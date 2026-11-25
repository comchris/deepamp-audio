// Every control in the panel, driven once. Asserts two things per control: nothing
// throws (a throw in an event handler abdicates the shell.overlay slot exactly like a
// render throw) and the route/verb the host actually registers is the one used — the
// verb table is where client and host drift (job_status is GET; POSTing it 405s, which
// made the poll-then-play loop never settle). Also covers the header drag: the panel has
// to move (the old handler read isDragging off its own render closure, so it never did).
// Usage: node tests/actions.test.cjs [path/to/client.js]
const path = require('path');
const { createRuntime, loadClient, openAllSections } = require('./react_shim.cjs');

const TARGET = process.argv[2] || path.join(__dirname, '..', 'lib', 'client.js');
const JOB = 'ap-0007';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail ? '  ->  ' + detail : '')); }
}
function flush() {
  let p = Promise.resolve();
  for (let i = 0; i < 25; i++) p = p.then(function () {});
  return p;
}

const calls = [];
const bodies = [];
// T-256 / T-257: the parsed bodies of the two local ffmpeg verbs, plus a switch that makes the host refuse,
// so the panel's refusal sentence can be checked against an answer rather than assumed.
const mixCalls = [];
const remuxCalls = [];
let mixRefusal = null;
let remuxRefusal = null;
function host(url, opts) {
  const method = ((opts && opts.method) || 'GET').toUpperCase();
  const u = String(url);
  calls.push(method + ' ' + u.replace('/api/deepamp/', '~'));
  bodies.push((opts && opts.body) || '');
  let body;
  if (/get_endpoints/.test(u)) body = { tts: { url: 'http://cpu1.test:8963', route: 'speech' }, stt: { url: 'http://cpu1.test:8962', route: 'tasks' } };
  else if (/server_status/.test(u)) body = { tts: { ok: true, loaded_model: 'm1' }, stt: { ok: true } };
  // T-227: one clone-required model added to the fixture so the NO VOICE gate has a
  // model to refuse. Additive only — m1 / m2 / vdes1 keep their exact shapes.
  // T-229: fn=task now answers the TOOL half of the catalog (TASK_ALLOW, lib/index.js:4217)
  // rather than mirroring the TTS half, because the tool kinds are selectable inside the TTS
  // section and their models must come from the view the host answers for them.
  else if (/get_models/.test(u)) body = { models: /[?&]fn=task/.test(u)
    ? [{ id: 'bs_roformer', loaded: false, task: 'sep', family: 'bs_roformer', quant: 'f16' }, { id: 'controlfoley', loaded: false, task: 'gen', family: 'controlfoley' }, { id: 'vevo2', loaded: false, task: 'vc', family: 'vevo2' }]
    : [{ id: 'm1', loaded: false }, { id: 'm2', loaded: true }, { id: 'vdes1', loaded: false, design: true }, { id: 'clon1', loaded: false, task: 'clon', family: 'glm_tts', clone_required: true, default_voice: false }] };
  // T-352: the capability reader, in the host's own answer shape (families[family].params + request_options
  // with the engine's own types and defaults). `clon1` is the only model in this fixture that carries a
  // family (glm_tts), so it is the model the knobs are read for; every other family is answered as an
  // UNKNOWN record, which is what lets a check catch the panel inventing a knob from nothing.
  else if (/model_capabilities/.test(u)) {
    // T-463 (user 2026-10-15): the board now follows the tool / generate form too, and that half cannot be
    // measured without a TOOL model that has a record. controlfoley is a tool model in this fixture (fn=task,
    // task:'gen'), and its record deliberately declares `duration_seconds` - the very name the tool form owns -
    // so the collision rule between a visible form field and a generated knob is measured, not asserted.
    if (/family=controlfoley/.test(u)) body = {
      ok: true, fn: 'tts', id: 'primary', source: 'bundle',
      families: { controlfoley: {
        family: 'controlfoley', params_source: 'bundle', params: [],
        request_options: [
          { name: 'duration_seconds', type: 'float', label: 'Duration', default: 5, minimum: 1 },
          { name: 'seed', type: 'int', label: 'Seed', description: 'Reproduces a take exactly.' },
        ],
      } },
    };
    else if (/family=glm_tts/.test(u)) body = {
      ok: true, fn: 'tts', id: 'primary', source: 'bundle',
      families: { glm_tts: {
        family: 'glm_tts', params_source: 'bundle',
        params: [
          { name: 'temperature', type: 'float', label: 'Temperature', default: 1.5, minimum: 0 },
          { name: 'top_p', type: 'float', label: 'Top p', default: 0.6, minimum: 0, maximum: 1 },
          { name: 'return_timestamps', type: 'bool', label: 'Word timestamps', default: false },
          { name: 'transcription_mode', type: 'choice', label: 'Mode', default: 'verbatim', choices: ['verbatim', 'intended'] },
          { name: 'max_frames', type: 'int', label: 'Max frames', default: 0 },
          { name: 'language', type: 'string', label: 'Language' },
        ],
        request_options: [
          { name: 'seed', type: 'int', description: 'Reproduces a take exactly.' },
          { name: 'voice_samples', type: 'string', description: 'positional reference paths' },
        ],
      } },
    };
    else body = { ok: true, fn: 'tts', source: 'unknown', families: {} };
  }
  else if (/refresh_voices/.test(u)) body = { voices: ['v1', 'v2'] };
  else if (/playlist_list/.test(u)) body = {
    items: [
      { id: JOB, fn: 'tts', kind: 'tts', status: 'ok', text: 'hi', model: 'qwen3-tts', voice: 'bijan', duration: 3.2, filename: 'ap-0007_qwen3-tts_bijan_hi.wav', route_url: '/deepamp/' + JOB, output_path: '/out/ap-0007_qwen3-tts_bijan_hi.wav' },
      { id: 'ap-0008', fn: 'tts', kind: 'tts', status: 'queued', text: 'next one', position: 1, waiting_for_model: true, model: 'voxcpm2' },
      { id: 'ap-0009', fn: 'tts', kind: 'tts', status: 'running', text: 'now', activity: 'synthesizing', started: Date.now() - 12000, model: 'qwen3-tts' },
      // T-323 fixture additions: a row whose words came back OUT of the engine (a transcript), and a row that
      // has no words at all. The reuse control has to tell those two apart.
      { id: 'ap-0010', fn: 'stt', kind: 'stt', status: 'ok', transcript: 'the spoken words', model: 'qwen3_asr', language: 'de', duration: 2.1, output_path: '/out/ap-0010_qwen3-asr_the-spoken-words.txt' },
      { id: 'ap-0011', fn: 'tts', kind: 'tts', status: 'ok', model: 'qwen3-tts', duration: 1.0, output_path: '/out/ap-0011_qwen3-tts.wav' },
      // T-256 fixture addition (2026-10-14): a Separate row WITH stems, in the shape the live lane answers
      // (a row carries output_path, and a sep row additionally carries stems[] with ids). A mix needs a bed
      // that has more than one stem, or the stem select would never be exercised.
      { id: 'ap-0012', fn: 'tts', kind: 'sep', status: 'ok', text: 'a source take', model: 'bs_roformer', duration: 4.0, filename: 'ap-0012_bs-roformer_a-source-take.wav', route_url: '/deepamp/ap-0012', output_path: '/out/ap-0012_bs-roformer.wav', stems: [{ id: 'vocal', path: '/out/ap-0012_vocal.wav' }, { id: 'background', path: '/out/ap-0012_background.wav' }] },
      // T-357 fixture addition (2026-10-14): two BATCH PARTS in the shape the host's own row view answers
      // (batch_id, batch_part, batch_parts, batch_title — lib/index.js:3733-3740), one rendered and one
      // still queued. The batch board is a display area, and its one play control has to be the panel's
      // own play button, with everything that button refuses.
      { id: 'ap-0013', fn: 'tts', kind: 'tts', status: 'ok', model: 'qwen3-tts', voice: 'bijan', duration: 5.5, filename: 'ap-0013_qwen3-tts_bijan.wav', output_path: '/out/ap-0013_qwen3-tts.wav', route_url: '/deepamp/ap-0013', batch_id: 'b-42', batch_part: 1, batch_parts: 2, batch_title: 'the board probe', created: 1100, started: 1101 },
      { id: 'ap-0014', fn: 'tts', kind: 'tts', status: 'queued', model: 'qwen3-tts', position: 1, batch_id: 'b-42', batch_part: 2, batch_parts: 2, batch_title: 'the board probe', created: 1100 },
      // T-459 fixture addition (2026-10-15): an SFX / music row, in the shape the live lane answers — kind
      // 'task', task_kind 'gen', the PROMPT in `text`, and the options it ran with on the row (measured live on
      // ap-0505: duration 300, elapsed_load 5954, elapsed_gen 1144611, options {duration_seconds:"300"}). The
      // re-use bug the user reported is only visible with a row of THIS shape, which is why it is here.
      { id: 'ap-0015', fn: 'tts', kind: 'task', task_kind: 'gen', status: 'ok', text: 'rain on a tin roof, distant thunder', model: 'controlfoley', family: 'controlfoley', duration: 8, options: { duration_seconds: '8' }, filename: 'ap-0015_controlfoley_rain.wav', route_url: '/deepamp/ap-0015', output_path: '/out/ap-0015_controlfoley_rain.wav', elapsed_load: 2100, elapsed_gen: 15400 },
      // T-481 (user 2026-10-16): the FILE row a resample writes. This is the shape the live lane answered for
      // ap-0592 (a 44 100 Hz / 2 ch copy of ap-0503, 25 927 762 bytes on disk), reason text and all — the row whose
      // tooltip the user said was unusable.
      { id: 'ap-0016', fn: 'tts', kind: 'file', status: 'ok', model: '(resample)', text: 'resampled ap-0015 to 44100 Hz / 2 ch', duration: 147, size_bytes: 25927762, file_path: '/out/ap-0015_controlfoley_rain.wav', output_path: '/out/ap-0016_ap-0015_rs44100c2.wav', resampled_from: 'ap-0015', resampled_from_path: '/out/ap-0015_controlfoley_rain.wav', resample_rate: 44100, resample_channels: 2, source_rate: 48000, source_channels: 2, resample_reason: 'htdemucs_q8 answers prepare() sample rate mismatch: expected 44100, got 48000 — separation leg of the pipeline' },
      // T-760 fixture additions (2026-11-09, operator request: "if I use the 'reuse button' to re-load the text into
      // the lower TTS section - it should also return the previously selected model and voice"). Two rows, one per
      // half of the rule. `clon1` is the only clone-required model this fixture's catalog lists (see the get_models
      // mock above), and 'v1' is the voice this fixture's own voice-gate tests already pick — so ap-0017 is the case
      // where the voice CAN be put back, and ap-0018 names a voice this fixture's registry does not offer, which is
      // the case where it must not be.
      { id: 'ap-0017', fn: 'tts', kind: 'tts', status: 'ok', model: 'clon1', voice: 'v1', text: 'a take made with an offered voice', duration: 4.1, filename: 'ap-0017_clon1_v1.wav', output_path: '/out/ap-0017_clon1_v1.wav', route_url: '/deepamp/ap-0017' },
      { id: 'ap-0018', fn: 'tts', kind: 'tts', status: 'ok', model: 'clon1', voice: 'voice-that-is-gone', text: 'a take made with a voice no longer in the store', duration: 3.7, filename: 'ap-0018_clon1_voice-that-is-gone.wav', output_path: '/out/ap-0018_clon1.wav', route_url: '/deepamp/ap-0018' },
    ],
    queues: { tts: { paused: true, running: null, queued: 2 }, stt: { paused: false, running: null, queued: 0 } },
  };
  else if (/dispatch_stt/.test(u)) body = { ok: true, transcript: 'hello transcript' };
  else if (/dispatch_tts/.test(u)) body = { ok: true, job_id: 'ap-0100', route_url: '/deepamp/ap-0100', status: 'queued', position: 3 };
  // T-256 / T-257 (2026-10-14): the two LOCAL ffmpeg verbs, answered in the host's own success shape
  // (mix_audio returns the new stem on the bed row; remux_video returns the new video path). The bodies the
  // panel sent are kept so a check can say exactly what rode on the wire.
  else if (/mix_audio/.test(u)) {
    mixCalls.push(JSON.parse(String((opts && opts.body) || '{}')));
    const o = mixCalls[mixCalls.length - 1].options || {};
    body = mixRefusal ? { ok: false, error: mixRefusal } : {
      ok: true, job_id: JOB, stem_id: 'mix-ap-9001', file_path: '/out/ap-0012_mix_ap-9001.wav', duration: 4.0,
      route_url: '/deepamp/' + JOB + '?stem=mix-ap-9001', bed_stem: 'background',
      delay_applied_to: (o.delay_ms !== undefined && Number(o.delay_ms) < 0) ? 'bed' : 'none',
      layers: mixCalls[mixCalls.length - 1].layers.slice(), bed_gain: o.bed_gain === undefined ? 1 : o.bed_gain,
      layer_gain: o.layer_gain === undefined ? 1 : o.layer_gain, delay_ms: o.delay_ms === undefined ? 0 : o.delay_ms,
      rate: o.rate === undefined ? 1 : o.rate,
    };
  }
  else if (/remux_video/.test(u)) {
    remuxCalls.push(JSON.parse(String((opts && opts.body) || '{}')));
    const ro = remuxCalls[remuxCalls.length - 1].options || {};
    body = remuxRefusal ? { ok: false, error: remuxRefusal } : {
      ok: true, video_path: remuxCalls[remuxCalls.length - 1].video_path, output_path: '/out/scene_dubbed_ap-9002.mp4',
      audio_source: remuxCalls[remuxCalls.length - 1].audio_job_id + (remuxCalls[remuxCalls.length - 1].stem_id ? '/' + remuxCalls[remuxCalls.length - 1].stem_id : ''),
      audio_codec: ro.audio_codec || 'aac', trim: ro.trim || 'longest',
    };
  }
  else if (/play_job/.test(u)) body = { ok: true, route_url: '/deepamp/' + JOB };
  else if (/get_save_paths/.test(u)) body = { ok: true, tts_dir: '/home/deepamp-test/.dsh/deepamp-audio/tts', default_tts_dir: '/home/deepamp-test/.dsh/deepamp-audio/tts', stt_dir: '/home/deepamp-test/.dsh/deepamp-audio/stt' };
  else if (/voice_registry/.test(u)) body = { ok: true, voices: { delme: { ref_text: 'gone soon', ref_wav: '/home/deepamp-test/.dsh/deepamp-audio/voices/delme.wav' }, keeper: { ref_text: 'stays', ref_wav: '/home/deepamp-test/.dsh/deepamp-audio/voices/keeper.wav', groups: ['star trek'] } } };
  // T-361 (2026-10-14): the group verb, answered the way the host answers it (T-359): a write REPLACES the
  // labels of the one voice named, and the answer carries the labels back as they were stored.
  else if (/voice_groups/.test(u)) {
    const g361 = JSON.parse(String((opts && opts.body) || '{}'));
    body = { ok: true, name: g361.name, groups: g361.groups || [] };
  }
  else if (/delete_voice/.test(u)) body = { ok: true, removed: 'delme', file_deleted: true };
  else if (/delete_all_audio/.test(u)) body = { ok: true, files_deleted: 7, dirs: ['/home/deepamp-test/.dsh/deepamp-audio/tts', '/home/deepamp-test/.dsh/deepamp-audio/stt'] };
  else body = { ok: true };
  return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
}

// document with listener bookkeeping, so the drag can be driven and its cleanup proven.
const doc = (function () {
  const listeners = {};
  return {
    listeners: listeners,
    addEventListener: function (t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener: function (t, fn) {
      const a = listeners[t] || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    fire: function (t, ev) { (listeners[t] || []).slice().forEach(function (fn) { fn(ev); }); },
  };
})();

// The panel registers MORE THAN ONE timer.interval poller (status auto-refresh at the
// user's ms, plus the 15 s voices-dropdown freshness loop). A single intervalFn/intervalMs
// pair recorded only the LAST registration, so the auto-refresh assertions saw 15000 and
// failed even though the status poller was correctly armed at 5000. Record every poller.
let intervalFn = null;
let intervalMs = 0;
const intervals = [];
const timer = {
  interval: function (cb, ms) {
    const rec = { fn: cb, ms: ms };
    intervals.push(rec);
    intervalFn = cb; intervalMs = ms;
    return function () {
      intervalFn = null;
      const i = intervals.indexOf(rec);
      if (i >= 0) intervals.splice(i, 1);
    };
  },
  timeout: function () { return function () {}; },
};

(async function main() {
  const audio = { src: '', plays: [], load: function () {}, play: function () { this.plays.push(this.src); var self = this; return Promise.resolve().then(function () { if (typeof self.onended === 'function') self.onended(); }); } };
  const shim = createRuntime({
    makeHostNode: function (n) {
      return n.type === 'audio'
        ? audio
        : { tagName: n.type, getBoundingClientRect: function () { return { left: 500, top: 400, right: 940, bottom: 640 }; } };
    },
  });
  const client = loadClient(shim, { target: TARGET, fetch: host, timer: timer, document: doc });
  const comp = client.apply();
  if (!comp) throw new Error('panel did not register');

  function commit() { const b = {}; shim.render(comp(), b); shim.runEffects(); return b; }

  // Mount, let the boot effects land, then open every section so every control exists.
  let bag = commit();
  await flush();
  await openAllSections(shim, comp);
  bag = commit();
  await flush();

  // Type into the empty text fields (tts text, stt path).
  const rootStore = shim.rt.stores.get(bag.AudioPlayerPanel.__key);
  let typed = 0;
  for (let i = 0; i < rootStore.length; i++) if (rootStore[i] === '') { rootStore[i] = '/tmp/in.wav'; typed++; }
  check('text fields reachable', typed >= 2, 'typed=' + typed);
  bag = commit();
  await flush();

  // --- endpoint row ---
  bag.EndpointRow.onSave('tts', 'http://cpu1.test:8963', 'speech');
  await flush();
  check('Save endpoint -> POST set_endpoint', calls.indexOf('POST ~set_endpoint') >= 0, calls.join(' | '));
  check('Save endpoint refreshes models + status', calls.indexOf('GET ~get_models?fn=tts') >= 0 && calls.indexOf('GET ~server_status') >= 0);

  // --- model + voice selects ---
  bag.TtsBox.onModelChange('tts', 'm2');
  bag.TtsBox.onSelectVoice('tts', 'v2');
  await flush();
  // T-333 (user 2026-10-13, 15:0x): "the voices should also be pulled from the endpoints, but ONLY if it's
  // model-provided voices! no clone voices!" - the hop now asks the host for the engine-sourced capability
  // record with caps=1, so the URL the panel emits carries that parameter. The assertion is corrected in place to
  // the URL the user's rule requires; what it asserts is unchanged: a model change re-reads the voices for the new
  // model, and it is a GET.
  check('Model change -> GET refresh_voices?fn=tts&model=m2&caps=1', calls.indexOf('GET ~refresh_voices?fn=tts&model=m2&caps=1') >= 0, calls.join(' | '));

  // --- model management (T-62, 2026-09-17): the panel renders NO Load/Unload
  // buttons anymore — the servers answer 403 dynamic-model-management-disabled
  // and models load on demand at dispatch. load_model/unload_model stay
  // API-only routes for the agent CLI.
  const mgmtBtns = shim.rt.created.filter(function (e) {
    return e.type === 'button' && (e.props.children === 'Load' || e.props.children === 'Unload');
  });
  check('no Load/Unload buttons in the panel', mgmtBtns.length === 0, mgmtBtns.length);
  check('panel never calls load_model/unload_model',
    calls.indexOf('POST ~load_model') < 0 && calls.indexOf('POST ~unload_model') < 0, calls.join(' | '));

  // --- STT ---
  bag = commit(); await flush();
  bag.SttBox.dispatchStt();
  await flush();
  check('Transcribe -> POST dispatch_stt', calls.indexOf('POST ~dispatch_stt') >= 0, calls.join(' | '));
  bag = commit(); await flush();
  check('transcript rendered from the response', /hello transcript/.test(JSON.stringify(bag.SttBox || {})), JSON.stringify(bag.SttBox || {}).slice(0, 140));

  // --- playlist controls (rev 5) ---
  function lastBody(routeRe) {
    for (let i = calls.length - 1; i >= 0; i--) if (routeRe.test(calls[i])) return bodies[i] || '';
    return '';
  }
  function renderedStrings() {
    const out = [];
    (function walk(v, depth) {
      if (depth > 40 || v == null) return;
      if (typeof v === 'string' || typeof v === 'number') { out.push(String(v)); return; }
      if (Array.isArray(v)) { v.forEach(function (n) { walk(n, depth + 1); }); return; }
      if (typeof v === 'object' && v.props && v.props.children !== undefined) walk(v.props.children, 0 + depth + 1);
    })(shim.rt.created.map(function (e) { return e.props && e.props.children; }), 0);
    return out;
  }

  bag.PlaylistPane.play(JOB);
  await flush();
  check('Play -> POST play_job/<id>', calls.indexOf('POST ~play_job/' + JOB) >= 0, calls.join(' | '));
  check('Play routed into <audio> and played', audio.src === '/deepamp/' + JOB && audio.plays.length === 1, 'src=' + audio.src + ' plays=' + JSON.stringify(audio.plays));

  // --- T-184 (user request u2): the header names what is playing -----------------
  // The fake <audio> ends the file in the play() microtask, so this is the ENDED
  // path: the header must have followed the onended chain (no poll involved) and
  // must still show the last title, marked as finished.
  function nowReadout() {
    const el = shim.rt.created.filter(function (e) { return e.props && e.props.className === 'audio-play-now'; }).pop();
    if (!el) return null;
    return { text: [].concat(el.props.children || []).join(''), tip: String(el.props.title || ''), style: el.props.style || {} };
  }
  bag = commit(); await flush();
  let np = nowReadout();
  // T-307 CONTRACT CHANGE (user 2026-10-13, 05:15): "currently title display in our player shows 1. ap-0003
  // -> remove '1.' ✓ add 'long title' in scrolling fashion". The line speaks the take's own words; the job id
  // it used to print lives in the hover, where the id column of the playlist row already points at it.
  // T-469 (user 2026-10-15) RE-POINTS this pin, it does not delete it. T-307 removed the playlist ORDINAL ("1.")
  // from this line, and the assertion written that day went further and banned the job id with it. The same
  // person asked for the id back on 2026-10-15: "seems like at some point we dropped that the 'scrolling top row
  // in player is also displaying the ap-XXXX id and the tile while playing (and scrolling) - currently it
  // displays only my prompt text for ap-505". Everything else this pin guarded stands and is still asserted -
  // the line speaks the take, marks it finished, prints no ordinal, and keeps the full label and route in the
  // hover. Only "no job id" became "the id leads the line, then the model read off the file the host wrote".
  check('T-307 as re-pointed by T-469: the line leads with the job id and the derived label, still speaks the take, '
      + 'still marks it finished, still prints no ordinal, and the full label and route stay in the hover',
    !!np && np.text === 'ap-0007 · qwen3-tts · hi · finished'
      && !/^\d+\. /.test(np.text) && np.tip.indexOf(JOB) >= 0, np && np.text);
  check('header tooltip carries the full label + route (T-184)',
    !!np && np.tip.indexOf(JOB) >= 0 && np.tip.indexOf('/deepamp/' + JOB) >= 0, np && np.tip);
  check('header never renders undefined / null / [object Object]',
    !!np && !/undefined|null|\[object Object\]/.test(np.text), np && np.text);
  // A stem play is a play OF THAT ROW (the same route with ?stem= on it ✓, so the take's words are still
  // what is being spoken ✓ and the panel's own tail about WHICH stem survives on the line. What the tail
  // replaces is the job id, which the user asked to have off this line (T-307).
  bag.PlaylistPane.playStem(JOB, 'vocals');
  await flush();
  bag = commit(); await flush();
  np = nowReadout();
  // T-469 re-points this one too: the stem tail the panel wrote is still kept on the line, and it still
  // replaces nothing but the ordinal - the id and the derived label now sit in front of it.
  check('T-307 as re-pointed by T-469: a stem play names the take, keeps the stem tail the panel wrote, and leads with the id and the derived label',
    !!np && np.text === 'ap-0007 · qwen3-tts · hi · vocals · finished', np && np.text);
  check('stem route reached the player too (T-183 interrupt semantics intact)',
    audio.src === '/deepamp/' + JOB + '?stem=vocals' && audio.plays.length === 2, 'src=' + audio.src + ' plays=' + JSON.stringify(audio.plays));
  bag.PlaylistPane.playSrc(JOB);
  await flush();
  bag = commit(); await flush();
  np = nowReadout();
  // T-469: the source play is a play OF THE ROW, so it carries the row's identity the same way.
  check('T-307 as re-pointed by T-469: a src play names the take it was asked to speak, marks it finished, and leads with the id and the derived label',
    !!np && np.text === 'ap-0007 · qwen3-tts · hi · finished' && np.tip.indexOf(JOB) >= 0, np && np.text);

  bag.PlaylistPane.cancel('ap-0008');
  await flush();
  check('Cancel row -> POST cancel_job/<id>', calls.indexOf('POST ~cancel_job/ap-0008') >= 0, calls.join(' | '));

  // T-323 (user 2026-10-13): "playlist should also offer the button reuse the text from the playlist item
  // (either transcription or text used for generation) in the next generation". Driven from the row handler,
  // and read back out of the generation field itself, because that is the only place the promise can be kept.
  const reuseBtns = shim.rt.created.filter(function (e) {
    // T-334 (user 2026-10-13, 15:4x): "'reuse button' does not need text 'reuse' in the button, symbol + hover is ok"
    // - the control is the circular-arrow glyph alone and the hover carries the promise. The finder matches the glyph
    // AND the reuse hover, so it still asserts exactly what it always asserted: one control per row that has words, and
    // none on the row that has neither.
    return e.type === 'button' && String(e.props.children).trim() === '\u21BB'
      // T-459 re-pointed the phrase: the hover now names the FIELD the words land in - the sfx / music prompt
      // field for a gen row, the text-to-read field for every other row - so the finder matches the promise,
      // not one wording. The glyph test above it is unchanged.
      && /for the next take/.test(String(e.props.title || ''));
  });
  check('T-323: rows that HAVE words carry a reuse control; the row with neither does not',
    reuseBtns.length >= 4 && !reuseBtns.some(function (e) { return /ap-0011/.test(String(e.props.title)); }),
    [reuseBtns.length, reuseBtns.map(function (e) { return e.props.title; }).slice(0, 3)]);
  check('T-364 (user 2026-10-14, PPS): the reuse control carries no colour of its own — the plain row background and border, in the shared T-334 box',
    reuseBtns.length >= 4 && reuseBtns.every(function (e) {
      var s = (e.props || {}).style || {};
      return s.background === '#22222a' && s.border === '1px solid #8886' && s.height === '20px';
    }),
    reuseBtns.map(function (e) { var s = (e.props || {}).style || {}; return [s.background, s.border, s.height].join('/'); }).slice(0, 3));
  check('T-323: the hover says WHICH words it will hand over - a transcript or the generation text',
    reuseBtns.some(function (e) { return /transcript/.test(String(e.props.title)); }) &&
    reuseBtns.some(function (e) { return /generation text/.test(String(e.props.title)); }),
    reuseBtns.map(function (e) { return e.props.title; }).slice(0, 4));
  function genField() {
    const t = shim.rt.created.filter(function (e) {
      return e.type === 'textarea' && /^Text to synthesize/.test(String(e.props.placeholder || ''));
    });
    return t.length ? t[t.length - 1] : null;
  }
  bag.PlaylistPane.reuseText(JOB);
  await flush();
  bag = commit(); await flush();
  check('T-323: reusing a generation row puts ITS text into the generation field',
    (genField() || {}).props && genField().props.value === 'hi', genField() && genField().props.value);
  bag.PlaylistPane.reuseText('ap-0010');
  await flush();
  bag = commit(); await flush();
  check('T-323: reusing a transcript row takes the TRANSCRIPT - the words that came out of the engine',
    (genField() || {}).props && genField().props.value === 'the spoken words', genField() && genField().props.value);

  // T-459 (user 2026-10-15, verbatim): "fix: currently the 're-use' prompt on SFX creations does not re-insert
  // the sfx prompt in the sfx field". The press is the panel's own reuse control; the field it is read back from
  // is the generate box's prompt input, which only exists while a GENERATE kind is showing — so the kind is put
  // on screen first, exactly as a person would do it, and only then is the button pressed. The old behaviour is
  // asserted as a refusal too: the words must NOT be sitting in the text-to-read box.
  const t459Before = shim.rt.created.length;
  bag.TtsBox.onKindChange('gen'); await flush(); bag = commit(); await flush();
  bag.PlaylistPane.reuseText('ap-0015'); await flush(); bag = commit(); await flush();
  const t459Prompt = (function () {
    // T-568 re-point (2026-10-17): the sfx prompt field is a textarea now, so the lookup follows the field it
    // identifies. Left on 'input' it would have found nothing and reported "no prompt input on screen" as a fact about
    // the panel when it was only a fact about the filter.
    const t = shim.rt.created.filter(function (e) { return e.type === 'textarea' && /^prompt, e.g\./.test(String(e.props.placeholder || '')); });
    return t.length ? t[t.length - 1] : null;
  })();
  check('T-459: re-use on an SFX / music row lands its PROMPT in the sfx prompt field',
    !!t459Prompt && t459Prompt.props.value === 'rain on a tin roof, distant thunder',
    t459Prompt ? t459Prompt.props.value : 'no prompt input on screen with a generate kind selected');
  check('T-459: and it does NOT land in the text-to-read box, which is what the button used to do to an sfx row',
    !/tin roof/.test(String(((genField() || {}).props || {}).value === undefined ? '' : (genField().props.value || ''))),
    (genField() || {}).props && genField().props.value);
  check('T-459: the panel says out loud which field the words went into',
    shim.rt.created.slice(t459Before).some(function (e) { return /as the next sfx \/ music prompt/.test(JSON.stringify((e.props || {}).children)); }),
    shim.rt.created.slice(t459Before).map(function (e) { return String(JSON.stringify((e.props || {}).children || '')).slice(0, 60); }).filter(function (x) { return x.length > 14; }).slice(0, 4));
  // T-455 (user 2026-10-15, verbatim): "currently generated sfx items and music items do not seem to show
  // extended info like wall time like other tts generations do" and "and also show the options that have been
  // used 'like turns, etc'". Read off the ROW of the fixture's gen take (ap-0015: elapsed_load 2100 +
  // elapsed_gen 15400 = 17500 ms, options {duration_seconds:"8"}) — the same shape the live lane answers for
  // ap-0505 (300 s of audio, 5954 load + 1144611 render, options {duration_seconds:"300"}). The claim on trial
  // is that these facts are now ON the row, not only reachable through a hover.
  const t455Row = shim.rt.created.filter(function (e) { return e.type === 'div' && /^ap-0015\b/.test(String((e.props || {}).title || '')); }).pop();
  const t455Kids = function (n, cls) {
    const out = [];
    (function w(x) {
      if (!x) return;
      if (Array.isArray(x)) { x.forEach(w); return; }
      if (x.props && String(x.props.className || '').indexOf(cls) >= 0) out.push(x);
      w((x.props || {}).children);
    })(n);
    return out;
  };
  // T-455, SAME-DAY CORRECTION (user 2026-10-15, verbatim): "you added the wall time as a visible playlist item
  // to music and sfx, that is too long, keep duration, but drop wall time -> i wanted better tooltips showing the
  // wall time on hover". The visible mark is now FORBIDDEN by this check and the duration column is asserted as
  // the row's only time; the wall time is asserted where the user asked for it, on the hover.
  check('T-455 as corrected: the row keeps its duration and carries NO visible wall time',
    !!t455Row && t455Kids(t455Row, 'audio-play-row-wall455').length === 0
      && t455Kids(t455Row, 'audio-play-row-time').length === 1
      && String((t455Kids(t455Row, 'audio-play-row-time')[0] || {}).props.children || '') === '0:08',
    t455Row ? [t455Kids(t455Row, 'audio-play-row-wall455').length, String(((t455Kids(t455Row, 'audio-play-row-time')[0] || {}).props || {}).children)] : 'no gen row on screen');
  check('T-455 as corrected: the wall time lives on the duration cell\u2019s own hover, in words a person can read',
    !!t455Row && /wall time on the lane: 17\.5s \u2014 model load 2\.1s, render 15\.4s/.test(String(((t455Kids(t455Row, 'audio-play-row-time')[0] || {}).props || {}).title || '')),
    String(((t455Kids(t455Row, 'audio-play-row-time')[0] || {}).props || {}).title || '').slice(0, 200));
  // T-455, SECOND CORRECTION (user 2026-10-15, verbatim): "also remove the 'duration: ...' we already have the
  // time display in green! the 'single line' aspect must be preserved at default window size!". A playlist row is
  // a flex row with wrap, so every span added to it is a claim on the width the row owns at the default panel
  // size — the same fight T-199, T-306 and T-307 were about. Both halves of the correction are pinned: the options
  // are NOT a span on the row any more, and the popup no longer repeats the length the green column already
  // prints. What the row carries visibly is the length, in green, exactly as before this card touched it.
  check('T-455 as corrected: the options are not a visible span on the row - they ride the row popup',
    !!t455Row && t455Kids(t455Row, 'audio-play-row-knobs455').length === 0
      && /options: duration_seconds=8/.test(String(t455Row.props.title)),
    t455Row ? [t455Kids(t455Row, 'audio-play-row-knobs455').length, String(t455Row.props.title).slice(0, 160)] : 'no gen row on screen');
  check('T-455 as corrected: the popup carries no bare "duration:" line, and the green time column is the row\u2019s only length display',
    !!t455Row && !/duration: /.test(String(t455Row.props.title))
      && t455Kids(t455Row, 'audio-play-row-time').length === 1
      && String((t455Kids(t455Row, 'audio-play-row-time')[0] || {}).props.children || '') === '0:08',
    String((t455Row || { props: {} }).props.title || '').slice(0, 200));
  // The structural half of the same ruling, read where it can be read without guessing at another row's state:
  // the two spans this card added to a row do not exist in the panel any more. Not hidden, not display:none, not
  // rendered conditionally - the code that built them is gone, which is the only version of "the single line is
  // preserved at default window size" that a suite can actually prove. A flex row with wrap gives a span back the
  // width it was claiming only by wrapping the row onto a second line, and that is the failure the user named.
  check('T-455 as corrected: neither the wall span nor the options span exists in the panel any more',
    (function () {
      const src455 = require('fs').readFileSync(TARGET, 'utf8');
      return src455.indexOf('audio-play-row-wall455') < 0 && src455.indexOf('audio-play-row-knobs455') < 0
        && !/parts\.push\(h\("span", \{[^\n]*row-wall/.test(src455);
    })(),
    [require('fs').readFileSync(TARGET, 'utf8').indexOf('audio-play-row-wall455'),
     require('fs').readFileSync(TARGET, 'utf8').indexOf('audio-play-row-knobs455')]);

  check('T-455 as corrected: the row popup carries the same wall sentence and the options the row rode',
    !!t455Row && /wall time: 17\.5s on the lane \u2014 model load 2\.1s, render 15\.4s/.test(String(t455Row.props.title))
      && /options: duration_seconds=8/.test(String(t455Row.props.title)),
    String((t455Row || { props: {} }).props.title || '').slice(0, 220));
  check('T-455: a row that reported neither a wall time nor options carries neither mark - absence is not printed as 0',
    (function () {
      const rows = shim.rt.created.filter(function (e) { return e.type === 'div' && /^ap-0011\b/.test(String((e.props || {}).title || '')); });
      const r = rows[rows.length - 1];
      return !!r && t455Kids(r, 'audio-play-row-wall455').length === 0 && t455Kids(r, 'audio-play-row-knobs455').length === 0;
    })(), 'ap-0011 has no elapsed_* and no options on its row');

  // T-848 (2026-11-14): the tool-lane badge said WHICH lane a row ran on but not WHICH kind it was — every tool
  // badge carried one identical sentence whether the row separated stems, generated an effect, converted a voice or
  // ran a speech model, and a token the palette does not know got a grey colour and no word about it. The finding is
  // `TODOS.md` item 37, the one card that review left owed, and the operator-s word for the batch was "the more cards
  // we can clear the better". The fix reads the panel-s OWN vocabulary (`KIND_TIP` / `kindTitleFor` — the words the
  // model library-s kind groups and the tool form-s kind line already print); it invents no second table and it does
  // not touch the label on the badge, which stays the host-s token. Read off the same fixture row the T-455 block
  // uses: ap-0015, kind "task", task_kind "gen".
  const t848Titles = function (n) {
    const out = [];
    (function w(x) {
      if (!x) return;
      if (Array.isArray(x)) { x.forEach(w); return; }
      if (x.props && x.props.title) out.push({ title: String(x.props.title), text: [].concat(x.props.children || []).join('') });
      w((x.props || {}).children);
    })(n);
    return out;
  };
  const t848Badge = function (row) {
    return t848Titles(row).filter(function (e) { return /same lane and in the same queue as a render/.test(e.title); });
  };
  check('T-848: the badge on a tool row names the kind it is, in the words this panel already uses for that kind',
    !!t455Row && t848Badge(t455Row).length === 1
      && /audio generation from a prompt/.test(t848Badge(t455Row)[0].title)
      && /duration \/ guidance \/ steps/.test(t848Badge(t455Row)[0].title),
    t455Row ? t848Badge(t455Row).map(function (e) { return e.title.slice(0, 200); }) : 'no gen row on screen');
  check('T-848: and the label on the badge is still the host-s own token — the hover changed, the visible word did not',
    !!t455Row && t848Badge(t455Row).length === 1 && t848Badge(t455Row)[0].text === 'gen',
    t455Row ? t848Badge(t455Row).map(function (e) { return e.text; }) : 'no gen row on screen');
  check('T-848 source: the badge asks the one helper the rest of the panel asks, the sentence that described every tool row alike is gone, and an unknown token still gets a true sentence built from the token and the verb',
    (function () {
      const src848 = require('fs').readFileSync(TARGET, 'utf8');
      const cnt848 = function (re) { return (src848.match(re) || []).length; };
      return cnt848(/kindTitleFor\(j\.task_kind\)/g) === 1
        && cnt848(/"this row is a tool job \\u2014 spoken by the voice endpoint, in the same queue as a render"/g) === 0
        && cnt848(/function kindTitleFor\(kind\)/g) === 1 && cnt848(/var KIND_TIP = \{/g) === 1
        && cnt848(/as the host catalog reports it/g) === 1;
    })(),
    (function () {
      const src848 = require('fs').readFileSync(TARGET, 'utf8');
      const cnt848 = function (re) { return (src848.match(re) || []).length; };
      return [cnt848(/kindTitleFor\(j\.task_kind\)/g), cnt848(/"this row is a tool job \\u2014 spoken by the voice endpoint, in the same queue as a render"/g),
              cnt848(/function kindTitleFor\(kind\)/g), cnt848(/var KIND_TIP = \{/g), cnt848(/as the host catalog reports it/g)];
    })());

  // --- T-481 (user 2026-10-16, verbatim): "the tooltip on the FILE playlist entries created from the resample are
  //     also not usable and need an overhaul, remove the strange comments and include the two formats the conversion
  //     was from and to" --------------------------------------------------------------
  // Read off the fixture row ap-0016, which is the shape the live lane answered for ap-0592 (a 44 100 Hz / 2 ch copy
  // of ap-0503, 25 927 762 bytes on disk, the engine-contract sentence in resample_reason and all). What is on trial
  // is the POPUP: the two formats it converted between, the words that say which file is which, and the removal of the
  // placeholder model name and the paragraph the host keeps for the log.
  const t481Row = shim.rt.created.filter(function (e) { return e.type === 'div' && /^ap-0016\b/.test(String((e.props || {}).title || '')); }).pop();
  const t481Tip = function () { return String((t481Row || { props: {} }).props.title || ''); };
  check('T-481: a resample row popup opens with the two formats it converted between, units and channels spelled on both sides',
    !!t481Row && /resampled: 48000 Hz, 2 ch\s*->\s*44100 Hz, 2 ch/.test(t481Tip()), t481Tip().slice(0, 160));
  check('T-481: the popup names the row the copy came from, the copy it wrote, and the file it was copied from - each with the word that says which is which',
    /copy made from row: ap-0015/.test(t481Tip())
      && /this file: \/out\/ap-0016_ap-0015_rs44100c2\.wav/.test(t481Tip())
      && /copied from file: \/out\/ap-0015_controlfoley_rain\.wav/.test(t481Tip()), t481Tip().slice(0, 300));
  check('T-481: the strange comments are gone from this popup - no placeholder model name, no generic input line, and the byte count the row carries',
    !/model: \(resample\)/.test(t481Tip()) && !/^input: /m.test(t481Tip()) && /bytes: 25927762/.test(t481Tip()),
    t481Tip().slice(0, 300));
  check('T-481: the reason sentence stays out of the tooltip - it is the hosts log record and the rows own field, not a paragraph a hover has to carry',
    !/sample rate mismatch/.test(t481Tip()) && !/separation leg/.test(t481Tip()), t481Tip().slice(0, 200));
  check('T-481: the removal is scoped to resample rows - a model row still says which model made it',
    (function () {
      const rows = shim.rt.created.filter(function (e) { return e.type === 'div' && /^ap-0015\b/.test(String((e.props || {}).title || '')); });
      const r = rows[rows.length - 1];
      return !!r && /model: controlfoley/.test(String(r.props.title || '')) && !/resampled: /.test(String(r.props.title || ''));
    })(), 'ap-0015 keeps its model line');
  check('T-481 source: both sides of the conversion are spelled by ONE helper, and the generic model line is gated behind it',
    (function () {
      const src481 = require('fs').readFileSync(TARGET, 'utf8');
      return /function rateCh481\(rate, channels\)/.test(src481)
        && /parts\.push\("resampled: " \+ rateCh481\(j\.source_rate, j\.source_channels\)[\s\S]{0,80}rateCh481\(j\.resample_rate, j\.resample_channels\)\)/.test(src481)
        && /\} else if \(j\.model\) \{\s*\n\s*parts\.push\("model: " \+ j\.model\);/.test(src481);
    })(), (function () {
      const s = require('fs').readFileSync(TARGET, 'utf8');
      return [s.indexOf('function rateCh481'), /else if \(j\.model\)/.test(s)];
    })());

  // T-584 (2026-10-18, operator request): a third route was added to this same decision - a diar / sasr row that
  // carries turns with words and two or more speakers goes to the chapter editor instead of the text lane, because the
  // text lane has one voice and flattening it was the complaint. The window this pin reads had to grow for that, and
  // the ORDER is now asserted too: the diar branch has to come before the flat-text refusal, which it does only
  // because it was measured to be needed (a diar+ASR row carries its words only as turns).
  // T-459 source (RE-POINTED 2026-10-20 by plugin T-610, reason kept in place of the clauses it replaces): the two
  // clauses this pin read INSIDE the reuse handler - `blocks584.length >= 2 && speakers584.length >= 2` and
  // `diarTurnsWithWords584(row)` - no longer sit there. They moved into `reuseHandoff610(row)`, the one function that
  // answers "may this row's words go into a field that has one voice" for the panel's reuse act AND for the row's own
  // hover, which before this card promised the one-voice field even on a row whose words were going somewhere else.
  // The claim is the same and so is the ORDER it guards: a row that carries speaker blocks is routed before its flat
  // text is looked at, and a row that carries none still lands in the field T-323 gave it. Measured 2026-10-20 while
  // re-pointing: the flat write now sits at offset 5333 of the handler, not 2786 - the handler carries the T-459,
  // T-560 and T-610 explanations in full - so the window is 6000 characters.
  // RE-POINTED AGAIN the same day by T-611, and the reason is a record, not a fix: T-611 wrote the dated correction
  // of a live row this card had cited (ap-0699, gone from the plugin's state) into the handler's own comment block,
  // which moved the flat write from offset 5333 to 6032. Re-measured after the change: reuseHandoff610(row) at 1456,
  // ho610.source === "diar" at 2111, the refusal at 5121, the flat write at 6032 - the clauses and their ORDER are
  // exactly what this pin has always guarded, only the distance grew, so the window is 6800 characters.
  check('T-459 source (re-pointed 2026-10-20 by T-610): the routing follows the ROW - a gen row fills the prompt state, a multi-speaker row goes to the chapter editor, every other row keeps the text lane T-323 gave it',
    (function () {
      const src = require('fs').readFileSync(TARGET, 'utf8');
      const body = (/function reuseTextFromRow\(id\) \{[\s\S]{0,7400}/.exec(src) || [''])[0]; // window grew 6800 -> 7200 on 2026-10-20 (T-613): both hand-off branches of this control gained the rule sentence about lines the scene already carries, which pushed the final field-choice line past the old window. The ordering this pin measures is unchanged. Grew again 7200 -> 7400 on 2026-10-21 (T-613 item 15): the two hand-off sentences this control carries were re-worded from the refuse-a-repeat rule to the in-place write, and the control is longer by those words.
      const iHand = body.indexOf('reuseHandoff610(row)');
      const iDiar = body.indexOf('ho610.source === "diar"');
      const iFlat = body.indexOf('carries no text to reuse');
      const iWrite = body.indexOf('if (isGen459) setToolText(t); else setTtsText(t);');
      return /row\.kind === "task" && String\(row\.task_kind \|\| ""\) === "gen"/.test(body)
        && iWrite >= 0
        && iHand >= 0 && iDiar >= 0 && iFlat >= 0 && iHand < iFlat && iDiar < iFlat && iDiar < iWrite
        && /setReuseSeed584\(\{ id: String\(row\.id\)/.test(body);
    })(), 'the field is chosen by what the row was, not by which box the panel happens to prefer');
  check('T-610 source: the row-shape question is answered ONCE, in reuseHandoff610, and it reads both kinds of multi-speaker row - a diarisation\'s turns and a take\'s own tagged script - with the diar half first, and the row\'s hover asks that same function',
    (function () {
      const src = require('fs').readFileSync(TARGET, 'utf8');
      const fn = (/function reuseHandoff610\(row\) \{[\s\S]{0,1400}/.exec(src) || [''])[0];
      const iDiar = fn.indexOf('diarTurnsWithWords584(row)');
      const iTake = fn.indexOf('isDialogueTake610(row)');
      return iDiar >= 0 && iTake >= 0 && iDiar < iTake
        && /turns\.length >= 2/.test(fn) && /labels\.length >= 2/.test(fn)
        && /b\.lines\.length >= 2 && b\.speakers\.length >= 2/.test(fn)
        && /reuseHandoff610\(j\)/.test(src);
    })(), (function () {
      const s = require('fs').readFileSync(TARGET, 'utf8');
      const fn = (/function reuseHandoff610\(row\) \{[\s\S]{0,1400}/.exec(s) || [''])[0];
      return { handoff_len: fn.length, hover_asks_it: /reuseHandoff610\(j\)/.test(s) };
    })());
  bag.PlaylistPane.reuseText('ap-0011');
  await flush();
  bag = commit(); await flush();
  check('T-323: a row with no words changes nothing in the field and says so',
    (genField() || {}).props && genField().props.value === 'the spoken words', genField() && genField().props.value);
  check('T-323: reuse dispatches nothing - it only fills the field, the take is still the person\u2019s decision',
    !/dispatch_tts/.test(calls.slice(-3).join(' | ')), calls.slice(-3).join(' | '));

  // Function-level abort belongs to TtsBox/SttBox (abort_fn); rows use cancel_job.
  bag.TtsBox.abort('tts');
  await flush();
  check('Abort function -> POST abort_fn', calls.indexOf('POST ~abort_fn') >= 0, calls.join(' | '));
  // T-313 (user 2026-10-13): "remove Abort buttons from generation area". Both red buttons (the TTS box and the
  // STT box) are gone from the panel. This check is the pair to the one above and it is the whole point of the
  // change: the VERB is still reachable — the line above sends abort_fn through the component's own handler —
  // while the UI no longer offers a button next to Generate that kills a job the person is watching. A running
  // job is killed by its own row (cancel_job on a running row -> aborted), new jobs are held by the lane chip.
  const abortBtns313 = shim.rt.created.filter(function (e) {
    return e.type === 'button' && String([].concat(e.props.children)[0]) === 'Abort';
  });
  check('T-313 CONTRACT CHANGE: no Abort button is rendered anywhere in the panel, and abort_fn is still reachable',
    abortBtns313.length === 0 && calls.indexOf('POST ~abort_fn') >= 0, abortBtns313.length);

  // --- queue strip: ONE toggle per lane (U-18, user 2026-10-13) ---
  // "currently we have 4 buttons pause+resume -> reduce to two buttons: 1 per line - pause and unpause
  // processing of new jobs on that lane / do not confuse with enable/disable of endpoints".
  // shim.rt.created accumulates every render, so an exact count needs a slice taken after a fresh render.
  const nU18 = shim.rt.created.length;
  bag = commit(); await flush();
  const laneToggles = shim.rt.created.slice(nU18).filter(function (e) {
    // T-311 (user 2026-10-13): the labels moved from "hold new jobs"/"let jobs run" to the short pair
    // "pause"/"resume" - the user's own reason: "rename buttons ... -> saves space for both buttons",
    // because the row has to fit on ONE line at the default panel width. The two facts the long words
    // carried now live in the hover, which still says "NOT switching an endpoint off" (checked below),
    // so nothing is lost: the label got shorter, the contract did not. Matched on exact text now, so
    // this filter cannot pick up a button that merely contains the word.
    return e.type === 'button' && /^(pause|resume)$/.test(String([].concat(e.props.children)[0]));
  });
  check('exactly one queue toggle per lane row (two in the panel, not four)',
    laneToggles.length === 2, 'n=' + laneToggles.length);
  const toggleTips = laneToggles.map(function (e) { return String(e.props.title || ''); });
  check('a lane toggle says out loud that it is not switching an endpoint off',
    toggleTips.length === 2 && toggleTips.every(function (t) { return /NOT switching an endpoint off/.test(t); }),
    toggleTips.join(' || ').slice(0, 200));
  check('a lane toggle speaks about NEW jobs on its own lane',
    toggleTips.length === 2 && toggleTips.every(function (t) { return /new jobs on the (TTS|STT) lane/.test(t); }),
    toggleTips.join(' || ').slice(0, 200));
  // The direction the button will move is read off its OWN label, and the verb it then sends must match that
  // label. A control whose words and action disagree is the bug this replacement had to avoid.
  const beforeLabels = laneToggles.map(function (e) { return String([].concat(e.props.children)[0]); });
  // The suite has already paused the TTS lane earlier, so the honest test is not "both rows start unheld" -
  // it is "the verb matches the words on the button", whatever state the lane reported.
  check('each lane toggle reads its own lane state',
    beforeLabels.length === 2 && beforeLabels.every(function (l) { return l === 'pause' || l === 'resume'; }),
    beforeLabels.join('|'));
  const heldLane = (beforeLabels.indexOf('pause') === 0) ? 'tts' : 'stt';
  bag.QueueControls.onToggleQueue(heldLane);
  await flush();
  check('an unheld lane toggle sends pause_fn for its own lane',
    calls.indexOf('POST ~pause_fn') >= 0 && new RegExp('"fn":"' + heldLane + '"').test(lastBody(/pause_fn/)),
    lastBody(/pause_fn/) + '  [lane=' + heldLane + ']');
  const nU18b = shim.rt.created.length;
  bag = commit(); await flush();
  const ttsToggle = shim.rt.created.slice(nU18b).filter(function (e) {
    return e.type === 'button' && String([].concat(e.props.children)[0]) === 'resume';
  });
  check('the held lane offers its same control back as "resume"', ttsToggle.length === 1, 'n=' + ttsToggle.length);
  bag.QueueControls.onToggleQueue('stt');
  await flush();
  check('the other lane toggle holds its own queue, not the first one',
    /\"fn\":\"stt\"/.test(lastBody(/pause_fn/)), lastBody(/pause_fn/));
  bag.QueueControls.onToggleQueue('nonsense');
  await flush();
  check('a lane this panel does not have is refused locally, with no host call',
    !/nonsense/.test(calls.join(' ')), calls.slice(-2).join(' | '));

  // --- T-537 (2026-10-17): the playlist row's control is `clr`, it asks nothing, and it never deletes a file.
  //     The three pins that lived here measured the OLD ruling: they installed a confirm that answered yes, one that
  //     answered no, and they looked for a control named "Del". All three facts are gone by the user's word — "make
  //     delete only remove the ap entry (like clear does)" and "re-label those buttons from 'del' to 'clr' in
  //     playlist". The confirm that answers YES is still installed on purpose: reaching it at all is now a failure,
  //     so it is installed and counted rather than absent. The voice row's Del and the Output section's delete-all
  //     keep their confirms further down this file, and this card leaves them exactly where they are.
  let confirmReached537 = false;
  global.window.confirm = function () { confirmReached537 = true; return true; };
  const clrBtns537 = shim.rt.created.filter(function (e) {
    return e.type === 'button' && JSON.stringify(e.props.children) === '"clr"' &&
      /remove this row from the playlist/.test(String((e.props && e.props.title) || ''));
  });
  check('T-537: one clr control per playlist row, and nothing named Del carries that promise any more',
    clrBtns537.length >= 3 && !shim.rt.created.some(function (e) {
      return e.type === 'button' && JSON.stringify(e.props.children) === '"Del"' &&
        /stays on disk/.test(String((e.props && e.props.title) || ''));
    }), { clr: clrBtns537.length, delCarryingThePromise: shim.rt.created.filter(function (e) {
      return e.type === 'button' && JSON.stringify(e.props.children) === '"Del"' &&
        /stays on disk/.test(String((e.props && e.props.title) || '')); }).length });
  if (clrBtns537.length) { clrBtns537[clrBtns537.length - 1].props.onClick(); await flush(); }
  check('T-537: pressing clr asks nothing - a confirm that would answer YES is installed and never reached, and the request carries delete_file:false',
    !confirmReached537 && /"delete_file":false/.test(lastBody(/playlist_delete/)),
    { confirm_reached: confirmReached537, body: lastBody(/playlist_delete/) });
  delete global.window.confirm;
  // Direct-handler path too (older call shape without confirm must not touch disk).
  bag.PlaylistPane.deleteJob(JOB);
  await flush();
  check('deleteJob(id) default keeps the file', /"delete_file":false/.test(lastBody(/playlist_delete/)), lastBody(/playlist_delete/));

  // --- row affordances: state chip, activity, meta, download link ---
  // T-322 (user 2026-10-13): "also remove the '#1 swap' tags from the playlist - and '#2' tags to show the
  // order , those are not needed". Re-pinned IN PLACE, not deleted: the chip now names only the two states a
  // row cannot be read without (the lane is paused; the job is waiting for a model swap) and carries no place
  // in the queue anywhere.
  const posChip = shim.rt.created.filter(function (e) {
    return e.props && /lane is paused/.test(String(e.props.title || ''));
  }).pop();
  // T-334 (user 2026-10-13, 15:4x): "i still see badge 'swap paused' -> can be dropped / removed". The chip is gone,
  // so this asserts its absence rather than its wording. The lane state it carried is not hidden anywhere: the lane's
  // own Pause/Resume control and the queue read-out state it, and T-322 had already removed the queue-position number
  // from this same badge family. The next check (no #N position on any badge) is unchanged.
  check('T-322 + T-334 CONTRACT CHANGE: no row chip carries the lane state at all (the "swap paused" badge was removed)',
    !posChip, posChip ? JSON.stringify(posChip.props.children) : 'missing');
  // Scoped to the badge family (the chips are the spans with the 8px pill), because a tree-wide `#\d` sweep
  // also catches the hex colours inside the panel's own <style> text, which is not what this is about.
  check('T-322 (user: "#2 tags to show the order, those are not needed"): no row badge carries a #N queue position',
    !shim.rt.created.some(function (e) {
      var st = e.props && e.props.style;
      if (!st || st.borderRadius !== '8px') return false;
      return /#\d/.test([].concat(e.props.children || []).map(String).join(''));
    }), shim.rt.created.filter(function (e) {
      var st = e.props && e.props.style;
      return st && st.borderRadius === '8px' && /#\d/.test([].concat(e.props.children || []).map(String).join(''));
    }).map(function (e) { return [].concat(e.props.children).map(String).join(''); }).slice(0, 4));
  const actChip = shim.rt.created.filter(function (e) {
    return e.props && e.props.title === 'current activity';
  }).pop();
  check('running row shows activity label + seconds', !!actChip && /^synthesizing \d+s$/.test(String([].concat(actChip.props.children)[0])),
    actChip ? JSON.stringify(actChip.props.children) : 'missing');
  const dl = shim.rt.created.filter(function (e) {
    return e.type === 'a' && e.props && e.props.download && e.props.href === '/deepamp/' + JOB;
  }).pop();
  check('ok row carries a download link (href route + filename)', !!dl && dl.props.href === '/deepamp/' + JOB && dl.props.download === 'ap-0007_qwen3-tts_bijan_hi.wav',
    dl ? JSON.stringify([dl.props.href, dl.props.download]) : 'missing');
  const strings = renderedStrings();
  check('inline meta shows model + voice + duration',
    strings.some(function (s) { return /qwen3-tts.*bijan.*3\.2s/.test(s); }),
    strings.filter(function (s) { return /qwen3/.test(s); }).join(' | ').slice(0, 120));
  check('queue strip renders paused + depth', strings.indexOf('paused') >= 0 && /2 queued/.test(strings.filter(function (s) { return /queued/.test(s); }).join(' ')));

  // T-367 (user ruling 2026-10-14): the single "Clear" became two controls. Here the fixture holds a RUNNING
  // row (ap-0009) and queued rows, so "clear all" must sweep finished rows and dequeue waiting ones WITHOUT
  // ever sending cancel_job for the running row — a bulk control that killed in-flight work would be a worse
  // instrument than the row's own X, which is still the only thing that stops a running job.
  const clearAll367 = shim.rt.created.filter(function (e) {
    // T-762 re-label (2026-11-09, operator request verbatim: "i would like for you to change the playlist button
    // 'clear all' into 'clear old' - it should clear all, but the last 10 from the playlist instead"). The control
    // this pin finds is the same control in the same place with the operator's own word on it; the search string
    // moved with the label, and every assertion below still measures the same behaviour.
    return e.type === 'button' && JSON.stringify(e.props.children) === '"clear old"';
  }).pop();
  const clearFailed367 = shim.rt.created.filter(function (e) {
    return e.type === 'button' && JSON.stringify(e.props.children) === '"clear failed"';
  }).pop();
  const singleClear367 = shim.rt.created.filter(function (e) {
    return e.type === 'button' && JSON.stringify(e.props.children) === '"Clear"';
  });
  check('T-367: both clear controls are on the section and the old single "Clear" is not',
    !!clearAll367 && !!clearFailed367 && singleClear367.length === 0,
    [!!clearAll367, !!clearFailed367, singleClear367.length]);
  check('T-762 (the old word is gone from the control, not kept beside the new one): no button on this section reads "clear all"',
    !shim.rt.created.some(function (e) { return e.type === 'button' && JSON.stringify(e.props.children) === '"clear all"'; }),
    shim.rt.created.filter(function (e) { return e.type === 'button' && /clear/.test(JSON.stringify(e.props.children || '')); }).map(function (e) { return JSON.stringify(e.props.children); }).join(' | '));
  const callsBeforeClear367 = calls.length;
  const bodiesBeforeClear367 = bodies.length;
  if (clearAll367) { clearAll367.props.onClick(); await flush(); }
  const clearCalls367 = calls.slice(callsBeforeClear367);
  const clearBodies367 = bodies.slice(bodiesBeforeClear367);
  check('T-367: clear old -> POST playlist_clear, and no cancel_job ever names the running row',
    clearCalls367.some(function (c367) { return /playlist_clear/.test(c367); })
      && !clearCalls367.some(function (c367) { return /cancel_job\/ap-0009/.test(c367); }),
    clearCalls367.join(' | '));
  check('T-762 (the number is asked for, on the same press): the control asks the host to keep the newest 10 finished rows, and still names the verb it is confirming',
    (function () {
      for (let i = 0; i < clearCalls367.length; i++) {
        if (!/playlist_clear/.test(clearCalls367[i])) continue;
        let b = null; try { b = JSON.parse(String(clearBodies367[i] || '')); } catch (e) {}
        return !!(b && b.confirm === 'playlist_clear' && b.keep === 10);
      }
      return false;
    })(),
    clearBodies367.filter(function (b) { return /playlist_clear/.test(String(b)); }).join(' | ').slice(0, 200));

  // --- auto-refresh: turning it on must register a status poller ---
  // step:5000 is the auto-refresh field's own signature (client.js:3180). The other
  // number inputs in the same Settings section are plLimit (step 1), chunkSize (step 50)
  // and genTimeoutS (step 30) — picking ".pop()" grabbed genTimeoutS, so the old test
  // wrote 5000 into the GENERATION-TIMEOUT field and never re-armed the poller at all.
  const msInput = shim.rt.created.filter(function (e) {
    return e.type === 'input' && e.props.type === 'number' && e.props.step === 5000 && typeof e.props.onChange === 'function';
  }).pop();
  check('auto-refresh input rendered (section opens)', !!msInput, 'the Auto-refresh section used to be unopenable');
  if (msInput) {
    // A value the state does not already hold: 5000 is the initial state, so writing
    // 5000 would not re-run the effect and could not prove the wiring. 7000 forces a
    // re-arm, which is what the assertion is about.
    msInput.props.onChange({ target: { value: '7000' } });
    bag = commit();
    await flush();
    const statusPoll = intervals.filter(function (i) { return i.ms === 7000; }).pop();
    check('auto-refresh re-arms the status poller at the chosen ms', !!statusPoll,
      'intervals=' + intervals.map(function (i) { return i.ms; }).join(','));
    const before = calls.filter(function (c) { return /server_status/.test(c); }).length;
    if (statusPoll) { statusPoll.fn(); await flush(); }
    const after = calls.filter(function (c) { return /server_status/.test(c); }).length;
    check('interval tick re-polls server_status', after === before + 1, before + ' -> ' + after);
  }

  // --- format select + re-Generate (rev 5: the queue never rejects) ---
  bag.TtsBox.onFormat('ogg');
  bag = commit(); await flush();
  const nBefore = calls.filter(function (c) { return /dispatch_tts/.test(c); }).length;
  bag.TtsBox.dispatchTts();
  await flush();
  bag.TtsBox.dispatchTts(); // second Generate right away — enqueues, no gate
  await flush();
  const nAfter = calls.filter(function (c) { return /dispatch_tts/.test(c); }).length;
  check('re-Generate reaches host again (queued, not rejected)', nAfter === nBefore + 2, nBefore + ' -> ' + nAfter);
  check('dispatch body carries the chosen format', /"format":"ogg"/.test(lastBody(/dispatch_tts/)), lastBody(/dispatch_tts/));

  // --- voice design passthrough (the 2026-09-19 bug) ------------------------------
  // The old call() whitelist dropped `instructions`, so the panel's voice description
  // NEVER reached the engine ("design had no effect"). Design dispatches must send the
  // description AND an empty voice (a reference would override it engine-side).
  bag.TtsBox.onModelChange('tts', 'vdes1');
  bag = commit(); await flush();
  bag.TtsBox.onDesignText('old sea captain, gravelly');
  bag = commit(); await flush();
  bag.TtsBox.dispatchTts();
  await flush();
  check('design dispatch sends instructions', /"instructions":"old sea captain, gravelly"/.test(lastBody(/dispatch_tts/)), lastBody(/dispatch_tts/));
  check('design dispatch sends an EMPTY voice', /"voice":""/.test(lastBody(/dispatch_tts/)), lastBody(/dispatch_tts/));

  // --- T-328 (user 2026-10-13 12:1x): the mic is a small red button INSIDE the text field, and the
  //     description fields get dictation too. Before this, the only mic affordance on the TTS side was a
  //     button labelled "mic" sitting in the label line above the text area, and the two description
  //     fields - the voice-design prompt and the style instruction - had no dictation at all.
  // `shim.rt.created` is cumulative, so every check here is scoped to what THIS render pass created.
  const t328_mark = shim.rt.created.length;
  bag = commit(); await flush();
  const t328_pass = shim.rt.created.slice(t328_mark);
  const t328_desTa = t328_pass.filter(function (e) {
    return e.type === 'textarea' && /^Voice description/.test(String(e.props.placeholder || ''));
  }).pop();
  const t328_abs = t328_pass.filter(function (e) {
    return e.type === 'button' && e.props && e.props.style && e.props.style.position === 'absolute';
  });
  // T-442 (user 2026-10-15): the field now carries a PAIR - the record dot and, when the field holds text, a Clr
  // beside it - so the room it reserves is 56 px rather than the 26 px that fitted one 18 px dot. Re-pointed, not
  // loosened: the padding value is still pinned exactly, and the button set below is pinned harder than before.
  check('T-328 through T-442: the voice-design prompt field carries the pair inside it (the field reserves room for both buttons)',
    !!t328_desTa && (t328_desTa.props.style || {}).paddingRight === '56px', t328_desTa && t328_desTa.props.style);
  // Harder than what it replaces: every absolutely positioned in-field button must be one of the two kinds this
  // factory makes (a red record dot or the Clr), at least one of each must actually be there, and the record dot
  // must still be the alarm red rather than a grey box.
  check('T-328 through T-442: the design field renders the in-field record button absolutely positioned in the wrapper, red rather than grey, and the Clr beside it',
    t328_abs.length >= 2
      && t328_abs.every(function (b) {
        const cls442 = String((b.props && b.props.className) || '');
        return cls442 === 'audio-play-clr442'
          || /#f85149|#a4161a/.test(String((b.props.style || {}).color || '') + String((b.props.style || {}).border || ''));
      })
      && t328_abs.some(function (b) { return String((b.props && b.props.className) || '') !== 'audio-play-clr442' && /#f85149/.test(String((b.props.style || {}).color || '')); })
      && t328_abs.some(function (b) { return String((b.props && b.props.className) || '') === 'audio-play-clr442'; }),
    t328_abs.map(function (b) { return b.props.children + ':' + (b.props.style || {}).color + ':' + String((b.props && b.props.className) || 'mic'); }));
  const t328_ttsTa = t328_pass.filter(function (e) {
    return e.type === 'textarea' && /^Text to synthesize/.test(String(e.props.placeholder || ''));
  }).pop();
  check('T-328 through T-442: the text field reserves the same room for the pair, so typed text cannot run under either button',
    !!t328_ttsTa && (t328_ttsTa.props.style || {}).paddingRight === '56px', t328_ttsTa && t328_ttsTa.props.style);
  check('T-328: the old label-line "mic" button is gone - one affordance, in the field it writes into',
    !t328_pass.some(function (e) { return e.type === 'button' && e.props && e.props.children === 'mic'; }),
    t328_pass.filter(function (e) { return e.type === 'button' && typeof e.props.children === 'string'; })
      .map(function (e) { return e.props.children; }).slice(0, 12));
  // T-442 (user 2026-10-15, verbatim): "in the windows where we have the 'record' buttons to dictate input for
  // the fields, we should also add a small 'Clr' button, to empty the whole window on klick" - and when the scope
  // was asked, the answer was "only the field the button is placed in, beside the rec buttons (yes, only same
  // field)". That second answer is the contract, and this is what pins it: pressing one Clr empties exactly one
  // field and leaves every other filled field exactly as it was. The values are put back afterwards so the rest
  // of this block still sees the fixture it was written against.
  const t442_before = t328_pass.filter(function (e) { return e.type === 'textarea' && String(e.props.value || '').trim(); })
    .map(function (e) { return [String(e.props.placeholder || '').slice(0, 18), String(e.props.value)]; });
  const t442_clr = t328_pass.filter(function (e) { return e.type === 'button' && e.props && e.props.className === 'audio-play-clr442'; });
  check('T-442: one Clr per dictation field that holds text, and no Clr on a field that has nothing to clear',
    t442_clr.length === t442_before.length && t442_clr.length >= 1,
    [t442_clr.length, t442_before.length, t442_clr.map(function (b) { return String(b.props.children); })]);
  const t442_mark442 = shim.rt.created.length;
  if (t442_clr[0]) t442_clr[0].props.onClick();
  bag = commit(); await flush();
  const t442_after = shim.rt.created.slice(t442_mark442).filter(function (e) { return e.type === 'textarea' && String(e.props.placeholder || '').trim(); })
    .map(function (e) { return [String(e.props.placeholder || '').slice(0, 18), String(e.props.value || '')]; });
  const t442_names = t442_before.map(function (q) { return q[0]; });
  const t442_emptied = t442_after.filter(function (p) { return !p[1].trim() && t442_names.indexOf(p[0]) >= 0; });
  const t442_kept = t442_after.filter(function (p) { return p[1].trim() && t442_names.indexOf(p[0]) >= 0; });
  check('T-442: pressing a Clr empties exactly ONE field - the one it sits in - and leaves every other filled field alone',
    t442_emptied.length === 1 && t442_kept.length === t442_before.length - 1,
    [t442_emptied.map(function (p) { return p[0]; }), t442_kept.map(function (p) { return p[0] + '=' + p[1].slice(0, 14); })]);
  t442_before.forEach(function (p) {
    if (/^Voice description/.test(p[0]) && bag.TtsBox && typeof bag.TtsBox.onDesignText === 'function') bag.TtsBox.onDesignText(p[1]);
    else if (/^Text to synthesize/.test(p[0]) && bag.TtsBox && typeof bag.TtsBox.onText === 'function') bag.TtsBox.onText(p[1]);
    else if (bag.TtsBox && typeof bag.TtsBox.onStyleText === 'function') bag.TtsBox.onStyleText(p[1]);
  });
  bag = commit(); await flush();

  const t328_callsBefore = calls.length;
  // T-442: the wrapper now holds two absolutely positioned buttons, so this presses the mic BY ITS GLYPH rather
  // than by creation order. The record dot is ● at rest, ■ while recording, … while the job runs; "Clr" is
  // the other button and must never be the one this press lands on.
  const t328_mic442 = t328_abs.filter(function (b) { return ['●', '■', '…'].indexOf(String(b.props.children)) >= 0; })[0];
  if (t328_mic442) t328_mic442.props.onClick();
  bag = commit(); await flush();
  const t328_new = calls.slice(t328_callsBefore);
  check('T-328: pressing the in-field mic dispatches nothing on its own - with no getUserMedia in this harness it must say so, not invent a job',
    t328_new.length === 0 && !t328_new.some(function (c) { return /upload_audio|dispatch_stt/.test(c); }),
    t328_new.map(function (c) { return c.replace('/api/deepamp/', ''); }));
  const t328_notice = shim.rt.created.filter(function (e) {
    return /getUserMedia/.test(String(e.props && e.props.children));
  });
  check('T-328: and the refusal is stated to the user - dictation needs a browser that has getUserMedia + MediaRecorder',
    t328_notice.length >= 1, t328_notice.map(function (e) { return String(e.props.children); }).slice(0, 2));

  // --- T-227: NO VOICE is a first-class voice choice ------------------------------
  // Baseline FIRST, so the change is measured and not asserted into existence: with a
  // voice picked, a dispatch has always carried it, and the only way to send none was an
  // empty option value the <select> could not even display.
  bag.TtsBox.onModelChange('tts', 'm1');
  bag.TtsBox.onSelectVoice('tts', 'v1');
  bag = commit(); await flush();
  bag.TtsBox.dispatchTts();
  await flush();
  check('T-227 baseline: a dispatch with a voice picked carries that voice',
    /"voice":"v1"/.test(lastBody(/dispatch_tts/)), lastBody(/dispatch_tts/));

  // The new choice sends NOTHING: no voice key at all — not voice:"" and never the
  // sentinel string. The host reads an absent voice as "nothing to clone" (stage leg
  // index.js:585, payload index.js:5296-5298), so omission IS the contract.
  bag.TtsBox.onSelectVoice('tts', '__no_voice__');
  bag = commit(); await flush();
  bag.TtsBox.dispatchTts();
  await flush();
  const nvBody = JSON.parse(lastBody(/dispatch_tts/));
  check('T-227: a NO VOICE dispatch omits the voice key entirely (no voice:"", no sentinel on the wire)',
    !('voice' in nvBody) && !/__no_voice__/.test(lastBody(/dispatch_tts/)), JSON.stringify(nvBody));
  check('T-227: the no-voice body is the historical body minus the voice key, in the same order',
    Object.keys(nvBody).join(',') === 'fn,model,text,format,instructions', Object.keys(nvBody).join(','));
  check('T-227: and it carries no voice_ref / reference_text / speakers either (nothing to stage)',
    !('voice_ref' in nvBody) && !('reference_text' in nvBody) && !('speakers' in nvBody), JSON.stringify(nvBody));
  check('T-227: the rest of the body is untouched (model, text and format still ride)',
    nvBody.model === 'm1' && typeof nvBody.text === 'string' && nvBody.text.length > 0 && nvBody.format === 'ogg', JSON.stringify(nvBody));

  // The clone path is UNCHANGED: pick a name again and the dispatch is byte-for-byte the
  // one it always was — same keys, same order, no new field.
  bag.TtsBox.onSelectVoice('tts', 'v2');
  bag = commit(); await flush();
  bag.TtsBox.dispatchTts();
  await flush();
  const clBody = JSON.parse(lastBody(/dispatch_tts/));
  check('T-227: picking a voice back restores the clone dispatch exactly (voice rides, same keys, same order, nothing new)',
    clBody.voice === 'v2' && Object.keys(clBody).join(',') === 'fn,model,text,voice,format,instructions', JSON.stringify(clBody));

  // The gate. clon1 carries clone_required:true, which is the flag the host refuses on
  // (index.js:5927-5932), so the option must be VISIBLE AND REFUSED, and a "no voice"
  // pick carried over from a model that allowed it must not survive into a dispatch the
  // host would reject.
  bag.TtsBox.onSelectVoice('tts', '__no_voice__');
  bag = commit(); await flush();
  bag.TtsBox.onModelChange('tts', 'clon1');
  bag = commit(); await flush();
  bag = commit(); await flush();
  const gateSel = shim.rt.created.filter(function (e) {
    return e.type === 'select' && typeof e.props.title === 'string' && /voice list - opening re-checks/.test(e.props.title);
  }).pop();
  const gateOpts = (gateSel && Array.isArray(gateSel.props.children)) ? gateSel.props.children : [];
  const gateNoVoice = gateOpts.filter(function (o) { return o && o.props && o.props.value === '__no_voice__'; })[0];
  check('T-227 gate: the NO VOICE entry stays visible on a clone model but is disabled, reason in its label',
    !!gateNoVoice && gateNoVoice.props.disabled === true && /unavailable/.test(String(gateNoVoice.props.children)),
    gateNoVoice ? [gateNoVoice.props.disabled, gateNoVoice.props.children] : 'entry missing');
  check('T-227 gate: a carried-over NO VOICE pick snaps to a real voice on a clone model',
    String((gateSel || {}).props.value) === 'v1', gateSel && gateSel.props.value);
  bag.TtsBox.dispatchTts();
  await flush();
  check('T-227 gate: and the dispatch that follows carries a voice, never the sentinel',
    /"voice":"v1"/.test(lastBody(/dispatch_tts/)) && !/__no_voice__/.test(lastBody(/dispatch_tts/)), lastBody(/dispatch_tts/));

  // An UNKNOWN model (no catalog flags) is NOT gated, because the host refuses only when
  // the catalog entry is known (index.js:5922-5923) — the panel must not block a dispatch
  // the host would accept. m1 above carries no flags and is the unknown case.
  bag.TtsBox.onModelChange('tts', 'm1');
  bag = commit(); await flush();
  const unkOpts = (function () {
    const s = shim.rt.created.filter(function (e) {
      return e.type === 'select' && typeof e.props.title === 'string' && /voice list - opening re-checks/.test(e.props.title);
    }).pop();
    return (s && Array.isArray(s.props.children)) ? s.props.children : [];
  })();
  const unkNoVoice = unkOpts.filter(function (o) { return o && o.props && o.props.value === '__no_voice__'; })[0];
  check('T-227 gate: an unknown model (no catalog flags) still offers NO VOICE, not disabled',
    !!unkNoVoice && unkNoVoice.props.disabled !== true, unkNoVoice ? unkNoVoice.props.disabled : 'entry missing');

  // The read-aloud slot says what it is pinned to. A slot pinned while NO VOICE is
  // selected must read "(no voice)" — the old "(model default)" hid the difference
  // between "the model chose its speaker" and "the request sent nothing at all".
  bag.TtsBox.onSelectVoice('tts', '__no_voice__');
  bag = commit(); await flush();
  const pinBtn = shim.rt.created.filter(function (e) {
    return e.type === 'button' && e.props && e.props.title === 'pin this slot to the current model/voice/style text';
  }).pop();
  check('T-227: the slot pin control is reachable', !!pinBtn, 'missing');
  if (pinBtn) { pinBtn.props.onClick(); bag = commit(); await flush(); }
  const slotReadout = shim.rt.created.filter(function (e) {
    return e.props && typeof e.props.children === 'string' && e.props.children.indexOf('pinned \u00B7 ') === 0;
  }).pop();
  check('T-227: a slot pinned on NO VOICE reads "(no voice)" on the strip, not "(model default)"',
    !!slotReadout && /\(no voice\)/.test(slotReadout.props.children) && !/\(model default\)/.test(slotReadout.props.children),
    slotReadout ? slotReadout.props.children : 'no pinned readout rendered');

  // --- output save path section (opened via the expanded store) ---
  const exStore = rootStore.find(function (v) { return v && typeof v === 'object' && v.__pl === true; });
  // T-300 U-6: __out is no longer a section (its content moved into Settings, which this helper
  // already opens), so the output half of the panel is reachable through __set.

  bag = commit(); await flush();
  const pathInput = shim.rt.created.filter(function (e) {
  // T-742 (2026-11-07) contract change: the store root moved to /home/deepamp-test/.dsh/deepamp-audio at the operator's word ("we need a full conversion of the store to /home/deepamp-test/.dsh/deepamp-audio"). The patterns below name the store the plugin runs on; the assertions themselves are unchanged.
    return e.type === 'input' && typeof e.props.placeholder === 'string' && /deepamp-audio\/tts/.test(e.props.placeholder);
  }).pop();
  check('save-path input rendered', !!pathInput, 'missing');
  if (pathInput) {
    pathInput.props.onChange({ target: { value: '/tmp/ap_out_test' } });
    bag = commit(); await flush();
    const savePathBtn = shim.rt.created.filter(function (e) {
      return e.type === 'button' && e.props.title === 'absolute path; the parent directory must already exist';
    }).pop();
    check('save-path Save button found', !!savePathBtn, 'missing');
    if (savePathBtn) { savePathBtn.props.onClick(); await flush(); }
    check('Save path -> POST set_save_path with dir', calls.indexOf('POST ~set_save_path') >= 0 && /"dir":"\/tmp\/ap_out_test"/.test(lastBody(/set_save_path/)), lastBody(/set_save_path/));
    const resetBtn = shim.rt.created.filter(function (e) {
      return e.type === 'button' && JSON.stringify(e.props.children) === '"Default"';
    }).pop();
    if (resetBtn) { resetBtn.props.onClick(); await flush(); }
    check('Default -> POST set_save_path dir:"" (reset)', /"dir":""/.test(lastBody(/set_save_path/)), lastBody(/set_save_path/));
  }

  // --- drag the header ---
  // T-227 contract change: this used to take "the last element with an onMouseDown",
  // which only happened to be the header because the model left selected at this point
  // was a DESIGN one (a design model renders no voice select at all). T-227 leaves a
  // normal model selected, so the voice <select> — which also carries onMouseDown (it
  // re-checks the registry on open) — is created after the header and .pop() grabbed IT:
  // the press re-fetched voices and no drag ever started. Re-anchored to what actually
  // makes it the drag header (cursor:"move" + onMouseDown), the same anchor
  // ui_state.test.cjs uses for the same trap. Same assertion, same expectation.
  const header = shim.rt.created.filter(function (e) {
    return e.type === 'div' && typeof e.props.onMouseDown === 'function' && e.props.style && e.props.style.cursor === 'move';
  }).pop();
  check('header drag handler found (T-227 contract change: anchored on the drag header, not on "last onMouseDown")', !!header, '');
  if (header) {
    let stopped = false;
    header.props.onMouseDown({ button: 0, clientX: 200, clientY: 200, stopPropagation: function () { stopped = true; } });
    doc.fire('mousemove', { clientX: 260, clientY: 180 });
    commit();
    await flush();
    const panel = shim.rt.created.filter(function (e) { return e.props && e.props.className === 'audio-play-panel'; }).pop();
    const style = (panel && panel.props.style) || {};
    check('drag moves the panel (no stale-closure no-op)', style.left === 560 && style.top === 380, 'left=' + style.left + ' top=' + style.top);
    doc.fire('mouseup', {});
    check('mouseup drops the document listeners (no leak)',
      (doc.listeners.mousemove || []).length === 0 && (doc.listeners.mouseup || []).length === 0,
      'mousemove=' + (doc.listeners.mousemove || []).length + ' mouseup=' + (doc.listeners.mouseup || []).length);
    check('drag stops propagation to the shell', stopped, '');
  }

  // --- T-185 (user request u3): the bottom-right resize affordance ----------------
  // The panel resizes through CSS `resize: "both"` (browser corner). The plugin now
  // also paints a visible 18x18 grip there and owns a drag for it, so the grab area
  // is the whole marker. Both must hold: the CSS resize is untouched, and the new
  // grip drags with the same rect -> {w,h} geometry the mouseup persistence uses.
  const panelBefore = shim.rt.created.filter(function (e) { return e.props && e.props.className === 'audio-play-panel'; }).pop();
  check('CSS resize on the panel is untouched (resize:both while the body shows)',
    !!panelBefore && panelBefore.props.style.resize === 'both' && panelBefore.props.style.overflow === 'hidden',
    panelBefore && panelBefore.props.style.resize);
  const grip = shim.rt.created.filter(function (e) { return e.props && e.props.className === 'audio-play-resize-grip'; }).pop();
  check('resize grip rendered, anchored bottom-right, 18x18 hit area',
    !!grip && grip.props.style.position === 'absolute' && grip.props.style.right === '0' && grip.props.style.bottom === '0' &&
    grip.props.style.width === '18px' && grip.props.style.height === '18px' && grip.props.style.cursor === 'nwse-resize',
    grip ? JSON.stringify(grip.props.style) : 'missing');
  check('grip is visible but subtle: 2px corner bracket + faint hatch, existing tokens only',
    !!grip && grip.props.style.borderRight === '2px solid #8886' && grip.props.style.borderBottom === '2px solid #8886' &&
    /repeating-linear-gradient\(135deg, #8883/.test(String(grip.props.style.background || '')),
    grip && grip.props.style.background);
  check('grip has its own tooltip and does not swallow the rest of the panel',
    !!grip && /resize the panel/.test(String(grip.props.title || '')), grip && grip.props.title);
  check('grip is NOT the header drag target (header drag test above still owns onMouseDown order)',
    !!header && typeof header.props.onMouseDown === 'function' && header !== grip, '');
  if (grip) {
    // Fake rect is left 500 / top 400 / 440x240; +100/+100 pointer travel -> 540x340.
    grip.props.onMouseDown({ button: 0, clientX: 940, clientY: 640, stopPropagation: function () {} });
    doc.fire('mousemove', { clientX: 1040, clientY: 740 });
    commit();
    await flush();
    const grown = shim.rt.created.filter(function (e) { return e.props && e.props.className === 'audio-play-panel'; }).pop();
    check('corner drag resizes the panel (540x340 from 440x240)',
      !!grown && grown.props.style.width === '540px' && grown.props.style.height === '340px',
      grown && [grown.props.style.width, grown.props.style.height]);
    // Below the panel's own CSS min the drag must clamp, not shrink past it.
    doc.fire('mousemove', { clientX: 100, clientY: 100 });
    commit();
    await flush();
    const clamped = shim.rt.created.filter(function (e) { return e.props && e.props.className === 'audio-play-panel'; }).pop();
    check('corner drag clamps at the panel minimum (300x70), stays draggable at min size',
      !!clamped && clamped.props.style.width === '300px' && clamped.props.style.height === '70px',
      clamped && [clamped.props.style.width, clamped.props.style.height]);
    doc.fire('mouseup', {});
    check('corner drag drops its document listeners (no leak)',
      (doc.listeners.mousemove || []).length === 0 && (doc.listeners.mouseup || []).length === 0,
      'mousemove=' + (doc.listeners.mousemove || []).length + ' mouseup=' + (doc.listeners.mouseup || []).length);
    const gripAfter = shim.rt.created.filter(function (e) { return e.props && e.props.className === 'audio-play-resize-grip'; }).pop();
    check('grip still present at minimum size (still findable, still grabbable)', !!gripAfter, '');
  }

  // --- voice Del chip + delete-all-generated-files (2026-09-19) ------------------
  {
    // T-217 contract change: the row's delete is found by its class (audio-play-voice-del),
    // not by the pre-T-200 title wording — and there is ONE delete button per voice again,
    // because the plugin store is the only copy (the two-step scoped delete went with the shelf).
    global.window.confirm = function () { return true; };
    // rt.created ACCUMULATES across commits — scope to ONE fresh render batch.
    const n0 = shim.rt.created.length;
    commit();
    const batch = shim.rt.created.slice(n0);
    const voiceDelBtns = batch.filter(function (e) {
      return e.type === 'button' && e.props && /audio-play-voice-del/.test(String(e.props.className || ''));
    });
    check('voice chips render a Del button (2 voices) (T-217 contract change: one delete per voice)', voiceDelBtns.length === 2, voiceDelBtns.length);
    if (voiceDelBtns.length) { voiceDelBtns[0].props.onClick(); await flush(); commit(); await flush(); }
    check('voice Del -> POST delete_voice', calls.indexOf('POST ~delete_voice') >= 0, calls.slice(-4).join(' | '));
    // confirm=NO must never call the route.
    global.window.confirm = function () { return false; };
    const beforeDv = calls.filter(function (c) { return /delete_voice/.test(c); }).length;
    const still = batch.filter(function (e) {
      return e.type === 'button' && e.props && /audio-play-voice-del/.test(String(e.props.className || ''));
    });
    if (still.length) { still[0].props.onClick(); await flush(); }
    check('voice Del + confirm=no -> NO delete request',
      calls.filter(function (c) { return /delete_voice/.test(c); }).length === beforeDv, calls.slice(-3).join(' | '));
    // Delete-all button in the Output section, red, confirm-gated.
    global.window.confirm = function () { return true; };
    const delAll = shim.rt.created.filter(function (e) {
      return e.type === 'button' && JSON.stringify(e.props.children) === '"delete all generated files"';
    }).pop();
    check('delete-all button rendered', !!delAll, '');
    if (delAll) { delAll.props.onClick(); await flush(); }
    check('delete-all + confirm -> POST delete_all_audio', calls.indexOf('POST ~delete_all_audio') >= 0, calls.slice(-4).join(' | '));
    global.window.confirm = function () { return false; };
    if (delAll) { delAll.props.onClick(); await flush(); }
    check('delete-all + confirm=no -> nothing sent',
      calls.filter(function (c) { return /delete_all_audio/.test(c); }).length === 1, calls.slice(-3).join(' | '));
    delete global.window.confirm;
  }

  // --- T-229: the job kind picks the verb and the payload; an input the kind does not
  //     show is never submitted unseen --------------------------------------------
  console.log('\n--- T-229: the job kind (verb, payload, hidden inputs, voice round trip) ---');
  {
    // Every drive below goes through this: a client that has no job kind must fail the
    // checks, not abort the suite (the non-vacuity run against a saved pre-T-229 copy).
    const t229Call = function (which, name, arg) {
      const o = which === 'tools' ? bag.ToolsBox : bag.TtsBox;
      if (o && typeof o[name] === 'function') { o[name](arg); return true; }
      return false;
    };
    const tb = bag.TtsBox;
    check('T-229: the TTS box carries the kind handler', typeof tb.onKindChange === 'function');
    const kindSel = shim.rt.created.filter(function (e) { return e.type === 'select' && String(e.props.className || '') === 'audio-play-kind'; }).pop();
    check('T-229: the kind select is rendered', !!kindSel, '');
    const kindJson = kindSel ? JSON.stringify(kindSel.props.children) : '';
    ['sep', 'gen', 'vc'].forEach(function (k) {
      check('T-229: the tool kind ' + k + ' is selectable inside the TTS section', kindJson.indexOf('"value":"' + k + '"') >= 0, kindJson.slice(0, 200));
    });

    // separate: dispatch_task, the kind's own model, the source file, nothing invented.
    t229Call('tts', 'onKindChange', 'sep');
    bag = commit(); await flush();
    t229Call('tts', 'onToolFile', '/tmp/src.wav');
    bag = commit(); await flush();
    check('T-229: the separate kind resolved a model that serves it', (bag.TtsBox.selModel || {}).task === 'bs_roformer', JSON.stringify(bag.TtsBox.selModel));
    const beforeTask = calls.filter(function (c) { return /dispatch_task/.test(c); }).length;
    t229Call('tools', 'dispatchTask');
    await flush();
    check('T-229: a tool kind dispatches with dispatch_task', calls.filter(function (c) { return /dispatch_task/.test(c); }).length === beforeTask + 1, calls.slice(-3).join(' | '));
    let b = JSON.parse(lastBody(/dispatch_task/) || '{}');
    check('T-229: the tool payload keeps its shape (task_kind + model + file_path, no text, no options)',
      b.task_kind === 'sep' && b.model === 'bs_roformer' && b.file_path === '/tmp/src.wav' && !('text' in b) && !('options' in b), lastBody(/dispatch_task/));
    check('T-229: no lane pin is invented for a tool kind (no endpoint_id key) when the lane is auto (T-242 contract change)',
      !('endpoint_id' in b), lastBody(/dispatch_task/));

    // generate: the prompt and the three knobs ride the payload, exactly as before.
    t229Call('tts', 'onKindChange', 'gen');
    bag = commit(); await flush();
    t229Call('tts', 'onToolText', 'rain on a tin roof');
    t229Call('tts', 'onToolDur', '8'); t229Call('tts', 'onToolGuid', '6.5'); t229Call('tts', 'onToolSteps', '20');
    const t568Mark = shim.rt.created.length;
    bag = commit(); await flush();
    // T-568 (operator ruling 2026-10-17, verbatim: "The TTS prompt text window used should be 'the same' extendable
    // format, including clear and rec button FOR sfx/music 'prompt'", and on the dictation question the ruling was
    // "add mic and grip and clear"). The field holds text here, which is exactly the state where the mic dot is ALSO
    // a clear -- the half the render suite cannot reach, because its harness never types into a field. Read off the
    // render window this commit produced.
    const t568Win = shim.rt.created.slice(t568Mark);
    const t568Ta = t568Win.filter(function (e) { return e.type === 'textarea' && /^prompt, e.g\./.test(String(e.props.placeholder || '')); });
    const t568Clr = t568Win.filter(function (e) { return e.type === 'button' && String(e.props.children || '') === 'Clr'; });
    const t568Mic = t568Win.filter(function (e) { return e.type === 'button' && /^speak the prompt/.test(String(e.props.title || '')); });
    const t568Grip = t568Win.filter(function (e) { return /audio-play-gen-grip568/.test(String((e.props || {}).className || '')); });
    check('T-568: with text in the prompt field, the field is a textarea and the dot beside it is ALSO a Clr',
      t568Ta.length >= 1 && t568Ta[t568Ta.length - 1].props.value === 'rain on a tin roof' && t568Clr.length === 1 && t568Mic.length === 1,
      [t568Ta.length, t568Ta.length ? t568Ta[t568Ta.length - 1].props.value : null, t568Clr.length, t568Mic.length]);
    check('T-568: the prompt field carries its own drag strip, wired',
      t568Grip.length === 1 && typeof t568Grip[0].props.onMouseDown === 'function',
      [t568Grip.length, t568Grip.length ? typeof t568Grip[0].props.onMouseDown : null]);
    check('T-568: the Clr sits beside the dictation dot inside the same field, and its hover says it empties only this field',
      t568Clr.length === 1 && /empties only this field/.test(String((t568Clr[0] || {}).props.title || '')),
      t568Clr.length ? t568Clr[0].props.title : 'no Clr button rendered');
    t229Call('tools', 'dispatchTask');
    await flush();
    b = JSON.parse(lastBody(/dispatch_task/) || '{}');
    check('T-229: a generation kind sends its prompt as text, not file_path',
      b.task_kind === 'gen' && b.text === 'rain on a tin roof' && !('file_path' in b), lastBody(/dispatch_task/));
    // T-596 item 2 re-point (operator ruling 2026-10-21 10:38 Berlin, written against this session's framing:
    // "why hide ? why own thing ? makes no sense! analyse again - if advanced already has steps and guidance, drop it
    // from the upper section. so if kept unset, defaults will be used by the engine"). The measure STOOD on three
    // names in options{}; guidance_scale and num_inference_steps left the generate form's hand-written fields with the
    // boxes that produced them, so what this check can honestly measure now is the opposite half: the one knob the
    // form still owns rides, and the two that moved are NOT in the payload unless the Advanced board put them there.
    // The calls above still ask for onToolGuid / onToolSteps, and the drive helper answers false - the panel has no
    // such handler any more, which is the next check.
    check('T-596 item 2: the generate form has no guidance or steps handler left to type into',
      t229Call('tts', 'onToolGuid', '6.5') === false && t229Call('tts', 'onToolSteps', '20') === false, 'onToolGuid / onToolSteps');
    check('T-229: the knob the generate form still owns rides options{}, and the two that moved to Advanced do not ride unseen',
      !!(b.options && b.options.duration_seconds === '8') && !('guidance_scale' in (b.options || {})) && !('num_inference_steps' in (b.options || {})), lastBody(/dispatch_task/));

    // T-568, the load-bearing half: the clear is PRESSED, and what it empties is measured. It is asked to empty one
    // field, so the field is typed back to where it was afterwards -- the scenarios below rely on this prompt being
    // there, and a test that quietly changes the state of the next one is not a test.
    const t568ClrBtn = shim.rt.created.slice(t568Mark).filter(function (e) { return e.type === 'button' && String(e.props.children || '') === 'Clr'; });
    if (t568ClrBtn.length === 1 && typeof t568ClrBtn[0].props.onClick === 'function') t568ClrBtn[0].props.onClick({});
    // Each read is measured against the render it belongs to. `shim.rt.created` is cumulative, so a window that spans
    // two renders counts a button that the FIRST render made -- which is exactly how this check first failed: it read
    // one Clr, and that Clr was the one already on screen before the press.
    const t568Mark2 = shim.rt.created.length;
    bag = commit(); await flush();
    const t568After = shim.rt.created.slice(t568Mark2).filter(function (e) { return e.type === 'textarea' && /^prompt, e.g\./.test(String(e.props.placeholder || '')); });
    check('T-568: pressing that Clr empties the prompt field',
      t568After.length >= 1 && String(t568After[t568After.length - 1].props.value || '') === '',
      t568After.length ? JSON.stringify(t568After[t568After.length - 1].props.value) : 'no prompt field to read after the press');
    const t568ClrGone = shim.rt.created.slice(t568Mark2).filter(function (e) { return e.type === 'button' && String(e.props.children || '') === 'Clr'; });
    check('T-568: and once the field is empty the clear goes away with it, instead of standing there doing nothing',
      t568ClrGone.length === 0, t568ClrGone.length);
    t229Call('tts', 'onToolText', 'rain on a tin roof');
    const t568Mark3 = shim.rt.created.length;
    bag = commit(); await flush();
    const t568Back = shim.rt.created.slice(t568Mark3).filter(function (e) { return e.type === 'textarea' && /^prompt, e.g\./.test(String(e.props.placeholder || '')); });
    check('T-568: the prompt is typed back, so the scenarios after this one see the state they were written against',
      t568Back.length >= 1 && t568Back[t568Back.length - 1].props.value === 'rain on a tin roof',
      t568Back.length ? t568Back[t568Back.length - 1].props.value : 'no prompt field after typing it back');

    // THE hidden-input rule. Knobs typed for a generation kind must not ride a later kind.
    t229Call('tts', 'onKindChange', 'sep');
    let mark = shim.rt.created.length;
    bag = commit(); await flush();
    const knobInputs = shim.rt.created.slice(mark).filter(function (e) {
      // T-570 re-point (2026-10-17): the guidance placeholder is now "guidance" -- the old one named a value (6.5)
      // that no model spec read today carries. The filter had to follow the field it identifies, or this absence check
      // would have kept passing for the wrong reason: finding nothing is not the same as measuring nothing there.
      // T-596 item 1 re-point (2026-10-21): the duration placeholder is 'sfx ~8' now that the label is printed on
      // the row; the filter still identifies the same three knobs.
      // T-596 item 2 re-point (2026-10-21): the three became one. The filter follows the fields it identifies or this
      // absence check would keep passing for the wrong reason - on a separate-kind commit there is nothing to find
      // either way, so the count of what the GENERATE commit renders is measured below instead.
      return e.type === 'input' && ['sfx ~8', 'guidance', 'steps'].indexOf(String(e.props.placeholder || '')) >= 0;
    });
    check('T-229: the generation knobs are not on screen for the separate kind', knobInputs.length === 0, knobInputs.map(function (e) { return e.props.placeholder; }).join(' | '));
    // T-596 item 2 (2026-10-21): what the generate kind renders today, measured on the commit that has the kind.
    const genKnobs596 = shim.rt.created.filter(function (e) {
      return e.type === 'input' && ['sfx ~8', 'guidance', 'steps'].indexOf(String(e.props.placeholder || '')) >= 0;
    });
    check('T-596 item 2: the generate row carries ONE knob input - duration - and no guidance or steps box',
      genKnobs596.length >= 1 && genKnobs596.every(function (e) { return String(e.props.placeholder || '') === 'sfx ~8'; }),
      genKnobs596.map(function (e) { return e.props.placeholder; }).join(' | '));
    t229Call('tools', 'dispatchTask');
    await flush();
    b = JSON.parse(lastBody(/dispatch_task/) || '{}');
    check('T-229: and nothing they held is submitted unseen (no options on the separate payload)', !('options' in b), lastBody(/dispatch_task/));

    // voice convert: the target alternatives survive the move.
    t229Call('tts', 'onKindChange', 'vc');
    bag = commit(); await flush();
    t229Call('tts', 'onToolTargetVoice', 'voy_doctor');
    bag = commit(); await flush();
    t229Call('tools', 'dispatchTask');
    await flush();
    b = JSON.parse(lastBody(/dispatch_task/) || '{}');
    check('T-229: voice convert keeps target_voice when a registry voice is picked',
      b.task_kind === 'vc' && b.target_voice === 'voy_doctor' && !('target_wav_path' in b) && !('target_job_id' in b), lastBody(/dispatch_task/));

    // A render kind still dispatches with dispatch_tts, and a tool-kind round trip must
    // not resurrect a voice the user removed (the T-227 invariant, re-pinned here).
    bag.TtsBox.onModelChange('tts', 'm1');
    bag.TtsBox.onSelectVoice('tts', '__no_voice__');
    bag = commit(); await flush();
    t229Call('tts', 'onKindChange', 'sep');
    bag = commit(); await flush();
    t229Call('tts', 'onKindChange', 'tts');
    bag = commit(); await flush();
    check('T-229: the NO VOICE pick survives a tool-kind round trip', (bag.TtsBox.selVoice || {}).tts === '__no_voice__', JSON.stringify(bag.TtsBox.selVoice));
    const ttsBefore = calls.filter(function (c) { return /dispatch_tts/.test(c); }).length;
    bag.TtsBox.onText('kind round trip words');
    bag = commit(); await flush();
    bag.TtsBox.dispatchTts();
    await flush();
    check('T-229: a render kind dispatches with dispatch_tts', calls.filter(function (c) { return /dispatch_tts/.test(c); }).length === ttsBefore + 1, calls.slice(-3).join(' | '));
    check('T-229: and the voice-less dispatch still omits the voice key', !/"voice":/.test(lastBody(/dispatch_tts/)), lastBody(/dispatch_tts/));
  }

  // --- T-242 (user report 2026-10-07): "for sound convert or sfx tools we do not show the
  //     dropdown to pin to an endpoint, like we just added to stt lane — all generation
  //     tasks should have the same pinning options". The tool kinds now carry the SAME tts
  //     lane the render kinds pin: the control is on screen for a tool kind, and the pin
  //     rides dispatch_task with the same semantics (auto = NO endpoint_id key at all).
  console.log('\n--- T-242: the tool kinds carry the lane pin (control visible, payload identical beside it) ---');
  {
    // Every read below comes from ONE fresh render batch: shim.rt.created ACCUMULATES
    // across passes, and a stale pass's lane select would make "the control is on screen
    // for a tool kind" pass against a client that does not render it.
    let t242Tree = [];
    const t242Commit = function () {
      const n = shim.rt.created.length;
      bag = commit();
      t242Tree = shim.rt.created.slice(n);
      return bag;
    };
    const t242Call = function (which, name, arg) {
      const o = which === 'tools' ? bag.ToolsBox : bag.TtsBox;
      if (o && typeof o[name] === 'function') { o[name](arg); return true; }
      return false;
    };
    // Back to a tool kind with the lane still auto, and take the AUTO body as a STRING.
    // Every pinned body below is compared against this exact string, so "the auto case is
    // byte-identical" is a byte comparison and not a restatement of the shape checks.
    t242Call('tts', 'onKindChange', 'sep');
    t242Commit(); await flush();
    t242Call('tts', 'onToolFile', '/tmp/src.wav');
    t242Commit(); await flush();
    t242Call('tools', 'dispatchTask');
    await flush();
    const autoBody = String(lastBody(/dispatch_task/) || '');
    check('T-242: setup — the auto tool dispatch is on the wire and its body is captured', /"task_kind":"sep"/.test(autoBody), autoBody);

    // The lane selects of the LATEST pass: the tts one is created first, the stt one second.
    const t242Lanes = function () {
      return t242Tree.filter(function (e) { return e.type === 'select' && String(e.props.className || '') === 'audio-play-lane'; });
    };
    const t242Pin = async function (v) {
      const s = t242Lanes()[0];
      if (!s) return false;
      s.props.onChange({ target: { value: v } });
      t242Commit(); await flush();
      return true;
    };
    const t242Run = async function () {
      const n0 = calls.filter(function (c) { return /dispatch_task/.test(c); }).length;
      t242Call('tools', 'dispatchTask');
      await flush();
      return {
        sent: calls.filter(function (c) { return /dispatch_task/.test(c); }).length === n0 + 1,
        body: String(lastBody(/dispatch_task/) || ''),
      };
    };

    const lanesTool = t242Lanes();
    check('T-242: the lane select is rendered while a TOOL kind is selected (one lane control per fn in the TTS section, whatever the kind)',
      lanesTool.length === 2 && lanesTool[0].props.value === 'auto',
      lanesTool.map(function (s) { return s.props.value; }));
    const toolOpts = JSON.stringify((lanesTool[0] || {}).props.children || {});
    check('T-242: the tool lane select offers the SAME values the render kinds offer (auto / primary / the registry slot), not a tool-only list',
      /"value":"auto"/.test(toolOpts) && /"value":"primary"/.test(toolOpts), toolOpts.slice(0, 220));
    // U-18 (user 2026-10-13, 01:39): the hover is a user remark. The row key (endpoint_wait) and the count
    // phrase left it; the same three facts are now stated in words - which endpoint the job runs on, that a
    // pin is honoured alone ("never moved somewhere else"), and that it queues behind a render.
    const t242Tip = String((lanesTool[0] || {}).props.title || '');
    check('T-242: its wording is honest for a tool job — the endpoint the tool runs on, the honoured-alone pin, and the queue it lines up in',
      /TOOL KIND/.test(t242Tip)
      && /voice endpoint a tool job runs on/.test(t242Tip)
      && /never moved somewhere else/.test(t242Tip)
      && /lines up behind a render/.test(t242Tip)
      && !/endpoint_wait|dispatch_|\/[a-z_]+\/[a-z_]+/.test(t242Tip),
      t242Tip.slice(0, 160));

    const pinned1 = await (async function () { await t242Pin('primary'); return t242Run(); })();
    check('T-242: a pinned primary lane sends endpoint_id:"primary" on dispatch_task',
      pinned1.sent && /"endpoint_id":"primary"/.test(pinned1.body), pinned1.body);
    check('T-242: endpoint_id is the ONLY new key and it is appended last (the pinned body is the auto body plus that one key)',
      pinned1.body === autoBody.replace(/\}$/, ',"endpoint_id":"primary"}')
      && Object.keys(JSON.parse(pinned1.body)).join(',') === 'task_kind,model,file_path,endpoint_id', pinned1.body);

    const pinned2 = await (async function () { await t242Pin('e-1'); return t242Run(); })();
    check('T-242: an e-<n> lane sends that id (the host id, not a url) — the same value the render kinds send',
      pinned2.body === autoBody.replace(/\}$/, ',"endpoint_id":"e-1"}'), pinned2.body);

    // ONE lane state per fn: the pin picked in front of a tool kind is the SAME pick the
    // render verb sends, and a kind change does not invent a second one.
    t242Call('tts', 'onKindChange', 'tts');
    t242Commit(); await flush();
    bag.TtsBox.onText('t242 one lane state');
    t242Commit(); await flush();
    const ttsBefore242 = calls.filter(function (c) { return /dispatch_tts/.test(c); }).length;
    bag.TtsBox.dispatchTts();
    await flush();
    check('T-242: the same pick pins the render verb too — one lane state per fn, not a tool-only lane',
      calls.filter(function (c) { return /dispatch_tts/.test(c); }).length === ttsBefore242 + 1
      && /"endpoint_id":"e-1"/.test(String(lastBody(/dispatch_tts/))), lastBody(/dispatch_tts/));
    const lanesRender = t242Lanes();
    check('T-242: and the render kind shows the SAME lane control with the SAME value (no second select appeared for the tools)',
      lanesRender.length === 2 && lanesRender[0].props.value === 'e-1'
      && !/TOOL KIND/.test(String(lanesRender[0].props.title || '')),
      [lanesRender.map(function (s) { return s.props.value; }), String(lanesRender[0].props.title || '').slice(0, 60)]);

    // Back to the tool kind: the kind change did not silently change the lane.
    t242Call('tts', 'onKindChange', 'sep');
    t242Commit(); await flush();
    const backTool = await t242Run();
    check('T-242: changing the kind inside the TTS section does not silently change the lane',
      backTool.body === autoBody.replace(/\}$/, ',"endpoint_id":"e-1"}'), backTool.body);

    // The knobs and the target alternatives are untouched by the pin.
    t242Call('tts', 'onKindChange', 'gen');
    t242Commit(); await flush();
    t242Call('tts', 'onToolText', 't242 rain');
    t242Call('tts', 'onToolDur', '7'); t242Call('tts', 'onToolGuid', '6.5'); t242Call('tts', 'onToolSteps', '21');
    t242Commit(); await flush();
    const genPinned = await t242Run();
    const gb = JSON.parse(genPinned.body || '{}');
    // T-596 item 2 re-point (2026-10-21): "its three knobs" became one, for the reason written at the T-229 pin above.
    // The KEY of this check is the pin riding last in a byte-identical body, and that half is untouched.
    check('T-242: a generation kind keeps its prompt and its one remaining form knob, with the pin appended last',
      gb.task_kind === 'gen' && gb.text === 't242 rain' && !('file_path' in gb)
      && gb.options && gb.options.duration_seconds === '7' && !('guidance_scale' in (gb.options || {})) && !('num_inference_steps' in (gb.options || {}))
      && gb.endpoint_id === 'e-1'
      && Object.keys(gb).join(',') === 'task_kind,model,text,options,endpoint_id', genPinned.body);

    t242Call('tts', 'onKindChange', 'vc');
    t242Commit(); await flush();
    t242Call('tts', 'onToolTargetVoice', 'keeper');
    t242Commit(); await flush();
    const vcPinned = await t242Run();
    const vb = JSON.parse(vcPinned.body || '{}');
    check('T-242: voice convert keeps its target_voice alternative beside the pin',
      vb.task_kind === 'vc' && vb.target_voice === 'keeper' && !('target_wav_path' in vb) && !('target_job_id' in vb)
      && vb.endpoint_id === 'e-1', vcPinned.body);

    // auto again: the body must be BYTE-IDENTICAL to the captured auto body.
    await t242Pin('auto');
    const t242AutoBack = await (async function () {
      t242Call('tts', 'onKindChange', 'sep');
      t242Commit(); await flush();
      t242Call('tts', 'onToolFile', '/tmp/src.wav');
      t242Commit(); await flush();
      return t242Run();
    })();
    check('T-242: back to auto and the tool body is BYTE-IDENTICAL to the auto body captured above (no key, no empty key)',
      t242AutoBack.body === autoBody, [autoBody, t242AutoBack.body]);
    t242Call('tts', 'onKindChange', 'tts');
    t242Commit(); await flush();
    bag.TtsBox.onText('t242 auto render');
    t242Commit(); await flush();
    bag.TtsBox.dispatchTts();
    await flush();
    check('T-242: auto sends no endpoint_id on the render verb either — the T-195 rule is untouched by this chunk',
      String(lastBody(/dispatch_tts/)).indexOf('endpoint_id') < 0, lastBody(/dispatch_tts/));
  }

  // --- T-352 (T-278, user choice 2026-10-14): the engine's OWN declared parameters on a dispatch -------
  // The knobs are read from the endpoint's capability record and ride as `options`. The checks here are the
  // dispatch half of it: what reaches the host when a knob is set, when it is cleared, and when the record
  // on screen no longer belongs to the model being dispatched. `clon1` is the one model in this fixture
  // that carries a family (glm_tts), so it is the model the record is read for.
  console.log('\n--- T-352: engine options on the wire ---');
  const t352Cls = function (e, c) { return !!(e && e.props && String(e.props.className || '').split(/\s+/).indexOf(c) >= 0); };
  const t352Label = function (e) { const c = (e.props.children || [])[0]; return c && c.props ? String(c.props.children || '') : ''; };
  function t352Fresh() { const n = shim.rt.created.length; bag = commit(); return shim.rt.created.slice(n); }
  function t352CapCalls() { return calls.filter(function (c) { return /model_capabilities/.test(c); }); }
  // T-463: the same two boxes the T-229 scenario drives, reachable from this scenario's scope.
  const t352Call463 = function (which, name, arg, arg2) {
    const o = which === 'tools' ? bag.ToolsBox : bag.TtsBox;
    if (o && typeof o[name] === 'function') { (arg2 === undefined ? o[name](arg) : o[name](arg, arg2)); return true; }
    return false;
  };

  const t352Tree0 = t352Fresh();
  bag.TtsBox.onKindChange('clon');
  t352Fresh(); await flush();
  bag.TtsBox.onModelChange('tts', 'clon1');
  t352Fresh(); await flush();
  bag.TtsBox.onText('t352 actions knob probe');
  const t352Tree = t352Fresh(); await flush();
  const t352State = function (list) {
    const s = list.filter(function (e) { return t352Cls(e, 'audio-play-engine-opts-state352'); }).pop();
    return s ? String(s.props.children || '') : '';
  };
  check('T-352: the block is on screen and says the record has not been read yet, naming family and endpoint',
    /not read yet/.test(t352State(t352Tree)) && /glm_tts/.test(t352State(t352Tree)) && /primary/.test(t352State(t352Tree)),
    t352State(t352Tree));
  check('T-352: nothing is fetched until the person asks — no capability read was issued by opening or rendering',
    t352CapCalls().length === 0, t352CapCalls().join(' | '));
  const t352ReadBtn = t352Tree.filter(function (e) { return t352Cls(e, 'audio-play-engine-opt-read352'); }).pop();
  const t352ClearBtn = t352Tree.filter(function (e) { return t352Cls(e, 'audio-play-engine-opt-clear352'); }).pop();
  check('T-352: the block offers a read control and a clear control, and no knob before a record exists',
    !!t352ReadBtn && !!t352ClearBtn && t352Tree.filter(function (e) { return t352Cls(e, 'audio-play-engine-opt-row352'); }).length === 0,
    [!!t352ReadBtn, !!t352ClearBtn]);
  if (t352ReadBtn) { t352ReadBtn.props.onClick(); await flush(); }
  const t352Tree1 = t352Fresh(); await flush();
  check('T-352: the read is exactly one GET naming fn, id and family',
    t352CapCalls().length === 1 && /^GET ~model_capabilities\?fn=tts&id=primary&family=glm_tts$/.test(String(t352CapCalls()[0])),
    t352CapCalls().join(' | '));
  const t352Rows = t352Tree1.filter(function (e) { return t352Cls(e, 'audio-play-engine-opt-row352'); });
  const t352Labels = t352Rows.map(t352Label);
  check('T-352: five declared names get a control (params AND request_options); the five plugin-owned names get none',
    t352Labels.length === 5
    && ['temperature', 'top_p', 'return_timestamps', 'transcription_mode', 'seed'].every(function (n) {
      return t352Labels.some(function (s) { return s.indexOf('(' + n + ')') >= 0; }); })
    && !['max_frames', 'language', 'voice_samples', 'reference_text', 'instructions'].some(function (n) {
      return t352Labels.some(function (s) { return s.indexOf('(' + n + ')') >= 0; }); }),
    t352Labels.join(' | '));
  const t352TempRow = t352Rows.filter(function (e) { return /\(temperature\)/.test(t352Label(e)); }).pop();
  const t352BoolRow = t352Rows.filter(function (e) { return /\(return_timestamps\)/.test(t352Label(e)); }).pop();
  const t352BoolVals = (function () {
    if (!t352BoolRow) return 'no bool row';
    const sel = (t352BoolRow.props.children || [])[1];
    return (Array.isArray(sel.props.children) ? sel.props.children : [sel.props.children])
      .map(function (o) { return o && o.props ? String(o.props.value) : ''; }).join(',');
  })();
  check('T-352: a declared bool is three states (not sent / true / false) so a real false is sendable',
    t352BoolVals === ',true,false', t352BoolVals);

  if (t352TempRow) { (t352TempRow.props.children || [])[1].props.onChange({ target: { value: '0.8' } }); await flush(); }
  t352Fresh(); await flush();
  bag.TtsBox.dispatchTts();
  await flush();
  const t352Body1 = String(lastBody(/dispatch_tts/));
  check('T-352: a knob the person set rides as options, under the name the record declared',
    /"options":\{"temperature":"0\.8"\}/.test(t352Body1), t352Body1);
  check('T-352: the knob does not disturb any other key of the dispatch body',
    /"text":"t352 actions knob probe"/.test(t352Body1) && /"model":"clon1"/.test(t352Body1), t352Body1);

  if (t352ClearBtn) { t352ClearBtn.props.onClick(); await flush(); }
  t352Fresh(); await flush();
  bag.TtsBox.dispatchTts();
  await flush();
  const t352Body2 = String(lastBody(/dispatch_tts/));
  check('T-352: clearing the knobs puts the body back byte-for-byte — no options key at all',
    t352Body2.indexOf('"options"') < 0 && /"text":"t352 actions knob probe"/.test(t352Body2), t352Body2);

  if (t352TempRow) { (t352TempRow.props.children || [])[1].props.onChange({ target: { value: '0.9' } }); await flush(); }
  bag.TtsBox.onModelChange('tts', 'm2');
  t352Fresh(); await flush();
  bag.TtsBox.dispatchTts();
  await flush();
  const t352Toast = t352Fresh(); await flush();   // a notify only becomes an element on the next render
  const t352Body3 = String(lastBody(/dispatch_tts/));
  check('T-352: a record that belongs to a different model never rides along — it is refused out loud',
    t352Body3.indexOf('"options"') < 0
      && t352Toast.some(function (e) { return /belong to a different model or endpoint/.test(String(e.props.children || '')); })
      && t352Toast.some(function (e) { return /nothing was sent with it/.test(String(e.props.children || '')); }),
    [t352Body3, t352Toast.map(function (e) { return String(e.props.children || '').slice(0, 50); }).filter(function (s) { return s.length > 12; }).join(' ; ').slice(0, 300)]);
  check('T-352: a model with no family in the catalog is answered honestly and offers no knob',
    (function () {
      // T-356 moved the block into its own section, so a fixed trailing window of created elements no
      // longer reaches it. The check now anchors on the block's OWN state line — the last one rendered —
      // and looks for knob rows after it, which is where the block's controls can only appear.
      const all = shim.rt.created;
      let at = -1;
      for (let i = all.length - 1; i >= 0; i--) {
        if (t352Cls(all[i], 'audio-play-engine-opts-state352')) { at = i; break; }
      }
      if (at < 0) return false;
      const s = String((all[at].props || {}).children || '');
      return all.slice(at).filter(function (e) { return t352Cls(e, 'audio-play-engine-opt-row352'); }).length === 0
        && /no family in the catalog|no capability record|no model is selected/.test(s);
    })(), (function () {
      const all = shim.rt.created;
      for (let i = all.length - 1; i >= 0; i--) { if (t352Cls(all[i], 'audio-play-engine-opts-state352')) return String((all[i].props || {}).children || ''); }
      return '(no state line found)';
    })());
  check('T-352: the capability read added no route drift — every verb used is one the host registers (GET here)',
    t352CapCalls().every(function (c) { return /^GET /.test(c); }), t352CapCalls().join(' | '));

  // --- T-463 (user 2026-10-15, answer to the question round about what the Advanced options board follows) ---
  // Question put to the user: "the Advanced (Options) board follows the TTS model selection today. Should it also
  // follow the generate/sfx model and the STT model, depending on which form you are in?" Answer, verbatim:
  // "should also follow stt model, depending on selection , but needs visual implication". Both halves are pinned
  // below: it FOLLOWS (a read issued while bound to transcription goes to the stt endpoint; a tool dispatch
  // carries the knobs read for the tool model) and it is VISIBLE (its first line names the model, the form, the
  // lane and the endpoint, and a record that is not this model's is called out in amber before anyone types).
  console.log('\n--- T-463: the options board follows the form in use, and says which one it followed ---');
  {
    const own463 = function () {
      const all = shim.rt.created.filter(function (e) { return t352Cls(e, 'audio-play-cap-owner363'); });
      return all.length ? String(all[all.length - 1].props.children || '') : '(no ownership line rendered)';
    };
    const note463 = function () {
      const all = shim.rt.created.filter(function (e) { return t352Cls(e, 'audio-play-cap-note363'); });
      return all.length ? String(all[all.length - 1].props.children || '') : '(no form note rendered)';
    };
    const stale463 = function () {
      const all = shim.rt.created.filter(function (e) { return t352Cls(e, 'audio-play-cap-stale363'); });
      return all.length ? String(all[all.length - 1].props.children || '') : '(no stale line rendered)';
    };
    const readBtn463 = function () {
      return shim.rt.created.filter(function (e) { return t352Cls(e, 'audio-play-engine-opt-read352'); }).pop();
    };

    // a) a render kind: the board is bound to the render picker, and says so in four parts.
    t352Call463('tts', 'onKindChange', 'clon'); bag = commit(); await flush();
    t352Call463('tts', 'onModelChange', 'tts', 'clon1'); bag = commit(); await flush();
    check('T-463: on a render kind the board names its model, the form it belongs to, the lane, and the endpoint it read from',
      /clon1/.test(own463()) && /the text render form/.test(own463()) && /tts lane/.test(own463())
      && /record read from primary/.test(own463()), own463());

    // b) the transcription picker re-binds it, and the read that follows goes to the STT endpoint.
    t352Call463('tts', 'onModelChange', 'stt', 'clon1'); bag = commit(); await flush();
    check('T-463: touching the transcription picker re-binds the board, and the ownership line says which one it followed',
      /clon1/.test(own463()) && /the transcription form/.test(own463()) && /stt lane/.test(own463()), own463());
    const capBefore463 = t352CapCalls().length;
    if (readBtn463()) { readBtn463().props.onClick(); await flush(); }
    check('T-463: a record read while bound to transcription is read from the endpoint transcription runs on (fn=stt)',
      t352CapCalls().length === capBefore463 + 1
      && /^GET ~model_capabilities\?fn=stt&id=primary&family=glm_tts$/.test(String(t352CapCalls().slice(-1)[0])),
      t352CapCalls().slice(-1).join(' | '));
    check('T-463: the transcription half states what the host can carry today instead of implying a control that works',
      /no engine-options door on the host yet/.test(note463()) && /dispatch_stt carries diar knobs only/.test(note463()),
      note463().slice(0, 160));

    // c) a tool kind on screen: the render form is not there, so the board follows the tool form.
    t352Call463('tts', 'onKindChange', 'gen'); bag = commit(); await flush();
    check('T-463: a tool kind re-binds the board to the tool form and names the tool model the kind resolved',
      /controlfoley/.test(own463()) && /the tool \/ generate form/.test(own463()) && /tts lane/.test(own463()),
      own463());
    const capBefore463b = t352CapCalls().length;
    if (readBtn463()) { readBtn463().props.onClick(); await flush(); }
    // The read resolves through a promise, so its state only becomes elements on the NEXT commit — the same
    // order the T-352 scenario uses for its own read. Without this pass the knob rows are not on screen yet.
    bag = commit(); await flush();
    const t463Rows = (function () {
      const all = shim.rt.created;
      let at = -1;
      for (let i = all.length - 1; i >= 0; i--) { if (t352Cls(all[i], 'audio-play-engine-opts-state352')) { at = i; break; } }
      return at < 0 ? [] : all.slice(at).filter(function (e) { return t352Cls(e, 'audio-play-engine-opt-row352'); });
    })();
    const t463Labels = t463Rows.map(t352Label).join(' | ');
    check('T-463: the tool model record is read with fn=tts (the lane a tool job rides, T-242) and offers its declared names',
      t352CapCalls().length === capBefore463b + 1
      && /^GET ~model_capabilities\?fn=tts&id=primary&family=controlfoley$/.test(String(t352CapCalls().slice(-1)[0]))
      && t463Labels.indexOf('(duration_seconds)') >= 0 && t463Labels.indexOf('(seed)') >= 0,
      [String(t352CapCalls().slice(-1)[0]), t463Labels]);
    // Each knob write is a state write made through the closure of the render that CREATED that row, so two
    // writes off one render snapshot overwrite each other - the second would silently drop the first. Every
    // write below is followed by its own commit, and the next row is taken from the newest render.
    const rows463Now = function () {
      const all = shim.rt.created;
      let at = -1;
      for (let i = all.length - 1; i >= 0; i--) { if (t352Cls(all[i], 'audio-play-engine-opts-state352')) { at = i; break; } }
      return at < 0 ? [] : all.slice(at).filter(function (e) { return t352Cls(e, 'audio-play-engine-opt-row352'); });
    };
    const knob463 = function (name) {
      return rows463Now().filter(function (e) { return t352Label(e).indexOf('(' + name + ')') >= 0; }).pop();
    };
    const setKnob463 = async function (name, value) {
      const row = knob463(name);
      if (!row) return false;
      (row.props.children || [])[1].props.onChange({ target: { value: value } });
      await flush();
      bag = commit(); await flush();
      return true;
    };
    check('T-463: both declared names of the tool record are offered as controls the person can set',
      !!knob463('seed') && !!knob463('duration_seconds'), rows463Now().map(t352Label).join(' | '));
    await setKnob463('seed', '11');
    await setKnob463('duration_seconds', '7');
    t352Call463('tts', 'onToolText', 'deepamp, it really whips the llamas ass');
    t352Call463('tts', 'onToolDur', '3');
    bag = commit(); await flush();
    t352Call463('tools', 'dispatchTask');
    await flush();
    const b463 = JSON.parse(lastBody(/dispatch_task/) || '{}');
    check('T-463: a tool dispatch carries the knobs read for its own model',
      !!(b463.options && b463.options.seed === '11'), JSON.stringify(b463.options || {}));
    check('T-463: the tool form own visible field wins over a knob of the same name, and the board states that rule',
      // T-596 item 2 re-point (2026-10-21): the sentence names ONE form field now ("field ... wins"), because
      // guidance_scale and num_inference_steps are no longer form fields. The rule the pin guards - a visible field
      // outranks a same-named knob, and the board says so out loud - is unchanged.
      !!(b463.options && b463.options.duration_seconds === '3') && /wins over a knob of the same name/.test(note463())
      && /guidance_scale and num_inference_steps are not tool-form fields any more/.test(note463()),
      [JSON.stringify(b463.options || {}), note463().slice(0, 90)]);

    // d) the visual implication of a record that is not this model's, and the refusal that follows it.
    t352Call463('tts', 'onKindChange', 'clon'); bag = commit(); await flush();
    bag = commit(); await flush();
    check('T-463: a record belonging to another model is called out in amber before anyone types into it',
      /belongs to controlfoley/.test(stale463()) && /nothing typed here is sent/.test(stale463()), stale463().slice(0, 160));
    t352Call463('tts', 'onText', 't463 cross-model probe');
    bag = commit(); await flush();
    t352Call463('tts', 'dispatchTts');
    await flush();
    const toast463 = (function () { const n = shim.rt.created.length; bag = commit(); return shim.rt.created.slice(n); })();
    const b463d = String(lastBody(/dispatch_tts/));
    check('T-463: the tool model knob never rides a render for a different model, and the person is told out loud',
      b463d.indexOf('"options"') < 0
      && toast463.some(function (e) { return /belong to a different model or endpoint than clon1/.test(String(e.props.children || '')); }),
      [b463d.slice(0, 140), toast463.map(function (e) { return String(e.props.children || '').slice(0, 60); }).filter(function (x) { return x.length > 12; }).join(' ; ').slice(0, 220)]);

    const src463 = require('fs').readFileSync(TARGET, 'utf8');
    check('T-463: the binding is the picker last touched, the form on screen outranks it, and both dispatches name the job they send',
      /function capActive363\(\)/.test(src463)
      && /var form = kindIsTool\(ttsKind\) \? "tool" : \(\(capForm363 \|\| "text"\) === "stt" \? "stt" : "text"\);/.test(src463)
      && /setCapForm363\(fn === "stt" \? "stt" : \(fn === "task" \? "tool" : "text"\)\)/.test(src463)
      && /capSend352\("tts", "task", sel\)/.test(src463)
      && /capSend352\("tts", "tts", \(selModel && selModel\.tts\) \|\| ""\)/.test(src463),
      'the resolver, the picker write, and the two dispatch calls');
  }

  // --- T-256 / T-257 (T-278, user ruling 2026-10-14): the Mix and Remux block, on the wire -------------
  console.log('\n--- T-256 / T-257: mix and remux on the wire ---');
  function t353Fresh() { const n = shim.rt.created.length; bag = commit(); return shim.rt.created.slice(n); }
  function t353Cls(list, c) { return list.filter(function (e) { return t352Cls(e, c); }); }
  function t353Opts(list, c) {
    const sel = t353Cls(list, c)[0];
    if (!sel) return null;
    const kids = Array.isArray(sel.props.children) ? sel.props.children : [sel.props.children];
    return kids.map(function (o) { return o && o.props ? String(o.props.value) : ''; });
  }
  function t353Btn(list, c) { return t353Cls(list, c).pop(); }
  function t353Toast(list, re) { return list.some(function (e) { return re.test(String(e.props.children || '')); }); }
  function t353SetText(list, c, v) {
    const el = t353Cls(list, c)[0];
    if (!el) return false;
    el.props.onChange({ target: { value: v } });
    return true;
  }
  function t353SetSel(list, c, v) {
    const el = t353Cls(list, c)[0];
    if (!el) return false;
    el.props.onChange({ target: { value: v } });
    return true;
  }

  let t353Tree = t353Fresh(); await flush();
  // The fixture fills every empty string state with '/tmp/in.wav' early in the run (see the "text fields
  // reachable" setup), so the mix and remux fields are NOT empty when this block starts. Each refusal check
  // therefore clears the field it wants empty, through the control's own onChange, rather than assuming a
  // virgin state. The interval baseline is taken here so "no new timer" is a comparison and not a guess.
  const t353Intervals0 = intervals.map(function (i) { return i.ms; }).sort(function (x, y) { return x - y; }).join(',');
  check('T-256: the block is mounted and says out loud that mix and remux are LOCAL host steps, not a dispatch',
    t353Cls(t353Tree, 'audio-play-mixremux353').length === 1
      && t353Toast(t353Tree, /LOCAL steps on the host \(ffmpeg\): no engine, no endpoint, no queue, no new row/),
    t353Cls(t353Tree, 'audio-play-mixremux353').length);
  check('T-256: a bed and a layer are offered ONLY rows that finished ok with audio — a queued or running row is not offered',
    (function () {
      const vals = t353Opts(t353Tree, 'audio-play-mix-bed353') || [];
      return vals[0] === '' && vals.indexOf(JOB) >= 0 && vals.indexOf('ap-0011') >= 0 && vals.indexOf('ap-0012') >= 0
        && vals.indexOf('ap-0008') < 0 && vals.indexOf('ap-0009') < 0;
    })(), (t353Opts(t353Tree, 'audio-play-mix-bed353') || []).join(','));
  check('T-256: no bed stem select before a bed is picked, and no mix or remux call has been issued at all',
    t353Cls(t353Tree, 'audio-play-mix-stem353').length === 0 && mixCalls.length === 0 && remuxCalls.length === 0,
    [t353Cls(t353Tree, 'audio-play-mix-stem353').length, mixCalls.length, remuxCalls.length]);
  t353SetSel(t353Tree, 'audio-play-mix-bed353', ''); await flush();
  t353Tree = t353Fresh(); await flush();
  const t353MixBtn = t353Btn(t353Tree, 'audio-play-mix-go353');
  if (t353MixBtn) { t353MixBtn.props.onClick(); await flush(); }
  let t353After = t353Fresh(); await flush();
  check('T-256: pressing Mix with nothing picked is refused by the panel and NOTHING reaches the host',
    mixCalls.length === 0 && t353Toast(t353After, /pick the row the bed came from/),
    [mixCalls.length, t353After.map(function (e) { return String(e.props.children || '').slice(0, 40); }).filter(function (s) { return s.length > 12; }).join(' ; ').slice(0, 200)]);
  t353SetSel(t353After, 'audio-play-mix-bed353', 'ap-0012');
  t353Tree = t353Fresh(); await flush();
  check('T-256: picking a bed that HAS stems offers the stem select, with the host-picks option first',
    (function () {
      const vals = t353Opts(t353Tree, 'audio-play-mix-stem353') || [];
      return vals.length === 3 && vals[0] === '' && vals.indexOf('vocal') >= 0 && vals.indexOf('background') >= 0;
    })(), (t353Opts(t353Tree, 'audio-play-mix-stem353') || []).join(','));
  const t353Layer1 = t353Cls(t353Tree, 'audio-play-mix-layer353')[0];
  if (t353Layer1) { t353Layer1.props.onChange({ target: { value: 'ap-0011' } }); await flush(); }
  t353Tree = t353Fresh(); await flush();
  if (t353Btn(t353Tree, 'audio-play-mix-go353')) { t353Btn(t353Tree, 'audio-play-mix-go353').props.onClick(); await flush(); }
  t353After = t353Fresh(); await flush();
  check('T-256: one mix call, with the bed row and the layers, and NO options key when nobody typed one',
    mixCalls.length === 1 && mixCalls[0].bed_job_id === 'ap-0012'
      && String(mixCalls[0].layers) === 'ap-0011' && mixCalls[0].options === undefined,
    JSON.stringify(mixCalls[0]));
  check('T-256: the empty layer slot is dropped rather than sent as an empty layer (the host refuses an empty one)',
    mixCalls.length === 1 && mixCalls[0].layers.indexOf('') < 0, JSON.stringify(mixCalls[0] && mixCalls[0].layers));
  check('T-256: a successful mix is reported with the new stem, the bed stem it was mixed onto, and the file it wrote',
    t353Toast(t353After, /mixed 1 layer\(s\) onto bed stem background → mix-ap-9001 on row ap-0007 · \/out\/ap-0012_mix_ap-9001\.wav/),
    t353After.map(function (e) { return String(e.props.children || '').slice(0, 90); }).filter(function (s) { return /mixed/.test(s); }).join(' ; '));

  t353Tree = t353Fresh(); await flush();
  const t353OptInputs = t353Cls(t353Tree, 'audio-play-mix-opt353');
  check('T-256: the four mix options are offered as number inputs carrying the host\'s own bounds in their hover',
    t353OptInputs.length === 4 && t353OptInputs.every(function (e) {
      return e.props.type === 'number' && /leaving it empty sends nothing, so the host's own default runs/.test(String(e.props.title || ''));
    }) && (function () {
      const delay = t353OptInputs.filter(function (e) { return String(e.props.min) === '-600000'; })[0];
      const rate = t353OptInputs.filter(function (e) { return String(e.props.min) === '0.5'; })[0];
      return !!delay && !!rate && String(delay.props.max) === '600000' && String(rate.props.max) === '2';
    })(), t353OptInputs.map(function (e) { return e.props.min + '..' + e.props.max; }).join(','));
  if (t353OptInputs[0]) { t353OptInputs[0].props.onChange({ target: { value: '0.5' } }); await flush(); }
  t353Tree = t353Fresh(); await flush();
  const t353DelayInput = t353Cls(t353Tree, 'audio-play-mix-opt353').filter(function (e) { return String(e.props.min) === '-600000'; })[0];
  if (t353DelayInput) { t353DelayInput.props.onChange({ target: { value: '-250' } }); await flush(); }
  t353Tree = t353Fresh(); await flush();
  if (t353Btn(t353Tree, 'audio-play-mix-go353')) { t353Btn(t353Tree, 'audio-play-mix-go353').props.onClick(); await flush(); }
  t353After = t353Fresh(); await flush();
  check('T-256: only the options that were typed ride along — bed_gain and delay_ms, and no other option key',
    mixCalls.length === 2 && mixCalls[1].options && String(Object.keys(mixCalls[1].options).sort()) === 'bed_gain,delay_ms'
      && mixCalls[1].options.bed_gain === '0.5' && mixCalls[1].options.delay_ms === '-250',
    JSON.stringify(mixCalls[1] && mixCalls[1].options));
  check('T-256: a NEGATIVE delay is reported as having moved the BED, because the answer says which side moved',
    t353Toast(t353After, /the delay moved the bed/),
    t353After.map(function (e) { return String(e.props.children || '').slice(0, 120); }).filter(function (s) { return /delay/.test(s); }).join(' ; '));

  t353Tree = t353Fresh(); await flush();
  if (t353SetText(t353Tree, 'audio-play-mix-path353', '/out/hand_clap.wav')) { await flush(); }
  t353Tree = t353Fresh(); await flush();
  if (t353Btn(t353Tree, 'audio-play-mix-path-add353')) { t353Btn(t353Tree, 'audio-play-mix-path-add353').props.onClick(); await flush(); }
  t353Tree = t353Fresh(); await flush();
  check('T-256: a file path can be added as a layer, and it joins the layer list exactly like a row would',
    t353Cls(t353Tree, 'audio-play-mix-layer353').length === 3
      && (t353Cls(t353Tree, 'audio-play-mix-path353')[0] || { props: {} }).props.value === '',
    [t353Cls(t353Tree, 'audio-play-mix-layer353').length]);

  t353Tree = t353Fresh(); await flush();
  let guard353 = 0;
  while (guard353 < 20 && t353Btn(t353Tree, 'audio-play-mix-layer-add353')) {
    t353Btn(t353Tree, 'audio-play-mix-layer-add353').props.onClick(); await flush();
    t353Tree = t353Fresh(); await flush();
    guard353++;
  }
  check('T-256: layer slots stop at the host\'s own cap (12) — the add button disappears rather than offering a 13th',
    t353Cls(t353Tree, 'audio-play-mix-layer353').length === 12 && !t353Btn(t353Tree, 'audio-play-mix-layer-add353'),
    [t353Cls(t353Tree, 'audio-play-mix-layer353').length, guard353]);
  const t353DropBtn = t353Btn(t353Tree, 'audio-play-mix-layer-drop353');
  if (t353DropBtn) { t353DropBtn.props.onClick(); await flush(); }
  t353Tree = t353Fresh(); await flush();
  check('T-256: dropping a layer slot removes the LAST one and says plainly that nothing on disk is deleted',
    t353Cls(t353Tree, 'audio-play-mix-layer353').length === 11
      && /Nothing is deleted on disk/.test(String((t353Cls(t353Tree, 'audio-play-mix-layer353')[0].props.title || '') + String((t353Btn(t353Tree, 'audio-play-mix-layer-drop353') || { props: {} }).props.title || ''))),
    [t353Cls(t353Tree, 'audio-play-mix-layer353').length]);

  mixRefusal = 'row ap-0012 has 2 stems and none is named like a background bed';
  t353Tree = t353Fresh(); await flush();
  // A toast becomes an element in the render that the promise resolution triggers, which is BEFORE the next
  // t353Fresh() mark. The mark for a refusal check is therefore taken before the click, not after it.
  const t353MarkMix = shim.rt.created.length;
  if (t353Btn(t353Tree, 'audio-play-mix-go353')) { t353Btn(t353Tree, 'audio-play-mix-go353').props.onClick(); await flush(); }
  // The refusal answer travels back through the call's promise chain, so the notify lands a few renders later
  // than a synchronous one would. Three commit rounds are given, and the slice starts at the pre-click mark so
  // whichever render carries it is inside the slice.
  for (let k353 = 0; k353 < 3; k353++) { bag = commit(); await flush(); }
  t353After = shim.rt.created.slice(t353MarkMix);
  check('T-256: a host refusal is repeated in the host\'s own words, not softened into a panel message',
    t353Toast(t353After, /the mix did not go through: row ap-0012 has 2 stems and none is named like a background bed/),
    t353After.map(function (e) { return String(e.props.children || '').slice(0, 90); }).filter(function (s) { return /did not go through/.test(s); }).join(' ; '));
  mixRefusal = null;

  t353Tree = t353Fresh(); await flush();
  t353SetSel(t353Tree, 'audio-play-remux-row353', '');
  if (t353SetText(t353Tree, 'audio-play-remux-video353', '/mnt/llama/scenes/gst1.mp4')) { await flush(); }
  t353Tree = t353Fresh(); await flush();
  const t353Remux0 = remuxCalls.length;
  if (t353Btn(t353Tree, 'audio-play-remux-go353')) { t353Btn(t353Tree, 'audio-play-remux-go353').props.onClick(); await flush(); }
  t353After = t353Fresh(); await flush();
  check('T-257: remux without an audio row is refused by the panel and nothing new reaches the host',
    remuxCalls.length === t353Remux0 && t353Toast(t353After, /remux needs the row whose audio replaces the track/),
    [remuxCalls.length - t353Remux0]);
  t353Tree = t353Fresh(); await flush();
  if (t353SetSel(t353Tree, 'audio-play-remux-row353', 'ap-0011')) { await flush(); }
  t353Tree = t353Fresh(); await flush();
  const t353Codec = t353Cls(t353Tree, 'audio-play-remux-codec353')[0];
  const t353Trim = t353Cls(t353Tree, 'audio-play-remux-trim353')[0];
  check('T-257: codec and trim are offered as the host\'s own two choices each, with the default named, not pre-selected',
    (function () {
      const cv = (t353Opts(t353Tree, 'audio-play-remux-codec353') || []).join(',');
      const tv = (t353Opts(t353Tree, 'audio-play-remux-trim353') || []).join(',');
      return cv === ',aac,copy' && tv === ',longest,shortest' && !!t353Codec && !!t353Trim
        && /host default: aac/.test(String(t353Codec.props.children[0].props.children))
        && /host default: longest/.test(String(t353Trim.props.children[0].props.children));
    })(), [(t353Opts(t353Tree, 'audio-play-remux-codec353') || []).join(','), (t353Opts(t353Tree, 'audio-play-remux-trim353') || []).join(',')]);
  if (t353Trim) { t353Trim.props.onChange({ target: { value: 'shortest' } }); await flush(); }
  t353Tree = t353Fresh(); await flush();
  if (t353Btn(t353Tree, 'audio-play-remux-go353')) { t353Btn(t353Tree, 'audio-play-remux-go353').props.onClick(); await flush(); }
  t353After = t353Fresh(); await flush();
  check('T-256 / T-257: a stem id left over from another row is DROPPED, not carried onto a row that has no such stem',
    (function () {
      const last = remuxCalls[remuxCalls.length - 1] || {};
      return last.audio_job_id === 'ap-0011' && last.stem_id === undefined;
    })(), JSON.stringify(remuxCalls[remuxCalls.length - 1]));
  check('T-257: one remux call carries the video path and the audio row, and ONLY the option that was chosen',
    remuxCalls.length === 1 && remuxCalls[0].video_path === '/mnt/llama/scenes/gst1.mp4'
      && remuxCalls[0].audio_job_id === 'ap-0011' && remuxCalls[0].stem_id === undefined
      && remuxCalls[0].audio_path === undefined
      && remuxCalls[0].options && String(Object.keys(remuxCalls[0].options)) === 'trim' && remuxCalls[0].options.trim === 'shortest',
    JSON.stringify(remuxCalls[0]));
  check('T-257: the answer is reported with the file it wrote and what it did to the track',
    t353Toast(t353After, /remuxed \/mnt\/llama\/scenes\/gst1\.mp4 with ap-0011 \(aac, shortest\) → \/out\/scene_dubbed_ap-9002\.mp4/),
    t353After.map(function (e) { return String(e.props.children || '').slice(0, 110); }).filter(function (s) { return /remuxed/.test(s); }).join(' ; '));
  check('T-257: a row with no stems offers no stem select at all, so the host takes that row\'s own output file',
    (function () {
      const stemSel = t353Cls(t353After, 'audio-play-remux-stem353');
      return stemSel.length === 0;   // ap-0011 has no stems, so the host takes the row's own output file
    })(), t353Cls(t353After, 'audio-play-remux-stem353').length);
  remuxRefusal = 'video_path must be .mp4, .mkv, .webm or .mov (got "txt")';
  t353Tree = t353Fresh(); await flush();
  const t353MarkRx = shim.rt.created.length;
  if (t353Btn(t353Tree, 'audio-play-remux-go353')) { t353Btn(t353Tree, 'audio-play-remux-go353').props.onClick(); await flush(); }
  bag = commit(); await flush();
  t353After = shim.rt.created.slice(t353MarkRx);
  check('T-257: a remux refusal is repeated verbatim, including the extension the host complained about',
    t353Toast(t353After, /the remux did not go through: video_path must be \.mp4, \.mkv, \.webm or \.mov/),
    t353After.map(function (e) { return String(e.props.children || '').slice(0, 90); }).filter(function (s) { return /did not go through/.test(s); }).join(' ; '));
  remuxRefusal = null;
  check('T-256 / T-257: both verbs are POST — no verb drift on either new route',
    calls.filter(function (c) { return /mix_audio|remux_video/.test(c); }).every(function (c) { return /^POST /.test(c); })
      && calls.filter(function (c) { return /mix_audio/.test(c); }).length === mixCalls.length
      && calls.filter(function (c) { return /remux_video/.test(c); }).length === remuxCalls.length,
    calls.filter(function (c) { return /mix_audio|remux_video/.test(c); }).join(' ; '));
  check('T-256 / T-257: no new timer — the block adds no poller, the interval set is exactly what it was before it',
    (function () {
      const a = intervals.map(function (i) { return i.ms; }).sort(function (x, y) { return x - y; }).join(',');
      return a === t353Intervals0;
    })(), intervals.map(function (i) { return i.ms; }).join(',') + ' (was ' + t353Intervals0 + ')');

  console.log('\n  routes hit: ' + Array.from(new Set(calls)).sort().join('\n              '));
  // --- T-357 (user ruling 2026-10-14): the batch board's play control IS the panel's own play button ----
  console.log('\n--- T-357: the batch board on the wire ---');
  let t357Tree = t353Fresh(); await flush();
  const t357Tog = t357Tree.filter(function (e) { return t352Cls(e, 'audio-play-batch-board-toggle357'); })
    .filter(function (e) { return /the board probe/.test(String((e.props || {}).children || '')); })[0];
  check('T-357 setup — the board lists the batch the fixture dispatched, by its own title, with its parts counted by state',
    !!t357Tog && /1 ok, 1 queued/.test(String((t357Tog.props || {}).children || ''))
      && /5\.5s rendered/.test(String((t357Tog.props || {}).children || '')),
    t357Tog ? String(t357Tog.props.children) : '(no board line for this batch)');
  if (t357Tog && typeof t357Tog.props.onClick === 'function') { t357Tog.props.onClick(); await flush(); }
  t357Tree = t353Fresh(); await flush();
  const t357Parts = t357Tree.filter(function (e) { return t352Cls(e, 'audio-play-batch-board-part357'); });
  const t357PartBtn = function (rowId) {
    const row = t357Parts.filter(function (e) {
      const kids = Array.isArray(e.props.children) ? e.props.children : [e.props.children];
      return kids.some(function (k) { return k && k.props && String(k.props.children || '').trim() === rowId; });
    })[0];
    if (!row) return null;
    const kids = Array.isArray(row.props.children) ? row.props.children : [row.props.children];
    return kids.filter(function (k) { return k && k.type === 'button'; })[0] || null;
  };
  const t357Calls0 = calls.length;
  const t357OkBtn = t357PartBtn('ap-0013');
  if (t357OkBtn) { t357OkBtn.props.onClick(); await flush(); }
  const t357NewCalls = calls.slice(t357Calls0);
  check('T-357: the board plays a FINISHED part through the very play button the panel already has — one play_job for exactly that row, asked for nothing else',
    t357NewCalls.length === 1 && t357NewCalls[0] === 'POST ~play_job/ap-0013', t357NewCalls.join(' | ') || 'no call');
  const t357Calls1 = calls.length;
  const t357Mark = shim.rt.created.length;
  const t357QBtn = t357PartBtn('ap-0014');
  if (t357QBtn) { t357QBtn.props.onClick(); await flush(); commit(); await flush(); }
  const t357After = shim.rt.created.slice(t357Mark);
  check('T-357: and the board cannot put an unfinished part on the player — the panel refuses it out loud with its own play-button rule and asks the host for no route',
    (function () {
      const refused = t357After.some(function (e) { return /cannot play ap-0014 yet — the row is queued and there is no take to hear/.test(String((e.props || {}).children || '')); });
      const controlDisabled = !!(t357QBtn && t357QBtn.props.disabled === true);
      return refused && controlDisabled && calls.slice(t357Calls1).length === 0;
    })(), [calls.slice(t357Calls1).join(' | ') || 'no call',
      t357After.map(function (e) { return String((e.props || {}).children || '').slice(0, 60); }).filter(function (s) { return s.length > 12; }).join(' ; ').slice(0, 200),
      t357QBtn ? String(t357QBtn.props.disabled) : 'no button'].join(' :: '));

  // --- T-361 (user ruling 2026-10-14, live panel): the group editor writes through voice_groups and nothing else moves ---
  {
    const t361Btn = function (e, cls) { return e && e.type === 'button' && String((e.props || {}).className || '') === cls; };
    const n361a = shim.rt.created.length;
    commit(); await flush();
    const batch361 = shim.rt.created.slice(n361a);
    const edit361 = batch361.filter(function (e) { return t361Btn(e, 'audio-play-voice-group-edit361'); });
    check('T-361: every voice row carries its own group editor (2 voices in this fixture)', edit361.length === 2, edit361.length);
    const callsBefore361 = calls.length;
    edit361.forEach(function (b361) { b361.props.onClick(); });
    await flush();
    const n361b = shim.rt.created.length;
    commit(); await flush();
    const opened361 = shim.rt.created.slice(n361b);
    check('T-361: opening an editor issues no verb at all — filing a voice is not a request until the person saves it',
      calls.length === callsBefore361, calls.slice(callsBefore361).join(' | '));
    const in361 = opened361.filter(function (e) { return e.type === 'input' && String((e.props || {}).className || '') === 'audio-play-voice-group-input361'; });
    const save361 = opened361.filter(function (e) { return t361Btn(e, 'audio-play-voice-group-save361'); });
    check('T-361: an opened editor is a text field plus a save control, one pair per row opened',
      in361.length === 2 && save361.length === 2, { inputs: in361.length, saves: save361.length });
    check('T-361: the field is prefilled with the labels the voice already carries; an unfiled voice starts empty rather than being shown a filing it does not have',
      String(in361[0].props.value) === '' && String(in361[1].props.value) === 'star trek',
      [String(in361[0].props.value), String(in361[1].props.value)]);
    const otherBefore361 = calls.filter(function (c) { return /dispatch_tts|play_job|save_voice|delete_voice/.test(c); }).length;
    const regBefore361 = calls.filter(function (c) { return /voice_registry/.test(c); }).length;
    in361[1].props.onInput({ target: { value: 'star trek, bridge crew' } });
    await flush();
    // The control clicked must be the one THIS render made with the typed value in its hands — the T-339 lesson
    // (a save whose closure still held the old box content) is exactly what this rules out here.
    const n361c = shim.rt.created.length;
    commit(); await flush();
    const typed361 = shim.rt.created.slice(n361c);
    const inNow361 = typed361.filter(function (e) { return e.type === 'input' && String((e.props || {}).className || '') === 'audio-play-voice-group-input361'; });
    const saveNow361 = typed361.filter(function (e) { return t361Btn(e, 'audio-play-voice-group-save361'); });
    check('T-361: the field still holds what was typed after the re-render — the panel does not snap a person\'s edit back to the stored labels',
      inNow361.length === 2 && String(inNow361[1].props.value) === 'star trek, bridge crew',
      inNow361.map(function (e) { return String(e.props.value); }));
    saveNow361[1].props.onClick(); await flush(); commit(); await flush();
    const grpCalls361 = calls.filter(function (c) { return /voice_groups/.test(c); });
    check('T-361: save issues exactly one verb — POST voice_groups — re-reads the registry so the rows show what the host stored, and dispatches, plays, saves or deletes nothing',
      grpCalls361.length === 1 && grpCalls361[0] === 'POST ~voice_groups'
      && calls.filter(function (c) { return /voice_registry/.test(c); }).length === regBefore361 + 1
      && calls.filter(function (c) { return /dispatch_tts|play_job|save_voice|delete_voice/.test(c); }).length === otherBefore361,
      calls.slice(-5).join(' | '));
    const gBody361 = JSON.parse(String(bodies[calls.indexOf('POST ~voice_groups')] || '{}'));
    check('T-361: what leaves the panel is the voice name and the labels as a list — two keys, nothing else on this route',
      Object.keys(gBody361).length === 2 && gBody361.name === 'keeper' && JSON.stringify(gBody361.groups) === '["star trek","bridge crew"]', JSON.stringify(gBody361));
    const toast361 = shim.rt.created.filter(function (e) { return /filed under/.test(JSON.stringify((e.props || {}).children)); });
    check('T-361: the panel says out loud which labels the voice is now filed under',
      toast361.length >= 1, toast361.map(function (e) { return String(JSON.stringify((e.props || {}).children)).slice(0, 100); }));
  }

  // T-560 (operator request 2026-10-17, verbatim): "the 'reuse' button that re-uses a playlist text for
  // re-generate: on click, should also open and auto-scroll to the corresponding function: and also select the
  // corresponding processing type / model again (if avail in lists)". Every check below reads what the panel ENDED UP
  // showing after the press - which section is open, what the two selects hold, what the three knobs hold - because
  // the claim is about what the person sees, not about what the control intended. It runs last so the state this
  // press deliberately moves cannot leak into any earlier check.
  {
    const textOf560 = function (v) {
      const out560 = [];
      (function w560(x, d) {
        if (d > 14 || x == null) return;
        if (typeof x === 'string' || typeof x === 'number') { out560.push(String(x)); return; }
        if (Array.isArray(x)) { x.forEach(function (n) { w560(n, d + 1); }); return; }
        if (x.props && x.props.children !== undefined) w560(x.props.children, d + 1);
      })(v, 0);
      return out560.join('');
    };
    // The one DOM read this control needs is the one openSection386 already does in the real page: find the section
    // heads by class and scroll the matching one into view. The fake document had no querySelectorAll at all before
    // this scenario, so the scroll half of every navigation button was untestable here; it is mirrored now, with a
    // spy on each head, and it stays in place only for this block.
    let heads560 = [];
    doc.querySelectorAll = function (sel) { return String(sel) === '.audio-play-section-head' ? heads560 : []; };
    const arm560 = function () {
      heads560 = shim.rt.created
        .filter(function (e) { return String((e.props || {}).className || '') === 'audio-play-section-head'; })
        .map(function (e) {
          // textContent is the name the client reads (openSection386 asks for heads[i].textContent), so the
          // mirror has to carry that name for the match to be the same match the real page makes.
          return { textContent: textOf560(e).trim(), text: textOf560(e).trim(), scrolled: 0, opts: null,
            scrollIntoView: function (o) { this.scrolled++; this.opts = o; } };
        });
      return heads560;
    };
    const scrolledTo560 = function (title) {
      return heads560.filter(function (n) { return n.scrolled > 0 && n.text.indexOf(title) >= 0; });
    };
    const closeSection560 = function (title) {
      const hs = shim.rt.created.filter(function (e) {
        return String((e.props || {}).className || '') === 'audio-play-section-head' && textOf560(e).indexOf(title) >= 0;
      });
      if (!hs.length) throw new Error('no section head rendered for ' + title);
      hs[hs.length - 1].props.onClick();     // the header bar's own toggle, the same press a person makes
      return commit();
    };
    const toast560 = function (ixFromEnd) {
      // the same read the T-459 pin uses: the message may sit in a children ARRAY, so the match is made on the
      // stringified children and not on a bare string
      const t = shim.rt.created.filter(function (e) {
        return /reused the text of|carries no text to reuse/.test(JSON.stringify((e.props || {}).children));
      });
      return t.length ? String(JSON.stringify(t[t.length - 1 - (ixFromEnd || 0)].props.children)) : '';
    };
    // Which text lane holds what, read off the panel's own state rather than off a textarea in the element log:
    // the log also carries the scene composer's dialogue field and the CAP board's probe field, so "the last text
    // field on screen" is not the TTS box. A lane is identified by its store slot, so a later press can be checked
    // against the SAME slot the earlier press wrote.
    const laneSlot560 = function (value) {
      const rs = shim.rt.stores.get(bag.AudioPlayerPanel.__key) || [];
      for (let i = rs.length - 1; i >= 0; i--) if (rs[i] === value) return i;
      return -1;
    };
    const laneValue560 = function (ix) {
      const rs = shim.rt.stores.get(bag.AudioPlayerPanel.__key) || [];
      return ix >= 0 && ix < rs.length ? rs[ix] : null;
    };
    const selectValue560 = function (cls) {
      const ss = shim.rt.created.filter(function (e) { return e.type === 'select' && String((e.props || {}).className || '') === cls; });
      return ss.length ? String(ss[ss.length - 1].props.value) : null;
    };

    await closeSection560('TTS/MUSIC/SFX');
    let b560 = commit(); await flush();
    check('T-560 setup: the TTS section is CLOSED before the press, so "it opened the function" is something the press has to cause and not something already true',
      !b560.TtsBox && !b560.ToolsBox, JSON.stringify(Object.keys(b560)));
    arm560();
    bag.PlaylistPane.reuseText('ap-0011'); await flush(); b560 = commit(); await flush();
    check('T-560 the half that must NOT happen: a row with no words to reuse moves nothing - the section stays shut, nothing is scrolled, no model is touched',
      !b560.TtsBox && heads560.every(function (n) { return n.scrolled === 0; }) && /carries no text to reuse/.test(toast560()),
      [!!b560.TtsBox, heads560.map(function (n) { return n.scrolled; }), toast560().slice(0, 90)]);

    arm560();
    bag.PlaylistPane.reuseText('ap-0015'); await flush(); b560 = commit(); await flush();
    check('T-560 (open and auto-scroll to the corresponding function): the press on an sfx / music row opened the section that owns that row and brought the page to its header',
      !!b560.TtsBox && scrolledTo560('TTS/MUSIC/SFX').length >= 1
      && !!scrolledTo560('TTS/MUSIC/SFX')[0].opts && scrolledTo560('TTS/MUSIC/SFX')[0].opts.block === 'start',
      [!!b560.TtsBox, scrolledTo560('TTS/MUSIC/SFX').map(function (n) { return n.text + ' x' + n.scrolled; })]);
    check('T-560 (select the corresponding processing type again): the job-kind selector now holds the kind this row was - generate (sfx / music) - in the select a person reads',
      b560.TtsBox && b560.TtsBox.kind === 'gen' && selectValue560('audio-play-kind') === 'gen',
      [b560.TtsBox && b560.TtsBox.kind, selectValue560('audio-play-kind')]);
    check('T-560 (select the corresponding model again, IF AVAIL IN LISTS): the model slot this row dispatches with carries the model the row recorded, and the select shows it',
      b560.TtsBox && b560.TtsBox.selModel && b560.TtsBox.selModel.task === 'controlfoley'
      && selectValue560('audio-play-model') === 'controlfoley',
      [b560.TtsBox && b560.TtsBox.selModel, selectValue560('audio-play-model')]);
    check('T-560 (restore the generation settings saved in the row): the duration knob holds the 8 seconds this row was created with - read off the options the host stored on the row, not guessed',
      !!b560.ToolsBox && String(b560.ToolsBox.toolDur) === '8',
      b560.ToolsBox && [b560.ToolsBox.toolDur, b560.ToolsBox.toolGuid, b560.ToolsBox.toolSteps]);
    // T-596 item 2 re-point (2026-10-21): this pin used to measure two EMPTY FIELDS. The fields are gone, and an
    // empty-field check on a field that does not exist passes for the wrong reason (`undefined || ''` is ''). What
    // survives the ruling is the RULE the pin guarded - a knob the row never carried must not carry over - and it is
    // now measured where it can be measured: the payload a dispatch sends, and the fact that the panel holds no
    // guidance or steps value at all.
    check('T-596 item 2: the panel holds no guidance or steps value to carry over from the last thing this panel typed',
      !!b560.ToolsBox && !('toolGuid' in b560.ToolsBox) && !('toolSteps' in b560.ToolsBox),
      Object.keys(b560.ToolsBox || {}).filter(function (k) { return /tool(Guid|Steps)/.test(k); }).join(',') || 'none');
    check('T-560 (the panel says out loud what the press did, including the section it opened and the settings it put back)',
      // T-573 re-point (2026-10-17): the section is named "TTS/MUSIC/SFX" now (operator ruling, verbatim: "rename
      // section 'TTS (ONE VOICE)' to 'TTS/MUSIC/SFX'"). The regex is what the panel actually says today -- the escape
      // pairs that used to wrap "one voice" are gone because the new name has no parentheses, and the check still
      // demands the sentence name the section it opened.
      /opened TTS\/MUSIC\/SFX and scrolled to it/.test(toast560())
      && /processing type generate \(sfx \/ music\)/.test(toast560())
      && /model controlfoley re-selected from this row/.test(toast560())
      && /restored duration 8 s/.test(toast560()), toast560().slice(0, 260));

    arm560();
    bag.PlaylistPane.reuseText('ap-0012'); await flush(); b560 = commit(); await flush();
    check('T-560 (the type follows the ROW, not the kind the panel happened to be on): a separate row lands the kind selector on separate and the model slot on that row-s model',
      b560.TtsBox && b560.TtsBox.kind === 'sep' && b560.TtsBox.selModel.task === 'bs_roformer',
      [b560.TtsBox && b560.TtsBox.kind, b560.TtsBox && b560.TtsBox.selModel]);
    check('T-560 (T-229-s rule survives the new move: a knob the landed kind does not render must never ride the payload): landing a separate row empties the one knob the form has',
      !!b560.ToolsBox && String(b560.ToolsBox.toolDur || '') === '',
      b560.ToolsBox && [b560.ToolsBox.toolDur]);

    // T-596 item 2 (2026-10-21): a row that DID carry the two moved knobs is named to the person instead of being
    // written back into fields that no longer exist. The fixture row is written through the SAME object the panel
    // holds - `reuseTextFromRow` looks the row up in the panel's own `playlist` state (client.js:14928-14929), and
    // the host answers a row's `options` verbatim - so this is a row that carried the names, not a payload guess.
    // The row is put back exactly as it was before the next press reads it.
    const row596 = (bag.PlaylistPane.playlist || []).filter(function (r) { return r.id === 'ap-0015'; })[0];
    const optsWas596 = Object.assign({}, row596.options);
    row596.options = Object.assign({}, row596.options, { guidance_scale: '4.5', num_inference_steps: '25' });
    arm560();
    bag.PlaylistPane.reuseText('ap-0015'); await flush(); b560 = commit(); await flush();
    const toast596 = toast560();
    check('T-596 item 2: a row that was made with guidance and steps says so, and says nothing was typed for them',
      /guidance scale 4.5 and num inference steps 25 were set on that row but are engine options now/.test(toast596)
      && /nothing was typed for them, so the model's own default applies unless you set them in Advanced \(Options\)/.test(toast596),
      toast596.slice(0, 300));
    check('T-596 item 2: the duration the row carried still lands in the one field that exists',
      !!b560.ToolsBox && String(b560.ToolsBox.toolDur) === '8' && /restored duration 8 s/.test(toast596), toast596.slice(0, 200));
    row596.options = optsWas596;
    arm560();
    bag.PlaylistPane.reuseText('ap-0015'); await flush(); b560 = commit(); await flush();
    // The newest line only: `toast560()` matches any element whose stringified children carry the sentence, and a
    // log entry is nested inside the log page, so the newest MATCH is the whole page - which still holds the earlier
    // toast. This check is about what the LATEST press said, so it reads the leaf line.
    const leaf596 = shim.rt.created.filter(function (e) {
      return typeof (e.props || {}).children === 'string' && /reused the text of ap-0015/.test(String(e.props.children));
    }).pop();
    check('T-596 item 2: a row that never carried them is not told about them (the fixture is back to what it was)',
      !!leaf596 && !/are engine options now/.test(String(leaf596.props.children)),
      leaf596 ? String(leaf596.props.children).slice(0, 220) : 'no reuse line rendered');

    await closeSection560('STT (transcription)');
    b560 = commit(); await flush();
    check('T-560 setup: the STT section is closed too, so the same claim is tested on the other function and not only on the one the ask named',
      !b560.SttBox, JSON.stringify(Object.keys(b560)));
    // T-771 (2026-11-10) re-cuts the SECTION half of this block, on the operator's words: "keep current
    // functionality, update the 'from playlist' selection, we already have the show button to jump to the STT
    // section, so make the reuse jump in to the TTS section which it currently already fills in accordingly". A press
    // that wrote a row's words into the TTS text field and then walked the page to the STT section is what was
    // reported. The section a press opens is now the section its words are written into. Every other claim here is
    // kept: the language landing — read with that section open, which the fixture now does with the same header
    // toggle a person uses, because the press no longer opens it — and the model-the-panel-refused-to-move sentence,
    // both unchanged. What moved is the one thing that changed.
    await closeSection560('TTS/MUSIC/SFX');
    b560 = commit(); await flush();
    check('T-771 setup: the TTS section is closed as well, so that "the press opened it" is measured and not assumed',
      !b560.TtsBox && !b560.SttBox, JSON.stringify(Object.keys(b560)));
    arm560();
    bag.PlaylistPane.reuseText('ap-0010'); await flush(); b560 = commit(); await flush();
    const ttsLane560 = laneSlot560('the spoken words');
    check('T-771 (the section a transcription row is taken to is the one its words are written into): the press opened TTS/MUSIC/SFX, scrolled to its header, and the words are in that lane',
      !!b560.TtsBox && scrolledTo560('TTS/MUSIC/SFX').length >= 1 && ttsLane560 >= 0
      && laneValue560(ttsLane560) === 'the spoken words',
      [!!b560.TtsBox, scrolledTo560('TTS/MUSIC/SFX').map(function (n) { return n.text + ' x' + n.scrolled; }),
        laneValue560(ttsLane560)]);
    check('T-771 (the STT section stays closed and nothing scrolls to it — the row-s own view control is what opens it, exactly as the operator said): the press opens one section, not two',
      !b560.SttBox && scrolledTo560('STT (transcription)').length === 0,
      [!!b560.SttBox, scrolledTo560('STT (transcription)').length]);
    check('T-771 (a press that shows one section and restores a form in another says both): the notice names where the words are and how to reach the transcription form',
      /the words are in the TTS text field, which is the section this press opened/.test(toast560())
      && /restored in the STT \(transcription\) form, and view on this row is what opens it/.test(toast560()),
      toast560().slice(0, 340));
    await closeSection560('STT (transcription)');
    b560 = commit(); await flush();
    check('T-560 ("language for tts", the operator-s own words, read on the lane that carries one): the language the row was rendered in is put back into that lane-s language control (re-cut by T-771: the press no longer opens this section, so the fixture opens it by the same header toggle a person uses; the landing itself is untouched and still asserted)',
      b560.SttBox && b560.SttBox.selLang && b560.SttBox.selLang.stt === 'de', b560.SttBox && b560.SttBox.selLang);
    check('T-560 (the "if avail in lists" half, measured on a model this fleet no longer lists): the model is left exactly where the person had it, and the panel says which model it refused to move',
      /qwen3_asr/.test(toast560()) && /is not in the current lists, so the model was left as it is/.test(toast560()),
      toast560().slice(0, 260));

    // T-771 part 2 — the "from playlist" picker in the STT section, which is what the same report could not reach:
    // "in STT section: I can't select it in the 'from playlist' dropdown to 're-transcribe it using different
    // model' ... so, i can't really use the button currently for anything with this playlist entry?", plus "make the
    // 'from playlist' selection drop down in the STT section longer so it can display more", the shape chosen from
    // the options put being "keep the dropdown, make it wider and label rows better". The fixture row ap-0010 is the
    // shape of the live row ap-1317 measured the same day: a transcription row whose output_path is a .txt, with the
    // audio that lane consumed on other fields of the same row. Fields are written through the panel's own playlist
    // state and put back exactly as they were, the way T-596 item 2 does.
    const row771 = (bag.PlaylistPane.playlist || []).filter(function (r) { return r.id === 'ap-0010'; })[0];
    const FEED771 = '/out/ap-0010_qwen3-asr_the-spoken-words_feed.wav';
    const SRC771 = '/out/ap-0010_src.wav';
    // Read the picker itself, not every option in the element log. The log is cumulative across the whole suite and
    // the mix / remux board (T-353) lists EVERY row with its own `id · kind` label, so an unscoped read of option
    // labels measures that board and not this one. The control is named by the hover it carries, which is unique to
    // it: the tool section's own picker still says "a generated playlist row".
    const sttPick771 = function () {
      const sel = shim.rt.created.filter(function (e) {
        return e.type === 'select' && String((e.props || {}).title || '') === "use a playlist row's audio as the source";
      }).pop();
      if (!sel) return { sel: null, opts: [] };
      const kids = Array.isArray((sel.props || {}).children) ? (sel.props || {}).children : [];
      return { sel: sel, opts: kids.filter(function (o) {
        return o && String((o.props || {}).children || '').indexOf('ap-0010') === 0;
      }).map(function (o) { return String((o.props || {}).children); }) };
    };
    const pickOpts771 = function () { return sttPick771().opts; };
    const pickSelect771 = function () { return sttPick771().sel; };
    const said771 = function (re) {
      return re.test(JSON.stringify(shim.rt.created.map(function (e) { return (e.props || {}).children; })));
    };
    check('T-771 (what the operator could not do): a transcription row whose output_path is a text file is offered NOWHERE in the picker, and a pick on it is refused by name rather than writing a .txt into an audio field',
      pickOpts771().length === 0, pickOpts771());
    const fileWas771 = String((b560.SttBox || {}).sttFile || '');
    bag.SttBox.onUseRow('ap-0010'); await flush(); b560 = commit(); await flush();
    check('T-771 (the refusal is a sentence, not a silent no-op, and it changes nothing): the panel says the row carries no audio this lane can be fed, and the file field is left exactly as it was',
      String((b560.SttBox || {}).sttFile || '') === fileWas771 && said771(/carries no audio file this lane can be fed/),
      [String((b560.SttBox || {}).sttFile), fileWas771]);
    row771.stt_feed = { mode: 'original', rate: 48000, channels: 'source', feed_path: FEED771 };
    row771.file_path = SRC771;
    b560 = commit(); await flush();
    check('T-771 (the same row, now carrying the audio it was fed, IS offered, and the label says what it is): id, the kind, and the name of the file this entry would actually feed the lane',
      pickOpts771().length >= 1 && /^ap-0010 \u00B7 stt \u00B7 /.test(pickOpts771()[0]), pickOpts771());
    bag.SttBox.onUseRow('ap-0010'); await flush(); b560 = commit(); await flush();
    check('T-771 (the pick sets the audio the lane can be fed, not the transcript it wrote): the feed copy lands in the STT file field, and the .txt never reaches an audio field',
      String((b560.SttBox || {}).sttFile || '') === FEED771, [String((b560.SttBox || {}).sttFile)]);
    check('T-771 (the notice says WHICH audio it picked): "the audio the transcription lane was fed" is not the same claim as "the audio this row produced"',
      /source set to ap-0010 \u00B7 ap-0010_qwen3-asr_the-spoken-words_feed\.wav \u00B7 the audio the transcription lane was fed/.test(
        JSON.stringify(shim.rt.created.map(function (e) { return (e.props || {}).children; }))),
      String((b560.SttBox || {}).sttFile));
    const sel771 = pickSelect771();
    check('T-771 (the wider control the operator asked for, read on the very control that now lists the row): the cap is 340px and the grow base 220px, up from 190px and 140px, and the cap is still a cap',
      !!sel771 && ((sel771.props || {}).style || {}).maxWidth === '340px'
      && ((sel771.props || {}).style || {}).flex === '1 1 220px',
      sel771 ? JSON.stringify([(sel771.props || {}).style || {}]) : 'no select rendered that lists a transcription row');
    delete row771.stt_feed; delete row771.file_path;
    b560 = commit(); await flush();
    check('T-771 (the offer follows the row, not a one-time mutation): put the fixture back as it was and the row is unoffered again',
      pickOpts771().length === 0, pickOpts771());
    const src771 = require('fs').readFileSync(TARGET, 'utf8');
    const count771 = function (needle) {
      return (src771.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    };
    check('T-771 contract (re-cut by T-772, 2026-11-10 — the claim is unchanged, the count moved because a third door now asks the same question; the operator ruled that door and refused to change what it resolves, verbatim: "do 3 , ... do not do 2 it would change the expected behaviour"): one answer to "can this row be fed, and from which file" exists, and every door asks it — the picker that lists rows, the pick that sets the file, and the row-s own re-transcribe control',
      count771('function sttSourceOfRow771(') === 1 && count771('sttSourceOfRow771(') === 4,
      [count771('function sttSourceOfRow771('), count771('sttSourceOfRow771(')]);
    check('T-771 contract: the two questions the picker and the pick used to ask separately are gone from the client — the STT picker no longer filters on kind==="tts" and the pick no longer reads output_path directly',
      count771('j.kind === "tts" && j.status === "ok" && j.output_path') === 0
      && count771('(setter || setSttFile)(row.output_path)') === 0,
      [count771('j.kind === "tts" && j.status === "ok" && j.output_path'),
        count771('(setter || setSttFile)(row.output_path)')]);

    // T-772 (2026-11-10) — the door the same report named and this file did not have. The operator's words,
    // verbatim: "currently i got the problem that i cannot re-transcribe, or reuse - ap-1326 - something i dicted,
    // it used the wrong model - we have no ui functionality for that", and the ruling on which half to build:
    // "do 3 , ... do not do 2 it would change the expected behaviour". So the row gets its own door to the
    // transcription form, and what the shared resolver prefers is left exactly as T-771 left it — these tests read
    // the same audio the picker offers, because two doors that answer differently about the same row is the bug.
    // The live row behind this was measured before any of it was written: `kind:"diar"`, a transcript of 38
    // characters that is a speaker listing, and no words anywhere — the model it ran answers who spoke when.
    // The fixture row ap-0010 is given the same shape it was given for T-771 part 2 and put back after.
    const door772 = function (from772) {
      return shim.rt.created.slice(from772).filter(function (e) {
        return e.type === 'button' && String((e.props || {}).className || '') === 'audio-play-retranscribe772';
      });
    };
    // The element log is cumulative across the whole suite, so a per-render count is taken from the slice this
    // render appended. That is what makes the gate measurable as a difference rather than as a presence.
    row771.stt_feed = { mode: 'original', rate: 48000, channels: 'source', feed_path: FEED771 };
    row771.file_path = SRC771;
    await closeSection560('STT (transcription)');   // it is open at this point in the block: the header toggle closes it
    b560 = commit(); await flush();
    check('T-772 setup: the STT section is closed before the press, so "the press opened it" is measured and not assumed',
      !b560.SttBox, JSON.stringify(Object.keys(b560)));
    arm560();
    const renderFrom772 = shim.rt.created.length;
    b560 = commit(); await flush();
    const doorsAsStt772 = door772(renderFrom772);
    const kindWas772 = row771.kind;
    row771.kind = 'tts';
    const renderFlip772 = shim.rt.created.length;
    b560 = commit(); await flush();
    const doorsAsTts772 = door772(renderFlip772);
    row771.kind = kindWas772;
    const renderBack772 = shim.rt.created.length;
    b560 = commit(); await flush();
    check('T-772 (the door belongs to transcription rows and only to them): the same fixture row carries it as stt, does not carry it as a render row, and carries it again when it is put back — measured as a difference between three renders',
      doorsAsStt772.length >= 1 && doorsAsTts772.length === doorsAsStt772.length - 1
      && door772(renderBack772).length === doorsAsStt772.length,
      [doorsAsStt772.length, doorsAsTts772.length, door772(renderBack772).length]);
    check('T-772 (the promise lives in the hover, as it does for every other control in this cluster, and it says the press dispatches nothing)',
      doorsAsStt772.length >= 1 && /re-transcribe this row's audio with a different model/.test(String((doorsAsStt772[0].props || {}).title || ''))
      && /nothing is dispatched/.test(String((doorsAsStt772[0].props || {}).title || ''))
      && String(doorsAsStt772[0].props.children) === 'stt',
      doorsAsStt772.length ? String(doorsAsStt772[0].props.title) : 'no door rendered for a transcription row');
    const callsWas772 = calls.length;
    bag.PlaylistPane.reTranscribe772('ap-0010'); await flush(); b560 = commit(); await flush();
    check('T-772 (what the operator could not do at all): the press puts that row-s audio into the transcription form-s file field, and the .txt the row wrote never reaches an audio field',
      String((b560.SttBox || {}).sttFile || '') === FEED771, [String((b560.SttBox || {}).sttFile || '')]);
    check('T-772 (the press opens the section that holds that form, and only that section): the STT section is on screen and scrolled to, and the TTS section was not touched',
      !!b560.SttBox && scrolledTo560('STT (transcription)').length >= 1 && scrolledTo560('TTS/MUSIC/SFX').length === 0,
      [!!b560.SttBox, scrolledTo560('STT (transcription)').map(function (n) { return n.text + ' x' + n.scrolled; }),
        scrolledTo560('TTS/MUSIC/SFX').length]);
    check('T-772 (no lane slot is spent by a button press): the press asked the host for nothing at all',
      calls.length === callsWas772, calls.slice(callsWas772));
    const modelNow772 = String(((b560.SttBox || {}).selModel || {}).stt || '');
    const leaf772 = shim.rt.created.filter(function (e) {
      return typeof (e.props || {}).children === 'string' && /re-transcribe ready from ap-0010/.test(String(e.props.children));
    }).pop();
    const leafTxt772 = leaf772 ? String(((leaf772.props || {}).children) || '') : '';
    check('T-772 (the notice names the two things this row got wrong for the person): which audio it is about to send, and which model is sitting in the form right now — read against the value that form is actually holding',
      !!leaf772 && /re-transcribe ready from ap-0010 \u00B7 the STT file field now holds ap-0010_qwen3-asr_the-spoken-words_feed\.wav/.test(leafTxt772)
      && /the audio the transcription lane was fed/.test(leafTxt772)
      && new RegExp('the model selected there is ' + (modelNow772 || 'none yet')).test(leafTxt772),
      [leafTxt772.slice(0, 300), modelNow772]);
    bag.PlaylistPane.reTranscribe772('ap-0010'); await flush(); b560 = commit(); await flush();
    check('T-772 (a press that asks to be shown a section never closes the one it is looking at): a second press on the same row leaves the section open and the file field where it is',
      !!b560.SttBox && String((b560.SttBox || {}).sttFile || '') === FEED771,
      [!!b560.SttBox, String((b560.SttBox || {}).sttFile || '')]);
    delete row771.stt_feed; delete row771.file_path;
    const fileWas772 = String((b560.SttBox || {}).sttFile || '');
    bag.PlaylistPane.reTranscribe772('ap-0010'); await flush(); b560 = commit(); await flush();
    check('T-772 (a row with no audio anywhere is refused by the same sentence the picker uses, and the field is left exactly as it was): no second opinion about the row, and no half-done press',
      String((b560.SttBox || {}).sttFile || '') === fileWas772 && said771(/carries no audio file this lane can be fed/),
      [String((b560.SttBox || {}).sttFile || ''), fileWas772]);
    check('T-772 contract: the door, the handler and the wiring are one door — the control asks the prop and calls it (the same two-step shape props.retry has, so a row with no panel handler is inert rather than throwing), and it resolves through the function T-771 made shared, in the order that card left it',
      count771('function reTranscribeRow772(') === 1 && count771('reTranscribe772: reTranscribeRow772') === 1
      && count771('props.reTranscribe772') === 2 && count771('audio-play-retranscribe772') === 1
      && count771('sttSourceOfRow771(') === 4,
      [count771('function reTranscribeRow772('), count771('reTranscribe772: reTranscribeRow772'),
        count771('props.reTranscribe772'), count771('audio-play-retranscribe772'), count771('sttSourceOfRow771(')]);
    // The keepOpen half is asserted here as a source claim, and it is said plainly because it is the honest limit of
    // this harness: openSection386 only takes its closing branch when it can measure that the section header is inside
    // the panel's scroll container, and the shim gives its spy heads no getBoundingClientRect — the same reason this
    // block measures the opening half of a navigation press and never the closing one.
    check('T-772 contract: the section is opened through the panel-s own helper with keepOpen set, so this press is not a toggle on a section a person is already looking at',
      count771('openSection386(STT_SECTION_NAME501, "__stt", true)') === 1,
      count771('openSection386(STT_SECTION_NAME501, "__stt", true)'));

    arm560();
    bag.PlaylistPane.reuseText('ap-0016'); await flush(); b560 = commit(); await flush();
    // Read the lane the words landed in off the box that dispatches from it. The suite's own genField() helper is
    // NOT used here: the cumulative element log also carries the scene composer's dialogue field and the CAP board's
    // probe field, and the LAST of those is not the TTS box - a DOM guess would have measured the wrong field
    // (which is exactly what the first version of this check did, and the claim was fixed instead of loosened).
    check('T-560 (a row that maps to no listed model still gets its words into the lane it has always gone to, and the panel names the model it could not re-select)',
      ttsLane560 >= 0 && laneValue560(ttsLane560) === 'resampled ap-0015 to 44100 Hz / 2 ch'
      && /reused the text of ap-0016/.test(toast560())
      && /model this row recorded \(\(resample\)\) is not in the current lists, so the model was left as it is/.test(toast560()),
      [laneValue560(ttsLane560), toast560().slice(0, 240)]);

    // T-760 (operator request 2026-11-09, verbatim: "On the TTS playlist entries - if I use the \"reuse button\" to
    // re-load the text into the lower TTS section - it should also return the previously selected model and voice").
    // The model half of that was already pinned above; the voice half is what was missing, and the reason it was
    // missing is a mechanism rather than an oversight: landing a model starts a voice landing of its own (the resolver
    // keyed to pendingVoiceModel370) that runs when the voice list next answers, so setting the selection here alone
    // would be overwritten by a landing that knows nothing about the row. The panel now writes what a person's pick
    // writes — the selection, the persisted selection, and the model→voice memory, keyed to the model this press lands
    // on — which is what makes the two agree instead of fight.
    arm560();
    // This suite's harness carries no localStorage (react_shim.cjs provides none) and the panel's own writer guards on
    // `typeof localStorage === "undefined"`, so the memory half of this change is unmeasurable here unless this block
    // supplies one. It supplies a minimal fake for its own duration and puts the global back exactly as it found it.
    const hadLS760 = Object.prototype.hasOwnProperty.call(global, 'localStorage');
    const oldLS760 = global.localStorage;
    const memLS760 = {};
    global.localStorage = {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(memLS760, k) ? memLS760[k] : null; },
      setItem: function (k, v) { memLS760[k] = String(v); },
      removeItem: function (k) { delete memLS760[k]; },
    };
    if (bag.TtsBox && typeof bag.TtsBox.onRefreshVoices === 'function') { bag.TtsBox.onRefreshVoices(); await flush(); }
    bag.PlaylistPane.reuseText('ap-0017'); await flush(); b560 = commit(); await flush();
    check('T-760: the voice comes back with the model — the TTS box holds the voice this row was rendered with',
      !!(b560.TtsBox && b560.TtsBox.selModel) && String(b560.TtsBox.selModel.tts) === 'clon1'
      && !!b560.TtsBox.selVoice && String(b560.TtsBox.selVoice.tts) === 'v1',
      [b560.TtsBox && b560.TtsBox.selModel, b560.TtsBox && b560.TtsBox.selVoice]);
    check('T-760: and the panel says it did it, in the same sentence it already uses for the model and the settings',
      /model clon1 re-selected from this row/.test(toast560()) && /voice v1 re-selected from this row/.test(toast560()),
      toast560().slice(0, 300));
    check('T-760: the pick is remembered for the model it was made on, so the model-change landing agrees instead of overwriting it',
      (function () {
        // The memory is stored the way the panel stores it — a JSON string inside the selection object, the same
        // double-encode `onSelectVoice` writes for a person's pick. Reading it back is the only way to ask whether
        // the key is the model THIS press landed on.
        let sel = null; try { sel = JSON.parse(memLS760['deepamp:sel'] || ''); } catch (e) {}
        const mem = sel && sel.tts_voice_by_model370;
        let parsed = null; try { parsed = (typeof mem === 'string') ? JSON.parse(mem) : mem; } catch (e) {}
        return !!(parsed && parsed.clon1 === 'v1');
      })(),
      String(memLS760['deepamp:sel'] || '').slice(-260));
    arm560();
    bag.PlaylistPane.reuseText('ap-0018'); await flush(); b560 = commit(); await flush();
    check('T-760 (the half that must NOT happen): a voice the store no longer holds is named and NOT put into a control that cannot display it',
      /voice this row used \(voice-that-is-gone\) is not in the current voice list, so the voice was left as it is/.test(toast560())
      && !/voice voice-that-is-gone re-selected/.test(toast560()),
      toast560().slice(0, 300));
    if (hadLS760) global.localStorage = oldLS760; else delete global.localStorage;

    // T-669 (operator, 2026-10-27 11:2x Berlin, verbatim: "they should keep their current functionality, and open and
    // scroll as currently, but on the second press, if window is already scrolled into the position, the buttons
    // should close the lower window extension and 'untoggle PL and EQ' -> behave like winamp close Playlist or eq").
    // The new branch answers one question the harness has never been asked before - "is this section's header already
    // inside the panel's scroll container?" - and the harness has no layout, so this block hands the container and the
    // head it matches a rect, through the same head mirror openSection386 already reads. Three presses, driven:
    // a press that still has somewhere to go, a press that has nowhere left to go, and a press on a closed section.
    const arm669 = function (headTop) {
      arm560();
      heads560.forEach(function (n) {
        n.getBoundingClientRect = function () { return { top: headTop, bottom: headTop + 20 }; };
      });
      const hosts669 = shim.rt.created.filter(function (e) {
        const p = e.props || {};
        return p.ref && typeof p.ref === 'object' && p.ref.current && p.style
          && p.style.overflowY === 'auto' && p.style.flex === '1 1 auto';
      });
      if (!hosts669.length) throw new Error('T-669: the panel scroll container was not rendered');
      hosts669[hosts669.length - 1].props.ref.current.getBoundingClientRect = function () { return { top: 0, bottom: 600 }; };
      return heads560.length;
    };
    const pressShortcut669 = function (cls) {
      const bs = shim.rt.created.filter(function (e) { return String((e.props || {}).className || '') === cls; });
      if (!bs.length) throw new Error('T-669: no ' + cls + ' button was rendered');
      bs[bs.length - 1].props.onClick();
    };
    const bodiesSince669 = function (from) {
      return shim.rt.created.slice(from).filter(function (e) {
        return String((e.props || {}).className || '') === 'audio-play-section-body';
      }).length;
    };

    arm669(900);
    let cut669a = shim.rt.created.length;
    await flush(); commit(); await flush();
    const openBodies669 = bodiesSince669(cut669a);
    cut669a = shim.rt.created.length;
    pressShortcut669('audio-play-tp-pl386');
    await flush(); commit(); await flush();
    check('T-669 press one (the Playlist header is measured BELOW the container, so this press still has somewhere to go): the button does exactly what T-386 / T-388 / T-418 built - the section stays open and the window is brought to its header',
      openBodies669 > 0 && bodiesSince669(cut669a) === openBodies669
        && scrolledTo560('Playlist').length >= 1 && scrolledTo560('Playlist')[0].scrolled >= 1
        && scrolledTo560('Playlist')[0].opts && scrolledTo560('Playlist')[0].opts.block === 'start',
      { bodies_open_before: openBodies669, bodies_after_press: bodiesSince669(cut669a),
        scrolls: scrolledTo560('Playlist').map(function (n) { return n.text + ' x' + n.scrolled; }) });

    arm669(100);
    cut669a = shim.rt.created.length;
    pressShortcut669('audio-play-tp-pl386');
    await flush(); commit(); await flush();
    const closedBodies669 = bodiesSince669(cut669a);
    check('T-669 press two (the section is open AND its header is already inside the container): the press closes the section instead of scrolling to it, and nothing moves',
      closedBodies669 === openBodies669 - 1 && scrolledTo560('Playlist').length === 0,
      { bodies_open_before: openBodies669, bodies_after_close: closedBodies669,
        scrolls: scrolledTo560('Playlist').length });

    arm669(100);
    cut669a = shim.rt.created.length;
    pressShortcut669('audio-play-tp-pl386');
    await flush(); commit(); await flush();
    check('T-669 press three (the section is CLOSED and its header is in view): the close branch cannot fire on a section that is not open, so this press opens it and scrolls to it - the failure mode this card was audited for',
      bodiesSince669(cut669a) === openBodies669 && scrolledTo560('Playlist').length >= 1,
      { bodies_after_reopen: bodiesSince669(cut669a),
        scrolls: scrolledTo560('Playlist').map(function (n) { return n.text + ' x' + n.scrolled; }) });

    // T-666 (operator, 2026-10-27 11:2x Berlin, verbatim: "in the ejectbutton/dropdown to select a preset - we should
    // have an 'add...' as a permanent link that scrolls down, selects the default music model and shows the prompt
    // winow for user to enter a text to render as music"). Four things are driven, in the order the operator named
    // them, plus the one thing the entry must never do. The focus half needs the render that creates the field, so
    // this block renders first and runs the effects second - the same two steps commit() does in one call - and puts
    // a spy on the prompt field's own host node between them.
    const pressClassPart666 = function (part) {
      const bs = shim.rt.created.filter(function (e) {
        return e.type === 'button' && String((e.props || {}).className || '').indexOf(part) >= 0;
      });
      if (!bs.length) throw new Error('T-666: no button carrying ' + part + ' was rendered');
      bs[bs.length - 1].props.onClick();
    };
    const optionTexts666 = function (cls) {
      const ss = shim.rt.created.filter(function (e) { return String((e.props || {}).className || '') === cls; });
      if (!ss.length) return [];
      return ((ss[ss.length - 1].props || {}).children || []).filter(Boolean).map(function (o) { return textOf560(o); });
    };
    // The model select's children are NOT flat - the options are produced inside group maps - so this walks the
    // subtree and collects every option node it finds, which is what a person scrolling that dropdown actually sees.
    const optionValues666 = function (cls) {
      const ss = shim.rt.created.filter(function (e) { return String((e.props || {}).className || '') === cls; });
      if (!ss.length) return [];
      const out666 = [];
      (function walk666(x, d) {
        if (d > 8 || x == null) return;
        if (Array.isArray(x)) { x.forEach(function (n) { walk666(n, d + 1); }); return; }
        if (x.type === 'option') { out666.push(String((x.props || {}).value || '')); return; }
        if (x.props && x.props.children !== undefined) walk666(x.props.children, d + 1);
      })(ss[ss.length - 1].props.children, 0);
      return out666;
    };

    pressClassPart666('audio-play-tp-eject'); await flush(); b560 = commit(); await flush();
    const opts666 = optionTexts666('audio-play-quickmusic-preset602');
    check('T-666 the entry is permanent: with the eject row open, the preset dropdown carries "add a new music prompt" as its FIRST choice, before any preset the store reports',
      opts666.length >= 2 && opts666[0] === 'add a new music prompt\u2026',
      opts666.slice(0, 3));

    // The form is deliberately put on the OTHER kind first, so that "selects the default music model" is something
    // this press has to cause and not something that was already true.
    bag.TtsBox.onKindChange('tts'); await flush(); b560 = commit(); await flush();
    const kindWas666 = b560.TtsBox && b560.TtsBox.kind;
    const modelWas666 = selectValue560('audio-play-model');
    const dispatchBefore666 = calls.filter(function (c) { return /dispatch_task/.test(c); }).length;
    arm669(900);
    const q666 = shim.rt.created.filter(function (e) { return String((e.props || {}).className || '') === 'audio-play-quickmusic-preset602'; });
    if (!q666.length) throw new Error('T-666: the eject preset dropdown was not rendered');
    const cut666 = shim.rt.created.length;
    q666[q666.length - 1].props.onChange({ target: { value: '__add666' } });
    await flush();
    const b666r = {}; shim.render(comp(), b666r);                       // the render that creates the prompt field
    const focused666 = [];
    shim.rt.created.slice(cut666).forEach(function (e) {
      const p = e.props || {};
      if (e.type === 'textarea' && p.ref && typeof p.ref === 'object' && p.ref.current && /tin roof/.test(String(p.placeholder || ''))) {
        p.ref.current.focus = function () { focused666.push('music prompt field'); };
      }
    });
    shim.runEffects(); await flush(); b560 = commit(); await flush();

    check('T-666 (1) "scrolls down": the press opened the music / sfx section - the section that was NOT in view when the press happened - and brought the window to its header',
      bodiesSince669(cut666) > 0 && scrolledTo560('TTS/MUSIC/SFX').length >= 1
        && scrolledTo560('TTS/MUSIC/SFX')[0].opts && scrolledTo560('TTS/MUSIC/SFX')[0].opts.block === 'start',
      { bodies_created: bodiesSince669(cut666),
        scrolls: scrolledTo560('TTS/MUSIC/SFX').map(function (n) { return n.text + ' x' + n.scrolled; }) });
    check('T-666 (2) "selects the default music model": the form was on ' + kindWas666 + ' before the press and is on the music kind after it, and the model it landed on is one the live lists offer for that kind - read out of the select a person sees, not a name this panel stores',
      kindWas666 === 'tts' && b560.TtsBox && b560.TtsBox.kind === 'gen'
        && !!selectValue560('audio-play-model')
        && optionValues666('audio-play-model').indexOf(selectValue560('audio-play-model')) >= 0
        && selectValue560('audio-play-model') !== modelWas666,
      'kind ' + kindWas666 + ' -> ' + (b560.TtsBox && b560.TtsBox.kind)
        + ' | model ' + modelWas666 + ' -> ' + selectValue560('audio-play-model')
        + ' | offered ' + optionValues666('audio-play-model').filter(Boolean).slice(0, 6).join(','));
    check('T-666 (3) "shows the prompt window for user to enter a text": the cursor is in the music / sfx prompt field on the render that created it',
      focused666.length === 1, focused666);
    check('T-666 (4) what the entry does NOT do: it renders nothing - no job is queued by picking it - and the dropdown is left listing presets rather than holding a choice',
      calls.filter(function (c) { return /dispatch_task/.test(c); }).length === dispatchBefore666
        && selectValue560('audio-play-quickmusic-preset602') === '',
      { dispatch_before: dispatchBefore666, dispatch_after: calls.filter(function (c) { return /dispatch_task/.test(c); }).length,
        dropdown_value: selectValue560('audio-play-quickmusic-preset602') });
    // T-674 (operator, 2026-10-28 09:1x Berlin, verbatim: "if we deactivate EQ and PL using the buttons in player,
    // it should close/collapse the lower window part aswell - if both are toggled to off using the buttons"). The
    // lower window part is measured the way T-669 measures it, on the newest render of the panel: what stands under
    // the section headers. A collapsed panel renders the player strip and nothing below it, so a collapse is
    // measurable as ZERO headers rendered, and a panel whose lower part is still there is measurable as headers with
    // bodies under them. Three drives, in the order that leaves nothing behind for the blocks above this one.
    const headsInWindow674 = function (from674) {
      return shim.rt.created.slice(from674).filter(function (e674) {
        return String((e674.props || {}).className || '') === 'audio-play-section-head';
      }).length;
    };
    const bodiesInWindow674 = function (from674) {
      return shim.rt.created.slice(from674).filter(function (e674) {
        return String((e674.props || {}).className || '') === 'audio-play-section-body';
      }).length;
    };
    // A section is open when its body renders after its own head and before the next head, which is how the panel
    // actually lays a Collapsible out. Reading it off the element order is the honest instrument here: the harness
    // has no layout, so the only way to know which sections are open is the tree the panel built.
    // The window since a press holds every render that press made, so the honest number is per render: the play
    // control is rendered exactly once per render in either shape of the panel (expanded: the play button;
    // collapsed: the compact bar's one button, which carries the same class), so it counts the renders, and the
    // headers and bodies are read per render rather than as a window total.
    const rendersInWindow674 = function (from674) {
      return shim.rt.created.slice(from674).filter(function (e674) {
        return String((e674.props || {}).className || '').indexOf('audio-play-tp-play') >= 0;
      }).length;
    };
    const lastRender674 = function (from674) {
      const w674 = shim.rt.created.slice(from674);
      let start674 = -1;
      for (let i674 = 0; i674 < w674.length; i674++) {
        if (String((w674[i674].props || {}).className || '').indexOf('audio-play-tp-play') >= 0) start674 = i674;
      }
      const tail674 = w674.slice(Math.max(0, start674));
      const c674 = function (cls674) {
        return tail674.filter(function (e674) { return String((e674.props || {}).className || '') === cls674; }).length;
      };
      return { marker_found: start674 >= 0, heads: c674('audio-play-section-head'), bodies: c674('audio-play-section-body') };
    };
    // RE-CUT 2026-11-02 (T-683 investigation): the instrument this block used was wrong about the panel. The
    // lower window part is not unmounted on a collapse — T-301 keeps the subtree mounted and switches it to
    // display:none, because the media element lives in that strip and tearing the subtree down would stop a take
    // that is already playing ("Hidden is not gone", lib/client.js above `var showBody`). So a collapsed panel
    // still CREATES every section head and body, and a head count measures nothing about the collapse. What a
    // collapse writes is measured here: the panel's own sections scroll container carries display:"none"
    // (lib/client.js, the `showBody ? null : { display: "none" }` on the bodyScrollRef669 div), and the header's
    // own control reads "expand panel". Both are read off the newest render, the same window the rest of this
    // block reads.
    const sectionsContainer674 = function () {
      const hosts674c = shim.rt.created.filter(function (e674c) {
        const p674c = e674c.props || {};
        return p674c.ref && typeof p674c.ref === 'object' && p674c.style
          && p674c.style.overflowY === 'auto' && p674c.style.flex === '1 1 auto';
      });
      return hosts674c.length ? hosts674c[hosts674c.length - 1] : null;
    };
    const lowerPartClosed674 = function () {
      const c674l = sectionsContainer674();
      if (!c674l) return { hidden: false, container: false, chrome: 'none' };
      const chrome674l = shim.rt.created.filter(function (e674d) {
        const t674d = String((e674d.props || {}).title || '');
        return t674d === 'collapse panel' || t674d === 'expand panel';
      });
      return {
        hidden: String(((c674l.props || {}).style || {}).display || '') === 'none',
        container: true,
        chrome: chrome674l.length ? String((chrome674l[chrome674l.length - 1].props || {}).title) : 'none',
      };
    };

    const openHeads674 = function (from674) {
      const seq674 = shim.rt.created.slice(from674);
      const seen674 = [];
      for (let i674 = 0; i674 < seq674.length; i674++) {
        const cls674 = String((seq674[i674].props || {}).className || '');
        if (cls674 === 'audio-play-section-head') seen674.push({ el: seq674[i674], body: false });
        else if (cls674 === 'audio-play-section-body' && seen674.length) seen674[seen674.length - 1].body = true;
      }
      return seen674.filter(function (h674) { return h674.body; });
    };

    // The drive the rule needs: both shortcut sections standing open, then the press that closes the Voices
    // section (the PL lamp is still lit, so no collapse), then the press that closes the Playlist section (the last
    // lamp goes dark, so the collapse). "Standing open" is read off the tree the panel built rather than assumed,
    // because the blocks above this one leave the panel in a state the drive cannot guess: the probe on the root
    // store showed __pl false and __voi true at a press that was meant to close Voices, which is why the first
    // version of this drive failed - the rule answered correctly and refused to collapse with a lamp still lit.
    let cutNow674 = shim.rt.created.length;
    const titlesOpen674 = function () {
      return openHeads674(cutNow674).map(function (h674) { return textOf560(h674.el).trim(); });
    };
    const ensureOpen674 = async function (cls674, title674) {
      if (titlesOpen674().some(function (t674) { return t674.indexOf(title674) >= 0; })) return;
      const before674 = shim.rt.created.length;
      pressShortcut669(cls674);
      await flush(); commit(); await flush();
      cutNow674 = before674;
    };
    const closeWithPress674 = async function (cls674) {
      arm669(100);
      const before674 = shim.rt.created.length;
      pressShortcut669(cls674);
      await flush(); commit(); await flush();
      cutNow674 = before674;
      return before674;
    };

    await ensureOpen674('audio-play-tp-eq386', 'Voices');
    await ensureOpen674('audio-play-tp-pl386', 'Playlist');

    const cutB674 = await closeWithPress674('audio-play-tp-eq386');
    const oneLit674 = lastRender674(cutB674);
    const openA674 = lowerPartClosed674();
    check('T-674, re-cut 2026-10-28 09:4x Berlin on the operator ruling ("4 yes, change accordingly"), instrument re-cut 2026-11-02: the press that closes the Voices section leaves the lower window part standing, because the PL lamp is still lit - the collapse follows the two shortcut lamps, not the other sections',
      oneLit674.marker_found && oneLit674.heads > 0 && oneLit674.bodies > 0
        && !openA674.hidden && openA674.container && openA674.chrome === 'collapse panel',
      JSON.stringify({ headers: oneLit674.heads, bodies: oneLit674.bodies, lower_part_hidden: openA674.hidden, chrome: openA674.chrome }));

    const cutE674 = await closeWithPress674('audio-play-tp-pl386');
    const bothDark674 = lastRender674(cutE674);
    const closedB674 = lowerPartClosed674();
    check('T-674 (both shortcut lamps off), instrument re-cut 2026-11-02 on the T-683 read: the press that turns the last lamp off closes the lower window part - the panel itself switches its sections container to display:none and its header control offers "expand panel" again. The heads are still BUILT: T-301 hides that subtree rather than unmounting it, on purpose, so a collapse cannot stop a take that is already playing',
      closedB674.hidden && closedB674.container && closedB674.chrome === 'expand panel'
        && bothDark674.bodies < oneLit674.bodies,
      JSON.stringify({ lower_part_hidden: closedB674.hidden, chrome: closedB674.chrome, bodies_before: oneLit674.bodies, bodies_after: bothDark674.bodies }));

  }

  if (shim.rt.throws.length) {
    fail++;
    console.log('  FAIL  recorded throws: ' + shim.rt.throws.map(function (t) { return t.where + ': ' + t.err.message; }).join(' ; '));
  }
  console.log('\n=== ' + pass + ' pass, ' + fail + ' fail ===');
  process.exitCode = fail ? 1 : 0;
})().catch(function (e) {
  console.log('  THREW  ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
