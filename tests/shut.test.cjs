// T-301 (closed 2026-10-13): the close control and the panel's third state.
//
// The user's own words, in order:
//   01:39  "collapse to header only - showing DEEPAMP - re-expand on mouse over"
//   01:52  "Hover expands and stays open"
// so the panel now has THREE states, not two:
//   open     - header + player + sections
//   collapsed- the header row + the player strip, sections hidden (the -/+ control, T-199 wording)
//   shut     - the header row ALONE, player hidden and sections hidden, the pointer opening it again
//
// What this suite pins, because each one is a way this could have been built wrong:
//   1. shut is persisted (audio-play:shut), so a reload keeps the panel closed to its title bar.
//   2. shut HIDES the player strip and the sections body, it does not unmount them. The <audio> element
//      lives inside the player strip; unmounting that subtree would stop a take that is already playing.
//   3. hover opens a shut panel and it STAYS open - a later mouse-leave does not close it again. That is
//      the 01:52 refinement, and it is the difference between a peek and a shut-release.
//   4. the minimise control is untouched: its titles stay "collapse panel" / "expand panel" VERBATIM
//      (ui_state finds it by those strings), its peek behaviour is unchanged, and minimising releases shut.
//   5. a playback the PANEL started releases shut, so a take the lane finished never plays into a panel the user
//      cannot see. T-375 (user ruling 2026-10-14, "Only autoplay expands"): a take the person started by
//      pressing a control leaves the shut state alone — the mini row is what they are looking at, and it plays there.
//   6. the header still says DEEPAMP while shut - that is the whole point of closing to the title bar.
// Usage: node tests/shut.test.cjs [path/to/client.js]
const path = require('path');
const fs = require('fs');
const { createRuntime, loadClient, openAllSections } = require('./react_shim.cjs');

const TARGET = process.argv[2] || path.join(__dirname, '..', 'lib', 'client.js');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '  ->  ' + JSON.stringify(detail === undefined ? null : detail).slice(0, 240)); }
}
function flush() { return new Promise(function (r) { setTimeout(r, 8); }); }

// The dwell timers are recorded, not executed: the peek is armed by a 3000 ms timer and retracted by a
// 2500 ms one, and a suite that waits for real time is a suite that gets slower and flakier for no reason.
// Recording them lets the test fire the dwell it cares about and say nothing about wall-clock time.
function makeTimer() {
  const armed = [];
  return {
    armed: armed,
    interval: function () { return function () {}; },
    // T-320: the cancel handle is recorded as well as the arming. Without it, "leaving the panel before the
    // dwell fires cancels the dwell" cannot be tested at all - a cancelled dwell and a running dwell would look
    // identical here. Recording the cancellation strengthens the fixture; nothing that used it changes.
    timeout: function (fn, ms) { const rec = { fn: fn, ms: ms, cancelled: false }; armed.push(rec); return function () { rec.cancelled = true; }; },
  };
}
const doc = {
  addEventListener: function () {}, removeEventListener: function () {},
  createElement: function (t) { return { tagName: t, click: function () {} }; },
  body: { appendChild: function () {}, removeChild: function () {} },
};

function makeStore(seed) {
  const store = Object.assign(Object.create(null), seed || {});
  global.localStorage = {
    getItem: function (k) { return k in store ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; },
  };
  return store;
}

// One mounted panel. The fixture carries a playlist row on purpose: several of the shut-release paths are
// only observable when there is something to play.
async function mount(store) {
  const calls = [];
  const timer = makeTimer();
  const audio = {
    tagName: 'audio', paused: true, ended: false, currentTime: 0, duration: 3.44,
    pauseCalls: 0, playCalls: 0, _l: {},
    addEventListener: function (n, f) { (this._l[n] = this._l[n] || []).push(f); },
    removeEventListener: function () {},
    fire: function (n) { (this._l[n] || []).forEach(function (f) { f({ type: n }); }); },
    pause: function () { this.paused = true; this.pauseCalls++; this.fire('pause'); },
    play: function () { this.paused = false; this.ended = false; this.playCalls++; this.fire('play'); return Promise.resolve(); },
    captureStream: function () { return { getAudioTracks: function () { return []; }, getTracks: function () { return []; } }; },
  };
  const shim = createRuntime({
    makeHostNode: function (n) {
      if (n.type === 'audio') return audio;
      if (n.type === 'canvas') return { tagName: 'canvas', getContext: function () { return null; } };
      return { tagName: n.type };
    },
  });
  const client = loadClient(shim, {
    target: TARGET,
    document: doc,
    timer: timer,
    fetch: function (url, o) {
      const u = String(url); calls.push(((o && o.method) || 'GET') + ' ' + u);
      let body = { ok: true };
      if (/get_endpoints/.test(u)) body = { tts: { url: 'http://cpu1.test:8963' }, stt: { url: 'http://cpu1.test:8962' } };
      else if (/server_status/.test(u)) body = { tts: { ok: true, loaded_model: 'cpu2' }, stt: { ok: true } };
      else if (/get_models/.test(u)) body = { models: [{ id: 'm1', loaded: true }] };
      else if (/refresh_voices/.test(u)) body = { voices: ['voy_janeway'], builtins: [] };
      else if (/voice_registry/.test(u)) body = { voices: [{ id: 'voy_janeway', name: 'Janeway' }] };
      else if (/playlist_list/.test(u)) body = {
        items: [{ id: 'ap-9101', fn: 'tts', kind: 'tts', status: 'ok', model: 'm1', voice: 'voy_janeway', duration: 3.44, text: 'the take' }],
        queues: { tts: { paused: false, running: null, queued: 0 }, stt: { paused: false, running: null, queued: 0 } },
      };
      else if (/queue_status/.test(u)) body = { ok: true, queues: { tts: { queued: 0, paused: false, running_ids: [] }, stt: { queued: 0, paused: false, running_ids: [] } } };
      else if (/play_job/.test(u)) body = { ok: true, route_url: '/deepamp/ap-9101', job_id: 'ap-9101' };
      else if (/storage_status/.test(u)) body = { ok: true, base: '/home/deepamp-test/.dsh/deepamp-audio', writable: true };
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
    },
  });
  const comp = client.apply();
  if (!comp) throw new Error('panel did not register');
  let mark = 0;
  function commit() {
    const bag = {}; const start = shim.rt.created.length;
    shim.render(comp(), bag); shim.runEffects();
    mark = start;
    return bag;
  }
  function created() { return shim.rt.created.slice(mark); }
  function hasCls(c, want) { return String(c || '').split(/\s+/).indexOf(want) >= 0; }
  function els(cls) { return created().filter(function (e) { return e.props && hasCls(e.props.className, cls); }); }
  function btnByTitle(re) {
    const all = created().filter(function (e) { return e.type === 'button' && re.test(String(e.props && e.props.title)); });
    return all.length ? all[all.length - 1] : null;
  }
  function panelEl() { const p = els('audio-play-panel'); return p.length ? p[p.length - 1] : null; }
  // The sections body is the panel's one scroll container (T-121). It is identified by its 66vh cap, which
  // is what ui_state uses too - this suite must look at the SAME element the layout contract names.
  function bodyEl() {
    const all = created().filter(function (e) { return e.type === 'div' && e.props && e.props.style && e.props.style.maxHeight === '66vh'; });
    return all.length ? all[all.length - 1] : null;
  }
  function playerEl() { const p = els('audio-play-player'); return p.length ? p[p.length - 1] : null; }
  function audioEls() { return created().filter(function (e) { return e.type === 'audio'; }); }
  function titleWord() {
    const t = els('audio-play-title');
    if (!t.length) return '';
    const c = t[t.length - 1].props.children;
    return (typeof c === 'string') ? c : '';
  }
  function hoverIn() { const p = panelEl(); if (p && typeof p.props.onMouseEnter === 'function') p.props.onMouseEnter({}); }
  function hoverOut() { const p = panelEl(); if (p && typeof p.props.onMouseLeave === 'function') p.props.onMouseLeave({}); }
  async function open() {
    let bag = commit(); await flush();
    await openAllSections(shim, comp);
    bag = commit(); await flush(); bag = commit(); await flush();
    return bag;
  }
  return {
    shim: shim, comp: comp, audio: audio, calls: calls, commit: commit, created: created, els: els,
    btnByTitle: btnByTitle, panelEl: panelEl, bodyEl: bodyEl, playerEl: playerEl, audioEls: audioEls,
    titleWord: titleWord, hoverIn: hoverIn, hoverOut: hoverOut, open: open, armed: timer.armed,
  };
}

function teardown() { delete global.localStorage; }

(async function main() {
  const src = fs.readFileSync(TARGET, 'utf8');

  // 0. the state exists in the client as a persisted key, and it is a THIRD state, not a rename of collapse.
  check('T-301: the shut state is persisted under its own storage key',
    /LS_SHUT301 = "deepamp:shut"/.test(src), src.indexOf('deepamp:shut'));
  check('T-301: showBody is built from shut AND collapse, so shut sits above collapse rather than replacing it',
    /var showBody = !shut301 && \(!collapsed \|\| hoverPeek\);/.test(src), 'showBody');
  check('T-301 SAFETY: the player strip is switched to display none, not unmounted (the media element lives there)',
    /display: \(shut301 \? "none" : "flex"\)/.test(src), 'player strip');

  // ---------------------------------------------------------------- A. close, from an open panel
  let store = makeStore({});
  let m = await mount(store);
  await m.open();
  check('T-301: an open panel shows the player strip and the sections body',
    m.playerEl() && m.playerEl().props.style.display === 'flex' && m.bodyEl() && m.bodyEl().props.style.display === undefined,
    [m.playerEl() && m.playerEl().props.style.display, m.bodyEl() && m.bodyEl().props.style.display]);
  check('T-312: an OPEN panel has no mini row - the header stays the T-300 U-15 shape (spacer, centred title, controls)',
    m.els('audio-play-mini312').length === 0 && m.els('audio-play-vol312').length === 0,
    [m.els('audio-play-mini312').length, m.els('audio-play-vol312').length]);
  const closeBtn = m.btnByTitle(/close this panel down to its title bar/);
  check('T-301: the close control is there, and its hover says what it does and how it opens again',
    !!closeBtn && /move the mouse onto it to open it again/.test(String(closeBtn.props.title)), closeBtn && closeBtn.props.title);
  closeBtn.props.onClick();
  m.commit();
  check('T-301: pressing close writes audio-play:shut', store['deepamp:shut'] === '1', store['deepamp:shut']);
  check('T-301: a shut panel hides the player strip and the sections body',
    m.playerEl().props.style.display === 'none' && m.bodyEl().props.style.display === 'none',
    [m.playerEl().props.style.display, m.bodyEl().props.style.display]);
  // T-405 added the station's own element. T-301's rule is untouched and gets stronger: a closed panel mounts
  // nothing away, so BOTH media elements are still there, still reachable, still able to finish what they were
  // doing while the panel was closed.
  // T-603 RE-POINT (2026-10-27): three media elements now, the third carrying a crossfade tail — and the rule is
  // the same one, only wider: a closed panel unmounts none of them, so a tail that was mid-handover when the
  // panel was closed is not orphaned either. The count moved because a card asked for both sides of a handover
  // to move; the rule this pin guards is the one that did not move.
  check('T-301 CONTRACT: nothing is unmounted - all three media elements are still in the tree while shut',
    m.audioEls().length === 3, m.audioEls().length);
  check('T-301: the header still prints DEEPAMP, which is the whole point of closing to the title bar',
    m.titleWord() === 'DEEPAMP', m.titleWord());
  check('T-301: the close button now reads as the way back in, and it still says the pointer works',
    /closed to its title bar/.test(String(m.btnByTitle(/closed to its title bar/) && m.btnByTitle(/closed to its title bar/).props.title)),
    m.btnByTitle(/closed to its title bar/) && m.btnByTitle(/closed to its title bar/).props.title);
  check('T-301: a shut panel offers no resize grip (there is no body to resize)',
    m.els('audio-play-resize-grip').length === 0, m.els('audio-play-resize-grip').length);

  // T-312 (user 2026-10-13 06:36 + 07:35): "in this mode should only show header", then "add volume slider and
  // smaller play control buttons to the header in this single row mode - should be minimal controls - like
  // winamp had them", then the exact limit: "limit it to prev, play, pause, stop, next and rec and volume
  // slider, ... the DEEPAMP logo should move to the left in this mode, followed by the buttons, with star, + and
  // X staying in place". The closed panel is therefore a MINI PLAYER, and the mini row is the strip's own
  // transport at 0.62 of its boxes (40x31 -> 25x19), same handlers, same hovers, record keeping the row's width
  // factor 1.4 and the mini row's height (35x19) - the T-316 rule, at mini scale. The eject is deliberately
  // absent: the user named six controls and eject is a panel action, not a transport one.
  const mini312 = m.els('audio-play-mini312');
  check('T-312: a shut panel carries exactly ONE mini row in the header, and it is NOT the strip - the strip keeps its own class and stays mounted',
    mini312.length === 1 && m.els('audio-play-transport').length === 1, [mini312.length, m.els('audio-play-transport').length]);
  const miniBtns = m.created().filter(function (e) {
    return e.type === 'button' && e.props && e.props.style && e.props.style.width === '25px' && e.props.style.height === '19px';
  });
  // T-316 MIGRATION (user ruling 2026-10-14): the mini row's five controls are drawn as inline SVG too, so
  // the order is read off the classes the buttons carry. Same five verbs, same 25x19 boxes, same centring.
  const miniWord316 = function (e) {
    const c = String((e.props && e.props.className) || '').split(/\s+/);
    const hit = ['prev', 'play', 'pause', 'stop', 'next'].filter(function (w) { return c.indexOf('audio-play-tp-' + w) >= 0; });
    return hit.length ? hit[0] : String(e.props && e.props.children);
  };
  check('T-312: the mini transport is prev, play, pause, stop, next at 25x19 (0.62 of the strip box), in that order, centred like the strip, and T-316: every one of them is DRAWN as an inline svg',
    miniBtns.length === 5
    && miniBtns.map(miniWord316).join(',') === 'prev,play,pause,stop,next'
    && miniBtns.every(function (e) { return !!(e.props.children && e.props.children.type === 'svg'); })
    && miniBtns.every(function (e) { const st = e.props.style; return st.padding === '0' && st.lineHeight === '1' && st.boxSizing === 'border-box' && st.display === 'inline-flex' && st.alignItems === 'center' && st.justifyContent === 'center'; }),
    miniBtns.map(function (e) { return [miniWord316(e), e.props.style.width, e.props.style.height, !!(e.props.children && e.props.children.type === 'svg')]; }));
  const miniRec = m.created().filter(function (e) {
    return e.type === 'button' && e.props && e.props.style && e.props.style.width === '35px' && e.props.style.height === '19px';
  });
  check('T-312: the mini row carries the record button - wider (35px) and the SAME 19px height, never shorter',
    miniRec.length === 1, miniRec.length);
  check('T-312: the mini row carries its own volume slider at the 484px default (its own class, so the strip slider is not double-counted)',
    m.els('audio-play-vol312').length === 1, m.els('audio-play-vol312').length);
  const clsSeq = m.created().map(function (e) { return (e.props && e.props.className) || ''; });
  const ixId312 = clsSeq.lastIndexOf('audio-play-head-id');
  const ixPad312 = clsSeq.lastIndexOf('audio-play-head-pad');
  check('T-312: the logo moved to the LEFT edge - the title group is created BEFORE the spacer that pushes star / + / X to the right edge',
    ixId312 > 0 && ixPad312 > ixId312, [ixId312, ixPad312]);
  // RE-POINTED 2026-10-28 by T-680 (the operator's mini bug: "when in minimised (closed mode) - the reset button
  // messes up the canvas size - maybe do not show reset button in miniplayer mode"), and RE-POINTED AGAIN the same
  // day by the operator's correction of that build ("i wanted the reset button only remoed in the closed
  // mini-bar-state"). The closed bar is the one shape where a maximise has nothing to put back; the minimised
  // header and the full panel keep their three controls, and the ui_state suite pins those shapes.
  check('T-312, re-pointed by T-680 and by its correction the same day: the closed mini-bar carries its two window controls - collapse and close - and no maximise. The maximise is the control the operator named as the one that does not belong in this shape',
    !m.btnByTitle(/maximise \/ reset panel size/) && !!m.btnByTitle(/^collapse panel$/) && !!m.btnByTitle(/closed to its title bar/),
    [m.btnByTitle(/maximise \/ reset panel size/), m.btnByTitle(/^collapse panel$/)]);
  // T-550 (user 2026-10-17, verbatim): "the Header button to 'reset size and position' symbol - currently is a
  // '5 point star' - should be replaced with an R - or do you have another suggestion for a good symbol ?". The mark
  // is now an anticlockwise open circle arrow: it is the mark people already read as put-it-back-the-way-it-was, and
  // the letter R was not chosen because a panel whose dot-matrix clock has a red disc meaning RECORD should not put a
  // lone R on its window chrome meaning something else. The star said nothing about the act either. The alternative is
  // one character in lib/client.js if the user prefers their own suggestion. What is pinned is that the hover - the
  // thing that actually carries the three parts of this act - did not change with the glyph.
  // RE-POINTED 2026-10-28 by T-680's correction (operator, verbatim: "i see another bug introduced - you removed
  // the reset button in the player if in "default player size" - but i wanted the reset button only remoed in the
  // "closed mini-bar-state""). This scenario is the closed mini-bar, where the control is not mounted, so the glyph
  // and its hover are measured on the shape the control does belong to - the minimised header, reached by the toggle
  // the closed bar already carries. The panel is closed to its bar again at the end, because every later shut pin
  // here measures the closed state.
  (function () {
    m.btnByTitle(/^collapse panel$/).props.onClick(); m.commit();
    check('T-680 correction, measured on the tree: the minimised header keeps its three window controls. The '
        + 'maximise belongs to every shape that has a size to put back, and the closed mini-bar is the only shape '
        + 'that does not offer it',
      !!m.btnByTitle(/maximise \/ reset panel size/) && !!m.btnByTitle(/^expand panel$/)
        && !!m.btnByTitle(/close this panel down to its title bar/),
      [!!m.btnByTitle(/maximise \/ reset panel size/), !!m.btnByTitle(/^expand panel$/)]);
    const resetBtn550 = m.btnByTitle(/maximise \/ reset panel size/);
    const glyph550 = resetBtn550 ? String(resetBtn550.props.children || '') : '';
    const hover550 = resetBtn550 ? String(resetBtn550.props.title || '') : '';
    check('T-550: the reset control wears the anticlockwise arrow rather than the star, and the hover that names all three parts of the act is untouched by the swap',
      glyph550 === '\u21BA' && glyph550 !== '\u26E4' && glyph550 !== 'R'
      && /canvas width/.test(hover550) && /import/.test(hover550) && /drag the bottom-right corner/.test(hover550),
      { glyph: glyph550, glyph_code: glyph550 ? glyph550.codePointAt(0).toString(16) : '', hover: hover550.slice(0, 90) });
    // Back to the closed bar, the state this file measures from here on.
    m.btnByTitle(/^expand panel$/).props.onClick(); m.commit();
    m.btnByTitle(/close this panel down to its title bar/).props.onClick(); m.commit();
  })();
  check('T-312: a mini button never starts a window drag - each one stops the header mousedown',
    miniBtns.every(function (e) { return typeof e.props.onMouseDown === 'function'; }), miniBtns.length);

  // ---------------------------------------------------------------- B. hover opens it, and it STAYS open
  // T-320 (user 2026-10-13, 09:24) re-pinned this block IN PLACE rather than removing it. The complaint was
  // "in minimized mode, the timer is missing so it instantly re-opens on mouse over". All three T-301 promises
  // still stand - hover opens a shut panel, opening clears the persisted state, and it stays open afterwards -
  // but "opens" now means "opens after the dwell", the same dwell the collapsed player has always had.
  m.hoverIn();
  m.commit();
  const shutDwell320 = m.armed.filter(function (t) { return t.ms === 3000 && !t.cancelled; }).pop();
  check('T-320 (user: "in minimized mode, the timer is missing so it instantly re-opens on mouse over"): entering a shut panel arms the dwell instead of opening on the spot',
    !!shutDwell320 && m.playerEl().props.style.display === 'none' && m.bodyEl().props.style.display === 'none',
    [m.armed.map(function (t) { return t.ms; }), m.playerEl().props.style.display]);
  check('T-301 (user 01:39), kept in substance: the dwell opens a shut panel again',
    (function () { if (shutDwell320) shutDwell320.fn(); m.commit(); return m.playerEl().props.style.display === 'flex' && m.bodyEl().props.style.display === undefined; })(),
    [m.playerEl().props.style.display, m.bodyEl().props.style.display]);
  check('T-301, kept: opening by hover clears the persisted state, so a reload does not close it back down',
    store['deepamp:shut'] === '0', store['deepamp:shut']);
  m.hoverOut();
  m.commit();
  check('T-301 (user 01:52: "Hover expands and stays open"), kept: moving the mouse away does NOT close it again',
    m.playerEl().props.style.display === 'flex' && m.bodyEl().props.style.display === undefined,
    [m.playerEl().props.style.display, m.bodyEl().props.style.display]);
  check('T-320: the leave handler still refuses to re-close a released panel, and it now cancels a dwell that has not fired',
    /if \(shut301\) \{ clearHoverTimer\(\); return; \}/.test(src), 'onPanelLeave body');

  // ---------------------------------------------------------------- C. the minimise control is untouched
  const minBtn = m.btnByTitle(/^collapse panel$/);
  check('T-199 wording, kept VERBATIM: the minimise control is still titled "collapse panel"',
    !!minBtn && minBtn.props.title === 'collapse panel', minBtn && minBtn.props.title);
  minBtn.props.onClick();
  m.commit();
  check('T-301: minimising from an open panel hides the sections body and KEEPS the player strip (unchanged T-300 contract)',
    m.bodyEl().props.style.display === 'none' && m.playerEl().props.style.display === 'flex',
    [m.bodyEl().props.style.display, m.playerEl().props.style.display]);
  check('T-312: minimise is NOT the shut mode - a minimised panel keeps its full strip and gets no mini row',
    m.els('audio-play-mini312').length === 0 && m.els('audio-play-transport').length === 1,
    [m.els('audio-play-mini312').length, m.els('audio-play-transport').length]);
  check('T-199 wording, kept VERBATIM: minimised, the same control is titled "expand panel"',
    (function () { const b = m.btnByTitle(/^expand panel$/); return !!b && b.props.title === 'expand panel'; })(),
    m.btnByTitle(/^expand panel$/) && m.btnByTitle(/^expand panel$/).props.title);
  // T-418 (user 2026-10-15): "the 'minimize' button to restore to player height: should 'auto-close EQ and
  // PL' -> so they can be re-pressed to trigger expansion again". The press above minimised the panel. The two
  // sections the EQ and PL buttons navigate to have to be closed by that same press, and the lamps inside the
  // buttons have to say so; then the buttons have to bring the sections back.
  const sec418 = JSON.parse(store['deepamp:sections'] || '{}');
  check('T-418: minimising closes the Playlist and the Voices section, and the closure is persisted',
    sec418.__pl === false && sec418.__voi === false, store['deepamp:sections']);
  check('T-418: both lamps are out - neither button claims an open section',
    (function () {
      const eq = m.els('audio-play-tp-eq386').pop(), pl = m.els('audio-play-tp-pl386').pop();
      const out = function (b) {
        if (!b) return false;
        const kids = (b.props.children || []).filter(function (c) { return c && c.props && c.props.className === 'audio-play-tp-lamp388'; });
        return kids.length === 1 && kids[0].props.style.background === '#3a3f46';
      };
      return out(eq) && out(pl);
    })(), (function () { const e = m.els('audio-play-tp-eq386').pop(); return e && e.props; })());
  (function () { const b = m.els('audio-play-tp-eq386').pop(); if (b) b.props.onClick(); })();
  m.commit();
  const sec418b = JSON.parse(store['deepamp:sections'] || '{}');
  check('T-418: pressing EQ again re-opens the Voices section and expands the panel back',
    sec418b.__voi === true && m.bodyEl().props.style.display !== 'none' && !!m.btnByTitle(/^collapse panel$/),
    [store['deepamp:sections'], m.bodyEl().props.style.display, !!m.btnByTitle(/^collapse panel$/)]);
  check('T-418: minimising again does NOT re-open the Playlist section - the closed state is what a refresh restores',
    (function () {
      const b = m.btnByTitle(/^collapse panel$/); if (!b) return false;
      b.props.onClick(); m.commit();
      const s = JSON.parse(store['deepamp:sections'] || '{}');
      return s.__pl === false;
    })(), store['deepamp:sections']);

  // The peek is the collapse behaviour the suites already depend on, dwell and all: entering a minimised
  // panel arms a 3 s dwell (it must NOT pop open at once - the always-visible player strip is under the
  // pointer on purpose), the dwell peeks the body, and leaving retracts it 2.5 s later. shut must not have
  // eaten any of that. As of T-320 shut and collapse share the SAME dwell number - which is what the user
  // asked for - so the two modes differ in what they open, not in how long they wait for the pointer.
  m.hoverIn(); m.commit();
  check('T-301 did not break collapse: a minimised panel does not peek at once (the 3 s dwell still rules)',
    m.bodyEl().props.style.display === 'none', m.bodyEl().props.style.display);
  const dwell = m.armed.filter(function (t) { return t.ms === 3000; }).pop();
  check('T-301 did not break collapse: entering a minimised panel arms the 3 s dwell timer',
    !!dwell, m.armed.map(function (t) { return t.ms; }));
  if (dwell) { dwell.fn(); m.commit(); }
  check('T-301 did not break collapse: the dwell peeks the body open',
    m.bodyEl().props.style.display === undefined, m.bodyEl().props.style.display);
  m.hoverOut(); m.commit();
  const retract = m.armed.filter(function (t) { return t.ms === 2500; }).pop();
  check('T-301 did not break collapse: leaving arms the 2.5 s retract instead of closing at once',
    !!retract, m.armed.map(function (t) { return t.ms; }));
  if (retract) { retract.fn(); m.commit(); }
  check('T-301 did not break collapse: the peek is taken back after the retract delay',
    m.bodyEl().props.style.display === 'none', m.bodyEl().props.style.display);
  // And minimising a SHUT panel releases shut rather than stacking two hidden states on top of each other.
  m.btnByTitle(/close this panel down to its title bar/).props.onClick(); m.commit();
  check('T-301: close works again after a peek cycle (the state is not one-shot)',
    m.playerEl().props.style.display === 'none' && store['deepamp:shut'] === '1',
    [m.playerEl().props.style.display, store['deepamp:shut']]);
  m.btnByTitle(/^expand panel$/).props.onClick(); m.commit();
  check('T-301: minimising while shut releases shut (one hidden state at a time, and the strip comes back)',
    store['deepamp:shut'] === '0' && m.playerEl().props.style.display === 'flex',
    [store['deepamp:shut'], m.playerEl().props.style.display]);
  teardown();

  // ---------------------------------------------------------------- D. shut survives a reload
  store = makeStore({ 'deepamp:shut': '1' });
  m = await mount(store);
  await m.open();
  check('T-301: a panel reloaded with audio-play:shut comes up closed to its title bar',
    m.playerEl().props.style.display === 'none' && m.bodyEl().props.style.display === 'none',
    [m.playerEl().props.style.display, m.bodyEl().props.style.display]);
  // RE-POINTED 2026-10-28 by T-680 and its correction the same day: a panel reloaded into the closed bar comes up
  // with TWO window controls - collapse and close - and the maximise is not offered here. The operator named that
  // control as the one this shape must not carry; the two controls that reach a shape it fits are untouched.
  check('T-301, re-pointed by T-680: and it comes up with its header word and its two window controls, nothing else visible',
    m.titleWord() === 'DEEPAMP' && !!m.btnByTitle(/closed to its title bar/) && !!m.btnByTitle(/^collapse panel$/)
      && !m.btnByTitle(/maximise \/ reset panel size/),
    [m.titleWord(), !!m.btnByTitle(/maximise \/ reset panel size/)]);
  // T-603 RE-POINT (2026-10-27): three media elements now; the rule — a closed panel orphans nothing that is playing — is unchanged.
  check('T-301 through T-603: the closed panel still holds its media elements, so a take, a station, or a crossfade tail started elsewhere is not orphaned',
    m.audioEls().length === 3, m.audioEls().length);

  // ---------------------------------------------------------------- E. who may release shut (T-301 narrowed by T-375)
  const playBtn = m.btnByTitle(/play the row the transport is on/);
  check('T-301: the closed panel can still reach its own row (the section body is hidden, not gone)',
    !!playBtn, !!playBtn);
  if (playBtn) { playBtn.props.onClick(); await flush(); m.commit(); await flush(); }
  // T-375 (user ruling 2026-10-14, chosen from the options offered: "Only autoplay expands"). This is the press
  // case: the button is the panel's own transport play, reached from the shut header row. The user's words for
  // what used to happen: "if i hit play in the collapsed mini player in header, the window still instantly
  // expands, -> should stay small". The take starts, the row plays it, and the window stays the size it was.
  check('T-375: a press on the transport while the panel is shut keeps it shut - the take plays in the one row '
      + 'the person is already looking at',
    store['deepamp:shut'] === '1' && m.playerEl().props.style.display === 'none',
    [store['deepamp:shut'], m.playerEl().props.style.display]);
  check('T-375: and the take still started on the element that survived being hidden - staying small is not '
      + 'staying silent',
    m.audio.playCalls >= 1, m.audio.playCalls);
  // The other half of the ruling is the case T-301 was built for: a take the PANEL started. It is pinned here as
  // the shape of the funnel, because no harness in this project drives the poll that fires autoplay.
  check('T-375: the playback funnel keeps the distinction the ruling asks for - the shut release is gated on '
      + 'who started the take, and the flag is a parameter of that one funnel every playback path goes through',
    /if \(shut301 && panelStarted375\)/.test(src)
      && /function queuePlayback\(url, label, force, panelStarted375\)/.test(src),
    [(src.match(/if \(shut301.*/) || [''])[0], (src.match(/function queuePlayback\(.*/) || [''])[0]]);
  check('T-375: exactly the two autoplay call sites claim it - the agent fresh-take sweep and a panel-dispatched '
      + 'job that just settled ok - and the ordered chunk inserter carries it through',
    (src.match(/, false, true\);   \/\/ T-375: the panel started this/g) || []).length === 2
      && /queuePlayback\(nxt\.url, nxt\.label, false, panelStarted375\)/.test(src),
    [(src.match(/, false, true\);   \/\/ T-375: the panel started this/g) || []).length, (src.match(/queuePlayback\(nxt[^)]*\)/) || [''])[0]]);
  check('T-375: and no press call site claims it - the transport walk, a row play button, a row source play and a '
      + 'stem all still hand three arguments at most',
    /queuePlayback\(r\.route_url, row\.id, true\)/.test(src)
      && /queuePlayback\(r\.route_url, id, true\)/.test(src)
      // RE-POINTED IN PLACE 2026-10-21 (T-627): the source play and the stem play now build their route into a
      // local name BEFORE the interrupt, because a press has to ask "is this the file that is paused?" before it
      // drops the queue. The route is the same string; only where it is spelled changed. The claim this pin guards
      // is unchanged - no press hands the funnel a fourth argument - so it is measured on the call, not on the
      // literal that used to sit inside it.
      && /var u627 = "\/deepamp\/" \+ encodeURIComponent\(id\) \+ "\?src=1";[\s\S]{0,400}?queuePlayback\(u627, id, true\)/.test(src)
      && /var u627 = "\/deepamp\/" \+ encodeURIComponent\(id\) \+ "\?stem=" \+ encodeURIComponent\(stemId\);[\s\S]{0,400}?queuePlayback\(u627, id \+ " \\u00B7 " \+ stemId, true\)/.test(src),
    [(src.match(/queuePlayback\([^;]*true\)/g) || []).length]);
  teardown();

  // ---------------------------------------------------------------- F. a shut panel does not lose the transport
  // The user's rule "our single window we have should keep the vertical devised arrangement" still applies
  // while open; while shut the panel is one row. The transport row must not be duplicated by the shut state.
  store = makeStore({});
  m = await mount(store);
  await m.open();
  check('T-300 arrangement: an open panel has exactly one transport row and one play control',
    m.els('audio-play-transport').length === 1 && m.els('audio-play-seek').length === 1,
    [m.els('audio-play-transport').length, m.els('audio-play-seek').length]);
  m.btnByTitle(/close this panel down to its title bar/).props.onClick(); m.commit();
  check('T-301: closing hides that one transport row instead of replacing it with a second one',
    m.els('audio-play-transport').length === 1 && m.playerEl().props.style.display === 'none',
    [m.els('audio-play-transport').length, m.playerEl().props.style.display]);
  teardown();

  // ---------------------------------------------------------------- G. T-320: one dwell setting, and 0 switches hover-opening off in both modes
  // (user 2026-10-13, 09:24): "the auto-expands should also get a setting for the timer in settings with 0 to
  // disable auto-expand on mouse over for player and mini-player mode".
  store = makeStore({ 'deepamp:shut': '1', 'deepamp:hover.ms': '1200' });
  m = await mount(store);
  await m.open();
  m.hoverIn(); m.commit();
  const armed320 = m.armed.filter(function (t) { return t.ms === 1200; });
  check('T-320: the dwell is READ from the store - a stored 1200 arms 1200, not the built-in 3000',
    armed320.length === 1, m.armed.map(function (t) { return t.ms; }));
  m.hoverOut(); m.commit();
  check('T-320: leaving before the dwell ends CANCELS it, and the panel stays closed to its title bar',
    (armed320[0] || {}).cancelled === true && m.playerEl().props.style.display === 'none' && store['deepamp:shut'] === '1',
    [(armed320[0] || {}).cancelled, m.playerEl().props.style.display, store['deepamp:shut']]);
  check('T-320: while the dwell runs the panel is still the mini header - the mini row is on screen, not the body',
    m.els('audio-play-mini312').length === 1 && m.bodyEl().props.style.display === 'none',
    [m.els('audio-play-mini312').length, m.bodyEl().props.style.display]);
  teardown();

  store = makeStore({ 'deepamp:shut': '1', 'deepamp:hover.ms': '0' });
  m = await mount(store);
  await m.open();
  m.hoverIn(); m.commit();
  check('T-320 (user: "0 to disable auto-expand on mouse over for player and mini-player mode"): at dwell 0 a shut panel arms no dwell and stays closed',
    m.armed.filter(function (t) { return t.ms === 3000 || t.ms === 1200 || t.ms === 2500; }).length === 0
    && m.playerEl().props.style.display === 'none' && store['deepamp:shut'] === '1',
    [m.armed.map(function (t) { return t.ms; }), store['deepamp:shut']]);
  const closeShut320 = m.btnByTitle(/closed to its title bar/);
  check('T-320: at dwell 0 the close control says the pointer will NOT open it, instead of promising what the setting refuses to do',
    /auto-expand on mouse-over is switched off/.test(String(closeShut320 && closeShut320.props.title)),
    closeShut320 && closeShut320.props.title);
  if (closeShut320) { closeShut320.props.onClick(); m.commit(); }
  check('T-320: dwell 0 does not trap the panel - the explicit click still opens it',
    store['deepamp:shut'] === '0' && m.playerEl().props.style.display === 'flex',
    [store['deepamp:shut'], m.playerEl().props.style.display]);
  teardown();

  // The PLAYER half of the same number: one setting governs the collapsed peek too.
  store = makeStore({ 'deepamp:collapsed': '1', 'deepamp:hover.ms': '0' });
  m = await mount(store);
  await m.open();
  m.hoverIn(); m.commit();
  check('T-320: dwell 0 also switches the peek off in the collapsed player (one setting, both modes, as asked)',
    m.armed.filter(function (t) { return t.ms === 3000 || t.ms === 1200 || t.ms === 2500; }).length === 0
    && m.bodyEl().props.style.display === 'none',
    [m.armed.map(function (t) { return t.ms; }), m.bodyEl().props.style.display]);
  teardown();

  // And the control that owns it: a number field in Settings, 0 allowed, ceiling enforced, and it writes the store.
  store = makeStore({});
  m = await mount(store);
  await m.open();
  const hov320 = m.created().filter(function (e) {
    return e.type === 'input' && /before it opens itself/.test(String((e.props && e.props.title) || ''));
  });
  check('T-320: Settings carries the auto-expand dwell as its own number input',
    hov320.length === 1, hov320.length);
  if (hov320.length === 1) {
    const p320 = hov320[0].props;
    check('T-320: the field allows 0 (the user asked for it) and caps at 10 s',
      p320.min === 0 && p320.max === 10000 && p320.value === 3000, [p320.min, p320.max, p320.value]);
    p320.onChange({ target: { value: '0' } }); m.commit();
    check('T-320: setting it to 0 WRITES the store (the value is kept, not just used)',
      store['deepamp:hover.ms'] === '0', store['deepamp:hover.ms']);
    p320.onChange({ target: { value: '999999' } }); m.commit();
    check('T-320: an out-of-range dwell is clamped by the input, so what is typed and what is restored agree',
      store['deepamp:hover.ms'] === '10000', store['deepamp:hover.ms']);
  }
  teardown();

  // T-397 (T-387 item 9, user 2026-10-14): "hide the closed mini-player's full-width line". Measured live in the shut
  // state before the change: the panel is 484 x 45 and the header row is a 458 x 37 div carrying borderBottom 1px — a
  // rule running the whole width of a window that is already framed. In the open state that same rule is the line
  // between the title row and the player, where it has a job, so only the shut state drops it. Measured live after the
  // change: the shut header div reports borderBottomWidth 0px at 458 x 36.
  {
    // read off the file under test (TARGET), not off the shipped path: a source pin that always reads the shipped
    // file cannot be shown to fail against a copy, which is what a negative control is for.
    const src397 = fs.readFileSync(TARGET, 'utf8');
    // RE-POINTED IN PLACE 2026-10-21 by T-628 (the operator's own request, verbatim: "in the player view, below the
    // header logo, and below the winows-icons we have one small horizontal line - i would like it removed so we save a
    // few pixel height in the default player view"). The measure that stood here pinned the shut-only override
    // `{ borderBottom: "0px" }`, which was the whole of T-397: the open state kept the rule because it "has a job".
    // The operator has overruled that for the open state, so the rule is no longer in headerStyle at all and the
    // override it needed is gone. What this check now measures is the claim underneath the old literal - the header
    // row carries NO horizontal rule in EITHER state - and it is measured on the rendered style, not on the source.
    function hdr628(m) {
      return m.created().filter(function (e) {
        return e.type === 'div' && typeof e.props.onMouseDown === 'function' && e.props.style && e.props.style.cursor === 'move';
      }).pop();
    }
    const open628 = await mount(makeStore({})); await open628.open();
    const ho = hdr628(open628);
    check('T-628: the open player view has NO horizontal line under the logo and the window icons - the header row renders no border at all',
      !!ho && !ho.props.style.borderBottom && !ho.props.style.borderTop,
      ho ? { borderBottom: ho.props.style.borderBottom, borderTop: ho.props.style.borderTop } : 'no header div');
    // RE-POINTED 2026-10-28 by T-682 (the operator's centring request, quoted at the client comment). T-628's point
    // was that the space the removed line sat in is reclaimed - 8px of padding minus the 1px rule and its breathing
    // room, 5px where it used to be 8px. That total is still exactly 10px of vertical padding, which is what this
    // pin has always been about; the two numbers are now split 7.5 above and 2.5 below, because the band the
    // content must centre in carries the panel's 1px border above the row and the strip's 6px margin below it. The
    // row's own height is unchanged, and that is why the canvas does not move.
    check('T-628, re-pointed by T-682: the height the line sat in is still reclaimed - the open header row carries 10px of vertical padding (7.5px above, 2.5px below, centred on the band that reaches the canvas) where the rule left 8px of it',
      !!ho && ho.props.style.padding === '7.5px 0 2.5px', ho && ho.props.style.padding);
    check('T-628 source: no header rule is left in the shared style, and no render path re-adds one',
      !/var headerStyle = \{[^\n]*borderBottom/.test(src397) && !/headerStyle, \{ borderBottom/.test(src397)
      && (src397.match(/style: headerStyle\}/g) || []).length === 0,
      { bare: (src397.match(/style: headerStyle\}/g) || []).length });
    const shut628 = await mount(makeStore({ 'deepamp:shut': '1' })); await shut628.open();
    const hs = hdr628(shut628);
    check('T-628 keeps T-397’s measurement: the closed bar is untouched - still no rule, and still its own 8px padding (it carries the mini transport and the volume slider)',
      !!hs && !hs.props.style.borderBottom && hs.props.style.padding === '8px 0',
      hs ? { borderBottom: hs.props.style.borderBottom, padding: hs.props.style.padding } : 'no header div');
    const boxes682 = function (mm) {
      return mm.created().filter(function (e682) {
        if (e682.type !== 'button') return false;
        const t682 = String(e682.props.title || '');
        return /maximise \/ reset panel size/.test(t682) || /^(collapse|expand) panel$/.test(t682)
          || /down to its title bar|is closed to its title bar/.test(t682);
      });
    };
    const boxRule682 = function (b682) {
      const st = (b682.props || {}).style || {};
      // The client's own literal for the box is `padding: 0` - a number, not a string. The rule being pinned is one
      // box for all three controls, so the reading is tolerant here on purpose: a zero padding is a zero padding
      // however the style object spells it.
      return st.height === '18px' && st.lineHeight === '18px' && st.width === '24px'
        && (st.padding === 0 || st.padding === '0' || st.padding === undefined);
    };
    const boxShape682 = function (list) {
      return list.map(function (b682) { return [b682.props.style.width, b682.props.style.height, b682.props.style.lineHeight]; });
    };
    check('T-682: the three window boxes carry ONE height in both shapes - the same named value in the open row and '
        + 'in the closed bar, with the mark centred in it by a line box set to that height. The operator named this '
        + 'as a rule: "buttons should not change height during switching"',
      (function () {
        const o682 = boxes682(open628), s682 = boxes682(shut628);
        return o682.length === 3 && s682.length === 2 && o682.every(boxRule682) && s682.every(boxRule682);
      })(),
      { open: boxShape682(boxes682(open628)), shut: boxShape682(boxes682(shut628)) });
  }

  console.log('=== ' + pass + ' pass, ' + fail + ' fail ===');
  if (fail) process.exit(1);
})().catch(function (e) {
  console.log('THROW: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
