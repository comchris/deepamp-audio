#!/usr/bin/env node
// The model x host x quant test matrix runner. It was written new rather than extended, and the depth of
// each row was fixed from a pilot run before the sweep was planned.
//
// This is the runner, not the results. It plans a sweep, and in --dry-run it prints the plan WITHOUT dispatching
// anything, which is what tests/model_matrix.test.cjs pins. In a real run it dispatches one fixed sentence per
// model, one model at a time, and records what the lane actually answered: load time and generation time kept
// apart, the audio it produced, and any refusal in the words the host used.
//
// Rules this code is written to, all of them measured facts about this fleet:
//   1. `max_loaded_models: 1` per engine, so a sweep is SEQUENTIAL on one endpoint. Two models on the same engine
//      at once is not a faster sweep, it is a failed sweep.
//   2. A family that needs a built-in engine voice (lfm2_audio, kugelaudio, kokoro_tts, ...) must be dispatched
//      with one named, or the plugin's capability bar refuses it. That refusal is useful data, but only if the
//      sweep did not cause it.
//   3. A family that clones needs a voice the plugin owns, with a sample. If none exists the model is SKIPPED with
//      a reason, not dispatched into a refusal.
//   4. Nothing here invents audio. Every row is a real take the lane rendered, or a real refusal it named.
//   5. A row that fails is still a row. The table is for whitelisting, and a model that fails on a host is exactly
//      the kind of fact a whitelist needs.

'use strict';

const API_BASE = process.env.DSH_API || 'http://127.0.0.1:3080/api/deepamp';
const SENTENCE = process.env.MATRIX_TEXT || 'The shuttle is quiet now and the seat by the window is mine.';

function apiFetch(path, opts) {
  const o = Object.assign({}, opts || {});
  if (o.body && typeof o.body !== 'string') o.body = JSON.stringify(o.body);
  if (o.body && !o.headers) o.headers = { 'Content-Type': 'application/json' };
  return fetch(API_BASE + path, o).then(function (r) { return r.json(); });
}

// The voice decision, kept separate from the dispatch so it can be tested without a fleet.
// The inputs are the host's OWN words, read from its verbs: `get_models?fn=tts` answers per model
// {id, task, family, mode, path, quant, clone_required, clone_optional, default_voice, samples_only,
// ref_text_required, loaded}; `model_capabilities?fn=tts` answers per family {tasks, capability_needs,
// builtin_voices, default_voice, capabilities}; `voice_registry` answers a dict of the voices this plugin owns.
function pickVoice382(model, cap, registryVoices) {
  const needs = (cap && cap.capability_needs) || [];
  const builtins = (cap && cap.builtin_voices) || [];
  const hasOwnVoice = (registryVoices || []).length > 0;
  const wantsBuiltin = builtins.length > 0 && needs.indexOf('built_in_voice') >= 0;
  if (wantsBuiltin) {
    const d = cap && cap.default_voice;
    if (d && d !== true && d !== 'true') return { voice: String(d), mode: 'engine_builtin', reason: '' };
    if (builtins.length) return { voice: String(builtins[0]), mode: 'engine_builtin', reason: '' };
    return { voice: '', mode: 'skip', reason: 'family ' + ((cap && cap.family) || (model && model.family) || '') + ' needs a built-in voice and the engine named none' };
  }
  if (model && model.clone_required) {
    if (!hasOwnVoice) return { voice: '', mode: 'skip', reason: 'this model clones and this plugin holds no registered voice' };
    const v = registryVoices[0];
    return { voice: v.name || v.id, mode: 'plugin_voice', reason: '' };
  }
  const v2 = (registryVoices || [])[0];
  if (v2 && (v2.name || v2.id)) return { voice: v2.name || v2.id, mode: 'plugin_voice_offered', reason: '' };
  return { voice: '', mode: 'engine_default', reason: '' };
}

// Which models this sweep may even try. A model whose family the lane cannot drive at all - one that
// only does generation, voice conversion or speech-to-speech - is listed as UNTESTABLE with the reason.
// Pretending otherwise would be a clean table of nothing, which is what this matrix exists to avoid.
function planRows382(models, capsByModel, registryVoices, opts) {
  const out = [];
  // A targeted re-run is a first-class thing here, not an afterthought: if an operator touches the playlist while a
  // sweep is running, the rows that were aborted or cancelled by that touch are invalid data, and the honest fix is
  // to re-measure exactly those models rather than throw the whole sweep away. --models a,b,c selects them.
  const only = (opts && opts.onlyModels && opts.onlyModels.length) ? opts.onlyModels : null;
  const pool = only ? (models || []).filter(function (m) { return only.indexOf(m.id || m.model) >= 0; }) : (models || []);
  const limit = opts && Number(opts.limit) > 0 ? Number(opts.limit) : pool.length;
  const fn = (opts && opts.fn) || 'tts';
  pool.slice(0, limit).forEach(function (m) {
    const id = m.id || m.model || '';
    const cap = (capsByModel || {})[id] || null;
    const tasks = (cap && Array.isArray(cap.tasks)) ? cap.tasks : (m.task ? [m.task] : []);
    if (tasks.length && tasks.indexOf(fn) < 0) {
      out.push({ model: id, family: m.family || (cap && cap.family) || '', quant: m.quant || '', verdict: 'untestable', voice: '', voice_mode: 'none', reason: 'the engine says this family serves ' + tasks.join('/') + ' and this sweep runs the ' + fn + ' lane', endpoint: (opts && opts.endpoint) || 'primary', fn: fn, text: '' });
      return;
    }
    const pv = pickVoice382(m, cap, registryVoices);
    out.push({
      model: id, family: m.family || (cap && cap.family) || '', quant: m.quant || '',
      verdict: pv.mode === 'skip' ? 'skip' : 'run', voice: pv.voice, voice_mode: pv.mode, reason: pv.reason,
      endpoint: (opts && opts.endpoint) || 'primary', fn: fn, text: SENTENCE,
    });
  });
  return out;
}

const COLUMNS = ['ran_at', 'fn', 'endpoint', 'model', 'family', 'quant', 'voice', 'voice_mode', 'job_id', 'status', 'elapsed_load_ms', 'elapsed_gen_ms', 'audio_seconds', 'bytes', 'error'];

function rowFromJob382(planRow, job, ranAt) {
  const j = job || {};
  return {
    ran_at: ranAt || new Date().toISOString(),
    fn: planRow.fn, endpoint: planRow.endpoint, model: planRow.model, family: planRow.family, quant: planRow.quant,
    voice: planRow.voice, voice_mode: planRow.voice_mode, job_id: j.id || '', status: j.status || 'no_job',
    elapsed_load_ms: typeof j.elapsed_load === 'number' ? j.elapsed_load : '',
    elapsed_gen_ms: typeof j.elapsed_gen === 'number' ? j.elapsed_gen : '',
    audio_seconds: typeof j.duration === 'number' ? j.duration : '',
    bytes: typeof j.size_bytes === 'number' ? j.size_bytes : '',
    error: j.error ? String(j.error).replace(/\s+/g, ' ').slice(0, 240) : '',
  };
}

function toCsv382(rows) {
  const esc = function (v) { const s = String(v === undefined || v === null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return COLUMNS.join(',') + '\n' + rows.map(function (r) { return COLUMNS.map(function (c) { return esc(r[c]); }).join(','); }).join('\n') + '\n';
}

async function waitJob382(fn, jobId, maxSeconds) {
  const deadline = Date.now() + (maxSeconds || 600) * 1000;
  while (Date.now() < deadline) {
    const s = await apiFetch('/job_status?fn=' + encodeURIComponent(fn) + '&job_id=' + encodeURIComponent(jobId));
    const row = (s && s.job) ? s.job : s;
    if (row && ['ok', 'error', 'cancelled', 'aborted'].indexOf(row.status) >= 0) return row;
    await new Promise(function (r) { setTimeout(r, 10000); });
  }
  return { status: 'timeout', id: jobId, error: 'the sweep stopped waiting after ' + (maxSeconds || 600) + ' s' };
}

async function runSweep382(opts) {
  const fn = opts.fn || 'tts';
  const models = await apiFetch('/get_models?fn=' + encodeURIComponent(fn)).then(function (d) { return d.models || []; });
  const reg = await apiFetch('/voice_registry').then(function (d) {
    const v = d.voices || d.entries || {};
    if (Array.isArray(v)) return v;
    return Object.keys(v).map(function (k) { return Object.assign({ name: k }, v[k] || {}); });
  }).catch(function () { return []; });
  const cap = await apiFetch('/model_capabilities?fn=' + encodeURIComponent(fn) + '&model=' + encodeURIComponent((models[0] && models[0].id) || '')).catch(function () { return null; });
  const capsByModel = {};
  if (cap && cap.families) {
    models.forEach(function (m) {
      const f = cap.families[m.family || ''];
      if (f) capsByModel[m.id] = { family: f.family, tasks: f.tasks || [], capability_needs: f.capability_needs || [], builtin_voices: f.builtin_voices || [], default_voice: f.default_voice };
    });
  }
  const plan = planRows382(models, capsByModel, reg, opts);
  if (opts.dryRun) {
    console.log(JSON.stringify({ models: models.length, planned: plan.length, rows: plan }, null, 1));
    return { plan: plan, results: [] };
  }
  const results = [];
  for (const p of plan) {
    if (p.verdict !== 'run') { results.push(rowFromJob382(p, { status: p.verdict, error: p.reason }, new Date().toISOString())); continue; }
    const body = { fn: p.fn, model: p.model, text: p.text, endpoint_id: p.endpoint };
    if (p.voice) body.voice = p.voice;
    const d = await apiFetch('/dispatch_tts', { method: 'POST', body: body });
    if (!d || d.ok === false || !d.job_id) {
      results.push(rowFromJob382(p, { id: '', status: 'refused', error: (d && d.error) || 'dispatch refused' }, new Date().toISOString()));
      console.log('refused ' + p.model + ': ' + ((d && d.error) || 'no reason given').slice(0, 140));
      continue;
    }
    const job = await waitJob382(p.fn, d.job_id, opts.jobTimeout);
    results.push(rowFromJob382(p, job, new Date().toISOString()));
    console.log(p.model + ' ' + job.status + ' load ' + job.elapsed_load + ' gen ' + job.elapsed_gen + ' s ' + job.duration + ' B ' + job.size_bytes);
  }
  // A timed-out row is not necessarily a failed model: the ceiling was mine, not the engine's. Before
  // the table is written, every timed-out row gets ONE more look, and if the engine answered in the
  // meantime the row carries the engine's real numbers. Measured on the live lane: `omnivoice` made
  // 3.00 s of audio in 420,844 ms of generation while my 420 s ceiling wrote the row as `timeout` and
  // the playlist said `ok`. The row keeps saying the ceiling was hit — it stops pretending nothing came.
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status !== 'timeout' || !r.job_id) continue;
    try {
      const s = await apiFetch('/job_status?fn=' + encodeURIComponent(r.fn) + '&job_id=' + encodeURIComponent(r.job_id));
      const late = (s && s.job) ? s.job : s;
      if (late && ['ok', 'error', 'cancelled', 'aborted'].indexOf(late.status) >= 0) {
        const prow = plan.filter(function (p) { return p.model === r.model; })[0] || {};
        const fixed = rowFromJob382(prow, late, r.ran_at);
        fixed.error = (late.status === 'ok'
          ? 'answered after the sweep stopped waiting at ' + (opts.jobTimeout || 600) + ' s'
          : (late.error || '')) + ' [ceiling ' + (opts.jobTimeout || 600) + ' s]';
        results[i] = fixed;
        console.log('late answer ' + r.model + ' ' + late.status + ' gen ' + late.elapsed_gen + ' s ' + late.duration);
      }
    } catch (e) {}
  }
  const out = opts.out || ('bench/model_matrix_' + new Date().toISOString().slice(0, 10) + '.csv');
  require('fs').mkdirSync(require('path').dirname(out), { recursive: true });
  require('fs').writeFileSync(out, toCsv382(results));
  console.log('WROTE ' + out + ' rows=' + results.length);
  return { plan: plan, results: results };
}

if (require.main === module) {
  const a = process.argv.slice(2);
  const opts = { dryRun: a.indexOf('--dry-run') >= 0, fn: 'tts', endpoint: 'primary', limit: 0, jobTimeout: 600, out: '' };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--fn' && a[i + 1]) opts.fn = a[++i];
    else if (a[i] === '--endpoint' && a[i + 1]) opts.endpoint = a[++i];
    else if (a[i] === '--limit' && a[i + 1]) opts.limit = Number(a[++i]);
    else if (a[i] === '--models' && a[i + 1]) opts.onlyModels = String(a[++i]).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    else if (a[i] === '--out' && a[i + 1]) opts.out = a[++i];
    else if (a[i] === '--job-timeout' && a[i + 1]) opts.jobTimeout = Number(a[++i]);
  }
  runSweep382(opts).catch(function (e) { console.log('MATRIX ERROR ' + (e && e.message || e)); process.exitCode = 1; });
} else {
  module.exports = { pickVoice382, planRows382, rowFromJob382, toCsv382, COLUMNS, waitJob382, runSweep382 };
}
