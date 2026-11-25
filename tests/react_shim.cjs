// Shared React stand-in for the audio-play client tests.
//
// Why this exists: the panel mounts into `shell.overlay`, and an entry there is dropped
// ("abdicated") when its component throws during render, during an effect, or in one of
// its own event handlers. Each earlier harness hand-rolled its own React shim, and none
// of them enforced React's own element contract — so `h("input", props)` handing React
// `children: []` passed every test while the real react-dom threw minified React error
// #137 ("`input` is a void element tag and must neither have `children`...") at COMMIT
// time and dropped the panel. That gap is the bug this file closes: the shim mirrors the
// shipped react-dom (18.3.1, `setInitialProperties`) instead of trusting the component.
//
// What is modelled:
//   * createElement: children come from the trailing arguments only (0 -> key absent,
//     1 -> assigned directly, 2+ -> array), and a void tag whose children != null
//     throws, `[]` included.
//   * useState / useRef: per-component-instance hook stores keyed by tree path, so
//     state survives re-renders and setters work from event handlers.
//   * useEffect: real dep-array semantics plus cleanup-before-rerun, run after the pass.
// What is NOT modelled: batching, concurrency, keys, scheduler, context, memo bailouts.
// The renderer is one synchronous pass; the caller re-renders after changing state.
'use strict';

const fs = require('fs');

// React's own void-element list (react-dom `setInitialProperties`, tag m7 in the
// production bundle). Any of these with props.children != null throws React #137.
const VOID_ELEMENTS = {
  area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1,
  keygen: 1, link: 1, meta: 1, param: 1, source: 1, track: 1, wbr: 1,
};

function depsEqual(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/**
 * Build a shim runtime.
 * @param {object} [opts]
 * @param {(node) => object} [opts.makeHostNode] stub for a host element that carries a
 *        ref (the panel needs `audioRef.current` to be truthy to start playback).
 * @param {boolean} [opts.strictVoid=true] throw React-#137-style on void+children.
 */
function createRuntime(opts) {
  opts = opts || {};
  const strictVoid = opts.strictVoid !== false;

  const rt = {
    stores: new Map(),      // "Component#1.2" -> hook slot array
    pendingEffects: [],     // { slot, fn } collected during the current pass
    throws: [],             // every throw seen (render, effect), for assertions
    tags: Object.create(null), // host tag name -> how many elements createElement built
    created: [],               // every element createElement built (for invariant checks)
    passes: 0,
    React: null,
  };

  let frame = null;         // { store, i, key, prev } for the component being rendered
  let counters = [];        // instance counters per function-component depth
  let noEffects = false;    // isolation pass: collect no effects at all

  function createElement(type, props, ...children) {
    if (typeof type === 'string') rt.tags[type] = (rt.tags[type] || 0) + 1;
    const p = Object.assign({}, props || {});
    if (children.length === 1) p.children = children[0];
    else if (children.length > 1) p.children = children;
    if (strictVoid && typeof type === 'string' && VOID_ELEMENTS[type] &&
      (p.children != null || p.dangerouslySetInnerHTML != null)) {
      // Same message shape as React's, so a grep for #137 finds the intent.
      throw new Error('`' + type + '` is a void element tag and must neither have ' +
        '`children` nor use `dangerouslySetInnerHTML`. (React error #137)');
    }
    const el = { type, props: p };
    if (opts.track !== false) rt.created.push(el);
    return el;
  }

  function requireFrame(name) {
    if (!frame) throw new Error('React.' + name + ' called outside a component render');
    return frame;
  }

  function useState(init) {
    const f = requireFrame('useState');
    const i = f.i++;
    if (!(i in f.store)) f.store[i] = typeof init === 'function' ? init() : init;
    // The setter closes over the STORE, not the frame: React allows setState from an
    // event handler long after the render frame has exited.
    return [f.store[i], function (v) { f.store[i] = typeof v === 'function' ? v(f.store[i]) : v; }];
  }

  function useRef(init) {
    const f = requireFrame('useRef');
    const i = f.i++;
    if (!(i in f.store)) f.store[i] = { current: init };
    return f.store[i];
  }

  function useMemo(fn, deps) {
    const f = requireFrame('useMemo');
    const i = f.i++;
    const slot = f.store[i];
    if (!slot || !depsEqual(slot.deps, deps)) f.store[i] = { deps: deps, value: fn() };
    return f.store[i].value;
  }

  function useEffect(fn, deps) {
    if (!frame || noEffects) return;          // outside render / isolation pass: React ignores too
    const i = frame.i++;
    let slot = frame.store[i];
    if (!slot) slot = frame.store[i] = { first: true, deps: undefined, cleanup: undefined };
    const changed = slot.first || deps === undefined || !depsEqual(slot.deps, deps);
    slot.first = false;
    slot.deps = deps;
    if (changed) rt.pendingEffects.push({ slot: slot, fn: fn });
  }

  rt.React = {
    createElement,
    Fragment: 'Fragment',
    useState,
    useRef,
    useEffect,
    useMemo,
    useCallback: function (fn) { return fn; },
  };

  function renderNode(node, bag) {
    if (node == null || typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return;
    if (Array.isArray(node)) { for (const n of node) renderNode(n, bag); return; }
    if (typeof node !== 'object' || !('type' in node)) return;

    if (typeof node.type === 'function') {
      const nm = node.type.name || 'anonymous';
      const depth = counters.length;
      counters[depth] = (counters[depth] || 0) + 1;
      counters.length = depth + 1;
      const key = nm + '#' + counters.join('.');
      let store = rt.stores.get(key);
      if (!store) { store = []; rt.stores.set(key, store); }
      if (bag && !bag[nm]) { bag[nm] = node.props; bag[nm].__key = key; }
      if (opts.onComponent) opts.onComponent(nm, node.props, key, node.type);
      frame = { store: store, i: 0, key: key, prev: frame };
      let out;
      try {
        out = node.type(node.props);
      } catch (e) {
        rt.throws.push({ where: 'render ' + key, err: e });
        frame = frame.prev;
        throw e;
      }
      frame = frame.prev;
      renderNode(out, bag);
      return;
    }

    // Host element.
    const p = node.props || {};
    if (p.ref && typeof p.ref === 'object' && p.ref.current == null) {
      p.ref.current = opts.makeHostNode ? opts.makeHostNode(node) : { tagName: node.type };
    }
    if (p.children != null) renderNode(p.children, bag);
  }

  /** One synchronous render pass; throws from a component propagate (error boundary). */
  function render(root, bag) {
    counters = [];
    rt.passes++;
    renderNode(root, bag);
  }

  /** Run the effects collected by the last pass (cleanup first, React order). */
  function runEffects() {
    const list = rt.pendingEffects.slice();
    rt.pendingEffects.length = 0;
    for (const e of list) {
      if (typeof e.slot.cleanup === 'function') {
        try { e.slot.cleanup(); } catch (err) { rt.throws.push({ where: 'cleanup', err: err }); }
      }
      try {
        const c = e.fn();
        e.slot.cleanup = typeof c === 'function' ? c : undefined;
      } catch (err) {
        e.slot.cleanup = undefined;
        rt.throws.push({ where: 'effect', err: err });
        throw err;
      }
    }
  }

  /** Render pass + effects, the way React commits then flushes effects. */
  function renderAndCommit(root, bag) {
    render(root, bag);
    runEffects();
  }

  /**
   * Render ONE component in isolation: fresh hook store, subtree walked, effects
   * suppressed. Used by the prop-matrix harnesses, where a component has to be driven
   * with hand-made props without inheriting the mount pass's state.
   */
  function renderComponent(fn, props, opts2) {
    opts2 = opts2 || {};
    counters = [];
    rt.passes++;
    const nm = fn.name || 'anonymous';
    const key = nm + '#iso' + (opts2.tag ? opts2.tag : '');
    let store = rt.stores.get(key);
    if (!store || opts2.fresh !== false) { store = []; rt.stores.set(key, store); }
    if (opts.onComponent) opts.onComponent(nm, props, key, fn);
    noEffects = opts2.effects === false ? true : false;
    frame = { store: store, i: 0, key: key, prev: null };
    let out;
    try {
      out = fn(props);
      renderNode(out, null);
    } catch (e) {
      rt.throws.push({ where: 'render ' + key, err: e });
      throw e;
    } finally {
      frame = null;
      noEffects = false;
    }
    return out;
  }

  /** Flush pending microtasks (a handful of ticks + a macrotask). */
  function flush(times) {
    let p = Promise.resolve();
    for (let i = 0; i < (times || 12); i++) p = p.then(function () {});
    return p.then(function () { return new Promise(function (r) { setImmediate(r); }); });
  }

  return {
    rt,
    React: rt.React,
    createElement,
    render,
    renderNode,
    renderComponent,
    runEffects,
    renderAndCommit,
    flush,
    VOID_ELEMENTS,
  };
}

/**
 * Load lib/client.js the way the browser module loader does and register its panel.
 * @param {object} shim result of createRuntime()
 * @param {object} [opts] { target, fetch, timer, document, styles }
 */
function loadClient(shim, opts) {
  opts = opts || {};
  const target = opts.target || require('path').join(__dirname, '..', 'lib', 'client.js');
  const src = fs.readFileSync(target, 'utf8');

  let loaded = null;
  const prev = { window: global.window, document: global.document, fetch: global.fetch, styles: global.styles };

  global.window = { __ModuleLoader__: { load: function (m) { loaded = m; } } };
  global.document = opts.document || { addEventListener() {}, removeEventListener() {} };
  global.fetch = opts.fetch || function () {
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true }); } });
  };
  if ('styles' in opts) global.styles = opts.styles; else delete global.styles;

  try {
    (0, eval)(src);
    if (!loaded) throw new Error('client bundle did not register with __ModuleLoader__');
    const mod = loaded.factory(function (name) {
      if (name === 'react') return shim.React;
      throw new Error('unresolved module in bundle: ' + name);
    });

    const out = { mod, target, desc: null, restore: function () { global.window = prev.window; global.document = prev.document; global.fetch = prev.fetch; if (prev.styles === undefined) delete global.styles; else global.styles = prev.styles; } };
    out.apply = function (extraServices) {
      let comp = null;
      const slots = {
        inject: function (name, cb) { cb(); return function () {}; },
        register: function (desc, c) { out.desc = desc; comp = c; return function () {}; },
      };
      const timer = opts.timer || { interval: function () { return function () {}; }, timeout: function () { return function () {}; } };
      const svc = Object.assign({ slots, timer }, extraServices || {});
      const ctx = {
        get: function (n) { return svc[n]; },
        effect: function (fn) { return typeof fn === 'function' ? fn() : undefined; },
      };
      out.applyReturn = mod.apply(ctx);
      out.component = comp;
      out.timer = timer;
      out.slots = slots;
      return comp;
    };
    return out;
  } catch (e) {
    if (prev) { global.window = prev.window; global.document = prev.document; global.fetch = prev.fetch; }
    throw e;
  }
}

/**
 * Open every Collapsible section of the audio-play panel.
 *
 * Coverage reason: the endpoint rows and the auto-refresh input are rendered only while
 * their section is open — and those inputs are exactly the void elements that produced
 * the React #137 abdication. Mount alone never reaches them.
 *
 * Mounts (render + commit, which is what creates the section state), finds the
 * `expanded` slot by its shape, sets every key true, and re-renders.
 * @returns {Array} the panel's root hook store.
 */
async function openAllSections(shim, comp) {
  shim.renderAndCommit(comp());
  // The mount effect fills the section state from get_endpoints, so let the promise
  // chain land before looking for it.
  await shim.flush();
  var bag = {};
  shim.render(comp(), bag);
  var root = bag.AudioPlayerPanel;
  if (!root || !root.__key) throw new Error('AudioPlayerPanel instance not found in the tree');
  var store = shim.rt.stores.get(root.__key);
  if (!store) throw new Error('no hook store for AudioPlayerPanel');
  var isExpanded = function (v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    var k = Object.keys(v);
    return k.length === 2 && k.indexOf('tts') >= 0 && k.indexOf('stt') >= 0 &&
      typeof v.tts === 'boolean' && typeof v.stt === 'boolean';
  };
  // Pick the slot by shape, but NEVER silently: a second state slot that happens to
  // be a {tts: boolean, stt: boolean} map is indistinguishable from `expanded` here,
  // and grabbing the wrong one leaves every section closed while the test still
  // "passes" its earlier assertions. That is exactly how a stale-catalog boolean map
  // made EndpointRow disappear on 2026-09-17 — so ambiguity is an error, not a guess.
  var matches = [];
  for (var i = 0; i < store.length; i++) {
    if (isExpanded(store[i])) matches.push(i);
  }
  if (matches.length > 1) {
    throw new Error('ambiguous tts/stt boolean slots at ' + matches.join(', ') +
      ' — a new state slot shape-matches `expanded`; give it object values (or distinct keys)' +
      ' instead of letting the harness guess');
  }
  if (matches.length === 1) {
    // T-298 (2026-10-12): `__scene` (the Scene (batch) composer) joins the list so the open tree
    // really is open — the T-219 overflow checks read every section's triangle transform, and a
    // section left closed here is a section those checks never looked at. `__tl` and `__pip` stay:
    // their Collapsibles are gone from the panel and an unknown key in this map is inert.
    // T-300 U-6 (2026-10-12): __out is gone — the save path lives inside Settings now. The stale
    // __pip / __tl / __ar keys are left alone: they name sections that no longer exist and a missing
    // key in this map simply means the section keeps its own default.
    // T-356 (2026-10-14): the panel gained __dlg (Dialogue, multi-speaker batch) and __adv (Advanced:
    // model options, mix, remux) when "Text and dialogue" was split. Both are forced open here for the
    // same reason as the rest: the T-219 checks read EVERY section's triangle transform, and a section
    // closed in this map is a section those checks never saw. __log stays out: it is open by default.
    // T-400 (2026-10-15, T-387 items 6-8 change 1): the panel gained __stt when the STT pane moved out of
    // "Text and dialogue" into its own section. It defaults CLOSED in the panel, which is the user's ruling, but a
    // closed section renders no body — and every suite that reads the STT lane select, the Transcribe verb or the
    // diar rows reads them through the open tree. Forcing it open here is the same reason __dlg and __adv were forced
    // open for T-356: a section closed in this map is a section those checks never saw.
    store[matches[0]] = { tts: true, stt: true, __lib: true, __pl: true, __tl: true, __ar: true, __set: true, __ep: true, __voi: true, __pip: true, __scene: true, __dlg: true, __adv: true, __stt: true, __auto: true };
    shim.render(comp(), bag);
    return store;
  }
  throw new Error('the `expanded` section-state slot was not found — its shape changed?');
}

module.exports = { createRuntime, loadClient, openAllSections, VOID_ELEMENTS, depsEqual };
