// T-236 — the boot-window suite.
//
// The live fault (perf_log <home>/.dsh/deepamp-audio/perf_log.jsonl, read 2026-10-06):
//   ap-0112 moss_tts_local  cpu1.test:8963  attempt 1  ms 1283384  st error
//         err "curl exit 52: curl: (52) Empty reply from server"
//   ap-0113 moss_tts_local  cpu1.test:8963  attempt 3  ms 1368180  st error   (same err)
//   ap-0061 cosyvoice3      gpu1.test:8963   attempt 4  ms   94634  st error   (same err)
//         immediately followed by {"ev":"auto_pause","streak":2,"wedge_streak":2,...}
//   For contrast: "no error body" appears 24x and "curl exit 7" 15x, every one st:'retry'.
//
// Every engine unit in this fleet carries Restart=on-failure (gpu1 audio-cpp-vk.service /
// audio-cpp-vk2.service, RestartSec=15), so a crashed engine comes back by itself. During the
// restart plus the model load the port accepts a connection and answers EMPTY. Today that
// answer is not in the transient path, so it ends the retry loop, fails the row, and — because
// isWedgeLike matches "empty reply" — feeds the T-206 ceiling and auto-pauses the lane.
//
// Everything here runs against a STUBBED transport: no network, no engine, no real TTS, no
// real STT. The shell seam records every curl and never executes one.
//
// Run against another copy of the host with DEEPAMP_LIB=<path> to show these same
// assertions failing on a lib/index.js that does not have T-236.
const path = require('path');
  // T-744 (2026-11-07): the suite reads the renamed key first and the name it had before that
  // date after it, so an environment that still exports the old name points this run at the
  // copy it was meant to point at. The plugin itself follows the same order.
const LIB = process.env.DEEPAMP_LIB || process.env.AUDIO_PLAY_LIB || path.join(__dirname, '..', 'lib', 'index.js');
// (2026-11-18 private-data sweep, TODOS.md item 38) Not a mock path: the host loads its state from
  // the default store root it resolves from HOME at boot, so the seed key must be that same path.
const STATE = path.join(require('os').homedir(), '.dsh', 'deepamp-audio', 'state.json');

const T1 = 'http://10.0.0.10:8963';   // cpu1 TTS (the primary lane)
const T3 = 'http://10.0.0.14:8963';   // gpu1 TTS  (e-3, Vulkan)
const S1 = 'http://10.0.0.10:8962';   // cpu1 STT
const H3 = '10.0.0.14';
const WAV236 = '/tmp/t236_ref.wav';

// The exact live error string, byte for byte as perf_log recorded it.
const EMPTY52 = 'curl: (52) Empty reply from server';

// Counted across every instance this suite builds: the host must never create one.
let allIntervals = 0;
// Read off the host source so the suite bounds itself against the host's own numbers.
let SRC = '';
let BOOT_WINDOW_MAX_MS = 0;
let BOOT_WAIT_MAX_ARMS = 0;
let BOOT_MAX_PROBES = 0;
let SLOW_AVG_MS = 0;

const WIRE236 = { data: [
  { id: 'moss_ttsd', family: 'moss_ttsd', task: 'tts', mode: 'offline', path: '/mnt/llama/audio.cpp/moss.gguf', loaded: false },
  { id: 'qwen3-tts', family: 'qwen3_tts', task: 'tts', mode: 'offline', path: '/mnt/llama/audio.cpp/qwen3.gguf', loaded: false },
  { id: 'qwen3_asr', family: 'qwen3_asr', task: 'asr', mode: 'offline', path: '/mnt/llama/audio.cpp/asr.gguf', loaded: false },
] };

function ep(id, fn, url, models) {
  return {
    id: id, fn: fn, url: url, route: 'speech', enabled: true, batch_allowed: true, paused: false,
    models: models, models_source: 'operator', models_at: 1000, last_used_at: 0,
  };
}

function makeCtx(opts) {
  opts = opts || {};
  const held = [];
  const bag = {
    shellCalls: [], specs: [], fetchCalls: [], registered: [], fsMap: Object.assign({}, opts.fsSeed),
    hold: opts.hold !== false, holdFrom: 0, holdNext: 0,
    healthMode: opts.healthMode || 'ok', healthCalls: [], intervals: 0, timeouts: 0, timerMs: [],
    bootReplies: 0, slowEmptyMs: 0, connFail: false, failBody: null, uploads: [],
    engineCalls: 0, opts: opts,
  };
  bag.release = function () { const h = held.splice(0, held.length); h.forEach(function (f) { f(); }); };
  const emptyReply = function (sleepMs) {
    const wait = (sleepMs > 0)
      ? new Promise(function (r) { setTimeout(r, sleepMs); })
      : Promise.resolve();
    return wait.then(function () {
      return { exitCode: 52, stdout: { text: '' }, stderr: { text: EMPTY52 }, aborted: false };
    });
  };
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
      fetch: async function (req) { bag.fetchCalls.push(req.url); return { statusCode: 200, body: { content: '{}' } }; },
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

        // --- the /health leg: the ONLY probe the host is allowed to ask an endpoint ----
        if (/\/health'/.test(cmd)) {
          bag.healthCalls.push(cmd);
          if (bag.healthMode === 'down') {
            return { exitCode: 7, stdout: { text: '' }, aborted: false, stderr: { text: 'curl: (7) Failed to connect to 10.0.0.10 port 8963: Connection refused' } };
          }
          // The measured answer (GET http://cpu1.test:8963/health, 2026-10-05).
          return { exitCode: 0, aborted: false, stderr: { text: '' }, stdout: { text: '{"status":"ok","backend":"cpu","models":45,"ui":true,"ui_management":true}\n200' } };
        }

        // --- the engine legs -----------------------------------------------------------
        if (/\/v1\/audio\/(speech|transcriptions)/.test(cmd) && /curl/.test(cmd)) {
          bag.engineCalls += 1;
          // T-245 seam (only when a test asks for the session-identity engine): a path the
          // request names that is not inside the CURRENT session root is a file this engine
          // process never wrote, and src/framework/audio/wav_reader.cpp:412 answers with its own
          // words — HTTP 500 {"error":{"message":"could not open WAV input: <path>"}} — which
          // this curl (-o <out>.part) writes INSIDE the .part, where sweepPart/capturePartBody
          // reads it. That is the route the live 2026-10-07 gpu1 failure took.
          // opts.enginePoison answers that way for EVERY staged path: how the retry is proven
          // to stop after ONE re-stage.
          if (opts.engineSession && /\/v1\/audio\/speech/.test(cmd)) {
            let esBody = {};
            try { esBody = JSON.parse(String(spec.stdin || '{}')); } catch (e) { esBody = {}; }
            const esPaths = [];
            if (esBody.voice_ref && typeof esBody.voice_ref === 'object' && esBody.voice_ref.path) esPaths.push(String(esBody.voice_ref.path));
            else if (typeof esBody.voice_ref === 'string') esPaths.push(esBody.voice_ref);
            if (esBody.options && typeof esBody.options.voice_samples === 'string') {
              esBody.options.voice_samples.split(',').forEach(function (x) { if (x.trim()) esPaths.push(x.trim()); });
            }
            const esDir = function (p) { const i = String(p).lastIndexOf('/'); return i > 0 ? String(p).slice(0, i) : ''; };
            const esOut = / -o '([^']+)'/.exec(cmd);
            const esStale = esPaths.filter(function (p) { return opts.enginePoison || esDir(p) !== opts.engineSession.dir; });
            if (esStale.length) {
              const esJson = JSON.stringify({ error: { message: 'could not open WAV input: ' + esStale[0], type: 'server_error' } });
              if (esOut) bag.fsMap[esOut[1]] = esJson;
              return { exitCode: 22, stdout: { text: '' }, aborted: false, stderr: { text: 'curl: (22) The requested URL returned error: 500' } };
            }
            if (esOut) bag.fsMap[esOut[1]] = 'RIFFfakewavbytes';
            return { exitCode: 0, stdout: { text: JSON.stringify({ audio: 'AAAA' }) }, stderr: { text: '' }, aborted: false };
          }
          if (bag.connFail) {
            return { exitCode: 7, stdout: { text: '' }, aborted: false, stderr: { text: 'curl: (7) Failed to connect to host 10.0.0.10 port 8963: Could not connect to server' } };
          }
          if (bag.slowEmptyMs > 0) {
            const ms = bag.slowEmptyMs; bag.slowEmptyMs = 0;
            return emptyReply(ms);
          }
          if (bag.bootReplies > 0) {
            bag.bootReplies -= 1;
            return emptyReply(0);
          }
          if (bag.failBody) {
            const pf = / -o '([^']+)'\.part'/.exec(cmd);
            if (pf) bag.fsMap[pf[1] + '.part'] = bag.failBody;
            return { exitCode: 22, stdout: { text: bag.failBody }, stderr: { text: 'curl: (22) The requested URL returned error: 500' }, aborted: false };
          }
          if (bag.holdNext > 0) {
            bag.holdNext -= 1;
            return new Promise(function (res) {
              held.push(function () { res({ exitCode: 0, stdout: { text: JSON.stringify({ audio: 'AAAA' }) }, stderr: { text: '' }, aborted: false }); });
            });
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

        // --- the T-217 stage leg: POST <endpoint>/v1/ui/upload --------------------------
        // T-245 seam (first, and only when a test asks for it): the same leg with a SESSION
        // IDENTITY. opts.engineSession is a live object {dir, n}: `dir` is the engine's upload
        // root — temp_directory_path()/("audiocpp-ui-" + microseconds of that process's start)
        // (app/server/runtime.cpp:961-965), remove_all'd by ~ServerState (runtime.cpp:1006-1008).
        // Changing `dir` between two renders IS the restart: no probe, no poller, no signal in
        // this suite. The answer is the shape handle_ui_upload really answers
        // (runtime.cpp:1330-1337): {"path":"<upload_root>/<upload id>-<filename>","bytes":N}.
        if (opts.engineSession && /\/v1\/ui\/upload/.test(cmd)) {
          const esFn = /X-Audiocpp-Filename: '?([^'\s]+)'?/.exec(cmd) || /'([^']+\.wav)'/.exec(cmd);
          const esS = opts.engineSession;
          esS.total = (esS.total || 0) + 1;
          // T-253 seam: opts.restarts = [{at, to}] - this engine process DIES after the `at`-th
          // upload leg it receives (1-based) and systemd starts a new one with a NEW upload root.
          // Still no probe, no poller, no signal: a field of the stub changes between two legs of
          // ONE take, which is exactly what the plugin cannot see until it looks at the paths its
          // own cast is holding. Inactive unless a test supplies it.
          const rs253 = (opts.restarts || []).filter(function (x) { return !x.done && x.at === esS.total; })[0];
          if (rs253) { rs253.done = true; esS.dir = rs253.to; esS.n = 0; }
          esS.n = (esS.n || 0) + 1;
          const esPath = esS.dir + '/' + esS.n + '-' + (esFn ? esFn[1] : 'input.wav');
          bag.uploads.push({
            url: (/'(https?:\/\/[^']+)\/v1\/ui\/upload'/.exec(cmd) || [])[1] || '',
            filename: esFn ? esFn[1] : '', path: esPath, root: esS.dir,
          });
          return { exitCode: 0, stdout: { text: JSON.stringify({ path: esPath, bytes: 4096 }) }, stderr: { text: '' }, aborted: false };
        }
        // T-245 seam: capturePartBody's legs (`stat -c %s <part>`, `head -c 200 <part>`) read the
        // .part a 500 wrote — where the engine's sentence lives on this curl. Active only for the
        // session-identity engine, so every pre-existing test answers exactly as before.
        if (opts.engineSession && /^head -c /.test(cmd)) {
          const hp = /'([^']+)'/.exec(cmd);
          const key = hp ? hp[1] : '';
          if (key && bag.fsMap[key] !== undefined) return { exitCode: 0, stdout: { text: String(bag.fsMap[key]) }, stderr: { text: '' }, aborted: false };
        }
        if (opts.engineSession && /^stat -c %s /.test(cmd)) {
          const sp = /stat -c %s '([^']+)'/.exec(cmd);
          const key = sp ? sp[1] : '';
          if (key && bag.fsMap[key] !== undefined) return { exitCode: 0, stdout: { text: String(String(bag.fsMap[key]).length) }, stderr: { text: '' }, aborted: false };
          return { exitCode: 0, stdout: { text: '4096' }, stderr: { text: '' }, aborted: false };
        }
        if (/\/v1\/ui\/upload/.test(cmd)) {
          const fn1 = /X-Audiocpp-Filename: '?([^'\s]+)'?/.exec(cmd) || /'([^']+\.wav)'/.exec(cmd);
          bag.uploads.push({ url: (/'(https?:\/\/[^']+)\/v1\/ui\/upload'/.exec(cmd) || [])[1] || '', filename: fn1 ? fn1[1] : '' });
          return { exitCode: 0, stdout: { text: JSON.stringify({ path: '/tmp/upload/1-test.wav', bytes: 4 }) }, stderr: { text: '' }, aborted: false };
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
  SRC = require('fs').readFileSync(LIB, 'utf8');
  const num = function (name) {
    const m = new RegExp('var\\s+' + name + '\\s*=\\s*(\\d+)').exec(SRC);
    return m ? parseInt(m[1], 10) : 0;
  };
  BOOT_WINDOW_MAX_MS = num('BOOT_WINDOW_MAX_MS');
  BOOT_WAIT_MAX_ARMS = num('BOOT_WAIT_MAX_ARMS');
  BOOT_MAX_PROBES = num('BOOT_MAX_PROBES');
  SLOW_AVG_MS = num('SLOW_AVG_MS');

  const mod = await import('file://' + LIB);
  let pass = 0, fail = 0;
  function ok(label, cond, extra) {
    if (cond) { pass++; console.log('  PASS  ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 320) : '')); }
  }

  const mk = function (opts) {
    opts = opts || {};
    const seed = {
      version: 3,
      endpoints: {
        tts: { url: (opts.ttsUrl === undefined ? T1 : opts.ttsUrl), route: 'speech' },
        stt: { url: (opts.sttUrl === undefined ? S1 : opts.sttUrl), route: 'speech' },
      },
      counter: 1, playlist: [],
      voices: opts.voices || {},
    };
    seed.endpoint_registry = opts.registry || { tts: [], stt: [] };
    const ctx = makeCtx({
      modelsPayload: WIRE236, fastTimers: opts.fastTimers, hold: opts.hold,
      healthMode: opts.healthMode,
      engineSession: opts.engineSession, enginePoison: opts.enginePoison, restarts: opts.restarts,
      fsSeed: Object.assign({ [STATE]: opts.rawSeed !== undefined ? opts.rawSeed : JSON.stringify(seed), [WAV236]: 'RIFFfake' }, opts.fsSeed || {}),
    });
    mod.apply(ctx.ctx || ctx);
    const bag = ctx.bag;
    bag.api = bag.registered.find(function (x) { return x.path === '/api/deepamp'; }).handler;
    return bag;
  };
  const J = function (res) { return JSON.parse(res.body); };
  const tts = async function (c, body) { return J(await call(c.api, '/api/deepamp/dispatch_tts', 'POST', Object.assign({ fn: 'tts', model: 'moss_ttsd' }, body))); };
  const stt = async function (c, body) { return J(await call(c.api, '/api/deepamp/dispatch_stt', 'POST', Object.assign({ fn: 'stt', model: 'qwen3_asr', file_path: WAV236 }, body))); };
  const row = async function (c, id) { return J(await call(c.api, '/api/deepamp/job_status?job_id=' + encodeURIComponent(id), 'GET')); };
  const qs = async function (c) { return J(await call(c.api, '/api/deepamp/queue_status', 'GET')); };
  const engineUrls = function (c) {
    return c.shellCalls.filter(function (x) { return /\/v1\/audio\/(speech|transcriptions)/.test(x); })
      .map(function (x) { return (/'(https?:\/\/[^']+)\/v1\/audio/.exec(x) || [])[1] || ''; });
  };
  const evCount = function (c, ev) {
    return c.shellCalls.filter(function (x) { return x.indexOf('"ev":"' + ev + '"') >= 0; }).length;
  };
  const evLines = function (c, ev) {
    return c.shellCalls.filter(function (x) { return x.indexOf('"ev":"' + ev + '"') >= 0; });
  };

  // ==========================================================================
  // A — the live fault: an endpoint that answers EMPTY on the first attempt and
  //     is healthy afterwards. Today the row ends in 'error'.
  // ==========================================================================
  console.log('\n--- T-236 (a): a fast empty reply is a boot-window wait, not a failed row ---');
  {
    const c = mk({ hold: false });
    await tick(40);
    c.bootReplies = 1;          // attempt 1: curl exit 52 / Empty reply from server
    c.holdNext = 1;             // attempt 2: held, so the row can be READ while it waits
    const d = await tts(c, { text: 'the engine was still coming back' });
    await tick(120);
    const mid = await row(c, d.job_id);
    ok('T-236 (a): the row that met a fast empty reply is RETRYING, not failed',
      mid.status === 'running' && !mid.error, { st: mid.status, err: mid.error });
    ok('T-236 (a): the row says what it is waiting for (activity waiting_engine_boot, not waiting_busy)',
      mid.activity === 'waiting_engine_boot', mid.activity);
    c.release();
    await tick(250);
    const after = await row(c, d.job_id);
    const urls = engineUrls(c);
    ok('T-236 (a): the row SURVIVES — it ends ok, not error (ap-0112 / ap-0113 / ap-0061 today end in error)',
      after.status === 'ok' && !after.error, { st: after.status, err: after.error });
    ok('T-236 (a): the retry really re-sent the request to the SAME endpoint',
      urls.length === 2 && urls[0] === T1 && urls[1] === T1, urls);
    ok('T-236 (a): the boot-window decision is recorded as its OWN perf event (engine_boot)',
      evCount(c, 'engine_boot') === 1, evLines(c, 'engine_boot').map(function (x) { return x.slice(0, 200); }));
    ok('T-236 (a): the attempt that died is logged st:"retry", never st:"error" (today it is error)',
      c.shellCalls.some(function (x) { return /"ev":"synth"/.test(x) && /"attempt":1/.test(x) && /"st":"retry"/.test(x) && /curl exit 52/.test(x); }),
      c.shellCalls.filter(function (x) { return /"ev":"synth"/.test(x); }).map(function (x) { return x.slice(0, 220); }));
    ok('T-236 (a): a boot-window retry logged no auto_pause and left the lane unpaused',
      evCount(c, 'auto_pause') === 0, evLines(c, 'auto_pause'));
    const q = await qs(c);
    ok('T-236 (a): the lane is not paused and carries no auto_pause reason',
      q.queues.tts.paused === false && q.queues.tts.auto_paused === '', q.queues.tts);
    ok('T-236 (a): the engine_boot event names the ceiling it was measured against',
      c.shellCalls.some(function (x) { return /"ev":"engine_boot"/.test(x) && /"ceiling_ms":\d+/.test(x); }),
      evLines(c, 'engine_boot').map(function (x) { return x.slice(0, 240); }));
  }

  // ==========================================================================
  // B — the wedge ceiling. Today a fast empty reply IS wedge evidence
  // (isWedgeLike matches "empty reply"), so two of them auto-pause the lane —
  // exactly the ap-0061 `auto_pause` record with wedge_streak 2.
  // ==========================================================================
  console.log('\n--- T-236 (b): a boot-window failure does not feed the T-206 ceiling ---');
  {
    const c = mk({ hold: false });
    await tick(40);
    c.bootReplies = 1;
    const d1 = await tts(c, { text: 'first row met a booting engine' });
    await tick(250);
    c.bootReplies = 1;
    const d2 = await tts(c, { text: 'second row met a booting engine' });
    await tick(250);
    const r1 = await row(c, d1.job_id);
    const r2 = await row(c, d2.job_id);
    ok('T-236 (b): both rows that met a fast empty reply survive (today the second one auto-pauses the lane)',
      r1.status === 'ok' && r2.status === 'ok', { r1: r1.status, r2: r2.status });
    const q = await qs(c);
    ok('T-236 (b): neither row advanced the wedge ceiling — the lane is UNPAUSED with no reason',
      q.queues.tts.paused === false && q.queues.tts.auto_paused === '', q.queues.tts);
    ok('T-236 (b): no auto_pause was ever logged (today this pair logs one, as ap-0061 did)',
      evCount(c, 'auto_pause') === 0, evLines(c, 'auto_pause'));
  }
  {
    // A row that really does exhaust its attempts on fast empty replies still FAILS — the
    // boot window is a wait, not a pardon — but it takes NO wedge credit and says so.
    const c = mk({ hold: false });
    await tick(40);
    c.bootReplies = 4;
    const d = await tts(c, { text: 'the engine never came back' });
    await tick(400);
    const r = await row(c, d.job_id);
    ok('T-236 (b): a row that exhausts ENGINE_TRIES on fast empty replies still ends in error',
      r.status === 'error' && /curl exit 52/.test(r.error || ''), { st: r.status, err: r.error });
    ok('T-236 (b): the exhausted boot window is its own perf event and says it took NO wedge credit',
      c.shellCalls.some(function (x) { return /"ev":"engine_boot_exhausted"/.test(x) && /"wedge_credit":false/.test(x); }),
      evLines(c, 'engine_boot_exhausted').map(function (x) { return x.slice(0, 240); }));
    ok('T-207 (engine_boot): the row that exhausted its boot window writes ONE job_outcome carrying the class the host already computed — cls boot_window, not a blank failure',
      evCount(c, 'job_outcome') === 1
      && /"cls":"boot_window"/.test(evLines(c, 'job_outcome')[0] || '')
      && /"st":"error"/.test(evLines(c, 'job_outcome')[0] || '')
      && new RegExp('"job":"' + d.job_id + '"').test(evLines(c, 'job_outcome')[0] || ''),
      evLines(c, 'job_outcome').map(function (x) { return x.slice(0, 240); }));
    const q = await qs(c);
    ok('T-236 (b): one exhausted boot window does not pause the lane',
      q.queues.tts.paused === false && q.queues.tts.auto_paused === '', q.queues.tts);
  }

  // ==========================================================================
  // C — the other half of the rule: a SLOW empty reply (ap-0061 died at 94 s,
  // ap-0112/0113 at 1283 s / 1368 s) stays a real transport failure and keeps
  // its wedge behaviour. Do not paper over a dying engine.
  // ==========================================================================
  console.log('\n--- T-236 (c): a slow empty reply is still a real failure and still wedge evidence ---');
  {
    const c = mk({ hold: false });
    await tick(40);
    // Longer than BOOT_WINDOW_MAX_MS, so the attempt is outside the boot window.
    c.slowEmptyMs = BOOT_WINDOW_MAX_MS + 1500;
    const d1 = await tts(c, { text: 'the engine died mid-render' });
    await tick(BOOT_WINDOW_MAX_MS + 3000);
    const r1 = await row(c, d1.job_id);
    ok('T-236 (c): a slow empty reply still ends the row in error (it is NOT turned into a wait)',
      r1.status === 'error' && /curl exit 52/.test(r1.error || ''), { st: r1.status, err: r1.error });
    ok('T-236 (c): a slow empty reply is NOT classified as a boot window (no engine_boot event, no engine_boot_exhausted)',
      evCount(c, 'engine_boot') === 0 && evCount(c, 'engine_boot_exhausted') === 0,
      { boot: evCount(c, 'engine_boot'), exhausted: evCount(c, 'engine_boot_exhausted') });
    ok('T-236 (c): a slow empty reply sent ONE attempt only — it was not retried as a boot window',
      engineUrls(c).length === 1, engineUrls(c));
    // Its wedge standing: the NEXT connection-style failure completes the pair and pauses.
    c.connFail = true;
    const d2 = await tts(c, { text: 'a connection failure after the slow death' });
    await tick(400);
    const r2 = await row(c, d2.job_id);
    const q = await qs(c);
    ok('T-236 (c): the slow empty reply kept its wedge standing — the pair pauses the lane',
      r2.status === 'error' && q.queues.tts.paused === true && /connection failures/.test(q.queues.tts.auto_paused || ''),
      { st: r2.status, paused: q.queues.tts.paused, reason: q.queues.tts.auto_paused });
    ok('T-236 (c): the pause is logged as an auto_pause, exactly as ap-0061 was',
      evCount(c, 'auto_pause') === 1, evLines(c, 'auto_pause'));
    ok('T-207 (engine_boot): both failed rows of the wedge pair write their own job_outcome, each naming the class the host already computed (wedge_like) — the row that paused the lane is no longer invisible',
      evCount(c, 'job_outcome') === 2
      && new RegExp('"job":"' + d1.job_id + '","fn":"tts"[^}]*"cls":"wedge_like"').test(evLines(c, 'job_outcome').join('\n'))
      && new RegExp('"job":"' + d2.job_id + '"[^}]*"cls":"wedge_like"').test(evLines(c, 'job_outcome').join('\n')),
      evLines(c, 'job_outcome').map(function (x) { return x.slice(0, 200); }));
  }

  // ==========================================================================
  // D — pre-flight admission: do not start a curl that is known to die.
  // ==========================================================================
  console.log('\n--- T-236 (d): an endpoint not known serving parks the row instead of burning it ---');
  {
    const c = mk({ hold: false, healthMode: 'down' });
    await tick(40);
    // The plugin WATCHES the endpoint go down (the existing on-demand probe).
    const h = J(await call(c.api, '/api/deepamp/endpoint_health', 'POST', { fn: 'tts', id: 'primary' }));
    await tick(60);
    ok('T-236 (d): setup — the on-demand probe found the primary endpoint not serving',
      h.ok === true && h.endpoints[0].online === false, h.endpoints && h.endpoints[0]);
    const d = await tts(c, { text: 'this row must not spend a curl on a down endpoint' });
    await tick(120);
    const r = await row(c, d.job_id);
    ok('T-236 (d): the row is PARKED, not started — no speech request was ever sent (today it is sent and dies)',
      r.status === 'queued' && !r.error && engineUrls(c).length === 0,
      { st: r.status, err: r.error, urls: engineUrls(c) });
    ok('T-236 (d): the dispatch response names the wait (endpoint_boot_wait, reason offline)',
      !!d.endpoint_boot_wait && d.endpoint_boot_wait.reason === 'offline'
      && d.endpoint_boot_wait.url === T1 && d.endpoint_boot_wait.id === 'primary',
      d.endpoint_boot_wait);
    ok('T-236 (d): job_status names the same wait, in the style of endpoint_slot_wait',
      !!r.endpoint_boot_wait && r.endpoint_boot_wait.url === T1 && r.endpoint_boot_wait.id === 'primary'
      && ['offline', 'probing', 'stale', 'unknown', 'in_flight'].indexOf(r.endpoint_boot_wait.reason) >= 0,
      r.endpoint_boot_wait);
    const q = await qs(c);
    ok('T-236 (d): a park is not a failure — the lane is not paused, nothing auto-paused, no wedge evidence',
      q.queues.tts.paused === false && q.queues.tts.auto_paused === '' && evCount(c, 'auto_pause') === 0,
      { paused: q.queues.tts.paused, auto: q.queues.tts.auto_paused });
    ok('T-236 (d): the wait is its own key, not a machine_wait and not an endpoint_slot_wait',
      !r.machine_wait && !r.endpoint_slot_wait, { machine_wait: r.machine_wait, slot: r.endpoint_slot_wait });
    // Three more rows pile up behind it: ONE probe per endpoint, not one per row.
    await tts(c, { text: 'queued behind it two' });
    await tts(c, { text: 'queued behind it three' });
    await tick(200);
    const probes = c.healthCalls.length;
    ok('T-236 (d): the pre-flight fired at least one /health probe and no more than the bounded budget (today: zero probes)',
      probes >= 1 && probes <= 1 + BOOT_MAX_PROBES, { probes: probes, cap: 1 + BOOT_MAX_PROBES });
    ok('T-236 (d): the pre-flight is the EXISTING /health leg only — same 5 s curl cap, never /status',
      c.healthCalls.every(function (x) { return x.indexOf("curl -sS -m 5 -w '\\n%{http_code}' ") === 0 && /'https?:\/\/[^']+\/health'$/.test(x); })
      && !c.shellCalls.some(function (x) { return /\/status'/.test(x); }),
      c.healthCalls.slice(0, 2));
    ok('T-236 (d): the drain is a bounded one-shot re-check — at most BOOT_WAIT_MAX_ARMS timers, and ZERO intervals',
      c.intervals === 0 && c.timerMs.filter(function (ms) { return ms === 15000; }).length >= 1
      && c.timerMs.filter(function (ms) { return ms === 15000; }).length <= BOOT_WAIT_MAX_ARMS,
      { intervals: c.intervals, arms: c.timerMs.filter(function (ms) { return ms === 15000; }).length, all: c.timerMs });
    const rows = [];
    for (const id of [d.job_id]) rows.push(await row(c, id));
    const q2 = await qs(c);
    ok('T-236 (d): the parked rows are still QUEUED and still named — nothing was lost or failed',
      rows[0].status === 'queued' && !!rows[0].endpoint_boot_wait && q2.queues.tts.queued >= 1,
      { st: rows[0].status, queued: q2.queues.tts.queued });

    // The engine comes back (Restart=on-failure did its job). The parked row is admitted.
    c.healthMode = 'ok';
    const back = J(await call(c.api, '/api/deepamp/endpoint_health', 'POST', { fn: 'tts', id: 'primary' }));
    await tick(250);
    const after = await row(c, d.job_id);
    ok('T-236 (d): when the endpoint answers again the parked row is admitted and renders',
      back.endpoints[0].online === true && (after.status === 'ok' || after.status === 'running')
      && engineUrls(c).length >= 1, { online: back.endpoints[0].online, st: after.status, urls: engineUrls(c) });
    ok('T-236 (d): the recovery is its own perf event, so an analysis can see the restart',
      evCount(c, 'endpoint_recovered') === 1, evLines(c, 'endpoint_recovered'));
    ok('T-236 (d): the admitted row no longer carries the wait key',
      !after.endpoint_boot_wait, after.endpoint_boot_wait);
  }
  {
    // Never probe while a request is in flight on that endpoint. Two lanes, ONE engine URL:
    // a TTS render is live on it while an STT row wants the same box.
    const c = mk({ hold: false, ttsUrl: T3, sttUrl: T3 });
    await tick(40);
    // 4 attempts on /v1/audio/transcriptions/details, then the existing fallback leg
    // retries 4 more on /v1/audio/transcriptions. Both have to meet the booting engine.
    c.bootReplies = 8;
    const s1 = await stt(c, {});
    await tick(400);
    const s1row = await row(c, s1.job_id);
    ok('T-236 (d): setup — the STT lane exhausted its attempts against the booting engine (doubt recorded)',
      s1row.status === 'error' && /curl exit 52/.test(s1row.error || '') && evCount(c, 'endpoint_doubt') === 1,
      { st: s1row.status, err: s1row.error, doubt: evCount(c, 'endpoint_doubt') });
    const probesAfterDoubt = c.healthCalls.length;
    c.holdNext = 1;                          // a TTS render is now LIVE on that same engine
    const t1 = await tts(c, { text: 'a render is now in flight on this engine' });
    await tick(120);
    const t1row = await row(c, t1.job_id);
    // dispatch_stt resolves when ITS row finishes, so it must not be awaited here: the row
    // is parked. Fire it and read the row out of the queue instead.
    const s2p = call(c.api, '/api/deepamp/dispatch_stt', 'POST', { fn: 'stt', model: 'qwen3_asr', file_path: WAV236 });
    await tick(120);
    const queued236 = (J(await call(c.api, '/api/deepamp/playlist_list?page_size=20', 'GET')).items || [])
      .filter(function (j) { return j.fn === 'stt' && j.status === 'queued'; });
    const s2row = queued236[0] || null;
    ok('T-236 (d): the second STT row is parked, not started, while a request is in flight on that endpoint',
      !!s2row && s2row.status === 'queued' && !!s2row.endpoint_boot_wait, { row: s2row });
    ok('T-236 (d): the park names in_flight and NO probe was fired under the live request (today the row renders)',
      !!s2row && !!s2row.endpoint_boot_wait && s2row.endpoint_boot_wait.reason === 'in_flight'
      && c.healthCalls.length === probesAfterDoubt && t1row.status === 'running',
      { reason: s2row && s2row.endpoint_boot_wait && s2row.endpoint_boot_wait.reason, probes: c.healthCalls.length, fired: probesAfterDoubt, tts: t1row.status });
    c.release();
    await tick(300);
  }

  // ==========================================================================
  // E — the T-217 staleness gap. A staged clone sample lives in the engine's
  // scratch dir, which the engine remove_all-s at shutdown. A boot-window retry
  // PROVES that engine restarted, so the staged path is gone.
  // ==========================================================================
  console.log('\n--- T-236 (e): a boot-window retry invalidates the staged clone cache (T-217 gap) ---');
  {
    const voices = {
      kirk: { ref_text: 'the reference line', ref_wav: WAV236, remote_wav: '', remote_host: '', created: 111, source: 'test', ref_dur_s: 4 },
    };
    const c = mk({ hold: false, voices: voices });
    await tick(40);
    await call(c.api, '/api/deepamp/get_models?fn=tts', 'GET');
    await tick(60);
    await tts(c, { model: 'qwen3-tts', voice: 'kirk', text: 'first clone stages the sample' });
    await tick(250);
    ok('T-236 (e): setup — the clone staged its sample on the endpoint that rendered it',
      c.uploads.length === 1 && c.uploads[0].url === T1, c.uploads);
    await tts(c, { model: 'qwen3-tts', voice: 'kirk', text: 'second clone reuses the staged path' });
    await tick(120);
    c.bootReplies = 1;   // the engine restarts mid-way through this take
    await tts(c, { model: 'qwen3-tts', voice: 'kirk', text: 'the engine restarted during this take' });
    await tick(300);
    ok('T-236 (e): the boot-window retry DROPPED the staged cache for that endpoint (today the path survives a restart)',
      evCount(c, 'voice_stage_drop') === 1 && /boot-window/.test(evLines(c, 'voice_stage_drop')[0] || ''),
      evLines(c, 'voice_stage_drop').map(function (x) { return x.slice(0, 240); }));
    await tts(c, { model: 'qwen3-tts', voice: 'kirk', text: 'third clone must re-upload' });
    await tick(300);
    ok('T-236 (e): the next clone RE-UPLOADED instead of reusing a scratch path the restart removed',
      c.uploads.length === 2 && c.uploads[1].url === T1, c.uploads);
  }

  // ==========================================================================
  // T-234a — A DEVICE-LOST 500 IS NOT A BOOT-WINDOW WAIT.
  // The natural fault (perf_log, 2026-10-07): ap-0016 (298 867 ms) and ap-0017 (17 s) on e-3
  // answered `curl exit 22 ... 500 | body: vk::Queue::submit: ErrorDeviceLost` while
  // audio-cpp-vk.service stayed active/running (NRestarts=0), /health kept answering 200 and
  // endpoint_registry kept e-3 online:true paused:false. An empty reply means "the port is up and
  // the engine is still coming back". A device-lost body means "the engine is up and its GPU is
  // gone". The first is a wait; the second is an endpoint failure, and it takes wedge credit.
  // ==========================================================================
  console.log('\n--- T-234a: a device-lost 500 gets no boot-window treatment and takes full wedge credit ---');
  {
    const DEV234 = JSON.stringify({ error: { message: 'vk::Queue::submit: ErrorDeviceLost', type: 'server_error' } });
    const c = mk({ hold: false });
    await tick(40);
    c.failBody = DEV234;
    const d1 = await tts(c, { text: 'the vulkan device is lost (1)' });
    await tick(150);
    const r1 = await row(c, d1.job_id);
    ok('T-234a (a): a device-lost 500 FAILS the row at once — no boot-window retry (one engine call, not ENGINE_TRIES)',
      r1.status === 'error' && engineUrls(c).length === 1, { st: r1.status, calls: engineUrls(c).length });
    ok('T-234a (a): a device-lost failure wrote NO boot-window event (engine_boot / engine_boot_exhausted belong to an engine that is coming back)',
      evCount(c, 'engine_boot') === 0 && evCount(c, 'engine_boot_exhausted') === 0,
      { engine_boot: evCount(c, 'engine_boot'), exhausted: evCount(c, 'engine_boot_exhausted') });
    ok('T-234a (a): the row never claimed it was waiting for a booting engine (no waiting_engine_boot anywhere in the run)',
      !c.shellCalls.some(function (x) { return /waiting_engine_boot/.test(x); }) && r1.activity !== 'waiting_engine_boot',
      { activity: r1.activity });
    await tts(c, { text: 'the vulkan device is lost (2)' });
    await tick(150);
    const q = await qs(c);
    ok('T-234a (a): two consecutive device-lost failures TAKE THE WEDGE CREDIT and pause the lane on strike 2 — where two fast empty replies pause on no strike at all (T-236 (b))',
      q.queues.tts.paused === true && /endpoint is down or wedged/.test(q.queues.tts.auto_paused || ''), q.queues.tts);
    ok('T-234a (a): the pause record names it endpoint evidence (conn:true) and the outcome record names the class (cls device_lost)',
      evLines(c, 'auto_pause').some(function (x) { return /"conn":true/.test(x); })
      && evLines(c, 'job_outcome').some(function (x) { return /"cls":"device_lost"/.test(x); }),
      { pause: evLines(c, 'auto_pause').map(function (x) { return x.slice(0, 150); }) });
    c.release();
  }

  // ==========================================================================
  // Contract guards.
  // ==========================================================================
  console.log('\n--- T-236 contract: threshold, ordering, no poller, no renamed key ---');
  {
    ok('T-236 contract: BOOT_WINDOW_MAX_MS exists and is BELOW SLOW_AVG_MS, so a boot-window attempt can never read as a slow pair',
      BOOT_WINDOW_MAX_MS > 0 && SLOW_AVG_MS > 0 && BOOT_WINDOW_MAX_MS < SLOW_AVG_MS,
      { BOOT_WINDOW_MAX_MS: BOOT_WINDOW_MAX_MS, SLOW_AVG_MS: SLOW_AVG_MS });
    ok('T-236 contract: the threshold sits far under the slowest real death on record (94634 ms, ap-0061)',
      BOOT_WINDOW_MAX_MS > 0 && 94634 > 5 * BOOT_WINDOW_MAX_MS, { BOOT_WINDOW_MAX_MS: BOOT_WINDOW_MAX_MS });
    // Window re-cut 2026-11-09 (T-765): this contract read a fixed 4 000-character slice from the start of
    // runEngine, and card T-765's comment above the wall recognition pushed the classifier calls past that line.
    // The ORDER it guards is unchanged; the window was an artifact of it. The contract is now stated over the whole
    // function body, which is what it was always meant to say.
    const reStart = SRC.indexOf('function runEngine(');
    const reSrc = SRC.slice(reStart, SRC.indexOf('\n  function ', reStart + 1));
    ok('T-236 contract: runEngine consults isWedgeLike BEFORE the boot-window classification',
      reSrc.indexOf('isWedgeLike(err)') >= 0 && reSrc.indexOf('isWedgeLike(err)') < reSrc.indexOf('isBootWindowEmptyReply(err'),
      { wedge: reSrc.indexOf('isWedgeLike(err)'), boot: reSrc.indexOf('isBootWindowEmptyReply(err') });
    const sqSrc = SRC.slice(SRC.indexOf('function startQueuedJob('), SRC.indexOf('function runEngine('));
    ok('T-236 contract: the wedge guard consults isWedgeLike(job.error) BEFORE the boot-window classification',
      sqSrc.indexOf('isWedgeLike(job.error)') >= 0 && sqSrc.indexOf('isWedgeLike(job.error)') < sqSrc.indexOf('isBootWindowEmptyReply(job.error'),
      { wedge: sqSrc.indexOf('isWedgeLike(job.error)'), boot: sqSrc.indexOf('isBootWindowEmptyReply(job.error') });
    ok('T-236 contract: isCapabilityRejection and isBusyRejection still check isWedgeLike first',
      /function isCapabilityRejection\(msg\) \{\s*var s = String\(msg \|\| ''\);\s*if \(!s \|\| isWedgeLike\(s\)\) return false;/.test(SRC)
      && /function isBusyRejection\(msg\) \{\s*var s = String\(msg \|\| ''\);\s*if \(!s \|\| isWedgeLike\(s\)\) return false;/.test(SRC),
      null);
    ok('T-236 contract: the transient regex is UNCHANGED (50[234] and no error body|curl exit 7|curl exit null)',
      /function isTransientEngineError\(msg\) \{\s*var m = String\(msg \|\| ''\);\s*return \/50\[234\]\/\.test\(m\) \|\| \/no error body\|curl exit 7\\b\|curl exit null\/i\.test\(m\);\s*\}/.test(SRC),
      null);
    ok('T-236 contract: the wedge reason strings are UNCHANGED (T-129/T-206 wording survives)',
      /connection failures/.test(SRC) && /endpoint is down or wedged/.test(SRC) && /2 slow failures/.test(SRC)
      && /consecutive endpoint failures/.test(SRC) && /consecutive BUSY rejections/.test(SRC),
      null);
    ok('T-236 contract: lib/index.js contains no interval / polling loop (the drain stays completion-driven)',
      !/setInterval\(/.test(SRC) && !/timex\.interval\(/.test(SRC),
      SRC.split('\n').filter(function (l) { return /setInterval\(|timex\.interval\(/.test(l); }).slice(0, 3));
    ok('T-236 contract: every instance this suite built created ZERO host intervals',
      allIntervals === 0, allIntervals);
    ok('T-236 contract: the health leg is /health only — the host never probes /status',
      /var ENDPOINT_HEALTH_PATH = '\/health';/.test(SRC) && !/sq\(url \+ '\/status'\)/.test(SRC),
      null);
    ok('T-236 contract: no new recurring-timer constant was introduced for the boot gate (one-shot only)',
      !/ENDPOINT_WAIT_RETRY_MS|SLOT_WAIT_RETRY_MS|ENDPOINT_SETTLE_MS|BOOT_WAIT_INTERVAL/.test(SRC),
      SRC.split('\n').filter(function (l) { return /ENDPOINT_WAIT_RETRY_MS|SLOT_WAIT_RETRY_MS|ENDPOINT_SETTLE_MS|BOOT_WAIT_INTERVAL/.test(l); }).slice(0, 3));
    ok('T-236 contract: the pre-flight probe and the boot watchdog use one-shot timex.timeout machinery only (no raw timer, no interval)',
      (function () {
        const a = SRC.slice(SRC.indexOf('function startEndpointPreflight'), SRC.indexOf('function armEndpointBootWait'));
        const b = SRC.slice(SRC.indexOf('function armEndpointBootWait'), SRC.indexOf('function armEndpointBootWait') + 1200);
        return a.length > 500 && b.length > 500
          && !/setTimeout\(/.test(a) && !/timex\.interval\(/.test(a)
          && /timex\.timeout\(/.test(b) && !/timex\.interval\(/.test(b) && !/setInterval\(/.test(b);
      })(),
      null);
    ok('T-236 contract: no existing park key was renamed or removed (endpoint_pending / endpoint_wait / machine_wait / endpoint_slot_wait all still written)',
      /job\.endpoint_pending = true/.test(SRC) && /job\.endpoint_wait = \{/.test(SRC)
      && /job\.machine_wait = \{/.test(SRC) && /job\.endpoint_slot_wait = \{/.test(SRC),
      null);
    ok('T-236 contract: the boot gate sits AFTER the host cap gate, so the cap precedence is unchanged',
      (function () {
        const body = SRC.slice(SRC.indexOf('function startQueuedJob('), SRC.indexOf('var ac = new AbortController();'));
        const cap = body.indexOf('job.machine_wait = {');
        const boot = body.indexOf('endpointServingState(fn, endpoint)');
        return cap >= 0 && boot > cap;
      })(),
      null);
    ok('T-236 contract: the T-231 exclusivity gate is still enforced in the runner itself',
      (function () {
        const body = SRC.slice(SRC.indexOf('function startQueuedJob('), SRC.indexOf('var ac = new AbortController();'));
        return /endpointHolderOf\(/.test(body) && /endpoint_slot_wait/.test(body);
      })(),
      null);
    // T-234a contracts: the device-lost classifier joins the wedge family at the right place and
    // moves nothing the boot suite depends on.
    ok('T-234a contract: isWedgeLike claims the device-lost family, so isCapabilityRejection and isBusyRejection (which both open with the isWedgeLike bail-out) can never claim it',
      /function isWedgeLike\(msg\) \{[\s\S]{0,900}?if \(isDeviceLostFailure\(s\)\) return true;[\s\S]*?curl exit 7/.test(SRC)
      && /function isCapabilityRejection\(msg\) \{\s*var s = String\(msg \|\| ''\);\s*if \(!s \|\| isWedgeLike\(s\)\) return false;/.test(SRC)
      && /function isBusyRejection\(msg\) \{\s*var s = String\(msg \|\| ''\);\s*if \(!s \|\| isWedgeLike\(s\)\) return false;/.test(SRC),
      null);
    ok('T-234a contract: the device-lost question is asked AFTER isWedgeLike and BEFORE the boot-window question, at both consultation sites',
      (function () {
        const sq = SRC.slice(SRC.indexOf('function startQueuedJob('), SRC.indexOf('function runEngine('));
        const reStart234 = SRC.indexOf('function runEngine(');
        // Same re-cut as the T-236 window above, 2026-11-09 (T-765): whole function body, not a fixed 4 000 chars.
        const re = SRC.slice(reStart234, SRC.indexOf('\n  function ', reStart234 + 1));
        return sq.indexOf('isWedgeLike(job.error)') < sq.indexOf('isDeviceLostFailure(job.error)')
          && sq.indexOf('isDeviceLostFailure(job.error)') < sq.indexOf('isBootWindowEmptyReply(job.error')
          && re.indexOf('isWedgeLike(err)') < re.indexOf('isDeviceLostFailure(err)')
          && re.indexOf('isDeviceLostFailure(err)') < re.indexOf('isBootWindowEmptyReply(err');
      })(),
      { guard_dev: SRC.indexOf('isDeviceLostFailure(job.error)'), run_dev: SRC.indexOf('isDeviceLostFailure(err)') });
    ok('T-234a contract: isBootWindowEmptyReply and BOOT_REPLY_RE are UNCHANGED — a dead GPU is excluded by the caller, the boot window itself was not edited',
      /var BOOT_REPLY_RE = \/curl exit 52\\b\|empty reply from server\/i;/.test(SRC)
      && /function isBootWindowEmptyReply\(msg, attemptMs\) \{\s*var m = String\(msg \|\| ''\);\s*if \(!BOOT_REPLY_RE\.test\(m\)\) return false;\s*var ms = Number\(attemptMs\);\s*return ms >= 0 && ms < BOOT_WINDOW_MAX_MS;\s*\}/.test(SRC),
      null);
    ok('T-234a contract: no boot-window or wedge constant moved and no new one was introduced (BOOT_WINDOW_MAX_MS / SLOW_AVG_MS / WEDGE_MAX_STREAK / BUSY_MAX_STREAK / ENGINE_TRIES)',
      BOOT_WINDOW_MAX_MS === 10000 && SLOW_AVG_MS === 15000 && num('WEDGE_MAX_STREAK') === 3
      && num('BUSY_MAX_STREAK') === 8 && num('ENGINE_TRIES') === 4
      && !/DEVICE_LOST_MAX|DEVICE_LOST_STREAK|DEVICE_LOST_CEILING|BOOT_WINDOW_DEVICE|DEVLOST_/.test(SRC),
      { BOOT_WINDOW_MAX_MS: BOOT_WINDOW_MAX_MS, SLOW_AVG_MS: SLOW_AVG_MS, WEDGE_MAX_STREAK: num('WEDGE_MAX_STREAK'), BUSY_MAX_STREAK: num('BUSY_MAX_STREAK'), ENGINE_TRIES: num('ENGINE_TRIES') });
    ok('T-234a contract: the transient retry regex is still 50[234] only — a device-lost 500 is NOT retried into the engine',
      /function isTransientEngineError\(msg\) \{\s*var m = String\(msg \|\| ''\);\s*return \/50\[234\]\/\.test\(m\) \|\| \/no error body\|curl exit 7\\b\|curl exit null\/i\.test\(m\);\s*\}/.test(SRC),
      null);
  }
  {
    // A pinned row keeps its pin across a boot-window retry (T-221 re-pin semantics).
    const c = mk({ hold: false, registry: { tts: [ep('e-3', 'tts', T3, ['moss_ttsd', 'qwen3-tts'])], stt: [] } });
    await tick(40);
    c.bootReplies = 1;
    const d = await tts(c, { text: 'pinned row that met a booting engine', endpoint_id: 'e-3' });
    await tick(300);
    const r = await row(c, d.job_id);
    const urls = engineUrls(c);
    ok('T-236 contract: a boot-window retry kept the row pinned to e-3 (no re-placement, no fallback)',
      r.status === 'ok' && r.endpoint_id === 'e-3' && urls.length === 2 && urls[0] === T3 && urls[1] === T3,
      { st: r.status, ep: r.endpoint_id, urls: urls });
    ok('T-236 contract: the retry stayed on the pinned endpoint and never leaked onto the primary',
      urls.every(function (u) { return u === T3; }), urls);
  }

  // ==========================================================================
  // T-240 (user decision 2026-10-06): health became ON-DEMAND ONLY in the PANEL. The host
  // half is deliberately UNCHANGED, and the T-236 boot window depends on that: it reads the
  // same cached answers, keeps the same 120 s staleness rule, and still treats an endpoint
  // this plugin has never probed as SERVING so the first dispatch of a session is not parked.
  // These checks pin that the removal of the panel poller did not move any of it.
  // ==========================================================================
  console.log('\n--- T-240: the host half is untouched — on-demand health, and the T-236 freshness rules survive ---');
  {
    const STALE = num('ENDPOINT_HEALTH_STALE_MS');
    const REPROBE = num('BOOT_REPROBE_MS');
    const MAXP = num('BOOT_MAX_PROBES');
    ok('T-240 host: ENDPOINT_HEALTH_STALE_MS is still 120000 — an old answer is still stale, unchanged by the panel edit',
      STALE === 120000, { ENDPOINT_HEALTH_STALE_MS: STALE });
    ok('T-240 host: the boot gate constants are unchanged (BOOT_REPROBE_MS 15000, BOOT_MAX_PROBES 4, one bounded re-check)',
      REPROBE === 15000 && MAXP === 4 && BOOT_MAX_PROBES === 4, { BOOT_REPROBE_MS: REPROBE, BOOT_MAX_PROBES: MAXP });
    const gate = SRC.slice(SRC.indexOf('function endpointServingState'), SRC.indexOf('function startEndpointPreflight'));
    ok('T-240 host: an endpoint that has NEVER been probed is still SERVING (no answer is not evidence of a fault) — the rule that keeps the first dispatch of a session from parking',
      /if \(!h && !doubt\) return \{ serving: true, reason: '', age_ms: -1 \};/.test(gate), gate.slice(0, 400));
    ok('T-240 host: the stale branch is intact (age >= ENDPOINT_HEALTH_STALE_MS -> not serving, reason stale)',
      /if \(age >= ENDPOINT_HEALTH_STALE_MS\) return \{ serving: false, reason: 'stale', age_ms: age \};/.test(gate), gate.slice(0, 400));
    ok('T-240 host: rememberEndpointHealth semantics are UNCHANGED (writes the record, stamps checked_at, drops the staged clone cache on online:false)',
      /if \(entry\) entry\.health = rec; else primaryHealth\[fn\] = rec;/.test(SRC)
      && /checked_at: Date\.now\(\)/.test(SRC)
      && /dropStagedEndpoint\(url, 'endpoint_health online:false:/.test(SRC), null);
    ok('T-240 host: the host gained NO poller and NO new health caller — /health is still reached from exactly two call sites (the route and the pre-flight)',
      !/setInterval\(/.test(SRC) && !/timex\.interval\(/.test(SRC)
      && SRC.split('probeEndpointHealth(').length - 1 === 3,
      { callSites: SRC.split('probeEndpointHealth(').length - 1 });
  }
  {
    // Behaviour: a session that never probed anything dispatches exactly as it always did.
    const c = mk({ hold: false });
    await tick(40);
    const d = await tts(c, { text: 'a session that has never probed must still render' });
    await tick(250);
    const r = await row(c, d.job_id);
    ok('T-240 host: with no panel poller a never-probed endpoint is NOT parked — the row renders and NO /health probe was spent',
      c.healthCalls.length === 0 && !d.endpoint_boot_wait && !r.endpoint_boot_wait
      && (r.status === 'ok' || r.status === 'running') && engineUrls(c).length >= 1,
      { probes: c.healthCalls.length, wait: d.endpoint_boot_wait, st: r.status, urls: engineUrls(c) });
    ok('T-240 host: a session that never asked for health logged NO endpoint_health record at all (the 12 791-row poller is gone, not hidden)',
      evCount(c, 'endpoint_health') === 0, evLines(c, 'endpoint_health'));
    // The on-demand verb still works, and a deliberate probe is STILL logged.
    const h = J(await call(c.api, '/api/deepamp/endpoint_health', 'POST', { fn: 'tts', id: 'primary' }));
    await tick(60);
    ok('T-240 host: POST endpoint_health {fn,id} still probes <url>/health under the 5 s cap and answers the probe set',
      h.ok === true && h.endpoints.length === 1 && h.endpoints[0].id === 'primary'
      && h.endpoints[0].online === true && h.endpoints[0].checked_at > 0
      && c.healthCalls.every(function (x) { return /'https?:\/\/[^']+\/health'$/.test(x); }),
      h.endpoints && h.endpoints[0]);
    ok('T-240 host: a DELIBERATE probe is still logged — the endpoint_health perf record survives, it is just rare now',
      evCount(c, 'endpoint_health') === 1 && /"ev":"endpoint_health"/.test(evLines(c, 'endpoint_health')[0]),
      evLines(c, 'endpoint_health'));
    const both = J(await call(c.api, '/api/deepamp/endpoint_health', 'POST', {}));
    ok('T-240 host: the no-fn variant still answers every endpoint of BOTH fns in one call (the panel\'s open-section read is unchanged)',
      both.ok === true && both.endpoints.length === 2
      && both.endpoints.map(function (x) { return x.fn; }).join(',') === 'tts,stt',
      both.endpoints && both.endpoints.map(function (x) { return x.fn + ':' + x.id; }));
    const reg = J(await call(c.api, '/api/deepamp/endpoint_registry?fn=tts', 'GET'));
    ok('T-240 host: the cached answer still rides endpoint_registry — reading it back costs NO second probe',
      reg.ok === true && reg.primary && reg.primary.online === true && reg.primary.checked_at > 0
      && c.healthCalls.length === 3, { probes: c.healthCalls.length, primary: reg.primary });
  }
  {
    // Behaviour: the 120 s window is real. ONE instance, ONE cached answer, ONE engine — the
    // only thing that changes between the two dispatches is the clock.
    const c = mk({ hold: false });
    await tick(40);
    const h = J(await call(c.api, '/api/deepamp/endpoint_health', 'POST', { fn: 'tts', id: 'primary' }));
    await tick(60);
    const fresh = await tts(c, { text: 'the cached answer is FRESH — this row must start' });
    ok('T-240 host: an answer INSIDE the 120 s window is SERVING — no park, no wait key, no extra probe',
      h.endpoints[0].online === true && !fresh.endpoint_boot_wait && c.healthCalls.length === 1,
      { wait: fresh.endpoint_boot_wait, probes: c.healthCalls.length });
    await tick(250);
    const fr = await row(c, fresh.job_id);
    ok('T-240 host: the fresh-answer row rendered — a healthy fleet dispatches exactly as it always did',
      fr.status === 'ok' || fr.status === 'running', { st: fr.status });
    const urlsBefore = engineUrls(c).length;
    const realNow = Date.now;
    Date.now = function () { return realNow() + num('ENDPOINT_HEALTH_STALE_MS') + 15000; };
    const aged = await tts(c, { text: 'the same cached answer is now older than the host window' });
    Date.now = realNow;
    ok('T-240 host: the SAME answer, once older than ENDPOINT_HEALTH_STALE_MS, parks the row instead of starting it (the 120 s rule is live and unchanged)',
      !!aged.endpoint_boot_wait && aged.endpoint_boot_wait.id === 'primary'
      && ['stale', 'probing', 'offline', 'unknown', 'in_flight'].indexOf(aged.endpoint_boot_wait.reason) >= 0,
      aged.endpoint_boot_wait);
    ok('T-240 host: the stale park spent NO engine request at dispatch time — a wait, not a burned row',
      engineUrls(c).length === urlsBefore && evCount(c, 'auto_pause') === 0, { urls: engineUrls(c) });
    await tick(120);
    ok('T-240 host: the pre-flight path is intact — the stale park fired the bounded /health re-probe with ZERO intervals',
      c.healthCalls.length >= 2 && c.intervals === 0, { probes: c.healthCalls.length, intervals: c.intervals });
  }

  // ==========================================================================
  // T-245 — the restart this suite is about, seen from the OTHER side: the staged
  // sample. A restart wipes upload_root_ (runtime.cpp:1006-1008), so every voice the
  // plugin believes is staged on that endpoint is now a path this engine process never
  // wrote, and the next clone walks into wav_reader.cpp:412. Measured live on gpu1
  // 2026-10-07 after audio-cpp-vk.service was restarted:
  //   curl exit 22: curl: (22) The requested URL returned error: 500
  //     | body: could not open WAV input: /tmp/audiocpp-ui-1791356334209286/1-voy-doctor.wav
  // That answer is `unclassified` to the wedge guard — it advances wedgeStreak — so a
  // restart that nothing probed used to feed the T-206 ceiling one stale path at a time.
  // Nothing below probes, polls, signals, or restarts anything: the engine identity is a
  // field of the stub that changes between two renders.
  // ==========================================================================
  {
    // Built, not written: a voice sample has to sit under the store root the host itself resolves.
    const VDIR245 = path.join(require('os').homedir(), '.dsh', 'deepamp-audio', 'voices');
    const SESS_A245 = '/tmp/audiocpp-ui-1791356334209225';   // the session the live fault names
    const SESS_B245 = '/tmp/audiocpp-ui-1791358136942325';   // the session after the restart
    const VOICES245 = {
      tomboy1: { ref_text: 'the first reference line', ref_wav: VDIR245 + '/tomboy1.wav', remote_wav: '', remote_host: '', created: 111, source: 'test', ref_dur_s: 4 },
    };
    const mk245 = function (opts) {
      opts = opts || {};
      const sess245 = opts.session || { dir: SESS_A245, n: 0 };
      const c = mk(Object.assign({}, opts, {
        hold: false, engineSession: sess245, voices: VOICES245,
        fsSeed: Object.assign({}, opts.fsSeed || {}, { [VDIR245 + '/tomboy1.wav']: 'RIFFfake' }),
      }));
      c.sess = sess245;
      return c;
    };
    const clone245 = async function (c, text) {
      // moss_ttsd is a samples_only family: a clone rides `speakers` -> options.voice_samples,
      // the positional WAV paths staged on the endpoint that renders the take. That is the
      // shape the live gpu1 clone rode into the dead upload root.
      const d = await tts(c, { speakers: ['tomboy1'], text: text });
      await tick(250);
      return row(c, d.job_id);
    };
    const pathSent245 = function (c) {
      const sp = c.specs.filter(function (s) { return /\/v1\/audio\/speech/.test(s.command); }).pop();
      let b = {};
      try { b = JSON.parse(String((sp && sp.stdin) || '{}')); } catch (e) { b = {}; }
      if (b.voice_ref && typeof b.voice_ref === 'object' && b.voice_ref.path) return String(b.voice_ref.path);
      if (b.options && b.options.voice_samples) return String(b.options.voice_samples);
      return '';
    };
    const dirOf245 = function (p) { const i = String(p).lastIndexOf('/'); return i > 0 ? String(p).slice(0, i) : ''; };

    console.log('\n--- T-245 (h): a restart nothing probed must not feed the wedge ceiling ---');
    const c245 = mk245({});
    await tick(60);
    // The samples_only guard is a KNOWN-catalog guard and this suite fetches /v1/models during
    // the first dispatch, so one plain generation warms the catalog before the clone runs.
    const warm = await tts(c245, { text: 'catalog warm-up, no voice, no staging' });
    await tick(250);
    const r1 = await clone245(c245, 'render 1, before the restart');
    ok('T-245 (h): the first clone stages into the engine session its upload answer named',
      r1.status === 'ok' && c245.uploads.length === 1 && dirOf245(c245.uploads[0].path) === SESS_A245
      && pathSent245(c245) === c245.uploads[0].path, { uploads: c245.uploads.length, sent: pathSent245(c245) });
    c245.sess.dir = SESS_B245;      // the engine process died and systemd started a new one
    c245.sess.n = 0;
    const r2 = await clone245(c245, 'render 2, the first one after the restart');
    const r3 = await clone245(c245, 'render 3, on the new session');
    const r4 = await clone245(c245, 'render 4, on the new session');
    // T-336 (2026-10-13): this group's clone is `speakers:['tomboy1']`, i.e. a ONE-slot positional
    // cast, so it now takes the identity probe. The point of the group is unchanged — a restart
    // nothing probed must not feed the wedge ceiling — but the recovery moved: the take re-stages
    // its one slot BEFORE the request (an upload, which is the only identity answer the engine
    // gives) instead of discovering the dead root from the engine's refusal afterwards. Still zero
    // /health calls and zero intervals: the plugin never polls, and it never needed to.
    ok('T-245 (h) T-336: every row after the unprobed restart renders clean, each having re-staged its own slot first (4 uploads for 4 rows)',
      r2.status === 'ok' && r3.status === 'ok' && r4.status === 'ok'
      && c245.uploads.length === 4 && dirOf245(pathSent245(c245)) === SESS_B245,
      { st: [r1.status, r2.status, r3.status, r4.status], uploads: c245.uploads.length, sent: pathSent245(c245) });
    ok('T-245 (h): THREE stale renders cost the ceiling NOTHING — no auto_pause event, the lane is not paused (pre-T-245 the third one paused it)',
      evCount(c245, 'auto_pause') === 0 && (await qs(c245)).queues.tts.paused === false,
      { auto_pause: evCount(c245, 'auto_pause'), paused: (await qs(c245)).queues.tts.paused, auto_paused: (await qs(c245)).queues.tts.auto_paused });
    ok('T-245 (h): every row that reached a terminal state logged exactly ONE outcome, and every one of them is ok',
      evCount(c245, 'job_outcome') === 5 && evLines(c245, 'job_outcome').every(function (l) { return /"st":"ok"/.test(l); }),
      evLines(c245, 'job_outcome').map(function (l) { return (/"st":"(\w+)"/.exec(l) || [])[1]; }));
    ok('T-245 (h) T-336: the recovery is an upload, never a poll — zero /health calls and zero intervals in the whole session, and no engine refusal was ever needed (3 identity probes, 0 refusal re-stages)',
      c245.healthCalls.length === 0 && c245.intervals === 0 && evCount(c245, 'voice_stage_restage') === 0
      && evCount(c245, 'voice_stage_identity_probe') === 3,
      { probes: c245.healthCalls.length, intervals: c245.intervals, refusal_restages: evCount(c245, 'voice_stage_restage'),
        identity_probes: evCount(c245, 'voice_stage_identity_probe') });

    console.log('\n--- T-245 (i): when the re-stage also fails, the row still counts ONCE against the ceiling ---');
    const p245 = mk245({ enginePoison: true });
    await tick(60);
    await tts(p245, { text: 'catalog warm-up, no voice, no staging' });
    await tick(250);
    const p1 = await clone245(p245, 'poisoned render 1');
    const p2 = await clone245(p245, 'poisoned render 2');
    const p3 = await clone245(p245, 'poisoned render 3');
    ok('T-245 (i): three poisoned rows fail — each ONE row, ONE outcome, ONE re-stage (no row is counted twice)',
      p1.status === 'error' && p2.status === 'error' && p3.status === 'error'
      && evCount(p245, 'job_outcome') === 4 && evLines(p245, 'job_outcome').filter(function (l) { return /"fn":"tts"/.test(l); }).length === 4
      && evLines(p245, 'job_outcome').every(function (l) { return /"st":"(ok|error)"/.test(l); })
      && evLines(p245, 'job_outcome').filter(function (l) { return /"st":"error"/.test(l); }).length === 3
      && evCount(p245, 'voice_stage_restage') === 3,
      { outcomes: evCount(p245, 'job_outcome'), restages: evCount(p245, 'voice_stage_restage') });
    ok('T-245 (i): the ceiling fires ONCE, at wedge_streak 3 — the retries added nothing to the streak',
      evCount(p245, 'auto_pause') === 1
      && (/"wedge_streak":(\d+)/.exec(evLines(p245, 'auto_pause')[0] || '') || [])[1] === String(num('WEDGE_MAX_STREAK')),
      { auto_pause: evCount(p245, 'auto_pause'), line: (evLines(p245, 'auto_pause')[0] || '').slice(0, 240) });
    ok('T-245 (i): and every failed row still carries the engine\'s own wav_reader sentence',
      [p1, p2, p3].every(function (r) { return /could not open WAV input: /.test(String(r.error || '')); }),
      [p1.error, p2.error, p3.error]);
  }


  // ==========================================================================
  // T-253 (2026-10-07): THE MULTI-SLOT CAST AND THE ENGINE SESSION.
  // T-245 (h) above is the one-voice clone. The live fault that opened T-253 was a THREE-voice
  // moss_ttsd cast on gpu1 (perf_log 2026-10-07, ap-0179): the cast staged its one fresh
  // sample, the plugin LOGGED the identity change from that upload ("engine session identity
  // changed (/tmp/audiocpp-ui-1791381206388516 -> /tmp/audiocpp-ui-1791381410555923)"), and the
  // take still went out with the two cache-hot slots pointing into the dead root - 108 179 ms of
  // GPU before "could not open WAV input: /tmp/audiocpp-ui-1791381206388516/1-voy-doctor.wav",
  // and the render that lost the Vulkan device. The gap is the ORDER a cast resolves its slots,
  // so the assertions below put the restart between two upload legs of ONE cast.
  // ==========================================================================
  {
    // Built, not written: same reason as VDIR245 (item 38).
    const VDIR253 = path.join(require('os').homedir(), '.dsh', 'deepamp-audio', 'voices');
    const SA253 = '/tmp/audiocpp-ui-1791356334209225';
    const SB253 = '/tmp/audiocpp-ui-1791358136942325';
    const SC253 = '/tmp/audiocpp-ui-1791360000000111';
    const VOICES253 = {
      voy_doctor: { ref_text: 'the doctor reference line', ref_wav: VDIR253 + '/voy_doctor.wav', remote_wav: '', remote_host: '', created: 111, source: 'test', ref_dur_s: 4 },
      tomboy1: { ref_text: 'the first reference line', ref_wav: VDIR253 + '/tomboy1.wav', remote_wav: '', remote_host: '', created: 111, source: 'test', ref_dur_s: 4 },
      newvoice1: { ref_text: 'a third reference line', ref_wav: VDIR253 + '/newvoice1.wav', remote_wav: '', remote_host: '', created: 111, source: 'test', ref_dur_s: 4 },
    };
    const mk253 = function (opts) {
      opts = opts || {};
      const sess = opts.session || { dir: SA253, n: 0 };
      const c = mk(Object.assign({}, opts, {
        hold: false, engineSession: sess, voices: VOICES253,
        fsSeed: Object.assign({}, opts.fsSeed || {}, {
          [VDIR253 + '/voy_doctor.wav']: 'RIFFfake', [VDIR253 + '/tomboy1.wav']: 'RIFFfake', [VDIR253 + '/newvoice1.wav']: 'RIFFfake',
        }),
      }));
      c.sess253 = sess;
      return c;
    };
    const cast253 = async function (c, speakers, text) {
      const d = await tts(c, { speakers: speakers, text: text });
      await tick(400);
      return row(c, d.job_id);
    };
    const slots253 = function (c, idx) {
      const sps = c.specs.filter(function (s) { return /\/v1\/audio\/speech/.test(s.command); });
      const sp = idx === undefined ? sps.pop() : sps[idx];
      let b = {};
      try { b = JSON.parse(String((sp && sp.stdin) || '{}')); } catch (e) { b = {}; }
      return String((b.options && b.options.voice_samples) || '').split(',');
    };
    const renders253 = function (c) { return c.specs.filter(function (s) { return /\/v1\/audio\/speech/.test(s.command); }).length; };
    const ev253 = function (c, ev) { return c.shellCalls.filter(function (x) { return x.indexOf('"ev":"' + ev + '"') >= 0; }); };
    const dirOf253 = function (p) { const i = String(p).lastIndexOf('/'); return i > 0 ? String(p).slice(0, i) : ''; };

    console.log('\n--- T-253 (j): a cast whose engine died between its OWN upload legs ---');
    const j253 = mk253({ restarts: [{ at: 2, to: SB253 }] });
    await tick(60);
    await tts(j253, { text: 'catalog warm-up, no voice, no staging' });   // warms the known-model catalog
    await tick(250);
    const jRenders0 = renders253(j253);
    const j1 = await cast253(j253, ['voy_doctor', 'tomboy1', 'newvoice1'], '[S1] worf [S2] data [S3] neelix');
    const jFirst = slots253(j253, jRenders0);
    ok('T-253 (j): a multi-slot cast that spans two engine sessions never renders on the dead root - its FIRST speech request already names the live upload root in every slot, and the take issues ONE request',
      renders253(j253) - jRenders0 === 1 && jFirst.length === 3
      && jFirst.every(function (p) { return String(p || '').trim() !== '' && dirOf253(p) === SB253; }) && j1.status === 'ok',
      { renders: renders253(j253) - jRenders0, first_request_slots: jFirst, live: SB253, dead: SA253, status: j1.status, error: j1.error });
    ok('T-253 (j): the whole cast was dropped for that endpoint and re-staged as a unit, once, and the recovery happened before any request - voice_stage_cast_restage once, no voice_stage_restage',
      ev253(j253, 'voice_stage_cast_restage').length === 1 && ev253(j253, 'voice_stage_restage').length === 0
      && j1.stage_cast_restaged === true && j1.stage_restaged !== true,
      { cast_restages: ev253(j253, 'voice_stage_cast_restage').length, restages: ev253(j253, 'voice_stage_restage').length,
        line: String(ev253(j253, 'voice_stage_cast_restage')[0] || '').slice(0, 300) });
    const jDrops = ev253(j253, 'voice_stage_drop').filter(function (l) { return l.indexOf('dialogue cast re-staged') >= 0; });
    ok('T-253 (j): the re-stage is bounded - 3 slots staged + 3 re-staged for a 3-slot cast, and the whole-cast drop is its OWN event naming the live session it re-staged into',
      j253.uploads.length === 6 && jDrops.length === 1 && jDrops[0].indexOf(SB253) >= 0,
      { uploads: j253.uploads.map(function (u) { return u.filename + ' -> ' + u.path; }), drops: ev253(j253, 'voice_stage_drop').map(function (l) { return l.slice(0, 260); }) });
    const j2 = await cast253(j253, ['voy_doctor', 'tomboy1', 'newvoice1'], '[S1] second take [S2] second take [S3] second take');
    // T-336: the second take pays ONE probe upload (7 instead of 6). One render per take, one cast
    // re-stage for the whole session, and no second one — those halves of the guard are unchanged.
    ok('T-253 (j) T-336: the take after the re-stage reuses the re-staged cast - one probe upload (7 total), one request, and no second cast re-stage',
      j2.status === 'ok' && j253.uploads.length === 7 && renders253(j253) - jRenders0 === 2
      && ev253(j253, 'voice_stage_cast_restage').length === 1 && ev253(j253, 'voice_stage_identity_probe').length === 1,
      { uploads: j253.uploads.length, renders: renders253(j253) - jRenders0,
        cast_restages: ev253(j253, 'voice_stage_cast_restage').length, probes: ev253(j253, 'voice_stage_identity_probe').length });

    console.log('\n--- T-253 (k): what the one-voice cast and a stable engine now cost (T-336 moved these numbers) ---');
    const k253 = mk253({});
    await tick(60);
    await tts(k253, { text: 'catalog warm-up' });
    await tick(250);
    const kR0 = renders253(k253);
    const k0 = await cast253(k253, ['tomboy1'], '[S1] a single cloned line, staged before the restart');
    k253.sess253.dir = SB253; k253.sess253.n = 0;      // the engine process died; nothing probed it
    const k1 = await cast253(k253, ['tomboy1'], '[S1] a single cloned line after the restart');
    // T-336 CHANGED THIS GUARD'S NUMBERS, NOT ITS POINT. A `speakers:[one voice]` take is still a
    // positional cast, so it now takes the identity probe and never walks into the dead root: the
    // engine refusal that used to discover the restart is gone, the second speech request is gone,
    // and the row carries no retry flag. What still must not happen is a CAST re-stage for a
    // one-slot cast — that machinery is for a multi-slot cast spanning two sessions (T-253 (j)).
    ok('T-253 (k) guard T-336: a ONE-voice take takes the probe, not the cast gate - one request for the stale row (it used to be two), zero re-stages of either kind, no retry flag',
      k0.status === 'ok' && k1.status === 'ok' && renders253(k253) - kR0 === 2
      && ev253(k253, 'voice_stage_cast_restage').length === 0
      && ev253(k253, 'voice_stage_restage').length === 0
      && ev253(k253, 'voice_stage_identity_probe').length === 1 && k1.stage_restaged !== true,
      { renders_after_warmup: renders253(k253) - kR0, cast_restages: ev253(k253, 'voice_stage_cast_restage').length,
        restages: ev253(k253, 'voice_stage_restage').length, probes: ev253(k253, 'voice_stage_identity_probe').length,
        status: k1.status, stage_restaged: k1.stage_restaged });
    const k253b = mk253({});
    await tick(60);
    await tts(k253b, { text: 'catalog warm-up' });
    await tick(250);
    const kB0 = renders253(k253b);
    await cast253(k253b, ['voy_doctor', 'tomboy1'], '[S1] stable one [S2] stable two');
    await cast253(k253b, ['voy_doctor', 'tomboy1'], '[S1] stable three [S2] stable four');
    ok('T-253 (k) guard T-336: with a stable engine identity a two-voice cast stages ONE sample per voice and pays ONE probe on the second take - three uploads, two requests, no re-stage of either kind',
      k253b.uploads.length === 3 && renders253(k253b) - kB0 === 2
      && ev253(k253b, 'voice_stage_restage').length === 0 && ev253(k253b, 'voice_stage_cast_restage').length === 0
      && ev253(k253b, 'voice_stage_identity_probe').length === 1,
      { uploads: k253b.uploads.map(function (u) { return u.path; }), renders: renders253(k253b) - kB0,
        probes: ev253(k253b, 'voice_stage_identity_probe').length });
  }

  console.log('\n=== ' + pass + ' pass, ' + fail + ' fail ===');
  process.exitCode = fail ? 1 : 0;
})().catch(function (e) { console.log('HARNESS ERROR', e && e.stack); process.exitCode = 1; });
