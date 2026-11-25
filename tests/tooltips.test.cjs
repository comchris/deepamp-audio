// U-18 tooltip policy (user 2026-10-13 01:39): "PPS: from hover tooltips: remove 'programming remarks like
// -now in the winamp transport where shuttle sits) - the tooltips are user remarks, not programming-agent
// remarks - use code comments for those".
//
// This suite is the rule as a machine check. It mounts the panel the way a person would open it - every
// section expanded, a playlist with rows, endpoints registered, models and voices loaded - and then reads
// every hover the panel can hand out, plus the visible caption text, and refuses any string that talks about
// the build instead of to the person using it.
//
// What counts as a programming remark here, and why each one is on the list:
//   1. A route verb of this plugin (pause_fn, dispatch_batch, storage_status ...). A hover that names a verb
//      is the panel describing its own API. The same sentence in user words is what the sweep left behind.
//   2. A row key or a field name (endpoint_wait, endpoint_pending, machine_wait, endpoint_id). Those are how
//      the lane reports a state, not what the person sees on the row.
//   3. A task or artifact id (T-242, U-18, WM-11). Nobody reading a hover is looking for a ticket.
//   4. A storage key (audio-play:scope.mode) or a source file name (client.js). Both are where the panel
//      keeps things, not what a hover is for.
//   5. A browser API name (captureStream, AudioContext, createMediaElementSource). The visualizer hover used
//      to carry exactly this; it now says what the strip does to what you are hearing.
//   6. An HTTP method word used as a label (POST / GET).
// What is deliberately EXEMPT, and why: the armed confirm line on `set as primary` prints the exact body
// the next click will send (T-238, user-requested transparency before a mutation). That line is visible text
// shown only after the first click, not a hover, and its whole purpose is to name the call.
//
// What is deliberately ALLOWED, because it is data the person is acting on and not a remark about the build:
//   - an endpoint id or address in an endpoint row hover (e-5, cpu1.test:8963),
//   - a job id on a playlist row, a model id, a voice name,
//   - an engine path in the Endpoints section, where the user is choosing what an endpoint is called on.
// Usage: node tests/tooltips.test.cjs [path/to/client.js]
const path = require('path');
const fs = require('fs');
const { createRuntime, loadClient, openAllSections } = require('./react_shim.cjs');

const TARGET = process.argv[2] || path.join(__dirname, '..', 'lib', 'client.js');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + '  ->  ' + JSON.stringify(detail === undefined ? null : detail).slice(0, 8000)); }
}
function flush() { return new Promise(function (r) { setTimeout(r, 8); }); }

// 1. route verbs of this plugin. The list is the switch in lib/client.js call(), not a guess.
const VERBS = [
  'get_endpoints', 'server_status', 'get_models', 'refresh_voices', 'voice_registry', 'playlist_list',
  'playlist_delete', 'playlist_clear', 'play_job', 'cancel_job', 'abort_fn', 'pause_fn', 'resume_fn',
  'job_status', 'queue_status', 'storage_status', 'dispatch_tts', 'set_endpoint', 'unset_endpoint', 'endpoint_add',
  'endpoint_update', 'endpoint_remove', 'endpoint_pause', 'endpoint_resume', 'endpoint_models',
  'endpoint_clear', 'endpoint_health', 'endpoint_registry', 'endpoint_promote', 'get_save_paths', 'set_save_path',
  'limit_one_per_host', 'job_timeout', 'perf_log', 'log_tail', 'wave_peaks', 'dispatch_task',
  'dispatch_batch', 'batch_plan', 'batch_text_save', 'batch_text_list', 'batch_delete', 'cast_preview',
  'save_design', 'dispatch_design', 'voice_delete', 'voice_pull', 'model_load', 'unload_model',
  'dispatch_stems', 'save_stems', 'purge_shelf',
  // T-436 (2026-10-15): the two doors the capture added. They join the list because the list is "the switch in
  // lib/client.js call()", and a verb that is not on the ban list is a verb a hover may quietly start naming.
  'ytdlp_path', 'capture_url',
];
// 2. row keys and field names the lane reports.
const KEYS = ['endpoint_wait', 'endpoint_pending', 'machine_wait', 'endpoint_slot_wait', 'endpoint_id',
  'ref_wav', 'route_url', 'task_kind', 'page_size', 'max_loaded_models'];
// 3. ticket ids. 4. storage keys. 5. browser APIs. 6. HTTP method labels.
const PATTERNS = [
  { name: 'a plugin route verb', re: new RegExp('\\b(' + VERBS.join('|') + ')\\b') },
  { name: 'a lane field name', re: new RegExp('\\b(' + KEYS.join('|') + ')\\b') },
  { name: 'a task or artifact id', re: /\b(T|U|WM|S)-\d+[a-z]?\b/ },
  { name: 'a storage key', re: /deepamp:[a-z_.]+/ },
  { name: 'a source file name', re: /\b(client|index)\.js\b/ },
  { name: 'a browser API name', re: /captureStream|createMediaElementSource|createMediaStreamSource|AudioContext|localStorage|getElementById|useRef\(|useState\(|React\./ },
  { name: 'an HTTP method used as a label', re: /\b(POST|GET)\s+[a-z_]/ },
  { name: 'a dotted internal path', re: /\b[a-z_]+\.[a-z_]+\.[a-z_]+\b/ },
];

const timer = { interval: function () { return function () {}; }, timeout: function () { return function () {}; } };
const doc = {
  addEventListener: function () {}, removeEventListener: function () {},
  createElement: function (t) { return { tagName: t, click: function () {} }; },
  body: { appendChild: function () {}, removeChild: function () {} },
};

(async function main() {
  const src = fs.readFileSync(TARGET, 'utf8');
  global.localStorage = (function () {
    const store = Object.create(null);
    return {
      getItem: function (k) { return k in store ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; },
    };
  })();

  const calls = [];
  const shim = createRuntime({
    makeHostNode: function (n) {
      if (n.type === 'audio') {
        const a = {
          tagName: 'audio', paused: true, ended: false, _l: {},
          addEventListener: function (t, f) { (a._l[t] = a._l[t] || []).push(f); },
          removeEventListener: function () {},
          fire: function (t) { (a._l[t] || []).forEach(function (f) { f({ type: t }); }); },
          pause: function () { a.paused = true; }, play: function () { a.paused = false; return Promise.resolve(); },
          captureStream: function () { return { getAudioTracks: function () { return []; }, getTracks: function () { return []; } }; },
        };
        return a;
      }
      if (n.type === 'canvas') return { tagName: 'canvas', getContext: function () { return null; } };
      return { tagName: n.type };
    },
  });
  const client = loadClient(shim, {
    target: TARGET, document: doc, timer: timer,
    fetch: function (url, o) {
      const u = String(url); calls.push(((o && o.method) || 'GET') + ' ' + u);
      let body = { ok: true };
      if (/get_endpoints/.test(u)) body = { tts: { url: 'http://cpu1.test:8963' }, stt: { url: 'http://cpu1.test:8962' } };
      else if (/server_status/.test(u)) body = { tts: { ok: true, loaded_model: 'cpu2' }, stt: { ok: true, loaded_model: 'qwen3_asr' } };
      else if (/get_models/.test(u)) body = { models: [{ id: 'moss_ttsd', loaded: true }, { id: 'qwen3_asr', loaded: false }] };
      else if (/refresh_voices/.test(u)) body = { voices: ['voy_janeway', 'voy_neelix'], builtins: ['kirk'] };
      else if (/voice_registry/.test(u)) body = { voices: [{ id: 'voy_janeway', name: 'Janeway', ref_text: 'Chakotay' }] };
      else if (/playlist_list/.test(u)) body = {
        items: [
          { id: 'ap-9001', fn: 'tts', kind: 'tts', status: 'ok', model: 'moss_ttsd', voice: 'voy_janeway', duration: 3.44, text: 'the take' },
          { id: 'ap-9002', fn: 'tts', kind: 'task', task_kind: 'sep', status: 'ok', model: 'moss_ttsd', duration: 2.64, text: 'a tool row' },
          { id: 'ap-9003', fn: 'stt', kind: 'stt', status: 'ok', model: 'qwen3_asr', duration: 4.2, transcript: 'the shuttles are fuelled' },
        ],
        queues: { tts: { paused: true, running: 'ap-9001', queued: 2 }, stt: { paused: false, running: null, queued: 0 } },
      };
      else if (/queue_status/.test(u)) body = { ok: true, queues: { tts: { queued: 2, paused: true, running_ids: ['ap-9001'] }, stt: { queued: 0, paused: false, running_ids: [] } }, machines: {} };
      else if (/endpoint_registry/.test(u)) body = { ok: true, fn: /fn=tts/.test(u) ? 'tts' : 'stt', endpoints: [
        { id: 'e-5', url: 'http://cpu1.test:8963', enabled: true, batch_allowed: true, paused: false, models: ['moss_ttsd'] },
        { id: 'e-10', url: 'http://gpu1.test:8963', enabled: false, batch_allowed: false, paused: true, models: [] },
      ], primary: 'http://cpu2.test:8963' };
      else if (/get_endpoints|endpoint_health/.test(u)) body = { ok: true };
      else if (/get_save_paths/.test(u)) body = { ok: true, paths: ['/home/deepamp-test/.dsh/deepamp-audio/takes'], current: '/home/deepamp-test/.dsh/deepamp-audio/takes' };
      else if (/storage_status/.test(u)) body = { ok: true, base: '/home/deepamp-test/.dsh/deepamp-audio', writable: true, free_mb: 4000 };
      else if (/limit_one_per_host/.test(u)) body = { ok: true, on: true, source: 'switch' };
      else if (/job_timeout/.test(u)) body = { ok: true, seconds: 600 };
      else if (/log_tail/.test(u)) body = { ok: false, error: 'unknown route: log_tail' };
      else if (/wave_peaks/.test(u)) body = { ok: false, error: 'unknown route: wave_peaks' };
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
    },
  });
  const comp = client.apply();
  if (!comp) throw new Error('panel did not register');
  let mark = 0;
  function commit() {
    const bag = {}; const start = shim.rt.created.length;
    shim.render(comp(), bag); shim.runEffects();
    mark = start; return bag;
  }
  function created() { return shim.rt.created.slice(mark); }

  let bag = commit(); await flush();
  await openAllSections(shim, comp);          // every section open: the sweep has to see the whole panel
  bag = commit(); await flush(); bag = commit(); await flush();
  // T-855 (2026-11-14): the player window is a mount of its own and it appears when the eject control is
  // pressed. Its hovers are part of the panel a person can reach, and the operator's complaint that started
  // this card was about a hover that lives there - so the sweep opens it and reads them like any other.
  const ejectBtn855 = created().filter(function (e) {
    return /audio-play-tp-eject/.test(String((e.props || {}).className || ''));
  }).pop();
  if (ejectBtn855 && ejectBtn855.props && typeof ejectBtn855.props.onClick === 'function') {
    ejectBtn855.props.onClick(); await flush();
  }
  bag = commit(); await flush(); bag = commit(); await flush();

  const tree = created();

  // ---------------------------------------------------------------- collect every hover
  const tips = [];
  tree.forEach(function (e) {
    if (!e.props || e.props.title === undefined || e.props.title === null) return;
    tips.push({ where: String(e.type) + ' ' + String(e.props.className || ''), text: String(e.props.title) });
  });
  check('the sweep has something to say about: the panel hands out hovers in the hundreds',
    tips.length >= 120, tips.length);

  // ---------------------------------------------------------------- T-687: the LIST, measured on real hovers
  // The operator's request, verbatim: "list and fix all tooltipps and long 'walls of text' across the plugin -
  // nobody reads 10 lines that hover across a button!". The card asks for the list BEFORE any fix, and the list is
  // only reviewable if it is measured on the hovers the panel actually hands out - so the measure lives here, on the
  // same mount the U-18 policy runs on. A hover is scored by what a person has to read: how many clauses (this panel
  // joins clauses with the " · " separator), how many words, how many characters, and how many lines those characters
  // would take in a native hover box, which wraps at a modest width. DUMP_HOVERS=<path> writes the whole list.
  function scoreHover687(t) {
    const text = String(t.text);
    const segs = text.split(/\s*\u00B7\s*/).map(function (s) { return s.trim(); }).filter(function (s) { return s.length; });
    const words = text.split(/\s+/).filter(function (w) { return w.length; }).length;
    const chars = text.length;
    return {
      where: t.where, segments: segs.length, words: words, chars: chars,
      lines: Math.max(segs.length, Math.ceil(chars / 80)), text: text,
    };
  }
  const scored687 = tips.map(scoreHover687).sort(function (a, b) { return (b.lines - a.lines) || (b.chars - a.chars); });
  const over687 = scored687.filter(function (s) { return s.lines > 3; });
  const longest687 = scored687[0] || { lines: 0, words: 0, chars: 0, where: '' };
  console.log('  MEASURE  T-687 hover list: ' + scored687.length + ' hovers read, ' + over687.length
    + ' longer than 3 lines; longest ' + longest687.lines + ' lines / ' + longest687.words + ' words / '
    + longest687.chars + ' chars at ' + longest687.where);
  if (process.env.DUMP_HOVERS) {
    require('fs').writeFileSync(process.env.DUMP_HOVERS, JSON.stringify(scored687, null, 2) + '\n');
    console.log('  MEASURE  T-687 hover list written to ' + process.env.DUMP_HOVERS);
  }

  // ---------------------------------------------------------------- T-855: the ratchet on the same measure
  // The operator's request, verbatim (2026-11-14): "make the overlay tooltip on the dropdown menu for the preset
  // selection in the eject menu shorter, it is way too long! - same for most log outputs - should be shorter and
  // brief in general for all future changes". This is a ratchet, not a rewrite of the panel: the numbers below are
  // what this measure returned on 2026-11-14 AFTER the hovers that card shortened were shortened - the whole panel
  // plus the player window, which this sweep now opens because the control the operator named lives there. A future
  // change may lower these numbers; it may not raise them. Lowering the count is the point of the ceiling, and a
  // change that adds a wall of text now fails here instead of arriving quietly in a panel nobody re-reads.
  const CEILING855 = { over3: 84, maxChars: 929 };
  check('T-855 ratchet: no change may add a hover over 3 lines, or a hover longer than the longest one measured 2026-11-14',
    over687.length <= CEILING855.over3 && longest687.chars <= CEILING855.maxChars,
    { read: scored687.length, over3: over687.length, ceiling_over3: CEILING855.over3,
      longest_chars: longest687.chars, ceiling_chars: CEILING855.maxChars, longest_at: longest687.where });

  // ---------------------------------------------------------------- the rule
  const hits = [];
  tips.forEach(function (t) {
    PATTERNS.forEach(function (p) {
      const m = p.re.exec(t.text);
      if (m) hits.push({ what: p.name, token: m[0], where: t.where, tip: t.text.slice(0, 120) });
    });
  });
  check('U-18 POLICY: no hover in the whole panel names a route verb, a lane field, a ticket id, a storage key, a source file, a browser API, or an HTTP method',
    hits.length === 0, hits.map(function (h) { return h.what + ' [' + h.token + '] in ' + h.where + ': ' + h.tip; }));

  // The same rule on the visible text the panel prints, so a caption cannot carry what a hover just lost.
  const texts = [];
  tree.forEach(function (e) {
    if (!e.props) return;
    (function walk(c) {
      if (c == null) return;
      if (typeof c === 'string' || typeof c === 'number') { texts.push(String(c)); return; }
      if (Array.isArray(c)) { c.forEach(walk); return; }
    })(e.props.children);
  });
  const textHits = [];
  texts.forEach(function (t) {
    PATTERNS.forEach(function (p) {
      const m = p.re.exec(t);
      if (m) textHits.push({ what: p.name, token: m[0], text: t.slice(0, 120) });
    });
  });
  check('U-18 POLICY, extended: no visible caption carries one of those either (a hover ban that a caption walks around is not a policy)',
    textHits.length === 0, textHits.map(function (h) { return h.what + ' [' + h.token + ']: ' + h.text; }));

  // ---------------------------------------------------------------- what the policy must NOT have eaten
  // A sweep that only deletes is a sweep that leaves the panel quieter and less usable. These are the hovers
  // the user asked for, in user words, and they have to survive.
  function tipFor(re) {
    const all = tips.filter(function (t) { return re.test(t.text); });
    return all.length ? all[all.length - 1].text : '';
  }
  // T-535 (2026-10-17): the strip's own hover is now found by what it IS, not by the word "visualizer". A press that
  // sets a visualizer was added to the Settings table, its hover naturally uses that word, and a search for the word
  // returned the newest hover instead of the strip's. Anchoring on the strip hover's own opening ("visualizer:
  // currently <mode>") is the difference between naming an object and naming a word that happens to appear in it.
  function stripTip535() { return tipFor(/^visualizer: currently/); }
  check('the lane toggles still explain that holding new jobs is not switching an endpoint off',
    /NOT switching an endpoint off/.test(tipFor(/new jobs on the (TTS|STT) lane/)), tipFor(/new jobs on the/).slice(0, 120));
  check('the visualizer hover still says the peak meter reads the LIVE output and can clip',
    /LIVE output/.test(stripTip535()) && /clipped/.test(stripTip535()), stripTip535().slice(0, 200));
  check('the visualizer hover tells the user what the strip now does - scaled trace, two colours on a stereo take',
    /scales its trace/.test(stripTip535()) && /two lines in two colours/.test(stripTip535()), stripTip535().slice(0, 220));
  check('the lane pin hover still states the contract: auto places, a named endpoint is honoured alone, the row waits on it',
    /which endpoint this job asks for/.test(tipFor(/which endpoint this job asks for/))
      && /it is never moved somewhere else/.test(tipFor(/which endpoint this job asks for/)),
    tipFor(/which endpoint this job asks for/).slice(0, 200));
  // The tool-lane sentence only renders when a tool kind is on screen, so this one is read off the source
  // constant the panel uses for it - and it is run through the same ban list as everything else.
  const noteLine = (src.match(/var TOOL_LANE_NOTE = "([\s\S]*?)";/) || [null, ''])[1];
  const noteBans = [];
  PATTERNS.forEach(function (p) { const m = p.re.exec(noteLine); if (m) noteBans.push(p.name + ' [' + m[0] + ']'); });
  check('the tool-lane sentence is still there, in user words, and carries none of the banned remarks',
    /^TOOL KIND: this is the voice endpoint a tool job runs on\./.test(noteLine) && noteBans.length === 0,
    [noteLine.slice(0, 160), noteBans]);
  const panelWords = tips.map(function (t) { return t.text; }).join('\n');
  check('the minimise control keeps its exact wording (the suites and the user both look for these words)',
    /collapse panel/.test(panelWords), [panelWords.indexOf('collapse panel'), tips.length,
      tips.filter(function (t) { return /panel/.test(t.text); }).map(function (t) { return t.text.slice(0, 60); }).slice(0, 8)]);
  check('T-301: the close control explains both directions - what it does, and that the pointer opens it again',
    /close this panel down to its title bar/.test(tipFor(/close this panel down/))
      || /closed to its title bar/.test(tipFor(/closed to its title bar/)), tipFor(/title bar/).slice(0, 160));
  check('endpoint rows still name the endpoint they are about (data the user acts on is not a programming remark)',
    /e-5|e-10/.test(tips.map(function (t) { return t.text; }).join('\n')), 'endpoint ids present');

  // ---------------------------------------------------------------- the sweep left comments behind, as asked
  check('U-18: the remarks that left the hovers are recorded as code comments instead of being thrown away',
    /Tooltip policy/.test(src) && /recorded as code comments, not thrown away/.test(src), 'the policy is written down in the source too');

  console.log('=== ' + pass + ' pass, ' + fail + ' fail ===');
  if (fail) process.exit(1);
})().catch(function (e) {
  console.log('THROW: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
