// T-603 (2026-10-27) — the crossfade between the takes auto play hands over, step 1.
// What is pinned here, in the operator's own words for the card (2026-10-19, refined 2026-10-21): a fade BETWEEN
// auto-play arrivals; two music arrivals both move; a handover with music on one side and speech on the other
// fades ONLY the music side, because "a fade across the first words of a spoken line blurs the line"; speech
// into speech is left alone; the switch is OFF until a person turns it on; the length is stored only once it is
// changed; and a press that takes control must not leave a fade running.
// No audio is played, nothing is dispatched to a real lane, no endpoint is contacted, and no synthetic audio is
// made anywhere in this file. The fade is measured as the level the panel puts on its own media element.
// Usage: node tests/crossfade603.test.cjs [path/to/client.js]
const path = require('path');
const { createRuntime, loadClient, openAllSections } = require('./react_shim.cjs');

const TARGET = process.argv[2] || path.join(__dirname, '..', 'lib', 'client.js');
const SRC = require('fs').readFileSync(TARGET, 'utf8');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail !== undefined ? '  ->  ' + JSON.stringify(detail).slice(0, 240) : '')); }
}
function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function mkLs(seed) {
  return {
    s: seed || {},
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(this.s, k) ? this.s[k] : null; },
    setItem: function (k, v) { this.s[k] = String(v); },
  };
}

// --- the pure half, taken out of the file and run as it is written ----------------------------------------
// These carry the whole decision of the card, and they close over nothing, so the suite can hold them without a
// panel. It is the same technique tests/host.test.cjs already uses. T-838 (2026-11-14) added two more to the set:
// the length floor is a decision too, and a decision this file can hold up without a browser is one it can trust
// the panel to make the same way at play time.
function grabFn(name) {
  const at = SRC.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('the source has no function named ' + name);
  let i = SRC.indexOf('{', at), depth = 0, end = -1;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error('unbalanced body for ' + name);
  return SRC.slice(at, end + 1);
}
// T-838: the ratio is read out of the panel's own source, not restated here, so this file cannot drift from the
// number the panel actually uses. A source that stopped carrying it fails here rather than quietly re-declaring it.
const RATIO838 = /var CROSSFADE_MIN_TAKE_RATIO603 = (\d+);/.exec(SRC);
if (!RATIO838) throw new Error('the source has no CROSSFADE_MIN_TAKE_RATIO603 to read');
const pure603 = new Function(
  grabFn('isMusicRow603') + '\n' + grabFn('crossfadePair603') + '\n' + grabFn('fadeMs603') + '\n' +
  grabFn('takeFloorSec603') + '\n' + grabFn('takeClearsFloor603') + '\n' +
  'var FADE_DEFAULT_MS603 = 2500, FADE_MIN_MS603 = 250, FADE_MAX_MS603 = 12000;\n' +
  'var CROSSFADE_MIN_TAKE_RATIO603 = ' + RATIO838[1] + ';\n' +
  'return { isMusicRow603: isMusicRow603, crossfadePair603: crossfadePair603, fadeMs603: fadeMs603,'
  + ' takeFloorSec603: takeFloorSec603, takeClearsFloor603: takeClearsFloor603 };')();

function genRow(id) { return { id: id, fn: 'task', kind: 'task', task_kind: 'gen', status: 'ok', created: 100 }; }
function ttsRow(id) { return { id: id, fn: 'tts', kind: 'tts', status: 'ok', created: 101 }; }

function pureTests() {
  const p = pure603;
  check('T-603 decision: two music arrivals move together', p.crossfadePair603(genRow('a'), genRow('b')) === 'cross');
  check('T-603 decision: music handing over to speech fades the outgoing side only', p.crossfadePair603(genRow('a'), ttsRow('b')) === 'out');
  check('T-603 decision: speech handing over to music fades the arriving side only', p.crossfadePair603(ttsRow('a'), genRow('b')) === 'in');
  check('T-603 decision: speech into speech moves nothing', p.crossfadePair603(ttsRow('a'), ttsRow('b')) === 'none');
  check('T-603 decision: a handover with nothing on one side moves nothing',
    p.crossfadePair603(null, genRow('b')) === 'in' && p.crossfadePair603(genRow('a'), null) === 'out' && p.crossfadePair603(null, null) === 'none',
    { fromNothing: p.crossfadePair603(null, genRow('b')), toNothing: p.crossfadePair603(genRow('a'), null) });
  check('T-603 decision: "music" is the row\'s own task token, not a model name and not a lane guess',
    p.isMusicRow603(genRow('a')) === true && p.isMusicRow603(ttsRow('b')) === false
    && p.isMusicRow603({ id: 'x', kind: 'task', task_kind: 'tts', status: 'ok' }) === false
    && p.isMusicRow603({ id: 'x', kind: 'batch', status: 'ok' }) === false
    && p.isMusicRow603(null) === false);
  check('T-603 decision: the table is exhaustive over the four pairs and says nothing about a voice',
    ['cross', 'out', 'in', 'none'].indexOf(p.crossfadePair603(genRow('a'), ttsRow('b'))) >= 0
    && p.crossfadePair603(ttsRow('a'), ttsRow('b')) === 'none');
  // The length: unset and garbage both land on the built-in value, and a value out of range is clamped rather
  // than refused, because a Settings number a person cannot make work is a Settings number they will fight.
  check('T-603 length: unset and non-numeric both land on the built-in length',
    p.fadeMs603(null) === 2500 && p.fadeMs603('') === 2500 && p.fadeMs603('abc') === 2500 && p.fadeMs603(undefined) === 2500);
  check('T-603 length: a set value is kept', p.fadeMs603('1500') === 1500 && p.fadeMs603(4000) === 4000);
  check('T-603 length: out of range is clamped, not refused, and a fraction is not accepted',
    p.fadeMs603('10') === 250 && p.fadeMs603('999999') === 12000 && p.fadeMs603('2.5') === 2500 && p.fadeMs603('-4') === 2500,
    { low: p.fadeMs603('10'), high: p.fadeMs603('999999'), fraction: p.fadeMs603('2.5'), negative: p.fadeMs603('-4') });

  // --- T-838 (2026-11-14): the length floor, in the operator-s own words ------------------------------------
  // "we have to \"not\" crossfade between the short sfx jobs - crossfade should be skipped for sfx, voice, clone
  // (spoken text) - while muic generations should be crossfaded if enabled ... i guess the easy protection would
  // be that duration of generation has to be at least 3xcrossfade-suration to actually use it". The spoken half
  // of that was this table's answer already (checked above); what was missing is the short take, and these are
  // the checks for the protection the operator named. Durations here are the seconds the lane reports on a row.
  const dur838 = function (id, seconds) { return Object.assign(genRow(id), { duration: seconds }); };
  check('T-838 floor: the ratio is one number in the panel and it is the one the operator named',
    (SRC.match(/var CROSSFADE_MIN_TAKE_RATIO603 = /g) || []).length === 1 && Number(RATIO838[1]) === 3,
    { ratio: RATIO838[1] });
  check('T-838 floor: at the built-in 2.5 s fade a 5 s take is not faded in any shape of handover — the case named',
    p.crossfadePair603(dur838('a', 5), dur838('b', 5), 2500) === 'none'
    && p.crossfadePair603(dur838('a', 5), dur838('b', 180), 2500) === 'none'
    && p.crossfadePair603(dur838('a', 180), dur838('b', 5), 2500) === 'none'
    && p.crossfadePair603(dur838('a', 5), ttsRow('b'), 2500) === 'none'
    && p.crossfadePair603(ttsRow('a'), dur838('b', 5), 2500) === 'none',
    { both_short: p.crossfadePair603(dur838('a', 5), dur838('b', 5), 2500), short_into_long: p.crossfadePair603(dur838('a', 5), dur838('b', 180), 2500), long_into_short: p.crossfadePair603(dur838('a', 180), dur838('b', 5), 2500), short_into_speech: p.crossfadePair603(dur838('a', 5), ttsRow('b'), 2500), speech_into_short: p.crossfadePair603(ttsRow('a'), dur838('b', 5), 2500) });
  check('T-838 floor: the floor is asked of the side that moves — a short spoken take does not veto a fade it is not part of',
    p.crossfadePair603(dur838('a', 180), Object.assign(ttsRow('b'), { duration: 2 }), 2500) === 'out'
    && p.crossfadePair603(Object.assign(ttsRow('a'), { duration: 2 }), dur838('b', 180), 2500) === 'in'
    && p.crossfadePair603(dur838('a', 180), dur838('b', 120), 2500) === 'cross');
  check('T-838 floor: a long handover still moves together — music is what stayed',
    p.crossfadePair603(dur838('a', 180), dur838('b', 120), 2500) === 'cross'
    && p.crossfadePair603(dur838('a', 30), ttsRow('b'), 2500) === 'out'
    && p.crossfadePair603(ttsRow('a'), dur838('b', 30), 2500) === 'in');
  check('T-838 floor: the floor is three fade-lengths, met AT the line and not only above it',
    p.crossfadePair603(dur838('a', 7.5), dur838('b', 7.5), 2500) === 'cross'
    && p.crossfadePair603(dur838('a', 7.49), dur838('b', 7.5), 2500) === 'none',
    { at_the_line: p.crossfadePair603(dur838('a', 7.5), dur838('b', 7.5), 2500), just_under: p.crossfadePair603(dur838('a', 7.49), dur838('b', 7.5), 2500) });
  check('T-838 floor: the floor moves with the length a person sets — a short fade asks for a short take',
    p.crossfadePair603(dur838('a', 5), dur838('b', 5), 1000) === 'cross'
    && p.crossfadePair603(dur838('a', 1), dur838('b', 1), 250) === 'cross'
    && p.crossfadePair603(dur838('a', 12), dur838('b', 12), 12000) === 'none'
    && p.takeFloorSec603(2500) === 7.5 && p.takeFloorSec603(250) === 0.75 && p.takeFloorSec603(12000) === 36,
    { ten_second_take_at_1s: p.crossfadePair603(dur838('a', 5), dur838('b', 5), 1000), twelve_second_take_at_12s: p.crossfadePair603(dur838('a', 12), dur838('b', 12), 12000) });
  check('T-838 floor: a spoken take is still never faded, with a long duration on it or without one',
    p.crossfadePair603(ttsRow('a'), ttsRow('b'), 2500) === 'none'
    && p.crossfadePair603(Object.assign(ttsRow('a'), { duration: 300 }), dur838('b', 300), 2500) === 'in'
    && p.crossfadePair603(Object.assign(ttsRow('a'), { duration: 1 }), dur838('b', 300), 2500) === 'in');
  check('T-838 floor: no fade length asked for is not a floor — the kind table answers on its own',
    p.crossfadePair603(genRow('a'), genRow('b')) === 'cross'
    && p.takeFloorSec603(undefined) === 0 && p.takeFloorSec603('abc') === 0 && p.takeFloorSec603(0) === 0
    && p.takeFloorSec603(-4) === 0 && p.takeFloorSec603(Infinity) === 0);
  check('T-838 floor: a row that reports no duration is NOT read as a short one — the play-time guard is the place that refuses it',
    p.takeClearsFloor603(genRow('a'), 2500) === true
    && p.takeClearsFloor603(dur838('b', 0), 2500) === true
    && p.takeClearsFloor603(dur838('c', -4), 2500) === true
    && p.takeClearsFloor603(null, 2500) === true
    && /if \(!\(dur603 > 0\) \|\| !isFinite\(dur603\)\) return;/.test(SRC));
  check('T-838 words: the rule is stated where a person switches the fade on and where they set its length',
    /at least three times the fade length you set/.test(SRC) && /It also sets the floor a take has to clear/.test(SRC));

  // --- T-841 (2026-11-14): the side a pick carries, and what it means for a fade --------------------------
  // The operator-s ruling on `TODOS.md` items 27 and 28 was ONE mechanism, and their words for item 27 were the
  // literal rule: "crossfade should be skipped for sfx, voice, clone (spoken text) - while muic generations
  // should be crossfaded if enabled". T-838 could only reach that through the length floor, because no record on a
  // generated row named a side. Now a row CAN carry one: a prompt that came from a preset under presets/sfx/
  // names the sfx side, and the host writes it on the row (lib/index.js, presetRef841). These are the checks for
  // the literal rule, and for the boundary that keeps it honest — a row nobody claimed a side for is still judged
  // exactly as T-838 judged it.
  const sideRow = function (id, seconds, side) { return Object.assign(dur838(id, seconds), { preset_side: side }); };
  // What the rule means at a handover, stated because the operator-s sentence has two possible readings and this
  // one is the reading the rest of the table already commits to. "crossfade should be skipped for sfx" is taken as
  // "the sfx side is never a side that moves" — the same treatment a spoken take gets, and it is the half that
  // keeps the other half of their word alive: "muic generations should be crossfaded if enabled". So a handover
  // between an sfx-side take and a music take fades the MUSIC side only, and the sfx is started at full level and
  // touched by nothing. The stricter reading — no fade at all in any handover that has an sfx in it — would take a
  // fade the operator asked to keep away from the music side, and it is not what this table does to a voice. Two
  // sfx-side takes hand over with nothing moving on either side, which is the case their words name directly.
  check('T-841 side: a row that carries the sfx side is not a side that moves, at any length — the case the length floor could not reach',
    p.isMusicRow603(sideRow('a', 180, 'sfx')) === false
    && p.isMusicRow603(sideRow('b', 300, 'sfx')) === false
    && p.crossfadePair603(sideRow('a', 180, 'sfx'), sideRow('b', 180, 'sfx'), 2500) === 'none'
    && p.crossfadePair603(sideRow('a', 180, 'sfx'), dur838('b', 180), 2500) === 'in'
    && p.crossfadePair603(dur838('a', 180), sideRow('b', 180, 'sfx'), 2500) === 'out'
    && p.crossfadePair603(sideRow('a', 5, 'sfx'), dur838('b', 180), 2500) === 'in'
    && p.crossfadePair603(dur838('a', 180), sideRow('b', 5, 'sfx'), 2500) === 'out',
    { sfx_into_sfx: p.crossfadePair603(sideRow('a', 180, 'sfx'), sideRow('b', 180, 'sfx'), 2500), sfx_into_music: p.crossfadePair603(sideRow('a', 180, 'sfx'), dur838('b', 180), 2500), music_into_sfx: p.crossfadePair603(dur838('a', 180), sideRow('b', 180, 'sfx'), 2500) });
  check('T-841 side: a 20 s effect clears the old floor and is now skipped by the rule itself — the difference this card makes',
    p.crossfadePair603(dur838('a', 20), dur838('b', 20), 2500) === 'cross'
    && p.crossfadePair603(sideRow('a', 20, 'sfx'), dur838('b', 20), 2500) === 'in'
    && p.crossfadePair603(dur838('a', 20), sideRow('b', 20, 'sfx'), 2500) === 'out'
    && p.crossfadePair603(sideRow('a', 20, 'sfx'), sideRow('b', 20, 'sfx'), 2500) === 'none');
  check('T-841 side: the music side and the row nobody claimed a side for are judged exactly as T-838 judged them — the exemption adds a fact, it does not weaken the floor',
    p.isMusicRow603(sideRow('a', 180, 'music')) === true
    && p.isMusicRow603(Object.assign(dur838('b', 180), { preset_side: '' })) === true
    && p.isMusicRow603(Object.assign(dur838('c', 180), { preset_side: 'tts' })) === true
    && p.crossfadePair603(sideRow('a', 180, 'music'), dur838('b', 120), 2500) === 'cross'
    && p.crossfadePair603(dur838('a', 5), dur838('b', 5), 2500) === 'none'
    && p.crossfadePair603(sideRow('a', 5, 'music'), dur838('b', 5), 2500) === 'none');
  check('T-841 side: the side is read off the row, asked before the kind test, and the deciding code consults no model and no prompt',
    (function () {
      const at = SRC.indexOf('function isMusicRow603(');
      const body = SRC.slice(at, SRC.indexOf('\n    }', at));
      const code = body.split('\n').filter(function (l841) { return !/^\s*\/\//.test(l841); }).join('\n');
      const sideAt = code.indexOf('String(r603.preset_side || "") === "sfx"');
      const kindAt = code.indexOf('r603.kind === "task"');
      return sideAt > 0 && kindAt > 0 && sideAt < kindAt
        && !/model|\.text|prompt/.test(code)
        && /var CROSSFADE_MIN_TAKE_RATIO603/.test(SRC);
    })());
  check('T-841 wiring: the panel hands the preset it is showing to the lane on both legs, and only while the field still holds it',
    /payload\.preset_path = prePath841/.test(SRC) && /payload\.preset_path = prePathT841/.test(SRC)
    && /var prePath841 = tk === "gen" \? presetShown572\(\) : "";/.test(SRC)
    && /var prePathT841 = presetShownTts688\(\);/.test(SRC)
    && (SRC.match(/payload\.preset_path = /g) || []).length === 2);
  check('T-841 model move: a pick moves the generator selection to the model the preset was used with, and it lands through the panel-s own resolver',
    /function presetModelMove841\(path841, entry841\)/.test(SRC)
    && /modelsForKind\(lists841\.tts, lists841\.task, "gen"\)/.test(SRC)
    && /resolveTtsSelection\("gen"\)/.test(SRC)
    && /the model this preset was last run with/.test(SRC)
    && /is not in the live lists for the generation kind, so nothing moved/.test(SRC)
    // (T-846 contract change, 2026-11-14) The first version of this third answer said the preset "has not been run
    // through the lane from this panel" — a claim read off the absence of an entry in a list, not off a record. The
    // assertion is re-cut onto the wording the panel now uses, which says what is actually known: no pairing reached
    // this listing. Nothing here was relaxed; the answer is still demanded, and it is still the one that names itself.
    && /carries no model record in the list this panel has/.test(SRC));
  check('T-841 pairing: the preset list carries the model a preset was run with, read off the listing that offered it',
    /used_model: String\(f572\.used_model \|\| ""\)/.test(SRC)
    && /used_side: String\(f572\.used_side \|\| ""\)/.test(SRC)
    && (SRC.match(/used_model/g) || []).length >= 2);
}

// --- the panel half ---------------------------------------------------------------------------------------
function laneFetch(rows, seen) {
  return function (url, opts) {
    const method = ((opts && opts.method) || 'GET').toUpperCase();
    const u = String(url);
    seen.calls.push(method + ' ' + u);
    let body;
    if (/playlist_list/.test(u)) body = { items: rows };
    else if (/play_job/.test(u)) {
      // The panel puts this verb's job id in the URL path (`play_job/<ap-id>`), not in a body — read it off
      // the URL the panel actually asked with, which is the only honest way for a stub to answer the right row.
      let asked = (/play_job\/([^/?]+)/.exec(u) || [0, ''])[1];
      if (!asked) { const b603 = (opts && opts.body); try { asked = String((typeof b603 === 'string' ? JSON.parse(b603 || '{}') : (b603 || {})).job_id || ''); } catch (e) { asked = ''; } }
      seen.playJobs.push(asked);
      body = { ok: true, route_url: '/deepamp/' + (asked || 'ap-0000'), job_id: asked };
    } else if (/get_endpoints/.test(u)) body = { tts: { url: 'http://lane.test:1', route: 'speech' }, stt: { url: 'http://lane.test:2', route: 'transcribe' } };
    else if (/queue_status/.test(u)) body = { ok: true, queues: { tts: { paused: false, running: null, queued: 0, slots: { max: 2, used: 0 } }, task: { paused: false, running: null, queued: 0, slots: { max: 2, used: 0 } } }, machines: {} };
    else if (/get_models|refresh_voices|voice_groups|voice_registry|storage_status|limit_one_per_host|prefer_primary|endpoint_registry/.test(u)) body = { models: [], ok: true };
    else body = { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
  };
}

async function mount(rows, seed) {
  // The panel orders rows by when they were made, not by the order a stub listed them in. Stamping the
  // position back into `created` is what makes "the row before this one" mean the row this file means.
  rows.forEach(function (r603, i603) { r603.created = 1000 + i603; });
  const seen = { calls: [], playJobs: [] };
  global.localStorage = mkLs(seed || {});
  const shim = createRuntime({
    makeHostNode: function (node) {
      const host = { tagName: node.type, _ls: {}, paused: true, ended: false, volume: 1, currentTime: 0, duration: 0 };
      if (node.type === 'audio') {
        host.addEventListener = function (t, fn) { (host._ls[t] = host._ls[t] || []).push(fn); };
        host.removeEventListener = function () {};
        host.fire = function (t) {
          const ev = { type: t, target: host };
          (host._ls[t] || []).forEach(function (f) { f(ev); });
          if (typeof host['on' + t] === 'function') host['on' + t](ev);
        };
        host.load = function () { host.loads = (host.loads || 0) + 1; };
        host.play = function () { host.plays = (host.plays || 0) + 1; host.paused = false; return Promise.resolve(); };
        host.pause = function () { host.paused = true; };
        host.removeAttribute = function (k) { host[k] = undefined; };
        host.captureStream = function () { return { getAudioTracks: function () { return []; }, getTracks: function () { return [] } }; };
        seen.hosts = seen.hosts || [];
        host._tag = 'h' + seen.hosts.length;
        seen.hosts.push(host);
      }
      return host;
    },
  });
  const client = loadClient(shim, { target: TARGET, fetch: laneFetch(rows, seen) });
  const comp = client.apply();
  if (!comp) throw new Error('panel did not register');
  let mark = 0;
  const commit = function () { mark = shim.rt.created.length; shim.renderAndCommit(comp()); return shim.rt.created; };
  const rendered = function () { return shim.rt.created.slice(mark); };
  commit(); await shim.flush();
  await openAllSections(shim, comp);
  commit(); await shim.flush();
  if (shim.rt.throws.length) { const t = shim.rt.throws[0]; throw new Error(t.where + ': ' + (t.err && t.err.message)); }
  const byCls = function (cls) { return rendered().filter(function (e) { return String((e.props && e.props.className) || '').split(/\s+/).indexOf(cls) >= 0; }); };
  const lastMatch = function (list) { return list.length ? list[list.length - 1] : null; };
  const click = async function (el) {
    if (!el || typeof el.props.onClick !== 'function') throw new Error('control has no click handler');
    el.props.onClick();
    commit(); await shim.flush(); commit(); await shim.flush();
  };
  const take = (seen.hosts || [])[0];
  if (!take) throw new Error('no take element was mounted');
  return { shim: shim, comp: comp, commit: commit, rendered: rendered, byCls: byCls, lastMatch: lastMatch, click: click, take: take, seen: seen, ls: global.localStorage };
}

async function pressTransportPlay(m) {
  const b = m.lastMatch(m.byCls('audio-play-tp-play'))
    || m.lastMatch(rendered2(m, function (e) { return e.type === 'button' && /play the row the transport is on/.test(String((e.props || {}).title || '')); }));
  if (!b) throw new Error('the transport play control was not found');
  await m.click(b);
}
function rendered2(m, f) { return m.rendered().filter(f); }

/** The panel's own transport play, then the walk it starts when that take ends. */
async function startFirstTake(m) {
  await pressTransportPlay(m);
  await wait(60); m.commit(); await m.shim.flush();
  return m.take;
}
function nearEnd(take, leftSec) {
  take.duration = 20;
  take.currentTime = 20 - leftSec;
  take.fire('timeupdate');
}

async function behaviourTests() {
  // A. crossfade OFF: the panel behaves exactly as it did before this card. Nothing is written to the level of
  // the take element, on the start of a take or at its end, even across a music-to-music handover.
  {
    const m = await mount([genRow('ap-9001'), genRow('ap-9002'), genRow('ap-9003')], { 'deepamp:fastfwd': '1' });
    const take = await startFirstTake(m);
    check('T-603 off: the switch is OFF at mount and the panel says so on its own control',
      !!m.lastMatch(m.byCls('audio-play-cf-toggle603')) && m.lastMatch(m.byCls('audio-play-cf-toggle603')).props.children === 'crossfade off'
      && m.lastMatch(m.byCls('audio-play-cf-toggle603')).props['aria-pressed'] === 'false');
    check('T-603 off: nothing about this card is written to storage until a person touches it',
      m.ls.s['deepamp:crossfade.on'] === undefined && m.ls.s['deepamp:crossfade.ms'] === undefined,
      Object.keys(m.ls.s));
    nearEnd(take, 0.1);
    check('T-603 off: a take that is about to end is left at the level the panel holds — no fade is applied', take.volume === 1, { volume: take.volume });
    take.fire('ended');
    await wait(80); m.commit(); await m.shim.flush();
    check('T-603 off: the handover to the next music take starts it at full level, as it always did',
      take.volume === 1 && take.paused === false && String(take.src || '').indexOf('ap-9002') >= 0,
      { volume: take.volume, src: take.src, plays: take.plays });
  }

  // B. crossfade ON, music into music: the tail of the first take fades, and the arriving take fades IN.
  {
    const m = await mount([genRow('ap-9001'), genRow('ap-9002'), genRow('ap-9003')],
      { 'deepamp:fastfwd': '1', 'deepamp:crossfade.on': '1', 'deepamp:crossfade.ms': '250' });
    const take = await startFirstTake(m);
    check('T-603 on: the switch is ON when it was turned on, and it is the switch that says so',
      m.lastMatch(m.byCls('audio-play-cf-toggle603')).props.children === 'crossfade on'
      && m.lastMatch(m.byCls('audio-play-cf-toggle603')).props['aria-pressed'] === 'true');
    // RE-POINTED by T-671 (2026-10-28): the field reads seconds now, so a stored 250 ms shows as "0.25", and the
    // readout beside it says the same number instead of rounding it to "0.3 s". The pin's intent is unchanged - a
    // stored length is shown by the control that sets it, and the person sees the unit it means - and the stored
    // key it mounts with is still milliseconds.
    check('T-603 on: the length shows the stored value, and it is the number control that shows it',
      m.lastMatch(m.byCls('audio-play-crossfade-ms603')).props.value === '0.25'
      && m.lastMatch(m.byCls('audio-play-crossfade-read603')).props.children === '0.25 s',
      { value: m.lastMatch(m.byCls('audio-play-crossfade-ms603')).props.value, read: m.lastMatch(m.byCls('audio-play-crossfade-read603')).props.children });
    // RE-POINTED by T-603 STEP 2 (2026-10-27): with the two-sided overlap in place, the last moments of a music
    // take are carried by the SECOND take element, and the take element has already been handed to the arriving
    // take — so "the tail fades down" is measured on the element that now carries it. The intent of both pins is
    // unchanged; only the element they look at moved, and it moved because the card asked for both sides to move.
    // `fire('loadedmetadata')` is the stub doing what a real media element does on its own once its resource is
    // set: it is what lets the tail be confirmed audible, which is the condition the swap waits for.
    const tailB = (m.seen.hosts || [])[2];
    nearEnd(take, 0.1);
    await wait(150);
    tailB.fire('loadedmetadata');
    await wait(120);
    // The thresholds here are "a ramp is measurably on its way", not a fixed value at a fixed millisecond: the
    // swap waits for the tail to be confirmed audible, so the two ramps start a few dozen milliseconds apart and
    // a number written for one machine's timer would fail on another's. What is pinned is the pair — part way
    // down on one side and part way up on the other, then silence on one and full level on the other.
    check('T-603 on, re-pointed by step 2: the last moments of a music take fade down instead of stopping at full level — on the element that carries the tail',
      tailB.volume < 0.7 && tailB.volume > 0 && String(tailB.src || '').indexOf('ap-9001') >= 0, { tailVolume: tailB.volume, tailSrc: tailB.src });
    check('T-603 on: the arriving music take starts from silence, not from full level',
      take.volume < 0.7 && String(take.src || '').indexOf('ap-9002') >= 0, { volume: take.volume, src: take.src });
    await wait(450);
    check('T-603 on: the fade-in reaches the level the panel holds, and does not stop halfway',
      take.volume > 0.95, { volume: take.volume });
    // The take element is the middle row by now, so this measures the middle row's tail directly. It is NOT the
    // last row of the walk: the last row gets no fade-out by ruling, and firing `ended` here would have moved the
    // measurement onto that last row and made this pin test the wrong thing.
    nearEnd(take, 0.1);
    await wait(150);
    tailB.fire('loadedmetadata');
    await wait(120);
    check('T-603 on, re-pointed by step 2: the middle take of the walk fades its tail too — the rule is not only the first handover',
      tailB.volume < 0.7 && String(tailB.src || '').indexOf('ap-9002') >= 0, { tailVolume: tailB.volume, tailSrc: tailB.src });
  }

  // C. crossfade ON, music into SPEECH: the music side fades, the arriving spoken take is left exactly as it is.
  {
    const m = await mount([genRow('ap-9001'), ttsRow('ap-9002'), ttsRow('ap-9003')],
      { 'deepamp:fastfwd': '1', 'deepamp:crossfade.on': '1', 'deepamp:crossfade.ms': '250' });
    const take = await startFirstTake(m);
    nearEnd(take, 0.1);
    await wait(220);
    check('T-603 single-sided: the music side of a music-into-speech handover does fade', take.volume < 0.2, { volume: take.volume });
    take.currentTime = 20; take.fire('ended');
    await wait(60); m.commit(); await m.shim.flush();
    check('T-603 single-sided: the arriving SPOKEN take keeps its level — no fade is applied to a voice',
      take.volume === 1 && String(take.src || '').indexOf('ap-9002') >= 0, { volume: take.volume, src: take.src });
    nearEnd(take, 0.1);
    check('T-603 single-sided: the spoken take that follows fades nothing at its end either — a voice is not faded in either direction',
      take.volume === 1, { volume: take.volume });
  }

  // D. crossfade ON, SPEECH into music: the spoken tail is left alone, the arriving music fades in.
  {
    const m = await mount([ttsRow('ap-9001'), genRow('ap-9002'), genRow('ap-9003')],
      { 'deepamp:fastfwd': '1', 'deepamp:crossfade.on': '1', 'deepamp:crossfade.ms': '250' });
    const take = await startFirstTake(m);
    nearEnd(take, 0.1);
    await wait(220);
    check('T-603 single-sided: a SPOKEN tail is not faded on its way into music', take.volume === 1, { volume: take.volume });
    take.currentTime = 20; take.fire('ended');
    await wait(40); m.commit(); await m.shim.flush();
    check('T-603 single-sided: the arriving MUSIC take fades in', take.volume < 0.4, { volume: take.volume, src: take.src });
    await wait(400);
    check('T-603 single-sided: and it reaches the panel level it was ramped to', take.volume > 0.95, { volume: take.volume });
  }

  // E. crossfade ON, speech into speech: nothing moves, at either end of the handover.
  {
    const m = await mount([ttsRow('ap-9001'), ttsRow('ap-9002'), ttsRow('ap-9003')],
      { 'deepamp:fastfwd': '1', 'deepamp:crossfade.on': '1', 'deepamp:crossfade.ms': '250' });
    const take = await startFirstTake(m);
    nearEnd(take, 0.1);
    await wait(220);
    check('T-603 untouched: speech into speech fades nothing at the end of the first take', take.volume === 1, { volume: take.volume });
    take.currentTime = 20; take.fire('ended');
    await wait(60); m.commit(); await m.shim.flush();
    check('T-603 untouched: speech into speech fades nothing at the start of the next take either',
      take.volume === 1, { volume: take.volume, src: take.src });
  }

  // F. A press that takes control must not leave a fade running. STOP first, then the volume slider mid-fade.
  // RE-POINTED by T-603 STEP 2 (2026-10-27) onto the pairing that still fades on ONE element — music into
  // speech, a single-sided handover — because music into music now hands its tail to the second element, and
  // that pairing's interrupts are pinned in their own block further down (the STOP case and the slider case).
  // Nothing here was dropped: the fade this block measures is still a fade the panel really runs.
  {
    const m = await mount([genRow('ap-9001'), ttsRow('ap-9002'), ttsRow('ap-9003')],
      { 'deepamp:fastfwd': '1', 'deepamp:crossfade.on': '1', 'deepamp:crossfade.ms': '250' });
    const take = await startFirstTake(m);
    nearEnd(take, 0.1);
    await wait(150);
    check('T-603 interrupt: a fade really is running before the press (this is the pin the next two depend on)',
      take.volume < 0.6, { volume: take.volume });
    const stop = m.lastMatch(m.byCls('audio-play-tp-stop'));
    if (!stop) throw new Error('the transport stop control was not found');
    await m.click(stop);
    check('T-603 interrupt: STOP during a fade leaves the element at the level the panel holds, not at the faded one',
      take.volume === 1, { volume: take.volume });
    await wait(220);
    check('T-603 interrupt: and the cancelled fade does not carry on ramping afterwards', take.volume === 1, { volume: take.volume });
  }
  {
    const m = await mount([genRow('ap-9001'), genRow('ap-9002'), genRow('ap-9003')],
      { 'deepamp:fastfwd': '1', 'deepamp:crossfade.on': '1', 'deepamp:crossfade.ms': '250' });
    const take = await startFirstTake(m);
    nearEnd(take, 0.1); await wait(150);
    (m.seen.hosts || [])[2].fire('loadedmetadata');   // RE-POINTED by step 2: this arrival comes by handover, not by the take ending
    await wait(120); m.commit(); await m.shim.flush();
    check('T-603 interrupt: a fade-in is running on the arriving take before the slider is moved', take.volume < 0.5, { volume: take.volume });
    const vol = m.lastMatch(m.byCls('audio-play-vol'));
    if (!vol) throw new Error('the volume slider was not found');
    vol.props.onInput({ target: { value: '0.5' } });
    m.commit(); await m.shim.flush();
    await wait(200);
    check('T-603 interrupt: moving the volume slider mid-fade RETARGETS the fade instead of fighting it — the person level wins',
      take.volume <= 0.5 + 0.001 && take.volume > 0.2, { volume: take.volume });
  }

  // H. STEP 2, music into music: both sides move. The tail is heard on the second take element while the
  // arriving take has already started on the take element, and both of their levels are on the way somewhere.
  {
    const m = await mount([genRow('ap-9101'), genRow('ap-9102'), genRow('ap-9103')],
      { 'deepamp:fastfwd': '1', 'deepamp:crossfade.on': '1', 'deepamp:crossfade.ms': '250' });
    const hosts = m.seen.hosts || [];
    check('T-603 step 2: the panel mounts a third media element for a tail, hidden like the take element and the station element',
      hosts.length >= 3, { elements: hosts.length });
    const tail = hosts[2];
    const take = await startFirstTake(m);
    nearEnd(take, 0.1);
    await wait(140);
    check('T-603 step 2: the tail element took the resource the listener is hearing right now, not the arriving one',
      String(tail.src || '').indexOf('ap-9101') >= 0, { tailSrc: String(tail.src), takeSrc: String(take.src) });
    tail.fire('loadedmetadata');
    await wait(140);
    check('T-603 step 2: both sides are audible at once and both levels are moving — the ruled music-into-music handover',
      tail.paused === false && tail.volume > 0 && tail.volume < 1
      && String(take.src || '').indexOf('ap-9102') >= 0 && take.paused === false && take.volume < 1,
      { tailVolume: tail.volume, tailPaused: tail.paused, takeVolume: take.volume, takeSrc: String(take.src) });
    await wait(500);
    check('T-603 step 2: the tail reached silence and was let go — paused, and its resource cleared',
      tail.paused === true && !String(tail.src || ''), { tailPaused: tail.paused, tailSrc: String(tail.src), tailVolume: tail.volume });
    check('T-603 step 2: and the arriving take finished its fade-in at the level the panel holds',
      take.volume > 0.95 && String(take.src || '').indexOf('ap-9102') >= 0, { takeVolume: take.volume });
    check('T-603 step 2: the take element was never the tail\u2019s carrier — the transport and the strip keep pointing at the arriving take',
      String(take.src || '').indexOf('ap-9102') >= 0, { takeSrc: String(take.src) });
  }

  // I. STEP 2 against the operator\u2019s named edge case: a press that takes control while an overlap is in flight.
  {
    const m = await mount([genRow('ap-9101'), genRow('ap-9102'), genRow('ap-9103')],
      { 'deepamp:fastfwd': '1', 'deepamp:crossfade.on': '1', 'deepamp:crossfade.ms': '250' });
    const tail2 = (m.seen.hosts || [])[2];
    const take = await startFirstTake(m);
    nearEnd(take, 0.1);
    await wait(140);
    tail2.fire('loadedmetadata');
    await wait(120);
    // The take element is ALREADY on the arriving row when an overlap is in flight — that is the whole point of
    // the two-sided handover, and the pin that follows is only meaningful if this one holds.
    check('T-603 step 2 interrupt: an overlap really is in flight before the press (the pin the next one depends on)',
      tail2.paused === false && String(tail2.src || '').indexOf('ap-9101') >= 0
      && String(take.src || '').indexOf('ap-9102') >= 0, { tailPaused: tail2.paused, tailSrc: String(tail2.src), takeSrc: String(take.src) });
    await m.click(m.lastMatch(m.byCls('audio-play-tp-stop')));
    check('T-603 step 2 interrupt: STOP during an overlap stops the tail as well as the take, and leaves no element faded',
      tail2.paused === true && !String(tail2.src || '') && take.paused === true && take.volume === 1,
      { tailPaused: tail2.paused, tailSrc: String(tail2.src), takePaused: take.paused, takeVolume: take.volume });
  }
  {
    const m = await mount([genRow('ap-9101'), genRow('ap-9102'), genRow('ap-9103')],
      { 'deepamp:fastfwd': '1', 'deepamp:crossfade.on': '1', 'deepamp:crossfade.ms': '250' });
    const tail3 = (m.seen.hosts || [])[2];
    const take = await startFirstTake(m);
    nearEnd(take, 0.1);
    await wait(140);
    tail3.fire('loadedmetadata');
    await wait(120);
    const vol = m.lastMatch(m.byCls('audio-play-vol'));
    vol.props.onInput({ target: { value: '0.4' } });
    m.commit(); await m.shim.flush();
    await wait(120);
    check('T-603 step 2 interrupt: the volume slider retargets the TAIL too, so a person\u2019s level wins over a ramp on either element',
      tail3.volume <= 0.4 + 0.001, { tailVolume: tail3.volume });
  }

  // J. STEP 2 does not reach into the pairings it was not ruled for.
  {
    const m = await mount([genRow('ap-9101'), ttsRow('ap-9102'), ttsRow('ap-9103')],
      { 'deepamp:fastfwd': '1', 'deepamp:crossfade.on': '1', 'deepamp:crossfade.ms': '250' });
    const tail4 = (m.seen.hosts || [])[2];
    const take = await startFirstTake(m);
    nearEnd(take, 0.1);
    await wait(220);
    check('T-603 step 2 scope: a single-sided handover never touches the second element — only music into music overlaps',
      !String(tail4.src || '') && tail4.paused === true, { tailSrc: String(tail4.src) });
  }
  {
    const m = await mount([genRow('ap-9201'), genRow('ap-9202'), genRow('ap-9203')], { 'deepamp:fastfwd': '1' });
    const tail5 = (m.seen.hosts || [])[2];
    const take = await startFirstTake(m);
    nearEnd(take, 0.1);
    await wait(260);
    check('T-603 step 2 off: with the switch off the second element is never given a resource and never plays',
      !String(tail5.src || '') && tail5.paused === true && !tail5.plays, { tailSrc: String(tail5.src), tailPlays: tail5.plays });
  }

  // K. T-838 (2026-11-14): the length floor inside a real walk, in the panel. The operator-s words: "we have to
  // \"not\" crossfade between the short sfx jobs … i guess the easy protection would be that duration of
  // generation has to be at least 3xcrossfade-suration to actually use it". The rows below carry the seconds the
  // lane reports on a row; the media element is still held at 20 s by nearEnd(), so the only thing refusing the
  // fade here is the length on the row. The third block is the same walk with 30-second rows and the same
  // built-in fade length, and it still overlaps — which is what says the wiring is untouched and the length is
  // the only thing that moved.
  {
    const short838 = function (id) { return Object.assign(genRow(id), { duration: 5 }); };
    const m = await mount([short838('ap-9301'), short838('ap-9302'), short838('ap-9303')],
      { 'deepamp:fastfwd': '1', 'deepamp:crossfade.on': '1' });   // no length written: the built-in 2500 ms, floor 7.5 s
    const tail838 = (m.seen.hosts || [])[2];
    const take = await startFirstTake(m);
    nearEnd(take, 0.1);
    await wait(260);
    check('T-838 in the walk: a five-second take is not ramped at its end and no overlap is started — the level stays where the person put it',
      take.volume === 1 && !String(tail838.src || '') && tail838.paused === true,
      { takeVolume: take.volume, tailSrc: String(tail838.src), tailPaused: tail838.paused });
    take.fire('ended');
    await wait(80); m.commit(); await m.shim.flush();
    check('T-838 in the walk: and the arriving five-second take is not faded in either — it starts at the panel level',
      String(take.src || '').indexOf('ap-9302') >= 0 && take.volume === 1,
      { takeSrc: String(take.src), takeVolume: take.volume });
  }
  {
    const long838 = function (id) { return Object.assign(genRow(id), { duration: 30 }); };
    const m = await mount([long838('ap-9401'), long838('ap-9402'), long838('ap-9403')],
      { 'deepamp:fastfwd': '1', 'deepamp:crossfade.on': '1' });   // the same built-in length, rows 6x over the floor
    const tail838b = (m.seen.hosts || [])[2];
    const take = await startFirstTake(m);
    nearEnd(take, 0.1);
    await wait(160);
    // The same confirmation the ruled overlap test uses: the swap waits until the tail is confirmed audible,
    // which is what a real media element reports on its own once its resource is set.
    tail838b.fire('loadedmetadata');
    await wait(160);
    check('T-838 in the walk: the same three rows at 30 s do overlap, so the floor is what changed and not the wiring',
      String(tail838b.src || '').indexOf('ap-9401') >= 0 && tail838b.paused === false && tail838b.volume > 0 && tail838b.volume < 1,
      { tailSrc: String(tail838b.src), tailPaused: tail838b.paused, tailVolume: tail838b.volume });
  }

  // G. The controls themselves: the switch is a press that persists, and the length is stored only once changed.
  {
    const m = await mount([genRow('ap-9001'), genRow('ap-9002')], { 'deepamp:fastfwd': '1' });
    // RE-POINTED by T-671 (2026-10-28): the built-in 2500 ms is now SHOWN as 2.5 (seconds), which is the same
    // length told in the unit the field asks for. "Nothing was written to get it there" is what the second clause
    // still guards, and it is unchanged.
    check('T-603 settings: the built-in length is shown, and nothing was written to get it there',
      m.lastMatch(m.byCls('audio-play-crossfade-ms603')).props.value === '2.5'
      && m.ls.s['deepamp:crossfade.ms'] === undefined,
      { value: m.lastMatch(m.byCls('audio-play-crossfade-ms603')).props.value, stored: m.ls.s['deepamp:crossfade.ms'] });
    check('T-603 settings: the length control is disabled while the switch is off — a number that does nothing is not offered as one that does',
      m.lastMatch(m.byCls('audio-play-crossfade-ms603')).props.disabled === true);
    const sw = m.lastMatch(m.byCls('audio-play-cf-toggle603'));
    await m.click(sw);
    check('T-603 settings: pressing the switch is what writes it, and it writes both ways',
      m.ls.s['deepamp:crossfade.on'] === '1', { stored: m.ls.s['deepamp:crossfade.on'] });
    const sw2 = m.lastMatch(m.byCls('audio-play-cf-toggle603'));
    check('T-603 settings: and the control answers the new state on the render after the press',
      sw2.props.children === 'crossfade on' && sw2.props['aria-pressed'] === 'true');
    await m.click(sw2);
    check('T-603 settings: turning it off is stored too, so the next page starts off', m.ls.s['deepamp:crossfade.on'] === '0');
    // RE-POINTED by T-671 (2026-10-28): the press now types a number in the unit the field asks for - 1.5 s - and
    // the pin still guards what it always guarded: the length is written only once a person actually sets it, and
    // what is written is milliseconds. '1500' typed into a seconds field would now mean 1500 seconds, which the
    // panel would clamp to 12 s; that is the proof this re-point is honest and not a widening.
    const num = m.lastMatch(m.byCls('audio-play-crossfade-ms603'));
    num.props.onChange({ target: { value: '1.5' } });
    m.commit(); await m.shim.flush();
    check('T-603 settings: the length is stored only once a person actually sets it',
      m.ls.s['deepamp:crossfade.ms'] === '1500' && m.lastMatch(m.byCls('audio-play-crossfade-ms603')).props.value === '1.5',
      { stored: m.ls.s['deepamp:crossfade.ms'], value: m.lastMatch(m.byCls('audio-play-crossfade-ms603')).props.value });
    // RE-POINTED by T-671 (2026-10-28): '10' is a valid 10 s now, so the out-of-range press is 0.1 s - below the
    // floor. What the pin guards is unchanged: the clamp answers on the control AND in storage, in the same unit
    // (0.25 s shown, 250 ms stored - the two are the same length).
    const num2 = m.lastMatch(m.byCls('audio-play-crossfade-ms603'));
    num2.props.onChange({ target: { value: '0.1' } });
    m.commit(); await m.shim.flush();
    check('T-603 settings: an out-of-range length is clamped to what the panel can use, on the control and in storage alike',
      m.lastMatch(m.byCls('audio-play-crossfade-ms603')).props.value === '0.25' && m.ls.s['deepamp:crossfade.ms'] === '250',
      { value: m.lastMatch(m.byCls('audio-play-crossfade-ms603')).props.value, stored: m.ls.s['deepamp:crossfade.ms'] });
    // T-671 (2026-10-28): what a person types is what they meant, in the unit the field asks for, and the value
    // the fade and the store use is still milliseconds. Three numbers, three lengths, no rounding in between.
    const num3 = m.lastMatch(m.byCls('audio-play-crossfade-ms603'));
    num3.props.onChange({ target: { value: '3' } });
    m.commit(); await m.shim.flush();
    check('T-671: a plain whole number in seconds means that many seconds, and it is stored as milliseconds',
      m.ls.s['deepamp:crossfade.ms'] === '3000' && m.lastMatch(m.byCls('audio-play-crossfade-ms603')).props.value === '3'
      && m.lastMatch(m.byCls('audio-play-crossfade-read603')).props.children === '3 s',
      { stored: m.ls.s['deepamp:crossfade.ms'], value: m.lastMatch(m.byCls('audio-play-crossfade-ms603')).props.value, read: m.lastMatch(m.byCls('audio-play-crossfade-read603')).props.children });
    const num4 = m.lastMatch(m.byCls('audio-play-crossfade-ms603'));
    num4.props.onChange({ target: { value: '99' } });
    m.commit(); await m.shim.flush();
    check('T-671: the ceiling is the ceiling in either unit - 99 s is refused as 12 s, on the control and in storage',
      m.ls.s['deepamp:crossfade.ms'] === '12000' && m.lastMatch(m.byCls('audio-play-crossfade-ms603')).props.value === '12'
      && m.lastMatch(m.byCls('audio-play-crossfade-read603')).props.children === '12 s',
      { stored: m.ls.s['deepamp:crossfade.ms'], value: m.lastMatch(m.byCls('audio-play-crossfade-ms603')).props.value });
    const num5 = m.lastMatch(m.byCls('audio-play-crossfade-ms603'));
    num5.props.onChange({ target: { value: '2.75' } });
    m.commit(); await m.shim.flush();
    check('T-671: a decimal length is accepted exactly, shows the same number in the field and in the readout, and is stored as 2750 ms',
      m.ls.s['deepamp:crossfade.ms'] === '2750' && m.lastMatch(m.byCls('audio-play-crossfade-ms603')).props.value === '2.75'
      && m.lastMatch(m.byCls('audio-play-crossfade-read603')).props.children === '2.75 s',
      { stored: m.ls.s['deepamp:crossfade.ms'], value: m.lastMatch(m.byCls('audio-play-crossfade-ms603')).props.value, read: m.lastMatch(m.byCls('audio-play-crossfade-read603')).props.children });
  }
}

// --- the source half: the wiring a browser test cannot see from outside ------------------------------------
function sourceTests() {
  const cnt = function (re) { return (SRC.match(re) || []).length; };
  check('T-603 wiring: the tail fade hangs off the element clock readout, the one place the panel knows how far into a file it is',
    /a\.ontimeupdate = function \(\) \{[\s\S]{0,600}tailFadeFor603\(a\);[\s\S]{0,40}\};/.test(SRC));
  check('T-603 wiring: the fade-in is armed after the play call, never before it',
    SRC.indexOf('var head603 = headFadeFor603(url);') < SRC.indexOf('fadeRun603Ref.current = fadeVolume603(a, 0, 1')
    && SRC.indexOf('var p = a.play();') < SRC.indexOf('fadeRun603Ref.current = fadeVolume603(a, 0, 1'));
  check('T-603 wiring: the plan is made by the auto-play walk itself, from the rows that walk ordered',
    /planHandoverFade603\(rows, i\);/.test(SRC));
  // RE-CUT IN PLACE 2026-11-12 (T-813): the adjacency this pin read is now two statements with the carry step
  // between them — a hold the incoming take would take again is offered to it before anything is released. What
  // this pin guards is the ORDER, and it is still asserted: the fade a replaced take left running is cancelled
  // inside the one function every take calls, and before that take's hold is let go.
  check('T-603 wiring: every new take cleans a fade the take it replaces left running — the one function every take calls',
    (function () {
      const at603c = SRC.indexOf('function applyOverlap395(');
      const body603c = SRC.slice(at603c, SRC.indexOf('function releaseOverlap395('));
      return at603c > 0 && body603c.indexOf('cancelFade603(1);') >= 0
        && body603c.indexOf('cancelFade603(1);') < body603c.indexOf('var held551 = overlapRef395.current;');
    })());
  check('T-603 wiring: stop, pause and seek each cancel a fade in flight',
    /cancelFade603\(1\);\s*\n\s*var ctl397 = controlEl395\(\);/.test(SRC)
    && /cancelFade603\(1\);\s*\n\s*var pausedNow = a\.paused === true;/.test(SRC)
    && /cancelFade603\(1\);\s*\n\s*try \{ a\.currentTime = v; \}/.test(SRC));
  check('T-603 wiring: a fade is ramped against the LIVE panel level, which is what makes the volume slider win',
    /fadeLevel603Ref\.current = \(a && typeof a\.volume === "number"/.test(SRC)
    && cnt(/fadeLevelNow603/g) >= 3);
  check('T-603 wiring: the switch defaults off and is read as a switch, not as a guess',
    /lsGet\(LS_CROSSFADE603\) === "1"/.test(SRC) && cnt(/lsSet\(LS_CROSSFADE603/g) === 1 && cnt(/lsSet\(LS_FADE_MS603/g) === 1);
  const graphLines = SRC.split('\n').filter(function (l603) { return /createMediaElementSource|createBufferSource\(/.test(l603); });
  const fadeBodyAt = SRC.indexOf('function fadeVolume603(');
  const fadeBody = SRC.slice(fadeBodyAt, fadeBodyAt + 1800);
  check('T-603 wiring: a fade is done on the element\u2019s own level and never through a media graph node — every mention of one in this file is a comment saying it is not used',
    graphLines.length > 0 && graphLines.every(function (l603) { return /^\s*(\/\/|\*)/.test(l603); })
    && fadeBodyAt > 0 && !/createGain|createMediaElementSource|createBiquadFilter|AudioContext/.test(fadeBody),
    { lines: graphLines.slice(0, 3).map(function (l603) { return l603.trim().slice(0, 90); }) });
  check('T-603 wiring: the crossfade is decided from the row task token, and no model name is consulted',
    /r603\.kind === "task" && String\(r603\.task_kind \|\| ""\) === "gen"/.test(SRC));
  // (T-838 contract change, 2026-11-14) The same assertion, re-cut: the call now carries the fade length, because
  // the decision cannot answer whether a take clears the floor without knowing how long the fade is. The operator-s
  // words behind it: "duration of generation has to be at least 3xcrossfade-suration to actually use it". Nothing
  // about the neighbour rule was dropped — a walk-s first row still gets no fade-in and its last row no fade-out,
  // and both halves still go through the one decision function.
  check('T-603 wiring: a handover needs a real neighbour on both sides — a walk\'s first row gets no fade-in and its last row no fade-out',
    /head: prev603 \? crossfadePair603\(prev603, out603, crossfadeMs603\) : "none"/.test(SRC)
    && /tail: next603 \? crossfadePair603\(out603, next603, crossfadeMs603\) : "none"/.test(SRC));
  check('T-838 wiring: the fade length is handed to the decision at both halves of a handover, and nowhere else',
    (SRC.match(/crossfadePair603\(/g) || []).length === 3
    && (SRC.match(/crossfadePair603\([^)]*crossfadeMs603\)/g) || []).length === 2);
  check('T-603 wiring: the two halves of the voice rule are written where they apply, not only in the decision table',
    /plan603\.tail !== "cross" && plan603\.tail !== "out"/.test(SRC)
    && /plan603\.head !== "cross" && plan603\.head !== "in"/.test(SRC));
  check('T-603 step 2 wiring: the tail rides a THIRD mounted take element, hidden and ref-attached like the other two, and it is not the station element',
    /ref: takeBRef603, controls: false,[\s\S]{0,80}display: "none"/.test(SRC)
    && cnt(/h\("audio", \{/g) === 3
    && SRC.indexOf('ref: takeBRef603') > SRC.indexOf('ref: streamAudioRef'),
    { audio_elements: cnt(/h\("audio", \{/g) });
  check('T-603 step 2 wiring: the overlap is refused while this take is holding a duck or a paused station — three audible sources is not what either card asked for',
    /if \(overlapRef395\.current\) return false;/.test(SRC)
    && /isStreamRoute395\(st603\.src\) && st603\.paused !== true/.test(SRC));
  // The ownership claim is taken BEFORE the tail ramp is armed, and the door's cancel checks it before it
  // cancels anything. Both halves are pinned because the first version of this got the order wrong and the tail
  // was cancelled by the handover's own arrival: the fade was there, the level was put back to full, and the
  // audio was cut for the length of the fade nobody heard.
  check('T-603 step 2 wiring: the handover claims ownership before it arms the tail ramp, and the panel door honours that claim before it cancels anything',
    /handoverOwns603Ref\.current = true;[\s\S]{0,320}queuePlayback\(route603, plan603\.nextId, true\);/.test(SRC)
    && /function cancelFade603\([^)]*\) \{[\s\S]{0,900}if \(handoverOwns603Ref\.current\) \{ handoverOwns603Ref\.current = false; return; \}/.test(SRC)
    && /if \(run603 && typeof run603\.stop === "function"\) \{ run603\.stop\(\); return; \}/.test(SRC));
  check('T-603 step 2 wiring: the arriving route is asked for through the verb the walk already uses, not by inventing a local one',
    /call\("play_job", \{ job_id: plan603\.nextId \}\)/.test(SRC));
  check('T-603 step 2 wiring: a tail that never got audible falls back to the single-element fade rather than to silence',
    /h603\.timer = setTimeout\(function \(\) \{ abandon603\(\); \}/.test(SRC)
    && /var abandon603 = function \(\)[\s\S]{0,400}fadeTailOnOneElement603\(a603/.test(SRC));
  // The operator's named edge case, verbatim: "user drops play on voice button while crossfade is in progress".
  // Pinned in the form this fixture can honestly hold: a voice sample press interrupts in the SAME three
  // statements a row press does, and every take - a row's, a source file's, a voice sample's, a chunk part's -
  // reaches `applyOverlap395`, which is where the fade cancel and the tail stop live. The behaviour pin for the
  // voice button itself is NOT driven here, because this suite stubs no voice registry and a voice row only gets
  // its play control when the panel can see the sample is really on disk. That press belongs to the live check
  // the card owes, and it is written on the pin rather than left implied.
  check('T-603 step 2 interrupt: a voice sample press interrupts in the same shape as a row press, and every take reaches the one door that stops a fade and a tail',
    /function playVoiceNow448\(name\) \{[\s\S]{0,700}playQRef\.current\.length = 0;[\s\S]{0,200}playingRef\.current = false;[\s\S]{0,300}queuePlayback\("\/deepamp\/voice\/"[\s\S]{0,140}, true\);/.test(SRC)
    && /function playJob\(id\) \{[\s\S]{0,1800}playQRef\.current\.length = 0;[\s\S]{0,200}playingRef\.current = false;/.test(SRC)
    && /function applyOverlap395\([\s\S]{0,2400}cancelFade603\(1\);/.test(SRC));   // (T-813 contract change) the signature now names the take's token; the door this pin reaches is unchanged.
  const hovers = SRC.match(/title: "[^"]*(crossfade|fade)[^"]*"/g) || [];
  check('T-603 hover policy: the new hovers name no card id, no storage key, no verb of the lane and no browser API',
    hovers.length >= 2 && hovers.every(function (t388) {
      return !/T-\d{3}/.test(t388) && !/deepamp:/.test(t388) && !/localStorage/.test(t388)
        && !/\bPOST\b|\bGET\b/.test(t388) && !/dispatch|playlist_list|play_job/.test(t388);
    }), { hovers: hovers.length });
}

// T-850 (2026-11-14), the ruling on `TODOS.md` item 36 (c): the side a row carries was READ by this panel on every
// auto-play handover — `isMusicRow603` asks `preset_side` before it asks anything else, and an sfx-side take is never
// a side a fade moves — and it was SHOWN nowhere. A person watching a 20 s effect not fade had no way to see why,
// and the rule the operator actually asked for ("crossfade should be skipped for sfx") was running invisibly. What is
// pinned here is the pair that makes that honest: for the SAME fixture row, what the decision does and what the row
// says. A row with no side on it prints nothing about a side, which is the rule this panel keeps elsewhere.
async function displayTests850() {
  const rowTip = function (m, id) {
    const hit = m.rendered().filter(function (e) { return e.type === 'div' && new RegExp('^' + id + '\\b').test(String((e.props || {}).title || '')); });
    return hit.length ? String(hit[hit.length - 1].props.title) : '';
  };
  const sfx850 = Object.assign(genRow('ap-9501'), { preset_side: 'sfx' });
  const music850 = Object.assign(genRow('ap-9502'), { preset_side: 'music' });
  const plain850 = genRow('ap-9503');
  const m = await mount([sfx850, music850, plain850], {});
  const tSfx = rowTip(m, 'ap-9501'), tMusic = rowTip(m, 'ap-9502'), tPlain = rowTip(m, 'ap-9503');
  check('T-850: the row the fade skips says so on its own popup, and the decision skips it — one row, one fact, both halves',
    pure603.isMusicRow603(sfx850) === false
      && /preset side: sfx/.test(tSfx) && /never a side a crossfade moves/.test(tSfx),
    { decided: pure603.isMusicRow603(sfx850), popup: tSfx.slice(0, 220) });
  check('T-850: the row the fade may move names its side and names the two conditions a fade needs',
    pure603.isMusicRow603(music850) === true
      && /preset side: music/.test(tMusic) && /when the switch is on and both takes clear the length floor/.test(tMusic),
    { decided: pure603.isMusicRow603(music850), popup: tMusic.slice(0, 240) });
  check('T-850: a row with no side on it prints nothing about a side — absence is not printed, and for that row the length floor is the answer',
    tPlain !== '' && !/preset side/.test(tPlain), tPlain.slice(0, 160));
  check('T-850 source: the side reaches the popup through the row-s own parts list, and no span keyed on the side was added to the row',
    (SRC.match(/parts\.push\(j\.preset_side === "sfx"/g) || []).length === 1
      && (SRC.match(/preset side: sfx \\u2014/g) || []).length === 1
      && (SRC.match(/preset side: music \\u2014/g) || []).length === 1
      && (SRC.match(/if \(j\.preset_side === "sfx" \|\| j\.preset_side === "music"\)/g) || []).length === 1,
    { pushes: (SRC.match(/parts\.push\(j\.preset_side === "sfx"/g) || []).length,
      gates: (SRC.match(/if \(j\.preset_side === "sfx" \|\| j\.preset_side === "music"\)/g) || []).length });
}

(async function main() {
  console.log('=== T-603 crossfade regressions ===');
  pureTests();
  sourceTests();
  await behaviourTests();
  await displayTests850();
  console.log('=== ' + pass + ' pass, ' + fail + ' fail ===');
  if (shimThrows()) process.exitCode = 1;
  function shimThrows() { return false; }
}()).catch(function (e) {
  console.log('  THREW  ' + (e && e.message));
  console.log('=== ' + pass + ' pass, ' + (fail + 1) + ' fail ===');
  process.exitCode = 1;
});
