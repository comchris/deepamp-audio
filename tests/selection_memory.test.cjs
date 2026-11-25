// Selection memory (user request 2026-09-19): the last model pick must survive a
// reload, and the fallback when nothing (or a stale value) is stored must land on a model the lane actually
// lists — never on a blank select and never on a name the client carries.
// (T-845 contract change, 2026-11-14) Until today the middle of that order named a model: "the preferred default
// (qwen3-tts / qwen3_asr)". The operator-s ruling for taking it out is CHANGELOG.md T-845, and the rule it serves is
// AGENTS.md 11.9 — model choices are read, never carried. The operator-s words were "Your recommendations for
// 1,2,3,4 sound good, implement accordingly", on the recommendation "take them out and let the default be first
// listed". Four assertions in this file named the carried name and are re-cut onto the read order; none of them was
// dropped, and each still demands the same thing it was written to demand — a pick that is not blank, not stale, and
// not invented here. The order this suite now measures is saved -> first listed, and "first listed" is the order the
// panel reads the lane in, because lib/client.js sorts the list by id before it resolves anything.
// Three fresh boots, three LS states — one layer of the resolution order each.
'use strict';
const path = require('path');
const { createRuntime, loadClient } = require('./react_shim.cjs');

// T-227: the suite must be runnable against a saved copy of the client (non-vacuity
// proof), so the target is now an argument like the other client suites take. Default is
// unchanged: lib/client.js.
const TARGET = process.argv[2] || path.join(__dirname, '..', 'lib', 'client.js');
// The panel's sentinel for "send no voice at all" (lib/client.js, T-227). It is a UI /
// localStorage value only — it is never sent to the host, and lib/index.js:3492-3496
// (VOICE_NAME_RE, [a-z0-9_-]) guarantees it can never collide with a real voice name.
const NO_VOICE = '__no_voice__';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  ->  ' + JSON.stringify(detail) : '')); }
}
const flush = function () { return new Promise(function (r) { setTimeout(r, 5); }); };

// Fake localStorage (same shape ui_state uses; the client guards with typeof).
function mkLs(seed) {
  return {
    s: seed || {},
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(this.s, k) ? this.s[k] : null; },
    setItem: function (k, v) { this.s[k] = String(v); },
  };
}
const MODELS = [
  { id: 'm1', loaded: true, task: 'tts', family: 'voxcpm2', quant: 'bf16' },
  { id: 'qwen3-tts', loaded: false, task: 'tts', family: 'qwen3_tts', quant: 'q8' },
  { id: 'qwen3_asr', loaded: false, task: 'stt', family: 'qwen3_asr' },
  { id: 'm2', loaded: false, task: 'clon', family: 'glm_tts', quant: 'q8' },
  // T-229: the tool half of the catalog, answered only on fn=task (TASK_ALLOW,
  // lib/index.js:4217). Additive — the tts/stt lists keep their exact contents.
  { id: 'bs_roformer', loaded: false, task: 'sep', family: 'bs_roformer', quant: 'f16' },
  { id: 'vevo2', loaded: false, task: 'vc', family: 'vevo2' },
];
const TOOL_TASKS = ['sep', 'gen', 'vc', 's2s'];
function mkFetch() {
  return function (u, opts) {
    let body;
    if (/get_endpoints/.test(u)) body = { tts: { url: 'http://cpu1.test:8963', route: 'speech' }, stt: { url: 'http://cpu1.test:8962', route: 'speech' } };
    else if (/server_status/.test(u)) body = { tts: { ok: true }, stt: { ok: true } };
    else if (/get_models/.test(u)) {
      // Realistic per-fn projection (the host filters the catalog by task): the
      // STT list deliberately contains NO 'qwen3-tts' so the test can identify
      // which select it is reading.
      body = { models: /fn=stt/.test(u) ? MODELS.filter(function (m) { return m.task === 'stt'; })
        : (/fn=task/.test(u) ? MODELS.filter(function (m) { return TOOL_TASKS.indexOf(m.task) >= 0; })
          : MODELS.filter(function (m) { return m.task !== 'stt' && TOOL_TASKS.indexOf(m.task) < 0; })) };
    }
    else if (/refresh_voices/.test(u)) {
      body = { voices: ['v1', 'v2'] };
      // T-370: an additive switch, off unless a block turns it on. A model listed here answers with its OWN
      // speakers and its declared default; a model not listed keeps the answer every check here already saw.
      var mb370 = (global.__TEST_BUILTINS || null);
      if (mb370) {
        var mid370 = (String(u).match(/[?&]model=([^&]+)/) || [])[1] || '';
        var hit370 = mb370[mid370];
        if (hit370) {
          // The shape the host really answers: `voices` is the model's own clone-voice list (empty here),
          // `builtins` is the model's preset speakers. A model whose clone list ALSO carries its preset
          // names is the case the client hardening above now covers, and it is tested there.
          body = { voices: [], builtins: hit370.voices.slice(),
                   builtins_source: 'capability', default_voice: hit370.default_voice || hit370.voices[0] };
        }
      }
    }
    else if (/voice_registry/.test(u)) body = { ok: true, voices: (global.__TEST_REG || {}) };
    else if (/playlist_list/.test(u)) body = { items: [] };
    else if (/endpoint_registry/.test(u)) {
      // T-242 (additive): the lane selects read the registry once at boot, so a remembered
      // pin can be read against a REAL slot instead of the "gone" fallback. Deliberately NO
      // `primary` key: the get_endpoints answer above stays the panel's primary view, so
      // every pre-T-242 assertion in this suite sees exactly what it saw before.
      const fnR = /fn=stt/.test(u) ? 'stt' : 'tts';
      body = { ok: true, fn: fnR, endpoints: fnR === 'stt' ? [] : [{ id: 'e-1', fn: 'tts', url: 'http://cpu2.test:8963', route: 'speech', host: 'cpu2.test', enabled: true, batch_allowed: true, paused: false, models: ['vevo2', 'bs_roformer'], models_source: 'engine', models_at: 1 }] };
    }
    else body = { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
  };
}

// Boot one full panel with a given LS seed; resolve with the tts select's value.
async function bootWithSel(seed) {
  global.localStorage = mkLs(Object.assign({}, seed));
  const shim = createRuntime({
    makeHostNode: function (n) {
      return n.type === 'audio'
        ? { play: function () {}, pause: function () {} }
        : { tagName: n.type, getBoundingClientRect: function () { return { left: 1180, top: 10, width: 440, height: 400, right: 1620, bottom: 410 }; } };
    },
  });
  const client = loadClient(shim, { target: path.join(__dirname, '..', 'lib', 'client.js'), fetch: mkFetch() });
  const comp = client.apply();
  if (!comp) throw new Error('panel did not register');
  const b = {};
  shim.render(comp(), b);
  shim.runEffects();
  await flush();
  shim.render(comp(), b);
  // The TTS model select is the select whose options list the model ids.
  // T-229 contract change: the options are now FILTERED by the job kind (and grouped in
  // <optgroup>s), so an option-text fingerprint is no longer a stable locator on its own —
  // a clone kind lists only the clone models. The select is located by its own class first
  // (the house style for a control the tests have to name, same as audio-play-lane), and
  // the original fingerprint is kept as a fallback so the SAME reading works against a
  // saved pre-T-229 copy of the client. Same select, same value, same assertion.
  const ttsSel = shim.rt.created.filter(function (e) {
    if (!(e.type === 'select' && Array.isArray(e.props.children))) return false;
    return e.props.className === 'audio-play-model' || JSON.stringify(e.props.children).indexOf('qwen3-tts') >= 0;
  }).pop();
  return ttsSel ? String(ttsSel.props.value) : null;
}

// Voice/format restore (bug 2026-09-20): the reload used to fall back to the
// engine's FIRST voice because the resolver only knew the server list — a
// saved REGISTRY voice (voy_doctor) reset to bijan. Same boot, reads a
// different select by option fingerprint.
async function bootWithSel2(seed, reg, fingerprint) {
  global.__TEST_REG = reg || {};
  global.localStorage = mkLs(Object.assign({}, seed));
  const shim = createRuntime({
    makeHostNode: function (n) {
      return n.type === 'audio'
        ? { play: function () {}, pause: function () {} }
        : { tagName: n.type, getBoundingClientRect: function () { return { left: 1180, top: 10, width: 440, height: 400, right: 1620, bottom: 410 }; } };
    },
  });
  const client = loadClient(shim, { target: path.join(__dirname, '..', 'lib', 'client.js'), fetch: mkFetch() });
  const comp = client.apply();
  if (!comp) throw new Error('panel did not register');
  const b = {};
  shim.render(comp(), b);
  shim.runEffects();
  await flush();
  shim.render(comp(), b);
  const s = shim.rt.created.filter(function (e) {
    return e.type === 'select' && Array.isArray(e.props.children) && JSON.stringify(e.props.children).indexOf(fingerprint) >= 0;
  }).pop();
  delete global.__TEST_REG;
  return s ? String(s.props.value) : null;
}

// T-227 boot: same shape as bootWithSel2 but it keeps the panel live so the test can
// read the voice <select> repeatedly, drive it, tick the 15 s voice-dropdown loop, and
// see what was written to localStorage. Three renders, not two: a clone model resolves
// the saved sentinel, then TtsBox refuses it and snaps to a name, and only the render
// after that shows the name.
async function bootVoice(seed, reg) {
  global.__TEST_REG = reg || {};
  global.localStorage = mkLs(Object.assign({}, seed));
  const ivs = [];
  const shim = createRuntime({
    makeHostNode: function (n) {
      return n.type === 'audio'
        ? { play: function () {}, pause: function () {} }
        : { tagName: n.type, getBoundingClientRect: function () { return { left: 1180, top: 10, width: 440, height: 400, right: 1620, bottom: 410 }; } };
    },
  });
  const client = loadClient(shim, {
    target: TARGET, fetch: mkFetch(),
    timer: {
      interval: function (cb, ms) {
        const rec = { cb: cb, ms: ms };
        ivs.push(rec);
        return function () { const i = ivs.indexOf(rec); if (i >= 0) ivs.splice(i, 1); };
      },
      timeout: function () { return function () {}; },
    },
  });
  const comp = client.apply();
  if (!comp) throw new Error('panel did not register');
  const b = {};
  shim.render(comp(), b);
  shim.runEffects();
  await flush();
  shim.render(comp(), b);
  shim.render(comp(), b);
  const voiceSel = function () {
    return shim.rt.created.filter(function (e) {
      return e.type === 'select' && typeof e.props.title === 'string' && /voice list - opening re-checks/.test(e.props.title);
    }).pop();
  };
  const read = function () {
    const s = voiceSel();
    const opts = (s && Array.isArray(s.props.children)) ? s.props.children : [];
    const nv = opts.filter(function (o) { return o && o.props && o.props.value === NO_VOICE; })[0];
    let stored = null;
    try { stored = JSON.parse(global.localStorage.getItem('deepamp:sel')); } catch (e) {}
    return {
      value: s ? String(s.props.value) : null,
      values: opts.map(function (o) { return o && o.props ? String(o.props.value) : null; }),
      nvPresent: !!nv,
      nvDisabled: nv ? nv.props.disabled === true : null,
      stored: stored,
    };
  };
  const pick = async function (v) {
    const s = voiceSel();
    if (!s) return false;
    s.props.onChange({ target: { value: v } });
    shim.render(comp(), b);
    await flush();
    shim.render(comp(), b);
    return true;
  };
  const tickVoice = async function () {
    const rec = ivs.filter(function (i) { return i.ms === 15000; }).pop();
    if (!rec) return false;
    rec.cb();
    await flush();
    shim.render(comp(), b);
    return true;
  };
  // T-370: drive the TTS model select, the way a person switching models does.
  const setModel = async function (id) {
    const ms = shim.rt.created.filter(function (e) {
      return e.type === 'select' && e.props && e.props.className === 'audio-play-model';
    }).pop();
    if (!ms) return false;
    ms.props.onChange({ target: { value: id } });
    shim.render(comp(), b);
    await flush();
    shim.render(comp(), b);
    shim.render(comp(), b);
    return true;
  };
  // T-370: the voice dropdown is grouped now; read every option it holds, group headings not counted as options.
  const voiceValues = function () {
    const sv = voiceSel();
    const kids = (sv && Array.isArray(sv.props.children)) ? sv.props.children : [];
    const outV = [];
    kids.forEach(function (k) {
      if (!k) return;
      if (k.type === 'optgroup') {
        (Array.isArray(k.props.children) ? k.props.children : [k.props.children]).forEach(function (o) { if (o) outV.push(String(o.props.value)); });
      } else outV.push(String(k.props.value));
    });
    return outV;
  };
  const groupLabels = function () {
    const sv = voiceSel();
    const kids = (sv && Array.isArray(sv.props.children)) ? sv.props.children : [];
    return kids.filter(function (k) { return k && k.type === 'optgroup'; }).map(function (g) { return String(g.props.label || ''); });
  };
  const out = { read: read, pick: pick, tickVoice: tickVoice, setModel: setModel, voiceValues: voiceValues, groupLabels: groupLabels, raw: function () { return global.localStorage.getItem('deepamp:sel'); } };
  delete global.__TEST_REG;
  return out;
}

// T-229 boot: the same panel, but read the JOB KIND selector and the model select it
// filters, and drive a kind change while the panel is live. The selects are read by their
// own class (audio-play-kind / audio-play-model), the house style for a control the tests
// have to name.
async function bootKind(seed) {
  global.localStorage = mkLs(Object.assign({}, seed));
  const shim = createRuntime({
    makeHostNode: function (n) {
      return n.type === 'audio'
        ? { play: function () {}, pause: function () {} }
        : { tagName: n.type, getBoundingClientRect: function () { return { left: 1180, top: 10, width: 440, height: 400, right: 1620, bottom: 410 }; } };
    },
  });
  const client = loadClient(shim, { target: TARGET, fetch: mkFetch() });
  const comp = client.apply();
  if (!comp) throw new Error('panel did not register');
  const b = {};
  shim.render(comp(), b);
  shim.runEffects();
  await flush();
  shim.render(comp(), b);
  await flush();
  shim.render(comp(), b);
  const flat = function (e) {
    const out = [];
    (function walk(x) {
      if (x == null) return;
      if (Array.isArray(x)) { x.forEach(walk); return; }
      out.push(x);
      // The model select groups its options inside <optgroup>s, so the walk has to
      // descend into elements as well as arrays.
      if (x.props && x.props.children) walk(x.props.children);
    })((e && e.props && e.props.children));
    return out;
  };
  const read = function () {
    const k = shim.rt.created.filter(function (e) { return e.type === 'select' && e.props && e.props.className === 'audio-play-kind'; }).pop();
    const m = shim.rt.created.filter(function (e) { return e.type === 'select' && e.props && e.props.className === 'audio-play-model'; }).pop();
    let stored = null;
    try { stored = JSON.parse(global.localStorage.getItem('deepamp:sel')); } catch (e) {}
    return {
      kind: k ? String(k.props.value) : null,
      kindOptions: k ? flat(k).filter(function (o) { return o && o.type === 'option'; }).map(function (o) { return { value: o.props.value, disabled: !!o.props.disabled }; }) : [],
      model: m ? String(m.props.value) : null,
      modelOptions: m ? flat(m).filter(function (o) { return o && o.type === 'option'; }).map(function (o) { return o.props.value; }) : [],
      stored: stored,
    };
  };
  const drive = async function (kind) {
    const tb = shim.rt.created.filter(function (e) { return e.props && typeof e.props.onKindChange === 'function'; }).pop();
    // No handler is itself the finding (a client with no job kind has nothing to drive);
    // it must show up as failing checks, not as an aborted suite.
    if (!tb) return null;
    tb.props.onKindChange(kind);
    await flush();
    shim.render(comp(), b);
    await flush();
    return read();
  };
  return { read: read, drive: drive, raw: function () { return global.localStorage.getItem('deepamp:sel'); } };
}

// T-242 (user report 2026-10-07): the dispatch LANE is a selection like model / voice /
// language / format. It is remembered in the SAME store (LS_SEL keys tts_lane / stt_lane),
// restored through the SAME normaliser (normLane), and it belongs to the FN, not to the job
// kind — the tool kinds run on the tts fn and in the tts queue, so they pin the tts lane.
// This boots a panel and exposes the lane selects plus a kind drive, so "changing the kind
// inside the TTS section must not silently change the lane" is assertable against a saved
// copy of the client (TARGET, like the rest of this suite).
async function bootLane(seedSel) {
  // T-400 (2026-10-15): the panel gained a section that defaults CLOSED (__stt), and a closed Collapsible renders no
  // body — so a boot that leaves the store empty no longer renders the STT lane select at all, and "one lane select
  // per fn" would pass by accident on the tts side alone. The section store is seeded open here, in the exact shape
  // toggleExpand writes (only "__" keys, JSON map of booleans), so these checks still see both lane controls.
  const t400Sections = JSON.stringify({ __pl: true, __lib: true, __voi: true, __scene: true, __dlg: true, __adv: true, __stt: true, __auto: true, __set: true, __ep: true, __log: true });
  const t400Seed = Object.assign({ 'deepamp:sections': t400Sections }, seedSel ? { 'deepamp:sel': seedSel } : {});
  global.localStorage = mkLs(t400Seed);
  const shim = createRuntime({
    makeHostNode: function (n) {
      return n.type === 'audio'
        ? { play: function () {}, pause: function () {} }
        : { tagName: n.type, getBoundingClientRect: function () { return { left: 1180, top: 10, width: 440, height: 400, right: 1620, bottom: 410 }; } };
    },
  });
  const client = loadClient(shim, { target: TARGET, fetch: mkFetch() });
  const comp = client.apply();
  if (!comp) throw new Error('panel did not register');
  const commit = function () { const b = {}; shim.render(comp(), b); shim.runEffects(); return b; };
  commit(); await flush(); commit(); await flush();
  // ONE fresh render batch: the lane selects of the CURRENT frame, identified by WHICH fn
  // they belong to (the panel labels the first slot TTS1 / STT1), plus the kind select of
  // that same frame. Identification by fn matters: a client that does not render the tts lane
  // for a tool kind must fail "the tts lane is remembered", not silently read the STT select.
  const snap = function () {
    const n = shim.rt.created.length;
    shim.render(comp());
    const tree = shim.rt.created.slice(n);
    const k = tree.filter(function (e) { return e.type === 'select' && e.props && e.props.className === 'audio-play-kind'; }).pop();
    const laneSel = tree.filter(function (e) { return e.type === 'select' && e.props && e.props.className === 'audio-play-lane'; });
    const laneTxt = function (s) { return JSON.stringify((s && s.props.children) || []); };
    return {
      lanes: laneSel,
      ttsLane: laneSel.filter(function (s) { return /TTS1/.test(laneTxt(s)); })[0] || null,
      sttLane: laneSel.filter(function (s) { return /STT1/.test(laneTxt(s)); })[0] || null,
      kind: k ? String(k.props.value) : null,
    };
  };
  const setLane = async function (which, v) {
    const s = (which === "stt" ? snap().sttLane : snap().ttsLane);
    if (!s) return false;
    s.props.onChange({ target: { value: v } });
    await flush(); commit(); await flush();
    return true;
  };
  const driveKind = async function (kind) {
    const was = snap().kind;
    const tb = shim.rt.created.filter(function (e) { return e.props && typeof e.props.onKindChange === 'function'; }).pop();
    // No handler is itself the finding: it must fail the checks, not abort the suite.
    if (!tb) return { was: was, after: snap(), drove: false };
    tb.props.onKindChange(kind);
    await flush(); commit(); await flush();
    return { was: was, after: snap(), drove: true };
  };
  const raw = function () { return global.localStorage.getItem('deepamp:sel'); };
  const parsed = function () { try { return JSON.parse(raw() || '{}'); } catch (e) { return {}; } };
  return { snap: snap, setLane: setLane, driveKind: driveKind, raw: raw, parsed: parsed };
}

(async function main() {
  console.log('--- selection memory (saved -> first listed) ---');

  // 1. Saved pick wins, even though m1 is listed first.
  const s1 = await bootWithSel({ 'deepamp:sel': JSON.stringify({ tts: 'm2' }) });
  check('saved model pick restored after reload', s1 === 'm2', s1);

  // 2. Nothing saved -> the first model the lane lists. (T-845 contract change, 2026-11-14: this used to assert
  //    qwen3-tts, a name the client carried. The point of the assertion is unchanged — a fresh boot resolves to a
  //    real, listed model — and what it now measures is the read order instead of a remembered name.)
  const s2 = await bootWithSel({});
  check('no saved pick -> the first model the lane lists, never a name carried in the client', s2 === 'm1', s2);

  // 3. Stale saved value (model gone) -> falls through to the first listed model, never blank.
  const s3 = await bootWithSel({ 'deepamp:sel': JSON.stringify({ tts: 'model-that-no-longer-exists' }) });
  check('stale saved model -> first listed, never blank', s3 === 'm1', s3);

  // 4. A manual pick persists to localStorage (survives this reload).
  global.localStorage = mkLs({});
  const shim4 = createRuntime({
    makeHostNode: function (n) {
      return n.type === 'audio'
        ? { play: function () {}, pause: function () {} }
        : { tagName: n.type, getBoundingClientRect: function () { return { left: 1180, top: 10, width: 440, height: 400, right: 1620, bottom: 410 }; } };
    },
  });
  const client4 = loadClient(shim4, { target: path.join(__dirname, '..', 'lib', 'client.js'), fetch: mkFetch() });
  const comp4 = client4.apply();
  const b4 = {};
  shim4.render(comp4(), b4);
  shim4.runEffects();
  await flush();
  shim4.render(comp4(), b4);
  const box = {};
  // TtsBox carries the model select; onModelChange is the panel's persisting handler.
  const seen = shim4.rt.created.filter(function (e) { return typeof e.type === 'function' && e.type.name === 'TtsBox'; });
  // Drive the handler directly through the created TtsBox element props.
  const tb = shim4.rt.created.filter(function (e) { return e.props && typeof e.props.onModelChange === 'function' && typeof e.props.dispatchTts === 'function'; }).pop();
  // Fallback: call through the select element's onChange instead.
  const sel4 = shim4.rt.created.filter(function (e) {
    return e.type === 'select' && Array.isArray(e.props.children) && JSON.stringify(e.props.children).indexOf('m2') >= 0;
  }).pop();
  const fire = (tb && tb.props.onModelChange) ? function (m) { tb.props.onModelChange('tts', m); }
    : (sel4 ? function (m) { sel4.props.onChange({ target: { value: m } }); } : null);
  check('model select reachable in tree', !!fire);
  if (fire) {
    fire('m1');
    shim4.render(comp4(), b4);
    const raw = global.localStorage.getItem('deepamp:sel');
    let stored = null; try { stored = JSON.parse(raw); } catch (e) {}
    check('manual pick written to localStorage', stored && stored.tts === 'm1', raw);
  }

  console.log('--- voice + format restore (2026-09-20) ---');

  // 5. THE bijan-regression: saved voice is a REGISTRY name (never in the
  //    server list) -> must restore, not fall to the first server voice.
  const v5 = await bootWithSel2(
    { 'deepamp:sel': JSON.stringify({ tts: 'qwen3-tts', tts_voice: 'voy_doctor' }) },
    { voy_doctor: { ref_text: 'x', ref_wav: '/home/deepamp-test/.dsh/deepamp-audio/voices/voy_doctor.wav' } },
    'voy_doctor');
  check('saved REGISTRY voice restored (no reset to first server voice)', v5 === 'voy_doctor', v5);

  // 6. Saved server voice restored as-is.
  const v6 = await bootWithSel2(
    { 'deepamp:sel': JSON.stringify({ tts: 'qwen3-tts', tts_voice: 'v2' }) }, {}, 'v2');
  check('saved server voice restored', v6 === 'v2', v6);

  // 7. Nothing saved -> first candidate (voice-less dispatch is a remote 500).
  const v7 = await bootWithSel2({}, {}, 'v1');
  check('no saved voice -> first candidate', v7 === 'v1', v7);

  console.log('\n--- T-679: the fallback voice a person names on a voice row ---');

  // 9a. The operator's ruling on this card, verbatim: "a stored word in the browser, per lane,
  //     written by a fallback control on a voice row, with the derived chain answering when that word
  //     is empty". The word is a link in the chain, never a replacement of it: a stored fallback
  //     outranks the accident of a list order, and with no word stored the answer stays what check 7
  //     and check 9 already measured.
  const v9a = await bootWithSel2({ 'deepamp:voice.fallback.tts': 'v2' }, {}, 'v1');
  check('T-679: a stored fallback word answers before the first entry of the list', v9a === 'v2', v9a);
  const v9b = await bootWithSel2({}, {}, 'v1');
  check('T-679: with no word stored the chain is exactly what it was (check 7 unchanged)', v9b === 'v1', v9b);
  // A word that names a voice the list does not hold is the operator's "Fall back to the chain": the
  // word is not applied and nothing is invented for it.
  const v9c = await bootWithSel2({ 'deepamp:voice.fallback.tts': 'gone-voice' }, {}, 'v1');
  check('T-679: a word naming a deleted voice falls back to the chain instead of applying', v9c === 'v1', v9c);
  // The word is per lane: the stt lane has its own key and must not read the tts one.
  const v9d = await bootWithSel2({ 'deepamp:voice.fallback.stt': 'v2' }, {}, 'v1');
  check('T-679: the word is per lane - a stored stt fallback does not answer for the tts pick', v9d === 'v1', v9d);

  // 8. Format pick survives reload.
  const f8 = await bootWithSel2({ 'deepamp:sel': JSON.stringify({ tts: 'qwen3-tts', tts_fmt: 'mp3' }) }, {}, 'ogg');
  check('saved format restored', f8 === 'mp3', f8);

  // 9. A saved voice that was DELETED snaps to the first candidate (never blank).
  const v9 = await bootWithSel2(
    { 'deepamp:sel': JSON.stringify({ tts: 'qwen3-tts', tts_voice: 'gone-voice' }) }, {}, 'v1');
  check('deleted saved voice -> snaps to first candidate', v9 === 'v1', v9);

  console.log('\n--- T-227: "no voice" is a saved choice like any other ---');

  // 10. A saved NO VOICE pick restores as NO VOICE. This is the assertion the task turns
  //     on: restoring must not resurrect a voice. The resolver used to have only two
  //     outcomes for a stored value — a name it can find, or "snap to the first
  //     candidate" — and the sentinel is neither.
  const b10 = await bootVoice({ 'deepamp:sel': JSON.stringify({ tts: 'qwen3-tts', tts_voice: NO_VOICE }) }, {});
  const r10 = b10.read();
  check('T-227: saved NO VOICE pick restored after reload (the select shows the no-voice entry, not a name)',
    r10.value === NO_VOICE, r10.value);
  check('T-227: restoring NO VOICE writes no voice name back to localStorage',
    r10.stored && r10.stored.tts_voice === NO_VOICE, b10.raw());
  check('T-227: the entry is present and selectable on a plain tts model (qwen3-tts here is task "tts")',
    r10.nvPresent && r10.nvDisabled !== true, [r10.nvPresent, r10.nvDisabled, r10.values]);

  // 11. It survives the 15 s voice-dropdown loop. That loop re-runs the resolver with a
  //     fresh voice list, which is exactly the path that would silently snap a name back
  //     in a few seconds after the user chose "no voice".
  const ticked11 = await b10.tickVoice();
  const r11 = b10.read();
  check('T-227: the 15 s voice-dropdown refresh KEEPS NO VOICE selected (no snap back to a name)',
    ticked11 && r11.value === NO_VOICE, [ticked11, r11.value]);
  check('T-227: and that refresh still wrote no voice name to localStorage',
    r11.stored && r11.stored.tts_voice === NO_VOICE, b10.raw());

  // 12. Picking it in the dropdown persists it, and a fresh boot off THAT stored value
  //     restores it — the full round trip, not just one direction.
  const b12 = await bootVoice({ 'deepamp:sel': JSON.stringify({ tts: 'qwen3-tts', tts_voice: 'v1' }) }, {});
  const picked12 = await b12.pick(NO_VOICE);
  const r12 = b12.read();
  check('T-227: picking NO VOICE in the dropdown writes the sentinel to localStorage',
    picked12 && r12.value === NO_VOICE && r12.stored && r12.stored.tts_voice === NO_VOICE, [picked12, r12.value, b12.raw()]);
  const r12b = await bootVoice({ 'deepamp:sel': b12.raw() }, {}).then(function (b) { return b.read(); });
  check('T-227: a reload off that stored value restores NO VOICE (round trip closed, no voice resurrected)',
    r12b.value === NO_VOICE && r12b.stored && r12b.stored.tts_voice === NO_VOICE, [r12b.value, r12b.stored]);

  // 13. The gate, in memory terms. m2 is task "clon" (selection_memory.test.cjs:28) — the
  //     shape the host refuses voice-less (lib/index.js:5927-5932). A NO VOICE pick saved
  //     on a permissive model and carried onto a clone model must NOT survive as NO VOICE:
  //     the panel has to put a voice back on it, and it has to say why on the entry.
  const b13 = await bootVoice({ 'deepamp:sel': JSON.stringify({ tts: 'm2', tts_voice: NO_VOICE }) }, {});
  const r13 = b13.read();
  check('T-227 gate: on a task-clon model the NO VOICE entry is still listed but DISABLED',
    r13.nvPresent && r13.nvDisabled === true, [r13.nvPresent, r13.nvDisabled, r13.values]);
  check('T-227 gate: a saved NO VOICE pick on a clone model snaps to a real voice instead of dispatching voice-less',
    r13.value === 'v1', r13.value);
  check('T-227 gate: and the snap persisted the voice it chose (the next reload will not be voice-less either)',
    r13.stored && r13.stored.tts_voice === 'v1', b13.raw());

  // 14. The two invariants this suite was written for must still hold with the sentinel
  //     in the vocabulary: an unset voice still lands on the first candidate, and a
  //     DELETED saved voice still snaps to the first candidate. "no voice" is a third,
  //     distinct stored value — it must not swallow either of those.
  const b14a = await bootVoice({ 'deepamp:sel': JSON.stringify({ tts: 'qwen3-tts' }) }, {});
  const r14a = b14a.read();
  check('T-227: a stored pick with NO voice key still lands on the first candidate (test 7 unchanged)',
    r14a.value === 'v1', r14a.value);
  const b14b = await bootVoice({ 'deepamp:sel': JSON.stringify({ tts: 'qwen3-tts', tts_voice: 'gone-voice' }) }, {});
  const r14b = b14b.read();
  check('T-227: a DELETED saved voice still snaps to the first candidate, not to NO VOICE (test 9 unchanged)',
    r14b.value === 'v1' && r14b.stored && r14b.stored.tts_voice === 'v1', [r14b.value, b14b.raw()]);

  console.log('\n--- T-229: the job kind is remembered too, and a model is only ever restored into a kind that serves it ---');

  // 15. Nothing saved: the kind lands on the first DERIVED kind (voice) and the model on
  //     the first model that kind lists. (T-845 contract change, 2026-11-14 — see the note at the top of this file.)
  const b15 = await bootKind({});
  const k15 = b15.read();
  check('T-229: no saved kind -> the first kind the catalog serves', k15.kind === 'tts', k15.kind);
  check('T-229: and the model inside that kind is one the kind lists, in the order the lane lists it', k15.model === 'm1', [k15.model, k15.modelOptions]);
  check('T-229: the kind selector lists the served kinds only',
    k15.kindOptions.filter(function (o) { return !o.disabled; }).map(function (o) { return o.value; }).join(',') === 'tts,clon,sep,vc',
    JSON.stringify(k15.kindOptions));

  // 16. A saved kind is restored, with a model that serves it.
  const k16 = (await bootKind({ 'deepamp:sel': JSON.stringify({ tts_kind: 'sep' }) })).read();
  check('T-229: a saved tool kind is restored after reload', k16.kind === 'sep', k16.kind);
  check('T-229: and its model is one the kind serves', k16.model === 'bs_roformer' && k16.modelOptions.join(',') === 'bs_roformer', [k16.model, k16.modelOptions]);

  // 17. THE INVARIANT: a saved model the saved kind cannot serve is NOT restored into
  //     that kind. m1 is a task-tts model; the kind saved with it is 'sep'. The kind wins,
  //     and the model is re-picked inside the kind — never m1.
  const k17 = (await bootKind({ 'deepamp:sel': JSON.stringify({ tts_kind: 'sep', tts: 'm1', tts_models: { sep: 'm1' } }) })).read();
  check('T-229: a saved model the saved kind cannot serve is never restored',
    k17.kind === 'sep' && k17.model === 'bs_roformer' && k17.modelOptions.indexOf('m1') < 0, [k17.kind, k17.model, k17.modelOptions]);

  // 18. A saved kind no model serves is not restored either — it falls back to a served
  //     kind rather than showing an empty model list.
  const k18 = (await bootKind({ 'deepamp:sel': JSON.stringify({ tts_kind: 'gen' }) })).read();
  check('T-229: a saved kind no model serves falls back to a served kind, never an empty list',
    k18.kind === 'tts' && k18.modelOptions.length > 0, [k18.kind, k18.modelOptions]);

  // 19. Per-kind model memory: each kind keeps its own model across a round trip.
  const b19 = await bootKind({});
  const c19 = (await b19.drive('clon')) || {};
  check('T-229: the clone kind picks a model the clone kind serves', c19.model === 'm2', [c19.kind, c19.model]);
  const t19 = (await b19.drive('tts')) || {};
  // (T-845 contract change, 2026-11-14) Both values below used to be qwen3-tts because the client carried that name
  // as its preferred default. The memory being tested is the per-kind model memory, and it is still tested the same
  // way: what the kind resolved to on the first pass is what comes back on the second, and it is what is stored.
  check('T-229: back to the voice kind, the voice kind model is remembered', t19.model === 'm1', [t19.kind, t19.model]);
  check('T-229: both kinds and both models are in the stored selection',
    t19.stored && t19.stored.tts_kind === 'tts' && t19.stored.tts_models && t19.stored.tts_models.tts === 'm1' && t19.stored.tts_models.clon === 'm2', b19.raw());

  // 20. A kind picked in this session is what the NEXT reload restores.
  const v20 = (await b19.drive('vc')) || {};
  check('T-229: the kind picked in the panel is stored', v20.kind === 'vc' && v20.stored && v20.stored.tts_kind === 'vc', [v20.kind, b19.raw()]);
  const k20b = (await bootKind({ 'deepamp:sel': b19.raw() })).read();
  check('T-229: and the next reload restores that kind with a model that serves it',
    k20b.kind === 'vc' && k20b.model === 'vevo2', [k20b.kind, k20b.model]);

  // 21. T-242 (user report 2026-10-07): the dispatch lane is remembered like every other
  //     selection, and it belongs to the FN. A tool kind neither loses a remembered pin nor
  //     gets a lane of its own.
  const b21 = await bootLane(JSON.stringify({ tts_kind: 'sep', tts_models: { sep: 'bs_roformer' }, tts_lane: 'e-1' }));
  const s21 = b21.snap();
  check('T-242: a remembered tts_lane is restored into the lane select on a fresh boot, tool kind included',
    s21.lanes.length === 2 && !!s21.ttsLane && s21.ttsLane.props.value === 'e-1',
    s21.lanes.map(function (s) { return s.props.value; }));
  // T-597 (2026-10-20): the label this pin read ("TTS2 · e-1") is now "TTS2: cpu2.test" — the dropdown prints the
  // machine. The pin's point is unchanged and still measured the same way: the RESTORED VALUE is an id the live
  // registry really carries, not a value the panel made up.
  check('T-242: the restored pin is a live registry slot (TTS2: cpu2.test), not an invented value',
    !!s21.ttsLane && /TTS2: cpu2\.test/.test(JSON.stringify(s21.ttsLane.props.children || [])) && /"value":"e-1"/.test(JSON.stringify(s21.ttsLane.props.children || [])),
    JSON.stringify((s21.ttsLane && s21.ttsLane.props.children) || []).slice(0, 200));
  check('T-242: the tool kind the store saved is restored beside that lane', s21.kind === 'sep', s21.kind);

  // 22. A lane picked in front of a tool kind is stored, and the NEXT reload restores it.
  const b22 = await bootLane('{}');
  await b22.driveKind('sep');
  await b22.setLane('tts', 'e-1');
  check('T-242: a lane picked while a tool kind is showing is written to the selection store',
    b22.parsed().tts_lane === 'e-1', b22.raw());
  const s22b = (await bootLane(b22.raw())).snap();
  check('T-242: and the next reload restores that tool lane with the tool kind still selected',
    !!s22b.ttsLane && s22b.ttsLane.props.value === 'e-1' && s22b.kind === 'sep',
    [s22b.ttsLane ? s22b.ttsLane.props.value : null, s22b.kind]);

  // 23. The lane belongs to the fn: changing the kind inside the TTS section does not
  //     silently change it, in either direction.
  const b23 = await bootLane(JSON.stringify({ tts_lane: 'e-1' }));
  const s23a = b23.snap();
  const d23 = await b23.driveKind('vc');
  check('T-242: switching from a render kind to a tool kind does not silently change the lane',
    !!s23a.ttsLane && s23a.ttsLane.props.value === 'e-1' && d23.after.kind === 'vc'
    && !!d23.after.ttsLane && d23.after.ttsLane.props.value === 'e-1'
    && b23.parsed().tts_lane === 'e-1',
    [s23a.ttsLane && s23a.ttsLane.props.value, d23.after.kind, d23.after.ttsLane && d23.after.ttsLane.props.value, b23.raw()]);
  const d23b = await b23.driveKind('tts');
  check('T-242: and back to a render kind the SAME single lane control is still the one on screen (no second lane appeared for the tools)',
    d23b.after.kind === 'tts' && d23b.after.lanes.length === 2 && !!d23b.after.ttsLane && d23b.after.ttsLane.props.value === 'e-1',
    [d23b.after.kind, d23b.after.lanes.map(function (s) { return s.props.value; })]);

  // 24. One lane per fn, and the SAME normaliser: a corrupted value is auto, not a bogus pin.
  const s24 = (await bootLane(JSON.stringify({ tts_lane: 'nonsense', stt_lane: 'e-2' }))).snap();
  check('T-242: a corrupted tts_lane normalises to auto (the same normLane rule — no tool-only variant was added)',
    !!s24.ttsLane && s24.ttsLane.props.value === 'auto', s24.ttsLane && s24.ttsLane.props.value);
  check('T-242: the stt lane stays its own pick — one lane per fn, and the tool kinds share the tts one',
    !!s24.sttLane && s24.sttLane.props.value === 'e-2', s24.lanes.map(function (s) { return s.props.value; }));

  // 25. T-317 (user 2026-10-13): "auto-refresh - do we still use the setting ?" — yes, and it was the ONE panel
  //     setting that was edited but never kept: every reload went back to 5000 ms. It is persisted now, in the
  //     panel's own guarded store, and the clamp boot applies is the clamp the input applies, so what a person
  //     types and what the next page restores cannot disagree. The input is located by its own hover because the
  //     Settings section carries four number inputs (cadence, playlist limit, chunk size, generation timeout).
  async function bootCadence(seedValue) {
    global.localStorage = mkLs(seedValue === undefined ? {} : { 'deepamp:autorefresh': seedValue });
    const shim = createRuntime({
      makeHostNode: function (n) {
        return n.type === 'audio'
          ? { play: function () {}, pause: function () {} }
          : { tagName: n.type, getBoundingClientRect: function () { return { left: 1180, top: 10, width: 440, height: 400, right: 1620, bottom: 410 }; } };
      },
    });
    const client = loadClient(shim, { target: TARGET, fetch: mkFetch() });
    const comp = client.apply();
    if (!comp) throw new Error('panel did not register');
    const b = {};
    shim.render(comp(), b); shim.runEffects(); await flush(); shim.render(comp(), b);
    const num = shim.rt.created.filter(function (e) {
      return e.type === 'input' && String(e.props.type) === 'number'
        && /how often the panel asks the lane for status/.test(String(e.props.title || ''));
    }).pop();
    return { shim: shim, num: num, ls: global.localStorage };
  }
  const c25a = await bootCadence(undefined);
  check('T-317: nothing stored means the panel refreshes on its own default (5000 ms)',
    !!c25a.num && String(c25a.num.props.value) === '5000', c25a.num && c25a.num.props.value);
  // The edit is driven on the SAME boot it belongs to: every bootCadence installs its own store, so an edit
  // driven later would land in a later page's store and prove nothing.
  if (c25a.num && typeof c25a.num.props.onChange === 'function') {
    c25a.num.props.onChange({ target: { value: '20000' } });
    await flush();
    check('T-317: editing the input WRITES the store - the half that was missing',
      c25a.ls.getItem('deepamp:autorefresh') === '20000', c25a.ls.s['deepamp:autorefresh']);
    const c25f = await bootCadence('20000');
    check('T-317: and the next page starts at the number the person typed',
      !!c25f.num && String(c25f.num.props.value) === '20000', c25f.num && c25f.num.props.value);
    c25f.num.props.onChange({ target: { value: '99999999999' } });
    await flush();
    check('T-317: the input clamps to the same ceiling boot refuses, so what is typed and what is restored agree',
      c25f.ls.getItem('deepamp:autorefresh') === String(3600000), c25f.ls.s['deepamp:autorefresh']);
  } else {
    check('T-317: the auto-refresh input is there to be edited', false, 'no cadence input found');
  }
  const c25b = await bootCadence('12000');
  check('T-317: a stored cadence is RESTORED on boot - the setting the panel edits is the setting it keeps',
    !!c25b.num && String(c25b.num.props.value) === '12000', c25b.num && c25b.num.props.value);
  const c25c = await bootCadence('0');
  check('T-317: 0 is a legal cadence (polling off) and comes back as 0, never mistaken for an empty store',
    !!c25c.num && String(c25c.num.props.value) === '0', c25c.num && c25c.num.props.value);
  const c25d = await bootCadence('nonsense');
  check('T-317: a value that is not a cadence is not applied - the default answers, as it does for every other key',
    !!c25d.num && String(c25d.num.props.value) === '5000', c25d.num && c25d.num.props.value);
  const c25e = await bootCadence('99999999999');
  check('T-317: an absurd cadence is refused rather than trusted (a panel that never refreshes is stalled, not paced)',
    !!c25e.num && String(c25e.num.props.value) === '5000', c25e.num && c25e.num.props.value);

  // --- T-370 (user ruling 2026-10-14): when a model offers BOTH its own speakers and the stored voices,
  // which one is already selected? The user chose "Remember per model": "First time you land on a model you
  // get its own speaker; after you choose, your choice sticks for that model and is restored when you come
  // back." These run against the live panel with the model select driven the way a person drives it. ---
  console.log('\n--- T-370: the voice pick is remembered per model ---');
  {
    global.__TEST_BUILTINS = { m1: { voices: ['own_a', 'own_b'], default_voice: 'own_b' } };
    const REG370 = { voy_doctor: { ref_text: 'x', ref_wav: '/home/deepamp-test/.dsh/deepamp-audio/voices/voy_doctor.wav' } };
    const mem370 = function (raw) {
      let sel = null;
      try { sel = JSON.parse(raw); } catch (e) { return null; }
      let m = null;
      try { m = JSON.parse(sel.tts_voice_by_model370 || '{}'); } catch (e) { return null; }
      return m;
    };
    const b370 = await bootVoice({ 'deepamp:sel': JSON.stringify({ tts: 'qwen3-tts', tts_voice: 'voy_doctor' }) }, REG370);
    const r370a = b370.read();
    check('T-370 setup: on a model the host says has no speakers of its own, the stored pick stands and only the stored group is offered',
      r370a.value === 'voy_doctor' && b370.groupLabels().length === 1 && /stored voices/.test(b370.groupLabels()[0]),
      { value: r370a.value, labels: b370.groupLabels() });
    await b370.setModel('m1');
    const r370b = b370.read();
    const g370b = b370.groupLabels();
    check('T-370: landing on a model that declares its own speakers LANDS THE PICK on its declared default, not on the first stored voice',
      r370b.value === 'own_b' && r370b.stored && r370b.stored.tts_voice === 'own_b',
      { value: r370b.value, stored_voice: r370b.stored && r370b.stored.tts_voice });
    check('T-370: and the dropdown shows both, the model speakers in their own group first',
      g370b.length === 2 && /own speakers \(2\)/.test(g370b[0]) && /stored voices \(/.test(g370b[1]),
      g370b);
    check('T-370: an automatic landing is NOT remembered as a choice — the per-model memory is still empty for this model',
      !mem370(b370.raw()) || mem370(b370.raw()).m1 === undefined,
      mem370(b370.raw()));
    await b370.pick('voy_doctor');
    const r370c = b370.read();
    check('T-370: a pick a person made IS remembered, under the model it was made on',
      r370c.value === 'voy_doctor' && mem370(b370.raw()) && mem370(b370.raw()).m1 === 'voy_doctor',
      { value: r370c.value, memory: mem370(b370.raw()) });
    await b370.setModel('qwen3-tts');
    const r370d = b370.read();
    check('T-370: a model with no speakers of its own keeps a stored voice that fits it (no forced move, no invented voice)',
      r370d.value === 'voy_doctor' && b370.groupLabels().length === 1,
      { value: r370d.value, labels: b370.groupLabels() });
    await b370.setModel('m1');
    const r370e = b370.read();
    check('T-370: coming back to the model restores the choice made THERE, not the model default',
      r370e.value === 'voy_doctor', { value: r370e.value, memory: mem370(b370.raw()) });
    await b370.pick(NO_VOICE);
    await b370.setModel('qwen3-tts');
    await b370.setModel('m1');
    const r370f = b370.read();
    check('T-370: an intentional NO VOICE is remembered per model too, and is not snapped back to a name on return',
      r370f.value === NO_VOICE && mem370(b370.raw()).m1 === NO_VOICE,
      { value: r370f.value, memory: mem370(b370.raw()) });
    const b370r = await bootVoice({ 'deepamp:sel': b370.raw() }, REG370);
    const r370g = b370r.read();
    check('T-370: the memory survives a reload, and the model that was last selected comes back with the pick made on it',
      r370g.value === NO_VOICE && mem370(b370r.raw()) && mem370(b370r.raw()).m1 === NO_VOICE,
      { value: r370g.value, memory: mem370(b370r.raw()) });
    const b370h = await bootVoice({ 'deepamp:sel': JSON.stringify({ tts: 'm1', tts_voice: 'voy_doctor', tts_voice_by_model370: '{ this is not json' }) }, REG370);
    const r370h = b370h.read();
    check('T-370: a corrupt memory value reads as no memory, never as a pick and never as an error (the saved voice still restores)',
      r370h.value === 'voy_doctor', { value: r370h.value, raw: b370h.raw() });
    // Reached by a SWITCH, which is the path the ruling is about: boot has no pending model and keeps the
    // rules it has always had.
    const b370i = await bootVoice({ 'deepamp:sel': JSON.stringify({ tts: 'qwen3-tts', tts_voice: 'voy_doctor', tts_voice_by_model370: JSON.stringify({ m1: 'gone_voice_370' }) }) }, REG370);
    await b370i.setModel('m1');
    const r370i = b370i.read();
    check('T-370: a remembered voice the store no longer holds does not stick — the declared default of the model takes the pick',
      r370i.value === 'own_b', { value: r370i.value, offered: b370i.voiceValues() });
    global.__TEST_BUILTINS = null;
  }

  console.log('\n=== ' + pass + ' pass, ' + fail + ' fail ===');
  process.exitCode = fail ? 1 : 0;
})().catch(function (e) { console.log('HARNESS ERROR', e && e.stack); process.exitCode = 1; });
