// Poll-then-play flow: dispatch_tts answers while the WAV is still being generated, so
// the panel must NOT point <audio> at the route immediately — it has to wait for
// job_status to report ok. This drives the real component with a hook-capable shim, a
// scripted host, a virtual timer and a fake <audio>, and asserts the whole sequence:
//
//   dispatch -> busy, no src, no play        (the old code played a route with no file
//                                             behind it and stayed silently dead)
//   running  -> still no src, retry scheduled
//   ok       -> src = /deepamp/<id>, play() exactly once, busy cleared, no timers left
//   error    -> no play, error surfaced to the user, busy cleared
//
// It also pins the HTTP verbs the host accepts (job_status is a GET route; a POST gets
// 405, which would make the poll never settle).
// Usage: node tests/flow.test.cjs [path/to/client.js]
const path = require('path');
const fs = require('fs');
const { createRuntime, loadClient } = require('./react_shim.cjs');

const TARGET = process.argv[2] || path.join(__dirname, '..', 'lib', 'client.js');
const JOB = 'ap-0042';

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

/** Scripted host: the job reports `running` `runs` times, then settles to `final`. */
function makeHost(final, runs) {
  const seen = { calls: [], jobStatus: 0 };
  const fetchImpl = function (url, opts) {
    const method = ((opts && opts.method) || 'GET').toUpperCase();
    const u = String(url);
    seen.calls.push(method + ' ' + u);
    let body;
    if (/get_endpoints/.test(u)) body = { tts: { url: 'http://cpu1.test:8963', route: 'speech' }, stt: { url: 'http://cpu1.test:8962', route: 'speech' } };
    else if (/server_status/.test(u)) body = { tts: { ok: true, loaded_model: 'm1' }, stt: { ok: true } };
    else if (/playlist_list/.test(u)) body = { items: [] };
    else if (/dispatch_tts/.test(u)) body = { ok: true, route_url: '/deepamp/' + JOB, job_id: JOB };
    else if (/job_status/.test(u)) {
      seen.jobStatus++;
      body = seen.jobStatus <= runs
        ? { ok: true, id: JOB, kind: 'tts', status: 'running', route_url: '/deepamp/' + JOB }
        : (final === 'ok'
          ? { ok: true, id: JOB, kind: 'tts', status: 'ok', route_url: '/deepamp/' + JOB }
          : { ok: true, id: JOB, kind: 'tts', status: final, error: 'curl exit 22: upstream 500' });
    }
    else if (/get_models|refresh_voices/.test(u)) body = { models: [{ id: 'm1', loaded: true }], voices: ['v1'] };
    else body = { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
  };
  return { fetchImpl, seen };
}

/** Virtual clock: the panel schedules through the client timer service, never Date. */
function makeTimer() {
  const q = [];
  return {
    timeout: function (cb, ms) {
      const e = { cb: cb, ms: ms };
      q.push(e);
      return function () { const i = q.indexOf(e); if (i >= 0) q.splice(i, 1); };
    },
    interval: function () { return function () {}; },
    pending: function () { return q.length; },
    // T-371: this check has always meant "no duplicate POLLERS". The panel now also arms one short UI timer
    // for the button's own feedback, which is not a poller and must not be mistaken for one. The poll cadence
    // is named here instead of counting every armed timer; every other check in this file still counts ALL of
    // them, so an orphan timer is still caught.
    pollPending: function () { return q.filter(function (e) { return e.ms === 1200; }).length; },
    fireOne: async function () {
      const e = q.shift();
      if (!e) return false;
      e.cb();
      await flush();
      return true;
    },
  };
}

/** Collect every string the panel rendered (for "did the user see the error"). */
function renderedText(shim) {
  const out = [];
  (function walk(v, depth) {
    if (depth > 40 || v == null) return;
    if (typeof v === 'string' || typeof v === 'number') { out.push(String(v)); return; }
    if (Array.isArray(v)) { v.forEach(function (n) { walk(n, depth + 1); }); return; }
    if (typeof v === 'object' && v.props && v.props.children !== undefined) walk(v.props.children, depth + 1);
  })(shim.rt.created.map(function (e) { return e.props && e.props.children; }), 0);
  return out.join(' | ');
}

async function scenario(name, final, runs) {
  console.log('\n--- ' + name + ' ---');
  const audio = {
    src: '', plays: [], loads: 0,
    load: function () { this.loads++; },
    play: function () { this.plays.push(this.src); var self = this; return Promise.resolve().then(function () { if (typeof self.onended === 'function') self.onended(); }); },
  };
  const host = makeHost(final, runs);
  const timer = makeTimer();
  const shim = createRuntime({
    makeHostNode: function (node) { return node.type === 'audio' ? audio : { tagName: node.type }; },
  });
  const client = loadClient(shim, { target: TARGET, fetch: host.fetchImpl, timer: timer });
  const comp = client.apply();
  if (!comp) throw new Error('panel did not register');

  function commit() { const b = {}; shim.render(comp(), b); shim.runEffects(); return b; }

  let bag = commit();
  await flush();

  // Type into the TTS text + STT path fields (empty-string state slots on the root).
  const rootStore = shim.rt.stores.get(bag.AudioPlayerPanel.__key);
  let typed = 0;
  for (let i = 0; i < rootStore.length; i++) if (rootStore[i] === '') { rootStore[i] = 'Once upon a time'; typed++; }
  check('typed into the text/path fields', typed >= 1, 'typed=' + typed);

  bag = commit();
  await flush();

  // --- dispatch ---
  bag.TtsBox.dispatchTts();
  await flush();
  check('dispatch_tts issued as POST', host.seen.calls.indexOf('POST /api/deepamp/dispatch_tts') >= 0, host.seen.calls.slice(0, 3).join(' | '));
  check('audio NOT pointed at the route while generating', audio.src === '', 'src=' + audio.src);
  check('play() NOT called while generating', audio.plays.length === 0, JSON.stringify(audio.plays));

  // --- arm the poll effect, then run the virtual clock until nothing is armed ---
  bag = commit();
  await flush();
  check('busy flag raised while generating', !!((bag.TtsBox || {}).busy || {}).tts, JSON.stringify((bag.TtsBox || {}).busy));
  check('exactly one poll timer armed (no duplicate pollers)', timer.pollPending() === 1, 'pending=' + timer.pending() + ' poll=' + timer.pollPending());

  let fired = 0;
  while (timer.pending() > 0 && fired < runs + 5) { await timer.fireOne(); fired++; }
  await flush();
  bag = commit();
  await flush();

  check('job_status polled with GET (POST would 405)', host.seen.calls.indexOf('GET /api/deepamp/job_status/' + JOB) >= 0,
    host.seen.calls.filter(function (c) { return /job_status/.test(c); }).slice(0, 2).join(' | '));
  check('polled ' + runs + 'x running before settling', host.seen.jobStatus >= runs + 1, 'polls=' + host.seen.jobStatus);

  if (final === 'ok') {
    check('audio.src set to the job route after ok', audio.src === '/deepamp/' + JOB, 'src=' + audio.src);
    check('play() called exactly once', audio.plays.length === 1, JSON.stringify(audio.plays));
    check('busy cleared after settle', ((bag.TtsBox || {}).busy || {}).tts === false, JSON.stringify((bag.TtsBox || {}).busy));
    check('no timer left armed after settle', timer.pending() === 0, 'pending=' + timer.pending());
  } else {
    check('no playback on ' + final, audio.plays.length === 0, JSON.stringify(audio.plays));
    check('audio.src untouched on ' + final, audio.src === '', 'src=' + audio.src);
    check('failure shown to the user', /curl exit 22/.test(renderedText(shim)), renderedText(shim).slice(0, 160));
    check('busy cleared after ' + final, ((bag.TtsBox || {}).busy || {}).tts === false, JSON.stringify((bag.TtsBox || {}).busy));
    check('no timer left armed after ' + final, timer.pending() === 0, 'pending=' + timer.pending());
  }
}

// Rev 5: the queue never rejects — two dispatches made back-to-back both enter the
// pending map; ONE shared poll timer drives both; busy holds until the LAST settles;
// each job plays exactly once, in settle order.
async function multiJob() {
  console.log('\n--- scenario: two queued dispatches, one shared poller ---');
  const IDS = ['ap-0101', 'ap-0102'];
  let dispatches = 0;
  const polls = { 'ap-0101': 0, 'ap-0102': 0 };
  const seenCalls = [];
  const fetchImpl = function (url, opts) {
    const u = String(url);
    seenCalls.push(((opts && opts.method) || 'GET') + ' ' + u);
    let body;
    if (/get_endpoints/.test(u)) body = { tts: { url: 'http://cpu1.test:8963', route: 'speech' }, stt: { url: 'http://cpu1.test:8962', route: 'speech' } };
    else if (/server_status/.test(u)) body = { tts: { ok: true }, stt: { ok: true } };
    else if (/playlist_list/.test(u)) body = { items: [] };
    else if (/dispatch_tts/.test(u)) {
      const id = IDS[dispatches] || IDS[IDS.length - 1];
      dispatches++;
      body = { ok: true, job_id: id, route_url: '/deepamp/' + id, status: 'queued', position: dispatches };
    } else if (/job_status\/(ap-\d+)/.test(u)) {
      const id = /job_status\/(ap-\d+)/.exec(u)[1];
      polls[id]++;
      const settleAt = id === IDS[0] ? 1 : 2; // job1 ok on poll 1, job2 on poll 2
      body = polls[id] >= settleAt
        ? { ok: true, id: id, status: 'ok', route_url: '/deepamp/' + id }
        : { ok: true, id: id, status: 'running' };
    }
    else if (/get_models|refresh_voices/.test(u)) body = { models: [{ id: 'm1', loaded: true }], voices: ['v1'] };
    else body = { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
  };
  const audio = { src: '', plays: [], load: function () {}, play: function () { this.plays.push(this.src); var self = this; return Promise.resolve().then(function () { if (typeof self.onended === 'function') self.onended(); }); } };
  const timer = makeTimer();
  const shim = createRuntime({ makeHostNode: function (n) { return n.type === 'audio' ? audio : { tagName: n.type }; } });
  const client = loadClient(shim, { target: TARGET, fetch: fetchImpl, timer: timer });
  const comp = client.apply();
  if (!comp) throw new Error('panel did not register');
  function commit() { const b = {}; shim.render(comp(), b); shim.runEffects(); return b; }

  let bag = commit();
  await flush();
  const rootStore = shim.rt.stores.get(bag.AudioPlayerPanel.__key);
  for (let i = 0; i < rootStore.length; i++) if (rootStore[i] === '') { rootStore[i] = 'queue me'; }
  bag = commit();
  await flush();

  // Two dispatches back-to-back (no settle in between) — both must go out.
  bag.TtsBox.dispatchTts();
  await flush();
  bag = commit();
  bag.TtsBox.dispatchTts();
  await flush();
  const nDisp = seenCalls.filter(function (c) { return /dispatch_tts/.test(c); }).length;
  check('both dispatches reached the host (queue never rejects)', nDisp === 2, 'n=' + nDisp);
  check('text still in the box after dispatch', rootStore.indexOf('queue me') >= 0);

  bag = commit();
  await flush();
  check('busy true while queued jobs are open', !!((bag.TtsBox || {}).busy || {}).tts);
  check('still exactly ONE poll timer for two jobs', timer.pollPending() === 1, 'pending=' + timer.pending() + ' poll=' + timer.pollPending());

  let fired = 0;
  while (timer.pending() > 0 && fired < 8) { await timer.fireOne(); fired++; }
  await flush();
  bag = commit();
  await flush();

  check('both jobs played exactly once', audio.plays.length === 2, JSON.stringify(audio.plays));
  check('plays in settle order', audio.plays[0] === '/deepamp/ap-0101' && audio.plays[1] === '/deepamp/ap-0102', JSON.stringify(audio.plays));
  check('busy cleared only after the LAST settle', ((bag.TtsBox || {}).busy || {}).tts === false, JSON.stringify((bag.TtsBox || {}).busy));
  check('no timers left armed', timer.pending() === 0, 'pending=' + timer.pending());
}

// Read-aloud chunk ordering (T-115, 2026-09-26): a long message split into several TTS
// parts must PLAY 0,1,2,... in TEXT order even when their renders complete OUT of order on
// the remote. The generic poll path enqueues a settled job the instant it answers ok, so a
// later chunk can finish first and jump the playback queue. The fix routes chunk jobs
// (chunkIdx + streamId) through an ordered inserter that only releases chunk N once chunk
// N-1 has been enqueued. This drives the real component: it selects a model, hits "Speak
// last", lets three chunks dispatch, makes chunk 2 finish first and chunk 0 last, and
// asserts playback lands in TEXT order (reversed from completion order).
async function chunkOrder() {
  console.log('\n--- scenario: chunked read-aloud plays in TEXT order (T-115) ---');
  // Isolate the panel poll path: agent auto-play OFF, panel auto-play ON (default), and a
  // small chunk size so the message deterministically splits into three parts. Set before
  // load() so the useState initializers read it.
  global.localStorage = {
    _s: {},
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
    setItem: function (k, v) { this._s[k] = String(v); },
    removeItem: function (k) { delete this._s[k]; },
    clear: function () { this._s = {}; },
  };
  global.localStorage.setItem('deepamp:agentplay', '0');
  global.localStorage.setItem('deepamp:chunkSize', '200');

  // Three sentences each ~150 chars: 150+150+1 > 200 so each packs into its own chunk.
  var WORDS = "the quick brown fox jumps over the lazy dog near the quiet riverbank while the evening sun sets slowly behind the distant hills".split(" ");
  function sentence(prefix) {
    var s = prefix + WORDS.join(" ");
    while (s.length < 150) s += " " + WORDS.slice(0, 6).join(" ");
    return s.replace(/\s+$/, ".");
  }
  var LONG_TEXT = [sentence("A"), sentence("B"), sentence("C")].join(" ");

  var CHUNK_IDS = ['ap-0301', 'ap-0302', 'ap-0303']; // chunk 0, 1, 2
  var dispatches = 0;
  var polls = { 'ap-0301': 0, 'ap-0302': 0, 'ap-0303': 0 };
  // Completion in POLLS: chunk 2 first (poll 1), chunk 1 (poll 2), chunk 0 last (poll 3)
  // => completion order is the REVERSE of text order.
  var settleAt = { 'ap-0301': 3, 'ap-0302': 2, 'ap-0303': 1 };
  var seenCalls = [];
  var ttsBodies = [];   // T-227: the read-aloud lane's actual request bodies
  var fetchImpl = function (url, opts) {
    var u = String(url);
    seenCalls.push(((opts && opts.method) || 'GET') + ' ' + u);
    var body;
    if (/get_endpoints/.test(u)) body = { tts: { url: 'http://cpu1.test:8963', route: 'speech' }, stt: { url: 'http://cpu1.test:8962', route: 'speech' } };
    else if (/server_status/.test(u)) body = { tts: { ok: true }, stt: { ok: true } };
    else if (/playlist_list/.test(u)) body = { items: [] };
    else if (/last_agent_message/.test(u)) body = { ok: true, text: LONG_TEXT, truncated: false };
    else if (/dispatch_tts/.test(u)) {
      ttsBodies.push(String((opts && opts.body) || ''));
      var id = CHUNK_IDS[dispatches] || CHUNK_IDS[CHUNK_IDS.length - 1];
      dispatches++;
      body = { ok: true, job_id: id, route_url: '/deepamp/' + id };
    } else if (/job_status\/(ap-\d+)/.test(u)) {
      var jid = /job_status\/(ap-\d+)/.exec(u)[1];
      polls[jid]++;
      body = polls[jid] >= settleAt[jid]
        ? { ok: true, id: jid, kind: 'tts', status: 'ok', route_url: '/deepamp/' + jid }
        : { ok: true, id: jid, kind: 'tts', status: 'running' };
    }
    else if (/get_models|refresh_voices/.test(u)) body = { models: [{ id: 'm1', loaded: true }], voices: ['v1'] };
    else body = { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
  };
  var audio = { src: '', plays: [], load: function () {}, play: function () { this.plays.push(this.src); var self = this; return Promise.resolve().then(function () { if (typeof self.onended === 'function') self.onended(); }); } };
  var timer = makeTimer();
  var shim = createRuntime({ makeHostNode: function (n) { return n.type === 'audio' ? audio : { tagName: n.type }; } });
  var client = loadClient(shim, { target: TARGET, fetch: fetchImpl, timer: timer });
  var comp = client.apply();
  if (!comp) throw new Error('panel did not register');
  function commit() { const b = {}; shim.render(comp(), b); shim.runEffects(); return b; }

  var bag = commit();
  await flush();

  // Select a TTS model (boot leaves selModel null, which would make speakMessageResult bail).
  if (typeof bag.TtsBox.onModelChange === 'function') { bag.TtsBox.onModelChange('tts', 'm1'); bag = commit(); await flush(); }
  else throw new Error('TtsBox.onModelChange not exposed to the test harness');

  // T-300 CONTRACT CHANGE (user feedback 2026-10-12, 18:47): "replace 'speak last' with the 'eject
  // button' ... make it the 'eject button' as the 'right side button' - with hover overlay 'speak last
  // Session message'". The control is the eject glyph now, found by its title (the words the user asked
  // for on the hover) and not by a label, so a test cannot pick up some other button by accident. Same
  // handler, same chunked queueing this scenario is about.
  var speakLast = null;
  for (var i = 0; i < shim.rt.created.length; i++) {
    var el = shim.rt.created[i];
    // T-316 MIGRATION (user ruling 2026-10-14): the eject is DRAWN now, so it is found by its class and its
    // hover — the two things that identify it — instead of by a glyph character it no longer carries.
    // T-385 / item 8 (user ruling 2026-10-14): the eject's speaking job moved to the read button behind REC, and the
    // eject became the import control. This flow is about speaking a long message in parts, so the control it drives
    // is now the read button. The eject's new job has its own check in transport.test.cjs.
    if (el && el.type === 'button' && String((el.props || {}).className || '').split(/\s+/).indexOf('audio-play-tp-read387') >= 0
      && typeof el.props.onClick === 'function') { speakLast = el.props.onClick; break; }
  }
  if (!speakLast) throw new Error('the read button (speak the last session message) is not in the rendered tree');
  speakLast();
  await flush();
  bag = commit();
  await flush();

  check('message split into exactly three chunks (3 dispatches)', dispatches === 3, 'dispatches=' + dispatches);
  check('chunk job ids are ap-0301/ap-0302/ap-0303',
    seenCalls.filter(function (c) { return /dispatch_tts/.test(c); }).length === 3);

  // Phase A (dispatch settle): the three chunk dispatches are nested (chunk 0's .then
  // fires the rest), so chunks 1/2 enter the pending map a few microtasks after chunk 0.
  // Commit + flush a fixed number of cycles (NOT timer.pending() — that counts armed
  // timers, max 1, never jobs) so all three jobs land in the pending map before polling.
  var settled = 0;
  while (settled < 15) { await flush(); bag = commit(); await flush(); settled++; }

  // Phase B (completion drain): one shared poll advances all jobs. Completion schedule
  // makes chunk 2 finish first (poll 1), chunk 1 (poll 2), chunk 0 last (poll 3) — the
  // reverse of text order — to prove playback is re-ordered to text order, not settle order.
  var fired = 0;
  while (timer.pending() > 0 && fired < 20) { await timer.fireOne(); await flush(); bag = commit(); await flush(); fired++; }

  // Sanity: every chunk job was actually polled (i.e. all three were pending), so the
  // play order above is a real test of re-ordering, not a partial drain.
  check('all three chunk jobs were polled (all pending)',
    polls['ap-0301'] > 0 && polls['ap-0302'] > 0 && polls['ap-0303'] > 0,
    'polls=' + JSON.stringify(polls));

  var a = 0;
  while (audio.plays.length < 3 && a < 100) { await flush(); a++; }

  check('all three parts played', audio.plays.length === 3, JSON.stringify(audio.plays));
  // Playback must follow TEXT order (0,1,2) EVEN THOUGH completion order was 2,1,0.
  check('plays in TEXT order (chunk 0 first), not completion order',
    audio.plays[0] === '/deepamp/ap-0301', 'first=' + audio.plays[0]);
  check('plays in TEXT order (chunk 2 last)',
    audio.plays[2] === '/deepamp/ap-0303', 'last=' + audio.plays[2]);
  check('plays in TEXT order (chunk 1 middle)',
    audio.plays[1] === '/deepamp/ap-0302', 'middle=' + audio.plays[1]);

  // T-227: the read-aloud lane obeys the same rule as the Generate button. Baseline
  // first — this fixture offers v1 and the panel holds the first candidate, so every
  // chunk carried the voice before this task and still carries it now.
  const chunkBodies = ttsBodies.map(function (b) { try { return JSON.parse(b); } catch (e) { return null; } });
  check('T-227 baseline: every read-aloud chunk carries the voice the panel holds (v1), same keys in the same order on all three',
    chunkBodies.length === 3 && chunkBodies.every(function (b) {
      return b && b.voice === 'v1' && Object.keys(b).join(',') === 'fn,model,text,voice,format,instructions';
    }), chunkBodies.map(function (b) { return b ? Object.keys(b).join(',') : 'unparsable'; }));

  // Same lane, same chunking, NO VOICE picked: every chunk must drop the voice key. The
  // chunking, the count and the order must not change — only the voice field.
  const beforeNoVoice = ttsBodies.length;
  if (typeof bag.TtsBox.onSelectVoice === 'function') {
    bag.TtsBox.onSelectVoice('tts', '__no_voice__');
    bag = commit(); await flush();
    speakLast();
    await flush();
    for (var nvw = 0; nvw < 12; nvw++) { await flush(); }
  }
  const nvChunkBodies = ttsBodies.slice(beforeNoVoice).map(function (b) { try { return JSON.parse(b); } catch (e) { return null; } });
  check('T-227: a NO VOICE read-aloud still splits into the same three chunks',
    nvChunkBodies.length === 3, nvChunkBodies.length);
  check('T-227: and every chunk of a NO VOICE read-aloud omits the voice key (nothing else changed)',
    nvChunkBodies.length === 3 && nvChunkBodies.every(function (b) {
      return b && !('voice' in b) && Object.keys(b).join(',') === 'fn,model,text,format,instructions';
    }), nvChunkBodies.map(function (b) { return b ? Object.keys(b).join(',') : 'unparsable'; }));

  if (global.localStorage) { try { delete global.localStorage; } catch (e) { global.localStorage = undefined; } }
}

// T-824 (2026-11-13): the same read-aloud chunking, with the panel's AUTO-PLAY ON — the
// setting the operator reported when they found chunks playing out of order ("the next played
// item seems to jump to the next currently finished job, instead of the next chunk"). The
// scenario above isolates the ordered path by turning agent auto-play OFF; this one turns it
// ON and lets the host's own listing report the chunk rows as finished, in completion order,
// which is what a real lane does when two chunks run on two endpoints. A chunk row that the
// auto-play poll hands to the play queue itself bypasses the ordered inserter, and the queue's
// duplicate guard then swallows the ordered call that arrives later. This is the measurement
// that says whether that path can reorder a read-aloud, and it asserts text order either way.
async function chunkOrderAgentPlay() {
  console.log('\n--- scenario: chunked read-aloud with agent auto-play ON (T-824) ---');
  global.localStorage = {
    _s: {},
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
    setItem: function (k, v) { this._s[k] = String(v); },
    removeItem: function (k) { delete this._s[k]; },
    clear: function () { this._s = {}; },
  };
  global.localStorage.setItem('deepamp:agentplay', '1');   // the operator's setting: play rows as they finish
  global.localStorage.setItem('deepamp:chunkSize', '200');

  var WORDS = "the quick brown fox jumps over the lazy dog near the quiet riverbank while the evening sun sets slowly behind the distant hills".split(" ");
  function sentence(prefix) {
    var s = prefix + WORDS.join(" ");
    while (s.length < 150) s += " " + WORDS.slice(0, 6).join(" ");
    return s.replace(/\s+$/, ".");
  }
  var LONG_TEXT = [sentence("A"), sentence("B"), sentence("C")].join(" ");

  var CHUNK_IDS = ['ap-0401', 'ap-0402', 'ap-0403'];   // chunk 0, 1, 2
  var dispatches = 0;
  var polls = { 'ap-0401': 0, 'ap-0402': 0, 'ap-0403': 0 };
  var settleAt = { 'ap-0401': 3, 'ap-0402': 2, 'ap-0403': 1 };   // completion order 2,1,0 = reverse of text order
  var seenCalls = [];
  var listReads = 0;
  var fetchImpl = function (url, opts) {
    var u = String(url);
    seenCalls.push(((opts && opts.method) || 'GET') + ' ' + u);
    var body;
    if (/get_endpoints/.test(u)) body = { tts: { url: 'http://cpu1.test:8963', route: 'speech' }, stt: { url: 'http://cpu1.test:8962', route: 'speech' } };
    else if (/server_status/.test(u)) body = { tts: { ok: true }, stt: { ok: true } };
    else if (/playlist_list/.test(u)) {
      // The host's own listing, newest-first, carrying each chunk at its real state at the
      // moment this read happens. That is the input the auto-play poll actually reads.
      listReads++;
      var items = [];
      for (var ci = CHUNK_IDS.length - 1; ci >= 0; ci--) {
        var cid = CHUNK_IDS[ci];
        if (polls[cid] <= 0 && dispatches <= ci) continue;   // not dispatched yet
        items.push({ id: cid, kind: 'tts', status: polls[cid] >= settleAt[cid] ? 'ok' : 'running',
          created: 1000 + ci, text: 'chunk ' + ci, duration: 4, route_url: '/deepamp/' + cid });
      }
      body = { items: items, queues: {}, auto_gen: { state: 'off' } };
    } else if (/last_agent_message/.test(u)) body = { ok: true, text: LONG_TEXT, truncated: false };
    else if (/dispatch_tts/.test(u)) {
      var id = CHUNK_IDS[dispatches] || CHUNK_IDS[CHUNK_IDS.length - 1];
      dispatches++;
      body = { ok: true, job_id: id, route_url: '/deepamp/' + id };
    } else if (/job_status\/(ap-\d+)/.test(u)) {
      var jid = /job_status\/(ap-\d+)/.exec(u)[1];
      polls[jid]++;
      body = polls[jid] >= settleAt[jid]
        ? { ok: true, id: jid, kind: 'tts', status: 'ok', route_url: '/deepamp/' + jid }
        : { ok: true, id: jid, kind: 'tts', status: 'running' };
    }
    else if (/get_models|refresh_voices/.test(u)) body = { models: [{ id: 'm1', loaded: true }], voices: ['v1'] };
    else body = { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
  };
  var audio = { src: '', plays: [], load: function () {}, play: function () { this.plays.push(this.src); var self = this; return Promise.resolve().then(function () { if (self.onended) self.onended(); }); } };
  var timer = makeTimer();
  var shim = createRuntime({ makeHostNode: function (n) { return n.type === 'audio' ? audio : { tagName: n.type }; } });
  var client = loadClient(shim, { target: TARGET, fetch: fetchImpl, timer: timer });
  var comp = client.apply();
  if (!comp) throw new Error('panel did not register');
  function commit() { const b = {}; shim.render(comp(), b); shim.runEffects(); return b; }

  var bag = commit();
  await flush();
  if (typeof bag.TtsBox.onModelChange === 'function') { bag.TtsBox.onModelChange('tts', 'm1'); bag = commit(); await flush(); }
  else throw new Error('TtsBox.onModelChange not exposed to the test harness');

  var readBtn = null;
  for (var i = 0; i < shim.rt.created.length; i++) {
    var el = shim.rt.created[i];
    if (el && el.type === 'button' && String((el.props || {}).className || '').split(/\s+/).indexOf('audio-play-tp-read387') >= 0
      && typeof el.props.onClick === 'function') { readBtn = el.props.onClick; break; }
  }
  if (!readBtn) throw new Error('the read button is not in the rendered tree');
  readBtn();
  await flush();
  bag = commit();
  await flush();

  check('T-824 fixture: the message still splits into three chunks with auto-play ON', dispatches === 3, 'dispatches=' + dispatches);

  var settled = 0;
  while (settled < 15) { await flush(); bag = commit(); await flush(); settled++; }
  var fired = 0;
  while (timer.pending() > 0 && fired < 20) { await timer.fireOne(); await flush(); bag = commit(); await flush(); fired++; }
  for (var extra = 0; extra < 12; extra++) {
    var pr = timer.pending() > 0 ? timer.fireOne() : null;
    if (pr && typeof pr.catch === 'function') await pr.catch(function () {});
    await flush(); bag = commit(); await flush();
  }

  var a = 0;
  while (audio.plays.length < 3 && a < 120) { await flush(); a++; }

  check('T-824: the host listing really did report the chunks out of text order',
    listReads > 0, { list_reads: listReads, plays: audio.plays });
  check('T-824: all three chunks played', audio.plays.length === 3, JSON.stringify(audio.plays));
  check('T-824: with auto-play ON a read-aloud still plays chunk 0 first, not the chunk that finished first',
    audio.plays[0] === '/deepamp/ap-0401', { plays: audio.plays, completion_order: 'ap-0403,ap-0402,ap-0401' });
  check('T-824: and the whole read lands 0,1,2 — no chunk is played ahead of an earlier one',
    audio.plays[0] === '/deepamp/ap-0401' && audio.plays[1] === '/deepamp/ap-0402' && audio.plays[2] === '/deepamp/ap-0403',
    { plays: audio.plays });

  if (global.localStorage) { try { delete global.localStorage; } catch (e) { global.localStorage = undefined; } }
}

// T-824 (2026-11-13, the operator's second word): "Both - it started itself, I pressed later."
// A read-aloud is playing on its own, the panel queued its parts in text order, and then a
// transport control was pressed. The walk resolves its position from `walkRef299` — the row the
// WALK last played — and a read-aloud never walks, so that pointer is empty: `at` defaults to 0
// and the step lands on the second playable row in the whole playlist, while `playQRef` is
// emptied first (lib/client.js:19806-19807). The parts the ordered inserter had already queued
// are gone. This drives that exact situation: two older finished rows sit in the list, a
// read-aloud starts itself, its first part is being heard with the rest queued behind it, and
// the transport's next is pressed. The expectation is the next part of the read being heard,
// not some other finished row. The <audio> here resolves play() and does NOT end the file, so
// the queue is still holding the remaining parts at the moment of the press.
async function walkNextDuringReadAloud() {
  console.log('\n--- scenario: a transport next pressed mid-read-aloud (T-824) ---');
  global.localStorage = {
    _s: {},
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
    setItem: function (k, v) { this._s[k] = String(v); },
    removeItem: function (k) { delete this._s[k]; },
    clear: function () { this._s = {}; },
  };
  global.localStorage.setItem('deepamp:agentplay', '0');   // isolate the read-aloud path from the agent poll
  global.localStorage.setItem('deepamp:chunkSize', '200');

  var WORDS = "the quick brown fox jumps over the lazy dog near the quiet riverbank while the evening sun sets slowly behind the distant hills".split(" ");
  function sentence(prefix) {
    var s = prefix + WORDS.join(" ");
    while (s.length < 150) s += " " + WORDS.slice(0, 6).join(" ");
    return s.replace(/\s+$/, ".");
  }
  var LONG_TEXT = [sentence("A"), sentence("B"), sentence("C")].join(" ");
  var CHUNK_IDS = ['ap-0511', 'ap-0512', 'ap-0513'];
  var OLD_IDS = ['ap-0501', 'ap-0502'];   // older finished takes, sitting in the list, never played here
  var dispatches = 0;
  var played = {};
  var fetchImpl = function (url, opts) {
    var u = String(url);
    var body;
    if (/get_endpoints/.test(u)) body = { tts: { url: 'http://cpu1.test:8963', route: 'speech' }, stt: { url: 'http://cpu1.test:8962', route: 'speech' } };
    else if (/server_status/.test(u)) body = { tts: { ok: true }, stt: { ok: true } };
    else if (/playlist_list/.test(u)) {
      var items = [];
      for (var oi = OLD_IDS.length - 1; oi >= 0; oi--) {
        items.push({ id: OLD_IDS[oi], kind: 'tts', status: 'ok', created: 500 + oi, text: 'older take ' + oi, duration: 4 });
      }
      for (var ci = CHUNK_IDS.length - 1; ci >= 0; ci--) {
        if (dispatches <= ci) continue;
        items.push({ id: CHUNK_IDS[ci], kind: 'tts', status: 'ok', created: 1000 + ci, text: 'chunk ' + ci, duration: 4 });
      }
      body = { items: items, queues: {}, auto_gen: { state: 'off' } };
    } else if (/last_agent_message/.test(u)) body = { ok: true, text: LONG_TEXT, truncated: false };
    else if (/dispatch_tts/.test(u)) {
      var id = CHUNK_IDS[dispatches] || CHUNK_IDS[CHUNK_IDS.length - 1];
      dispatches++;
      body = { ok: true, job_id: id, route_url: '/deepamp/' + id };
    } else if (/play_job/.test(u)) {
      var raw = String((opts && opts.body) || '') + ' ' + u;
      var pm = /ap-\d+/.exec(raw);
      var pid = pm ? pm[0] : '';
      body = { ok: true, job_id: pid, route_url: '/deepamp/' + pid };
    } else if (/job_status\/(ap-\d+)/.test(u)) {
      var jid = /job_status\/(ap-\d+)/.exec(u)[1];
      played[jid] = (played[jid] || 0) + 1;
      body = { ok: true, id: jid, kind: 'tts', status: 'ok', route_url: '/deepamp/' + jid };
    }
    else if (/get_models|refresh_voices/.test(u)) body = { models: [{ id: 'm1', loaded: true }], voices: ['v1'] };
    else body = { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
  };
  // play() resolves and does NOT end the take: the parts behind it stay queued, which is the state
  // the press lands in. The test ends a take only when it wants the next one to start.
  var audio = { src: '', plays: [], load: function () {}, play: function () { this.plays.push(this.src); return Promise.resolve(); } };
  var timer = makeTimer();
  var shim = createRuntime({ makeHostNode: function (n) { return n.type === 'audio' ? audio : { tagName: n.type }; } });
  var client = loadClient(shim, { target: TARGET, fetch: fetchImpl, timer: timer });
  var comp = client.apply();
  if (!comp) throw new Error('panel did not register');
  function commit() { const b = {}; shim.render(comp(), b); shim.runEffects(); return b; }

  var bag = commit();
  await flush();
  if (typeof bag.TtsBox.onModelChange === 'function') { bag.TtsBox.onModelChange('tts', 'm1'); bag = commit(); await flush(); }
  else throw new Error('TtsBox.onModelChange not exposed to the test harness');

  var readBtn = null, nextBtn = null;
  for (var i = 0; i < shim.rt.created.length; i++) {
    var el = shim.rt.created[i];
    var cls = String((el && el.props && el.props.className) || '');
    if (el && el.type === 'button') {
      if (!readBtn && cls.split(/\s+/).indexOf('audio-play-tp-read387') >= 0 && typeof el.props.onClick === 'function') readBtn = el.props.onClick;
      if (!nextBtn && cls.split(/\s+/).indexOf('audio-play-tp-next') >= 0 && typeof el.props.onClick === 'function') nextBtn = el.props.onClick;
    }
  }
  if (!readBtn) throw new Error('the read button is not in the rendered tree');
  if (!nextBtn) throw new Error('the transport next control is not in the rendered tree');

  readBtn();
  await flush();
  bag = commit();
  await flush();
  var settled = 0;
  while (settled < 15) { await flush(); bag = commit(); await flush(); settled++; }
  var fired = 0;
  while (timer.pending() > 0 && fired < 12) { var pr = timer.fireOne(); if (pr && typeof pr.catch === 'function') await pr.catch(function () {}); await flush(); bag = commit(); await flush(); fired++; }

  check('T-824 fixture: the read-aloud dispatched three parts and the first one is being heard',
    dispatches === 3 && audio.plays[0] === '/deepamp/ap-0511', 'dispatches=' + dispatches + ' played=' + JSON.stringify(audio.plays));
  check('T-824 fixture: the parts behind it are still queued - nothing has been ended by this test',
    audio.plays.length === 1, 'played=' + JSON.stringify(audio.plays));

  nextBtn();
  await flush();
  bag = commit();
  await flush();
  // The take being heard now reaches its end. What starts next is the whole question: the ordered
  // inserter had ap-0512 and ap-0513 queued behind it, and the walk empties that queue before it
  // queues the row it stepped to (lib/client.js:19806-19807).
  if (typeof audio.onended === 'function') audio.onended();
  await flush();
  for (var w = 0; w < 40 && audio.plays.length < 2; w++) { await flush(); bag = commit(); await flush(); }

  check('T-824: the row a press reaches is the NEXT PART of the read being heard, not another finished row (re-cut 2026-11-13 as a T-827 note on what this measurement shows: the observable here is the take that starts when the current one ends, and that is the read-aloud path keeping its own order across a press — the read path never calls play_job. The transport walk itself is measured in the T-827 scenario below, which reads the play_job requests the walk makes. The condition and its outcome are unchanged.)',
    audio.plays[1] === '/deepamp/ap-0512', 'played=' + JSON.stringify(audio.plays) + ' expected=/deepamp/ap-0512');

  if (global.localStorage) { try { delete global.localStorage; } catch (e) { global.localStorage = undefined; } }
}

// T-824 (2026-11-13, the half that the operator's own run shows). Their first attempt was a
// 2 000-character split: `ap-1372` (1 955 chars) ERRORED and `ap-1373` (835 chars) rendered ok a
// second later, and the panel asked to play ap-1373 through `play_job` — a verb the read-aloud
// path never calls. The ordered inserter releases a stream only while `st.pend[st.head]` exists
// (lib/client.js:16058) and its head advances only on a successful release; the branch a
// panel-dispatched row takes when it settles as error or aborted calls `dropPending(id)` and
// nothing else (:17116-17130). A chunk that fails therefore never advances the head, and every
// later chunk of that read stays stashed. This is the reproduction: three parts, the FIRST one
// fails, and the read must still play the two that came.
async function chunkOrderAfterFailedChunk() {
  console.log('\n--- scenario: a read-aloud whose first chunk fails (T-824) ---');
  global.localStorage = {
    _s: {},
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
    setItem: function (k, v) { this._s[k] = String(v); },
    removeItem: function (k) { delete this._s[k]; },
    clear: function () { this._s = {}; },
  };
  global.localStorage.setItem('deepamp:agentplay', '0');
  global.localStorage.setItem('deepamp:chunkSize', '200');

  var WORDS = "the quick brown fox jumps over the lazy dog near the quiet riverbank while the evening sun sets slowly behind the distant hills".split(" ");
  function sentence(prefix) {
    var s = prefix + WORDS.join(" ");
    while (s.length < 150) s += " " + WORDS.slice(0, 6).join(" ");
    return s.replace(/\s+$/, ".");
  }
  var LONG_TEXT = [sentence("A"), sentence("B"), sentence("C")].join(" ");
  var CHUNK_IDS = ['ap-0701', 'ap-0702', 'ap-0703'];
  var dispatches = 0;
  var fetchImpl = function (url, opts) {
    var u = String(url);
    var body;
    if (/get_endpoints/.test(u)) body = { tts: { url: 'http://cpu1.test:8963', route: 'speech' }, stt: { url: 'http://cpu1.test:8962', route: 'speech' } };
    else if (/server_status/.test(u)) body = { tts: { ok: true }, stt: { ok: true } };
    else if (/playlist_list/.test(u)) body = { items: [], queues: {}, auto_gen: { state: 'off' } };
    else if (/last_agent_message/.test(u)) body = { ok: true, text: LONG_TEXT, truncated: false };
    else if (/dispatch_tts/.test(u)) {
      var id = CHUNK_IDS[dispatches] || CHUNK_IDS[CHUNK_IDS.length - 1];
      dispatches++;
      body = { ok: true, job_id: id, route_url: '/deepamp/' + id };
    } else if (/job_status\/(ap-\d+)/.test(u)) {
      var jid = /job_status\/(ap-\d+)/.exec(u)[1];
      // chunk 0 is the one the lane refuses — the shape of ap-1372, a chunk too long for the engine.
      body = jid === 'ap-0701'
        ? { ok: true, id: jid, kind: 'tts', status: 'error', error: 'engine refused this chunk' }
        : { ok: true, id: jid, kind: 'tts', status: 'ok', route_url: '/deepamp/' + jid };
    }
    else if (/get_models|refresh_voices/.test(u)) body = { models: [{ id: 'm1', loaded: true }], voices: ['v1'] };
    else body = { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
  };
  var audio = { src: '', plays: [], load: function () {}, play: function () { this.plays.push(this.src); var self = this; return Promise.resolve().then(function () { if (self.onended) self.onended(); }); } };
  var timer = makeTimer();
  var shim = createRuntime({ makeHostNode: function (n) { return n.type === 'audio' ? audio : { tagName: n.type }; } });
  var client = loadClient(shim, { target: TARGET, fetch: fetchImpl, timer: timer });
  var comp = client.apply();
  if (!comp) throw new Error('panel did not register');
  function commit() { const b = {}; shim.render(comp(), b); shim.runEffects(); return b; }

  var bag = commit();
  await flush();
  if (typeof bag.TtsBox.onModelChange === 'function') { bag.TtsBox.onModelChange('tts', 'm1'); bag = commit(); await flush(); }
  else throw new Error('TtsBox.onModelChange not exposed to the test harness');
  var readBtn = null;
  for (var i = 0; i < shim.rt.created.length; i++) {
    var el = shim.rt.created[i];
    if (el && el.type === 'button' && String((el.props || {}).className || '').split(/\s+/).indexOf('audio-play-tp-read387') >= 0
      && typeof el.props.onClick === 'function') { readBtn = el.props.onClick; break; }
  }
  if (!readBtn) throw new Error('the read button is not in the rendered tree');
  readBtn();
  await flush();
  bag = commit(); await flush();
  var settled = 0;
  while (settled < 15) { await flush(); bag = commit(); await flush(); settled++; }
  var fired = 0;
  while (timer.pending() > 0 && fired < 20) { var pr = timer.fireOne(); if (pr && typeof pr.catch === 'function') await pr.catch(function () {}); await flush(); bag = commit(); await flush(); fired++; }
  for (var extra = 0; extra < 12; extra++) {
    var pr2 = timer.pending() > 0 ? timer.fireOne() : null;
    if (pr2 && typeof pr2.catch === 'function') await pr2.catch(function () {});
    await flush(); bag = commit(); await flush();
  }

  check('T-824 fixture: the read dispatched three parts and the first one the lane refused',
    dispatches === 3, 'dispatches=' + dispatches);
  check('T-824: a failed first chunk does not freeze the rest of the read - the two parts that rendered are played',
    audio.plays.length === 2, 'played=' + JSON.stringify(audio.plays));
  check('T-824: and they are played in the order the message was written',
    audio.plays[0] === '/deepamp/ap-0702' && audio.plays[1] === '/deepamp/ap-0703', 'played=' + JSON.stringify(audio.plays));

  if (global.localStorage) { try { delete global.localStorage; } catch (e) { global.localStorage = undefined; } }
}

// T-184 (user request u2, 2026-10-04): the header must name WHAT is playing. This
// drives the real panel with an <audio> whose play() resolves but does NOT end the
// file by itself — the test fires 'ended' — so all three header states are observable:
// idle (before anything is queued), playing (title + queue position 1/2, 2/2) and
// finished (the last title kept and marked, after the real onended chain).
async function nowPlayingHeader() {
  console.log('\n--- scenario: header shows the playing title, position, and finish (T-184) ---');
  const IDS = ['ap-0501', 'ap-0502'];
  let dispatches = 0;
  const polls = { 'ap-0501': 0, 'ap-0502': 0 };
  const fetchImpl = function (url, opts) {
    const u = String(url);
    let body;
    if (/get_endpoints/.test(u)) body = { tts: { url: 'http://cpu1.test:8963', route: 'speech' }, stt: { url: 'http://cpu1.test:8962', route: 'speech' } };
    else if (/server_status/.test(u)) body = { tts: { ok: true }, stt: { ok: true } };
    else if (/playlist_list/.test(u)) body = { items: IDS.slice(0, dispatches).map(function (id469) {
      // T-469: this fixture used to answer an EMPTY playlist while the panel played a take it had just
      // dispatched, which no real host does - playlist_list answers full rows. With no row to match, the
      // ticker had nothing to name and the test could not see the identity a playing take is supposed to
      // carry. The row now carries the words it was asked to speak, the file the host wrote and the model
      // that wrote it, which is what a row of record looks like.
      return { id: id469, fn: 'tts', kind: 'tts', status: 'ok', route_url: '/deepamp/' + id469,
        text: 'the take words ' + id469, filename: id469 + '_m1_gen_the-take-words.wav',
        model: 'm1', quant: 'q8_0', duration: 4, output_path: '/tmp/' + id469 + '_m1_gen_the-take-words.wav' };
    }) };
    else if (/dispatch_tts/.test(u)) {
      const id = IDS[dispatches] || IDS[IDS.length - 1];
      dispatches++;
      body = { ok: true, job_id: id, route_url: '/deepamp/' + id, status: 'queued', position: dispatches };
    } else if (/job_status\/(ap-\d+)/.test(u)) {
      const jid = /job_status\/(ap-\d+)/.exec(u)[1];
      polls[jid]++;
      body = polls[jid] >= 1
        ? { ok: true, id: jid, kind: 'tts', status: 'ok', route_url: '/deepamp/' + jid,
            // T-469 (user 2026-10-15): the fixture now carries what a real row carries - the words it was
            // asked to speak, the file the host wrote, and the model that wrote it - because the pin this
            // scenario is for is about a row that HAS words. Without them the ticker line fell back to the
            // play item's own label and the test could not see whether the id is printed when a take speaks.
            text: 'the take words ' + jid, filename: jid + '_m1_gen_the-take-words.wav', model: 'm1', quant: 'q8_0' }
        : { ok: true, id: jid, kind: 'tts', status: 'running' };
    }
    else if (/get_models|refresh_voices/.test(u)) body = { models: [{ id: 'm1', loaded: true }], voices: ['v1'] };
    else body = { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
  };
  // play() resolves but never ends the file: the test owns 'ended'.
  const audio = { src: '', plays: [], load: function () {}, play: function () { this.plays.push(this.src); return Promise.resolve(); } };
  const timer = makeTimer();
  const shim = createRuntime({ makeHostNode: function (n) { return n.type === 'audio' ? audio : { tagName: n.type }; } });
  const client = loadClient(shim, { target: TARGET, fetch: fetchImpl, timer: timer });
  const comp = client.apply();
  if (!comp) throw new Error('panel did not register');
  function commit() { const b = {}; shim.render(comp(), b); shim.runEffects(); return b; }

  function readout() {
    const el = shim.rt.created.filter(function (e) { return e.props && e.props.className === 'audio-play-now'; }).pop();
    if (!el) return null;
    return { text: [].concat(el.props.children || []).join(''), tip: String(el.props.title || ''), style: el.props.style || {} };
  }

  let bag = commit();
  await flush();
  let r = readout();
  check('header readout rendered in the header row', !!r, 'no .audio-play-now element');
  check('idle before anything plays (not an empty slot)', !!r && r.text === 'idle' && r.tip === 'nothing playing yet', r && [r.text, r.tip]);

  const rootStore = shim.rt.stores.get(bag.AudioPlayerPanel.__key);
  for (let i = 0; i < rootStore.length; i++) if (rootStore[i] === '') { rootStore[i] = 'header me'; }
  bag = commit();
  await flush();
  bag.TtsBox.dispatchTts();
  await flush();
  bag = commit();
  bag.TtsBox.dispatchTts();
  await flush();
  // Commit AFTER the second dispatch: the poll tick reads the live pending map
  // through a ref that only a render refreshes, so without this pass the second
  // job would never be polled (same order multiJob uses).
  bag = commit();
  await flush();

  let fired = 0;
  while (timer.pending() > 0 && fired < 8) { await timer.fireOne(); fired++; }
  await flush();
  bag = commit();
  await flush();

  check('both jobs dispatched and both settled (setup is real)', dispatches === 2 && polls['ap-0501'] > 0 && polls['ap-0502'] > 0, JSON.stringify(polls));
  check('first item playing, second still queued (no onended yet)', audio.plays.length === 1 && audio.src === '/deepamp/ap-0501', JSON.stringify(audio.plays));
  r = readout();
  // T-300 U-15 CONTRACT CHANGE (user 2026-10-12, 19:23): the ticker line names the item; the QUEUE POSITION
  // moved into its hover. The line is one narrow bar that has to survive an 80-character title, and the rule
  // the user gave it is "either display currently played task from the playlist, or status/error" — a queue
  // counter is neither. The play-marker glyph is gone from the text as well: the ticker IS the playing state,
  // and the two lane lamps beside it are what say which lane is working.
  check('T-300 U-15 CONTRACT CHANGE: the ticker names the item and the queue position 1/2 rides its hover (was: 1/2 printed in the line)',
    !!r && /ap-0501/.test(r.text) && /queue position 1\/2/.test(r.tip) && !/\u25B6/.test(r.text), r && [r.text, r.tip]);
  check('playing tooltip carries the full label + route', !!r && r.tip.indexOf('ap-0501') >= 0 && r.tip.indexOf('/deepamp/ap-0501') >= 0, r && r.tip);

  // T-469 (user 2026-10-15, verbatim): "seems like at some point we dropped that the 'scrolling top row in player
  // is also displaying the ap-XXXX id and the tile while playing (and scrolling) - currently it displays only my
  // prompt text for ap-505". The fixture row now SPEAKS (it has text), which is the case the complaint is about:
  // the line must lead with the row's own id and carry its derived label - the model read off the file the host
  // wrote - and only then the words, which is what scrolls.
  check('T-469: while a take plays the line leads with its ap-XXXX id and carries the derived label before the words',
    !!r && /^ap-0501 \u00B7 m1 \u00B7 the take words ap-0501/.test(r.text), r && r.text);
  check('playing state is not the idle look', !!r && r.text !== 'idle' && r.style.fontStyle !== 'italic', r && r.style);

  if (typeof audio.onended === 'function') audio.onended();
  await flush();
  bag = commit();
  await flush();
  check('queue advanced on ended (second item now playing)', audio.plays.length === 2 && audio.src === '/deepamp/ap-0502', JSON.stringify(audio.plays));
  r = readout();
  check('T-300 U-15: the ticker switched to the second item, its hover says 2/2 (was: 2/2 printed in the line)',
    !!r && /ap-0502/.test(r.text) && /queue position 2\/2/.test(r.tip), r && [r.text, r.tip]);

  if (typeof audio.onended === 'function') audio.onended();
  await flush();
  bag = commit();
  await flush();
  r = readout();
  check('FINISHED state keeps the last title and marks it', !!r && /ap-0502/.test(r.text) && /finished/.test(r.text), r && r.text);
  // T-469: the finished line keeps the same identity it had while playing - id, label, words, then the mark.
  check('T-469: the finished line keeps the id and the derived label it carried while playing',
    !!r && /^ap-0502 \u00B7 m1 \u00B7 the take words ap-0502 \u00B7 finished$/.test(r.text), r && r.text);
  check('finished does NOT look active (no play marker)', !!r && r.text.indexOf('\u25B6') < 0 && r.style.fontStyle === 'italic', r && [r.text, r.style.fontStyle]);
  check('finished state is not silently cleared back to idle', !!r && r.text !== 'idle', r && r.text);
  check('no undefined / null / [object Object] ever reaches the header',
    !!r && !/undefined|null|\[object Object\]/.test(r.text), r && r.text);

  check('no timer left armed after the run', timer.pending() === 0, 'pending=' + timer.pending());
}

// T-184 (u2): the title RULES, asserted on the shipped helper extracted from the
// real source and eval'd — the same idiom tests/shell_safety.test.cjs uses for the
// host validators, not a reimplementation here. Every UI caller passes a label, so
// the filename-from-route branch is otherwise unreachable through the panel.
function titleRules() {
  console.log('\n--- title derivation rules (T-184, helper extracted from lib/client.js) ---');
  const SRC = fs.readFileSync(TARGET, 'utf8');
  const a = SRC.indexOf('function playTitle(label, url) {');
  // T-210 (S-2): rowTitle now takes the endpoint registry too, so the END marker of this
  // extraction follows the real signature. The extracted slice is still exactly playTitle.
  // (T-846 contract change, 2026-11-14) The signature gained a third argument — the lane answer the row's own
  // sentences read a machine cap off (`rowTitle(j, registry, q)`). The marker is re-cut onto the real signature, the
  // way T-210 re-cut it onto the registry argument; the extracted slice is still exactly playTitle and every rule
  // below it is unchanged.
  const b = SRC.indexOf('function rowTitle(j, registry, q) {');
  if (a < 0 || b < 0 || b <= a) { check('playTitle extractable from the client source (T-210: rowTitle(j, registry); T-846: the lane answer joins it)', false, 'markers not found'); return; }
  const PT = (0, eval)('(function () {\n' + SRC.slice(a, b) + '\nreturn playTitle;\n})()');
  check('label wins: a row label is used verbatim', PT('ap-0042', '/deepamp/ap-0042') === 'ap-0042', PT('ap-0042', '/deepamp/ap-0042'));
  check('label wins: a stem row keeps "id · stem"',
    PT('ap-0042 · vocals', '/deepamp/ap-0042?stem=vocals') === 'ap-0042 · vocals', PT('ap-0042 · vocals', '/deepamp/ap-0042?stem=vocals'));
  check('no label: /deepamp/ prefix + .wav suffix + model_voice pair stripped, job id KEPT',
    PT('', '/deepamp/ap-0042_qwen3-tts_bijan_hello.wav') === 'ap-0042 · hello', PT('', '/deepamp/ap-0042_qwen3-tts_bijan_hello.wav'));
  check('no label: bare route yields the job id', PT(undefined, '/deepamp/ap-0042') === 'ap-0042', PT(undefined, '/deepamp/ap-0042'));
  check('no label: an absolute engine route still lands on the job id',
    PT(null, 'http://cpu1.test:8963/deepamp/ap-0099_glm-tts_bijan-0048_a_line.wav') === 'ap-0099 · a_line',
    PT(null, 'http://cpu1.test:8963/deepamp/ap-0099_glm-tts_bijan-0048_a_line.wav'));
  check('no label: id + model only (no text slug) keeps both, id first',
    PT('', '/deepamp/ap-0042_qwen3-tts') === 'ap-0042 · qwen3-tts' &&
    PT('', '/deepamp/ap-0042_qwen3-tts_bijan') === 'ap-0042',
    [PT('', '/deepamp/ap-0042_qwen3-tts'), PT('', '/deepamp/ap-0042_qwen3-tts_bijan')]);
  check('no label: stem / src query is named, not dropped',
    PT('', '/deepamp/ap-0042?stem=vocals') === 'ap-0042 · vocals' && PT('', '/deepamp/ap-0042?src=1') === 'ap-0042 · src',
    [PT('', '/deepamp/ap-0042?stem=vocals'), PT('', '/deepamp/ap-0042?src=1')]);
  check('a malformed %xx stem stays literal instead of throwing',
    PT('', '/deepamp/ap-0042?stem=%zz') === 'ap-0042 · %zz', PT('', '/deepamp/ap-0042?stem=%zz'));
  check('junk labels never reach the header (object, [object Object], whitespace)',
    PT({}, '/deepamp/ap-0042') === 'ap-0042' &&
    PT('[object Object]', '/deepamp/ap-0042') === 'ap-0042' &&
    PT('   ', '/deepamp/ap-0042') === 'ap-0042',
    [PT({}, '/deepamp/ap-0042'), PT('[object Object]', '/deepamp/ap-0042'), PT('   ', '/deepamp/ap-0042')]);
  check('nothing to name: falls back to the raw route, never undefined/null',
    PT('', 'http://x/y/z.wav') === 'http://x/y/z' && PT('', '') === '' && PT(undefined, undefined) === '',
    [PT('', 'http://x/y/z.wav'), PT('', ''), PT(undefined, undefined)]);
}

// T-308 (user 2026-10-13, 06:20): "The text should not scroll if it fits, if it scrolls it should scroll around
// and start from the beginning before the end is done with the scroll (it should go around)".
// The marquee effect is extracted from lib/client.js the same way playTitle is extracted above, and RUN against
// fake nodes that report their own widths. That MEASURES the mechanism instead of reading for it. A 200 px box
// holding a 400 px line must (1) move, (2) move both copies in lockstep, (3) wrap back to zero after one period
// of 424 px - the line plus the 24 px gap the single pass used to end with - with no jump and no dead gap, and
// (4) a line that fits must get no timer at all. A paused take freezes the offset where it stands and resumes on
// play, the way the strip has frozen since T-307.
function marqueeRules() {
  console.log('\n--- marquee loop rules (T-308, effect extracted from lib/client.js) ---');
  const SRC = fs.readFileSync(TARGET, 'utf8');
  const a = SRC.indexOf('var tickerBox300 = React.useRef(null);');
  const END = '}, [tickerTxt300]);';
  const b = SRC.indexOf(END, a);
  if (a < 0 || b < 0) { check('the marquee effect is extractable from the client source (T-308)', false, 'markers not found'); return; }
  const body = SRC.slice(a, b + END.length);
  check('T-308 CONTRACT CHANGE: the single-pass end is gone - the offset wraps instead of ending a pass and restarting',
    !/if \(tickerOff300\.current > sw \+ 24\)/.test(body) && /\(tickerOff300\.current \+ 1\) % period308/.test(body),
    body.indexOf('% period308') >= 0 ? 'wrap formula present' : 'no wrap formula');
  const make = (0, eval)('(function (React, setInterval, clearInterval, playPaused299, tickerTxt300) {\n'
    + body + '\nreturn null;\n})');
  function node(w) {
    return { clientWidth: w, style: {}, getBoundingClientRect: function () { return { width: w }; } };
  }
  function run(boxW, spanW, paused) {
    const refs = [];
    const captured = { effect: null, fn: null, ms: 0, cleared: 0 };
    const ReactShim = {
      useRef: function (v) { const r = { current: v }; refs.push(r); return r; },
      useEffect: function (f) { captured.effect = f; },
    };
    make(ReactShim, function (f, ms) { captured.fn = f; captured.ms = ms; return { unref: function () {} }; },
      function () { captured.cleared++; }, !!paused, 'a take whose title is far too long for the strip beside it');
    const box = node(boxW), span = node(spanW), echo = node(spanW);
    if (refs.length !== 5) return { error: 'the effect does not own five refs (box, span, offset, echo, pause): ' + refs.length };
    refs[0].current = box; refs[1].current = span; refs[3].current = echo; refs[4].current = !!paused;
    captured.effect();
    return { box: box, span: span, echo: echo, refs: refs, captured: captured };
  }
  function steps(r, n) {
    const out = [];
    for (let i = 0; i < n; i++) {
      r.captured.fn();
      out.push([String(r.span.style.transform || ''), String(r.echo.style.transform || '')]);
    }
    return out;
  }
  const num = function (t) { const m = /translateX\((-?\d+)px\)/.exec(String(t || '')); return m ? parseInt(m[1], 10) : NaN; };

  // 1. A line that fits gets no motion and no timer at all.
  const fits = run(500, 400, false);
  check('T-308: a line that fits the box is not scrolled, and no timer is created for it',
    !fits.captured.fn && fits.span.style.transform === 'translateX(0px)',
    [fits.captured.fn ? 'timer created' : 'no timer', fits.span.style.transform]);
  check('T-308: a line that fits also parks its echo out of the box (it cannot leave a second copy standing there)',
    fits.echo.style.visibility === 'hidden', JSON.stringify(fits.echo.style));

  // 2. A line that overflows moves, and BOTH copies move together.
  const mv = run(200, 400, false);
  check('T-308: an overflowing line gets the same 40 ms timer it always had',
    !!mv.captured.fn && mv.captured.ms === 40, mv.captured.ms);
  check('T-308: the echo is placed exactly one line plus the old 24 px gap behind the head, so the strip is continuous',
    mv.echo.style.left === '424px' && mv.echo.style.visibility === 'visible',
    [mv.echo.style.left, mv.echo.style.visibility]);
  const seq = steps(mv, 700);
  const nums = seq.map(function (p) { return num(p[0]); });
  const period = 424;
  const lockstep = seq.every(function (p) { return p[1] === p[0]; });
  const continuous = nums.every(function (n, i) {
    if (!isFinite(n)) return false;
    if (i === 0) return n === -1;
    const prev = nums[i - 1];
    return (n === 0 && prev === -(period - 1)) || n === prev - 1;
  });
  check('T-308: both copies carry the same offset on every step (one strip, not two independent marquees)',
    lockstep, mv.echo.style.transform + ' vs ' + mv.span.style.transform);
  check('T-308: the offsets run one pixel at a time and WRAP back to zero at the period, with no jump and no gap',
    continuous && nums[0] === -1, [nums.slice(0, 3), nums[period - 1], nums[period], nums[period + 1]]);
  // Step k carries offset k, so the last step of a period is index period-2 (0-based) and the wrap lands on
  // index period-1. That deepest point is the moment the head is already entering the box while its own tail is
  // still leaving it - which is the user's sentence, measured.
  check('T-308: the deepest offset is the whole period less one, then zero - the head enters while its tail is still leaving',
    nums[period - 2] === -(period - 1) && nums[period - 1] === 0, [nums[period - 2], nums[period - 1], nums[period]]);
  check('T-308: the echo never drops out mid-loop (a loop with a blank half is the dead gap the user rejected)',
    mv.echo.style.visibility === 'visible', mv.echo.style.visibility);

  // 3. A paused take freezes the marquee with everything else and resumes on play.
  const pz = run(200, 400, true);
  pz.captured.fn(); pz.captured.fn();
  const frozen = pz.span.style.transform;
  check('T-308: a paused take does not advance the marquee (the strip is frozen since T-307, the line now matches it)',
    frozen === 'translateX(0px)' || !/-[1-9]/.test(String(frozen)), frozen);
  pz.refs[4].current = false;
  pz.captured.fn();
  check('T-308: letting the take play on resumes the same line where it stood',
    pz.span.style.transform === 'translateX(-1px)', pz.span.style.transform);
}

// T-559 (operator request 2026-10-17, verbatim): "i play title ap-0665, and at the end it stops instead of playing
// ap-0666 and then ap-0667 ... maybe a fast forward button in playlist header, what do you think? -> implement". The
// ruling that came back: "it's not a \"press button\", it's a toggle button that should \"auto-play\" the next
// playlist item after current item (or wait for it's render and play then) if enabled, otherwise should stop playing
// after each manual started play", and on the three questions left open: "default on, remembered, skip failed".
//
// One mounted panel, three rows the panel did NOT create (so the agent auto-play path is out of the picture, and it
// is switched off in storage as well), and a press on the first row. What is measured is the ORDER of routes handed
// to the player, which is the only honest read of "it played ap-0666 and then ap-0667".
async function fastForwardToggle() {
  console.log('\n--- scenario: the fast-forward toggle carries a take on to the next row (T-559) ---');
  global.localStorage = {
    _s: {},
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
    setItem: function (k, v) { this._s[k] = String(v); },
    removeItem: function (k) { delete this._s[k]; },
    clear: function () { this._s = {}; },
  };
  global.localStorage.setItem('deepamp:agentplay', '0');   // the OTHER auto-play path is off, on purpose
  const IDS559 = ['ap-0601', 'ap-0602', 'ap-0603'];
  let flip559 = false;                       // ap-0603 is still rendering until the test says otherwise
  const fetchImpl = function (url, opts) {
    const u = String(url);
    let body;
    if (/get_endpoints/.test(u)) body = { tts: { url: 'http://cpu1.test:8963', route: 'speech' }, stt: { url: 'http://cpu1.test:8962', route: 'speech' } };
    else if (/server_status/.test(u)) body = { tts: { ok: true }, stt: { ok: true } };
    else if (/get_models|refresh_voices/.test(u)) body = { models: [{ id: 'm1', loaded: true }], voices: ['v1'] };
    else if (/playlist_list/.test(u)) {
      body = { items: IDS559.slice().reverse().map(function (id559, ix559) {   // newest-first, the way the host hands it out
        const st559 = (id559 === 'ap-0603' && !flip559) ? 'running' : 'ok';
        return { id: id559, fn: 'tts', kind: 'tts', status: st559, route_url: '/deepamp/' + id559,
          created: 1001 + IDS559.indexOf(id559),   // the stamp follows the mint order, not the list order
          text: 'the take words ' + id559, model: 'm1', quant: 'q8_0', duration: 3,
          filename: id559 + '_m1_gen_the-take-words.wav', output_path: '/tmp/' + id559 + '_m1_gen_the-take-words.wav' };
      }) };
    } else if (/play_job\/(ap-\d+)/.test(u)) {
      // The client sends the row id IN THE PATH (lib/client.js call(): play_job / abort_job / cancel_job all do),
      // and the host reads it from there (handleApi: parts[0] === 'play_job', then parts[1]).
      const id559 = /play_job\/(ap-\d+)/.exec(u)[1];
      body = { ok: true, job_id: id559, route_url: '/deepamp/' + id559, status: 'ok' };
    } else body = { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
  };
  // play() resolves and does NOT end the file: the test owns 'ended', exactly like the T-184 scenario above.
  const audio = { src: '', plays: [], load: function () {}, play: function () { this.plays.push(this.src); return Promise.resolve(); } };
  const timer = makeTimer();
  // The shared makeTimer's interval() is INERT on purpose (every other scenario in this file relies on that), but a
  // fast-forward wait is resolved by the panel-s own cadence read, so THIS fixture gives this panel a timer whose
  // interval actually repeats. Nothing else about the fixture changes.
  const ivals559 = [];
  timer.interval = function (cb) { const e559 = { cb: cb }; ivals559.push(e559); return function () { const i559 = ivals559.indexOf(e559); if (i559 >= 0) ivals559.splice(i559, 1); }; };
  timer.pending = function () { return ivals559.length; };
  timer.fireOne = async function () { if (!ivals559.length) return false; ivals559[0].cb(); await flush(); return true; };
  const shim = createRuntime({ makeHostNode: function (n) { return n.type === 'audio' ? audio : { tagName: n.type }; } });
  const client = loadClient(shim, { target: TARGET, fetch: fetchImpl, timer: timer });
  const comp = client.apply();
  if (!comp) throw new Error('panel did not register');
  function commit() { const b = {}; shim.render(comp(), b); shim.runEffects(); return b; }
  const ffBtn559 = function () {
    return shim.rt.created.filter(function (e) { return e.props && e.props.className === 'audio-play-ff-toggle559'; }).pop();
  };
  const end = async function () { if (typeof audio.onended === 'function') audio.onended(); await flush(); bag = commit(); await flush(); };
  const plays559 = function () { return audio.plays.join(' '); };

  let bag = commit();
  await flush();
  bag = commit();
  await flush();
  check('T-559 setup: three rows the panel did not create are listed, and nothing plays on its own (the agent auto-play path is off in storage and primed by the mount read)',
    audio.plays.length === 0 && (shim.rt.created.filter(function (e) { return e.props && e.props.className === 'audio-play-row-main'; }).length >= 3),
    [JSON.stringify(audio.plays), shim.rt.created.filter(function (e) { return e.props && e.props.className === 'audio-play-row-main'; }).length]);
  const btnOn559 = ffBtn559();
  check('T-559 (the control is a TOGGLE that shows its state, and the ruling\'s default is ON) -- and the NAME of it, which the operator ruled on 2026-10-17: "the fast forward button should NOT be named as such, redo the tooltip: \'Auto play next track if available\' is far better". The header carries it, it reads as a state and not an action, aria-pressed says on, the hover IS the operator\'s own sentence, and the words fast forward are gone from it',
    !!btnOn559 && btnOn559.props.children === 'auto play on' && btnOn559.props['aria-pressed'] === 'true'
    && String(btnOn559.props.title || '').indexOf('Auto play next track if available') === 0
    && !/fast[ -]forward/i.test(String(btnOn559.props.title || ''))
    && /still rendering is waited for/.test(String(btnOn559.props.title || ''))
    && /stops at the end of the list/.test(String(btnOn559.props.title || '')),
    btnOn559 && [btnOn559.props.children, btnOn559.props['aria-pressed'], String(btnOn559.props.title || '').slice(0, 80)]);

  if (!bag.PlaylistPane || typeof bag.PlaylistPane.play !== 'function')
    throw new Error('the fixture cannot reach a row play control. bag keys: ' + Object.keys(bag).join(','));
  bag.PlaylistPane.play('ap-0601');
  await flush();
  check('T-559 setup: the row a person pressed plays first, and it is the ONLY thing that played',
    plays559() === '/deepamp/ap-0601', plays559());

  await end();
  check('T-559 (the operator-s own sentence, verbatim: "i play title ap-0665, and at the end it stops instead of '
      + 'playing ap-0666 and then ap-0667"): the take reached its end and the panel carried on to the NEXT row in the '
      + 'order the lane made them - ap-0601, then ap-0602, with no second press from anyone',
    plays559() === '/deepamp/ap-0601 /deepamp/ap-0602', plays559());

  await end();
  check('T-559 (the wait half, verbatim: "or wait for it\'s render and play then"): the row after ap-0602 is still '
      + 'rendering, so the panel waits for THAT row - it does not play it early and it does not skip past it to '
      + 'something later - and the player is left holding the take that just ended',
    audio.plays.length === 2 && audio.src === '/deepamp/ap-0602', plays559());

  flip559 = true;
  let fired559 = 0;
  // The cadence read is what learns a row settled; the loop stops as soon as the waited row plays, and it cannot
  // run away because a repeating interval is bounded here by the fire count.
  while (fired559 < 8 && audio.plays.length < 3) { if (!await timer.fireOne()) break; fired559++; }
  await flush();
  bag = commit();
  await flush();
  check('T-559 (the wait resolves on the panel-s own poll, at no extra cost): the row rendered and the walk played '
      + 'it - ap-0601, ap-0602, ap-0603, one press and three takes',
    plays559() === '/deepamp/ap-0601 /deepamp/ap-0602 /deepamp/ap-0603', plays559());

  await end();
  check('T-559 (the walk stops at the end of the list; it does not wrap back to the top): after the last row nothing '
      + 'is played, and the panel does not replay the list from ap-0601',
    audio.plays.length === 3 && audio.plays[0] === '/deepamp/ap-0601', plays559());

  const btnOff559 = ffBtn559();
  if (!btnOff559) throw new Error('the fast-forward control vanished from the header mid-scenario');
  btnOff559.props.onClick();
  bag = commit();
  await flush();
  const btnAfter559 = ffBtn559();
  check('T-559 (the ruling\'s "remembered", and the toggle half of "it\'s not a press button"): pressing the control '
      + 'flips a STATE that is written to the panel-s own storage and read back as off, not an action that fires once',
    !!btnAfter559 && btnAfter559.props.children === 'auto play off' && btnAfter559.props['aria-pressed'] === 'false'
    && global.localStorage.getItem('deepamp:fastfwd') === '0',
    btnAfter559 && [btnAfter559.props.children, btnAfter559.props['aria-pressed'], global.localStorage.getItem('deepamp:fastfwd')]);

  const held559 = audio.plays.length;
  bag.PlaylistPane.play('ap-0601');
  await flush();
  await end();
  check('T-559 the other half of the ruling, verbatim: "otherwise should stop playing after each manual started '
      + 'play": with the toggle off, the take a person started plays, reaches its end, and NOTHING follows it - the '
      + 'list still holds ap-0602 and ap-0603 and the panel leaves them where they are',
    audio.plays.length === held559 + 1 && audio.plays[audio.plays.length - 1] === '/deepamp/ap-0601', plays559());

  if (global.localStorage) { try { delete global.localStorage; } catch (e) { global.localStorage = undefined; } }
}

// T-827 (2026-11-13). The operator's words: "it jumps from ap-1444 to 1446 instead of 1445 during normal playback
// for example - why ?" Those three rows, read off the live lane the same hour: ap-1444 created 1794592691970,
// ap-1445 created 1794592691970 — the SAME millisecond — and ap-1446 created 1794592691971. A chunked read mints
// its rows in one event-loop turn, so `Date.now()` answers the same millisecond for several of them; a sort keyed
// on the stamp alone leaves tied rows in the order they arrived, and the host hands the playlist out newest-first,
// so the tied pair sat in the walk reversed and the step forward from the first of them landed on the row a
// millisecond later. This is that shape, with the same distances: two rows sharing a stamp and one a millisecond
// after it.
async function walkOrderTiedStamps() {
  console.log('\n--- scenario: a transport next through a burst of rows sharing one created stamp (T-827) ---');
  global.localStorage = {
    _s: {},
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
    setItem: function (k, v) { this._s[k] = String(v); },
    removeItem: function (k) { delete this._s[k]; },
    clear: function () { this._s = {}; },
  };
  global.localStorage.setItem('deepamp:agentplay', '0');
  global.localStorage.setItem('deepamp:chunkSize', '200');

  var WORDS = "the quick brown fox jumps over the lazy dog near the quiet riverbank while the evening sun sets slowly behind the distant hills".split(" ");
  function sentence727(prefix) {
    var s = prefix + WORDS.join(" ");
    while (s.length < 150) s += " " + WORDS.slice(0, 6).join(" ");
    return s.replace(/\s+$/, ".");
  }
  var LONG_TEXT727 = [sentence727("A"), sentence727("B"), sentence727("C")].join(" ");
  var IDS727 = ['ap-0711', 'ap-0712', 'ap-0713'];
  // 0711 and 0712 in one millisecond, 0713 one millisecond later: the live distances of 1444 / 1445 / 1446.
  var STAMP727 = { 'ap-0711': 1794592691970, 'ap-0712': 1794592691970, 'ap-0713': 1794592691971 };
  var dispatches727 = 0;
  var asked727 = [];
  var calls727 = [];
  var fetch727 = function (url, opts) {
    var u = String(url);
    calls727.push(((opts && opts.method) || 'GET') + ' ' + u.replace(/^.*\/api\/deepamp\//, '~'));
    var body;
    if (/get_endpoints/.test(u)) body = { tts: { url: 'http://cpu1.test:8963', route: 'speech' }, stt: { url: 'http://cpu1.test:8962', route: 'speech' } };
    else if (/server_status/.test(u)) body = { tts: { ok: true }, stt: { ok: true } };
    else if (/playlist_list/.test(u)) {
      var items727 = [];
      for (var ci727 = IDS727.length - 1; ci727 >= 0; ci727--) {   // NEWEST FIRST, as the host hands it out
        if (dispatches727 <= ci727) continue;
        items727.push({ id: IDS727[ci727], kind: 'tts', status: 'ok', created: STAMP727[IDS727[ci727]], queued_at: STAMP727[IDS727[ci727]], text: 'chunk ' + ci727, duration: 4 });
      }
      body = { items: items727, queues: {}, auto_gen: { state: 'off' } };
    } else if (/last_agent_message/.test(u)) body = { ok: true, text: LONG_TEXT727, truncated: false };
    else if (/dispatch_tts/.test(u)) {
      var id727 = IDS727[dispatches727] || IDS727[IDS727.length - 1];
      dispatches727++;
      body = { ok: true, job_id: id727, route_url: '/deepamp/' + id727 };
    } else if (/play_job/.test(u)) {
      var pm727 = /ap-\d+/.exec(String((opts && opts.body) || '') + ' ' + u);
      var pid727 = pm727 ? pm727[0] : '';
      asked727.push(pid727);
      body = { ok: true, job_id: pid727, route_url: '/deepamp/' + pid727 };
    } else if (/job_status\/(ap-\d+)/.test(u)) {
      var jid727 = /job_status\/(ap-\d+)/.exec(u)[1];
      body = { ok: true, id: jid727, kind: 'tts', status: 'ok', route_url: '/deepamp/' + jid727 };
    } else if (/get_models|refresh_voices/.test(u)) body = { models: [{ id: 'm1', loaded: true }], voices: ['v1'] };
    else body = { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
  };
  var audio727 = { src: '', plays: [], load: function () {}, play: function () { this.plays.push(this.src); return Promise.resolve(); } };
  var timer727 = makeTimer();
  var shim727 = createRuntime({ makeHostNode: function (n) { return n.type === 'audio' ? audio727 : { tagName: n.type }; } });
  var client727 = loadClient(shim727, { target: TARGET, fetch: fetch727, timer: timer727 });
  var comp727 = client727.apply();
  if (!comp727) throw new Error('T-827 panel did not register');
  function commit727() { const b = {}; shim727.render(comp727(), b); shim727.runEffects(); return b; }
  var plays727 = function () { return 'played=' + JSON.stringify(audio727.plays) + ' play_job_asked=' + JSON.stringify(asked727); };

  var bag727 = commit727();
  await flush();
  if (typeof bag727.TtsBox.onModelChange === 'function') { bag727.TtsBox.onModelChange('tts', 'm1'); bag727 = commit727(); await flush(); }
  else throw new Error('TtsBox.onModelChange not exposed to the test harness');

  // The LAST control of a class, not the first. `shim.rt.created` accumulates every node the shim has
  // ever built, so the first one belongs to an early render and its closure holds the state that render
  // had — an empty playlist. Pressing that is pressing a stale component.
  var read727 = null, next727 = null, prev727 = null;
  for (var i727 = 0; i727 < shim727.rt.created.length; i727++) {
    var el727 = shim727.rt.created[i727];
    var cls727 = String((el727 && el727.props && el727.props.className) || '');
    var classes727 = cls727.split(/\s+/);
    if (el727 && el727.type === 'button' && typeof el727.props.onClick === 'function') {
      if (classes727.indexOf('audio-play-tp-read387') >= 0) read727 = el727.props.onClick;
      if (classes727.indexOf('audio-play-tp-next') >= 0) next727 = el727.props.onClick;
      if (classes727.indexOf('audio-play-tp-prev') >= 0) prev727 = el727.props.onClick;
    }
  }
  if (!read727) throw new Error('the read button is not in the rendered tree');
  if (!next727) throw new Error('the transport next control is not in the rendered tree');
  if (!prev727) throw new Error('the transport prev control is not in the rendered tree');

  read727();
  await flush();
  bag727 = commit727();
  await flush();
  var settled727 = 0;
  while (settled727 < 15) { await flush(); bag727 = commit727(); await flush(); settled727++; }
  var fired727 = 0;
  while (timer727.pending() > 0 && fired727 < 12) { var pr727 = timer727.fireOne(); if (pr727 && typeof pr727.catch === 'function') await pr727.catch(function () {}); await flush(); bag727 = commit727(); await flush(); fired727++; }

  // Re-take the transport controls from the newest render. A closure collected before the read started holds
  // the playlist as it was then, and then it was empty — pressing that one is pressing a stale component.
  next727 = null; prev727 = null;
  for (var i727b = 0; i727b < shim727.rt.created.length; i727b++) {
    var el727b = shim727.rt.created[i727b];
    var cls727b = String((el727b && el727b.props && el727b.props.className) || '').split(/\s+/);
    if (el727b && el727b.type === 'button' && typeof el727b.props.onClick === 'function') {
      if (cls727b.indexOf('audio-play-tp-next') >= 0) next727 = el727b.props.onClick;
      if (cls727b.indexOf('audio-play-tp-prev') >= 0) prev727 = el727b.props.onClick;
    }
  }
  if (!next727 || !prev727) throw new Error('the transport controls are not in the rendered tree after the read started');

  check('T-827 fixture: the read dispatched three parts and the one being heard is the FIRST of them (ap-0711 and ap-0712 share one created millisecond, ap-0713 is one millisecond later)',
    dispatches727 === 3 && audio727.plays[0] === '/deepamp/ap-0711', 'dispatches=' + dispatches727 + ' ' + plays727());

  // The observable is `play_job`, not what the panel plays. The read-aloud path never calls that verb (it plays the
  // takes its own dispatch returned), so a play_job request is the transport walk speaking, and only it.
  for (var p727 = 0; p727 < 3; p727++) {
    next727();
    await flush();
    bag727 = commit727();
    await flush();
    for (var w727 = 0; w727 < 40 && asked727.length <= p727; w727++) { await flush(); bag727 = commit727(); await flush(); }
  }
  check('T-827: three forward presses through a burst ask for the parts in the order the lane made them — ap-0711, ap-0712, ap-0713. The same three presses on the client as it was asked ap-0712, ap-0711, ap-0713: the pair sharing one millisecond sat reversed in the walk, and the step forward from the first of them landed on the row a millisecond later',
    asked727.join(',') === 'ap-0711,ap-0712,ap-0713', plays727());
  check('T-827: which is the rule the operator named in their own words — "i would expect it to play ap++ … so playback of the message parts always stays in order" — the ids the walk asks for ascend, and no row is asked for twice',
    asked727.length === 3 && asked727.every(function (id727, i727d) { return i727d === 0 || Number(id727.slice(3)) > Number(asked727[i727d - 1].slice(3)); })
    && new Set(asked727).size === asked727.length, plays727());

  prev727();
  await flush();
  bag727 = commit727();
  await flush();
  for (var w727e = 0; w727e < 40 && asked727.length < 4; w727e++) { await flush(); bag727 = commit727(); await flush(); }
  check('T-827: the reverse step goes back one in the same order — from ap-0713 it asks for ap-0712. On the client as it was it asked for ap-0711, because the reversed pair sat on the other side of it',
    asked727[3] === 'ap-0712', plays727());

  const src727 = require('fs').readFileSync(TARGET, 'utf8');
  const cnt727 = function (re727) { return (src727.match(re727) || []).length; };
  check('T-827 source: the stamp is still the primary key and the mint order is only the tie — the comparator asks the stamps first and returns to the ids on an exact tie',
    cnt727(/if \(ta !== tb\) return ta - tb;/g) === 1
    && cnt727(/return rowMint299\(a\) - rowMint299\(b\);/g) === 1
    && cnt727(/function rowMint299\(j\)/g) === 1,
    { primary_key: cnt727(/if \(ta !== tb\) return ta - tb;/g), tie_break: cnt727(/return rowMint299\(a\) - rowMint299\(b\);/g) });
  check('T-827 source: both walks use the one comparator — no sort is left keyed on the stamp alone, and the no-stamp fallback to the id order is untouched',
    cnt727(/\.sort\(rowOrderCmp299\)/g) === 2
    && cnt727(/sort\(function \(a, b\) \{ return rowWhen299\(a\) - rowWhen299\(b\); \}\)/g) === 0
    && cnt727(/return rowMint299\(j\);/g) === 1,
    { shared_comparator: cnt727(/\.sort\(rowOrderCmp299\)/g), old_stamp_only_sorts: cnt727(/sort\(function \(a, b\) \{ return rowWhen299\(a\) - rowWhen299\(b\); \}\)/g) });

  if (global.localStorage) { try { delete global.localStorage; } catch (e) { global.localStorage = undefined; } }
}

// T-842 (2026-11-14). The finding is `TODOS.md` item 30, from the client review of 2026-11-14
// (`scratch/code_review_20261114_client/`), and the operator-s word for it was "Your recommendations for 1,2,3,4
// sound good, implement accordingly" on the recommendation to fix the resume point and the fast-forward gate that
// sits next to it. The defect, in the review-s own words: the transport walk's position was looked up by searching
// the REBUILT walk list for the id of the row the walk last stood on, and a row the panel had just marked
// unplayable is no longer in that list — the search found nothing, the position stayed 0, and the next step landed
// near the top of the playlist. Pressing next across a broken row jumped away from where the person was standing.
// The row is still in the playlist the host handed out (the panel excludes it from the walk and from nothing else),
// so the slot it would have held is still knowable, and `walkPosition299` reads the position off that slot.
// The observable here is the same one T-827 chose: `play_job` requests, which only the transport walk makes.
async function walkAcrossRefusedRow() {
  console.log('\n--- scenario: a transport walk across a row the lane refuses (T-842) ---');
  global.localStorage = {
    _s: {},
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._s, k) ? this._s[k] : null; },
    setItem: function (k, v) { this._s[k] = String(v); },
    removeItem: function (k) { delete this._s[k]; },
    clear: function () { this._s = {}; },
  };
  global.localStorage.setItem('deepamp:agentplay', '0');

  var IDS842 = ['ap-0801', 'ap-0802', 'ap-0803', 'ap-0804', 'ap-0805'];
  // Five finished rows, one millisecond apart: the order is the lane-s, and no tie-break is involved.
  var STAMP842 = {};
  for (var s842 = 0; s842 < IDS842.length; s842++) STAMP842[IDS842[s842]] = 1794600000001 + s842;
  var DEAD842 = 'ap-0803';          // the row the lane says it has no file for
  var asked842 = [];
  var calls842 = [];
  var fetch842 = function (url, opts) {
    var u = String(url);
    calls842.push(((opts && opts.method) || 'GET') + ' ' + u.replace(/^.*\/api\/deepamp\//, '~'));
    var body;
    if (/get_endpoints/.test(u)) body = { tts: { url: 'http://cpu1.test:8963', route: 'speech' }, stt: { url: 'http://cpu1.test:8962', route: 'speech' } };
    else if (/server_status/.test(u)) body = { tts: { ok: true }, stt: { ok: true } };
    else if (/playlist_list/.test(u)) {
      var items842 = [];
      for (var ci842 = IDS842.length - 1; ci842 >= 0; ci842--) {   // NEWEST FIRST, as the host hands it out
        items842.push({ id: IDS842[ci842], kind: 'tts', status: 'ok', created: STAMP842[IDS842[ci842]],
          queued_at: STAMP842[IDS842[ci842]], text: 'row ' + ci842, duration: 4, route_url: '/deepamp/' + IDS842[ci842] });
      }
      body = { items: items842, queues: {}, auto_gen: { state: 'off' } };
    } else if (/play_job/.test(u)) {
      var pm842 = /ap-\d+/.exec(String((opts && opts.body) || '') + ' ' + u);
      var pid842 = pm842 ? pm842[0] : '';
      asked842.push(pid842);
      // The lane refuses ONE row and answers every other one with its route. A refusal is what marks the row
      // unplayable in the panel (markDead299) and what makes the walk try the next row in the same press.
      if (pid842 === DEAD842) body = { ok: false, error: 'no file for this row' };
      else body = { ok: true, job_id: pid842, route_url: '/deepamp/' + pid842 };
    } else if (/job_status\/(ap-\d+)/.test(u)) {
      var jid842 = /job_status\/(ap-\d+)/.exec(u)[1];
      body = { ok: true, id: jid842, kind: 'tts', status: 'ok', route_url: '/deepamp/' + jid842 };
    } else if (/get_models|refresh_voices/.test(u)) body = { models: [{ id: 'm1', loaded: true }], voices: ['v1'] };
    else body = { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
  };
  var audio842 = { src: '', plays: [], load: function () {}, play: function () { this.plays.push(this.src); return Promise.resolve(); } };
  var timer842 = makeTimer();
  var shim842 = createRuntime({ makeHostNode: function (n) { return n.type === 'audio' ? audio842 : { tagName: n.type }; } });
  var client842 = loadClient(shim842, { target: TARGET, fetch: fetch842, timer: timer842 });
  var comp842 = client842.apply();
  if (!comp842) throw new Error('T-842 panel did not register');
  function commit842() { const b = {}; shim842.render(comp842(), b); shim842.runEffects(); return b; }
  var asked842txt = function () { return 'play_job_asked=' + JSON.stringify(asked842) + ' played=' + JSON.stringify(audio842.plays); };

  var bag842 = commit842();
  await flush();
  if (typeof bag842.TtsBox.onModelChange === 'function') { bag842.TtsBox.onModelChange('tts', 'm1'); bag842 = commit842(); await flush(); }
  else throw new Error('TtsBox.onModelChange not exposed to the test harness');
  // Let the panel read the playlist it is being handed. The rows exist without any dispatch of mine.
  for (var f842 = 0; f842 < 12; f842++) { await flush(); bag842 = commit842(); await flush(); }
  while (timer842.pending() > 0 && f842 < 40) { var pr842 = timer842.fireOne(); if (pr842 && typeof pr842.catch === 'function') await pr842.catch(function () {}); await flush(); bag842 = commit842(); await flush(); f842++; }

  // The LAST control of each class, for the reason T-827 states: an earlier node holds an earlier state.
  var play842 = null, next842 = null, prev842 = null;
  for (var i842 = 0; i842 < shim842.rt.created.length; i842++) {
    var el842 = shim842.rt.created[i842];
    var cls842 = String((el842 && el842.props && el842.props.className) || '').split(/\s+/);
    if (el842 && el842.type === 'button' && typeof el842.props.onClick === 'function') {
      if (cls842.indexOf('audio-play-tp-play') >= 0) play842 = el842.props.onClick;
      if (cls842.indexOf('audio-play-tp-next') >= 0) next842 = el842.props.onClick;
      if (cls842.indexOf('audio-play-tp-prev') >= 0) prev842 = el842.props.onClick;
    }
  }
  if (!play842) throw new Error('the transport play control is not in the rendered tree');
  if (!next842) throw new Error('the transport next control is not in the rendered tree');
  if (!prev842) throw new Error('the transport prev control is not in the rendered tree');

  var press842 = async function (fn842, want842) {
    var before842 = asked842.length;
    fn842();
    await flush();
    bag842 = commit842();
    await flush();
    for (var w842 = 0; w842 < 60 && asked842.length < want842; w842++) { await flush(); bag842 = commit842(); await flush(); }
    return asked842.slice(before842);
  };

  // A walk with no position yet: the play control starts it at the FIRST row the lane made.
  await press842(play842, 1);
  check('T-842 fixture: five finished rows sit in the panel in the order the lane made them, and the walk starts at the oldest of them',
    asked842.join(',') === 'ap-0801', asked842txt());

  // Press 2 and 3 step forward in order. Press 3 reaches ap-0803, which the lane refuses.
  await press842(next842, 2);
  await press842(next842, 4);
  check('T-842: the press that reaches a row the lane refuses steps onto the row AFTER it, not back to a row already played (the walk stood on ap-0803, and ap-0804 is the row that now holds the slot ap-0803 would have held)',
    asked842.join(',') === 'ap-0801,ap-0802,ap-0803,ap-0804', asked842txt());
  check('T-842: no row is asked for twice on the way across the broken one — the old lookup answered 0 and stepped onto ap-0802 a second time',
    new Set(asked842).size === asked842.length, asked842txt());

  // The position survived: the next press goes on, and the reverse press comes back.
  await press842(next842, 5);
  check('T-842: the position the walk holds is not lost by the row that defined it — the next press after the broken row goes on to ap-0805',
    asked842[4] === 'ap-0805', asked842txt());
  await press842(prev842, 6);
  check('T-842: and the reverse press comes back along the same list, over the row the lane refused',
    asked842[5] === 'ap-0804', asked842txt());

  const src842 = require('fs').readFileSync(TARGET, 'utf8');
  const cnt842 = function (re842) { return (src842.match(re842) || []).length; };
  check('T-842 source: the position is read once, from one function, and the search-that-answered-0 is gone',
    cnt842(/function walkPosition299\(rows, step\)/g) === 1
    && cnt842(/var at = walkPosition299\(rows, step\);/g) === 1
    && cnt842(/if \(rows\[i\]\.id === walkRef299\.current\) \{ at = i; break; \}/g) === 0,
    { position_helper: cnt842(/function walkPosition299\(rows, step\)/g), call: cnt842(/var at = walkPosition299\(rows, step\);/g), old_lookup: cnt842(/if \(rows\[i\]\.id === walkRef299\.current\) \{ at = i; break; \}/g) });
  check('T-842 source: a walk with no position yet still starts at the top — the named fallback, not a failed search — and both walks refuse a row the lane has already refused',
    cnt842(/if \(!id\) return 0;/g) === 1 && cnt842(/if \(!held\) return 0;/g) === 1
    && cnt842(/if \(deadRef299\.current\[j\.id\]\) return false;/g) === 2,
    { no_position: cnt842(/if \(!id\) return 0;/g), no_anchor: cnt842(/if \(!held\) return 0;/g), dead_row_gate: cnt842(/if \(deadRef299\.current\[j\.id\]\) return false;/g) });

  if (global.localStorage) { try { delete global.localStorage; } catch (e) { global.localStorage = undefined; } }
}

(async function main() {
  await scenario('happy path: running x2 then ok', 'ok', 2);
  await scenario('failure path: error after one poll', 'error', 1);
  await multiJob();
  await nowPlayingHeader();
  await chunkOrder();
  await chunkOrderAgentPlay();
  await walkNextDuringReadAloud();
  await chunkOrderAfterFailedChunk();
  await fastForwardToggle();
  await walkOrderTiedStamps();
  await walkAcrossRefusedRow();
  titleRules();
  marqueeRules();
  console.log('\n=== ' + pass + ' pass, ' + fail + ' fail ===');
  process.exitCode = fail ? 1 : 0;
})();
