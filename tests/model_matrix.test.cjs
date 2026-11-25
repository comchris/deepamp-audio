'use strict';
// T-382 (2026-10-14): tests for the matrix runner itself, offline. The user's instruction was "test matrix needs
// to be expanded - and redone (new code, new tests)" and they chose to build the tooling first and decide the
// depth after a pilot run. These checks are what make the tooling trustworthy BEFORE it produces a table: a sweep
// that dispatches a clone model with no voice, or that runs two models on one engine at once, or that merges load
// and generation into one number, produces a table that looks authoritative and is not.
//
// Nothing here talks to the fleet. The fixtures are the shapes the live plugin actually answers, measured today:
//   get_models?fn=tts        -> {id, task, family, mode, path, quant, clone_required, clone_optional,
//                                default_voice, samples_only, ref_text_required, loaded}
//   model_capabilities?fn=tts-> families[family] = {tasks, capability_needs, builtin_voices, default_voice, ...}
//   voice_registry           -> {voices: {<name>: {ref_wav, ref_text, ...}}}

const path = require('path');
const fs = require('fs');
const M = require(path.join(__dirname, '..', 'tools', 'model_matrix.cjs'));

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined && detail !== null ? '  ->  ' + String(detail).slice(0, 240) : '')); }
}

const MODELS = [
  { id: 'kokoro-tts', task: 'tts', family: 'kokoro_tts', quant: 'q8_0', clone_required: false, clone_optional: true, default_voice: true },
  { id: 'kitten_tts', task: 'tts', family: 'kitten_tts', quant: 'orig', clone_required: false, clone_optional: false, default_voice: true },
  { id: 'breeze_tts', task: 'clon', family: 'breeze_tts', quant: 'q8_0', clone_required: true, clone_optional: false, default_voice: false },
  { id: 'lfm2_audio', task: 'tts', family: 'lfm2_audio', quant: 'q8_0', clone_required: false, clone_optional: false, default_voice: true },
  { id: 'some_gen_model', task: 'gen', family: 'some_gen', quant: 'q4_0', clone_required: false, clone_optional: false, default_voice: false },
  { id: 'kagula_clone', task: 'clon', family: 'kagula', quant: 'q8_0', clone_required: true, clone_optional: false, default_voice: false },
];
const CAPS = {
  'kokoro-tts': { family: 'kokoro_tts', tasks: ['tts'], capability_needs: ['built_in_voice'], builtin_voices: ['af_north', 'zm_mid_woman'], default_voice: 'af_north' },
  'kitten_tts': { family: 'kitten_tts', tasks: ['tts'], capability_needs: [], builtin_voices: ['Bruno'], default_voice: 'Bruno' },
  'breeze_tts': { family: 'breeze_tts', tasks: ['tts'], capability_needs: ['clone_sample'], builtin_voices: [], default_voice: false },
  'lfm2_audio': { family: 'lfm2_audio', tasks: ['tts'], capability_needs: ['built_in_voice'], builtin_voices: ['us_male'], default_voice: 'us_male' },
  'some_gen_model': { family: 'some_gen', tasks: ['gen', 's2s'], capability_needs: [], builtin_voices: [], default_voice: false },
  'kagula_clone': { family: 'kagula', tasks: ['tts'], capability_needs: ['clone_sample'], builtin_voices: [], default_voice: false },
};
const VOICES = [{ name: 'voy_doctor', ref_wav: '/home/deepamp-test/.dsh/deepamp-audio/voices/voy_doctor.wav' }];

const plan = M.planRows382(MODELS, CAPS, VOICES, { fn: 'tts', endpoint: 'primary' });
const byId = {};
plan.forEach(function (r) { byId[r.model] = r; });

check('a family the engine says serves only gen/s2s is marked UNTESTABLE with the engine\u2019s own tasks named, not quietly dropped from the table',
  byId.some_gen_model.verdict === 'untestable' && /gen\/s2s/.test(byId.some_gen_model.reason) && /tts lane/.test(byId.some_gen_model.reason),
  JSON.stringify(byId.some_gen_model));
check('a model that clones is SKIPPED with a reason when this plugin owns no voice — the sweep does not dispatch it into a capability refusal it caused itself',
  (function () {
    const p0 = M.planRows382(MODELS, CAPS, [], { fn: 'tts' });
    const r = p0.filter(function (x) { return x.model === 'breeze_tts'; })[0];
    return r.verdict === 'skip' && /no registered voice/.test(r.reason) && r.voice === '';
  })(), JSON.stringify(plan.filter(function (x) { return x.model === 'breeze_tts'; })[0]));
check('a model that clones runs with a voice this plugin owns, and the row says which one and in what mode',
  byId.breeze_tts.verdict === 'run' && byId.breeze_tts.voice === 'voy_doctor' && byId.breeze_tts.voice_mode === 'plugin_voice',
  JSON.stringify(byId.breeze_tts));
check('a family that needs a built-in engine voice runs with the engine\u2019s OWN default_voice, not a plugin voice and not a guess',
  byId['kokoro-tts'].verdict === 'run' && byId['kokoro-tts'].voice === 'af_north' && byId['kokoro-tts'].voice_mode === 'engine_builtin'
    && byId.lfm2_audio.voice === 'us_male', JSON.stringify([byId['kokoro-tts'], byId.lfm2_audio]));
check('every planned row carries the endpoint it was told to use — a sweep is pinned, and a pin never silently falls back to another machine',
  plan.every(function (r) { return r.endpoint === 'primary'; })
    && M.planRows382(MODELS, CAPS, VOICES, { fn: 'tts', endpoint: 'e-5' }).every(function (r) { return r.endpoint === 'e-5'; }), null);
check('the limit is honoured, so a pilot run is a pilot run and not the whole catalogue',
  M.planRows382(MODELS, CAPS, VOICES, { fn: 'tts', limit: 3 }).length === 3 && plan.length === MODELS.length,
  M.planRows382(MODELS, CAPS, VOICES, { fn: 'tts', limit: 3 }).length + ' vs ' + plan.length);

const okJob = { id: 'ap-0431', status: 'ok', elapsed_load: 1136, elapsed_gen: 4185, duration: 5.12, size_bytes: 245644 };
const errJob = { id: 'ap-0429', status: 'error', elapsed_load: 706, elapsed_gen: 868, duration: 0, size_bytes: 0, error: 'GGUF for family lfm2_audio does not embed an audio.cpp model spec' };
const rOk = M.rowFromJob382(byId.kitten_tts, okJob, '2026-10-14T20:11:00.000Z');
const rErr = M.rowFromJob382(byId.lfm2_audio, errJob, '2026-10-14T20:12:00.000Z');
check('load time and generation time are recorded as two separate columns — the standing rule that a 1.1 s load and a 4.2 s render are not one number',
  rOk.elapsed_load_ms === 1136 && rOk.elapsed_gen_ms === 4185 && M.COLUMNS.indexOf('elapsed_load_ms') >= 0 && M.COLUMNS.indexOf('elapsed_gen_ms') >= 0
    && M.COLUMNS.indexOf('elapsed_ms') < 0, JSON.stringify(M.COLUMNS));
check('a FAILED model is still a row, with the host\u2019s own error text in it — a whitelist that only lists models that worked is not a whitelist',
  rErr.status === 'error' && /does not embed an audio\.cpp model spec/.test(rErr.error) && rErr.audio_seconds === 0, JSON.stringify(rErr));
check('the table carries the facts a whitelist decision needs: when, which lane, which endpoint, which model, family, quant, voice and mode',
  ['ran_at', 'fn', 'endpoint', 'model', 'family', 'quant', 'voice', 'voice_mode', 'job_id', 'status', 'elapsed_load_ms', 'elapsed_gen_ms', 'audio_seconds', 'bytes', 'error'].every(function (c) { return M.COLUMNS.indexOf(c) >= 0; })
    && M.COLUMNS.length === 15, M.COLUMNS.join(','));
check('CSV escaping is real: a host error containing a comma and a quote comes back quoted with its quotes doubled, so the table is still one row',
  (function () {
    const r = M.rowFromJob382(byId.kitten_tts, { id: 'x', status: 'error', error: 'refused, said \"no\", gave up' }, '2026-10-14T20:13:00.000Z');
    const csv = M.toCsv382([r]);
    return csv.split('\n').length === 3 && /"refused, said ""no"", gave up"/.test(csv);
  })(), M.toCsv382([M.rowFromJob382(byId.kitten_tts, { id: 'x', status: 'error', error: 'refused, said "no", gave up' }, 'x')]).split('\n')[1]);

// Source pins on the runner: the rules that keep a sweep honest are structural, and a rewrite must not lose them.
const src = fs.readFileSync(path.join(__dirname, '..', 'tools', 'model_matrix.cjs'), 'utf8');
const cnt = function (re) { return (src.match(re) || []).length; };
check('T-382 source: the sweep is SEQUENTIAL — max_loaded_models is 1 per engine, so there is exactly one dispatch call site, no Promise.all, and every job is awaited before the next model starts',
  cnt(/dispatch_tts/g) === 1 && cnt(/Promise\.all/g) === 0 && /for \(const p of plan\)/.test(src) && /await waitJob382/.test(src),
  { dispatch: cnt(/dispatch_tts/g), promise_all: cnt(/Promise\.all/g), awaits: cnt(/await waitJob382/g) });
check('T-382 source: --dry-run plans without dispatching — the dry-run return happens before the dispatch call site, so a plan can be reviewed before any audio is rendered',
  src.indexOf('if (opts.dryRun)') < src.indexOf('dispatch_tts'), { dry: src.indexOf('if (opts.dryRun)'), dispatch: src.indexOf('dispatch_tts') });
check('T-382 source: a job that never finishes is a ROW with status timeout, not a missing row — an unfinished sweep has to show that it is unfinished',
  /status: 'timeout'/.test(src) && /the sweep stopped waiting/.test(src), null);
check('T-382 source: the runner invents no audio and touches no voice file — no wav is written anywhere, and no local audio server is started',
  cnt(/\.wav/g) === 0 && cnt(/spawn|execFile|child_process/g) === 0, { wav_refs: cnt(/\.wav/g), spawn_refs: cnt(/spawn|execFile|child_process/g) });
check('T-382 source: refusal payloads are recorded in the host\u2019s words instead of being retried into a different voice — no force flag is sent anywhere',
  cnt(/force:\s*true/g) === 0 && /d\.error/.test(src), { force: cnt(/force:\s*true/g) });
check('T-382 source: a timed-out row is looked at ONE more time before the table is written — the ceiling is the sweep\u2019s, not the engine\u2019s, and omnivoice proved the difference (3.00 s of audio in 420,844 ms, called timeout by a 420 s ceiling while the playlist said ok)',
  cnt(/status !== 'timeout'/g) === 1 && /late answer/.test(src) && /answered after the sweep stopped waiting/.test(src),
  { relook: cnt(/status !== 'timeout'/g) });

console.log('\n=== ' + pass + ' pass, ' + fail + ' fail ===');
process.exitCode = fail ? 1 : 0;
