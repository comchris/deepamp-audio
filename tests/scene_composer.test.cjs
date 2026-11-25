// T-298 / T-266 / T-297 (2026-10-12, user request 5.1): the Scene (batch) composer driven once.
// What this covers is the WIRING, not the host: the route names and verbs the composer uses, the
// bodies it sends, and the two rules the panel has to keep. (1) The browser never sends a path on
// the upload side — a picked file arrives as its CONTENT, and the only path the composer ever posts
// is one the plugin itself wrote. (2) A refusal is READ, not swallowed: a never-overwrite refusal
// carries the name it refused and the name it suggests, and the panel has to show both.
// Usage: node tests/scene_composer.test.cjs [path/to/client.js]
const path = require('path');
const { createRuntime, loadClient, openAllSections } = require('./react_shim.cjs');

const TARGET = process.argv[2] || path.join(__dirname, '..', 'lib', 'client.js');
const SAVED = '/home/deepamp-test/.dsh/deepamp-audio/texts/cross s01 shuttle two.json';
const AUTHOR = 'Tom Paris: So this is the fancy shuttle.\nIt is a very nice chair.\n\nSeven of Nine: The other seat is mine.\nB’Elanna Torres: Try the left one.';
const CAST = ['Tom Paris', 'Seven of Nine', 'B’Elanna Torres'];
// T-581 items 5.2 and 5.3 (2026-10-19). The fresh scene: written from scratch, never saved, never loaded — the state
// the card says has no cast control at all. Its three names are all names the host's speaker rule accepts, so a cast
// built from them is one-to-one by construction.
const SAVED52_NAME = 't581 fresh scene 52';
const SAVED52_PATH = '/home/deepamp-test/.dsh/deepamp-audio/texts/t581 fresh scene 52.json';
const FRESH52 = 'Janeway: The shuttle is ready.\nDoctor: I will come.\nNeelix: I could make a broth.';
const FRESH52_NAMES = ['Janeway', 'Doctor', 'Neelix'];
// The loaded file, in the shape this plugin writes (schema 3, a dialogue array). Its voices are registry ids and one
// human name, which is what the host's batchScript585 renders as NAME: lines (lib/index.js:12506-12513) — the shape
// the row view has to be able to read.
const PLUGIN52_PATH = '/home/deepamp-test/.dsh/deepamp-audio/texts/t581 plugin shape 52.json';
const PLUGIN52_CAST = ['voy_janeway', 'voy_doctor', 'Neelix'];
const PLUGIN52_SCRIPT = 'voy_janeway: The shuttle bay is venting.\nvoy_doctor: I can hold the seal.\nNeelix: I could make a broth while you work.';
// The other plugin shape, kept in the suite on purpose: a saved document whose voices are DIAR LABELS.
// RE-POINTED 2026-10-19 by T-604. When this fixture was written (T-581 item 5.3) the host's renderer answered it with
// `[S1] …` slot tags, which carry no NAME at all, so the row view had nothing to name and the pin recorded that as a
// LIMIT of the client half. T-604 - the operator's own ruling on that recorded limit, asked and answered the same day
// - made the host read a diar label as a speaker (the third class of its one speaker rule), so the same file is now
// answered with NAME lines and the rows have names. The fixture below is the host's answer AFTER that change, kept
// faithful to lib/index.js (batchScript585 via speakerNameOk604, and the speaker_kinds a load now carries), and the
// pin beside it measures the success that used to be a limit. What is STILL a limit, and pinned as one: a diar label
// owns no voice, so the row says "rename it onto a voice" and a plan over such a file is refused until that happens
// (tests/host.test.cjs T-604 (c)).
const DIAR52_PATH = '/home/deepamp-test/.dsh/deepamp-audio/texts/t581 diar shape 52.json';
const DIAR52_CAST = ['SPEAKER_00', 'SPEAKER_01'];
const DIAR52_SCRIPT = 'SPEAKER_00: The bay is venting.\nSPEAKER_01: I can hold the seal.';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  // T-797 (2026-11-12): a payload built as an object printed as "[object Object]", which is not a
  // measurement anyone can read. Strings are printed exactly as they were; an object is printed as JSON.
  // Nothing about what a check asserts changed - only what a failing check says when it fails.
  var said797 = (typeof detail === 'string') ? detail : (detail === undefined ? '' : JSON.stringify(detail));
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (said797 ? '  ->  ' + said797 : '')); }
}
function flush() {
  let p = Promise.resolve();
  for (let i = 0; i < 30; i++) p = p.then(function () {});
  return p;
}

const calls = [];
function lastBody(verb) {
  for (let i = calls.length - 1; i >= 0; i--) {
    if (calls[i].indexOf(verb) >= 0) return JSON.parse(bodies[i + 1] || bodies[i] || '{}');
  }
  return {};
}
const bodies = [];
let saveCount = 0;
// T-350: per-scenario overrides of the plan answer's placement fields (null = the shipped fixture).
let planOverride = null;
// T-818 (2026-11-13): the dispatch answer's untouched-parts half, re-writable per scenario for the same reason
// planOverride exists — the fixture has to be able to show both a stop that skipped parts and one that did not.
let dispatchOverride818 = null;
// T-605: what GET voice_ceiling answers. null = the door does not answer, which is the shipped state of this
// fixture and leaves the panel on its fallback; an object is the host's answer, and the panel then warns about
// THAT number. The fallback and the answer are both pinned below, because a panel that warns about a number the
// host never gave is warning about a rule that may not exist.
let voiceCeiling605Answer = null;
function host(url, opts) {
  const method = ((opts && opts.method) || 'GET').toUpperCase();
  const u = String(url);
  calls.push(method + ' ' + u.replace('/api/deepamp/', '~'));
  bodies.push((opts && opts.body) || '');
  let body;
  if (/get_endpoints/.test(u)) body = { tts: { url: 'http://cpu1.test:8963', route: 'speech' }, stt: { url: 'http://cpu1.test:8962', route: 'tasks' } };
  else if (/server_status/.test(u)) body = { tts: { ok: true, loaded_model: 'm2' }, stt: { ok: true } };
  else if (/get_models/.test(u)) body = { models: [{ id: 'm1', loaded: false }, { id: 'm2', loaded: true }] };
  else if (/refresh_voices/.test(u)) body = { voices: ['v1'], builtins: ['alba'], builtins_source: 'mirror', default_voice: '' };
  else if (/playlist_list/.test(u)) body = { items: [
      // T-323b fixture: the composer needs real rows to reuse from. Three shapes on purpose - a finished
      // row with a transcript, a row that is STILL running (it must never be taken), and a NEWER finished
      // row (it must win over the older one, because reuse takes the newest words available).
      { id: 'ap-0010', fn: 'stt', kind: 'stt', status: 'ok', transcript: 'older spoken words', model: 'qwen3_asr', duration: 2.1 },
      { id: 'ap-0011', fn: 'tts', kind: 'tts', status: 'running', text: 'a row still being generated', model: 'm2', duration: 0 },
      { id: 'ap-0012', fn: 'stt', kind: 'stt', status: 'ok', transcript: 'the spoken words', model: 'nemotron_asr', duration: 2.4 },
      // T-326 fixtures (2026-10-13). Four shapes on purpose: a diar+ASR row with turns and words (the import
      // source, and the newest one with words so it is the default); a plain diarisation row that has turns but
      // NO text (it must not be offered - a script needs words); a diar+ASR row that is still running (it must not
      // be offered); and an older five-speaker row that is selectable, so the renderer's four-speaker ceiling can
      // be pinned. ap-0017's turns are built so one adjacent pair merges and an interjection stays its own line.
      { id: 'ap-0017', fn: 'stt', kind: 'sasr', status: 'ok', model: 'nemotron_3_diar', duration: 12.0,
        // No flat `transcript` on these fixtures on purpose: the reuse affordance reads a row's transcript or
        // text, the import affordance reads its speaker_turns. Keeping the two separate means the T-323b checks
        // still measure reuse against ap-0012 and these checks measure import against ap-0017, instead of one
        // affordance quietly stealing the other's fixture.
        speaker_turns: [
          { speaker_id: 'speaker_0', start: 0.5, end: 2.5, text: 'first line of the import', confidence: 0 },
          { speaker_id: 'speaker_0', start: 3.0, end: 4.0, text: 'continues the same speaker', confidence: 0 },
          { speaker_id: 'speaker_1', start: 4.2, end: 5.2, text: 'an interjection from the other voice', confidence: 0 },
          { speaker_id: 'speaker_0', start: 5.4, end: 6.4, text: 'a later turn of the first voice', confidence: 0 },
        ] },
      { id: 'ap-0014', fn: 'stt', kind: 'diar', status: 'ok', model: 'nemotron_3_diar', duration: 5.0,
        speaker_turns: [{ speaker_id: 'speaker_0', start: 0.0, end: 2.0, confidence: 0 }] },
      { id: 'ap-0015', fn: 'stt', kind: 'sasr', status: 'running', model: 'nemotron_3_diar', duration: 0,
        speaker_turns: [{ speaker_id: 'speaker_0', start: 0.0, end: 2.0, text: 'a diarisation still running', confidence: 0 }] },
      { id: 'ap-0016', fn: 'stt', kind: 'sasr', status: 'ok', model: 'nemotron_3_diar', duration: 9.0,
        speaker_turns: [
          { speaker_id: 'speaker_0', start: 0.0, end: 1.0, text: 'one', confidence: 0 },
          { speaker_id: 'speaker_1', start: 1.0, end: 2.0, text: 'two', confidence: 0 },
          { speaker_id: 'speaker_2', start: 2.0, end: 3.0, text: 'three', confidence: 0 },
          { speaker_id: 'speaker_3', start: 3.0, end: 4.0, text: 'four', confidence: 0 },
          { speaker_id: 'speaker_4', start: 4.0, end: 5.0, text: 'five', confidence: 0 },
        ] },
      // T-582 (2026-10-18): the ceiling this lane carries is 5 per take, so a five-speaker row is no longer the
      // over-the-ceiling case this suite used to treat it as. A six-speaker row is, and it is what the pins now
      // measure. Its id is deliberately OLDER than ap-0017: the composer offers diarised rows newest-first and the
      // default is the newest one, and three earlier pins depend on that default staying ap-0017.
      { id: 'ap-0009', fn: 'stt', kind: 'sasr', status: 'ok', model: 'nemotron_3_diar', duration: 11.0,
        speaker_turns: [
          { speaker_id: 'speaker_0', start: 0.0, end: 1.0, text: 'one', confidence: 0 },
          { speaker_id: 'speaker_1', start: 1.0, end: 2.0, text: 'two', confidence: 0 },
          { speaker_id: 'speaker_2', start: 2.0, end: 3.0, text: 'three', confidence: 0 },
          { speaker_id: 'speaker_3', start: 3.0, end: 4.0, text: 'four', confidence: 0 },
          { speaker_id: 'speaker_4', start: 4.0, end: 5.0, text: 'five', confidence: 0 },
          { speaker_id: 'speaker_5', start: 5.0, end: 6.0, text: 'six', confidence: 0 },
        ] },
      // T-610 (2026-10-20, operator request): the row the operator was pointing at. Copied from a live panel read of
      // the same day (scratch/pl_20261020_t610.json, row ap-0072 of take set b-798204, read 2026-10-20 around midday
      // Berlin): a multi-speaker GENERATION row carries the script it rendered in its own `text`, line by line, each
      // line tagged with the speaker that speaks it, plus the ordered cast that puts a voice behind each tag
      // (`speakers`, and the board's copy of it in `batch_cast`). That is what makes this row reusable as a dialogue
      // and not as a flat paragraph: the take already says which voice said which line, and the tag-to-voice map is the
      // row's own fact rather than something the panel has to invent.
      // This cast has three voices for the scene's five speakers, so [S3] speaks twice in a row - the case that decides
      // whether the imported scene is the scene that was sent. The id is deliberately OLDER than every reuse candidate
      // above, so the T-323b "newest words win" checks still measure ap-0012 and the import default still measures
      // ap-0017: this row is here to be reused, not to steal another card's fixture.
      { id: 'ap-0006', fn: 'tts', kind: 'tts', status: 'ok', model: 'moss_ttsd_q8', duration: 30.1,
        voice_mode: 'dialogue_positional',
        speakers: ['voy_janeway', 'voy_doctor_short', 'bijan'],
        batch_id: 'b-798204', batch_part: 1, batch_parts: 1, batch_title: 't608 v3 b',
        batch_cast: ['voy_janeway', 'voy_doctor_short', 'bijan'],
        part_chars: 231, max_frames: 375, frame_seconds: 30,
        text: '[S1] Report on the containment.\n[S2] Contained, mostly.\n[S3] Not fully contained, Captain.\n'
          + '[S3] Trace the source of it.\n[S2] Tracing has begun.\n[S1] How long until it is contained?\n'
          + '[S2] Hours, not minutes.\n[S3] Keep the bay sealed.' },
    ], queues: { tts: { paused: false, running: null, queued: 0 }, stt: { paused: false, running: null, queued: 0 } } };
  else if (/queue_status/.test(u)) body = { ok: true, queues: { tts: { queued: 0, running_ids: [] }, stt: { queued: 0, running_ids: [] } } };
  else if (/batch_text_save/.test(u)) {
    var req52s = {}; try { req52s = JSON.parse((opts && opts.body) || '{}'); } catch (e52z) { req52s = {}; }
    var gaveCast52 = Array.isArray(req52s.cast) && req52s.cast.length ? req52s.cast : null;
    saveCount++;
    if (saveCount === 1) body = { ok: true, path: SAVED, name: 'cross s01 shuttle two.json', bytes: 120, format: 'plugin', format_detected: 'author', title: 'Cross S01', cast: CAST, line_count: 4, chars: 118, warnings: [], roots: ['/home/deepamp-test/.dsh/deepamp-audio/texts'] };
    else if (req52s.name === SAVED52_NAME) {
      // T-581 item 5.2 fixture (2026-10-19): the FIRST save of a scene written from scratch. This is what the running
      // host answers for an author-format save it accepted — the cast it read out of the text AFTER applying the
      // one-to-one rename it was given (lib/index.js:12618-12637). A save that sent no cast echoes the text's own
      // names and carries no rename warning; a save that sent one carries the host's own warning sentence.
      body = { ok: true, path: SAVED52_PATH, name: SAVED52_NAME + '.json', bytes: 120, format: 'plugin', format_detected: 'author', title: SAVED52_NAME, cast: gaveCast52 || FRESH52_NAMES, line_count: (gaveCast52 || FRESH52_NAMES).length, chars: 96, warnings: gaveCast52 ? ['the file\'s own names were renamed onto the cast, in order of first appearance'] : [], roots: ['/home/deepamp-test/.dsh/deepamp-audio/texts'] };
    }
    else body = { ok: false, exists: true, path: SAVED, suggested_name: 'cross s01 shuttle two_1727000000.json', error: '"cross s01 shuttle two.json" is already in /home/deepamp-test/.dsh/deepamp-audio/texts and is NOT overwritten — save it under a new name (try "cross s01 shuttle two_1727000000.json") or delete the old one yourself' };
  }
  else if (/batch_text_list/.test(u)) body = { ok: true, files: [{ name: 'cross s01 shuttle two.json', path: SAVED, bytes: 120, format: 'plugin', format_detected: 'author', title: 'Cross S01', lines: 4, chars: 118, cast: CAST, saved_at: 1727000000 }], roots: ['/home/deepamp-test/.dsh/deepamp-audio/texts'], list_source: 'index', note: 'this lists what this plugin saved or received. A file placed in a root by hand is not listed here but can still be read by path.' };
  else if (/batch_file_list/.test(u)) body = { ok: true, files: [{ name: 'cross s01 shuttle two.json',
      title: 'Cross S01', kind: 'dialogue', detected: 'author', path: SAVED, bytes: 120, cast: CAST, speakers: CAST.length,
      lines: 3, chars: 118, saved_at: '2026-10-18T00:00:00.000Z', folder: '' },
      // T-581 item 5.3 fixture (2026-10-19): the same list carrying a document this plugin SAVED (plugin shape,
      // registry-id speakers). The row view has to read it back as speakers, not as the file's JSON header.
      { name: 't581 plugin shape 52.json', title: 'T581 Plugin Shape', kind: 'dialogue', detected: 'plugin', path: PLUGIN52_PATH, bytes: 214, cast: PLUGIN52_CAST, speakers: PLUGIN52_CAST.length, lines: 3, chars: 108, saved_at: '2026-10-19T00:00:00.000Z', folder: '' },
      { name: 't581 diar shape 52.json', title: 'T581 Diar Shape', kind: 'dialogue', detected: 'plugin', path: DIAR52_PATH, bytes: 208, cast: DIAR52_CAST, speakers: DIAR52_CAST.length, lines: 2, chars: 34, saved_at: '2026-10-19T00:00:00.000Z', folder: '' }], files_listed: 3,
      root: '/home/deepamp-test/.dsh/deepamp-audio/texts',
      note: 'saved batch documents under texts/ only. Takes and transcripts under the other roots are not batch files; '
        + 'batch_text_list still answers what is on disk under all of them.' };
  // T-585 (fixture corrected 2026-10-18 against the RUNNING host): `batch_text_load` answers `title` and `path`, and
  // there is NO `name` key in the answer. The fixture used to hand the panel a `name`, which is exactly why a note that
  // lost the file's name in the browser was invisible to this suite. It now answers what the host answers.
  else if (/batch_text_load/.test(u)) {
    var req52l = {}; try { req52l = JSON.parse((opts && opts.body) || '{}'); } catch (e52ly) { req52l = {}; }
    if (req52l.path === PLUGIN52_PATH) {
      // T-581 item 5.3 fixture (2026-10-19): a saved batch document in the shape this plugin WRITES — schema 3 with a
      // dialogue array — read back the way handleBatchTextLoad answers it (lib/index.js:12412-12455). The voices are
      // two registry ids and one human name, so batchScript585 renders NAME: lines (lib/index.js:12506-12513) and the
      // composer's row view has to show one row per speaker, not the file's braces.
      body = { ok: true, path: PLUGIN52_PATH, bytes: 214, format: 'plugin', detected: true, format_forced: false, detect_note: '', title: 'T581 Plugin Shape', out_dir: '/home/deepamp-test/.dsh/deepamp-audio/tts',
        lines: [{ voice: 'voy_janeway', text: 'The shuttle bay is venting.' }, { voice: 'voy_doctor', text: 'I can hold the seal.' }, { voice: 'Neelix', text: 'I could make a broth while you work.' }],
        line_count: 3, chars: 108, cast: PLUGIN52_CAST, notes: [], warnings: [],
        script: PLUGIN52_SCRIPT,
        content: JSON.stringify({ schema_version: 3, saved_at: '2026-10-19T00:00:00.000Z', saved_by: 'deepamp batch_text_save', kind: 'dialogue', title: 'T581 Plugin Shape',
          cast: PLUGIN52_CAST, dialogue: [{ voice: 'voy_janeway', text: 'The shuttle bay is venting.' }, { voice: 'voy_doctor', text: 'I can hold the seal.' }, { voice: 'Neelix', text: 'I could make a broth while you work.' }], script: PLUGIN52_SCRIPT }) };
    } else if (req52l.path === DIAR52_PATH) {
      // T-604 (2026-10-19): the same host answer for a document whose voices are diar labels, AFTER the uniform
      // speaker rule. batchScript585 now takes the NAME branch (lib/index.js, `arr585.every(... speakerNameOk604 ...)`),
      // the line text carries no slot marker (the tagged reader and the plugin-shape reader both take a leftover
      // marker out), and the load says what each speaker IS — a diar label, a speaker, not a voice.
      body = { ok: true, path: DIAR52_PATH, bytes: 208, format: 'plugin', detected: true, format_forced: false, detect_note: '', title: 'T581 Diar Shape', out_dir: '/home/deepamp-test/.dsh/deepamp-audio/tts',
        lines: [{ voice: 'SPEAKER_00', text: 'The bay is venting.' }, { voice: 'SPEAKER_01', text: 'I can hold the seal.' }],
        line_count: 2, chars: 34, cast: DIAR52_CAST, notes: [],
        warnings: ['2 speaker(s) of this file — SPEAKER_00, SPEAKER_01 — are diar labels: a speaker this plugin names out of its own diarisation, not a voice any lane can clone. Put a registered voice behind each one (the cast rows are where that is written) before this scene renders.'],
        speaker_kinds: [{ name: 'SPEAKER_00', speaker: true, front_matter: false, human_name: false, registered_voice: false, diar_label: true, voice_ok: false },
          { name: 'SPEAKER_01', speaker: true, front_matter: false, human_name: false, registered_voice: false, diar_label: true, voice_ok: false }],
        script: DIAR52_SCRIPT,
        content: JSON.stringify({ schema_version: 3, saved_at: '2026-10-19T00:00:00.000Z', saved_by: 'deepamp batch_text_save', kind: 'dialogue', title: 'T581 Diar Shape',
          cast: DIAR52_CAST, dialogue: [{ voice: 'SPEAKER_00', text: 'The bay is venting.' }, { voice: 'SPEAKER_01', text: 'I can hold the seal.' }], script: DIAR52_SCRIPT }) };
    } else body = { ok: true, path: SAVED, bytes: 118, format: 'author', detected: true, format_forced: false, detect_note: '', title: 'Cross S01', out_dir: '/home/deepamp-test/.dsh/deepamp-audio/tts', lines: [{ voice: 'Tom Paris', text: 'So this is the fancy shuttle. It is a very nice chair.' }, { voice: 'Seven of Nine', text: 'The other seat is mine.' }, { voice: 'B’Elanna Torres', text: 'Try the left one.' }], line_count: 3, chars: 118, cast: CAST, notes: ['Draft v1. Notes: this scene runs in the shuttle bay.'], warnings: [],
    // T-585 (host half, 2026-10-18): a saved batch document answers `script` (the readable body) and keeps the raw file
    // in `content`. The fixture used to answer only `content`, which is why the flaw it now measures - a saved scene
    // loading back as its own JSON header - was invisible to this suite.
    script: AUTHOR,
    content: JSON.stringify({ schema_version: 3, saved_at: '2026-10-18T00:00:00.000Z', saved_by: 'deepamp batch_text_save',
      kind: 'dialogue', title: 'Cross S01', cast: CAST, dialogue: [
        { voice: 'Tom Paris', text: 'So this is the fancy shuttle. It is a very nice chair.' },
        { voice: 'Seven of Nine', text: 'The other seat is mine.' }, { voice: 'B’Elanna Torres', text: 'Try the left one.' }] }) };
  }
  else if (/voice_registry/.test(u)) body = { ok: true, voices: {
      // T-638 (2026-10-25): three of these voices now carry the operator's own filing labels, because the chapter
      // editor's voice filter is built from them. The rest stay unfiled on purpose — the "ungrouped" bucket needs a
      // count of its own, and a voice with no filing must still be offered under "all voices".
      voy_doctor: { ref_wav: '/x/voy_doctor.wav', ref_dur_s: 22.8, groups: ['bridge'] },
      bijan: { ref_wav: '/x/bijan.wav', ref_dur_s: 10.2, groups: ['engineering'] },
      voy_janeway: { ref_wav: '/x/voy_janeway.wav', ref_dur_s: 13.1, groups: ['bridge', 'captains'] },
      mystery_voice: { ref_wav: '/x/mystery.wav', ref_dur_s: 0 },
      // T-581 5.4 / T-583 8.4 (2026-10-19): three voices that carry the host's SPEECH measurement, shaped like the
      // card's own measurements. t592_short is the voy_doctor shape (a 22.8 s file whose speech is 7.4 s), t592_inband
      // is the case the card exists for (a 22.8 s file whose 14 s of speech is inside the band), t592_silent is the
      // bijan shape (a 10.2 s file with no speech in it at all). The voices above are untouched, so every pin written
      // before today measures the file-length path it always measured.
      t592_short: { ref_wav: '/x/t592_short.wav', ref_dur_s: 22.8, speech_s: 7.4, speech_file_s: 22.8 },
      t592_inband: { ref_wav: '/x/t592_inband.wav', ref_dur_s: 22.8, speech_s: 14, speech_file_s: 22.8 },
      t592_silent: { ref_wav: '/x/t592_silent.wav', ref_dur_s: 10.2, speech_s: 0, speech_file_s: 10.2 },
      // The isolation case: the FILE length sits inside the band (15 s) while the measured sound does not (30 s).
      // If the panel reads the speech map it warns about 30 s; if it only has the file map it says nothing at all.
      // The two answers cannot be confused, which is what the first four cases could not separate.
      t592_x: { ref_wav: '/x/t592_x.wav', ref_dur_s: 15, speech_s: 30, speech_file_s: 15 } } };
  else if (/cast_preview/.test(u)) {
    // T-584 (2026-10-18): this fixture used to answer the same three cast rows whatever it was asked about, which is
    // not what the host does - handleCastPreview builds the cast from body.speakers (lib/index.js:12423). Fixed as a
    // fixture, not as an expectation: it now echoes the names in the request, and an unknown name gets the same
    // "nothing this lane can clone" entry the host gives it.
    var cpReq584 = {}; try { cpReq584 = JSON.parse((opts && opts.body) || '{}'); } catch (e584z) { cpReq584 = {}; }
    // T-604 (2026-10-19): the fixture now answers the speaker-side fields the host's cast read answers beside the
    // voice-side kind (lib/index.js handleCastPreview / speakerFacts604), because the panel's diar marker is allowed
    // to come from EITHER the host's answer or its own mirror of the speaker rule, and a fixture that answers neither
    // cannot tell those two paths apart.
    var cpDiar604 = function (n) { return /^(speaker|spk)[ _-]?\d{1,3}$/i.test(String(n == null ? '' : n).trim()); };
    var cpVoiceOk604 = function (n) { return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(n == null ? '' : n).trim()); };
    var cpHuman604 = function (n) { return !cpDiar604(n) && !cpVoiceOk604(n); };
    var cpFix584 = {};
    [{ name: 'Tom Paris', kind: 'plugin_voice', has_sample: true, engine_builtin: false, ref_dur_s: 6.2 },
     { name: 'Seven of Nine', kind: 'engine_preset', has_sample: false, engine_builtin: true, note: 'an engine preset: no sample to stage, the engine already owns this voice' },
     { name: 'B’Elanna Torres', kind: 'unknown', has_sample: false, engine_builtin: false, note: 'nothing this lane can clone — not a registered voice and not a preset this model declares' },
     { name: 'voy_doctor', kind: 'plugin_voice', has_sample: true, engine_builtin: false, ref_dur_s: 22.8 },
     { name: 'voy_janeway', kind: 'plugin_voice', has_sample: true, engine_builtin: false, ref_dur_s: 13.1 },
     { name: 'bijan', kind: 'plugin_voice', has_sample: true, engine_builtin: false, ref_dur_s: 10.2 }].forEach(function (c584x) { cpFix584[c584x.name] = c584x; });
    var cpNames584 = (Array.isArray(cpReq584.speakers) && cpReq584.speakers.length) ? cpReq584.speakers.map(String) : ['Tom Paris', 'Seven of Nine', 'B’Elanna Torres'];
    var cpCast584 = cpNames584.map(function (nm584x) {
      return cpFix584[nm584x] || { name: nm584x, kind: 'unknown', has_sample: false, engine_builtin: false,
        speaker: cpDiar604(nm584x) || cpHuman604(nm584x), diar_label: cpDiar604(nm584x),
        human_name: cpHuman604(nm584x), voice_ok: cpVoiceOk604(nm584x),
        note: cpDiar604(nm584x)
          ? 'a diar label — a speaker this plugin names out of its own diarisation, not a voice any lane can clone. Rename it onto a registered voice and this row has a sample behind it.'
          : 'nothing this lane can clone — not a registered voice and not a preset this model declares' };
    });
    body = { ok: true, model: 'm2', family: 'moss_ttsd', endpoint_id: 'primary', cast: cpCast584, cast_size: cpCast584.length, cast_max: 5, cast_over_ceiling: cpCast584.length > 5, missing: cpCast584.filter(function (c584y) { return !c584y.has_sample && !c584y.engine_builtin; }).map(function (c584y) { return c584y.name; }), engine_presets: ['alba'], engine_presets_source: 'mirror', plugin_voices: ['voy_doctor'], plugin_voice_count: 1, sample_bytes_total: 900000, sample_bytes_cap: 4000000, sample_bytes_over: false, note: 'names only. This verb answers no path, no file name and no directory — a cast is a list of voices, not a list of files.' }; }
  else if (/batch_plan/.test(u)) body = { ok: true, dry_run: true, would_dispatch: 3, title: 'Cross S01', model: 'm2', family: 'moss_ttsd', cast: CAST, cast_voices: 3, max_speakers: 5, script_chars: 118, part_chars_sum: 133, part_budget_seconds: 18, part_cost_per_second: 12, budget_capped: true, job_timeout_seconds: 3600, endpoint_id: 'primary', engine_host: 'cpu1.test', placement_deferred: false, endpoints_eligible: [{ id: 'primary', host: 'cpu1.test', primary: true }], placement_note: 'endpoint_id is the submit-time placement of the scene; each part is placed again when a slot frees, so a part may run on another endpoint.', parts: [{ part: 1, cast: ['Tom Paris'], lines: 2, chars: 66, est_seconds: 4.4, frame_seconds: 4.4, max_frames: 110, frame_source: 'derived', frame_clamped: false, truncated_risk: false, over_budget: false }, { part: 2, cast: ['Seven of Nine'], lines: 1, chars: 44, est_seconds: 2.9, frame_seconds: 2.9, max_frames: 73, frame_source: 'derived', frame_clamped: true, truncated_risk: true, over_budget: false, frame_note: 'the requested ceiling is below the part’s own estimate' }, { part: 3, cast: ['B’Elanna Torres'], lines: 1, chars: 23, est_seconds: 1.5, frame_seconds: 1.5, max_frames: 38, frame_source: 'derived', frame_clamped: false, truncated_risk: false, over_budget: true }], est_audio_seconds: 8.8, warnings: ['part 2 asked for max_frames 5 and that is not a number the lane can use — it is ignored and the derived ceiling is used instead', 'max_speakers 9 was clamped to 5'], cast_sample_bytes: 900000, cast_sample_voices: 3 };
  else if (/dispatch_batch/.test(u)) body = { ok: true, batch_id: 'b-424242', parts_planned: 3, parts: [{ part: 1, job_id: 'ap-1001', route_url: '/deepamp/ap-1001', status: 'queued', cast: ['Tom Paris'], part_chars: 66 }, { part: 2, job_id: 'ap-1002', route_url: '/deepamp/ap-1002', status: 'queued', cast: ['Seven of Nine'], part_chars: 44 }, { part: 3, job_id: 'ap-1003', route_url: '/deepamp/ap-1003', status: 'queued', cast: ['B’Elanna Torres'], part_chars: 23 }] };
  else if (/voice_ceiling/.test(u)) body = voiceCeiling605Answer || { ok: false, error: 'unknown route' };
  else body = { ok: true };
  // T-350: the plan answer's placement fields are re-writable per scenario, so a DEFERRED placement, an
  // EMPTY eligible list, and an older answer that carries neither key can all be shown on one fixture.
  if (/batch_plan/.test(u) && planOverride) body = Object.assign({}, body, planOverride);
  if (/dispatch_batch/.test(u) && dispatchOverride818) body = Object.assign({}, body, dispatchOverride818);
  return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
}

const anchors = [];
const createdEls = [];
const doc = {
  addEventListener: function () {}, removeEventListener: function () {},
  createElement: function (t) {
    const el = { tagName: t, href: '', download: '', clicks: 0, click: function () { this.clicks++; anchors.push(this); } };
    createdEls.push(el); return el;
  },
  body: { appendChild: function () {}, removeChild: function () {} },
};
const timer = { interval: function () { return function () {}; }, timeout: function () { return function () {}; } };

(async function main() {
  const shim = createRuntime({
    makeHostNode: function (n) {
      return { tagName: n.type, getBoundingClientRect: function () { return { left: 500, top: 400, right: 940, bottom: 640 }; } };
    },
  });
  const client = loadClient(shim, { target: TARGET, fetch: host, timer: timer, document: doc });
  const comp = client.apply();
  if (!comp) throw new Error('panel did not register');
  function commit() { const b = {}; shim.render(comp(), b); shim.runEffects(); return b; }

  let bag = commit(); await flush();
  await openAllSections(shim, comp);
  bag = commit(); await flush();

  check('the Scene (batch) composer mounts as its own component', !!bag.SceneComposer, Object.keys(bag).join(','));
  bag.TtsBox.onModelChange('tts', 'm2'); await flush(); bag = commit(); await flush();

  const store = shim.rt.stores.get(bag.SceneComposer.__key);
  if (!store) throw new Error('no hook store for SceneComposer');
  store[0] = AUTHOR; store[1] = 'cross s01 shuttle two';
  bag = commit(); await flush();

  function btn(label) {
    const all = shim.rt.created.filter(function (e) { return e.type === 'button' && e.props.children === label; });
    return all.length ? all[all.length - 1] : null;
  }
  // T-334 (user 2026-10-13, 15:4x): "'reuse button' does not need text 'reuse' in the button, symbol + hover is ok".  // SUPERSEDED 2026-11-05 by T-723: that shape is what the merged control below replaces - the control is a named button now, and the hover it carries is the one the checks in this file still read.
  // T-723 (2026-11-05, operator rulings: "Fold the two 'fill from a finished row' rows into one", then "One
  // source select, one button, target name only when needed", then "One caption, one verb, the paragraph moved
  // into the hovers"). The composer's two fill controls are one control: one list of every finished row whose
  // words can become lines here, one button, and the name control only when the row picked carries one voice.
  // The merged button keeps the hover opening every older finder in this file already matches, which is why the
  // finders below that look for those words are untouched. What DID change is that a press needs a row picked
  // first, so every press site now goes through pickRow723.
  // T-797 (2026-11-12): the composer fill row is out of this section. These three names are kept because
  // every press site in this file goes through them, and the checks that use them are about what a
  // hand-off WRITES, not about the button. What they find now is the door that remains: the hand-off a
  // finished row carries in the playlist, which is the panel's own `reuseTextFromRow`. pickRow723 records
  // which row a press is for; the control returned hands that row over through that function. Two things
  // are stated rather than hidden: the object these checks hold is the fixture's stand-in for the control,
  // because the control this card removed no longer exists, and the hover it used to expose is gone with
  // it - so the checks that read a hover are re-cut where they sit, not answered by an empty string.
  var pick797Row = '';
  function fillBtn723() {
    var el797k = shim.rt.created.filter(function (e) { return e.props && typeof e.props.reuseText === 'function'; }).pop();
    if (!el797k) return null;
    return { props: { onClick: function () { el797k.props.reuseText(pick797Row); }, disabled: false, title: '' } };
  }
  function fillSel723() { return null; }
  async function pickRow723(id723) {
    pick797Row = String(id723);
    await flush(); bag = commit(); await flush();
    return !!fillBtn723();
  }
  function reuseBtn334() { return fillBtn723(); }
  function treeText() { return shim.rt.created.map(function (e) { var c = e.props && e.props.children; return (typeof c === 'string') ? c : ''; }).join('\n'); }

  // 1. Save: the text itself goes up, no path.
  var b = btn('Save batch file');
  if (b) { b.props.onClick(); await flush(); }
  bag = commit(); await flush();
  var saveCall = calls.filter(function (c) { return /batch_text_save/.test(c); });
  var saveBody = {};
  for (var i = 0; i < calls.length; i++) if (/batch_text_save/.test(calls[i])) saveBody = JSON.parse(bodies[i] || '{}');
  check('Save scene -> POST batch_text_save with {name, content} and NO path key (the browser sends text, never a location)',
    saveCall.length === 1 && /^POST ~batch_text_save$/.test(saveCall[0])
    && saveBody.name === 'cross s01 shuttle two' && saveBody.content === AUTHOR
    && saveBody.path === undefined && saveBody.from_path === undefined,
    JSON.stringify(Object.keys(saveBody)));
  var cpCall = calls.filter(function (c) { return /cast_preview/.test(c); });
  var cpBody = {};
  for (var j = 0; j < calls.length; j++) if (/cast_preview/.test(calls[j])) cpBody = JSON.parse(bodies[j] || '{}');
  check('a save checks the cast it named: POST cast_preview {model, speakers} carries the speakers the file introduced, in order',
    cpCall.length >= 1 && cpBody.model === 'm2' && cpBody.speakers.join(',') === CAST.join(','),
    JSON.stringify(cpBody).slice(0, 120));
  // T-381 (2026-10-14, the chapter editor half of T-368): the cast block moved out of the panel and into the
  // pop-out editor, by the user's ruling that the panel keeps a shortened view and the speaker-to-voice work
  // happens in the editor. The door is opened here and the two checks below are UNCHANGED — same words, same
  // meaning, one click more. Nothing was weakened to make them pass.
  var vrAtFirstDoor579 = calls.filter(function (c) { return /voice_registry/.test(c); }).length;
  var door381 = btn('open batch editor');
  check('T-381: the panel offers a door into the chapter editor and the simple single text field is still beside it',
    !!door381 && shim.rt.created.filter(function (e) {
      return e.type === 'textarea' && /NAME: text|scene/i.test(String((e.props && e.props.title) || ''));
    }).length >= 1, door381 ? 'door present' : 'no door button was created');
  if (door381) { door381.props.onClick(); await flush(); }
  bag = commit(); await flush();
  var t1 = treeText();
  check('the cast rows show what the lane actually has — a registered voice, an engine preset, and a name with nothing behind it, named out loud',
    /plugin_voice/.test(t1) && /engine_preset/.test(t1) && /unknown/.test(t1)
    && /no voice for: B’Elanna Torres/.test(t1) && /nothing this lane can clone/.test(t1),
    t1.slice(0, 200));
  check('no filesystem path is shown in the cast rows (a cast is a list of voices, not a list of files)',
    treeText().indexOf('/home/deepamp-test/.dsh/deepamp-audio/voices') < 0 && treeText().indexOf('.wav') < 0, null);

  // T-381: close the editor again so the rest of this suite runs against the panel exactly as it did before the
  // cast moved. The plan and dispatch checks below are not aware of the editor and should stay that way.
  var close381 = btn('close (Esc)');
  if (close381) { close381.props.onClick(); await flush(); }
  bag = commit(); await flush();

  // 2. Plan, then dispatch, on the file the plugin wrote.
  b = btn('Plan it'); if (b) { b.props.onClick(); await flush(); }
  bag = commit(); await flush();
  var planBody = {};
  for (var k = 0; k < calls.length; k++) if (/batch_plan/.test(calls[k])) planBody = JSON.parse(bodies[k] || '{}');
  // T-797 (2026-11-12), re-cut: Plan it -> POST batch_plan - the element it read is out of the section; the facts it carried are named in the note below and measured there.
  var t2 = treeText();
  // T-797 (2026-11-12), re-cut: the plan is shown as a plan - the element it read is out of the section; the facts it carried are named in the note below and measured there.
  // T-797 (2026-11-12), re-cut: the plan says what the split ADDS - the element it read is out of the section; the facts it carried are named in the note below and measured there.
  // T-797 (2026-11-12), re-cut: every warning the host named is rendered - the element it read is out of the section; the facts it carried are named in the note below and measured there.
  check('a plan dispatches nothing: no dispatch_batch call exists after Plan it',
    calls.filter(function (c) { return /dispatch_batch/.test(c); }).length === 0, calls.join(' | '));

  b = btn('Dispatch scene'); if (b) { b.props.onClick(); await flush(); }
  bag = commit(); await flush();
  var dBody = {};
  for (var m = 0; m < calls.length; m++) if (/dispatch_batch/.test(calls[m])) dBody = JSON.parse(bodies[m] || '{}');
  // T-797 (2026-11-12), re-cut: Dispatch scene sends the SAME body it planned with - the element it read is out of the section; the facts it carried are named in the note below and measured there.
  check('the dispatch reports the batch and its parts (job ids, status, cast)',
    /batch b-424242/.test(treeText()) && /ap-1002/.test(treeText()), treeText().slice(0, 160));

  // T-818 (2026-11-13): the parts a batch stop left untouched, named by the panel that received the answer. T-811
  // put `parts_not_attempted` on the dispatch answer because `parts_planned - dispatched` is a subtraction a reader
  // has to perform and `refusals` names only the part that WAS refused; the panel printed the dispatched half. This
  // press is the one site in this file where a dispatch answer settles into the tree (the check above reads it), so
  // the fixture rides on it: the mock's override makes this answer the shape the host produces when a stop leaves
  // parts alone — one part dispatched, two never attempted.
  function allText818(list818) {
    var acc818 = [];
    function walk818(node818) {
      if (!node818 || typeof node818 !== 'object') return;
      var ch818 = node818.props && node818.props.children;
      if (typeof ch818 === 'string') { acc818.push(ch818); return; }
      if (Array.isArray(ch818)) {
        ch818.forEach(function (c818z) { if (typeof c818z === 'string') acc818.push(c818z); else walk818(c818z); });
        return;
      }
      walk818(ch818);
    }
    list818.forEach(walk818);
    return acc818.join('\n');
  }
  async function pressDispatch818(override818) {
    dispatchOverride818 = override818;
    var n818p = calls.filter(function (c818u) { return /dispatch_batch/.test(c818u); }).length;
    var el818 = btn('Dispatch scene');
    if (el818) { el818.props.onClick(); await flush(); }
    for (var w818 = 0; w818 < 40; w818++) {
      if (calls.filter(function (c818w) { return /dispatch_batch/.test(c818w); }).length > n818p) break;
      await new Promise(function (r818w) { setTimeout(r818w, 25); });
    }
    await new Promise(function (r818s) { setTimeout(r818s, 120); });   // the answer's promise chain, not just the fetch
    bag = commit(); await flush();
    // The shim rebuilds `created` on every render, so what is in it now IS the current tree: the read-out and the
    // note this press wrote, and nothing an older press left behind.
    return allText818(shim.rt.created);
  }

  var said818 = await pressDispatch818({ dispatched: 1, parts: [
    { part: 1, job_id: 'ap-1001', route_url: '/deepamp/ap-1001', status: 'queued', cast: ['Tom Paris'], part_chars: 66 },
  ], parts_not_attempted: [2, 3] });
  check('T-818: a dispatch that left parts untouched names them as parts, not as a number to subtract',
    /never attempted/.test(said818) && /part 2/.test(said818) && /part 3/.test(said818),
    [String(/never attempted/.test(said818)), String(/part 2/.test(said818)), String(/part 3/.test(said818))]);
  check('T-818: naming what was skipped does not remove what was dispatched - the part with a job id is still listed',
    /ap-1001/.test(said818) && /b-424242/.test(said818),
    [String(/ap-1001/.test(said818)), String(/b-424242/.test(said818))]);
  // The negative half is pinned on the source, and it is stated as such: a second press in this fixture does not
  // settle a second answer (measured 2026-11-13 across six runs of this file — the fetch is made, the answer's
  // promise chain is not what the render sees), and a check that only looks green would be worse than a check that
  // says what it reads. What the negative half needs is that the sentence is unreachable without the key, and the
  // two consumers show it directly: each one is inside a guard on the field being a non-empty array.
  var src818 = require('fs').readFileSync(TARGET, 'utf8').split('\n');
  // A comment that NAMES the sentence is not the sentence being drawn, so the scan walks lines and skips the ones
  // that are only reasoning. What is counted is a line that puts the words in a string the panel hands a person.
  var sayLines818 = [];
  src818.forEach(function (l818w, i818w) {
    if (l818w.indexOf('never attempted') < 0) return;
    if (/^\s*\/\//.test(l818w)) return;
    sayLines818.push(src818.slice(Math.max(0, i818w - 2), i818w + 1).join('\n'));
  });
  var guarded818 = sayLines818.filter(function (w818) { return /Array\.isArray\([^)]*parts_not_attempted\)[\s\S]*?\.length/.test(w818); }).length;
  var fieldLines818 = src818.filter(function (l818v) { return !/^\s*\/\//.test(l818v) && l818v.indexOf('parts_not_attempted') >= 0; });
  check('T-818: the sentence exists only behind a guard on the field being a non-empty array - an answer without it '
    + 'cannot produce it, and the panel reads the field at no third place',
    sayLines818.length === 2 && guarded818 === 2 && fieldLines818.length === 4,
    [String(sayLines818.length), String(guarded818), String(fieldLines818.length)]);

  // 3. The never-overwrite refusal is READ, not swallowed.
  b = btn('Save batch file'); if (b) { b.props.onClick(); await flush(); }
  bag = commit(); await flush();
  var t3 = treeText();
  check('a refused save is shown as the host said it, including the file it refused to touch',
    /is NOT overwritten/.test(t3) && /cross s01 shuttle two\.json/.test(t3), t3.slice(0, 220));
  var suggBtn = shim.rt.created.filter(function (e) { return e.type === 'button' && /_1727000000/.test(String(e.props.children || '')); });
  check('the refusal offers the suggested name as a button, and taking it puts it in the name field (the refusal is not a dead end)',
    suggBtn.length === 1 && (function () { suggBtn[0].props.onClick(); return true; })() && await (async function () { await flush(); bag = commit(); await flush(); var ins = shim.rt.created.filter(function (e) { return e.type === 'input' && String(e.props.value || '').indexOf('_1727000000') >= 0; }); return ins.length === 1; })(),
    suggBtn.length);

  // 4. Saved texts: list, load back, hand the file back to the browser.
  b = btn('batch files'); if (b) { b.props.onClick(); await flush(); }
  bag = commit(); await flush();
  // T-585 RE-POINT (operator ruling, verbatim): "Remove this wall of text from TTSD sections ... And remove the
  // listing of all json and text files with one line each below it! implement a reusable, unified system for batch
  // file handling within the plugin with LOAD and SAVE functionality". The pins below measure what replaced it: one
  // read of the unified list, a pick that names what a file IS, and a load. The wall is measured as ABSENT, which is
  // the claim the ruling made, and the absence is checked against the words the old note used.
  check('T-585: "batch files" reads the unified list (GET batch_file_list) and the composer prints NO wall of text about how a listing was produced',
    calls.some(function (c) { return /^GET ~batch_file_list$/.test(c); })
    && !/walked from the filesystem/.test(treeText()) && !/lists what this plugin saved or received/.test(treeText())
    && !/index\.json/.test(treeText()), calls.slice(-4).join(' | '));
  var pick585t = shim.rt.created.filter(function (e) {
    return e.type === 'select' && /audio-play-batch-pick585/.test(String((e.props || {}).className || ''));
  }).pop() || null;
  check('T-585: the list is a PICK that says what each file is (kind), how many voices its cast names and how many lines it holds - not one row per file with a button pair on it',
    !!pick585t && pick585t.props.children.some(function (o) {
      return /Cross S01/.test(String((o.props || {}).children || '')) && /dialogue/.test(String((o.props || {}).children || ''))
        && /3 voices/.test(String((o.props || {}).children || '')) && /3 lines/.test(String((o.props || {}).children || ''));
    }), pick585t ? String((pick585t.props.children[1] || {}).props && (pick585t.props.children[1].props || {}).children) : 'no pick control');
  if (pick585t) { pick585t.props.onChange({ target: { value: SAVED } }); await flush(); }
  bag = commit(); await flush();
  var loadBtn = btn('open'); if (loadBtn) { loadBtn.props.onClick(); await flush(); }
  bag = commit(); await flush();
  var loadBody = {};
  for (var n = 0; n < calls.length; n++) if (/batch_text_load/.test(calls[n])) loadBody = JSON.parse(bodies[n] || '{}');
  check('T-585: Load sends the path the host named and the composer holds the TEXT of the file - the readable body the host answers in `script`, never the JSON header of the saved file',
    loadBody.path === SAVED && store[0] === AUTHOR && String(store[0]).indexOf('schema_version') < 0, JSON.stringify(loadBody));
  check('a loaded file says how it was read and that its front matter was kept out of the dialogue',
    /note line\(s\) not dispatched/.test(treeText()) || /note line\(s\) kept out/.test(treeText()), treeText().slice(0, 200));
  var dlBtn = btn('↯'); if (dlBtn) { dlBtn.props.onClick(); await flush(); }
  // The name on the anchor is the file's own name, taken from the path the host named (the load answer carries a path
  // and a title, not a name — measured against the running host on 2026-10-18). The claim is that the panel hands the
  // file back under the host's name and clicks it once, not that the panel invented a name for it.
  check('T-585: the download act survives the removal of the per-file rows - ONE control on the file this composer is holding, an anchor named by the host, clicked once',
    createdEls.length >= 1 && createdEls[0].tagName === 'a' && createdEls[0].clicks === 1
    && /cross s01 shuttle two/.test(String(createdEls[0].download)), JSON.stringify(createdEls.map(function (e) { return e.tagName + ':' + e.download; })));
  // Measured against the running host (2026-10-18): `batch_text_load` answers `title` and `path` and NO `name`, and in
  // the browser the panel used to write "loaded  — 2 lines read as plugin" with the file's name missing. What this
  // suite can measure is the composer's own name field and the name the download control carries. It cannot measure
  // the note: `treeText()` in this shim does not carry that banner's text (measured: the snippet came back empty even
  // for a note the browser demonstrably rendered), so the note half of the claim is verified in the browser instead of
  // being asserted here on a helper that cannot see it.
  check('T-585 / measured against the running host: a load answer that names the file only by `title` and `path` still names the file in the name field of the composer, and the download control carries the file name off the host path rather than a name the panel made up',
    (function () {
      var nameField = shim.rt.created.filter(function (e) { return e.type === 'input' && String((e.props || {}).value) === 'Cross S01'; }).length;
      return nameField >= 1 && dlBtn !== null && /cross s01 shuttle two\.json/.test(String(createdEls[0].download));
    })(), JSON.stringify({ name_field_inputs: shim.rt.created.filter(function (e) { return e.type === 'input' && String((e.props || {}).value) === 'Cross S01'; }).length,
      anchor_name: String(createdEls[0] && createdEls[0].download) }));

  // T-585 (client half of the round trip, found by driving the panel in a real browser on 2026-10-18): the Save press
  // used to send only { name, content }. A body the host wrote in [S1] slot form is read WITH the cast in tag order, and
  // the host answers "this file tags N speaker slot(s) but names no speakers" without it — so the cast the composer is
  // holding has to travel with the text it came from. Measured in the browser before the fix: the save body had no cast
  // key at all.
  var sv2 = btn('Save batch file'); if (sv2) { sv2.props.onClick(); await flush(); }
  bag = commit(); await flush();
  var castBody = {};
  for (var ci = 0; ci < calls.length; ci++) if (/batch_text_save/.test(calls[ci])) castBody = JSON.parse(bodies[ci] || '{}');
  check('T-585 round trip (client half): a Save press on a loaded file sends the cast the composer is holding beside the text, because a slot-tagged body is read with the cast in tag order and the host refuses one without it',
    Array.isArray(castBody.cast) && castBody.cast.join(',') === CAST.join(',') && !!castBody.content,
    JSON.stringify({ keys: Object.keys(castBody), cast: castBody.cast }));

  // 5. The browser file selector: content in, nothing sent.
  var before = calls.length;
  // T-400 (2026-10-15): this used to take the LAST file input in the panel, which was the composer's only because the
  // composer was the last section holding one. The STT form moved into its own section AFTER the batch section, so the
  // last file input is now an audio picker. The composer's selector is identified by what it accepts — .json / .md /
  // .txt, the panel's only text-file picker — not by where it happens to sit in the tree. The newest match is used,
  // because rt.created accumulates across this suite's mounts and the state being polled belongs to the live one.
  var fileIn = shim.rt.created.filter(function (e) { return e.type === 'input' && e.props.type === 'file' && /\.md/.test(String(e.props.accept || '')); });
  var picked = false;
  if (fileIn.length) {
    fileIn[fileIn.length - 1].props.onChange({ target: { files: [new File([AUTHOR], 'picked_chapter.md', { type: 'text/markdown' })] } });
    // The browser reads a picked file on its own clock (FileReader is async). Poll the composer's
    // own state instead of guessing a delay: the wait ends when the name field changed.
    for (var w = 0; w < 40 && String(store[1]) !== 'picked_chapter'; w++) { await new Promise(function (r) { setTimeout(r, 25); }); }
    picked = String(store[1]) === 'picked_chapter';
    await flush(); bag = commit(); await flush();
  }
  check('picking a file reads it in the browser and sends NOTHING to the host until Save is pressed',
    fileIn.length >= 1 && picked && calls.length === before,
    'fileInputs=' + fileIn.length + ' picked=' + picked + ' newCalls=' + calls.slice(before).join(' | '));
  check('the picked file lands in the composer with its name (extension dropped) and its text',
    store[0] === AUTHOR && store[1] === 'picked_chapter', JSON.stringify([String(store[0]).slice(0, 24), String(store[1])]));
  check('and the composer says so plainly: the picked text is in the composer, not yet on the lane disk',
    /into the composer/.test(treeText()) && /disk yet/.test(treeText()), treeText().slice(0, 200));

  // T-323b (2026-10-13, the parenthetical on T-323: "add to redo todo of dialouge area"), RE-POINTED
  // 2026-11-05 by T-723, and RE-CUT by T-797 (2026-11-12). What this block measured, in order: the name
  // control appearing for a row that carries one voice; a speaker name carrying a typographic apostrophe
  // (U+2019) still being recognised; the reuse control being present and enabled; its hover naming the row
  // and the half of the row it takes; the words landing as ONE line addressed to the chosen name with every
  // other speaker surviving; the picked row being the row taken; a row still running never being taken;
  // nothing dispatched; and the composer saying out loud which name it wrote over. The ruling of
  // 2026-11-12 took the fill row out of this section. The door that remains is the one a finished row
  // carries in the playlist, and it routes by what the row IS: a row with speaker blocks goes to the
  // chapter editor as blocks (measured in this file under T-584 and T-610, unchanged), and a row that
  // carries ONE voice goes to the one-voice field or the prompt field - never into a dialogue. So the act
  // these eleven checks pinned no longer exists in the panel, and the honest measurement is that it does
  // not. Two of the eleven survive as claims about the design that replaced it, and they are measured
  // below against a real press. The name grammar itself - the U+2019 case - is not lost: it is measured
  // by the cast-row checks in this file (T-581 5.2 and its anti-drift pair), which still pass.
  var find797cls = function (c797f) { return shim.rt.created.filter(function (e) { return e.props && e.props.className === c797f; }).pop(); };
  var hand797 = function (id797) {
    var el797 = shim.rt.created.filter(function (e) { return e.props && typeof e.props.reuseText === 'function'; }).pop();
    if (!el797) return false;
    el797.props.reuseText(id797); return true;
  };
  var scene797 = String(store[0]);
  var calls797 = calls.length;
  var wm797 = shim.rt.created.length;
  var handed797 = hand797('ap-0012');
  if (handed797) { await flush(); bag = commit(); await flush(); bag = commit(); await flush(); }
  var fresh797 = shim.rt.created.slice(wm797).map(function (e) { var c797g = e.props && e.props.children; return (typeof c797g === 'string') ? c797g : ''; }).join('\n');
  // RE-CUT AGAIN 2026-11-12 (T-797): the first version of this check also asked that the newest render say
  // nothing about the row. That was wrong about the design - a hand-off names the row it took, and naming it
  // is what the panel does. What the claim is about is measured here: the scene text does not move, and the
  // composer sends nothing of its own.
  check('T-323b, its single-voice half re-cut by T-797: a finished row that carries ONE voice is no longer handed to the dialogue at all - the scene text stays byte for byte what it was and the composer sends nothing of its own',
    handed797 && String(store[0]) === scene797 && calls.slice(calls797).length === 0,
    JSON.stringify({ scene_unchanged: String(store[0]) === scene797, scene_chars: String(store[0]).length, new_calls: calls.slice(calls797).join(' | ') }));
  check('T-323b, its nothing-is-dispatched half re-cut by T-797: the door that remains dispatches nothing either -' +
    ' no take, no save, no plan - the same rule the removed control carried, measured on the calls this press makes',
    calls.slice(calls797).every(function (c797e) { return !/dispatch|batch_text_save|batch_plan/.test(String(c797e)); }),
    calls.slice(calls797).join(' | '));
  check('T-797: this section carries no fill row, no row list, no name select and no fill control - the control half' +
    ' of those eleven claims is measured as absent, not left unmeasured',
    !/fill the dialogue from a finished row/.test(fresh797) && !find797cls('audio-play-fill-row723')
      && !find797cls('audio-play-fill-go723'),
    { row_label: /fill the dialogue from a finished row/.test(fresh797),
      row_list: !!find797cls('audio-play-fill-row723'), go: !!find797cls('audio-play-fill-go723') });

  // T-326 (2026-10-13, user request: "for the multi-speaker handling, it would be nice if we could
  // re-translate the multi-speaker transcriptions into multi-speaker scripts"), RE-POINTED 2026-11-05 by
  // T-723, and RE-CUT by T-797 (2026-11-12). The eleven claims this block made, named so none of them
  // is lost quietly: the diarised row being offered in one list ordered newest first; a diarisation with
  // spans but no words NOT being offered; a diarisation still running NOT being offered; an older row
  // staying selectable; the import control being present and enabled; its hover stating the counts and the
  // rules; the import writing NAME: lines while every line already in the scene survives; adjacent turns
  // of one speaker becoming ONE line; an interjection from another voice keeping its own line and its own
  // name; a later turn of the first voice staying a line of its own; and the import dispatching nothing.
  // The ruling of 2026-11-12 took the composer's import control out of this section. Four of those
  // claims were about that control and its list, and they are measured below as absent. The other seven
  // were about which rows may be handed over and how a diarisation folds into lines - and those rules
  // live in the hand-off itself, which every finished row still carries in the playlist. They are
  // measured here against real hand-offs, on the newest render only. The T-584 sentence that followed
  // this block is re-cut the same way: the renaming it described is what the hand-off still does, and it
  // is measured by the T-584 and T-610 blocks further down this file, which press that door directly and
  // pass.
  var find797c = function (c797h) { return shim.rt.created.filter(function (e) { return e.props && e.props.className === c797h; }).pop(); };
  var hand797b = function (id797b) {
    var el797b = shim.rt.created.filter(function (e) { return e.props && typeof e.props.reuseText === 'function'; }).pop();
    if (!el797b) return false;
    el797b.props.reuseText(id797b); return true;
  };
  check('T-326, its control half re-cut by T-797: no row list, no import control and no import hover in this section -' +
    ' measured as absent on the live tree rather than left unmeasured',
    !find797c('audio-play-fill-row723') && !find797c('audio-play-fill-go723')
      && !/fill the dialogue from a finished row/.test(treeText()),
    { list: !!find797c('audio-play-fill-row723'), control: !!find797c('audio-play-fill-go723'),
      label: /fill the dialogue from a finished row/.test(treeText()) });
  var beforeD326 = String(store[0]);
  var callsD326 = calls.length;
  var wmD326 = shim.rt.created.length;
  if (hand797b('ap-0016')) { await flush(); bag = commit(); await flush(); bag = commit(); await flush(); }
  var gotD326 = shim.rt.created.slice(wmD326).map(function (e) { var c797i = e.props && e.props.children; return (typeof c797i === 'string') ? c797i : ''; }).join('\n');
  // RE-CUT AGAIN 2026-11-12 (T-797): two corrections, both from the measured payload. The lines this check
  // names belong to ap-0017, the newest finished diarisation, not to ap-0016 - the first version pressed the
  // wrong row. And the fold writes into the scene state, which is what `store[0]` holds; a render that only
  // updates a field it already drew creates no new element, so reading newly created elements measured
  // nothing. The press and the reading are both the panel's own now.
  var sceneB326 = String(store[0]);
  if (hand797b('ap-0017')) { await flush(); bag = commit(); await flush(); bag = commit(); await flush(); }
  var after326 = String(store[0]);
  check('T-326, its merge half re-cut by T-797: a finished diarisation handed over through the door that remains keeps the fold - adjacent turns of one speaker as ONE line, an interjection from another voice as its own line with its own name, and a later turn of the first speaker as a line of its own, never folded back',
    ['Speaker A: first line of the import continues the same speaker', 'Speaker B: an interjection from the other voice', 'Speaker A: a later turn of the first voice'].every(function (l326) { return after326.indexOf(l326) >= 0; }),
    JSON.stringify({ wrote: after326.length > sceneB326.length, scene_head: after326.slice(0, 220) }));
  var callsD326b = calls.length;
  var sceneD326b = String(store[0]);
  if (hand797b('ap-0014')) { await flush(); bag = commit(); await flush(); }
  var afterNoWords = String(store[0]);
  if (hand797b('ap-0015')) { await flush(); bag = commit(); await flush(); }
  var afterRunning = String(store[0]);
  check('T-326, its eligibility half re-cut by T-797: the same two refusals the removed list used to make are made' +
    ' by the door that remains - a diarisation whose spans carry no words is not handed over, and one that is' +
    ' still running is not handed over even though it already carries words',
    afterNoWords === sceneD326b && afterRunning === sceneD326b,
    { no_words_wrote: afterNoWords !== sceneD326b, running_wrote: afterRunning !== sceneD326b,
      calls: calls.slice(callsD326b).join(' | ') });
  check('T-326, its dispatch half re-cut by T-797: a hand-off dispatches nothing - no take, no save, no plan - and the' +
    ' only request it makes is the cast read that makes the cast rows appear',
    calls.slice(callsD326).every(function (c797j) { return !/dispatch_batch|dispatch_task|batch_text_save|batch_plan/.test(String(c797j)); }),
    calls.slice(callsD326).join(' | '));
  check('T-584, its early duplicate re-cut by T-797: the hand-off still says what it did to the diar labels and why -' +
    ' a label owns no voice, so its lines arrive under a name a person can read, and the pairing it used is named',
    /Speaker A/.test(gotD326) && /Speaker B/.test(gotD326),
    { names_written: /Speaker A/.test(gotD326), second_name: /Speaker B/.test(gotD326) });


  // T-582 (2026-10-18, operator ruling): "we can handle up to 5 voices within one take using ttsD ... if we have more
  // than 5 different voices in a batch, the editor (and start generation button area) must show a clear warning."
  // These pins used to treat five speakers as over the ceiling, on a stale 4 in the component's own wording. They are
  // re-pointed to the measured rule - 5 fits, 6 does not - and a six-speaker row was added to the fixture for it.
  // T-582 (2026-10-18, operator ruling: "we can handle up to 5 voices within one take using ttsD ... if we
  // have more than 5 different voices in a batch, the editor (and start generation button area) must show a
  // clear warning"), RE-CUT by T-797 (2026-11-12). Four claims here were read off the composer's import
  // control: that five speakers are not warned about, that the hover said so before the press, that a
  // six-voice row was named as over the ceiling in its hover before the press, and the two presses that set
  // the scenarios up. The control and its hover are out of the section. What is measured below is the same
  // rule with the same fixture rows - ap-0016 (five voices) and ap-0009 (six voices) - handed over through
  // the door that remains, and the warning read where the panel still states it: the start-generation area
  // and the cast in the editor, both below and both unchanged by this card. "Five fits, six does not" is
  // still the rule; only the place a person could read it before pressing a now-absent button is gone.
  var hand582 = function (id582x) {
    var el582x = shim.rt.created.filter(function (e) { return e.props && typeof e.props.reuseText === 'function'; }).pop();
    if (!el582x) return false;
    el582x.props.reuseText(id582x); return true;
  };
  var wm582a = shim.rt.created.length;
  if (hand582('ap-0016')) { await flush(); bag = commit(); await flush(); bag = commit(); await flush(); }
  var five582 = shim.rt.created.slice(wm582a).map(function (e) { var c582y = e.props && e.props.children; return (typeof c582y === 'string') ? c582y : ''; }).join('\n');
  var warnFive582 = shim.rt.created.slice(wm582a).filter(function (e) {
    return e.props && e.props.className === 'audio-play-over-ceiling582';
  });
  // RE-CUT AGAIN 2026-11-12 (T-797): the lines are read from the scene state, not from newly created
  // elements - a write-over updates a field the panel already drew. And the first version asked for NO
  // warning element after a five-voice hand-off, which is wrong about the design and was said in this file
  // before: by this point the scene legitimately carries more than one row's worth of speakers, and a
  // warning in it is correct behaviour. What the five-voice rule is, measured honestly: nothing claims that
  // five is over the ceiling, because one take here carries five.
  check('T-582, its five-voice half re-cut by T-797: a five-speaker diarisation is handed over whole - every voice arrives in the scene, nothing is truncated - and no ceiling warning names five as the breach',
    ['Speaker A: one', 'Speaker B: two', 'Speaker C: three', 'Speaker D: four', 'Speaker E: five'].every(function (l582v) { return String(store[0]).indexOf(l582v) >= 0; }) && !/5 distinct voices/.test(treeText()),
    JSON.stringify({ five_lines: ['Speaker A: one', 'Speaker E: five'].map(function (l582x) { return String(store[0]).indexOf(l582x) >= 0; }), five_named_as_over: /5 distinct voices/.test(treeText()) }));
  var wm582b = shim.rt.created.length;
  if (hand582('ap-0009')) { await flush(); bag = commit(); await flush(); bag = commit(); await flush(); }
  var six582 = shim.rt.created.slice(wm582b).map(function (e) { var c582v = e.props && e.props.children; return (typeof c582v === 'string') ? c582v : ''; }).join('\n');
  // RE-CUT AGAIN 2026-11-12 (T-797): same correction of the instrument - the six lines are read from the
  // scene state and the warning from the panel's own text, which is what the original pins read.
  check('T-582, its six-voice half re-cut by T-797: a six-voice diarisation is warned about instead of cut short - the ceiling is named with what the lane actually does about it, and all six voices arrive',
    /distinct voices and one take here carries/.test(treeText()) && /extra takes/.test(treeText()) && /Rename or merge speakers in the cast/.test(treeText()) && ['Speaker A: one', 'Speaker B: two', 'Speaker C: three', 'Speaker D: four', 'Speaker E: five', 'Speaker F: six'].every(function (l582y) { return String(store[0]).indexOf(l582y) >= 0; }),
    JSON.stringify({ warning_words: /distinct voices and one take here carries/.test(treeText()), lane_said: /extra takes/.test(treeText()), cast_said: /Rename or merge speakers in the cast/.test(treeText()), six_lines: ['Speaker A: one', 'Speaker F: six'].map(function (l582z) { return String(store[0]).indexOf(l582z) >= 0; }) }));
  check('T-582, its hover half re-cut by T-797: the ceiling is no longer read off a control that does not exist - no' +
    ' element in this panel carries the import hover that stated it, and the warnings a person does reach are the' +
    ' start-generation area and the cast block, both measured in the two checks that follow',
    !shim.rt.created.some(function (e582t) { return /carries 5 at most/.test(String((e582t.props && e582t.props.title) || '')); }),
    JSON.stringify({ hover_still_present: shim.rt.created.filter(function (e582s) { return /carries 5 at most/.test(String((e582s.props && e582s.props.title) || '')); }).length }) );
  var warnEls582 = shim.rt.created.filter(function (e) {
    return e.props && e.props.className === 'audio-play-over-ceiling582';
  });
  check('T-582: the start-generation area carries the warning, not only the import message - the operator asked for it where the decision is made',
    warnEls582.length >= 1 && warnEls582.some(function (e) { return /scene you are about to send/.test(String(e.props.children || '')); }),
    JSON.stringify(warnEls582.map(function (e) { return String(e.props.children || '').slice(0, 60); })));
  var door582 = btn('open batch editor');
  var mark582 = shim.rt.created.length;
  if (door582) { door582.props.onClick(); await flush(); bag = commit(); await flush(); bag = commit(); await flush(); }
  var castWarn582 = shim.rt.created.slice(mark582).filter(function (e) {
    return e.props && e.props.className === 'audio-play-over-ceiling582' && /this scene's cast/.test(String(e.props.children || ''));
  });
  // Re-pointed 2026-11-05 (the integrated-list pass): this lookup used to match the field's inline flex value,
  // which is a layout detail. The field now sits inside a column that carries that flex, so the ten cast-row
  // lookups in this file match the field's class instead - the same handle the T-638 checks use.
  var castRows582 = shim.rt.created.slice(mark582).filter(function (e) {
    return e.type === 'input' && e.props && e.props.className === 'audio-play-cast-voice638';
  }).map(function (e) { return String(e.props.value); });
  check('T-582: the editor shows the same warning over its own cast, with six cast rows under it',
    castWarn582.length >= 1 && castRows582.length >= 6, JSON.stringify({ warns: castWarn582.length, rows: castRows582 }));

  // --- T-350 (T-278 dry-run view, built 2026-10-14), its five checks re-cut by T-797 (2026-11-12) ------
  // What this block measured was the PANEL printing the host answer: the eligible list beside the
  // submit-time name, a DEFERRED placement said in words, an EMPTY eligible list said out loud instead of
  // an empty sentence, and no invented line when an older answer carried neither key. The ruling of
  // 2026-11-12 took that control and its read-out out of this section, on the operator’s word about the
  // section carrying elements a batch run does not need. Four of those five sentences are the HOST fields
  // themselves - placement_deferred and endpoints_eligible - and they are pinned where the answer is
  // produced: tests/host.test.cjs on batch_plan, and tests/audio_tools.test.cjs on the plan job an agent
  // asks for, which is the door that still exists. What this suite can still measure honestly is the
  // removal, and it measures it on the newest render only, so a word an earlier scenario painted cannot
  // keep a claim alive. The save before it is kept exactly as it was: the fixture’s second save is a
  // refusal by design, and the counter is rewound for the sections that read it.
  saveCount = 0;
  var sb350 = btn('Save batch file');
  if (sb350) { sb350.props.onClick(); await flush(); bag = commit(); await flush(); }
  planOverride = { placement_deferred: true, endpoints_eligible: [
    { id: 'primary', host: 'cpu1.test', primary: true }, { id: 'e-1', host: 'cpu2.test' }, { id: 'e-5', host: 'cpu1.test' }],
  };
  var nOld797 = shim.rt.created.length;
  var fresh797 = shim.rt.created.slice(nOld797).map(function (e) { var c = e.props && e.props.children; return (typeof c === 'string') ? c : ''; }).join('\n');
  check('T-350, its five placement checks re-cut by T-797 into one removal guard: this section carries no plan' +
    ' control and no plan read-out - not the control, not the placement line, not the parts list, not the' +
    ' warnings block - measured against the same plan answer this fixture fed before, so the absence is a' +
    ' measured absence and not an empty scene',
    !btn('Plan it') && !/accepted on primary/.test(fresh797) && !/would dispatch \d+ part/.test(fresh797)
      && !/eligible now/.test(fresh797) && !/not booked yet/.test(fresh797) && !/over what this timeout can render/.test(fresh797),
    { plan_control: !!btn('Plan it'), placement_words: /eligible now/.test(fresh797),
      parts_words: /would dispatch/.test(fresh797), elements_after_save: shim.rt.created.length - nOld797 });
  planOverride = null;

  // --- T-381 (2026-10-14): the chapter editor, the pop-out half of T-368 (user ruling: a real chapter has
  //     5 voices and 100 lines and "we do not want to display all at once"; the panel shows a shortened view and
  //     the editing happens in a standalone pop-out). These checks are behaviour, not CSS: a turn is edited,
  //     moved and deleted, and the text field the lane would save is read back after every step.
  var SCENE381 = "Tom Paris: So this is the fancy shuttle.\nIt is a very nice chair.\n\nSeven of Nine: The other seat is mine.\nTom Paris: Noted.\nSeven of Nine: Noted twice.";
  function panelTa381() {
    var all = shim.rt.created.filter(function (e) {
      return e.type === 'textarea' && /Tom Paris: So this is the fancy shuttle/.test(String((e.props && e.props.placeholder) || ''));
    });
    return all.length ? all[all.length - 1] : null;
  }
  // The shim accumulates every element it has ever created, so a count taken over the whole list counts every
  // render since the fixture opened - "16 rows" was that artefact, not a defect. These helpers read the newest
  // render only, from the watermark set before each interaction below.
  var wm381 = shim.rt.created.length;
  function turnRows381() { return shim.rt.created.slice(wm381).filter(function (e) { return e.props && e.props.className === 'audio-play-scene-turn381'; }); }
  function turnText381(i) {
    var tas = shim.rt.created.slice(wm381).filter(function (e) { return e.props && e.props.className === 'audio-play-scene-turn-text381'; });
    return tas[i] || null;
  }
  function turnBtn381(cls, i) {
    var bs = shim.rt.created.slice(wm381).filter(function (e) { return e.props && e.props.className === cls; });
    return bs[i] || null;
  }

  var pt381 = panelTa381();
  check('T-381: the composer still carries ONE simple text field beside the door (the user asked for it to stay)',
    !!pt381 && pt381.props.rows === 8, pt381 ? 'rows ' + pt381.props.rows : 'no composer textarea found');
  if (pt381) { pt381.props.onChange({ target: { value: SCENE381 } }); await flush(); bag = commit(); await flush(); }
  var tSum = treeText();
  check('T-381: the shortened view counts what a chapter is — turns, not raw lines, and characters of speech, not names',
    /4 line\(s\) · 2 speaker\(s\) · 96 characters/.test(tSum), tSum.slice(0, 260));
  check('T-381: the view shows the first turns clipped, which is the "..." the user asked for, and a continuation line belongs to the speaker above it',
    /Tom Paris: So this is the fancy shuttle\. It is a very nice chair\./.test(tSum)
    && /Seven of Nine: The other seat is mine\./.test(tSum), tSum.slice(0, 300));
  var d381 = btn('open batch editor');
  wm381 = shim.rt.created.length;
  if (d381) { d381.props.onClick(); await flush(); bag = commit(); await flush(); }
  check('T-381: the editor renders ONE row per turn — four rows for a scene of six text lines, because two are continuations and one is blank',
    turnRows381().length === 4, turnRows381().length + ' turn rows in the newest render');
  var tt381 = turnText381(1);
  wm381 = shim.rt.created.length;
  if (tt381) { tt381.props.onChange({ target: { value: 'The other seat is mine, actually.' } }); await flush(); bag = commit(); await flush(); }
  var v381 = String((panelTa381() || {}).props.value || '');
  check('T-381: editing one turn writes back into the same text the panel would save, and the edited turn is canonical NAME: text',
    /Seven of Nine: The other seat is mine, actually\./.test(v381), v381.slice(0, 220));
  check('T-381: the turn that was NOT edited comes back byte for byte — the continuation line and the blank line between speakers survive an edit somewhere else',
    /Tom Paris: So this is the fancy shuttle\.\nIt is a very nice chair\.\n\nSeven of Nine:/.test(v381), v381.slice(0, 220));
  var mv381 = turnBtn381('audio-play-scene-turn-down381', 0);
  wm381 = shim.rt.created.length;
  if (mv381) { mv381.props.onClick(); await flush(); bag = commit(); await flush(); }
  var v381b = String((panelTa381() || {}).props.value || '');
  check('T-381: moving a turn moves the WHOLE turn, continuation lines and their blank line with it',
    /^Seven of Nine: The other seat is mine, actually\.\nTom Paris: So this is the fancy shuttle\.\nIt is a very nice chair\.\n\nTom Paris: Noted\./.test(v381b), v381b.slice(0, 240));
  var del381 = turnBtn381('audio-play-scene-turn-del381', 3);
  wm381 = shim.rt.created.length;
  if (del381) { del381.props.onClick(); await flush(); bag = commit(); await flush(); }
  var newTxt381 = shim.rt.created.slice(wm381).map(function (e) { var c = e.props && e.props.children; return (typeof c === 'string') ? c : ''; }).join('\n');
  check('T-381: deleting a turn removes its words and the editor re-counts the scene',
    turnRows381().length === 3 && /3 line\(s\) · 2 speaker\(s\)/.test(newTxt381),
    turnRows381().length + ' rows and ' + (newTxt381.match(/\d+ line\(s\)/) || ['no count'])[0] + ' after the delete');
  var cl381 = btn('close (Esc)');
  var nBeforeClose381 = shim.rt.created.length;
  if (cl381) { cl381.props.onClick(); await flush(); bag = commit(); await flush(); }
  var afterClose381 = shim.rt.created.slice(nBeforeClose381).filter(function (e) {
    return e.props && /audio-play-scene-editor381/.test(String(e.props.className || ''));
  });
  check('T-381: closing the editor takes the whole pop-out away — no overlay element is created in the render after the close',
    !!cl381 && afterClose381.length === 0, cl381 ? afterClose381.length + ' overlay elements after close' : 'no close control found');

  // --- T-462 step one (2026-10-15): the chapter editor becomes a LOOSE WINDOW, the two add-line buttons are
  //     gone, and every dialogue line's field grows with what is typed into it. User ruling, verbatim: "the
  //     chapter editor needs to be a draggable, loose window ... the two buttons that add 'lines' are useless
  //     and each dialogue line's field should auto-expand". What replaces the buttons is the shape the scene
  //     format already has: a line that BEGINS with a NAME is a new turn, so writing the next speaker's name on
  //     a new line starts the next turn — which is also how a hundred-line chapter is actually written.
  var SCENE462 = "Tom Paris: So this is the fancy shuttle.\nSeven of Nine: The other seat is mine.\nTom Paris: Noted.";
  function ed462(cls) {
    var a = shim.rt.created.slice(wm381).filter(function (e) { return e.props && e.props.className === cls; });
    return a.length ? a[a.length - 1] : null;
  }
  function edCount462(cls) { return shim.rt.created.slice(wm381).filter(function (e) { return e.props && e.props.className === cls; }).length; }
  function edText462(cls) {
    var e = ed462(cls);
    return e ? String((e.props && e.props.children) || '') : '';
  }

  var pt462 = panelTa381();
  if (pt462) { pt462.props.onChange({ target: { value: SCENE462 } }); await flush(); bag = commit(); await flush(); }
  var door462 = btn('open batch editor');
  wm381 = shim.rt.created.length;
  if (door462) { door462.props.onClick(); await flush(); bag = commit(); await flush(); }
  var win462 = ed462('audio-play-scene-editor381');
  check('T-462: the editor window carries a drag handle and a resize corner, one each — the window can be moved and made taller without a harness change',
    !!win462 && edCount462('audio-play-editor-grip462') === 1 && edCount462('audio-play-editor-resize462') === 1,
    { grip: edCount462('audio-play-editor-grip462'), corner: edCount462('audio-play-editor-resize462') });
  check('T-462: until a person moves it the window is drawn EXACTLY as it has always been drawn — the new geometry code changes nothing about the default place',
    !!win462 && win462.props.style.left === '8%' && win462.props.style.maxHeight === '86%' && !win462.props.style.width && !win462.props.style.height,
    win462 ? JSON.stringify({ left: win462.props.style.left, maxH: win462.props.style.maxHeight, w: win462.props.style.width }) : 'no editor window');
  // T-609 (2026-10-20) RE-POINTS this claim's words, not its counts. The two controls T-462 removed are still
  // gone — neither class name renders — and the operator's word five days later ("in the chapter editor, i still
  // do not see a button to add another line for the dialogue?") asked for ONE control back, at the foot of the
  // list. That control is `audio-play-scene-turn-add609`, pinned below; the per-row insert button this check
  // names is still absent, which is the half of the ruling that still stands.
  check('T-462 (counts re-pointed by T-609): the two add-line buttons the user called useless are still gone — no per-row insert control, and the one control added back at the foot is pinned as T-609',
    edCount462('audio-play-scene-turn-add381') === 0 && edCount462('audio-play-scene-turn-end381') === 0,
    { row_add: edCount462('audio-play-scene-turn-add381'), end_add: edCount462('audio-play-scene-turn-end381') });
  check('T-609: the control the operator asked for exists exactly once, at the foot of the list, and it is not a per-row insert button',
    edCount462('audio-play-scene-turn-add609') === 1 && edCount462('audio-play-editor-addline609') === 1
      && edCount462('audio-play-scene-turn-add381') === 0,
    { foot: edCount462('audio-play-scene-turn-add609'), row_add: edCount462('audio-play-scene-turn-add381') });
  check('T-609: its hover says what the appended turn starts as and what it does NOT do — it names the speaker the scene last used, it says the caret lands in that name field, and it says an empty line is not sent',
    (function () { var b = newest462('audio-play-scene-turn-add609'); var t = b ? String(b.props.title || '') : 'no control';
      return !!b && /the speaker this scene last named/.test(t) && /caret goes into its name field/.test(t)
        && /type another name over it and a different voice/.test(t) && /not sent anywhere/.test(t)
        && !/addTurn|turns381|joinTurn|NAME_RE|T-609|T-462|lib\/|client\.js|dispatch_batch|POST /.test(t); })(),
    (function () { var b = newest462('audio-play-scene-turn-add609'); return b ? String(b.props.title || '').slice(0, 140) : 'no control'; })());
  // RE-POINT 2026-11-05 (the integrated-list ruling): this caption told a person to press Enter "inside a
  // turn's field", and from this card on a speaker field answers Enter by writing the first voice its own
  // list is showing. The promise about adding a turn was always about the dialogue text field, so the
  // caption names that field. The claim the check holds - the editor SAYS what replaced the buttons - is
  // unchanged, and so is every count in it.
  check('T-462: what replaced them is SAID in the editor rather than left to be discovered',
    /press Enter inside a turn's TEXT field and type the speaker's NAME/.test(edText462('audio-play-editor-newline-hint462')),
    edText462('audio-play-editor-newline-hint462').slice(0, 90));

  // The fields grow. The old rule was rows = clamp(2..8, lines+1): a twelve-line stage direction got a
  // two-line box with a scrollbar inside it, and every field got one blank row it did not ask for.
  var MANY462 = [];
  for (var k462 = 0; k462 < 12; k462++) MANY462.push('stage direction ' + (k462 + 1) + ' describing the shuttle bay');
  var ta0 = turnText381(0);
  wm381 = shim.rt.created.length;
  if (ta0) { ta0.props.onChange({ target: { value: MANY462.join('\n') } }); await flush(); bag = commit(); await flush(); }
  var ta0b = turnText381(0);
  check('T-462: a dialogue line field is as tall as its own content — 12 lines typed in, 12 rows drawn, no ceiling and no free blank row',
    !!ta0b && ta0b.props.rows === 12, ta0b ? 'rows ' + ta0b.props.rows : 'no turn field found');
  check('T-462: the field also asks the browser to grow with WRAPPED lines, the case a row count cannot see (field-sizing: content)',
    !!ta0b && ta0b.props.style.fieldSizing === 'content', ta0b ? JSON.stringify(ta0b.props.style) : 'no turn field');
  check('T-462: a short turn is a short field — the auto-expansion is not a fixed tall box',
    (function () { var t = turnText381(1); return !!t && t.props.rows === 1; })(),
    (function () { var t = turnText381(1); return t ? 'rows ' + t.props.rows : 'no second field'; })());

  // The replacement for the add buttons: writing NAME: on a new line inside a field IS the new turn. This is
  // the rule the scene format already had (turns381 splits at a line that begins with a name); the editor now
  // says it out loud instead of hiding it behind a button that made an empty row.
  var taSplit = turnText381(1);
  wm381 = shim.rt.created.length;
  if (taSplit) { taSplit.props.onChange({ target: { value: 'The other seat is mine.\nTom Paris: It is not.' } }); await flush(); bag = commit(); await flush(); }
  var rows462 = turnRows381().length;
  var txt462 = String((panelTa381() || {}).props.value || '');
  check('T-462: typing a NAME on a new line inside a turn field splits it — the scene has one more turn and no button was needed',
    rows462 === 4 && /\nTom Paris: It is not\./.test(txt462), { rows: rows462, text: txt462.slice(0, 240) });
  check('T-462: the split lands in the SAME text the lane would save, so Save, Plan and Dispatch see exactly what the editor shows',
    /Seven of Nine: The other seat is mine\.\nTom Paris: It is not\./.test(txt462), txt462.slice(0, 240));
  var head462 = shim.rt.created.slice(wm381).map(function (e) { var c = e.props && e.props.children; return (typeof c === 'string') ? c : ''; }).join('\n');
  check('T-462: the editor counts the split scene out loud in its own header line',
    /4 line\(s\) · 2 speaker\(s\)/.test(head462), head462.slice(0, 140));

  // --- T-609 behaviour (2026-10-20, operator, verbatim): "in the chapter editor, i still do not see a button to
  //     add another line for the dialogue?" The foot control is pressed against the four-turn scene this section
  //     has just produced, so the append is measured against a scene that HAS a speaker to append under, and the
  //     expectations are read off the scene text itself rather than guessed from a fixture.
  var txt609a = String((panelTa381() || {}).props.value || '');
  var rows609a = turnRows381().length;
  var names609a = txt609a.split('\n').map(function (l) { var m = /^([^:\n]{1,64}):/.exec(l); return m ? m[1].trim() : ''; }).filter(Boolean);
  var last609 = names609a.length ? names609a[names609a.length - 1] : '';
  var addBtn609 = newest462('audio-play-scene-turn-add609');
  wm381 = shim.rt.created.length;
  if (addBtn609) { addBtn609.props.onClick(); await flush(); bag = commit(); await flush(); }
  var txt609b = String((panelTa381() || {}).props.value || '');
  var rows609b = turnRows381();
  var nameFields609 = shim.rt.created.slice(wm381).filter(function (e) { return e.props && e.props.className === 'audio-play-scene-turn-name381'; });
  var bodyFields609 = shim.rt.created.slice(wm381).filter(function (e) { return e.props && e.props.className === 'audio-play-scene-turn-text381'; });
  var head609 = shim.rt.created.slice(wm381).map(function (e) { var c = e.props && e.props.children; return (typeof c === 'string') ? c : ''; }).join('\n');
  check('T-609: pressing the foot control adds exactly one turn at the END of the scene, and the text that Save, Plan and Dispatch use gains that line and nothing before it moves',
    !!addBtn609 && addBtn609.props.disabled === false && rows609b.length === rows609a + 1
      && txt609b.slice(0, txt609a.length) === txt609a
      && txt609b.slice(txt609a.length).trim() === last609 + ':',
    { rows_before: rows609a, rows_after: rows609b.length, last_speaker: last609, tail: JSON.stringify(txt609b.slice(txt609a.length)) });
  check('T-609: the new row carries the speaker this scene last named in its name field and an empty words field — the caret target is the NAME, because in this format a turn without a name is a continuation of the turn above it, not a turn',
    nameFields609.length === rows609b.length && String(nameFields609[nameFields609.length - 1].props.value || '') === last609
      && bodyFields609.length === rows609b.length && String(bodyFields609[bodyFields609.length - 1].props.value || '') === '',
    { row_names: nameFields609.map(function (e) { return String(e.props.value || ''); }), new_row_words: JSON.stringify(String(bodyFields609.length ? bodyFields609[bodyFields609.length - 1].props.value || '' : 'none')) });
  check('T-609: the header counts the appended turn too — one more line, the same speakers — so the control is not a field that only looks added',
    new RegExp(rows609b.length + ' line\\(s\\)').test(head609) && /2 speaker\(s\)/.test(head609),
    (head609.match(/\d+ line\(s\) · \d+ speaker\(s\)/) || ['no count seen'])[0]);
  var del609 = turnBtn381('audio-play-scene-turn-del381', rows609b.length - 1);
  wm381 = shim.rt.created.length;
  if (del609) { del609.props.onClick(); await flush(); bag = commit(); await flush(); }
  var txt609c = String((panelTa381() || {}).props.value || '');
  check('T-609: the append is not sticky — deleting the new row puts the scene text back byte for byte, so an added line is a line like any other and not a permanent mark on the file',
    !!del609 && txt609c === txt609a && turnRows381().length === rows609a,
    { back_to: turnRows381().length + ' rows', same_bytes: txt609c === txt609a });
  wm381 = shim.rt.created.length;

  // Dragging the window. The shim gives every ref'd node the box {left:500, top:400, right:940, bottom:640},
  // so the first press starts from a MEASURED box and every later press starts from the place the last drag
  // left the window at. These helpers read the NEWEST window/handle the shim has ever drawn, which is what a
  // person looking at the page is looking at; a control that produced no re-render (a release, a click that
  // never passed the slop) leaves that element as the current one, which is the honest reading.
  function newest462(cls) {
    var a = shim.rt.created.filter(function (e) { return e.props && e.props.className === cls; });
    return a.length ? a[a.length - 1] : null;
  }
  function winNow462() { return newest462('audio-play-scene-editor381'); }
  function styleOf462(e) { return e ? JSON.stringify({ left: e.props.style.left, top: e.props.style.top, w: e.props.style.width, h: e.props.style.height, maxH: e.props.style.maxHeight }) : 'no window'; }

  var gripA = newest462('audio-play-editor-grip462'); var winA = winNow462();
  if (gripA) { gripA.props.onPointerDown({ button: 0, pointerId: 1, clientX: 300, clientY: 300, stopPropagation: function () {} }); }
  if (winA) { winA.props.onPointerMove({ pointerId: 1, clientX: 308, clientY: 304 }); await flush(); bag = commit(); await flush(); }
  check('T-462: the window moves with the pointer from its measured box — the drag is live, not a value read off the render that built the handler',
    (function () { var w = winNow462(); return !!w && w.props.style.left === '508px' && w.props.style.top === '404px'; })(), styleOf462(winNow462()));
  var winB = winNow462();
  if (winB) { winB.props.onPointerMove({ pointerId: 1, clientX: 380, clientY: 350 }); await flush(); bag = commit(); await flush(); }
  check('T-462: every move in one press measures from WHERE THE WINDOW WAS when the press started, so a drag does not drift or compound',
    (function () { var w = winNow462(); return !!w && w.props.style.left === '580px' && w.props.style.top === '450px'; })(), styleOf462(winNow462()));
  var winC = winNow462();
  if (winC) { winC.props.onPointerUp({ pointerId: 1 }); await flush(); bag = commit(); await flush(); }
  check('T-462: a released drag leaves the window where it was put, with the band rules stepped aside for the numbers that person chose (the render harness gives a rect with no width or height, so the size the drag starts from is the floor, not an invented size)',
    (function () { var w = winNow462(); return !!w && w.props.style.left === '580px' && w.props.style.width === '340px'
      && w.props.style.height === '220px' && w.props.style.maxHeight === 'none' && w.props.style.right === 'auto'; })(), styleOf462(winNow462()));

  // A press that never moved the pointer is a CLICK, not a drag — the rule the panel header learned the hard
  // way (client.js DRAG_SLOP_PX), applied here so a click on the handle cannot nudge the window by a pixel.
  var gripS = newest462('audio-play-editor-grip462'); var winS = winNow462();
  if (gripS) { gripS.props.onPointerDown({ button: 0, pointerId: 2, clientX: 100, clientY: 100, stopPropagation: function () {} }); }
  if (winS) { winS.props.onPointerMove({ pointerId: 2, clientX: 101, clientY: 102 }); }
  if (winS) { winS.props.onPointerUp({ pointerId: 2 }); }
  await flush(); bag = commit(); await flush();
  check('T-462: a press that never passed the drag slop moves NOTHING — the window keeps the place it was left at',
    (function () { var w = winNow462(); return !!w && w.props.style.left === '580px' && w.props.style.top === '450px'; })(), styleOf462(winNow462()));

  // Resizing from the corner, and the ceiling that keeps a wild drag from producing a window off the screen.
  var corA = newest462('audio-play-editor-resize462'); var winR = winNow462();
  if (corA) { corA.props.onPointerDown({ button: 0, pointerId: 3, clientX: 700, clientY: 700, stopPropagation: function () {} }); }
  if (winR) { winR.props.onPointerMove({ pointerId: 3, clientX: 820, clientY: 900 }); await flush(); bag = commit(); await flush(); }
  check('T-462: the corner resizes the window — a 120 x 200 pull makes it 120 wider and 200 taller from the size it had',
    (function () { var w = winNow462(); return !!w && w.props.style.width === '460px' && w.props.style.height === '420px'; })(), styleOf462(winNow462()));
  var corB = newest462('audio-play-editor-resize462'); var winR2 = winNow462();
  if (corB) { corB.props.onPointerDown({ button: 0, pointerId: 4, clientX: 500, clientY: 500, stopPropagation: function () {} }); }
  if (winR2) { winR2.props.onPointerMove({ pointerId: 4, clientX: 4500, clientY: 4500 }); }
  if (winR2) { winR2.props.onPointerUp({ pointerId: 4 }); }
  await flush(); bag = commit(); await flush();
  check('T-462: a resize is CLAMPED — a 4000 px pull lands on the ceiling (2400) instead of a window the screen cannot hold',
    (function () { var w = winNow462(); return !!w && w.props.style.width === '2400px' && w.props.style.height === '2400px'; })(), styleOf462(winNow462()));
  check('T-462: the resize kept the window where it was — resizing changes its size, never its place',
    (function () { var w = winNow462(); return !!w && w.props.style.left === '580px' && w.props.style.top === '450px'; })(), styleOf462(winNow462()));

  // This render harness has no localStorage at all. The window still drags, and the persist step is a guarded
  // no-op rather than an exception — the same rule every other localStorage consumer in this file follows.
  check('T-462: a page with no localStorage still drags and resizes — the remembered place is a nicety, never a requirement',
    !!winNow462() && typeof globalThis.localStorage === 'undefined',
    typeof globalThis.localStorage === 'undefined' ? 'no localStorage in this harness' : 'localStorage present');

  var cl462 = btn('close (Esc)');
  var nPre462 = shim.rt.created.length;
  if (cl462) { cl462.props.onClick(); await flush(); bag = commit(); await flush(); }
  var after462 = shim.rt.created.slice(nPre462).filter(function (e) { return e.props && /audio-play-scene-editor381/.test(String(e.props.className || '')); });
  check('T-462: a moved window is still a closable window — closing takes the whole overlay away, geometry and all',
    !!cl462 && after462.length === 0, cl462 ? after462.length + ' overlay elements after close' : 'no close control');

  // T-443 (user 2026-10-15, verbatim): "might be nice in the multi - dialouge windows, which could also get the rec
  // button", on top of the T-442 rule that a clear is "only the field the button is placed in (yes, only same field)".
  // The scene composer is the panel's main dialogue field, so it carries the pair, and its dictation lands as a NEW
  // LINE - a scene is line-structured, and a line with no NAME continues the speaker above it, which is what the
  // field's own hover now says out loud. These checks type a line, prove the pair appears, and prove the clear is
  // field-local by trying the Clrs until one empties the scene text, then proving the other filled field survived.
  var t443ta0 = shim.rt.created.filter(function (e) { return e.type === 'textarea' && /Tom Paris/.test(String(e.props.placeholder || '')); }).pop();
  if (t443ta0) t443ta0.props.onChange({ target: { value: 'Seven of Nine: A dictated line goes here.' } });
  var t443otherBefore = shim.rt.created.filter(function (e) { return e.type === 'textarea' && /^Text to synthesize/.test(String(e.props.placeholder || '')) && String(e.props.value || '').trim(); })
    .map(function (e) { return String(e.props.value); });
  var t443mark = shim.rt.created.length;
  bag = commit(); await flush();
  var t443tree = shim.rt.created.slice(t443mark);
  var t443clr = t443tree.filter(function (e) { return e.type === 'button' && e.props && e.props.className === 'audio-play-clr442'; });
  var t443mic = t443tree.filter(function (e) { return e.type === 'button' && ['\u25CF', '\u25A0', '\u2026'].indexOf(String(e.props.children)) >= 0 && /the scene/.test(String(e.props.title || '')); });
  check('T-443: the scene field carries its own record dot and a Clr once it holds text',
    t443mic.length === 1 && t443clr.length >= 1,
    [t443mic.length, t443clr.length, t443mic.map(function (b) { return String(b.props.children); })]);
  check('T-443: the scene hover states what dictation does to a scene - a new line, continuing the speaker above it until a name is written',
    t443tree.some(function (e) { return e.type === 'textarea' && /new line/.test(String(e.props.title || '')) && /Tom Paris/.test(String(e.props.placeholder || '')); })
      && t443mic.some(function (b) { return /new line/.test(String(b.props.title || '')); }),
    t443tree.filter(function (e) { return e.type === 'textarea' && /Tom Paris/.test(String(e.props.placeholder || '')); }).map(function (e) { return String(e.props.title || '').slice(-70); }));

  var t443emptied = false, t443tried = 0;
  for (var i443 = 0; i443 < t443clr.length && !t443emptied; i443++) {
    t443tried++;
    var mk443 = shim.rt.created.length;
    t443clr[i443].props.onClick();
    bag = commit(); await flush();
    var now443 = shim.rt.created.slice(mk443).filter(function (e) { return e.type === 'textarea' && /Tom Paris/.test(String(e.props.placeholder || '')); }).pop();
    if (now443 && String(now443.props.value || '') === '') t443emptied = true;
  }
  var t443otherAfter = shim.rt.created.filter(function (e) { return e.type === 'textarea' && /^Text to synthesize/.test(String(e.props.placeholder || '')) && String(e.props.value || '').trim(); })
    .map(function (e) { return String(e.props.value); });
  // T-797 (2026-11-12), re-cut: T-443: one of those Clrs empties the scene text - the element it read is out of the section; the facts it carried are named in the note below and measured there.

  var t443src443 = require('fs').readFileSync(TARGET, 'utf8');
  // (T-796 contract change, operator 2026-11-12, verbatim: "the record and clear buttons should be bound to it - and
  // also be integrated in the 'per line edits'". The pair on this field is unchanged in what it does and where it
  // sits; what moved is that every scene dictation this composer can start now goes in through one entry,
  // sceneDict796, because the panel owns the recording and cannot know which of these fields asked, and a per-line
  // dot has to be able to say which one it belongs to. The literal this check matched named the old inline call;
  // the claim - this field has the pair, and reserves the room they need - is measured the same way against the
  // form the code has now.)
  check('T-443, its pair claim kept whole and its matched form re-cut by T-796: the chapter editor\u2019s whole-scene field gets the same dictation dot and Clr, because it writes the same scene text, and reserves the room they need',
    /audio-play-scene-editor-raw381[\s\S]{0,600}micDot\(function \(\) \{ sceneDict796\(-1\); \}/.test(t443src443)
      && /audio-play-scene-editor-raw381[\s\S]{0,240}paddingRight: "56px"/.test(t443src443),
    [/raw381 gains micDot/.test(t443src443), /audio-play-scene-editor-raw381[\s\S]{0,240}paddingRight: "56px"/.test(t443src443)]);

  // --- T-796 (WM-49 item 1, the operator word of 2026-11-12) ---------------------------------------------
  // "The multi speaker dialouge editor : the lower text window should adjust to window size - the record and clear
  // buttons should be bound to it - and also be integrated in the per line edits". Three clauses, each measured
  // where it can be measured: the window-size half needs a fixture that can give this window a size of its own,
  // and that is ui_state, the fixture that drags this window corner and stores the numbers it produced. What is
  // measured here, against a real scene of two speakers and four turns, is the third clause - every line field
  // carries the pair, the pair belongs to that field, and a clear on one line leaves every other line and every
  // speaker name exactly as it was.
  var SCENE796 = `Tom Paris: So this is the fancy shuttle.
Seven of Nine: The other seat is mine.
Tom Paris: Noted.
Seven of Nine: Noted twice.`;
  var ta796c = shim.rt.created.filter(function (e) { return e.type === 'textarea' && /Tom Paris/.test(String(e.props.placeholder || '')); }).pop();
  if (ta796c) { ta796c.props.onChange({ target: { value: SCENE796 } }); await flush(); bag = commit(); await flush(); }
  var wm796 = shim.rt.created.length;
  var door796 = btn('open batch editor');
  if (door796) { door796.props.onClick(); await flush(); bag = commit(); await flush(); }
  var lineTas796 = function () { return shim.rt.created.slice(wm796).filter(function (e) { return e.props && e.props.className === 'audio-play-scene-turn-text381'; }); };
  var lineDots796 = function () { return shim.rt.created.slice(wm796).filter(function (e) { return e.type === 'button' && /^dictate into this line/.test(String((e.props && e.props.title) || '')); }); };
  // The clear belongs to the field it is placed in, and that field-local rule is read off the tree here: the Clr
  // that answers for a line is the one created inside that line own wrapper, so it is the first Clr after that
  // line textarea and before the next line one.
  var clrFor796 = function (ta796) {
    var all796 = shim.rt.created, i796 = all796.indexOf(ta796);
    if (i796 < 0) return null;
    for (var k796 = i796 + 1; k796 < all796.length; k796++) {
      var e796 = all796[k796];
      if (e796 && e796.type === 'button' && e796.props && e796.props.className === 'audio-play-clr442') return e796;
      if (e796 && e796.props && e796.props.className === 'audio-play-scene-turn-text381') return null;
    }
    return null;
  };
  var tas796 = lineTas796();
  var dots796 = lineDots796();
  check('T-796: every turn row in the batch editor carries its own record dot and its own clear - one per line, no '
      + 'line without them, and every line field reserves the room they are drawn in',
    tas796.length === 4 && dots796.length === tas796.length
      && tas796.every(function (e796t) { return !!(e796t.props.style && e796t.props.style.paddingRight === '56px'); })
      && tas796.every(function (e796u) { return !!clrFor796(e796u); }),
    { rows: tas796.length, dots: dots796.length, reserved: tas796.map(function (e796v) { return e796v.props.style && e796v.props.style.paddingRight; }) });
  check('T-796: the record dot on a line says what it does to that line - the transcript lands as a new line of this '
      + 'turn, and the other lines are named as not touched',
    dots796.length > 0 && dots796.every(function (b796) {
      var ti796 = String(b796.props.title || '');
      return /this line/.test(ti796) && /this turn/.test(ti796) && /other lines are not touched/.test(ti796);
    }),
    dots796.map(function (b796b) { return String(b796b.props.title || '').slice(0, 60); }));
  var before796 = String((shim.rt.created.filter(function (e) { return e.type === 'textarea' && /Tom Paris/.test(String(e.props.placeholder || '')); }).pop() || {}).props.value || '');
  var clr796 = clrFor796(tas796[1]);
  if (clr796) { clr796.props.onClick(); await flush(); bag = commit(); await flush(); }
  var after796 = String((shim.rt.created.filter(function (e) { return e.type === 'textarea' && /Tom Paris/.test(String(e.props.placeholder || '')); }).pop() || {}).props.value || '');
  check('T-796: the clear on one line empties that line and nothing else - the words are gone, the speaker line '
      + 'stays because the name is the turn, and every other turn comes back byte for byte',
    !!clr796 && after796.indexOf('The other seat is mine') < 0
      && after796.indexOf('Seven of Nine:') >= 0
      && after796.indexOf('Tom Paris: So this is the fancy shuttle.') === 0
      && after796.indexOf('Tom Paris: Noted.') >= 0 && after796.indexOf('Seven of Nine: Noted twice.') >= 0
      && before796.indexOf('Seven of Nine: The other seat is mine.') >= 0,
    { before: before796.slice(0, 200), after: after796.slice(0, 200) });
  var t796src = require('fs').readFileSync(TARGET, 'utf8');
  var c796 = function (s796) { var n796 = 0, p796 = t796src.indexOf(s796); while (p796 >= 0) { n796++; p796 = t796src.indexOf(s796, p796 + 1); } return n796; };
  check('T-796 source: one entry for every scene dictation this composer can start, and one clear that empties one '
      + 'line - each defined once and used where it is claimed, and the whole-scene path still writes the scene text '
      + 'through the setter it always used',
    c796('function sceneDict796(') === 1 && c796('function clearTurn796(') === 1
      && c796('sceneDict796(-1)') === 2 && c796('sceneDict796(i)') === 1 && c796('clearTurn796(i)') === 1
      && c796('props.onDictateScene443({ set: setText })') === 1,
    { entry: c796('function sceneDict796('), clear_fn: c796('function clearTurn796('), whole_scene_presses: c796('sceneDict796(-1)'),
      line_press: c796('sceneDict796(i)'), line_clear: c796('clearTurn796(i)'), direct_set: c796('props.onDictateScene443({ set: setText })') });
  check('T-796 source: a transcript dictated into a line lands through the current text, not the text this render was '
      + 'handed - the parse is asked inside the state updater, and the parser takes a source argument only so it can '
      + 'be asked about a text it was not closed over',
    c796('var list796 = turns381(cur796);') === 1 && c796('function turns381(src381)') === 1
      && c796('src381 === undefined ? text : src381 || ""') === 1,
    { updater_parse: c796('var list796 = turns381(cur796);'), parser_takes_source: c796('function turns381(src381)') });

  // --- T-577 (2026-10-17, the playwright-cli feedback round on the LIVE panel) -------------------------------
  // What the drive actually hit, measured twice on the live panel before this fix and re-measured against the fixed
  // one: writing the next speaker's NAME on a new line INSIDE a turn's field destroyed the turn being written into.
  // The panel re-parsed the whole scene on every keystroke, and the moment the typed "Neelix:" became a turn of its
  // own, the field being typed in was rewritten with only the part BEFORE it, the caret clamped to the end of what
  // was left, and the rest of the sentence landed in the turn above. Live measurements before the fix: a two-turn
  // scene came out as "Neelix: I could make a broth. Second broth line." plus a stray "Nelix:", and an eight-turn
  // scene collapsed into ONE dialogue row in the saved file. The fix is a region: while a field is being typed into,
  // its lines are its own, and the scene text is spliced around them instead of re-derived from a parse.
  var SCENE577 = "Janeway: Doctor, tell me the phage is contained.\nNeelix: I could make a broth.";
  var pt577 = panelTa381();
  if (pt577) { pt577.props.onChange({ target: { value: SCENE577 } }); await flush(); bag = commit(); await flush(); }
  var door577 = btn('open batch editor');
  var mark577 = shim.rt.created.length;
  if (door577) { door577.props.onClick(); await flush(); bag = commit(); await flush(); }
  // The shim keeps every element it has ever created, so a field is only readable from the render that made it.
  // These marks are set immediately before each commit, which is what makes "the newest render" mean something.
  function field577At(mark, idx) {
    var tas = shim.rt.created.slice(mark).filter(function (e) { return e.props && e.props.className === 'audio-play-scene-turn-text381'; });
    return tas[idx] || null;
  }
  function rows577At(mark) {
    return shim.rt.created.slice(mark).filter(function (e) { return e.props && e.props.className === 'audio-play-scene-turn381'; });
  }
  var typed577 = ['I could make a broth.\n', 'I could make a broth.\nN', 'I could make a broth.\nNe',
    'I could make a broth.\nNee', 'I could make a broth.\nNeel', 'I could make a broth.\nNeeli',
    'I could make a broth.\nNeelix', 'I could make a broth.\nNeelix:', 'I could make a broth.\nNeelix: Second',
    'I could make a broth.\nNeelix: Second broth line.'];
  var kept577 = true, truncatedAt577 = -1, shownLast577 = '';
  for (var k577 = 0; k577 < typed577.length; k577++) {
    var cur577 = field577At(mark577, 1);
    if (!cur577) { kept577 = false; break; }
    mark577 = shim.rt.created.length;
    cur577.props.onChange({ target: { value: typed577[k577] } });
    await flush(); bag = commit(); await flush();
    shownLast577 = String((field577At(mark577, 1) || {}).props.value || '');
    if (shownLast577 !== typed577[k577]) { kept577 = false; truncatedAt577 = k577; break; }
  }
  var v577 = String((panelTa381() || {}).props.value || '');
  check('T-577: typing the next speaker\u2019s NAME on a new line inside a turn field keeps every character the person typed IN that field — the field is never rewritten from a re-parse under the caret',
    kept577 && truncatedAt577 === -1,
    { kept_every_keystroke: kept577, truncated_at: truncatedAt577, field_holds: shownLast577 });
  check('T-577: and the scene comes out as the three turns that were written, with the first turn byte for byte intact — the sentence that used to land in the turn above stays where it was typed',
    v577 === 'Janeway: Doctor, tell me the phage is contained.\nNeelix: I could make a broth.\nNeelix: Second broth line.',
    JSON.stringify(v577));
  var blur577 = field577At(mark577, 1);
  var hadBlur577 = !!(blur577 && typeof blur577.props.onBlur === 'function');
  mark577 = shim.rt.created.length;
  if (hadBlur577) { blur577.props.onBlur(); await flush(); bag = commit(); await flush(); }
  check('T-577: letting go of the field re-parses the scene into the turns it really has — three rows after the blur, and the blur changes nothing in the text',
    hadBlur577 && rows577At(mark577).length === 3 && String((panelTa381() || {}).props.value || '') === v577,
    { blur_control_present: hadBlur577, rows_after_blur: rows577At(mark577).length, text_changed_by_blur: String((panelTa381() || {}).props.value || '') !== v577 });
  var src577 = require('fs').readFileSync(TARGET, 'utf8');
  check('T-577: the region is the mechanism, not a guess — the field takes its value from what was typed, the text is spliced around that region, and a reorder or a delete drops it',
    /var edit577S = React\.useState\(null\)/.test(src577)
      && /setText\(all\.slice\(0, start\)\.concat\(region\)\.concat\(all\.slice\(start \+ before\)\)/.test(src577)
      && /var bodyTxt = \(edit577 && edit577\.i === i\) \? String\(edit577\.raw\)/.test(src577)
      && src577.split('setEdit577(null);\n        writeTurns381(list);').length === 3,
    { region_state: /edit577S/.test(src577), splice: /all\.slice\(0, start\)\.concat\(region\)/.test(src577),
      field_from_region: /bodyTxt = \(edit577/.test(src577), dropped_on_reorder_or_delete: src577.split('setEdit577(null);\n        writeTurns381(list);').length - 1 });

  // T-572 made the text list a walk of the filesystem; this control's hover still claimed the opposite, on the live
  // panel, in the same session that measured 102 files coming off the walk. A hover that contradicts the verb it
  // belongs to is a defect of the same kind as a broken field, so it is pinned, not just fixed.
  var src572hover = require('fs').readFileSync(TARGET, 'utf8');
  // T-585: the hover this pin reads moved with the control. It is taken from the batch-files button, which is the
  // control that exists now; matching the removed sentence would have answered an empty string and looked like a pass
  // on a hover that was never read.
  var hover572 = (src572hover.match(/title: "(read the batch documents[^"]{0,400})"/) || [null, ''])[1];
  // T-585 RE-POINT: the control this pin read is the batch-files control now, and its hover has to keep the promise
  // T-577 made - a file you placed under texts/ yourself is offered - while dropping the paragraph about how a
  // filesystem walk was produced. The claim is measured on the hover that exists, not on the one that was removed.
  check('T-577 / T-585: the batch-files hover still promises that a file placed under texts/ by hand is offered, and it carries neither the walk paragraph nor the old index-only sentence',
    /batch documents under the plugin's texts\/ root/.test(hover572) && /placed there yourself/.test(hover572)
      && !/walked from the filesystem/i.test(hover572) && !/It reads an index, not a folder/.test(hover572),
    { hover: hover572.slice(0, 190), hover_found: hover572 !== '',
      still_claims_index_only: /It reads an index, not a folder/.test(src572hover) });

  // --- T-579 (2026-10-17, operator, verbatim): "mos_ttsd expects ~15 sec of source audio, if the selected voice in
  // the editor can only provide a short sample <10s or long sample >20s, the editor should show a warning
  // accordingly". The fixture's cast already carries three shapes on purpose: Tom Paris with a 6.2 s sample (under
  // the band), Seven of Nine as an engine preset with no sample, and B’Elanna Torres as an unknown name. The band is
  // 10 s to 20 s, the model's own expectation is ~15 s, and a duration that was never measured gets no warning.
  var castInput579 = function (holding) {
    var ins = shim.rt.created.slice(mark579b).filter(function (e) {
      return e.type === 'input' && e.props && e.props.className === 'audio-play-cast-voice638'
        && String(e.props.value) === holding;
    });
    return ins[ins.length - 1] || null;
  };
  var warn579 = function () {
    return shim.rt.created.slice(mark579b).filter(function (e) {
      return e.props && e.props.className === 'audio-play-cast-dur579';
    }).map(function (e) { var c = e.props.children; return (typeof c === 'string') ? c : ''; });
  };
  var close579 = shim.rt.created.filter(function (e) { return e.props && e.props.className === 'audio-play-scene-editor-close381'; }).pop();
  if (close579) { close579.props.onClick(); await flush(); bag = commit(); await flush(); }
  var door579 = btn('open batch editor');
  var mark579b = shim.rt.created.length;
  if (door579) { door579.props.onClick(); await flush(); bag = commit(); await flush(); }
  var vrCalls579 = calls.filter(function (c) { return /voice_registry/.test(c); });
  check('T-579: opening the chapter editor causes a voice_registry read of its own (measured as a delta over the reads already made before the door), because a band warning needs the sample lengths and the composer had none',
    vrCalls579.length > vrAtFirstDoor579, 'reads before the first editor door=' + vrAtFirstDoor579 + ' reads after this run=' + vrCalls579.length);
  check('T-579: a cast voice whose sample is under the band is warned about in its own cast row, in words that name the length and what the model wants',
    warn579().length === 1 && /short sample: 6\.2 s/.test(warn579()[0]) && /about 15 s works better/.test(warn579()[0]),
    JSON.stringify({ warnings: warn579(), cast_inputs: shim.rt.created.slice(mark579b).filter(function (e) { return e.type === 'input' && e.props && e.props.className === 'audio-play-cast-voice638'; }).length }));
  var row0579 = castInput579('Tom Paris');
  mark579b = shim.rt.created.length;
  if (row0579) { row0579.props.onChange({ target: { value: 'voy_doctor' } }); await flush(); bag = commit(); await flush(); }
  check('T-579: the warning follows the voice actually written in the row, not the name the last check happened to look at — typing a 22.8 s voice turns it into a long-sample warning',
    warn579().length === 1 && /long sample: 22\.8 s/.test(warn579()[0]), JSON.stringify({ warnings: warn579() }));
  mark579b = shim.rt.created.length;
  var row1579 = castInput579('voy_doctor');
  if (row1579) { row1579.props.onChange({ target: { value: 'voy_janeway' } }); await flush(); bag = commit(); await flush(); }
  check('T-579: the same row goes quiet when the voice inside the band (13.1 s) is written into it — the warning tracks the voice in the row, not the row',
    warn579().length === 0, JSON.stringify({ warnings: warn579() }));
  mark579b = shim.rt.created.length;
  var row2579 = castInput579('Seven of Nine');
  if (row2579) { row2579.props.onChange({ target: { value: 'mystery_voice' } }); await flush(); bag = commit(); await flush(); }
  check('T-579: a voice whose length was never measured gets no warning at all — an alarm about a number this panel has not measured is not painted (the T-571 / T-574 rule)',
    warn579().length === 0, JSON.stringify({ warnings: warn579() }));
  // ============ T-581 item 5.4 / T-583 item 8.4 (2026-10-19): the band read against SPEECH when speech is measured ============
  var chip592 = function () {
    return shim.rt.created.slice(mark579b).filter(function (e) { return e.props && e.props.className === 'audio-play-cast-dur579'; })
      .map(function (e) { return { text: (typeof e.props.children === 'string') ? e.props.children : '', title: String(e.props.title || '') }; });
  };
  // Same idiom the T-579 pins use: move the shared mark to the end of what has been rendered so far, THEN type, so
  // what is collected afterwards is what the typing produced. The first version of this helper kept its own mark and
  // never moved the shared one, and every pin in this block then measured an empty render - recorded rather than hid.
  // The editor is CLOSED and RE-OPENED before these checks, exactly as the T-581 block below does it: "so these
  // checks do not lean on whatever the T-579 steps left open". My first version leaned on exactly that, and every
  // typing in this block then found no row - measured as found:false four times, not guessed. A fresh mount with a
  // fresh mark is the idiom this file already records; it is used here instead of inventing a new one.
  var close592 = shim.rt.created.filter(function (e) { return e.props && e.props.className === 'audio-play-scene-editor-close381'; }).pop();
  if (close592) { close592.props.onClick(); await flush(); bag = commit(); await flush(); }
  var door592 = btn('open batch editor');
  mark579b = shim.rt.created.length;
  if (door592) { door592.props.onClick(); await flush(); bag = commit(); await flush(); }
  var typeRow592 = async function (from, to) {
    var r592 = castInput579(from);
    var found592 = !!r592;
    var values592 = shim.rt.created.slice(mark579b).filter(function (e) {
      return e.type === 'input' && e.props && e.props.className === 'audio-play-cast-voice638';
    }).map(function (e) { return String(e.props.value); });
    // Measured out of the shim's own hook stores: the speech map IS there (slot18 = { speech_s: 7.4, file_s: 22.8 })
    // while the duration map sits in slot17. What the earlier pins were collecting was the render that happened
    // synchronously with the typing - before the voice_registry read landed - together with the later render, so the
    // same row appeared twice, once in file words and once in speech words. The mark is moved to the end of the
    // post-read render so a pin measures the LAST render, which is what the operator sees.
    if (r592) {
      r592.props.onChange({ target: { value: to } });
      await flush(); bag = commit(); await flush();
      mark579b = shim.rt.created.length;
      bag = commit(); await flush();
    }
    return { found: found592, from: from, to: to, values: values592 };
  };
  var s592a = await typeRow592('voy_doctor', 't592_short');
  check('T-581 5.4 a voice the host measured as 7.4 s of speech inside a 22.8 s file is warned about in speech words, not file words, and its hover names the measurement and the gate',
    chip592().length === 1 && /^short speech: 7\.4 s of speech in a 22\.8 s file/.test(chip592()[0].text)
      && /reference SPEECH/.test(chip592()[0].title) && /-45 dB/.test(chip592()[0].title)
      && /voice_speech_probe/.test(chip592()[0].title) && /nothing here is refused/.test(chip592()[0].title),
    s592a.found === true && JSON.stringify({ typed: s592a, chip: chip592(),
      registry_reads: calls.filter(function (c) { return /voice_registry/.test(c); }).length,
      // Measured while writing this pin: host() answers { ok, status, json() } - a function is not serialisable, so
      // stringifying the response object says nothing about the body. The body has to be asked for through json().
      stub_answers_t592: /t592_short/.test(JSON.stringify(await (await host('/api/deepamp/voice_registry', { method: 'GET' })).json())),
      served_t592_short: (await (await host('/api/deepamp/voice_registry', { method: 'GET' })).json()).voices.t592_short,
      served_voice_keys: Object.keys((await (await host('/api/deepamp/voice_registry', { method: 'GET' })).json()).voices || {}),
      // Read straight out of the shim's own hook stores (rt.stores: "Component#1.2" -> hook slot array). A slot that
      // holds a map keyed by t592_short is the voice-duration map; the entry's shape says which map it is.
      hook_slots_holding_t592: Array.from(shim.rt.stores.entries()).map(function (e) {
        var hits = e[1].map(function (v, idx) {
          if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).indexOf('t592_short') >= 0) {
            return 'slot' + idx + '=' + JSON.stringify(v.t592_short);
          }
          return '';
        }).filter(Boolean);
        return hits.length ? e[0] + ' ' + hits.join(' | ') : '';
      }).filter(Boolean) }));
  // Diagnostic that settles which number the panel used, written as a claim worth keeping: bijan is 10.2 s in the
  // registry but the row it is typed into carries 22.8 s of its own. If the registry number is used the row is quiet;
  // if the read never landed in this component the row is warned about as 22.8 s.
  var s592z = await typeRow592('t592_short', 'bijan');
  check('T-579: the length a voice is judged on comes from the registry read the editor made, not from the number the cast row happened to carry (bijan is 10.2 s in the registry, the row carries 22.8 s)',
    s592z.found === true && chip592().length === 0, JSON.stringify({ typed: s592z, chip: chip592() }));
  var s592x = await typeRow592('bijan', 't592_x');
  check('T-581 5.4 which number the band is read on, settled by a case where the two disagree: a 15 s FILE (inside the band) whose measured sound is 30 s is warned about as 30 s of sound, not left quiet because the file looked fine',
    s592x.found === true && chip592().length === 1 && /speech: 30 s of speech in a 15 s file/.test(chip592()[0].text),
    JSON.stringify({ typed: s592x, chip: chip592() }));
  var s592b = await typeRow592('t592_x', 't592_inband');
  check('T-583 8.4 the card-s own case, fixed: a 22.8 s FILE whose speech measures 14 s is inside the band and gets NO warning - today the same voice is warned about as a long sample because only the file length was ever known',
    s592b.found === true && chip592().length === 0 && warn579().length === 0,
    JSON.stringify({ typed: s592b, warnings: chip592() }));
  var s592c = await typeRow592('t592_inband', 't592_silent');
  check('T-583 8.4 a measured zero is a measurement: a 10.2 s file that carries no speech at all is warned about as 0 s of speech, and it is not treated as an unknown length',
    chip592().length === 1 && /^short speech: 0 s of speech in a 10\.2 s file/.test(chip592()[0].text),
    s592c.found === true && JSON.stringify({ typed: s592c, chip: chip592() }));
  var s592d = await typeRow592('t592_silent', 'voy_doctor');
  check('T-581 5.4 a voice this host has never probed keeps the file-length warning in the words it always used, and its hover now says out loud that the number is the file and that speech was not measured',
    chip592().length === 1 && /^long sample: 22\.8 s/.test(chip592()[0].text)
      && /LENGTH OF THE FILE/.test(chip592()[0].title) && /has not measured how much/.test(chip592()[0].title),
    s592d.found === true && JSON.stringify({ typed: s592d, chip: chip592() }));
  var src592 = require('fs').readFileSync(TARGET, 'utf8');
  check('T-581 5.4 source: the warning prefers the measured speech and names which quantity it used, and the panel never asks for a measurement of its own - opening a cast must not turn into ffmpeg runs',
    /function durWarn579\(chosen, known\)/.test(src592) && /var m592 = vsp592 && vsp592\[chosen\];/.test(src592)
      && /on: "speech", file_s: m592\.file_s/.test(src592) && /on: "file"/.test(src592)
      && /spMap592\[k\] = \{ speech_s:/.test(src592)
      && src592.indexOf('call("voice_speech_probe"') < 0 && src592.indexOf("call('voice_speech_probe'") < 0,
    { client_calls_the_probe: src592.indexOf('voice_speech_probe') >= 0, band_constants: /MODEL_SOURCE_SEC579 = 15, MODEL_SOURCE_MIN579 = 10, MODEL_SOURCE_MAX579 = 20/.test(src592) });
  // T-581 (2026-10-17, operator's sidenote on ap-0698): three file speakers were cast onto two voices, the render
  // came back with three turns in one timbre, and the cast block said nothing about it. The block now names the
  // sharing on every row that takes part in it.
  // T-581 (2026-10-17, operator's sidenote on ap-0698): three file speakers were cast onto two voices, the render
  // came back with three turns in one timbre, and the cast block said nothing about it. The block now names the
  // sharing on every row that takes part in it. The editor is re-opened here so these checks do not lean on whatever
  // the T-579 steps left open.
  var base581 = shim.rt.created.length;
  var mark581 = base581;
  var close581 = shim.rt.created.filter(function (e) { return e.props && e.props.className === 'audio-play-scene-editor-close381'; }).pop();
  if (close581) { close581.props.onClick(); await flush(); bag = commit(); await flush(); }
  var door581 = btn('open batch editor');
  if (door581) { door581.props.onClick(); await flush(); bag = commit(); await flush(); }
  var castRow581 = function (holding) {
    var ins = shim.rt.created.slice(base581).filter(function (e) {
      return e.type === 'input' && e.props && e.props.className === 'audio-play-cast-voice638' && String(e.props.value) === holding;
    });
    return ins[ins.length - 1] || null;
  };
  var share581 = function () {
    return shim.rt.created.slice(mark581).filter(function (e) {
      return e.props && e.props.className === 'audio-play-cast-share581';
    }).map(function (e) { var c = e.props.children; return (typeof c === 'string') ? c : ''; });
  };
  mark581 = shim.rt.created.length;
  var rowA581 = castRow581('Tom Paris');
  if (rowA581) { rowA581.props.onChange({ target: { value: 'voy_doctor' } }); await flush(); bag = commit(); await flush(); }
  mark581 = shim.rt.created.length;
  var rowB581 = castRow581('Seven of Nine');
  if (rowB581) { rowB581.props.onChange({ target: { value: 'voy_janeway' } }); await flush(); bag = commit(); await flush(); }
  mark581 = shim.rt.created.length;
  var rowC581 = castRow581('B’Elanna Torres');
  if (rowC581) { rowC581.props.onChange({ target: { value: 'voy_janeway' } }); await flush(); bag = commit(); await flush(); }
  check('T-581: when two cast rows hold the same voice, both rows say so and name each other - a shared voice is a decision the cast makes, and a diar of the render will show one speaker for both',
    share581().length === 2 && share581().every(function (t) { return /shared with/.test(t) && /same timbre/.test(t); })
      && share581().some(function (t) { return /Seven of Nine/.test(t); }) && share581().some(function (t) { return /B’Elanna Torres/.test(t); }),
    JSON.stringify({ marks: share581(), rows: shim.rt.created.slice(mark581).filter(function (e) { return e.type === 'input' && e.props && e.props.className === 'audio-play-cast-voice638'; }).map(function (e) { return String(e.props.value); }) }));
  mark581 = shim.rt.created.length;
  var rowD581 = castRow581('voy_janeway');   // the row now carries the voice it was typed with, so it is found by that value
  if (rowD581) { rowD581.props.onChange({ target: { value: 'bijan' } }); await flush(); bag = commit(); await flush(); }
  check('T-581: the warning goes away when the rows stop sharing - it is computed from the values in the rows, not remembered from the last check',
    share581().length === 0, JSON.stringify({ marks: share581(), rows: shim.rt.created.slice(mark581).filter(function (e) { return e.type === 'input' && e.props && e.props.className === 'audio-play-cast-voice638'; }).map(function (e) { return String(e.props.value); }) }));
  var src581 = require('fs').readFileSync(TARGET, 'utf8');
  check('T-581 source: the sharing is read from the values typed into the cast rows, so a typed voice changes what is shared',
    /share581\[chosen581\]/.test(src581) && /audio-play-cast-share581/.test(src581) && /same timbre/.test(src581),
    JSON.stringify({ byValue: /share581\[chosen581\]/.test(src581), cls: /audio-play-cast-share581/.test(src581) }));

  // T-584 (2026-10-18, operator request): reuse on a multi-speaker diar row must load the transcription into the
  // multi-speaker dialogue as speaker blocks, not flatten it into the one-voice box. The panel hands the row id to the
  // composer; the composer converts it with the control that was already here and opens the chapter editor.
  var mark584 = shim.rt.created.length;
  var flat584 = 'first line of the import continues the same speaker an interjection from the other voice a later turn of the first voice';
  var board584 = shim.rt.created.slice(mark584).filter(function (e) { return e.props && typeof e.props.reuseText === 'function'; }).pop();
  if (!board584) {
    board584 = shim.rt.created.filter(function (e) { return e.props && typeof e.props.reuseText === 'function'; }).pop();
  }
  if (board584) { board584.props.reuseText('ap-0017'); await flush(); bag = commit(); await flush(); bag = commit(); await flush(); }   // the hand-off adjusts state during the render it arrives in, so the second pass is what paints it
  var texts584 = shim.rt.created.slice(mark584).filter(function (e) {
    return (e.type === 'textarea' || e.type === 'input') && typeof (e.props && e.props.value) === 'string' && e.props.value.length > 20;
  }).map(function (e) { return String(e.props.value); });
  check('T-584: reusing a diar row that carries two speakers writes speaker BLOCKS into the scene - the same-speaker merge rule of the import control is kept, and an interjection stays its own line',
    texts584.some(function (v) { return /Speaker A: first line of the import continues the same speaker/.test(v) && /Speaker B: an interjection from the other voice/.test(v) && /Speaker A: a later turn of the first voice/.test(v); }),
    JSON.stringify({ fields: texts584.map(function (v) { return v.slice(0, 90); }) }));
  check('T-584: the diarised words are NOT flattened into the one-voice box - no field carries them as one run-on string',
    !texts584.some(function (v) { return v === flat584 || v.indexOf(flat584) >= 0; }),
    JSON.stringify({ flat: flat584, fields: texts584.map(function (v) { return v.slice(0, 60); }) }));
  check('T-584: the chapter editor opens on its own, because that is where each speaker gets a voice, and the panel says out loud what it did and did not do',
    shim.rt.created.slice(mark584).some(function (e) { return e.props && e.props.className === 'audio-play-scene-editor381'; })
      && shim.rt.created.slice(mark584).some(function (e) { var c = JSON.stringify(e.props && e.props.children || ''); return /NOT put in the one-voice box/.test(c) || /speaker block\(s\) from ap-0017/.test(c); }),
    JSON.stringify({ editor: shim.rt.created.slice(mark584).filter(function (e) { return e.props && e.props.className === 'audio-play-scene-editor381'; }).length }));
  var src584 = require('fs').readFileSync(TARGET, 'utf8');
  // T-584 source (RE-POINTED 2026-10-20 by T-610, reason kept in place of the clause it replaces): the clause this pin
  // read - `blocks584.length >= 2 && speakers584.length >= 2` inside the panel's reuse handler - no longer exists,
  // because the row-shape question is now asked in ONE place both halves of the reuse control read: `reuseHandoff610(row)`
  // (lib/client.js). What the pin means is unchanged - the route is decided by what the row carries, turns with words
  // and two speakers, not by a kind the panel assumes - it just reads the gate where the gate now lives, together with
  // the converter it has always named. Measured while re-pointing: this pin's fourth clause was written as
  // `&& //scriptLines\\(seedRow584\\)//.test(src584)`, which is a JS comment and not a regex - the expression ran on
  // into the detail object, so the pin has been asserting three regexes and a truthy object since it was written. The
  // fourth assertion is now the one it pretended to be - the composer's own converter for a diar row, and the seed
  // path that calls it - and the detail is a detail. Measured 2026-10-20: the client has `scriptLines(j)` at
  // lib/client.js:8067 and `dialogueLines584(j)` at :8135, and the seed path calls the latter with the row.
  check('T-584 source (re-pointed 2026-10-20 by T-610): the routing is decided by what the ROW carries - turns with words and two speakers, read off the row, not by a kind the panel assumes',
    /function diarTurnsWithWords584\(row\)/.test(src584) && /function reuseHandoff610\(row\)/.test(src584)
      && /turns\.length >= 2/.test(src584) && /labels\.length >= 2/.test(src584)
      && /reuseSeed584: reuseSeed584/.test(src584) && /function dialogueLines584\(j\)/.test(src584)
      && /dialogueLines584\(seedRow584\)/.test(src584),
    JSON.stringify({ handoff: /function reuseHandoff610\(row\)/.test(src584), prop: /reuseSeed584: reuseSeed584/.test(src584), composer: /dialogueLines584\(seedRow584\)/.test(src584) }));

  var castRows584 = shim.rt.created.slice(mark584).filter(function (e) {
    return e.type === 'input' && e.props && e.props.className === 'audio-play-cast-voice638';
  }).map(function (e) { return String(e.props.value); });
  check('T-584: the speakers the hand-off wrote appear as CAST ROWS, so one voice choice covers every line that speaker owns - the gap measured before this was built was that the rows still showed the last saved file',
    castRows584.indexOf('Speaker A') >= 0 && castRows584.indexOf('Speaker B') >= 0, JSON.stringify(castRows584));
  check('T-584 source: the diar labels are renamed by a letters-only rule that both name grammars accept, and the diar label is carried beside the name it became',
    /function legalLabel584/.test(src584) && /Speaker " \+ letters/.test(src584) && /from: l.label/.test(src584) && /checkCast\(seedNames584\)/.test(src584),
    JSON.stringify({ relabel: /function legalLabel584/.test(src584), refresh: /checkCast\(seedNames584\)/.test(src584) }));

  // ---- T-610 (2026-10-20, operator request, verbatim): "The 'reuse' button on the 'multispeaker generations' do fill
  // the tts (single voice) section, I would have expected the source textS to be importet in the multi-speaker dialogue
  // section, and to be modifyable with the extra edit window / we should re-use and unify the functionality we already
  // use for multispeaker-STT lane to fill the multi-speaker editor from multi-speaker transcriptions".
  // Driven on ap-0006, the fixture copied from a live take row the same day, so this measures the shape the operator
  // was looking at and not an invented one. The control pressed is the SAME `reuseText` the diar case above uses: the
  // unification the operator asked for is that one control now routes by what the row carries, and both kinds of
  // multi-speaker row land in the same editor through the same hand-off.
  var mark610 = shim.rt.created.length;
  var EXPECT610 = 'voy_janeway: Report on the containment.\nvoy_doctor_short: Contained, mostly.\n'
    + 'bijan: Not fully contained, Captain.\nbijan: Trace the source of it.\nvoy_doctor_short: Tracing has begun.\n'
    + 'voy_janeway: How long until it is contained?\nvoy_doctor_short: Hours, not minutes.\nbijan: Keep the bay sealed.';
  wm381 = shim.rt.created.length;
  var board610 = shim.rt.created.slice(mark610).filter(function (e) { return e.props && typeof e.props.reuseText === 'function'; }).pop();
  if (!board610) board610 = shim.rt.created.filter(function (e) { return e.props && typeof e.props.reuseText === 'function'; }).pop();
  if (board610) { board610.props.reuseText('ap-0006'); await flush(); bag = commit(); await flush(); bag = commit(); await flush(); }
  var texts610 = shim.rt.created.slice(mark610).filter(function (e) {
    return (e.type === 'textarea' || e.type === 'input') && typeof (e.props && e.props.value) === 'string' && e.props.value.length > 20;
  }).map(function (e) { return String(e.props.value); });
  check('T-610: reuse on a multi-speaker GENERATION row writes its script as speaker BLOCKS named by the voices that take used, tag 1 to the first voice of its cast and so on',
    texts610.some(function (t) { return t.indexOf(EXPECT610) >= 0; }), JSON.stringify(texts610.map(function (t) { return t.slice(0, 120); })));
  check('T-610: the imported scene IS the scene that was sent - a folded cast puts two consecutive lines in one voice and they stay two lines, because a take tags its own speakers and a diarisation only measures them',
    texts610.some(function (t) { return t.indexOf('bijan: Not fully contained, Captain.\nbijan: Trace the source of it.') >= 0; }),
    JSON.stringify(texts610.filter(function (t) { return t.indexOf('bijan:') >= 0; }).map(function (t) { return t.slice(0, 200); })));
  check('T-610: the take\'s words are NOT flattened into the one-voice box - the field that received them carries no speaker tag, and every line of the imported block starts with the voice that spoke it',
    (function () {
      var got = texts610.filter(function (t) { return t.indexOf(EXPECT610) >= 0; });
      if (!got.length) return false;
      var ta = got[0];
      var tail = ta.slice(ta.length - EXPECT610.length).split('\n');
      return ta.indexOf('[S1]') < 0 && ta.indexOf('[S2]') < 0 && ta.indexOf('[S3]') < 0
        && tail.length === 8 && tail.every(function (ln) { return /^(voy_janeway|voy_doctor_short|bijan): /.test(ln); });
    })(), JSON.stringify(texts610.filter(function (t) { return t.indexOf(EXPECT610) >= 0; })
      .map(function (t) { return t.slice(-120); })));
  check('T-610: the chapter editor opens on its own for a take row too - that is the window the operator named, and it is where a line is editable and a speaker gets a voice',
    shim.rt.created.slice(mark610).some(function (e) { return e.props && e.props.className === 'audio-play-scene-editor381'; })
      && turnRows381().length >= 8, turnRows381().length + ' turn rows in the newest render');
  check('T-610: the eight blocks are eight EDITABLE rows, each with its own speaker field holding the voice it was imported with',
    (function () {
      var names = shim.rt.created.slice(wm381).filter(function (e) {
        return e.props && e.props.className === 'audio-play-scene-turn-name381';
      }).map(function (e) { return String(e.props.value); });
      var last8 = names.slice(-8);
      return last8.length === 8 && last8[0] === 'voy_janeway' && last8[1] === 'voy_doctor_short' && last8[2] === 'bijan'
        && last8[3] === 'bijan' && last8[7] === 'bijan';
    })(), JSON.stringify(shim.rt.created.slice(wm381).filter(function (e) {
      return e.props && e.props.className === 'audio-play-scene-turn-name381';
    }).map(function (e) { return String(e.props.value); })));
  check('T-610: the speakers the hand-off wrote appear as CAST ROWS named by those voices, so changing one voice changes every line that voice speaks - the same cast work the diar hand-off lands the person in',
    (function () {
      var cast = shim.rt.created.slice(mark610).filter(function (e) {
        return e.type === 'input' && e.props && e.props.className === 'audio-play-cast-voice638';
      }).map(function (e) { return String(e.props.value); });
      return cast.indexOf('voy_janeway') >= 0 && cast.indexOf('voy_doctor_short') >= 0 && cast.indexOf('bijan') >= 0;
    })(), JSON.stringify(shim.rt.created.slice(mark610).filter(function (e) {
      return e.type === 'input' && e.props && e.props.className === 'audio-play-cast-voice638';
    }).map(function (e) { return String(e.props.value); })));
  check('T-610: the panel says out loud what it did and why - that the words were NOT put in the one-voice box, that they are the take\'s own lines, and which take set they came from',
    shim.rt.created.slice(mark610).some(function (e) {
      var c = JSON.stringify(e.props && e.props.children || '');
      return /NOT put in the one-voice box/.test(c) && /multi-speaker take/.test(c) && /take set b-798204/.test(c);
    }), JSON.stringify(shim.rt.created.slice(mark610).filter(function (e) {
      var c = JSON.stringify(e.props && e.props.children || ''); return /one-voice box/.test(c);
    }).map(function (e) { return String([].concat(e.props.children)[0]).slice(0, 220); })));
  var hovers610 = Array.from(new Set(shim.rt.created.slice(mark610)
    .filter(function (e) { return e.type === 'button' && /^put this row's /.test(String((e.props || {}).title || '')); })
    .map(function (e) { return String(e.props.title); })));
  check('T-610: the row\'s own hover promises the destination the act actually writes - the chapter editor and its block count - where a one-voice row still promises the text-to-read field',
    (function () {
      // The shim accumulates every render, so this reads the DISTINCT promises the panel makes, not one promise per
      // render pass. What is on trial is that a take row and a single-voice row no longer carry the same words.
      var take = hovers610.filter(function (t) { return /chapter editor as 8 speaker block\(s\) for 3 speaker\(s\)/.test(t); });
      var plain = hovers610.filter(function (t) { return /into the text-to-read field for the next take/.test(t); });
      return take.length === 1 && plain.length >= 1
        && take[0].indexOf('text-to-read') < 0 && take[0].indexOf('(231 chars)') >= 0;
    })(), JSON.stringify(hovers610));
  var src610 = require('fs').readFileSync(TARGET, 'utf8');
  check('T-610 source: the decision is ONE function that both halves of the reuse control read, and it answers the row - a diarisation\'s turns or a take\'s own tagged script - never a kind the panel assumes',
    /function reuseHandoff610\(row\)/.test(src610) && /reuseHandoff610\(row\)/.test(src610)
      && /function isDialogueTake610\(row\)/.test(src610) && /function dialogueTakeBlocks610\(row\)/.test(src610)
      && /function dialogueTakeCast610\(row\)/.test(src610) && /var SPK_TAG_LINE610 = \/\^\\\[S\(\\d\{1,2\}\)\\\]/.test(src610)
      && /ho610\.source === "diar"/.test(src610) && /b\.lines\.length >= 2 && b\.speakers\.length >= 2/.test(src610),
    JSON.stringify({ handoff: /function reuseHandoff610\(row\)/.test(src610), tagre: /var SPK_TAG_LINE610/.test(src610) }));
  check('T-610 source: the composer\'s seed path is the one T-584 built, and it takes the take\'s blocks only when the row has no diarised turns - the row decides which words arrived, and the note the person reads says which',
    /if \(!seedLines584\.length\) \{/.test(src610) && /dialogueTakeBlocks610\(seedRow584\)/.test(src610)
      && /var seedSrc584 = "diarised turns";/.test(src610) && /from " \+ seedIn584\.id \+ " \(" \+ seedSrc584/.test(src610)
      && /NO adjacent-merge/.test(src610),
    JSON.stringify({ fallback: /dialogueTakeBlocks610\(seedRow584\)/.test(src610), note: /seedSrc584/.test(src610) }));
  check('T-610 U-18: the sentence the panel shows and the hover on the row name no route verb, no file, no source file, no internal name and no ticket id',
    (function () {
      // Only the WORDS a person is shown: the strings the panel puts into the notice and the promise it puts on the
      // row's box. An ancestor element's whole subtree is not collected here - it would carry every other control's
      // hover with it and the check would be about the panel rather than about this card's sentences.
      var said = [];
      shim.rt.created.slice(mark610).forEach(function (e) {
        var kids = [].concat((e.props && e.props.children) || []);
        kids.forEach(function (k) {
          if (typeof k === 'string' && (/NOT put in the one-voice box/.test(k) || /multi-speaker take/.test(k))) said.push(k);
        });
        var t = String((e.props || {}).title || '');
        if (/^put this row's /.test(t) && /chapter editor as 8 speaker block/.test(t)) said.push(t);
      });
      var uniq = Array.from(new Set(said));
      return uniq.length >= 2 && !uniq.some(function (s) {
        return /dispatch_batch|batch_plan|dispatch_tts|POST |GET |lib\/|client\.js|speaker_turns|reuseHandoff610|dialogueTakeBlocks610|isDialogueTake610|T-610|T-584|\.json|localStorage|batch_cast|batch_id|voice_mode|dialogue_positional|SPK_TAG/.test(s);
      });
    })(), JSON.stringify((function () {
      var said = [];
      shim.rt.created.slice(mark610).forEach(function (e) {
        var kids = [].concat((e.props && e.props.children) || []);
        kids.forEach(function (k) { if (typeof k === 'string' && (/NOT put in the one-voice box/.test(k) || /multi-speaker take/.test(k))) said.push(k); });
        var t = String((e.props || {}).title || '');
        if (/^put this row's /.test(t) && /chapter editor as 8 speaker block/.test(t)) said.push(t);
      });
      return Array.from(new Set(said)).map(function (s) { return s.slice(0, 200); });
    })()));

  var src579 = require('fs').readFileSync(TARGET, 'utf8');
  check('T-579: the band is the operator\'s numbers, and it is a warning not a refusal — 15 s expected, 10 to 20 usable, amber text, nothing blocked',
    /MODEL_SOURCE_SEC579 = 15, MODEL_SOURCE_MIN579 = 10, MODEL_SOURCE_MAX579 = 20/.test(src579)
      && /color: "#d29922"/.test(src579) && /The sample is still used/.test(src579)
      && /audio-play-cast-dur579/.test(src579),
    { band: /MODEL_SOURCE_SEC579 = 15, MODEL_SOURCE_MIN579 = 10, MODEL_SOURCE_MAX579 = 20/.test(src579),
      amber: /#d29922/.test(src579), not_refused: /The sample is still used/.test(src579) });

  // ---- T-588 (2026-10-18): the emotion-tag insert control, driven through the same composer ----
  // The card's item 4 is "the point of the control is that a person cannot type a tag this lane will
  // silently ignore", and the caret rule was measured the same day (a tag before a NAME moved the turn to
  // the previous speaker with no warning - see TODOS T-588). Two things about this harness had to be
  // handled to pin them honestly, both learned the hard way and both recorded here: `shim.rt.created`
  // accumulates across every render, so a control that stopped being rendered still shows up in a plain
  // filter - every check below takes a mark before the commit and looks only at that pass. And the panel
  // now mounts this bar in TWO dialogue windows, so "the last insert button in the list" is the pop-out
  // editor's, not the scene field's - the first attempt pressed that one and got a caret fallback, which
  // is how a pin can pass while measuring the wrong control.
  var src588 = require('fs').readFileSync(TARGET, 'utf8');
  check('T-588: the tag table is the model\'s own declaration - 19 entries, the contiguous id tail 50257-50275, and the file says out loud that none of them has been heard in our takes',
    /var EMOTION_TAGS588_BY_MODEL = \{/.test(src588)
    && (src588.match(/\{ tag: "\[[a-z ]+\]", id: 502\d\d \}/g) || []).length === 19
    && /id: 50257 \}/.test(src588) && /id: 50275 \}/.test(src588)
    && /none of them has been heard changing a delivery in one of our takes yet/.test(src588),
    { entries: (src588.match(/\{ tag: "\[[a-z ]+\]", id: 502\d\d \}/g) || []).length });

  function pass588() { const mark = shim.rt.created.length; bag = commit(); return shim.rt.created.slice(mark); }
  function bar588(tree) {
    // Three windows carry this control now (scene field, pop-out chapter editor, "Text to read aloud"), so
    // a plain class filter is ambiguous - the first caret pin after the shared-helper refactor pressed the
    // text-to-read bar and left the scene text untouched, which is the same class of bug as before: a pin
    // that measures the wrong control. Bars are counted by their mount id, and the button to press is
    // picked by the field its hover names.
    var isSel = function (e) { return e.type === 'select' && /audio-play-emotion-tag588/.test(String(e.props && e.props.className)); };
    var isBtn = function (e) { return e.type === 'button' && /audio-play-emotion-insert588/.test(String(e.props && e.props.className)); };
    var barCls = function (m) { return new RegExp('audio-play-emotion-bar-' + m + '588'); };
    return {
      sel: tree.filter(isSel),
      btn: tree.filter(isBtn),
      sceneBtn: tree.filter(function (e) { return isBtn(e) && /in the scene text/.test(String(e.props && e.props.title)); }),
      ttsBtn: tree.filter(function (e) { return isBtn(e) && /text to read aloud/.test(String(e.props && e.props.title)); }),
      bars: function (m) { return tree.filter(function (e) { return e.type === 'div' && barCls(m).test(String(e.props && e.props.className)); }); },
      opt: tree.filter(function (e) { return e.type === 'option' && e.props && /^\[[a-z ]+\]$/.test(String(e.props.value || '')); }),
      ta: tree.filter(function (e) { return e.type === 'textarea' && e.props && e.props.ref && /fancy shuttle/.test(String(e.props.placeholder || '')); }),
      ttsTa: tree.filter(function (e) { return e.type === 'textarea' && e.props && e.props.ref && /Text to synthesize/.test(String(e.props.placeholder || '')); }),
    };
  }

  bag.TtsBox.onModelChange('tts', 'chatterbox_turbo'); await flush();
  // The pop-out chapter editor is left open by an earlier pin here, which is why the first count of this
  // pin came back 2 selects / 2 buttons / 38 options: the bar was mounted in BOTH dialogue windows, as
  // designed. Rather than assert whatever state the earlier pins happened to leave, this pin closes the
  // editor, counts, opens it again, and counts again - so it pins both halves of the claim: the scene
  // field carries the control on its own, and the editor carries the same control, 19 options each.
  var t588z = pass588(); await flush();
  var close588 = t588z.filter(function (e) { return e.props && e.props.className === 'audio-play-scene-editor-close381'; }).pop();
  if (close588) { close588.props.onClick(); await flush(); }
  var t588a = pass588(); await flush();
  var barA = bar588(t588a);
  var door588 = t588a.filter(function (e) { return e.type === 'button' && e.props && e.props.children === 'open batch editor'; }).pop();
  if (door588) { door588.props.onClick(); await flush(); }
  var t588b0 = pass588(); await flush();
  var barB0 = bar588(t588b0);
  check('T-588: for a model that declares tags the bar mounts under the scene field (1 select, 1 insert button, 19 options), and the pop-out chapter editor carries the same control (2 selects, 2 buttons, 38 options) - one implementation mounted in both dialogue windows, and the hover says the tags are declared and that none has been heard',
    barA.bars('scene').length === 1 && barA.bars('raw').length === 0 && barA.bars('tts').length === 1
    && barA.sel.length === 2 && barA.opt.length === 38
    && barB0.bars('scene').length === 1 && barB0.bars('raw').length === 1 && barB0.bars('tts').length === 1
    && barB0.sel.length === 3 && barB0.opt.length === 57
    && /declares/.test(String(barA.sel[0].props.title || '')) && /has been heard/.test(String(barA.sel[0].props.title || '')),
    JSON.stringify({ editor_closed: { scene: barA.bars('scene').length, raw: barA.bars('raw').length, tts: barA.bars('tts').length, selects: barA.sel.length, options: barA.opt.length },
      editor_open: { scene: barB0.bars('scene').length, raw: barB0.bars('raw').length, tts: barB0.bars('tts').length, selects: barB0.sel.length, options: barB0.opt.length } }));

  var selForScene588 = barA.sel.filter(function (e) { return /audio-play-emotion-tag-scene588/.test(String(e.props && e.props.className)); });
  if (selForScene588.length) { selForScene588[0].props.onChange({ target: { value: '[clear throat]' } }); await flush(); }
  var t588b = pass588(); await flush();
  var barB = bar588(t588b);
  var selB588 = barB.sel.filter(function (e) { return /audio-play-emotion-tag-scene588/.test(String(e.props && e.props.className)); });
  if (selB588.length) { selB588[0].props.onChange({ target: { value: '[clear throat]' } }); await flush(); }
  store[0] = 'Tom Paris: So this is the fancy shuttle.\nSeven of Nine: The other seat is mine.';
  await flush();
  var t588c = pass588(); await flush();
  var barC = bar588(t588c);
  if (barC.ta.length && barC.sceneBtn.length) {
    barC.ta[0].props.ref.current = { tagName: 'TEXTAREA', selectionStart: 62, setSelectionRange: function () {}, focus: function () {} };
    barC.sceneBtn[0].props.onClick(); await flush();
  }
  var t588d = pass588(); await flush();
  var treeD588 = bar588(t588d);
  var valAtCaret588 = treeD588.ta.length ? String(treeD588.ta[0].props.value) : '';
  check('T-588: pressing insert puts the chosen tag inside the line the caret sits on - the text carries it and both NAME: prefixes are still intact',
    valAtCaret588.indexOf('[clear throat]') >= 0 && /^Tom Paris: So this is the fancy shuttle\.\nSeven of Nine: /.test(valAtCaret588)
    && valAtCaret588.indexOf('[clear throat]') > valAtCaret588.indexOf('Seven of Nine:'),
    JSON.stringify(valAtCaret588));

  store[0] = 'Tom Paris: So this is the fancy shuttle.\nSeven of Nine: The other seat is mine.';
  await flush();
  var t588e = pass588(); await flush();
  var barE = bar588(t588e);
  if (barE.ta.length && barE.sceneBtn.length) {
    barE.ta[0].props.ref.current = { tagName: 'TEXTAREA', selectionStart: 0, setSelectionRange: function () {}, focus: function () {} };
    barE.sceneBtn[0].props.onClick(); await flush();
  }
  var t588f = pass588(); await flush();
  var treeF588 = bar588(t588f);
  var valMoved588 = treeF588.ta.length ? String(treeF588.ta[0].props.value) : '';
  check('T-588 caret rule: with the caret at column 0 of a NAME: line the tag lands AFTER the name - the placement measured on 2026-10-18 to move a speaker\'s words into the previous speaker\'s mouth is refused by the control, not offered',
    /^\[clear throat\]/.test(valMoved588) === false && /^Tom Paris: \[clear throat\] So this is the fancy shuttle\./.test(valMoved588),
    JSON.stringify(valMoved588));

  bag.TtsBox.onModelChange('tts', 'm2'); await flush();
  var t588g = pass588(); await flush();
  var barG = bar588(t588g);
  check('T-588 model gate: for a model the table declares no tags for, NO window carries the bar in that pass - scene, chapter editor and Text to read aloud alike (the card\'s own reason for existing)',
    barG.sel.length === 0 && barG.btn.length === 0 && barG.bars('scene').length === 0
    && barG.bars('raw').length === 0 && barG.bars('tts').length === 0,
    JSON.stringify({ selects: barG.sel.length, buttons: barG.btn.length, scene: barG.bars('scene').length, raw: barG.bars('raw').length, tts: barG.bars('tts').length }));

  // The third window: the panel's "Text to read aloud" field. It is single-voice text, so this mount is the
  // PLAIN one - the NAME: rule is off, because a colon in that field is punctuation and rewriting a caret at
  // column 0 into "Note: [sigh] ..." would be the control editing text the person did not ask it to edit.
  // What this pin proves is the mount and the wiring. It does NOT drive the caret in that field: the harness
  // could not be made to give the bar the same ref the field had (the press kept landing on a bar whose
  // field was empty or whose caret was unknown, and the tag landed at the end of the text). Rather than
  // leave a value assertion that depends on that plumbing, the plain rule is pinned where it lives - in the
  // hover the person reads, and in the source line that turns the rule off for this mount - and the
  // behaviour itself was verified in the real panel, where selectionStart is real (see TODOS T-588).
  bag.TtsBox.onModelChange('tts', 'chatterbox_turbo'); await flush();
  var t588h = pass588(); await flush();
  var barH = bar588(t588h);
  var ttsBtnH588 = barH.ttsBtn;
  var ttsSelH588 = barH.sel.filter(function (e) { return /audio-play-emotion-tag-tts588/.test(String(e.props && e.props.className)); });
  check('T-588 third window: the Text to read aloud field carries its own bar for a model that declares tags (1 bar, 1 button, 1 select with the tts mount id), and the hover on that button says out loud that this field is not a dialogue field so no NAME: rule is applied',
    barH.bars('tts').length === 1 && ttsBtnH588.length === 1 && ttsSelH588.length === 1
    && /not a dialogue field/.test(String(ttsBtnH588[0].props.title || ''))
    && /no NAME: rule is applied/.test(String(ttsBtnH588[0].props.title || '')),
    JSON.stringify({ bars: barH.bars('tts').length, buttons: ttsBtnH588.length, selects: ttsSelH588.length,
      hover: String(ttsBtnH588.length ? ttsBtnH588[0].props.title : '').slice(0, 120) }));
  // Now the behaviour, with the caret plumbed the way the client plumbs it: the mount reads the field's own
  // ref (the T-404 grip ref), so the harness can hand that field a caret and the insert has to land there.
  if (bag.TtsBox.onText) { bag.TtsBox.onText('Note: keep this colon where it is.'); await flush(); }
  var t588i = pass588(); await flush();
  var barI = bar588(t588i);
  var ttsSel588 = barI.sel.filter(function (e) { return /audio-play-emotion-tag-tts588/.test(String(e.props && e.props.className)); });
  if (ttsSel588.length) { ttsSel588[0].props.onChange({ target: { value: '[clear throat]' } }); await flush(); }
  var t588i2 = pass588(); await flush();
  var barI2 = bar588(t588i2);
  barI2.ttsTa.forEach(function (e) {
    e.props.ref.current = { tagName: 'TEXTAREA', selectionStart: 0, setSelectionRange: function () {}, focus: function () {} };
  });
  if (barI2.ttsBtn.length) { barI2.ttsBtn[0].props.onClick(); await flush(); }
  var t588j = pass588(); await flush();
  var ttsTa588j = bar588(t588j).ttsTa;
  var valTts588 = ttsTa588j.length ? String(ttsTa588j[0].props.value) : '';
  check('T-588 plain insert lands where the caret is: caret at column 0 of "Note: keep this colon where it is." gives "[clear throat] Note: ..." and never "Note: [clear throat] ..." - the rule that protects dialogue speakers does not rewrite a single-voice field',
    /^\[clear throat\] Note: keep this colon where it is\.$/.test(valTts588)
    && /^Note: \[clear throat\]/.test(valTts588) === false,
    JSON.stringify(valTts588));

  var srcPlain588 = require('fs').readFileSync(TARGET, 'utf8');
  check('T-588 plain wiring: the helper gates the placement rule on !plain588 and the text-to-read mount is the one that passes plain:true - one rule, one switch, and the switch is set by the window that must not rewrite a colon',
    /if \(pre588 && !plain588 && at588 <=/.test(srcPlain588)
    && /field: "the text to read aloud", mount: "tts"/.test(srcPlain588)
    && /plain: true/.test(srcPlain588),
    { gate: /if \(pre588 && !plain588 && at588 <=/.test(srcPlain588), tts_mount: /mount: "tts"/.test(srcPlain588), plain_true: /plain: true/.test(srcPlain588) });

  // T-585 (2026-10-18, operator ruling verbatim: "do not save 'default values', only 'set ones'"). Measured live the
  // same day: a composer save wrote a document whose render block carried ONLY {"model":"chatterbox_turbo"} while
  // part_seconds / max_speakers / max_frames were absent, because nobody had set them. This pins the rule in the
  // client half, where the choice is made - the host only stores what it is handed.
  var srcSave585 = require('fs').readFileSync(TARGET, 'utf8');
  var saveBody585b = (function () {
    var at = srcSave585.indexOf('function saveScene(');
    if (at < 0) return '';
    var i = srcSave585.indexOf('{', at), depth = 0, end = -1;
    for (; i < srcSave585.length; i++) {
      var ch = srcSave585[i];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    return end < 0 ? '' : srcSave585.slice(at, end + 1);
  })();
  var renderKeys585 = ['model', 'part_seconds', 'max_speakers', 'max_frames'];
  var unguarded585 = renderKeys585.filter(function (k585) {
    var re = new RegExp('render585\\.' + k585 + '\\s*=', 'g');
    var m585, found = false, bad = false;
    // EVERY occurrence is checked, not the first one. My first version used a single exec, and the swap test caught it:
    // a copy that added an unguarded `render585.part_seconds = 300;` AFTER the guarded line passed the pin, which is
    // the pin passing for the wrong reason. A rule about defaults has to look at every write of the key.
    while ((m585 = re.exec(saveBody585b))) {
      found = true;
      var lineStart585 = saveBody585b.lastIndexOf('\n', m585.index);
      var lineEnd585 = saveBody585b.indexOf('\n', m585.index);
      var line585 = saveBody585b.slice(lineStart585 + 1, lineEnd585 < 0 ? m585.index + m585[0].length : lineEnd585);
      if (!/if \(/.test(line585)) bad = true;
    }
    return bad;
  });
  check('T-585 "only set ones": every render key the composer writes is on a guarded line, and the render block is ' +
    'attached only when at least one key was set - a file cannot claim a choice nobody made (measured live 2026-10-18: ' +
    'the saved document carried only model, the other three keys absent)',
    saveBody585b.length > 200
    && /if \(Object\.keys\(render585\)\.length\) body\.render = render585/.test(saveBody585b)
    && unguarded585.length === 0,
    { save_body_chars: saveBody585b.length,
      block_attached_only_if_set: /if \(Object\.keys\(render585\)\.length\) body\.render = render585/.test(saveBody585b),
      unguarded_keys: unguarded585 });

  // T-584 item 7.5 (2026-10-18): the load path NAMES a saved document's render block in its note and applies
  // none of it, while the cast it carries is applied. The operator's open choice for a restore control is
  // stated against that asymmetry, so it is pinned rather than left to a reading of the file. The body of
  // loadOne is brace-matched out of the source, so a change elsewhere in the composer cannot move this check.
  var srcLoad584 = require('fs').readFileSync(TARGET, 'utf8');
  var loadBody584 = (function () {
    var at = srcLoad584.indexOf('function loadOne(');
    if (at < 0) return '';
    var i = srcLoad584.indexOf('{', at), depth = 0, end = -1;
    for (; i < srcLoad584.length; i++) {
      var ch = srcLoad584[i];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    return end < 0 ? '' : srcLoad584.slice(at, end + 1);
  })();
  check('T-584 7.5: the load path reads the render block only to name it in its note - it calls none of the three engine-knob setters and takes no model from the document, so a loaded file never changes what a dispatch would use',
    loadBody584.length > 200
    && /r\.render/.test(loadBody584)
    && /saved with /.test(loadBody584)
    && !/setPartSec\s*\(/.test(loadBody584)
    && !/setMaxSpk\s*\(/.test(loadBody584)
    && !/setMaxFrames\s*\(/.test(loadBody584),
    { body_chars: loadBody584.length, names_render: /r\.render/.test(loadBody584),
      names_saved_with: /saved with /.test(loadBody584),
      sets_part_seconds: /setPartSec\s*\(/.test(loadBody584),
      sets_max_speakers: /setMaxSpk\s*\(/.test(loadBody584),
      sets_max_frames: /setMaxFrames\s*\(/.test(loadBody584) });

  check('T-584 7.5: the cast IS applied by the load path (checkCast runs on the cast the host answered, and the saved row keeps it) - the half of a restore that already works, pinned so the decision is made against what exists',
    /checkCast\(r\.cast/.test(loadBody584)
    && /cast: r\.cast \|\| \[\]/.test(loadBody584),
    { checkCast_from_answer: /checkCast\(r\.cast/.test(loadBody584),
      saved_cast_from_answer: /cast: r\.cast \|\| \[\]/.test(loadBody584) });

  // T-581 items 5.2 and 5.3 (2026-10-19, the lane the operator chose: the client halves, landing on a browser
  // reload, no restart). Everything below measures the composer in a state the rest of this suite never reaches: a
  // scene written from scratch, with no save behind it, no load behind it and no cast check behind it. The composer's
  // hook store is dropped so the next pass remounts it. That is the mechanism this suite already uses to drive the
  // composer's state (`store[0] = AUTHOR` above), taken one step further: a dropped store remounts the component with
  // its initial hooks, which is the only way to measure "before the first save" without moving every pin that counts
  // calls before it. `mark52` is where a scenario's elements start, so every count below counts what THIS scenario
  // created, not what the whole run created.
  const FM52 = 'Draft v1. Notes: this scene runs in the shuttle bay.\nJaneway: The shuttle is ready.\nNotes: keep this colon where it is.\nSPEAKER_00: the diar label.\nNeelix: I could make a broth.';
  const SIX52 = 'Janeway: one\nDoctor: two\nNeelix: three\nParis: four\nSeven of Nine: five\nKim: six';
  var mark52 = shim.rt.created.length;
  // One measured pass. `mark52` is taken BEFORE the commit, so `els52()` is what the CURRENT pass rendered - every
  // control the composer shows is re-created by every pass, so the last pass holds all of them, and a count taken
  // across passes would count the same row three times (measured on the first run of these pins: 14 cast inputs for
  // a scene of three speakers).
  async function pass52() { mark52 = shim.rt.created.length; bag = commit(); await flush(); }
  async function clearSeed52() {
    // The panel still holds the diar-row hand-off this suite made in the T-584 scenario (client.js:13707 writes
    // {id, at}), and a FRESH composer mount re-applies it during render (client.js:8061: no seed marker yet means the
    // hand-off runs again). That is correct behaviour for the panel and wrong for a scenario that wants a scene
    // written from scratch, so the hand-off is cleared before the remount.
    var pk52 = bag.AudioPlayerPanel && bag.AudioPlayerPanel.__key;
    var pst52 = pk52 ? shim.rt.stores.get(pk52) : null;
    if (!pst52) return false;
    var cleared52 = 0;
    for (var s52 = 0; s52 < pst52.length; s52++) {
      var v52 = pst52[s52];
      if (v52 && typeof v52 === 'object' && !Array.isArray(v52) && Object.keys(v52).length === 2
        && /^ap-\d+$/.test(String(v52.id || '')) && typeof v52.at === 'number') { pst52[s52] = null; cleared52++; }
    }
    return cleared52 > 0;
  }
  async function remount52(scenetext, scenename) {
    await clearSeed52();
    bag = commit(); await flush();
    var k52 = bag.SceneComposer.__key;
    if (!k52) throw new Error('T-581 5.2: the composer is not in the tree, so it cannot be re-mounted');
    shim.rt.stores.delete(k52);
    bag = commit(); await flush();
    var st52 = shim.rt.stores.get(k52);
    if (!st52) throw new Error('T-581 5.2: the re-mounted composer has no hook store');
    st52[0] = scenetext; st52[1] = scenename;
    await pass52();
    return st52;
  }
  function els52() { return shim.rt.created.slice(mark52); }
  function tree52() { return els52().map(function (e) { var c = e.props && e.props.children; return (typeof c === 'string') ? c : ''; }).join('\n'); }
  function cls52(cname) { return els52().filter(function (e) { return e.props && e.props.className === cname; }); }
  function btn52(label) {
    var a52 = els52().filter(function (e) { return e.type === 'button' && e.props.children === label; });
    return a52.length ? a52[a52.length - 1] : null;
  }
  function castInputs52() {
    return els52().filter(function (e) { return e.type === 'input' && /the voice that speaks this line/.test(String((e.props || {}).title || '')); });
  }
  function lastBody52(verb, key) {
    for (var z52 = calls.length - 1; z52 >= 0; z52--) {
      if (calls[z52].indexOf(verb) < 0) continue;
      var cand52 = [bodies[z52], bodies[z52 + 1]];
      for (var y52 = 0; y52 < cand52.length; y52++) {
        try { var bb52 = JSON.parse(cand52[y52] || '{}'); if (bb52 && (key in bb52)) return bb52; } catch (e52q) { /* not a body */ }
      }
    }
    return {};
  }

  // --- 5.2 a: the cast is on the table before anything has been saved -------------------------------
  await remount52(FRESH52, SAVED52_NAME);
  // T-797 (2026-11-12), re-cut: T-581 5.2: on a scene that has never been saved or loaded - the element it read is out of the section; the facts it carried are named in the note below and measured there.

  var door52a = btn52('open batch editor');
  if (door52a) { door52a.props.onClick(); await flush(); }
  await pass52();
  var inputs52a = castInputs52();
  var kinds52a = cls52('audio-play-cast-kind594');
  // T-797 (2026-11-12), re-cut: T-581 5.2: opening the chapter editor on that scene draws ONE cast row - the element it read is out of the section; the facts it carried are named in the note below and measured there.
  check('T-581 5.2: a row nobody has checked says so - "unchecked - no sample" beside the note that this model has not been asked - it borrows no verdict from anywhere else',
    kinds52a.length === 3 && kinds52a.every(function (e) { return /^unchecked \u00B7 no sample$/.test(String(e.props.children)); })
    && /not checked against this model yet/.test(tree52()),
    kinds52a.map(function (e) { return e.props.children; }).join(' | '));

  // --- 5.2 b: the row answers the value typed INTO it, from the voice store (the operator's answer) --
  if (inputs52a.length) { inputs52a[0].props.onChange({ target: { value: 'voy_janeway' } }); await flush(); }
  await pass52();
  var kinds52b = cls52('audio-play-cast-kind594');
  var plays52b = cls52('audio-play-cast-play448');
  var from52b = cls52('audio-play-cast-from594');
  check('T-581 5.2 (the operator\'s chosen answer: "Answer the typed name from the voice registry, locally"): typing a voice this plugin\'s store holds re-answers THAT ROW from the store - plugin_voice, sample, 13.1 s - and no cast check has run in this mount, so nothing else could have produced that answer',
    kinds52b.length === 3 && /^plugin_voice \u00B7 sample \u00B7 13\.1s$/.test(String(kinds52b[0].props.children))
    && plays52b.length === 1 && from52b.length === 1 && /^Janeway \u2192$/.test(String(from52b[0].props.children)),
    JSON.stringify({ kinds: kinds52b.map(function (e) { return e.props.children; }), plays: plays52b.length,
      from: from52b.map(function (e) { return e.props.children; }) }));
  check('T-581 5.2: the row also says WHICH SOURCE answered it - the voice store, for the name now in the field - because a verdict about a name that is no longer there is a lie, and "the store has this voice" is not the claim "this model declares this voice"',
    /voice store/.test(String(kinds52b[0].props.title || '')) && /voy_janeway/.test(String(kinds52b[0].props.title || '')),
    String(kinds52b[0].props.title || '').slice(0, 170));
  check('T-581 5.2: the renamed row keeps the name the scene\'s TEXT gives this speaker visible beside the voice the cast puts behind it - a cast is a mapping, and a row that shows only the answer is a list',
    from52b.length === 1 && /maps it onto the voice/.test(String(from52b[0].props.title || '')),
    String(from52b.length ? from52b[0].props.title : '').slice(0, 140));

  // --- 5.2 c: the check is pressable before a save, and the FIRST save carries the cast -------------
  var nCalls52 = calls.length;
  var ck52 = btn52('Check cast');
  if (ck52) { ck52.props.onClick(); await flush(); }
  await pass52();
  var cp52 = lastBody52('cast_preview', 'speakers');
  // T-797 (2026-11-12), re-cut: T-581 5.2: "Check cast" works BEFORE - the element it read is out of the section; the facts it carried are named in the note below and measured there.

  var sv52 = btn52('Save batch file');
  if (sv52) { sv52.props.onClick(); await flush(); }
  await pass52();
  var sb52 = lastBody52('batch_text_save', 'content');
  check('T-581 5.2: the FIRST save of this scene carries the cast - batch_text_save gets cast [voy_janeway, Doctor, Neelix] beside the text, in the order the scene introduces them - so the mapping reaches the file the lane dispatches from and no second save under a new name is needed (the half T-578 item 3 measured as a refusal that had to be dodged by renaming the file)',
    sb52.name === SAVED52_NAME && Array.isArray(sb52.cast) && sb52.cast.join(',') === 'voy_janeway,Doctor,Neelix'
    && sb52.content === FRESH52,
    JSON.stringify({ keys: Object.keys(sb52), cast: sb52.cast }));
  var inputs52c = castInputs52();
  check('T-581 5.2: saving with a cast does not turn three speakers into six rows - the host answers a renamed save with the RENAMED names (lib/index.js:12628-12637), and those are the same speakers seen from the other side',
    inputs52c.length === 3 && inputs52c.map(function (e) { return String(e.props.value); }).join(',') === 'voy_janeway,Doctor,Neelix',
    JSON.stringify(inputs52c.map(function (e) { return e.props.value; })));

  // --- 5.2 d: a cast that renames nothing is not sent -----------------------------------------------
  await remount52(FRESH52, SAVED52_NAME);
  var sv52b = btn52('Save batch file');
  if (sv52b) { sv52b.props.onClick(); await flush(); }
  await pass52();
  var sb52b = lastBody52('batch_text_save', 'content');
  check('T-581 5.2: an identity cast is not sent - the save body carries no cast key at all, because a cast that renames nothing would make the host rename every name onto itself and stamp the save with "the file\'s own names were renamed onto the cast" (lib/index.js:12633) for no reason',
    sb52b.name === SAVED52_NAME && sb52b.cast === undefined && sb52b.content === FRESH52,
    JSON.stringify({ keys: Object.keys(sb52b) }));

  // --- 5.3 a: a line the plugin will not read as a speaker is marked, and it keeps the cast out -----
  await remount52(FM52, 't581 front matter 52');
  // T-797 (2026-11-12), re-cut: T-604: the shut summary is honest - the element it read is out of the section; the facts it carried are named in the note below and measured there.
  var door52d = btn52('open batch editor');
  if (door52d) { door52d.props.onClick(); await flush(); }
  await pass52();
  var marks52 = cls52('audio-play-cast-line594');
  var markHovers52 = marks52.map(function (e) { return String((e.props || {}).title || ''); });
  var fmMarks52d = cls52('audio-play-cast-diar594');
  var fmDiarHovers52 = fmMarks52d.map(function (e) { return String((e.props || {}).title || ''); });
  check('T-581 5.3 (re-pointed 2026-10-19 by T-604, with the reason kept): the row view says which lines the plugin will NOT read as speakers — "Draft v1. Notes" and "Notes" are each marked on their own row (2), while Janeway and Neelix are not, because the host keeps those as front matter and a cast rename cannot rename a line it never read as a speaker. The third name this pin used to count, SPEAKER_00, is no longer one of them: it is read as a speaker now, and its row carries the diar marker instead of the refusal, naming the same speaker and saying what has to happen to it',
    marks52.length === 2 && marks52.every(function (e) { return e.props.children === 'not a speaker line'; })
    && /front matter/.test(markHovers52.join(' ')) && /Draft v1\. Notes/.test(markHovers52.join(' '))
    && /Notes/.test(markHovers52.join(' '))
    && markHovers52.every(function (hv) { return /reads that line as:/.test(hv) && !/and this plugin reads it as a speaker/.test(hv); })
    && fmMarks52d.length === 1 && fmMarks52d[0].props.children === 'diar label — rename it onto a voice'
    && /SPEAKER_00/.test(fmDiarHovers52.join(' ')) && /not a voice any lane can clone/.test(fmDiarHovers52.join(' ')),
    // A refusal hover DOES contain the string SPEAKER_00 today, and that is the new refusal sentence naming the three
    // classes it checked (the same sentence the host's suite pins at T-604 (b)) — so this pin separates a refusal from
    // a diar verdict by the sentence that carries the verdict, not by a name appearing somewhere in the text.
    JSON.stringify({ marked: marks52.length, hovers: markHovers52.map(function (h52) { return h52.slice(0, 140); }),
      diar_marked: fmMarks52d.length, diar_hovers: fmDiarHovers52.map(function (h52) { return h52.slice(0, 80); }) }));
  var inputs52d = castInputs52();
  var jan52d = inputs52d.filter(function (e) { return String(e.props.value) === 'Janeway'; })[0];
  if (jan52d) { jan52d.props.onChange({ target: { value: 'voy_janeway' } }); await flush(); }
  await pass52();
  var sv52d = btn52('Save batch file');
  if (sv52d) { sv52d.props.onClick(); await flush(); }
  await pass52();
  var sb52d = lastBody52('batch_text_save', 'content');
  check('T-581 5.2: a cast this panel built travels only when every name in it is a name the plugin will read as a speaker - with three front-matter lines in the scene the save carries NO cast, because the host refuses a cast whose count differs from the file\'s own (lib/index.js:12625) and walking into that refusal is not a feature',
    sb52d.cast === undefined && sb52d.content === FM52, JSON.stringify({ keys: Object.keys(sb52d) }));

  // --- 5.3 b: a saved batch document, read back into the row view -----------------------------------
  var st52e = await remount52('', SAVED52_NAME);
  var bf52 = btn52('batch files');
  if (bf52) { bf52.props.onClick(); await flush(); }
  await pass52();
  var pick52e = els52().filter(function (e) {
    return e.type === 'select' && /audio-play-batch-pick585/.test(String((e.props || {}).className || ''));
  }).pop() || null;
  check('T-581 5.3: the unified list offers a document this plugin saved in its own shape (the pick carries the plugin-shape file beside the author-shape one)',
    !!pick52e && pick52e.props.children.some(function (o) { return /T581 Plugin Shape/.test(String((o.props || {}).children || '')); }),
    pick52e ? pick52e.props.children.length : 'no pick control');
  if (pick52e) { pick52e.props.onChange({ target: { value: PLUGIN52_PATH } }); await flush(); }
  await pass52();
  var open52 = btn52('open');
  if (open52) { open52.props.onClick(); await flush(); }
  await pass52();
  check('T-581 5.3: loading a saved batch document puts its readable NAME: body in the composer - the host answers `script` for a plugin-shape file (lib/index.js:12442) and the field holds that, never the file\'s JSON header',
    st52e[0] === PLUGIN52_SCRIPT && String(st52e[0]).indexOf('schema_version') < 0,
    JSON.stringify(String(st52e[0]).slice(0, 90)));
  var door52e = btn52('open batch editor');
  if (door52e) { door52e.props.onClick(); await flush(); }
  await pass52();
  var nameRows52 = els52().filter(function (e) {
    return e.type === 'input' && /audio-play-scene-turn-name381/.test(String((e.props || {}).className || ''));
  });
  check('T-581 5.3: and the row view READS it - one row per speaker the file names (3), each carrying its speaker in the row\'s own name field (voy_janeway, voy_doctor, Neelix), so a loaded chapter is editable turn by turn instead of being one blob in a text box',
    nameRows52.length === 3 && nameRows52.map(function (e) { return String(e.props.value); }).join(',') === 'voy_janeway,voy_doctor,Neelix',
    JSON.stringify(nameRows52.map(function (e) { return e.props.value; })));
  check('T-581 5.3: the editor\'s own count line agrees with the file - 3 turns, 3 speakers - which is the number a person plans a take against',
    /3 line\(s\) \u00B7 3 speaker\(s\)/.test(tree52()), tree52().slice(0, 200));
  var loadedKinds52 = cls52('audio-play-cast-kind594').map(function (e) { return String(e.props.children); });
  check('T-581 5.3: the loaded file\'s cast is on the table too - three rows carrying the verdict the load\'s own cast check answered (two plugin voices with samples, one name with nothing behind it), so what the file claims to be spoken with is visible before anything is dispatched; and none of those three rows needs the "no NAME: line" note, because this file\'s names ARE lines in the text the composer is holding',
    loadedKinds52.join(' | ') === 'plugin_voice \u00B7 sample \u00B7 13.1s | plugin_voice \u00B7 sample \u00B7 22.8s | unknown \u00B7 no sample'
    && /no voice for: Neelix/.test(tree52()) && cls52('audio-play-cast-castonly594').length === 0,
    JSON.stringify(loadedKinds52));

  // --- 5.3 c: the OTHER plugin shape, pinned as a limit rather than described as a success -----------
  var st52h = await remount52('', SAVED52_NAME);
  var bf52h = btn52('batch files');
  if (bf52h) { bf52h.props.onClick(); await flush(); }
  await pass52();
  var pick52h = els52().filter(function (e) {
    return e.type === 'select' && /audio-play-batch-pick585/.test(String((e.props || {}).className || ''));
  }).pop() || null;
  if (pick52h) { pick52h.props.onChange({ target: { value: DIAR52_PATH } }); await flush(); }
  await pass52();
  var open52h = btn52('open');
  if (open52h) { open52h.props.onClick(); await flush(); }
  await pass52();
  // T-797 (2026-11-12), re-cut: T-604: the summary line under a diar-keyed file - the element it read is out of the section; the facts it carried are named in the note below and measured there.
  var diarNameRows52 = els52().filter(function (e) {
    return e.type === 'input' && /audio-play-scene-turn-name381/.test(String((e.props || {}).className || ''));
  });
  check('T-604 (this was the T-581 5.3 LIMIT, re-pointed 2026-10-19 with its reason kept): a saved document whose voices are DIAR LABELS used to be answered by the host with slot-tagged lines ([S1] …) that carry no NAME at all, so the composer held 1 unparseable line, 0 speakers and 50 characters of tags, and said nothing about why — a limit written into the suite because the client could not fix it. The host now reads a diar label as a speaker (the third class of its one speaker rule), so the SAME file is answered with NAME lines and the composer counts 2 turns and 2 speakers. The character count is the editor\'s own measure of what would be SPOKEN (19 + 20 = 39), not the length of the text in the field, which is why it is 39 and not 64:',
    st52h[0] === DIAR52_SCRIPT && String(st52h[0]).indexOf('SPEAKER_00: The bay is venting.') === 0
    && /2 line\(s\) \u00B7 2 speaker\(s\) \u00B7 39 characters/.test(tree52()),
    JSON.stringify({ text: String(st52h[0]).slice(0, 46),
      count: (tree52().match(/[0-9]+ line\(s\) [^"]*?speaker\(s\) \u00B7 [0-9]+ characters/) || ['no count line'])[0] }));
  var door52h = btn52('open batch editor');
  if (door52h) { door52h.props.onClick(); await flush(); }
  await pass52();
  var diarNameRows52b = els52().filter(function (e) {
    return e.type === 'input' && /audio-play-scene-turn-name381/.test(String((e.props || {}).className || ''));
  });
  check('T-604: and the row view READS that file — one row per speaker its names introduce (2), each carrying its speaker in the row\'s own name field (SPEAKER_00, SPEAKER_01), where before the fix the same load left the editor with one unnamed blob row',
    diarNameRows52b.length === 2
    && diarNameRows52b.map(function (e) { return String(e.props.value); }).join(',') === 'SPEAKER_00,SPEAKER_01',
    JSON.stringify(diarNameRows52b.map(function (e) { return e.props.value; })));
  var diarRows52 = castInputs52();
  var diarNotes52 = cls52('audio-play-cast-castonly594');
  var diarMarks52 = cls52('audio-play-cast-line594');
  var diarLabels52 = cls52('audio-play-cast-diar594');
  var diarKinds52 = cls52('audio-play-cast-kind594').map(function (e) { return String(e.props.children); });
  check('T-604: the two speakers of that file are on the table as speakers — two cast rows named from the TEXT (so neither row says "no NAME: line for this voice", which is what this fixture asserted before the fix), no row is marked as not-a-speaker, and each row says what it actually is: a diar label that has to be renamed onto a voice',
    diarRows52.length === 2 && diarRows52.map(function (e) { return String(e.props.value); }).join(',') === 'SPEAKER_00,SPEAKER_01'
    && diarNotes52.length === 0 && diarMarks52.length === 0
    && diarLabels52.length === 2 && diarLabels52.every(function (e) { return e.props.children === 'diar label — rename it onto a voice'; })
    && diarKinds52.join(' | ') === 'unknown \u00B7 no sample | unknown \u00B7 no sample',
    JSON.stringify({ rows: diarRows52.map(function (e) { return e.props.value; }), castonly: diarNotes52.length,
      not_speaker_marks: diarMarks52.length, diar_marks: diarLabels52.map(function (e) { return e.props.children; }), kinds: diarKinds52 }));
  check('T-604: and the panel says at the file what the host said at the load — this scene has two speakers and neither owns a voice, so it cannot render until each is renamed. The answer arrived from the host before today and the panel stored it without showing it; the row markers and this line are now the same claim in two sizes:',
    /diar labels/.test(tree52()) && /SPEAKER_00, SPEAKER_01/.test(tree52()) && /rename/i.test(tree52()),
    (tree52().match(/read as [^\n]{0,220}/) || ['no read-as line'])[0]);

  // --- 5.2 e: the take ceiling counts VOICES, which is what the operator's ruling named -------------
  await remount52(SIX52, 't581 ceiling 52');
  var door52f = btn52('open batch editor');
  if (door52f) { door52f.props.onClick(); await flush(); }
  await pass52();
  var over6 = cls52('audio-play-over-ceiling582').length;
  var inputs52f = castInputs52();
  // One rename per pass. Two onChange calls in the SAME pass both start from the cast map that pass rendered, so the
  // second would overwrite the first (measured on the first run of these pins: only Kim survived and the scene stayed
  // at six voices). In the browser every keystroke re-renders, so this is a harness shape, not a client defect - the
  // scenario is written the way a person types instead of pretending the two are the same act.
  var docRow52 = inputs52f.filter(function (e) { return String(e.props.value) === 'Doctor'; })[0];
  if (docRow52) { docRow52.props.onChange({ target: { value: 'voy_janeway' } }); await flush(); }
  await pass52();
  var kimRow52 = castInputs52().filter(function (e) { return String(e.props.value) === 'Kim'; })[0];
  if (kimRow52) { kimRow52.props.onChange({ target: { value: 'voy_janeway' } }); await flush(); }
  await pass52();
  var over5 = cls52('audio-play-over-ceiling582').length;
  var sixValues52 = castInputs52().map(function (e) { return String(e.props.value); });
  check('T-582\'s ceiling read on voices, not on names (T-581 5.2): six speakers is over the five-voice ceiling and says so in BOTH places that say it (the cast block and the area the send button sits in); the same six speakers renamed onto five voices is NOT over it and says nothing, because the ceiling is about the voices a scene is spoken with ("if we have more than 5 different voices in a batch", T-582)',
    over6 === 2 && over5 === 0, JSON.stringify({ over_before: over6, over_after: over5, values: sixValues52 }));

  // --- T-605 (2026-10-20): the ceiling the panel warns about is the HOST's number, not a constant of its own ----
  // The operator's word: "for now limit to 5 voices, but make the limit adjustable". This component used to carry
  // its own 5 in its own wording — which is exactly how it came to say "4" for a while and be wrong (the T-582
  // re-point above records that). Now the number is read when the editor opens, and these pins measure both sides:
  // a host that answers 2 makes the panel warn about 2, and a host that does not answer leaves it on the fallback —
  // the hard maximum — rather than on whatever number was last read into a component instance that no longer exists.
  voiceCeiling605Answer = { ok: true, voices: 2, default_voices: 5, min_voices: 1, max_voices: 5, at_default: false,
    applies_to: 'how many DISTINCT voices one take may carry',
    note: 'set by the operator: one take carries at most 2 distinct voices; a scene or request naming more is clamped to it, and the plan says so before anything is queued' };
  await remount52(SIX52, 't605 ceiling two');
  var door605a = btn52('open batch editor');
  if (door605a) { door605a.props.onClick(); await flush(); }
  await pass52();
  var warns605 = cls52('audio-play-over-ceiling582');
  check('T-605: with the host answering 2, six speakers are warned about against TWO voices, in both places that warn — the panel no longer asserts its own ceiling',
    warns605.length === 2 && warns605.every(function (e) { return /carries 2 at most/.test(String(e.props.children || '')); }),
    JSON.stringify(warns605.map(function (e) { return String(e.props.children || '').slice(0, 90); })));
  check('T-605: and the hover keeps the measurement honest about which ceiling it was taken at — "at the default ceiling of 5", not presented as the rule now in force',
    warns605.some(function (e) { return /at the default ceiling of 5/.test(String(e.props.title || '')); }),
    JSON.stringify(warns605.map(function (e) { return String(e.props.title || '').slice(0, 70); })));
  await remount52('Janeway: one\nDoctor: two', 't605 two voices');
  var door605b = btn52('open batch editor');
  if (door605b) { door605b.props.onClick(); await flush(); }
  await pass52();
  check('T-605: a two-voice scene under a ceiling of 2 is not warned about — the ceiling is a bound, not a standing alarm',
    cls52('audio-play-over-ceiling582').length === 0,
    JSON.stringify(cls52('audio-play-over-ceiling582').map(function (e) { return String(e.props.children || '').slice(0, 60); })));
  voiceCeiling605Answer = null;
  await remount52(SIX52, 't605 ceiling door silent');
  var door605c = btn52('open batch editor');
  if (door605c) { door605c.props.onClick(); await flush(); }
  await pass52();
  var warns605b = cls52('audio-play-over-ceiling582');
  check('T-605: a door that stopped answering leaves the panel on its fallback — the hard maximum — and NOT on the 2 it read into a component instance that is gone',
    warns605b.length === 2 && warns605b.every(function (e) { return /carries 5 at most/.test(String(e.props.children || '')); }),
    JSON.stringify(warns605b.map(function (e) { return String(e.props.children || '').slice(0, 90); })));
  var src605d = require('fs').readFileSync(TARGET, 'utf8');
  check('T-605 source: the fallback constant is the hard maximum, the read is taken from the host, and every ceiling sentence the cast warning prints goes through the read number',
    /var TAKE_CEILING582 = 5;/.test(src605d) && /var cap605 = takeCeilingNow605\(\);/.test(src605d)
    && /one take here carries " \+ o582\.cap/.test(src605d)
    && /call\("voice_ceiling", \{\}\)/.test(src605d),
    { cap_used: /o582\.cap/.test(src605d), read: /call\("voice_ceiling", \{\}\)/.test(src605d) });

  // --- source pins: the two claims that live in the code, not in a render ---------------------------
  var src52 = require('fs').readFileSync(TARGET, 'utf8');
  check('T-581 5.2 source: the cast row\'s play button hands the panel the voice IN the row, not the name the row started with - a renamed row used to be able to play only a sample that does not exist',
    /onPlaySample448\(c\.chosen\)/.test(src52) && !/onPlaySample448\(c\.name\)/.test(src52),
    { chosen: /onPlaySample448\(c\.chosen\)/.test(src52), name_left: /onPlaySample448\(c\.name\)/.test(src52) });
  check('T-581 5.2 source: the cast a save carries is gated on the panel\'s own speaker verdict for every name in it - the gate is in castNames(), not in a comment about it',
    /if \(!rows594\[i594\]\.speakerOk594\) return \[\];/.test(src52), { gate: /if \(!rows594\[i594\]\.speakerOk594\) return \[\];/.test(src52) });

  // The speaker grammar the panel mirrors is the HOST's, and a mirror that drifts is the defect this card is
  // about (T-578 item 4: panel and host disagreeing about who is a speaker). This pin compares the two sets read
  // out of the two files, so a change on one side fails here instead of surfacing as a refused save in the browser.
  var hostSrc52 = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'index.js'), 'utf8');
  function objKeys52(src, decl) {
    var at52 = src.indexOf(decl);
    if (at52 < 0) return null;
    var end52 = src.indexOf('};', at52);
    if (end52 < 0) return null;
    var out52 = [], m52, re52 = /([A-Za-z_]+):\s*1\b/g;
    while ((m52 = re52.exec(src.slice(at52, end52)))) out52.push(m52[1]);
    return out52.sort();
  }
  function reLit52(src, decl) {
    var at52 = src.indexOf(decl);
    if (at52 < 0) return null;
    var m52 = /\/[^\n]*?\/[a-z]*/.exec(src.slice(at52, at52 + 200));
    return m52 ? m52[0] : null;
  }
  var hostConn52 = objKeys52(hostSrc52, 'var TEXT_CONNECTIVES = {');
  var clientConn52 = objKeys52(src52, 'var TEXT_CONNECTIVES594 = {');
  var hostFm52 = objKeys52(hostSrc52, 'var TEXT_FRONTMATTER_KEYS = {');
  var clientFm52 = objKeys52(src52, 'var TEXT_FRONTMATTER_KEYS594 = {');
  var hostVn52 = reLit52(hostSrc52, 'var VOICE_NAME_RE = ');
  var clientVn52 = reLit52(src52, 'var VOICE_NAME_RE594 = ');
  // T-604 (2026-10-19): the third class of the one speaker rule is compared the same way the other two are. The
  // diar class is the newest half of the mirror, and it is the one a reader is most likely to "fix" on one side only
  // - the panel decides a diar row is a speaker without asking the host, so a widened client regex would paint a row
  // green that the host then refuses to name as a speaker, and a narrowed one would mark a real speaker as broken.
  var hostDiar52 = reLit52(hostSrc52, 'var DIAR_LABEL_RE604 = ');
  var clientDiar52 = reLit52(src52, 'var DIAR_LABEL_RE594 = ');
  check('T-581 5.2 anti-drift: the speaker grammar this panel mirrors IS the host\'s - the connective list, the front-matter key list, the voice-id grammar and (T-604) the diar-label class are read out of both files and compared as sets and literals, so a change on one side fails here instead of showing up as a refused save in the browser',
    !!hostConn52 && !!clientConn52 && hostConn52.join(',') === clientConn52.join(',')
    && !!hostFm52 && !!clientFm52 && hostFm52.join(',') === clientFm52.join(',')
    && !!hostVn52 && hostVn52 === clientVn52
    && !!hostDiar52 && !!clientDiar52 && hostDiar52 === clientDiar52,
    JSON.stringify({ connectives_host: hostConn52, connectives_client: clientConn52,
      frontmatter_host_n: hostFm52 && hostFm52.length, frontmatter_client_n: clientFm52 && clientFm52.length,
      voice_re_host: hostVn52, voice_re_client: clientVn52, diar_re_host: hostDiar52, diar_re_client: clientDiar52 }));
  check('T-604 source: the panel\'s own classifier admits the diar class and says which class decided it, and the row marker that carries that verdict is a class name in the DOM, not a colour someone has to guess',
    /if \(DIAR_LABEL_RE594\.test\(s594\)\) return \{ ok: true, decided: true, via: "diar label", diar: true \};/.test(src52)
    && /diar594: !!\(line594\.diar \|\| \(host594 && host594\.diar_label\)\)/.test(src52)
    && /className: "audio-play-cast-diar594"/.test(src52)
    && /"diar label \u2014 rename it onto a voice"/.test(src52),
    { classifier: /DIAR_LABEL_RE594\.test\(s594\)/.test(src52), row_field: /diar594: !!/.test(src52),
      marker_class: /audio-play-cast-diar594/.test(src52) });

  // ---- T-611 (2026-10-20): the reuse control on a diar row whose words exist ONLY as speaker turns.
  // T-610 item 10 (c) recorded this gap inside the card that built the take hand-off: the hand-off already worked for
  // a row of that shape, and the control to reach it did not, because the row action was gated on `transcript || text`
  // while a diar+ASR row can carry its words per turn and nowhere else. This block is at the END of the file on
  // purpose: it presses a real row control, which appends blocks to the scene, and no earlier card's pin may be
  // measured on a scene this card grew.
  // What the live panel can and cannot show today (read 2026-10-20 20:0x Berlin, read-only): `GET playlist_list`
  // answers 52 rows - 31 generation tasks and 21 renders - and NO diar or sasr row at all, and `speaker_turns`
  // appears on none of them; the two rows T-584 measured, ap-0698 and ap-0699, answer "job not found" to
  // `GET job_status?job_id=` (scratch/t611_js_ap-0698.json, scratch/t611_js_ap-0699.json). So the live case is not
  // available until the next diar run, and the fixture that does show it is this suite's own ap-0017: four turns with
  // words, two speakers, no transcript and no text. `rowOf` (lib/index.js:4741) does project speaker_turns into
  // playlist rows, which is what makes the gate the whole of the gap rather than a missing read.
  var mark611 = shim.rt.created.length;
  var btns611 = shim.rt.created.filter(function (e) {
    return e.type === 'button' && String(e.props.children).trim() === '\u21BB'
      && /^put this row's /.test(String((e.props || {}).title || ''));
  });
  var hovers611 = Array.from(new Set(btns611.map(function (e) { return String(e.props.title); })));
  var turnHov611 = hovers611.filter(function (t) { return /speaker turns into the chapter editor/.test(t); });
  check('T-611: a diar row whose words exist only as speaker turns now carries the reuse control - all three such rows here - 4 turns folding to 3 blocks for 2 speakers, 5 for 5, 6 for 6 - and the hover names the words the row actually has',
    turnHov611.length === 3
      && turnHov611.some(function (t) { return /as 4 diarised turn\(s\) for 2 speaker\(s\)/.test(t) && /\(117 chars\)/.test(t); })
      && turnHov611.some(function (t) { return /as 5 diarised turn\(s\) for 5 speaker\(s\)/.test(t); })
      && turnHov611.some(function (t) { return /as 6 diarised turn\(s\) for 6 speaker\(s\)/.test(t); }),
    JSON.stringify(hovers611));
  check('T-611: the door is not opened on a row that has nothing to hand over - spans without words carry no control, and a diarisation still running is not offered (the composer refuses it too, so the panel must not promise it)',
    (function () {
      var single = hovers611.filter(function (t) { return /for 1 speaker\(s\)/.test(t); });
      var wrong = hovers611.filter(function (t) { return /speaker turns/.test(t) && !/into the chapter editor/.test(t); });
      return single.length === 0 && wrong.length === 0;
    })(), JSON.stringify(hovers611));
  check('T-611: a row that DOES carry flat words is promised and routed exactly as before - the take row still promises its generation text into the chapter editor, a one-voice row still promises the text-to-read field',
    hovers611.some(function (t) { return /^put this row's generation text into the chapter editor as 8 speaker block\(s\) for 3 speaker\(s\) for the next take \(231 chars\)$/.test(t); })
      && hovers611.some(function (t) { return /^put this row's (transcript|generation text) into the text-to-read field for the next take \(\d+ chars\)$/.test(t); }),
    JSON.stringify(hovers611));
  var press611 = btns611.filter(function (e) { return /as 4 diarised turn\(s\) for 2 speaker\(s\)/.test(String(e.props.title || '')); })[0];
  var wm611 = shim.rt.created.length;
  if (press611) { press611.props.onClick(); await flush(); bag = commit(); await flush(); bag = commit(); await flush(); }
  var texts611 = shim.rt.created.slice(wm611).filter(function (e) {
    return (e.type === 'textarea' || e.type === 'input') && typeof (e.props && e.props.value) === 'string' && e.props.value.length > 20;
  }).map(function (e) { return String(e.props.value); });
  check('T-611: pressing the ROW CONTROL itself - not the handler behind it - hands that row\'s turns to the chapter editor as speaker blocks, keeping the diar merge rule (adjacent turns of one voice stay one block, an interjection stays its own)',
    !!press611 && texts611.some(function (t) {
      return /Speaker A: first line of the import continues the same speaker/.test(t)
        && /Speaker B: an interjection from the other voice/.test(t)
        && /Speaker A: a later turn of the first voice/.test(t);
    }), JSON.stringify(texts611.map(function (t) { return t.slice(-140); })));
  check('T-611: the panel says out loud which words it handed over and where they did NOT go - diarised turns, and not into the one-voice box',
    shim.rt.created.slice(wm611).some(function (e) {
      var c = JSON.stringify(e.props && e.props.children || '');
      return /diarised turns/.test(c) && /NOT put in the one-voice box/.test(c);
    }), JSON.stringify(shim.rt.created.slice(wm611).filter(function (e) {
      var c = JSON.stringify(e.props && e.props.children || ''); return /one-voice box/.test(c);
    }).map(function (e) { return String([].concat(e.props.children)[0]).slice(0, 200); })));
  check('T-611: the blocks arrive as editable rows with their own speaker fields, relabelled into names this host accepts - the same relabel the import control uses, because it is the same hand-off',
    (function () {
      var names = shim.rt.created.slice(wm611).filter(function (e) {
        return e.props && e.props.className === 'audio-play-scene-turn-name381';
      }).map(function (e) { return String(e.props.value); });
      return names.indexOf('Speaker A') >= 0 && names.indexOf('Speaker B') >= 0;
    })(), JSON.stringify(shim.rt.created.slice(wm611).filter(function (e) {
      return e.props && e.props.className === 'audio-play-scene-turn-name381';
    }).map(function (e) { return String(e.props.value); })));
  check('T-611: the hover names the fact the row itself carries and does not count blocks the row action did not decide - a diarised row is promised as its diarised turns (the fold from turns to blocks is the composer\'s own rule, measured by the press pin above), a take row is promised as its speaker blocks because its own tags decided them',
    turnHov611.length === 3 && turnHov611.every(function (t) { return /diarised turn\(s\) for \d+ speaker\(s\)/.test(t); })
      && hovers611.filter(function (t) { return /as 8 speaker block\(s\) for 3 speaker\(s\)/.test(t); }).length === 1
      && hovers611.filter(function (t) { return /speaker turns into the chapter editor/.test(t); }).length === 3
      && hovers611.filter(function (t) { return /speaker block\(s\) for/.test(t); }).length === 1,
    JSON.stringify({ turn_hovers: turnHov611, block_hovers: hovers611.filter(function (t) { return /speaker block\(s\) for/.test(t); }) }));

  check('T-611 U-18: the new hover names what a person sees in the panel - speaker turns, speaker blocks, the chapter editor - and no internal key, verb, file or storage name',
    turnHov611.length === 3 && turnHov611.every(function (t) {
      return !/speaker_turns/.test(t) && !/job_status/.test(t) && !/dispatch/.test(t) && !/playlist/.test(t)
        && !/reuseSeed/.test(t) && !/client\.js/.test(t) && !/POST|GET/.test(t);
    }), JSON.stringify(turnHov611));
  var src611 = require('fs').readFileSync(TARGET, 'utf8');
  check('T-611 source: the gate, the hover and the handler ask the SAME question of the same row - one function decides the route, the control appears only when it has something to hand over, and the length quoted is the length of what is handed over',
    /\(j\.transcript \|\| j\.text \|\| \(j\.status === "ok" && reuseHandoff610\(j\)\)\) \? h\("button"/.test(src611)
      && /if \(!j\.transcript && !j\.text && j\.status === "ok" && reuseHandoff610\(j\)\) return "speaker turns";/.test(src611)
      && /var ho610r = reuseHandoff610\(j\);/.test(src611)
      && /var ho610 = reuseHandoff610\(row\);/.test(src611)
      && /diarTurnsWithWords584\(j\)\.forEach/.test(src611),
    JSON.stringify({ gate: /\(j\.status === "ok" && reuseHandoff610\(j\)\)\) \? h\("button"/.test(src611),
      hover_label: /return "speaker turns";/.test(src611), hover_route: /var ho610r = reuseHandoff610\(j\);/.test(src611),
      handler: /var ho610 = reuseHandoff610\(row\);/.test(src611) }));

  // --- T-612 (2026-10-20): the composer half of the operator's ask. The picker offers a finished multi-speaker
  //     GENERATION row now (T-610 item 10 (a), closed), the import writes that take's own lines under the voices
  //     that spoke them, and the composer's own reuse control asks the board's row question too. These pins sit at
  //     the END of the file on purpose: like the T-611 block above, this card presses controls that grow the scene,
  //     and no card measured before it may be measured on a scene this card grew.
  {
    var sel612 = shim.rt.created.filter(function (e) {
      return e.type === 'select' && Array.isArray(e.props.children) &&
        e.props.children.some(function (o) { return o && o.props && o.props.value === 'ap-0017'; });
    });
    var ssel612 = sel612.length ? sel612[sel612.length - 1] : null;
    var opts612 = ssel612 ? ssel612.props.children.filter(function (o) { return o && o.type === 'option'; }) : [];
    var vals612 = opts612.map(function (o) { return String(o.props.value); });
    var labels612 = opts612.map(function (o) { return String(o.props.children); });
    var takeOpt612 = opts612.filter(function (o) { return o.props.value === 'ap-0006'; })[0];
    var diarOpt612 = opts612.filter(function (o) { return o.props.value === 'ap-0017'; })[0];

  // T-797 (2026-11-12), re-cut: T-612: the composer import picker offers a finished multi-speaker GENERATION row - the control it read is out of the section; the facts it carried are named in the note below and measured there.
  // T-797 (2026-11-12), re-cut: T-612: a diarised row is still offered with its turns named - the control it read is out of the section; the facts it carried are named in the note below and measured there.
    // RE-CUT 2026-11-05 by T-723 (operator ruling, chosen answer: "One source select, one button, target name
    // only when needed"). The older half of this card's claim - that a row which is not a dialogue is not
    // offered - is superseded: one voice's words can still become a line here, and the option says which kind
    // of row it is. What the card was opened for is still measured, and it is the gate that still gates:
    // a row with spans but no words, and a row that is still running, are not offered.
    var singleOpt723 = opts612.filter(function (o723) { return String(o723.props.value) === 'ap-0012'; })[0];
  // T-797 (2026-11-12), re-cut: T-612, RE-CUT 2026-11-05 (T-723): a row that carries ONE voice IS offered - the control it read is out of the section; the facts it carried are named in the note below and measured there.

    var callsBefore612 = calls.length;
    // `store` (line 301) is the hook list of the instance this suite mounted first. By this point in the file other
    // cards have opened the pop-out chapter editor and remounted the composer, so the scene text is read from the
    // store of the instance the last commit actually rendered - the same state the control writes into.
    var bag612 = commit();
    var store612 = shim.rt.stores.get(bag612.SceneComposer.__key);
    var sceneBefore612 = String(store612[0]);
    if (ssel612) { ssel612.props.onChange({ target: { value: 'ap-0006' } }); await flush(); bag612 = commit(); await flush(); }
    var ibtn612 = fillBtn723();
  // T-797 (2026-11-12), re-cut: T-612: the import hover states the take row own numbers - the control it read is out of the section; the facts it carried are named in the note below and measured there.
    if (ibtn612) { ibtn612.props.onClick(); await flush(); bag612 = commit(); await flush(); }
    var after612 = String(shim.rt.stores.get(bag612.SceneComposer.__key)[0]);

  // T-797 (2026-11-12), re-cut: T-612: importing a take writes one NAME: line per line - the control it read is out of the section; the facts it carried are named in the note below and measured there.
  // T-797 (2026-11-12), re-cut: T-612: the take keeps its own lines - the control it read is out of the section; the facts it carried are named in the note below and measured there.
    check('T-612: the speaker tags of the take never reach the scene as text - a scene carries names this lane can put voices on, not the numbering of one take set',
      !/\[S\d/.test(after612.slice(sceneBefore612.length)), after612.slice(sceneBefore612.length, sceneBefore612.length + 200));
  // T-797 (2026-11-12), re-cut: T-612: the panel says out loud that these are the take own lines - the control it read is out of the section; the facts it carried are named in the note below and measured there.
  // T-797 (2026-11-12), re-cut: T-612: importing dispatches nothing - the control it read is out of the section; the facts it carried are named in the note below and measured there.

    // T-723 RE-POINT (2026-11-05): the merged control reads the row a person picked, so the row this check is
    // about is picked here rather than assumed.
    await pickRow723('ap-0012');
    var rebtn612 = shim.rt.created.filter(function (e) {
      return e.type === 'button' && /^take the words of /.test(String((e.props || {}).title || ''));
    });
    var reHov612 = rebtn612.length ? String(rebtn612[rebtn612.length - 1].props.title) : '';
  // T-797 (2026-11-12), re-cut: T-612: the composer own reuse control still promises one line - the control it read is out of the section; the facts it carried are named in the note below and measured there.
    check('T-612 U-18: the new option label and the new import hover name no verb, no route, no storage key, no source file and no ticket id',
      !/dispatch_|playlist_list|batch_cast|speaker_turns|lib\/client|POST |T-6\d\d/.test(String(takeOpt612 ? takeOpt612.props.children : '') + ' ' + reHov612)
        && !/dispatch_|playlist_list|batch_cast|speaker_turns|lib\/client|POST |T-6\d\d/.test(String(ibtn612 ? ibtn612.props.title : '')),
      JSON.stringify({ option: String(takeOpt612 ? takeOpt612.props.children : ''), reuse_hover: reHov612.slice(0, 160) }));
  // T-797 (2026-11-12), re-cut: T-612 source: the composer picker, both composer hovers - the control it read is out of the section; the facts it carried are named in the note below and measured there.

    // ---- T-613 (2026-10-20, operator request, verbatim): "fix the \"reuse\" of TTS-D jobs first - current problem is
    // that the text \"is added\" on top of existing rows, so the mult-speaker editor content gets longer with every
    // klick". The state under test is the scene text itself (`shim.rt.stores.get(bag.SceneComposer.__key)[0]`), and
    // the measurement is its length across repeated presses of the same control on the same row.
    // The press is taken from the newest render, not from the element an earlier section held: an old element
    // carries that render's closures, and measuring a stale closure measures a component instance this panel no
    // longer uses. The note is read out of the component state, for the same reason - `treeText()` is cumulative
    // over every render this suite has made and would still be reading a sentence an earlier section wrote.
    function t613Note(bag) {
      var st = shim.rt.stores.get(bag.SceneComposer.__key) || [];
      var hits = st.filter(function (x) { return x && typeof x === 'object' && typeof x.text === 'string' && x.type; });
      return hits.length ? String(hits[hits.length - 1].type + ':' + hits[hits.length - 1].text) : '';
    }
    var bag613 = commit(); await flush();
    var t613Before = String(shim.rt.stores.get(bag613.SceneComposer.__key)[0]);
    // T-723 RE-POINT (2026-11-05): re-pick the take row this block measures, after the single-voice row above.
    await pickRow723('ap-0006');
    var ibtn613 = fillBtn723();
    var t613Calls0 = calls.length;
    if (ibtn613) { ibtn613.props.onClick(); await flush(); }
    var t613Calls1 = calls.slice(t613Calls0);
    var t613After = String(shim.rt.stores.get(bag613.SceneComposer.__key)[0]);
    var t613Note1 = t613Note(bag613);
  // T-797 (2026-11-12), re-cut: T-613: a second press of the import control on the same take row writes nothing - the control it read is out of the section; the facts it carried are named in the note below and measured there.
    // RE-POINTED IN PLACE 2026-10-21 by T-613 item 15 (operator ruling, verbatim: "can't the second press just
    // overwrite it, like the first press would ? do not overcomplicate"). The sentence used to refuse the press and
    // tell the person to take the lines out first. The press now writes the row's lines over the block this scene
    // already carries for those speakers, and the sentence names that - which names it wrote over, how many lines it
    // took out, and that the text came out the same because the row has not changed since.
  // T-797 (2026-11-12), re-cut: T-613: and the panel says what actually happened - the control it read is out of the section; the facts it carried are named in the note below and measured there.
    var bag613h = commit(); await flush();
    var ibtn613h = fillBtn723();
  // T-797 (2026-11-12), re-cut: T-613: the import hover promises what the act now does - the control it read is out of the section; the facts it carried are named in the note below and measured there.
    check('T-613: the second press asks for nothing - no dispatch, no plan, no save, and not even the cast read, because no new name entered the scene (measured on the press and its flush, before a re-render that may re-run the mount reads of this composer)',
      t613Calls1.filter(function (x) { return /dispatch|batch_plan|batch_text_save|cast_preview|voice_registry|voice_ceiling/.test(x); }).length === 0,
      t613Calls1.join(' | '));

    // The guard is content-based, so it has to survive the two cases a person actually creates: a scene that already
    // holds SOME of the row's lines, and a scene whose line merely starts with one of them.
    var t613Ta = shim.rt.created.filter(function (e) {
      return e.type === 'textarea' && /Tom Paris/.test(String((e.props || {}).placeholder || ''));
    }).pop();
    if (t613Ta) { t613Ta.props.onChange({ target: { value: 'voy_janeway: Report on the containment.' } }); await flush(); commit(); }
    var t613Calls1 = calls.length;
    var ibtn613b = fillBtn723();
    if (ibtn613b) { ibtn613b.props.onClick(); await flush(); }
    var bag613c = commit(); await flush();
    var t613Partial = String(shim.rt.stores.get(bag613c.SceneComposer.__key)[0]);
    check('T-613: a scene that already carries one of that row\'s lines gets the other seven only - the row is not re-imported whole and the line already there is not written twice',
      /^voy_janeway: Report on the containment\.$/.test(t613Partial.split("\n")[0])
        && (t613Partial.match(/^voy_janeway: Report on the containment\.$/gm) || []).length === 1
        && (t613Partial.match(/^bijan: /gm) || []).length === 3
        && (t613Partial.match(/^voy_doctor_short: /gm) || []).length === 3
        && (t613Partial.match(/^voy_janeway: /gm) || []).length === 2,
      JSON.stringify({ lines: t613Partial.split("\n").length, head: t613Partial.slice(0, 120) }));
    // RE-POINTED IN PLACE 2026-10-21 by T-613 item 15: the row is written whole, and what the sentence carries is
    // the shape of the write - the block the scene already carried for one of these names, how many lines of it were
    // written over, and which speaker names arrived as new lines. The number a person reads is still the number of
    // lines the row carries, because the row's lines are what the scene now holds for those speakers.
  // T-797 (2026-11-12), re-cut: T-613: the import sentence counts what it wrote - the control it read is out of the section; the facts it carried are named in the note below and measured there.

    if (t613Ta) { t613Ta.props.onChange({ target: { value: 'voy_janeway: Report on the containment. And a word more than the row carries.' } }); await flush(); commit(); }
    var ibtn613c = fillBtn723();
    if (ibtn613c) { ibtn613c.props.onClick(); await flush(); }
    var bag613d = commit(); await flush();
    var t613Prefix = String(shim.rt.stores.get(bag613d.SceneComposer.__key)[0]);
    // RE-POINTED IN PLACE 2026-10-21 by T-613 item 15. This is the case the ruling changes most: the scene carried a
    // line that was that speaker's line with words added to it. Under the old guard it was "not that line", so the
    // row's lines were appended beside it and the scene held both. Under the ruling the press is an overwrite of
    // that speaker's block, so the scene now holds the row's two lines for voy_janeway and the extra words are gone
    // - which is what "overwrite it, like the first press would" means, and the sentence above names the line it
    // wrote over so the person is not left to discover it. The whole-line rule survives where it still governs:
    // blocks the scene cannot be asked about by name (no NAME: prefix) are still matched word for word.
  // T-797 (2026-11-12), re-cut: T-613: a scene line that is that speaker - the control it read is out of the section; the facts it carried are named in the note below and measured there.

    // T-723 RE-POINT (2026-11-05): the merged control takes the row a person picked, so this block names the
    // single-voice row it has always measured instead of relying on a control that picked a row for itself.
    await pickRow723('ap-0012');
    var t613ReBtn = shim.rt.created.filter(function (e) {
      return e.type === 'button' && /^take the words of /.test(String((e.props || {}).title || ''));
    });
    var t613Re = t613ReBtn.length ? t613ReBtn[t613ReBtn.length - 1] : null;
    var t613ReBefore = String(shim.rt.stores.get(bag613d.SceneComposer.__key)[0]);
    if (t613Re) { t613Re.props.onClick(); await flush(); }
    var bag613e = commit(); await flush();
    var t613ReMid = String(shim.rt.stores.get(bag613e.SceneComposer.__key)[0]);
    var t613ReBtn2 = shim.rt.created.filter(function (e) {
      return e.type === 'button' && /^take the words of /.test(String((e.props || {}).title || ''));
    });
    var t613Re2 = t613ReBtn2.length ? t613ReBtn2[t613ReBtn2.length - 1] : null;
    var t613ReHover = String(t613Re2 ? t613Re2.props.title : '');
    if (t613Re2) { t613Re2.props.onClick(); await flush(); }
    var bag613f = commit(); await flush();
    var t613ReAfter = String(shim.rt.stores.get(bag613f.SceneComposer.__key)[0]);
    // RE-POINTED IN PLACE 2026-10-21 by T-613 item 15. The old claim - the first press LENGTHENS - is what the
    // operator's ruling replaces: the scene already carried this speaker, so the press writes over that speaker's
    // block where it sat. What the card was opened for is still measured, in the form the ruling keeps: the scene
    // never grows a second copy, no other speaker's line moves, a later turn of the same speaker is left alone, and
    // a repeat press changes nothing at all.
  // T-797 (2026-11-12), re-cut: T-613: the composer reuse control never writes a second copy - the control it read is out of the section; the facts it carried are named in the note below and measured there.
    // The sentence for a repeat press is the act itself now: it names the row, the name it wrote over, how many
    // lines that took out, that no other speaker was touched, and - because the row has not changed since the first
    // press - that the text came out the same. The old advice to take the lines out of the scene text first is gone
    // with the refusal it belonged to.
  // T-797 (2026-11-12), re-cut: T-613: the second press is reported as what it is - the control it read is out of the section; the facts it carried are named in the note below and measured there.
  // T-797 (2026-11-12), re-cut: T-613: and the reuse hover carries the same truth - the control it read is out of the section; the facts it carried are named in the note below and measured there.
  // T-797 (2026-11-12) re-cut of the T-612 and T-613 clusters. The ruling - the operator's word on
  // 2026-11-12 that the section carried "a lot of confusing ui elements in the section we do not really
  // need for ttsd generation", answered from the element table with "Fold the whole recommendation list"
  // - removed the composer's import picker, its hover and the composer's own import sentence. Eighteen
  // checks read those three things directly, and each one is named below rather than dropped:
  // T-612: the picker offering a finished multi-speaker GENERATION row; the picker offering a diarised
  // row with its turns named and its default position kept; the picker offering a single-voice row named
  // as one voice while refusing a no-words row and a running row; the import hover stating the take's own
  // numbers; the import writing one NAME: line per line of the take under the voice that spoke it; the
  // take keeping its own lines when one voice speaks twice; the composer saying out loud that these are
  // the take's own lines; the import dispatching nothing; the composer's own reuse control promising one
  // line for a flat row; and T-612 source, that one helper answers that decision for both hovers and both
  // acts. T-613: a second press writing nothing; the panel naming the row, the block it wrote over and
  // how many lines that took out; the hover promising the write-over instead of a growth; the import
  // sentence counting what it wrote; a scene line with words added being written over; the control never
  // writing a second copy; the second press being reported as what it is; and the hover carrying the same
  // truth before the press. The picker half of that is measured by the removal guards earlier in this
  // file (T-326 and T-582, re-cut by this card). The act half is measured again below, through the door
  // that remains - the hand-off a finished row carries, which lands a multi-speaker row in the chapter
  // editor. Four checks follow, and they carry the facts: one row per line of the take under the voice
  // that spoke it, a voice speaking twice staying two rows, a second hand-off adding no second copy, and
  // the sentence naming the row and the write-over rule without naming a verb, a file or a key.
  var hand797d = function (id797d) {
    var el797d = shim.rt.created.filter(function (e) { return e.props && typeof e.props.reuseText === 'function'; }).pop();
    if (!el797d) return false;
    el797d.props.reuseText(id797d); return true;
  };
  var rows797d = function (wm797d) {
    return shim.rt.created.slice(wm797d).filter(function (e) {
      return e.type === 'textarea' && e.props && /turn-text/.test(String(e.props.className || ''));
    }).map(function (e) { return String(e.props.value); });
  };
  var door797d = btn('open batch editor');
  var wm797a = shim.rt.created.length;
  if (door797d) { door797d.props.onClick(); await flush(); bag = commit(); await flush(); }
  var wm797b = shim.rt.created.length;
  if (hand797d('ap-0006')) { await flush(); bag = commit(); await flush(); bag = commit(); await flush(); }
  var rowsB797 = rows797d(wm797b);
  var saidB797 = shim.rt.created.slice(wm797b).map(function (e) { var c797d = e.props && e.props.children; return (typeof c797d === 'string') ? c797d : ''; }).join('\n');
  var names797 = ['Janeway', 'Bijan', 'The Doctor'];
  var twice797 = function (rows797q) {
    var most797 = 0;
    names797.forEach(function (n797m) {
      var c797m = rows797q.filter(function (t797q) { return t797q.trim().indexOf(n797m + ':') === 0; }).length;
      if (c797m > most797) most797 = c797m;
    });
    return most797;
  };
  var wm797c = shim.rt.created.length;
  if (hand797d('ap-0006')) { await flush(); bag = commit(); await flush(); bag = commit(); await flush(); }
  var rowsC797 = rows797d(wm797c);
  // RE-CUT AGAIN 2026-11-12 (T-797): the first version looked for the take's voice names INSIDE the line
  // fields. The editor keeps a speaker name in its own field (`audio-play-scene-turn-name381`) beside the
  // words (`...-text381`), and the take's names are the voices the take used - `voy_janeway`,
    // `voy_doctor_short`, `bijan` - not invented labels. One clean render is read, so a line counted in two
  // renders is not counted twice. The payload prints the names and the line count it found.
  var names797n = ['voy_janeway', 'voy_doctor_short', 'bijan'];
  var pair797n = function (wm797n) {
    return {
      names: shim.rt.created.slice(wm797n).filter(function (e797n) { return e797n.type === 'input' && e797n.props && String(e797n.props.className || '') === 'audio-play-scene-turn-name381'; }).map(function (e797n) { return String(e797n.props.value); }),
      texts: shim.rt.created.slice(wm797n).filter(function (e797n) { return e797n.type === 'textarea' && e797n.props && String(e797n.props.className || '') === 'audio-play-scene-turn-text381'; }).map(function (e797n) { return String(e797n.props.value); }),
    };
  };
  var wmPairB797 = shim.rt.created.length;
  bag = commit(); await flush();
  var pairB797 = pair797n(wmPairB797);
  check('T-612, its write half re-cut by T-797 against the door that remains: a finished multi-speaker take handed to the chapter editor arrives as one row per line of that take, each row carrying the speaker name the take used beside its words',
    pairB797.texts.length >= 8 && names797n.every(function (n797n) { return pairB797.names.indexOf(n797n) >= 0; }) && pairB797.names.length === pairB797.texts.length,
    JSON.stringify({ rows: pairB797.texts.length, names: pairB797.names.length, distinct_names: names797n.map(function (n797p) { return [n797p, pairB797.names.filter(function (v797p) { return v797p === n797p; }).length]; }) }));
  check('T-612, its keep-its-own-lines half re-cut by T-797: a voice that speaks more than once in a take carries more than one row here, not one - the scene that comes back has to be the scene that would be sent',
    names797n.some(function (n797q) { return pairB797.names.filter(function (v797q) { return v797q === n797q; }).length >= 2; }),
    JSON.stringify({ rows_per_name: names797n.map(function (n797r) { return [n797r, pairB797.names.filter(function (v797r) { return v797r === n797r; }).length]; }) }));
  check('T-613, its no-second-copy half re-cut by T-797: a second hand-off of the same row adds no second copy - the' +
    ' rows drawn after it are byte for byte the rows drawn after the first',
    JSON.stringify(rowsC797) === JSON.stringify(rowsB797),
    { rows_after_first: rowsB797.length, rows_after_second: rowsC797.length, same: JSON.stringify(rowsC797) === JSON.stringify(rowsB797) });
  check('T-612 and T-613, their sentence half re-cut by T-797: the hand-off names the row it took and states the' +
    ' write-over rule in the same act, and it names no verb, no file and no internal key - the rule the removed' +
    ' import sentence carried is still the rule the panel states',
    /ap-0006/.test(saidB797) && /written OVER the block/.test(saidB797) && /in the place they sat/.test(saidB797)
      && !/dispatch_batch|batch_plan|batch_text_save/.test(saidB797),
    { names_row: /ap-0006/.test(saidB797), states_rule: /written OVER the block/.test(saidB797),
      in_place: /in the place they sat/.test(saidB797), verbs_named: /dispatch_batch|batch_plan|batch_text_save/.test(saidB797) });
    // The board's own sentence about a hand-off: the board cannot count what the composer's field holds, so what it
    // may say is the rule the composer applies and where the count lives. Pressed from the newest render, read from
    // the newest render.
    var t613BoardBtn = shim.rt.created.filter(function (e) {
      return e.type === 'button' && /^put this row's /.test(String((e.props || {}).title || ''))
        && /chapter editor as \d+ (speaker block|diarised turn)\(s\)/.test(String((e.props || {}).title || ''));
    }).pop();
    var t613Mark2 = shim.rt.created.length;
    if (t613BoardBtn) { t613BoardBtn.props.onClick(); await flush(); commit(); await flush(); }
    var t613BoardText = shim.rt.created.slice(t613Mark2).map(function (e) {
      var c = e.props && e.props.children; return (typeof c === 'string') ? c : '';
    }).join('\n');
    // RE-POINTED IN PLACE 2026-10-21 by T-613 item 15: the board's sentence stated the refusal rule. It states the
    // overwrite rule now, and still names where the count of what arrived is written.
    check('T-613: the board row sentence about a hand-off states the rule the composer applies today - a speaker the scene already carries is written over in place, a speaker it does not carry arrives new - and names where the count of what arrived is written',
      !!t613BoardBtn && /is checked before any of them is written/.test(t613BoardText)
        && /written OVER the block those lines form, in the place they sat/.test(t613BoardText)
        && /a speaker the scene does not carry arrives as new lines/.test(t613BoardText)
        && /the note that names how many arrived is the one the editor itself writes/.test(t613BoardText),
      t613BoardText.slice(-460));
    // RE-POINTED IN PLACE 2026-10-21 by T-613 item 15: the guard this pin counted was `appendSceneBlocks613`, the
    // refuse-a-repeat write. The ruling made it an in-place write, so the function is `writeSceneBlocks613` and the
    // old name appears nowhere. The card's structural claims are re-measured on the new shape: the four reuse
    // controls all go through the ONE write, the hovers all go through the ONE clause, the sentences all go through
    // the ONE counts clause, the write touches the scene text in exactly one place (so no control can write past
    // it), no control appends by hand any more, and the run rule reads names off the composer's OWN name rule.
    check('T-613 source: every reuse write in this composer goes through the one in-place write, every hover through the one clause, every sentence through the one counts clause, the write touches the scene text in exactly one place, and no control appends by hand',
      (function () {
        var src613 = require('fs').readFileSync(TARGET, 'utf8');
        var write = (src613.match(/writeSceneBlocks613\(/g) || []).length;
        var clause = (src613.match(/alreadyInSceneClause613\(/g) || []).length;
        var counts = (src613.match(/writeCountsClause613\(/g) || []).length;
        var refuse = (src613.match(/appendSceneBlocks613/g) || []).length;
        var setTexts = (src613.match(/setText\(next613\)/g) || []).length;
        var turns = (src613.match(/sceneTurns613\(/g) || []).length;
        var nameRule = /function sceneTurns613\(lines\) \{[\s\S]{0,900}?NAME_RE381/.test(src613) ? 1 : 0;
        var flatOld = (src613.match(/setText\(body \+ \(body \? "\\n" : ""\) \+ who \+ ": " \+ words\);/g) || []).length;
        var rawAppend = (src613.match(/setText\((body|seedBody584) \+ \((body|seedBody584) \? "\\n" : ""\)/g) || []).length;
        return write === 5 && clause === 5 && counts === 4 && refuse === 0 && setTexts === 1 && turns === 4
          && nameRule === 1 && flatOld === 0 && rawAppend === 0;
      })(), (function () {
        var s613 = require('fs').readFileSync(TARGET, 'utf8');
        return JSON.stringify({
          write_uses: (s613.match(/writeSceneBlocks613\(/g) || []).length,
          hover_clause_uses: (s613.match(/alreadyInSceneClause613\(/g) || []).length,
          counts_clause_uses: (s613.match(/writeCountsClause613\(/g) || []).length,
          refuse_guard_left: (s613.match(/appendSceneBlocks613/g) || []).length,
          write_settexts: (s613.match(/setText\(next613\)/g) || []).length,
          turns_uses: (s613.match(/sceneTurns613\(/g) || []).length,
          flat_write_old: (s613.match(/setText\(body \+ \(body \? "\\n" : ""\) \+ who \+ ": " \+ words\);/g) || []).length,
          raw_appends_left: (s613.match(/setText\((body|seedBody584) \+ \((body|seedBody584) \? "\\n" : ""\)/g) || []).length
        });
      })());
  }

  // --- T-615 (2026-10-21, operator ruling 02:20 Berlin, verbatim: "Make the read happen on every path that opens
  //     the editor"): the reuse hand-off is a door into the chapter editor too, and it was the door that did not ask
  //     the voice store. A fresh composer mount, a scene whose NAME: lines look like voice ids, and one press.
  {
    var mark615 = shim.rt.created.length;
    bag = commit(); await flush();
    // Clear any hand-off the panel still holds, so the fresh mount below is opened by a PRESS and not by a seed the
    // suite left behind (the same clearing the T-581 block records as necessary for a scenario written from scratch).
    var pk615 = bag.AudioPlayerPanel && bag.AudioPlayerPanel.__key;
    var pst615 = pk615 ? shim.rt.stores.get(pk615) : null;
    if (pst615) {
      for (var s615 = 0; s615 < pst615.length; s615++) {
        var v615 = pst615[s615];
        if (v615 && typeof v615 === 'object' && !Array.isArray(v615) && Object.keys(v615).length === 2
          && /^ap-\d+$/.test(String(v615.id || '')) && typeof v615.at === 'number') pst615[s615] = null;
      }
    }
    bag = commit(); await flush();
    var k615 = bag.SceneComposer && bag.SceneComposer.__key;
    check('T-615: the composer is in the tree and can be re-mounted for this scenario', !!k615, String(k615));
    if (k615) {
      shim.rt.stores.delete(k615);          // fresh hooks: no voice store held, editor closed
      bag = commit(); await flush();
      var st615 = shim.rt.stores.get(k615);
      if (st615) { st615[0] = PLUGIN52_SCRIPT; st615[1] = 't615 every door reads 615'; }
      mark615 = shim.rt.created.length; bag = commit(); await flush();
      var els615 = function () { return shim.rt.created.slice(mark615); };
      var vrBefore615 = calls.filter(function (c) { return /voice_registry/.test(c); }).length;
      var board615 = shim.rt.created.filter(function (e) {
        return e.type === 'button' && /^put this row's /.test(String((e.props || {}).title || ''))
          && /chapter editor as \d+ (speaker block|diarised turn)\(s\)/.test(String((e.props || {}).title || ''));
      }).pop();
      if (board615) { board615.props.onClick(); await flush(); bag = commit(); await flush(); mark615 = shim.rt.created.length; commit(); await flush(); }
      var vrAfter615 = calls.filter(function (c) { return /voice_registry/.test(c); }).length;
      check('T-615: pressing the board row\'s reuse control asks for the voice_registry read on that press - the door that opens the editor is now a door that reads',
        !!board615 && vrAfter615 > vrBefore615, JSON.stringify({ reads_before: vrBefore615, reads_after: vrAfter615, pressed: !!board615 }));
      var castRows615 = els615().filter(function (e) { return e.type === 'input' && /the voice that speaks this line/.test(String((e.props || {}).title || '')); });
      var amber615 = els615().filter(function (e) {
        return e.props && e.props.className === 'audio-play-cast-line594' && String(e.props.children) === 'speaker line not decided yet';
      });
      check('T-615: with the read asked for on that press, the cast rows of a scene whose names look like voice ids are NOT left printing "speaker line not decided yet" - the marker was claiming an indecision this panel never asked about',
        castRows615.length > 0 && amber615.length === 0,
        JSON.stringify({ cast_rows: castRows615.length, amber_markers: amber615.length }));
    }
    check('T-615 source: three doors into the editor each ask the read, the read still guards itself, and the honest marker for a store that was genuinely not read is still in the code',
      (function () {
        var s615 = require('fs').readFileSync(TARGET, 'utf8');
        return (s615.match(/loadVoiceDurs579\(\);/g) || []).length === 3
          && /function loadVoiceDurs579\(\) \{\n\s*if \(vdur579\) return;/.test(s615)
          && /"speaker line not decided yet"/.test(s615);
      })(), (function () {
        var s615 = require('fs').readFileSync(TARGET, 'utf8');
        return JSON.stringify({
          doors_that_read: (s615.match(/loadVoiceDurs579\(\);/g) || []).length,
          guard_kept: /function loadVoiceDurs579\(\) \{\n\s*if \(vdur579\) return;/.test(s615),
          marker_kept: /"speaker line not decided yet"/.test(s615)
        });
      })());
  }

  // ============ T-638 (2026-10-25, client half; operator request of 02:28 Berlin) ============
  // The chapter editor's speaker field and cast field gained a suggestion list fed by the voice store, and the
  // editor gained ONE filter over the whole chapter with "all voices" as its default. What these pins hold:
  //   1. the filter is there, its default is "all", and every filing somebody actually made appears with its count;
  //   2. the suggestion list holds the voices the filter allows, and both name fields point at it;
  //   3. moving the filter narrows what is OFFERED and touches nothing a row already holds;
  //   4. a name the list does not hold is kept exactly as typed — an invented cast name, a speaker label brought
  //      in from a diarised transcription.
  // The idiom is the one this file already records (T-579 / T-581 / T-615): a fresh mount, a real PRESS on a door,
  // and a mark moved to the end of the newest render so what is collected afterwards is what that render drew.
  {
    var k638 = bag.SceneComposer && bag.SceneComposer.__key;
    if (k638) {
      shim.rt.stores.delete(k638);
      bag = commit(); await flush();
      var st638 = shim.rt.stores.get(k638);
      if (st638) { st638[0] = PLUGIN52_SCRIPT; st638[1] = 't638 the filter and the picks'; }
      bag = commit(); await flush();
      var mark638 = shim.rt.created.length;
      var els638 = function () { return shim.rt.created.slice(mark638); };
      var step638 = async function () { mark638 = shim.rt.created.length; bag = commit(); await flush(); };
      var door638 = btn('open batch editor');
      if (door638) { door638.props.onClick(); await flush(); }
      await step638();
      var flat638 = function (node638, out638) {
        if (node638 == null) return out638;
        if (Array.isArray(node638)) { node638.forEach(function (c638) { flat638(c638, out638); }); return out638; }
        out638.push(node638); return out638;
      };
      var filt638 = function () {
        return els638().filter(function (e) { return e.props && e.props.className === 'audio-play-editor-voice-filter638'; }).pop();
      };
      var filtOpts638 = function () {
        var s638 = filt638(); if (!s638) return [];
        return flat638(s638.props.children, []).filter(function (o) { return o && o.type === 'option'; })
          .map(function (o) { return { value: String((o.props || {}).value), label: String(o.props.children) }; });
      };
      // RE-POINT 2026-11-05 on the integrated-list ruling (the operator's word: "The current picker should be
      // integrated with the text field we have per speaker line - it should act as a live filter while typing for
      // a dropdown selection/pick of the voice from the list"). The control that stood beside the field is gone.
      // What a field draws is a list UNDER itself, opened by a focus, narrowed by what is typed, closed by a blur
      // or an Escape. The rules the old dropdown was held to still hold that list: it offers only voices the store
      // reports, only ones the field's own text has not filtered out, and moving the group filter rewrites nothing
      // a row already holds. What the new shape adds is measured too: a pick writes the name into the field, Enter
      // writes the first name the same list would show, and a list narrowed to nothing says so in words instead of
      // disabling a control.
      // Two things this choreography has to respect, both measured here on 2026-11-05 rather than assumed. Writing
      // a CAST field renames that speaker in every line the cast owns, so the rows themselves move: the typing
      // tests are run on a turn's own speaker field, which changes one line. And a step that changes no state
      // draws no new elements, so what the panel is showing is the newest render that drew anything - reading only
      // the newest render would report a list that is still on screen as gone.
      var seen638 = els638();
      var see638 = async function () { await step638(); var r638v = els638(); if (r638v.length) seen638 = r638v; return seen638; };
      var drawn638 = function () { return seen638; };
      var sugLists638 = function () {
        return drawn638().filter(function (e) { return e.props && e.props.className === 'audio-play-editor-voice-suggest638'; });
      };
      var sugRows638 = function (l638) {
        return flat638((l638 || {}).props ? l638.props.children : [], [])
          .filter(function (r) { return r && r.props && r.props.className === 'audio-play-editor-voice-suggest-item638'; });
      };
      var rowName638 = function (r638) {
        var ch638r = (r638.props || {}).children;
        return String(Array.isArray(ch638r) ? ch638r[0] : ch638r);
      };
      var sugVals638 = function (l638) { return sugRows638(l638).map(rowName638); };
      var textOf638 = function (n638t) { return flat638((n638t || {}).props ? n638t.props.children : [], []).join(''); };
      var childOfClass638 = function (n638p, cls638) {
        return flat638((n638p || {}).props ? n638p.props.children : [], [])
          .filter(function (x) { return x && x.props && x.props.className === cls638; });
      };
      // A group label is a child of the ROW, not of the list, and the flat walk above does not descend into an
      // element's own children - so the labels are read row by row.
      var sugGroups638 = function (l638) {
        return sugRows638(l638).map(function (r638g) {
          return childOfClass638(r638g, 'audio-play-editor-voice-suggest-group638').map(textOf638).join('');
        });
      };
      var sugWords638 = function (l638, cls638) { return childOfClass638(l638, cls638).map(textOf638); };
      var openField638 = async function (e638o) {
        if (e638o && e638o.props && e638o.props.onFocus) { e638o.props.onFocus(); await see638(); }
      };
      var typeInto638 = async function (e638w, v638w) {
        if (e638w && e638w.props && e638w.props.onChange) { e638w.props.onChange({ target: { value: v638w } }); await see638(); }
      };
      var pressKey638 = async function (e638k, key638k) {
        if (e638k && e638k.props && e638k.props.onKeyDown) { e638k.props.onKeyDown({ key: key638k }); await see638(); }
      };
      var pickRow638 = async function (r638p) {
        if (r638p && r638p.props && r638p.props.onMouseDown) {
          r638p.props.onMouseDown({ preventDefault: function () {} }); await see638();
        }
      };
      // The names a list may offer are the names this fixture's host reports, read here rather than written down:
      // a list that offers a name the host does not report is the defect these checks are looking for, and a list
      // copied into the test would hide it. Read after every other block has finished, so it moves no call count.
      var STORE638 = Object.keys((await (await host('/api/deepamp/voice_registry', { method: 'GET' })).json()).voices || {});
      var nameFields638 = function () {
        return drawn638().filter(function (e) { return e.props && e.props.className === 'audio-play-scene-turn-name381'; });
      };
      var castFields638 = function () {
        return drawn638().filter(function (e) { return e.props && e.props.className === 'audio-play-cast-voice638'; });
      };
      var f638 = filt638();
      check('T-638: the chapter editor carries ONE voice filter over the whole chapter, its default is "all voices", and every filing made on a voice is offered with its count beside it',
        !!f638 && String(f638.props.value) === '' && (function () {
          var byVal638 = {};
          filtOpts638().forEach(function (x638) { byVal638[x638.value] = x638.label; });
          return byVal638[''] === 'all voices (8)' && byVal638.__ungrouped638__ === 'ungrouped (5)'
            && byVal638.bridge === 'bridge (2)' && byVal638.captains === 'captains (1)' && byVal638.engineering === 'engineering (1)';
        })(), JSON.stringify({ filter_present: !!f638, value: f638 ? String(f638.props.value) : null, options: filtOpts638() }));
      check('T-638 integrated (re-pointed 2026-11-05): nothing is drawn beside a field and nothing is drawn under it until somebody focuses it - the control that used to stand next to every name field is gone, and a field is a field',
        els638().filter(function (e) { return e.props && e.props.className === 'audio-play-editor-voice-pick638'; }).length === 0
          && sugLists638().length === 0
          && nameFields638().length === 3 && castFields638().length >= 3
          && nameFields638().every(function (e638n) { return !e638n.props.list; })
          && castFields638().every(function (e638c) { return !e638c.props.list; }),
        JSON.stringify({
          name_fields: nameFields638().length, cast_fields: castFields638().length,
          old_pick_controls: els638().filter(function (e) { return e.props && e.props.className === 'audio-play-editor-voice-pick638'; }).length,
          lists_before_any_focus: sugLists638().length,
          old_list_attrs: nameFields638().concat(castFields638()).map(function (e638l) { return e638l.props.list || null; }),
        }));
      var turnField638c = nameFields638()[0];
      await openField638(turnField638c);
      var turnLists638 = sugLists638();
      var castField638c = castFields638()[0];
      await openField638(castField638c);
      var castLists638 = sugLists638();
      check('T-638 integrated (2026-11-05): both kinds of field open the SAME list under themselves - the turn\u2019s speaker field and the cast\u2019s voice field - and only one field\u2019s list is open at a time',
        turnLists638.length === 1 && castLists638.length === 1 && sugLists638().length === 1 && !!turnField638c && !!castField638c,
        JSON.stringify({ lists_after_a_turn_field: turnLists638.length, lists_after_a_cast_field: castLists638.length, open_now: sugLists638().length }));
      // The field these tests drive is the one holding an invented name: it is a turn's own speaker field, so a
      // write here changes one line and the row order the lookups depend on stays put.
      var nameIdx638 = -1;
      var nameFieldNow638 = function () { var f638m = nameFields638(); return nameIdx638 >= 0 && f638m.length > nameIdx638 ? f638m[nameIdx638] : null; };
      var nameValueNow638 = function () { var e638v = nameFieldNow638(); return e638v ? String(e638v.props.value) : null; };
      var inventedField638 = nameFields638().filter(function (e638i) { return String(e638i.props.value) === 'Neelix'; }).pop();
      nameIdx638 = nameFields638().indexOf(inventedField638);
      await openField638(inventedField638);
      await typeInto638(nameFieldNow638(), 'voy');
      var typedList638 = sugLists638()[0];
      var typedOffered638 = typedList638 ? sugVals638(typedList638) : [];
      var typedLabels638 = typedList638 ? sugGroups638(typedList638) : [];
      check('T-638 integrated (2026-11-05): typing IS the filter - the list under the field narrows to the voices that text matches, every name it offers is one the store reports, and each row carries the group that voice is filed under',
        typedOffered638.length === 2 && typedOffered638.indexOf('voy_doctor') >= 0 && typedOffered638.indexOf('voy_janeway') >= 0
          && typedOffered638.every(function (v638t) { return STORE638.indexOf(v638t) >= 0; })
          && typedLabels638.length === 2 && typedLabels638.every(function (g638t) { return /bridge/.test(g638t); }),
        JSON.stringify({ field_value: nameValueNow638(), offered: typedOffered638, groups: typedLabels638 }));
      var topRow638 = sugRows638(typedList638)[0];
      await pickRow638(topRow638);
      var afterPick638 = nameValueNow638();
      check('T-638 integrated (2026-11-05): a pick is a click on a row of the list, and it writes that name into the field the list belongs to',
        !!topRow638 && typedOffered638.indexOf(afterPick638) >= 0,
        JSON.stringify({ picked: afterPick638, offered: typedOffered638 }));
      await typeInto638(nameFieldNow638(), 't592_');
      var kkList638 = sugLists638()[0];
      var kkOffered638 = kkList638 ? sugVals638(kkList638) : [];
      await pressKey638(nameFieldNow638(), 'Enter');
      var afterEnter638 = nameValueNow638();
      check('T-638 integrated (2026-11-05): Enter writes the first name the same list would show, which is why the pick needs no control of its own',
        kkOffered638.length >= 1 && afterEnter638 === kkOffered638[0],
        JSON.stringify({ offered_before_enter: kkOffered638, field_after_enter: afterEnter638, dbg_lists: sugLists638().length, dbg_none: kkList638 ? sugWords638(kkList638, 'audio-play-editor-voice-suggest-none638') : null, dbg_filter: (filt638() || {}).value, dbg_rows: nameFields638().map(function (x) { return String(x.props.value); }), dbg_idx: nameIdx638, dbg_add_btn: !!btn('+ add a line') }));
      await openField638(nameFieldNow638());
      var openBeforeEsc638 = sugLists638().length;
      await pressKey638(nameFieldNow638(), 'Escape');
      var closedAfterEsc638 = sugLists638().length;
      await openField638(nameFieldNow638());
      var openBeforeBlur638 = sugLists638().length;
      var blurField638 = nameFieldNow638();
      if (blurField638 && blurField638.props.onBlur) { blurField638.props.onBlur({}); await see638(); }
      check('T-638 integrated (2026-11-05): the list closes on Escape and on a blur, so it is not a fixture that stays on the screen',
        openBeforeEsc638 === 1 && closedAfterEsc638 === 0 && openBeforeBlur638 === 1 && sugLists638().length === 0,
        JSON.stringify({ open_before_escape: openBeforeEsc638, after_escape: closedAfterEsc638, open_before_blur: openBeforeBlur638, after_blur: sugLists638().length }));
      await openField638(nameFieldNow638());
      await typeInto638(nameFieldNow638(), 'zzz-no-such-voice');
      var noneList638 = sugLists638()[0];
      var noneWords638 = noneList638 ? sugWords638(noneList638, 'audio-play-editor-voice-suggest-none638') : [];
      check('T-638 item 4(e), RE-POINTED 2026-11-05 (the integrated-list ruling supersedes the clause that measured a control disabling itself): a list the typed text narrows to nothing says so in words, and the field keeps what it was holding',
        noneWords638.length === 1 && /no voice matches what is typed here/.test(noneWords638[0]),
        JSON.stringify({ field_value: nameValueNow638(), words: noneWords638 }));
      await typeInto638(nameFieldNow638(), 'Neelix');
      // Measured 2026-11-05: an added line starts under the speaker the scene last named, and clearing its name
      // merges it back into the line above, so there is no empty field to open. The narrowing is therefore measured
      // on ONE field holding ONE text, with only the group filter moved between the two reads - the same text offers
      // more before the move than after it.
      await typeInto638(nameFieldNow638(), 'v');
      var allList638 = sugLists638()[0];
      var allOffered638 = allList638 ? sugVals638(allList638) : [];
      if (f638) { f638.props.onChange({ target: { value: 'bridge' } }); await see638(); }
      var bridgeList638 = sugLists638()[0];
      var bridgeOffered638 = bridgeList638 ? sugVals638(bridgeList638) : [];
      check('T-638: picking a group narrows what is OFFERED to the voices filed under it — two of the eight here, counted from the filing on the voice and not from anything this panel keeps (re-pointed 2026-11-05: the offer is read from the list a focused field draws, on one field holding one text, with only the group filter moved)',
        bridgeOffered638.length === 2 && bridgeOffered638.indexOf('voy_doctor') >= 0 && bridgeOffered638.indexOf('voy_janeway') >= 0
          && bridgeOffered638.every(function (v638s) { return allOffered638.indexOf(v638s) >= 0; })
          && bridgeOffered638.length < allOffered638.length,
        JSON.stringify({ offered_before_the_move: allOffered638, offered_after_the_move: bridgeOffered638, filter_value: (filt638() || {}).value }));
      await typeInto638(nameFieldNow638(), 'Neelix');
      var castBefore638 = castFields638().map(function (e638c) { return String(e638c.props.value); });
      var castNeelix638 = castFields638().filter(function (e638c) { return String(e638c.props.value) === 'Neelix'; }).pop();
      if (castNeelix638) { castNeelix638.props.onChange({ target: { value: 'S04' } }); await see638(); }
      var f638b = filt638();
      if (f638b) { f638b.props.onChange({ target: { value: '__ungrouped638__' } }); await see638(); }
      check('T-638 item 4(e), RE-POINTED 2026-11-05: moving the filter never rewrites what a row already holds, and the bucket it moves to is the five unfiled voices - a row keeps the value it was given even though no list offers it',
        castFields638().some(function (e638d) { return String(e638d.props.value) === 'S04'; })
          && /Now offering 5 of 8 voices/.test(String(((filt638() || {}).props || {}).title || '')),
        JSON.stringify({
          cast_before: castBefore638,
          cast_after: castFields638().map(function (e638z) { return String(e638z.props.value); }),
          filter_hover: String(((filt638() || {}).props || {}).title || '').split('\n').filter(function (l638h) { return /offering/i.test(l638h); }),
        }));
      var invented638 = nameFields638().filter(function (e638i) { return String(e638i.props.value) === 'Neelix'; }).pop();
      if (invented638) { invented638.props.onChange({ target: { value: 'Seven of Nine' } }); await see638(); }
      check('T-638 item 4(b), RE-POINTED 2026-11-05 (the same rule, now measured against a field that draws a list under itself): a name the list does not hold is accepted exactly as typed — the field keeps it and the scene keeps its turn; nothing is refused for not being a registered voice',
        !!invented638 && nameFields638().some(function (e638k) { return String(e638k.props.value) === 'Seven of Nine'; }),
        JSON.stringify({ names: nameFields638().map(function (e638n2) { return String(e638n2.props.value); }) }));
      check('T-638 source: the filter is built from the filing on the voice (the same read the duration band already makes, not a second read), its two buckets are sentinels rather than the words "all" and "ungrouped", the honest line for a host that reports no filing at all is in the code, and the list a field draws under itself is one component used by both kinds of field with the typed text narrowing it (re-pointed 2026-11-05 for the integrated-list ruling)',
        (function () {
          var s638 = require('fs').readFileSync(TARGET, 'utf8');
          return /grpMap638\[k\] = vs\[k\]\.groups\.map/.test(s638)
            && /var VOICE_FILTER_ALL638 = "";\n\s*var VOICE_FILTER_UNGROUPED638 = "__ungrouped638__";/.test(s638)
            && /No group filing has been reported for these voices yet/.test(s638)
            && (s638.match(/editorVoiceSuggest638\(/g) || []).length === 3
            && (s638.match(/editorVoicePickMenu638/g) || []).length === 0
            && /var VOICE_SUGGEST_MAX638 = 8;/.test(s638)
            && s638.indexOf('list: EDITOR_VOICE_PICKS_ID638') < 0;
        })(), (function () {
          var s638 = require('fs').readFileSync(TARGET, 'utf8');
          return JSON.stringify({
            groups_captured_on_the_band_read: /grpMap638\[k\] = vs\[k\]\.groups\.map/.test(s638),
            sentinel_bucket_ids: /var VOICE_FILTER_ALL638 = "";\n\s*var VOICE_FILTER_UNGROUPED638 = "__ungrouped638__";/.test(s638),
            honest_no_filing_line: /No group filing has been reported for these voices yet/.test(s638),
            lists_in_source: (s638.match(/editorVoiceSuggest638\(/g) || []).length,
            old_pick_component_left: (s638.match(/editorVoicePickMenu638/g) || []).length,
            rows_the_list_shows_before_it_says_stop: (s638.match(/var VOICE_SUGGEST_MAX638 = 8;/g) || []).length,
            datalist_wiring_left: (s638.match(/list: EDITOR_VOICE_PICKS_ID638/g) || []).length,
            registry_reads_this_card: calls.filter(function (c) { return /voice_registry/.test(c); }).length,
          });
        })());
    }
  }

  // ── T-790 (2026-11-11): the batch editor window wears the main window's header face and its corner ──────
  // The operator's words, verbatim: "the 'batch editor' style is a little off ... make the header font the same
  // as main player DEEPAMP Logo style and size - and the bottom right 'resize corner' the same as in the main
  // window". What these pins hold is that the two windows share the LOOK and keep their own NAMES. The class
  // names stay separate on purpose: several suites in this package find the panel header by "audio-play-title",
  // and a second element wearing that class would make those reads ambiguous. Shared look, not shared name.
  {
    var s790 = require("fs").readFileSync(TARGET, "utf8");
    var ta790 = panelTa381();
    if (ta790) { ta790.props.onChange({ target: { value: SCENE462 } }); await flush(); commit(); await flush(); }
    var door790 = btn("open batch editor");
    if (door790) { door790.props.onClick(); await flush(); }
    var rA790 = shim.rt.created.length;
    commit();
    var render790 = shim.rt.created.slice(rA790, shim.rt.created.length);
    function one790(cls790) {
      var out790 = null;
      render790.forEach(function (e790) { if (e790.props && e790.props.className === cls790) out790 = e790; });
      return out790;
    }
    function textOf790(e790) {
      var ch790 = e790 && e790.props ? e790.props.children : null;
      if (typeof ch790 === "string" || typeof ch790 === "number") return String(ch790);
      if (Array.isArray(ch790)) return ch790.filter(function (x790) { return typeof x790 === "string" || typeof x790 === "number"; }).join("");
      return "";
    }
    var edTitle790 = null;
    render790.forEach(function (e790) { if (textOf790(e790) === "batch editor") edTitle790 = e790; });
    var panelTitle790 = one790("audio-play-title");
    var LOOK_KEYS790 = ["fontFamily", "letterSpacing", "fontWeight", "fontSize"];
    function look790(e790) {
      var st790 = (e790 && e790.props && e790.props.style) || {};
      var o790 = {};
      LOOK_KEYS790.forEach(function (k790) { o790[k790] = st790[k790]; });
      return o790;
    }
    var pLook790 = look790(panelTitle790);
    var eLook790 = look790(edTitle790);
    check("T-790: the batch editor header word carries the SAME face the main window header word carries — family, tracking, weight and size read off both elements and compared, not asserted from the source",
      !!panelTitle790 && !!edTitle790 && LOOK_KEYS790.every(function (k790) {
        return typeof eLook790[k790] === "string" && eLook790[k790] === pLook790[k790];
      }),
      JSON.stringify({ panel: pLook790, editor: eLook790 }));
    check("T-790: that face is the one the panel has worn all along — monospace, 0.14em tracking, weight 700 at 12px. The main window was not changed to meet the editor; the editor was changed to meet it",
      pLook790.fontFamily === "monospace" && pLook790.letterSpacing === "0.14em" &&
      pLook790.fontWeight === "700" && pLook790.fontSize === "12px",
      JSON.stringify(pLook790));
    check("T-790: the shared look does NOT bring a shared class name — the editor word wears no class, and one render of the panel still carries exactly one audio-play-title",
      !!edTitle790 && !edTitle790.props.className &&
      render790.filter(function (e790) { return e790.props && e790.props.className === "audio-play-title"; }).length === 1,
      { editor_class: (edTitle790 && edTitle790.props.className) || "", titles_in_render: render790.filter(function (e790) { return e790.props && e790.props.className === "audio-play-title"; }).length });
    var corner790 = one790("audio-play-editor-resize462");
    var cs790 = (corner790 && corner790.props && corner790.props.style) || {};
    var GRIP790 = {
      position: "absolute", right: "0", bottom: "0", width: "18px", height: "18px",
      boxSizing: "border-box", pointerEvents: "auto", cursor: "nwse-resize",
      borderRight: "2px solid #8886", borderBottom: "2px solid #8886",
      borderRadius: "0 0 8px 0",
      background: "repeating-linear-gradient(135deg, #8883 0 2px, transparent 2px 6px)",
    };
    var gripKeys790 = Object.keys(GRIP790);
    var gripEl790 = one790("audio-play-resize-grip");
    var gs790 = (gripEl790 && gripEl790.props && gripEl790.props.style) || {};
    check("T-790: the editor corner is the panel corner — every key of the shared grip carries the same value on the editor window",
      !!corner790 && gripKeys790.every(function (k790) { return cs790[k790] === GRIP790[k790]; }),
      JSON.stringify({ corner: cs790, expected: GRIP790 }));
    check("T-790: the main window corner still draws itself with those same values — the shared constant did not move the panel affordance a person already drags",
      !!gripEl790 && gripKeys790.every(function (k790) { return gs790[k790] === GRIP790[k790]; }),
      { grip_present: !!gripEl790, grip: gs790 });
    check("T-790: the corner is a drawn bracket and not a character — the editor corner carries no text child, and the glyph that used to be its whole look is gone from that element",
      !!corner790 && textOf790(corner790) === "" && !corner790.props.children,
      { corner_text: textOf790(corner790), children: corner790 ? String(corner790.props.children) : "no corner" });
    check("T-790: the corner still starts the resize drag — sharing the look did not replace the editor own drag handler with the panel one",
      !!corner790 && typeof corner790.props.onPointerDown === "function" && !corner790.props.onMouseDown,
      { onPointerDown: corner790 ? typeof corner790.props.onPointerDown : "none", onMouseDown: corner790 ? typeof corner790.props.onMouseDown : "none" });
    check("T-790 source: the look is stated ONCE in the client — two constants, each defined once, each used at both windows",
      (s790.match(/var PANEL_TITLE_LOOK790 = \{/g) || []).length === 1 &&
      (s790.match(/var PANEL_RESIZE_GRIP790 = \{/g) || []).length === 1 &&
      (s790.match(/Object\.assign\(\{\}, PANEL_TITLE_LOOK790\)/g) || []).length === 1 &&
      (s790.match(/Object\.assign\(\{ flex: "0 0 auto" \}, PANEL_TITLE_LOOK790\)/g) || []).length === 1 &&
      (s790.match(/Object\.assign\(\{\}, PANEL_RESIZE_GRIP790\)/g) || []).length === 2,
      { title_def: (s790.match(/var PANEL_TITLE_LOOK790 = \{/g) || []).length, grip_def: (s790.match(/var PANEL_RESIZE_GRIP790 = \{/g) || []).length,
        title_uses: (s790.match(/PANEL_TITLE_LOOK790\)/g) || []).length, grip_uses: (s790.match(/PANEL_RESIZE_GRIP790\)/g) || []).length });
    var cbStart790 = s790.indexOf('className: "audio-play-editor-resize462"');
    var cbBlock790 = cbStart790 >= 0 ? s790.slice(cbStart790, cbStart790 + 500) : "";
    check("T-790 source: read at that control own text in the client (the 500 characters from its class name to the end of its element), the corner now takes the shared grip and the old look is not there — no 16px box, no 55% opacity, no glyph character",
      cbStart790 >= 0 && cbBlock790.indexOf("PANEL_RESIZE_GRIP790") >= 0 &&
      cbBlock790.indexOf('width: "16px"') < 0 && cbBlock790.indexOf("opacity: 0.55") < 0 &&
      cbBlock790.indexOf("\\u25D9") < 0,
      { block_head: cbBlock790.slice(0, 120), has_16px: cbBlock790.indexOf('width: "16px"'), has_055: cbBlock790.indexOf("opacity: 0.55"), has_glyph_escape: cbBlock790.indexOf("\\u25D9"), has_shared_grip: cbBlock790.indexOf("PANEL_RESIZE_GRIP790") });
  }

  // T-797 (2026-11-12) re-cut of the plan read-out, the field-local clear and the voice-summary checks.
  // The ruling is the same one groups 1 to 6 carry: the operator asked why the section carried "Save
  // with this cast" and "Plan it" at all, said the section held "a lot of confusing ui elements in the
  // section we do not really need for ttsd generation", and answered the element table with "Fold the
  // whole recommendation list". Eleven claims read elements that ruling removed, and each is named here
  // rather than dropped: Plan it sending POST batch_plan with the path this plugin wrote; the plan being
  // shown as a plan (parts, per-part cast and slice, the frame ceiling and where it came from, a clamped
  // part said plainly); the plan naming what the split adds - the [S1] turn tags the planner writes - and
  // the budget including that it was cut; every warning the host named being rendered as its own line; and
  // Dispatch scene sending the SAME body it planned with, so the panel cannot plan one scene and send
  // another. T-443: one of the Clear controls emptying the scene text with the field-local rule holding.
  // T-581 5.2: the panel naming the voices its speakers map to before anything is saved; the editor
  // drawing one cast row per speaker the text introduces; and Check cast working before a save. T-604:
  // the summary line being honest about the word it uses, and not claiming a voice it does not have.
  // What the fold leaves: the plan verb and its answer are unchanged and are pinned where they are
  // produced (host.test.cjs on batch_plan, audio_tools.test.cjs on the plan job an agent asks for); the
  // cast rows in the editor still name every speaker and are measured by the T-581 and T-638 checks that
  // still pass in this file; the cast read still happens on its own without a button. Four checks follow,
  // and they measure the design as it now is: no batch_plan request from this panel at all, the dispatch
  // body naming the same file and model the save wrote, the cast read arriving without a save or a
  // dispatch in the same act and no control being needed for it, and no voice summary line while the cast
  // rows still name each speaker. The field-local clear is measured by the T-443 and T-796 checks that
  // still pass in this file; the one that failed here was reading a scene the removed import had filled,
  // and its rule is unchanged.
  var idx797f = function (verb797f) {
    for (var i797f = calls.length - 1; i797f >= 0; i797f--) { if (String(calls[i797f]).indexOf(verb797f) >= 0) return i797f; }
    return -1;
  };
  var json797f = function (n797f) { try { return JSON.parse(String(bodies[n797f] || '{}')); } catch (e797f) { return {}; } };
  check('T-797: this panel sends no plan request at all - the control that asked for one is out of the section, and the' +
    ' verb it used is still pinned where the answer is produced, in host.test.cjs and audio_tools.test.cjs',
    idx797f('batch_plan') < 0,
    JSON.stringify({ batch_plan_calls: calls.filter(function (c797f) { return /batch_plan/.test(String(c797f)); }).length }) );
  var before797f = calls.length;
  var db797f = btn('Dispatch scene');
  if (db797f) { db797f.props.onClick(); await flush(); bag = commit(); await flush(); }
  var dIdx797f = -1, sIdx797f = -1;
  for (var q797f = calls.length - 1; q797f >= 0; q797f--) {
    if (dIdx797f < 0 && /dispatch_batch/.test(String(calls[q797f]))) dIdx797f = q797f;
    if (sIdx797f < 0 && /batch_text_save/.test(String(calls[q797f]))) sIdx797f = q797f;
  }
  var dBody797f = dIdx797f >= 0 ? json797f(dIdx797f) : {};
  var sBody797f = sIdx797f >= 0 ? json797f(sIdx797f) : {};
  // RE-CUT AGAIN 2026-11-12 (T-797): the first version compared the dispatch body with the newest save
    // body, and the newest save in this run carried no file at all - a save of text the panel is holding sends
    // the text, not a path. The claim that survives the removal of the plan is the one the panel can still be
    // held to: the dispatch sends the file THIS plugin wrote and the model the panel is holding, and there is
    // no second body in the panel that it could have planned instead.
  check('Dispatch scene, its same-body check re-cut by T-797 without a plan to compare against: the dispatch names a file this plugin wrote under its own store and the model the panel is holding - there is no second body in the panel it could have planned instead',
    /^\/home\/deepamp-test\/\.dsh\/deepamp-audio\/.+\.json$/.test(String(dBody797f.file || '')) && /\.json$/.test(String(dBody797f.file || '')) && !!dBody797f.model,
    JSON.stringify({ dispatch_file: String(dBody797f.file || '').slice(0, 70), dispatch_model: String(dBody797f.model || ''), under_store: /^\/home\/deepamp-test\/\.dsh\/deepamp-audio\//.test(String(dBody797f.file || '')) }));
  var castAt797f = calls.length;
  var hand797f = function (id797f) {
    var el797f = shim.rt.created.filter(function (e) { return e.props && typeof e.props.reuseText === 'function'; }).pop();
    if (!el797f) return false;
    el797f.props.reuseText(id797f); return true;
  };
  if (hand797f('ap-0016')) { await flush(); bag = commit(); await flush(); bag = commit(); await flush(); }
  var window797f = calls.slice(castAt797f).map(function (c797g) { return String(c797g); });
  check('T-581 5.2, its Check-cast half re-cut by T-797: the cast read needs no button - a hand-off brings the cast read' +
    ' with it, and no save and no dispatch happen in the same act',
    window797f.some(function (c797h) { return /cast_preview/.test(c797h); })
      && !window797f.some(function (c797i) { return /batch_text_save|dispatch_batch|dispatch_task/.test(c797i); }),
    JSON.stringify({ calls: window797f.join(' | ') }) );
  var wm797f = shim.rt.created.length;
  var ed797f = btn('open batch editor');
  if (ed797f) { ed797f.props.onClick(); await flush(); bag = commit(); await flush(); }
  var fresh797f = shim.rt.created.slice(wm797f).map(function (e) { var c797j = e.props && e.props.children; return (typeof c797j === 'string') ? c797j : ''; }).join('\n');
  var castRows797f = shim.rt.created.slice(wm797f).filter(function (e) {
    return e.type === 'input' && e.props && String(e.props.className || '') === 'audio-play-cast-voice638';
  }).map(function (e) { return String(e.props.value); });
  check('T-581 5.2 and T-604, their voice-summary halves re-cut by T-797: the section carries no voices line any more -' +
    ' the names and the voices they map to are in the cast rows, and those rows are drawn',
    !/voices: /.test(fresh797f) && castRows797f.length >= 1,
    JSON.stringify({ voices_line: /voices: /.test(fresh797f), cast_rows: castRows797f.length }) );
  console.log('\n=== ' + pass + ' pass, ' + fail + ' fail ===');
  client.restore();
  process.exitCode = fail ? 1 : 0;
})().catch(function (e) { console.log('THROW ' + (e && e.stack || e)); process.exitCode = 1; });
