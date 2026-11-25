#!/usr/bin/env node
'use strict';
// =====================================================================================================================
// T-302 - the Settings transparency slider (client-only).
//
// What the user asked (2026-10-12 19:15): "in settings, add a 'transparency slider setting' so we can adjust
// transparency of the whole DEEPAMP window between 90 and 0 %". Which end is 90 % was ambiguous, so it was
// asked, and the user answered at 23:03: "default should be 100% solid - down to 90% transperancy - to prevent
// the window goes missing fully". That answer is the contract this suite pins:
//
//   1. the panel starts SOLID (opacity 1) when nothing is stored;
//   2. the slider's own number is the TRANSPARENCY percent, 0 to 90, never further;
//   3. the floor is 0.10 opacity - the window may go nearly ghost, it may never disappear;
//   4. it is the panel element's own opacity, so header, transport and every section fade as one window;
//   5. it is persisted under audio-play:opacity like the panel size, and a stored value is clamped on the way
//      back in - a corrupted or out-of-range key can never produce an invisible panel.
// =====================================================================================================================

const path = require('path');
const { createRuntime, loadClient, openAllSections } = require('./react_shim.cjs');

const TARGET = process.argv[2] || path.join(__dirname, '..', 'lib', 'client.js');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  ->  ' + JSON.stringify(detail) : '')); }
}
function flush() {
  let p = Promise.resolve();
  for (let i = 0; i < 30; i++) p = p.then(function () {});
  return p;
}

function makeBrowser(opts) {
  opts = opts || {};
  const b = { store: Object.assign(Object.create(null), opts.storage || {}), calls: [] };
  global.localStorage = {
    getItem: function (k) { return k in b.store ? b.store[k] : null; },
    setItem: function (k, v) { b.store[k] = String(v); },
    removeItem: function (k) { delete b.store[k]; },
  };
  b.doc = { hidden: false, addEventListener: function () {}, removeEventListener: function () {} };
  return b;
}
function teardown() { delete global.localStorage; }

// ------------------------------------------------------------------ one mounted panel, with lookups
async function mount(b) {
  const shim = createRuntime({});
  const client = loadClient(shim, {
    target: TARGET,
    document: b.doc,
    fetch: function (url, o) {
      const u = String(url); b.calls.push(((o && o.method) || 'GET') + ' ' + u);
      let body = { ok: true };
      if (/get_endpoints/.test(u)) body = { tts: { url: 'http://cpu1.test:8963' }, stt: { url: 'http://cpu1.test:8962' } };
      else if (/server_status/.test(u)) body = { tts: { ok: true, loaded_model: 'm1' }, stt: { ok: true } };
      else if (/get_models/.test(u)) body = { models: [{ id: 'm1', loaded: true }] };
      else if (/refresh_voices/.test(u)) body = { voices: ['voy_janeway'], builtins: [] };
      else if (/playlist_list/.test(u)) body = { items: [], queues: { tts: { paused: false, running: null, queued: 0 }, stt: { paused: false, running: null, queued: 0 } } };
      else if (/queue_status/.test(u)) body = { ok: true, queues: { tts: { queued: 0, paused: false, running_ids: [] }, stt: { queued: 0, paused: false, running_ids: [] } } };
      else if (/storage_status/.test(u)) body = { ok: true, base: '/home/deepamp-test/.dsh/deepamp-audio', writable: true };
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
    },
  });
  const comp = client.apply();
  if (!comp) throw new Error('panel did not register');
  let mark = 0;
  function created() { return shim.rt.created.slice(mark); }
  function commit() {
    const bag = {}; const start = shim.rt.created.length;
    shim.render(comp(), bag); shim.runEffects();
    mark = start;
    return created();
  }
  function hasCls(c, want) { return String(c || '').split(/\s+/).indexOf(want) >= 0; }
  function els(cls) { return created().filter(function (e) { return e.props && hasCls(e.props.className, cls); }); }
  function ownText(e) { const c = e.props && e.props.children; return (typeof c === 'string') ? c : ''; }
  function panel() { const p = els('audio-play-panel'); return p.length ? p[p.length - 1] : null; }
  function slider() { const p = els('audio-play-opacity'); return p.length ? p[p.length - 1] : null; }
  function readout() { const p = els('audio-play-opacity-read'); return p.length ? ownText(p[p.length - 1]) : ''; }
  function opacityNow() {
    const p = panel();
    if (!p || !p.props || !p.props.style) return null;
    return p.props.style.opacity;
  }
  function drag(value) {
    const s = slider();
    if (!s || !s.props.onChange) return false;
    s.props.onChange({ target: { value: String(value) } });
    return true;
  }
  return {
    shim: shim, comp: comp, commit: commit, created: created, els: els, panel: panel, slider: slider,
    readout: readout, opacityNow: opacityNow, drag: drag, ownText: ownText,
  };
}

(async function main() {
  let b, m, bag;

  // ------------------------------------------------------------------ A: nothing stored = solid
  console.log('A  no stored value: the window starts solid, and the slider sits at its solid end');
  b = makeBrowser({});
  m = await mount(b);
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit();
  check('T-302: the panel element carries the opacity itself (not a child, not a background alpha)',
    m.panel() && m.opacityNow() === 1, m.panel() && m.opacityNow());
  // T-388 item 4 (user 2026-10-14): "0% transparent" used to still show ~5% through, because the panel's FILL carried
  // an alpha of its own (#14141af2) that the slider never moved. The ruling was "Make the background solid: 0%
  // transparent becomes truly solid", so the fill is pinned opaque here: the element opacity is the only thing allowed
  // to make the window see-through, which is what the control has always claimed to do.
  check('T-388 CONTRACT CHANGE: at the solid end the panel fill is opaque, so 0% transparent means nothing shows through',
    m.panel() && String(m.panel().props.style.background) === '#14141a'
      && !/background: "#14141af2"/.test(require('fs').readFileSync(TARGET, 'utf8')),
    m.panel() && m.panel().props.style.background);
  // T-408 (user 2026-10-15, verbatim): "settings: limit transparency to 50% max - shorten slider to save
  // some space". The range the user asked for in T-302 was 0 to 90; the same person has now capped it at 50,
  // and the cap is asserted where the range is asserted, so the ceiling is a checked fact and not a habit.
  check('T-302 through T-408: the slider exists in Settings with the range the user now allows, 0 to 50 percent',
    m.slider() && m.slider().props.type === 'range' && m.slider().props.min === '0' && m.slider().props.max === '50',
    m.slider() && [m.slider().props.type, m.slider().props.min, m.slider().props.max]);
  check('T-302 CONTRACT (user 23:03): default is 100 % solid, so the slider reads 0 % transparent',
    m.slider() && m.slider().props.value === '0' && m.readout() === '0% transparent',
    [m.slider() && m.slider().props.value, m.readout()]);
  check('T-302: the control is labelled so a user knows what it moves',
    m.created().some(function (e) { return m.ownText(e) === 'Panel transparency'; }),
    m.created().map(m.ownText).filter(function (t) { return /transparen/i.test(t); }).slice(0, 3));
  // T-408 moved the ceiling, so the sentence the hover has to carry moved with it: the limit is named, and
  // the refusal to go fully invisible is still what the limit exists for.
  check('T-302 through T-408: the hover states the limit out loud, because an invisible window is the failure mode',
    m.slider() && /50 % is as /.test(String(m.slider().props.title || '')) && /never goes further/.test(String(m.slider().props.title || '')),
    m.slider() && m.slider().props.title);

  // ------------------------------------------------------------------ B: a stored value is honoured
  console.log('B  a stored opacity is restored, and the slider is derived from it');
  b = makeBrowser({ storage: { 'deepamp:opacity': '0.5' } });
  m = await mount(b);
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit();
  check('T-302: a stored 0.5 comes back as 0.5 opacity on the panel', m.opacityNow() === 0.5, m.opacityNow());
  check('T-302: and the slider shows it as 50 % transparent',
    m.slider().props.value === '50' && m.readout() === '50% transparent', [m.slider().props.value, m.readout()]);

  // ------------------------------------------------------------------ C: the floor, the point of the whole feature
  console.log('C  the floor: 50 % transparent is as far as this window is allowed to go (T-408)');
  b = makeBrowser({ storage: { 'deepamp:opacity': '0.02' } });   // out of range, from an older build or by hand
  m = await mount(b);
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit();
  check('T-302 CONTRACT (user 23:03: "to prevent the window goes missing fully") through T-408: a stored value '
      + 'below the floor is clamped to 0.50 opacity, never applied as given',
    m.opacityNow() === 0.5, m.opacityNow());
  check('T-408: the slider cannot be set past 50 % (its own max), so a fully invisible window is unreachable by dragging',
    m.slider().props.max === '50' && m.slider().props.value === '50', [m.slider().props.max, m.slider().props.value]);

  // ------------------------------------------------------------------ D and E: junk in storage
  console.log('D  a stored value above 1, and a stored value that is not a number');
  b = makeBrowser({ storage: { 'deepamp:opacity': '1.7' } });
  m = await mount(b);
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit();
  check('T-302: 1.7 clamps to solid rather than an illegal opacity', m.opacityNow() === 1, m.opacityNow());
  teardown();

  b = makeBrowser({ storage: { 'deepamp:opacity': 'not-a-number' } });
  m = await mount(b);
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit();
  check('T-302: corrupted storage falls back to SOLID, not to a half-visible window',
    m.opacityNow() === 1 && m.slider().props.value === '0', [m.opacityNow(), m.slider().props.value]);
  teardown();

  b = makeBrowser({ storage: { 'deepamp:opacity': '' } });
  m = await mount(b);
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit();
  check('T-302: an empty stored string is treated as "nothing stored" (solid), the same rule the panel size uses',
    m.opacityNow() === 1, m.opacityNow());
  teardown();

  // ------------------------------------------------------------------ F: dragging it, and what gets persisted
  console.log('F  dragging the slider changes the window AND persists it, clamped, under audio-play:opacity');
  b = makeBrowser({});
  m = await mount(b);
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit();
  check('T-302: the slider moves the window', m.drag(45) && (m.commit(), true) && m.opacityNow() === 0.55,
    m.opacityNow());
  check('T-302: and the read-out follows the same number the user dragged to',
    m.slider().props.value === '45' && m.readout() === '45% transparent', [m.slider().props.value, m.readout()]);
  check('T-302: persisted under audio-play:opacity as the OPACITY, like audio-play:size is the size',
    b.store['deepamp:opacity'] === '0.55', b.store['deepamp:opacity']);
  m.drag(50); m.commit();
  check('T-408 CONTRACT: dragging to the far end lands on 0.50 opacity - half a window, never a ghost',
    m.opacityNow() === 0.5 && b.store['deepamp:opacity'] === '0.5', [m.opacityNow(), b.store['deepamp:opacity']]);
  // The ceiling is a clamp, not only a slider attribute: a value that arrives from anywhere else is capped too.
  m.drag(80); m.commit();
  check('T-408: a value past the ceiling is capped at 50 % transparent rather than stored as given',
    m.opacityNow() === 0.5 && b.store['deepamp:opacity'] === '0.5', [m.opacityNow(), b.store['deepamp:opacity']]);
  check('T-408: the slider is shorter than the row it sits in, so the row saves the space it used to spend on it',
    /maxWidth: "110px"/.test(require('fs').readFileSync(TARGET, 'utf8')), 'slider basis');
  m.drag(0); m.commit();
  check('T-302: dragging back to 0 restores a fully solid window',
    m.opacityNow() === 1 && b.store['deepamp:opacity'] === '1', [m.opacityNow(), b.store['deepamp:opacity']]);
  teardown();

  // ------------------------------------------------------------------ G: it is one window, not a half-styled one
  console.log('G  the whole window fades together (the panel root carries it, so every child inherits it)');
  b = makeBrowser({ storage: { 'deepamp:opacity': '0.6' } });   // legal under the T-408 floor, so this section measures inheritance and not clamping
  m = await mount(b);
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit();
  const pl = m.els('audio-play-player');
  const hd = m.els('audio-play-title');   // the header row's own title span
  check('T-302: the player block and the header title are INSIDE the element that carries the opacity (they '
      + 'are not separately faded, and not exempted)',
    m.panel() && pl.length > 0 && hd.length > 0 && m.opacityNow() === 0.6,
    [m.panel() ? m.opacityNow() : null, pl.length, hd.length]);
  check('T-302: nothing re-writes the panel opacity behind the slider (the style value is the state value)',
    m.opacityNow() === 0.6, m.opacityNow());
  teardown();

  console.log('=== ' + pass + ' pass, ' + fail + ' fail ===');
  process.exitCode = fail ? 1 : 0;
})().catch(function (e) {
  console.log('THROW  ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
