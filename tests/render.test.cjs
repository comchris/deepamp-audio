// Renders the real audio-play client component tree and forces every nullable prop
// through null/undefined, empty and populated post-fetch shapes.
//
// The shim it renders with (react_shim.cjs) enforces react-dom's element contract, so
// this harness also catches the class of bug that shipped twice: passing children to a
// void tag (minified React error #137), which throws at commit and abdicates the
// shell.overlay entry. Usage: node tests/render.test.cjs [path/to/client.js]
const path = require('path');
const { createRuntime, loadClient, openAllSections, VOID_ELEMENTS } = require('./react_shim.cjs');

const TARGET = process.argv[2] || path.join(__dirname, '..', 'lib', 'client.js');

// seen: name -> { fn, props } for every function component actually reached.
const seen = new Map();
const shim = createRuntime({
  onComponent: function (name, props, key, fn) {
    if (!seen.has(name)) seen.set(name, { fn: fn, props: props });
  },
});
const client = loadClient(shim, { target: TARGET });
const registeredComp = client.apply();
if (!registeredComp) throw new Error('no component registered');

let pass = 0, fail = 0;
async function attempt(label, fn) {
  try { await fn(); pass++; console.log('  PASS  ' + label); return true; }
  catch (e) {
    fail++;
    const msg = e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n          ') : String(e);
    console.log('  THROW ' + label + '  ->  ' + msg);
    return false;
  }
}

// Every void element the loose runtime saw, as a "carries children" violation list.
function voidViolations(runtime) {
  return runtime.rt.created.filter(function (e) {
    return typeof e.type === 'string' && VOID_ELEMENTS[e.type] &&
      (e.props.children != null || e.props.dangerouslySetInnerHTML != null);
  });
}

(async function main() {
  console.log('file          :', TARGET);
  console.log('exports.inject:', JSON.stringify(client.mod.inject));
  console.log('apply() ->    ', typeof client.applyReturn);
  console.log('registered    :', JSON.stringify(client.desc));

  console.log('\n--- 0. the shim itself rejects void elements with children ---');
  // A suite that cannot express the production failure is not a suite.
  await attempt('shim throws on <input children={[]}>', function () {
    let threw = false;
    try { shim.createElement('input', { value: '' }, []); } catch (e) { threw = /#137|void element/.test(e.message); }
    if (!threw) throw new Error('shim accepted children on a void tag');
  });
  await attempt('shim throws on <br> with a child', function () {
    let threw = false;
    try { shim.createElement('br', {}, 'x'); } catch (e) { threw = /#137|void element/.test(e.message); }
    if (!threw) throw new Error('shim accepted children on <br>');
  });
  await attempt('shim allows <input> with no children arg', function () {
    shim.createElement('input', { value: '' });
  });
  await attempt('real tree: no void element carries children (sections all open)', async function () {
    // A second, NON-strict runtime: rather than only proving the panel throws somewhere,
    // inspect every element the tree hands React. This is the rule react-dom 18.3.1
    // enforces at commit (void tag && props.children != null) — the check that dropped
    // the slot. All sections are opened because the endpoint rows and the auto-refresh
    // input exist only there, and those are the inputs that crashed.
    const loose = createRuntime({ strictVoid: false });
    const c2 = loadClient(loose, { target: TARGET });
    const comp2 = c2.apply();
    if (!comp2) throw new Error('panel did not register in the loose runtime');
    await openAllSections(loose, comp2);
    const voids = loose.rt.created.filter(function (e) { return typeof e.type === 'string' && VOID_ELEMENTS[e.type]; });
    const bad = voidViolations(loose);
    console.log('  void elements built:', voids.length, '| inputs:', loose.rt.tags.input || 0);
    if ((loose.rt.tags.input || 0) < 8) {
      throw new Error('only ' + (loose.rt.tags.input || 0) + ' <input> elements built — not every section opened (expected >= 8)');
    }
    if (bad.length) {
      throw new Error(bad.length + ' void element(s) carry children, e.g. <' + bad[0].type + '> children=' + JSON.stringify(bad[0].props.children));
    }
  });

  console.log('\n--- 1. mount render (all state at initial values) ---');
  const tagsBefore = Object.assign({}, shim.rt.tags);
  await attempt('root render', function () { shim.render(registeredComp()); });
  console.log('  components reached:', Array.from(seen.keys()).join(', '));

  await attempt('every section opens and renders', async function () {
    await openAllSections(shim, registeredComp);
    const missing = ['EndpointRow'].filter(function (n) { return !seen.has(n); });
    if (missing.length) throw new Error('still not rendered: ' + missing.join(', '));
  });
  await attempt('mount built void elements (so #137 is really covered)', function () {
    const built = Object.keys(shim.rt.tags).filter(function (t) { return shim.rt.tags[t] > (tagsBefore[t] || 0); }).sort();
    console.log('  host tags built:', built.join(', '));
    if (built.indexOf('input') < 0) throw new Error('no <input> element was created during mount');
  });

  console.log('\n--- 2. each component with nullable props forced to null/undefined ---');
  const NULLABLE = ['busy', 'models', 'voices', 'status', 'ep', 'selModel', 'selVoice', 'playlist', 'expanded', 'queues'];
  // The components are module-private closures; onComponent collected them for us.
  const fnByName = {};
  for (const entry of seen) fnByName[entry[0]] = entry[1].fn;
  const targets = Array.from(seen.entries()).filter(function (e) { return fnByName[e[0]]; });
  // T-229 contract change: ToolsBox is no longer a section of its own — it is the
  // tool-kind input block mounted inside TtsBox, and it renders nothing unless the job
  // kind it is given is a tool kind. The shape matrix used to reach it through its own
  // Collapsible; it now reaches it with the same props plus a tool kind, so every
  // null/undefined/empty/populated check below still exercises the tool rows rather than
  // a null return.
  for (const t of targets) {
    if (t[0] === 'ToolsBox') t[1].props = Object.assign({}, t[1].props, { kind: 'sep' });
  }
  for (const [name, rec] of targets) {
    for (const key of NULLABLE) {
      if (!(key in rec.props)) continue;
      for (const hv of [null, undefined]) {
        await attempt(name + ' .' + key + ' = ' + String(hv), function () {
          const p = Object.assign({}, rec.props);
          p[key] = hv;
          shim.renderComponent(fnByName[name], p, { fresh: true, effects: false });
        });
      }
    }
  }

  function shapeEmpty(p) {
    if ('busy' in p) p.busy = { tts: false, stt: false };
    if ('models' in p) p.models = { tts: [], stt: [], task: [] };
    if ('voices' in p) p.voices = { tts: [], stt: [] };
    if ('status' in p) p.status = { tts: { ok: true, loaded_model: 'm' }, stt: { ok: false } };
    if ('selModel' in p) p.selModel = { tts: 'a', stt: 'b' };
    if ('selVoice' in p) p.selVoice = { tts: 'v', stt: '' };
    if ('expanded' in p) p.expanded = { tts: true, stt: true };
    if ('playlist' in p) p.playlist = [{ id: 'j1', fn: 'tts', kind: 'tts', status: 'ok', text: 'hi' }];
    if ('queues' in p) p.queues = { tts: { paused: false, running: null, queued: 0 }, stt: { paused: false, running: null, queued: 0 } };
    if ('ep' in p) p.ep = { url: 'http://x:1', route: 'speech' };
    return p;
  }
  function shapePopulated(p) {
    if ('busy' in p) p.busy = { tts: true, stt: true };
    if ('models' in p) p.models = { tts: [{ id: 'm1', loaded: true }], stt: [{ id: 's1', loaded: false }], task: [{ id: 'htdemucs', task: 'sep', quant: 'f16' }, { id: 'controlfoley', task: 'gen' }] };
    if ('voices' in p) p.voices = { tts: ['v1', 'v2'], stt: [] };
    if ('status' in p) p.status = { tts: { ok: true, loaded_model: 'm1' }, stt: { ok: true } };
    if ('selModel' in p) p.selModel = { tts: 'm1', stt: 's1', task: 'htdemucs' };
    if ('selVoice' in p) p.selVoice = { tts: 'v1', stt: '' };
    if ('expanded' in p) p.expanded = { tts: true, stt: true };
    if ('playlist' in p) p.playlist = [
      { id: 'j1', fn: 'tts', kind: 'tts', status: 'running', text: 'x', activity: 'synthesizing', started: Date.now() - 3000, model: 'm1', voice: 'v1' },
      { id: 'j1q', fn: 'tts', kind: 'tts', status: 'queued', text: 'q', position: 1, waiting_for_model: true, model: 'm2' },
      { id: 'j1c', fn: 'tts', kind: 'tts', status: 'cancelled', text: 'c' },
      { id: 'j1d', fn: 'tts', kind: 'tts', status: 'ok', text: 'd', duration: 12.5, filename: 'j1d_m1.wav', route_url: '/deepamp/j1d' },
      { id: 'j2', fn: 'stt', kind: 'stt', status: 'error', error: 'boom' },
      { id: 'j3', fn: 'stt', kind: 'stt', status: 'ok', transcript: 'a'.repeat(200), filename: 'j3_asr_src.txt', route_url: '/deepamp/j3' },
      // Tool lanes (2026-09-26): separation row with stems + diar row with speaker turns.
      { id: 'j4', fn: 'tts', kind: 'task', task_kind: 'sep', status: 'ok', model: 'htdemucs', route_url: '/deepamp/j4', src_url: '/deepamp/j4?src=1', stems: [{ id: 'vocals', url: '/deepamp/j4?stem=vocals' }, { id: 'drums', url: '/deepamp/j4?stem=drums' }] },
      { id: 'j5', fn: 'stt', kind: 'diar', status: 'ok', model: 'nemotron_3_diar', transcript: 'SPEAKER 0 [0.00s-3.00s] (0.90): hello', speaker_turns: [{ speaker_id: '0', start: 0, end: 3, confidence: 0.9, text: 'hello' }, { speaker_id: '1', start: 3, end: 5.2, confidence: 0.8, text: 'yes' }], src_url: '/deepamp/j5?src=1', route_url: '/deepamp/j5' },
    ];
    if ('queues' in p) p.queues = { tts: { paused: true, running: 'j1', queued: 3 }, stt: { paused: false, running: null, queued: 0 } };
    if ('ep' in p) p.ep = { url: 'http://cpu1.test:8963', route: 'tasks' };
    return p;
  }

  console.log('\n--- 3. "loaded" shape: busy/models/voices present but EMPTY (post-fetch) ---');
  for (const [name, rec] of targets) {
    await attempt(name + ' loaded-empty shape', function () {
      shim.renderComponent(fnByName[name], shapeEmpty(Object.assign({}, rec.props)), { fresh: true, effects: false });
    });
  }

  console.log('\n--- 4. "loaded" shape with POPULATED lists ---');
  for (const [name, rec] of targets) {
    await attempt(name + ' populated shape', function () {
      shim.renderComponent(fnByName[name], shapePopulated(Object.assign({}, rec.props)), { fresh: true, effects: false });
    });
  }

  console.log('\n--- 5. per-model built-in voices shape (crash 2026-09-20) ---');
  // The FIRST live render after a refresh had voicesBuiltin={tts:['alba']} with
  // selModel=pocket_tts — the merge block ran before `var vlist` (hoisting ->
  // undefined) and killed the whole shell.overlay entry. Force that shape.
  for (const [name, rec] of targets) {
    if (!('voicesBuiltin' in rec.props)) continue;
    await attempt(name + ' built-in voices populated', function () {
      const p = shapePopulated(Object.assign({}, rec.props));
      p.voicesBuiltin = { tts: ['alba'] };
      shim.renderComponent(fnByName[name], p, { fresh: true, effects: false });
    });
    await attempt(name + ' built-in voices + selVoice is a built-in', function () {
      const p = shapePopulated(Object.assign({}, rec.props));
      p.voices = { tts: [], stt: [] }; // server empty, selection a built-in
      p.selVoice = { tts: 'alba', stt: '' };
      p.voicesBuiltin = { tts: ['alba'] };
      shim.renderComponent(fnByName[name], p, { fresh: true, effects: false });
    });
    await attempt(name + ' voicesBuiltin garbage (null, string, missing)', function () {
      for (const g of [null, undefined, 'alba', {}]) {
        const p = shapePopulated(Object.assign({}, rec.props));
        p.voicesBuiltin = g;
        shim.renderComponent(fnByName[name], p, { fresh: true, effects: false });
      }
    });
  }

  console.log('\n--- 5b. T-227: the voice dropdown\'s NO VOICE entry (structure, gate, and what a row says) ---');
  // T-369 (2026-10-14): the voice dropdown is GROUPED now — the model's own speakers in one group, the
  // plugin's stored clone voices in another. A check that wants "the entries of the voice dropdown" must look
  // inside the groups as well as beside them: an optgroup is a heading, not a filter. This helper is the
  // flattening every voice-dropdown check below uses, so no check can accidentally look only at the first
  // group and report the other one as missing.
  function voiceOptsOf369(sel) {
    const kids = Array.isArray(sel.props.children) ? sel.props.children : [sel.props.children];
    const out = [];
    kids.forEach(function (k) {
      if (!k) return;
      if (k.type === 'optgroup') {
        const inner = Array.isArray(k.props.children) ? k.props.children : [k.props.children];
        inner.forEach(function (o) { out.push(o); });
      } else out.push(k);
    });
    return out;
  }
  await attempt('T-227: NO VOICE is the FIRST entry of the TTS voice dropdown, with its own value and its own label', function () {
    const rec = seen.get('TtsBox');
    if (!rec) throw new Error('TtsBox was never reached');
    const p = shapePopulated(Object.assign({}, rec.props));
    p.models = { tts: [{ id: 'm1', loaded: true, task: 'tts', family: 'voxcpm2', default_voice: true, clone_required: false }], stt: [], task: [] };
    p.selModel = { tts: 'm1', stt: 's1', task: 'htdemucs' };
    p.selVoice = { tts: 'v1', stt: '' };
    const mark = shim.rt.created.length;
    shim.renderComponent(fnByName.TtsBox, p, { fresh: true, effects: false });
    const tree = shim.rt.created.slice(mark);
    const sel = tree.filter(function (e) { return e.type === 'select' && /voice list - opening re-checks/.test(String(e.props.title || '')); }).pop();
    if (!sel) throw new Error('no voice <select> in the tree');
    const opts = voiceOptsOf369(sel);
    const sig = opts.map(function (o) { return o && o.props ? String(o.props.value) + '=' + ownTxt(o) : '?'; });
    if (!opts.length) throw new Error('the dropdown is empty');
    if (opts[0].props.value !== '__no_voice__') throw new Error('first entry is not NO VOICE: ' + sig.join(' | '));
    if (ownTxt(opts[0]) !== 'no voice \u2014 let the model choose') throw new Error('label: ' + ownTxt(opts[0]));
    if (opts[0].props.disabled === true) throw new Error('NO VOICE is disabled on a default_voice model');
    if (opts.some(function (o) { return o && o.props && String(o.props.value) === ''; })) throw new Error('an empty-value entry is back: ' + sig.join(' | '));
    if (!opts.some(function (o) { return o && o.props && o.props.value === 'v1'; })) throw new Error('the real voices disappeared: ' + sig.join(' | '));
  });
  await attempt('T-227: on a clone_required model the SAME entry is present but REFUSED, with the reason in its label', function () {
    const rec = seen.get('TtsBox');
    const p = shapePopulated(Object.assign({}, rec.props));
    p.models = { tts: [{ id: 'clon1', loaded: false, task: 'clon', family: 'glm_tts', default_voice: false, clone_required: true }], stt: [], task: [] };
    p.selModel = { tts: 'clon1', stt: 's1', task: 'htdemucs' };
    p.selVoice = { tts: 'v1', stt: '' };
    const mark = shim.rt.created.length;
    shim.renderComponent(fnByName.TtsBox, p, { fresh: true, effects: false });
    const tree = shim.rt.created.slice(mark);
    const sel = tree.filter(function (e) { return e.type === 'select' && /voice list - opening re-checks/.test(String(e.props.title || '')); }).pop();
    if (!sel) throw new Error('no voice <select> in the tree');
    const opts = voiceOptsOf369(sel);
    const nv = opts.filter(function (o) { return o && o.props && o.props.value === '__no_voice__'; })[0];
    if (!nv) throw new Error('the entry vanished instead of being refused: ' + opts.map(function (o) { return o && o.props && o.props.value; }).join(' | '));
    if (nv.props.disabled !== true) throw new Error('the entry is selectable on a clone_required model');
    if (!/unavailable: clone-only model/.test(ownTxt(nv))) throw new Error('no reason in the label: ' + ownTxt(nv));
    if (!/voice-clone family/.test(String(nv.props.title || ''))) throw new Error('no reason in the hover title: ' + nv.props.title);
  });
  // T-881 (2026-11-16): the voice_samples family on the single-voice form. The host refuses a voice_ref pick
  // on it before the dispatch, so the dropdown may not offer one; and the plain half of the family (NO VOICE,
  // the model's own voice) must stay selectable, because that dispatch is valid. The operator's panel press on
  // moss_ttsd is what this pair of facts pins.
  await attempt('T-881: on a samples_only model NO VOICE stays selectable, the stored names are NOT offered, and a named line points at the batch form', function () {
    const rec = seen.get('TtsBox');
    const p = shapePopulated(Object.assign({}, rec.props));
    p.models = { tts: [{ id: 'ms1', loaded: false, task: 'tts', family: 'moss_ttsd', default_voice: false, clone_required: false, clone_optional: false, samples_only: true }], stt: [], task: [] };
    p.selModel = { tts: 'ms1', stt: 's1', task: 'htdemucs' };
    p.selVoice = { tts: 'v1', stt: '' };
    const mark = shim.rt.created.length;
    shim.renderComponent(fnByName.TtsBox, p, { fresh: true, effects: false });
    const tree = shim.rt.created.slice(mark);
    const sel = tree.filter(function (e) { return e.type === 'select' && /voice list - opening re-checks/.test(String(e.props.title || '')); })[0];
    if (!sel) throw new Error('no voice <select> in the tree');
    const opts = voiceOptsOf369(sel);
    const nv = opts.filter(function (o) { return o && o.props && o.props.value === '__no_voice__'; })[0];
    if (!nv) throw new Error('NO VOICE vanished on a samples_only model');
    if (nv.props.disabled === true) throw new Error('NO VOICE was refused on a samples_only model — plain generation is a valid dispatch');
    if (opts.some(function (o) { return o && o.props && o.props.value === 'v1'; })) throw new Error('a stored voice was offered on a model whose route refuses voice_ref');
    const line = opts.filter(function (o) { return o && o.props && String(o.props.value) === '__samples_only_form369'; })[0];
    if (!line) throw new Error('the samples-only line is missing: ' + opts.map(function (o) { return o && o.props && String(o.props.value); }).join(' | '));
    if (line.props.disabled !== true) throw new Error('the samples-only line is selectable — it is a statement, not a pick');
    if (!/batch form \(speakers\)/.test(ownTxt(line))) throw new Error('the line does not name the route that clones: ' + ownTxt(line));
  });
  await attempt('T-227: with no voices listed the dropdown still carries NO VOICE and a stated empty list (no invisible empty option)', function () {
    const rec = seen.get('TtsBox');
    const p = shapePopulated(Object.assign({}, rec.props));
    p.voices = { tts: [], stt: [] };
    p.voiceReg = {};
    p.voicesBuiltin = null;
    p.models = { tts: [{ id: 'm1', loaded: true, task: 'tts', family: 'voxcpm2', default_voice: true, clone_required: false }], stt: [], task: [] };
    p.selModel = { tts: 'm1', stt: 's1', task: 'htdemucs' };
    p.selVoice = { tts: '__no_voice__', stt: '' };
    const mark = shim.rt.created.length;
    shim.renderComponent(fnByName.TtsBox, p, { fresh: true, effects: false });
    const tree = shim.rt.created.slice(mark);
    const sel = tree.filter(function (e) { return e.type === 'select' && /voice list - opening re-checks/.test(String(e.props.title || '')); }).pop();
    if (!sel) throw new Error('no voice <select> in the tree');
    const opts = voiceOptsOf369(sel);
    if (!opts.some(function (o) { return o && o.props && o.props.value === '__no_voice__'; })) throw new Error('NO VOICE missing when the list is empty');
    const none = opts.filter(function (o) { return o && o.props && o.props.value === '__no_voices_listed'; })[0];
    if (!none || none.props.disabled !== true) throw new Error('the empty list is not stated: ' + opts.map(function (o) { return o && o.props && o.props.value; }).join(' | '));
    if (opts.some(function (o) { return o && o.props && String(o.props.value) === ''; })) throw new Error('an empty-value entry is back');
    // And the panel states the choice in its own slot.
    const line = tree.filter(function (e) { return e.props && e.props.className === 'audio-play-voice-none'; });
    if (line.length !== 1) throw new Error('no-voice line count: ' + line.length);
    if (!/no voice field/.test(ownTxt(line[0]))) throw new Error('line text: ' + ownTxt(line[0]));
  });
  // --- T-369 (user ruling 2026-10-14): "if such a model is selected, the voice selector switches to those
  // available voices, instead of the clone samples, for models that support both -> show both".
  // The dropdown already carried both kinds of voice (T-247 registry, T-333 model speakers) but carried them
  // FLAT, so a model with its own speakers looked like a clone model with one extra name. These checks pin the
  // shape the ruling asked for, and the one case where names are withheld on purpose. ---
  const v369Sel = function (tree) {
    return tree.filter(function (e) { return e.type === 'select' && /voice list - opening re-checks/.test(String(e.props.title || '')); }).pop();
  };
  const v369Groups = function (sel) {
    const kids = sel && Array.isArray(sel.props.children) ? sel.props.children : [];
    return kids.filter(function (k) { return k && k.type === 'optgroup'; });
  };
  const v369GroupVals = function (g) { return voiceOptsOf369(g).map(function (o) { return o && o.props ? String(o.props.value) : '?'; }); };
  const v369Fixture = function (over) {
    const rec = seen.get('TtsBox');
    const p = shapePopulated(Object.assign({}, rec.props));
    p.voices = { tts: ['voy_kate'], stt: [] };
    p.voiceReg = { voy_kate: { ref_wav: '/x/voy_kate.wav', ref_text: 'a line', ref_dur_s: 4.2 } };
    p.selModel = { tts: 'm1', stt: 's1', task: 'htdemucs' };
    p.selVoice = { tts: 'voy_kate', stt: '' };
    p.voicesBuiltin = { tts: [] };
    p.voicesBuiltinSrc = 'none';
    p.voicesDefault = '';
    Object.keys(over).forEach(function (k) { p[k] = over[k]; });
    const picked = [];
    p.onSelectVoice = function (fn2, v) { picked.push(fn2 + '=' + v); };
    return { p: p, picked: picked };
  };
  await attempt('T-369: a model that has its own speakers AND takes a stored sample shows BOTH, the model group first, each group labelled with what it is', function () {
    const f = v369Fixture({
      models: { tts: [{ id: 'pock1', loaded: true, task: 'tts', family: 'pocket_tts', default_voice: true, clone_required: false, clone_optional: true }], stt: [], task: [] },
      selModel: { tts: 'pock1', stt: 's1', task: 'htdemucs' },
      voicesBuiltin: { tts: ['alba'] }, voicesBuiltinSrc: 'capability', voicesDefault: 'alba',
    });
    const mark = shim.rt.created.length;
    shim.renderComponent(fnByName.TtsBox, f.p, { fresh: true, effects: false });
    const tree = shim.rt.created.slice(mark);
    const sel = v369Sel(tree);
    if (!sel) throw new Error('no voice <select>');
    const groups = v369Groups(sel);
    const labels = groups.map(function (g) { return String(g.props.label || ''); });
    const opts = voiceOptsOf369(sel);
    if (groups.length !== 2) throw new Error('group count: ' + groups.length + ' [' + labels.join(' | ') + ']');
    if (!/this model's own speakers \(1\)/.test(labels[0]) || !/engine record for this model's family/.test(labels[0])) throw new Error('model group label: ' + labels[0]);
    if (!/stored voices \(1\)/.test(labels[1]) || !/plugin's own clone samples/.test(labels[1])) throw new Error('stored group label: ' + labels[1]);
    if (v369GroupVals(groups[0]).join(',') !== 'alba' || v369GroupVals(groups[1]).join(',') !== 'voy_kate') throw new Error('group contents: ' + labels.join(' | ') + ' :: ' + v369GroupVals(groups[0]) + ' / ' + v369GroupVals(groups[1]));
    if (opts[0].props.value !== '__no_voice__') throw new Error('NO VOICE is no longer the first entry: ' + opts.map(function (o) { return o && o.props && o.props.value; }).join(' | '));
    if (String(sel.props.value) !== 'voy_kate') throw new Error('a valid pick was moved: ' + sel.props.value);
    if (f.picked.length) throw new Error('the panel moved a pick that was fine: ' + f.picked.join(','));
    if (tree.filter(function (e) { return e.props && e.props.className === 'audio-play-voice-switch369'; }).length) throw new Error('a switch note rendered when nothing switched');
  });
  await attempt('T-369: a model with its own speakers that takes NO stored sample gets its own speakers only, and the withheld stored voices are named, not hidden', function () {
    const f = v369Fixture({
      models: { tts: [{ id: 'kok1', loaded: true, task: 'tts', family: 'kokoro_tts', default_voice: true, clone_required: false, clone_optional: false }], stt: [], task: [] },
      selModel: { tts: 'kok1', stt: 's1', task: 'htdemucs' },
      voicesBuiltin: { tts: ['af_bella', 'af_heart'] }, voicesBuiltinSrc: 'capability', voicesDefault: 'af_heart',
    });
    const mark = shim.rt.created.length;
    shim.renderComponent(fnByName.TtsBox, f.p, { fresh: true, effects: false });
    const tree = shim.rt.created.slice(mark);
    const sel = v369Sel(tree);
    if (!sel) throw new Error('no voice <select>');
    const groups = v369Groups(sel);
    if (groups.length !== 1 || !/this model's own speakers \(2\)/.test(String(groups[0].props.label || ''))) throw new Error('groups: ' + groups.map(function (g) { return g.props.label; }).join(' | '));
    if (v369GroupVals(groups[0]).join(',') !== 'af_bella,af_heart') throw new Error('model group contents: ' + v369GroupVals(groups[0]));
    const held = voiceOptsOf369(sel).filter(function (o) { return o && o.props && o.props.value === '__stored_not_offered369'; })[0];
    if (!held || held.props.disabled !== true) throw new Error('the withheld stored voices are not stated as a line');
    if (!/1 held in the store/.test(String(held.props.children)) || !/not offered on this model/.test(String(held.props.children))) throw new Error('withheld line: ' + held.props.children);
    if (voiceOptsOf369(sel).some(function (o) { return o && o.props && o.props.value === 'voy_kate'; })) throw new Error('a stored voice is offered on a model that takes none');
    if (f.picked.join(',') !== 'tts=af_heart') throw new Error('the stale pick did not snap to the model default: ' + f.picked.join(','));
    // The note is a state write, so it exists on the NEXT render — the same rule every other piece of state in
    // this panel follows. The second render carries the pick the snap asked for, which is what the panel's own
    // selection state would hold a moment later.
    f.p.selVoice = { tts: 'af_heart', stt: '' };
    const mark2 = shim.rt.created.length;
    shim.renderComponent(fnByName.TtsBox, f.p, { fresh: false, effects: false });
    const tree2 = shim.rt.created.slice(mark2);
    const note = tree2.filter(function (e) { return e.props && e.props.className === 'audio-play-voice-switch369'; }).pop();
    if (!note) throw new Error('no switch note rendered');
    const nt = ownTxt(note);
    // T-832 contract change (2026-11-13, the operator's word, verbatim: "shorten \"the voice pick moved: 'Vincent'
    // is not offered on 'breeze_tts' — now 'noplacelikelocalhost' (a voice in the plugin's store)\" to selected
    // voice: 'Vincent' is not on 'breeze_tts' now: 'noplacelikelocalhost'"). What this pin measures is unchanged:
    // both names are on the line, the old one and the new one, and what the new pick IS is still named. What moved
    // is where that last part is printed - off the line a person reads and onto the notice's hover.
    if (!/voy_kate/.test(nt) || !/af_heart/.test(nt) || !/is not on 'kok1' now: 'af_heart'/.test(nt)) throw new Error('switch note: ' + nt);
    if (!/this model's own speaker/.test(String(note.props.title || ''))) throw new Error('the note hover does not name what the new pick is: ' + String(note.props.title || ''));
  });
  await attempt('T-369: a clone-only model is untouched — stored voices only, no model group, and the line that names the empty answer is still there', function () {
    const f = v369Fixture({
      models: { tts: [{ id: 'clon1', loaded: false, task: 'clon', family: 'glm_tts', default_voice: false, clone_required: true, clone_optional: true }], stt: [], task: [] },
      selModel: { tts: 'clon1', stt: 's1', task: 'htdemucs' },
    });
    const mark = shim.rt.created.length;
    shim.renderComponent(fnByName.TtsBox, f.p, { fresh: true, effects: false });
    const tree = shim.rt.created.slice(mark);
    const sel = v369Sel(tree);
    const groups = v369Groups(sel);
    if (groups.length !== 1 || !/stored voices \(1\)/.test(String(groups[0].props.label || ''))) throw new Error('groups on a clone model: ' + groups.map(function (g) { return g.props.label; }).join(' | '));
    if (groups.some(function (g) { return /own speakers/.test(String(g.props.label || '')); })) throw new Error('a model group appeared on a model with no speakers declared');
    const line = tree.filter(function (e) { return e.props && e.props.className === 'audio-play-no-model-speakers'; });
    if (line.length !== 1) throw new Error('the empty-answer line count: ' + line.length);
    // T-832 contract change (2026-11-13, the operator asked for this line by name: "shorten \"this model reports
    // no built-in speakers on the lane — the voices listed here are the plugin's registry clones\" to \"this model
    // reports no built-in speakers, using registry clone samples\""). The line still has to say both halves - what
    // the lane does not offer, and what the dropdown is therefore holding. Only the wording is shorter.
    if (!/no built-in speakers, using registry clone samples/.test(ownTxt(line[0]))) throw new Error('line text: ' + ownTxt(line[0]));
  });
  await attempt('T-369: a host that answers no clone flag keeps the stored voices on screen but labels them as unconfirmed, because hiding a voice this host would accept is the worse error', function () {
    const f = v369Fixture({
      models: { tts: [{ id: 'old1', loaded: true, task: 'tts', family: 'pocket_tts', default_voice: true, clone_required: false }], stt: [], task: [] },
      selModel: { tts: 'old1', stt: 's1', task: 'htdemucs' },
      voicesBuiltin: { tts: ['alba'] }, voicesBuiltinSrc: 'capability', voicesDefault: 'alba',
    });
    const mark = shim.rt.created.length;
    shim.renderComponent(fnByName.TtsBox, f.p, { fresh: true, effects: false });
    const tree = shim.rt.created.slice(mark);
    const groups = v369Groups(v369Sel(tree));
    const labels = groups.map(function (g) { return String(g.props.label || ''); });
    if (groups.length !== 2) throw new Error('group count with an unknown flag: ' + groups.length + ' [' + labels.join(' | ') + ']');
    if (!/not confirmed on this model by this host/.test(labels[1])) throw new Error('stored group label without the honest caveat: ' + labels[1]);
    if (!/voy_kate/.test(v369GroupVals(groups[1]).join(','))) throw new Error('stored voices were hidden from an old host: ' + v369GroupVals(groups[1]));
  });

  // --- T-371 (user ruling 2026-10-14, after the restart, verbatim): "the generate (queued) button should be
  // in known neon green and \"show\" some feedback for a second after press - \"queued as ap-XXX\" for example".
  // RE-RULED 2026-10-27 (T-664, operator ruling 09:3x Berlin: "make only the outer frame of the button green,
  // keep the font white", with the green named being the one the player's rate read-out prints, #3fb950). What
  // these pins protect is UNCHANGED — a pressable control is lit, a control that cannot be pressed is not, a
  // refusal is shown rather than hidden — only which property carries the signal moved: the FRAME now, not the
  // FILL. The old pins asked `background === '#00c800'`; the new ones ask `borderColor === '#3fb950'` and white
  // text, and they also assert the filled block is gone, so a later session cannot quietly paint it back.
  // SCOPE_GREEN300 still paints the Winamp-style transport it was copied from; these pins no longer cover it. ---
  const g371Btn = function (tree) {
    return tree.filter(function (e) { return e.type === 'button' && e.props && /audio-play-generate371/.test(String(e.props.className || '')); }).pop();
  };
  const g371Props = function (over) {
    const rec = seen.get('TtsBox');
    const p = shapePopulated(Object.assign({}, rec.props));
    p.ttsText = 'a line to synthesize';
    p.busy = { tts: null, stt: null };
    p.dispatchFlash371 = null;
    Object.keys(over).forEach(function (k) { p[k] = over[k]; });
    const mark = shim.rt.created.length;
    shim.renderComponent(fnByName.TtsBox, p, { fresh: true, effects: false });
    const tree = shim.rt.created.slice(mark);
    const b = g371Btn(tree);
    if (!b) throw new Error('the go button has no name a check can point at (audio-play-generate371 missing)');
    return b;
  };
  await attempt('T-371, frame re-ruled 2026-10-27: a pressable Generate is framed in the LED green of the panel with white text on its own dark box', function () {
    const b = g371Props({});
    const st = b.props.style || {};
    if (st.borderColor !== '#3fb950') throw new Error('borderColor: ' + st.borderColor);
    if (st.color !== '#fff') throw new Error('text colour: ' + st.color);
    if (st.background === '#00c800') throw new Error('the button is still a filled green block: ' + st.background);
    if (st.background !== '#22222a') throw new Error('the live button no longer sits on the box of the panel: ' + st.background);
    if (b.props.disabled === true) throw new Error('a pressable button rendered disabled');
    if (String(b.props.children) !== 'Generate (TTS)') throw new Error('label at rest: ' + b.props.children);
  });
  await attempt('T-371 (title re-pointed by T-688, 2026-10-29): with nothing to say the button still does nothing — it is dim in its words, aria-disabled, pressable, and it names the reason on the hover', function () {
    const b = g371Props({ ttsText: '   ' });
    const st = b.props.style || {};
    // T-399: the empty-text button is no longer hard-disabled, because a disabled button swallows the press and the
    // user asked for a visible reaction to exactly that press. What the T-371 ruling protects — "a glowing control
    // that does nothing is what a colour is supposed to prevent" — is still protected here: the button is dim in its
    // words, aria-disabled, and says on the hover why it is off.
    // T-688 (2026-10-29, the operator, verbatim: "gie all "generate buttons" the same green as we hae in the upper
    // player around the generate button - neon green outer border - so all generate buttons look like the top one").
    // This supersedes the FRAME half of the dim look. The sentence above once carried, that the difference must be
    // visible in the colour of a lane that cannot start, is now answered by the words and the hover instead of the
    // edge: every control that starts work wears the same frame, because the operator saw the waiting button as a
    // different kind of control - the asymmetry of availability T-387 item 3 named is exactly what was removed.
    if (st.borderColor !== '#3fb950') throw new Error('an empty-text lane button does not wear the same edge as a live one: ' + st.borderColor);
    if (st.color !== '#8ad9a5') throw new Error('an empty-text lane button has no dim text: ' + st.color);
    if (st.opacity !== '0.8') throw new Error('the dim look of a lane that cannot start moved out of the style: ' + st.opacity);
    if (b.props.disabled === true) throw new Error('an empty-text button with a reason is still hard-disabled, so its press would be swallowed');
    if (b.props['aria-disabled'] !== true) throw new Error('an empty-text button is pressable without being aria-disabled');
    if (!/off because nothing typed in the text box/.test(String(b.props.title || ''))) throw new Error('an empty-text button carries no reason: ' + String(b.props.title || '').slice(0, 90));
  });
  await attempt('T-371: after a press the button names the job it queued, and stays green while it says so', function () {
    const b = g371Props({ dispatchFlash371: { tts: { kind: 'ok', id: 'ap-0417' } } });
    if (String(b.props.children) !== 'queued as ap-0417') throw new Error('press feedback label: ' + b.props.children);
    if ((b.props.style || {}).borderColor !== '#3fb950') throw new Error('the success flash lost the frame: ' + (b.props.style || {}).borderColor);
  });
  await attempt('T-371: a refusal is shown on the button too, in the alarm red the panel already means, not swallowed', function () {
    const b = g371Props({ dispatchFlash371: { tts: { kind: 'fail', id: '' } } });
    if (String(b.props.children) !== 'not queued') throw new Error('refusal label: ' + b.props.children);
    if ((b.props.style || {}).background !== '#f85149') throw new Error('refusal colour: ' + (b.props.style || {}).background);
  });
  await attempt('T-371: the queued label survives a busy lane, and the flash label wins over it only while it is showing', function () {
    const busyBtn = g371Props({ busy: { tts: 1, stt: null } });
    if (String(busyBtn.props.children) !== 'Generate (queued)') throw new Error('busy label: ' + busyBtn.props.children);
    if ((busyBtn.props.style || {}).borderColor !== '#3fb950') throw new Error('a queued lane lost the frame: ' + (busyBtn.props.style || {}).borderColor);
    const flashed = g371Props({ busy: { tts: 1, stt: null }, dispatchFlash371: { tts: { kind: 'ok', id: 'ap-0418' } } });
    if (String(flashed.props.children) !== 'queued as ap-0418') throw new Error('flash over busy: ' + flashed.props.children);
  });

  await attempt('T-371b: the feedback is per lane — a flash on another lane does not speak through this button', function () {
    const b = g371Props({ dispatchFlash371: { stt: { kind: 'ok', id: 'ap-0500' }, task: { kind: 'fail', id: '' } } });
    if (String(b.props.children) !== 'Generate (TTS)') throw new Error('another lane spoke through the tts button: ' + b.props.children);
    if ((b.props.style || {}).borderColor !== '#3fb950') throw new Error('the tts button lost its own colour because another lane failed: ' + (b.props.style || {}).borderColor);
  });

  await attempt('T-227: a playlist row says plainly whether a voice was sent (and a cast/batch row does not claim it)', function () {
    const rec = seen.get('PlaylistPane');
    if (!rec) throw new Error('PlaylistPane was never reached');
    const p = shapePopulated(Object.assign({}, rec.props));
    p.playlist = [
      { id: 'nv1', fn: 'tts', kind: 'tts', status: 'ok', text: 'no voice sent', model: 'm1', duration: 2.5 },
      { id: 'nv2', fn: 'tts', kind: 'tts', status: 'ok', text: 'named voice', model: 'm1', voice: 'v1', duration: 2.5 },
      { id: 'nv3', fn: 'tts', kind: 'tts', status: 'ok', text: 'cast take', model: 'm1', speakers: ['a', 'b'], duration: 4 },
      { id: 'nv4', fn: 'tts', kind: 'tts', status: 'ok', text: 'batch part', model: 'm1', batch_id: 'b1', duration: 4 },
    ];
    const mark = shim.rt.created.length;
    shim.renderComponent(fnByName.PlaylistPane, p, { fresh: true, effects: false });
    const rows = shim.rt.created.slice(mark).filter(function (e) {
      return e.type === 'div' && typeof e.props.title === 'string' && /^nv\d {2}\| {2}status:/.test(e.props.title);
    });
    if (rows.length !== 4) throw new Error('rows found: ' + rows.map(function (r) { return r.props.title.slice(0, 12); }).join(' | '));
    const byId = {};
    rows.forEach(function (r) { byId[r.props.title.split(' ')[0]] = r; });
    const leafText = function (el) {
      const out = [];
      (function walk(v) {
        if (v == null) return;
        if (typeof v === 'string' || typeof v === 'number') { out.push(String(v)); return; }
        if (Array.isArray(v)) { v.forEach(walk); return; }
        if (v.props) walk(v.props.children);
      })(el);
      return out.join(' ');
    };
    if (!/voice: none sent/.test(byId.nv1.props.title)) throw new Error('nv1 hover title: ' + byId.nv1.props.title);
    if (!/no voice/.test(leafText(byId.nv1))) throw new Error('nv1 meta: ' + leafText(byId.nv1));
    if (/none sent/.test(byId.nv2.props.title) || /no voice/.test(leafText(byId.nv2))) throw new Error('nv2 (a named voice) reads as voice-less: ' + leafText(byId.nv2));
    if (!/voice: v1/.test(byId.nv2.props.title)) throw new Error('nv2 hover title lost the voice: ' + byId.nv2.props.title);
    if (/none sent/.test(byId.nv3.props.title) || /no voice/.test(leafText(byId.nv3))) throw new Error('a cast row claims no voice: ' + byId.nv3.props.title);
    if (/none sent/.test(byId.nv4.props.title) || /no voice/.test(leafText(byId.nv4))) throw new Error('a batch part claims no voice: ' + byId.nv4.props.title);
  });

  console.log('\n--- 6. T-195: the endpoint-registry components (row, add form, lane select, machines) ---');

  // T-195 added four components to the client. They must survive the same treatment the
  // older ones get: reached in the real tree, and null-tolerant when the host has not
  // answered yet (registry null, machines null, endpoints missing, garbage lane).
  await attempt('T-195: LaneSelect / EndpointAddForm are reached with every section open (T-223: machines block removed from Endpoints)', function () {
    const missing = ['LaneSelect', 'EndpointAddForm'].filter(function (n) { return !seen.has(n); });
    if (missing.length) throw new Error('not rendered: ' + missing.join(', '));
    // T-223 (user request 1): the Machines block is GONE from the Endpoints section, so the
    // component that rendered it must not be reached anywhere in the tree.
    if (seen.has('MachinesPane')) throw new Error('MachinesPane is still reached — the Machines block was not removed');
  });
  await attempt('T-195: with an EMPTY registry no registry row component is reached (pre-T-188 section shape)', function () {
    if (seen.has('RegistryEndpointRow')) throw new Error('RegistryEndpointRow rendered with an empty registry');
  });
  await attempt('T-195: lane select / add form survive null + garbage props (T-223: machines block removed from Endpoints)', function () {
    const garbage = [
      { fn: 'tts', lane: null, endpoints: null, onLane: null, onRefresh: null },
      { fn: undefined, lane: 'e-99', endpoints: undefined, onLane: undefined },
      { fn: 'stt', lane: 'nonsense', endpoints: [null, { id: 'e-1' }, {}], onLane: null },
      { fn: 'tts', lane: { bad: 1 }, endpoints: 'not-a-list', onLane: null },
    ];
    for (const p of garbage) {
      shim.renderComponent(fnByName.LaneSelect, p, { fresh: true, effects: false });
    }
    for (const p of [{ onAdd: null }, { onAdd: undefined }, {}]) {
      shim.renderComponent(fnByName.EndpointAddForm, p, { fresh: true, effects: false });
    }
    // T-223: the machine view is not just unreached, it is GONE — no component to hand
    // garbage props to. The queue_status answer itself is untouched (the host still reports
    // `machines`); only the client-side rendering of it was removed.
    if (fnByName.MachinesPane) throw new Error('MachinesPane still exists as a component');
  });
  await attempt('T-597 (operator 2026-10-20, verbatim: "in general - the labels \'e-10\' and \'e11\' for lanes - what are those for? Using TTS1, TTS2, TTS3 uniformly would look better in \'lane dropdown\' or better: \'TTS1: HOSTNAME\'"): the lane dropdown prints the machine on its face and sends the same values as before', function () {
    const ep597 = function (id, url, host) {
      return { id: id, fn: 'tts', url: url, route: 'speech', host: host, enabled: true, batch_allowed: true, paused: false, models: [] };
    };
    const oneLane597 = function (list, primary) {
      const mark597 = shim.rt.created.length;
      shim.renderComponent(fnByName.LaneSelect, { fn: 'tts', lane: 'auto', endpoints: list, primary: primary, onLane: null, onRefresh: null }, { fresh: true, effects: false });
      const sel = shim.rt.created.slice(mark597).filter(function (e) { return e.type === 'select' && String((e.props || {}).className || '') === 'audio-play-lane'; })[0];
      if (!sel) throw new Error('no lane select was rendered');
      const kids = (sel.props.children || []).filter(Boolean);
      return {
        labels: kids.map(function (o) { return String((o.props || {}).children); }),
        values: kids.map(function (o) { return String((o.props || {}).value); }),
        width: String(((sel.props || {}).style || {}).width || ''),
        tip: String((sel.props || {}).title || ''),
      };
    };
    // (a) The shape the operator asked for: one endpoint per machine, so the machine names the slot.
    const a597 = oneLane597([ep597('e-11', 'http://cpu2.test:8963', 'cpu2.test')],
      { id: 'primary', url: 'http://cpu1.test:8963', route: 'speech', host: 'cpu1.test' });
    if (a597.labels.join('|') !== 'auto|TTS1: cpu1.test|TTS2: cpu2.test')
      throw new Error('the dropdown does not name the machine the slot is on: ' + a597.labels.join(' | '));
    // The values are the T-195 / T-204 contract and they did not move: a pin still pins, a saved lane still
    // restores, and the number a dispatch carries is the same number the host gates (cleanEndpointPin).
    if (a597.values.join('|') !== 'auto|primary|e-11')
      throw new Error('the VALUE a lane control sends changed (T-195 / T-204 contract): ' + a597.values.join(' | '));
    // (b) Two endpoints of ONE lane on ONE machine (a live shape in this fleet: two ports on one box). The machine
    // name alone would print the same words for both, so the port joins the name — and the registry number stays
    // off the face, because the question the operator asked was what those numbers are for.
    const b597 = oneLane597([ep597('e-11', 'http://cpu1.test:8964', 'cpu1.test'), ep597('e-12', 'http://gpu1.test:8963', 'gpu1.test')],
      { id: 'primary', url: 'http://cpu1.test:8963', route: 'speech', host: 'cpu1.test' });
    if (b597.labels.join('|') !== 'auto|TTS1: cpu1.test:8963|TTS2: cpu1.test:8964|TTS3: gpu1.test')
      throw new Error('two endpoints on one machine are not told apart by their port: ' + b597.labels.join(' | '));
    if (b597.values.join('|') !== 'auto|primary|e-11|e-12')
      throw new Error('the values moved with the labels: ' + b597.values.join(' | '));
    if (b597.width === a597.width)
      throw new Error('the control is still a fixed width while printing a longer name than it can show: ' + a597.width + ' vs ' + b597.width);
    // (c) An entry the host answered without a machine names its slot and nothing more — the panel does not invent
    // a hostname it was not given, and it does not fall back to the bare id the operator questioned.
    const c597 = oneLane597([{ id: 'e-13', fn: 'tts', url: '', route: 'speech', enabled: true, batch_allowed: true, paused: false, models: [] }], null);
    if (c597.labels.join('|') !== 'auto|TTS1|TTS2')
      throw new Error('a slot with no machine answer invented something: ' + c597.labels.join(' | '));
    // (d) The hover explains what the words on the list mean, in user words (U-18), and the T-195 contract title
    // still starts the hover — the new sentence is appended, not inserted.
    if (!/^which endpoint this job asks for\./.test(a597.tip))
      throw new Error('the lane hover no longer starts with the T-195 contract sentence: ' + a597.tip.slice(0, 80));
    if (!/Two endpoints of one lane on one machine are named with their port too/.test(a597.tip))
      throw new Error('the lane hover does not explain the machine name: ' + a597.tip.slice(0, 200));
  });
  await attempt('T-195: a POPULATED registry renders one row per endpoint, with controls, and no void tag carries children (T-223: machines block removed from Endpoints)', async function () {
    const seen3 = new Map();
    const loose3 = createRuntime({
      strictVoid: false,
      onComponent: function (name, props, key, fn) { if (!seen3.has(name)) seen3.set(name, { fn: fn, props: props }); },
    });
    const entry = function (id, fn, extra) {
      return Object.assign({ id: id, fn: fn, url: 'http://cpu2.test:' + (fn === 'tts' ? '8963' : '8962'), route: 'speech', host: 'cpu2.test', enabled: true, batch_allowed: true, paused: false, models: ['m1', 'm2'], models_source: 'engine', models_at: Date.now() }, extra || {});
    };
    const fetch3 = function (url) {
      const u = String(url);
      let body = { ok: true };
      if (/endpoint_registry/.test(u)) {
        const fn = /fn=stt/.test(u) ? 'stt' : 'tts';
        body = { ok: true, fn: fn, primary: { url: 'http://cpu1.test:8963', route: 'speech' }, endpoints: fn === 'stt' ? [entry('e-2', 'stt', { enabled: false, batch_allowed: false, paused: true })] : [entry('e-1', 'tts')] };
      } else if (/queue_status/.test(u)) {
        body = {
          ok: true,
          queues: { tts: { paused: false, running: null, queued: 1 }, stt: { paused: false, running: null, queued: 0 } },
          machines: { 'cpu2.test': { running: null, running_fns: [], queued: 2, shared_fns: ['tts', 'stt'], endpoints: [
            { id: 'e-1', url: 'http://cpu2.test:8963', route: 'speech', enabled: true, paused: false },
            { id: 'e-2', url: 'http://cpu2.test:8962', route: 'speech', enabled: false, paused: true },
          ] } },
        };
      }
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
    };
    const c3 = loadClient(loose3, { target: TARGET, fetch: fetch3 });
    const comp3 = c3.apply();
    if (!comp3) throw new Error('panel did not register in the registry runtime');
    await openAllSections(loose3, comp3);
    // One clean render, sliced: rt.created accumulates across the renders
    // openAllSections performs, so counting the whole history would count the same row
    // once per render.
    const mark3 = loose3.rt.created.length;
    loose3.render(comp3());
    const tree = loose3.rt.created.slice(mark3);
    const rows = tree.filter(function (e) { return e.props && e.props.className === 'audio-play-ep-row'; });
    if (rows.length !== 2) throw new Error('expected 2 registry endpoint rows, saw ' + rows.length);
    const lanes = tree.filter(function (e) { return e.type === 'select' && e.props && e.props.className === 'audio-play-lane'; });
    if (lanes.length !== 2) throw new Error('expected 2 lane selects, saw ' + lanes.length);
    // T-223 (user request 1): this runtime's queue_status ANSWERS `machines` (see fetch3
    // above), so the removed block has real host data to render and still renders NOTHING.
    // Re-anchored from "the pane renders nothing before any queue_status answer": the answer
    // is now deliberately present, and the absence is the contract.
    await loose3.flush();
    const mark3b = loose3.rt.created.length;
    loose3.render(comp3());
    const tree3b = loose3.rt.created.slice(mark3b);
    const mach = tree3b.filter(function (e) { return e.props && e.props.className === 'audio-play-machines'; });
    if (mach.length !== 0) throw new Error('machines pane rendered even though the block was removed');
    const machCls = ['audio-play-machine-row', 'audio-play-machine-share', 'audio-play-machine-cap',
      'audio-play-machine-ceiling', 'audio-play-machine-jobs', 'audio-play-machine-ids', 'audio-play-machine-host'];
    const leftover = loose3.rt.created.filter(function (e) {
      const c = (e.props && e.props.className) || '';
      return machCls.indexOf(c) >= 0;
    });
    if (leftover.length) throw new Error('machine classes survive in the tree: ' + leftover.map(function (e) { return e.props.className; }).join(', '));
    const epRows = tree3b.filter(function (e) { return e.props && e.props.className === 'audio-play-ep-row'; });
    if (epRows.length !== 2) throw new Error('removing the Machines block also removed endpoint rows: ' + epRows.length);
    // The row component itself, pushed through the shapes a half-answered host produces.
    if (!seen3.has('RegistryEndpointRow')) throw new Error('RegistryEndpointRow was never reached');
    for (const p of [
      { fn: 'tts', ep: null, index: 0, onAction: null },
      { fn: undefined, ep: undefined, index: undefined, onAction: undefined },
      { fn: 'stt', ep: { id: 'e-3', url: null, route: null, models: null, models_source: null, enabled: null, batch_allowed: null, paused: null }, index: 1 },
      { fn: 'tts', ep: { id: 'e-4', url: 'http://x:1', models: 'not-a-list', models_at: 'nope' }, index: 'x' },
    ]) {
      loose3.renderComponent(seen3.get('RegistryEndpointRow').fn, p, { fresh: true, effects: false });
    }
    const bad = voidViolations(loose3);
    if (bad.length) throw new Error(bad.length + ' void element(s) carry children, e.g. <' + bad[0].type + '> children=' + JSON.stringify(bad[0].props.children));
  });

  console.log('\n--- 7. T-199: the log section, the header, the four endpoint rows, and the wrap fix ---');
  function ownTxt(e) {
    let s = '';
    (function walk(list) {
      (list || []).forEach(function (k) {
        if (k == null) return;
        if (typeof k === 'string' || typeof k === 'number') { s += String(k); return; }
        if (Array.isArray(k)) { walk(k); return; }
        if (k.props) walk([].concat(k.props.children || []));
      });
    })([].concat((e && e.props && e.props.children) || []));
    return s;
  }
  // A class TOKEN, not the whole className: an alarming header chip is
  // "audio-play-head-out audio-play-alarm".
  const hasCls = function (e, c) { return !!(e && e.props && String(e.props.className || '').split(/\s+/).indexOf(c) >= 0); };
  const withCls = function (list, c) { return (list || []).filter(function (e) { return hasCls(e, c); }); };
  // T-300 CONTRACT CHANGE (user feedback 2026-10-12, 18:47): the header used to print FOUR things -
  // status_ idle, a TTS/STT light pair (audio-play-head-ep) and an OUT chip (audio-play-head-out) - and
  // an alarm was a CLASS on one of those chips. It prints ONE status readout now, and an alarm is that
  // readout's own colour (#f85149) plus a "! ..." clause in its text. statusReadout / statusAlarming /
  // statusText replace "withCls(..., 'audio-play-alarm')" wherever this suite asked "did the header
  // claim something is broken?", so those guards still guard the same thing.
  const statusReadout = function (list) { return withCls(list, 'audio-play-now').pop() || null; };
  const statusText = function (list) {
    const el = statusReadout(list);
    return el ? [].concat(el.props.children || []).join('') : '(no status readout rendered)';
  };
  const statusAlarming = function (list) {
    const el = statusReadout(list);
    if (!el) return false;
    const st = el.props.style || {};
    return st.color === '#f85149' || /! no endpoint|! output unwritable/.test(statusText(list));
  };
  function mountWith(fetchFn) {
    const seenX = new Map();
    const rx = createRuntime({ strictVoid: false, onComponent: function (name, props, key, fn) { if (!seenX.has(name)) seenX.set(name, { fn: fn, props: props }); } });
    const cx = loadClient(rx, { target: TARGET, fetch: fetchFn });
    const compX = cx.apply();
    if (!compX) throw new Error('panel did not register');
    return { run: rx, seen: seenX, comp: compX };
  }

  await attempt('T-300 U-15 CONTRACT CHANGE: the header carries the centred word and three window controls and nothing else — the "status:" label and the readout left it for the ticker line (was: title + "status:" + readout, both in the header). The Log section stays open (S-1: DEEPAMP) (T-223: rows dropdown offers all)', function () {
    const mark = shim.rt.created.length;
    shim.render(registeredComp());
    const tree = shim.rt.created.slice(mark);
    const title = withCls(tree, 'audio-play-title');
    const label = withCls(tree, 'audio-play-status-label');
    const now = withCls(tree, 'audio-play-now');
    // S-1 (2026-10-05): the visible title word is DEEPAMP. Re-anchored from the T-199 wording
    // ("AP"); the className, the group and the readout are the same assertions as before.
    if (title.length !== 1 || ownTxt(title[0]) !== 'DEEPAMP') throw new Error('title: ' + title.map(ownTxt).join('|'));
    // T-300 U-15 (user 2026-10-12, 19:23): "the header needs the DEEPAMP logo moved center, so the status and
    // error reporting should be done in the same text display as the current title". The label is GONE and the
    // readout is now the ticker line. It keeps the className `audio-play-now` on purpose: every older guard in
    // every suite reads the status sentence by that name, and a rename would blind them all. They now read it
    // from its new home instead.
    if (label.length !== 0) throw new Error('the "status:" label is still rendered: ' + label.map(ownTxt).join('|'));
    // T-913 CONTRACT CHANGE (2026-11-23, operator: "On the fresh install, there was no visualizer selected by
    // default, so it never showed - we should preselect the spectrum analyser for new users"). A browser that has
    // never chosen now HAS a visualizer, and this runtime's browser cannot tap the player output — so what the
    // ticker carries at mount is the panel-s own capability sentence about that, which is what it has always said
    // to a person who selected a mode on such a browser. The never-blank rule stands unchanged; only the word
    // differs, and it is a fact rather than a placeholder. The `idle` readout is still pinned, for a browser that
    // CAN tap: tests/scope.test.cjs, the T-913 block.
    if (now.length !== 1 || ownTxt(now[0]) !== 'this browser cannot tap the player output - the visualizer is unavailable here') throw new Error('readout at mount: ' + now.map(ownTxt).join('|'));
    // The centring is a construction, not a wish: two regions of IDENTICAL flex either side of a fixed-width
    // title. That is what centres the word in the BAR and not in whatever space the buttons leave behind.
    const pad = withCls(tree, 'audio-play-head-pad');
    const ctl = withCls(tree, 'audio-play-head-controls');
    if (pad.length !== 1 || !pad[0].props.style || pad[0].props.style.flex !== '1 1 0') throw new Error('the left half of the centred header is missing or is not flex 1 1 0');
    if (ownTxt(pad[0]) !== '') throw new Error('the left half carries text: ' + ownTxt(pad[0]));
    if (ctl.length !== 1 || !ctl[0].props.style || ctl[0].props.style.flex !== '1 1 0') throw new Error('the right half is not the matching flex 1 1 0 region');
    if (ctl[0].props.style.justifyContent !== 'flex-end') throw new Error('the window controls are not pushed to the right edge of their half');
    if (title[0].props.style.flex !== '0 0 auto') throw new Error('the title is not the fixed-width middle piece');
    if ([].concat(ctl[0].props.children || []).length !== 3) throw new Error('the header does not hold exactly three window controls: ' + [].concat(ctl[0].props.children || []).length);
    // The status line IS the ticker text: it lives inside the clipping box, on one unbroken line.
    const tick = withCls(tree, 'audio-play-ticker');
    if (tick.length !== 1) throw new Error('the ticker box is not rendered exactly once: ' + tick.length);
    if ([].concat(tick[0].props.children || []).indexOf(now[0]) < 0) throw new Error('the status readout is not the text inside the ticker box');
    if (tick[0].props.style.overflow !== 'hidden') throw new Error('the ticker box does not clip');
    if (now[0].props.style.whiteSpace !== 'nowrap') throw new Error('the ticker line is not a single unbroken line');
    if (withCls(tree, 'audio-play-log').length !== 1) throw new Error('the Log section is not rendered');
    const sel = tree.filter(function (e) { return e.type === 'select' && hasCls(e, 'audio-play-log-limit'); });
    // T-223 (user request 2): the dropdown gained "all". Re-anchored from the T-199 wording
    // ("5 / 10 / 20"); the select count, the default value and the 5-row default are the same
    // assertions as before.
    if (sel.length !== 1 || ownTxt(sel[0]).replace(/\s/g, '') !== '51020all') throw new Error('log row control: ' + sel.map(ownTxt).join('|'));
    if (withCls(tree, 'audio-play-log-row').length > 5) throw new Error('more than the default 5 rows listed at mount');
    if (withCls(tree, 'audio-play-head-id').length !== 1) throw new Error('the title group is missing');
  });

  await attempt('T-300 U-14 + U-17 + T-305 + T-307: the player block is THREE stacked rows - the display '
    + 'block (the canvas with its dot-matrix clock painted INSIDE it) beside the info column that carries the '
    + 'read-outs AND the volume slider with the two lane buttons at its bottom, where Winamp has its volume and '
    + 'its EQ / PL buttons - then the full-width progress bar, then the transport row', function () {
    const mark = shim.rt.created.length;
    shim.render(registeredComp());
    const tree = shim.rt.created.slice(mark);
    // The user's own words (2026-10-12, 19:15): "the 'track progress bar' being placed as an element taking in
    // the full width in a single row above the play buttons, and the volume slider is the small slider above
    // that. our SST and TTS 'status LEDs' should be placed where winamp has the EQ and PL LED- lights".
    // T-305 (2026-10-13, 03:17) put the lamps INTO that caption line as buttons, and put the clock inside the
    // canvas. The row the user's second screenshot showed as one display block is what this pins now.
    const deepTxt = function (e) {
      if (!e) return '';
      if (typeof e === 'string' || typeof e === 'number') return String(e);
      return [].concat((e.props && e.props.children) || []).map(deepTxt).join('');
    };
    if (withCls(tree, 'audio-play-player').length !== 1) throw new Error('the player block is not one block');
    // T-305: the info row is GONE and so is the DOM clock. Either surviving is the exact thing the user asked
    // to see removed from the strip.
    if (withCls(tree, 'audio-play-info-row').length !== 0) throw new Error('the info row survived T-305');
    if (withCls(tree, 'audio-play-clock').length !== 0) throw new Error('a DOM clock survived T-305 - the clock is painted inside the canvas now');
    if (withCls(tree, 'audio-play-scope-chan').length !== 0) throw new Error('the old single-word channel read-out survived T-305');
    if (withCls(tree, 'audio-play-scope-note').length !== 0) throw new Error('a second caption line survived T-305 - the panel has one status display');
    const rowCls = ['audio-play-scope-row', 'audio-play-seek-row', 'audio-play-transport'];
    const rows = rowCls.map(function (c) {
      for (let i = 0; i < tree.length; i++) if (hasCls(tree[i], c)) return i;
      return -1;
    });
    if (rows.some(function (i) { return i < 0; }))
      throw new Error('a row is missing from the player block: ' + rowCls.map(function (c, i) { return c + '=' + rows[i]; }).join(' '));
    if (!rows.every(function (i, k) { return k === 0 || i > rows[k - 1]; }))
      throw new Error('the rows are not in the chosen order scope|seek|transport: ' + rows.join(' '));
    const rowKids = [].concat(withCls(tree, 'audio-play-scope-row')[0].props.children || []);
    if (!(rowKids.some(function (k) { return k && hasCls(k, 'audio-play-scope'); })
       && rowKids.some(function (k) { return k && hasCls(k, 'audio-play-lane-col'); })))
      throw new Error('the visualizer and the info column are not siblings in one row');
    // U-18 (user 2026-10-13 01:39): "the volume slider is still in upper right corner in my view - should be
    // above progress bar and between visualizer area and 'status/LEDs'". T-305 put the lamps behind the volume
    // on the caption line UNDER the canvas. T-307 (user 2026-10-13, 05:15): "our volume slider and TTS / STT
    // LED/Buttons are still below the vis-canvas -> should be on the right side of it" - the whole control
    // line moved into the column at the canvas's right edge, which is where the reference puts its volume
    // beside its EQ / PL buttons. The mode word left the DOM in the same wave.
    if (withCls(tree, 'audio-play-scope-meta').length !== 0) throw new Error('the caption line under the canvas survived T-307');
    if (withCls(tree, 'audio-play-scope-mode').length !== 0) throw new Error('a mode caption is still printed - T-307 removed it');
    const meta = withCls(tree, 'audio-play-lane-controls');
    if (meta.length !== 1) throw new Error('the control line in the info column is not exactly one element: ' + meta.length);
    const metaKids = [].concat(meta[0].props.children || []).filter(function (k) { return k; });
    const idxOf = function (cls) {
      for (let i = 0; i < metaKids.length; i++) if (hasCls(metaKids[i], cls)) return i;
      return -1;
    };
    const ivol = idxOf('audio-play-vol');
    // T-386 (user 2026-10-14): "those should move up and make room for the new 2 buttons". The two lane chips left
    // this line and the two buttons the reference keeps in exactly this slot — EQ and PL — took their place. So the
    // control line is now the volume slider, then EQ, then PL, and NO lamp on it. The lamps are measured where they
    // moved to, in the block below, and the old "no lamp on the control line" rule is not dropped: it is now the
    // other way round, because a lamp that stayed here would mean the swap the user asked for did not happen.
    const lampIx = [];
    metaKids.forEach(function (k, i) { if (k && hasCls(k, 'audio-play-lane-led')) lampIx.push(i); });
    if (ivol < 0) throw new Error('the volume slider is not on the control line');
    if (metaKids.filter(function (k) { return hasCls(k, 'audio-play-vol'); }).length !== 1)
      throw new Error('there is more than one volume slider on the control line');
    if (lampIx.length !== 0) throw new Error('a lane lamp is still on the control line after T-386: ' + lampIx.join(','));
    const eqIx = idxOf('audio-play-tp-eq386');
    const plIx = idxOf('audio-play-tp-pl386');
    if (eqIx < 0 || plIx < 0) throw new Error('the EQ / PL buttons are not on the control line');
    if (eqIx < ivol || plIx < ivol)
      throw new Error('a new button sits in FRONT of the volume - the reference puts its buttons after the slider');
    if (metaKids.filter(function (k) { return hasCls(k, 'audio-play-tp-eq386') || hasCls(k, 'audio-play-tp-pl386'); }).length !== 2)
      throw new Error('there is not exactly one EQ button and one PL button on the control line');
    const volEl = metaKids[ivol];
    if (!volEl.props || typeof volEl.props.onInput !== 'function' || volEl.props.type !== 'range')
      throw new Error('the element on the caption line is not the volume slider: ' + JSON.stringify(volEl.props && volEl.props.type));
    const scopeCol = withCls(tree, 'audio-play-scope')[0];
    const colKidsU18 = [].concat(scopeCol.props.children || []).filter(function (k) { return k; });
    // T-307: the display column is the canvas and nothing else. Nothing may sit under it again - that is the
    // arrangement the user rejected twice.
    if (colKidsU18.some(function (k) { return hasCls(k, 'audio-play-scope-meta') || hasCls(k, 'audio-play-lane-controls'); }))
      throw new Error('a control line is still under the canvas');
    const led = withCls(tree, 'audio-play-lane-led');
    if (led.length !== 2) throw new Error('there are not exactly two lane lamps: ' + led.length);
    // T-386 (user 2026-10-14): where the lamps went. They ride the engine / voice read-out line now, in lane order,
    // AFTER the read-out text — because the read-out is the thing that has to give way when the line runs short, not
    // the control a person is meant to press.
    const line386 = withCls(tree, 'audio-play-lane-line386');
    if (line386.length !== 1) throw new Error('there is not exactly one line for the lamps to ride: ' + line386.length);
    const lineKids386 = [].concat(line386[0].props.children || []).filter(function (k) { return k; });
    if (lineKids386.length !== 3) throw new Error('the read-out line does not carry the read-out and two lamps: ' + lineKids386.length);
    if (!hasCls(lineKids386[0], 'audio-play-lane-read')) throw new Error('the read-out is not first on its own line');
    if (!hasCls(lineKids386[1], 'audio-play-lane-led') || !hasCls(lineKids386[2], 'audio-play-lane-led'))
      throw new Error('the two lamps are not on the read-out line in lane order');
    const labels = led.map(function (e) {
      return [].concat(e.props.children || []).filter(function (c) { return typeof c === 'string'; }).join('');
    });
    if (labels.join('|') !== 'TTS|STT') throw new Error('the lamps are not labelled TTS and STT: ' + labels.join('|'));
    // T-387 item 2 (user 2026-10-14): the dot INSIDE the two shortcut buttons, and what it is for. It is a state lamp,
    // so the check has to be about STATE and not about the presence of a dot — a dot that never changed colour would
    // pass a "is there a dot" check and would be exactly the decoration the user did not ask for. In this fixture the
    // section defaults are the panel's own (Playlist open, Voices closed), so the PL lamp must be lit and the EQ lamp
    // dark, and each lamp must be the first thing inside its button so the rim, not the caption, is what changes.
    const lamp388s = withCls(tree, 'audio-play-tp-lamp388');
    if (lamp388s.length !== 2) throw new Error('the two shortcut buttons do not carry one lamp each: ' + lamp388s.length);
    const kidsOfBtn = function (cls) {
      const b = withCls(tree, cls)[0];
      return [].concat((b && b.props && b.props.children) || []).filter(function (k) { return k; });
    };
    const eqKids388 = kidsOfBtn('audio-play-tp-eq386');
    const plKids388 = kidsOfBtn('audio-play-tp-pl386');
    if (eqKids388.length !== 2 || plKids388.length !== 2)
      throw new Error('a shortcut button is not lamp + label: ' + eqKids388.length + ' / ' + plKids388.length);
    if (!hasCls(eqKids388[0], 'audio-play-tp-lamp388') || !hasCls(plKids388[0], 'audio-play-tp-lamp388'))
      throw new Error('the lamp is not the first thing inside the button');
    const txtOf = function (e) {
      return [].concat((e && e.props && e.props.children) || []).map(function (c) {
        if (typeof c === 'string') return c;
        if (c && typeof c.props === 'object' && typeof c.props.children === 'string') return c.props.children;
        return '';
      }).join('');
    };
    // The same rule the button itself uses on the live page: a section is open when its body is in the tree. Read
    // from the tree rather than assumed from a fixture, because the fixture's own section state has already been
    // proved different from the live page's once today.
    const openStateOf388 = function (labelText) {
      const nodes = tree.filter(function (e) {
        return [].concat((e.props || {}).children || []).some(function (k) {
          if (!k || !hasCls(k, 'audio-play-section-head')) return false;
          const at = txtOf(k).trim().indexOf(labelText);
          return at >= 0 && at <= 3;
        });
      });
      if (!nodes.length) return null;
      return [].concat((nodes[0].props || {}).children || []).some(function (k) { return k && hasCls(k, 'audio-play-section-body'); });
    };
    const voOpen388 = openStateOf388('Voices');
    const plOpen388 = openStateOf388('Playlist');
    if (voOpen388 === null || plOpen388 === null) throw new Error('a section the shortcut buttons act on is not in the tree');
    const lit388 = function (kid) { return String(kid.props.style.background) === '#3fb950'; };
    if (lit388(eqKids388[0]) !== !!voOpen388)
      throw new Error('the EQ lamp does not match the Voices section: lamp ' + String(eqKids388[0].props.style.background) + ' section open ' + voOpen388);
    if (lit388(plKids388[0]) !== !!plOpen388)
      throw new Error('the PL lamp does not match the Playlist section: lamp ' + String(plKids388[0].props.style.background) + ' section open ' + plOpen388);
    const litKid388 = lit388(eqKids388[0]) ? eqKids388[0] : plKids388[0];
    const darkKid388 = lit388(eqKids388[0]) ? plKids388[0] : eqKids388[0];
    [eqKids388[0], plKids388[0]].forEach(function (kid) {
      const lit = String(kid.props.style.background) === '#3fb950';
      const dark = String(kid.props.style.background) === '#3a3f46';
      if (!lit && !dark) throw new Error('a state lamp is drawn outside the lit / dark pair: ' + String(kid.props.style.background));
      if (lit && (!/56d364/.test(String(kid.props.style.border)) || !/rgba\(63, 185, 80/.test(String(kid.props.style.boxShadow))))
        throw new Error('a lit state lamp has no rim or no glow');
      if (dark && (!/4d5157/.test(String(kid.props.style.border)) || String(kid.props.style.boxShadow) !== 'none'))
        throw new Error('a dark state lamp carries a lit rim or glows anyway');
    });
    // The fixture's own section states are read from the tree rather than assumed, and this suite does not require a
    // closed section to exist: what it requires is that each lamp equals the section its own button acts on. The guard
    // against a lamp that is simply always lit lives in ui_state, which can pin the source: the lamp is drawn from
    // sectionOpen with the section's own default, and no call hands it a constant.
    // T-387 item 3 (user 2026-10-14): "the generate button in 'text' section should be green, too, same as transcribe
    // button". Live measurement first (see the code comment at runButton371) showed both lane buttons already share
    // one colour rule and both were grey only because both were disabled. What is checked here is the user's own word:
    // SAME. Two lane buttons in the same state must carry the same colour, and in the disabled state that colour must
    // be the dim green, not the generic grey every other button in the panel uses.
    const gen387 = withCls(tree, 'audio-play-generate371')[0];
    const trn387 = withCls(tree, 'audio-play-transcribe371')[0];
    if (!gen387 || !trn387) throw new Error('a lane run button is missing from the tree');
    if (gen387.props.disabled === trn387.props.disabled) {
      if (String(gen387.props.style.background) !== String(trn387.props.style.background))
        throw new Error('two lane buttons in the same state paint differently: ' + String(gen387.props.style.background) + ' vs ' + String(trn387.props.style.background));
    }
    if (gen387.props.disabled === true && String(gen387.props.style.background) !== '#0f2f1c')
      throw new Error('a disabled lane button is not dim-green: ' + String(gen387.props.style.background));
    if (gen387.props.disabled === true && String(gen387.props.style.background) === '#22222a')
      throw new Error('a disabled lane button still wears the generic button grey — the lane family is not readable as a family');
    // T-386 (user 2026-10-14, 21:3x): "the TTS and STT items should stay, only remove the 'dotsymbol' inside the
    // rectangle so those are a bit smaller" - the 8px circle went. T-460 (user 2026-10-15, verbatim): "remove/hide
    // the squares around our SST and TTS 'LEDs' in the 3rd row on the right side, currently those misalign with the
    // EQ and PL buttons so it doesn't look nice, ... keep the 'button function with the current working
    // functionality'" - the RECTANGLE went too, and the side padding came in so the two labels read as part of the
    // line they sit in. What this check still guards is the STATE (the label's colour IS the state colour, plus the
    // state class on the element) and the line box the lamp shares with its neighbours. A lamp that lost its box
    // AND its colour, or that stopped being a button, is the failure this block exists to catch - the button-ness
    // is asserted below it.
    led.forEach(function (e) {
      const kids = [].concat(e.props.children || []).filter(function (k) { return k && k.type === 'span'; });
      if (kids.length !== 0) throw new Error('a lamp still carries a child element: ' + kids.length);
      const cs = e.props.style;
      if (cs.lineHeight !== '14px') throw new Error('the lamp lost the line box it shares with the controls beside it: ' + cs.lineHeight);
      if (String(cs.border) !== 'none' || String(cs.background) !== 'transparent' || cs.borderRadius !== '0')
        throw new Error('the square is still drawn around the lamp: ' + [cs.border, cs.background, cs.borderRadius].join(' / '));
      if (!cs.color) throw new Error('the lamp lost the state colour on its own label: ' + JSON.stringify(cs.color));
      if (String(cs.padding) !== '1px 2px') throw new Error('the lamp is not on the T-460 padding that lines it up: ' + cs.padding);
    });
    if (tree.filter(function (e) { return hasCls(e, 'audio-play-lane-dot'); }).length !== 0)
      throw new Error('a lamp dot survived the change');
    // T-305 (user 2026-10-13, 03:17): "maybe with function: on klick-> expand window + model selection". A lamp
    // is a BUTTON now, and a span with an onClick would be the version that looks like a lamp and does nothing.
    led.forEach(function (e) {
      if (e.type !== 'button') throw new Error('a lane lamp is not a button: ' + e.type);
      if (typeof e.props.onClick !== 'function') throw new Error('a lane lamp has no click behaviour: ' + e.type);
    });
    // The column at the canvas\u2019s right edge is the Winamp info block and the panel\u2019s ONE status display:
    // the status line, the rate read-out, the mono / stereo pair, and what the next dispatch would use.
    const colKids = [].concat(withCls(tree, 'audio-play-lane-col')[0].props.children || []).filter(function (k) { return k; });
    // The lamps belong to the control line, not to the stack of read-out lines: a lamp as its own line is the
    // "LED above each other" arrangement the user rejected in T-305.
    if (colKids.some(function (k) { return hasCls(k, 'audio-play-lane-led'); }))
      throw new Error('a lamp is stacked as its own line in the info column instead of riding the control line');
    // T-318 (user 2026-10-13): "in player the '-- kbps -- kHz' and 'mono stereo' should only use one line".
    // The rate read-out and the channel pair are now ONE line of the info column, carried by one row element
    // (.audio-play-inforow318) that holds both spans with their own classes. The column is therefore four lines
    // here, not five, and the checks below reach the two read-outs THROUGH that row.
    // T-386 (user 2026-10-14): the third line of the column is now the ROW that carries the engine / voice read-out
    // and the two lane chips, not the read-out text on its own. The read-out is still one line and still measured —
    // through this row, exactly the way T-318 reaches the rate read-outs through .audio-play-inforow318 above. The
    // column is still four lines in this order, and the controls are still its last line.
    const colCls = ['audio-play-ticker', 'audio-play-inforow318', 'audio-play-lane-line386', 'audio-play-lane-controls'];
    const colIx = colCls.map(function (c) {
      const hits = colKids.filter(function (k) { return hasCls(k, c); });
      if (hits.length !== 1) return -1;
      return colKids.indexOf(hits[0]);
    });
    if (colIx.some(function (i) { return i < 0; }))
      throw new Error('the info column is missing a line: ' + colCls.map(function (c, i) { return c + '=' + colIx[i]; }).join(' '));
    if (!colIx.every(function (i, k) { return k === 0 || i > colIx[k - 1]; }))
      throw new Error('the info column lines are not in the order status|rate+channels|selection|controls: ' + colIx.join(' '));
    if (colIx[colCls.length - 1] !== colKids.length - 1)
      throw new Error('the volume and the lane buttons are not at the BOTTOM of the info column, where the reference has them: ' + colIx.join(' '));
    const tick = colKids[colIx[0]];
    const nowEl = [].concat(tick.props.children || [])[0];
    if (!nowEl || !hasCls(nowEl, 'audio-play-now')) throw new Error('the status line is not the text inside the ticker box');
    if (!deepTxt(nowEl).trim()) throw new Error('the panel\u2019s one status display is blank: ' + JSON.stringify(deepTxt(nowEl)));
    // T-308 (user 2026-10-13): "if it scrolls it should scroll around and start from the beginning before the
    // end is done with the scroll (it should go around)". Going around needs the line painted TWICE, so the
    // ticker box now carries TWO children: the panel's own read-out - still FIRST, still the only element a
    // read-out reads - and the echo that follows its own head. The echo is paint only: aria-hidden, no pointer
    // events, absolutely positioned, no hover of its own, and the very same words.
    const tickKids308 = [].concat(tick.props.children || []).filter(function (k) { return k; });
    if (tickKids308.length !== 2 || tickKids308[0] !== nowEl)
      throw new Error('the marquee is not the read-out followed by its echo: ' + tickKids308.length);
    const echo308 = tickKids308[1];
    if (String(echo308.props.className) !== 'audio-play-now-echo308')
      throw new Error('the second copy in the ticker box is not the echo: ' + echo308.props.className);
    if (echo308.props['aria-hidden'] !== 'true' || echo308.props.style.pointerEvents !== 'none' || echo308.props.style.position !== 'absolute')
      throw new Error('the echo is a live second read-out rather than paint: ' + JSON.stringify(echo308.props.style));
    if (deepTxt(echo308) !== deepTxt(nowEl))
      throw new Error('the echo does not carry the words of the line it is following: ' + JSON.stringify([deepTxt(nowEl), deepTxt(echo308)]));
    if (echo308.props.title) throw new Error('the echo carries its own hover, which would put two tooltips on one line');
    // T-341 (user 2026-10-13 22:4x): "the sliding title in player is altering in vertical position - the status
    // part seems one or two pixel too low". ROOT CAUSE in this tree: the read-out was an inline-block aligned by
    // BASELINE inside a 16px clip, while the echo is absolutely positioned at top:0, so the two halves of the
    // same scrolling line were painted 1-2 px apart and the status text stepped up and down as it went round.
    // The contract is now ONE height for all three pieces: the box states the line height it clips, the
    // read-out aligns to the TOP of that line box, and the echo keeps the same line height pinned at top:0.
    if (tick.props.style.height !== tick.props.style.lineHeight)
      throw new Error('the ticker clip does not state the line height it clips: ' + JSON.stringify([tick.props.style.height, tick.props.style.lineHeight]));
    if (nowEl.props.style.verticalAlign !== 'top')
      throw new Error('the status read-out is baseline-aligned inside the clip, which is what put it 1-2 px low: ' + nowEl.props.style.verticalAlign);
    if (nowEl.props.style.lineHeight !== tick.props.style.lineHeight || nowEl.props.style.lineHeight !== echo308.props.style.lineHeight)
      throw new Error('the two halves of the marquee are painted at different heights: ' + JSON.stringify([tick.props.style.lineHeight, nowEl.props.style.lineHeight, echo308.props.style.lineHeight]));
    if (echo308.props.style.top !== 0)
      throw new Error('the echo is no longer pinned to the top edge of the clip it shares with the read-out: ' + echo308.props.style.top);
    // The rate read-out prints dashes until the lane answers, which is the honest version of a number the
    // panel cannot measure by itself. T-318 re-pinned the SPACING, in the user's own words: "remove space
    // between number and 'kHz' and number and 'kbps' - then it should fit", so the unit sits ON its number.
    const infoRow318 = colKids[colIx[1]];
    if (infoRow318.props.style.flexWrap !== 'nowrap')
      throw new Error('the rate + channels line is allowed to wrap onto a second line: ' + JSON.stringify(infoRow318.props.style));
    const infoKids318 = [].concat(infoRow318.props.children || []).filter(function (k) { return k; });
    const rateEl = infoKids318.filter(function (k) { return hasCls(k, 'audio-play-bitrate'); })[0];
    const chanEl = infoKids318.filter(function (k) { return hasCls(k, 'audio-play-chan'); })[0];
    if (!rateEl || !chanEl)
      throw new Error('the rate read-out and the channel pair are not both carried by the one info line: ' + infoKids318.map(function (k) { return String(k.props.className || k.type); }).join(' '));
    if (infoKids318.indexOf(chanEl) !== infoKids318.indexOf(rateEl) + 1)
      throw new Error('the channel pair is not the line-mate of the rate read-out: ' + infoKids318.map(function (k) { return String(k.props.className); }).join(' '));
    const rateTxt = deepTxt(rateEl);
    if (!/kbps/.test(rateTxt) || !/kHz/.test(rateTxt)) throw new Error('the rate read-out does not name both units: ' + rateTxt);
    // T-396 (user 2026-10-15): "re-add spaces again between number and unit for 'XXX kbps' and ' YY kHz' in player
    // window". T-318 removed them to make the pair fit; the pair is still one line, the units are spaced again.
    if (!/^-- kbps  -- kHz$/.test(rateTxt)) throw new Error('the rate read-out either claims a number the lane never gave, or the units are not sitting spaced off their numbers (T-396 re-added the spaces T-318 took out): ' + rateTxt);
    // mono / stereo is printed as a PAIR, both words present, the true one lit - an unknown count leaves both
    // dark rather than claiming mono because a second channel was not seen.
    const chanTxt = deepTxt(chanEl);
    if (!/mono/.test(chanTxt) || !/stereo/.test(chanTxt)) throw new Error('the channel pair does not print both words: ' + JSON.stringify(chanTxt));
    const chanKids = [].concat(chanEl.props.children || []).filter(function (k) { return k && k.props && k.props.className; });
    if (chanKids.length !== 2) throw new Error('the channel pair is not two spans: ' + chanKids.length);
    chanKids.forEach(function (k) {
      if (k.props.style.color !== '#555') throw new Error('a channel that was not reported is lit anyway: ' + k.props.className + ' ' + k.props.style.color);
    });
    const laneRead = withCls(tree, 'audio-play-lane-read');
    if (laneRead.length !== 1) throw new Error('the lane column read-out is not exactly one element: ' + laneRead.length);
    // selModel and selVoice are SLOT objects (selModel.tts, selVoice.tts), not names. Reading the object is how
    // a read-out ends up printing "[object Object] - a string that looks like a name the lane knows.
    const lrTxt = ownTxt(laneRead[0]);
    if (/object Object/.test(lrTxt)) throw new Error('the lane read-out stringified a slot object: ' + lrTxt);
    // The honest contract: the line is either a name the panel would actually dispatch with, or the words that
    // say nothing is selected. It is never blank, and it never stringifies a slot object.
    if (!lrTxt || !lrTxt.trim()) throw new Error('the lane read-out is blank: ' + JSON.stringify(lrTxt));
    if (lrTxt.split('\u00B7').length !== 2) throw new Error('the lane read-out is not model and voice: ' + lrTxt);
    lrTxt.split('\u00B7').forEach(function (part) {
      const t = String(part).trim();
      if (!t) throw new Error('one half of the lane read-out is empty: ' + lrTxt);
      if (!/^[A-Za-z0-9_.:\/-]+$/.test(t) && !/no (model|voice) selected/.test(t))
        throw new Error('the lane read-out half is neither a name nor the honest words: ' + t);
    });
    const canvasAll = tree.filter(function (e) { return e.type === 'canvas'; });
    if (canvasAll.length > 1) throw new Error('more than one visualizer canvas is mounted: ' + canvasAll.length);
    // At mount the host has reported nothing, so BOTH lamps are grey UNKNOWN. Red is reserved for a fact the
    // host actually gave, and a lamp that guesses red is how a panel makes a user chase a fault that is not there.
    led.forEach(function (e) {
      if (!/audio-play-lane-unknown/.test(String(e.props.className || ''))) throw new Error('a lamp with no host answer is not marked unknown: ' + e.props.className);
      if (e.props.style.color !== '#888') throw new Error('an unknown lane is not grey: ' + e.props.style.color);
      if (e.props.style.opacity !== 1) throw new Error('an unknown lane blinks: ' + e.props.style.opacity);
      if (!/UNKNOWN, not broken/.test(String(e.props.title || ''))) throw new Error('the unknown lamp does not say so in its hover');
    });
    // The progress bar takes the full width of the block, and it is disabled while nothing is loaded.
    const seek = withCls(tree, 'audio-play-seek')[0];
    if (seek.props.style.flex !== '1 1 auto' || seek.props.style.width !== '100%') throw new Error('the progress bar does not take the full width of its row');
    if (seek.props.disabled !== true) throw new Error('the progress bar pretends to seek while nothing is loaded');
    const btns = [].concat(withCls(tree, 'audio-play-transport')[0].props.children || []);
    // T-331 (user 2026-10-13): "in addition, on the right side of the rec button, we should add a dropdown
    // menu that displays or changes the currently selected voice from the voices available for the selected
    // engine". The seven-glyph assertion below is the user's own Winamp order and it is kept exactly as it
    // was; what changed is that the row now ENDS with the voice pick, so the glyph list is read off the
    // buttons and the new control is asserted as itself, in its place, rather than being allowed to slip in
    // anywhere.
    const pick331 = btns.filter(function (b) { return b && b.type === 'select'; });
    // T-316 MIGRATION (user ruling 2026-10-14): the six transport controls are DRAWN as inline SVG, so their
    // identity is the class they carry, not a character the browser happens to have a font for. The ORDER
    // pinned here is the user's own Winamp order and it is unchanged.
    const tpWord316 = function (b) {
      const c = String((b && b.props && b.props.className) || '').split(/\s+/);
      const hit = ['prev', 'play', 'pause', 'stop', 'next', 'eject'].filter(function (w) { return c.indexOf('audio-play-tp-' + w) >= 0; });
      return hit.length ? hit[0] : String((b && b.props && b.props.children) || '');
    };
    const glyphs = btns.filter(function (b) { return b && b.type === 'button'; }).map(tpWord316);
    // T-300 U-16 (user 2026-10-12, 19:31): "stop and next button order should be inverted to match winamp
    // order" - Winamp 2 classic is prev, play, pause, STOP, next.
    // T-387 (user 2026-10-14): "it should be in the player, behind the REC button, and should be labeled read" — the
    // read control is the row's last control, and the voice dropdown that used to sit at the right end of the row is
    // gone by the same message. The Winamp cluster in front of it is unchanged.
    // T-508 RE-POINT (2026-10-17): the row's order now ENDS with the info button. This pin did not move when T-508
    // was built, because the `i` was not actually inside the row then — the read button's closing line carried one
    // parenthesis too many and closed the transport span there, which is the bug the user reported with a screenshot
    // ("the info button is too low"). Putting the button where the request put it gives: the Winamp cluster, then
    // Mic, then read behind it, then the info button at the right edge of the row.
    if (glyphs.join(' ') !== 'prev play pause stop next eject \u25CF Mic \u266A read i') throw new Error('the bottom row is not prev play pause stop next eject Mic read info: ' + glyphs.join(' '));
    // T-316: all six are drawn. An svg child with a filled path, and no character anywhere in the cluster.
    // T-387: the read control is a LABELLED control in the row, the way the record button is (record carries no
    // audio-play-tp- class at all), so it is not part of the drawn-glyph family — excluded here by name, which keeps
    // the rule instead of loosening it.
    // T-508 RE-POINT (2026-10-17): the exclusion gains the info button for the SAME reason it already carries the
    // read control. The `i` is a labelled control typed as a character (Winamp's own marquee-letter style), not one
    // of the six glyphs drawn from the shared 16x16 grid, so it is named out of the family instead of the family
    // being loosened: the drawn set is still exactly six, each with an svg child on the shared grid.
    const drawn316 = btns.filter(function (b) { return b && b.type === 'button' && /audio-play-tp-/.test(String((b.props || {}).className || '')) && !/read387/.test(String((b.props || {}).className || '')) && !/info508/.test(String((b.props || {}).className || '')); });
    if (drawn316.length !== 6) throw new Error('the transport row carries ' + drawn316.length + ' drawn transport buttons; expected 6');
    if (!drawn316.every(function (b) { return !!(b.props.children && b.props.children.type === 'svg'); }))
      throw new Error('a transport button is still typed as a character instead of drawn as an svg');
    if (!drawn316.every(function (b) { return b.props.children.props && b.props.children.props.viewBox === '0 0 16 16'; }))
      throw new Error('a drawn glyph is not on the shared 16x16 grid the six were designed on');
    // T-387 (user 2026-10-14): the voice dropdown T-331 put at the right end of this row is GONE — "the drop down for
    // voice selection in the player might be dropped for now" — and the read control sits behind the record button in
    // the room it made. The assertion changes shape but not its strength: NO select may appear in the row, and the row
    // must end with the read control. What the dropdown used to say out loud is not lost — the read-out line above
    // names the model and voice the next dispatch will use, and the Voices section and the model library still set
    // that selection through the same path.
    if (pick331.length !== 0) throw new Error('a voice dropdown is still in the transport row after T-387: ' + pick331.length);
    if (btns.some(function (b) { return b && b.type === 'select'; }))
      throw new Error('the transport row still carries a select of any kind: ' + btns.filter(function (b) { return b && b.type === 'select'; }).length);
    const read387b = btns.filter(function (b) { return b && /audio-play-tp-read387/.test(String((b.props || {}).className || '')); });
    if (read387b.length !== 1) throw new Error('the row does not carry exactly one read control: ' + read387b.length);
    const rowOrder387 = btns.map(tpWord316);
    // T-508 RE-POINT (2026-10-17): "behind the REC button" still holds exactly — Mic, then read, one after the other
    // — and the info button sits after both, at the row's right edge, which is the request's own words ("same
    // distance to right border (fixed to right side)"). The rule is checked by index instead of by the last two
    // slots because a control was ADDED after the read control, not because the rule changed.
    const micIx387 = rowOrder387.indexOf('\u25CF Mic');
    const readIx387 = rowOrder387.indexOf('\u266A read');
    if (micIx387 < 0 || readIx387 !== micIx387 + 1)
      throw new Error('the read control is not on the right side of the record button: ' + rowOrder387.join(' '));
    if (rowOrder387[rowOrder387.length - 1] !== 'i')
      throw new Error('the info button is not the last control of the transport row: ' + rowOrder387.join(' '));
    if (String(read387b[0].props.children) !== '\u266A read') throw new Error('the read control is not labelled read: ' + String(read387b[0].props.children));
    if (typeof read387b[0].props.onClick !== 'function') throw new Error('the read control has no click behaviour');
  });

  await attempt('S-1 + T-718: the shell overlay is registered under id "deepamp" with the label DEEPAMP', function () {
    // The label is what the shell SHOWS; the id is what this panel is mounted under. S-1 (2026-10-05)
    // pinned them apart because the id was claimed to be what the API paths were built from — that
    // claim was measured false on 2026-11-03: the prefix and the id are separate literals in separate
    // files, and T-718 moved both in one step for exactly that reason. What is pinned here is the
    // behaviour: the id says the package's word, the label still says DEEPAMP, the order is unchanged.
    const d = client.desc || {};
    if (d.name !== 'shell.overlay') throw new Error('overlay name: ' + JSON.stringify(d.name));
    if (d.id !== 'deepamp') throw new Error('overlay id changed: ' + JSON.stringify(d.id));
    if (d.label !== 'DEEPAMP') throw new Error('overlay label: ' + JSON.stringify(d.label));
    if (d.order !== 100) throw new Error('overlay order: ' + JSON.stringify(d.order));
    // And the panel's own DOM still hangs on the same class vocabulary.
    const mark = shim.rt.created.length;
    shim.render(registeredComp());
    const tree = shim.rt.created.slice(mark);
    if (withCls(tree, 'audio-play-panel').length !== 1) throw new Error('audio-play-panel is gone from the tree');
    if (!tree.some(function (e) { return hasCls(e, 'audio-play-title'); })) throw new Error('audio-play-title is gone from the tree');
  });

  await attempt('T-199: the removed Pipelines section is gone and the Log section replaced it in the panel', function () {
    const all = shim.rt.created.filter(function (e) {
      return e.type === 'div' && typeof e.props.onClick === 'function' && ownTxt(e).indexOf('Pipelines (all engines)') === 0;
    });
    if (all.length) throw new Error('the Pipelines collapsible is still rendered');
    // T-300 U-8a CONTRACT CHANGE (user request 2026-10-12): the section is now named for what it
    // holds. U-8b then added the lane's own records under their own label, so the title names BOTH
    // sources. The assertion is the same shape each time; only the title moved.
    const heads = shim.rt.created.filter(function (e) {
      return e.type === 'div' && typeof e.props.onClick === 'function' && ownTxt(e).indexOf('Logs') === 0;
    });
    if (!heads.length) throw new Error('the Log collapsible header is missing');
  });

  await attempt('T-199: a PRE-T-198 host (primary is {url,route}) gets NO invented controls, and its lights read "unknown"', async function () {
    const regEntry = function (id, fn, extra) {
      return Object.assign({ id: id, fn: fn, url: 'http://cpu2.test:' + (fn === 'tts' ? '8963' : '8962'), route: 'speech', host: 'cpu2.test', enabled: true, batch_allowed: true, paused: false, models: ['m1', 'm2'], models_source: 'engine', models_at: 1727000000000 }, extra || {});
    };
    const oldHost = function (url) {
      const u = String(url);
      let body = { ok: true };
      if (/endpoint_registry/.test(u)) {
        const fn = /fn=stt/.test(u) ? 'stt' : 'tts';
        body = { ok: true, fn: fn, primary: { url: 'http://cpu1.test:' + (fn === 'stt' ? '8962' : '8963'), route: 'speech' }, endpoints: fn === 'stt' ? [regEntry('e-2', 'stt')] : [regEntry('e-1', 'tts')] };
      }
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
    };
    const m = mountWith(oldHost);
    await openAllSections(m.run, m.comp);
    const mark2 = m.run.rt.created.length;
    m.run.render(m.comp());
    const tree = m.run.rt.created.slice(mark2);
    const lights = withCls(tree, 'audio-play-ep-online');
    if (lights.length !== 4) throw new Error('expected an online light on all 4 endpoint rows, saw ' + lights.length);
    if (lights.map(ownTxt).join('|') !== 'unknown|unknown|unknown|unknown') throw new Error('lights: ' + lights.map(ownTxt).join('|'));
    if (lights.some(function (e) { return e.props.style.color !== '#d29922'; })) throw new Error('an unprobed endpoint was painted as something other than amber unknown');
    const ctls = withCls(tree, 'audio-play-ep-ctl');
    if (ctls.length) throw new Error('the panel invented ' + ctls.length + ' primary control(s) the old host never exposed: ' + ctls.map(ownTxt).join('|'));
    const webui = withCls(tree, 'audio-play-ep-webui');
    if (webui.length !== 4) throw new Error('expected a webui link on all 4 rows, saw ' + webui.length);
    if (withCls(tree, 'audio-play-ep-unset').length) throw new Error('an unset chip appeared for a host that never reports unset');
    if (statusAlarming(tree)) throw new Error('an alarm appeared with no host answer behind it: ' + statusText(tree));
    if (withCls(tree, 'audio-play-storage').length) throw new Error('a storage block was painted with no storage_status answer');
    const bad = voidViolations(m.run);
    if (bad.length) throw new Error(bad.length + ' void element(s) carry children');
  });

  await attempt('T-199: a T-198 host (primary carries id + flags + health) lights the rows and unlocks the same controls (T-235 contract change: the slot labels name the Primary)', async function () {
    const regEntry = function (id, fn, extra) {
      return Object.assign({ id: id, fn: fn, url: 'http://cpu2.test:' + (fn === 'tts' ? '8963' : '8962'), route: 'speech', host: 'cpu2.test', enabled: true, batch_allowed: true, paused: false, models: ['m1', 'm2'], models_source: 'engine', models_at: 1727000000000 }, extra || {});
    };
    const newHost = function (url) {
      const u = String(url);
      let body = { ok: true };
      if (/endpoint_registry/.test(u)) {
        const fn = /fn=stt/.test(u) ? 'stt' : 'tts';
        body = {
          ok: true, fn: fn,
          primary: { id: 'primary', fn: fn, url: 'http://cpu1.test:' + (fn === 'stt' ? '8962' : '8963'), route: 'speech', host: 'cpu1.test', enabled: true, batch_allowed: true, paused: false, online: fn === 'tts', checked_at: 1727000100000, health_error: fn === 'tts' ? '' : 'connect ECONNREFUSED' },
          endpoints: fn === 'stt' ? [regEntry('e-2', 'stt', { online: false, health_error: 'HTTP 503', checked_at: 1727000100000 })] : [regEntry('e-1', 'tts', { online: true, http: 200, checked_at: 1727000100000 })],
        };
      }
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
    };
    const m = mountWith(newHost);
    await openAllSections(m.run, m.comp);
    const mark2 = m.run.rt.created.length;
    m.run.render(m.comp());
    const tree = m.run.rt.created.slice(mark2);
    const lights = withCls(tree, 'audio-play-ep-online').map(function (e) { return ownTxt(e) + ':' + e.props.style.color; }).sort().join('|');
    if (lights !== 'offline:#f85149|offline:#f85149|online:#3fb950|online:#3fb950') throw new Error('lights: ' + lights);
    const ctls = withCls(tree, 'audio-play-ep-ctl').map(ownTxt);
    // T-300 U-7 CONTRACT CHANGE (user request 2026-10-12: "enabled and disabled + batch allowed should be
    // 2 buttons, pause is not needed"). Two primaries x (enable/disable, models) + the tts-only batch toggle
    // + two clear buttons. The pause count is asserted as 0 rather than dropped: an endpoint row must not
    // be able to send endpoint_pause at all any more, and a count of 0 is the only way to see that from here.
    if (ctls.filter(function (t) { return t === 'pause' || t === 'resume'; }).length !== 0) throw new Error('pause/resume controls (T-300 U-7: gone from every row): ' + ctls.join('|'));
    // T-499 CONTRACT CHANGE (user, 2026-10-16): the state control now names the STATE - `enabled` on a row that
    // is in play, `disabled` or `paused` on one that is not - and the row keeps no chip repeating it.
    if (ctls.filter(function (t) { return t === 'enabled'; }).length !== 2) throw new Error('enabled controls: ' + ctls.join('|'));
    // T-505 CONTRACT CHANGE (user request 2026-10-16): the destructive control is `remove` on EVERY row, the
    // Primary row included - so the two Primary rows here carry exactly two of them, under the new name. (A
    // registered row's controls carry no ctlCls, which is why they are not counted in this list.)
    if (ctls.filter(function (t) { return t === 'remove'; }).length !== 2) throw new Error('remove controls: ' + ctls.join('|'));
    if (ctls.filter(function (t) { return t === 'batch off' || t === 'batch on'; }).length !== 1) throw new Error('batch must be a tts-only control: ' + ctls.join('|'));
    const slots = withCls(tree, 'audio-play-ep-slot').map(ownTxt).join('|');
    // T-235 contract change: the four slots are still exactly these four, in the same order and
    // the same vocabulary — the primary slot now also names itself, and a registered row names
    // its host id beside its slot.
    // T-597 RE-POINTED 2026-10-20 (the operator chose the second half of that card: the machine on the row, the
    // registry id in the hover). What this pin protects is UNCHANGED — four slots, this order, this vocabulary, the
    // primary first — only the words after the slot are the machine the host named instead of the registry id.
    if (slots !== 'TTS1: cpu1.test|TTS2: cpu2.test|STT1: cpu1.test|STT2: cpu2.test') throw new Error('slot labels (T-235 contract change): ' + slots);
    const bad = voidViolations(m.run);
    if (bad.length) throw new Error(bad.length + ' void element(s) carry children');
  });


  // T-235 (user request 2026-10-06): "if we have a 'primary' node per endpoint group, then name
  // it as such and add buttons to the 2nd and 3rd, ... etc to 'set as primary'". The render half
  // pins the SHAPE: a group of three endpoints renders three rows with the same controls, the
  // primary row is the one whose label says Primary, and every registered row offers the
  // promotion. The ONE verb those buttons send (endpoint_promote, T-238) is pinned in
  // tests/ui_state.test.cjs.
  await attempt('T-235: a group of THREE endpoints renders three rows of the same shape, the Primary label sits on the primary row only, and every registered row offers set as primary', async function () {
    const regEntry = function (id, fn, port) {
      const host = (id === 'e-3' || id === 'e-4') ? 'gpu1.test' : 'cpu2.test';
      return { id: id, fn: fn, url: 'http://' + host + ':' + port, route: 'speech', host: host, enabled: true, batch_allowed: true, paused: false, models: ['m1'], models_source: 'engine', models_at: 1727000000000, online: true, checked_at: 1727000100000, health_error: '' };
    };
    const threeHost = function (url) {
      const u = String(url);
      let body = { ok: true };
      if (/endpoint_registry/.test(u)) {
        const fn = /fn=stt/.test(u) ? 'stt' : 'tts';
        body = {
          ok: true, fn: fn,
          primary: { id: 'primary', fn: fn, url: 'http://cpu1.test:' + (fn === 'stt' ? '8962' : '8963'), route: 'speech', host: 'cpu1.test', enabled: true, batch_allowed: true, paused: false, online: true, checked_at: 1727000100000, health_error: '' },
          endpoints: fn === 'stt' ? [regEntry('e-2', 'stt', 8962), regEntry('e-4', 'stt', 8962)] : [regEntry('e-1', 'tts', 8963), regEntry('e-3', 'tts', 8963)],
        };
      }
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
    };
    const m = mountWith(threeHost);
    await openAllSections(m.run, m.comp);
    const mark = m.run.rt.created.length;
    m.run.render(m.comp());
    const tree = m.run.rt.created.slice(mark);
    const primRows = withCls(tree, 'audio-play-endpoint');
    const regRows = withCls(tree, 'audio-play-ep-row');
    if (primRows.length !== 2 || regRows.length !== 4) throw new Error('rows: primary ' + primRows.length + ' registered ' + regRows.length);
    // The row's OWN subtree: the flat created list is children-before-parents, so a slice of it
    // would sweep in buttons from other sections.
    const rowBtns = function (el) {
      const out = [];
      (function walk(node) {
        if (node == null) return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (!node.props) return;
        if (node.type === 'button') out.push(ownTxt(node));
        [].concat(node.props.children || []).forEach(walk);
      })(el);
      return out;
    };
    const rowBySlot = function (slot) {
      const all = primRows.concat(regRows).filter(function (e) { return ownTxt(e).indexOf(slot) === 0; });
      return all.length ? all[all.length - 1] : null;
    };
    const slots = withCls(tree, 'audio-play-ep-slot').map(ownTxt);
    // T-597 RE-POINTED 2026-10-20: a group of THREE still renders THREE rows, in registration order, with the
    // Primary row first and the slot numbering (TTS1/TTS2/TTS3) unchanged — that is what this line exists to prove.
    // The words after the slot are now the machine, per the operator's answer on that card.
    if (slots.join('|') !== 'TTS1: cpu1.test|TTS2: cpu2.test|TTS3: gpu1.test|STT1: cpu1.test|STT2: cpu2.test|STT3: gpu1.test') throw new Error('slot labels: ' + slots.join('|'));
    const groups = [
      // T-300 U-7 CONTRACT CHANGE (user request 2026-10-12: "pause is not needed"): the core control set
      // every endpoint row must carry lost 'pause'. It is still one identical set per group, which is
      // what this block exists to prove.
      // T-499: the core set names the states, not the presses - an endpoint in play says `enabled`, a tts row
      // whose batch is allowed says `batch on`.
      // T-655 (2026-10-26): `models` and `check` merged into the row's one `read now` control.
      { name: 'tts', core: ['enabled', 'batch on', 'read now'], slots: ['TTS1', 'TTS2', 'TTS3'] },
      { name: 'stt', core: ['enabled', 'read now'], slots: ['STT1', 'STT2', 'STT3'] },
    ];
    groups.forEach(function (g) {
      g.slots.forEach(function (slot, i) {
        const el = rowBySlot(slot);
        if (!el) throw new Error('no row rendered for ' + slot);
        const ctrls = rowBtns(el);
        g.core.forEach(function (v) { if (ctrls.indexOf(v) < 0) throw new Error(g.name + ' row ' + slot + ' lacks ' + v + ': ' + ctrls.join(',')); });
        // T-505 CONTRACT CHANGE: the destructive control has ONE name on every row - `remove` - and there is
        // no `clear` left on a Primary row. `set as primary` stays what only a registered row can offer.
        if (ctrls.indexOf('remove') < 0 || ctrls.indexOf('clear') >= 0) throw new Error(g.name + ' row ' + slot + ' lacks the one destructive control: ' + ctrls.join(','));
        if (i === 0) {
          if (ctrls.indexOf('set as primary') >= 0) throw new Error(g.name + ' primary row offers a promotion it cannot need: ' + ctrls.join(','));
        } else if (ctrls.indexOf('set as primary') < 0) {
          throw new Error(g.name + ' registered row ' + slot + ' has no set as primary: ' + ctrls.join(','));
        }
      });
    });
    const sp = tree.filter(function (e) { return e.type === 'button' && e.props && e.props.className === 'audio-play-ep-setprimary'; });
    if (sp.length !== 4) throw new Error('set as primary controls: ' + sp.length + ' (expected one per registered row)');
    if (sp.some(function (b) { return ownTxt(b) !== 'set as primary'; })) throw new Error('set as primary labels: ' + sp.map(ownTxt).join(','));
    // U-18 (user 2026-10-13, 01:39): the hover says what the click does in user words and names no call.
    // T-238's contract - ONE step, and no composed chain of remove/set/add - is still what is asserted.
    if (sp.some(function (b) { const t = String(b.props.title || ''); return !/ONE call, one step/.test(t) || /endpoint_promote|endpoint_remove|endpoint_add|set_endpoint|\{fn/.test(t); })) throw new Error('a set as primary hover does not state the ONE step, or names a call (T-238 contract change): ' + sp.map(function (b) { return String(b.props.title || ''); }).join(' || '));
    if (primRows.some(function (r) { return rowBtns(r).indexOf('set as primary') >= 0; })) throw new Error('a primary row offers set as primary');
    // T-597 RE-POINTED 2026-10-20 (the operator's answer on that card: the machine on the row face, the registry id
    // and what the row IS in the hover). The word "Primary" left the face of every row, so the same fact is measured
    // where it now lives: the two primary rows say it about themselves, and no registered row says it at all.
    const slotTip = function (el) {
      const found = [];
      (function walk(node) {
        if (node == null) return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        if (!node.props) return;
        if (hasCls(node, 'audio-play-ep-slot')) found.push(String(node.props.title || ''));
        [].concat(node.props.children || []).forEach(walk);
      })(el);
      return found.join(' || ');
    };
    if (primRows.filter(function (r) { return /is the primary endpoint/.test(slotTip(r)); }).length !== 2) throw new Error('rows whose hover says it is the primary: ' + primRows.filter(function (r) { return /is the primary endpoint/.test(slotTip(r)); }).length + ' of ' + primRows.length);
    if (regRows.some(function (r) { return /is the primary endpoint/.test(slotTip(r)); })) throw new Error('a registered row claims to be the primary endpoint');
    const bad = voidViolations(m.run);
    if (bad.length) throw new Error(bad.length + ' void element(s) carry children');
  });

  // T-726 (WM-31 item 7, the operator's words of 2026-11-05: "Endpoints: Fix 'unload' functionality - insert thin
  // lines between endpoints"). The row's bottom edge has always been the separation; what was wrong is that it did
  // not read as one. So this pins the separator itself, on every row of a group - the Primary row and every
  // registered row: a drawn 1 px line in the panel's own control-edge tone, with the row's own bottom padding above
  // it and the row's own bottom margin below it. The line's strength and its spacing are what the ask named, and a
  // row that carries neither is what this refuses.
  await attempt('T-726 (WM-31 item 7): every endpoint row of a group - Primary and registered - is separated from '
      + 'the next by a thin line with space on both sides of it, in the panel\u2019s own control-edge tone', async () => {
    const regEntry726 = function (id, fn, port) {
      const host726 = (id === 'e-4') ? 'gpu1.test' : 'cpu2.test';
      return { id: id, fn: fn, url: 'http://' + host726 + ':' + port, route: 'speech', host: host726,
        enabled: true, batch_allowed: true, paused: false, models: ['m1'], models_source: 'engine',
        models_at: 1727000000000, online: true, checked_at: 1727000100000, health_error: '' };
    };
    const sepHost726 = function (url726) {
      const u726 = String(url726);
      let body726 = { ok: true };
      if (/endpoint_registry/.test(u726)) {
        const fn726 = /fn=stt/.test(u726) ? 'stt' : 'tts';
        body726 = {
          ok: true, fn: fn726,
          primary: { id: 'primary', fn: fn726, url: 'http://cpu1.test:' + (fn726 === 'stt' ? '8962' : '8963'),
            route: 'speech', host: 'cpu1.test', enabled: true, batch_allowed: true, paused: false,
            online: true, checked_at: 1727000100000, health_error: '' },
          endpoints: fn726 === 'stt' ? [regEntry726('e-2', 'stt', 8962)] : [regEntry726('e-1', 'tts', 8963)],
        };
      }
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body726); } });
    };
    const m726 = mountWith(sepHost726);
    await openAllSections(m726.run, m726.comp);
    const mark726 = m726.run.rt.created.length;
    m726.run.render(m726.comp());
    const tree726 = m726.run.rt.created.slice(mark726);
    const rows726 = withCls(tree726, 'audio-play-endpoint').concat(withCls(tree726, 'audio-play-ep-row'));
    if (rows726.length !== 4) throw new Error('endpoint rows: ' + rows726.length);
    const sep726 = rows726.map(function (e726) { return (e726 && e726.props && e726.props.style) || {}; });
    const bad726 = sep726.filter(function (s726) {
      return !/^1px solid #8886$/.test(String(s726.borderBottom || ''))
          || !/\d+px 0 \d+px/.test(String(s726.padding || ''))
          || !/^\d+px$/.test(String(s726.marginBottom || ''));
    });
    if (bad726.length) throw new Error('endpoint rows with no separated line: ' + bad726.length);
    const bad2 = voidViolations(m726.run);
    if (bad2.length) throw new Error(bad2.length + ' void element(s) carry children');
  });


  await attempt('T-235: a PRE-T-198 host with registered endpoints gets NO set as primary control (the panel sends only a verb that host actually answers) (T-238 contract change)', async function () {
    const regEntry = function (id, fn) {
      return { id: id, fn: fn, url: 'http://cpu2.test:' + (fn === 'stt' ? '8962' : '8963'), route: 'speech', host: 'cpu2.test', enabled: true, batch_allowed: true, paused: false, models: ['m1'], models_source: 'engine', models_at: 1727000000000 };
    };
    const oldHost = function (url) {
      const u = String(url);
      let body = { ok: true };
      if (/endpoint_registry/.test(u)) {
        const fn = /fn=stt/.test(u) ? 'stt' : 'tts';
        body = { ok: true, fn: fn, primary: { url: 'http://cpu1.test:' + (fn === 'stt' ? '8962' : '8963'), route: 'speech' }, endpoints: fn === 'stt' ? [regEntry('e-2', 'stt')] : [regEntry('e-1', 'tts')] };
      }
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
    };
    const m = mountWith(oldHost);
    await openAllSections(m.run, m.comp);
    const mark = m.run.rt.created.length;
    m.run.render(m.comp());
    const tree = m.run.rt.created.slice(mark);
    if (withCls(tree, 'audio-play-ep-row').length !== 2) throw new Error('registered rows: ' + withCls(tree, 'audio-play-ep-row').length);
    const sp = tree.filter(function (e) { return e.type === 'button' && e.props && e.props.className === 'audio-play-ep-setprimary'; });
    if (sp.length) throw new Error('the panel invented ' + sp.length + ' set-as-primary control(s) on a host that has no primary view to displace');
    if (withCls(tree, 'audio-play-ep-ctl').length) throw new Error('the panel invented primary controls on a pre-T-198 host');
    const slots = withCls(tree, 'audio-play-ep-slot').map(ownTxt).join('|');
    // T-597 RE-POINTED 2026-10-20: this block is about a host that answers NO primary view, so the panel must
    // invent no controls. The labels moved with the panel's vocabulary; the invention it guards against is unchanged.
    if (slots !== 'TTS1: cpu1.test|TTS2: cpu2.test|STT1: cpu1.test|STT2: cpu2.test') throw new Error('slot labels: ' + slots);
    const bad = voidViolations(m.run);
    if (bad.length) throw new Error(bad.length + ' void element(s) carry children');
  });

  await attempt("T-597 (operator 2026-10-20, the half of the card they chose: the Endpoints rows print the machine too, the id stays in the hover): a lane that carries TWO endpoints on ONE machine says so on the row, with the port", async function () {
    // The fixture is the shape AGENTS.md warns about, drawn small: the primary and a registered entry of the SAME
    // lane on the SAME machine, on two ports. A bare machine name would print the same words for both rows, so the
    // port joins the name on those two rows and stays off the row whose machine carries only one endpoint.
    const regEntry597 = function (id, fn, url, host) {
      return { id: id, fn: fn, url: url, route: 'speech', host: host, enabled: true, batch_allowed: true, paused: false, held_by: '', hold_reason: '', held_at: 0, models: ['m1'], models_source: 'engine', models_at: 1727000000000 };
    };
    const twoOnOneBox597 = function (url) {
      const u = String(url);
      let body = { ok: true };
      if (/endpoint_registry/.test(u)) {
        const fn = /fn=stt/.test(u) ? 'stt' : 'tts';
        body = { ok: true, fn: fn,
          primary: { id: 'primary', url: 'http://cpu1.test:' + (fn === 'stt' ? '8962' : '8963'), route: 'speech', host: 'cpu1.test', enabled: true, batch_allowed: true, held_by: '', models: ['m1'], models_at: 1727000000000 },
          endpoints: fn === 'stt'
            ? [regEntry597('e-2', 'stt', 'http://cpu2.test:8962', 'cpu2.test')]
            : [regEntry597('e-11', 'tts', 'http://cpu2.test:8963', 'cpu2.test'), regEntry597('e-12', 'tts', 'http://cpu1.test:8964', 'cpu1.test')] };
      } else if (/queue_status/.test(u)) {
        body = { ok: true, queues: { tts: { paused: false, running: null, queued: 0 }, stt: { paused: false, running: null, queued: 0 } }, machines: {} };
      }
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
    };
    const m597 = mountWith(twoOnOneBox597);
    await openAllSections(m597.run, m597.comp);
    const mark597 = m597.run.rt.created.length;
    m597.run.render(m597.comp());
    const tree597 = m597.run.rt.created.slice(mark597);
    const chips597 = withCls(tree597, 'audio-play-ep-slot');
    const faces597 = chips597.map(ownTxt);
    if (faces597.join('|') !== 'TTS1: cpu1.test:8963|TTS2: cpu2.test|TTS3: cpu1.test:8964|STT1: cpu1.test|STT2: cpu2.test') {
      throw new Error('the rows do not tell two endpoints of one lane on one machine apart, or they told apart a machine that carries only one: ' + faces597.join(' | '));
    }
    // The id a dispatch carries did not vanish, it moved: every row still names its registry id in its own hover.
    const tips597 = chips597.map(function (c) { return String((c.props || {}).title || ''); });
    if (tips597.some(function (t) { return !/endpoint slot (TTS|STT)\d/.test(t) || !/\(id (primary|e-\d+)\)/.test(t); })) {
      throw new Error('a row hover no longer names the slot and the id it carries: ' + tips597.map(function (t) { return t.slice(0, 60); }).join(' || '));
    }
    // The fallback that refuses to claim an identity it has not checked: a row rendered without a peer list keeps
    // the label it had before this card. The panel always hands one over today; this is the guard for a caller that
    // does not, so a machine name is never printed on the strength of one endpoint's own url alone.
    // EndpointPeerRow is reached as a plain call from the row builders, so the runtime cannot be handed it
    // directly; RegistryEndpointRow can, and it is the caller that hands the peer list down.
    const rowFn597 = m597.seen.get('RegistryEndpointRow');
    if (!rowFn597 || !rowFn597.fn) throw new Error('no RegistryEndpointRow was reached to test the no-peer-list fallback');
    const markNoPeers = m597.run.rt.created.length;
    m597.run.renderComponent(rowFn597.fn, {
      // index 1 is where this entry sits in the fixture above, and epSlot names that slot TTS3 — the same number
      // the panel printed for it a few lines up, which is the point: the fallback changes the words after the slot
      // and not the slot itself.
      fn: 'tts', ep: regEntry597('e-12', 'tts', 'http://cpu1.test:8964', 'cpu1.test'), index: 1,
      primary: null, primaryLaneRows: 0, occupancy: null,
    }, { fresh: true, effects: false });
    const noPeersChip = withCls(m597.run.rt.created.slice(markNoPeers), 'audio-play-ep-slot')[0];
    if (!noPeersChip) throw new Error('the fallback row rendered no slot chip');
    if (ownTxt(noPeersChip) !== 'TTS3 \u00B7 e-12') throw new Error('a row with no peer list named a machine it cannot check: ' + ownTxt(noPeersChip));
    const bad597 = voidViolations(m597.run);
    if (bad597.length) throw new Error(bad597.length + ' void element(s) carry children');
  });
  await attempt('T-199: an unset primary + a broken output root are the ONLY two things that make the header blink', async function () {
    const brokenHost = function (url) {
      const u = String(url);
      let body = { ok: true };
      if (/endpoint_registry/.test(u)) {
        const fn = /fn=stt/.test(u) ? 'stt' : 'tts';
        body = { ok: true, fn: fn, primary: { id: 'primary', fn: fn, url: '', route: 'speech', unset: true, enabled: true, batch_allowed: true, paused: false }, endpoints: [] };
      } else if (/storage_status/.test(u)) {
        body = { ok: true, roots: [{ path: '/mnt/llama/tts', exists: true, writable: false, free_bytes: 536870912, total_bytes: 1099511627776, error: 'EACCES: permission denied' }], low_space: true, low_space_bytes_threshold: 2147483648, write_error: true, write_errors: [{ ts: 1727000000000, where: 'save_wav', error: 'ENOSPC: no space left on device' }], checked_at: 1727000000000 };
      }
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
    };
    const m = mountWith(brokenHost);
    await openAllSections(m.run, m.comp);
    const mark2 = m.run.rt.created.length;
    m.run.render(m.comp());
    const tree = m.run.rt.created.slice(mark2);
    // T-300 CONTRACT CHANGE (user feedback 2026-10-12, 18:47): "currently i see status_ idle ... 'LED'
    // TTS 'LED' STT and the 'OUT' -> we only need one status display in header -> combine into one status
    // showing ALARMS aswell". The endpoint chip and the output chip are GONE; the one status readout
    // carries both alarms. The guard did not get weaker - it got stricter in three ways: the two removed
    // parts must render NOWHERE, the readout must NAME both alarms in its text (an alarm you cannot read
    // is an alarm you do not have), and its tooltip must still hold both full reasons the chips used to
    // hold, which is also what keeps the output PATH out of the visible header (T-199 request 7).
    if (withCls(tree, 'audio-play-head-ep').length !== 0 || withCls(tree, 'audio-play-head-out').length !== 0)
      throw new Error('a removed header part came back: ' + withCls(tree, 'audio-play-head-ep').length + ' ep + ' + withCls(tree, 'audio-play-head-out').length + ' out');
    const alarms = withCls(tree, 'audio-play-now');
    if (alarms.length !== 1) throw new Error('expected exactly ONE status readout in the header, saw ' + alarms.length);
    const alarmTxt = [].concat(alarms[0].props.children || []).join('');
    if (alarmTxt.indexOf('! no endpoint') < 0 || alarmTxt.indexOf('! output unwritable') < 0)
      throw new Error('the one status readout does not name both alarms: ' + alarmTxt);
    if (alarms[0].props.style.color !== '#f85149') throw new Error('the alarming status readout was not red: ' + JSON.stringify(alarms[0].props.style));
    if (typeof alarms[0].props.title !== 'string' || alarms[0].props.title.length < 40) throw new Error('the alarming status readout carries no tooltip');
    if (alarms[0].props.title.indexOf('NO TTS + STT ENDPOINT IS SET') < 0 || alarms[0].props.title.indexOf('EACCES') < 0)
      throw new Error('the status tooltip lost one of the two alarm reasons: ' + alarms[0].props.title);
    if (withCls(tree, 'audio-play-storage-row').length !== 1) throw new Error('the failing root is not listed in the Output section');
    const bad = voidViolations(m.run);
    if (bad.length) throw new Error(bad.length + ' void element(s) carry children');
  });

  await attempt('T-324: a separation row offers "play src" while it is queued or running, not only once it finishes', function () {
    // T-324 (user 2026-10-13): "the SEP jobs should have a 'play src' button while those are not yet processed or
    // are being processed". The host has always served ?src=1 straight from the row's own file_path with no
    // status test (index.js:13090) and always put src_url on such a row (index.js:3582); it was only the PANEL
    // that hid the button behind status === 'ok'. A 102 s separation runs for the better part of an hour while its
    // input file has been on disk since the moment it was dispatched.
    const calls324 = [];
    const noop324 = function () {};
    const rows324 = [
      { id: 'q1', fn: 'tts', kind: 'task', task_kind: 'sep', status: 'queued', model: 'bs_roformer', file_path: '/x/in.wav', src_url: '/deepamp/q1?src=1', position: 1 },
      { id: 'r1', fn: 'tts', kind: 'task', task_kind: 'sep', status: 'running', model: 'bs_roformer', file_path: '/x/in.wav', src_url: '/deepamp/r1?src=1', activity: 'separating', started: Date.now() - 40000 },
      { id: 's1', fn: 'tts', kind: 'task', task_kind: 'sep', status: 'queued', model: 'bs_roformer' },
      { id: 'o1', fn: 'tts', kind: 'task', task_kind: 'sep', status: 'ok', model: 'bs_roformer', file_path: '/x/in.wav', src_url: '/deepamp/o1?src=1', route_url: '/deepamp/o1', stems: [{ id: 'vocals', url: '/deepamp/o1?stem=vocals' }] },
    ];
    const mark324 = shim.rt.created.length;
    shim.renderComponent(fnByName.PlaylistPane, {
      playlist: rows324, limit: 20, queues: null, play: noop324, deleteJob: noop324, cancel: noop324,
      saveDesign: noop324, playSrc: function (id) { calls324.push(id); }, playStem: noop324, viewDiar: noop324,
      retry: noop324, reuseText: noop324,
    }, { fresh: true, effects: false });
    const tree324 = shim.rt.created.slice(mark324);
    const srcBtns = tree324.filter(function (e) { return e.type === 'button' && JSON.stringify(e.props.children) === '"\u25B6 src"'; });
    if (srcBtns.length !== 3)
      throw new Error('expected src on the queued, the running and the finished sep row, and none on the row with no source file: ' + srcBtns.length);
    const tipOf = function (id) {
      const b = srcBtns.filter(function (e) { return /job is waiting in the queue/.test(String(e.props.title)) && id === 'q1'
        || /still being processed/.test(String(e.props.title)) && id === 'r1'
        || /listen while checking the transcript/.test(String(e.props.title)) && id === 'o1'; }).pop();
      return b ? String(b.props.title) : 'missing';
    };
    if (!/input file is on disk already/.test(tipOf('q1'))) throw new Error('the queued row does not say the input is already there: ' + tipOf('q1'));
    if (!/still being processed/.test(tipOf('r1'))) throw new Error('the running row does not say it is still working: ' + tipOf('r1'));
    if (!/listen while checking the transcript/.test(tipOf('o1'))) throw new Error('the finished row lost its original hover: ' + tipOf('o1'));
    srcBtns.forEach(function (e) { if (typeof e.props.onClick === 'function') e.props.onClick(); });
    if (calls324.length !== 3 || calls324.some(function (id) { return !['q1', 'r1', 'o1'].includes(id); }))
      throw new Error('the src buttons do not all reach playSrc with their own row id: ' + JSON.stringify(calls324));
    // The MAIN OUTPUT button stays behind status === 'ok': a queued separation has no output to play.
    const mainBtns = tree324.filter(function (e) { return e.type === 'button' && JSON.stringify(e.props.children) === '"\u25B6"'; });
    if (mainBtns.length !== 1) throw new Error('a queued or running separation is being offered an output that does not exist yet: ' + mainBtns.length);
  });

  await attempt('T-199: an expanded playlist row wraps instead of forcing a horizontal scrollbar', function () {
    const stems = ['vocals', 'drums', 'bass', 'other', 'other1', 'other2'].map(function (s) { return { id: s, url: '/deepamp/j9?stem=' + s }; });
    const rows = [
      { id: 'j9', fn: 'tts', kind: 'task', task_kind: 'sep', status: 'ok', text: 'six stems', model: 'htdemucs', route_url: '/deepamp/j9', stems: stems },
      { id: 'j10', fn: 'stt', kind: 'diar', status: 'ok', text: 'x'.repeat(200), model: 'nemotron_3_diar', route_url: '/deepamp/j10', transcript: 'x'.repeat(200), speaker_turns: [{ speaker_id: '0', start: 0, end: 3, confidence: 0.9, text: 'https://audio.cpp.invalid/' + 'y'.repeat(160) + '/z.wav' }] },
    ];
    const mark = shim.rt.created.length;
    shim.renderComponent(fnByName.PlaylistPane, { playlist: rows, limit: 20, queues: null, play: function () {}, deleteJob: function () {}, cancel: function () {}, saveDesign: function () {}, playSrc: function () {}, playStem: function () {}, viewDiar: function () {}, retry: function () {} }, { fresh: true, effects: false });
    const tree = shim.rt.created.slice(mark);
    const row = tree.filter(function (e) { return e.type === 'div' && typeof e.props.title === 'string' && e.props.title.indexOf('j9') === 0; }).pop();
    if (!row) throw new Error('the six-stem row was not rendered');
    if (row.props.style.minWidth !== '0' || row.props.style.overflowWrap !== 'anywhere') throw new Error('the row itself cannot shrink: ' + JSON.stringify(row.props.style));
    const stemSpan = tree.filter(function (e) { return e.type === 'span' && String(e.props.title || '') === 'separation stems \u2014 play or download each track'; }).pop();
    if (!stemSpan) throw new Error('the stems group is missing');
    if (stemSpan.props.style.flexWrap !== 'wrap') throw new Error('the stems group still refuses to wrap');
    if (stemSpan.props.style.minWidth !== '0') throw new Error('the stems group still has an automatic (min-content) minimum size');
    if (stemSpan.props.style.flexShrink === 0) throw new Error('the stems group is still unshrinkable');
    const clsOf = function (e) { return String((e && e.props && e.props.className) || ''); };
    const main = tree.filter(function (e) { return clsOf(e).split(/\s+/).indexOf('audio-play-row-main') >= 0; });
    if (!main.length || main.some(function (e) { return e.props.style.minWidth !== '0' || e.props.style.flex !== '1 1 0'; }))
      throw new Error('the row text span cannot shrink - T-307 made it the thing that gives way, not the buttons');
    if (main.some(function (e) { return e.props.style.whiteSpace !== 'nowrap' || e.props.style.textOverflow !== 'ellipsis'; }))
      throw new Error('the row text is allowed to wrap onto a second line');
    // T-307 (user 2026-10-13, 05:52): "i would prefer to have playlist buttons bound on the right side of the
    // panel and no wrapping of playlist items (remove min width from text field should suffice)". Everything a
    // row can DO is one group, pinned to the right edge and never squeezed.
    const acts = tree.filter(function (e) { return clsOf(e).split(/\s+/).indexOf('audio-play-row-acts') >= 0; });
    // This fixture renders TWO rows (j9 with six stems, j10 with a 200-character token), so TWO groups - one
    // per row - is the honest expectation, and every one of them has to be pinned.
    if (acts.length !== 2) throw new Error('the two fixture rows do not carry one action group each: ' + acts.length);
    acts.forEach(function (e) {
      if (e.props.style.justifyContent !== 'flex-end')
        throw new Error('the row buttons are not flush against the right edge of the panel: ' + JSON.stringify(e.props.style));
      if (e.props.style.flexShrink !== 0) throw new Error('the row buttons can be squeezed out of shape');
    });
    if (tree.some(function (e) { return e.type === 'span' && e.props.style && e.props.style.flex === '1 1 120px'; }))
      throw new Error('a row line still asks for 120px before anything else shrinks');
    if (acts.some(function (e) { return e.props.style.marginLeft === 'auto'; }))
      throw new Error('an auto margin on the buttons claims the free space before the text line grows - '
        + 'that is what starves a row line to zero width');
    // T-307 (user 2026-10-13, 06:02): "now it looks like every playlist item has 2 rows". A wrapping flex line
    // is packed by HYPOTHETICAL sizes before shrinking is considered, so a text line whose basis is its own
    // content jumps to a second line instead of being cut. Basis 0 is what keeps it on the first line.
    main.forEach(function (e) {
      if (e.props.style.flex !== '1 1 0') throw new Error('the row text line claims a width up front again');
    });

    const mark2 = shim.rt.created.length;
    shim.renderComponent(fnByName.SttBox, {
      models: { stt: [] }, selModel: { stt: '' }, sttFile: null, sttTranscript: 'z'.repeat(400), busy: { stt: false },
      selLang: 'auto', onSelectLang: function () {}, selLane: '', registry: null, onLane: function () {}, onRefreshRegistry: function () {},
      onModelChange: function () {}, onFile: function () {}, dispatchStt: function () {}, abort: function () {}, onUploadFile: function () {},
      onUseRow: function () {}, playlist: [], sttSpeakerTurns: [{ speaker_id: '0', start: 0, end: 3, confidence: 0.9, text: 'https://audio.cpp.invalid/' + 'y'.repeat(160) + '/z.wav' }], sttViewSeq: 1,
    }, { fresh: true, effects: false });
    const tree2 = shim.rt.created.slice(mark2);
    const turn = tree2.filter(function (e) { return e.type === 'span' && e.props.style && e.props.style.flex === '1 1 80px'; }).pop();
    if (!turn) throw new Error('the diar turn text span was not rendered');
    if (turn.props.style.minWidth !== '0' || turn.props.style.overflowWrap !== 'anywhere') throw new Error('a long token in a diar turn still forces the row wider than the panel: ' + JSON.stringify(turn.props.style));
  });

  await attempt('T-566 (operator 2026-10-17, verbatim: "the playlist shows the Text instruction field too small '
      + 'compared to modelname"; the ruling chosen was "drop the 60-char cut, give the text priority over the model '
      + 'chip"): the row carries the WHOLE instruction, and the model chip is the item with a width of its own', function () {
    const rows566 = [
      { id: 'k1', fn: 'tts', kind: 'tts', status: 'ok', text: 'a'.repeat(140), model: 'qwen3-tts', voice: 'bijan', route_url: '/deepamp/k1' },
      { id: 'k2', fn: 'stt', kind: 'diar', status: 'ok', text: 'x'.repeat(200), model: 'nemotron_3_diar', route_url: '/deepamp/k2', transcript: 'x'.repeat(200) },
    ];
    const mark566 = shim.rt.created.length;
    shim.renderComponent(fnByName.PlaylistPane, { playlist: rows566, limit: 20, queues: null, play: function () {}, deleteJob: function () {}, cancel: function () {}, saveDesign: function () {}, playSrc: function () {}, playStem: function () {}, viewDiar: function () {}, retry: function () {} }, { fresh: true, effects: false });
    const tree566 = shim.rt.created.slice(mark566);
    const cls566 = function (e) { return String((e && e.props && e.props.className) || ''); };
    const mains566 = tree566.filter(function (e) { return cls566(e).split(/\s+/).indexOf('audio-play-row-main') >= 0; });
    if (mains566.length !== 2) throw new Error('the two fixture rows did not both render a text span: ' + mains566.length);
    const texts566 = mains566.map(function (e) { return String(e.props.children); });
    const bare566 = texts566.map(function (t) { return t.replace(/"/g, ''); });
    if (!bare566.some(function (t) { return t.length === 140; }) || !bare566.some(function (t) { return t.length === 200; }))
      throw new Error('a row text is still cut in the data: ' + JSON.stringify(bare566.map(function (t) { return t.length; })));
    if (texts566.some(function (t) { return t.indexOf('\u2026') >= 0; }))
      throw new Error('an ellipsis was written into the row text instead of being left to the CSS cut');
    mains566.forEach(function (e) {
      if (e.props.style.flex !== '1 1 0' || e.props.style.minWidth !== '0') throw new Error('the text line no longer absorbs what is left: ' + JSON.stringify(e.props.style));
      if (e.props.style.whiteSpace !== 'nowrap' || e.props.style.textOverflow !== 'ellipsis') throw new Error('a row text that is no longer cut in the data is also no longer cut on screen: it wraps');
    });
    const chipTitles566 = ['qwen3-tts \u00B7 bijan', 'nemotron_3_diar'];
    const chips566 = tree566.filter(function (e) { return e.type === 'span' && chipTitles566.indexOf(String(e.props.title)) >= 0; });
    if (chips566.length !== 2) throw new Error('the model chips were not both rendered: ' + chips566.length);
    chips566.forEach(function (e) {
      if (e.props.style.maxWidth !== '96px') throw new Error('the model chip still claims more width than the take text is allowed: ' + String(e.props.style.maxWidth));
      if (e.props.style.textOverflow !== 'ellipsis' || e.props.style.whiteSpace !== 'nowrap') throw new Error('the chip that gives way is not the model chip');
      if (typeof e.props.onMouseEnter !== 'function') throw new Error('the chip lost the hover slide that makes its cut readable (T-373)');
    });
  });

  await attempt('T-199: the endpoint row survives a primary that is null, garbage, or unset', function () {
    const base = seen.get('EndpointRow').props;
    const shapes = [
      { primary: null },
      { primary: undefined },
      { primary: {} },
      { primary: [] },
      { primary: 'not-an-object' },
      { primary: { id: 'primary', fn: 'tts', url: '', unset: true } },
      { primary: { id: 'primary', fn: 'tts', url: 'http://x:1', route: 'tasks', enabled: false, batch_allowed: false, paused: true, online: false, health_error: 'boom', checked_at: 0 } },
      { primary: { id: 'primary', fn: 'tts', url: 'http://x:1', models: 'nope' }, models: null },
      { primary: { id: 'primary', fn: 'tts', url: null }, models: { tts: [null, {}, { id: 'm1' }] } },
    ];
    for (const extra of shapes) {
      const p = Object.assign({}, base, extra);
      shim.renderComponent(fnByName.EndpointRow, p, { fresh: true, effects: false });
    }
    for (const p of [{ events: null, limit: null, onLimit: null }, { events: [null, {}, { ts: 0, text: 'x' }], limit: 0 }, { events: 'not-a-list', limit: 'x' }]) {
      shim.renderComponent(fnByName.LogPane, p, { fresh: true, effects: false });
    }
    const bad = voidViolations(shim);
    if (bad.length) throw new Error(bad.length + ' void element(s) carry children');
  });

  console.log('\n--- 8. T-217 / T-247: ONE voice list, the plugin store as the entity (client half) ---');
  // The user's complaint (2026-10-05): "we still have server sided and plugin reg as
  // different entities - should have been harmonized". T-201 pinned the harmonized view: one
  // list, one row per name, provenance ON the row. T-217 then removed the shelf half of that
  // view: the plugin voice store IS the entity, and the samples a clone needs are staged onto
  // the endpoint that renders the take. So the row's load-bearing flag is `local_copy`.
  // T-247 (user decision 2026-10-07) removed the last engine-shaped fact: `registered_remote`
  // and the `engine_voices` block, which said only what an engine's own list said about a NAME.
  // The plugin does not read an engine voice list, so these checks now pin the ABSENCE -- and
  // they pin it against a host that STILL SENDS the block (the stub keeps sending
  // `engine_voices` on purpose: a stale host must not resurrect the header line or the badge).
  // The pre-T-217 host (no engine_voices block, no local_copy) still renders with no crash and
  // no invented alarm.
  const ENGINE217 = {
    hosts: [
      { url: 'http://10.0.0.10:8963', host: '10.0.0.10', count: 3,
        names: ['voy_doctor', 'engine_only_voice', 'bijan_0048'], listed_at: 1727000100000 },
    ],
    count: 3, names: ['voy_doctor', 'engine_only_voice', 'bijan_0048'],
    listed_at: 1727000100000, error: '',
  };
  const REG217 = {
    // here, and the plugin's own captured transcript. (It used to also claim an engine lists
    // the name; that flag is what T-247 removed from the wire and from the row.)
    voy_doctor: {
      ref_text: 'Doctor who, continuing the mission.', ref_wav: '/home/deepamp-test/.dsh/deepamp-audio/voices/voy_doctor.wav',
      remote_wav: '/mnt/llama/audio.cpp/voices/registered/voy_doctor.wav', remote_host: 'cpu1.test',
      created: 1727000000000, source: 'job ap-0254', ref_dur_s: 12.4, registered_remote: true,
      local_copy: true, voice_origin: 'plugin',
      reference_text: 'Doctor who, continuing the mission.', reference_text_source: 'plugin',
    },
    // here. Under T-217 and T-247 alike the sample is dispatched by path, so the row stays
    // selectable (T-201 contract change).
    voy_janeway: {
      ref_text: 'captain log, stardate 49012', ref_wav: '/home/deepamp-test/.dsh/deepamp-audio/voices/voy_janeway.wav',
      remote_wav: '', remote_host: '', created: 1727000000000, source: 'job ap-0301', ref_dur_s: 8.1,
      registered_remote: false, local_copy: true, voice_origin: 'plugin',
      reference_text: 'captain log, stardate 49012', reference_text_source: 'plugin',
      // T-361 (2026-10-14): the person's own filing, exactly as voice_registry answers it (T-359 host verb).
      groups: ['star trek', 'bridge crew'],
    },
    // an entry with no sample. T-201 contract change: it used to be gated and offered a pull;
    // T-217 removed the pull. T-247 contract change: it used to be SELECTABLE because an
    // engine's list named it; with no engine read there is nothing to resolve the name, so the
    // row is gated on the one fact that remains.
    engine_only_voice: {
      ref_text: '', ref_wav: '', remote_wav: '', remote_host: '',
      created: 1727000100000, source: 'shelf', ref_dur_s: 0,
      registered_remote: true, local_copy: false, voice_origin: 'shelf',
      reference_text: '', reference_text_source: '',
    },
    // no sample at all: the only genuinely unusable row, same as before.
    nowhere_voice: {
      ref_text: 'mine only', ref_wav: '', remote_wav: '', remote_host: '',
      created: 1727000000000, source: 'job ap-0500', ref_dur_s: 0,
      registered_remote: false, local_copy: false, voice_origin: 'plugin',
      reference_text: 'mine only', reference_text_source: 'plugin',
    },
  };
  function host201(url, opts, engineOverride) {
    const u = String(url);
    let body = { ok: true };
    // A model has to be listed or the boot chain never reaches refresh_voices (the host
    // loads a model's voices only once it knows a model exists). The stub STILL sends
    // engine_voices: that is the stale-host case T-247 has to survive.
    if (/get_models/.test(u)) body = { ok: true, models: [{ id: 'm1', loaded: true, task: 'tts', family: 'voxcpm2', quant: 'bf16', default_voice: true, clone_required: false }] };
    else if (/voice_registry/.test(u)) body = { ok: true, voices: REG217, engine_voices: engineOverride === undefined ? ENGINE217 : engineOverride };
    else if (/refresh_voices/.test(u)) body = { voices: [], server: [], ok: true, engine_voices: engineOverride === undefined ? ENGINE217 : engineOverride };
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
  }
  function mount201(engineOverride) {
    return mountWith(function (url, opts) { return host201(url, opts, engineOverride); });
  }
  // A row WITH its own chips/controls. rt.created is FLAT and hyperscript builds children
  // before their parent, so a row's parts sit in the list BEFORE the row element. T-217 walked
  // back to the previous row; T-247 makes that wrong for the FIRST row (with no engine-listed
  // name in front of it, the walk ran all the way back through other sections and counted
  // their buttons). The slice is now the row's OWN subtree, in creation order, with the row
  // element last. Same helper shape and same results for every row that has parts.
  function voiceRowOf(list, name) {
    const isRow = function (e) { return e.props && String(e.props.className || '').split(/\s+/).indexOf('audio-play-voice-row') >= 0; };
    const idx = (list || []).findIndex(function (e) { return isRow(e) && ownTxt(e).indexOf(name) === 0; });
    if (idx < 0) return null;
    const row = list[idx];
    const inSubtree = new Set();
    (function walk(e) {
      if (!e || typeof e !== 'object') return;
      (Array.isArray(e) ? e : [].concat((e.props && e.props.children) || [])).forEach(function (k) {
        if (k == null || typeof k !== 'object') return;
        if (Array.isArray(k)) { walk(k); return; }
        if (k.props && !inSubtree.has(k)) { inSubtree.add(k); walk(k); }
      });
    })(row);
    const slice = (list || []).slice(0, idx).filter(function (e) { return inSubtree.has(e); });
    slice.push(row);
    return slice;
  }
  const chipTextsIn = function (list) {
    return withCls(list, 'audio-play-voice-chip').map(ownTxt);
  };
  // The ROW ELEMENT is the last element of the slice (children are built before parents).
  const rowText = function (slice) { return ownTxt((slice || [])[slice.length - 1]); };
  const btnIn = function (list, cls) {
    return (list || []).filter(function (e) { return e.type === 'button' && hasCls(e, cls); });
  };

  let t201_tree = null;
  await attempt('NO engine header line is rendered even though the host still sends engine_voices (was: "engine voices 3 across 1 endpoint(s) - listed HH:MM:SS" with the endpoint URL and /v1/audio/voices in its tooltip); the shelf line stays gone (T-247 contract change)', async function () {
    const m = mount201();
    await openAllSections(m.run, m.comp);
    const mark = m.run.rt.created.length;
    m.run.render(m.comp());
    t201_tree = m.run.rt.created.slice(mark);
    const head = withCls(t201_tree, 'audio-play-voice-engine-line');
    if (head.length !== 0) throw new Error('an engine header line is still rendered: ' + ownTxt(head[0]));
    if (withCls(t201_tree, 'audio-play-voice-engine').length) throw new Error('the engine header block is still rendered');
    const all = t201_tree.map(ownTxt).join(' ');
    if (/engine voices/.test(all)) throw new Error('engine-voice wording is still on screen: ' + all.slice(0, 120));
    if (t201_tree.some(function (e) { return /\/v1\/audio\/voices/.test(String((e.props && e.props.title) || '')); })) throw new Error('a tooltip still points at GET /v1/audio/voices');
    if (withCls(t201_tree, 'audio-play-voice-shelf-line').length) throw new Error('a shelf header line is still rendered');
    if (withCls(t201_tree, 'audio-play-voice-shelf').length) throw new Error('the shelf header block is still rendered');
  });

  await attempt('exactly ONE voice list, one row per name, no second list - 4 rows (was: 5, because a name an engine listed and the plugin had no entry for got its own row) (T-247 contract change)', function () {
    const lists = withCls(t201_tree, 'audio-play-voice-list');
    if (lists.length !== 1) throw new Error('voice list components: ' + lists.length);
    const rows = withCls(t201_tree, 'audio-play-voice-row');
    // The 4 registry names, and nothing else: the panel has no engine voice list to merge.
    if (rows.length !== 4) throw new Error('rows: ' + rows.length + ' (' + rows.map(ownTxt).join(' | ') + ')');
    const names = rows.map(function (e) { return ownTxt(e).split(' ')[0]; });
    if (new Set(names).size !== names.length) throw new Error('a name renders twice: ' + names.join(','));
    if (names.some(function (n) { return n.indexOf('bijan_0048') === 0; })) throw new Error('an engine-listed name with no registry entry still gets a row: ' + names.join(','));
    const all = t201_tree.map(ownTxt).join(' ');
    if (/Server voices/.test(all)) throw new Error('the "Server voices" block is still rendered');
    if (withCls(t201_tree, 'audio-play-voice-engine-error').length) throw new Error('an engine error line appeared with no engine read');
    if (withCls(t201_tree, 'audio-play-voice-engine-stale').length) throw new Error('a stale marker appeared with no engine read');
    if (statusAlarming(t201_tree)) throw new Error('a header alarm was invented: ' + statusText(t201_tree));
  });

  await attempt('a registry entry with no sample is GATED and carries no engine-name badge (was: "engine name only - dispatched by name" and SELECTABLE because an engine resolved the name) (T-247 contract change)', function () {
    const row = voiceRowOf(t201_tree, 'engine_only_voice');
    if (!row) throw new Error('the no-sample row is missing');
    const chips = chipTextsIn(row);
    if (chips.indexOf('not here') < 0) throw new Error('local_copy:false is not rendered: ' + chips.join(' | '));
    if (chips.indexOf('engine name') >= 0) throw new Error('registered_remote:true is still rendered as a badge: ' + chips.join(' | '));
    if (chips.some(function (t) { return t.indexOf('engine name only') >= 0; })) throw new Error('the engine-name reading is still rendered: ' + chips.join(' | '));
    if (chips.indexOf('no sample in the store \u2014 a clone has nothing to stage') < 0) throw new Error('the reading is missing: ' + chips.join(' | '));
    // T-426 (user ruling 2026-10-16): the origin chip is reserved for the EXCEPTION and says what it is —
    // "shelf import", not the bare word. A name imported while the shelf was the entity is the one origin a
    // person did not create here, and it is the only row that still carries the chip.
    if (chips.indexOf('shelf import') < 0) throw new Error('the exception origin chip (voice_origin:shelf) is missing: ' + chips.join(' | '));
    if (chips.indexOf('plugin') >= 0) throw new Error('the plugin provenance chip is back on a row where it states the default (T-426): ' + chips.join(' | '));
    if (!withCls(row, 'audio-play-voice-gated').length) throw new Error('a name nothing can resolve was still offered as a pick');
    const btns = (row || []).filter(function (e) { return e.type === 'button'; });
    // T-361 (user ruling 2026-10-14) adds ONE affordance to every voice row: the group editor button. It is
    // not a dispatch control, and a gated voice gets it too — a name nothing can stage can still be filed
    // under a group of the person's own.
    // RE-COUNT 2026-11-02 (T-683 read): T-679 (2026-10-28, operator's fallback mechanism) put a THIRD control on
    // every row that is in the registry, gated ones included — `audio-play-voice-fallback679`. The count below
    // names the controls that exist today; the intent of the count is unchanged, a row that grows a control
    // nobody asked for still fails here, it just has to say which one.
    if (btns.length !== 3) throw new Error('buttons on the row (delete + the T-361 group editor + the T-679 fallback expected): ' + btns.length);
    if (!btns.some(function (b) { return String((b.props || {}).className || '') === 'audio-play-voice-fallback679'; })) {
      throw new Error('the T-679 fallback control is missing on a gated voice: ' + btns.map(function (b) { return String((b.props || {}).className || b.children || ''); }).join(' | '));
    }
    if (!btns.some(function (b) { return String((b.props || {}).className || '') === 'audio-play-voice-group-edit361'; })) {
      throw new Error('the group editor is missing on a gated voice: ' + btns.map(function (b) { return String((b.props || {}).className || b.children || ''); }).join(' | '));
    }
    if (btnIn(row, 'audio-play-voice-pull').length) throw new Error('a pull button is still offered (T-217 removed voice_pull)');
    if (chips.some(function (t) { return t.indexOf('on shelf') >= 0 || t.indexOf('not on shelf') >= 0; })) throw new Error('a shelf chip is still rendered: ' + chips.join(' | '));
  });

  await attempt('T-354 CONTRACT CHANGE (user 2026-10-14, live panel: "too many tags — a here tag on every voice makes no sense"): a voice the store holds carries NO state tag; the fact rides in the hover and only the exception is badged', function () {
    const row = voiceRowOf(t201_tree, 'voy_janeway');
    if (!row) throw new Error('the row is missing');
    const chips = chipTextsIn(row);
    if (chips.indexOf('here') >= 0) throw new Error('a stored voice still carries a "here" tag: ' + chips.join(' | '));
    if (chips.indexOf('here \u2014 staged onto the endpoint at dispatch') >= 0) throw new Error('the reading chip is still on a stored voice: ' + chips.join(' | '));
    if (withCls(row, 'audio-play-voice-state').length !== 0) throw new Error('state chips on a stored voice: ' + withCls(row, 'audio-play-voice-state').map(ownTxt).join(' | '));
    if (chips.indexOf('no engine name') >= 0) throw new Error('registered_remote:false is still rendered as a badge: ' + chips.join(' | '));
    const tips = (row || []).map(function (e) { return String((e.props || {}).title || ''); }).join('\n');
    if (!/staged onto the endpoint at dispatch/.test(tips)) throw new Error('the row hover lost the local_copy fact: ' + chips.join(' | '));
    if (withCls(row, 'audio-play-voice-gated').length) throw new Error('a voice the store holds was gated');
    if (btnIn(row, 'audio-play-voice-pull').length) throw new Error('pull offered for a voice the store already has');
    const btns = (row || []).filter(function (e) { return e.type === 'button'; });
    // T-361: name select + the group editor + delete. T-448 (user 2026-10-15): "add 'existing' small play buttons
    // for all voice samples to instantly playing the actual voice sample file in the player but without adding a
    // playlist entry" — a fourth control, and this fixture IS a voice the store holds, so the sample control must
    // be here. The count is stated with the controls named, because a row that grew a control nobody asked for
    // should fail here too.
    // RE-COUNT 2026-11-02 (T-683 read): the fifth control is the T-679 fallback button (2026-10-28), which sits on
    // every row that is in the registry. The count below names the five that exist today.
    if (btns.length !== 5) throw new Error('buttons on the row (name select + the T-361 group editor + delete + the T-448 sample play + the T-679 fallback expected): ' + btns.length);
    if (!btns.some(function (b) { return String((b.props || {}).className || '').indexOf('audio-play-voice-fallback679') === 0; })) {
      throw new Error('the T-679 fallback control is missing on a stored voice: ' + btns.map(function (b) { return String((b.props || {}).className || b.children || ''); }).join(' | '));
    }
    const play448 = btnIn(row, 'audio-play-voice-play448');
    if (play448.length !== 1) throw new Error('the sample play control is missing or doubled on a stored voice: ' + play448.length);
    if (!/does NOT become a playlist row/.test(String((play448[0] || {}).props.title || '')))
      throw new Error('the sample control does not say it creates no playlist row');
    if (typeof (play448[0].props || {}).onClick !== 'function') throw new Error('the sample control is a decoration, not a control: ' + typeof (play448[0].props || {}).onClick);

  });
  await attempt('T-361 (user ruling 2026-10-14, live panel: "the group bound to the voice should be visible to agent and user for sorting of sample voices accordingly"): a filed voice carries its own group labels as chips on its row; a voice nobody filed carries none', function () {
    const row = voiceRowOf(t201_tree, 'voy_janeway');
    if (!row) throw new Error('the row is missing');
    const gchips = withCls(row, 'audio-play-voice-group361').map(ownTxt);
    if (gchips.join(' | ') !== 'star trek | bridge crew') throw new Error('the group chips on the row: ' + gchips.join(' | '));
    const gated = voiceRowOf(t201_tree, 'engine_only_voice');
    if (!gated) throw new Error('the unfiled row is missing');
    if (withCls(gated, 'audio-play-voice-group361').length !== 0) {
      throw new Error('a voice nobody filed still carries a group chip: ' + withCls(gated, 'audio-play-voice-group361').map(ownTxt).join(' | '));
    }
    const editOf = function (r) {
      return (r || []).filter(function (e) { return e.type === 'button' && String((e.props || {}).className || '') === 'audio-play-voice-group-edit361'; })[0];
    };
    const eFiled = editOf(row); const eBare = editOf(gated);
    if (!eFiled || !eBare) throw new Error('the group editor is missing on a row (filed or unfiled)');
    if (ownTxt(eFiled) !== 'groups') throw new Error('a filed voice should offer "groups", it says: ' + ownTxt(eFiled));
    if (ownTxt(eBare) !== 'grp +') throw new Error('an unfiled voice should offer "grp +", it says: ' + ownTxt(eBare));
    const gtips = (row || []).map(function (e) { return String((e.props || {}).title || ''); }).join('\n');
    if (!/voice_groups/.test(gtips)) throw new Error('the group chip does not name the route the label is stored on');
    if (!/changes nothing about how this voice dispatches/.test(gtips)) throw new Error('the group chip does not say what a group does NOT do');
  });

  await attempt('T-361: the group editor is a control that opens on the row and writes nothing by itself — no save control exists until it is opened', function () {
    const row = voiceRowOf(t201_tree, 'voy_janeway');
    const editBtn = (row || []).filter(function (e) { return e.type === 'button' && String((e.props || {}).className || '') === 'audio-play-voice-group-edit361'; })[0];
    if (!editBtn) throw new Error('no group editor on the row');
    if (typeof editBtn.props.onClick !== 'function') throw new Error('the group editor is not a control');
    if (t201_tree.filter(function (e) { return String((e.props || {}).className || '') === 'audio-play-voice-group-save361'; }).length) {
      throw new Error('a save control is on screen before the editor was opened');
    }
    if (t201_tree.filter(function (e) { return String((e.props || {}).className || '') === 'audio-play-voice-group-input361'; }).length) {
      throw new Error('a group text field is on screen before the editor was opened');
    }
    const etip = String((editBtn.props || {}).title || '');
    if (!/comma separated/.test(etip)) throw new Error('the group editor does not say how labels are written: ' + etip);
    if (!/stops existing/.test(etip)) throw new Error('the group editor does not say what clearing a label does: ' + etip);
  });

  await attempt('T-354: the stored voice row has no state chip at all, and nothing on it names registered_remote (T-247 left one flag; T-354 stops printing it when it is the normal case)', function () {
    const row = voiceRowOf(t201_tree, 'voy_doctor');
    if (!row) throw new Error('the row is missing');
    const chips = chipTextsIn(row);
    if (chips.indexOf('here') >= 0) throw new Error('flags: ' + chips.join(' | '));
    if (chips.indexOf('engine name') >= 0) throw new Error('the engine-name badge is still on a stored voice: ' + chips.join(' | '));
    const stateChip = withCls(row, 'audio-play-voice-state').map(ownTxt);
    if (stateChip.length !== 0) throw new Error('state chips on a stored voice: ' + stateChip.join(' | '));
    if (/registered_remote/.test(chips.join(' '))) throw new Error('a chip still names registered_remote: ' + chips.join(' | '));
    if (withCls(row, 'audio-play-voice-gated').length) throw new Error('a dispatchable voice was gated');
    if (btnIn(row, 'audio-play-voice-pull').length) throw new Error('pull offered for a voice the store already has');
    const dur = withCls(row, 'audio-play-voice-dur').map(ownTxt);
    if (dur.join('') !== '12.4 s') throw new Error('duration: ' + dur.join('|'));
  });

  await attempt('the gated rows are the ones with no sample (2 of 4), and each tooltip says why in the one fact that is left (T-247 contract change)', function () {
    const row = voiceRowOf(t201_tree, 'nowhere_voice');
    if (!row) throw new Error('the row is missing');
    const gated = withCls(row, 'audio-play-voice-gated');
    if (gated.length !== 1) throw new Error('gated spans: ' + gated.length);
    const tip = String(gated[0].props.title || '');
    if (tip.indexOf('no sample in the plugin voice store') < 0) throw new Error('gate tooltip: ' + tip);
    // U-18 (user 2026-10-13, 01:39): a hover is a user remark. The ticket ids (T-217 / T-247) and the field
    // name (local_copy) that used to sit in this tooltip are recorded in the code comments at the gate.
    if (/T-\d+|local_copy/.test(tip)) throw new Error('the gate hover carries an internal name again: ' + tip);
    if (tip.indexOf('no engine lists this name') >= 0) throw new Error('the gate tooltip still claims an engine list: ' + tip);
    if (chipTextsIn(row).indexOf('no sample in the store \u2014 a clone has nothing to stage') < 0) throw new Error('chips: ' + chipTextsIn(row).join(' | '));
    if (btnIn(row, 'audio-play-voice-pull').length) throw new Error('a pull button was offered for it');
    const gatedRows = withCls(t201_tree, 'audio-play-voice-gated').length;
    if (gatedRows !== 2) throw new Error('gated rows across the list (engine_only_voice + nowhere_voice expected): ' + gatedRows);
  });

  await attempt('T-217 through T-404 contract change (user 2026-10-15): a voice WITH a transcript carries NO text chip at all; only the ABSENCE of one is tagged. The provenance the T-217 chip used to print is now in the hover of the same span.', function () {
    const rd = voiceRowOf(t201_tree, 'voy_doctor');
    const rj = voiceRowOf(t201_tree, 'voy_janeway');
    const eo = voiceRowOf(t201_tree, 'engine_only_voice');
    if (!rd || !rj || !eo) throw new Error('rows missing');
    const refTips = function (row) {
      const out = [];
      (function walk(n) {
        if (!n) return;
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if (n.props && n.props.title !== undefined) out.push(String(n.props.title));
        if (n.props) walk(n.props.children);
      })(row);
      return out.join(' | ');
    };
    if (chipTextsIn(rd).indexOf('text: plugin') >= 0) throw new Error('the dropped "text: plugin" tag is back on voy_doctor: ' + chipTextsIn(rd).join(' | '));
    if (chipTextsIn(rj).indexOf('text: plugin') >= 0) throw new Error('the dropped "text: plugin" tag is back on voy_janeway: ' + chipTextsIn(rj).join(' | '));
    // chipTextsIn collects EVERY chip in the row (groups, engine marks), so the claim is about the text
    // chips specifically: neither the dropped tag nor the absence-warning may appear on a voice that has text.
    if (chipTextsIn(rd).indexOf('no text') >= 0) throw new Error('a voice with a transcript is tagged as missing one: ' + chipTextsIn(rd).join(' | '));
    if (chipTextsIn(rj).indexOf('no text') >= 0) throw new Error('a voice with a transcript is tagged as missing one: ' + chipTextsIn(rj).join(' | '));
    if (/reference_text_source:plugin/.test(refTips(rd)) === false) throw new Error('the hover no longer names where the transcript came from: ' + refTips(rd));
    if (/reference_text_source:plugin/.test(refTips(rj)) === false) throw new Error('the hover no longer names where the transcript came from: ' + refTips(rj));
    if (/reference_text_source:\(empty\)/.test(refTips(eo)) === false) throw new Error('the hover no longer names the empty answer: ' + refTips(eo));
    if (chipTextsIn(eo).indexOf('no text') < 0) throw new Error('engine_only text source: ' + chipTextsIn(eo).join(' | '));
    if (chipTextsIn(rd).indexOf('text: shelf') >= 0) throw new Error('a "text: shelf" chip is still rendered');
    if (!/Doctor who, continuing the mission\./.test(rowText(rd))) throw new Error('the transcript is not shown: ' + rowText(rd));
    if (!/captain log, stardate 49012/.test(rowText(rj))) throw new Error('the plugin transcript is not shown: ' + rowText(rj));
  });

  await attempt('an engine-listed name the plugin has no entry for renders NO row and NO "not in the plugin store" chip (was: it was NAMED on its own row, not hidden) (T-247 contract change)', function () {
    const row = voiceRowOf(t201_tree, 'bijan_0048');
    if (row) throw new Error('the engine-only name still has a row: ' + rowText(row));
    const all = t201_tree.map(ownTxt).join(' ');
    if (all.indexOf('not in the plugin store') >= 0) throw new Error('the "not in the plugin store" chip is still rendered');
    if (t201_tree.map(ownTxt).some(function (t) { return t.indexOf('bijan_0048') === 0; })) throw new Error('an engine-only name is still on screen');
  });

  await attempt('a host that reports a FAILED engine voice read renders no error line, no stale marker and no alarm, and the list is unchanged (was: the error was named verbatim and the answer marked STALE) (T-247 contract change)', async function () {
    const bad = Object.assign({}, ENGINE217, { error: 'voices list of http://10.0.0.10:8963 unreachable (curl exit 7)' });
    const m = mount201(bad);
    await openAllSections(m.run, m.comp);
    const mark = m.run.rt.created.length;
    m.run.render(m.comp());
    const tree = m.run.rt.created.slice(mark);
    const head = withCls(tree, 'audio-play-voice-engine-line');
    if (head.length !== 0) throw new Error('header lines: ' + head.length);
    if (withCls(tree, 'audio-play-voice-engine-stale').length) throw new Error('a stale marker is still painted');
    if (withCls(tree, 'audio-play-voice-engine-error').length) throw new Error('an engine error line is still painted');
    const allTxt = tree.map(ownTxt).join(' ');
    if (allTxt.indexOf('curl exit 7') >= 0 || allTxt.indexOf('unreachable') >= 0) throw new Error('a failed engine read is still narrated to the user');
    if (withCls(tree, 'audio-play-voice-row').length !== 4) throw new Error('the registry list changed with an engine answer: ' + withCls(tree, 'audio-play-voice-row').length);
    if (statusAlarming(tree)) throw new Error('a failed read was painted as a header alarm: ' + statusText(tree));
  });

  await attempt('a stale host that still sends `dropped` renders NO dropped line, and no engine header either (was: the engine header stayed and the dropped names were ignored) (T-247 contract change)', async function () {
    const staleHost = Object.assign({}, ENGINE217, { dropped: ['../escape', 'Bad Name'] });
    const m = mount201(staleHost);
    await openAllSections(m.run, m.comp);
    const mark = m.run.rt.created.length;
    m.run.render(m.comp());
    const tree = m.run.rt.created.slice(mark);
    if (withCls(tree, 'audio-play-voice-shelf-dropped').length) throw new Error('a dropped-names line is still rendered');
    if (withCls(tree, 'audio-play-voice-engine-line').length !== 0) throw new Error('an engine header came back with the stale block');
    if (withCls(tree, 'audio-play-voice-row').length !== 4) throw new Error('the stale block changed the row count: ' + withCls(tree, 'audio-play-voice-row').length);
  });

  await attempt('a PRE-T-217 host (no engine_voices, no local_copy) renders no header, no chips, no alarm, and ONE delete per entry - 2 rows, not 3 (was: the refresh_voices engine name added a third row) (T-247 contract change)', async function () {
    const legacyReg = {
      a: { ref_text: 'x', ref_wav: '/home/deepamp-test/.dsh/deepamp-audio/voices/a.wav', remote_wav: '/mnt/llama/audio.cpp/voices/registered/a.wav', remote_host: 'cpu1.test', created: 1, source: 'job ap-0254', ref_dur_s: 3, registered_remote: true },
      b: { ref_text: 'y', ref_wav: '/home/deepamp-test/.dsh/deepamp-audio/voices/b.wav', remote_wav: '', remote_host: '', created: 1, source: 'test', ref_dur_s: 2 },
    };
    const m = mountWith(function (url, opts) {
      const u = String(url);
      let body = { ok: true };
      if (/get_models/.test(u)) body = { ok: true, models: [{ id: 'm1', loaded: true, task: 'tts', family: 'voxcpm2', default_voice: true }] };
      else if (/voice_registry/.test(u)) body = { ok: true, voices: legacyReg };
      else if (/refresh_voices/.test(u)) body = { voices: ['bijan_0048'], server: ['bijan_0048'] };
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
    });
    await openAllSections(m.run, m.comp);
    const mark = m.run.rt.created.length;
    m.run.render(m.comp());
    const tree = m.run.rt.created.slice(mark);
    if (withCls(tree, 'audio-play-voice-engine').length) throw new Error('an engine header was invented for a host that reports none');
    if (withCls(tree, 'audio-play-voice-chip').length) throw new Error('provenance chips were invented for a host that reports no flags');
    if (withCls(tree, 'audio-play-alarm').length) throw new Error('an alarm was invented');
    const rows = withCls(tree, 'audio-play-voice-row');
    if (rows.length !== 2) throw new Error('legacy rows: ' + rows.length);
    if (rows.map(ownTxt).join(' ').indexOf('bijan_0048') >= 0) throw new Error('a refresh_voices name still reaches the Voices list');
    const dels = withCls(tree, 'audio-play-voice-del');
    if (dels.length !== 2) throw new Error('legacy delete buttons: ' + dels.length);
    if (btnIn(tree, 'audio-play-voice-pull').length) throw new Error('a pull button was invented');
    if (withCls(tree, 'audio-play-voice-gated').length) throw new Error('a legacy row was gated on a flag the host never sent');
  });

  await attempt('the list survives garbage (registry null / garbage / non-boolean flags), and VoiceEngineHeader is no longer a component at all (was: the header survived seven engine shapes) (T-247 contract change)', function () {
    const fn = seen.get('AudioPlayerPanel').fn;
    const shapes = [
      { reg: null },
      { reg: {} },
      { reg: { c: { local_copy: 'yes', registered_remote: 1 } } },
      { reg: { c: { local_copy: true }, d: 'not-an-entry', e: null } },
    ];
    for (const p of shapes) shim.renderComponent(fn, p, { fresh: true, effects: false });
    if (seen.has('VoiceEngineHeader')) throw new Error('VoiceEngineHeader is still a registered component');
    const hfn = seen.get('VoiceList') && seen.get('VoiceList').fn;
    if (!hfn) throw new Error('VoiceList is gone - the removal took the list with it');
    for (const s of [null, undefined, 'x', [], {}, { hosts: null, names: null, error: null }, { error: 'boom', hosts: [null, 'ok'] }]) {
      shim.renderComponent(hfn, { reg: s }, { fresh: true, effects: false });
    }
    const bad = voidViolations(shim);
    if (bad.length) throw new Error(bad.length + ' void element(s) carry children, e.g. <' + bad[0].type + '> children=' + JSON.stringify(bad[0].props.children));
  });

  // T-247 PROOF 1 (the removal, on the wire AND on the screen): a full mount, every section
  // opened, and both voice selects opened through their fetch-on-open handlers must issue ZERO
  // requests to an engine voice list; the two plugin voice routes must HAVE been called (so the
  // zero is a removal, not a panel that fetched nothing); and names that exist ONLY inside a
  // stale engine answer - `server` names and `engine_voices.names` - must reach neither the
  // list nor the dropdown. That last part is what makes this check fail on a pre-T-247 client.
  await attempt('T-247: proof - ZERO engine voice-listing requests, both plugin voice routes still called, and a name that only an engine answer carries reaches neither the list nor the dropdown', async function () {
    const urls = [];
    const GHOST_ENGINE = {
      hosts: [{ url: 'http://10.0.0.10:8963', host: '10.0.0.10', count: 2,
        names: ['ghost_engine_voice', 'voy_doctor'], listed_at: 1727000100000 }],
      count: 2, names: ['ghost_engine_voice', 'voy_doctor'], listed_at: 1727000100000, error: '',
    };
    const ghostReg = { voy_doctor: REG217.voy_doctor };
    const m = mountWith(function (url, opts) {
      const u = String(url);
      urls.push(u);
      let body = { ok: true };
      if (/get_models/.test(u)) body = { ok: true, models: [{ id: 'm1', loaded: true, task: 'tts', family: 'voxcpm2', quant: 'bf16', default_voice: true, clone_required: false }] };
      else if (/voice_registry/.test(u)) body = { ok: true, voices: ghostReg, engine_voices: GHOST_ENGINE };
      else if (/refresh_voices/.test(u)) body = { ok: true, voices: [], server: ['ghost_server_voice'], builtins: [], engine_voices: GHOST_ENGINE };
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
    });
    await openAllSections(m.run, m.comp);
    m.run.render(m.comp());
    const tree = m.run.rt.created;
    const voiceSelects = tree.filter(function (e) {
      return e.type === 'select' && /voice list - opening re-checks|target voice from the clone registry/.test(String((e.props && e.props.title) || ''));
    });
    if (voiceSelects.length < 1) throw new Error('no voice select with a fetch-on-open handler was rendered');
    voiceSelects.forEach(function (e) {
      if (typeof e.props.onMouseDown === 'function') e.props.onMouseDown();
      if (typeof e.props.onFocus === 'function') e.props.onFocus();
    });
    await new Promise(function (r) { setImmediate(r); });
    await new Promise(function (r) { setImmediate(r); });
    const legs = urls.filter(function (u) { return /\/v1\/audio\/voices/.test(u); });
    if (legs.length) throw new Error('the panel requested an engine voice list: ' + legs.join(' | '));
    if (!urls.some(function (u) { return /voice_registry/.test(u); })) throw new Error('voice_registry was never called - the zero-request proof would be vacuous');
    if (!urls.some(function (u) { return /refresh_voices/.test(u); })) throw new Error('refresh_voices was never called - the zero-request proof would be vacuous');
    const rows = withCls(tree, 'audio-play-voice-row').map(ownTxt);
    const ghosts = ['ghost_server_voice', 'ghost_engine_voice'];
    const leakedRows = rows.filter(function (t) { return ghosts.some(function (g) { return t.indexOf(g) === 0; }); });
    if (leakedRows.length) throw new Error('an engine-only name reached the Voices list: ' + leakedRows.map(function (t) { return t.slice(0, 40); }).join(' | '));
    const opts = tree.filter(function (e) { return e.type === 'option'; }).map(ownTxt);
    const leakedOpts = opts.filter(function (t) { return ghosts.some(function (g) { return t.indexOf(g) >= 0; }); });
    if (leakedOpts.length) throw new Error('an engine-only name reached a dropdown: ' + leakedOpts.join(' | '));
    if (!rows.some(function (t) { return t.indexOf('voy_doctor') === 0; })) throw new Error('the registry row is missing too - the check would pass on an empty list: ' + rows.join(' | '));
  });

  // T-247 PROOF 2 (the badge): the string the badge was built from must not appear in any
  // rendered text or tooltip of the whole panel, for a host that STILL sends the flag.
  await attempt('T-247: proof - no rendered text or tooltip anywhere in the panel names registered_remote', async function () {
    const m = mount201();
    await openAllSections(m.run, m.comp);
    const mark = m.run.rt.created.length;
    m.run.render(m.comp());
    const tree = m.run.rt.created.slice(mark);
    const hits = [];
    tree.forEach(function (e) {
      const t = ownTxt(e);
      const tip = String((e.props && e.props.title) || '');
      if (t.indexOf('registered_remote') >= 0) hits.push('text: ' + t.slice(0, 80));
      if (tip.indexOf('registered_remote') >= 0) hits.push('tooltip: ' + tip.slice(0, 80));
    });
    if (hits.length) throw new Error('registered_remote is still on screen: ' + hits.join(' | '));
    if (withCls(tree, 'audio-play-voice-row').length !== 4) throw new Error('the badge proof ran against a list that is not the registry list: ' + withCls(tree, 'audio-play-voice-row').length);
  });


  console.log('\n--- 9. S-1 / T-210 / T-208 / T-212: the header word, the machine on every row, the machine ceiling, the missing transcript ---');

  const noop = function () {};
  const plProps = function (rows, registry) {
    return {
      playlist: rows, limit: 20, queues: null, registry: registry, play: noop, deleteJob: noop,
      cancel: noop, saveDesign: noop, playSrc: noop, playStem: noop, viewDiar: noop, retry: noop,
    };
  };
  const T210_REG = {
    tts: [{ id: 'e-1', fn: 'tts', url: 'http://cpu2.test:8963', route: 'speech', host: 'cpu2.test', enabled: true },
          { id: 'e-3', fn: 'tts', url: 'http://third.lan:8963', route: 'speech', host: 'third.lan', enabled: true }],
    stt: [{ id: 'e-2', fn: 'stt', url: 'http://cpu2.test:8962', route: 'speech', host: 'cpu2.test', enabled: true }],
  };

  await attempt('T-210: a PRIMARY placed row names its machine, and the lane label stays the lane name', function () {
    // The T-205a host shape: EVERY placed row carries endpoint_id / endpoint_url / host, the
    // first endpoint included, and its id is literally "primary".
    const rows = [
      { id: 'ap-0601', fn: 'tts', kind: 'tts', status: 'ok', text: 'first endpoint', created: 601,
        endpoint_id: 'primary', endpoint_url: 'http://cpu1.test:8963', endpoint_route: 'speech', host: 'cpu1.test', assigned_at: 1727000100000 },
      { id: 'ap-0602', fn: 'tts', kind: 'tts', status: 'ok', text: 'registered endpoint', created: 602,
        endpoint_id: 'e-1', endpoint_url: 'http://cpu2.test:8963', endpoint_route: 'speech', host: 'cpu2.test', assigned_at: 1727000101000 },
      { id: 'ap-0603', fn: 'stt', kind: 'stt', status: 'queued', text: 'not placed yet', created: 603,
        endpoint_pending: true, endpoint_id: '' },
    ];
    const mark = shim.rt.created.length;
    shim.renderComponent(seen.get('PlaylistPane').fn, plProps(rows, T210_REG), { fresh: true, effects: false });
    const tree = shim.rt.created.slice(mark);
    const tags = withCls(tree, 'audio-play-row-lane');
    const tagTxt = tags.map(ownTxt).sort();
    const tagTip = tags.map(function (e) { return String(e.props.title || ''); });
    // T-306 (user 2026-10-13, 04:31): "combine the TTSx tags into one - TTS as tagged while queued, and TTSx
    // with x as number for endpoint as soon as endpoint is assigned". The slot vocabulary is unchanged (the
    // primary is slot 1, entry N is N+2); what changed is that ONE tag carries it, on every row.
    if (tagTxt.join(' ') !== 'STT TTS1 TTS2') throw new Error('lane tags: ' + tagTxt.join(' | '));
    // Both placed rows still name the MACHINE - the primary row included, which rendered nothing here before -
    // in the tag's hover, where it costs the row no width.
    if (!tagTip.some(function (t) { return /TTS1/.test(t) && /cpu1\.test:8963/.test(t); })) {
      throw new Error('the first endpoint tag names no machine: ' + tagTip.join(' || ').slice(0, 200));
    }
    if (!tagTip.some(function (t) { return /TTS2/.test(t) && /cpu2\.test:8963/.test(t); })) {
      throw new Error('the registered endpoint tag names no machine: ' + tagTip.join(' || ').slice(0, 200));
    }
    // The unplaced row shows its lane with NO number, and the sentence the old chip used to print is its hover.
    const unTag = tags.filter(function (e) { return ownTxt(e) === 'STT'; })[0];
    if (!unTag) throw new Error('the unplaced row carries no lane tag');
    if (!/lane auto/.test(String(unTag.props.title)) || !/not refused/.test(String(unTag.props.title))) {
      throw new Error('the unplaced row tag hover: ' + String(unTag.props.title));
    }
    // The three separate marks T-306 replaced are gone, not merely rearranged.
    if (withCls(tree, 'audio-play-ep-badge').length !== 0) throw new Error('a machine chip is still on a row');
    if (withCls(tree, 'audio-play-ep-unassigned').length !== 0) throw new Error('an unassigned chip is still on a row');
    if (tree.some(function (e) { return hasCls(e, 'audio-play-ep-wait'); })) throw new Error('a wait chip appeared on a row that has none');
    // And the hover popup names the machine for the primary row too.
    const titles = tree.filter(function (e) { return e.props && typeof e.props.title === 'string'; }).map(function (e) { return e.props.title; });
    if (!titles.some(function (t) { return /endpoint: primary http:\/\/cpu1\.test:8963/.test(t); })) {
      throw new Error('the primary row hover popup names no endpoint');
    }
    if (!titles.some(function (t) { return /slot: TTS1/.test(t); })) throw new Error('the primary row hover popup names no slot');
  });

  // T-342 (user 2026-10-13 22:4x): "add a marker in the ui and a tag for the agent". Two live takes the
  // sweep wrote as OK and the user's ears threw away — vevo2 (ap-0186, "noise") and controlfoley q8_0
  // (ap-0188, "really bad noise, loud!") — are the fixture. The marker is set by a person or the agent
  // (POST job_flag), keyed by JOB ID, and it rides the answers that draw the rows. The wording is the
  // user's ruling: NOT "rejected", because "we might have been using them wrong".
  await attempt('T-342: a take judged by ear carries a marker chip on its own row, and an unmarked take carries none', function () {
    const rows = [
      { id: 'ap-0186', fn: 'tts', kind: 'task', task_kind: 'vc', status: 'ok', text: 'vevo2 spent 306 s on the kitchen window', created: 186,
        endpoint_id: 'e-3', endpoint_url: 'http://gpu1.test:8963', host: 'gpu1.test' },
      { id: 'ap-0188', fn: 'tts', kind: 'task', task_kind: 'gen', status: 'ok', text: 'controlfoley made loud bad noise', created: 188,
        endpoint_id: 'e-3', endpoint_url: 'http://gpu1.test:8963', host: 'gpu1.test' },
      { id: 'ap-0189', fn: 'tts', kind: 'tts', status: 'ok', text: 'nobody has listened to this one', created: 189,
        endpoint_id: 'e-3', endpoint_url: 'http://gpu1.test:8963', host: 'gpu1.test' },
    ];
    const p342 = plProps(rows, T210_REG);
    // RE-POINTED 2026-10-24: these stamps used to be 1 and 2, written at a time when a marker's age meant
    // nothing to the panel. T-342's guard now reads that age against the row's own creation time, so the fixture
    // stamps a marker AFTER the take was made - which is what a verdict by ear always is.
    p342.qualityFlags = {
      'ap-0186': { flag: 'noise', note: 'ap-0186 -> noise', ts: 1861 },
      'ap-0188': { flag: 'noise', note: 'the controlfoley@q8_0 result 0188 -> really bad noise, loud!', ts: 1881 },
    };
    const mark = shim.rt.created.length;
      shim.renderComponent(seen.get('PlaylistPane').fn, p342, { fresh: true, effects: false });
    const tree = shim.rt.created.slice(mark);
    const chips = withCls(tree, 'audio-play-row-qflag342');
    if (chips.length !== 2) throw new Error('the two marked rows do not each carry one marker chip: ' + chips.length);
    if (chips.map(ownTxt).sort().join(' ') !== 'noise noise') throw new Error('marker chip words: ' + chips.map(ownTxt).join(' | '));
    const tips = chips.map(function (e) { return String(e.props.title || ''); });
    if (!tips.some(function (t) { return /really bad noise, loud!/.test(t); }))
      throw new Error('the marker hover does not carry the words that were said about the take: ' + tips.join(' || ').slice(0, 180));
    if (!tips.every(function (t) { return /marked by ear, not by status/.test(t) && /request shape is the open question/.test(t); }))
      throw new Error('a marker hover does not say what a marker is: ' + tips.join(' || ').slice(0, 180));
    // Caution orange, not alarm red — a marker is a standing question to investigate, not an alarm.
    if (!chips.every(function (e) { return /f0883e/.test(String((e.props.style || {}).color || '')); }))
      throw new Error('a marker chip is not in the panel\u2019s caution colour: ' + chips.map(function (e) { return (e.props.style || {}).color; }).join(' | '));
    if (chips.some(function (e) { return /f85149/.test(String((e.props.style || {}).color || '')); }))
      throw new Error('a marker chip is painted as an alarm');
    // An unmarked take in a marked list gets nothing.
    const rowIds = withCls(tree, 'audio-play-row-id').map(ownTxt);
    if (rowIds.indexOf('ap-0189') < 0) throw new Error('the unmarked row is not on the list: ' + rowIds.join(' '));
    // And the panel is harmless against a host that does not know the verb yet (no qualityFlags at all).
    const mark2 = shim.rt.created.length;
    shim.renderComponent(seen.get('PlaylistPane').fn, plProps(rows, T210_REG), { fresh: true, effects: false });
    if (withCls(shim.rt.created.slice(mark2), 'audio-play-row-qflag342').length !== 0)
      throw new Error('the panel invented markers for a host that sent none');
  });

  await attempt('T-342 guard (operator, live panel 2026-10-24, verbatim: "ap-0188 sounds good, the noise marker makes no sense to be displayed \u2026 why would we want to tag a new current file like ap-0188 with noise ?"): a marker is drawn only on a row that already existed when the marker was made', function () {
    // THE LIVE SHAPE, ROW FOR ROW. Today ap-0186 is a diar answer and ap-0188 a music take, both created
    // 2026-10-23, and both wore a marker stamped 2026-10-13 about takes of an EARLIER store generation that
    // happened to carry those two ids: the ids were reissued by a store rebuild, the marker table was not.
    // So the marker PREDATES the row wearing it, and a verdict written ten days before a take existed is not a
    // verdict about that take.
    const born634g = 1792791881207;   // 2026-10-23 21:44 UTC - the diar row the operator asked about
    const stampOld634g = 1791927579920; // 2026-10-13 21:39 UTC - ten days before either row came into being
    const rowsG634 = [
      { id: 'ap-0186', fn: 'stt', kind: 'diar', status: 'ok', text: 'a diar answer nobody has listened to', created: born634g,
        endpoint_id: 'primary', endpoint_url: 'http://cpu1.test:8962', host: 'cpu1.test' },
      { id: 'ap-0188', fn: 'tts', kind: 'task', task_kind: 'gen', status: 'ok', text: 'the music take made from a preset', created: born634g + 157556,
        endpoint_id: 'e-11', endpoint_url: 'http://cpu2.test:8963', host: 'cpu2.test' },
      { id: 'ap-0187', fn: 'tts', kind: 'task', task_kind: 'gen', status: 'ok', text: 'its sibling, judged by ear a minute after it finished', created: born634g - 400000,
        endpoint_id: 'primary', endpoint_url: 'http://cpu1.test:8962', host: 'cpu1.test' },
    ];
    const pG634 = plProps(rowsG634, T210_REG);
    pG634.qualityFlags = {
      'ap-0186': { flag: 'noise', note: 'ap-0186 -> noise', ts: stampOld634g },
      'ap-0188': { flag: 'noise', note: 'the controlfoley@q8_0 result 0188 -> really bad noise, loud!', ts: stampOld634g },
      'ap-0187': { flag: 'clipped', note: 'said about THIS take, one minute after it finished', ts: born634g - 300000 },
    };
    const markG634 = shim.rt.created.length;
      shim.renderComponent(seen.get('PlaylistPane').fn, pG634, { fresh: true, effects: false });
    const chipsG634 = withCls(shim.rt.created.slice(markG634), 'audio-play-row-qflag342');
    if (chipsG634.length !== 1) throw new Error('the two stale markers are still being painted on rows they were never about: ' + chipsG634.map(ownTxt).join(' | '));
    if (ownTxt(chipsG634[0]) !== 'clipped') throw new Error('the chip that survived is not the one made about a live row: ' + ownTxt(chipsG634[0]));
    if (!/said about THIS take, one minute after it finished/.test(String(chipsG634[0].props.title || '')))
      throw new Error('the surviving chip does not carry its own note: ' + String(chipsG634[0].props.title || '').slice(0, 160));
    // HIDING, NOT DELETING, AND ONLY WITH PROOF. A marker with no stamp, or a row whose own creation time the
    // panel cannot read, is still drawn: the rule suppresses a marker only when it can show the marker was
      // written before this row existed, and a render is not the place to throw a person's verdict away.
    const rowsU634 = [
      { id: 'ap-0200', fn: 'tts', kind: 'tts', status: 'ok', text: 'a row whose age the panel cannot read', endpoint_id: 'primary',
        endpoint_url: 'http://cpu1.test:8962', host: 'cpu1.test' },
      { id: 'ap-0201', fn: 'tts', kind: 'tts', status: 'ok', text: 'a row carrying a marker with no stamp on it', created: born634g, endpoint_id: 'primary',
        endpoint_url: 'http://cpu1.test:8962', host: 'cpu1.test' },
    ];
    const pU634 = plProps(rowsU634, T210_REG);
    pU634.qualityFlags = {
      'ap-0200': { flag: 'quiet', note: 'the row carries no creation time, so nothing is suppressed', ts: stampOld634g },
      'ap-0201': { flag: 'quiet', note: 'the marker carries no stamp, so nothing is suppressed', ts: 0 },
    };
    const markU634 = shim.rt.created.length;
      shim.renderComponent(seen.get('PlaylistPane').fn, pU634, { fresh: true, effects: false });
    const chipsU634 = withCls(shim.rt.created.slice(markU634), 'audio-play-row-qflag342');
    if (chipsU634.length !== 2) throw new Error('the guard suppressed a marker it cannot prove is stale: ' + chipsU634.length + ' chips of 2 rows');
    // SOURCE SHAPE: the guard is an age comparison between the marker's stamp and the row's own creation time,
    // written where the chip is drawn. It calls no verb - a render that hides a marker must not be a render that
    // clears one, and the marker table stays the host's to hold.
    const srcG634 = require('fs').readFileSync(TARGET, 'utf8');
    if (!/qf342\.ts > 0 && j\.created > 0 && qf342\.ts < j\.created/.test(srcG634))
      throw new Error('the guard is not the age comparison it claims to be');
    const guardLine634 = (srcG634.match(/if \(qf342\.ts > 0 && j\.created > 0 && qf342\.ts < j\.created\) return null;/) || [''])[0];
    if (!guardLine634) throw new Error('the guard could not be isolated in the source');
    if (/call\(|job_flag_clear/.test(guardLine634)) throw new Error('the guard reaches for a verb: a render hides a marker, it does not clear one');
  });

  await attempt('T-345: the row the player is showing is lit in the list, and no other row is', function () {
    const rows = [
      { id: 'ap-0186', fn: 'tts', kind: 'tts', status: 'ok', text: 'a take that finished earlier', created: 186,
        endpoint_id: 'e-3', endpoint_url: 'http://gpu1.test:8963', host: 'gpu1.test' },
      { id: 'ap-0188', fn: 'tts', kind: 'tts', status: 'ok', text: 'the take the player is showing right now', created: 188,
        endpoint_id: 'e-3', endpoint_url: 'http://gpu1.test:8963', host: 'gpu1.test' },
      { id: 'ap-0189', fn: 'tts', kind: 'tts', status: 'ok', text: 'another finished take', created: 189,
        endpoint_id: 'e-3', endpoint_url: 'http://gpu1.test:8963', host: 'gpu1.test' },
    ];
    const p345 = plProps(rows, T210_REG);
    p345.playing = 'ap-0188';
    const mark = shim.rt.created.length;
    shim.renderComponent(seen.get('PlaylistPane').fn, p345, { fresh: true, effects: false });
    const tree = shim.rt.created.slice(mark);
    const lit = withCls(tree, 'audio-play-row-lit345');
    if (lit.length !== 1) throw new Error('the highlight lit ' + lit.length + ' rows; exactly the playing row may light');
    // The RIGHT row: rowTitle() starts with the job id, so the lit row is identifiable by its own hover.
    if (String(lit[0].props.title || '').indexOf('ap-0188') !== 0)
      throw new Error('the lit row is not the playing row: ' + String(lit[0].props.title || '').slice(0, 60));
    const ls = lit[0].props.style || {};
    if (!/58a6ff/.test(String(ls.borderLeft || ''))) throw new Error('the lit row carries no accent bar: ' + JSON.stringify(ls));
    if (!/16233d/.test(String(ls.background || ''))) throw new Error('the lit row carries no background tint: ' + JSON.stringify(ls));
    if (!/NOW PLAYING/.test(String(lit[0].props.title || ''))) throw new Error('the lit row does not say why it is lit');
    // T-373 (user 2026-10-14, live panel): "now i see the 'playing' Tag in the playlist - we already have two
    // highlighting by background for that, no extra tag needed". The highlight stays; the TAG is gone. The pin
    // is now the reverse of the T-345 one on purpose: the row must say it is playing without a chip.
    if (withCls(tree, 'audio-play-row-playing345').length !== 0) throw new Error('a separate playing tag is back on the lit row');
    // Its id column is lit too, and it is the ONLY id column painted blue.
    const ids = withCls(tree, 'audio-play-row-id');
    const blue = ids.filter(function (e) { return /58a6ff/.test(String((e.props.style || {}).color || '')); });
    if (blue.length !== 1) throw new Error(blue.length + ' id columns are lit; expected 1 of ' + ids.length);
    // A list with no playing item lights nothing, and a playing id that is not on the list lights nothing.
    const mark2 = shim.rt.created.length;
    shim.renderComponent(seen.get('PlaylistPane').fn, plProps(rows, T210_REG), { fresh: true, effects: false });
    const t2 = shim.rt.created.slice(mark2);
    if (withCls(t2, 'audio-play-row-lit345').length !== 0)
      throw new Error('the panel lit rows while nothing was playing');
    const p345b = plProps(rows, T210_REG);
    p345b.playing = 'ap-9999';
    const mark3 = shim.rt.created.length;
    shim.renderComponent(seen.get('PlaylistPane').fn, p345b, { fresh: true, effects: false });
    const t3 = shim.rt.created.slice(mark3);
    if (withCls(t3, 'audio-play-row-lit345').length !== 0)
      throw new Error('the panel lit a row to match a play item that is not on the list');
  });

  await attempt('T-330 / T-363 (user ruling 2026-10-14): the row wears NO heard chip any more — the heard fact rides the row hover, and the take title\u2019s own green is what dims', function () {
    const rows = [
      { id: 'ap-0186', fn: 'stt', kind: 'task', task_kind: 'diar', status: 'ok', text: 'a diar row: only its source is listenable', created: 186,
        endpoint_id: 'e-5', endpoint_url: 'http://cpu1.test:8962', host: 'cpu1.test' },
      { id: 'ap-0188', fn: 'tts', kind: 'tts', status: 'ok', text: 'a take with output, source and stems', created: 188,
        endpoint_id: 'e-5', endpoint_url: 'http://cpu1.test:8963', host: 'cpu1.test', stems: [{ id: 'vocal', path: '/x/vocal.wav' }] },
      { id: 'ap-0189', fn: 'tts', kind: 'tts', status: 'ok', text: 'nothing has been played from this row', created: 189,
        endpoint_id: 'e-5', endpoint_url: 'http://cpu1.test:8963', host: 'cpu1.test' },
      { id: 'ap-0190', fn: 'tts', kind: 'tts', status: 'queued', text: 'a queued row the panel once played a stem of', created: 190,
        endpoint_id: 'e-5', endpoint_url: 'http://cpu1.test:8963', host: 'cpu1.test' },
    ];
    const p330 = plProps(rows, T210_REG);
    p330.heard = {
      'ap-0186': { src: 1791900000000 },
      'ap-0188': { out: 1791900001000, src: 1791900002000, 'stem:vocal': 1791900003000 },
      'ap-0190': { 'stem:vocal': 1791900004000 },
    };
    const mark = shim.rt.created.length;
    shim.renderComponent(seen.get('PlaylistPane').fn, p330, { fresh: true, effects: false });
    const tree = shim.rt.created.slice(mark);
    if (withCls(tree, 'audio-play-row-heard346').length !== 0)
      throw new Error('a heard chip is on a row after T-363 removed it');
    const tips = tree.filter(function (e) { return /HEARD IN THIS PANEL/.test(String((e.props || {}).title || '')); });
    if (tips.length !== 3) throw new Error('rows whose hover names what this panel heard: ' + tips.length + ', expected 3 of 4 (0186, 0188, 0190)');
    const bigTip = tips.filter(function (e) { return /the processed output/.test(String(e.props.title)); })[0];
    if (!bigTip) throw new Error('no row hover names the processed output');
    ['the processed output', 'the original source', 'stem vocal', 'THIS panel played', 'reload clears it'].forEach(function (w) {
      if (String(bigTip.props.title).indexOf(w) < 0) throw new Error('the row hover does not say: ' + w);
    });
    const mains = withCls(tree, 'audio-play-row-main');
    const mainOf = function (txt) { return mains.filter(function (e) { return ownTxt(e).indexOf(txt) === 0; })[0]; };
    const dimmed = mains.filter(function (e) { return (e.props.style || {}).opacity === 0.62; });
    if (dimmed.length !== 2) throw new Error('dimmed take titles: ' + dimmed.length + ', expected 2 — only the rows whose title IS the ok green');
    if (!mainOf('a diar row') || !mainOf('a take with output')) throw new Error('the dimmed titles are not the two rows they should be');
    const qrow = mainOf('a queued row');
    if (!qrow) throw new Error('the queued fixture row is missing from the list');
    if (qrow.props.style.opacity === 0.62) throw new Error('a queued row (its title is the queued blue, not the ok green) was dimmed anyway');
    const un = mainOf('nothing has been played');
    if (!un) throw new Error('the unheard fixture row is missing from the list');
    if (un.props.style.opacity === 0.62) throw new Error('a row this panel never played was dimmed');
    if (tips.filter(function (e) { return String(e.props.title).indexOf('nothing has been played') >= 0; }).length !== 0)
      throw new Error('the panel claimed a heard fact for a row it never played');
    const mark2 = shim.rt.created.length;
    shim.renderComponent(seen.get('PlaylistPane').fn, plProps(rows, T210_REG), { fresh: true, effects: false });
    const tree2 = shim.rt.created.slice(mark2);
    if (withCls(tree2, 'audio-play-row-heard346').length !== 0) throw new Error('the panel invented heard chips the panel never made');
    if (tree2.filter(function (e) { return /HEARD IN THIS PANEL/.test(String((e.props || {}).title || '')); }).length !== 0)
      throw new Error('with no heard state in its props the panel still claimed one in the hover');
    if (withCls(tree2, 'audio-play-row-main').some(function (e) { return (e.props.style || {}).opacity === 0.62; }))
      throw new Error('with no heard state the panel still dimmed a title');
  });

  await attempt('T-210: an UNPLACED row still shows only the unassigned chip (no invented machine, no invented lane)', function () {
    const rows = [
      { id: 'ap-0610', fn: 'tts', kind: 'tts', status: 'queued', text: 'auto, waiting', created: 610, endpoint_pending: true, endpoint_id: '' },
      { id: 'ap-0611', fn: 'tts', kind: 'tts', status: 'queued', text: 'pinned, parked', created: 611, endpoint_id: 'e-1', endpoint_wait: { id: 'e-1', url: 'http://cpu2.test:8963' } },
      { id: 'ap-0612', fn: 'tts', kind: 'tts', status: 'queued', text: 'machine full', created: 612, machine_wait: { host: 'cpu2.test', job_id: 'ap-0601' } },
    ];
    const mark = shim.rt.created.length;
    shim.renderComponent(seen.get('PlaylistPane').fn, plProps(rows, T210_REG), { fresh: true, effects: false });
    const tree = shim.rt.created.slice(mark);
    const tags2 = withCls(tree, 'audio-play-row-lane');
    const tagTxt2 = tags2.map(ownTxt).sort();
    // The parked PIN shows its slot (it was chosen at submit) even though it is not placed; an auto row
    // waiting for any slot and a machine_wait row show the lane with NO number - no endpoint, no claim.
    if (tagTxt2.join(' ') !== 'TTS TTS TTS2') throw new Error('lane tags: ' + tagTxt2.join(' | '));
    // And the numberless tags name no machine, because the host named none.
    const tips2 = tags2.filter(function (e) { return ownTxt(e) === 'TTS'; }).map(function (e) { return String(e.props.title || ''); });
    if (tips2.length !== 2 || tips2.some(function (t) { return /:\d{4}/.test(t); })) {
      throw new Error('a machine was invented for a row the host never placed: ' + tips2.join(' || '));
    }
    if (withCls(tree, 'audio-play-ep-badge').length !== 0) throw new Error('a machine chip was invented for a row the host never placed');
    if (withCls(tree, 'audio-play-ep-unassigned').length !== 0) throw new Error('the old unassigned chip is still being rendered');
    const waits = withCls(tree, 'audio-play-ep-wait').map(ownTxt).sort();
    if (waits.length !== 2) throw new Error('wait chips: ' + waits.join(' | '));
    // T-307 (user 2026-10-13, 06:02): "now it looks like every playlist item has 2 rows". A wait chip used to
    // claim its whole sentence as its hypothetical width - "machine cpu2.test at cap" is around 120px of text
    // nothing could shrink - and a wrapping flex line is packed by hypothetical sizes BEFORE shrinking is
    // considered, so the chip itself is what pushed the row onto a second line. Every amber chip on a row is
    // capped at 132px now and ellipsised, and the whole sentence stays where it already was: its hover.
    withCls(tree, 'audio-play-ep-wait').forEach(function (e) {
      const st = e.props.style || {};
      if (st.maxWidth !== '132px' || st.whiteSpace !== 'nowrap' || st.textOverflow !== 'ellipsis' || st.minWidth !== 0)
        throw new Error('a wait chip can still claim its full text width: ' + JSON.stringify(st));
      if (typeof e.props.title !== 'string' || !e.props.title.length)
        throw new Error('a capped wait chip has no hover holding the whole sentence');
    });
  });

  // T-349 (T-278 queue visibility, built 2026-10-14). The host has written WHY a queued row is not
  // starting since T-198 (endpoint_wait.paused_by), T-236 (endpoint_wait.probing) and T-244
  // (lane_wait {paused_by, reason, fn}). The panel read the ids but not the reasons: "waits on e-10"
  // and "the lane is paused, so nothing in it is starting" looked identical on screen.
  await attempt('T-349: a row parked by a LANE pause says the lane is paused, names who paused it, and is not mistaken for a row waiting its turn', function () {
    const rows = [
      { id: 'ap-0630', fn: 'tts', kind: 'tts', status: 'queued', text: 'lane paused by a person', created: 630,
        endpoint_pending: true, lane_wait: { paused_by: 'operator', reason: '', fn: 'tts' } },
      { id: 'ap-0631', fn: 'stt', kind: 'stt', status: 'queued', text: 'lane paused by the plugin', created: 631,
        endpoint_pending: true, lane_wait: { paused_by: 'auto_pause', reason: 'engine failed twice in a row', fn: 'stt' } },
    ];
    const mark = shim.rt.created.length;
    shim.renderComponent(seen.get('PlaylistPane').fn, plProps(rows, T210_REG), { fresh: true, effects: false });
    const tree = shim.rt.created.slice(mark);
    const chips = withCls(tree, 'audio-play-lane-wait');
    if (chips.length !== 2) throw new Error('lane-pause chips: ' + chips.length);
    const labels = chips.map(ownTxt).sort().join(' | ');
    if (labels !== 'stt lane paused | tts lane paused') throw new Error('lane chip labels: ' + labels);
    const tips = chips.map(function (e) { return String(e.props.title || ''); });
    if (!tips.some(function (t) { return /a person paused it/.test(t) && /QUEUED and waiting/.test(t) && !/repeated engine failures/.test(t); }))
      throw new Error('an operator lane pause is not named as a person\u2019s own pause: ' + tips.join(' || '));
    const autoTip = tips.filter(function (t) { return /repeated engine failures/.test(t); });
    if (autoTip.length !== 1 || !/engine failed twice in a row/.test(autoTip[0]))
      throw new Error('the auto pause does not name itself, or its reason text is dropped: ' + tips.join(' || '));
    // Red for the pause something BROKE, amber for the pause a person chose (the panel's colour rule).
    const colours = chips.map(function (e) { return (e.props.style || {}).color; }).sort().join(' ');
    if (colours !== '#d29922 #f85149') throw new Error('lane-pause chip colours: ' + colours);
    // T-307 still holds: a chip on a row is capped and ellipsised, and the whole sentence lives on the hover.
    chips.forEach(function (e) {
      const st = e.props.style || {};
      if (st.maxWidth !== '132px' || st.whiteSpace !== 'nowrap' || st.textOverflow !== 'ellipsis' || st.minWidth !== 0)
        throw new Error('a lane-pause chip can claim its full text width: ' + JSON.stringify(st));
    });
    // And the panel invents nothing: a lane-paused row gets the lane chip ONLY. No endpoint wait, no machine wait.
    if (withCls(tree, 'audio-play-ep-wait').length !== 0) throw new Error('a lane-paused row also got an endpoint or machine wait chip');
  });

  // T-372 (user bug report 2026-10-14, live panel): "the badge in playlist items 'tts_lane_paused' seems to be
  // stuck after i unpaused the playlist". The host stamps a park reason on a QUEUED row and re-decides it on
  // every pump pass, but the pump only walks rows whose status is 'queued' (lib/index.js:4096) and no terminal
  // path clears what the row carried — so an aborted / cancelled / finished row can keep `lane_wait` in the
  // saved playlist, and the panel used to print it regardless. The chip's own sentence says the row IS queued,
  // so printing it on a row that stopped waiting is the panel contradicting itself.
  await attempt('T-372: a park chip is printed only while the row is still queued — a row that left the queue does not wear a wait it stopped having', function () {
    const parked372 = function (statuses372) {
      return [
        { id: 'ap-0700', fn: 'tts', kind: 'tts', status: statuses372[0], text: 'parked behind a paused lane', created: 700,
          lane_wait: { paused_by: 'operator', reason: 'pause_fn', fn: 'tts' } },
        { id: 'ap-0701', fn: 'tts', kind: 'tts', status: statuses372[1], text: 'parked behind an auto pause', created: 701,
          lane_wait: { paused_by: 'auto_pause', reason: 'engine failed twice in a row', fn: 'tts' } },
        { id: 'ap-0702', fn: 'tts', kind: 'tts', status: statuses372[2], text: 'parked on a paused endpoint', created: 702,
          endpoint_wait: { held_by: 'operator', id: 'e-1' } },
        { id: 'ap-0703', fn: 'tts', kind: 'tts', status: statuses372[3], text: 'parked at the host cap and probing', created: 703,
          machine_wait: { id: 'cpu2.test', why: 'at the host cap' }, endpoint_boot_wait: { id: 'e-2', url: 'http://gpu1.test:8963', reason: 'probing' } },
      ];
    };
    const look372 = function (statuses372) {
      const mark372 = shim.rt.created.length;
      shim.renderComponent(seen.get('PlaylistPane').fn, plProps(parked372(statuses372), T210_REG), { fresh: true, effects: false });
      const tree372 = shim.rt.created.slice(mark372);
      return {
        lane: withCls(tree372, 'audio-play-lane-wait').map(ownTxt).sort().join(' | '),
        park: withCls(tree372, 'audio-play-ep-wait').length,
      };
    };
    // Still queued: every reason the host wrote is printed. This is the positive control — the gate must not
    // simply hide the chips, or the fix would read as the panel refusing to say anything at all.
    const q372 = look372(['queued', 'queued', 'queued', 'queued']);
    if (q372.lane !== 'tts lane paused | tts lane paused') throw new Error('queued rows lost their lane chips: ' + JSON.stringify(q372));
    if (q372.park !== 3) throw new Error('queued rows lost their endpoint / machine / boot wait chips: ' + JSON.stringify(q372));
    // Left the queue: nothing is printed, because the chip sentence says the row IS queued and waiting, and a
    // cancelled / aborted / played-out row is none of those.
    const gone372 = look372(['cancelled', 'aborted', 'ok', 'error']);
    if (gone372.lane !== '' || gone372.park !== 0) throw new Error('a row that left the queue still wears a wait chip: ' + JSON.stringify(gone372));
    // Mixed list: only the row still parked is allowed to say it is waiting.
    const mix372 = look372(['queued', 'cancelled', 'ok', 'error']);
    if (mix372.lane !== 'tts lane paused' || mix372.park !== 0) throw new Error('a mixed list printed the wrong waits: ' + JSON.stringify(mix372));
  });


  await attempt('T-349 + T-503: a parked PIN names why its endpoint cannot take it (the plugin is holding it, a person is holding it, or it is still probing)', function () {
    const rows = [
      { id: 'ap-0640', fn: 'tts', kind: 'tts', status: 'queued', text: 'pinned to a plugin-paused endpoint', created: 640,
        endpoint_id: 'e-10', endpoint_pinned: true, endpoint_wait: { id: 'e-10', url: 'http://gpu1.test:8963', held_by: 'plugin', hold_reason: 'auto-paused after 3 connection failures (current streak 3)' } },
      { id: 'ap-0641', fn: 'tts', kind: 'tts', status: 'queued', text: 'pinned to a paused endpoint', created: 641,
        endpoint_id: 'e-5', endpoint_pinned: true, endpoint_wait: { id: 'e-5', url: 'http://cpu1.test:8963', held_by: 'operator', hold_reason: 'taken out of placement by hand' } },
      { id: 'ap-0642', fn: 'tts', kind: 'tts', status: 'queued', text: 'pinned, reason unknown', created: 642,
        endpoint_id: 'e-1', endpoint_pinned: true, endpoint_wait: { id: 'e-1', url: 'http://cpu2.test:8963' } },
      { id: 'ap-0643', fn: 'tts', kind: 'tts', status: 'queued', text: 'pinned, being probed', created: 643,
        endpoint_id: 'e-6', endpoint_pinned: true, endpoint_wait: { id: 'e-6', url: 'http://cpu1.test:8962', probing: true } },
    ];
    const mark = shim.rt.created.length;
    shim.renderComponent(seen.get('PlaylistPane').fn, plProps(rows, T210_REG), { fresh: true, effects: false });
    const tree = shim.rt.created.slice(mark);
    const chips = withCls(tree, 'audio-play-ep-wait');
    if (chips.length !== 4) throw new Error('wait chips: ' + chips.length);
    // T-656 (2026-10-26, the operator's ruling "do 1 as overlay, but playlist row should be minimal/short -
    // 'TTSn' is ok"): the chip is SHORT and the machine rides the hover. e-1 is in this lane's registry, so its
    // chip says the slot word the rest of the panel already uses for it; e-10 / e-5 / e-6 are not in T210_REG, and
    // those chips still print the raw id, which is the only honest answer for a slot this registry does not name.
    if (chips.map(ownTxt).sort().join(' | ') !== 'waits on TTS2 | waits on e-10 | waits on e-5 | waits on e-6')
      throw new Error('wait chip labels: ' + chips.map(ownTxt).join(' | '));
    const tipOf = function (label) {
      const c = chips.filter(function (e) { return ownTxt(e) === 'waits on ' + label; })[0];
      return String(((c || {}).props || {}).title || '');
    };
    const t10 = tipOf('e-10'), t5 = tipOf('e-5'), t1 = tipOf('TTS2'), t6 = tipOf('e-6');
    // T-656: the overlay. The chip says TTS2; the hover says the same name the Endpoints row and the lane select
    // print, machine included, and keeps the registry id because a verb body names the slot by that id.
    if (!/TTS2: cpu2\.test \[id e-1\]/.test(t1))
      throw new Error('the derived name did not reach the hover of the chip that shortened itself: ' + t1);
    if (!/waiting on the endpoint you pinned: e-10 \u2014 http:\/\/gpu1\.test:8963/.test(t10))
      throw new Error('a slot this registry does not name lost its raw id: ' + t10);
    if (!/the plugin is holding that endpoint after its own failed reads/.test(t10) || !/not by you/.test(t10) || !/press enable/.test(t10))
      throw new Error('a plugin-paused endpoint is not named as one: ' + t10);
    if (!/a person took that endpoint out of placement/.test(t5) || /the plugin is holding/.test(t5))
      throw new Error('a person\u2019s pause is not named as one: ' + t5);
    // No reason from the host -> no invented reason on the hover. The sentence stays the T-198 one.
    if (/BY THE PLUGIN|a person paused it|probing its health/.test(t1))
      throw new Error('the panel invented a reason the host did not give: ' + t1);
    if (!/probing its health before it dispatches this row/.test(t6))
      throw new Error('the pre-dispatch probe is not named on the row it is holding: ' + t6);
  });

  await attempt('T-210: an endpoint_id the registry no longer lists keeps its id instead of getting an invented slot', function () {
    const rows = [
      { id: 'ap-0620', fn: 'tts', kind: 'tts', status: 'ok', text: 'vanished endpoint', created: 620,
        endpoint_id: 'e-9', endpoint_url: 'http://gone.lan:8963', host: 'gone.lan' },
    ];
    const mark = shim.rt.created.length;
    shim.renderComponent(seen.get('PlaylistPane').fn, plProps(rows, T210_REG), { fresh: true, effects: false });
    const tree = shim.rt.created.slice(mark);
    const tags3 = withCls(tree, 'audio-play-row-lane');
    if (tags3.length !== 1 || ownTxt(tags3[0]) !== 'e-9') throw new Error('lane tag: ' + tags3.map(ownTxt).join(' | '));
    // The tag keeps the id rather than inventing a slot, and the machine the host DID report still rides the
    // hover - provenance is not lost just because the slot vocabulary is.
    if (!/gone\.lan:8963/.test(String(tags3[0].props.title || ''))) {
      throw new Error('the tag hover drops the machine the host reported: ' + String(tags3[0].props.title));
    }
    if (withCls(tree, 'audio-play-ep-badge').length !== 0) throw new Error('a machine chip is still on a row');
  });

  // T-231 / T-236 (client half, 2026-10-06): the host now reports FOUR reasons a queued row is
  // parked — endpoint_pending, endpoint_wait, machine_wait, endpoint_slot_wait (its endpoint
  // already holds a running row: max_loaded_models=1) and endpoint_boot_wait (the endpoint is
  // not known to be serving, so the plugin probes /health before dispatching). The panel shows
  // all of them in the SAME amber wait vocabulary, and shows NOTHING for a key the host did
  // not write: the host half of T-231 / T-236 needs a harness restart that has not happened.
  console.log('\n--- 9b. T-231 / T-236: the two new park reasons on the row ---');

  await attempt('T-231: a row parked behind the row that holds its endpoint renders a chip naming the endpoint AND the holding job', function () {
    const rows = [
      { id: 'ap-1101', fn: 'tts', kind: 'tts', status: 'queued', text: 'endpoint already rendering', created: 1101,
        endpoint_id: 'e-1', endpoint_slot_wait: { id: 'e-1', url: 'http://cpu2.test:8963', job_id: 'ap-0601' } },
    ];
    const mark = shim.rt.created.length;
    shim.renderComponent(seen.get('PlaylistPane').fn, plProps(rows, T210_REG), { fresh: true, effects: false });
    const tree = shim.rt.created.slice(mark);
    const waits = withCls(tree, 'audio-play-ep-wait');
    if (waits.length !== 1) throw new Error('wait chips: ' + waits.map(ownTxt).join(' | '));
    // T-656 (2026-10-26): e-1 IS in T210_REG, so the chip carries the short slot word and the hover carries the
    // derived name with the id kept in brackets. A slot the registry does not name still prints the raw id (the
    // T-349 + T-503 scenario above pins that half).
    if (ownTxt(waits[0]) !== 'TTS2 slot busy') throw new Error('slot chip label: ' + ownTxt(waits[0]));
    const tip = String(waits[0].props.title || '');
    const NEED = ['endpoint TTS2: cpu2.test [id e-1]', 'http://cpu2.test:8963', 'already rendering ap-0601',
      // U-18: the engine field (max_loaded_models=1) left the hover; the rule it stated is still stated.
      'one job at a time on an engine', 'waits for that slot to free', 'a wait, not a failure and not a rejection'];
    const miss = NEED.filter(function (p) { return tip.indexOf(p) < 0; });
    if (miss.length) throw new Error('slot chip tooltip misses: ' + miss.join(' | ') + '  <<' + tip + '>>');
    // The chip is a WAIT chip: same class as the pin / machine waits, and the row popup names
    // the holder too.
    const titles = tree.filter(function (e) { return e.props && typeof e.props.title === 'string'; }).map(function (e) { return e.props.title; });
    if (!titles.some(function (t) { return /waits for endpoint TTS2: cpu2\.test \[id e-1\] http:\/\/cpu2\.test:8963 \(held by ap-0601/.test(t); })) {
      throw new Error('row hover popup names no holder: ' + titles.join(' | ').slice(0, 200));
    }
    const bad = voidViolations(shim);
    if (bad.length) throw new Error(bad.length + ' void element(s) carry children');
  });

  await attempt('T-236: a row parked behind an endpoint that is not known to be serving names the endpoint and the reason in operator words', function () {
    const REASONS = { probing: 'probe in flight', offline: 'engine not answering', stale: 'last probe stale', unknown: 'status unknown', in_flight: 'request in flight' };
    const rows = Object.keys(REASONS).map(function (r, i) {
      return { id: 'ap-11' + (20 + i), fn: 'tts', kind: 'tts', status: 'queued', text: 'boot wait ' + r, created: 1120 + i,
        endpoint_id: 'e-3', endpoint_boot_wait: { id: 'e-3', url: 'http://third.lan:8963', reason: r, health_error: 'connect ECONNREFUSED 10.0.0.14:8963' } };
    });
    const mark = shim.rt.created.length;
    shim.renderComponent(seen.get('PlaylistPane').fn, plProps(rows, T210_REG), { fresh: true, effects: false });
    const tree = shim.rt.created.slice(mark);
    const waits = withCls(tree, 'audio-play-ep-wait');
    if (waits.length !== 5) throw new Error('boot chips: ' + waits.map(ownTxt).join(' | '));
    // T-656: e-3 is the second tts slot of T210_REG, so every boot chip carries its short slot word and every
    // tooltip carries the derived name with the id kept in brackets.
    const want = Object.keys(REASONS).map(function (r) { return 'TTS3 ' + REASONS[r]; }).sort();
    const got = waits.map(ownTxt).sort();
    if (got.join(' | ') !== want.join(' | ')) throw new Error('boot chip labels: ' + got.join(' | '));
    // Every boot tooltip says the plugin probes before it dispatches, and carries the raw error.
    const tips = waits.map(function (e) { return String(e.props.title || ''); });
    if (!tips.every(function (t) { return /endpoint TTS3: third\.lan \[id e-3\]/.test(t) && /not known to be serving/.test(t) && /probes its \/health before dispatching this row/.test(t) && /a wait, not a failure and not a rejection/.test(t); })) {
      throw new Error('boot tooltips: ' + tips.join(' || ').slice(0, 400));
    }
    if (!tips.every(function (t) { return /last probe error: connect ECONNREFUSED 10\.0\.0\.14:8963/.test(t); })) {
      throw new Error('a boot tooltip drops the raw health_error: ' + tips[0]);
    }
    // The raw error is TOOLTIP-ONLY: no rendered text may carry it.
    const txt = tree.map(ownTxt).join('\n');
    if (txt.indexOf('ECONNREFUSED') >= 0) throw new Error('the raw health_error is printed as text: ' + txt.slice(0, 200));
    // And the reason TOKEN never reaches the label.
    if (got.some(function (t) { return /in_flight|probing/.test(t); })) throw new Error('a raw reason token reached a chip: ' + got.join(' | '));
    const bad = voidViolations(shim);
    if (bad.length) throw new Error(bad.length + ' void element(s) carry children');
  });

  await attempt('T-231/T-236: a row with NONE of the park keys renders no wait chip at all (the not-yet-restarted host is unchanged)', function () {
    const rows = [
      { id: 'ap-1140', fn: 'tts', kind: 'tts', status: 'queued', text: 'placed and queued, no park key', created: 1140,
        endpoint_id: 'e-1', endpoint_url: 'http://cpu2.test:8963', endpoint_route: 'speech', host: 'cpu2.test' },
      { id: 'ap-1141', fn: 'tts', kind: 'tts', status: 'ok', text: 'done', created: 1141,
        endpoint_id: 'primary', endpoint_url: 'http://cpu1.test:8963', host: 'cpu1.test' },
      { id: 'ap-1142', fn: 'stt', kind: 'stt', status: 'queued', text: 'plain queued row', created: 1142 },
    ];
    const mark = shim.rt.created.length;
    shim.renderComponent(seen.get('PlaylistPane').fn, plProps(rows, T210_REG), { fresh: true, effects: false });
    const tree = shim.rt.created.slice(mark);
    if (withCls(tree, 'audio-play-ep-wait').length !== 0) {
      throw new Error('a wait chip appeared on rows that carry no park key: ' + withCls(tree, 'audio-play-ep-wait').map(ownTxt).join(' | '));
    }
    if (withCls(tree, 'audio-play-ep-unassigned').length !== 0) throw new Error('an unassigned chip was invented');
    // The placed rows still say WHICH slot rendered them, and the plain queued stt row says its lane with no
    // number - it has no endpoint and nothing is invented for it. The machine each slot means is in the hover.
    const tagTxt4 = withCls(tree, 'audio-play-row-lane').map(ownTxt).sort();
    if (tagTxt4.join(' ') !== 'STT TTS1 TTS2') throw new Error('lane tags: ' + tagTxt4.join(' | '));
    const tips4 = withCls(tree, 'audio-play-row-lane').map(function (e) { return String(e.props.title || ''); });
    if (!tips4.some(function (t) { return /cpu2\.test:8963/.test(t); }) || !tips4.some(function (t) { return /cpu1\.test:8963/.test(t); })) {
      throw new Error('a placed row names no machine in its tag hover: ' + tips4.join(' || ').slice(0, 200));
    }
  });

  await attempt('T-231/T-236: a park key with empty parts still renders its chip, never an empty or misleading one', function () {
    const rows = [
      { id: 'ap-1150', fn: 'tts', kind: 'tts', status: 'queued', text: 'slot wait, no job_id', created: 1150,
        endpoint_id: 'e-1', endpoint_slot_wait: { id: 'e-1', url: '', job_id: '' } },
      { id: 'ap-1151', fn: 'tts', kind: 'tts', status: 'queued', text: 'boot wait, unknown reason, no error', created: 1151,
        endpoint_id: 'e-1', endpoint_boot_wait: { id: 'e-1', url: '', reason: 'something_new', health_error: '' } },
      { id: 'ap-1152', fn: 'tts', kind: 'tts', status: 'queued', text: 'garbage keys', created: 1152,
        endpoint_id: 'e-1', endpoint_slot_wait: null, endpoint_boot_wait: null },
    ];
    const mark = shim.rt.created.length;
    shim.renderComponent(seen.get('PlaylistPane').fn, plProps(rows, T210_REG), { fresh: true, effects: false });
    const tree = shim.rt.created.slice(mark);
    const waits = withCls(tree, 'audio-play-ep-wait').map(ownTxt);
    if (waits.length !== 2) throw new Error('wait chips: ' + waits.join(' | '));
    if (waits.some(function (t) { return !t.trim(); })) throw new Error('an empty wait chip was rendered');
    // T-656: both chips of a slot the registry names carry the short slot word; the empty url on the WAIT key does
    // not undo that, because the name is read off the registry entry, not off the wait object.
    if (waits.indexOf('TTS2 slot busy') < 0) throw new Error('slot chip: ' + waits.join(' | '));
    // An unrecognised reason is not dropped and not invented away: it says what the host means.
    if (waits.indexOf('TTS2 not known to be serving') < 0) throw new Error('unknown-reason chip: ' + waits.join(' | '));
    const tips = withCls(tree, 'audio-play-ep-wait').map(function (e) { return String(e.props.title || ''); });
    if (tips.some(function (t) { return /last probe error:$/.test(t) || /last probe error: $/.test(t); })) throw new Error('a tooltip dangles on an empty health_error: ' + tips.join(' || '));
    if (tips.some(function (t) { return !t.trim(); })) throw new Error('a wait chip has no tooltip');
    const bad = voidViolations(shim);
    if (bad.length) throw new Error(bad.length + ' void element(s) carry children');
  });

  // T-223 (user request 1, 2026-10-06): the Machines block is REMOVED from the Endpoints
  // section — the "Machines · cap N job(s) per machine, 1 job per endpoint: ..." header, the
  // "machine ceiling N (…) · endpoint ceiling 1" line, and the per-machine rows with their
  // "N jobs · shared cap" chip. The two T-208 checks that used to drive MachinesPane directly
  // are re-anchored below to the NEW contract. The host data is untouched: the scripted host
  // still answers queue_status with `machines` (two jobs on one box) plus host_cap /
  // host_cap_source on every fn. The ceiling is now printed in ONE place only — the Settings
  // line, pinned in tests/ui_state.test.cjs ("T-208: the Settings line names the effective
  // cap and the lever that set it").
  const t223Reg = function (fn) {
    return { id: fn === 'stt' ? 'e-2' : 'e-1', fn: fn, url: 'http://cpu2.test:' + (fn === 'stt' ? '8962' : '8963'), route: 'speech', host: 'cpu2.test', enabled: true, batch_allowed: true, paused: false, models: ['m1', 'm2'], models_source: 'engine', models_at: 1727000000000, online: true, checked_at: 1727000100000, health_error: '' };
  };
  const t223Machines = {
    'cpu1.test': { host: 'cpu1.test', endpoints: [{ id: 'primary', url: 'http://cpu1.test:8963', route: 'speech', enabled: true, paused: false }], running_fns: ['tts'], shared_fns: ['tts', 'stt'], queued: 0, jobs: [{ id: 'ap-0700', fn: 'tts', model: 'm1', endpoint_id: 'primary' }] },
    'cpu2.test': { host: 'cpu2.test', endpoints: [{ id: 'e-1', url: 'http://cpu2.test:8963', route: 'speech', enabled: true, paused: false }, { id: 'e-2', url: 'http://cpu2.test:8962', route: 'speech', enabled: true, paused: false }], running_fns: ['tts', 'stt'], shared_fns: [], queued: 1, jobs: [{ id: 'ap-0701', fn: 'tts', model: 'm1', endpoint_id: 'e-1' }, { id: 'ap-0702', fn: 'stt', model: 's1', endpoint_id: 'e-2' }] },
  };
  // Open the Endpoints section the way a user does: its header click is what reads
  // queue_status, so the host's `machines` answer is really IN the panel state before the
  // absence is asserted. (Mount alone never reads queue_status.)
  const t223OpenEp = async function (queues) {
    const host = function (url) {
      const u = String(url);
      let body = { ok: true };
      if (/endpoint_registry/.test(u)) {
        const fn = /fn=stt/.test(u) ? 'stt' : 'tts';
        body = { ok: true, fn: fn, primary: { id: 'primary', fn: fn, url: 'http://cpu1.test:' + (fn === 'stt' ? '8962' : '8963'), route: 'speech', host: 'cpu1.test', enabled: true, batch_allowed: true, paused: false, online: true, checked_at: 1727000100000, health_error: '' }, endpoints: [t223Reg(fn)] };
      } else if (/queue_status/.test(u)) {
        body = { ok: true, queues: queues, machines: t223Machines, mgmt_disabled: {} };
      }
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
    };
    const m = mountWith(host);
    m.run.renderAndCommit(m.comp());
    await m.run.flush();
    const hdr = m.run.rt.created.filter(function (e) {
      return e.type === 'div' && typeof e.props.onClick === 'function' && ownTxt(e).indexOf('Endpoints') === 0;
    }).pop();
    if (!hdr) throw new Error('the Endpoints section header is missing');
    hdr.props.onClick();
    await m.run.flush();
    // T-400 (2026-10-15): this check also counts the panel's lane selects, one per fn. The STT form now lives in its
    // own section, which defaults CLOSED in the panel, and a closed section renders no body — so without opening it
    // here the count would read 1 and the check would pass on the tts side alone. A section this check never opened
    // is a section this check never measured.
    const t400SttHdr = m.run.rt.created.filter(function (e) {
      return e.type === 'div' && typeof e.props.onClick === 'function' && ownTxt(e).indexOf('STT (transcription)') === 0;
    }).pop();
    if (!t400SttHdr) throw new Error('the STT (transcription) section header is missing — T-400 moved the STT form into its own section');
    t400SttHdr.props.onClick();
    await m.run.flush();
    const mark = m.run.rt.created.length;
    m.run.render(m.comp());
    return { run: m.run, tree: m.run.rt.created.slice(mark) };
  };
  // The Endpoints section's OWN slice of the created list, as text + tooltips. Two things
  // make a plain subtree walk useless here: (1) the Settings section legitimately prints
  // "machine ceiling N · set by <lever>", and that line is NOT part of what T-223 removed;
  // (2) hyperscript evaluates h(Collapsible, …, h(MachinesPane, …)) eagerly, so a component's
  // OUTPUT only appears in rt.created when the walker invokes it — the machine rows are
  // separate entries, not descendants of the section element. The panel's children are walked
  // in order, so the section wrappers bracket the run of elements that belong to each one.
  const t223EpText = function (tree) {
    const heads = [];
    tree.forEach(function (e, i) {
      if (e.type === 'div' && e.props && e.props.className === 'audio-play-section') heads.push(i);
    });
    let start = -1;
    for (const i of heads) if (ownTxt(tree[i]).indexOf('Endpoints') === 0) start = i;
    if (start < 0) throw new Error('the Endpoints section is not in the rendered tree');
    let end = tree.length;
    for (const i of heads) if (i > start) { end = i; break; }
    const slice = tree.slice(start, end);
    let s = '';
    (function walk(n) {
      if (n == null) return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (typeof n === 'string' || typeof n === 'number') { s += String(n) + '\n'; return; }
      if (!n.props) return;
      s += String(n.props.title || '') + '\n';
      walk(n.props.children);
    })(slice);
    return s;
  };
  const T223_MACHINE_CLS = ['audio-play-machines', 'audio-play-machine-row', 'audio-play-machine-share',
    'audio-play-machine-cap', 'audio-play-machine-ceiling', 'audio-play-machine-jobs',
    'audio-play-machine-ids', 'audio-play-machine-host'];

  await attempt('T-208: the Endpoints section no longer prints the machine ceiling or the per-machine rows (T-223: machines block removed from Endpoints)', async function () {
    const shapes = [
      { q: { tts: { paused: false, running: null, queued: 1, slots: { max: 2, used: 1 }, host_cap: 1, host_cap_source: 'limit_one_per_host', limit_one_per_host: true }, stt: { paused: false, running: null, queued: 0, slots: { max: 2, used: 0 }, host_cap: 1, host_cap_source: 'limit_one_per_host', limit_one_per_host: true } } },
      { q: { tts: { paused: false, running: null, queued: 0, slots: { max: 2, used: 1 }, host_cap: 3, host_cap_source: 'env:DEEPAMP_MAX_JOBS_PER_HOST', limit_one_per_host: false }, stt: { paused: false, running: null, queued: 0, slots: { max: 2, used: 0 }, host_cap: 3, host_cap_source: 'env:DEEPAMP_MAX_JOBS_PER_HOST', limit_one_per_host: false } } },
      { q: { tts: { paused: false, running: null, queued: 0, slots: { max: 2, used: 1 }, host_cap: 1, host_cap_source: 'serialize_per_host', limit_one_per_host: false }, stt: { paused: false, running: null, queued: 0, slots: { max: 2, used: 0 }, host_cap: 1, host_cap_source: 'serialize_per_host', limit_one_per_host: false } } },
      { q: { tts: { paused: false, running: null, queued: 0, slots: { max: 2, used: 1 }, host_cap: 2, host_cap_source: 'default', limit_one_per_host: false }, stt: { paused: false, running: null, queued: 0, slots: { max: 2, used: 0 }, host_cap: 2, host_cap_source: 'default', limit_one_per_host: false } } },
      // A host old enough not to answer host_cap at all.
      { q: { tts: { paused: false, running: null, queued: 0, slots: { max: 2, used: 1 } }, stt: { paused: false, running: null, queued: 0, slots: { max: 2, used: 0 } } } },
      { q: null },
    ];
    for (const s of shapes) {
      const t = await t223OpenEp(s.q);
      const txt = t223EpText(t.tree);
      const PHRASES = ['Machines \u00B7 cap', 'machine ceiling', 'jobs \u00B7 shared cap', 'endpoint ceiling 1'];
      const still = PHRASES.filter(function (p) { return txt.indexOf(p) >= 0; });
      if (still.length) throw new Error('the Machines block is still rendered in the Endpoints section (host_cap ' + ((s.q && s.q.tts) || {}).host_cap + '): ' + still.join(' | '));
      const cls = T223_MACHINE_CLS.filter(function (c) { return withCls(t.tree, c).length; });
      if (cls.length) throw new Error('machine classes are still rendered: ' + cls.join(', '));
      // What the section must STILL have, unchanged by the removal.
      const prim = withCls(t.tree, 'audio-play-endpoint').length;
      const reg = withCls(t.tree, 'audio-play-ep-row').length;
      const slots = withCls(t.tree, 'audio-play-ep-queue').map(ownTxt);
      const addBtn = t.tree.filter(function (e) { return e.type === 'button' && ownTxt(e) === 'add endpoint'; }).length;
      if (prim !== 2 || reg !== 2) throw new Error('endpoint rows after the removal: primary ' + prim + ' registry ' + reg);
      // The q:null shape is a host that answers queue_status with nothing usable, so the lane
      // chips are legitimately absent there; every other shape answers slots for both fns.
      const wantSlots = (s.q && s.q.tts && s.q.tts.slots) ? 2 : 0;
      if (slots.length !== wantSlots) throw new Error('lane capacity chips after the removal: ' + slots.join(' | '));
      if (addBtn !== 1) throw new Error('the add-endpoint form is gone: ' + addBtn);
      const bad = voidViolations(t.run);
      if (bad.length) throw new Error(bad.length + ' void element(s) carry children');
    }
  });

  await attempt('T-208: host_cap no longer drives any cap chip, and the observed-jobs floor is printed nowhere (T-223: machines block removed from Endpoints)', async function () {
    // host_cap 1 while the host SHOWS two jobs on cpu2.test — the exact shape that used to
    // prove the panel prints the larger number. The host answer is unchanged; the panel now
    // prints none of it. The ENDPOINT ceiling still prints, from queues[fn].slots.
    const q1 = { tts: { paused: false, running: 'ap-0701', queued: 0, slots: { max: 2, used: 1 }, host_cap: 1, host_cap_source: 'limit_one_per_host', limit_one_per_host: true }, stt: { paused: false, running: 'ap-0702', queued: 0, slots: { max: 2, used: 1 }, host_cap: 1, host_cap_source: 'limit_one_per_host', limit_one_per_host: true } };
    const t = await t223OpenEp(q1);
    const caps = withCls(t.tree, 'audio-play-machine-cap').map(ownTxt);
    if (caps.length !== 0) throw new Error('cap chips still rendered: ' + caps.join(' | '));
    const share = withCls(t.tree, 'audio-play-machine-share').map(ownTxt);
    if (share.length !== 0) throw new Error('shared-cap chips still rendered: ' + share.join(' | '));
    const slots = withCls(t.tree, 'audio-play-ep-queue').map(ownTxt).sort().join(',');
    if (slots !== 'slots 1/2,slots 1/2') throw new Error('lane capacity chips: ' + slots);
    const txt = t223EpText(t.tree);
    if (txt.indexOf('shared cap') >= 0) throw new Error('a shared-cap line is still in the Endpoints section');
    if (txt.indexOf('ap-0701') >= 0 || txt.indexOf('ap-0702') >= 0) throw new Error('the per-machine job chips are still rendered');
  });

  // T-231 (client half): per-ENDPOINT occupancy, read off the queue_status answer this section
  // already makes (no new fetch, no new timer). queues[fn].endpoints = [{id,url,host,primary,
  // enabled,paused,running_job_id,running_fn,queued_rows}] — which row holds which engine, and
  // how many rows wait on it. Absent key = the live, not-yet-restarted host: nothing renders.
  console.log('\n--- 9c. T-231: per-endpoint occupancy in the Endpoints section ---');
  const t231Occ = function (extra) {
    const base = function (fn, occ) {
      const q = { paused: false, running: null, queued: 0, slots: { max: 2, used: 1 } };
      if (occ) q.endpoints = occ;
      return q;
    };
    return {
      tts: Object.assign(base('tts', extra ? [
        { id: 'primary', url: 'http://cpu1.test:8963', host: 'cpu1.test', primary: true, enabled: true, paused: false, running_job_id: 'ap-0701', running_fn: 'tts', queued_rows: 2 },
        { id: 'e-1', url: 'http://cpu2.test:8963', host: 'cpu2.test', primary: false, enabled: true, paused: false, running_job_id: null, running_fn: '', queued_rows: 1 },
      ] : null), { running: 'ap-0701', queued: 3 }),
      stt: Object.assign(base('stt', extra ? [
        { id: 'primary', url: 'http://cpu1.test:8962', host: 'cpu1.test', primary: true, enabled: true, paused: false, running_job_id: null, running_fn: '', queued_rows: 0 },
        { id: 'e-2', url: 'http://cpu2.test:8962', host: 'cpu2.test', primary: false, enabled: true, paused: false, running_job_id: 'ap-0702', running_fn: 'stt', queued_rows: 3 },
      ] : null), { running: 'ap-0702', queued: 3 }),
    };
  };
  // A row's OWN occupancy chips, read by walking the row element (rt.created is flat and
  // children-before-parent, so a slice of it would sweep in the neighbouring rows' spans).
  const t231RowOcc = function (el) {
    const out = [];
    (function walk(node) {
      if (node == null) return;
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (!node.props) return;
      if (hasCls(node, 'audio-play-ep-occup')) out.push(ownTxt(node));
      walk([].concat(node.props.children || []));
    })(el);
    return out;
  };

  await attempt('T-231: each endpoint row prints its own occupancy — the running row and the rows queued on it (queues[fn].endpoints)', async function () {
    const t = await t223OpenEp(t231Occ(true));
    const chips = withCls(t.tree, 'audio-play-ep-occup');
    if (chips.map(ownTxt).sort().join(' | ') !== '1 queued | ap-0701 running · 2 queued | ap-0702 running · 3 queued') {
      throw new Error('occupancy chips: ' + chips.map(ownTxt).join(' | '));
    }
    const rows = withCls(t.tree, 'audio-play-endpoint').concat(withCls(t.tree, 'audio-play-ep-row'));
    if (rows.length !== 4) throw new Error('endpoint rows: ' + rows.length);
    const bySlot = {};
    rows.forEach(function (r) { bySlot[ownTxt(r).slice(0, 4)] = t231RowOcc(r); });
    const want = { TTS1: 'ap-0701 running · 2 queued', TTS2: '1 queued', STT1: '', STT2: 'ap-0702 running · 3 queued' };
    const bad = Object.keys(want).filter(function (s) { return (bySlot[s] || []).join(',') !== want[s]; });
    if (bad.length) throw new Error('wrong occupancy on: ' + bad.map(function (s) { return s + '=' + (bySlot[s] || []).join(','); }).join(' | '));
    const tips = chips.map(function (e) { return String(e.props.title || ''); });
    // U-18: the chip used to print queue_status.queues.<fn>.endpoints - the path into the host answer. It
    // now says whose queue it is, in words a person reads.
    if (!tips.every(function (x) { return /this endpoint's own queue/.test(x); })) throw new Error('tooltips: ' + tips.join(' || ').slice(0, 300));
    if (tips.some(function (x) { return /queue_status|max_loaded_models/.test(x); })) throw new Error('a chip names an internal path again: ' + tips.join(' || ').slice(0, 200));
    if (!tips.filter(function (x, i) { return /running/.test(ownTxt(chips[i])); }).every(function (x) { return /one job at a time on an endpoint/.test(x); })) {
      throw new Error('a running-row tooltip omits the one-job-per-endpoint rule');
    }
    // The STT primary is idle in this answer: the panel claims nothing it was not told.
    if ((bySlot.STT1 || []).length !== 0) throw new Error('an idle endpoint got a chip: ' + bySlot.STT1.join(','));
    // And the removal from T-223 is still a removal: occupancy did not resurrect the Machines block.
    const cls = T223_MACHINE_CLS.filter(function (c) { return withCls(t.tree, c).length; });
    if (cls.length) throw new Error('occupancy reintroduced machine classes: ' + cls.join(', '));
    const bad2 = voidViolations(t.run);
    if (bad2.length) throw new Error(bad2.length + ' void element(s) carry children');
  });

  await attempt('T-231: with queues[fn].endpoints ABSENT the section renders no occupancy chip and names no job (the pre-T-231 host is unchanged)', async function () {
    const shapes = [t231Occ(false), null];
    for (const q of shapes) {
      const t = await t223OpenEp(q);
      const chips = withCls(t.tree, 'audio-play-ep-occup').map(ownTxt);
      if (chips.length !== 0) throw new Error('an occupancy chip appeared with no endpoints key: ' + chips.join(' | '));
      const txt = t223EpText(t.tree);
      if (txt.indexOf('ap-0701') >= 0 || txt.indexOf('ap-0702') >= 0) throw new Error('a job id was invented for a host that never named one');
      const rows = withCls(t.tree, 'audio-play-endpoint').length + withCls(t.tree, 'audio-play-ep-row').length;
      if (rows !== 4) throw new Error('endpoint rows: ' + rows);
      const bad = voidViolations(t.run);
      if (bad.length) throw new Error(bad.length + ' void element(s) carry children');
    }
  });

  // T-778 (WM-38 7(b), the half the panel owed T-764): an engine holding the inference of a row this
  // plugin no longer has is now named on the endpoint row that carries it. Same answer, no new fetch and
  // no new timer — the fixture is the T-231 occupancy array with the three keys T-764 added to one row.
  // The measured reason is 2026-11-09: the slot that refused ap-1298 and ap-1301 was holding the
  // inference of ap-1300, a row the plugin no longer had, and nothing on the lane could see it.
  console.log('\n--- 9d. T-778: the idle hold is named on its own endpoint row ---');
  const t778Run = async function (patch) {
    const q = t231Occ(true);
    q.stt.endpoints[0] = Object.assign({}, q.stt.endpoints[0], patch);
    const t = await t223OpenEp(q);
    const rows = withCls(t.tree, 'audio-play-endpoint').concat(withCls(t.tree, 'audio-play-ep-row'));
    const bySlot = {};
    rows.forEach(function (r) { bySlot[ownTxt(r).slice(0, 4)] = t231RowOcc(r); });
    const chips = withCls(t.tree, 'audio-play-ep-occup');
    return { t: t, bySlot: bySlot, chips: chips };
  };

  await attempt('T-778 (a): a slot holding a model with no row of mine on it gets a chip that says exactly that (holds_idle_model + idle_model)', async function () {
    const at = Date.now() - 45000;
    const r = await t778Run({ holds_idle_model: true, idle_model: ['qwen3-asr'], idle_model_at: at });
    if ((r.bySlot.STT1 || []).join(',') !== 'holds qwen3-asr with nothing on it') {
      throw new Error('the idle hold is not named on its row: ' + JSON.stringify(r.bySlot.STT1 || []));
    }
    // Additive, not a rewrite: the three rows the T-231 check pins are unchanged, word for word.
    const want = { TTS1: 'ap-0701 running · 2 queued', TTS2: '1 queued', STT2: 'ap-0702 running · 3 queued' };
    const bad = Object.keys(want).filter(function (s) { return (r.bySlot[s] || []).join(',') !== want[s]; });
    if (bad.length) throw new Error('the idle half moved an existing chip on: ' + bad.map(function (s) { return s + '=' + (r.bySlot[s] || []).join(','); }).join(' | '));
    if (r.chips.length !== 4) throw new Error('occupancy chips: ' + r.chips.length);
    // An inference nobody owns has no row id in it, and it is not a green "running" claim.
    if (/\dap-\d{4}\b/.test(r.bySlot.STT1[0])) throw new Error('the idle chip names a row the host did not name: ' + r.bySlot.STT1[0]);
    const styles = {};
    r.chips.forEach(function (c) { styles[ownTxt(c)] = String((c.props.style || {}).color || ''); });
    if (styles['holds qwen3-asr with nothing on it'] !== '#d29922') {
      throw new Error('the idle hold is not the warning colour: ' + JSON.stringify(styles));
    }
    if (styles['ap-0701 running · 2 queued'] !== '#3fb950') throw new Error('a running row lost its colour: ' + styles['ap-0701 running · 2 queued']);
    const tip = String((r.chips.filter(function (c) { return /holds qwen3-asr/.test(ownTxt(c)); })[0] || {}).props.title || '');
    if (!/reported qwen3-asr loaded on this slot while this plugin has no row on it/.test(tip)) throw new Error('the idle tooltip does not say what the engine reported: ' + tip.slice(0, 220));
    if (!/inference nobody owns/.test(tip) || !/unload <model>/.test(tip)) throw new Error('the idle tooltip omits the fact or the control that answers it: ' + tip.slice(0, 220));
    if (!/read .+ ago/.test(tip)) throw new Error('the read time carried on the row is not quoted as an age: ' + tip.slice(0, 240));
    // Every chip says what an empty list is NOT. That distinction is the whole reason the host key exists.
    const tips = r.chips.map(function (c) { return String(c.props.title || ''); });
    if (!tips.every(function (x) { return /never read what that engine holds/.test(x) && /not the claim that the engine is free/.test(x); })) {
      throw new Error('a chip omits the not-read-is-not-free caveat: ' + tips.join(' || ').slice(0, 300));
    }
    const bad2 = voidViolations(r.t.run);
    if (bad2.length) throw new Error(bad2.length + ' void element(s) carry children');
  });

  await attempt('T-778 (b): what the panel does NOT claim — no read time, no age; no flag, no chip; an empty list, no chip', async function () {
    const cases = [
      { patch: { holds_idle_model: true, idle_model: ['qwen3-asr'], idle_model_at: 0 }, want: 'holds qwen3-asr with nothing on it', why: 'a hold with no read time is still a hold' },
      { patch: { holds_idle_model: false, idle_model: ['qwen3-asr'], idle_model_at: 0 }, want: '', why: 'the host flag governs, not the list' },
      { patch: { holds_idle_model: true, idle_model: [], idle_model_at: 0 }, want: '', why: 'an empty list means not read, and the panel claims nothing about it' },
      { patch: { holds_idle_model: true, idle_model: [null, '', 7, 'real_model'], idle_model_at: 0 }, want: 'holds real_model with nothing on it', why: 'a list is filtered to names' },
    ];
    for (const c of cases) {
      const r = await t778Run(c.patch);
      const got = (r.bySlot.STT1 || []).join(',');
      if (got !== c.want) throw new Error(JSON.stringify(c.patch) + ' -> ' + JSON.stringify(got) + ' (' + c.why + ')');
      if (c.want && c.patch.idle_model_at === 0) {
        const tip = String((r.chips.filter(function (x) { return /holds /.test(ownTxt(x)); })[0] || {}).props.title || '');
        if (!/no read time was carried, so no age is claimed/.test(tip)) {
          throw new Error('an age was invented for a hold with no read time: ' + tip.slice(0, 240));
        }
      }
    }
  });

  await attempt('T-778 (c): more than one model is named compactly and capped at the four the host sends', async function () {
    const r = await t778Run({ holds_idle_model: true, idle_model: ['qwen3-asr', 'neutts2'], idle_model_at: Date.now() - 1000 });
    if ((r.bySlot.STT1 || []).join(',') !== 'holds qwen3-asr, neutts2 with nothing on it') {
      throw new Error('two held models are not both named: ' + JSON.stringify(r.bySlot.STT1 || []));
    }
    const r5 = await t778Run({ holds_idle_model: true, idle_model: ['m1', 'm2', 'm3', 'm4', 'm5'], idle_model_at: 0 });
    const txt = (r5.bySlot.STT1 || []).join(',');
    if (txt !== 'holds m1, m2, m3, m4 with nothing on it') throw new Error('the cap is not the host cap of four: ' + txt);
    if (/m5/.test(txt)) throw new Error('a fifth model leaked into the chip: ' + txt);
  });

  await attempt('T-231: garbage in queues[fn].endpoints renders nothing misleading (null / string / empty / id-less / unknown id)', async function () {
    const garbage = [null, 'x', [], [null], [{}], [{ id: 'primary', running_job_id: '', queued_rows: 0 }], [{ id: 'e-9', running_job_id: 'ap-9999', queued_rows: 4 }]];
    for (const g of garbage) {
      const q = t231Occ(true);
      q.tts.endpoints = g; q.stt.endpoints = g;
      const t = await t223OpenEp(q);
      const chips = withCls(t.tree, 'audio-play-ep-occup').map(ownTxt);
      if (chips.length !== 0) throw new Error(JSON.stringify(g) + ' produced chips: ' + chips.join(' | '));
      const txt = t223EpText(t.tree);
      if (txt.indexOf('ap-9999') >= 0) throw new Error('an unknown endpoint id leaked its job id into the section');
      const bad = voidViolations(t.run);
      if (bad.length) throw new Error(bad.length + ' void element(s) carry children');
    }
  });

  await attempt('T-212: the voice pick warns when the SELECTED voice has no transcript, and says nothing when it has one', function () {
    const base = Object.assign({}, seen.get('TtsBox').props);
    base.models = { tts: [{ id: 'm1', family: 'qwen3_tts', task: 'clon', clone_required: true }], stt: [], task: [] };
    base.selModel = { tts: 'm1', stt: '', task: '' };
    base.voices = { tts: ['voy_doctor_short'], stt: [] };
    base.selVoice = { tts: 'voy_doctor_short', stt: '' };
    base.onSelectVoice = noop; base.onModelChange = noop; base.onSelectLang = noop;
    // A non-empty text box: the Generate button's normal "nothing to say" disable must not
    // be confused with the T-212 rule (the warning must never disable dispatch).
    base.ttsText = 'a line to read aloud';
    base.voiceShelf = { host: 'cpu1.test', path: '/mnt/llama/audio.cpp/voices/registered', count: 1, names: ['voy_doctor_short'], listed_at: 1727000100000, error: '', dropped: [] };
    const shelf = function (refText, src) {
      return Object.assign({}, base, {
        voiceReg: { voy_doctor_short: { on_shelf: true, local_copy: true, voice_origin: 'shelf', reference_text: refText, reference_text_source: src, ref_dur_s: 4.2 } },
      });
    };
    // The live case: a WAV on the shelf, NO line in prompt_text.
    let mark = shim.rt.created.length;
    shim.renderComponent(seen.get('TtsBox').fn, shelf('', ''), { fresh: true, effects: false });
    let warn = withCls(shim.rt.created.slice(mark), 'audio-play-voice-no-ref').map(ownTxt);
    if (warn.length !== 1 || warn[0] !== 'no transcript for this voice') throw new Error('warning for a transcript-less voice: ' + warn.join(' | '));
    // It is a WARNING, not a block: the dispatch button is still there and still enabled.
    const gen = shim.rt.created.slice(mark).filter(function (e) { return e.type === 'button' && /^Generate/.test(ownTxt(e)); });
    if (gen.length !== 1) throw new Error('Generate button: ' + gen.length);
    if (gen[0].props.disabled === true) throw new Error('the warning disabled dispatch');

    mark = shim.rt.created.length;
    shim.renderComponent(seen.get('TtsBox').fn, shelf('the doctor said nothing at all', 'shelf'), { fresh: true, effects: false });
    warn = withCls(shim.rt.created.slice(mark), 'audio-play-voice-no-ref').map(ownTxt);
    if (warn.length !== 0) throw new Error('a voice WITH a transcript was warned about: ' + warn.join(' | '));

    mark = shim.rt.created.length;
    shim.renderComponent(seen.get('TtsBox').fn, shelf('plugin captured line', 'plugin'), { fresh: true, effects: false });
    warn = withCls(shim.rt.created.slice(mark), 'audio-play-voice-no-ref').map(ownTxt);
    if (warn.length !== 0) throw new Error('a plugin-sourced transcript was warned about: ' + warn.join(' | '));

    // A pre-T-200 host sends no reference_text_source at all: UNKNOWN, not broken, no warning.
    mark = shim.rt.created.length;
    shim.renderComponent(seen.get('TtsBox').fn, Object.assign({}, base, { voiceReg: { voy_doctor_short: { ref_text: '', ref_wav: 'x.wav' } } }), { fresh: true, effects: false });
    warn = withCls(shim.rt.created.slice(mark), 'audio-play-voice-no-ref').map(ownTxt);
    if (warn.length !== 0) throw new Error('the panel warned on a host that never reported reference_text_source: ' + warn.join(' | '));

    // A voice that is not a registry entry at all (engine-listed / built-in) is not judged.
    mark = shim.rt.created.length;
    shim.renderComponent(seen.get('TtsBox').fn, Object.assign({}, base, { voiceReg: {} }), { fresh: true, effects: false });
    warn = withCls(shim.rt.created.slice(mark), 'audio-play-voice-no-ref').map(ownTxt);
    if (warn.length !== 0) throw new Error('the panel warned about a voice it has no registry entry for');

    // No voice selected (a default-voice model) -> nothing to warn about.
    mark = shim.rt.created.length;
    shim.renderComponent(seen.get('TtsBox').fn, Object.assign({}, shelf('', ''), { selVoice: { tts: '', stt: '' } }), { fresh: true, effects: false });
    warn = withCls(shim.rt.created.slice(mark), 'audio-play-voice-no-ref').map(ownTxt);
    if (warn.length !== 0) throw new Error('the panel warned with no voice selected');
  });

  console.log('\n--- T-219: expanding a section never forces a horizontal scrollbar ---');
  // The user report (2026-10-06): "expanding any of the sections results in a horizontal
  // scrollbar to be visible -> small ui glitch to track". The culprit was the Collapsible
  // header's triangle span: its LAYOUT box is the glyph advance (6px) by the line box (14px),
  // and rotate(90deg) swaps them, so the PAINTED box was 14px wide and hung 4px past the
  // header row. The row is flush with the panel's content box and the panel body is the
  // panel's only scroll container, so 4px of paint is a horizontal bar - and only for OPEN
  // sections, which is exactly what was reported. Measured in Chromium on this tree: body
  // clientWidth 460 / scrollWidth 464, 26 offenders, every one of them that triangle.
  // These checks pin the shape that makes the overflow impossible.
  const openTree219 = async function () {
    const m = mountWith(function (url, opts) {
      const u = String(url);
      if (/storage_status/.test(u)) {
        const body = { ok: true, roots: [{ path: '/mnt/llama/tts', exists: true, writable: false, free_bytes: 536870912, total_bytes: 1099511627776, error: 'EACCES: permission denied, mkdir \'/home/deepamp-test/.dsh/deepamp-audio/out\' - a long host error string that has to wrap inside the panel, not widen it' }], low_space: true, low_space_bytes_threshold: 2147483648, checked_at: 1727000000000 };
        return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
      }
      return host201(url, opts);
    });
    await openAllSections(m.run, m.comp);
    const mark = m.run.rt.created.length;
    m.run.render(m.comp());
    return m.run.rt.created.slice(mark);
  };
  const styleOf = function (e) { return (e && e.props && e.props.style) || null; };

  await attempt('T-219: the rotated section triangle is boxed in a square, so an open section cannot overflow the panel (T-219: no horizontal overflow)', async function () {
    const tree = await openTree219();
    const sections = tree.filter(function (e) { return e.type === 'div' && hasCls(e, 'audio-play-section'); });
    // T-229 contract change: 9 sections -> 8. The "Tools (separation / sfx / vc / s2s)"
    // Collapsible is gone (its four kinds are selectable inside the TTS section as job
    // kinds; a dispatch_task row is already fn:'tts', lib/index.js:7545). Every check in
    // this attempt is the same check as before — the count it tracks is the new one, and
    // the next two lines pin that the removed title renders nowhere.
    // T-298 contract change (2026-10-12, user request 5.1): 8 -> 9. The "Scene (batch)"
    // composer is mounted (multi-speaker handling + text load/save in the panel). The checks
    // below are unchanged and now run over one MORE section container, so the new section has
    // to satisfy the same no-overflow rules as the eight it already had.
    // T-300 U-6 CONTRACT CHANGE (user request 2026-10-12): "Output save path can be integrated in
    // settings, to reduce menu surface". The Output section is not a section any more; its content is
    // the first block inside Settings, so the panel had 8 top-level sections (it was 8 before T-229,
    // 9 with the Scene section added in T-298, and 8 again now).
    // T-300 U-4 + U-5 CONTRACT CHANGE (user requests 2026-10-12): 8 -> 7. "TTS — models" and "STT —
    // models" are ONE "Models (library)" explorer, and the two text forms plus the batch composer are
    // ONE "Text and dialogue" section. T-356 CONTRACT CHANGE (user ruling 2026-10-14, live panel: "turn it
    // into 9 section : a new dynamic tab for the engine specific advanced options (temperature, ...) a new
    // multi-speaker-compose and display area for batch handling while keeping the existing TTS and STT box
    // focused on easy usage"): the batch composer and the two advanced blocks left "Text and dialogue" and
    // became two sections of their own.
    // T-400 CONTRACT CHANGE (2026-10-15, T-387 items 6-8, user ruling bundle A with "usually all are closed -
    // should just keep last state"): the STT pane left "Text and dialogue" for its own section, and three sections
    // were retitled. The order is now Playlist, Models, Voices, TTS/MUSIC/SFX, TTSD (multi-speaker batch),
    // Advanced (Options, Remux), STT (transcription), Auto-play Agent Session, Settings, Endpoints, Logs — eleven,
    // as retitled by T-432/T-433/T-434 on 2026-10-15 at the user's request for shorter headers. The titles this
    // line carried before were "Advanced (model options, mix, remux)", "Endpoints (TTS + STT)" and "Log (this page and the lane)".
    // and Auto-play Agent Session is the eleventh, built in change 2. The count is still asserted, not relaxed: a section
    // that disappears without this line moving is a section someone removed by accident.
    if (sections.length !== 11) throw new Error('sections in the open tree: ' + sections.length);
    if (tree.map(ownTxt).join('\n').indexOf('Tools (separation') >= 0) throw new Error('the removed Tools section is still titled somewhere in the open tree');
    // T-355 + T-356 + T-400: the ORDER of the sections is asserted, not only their number — an arrangement this
    // explicit should fail loudly when someone undoes it.
    // T-548 (user 2026-10-17, verbatim): "we should change the order of sections and move the 'Auto-play agent
    // session' section between TTS and TTSD". The order T-355 / T-356 / T-400 ruled is re-pointed to the order the
    // user ruled on 2026-10-17, and nothing else about it moved: the same eleven sections, still asserted by name and
    // still asserted to be in order, because an arrangement this explicit is exactly the thing that quietly undoes
    // itself. Auto-play now sits directly under the single-voice form and directly above the batch form, which is
    // where a person looking for "what speaks on its own" is standing when they ask.
    // (T-741 contract change) The ORDER list below is the one the operator ruled on 2026-11-07 for WM-31
    // item 6, verbatim: "Playlist HAS to be on top, 2. then models, 3. voices, 4. TTS -> in order of
    // 'selection while creating a job'". It replaces the order the same operator ruled on 2026-11-06 - "work
    // first, then output, then the machine" (T-740) - which had replaced the one T-548 ruled on 2026-10-17.
    // The operator named the first four positions and put the rest at "later"; the sections after those four
    // are in the arrangement they already had, so this list is the ruled four plus the unchanged tail, and the
    // row in `TODOS.md` says which half is ruled and which is not.
    // What this check IS has not changed at all: the same eleven sections, still asserted by name, still
    // asserted to be in order, because an arrangement this explicit is exactly the thing that quietly undoes
    // itself. The variable names carry 741 for the same reason the old ones carried 355 and 740.
    const order741 = ['Playlist', 'Models', 'Voices', 'TTS/MUSIC/SFX', 'TTSD (multi-speaker batch)',
      'STT (transcription)', 'Auto-play Agent Session', 'Advanced (Options, Remux)',
      'Settings', 'Endpoints', 'Logs'];
    const firstAt741 = function (label) {
      for (var i = 0; i < tree.length; i++) {
        if (tree[i].type === 'span' && ownTxt(tree[i]).indexOf(label) === 0) return i;
      }
      return -1;
    };
    const at741 = order741.map(firstAt741);
    if (at741.some(function (i) { return i < 0; })) {
      throw new Error('a section header is missing from the open tree: ' + order741.map(function (t, i) { return t + '=' + at741[i]; }).join(', '));
    }
    if (at741.some(function (i, k) { return k > 0 && i < at741[k - 1]; })) {
      throw new Error('section order is not the ruled one: ' + order741.map(function (t, i) { return t + '@' + at741[i]; }).join(' | '));
    }
    // 1. the section containers: minWidth 0, or a flex item keeps its min-content width.
    if (sections.some(function (e) { return !styleOf(e) || styleOf(e).minWidth !== '0'; })) {
      throw new Error('a .audio-play-section container has no minWidth:0');
    }
    // 2. the header rows (flex + space-between + a pointer cursor; the panel header is the
    //    same shape with cursor:move, so cursor is what separates them).
    const heads = tree.filter(function (e) {
      const s = styleOf(e);
      return e.type === 'div' && s && s.display === 'flex' && s.justifyContent === 'space-between' &&
        s.cursor === 'pointer' && s.userSelect === 'none';
    });
    if (heads.length !== sections.length) throw new Error('section header rows: ' + heads.length + ' vs ' + sections.length + ' sections');
    if (heads.some(function (e) { return styleOf(e).minWidth !== '0'; })) throw new Error('a section header row still has an automatic (min-content) minimum size');
    // 3. THE culprit, pinned as gone: a rotating element must be boxed in a square
    //    (width == height) and must not be squeezed by its row, or its rotated bounding box
    //    reaches past the row it is flush with.
    // T-413 (2026-10-15): the single right-hand triangle became a MIRRORED PAIR - \u25B8 left of the title pointing
    // inwards, \u25C2 right of the title pointing inwards; open, the left rotates +90deg and the right -90deg so both
    // end pointing DOWN. The guarantee this test exists for is unchanged and is now checked against twice as many
    // rotating elements: every rotating element must be boxed in a square (width == height) with flexShrink 0, or
    // its rotated bounding box reaches past the row it is flush with - which was T-219's horizontal scrollbar.
    const trisL = tree.filter(function (e) { return e.type === 'span' && ownTxt(e) === '\u25B8'; });
    const trisR = tree.filter(function (e) { return e.type === 'span' && ownTxt(e) === '\u25C2'; });
    if (trisL.length !== sections.length) throw new Error('left header arrows: ' + trisL.length + ' vs ' + sections.length + ' sections');
    if (trisR.length !== sections.length) throw new Error('right header arrows: ' + trisR.length + ' vs ' + sections.length + ' sections');
    const tris = trisL.concat(trisR);
    const bad = tris.filter(function (e) {
      const s = styleOf(e);
      return !s || !s.width || s.width !== s.height || s.flexShrink !== 0 || !/rotate\(/.test(String(s.transform || ''));
    });
    if (bad.length) throw new Error('a rotated header arrow is not boxed in a square: ' + JSON.stringify(bad[0].props.style));
    if (tris.some(function (e) { return String(e.props.className || '').indexOf('audio-play-section-head-arrow') < 0; })) throw new Error('a header arrow is not marked as one');
    const rotated = tree.filter(function (e) { const s = styleOf(e); return s && /rotate\(/.test(String(s.transform || '')); });
    if (rotated.length !== tris.length) throw new Error('rotating elements: ' + rotated.length + ' vs mirrored header arrows ' + tris.length);
    if (rotated.some(function (e) { const s = styleOf(e); return s.width !== s.height; })) throw new Error('a rotating element is wider than its own box (T-219: no horizontal overflow)');
    // The mirroring itself, in both states: opposite signs, so a closed pair points at each other and an open pair
    // points down together. A pair that rotated the same way would leave one arrow pointing up.
    if (trisL.some(function (e) { const t = String(styleOf(e).transform || ''); return t !== 'none' && t.indexOf('rotate(90deg)') < 0; })) throw new Error('a left header arrow does not rotate clockwise into the down position');
    if (trisR.some(function (e) { const t = String(styleOf(e).transform || ''); return t !== 'none' && t.indexOf('rotate(-90deg)') < 0; })) throw new Error('a right header arrow does not rotate counter-clockwise into the down position');
  });

  await attempt('T-219: the panel body scrolls vertically only, and the flex children that refused to shrink now wrap (T-219: no horizontal overflow)', async function () {
    const tree = await openTree219();
    const bodies = tree.filter(function (e) { const s = styleOf(e); return e.type === 'div' && s && s.maxHeight === '66vh'; });
    if (bodies.length !== 1) throw new Error('scroll containers in the panel: ' + bodies.length);
    const bs = styleOf(bodies[0]);
    if (bs.overflow != null) throw new Error('overflow:auto is still on the panel body: ' + bs.overflow);
    if (bs.overflowY !== 'auto' || bs.overflowX !== 'hidden') throw new Error('the panel body can still hand the panel a horizontal bar: ' + JSON.stringify(bs));
    if (bs.minWidth !== '0') throw new Error('the panel body cannot shrink inside the panel column');
    // The two measured offenders at a narrow panel: the storage error span (was flexShrink:0,
    // 397px of unshrinkable text) and the queue chips (min-content 327px, no wrap).
    const errSpan = tree.filter(function (e) { return e.type === 'span' && ownTxt(e).indexOf('EACCES') === 0; }).pop();
    if (!errSpan) throw new Error('the storage error span is missing - the offender cannot be checked');
    if (styleOf(errSpan).flexShrink === 0) throw new Error('the storage error span is still unshrinkable (flexShrink:0)');
    if (styleOf(errSpan).minWidth !== '0' || styleOf(errSpan).overflowWrap !== 'anywhere') throw new Error('the storage error span cannot wrap: ' + JSON.stringify(styleOf(errSpan)));
    const chips = tree.filter(function (e) {
      const s = styleOf(e);
      return e.type === 'span' && s && s.display === 'inline-flex' && s.borderRadius === '10px' && s.border === '1px solid #8884';
    });
    if (chips.length !== 2) throw new Error('queue chips: ' + chips.length);
    // T-311 CONTRACT CHANGE (user 2026-10-13): the chip no longer WRAPS, it SHRINKS. T-219's fault was a
    // chip whose 327px min-content forced the panel body sideways, and wrapping was that answer. The user
    // then asked for both chips on ONE line at the default width, which wrapping by definition cannot give.
    // The anti-overflow guarantee is NOT dropped, it is moved: the chip keeps minWidth:0 (it can still
    // shrink, so it still cannot force a horizontal bar), adds flex:0 1 auto and overflow:hidden (a shrink
    // clips inside the chip instead of painting past its rounded border), and the piece that gives way is
    // the build span - the one whose full text already lives on its hover - not the state word and not the
    // button. A chip that cannot shrink is still the bug T-219 was about, so minWidth:0 is still checked.
    if (chips.some(function (e) {
      const s = styleOf(e);
      return s.flexWrap !== 'nowrap' || s.minWidth !== '0' || s.overflow !== 'hidden' || s.flex !== '0 1 auto';
    })) throw new Error('a queue chip is not one shrinkable line: ' + JSON.stringify(styleOf(chips[0])));
    // T-626 RE-POINT (2026-10-21): the endpoint row now carries a SECOND monospace 9px ellipsis span — the
    // recorded engine build (BuildTag626). The style fingerprint matched it and this pin reported the wrong
    // span as "not the aggressive shrinker". The shrinker is now named by exclusion, and the build tag's own
    // anti-overflow guarantee is checked in its own block below, so the T-219 guarantee is not relaxed.
    const buildSpans = tree.filter(function (e) {
      const s = styleOf(e);
      return e.type === 'span' && s && s.fontFamily === 'monospace' && s.fontSize === '9px' && s.textOverflow === 'ellipsis'
        && !((e.props || {}).className === 'audio-play-ep-build626');
    });
    if (buildSpans.length === 0) throw new Error('no model@quant span to shrink - the chip would have to clip its own button');
    if (buildSpans.some(function (e) { const s = styleOf(e); return !(s.flexShrink >= 2) || s.minWidth !== 0 || s.whiteSpace !== 'nowrap' || s.overflow !== 'hidden'; }))
      throw new Error('the build span is not the aggressive shrinker: ' + JSON.stringify(styleOf(buildSpans[0])));
    // The row the user asked about: at the 484px default (no persisted size in this suite) both chips must
    // share ONE line. Below 420px of panel width the row is allowed to stack them instead of crushing both.
    // T-519 RE-POINT (2026-10-16), and it is a tightening, not a relaxation. This filter used to identify the
    // lane chip row by its style fingerprint. The Log section's new version row (T-519) legitimately uses the
    // same compact shape — 10px text, 8px gaps, flex — so the fingerprint matched two rows and .pop() picked the
    // wrong one: the pin reported "the lane row may wrap" about a row in another section. The row is now NAMED
    // (audio-play-lane-chip-row311) and the pin points at the name. Everything the pin asserts afterwards is
    // unchanged: one line at the default width (flexWrap:nowrap) and the ability to shrink (minWidth:0).
    const laneRow311 = tree.filter(function (e) {
      return e.type === 'div' && e.props && e.props.className === 'audio-play-lane-chip-row311';
    }).pop();
    if (!laneRow311) throw new Error('the lane chip row is missing (it is named now: audio-play-lane-chip-row311)');
    if (styleOf(laneRow311).flexWrap !== 'nowrap') throw new Error('the lane row may wrap at the default panel width: ' + JSON.stringify(styleOf(laneRow311)));
    if (styleOf(laneRow311).minWidth !== 0) throw new Error('the lane row cannot shrink inside the panel body');
  });

  console.log('\n--- T-220: the voice storage copy matches today\'s state and is shorter ---');
  // The user request (2026-10-06): "it looks like the voice storage still needs overhaul and
  // text fixes (remove outdated and streamline)". Outdated = presenting the shared shelf as
  // the authoritative store this plugin mirrors, and the empty-list / origin text that went
  // with it. Today: the plugin's own voice store is what this panel dispatches from (T-217),
  // a voice is a WAV plus its reference line, a clone uses the stored sample, and the shelf
  // listing is failing over ssh (T-218) and is on its way out. Copy only - the routes, the
  // ids, the chips (host flags), the confirms and the delete warnings are untouched.
  const voiceWords220 = async function () {
    const m = mount201();
    await openAllSections(m.run, m.comp);
    const mark = m.run.rt.created.length;
    m.run.render(m.comp());
    const tree = m.run.rt.created.slice(mark);
    return {
      tree: tree,
      all: tree.map(ownTxt).join('\n') + '\n' + tree.map(function (e) { return String((e.props && e.props.title) || ''); }).join('\n'),
    };
  };

  await attempt('T-220: the outdated voice-storage wording is gone from the panel (T-220: streamlined voice copy)', async function () {
    const v = await voiceWords220();
    const OUTDATED = [
      'single voice entity', 'local mirror', 'deprecated cache', 'no voice API',
      'shared voice store', 'not yet on the shared voice store', 'Voices (one list \u2014 shelf + plugin)',
      'press \u21BB to list the shelf', 'none registered on the server', 'auto-imported; no local sample',
      'pre-T-200 key', 'the shared voice shelf as this host last saw it',
    ];
    const still = OUTDATED.filter(function (p) { return v.all.indexOf(p) >= 0; });
    if (still.length) throw new Error('outdated voice-storage wording is still rendered: ' + still.join(' | '));
  });

  await attempt('the Voices section carries no explanatory paragraph at all, and the section itself is unchanged (T-220 streamlined voice copy) (T-223: section titled "Voices") (T-331 follow-up: the paragraph was removed)', async function () {
    const v = await voiceWords220();
    // T-331 follow-up (user 2026-10-13, 14:4x): "from Voices, also remove the text ... -> text can be removed in
    // general". The earlier contract here required the paragraph's sentences to be PRESENT; the user has now
    // ordered the paragraph gone, so the same sentences are asserted ABSENT. That is the assertion corrected in
    // place to the user's own words, not a check dropped: what the section must still do - be titled "Voices",
    // keep its one-row-per-voice layout, and keep spelling the host's own flag on the row - is asserted below,
    // unchanged, so removing copy cannot quietly remove a reading.
    const REMOVED = [
      'ONE row per voice name', 'A voice is a WAV plus its reference line', 'stored in the plugin voice store',
      'stages the stored sample onto the endpoint', 'does not ask an engine for its voice list',
      'an endpoint is asked for its MODELS',
    ];
    const present = REMOVED.filter(function (p) { return v.all.indexOf(p) >= 0; });
    if (present.length) throw new Error('the removed Voices paragraph is still rendering through: ' + present.join(' | '));
    const intro = v.tree.filter(function (e) { return e.type === 'div' && ownTxt(e).indexOf('ONE row per voice name.') === 0; }).pop();
    if (intro) throw new Error('the Voices section intro div is still mounted (' + ownTxt(intro).length + ' chars of prose in the working area)');
    // Streamlined, not renamed: the section is still the Voices section.
    // T-223 (user request 3): the title is now exactly "Voices". Re-anchored from the wording
    // added today ("Voices (one list)"); the row flags and the chip readings are the
    // same assertions as before.
    const titles = v.tree.filter(function (e) { return e.type === 'span' && ownTxt(e).indexOf('Voices') === 0; }).map(ownTxt);
    if (titles.indexOf('Voices') < 0) throw new Error('section titles: ' + titles.join(' | '));
    // The host's own flag is still spelled out on the row - removed copy does not mean a
    // lost reading (the T-201 contract, re-anchored on the one flag T-247 leaves).
    const row = voiceRowOf(v.tree, 'engine_only_voice');
    const chips = chipTextsIn(row);
    if (chips.indexOf('not here') < 0
      || chips.indexOf('no sample in the store \u2014 a clone has nothing to stage') < 0) {
      throw new Error('the streamlined row lost its flag reading: ' + chips.join(' | '));
    }
  });


  console.log('\n--- T-223: the Machines block is gone, the Log rows dropdown has "all", the Voices title is "Voices" ---');
  // The three new contracts the user asked for (2026-10-06), each pinned on its own so a
  // later edit that puts the block back, drops the "all" option, or renames the section
  // fails here with a named message rather than only in the re-anchored T-195/T-208 checks.

  await attempt('T-223: the Machines block is NOT rendered in the Endpoints section while the endpoint rows and chips are (T-223: machines block removed from Endpoints) (T-235 contract change: slot chips name the Primary)', async function () {
    const t = await t223OpenEp({ tts: { paused: false, running: 'ap-0701', queued: 1, slots: { max: 2, used: 1 }, host_cap: 2, host_cap_source: 'default', limit_one_per_host: false }, stt: { paused: false, running: null, queued: 0, slots: { max: 2, used: 1 }, host_cap: 2, host_cap_source: 'default', limit_one_per_host: false } });
    const txt = t223EpText(t.tree);
    // The exact phrases the user quoted, none of which may survive anywhere in the section.
    const PHRASES = [
      'Machines \u00B7 cap', 'job(s) per machine', 'machine ceiling', 'endpoint ceiling 1',
      'jobs \u00B7 shared cap', 'shared cap', 'idle 0 queued', 'serves tts+stt',
    ];
    const still = PHRASES.filter(function (p) { return txt.indexOf(p) >= 0; });
    if (still.length) throw new Error('still rendered in the Endpoints section: ' + still.join(' | '));
    const cls = T223_MACHINE_CLS.filter(function (c) { return withCls(t.tree, c).length; });
    if (cls.length) throw new Error('machine classes still rendered: ' + cls.join(', '));
    // The host DID answer with two machines and two jobs on one of them; the endpoint side of
    // the section is untouched by that removal.
    const rows = withCls(t.tree, 'audio-play-ep-row').map(ownTxt);
    const prim = withCls(t.tree, 'audio-play-endpoint').map(ownTxt);
    if (rows.length !== 2 || prim.length !== 2) throw new Error('endpoint rows: registry ' + rows.length + ' primary ' + prim.length);
    const chips = withCls(t.tree, 'audio-play-ep-slot').map(ownTxt).sort().join(',');
    // T-235 contract change: same four slots, same vocabulary — the primary slot names itself
    // and a registered row names its host id.
    // T-597 RE-POINTED 2026-10-20: still four slot chips and no Machines block; the machine took the registry id's
    // place on the face, and the id is still in each chip's hover (pinned in the new T-597 block of this file).
    if (chips !== 'STT1: cpu1.test,STT2: cpu2.test,TTS1: cpu1.test,TTS2: cpu2.test') throw new Error('endpoint slot chips (T-235 contract change): ' + chips);
    const lights = withCls(t.tree, 'audio-play-ep-online').length;
    if (lights !== 4) throw new Error('liveness lights: ' + lights);
    const laneSel = t.tree.filter(function (e) { return e.type === 'select' && hasCls(e, 'audio-play-lane'); }).length;
    if (laneSel !== 2) throw new Error('lane selects: ' + laneSel);
  });

  await attempt('T-223: the Log rows dropdown offers "all", and choosing it lists every kept event with no "+ N older" remainder (T-223: rows dropdown offers all)', function () {
    const events = [];
    for (let i = 0; i < 50; i++) events.push({ ts: 1727000000000 + i, type: 'info', text: 'event ' + i });
    const mark = shim.rt.created.length;
    shim.renderComponent(fnByName.LogPane, { events: events, limit: 0, onLimit: function () {} }, { fresh: true, effects: false });
    const tree = shim.rt.created.slice(mark);
    const sel = withCls(tree, 'audio-play-log-limit');
    if (sel.length !== 1) throw new Error('row-count selects: ' + sel.length);
    const opts = (sel[0].props.children || []).map(ownTxt);
    if (opts.indexOf('all') < 0) throw new Error('rows dropdown options: ' + opts.join(' | '));
    if (opts.join(',') !== '5,10,20,all') throw new Error('rows dropdown options: ' + opts.join(' | '));
    if (sel[0].props.value !== '0') throw new Error('select value for "all": ' + sel[0].props.value);
    const rows = withCls(tree, 'audio-play-log-row');
    if (rows.length !== 50) throw new Error('rows listed with "all": ' + rows.length);
    const kept = withCls(tree, 'audio-play-log').map(ownTxt).join('');
    if (!/50 event\(s\) kept \u00B7 showing all 50/.test(kept)) throw new Error('kept line: ' + kept.slice(0, 90));
    if (/\+ \d+ older/.test(kept)) throw new Error('a "+ N older" remainder is still printed with "all": ' + kept.slice(0, 90));
    // The numeric choices still behave as before, remainder included.
    const mark2 = shim.rt.created.length;
    shim.renderComponent(fnByName.LogPane, { events: events, limit: 20, onLimit: function () {} }, { fresh: true, effects: false });
    const tree2 = shim.rt.created.slice(mark2);
    if (withCls(tree2, 'audio-play-log-row').length !== 20) throw new Error('rows listed with 20: ' + withCls(tree2, 'audio-play-log-row').length);
    const kept2 = withCls(tree2, 'audio-play-log').map(ownTxt).join('');
    if (!/50 event\(s\) kept \u00B7 showing last 20/.test(kept2) || !/\+ 30 older/.test(kept2)) throw new Error('kept line at 20: ' + kept2.slice(0, 90));
    const bad = voidViolations(shim);
    if (bad.length) throw new Error(bad.length + ' void element(s) carry children');
  });

  await attempt('T-223: the Voices section title is exactly "Voices" and the old title appears nowhere (T-223: section titled "Voices") (T-247 contract change: the row count this check pins is the registry count, 4)', async function () {
    const m = mount201();
    await openAllSections(m.run, m.comp);
    const mark = m.run.rt.created.length;
    m.run.render(m.comp());
    const tree = m.run.rt.created.slice(mark);
    const heads = tree.filter(function (e) {
      return e.type === 'div' && typeof e.props.onClick === 'function' && ownTxt(e).indexOf('Voices') === 0;
    });
    if (heads.length !== 1) throw new Error('Voices section headers: ' + heads.map(ownTxt).join(' | '));
    // T-300 CONTRACT (user feedback 2026-10-12, 18:51): "I would like the headers to sit in the center like in
    // winamp (center \"Playlist\", \"Models\",...)" - the word centred in the BAR, not in the space left next to
    // one arrow. T-300 achieved that with an empty 16px spacer on the left of the title.
    // T-413 CONTRACT CHANGE (2026-10-15, the user asked for a mirrored pair of header arrows for review): the
    // empty spacer is gone, because the LEFT arrow of the pair is 16px wide and occupies that side now. The
    // centring measurement 16px - title - 16px is unchanged, and instead of pinning an empty span it is now
    // pinned directly: two arrow spans, the same width, bracketing the title in visual order, and the title still
    // the only span carrying text, still exactly "Voices", still centred. That is a stronger check than the one it
    // replaces, not a relaxed one.
    const headSpans = (heads[0].props.children || []).filter(function (c) { return c && c.type === 'span'; });
    const arrows223 = headSpans.filter(function (c) { return String(c.props.className || '').indexOf('audio-play-section-head-arrow') >= 0; });
    if (arrows223.length !== 2) throw new Error('header arrows in the Voices head: ' + arrows223.length);
    if (arrows223.some(function (c) { return ownTxt(c) === ''; })) throw new Error('a header arrow carries no glyph');
    if (arrows223[0].props.style.width !== arrows223[1].props.style.width)
      throw new Error('the two header arrows are not the same width: ' + arrows223[0].props.style.width + ' vs ' + arrows223[1].props.style.width);
    const titleSpan = headSpans.filter(function (c) { return ownTxt(c) !== '' && String(c.props.className || '').indexOf('head-arrow') < 0; })[0];
    if (!titleSpan || ownTxt(titleSpan) !== 'Voices') throw new Error('section title: ' + (titleSpan ? ownTxt(titleSpan) : 'none'));
    if (titleSpan.props.style.textAlign !== 'center' || titleSpan.props.style.flex !== '1 1 auto')
      throw new Error('the section title is not centred: ' + JSON.stringify(titleSpan.props.style));
    // Visual order is arrow - title - arrow because flex `order` places them while the DOM keeps the title first,
    // which is what keeps the header's own text beginning with the title for every lookup in this suite.
    const o223 = [Number(arrows223[0].props.style.order), Number(titleSpan.props.style.order), Number(arrows223[1].props.style.order)];
    if (!(o223[0] < o223[1] && o223[1] < o223[2])) throw new Error('the header arrows do not bracket the title in visual order: ' + JSON.stringify(o223));
    const all = tree.map(ownTxt).join('\n');
    if (all.indexOf('Voices (one list)') >= 0) throw new Error('the old title "Voices (one list)" is still rendered');
    // T-247 contract change: 4 rows, the registry names only (it was 5 under T-217, because a
    // name an engine listed and the plugin had no entry for got its own row).
    if (withCls(tree, 'audio-play-voice-row').length !== 4) throw new Error('the rename changed the voice rows: ' + withCls(tree, 'audio-play-voice-row').length);
  });

  // T-240 (user decision 2026-10-06): health is ON-DEMAND ONLY, so the panel must be honest
  // about not knowing. Two host shapes, both rendered straight off the host's own answer: a
  // registry that carries NO health at all (a session that has not probed anything), and a
  // registry carrying a CACHED answer that is minutes old. The first must read UNKNOWN, not
  // down; the second must show its age instead of pretending to be current.
  const t240EpHost = function (healthOf) {
    return function (url) {
      const u = String(url);
      let body = { ok: true };
      if (/endpoint_registry/.test(u)) {
        const fn = /fn=stt/.test(u) ? 'stt' : 'tts';
        const h = healthOf(fn);
        body = {
          ok: true, fn: fn,
          primary: Object.assign({ id: 'primary', fn: fn, url: 'http://cpu1.test:' + (fn === 'stt' ? '8962' : '8963'), route: 'speech', host: 'cpu1.test', enabled: true, batch_allowed: true, paused: false }, h.primary),
          endpoints: [Object.assign({ id: fn === 'stt' ? 'e-2' : 'e-1', fn: fn, url: 'http://cpu2.test:' + (fn === 'stt' ? '8962' : '8963'), route: 'speech', host: 'cpu2.test', enabled: true, batch_allowed: true, paused: false, models: ['m1'], models_source: 'engine', models_at: 1727000000000 }, h.entry)],
        };
      } else if (/queue_status/.test(u)) {
        body = { ok: true, queues: { tts: { paused: false, running: null, queued: 0, slots: { max: 2, used: 0 } }, stt: { paused: false, running: null, queued: 0, slots: { max: 2, used: 0 } } } };
      }
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
    };
  };
  const t240OpenEp = async function (healthOf) {
    const m = mountWith(t240EpHost(healthOf));
    m.run.renderAndCommit(m.comp());
    await m.run.flush();
    const hdr = m.run.rt.created.filter(function (e) {
      return e.type === 'div' && typeof e.props.onClick === 'function' && ownTxt(e).indexOf('Endpoints') === 0;
    }).pop();
    if (!hdr) throw new Error('the Endpoints section header is missing');
    hdr.props.onClick();
    await m.run.flush();
    const mark = m.run.rt.created.length;
    m.run.render(m.comp());
    return { run: m.run, tree: m.run.rt.created.slice(mark) };
  };

  await attempt('T-240: a session that has probed nothing renders four amber UNKNOWN lights, a "not probed" age on every row, and ONE plain honesty line (UNKNOWN is not "down") (T-243 contract change: a row now prints a health age AND a model age)', async function () {
    const t = await t240OpenEp(function () { return { primary: {}, entry: {} }; });
    const lights = withCls(t.tree, 'audio-play-ep-online');
    if (lights.length !== 4) throw new Error('lights: ' + lights.length);
    if (lights.map(ownTxt).join('|') !== 'unknown|unknown|unknown|unknown') throw new Error('lights: ' + lights.map(ownTxt).join('|'));
    if (lights.some(function (e) { return e.props.style.color !== '#d29922'; })) throw new Error('an unprobed endpoint was painted as something other than amber unknown');
    if (!lights.every(function (e) { const tip = String(e.props.title || ''); return /never probed this session/.test(tip) && /UNKNOWN, not down/.test(tip); })) {
      throw new Error('unknown tooltips: ' + lights.map(function (e) { return e.props.title; }).join(' || '));
    }
    const ages = withCls(t.tree, 'audio-play-ep-age').map(ownTxt);
    // T-243 CONTRACT, RE-EXPRESSED (the T-240 check is kept whole): a row now prints TWO
    // ages — the health age and the model age — so the tag count per row is two. The four
    // "not probed" health ages are still exactly four, one per row; what is new is that a
    // model answer nobody has ever read says "not read" instead of showing a count.
    if (ages.length !== 8) throw new Error('age tags: ' + ages.join(' | '));
    if (ages.filter(function (x) { return x === 'not probed'; }).length !== 4) throw new Error('health ages: ' + ages.join(' | '));
    if (ages.filter(function (x) { return x === 'not probed'; }).length !== 4) throw new Error('health ages: ' + ages.join(' | '));
    if (ages.filter(function (x) { return x === 'not read' || /^read \d+(s|m|h|d) ago$/.test(x); }).length !== 4) throw new Error('model ages: ' + ages.join(' | '));
    const notes = withCls(t.tree, 'audio-play-ep-healthnote').map(ownTxt);
    if (notes.length !== 1) throw new Error('honesty lines: ' + notes.length);
    if (!/no endpoint has been probed this session/.test(notes[0]) || !/UNKNOWN, not down/.test(notes[0])) throw new Error('honesty line: ' + notes[0]);
    if (withCls(t.tree, 'audio-play-ep-online').some(function (e) { return e.props.style.color === '#f85149'; })) throw new Error('an unprobed endpoint was painted red');
    const bad = voidViolations(t.run);
    if (bad.length) throw new Error(bad.length + ' void element(s) carry children');
  });

  await attempt('T-240: a cached health answer the registry carries is printed WITH ITS AGE (minutes old, amber) and the "we do not know" line is gone (T-243 contract change: eight age tags now, the four health ages unchanged)', async function () {
    const old = Date.now() - 200000;   // 3 min 20 s: past the host's own 120 s staleness window
    const t = await t240OpenEp(function () {
      return {
        primary: { online: true, http: 200, checked_at: old, health_error: '' },
        entry: { online: true, http: 200, checked_at: old, health_error: '' },
      };
    });
    const ages = withCls(t.tree, 'audio-play-ep-age');
    const ageTxt = ages.map(ownTxt);
    // T-243 CONTRACT, RE-EXPRESSED: eight age tags now (four health, four model). The four
    // "probed …" ages and their amber staleness marking are unchanged; the four model ages
    // in this fixture are "not read" — nothing in it has ever read a /v1/models.
    if (ageTxt.length !== 8) throw new Error('age tags: ' + ageTxt.length);
    if (ageTxt.filter(function (x) { return /^probed \d+(m|h|d) ago$/.test(x); }).length !== 4) throw new Error('health ages: ' + ageTxt.join(' | '));
    if (ageTxt.filter(function (x) { return x === 'not read' || /^read \d+(m|h|d) ago$/.test(x); }).length !== 4) throw new Error('model ages: ' + ageTxt.join(' | '));
    if (ages.some(function (e) { return e.props.style.color !== '#d29922'; })) throw new Error('an answer older than the staleness window was not marked: ' + ages.map(function (e) { return e.props.style.color; }).join(','));
    const lights = withCls(t.tree, 'audio-play-ep-online');
    if (lights.map(ownTxt).join('|') !== 'online|online|online|online') throw new Error('lights: ' + lights.map(ownTxt).join('|'));
    if (!lights.every(function (e) { const tip = String(e.props.title || ''); return /the answer is \d+(m|h|d) old/.test(tip) && /no health poller/.test(tip) && !/auto-refresh tick/.test(tip); })) {
      throw new Error('online tooltips: ' + lights.map(function (e) { return e.props.title; }).join(' || '));
    }
    if (withCls(t.tree, 'audio-play-ep-healthnote').length !== 0) throw new Error('the "we do not know" line is still printed when an answer exists');
    const bad = voidViolations(t.run);
    if (bad.length) throw new Error(bad.length + ' void element(s) carry children');
  });

  console.log('\n--- T-229: the job kind selector, the kind-filtered model list, the inputs each kind shows ---');
  // The live catalog shape (MODELS_REMOTE.md) split the way TASK_ALLOW splits it
  // (lib/index.js:4217): fn=tts answers tts/clon/vdes, fn=task answers sep/gen/vc/s2s.
  // The flags are the ones modelsOf actually sends (index.js:4060-4075) — including
  // qwen3_tts carrying clone_required:true from FAMILY_CAPS (index.js:4011), which is why
  // qwen3-tts lands under CLONE here and not under voice: the host has no built-in voice
  // for it, and the T-227 gate (client.js:1463) reads the same flag.
  const T229_TTS = [
    { id: 'glm_tts_3702_clone', loaded: false, task: 'clon', family: 'glm_tts', quant: 'q8', clone_required: true, default_voice: false },
    { id: 'qwen3-tts', loaded: true, task: 'tts', family: 'qwen3_tts', quant: 'bf16', clone_required: true, default_voice: false },
    { id: 'voxcpm2_6s', loaded: true, task: 'tts', family: 'voxcpm2', quant: 'bf16', clone_required: false, default_voice: true },
    { id: 'voy_design_short', loaded: false, task: 'vdes', family: 'voxcpm2', design: true },
  ];
  const T229_TASK = [
    { id: 'bs_roformer', loaded: false, task: 'sep', family: 'bs_roformer', quant: 'f16' },
    { id: 'controlfoley', loaded: false, task: 'gen', family: 'controlfoley' },
    { id: 'personaplex', loaded: false, task: 's2s', family: 'personaplex' },
    { id: 'stable_audio_medium', loaded: false, task: 'gen', family: 'stable_audio' },
    { id: 'vevo2', loaded: false, task: 'vc', family: 'vevo2' },
  ];
  function t229Mount(ttsModels, taskModels) {
    return mountWith(function (url, opts) {
      const u = String(url);
      let body = { ok: true };
      const fm = /[?&]fn=([A-Za-z]+)/.exec(u);
      const fn = fm ? fm[1] : '';
      if (/get_models/.test(u)) body = { ok: true, models: fn === 'task' ? taskModels : (fn === 'stt' ? [] : ttsModels) };
      else if (/refresh_voices/.test(u)) body = { ok: true, voices: ['v1'], server: [] };
      else if (/voice_registry/.test(u)) body = { ok: true, voices: [] };
      else if (/playlist_list/.test(u)) body = { ok: true, items: [], queues: { tts: { paused: false, running: null, queued: 0 }, stt: { paused: false, running: null, queued: 0 } } };
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
    });
  }
  const flatKids = function (e) {
    const out = [];
    (function walk(x) {
      if (x == null) return;
      if (Array.isArray(x)) { x.forEach(walk); return; }
      out.push(x);
    })((e && e.props && e.props.children));
    return out;
  };
  const t229Sel = function (list, cls) { return (list || []).filter(function (e) { return e.type === 'select' && hasCls(e, cls); }).pop(); };
  const t229KindOpts = function (list) {
    const s = t229Sel(list, 'audio-play-kind');
    if (!s) return null;
    return flatKids(s).filter(function (e) { return e && e.type === 'option'; }).map(function (o) {
      return { value: o.props.value, label: ownTxt(o), disabled: !!o.props.disabled, tip: String(o.props.title || '') };
    });
  };
  const t229Groups = function (list) {
    const s = t229Sel(list, 'audio-play-model');
    if (!s) return null;
    return flatKids(s).filter(function (e) { return e && e.type === 'optgroup'; }).map(function (g) {
      return {
        label: g.props.label,
        options: flatKids(g).filter(function (o) { return o && o.type === 'option'; }).map(function (o) { return { value: o.props.value, label: ownTxt(o) }; }),
      };
    });
  };
  const t229Drive = async function (m, kind) {
    const tb = m.run.rt.created.filter(function (e) { return e.props && typeof e.props.onKindChange === 'function'; }).pop();
    if (!tb) throw new Error('no component carries the kind handler');
    tb.props.onKindChange(kind);
    await m.run.flush();
    m.run.render(m.comp());
    await m.run.flush();
    return m.run.rt.created.slice();
  };

  await attempt('T-229: the kind options are DERIVED from the catalog the host answers, one entry per served kind, counted', async function () {
    const m = t229Mount(T229_TTS, T229_TASK);
    await openAllSections(m.run, m.comp);
    const tree = m.run.rt.created.slice();
    const opts = t229KindOpts(tree);
    if (!opts) throw new Error('no .audio-play-kind select rendered');
    const want = ['tts', 'clon', 'vdes', 'sep', 'gen', 'vc', 's2s'];
    if (opts.map(function (o) { return o.value; }).join(',') !== want.join(',')) throw new Error('kind options: ' + opts.map(function (o) { return o.value; }).join(','));
    if (opts.some(function (o) { return o.disabled; })) throw new Error('a served kind is disabled: ' + JSON.stringify(opts.filter(function (o) { return o.disabled; })));
    // The counts are model counts off the same catalog, not invented labels.
    const counts = {};
    opts.forEach(function (o) { const m2 = /· (\d+)$/.exec(o.label); counts[o.value] = m2 ? Number(m2[1]) : 0; });
    const expect = { tts: 1, clon: 2, vdes: 1, sep: 1, gen: 2, vc: 1, s2s: 1 };
    Object.keys(expect).forEach(function (k) {
      if (counts[k] !== expect[k]) throw new Error('kind ' + k + ' counted ' + counts[k] + ', catalog says ' + expect[k]);
    });
    // The labels are the design note's wording. U-18 (2026-10-13) took the verbs out of them: the hover
    // says what the kind does to the take, and the verb it rides is a code fact, recorded at the dispatch
    // sites (KIND_VERB) and in the comment above KIND_TIP.
    const tips = opts.map(function (o) { return o.tip; });
    if (tips.some(function (t) { return /dispatch_|\/v1\//.test(t); })) throw new Error('a kind hover names a verb or a route again: ' + tips.join(' || '));
    if (tips[0].indexOf('text in, one voice out') < 0) throw new Error('the render kind hover no longer says what it does: ' + tips[0]);
    if (!tips.some(function (t) { return /a clone without a voice is refused/.test(t); })) throw new Error('the clone hover lost the refusal it exists to warn about: ' + tips.join(' || '));
    if (!tips.some(function (t) { return /a WAV in, stems out/.test(t); })) throw new Error('the separation hover lost what it gives back: ' + tips.join(' || '));
    const bad = voidViolations(m.run);
    if (bad.length) throw new Error(bad.length + ' void element(s) carry children');
  });

  await attempt('T-313 (user 2026-10-13): "the model selection dropdown is too small and not visible" - the model select has a real floor and a real basis, and the voice select takes the same one', async function () {
    const m = t229Mount(T229_TTS, []);
    await openAllSections(m.run, m.comp);
    const tree = m.run.rt.created.slice();
    const modelSel = t229Sel(tree, 'audio-play-model');
    if (!modelSel) throw new Error('no .audio-play-model select rendered');
    const ms = modelSel.props.style || {};
    // The defect was a flex item with a ZERO floor sitting in an over-subscribed head row (kind select capped at
    // 190px + format select 90px + the lane select): the item that can shrink to nothing is the first thing to
    // become a sliver, and it was the control the person needs most. A floor and a basis are the fix, so both
    // are pinned here - a flex value that drops the floor back to 0 fails this check.
    if (ms.minWidth !== '150px') throw new Error('the model select can be squeezed below its floor again: ' + JSON.stringify(ms));
    if (ms.flex !== '1 1 220px') throw new Error('the model select has no basis to grow from: ' + JSON.stringify(ms));
    const floored = tree.filter(function (e) { return e.type === 'select' && e.props && e.props.style && e.props.style.minWidth === '150px'; });
    if (floored.length < 2) throw new Error('the voice select did not take the same floor: ' + floored.length);
  });

  await attempt('T-313 (user 2026-10-13): "We still do not display the model\'s default voices provided by the models to select from" - when the lane reports NONE for the selected model the panel says so at the pick, instead of leaving a gap that reads as a panel that failed to list something', async function () {
    const m = t229Mount(T229_TTS, []);
    await openAllSections(m.run, m.comp);
    const tree = m.run.rt.created.slice();
    const line = withCls(tree, 'audio-play-no-model-speakers');
    // One per TTS box that has a model picked (the panel renders the box for more than one slot), so the pin is
    // "at least one, and every one of them honest" - not an exact count, which would pin the slot layout to a
    // number it has no reason to hold.
    if (line.length < 1) throw new Error('the honest line is not rendered (this catalog has no preset-bearing model and the host answers no builtins): ' + line.length);
    line.forEach(function (e, i) {
      const txt = ownTxt(e);
      // T-832 contract change (2026-11-13): the same line, re-worded shorter at the operator's word. What is
      // measured here is unchanged - every copy names what the lane does not offer, and no copy pretends.
      if (!/no built-in speakers, using registry clone samples/.test(txt)) throw new Error('copy #' + i + ' does not say what is missing: ' + txt);
      // The point of the line is that it does NOT pretend. A "model speakers (N):" claim on top of an empty
      // answer is the failure the user reported, so the two forms may not coexist on the same box.
      if (/model speakers \(/.test(txt)) throw new Error('copy #' + i + ' claims speakers the lane never gave: ' + txt);
      const tip = String(e.props.title || '');
      if (tip.indexOf('builtins:[]') < 0) throw new Error('copy #' + i + ' hover does not name the answer the lane gave: ' + tip);
      if (tip.indexOf('builtins_source') < 0) throw new Error('copy #' + i + ' hover does not say where that answer came from: ' + tip);
    });
    const claims = tree.filter(function (e) { return /model speakers \(\d+\)/.test(ownTxt(e)); });
    if (claims.length) throw new Error('a preset count was claimed on a lane that answered none: ' + claims.map(function (e) { return ownTxt(e); }).join(' || '));
  });

  await attempt('T-229: a kind no model serves is listed DISABLED and says so, never selectable, never an empty model list', async function () {
    const m = t229Mount(T229_TTS, []);   // no tool models on this fleet
    await openAllSections(m.run, m.comp);
    const tree = m.run.rt.created.slice();
    const opts = t229KindOpts(tree);
    if (!opts) throw new Error('no .audio-play-kind select rendered');
    const off = opts.filter(function (o) { return o.disabled; }).map(function (o) { return o.value; });
    if (off.join(',') !== 'sep,gen,vc,s2s') throw new Error('unserved kinds: ' + off.join(','));
    const unserved = opts.filter(function (o) { return o.disabled; });
    if (!unserved.every(function (o) { return /no model on this fleet/.test(o.label); })) throw new Error('an unserved kind does not say so plainly: ' + unserved.map(function (o) { return o.label; }).join(' | '));
    if (opts.filter(function (o) { return !o.disabled; }).map(function (o) { return o.value; }).join(',') !== 'tts,clon,vdes') throw new Error('served kinds changed: ' + opts.map(function (o) { return o.value; }).join(','));
    // And the model select is never empty for the kind that IS selected.
    const groups = t229Groups(tree);
    if (!groups || !groups.length || !groups[0].options.length) throw new Error('the model list is empty for a served kind');
    const bad = voidViolations(m.run);
    if (bad.length) throw new Error(bad.length + ' void element(s) carry children');
  });

  await attempt('T-229: the model dropdown is FILTERED by the kind — a tool kind cannot offer a speech model', async function () {
    const m = t229Mount(T229_TTS, T229_TASK);
    await openAllSections(m.run, m.comp);
    const tree = await t229Drive(m, 'sep');
    const groups = t229Groups(tree);
    if (!groups) throw new Error('no .audio-play-model select after a kind change');
    const ids = groups.map(function (g) { return g.options.map(function (o) { return o.value; }); }).flat();
    if (ids.join(',') !== 'bs_roformer') throw new Error('the separate kind offers: ' + ids.join(','));
    if (ids.indexOf('qwen3-tts') >= 0 || ids.indexOf('voxcpm2_6s') >= 0) throw new Error('a speech model leaked into the separate kind');
    // The group is the host's own category for that token (categoryOf, index.js:4049).
    if (groups.map(function (g) { return g.label; }).join(',') !== 'audio tools') throw new Error('optgroup labels: ' + groups.map(function (g) { return g.label; }).join(','));
    // The kind selector itself moved to the new kind, and the tool inputs are showing.
    const kindSel = t229Sel(tree, 'audio-play-kind');
    if (String(kindSel.props.value) !== 'sep') throw new Error('kind select value: ' + kindSel.props.value);
    const bad = voidViolations(m.run);
    if (bad.length) throw new Error(bad.length + ' void element(s) carry children');
  });

  await attempt('T-229: options are grouped by the host pipeline category, and each option names the task it serves', async function () {
    const m = t229Mount(T229_TTS, T229_TASK);
    await openAllSections(m.run, m.comp);
    const tree = await t229Drive(m, 'gen');
    const groups = t229Groups(tree);
    if (groups.map(function (g) { return g.label; }).join(',') !== 'audio generation') throw new Error('optgroup labels for gen: ' + groups.map(function (g) { return g.label; }).join(','));
    if (groups[0].options.map(function (o) { return o.value; }).join(',') !== 'controlfoley,stable_audio_medium') throw new Error('gen options: ' + groups[0].options.map(function (o) { return o.value; }).join(','));
    if (!groups[0].options.every(function (o) { return /task:gen/.test(o.label); })) throw new Error('an option does not name its task: ' + groups[0].options.map(function (o) { return o.label; }).join(' | '));
    // A render kind groups under speech synthesis and keeps the capability tags the T-40/T-41
    // dropdown already showed.
    const back = await t229Drive(m, 'clon');
    const g2 = t229Groups(back);
    if (g2.map(function (g) { return g.label; }).join(',') !== 'speech synthesis') throw new Error('optgroup labels for clon: ' + g2.map(function (g) { return g.label; }).join(','));
    if (g2[0].options.map(function (o) { return o.value; }).join(',') !== 'glm_tts_3702_clone,qwen3-tts') throw new Error('clon options: ' + g2[0].options.map(function (o) { return o.value; }).join(','));
    if (!/CLONE/.test(g2[0].options[0].label)) throw new Error('the capability tag was dropped from the option: ' + g2[0].options[0].label);
    const bad = voidViolations(m.run);
    if (bad.length) throw new Error(bad.length + ' void element(s) carry children');
  });

  // TtsBox rendered on its own, with a chosen kind. The panel's other sections share some
  // input placeholders (the STT box uses the same "local /path/to/file.wav"), so the
  // per-kind input shape has to be read from the box itself, not from the whole tree.
  const t229Box = function (m, kind, extra) {
    const rec = m.seen.get('TtsBox');
    if (!rec) throw new Error('TtsBox was never rendered');
    // The model the panel would have resolved for that kind (the same pick the real
    // resolution makes), so the box's own model-derived rows read the right catalog entry.
    const pick = { tts: 'voxcpm2_6s', clon: 'qwen3-tts', vdes: 'voy_design_short', sep: 'bs_roformer', gen: 'controlfoley', vc: 'vevo2', s2s: 'personaplex' }[kind];
    const props = Object.assign({}, rec.props, {
      kind: kind,
      models: { tts: T229_TTS, stt: [], task: T229_TASK },
      selModel: { tts: kind === 'tts' || kind === 'clon' || kind === 'vdes' ? pick : 'voxcpm2_6s', stt: '', task: kind === 'sep' || kind === 'gen' || kind === 'vc' || kind === 's2s' ? pick : 'bs_roformer' },
      voices: { tts: ['v1'], stt: [] }, voicesBuiltin: {},
      selVoice: { tts: 'v1', stt: '' }, voiceReg: {}, voiceEngine: [],
      playlist: [], busy: { tts: false, stt: false },
    }, extra || {});
    const mark = m.run.rt.created.length;
    m.run.renderComponent(rec.fn, props, { fresh: true, effects: false });
    return m.run.rt.created.slice(mark);
  };

  await attempt('T-229: the kind decides which inputs appear — text for voice/clone/design, prompt + knobs for generate, source for the file kinds, target choices for voice convert', async function () {
    const m = t229Mount(T229_TTS, T229_TASK);
    await openAllSections(m.run, m.comp);
    const inputsOf = function (tree) {
      return tree.filter(function (e) { return e.type === 'input'; }).map(function (e) { return String(e.props.placeholder || e.props.type || ''); });
    };
    const textOf = function (tree) {
      return tree.filter(function (e) { return e.type === 'textarea'; }).map(function (e) { return String(e.props.placeholder || ''); });
    };
    const voice = t229Box(m, 'tts');
    if (!textOf(voice).some(function (p) { return p.indexOf('Text to synthesize') === 0; })) throw new Error('the voice kind has no read-aloud box: ' + textOf(voice).join(' | '));
    if (inputsOf(voice).some(function (p) { return p === 'local /path/to/file.wav'; })) throw new Error('the voice kind renders a tool source input');
    const clone = t229Box(m, 'clon');
    if (!textOf(clone).some(function (p) { return p.indexOf('Text to synthesize') === 0; })) throw new Error('the clone kind has no read-aloud box');
    const design = t229Box(m, 'vdes');
    if (!textOf(design).some(function (p) { return p.indexOf('Voice description') === 0; })) throw new Error('design has no voice-design prompt: ' + textOf(design).join(' | '));
    if (design.filter(function (e) { return e.type === 'select' && String(e.props.title || '').indexOf('voice list') === 0; }).length) throw new Error('design renders a voice select it should not');
    const gen = t229Box(m, 'gen');
    // T-568 re-point (2026-10-17, operator ruling: "add mic and grip and clear"): the prompt field is a TEXTAREA now,
    // the same kind of field the text-to-read box is. The filter follows the field, it does not relax: the check still
    // demands a prompt box for the generate kind, and the T-568 attempt below measures the field's own shape.
    if (!textOf(gen).some(function (p) { return p.indexOf('prompt, e.g.') === 0; })) throw new Error('generate has no prompt box: ' + textOf(gen).join(' | '));
    // T-570 (operator ruling 2026-10-17, verbatim): "do not prefill - if fallback is engine using defaults - that is
    // fine". The fields stay empty; what changed is the guidance placeholder, which used to read "guidance (6.5)" and
    // named a number NO model spec read on 2026-10-17 carries (controlfoley 4.5, stable audio 1, minimax_music3 1.7,
    // heartmula 1.5). The knob list is re-pointed to what the fields are now called, not loosened -- the check below
    // still demands all three knobs on screen for the generate kind and none of them for the separate kind.
    // T-596 item 1 re-point (operator, 2026-10-21 00:51 Berlin, "Print the label, keep the box empty"): the duration
    // field's placeholder stopped carrying the label - the words "duration seconds" are now printed on the row - so the
    // placeholder this pin identifies is 'sfx ~8'. The check itself is unchanged: all three knobs on screen for the
    // generate kind, none for the separate kind.
    // T-596 item 2 re-point (operator ruling 2026-10-21 10:38 Berlin: "if advanced already has steps and guidance,
    // drop it from the upper section. so if kept unset, defaults will be used by the engine"): three became one. The
    // generate row carries its ONE knob, and the two names that moved are demanded ABSENT here rather than present,
    // because a form field that no longer exists is exactly what this ruling decided - and the door they ride through
    // now (the Advanced options board) is measured live in tests/actions.test.cjs, where a record is read and its
    // declared names become controls.
    if (!inputsOf(gen).some(function (x) { return x === 'sfx ~8'; })) throw new Error('generate is missing its knob: duration');
    ['guidance', 'steps'].forEach(function (p) {
      if (inputsOf(gen).some(function (x) { return x === p; })) throw new Error('the generate row still carries a knob the ruling moved to Advanced: ' + p);
    });
    const durEl596 = gen.filter(function (e) { return e.type === 'input' && String(e.props.placeholder || '') === 'sfx ~8'; }).pop();
    if (!durEl596) throw new Error('no duration input to read the label and the pointer off');
    const label596 = gen.filter(function (e) { return e.type === 'span' && String(e.props.children || '') === 'duration seconds'; });
    if (label596.length !== 1) throw new Error('the label T-596 item 1 printed is not on the row exactly once: ' + label596.length);
    if (!/guidance_scale and num_inference_steps are not on this row any more/.test(String(durEl596.props.title || '')))
      throw new Error('the duration hover does not say where the two moved knobs live: ' + String(durEl596.props.title || '').slice(0, 160));
    if (inputsOf(gen).some(function (p) { return p === 'local /path/to/file.wav'; })) throw new Error('generate renders a source input it does not use');
    const sep = t229Box(m, 'sep');
    if (!inputsOf(sep).some(function (p) { return p === 'local /path/to/file.wav'; })) throw new Error('separate has no source input: ' + inputsOf(sep).join(' | '));
    ['sfx ~8', 'guidance', 'steps'].forEach(function (p) {
      if (inputsOf(sep).some(function (x) { return x === p; })) throw new Error('separate renders an input it does not use: ' + p);
    });
    // T-568 re-point: the prompt moved out of `input` and into `textarea`, so asking inputsOf() whether it is absent
    // would have been a check that measures nothing. It is asked of the right collection instead -- a separate job
    // still has no prompt box of either kind.
    if (textOf(sep).some(function (p) { return p.indexOf('prompt, e.g.') === 0; })) throw new Error('separate renders a prompt box it does not use');
    if (inputsOf(sep).some(function (p) { return p.indexOf('prompt, e.g.') === 0; })) throw new Error('separate renders a prompt input it does not use');
    // T-569 (operator ruling 2026-10-17, verbatim: "make uniform design"). Measured BEFORE anything was changed, and
    // the measurement killed the obvious fix: the controls that start work already share ONE factory (runButton371
    // sets minWidth and maxWidth 132px, nowrap, ellipsis -- T-451) and one green, so there was no colour or box to
    // unify. What nothing protected was the LABEL against the box: a label longer than 132px at an 11px font is
    // ellipsised, and an ellipsised label is a row that stops looking uniform without any rule being broken. This
    // pins the two facts the row has to keep -- the same fixed box on every run control, and a label short enough to
    // be shown inside it -- so a future label edit that overflows fails a check instead of shipping a truncated word.
    const runBtns569 = gen.filter(function (e) { return e.type === 'button' && /audio-play-run371/.test(String((e.props || {}).className || '')); })
      .concat(sep.filter(function (e) { return e.type === 'button' && /audio-play-run371/.test(String((e.props || {}).className || '')); }));
    if (runBtns569.length < 2) throw new Error('no run control found to measure (got ' + runBtns569.length + ')');
    runBtns569.forEach(function (b569) {
      const st569 = (b569.props || {}).style || {};
      const lab569 = String((b569.props || {}).children || '');
      if (st569.minWidth !== '132px' || st569.maxWidth !== '132px') {
        throw new Error('a run control left the fixed box: ' + JSON.stringify([lab569, st569.minWidth, st569.maxWidth]));
      }
      if (lab569.length > 20) {
        throw new Error('a run label does not fit the 132px box at 11px font, so it would render ellipsised: '
          + lab569 + ' (' + lab569.length + ' chars)');
      }
    });
    // T-453 (user 2026-10-15, verbatim): "for 'voice convert' ... it needs some tags for 'source voice:'
    // 'target voice:' and remove both 'manual path' options -> the default first option in the 'target voice'
    // dropdown should be 'currently selected'". A VC source is a VOICE, not a path: picked from the computer or
    // pointed at on the playlist. Both typed paths are gone HERE and stay for sep / s2s, whose source really is a
    // file on the host's disk (a capture, a stem) — asserted in the blocks above and below this one.
    const vc = t229Box(m, 'vc');
    if (inputsOf(vc).some(function (p) { return p === 'local /path/to/file.wav'; })) throw new Error('voice convert offers a manual source path again');
    if (inputsOf(vc).some(function (p) { return p === 'or /path/to/target.wav'; })) throw new Error('voice convert offers a manual target path again');
    const vcTags = vc.filter(function (e) { return e.type === 'span' && ['source voice:', 'target voice:'].indexOf(ownTxt(e)) >= 0; });
    if (vcTags.length !== 2) throw new Error('voice convert tags on screen: ' + vcTags.length + ' (want "source voice:" and "target voice:")');
    const vcSelects = vc.filter(function (e) {
      return e.type === 'select' && ['currently selected', 'target from playlist'].some(function (t) { return ownTxt(e).indexOf(t) === 0; });
    });
    if (vcSelects.length !== 2) throw new Error('voice convert target selects: ' + vcSelects.length);
    const vcVoiceSel = vcSelects.filter(function (e) { return ownTxt(e).indexOf('currently selected') === 0; })[0] || null;
    if (!vcVoiceSel) throw new Error('the target voice select has no "currently selected" first option');
    if (String(vcVoiceSel.props.value) !== '') throw new Error('the default target is no longer the untouched state: ' + vcVoiceSel.props.value);
    const s2s = t229Box(m, 's2s');
    if (!inputsOf(s2s).some(function (p) { return p === 'local /path/to/file.wav'; })) throw new Error('speech-to-speech has no source input');
    if (inputsOf(s2s).some(function (p) { return p === 'or /path/to/target.wav'; })) throw new Error('speech-to-speech renders a voice-convert target input');
    const bad = voidViolations(m.run);
    if (bad.length) throw new Error(bad.length + ' void element(s) carry children');
  });

  // T-568 (operator ruling 2026-10-17, verbatim: "The TTS prompt text window used should be 'the same' extendable
  // format, including clear and rec button FOR sfx/music 'prompt'"; the open question this card asked -- dictating a
  // music prompt means speaking it to a SPEECH model to feed an audio model -- was answered "add mic and grip and
  // clear"). The field used to be a one-line input with flex:1: nothing to remember, nothing to drag, no mic, no
  // clear. These claims are read off the rendered props, not off a screenshot, and they are the shape the field has
  // to keep from here on.
  await attempt('T-568: the sfx / music prompt field is the same KIND of field the text-to-read field is — a textarea with a remembered height, a full-width drag strip, and the dictation dot inside it', async function () {
    const m = t229Mount(T229_TTS, T229_TASK);
    await openAllSections(m.run, m.comp);
    const gen = t229Box(m, 'gen');
    const ta568 = gen.filter(function (e) { return e.type === 'textarea' && String(e.props.placeholder || '').indexOf('prompt, e.g.') === 0; });
    if (ta568.length !== 1) throw new Error('the generate prompt is not exactly one textarea on screen: ' + ta568.length);
    const f568 = ta568[0];
    const st568 = f568.props.style || {};
    if (st568.resize !== 'vertical') throw new Error('the prompt field cannot be resized by hand at all: ' + JSON.stringify(st568.resize));
    if (st568.paddingRight !== '56px') throw new Error('typed text can run under the dot: paddingRight ' + JSON.stringify(st568.paddingRight));
    if (f568.props.rows !== 2) throw new Error('the field has no default row count to fall back on when nothing is stored: ' + JSON.stringify(f568.props.rows));
    if (st568.height !== undefined) throw new Error('a fresh profile renders an explicit height before anything was dragged: ' + JSON.stringify(st568.height));
    if (gen.some(function (e) { return e.type === 'input' && String(e.props.placeholder || '').indexOf('prompt, e.g.') === 0; })) throw new Error('the prompt is back to being a one-line input');
    const grip568 = gen.filter(function (e) { return /audio-play-gen-grip568/.test(String((e.props || {}).className || '')); });
    if (grip568.length !== 1) throw new Error('the prompt field has no drag strip of its own: ' + grip568.length);
    if (typeof grip568[0].props.onMouseDown !== 'function') throw new Error('the drag strip is decoration: it carries no onMouseDown');
    if ((grip568[0].props.style || {}).cursor !== 'ns-resize') throw new Error('the strip does not read as a vertical drag: ' + JSON.stringify((grip568[0].props.style || {}).cursor));
    if (!/separately from the text-to-read field/.test(String(grip568[0].props.title || ''))) throw new Error('the grip does not say the two heights are kept apart: ' + JSON.stringify(grip568[0].props.title));
    const mic568 = gen.filter(function (e) { return e.type === 'button' && /^speak the prompt/.test(String(e.props.title || '')); });
    if (mic568.length !== 1) throw new Error('no dictation dot inside the prompt field: ' + mic568.length);
    // The dot turns into Clr only while the field holds text. Measured here on an EMPTY field, which is how a panel
    // opens: a clear button for nothing to clear is a button that does nothing. The other half -- text in the field,
    // Clr beside the dot, and Clr emptying exactly this field -- is pinned where a field can actually be typed into,
    // in actions.test.cjs.
    if (gen.some(function (e) { return e.type === 'button' && ownTxt(e) === 'Clr'; })) throw new Error('a Clr button is rendered in an empty prompt field');
  });

  // T-572 (2026-10-17, operator ruling verbatim): "the lists for loading predefined prompts is dynamically generated
  // from the fs ?". What the shape can prove without a store: the picker exists on the music / sfx form, it is ONE
  // control, it names the store it reads, and its hovers say what picking does (fills the field, renders nothing)
  // and what saving does (writes under texts/presets/gen/, never overwrites). What it must NOT be is a control that
  // wandered onto the other forms.
  await attempt('T-572: the preset picker belongs to the music / sfx form and to no other form — one select that names the store it reads, and controls whose hovers say that picking renders nothing and that a save never overwrites', async function () {
    const m = t229Mount(T229_TTS, T229_TASK);
    await openAllSections(m.run, m.comp);
    const gen = t229Box(m, 'gen');
    const sel572 = gen.filter(function (e) { return e.type === 'select' && hasCls(e, 'audio-play-preset572'); });
    if (sel572.length !== 1) throw new Error('the generate form does not carry exactly one preset picker: ' + sel572.length);
    const tip572 = String(sel572[0].props.title || '');
    if (!/texts\/presets/.test(tip572)) throw new Error('the picker does not say which store it reads: ' + JSON.stringify(tip572.slice(0, 90)));
    if (!/does not start a render/.test(tip572)) throw new Error('the picker does not say that picking only fills the field: ' + JSON.stringify(tip572.slice(0, 90)));
    const opts572 = flatKids(sel572[0]).filter(function (e) { return e && e.type === 'option'; }).map(ownTxt);
    // T-705 item 4 (accepted 2026-11-02 08:08 Berlin): the resting option no longer claims the store is empty.
    // The list is read on open, so at first paint the panel knows only that it has not asked yet.
    if (opts572.length !== 1 || opts572[0] !== 'presets \u2014 open to read') throw new Error('with no list read yet the picker does not say so: ' + JSON.stringify(opts572));
    // T-602 item 8 re-point (2026-10-22): the one save control is TWO now - save music and save sfx - because the
    // folder a save writes into follows the KIND the person pressed, and the panel is not allowed to guess a kind
    // from the words in the prompt field. Both doors are read here, and each hover is checked against the folder
    // THAT door names.
    const save572 = gen.filter(function (e) { return e.type === 'button' && /^(save music|save sfx)$/.test(ownTxt(e)); });
    const list572 = gen.filter(function (e) { return e.type === 'button' && ownTxt(e) === 'list'; });
    // T-596 items 3 and 4 re-point (operator, 2026-10-21 00:53 / 00:55 Berlin): "remove the button, re-read on open"
    // and "Shorten it to 'save' and let the hover say what it saves" onto the Generate row. The save control is still
    // exactly one and still says where a preset is written and that nothing is overwritten; the LIST control must now
    // be ZERO, and the sentence it carried about the store being a filesystem walk lives in the picker's own hover.
    if (save572.length !== 2 || list572.length !== 0) throw new Error('the picker carries ' + save572.length + ' save and ' + list572.length + ' list control(s)');
    if (!/texts\/presets\/music\//.test(String(save572[0].props.title || '')) || !/texts\/presets\/sfx\//.test(String(save572[1].props.title || ''))) throw new Error('a save door does not name the folder it writes into: ' + JSON.stringify([String(save572[0].props.title || '').slice(0, 70), String(save572[1].props.title || '').slice(0, 70)]));
    if (!/never overwritten/.test(String(save572[0].props.title || ''))) throw new Error('the save control does not say the store is never overwritten');
    if (!/Opening re-reads the list/.test(tip572) || !/walk of the filesystem/.test(tip572)) throw new Error('the picker does not say that opening re-reads the store, and what that costs: ' + JSON.stringify(tip572.slice(0, 140)));
    // T-596 item 12 (2026-10-22): the retire door is a control of its OWN on the generate form, one of its kind,
    // and nowhere else on the panel.
    // T-830 contract change (2026-11-13, the operator's word: "the \"preset - pick one \" seems to be a load field,
    // and the \"clear preset\" seems to be a load field aswell - we only need a single load field ... we want a
    // clear SAVE and LOAD functionality for those presets - in one line"): the door is a BUTTON now, because the
    // second list it used to carry was the thing being removed. The count it holds (exactly one) and the sentence
    // its hover must carry (where a retired preset goes) are the same promises as before.
    const ret596 = gen.filter(function (e) { return e.type === 'button' && hasCls(e, 'audio-play-preset-retire596'); });
    if (ret596.length !== 1) throw new Error('the generate form does not carry exactly one clear door: ' + ret596.length);
    if (!/texts-trash/.test(String(ret596[0].props.title || ''))) throw new Error('the retire select does not say where a retired preset goes: ' + JSON.stringify(String(ret596[0].props.title || '').slice(0, 90)));
    const sep572 = t229Box(m, 'sep');
    if (sep572.some(function (e) { return e.type === 'select' && hasCls(e, 'audio-play-preset572'); })) throw new Error('the separation form grew a preset picker nobody asked for');
    const tts572 = t229Box(m, 'tts');
    if (tts572.some(function (e) { return e.type === 'select' && hasCls(e, 'audio-play-preset572'); })) throw new Error('the text-to-read form grew a preset picker nobody asked for');
  });

  await attempt('T-229: a cost is printed on an option ONLY when the host reports one — the panel invents none', async function () {
    const withCost = T229_TTS.map(function (x) { return x.id === 'voxcpm2_6s' ? Object.assign({}, x, { cost_per_second: 0.42 }) : x; });
    const a = t229Mount(withCost, T229_TASK);
    await openAllSections(a.run, a.comp);
    const treeA = await t229Drive(a, 'tts');
    const groupsA = t229Groups(treeA);
    const idsA = groupsA.map(function (g) { return g.options; }).flat();
    if (!idsA.some(function (o) { return /0\.42 s per audio s/.test(o.label); })) throw new Error('the reported cost is not printed: ' + idsA.map(function (o) { return o.label; }).join(' | '));
    if (idsA.filter(function (o) { return /per audio s/.test(o.label); }).length !== 1) throw new Error('a cost was printed for a model that reports none: ' + idsA.map(function (o) { return o.label; }).join(' | '));
    // The same panel on the catalog as it is today (no cost field anywhere on the wire):
    // no option says anything about cost.
    const b = t229Mount(T229_TTS, T229_TASK);
    await openAllSections(b.run, b.comp);
    const treeB = await t229Drive(b, 'tts');
    const idsB = t229Groups(treeB).map(function (g) { return g.options; }).flat();
    if (idsB.some(function (o) { return /per audio s|cost/.test(o.label); })) throw new Error('an invented cost was printed: ' + idsB.map(function (o) { return o.label; }).join(' | '));
    const bad = voidViolations(a.run).concat(voidViolations(b.run));
    if (bad.length) throw new Error(bad.length + ' void element(s) carry children');
  });

  await attempt('T-229: the tool kinds keep their lane sentence and their Run verb inside the TTS section', async function () {
    const m = t229Mount(T229_TTS, T229_TASK);
    await openAllSections(m.run, m.comp);
    const tree = await t229Drive(m, 'sep');
    const all = tree.map(ownTxt).join('\n');
    // T-452 (user 2026-10-15, verbatim): "in all 'mode selections', remove this wall of text ... for ALL". The
    // paragraph is OFF the panel, and this test now proves the other half of the ruling: the sentence did not
    // disappear, it moved onto the control it describes. The lane select's hover carries the queue fact and the
    // honoured-alone rule (TOOL_LANE_NOTE is appended to that title for exactly these kinds).
    if (all.indexOf('A tool job is spoken by the voice endpoint, in the same queue as a render') >= 0) throw new Error('the tool box prints its wall of text again');
    if (/\/v1\/tasks\/run|endpoint_wait/.test(all)) throw new Error('the tool box carries an internal name again');
    const t452LaneEls = tree.filter(function (e) { return typeof e.type === 'function' && e.type.name === 'LaneSelect' && e.props && e.props.fn === 'tts'; });
    const t452Tip = t452LaneEls.length ? String((t452LaneEls[0].props.note || '') + ' ' + (t452LaneEls[0].props.lane || '')) : '';
    const t452Sel = tree.filter(function (e) { return e.type === 'select' && hasCls(e, 'audio-play-lane') && /TOOL KIND/.test(String(e.props.title || '')); });
    if (!t452Sel.length) throw new Error('no lane control in the tool-kind tree carries the tool sentence in its hover: ' + t452Tip.slice(0, 120));
    const t452RealTip = String(t452Sel[0].props.title || '');
    if (!/TOOL KIND/.test(t452RealTip) || !/never moved somewhere else/.test(t452RealTip) || !/lines up behind a render/.test(t452RealTip)) throw new Error('the sentence left the print and did not arrive on the lane control: ' + t452RealTip.slice(0, 140));
    const run = t229Box(m, 'sep').filter(function (e) { return e.type === 'button' && ownTxt(e) === 'Separate (stems)'; });
    if (run.length !== 1) throw new Error('Run buttons: ' + run.length);
    // T-399 changed the shape of a lane that cannot start, and the intent is unchanged: with no source file typed this
    // control must not be able to START work. It is no longer `disabled` — a disabled button swallows the press, which is
    // exactly the silence the user complained about — it is aria-disabled, it carries its reason on the hover, and the
    // press reports the refusal instead of vanishing. transport.test.cjs proves the behaviour (a press dispatches
    // nothing); this check proves the shape that makes that possible.
    if (run[0].props.disabled === true) throw new Error('Run is still hard-disabled, so a press on it would be swallowed again');
    if (run[0].props['aria-disabled'] !== true) throw new Error('Run is pressable without being aria-disabled: a keyboard user would be invited to press a control that cannot start work');
    if (!/off because this tool needs audio and none is chosen/.test(String(run[0].props.title || ''))) throw new Error('Run carries no reason for being off: ' + String(run[0].props.title || '').slice(0, 90));
    // The render verb is not offered while a tool kind is showing.
    if (t229Box(m, 'sep').some(function (e) { return e.type === 'button' && ownTxt(e).indexOf('Generate (') === 0; })) throw new Error('Generate is rendered for a tool kind');
    if (!t229Box(m, 'tts').some(function (e) { return e.type === 'button' && ownTxt(e) === 'Generate (TTS)'; })) throw new Error('Generate is missing for a render kind');
    const bad = voidViolations(m.run);
    if (bad.length) throw new Error(bad.length + ' void element(s) carry children');
  });

  // --- T-242 (user report 2026-10-07): "for sound convert or sfx tools we do not show the
  //     dropdown to pin to an endpoint, like we just added to stt lane". The lane pin is a
  //     generation-task control, not a render-only one: the tool kinds get the SAME lane
  //     select, in the SAME kind/model head row, and the panel still renders ONE lane
  //     control per fn (the tts one + the stt one) — never a second, tool-only lane.
  await attempt('T-242: the lane pin renders for a tool kind too, in the kind/model head row, and the panel keeps one lane control per fn', async function () {
    const m = t229Mount(T229_TTS, T229_TASK);
    await openAllSections(m.run, m.comp);
    await t229Drive(m, 'sep');
    // Whole panel, ONE fresh render batch (rt.created accumulates across passes).
    const markAll = m.run.rt.created.length;
    m.run.render(m.comp());
    const panel = m.run.rt.created.slice(markAll);
    const panelLanes = panel.filter(function (e) { return e.type === 'select' && hasCls(e, 'audio-play-lane'); });
    if (panelLanes.length !== 2) throw new Error('lane selects in the panel with a tool kind selected: ' + panelLanes.length + ' (want the tts one + the stt one)');
    if (String(panelLanes[0].props.value) !== 'auto') throw new Error('tool-kind lane select value: ' + panelLanes[0].props.value);
    // The tool box on its own: the lane control is a DIRECT child of the kind/model head row.
    const box = t229Box(m, 'sep');
    const lanes = box.filter(function (e) { return e.type === 'select' && hasCls(e, 'audio-play-lane'); });
    if (lanes.length !== 1) throw new Error('lane selects inside the tool-kind box: ' + lanes.length);
    const laneEls = box.filter(function (e) { return typeof e.type === 'function' && e.type.name === 'LaneSelect'; });
    if (laneEls.length !== 1) throw new Error('lane controls inside the tool-kind box: ' + laneEls.length);
    if (String(laneEls[0].props.fn) !== 'tts') throw new Error('the tool kind got a lane control for fn ' + laneEls[0].props.fn);
    const kindSel = t229Sel(box, 'audio-play-kind');
    const modelSel = t229Sel(box, 'audio-play-model');
    // T-454 (user 2026-10-15, verbatim): "move the 'lane: dropdown' - selector on the right side of the generate
    // button". ONE control, ONE state, the same element (T-242's no-second-copy rule holds: it moved, it was not
    // duplicated) — but its row is the one that starts the job. The head row keeps kind + model and nothing else.
    const headRow = box.filter(function (e) {
      if (e.type !== 'div' || !Array.isArray(e.props.children)) return false;
      const kids = e.props.children;
      return kids.indexOf(kindSel) >= 0 && kids.indexOf(modelSel) >= 0;
    }).pop();
    if (!headRow) throw new Error('the kind/model head row is gone from the tool branch');
    if (headRow.props.children.indexOf(laneEls[0]) >= 0) throw new Error('the lane control is still in the head row of the tool branch');
    const runRow454 = box.filter(function (e) {
      if (e.type !== 'div' || !Array.isArray(e.props.children)) return false;
      const kids = e.props.children;
      const hasRun = kids.some(function (k) { return k && k.type === 'button' && ownTxt(k) === 'Separate (stems)'; });
      return hasRun && kids.indexOf(laneEls[0]) >= 0;
    }).pop();
    if (!runRow454) throw new Error('the lane control is not a child of the row that carries the Run button');
    const runKids454 = runRow454.props.children;
    const runIdx454 = runKids454.findIndex(function (k) { return k && k.type === 'button' && ownTxt(k) === 'Separate (stems)'; });
    if (runKids454.indexOf(laneEls[0]) < runIdx454) throw new Error('the lane control sits BEFORE the button rather than on its right side');
    if (String(lanes[0].props.value) !== 'auto') throw new Error('tool-kind lane value: ' + lanes[0].props.value);
    // Honest wording, and ONLY for a tool kind.
    const tip = String(lanes[0].props.title || '');
    if (!/TOOL KIND/.test(tip)) throw new Error('the tool lane select does not name the endpoint the tool runs on: ' + tip.slice(0, 90));
    // U-18: the row key (endpoint_wait) left the hover; the honoured-alone rule is now stated as plainly
    // as it was, in words - "it is never moved somewhere else".
    if (!/never moved somewhere else/.test(tip)) throw new Error('the tool lane select no longer states that a pin is honoured alone: ' + tip.slice(0, 220));
    if (tip.indexOf('speech queue') < 0 || tip.indexOf('speech endpoints') < 0) throw new Error('the tool lane select does not say the tool shares the queue and the endpoints with renders: ' + tip.slice(0, 220));
    const renderBox = t229Box(m, 'tts');
    const rLanes = renderBox.filter(function (e) { return e.type === 'select' && hasCls(e, 'audio-play-lane'); });
    if (rLanes.length !== 1) throw new Error('lane selects inside the render-kind box: ' + rLanes.length);
    const rLaneEls = renderBox.filter(function (e) { return typeof e.type === 'function' && e.type.name === 'LaneSelect'; });
    if (rLaneEls.length !== 1) throw new Error('lane controls inside the render-kind box: ' + rLaneEls.length);
    // T-454 (user 2026-10-15): the render kind shares the ONE control with the tool kinds, and both now sit
    // beside the button that starts the job. The head row keeps kind + model and nothing else — the control is
    // shared by being MOVED, not by being duplicated, which is what T-242 was protecting.
    const rHeadRow = renderBox.filter(function (e) {
      if (e.type !== 'div' || !Array.isArray(e.props.children)) return false;
      const kids = e.props.children;
      return kids.indexOf(t229Sel(renderBox, 'audio-play-kind')) >= 0
        && kids.indexOf(t229Sel(renderBox, 'audio-play-model')) >= 0;
    }).pop();
    if (!rHeadRow) throw new Error('the render kind lost its kind/model head row');
    if (rHeadRow.props.children.indexOf(rLaneEls[0]) >= 0) throw new Error('the render lane control is still sitting in the head row');
    const rRunRow454 = renderBox.filter(function (e) {
      if (e.type !== 'div' || !Array.isArray(e.props.children)) return false;
      const kids = e.props.children;
      const hasGen = kids.some(function (k) { return k && k.type === 'button' && ownTxt(k) === 'Generate (TTS)'; });
      return hasGen && kids.indexOf(rLaneEls[0]) >= 0;
    }).pop();
    if (!rRunRow454) throw new Error('the render lane control is not a child of the row that carries Generate');
    const rKids454 = rRunRow454.props.children;
    const rGenIdx454 = rKids454.findIndex(function (k) { return k && k.type === 'button' && ownTxt(k) === 'Generate (TTS)'; });
    if (rKids454.indexOf(rLaneEls[0]) < rGenIdx454) throw new Error('the render lane control sits BEFORE Generate rather than on its right side');
    const rTip = String(rLanes[0].props.title || '');
    if (/TOOL KIND/.test(rTip)) throw new Error('the render kind got the tool wording: ' + rTip.slice(0, 90));
    // U-18 tooltip policy: the T-195 wording named a request field. The sentence is the same contract in
    // operator words, so the test follows the words, not the field name.
    if (rTip.indexOf('which endpoint this job asks for.') !== 0) throw new Error('the render lane select lost the T-195 contract title: ' + rTip.slice(0, 90));
    // The pin rule lives in the hover of the control that sets it (checked above). What the visible tool
    // sentence has to carry is what the person sees: a tool job queues behind a render on the same endpoint.
    // U-18 (2026-10-13) took the row key out of that sentence, so this reads the sentence, not the bracket.
    // T-452 (user 2026-10-15): the visible sentence is gone by ruling, not by accident. What this test now
    // requires is that the SAME fact is stated where the choice is made — the hover of the lane control in the
    // tool box — and that nothing printed carries an internal name.
    const cap242 = box.map(ownTxt).join('\n');
    if (cap242.indexOf('A tool job is spoken by the voice endpoint, in the same queue as a render') >= 0) throw new Error('the tool box prints the wall of text again');
    const cap242Sel = box.filter(function (e) { return e.type === 'select' && hasCls(e, 'audio-play-lane') && /TOOL KIND/.test(String(e.props.title || '')); });
    if (!cap242Sel.length) throw new Error('no lane control in the tool box carries the shared-queue sentence in its hover');
    if (!/shares the speech queue|lines up behind a render/.test(String(cap242Sel[0].props.title))) throw new Error('the shared-queue fact is not on the lane control: ' + String(cap242Sel[0].props.title).slice(0, 140));
    if (/endpoint_wait|\/v1\/tasks\/run/.test(cap242)) throw new Error('the tool box caption carries an internal name again');
    const bad242 = voidViolations(m.run);
    if (bad242.length) throw new Error(bad242.length + ' void element(s) carry children');
  });

  await attempt('T-229: a target the registry or the playlist no longer carries is SHOWN on the select, never dispatched unseen', async function () {
    const m = t229Mount(T229_TTS, T229_TASK);   // voice_registry answers empty, playlist answers empty
    await openAllSections(m.run, m.comp);
    const tree = t229Box(m, 'vc', { toolTargetVoice: 'voy_doctor', toolTargetRow: 'ap-0451', toolFile: '/tmp/src.wav' });
    const vSel = tree.filter(function (e) { return e.type === 'select' && String(e.props.title || '').indexOf('the voice this job clones') === 0; }).pop();
    if (!vSel) throw new Error('the voice-convert target voice select is not rendered');
    const vOpts = flatKids(vSel).filter(function (e) { return e && e.type === 'option'; }).map(function (o) { return { value: o.props.value, label: ownTxt(o) }; });
    const staleV = vOpts.filter(function (o) { return o.value === 'voy_doctor'; });
    if (staleV.length !== 1) throw new Error('the stored target voice is not offered as an option: ' + vOpts.map(function (o) { return o.value; }).join(','));
    if (!/not in the registry/.test(staleV[0].label)) throw new Error('the stale target voice is offered without saying why: ' + staleV[0].label);
    if (String(vSel.props.value) !== 'voy_doctor') throw new Error('the select does not show the value dispatch would send: ' + vSel.props.value);
    const rSel = tree.filter(function (e) { return e.type === 'select' && String(e.props.title || '') === 'or use a playlist row as the target voice sample'; }).pop();
    if (!rSel) throw new Error('the voice-convert target row select is not rendered');
    const rOpts = flatKids(rSel).filter(function (e) { return e && e.type === 'option'; }).map(function (o) { return { value: o.props.value, label: ownTxt(o) }; });
    const staleR = rOpts.filter(function (o) { return o.value === 'ap-0451'; });
    if (staleR.length !== 1) throw new Error('the stored target row is not offered as an option: ' + rOpts.map(function (o) { return o.value; }).join(','));
    if (!/not in the playlist/.test(staleR[0].label)) throw new Error('the stale target row is offered without saying why: ' + staleR[0].label);
    const bad = voidViolations(m.run);
    if (bad.length) throw new Error(bad.length + ' void element(s) carry children');
  });

  // --- T-351 (T-278, user ruling 2026-10-14: "panel-side estimate for single dispatches"). A single job has
  //     no dry_run verb, so the panel answers the question itself from the answers the host already sends,
  //     with the host's own bars (index.js evaluateEndpoints) and no invented booking.
  console.log('\n--- T-476: the model dropdown says which separator separates WHAT ---');
  await attempt('T-468 item 29 (2026-10-17): the dispatch format select says what asking for mp3 or ogg does to the '
      + 'STORE, because the ruling of 2026-10-16 changed that answer', async function () {
    const m = t229Mount(T229_TTS, T229_TASK);
    await openAllSections(m.run, m.comp);
    const tree = await t229Drive(m, 'gen');
    // The control is found by what it offers, not by a class it does not have: it is the panel's ONE select whose
    // options are exactly wav, mp3 and ogg.
    const sels = tree.filter(function (e) {
      if (e.type !== 'select') return false;
      const vals = [].concat(e.props.children || []).map(function (o) { return o && o.props && o.props.value; });
      return vals.join('|') === 'wav|mp3|ogg';
    });
    // The tree this helper returns accumulates every render pass, so the SAME control appears once per pass (measured:
    // three). The rule is therefore stated over all of them: every occurrence of the choice must carry the sentence,
    // because a hover that is honest on one render and stale on the next is not honest.
    if (!sels.length) throw new Error('no select in the TTS section offers wav, mp3 and ogg');
    const tips468 = sels.map(function (e) { return String(e.props.title || ''); });
    if (tips468.some(function (x) { return !/converted locally with ffmpeg/.test(x); }))
      throw new Error('a format select no longer says what the conversion is: ' + tips468[0].slice(0, 160));
    if (tips468.some(function (x) { return !/KEEPS the take/.test(x) || !/nothing stored is replaced/.test(x); }))
      throw new Error('a format select still describes the build that deleted the rendered take: ' + tips468[0].slice(0, 240));
  });

  await attempt('T-476: the separation model option carries a hover naming the tracks it answers, because the catalog cannot say it', async function () {
    const m = t229Mount(T229_TTS, T229_TASK);
    await openAllSections(m.run, m.comp);
    const tree = await t229Drive(m, 'sep');
    const sel476 = t229Sel(tree, 'audio-play-model');
    if (!sel476) throw new Error('no .audio-play-model select rendered');
    const opts476 = [];
    flatKids(sel476).filter(function (e) { return e && e.type === 'optgroup'; }).forEach(function (g) {
      flatKids(g).filter(function (o) { return o && o.type === 'option'; }).forEach(function (o) {
        opts476.push({ value: o.props.value, label: ownTxt(o), tip: String(o.props.title || ''), raw: o.props.title });
      });
    });
    const bs = opts476.filter(function (o) { return o.value === 'bs_roformer'; }).pop();
    if (!bs) throw new Error('bs_roformer is not in the tool model list: ' + opts476.map(function (o) { return o.value; }).join(','));
    if (!/VOICE separator/.test(bs.tip)) throw new Error('the bs_roformer hover says: ' + bs.tip);
    if (!/vocals and instrumental/.test(bs.tip)) throw new Error('the hover does not name the two tracks it answers: ' + bs.tip);
  });
  await attempt('T-476: a model with no note gets NO hover of its own - the panel does not pad every option with text it has not measured', async function () {
    const m = t229Mount(T229_TTS, T229_TASK);
    await openAllSections(m.run, m.comp);
    const tree = await t229Drive(m, 'gen');
    const sel476g = t229Sel(tree, 'audio-play-model');
    if (!sel476g) throw new Error('no .audio-play-model select rendered for the generate kind');
    const opts476 = [];
    flatKids(sel476g).filter(function (e) { return e && e.type === 'optgroup'; }).forEach(function (g) {
      flatKids(g).filter(function (o) { return o && o.type === 'option'; }).forEach(function (o) {
        opts476.push({ value: o.props.value, label: ownTxt(o), tip: String(o.props.title || ''), raw: o.props.title });
      });
    });
    const cf = opts476.filter(function (o) { return o.value === 'controlfoley'; }).pop();
    if (!cf) throw new Error('controlfoley is not in the gen list: ' + opts476.map(function (o) { return o.value; }).join(','));
    if (cf.raw !== undefined) throw new Error('a tool model with no note got a hover anyway: ' + String(cf.raw));
  });
  await attempt('T-476: the music separator is named AS one, and both voice separators are named as the better choice for speech, with the measured numbers beside them', async function () {
    const src476 = require('fs').readFileSync(TARGET, 'utf8');
    const i476 = src476.indexOf('var SEP_MODEL_NOTE476');
    if (i476 < 0) throw new Error('no guidance map in the panel source');
    const seg476 = src476.slice(i476, i476 + 3000);
    const h = seg476.slice(seg476.indexOf('htdemucs_q8:'), seg476.indexOf('bs_roformer:'));
    if (!/MUSIC separator/.test(h)) throw new Error('the htdemucs entry does not call it a music separator');
    if (!/drums, bass, other, vocals/.test(h)) throw new Error('the htdemucs entry does not name the four stems it answers: ' + h.slice(0, 200));
    if (h.indexOf('bs_roformer or mel_band_roformer') < 0) throw new Error('the htdemucs entry does not name the two models that serve speech better');
    if (!/206 634 ms/.test(seg476) || !/44 433 ms/.test(seg476)) throw new Error('the two RoFormer entries do not carry the render times measured on the Vulkan lane');
    if (seg476.indexOf('htdemucs_f16:') < 0) throw new Error('the f16 build is not covered — the user named htdemucs_q8@q8_0 and htdemucs_f16@f16');
  });

  console.log('\n--- T-351: the panel-side dry run for a single dispatch ---');
  const t351_props = function (over) {
    const rec = seen.get('TtsBox');
    if (!rec) throw new Error('TtsBox was never reached');
    const p = shapePopulated(Object.assign({}, rec.props));
    p.models = { tts: [{ id: 'm1', loaded: true }], stt: [{ id: 's1', loaded: false }], task: [{ id: 'htdemucs', task: 'sep' }] };
    p.selModel = { tts: 'm1', stt: 's1', task: 'htdemucs' };
    p.selVoice = { tts: 'v1', stt: '' };
    p.selLane = { tts: 'auto', stt: 'auto' };
    p.primaryView = { tts: { id: 'primary', url: 'http://cpu2.test:8963', enabled: true, held_by: '', models: ['m1'] } };
    p.registry = { tts: [
      { id: 'e-5', url: 'http://cpu1.test:8963', host: 'cpu1.test', enabled: true, held_by: '', batch_allowed: false, models: ['m1'] },
      { id: 'e-10', url: 'http://gpu1.test:8963', host: 'gpu1.test', enabled: false, held_by: 'operator', hold_reason: 'taken out of placement by hand', batch_allowed: true, models: ['m1'] }
    ], stt: [] };
    p.queues = { tts: { paused: false, queued: 0, slots: { max: 2, used: 1 }, endpoints: [
      { id: 'primary', host: 'cpu2.test', running_job_id: null },
      { id: 'e-5', host: 'cpu1.test', running_job_id: 'ap-0501' },
      { id: 'e-10', host: 'gpu1.test', running_job_id: null },
    ] } };
    p.machines = { 'cpu1.test': { host: 'cpu1.test', jobs: [{ id: 'ap-0501', fn: 'tts' }] }, 'cpu2.test': { host: 'cpu2.test', jobs: [] } };
    return Object.assign(p, over || {});
  };
  const t351_hint = function (p) {
    const mark = shim.rt.created.length;
    // T-404 (user ruling 2026-10-15): the line no longer rides on the render kind of the TTS section, so the
    // dry-run drives the estimate component with the same props the section hands it: fn, model, lane,
    // registry, primary, queues, machines, catalog. Nothing about the claims below changed.
    shim.renderComponent(fnByName.PlacementHint351, {
      fn: 'tts',
      model: (p.selModel || {}).tts,
      lane: (p.selLane || {}).tts,
      registry: (p.registry || {}).tts,
      primary: (p.primaryView || {}).tts,
      queues: p.queues, machines: p.machines, catalog: p.models,
    }, { fresh: true, effects: false });
    const tree = shim.rt.created.slice(mark);
    const hits = withCls(tree, 'audio-play-placement-hint351');
    if (hits.length > 1) throw new Error('the estimate line is mounted ' + hits.length + ' times in one section');
    const el = hits[0] || null;
    return { el: el, txt: el ? ownTxt(el) : '', tip: el ? String(el.props.title || '') : '' };
  };

  await attempt('T-351: the line names the free endpoint, the one that would WAIT, and the one that CANNOT take it, each with its reason', function () {
    const h = t351_hint(t351_props());
    if (!h.el) throw new Error('no estimate line was rendered at all');
    // T-452 (user 2026-10-15, verbatim): "in all 'mode selections', remove this wall of text ... for ALL". The
    // estimate line stays (T-351 was the user's own ruling) but it PRINTS THE STATE and keeps the reasons on its
    // hover, which is where the user put them: "we already have this in the hover tooltips!". Every claim this
    // block used to make on the row is still made — the names on the line, the reasons in the hover.
    if (!(/^now ·/.test(h.txt))) throw new Error('the line does not read as the state of a send, now: ' + h.txt);
    if (!/free TTS1 cpu2\.test/.test(h.txt)) throw new Error('the free endpoint is not named on the line: ' + h.txt);
    if (!/waits TTS2 cpu1\.test/.test(h.txt)) throw new Error('the waiting candidate is not named on the line: ' + h.txt);
    if (!/cannot TTS3 gpu1\.test/.test(h.txt)) throw new Error('the blocked candidate is not named on the line: ' + h.txt);
    if (!/if you sent this now/.test(h.tip)) throw new Error('the hover no longer says this is an estimate of a send: ' + h.tip.slice(0, 90));
    if (!/could take it but waits: TTS2 cpu1\.test \(slot busy \(ap-0501\), machine holds ap-0501\)/.test(h.tip))
      throw new Error('the waiting reason left the print and did not arrive in the hover: ' + h.tip.slice(0, 170));
    if (!/cannot take it: TTS3 gpu1\.test \(disabled \(held by you\)/.test(h.tip))
      throw new Error('the blocked reason does not name WHO holds the endpoint: ' + h.tip.slice(0, 170));
    // The panel may not claim a booking it cannot know: the line marks the lane unpinned, the hover disclaims the choice.
    if (!(/· auto$/.test(h.txt))) throw new Error('the line does not mark the lane as unpinned: ' + h.txt);
    if (!/which free endpoint the lane will pick/.test(h.tip) || !/host\u2019s choice/.test(h.tip))
      throw new Error('the hover does not disclaim the choice: ' + h.tip);
  });

  await attempt('T-503 patch E on the client board: a hold the PLUGIN applied is a SOFT bar (the row waits there), a hold a PERSON applied is a HARD bar (it cannot take the job at all)', function () {
    const pE = t351_props({ registry: { tts: [
      { id: 'e-5', url: 'http://cpu1.test:8963', host: 'cpu1.test', enabled: false, held_by: 'plugin', hold_reason: 'auto-paused after 3 connection failures (current streak 3)', batch_allowed: true, models: ['m1'] },
      { id: 'e-10', url: 'http://gpu1.test:8963', host: 'gpu1.test', enabled: false, held_by: 'operator', hold_reason: 'taken out of placement by hand', batch_allowed: true, models: ['m1'] },
    ], stt: [] } });
    const hE = t351_hint(pE);
    // The plugin's brake: the candidate is still a candidate, it just waits.
    if (!/waits TTS2 cpu1\.test \(disabled - held by the plugin after its own failed reads/.test(hE.txt))
    if (!/waits TTS2 cpu1\.test/.test(hE.txt)) throw new Error('the plugin hold did not leave the blocked group: ' + hE.txt);
    if (!/could take it but waits: TTS2 cpu1\.test \(disabled - held by the plugin after its own failed reads/.test(hE.tip))
      throw new Error('the plugin hold is not named as the plugin\u2019s own on the hover: ' + hE.tip.slice(0, 200));
    if (!/cannot take it: TTS3 gpu1\.test \(disabled \(held by you\)/.test(hE.tip))
      throw new Error('the operator hold does not name the holder on the hover: ' + hE.tip.slice(0, 200));
    if (/held by you/.test(hE.tip) && /cpu1/.test(hE.tip.split('cannot take it')[1] || ''))
      throw new Error('the plugin hold was described with the operator wording: ' + hE.tip.slice(0, 200));
  });

  await attempt('T-351: batch_allowed:false is NOT a bar for a single dispatch (it bars dispatch_batch parts only)', function () {
    const h = t351_hint(t351_props());
    if (/batch/.test(h.txt) || /batch/.test(h.tip)) throw new Error('the panel bars a candidate on batch_allowed for a plain dispatch: ' + h.txt);
    if (/cannot take it:[^)]*cpu1/.test(h.tip)) throw new Error('a batch-disallowed endpoint was ruled out for a single job: ' + h.tip.slice(0, 170));
  });

  await attempt('T-351: an endpoint whose own model answer does not list the model is ruled out, in the host\u2019s words, not guessed away', function () {
    const p = t351_props();
    p.registry = { tts: [{ id: 'e-6', url: 'http://cpu1.test:8963', host: 'cpu1.test', enabled: true, paused: false, batch_allowed: true, models: ['other_model'] }], stt: [] };
    p.queues = { tts: { paused: false, queued: 0, endpoints: [{ id: 'e-6', host: 'cpu1.test', running_job_id: null }] } };
    p.machines = {};   // this scenario is about the model bar alone
    const h = t351_hint(p);
    if (!/cannot TTS2 cpu1\.test/.test(h.txt)) throw new Error('the ruled-out endpoint is not named on the line: ' + h.txt);
    if (!/does not list m1/.test(h.tip)) throw new Error('the model bar left the print and is not in the hover either: ' + h.tip.slice(0, 170));
  });

  await attempt('T-351: an endpoint with NO model answer is said to have no answer, and a primary with no catalog is never refused on one', function () {
    const p = t351_props();
    p.registry = { tts: [{ id: 'e-7', url: 'http://gpu1.test:8963', host: 'gpu1.test', enabled: true, paused: false, batch_allowed: true, models: [] }], stt: [] };
    p.primaryView = { tts: { id: 'primary', url: 'http://cpu2.test:8963', enabled: true, paused: false } };
    p.models = { tts: [], stt: [], task: [] };
    p.queues = { tts: { paused: false, queued: 0, endpoints: [{ id: 'primary' }, { id: 'e-7', host: 'gpu1.test' }] } };
    const h = t351_hint(p);
    if (!/no model answer for this endpoint yet/.test(h.tip)) throw new Error('the unknown capability is not said in the hover: ' + h.tip.slice(0, 170));
    if (/cannot take it:[^)]*cpu2/.test(h.tip)) throw new Error('the primary was refused on a missing catalog, which the host never does: ' + h.tip.slice(0, 170));
  });

  await attempt('T-351: a PINNED job narrows the estimate to the pinned endpoint and says so out loud', function () {
    const h = t351_hint(t351_props({ selLane: { tts: 'e-10', stt: 'auto' } }));
    if (!(/· pinned e-10$/.test(h.txt))) throw new Error('the pin is not named on the line: ' + h.txt);
    if (/TTS1 cpu2|TTS2 cpu1/.test(h.txt)) throw new Error('a pinned estimate still lists the endpoints a pin excludes: ' + h.txt);
    if (!/PINNED to e-10/.test(h.tip) || !/waits on it instead of moving/.test(h.tip)) throw new Error('the hover does not name the pin rule: ' + h.tip);
    if (!/disabled/.test(h.tip)) throw new Error('the pinned endpoint is disabled and the hover does not say so: ' + h.tip.slice(0, 170));
  });

  await attempt('T-351: nothing is printed when there is nothing to place (no model picked, or the lane has not been read)', function () {
    const a = t351_hint(t351_props({ selModel: { tts: '', stt: 's1', task: 'htdemucs' } }));
    if (a.el) throw new Error('an estimate appeared with no model selected: ' + a.txt);
    const b = t351_hint(t351_props({ registry: null, primaryView: null }));
    if (b.el) throw new Error('an estimate appeared with no registry and no primary view: ' + b.txt);
  });

  await attempt('T-404 (user ruling 2026-10-15): the render kind of the TTS section shows NO capacity-preview line — it was too much information for the person about to press Generate', function () {
    const renderMark = shim.rt.created.length;
    shim.renderComponent(fnByName.TtsBox, t351_props({ kind: 'tts' }), { fresh: true, effects: false });
    const renderTree = shim.rt.created.slice(renderMark);
    const inRender = withCls(renderTree, 'audio-play-placement-hint351');
    if (inRender.length) throw new Error('the estimate line is still mounted for a render kind: ' + ownTxt(inRender[0]));
    const toolMark = shim.rt.created.length;
    shim.renderComponent(fnByName.TtsBox, t351_props({ kind: 'sep', selModel: { tts: 'm1', stt: 's1', task: 'htdemucs' }, models: { tts: [{ id: 'm1', loaded: true }], stt: [], task: [{ id: 'htdemucs', task: 'sep' }] } }), { fresh: true, effects: false });
    const toolTree = shim.rt.created.slice(toolMark);
    // The shim records a child component by its function source, not by a short name, so the tool branch
    // is recognised by the ToolsBox component appearing at all.
    if (!toolTree.some(function (e) { return String(e.type).indexOf('ToolsBox') >= 0; })) throw new Error('the tool branch was not reached, so its estimate line was never tested');
    if (!withCls(toolTree, 'audio-play-placement-hint351').length) throw new Error('the estimate line went with the render kind and took the tool kinds with it');
  });

  await attempt('S-1 / T-210 / T-208 / T-212: the whole panel still builds no void element with children', function () {
    const bad = voidViolations(shim);
    if (bad.length) throw new Error(bad.length + ' void element(s) carry children, e.g. <' + bad[0].type + '> children=' + JSON.stringify(bad[0].props.children));
  });

  await attempt('T-380: the sixth park reason is printed at last — a batch part held behind its OWN predecessor says so, and only while it is still queued', function () {
    const rows380 = function (st380) {
      return [
        { id: 'ap-0750', fn: 'tts', kind: 'tts', status: st380[0], text: 'part two of a scene held behind part one', created: 750,
          batch_id: 'b-77', batch_part: 2, batch_parts: 3, batch_order_wait: { batch: 'b-77', part: 1, job_id: 'ap-0749' } },
        { id: 'ap-0751', fn: 'tts', kind: 'tts', status: st380[1], text: 'a part parked behind a paused lane', created: 751,
          batch_id: 'b-77', batch_part: 3, batch_parts: 3, lane_wait: { paused_by: 'operator', reason: 'pause_fn', fn: 'tts' } },
      ];
    };
    const look380 = function (st380) {
      const mark380 = shim.rt.created.length;
      shim.renderComponent(seen.get('PlaylistPane').fn, plProps(rows380(st380), T210_REG), { fresh: true, effects: false });
      const tree380 = shim.rt.created.slice(mark380);
      const chips = withCls(tree380, 'audio-play-batch-order-wait380');
      return {
        n: chips.length,
        txt: chips.map(ownTxt).sort().join(' | '),
        tip: chips.map(function (e) { return String((e.props || {}).title || ''); }).join(' '),
        hoverLines: tree380.filter(function (e) { return /waits for part 1 of its own batch b-77/.test(String((e.props || {}).title || '')) || /lane paused \(by a person\)/.test(String((e.props || {}).title || '')); }).length,
      };
    };
    const q380 = look380(['queued', 'queued']);
    if (q380.n !== 1) throw new Error('the batch-order park chip was not printed for the queued part held behind its predecessor: ' + JSON.stringify(q380));
    if (q380.txt !== 'part 1 waits') throw new Error('the chip does not name the part number it waits for: ' + JSON.stringify(q380));
    if (!/batch b-77/.test(q380.tip) || !/part 1/.test(q380.tip) || !/ap-0749/.test(q380.tip) || !/not a failure/.test(q380.tip)) throw new Error('the chip hover is incomplete: ' + q380.tip);
    if (q380.hoverLines < 2) throw new Error('the row hover popup still keeps silent about the batch order wait or the lane pause: ' + JSON.stringify(q380));
    const gone380 = look380(['ok', 'cancelled']);
    if (gone380.n !== 0) throw new Error('a row that left the queue still wears the batch-order wait chip: ' + JSON.stringify(gone380));
  });

  // T-624 (operator request 2026-10-21): the captured row's play door, and the row's own save-voice menu.
  await attempt('T-624: a captured (upload) row gets a play door, and only once its file is there', function () {
    // "the presented ap in playlist from the youtube download does not present a play button, ap-0141 should be able
    // to play". ap-0141 is kind 'upload' with route_url and a 270 MB file on disk, and the main door only ever named
    // tts / file / task. A failed capture still gets nothing: there is no audio in it.
    const noop624 = function () {};
    const rows624 = [
      { id: 'u1', fn: 'tts', kind: 'upload', status: 'ok', filename: 'ap-0141_YwDVtf7-KWc.wav', output_path: '/x/ap-0141_YwDVtf7-KWc.wav', route_url: '/deepamp/u1', dl_url: '/deepamp/u1?dl=1', duration: 1408.2, size_bytes: 270382890, note: 'captured from https://example.invalid/watch?v=YwDVtf7-KWc via yt-dlp (Youtube)' },
      { id: 'u2', fn: 'tts', kind: 'upload', status: 'error', filename: 'ap-0142_x.wav', error: 'download failed' },
      { id: 'f1', fn: 'tts', kind: 'file', status: 'ok', output_path: '/x/ap-0142.wav', route_url: '/deepamp/f1', duration: 12.4 },
    ];
    const played624 = [];
    const mark624 = shim.rt.created.length;
    shim.renderComponent(fnByName.PlaylistPane, {
      playlist: rows624, limit: 20, queues: null, play: function (id) { played624.push(id); }, deleteJob: noop624,
      cancel: noop624, saveDesign: noop624, playSrc: noop624, playStem: noop624, viewDiar: noop624,
      retry: noop624, reuseText: noop624,
    }, { fresh: true, effects: false });
    const tree624 = shim.rt.created.slice(mark624);
    const main624 = tree624.filter(function (e) { return e.type === 'button' && JSON.stringify(e.props.children) === '"\u25B6"'; });
    if (main624.length !== 2) throw new Error('expected a play door on the capture and on the slice row, and none on the failed capture: ' + main624.length);
    main624.forEach(function (e) { if (typeof e.props.onClick === 'function') e.props.onClick(); });
    if (played624.length !== 2 || played624.indexOf('u1') < 0 || played624.indexOf('f1') < 0)
      throw new Error('the play doors do not reach props.play with their own row id: ' + JSON.stringify(played624));
    // The source shape is pinned too, because the whole fault was a kind list: 'upload' has to be IN the gate, and
    // the status test has to stay beside it.
    const src624 = require('fs').readFileSync(TARGET, 'utf8');
    const gate624 = src624.match(/\(j\.kind === "tts" \|\| j\.kind === "file" \|\| j\.kind === "task" \|\| j\.kind === "upload"\) && j\.status === "ok"/);
    if (!gate624) throw new Error('the main play gate no longer names upload inside the same status test');
    if (src624.split(/\(j\.kind === "tts" \|\| j\.kind === "file" \|\| j\.kind === "task" \|\| j\.kind === "upload"\) && j\.status === "ok"/).length - 1 !== 1)
      throw new Error('the four-kind play gate appears more than once - a second door was opened somewhere else');
  });

  await attempt('T-624: an audio row offers its own save-voice door, a design row keeps the one it already had, a transcript row gets none', function () {
    const noop624 = function () {};
    const rows624 = [
      { id: 'u1', fn: 'tts', kind: 'upload', status: 'ok', output_path: '/x/ap-0141.wav', route_url: '/deepamp/u1', duration: 1408.2 },
      { id: 'f1', fn: 'tts', kind: 'file', status: 'ok', output_path: '/x/ap-0142.wav', route_url: '/deepamp/f1', duration: 12.4 },
      { id: 'd1', fn: 'tts', kind: 'tts', status: 'ok', model: 'voice_design', design: true, output_path: '/x/ap-0143.wav', route_url: '/deepamp/d1', duration: 6.1 },
      { id: 's1', fn: 'stt', kind: 'stt', status: 'ok', output_path: '/x/ap-0144.txt', route_url: '/deepamp/s1', transcript: 'words' },
      { id: 'n1', fn: 'tts', kind: 'file', status: 'ok', route_url: '/deepamp/n1' },
      // T-631 (2026-10-22): the two rows the operator's complaint is about, in the shape the live host answers them
      // (playlist_list read 2026-10-22 02:5x Berlin: 38 gen rows, 8 vc rows, task_kind absent everywhere else).
      { id: 'm1', fn: 'tts', kind: 'task', task_kind: 'gen', family: 'stable_audio', model: 'stable_audio_medium', status: 'ok', output_path: '/x/ap-0160.wav', route_url: '/deepamp/m1', duration: 240 },
      { id: 'v1', fn: 'tts', kind: 'task', task_kind: 'vc', family: 'rvc', model: 'rvc_f16', status: 'ok', output_path: '/x/ap-0149.wav', route_url: '/deepamp/v1', duration: 18.4 },
    ];
    const opened624 = [];
    const designed624 = [];
    const mark624 = shim.rt.created.length;
    shim.renderComponent(fnByName.PlaylistPane, {
      playlist: rows624, limit: 20, queues: null, play: noop624, deleteJob: noop624, cancel: noop624,
      saveDesign: function (id) { designed624.push(id); }, playSrc: noop624, playStem: noop624, viewDiar: noop624, retry: noop624, reuseText: noop624,
      toggleVoiceMenu624: function (id) { opened624.push(id); },
    }, { fresh: true, effects: false });
    const tree624 = shim.rt.created.slice(mark624);
    const cls624 = function (e) { return String((e && e.props && e.props.className) || ''); };
    // T-631 RE-POINT (2026-10-22, operator item 3: "replace text of 'save voice' button with a 'mouth' Icon if
    // available and remove blue border - normal style"). "If available" was answered by AUTHORING the shape in the
    // panel's own idiom (TGLYPH316's chunky 16x16 currentColor paths, no font, no picture file, no emoji), so the
    // doors now carry the row-glyph and NO word at all: the hover is what names the act. The door is recognised
    // here by that glyph, and one pin below proves no text label survived on it.
    // T-631 RE-POINT (2026-10-23, operator item 25: "save voice button needs better symbol, current one looks too
    // much like 'convert' symbol"): the two stacked bars read as arrows, so the face is now the mic the operator
    // chose from the four offered. The helper keeps its 624 name; only the glyph it recognises moved, and the claim
    // this suite proves - a glyph, no word - is unchanged.
    const mouthChild624 = function (e) {
      const kids624 = Array.isArray((e && e.props || {}).children) ? e.props.children : [(e && e.props || {}).children];
      return kids624.filter(function (k) { return k && k.type === 'svg' && String((k.props || {}).className || '').indexOf('audio-play-row-glyph631-mic') >= 0; });
    };
    const anySave624 = tree624.filter(function (e) { return e.type === 'button' && mouthChild624(e).length === 1; });
    const newDoor624 = anySave624.filter(function (e) { return cls624(e).split(/\s+/).indexOf('audio-play-savevoice624') >= 0; });
    // T-631 RE-POINT (2026-10-22): the count moved because the fixture now holds the two rows the operator's
    // complaint names. The door sits on the capture, the slice row and the CONVERSION row - and not on the generated
    // music row. Which row each door belongs to is read off the press, not off an assumed render order.
    if (anySave624.length !== 4) throw new Error('expected a save-voice door on the capture, the slice row, the conversion row and the design render: ' + anySave624.length);
    if (newDoor624.length !== 3) throw new Error('the new door is not on exactly the capture, the slice row and the conversion row: ' + newDoor624.length);
    newDoor624.forEach(function (e) { e.props.onClick(); });
    if (opened624.slice().sort().join(',') !== 'f1,u1,v1')
      throw new Error('the save-voice doors opened on the wrong rows: ' + JSON.stringify(opened624));
    if (opened624.indexOf('m1') >= 0) throw new Error('a generated sfx / music row was offered the save-voice door the operator asked to take off it');
    if (designed624.length !== 0) throw new Error('a new door pressed the design path: ' + JSON.stringify(designed624));
    const oldDoor624 = anySave624.filter(function (e) { return cls624(e).indexOf('audio-play-savevoice624') < 0; });
    if (oldDoor624.length !== 1 || !/voice-design render/.test(String(oldDoor624[0].props.title)))
      throw new Error('the design render lost the door it already had, or a second one was opened on it: ' + anySave624.length);
    // T-631 item 3: neither door carries the blue border any more - both are the row's normal button style.
    if (anySave624.some(function (e) { var s631 = ((e.props || {}).style || {}); return /8ab4f8/.test(String(s631.borderColor || '')) || /1d2433/.test(String(s631.background || '')); }))
      throw new Error('a save-voice door still carries the blue border the operator asked to remove');
    if (anySave624.some(function (e) { return /transcript row/.test(String(e.props.title || "")); }))
      throw new Error('a transcript row is being offered a voice it cannot make');
    if (anySave624.some(function (e) {
      const kids624 = Array.isArray(e.props.children) ? e.props.children : [e.props.children];
      return kids624.some(function (k) { return typeof k === 'string' && /voice/i.test(k); }) || !/mic/.test(String(mouthChild624(e)[0].props.className));
    })) throw new Error('a save-voice door still carries a word, or the glyph is not the mic glyph (T-631 item 25)');
    newDoor624.forEach(function (e) {
      if (typeof e.props.onClick !== 'function') throw new Error('the save-voice door is inert');
      if (!/nothing is registered until a name is typed/.test(String(e.props.title)))
        throw new Error('the door does not say that pressing it saves nothing by itself: ' + e.props.title);
    });
  });

  await attempt('T-624: the save-voice menu holds the name field, states the cut this row would take, and presses reach the panel', function () {
    const noop624 = function () {};
    const rows624 = [
      { id: 'u1', fn: 'tts', kind: 'upload', status: 'ok', output_path: '/x/ap-0141.wav', route_url: '/deepamp/u1', duration: 1408.2 },
      { id: 'f1', fn: 'tts', kind: 'file', status: 'ok', output_path: '/x/ap-0142.wav', route_url: '/deepamp/f1', duration: 12.4 },
    ];
    const pressed624 = [];
    const marks624 = shim.rt.created.length;
    shim.renderComponent(fnByName.PlaylistPane, {
      playlist: rows624, limit: 20, queues: null, play: noop624, deleteJob: noop624, cancel: noop624,
      saveDesign: noop624, playSrc: noop624, playStem: noop624, viewDiar: noop624, retry: noop624, reuseText: noop624,
      voiceMenuId624: 'u1', toggleVoiceMenu624: function (id) { pressed624.push(['toggle', id]); },
      voiceMenuName624: 'bijan', setVoiceMenuName624: function (v) { pressed624.push(['name', v]); },
      saveRowVoice624: function (j, secs, whole631) { pressed624.push(['save', j.id, secs, whole631 === true]); },
    }, { fresh: true, effects: false });
    const tree624 = shim.rt.created.slice(marks624);
    const cls624 = function (e) { return String((e && e.props && e.props.className) || ''); };
    const menus624 = tree624.filter(function (e) { return cls624(e).split(/\s+/).indexOf('audio-play-voice-menu624') >= 0; });
    if (menus624.length !== 1) throw new Error('the menu opened on more than the pressed row, or not at all: ' + menus624.length);
    const nameInput624 = tree624.filter(function (e) { return e.type === 'input' && cls624(e).indexOf('audio-play-voice-name624') >= 0; });
    if (nameInput624.length !== 1) throw new Error('the menu has no name field in it: ' + nameInput624.length);
    if (nameInput624[0].props.value !== 'bijan') throw new Error('the name field does not show the name that was typed: ' + nameInput624[0].props.value);
    if (!/\[a-z0-9_\-\]/.test(String(nameInput624[0].props.placeholder))) throw new Error('the name field does not say what a name may contain: ' + nameInput624[0].props.placeholder);
    if (typeof nameInput624[0].props.onChange === 'function') nameInput624[0].props.onChange({ target: { value: 'newname' } });
    // T-631 RE-POINT (2026-10-22, operator item 2, verbatim): "The 'save voice dropdown' should only be 'one added
    // line in height ' with shortened button texts: 'first 15 sec as voice' -> '15 sec' + button '30 sec' + button
    // 'full' (orange border style like 'retry' button and removed text ' cut 0–15 s out of 240 s'".
    const cutBtn624 = tree624.filter(function (e) { return e.type === 'button' && cls624(e).indexOf('audio-play-voice-cut624') >= 0; });
    if (cutBtn624.length !== 1) throw new Error('the menu has no 15 sec button: ' + cutBtn624.length);
    if (JSON.stringify(cutBtn624[0].props.children) !== '"15 sec"')
      throw new Error('the cut button does not carry the shortened text the operator named: ' + JSON.stringify(cutBtn624[0].props.children));
    const cut30_631 = tree624.filter(function (e) { return e.type === 'button' && cls624(e).indexOf('audio-play-voice-cut631') >= 0; });
    const full631 = tree624.filter(function (e) { return e.type === 'button' && cls624(e).indexOf('audio-play-voice-full631') >= 0; });
    if (cut30_631.length !== 1 || full631.length !== 1) throw new Error('the 30 sec / full buttons the operator named are not both there: ' + cut30_631.length + ' / ' + full631.length);
    if (JSON.stringify(cut30_631[0].props.children) !== '"30 sec"' || JSON.stringify(full631[0].props.children) !== '"full"')
      throw new Error('the new buttons do not carry the operator\'s own words: ' + JSON.stringify([cut30_631[0].props.children, full631[0].props.children]));
    // "orange border style like 'retry' button" - the retry button's own colour pair, the one this file already reads.
    var stFull631 = (full631[0].props || {}).style || {};
    if (stFull631.borderColor !== '#d2992288' || stFull631.background !== '#242013')
      throw new Error('the full button is not in the retry button\'s orange: ' + JSON.stringify([stFull631.borderColor, stFull631.background]));
    if (!/NEW ap-XXXX row/.test(String(cutBtn624[0].props.title)) || !/keeps its own file/.test(String(cutBtn624[0].props.title)))
      throw new Error('the cut button does not say a new row is cut and this row is left alone: ' + cutBtn624[0].props.title);
    // The removed sentence: gone from the line, kept where it can still be read - on the button that makes that cut.
    const info624 = tree624.filter(function (e) { return e.type === 'span' && cls624(e).indexOf('audio-play-voice-cutinfo624') >= 0; });
    if (info624.length !== 0)
      throw new Error('the sentence the operator asked to remove is still drawn in the menu: ' + JSON.stringify(info624.map(function (e) { return e.props.children; })));
    if (!/cut 0\u201315 s out of 1408\.2 s/.test(String(cutBtn624[0].props.title)) || !/cut 0\u201330 s out of 1408\.2 s/.test(String(cut30_631[0].props.title)))
      throw new Error('the per-row cut is not stated on the button that makes it: ' + JSON.stringify([cutBtn624[0].props.title, cut30_631[0].props.title]));
    if (!/cut 0\u20131408\.2 s \(the whole row\)/.test(String(full631[0].props.title)))
      throw new Error('the full button does not name the whole row it would cut: ' + full631[0].props.title);
    // ONE added line in height: the menu cannot wrap, and the label span that took the room is gone.
    var menuStyle631 = (menus624[0].props || {}).style || {};
    if (menuStyle631.flexWrap !== 'nowrap') throw new Error('the menu can still wrap to a second line: ' + menuStyle631.flexWrap);
    const labelSpans631 = tree624.filter(function (e) { return e.type === 'span' && JSON.stringify(e.props.children) === '"save a voice from this row"'; });
    if (labelSpans631.length !== 0) throw new Error('the menu still carries its own label line: ' + labelSpans631.length);
    const close624 = tree624.filter(function (e) { return e.type === 'button' && cls624(e).indexOf('audio-play-voice-close624') >= 0; });
    if (close624.length !== 1) throw new Error('the menu cannot be closed: ' + close624.length);
    cutBtn624[0].props.onClick();
    cut30_631[0].props.onClick();
    full631[0].props.onClick();
    close624[0].props.onClick();
    const saved624 = pressed624.filter(function (p) { return p[0] === 'save'; });
    if (saved624.length !== 3) throw new Error('the three cut buttons do not all reach the panel: ' + JSON.stringify(saved624));
    if (saved624[0][1] !== 'u1' || saved624[0][2] !== 15 || saved624[1][2] !== 30)
      throw new Error('a cut button does not press the panel with its own row and the seconds its word names: ' + JSON.stringify(saved624));
    if (saved624[2][1] !== 'u1' || saved624[2][3] !== true)
      throw new Error('the full button does not press the panel as a whole-row cut: ' + JSON.stringify(saved624[2]));
    if (!pressed624.some(function (p) { return p[0] === 'name' && p[1] === 'newname'; }))
      throw new Error('typing in the name field does not reach the panel: ' + JSON.stringify(pressed624));
    if (!pressed624.some(function (p) { return p[0] === 'toggle' && p[1] === ''; }))
      throw new Error('the close button does not close the menu: ' + JSON.stringify(pressed624));
    // A row shorter than the cut is told so, in the menu it opened.
    const mark2624 = shim.rt.created.length;
    shim.renderComponent(fnByName.PlaylistPane, {
      playlist: rows624, limit: 20, queues: null, play: noop624, deleteJob: noop624, cancel: noop624,
      saveDesign: noop624, playSrc: noop624, playStem: noop624, viewDiar: noop624, retry: noop624, reuseText: noop624,
      voiceMenuId624: 'f1', toggleVoiceMenu624: noop624, voiceMenuName624: '', setVoiceMenuName624: noop624, saveRowVoice624: noop624,
    }, { fresh: true, effects: false });
    const tree2624 = shim.rt.created.slice(mark2624);
    const info2624 = tree2624.filter(function (e) { return e.type === 'span' && cls624(e).indexOf('audio-play-voice-cutinfo624') >= 0; });
    if (info2624.length !== 0) throw new Error('the removed sentence came back on a short row: ' + JSON.stringify(info2624.map(function (e) { return e.props.children; })));
    const cut2624 = tree2624.filter(function (e) { return e.type === 'button' && cls624(e).indexOf('audio-play-voice-cut624') >= 0; });
    const c30_2624 = tree2624.filter(function (e) { return e.type === 'button' && cls624(e).indexOf('audio-play-voice-cut631') >= 0; });
    const full2624 = tree2624.filter(function (e) { return e.type === 'button' && cls624(e).indexOf('audio-play-voice-full631') >= 0; });
    if (!/shorter than 15 s/.test(String(cut2624[0].props.title))) throw new Error('the 15 sec button is silent about the short row it sits on: ' + cut2624[0].props.title);
    // A 12.4 s row asked for 30 s: the button states the cut it will really make (the whole row), not the number on it.
    if (!/cut 0\u201312\.4 s out of 12\.4 s/.test(String(c30_2624[0].props.title)) || !/shorter than 30 s, so the whole row is the cut/.test(String(c30_2624[0].props.title)))
      throw new Error('the 30 sec button does not say what a 12.4 s row actually gets: ' + c30_2624[0].props.title);
    if (!/cut 0\u201312\.4 s \(the whole row\)/.test(String(full2624[0].props.title)))
      throw new Error('the full button does not name this row\'s whole length: ' + full2624[0].props.title);
    // A row whose length was never read: "full" says it cannot be asked for, instead of guessing an end.
    const mark3631 = shim.rt.created.length;
    shim.renderComponent(fnByName.PlaylistPane, {
      playlist: [{ id: 'n1', fn: 'tts', kind: 'file', status: 'ok', output_path: '/x/ap-0142.wav', route_url: '/deepamp/n1' }],
      limit: 20, queues: null, play: noop624, deleteJob: noop624, cancel: noop624,
      saveDesign: noop624, playSrc: noop624, playStem: noop624, viewDiar: noop624, retry: noop624, reuseText: noop624,
      voiceMenuId624: 'n1', toggleVoiceMenu624: noop624, voiceMenuName624: '', setVoiceMenuName624: noop624, saveRowVoice624: noop624,
    }, { fresh: true, effects: false });
    const tree3631 = shim.rt.created.slice(mark3631);
    const full3631 = tree3631.filter(function (e) { return e.type === 'button' && cls624(e).indexOf('audio-play-voice-full631') >= 0; });
    if (full3631.length !== 1 || !/length of this row was not read/.test(String(full3631[0].props.title)) || !/this press is refused/.test(String(full3631[0].props.title)))
      throw new Error('on a row with no length read, the full button does not say it is refused: ' + (full3631[0] ? full3631[0].props.title : 'no full button'));
  });

  // T-623 item 3 (operator reading of a fresh capture, verbatim 2026-10-21 04:36 Berlin: "it added ap-0141 as STT REF
  // - but the job did not start running ?"): the amber REF badge is keyed on what the row's note MEANS.
  await attempt('T-623: a capture row is badged as provenance, a reference-window row keeps its amber REF, and a note that is neither says what it is', function () {
    const noop623 = function () {};
    const rows623 = [
      { id: 'c1', fn: 'tts', kind: 'upload', status: 'ok', output_path: '/x/ap-0141_YwDVtf7-KWc.wav', route_url: '/deepamp/c1', duration: 1408.2,
        note: 'captured from https://example.invalid/watch?v=YwDVtf7-KWc via yt-dlp (Youtube)' },
      { id: 'r1', fn: 'tts', kind: 'tts', status: 'ok', output_path: '/x/ap-0144.wav', route_url: '/deepamp/r1', duration: 30,
        note: 'reference 30 s in the verified silent-truncation zone (25-40 s) for cosyvoice3 - tail words can be dropped silently; ears miss it, ASR does not' },
      { id: 'r2', fn: 'tts', kind: 'tts', status: 'queued', output_path: '/x/ap-0145.wav', route_url: '/deepamp/r2',
        note: 'force:true override - cosyvoice3 collapses at >= 60 s reference (verified pilot 2026-09-28/29); this reference is 71.4 s - use a shorter reference (dispatch allowed, expect a collapse/OOM render)' },
      { id: 'n1', fn: 'tts', kind: 'tts', status: 'ok', output_path: '/x/ap-0146.wav', route_url: '/deepamp/n1', duration: 4.2,
        note: 'both instructions (request field) and instruct (engine option) are set on this take' },
      { id: 'x1', fn: 'tts', kind: 'tts', status: 'ok', output_path: '/x/ap-0147.wav', route_url: '/deepamp/x1', duration: 3.1 },
    ];
    const mark623 = shim.rt.created.length;
    shim.renderComponent(fnByName.PlaylistPane, {
      playlist: rows623, limit: 20, queues: null, play: noop623, deleteJob: noop623, cancel: noop623, saveDesign: noop623,
      playSrc: noop623, playStem: noop623, viewDiar: noop623, retry: noop623, reuseText: noop623,
    }, { fresh: true, effects: false });
    const chips623 = shim.rt.created.slice(mark623).filter(function (e) {
      return e.type === 'span' && String((e.props || {}).className || '') === 'audio-play-row-note623';
    });
    const labels623 = chips623.map(function (e) { return String(e.props.children); });
    if (chips623.length !== 4) throw new Error('expected one chip on each of the four noted rows and none on the note-less row: ' + JSON.stringify(labels623));
    if (labels623[0] !== 'captured') throw new Error('a fresh capture is still badged as something other than provenance: ' + labels623[0]);
    if (labels623[1] !== 'REF' || labels623[2] !== 'REF') throw new Error('a reference-window warning or its force:true override lost its REF badge: ' + JSON.stringify(labels623));
    if (labels623[3] !== 'note') throw new Error('a note that is neither a window warning nor provenance is not named as itself: ' + labels623[3]);
    const colours623 = chips623.map(function (e) { return String((e.props.style || {}).color); });
    if (colours623[1] !== '#d29922' || colours623[2] !== '#d29922') throw new Error('the amber warning colour was lost from the rows it belongs to: ' + JSON.stringify(colours623));
    if (colours623[0] !== '#8b949e' || colours623[3] !== '#8b949e') throw new Error('a provenance chip or a plain note chip is still painted in the warning colour: ' + JSON.stringify(colours623));
    const titles623 = chips623.map(function (e) { return String(e.props.title); });
    if (!/^provenance, not a warning: captured from https/.test(titles623[0])) throw new Error('the capture chip does not name itself as provenance in its own hover: ' + titles623[0]);
    if (!/verified silent-truncation zone/.test(titles623[1]) || !/force:true override/.test(titles623[2])) throw new Error('the full warning text left the tooltip: ' + JSON.stringify(titles623));
    // The old shape is pinned as GONE: a badge that printed on any note is the fault this item names, and a source
    // pin that only checks the new shape would pass with both shapes present.
    const src623 = require('fs').readFileSync(TARGET, 'utf8');
    if (/j\.note \? h\("span"/.test(src623)) throw new Error('the any-note badge is still in the code beside the new one');
    const uses623 = (src623.match(/rowNoteBadge623\(j\)/g) || []).length;
    const defs623 = (src623.match(/function rowNoteBadge623\(j\)/g) || []).length;
    if (defs623 !== 1 || uses623 - defs623 !== 1) throw new Error('the classifier is not defined once and used once: ' + JSON.stringify({ uses: uses623, definitions: defs623 }));
  });

  // T-611 item 14 (operator ruling 2026-10-21 02:24 Berlin, one question at a time in the walk of the blocked cards:
  // "Offer nothing, and say why on the row"). A diarisation answers who spoke when; some diar models transcribe and
  // some carry no text at all, so a diar row of pure spans is a correct result. The refusal T-611 built stays; what is
  // new is that such a row explains itself instead of sitting there control-less.
  await attempt('T-611 item 14: a diar row that carries turns and no words says so on the row, and still gets no reuse control', function () {
    const noop611 = function () {};
    const rowTree611 = function (row611) {
      const mark611 = shim.rt.created.length;
      shim.renderComponent(fnByName.PlaylistPane, {
        playlist: [row611], limit: 20, queues: null, play: noop611, deleteJob: noop611, cancel: noop611,
        saveDesign: noop611, playSrc: noop611, playStem: noop611, viewDiar: noop611, retry: noop611, reuseText: noop611,
      }, { fresh: true, effects: false });
      return shim.rt.created.slice(mark611);
    };
    const spans611 = [
      { speaker_id: 'SPEAKER_00', start: 0, end: 5.2 }, { speaker_id: 'SPEAKER_01', start: 5.2, end: 9.4 },
      { speaker_id: 'SPEAKER_00', start: 9.4, end: 12 },
    ];
    const wordless611 = { id: 'd1', fn: 'stt', kind: 'diar', status: 'ok', model: 'diar_model', output_path: '/x/ap-0200.wav',
      route_url: '/deepamp/d1', duration: 42, speaker_turns: spans611 };
    const tree611 = rowTree611(wordless611);
    const chip611 = tree611.filter(function (e) { return e.type === 'span' && String((e.props || {}).className || '') === 'audio-play-row-diarwords611'; });
    if (chip611.length !== 1) throw new Error('the wordless diar row carries ' + chip611.length + ' explanation chip(s), expected 1');
    if (String(chip611[0].props.children) !== 'no words') throw new Error('the chip does not say what the row lacks: ' + chip611[0].props.children);
    const hover611 = String(chip611[0].props.title);
    if (!/3 diarised turns for 2 speakers \(SPEAKER_00, SPEAKER_01\)/.test(hover611)) throw new Error('the chip does not count the row\'s own turns and speakers: ' + hover611);
    if (!/WHO SPOKE WHEN and no words/.test(hover611) || !/nothing here to hand to a script/.test(hover611))
      throw new Error('the chip does not say why the row has no reuse control: ' + hover611);
    if (String((chip611[0].props.style || {}).color) !== '#8b949e')
      throw new Error('the explanation is painted as a warning; it is a fact about the row: ' + chip611[0].props.style.color);
    // The ruling is "OFFER NOTHING": the refusal T-611 built is untouched, and the row keeps the one control that
    // matches what it does carry.
    if (tree611.filter(function (e) { return e.type === 'button' && String(e.props.children) === '\u21BB'; }).length !== 0)
      throw new Error('a wordless diar row was offered a reuse control after all');
    // T-635 RE-POINT (2026-10-23, operator: "jobs like ap 0176 should have a view button, too / and view buttons
    // should have default colors and an eye symbol or magnifier if avail"): the control this pin names is the SAME
    // control, now the row's plain button wearing the eye instead of the word. What it proves is unchanged - the
    // wordless diar row keeps the one control it CAN honour.
    const eyeBtn611 = tree611.filter(function (e) {
      if (e.type !== 'button') return false;
      const kids611 = Array.isArray((e.props || {}).children) ? e.props.children : [(e.props || {}).children];
      return kids611.some(function (k) { return k && k.type === 'svg' && String((k.props || {}).className || '').indexOf('audio-play-row-glyph631-eye') >= 0; });
    });
    if (eyeBtn611.length !== 1)
      throw new Error('the row lost the one control it CAN honour - opening its turns in the STT result pane: ' + eyeBtn611.length);
    // The row's own hover popup says the same thing the chip says, in the hover's own words.
    const rowHover611 = tree611.map(function (e) { return String((e.props || {}).title || ''); })
      .filter(function (t611) { return /turns: 3/.test(t611); });
    if (!rowHover611.length || !/diarised turns carry no words/.test(rowHover611[0]))
      throw new Error('the row hover counts the turns but does not say they carry no words: ' + JSON.stringify(rowHover611));

    // And the chip is keyed on what the row actually lacks: a diar row with words keeps the reuse control and grows no chip.
    const words611 = [
      { speaker_id: 'SPEAKER_00', start: 0, end: 5.2, text: 'hello there' }, { speaker_id: 'SPEAKER_01', start: 5.2, end: 9.4, text: 'and you?' },
    ];
    const tree2611 = rowTree611(Object.assign({}, wordless611, { id: 'd2', speaker_turns: words611 }));
    if (tree2611.filter(function (e) { return String((e.props || {}).className || '') === 'audio-play-row-diarwords611'; }).length !== 0)
      throw new Error('a diar row that DOES carry words was told it has none');
    if (tree2611.filter(function (e) { return e.type === 'button' && String(e.props.children) === '\u21BB'; }).length !== 1)
      throw new Error('T-611\'s own gate moved: a diar row with words no longer offers the hand-off');
    const tree3611 = rowTree611(Object.assign({}, wordless611, { id: 'd3', transcript: 'a flat transcript on the row', speaker_turns: [{ speaker_id: 'SPEAKER_00', start: 0, end: 4 }] }));
    if (tree3611.filter(function (e) { return String((e.props || {}).className || '') === 'audio-play-row-diarwords611'; }).length !== 0)
      throw new Error('a diar row whose words sit in its transcript was badged as wordless');
    const tree4611 = rowTree611({ id: 'd4', fn: 'tts', kind: 'tts', status: 'ok', output_path: '/x/ap-0201.wav', route_url: '/deepamp/d4',
      duration: 4, speaker_turns: spans611 });
    if (tree4611.filter(function (e) { return String((e.props || {}).className || '') === 'audio-play-row-diarwords611'; }).length !== 0)
      throw new Error('the explanation reached a row that is not a diarisation');

    // Source: the refusal is untouched, and the explanation is one classifier used in the two places it is said.
    const src611 = require('fs').readFileSync(TARGET, 'utf8');
    if (!/return t\.filter\(function \(x\) \{ return x && String\(x\.text \|\| ""\)\.trim\(\); \}\);/.test(src611))
      throw new Error('diarTurnsWithWords584 no longer filters to turns that carry text - the refusal itself changed');
    const defs611 = (src611.match(/function diarWordlessTurns611\(j\)/g) || []).length;
    const uses611 = (src611.match(/diarWordlessTurns611\(j\)/g) || []).length;
    if (defs611 !== 1 || uses611 - defs611 !== 2)
      throw new Error('the wordless-row classifier is not defined once and used in exactly its two places (chip, hover): ' + JSON.stringify({ uses: uses611, defs: defs611 }));
  });

  await attempt('T-626: the endpoint row shows the engine build a person RECORDED, and says "build not recorded" when nobody did', async function () {
    const loose626 = createRuntime({ strictVoid: true });
    const BUILD626R = 'v0.9.2-drama3-base-small-26-g0125a991';
    // T-915: the engine-s own answer for the same slot, in the shape the host carries it (the version string the
    // node reports about itself, plus the moment this side read it). A different string on purpose: the whole
    // point of the card is that the two can disagree and the row must show the engine-s.
    const BUILD626LIVE = 'dev 2f4c9a11 2026-11-23';
    const fetch626 = function (url) {
      const u = String(url);
      let body = { ok: true };
      if (/endpoint_registry/.test(u)) {
        const fn = /fn=stt/.test(u) ? 'stt' : 'tts';
        const mk = function (id, extra) {
          return Object.assign({ id: id, fn: fn, url: 'http://cpu2.test:' + (fn === 'tts' ? '8963' : '8962'),
            route: 'speech', host: 'cpu2.test', enabled: true, batch_allowed: true, models: [], models_source: '', models_at: 0,
            online: null, checked_at: 0, health_error: '', held_by: '', hold_reason: '', held_at: 0, loaded_models: [], loaded_at: 0,
            backend: '', last_used_at: 0, build: '', build_at: 0, engine_build: '', engine_build_at: 0 }, extra || {});
        };
        body = { ok: true, fn: fn,
          primary: { id: 'primary', fn: fn, url: 'http://cpu1.test:8963', route: 'speech', host: 'cpu1.test', enabled: true,
            batch_allowed: true, models: [], models_source: '', models_at: 0, online: null, checked_at: 0, health_error: '',
            held_by: '', hold_reason: '', held_at: 0, loaded_models: [], loaded_at: 0, backend: '', last_used_at: 0,
            build: fn === 'tts' ? BUILD626R : '', build_at: fn === 'tts' ? 1760000000000 : 0 },
          // T-915 (2026-11-23, TODOS item 71): two rows now carry the engine-s own answer beside what a person
          // wrote down — e-1 has BOTH (the case that was measured live: a slot whose recorded value named a build
          // many commits behind, answering its own current build in the same record), and e-2 has only the engine-s
          // answer. The tts primary keeps a hand-recorded value and no engine answer, which is the case the old
          // wording was written for and still describes.
          endpoints: fn === 'tts' ? [mk('e-1', { build: BUILD626R, build_at: 1760000000000,
            engine_build: BUILD626LIVE, engine_build_at: 1760000123000 }), mk('e-2', { engine_build: BUILD626LIVE, engine_build_at: 1760000123000 })] : [],
        };
      }
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
    };
    const c626 = loadClient(loose626, { target: TARGET, fetch: fetch626 });
    const comp626 = c626.apply();
    if (!comp626) throw new Error('panel did not register');
    await openAllSections(loose626, comp626);
    const mark626 = loose626.rt.created.length;
    loose626.render(comp626());
    const tree626 = loose626.rt.created.slice(mark626);
    const own626 = function (e) {
      const c = (e.props || {}).children;
      if (c == null) return '';
      return Array.isArray(c) ? c.map(own626).join('') : String(c);
    };
    const tags = tree626.filter(function (e) { return e.type === 'span' && (e.props || {}).className === 'audio-play-ep-build626'; });
    // 2 tts rows (Primary + e-1 + e-2 = 3) plus 1 stt Primary row = 4 rows, one tag each.
    if (tags.length !== 4) throw new Error('build tags: ' + tags.length + ' (expected one per endpoint row: 3 tts + 1 stt primary)');
    const texts = tags.map(own626);
    const rec = texts.filter(function (x) { return x === BUILD626R; });
    const gap = texts.filter(function (x) { return x === 'build not recorded'; });
    const live = texts.filter(function (x) { return x === BUILD626LIVE; });
    // (T-915 contract change, 2026-11-23, at the operator-s word on TODOS item 71.) This pair read `rec 2 / gap 2`
    // against a fixture in which no row carried an engine answer, because none existed. The fixture now carries one
    // on two rows, so the honest counts are: one row shows a hand-recorded value, one row says nothing has been
    // recorded and nothing has been asked, and two rows show the engine-s own answer.
    if (rec.length !== 1) throw new Error('hand-recorded builds shown: ' + rec.length + ' (expected the tts Primary only): ' + texts.join(' | '));
    if (gap.length !== 1) throw new Error('rows that have neither said so: ' + gap.length + ' (expected the stt Primary only): ' + texts.join(' | '));
    if (live.length !== 2) throw new Error('rows showing the engine-s own answer: ' + live.length + ' (expected e-1 and e-2): ' + texts.join(' | '));
    if (/v0\.9\.2-drama3/.test(texts.filter(function (x) { return x !== BUILD626R; }).join(' | ')))
      throw new Error('a row that has an engine answer still shows the hand-recorded string');
    // The hover is where the honesty lives: a recorded value says WHEN it was recorded and that the plugin
    // cannot measure it; an unrecorded row says the value has to be written down by hand. The second half of
    // that sentence used to read 'an unrecorded row names the verb that records it', and U-18 (2026-10-22)
    // says a hover names no verb - the re-point of the check is below.
    const recTag = tags.filter(function (e) { return own626(e) === BUILD626R; })[0];
    const gapTag = tags.filter(function (e) { return own626(e) === 'build not recorded'; })[0];
    const tipRec = String((recTag.props || {}).title || '');
    const tipGap = String((gapTag.props || {}).title || '');
    // U-18 RE-POINT (2026-10-22): tests/tooltips.test.cjs caught this hover naming a route verb, and the panel's own
    // policy says a hover speaks in user words and names no verb and no request field. What the hover must still say
    // is the honesty itself: a recorded value is a person's written-down value, the plugin cannot measure it, and an
    // unrecorded row says the number has to be written down by hand off the node's own checkout.
    if (!/recorded /.test(tipRec) || !/wrote down by hand/.test(tipRec))
      throw new Error('the recorded hover does not say it is a value a person wrote down: ' + tipRec.slice(0, 160));
    // (T-915 contract change, 2026-11-23.) This pin read the exact sentence "The plugin cannot measure it", which
    // the panel wrote when no engine answer carried a build at all (measured 2026-10-21). That premise is gone —
    // the host has read the engine-s own answer since T-741 — so the sentence was corrected rather than kept. What
    // the hover must still carry, and what this still pins, is the honesty itself: a recorded value is a person-s
    // written-down value, and this row shows it only because the engine has not answered for itself.
    if (!/has not answered what it is running/.test(tipRec) || !/wrote down by hand/.test(tipRec))
      throw new Error('the recorded hover no longer says whose value this is and why it is being shown: ' + tipRec.slice(0, 200));
    if (!/no engine build recorded for this endpoint/.test(tipGap) || !/written down by hand/.test(tipGap) || /endpoint_update/.test(tipGap))
      throw new Error('the empty hover lost the honesty or named a route verb: ' + tipGap.slice(0, 160));
    // T-915 (2026-11-23, at the operator-s word on TODOS item 71). The fault was measured on the live lane: one
    // slot record carried `build:"v0.9.3-52-g76e99236"` beside a live `engine_build:"dev 9999a82e 2026-11-23"`,
    // and the panel showed the first. So: where an engine answer exists the row shows it, and where a hand-written
    // value disagrees the row says so rather than quietly dropping it. Three lines is the hover ceiling this panel
    // holds (AGENTS 5.19), so the pair is named in two.
    const bothTags626 = tags.filter(function (e) { return own626(e) === BUILD626LIVE; });
    if (bothTags626.length !== 2) throw new Error('rows showing the engine answer: ' + bothTags626.length);
    const tipBoth626 = bothTags626.map(function (e) { return String((e.props || {}).title || ''); });
    if (!tipBoth626.some(function (t) { return /the engine answered this about itself/.test(t) && /earlier says v0\.9\.2-drama3/.test(t) && /is not what this row shows/.test(t); }))
      throw new Error('the row that has both does not name whose answer it shows and which value it dropped: ' + tipBoth626.join(' || ').slice(0, 240));
    if (!tipBoth626.some(function (t) { return /the engine answered this about itself/.test(t) && !/earlier says/.test(t); }))
      throw new Error('a row whose only source is the engine-s answer invented a hand-written value beside it');
    tipBoth626.forEach(function (t) {
      if ((t.match(/\n/g) || []).length > 2) throw new Error('the engine-answer hover is over three lines: ' + t.length + ' chars');
    });
    // T-219 guarantee, applied to the new span: it may shrink and clip, it may not force a horizontal bar.
    tags.forEach(function (e) {
      const s = styleOf(e) || {};
      if (!(s.flexShrink >= 1) || s.minWidth !== 0 || s.overflow !== 'hidden' || s.textOverflow !== 'ellipsis')
        throw new Error('a build tag cannot shrink: ' + JSON.stringify(s));
    });
    const src626 = require('fs').readFileSync(TARGET, 'utf8');
    if ((src626.match(/BuildTag626\(/g) || []).length !== 2)
      throw new Error('BuildTag626 is not defined once and rendered once: ' + (src626.match(/BuildTag626\(/g) || []).length);
    if (!/build: String\(\(manageable && p && p\.build\) \|\| ""\)/.test(src626) || !/build_at: \(manageable && p\) \? \(Number\(p\.build_at\) \|\| 0\) : 0/.test(src626))
      throw new Error('the Primary row no longer carries the two recorded-build keys with the null guard it needs');
  });

  // T-635 (operator 2026-10-23, verbatim): "jobs like ap 0176 should have a view button, too" and "view buttons
  // should have default colors and an eye symbol or magnifier if avail". What changed is the GATE and the FACE, not
  // the machinery: the loader this control calls has always put a row's transcript text into the result pane and
  // drawn turn chips only when a row HAS turns (viewDiarRow sets the transcript first, then the turns).
  await attempt('T-635: a plain transcription row gets the eye, a diar row and a diar+asr row keep it, and each hover names what the press loads', function () {
    const noop635 = function () {};
    const loaded635 = [];
    const rowTree635 = function (row635) {
      const mark635 = shim.rt.created.length;
      shim.renderComponent(fnByName.PlaylistPane, {
        playlist: [row635], limit: 20, queues: null, play: noop635, deleteJob: noop635, cancel: noop635,
        saveDesign: noop635, playSrc: noop635, playStem: noop635, retry: noop635, reuseText: noop635,
        viewDiar: function (id) { loaded635.push(id); },
      }, { fresh: true, effects: false });
      return shim.rt.created.slice(mark635);
    };
    const eyeOn635 = function (e635) {
      const kids635 = Array.isArray((e635.props || {}).children) ? e635.props.children : [(e635.props || {}).children];
      return kids635.some(function (k) { return k && k.type === 'svg' && String((k.props || {}).className || '').indexOf('audio-play-row-glyph631-eye') >= 0; });
    };
    const viewOn635 = function (tree635) { return tree635.filter(function (e) { return e.type === 'button' && eyeOn635(e); }); };
    const mk635 = function (id, kind, extra) {
      const r = { id: id, fn: 'stt', kind: kind, status: 'ok', model: 'm635', output_path: '/x/' + id + '.txt', route_url: '/deepamp/' + id, duration: 4 };
      return Object.assign(r, extra || {});
    };
    const asr635 = viewOn635(rowTree635(mk635('s1', 'stt', { transcript: 'Subspace anomaly detected near the border.' })));
    if (asr635.length !== 1) throw new Error('a plain transcription row was not offered the view control: ' + asr635.length);
    asr635[0].props.onClick();
    if (loaded635.join(',') !== 's1') throw new Error('the eye on the transcription row pressed the wrong row: ' + JSON.stringify(loaded635));
    if (!/transcription/.test(String(asr635[0].props.title))) throw new Error('the hover does not say what the press loads: ' + asr635[0].props.title);
    const diar635 = viewOn635(rowTree635(mk635('d1', 'diar', {
      transcript: 'SPEAKER SPEAKER_00 [0.1s-2s] (0.90)', speaker_turns: [{ speaker_id: 'SPEAKER_00', start: 0.1, end: 2 }],
    })));
    if (diar635.length !== 1) throw new Error('the diar row lost the control it already had: ' + diar635.length);
    if (!/speaker turns/.test(String(diar635[0].props.title))) throw new Error('the diar hover moved while nothing about the diar row moved: ' + diar635[0].props.title);
    const sasr635 = viewOn635(rowTree635(mk635('x1', 'sasr', {
      transcript: 'SPEAKER SPEAKER_00 [0.1s-2s] (0.90) hello', speaker_turns: [{ speaker_id: 'SPEAKER_00', start: 0.1, end: 2, text: 'hello' }],
    })));
    if (sasr635.length !== 1) throw new Error('the diar+asr row lost the control it already had: ' + sasr635.length);
    // Nothing is offered when there is nothing to show: a row that is not finished, and a finished row with neither
    // text nor turns. The gate asks for content, not for a kind.
    const q635 = viewOn635(rowTree635(Object.assign(mk635('s2', 'stt', { transcript: 'x' }), { status: 'queued' })));
    if (q635.length !== 0) throw new Error('a queued transcription row was offered a view of nothing');
    const empty635 = viewOn635(rowTree635(mk635('s3', 'stt', {})));
    if (empty635.length !== 0) throw new Error('an empty transcription row was offered a view of nothing');
    // "default colors": the control is the row's normal button now. The purple box it used to wear is gone, and the
    // size is the one every other row control uses.
    const st635 = (asr635[0].props.style || {});
    if (/af7ee066|2a1d33/.test(String(st635.borderColor || '') + String(st635.background || '')))
      throw new Error('the view control still wears the purple box the operator asked to drop: ' + JSON.stringify(st635));
    if (st635.height !== '20px' || st635.fontSize !== '10px')
      throw new Error('the view control is not the row-button size the other controls use: ' + JSON.stringify(st635));
    // Source shape: the gate names the three kinds it offers, and the glyph registry carries the eye the operator
    // named. The retired mouth path is NOT in the file any more - its shape lives on the card.
    const src635 = require('fs').readFileSync(TARGET, 'utf8');
    if (!/j\.kind === "diar" \|\| j\.kind === "sasr" \|\| j\.kind === "stt"/.test(src635))
      throw new Error('the view gate no longer names the transcription row it was opened for');
    if (!/eye: "M1 8C4 3\.6 12 3\.6 15 8/.test(src635)) throw new Error('the eye glyph is not authored in the panel glyph registry');
    if (!/fillRule: "evenodd"/.test(src635)) throw new Error('the eye is drawn without the fill rule that turns its middle subpath into the white of the eye');
    if (/ROW_GLYPH631 = \{[^}]*mouth/s.test(src635)) throw new Error('the retired mouth shape is still in the registry');
  });

  await attempt('T-634 item 13a (operator 2026-10-23, the option chosen after the card measured the mismatch): the diar view carries ONE line naming the take the answer was made from and how many speaker ids that answer names - and it draws nothing when no source row was found', function () {
    const turns634 = [
      { speaker_id: 'SPEAKER_00', start: 0, end: 3, confidence: 0.94, text: 'first line' },
      { speaker_id: 'SPEAKER_00', start: 3, end: 6, confidence: 0.69, text: 'second line' },
    ];
    const draw634 = function (extra634) {
      const p634 = {
        models: { stt: [] }, selModel: { stt: '' }, sttFile: null, sttTranscript: '', busy: { stt: false },
        selLang: 'auto', onSelectLang: function () {}, selLane: '', registry: null, onLane: function () {}, onRefreshRegistry: function () {},
        onModelChange: function () {}, onFile: function () {}, dispatchStt: function () {}, abort: function () {}, onUploadFile: function () {},
        onUseRow: function () {}, playlist: [], sttSpeakerTurns: turns634, sttViewSeq: 1,
      };
      Object.assign(p634, extra634 || {});
      const mark634 = shim.rt.created.length;
      shim.renderComponent(fnByName.SttBox, p634, { fresh: true, effects: false });
      return shim.rt.created.slice(mark634);
    };
    const line634 = function (tree634) {
      return tree634.filter(function (e634) {
        return e634.type === 'div' && String((e634.props || {}).className || '').split(/\s+/).indexOf('audio-play-diar-cast634') >= 0;
      })[0] || null;
    };
    const words634 = function (e634) {
      if (!e634) return '';
      const kids634 = Array.isArray((e634.props || {}).children) ? e634.props.children : [(e634.props || {}).children];
      return kids634.map(function (k634) { return (typeof k634 === 'string' || typeof k634 === 'number') ? String(k634) : words634(k634); }).join(' ');
    };
    // THE CASE THE CARD MEASURED ON THE LIVE STORE: a take rendered with two voices, a diar answer that names one
    // id (ap-0165 / ap-0175). Both numbers have to be on the line and the difference said out loud, because the
    // point of the line is seeing the mismatch without listening to the take.
    const bad634 = line634(draw634({ sttDiarCast634: { source: 'ap-0165', cast: ['ent_worf', 'ent_data'], ids: 1 } }));
    if (!bad634) throw new Error('no cast line was drawn although the loaded answer has a source row carrying a cast');
    const badTxt634 = words634(bad634);
    if (!/ap-0165/.test(badTxt634) || !/rendered with 2 voices \(ent_worf, ent_data\)/.test(badTxt634)
      || !/this answer names 1 speaker id/.test(badTxt634) || !/fewer than the take was rendered with/.test(badTxt634)) {
      throw new Error('the mismatch line does not carry both numbers and the difference: ' + badTxt634);
    }
    if ((bad634.props.style || {}).color !== '#d29922') throw new Error('a mismatch is not marked in the panel palette: ' + JSON.stringify(bad634.props.style || {}));
    // AGREEMENT: the same take, an answer that names two ids. The line stays (it is the take's own description,
    // not an alarm) but it stops comparing and stops being painted as a fault.
    const ok634 = line634(draw634({ sttDiarCast634: { source: 'ap-0165', cast: ['ent_worf', 'ent_data'], ids: 2 } }));
    if (!ok634) throw new Error('the line vanished when the numbers agree - it was written as a fault banner, not as a reading of the take');
    const okTxt634 = words634(ok634);
    if (/fewer|more than/.test(okTxt634)) throw new Error('the agreement line still compares: ' + okTxt634);
    if ((ok634.props.style || {}).color === '#d29922') throw new Error('agreement is painted as a fault');
    // NO SOURCE ROW (a diar made from an uploaded file, or a source gone from the playlist): the reader answers
    // null and the view draws NOTHING. The panel does not claim a cast it cannot read off a row.
    if (line634(draw634())) throw new Error('the diar view drew a cast line out of nothing');
    // OVER-SEGMENTATION, the other honest direction: an answer naming more ids than the take has voices for.
    const over634 = line634(draw634({ sttDiarCast634: { source: 'ap-0165', cast: ['ent_worf'], ids: 3 } }));
    const overTxt634 = words634(over634);
    if (!over634 || !/more than the take was rendered with/.test(overTxt634)) throw new Error('the over-count case is not stated: ' + overTxt634);
    // A LONG CAST: six names shown, the rest counted, so a five-cast scene line and a two-voice line fit the same
    // narrow panel (the diar box sits in a pane whose minimum is 300 px).
    const long634 = words634(line634(draw634({ sttDiarCast634: { source: 'ap-0165', cast: ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8'], ids: 2 } })));
    if (!/\+2 more/.test(long634)) throw new Error('a long cast is shown in full instead of being counted: ' + long634);
    // SOURCE SHAPE. The line is a READER of the source row, not a second diar pass: it reads the cast the store
    // already carries (batch_cast, else speakers) and counts the ids the turns already name. It never invents,
    // renumbers, or relabels an engine's answer (T-634 item 6 stays unadopted), and it names no model (WM-23).
    const src634 = require('fs').readFileSync(TARGET, 'utf8');
    if (!/function diarCastInfo634\(turns, sourcePath, rows\)/.test(src634) || !/function diarCastSentence634\(info\)/.test(src634)) {
      throw new Error('the cast line is not authored as a reader of the source row');
    }
    if (!/src634\.batch_cast/.test(src634) || !/src634\.speakers/.test(src634)) throw new Error('the cast is not read off the source row\'s own fields');
    if (!/String\(j\.output_path\) === sp634/.test(src634)) throw new Error('the source row is not matched by the file the diar row was diarised from');
    const sent634 = (src634.match(/function diarCastSentence634\(info\) \{[\s\S]*?\n    \}/) || [''])[0];
    if (!sent634) throw new Error('the sentence builder could not be isolated in the source');
    if (/model/i.test(sent634)) throw new Error('the sentence reaches for a model name (WM-23): ' + sent634.slice(0, 160));
    if (!/cast: cast634/.test(src634) || !/ids: ids634/.test(src634)) throw new Error('the reader does not hand the view both numbers');
  });

  // T-818 (2026-11-13): the WORD the host writes beside whichever park key a row carries, and the capacity-pair,
  // on the row's own hover. T-815 made every park gate write the word and every clear clear it, and `job_status` /
  // `queue_status` answer it; the panel named WHO a row waits on and never named the KIND, and the capacity counter
  // (T-763's, put on the wire by T-810) reached no display at all. These fixtures are the two shapes the host
  // really produces: a parked row carrying its word, and an exhausted row carrying the capacity pair and NO park key.
  console.log('\n--- T-818: the park word and the capacity-pair on the row hover ---');

  function titlesOf818(tree818) {
    return tree818.filter(function (e818) { return e818.props && typeof e818.props.title === 'string'; })
      .map(function (e818t) { return String(e818t.props.title); });
  }
  function renderRows818(rows818) {
    const mark818 = shim.rt.created.length;
    shim.renderComponent(seen.get('PlaylistPane').fn, plProps(rows818, T210_REG), { fresh: true, effects: false });
    return titlesOf818(shim.rt.created.slice(mark818));
  }

  await attempt('T-818: a parked row prints the word beside the holder line, and the holder line is still there', function () {
    const titles = renderRows818([
      { id: 'ap-1801', fn: 'tts', kind: 'tts', status: 'queued', text: 'slot busy, with the word', created: 1801,
        endpoint_id: 'e-1', park_reason: 'slot',
        endpoint_slot_wait: { id: 'e-1', url: 'http://cpu2.test:8963', job_id: 'ap-0601' } },
    ]);
    const hit = titles.filter(function (t818a) { return t818a.indexOf('parked by: slot') >= 0; });
    if (hit.length < 1) throw new Error('no hover names the word: ' + titles.join(' | ').slice(0, 240));
    if (hit[0].indexOf('waits for endpoint TTS2: cpu2.test [id e-1]') < 0) {
      throw new Error('the word replaced the holder line instead of adding to it: ' + hit[0].slice(0, 240));
    }
  });

  await attempt('T-818: a parked row from a host that writes no word renders exactly what it rendered before', function () {
    const titles = renderRows818([
      { id: 'ap-1802', fn: 'tts', kind: 'tts', status: 'queued', text: 'slot busy, no word', created: 1802,
        endpoint_id: 'e-1', endpoint_slot_wait: { id: 'e-1', url: 'http://cpu2.test:8963', job_id: 'ap-0601' } },
    ]);
    const withWord = titles.filter(function (t818b) { return /parked by:/.test(t818b); });
    if (withWord.length) throw new Error('the panel invented a reason for a host that wrote none: ' + withWord[0].slice(0, 200));
    if (!titles.some(function (t818c) { return t818c.indexOf('waits for endpoint TTS2: cpu2.test [id e-1]') >= 0; })) {
      throw new Error('the additive change took the holder line with it: ' + titles.join(' | ').slice(0, 200));
    }
  });

  await attempt('T-818: a word outside the closed set is not printed, and the row keeps its holder line', function () {
    const titles = renderRows818([
      { id: 'ap-1803', fn: 'tts', kind: 'tts', status: 'queued', text: 'a word the host does not write', created: 1803,
        endpoint_id: 'e-1', park_reason: 'banana',
        endpoint_slot_wait: { id: 'e-1', url: 'http://cpu2.test:8963', job_id: 'ap-0601' } },
    ]);
    const bad = titles.filter(function (t818d) { return /banana/.test(t818d); });
    if (bad.length) throw new Error('the panel printed a word it does not know: ' + bad[0].slice(0, 200));
    if (!titles.some(function (t818e) { return t818e.indexOf('waits for endpoint TTS2: cpu2.test [id e-1]') >= 0; })) {
      throw new Error('an unknown word silenced the line that was already true: ' + titles.join(' | ').slice(0, 200));
    }
  });

  await attempt('T-818: a word on a row that is NOT parked prints nothing — the panel holds the host invariant', function () {
    const titles = renderRows818([
      { id: 'ap-1804', fn: 'tts', kind: 'tts', status: 'running', text: 'placed and running, a leaked word', created: 1804,
        endpoint_id: 'e-1', park_reason: 'slot' },
    ]);
    const leaked = titles.filter(function (t818f) { return /parked by:/.test(t818f); });
    if (leaked.length) throw new Error('the panel named a reason this row is not in: ' + leaked[0].slice(0, 200));
  });

  await attempt('T-818: the capacity counter is named in the engine-own-words, not as a number beside no sentence', function () {
    const titles = renderRows818([
      { id: 'ap-1805', fn: 'tts', kind: 'tts', status: 'queued', text: 'parked on the engine slot twice', created: 1805,
        endpoint_id: 'e-1', park_reason: 'slot', capacity_parks: 2,
        endpoint_slot_wait: { id: 'e-1', url: 'http://cpu2.test:8963', engine_hold: 'every loaded model is busy; retry later' } },
    ]);
    const hit = titles.filter(function (t818g) { return /engine's own busy model slot/.test(t818g); });
    if (hit.length < 1) throw new Error('no capacity line: ' + titles.join(' | ').slice(0, 240));
    if (hit[0].indexOf('waited 2 time(s)') < 0) throw new Error('the counter is not carried: ' + hit[0].slice(0, 240));
    // WM-23: a hover names what is happening, never a model as the thing to use. The names below are the ones this
    // suite's own fixtures put on rows, which is what makes the check concrete instead of a word-shape guess.
    const NAMED818 = ['moss_ttsd', 'qwen3_tts', 'chatterbox', 'breeze_tts', 'voxcpm2', 'omnivoice', 'cosyvoice'];
    const capLine818 = (hit[0].match(/engine's own busy model slot[^|]*/)[0]);
    const named818 = NAMED818.filter(function (m818n) { return capLine818.indexOf(m818n) >= 0; });
    if (named818.length) throw new Error('the capacity sentence reached for a model name (WM-23): ' + named818.join(','));
  });

  await attempt('T-818: the exhausted row is named although it carries no park key — the case T-810 exists for', function () {
    const titles = renderRows818([
      { id: 'ap-1806', fn: 'tts', kind: 'tts', status: 'error', text: 'the park budget ran out', created: 1806,
        error: 'engine slot stayed busy', endpoint_id: 'e-1', capacity_parks: 3, capacity_park_exhausted: true },
    ]);
    const hit = titles.filter(function (t818h) { return /stopped waiting: its park budget ran out/.test(t818h); });
    if (hit.length < 1) throw new Error('the exhausted row says nothing about why: ' + titles.join(' | ').slice(0, 240));
    if (hit[0].indexOf('3 time(s)') < 0) throw new Error('the exhausted line lost the count: ' + hit[0].slice(0, 240));
    if (/parked by:/.test(hit[0])) throw new Error('a row with no park key printed a park word: ' + hit[0].slice(0, 240));
  });

  await attempt('T-818: a row carrying neither key carries neither sentence, and no empty line is added', function () {
    const titles = renderRows818([
      { id: 'ap-1807', fn: 'tts', kind: 'tts', status: 'ok', text: 'a finished take', created: 1807, duration: 3.2,
        endpoint_id: 'e-1', output_path: '/x/ap-1807.wav' },
    ]);
    const bad = titles.filter(function (t818i) { return /parked by:|capacity|model slot was busy/.test(t818i); });
    if (bad.length) throw new Error('a clean row gained a sentence it was never given: ' + bad[0].slice(0, 200));
  });

  if (shim.rt.throws.length) {

    fail++;
    console.log('  recorded throws: ' + shim.rt.throws.map(function (t) { return t.where + ': ' + t.err.message; }).join(' ; '));
  }
  console.log('\n=== ' + pass + ' pass, ' + fail + ' throw ===');
  process.exitCode = fail ? 1 : 0;
})();
