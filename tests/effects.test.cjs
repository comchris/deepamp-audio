// Second stage: run the mount-time effects (which the render harness skips) against
// several fetch outcomes — ok, HTTP 500 non-JSON, network rejection, malformed shape —
// because an effect throw reaches the shell.overlay error boundary just like a render
// throw and abdicates the panel.
//
// Renders through the shared shim (react_shim.cjs), so this exercises the same element
// contract the browser enforces. Usage: node tests/effects.test.cjs [path/to/client.js]
const path = require('path');
const { createRuntime, loadClient } = require('./react_shim.cjs');

const TARGET = process.argv[2] || path.join(__dirname, '..', 'lib', 'client.js');

const SCENARIOS = {
  ok: function (u) {
    return Promise.resolve({
      ok: true, status: 200, json: function () {
        if (/get_endpoints/.test(u)) return Promise.resolve({ tts: { url: 'http://cpu1.test:8963', route: 'speech' }, stt: { url: 'http://cpu1.test:8962', route: 'speech' } });
        if (/server_status/.test(u)) return Promise.resolve({ tts: { ok: true, loaded_model: 'm1' }, stt: { ok: false } });
        if (/playlist_list/.test(u)) return Promise.resolve({ items: [] });
        return Promise.resolve({ ok: true });
      },
    });
  },
  http500nonjson: function () {
    return Promise.resolve({ ok: false, status: 500, json: function () { return Promise.reject(new SyntaxError('Unexpected token <')); } });
  },
  reject: function () { return Promise.reject(new TypeError('Failed to fetch')); },
  weirdshape: function (u) {
    return Promise.resolve({
      ok: true, status: 200, json: function () {
        if (/get_endpoints/.test(u)) return Promise.resolve(null);
        if (/playlist_list/.test(u)) return Promise.resolve({ items: null });
        return Promise.resolve(undefined);
      },
    });
  },
};

function makeFetch(mode) {
  return function (u) {
    const impl = SCENARIOS[mode];
    try { return impl(u); } catch (e) { return Promise.reject(e); }
  };
}

let pass = 0, fail = 0;
async function attempt(label, fn) {
  try { await fn(); pass++; console.log('  PASS  ' + label); }
  catch (e) {
    fail++;
    console.log('  THROW ' + label + '  ->  ' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n          ') : String(e)));
  }
}

// A rejected promise nobody is watching yet would kill the process on Node >= 15; the
// panel attaches handlers synchronously, so anything landing here is a real leak.
let stray = 0;
process.on('unhandledRejection', function (r) {
  stray++;
  console.log('  NOTE  unhandled rejection: ' + (r && r.stack ? r.stack.split('\n').slice(0, 3).join(' | ') : String(r)));
});

(async function main() {
  for (const mode of Object.keys(SCENARIOS)) {
    await attempt('mount + effects + re-render with fetch=' + mode, async function () {
      const shim = createRuntime();
      const client = loadClient(shim, { target: TARGET, fetch: makeFetch(mode) });
      const comp = client.apply();
      if (!comp) throw new Error('panel did not register');
      // mount: render, then commit effects
      shim.renderAndCommit(comp());
      await shim.flush();
      // React re-renders after those setStates; commit again so the dep-array effects
      // (auto-refresh, poll-then-play) run with their post-fetch values.
      shim.renderAndCommit(comp());
      await shim.flush();
      if (shim.rt.throws.length) {
        const t = shim.rt.throws[0];
        throw new Error(t.where + ': ' + (t.err && t.err.message));
      }
    });
  }
  console.log('\n=== ' + pass + ' pass, ' + fail + ' throw ===' + (stray ? ' | ' + stray + ' unhandled rejection(s)' : ''));
  process.exitCode = (fail || stray) ? 1 : 0;
})();
