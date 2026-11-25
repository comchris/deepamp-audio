// Exercises the click handlers with real state: type text into the panel, then press
// Generate/Transcribe while `busy` is still null — the regression that abdicated the
// slot once already. Renders through the shared shim, so the element contract (void
// tags, hook stores, dep-array effects) is the same one render.test.cjs enforces.
// Usage: node tests/handler.test.cjs [path/to/client.js]
const path = require('path');
const { createRuntime, loadClient } = require('./react_shim.cjs');

const TARGET = process.argv[2] || path.join(__dirname, '..', 'lib', 'client.js');

const calls = [];
function fakeFetch(url, opts) {
  calls.push(((opts && opts.method) || 'GET') + ' ' + String(url));
  return Promise.resolve({
    ok: true, status: 200,
    json: function () { return Promise.resolve({ ok: true, route_url: '/deepamp/ap-0001', transcript: 'hi' }); },
  });
}

const shim = createRuntime();
const client = loadClient(shim, { target: TARGET, fetch: fakeFetch });
const comp = client.apply();
if (!comp) throw new Error('panel did not register');

// --- mount pass --------------------------------------------------------------
let bag = {};
shim.render(comp(), bag);

const rootKey = (bag.AudioPlayerPanel && bag.AudioPlayerPanel.__key) || null;
const rootStore = rootKey ? shim.rt.stores.get(rootKey) : null;
if (!rootStore) { console.log('FAIL: AudioPlayerPanel store not found'); process.exit(1); }

// Type into every empty string state slot (ttsText, sttFile, ...).
let typed = 0;
for (let i = 0; i < rootStore.length; i++) {
  if (rootStore[i] === '') { rootStore[i] = 'some words'; typed++; }
}
console.log('file :', TARGET);
console.log('root :', rootKey, '| hook slots:', rootStore.length, '| typed into', typed, 'field(s)');

// --- re-render so the handler closures capture the typed text ----------------
bag = {};
shim.render(comp(), bag);

let fail = 0;
const pending = [];
function click(label, fnName, comp) {
  if (!bag[comp] || typeof bag[comp][fnName] !== 'function') { console.log('  SKIP  ' + label); return; }
  try {
    const r = bag[comp][fnName]();
    if (r && typeof r.then === 'function') pending.push(r.then(
      function () { console.log('  PASS  ' + label); },
      function (e) { fail++; console.log('  THROW ' + label + ' (async) -> ' + (e && e.message)); }
    ));
    else console.log('  PASS  ' + label);
  } catch (e) {
    fail++;
    console.log('  THROW ' + label + '  ->  ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n          ') : String(e)));
  }
}

(async function () {
  click('TTS Generate click (busy=null, text typed)', 'dispatchTts', 'TtsBox');
  click('STT Transcribe click (busy=null, path typed)', 'dispatchStt', 'SttBox');
  await Promise.all(pending);
  await shim.flush();

  // Rev 5 busy semantics: the queue NEVER rejects — a second Generate on a fresh
  // render MUST reach the host (it enqueues behind the first). The old "no-op"
  // guard expectation is obsolete.
  const before = calls.filter(function (c) { return /dispatch_tts/.test(c); }).length;
  bag = {};
  shim.render(comp(), bag);
  click('TTS Generate click while generating (queues another job)', 'dispatchTts', 'TtsBox');
  await Promise.all(pending);
  await shim.flush();
  const after = calls.filter(function (c) { return /dispatch_tts/.test(c); }).length;
  if (after !== before + 1) { fail++; console.log('  THROW  queue dispatch: ' + after + ' dispatch_tts calls, expected ' + (before + 1)); }
  else console.log('  PASS  re-Generate queued (' + after + ' dispatch_tts total)');

  // The text box must survive a dispatch (kept draft, user ask): the ttsText
  // state slot still holds the typed words after Generate.
  const stillTyped = rootStore.filter(function (s) { return s === 'some words'; }).length;
  if (stillTyped < 1) { fail++; console.log('  THROW  tts text was cleared after Generate'); }
  else console.log('  PASS  text kept in the box after Generate');

  console.log('  fetches issued:', calls.length);
  console.log('  ', calls.slice(0, 6).join('  |  '));
  console.log(fail ? '=== FAILING ===' : '=== handlers OK ===');
  process.exitCode = fail ? 1 : 0;
})();
