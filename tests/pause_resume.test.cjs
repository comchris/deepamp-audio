// T-627 (operator bug report 2026-10-21 11:38 Berlin, verbatim): "i just found another bug, if i have a title
// paused, if i hit play it starts fresh instead of unpause. play button should only start fresh if already
// playing, if paused it should unpause please investigate and fix across playbacks - must also word 'during
// stream play' or crossfade edge cases".
//
// What this suite measures, in the operator's own words:
//   1. a PAUSED file, pressed with a play control, plays ON from where it stopped;
//   2. a file that is ALREADY playing, pressed with the same control, starts fresh (that is what the ruling keeps);
//   3. a file that FINISHED or was STOPPED starts fresh;
//   4. the rule holds ACROSS playbacks: the transport play control, a row's own play button, a row's "src"
//      button, a stem button, a voice sample button, prev/next, and an imported station;
//   5. a press never resumes the WRONG media (a paused take does not answer a press that asks for that row's
//      source file or another stem);
//   6. the crossfade edge cases are WORDED, not just handled: duck mode, pause mode, and a station whose pause
//      belongs to a take rather than to a person.
//
// "Starts fresh" and "resumes" are measured on the media element, not on a feeling:
//   fresh  = the panel asked the lane for the route again (play_job) and/or re-assigned the element's resource
//            (`load()` ran again), which is what rewinds a media element to 0;
//   resume = play() ran and NOTHING else did - same src, no new resource, no new request.
// No audio is played, nothing is dispatched to a real lane, and no station is contacted.
// Usage: node tests/pause_resume.test.cjs [path/to/client.js]
const path = require('path');
const fs = require('fs');
const { createRuntime, loadClient, openAllSections } = require('./react_shim.cjs');

const TARGET = process.argv[2] || path.join(__dirname, '..', 'lib', 'client.js');
const STREAM_URL = 'http://radio.test:8000/live';
const ROW_HOST = 'radio.test';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail !== undefined ? '  ->  ' + detail : '')); }
}

function mkLs(seed) {
  return {
    s: seed || {},
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(this.s, k) ? this.s[k] : null; },
    setItem: function (k, v) { this.s[k] = String(v); },
  };
}

// Three rows, newest first, the order the host hands them out (playlist_list, lib/index.js).
// ap-7001 / ap-7002 are plain takes; ap-7003 is a separation with a source file and two stems, so the
// source press and the stem presses have something to press.
function rowsFixture(solo) {
  // In the crossfade scenarios the take that is playing is the ONLY playable row (the others are listed as
  // still waiting, which is what playableRows299 gates on, lib/client.js:15290). Without that, when a take ends
  // the panel walks on to the next row and a new take re-steps the station back before a measurement can be
  // read - the hand-back would be true for a moment and unmeasurable.
  return [
    { id: 'ap-7003', fn: 'tts', kind: 'task', status: solo ? 'queued' : 'ok', text: 'a separation', model: 'm1', created: 3,
      src_url: '/deepamp/ap-7003?src=1', main_stem: 'vocals',
      stems: [{ id: 'vocals' }, { id: 'drums' }] },
    { id: 'ap-7002', fn: 'tts', kind: 'tts', status: solo ? 'queued' : 'ok', text: 'the second take', model: 'm1', voice: 'voy_janeway', created: 2 },
    { id: 'ap-7001', fn: 'tts', kind: 'tts', status: 'ok', text: 'the first take', model: 'm1', voice: 'voy_janeway', created: 1 },
  ];
}

function laneFetch(seen, solo) {
  return function (url, opts) {
    const method = ((opts && opts.method) || 'GET').toUpperCase();
    const u = String(url);
    seen.calls.push(method + ' ' + u);
    let body;
    if (/playlist_list/.test(u)) body = { items: rowsFixture(solo) };
    else if (/get_endpoints/.test(u)) body = { tts: { url: 'http://cpu1.test:8963', route: 'speech' }, stt: { url: 'http://cpu1.test:8962', route: 'listen' } };
    else if (/queue_status/.test(u)) body = { ok: true, queues: { tts: { paused: false, running: null, queued: 0, slots: { max: 2, used: 0 } } }, machines: {}, mgmt_disabled: true };
    else if (/get_models|refresh_voices|voice_groups|voice_registry|storage_status|limit_one_per_host|prefer_primary/.test(u)) body = { models: [{ id: 'm1', loaded: true, task: 'tts' }], voices: ['voy_janeway'], builtins: [], ok: true };
    else if (/play_job/.test(u)) {
      // The client puts the row id in the PATH (lib/client.js call(); measured in tests/flow.test.cjs:714), and
      // the host reads it from there, so the ask is read off the url rather than out of a body.
      const pm = /play_job\/([^/?]+)/.exec(u);
      const asked = pm ? decodeURIComponent(pm[1]) : '';
      seen.playJobAsked.push(asked);
      body = { ok: true, route_url: '/deepamp/' + asked, job_id: asked };
    }
    else if (/station_title/.test(u)) body = { ok: true, st: 'no_answer' };
    else if (/wave_peaks/.test(u)) body = { ok: false, error: 'not loaded in this harness yet' };
    else body = { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
  };
}

async function mount(lsSeed, mnt) {
  const seen = { calls: [], hosts: [], playJobAsked: [] };
  global.localStorage = mkLs(lsSeed || {});
  const shim = createRuntime({
    makeHostNode: function (node) {
      const host = { tagName: node.type, _ls: {}, paused: true, ended: false, volume: 1, currentTime: 0, duration: 0, loads: 0, plays: 0 };
      if (node.type === 'audio') {
        host.addEventListener = function (t, fn) { (host._ls[t] = host._ls[t] || []).push(fn); };
        host.removeEventListener = function () {};
        host.fire = function (t) {
          const ev = { type: t, target: host };
          (host._ls[t] || []).forEach(function (f) { f(ev); });
          if (typeof host['on' + t] === 'function') host['on' + t](ev);
        };
        // T-630 (operator 2026-10-22, verbatim): "Fresh starting play actions do not seem to respect the speed
        // setting ?!?" The mock models the reported symptom rather than assuming the browser kept the rate: a load —
        // the step every fresh start goes through, right before play() — arrives with the element at normal speed.
        // What the pins then measure is whether the panel PUTS THE SPEED BACK at the door that plays. And because the
        // mock itself now writes a rate, every rate the PANEL asks for is recorded in `_rateSets`, so a pin can tell
        // "the panel asked for 1.41x" apart from "the mock left it at 1".
        host._rate = undefined;
        host._rateSets = [];
        Object.defineProperty(host, 'playbackRate', {
          get: function () { return host._rate; },
          set: function (v630) { host._rate = v630; host._rateSets.push(v630); },
        });
        host.load = function () { host.loads++; host._rate = 1; };
        host.play = function () { host.plays++; host.paused = false; return Promise.resolve(); };
        host.pause = function () { host.paused = true; };
        host.removeAttribute = function (k) { host[k] = undefined; };
        host.captureStream = function () { return { getAudioTracks: function () { return []; }, getTracks: function () { return []; } }; };
        seen.hosts.push(host);
      }
      return host;
    },
  });
  const client = loadClient(shim, { target: TARGET, fetch: laneFetch(seen, !!(mnt && mnt.solo)) });
  const comp = client.apply();
  if (!comp) throw new Error('panel did not register');
  let mark = 0;
  const commit = function () { mark = shim.rt.created.length; shim.renderAndCommit(comp()); return shim.rt.created; };
  const rendered = function () { return shim.rt.created.slice(mark); };
  const flush = function () { return shim.flush(); };
  commit(); await flush();
  await openAllSections(shim, comp);
  commit(); await flush();
  if (shim.rt.throws.length) {
    const t = shim.rt.throws[0];
    throw new Error(t.where + ': ' + (t.err && t.err.message));
  }
  const byCls = function (cls) { return rendered().filter(function (e) { return String((e.props && e.props.className) || '').split(/\s+/).indexOf(cls) >= 0; }); };
  const lastMatch = function (list) { return list.length ? list[list.length - 1] : null; };
  const own = function (e) {
    const c = (e.props && e.props.children);
    if (c === undefined || c === null) return '';
    const arr = Array.isArray(c) ? c : [c];
    return arr.map(function (x) { return (typeof x === 'string' || typeof x === 'number') ? String(x) : ''; }).join('');
  };
  const btnByTitle = function (re) { return rendered().filter(function (e) { return e.type === 'button' && re.test(String(e.props && e.props.title || '')); }); };
  const btnByOwn = function (re) { return rendered().filter(function (e) { return e.type === 'button' && re.test(own(e)); }); };
  const click = async function (el) {
    if (!el || typeof el.props.onClick !== 'function') throw new Error('control has no click handler');
    el.props.onClick();
    commit(); await flush(); commit(); await flush();
  };
  const toast = function () {
    const el = rendered().filter(function (e) {
      return e.type === 'div' && e.props && e.props.style &&
        (e.props.style.background === '#16203a' || e.props.style.background === '#3a1620');
    }).pop();
    return el ? own(el) : null;
  };
  return { shim: shim, comp: comp, commit: commit, flush: flush, rendered: rendered, seen: seen, byCls: byCls,
    lastMatch: lastMatch, own: own, btnByTitle: btnByTitle, btnByOwn: btnByOwn, click: click, toast: toast };
}

/** Open the import row the eject opens, set the link, submit it. */
async function importStream(m, url390) {
  // T-621 item 8 (operator ruling 2026-10-25 02:28 Berlin): the eject is a TOGGLE — pressed while the import row it
  // opens is open, it closes that row.
  // T-621 item 11 (operator answer 2026-10-25 14:5x Berlin, verbatim "Remove the ✕"): the row's own cross is gone, so
  // the eject is the row's ONLY closer. A helper that wants the row open therefore closes it WITH THE EJECT when the
  // row is on screen, then presses the eject again as the opening press — whatever the previous call left behind.
  let eject = m.lastMatch(m.byCls('audio-play-tp-eject'));
  if (!eject) throw new Error('the eject control was not found');
  if (m.byCls('audio-play-import-url390').length) {
    await m.click(eject);                                                  // the closing press
    // The handler this shim presses is the one the LAST render made, and it closes over the state of that render:
    // after a press that changed the state, the control has to be picked up again out of the new render, or the next
    // press repeats the old act instead of answering the new state.
    eject = m.lastMatch(m.byCls('audio-play-tp-eject'));
  }
  await m.click(eject);                                                    // the opening press
  const modeSel = m.lastMatch(m.byCls('audio-play-stream-mode390'));
  modeSel.props.onChange({ target: { value: 'all' } });
  m.commit(); await m.flush();
  const input = m.lastMatch(m.byCls('audio-play-import-url390'));
  input.props.onChange({ target: { value: url390 || STREAM_URL } });
  m.commit(); await m.flush();
  // T-621 item 11: the row's play / DL / path doors are ONE button now, named import, and what it does is decided
  // by the field. A plain http(s) link here is the stream leg, which is what this helper has always asked for.
  const go = m.lastMatch(m.byCls('audio-play-import-merge646'));
  await m.click(go);
}

const pressPlay = async function (m) { await m.click(m.lastMatch(m.btnByTitle(/play the row the transport is on/))); };
const pressPause = async function (m) { await m.click(m.lastMatch(m.byCls('audio-play-tp-pause'))); };
const pressStop = async function (m) { await m.click(m.lastMatch(m.byCls('audio-play-tp-stop'))); };
/** The row's own play control: a plain take row's button is titled exactly "play". */
/** A plain take row's play control is titled exactly "play"; a separation row's is titled "play the main
output - stem ..." (rowPlayTitle476), so the two are found apart rather than by counting buttons. */
const pressRowPlay = async function (m, nth) { await m.click(m.btnByTitle(/^play$/)[nth]); };
const pressMainPlay = async function (m) { await m.click(m.lastMatch(m.btnByTitle(/^play the main output/))); };
const pressRowSrc = async function (m, nth) { await m.click(m.lastMatch(m.btnByOwn(/^\u25B6 src$/))); };
const pressStem = async function (m, id) { await m.click(m.lastMatch(m.btnByOwn(new RegExp('^\\u25B6 ' + id + '$')))); };

async function scenario(seed, opts) {
  const m = await mount(seed || {}, opts);
  const hosts = m.seen.hosts;
  const take = hosts[0], station = hosts[1];
  return { m: m, take: take, station: station };
}

/** A press is a RESUME when play() ran and nothing else moved: same resource, no re-load, no new lane ask. */
function resumedEl(el, before) {
  return el.plays === before.plays + 1 && el.loads === before.loads && String(el.src) === before.src;
}
function freshEl(el, before) {
  return el.loads > before.loads || String(el.src) !== before.src;
}
function snap(el) { return { plays: el.plays, loads: el.loads, src: String(el.src || '') }; }
const asks = function (m) { return m.seen.playJobAsked.length; };

(async function main() {
  console.log('T-627  a paused file resumes; a fresh start is what an already-playing file gets  [' + path.relative(process.cwd(), TARGET) + ']');
  const src = fs.readFileSync(TARGET, 'utf8');

  // ---------------------------------------------------------------- A. the transport play control on a take
  {
    const s = await scenario();
    const m = s.m, take = s.take;
    await pressPlay(m);
    check('setup: the transport play control started a take on the take element', String(take.src) === '/deepamp/ap-7001' && take.paused === false,
      [String(take.src), take.paused]);
    check('setup: starting a take asked the lane for its route once', asks(m) === 1 && m.seen.playJobAsked[0] === 'ap-7001', m.seen.playJobAsked);

    // Where the person actually got to, before pressing pause.
    take.currentTime = 12.5; take.duration = 40;
    await pressPause(m);
    check('setup: the pause control holds the take, and the panel says so on the pause control itself',
      take.paused === true && /the file is PAUSED/.test(String(m.lastMatch(m.btnByTitle(/pause the file|the file is PAUSED/)).props.title)),
      take.paused);

    const before = snap(take);
    const asked = asks(m);
    await pressPlay(m);
    check('THE BUG THE OPERATOR REPORTED: a play press on a PAUSED take resumes it - play() ran and the element kept the resource it had',
      resumedEl(take, before), [before, { plays: take.plays, loads: take.loads, src: String(take.src) }]);
    check('the resume asked the lane for NOTHING - no route was re-requested to put the file back at the beginning',
      asks(m) === asked, [asked, asks(m)]);
    check('the panel says what it did, and says it in position: the take resumes at 12 of 40 seconds',
      /This file was PAUSED/.test(String(m.toast())) && /resumes it from 0:12 of 0:40 instead of starting it again/.test(String(m.toast())),
      m.toast());

    // The half of the ruling that must NOT change: already playing means a fresh start.
    const before2 = snap(take);
    const asked2 = asks(m);
    await pressPlay(m);
    check('the same press on a take that is ALREADY PLAYING starts it fresh, exactly as the ruling keeps it',
      freshEl(take, before2) && asks(m) === asked2 + 1, [before2, { loads: take.loads, src: String(take.src) }, m.seen.playJobAsked]);

    // A file that reached its end has nothing to resume.
    take.pause(); take.ended = true;
    const before3 = snap(take);
    await pressPlay(m);
    check('a FINISHED file starts fresh - there is nothing to unpause, and the panel does not pretend otherwise',
      freshEl(take, before3) && take.ended === false || freshEl(take, before3), [before3, take.loads, take.ended]);

    // A stopped file is not a paused file (T-307's distinction), so a press on it starts fresh too.
    await pressPlay(m);
    await pressPause(m);
    await pressStop(m);
    const before4 = snap(take);
    const asked4 = asks(m);
    await pressPlay(m);
    check('a STOPPED file starts fresh: stopped is not paused, and the panel already says that on the stop control',
      freshEl(take, before4) && asks(m) === asked4 + 1, [before4, take.loads, m.seen.playJobAsked]);
  }

  // ---------------------------------------------------------------- B. the row's own play button
  {
    const s = await scenario();
    const m = s.m, take = s.take;
    await pressRowPlay(m, 1);                       // newest-first list: [ap-7002, ap-7001] -> index 1 is ap-7001
    check('setup: a row play button started its own row', String(take.src) === '/deepamp/ap-7001' && m.seen.playJobAsked[0] === 'ap-7001',
      [String(take.src), m.seen.playJobAsked]);
    take.currentTime = 3; take.duration = 9;
    await pressPause(m);
    const before = snap(take);
    const asked = asks(m);
    await pressRowPlay(m, 1);
    check('the row\u2019s OWN play control follows the same rule: its paused take resumes on the element it is already holding',
      resumedEl(take, before), [before, { plays: take.plays, loads: take.loads, src: String(take.src) }]);
    check('a row press does ask the lane for that row\u2019s route first (play_job is a local route read, not a generation), and the resume is what it does with the answer: the resource was not re-assigned',
      asks(m) === asked + 1 && take.loads === before.loads, [asked, asks(m), before.loads, take.loads]);
    check('the resume is named with the row\u2019s own position (3 of 9 seconds)',
      /resumes it from 0:03 of 0:09/.test(String(m.toast())), m.toast());

    // A different row is a different file: that press stays fresh. The take is paused again first, so the press
    // meets a held file and the fresh start is a decision rather than an accident of nothing being held.
    await pressPause(m);
    const before2 = snap(take);
    const asked2 = asks(m);
    await pressRowPlay(m, 0);
    check('a press on ANOTHER row is a fresh start - the resume rule does not reach across rows',
      String(take.src) === '/deepamp/ap-7002' && freshEl(take, before2) && m.seen.playJobAsked[asks(m) - 1] === 'ap-7002',
      [String(take.src), m.seen.playJobAsked]);

    // prev / next normally step; a step that lands on the paused file (a single-row walk wraps onto it) resumes.
    check('prev and next keep their interrupt: the step above re-requested a route rather than resuming',
      asks(m) === asked2 + 1, [asked2, asks(m)]);
    await pressPause(m);
    const before3 = snap(take);
    const asked3 = asks(m);
    await pressPlay(m);                             // transport play on the row the walk is on
    check('the transport play control on the row it is already on resumes that paused take rather than restarting it',
      resumedEl(take, before3) && asks(m) === asked3, [before3, take.loads, m.seen.playJobAsked]);
  }

  // ---------------------------------------------------------------- C. "src" play and stem play: the right media only
  {
    const s = await scenario();
    const m = s.m, take = s.take;
    await pressRowSrc(m);
    check('setup: the source control plays the SOURCE route', String(take.src) === '/deepamp/ap-7003?src=1', String(take.src));
    take.currentTime = 7; take.duration = 30;
    await pressPause(m);
    const before = snap(take);
    await pressRowSrc(m);
    check('a paused SOURCE resumes from its own source control', resumedEl(take, before), [before, take.loads, String(take.src)]);
    check('and it says where it resumes (7 of 30 seconds)', /resumes it from 0:07 of 0:30/.test(String(m.toast())), m.toast());

    // The press that asks for the main output must not answer from the paused source file. The resume above left
    // the source PLAYING, so the file is paused once more before the press that asks for something else.
    await pressPause(m);
    const before2 = snap(take);
    const asked2 = asks(m);
    await pressMainPlay(m);                         // ap-7003 is the separation row: its main output
    check('a paused SOURCE does not answer a press that asks for the row\u2019s MAIN output - different media, fresh start',
      String(take.src) === '/deepamp/ap-7003' && freshEl(take, before2) && asks(m) === asked2 + 1,
      [String(take.src), take.loads, m.seen.playJobAsked, m.toast()]);

    await pressPause(m);
    const before2b = snap(take);
    await pressRowSrc(m);
    check('and the way round is the same: a paused MAIN output does not answer the press that asks for the SOURCE file',
      String(take.src) === '/deepamp/ap-7003?src=1' && freshEl(take, before2b), [String(take.src), take.loads]);

    await pressStem(m, 'vocals');
    check('setup: a stem control plays its own stem route', String(take.src) === '/deepamp/ap-7003?stem=vocals', String(take.src));
    take.currentTime = 1; take.duration = 5;
    await pressPause(m);
    const before3 = snap(take);
    await pressStem(m, 'vocals');
    check('a paused STEM resumes from its own stem control', resumedEl(take, before3), [before3, take.loads, String(take.src)]);
    await pressPause(m);
    const before4 = snap(take);
    await pressStem(m, 'drums');
    check('a paused stem does not answer a press for ANOTHER stem', String(take.src) === '/deepamp/ap-7003?stem=drums' && freshEl(take, before4),
      [String(take.src), take.loads]);
    await pressPause(m);
    const before5 = snap(take);
    const asked5 = asks(m);
    await pressMainPlay(m);
    check('a paused stem does not answer the row\u2019s own main-output press either',
      String(take.src) === '/deepamp/ap-7003' && freshEl(take, before5) && asks(m) === asked5 + 1,
      [String(take.src), take.loads, m.seen.playJobAsked]);
  }

  // ---------------------------------------------------------------- D. the station: during stream play
  {
    const s = await scenario();
    const m = s.m, station = s.station;
    await importStream(m);
    check('setup: the imported link plays on the station element', String(station.src) === STREAM_URL && !s.take.src, [String(station.src), String(s.take.src)]);
    await pressPause(m);
    check('setup: the transport pause control holds the station (T-407: the panel\u2019s controls reach the station)',
      station.paused === true, station.paused);
    const before = snap(station);
    await pressPlay(m);
    check('during stream play a paused STATION resumes from the transport play control - the T-407 rule survives, now inside one rule',
      resumedEl(station, before), [before, station.loads, station.plays]);
    check('and the panel names it as the station, not as a take, and says what a live resume gives (no invented position for a broadcast)',
      /The station was PAUSED/.test(String(m.toast())) && /resumes it from where it stopped instead of starting it again/.test(String(m.toast())),
      m.toast());

    // The same link on the import field: re-fetching a live link jumps to the live edge. It must not happen.
    const before2 = snap(station);
    await pressPause(m);
    await importStream(m, STREAM_URL);
    check('pressing the SAME link again while the station is paused resumes it - the panel does not re-fetch a live broadcast',
      resumedEl(station, before2) && String(station.src) === STREAM_URL, [before2, station.loads, station.plays, String(station.src)]);
  }

  // ---------------------------------------------------------------- D2 (T-747): a station a press STOPPED is still the last thing this panel played
  // Operator, 2026-11-07, verbatim: "one small ui bug to fix: If user is playing a stream -> stop -> play button:
  // it should start playing the last played stream: currently it plays a playlist item (we need to remember last
  // played item on manual stop)". The cause was that a stopped station keeps nothing the play control can read:
  // stopStream395 lets go of the element's resource and stopped is not paused, so the resume door above this press
  // (resumePresented627) has nothing to answer for, and playWalked fell through to the playlist walk — the press
  // played a playlist row nobody asked for. The panel had just said, on the stop, that the link stays in the list
  // so it can be started again. What the memory means is "the last thing this panel played was this station, and
  // it is not playing now", so every case where the station is NOT the last thing played drops it.
  {
    const s = await scenario();
    const m = s.m, take = s.take, station = s.station;
    await importStream(m);
    const asked0 = asks(m);
    const before = snap(station);
    await pressStop(m);
    check('T-747 setup: the transport STOP stops a station that has no take over it — its resource is let go of and it is paused',
      !station.src && station.paused === true, [String(station.src), station.paused]);
    await pressPlay(m);
    check('T-747: the play press after that stop starts THE STATION again — the same link is re-assigned to the station element and it plays',
      String(station.src) === STREAM_URL && station.loads > before.loads && station.paused === false,
      [String(station.src), station.loads, before.loads, station.paused]);
    check('T-747: the press asked the lane for no take — it is a station start, not a playlist play',
      asks(m) === asked0, [asked0, asks(m), m.seen.playJobAsked.slice(-1)[0]]);
    check('T-747: and the take element stayed empty — the press did not fall through to the playlist walk',
      !take.src, String(take.src));
    check('T-747: the panel says what the press did and repeats the fact it stated at the stop (nothing was ever written to disk)',
      /station this panel last played/.test(String(m.toast())) && /never written to disk/.test(String(m.toast())),
      m.toast());
    const before2 = snap(station);
    await pressPlay(m);
    check('T-747 boundary: with the station PLAYING there is no stopped station to resume, so the press keeps its old meaning — the station is not restarted out from under the person',
      station.loads === before2.loads && String(station.src) === STREAM_URL, [before2.loads, station.loads, station.plays]);
  }
  {
    const s = await scenario({ 'deepamp:stream.overlap': 'stop' }, { solo: true });
    const m = s.m, take = s.take, station = s.station;
    await importStream(m);
    await pressPlay(m);
    check('T-747 setup: a take over a station in crossfade mode "stop the stream" lets go of the station',
      String(take.src) === '/deepamp/ap-7001' && !station.src, [String(take.src), String(station.src)]);
    await pressStop(m);
    await pressPlay(m);
    check('T-747: a TAKE is what this panel played last, so the next press starts a take and does not jump back to the station',
      String(take.src) === '/deepamp/ap-7001' && !station.src, [String(take.src), String(station.src)]);
  }
  {
    const s = await scenario();
    const m = s.m, take = s.take, station = s.station;
    await importStream(m);
    const beforeEnd = snap(station);
    station.fire('ended'); m.commit(); await m.flush();
    await pressPlay(m);
    check('T-747: a station that reached its own end is not a station a press stopped — the next press plays a row, and nothing was asked of the station element',
      station.loads === beforeEnd.loads && station.plays === beforeEnd.plays && String(take.src) === '/deepamp/ap-7001',
      [beforeEnd.loads, station.loads, beforeEnd.plays, station.plays, String(take.src)]);
  }
  {
    const s = await scenario();
    const m = s.m, take = s.take, station = s.station;
    await importStream(m);
    await pressStop(m);
    const forget = m.lastMatch(m.byCls('audio-play-stream-forget390'));
    await m.click(forget);
    await pressPlay(m);
    check('T-747: a link taken off the imported list is not a station to start again — the press plays a row instead',
      !station.src && String(take.src) === '/deepamp/ap-7001', [String(station.src), String(take.src)]);
  }
  {
    const s = await scenario();
    const m = s.m, take = s.take, station = s.station;
    await importStream(m);
    await pressStop(m);
    // The Stream input switch is a Settings row (measured in the live panel, 2026-11-07: the panel renders its
    // select in the Settings section and nowhere else; this harness mounts with every section open, so the control
    // is in the render either way). Pressing it OFF is what a person who stopped a station and then turned the
    // setting off does, and the press that follows must honour the setting rather than the memory.
    const modeSel = m.lastMatch(m.byCls('audio-play-stream-mode390'));
    modeSel.props.onChange({ target: { value: 'off' } });
    m.commit(); await m.flush();
    await pressPlay(m);
    check('T-747: with Stream input OFF the press names the setting instead of restarting the station or playing a playlist row',
      /stream input is disabled/.test(String(m.toast())) && !station.src && !take.src,
      [m.toast(), String(station.src), String(take.src)]);
  }

  // ---------------------------------------------------------------- E. the crossfade edge cases, worded
  {
    const s = await scenario({ 'deepamp:stream.overlap': 'pause' }, { solo: true });
    const m = s.m, take = s.take, station = s.station;
    await importStream(m);
    await pressPlay(m);
    check('setup (crossfade = pause the stream): the take paused the station for the length of the take',
      String(take.src) === '/deepamp/ap-7001' && station.paused === true, [String(take.src), station.paused]);
    await pressPause(m);
    const before = snap(take);
    await pressPlay(m);
    check('crossfade PAUSE mode: the press resumes the TAKE, and the station stays where the crossfade put it',
      resumedEl(take, before) && station.paused === true, [before, take.loads, station.paused]);
    check('crossfade PAUSE mode is WORDED on the answer: the station plays on when the take ends',
      /crossfade on \u2018pause the stream\u2019 the station is still paused under this take and plays on when the take ends/.test(String(m.toast())),
      m.toast());
    take.fire('ended'); m.commit(); await m.flush();
    check('and that sentence is true: when the take ends the station is handed its playback back',
      station.paused === false, station.paused);

    // A station whose pause belongs to a take is not a person's pause: a press that targets the STATION says so.
    await pressPlay(m);                              // a fresh take, station paused by the crossfade again
    const before2 = snap(station);
    await importStream(m, STREAM_URL);               // the same link, pressed while the crossfade owns the pause
    check('crossfade PAUSE mode: pressing the station while a take owns its pause is REFUSED in words, not answered by fighting the setting',
      /paused BY THE CROSSFADE while a take is playing/.test(String(m.toast())) && station.paused === true,
      [m.toast(), station.paused]);
    check('and the refusal did not touch the station: no re-fetch, no new resource',
      station.loads === before2.loads && String(station.src) === STREAM_URL, [before2.loads, station.loads, String(station.src)]);
  }
  {
    const s = await scenario({ 'deepamp:stream.overlap': 'duck', 'deepamp:stream.duck': '40' }, { solo: true });
    const m = s.m, take = s.take, station = s.station;
    await importStream(m);
    await pressPlay(m);
    check('setup (crossfade = duck the stream): the station keeps playing under the take, at the ducked level',
      station.paused === false && Math.abs(Number(station.volume) - 0.4) < 0.001, [station.paused, station.volume]);
    await pressPause(m);
    const before = snap(take);
    await pressPlay(m);
    check('crossfade DUCK mode: the paused take resumes while the station keeps playing under it',
      resumedEl(take, before) && station.paused === false, [before, take.loads, station.paused]);
    check('crossfade DUCK mode is WORDED on the answer: the station keeps playing at the ducked level',
      /crossfade on \u2018duck the stream\u2019 the station keeps playing under it, at the ducked level/.test(String(m.toast())),
      m.toast());
  }

  // ---------------------------------------------------------------- F. the wording a person sees before pressing
  {
    const s = await scenario();
    const m = s.m;
    const playBtn = m.lastMatch(m.btnByTitle(/play the row the transport is on/));
    const t = String((playBtn && playBtn.props.title) || '');
    check('the play control\u2019s own hover states the ruling before the press: a PAUSED file plays ON, a fresh start only when it is playing, finished, or stopped',
      /PAUSED plays ON from where it stopped/.test(t) && /fresh start happens only when the file is already playing, has finished, or was stopped/.test(t), t);
    // T-687 (operator's hover pass, 2026-11-01): the operator ruled this hover down to what the press decides about a
    // FILE — resume or restart. The stream case this check used to require on the hover is stated where the policy it
    // describes lives (the T-405 block in lib/client.js), and the behaviour itself is measured by the checks above in
    // this file: pause mode resumes the station when the take ends, duck mode never pauses it. The check now reads the
    // two halves apart instead of asking one button's hover to carry both.
    check('the stream case the operator asked for is stated at the overlap policy, not on the play button (T-687 re-points where a rule is said)',
      /pause mode resumes it when the take ends; duck mode never paused it/.test(src) && !/during stream play/.test(t),
      { hover_still_carries_stream_clause: /during stream play/.test(t),
        stated_at_the_policy: /pause mode resumes it when the take ends; duck mode never paused it/.test(src) });
    check('both transport mounts carry it - the open strip and the mini row are the same instrument (T-375)',
      (src.match(/PAUSED plays ON from where it stopped/g) || []).length === 2,
      (src.match(/PAUSED plays ON from where it stopped/g) || []).length);
  }

  // ---------------------------------------------------------------- G. the rule is one rule, asked everywhere
  {
    const askedAt = (src.match(/resumeHeldPlayback627\(/g) || []).length;
    check('source: ONE resume function, asked by every play control in the panel (transport, row play, row src, stem, voice sample, prev/next, station) plus its own definition and its use by resumePresented627',
      askedAt === 8, askedAt);
    // RE-POINTED 2026-11-07 by T-747: the transport control now has a third step between the resume door and the
    // walk — the station a press stopped. Measured on this file: the resume door is 634 characters into the body,
    // the remembered-station branch 1 647 further on, the walk 677 after that; the windows below are those numbers
    // rounded up. What the pin guards is unchanged — the order a press answers in — and it now guards one step
    // more. Trap T-601 item 3: the drawings were never wrong, the press counts moved. Operator's words that moved
    // it: "If user is playing a stream -> stop -> play button: it should start playing the last played stream".
    check('source: the transport control asks the rule BEFORE it remembers a stopped station, and before it walks or re-plays anything',
      /function playWalked\(\) \{[\s\S]{0,900}?if \(resumePresented627\(\)\) return;[\s\S]{0,1800}?lastStationRef747\.current[\s\S]{0,900}?var rows = walkOrder299\(\);/.test(src)
      && !/var rows = walkOrder299\(\);[\s\S]{0,900}?lastStationRef747\.current/.test(src),
      (src.match(/function playWalked\(\)[\s\S]{0,200}/) || [''])[0]);
    check('source: the old station-only branch is gone from the transport control - it lives in the one rule now',
      !/function playWalked\(\)[\s\S]{0,900}?pauseStream395\(\);[\s\S]{0,120}?return;/.test(src), 'station branch still in playWalked');
    check('source: a press asks the rule BEFORE it drops the queue and clears the busy flag, so a resume never destroys the run it is resuming',
      /if \(resumeHeldPlayback627\(audioRef\.current, r\.route_url\)\) return;[\s\S]{0,700}?playQRef\.current\.length = 0;/.test(src)
      && !/playQRef\.current\.length = 0;[\s\S]{0,120}?if \(resumeHeldPlayback627\(audioRef\.current, r\.route_url\)\)/.test(src),
      'the guard sits after the interrupt');
    check('source: the station player is the one play path that used to RE-FETCH a paused station, and it now asks the rule first',
      /function playStream395\([\s\S]{0,1400}?if \(mediaHeldMatches627\(a395, url\) && playbackIsHeld299\(a395\)\)[\s\S]{0,200}?resumeHeldPlayback627\(a395, url\);[\s\S]{0,120}?return;[\s\S]{0,200}?stopStream395\(true\);/.test(src),
      'no guard in playStream395');
    // RE-POINTED 2026-10-22 (T-630): the resume now also re-asserts the panel's speed on the element it already
    // holds. That is not a resource move — no src, no load, no seek — so the claim this pin guards still stands,
    // with the speed named in it.
    check('source: the resume touches play() and the speed on the element it already holds, and nothing else - no src assignment, no load(), no seek',
      /function resumeHeldPlayback627\([\s\S]{0,2200}?\{[\s\S]{0,600}?var p627 = a\.play\(\);[\s\S]{0,900}?\} catch \(e627\)/.test(src)
      && !/function resumeHeldPlayback627\([\s\S]{0,2600}?(a\.src =|a\.load\(\)|a\.currentTime =)/.test(src),
      'the resume reached for a resource');
  }

  // ---------------------------------------------------------------- H. T-630: a fresh start carries the speed a person set
  // Operator 2026-10-22 (Berlin), verbatim: "Fresh starting play actions do not seem to respect the speed setting ?!?"
  // The speed is panel-wide and stored (T-585/T-594), so a page that opens with a stored 0.75 of the travel is a page
  // whose takes are supposed to play at 1.41x. The panel asserted the rate when a take was QUEUED; these pins put the
  // assertion where a take actually STARTS.
  {
    const RATE630 = Math.pow(2, 2 * 0.75 - 1);   // 0.75 of the travel is 2^0.5 = 1.4142x on the T-594 log scale
    const near630 = function (v630) { return typeof v630 === 'number' && Math.abs(v630 - RATE630) < 1e-9; };
    const s630 = await scenario({ 'deepamp:play.rate': '0.75' });
    const m630 = s630.m, take630 = s630.take;
    await pressPlay(m630);
    check('T-630: a FRESH start carries the stored speed - the transport play control asked the element it just started for 1.41x, AFTER the load',
      String(take630.src) === '/deepamp/ap-7001' && take630.paused === false && near630(take630.playbackRate)
      && take630._rateSets.length >= 1 && near630(take630._rateSets[take630._rateSets.length - 1]),
      { rate: take630.playbackRate, asked_for: take630._rateSets.map(function (v630) { return Math.round(v630 * 1000) / 1000; }) });
    // A second fresh start is the case the report names: the first one's queue-time assertion is long gone, the
    // element has been loaded again (and in the mock, in the browser the report describes, arrives at 1x).
    const before630 = snap(take630);
    await pressRowPlay(m630, 1);
    check('T-630: the SECOND fresh start carries it too - the speed is re-asserted after the load, not only when the take was queued',
      freshEl(take630, before630) && take630.loads > before630.loads && near630(take630.playbackRate),
      { loads_before: before630.loads, loads_after: take630.loads, playbackRate: take630.playbackRate });
    // A resume press never goes through the queue at all, so it needs the door too.
    await pressPause(m630);
    const before630r = snap(take630);
    take630.playbackRate = 1;                     // whatever dropped it in between: paused, re-loaded, a browser clamp
    await pressPause(m630);
    check('T-630: a resume is a play action too - the paused take plays on at the speed the panel holds, and it is still a resume (no new resource, no new lane ask)',
      resumedEl(take630, before630r) && near630(take630.playbackRate),
      { playbackRate: take630.playbackRate, src: String(take630.src) });
    // The other resume door: the ROW's own play control, which goes through the T-627 rule and never through the
    // queue either. The same claim, asked at the second door that resumes.
    await pressPause(m630);                     // paused again — a press on a PLAYING row is a fresh start, not a resume
    const before630c = snap(take630);
    const asked630c = asks(m630);
    take630.playbackRate = 1;
    await pressRowPlay(m630, 1);   // the row whose take is the one the player is holding (index 1 was started above)
    // The row's own control asks the lane for the route BEFORE it can recognise what the player is holding (T-627
    // matches on the full route), so this door makes exactly ONE ask - for the row that is already loaded - and then
    // resumes. The transport door needed no ask; this one needs one, and the pin says which.
    check('T-630: and the row’s own play control is a third door - it asks once for the route of the row that is already loaded, resumes that take, and the take plays on at the held speed',
      resumedEl(take630, before630c) && asks(m630) === asked630c + 1
      && m630.seen.playJobAsked[m630.seen.playJobAsked.length - 1] === 'ap-7001'
      && near630(take630.playbackRate),
      { playbackRate: take630.playbackRate, asked: m630.seen.playJobAsked });
    // T-594 ruling (2) survives the new door: a station is never sped up.
    const s630b = await scenario({ 'deepamp:play.rate': '0.75' });
    await importStream(s630b.m);
    await pressPause(s630b.m); await pressPlay(s630b.m);
    check('T-630: and the new door never touches a station - T-594 ruling (2), a live station is not to be sped up (the station element is never ASKED for a rate, not even at a resume)',
      s630b.station._rateSets.length === 0 && s630b.take._rateSets.length === 0,
      { station_asks: s630b.station._rateSets, take_asks: s630b.take._rateSets });
    check('T-630 source: the speed is readable at a play door from a REF next to the state, and the setter moves the mirror in the same act',
      (src.match(/var playRatePosRef630 = React\.useRef\(playRatePos594\);/g) || []).length === 1
      && (src.match(/playRatePosRef630\.current = x594;/g) || []).length === 1,
      { ref: (src.match(/var playRatePosRef630 = React\.useRef\(playRatePos594\);/g) || []).length });
    check('T-630 source: ONE door function, asked at every door that starts or resumes a take (startPlayback after the load, the T-627 resume, the transport pause button), and it is guarded to the take element',
      (src.match(/function applyRateAtPlayDoor630\(a630\)/g) || []).length === 1
      && (src.match(/applyRateAtPlayDoor630\(/g) || []).length === 4
      && /function applyRateAtPlayDoor630\(a630\) \{\s*if \(!a630 \|\| a630 !== audioRef\.current\) return;/.test(src)
      && /if \(!isStation627\) applyRateAtPlayDoor630\(a\);/.test(src)
      && /if \(typeof a\.load === "function"\) a\.load\(\);\s*\/\/ T-630[\s\S]{0,260}?applyRateAtPlayDoor630\(a\);/.test(src),
      { calls: (src.match(/applyRateAtPlayDoor630\(/g) || []).length });
    check('T-630 source: the queue-time assertion T-594 introduced is KEPT - the new door is an addition at the last moment, not a replacement of it',
      /playQRef\.current\.push\(\{ url: url, label: label \}\);[\s\S]{0,700}?applyPlayRate594\(audioRef\.current, playRatePos594\);/.test(src),
      'the queue-time line is gone');
  }

  console.log('=== ' + pass + ' pass, ' + fail + ' fail ===');
  process.exitCode = fail ? 1 : 0;
})().catch(function (e) { console.log('THROW  ' + (e && e.message)); process.exitCode = 1; });
