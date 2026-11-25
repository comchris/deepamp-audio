// T-405 / T-407 (user 2026-10-15): what the panel does to a PLAYING web stream when a take has to play, and
// who is allowed to drive that stream.
// The user's words for the behaviour (T-405): "the best and default solution would be to reduce the stream's
// volume to an adjustable volume level and keep playing the stream while the playlist item plays at the same
// time -> risky but great usability, so user will get new agent messages, and music keeps playing in the
// background. the other setting should be to pause stream -> play new render -> resume stream".
// The user's words for the controls (T-407): "the new stream controls currently display in two lines - can you
// just integrate the play status in the 'imported stream' line ? Those already got the play control - add the
// pause function to the play button , (toggle) and add a stop button both left side" and "the title display and
// visualizer and timer should still display the stream data while no 'playlist job is playing'" and "CHANGE: the
// 'default play controls must still be able to 'control or stop' the stream and adjust the volume". The last of
// those REVERSES the earlier ruling that the transport stays with the take; the reversal is asserted here.
// No audio is played, nothing is dispatched to a real lane, and no station is contacted.
// Usage: node tests/stream_overlap.test.cjs [path/to/client.js]
const path = require('path');
const { createRuntime, loadClient, openAllSections } = require('./react_shim.cjs');

const TARGET = process.argv[2] || path.join(__dirname, '..', 'lib', 'client.js');
const STREAM_URL = 'http://radio.test:8000/live';
const STREAM_HOST = 'radio.test:8000';
const ROW_HOST = 'radio.test';   // what the panel prints on the link's own line
const ROUTE = '/deepamp/ap-7001';

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

function laneFetch(seen, laneOpts450) {
  return function (url, opts) {
    const method = ((opts && opts.method) || 'GET').toUpperCase();
    const u = String(url);
    seen.calls.push(method + ' ' + u);
    let body;
    if (/playlist_list/.test(u)) body = { items: [{ id: 'ap-7001', fn: 'tts', kind: 'tts', status: 'ok', text: 'a rendered take', model: 'm1', voice: 'voy_janeway', created: 1792000000000, duration: 4.5, filename: 'ap-7001_m1.wav' }] };
    else if (/get_endpoints/.test(u)) body = { tts: { url: 'http://cpu1.test:8963', route: 'speech' }, stt: { url: 'http://cpu1.test:8962', route: 'listen' } };
    else if (/queue_status/.test(u)) body = { ok: true, queues: { tts: { paused: false, running: null, queued: 0, slots: { max: 2, used: 0 } } }, machines: {}, mgmt_disabled: false, prefer_primary: true, quality_flags: {} };
    else if (/get_models|refresh_voices|voice_groups|voice_registry|storage_status|limit_one_per_host|prefer_primary/.test(u)) body = { models: [{ id: 'm1', loaded: true, task: 'tts' }], voices: ['voy_janeway'], builtins: [], ok: true };
    else if (/play_job/.test(u)) body = { ok: true, route_url: ROUTE, job_id: 'ap-7001' };
    else if (/station_title/.test(u)) {
      // T-450: the answer is keyed by the url the panel actually asked with, because the fact under test is
      // whether a title learned for ONE station can leak onto another one.
      const asked450 = decodeURIComponent((/url=([^&]*)/.exec(u) || [0, ''])[1]);
      const table450 = (laneOpts450 && laneOpts450.stationAnswers) || {};
      body = (asked450 in table450) ? table450[asked450] : { ok: true, st: 'no_answer' };
    }
    else if (/wave_peaks/.test(u)) body = { ok: false, error: 'not loaded in this harness yet' };
    else body = { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
  };
}

async function mount(lsSeed, mountOpts450) {
  const seen = { calls: [], hosts: [] };
  // T-913 (2026-11-23): a browser that has never chosen a visualizer now lands on the spectrum analyser, and a
  // live mode builds a tap and can print the no-WebAudio note — neither is what this suite measures. The word is
  // stated once, here, so every scenario keeps testing the two-stream rule it was written for; a scenario that
  // ever wants the visualizer passes its own value and that wins, since it is merged after the default.
  global.localStorage = mkLs(Object.assign({ 'deepamp:scope.mode': 'off' }, lsSeed || {}));
  const shim = createRuntime({
    makeHostNode: function (node) {
      const host = { tagName: node.type, _ls: {}, paused: true, ended: false, volume: 1 };
      if (node.type === 'audio') {
        host.addEventListener = function (t, fn) { (host._ls[t] = host._ls[t] || []).push(fn); };
        host.removeEventListener = function () {};
        // A real element delivers an event to BOTH its addEventListener listeners and its on<type> handler.
        // The client attaches its take-end through the property, so a fire() that only walks listeners leaves every
        // "the take ended" check in this suite unproven.
        host.fire = function (t) {
          var ev = { type: t, target: host };
          (host._ls[t] || []).forEach(function (f) { f(ev); });
          if (typeof host['on' + t] === 'function') host['on' + t](ev);
        };
        host.load = function () { host.loads = (host.loads || 0) + 1; };
        host.play = function () { host.plays = (host.plays || 0) + 1; host.paused = false; return Promise.resolve(); };
        host.pause = function () { host.paused = true; };
        host.removeAttribute = function (k) { host[k] = undefined; };
        host.captureStream = function () { return { getAudioTracks: function () { return []; }, getTracks: function () { return []; } }; };
        seen.hosts.push(host);
      }
      return host;
    },
  });
  const client = loadClient(shim, { target: TARGET, fetch: laneFetch(seen, mountOpts450) });
  const comp = client.apply();
  if (!comp) throw new Error('panel did not register');
  // The shim records every element it ever builds, across every mount and every commit. A count has to be
  // taken from the last render, which is what the panel on the screen actually is (the same mark shut.test.cjs uses).
  let mark395 = 0;
  const commit = function () { mark395 = shim.rt.created.length; shim.renderAndCommit(comp()); return shim.rt.created; };
  const rendered = function () { return shim.rt.created.slice(mark395); };
  const flush = function () { return shim.flush(); };
  commit(); await flush();
  await openAllSections(shim, comp);
  commit(); await flush();
  if (shim.rt.throws.length) {
    const t = shim.rt.throws[0];
    throw new Error(t.where + ': ' + (t.err && t.err.message));
  }
  // A control may carry more than one class (the transport buttons do), so a class is matched as a token.
  const byCls = function (cls) { return rendered().filter(function (e) { return String((e.props && e.props.className) || '').split(/\s+/).indexOf(cls) >= 0; }); };
  const lastMatch = function (list) { return list.length ? list[list.length - 1] : null; };
  const own = function (e) {
    const c = (e.props && e.props.children);
    if (c === undefined || c === null) return '';
    const arr = Array.isArray(c) ? c : [c];
    return arr.map(function (x) { return (typeof x === 'string' || typeof x === 'number') ? String(x) : ''; }).join('');
  };
  const deepText = function (e) {
    let out = own(e);
    const kids = Array.isArray(e.props && e.props.children) ? e.props.children : [];
    kids.forEach(function (k) { if (k && k.props) out += ' ' + deepText(k); });
    return out;
  };
  const btnByTitle = function (re) { return rendered().filter(function (e) { return e.type === 'button' && re.test(String(e.props && e.props.title || '')); }); };
  const click = async function (el) {
    if (!el || typeof el.props.onClick !== 'function') throw new Error('control has no click handler');
    el.props.onClick();
    commit(); await flush(); commit(); await flush();
  };
  return { shim: shim, comp: comp, commit: commit, flush: flush, rendered: rendered, seen: seen, byCls: byCls, lastMatch: lastMatch, own: own, deepText: deepText, btnByTitle: btnByTitle, click: click };
}

/** Open the import row the eject opens, set the link, submit it. */
async function importStream(m, url390, host390) {
  const u390 = url390 || STREAM_URL;
  // T-621 item 8 (operator ruling 2026-10-25 02:28 Berlin): the eject is a TOGGLE — pressed while the import row it
  // opens is open, it closes that row.
  // T-621 item 11 (operator answer 2026-10-25 14:5x Berlin, verbatim "Remove the ✕"): the row's own cross is gone and
  // the eject is the row's ONLY closer, so a helper that wants the row open closes it WITH THE EJECT when the row is
  // on screen, then presses the eject again as the opening press.
  let eject = m.lastMatch(m.byCls('audio-play-tp-eject'));
  if (!eject) throw new Error('the eject control was not found');
  if (m.byCls('audio-play-import-url390').length) {
    await m.click(eject);                                                  // the closing press
    // The handler this shim presses is the one the LAST render made, and it closes over the state of that render:
    // after a press that changed the state, the control has to be picked up again out of the new render or the next
    // press repeats the old one instead of answering the new state.
    eject = m.lastMatch(m.byCls('audio-play-tp-eject'));
  }
  await m.click(eject);                                                    // the opening press
  const modeSel = m.lastMatch(m.byCls('audio-play-stream-mode390'));
  if (!modeSel || typeof modeSel.props.onChange !== 'function') throw new Error('the stream-input select was not found');
  modeSel.props.onChange({ target: { value: 'all' } });
  m.commit(); await m.flush();
  const input = m.lastMatch(m.byCls('audio-play-import-url390'));
  if (!input || typeof input.props.onChange !== 'function') throw new Error('the stream field was not found');
  input.props.onChange({ target: { value: u390 } });
  m.commit(); await m.flush();
  // T-621 item 11: play / DL / path are ONE button named import, and the act is chosen by the field's content. The
  // link this helper types is a plain http(s) host, which the merged button routes to the stream leg.
  const go = m.lastMatch(m.byCls('audio-play-import-merge646'));
  if (!go || typeof go.props.onClick !== 'function') throw new Error('the import button was not found');
  await m.click(go);
}

async function pressTake(m) { await m.click(m.lastMatch(m.btnByTitle(/play the row the transport is on/))); }
async function pressPause(m) { await m.click(m.lastMatch(m.byCls('audio-play-tp-pause'))); }
async function pressStop(m) { await m.click(m.lastMatch(m.byCls('audio-play-tp-stop'))); }

/** The one row of this list that names this link. */
function rowFor(m, host390) {
  return m.lastMatch(m.byCls('audio-play-stream-row390').filter(function (e) { return m.deepText(e).indexOf(host390 || ROW_HOST) >= 0; }));
}

async function scenario(mode, duck) {
  const seed = {};
  if (mode) seed['deepamp:stream.overlap'] = mode;
  if (duck !== undefined) seed['deepamp:stream.duck'] = String(duck);
  const m = await mount(seed);
  const hosts = m.seen.hosts;
  // T-603 RE-POINT (2026-10-27): three media elements are mounted now — the take element, the station element,
  // and the second take element a crossfade tail is moved onto. Which one the transport and the strip answer is
  // what the rest of this suite measures, and it still answers the take element: the tail element is never the
  // control, and it is never given a resource unless a two-sided handover is actually running.
  check('the panel holds three media elements: the take element, the station element, and the element a crossfade tail rides on', hosts.length === 3, hosts.length);
  check('neither element carries a native control strip (the transport row is still the only play control a person sees)',
    m.rendered().filter(function (e) { return e.type === 'audio'; }).some(function (e) { return e.props.controls === false; })
    && m.rendered().filter(function (e) { return e.type === 'audio'; }).every(function (e) { return e.props.controls === false; }),
    'controls');

  const modeSel = m.lastMatch(m.byCls('audio-play-overlap-mode395'));
  const duckIn = m.lastMatch(m.byCls('audio-play-overlap-duck395'));
  const duckRead = m.lastMatch(m.byCls('audio-play-overlap-duck-read395'));
  check('the overlap setting exists once, with the three behaviours the user asked for',
    !!modeSel && modeSel.props.children.length === 3, modeSel ? modeSel.props.children.length : 'no select');
  check('duck is the default and the value the panel starts with',
    !!modeSel && modeSel.props.value === (mode || 'duck'), modeSel ? modeSel.props.value : 'no select');
  check('the duck level is adjustable and reads its own number',
    !!duckIn && duckIn.props.min === '0' && duckIn.props.max === '100' && duckRead && /%$/.test(m.own(duckRead)),
    duckIn ? [duckIn.props.min, duckIn.props.max, duckRead && m.own(duckRead)] : 'no slider');
  check('the level control is only live in the mode that uses a level',
    !!duckIn && duckIn.props.disabled === (mode !== undefined && mode !== 'duck'), duckIn ? duckIn.props.disabled : 'no slider');

  await importStream(m);
  const take = hosts[0], station = hosts[1];
  check('the imported link plays on the STATION element, not on the take element',
    String(station.src) === STREAM_URL && !take.src, [String(station.src), String(take.src)]);
  check('the station element is the one that asks for the cross-origin claim, and it asks BEFORE its src is assigned',
    station.crossOrigin === 'anonymous', String(station.crossOrigin));
  check('importing a link is not a lane job: no play_job request was made for it',
    !m.seen.calls.some(function (c) { return /play_job/.test(c); }), m.seen.calls.slice(-3).join(' | '));
  // T-424 (user 2026-10-15): 'instead show the title of the stream in player 'title' display again instead of idle
  // while 'just streaming''. A station never enters the lane queue (T-405), so before this the player's title
  // line fell back to its idle word while the panel was audibly streaming. It now names the station - the host it
  // is streaming from, which is the only title the panel has, since a real stream title would mean asking the
  // station for metadata, and this panel does not make that request.
  const now424 = m.lastMatch(m.byCls('audio-play-now'));
  // The panel's own label for a station is what its list row carries, so the row is the reference for what the
  // title line should name - no guessing at how a URL turns into a host.
  const rowTxt424 = m.deepText(rowFor(m));
  const src424 = require('fs').readFileSync(TARGET, 'utf8');
  check('T-424 (re-pointed for T-513): while only the station plays, the player title line names the station with the SAME word the row prints, and says what kind of play it is',
    !!now424 && !/idle/.test(m.deepText(now424)) && m.deepText(now424).length > 2
    && rowTxt424.indexOf(m.deepText(now424).split(' \u00B7 ')[0]) >= 0
    && /web stream/.test(m.deepText(now424)),
    [now424 ? m.deepText(now424) : 'no title line', rowTxt424.slice(0, 70)]);
  check('T-424 source (re-pointed for T-513): the title line takes the live colour while a station streams, the way it does for a take — and now also when a finished take is still sitting in nowPlaying while the station is what is presented',
    /\(\(nowPlaying && !nowPlaying\.done\) \|\| \(streamNow395 && !nowPlaying\) \|\| !!stationNow469\)/.test(src424),
    (function () { const mm = src424.match(/statusColour300[\s\S]{0,200}/); return mm ? mm[0].slice(0, 190) : 'no line'; })());

  // T-407: the status lives on the link's own line, and that line's play control is a toggle.
  const row = rowFor(m);
  check('there is no separate status line above the list any more (T-407 took the second line back)',
    m.byCls('audio-play-stream-live395').length === 0, m.byCls('audio-play-stream-live395').length);
  check('the link line carries its own play status', !!row && /playing/.test(m.deepText(row)), row ? m.deepText(row) : 'no row');
  const playBtn = m0(row, m, 'audio-play-stream-play390');
  const playKid390 = playBtn ? (Array.isArray(playBtn.props.children) ? playBtn.props.children[0] : playBtn.props.children) : null;
  // T-440 (user 2026-10-15): the control used to be a text glyph inside a box that followed the glyph's own width, so
  // the line shifted when a station started (\u2016 is narrower than \u25B6) and the mark read as two hairlines rather
  // than a pause. It is now the transport's own pause path in a fixed 24 px box. This check is stronger than the one
  // it replaces: it names the glyph AND the box, not just the character.
  check('T-305 through T-440: the play control on the link is a toggle drawn with the transport pause glyph, in a box that does not follow the glyph',
    !!playBtn && !!playKid390 && playKid390.type === 'svg'
      && String(playKid390.props.className || '').indexOf('audio-play-tp-glyph316-pause') >= 0
      && playBtn.props.style.width === '24px' && playBtn.props.style.padding === '0' && playBtn.props.style.flex === '0 0 auto'
      // T-461: the height is the shared 20px box, the same one the Del beside it and the controls on a Task row use.
      && playBtn.props.style.height === '20px',
    playBtn ? [String(playKid390 ? playKid390.type : ''), String(playKid390 ? playKid390.props.className : ''), String(playBtn.props.style.width), String(playBtn.props.style.padding)] : 'no control');
  const src440 = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'client.js'), 'utf8');
  // T-461 (user 2026-10-15) re-pointed the STYLE HALF of this pin, not its rule. The control still cannot follow
  // the width of the glyph it is showing — fixed 24px, padding 0, flex 0 0 auto, the transport's own 16px path —
  // but its HEIGHT now comes from the playlist section's shared row-button box (ROW_BTN334, 20px) instead of a
  // height this one control chose for itself. The composition is what the pin reads, because the box is shared
  // rather than repeated.
  check('T-440 with T-461: both states are drawn from the transport glyph table, in the fixed 24 px box, and the control wears the section\u2019s shared row-button box',
    /tGlyph316\(playing397 \? "pause" : "play", 16\)/.test(src440)
      && /Object\.assign\(\{\}, btnStyle, ROW_BTN334, \{ width: "24px", padding: "0", display: "flex", alignItems: "center", justifyContent: "center", flex: "0 0 auto" \}\)/.test(src440)
      && /var ROW_BTN334 = \{ padding: "0 6px", fontSize: "10px", lineHeight: "16px", height: "20px", boxSizing: "border-box" \};/.test(src440),
    [/tGlyph316\(playing397/.test(src440), /btnStyle, ROW_BTN334, \{ width: "24px", padding: "0"/.test(src440)]);
  const stopBtn = row ? m.lastMatch(m.byCls('audio-play-stream-stop395')) : null;
  check('a stop button sits beside it on the left of the line, and it is live because this line is the one playing',
    !!stopBtn && stopBtn.props.disabled !== true && m.own(stopBtn) === '\u25A0', stopBtn ? [stopBtn.props.disabled, m.own(stopBtn)] : 'no stop');
  const kids = row && Array.isArray(row.props.children) ? row.props.children : [];
  check('the toggle and the stop are the two LEFT-most controls on the line',
    kids.length >= 2 && kids[0] === playBtn && kids[1] === stopBtn, kids.map(function (k) { return k && k.props && k.props.className; }));
  check('the station element is playing', station.paused === false, station.paused);

  // T-407: the panel's own display shows the station while no lane job is playing.
  const read = m.lastMatch(m.byCls('audio-play-lane-read'));
  check('the title read-out names the station while no playlist job is playing',
    !!read && m.own(read).indexOf(ROW_HOST) === 0 && /web stream/.test(m.own(read)), read ? m.own(read) : 'no read-out');
  const seek = m.lastMatch(m.byCls('audio-play-seek'));
  check('the seek bar stays off for a live station rather than pretending there is an end to reach (T-385 rule, kept)',
    !!seek && seek.props.disabled === true, seek ? seek.props.disabled : 'no bar');

  await pressTake(m);
  check('the take plays on its OWN element, and the station keeps its src unless the mode is the one that lets go of it',
    String(take.src) === ROUTE && (mode === 'stop' ? !station.src : String(station.src) === STREAM_URL),
    [String(take.src), String(station.src)]);

  if (mode === 'pause') {
    check('pause mode: the station is paused for the length of the take', station.paused === true, station.paused);
    check('pause mode: the station was not ducked to a level it was never given', station.volume === 1, station.volume);
  } else if (mode === 'stop') {
    check('stop mode: the panel lets go of the station so the take plays alone',
      !station.src && station.paused === true, [String(station.src), station.paused]);
  } else {
    const want = (duck === undefined ? 25 : duck) / 100;
    check('duck mode (the default): the station drops to the level the panel is set to, and nothing else changes',
      station.volume === want && station.paused === false, [station.volume, want, station.paused]);
    const row2 = rowFor(m);
    check('the link line says out loud that the station stepped back for this take',
      !!row2 && /stepped back/.test(m.deepText(row2)), row2 ? m.deepText(row2) : 'no row');
    // T-411 (user 2026-10-15): "the dot matrix display has a race condition while both playbacks are active
    // , ... the playlist item should be dominant over the stream, for display, timer, pos slider, title and
    // vis and controls while it plays". A ducked station keeps playing and keeps reporting about four times
    // a second, and the station's own handlers used to write every one of those reports straight onto the
    // panel's clock. The position bar is a direct reading of that clock, so it is where the race shows on.
    take.currentTime = 2.5; take.duration = 4.5; take.fire('timeupdate');
    m.commit(); await m.flush();
    const seekTake = m.lastMatch(m.byCls('audio-play-seek'));
    check("the take owns the position bar while it plays", !!seekTake && String(seekTake.props.value) === "2.5", seekTake && seekTake.props.value);
    station.currentTime = 999.25; station.fire('timeupdate');
    m.commit(); await m.flush();
    const seekAfter = m.lastMatch(m.byCls('audio-play-seek'));
    check("the station's own reports cannot move the panel's clock while a take is playing",
      !!seekAfter && String(seekAfter.props.value) === "2.5", seekAfter && seekAfter.props.value);
    const readTake = m.lastMatch(m.byCls('audio-play-lane-read'));
    check("the title line stays on the take while the take plays, even though the station is audible",
      !!readTake && !/web stream/.test(m.own(readTake)), readTake && m.own(readTake));
  }

  // The take ends. One door out, and every take walks through it.
  take.fire('ended');
  // A state write that happens DURING the flush - which is where the take's own 'ended' handler runs, and
  // with it releaseOverlap395() - schedules another render. One commit and one flush is not enough to see
  // the result of a write made inside the flush; the same click() helper in this suite does commit, flush,
  // commit, flush for exactly this reason. Without the second pair the readings below are the ones from
  // before the take ended, which is how the hand-back looked missing when it was there.
  m.commit(); await m.flush(); m.commit(); await m.flush();
  if (mode === 'stop') {
    check('stop mode: the station is NOT restarted behind a take the person never asked to hear again',
      !station.src && station.paused === true, [String(station.src), station.paused]);
  } else if (mode === 'pause') {
    check('pause mode: the station is started again when the render ends (pause stream -> play render -> resume stream)',
      station.paused === false && (station.plays || 0) >= 2, [station.paused, station.plays]);
  } else {
    check('duck mode: the station gets back the volume it had, exactly', station.volume === 1, station.volume);
    const seekBack = m.lastMatch(m.byCls('audio-play-seek'));
    check("and the station is handed the panel's readings back at once, not on its own next report",
      !!seekBack && String(seekBack.props.value) === "999.25", seekBack && seekBack.props.value);
    check('duck mode: the station was never paused, so nothing was missed', station.paused === false && station.ended !== true, [station.paused, station.ended]);
  }

  // T-407: the default play controls reach the station when no take is playing.
  if (mode !== 'stop') {
    const vol = m.lastMatch(m.byCls('audio-play-vol'));
    if (vol && typeof vol.props.onInput === 'function') {
      vol.props.onInput({ target: { value: '0.4' } });
      m.commit(); await m.flush();
      check('the transport volume slider moves the STATION while no playlist job is playing',
        station.volume === 0.4, [station.volume, take.volume]);
    } else check('the transport volume slider moves the STATION while no playlist job is playing', false, 'no slider');
    await pressPause(m);
    check('the transport pause button holds the station (it is what the panel is presenting)', station.paused === true, station.paused);
    const jobsBefore = m.seen.calls.filter(function (c) { return /play_job/.test(c); }).length;
    await pressTake(m);
    check('the play button on a held station resumes that station instead of starting something else',
      station.paused === false && m.seen.calls.filter(function (c) { return /play_job/.test(c); }).length === jobsBefore,
      [station.paused, m.seen.calls.filter(function (c) { return /play_job/.test(c); }).length - jobsBefore]);
    await pressPause(m);
    await pressStop(m);
    check('the transport stop button stops the station and lets go of it',
      !station.src && station.paused === true, [String(station.src), station.paused]);
    const logText = m.rendered().map(function (e) { return m.own(e); }).join('\n');
    check('and it says which thing it stopped', /station is stopped/.test(logText), 'log');
    const row3 = rowFor(m);
    check('the link is still on the list after a stop, so it can be started again', !!row3, 'row gone');
    const stop3 = m.lastMatch(m.byCls('audio-play-stream-stop395'));
    check('the stop on a line that is not playing is off rather than silently doing nothing',
      !!stop3 && stop3.props.disabled === true, stop3 ? stop3.props.disabled : 'no stop');
  }
  return m;
}

async function main() {
  console.log('\n--- T-405 / T-407: duck mode, the default the user called best ---');
  await scenario(undefined, undefined);
  check('the default needs no stored key: a fresh profile ducks at 25 %', global.localStorage.s['deepamp:stream.duck'] === undefined, global.localStorage.s['deepamp:stream.duck']);

  console.log('\n--- T-405 / T-407: pause and resume ---');
  const b = await scenario('pause', 40);
  const modeSelB = b.lastMatch(b.byCls('audio-play-overlap-mode395'));
  modeSelB.props.onChange({ target: { value: 'duck' } });
  b.commit(); await b.flush();
  check('changing the behaviour writes the panel\u2019s own key, and nothing is sent to the lane',
    global.localStorage.s['deepamp:stream.overlap'] === 'duck' && !b.seen.calls.some(function (c) { return /overlap|duck/.test(c); }),
    [global.localStorage.s['deepamp:stream.overlap'], b.seen.calls.slice(-2).join(' | ')]);
  const duckB = b.lastMatch(b.byCls('audio-play-overlap-duck395'));
  duckB.props.onInput({ target: { value: '900' } });
  b.commit(); await b.flush();
  check('the level is clamped to what the control can mean (0..100), not stored as an absurd number',
    global.localStorage.s['deepamp:stream.duck'] === '100', global.localStorage.s['deepamp:stream.duck']);
  const duckReadB = b.lastMatch(b.byCls('audio-play-overlap-duck-read395'));
  check('the read-out shows the clamped number, not the one that was typed', !!duckReadB && b.own(duckReadB) === '100%', duckReadB && b.own(duckReadB));

  console.log('\n--- T-405 / T-407: stop the stream, the mode that keeps the old behaviour available ---');
  await scenario('stop', 25);

  console.log('\n--- T-407: two links on the list, and the same link twice (the user added a second station to test) ---');
  const d = await mount({ 'deepamp:stream.mode': 'all' });
  await importStream(d);
  await importStream(d, 'http://other.test:8100/second', 'other.test');
  const dHosts = d.seen.hosts;
  const dStation = dHosts[1];
  check('one station at a time: the second link replaced the first on the station element',
    String(dStation.src) === 'http://other.test:8100/second' && !/radio\.test/.test(String(dHosts[0].src)),
    [String(dStation.src), String(dHosts[0].src)]);
  const dRows = d.byCls('audio-play-stream-row390');
  check('both links are on the list', dRows.length === 2, dRows.length);
  const dLive = d.byCls('audio-play-stream-status397');
  check('only the line that is actually playing carries a status', dLive.length === 1, dLive.length);
  const rowOther = rowFor(d, 'other.test');
  const rowFirst = rowFor(d, ROW_HOST);
  check('the status is on the line of the link that is playing, not on the other one',
    !!rowOther && desc(rowOther, d, 'audio-play-stream-status397') !== null && !!rowFirst && desc(rowFirst, d, 'audio-play-stream-status397') === null,
    [rowOther && d.own(desc(rowOther, d, 'audio-play-stream-status397') || { props: {} }), rowFirst && desc(rowFirst, d, 'audio-play-stream-status397') === null]);
  const dup = await mount({ 'deepamp:stream.mode': 'all' });
  await importStream(dup);
  await importStream(dup);
  const dupRows = dup.byCls('audio-play-stream-row390').filter(function (e) { return dup.deepText(e).indexOf(ROW_HOST) >= 0; });
  check('the list keeps both entries of the same link (newest first, no de-duplication was promised)',
    dupRows.length === 2, dupRows.length);
  check('and only ONE of those two lines says it is playing, because the import names the row it started',
    dup.byCls('audio-play-stream-status397').length === 1, dup.byCls('audio-play-stream-status397').length);
  check('the import goes straight to the station player instead of through the lane queue',
    !dup.seen.calls.some(function (c) { return /play_job/.test(c); }), dup.seen.calls.slice(-3).join(' | '));

  console.log('\n--- T-405 / T-407: the honest sentences, and the safety rules that did not move ---');
  const c = await mount({ 'deepamp:stream.mode': 'all' });
  const modeSelC = c.lastMatch(c.byCls('audio-play-overlap-mode395'));
  const tipC = modeSelC ? String(modeSelC.props.title || '') : '';
  check('the mode hover names all three behaviours and says what a live broadcast costs',
    /duck/.test(tipC) && /pause and resume/.test(tipC) && /stop/.test(tipC) && /LIVE broadcast/.test(tipC) && /part you missed is gone/.test(tipC), tipC.slice(0, 120));
  await importStream(c);
  const rowC = rowFor(c);
  const playC = m0(rowC, c, 'audio-play-stream-play390');
  const tipT = playC ? String(playC.props.title || '') : '';
  check('the station\u2019s own toggle says the truth about a live station instead of pretending it is a file',
    /live broadcast does not pause in place/.test(tipT) && /part you missed is gone/.test(tipT), tipT.slice(0, 130));
  const src = require('fs').readFileSync(TARGET, 'utf8');
  // T-405 asked where the duck level was and looked in Settings; the user then moved the whole row there.
  // A control found by class can sit in any section, so the SECTION is what has to be pinned: the overlap row
  // comes after the Settings heading, after the stream-input row, and before the generated-files block.
  // T-802 RE-POINT (2026-11-12, the operator's card answer on which directory that block names: "we should
  // display the root path and check it for free space and write access"): the block's heading is the store
  // root line. The boundary this check exists for is the same boundary, one wording later.
  check("T-405 through T-410, re-pointed 2026-11-12 (T-802): the overlap rule is a SETTING, not an auto-play rule",
    (function () {
      const iSet = src.indexOf('title: "Settings"');
      const iAuto = src.indexOf("Auto-play Agent Session");
      const iStream = src.indexOf("audio-play-stream-mode390");
      const iOverlap = src.indexOf("audio-play-overlap395");
      const iFiles = src.indexOf("Store root: the directory this plugin keeps its files in");
      return iSet > 0 && iAuto > 0 && iStream > 0 && iOverlap > 0 && iFiles > 0
        && iSet < iOverlap && iStream < iOverlap && iOverlap < iFiles && iAuto < iSet;
    })(),
    [src.indexOf('title: "Settings"'), src.indexOf('audio-play-overlap395'), src.indexOf('Store root: the directory this plugin keeps its files in')]);

  check('the standing safety rule still holds: createMediaElementSource is never called, the tap is captureStream',
    !/createMediaElementSource\s*\(/.test(src) && /captureStream\(\)/.test(src));
  check('the panel still never reaches for the station\u2019s own metadata headers',
    !/icy-br|icy-samplerate|icy-channels/.test(src));
  const streamBody = (src.split('function playStream395')[1] || '').slice(0, 4000);
  check('the stream player asks the host for nothing: it only hands a link to a media element',
    !!streamBody && !/\bcall\(/.test(streamBody) && !/fetch\(/.test(streamBody) && !/writeFile/.test(streamBody),
    [!!streamBody, /\bcall\(/.test(streamBody), /fetch\(/.test(streamBody)]);
  check('one reading decides what the strip draws and one decides what the buttons act on, and both are named',
    /function pictureEl395\(\)/.test(src) && /function controlEl395\(\)/.test(src)
    && /var a = controlEl395\(\);/.test(src) && /var a = pictureEl395\(\);/.test(src));

  // --- T-504 (user 2026-10-16, verbatim): "If stream is playing via imported streams, then a playlist item is
  //     played over it at the same time, the Stop button in player actually pauses the stream, not the playlist item,
  //     but if a playlist item is played it's the 'primary' source, so player buttons should control that as long as
  //     it's playing."  Measured before the fix: the press stopped the STATION (src gone, left paused) and left the
  //     take playing. The cause was the order inside stopPlayback299 - it cleared the flag that says a take is
  //     playing before asking controlEl395() which element the press is about.
  console.log('\n--- T-504: while a take plays, the playlist item is what the player buttons act on ---');
  {
    const m = await mount({});
    const hosts = m.seen.hosts;
    const take504 = hosts[0], station504 = hosts[1];
    await importStream(m);
    m.commit(); await m.flush();
    await pressTake(m);
    check('T-504 setup: a take plays OVER a ducked station - the take is audible on its own element, the station is still playing at the ducked level',
      String(take504.src).indexOf('/deepamp/ap-7001') >= 0 && take504.paused === false
      && String(station504.src) === STREAM_URL && station504.paused === false && station504.volume < 1,
      { take: String(take504.src), takePaused: take504.paused, station: String(station504.src), stationPaused: station504.paused, vol: station504.volume });
    await pressStop(m);
    check('T-504: the transport STOP stops the TAKE - the playlist item is the primary source as long as it plays',
      take504.paused === true && take504.currentTime === 0 && String(take504.src).indexOf('/deepamp/ap-7001') >= 0,
      { takePaused: take504.paused, takeTime: take504.currentTime, takeSrc: String(take504.src) });
    check('T-504: and the same press leaves the station alone - the link is still loaded and still playing',
      station504.paused === false && String(station504.src) === STREAM_URL,
      { stationPaused: station504.paused, stationSrc: String(station504.src) });
    check('T-504: the duck is released by that press - a take stopped by hand never fires "ended", so the one door that hands the level back had to be walked here too',
      station504.volume === 1, station504.volume);
    check('T-504: the station is not re-requested either - stopping a take is not a new play',
      (station504.plays || 0) <= 1, station504.plays);

    // The other transport controls in the SAME state, measured so the ruling covers the buttons and not one button.
    const m3 = await mount({});
    const hosts3 = m3.seen.hosts;
    const take3 = hosts3[0], station3 = hosts3[1];
    await importStream(m3);
    m3.commit(); await m3.flush();
    await pressTake(m3);
    await pressPause(m3);
    check('T-504: the pause button pauses the TAKE in that state and leaves the station streaming (it already did - this is the rule the stop had to join)',
      take3.paused === true && station3.paused === false && String(station3.src) === STREAM_URL,
      { takePaused: take3.paused, stationPaused: station3.paused });
    await pressPause(m3);
    const vol504 = m3.lastMatch(m3.byCls('audio-play-vol'));
    if (vol504 && typeof vol504.props.onInput === 'function') {
      const sv504 = station3.volume;
      vol504.props.onInput({ target: { value: '0.7' } });
      m3.commit(); await m3.flush();
      check('T-504: and the transport volume slider moves the TAKE while it is the source, leaving the station at its ducked level',
        take3.volume === 0.7 && station3.volume === sv504, { takeVol: take3.volume, stationVol: station3.volume, ducked: sv504 });
    } else check('T-504: and the transport volume slider moves the TAKE while it is the source', false, 'no volume slider in that state');

    // The other half of the same button: with no take playing it is still the station's stop (T-407).
    const m2 = await mount({});
    const hosts2 = m2.seen.hosts;
    const take2 = hosts2[0], station2 = hosts2[1];
    await importStream(m2);
    m2.commit(); await m2.flush();
    await pressStop(m2);
    check('T-504 regression on T-407: with NO take playing, the same button is still the station\u2019s stop, and the take element is untouched',
      station2.paused === true && !station2.src && take2.paused !== false,
      { stationPaused: station2.paused, stationSrc: String(station2.src), takeSrc: String(take2.src) });

    const src504 = require('fs').readFileSync(TARGET, 'utf8');
    const stopBody504 = (src504.split('function stopPlayback299')[1] || '').split('function togglePlaybackPause299')[0];
    const iClear504 = stopBody504.indexOf('playingRef.current = false');
    const iRead504 = stopBody504.indexOf('var ctl397 = controlEl395()');
    check('T-504 source: the button works out WHICH source it is acting on before it clears the flag that says a take is playing - that order was the bug',
      iRead504 >= 0 && iClear504 >= 0 && iRead504 < iClear504, { readAt: iRead504, clearAt: iClear504 });
    check('T-504 source: the take branch hands the station back (releaseOverlap395) and the display is re-read from the source that is left, not forced to idle',
      /releaseOverlap395\(\);/.test(stopBody504)
      && /var ctl504 = controlEl395\(\);/.test(stopBody504)
      && /scopePlayMark300\.current = \(ctl504 && ctl504\.paused === false/.test(stopBody504), {});
    check('T-504 source: the sentence says the station keeps streaming when it does - a person must not have to guess which playback the press ended',
      /the station keeps streaming, at its own level again/.test(stopBody504), {});
  }

  console.log('\n--- T-513 (user 2026-10-16, verbatim): "it looks like we still do not show the right stream info in the ticker during stream-only play - needs revisit" ---');
  {
    // The state the user was looking at: a take played over a ducked station, the take ended, and the station went
    // on being audible. The panel still holds that finished take in nowPlaying, which is exactly what made the
    // ticker name something that was not playing.
    const m513 = await mount({});
    const h513 = m513.seen.hosts;
    const take513 = h513[0], station513 = h513[1];
    await importStream(m513);
    m513.commit(); await m513.flush();
    await pressTake(m513);
    take513.ended = true;
    take513.fire('ended');
    m513.commit(); await m513.flush(); m513.commit(); await m513.flush();
    const nowLine513 = m513.lastMatch(m513.byCls('audio-play-now'));
    const line513 = nowLine513 ? m513.deepText(nowLine513) : '';
    const tip513 = nowLine513 ? String(nowLine513.props.title || '') : '';
    check('T-513 setup: the take ended on its own while the ducked station kept playing - the state the report was about',
      String(station513.src) === STREAM_URL && station513.paused === false,
      { station: String(station513.src), paused: station513.paused, takeSrc: String(take513.src) });
    check('T-513: the title line names the STATION in that state. A station line and a take line must not look alike, so it names the station the way the row names it and adds the kind of play',
      /radio\.test/.test(line513) && /web stream/.test(line513), line513.slice(0, 90));
    check('T-513: no take is printed as if it were playing - the finished take is gone from the line, id and all',
      !/ap-7001/.test(line513) && !/finished/.test(line513) && !/idle/.test(line513), line513.slice(0, 90));
    check('T-513: the hover is where the finished take belongs - named, and named as the LAST take of the lane, one that finished before this station started',
      /fetched by the browser, nothing was written to disk/.test(tip513)
      && (!/ap-7001/.test(tip513) || /finished before this station started/.test(tip513)), tip513.slice(0, 170));
    // RE-POINTED 2026-11-07 by T-747: the count moved 2 -> 4. The station's name is still carried in the state at
    // both station starts (the plain retry and the normal start), and it is carried in two more places now: the
    // last-played memory that a stop press leaves behind, which is what the transport's play control restarts the
    // station UNDER. Operator's words: "it should start playing the last played stream ... we need to remember last
    // played item on manual stop". Trap T-601 item 3 — the drawings were never wrong, the press counts moved.
    check('T-513 source: the ticker asks the SAME question the transport row asks. controlEl395() decides whether the line names a take or a station, so the two readers cannot drift apart again, and the name a station was played WITH is carried in the state instead of dropped',
      (function () {
        const src513 = require('fs').readFileSync(TARGET, 'utf8');
        const i313 = src513.indexOf('var ctrlEl469 = controlEl395();');
        const j313 = src513.indexOf('var tickerTxt300 = tickerText300(');
        return i313 > 0 && j313 > i313 && /stationNow469/.test(src513.slice(i313, j313))
          && /if \(station469\) \{/.test(src513)
          && src513.indexOf('function streamLabel395(') > 0
          && (src513.match(/label: streamLabel395\(label, host395\)/g) || []).length === 4
          && (src513.match(/rememberStation747\(\{ url: url, label: streamLabel395\(label, host395\), id: rowId395 \|\| null \}\)/g) || []).length === 2;
      })(), {});
  }


  console.log('\n--- T-450 (host ruling 2026-10-16 Q5, client half): the ONE authorised station is asked what it is playing, once per station start, and its title is what the top row spends its width on ---');
  {
    const SONG450 = 'Falco - Rock Me Amadeus (Live)';
    const ANS_OK450 = { ok: true, st: 'ok', title: SONG450, station: '1LIVE', url: STREAM_URL, metaint: 16000, http: 200 };
    const ANS_REFUSE450 = { ok: false, st: 'not_authorised', title: '', station: '', authorised: 'https://wdr-1live-live.icecastssl.wdr.de/wdr/1live/live/mp3/128/stream.mp3', error: 'the plugin reads a station title for one authorised station only' };

    const asks450 = function (m450) {
      return m450.seen.calls.filter(function (c450) { return /station_title/.test(String(c450)); });
    };
    const lineAndTip450 = function (m450) {
      const el450 = m450.lastMatch(m450.byCls('audio-play-now'));
      return { line: el450 ? m450.deepText(el450) : '', tip: el450 ? String(el450.props.title || '') : '' };
    };

    // A. the authorised station answers with a title: the line carries the SONG, the station name stays beside
    // it, and the host name leaves the line — because the imported row already prints the host, and the top row
    // is the one line that can say what none of the others know.
    const mA450 = await mount({}, { stationAnswers: { [STREAM_URL]: ANS_OK450 } });
    await importStream(mA450);
    mA450.commit(); await mA450.flush(); mA450.commit(); await mA450.flush();
    const a450 = lineAndTip450(mA450);
    check('T-450: the ask is made ONCE per station start, as a GET, and it carries the link the panel is already playing',
      asks450(mA450).length === 1 && /^GET \/api\/deepamp\/station_title\?url=/.test(asks450(mA450)[0])
      && asks450(mA450)[0].indexOf(encodeURIComponent(STREAM_URL)) > 0, asks450(mA450));
    check('T-450: when the station announces a title, the top row shows THE TITLE and the station name, and the hostname it used to repeat is gone from the line',
      a450.line.indexOf(SONG450) >= 0 && /web stream/.test(a450.line) && a450.line.indexOf(STREAM_HOST) < 0,
      { line: a450.line.slice(0, 110) });
    check('T-450: the hover says where the title came from - the station-s own audio metadata, read once when this station started - so a person can tell a learned string from a derived one',
      /what the station announced in its own audio, read once when this station started/.test(a450.tip), a450.tip.slice(0, 200));

    // B. the host refuses, because this station is not the authorised one: the line is EXACTLY what it was
    // before this feature, and the hover names the real reason rather than claiming the station said nothing.
    const mB450 = await mount({}, { stationAnswers: { [STREAM_URL]: ANS_REFUSE450 } });
    await importStream(mB450);
    mB450.commit(); await mB450.flush(); mB450.commit(); await mB450.flush();
    const b450 = lineAndTip450(mB450);
    check('T-450 (the fallback the ruling keeps): a refused ask leaves the line exactly as it was - the station name, the host, and web stream - because the doubling is only wrong when a better string exists',
      /radio\.test/.test(b450.line) && /web stream/.test(b450.line) && b450.line.indexOf(SONG450) < 0,
      { line: b450.line.slice(0, 110) });
    check('T-450: the hover names WHICH fact a missing title is - here that the plugin may ask one authorised station only, not that the station announced nothing',
      /one authorised station only/.test(b450.tip) && !/announced no title/.test(b450.tip), b450.tip.slice(0, 220));

    // C. two stations in a row: the title learned for the first one may not travel to the second.
    const OTHER450 = 'http://other.test:8000/live';
    const mC450 = await mount({}, { stationAnswers: { [STREAM_URL]: ANS_OK450, [OTHER450]: ANS_REFUSE450 } });
    await importStream(mC450);
    mC450.commit(); await mC450.flush();
    const cLine1450 = lineAndTip450(mC450).line;
    await importStream(mC450, OTHER450, 'other.test');
    mC450.commit(); await mC450.flush(); mC450.commit(); await mC450.flush();
    const c450 = lineAndTip450(mC450);
    check('T-450 setup: the first station really did put its title on the line, so the second import is being measured against a title that EXISTS and must not follow',
      cLine1450.indexOf(SONG450) >= 0 && asks450(mC450).length === 2, { first_line: cLine1450.slice(0, 90), asks: asks450(mC450).length });
    check('T-450: a title learned for one station never travels to another - the second station-s own line names the second station and carries none of the first song',
      c450.line.indexOf(SONG450) < 0 && /other\.test/.test(c450.line) && /web stream/.test(c450.line),
      { line: c450.line.slice(0, 110), asks: asks450(mC450).map(function (x450) { return x450.slice(0, 60); }) });

    // D. no answer yet: the line keeps the station name and the hover says the ask has not finished, which is
    // the UNKNOWN state this panel is not allowed to paint over.
    const mD450 = await mount({}, { stationAnswers: {} });
    await importStream(mD450);
    mD450.commit(); await mD450.flush(); mD450.commit(); await mD450.flush();
    const d450 = lineAndTip450(mD450);
    check('T-450: an ask that answers nothing leaves the line on the station name, and the hover says the station announced no title rather than inventing one',
      /radio\.test/.test(d450.line) && d450.line.indexOf(SONG450) < 0 && /announced no title to the plugin/.test(d450.tip),
      { line: d450.line.slice(0, 90), tip: d450.tip.slice(0, 200) });

    check('T-450 source: one ask per station start and nowhere else, the ask is a GET, the title is gated on the url it was learned from, and nothing in this feature re-asks on a clock',
      (function () {
        const src450 = require('fs').readFileSync(TARGET, 'utf8');
        const asks = (src450.match(/askStationTitle450\(/g) || []).length;
        const i450 = src450.indexOf('function askStationTitle450(');
        const j450 = src450.indexOf('function stationTitleFor450(');
        const gate450 = src450.slice(j450, j450 + 700);
        const lane450 = src450.slice(src450.indexOf("case 'station_title':"), src450.indexOf("case 'station_title':") + 220);
        return asks === 3 && i450 > 0 && j450 > i450
          && /method = 'GET';/.test(lane450) && /station_title\?url=|'\?url=' \+ encodeURIComponent/.test(lane450)
          && /if \(stationTitle450\.url !== st469\.url\) return ""/.test(gate450)
          && !/setInterval\([^)]*stationTitle/.test(src450)
          && (src450.match(/setStationTitle450\(/g) || []).length === 2;
      })(), {
        ask_sites: (require('fs').readFileSync(TARGET, 'utf8').match(/askStationTitle450\(/g) || []).length,
        set_sites: (require('fs').readFileSync(TARGET, 'utf8').match(/setStationTitle450\(/g) || []).length,
        get_verb: true, url_gated: true,
      });
  }

  // --- T-551 (user 2026-10-17, verbatim): "i have the feeling that the playback of voice samples from the playbutton
  // in the voices section OR the playlist, WHILE playing a stream doesn't restore the stream volume after playback, it
  // stays ducked - the vol slider shows 100% but setting it to 100% makes it louder ... i guess we are missing the
  // restore previous stream volume after the overplay by voice samples -> needs analysis".
  // The scenario this suite already has proves the single case: one take ducks the station, the take ends, the station
  // gets its volume back. What is NOT covered is the case the user is describing: a play act that INTERRUPTS a take
  // that is still playing. playJob (client.js:12505), playSrcNow (12536) and playVoiceNow448 (12548) all interrupt the
  // same way - empty the client queue, clear the busy flag, queuePlayback with force - and playJob's own comment names
  // the fact that makes this dangerous: "replacing src mid-playback never fires 'ended' for the old file". The old
  // take's finish is the ONLY door that hands the station back, and an interrupt closes that door before it is walked
  // through. So the second take ducks a station that is already ducked, remembers THAT as its previous level, and the
  // first take's real level is lost with the token that held it.
  console.log('\n--- T-551: a play act that interrupts a ducked take ---');
  {
    const m = await mount({ 'deepamp:stream.duck': '25' });
    await importStream(m);
    const hosts551 = m.seen.hosts;
    const take551 = hosts551[0], station551 = hosts551[1];
    await pressTake(m);
    check('T-551 setup: the first take ducks the station to the level the panel is set to',
      station551.volume === 0.25 && String(station551.src) === STREAM_URL && station551.paused === false,
      [station551.volume, String(station551.src), station551.paused]);
    await pressTake(m);
    m.commit(); await m.flush();
    check('T-551: an interrupting play act does not compound the duck - the station is at the duck level once, not at the duck of a duck',
      station551.volume === 0.25 && String(station551.src) === STREAM_URL,
      [station551.volume, String(take551.src)]);
    take551.fire('ended');
    m.commit(); await m.flush(); m.commit(); await m.flush();
    check('T-551: when the interrupting take ends, the station is handed back the volume it had before ANY take ducked it - not the level the second take found it sitting at',
      station551.volume === 1, [station551.volume]);
    // The user named two doors: the play button on a voice row, and a playlist row. Both, and the source play button,
    // are the same three functions, and all three are interrupt acts that go through queuePlayback with force - which
    // is why one fix in applyOverlap395 covers all three rather than three separate patches. This is pinned at source
    // level so a later edit cannot quietly give one of them its own path past the door.
    (function () {
      const src551 = require('fs').readFileSync(TARGET, 'utf8');
      const applyBody = src551.slice(src551.indexOf('function applyOverlap395('), src551.indexOf('function releaseOverlap395('));   // (T-813 contract change) the signature now takes the take's token; the slice is the same function body this pin was written against.
      check('T-551 source: the release-before-the-duck is inside applyOverlap395 itself, and the three interrupt acts still reach the station through the one funnel that calls it',
        /var held551 = overlapRef395\.current;/.test(applyBody)
        && /if \(held551\.kind === "duck"\) \{ try \{ held551\.el\.volume = held551\.vol;/.test(applyBody)
        // Measured against the function body, not the file: `var a395 = streamAudioRef.current;` appears in other
        // functions too, and a whole-file indexOf compares this pin against the wrong line.
        && applyBody.indexOf('var held551 = overlapRef395.current;') < applyBody.indexOf('var a395 = streamAudioRef.current;')
        && /playQRef\.current\.length = 0;\s*\n\s*playingRef\.current = false;\s*\n\s*queuePlayback\(r\.route_url, id, true\)/.test(src551)
        && /queuePlayback\("\/deepamp\/voice\/" \+ encodeURIComponent\(nm448\), "voice sample \\u00B7 " \+ nm448, true\)/.test(src551)
        // RE-POINTED IN PLACE 2026-10-21 (T-627): the source press builds its route into `u627` before it
        // interrupts, because the press first asks whether the file it names is the paused one. The interrupt
        // itself - empty the queue, clear the busy flag, queue with force - is what this pin guards, and it is
        // still the same three lines in the same order.
        && /var u627 = "\/deepamp\/" \+ encodeURIComponent\(id\) \+ "\?src=1";[\s\S]{0,400}?queuePlayback\(u627, id, true\)/.test(src551),
        { release_inside_apply_first: applyBody.indexOf('var held551 = overlapRef395.current;') < applyBody.indexOf('var a395 = streamAudioRef.current;'),
          row_press_interrupts: /queuePlayback\(r\.route_url, id, true\)/.test(src551),
          voice_sample_interrupts: /voice sample \\u00B7 /.test(src551),
          src_press_interrupts: /queuePlayback\(u627, id, true\)/.test(src551) });
    })();
  }

  // --- T-813 (WM-31 item 20, opened 2026-11-07 08:02 Berlin): the reported symptom was a web-stream playing
  // while playlist items hand over by crossfade, and the card's ruled expectation (its item 5) is that the
  // station stays ducked, or stays paused, while playlist items hand over to one another, and the hold is
  // released only when no take is holding it. The card also said the claim needed a read before it was treated
  // as a diagnosis (its item 4) — this is that read. What the mock can see is the station element's own play
  // counter, and in the mode the report describes it is enough to answer: a handover that releases the hold and
  // re-takes it resumes the station and pauses it again in the same call.
  console.log('\n--- T-813: a handover between two takes, crossfade on pause the stream ---');
  {
    const m = await mount({ 'deepamp:stream.duck': '25', 'deepamp:stream.overlap': 'pause' });
    await importStream(m);
    const hosts813 = m.seen.hosts;
    const take813 = hosts813[0], station813 = hosts813[1];
    const plays813 = station813.plays || 0;
    await pressTake(m);
    m.commit(); await m.flush();
    check('T-813 setup: with the crossfade on pause the stream, the first take pauses the station and holds that pause',
      station813.paused === true && String(station813.src) === STREAM_URL && station813.plays === plays813,
      [station813.paused, String(station813.src), station813.plays]);
    await pressTake(m);            // the handover: the next take walks the same door
    m.commit(); await m.flush();
    check('T-813: the handover does not walk the station through a resume and a re-pause — the hold is carried to the take that now plays',
      (station813.plays || 0) === plays813 && station813.paused === true,
      [plays813, station813.plays || 0, 'station play calls before and after the handover; paused after: ' + station813.paused]);
    take813.fire('ended');
    m.commit(); await m.flush(); m.commit(); await m.flush();
    check('T-813: the take now holding the pause hands it back when it ends — the station plays again',
      station813.paused === false && (station813.plays || 0) > plays813,
      [station813.paused, station813.plays || 0]);
    (function () {
      const src813 = require('fs').readFileSync(TARGET, 'utf8');
      const applyAt813 = src813.indexOf('function applyOverlap395(');
      const relAt813 = src813.indexOf('function releaseOverlap395(');
      const applyBody813 = src813.slice(applyAt813, relAt813);
      const relBody813 = src813.slice(relAt813, relAt813 + 2800);
      check('T-813 source: the hold names the take that took it, the carry is weighed before anything is released, the carry refuses a duck whose level is no longer the one the panel is set to, and a take that does not hold the station leaves the hold to the one that does',
        applyAt813 > 0 && relAt813 > applyAt813
        && /var tok813 = \+\+overlapSeq395Ref\.current;/.test(src813)
        && /overlapRef395\.current = applyOverlap395\(tok813\);/.test(src813)
        && /releaseOverlap395\(tok813\);/.test(src813)
        && /if \(owner813 !== undefined && transferable813\(carry813, owner813\)\) \{\s*\n\s*carry813\.owner = owner813;\s*\n\s*return carry813;/.test(applyBody813)
        && applyBody813.indexOf('transferable813(carry813') < applyBody813.indexOf('var held551 = overlapRef395.current;')
        && /if \(held813\.kind === "duck"\) return overlapMode395v === "duck" && a813\.volume === duckLevel395v \/ 100;/.test(src813)
        && /return \{ kind: "duck", el: a395, vol: prev395, owner: owner813 \};/.test(applyBody813)
        && /var other813 = !!\(t395 && owner813 !== undefined && t395\.owner !== undefined && t395\.owner !== owner813\);/.test(relBody813)
        && /if \(!other813 && t395\.kind === "duck"\)/.test(relBody813)
        && /if \(!other813 && t395\.kind === "pause"\)/.test(relBody813)
        && (src813.match(/applyOverlap395\(/g) || []).length === 2,
        { apply_sites: (src813.match(/applyOverlap395\(/g) || []).length,
          release_sites: (src813.match(/releaseOverlap395\(/g) || []).length });
    })();
  }

  console.log('\n=== ' + pass + ' pass, ' + fail + ' fail ===');
  if (fail) process.exitCode = 1;
}
/** Any element of a class inside one row's own subtree, not only its direct children. */
function desc(row, m, cls) {
  if (!row) return null;
  const kids = Array.isArray(row.props.children) ? row.props.children : [];
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (!k || !k.props) continue;
    if (String(k.props.className || '').split(/\s+/).indexOf(cls) >= 0) return k;
    const deep = desc(k, m, cls);
    if (deep) return deep;
  }
  return null;
}
/** The control of a class that belongs to one row (the newest mount wins, as always in this harness). */
function m0(row, m, cls) {
  if (!row) return null;
  const kids = Array.isArray(row.props.children) ? row.props.children : [];
  return kids.filter(function (k) { return k && k.props && k.props.className === cls; })[0] || null;
}

main().catch(function (e) { console.log('THROW: ' + (e && e.stack || e)); process.exitCode = 2; });
