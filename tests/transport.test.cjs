// T-300 U-2 / U-3 (2026-10-12, user request): the Winamp-style transport row and the playlist columns.
// This suite is about WIRING and honesty, not pixels: which verb each button posts, what the panel is
// allowed to claim about a row it cannot play, and the two user decisions the row implements — prev/next
// walk the WHOLE playlist, and a row whose file is gone is SKIPPED by the transport while the row itself
// still says what happened.
// Usage: node tests/transport.test.cjs [path/to/client.js]
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

const calls = [];
const bodies = [];
let ttsPaused = false;
let deadRefused = 0;
// T-436 UI pass (user 2026-10-15): the panel's DL press is now a GUIDE when the setting is missing, so the
// suite needs both worlds — a host with no binary (the guide path) and a host with one (the capture path).
// This flag flips the fake host between them mid-suite.
let ytdlpSet436 = false;
// T-458: which world the typed-path door is answering in — the filed answer or the header-mismatch refusal. The
// suite flips this between presses so the panel's behaviour in each world is measured, not assumed.
let importFile458 = true;
// T-353 (user bug report 2026-10-14): the rows this lane answers. `plOverride` lets a late check show the
// panel rows it is NOT allowed to play — queued or synthesizing rows — without pulling the fixed rows out
// from under the checks that ran earlier.
const PL_FIXED = [
  { id: 'ap-1001', fn: 'tts', kind: 'tts', status: 'ok', model: 'm1', voice: 'voy_janeway', duration: 13.1, text: 'Chakotay, report to the bridge.' },
  { id: 'ap-1002', fn: 'stt', kind: 'stt', status: 'ok', model: 'qwen3_asr', duration: 4.2, transcript: 'the shuttles are fuelled' },
  { id: 'ap-1003', fn: 'tts', kind: 'tts', status: 'ok', model: 'm1', voice: 'voy_doctor', duration: 215.6, text: 'I am the Doctor, not a door.' },
  // A row that never produced audio: no length was ever reported for it. This is the case --:--
  // exists for, and it is deliberately an STT row so it does not change the transport walk.
  { id: 'ap-1004', fn: 'stt', kind: 'stt', status: 'error', model: 'qwen3_asr', duration: 0, error: 'engine refused the file' },
];
let plOverride = null;
function host(url, opts) {
  const method = ((opts && opts.method) || 'GET').toUpperCase();
  const u = String(url);
  calls.push(method + ' ' + u.replace('/api/deepamp/', '~'));
  bodies.push((opts && opts.body) || '');
  let body;
  if (/get_endpoints/.test(u)) body = { tts: { url: 'http://cpu1.test:8963', route: 'speech' }, stt: { url: 'http://cpu1.test:8962', route: 'tasks' } };
  else if (/server_status/.test(u)) body = { tts: { ok: true, loaded_model: 'm1' }, stt: { ok: true } };
  else if (/get_models/.test(u)) body = { models: [{ id: 'm1', loaded: true }] };
  else if (/refresh_voices/.test(u)) body = { voices: ['voy_janeway'], builtins: ['alba'], builtins_source: 'mirror', default_voice: '' };
  else if (/playlist_list/.test(u)) {
    body = {
      items: (plOverride || PL_FIXED).slice(),
      queues: { tts: { paused: ttsPaused, running: null, queued: 0 }, stt: { paused: false, running: null, queued: 0 } },
    };
  }
  else if (/pause_fn/.test(u)) { ttsPaused = true; body = { ok: true, queue_paused: true, queues: { tts: { paused: true, queued: 0 }, stt: { paused: false, queued: 0 } } }; }
  else if (/resume_fn/.test(u)) { ttsPaused = false; body = { ok: true, queue_paused: false, queues: { tts: { paused: false, queued: 0 }, stt: { paused: false, queued: 0 } } }; }
  else if (/queue_status/.test(u)) body = { ok: true, queues: { tts: { queued: 0, paused: ttsPaused, running_ids: [] }, stt: { queued: 0, paused: false, running_ids: [] } } };
  else if (/play_job/.test(u)) {
    // The panel puts the job id in the PATH for this verb (client.js: play_job / abort_job /
    // cancel_job take route += '/' + job_id), so the id is read from the URL, not from a body.
    const id = (u.match(/play_job\/([^/?]+)/) || [])[1] || '';
    // ap-1003 is the dead row: the lane says there is nothing to play. The panel has no way to know
    // that before asking, which is exactly why "dead" is defined as "the lane refused this row".
    if (id === 'ap-1003' && deadRefused === 0) { deadRefused++; body = { ok: false, error: 'file not found: /home/deepamp-test/.dsh/deepamp-audio/tts/ap-1003.wav' }; }
    else body = { ok: true, route_url: '/deepamp/' + id, job_id: id };
  }
  else if (/ytdlp_path/.test(u)) {
    // T-436: the answer a freshly booted host really gives — the setting is NOT configured — and, once the
    // suite flips ytdlpSet436, the answer a configured host gives. The panel has to SHOW both, and never
    // guess either, so the suite answers the way the host answers instead of letting this door fall through
    // to the generic {ok:true} below.
    body = ytdlpSet436
      ? { ok: true, path: '/home/deepamp-test/bin/yt-dlp', configured: true, resolves: true, version: '2026.08.19', error: '', checked_at: 1792057384794 }
      : { ok: true, path: '', configured: false, resolves: false, version: '', error: '', checked_at: 0 };
  }
  else if (/capture_url/.test(u)) {
    // The same two worlds as the setting above: a host with no binary refuses before it asks anything, and a
    // host WITH one answers with what its binary actually said about this link.
    body = ytdlpSet436
      ? { ok: false, error: 'the capture left no audio file: ERROR: unable to extract video information - HTTP Error 403: Forbidden', version: '2026.08.19' }
      : { ok: false, error: 'no yt-dlp path is configured — Settings → "(optional) add yt-dlp binary by path"' };
  }
  else if (/import_path/.test(u)) {
    // T-458: the two worlds the typed-path door really has. A FILED answer names the copy it made, the header it
    // verified, the measured length and the row it created; a REFUSAL names BOTH sides of the mismatch in the host's
    // own words. The suite flips which world it is in, so the panel's behaviour in each is measured separately.
    body = importFile458
      ? { ok: true, id: 'ap-0900', job_id: 'ap-0900', row_kind: 'upload', row_status: 'ok',
          file_path: '/home/deepamp-test/.dsh/deepamp-audio/stt/uploads/ap-0900_room-tone.wav',
          output_path: '/home/deepamp-test/.dsh/deepamp-audio/stt/uploads/ap-0900_room-tone.wav',
          route_url: '/deepamp/ap-0900', duration: 4.3, size_bytes: 8192, extension: 'wav',
          header: 'RIFF....WAVE', imported_path: '/home/deepamp-test/tmp_media/room_tone.wav',
          copied_into_store: true, filed_in_place: false }
      : { ok: false, error: 'header mismatch: the name says .wav (expected RIFF....WAVE), the file says OggS (ogg/oga/opus)',
          detail: { extension: 'wav', expected: 'RIFF....WAVE', looks_like: ['OggS (ogg/oga/opus)'] } };
  }
  else body = { ok: true };
  return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
}

const timer = { interval: function () { return function () {}; }, timeout: function () { return function () {}; } };
const doc = { addEventListener: function () {}, removeEventListener: function () {}, createElement: function (t) { return { tagName: t, click: function () {} }; }, body: { appendChild: function () {}, removeChild: function () {} } };

function verbCalls(verb) { return calls.filter(function (c) { return c.indexOf(verb) >= 0; }); }
function postedBodies(verb) {
  return calls.map(function (c, i) { return c.indexOf(verb) >= 0 ? bodies[i] : null; })
    .filter(Boolean).map(function (b) { try { return JSON.parse(b); } catch (e) { return {}; } });
}
// The ids the panel asked to play, read from the path it posted (see the play_job branch above).
function postedJobs() {
  return calls.filter(function (c) { return c.indexOf('~play_job') >= 0; })
    .map(function (c) { return (c.match(/play_job\/([^/?]+)/) || [])[1] || ''; });
}

(async function main() {
  // U-18 needs a media element that behaves: the transport's pause button acts on THIS object, so the suite
  // has to be able to see whether the file really paused. The default shim hands back { tagName } only.
  const audio = {
    tagName: 'audio', paused: true, ended: false, currentTime: 0, duration: 30, readyState: 0,
    pauseCalls: 0, playCalls: 0, _l: {},
    addEventListener: function (n, f) { (this._l[n] = this._l[n] || []).push(f); },
    removeEventListener: function () {},
    fire: function (n) { (this._l[n] || []).forEach(function (f) { f(); }); },
    pause: function () { this.paused = true; this.pauseCalls++; this.fire('pause'); },
    play: function () { this.paused = false; this.ended = false; this.playCalls++; this.fire('play'); return Promise.resolve(); },
  };
  const shim = createRuntime({ makeHostNode: function (n) { return n.type === 'audio' ? audio : { tagName: n.type }; } });
  const client = loadClient(shim, { target: TARGET, fetch: host, timer: timer, document: doc });
  const comp = client.apply();
  if (!comp) throw new Error('panel did not register');
  // The shim keeps one entry per element per RENDER, so a plain filter counts the same row once for
  // every render since the panel mounted. Every lookup below therefore works on the elements created
  // by the LAST commit, which is what a person is actually looking at.
  let mark = 0;
  function commit() { const b = {}; const start = shim.rt.created.length; shim.render(comp(), b); shim.runEffects(); mark = start; return b; }
  function created() { return shim.rt.created.slice(mark); }

  let bag = commit(); await flush();
  await openAllSections(shim, comp);
  bag = commit(); await flush(); bag = commit(); await flush();

  function els(cls) { return created().filter(function (e) { return e.props && hasCls(e.props.className, cls); }); }
  function hasCls(c, want) { return String(c || '').split(/\s+/).indexOf(want) >= 0; }
  function ownText(e) { var c = e.props && e.props.children; return (typeof c === 'string') ? c : ''; }
  function btnByTitle(re) {
    const all = created().filter(function (e) { return e.type === 'button' && re.test(String(e.props && e.props.title)); });
    return all.length ? all[all.length - 1] : null;
  }
  function btn(label) {
    const all = created().filter(function (e) { return e.type === 'button' && e.props.children === label; });
    return all.length ? all[all.length - 1] : null;
  }
  function click(label) { const b = btn(label); if (b && typeof b.props.onClick === 'function') { b.props.onClick(); return true; } return false; }
  // T-316 CONTRACT MIGRATION (user ruling 2026-10-14): the six media controls are DRAWN as inline SVG, so the
  // glyph TEXT is no longer an identifier — it does not exist any more. Every lookup in this suite moved onto
  // the stable class each transport button carries (`audio-play-tp-<verb>`, plus `audio-play-tp-mini312` on the
  // closed panel's row). The facts pinned are the same buttons, verbs, hovers, order and geometry as before;
  // only the way they are found changed, which is exactly the migration the ruling priced before it was bought.
  const TP_WORDS316 = ['prev', 'play', 'pause', 'stop', 'next', 'eject'];
  function btnTp(which) {
    const all = created().filter(function (e) { return e.type === 'button' && hasCls(e.props && e.props.className, 'audio-play-tp-' + which); });
    return all.length ? all[all.length - 1] : null;
  }
  function clickTp(which) { const b = btnTp(which); if (b && typeof b.props.onClick === 'function') { b.props.onClick(); return true; } return false; }
  function glyph316(which) {
    const all = created().filter(function (e) { return e.type === 'svg' && hasCls(e.props && e.props.className, 'audio-play-tp-glyph316-' + which); });
    return all.length ? all[all.length - 1] : null;
  }
  function labelOf316(e) {
    const c = String((e.props && e.props.className) || '');
    const hit = TP_WORDS316.filter(function (w) { return hasCls(c, 'audio-play-tp-' + w); });
    return hit.length ? hit[0] : ownText(e);
  }

  // 1. the transport row exists, in the order the user asked for, and the mic button replaced Dictate.
  // T-300 CONTRACT CHANGE (user 2026-10-12, 19:25): "also, i changed my mind about the rec button - make it
  // replace the 'shuffle' button in the winamp screen and place it on the right side of the other buttons in
  // bottom line of player". That supersedes the 18:47 wording ("move Rec to be outer left button (Rec, Prev,
  // Play...)"): record is the LAST button of the bottom row now, where Winamp has SHUFFLE, and the eject keeps
  // Winamp's own place just before it. The eject sits INSIDE the transport group, so it is part of this order
  // instead of being checked as a control that hung off the far right of the strip.
  // T-300 CONTRACT CHANGE (user 2026-10-12, 19:31): "stop and next button order should be inverted to match
  // winamp order". Winamp 2 classic's row is prev, play, pause, STOP, next - the CBUTTONS.BMP sprite order
  // and the main-window.css left values 16, 39, 62, 85, 108 agree on it - so the stop glyph now comes
  // fourth and next fifth. The 19:25 wording about record stays in force: record is the last button.
  // T-316 MIGRATION: the same order, read off the classes now that the six controls have no glyph text.
  const glyphs = ['prev', 'play', 'pause', 'stop', 'next', 'eject', '\u25CF Mic'];
  const btnLabels = created().filter(function (e) { return e.type === 'button'; }).map(labelOf316);
  let at = -1, inOrder = true;
  for (const g of glyphs) { const ix = btnLabels.indexOf(g, at + 1); if (ix < 0) { inOrder = false; break; } at = ix; }
  check('T-300 U-16 CONTRACT CHANGE: the bottom row is prev, play, pause, STOP, next, eject, record (stop and next swapped to match Winamp, record still last)',
    inOrder && els('audio-play-transport').length === 1, [btnLabels, els('audio-play-transport').length]);
  // T-316 (user ruling 2026-10-14): the six are DRAWN. Each transport button carries an inline svg with a
  // filled path on a shared 16x16 grid, and none of them carries a Unicode character any more — which is the
  // whole point: size and optical centre come from geometry, not from whatever font the browser picks.
  const t316Drawn = TP_WORDS316.map(function (w) {
    const b = btnTp(w);
    const g = glyph316(w);
    const path = g ? (shim.rt.created.filter(function (e) { return e.type === 'path' && e.props && typeof e.props.d === 'string'; }).length && g) : null;
    return { word: w, button: !!b, svg: !!g, hasPath: !!path, textGlyph: b ? (typeof b.props.children === 'string') : false };
  });
  check('T-316 CONTRACT CHANGE: all six media controls are drawn as inline SVG with a filled path, and no transport button is a text glyph any more',
    t316Drawn.every(function (x) { return x.button && x.svg && x.hasPath && !x.textGlyph; }),
    t316Drawn.map(function (x) { return x.word + ':' + (x.button ? 'btn' : '-') + (x.svg ? '+svg' : '-svg') + (x.hasPath ? '+path' : '-path') + (x.textGlyph ? '+TEXT' : ''); }));
  const t316Svg = glyph316('play');
  check('T-316: the drawn glyph sizes itself from its box (0.62 of the button height, never smaller than 10px) and takes the button colour as its ink',
    !!t316Svg && /^\d+$/.test(String(t316Svg.props.width)) && t316Svg.props.viewBox === '0 0 16 16'
      && Number(t316Svg.props.width) >= 10 && t316Svg.props['aria-hidden'] === 'true',
    t316Svg && [t316Svg.props.width, t316Svg.props.viewBox]);
  check('U-2: no button is labelled Dictate any more (the record button replaced it)',
    !btn('Dictate'), created().filter(function (e) { return e.type === 'button'; }).map(ownText));
  // T-305 (user 2026-10-13, 03:17): "the timing display should be integrated at the top into the visualizer
  // canvas (like winamp - in a 'dot matrix display style')". The clock is no longer a DOM element at all, so
  // the old assertion that a span reads "--:-- / --:--" cannot be kept by re-naming it: what is pinned now is
  // that no such element exists ANYWHERE, and that the strip is tall enough to carry the digits it paints.
  // Unknown is still not 0:00 - the band paints the dashes, and the source keeps that as its initial value.
  const clocks = els('audio-play-clock');
  // The strip starts at "off" in this suite (no mode is persisted). T-307 (user 2026-10-13, 05:44) changed what "off"
  // is: the canvas is mounted and painted, so the timing display survives and the strip stays clickable. T-334 (user
  // 2026-10-13, 15:2x) then ruled "if disabled, canvas should keep size", so off no longer shortens the strip: the
  // reserved height is 80 + the 2px border = 82 in EVERY mode, off included. The clock is still not a DOM element.
  const strip305 = els('audio-play-scope');
  check('T-305 + T-307 + T-334 CONTRACT CHANGE: the clock is not a DOM element any more - no element in the panel '
      + 'prints the dashes - and the display block reserves 82px because the strip keeps its size while off',
    clocks.length === 0 && !created().some(function (e) { return ownText(e) === '--:-- / --:--'; })
      && strip305.length === 1 && strip305[0].props.style.minHeight === '82px',
    [clocks.length, strip305.map(function (e) { return strip305[0].props.style.minHeight; })]);

  // 2. T-300 CONTRACT CHANGE (user feedback 2026-10-12, 18:47): "what is the 'OUT' text in header ->
  // remove" and "we only need one status display in header -> combine into one status showing ALARMS
  // aswell". The OUT chip and the TTS/STT light pair are GONE from the header; the single status readout
  // carries their information. This is not a deleted assertion: it now pins that the removed parts render
  // NOWHERE and that the one readout that replaced them exists and prints no path.
  const readouts = els('audio-play-now');
  check('T-300: the OUT chip and the TTS/STT light pair render nowhere in the header',
    els('audio-play-head-out').length === 0 && els('audio-play-head-ep').length === 0
      && !created().some(function (e) { return ownText(e) === 'OUT'; }),
    [els('audio-play-head-out').length, els('audio-play-head-ep').length]);
  check('T-300: the header prints ONE status readout and it prints no output path',
    readouts.length === 1 && !/\/mnt\//.test(ownText(readouts[0])), ownText(readouts[0]));

  // 2b. one play button, not two (user: "our play window now has two play buttons - the winamp styled
  // one and the pre-existing one"). The native strip is off and the panel drives position and volume.
  const audioEls = created().filter(function (e) { return e.type === 'audio'; });
  // T-405 (user 2026-10-15): the panel now holds TWO media elements — the take's and the station's — because a
  // station that stays audible under a take cannot share one src with it. The rule this check carries is
  // unchanged and is now asserted over both: neither one shows a native control strip, so the transport row is
  // still the only play control a person sees, and the station's own controls are the panel's own buttons.
  // T-603 RE-POINT (2026-10-27): the panel holds THREE media elements now — take, station, and the second take
  // element that carries a crossfade tail — and the rule is unchanged over all three: none of them carries a
  // native control strip. The count moved because a card asked for both sides of a handover to move at once;
  // the rule this check guards is the one that did not.
  check('T-300 through T-603: every media element the panel holds has its native strip off, so the transport row is the only play control',
    audioEls.length === 3 && audioEls.every(function (e) { return e.props.controls === false; }),
    [audioEls.length, audioEls.map(function (e) { return e.props.controls; })]);
  check('T-300: the panel carries its own seek bar and volume slider in the same strip',
    els('audio-play-seek').length === 1 && els('audio-play-vol').length === 1,
    [els('audio-play-seek').length, els('audio-play-vol').length]);
  const seekEl = created().filter(function (e) { return e.props && e.props.className === 'audio-play-seek'; })[0];
  const volEl = created().filter(function (e) { return e.props && e.props.className === 'audio-play-vol'; })[0];
  check('T-300: the seek bar is disabled while no file is loaded (it cannot pretend to seek nothing)',
    !!seekEl && seekEl.props.disabled === true && !!volEl && volEl.props.disabled === undefined,
    [seekEl && seekEl.props.disabled, volEl && volEl.props.disabled]);

  // 2c. "buttons should have same size" (18:47) still holds. What changed is WHICH box: the user asked for
  // squares (19:31) and then refined it (20:05) to "keep dynamic size: with a fixed xy-ratio and a minimum
  // size so if window is resized horizontally, the buttons adjust up to a max size - so the ratios are kept".
  // T-300 CONTRACT CHANGE: the box is no longer the constant 44x22 - it is derived from the panel width with
  // Winamp 2 classic's own ratio (23:18 = 1.2778), clamped to 36..46px wide. In this suite no panel size is
  // persisted, so the panel is its 484px default and the formula maps that to 40x31. The height is now an
  // explicit property; before this change no height existed at all and the box inherited 22px from the 16px
  // line box, which is exactly why it was 44x22.
  const tbtns = created().filter(function (e) {
    return e.type === 'button' && e.props && e.props.style && e.props.style.width === '40px'
      && e.props.style.height === '31px' && e.props.style.boxSizing === 'border-box'
      && e.props.style.textAlign === 'center';
  });
  // T-305 (user 2026-10-13, 03:17): "the rec button can be a little wider and less tall to mimic the winamp
  // 'shuffle button' in the bottom line". Six of the seven keep the derived 40x31 box; the record button was
  // the row's ONE deliberate exception - 1.4x as wide and 0.72 as tall (56x22). T-316 (same day, with the
  // reference strip) put the height back to the row's own: the exception is now WIDTH ONLY. The filter below
  // still finds six, because the record box is 56px wide and cannot satisfy a 40px width test.
  // T-508 RE-POINT (2026-10-16): the count went from six to SEVEN. The new `i` button was built with the row's
  // own geometry object (`Object.assign({}, btnStyle, TBTN300)`), which is exactly how "same center height as the
  // play buttons" is honoured — by construction, not by a second set of numbers — so it joins the shared set
  // rather than becoming a second exception. The record button is still the row's ONE deliberate exception, and
  // the filter that finds these buttons still cannot find the record (its 56 px width fails the 40 px test).
  check('T-300 U-16 CONTRACT CHANGE, T-305 + T-316 amendments, T-508 amendment: seven transport buttons share the '
      + 'derived 40x31 box (ratio 23:18) and the record button is the only exception - wider, and the same height',
    tbtns.length === 7, tbtns.length);
  // T-307 (user 2026-10-13, 05:15): "play button icons still too small". The boxes were already what the
  // reference ratio derives; what was small was the glyph inside them, still the panel's shared 11px button
  // font. 20px fills a 31px box at the default panel and still clears the 27px box the row shrinks to at the
  // narrowest panel the transport can be drawn at.
  check('T-307 CONTRACT CHANGE (twice in one day): the transport glyph went 11 -> 20 -> 16px, and its line box '
      + 'is now the font itself (lineHeight 1), inside the same boxes',
    tbtns.length === 7 && tbtns.every(function (e) {
      return e.props.style.fontSize === '16px' && e.props.style.lineHeight === '1';
    }), tbtns.map(function (e) { return [e.props.style.fontSize, e.props.style.lineHeight]; }));
  // The centring the user saw as wrong was a 20px line box inside a 31px box: the flex centring centred the LINE
  // box, and a glyph's ink is not symmetric inside its line box, so the ink landed off-centre. With lineHeight:1
  // the box being centred IS the glyph's box.
  check('T-307: the glyph is centred by the box it is drawn in - flex centring on both axes, padding 0, and no '
      + 'line box taller than the glyph',
    tbtns.every(function (e) {
      const st = e.props.style;
      return st.display === 'inline-flex' && st.alignItems === 'center' && st.justifyContent === 'center'
        && st.padding === '0' && st.textAlign === 'center';
    }), tbtns.map(function (e) { return [e.props.style.display, e.props.style.alignItems, e.props.style.justifyContent]; }));
  // "add a few more pixel distance between play buttons and 'Playlist'" - the player block's bottom margin is
  // the space between the transport row and the first section header below it. 2px became 10px.
  const playerBlk307 = els('audio-play-player');
  check('T-307: the transport row sits 10px above the first section header instead of 2px',
    playerBlk307.length === 1 && playerBlk307[0].props.style.margin === '6px 0 10px',
    playerBlk307.map(function (e) { return e.props.style.margin; }));
  // T-307 (user 2026-10-13, 06:02): "the round slider knobs need squares, winamp style". A range input's knob
  // is a pseudo-element, and an inline style cannot reach a pseudo-element, so the panel ships a stylesheet
  // instead - mounted once, scoped to this window's own class name, and it has to say the two things that make
  // a square knob possible at all: take the native slider away, and give the thumb no radius.
  const cssNodes = created().filter(function (e) { return e.type === 'style'; });
  check('T-307: the panel mounts exactly ONE stylesheet, as its first child, scoped to .audio-play-panel',
    cssNodes.length === 1, cssNodes.length);
  const cssTxt = cssNodes.length ? String((cssNodes[0].props.children || '')) : '';
  // RE-POINTED IN PLACE 2026-10-21 (T-627 run): this pin measured NINE prefixes when it was written, and the count
  // it asserts is the rule count itself, not a floor. T-594 (built 2026-10-21) added the speed slider's own track
  // rules to the same stylesheet - two more panel-scoped prefixes - so the honest measure today is ELEVEN. The
  // number this file pins is the measure, not the memory: what has to stay true is that the count of scoped
  // prefixes equals the count of rules, i.e. unsafescoped stays empty, which is checked on the next lines.
  const scoped = (cssTxt.match(/\.audio-play-panel/g) || []).length;
  const unsafescoped = (cssTxt.match(/(^|\})\s*[^{}]*\{/g) || []).filter(function (m) {
    return m.indexOf('.audio-play-panel') < 0;
  });
  check('T-307: every rule in that stylesheet is scoped to the panel - it cannot restyle the harness or any '
      + 'other window',
    cssTxt.length > 200 && scoped === 11 && unsafescoped.length === 0, [scoped, unsafescoped]);
  check('T-307: the sliders get a SQUARE Winamp-style plate - appearance taken away, no border-radius on the '
      + 'thumb, for both engines, and it reaches all three sliders this panel has',
    /appearance:none/.test(cssTxt) && /-webkit-appearance:none/.test(cssTxt)
      && /::-webkit-slider-thumb\{[^}]*border-radius:0/.test(cssTxt)
      && /::-moz-range-thumb\{[^}]*border-radius:0/.test(cssTxt)
      && /::-webkit-slider-runnable-track/.test(cssTxt) && /::-moz-range-track/.test(cssTxt),
    [cssTxt.indexOf('::-webkit-slider-thumb'), cssTxt.indexOf('::-moz-range-thumb')]);
  // T-307 (user 2026-10-13, 06:20): "the position-slider needs a wider knob". The seek bar is the widest groove
  // this panel has and the only control whose whole job is a POSITION, so its plate is 20 px wide - wider than it
  // is tall, which is how a seek handle reads - while volume and transparency keep the 12 px plate. One family of
  // knobs, two widths: same height, same square corners, same face and edge.
  check('T-307: the seek plate is 20px on both engines and the generic plate stays 12px - the seek rule comes '
      + 'after the generic one, which is what lets it win',
    /::-webkit-slider-thumb\{[^}]*width:12px/.test(cssTxt)
      && /\.audio-play-seek::-webkit-slider-thumb\{width:20px;\}/.test(cssTxt)
      && /\.audio-play-seek::-moz-range-thumb\{width:20px;\}/.test(cssTxt)
      && cssTxt.indexOf('.audio-play-seek::-webkit-slider-thumb') > cssTxt.indexOf('::-webkit-slider-thumb{'),
    [cssTxt.indexOf('.audio-play-seek::-webkit-slider-thumb'), cssTxt.indexOf('::-webkit-slider-thumb{')]);
  const recBtn305 = btn('\u25CF Mic');
  const readBtn387 = created().filter(function (e) { return e.props && hasCls(e.props.className, 'audio-play-tp-read387'); })[0];
  check('T-387 CONTRACT CHANGE, overruling the height half of T-316: the record and the read control are 56px wide and two-thirds the height of the glyph cluster (56x20 beside 40x31 at the 484px default panel), and the two share one box',
    // T-316 made Rec the SAME height as the transport boxes because the reference row is uniform. The user has now
    // asked for the opposite on purpose: "make the rec and read buttons 66% in height of play buttons, keep length,
    // same length for both". The width factor 1.4 is untouched; the height factor moved 1.0 -> 0.66, and the read
    // control is handed the record button's own geometry object, so the two cannot drift apart.
    !!recBtn305 && recBtn305.props.style.width === '56px' && recBtn305.props.style.height === '20px'
      && recBtn305.props.style.boxSizing === 'border-box' && recBtn305.props.style.textAlign === 'center'
      && recBtn305.props.style.width !== tbtns[0].props.style.width
      && recBtn305.props.style.height !== tbtns[0].props.style.height
      && Number(String(recBtn305.props.style.height).replace('px', '')) === Math.round(Number(String(tbtns[0].props.style.height).replace('px', '')) * 0.66)
      && !!readBtn387 && readBtn387.props.style.width === recBtn305.props.style.width
      && readBtn387.props.style.height === recBtn305.props.style.height,
    recBtn305 && readBtn387 && [recBtn305.props.style.width, recBtn305.props.style.height,
      readBtn387.props.style.width, readBtn387.props.style.height,
      tbtns.map(function (e) { return e.props.style.height; })]);
  // "we should have a horizontal space between next and eject, aswell as between eject and rec" (19:31).
  // Those two gaps are a margin on the button that STARTS the gap - eject, then record - and on nothing
  // else: a spacer element would add children to the row, and a margin on the transport cluster would move
  // the whole cluster instead of opening one gap inside it.
  const gapBtns = created().filter(function (e) {
    return e.type === 'button' && e.props && e.props.style && typeof e.props.style.marginLeft === 'string'
      && e.props.style.marginLeft !== '0px';
  });
  // T-387 (user 2026-10-14): the read control sits "behind the REC button", and in this row a gap IS what "behind"
  // looks like, so it carries the same spacer the eject and the record carry. The rule is still that NOTHING ELSE in
  // the row has a left margin — the count went from two to three because a control was added, not because the rule
  // loosened.
  // T-508 RE-POINT (2026-10-16): four buttons now carry a left margin, and the count is stated in two kinds
  // because the two margins mean two different things. Three carry the 9 px SPACER the user asked for on 2026-10-12
  // ("a horizontal space between 'next' and 'eject' … aswell as between 'eject' and 'rec'"), and the read control
  // behind the record carries the same spacer (T-387). The fourth is the `i` button, whose margin is `auto`: it is
  // not a gap, it is the right-edge rule the request named ("same distance to right border (fixed to right side)"),
  // and it spends the slack the row has instead of leaving the button beside the read control. No other button in
  // the row has a left margin, which is the part of the original rule that still has to hold.
  check('T-300 U-16 + T-387 + T-508: three buttons carry the 9 px horizontal gap - the eject, the record and the read control behind the record - and the only other left margin in the row is the info button\'s `auto`, which is the right-edge rule and not a gap',
    gapBtns.length === 4 && hasCls(gapBtns[0].props.className, 'audio-play-tp-eject')
      && String(gapBtns[1].props.children) === '\u25CF Mic'
      && hasCls(gapBtns[2].props.className, 'audio-play-tp-read387')
      && hasCls(gapBtns[3].props.className, 'audio-play-tp-info508')
      && gapBtns[3].props.style.marginLeft === 'auto'
      && gapBtns.slice(0, 3).every(function (e) { return /px$/.test(String(e.props.style.marginLeft)); }),
    gapBtns.map(function (e) { return [labelOf316(e), e.props.style.marginLeft]; }));

  // T-508 BUG FIX 2026-10-17 (user, with a screenshot): "the info button is too low". It was too low, and every
  // T-508 pin above passed anyway, because all of them ask about the button's OWN box, its OWN margin and its OWN
  // hover — and a control can be correct in all three while living in the wrong element. That is exactly what had
  // happened: the read button's closing line carried one parenthesis too many, which closed the
  // `audio-play-transport` span there, so the `i` became a child of the player COLUMN. A column gives its children
  // their own line — that is the "too low" the user saw — while `marginLeft: "auto"` in a column still pushed the
  // button to the right edge, which is why it looked correct horizontally and wrong vertically. These two checks
  // are the parentage, and they are the part of the request that had no pin: "in bottom row … same center height as
  // the play buttons" is a statement about which element the button belongs to.
  function descendants508(node508, out508) {
    var kids508 = node508 && node508.props && node508.props.children;
    if (kids508 == null) return out508;
    [].concat(kids508).forEach(function (k508) {
      if (!k508 || typeof k508 !== 'object' || !k508.props) return;
      out508.push(k508);
      descendants508(k508, out508);
    });
    return out508;
  }
  const row508 = els('audio-play-transport').slice(-1)[0];
  const inRow508 = descendants508(row508, []).filter(function (e508) {
    return e508.type === 'button' && hasCls(e508.props.className, 'audio-play-tp-info508');
  });
  const col508 = els('audio-play-player').slice(-1)[0];
  const direct508 = [].concat((col508 && col508.props.children) || []).filter(function (e508) {
    return e508 && e508.props && hasCls(e508.props.className, 'audio-play-tp-info508');
  });
  check('T-508 (the bug the user reported with a screenshot): the info button is a child of the transport ROW and '
      + 'NOT a child of the player column, so it rides the same line as the play buttons instead of getting its own '
      + 'line under them',
    !!row508 && !!col508 && inRow508.length === 1 && direct508.length === 0,
    [!!row508, inRow508.length, direct508.length]);
  // The row is the one place the auto margin can do what the request asked. In a column `auto` means "push to the
  // right edge on a line of its own"; in a row that spans the panel it means "spend the slack to the right", which
  // is the right-edge rule with the play buttons' center height. The count of the row's own children is pinned
  // because the fix moved a control INTO this row: prev, play, pause, stop, next, eject, Mic, read, info.
  const rowKids508 = descendants508(row508, []).filter(function (e508) { return e508.type === 'button'; });
  check('T-508 re-point (2026-10-17): the transport row holds NINE buttons — the five transport glyphs, the eject, '
      + 'Mic, read and the info button — and the info button is the row\'s LAST child, which is Winamp\'s own place '
      + 'for it',
    rowKids508.length === 9 && hasCls(rowKids508[rowKids508.length - 1].props.className, 'audio-play-tp-info508'),
    rowKids508.map(function (e508) { return labelOf316(e508); }));

  // 2d. the eject replaced the "Speak last" text button (user: "make it the 'eject button' as the 'right
  // side button' - with hover overlay 'speak last Session message'").
  // T-385 / item 8 (user ruling 2026-10-14) moved the speaking job again, to the read button behind REC, and gave the
  // eject its import job. The original point of this check survives — there is no button LABELLED "Speak last" — and
  // the hover it pins is now the one that actually carries the action.
  check('T-300 as re-pointed by T-385: no button is labelled Speak last, the read button behind REC carries the speaking action, and the eject carries its import hover',
    !btn('Speak last') && !btnByTitle(/^speak last Session message/) && !!btnTp('eject')
      && /^import /.test(String(btnTp('eject').props.title || ''))
      && !!btnByTitle(/speak the last agent message/),
    [btn('Speak last'), btnTp('eject') && String(btnTp('eject').props.title || '').slice(0, 30)]);

  // 3. playlist rows carry the Winamp columns: a first column, a name, a time. T-306 (user 2026-10-13,
  // 04:31): "it would be better to use first column to show the actual global job markers ap-0001" - the
  // ordinal told you nothing you could act on, and cancel / retry / the Log all go by the job id.
  const nums = els('audio-play-row-id').map(ownText);
  const times = els('audio-play-row-time').map(ownText);
  check('T-306 CONTRACT CHANGE: the first column is the job marker (ap-1001 ... ap-1004), not an ordinal',
    nums.join(' ') === 'ap-1001 ap-1002 ap-1003 ap-1004', nums);
  check('T-306: the ordinal is not lost, it moved to the hover - prev / next walk that same order',
    /position 1 of 4/.test(String(els('audio-play-row-id')[0].props.title)), els('audio-play-row-id')[0].props.title);
  check('T-306: no row prints a bare ordinal any more, and no element carries the old number class',
    els('audio-play-row-num').length === 0 && !els('audio-play-row-id').some(function (e) { return /^\d+\.$/.test(ownText(e)); }),
    els('audio-play-row-id').map(ownText));
  check('U-3: the time column shows the engine-reported length in m:ss (0:13, 0:04, 3:35, --:--)',
    times.join(' ') === '0:13 0:04 3:35 --:--', times);

  // 4. U-18 (user 2026-10-13 01:39): "currently the pause button in the winamp style play controls does not
  // pause the current playback, but instead pauses the 'generation' of the tasks (pauses the playlist) ... the
  // 'player buttons' should control current playback, (prev,play,pause,stop,next)". The transport row now
  // pauses the FILE. The lane-queue control did not disappear - it lives on its own lane row (checked below).
  // A file is playing when the button is pressed. The panel mirrors the element through its own events, so
  // the suite says "it started" the way a browser does - a play event - rather than editing a private state.
  audio.src = '/deepamp/ap-9001.wav'; audio.currentSrc = '/deepamp/ap-9001.wav';
  audio.readyState = 4;                       // HAVE_ENOUGH_DATA: the file the test is about to pause is loaded
  audio.paused = false; audio.ended = false; audio.fire('play');
  bag = commit(); await flush();
  const pauseBtn0 = btnTp('pause');
  check('U-18: the pause button speaks about the file, not about the lane',
    !!pauseBtn0 && /pause the file the browser is playing/.test(String(pauseBtn0.props.title)),
    pauseBtn0 && pauseBtn0.props.title);
  check('U-18: pressing pause posts NO verb at all (a browser pause is not a lane call)', clickTp('pause'));
  await flush();
  check('U-18: no pause_fn and no resume_fn were sent on the way',
    verbCalls('~pause_fn').length === 0 && verbCalls('~resume_fn').length === 0, calls.join(' | '));
  check('U-18: the media element really paused', audio.paused === true && audio.pauseCalls === 1,
    [audio.paused, audio.pauseCalls]);
  bag = commit(); await flush();
  const pauseBtn1 = btnTp('pause');
  // T-305 (user 2026-10-13, 03:17): "the 'yellow pause highlight' -> not wanted, pause is a normal button, no
  // need to highlight". The button is drawn EXACTLY like its neighbour in both states - the state it carries is
  // in its hover, and the file's own state is drawn in the display block as the transport mark beside the
  // clock digits. The assertion is now that no amber appears, by comparing it with the play button next to it.
  const playBtn305 = btnTp('play');
  check('T-305 CONTRACT CHANGE: pause still reads as a resume in its hover, but it is NOT painted as held - '
      + 'it is the same box as the play button beside it and no amber appears on it',
    /the file is PAUSED/.test(String(pauseBtn1 && pauseBtn1.props.title))
      && !!pauseBtn1 && !!playBtn305
      && pauseBtn1.props.style.background === playBtn305.props.style.background
      && pauseBtn1.props.style.borderColor === playBtn305.props.style.borderColor
      && pauseBtn1.props.style.color === playBtn305.props.style.color
      && pauseBtn1.props.style.background !== '#d29922',
    [pauseBtn1 && pauseBtn1.props.title, pauseBtn1 && pauseBtn1.props.style && pauseBtn1.props.style.background]);
  check('U-18: pressing it again resumes the file, still with no verb', clickTp('pause'));
  await flush();
  check('U-18: the element is playing again and the lane was never asked to pause',
    audio.paused === false && audio.playCalls === 1 && verbCalls('~pause_fn').length === 0,
    [audio.paused, audio.playCalls]);
  // A finished file has nothing to resume: the button says what to press instead of pretending.
  audio.paused = true; audio.ended = true; audio.fire('ended');
  bag = commit(); await flush();
  const beforeEnded = calls.length;
  clickTp('pause'); await flush();
  check('U-18: on a finished file the pause button calls nothing and leaves the length alone',
    calls.length === beforeEnded && audio.playCalls === 1, [calls.slice(beforeEnded).join(' '), audio.playCalls]);
  audio.ended = false; audio.paused = false; audio.fire('play');
  bag = commit(); await flush();
  check('U-18: the lane-queue control lives on its own lane row, not on the transport row',
    // T-311 (user 2026-10-13): label pair renamed hold new jobs/let jobs run -> pause/resume to buy width
    // for the single-line lane strip. Exact-text match, so a transport button (glyph children) or any
    // button that merely contains the word cannot satisfy this. The FACT being pinned is unchanged:
    // the lane control is a real button in the panel, and the transport row carries only glyphs.
    created().some(function (e) { return e.type === 'button' && /^(pause|resume)$/.test(String([].concat(e.props.children)[0])); }),
    created().filter(function (e) { return e.type === 'button'; }).map(function (e) { return String(e.props.children); }).join(' '));
  check('U-2: the next button is clickable', clickTp('next'));
  await flush(); bag = commit(); await flush(); await flush(); bag = commit(); await flush();
  const played = postedJobs();
  check('U-3: next stepped over ap-1003 (the lane refused it) and played ap-1001 instead',
    played.join(',') === 'ap-1003,ap-1001', [played, calls.slice(-6), shim.rt.created.map(ownText).filter(function (t) { return /playlist|playable|stepped/.test(t); })]);
  check('U-3: a transcript row is never played (there is no audio in an STT row)',
    played.indexOf('ap-1002') < 0, played);
  const deadRow = created().filter(function (e) { return /NOT PLAYABLE/.test(String(e.props && e.props.title)); });
  check('U-3: the refused row says so in its own hover text instead of failing silently on the next click',
    deadRow.length >= 1 && /file not found/.test(String(deadRow[0].props.title)), deadRow.length);
  const deadTimes2 = els('audio-play-row-time').map(ownText);
  // What --:-- means is "nothing was ever reported". A row that DID render 215.6 s keeps that number
  // even after its file is gone — erasing a measured length to make a dead row look tidier would be
  // the panel lying about its own history. What changes on a dead row is the tooltip and the grey.
  const deadTimeEl = els('audio-play-row-time')[2];
  check('U-3: the dead row keeps its reported length and says it is not playable any more',
    ownText(deadTimeEl) === '3:35' && /not playable any more/.test(String(deadTimeEl.props.title)),
    [ownText(deadTimeEl), deadTimeEl && deadTimeEl.props.title]);
  const noLen = els('audio-play-row-time')[3];
  check('U-3: a row that never produced audio shows --:-- and not 0:00 (there was no take, not an empty one)',
    ownText(noLen) === '--:--' && /no audio length reported/.test(String(noLen.props.title)),
    [ownText(noLen), noLen && noLen.props.title]);
  const deadNums = els('audio-play-row-id').map(ownText);
  check('U-3: the dead row keeps its marker and its place in the list (a skipped row is not a deleted row)',
    deadNums.join(' ') === 'ap-1001 ap-1002 ap-1003 ap-1004', deadNums);

  // 6. prev walks backwards over the same order, and never re-enters the dead row.
  clickTp('prev'); await flush(); bag = commit(); await flush(); await flush(); bag = commit(); await flush();
  const played2 = postedJobs();
  check('U-3: prev walked back onto the playable row and did not offer the dead row again',
    played2[played2.length - 1] === 'ap-1001' && played2.filter(function (x) { return x === 'ap-1003'; }).length === 1,
    played2);

  // 7. play replays the row the transport is on; stop stops playback without touching a lane job.
  // The transport's own play button, picked by its tooltip: a row play button carries the same glyph,
  // and clicking one of those would test the row instead of the transport.
  const playBtn = btnByTitle(/play the row the transport is on/);
  if (playBtn) playBtn.props.onClick();
  await flush(); bag = commit(); await flush();
  const played3 = postedJobs();
  check('U-2: play posts play_job for the row the transport is standing on',
    played3[played3.length - 1] === 'ap-1001', played3[played3.length - 1]);
  const stopBefore = calls.length;
  clickTp('stop'); await flush(); bag = commit(); await flush();
  const newCalls = calls.slice(stopBefore);
  check('U-2: stop posts NO verb (it stops this playback and the waiting list of the panel itself; a lane job is cancelled by that row, not here)',
    newCalls.filter(function (c) { return /cancel|stop|pause_fn|play_job/.test(c); }).length === 0, newCalls);
  const logText = shim.rt.created.map(ownText).join('\n');
  check('U-2: stop reports what it did and what it did NOT do',
    /playback stopped/.test(logText) && /job the lane is running is untouched/.test(logText));

  // T-331 (user 2026-10-13): "in player window: we have the 'engine / voice' display: it should show the data
  // that WAS used for generating the file that is playing". Play a row, then read that line: while a file
  // plays it is the FILE's provenance, taken off the row the route belongs to, and it says so on the hover.
  const t331Before = calls.length;
  clickTp('play'); await flush(); bag = commit(); await flush();
  const t331Tree = shim.rt.created.slice(mark);
  const read331 = t331Tree.filter(function (e) { return /audio-play-lane-read/.test(String((e.props || {}).className || '')); });
  check('T-331: the player carries exactly one engine/voice read-out line', read331.length === 1, read331.length);
  const lr331 = read331[0] || {};
  const lrTxt331 = String(lr331.props && lr331.props.children);
  const halves331 = lrTxt331.split('\u00B7').map(function (s) { return s.trim(); });
  check('T-331: while a file plays the read-out is model and voice of THAT file, not a blob: ' + lrTxt331,
    halves331.length === 2 && halves331[0] === 'm1' && ['voy_janeway', 'voy_doctor'].indexOf(halves331[1]) >= 0);
  check('T-331: the read-out names the row it came from and says the current selection is not this file\'s provenance',
    /what this file was made with: m1/.test(String(lr331.props.title || ''))
    && /row ap-100\d/.test(String(lr331.props.title || ''))
    && /the panel's current selection is not this file's provenance/.test(String(lr331.props.title || '')));
  check("T-331: reading a file's provenance dispatches nothing (it is a read-out, not a request): "
    + JSON.stringify(calls.slice(t331Before).filter(function (c) { return /dispatch|generate|render/.test(c); })),
    calls.slice(t331Before).filter(function (c) { return /dispatch|generate|render/.test(c); }).length === 0);

  // T-387 (user 2026-10-14): the voice dropdown T-331 asked for at the right end of this row is REMOVED — "the drop
  // down for voice selection in the player might be dropped for now" — and the read control takes its place behind the
  // record button, which is where the user asked for it ("it should be in the player, behind the REC button, and
  // should be labeled read"). The selection is not gone from the panel: the read-out line names the model and voice
  // the next dispatch will use, and the Voices section and the model library set it. What the ROW must now show is
  // measured below, and it is measured as an absence plus a presence, not as a relaxed count.
  const sel387 = t331Tree.filter(function (e) { return e.type === 'select' && /audio-play-voice-pick331|audio-play-tp/.test(String((e.props || {}).className || '')); });
  check('T-387: the voice dropdown is gone from the panel and no select sits in the transport family (the mix-bed and mix-layer selects belong to the mix section and are not this row\'s)',
    sel387.length === 0 && t331Tree.filter(function (e) { return /audio-play-voice-pick331/.test(String((e.props || {}).className || '')); }).length === 0,
    sel387.map(function (e) { return String((e.props || {}).className || e.type); }));
  const read387t = t331Tree.filter(function (e) { return /audio-play-tp-read387/.test(String((e.props || {}).className || '')); });
  check('T-387: the row carries exactly one read control, labelled with a speaker symbol and the word read, and it is clickable',
    read387t.length === 1 && String(read387t[0].props.children) === '\u266A read'
      && typeof read387t[0].props.onClick === 'function' && /speak the last agent message/.test(String(read387t[0].props.title || '')),
    read387t.map(function (e) { return [String(e.props.children), e.props.style.width, e.props.style.height]; }));
  const eject387 = t331Tree.filter(function (e) { return /audio-play-tp-eject/.test(String((e.props || {}).className || '')); });
  const read387c = t331Tree.filter(function (e) { return /audio-play-tp-read387/.test(String((e.props || {}).className || '')); });
  // T-687 (operator's hover pass, 2026-11-01, the operator's answer to the audit's question on this control: "Move it
  // to the import row itself, keep a one-line hover"). This check used to require the eject's hover to point at the
  // read button as well as state its own act. The ruling is a one-line hover that says what THIS press does. The
  // speaking job is still stated by the control that performs it — the read button's own hover, asserted below and
  // unchanged — which is where a person looking for speech is, not where they are while deciding whether to import.
  check('T-385 CONTRACT CHANGE (item 8 ruling): the eject no longer speaks — it imports. Its hover says what it does and nothing else (T-687, 2026-11-01); the read button behind REC is the control that speaks the last agent message',
    eject387.length === 1 && typeof (eject387[0].props || {}).onClick === 'function'
      && /^import /.test(String((eject387[0].props || {}).title || ''))
      && !/read button behind REC/.test(String((eject387[0].props || {}).title || ''))
      && read387c.length === 1 && /speak the last agent message/.test(String((read387c[0].props || {}).title || '')),
    eject387.map(function (e) { return String(e.props.title || '').slice(0, 46); }));
  // The eject's new job, measured as behaviour and not as a caption: pressing it puts the import field on the player.
  const mark385 = shim.rt.created.length;
  if (eject387[0] && typeof eject387[0].props.onClick === 'function') { eject387[0].props.onClick(); }
  await flush(); bag = commit(); await flush();
  const tree385 = shim.rt.created.slice(mark385);
  const imp385 = tree385.filter(function (e) { return /audio-play-import390/.test(String((e.props || {}).className || '')); });
  const impUrl385 = tree385.filter(function (e) { return /audio-play-import-url390/.test(String((e.props || {}).className || '')); });
  const impGo385 = tree385.filter(function (e) { return /audio-play-import-merge646/.test(String((e.props || {}).className || '')); });
  check('T-385: pressing the eject opens the import row on the player — one row, one address field, ONE import control (T-621 item 11, 2026-10-25: the row\'s doors became one import button that decides by what is typed) — and that control states the stream setting it obeys',
    imp385.length === 1 && impUrl385.length === 1 && impGo385.length === 1
      // T-621 item 11 (operator answer 2026-10-25, chosen from the three offered: "The same red line inside the
      // row"): the merged control is NOT greyed when Stream input is off, because one control now covers three acts
      // and the same press may be a capture or a filing that the stream setting has no say over. What the old play
      // control said by being greyed, this one says in its hover, and the refusal is printed in the row in red.
      // The words it states are the panel's own label for the mode (STREAM_MODES390.off prints "disabled"), measured
      // on the hover of an EMPTY field, which is the one hover that always carries the mode sentence.
      && impGo385[0].props.disabled !== true
      && /Stream input is disabled/.test(String(impGo385[0].props.title || '')),
    { row: imp385.length, field: impUrl385.length, merge: impGo385.length, mergeDisabled: impGo385[0] && impGo385[0].props.disabled,
      hover: impGo385[0] ? String(impGo385[0].props.title || '').slice(0, 60) : null });
  // T-621 item 12 (operator ruling 2026-10-25 15:2x Berlin, verbatim): "why do we still have  \"upload\" and
  // \"import\" -> should only be import, -> move upload file button to playlist bottom". Measured as a POSITION in
  // the render, and the measurement only works with the order this fixture's tree is really recorded in: a call to
  // h(...) is compiled inside-out, so the CHILDREN of an element are created BEFORE the element that holds them —
  // measured in this run, the merged import button lands at 66, its own row line at 67, the row container at 68.
  // A control that belongs to the eject row is therefore created before the row container itself; the upload door is
  // created after it, inside the footer that comes later in the section. That difference is what this check measures.
  const cls385 = function (e385) { return String((e385.props || {}).className || ''); };
  const idx385 = function (re385) {
    for (let i385 = 0; i385 < tree385.length; i385++) { if (re385.test(cls385(tree385[i385]))) return i385; }
    return -1;
  };
  const iRow385 = idx385(/^audio-play-import390$/);
  const iLine385 = idx385(/^audio-play-import-line646$/);
  const iMerge385 = idx385(/^audio-play-import-merge646$/);
  const iDoor385 = idx385(/^audio-play-upload-lane646$/);
  const iLane385 = idx385(/^audio-play-lane-chip-row311$/);
  const iTog385 = idx385(/^audio-play-lane-toggle$/);
  const iBtn385 = idx385(/^audio-play-import-file-btn385$/);
  const iPick385 = idx385(/^audio-play-import-file385$/);
  // 2026-10-25 T-646 item 5 re-point: the door left the footer as well and joined the lane-state row, so this
  // proof now reads "inside the lane row", and the wrapper's own name changed with it (…-foot646 -> …-lane646).
  check('T-621 item 12 as re-ruled by T-646 item 5: the eject row holds no upload door any more — the button and its hidden picker are created inside the lane-state row, after the eject row that used to hold them',
    iRow385 >= 0 && iMerge385 >= 0 && iMerge385 < iLine385 && iLine385 < iRow385
    && iBtn385 > iRow385 && iPick385 > iRow385 && iBtn385 < iDoor385 && iPick385 < iDoor385
    && iDoor385 >= 0 && iDoor385 < iLane385,
    { row: iRow385, importLine: iLine385, merge: iMerge385, doorWrapper: iDoor385, laneRow: iLane385, laneToggle: iTog385,
      uploadBtn: iBtn385, hiddenPicker: iPick385 });
  // T-646 item 5 (operator ruling 2026-10-25 ~16:26 Berlin, verbatim): "playlist: the upload file button -> rename
  // to "upload" and join the row with the STT and TTS lane states -> single row". Measured as containment, not as
  // a screenshot: a call to h(...) is compiled inside-out, so children land at LOWER indices than the element that
  // holds them — the door wrapper is created before the lane row that carries it, and the row's own Pause/Resume
  // buttons are created between them. One row, and the upload control is inside it.
  check('T-646 item 5: the upload door is a child of the lane-state row — the wrapper is created inside it, and the row holding it is the same row that carries the TTS and STT chips',
    iDoor385 >= 0 && iLane385 > iDoor385 && iTog385 > iDoor385 && iTog385 < iLane385,
    { doorWrapper: iDoor385, laneToggle: iTog385, laneRow: iLane385 });
  const fb385 = tree385.filter(function (e) { return /audio-play-import-file-btn385/.test(String((e.props || {}).className || '')); });
  // T-385: the file half of the import row is NOT gated by the Stream input setting, and that is a ruling and not an
  // oversight — the setting is about links the browser plays and the plugin never touches; a picked file is the other
  // kind of import, written once and kept, which is what the user's upload ruling asks for. T-621 item 12 moved the
  // door to the end of the Playlist section on 2026-10-25; the ruling it carries did not move with it.
  check('T-385: the file picker is offered while the stream setting is off, because an upload is not a stream (T-621 item 12 moved it out of the eject row; T-646 item 5 moved it into the lane-state row, 2026-10-25)',
    (function () {
      const fb = fb385;
      // T-394 (user 2026-10-15): "rename "file" button to "upload file"". The panel holds two different doors and the
      // word has to say which one this button takes. T-621 item 12 kept the label for the same reason, and T-646
      // item 5 (operator ruling 2026-10-25) shortened it to the word the operator wrote — "rename to "upload"" —
      // because after that ruling this is the only upload door the panel has, so the extra word disambiguates nothing.
      return fb.length === 1 && fb[0].props.disabled !== true && /written ONCE/.test(String(fb[0].props.title || ''))
        && String(fb[0].props.children) === 'upload';   // T-646 item 5 (2026-10-25): the label is the operator's word; it was 'upload file' since T-394
    })(),
    { label: (function () { const f = fb385; return f.length ? String(f[0].props.children) : null; })() });
  // T-621 item 12 (operator ruling 2026-10-25 15:2x Berlin, verbatim): "please make the dropdown and the text field
  // the same height within this area … this way, the generate and import buttons can be same size and textfield and
  // dropdown can be same width". Measured on the props the render produced, not on a screenshot: both lines of the
  // row declare the SAME grid template, the two inputs declare the same box, and the two buttons declare the same
  // box. A pair that shares one object cannot drift, which is the point of the ruling.
  const qmLine385 = tree385.filter(function (e) { return /audio-play-quickmusic602/.test(String((e.props || {}).className || '')); });
  const imLine385 = tree385.filter(function (e) { return /audio-play-import-line646/.test(String((e.props || {}).className || '')); });
  const qmSel385 = tree385.filter(function (e) { return /audio-play-quickmusic-preset602/.test(String((e.props || {}).className || '')); });
  const qmGen385 = tree385.filter(function (e) { return /audio-play-quickmusic-gen602/.test(String((e.props || {}).className || '')); });
  const st385 = function (a385) { return (a385 && a385[0] && a385[0].props && a385[0].props.style) || {}; };
  const sSel385 = st385(qmSel385), sField385 = st385(impUrl385), sGen385 = st385(qmGen385), sMerge385 = st385(impGo385);
  // RE-CUT 2026-11-11 by T-794, with the operator’s words that moved it: “it should be in the
  // Player/Eject-dropdown player ui, - on the left side of the ‘generate’ button, - in form of a toggle button
  // with infinity symbol”. The row’s shared right column is 78px — exactly one button wide — so that position
  // cannot exist on the shared template, and the quick-music line now carries one extra 26px column of its own.
  // What this ruling is about is untouched and is still asserted, in its strongest form: the two lines’ BUTTON
  // columns are the same 78px, so the generate and import buttons are the same size, and the row’s inputs and
  // buttons each still share one box object. The templates are no longer identical because one line carries a
  // control the other does not; the columns that hold the row’s controls are.
  check('T-621 item 12, RE-CUT 2026-11-11 by T-794: the eject row is two grid lines whose BUTTON columns are the same 78px and whose inputs and buttons each share one box; only the quick-music line carries the extra 26px column the auto-generation toggle was asked to sit in',
    qmLine385.length === 1 && imLine385.length === 1
      && st385(qmLine385).display === 'grid' && st385(imLine385).display === 'grid'
      && st385(imLine385).gridTemplateColumns === 'minmax(0,1fr) 78px'
      && st385(qmLine385).gridTemplateColumns === 'minmax(0,1fr) 26px 78px'
      && String(st385(qmLine385).gridTemplateColumns).split(' ').pop() === String(st385(imLine385).gridTemplateColumns).split(' ').pop()
      && sSel385.height === sField385.height && sSel385.padding === sField385.padding
      && sSel385.background === sField385.background && sSel385.border === sField385.border
      && sGen385.height === sMerge385.height && sGen385.padding === sMerge385.padding
      && sGen385.width === sMerge385.width && sGen385.fontSize === sMerge385.fontSize,
    { lineSelect: st385(qmLine385).gridTemplateColumns, lineImport: st385(imLine385).gridTemplateColumns,
      button_column_of_each_line: [String(st385(qmLine385).gridTemplateColumns).split(' ').pop(),
        String(st385(imLine385).gridTemplateColumns).split(' ').pop()],
      select: [sSel385.height, sSel385.padding, sSel385.background], field: [sField385.height, sField385.padding, sField385.background],
      generate: [sGen385.height, sGen385.padding, sGen385.width], merge: [sMerge385.height, sMerge385.padding, sMerge385.width] });
  // T-621 item 12 (operator ruling 2026-10-25 15:2x Berlin, verbatim): "the generate button should have a green
  // highlight … the import button should not have any highlights - default colors". The green is the panel's existing
  // run-button treatment (T-371b), and the plain button is `btnStyle` — so this measures one control against the
  // panel's green and the other against the panel's default, in the same render.
  // RE-RULED 2026-10-27 (T-664, operator ruling 09:1x Berlin: "make only the outer frame of the button green, keep
  // the font white"). The two-colour rule this pin exists to protect is unchanged and the import half of it is
  // untouched; only which property carries the green moved, from the fill to the frame.
  check('T-621 item 12, FRAME re-ruled 2026-10-27: generate wears the panel run-button frame and import wears the default button colours',
    sGen385.borderColor === '#3fb950' && sGen385.color === '#fff' && sMerge385.background === '#22222a' && sMerge385.color === '#eee',
    { generate: [sGen385.borderColor, sGen385.color], import: [sMerge385.background, sMerge385.color] });
  // The refusal is a sentence, not silence (T-387 item 4). With stream input off — the shipped default — a link is
  // refused and the panel says why, in the import row and in the event log.
  const last385 = function (cls, tree) {
    const hit = (tree || shim.rt.created).filter(function (e) { return new RegExp(cls).test(String((e.props || {}).className || '')); });
    return hit.length ? hit[hit.length - 1] : null;
  };
  const press385 = async function (el) { if (el && typeof el.props.onClick === 'function') { el.props.onClick(); } await flush(); bag = commit(); await flush(); };
  const type385 = async function (value) {
    const f = last385('audio-play-import-url390');
    if (f && typeof f.props.onChange === 'function') { f.props.onChange({ target: { value: value } }); }
    await flush(); bag = commit(); await flush();
  };
  const msgText385 = function () { const m385 = last385('audio-play-import-msg390'); return m385 ? String(m385.props.children || '') : ''; };
  // T-621 item 8 (operator ruling 2026-10-25 02:28 Berlin, verbatim: "eject button should be able to close the menu
  // after opening it"): the eject is a TOGGLE now, so a fixture cannot press it blindly — pressing it while the row
  // is open closes the row. A fixture that wants the row open shuts it first, and the eject press that follows is
  // then the opening press. This is the fixture stating the state it wants instead of inheriting one.
  // T-621 item 11 (operator answer 2026-10-25 14:5x Berlin, verbatim: "Remove the ✕"): the row's own cross is gone,
  // so the shut is done WITH THE EJECT, and only when the row is on screen in the current render — which also makes
  // it a no-op for a fixture that never opened the row. The control is taken from the current render, not from
  // `last385`, because the handler a press calls is the one the last render made and it closes over that render.
  const shutImportRow385 = async function () {
    const open385 = created().filter(function (e) { return /audio-play-import-url390/.test(String((e.props || {}).className || '')); });
    if (!open385.length) return;
    const openEject385 = created().filter(function (e) { return /audio-play-tp-eject/.test(String((e.props || {}).className || '')); }).pop();
    await press385(openEject385);
  };

  await press385(impGo385[0]);
  check('T-385 + T-387 item 4: pressing import with nothing typed says so, in the panel, in words, and says plainly that nothing was asked of the plugin',
    /the field is empty/.test(msgText385()) && /Nothing was asked of the plugin/.test(msgText385()), msgText385().slice(0, 70));

  await type385('https://example.org/a.mp3');
  await press385(last385('audio-play-import-merge646'));
  check('T-385: a link while the setting is off is refused OUT LOUD, and the refusal names the setting that would change it',
    /stream input is disabled/.test(msgText385()) && /Settings/.test(msgText385()), msgText385().slice(0, 80));

  const heads385 = shim.rt.created.filter(function (e) {
    return hasCls(e.props && e.props.className, 'audio-play-section-head')
      && JSON.stringify(e.props.children || '').indexOf('"Settings"') >= 0;
  });
  await press385(heads385.length ? heads385[heads385.length - 1] : null);
  const sel390 = last385('audio-play-stream-mode390');
  if (sel390 && typeof sel390.props.onChange === 'function') { sel390.props.onChange({ target: { value: 'lan' } }); }
  await flush(); bag = commit(); await flush();
  const selNow390 = last385('audio-play-stream-mode390');
  const goNow390 = last385('audio-play-import-merge646');
  check('T-385: Settings carries the mode as a control with the three options the user named, and switching it to LAN leaves the import control pressable (T-621 item 11, 2026-10-25: the mode no longer greys the control — the refusal is the red line in the row)',
    !!sel390 && ['off', 'all', 'lan'].every(function (v390) { return (sel390.props.children || []).some(function (o390) { return o390 && o390.props && o390.props.value === v390; }); })
      && !!selNow390 && selNow390.props.value === 'lan'
      && !!goNow390 && goNow390.props.disabled === false,
    { options: sel390 ? (sel390.props.children || []).map(function (o390) { return o390 && o390.props && o390.props.value; }) : null, value: selNow390 && selNow390.props.value, mergeDisabled: goNow390 && goNow390.props.disabled });

  await type385('https://example.org/a.mp3');
  await press385(last385('audio-play-import-merge646'));
  check('T-385: LAN mode refuses a public host and says which hosts count as local, so the refusal teaches the rule instead of hiding it',
    /LAN mode/.test(msgText385()) && /example\.org/.test(msgText385()) && /192\.168/.test(msgText385()), msgText385().slice(0, 90));

  await type385('http://10.0.0.20:8963/some/song.mp3');
  await press385(last385('audio-play-import-merge646'));
  const row390 = last385('audio-play-stream-row390');
  // T-395 re-pointed the phrase, and the reason is the user's own live test: the panel accepted a WDR 1LIVE stream and
  // the browser played it, yet the answer was pasted back as an "error". The message was green and true; the trailing
  // caveat — the same sentence the standing note already carries — is what made it read like a refusal. The
  // confirmation now says only what happened to this link; the general rule is stated once, in the standing note.
  // T-424 (user 2026-10-15): 'the message 'playing wdr-1live-live... - nothing was written to disk' can be dropped
  // -> instead show the title of the stream in player 'title' display again instead of idle while 'just streaming''.
  // The printed confirmation is gone on purpose. What replaces it is on the player itself: the title line names the
  // station instead of falling back to its idle word. So this pin moved from the message to three facts that must
  // all still hold - the link is played and listed, the never-stored rule is still stated (now in the field's hover,
  // where the panel puts this kind of sentence), and the title line carries the station while it streams.
  // T-436 (2026-10-15) re-pointed the TOKEN, not the rule. The import row gained a download door that DOES write a
  // file, so a blanket "nothing is written to disk" printed on that row became a lie about the row it sits on; the
  // sentence is now scoped to the act it describes — a PLAYED link is never stored — which is what this check guards.
  check('T-385, re-pointed for T-424 and for T-436: the LAN link is played and listed, the never-stored rule for a PLAYED link still rides the field hover, and the player title names the station instead of idle',
    !/playing 10\.0\.0\.20/.test(msgText385())
      && /nothing it plays is written to disk/.test(JSON.stringify((last385('audio-play-import390', tree385) || { props: {} }).props))
      && !!row390 && JSON.stringify(row390.props.children || []).indexOf('10.0.0.20') >= 0,
      // the title line is asserted in stream_overlap.test.cjs, where a station plays with no take in the lane;
    { msg: msgText385().slice(0, 60), row: !!row390, title: msgText385().slice(0, 40) });
  const list390 = last385('audio-play-stream-list390');
  // T-412 (user 2026-10-15): "shorten 'imported streams - played by the browser, nothing stored' to 'imported
  // streams'". The heading still NAMES the block, which is what this check was guarding - only the explanatory
  // sentence it carried is gone, so the pin moves from that sentence to the name itself and the intent stands.
  check('T-385 with T-412: the accepted entry sits in the Playlist as a link row, kept apart from the rendered takes, under a heading that names it',
    !!list390 && JSON.stringify(list390.props.children || "").indexOf('imported streams') >= 0,
    list390 ? 'found' : 'no list block');
  // T-412 also gave the lane list its own centred heading, so the two lists in this section are named apart.
  // T-461 (user 2026-10-15, verbatim): "the elements in the 'imported streams' section need a bigger spacing
  // vertically, while the playlist items could use a little less, maybe make the distance between the rows the
  // same for 'imported streams' and 'tasks' - the buttons should also have the same size within the 'playlist
  // section' (use same buttons visually for play, Del, ...) accordingly". Read from THIS mount: the stream list's
  // own gap, and the height of every control that sits on a stream line. The Task half is pinned from the same
  // two constants the row is built with, because the arithmetic is the claim: 3px + a 1px hairline + 3px = 7px,
  // which is exactly the gap the stream list now asks for.
  check('T-461: one row distance and one button box across both lists of the Playlist section',
    (function () {
      const gap = list390 && list390.props && list390.props.style ? String(list390.props.style.gap) : '';
      const heights = [];
      (function walk(n) {
        if (!n) return;
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if (n.type === 'button' && n.props && n.props.style && n.props.style.height) heights.push(String(n.props.style.height));
        walk((n.props || {}).children);
      })(list390 ? list390.props.children : null);
      const src461 = require('fs').readFileSync(TARGET, 'utf8');
      const gapDecl = /var ROW_GAP461 = "7px";/.test(src461);
      const padDecl = /var ROW_PAD461 = "3px 0";/.test(src461);
      const taskRow = /gap: "6px", padding: ROW_PAD461, borderBottom: "1px solid #8883"/.test(src461);
      const streamList = /flexDirection: "column", gap: ROW_GAP461/.test(src461);
      const sharedBox = /Object\.assign\(\{\}, btnStyle, ROW_BTN334, \{ width: "24px", padding: "0"/.test(src461)
        && (src461.match(/Object\.assign\(\{\}, btnStyle, ROW_BTN334\)/g) || []).length >= 2;
      return gap === '7px' && heights.length >= 3 && heights.every(function (x) { return x === '20px'; })
        && gapDecl && padDecl && taskRow && streamList && sharedBox;
    })(),
    list390 ? [String(list390.props.style.gap), JSON.stringify((function () { const h = []; (function w(n){ if(!n) return; if(Array.isArray(n)){n.forEach(w);return;} if(n.type==='button'&&n.props&&n.props.style&&n.props.style.height)h.push(String(n.props.style.height)); w((n.props||{}).children); })(list390.props.children); return h; })())] : 'no stream list in this mount');

  check('T-412: the stream list and the lane list each carry their own centred heading',
    (function () {
      const made = shim.rt.created;   // the same creation list last385 reads: the last match is the current render
      const headAt = function (re) { for (let i = made.length - 1; i >= 0; i--) { if (re.test(String((made[i].props || {}).className || ""))) return { i: i, node: made[i] }; } return null; };
      const hs = headAt(/audio-play-stream-head470/), ht = headAt(/audio-play-pl-tasks-head646/);
      const centred = function (n) { const j = JSON.stringify(n.props || {}); return ((n.props || {}).style || {}).textAlign === "center" || /"textAlign":"center"/.test(j); };
      return !!hs && !!ht && hs.i > 0 && ht.i > hs.i && centred(hs.node) && centred(ht.node) && /imported streams/.test(JSON.stringify(hs.node.props.children || "")) && /"Tasks"/.test(JSON.stringify(ht.node.props.children || ""));
    })(),
    'the two headings, in order, both centred');

  // --- T-470 (user 2026-10-15, verbatim): "make section 'imported streams' within the playlist collapsible
  // (requires no stream playing) - to hide the stream items and shows only task items" ------------------------
  // The station played by the T-385 sequence above is LIVE in this mount, which is the useful accident: the first
  // thing this block can measure is the parenthetical, on a real live station, before anything is closed.
  console.log('\n--- T-470: the imported streams block closes, and a live station holds it open ---');
  {
    const src470 = require('fs').readFileSync(TARGET, 'utf8');
    const rows470 = function () { return created().filter(function (e) { return /audio-play-stream-row390/.test(String((e.props || {}).className || '')); }); };
    let head470 = last385('audio-play-stream-head470');
    check('T-470: the heading IS the control - a click target, not a button, and its own text still begins with the block name',
      !!head470 && typeof (head470.props || {}).onClick === 'function' && head470.type !== 'button'
        && JSON.stringify(head470.props.children || '').indexOf('imported streams') >= 0,
      head470 ? { type: head470.type, hover: String(head470.props.title || '').slice(0, 40) } : 'no heading control in this mount');

    const rowsLiveBefore = rows470().length;
    await press385(head470);
    const rowsLiveAfter = rows470().length;
    head470 = last385('audio-play-stream-head470');
    const said470 = shim.rt.created.filter(function (e) {
      return String((e.props || {}).children || '').indexOf('stop that station first') >= 0;
    }).length;
    check('T-470: while a station is live the block REFUSES to close - the rows stay, the control reads disabled, the hover says why, and the click is not silent',
      rowsLiveBefore >= 1 && rowsLiveAfter === rowsLiveBefore
        && !!head470 && (head470.props.style || {}).cursor === 'not-allowed'
        && /cannot be closed while a station is live/.test(String((head470.props || {}).title || ''))
        && said470 >= 1,
      { rowsBefore: rowsLiveBefore, rowsAfter: rowsLiveAfter, hover: String((head470 || {}).props ? (head470.props.title || '') : '').slice(0, 44), said: said470 });

    await press385(last385('audio-play-stream-stop395'));
    await press385(last385('audio-play-stream-head470'));
    const rowsClosed = rows470().length;
    head470 = last385('audio-play-stream-head470');
    check('T-470: once the station is stopped the same click hides the rows, and the heading survives so the block can be opened again',
      rowsClosed === 0 && !!head470 && /open this list again/.test(String((head470 || {}).props.title || ''))
        && JSON.stringify((head470 || {}).props.children || '').indexOf('imported streams') >= 0,
      { rows: rowsClosed, hover: String((head470 || {}).props.title || '').slice(0, 40) });

    await press385(last385('audio-play-stream-head470'));
    check('T-470: the next click brings every link back - closing hides rows, it does not delete a link',
      rows470().length === rowsLiveBefore, rows470().length);

    check('T-470: the state rides the section machinery rather than a private flag, and the live rule is an OR that cannot be overridden',
      /__streams: true/.test(src470)
        && /var streamsOpen470 = sectionOpen\("__streams", true\) \|\| streamLive470;/.test(src470)
        && /var streamLive470 = !!\(streamNow395 \|\| streamAudible395\(\)\);/.test(src470)
        && /toggleExpand\("__streams"\)/.test(src470),
      'defaults, the OR, the live read, the same toggleExpand the eleven sections use');
  }


  // --- T-436 (user 2026-10-15): the DOWNLOAD half of the import row ------------------------------------
  // The row used to offer two kinds of import (play a link, upload a file) and the user asked for a third:
  // a link that yt-dlp captures into the plugin's own store as a playlist row. What the panel is on trial
  // for here is not the download — the host does that — it is these three: the control exists and is placed
  // where the ruling put it; it is gated by the SETTING and never by the URL in the field; and when the
  // setting is empty it refuses in the row WITHOUT asking the door anything.
  console.log('\n--- T-436: the download half of the import row ---');
  {
    await shutImportRow385();
    const mark436 = shim.rt.created.length;
    const eject436 = created().filter(function (e) { return /audio-play-tp-eject/.test(String((e.props || {}).className || '')); }).pop();
    if (eject436 && typeof eject436.props.onClick === 'function') { eject436.props.onClick(); }
    await flush(); bag = commit(); await flush();
    const t436 = created();
    const pick436 = function (cls, tree) {
      return (tree || t436).filter(function (e) { return new RegExp(cls).test(String((e.props || {}).className || '')); });
    };
    // Hyperscript evaluates the arguments of h(Collapsible, …) eagerly, so a CLOSED section still CREATES
    // its body and simply does not attach it — a flat scan of rt.created therefore finds a shut section's
    // controls. These two helpers read the ATTACHED tree, which is the only honest reading of "on screen".
    const flatten436 = function (node) {
      if (node == null) return '';
      if (typeof node === 'string' || typeof node === 'number') return String(node);
      if (Array.isArray(node)) return node.map(flatten436).join('');
      if (node.props) return flatten436(node.props.children);
      return '';
    };
    const settingsTree436 = function () {
      const secs = created().filter(function (e) {
        return e.type === 'div' && e.props && e.props.className === 'audio-play-section' && /^Settings/.test(flatten436(e));
      });
      return secs.length ? secs[secs.length - 1] : null;
    };
    const inSettings436 = function (re) {
      const root = settingsTree436(); if (!root) return [];
      const hits = [];
      (function walk(n) {
        if (!n) return;
        if (Array.isArray(n)) { n.forEach(walk); return; }
        if (typeof n === 'string' || typeof n === 'number' || !n.props) return;
        if (re.test(String(n.props.className || ''))) hits.push(n);
        walk(n.props.children);
      })(root);
      return hits;
    };
    const settingsHead436 = function () {
      const hs = created().filter(function (e) {
        return hasCls(e.props && e.props.className, 'audio-play-section-head') && flatten436(e).indexOf('Settings') === 0;
      });
      return hs.length ? hs[hs.length - 1] : null;
    };

    const dl436 = pick436('audio-play-import-merge646');
    const fb436 = pick436('audio-play-import-file-btn385');
    check('T-436, re-pointed by T-621 item 11 (operator ruling 2026-10-25 14:5x Berlin, verbatim: "the textfield + import button should take over all functionalities depending on the content"): the row offers ONE import control for everything the field can hold and ONE upload-file control for what it cannot, and the import control comes before the file picker. The T-436 order (play, DL, upload) is superseded by the merge; what survives it is why a file keeps its own door — item 8(c), a browser cannot name a local file in a text field',
      dl436.length === 1 && fb436.length === 1 && t436.indexOf(dl436[0]) < t436.indexOf(fb436[0])
      && String(dl436[0].props.children) === 'import'
      && pick436('audio-play-import-go390').length === 0 && pick436('audio-play-import-dl436').length === 0
      && pick436('audio-play-import-path458').length === 0 && pick436('audio-play-import-close390').length === 0,
      { merge: dl436.length, fileBtn: fb436.length, order: [t436.indexOf(dl436[0]), t436.indexOf(fb436[0])],
        label: dl436.length ? String(dl436[0].props.children) : null,
        doors_gone: [pick436('audio-play-import-go390').length, pick436('audio-play-import-dl436').length,
          pick436('audio-play-import-path458').length, pick436('audio-play-import-close390').length] });

    // T-436 UI pass (user 2026-10-15, verbatim): "shorten download to DL - remove blue color, make normal
    // like other buttons". The control is one of its neighbours, not a highlighted exception. Re-pointed at the
    // merged control 2026-10-25 (T-621 item 11): the ruling was against a SECOND PALETTE on this row, and the merged
    // button carries the row's one go colour — the green the play door already wore, which the operator never
    // objected to — while the Settings palette stays off the row.
    check('T-436 UI pass: the control is short-labelled and carries no second palette on the row',
      dl436.length === 1 && String(dl436[0].props.children) === 'import'
      && !/#1d2433|#8ab4f8|#8b949e/.test(JSON.stringify(dl436[0].props.style || {})),
      { label: dl436.length ? String(dl436[0].props.children) : null, style: JSON.stringify(dl436[0].props.style || {}).slice(0, 140) });

    // Shut Settings, prove the yt-dlp field really is off the screen, then press import with no binary configured.
    for (let i436 = 0; i436 < 3 && inSettings436(/audio-play-ytdlp-path436/).length > 0; i436++) {
      await press385(settingsHead436());
    }
    const shut436 = inSettings436(/audio-play-ytdlp-path436/).length === 0;

    // T-621 item 11: the capture leg is now reached by WHAT IS TYPED, not by a door, so the fixture types a youtube
    // host — the operator's own branch ("youtube-url -> yt-fl if configured"). The token is a fixture string; the
    // panel never fetches it, the capture leg is a plugin verb the shim answers.
    await type385('https://www.youtube.com/watch?v=abcdefghijk');
    const dlTyped436 = last385('audio-play-import-merge646');
    check('T-436 UI pass (user 2026-10-15, verbatim: "remove empty → the download button is disabled - instead, if not set, the DL button should open settings drop down and scroll to the settings area"), re-pointed by T-621 item 11: the control is PRESSABLE whatever the setting says, and its hover says what THIS field would do — capture, and the missing binary',
      !!dlTyped436 && dlTyped436.props.disabled !== true
      && /capture this youtube link/.test(String(dlTyped436.props.title || ''))
      && /no yt-dlp binary is set/.test(String(dlTyped436.props.title || ''))
      && /opens Settings to the field that sets it/.test(String(dlTyped436.props.title || '')),
      dlTyped436 ? { disabled: dlTyped436.props.disabled, title: String(dlTyped436.props.title || '').slice(0, 90) } : 'no import control');

    const capAsked436 = verbCalls('capture_url').length;
    await press385(dlTyped436);
    check('T-436 ape-proof: with Settings shut and no binary set, pressing DL OPENS Settings to the field that sets it, says so in the row, and asks NOTHING of the door',
      shut436 && inSettings436(/audio-play-ytdlp-path436/).length >= 1
      && /no yt-dlp binary is set/.test(msgText385()) && /opening Settings/.test(msgText385())
      && verbCalls('capture_url').length === capAsked436,
      { settings_was_shut: shut436, field_on_screen_after_press: inSettings436(/audio-play-ytdlp-path436/).length,
        msg: msgText385().slice(0, 90), capture_calls: verbCalls('capture_url').length - capAsked436 });

    check('T-436, re-pointed by T-621 item 11: the CAPTURE leg is gated by the SETTING and never by whether the link looks good — a typed youtube link changes nothing while the binary is unset, and the refusal says so',
      /no yt-dlp binary is set/.test(msgText385()) && verbCalls('capture_url').length === capAsked436,
      msgText385().slice(0, 90));

    // The second world: the machine HAS a binary. Re-opening the import row re-reads the setting (there is
    // no poller), and from here the refusals are the panel's own.
    ytdlpSet436 = true;
    await shutImportRow385();
    await press385(last385('audio-play-tp-eject'));
    const lit436 = last385('audio-play-import-merge646');
    check('T-436: a binary that IS configured is read when the row opens and lights the SAME control, with the version in its hover rather than in a second colour',
      !!lit436 && lit436.props.disabled !== true && /2026\.08\.19/.test(String(lit436.props.title || ''))
      && !/#1d2433|#8ab4f8/.test(JSON.stringify(lit436.props.style || {})),
      lit436 ? String(lit436.props.title || '').slice(0, 90) : 'no import control');

    await type385('');
    await press385(last385('audio-play-import-merge646'));
    check('T-436, re-pointed by T-621 item 11: with a binary configured, pressing import with an empty field says the field is empty and says plainly that nothing was asked of the plugin',
      /the field is empty/.test(msgText385()) && /Nothing was asked of the plugin/.test(msgText385())
      && verbCalls('capture_url').length === capAsked436,
      msgText385().slice(0, 90));

    await type385('https://www.youtube.com/watch?v=abcdefghijk');
    await press385(last385('audio-play-import-merge646'));
    check('T-436: with a binary configured and a link typed, the press DOES ask the door, and the binary\'s own words come back as the answer — the panel does not paraphrase a refusal it was given',
      verbCalls('capture_url').length === capAsked436 + 1 && /download failed/.test(msgText385())
      && /HTTP Error 403: Forbidden/.test(msgText385()),
      { capture_calls: verbCalls('capture_url').length - capAsked436, msg: msgText385().slice(0, 90) });

    const state436 = inSettings436(/audio-play-ytdlp-state436/).map(function (e) { return String((e.props || {}).children || ''); });
    const field436 = inSettings436(/audio-play-ytdlp-path436/);
    check('T-436: Settings carries the yt-dlp binary path as a field, and the line under it repeats what the host answered — the version and the path, once the host has a path',
      field436.length >= 1 && state436.length >= 1
      && /yt-dlp 2026\.08\.19/.test(state436[state436.length - 1]) && /\/home\/deepamp-test\/bin\/yt-dlp/.test(state436[state436.length - 1]),
      state436.length ? state436[state436.length - 1].slice(0, 110) : 'no readout drawn');

    // T-436 UI pass (user 2026-10-15): the printed hint under that field is gone — "we already have this in
    // the hover tooltips". The sentence moved into the readout's hover, so the pin proves both halves.
    const hint436 = inSettings436(/audio-play-ytdlp-hint436/);
    const stateTitle436 = inSettings436(/audio-play-ytdlp-state436/).map(function (e) { return String(((e || {}).props || {}).title || ''); });
    check('T-436 UI pass: the printed paragraph under the yt-dlp field is gone, and what it said (two calls, and the link never on a command line) is stated in the readout hover',
      hint436.length === 0 && stateTitle436.length >= 1
      && /A capture is two calls/.test(stateTitle436[stateTitle436.length - 1])
      && /never rides on a command line/.test(stateTitle436[stateTitle436.length - 1]),
      { hint_lines: hint436.length, hover: (stateTitle436[stateTitle436.length - 1] || '').slice(0, 120) });

    // --- T-482 (user 2026-10-16, verbatim): "In settings, remove text 'applies as you type; also the take budget, and
    //     the poll deadline follows it (+5 min)' and 'empty -> captures are refuse' change 'yt-dlp binary path' to
    //     '(optional) add yt-dlp binary by path'" ---------------------------------------
    // Both removals are pinned as ABSENCE from the drawn Settings tree (not hidden, not conditional), and each fact
    // that was struck out of a printed line is pinned where the panel keeps that kind of sentence now: the control's
    // own hover. The label change is pinned as the exact text a person reads.
    {
      const lab482 = inSettings436(/audio-play-ytdlp-label436/);
      const lab482Text = lab482.length ? String((lab482[lab482.length - 1].props || {}).children || '') : '';
      const lab482Title = lab482.length ? String(((lab482[lab482.length - 1].props || {}).title) || '') : '';
      const treeText482 = flatten436(settingsTree436());
      const ph482 = (inSettings436(/audio-play-ytdlp-path436/).pop() || { props: {} }).props.placeholder;
      check('T-482: the yt-dlp field is labelled what it is - "(optional) add yt-dlp binary by path" - and the inline note under it is gone from the drawn tree',
        lab482Text === '(optional) add yt-dlp binary by path'
          && treeText482.indexOf('captures are refused') < 0
          && String(ph482) === '/absolute/path/to/yt-dlp',
        { label: lab482Text, placeholder: String(ph482), note_present: treeText482.indexOf('captures are refused') >= 0 });
      check('T-482: what the removed note said now lives in the fields own hover, where this panel keeps that kind of sentence - empty is not silence, it is a refusal named',
        /Left empty, the download control on the import row stays disabled/.test(lab482Title)
          && /a capture is refused before anything runs/.test(lab482Title), lab482Title.slice(-140));
      const genLab482 = (function () {
        const found = [];
        (function walk482(n) {
          if (!n) return;
          if (Array.isArray(n)) { n.forEach(walk482); return; }
          if (typeof n === 'string' || typeof n === 'number' || !n.props) return;
          if (flatten436(n) === 'generation timeout (s)') found.push(n);
          walk482(n.props.children);
        })(settingsTree436());
        return found.length ? found[found.length - 1] : null;
      })();
      check('T-482: the generation-timeout row carries no printed sentence under the number, and the one fact the struck line had that the hover did not already carry is now in the hover',
        treeText482.indexOf('applies as you type') < 0
          && !!genLab482 && /poll deadline rides this number \(\+5 min\)/.test(String((genLab482.props || {}).title || ''))
          && /It also sets the take budget/.test(String((genLab482.props || {}).title || '')),
        { printed_note_present: treeText482.indexOf('applies as you type') >= 0,
          hover: String(((genLab482 || { props: {} }).props || {}).title || '').slice(0, 160) });
      check('T-482 source: neither struck sentence exists in the panel as panel text any more - the only line still carrying the quote is the card comment that records the ruling - and the field pointer the import row prints names the field the panel shows',
        (function () {
          const lines482 = require('fs').readFileSync(TARGET, 'utf8').split('\n');
          const quoted482 = lines482.filter(function (l482) { return l482.indexOf('applies as you type; also the take budget') >= 0; });
          const struck482 = lines482.filter(function (l482) { return l482.indexOf('captures are refused') >= 0; });
          return quoted482.length > 0 && quoted482.every(function (l482) { return /^\s*\/\//.test(l482); })
            && struck482.length === 0
            && lines482.filter(function (l482) { return l482.indexOf('"yt-dlp binary path"') >= 0 && !/^\s*\/\//.test(l482); }).length === 0
            && require('fs').readFileSync(TARGET, 'utf8').indexOf('(optional) add yt-dlp binary by path') >= 0
            && /Settings \\u2192 the yt-dlp binary field/.test(require('fs').readFileSync(TARGET, 'utf8'));
        })(), (function () {
          const lines482b = require('fs').readFileSync(TARGET, 'utf8').split('\n');
          return [lines482b.filter(function (l) { return l.indexOf('applies as you type') >= 0; }).length,
            lines482b.filter(function (l) { return l.indexOf('captures are refused') >= 0; }).length,
            lines482b.filter(function (l) { return l.indexOf('"(optional) add yt-dlp binary by path"') >= 0; }).length];
        })());
    }

    check('T-436 source: the press is guided, not dead — the helper opens the Settings section BEFORE it re-reads the setting, and the press reaches the helper through the merged import button (T-621 item 11, 2026-10-25) rather than the capture directly',
      (function () {
        const src436 = require('fs').readFileSync(TARGET, 'utf8');
        const guide436 = (src436.match(/function captureOrGuide436\(\) \{[\s\S]*?\n      \}/) || [''])[0];
        return guide436.length > 500
          && /if \(!\(ytdlp && ytdlp\.configured && ytdlp\.resolves\)\)/.test(guide436)
          && guide436.indexOf('no yt-dlp binary is set') < guide436.indexOf('openSection386("Settings", "__set")')
          && guide436.indexOf('openSection386("Settings", "__set")') < guide436.indexOf('refreshYtdlp436()')
          && /captureUrl436\(\);/.test(guide436)
          // T-621 item 11 (operator ruling 2026-10-25): the row has no DL button of its own any more, so "the button
          // calls the helper rather than the capture directly" is measured on the merged press instead — importPress646
          // reads the field, and a youtube link goes to the guide, never straight to the capture.
          && (function () {
            const press646 = (src436.match(/function importPress646\(\) \{[\s\S]*?\n      \}/) || [''])[0];
            return press646.length > 400
              && /captureOrGuide436\(\);\s*\n\s*return;/.test(press646)
              && /importPathTyped458\(\); return;/.test(press646)
              && /submitImport390\(\);/.test(press646);
          })()
      })(), 'guide opens Settings, then reads, then captures only when the setting is sound');

    check('T-436 source: the download press is still gated in the panel BEFORE the door is called, and the refusal sentence names the setting it needs',
      (function () {
        const src436 = require('fs').readFileSync(TARGET, 'utf8');
        const body436 = (src436.match(/function captureUrl436\(\) \{[\s\S]*?\n      \}/) || [''])[0];
        return body436.length > 1200
          && /if \(!\(ytdlp && ytdlp\.configured && ytdlp\.resolves\)\)/.test(body436)
          && body436.indexOf('no yt-dlp binary is set') < body436.indexOf('call("capture_url"')
          && /call\("capture_url", \{ url: raw436 \}\)/.test(body436);
      })(), 'the guard sits before the call');

    check('T-436 subs: the caption outcome is said on a line of its own — a caption that came is filed, a link with none is reported as a fact, a pass that broke is a warning — and none of the three rewrites the capture result',
      (function () {
        const src436s = require('fs').readFileSync(TARGET, 'utf8');
        // window widened 900 -> 1500 on 2026-10-21 (T-623 item 4): the caption block carries the whole-line
        // reason now, which is more words on the page than the old tail-slice sentence was, and the two
        // sentences this pin looks for sit further down the block than 900 characters from its head.
        const sub436s = (/if \(r436\.subtitle_status === "written"\) \{[\s\S]{0,1500}/.exec(src436s) || [''])[0];
        return sub436s.length > 300 && /subtitle_status === "none"/.test(sub436s)
          && /subtitle_status === "failed"/.test(sub436s)
          && /no captions on this link/.test(sub436s) && /captions did not come: /.test(sub436s);
      })(), 'each caption world gets its own sentence, beside the capture line rather than inside it');

    check('T-623 item 4: the panel quotes the host\u0027s WHOLE-LINE reason for a caption outcome, and the old tail slice survives only as the fallback against a host that does not send a reason — a tail is what made a rate limit read as "no captions on this link"',
      (function () {
        const src623 = require('fs').readFileSync(TARGET, 'utf8');
        const blk623 = (/if \(r436\.subtitle_status === "written"\) \{[\s\S]{0,1500}/.exec(src623) || [''])[0];
        return (blk623.match(/r436\.subtitle_reason/g) || []).length === 4
          && (blk623.match(/String\(r436\.subtitle_reason\)/g) || []).length === 2
          && (blk623.match(/\.slice\(-160\)/g) || []).length === 1
          && (blk623.match(/\.slice\(-200\)/g) || []).length === 1;
      })(), 'the reason is quoted whole; the slice is the fallback, not the sentence');

    check('T-436 source: a capture that the binary complained about is said out loud as a warning, not folded into the success line',
      (function () {
        const src436 = require('fs').readFileSync(TARGET, 'utf8');
        const warn436 = (/if \(r436\.binary_note\) \{[\s\S]{0,220}/.exec(src436) || [''])[0];
        return warn436.length > 60 && /notify\("yt-dlp said, while capturing: "/.test(warn436) && /, "warn"\);/.test(warn436);
      })(), 'binary_note reaches the event log as a warning');
  }


  // --- T-353 (user bug report 2026-10-14, live panel): an unfinished row is not playable --------------
  // What was seen live: a row the lane had NOT finished (queued, waiting on a busy slot) was lit as
  // NOW PLAYING and carried a "HEARD OUT" chip. The host answers a route for ANY row it has — routeForJob
  // (lib/index.js:13279) does not look at status — so the transport walk could step onto an unfinished row
  // and the panel took it. The panel now gates it: the walk lands on finished rows only, and a hand-played
  // unfinished row is refused before the host is asked.
  console.log('\n--- T-353: queued and synthesizing rows are not playable ---');
  function t353Refresh() {
    const r = created().filter(function (e) {
      return e.type === 'button' && /re-dispatch with the same parameters/.test(String((e.props || {}).title || ''));
    }).pop();
    if (!r) return false;
    r.props.onClick();     // retryRow refreshes the playlist before anything else
    return true;
  }
  plOverride = PL_FIXED.concat([
    { id: 'ap-1005', fn: 'tts', kind: 'tts', status: 'queued', model: 'm1', voice: 'voy_janeway', text: 'not rendered yet', position: 1, endpoint_slot_wait: { id: 'e-5' } },
    { id: 'ap-1006', fn: 'tts', kind: 'tts', status: 'running', model: 'm1', activity: 'synthesizing', text: 'still cooking' },
  ]);
  if (t353Refresh()) { await flush(); bag = commit(); await flush(); bag = commit(); await flush(); }
  let t353Tree = created();
  check('T-353 setup — the lane now answers two unfinished rows and the panel draws them',
    t353Tree.some(function (e) { return /ap-1005/.test(String((e.props || {}).children || '')); })
      && t353Tree.some(function (e) { return /ap-1006/.test(String((e.props || {}).children || '')); }),
    t353Tree.filter(function (e) { return /ap-100[56]/.test(String((e.props || {}).children || '')); }).length);
  const t353Play0 = verbCalls('~play_job').length;
  clickTp('next'); await flush(); bag = commit(); await flush();
  const t353NewPlay = calls.slice(t353Play0).filter(function (c) { return /play_job/.test(c); });
  check('T-353: pressing next never hands an unfinished row to the lane — the step lands on a finished row',
    t353NewPlay.length >= 1 && !t353NewPlay.some(function (c) { return /ap-1005|ap-1006/.test(c); })
      && t353NewPlay.some(function (c) { return /ap-1001|ap-1003/.test(c); }),
    t353NewPlay.join(' | ') || 'no play_job at all');
  t353Tree = created();
  // T-373 (user 2026-10-14, live panel): the separate "playing" TAG is gone — the lit row says it by background,
  // accent bar and id column. The positive control below therefore reads the LIT ROW, not a chip: the marking
  // machinery must still be alive, it just no longer prints a word for it.
  check('T-353 / T-363 / T-373: an unfinished row carries no playing tag, no heard chip and no dimmed title, while the row the panel did play is still lit',
    (function () {
      const chips = t353Tree.filter(function (e) {
        const c = String((e.props && e.props.className) || '');
        return /audio-play-row-playing345|audio-play-row-heard346/.test(c);
      });
      const onUnfinished = chips.filter(function (e) { return /^ap-100[56]:/.test(String((e.props || {}).key || '')); });
      // T-363 (2026-10-14): the dim is the heard mark now, so an unfinished row must not carry it either —
      // a row this panel was never able to play cannot have been heard.
      const mainsU = t353Tree.filter(function (e) {
        return (e.props || {}).className === 'audio-play-row-main'
          && /not rendered yet|still cooking/.test(String((e.props || {}).children || ''));
      });
      const litU = t353Tree.filter(function (e) {
        return /audio-play-row-lit345/.test(String((e.props && e.props.className) || ''));
      }).filter(function (e) { return /^ap-100[56]/.test(String((e.props || {}).key || '')); });
      return onUnfinished.length === 0 && chips.length === 0 && litU.length === 0
        && t353Tree.some(function (e) { return /audio-play-row-lit345/.test(String((e.props && e.props.className) || '')); })
        && mainsU.length === 2 && mainsU.every(function (e) { return (e.props.style || {}).opacity !== 0.62; });
    })(), t353Tree.filter(function (e) { return /audio-play-row-(playing|heard)34/.test(String((e.props || {}).className || '')); })
      .map(function (e) { return String(e.props.key || '') + '=' + String(e.props.children || ''); }).join(' | '));
  const t353Play1 = verbCalls('~play_job').length;
  // Now a playlist with NOTHING finished: the refusal has to name what is actually there.
  plOverride = [
    PL_FIXED[3],
    { id: 'ap-1005', fn: 'tts', kind: 'tts', status: 'queued', model: 'm1', text: 'not rendered yet', position: 1, endpoint_slot_wait: { id: 'e-5' } },
    { id: 'ap-1006', fn: 'tts', kind: 'tts', status: 'running', model: 'm1', activity: 'synthesizing', text: 'still cooking' },
  ];
  if (t353Refresh()) { await flush(); bag = commit(); await flush(); bag = commit(); await flush(); }
  clickTp('next'); await flush(); bag = commit(); await flush();
  const t353MsgTree = created();
  check('T-353: with nothing finished the panel says the rows have not finished rendering, instead of shrinking the playlist to "nothing"',
    t353MsgTree.some(function (e) { return /2 row\(s\) that have not finished rendering — there is nothing to step to yet/.test(String((e.props || {}).children || '')); }),
    t353MsgTree.map(function (e) { return String((e.props || {}).children || '').slice(0, 70); }).filter(function (s) { return /rendering|step to/.test(s); }).join(' | '));
  check('T-353: and it asked the lane to play nothing on that empty step',
    verbCalls('~play_job').length === t353Play1, calls.slice(t353Play1).join(' | '));
  // T-372 (user bug report 2026-10-14, live panel, verbatim): "it looks like currently, the prev and next play
  // buttons are actually reversed (maybe globally in miniplayer, too) : if i get two renders, and want to skip
  // the currently playing item, i klick next, -> i expect the next render to be played -> playlist goes 'up'".
  // The fixture below is the order the host ACTUALLY hands the playlist out — newest first (playlist_list returns
  // playlist.slice(0, n), lib/index.js:14376, and the live read on this lane showed ap-0338 above ap-0337 above
  // ap-0336) — because the oldest-first fixture earlier in this file is exactly the fiction that let the reversal
  // live unnoticed. The walk must follow the order the lane MADE the takes, which is also the order the panel
  // plays them (FIFO play queue, autoplay takes the newest fresh row).
  {
    plOverride = [
      { id: 'ap-2103', fn: 'tts', kind: 'tts', status: 'ok', model: 'm1', voice: 'voy_janeway', duration: 11.5, text: 'newest take', created: 1760000003000, position: 3 },
      { id: 'ap-2102', fn: 'tts', kind: 'tts', status: 'ok', model: 'm1', voice: 'voy_neelix', duration: 12.5, text: 'middle take', created: 1760000002000, position: 2 },
      { id: 'ap-2101', fn: 'tts', kind: 'tts', status: 'ok', model: 'm1', voice: 'voy_doctor', duration: 13.5, text: 'oldest take', created: 1760000001000, position: 1 },
      // An error row is not playable, so it never lands in the walk; it is here because it is the control that
      // makes the panel ask the lane for the list again (the suite's poll timer is a no-op stub).
      { id: 'ap-2100', fn: 'tts', kind: 'tts', status: 'error', model: 'm1', voice: 'voy_doctor', duration: 0, text: 'failed take', created: 1760000000000, error: 'engine refused the file' },
    ];
    if (t353Refresh()) { await flush(); bag = commit(); await flush(); bag = commit(); await flush(); }
    const t372Before = postedJobs().length;
    clickTp('next'); await flush(); bag = commit(); await flush();
    clickTp('next'); await flush(); bag = commit(); await flush();
    const t372Fwd = postedJobs().slice(t372Before);
    check('T-372: on a newest-first playlist, next steps to the take the lane made AFTER this one (2102 then 2103), not the older one below it',
      t372Fwd.join(',') === 'ap-2102,ap-2103', [t372Fwd, calls.slice(-4).join(' ')]);
    clickTp('prev'); await flush(); bag = commit(); await flush();
    const t372Back = postedJobs().slice(t372Before + t372Fwd.length);
    check('T-372: and prev steps back to the take it came from',
      t372Back.join(',') === 'ap-2102', [t372Back, calls.slice(-3).join(' ')]);
  }
  plOverride = null;

  // T-399 (T-387 item 4, user 2026-10-14, verbatim): "visible reaction when a click schedules nothing". The lane button
  // that carries a reason is pressable ON PURPOSE — a hard-disabled button swallows the press, and that silence is what
  // the user reported — so the proof that matters is behavioural: the press must schedule NOTHING, must paint its
  // refusal on the button, and must leave the reason in words the operator can still read after the colour is gone.
  {
    const gen399 = last385('audio-play-generate371');
    if (!gen399) throw new Error('no Generate button in the tree to press');
    if (gen399.props.disabled === true) throw new Error('Generate is hard-disabled, so a press on it would be swallowed again');
    if (gen399.props['aria-disabled'] !== true) throw new Error('Generate is pressable without being aria-disabled');
    const before399 = calls.length;
    await press385(gen399);
    const newCalls399 = calls.slice(before399).filter(function (c) { return /dispatch|generate/i.test(c); });
    const after399 = last385('audio-play-generate371');
    const allTxt399 = shim.rt.created.map(function (e) { return String((e.props || {}).children || ''); }).join('\n');
    check('T-399: pressing Generate with nothing typed schedules nothing — no dispatch verb leaves the panel',
      newCalls399.length === 0, newCalls399);
    check('T-399: and the press is not silent — the button reads "nothing to send" and wears the alarm red for the same window a real result wears its green',
      !!after399 && String(after399.props.children) === 'nothing to send' && ((after399.props.style || {}).background === '#f85149'),
      after399 ? { label: String(after399.props.children), bg: (after399.props.style || {}).background } : null);
    check('T-399: the reason is said in words, not only painted in a colour',
      /nothing typed in the text box/.test(allTxt399), /nothing typed in the text box/.test(allTxt399) ? 'said' : 'missing');
  }

  // --- T-458 (user ruling 2026-10-15, built 2026-10-16): the PATH half of the import row -----------------
  // The user's words: "a full path should be added as playlist item, if wav, mp, ogg is found accordingly, and
  // readable, and give error on header mismatch - files should be verified prior to creating and using entry. must
  // be implemented accordingly". The verification is the host's job and the host suite measures it (24 pins). What
  // THIS suite is on trial for is the panel's half: the control exists and is placed with the file half rather than
  // with the links, because a path is not a stream and is not governed by the Stream input setting; a press that
  // cannot ask anything says so in the row and asks the door NOTHING; a filed import is taken up and played; a
  // refusal is printed in the row in the host's own words, both sides named, and the row stays open so it can be
  // read; and the play half stops calling a path "not an address" and names the door that takes it.
  console.log('\n--- T-458: the path half of the import row ---');
  {
    await shutImportRow385();
    const mark458 = shim.rt.created.length;
    const eject458 = created().filter(function (e) { return /audio-play-tp-eject/.test(String((e.props || {}).className || '')); }).pop();
    if (eject458 && typeof eject458.props.onClick === 'function') { eject458.props.onClick(); }
    await flush(); bag = commit(); await flush();
    const t458 = created();
    const pick458 = function (cls, tree) {
      return (tree || created()).filter(function (e) { return new RegExp(cls).test(String((e.props || {}).className || '')); });
    };
    const press458 = async function (el) { if (el && typeof el.props.onClick === 'function') { el.props.onClick(); } await flush(); bag = commit(); await flush(); };
    const type458 = async function (v) {
      const f = pick458('audio-play-import-url390').pop();
      if (f && typeof f.props.onChange === 'function') { f.props.onChange({ target: { value: v } }); }
      await flush(); bag = commit(); await flush();
    };
    const msg458 = function () { const m = pick458('audio-play-import-msg390').pop(); return m ? String(m.props.children || '') : ''; };
    const callsBefore458 = verbCalls('import_path').length;

    // T-621 item 11 (operator ruling 2026-10-25 14:5x Berlin, verbatim): "yes, the textfield + import button should
    // take over all functionalities depending on the content - youtube-url -> yt-fl if configured / other url ->
    // stream / file path -> import". The separate `path` control is GONE, and so are `play` and `DL`: ONE control
    // reads the field, and a leading "/" runs the SAME filing leg this fixture has measured since 2026-10-16 — same
    // guards, same verb, same body, same host sentence on a refusal. What changed is which control a person presses.
    // The hovers below are read off the merged control, and they are COMPUTED from what the field holds: a fixed
    // hover for a door the panel no longer has would describe a control that is not there.
    const merge458 = pick458('audio-play-import-merge646', t458);
    const hover458 = function () { const m = pick458('audio-play-import-merge646').pop(); return m ? String(m.props.title || '') : ''; };
    check('T-458, re-pointed by T-621 item 11 (2026-10-25): a PATH on the plugin host is filed through the ONE import control — the path door and the play door and the DL door are one button that reads the field',
      merge458.length === 1 && String(merge458[0].props.children) === 'import'
      && pick458('audio-play-import-path458', t458).length === 0
      && pick458('audio-play-import-go390', t458).length === 0
      && pick458('audio-play-import-dl436', t458).length === 0,
      { merge: merge458.length, label: merge458.length ? String(merge458[0].props.children) : null,
        pathBtn: pick458('audio-play-import-path458', t458).length, playBtn: pick458('audio-play-import-go390', t458).length,
        dlBtn: pick458('audio-play-import-dl436', t458).length });
    await type458('/home/deepamp-test/tmp_media/room_tone.wav');
    check('T-458, re-pointed by T-621 item 11: the ONE control states what the host checks before anything is filed, and it states it from what the field holds — the field is a path, so the hover is the filing hover, with the verification detail and the copy-into-the-store rule in it',
      /This press files \/home\/deepamp-test\/tmp_media\/room_tone\.wav as a playlist row/.test(hover458())
      && /absolute path only and no traversal/.test(hover458())
      && /header compared with its OWN extension/.test(hover458())
      && /both sides named/.test(hover458())
      && /copied into it first/.test(hover458()),
      { hover: hover458().slice(0, 80) });
    // The fixture's Settings hold the stream mode at OFF (its printed label is "disabled"), and the filing still
    // happened below — that is the behavioural proof that a path is not a stream. The hover of a PATH deliberately
    // does NOT carry the mode sentence: a filing is outside the setting's reach, and a hover that mentioned a mode
    // it cannot act on would imply a gate that does not exist. The mode IS stated in every hover the setting can
    // actually refuse (empty, unknown, stream), which the T-385 block above measures.
    check('T-458: filing a path is NOT gated by the Stream input setting — a path is not a stream — so the merged control is not disabled by it and states the filing act instead of a stream refusal',
      (function () { const m = pick458('audio-play-import-merge646').pop(); return !!m && m.props.disabled !== true; })()
      && /This press files \/home\/deepamp-test\/tmp_media\/room_tone\.wav/.test(hover458()),
      { disabled: (function () { const m = pick458('audio-play-import-merge646').pop(); return m ? m.props.disabled : null; })(),
        hover: hover458().slice(0, 60) });

    await type458('');
    await press458(pick458('audio-play-import-merge646').pop());
    check('T-458: pressing path with an empty field says so in the row, and asks the door NOTHING (T-387 item 4, the same rule the play half follows)',
      /field is empty/.test(msg458()) && verbCalls('import_path').length === callsBefore458,
      { msg: msg458().slice(0, 70), calls: verbCalls('import_path').length - callsBefore458 });

    await type458('tmp_media/room_tone.wav');
    await press458(pick458('audio-play-import-merge646').pop());
    check('T-458: a relative path is refused in the row with the rule named (absolute path only, this field is not a shell), and the door is still not asked anything',
      /absolute path only/.test(msg458()) && verbCalls('import_path').length === callsBefore458,
      { msg: msg458().slice(0, 80), calls: verbCalls('import_path').length - callsBefore458 });

    await type458('/home/deepamp-test/tmp_media/room_tone.wav');
    await press458(pick458('audio-play-import-merge646').pop());
    const asked458 = postedBodies('import_path').pop() || {};
    check('T-458: an absolute path is asked of the door, as a path and nothing else — the panel sends the typed string, it does not guess a prefix, resolve a relative path, or quote it into anything',
      verbCalls('import_path').length === callsBefore458 + 1 && asked458.path === '/home/deepamp-test/tmp_media/room_tone.wav'
      && Object.keys(asked458).length === 1, asked458);
    check('T-458: a FILED import is taken up — the row closed, and the panel asked to play the row the host created (ap-0900), which is the point of filing it: it is playable as soon as it exists',
      postedJobs().indexOf('ap-0900') >= 0 && pick458('audio-play-import390').length === 0,
      { played: postedJobs().slice(-1), rowStillOpen: pick458('audio-play-import390').length });

    // The refusal world: the host's own sentence, both sides named, kept in the row so it can be read.
    importFile458 = false;
    await shutImportRow385();
    const eject458b = created().filter(function (e) { return /audio-play-tp-eject/.test(String((e.props || {}).className || '')); }).pop();
    if (eject458b && typeof eject458b.props.onClick === 'function') { eject458b.props.onClick(); }
    await flush(); bag = commit(); await flush();
    await type458('/home/deepamp-test/tmp_media/mislabeled.wav');
    const callsBeforeBad458 = verbCalls('import_path').length;
    const jobsBeforeBad458 = postedJobs().length;
    await press458(pick458('audio-play-import-merge646').pop());
    check('T-458: a refused import keeps the row OPEN and prints the host\'s own sentence in it, with BOTH sides named — what the name says and what the file says — softened into nothing',
      pick458('audio-play-import390').length === 1 && /header mismatch/.test(msg458())
      && /OggS \(ogg\/oga\/opus\)/.test(msg458()) && /\.wav/.test(msg458())
      && verbCalls('import_path').length === callsBeforeBad458 + 1,
      { msg: msg458().slice(0, 110), open: pick458('audio-play-import390').length });
    check('T-458: a refusal plays nothing — the refused press asked for no play_job, and the row it refused is not filed anywhere',
      postedJobs().length === jobsBeforeBad458 && verbCalls('import_path').length === callsBeforeBad458 + 1,
      { jobs: postedJobs().slice(-2), newPlays: postedJobs().length - jobsBeforeBad458 });
    importFile458 = true;

    // T-458 asked (2026-10-16) that a path never be called "not an address a browser can play": the row had a PLAY
    // door and a PATH door side by side, and pressing the wrong one printed the sentence naming the other. T-621 item
    // 11 (operator ruling 2026-10-25 14:5x Berlin, verbatim: "file path -> import") removes the mistake a person
    // could make: there is ONE door, a leading "/" is READ as a path, and the browser leg is never reached. So the
    // check measures the routing as behaviour — the filing verb is asked, and no stream row appears.
    await type458('/home/deepamp-test/tmp_media/room_tone.wav');
    const callsBeforeRoute458 = verbCalls('import_path').length;
    const streamRows458 = function () { return created().filter(function (e) { return /audio-play-stream-row390/.test(String((e.props || {}).className || '')); }).length; };
    const rowsBeforeRoute458 = streamRows458();
    await press458(pick458('audio-play-import-merge646').pop());
    check('T-621 item 11: a typed path is READ as a filing and never reaches the browser leg — the verb asked of the plugin is import_path, and no stream row appears',
      verbCalls('import_path').length === callsBeforeRoute458 + 1 && streamRows458() === rowsBeforeRoute458,
      { newFilingCalls: verbCalls('import_path').length - callsBeforeRoute458, rowsBefore: rowsBeforeRoute458, rowsAfter: streamRows458() });

    const src458 = require('fs').readFileSync(TARGET, 'utf8');
    check('T-458 source, re-pointed by T-621 item 11: the panel calls the host door with the typed path only, the field says in its placeholder that a path belongs on it, and the door a path used to need is gone from the panel',
      /call\("import_path", \{ path: p458 \}\)/.test(src458)
      && /placeholder: "http\(s\) link, or \/absolute\/path on the plugin host/.test(src458)
      && /className: "audio-play-import-merge646"/.test(src458)
      && !/className: "audio-play-import-path458"/.test(src458), null);
    check('T-458 source: the path press is gated in the panel BEFORE the door is asked (empty field, relative path), and a refusal keeps the row open while a success closes it',
      /if \(p458\.charAt\(0\) !== "\/"\)/.test(src458) && /not filed: /.test(src458)
      && /setImportOpen390\(false\);\s*\n\s*setImportText390\(""\);\s*\n\s*refreshPlaylist\(\);\s*\n\s*if \(rowId458\) playJob\(rowId458\)/.test(src458), null);
    check('T-458 source, re-pointed by T-621 item 11: the link checker still says what a path IS rather than that it is not a link, and the sentence names the door that takes it — the door is now the import button itself',
      /that is a file path on the plugin host, not a link/.test(src458)
      && /import files it: the plugin verifies the file and lists it as a row/.test(src458), null);
  }

  console.log('=== ' + pass + ' pass, ' + fail + ' fail ===');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.log('THROW ' + (e && e.stack || e)); process.exit(1); });
