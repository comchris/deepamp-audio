// T-300 U-8a (2026-10-12, user request: "current log section still seems to be always empty — analyse").
// The analysis said the emptiness has three causes, and this suite covers the one a panel can fix by
// itself: the event log was React state, the ONE piece of panel state a reload threw away, so the section
// emptied exactly when a person reloaded to look at it. What is tested here is that the log now survives
// a reload, that it survives it CAPED and validated rather than as whatever was in storage, that clearing
// it is explicit, and that the section is honest about being this page's log rather than the lane's.
// Usage: node tests/event_log.test.cjs [path/to/client.js]
const path = require('path');
const { createRuntime, loadClient, openAllSections } = require('./react_shim.cjs');

const TARGET = process.argv[2] || path.join(__dirname, '..', 'lib', 'client.js');
const KEY = 'deepamp:events';

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

// The shim ships no localStorage, so the client's own guard (typeof localStorage === "undefined") makes
// every lsGet/lsSet a no-op inside a test. Injecting a store into the global is what lets this suite test
// persistence as behaviour instead of as a grep over the source.
function makeStore(seed) {
  const m = new Map(seed || []);
  return {
    getItem: function (k) { return m.has(k) ? m.get(k) : null; },
    setItem: function (k, v) { m.set(k, String(v)); },
    removeItem: function (k) { m.delete(k); },
    raw: function (k) { return m.has(k) ? m.get(k) : null; },
    size: function () { return m.size; },
  };
}

const timer = { interval: function () { return function () {}; }, timeout: function () { return function () {}; } };
const doc = { addEventListener: function () {}, removeEventListener: function () {}, createElement: function (t) { return { tagName: t, click: function () {} }; }, body: { appendChild: function () {}, removeChild: function () {} } };

// T-300 U-8b: the lane-log answer a page instance gets back from log_tail. A test reassigns it
// before opening a page, so the honest states (absent file, switched-off log, unknown route, a window
// read from the START instead of the END) are each shown to a real render instead of being asserted
// against the source text.
let laneAnswer = {
  ok: true, exists: true, on: true, file: '/home/deepamp-test/.dsh/deepamp-audio/perf_log.jsonl', limit: 25,
  total_bytes: 3693135, window_bytes: 131072, window: 'tail', truncated: true, dropped_partial: 1,
  bad_lines: 0, lines_read: 390, lines_parsed: 390,
  entries: [
    { ts: 1760000000100, ev: 'synth', fn: 'tts', job: 'ap-0001', model: 'moss_ttsd', ms: 1234, host: 'cpu2.test' },
    { ts: 1760000000200, ev: 'dispatch_refuse', fn: 'tts', job: 'ap-0002', reason: 'endpoint paused', ep: 'gpu1.test:8963' },
  ],
};
const fetchCalls = [];

function host(url, opts) {
  const u = String(url);
  fetchCalls.push(((opts && opts.method) || 'GET') + ' ' + u);
  let body = { ok: true };
  if (/get_endpoints/.test(u)) body = { tts: { url: 'http://cpu1.test:8963', route: 'speech' }, stt: { url: 'http://cpu1.test:8962', route: 'tasks' } };
  else if (/server_status/.test(u)) body = { tts: { ok: true, loaded_model: 'm1' }, stt: { ok: true } };
  else if (/get_models/.test(u)) body = { models: [{ id: 'm1', loaded: true }] };
  else if (/refresh_voices/.test(u)) body = { voices: ['voy_janeway'], builtins: ['alba'], builtins_source: 'mirror', default_voice: '' };
  else if (/playlist_list/.test(u)) body = { items: [], queues: { tts: { paused: false }, stt: { paused: false } } };
  else if (/queue_status/.test(u)) body = { ok: true, queues: { tts: { queued: 0 }, stt: { queued: 0 } } };
  else if (/log_tail/.test(u)) body = laneAnswer;
  return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
}

// One page instance: mount, open every section, and give the helpers that view of the last render only.
async function openPage() {
  const shim = createRuntime();
  const client = loadClient(shim, { target: TARGET, fetch: host, timer: timer, document: doc });
  const comp = client.apply();
  if (!comp) throw new Error('panel did not register');
  let mark = 0;
  function commit() { const b = {}; const start = shim.rt.created.length; shim.render(comp(), b); shim.runEffects(); mark = start; return b; }
  function created() { return shim.rt.created.slice(mark); }
  function ownText(e) { const c = e.props && e.props.children; return (typeof c === 'string') ? c : ''; }
  function byText(re) { return created().filter(function (e) { return re.test(ownText(e)) }); }
  function btn(label) {
    const all = created().filter(function (e) { return e.type === 'button' && ownText(e) === label; });
    return all.length ? all[all.length - 1] : null;
  }
  let bag = commit(); await flush();
  await openAllSections(shim, comp);
  bag = commit(); await flush(); bag = commit(); await flush();
  return { shim: shim, commit: commit, created: created, ownText: ownText, byText: byText, btn: btn, bag: bag };
}

(async function main() {
  // 1. A page that did something writes its log into storage and shows it.
  global.localStorage = makeStore();
  let pg = await openPage();
  // T-316 MIGRATION (user ruling 2026-10-14): the transport controls are drawn as inline SVG, so they are
  // found by the class they carry, not by a character.
  const stop = pg.created().filter(function (e) {
    return e.type === 'button' && String((e.props || {}).className || '').split(/\s+/).indexOf('audio-play-tp-stop') >= 0;
  }).pop();
  if (!stop) throw new Error('stop button not found (transport missing?)');
  stop.props.onClick();                       // stop posts no verb and notifies by design
  await flush(); pg.commit(); await flush();

  const stored = JSON.parse(global.localStorage.raw(KEY) || 'null');
  check('U-8a: an event the panel reported is written to storage under audio-play:events',
    Array.isArray(stored) && stored.length >= 1 && /playback stopped/.test(stored[0].text), stored);
  check('U-8a: the stored entry keeps severity and timestamp, not just the sentence',
    Array.isArray(stored) && typeof stored[0].ts === 'number' && stored[0].ts > 0
      && ['info', 'ok', 'error'].indexOf(stored[0].type) >= 0, stored[0]);
  check('U-8a: the same event is readable in the section on the page that caused it',
    pg.byText(/playback stopped/).length >= 1);
  // T-300 U-8b CONTRACT CHANGE: the section holds two sources, so its name named both.
  // T-432 CONTRACT CHANGE (user 2026-10-15): "rename section 'log (...)' to 'Logs' (shorter)". The name is short
  // now and the explanation moved to the header's hover, which is where explanatory text belongs in this panel. The
  // U-8a rule still stands inside the new arrangement - the page's own list and the lane's list are labelled by
  // WHO PRODUCED them, and the section is not allowed to call the whole thing the lane's log. T-520 (2026-10-16)
  // renamed the page label from "this page (panel)" to "panel log"; the distinction is the part that had to survive.
  // This check is stricter than the one it replaces: it pins the short title, the hover that carries both sources,
  // and both block labels.
  check('U-8b / T-432 / T-520: the header is short - "Logs" - its hover names both sources, and the two blocks are labelled by who produced them',
    pg.byText(/^Logs/).length >= 1
      && pg.created().some(function (e) {
        return typeof e.props.onToggle === 'function' && e.props.title === 'Logs'
          && /page/.test(String(e.props.titleHint || '')) && /lane/.test(String(e.props.titleHint || ''));
      })
      && pg.byText(/^panel log$/).length >= 1
      && pg.byText(/^lane log \(host\)$/).length >= 1,
    pg.byText(/^Logs |^panel log$|^lane log /).map(pg.ownText));

  // --- T-520 (user 2026-10-16, verbatim): "remove text Logs: 'this page (panel)'" ------------------------
  // The phrase is gone. What it was doing — telling a reader WHICH of two logs a line came from — is done by
  // naming the actor instead, in the same shape its neighbour already used.
  check('T-520: "this page (panel)" is not printed anywhere in the section as drawn — not moved, not hidden, gone',
    pg.byText(/this page \(panel\)/).length === 0,
    pg.byText(/this page/).map(pg.ownText).map(function (t) { return t.slice(0, 60); }));
  check('T-520: the two logs are STILL distinguishable, which is what the removed label was carrying — two labels, both present, both different, each naming its source',
    pg.byText(/^panel log$/).length === 1 && pg.byText(/^lane log \(host\)$/).length === 1,
    { page_label: pg.byText(/^panel log$/).map(pg.ownText), lane_label: pg.byText(/^lane log \(host\)$/).map(pg.ownText) });
  check('T-520: the label still sits on its OWN line rather than inside the toolbar row, so the count sentence still begins with the number it is about (the T-300 placement rule the rename had to keep)',
    pg.created().filter(function (e) { return e.props && e.props.className === 'audio-play-log-page-head'; }).length === 1
    && pg.byText(/^\d+ event\(s\) kept/).length >= 1,
    { head_lines: pg.created().filter(function (e) { return e.props && e.props.className === 'audio-play-log-page-head'; }).length, count_lines: pg.byText(/^\d+ event\(s\) kept/).map(function (e) { return e.props.children.slice(0, 40); }) });
  check('T-520: the sentences that tell you what an action TOUCHES kept their wording — clearing this log clears this page\u2019s list and its stored copy, and never the lane\u2019s records',
    pg.created().some(function (e) {
      return e.type === 'button' && /clear this page.s log \(the stored copy too\)/.test(String(e.props.title || ''));
    }), { hover: 'clear this page\u2019s log (the stored copy too)' });

  // 2. THE FIX: a second page instance, nothing clicked, still shows the first page's event.
  const seed = global.localStorage.raw(KEY);
  global.localStorage = makeStore([[KEY, seed]]);
  pg = await openPage();
  check('U-8a: after a reload the log is STILL THERE (this is the bug the user reported)',
    pg.byText(/playback stopped/).length >= 1, pg.byText(/no events on this page yet/).map(pg.ownText));
  check('U-8a: a restored log does not claim to be empty',
    pg.byText(/no events on this page yet/).length === 0);

  // 3. Storage is not trusted: garbage becomes an empty log, and an oversized blob is capped.
  global.localStorage = makeStore([[KEY, 'this is not JSON at all']]);
  pg = await openPage();
  check('U-8a: a corrupt stored log yields an empty section and a working panel, not a crash',
    pg.byText(/no events on this page yet/).length >= 1);
  const messyBlob = JSON.stringify([
    { ts: 1727000000000, text: 'kept entry', type: 'ok' },
    'a bare string', null, 42,
    { text: 'no timestamp at all' },
    { ts: 'not a number', text: 'bad ts', type: 'error' },
  ]);
  global.localStorage = makeStore([[KEY, messyBlob]]);
  pg = await openPage();
  // An ENTRY is kept when it is an object: its sentence is what a person reads, and a missing or
  // unusable timestamp becomes an undated row rather than a deleted event. A bare string, a number or
  // null is not an event at all, and those are what get dropped.
  check('U-8a: a stored blob that is not a list of event objects is read as events, not trusted as text',
    pg.byText(/^kept entry$/).length >= 1 && pg.byText(/a bare string|^42$/).length === 0,
    pg.byText(/kept entry|bare string|42/).map(pg.ownText));
  check('U-8a: an entry with no usable timestamp is kept as an undated row, not silently deleted',
    pg.byText(/^no timestamp at all$/).length >= 1 && pg.byText(/^bad ts$/).length >= 1,
    pg.byText(/timestamp|bad ts/).map(pg.ownText));
  const many = [];
  for (let i = 0; i < 400; i++) many.push({ ts: 1727000000000 + i, text: 'flood ' + i, type: 'info' });
  global.localStorage = makeStore([[KEY, JSON.stringify(many)]]);
  pg = await openPage();
  const keptLine = pg.byText(/event\(s\) kept/).map(pg.ownText)[0] || '';
  check('U-8a: a hand-made 400-entry blob is capped at the 50 the panel already keeps',
    /50 event\(s\) kept/.test(keptLine), keptLine);

  // 4. Clearing is explicit, clears both copies, and says so in the log it just cleared.
  global.localStorage = makeStore([[KEY, JSON.stringify([{ ts: 1727000000000, text: 'to be cleared', type: 'info' }])]]);
  pg = await openPage();
  const clr = pg.btn('clear log');
  if (!clr) throw new Error('clear log button not found');
  clr.props.onClick();
  await flush(); pg.commit(); await flush();
  // Clearing empties everything that was there, and the panel still reports the action it just took —
  // its own rule is that every action says what it did, and a silent clear is a clear you cannot verify.
  // So what remains is exactly one row, and it is the announcement, not a leftover event.
  const afterClear = JSON.parse(global.localStorage.raw(KEY) || '[]');
  check('U-8a: clear removes the stored events; what is left is the one row saying it was cleared',
    afterClear.length === 1 && /log was cleared/.test(afterClear[0].text), afterClear);
  check('U-8a: the event that was there before the clear is gone from the page too',
    pg.byText(/^to be cleared$/).length === 0, pg.byText(/cleared/).map(pg.ownText));
  check('U-8a: clearing says what it cleared and what it did NOT touch',
    pg.byText(/this page.s log was cleared/).length >= 1 && pg.byText(/lane.s own records are untouched/).length >= 1);
  check('U-8a: the clear button is labelled clear log, not a bare clear (the endpoint rows own clear)',
    !!pg.btn('clear log') && !pg.btn('clear'));

  // ---- T-300 U-8b: the lane's own log, read off the host --------------------------------------
  console.log('--- U-8b: the lane log block ---');
  {
    global.localStorage = makeStore();
    laneAnswer = {
      ok: true, exists: true, on: true, file: '/home/deepamp-test/.dsh/deepamp-audio/perf_log.jsonl', limit: 25,
      total_bytes: 3693135, window_bytes: 131072, window: 'tail', truncated: true, dropped_partial: 1,
      bad_lines: 0, lines_read: 390, lines_parsed: 390,
      entries: [
        { ts: 1760000000100, ev: 'synth', fn: 'tts', job: 'ap-0001', model: 'moss_ttsd', ms: 1234, host: 'cpu2.test' },
        { ts: 1760000000200, ev: 'dispatch_refuse', fn: 'tts', job: 'ap-0002', reason: 'endpoint paused', ep: 'gpu1.test:8963' },
      ],
    };
    fetchCalls.length = 0;
    let pg2 = await openPage();
    const cls = function (re) {
      return pg2.created().filter(function (e) { return re.test(String((e.props && e.props.className) || '')); });
    };
    check('U-8b: the lane block says it has not been read yet, instead of showing an empty space',
      pg2.byText(/not read from the host yet/).length >= 1, pg2.byText(/lane log/).map(pg2.ownText).slice(0, 4));
    check('U-8b: nothing is fetched on opening a page — a fresh instance issued no log_tail call',
      fetchCalls.filter(function (u) { return /log_tail/.test(u); }).length === 0, fetchCalls.filter(function (u) { return /log_tail/.test(u); }));

    const readBtn = pg2.btn('read lane log');
    check('U-8b: the block has its own button, labelled read lane log', !!readBtn && typeof readBtn.props.onClick === 'function');
    if (readBtn) {
      readBtn.props.onClick();
      await flush(); pg2.commit(); await flush();
      const tails = fetchCalls.filter(function (u) { return /log_tail/.test(u); });
      check('U-8b: pressing it issues exactly one log_tail read, and it is a POST',
        tails.length === 1 && tails[0].indexOf('POST ') === 0, tails);
      const rows = cls(/audio-play-log-lane-row/);
      check('U-8b: the host records render as their own rows, not mixed into the page rows',
        rows.length === 2 && cls(/audio-play-log-row$/).length !== rows.length, { lane: rows.length });
      const evs = cls(/audio-play-log-lane-ev/).map(function (e) { return pg2.ownText(e); });
      check('U-8b: each lane row prints the host event name it carries (synth, dispatch_refuse)',
        evs.indexOf('synth') >= 0 && evs.indexOf('dispatch_refuse') >= 0, evs);
      const meta = pg2.byText(/byte file, last 131072 bytes read/);
      check('U-8b: the block says how big the file is and how much of it the read covered',
        meta.length >= 1 && /read .* ago/.test(meta[0].props.children), meta.map(function (e) { return e.props.children; }));
      check('U-8b: a truncated read is announced as truncated rather than presented as the whole history',
        pg2.byText(/the read stopped at 25 records; the file holds more/).length >= 1);
      check('U-8b: the lane records are not written into the page log (two sources, one list each)',
        pg2.byText(/^endpoint paused$/).length === 0 && pg2.byText(/endpoint paused/).length >= 1,
        pg2.byText(/endpoint paused/).map(pg2.ownText));

      // Opening the section reads once. Toggle it closed and open again and the read happens then.
      fetchCalls.length = 0;
      global.localStorage = makeStore();
      let pg3 = await openPage();
      // The header's own text carries the open/close arrow after the title ("Log (...)▸"), so the
      // match is a prefix, not an equality - the same trap the transparency suite walked into.
      // `title` is a PROP of Collapsible and the pane renders it into a span of its own, so the flat
      // created() list holds no div whose OWN text is the title (ownText here reads props.children
      // only, and children are elements here). What IS reachable is the Collapsible element and its
      // onToggle prop - and onToggle is exactly the prop the auto-read is wired to, so driving it
      // directly tests the behaviour instead of a rendering detail.
      // Re-looked-up after every commit, because a handler closure captures the render it came from.
      // Clicking the SAME element object twice in a row drives a stale closure — in a browser the
      // next click lands on a freshly rendered header. Re-finding it is what makes this test measure
      // the panel rather than the shim's element identity.
      function logHead() {
        return pg3.created().filter(function (e) {
          return typeof e.props.onToggle === 'function'
            && /^Logs$/.test(String(e.props.title || ''));   // T-432: the header is "Logs" since 2026-10-15
        });
      }
      let hh = logHead();
      check('U-8b: the Log header is reachable and toggles', hh.length >= 1, hh.length);
      if (hh.length) {
        hh[0].props.onToggle(); pg3.commit(); await flush();          // closes: no read
        check('U-8b: closing the section reads nothing', fetchCalls.filter(function (u) { return /log_tail/.test(u); }).length === 0, fetchCalls.length);
        hh = logHead(); if (hh.length) hh[0].props.onToggle();
        pg3.commit(); await flush(); pg3.commit(); await flush();     // opens: one read
        const t3 = fetchCalls.filter(function (u) { return /log_tail/.test(u); });
        check('U-8b: opening the section reads the lane log ONCE (bounded: one window per open, no timer)',
          t3.length === 1, t3);
        hh = logHead(); if (hh.length) hh[0].props.onToggle();
        pg3.commit(); await flush();                                   // closes again
        hh = logHead(); if (hh.length) hh[0].props.onToggle();
        pg3.commit(); await flush();                                   // opens again: no re-read
        await flush();
        check('U-8b: a second open does NOT re-read when an answer is already in hand',
          fetchCalls.filter(function (u) { return /log_tail/.test(u); }).length === 1, fetchCalls.filter(function (u) { return /log_tail/.test(u); }).length);
      }
    }

    // The honest states, each shown to a real render.
    const stateCases = [
      { label: 'no lane log file on the host yet', ans: { ok: true, exists: false, on: true, entries: [], limit: 25, window: 'from_start', window_bytes: 131072, total_bytes: 0 }, re: /no lane log file yet/ },
      { label: 'a host that predates the verb (unknown route)', ans: { ok: false, exists: false, error: 'unknown route', entries: [] }, re: /could not answer: unknown route/ },
      { label: 'the lane log switched off on the host', ans: { ok: true, exists: true, on: false, entries: [{ ts: 1760000000300, ev: 'toggle' }], limit: 25, window: 'tail', window_bytes: 4096, total_bytes: 8192 }, re: /switched off on the host/ },
      { label: 'a window read from the START rather than the END', ans: { ok: true, exists: true, on: true, entries: [{ ts: 1760000000400, ev: 'synth', fn: 'tts' }], limit: 25, window: 'from_start', window_bytes: 131072, total_bytes: 900000 }, re: /OLDEST records in it, not the newest/ },
    ];
    for (let i = 0; i < stateCases.length; i++) {
      const c = stateCases[i];
      laneAnswer = c.ans;
      global.localStorage = makeStore();
      const pgS = await openPage();
      const btnS = pgS.btn('read lane log');
      if (btnS) { btnS.props.onClick(); await flush(); pgS.commit(); await flush(); }
      check('U-8b: ' + c.label + ' is said out loud in the block', pgS.byText(c.re).length >= 1,
        pgS.byText(/lane log|not read|could not|switched|OLDEST|no lane log/).map(pgS.ownText).slice(0, 3));
    }
    laneAnswer = { ok: true, exists: true, on: true, entries: [], limit: 25, window: 'tail', window_bytes: 0, total_bytes: 0 };
  }

  console.log('=== ' + pass + ' pass, ' + fail + ' fail ===');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.log('THROW ' + (e && e.stack || e)); process.exit(1); });
