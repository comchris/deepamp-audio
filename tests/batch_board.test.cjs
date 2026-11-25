// T-403 (T-383 visibility, user ruling 2026-10-15, "Build the batch-level board now").
// The failure policy says "retry once on another endpoint, then stop the rest". The lane already sends that
// state on a batch row (rowOf, lib/index.js 4055-4058: batch_retry_of, batch_retried_to, batch_halt,
// batch_wait_retry) and it keeps them across a restart. This suite drives the panel with rows in exactly
// those shapes and asks the one question that matters to the person at the panel: does the batch board say,
// in words, which parts the policy STOPPED, which parts it is still WAITING on, and which got a second
// attempt — and does it keep "stopped" and "waiting" apart, the way the host's own rule demands.
// No audio is involved and no batch is dispatched: these are lane row shapes, read from the live rowOf.
// Usage: node tests/batch_board.test.cjs [path/to/client.js]
const path = require('path');
const { createRuntime, loadClient, openAllSections } = require('./react_shim.cjs');

const TARGET = process.argv[2] || path.join(__dirname, '..', 'lib', 'client.js');
const BATCH = 'b-77';
const HALT_WHY = 'part 2 failed twice; the policy stopped the rest of the batch';
const WAIT_WHY = 'held while part 2\u2019s second attempt is in flight';

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail !== undefined ? '  ->  ' + detail : '')); }
}

/** One batch, four declared parts, in the two states the policy actually produces. */
function rowsFor(state) {
  const base = { fn: 'tts', kind: 'tts', model: 'moss_ttsd', batch_id: BATCH, batch_parts: 4, batch_title: 'Chapter 3' };
  const mk = function (id, part, status, extra) {
    const r = Object.assign({}, base, { id: id, batch_part: part, status: status, created: 1792000000000 + part, started: 1792000000000 + part, duration: status === 'ok' ? 4.2 : 0 }, extra || {});
    return r;
  };
  const out = [
    mk('ap-0501', 1, 'ok', { voice: 'arnold', batch_cast: ['arnold'], endpoint_id: 'e-1' }),
    mk('ap-0502', 2, 'error', { voice: 'john', error: 'curl exit 22: upstream 500', batch_retried_to: 'e-2', endpoint_id: 'e-1' }),
    mk('ap-0505', 2, state === 'halted' ? 'error' : 'running', { voice: 'john', batch_retry_of: 'ap-0502', endpoint_id: 'e-2', error: state === 'halted' ? 'curl exit 22: upstream 500' : '' }),
  ];
  if (state === 'halted') {
    out.push(mk('ap-0503', 3, 'cancelled', { voice: 'sarah', batch_halt: HALT_WHY }));
    out.push(mk('ap-0504', 4, 'cancelled', { voice: 'wife', batch_halt: HALT_WHY }));
  } else {
    out.push(mk('ap-0503', 3, 'queued', { voice: 'sarah', batch_wait_retry: WAIT_WHY }));
    out.push(mk('ap-0504', 4, 'queued', { voice: 'wife', batch_wait_retry: WAIT_WHY }));
  }
  return out;
}

function makeLane(state, seen) {
  const items = state === 'empty' ? [] : rowsFor(state);
  const fetchImpl = function (url, opts) {
    const method = ((opts && opts.method) || 'GET').toUpperCase();
    const u = String(url);
    seen.calls.push(method + ' ' + u);
    let body;
    if (/playlist_list/.test(u)) body = { items: items };
    else if (/get_endpoints/.test(u)) body = { tts: { url: 'http://cpu1.test:8963', route: 'speech' }, stt: { url: 'http://cpu1.test:8962', route: 'speech' } };
    else if (/queue_status/.test(u)) body = { ok: true, queues: { tts: { paused: false, running: null, queued: 0, slots: { max: 2, used: 0 }, host_cap: 2, host_cap_source: 'default' }, stt: { paused: false, running: null, queued: 0, slots: { max: 2, used: 0 }, host_cap: 2, host_cap_source: 'default' } }, machines: {} };
    else if (/get_models|refresh_voices|voice_groups|voice_registry/.test(u)) body = { models: [{ id: 'moss_ttsd', loaded: true }], voices: ['arnold', 'john', 'sarah', 'wife'], groups: [] };
    else body = { ok: true };
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
  };
  return fetchImpl;
}

/** Own text of a created element: its direct string children, joined. */
function own(e) {
  const c = (e.props && e.props.children);
  if (c === undefined || c === null) return '';
  const arr = Array.isArray(c) ? c : [c];
  return arr.map(function (x) { return (typeof x === 'string' || typeof x === 'number') ? String(x) : ''; }).join('');
}
/** Text of an element and everything under it, for rows whose children are elements. */
function deepText(e) {
  if (e === null || e === undefined) return '';
  if (typeof e === 'string' || typeof e === 'number') return String(e);
  const c = e.props && e.props.children;
  if (c === undefined || c === null) return '';
  const arr = Array.isArray(c) ? c : [c];
  return arr.map(function (x) {
    if (typeof x === 'string' || typeof x === 'number') return String(x);
    if (x && x.props) return deepText(x);
    return '';
  }).join(' ');
}
function byCls(shim, cls) {
  return shim.rt.created.filter(function (e) { return String((e.props && e.props.className) || '') === cls; });
}
/** Newest mount only: rt.created accumulates across mounts in a scenario. */
function lastMatch(list) { return list.length ? list[list.length - 1] : null; }

async function run(state) {
  console.log('\n--- batch board, lane state: ' + state + ' ---');
  const seen = { calls: [] };
  const shim = createRuntime();
  const client = loadClient(shim, { target: TARGET, fetch: makeLane(state, seen), timer: { timeout: function () { return function () {}; }, interval: function () { return function () {}; } } });
  const comp = client.apply();
  if (!comp) throw new Error('panel did not register');
  shim.renderAndCommit(comp());
  await shim.flush();
  await openAllSections(shim, comp);
  shim.renderAndCommit(comp());
  await shim.flush();
  if (shim.rt.throws.length) {
    const t = shim.rt.throws[0];
    throw new Error(t.where + ': ' + (t.err && t.err.message));
  }

  // A batch group is collapsed until it is clicked — that is the board's own design, "one line per batch, click
  // it for its parts". Reading the parts means clicking the line the way a person does, not reaching past it.
  if (state !== 'empty') {
    const opener = lastMatch(byCls(shim, 'audio-play-batch-board-toggle357'));
    if (opener && typeof opener.props.onClick === 'function') {
      opener.props.onClick();
      shim.renderAndCommit(comp());
      await shim.flush();
      shim.renderAndCommit(comp());
      await shim.flush();
    }
  }

  const board = lastMatch(byCls(shim, 'audio-play-batch-board357'));
  check('the batch board renders', !!board, 'board=' + !!board);
  const toggles = byCls(shim, 'audio-play-batch-board-toggle357');
  // rt.created accumulates across mounts, so a part row appears once per render pass. Dedupe by the job id the
  // row itself prints, which is the same identity a person reads on the line.
  const seenPart = {};
  const parts = byCls(shim, 'audio-play-batch-board-part357').filter(function (e) {
    const ids = deepText(e).match(/ap-\d+/g) || [];
    const k = ids.length ? ids[ids.length - 1] : deepText(e);
    if (seenPart[k]) return false;
    seenPart[k] = true;
    return true;
  });
  const states = byCls(shim, 'audio-play-batch-board-state357');

  if (state === 'empty') {
    check('an empty lane says so plainly instead of showing an empty board', states.some(function (e) { return /no batch is in this panel\u0027s list yet/.test(own(e)); }), 'state lines=' + states.length);
    check('no batch row, no batch claims', toggles.length === 0, 'toggles=' + toggles.length);
    return;
  }

  check('the batch is on one line, titled by its own batch title', toggles.some(function (e) { return own(e).indexOf('Chapter 3') === 0; }), 'toggles=' + toggles.length + ' text=' + (toggles[0] ? own(toggles[0]).slice(0, 90) : 'none'));
  check('the four declared parts are all listed (the retry row is a part too)', parts.length === 5, 'part rows=' + parts.length);

  const tg = lastMatch(toggles);
  const line = tg ? own(tg) : '';
  const hover = tg ? String(tg.props.title || '') : '';
  const colour = tg && tg.props.style ? String(tg.props.style.color || '') : '';
  const partText = parts.map(deepText).join('\n');
  const partColours = parts.map(function (e) {
    const kids = Array.isArray(e.props.children) ? e.props.children : [];
    const code = kids.filter(function (k) { return k && k.props && k.props.style && k.props.style.fontFamily === 'monospace' && /^B\d/.test(deepText(k)); });
    return code.length ? String(code[0].props.style.color || '') : '';
  });

  if (state === 'waiting') {
    check('the board says the batch is WAITING, with the count', /2 waiting for a retry/.test(line), 'line=' + line.slice(0, 120));
    check('waiting is not dressed up as stopped', line.indexOf('HALTED') < 0, 'line=' + line.slice(0, 120));
    check('the hover names the reason and says explicitly that these parts are still expected to run', /waiting, not stopped/.test(hover) && hover.indexOf('second attempt is in flight') >= 0, 'hover=' + hover.slice(-220));
    check('the second attempt is named as a second attempt, on another endpoint', /second attempts under the policy \(one retry, on another endpoint\): ap-0505/.test(hover), 'hover=' + hover.slice(-260));
    check('a waiting part carries its own waiting sentence on its own line', (partText.match(/waiting: /g) || []).length === 2, 'part text=' + partText.replace(/\n/g, ' | ').slice(0, 200));
    check('no part is claimed as stopped while the retry is in flight', partText.indexOf('stopped:') < 0, 'part text=' + partText.replace(/\n/g, ' | ').slice(0, 200));
    check('a waiting batch is not painted in the alarm red', colour !== '#f85149', 'toggle colour=' + colour);
  }

  if (state === 'halted') {
    check('the board says the batch HALTED, with how many parts the policy stopped', /HALTED, 2 parts stopped/.test(line), 'line=' + line.slice(0, 140));
    check('halted is not softened into waiting', line.indexOf('waiting for a retry') < 0, 'line=' + line.slice(0, 140));
    check('the hover carries the sentence that stopped it, in the host\u2019s own words', hover.indexOf(HALT_WHY) >= 0 && /HALTED by the failure policy/.test(hover), 'hover=' + hover.slice(-260));
    check('the hover says a halted part will not start again on its own', /will not start again on their own/.test(hover), 'hover=' + hover.slice(-200));
    check('the second attempt and the row it replaced are both named', /second attempts under the policy \(one retry, on another endpoint\): ap-0505/.test(hover) && /parts already replaced by a second attempt: ap-0502/.test(hover), 'hover=' + hover.slice(-300));
    check('each stopped part carries its own stopped sentence', (partText.match(/stopped: /g) || []).length === 2, 'part text=' + partText.replace(/\n/g, ' | ').slice(0, 240));
    check('the halted batch line is painted in the same alarm red a refused press gets', colour === '#f85149', 'toggle colour=' + colour);
    check('the stopped parts\u2019 own codes are red too', partColours.filter(function (c) { return c === '#f85149'; }).length >= 2, 'colours=' + partColours.join(','));
    check('stopped and waiting are never claimed on the same part', !partText.split('\n').some(function (l) { return /stopped:/.test(l) && /waiting:/.test(l); }), 'part lines=' + partText.replace(/\n/g, ' | ').slice(0, 240));
  }

  // The board's own promise, tested rather than asserted in a hover: it computes the batch fact from rows it
  // already holds and opens no extra request to do it.
  const batchCalls = seen.calls.filter(function (c) { return /dispatch_batch|batch_status|batch_state/i.test(c); });
  check('the board asked the lane for nothing beyond the rows it was already given', batchCalls.length === 0, 'calls=' + seen.calls.join(' | ').slice(0, 260));
  check('the board\u2019s hover still states honestly that it asks the host for nothing', /it asks the host for nothing/.test(hover) || /rows this panel already holds/.test(hover), 'hover head line=' + hover.slice(0, 200));
}

(async function main() {
  for (const state of ['waiting', 'halted', 'empty']) {
    try { await run(state); }
    catch (e) { fail++; console.log('  THROW ' + state + '  ->  ' + e.message); }
  }
  console.log('\n=== ' + pass + ' pass, ' + fail + ' fail ===');
  process.exitCode = fail ? 1 : 0;
})();
