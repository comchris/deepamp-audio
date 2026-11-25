// T-231 / T-233 — per-endpoint exclusivity suite.
//
// T-231: two rows on the SAME endpoint both reached 'running' with
// activity 'loading_model'. Each engine runs with max_loaded_models=1, so one
// endpoint holds exactly one render. The live wedge rows ap-0039..ap-0060 were
// all pinned to e-3 (gpu1 TTS).
//
// T-233: "if i have one playlist entry waiting for the engine - another
// playlist entry can still retry at that time and jump to load model stage".
//
// Everything here runs against a STUBBED transport: no network, no engine, no
// real TTS. The shell seam records every curl and never executes one.
//
// Run against another copy of the host with DEEPAMP_LIB=<path> so the same
// assertions can be shown failing on a reverted lib/index.js.
const { Buffer } = require('buffer');
const path = require('path');
  // T-744 (2026-11-07): the suite reads the renamed key first and the name it had before that
  // date after it, so an environment that still exports the old name points this run at the
  // copy it was meant to point at. The plugin itself follows the same order.
const LIB = process.env.DEEPAMP_LIB || process.env.AUDIO_PLAY_LIB || path.join(__dirname, '..', 'lib', 'index.js');
// (2026-11-18 private-data sweep, TODOS.md item 38) This is not a mock path: the host loads
// its state from the default store root, which it resolves from HOME at boot, so the seed key
// has to be the same path the plugin will ask for. It is built, never written as a literal.
const STATE = path.join(require('os').homedir(), '.dsh', 'deepamp-audio', 'state.json');
const WAV231 = '/tmp/t231_input.wav';

// The live fleet: one endpoint per engine process.
const T1 = 'http://10.0.0.10:8963';   // cpu1 TTS  (the primary lane)
const T1B = 'http://10.0.0.10:8964';  // a SECOND TTS endpoint on the SAME machine
const T2 = 'http://10.0.0.20:8963';   // cpu2 TTS    (e-1)
const T3 = 'http://10.0.0.14:8963';   // gpu1 TTS   (e-3, Vulkan)
const S1 = 'http://10.0.0.10:8962';   // cpu1 STT
const S4 = 'http://10.0.0.14:8962';   // gpu1 STT   (e-4)
const H1 = '10.0.0.10';
const H3 = '10.0.0.14';

// Counted across every instance this suite builds: the host must never create one.
let allIntervals = 0;

const WIRE231 = { data: [
  { id: 'moss_ttsd', family: 'moss_ttsd', task: 'tts', mode: 'offline', path: '/mnt/llama/audio.cpp/moss.gguf', loaded: false },
  { id: 'qwen3-tts', family: 'qwen3_tts', task: 'tts', mode: 'offline', path: '/mnt/llama/audio.cpp/qwen3.gguf', loaded: false },
  { id: 'qwen3_asr', family: 'qwen3_asr', task: 'asr', mode: 'offline', path: '/mnt/llama/audio.cpp/asr.gguf', loaded: false },
  { id: 'nemotron_asr', family: 'nemotron_asr', task: 'asr', mode: 'offline', path: '/mnt/llama/audio.cpp/nemotron.gguf', loaded: false },
] };

function ep(id, fn, url, models, extra) {
  return Object.assign({
    id: id, fn: fn, url: url, route: 'speech', enabled: true, batch_allowed: true,
    held_by: '', hold_reason: '', held_at: 0,   // T-503: one state, and a hold record that is empty when nobody holds it
    models: models, models_source: 'operator', models_at: 1000, last_used_at: 0,
  }, extra || {});
}

function makeCtx(opts) {
  opts = opts || {};
  const held = [];
  const bag = {
    shellCalls: [], specs: [], fetchCalls: [], registered: [], fsMap: Object.assign({}, opts.fsSeed),
    hold: opts.hold !== false, failBody: null, connFail: false,
    timeouts: 0, intervals: 0, timerMs: [], opts: opts,
  };
  bag.release = function () { const h = held.splice(0, held.length); h.forEach(function (f) { f(); }); };
  const ctx = {
    webServer: { register(spec) { bag.registered.push(spec); return function () {}; } },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : function () {}; },
    // T-715: the host half declares its service with ctx.provide('audioPlay', ...). Capture it so a
    // suite can drive the same seam the harness wires; the real provide returns a disposer.
    provide(name715, value715) { (bag.provided || (bag.provided = {}))[name715] = value715; return function () {}; },
    timer: {
      timeout(fn, ms) { bag.timeouts += 1; bag.timerMs.push(ms); const id = setTimeout(fn, opts.fastTimers === false ? ms : 0); return function () { clearTimeout(id); }; },
      // A host polling loop would show up here. The contract is that it never does.
      interval(fn, ms) { bag.intervals += 1; allIntervals += 1; const id = setInterval(fn, opts.fastTimers === false ? ms : 1); return function () { clearInterval(id); }; },
    },
    fs: {
      resolve: async function (p) { return { targetKey: p, displayPath: p }; },
      readText: async function (t) {
        if (!(t.targetKey in bag.fsMap)) { const e = new Error('ENOENT ' + t.targetKey); e.code = 'ENOENT'; throw e; }
        return bag.fsMap[t.targetKey];
      },
      readBytes: async function (t) {
        if (!(t.targetKey in bag.fsMap)) throw new Error('ENOENT');
        return Buffer.from(bag.fsMap[t.targetKey]);
      },
      writeText: async function (t, content) {
        bag.fsMap[t.targetKey] = content;
        return { operation: 'update', version: 'v', before: null, after: content };
      },
    },
    web: {
      fetch: async function (req) {
        bag.fetchCalls.push(req.url);
        return { statusCode: 200, body: { content: '{}' } };
      },
    },
    shell: {
      resolve(spec) { return spec; },
      execute: function (spec) {
        const self = this;
        return Promise.resolve(self.run(spec)).then(function (result) {
          return { result: function () { return result; } };
        });
      },
      run: async function (spec) {
        bag.shellCalls.push(spec.command);
        bag.specs.push(spec);
        const cmd = spec.command;
        // The engine legs: parked until bag.release(), or answered with a chosen failure.
        if (/\/v1\/audio\/(speech|transcriptions)/.test(cmd) && /curl/.test(cmd)) {
          if (bag.connFail) {
            return { exitCode: 7, stdout: { text: '' }, stderr: { text: 'curl: (7) Failed to connect' }, aborted: false };
          }
          if (bag.failBody) {
            const pf = / -o '([^']+)'\.part'/.exec(cmd);
            if (pf) bag.fsMap[pf[1] + '.part'] = bag.failBody;
            return { exitCode: 22, stdout: { text: bag.failBody }, stderr: { text: 'curl: (22) The requested URL returned error: 500' }, aborted: false };
          }
          if (bag.hold) {
            return new Promise(function (res) {
              held.push(function () { res({ exitCode: 0, stdout: { text: JSON.stringify({ audio: 'AAAA' }) }, stderr: { text: '' }, aborted: false }); });
            });
          }
          const okOut = / -o '([^']+)'\.part'/.exec(cmd);
          if (okOut) bag.fsMap[okOut[1]] = 'RIFFfakewavbytes';
          return { exitCode: 0, stdout: { text: JSON.stringify({ audio: 'AAAA' }) }, stderr: { text: '' }, aborted: false };
        }
        if (opts.modelsPayload && /\/v1\/models(?![\/\w])/.test(cmd) && !/-X POST/.test(cmd)) {
          return { exitCode: 0, stdout: { text: JSON.stringify(opts.modelsPayload) }, stderr: { text: '' }, aborted: false };
        }
        if (/^ffprobe /.test(cmd)) {
          if (/sample_rate,channels/.test(cmd)) return { exitCode: 0, stdout: { text: '24000,1\n' }, stderr: { text: '' }, aborted: false };
          return { exitCode: 0, stdout: { text: '4.25\n' }, stderr: { text: '' }, aborted: false };
        }
        if (/^rm -f /.test(cmd)) return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' }, aborted: false };
        if (/^mkdir/.test(cmd)) return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' }, aborted: false };
        if (/^printf %s/.test(cmd)) return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' }, aborted: false };
        const oMatch = / -o '([^']+)'/.exec(cmd);
        if (oMatch) bag.fsMap[oMatch[1].replace(/\.part$/, '')] = 'RIFFfakewavbytes';
        // T-649 (2026-10-26): a fixture may say what this engine answers to /health. Unset, the
        // catch-all below still answers it as it always did (a bare body, no status = offline), so
        // no existing fixture changes. A fixture that wants "the engine answers now" sets bag.healthAnswer.
        if (bag.healthAnswer && /\/health/.test(cmd)) return bag.healthAnswer;
        return { exitCode: 0, stdout: { text: '{}' }, stderr: { text: '' }, aborted: false };
      },
    },
  };
  return c_fix(bag, ctx);
}
function c_fix(bag, ctx) { ctx.bag = bag; return ctx; }

function fakeReq(url, method, bodyObj) {
  const req = { url: url, method: method || 'GET', headers: {}, _l: {}, on: function (ev, cb) { (this._l[ev] = this._l[ev] || []).push(cb); } };
  setTimeout(function () {
    const text = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
    if (text) (req._l.data || []).forEach(function (cb) { cb(Buffer.from(text)); });
    (req._l.end || []).forEach(function (cb) { cb(); });
  }, 0);
  return req;
}

function call(handler, url, method, bodyObj) {
  return new Promise(function (resolve) {
    const req = fakeReq(url, method, bodyObj);
    let statusCode = 0;
    handler(req, {
      writeHead(c) { statusCode = c; },
      end(body) { resolve({ code: statusCode, body: body }); },
    });
  });
}

const tick = function (ms) { return new Promise(function (r) { setTimeout(r, ms || 20); }); };

(async function main() {
  const mod = await import('file://' + LIB);
  let pass = 0, fail = 0;
  function ok(label, cond, extra) {
    if (cond) { pass++; console.log('  PASS  ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 300) : '')); }
  }

  const mk = function (opts) {
    opts = opts || {};
    const seed = {
      version: 3,
      endpoints: { tts: { url: (opts.ttsUrl === undefined ? T1 : opts.ttsUrl), route: 'speech' }, stt: { url: (opts.sttUrl === undefined ? S1 : opts.sttUrl), route: 'speech' } },
      counter: 1, playlist: [],
    };
    seed.endpoint_registry = opts.registry || { tts: [], stt: [] };
    if (opts.primaryLastUsed) seed.primary_last_used_at = opts.primaryLastUsed;
    const ctx = makeCtx({ modelsPayload: WIRE231, fsSeed: Object.assign({ [STATE]: opts.rawSeed !== undefined ? opts.rawSeed : JSON.stringify(seed), [WAV231]: 'RIFF' }, opts.fsSeed || {}) });
    mod.apply(ctx.ctx || ctx);
    const bag = ctx.bag;
    bag.api = bag.registered.find(function (x) { return x.path === '/api/deepamp'; }).handler;
    return bag;
  };
  const J = function (res) { return JSON.parse(res.body); };
  const tts = async function (c, body) { return J(await call(c.api, '/api/deepamp/dispatch_tts', 'POST', Object.assign({ fn: 'tts', model: 'moss_ttsd' }, body))); };
  const row = async function (c, id) { return J(await call(c.api, '/api/deepamp/job_status?job_id=' + id, 'GET')); };
  const rows = async function (c) { return J(await call(c.api, '/api/deepamp/playlist_list?page_size=50', 'GET')).items; };
  const q = async function (c) { return J(await call(c.api, '/api/deepamp/queue_status', 'GET')); };
  const retry = async function (c, id) { return J(await call(c.api, '/api/deepamp/retry_job', 'POST', { job_id: id })); };
  const speechUrls = function (c, lane) {
    const l = lane || 'speech';
    const re = new RegExp("'(http:[^']+)/v1/audio/" + l);
    return c.shellCalls.filter(function (x) { return x.indexOf('/v1/audio/' + l) >= 0; })
      .map(function (x) { const m = re.exec(x); return m ? m[1] : ''; });
  };
  const countUrl = function (list, url) { return list.filter(function (x) { return x === url; }).length; };
  const autoPauseLogged = function (c) { return c.shellCalls.some(function (x) { return /"ev":"auto_pause"/.test(x); }); };

  // ==========================================================================
  // T-231 (a) — THE FAULT: two rows pinned to ONE endpoint.
  // Live evidence: ap-0039..ap-0060 all pinned to e-3 (gpu1 TTS), both rows
  // showing "loading model" at the same time on an engine with max_loaded_models=1.
  // ==========================================================================
  console.log('\n--- T-231 (a): two rows pinned to the SAME endpoint (the live fault) ---');
  {
    const c = mk({ registry: { tts: [ep('e-1', 'tts', T2, ['moss_ttsd', 'qwen3-tts']), ep('e-3', 'tts', T3, ['moss_ttsd', 'qwen3-tts'])], stt: [] } });
    await tick(40);
    const a = await tts(c, { text: 'first row pinned to the vulkan lane', endpoint_id: 'e-3' });
    await tick(60);
    const b = await tts(c, { text: 'second row pinned to the SAME vulkan endpoint', endpoint_id: 'e-3' });
    await tick(60);
    const urls = speechUrls(c);
    const aRow = await row(c, a.job_id);
    const bRow = await row(c, b.job_id);
    const cq = await q(c);

    ok('T-231 (a): the first pinned row runs on e-3 and is the only render that endpoint has received',
      a.ok === true && a.status === 'running' && a.endpoint_id === 'e-3' && !!aRow.activity
      && countUrl(urls, T3) === 1, { urls: urls, a: a.status, act: aRow.activity });
    ok('T-231 (a): the SECOND row pinned to that endpoint never starts — it stays queued, it is not an error and not a refusal',
      b.ok === true && b.status === 'queued' && !b.error && bRow.status === 'queued' && !bRow.error,
      { dispatch: { st: b.status, err: b.error }, row: { st: bRow.status, err: bRow.error } });
    ok('T-231 (a): the endpoint really held exactly one render (one speech curl to e-3, not two)',
      countUrl(urls, T3) === 1 && urls.length === 1, urls);
    ok('T-231 (a): the parked row carries a NAMED reason naming the endpoint and the row that holds it (endpoint_slot_wait)',
      !!bRow.endpoint_slot_wait && bRow.endpoint_slot_wait.id === 'e-3' && bRow.endpoint_slot_wait.job_id === a.job_id,
      { keys: Object.keys(bRow), endpoint_slot_wait: bRow.endpoint_slot_wait });
    ok('T-231 (a): the parked row keeps its pin (a pin is evaluated alone and never falls back to a free endpoint)',
      bRow.endpoint_id === 'e-3' && bRow.endpoint_url === T3 && bRow.endpoint_pending !== true, bRow.endpoint_id);
    ok('T-231 (a): nothing leaked onto the two FREE endpoints while the pinned row waited',
      countUrl(urls, T2) === 0 && countUrl(urls, T1) === 0, urls);
    ok('T-231 (a): a wait is not a failure — the lane is not paused, nothing auto-paused, no wedge evidence was produced',
      cq.queues.tts.paused === false && cq.queues.tts.auto_paused === '' && !autoPauseLogged(c),
      { paused: cq.queues.tts.paused, auto: cq.queues.tts.auto_paused });
    ok('T-231 (a): the wait is not a machine_wait either — the row waits for ITS endpoint, not for the machine cap',
      !bRow.machine_wait, { machine_wait: bRow.machine_wait });
    ok('T-231 (a): queue_status names which endpoint holds which running row (additive per-endpoint occupancy)',
      Array.isArray(cq.queues.tts.endpoints)
      && cq.queues.tts.endpoints.some(function (e) { return e.id === 'e-3' && e.running_job_id === a.job_id; })
      && cq.queues.tts.endpoints.filter(function (e) { return !e.running_job_id; }).length === 2,
      cq.queues.tts.endpoints);
    ok('T-231 (a): the existing queue_status keys survive untouched (slots {max,used}, host_cap, host_cap_source, machines, running_ids)',
      cq.queues.tts.slots.max === 3 && cq.queues.tts.slots.used === 1
      && cq.queues.tts.host_cap === 2 && cq.queues.tts.host_cap_source === 'default'
      && JSON.stringify(cq.queues.tts.running_ids) === JSON.stringify([a.job_id])
      && cq.queues.tts.running === a.job_id && cq.queues.tts.queued === 1
      && !!cq.machines[H3] && cq.machines[H3].running === a.job_id, cq.queues.tts);

    // Drain on completion: the freed endpoint admits the parked row through the
    // existing completion-driven pump(), with no new timer.
    c.release();
    await tick(250);
    const bAfter = await row(c, b.job_id);
    const urls2 = speechUrls(c);
    ok('T-231 (a): the freed endpoint admits the parked row through the completion-driven pump (no new timer, no poller)',
      (bAfter.status === 'running' || bAfter.status === 'ok') && bAfter.endpoint_id === 'e-3'
      && countUrl(urls2, T3) === 2 && !('endpoint_slot_wait' in bAfter), { st: bAfter.status, urls: urls2 });
    ok('T-231 (a): the parked row was never lost — both pinned rows rendered on e-3, one after the other, with zero host intervals',
      (await rows(c)).filter(function (r) { return r.endpoint_id === 'e-3'; }).length === 2 && c.intervals === 0, { intervals: c.intervals });
    c.release();
    await tick(150);
  }

  // ==========================================================================
  // T-231 (b) — the PRIMARY lane is its own endpoint.
  // ==========================================================================
  console.log('\n--- T-231 (b): the primary lane is its own endpoint ---');
  {
    const c = mk({ registry: { tts: [ep('e-1', 'tts', T2, ['moss_ttsd', 'qwen3-tts'])], stt: [] } });
    await tick(40);
    const a = await tts(c, { text: 'first row on the primary lane', endpoint_id: 'primary' });
    await tick(60);
    const b = await tts(c, { text: 'second row also pinned to the primary lane', endpoint_id: 'primary' });
    await tick(60);
    const urls = speechUrls(c);
    const bRow = await row(c, b.job_id);
    ok('T-231 (b): two rows pinned to "primary" do not both render on the primary engine',
      a.status === 'running' && b.status === 'queued' && countUrl(urls, T1) === 1, { urls: urls, a: a.status, b: b.status });
    ok('T-231 (b): the second primary-lane row parks with endpoint_slot_wait naming the primary lane',
      !!bRow.endpoint_slot_wait && bRow.endpoint_slot_wait.id === 'primary' && bRow.endpoint_slot_wait.job_id === a.job_id,
      bRow.endpoint_slot_wait);
    c.release();
    await tick(250);
    const bAfter = await row(c, b.job_id);
    ok('T-231 (b): and it is admitted onto the primary lane when that lane frees',
      (bAfter.status === 'running' || bAfter.status === 'ok') && bAfter.endpoint_id === 'primary'
      && countUrl(speechUrls(c), T1) === 2, { st: bAfter.status, urls: speechUrls(c) });
    c.release();
    await tick(150);
  }

  // ==========================================================================
  // T-231 (c) — a RETRIED row obeys the same exclusivity, WITHOUT changing
  // which endpoint it targets (T-221 parked: the pin stays exactly as it is).
  // ==========================================================================
  console.log('\n--- T-231 (c): a retried row re-pins to its endpoint and waits for it ---');
  {
    const c = mk({ registry: { tts: [ep('e-1', 'tts', T2, ['moss_ttsd', 'qwen3-tts']), ep('e-3', 'tts', T3, ['moss_ttsd', 'qwen3-tts'])], stt: [] } });
    await tick(40);
    // A row that FAILED on e-3 (the engine answered 500) — the retry candidate.
    c.hold = false;
    c.failBody = JSON.stringify({ error: { message: 'HTTP 500 vk::Queue::submit: ErrorDeviceLost' } });
    const f = await tts(c, { text: 'the row that failed on the vulkan lane', endpoint_id: 'e-3' });
    await tick(150);
    c.failBody = null;
    c.hold = true;
    const fRow = await row(c, f.job_id);
    // Now e-3 is busy with a live render.
    const a = await tts(c, { text: 'a live render on the vulkan lane', endpoint_id: 'e-3' });
    await tick(60);
    const before = speechUrls(c).length;
    const r = await retry(c, f.job_id);
    await tick(80);
    const rRow = await row(c, r.job_id);
    const urls = speechUrls(c);
    ok('T-231 (c): the failed row really failed on e-3 and the live row is running there',
      fRow.status === 'error' && fRow.endpoint_id === 'e-3' && a.status === 'running' && a.endpoint_id === 'e-3',
      { f: fRow.status, a: a.status });
    ok('T-231 (c): the retried row keeps the endpoint it ran on (T-221 parked: the pin is unchanged)',
      r.ok === true && rRow.endpoint_id === 'e-3' && rRow.endpoint_url === T3, { ep: rRow.endpoint_id, url: rRow.endpoint_url });
    ok('T-231 (c): the retried row does NOT start while its endpoint is occupied — no third render reached e-3',
      rRow.status === 'queued' && countUrl(urls, T3) === 2 && urls.length === before, { urls: urls, st: rRow.status });
    ok('T-231 (c): the retried row parks with the same named reason as any other row (endpoint_slot_wait naming the live row)',
      !!rRow.endpoint_slot_wait && rRow.endpoint_slot_wait.id === 'e-3' && rRow.endpoint_slot_wait.job_id === a.job_id,
      rRow.endpoint_slot_wait);
    c.release();
    await tick(250);
    const rAfter = await row(c, r.job_id);
    ok('T-231 (c): when the live row finishes, the retried row is admitted onto ITS endpoint',
      (rAfter.status === 'running' || rAfter.status === 'ok') && rAfter.endpoint_id === 'e-3'
      && countUrl(speechUrls(c), T3) === 3, { st: rAfter.status, urls: speechUrls(c) });
    c.release();
    await tick(150);
  }

  // ==========================================================================
  // T-231 (d) — the per-HOST cap keeps its meaning: two jobs on one machine
  // are allowed when they are on two DIFFERENT endpoints of that machine.
  // ==========================================================================
  console.log('\n--- T-231 (d): the per-host cap still means two jobs on two DIFFERENT endpoints ---');
  {
    const c = mk({ registry: { tts: [ep('e-2', 'tts', T1B, ['moss_ttsd', 'qwen3-tts'])], stt: [] } });
    await tick(40);
    const a = await tts(c, { text: 'first job on the box' });
    await tick(60);
    const b = await tts(c, { text: 'second job on the same box, other endpoint' });
    await tick(60);
    const c3 = await tts(c, { text: 'third job: the box is at the cap' });
    await tick(60);
    const cq = await q(c);
    const urls = speechUrls(c);
    ok('T-231 (d): two rows on two DIFFERENT endpoints of ONE machine still run at the same time (the cap is unchanged)',
      a.status === 'running' && b.status === 'running' && a.endpoint_id !== b.endpoint_id
      && countUrl(urls, T1) === 1 && countUrl(urls, T1B) === 1, { a: a.endpoint_id, b: b.endpoint_id, urls: urls });
    ok('T-231 (d): the THIRD row on that machine still waits with machine_wait (the existing reason, not a refusal)',
      c3.ok === true && c3.status === 'queued' && !!c3.machine_wait && c3.machine_wait.host === H1, c3);
    ok('T-231 (d): slots.max is still the endpoint count and slots.used still counts running rows',
      cq.queues.tts.slots.max === 2 && cq.queues.tts.slots.used === 2 && cq.queues.tts.host_cap === 2, cq.queues.tts.slots);
    ok('T-231 (d): the occupancy view says the machine is full one endpoint at a time, not one job at a time',
      Array.isArray(cq.queues.tts.endpoints) && cq.queues.tts.endpoints.length === 2
      && cq.queues.tts.endpoints.every(function (e) { return !!e.running_job_id; }), cq.queues.tts.endpoints);
    c.release();
    await tick(250);
  }

  // ==========================================================================
  // T-231 (e) — a parked row never feeds a failure / wedge counter.
  // ==========================================================================
  console.log('\n--- T-231 (e): a parked row is not evidence of anything ---');
  {
    const c = mk({ registry: { tts: [ep('e-3', 'tts', T3, ['moss_ttsd', 'qwen3-tts'])], stt: [] } });
    await tick(40);
    await tts(c, { text: 'holding the vulkan lane', endpoint_id: 'e-3' });
    await tick(60);
    for (let i = 0; i < 4; i++) { await tts(c, { text: 'queued behind it ' + i, endpoint_id: 'e-3' }); await tick(30); }
    await tick(60);
    const cq = await q(c);
    const rs = await rows(c);
    ok('T-231 (e): four rows parked behind one occupied endpoint: all queued, none errored, none auto-paused',
      cq.queues.tts.queued === 4 && cq.queues.tts.slots.used === 1 && cq.queues.tts.paused === false
      && cq.queues.tts.auto_paused === '' && rs.filter(function (r) { return r.status === 'error'; }).length === 0,
      { queued: cq.queues.tts.queued, used: cq.queues.tts.slots.used, paused: cq.queues.tts.paused });
    ok('T-231 (e): no auto_pause and no refusal was ever logged for a wait',
      !autoPauseLogged(c) && !c.shellCalls.some(function (x) { return /"ev":"endpoint_refuse"/.test(x); }),
      c.shellCalls.filter(function (x) { return /auto_pause|endpoint_refuse/.test(x); }).slice(0, 2));
    const parked = rs.filter(function (r) { return r.status === 'queued'; });
    const named = parked.filter(function (r) { return !!r.endpoint_slot_wait; });
    // T-623 RE-POINT (2026-10-23). This pin used to name ap-0001..ap-0005 literally. The counter floor built for
    // item 19 e (lib/index.js:2392-2409, operator ruling "Persist the counter separately") now HONOURS the counter
    // this fixture seeds (counter: 1), so the ids this store hands out start at ap-0002 - the fix working, not a
    // fault. The claim was never about those five numbers, it is about WHO EACH PARKED ROW NAMES, so the ids are
    // read off the rows: the head parked row names the running holder, the rows behind it name the head row.
    const running255 = rs.filter(function (r) { return r.status === 'running'; })[0];
    const parkedSorted255 = parked.slice().sort(function (a, b) { return a.id < b.id ? -1 : 1; });
    ok('T-231 (e): every parked row on that endpoint names the endpoint AND the row AHEAD of it on it — the head row names the RUNNING holder, the three behind it name the head row:',
      named.length === 4 && named.every(function (r) { return r.endpoint_slot_wait.id === 'e-3' && r.endpoint_slot_wait.url === T3; })
      && !!running255 && parkedSorted255.length === 4
      && parkedSorted255[0].endpoint_slot_wait.job_id === running255.id
      && parkedSorted255.slice(1).every(function (r) { return r.endpoint_slot_wait.job_id === parkedSorted255[0].id; }),
      parked.map(function (r) { return { st: r.status, id: r.id, w: r.endpoint_slot_wait }; }));
    ok('T-231 (e): every queued row still names the endpoint it is placed on, so the panel can pair row -> endpoint from queues[fn].endpoints',
      parked.every(function (r) { return r.endpoint_id === 'e-3'; }),
      parked.map(function (r) { return { st: r.status, ep: r.endpoint_id }; }));
    ok('T-231 (e): parking does not arm a machine watchdog for that row (no machine_wait key, and no 15 s watchdog timer was ever requested)',
      rs.filter(function (r) { return r.status === 'queued'; }).every(function (r) { return !r.machine_wait; })
      && c.timerMs.indexOf(15000) < 0,
      { waits: rs.map(function (r) { return r.machine_wait; }), timers: c.timerMs });
    c.release();
    await tick(300);
    const cq2 = await q(c);
    ok('T-231 (e): the completion-driven drain admits the next row onto the freed endpoint, one at a time',
      cq2.queues.tts.slots.used === 1 && cq2.queues.tts.queued === 3,
      { used: cq2.queues.tts.slots.used, queued: cq2.queues.tts.queued });
    c.release();
    await tick(300);
    c.release();
    await tick(300);
    c.release();
    await tick(300);
    const done = (await rows(c)).filter(function (r) { return r.status === 'ok' || r.status === 'running'; }).length;
    ok('T-231 (e): all five rows eventually rendered, one per endpoint slot, in dispatch order',
      done === 5 && countUrl(speechUrls(c), T3) === 5, { done: done, urls: speechUrls(c) });
  }

  // ==========================================================================
  // T-233 (a) — ATTEMPT TO REPRODUCE a same-lane jump by retry.
  // An older row parked on a paused endpoint, then a retry of a failed row.
  // ==========================================================================
  console.log('\n--- T-233 (a): can a retry jump an older queued row in the same lane? ---');
  {
    const c = mk({ registry: { tts: [ep('e-1', 'tts', T2, ['moss_ttsd', 'qwen3-tts'], { enabled: false, held_by: 'plugin', hold_reason: 'the plugin held this endpoint after its own failed reads' })], stt: [] } });
    await tick(40);
    // First a row that RUNS and FAILS on the free primary (the retry candidate).
    c.hold = false;
    c.failBody = JSON.stringify({ error: { message: 'HTTP 500 boom' } });
    const f = await tts(c, { text: 'the row that will be retried' });
    await tick(150);
    c.failBody = null;
    c.hold = true;
    const fRow0 = await row(c, f.job_id);
    // Then a row that parks on the endpoint the plugin holds (T-503: a plugin hold parks, an operator hold refuses).
    const a = await tts(c, { text: 'waiting on an endpoint the plugin holds', endpoint_id: 'e-1' });
    await tick(60);
    const r = await retry(c, f.job_id);
    await tick(80);
    const aRow = await row(c, a.job_id);
    const rRow = await row(c, r.job_id);
    ok('T-233 (a): the retry candidate really ran and failed on the free primary — its render is the FIRST curl to the primary (T-255 contract change: the primary now carries a second curl in this scenario because the retried row is served there, see the next assertion)',
      fRow0.status === 'error' && fRow0.endpoint_id === 'primary' && speechUrls(c)[0] === T1 && countUrl(speechUrls(c), T1) === 2,
      { st: fRow0.status, ep: fRow0.endpoint_id, urls: speechUrls(c) });
    ok('T-233 (a) + T-503: the older row is really parked (endpoint_wait naming the endpoint the plugin holds - a plugin hold is the soft bar that parks a pinned row)',
      a.status === 'queued' && !!aRow.endpoint_wait && aRow.endpoint_wait.id === 'e-1', aRow.endpoint_wait);
    ok('T-233 (a): NO same-lane jump — the retried row never takes the endpoint the older row is parked on (e-1 stays untouched, the older row keeps its endpoint_wait there); it is served on a DIFFERENT endpoint (T-255 contract change: a row parked on a paused endpoint no longer blocks a row that targets another endpoint)',
      r.ok === true && rRow.status === 'running' && rRow.endpoint_id === 'primary'
      && countUrl(speechUrls(c), T2) === 0 && aRow.endpoint_wait.id === 'e-1' && aRow.status === 'queued',
      { retried: rRow.status, ep: rRow.endpoint_id, retry: r, urls: speechUrls(c) });
    c.release();
    await tick(250);
  }

  // ==========================================================================
  // T-233 (b) — THE REPRODUCIBLE VARIANT. The double-booked endpoint fills the
  // per-host cap, so the row that is waiting for the engine parks behind a
  // machine that is only busy because ONE endpoint was double-booked — and the
  // retried row, having no older row of its own lane queued, goes straight to
  // 'loading model'. That is exactly the user's observation.
  // ==========================================================================
  console.log('\n--- T-233 (b): a double-booked endpoint starves the row waiting on the engine ---');
  {
    const c = mk({ registry: { tts: [ep('e-1', 'tts', T2, ['moss_ttsd', 'qwen3-tts']), ep('e-3', 'tts', T3, ['moss_ttsd', 'qwen3-tts'])], stt: [ep('e-4', 'stt', S4, ['nemotron_asr', 'qwen3_asr'])] } });
    await tick(40);
    // First a row that RUNS and FAILS on the free cpu1 lane (the retry candidate).
    c.hold = false;
    c.failBody = JSON.stringify({ error: { message: 'HTTP 500 transient' } });
    const f = await tts(c, { text: 'a failed row on the cpu1 lane' });
    await tick(150);
    c.failBody = null;
    c.hold = true;
    const fRow0 = await row(c, f.job_id);
    // Then the vulkan lane gets one live render, then a SECOND row on the SAME endpoint.
    const a = await tts(c, { text: 'tts row one on the vulkan lane', endpoint_id: 'e-3' });
    await tick(60);
    const b = await tts(c, { text: 'tts row two, same vulkan endpoint', endpoint_id: 'e-3' });
    await tick(60);
    const sttPending = call(c.api, '/api/deepamp/dispatch_stt', 'POST', { fn: 'stt', model: 'nemotron_asr', file_path: WAV231, endpoint_id: 'e-4' });
    await tick(150);
    const allRows1 = await rows(c);
    const sttRow1 = allRows1.find(function (x) { return x.fn === 'stt'; });
    const r = await retry(c, f.job_id);
    await tick(150);
    const rRow = await row(c, r.job_id);
    const sttRow = await row(c, sttRow1.id);
    const cq2 = await q(c);
    const gpu1m = cq2.machines[H3] || {};
    ok('T-233 (b): the retry candidate really ran and failed on the cpu1 lane',
      fRow0.status === 'error' && fRow0.endpoint_id === 'primary', { st: fRow0.status, ep: fRow0.endpoint_id });
    ok('T-233 (b): the row waiting for the engine is NOT starved by a double-booked endpoint — the STT row placed on e-4 runs',
      sttRow.status === 'running' && sttRow.endpoint_id === 'e-4' && !sttRow.machine_wait,
      { st: sttRow.status, ep: sttRow.endpoint_id, mw: sttRow.machine_wait });
    ok('T-233 (b): the second TTS row waits for ITS endpoint (endpoint_slot_wait), not for a machine cap it never filled',
      b.status === 'queued' && !b.machine_wait && !!(await row(c, b.job_id)).endpoint_slot_wait,
      { st: b.status, mw: b.machine_wait, w: (await row(c, b.job_id)).endpoint_slot_wait });
    ok('T-233 (b): the retried row is served, but NEVER on the endpoint a queued row is parked on — it runs on another lane, e-3 still holds exactly one render, and the e-3 row keeps its endpoint_slot_wait naming the running holder (T-255 contract change: the retried row no longer waits behind a row parked on a DIFFERENT endpoint)',
      rRow.status === 'running' && rRow.endpoint_id !== 'e-3'
      && countUrl(speechUrls(c), T3) === 1 && (await row(c, b.job_id)).endpoint_slot_wait.job_id === a.job_id,
      { r: rRow.status, ep: rRow.endpoint_id, act: rRow.activity, urls: speechUrls(c) });
    ok('T-233 (b): the vulkan machine holds at most one job per endpoint (its two endpoints hold one job each)',
      (gpu1m.jobs || []).filter(function (j) { return j.endpoint_id === 'e-3'; }).length === 1
      && (gpu1m.jobs || []).filter(function (j) { return j.endpoint_id === 'e-4'; }).length <= 1, gpu1m);
    ok('T-233 (b): the retried row is not lost — it renders once the lane drains',
      !!r.job_id && r.ok === true, r);
    void sttPending;
    c.release();
    await tick(350);
    c.release();
    await tick(350);
    c.release();
    await tick(350);
    c.release();
    await tick(350);
    c.release();
    await tick(350);
    const finalRows = await rows(c);
    ok('T-233 (b): everything queued eventually rendered — the fix parks rows, it never drops them',
      finalRows.filter(function (x) { return x.status === 'queued'; }).length === 0,
      finalRows.map(function (x) { return { id: x.id, fn: x.fn, st: x.status, ep: x.endpoint_id }; }));
  }

  // ==========================================================================
  // T-233 (c) — the SAME-LANE half of FIFO, kept by T-255: a newer row never
  // takes a slot on the endpoint an older row of this queue is parked on.
  // (T-255 changed the other half: the pump no longer stops at the parked row,
  // so a newer row that targets a DIFFERENT free endpoint is served. The two
  // assertions below carry that contract change; the lane order is asserted by
  // the T-255 (a) / (a2) blocks further down and by T-231 (e) above.)
  // ==========================================================================
  console.log('\n--- T-233 (c): strict FIFO — a newer row does not get a slot past a parked older row ---');
  {
    const c = mk({ registry: { tts: [ep('e-1', 'tts', T2, ['moss_ttsd', 'qwen3-tts']), ep('e-3', 'tts', T3, ['moss_ttsd', 'qwen3-tts'])], stt: [] } });
    await tick(40);
    const a = await tts(c, { text: 'holding e-3', endpoint_id: 'e-3' });
    await tick(60);
    const b = await tts(c, { text: 'older row, also pinned to e-3', endpoint_id: 'e-3' });
    await tick(60);
    const cRow = await tts(c, { text: 'newer UNPINNED row: two endpoints are free, does it jump the queue?' });
    await tick(80);
    const urls = speechUrls(c);
    const cRow2 = await row(c, cRow.job_id);
    const bRow2 = await row(c, b.job_id);
    ok('T-233 (c): the newer unpinned row IS served while the older parked row waits — but only on a FREE endpoint: e-3 still has exactly one render and nothing leaked onto e-1 (T-255 contract change: the pump walks past a parked row instead of stopping at it; the row did not jump the lane the older row is parked on)',
      cRow2.status === 'running' && cRow2.endpoint_id !== 'e-3'
      && countUrl(urls, T3) === 1 && countUrl(urls, T2) === 0, { st: cRow2.status, ep: cRow2.endpoint_id, urls: urls });
    ok('T-233 (c): the older row is parked with the named endpoint reason, and it keeps its pin',
      bRow2.status === 'queued' && !!bRow2.endpoint_slot_wait && bRow2.endpoint_id === 'e-3', { st: bRow2.status, w: bRow2.endpoint_slot_wait });
    ok('T-233 (c): the row that holds the endpoint is still the only render on it',
      countUrl(urls, T3) === 1 && a.status === 'running', urls);
    c.release();
    await tick(350);
    const bAfter = await row(c, b.job_id);
    const urls2 = speechUrls(c);
    ok('T-233 (c): when e-3 frees, the OLDER parked row is the row that gets it — e-3 has exactly two renders and the LAST render issued in this scenario is that older row on e-3 (T-255 contract change: whole-queue curl order is no longer row order; the per-endpoint order is what strict FIFO means here — the newer row was served earlier, on a different endpoint, and never touched e-3)',
      (bAfter.status === 'running' || bAfter.status === 'ok') && bAfter.endpoint_id === 'e-3'
      && urls2.length === 3 && countUrl(urls2, T3) === 2 && urls2[urls2.length - 1] === T3, { b: bAfter.status, urls: urls2 });
    const cAfter1 = await row(c, cRow.job_id);
    ok('T-233 (c): the newer row is served on a free endpoint, not lost — the per-endpoint order is what is preserved (T-255 contract change to the label: it is no longer served AFTER the older row, it is served on a DIFFERENT endpoint; the check itself is unchanged)',
      (cAfter1.status === 'running' || cAfter1.status === 'ok') && (cAfter1.endpoint_id === 'e-1' || cAfter1.endpoint_id === 'primary'),
      { st: cAfter1.status, ep: cAfter1.endpoint_id });
    c.release();
    await tick(350);
    c.release();
    await tick(250);
  }

  // ==========================================================================
  // T-231 (f) — the live report said the user RESUMED two rows that both point
  // at the same node and endpoint. Restored rows carry a placement and no
  // candidate object, so they are exactly the rows that used to bypass the gate.
  // ==========================================================================
  console.log('\n--- T-231 (f): two RESUMED rows pinned to one endpoint (the live report) ---');
  {
    const seedC = mk({ registry: { tts: [ep('e-1', 'tts', T2, ['moss_ttsd', 'qwen3-tts']), ep('e-3', 'tts', T3, ['moss_ttsd', 'qwen3-tts'])], stt: [] } });
    await tick(40);
    await call(seedC.api, '/api/deepamp/pause_fn', 'POST', { fn: 'tts' });
    await tick(30);
    const r1 = await tts(seedC, { text: 'restored row one pinned to e-3', endpoint_id: 'e-3' });
    await tick(30);
    const r2 = await tts(seedC, { text: 'restored row two pinned to the same e-3', endpoint_id: 'e-3' });
    await tick(60);
    const saved = seedC.fsMap[STATE];
    const c = mk({ rawSeed: saved });
    await tick(60);
    const row1Before = await row(c, r1.job_id);
    const row2Before = await row(c, r2.job_id);
    const resumed = await call(c.api, '/api/deepamp/resume_fn', 'POST', { fn: 'tts' });
    await tick(120);
    const urls = speechUrls(c);
    const row1 = await row(c, r1.job_id);
    const row2 = await row(c, r2.job_id);
    ok('T-231 (f): both rows restored QUEUED with their e-3 placement (the resume is the live scenario)',
      row1Before.status === 'queued' && row2Before.status === 'queued'
      && row1Before.endpoint_id === 'e-3' && row2Before.endpoint_id === 'e-3',
      { r1: row1Before.status, r2: row2Before.status });
    ok('T-231 (f): after resume_fn only ONE restored row starts on e-3 — the second stays queued',
      J(resumed).ok === true && row1.status === 'running' && row2.status === 'queued' && countUrl(urls, T3) === 1,
      { r1: row1.status, r2: row2.status, urls: urls });
    ok('T-231 (f): the second restored row parks with endpoint_slot_wait naming the first one',
      !!row2.endpoint_slot_wait && row2.endpoint_slot_wait.id === 'e-3' && row2.endpoint_slot_wait.job_id === r1.job_id,
      row2.endpoint_slot_wait);
    ok('T-231 (f): the resumed pair never leaked onto the free endpoint e-1',
      countUrl(urls, T2) === 0, urls);
    c.release();
    await tick(300);
    const row2After = await row(c, r2.job_id);
    ok('T-231 (f): the second restored row is admitted onto e-3 when the first finishes',
      (row2After.status === 'running' || row2After.status === 'ok') && row2After.endpoint_id === 'e-3'
      && countUrl(speechUrls(c), T3) === 2, { st: row2After.status, urls: speechUrls(c) });
    c.release();
    await tick(200);
  }

  // ==========================================================================
  // T-231 (g) — the drain also happens when the holding row is CANCELLED: the
  // completion path pumps, no timer is involved.
  // ==========================================================================
  console.log('\n--- T-231 (g): a cancelled holder frees the endpoint through the same pump ---');
  {
    const c = mk({ registry: { tts: [ep('e-3', 'tts', T3, ['moss_ttsd', 'qwen3-tts'])], stt: [] } });
    await tick(40);
    const a = await tts(c, { text: 'holder to be cancelled', endpoint_id: 'e-3' });
    await tick(60);
    const b = await tts(c, { text: 'waiting behind it on the same endpoint', endpoint_id: 'e-3' });
    await tick(60);
    const bRow0 = await row(c, b.job_id);
    ok('T-231 (g): the second row is parked behind the holder',
      bRow0.status === 'queued' && !!bRow0.endpoint_slot_wait && bRow0.endpoint_slot_wait.job_id === a.job_id, bRow0.endpoint_slot_wait);
    const cancelled = J(await call(c.api, '/api/deepamp/cancel_job', 'POST', { job_id: a.job_id }));
    c.release();          // the killed engine leg settles, which is what the real abort does
    await tick(300);
    const bAfter = await row(c, b.job_id);
    ok('T-231 (g): cancelling the holder admits the waiting row onto the freed endpoint (completion-driven, no timer)',
      cancelled.ok === true && (bAfter.status === 'running' || bAfter.status === 'ok')
      && bAfter.endpoint_id === 'e-3' && countUrl(speechUrls(c), T3) === 2,
      { cancel: cancelled.ok, st: bAfter.status, urls: speechUrls(c) });
    c.release();
    await tick(200);
  }

  // ==========================================================================
  // T-255 (a) — THE MEASURED FAULT. queue_status today: queued 14, running 1,
  // slots {max:3, used:1} — gpu1 queued 9, cpu1 queued 1, two of three
  // engines idle while 14 rows waited. Cause: pump() took the OLDEST queued row
  // and RETURNED at the first obstacle, so nine parts pinned to a busy CPU
  // endpoint parked nine rows pinned to an idle GPU endpoint.
  // The fix: walk the queue oldest-first, park the rows that cannot run, and
  // keep walking — with a per-endpoint FIFO guard so no row overtakes a row
  // waiting on its own endpoint.
  // ==========================================================================
  const M255 = ['moss_ttsd', 'qwen3-tts'];
  console.log('\n--- T-255 (a): the pump walks past a parked row to an endpoint that has nothing to do ---');
  {
    const c = mk({ registry: { tts: [ep('e-1', 'tts', T2, M255), ep('e-3', 'tts', T3, M255)], stt: [] } });
    await tick(40);
    const a = await tts(c, { text: 'holder on the vulkan lane', endpoint_id: 'e-3' });
    await tick(60);
    const b = await tts(c, { text: 'older row pinned to the busy e-3', endpoint_id: 'e-3' });
    await tick(60);
    const d = await tts(c, { text: 'newer row pinned to the SAME busy e-3', endpoint_id: 'e-3' });
    await tick(60);
    const eR = await tts(c, { text: 'row pinned to the IDLE cpu2 lane', endpoint_id: 'e-1' });
    await tick(120);
    const urls = speechUrls(c);
    const aRow = await row(c, a.job_id);
    const bRow = await row(c, b.job_id);
    const dRow = await row(c, d.job_id);
    const eRow = await row(c, eR.job_id);
    const cq = await q(c);
    ok('T-255 (a): the row that COULD run on the idle endpoint runs — pre-edit the pump stopped at the parked row on e-3 and cpu2 never received a render',
      eRow.status === 'running' && eRow.endpoint_id === 'e-1' && countUrl(urls, T2) === 1
      && aRow.status === 'running' && bRow.status === 'queued',
      { e: eRow.status, ep: eRow.endpoint_id, b: bRow.status, urls: urls });
    ok('T-255 (a): queue_status now reports two of this queue\'s three endpoints working with rows still parked (the live shape was queued 14 / running 1 / slots {max:3, used:1}) — and a skip is still a wait, not a failure',
      cq.queues.tts.slots.max === 3 && cq.queues.tts.slots.used === 2 && cq.queues.tts.queued === 2
      && cq.queues.tts.paused === false && cq.queues.tts.auto_paused === '' && !autoPauseLogged(c),
      cq.queues.tts);
    ok('T-255 (a): PER-ENDPOINT FIFO — the newer row pinned to the SAME lane as the parked row is NOT served: it stays queued and names the OLDER row ahead of it on that endpoint, while the head row still names the running holder',
      dRow.status === 'queued' && !!dRow.endpoint_slot_wait && dRow.endpoint_slot_wait.id === 'e-3'
      && dRow.endpoint_slot_wait.job_id === b.job_id && dRow.endpoint_id === 'e-3' && !dRow.batch_order_wait
      && !!bRow.endpoint_slot_wait && bRow.endpoint_slot_wait.job_id === a.job_id && countUrl(urls, T3) === 1,
      { d: dRow.endpoint_slot_wait, b: bRow.endpoint_slot_wait, urls: urls });
    c.release();
    await tick(300);
    c.release();
    await tick(300);
  }

  // ==========================================================================
  // T-255 (a2) — the FIFO guard also holds when the older row is parked behind
  // an endpoint the plugin HOLDS (T-503: the plugin's own hold parks rows; a hold a person put by hand refuses):
  // reason, and only rows on OTHER endpoints are served.
  // ==========================================================================
  console.log('\n--- T-255 (a2) + T-503: an endpoint the plugin holds keeps its own rows queued while other endpoints are served ---');
  {
    const c = mk({ registry: { tts: [ep('e-1', 'tts', T2, M255, { enabled: false, held_by: 'plugin', hold_reason: 'the plugin held this endpoint after its own failed reads' }), ep('e-3', 'tts', T3, M255)], stt: [] } });
    await tick(40);
    await tts(c, { text: 'holder on e-3', endpoint_id: 'e-3' });
    await tick(60);
    const b = await tts(c, { text: 'older row pinned to the paused e-1', endpoint_id: 'e-1' });
    await tick(60);
    const d = await tts(c, { text: 'newer row pinned to the paused e-1 too', endpoint_id: 'e-1' });
    await tick(60);
    const eR = await tts(c, { text: 'newer row pinned to the free primary', endpoint_id: 'primary' });
    await tick(120);
    const urls = speechUrls(c);
    const bRow = await row(c, b.job_id);
    const dRow = await row(c, d.job_id);
    const eRow = await row(c, eR.job_id);
    ok('T-255 (a2) + T-503: the newer row on the held lane is now looked at and carries exactly ONE park key — endpoint_slot_wait naming its lane and the OLDER row ahead of it there (no endpoint_wait, no machine_wait, no batch_order_wait), while the head row of that lane keeps the endpoint_wait naming the pause — and no render ever went to the paused endpoint (pre-edit this row was never examined and carried no reason at all)',
      dRow.status === 'queued' && !!dRow.endpoint_slot_wait && dRow.endpoint_slot_wait.id === 'e-1'
      && dRow.endpoint_slot_wait.job_id === b.job_id && dRow.endpoint_slot_wait.url === T2
      && !dRow.endpoint_wait && !dRow.machine_wait && !dRow.endpoint_boot_wait && !dRow.batch_order_wait
      && bRow.status === 'queued' && !!bRow.endpoint_wait && bRow.endpoint_wait.id === 'e-1'
      && countUrl(urls, T2) === 0,
      { keys: Object.keys(dRow), w: dRow.endpoint_slot_wait, head: bRow.endpoint_wait, urls: urls });
    ok('T-255 (a2) + T-503: the row that could run elsewhere DID run on the free primary — a held endpoint no longer parks the whole queue, and the paused lane gained no overtaker',
      eRow.status === 'running' && eRow.endpoint_id === 'primary' && countUrl(urls, T1) === 1,
      { e: eRow.status, ep: eRow.endpoint_id, urls: urls });
    c.release();
    await tick(300);
  }

  // ==========================================================================
  // T-255 (b) — BATCH PART ORDER. A batch part may be overtaken only once its
  // OWN predecessor part (batch_id + batch_part - 1) has left the queue. The
  // rows here are restored queued rows (the restart shape: the queue comes back
  // paused and resume_fn pumps it), so the batch labels are on the rows exactly
  // as dispatch_batch wrote them.
  // ==========================================================================
  console.log('\n--- T-255 (b): a batch part whose predecessor part is still queued parks with batch_order_wait ---');
  {
    const row255 = function (id, extra) {
      return Object.assign({
        id: id, fn: 'tts', kind: 'tts', status: 'queued', model: 'moss_ttsd', voice: '',
        text: 'seeded queued row ' + id, language: '', format: '', instructions: '', speakers: [],
        max_frames: 0, batch_id: '', batch_part: 0, batch_parts: 0, batch_title: '', batch_cast: [],
        endpoint_id: '', endpoint_url: '', endpoint_route: 'speech', endpoint_pending: true,
        created: 1000, queued_at: 1000, started: 0, ended: 0, options: {},
      }, extra || {});
    };
    const seed255 = {
      version: 3,
      endpoints: { tts: { url: T1, route: 'speech' }, stt: { url: S1, route: 'speech' } },
      endpoint_registry: { tts: [ep('e-1', 'tts', T2, M255), ep('e-3', 'tts', T3, M255, { enabled: false, held_by: 'plugin', hold_reason: 'the plugin held this endpoint after its own failed reads' })], stt: [] },
      counter: 205,
      // newest first — the oldest queued row is ap-205, batch b-1 part 1, pinned to the paused e-3.
      // Every part carries its lane, so the walk decides ORDER, not placement.
      playlist: [
        row255('ap-201', { batch_id: 'b-2', batch_part: 2, batch_parts: 2, endpoint_id: 'e-1', endpoint_url: T2, endpoint_pending: false }),
        row255('ap-202', { batch_id: 'b-2', batch_part: 1, batch_parts: 2, status: 'ok', endpoint_pending: false }),
        row255('ap-203', { batch_id: 'b-1', batch_part: 3, batch_parts: 3, endpoint_id: 'primary', endpoint_url: T1, endpoint_pending: false }),
        row255('ap-204', { batch_id: 'b-1', batch_part: 2, batch_parts: 3, endpoint_id: 'primary', endpoint_url: T1, endpoint_pending: false }),
        row255('ap-205', { batch_id: 'b-1', batch_part: 1, batch_parts: 3, endpoint_id: 'e-3', endpoint_url: T3, endpoint_pending: false }),
      ],
    };
    const c = mk({ rawSeed: JSON.stringify(seed255) });
    await tick(60);
    await call(c.api, '/api/deepamp/resume_fn', 'POST', { fn: 'tts' });
    await tick(150);
    const urls = speechUrls(c);
    const r201 = await row(c, 'ap-201');
    const r203 = await row(c, 'ap-203');
    const r204 = await row(c, 'ap-204');
    const r205 = await row(c, 'ap-205');
    const r202 = await row(c, 'ap-202');
    const cq = await q(c);
    ok('T-255 (b): the queue was walked past two parked batch parts to the row behind them — b-2 part 2 runs on the idle endpoint e-1 (pre-edit the pump stopped at b-1 part 1 and nothing ran at all)',
      r201.status === 'running' && r201.endpoint_id === 'e-1' && countUrl(urls, T2) === 1
      && r201.batch_id === 'b-2' && r201.batch_part === 2,
      { r201: { st: r201.status, ep: r201.endpoint_id, batch: r201.batch_id, part: r201.batch_part }, urls: urls });
    ok('T-255 (b): b-1 part 2 parks with the NEW park key batch_order_wait naming the batch, the part number it waits for, and that part\'s job id',
      !!r204.batch_order_wait && r204.batch_order_wait.batch === 'b-1' && r204.batch_order_wait.part === 1
      && r204.batch_order_wait.job_id === 'ap-205',
      { batch_order_wait: r204.batch_order_wait, keys: Object.keys(r204) });
    ok('T-255 (b): b-1 part 3 waits for PART 2 (ap-204), not for the batch head — the order rule is per part, and a part never waits for another batch',
      !!r203.batch_order_wait && r203.batch_order_wait.batch === 'b-1' && r203.batch_order_wait.part === 2
      && r203.batch_order_wait.job_id === 'ap-204',
      { batch_order_wait: r203.batch_order_wait });
    ok('T-255 (b): a batch-parked row carries EXACTLY ONE park key — batch_order_wait, with no endpoint_wait / machine_wait / endpoint_slot_wait / endpoint_boot_wait / endpoint_pending beside it (and it keeps its placement)',
      r204.status === 'queued' && !!r204.batch_order_wait && !r204.endpoint_wait && !r204.machine_wait
      && !r204.endpoint_slot_wait && !r204.endpoint_boot_wait && r204.endpoint_pending !== true && !!r204.endpoint_id
      && r205.status === 'queued' && !!r205.endpoint_wait && r205.endpoint_wait.id === 'e-3' && !r205.batch_order_wait,
      { r204keys: Object.keys(r204), r205: { w: r205.endpoint_wait, b: r205.batch_order_wait } });
    ok('T-255 (b): the other batch is untouched by this one — b-2 part 2 ran because its OWN part 1 had already finished, while the three b-1 rows stay queued with exactly one slot used and the queue not paused (pre-edit: 4 queued, 0 running)',
      cq.queues.tts.queued === 3 && cq.queues.tts.slots.used === 1 && cq.queues.tts.paused === false
      && cq.queues.tts.auto_paused === '' && r202.status === 'ok' && !r202.batch_order_wait,
      cq.queues.tts);
    c.release();
    await tick(300);
  }

  // ==========================================================================
  // T-255 (c) — THE GUARD BOUND. The old pump allowed 32 iterations and never
  // needed more, because it stopped at row 1. The walk needs one iteration per
  // queued row it examines, so the bound is the queue it has to walk (MAX_PLAYLIST
  // caps that at 200); the old 32 stays as the floor. Here 36 rows park on one
  // endpoint and the row behind them is #37 — past the old bound.
  // ==========================================================================
  console.log('\n--- T-255 (c): the walk reaches row 37 — the bound is the queue, not the old fixed 32 ---');
  {
    const c = mk({ registry: { tts: [ep('e-1', 'tts', T2, M255), ep('e-3', 'tts', T3, M255)], stt: [] } });
    await tick(40);
    await tts(c, { text: 'holder on e-3', endpoint_id: 'e-3' });
    await tick(40);
    for (let i = 0; i < 36; i++) {
      await tts(c, { text: 'row pinned behind the holder on e-3 n' + i, endpoint_id: 'e-3' });
    }
    await tick(60);
    const last = await tts(c, { text: 'row 37: unassigned, and two endpoints are free' });
    await tick(150);
    const lastRow = await row(c, last.job_id);
    const cq = await q(c);
    ok('T-255 (c): row 37 — behind 36 parked rows — was reached and runs on the idle primary lane (pre-edit the pump stopped at parked row 1; even a 32-iteration walk could not reach row 37)',
      lastRow.status === 'running' && lastRow.endpoint_id === 'primary' && countUrl(speechUrls(c), T1) === 1
      && countUrl(speechUrls(c), T2) === 0,
      { st: lastRow.status, ep: lastRow.endpoint_id, pos: lastRow.position, urls: speechUrls(c) });
    ok('T-255 (c): 36 rows are still parked with two of three endpoints working and nothing errored, refused or auto-paused — the walk parks rows, it never spends them',
      cq.queues.tts.queued === 36 && cq.queues.tts.slots.max === 3 && cq.queues.tts.slots.used === 2
      && cq.queues.tts.paused === false && cq.queues.tts.auto_paused === '' && !autoPauseLogged(c),
      { queued: cq.queues.tts.queued, slots: cq.queues.tts.slots });
    c.release();
    await tick(300);
  }

  // ==========================================================================
  // T-337 — the per-(endpoint, model) failure verdict.
  // Live fault 2026-10-13 (ap-0166, gpu1 e-10, build 650b6370): moss_ttsd_q8 loaded in
  // 2 419 ms, ran 30 700 ms, and the engine answered
  //   curl exit 22: ... 500 | body: vk::Queue::submit: ErrorDeviceLost
  // while the SAME model renders 12-second takes cleanly on cpu1 and nemotron_3_diar
  // renders on that same Vulkan endpoint. The user's ruling: "a model can be fine using a
  // different quant, so we should mark that quant of that model on that host in this
  // audio.cpp version as 'testing failed with'". The unit is (model, endpoint). A family ban
  // would have banned a model that works, so this suite asserts the RECORD and, just as hard,
  // that nothing about placement moved.
  // ==========================================================================
  console.log('\n--- T-337: a device-lost answer records a verdict on (model, endpoint) and nothing else ---');
  {
    const c = mk({ registry: { tts: [ep('e-1', 'tts', T2, ['moss_ttsd', 'qwen3-tts']), ep('e-3', 'tts', T3, ['moss_ttsd', 'qwen3-tts'])], stt: [] } });
    await tick(40);
    const perfEv = function (re) {
      const lines = (c.shellCalls || []).join('\n');
      return (lines.match(new RegExp(re, 'g')) || []).length;
    };
    c.hold = false;
    c.failBody = JSON.stringify({ error: { message: 'HTTP 500 vk::Queue::submit: ErrorDeviceLost' } });
    const f = await tts(c, { text: 'the take that wedged the vulkan lane', endpoint_id: 'e-3' });
    await tick(160);
    c.failBody = null;
    const fRow = await row(c, f.job_id);
    const reg = J(await call(c.api, '/api/deepamp/endpoint_registry?fn=tts', 'GET'));
    const e3 = (reg.endpoints || []).filter(function (x) { return x.id === 'e-3'; })[0] || {};
    const e1 = (reg.endpoints || []).filter(function (x) { return x.id === 'e-1'; })[0] || {};
    const prim = reg.primary || {};
    const fl = J(await call(c.api, '/api/deepamp/endpoint_failures?fn=tts', 'GET'));
    const flE3 = J(await call(c.api, '/api/deepamp/endpoint_failures?fn=tts&id=e-3', 'GET'));
    ok('T-337: the device-lost row really failed on e-3 with the engine sentence',
      fRow.status === 'error' && fRow.endpoint_id === 'e-3' && /ErrorDeviceLost/.test(String(fRow.error || '')),
      { st: fRow.status, ep: fRow.endpoint_id, err: String(fRow.error || '').slice(0, 90) });
    ok('T-337: e-3 carries exactly ONE verdict, for the model that failed, named as the engine names it',
      (e3.model_failures || []).length === 1 && e3.model_failures[0].model === 'moss_ttsd',
      { e3: e3.model_failures });
    ok('T-337: the verdict carries the class the guard already decided, the engine words, the count and the row that saw it',
      (e3.model_failures || [])[0] && e3.model_failures[0].outcome === 'device_lost'
      && /ErrorDeviceLost/.test(e3.model_failures[0].error) && e3.model_failures[0].count === 1
      && e3.model_failures[0].jobs.indexOf(f.job_id) >= 0 && e3.model_failures[0].ts > 0,
      e3.model_failures && e3.model_failures[0]);
    ok('T-337: the verdict is stamped on ONE endpoint - e-1 and the primary report an empty list, not a clean bill of health',
      (e1.model_failures || []).length === 0 && (prim.model_failures || []).length === 0,
      { e1: e1.model_failures, primary: prim.model_failures });
    ok('T-337: endpoint_failures reads the fleet (every endpoint of the fn, verdicts counted) and one endpoint by id',
      fl.ok === true && fl.verdicts === 1 && (fl.endpoints || []).length === 3
      && flE3.ok === true && flE3.endpoints.length === 1 && flE3.endpoints[0].id === 'e-3'
      && flE3.endpoints[0].model_failures.length === 1,
      { fleet: fl.verdicts, fleet_rows: (fl.endpoints || []).length, one: flE3.endpoints && flE3.endpoints[0] });
    ok('T-337: the record event names what it is, per model on this endpoint, not per family',
      perfEv('"ev":"model_failure_record"') >= 1, { events: perfEv('"ev":"model_failure_record"') });
    // Captured HERE, before any clear: this is the state file a plugin would restart into with
    // the verdict still standing. (Reading it later would read the cleared state and prove
    // nothing, which is exactly the mistake this line replaced.)
    const savedWithVerdict = String(c.fsMap[STATE] || '');
    ok('T-337: the verdict is written to state.json (it survives the plugin, not just the row)',
      /"model_failures"/.test(savedWithVerdict) && /moss_ttsd/.test(savedWithVerdict),
      savedWithVerdict.slice(savedWithVerdict.indexOf('"model_failures"'), savedWithVerdict.indexOf('"model_failures"') + 220));
    // Placement is NOT changed by a verdict. This is the half of T-337 the user did not ask for
    // and the half that must stay true: the record is data for a later whitelist decision.
    c.hold = true;
    const again = await tts(c, { text: 'the same model, pinned to the same endpoint, after the verdict', endpoint_id: 'e-3' });
    await tick(60);
    const againRow = await row(c, again.job_id);
    ok('T-337: a verdict does not ban the model - the next pinned row on the SAME endpoint is still placed there',
      again.ok === true && againRow.endpoint_id === 'e-3' && (againRow.status === 'running' || againRow.status === 'ok'),
      { dispatch: again, st: againRow.status, ep: againRow.endpoint_id });
    c.release();
    await tick(200);
    // A connection failure is an ENDPOINT fact and must not be copied onto the model.
    const c2 = mk({ registry: { tts: [ep('e-3', 'tts', T3, ['moss_ttsd', 'qwen3-tts'])], stt: [] } });
    await tick(40);
    c2.hold = false;
    c2.connFail = true;
    const g = await tts(c2, { text: 'the socket died instead of the model', endpoint_id: 'e-3' });
    await tick(160);
    c2.connFail = false;
    const gRow = await row(c2, g.job_id);
    const reg2 = J(await call(c2.api, '/api/deepamp/endpoint_registry?fn=tts', 'GET'));
    const gE3 = (reg2.endpoints || []).filter(function (x) { return x.id === 'e-3'; })[0] || {};
    ok('T-337: a connection failure left the row failed and recorded NO model verdict',
      gRow.status === 'error' && (gE3.model_failures || []).length === 0,
      { st: gRow.status, err: String(gRow.error || '').slice(0, 80), failures: gE3.model_failures });
    // Clearing is an operator decision, and it is per model or per endpoint.
    const cl1 = J(await call(c.api, '/api/deepamp/endpoint_failures_clear', 'POST', { fn: 'tts', id: 'e-3', model: 'qwen3-tts' }));
    const afterCl1 = J(await call(c.api, '/api/deepamp/endpoint_failures?fn=tts&id=e-3', 'GET'));
    ok('T-337: clearing a model that has no verdict clears nothing and says so',
      cl1.ok === true && cl1.cleared === 0 && afterCl1.endpoints[0].model_failures.length === 1,
      { cleared: cl1.cleared, still: afterCl1.endpoints[0].model_failures.length });
    const cl2 = J(await call(c.api, '/api/deepamp/endpoint_failures_clear', 'POST', { fn: 'tts', id: 'e-3', model: 'moss_ttsd' }));
    const afterCl2 = J(await call(c.api, '/api/deepamp/endpoint_failures?fn=tts&id=e-3', 'GET'));
    ok('T-337: clearing the named model removes exactly that verdict on exactly that endpoint',
      cl2.ok === true && cl2.cleared === 1 && afterCl2.endpoints[0].model_failures.length === 0,
      { cleared: cl2.cleared, after: afterCl2.endpoints[0].model_failures });
    const badClear = J(await call(c.api, '/api/deepamp/endpoint_failures_clear', 'POST', { fn: 'tts' }));
    ok('T-337: a clear without an id is refused rather than clearing the whole fleet',
      badClear.ok === false && /id is required/.test(String(badClear.error || '')), badClear.error);
    // The verdict survives a PLUGIN restart, which is when the question actually gets asked.
    const c3 = mk({ rawSeed: savedWithVerdict });
    await tick(60);
    const reg3 = J(await call(c3.api, '/api/deepamp/endpoint_registry?fn=tts', 'GET'));
    const r3E3 = (reg3.endpoints || []).filter(function (x) { return x.id === 'e-3'; })[0] || {};
    ok('T-337: after a plugin restart the verdict is still there, with its count and the row that produced it',
      (r3E3.model_failures || []).length === 1 && r3E3.model_failures[0].model === 'moss_ttsd'
      && r3E3.model_failures[0].outcome === 'device_lost' && r3E3.model_failures[0].count === 1,
      r3E3.model_failures);
    const c4 = mk({ rawSeed: savedWithVerdict.replace('"model_failures":', '"model_failures_bogus":') });
    await tick(60);
    const reg4 = J(await call(c4.api, '/api/deepamp/endpoint_registry?fn=tts', 'GET'));
    const r4E3 = (reg4.endpoints || []).filter(function (x) { return x.id === 'e-3'; })[0] || {};
    ok('T-337: a state file from before T-337 restores with an empty verdict list, not a guess',
      (r4E3.model_failures || []).length === 0, r4E3.model_failures);
  }

  // ==========================================================================
  // T-342 — a LISTENING verdict on a take, keyed by job id.
  // Live fault 2026-10-13 (ap-0186 vevo2, ap-0188 controlfoley q8_0, gpu1 e-10, build
  // 650b6370): both rows came back status ok with audio, and the user's verdict on hearing
  // them was "noise" and "really bad noise, loud!". The user's ruling on the WORDING:
  // "'rejected' is too hard, we might have been using them wrong ;D — add a marker in the ui
  // and a tag for the agent - and track as long term todo to investigate". So the marker is
  // not a ban and not a model verdict (that is T-337, per model on per endpoint): it is a note
  // on THIS take, as dispatched. The engine cannot hear, so only a person or the agent sets it.
  // ==========================================================================
  console.log('\n--- T-342: a take judged by ear carries a marker, and nothing else moves ---');
  {
    const c = mk({ registry: { tts: [ep('e-1', 'tts', T2, ['vevo2', 'controlfoley'])], stt: [] } });
    await tick(40);
    const m1 = J(await call(c.api, '/api/deepamp/job_flag', 'POST',
      { job_id: 'ap-0186', flag: 'noise', note: 'ap-0186 -> noise' }));
    ok('T-342: a marker is stored on the take it belongs to, with the flag, the words used and a time',
      m1.ok === true && m1.job === 'ap-0186' && m1.flag === 'noise' && /noise/.test(m1.note) && m1.ts > 0,
      m1);
    const m2 = J(await call(c.api, '/api/deepamp/job_flag', 'POST',
      { job_id: 'ap-0188', flag: 'noise', note: 'the controlfoley@q8_0 result 0188 -> really bad noise, loud!' }));
    ok('T-342: a second take carries its own marker; two takes of the same kind are not one verdict',
      m2.ok === true && m2.job === 'ap-0188', m2);
    const all = J(await call(c.api, '/api/deepamp/job_flags', 'GET'));
    ok('T-342: job_flags reads the whole table back — this is the tag the agent can see',
      all.ok === true && all.count === 2 && all.flags['ap-0186'].flag === 'noise'
      && /loud/.test(all.flags['ap-0188'].note), all);
    const one = J(await call(c.api, '/api/deepamp/job_flags?job=ap-0186', 'GET'));
    const none = J(await call(c.api, '/api/deepamp/job_flags?job=ap-9999', 'GET'));
    ok('T-342: one take by id answers its marker, and an unmarked take answers null rather than a guess',
      one.flag && one.flag.flag === 'noise' && none.ok === true && none.flag === null,
      { one: one.flag, none: none.flag });
    const pl = J(await call(c.api, '/api/deepamp/playlist_list?page_size=50', 'GET'));
    const qs = J(await call(c.api, '/api/deepamp/queue_status', 'GET'));
    ok('T-342: the markers ride the answers that draw the rows (playlist_list and queue_status), so the panel marks a row in the read that painted it',
      pl.quality_flags && pl.quality_flags['ap-0186'] && qs.quality_flags && Object.keys(qs.quality_flags).length === 2,
      { pl: Object.keys(pl.quality_flags || {}), qs: Object.keys(qs.quality_flags || {}) });
    const badFlag = J(await call(c.api, '/api/deepamp/job_flag', 'POST', { job_id: 'ap-0186', flag: 'REALLY BAD NOISE!!' }));
    const longFlag = J(await call(c.api, '/api/deepamp/job_flag', 'POST', { job_id: 'ap-0186', flag: 'n'.repeat(40) }));
    const badJob = J(await call(c.api, '/api/deepamp/job_flag', 'POST', { job_id: 'ap-; rm -rf /', flag: 'noise' }));
    ok('T-342: a flag that is not a lowercase token, and a job id that is not ap-<digits>, are both refused',
      badFlag.ok === false && longFlag.ok === false && badJob.ok === false,
      { flag: badFlag.error, long: longFlag.error, job: badJob.error });
    const getFlag = await call(c.api, '/api/deepamp/job_flag', 'GET', {});
    ok('T-342: setting a marker is a POST; a read method on it is refused', getFlag.code === 405, getFlag.code);
    const cl = J(await call(c.api, '/api/deepamp/job_flag_clear', 'POST', { job_id: 'ap-0188' }));
    const afterCl = J(await call(c.api, '/api/deepamp/job_flags', 'GET'));
    ok('T-342: clearing removes exactly the named take and leaves the other marker alone',
      cl.ok === true && cl.cleared === 1 && afterCl.count === 1 && !!afterCl.flags['ap-0186'] && !afterCl.flags['ap-0188'],
      afterCl);
    // The marker survives a plugin restart — that is when the question "what did we already
    // hear?" actually gets asked. The snapshot is the state file as it stands after the clear above
    // (the save is debounced, so how many markers it still holds is the host's own business, not
    // this test's). What is pinned is the CONTRACT: whatever state.json holds is exactly what comes
    // back, with its flag and its words, and a stored id the plugin would refuse to write is
    // refused on the way in too.
    await tick(300);
    const savedWithFlags = String(c.fsMap[STATE] || '');
    const expectBoth = /ap-0188/.test(savedWithFlags);
    ok('T-342: the marker is written to state.json (it survives the plugin, not just the row)',
      /"quality_flags"/.test(savedWithFlags) && /ap-0186/.test(savedWithFlags),
      savedWithFlags.slice(savedWithFlags.indexOf('"quality_flags"'), savedWithFlags.indexOf('"quality_flags"') + 180));
    c.release();
    await tick(200);
    const c2 = mk({ rawSeed: savedWithFlags });
    await tick(60);
    const back = J(await call(c2.api, '/api/deepamp/job_flags', 'GET'));
    ok('T-342: after a plugin restart the table is exactly what state.json held, flag and words intact',
      back.count === (expectBoth ? 2 : 1) && back.flags['ap-0186'] && back.flags['ap-0186'].flag === 'noise'
      && /noise/.test(back.flags['ap-0186'].note) && back.flags['ap-0186'].ts > 0
      && (!!back.flags['ap-0188'] === expectBoth),
      { expected: expectBoth ? 2 : 1, got: back.flags });
    const cl2 = J(await call(c2.api, '/api/deepamp/job_flag_clear', 'POST', { job_id: 'ap-0186' }));
    const back2 = J(await call(c2.api, '/api/deepamp/job_flags', 'GET'));
    ok('T-342: a marker restored from state is still a marker that can be cleared',
      cl2.ok === true && cl2.cleared === 1 && !back2.flags['ap-0186'],
      back2.flags);
    const c3 = mk({ rawSeed: savedWithFlags.replace('"quality_flags":', '"quality_flags_bogus":') });
    await tick(60);
    const back3 = J(await call(c3.api, '/api/deepamp/job_flags', 'GET'));
    ok('T-342: a state file from before T-342 restores with an empty table, not a guess',
      back3.count === 0, back3);
    const c4 = mk({ rawSeed: savedWithFlags.replace(/"ap-0186"/, '"ap-1; ls"') });
    await tick(60);
    const back4 = J(await call(c4.api, '/api/deepamp/job_flags', 'GET'));
    const qf4Keys = Object.keys(back4.flags || {});
    ok('T-342: a stored job id that is not one of the plugin\u2019s own ids is dropped on restore, and nothing hostile survives',
      !back4.flags['ap-0186'] && qf4Keys.every(function (k) { return /^ap-\d+$/.test(k); })
      && back4.count === (expectBoth ? 1 : 0),
      { keys: qf4Keys, count: back4.count });
    c2.release(); c3.release(); c4.release();
    await tick(200);
  }

  // ==========================================================================
  // T-342 contract guards: a listening marker is DATA. It is not read by placement,
  // and it is not a model verdict (T-337 owns model verdicts, on endpoints).
  // ==========================================================================
  console.log('\n--- T-342 contract: the marker moves nothing, bans nothing, polls nothing ---');
  {
    const SRC = require('fs').readFileSync(LIB, 'utf8');
    const evStart = SRC.indexOf('function evaluateEndpoints(');
    const evBody = evStart >= 0 ? SRC.slice(evStart, SRC.indexOf('function ', evStart + 10)) : '';
    const prStart = SRC.indexOf('function placementRank(');
    const prBody = prStart >= 0 ? SRC.slice(prStart, SRC.indexOf('function ', prStart + 10)) : '';
    const stStart = SRC.indexOf('function startQueuedJob(');
    const stBody = stStart >= 0 ? SRC.slice(stStart, SRC.indexOf('takeQueueSlot(fn, job, ac)', stStart)) : '';
    ok('T-342 contract: placement never reads qualityFlags (a marker is not a capability bar)',
      evBody.length > 0 && prBody.length > 0 && !/qualityFlags|qualityFlag/.test(evBody + prBody),
      ((evBody + prBody).match(/qualityFlags/g) || []).slice(0, 3));
    ok('T-342 contract: the runner never reads qualityFlags (a marked take is still just a take)',
      stBody.length > 0 && !/qualityFlags/.test(stBody), (stBody.match(/qualityFlags/g) || []).slice(0, 3));
    ok('T-342 contract: no new timer or ceiling was introduced for a marker',
      !/QUALITY_FLAG_TTL|QUALITY_POLL|FLAG_RETRY/.test(SRC),
      SRC.split('\n').filter(function (l) { return /QUALITY_FLAG_TTL|QUALITY_POLL|FLAG_RETRY/.test(l); }).slice(0, 3));
    const setStart = SRC.indexOf('function setQualityFlag(');
    const setBody = setStart >= 0 ? SRC.slice(setStart, SRC.indexOf('\n  function ', setStart + 10)) : '';
    ok('T-342 contract: setting a marker touches no queue, no streak, no endpoint state, and dispatches nothing',
      setBody.length > 0 && !/queues\[|wedgeStreak|failStreak|busyStreak|dispatchTts|startQueuedJob/.test(setBody),
      (setBody.match(/queues\[|wedgeStreak|dispatchTts/g) || []).slice(0, 3));
  }

  // ==========================================================================
  // T-607 — PROVISIONAL PLACEMENT. Live report 2026-10-20: "playlist shows
  // ap-0068 … e-11 slot busy instead of using TTS1 — the 'fix to an endpoint for
  // jobs' seems to happen too early". Measured that morning: ap-0065..ap-0068 were
  // all stamped onto e-11 in ONE completion pass (assigned_at 1792453812321 for one
  // row and …322 for the other three); the head row parked at the pre-flight gate
  // and never took a queue slot, so the whole-queue stop never stopped the walk;
  // rowLaneOf then made e-11 the home of every row behind it. cpu1 (the primary
  // lane) went idle four minutes later — idle, model loaded, capacity 2 with one
  // slot used — and ap-0066 did not start for 21 minutes 13 s.
  // The rule this section pins: a placement is PROVISIONAL for a row nobody pinned.
  // Each pass asks one question per row — can the lane it carries take the row NOW?
  // yes: keep it; no: place it again among the lanes that can, and a lane an earlier
  // row of this pass claimed is not offered again. A row the caller PINNED
  // (endpoint_pinned) is outside the whole question.
  // ==========================================================================
  console.log('\n--- T-607: an unpinned row moves to a lane that can serve it; a pin never does ---');
  {
    // The live shape, seeded: three rows welded to e-1, plus rows that arrive while every
    // engine is busy. What the live playlist did wrong was name ONE lane for every row that
    // a single pass walked (ap-0066/67/68 all stamped e-11 at 1792453812321/322) and then
    // never look again, while cpu1 sat idle from 1792454066796 on and ap-0066 waited
    // 21 minutes 13 s for a lane that could have taken it.
    const row607 = function (id, created, extra) {
      return Object.assign({
        id: id, fn: 'tts', kind: 'tts', status: 'queued', model: 'moss_ttsd', voice: '',
        text: 'queued row ' + id, language: '', format: '', instructions: '', speakers: [],
        max_frames: 0, batch_id: '', batch_part: 0, batch_parts: 0, batch_title: '', batch_cast: [],
        endpoint_id: 'e-1', endpoint_url: T2, endpoint_route: 'speech', endpoint_pending: false,
        assigned_at: 900, created: created, queued_at: created, started: 0, ended: 0, options: {},
      }, extra || {});
    };
    const seed607 = {
      version: 3,
      endpoints: { tts: { url: T1, route: 'speech' }, stt: { url: S1, route: 'speech' } },
      endpoint_registry: { tts: [ep('e-1', 'tts', T2, ['moss_ttsd', 'qwen3-tts'], {
        enabled: false, held_by: 'plugin', hold_reason: 'the plugin held this endpoint after its own failed reads',
      })], stt: [] },
      counter: 124,
      // newest first — the walk takes them oldest first (ap-121, ap-122, ap-123).
      playlist: [row607('ap-123', 1230), row607('ap-122', 1220), row607('ap-121', 1210)],
    };
    const c = mk({ rawSeed: JSON.stringify(seed607) });
    await tick(60);
    await call(c.api, '/api/deepamp/resume_fn', 'POST', { fn: 'tts' });
    await tick(200);
    const urls = speechUrls(c);
    const r121 = await row(c, 'ap-121');
    const r122 = await row(c, 'ap-122');
    const r123 = await row(c, 'ap-123');
    const reg607 = J(await call(c.api, '/api/deepamp/endpoint_registry?fn=tts', 'GET'));
    const clockOf = function (id) {
      if (id === 'primary') return (reg607.primary || {}).last_used_at || 0;
      const e = (reg607.endpoints || []).filter(function (x) { return x.id === id; })[0];
      return e ? (e.last_used_at || 0) : -1;
    };
    const waitOf = function (r) {
      return r.endpoint_wait || r.endpoint_slot_wait || r.endpoint_boot_wait || r.machine_wait || null;
    };
    ok('T-607: a row already promised to a held endpoint KEEPS that lane and names the wait (T-188 / T-503) — the pump does not churn it onto another lane, and none of these rows carries a pin',
      r121.status === 'queued' && r121.endpoint_id === 'e-1' && !!r121.endpoint_wait && r121.endpoint_wait.id === 'e-1'
      && r121.endpoint_pinned !== true,
      { st: r121.status, ep: r121.endpoint_id, w: r121.endpoint_wait, pinned: r121.endpoint_pinned });
    ok('T-607: the two rows behind it are NOT placed on some other lane either — they keep the lane they carry and each carries exactly ONE park key naming that lane and the row ahead of it (T-255 FIFO), no welding, no churn',
      r122.status === 'queued' && r123.status === 'queued'
      && r122.endpoint_id === 'e-1' && r123.endpoint_id === 'e-1'
      && !!r122.endpoint_slot_wait && r122.endpoint_slot_wait.id === 'e-1' && r122.endpoint_slot_wait.job_id === 'ap-121'
      && !!r123.endpoint_slot_wait && r123.endpoint_slot_wait.id === 'e-1' && r123.endpoint_slot_wait.job_id === 'ap-121'
      && [r122, r123].every(function (r) {
        return ['endpoint_wait', 'endpoint_slot_wait', 'endpoint_boot_wait', 'machine_wait', 'endpoint_pending']
          .filter(function (k) { return !!r[k]; }).length === 1;
      })
      && r122.endpoint_pinned !== true && r123.endpoint_pinned !== true,
      { r122: { ep: r122.endpoint_id, sw: r122.endpoint_slot_wait, keys: Object.keys(r122).filter(function (k) { return /wait|pending/.test(k); }) },
        r123: { ep: r123.endpoint_id, sw: r123.endpoint_slot_wait, keys: Object.keys(r123).filter(function (k) { return /wait|pending/.test(k); }) } });
    ok('T-607: the usage clock is the moment a row TOOK THE SLOT, not the moment a lane was named — three rows sit placed on e-1, and that clock has never moved',
      clockOf('e-1') === 0 && clockOf('primary') === 0 && speechUrls(c).length === 0,
      { e1: clockOf('e-1'), primary: clockOf('primary'), urls: speechUrls(c) });

    // The hold clears. A row whose lane can take it keeps that lane; the row behind it is NOT
    // welded onto the lane an earlier row of the same pass already took — it is placed on the
    // lane that still has room. This is what the live pump failed to do in one pass.
    await call(c.api, '/api/deepamp/endpoint_resume', 'POST', { fn: 'tts', id: 'e-1' });
    // T-649 (2026-10-26): the re-armed hold was probed WHILE it was held, and this suite's mock answers
    // /health with a bare body and no status, so that probe recorded an OFFLINE verdict. The T-236
    // admission gate honours an offline answer for BOOT_REPROBE_MS — a resume does not fire a row at an
    // engine that just refused to answer. So the fixture asks what a person asks after restarting an
    // engine: press endpoint_health, get a real answer, and the row is admitted on the next pass.
    c.healthAnswer = { exitCode: 0, stdout: { text: '{"status":"ok","backend":"cpu"}\n200' }, stderr: { text: '' }, aborted: false };
    await call(c.api, '/api/deepamp/endpoint_health', 'POST', { fn: 'tts', id: 'e-1' });
    await tick(250);
    const urlsB = speechUrls(c);
    const b121 = await row(c, 'ap-121');
    const b122 = await row(c, 'ap-122');
    const b123 = await row(c, 'ap-123');
    const regB = J(await call(c.api, '/api/deepamp/endpoint_registry?fn=tts', 'GET'));
    const clockB = function (id) {
      if (id === 'primary') return (regB.primary || {}).last_used_at || 0;
      const e = (regB.endpoints || []).filter(function (x) { return x.id === id; })[0];
      return e ? (e.last_used_at || 0) : -1;
    };
    ok('T-607: the row that carried e-1 keeps e-1 (no churn); the row behind it moves to the idle primary lane instead of piling onto the lane its own pass already took — both engines render, one row each',
      b121.endpoint_id === 'e-1' && (b121.status === 'running' || b121.status === 'ok')
      && b122.endpoint_id === 'primary' && (b122.status === 'running' || b122.status === 'ok')
      && countUrl(urlsB, T2) === 1 && countUrl(urlsB, T1) === 1,
      { r121: { st: b121.status, ep: b121.endpoint_id }, r122: { st: b122.status, ep: b122.endpoint_id }, urls: urlsB });
    // The head-row shape the live incident produced: this row reached the T-236 pre-flight gate
    // (e-1 had to load the model) and so it took NO queue slot — the walk went past it, and the
    // row behind it still had somewhere to be told. It keeps its lane; it is not welded onto the
    // lane the same pass already took, and it says what it waits for.
    ok('T-607: the row with no room left is not welded and not silent — it keeps e-1 and says what it waits for (the pre-flight model load), and it is NOT stamped onto the lane this same pass already took',
      b123.status === 'queued' && b123.endpoint_id === 'e-1' && b123.waiting_for_model === true
      && b123.endpoint_pending !== true && !b123.endpoint_wait,
      { st: b123.status, ep: b123.endpoint_id, keys: Object.keys(b123).filter(function (k) { return /wait|pending|model/.test(k); }) });
    ok('T-607: both lanes now carry a real usage clock — each was 0 while rows sat placed on it, and each moved only when a row actually TOOK THE SLOT (the clock the next pass ranks on)',
      clockB('e-1') > 0 && clockB('primary') > 0,
      { e1: clockB('e-1'), primary: clockB('primary'), was: [0, 0] });
    c.release();
    await tick(300);

    // --- the incident shape: rows arrive while every engine is busy, and a completion pass
    //     must hand each free lane to ONE row, never to every row it walks ------------------
    const c2 = mk({ registry: { tts: [ep('e-1', 'tts', T2, ['moss_ttsd', 'qwen3-tts'])], stt: [] } });
    await tick(60);
    const g1 = J(await call(c2.api, '/api/deepamp/dispatch_tts', 'POST', { fn: 'tts', model: 'moss_ttsd', text: 'holder on e-1', endpoint_id: 'e-1' }));
    const g2 = J(await call(c2.api, '/api/deepamp/dispatch_tts', 'POST', { fn: 'tts', model: 'moss_ttsd', text: 'holder on the primary', endpoint_id: 'primary' }));
    await tick(150);
    const pend = [];
    for (var pi = 0; pi < 3; pi++) {
      pend.push(J(await call(c2.api, '/api/deepamp/dispatch_tts', 'POST', { fn: 'tts', model: 'moss_ttsd', text: 'queued row ' + (pi + 1) })).job_id);
      await tick(40);
    }
    await tick(150);
    const pRows = [];
    for (var qi = 0; qi < pend.length; qi++) pRows.push(await row(c2, pend[qi]));
    ok('T-607: with both engines taken, a row that cannot be placed stays UNASSIGNED (endpoint_pending) instead of being welded to the lane that looked closest — no queued row names an endpoint here (the live state named e-11 for all four)',
      pRows.every(function (r) { return r.status === 'queued' && r.endpoint_pending === true && !r.endpoint_id; })
      && pRows.every(function (r) { return !r.endpoint_slot_wait && !r.endpoint_wait; }),
      pRows.map(function (r) { return { st: r.status, ep: r.endpoint_id, pend: r.endpoint_pending, keys: Object.keys(r).filter(function (k) { return /wait|pending|endpoint_id/.test(k); }) } }));
    c2.release();
    await tick(300);
    const urlsC = speechUrls(c2);
    const started = [];
    for (var si = 0; si < pend.length; si++) started.push(await row(c2, pend[si]));
    const onT1 = started.filter(function (r) { return r.endpoint_url === T1; }).length;
    const onT2 = started.filter(function (r) { return r.endpoint_url === T2; }).length;
    ok('T-607: one completion pass hands each lane that can take a row to exactly ONE row — two lanes free, two rows placed, on two different machines',
      onT1 === 1 && onT2 === 1 && countUrl(urlsC, T1) === 2 && countUrl(urlsC, T2) === 2,
      { onT1: onT1, onT2: onT2, urls: urlsC, rows: started.map(function (r) { return { st: r.status, ep: r.endpoint_id }; }) });
    ok('T-607: the row with no room left is still unassigned and says so — never stamped onto a lane that has none',
      started.filter(function (r) { return r.status === 'queued'; }).every(function (r) { return r.endpoint_pending === true && !r.endpoint_id; }),
      started.map(function (r) { return { st: r.status, ep: r.endpoint_id, pend: r.endpoint_pending }; }));
    c2.release();
    await tick(200);

    // --- the PIN half: a row the caller named is outside the whole question -------------
    const cp = mk({ registry: { tts: [ep('e-1', 'tts', T2, ['moss_ttsd', 'qwen3-tts'], {
      enabled: false, held_by: 'plugin', hold_reason: 'the plugin held this endpoint after its own failed reads',
    })], stt: [] } });
    await tick(60);
    const p = J(await call(cp.api, '/api/deepamp/dispatch_tts', 'POST', {
      fn: 'tts', model: 'moss_ttsd', text: 'pinned to an endpoint that is out of play', endpoint_id: 'e-1',
    }));
    await tick(150);
    const pRow = await row(cp, p.job_id);
    const pList = (await rows(cp)).filter(function (r) { return r.id === p.job_id; })[0] || {};
    ok('T-607: a row the caller pinned carries endpoint_pinned: true in its own row view (an automatic placement never sets it)',
      p.ok === true && pRow.status === 'queued' && pRow.endpoint_id === 'e-1' && pRow.endpoint_pinned === true,
      { st: pRow.status, ep: pRow.endpoint_id, pinned: pRow.endpoint_pinned });
    ok('T-607: the pin marker is on the row the PANEL reads, not only on the dispatch response (playlist_list carries it too)',
      pList.endpoint_pinned === true && pList.endpoint_id === 'e-1' && pList.status === 'queued',
      { pinned: pList.endpoint_pinned, ep: pList.endpoint_id, st: pList.status });
    ok('T-607: the pinned row waits for the endpoint it was pinned to, by name, and never falls back to the idle lane beside it (T-221: a pin is evaluated alone)',
      pRow.status === 'queued' && !!pRow.endpoint_wait && pRow.endpoint_wait.id === 'e-1'
      && pRow.endpoint_pending !== true && pRow.endpoint_id === 'e-1' && speechUrls(cp).length === 0,
      { st: pRow.status, w: pRow.endpoint_wait, urls: speechUrls(cp) });
    await tick(700);
    const savedP = JSON.parse(String(cp.fsMap[STATE] || '{}'));
    const sp = (savedP.playlist || []).filter(function (r) { return r.id === p.job_id; })[0] || {};
    ok('T-607: the pin marker is PERSISTED (a restart does not turn a pinned row back into an automatic one)',
      sp.endpoint_pinned === true && sp.endpoint_id === 'e-1', { pinned: sp.endpoint_pinned, ep: sp.endpoint_id });
    const cp2 = mk({ rawSeed: JSON.stringify(savedP) });
    await tick(80);
    const rp = await row(cp2, p.job_id);
    ok('T-607: after a restart the restored row still carries the pin and its endpoint, so the pump still does not re-place it',
      rp.endpoint_pinned === true && rp.endpoint_id === 'e-1', { pinned: rp.endpoint_pinned, ep: rp.endpoint_id, st: rp.status });
    cp2.release();
    await tick(150);
    cp.release();
    await tick(150);
    c.release();
    await tick(150);
  }

  console.log('\n--- T-607 contract: the pump asks availability, never re-decides capability ---');
  {
    const SRC = require('fs').readFileSync(LIB, 'utf8');
    const pumpStart = SRC.indexOf('function pump(');
    const pumpBody = pumpStart >= 0 ? SRC.slice(pumpStart, SRC.indexOf('\n  function ', pumpStart + 10)) : '';
    ok('T-607 contract: the pump asks ONE question per row — can the lane it carries take it now — instead of stamping a placement on every pending row it walks',
      /laneTakeableNow607\(fn, job\)/.test(pumpBody) && /claimed607\[lane\] = true/.test(pumpBody),
      (pumpBody.match(/laneTakeableNow607|claimed607/g) || []).slice(0, 6));
    ok('T-607 contract: a pinned row is never re-placed by the pump (endpoint_pinned is the line the pump does not cross)',
      /job\.endpoint_pinned === true/.test(pumpBody) && !/stampEndpointPlacement\(job, placed\.endpoint, true\)/.test(pumpBody),
      (pumpBody.match(/endpoint_pinned/g) || []).slice(0, 4));
    const laneStart = SRC.indexOf('function laneTakeableNow607(');
    const laneBody = laneStart >= 0 ? SRC.slice(laneStart, SRC.indexOf('\n  function ', laneStart + 10)) : '';
    ok('T-607 contract: the sticky-lane test is AVAILABILITY only — it never reads the model catalog, quality markers or model verdicts (capability was the dispatcher\'s question)',
      laneBody.length > 0 && !/endpointModelReason|modelFailures|qualityFlags|catalog/.test(laneBody)
      && /endpointSlotBusy\(fn, cand\)/.test(laneBody) && /hostAtCap\(/.test(laneBody),
      (laneBody.match(/endpointSlotBusy|hostAtCap|endpointModelReason|modelFailures/g) || []).slice(0, 6));
    ok('T-607 contract: the pump never offers a lane that is out of play or already claimed this pass',
      /function pumpSkipGroup\(/.test(SRC) && /cand\.out_of_play === true/.test(SRC) && /claimSkip\[cand\.primary \? PRIMARY_ENDPOINT_ID : cand\.id\]/.test(SRC),
      (SRC.match(/pumpSkipGroup|out_of_play === true|claimSkip\[/g) || []).slice(0, 6));
    const sqStart = SRC.indexOf('function startQueuedJob(');
    const sqTake = SRC.indexOf('takeQueueSlot(fn, job, ac)', sqStart);
    const afterTake = sqTake >= 0 ? SRC.slice(sqTake, sqTake + 400) : '';
    ok('T-607 contract: the usage clock is stamped right after the slot is taken — the ONE place a lane is really used — and not at placement',
      sqTake >= 0 && /stampEndpointUsed\(fn, endpointLaneId\(endpoint\)\);/.test(afterTake)
      && !/stampEndpointUsed/.test(SRC.slice(sqStart, sqTake)),
      { afterTake: afterTake.split('\n').slice(0, 3) });
    ok('T-607 contract: no new timer, no new poller, no new queue — the drain is still the completion-driven pump',
      allIntervals === 0 && !/CLAIM_|LANE_WAIT_MS|REPLACE_MS/.test(SRC),
      SRC.split('\n').filter(function (l) { return /CLAIM_|LANE_WAIT_MS|REPLACE_MS/.test(l); }).slice(0, 3));
  }

  // ==========================================================================
  // T-337 contract guards: the verdict is DATA. It is not read by placement.
  // ==========================================================================
  console.log('\n--- T-337 contract: no model affinity entered placement, no new ceiling ---');
  {
    const SRC = require('fs').readFileSync(LIB, 'utf8');
    const evStart = SRC.indexOf('function evaluateEndpoints(');
    const evBody = evStart >= 0 ? SRC.slice(evStart, SRC.indexOf('function ', evStart + 10)) : '';
    ok('T-337 contract: evaluateEndpoints never reads modelFailures (a verdict is not a capability bar)',
      evBody.length > 0 && !/modelFailures|modelFailureList|modelFailureReason/.test(evBody),
      (evBody.match(/modelFailures|modelFailureList/g) || []).slice(0, 3));
    const prStart = SRC.indexOf('function placementRank(');
    const prBody = prStart >= 0 ? SRC.slice(prStart, SRC.indexOf('function ', prStart + 10)) : '';
    ok('T-337 contract: placementRank never reads modelFailures (the documented "no model affinity" rule stands)',
      prBody.length > 0 && !/modelFailures|modelFailureList/.test(prBody),
      (prBody.match(/modelFailures/g) || []).slice(0, 3));
    ok('T-337 contract: no new ceiling constant and no new timer was introduced for a verdict',
      !/MODEL_FAIL_MAX_STREAK|FAILURE_TTL_MS|MODEL_BAN/.test(SRC),
      SRC.split('\n').filter(function (l) { return /MODEL_FAIL_MAX_STREAK|FAILURE_TTL_MS|MODEL_BAN/.test(l); }).slice(0, 3));
    const recStart = SRC.indexOf('function recordModelFailure(');
    const recBody = recStart >= 0 ? SRC.slice(recStart, SRC.indexOf('\n  function ', recStart + 10)) : '';
    ok('T-337 contract: the record touches no streak, no pause, no queue (the wedge rules are untouched)',
      recBody.length > 0 && !/wedgeStreak|failStreak|busyStreak|queues\[/.test(recBody),
      (recBody.match(/wedgeStreak|failStreak|busyStreak|queues\[/g) || []).slice(0, 4));
    ok('T-337 contract: the record fires only for the device_lost class (a socket death is not a model verdict)',
      /if \(devLostErr\) \{\s*recordModelFailure\(/.test(SRC),
      SRC.split('\n').filter(function (l) { return /recordModelFailure\(/.test(l); }).slice(0, 4));
  }

  // ==========================================================================
  // Contract guards: no new interval, no new recurring timer, no new poller.
  // ==========================================================================
  console.log('\n--- T-231/T-233 contract: no new interval, no new recurring timer ---');
  {
    const SRC = require('fs').readFileSync(LIB, 'utf8');
    ok('T-231 contract: lib/index.js contains no interval / polling loop (the drain stays completion-driven)',
      !/setInterval\(/.test(SRC) && !/timex\.interval\(/.test(SRC),
      SRC.split('\n').filter(function (l) { return /setInterval\(|timex\.interval\(/.test(l); }).slice(0, 3));
    ok('T-231 contract: every instance this suite built created ZERO host intervals',
      allIntervals === 0, allIntervals);
    const sqStart = SRC.indexOf('function startQueuedJob(');
    const sqTake = SRC.indexOf('takeQueueSlot(fn, job, ac)', sqStart);
    const sqBody = sqStart >= 0 && sqTake > sqStart ? SRC.slice(sqStart, sqTake) : '';
    ok('T-231 contract: the runner itself (startQueuedJob, the ONE place a slot is taken) enforces the endpoint slot — not only the placement helper',
      sqBody.length > 0 && /endpointHolderOf\(/.test(sqBody) && /endpoint_slot_wait/.test(sqBody),
      { hasStart: sqStart >= 0, mentions: (sqBody.match(/endpointHolderOf\(/g) || []).length });
    ok('T-231 contract: the drain is completion-driven — no new timer constant was introduced for an occupied endpoint',
      !/ENDPOINT_WAIT_RETRY_MS|SLOT_WAIT_RETRY_MS|ENDPOINT_SETTLE_MS/.test(SRC),
      SRC.split('\n').filter(function (l) { return /ENDPOINT_WAIT_RETRY_MS|SLOT_WAIT_RETRY_MS|ENDPOINT_SETTLE_MS/.test(l); }).slice(0, 3));
  }

  console.log('\n=== ' + pass + ' pass, ' + fail + ' fail ===');
  process.exitCode = fail ? 1 : 0;
})().catch(function (e) { console.log('HARNESS ERROR', e && e.stack); process.exitCode = 1; });
