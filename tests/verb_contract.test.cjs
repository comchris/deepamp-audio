// T-588-era contract test (added 2026-10-18): the panel's read verbs and the host's method gates must agree.
//
// Why this exists. The host answers a read verb sent with the wrong verb with 405 {"ok":false,"error":"method not
// allowed"} (lib/index.js, the `notAllowed` closure at :17240). On 2026-10-18 a probe of mine sent POST to
// `batch_file_list` and got 405, and my first static attempt to find every such mismatch reported SIX broken calls -
// all six were MY parsing error: the client's switch groups several read verbs on one body
// (`case 'queue_status': case 'get_save_paths': case 'voice_registry':` at lib/client.js:9883-9885), and attributing
// that body only to the last label made four GET-cased verbs look POSTed. The live gates were then measured with
// curl: batch_text_list, get_save_paths, queue_status, storage_status, voice_registry and batch_file_list are all
// GET=200 / POST=405; takes_limit is GET=200 / POST=200. No panel call was actually mismatched.
//
// So the finding is not a defect, it is a contract, and a contract needs a pin: a future card that adds a read verb
// to one half and forgets the other must fail HERE rather than in the operator's browser. The grouped-case rule is
// pinned too, because that is the rule that fooled me.
//
// Usage: node tests/verb_contract.test.cjs [path/to/client.js]
'use strict';
const fs = require('fs');
const path = require('path');

const CLIENT = process.argv[2] || path.join(__dirname, '..', 'lib', 'client.js');
const HOST = process.argv[3] || path.join(__dirname, '..', 'lib', 'index.js');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  ->  ' + detail : '')); }
}

const client = fs.readFileSync(CLIENT, 'utf8');
const host = fs.readFileSync(HOST, 'utf8');

// --- the client's switch: label -> effective method, with fall-through groups attributed to EVERY label ---
function clientMethods(src) {
  const at = src.indexOf('switch (name) {');
  if (at < 0) throw new Error('the client call() switch was not found');
  let depth = 0, i = at + 'switch (name)'.length;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = src.slice(src.indexOf('{', at) + 1, i);
  const labels = [];
  const re = /\n\s*case '([a-z0-9_]+)':/g;
  let m;
  while ((m = re.exec(body))) labels.push({ name: m[1], start: m.index, end: m.index + m[0].length });
  const out = {};
  for (let k = 0; k < labels.length; k++) {
    // a group is a run of labels with nothing but comments/whitespace between them; the body of the LAST label in
    // the run is the body every label in the run falls through to.
    let g = k;
    while (g + 1 < labels.length) {
      const between = body.slice(labels[g].end, labels[g + 1].start);
      const stripped = between.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim();
      if (stripped.length) break;
      g++;
    }
    const stop = (g + 1 < labels.length) ? labels[g + 1].start : body.length;
    let seg = body.slice(labels[g].end, stop);
    seg = seg.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const isGet = /method\s*=\s*'GET'/.test(seg);
    const isPost = /method\s*=\s*'POST'/.test(seg);
    const method = isGet && !isPost ? 'GET' : (isPost ? 'POST' : 'POST');   // no assignment = the POST default
    for (let q = k; q <= g; q++) out[labels[q].name] = method;
    k = g;
  }
  return out;
}

// --- the host's gates: route -> what the dispatcher accepts ---
function hostGates(src) {
  const out = {};
  // Route openers, including the grouped form the host uses for alias verbs:
  //   if (parts[0] === 'endpoint_pause' || parts[0] === 'endpoint_resume') {
  // Every verb named on such a line shares the block, exactly as grouped `case` labels share one body in the client's
  // switch. Measured 2026-10-18 while adding the T-589 pins: my first version matched only the single-verb form, so
  // `endpoint_pause` and `endpoint_resume` were missing from the gate map although lib/index.js:18443 routes both, and
  // the new pin reported two verbs on the destructive list as unrouted. That was the parser, not the host.
  // An assignment such as `var isClear = parts[0] === 'endpoint_failures_clear';` sits INSIDE a block and is not a
  // route; requiring the line to open with `if (` and end with `) {` is what keeps those out.
  const re = /^[ \t]*if \(parts\[0\] === '([a-z0-9_]+)'((?: \|\| parts\[0\] === '[a-z0-9_]+')*)\) \{$/gm;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1];
    const names = [m[1]].concat((m[2].match(/'([a-z0-9_]+)'/g) || []).map(function (s) { return s.replace(/'/g, ''); }));
    // `match.end` is not dependable across Node versions - one build returns undefined there, which turns the slice
    // into an empty string, which makes every route look "ungated". Measured on 2026-10-18 while writing this test:
    // three gates read as ungated for exactly that reason. index + the match's own length is the portable form.
    const from = m.index + m[0].length;
    // The block's own text, found by brace matching from the route's opening brace. A fixed window is what produced a
    // wrong reading on 2026-10-18: `takes_limit` has a GET branch and a POST branch, a 1200-character window ran past
    // the end of its block into the NEXT route, and the next route's `method !== 'POST'` line made this one look
    // POST-only - while the live host answers GET 200 and POST 200 for it. A gate read from a segment that crossed a
    // block boundary is not a gate.
    let depth = 1, i = from;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    let seg = src.slice(from, Math.min(i + 40, from + 4000));
    // What the block ACCEPTS, read as a union rather than as a label. A label (GET only / POST only / both) is what
    // fooled me twice on 2026-10-18: `takes_limit` and `voice_groups` are written as `if (method === 'GET') { ... }
    // else if (method === 'POST') { ... } else notAllowed()`, and a classifier that looks for a strict
    // `if (method !== 'POST') { notAllowed` line first can call those blocks POST-only while the live host answers
    // GET 200 for them (measured). So the question this test asks is only: is the verb the panel sends accepted by
    // some branch of this block?
    const strictGet = /if \(method !== 'GET'\) \{ notAllowed/.test(seg);
    const strictPost = /if \(method !== 'POST'\) \{ notAllowed/.test(seg);
    // A strict gate line is itself a `method !== ...` mention, so it has to be taken out before the branch scan or it
    // reads as acceptance of the verb it refuses. That is how `batch_file_list` (GET only, strict) would otherwise
    // look like it accepts POST.
    const branches = seg
      .replace(/if \(method !== 'GET'\) \{ notAllowed[\s\S]{0,60}?\}/g, '')
      .replace(/if \(method !== 'POST'\) \{ notAllowed[\s\S]{0,60}?\}/g, '');
    const acceptGet = strictGet || /method === 'GET'/.test(branches) || /method !== 'POST'/.test(branches);
    const acceptPost = strictPost || /method === 'POST'/.test(branches) || /method !== 'GET'/.test(branches);
    const gateLabel589 = (acceptGet && acceptPost) ? 'GET or POST'
      : acceptGet ? 'GET only' : acceptPost ? 'POST only' : 'ungated';
    names.forEach(function (n589) { out[n589] = gateLabel589; });
  }
  return out;
}

const methods = clientMethods(client);
const gates = hostGates(host);

const calls = {};
let cm;
const cre = /(?:props\.|\bthis\.)?call\("([a-z0-9_]+)"/g;
while ((cm = cre.exec(client))) calls[cm[1]] = (calls[cm[1]] || 0) + 1;

// 1. the contract itself: every verb the panel calls must be accepted by the verb it sends.
const mismatch = [];
Object.keys(calls).forEach(function (name) {
  const gate = gates[name];
  if (!gate) return;                       // a verb the host does not route here at all is another test's business
  const sent = methods[name] || 'POST';    // not in the switch = the POST default
  const ok = gate === 'ungated' || gate === 'GET or POST' ||
    (gate === 'GET only' && sent === 'GET') || (gate === 'POST only' && sent === 'POST');
  if (!ok) mismatch.push(name + ' (panel sends ' + sent + ', host answers ' + gate + ')');
});
check('T-588 contract: every read or write verb the panel calls is accepted by the verb the host answers for it (' +
  Object.keys(calls).length + ' call sites, ' + Object.keys(gates).length + ' host routes read out of the dispatcher)',
  mismatch.length === 0, mismatch.join(' ; '));

// 2. the grouped-case rule that produced six false positives on 2026-10-18 is pinned: these four verbs share one
//    switch body at lib/client.js:9883-9891 and all four must resolve to GET, because the host answers all four with
//    GET 200 / POST 405.
['queue_status', 'get_save_paths', 'voice_registry', 'storage_status'].forEach(function (v) {
  check('T-588 parse rule: ' + v + ' resolves to GET through the grouped case body (this is the rule my first audit ' +
    'got wrong, and it is why four healthy calls looked broken)',
    methods[v] === 'GET', 'resolved to ' + methods[v]);
});

// 3. the two batch-list verbs, which is where the probe that started this found nothing wrong: the panel sends GET,
//    the host answers GET only, and they agree.
['batch_file_list', 'batch_text_list'].forEach(function (v) {
  check('T-588 batch list: ' + v + ' is sent with GET and the host gate is GET only (measured 2026-10-18: GET 200, ' +
    'POST 405 - a POST probe is a probe error, not a plugin fault)',
    methods[v] === 'GET' && gates[v] === 'GET only',
    'client ' + methods[v] + ' / host ' + gates[v]);
});

// 4. takes_limit: the panel sends GET and the host accepts both verbs (measured GET 200 / POST 200), so this is legal
//    and stays legal only while the gate keeps its second branch.
check('T-588 takes_limit: the panel sends GET and the host accepts GET or POST (measured 2026-10-18 both 200) - if a ' +
  'future card makes this POST only, this pin has to be moved with it, not deleted',
  methods['takes_limit'] === 'GET' && gates['takes_limit'] === 'GET or POST',
  'client ' + methods['takes_limit'] + ' / host ' + gates['takes_limit']);

// 5. the 405 line the operator would see, and the log line the host writes for it, are still there: this is what a
//    mismatch costs, and it is the reason the contract is worth pinning.
check('T-588 the cost of a mismatch is a 405 the person can see and a host log line: the refusal text and the ' +
  'logInputRefuse call are both still in the dispatcher',
  /sendJson\(res, 405, \{ ok: false, error: 'method not allowed' \}\)/.test(host) &&
  /logInputRefuse\(String\(parts\[0\][\s\S]{0,80}method not allowed/.test(host));

// 6. T-589 (the 2026-10-18 13:32 incident): the verbs that can destroy data are named here, and every named verb
//    must be a real route in the dispatcher. A list that names a verb the host does not route is a list that has
//    drifted from the surface it is supposed to protect a person from.
const DESTRUCTIVE589 = ['delete_all_audio', 'playlist_clear', 'playlist_delete', 'set_save_path', 'takes_limit',
  'pause_fn', 'resume_fn', 'abort_fn', 'cancel_job', 'retry_job', 'endpoint_add', 'endpoint_update',
  'endpoint_remove', 'endpoint_clear', 'endpoint_promote', 'endpoint_pause', 'endpoint_resume', 'set_endpoint',
  'dispatch_tts', 'dispatch_stt', 'dispatch_task', 'dispatch_batch', 'save_voice', 'delete_voice', 'refresh_voices',
  'upload_audio', 'import_path', 'mix_audio', 'remux_video', 'convert_item', 'job_timeout', 'station_title',
  'ytdlp_path', 'capture_url'];
const notRouted589 = DESTRUCTIVE589.filter(function (v) { return !gates[v]; });
check('T-589 the destructive surface is named in this test and every named verb is a real host route (' +
  DESTRUCTIVE589.length + ' verbs, ' + (DESTRUCTIVE589.length - notRouted589.length) + ' found in the dispatcher) - ' +
  'a read-only audit must not call anything on this list',
  notRouted589.length === 0, 'named but not routed: ' + notRouted589.join(', '));

// 7. the two verbs that caused the incident, pinned as they are today: a method gate and nothing else. This pin is
//    the incident on record. When T-589 is built it must be MOVED to assert the confirm field, not deleted - the
//    same rule this file applies to takes_limit above.
function branchBody589(src, verb) {
  const at = src.indexOf("parts[0] === '" + verb + "'");
  if (at < 0) return '';
  const i = src.indexOf('{', at); let depth = 0, end = -1;
  for (let k = i; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
  }
  return end < 0 ? '' : src.slice(at, end + 1);
}
// MOVED, not deleted, on 2026-10-19, exactly as this pin promised when it was written on 2026-10-18. It used to
// record the bare fact that the two verbs that destroyed data were guarded by nothing but the HTTP method. Now it
// asserts the guard: the confirm test sits inside the branch, it sits BEFORE the destructive leg of the branch, and
// the dry-run answer is named. The incident line stays in the text so the reason for the guard is not lost with the
// assertion that used to describe the exposure.
const daBody589 = branchBody589(host, 'delete_all_audio');
const pcBody589 = branchBody589(host, 'playlist_clear');
const daGuardAt589 = daBody589.indexOf("body.confirm === 'delete_all_audio'");
const daDestroyAt589 = daBody589.indexOf('-print -delete');
const pcGuardAt589 = pcBody589.indexOf("body.confirm !== 'playlist_clear'");
const pcRewriteAt589 = pcBody589.indexOf('playlist.length = 0');
check('T-589 the incident verbs are on the list and now guarded by a confirm that names the verb, tested before the ' +
  'destructive leg runs: delete_all_audio removed 1088 files and playlist_clear retired 200 finished rows on ' +
  '2026-10-18 from an empty body with no confirmation field, and the operator\'s word on 2026-10-19 was "leave them ' +
  'gone for now - make sure this doesn\'t happen on accident in the future ?!?"',
  DESTRUCTIVE589.indexOf('delete_all_audio') >= 0 && DESTRUCTIVE589.indexOf('playlist_clear') >= 0 &&
  daBody589.length > 200 && pcBody589.length > 200 &&
  /method !== 'POST'/.test(daBody589) && /method !== 'POST'/.test(pcBody589) &&
  daGuardAt589 >= 0 && daDestroyAt589 >= 0 && daGuardAt589 < daDestroyAt589 &&
  /dry_run: true/.test(daBody589) && /confirm_required: 'delete_all_audio'/.test(daBody589) &&
  pcGuardAt589 >= 0 && pcRewriteAt589 >= 0 && pcGuardAt589 < pcRewriteAt589 &&
  /dry_run: true/.test(pcBody589) && /confirm_required: 'playlist_clear'/.test(pcBody589),
  { delete_body: daBody589.length, clear_body: pcBody589.length,
    delete_confirm_before_destroy: daGuardAt589 >= 0 && daGuardAt589 < daDestroyAt589,
    delete_destroy_at: daDestroyAt589, delete_confirm_at: daGuardAt589,
    clear_confirm_before_rewrite: pcGuardAt589 >= 0 && pcGuardAt589 < pcRewriteAt589,
    clear_rewrite_at: pcRewriteAt589, clear_confirm_at: pcGuardAt589 });

// The panel half of the same rule: a human already confirmed by pressing the control, so the panel is allowed to
// name the verb - but it must say so, and it must not report a dry run as a deletion that found nothing.
const clientSrc589 = client;   // the same text this file already read into `client` at the top - no second read
// T-762 re-cut (2026-11-09). The operator's ask was the panel control ("change the playlist button 'clear all' into
// 'clear old' - it should clear all, but the last 10 from the playlist instead"), and writing the test for the new
// `keep` field is what found the defect this file had been missing: `playlist_clear` had its own case in the panel's
// `call()` switch reading `break; // POST, no body`, while an unlisted verb falls to `default: body =
// JSON.stringify(args)`. So the panel HAS been passing `{confirm:"playlist_clear"}` since 2026-10-19 and the switch
// HAS been dropping it, which means every press of that control landed as the host's dry-run and retired nothing —
// and this pin could not see it, because it read the CALL SITE and not the body the switch built. The rule is now
// measured where the defect lived: every call the panel makes at these two verbs names the verb, AND the switch
// builds a body that carries the token.
const pcCalls589 = clientSrc589.match(/call\("playlist_clear"[\s\S]{0,260}/g) || [];
const daCall589 = clientSrc589.match(/call\("delete_all_audio"[\s\S]{0,120}/g) || [];
const clientCaseBody589 = (function (verb) {
  const at = clientSrc589.indexOf("case '" + verb + "'");
  if (at < 0) return null;                       // not listed -> the switch's default serializes the args
  return clientSrc589.slice(at, at + 1400);
});
check('T-589 the panel names the verb it was asked to run, and reports a dry run as what it is',
  /call\("delete_all_audio", \{ confirm: "delete_all_audio" \}\)/.test(clientSrc589)
  && pcCalls589.length >= 1 && pcCalls589.every(function (c589) { return /confirm: "playlist_clear"/.test(c589); })
  && /r && r\.dry_run/.test(clientSrc589) && /r367 && r367\.dry_run/.test(clientSrc589),
  { delete_call: (clientSrc589.match(/call\("delete_all_audio",[^\n]*/) || ['none'])[0].slice(0, 90),
    clear_calls: pcCalls589.map(function (c589) { return c589.replace(/\s+/g, ' ').slice(0, 110); }) });
check('T-762 the confirm survives the panel-s own call switch: a verb with its own case builds a body, it does not declare "no body" and lose the token on the way out',
  (function () {
    const pcCase589 = clientCaseBody589('playlist_clear');
    const daCase589 = clientCaseBody589('delete_all_audio');
    const pcOk589 = !!pcCase589 && /body = JSON\.stringify\(/.test(pcCase589) && /confirm/.test(pcCase589);
    const daOk589 = daCase589 === null || (/body = JSON\.stringify\(/.test(daCase589) && /confirm/.test(daCase589));
    return pcOk589 && daOk589 && daCall589.length >= 1;
  })(),
  { playlist_clear_case: String(clientCaseBody589('playlist_clear') || 'not listed').replace(/\s+/g, ' ').slice(0, 150),
    delete_all_audio_case: String(clientCaseBody589('delete_all_audio') || 'not listed, falls to the default').replace(/\s+/g, ' ').slice(0, 110) });

// --- T-818 (2026-11-13): the park vocabulary is one vocabulary in BOTH halves ---
// The host writes one word from a closed set beside whichever park key a row carries (T-810, every gate made to
// write it by T-815). The panel now prints that word in the row's own hover. A word list held in two files drifts,
// and this suite is the one that reads both files — the same argument the verb-method comparison above makes about
// methods. This is the pin that says the panel and the record name the same thing.
{
  const hostWords818 = Array.from(new Set((host.match(/park_reason = '[a-z_]+'/g) || [])
    .map(function (m818) { return m818.replace(/^park_reason = '/, '').replace(/'$/, ''); }))).sort();
  const cw818 = /var PARK_WORDS818 = \[([^\]]*)\]/.exec(client);
  const clientWords818 = cw818 ? cw818[1].split(',').map(function (w818q) {
    return String(w818q).trim().replace(/^"|"$/g, '');
  }).filter(function (w818f) { return w818f.length > 0; }).sort() : [];
  check('T-818: the panel\'s park-word list IS the host\'s closed set, word for word',
    clientWords818.length === hostWords818.length && clientWords818.join('|') === hostWords818.join('|'),
    [hostWords818.join(','), clientWords818.join(',')]);

  // (T-843 contract change, 2026-11-14) The host's park-key list is SEVEN and this read was missing one of it.
  // `endpoint_pending` is written on the row answer and parkRow sets a reason word in all three of its branches,
  // including the branch a deferred row reaches; the panel gated its word on six, so a row with no lane at all could
  // carry a reason the panel was built never to print. The operator-s word for this finding was "if items 31 is easy,
  // do it now" — the count moves 6 -> 7 on BOTH sides of this comparison, it is not relaxed on one side.
  const hostKeys818 = Array.from(new Set((host.match(/\bout\.(endpoint_wait|machine_wait|endpoint_slot_wait|endpoint_boot_wait|endpoint_pending|batch_order_wait|lane_wait) = /g) || [])
    .map(function (m818k) { return m818k.replace(/^out\./, '').replace(/ = $/, ''); }))).sort();
  const ck818 = /var PARK_KEYS818 = \[([^\]]*)\]/.exec(client);
  const clientKeys818 = ck818 ? ck818[1].split(',').map(function (k818q) {
    return String(k818q).trim().replace(/^"|"$/g, '');
  }).filter(function (k818f) { return k818f.length > 0; }).sort() : [];
  check('T-818: the panel gates the word on exactly the keys the host parks a row BY, and on nothing else',
    clientKeys818.length === 7 && hostKeys818.length === 7 && clientKeys818.join('|') === hostKeys818.join('|'),
    [hostKeys818.join(','), clientKeys818.join(',')]);
  // T-843: the deferred case is the one this comparison existed to catch, so it is named rather than left to the set
  // arithmetic. A row the pump parks with no lane must be able to get its word; a row that IS placed must not keep one.
  const deferredPark843 = /if \(!placed\) \{ job\.endpoint_pending = true; return; \}/.test(host)
    && /else if \(job\.endpoint_pending === true\) \{[\s\S]{0,240}?parkRow\(fn, job, placed\.ev\);/.test(host)
    && /job\.park_reason = 'slot';/.test(host);
  check('T-843: the host parks a deferred row WITH a word — the pump reaches parkRow on a row that has no endpoint',
    deferredPark843, deferredPark843 ? 'deferred row is parked with a word' : 'no word for a deferred row');
  const keyOnRowAnswer843 = /if \(j\.endpoint_pending === true\) out\.endpoint_pending = true;/.test(host);
  check('T-843: the row answer carries the key the panel gates on, so the gate can actually fire',
    keyOnRowAnswer843, keyOnRowAnswer843 ? 'key is on the row answer' : 'key never reaches the panel');
  const clearAtPlacement843 = /job\.park_reason = null;/.test(host);
  check('T-843: the word is cleared by the stamp that places a row, so a placed row cannot print a park reason',
    clearAtPlacement843, clearAtPlacement843 ? 'cleared at the placement stamp' : 'no clear at placement');
  const clientNamesDeferred843 = /if \(j\.endpoint_pending === true\) parts\.push\("node: unassigned/.test(client);
  check('T-843: the panel names the unassigned state on the row AND gates its word on that same key',
    clientNamesDeferred843 && clientKeys818.indexOf('endpoint_pending') >= 0,
    clientNamesDeferred843 ? 'state named, key gated' : 'state named but key not gated, or neither');

  // The word reaches the row through the gated helper and through no other door: one print site, and no place in
  // the client that copies j.park_reason straight into a sentence without asking whether the row is parked.
  const gate818 = /var pw818 = parkReasonWord818\(j\);\s*\n\s*if \(pw818\) parts\.push\("parked by: " \+ pw818\);/.test(client);
  const printSites818 = (client.match(/"parked by: "/g) || []).length;
  // Every place the client names the field at all: the two declarations, the helper's own read, and the one gated
  // print. Anything beyond those four is a second door the word could come in through.
  const doors818 = (client.match(/park_reason|parkReasonWord818/g) || []).length;
  check('T-818: the word is printed once, through the helper, and never copied unguarded',
    gate818 && printSites818 === 1 && doors818 === 4,
    [String(printSites818), String(doors818), gate818 ? 'gated' : 'no gate found']);
  console.log('  T-818 vocabulary read: host words ' + hostWords818.length + ', panel words ' + clientWords818.length +
    ', host park keys ' + hostKeys818.length + ', panel-gated keys ' + clientKeys818.length);
}

// --- T-821 (2026-11-13): the panel's wave_peaks ask and the host's ceiling, read against each other -----------
// Why this belongs HERE and not in a drawing suite. The claim is between the two halves: the panel asks for a number
// of buckets and the host decides how many it will ever answer. A drawing suite cannot see the host's ceiling and a
// host suite cannot see what the panel asks, and the failure mode this pins is exactly the one where the two numbers
// drift apart — the panel asks for more than the host will give, the host clamps it, sets truncated, and the panel
// draws the clamped answer without saying so. The operator's card answer on 2026-11-13 was to raise the panel's ask
// to the ceiling ("Raise the panel's ask to 4000") because two narrower waveform windows had just been added and a
// bar 11 ms wide cannot be measured by a bucket 30 ms wide.
{
  const askM821 = client.match(/var SCOPE_PEAKS_SLICES793 = (\d+);/);
  const maxM821 = host.match(/var PEAKS_SLICES_MAX = (\d+);/);
  const defM821 = host.match(/var PEAKS_SLICES_DEFAULT = (\d+);/);
  const minM821 = host.match(/var PEAKS_SLICES_MIN = (\d+);/);
  const ask821 = askM821 ? Number(askM821[1]) : -1;
  const cap821 = maxM821 ? Number(maxM821[1]) : -1;
  const def821 = defM821 ? Number(defM821[1]) : -1;
  const flr821 = minM821 ? Number(minM821[1]) : -1;
  check('T-821: the panel asks for a number of buckets, and that number is inside what the host will answer -- the answer is never clamped on the way back to the panel',
    ask821 > 0 && cap821 > 0 && ask821 >= flr821 && ask821 <= cap821,
    ['panel asks ' + ask821, 'host answers up to ' + cap821, 'host floor ' + flr821]);
  check('T-821: the two numbers meet at the ceiling, so a card that moves either one fails HERE and names which side moved. RE-CUT ON A DRIFT BY DESIGN: this is the check that would have caught the panel asking 2000 while the host was willing to answer 4000 (2026-11-12 to 2026-11-13), which is a whole octave of resolution left on the table',
    ask821 === cap821,
    ['panel asks ' + ask821, 'host ceiling ' + cap821]);
  check('T-821: the ask is not the lane default and not under the lane floor -- the panel names a count on purpose, which is the half of the call that T-803 added and that has been pinned ever since',
    ask821 > 0 && def821 > 0 && flr821 > 0 && ask821 !== def821 && ask821 > flr821,
    ['lane default ' + def821, 'lane floor ' + flr821, 'panel ask ' + ask821]);
  // The number has one home and one use in the panel: declared once, carried into one call, and read by nothing in
  // the drawing code. The second half is the point -- the resolution a person gets is about what the lane measured,
  // and the bars the panel lays out are decided by the canvas, which is why raising the ask cannot change the shape
  // of the strip.
  const doors821 = (client.match(/SCOPE_PEAKS_SLICES793/g) || []).length;
  const callSites821 = (client.match(/call\("wave_peaks", \{ job: id, slices: SCOPE_PEAKS_SLICES793 \}/g) || []).length;
  check('T-821: the count is declared once and reaches the lane through exactly one call, and nothing in the drawing half reads it',
    doors821 === 2 && callSites821 === 1,
    ['occurrences in the panel ' + doors821, 'call sites ' + callSites821]);
  // The host half of the contract: the clamp and its admission are still there after the panel moved to the ceiling.
  // A ceiling without an admission is a silent shorter answer, which is the failure this block exists to prevent.
  check('T-821: the host still clamps an ask above its ceiling and still says so in the answer, and the three numbers a caller may be given are unchanged by what the panel now asks',
    /if \(slices > PEAKS_SLICES_MAX\) \{ slices = PEAKS_SLICES_MAX; out\.truncated = true; \}/.test(host)
    && def821 === 120 && flr821 === 8 && cap821 === 4000,
    ['default ' + def821, 'floor ' + flr821, 'ceiling ' + cap821]);
  // The arithmetic the raise buys, stated as a number rather than as a promise. A bucket is the take divided by the
  // ask; a bar is the window divided by the bars the canvas fits (68, measured in tests/scope.test.cjs the same day).
  // They meet at take length = window_ms / 34, which is the line the client comment carries.
  const barMs821 = { 'sliding 6 s': 6000 / 68, 'sliding2 3 s': 3000 / 68, 'sliding4 1.5 s': 1500 / 68, 'sliding8 0.75 s': 750 / 68 };
  const takeS821 = [10, 30, 60, 300, 600];
  console.log('  T-821 resolution read: panel asks ' + ask821 + ' buckets, host answers up to ' + cap821
    + ' | bucket width at ' + ask821 + ': ' + takeS821.map(function (s821t) {
      return s821t + 's take ' + Math.round((s821t * 1000 / ask821) * 100) / 100 + 'ms';
    }).join(', ')
    + ' | bar widths at 68 bars: ' + Object.keys(barMs821).map(function (k821w) {
      return k821w + ' ' + Math.round(barMs821[k821w] * 100) / 100 + 'ms';
    }).join(', ')
    + ' | every bar has its own bucket while take length <= ask x window / (bars x 1000), which at '
    + ask821 + ' buckets and 68 bars is window_ms / 17: '
    + Object.keys(barMs821).map(function (k821w) { return k821w + ' ' + Math.round((barMs821[k821w] * ask821) / 1000) + 's'; }).join(', '));
}

// --- T-893: the human-facing verb reference cannot drift out of the dispatcher's reach ---
// docs/VERBS.md is a companion to this suite and not a second authority: this suite stays the executable
// contract (AGENTS.md 4.1), and the page carries what a verb is FOR and what its refusals say, which a gate
// read cannot express. What this pin buys is coverage in both directions -- every route the dispatcher
// answers is named on the page as its own table row, and the page names no route the dispatcher does not
// answer. The page's method words are deliberately NOT compared here: this suite's own gate reader has two
// known blind spots, both filed as TODOS.md part one item 77 rather than hidden by comparing a document to
// a reader that is wrong in exactly those places. (a) a compound method condition -- the job_flag trio's
// `if (qfVerb !== 'job_flags' && method !== 'POST') { notAllowed(); }` -- is not matched by either strict
// pattern, so job_flag and job_flag_clear are labelled "GET only" while the live host answers them POST
// (measured 2026-11-19: GET job_flag -> "method not allowed"). (b) a route that carries its gate on the
// SAME line as its opener is not matched by the opener regex at all, so voice_registry is missing from the
// gate map -- which is why this suite reads 102 routes where the dispatcher answers 103.
{
  const doc893 = fs.readFileSync(path.join(__dirname, '..', 'docs', 'VERBS.md'), 'utf8');
  const docRows893 = new Set((doc893.match(/^\| `([a-z0-9_]+)` \|/gm) || []).map(function (s) {
    return s.match(/`([a-z0-9_]+)`/)[1];
  }));
  // The dispatcher's own reach, read the loose way on purpose: every name it dispatches ON, including the
  // grouped openers this suite's gate reader handles and the inline-gated one it does not.
  const routeNames893 = new Set(Object.keys(gates));
  (host.match(/parts\[0\] === '([a-z0-9_]+)'/g) || []).forEach(function (s) {
    routeNames893.add(s.match(/'([a-z0-9_]+)'/)[1]);
  });
  const missing893 = Array.from(routeNames893).filter(function (v) { return !docRows893.has(v); }).sort();
  const extra893 = Array.from(docRows893).filter(function (v) { return !routeNames893.has(v); }).sort();
  check('T-893: docs/VERBS.md names every route the dispatcher answers and names no route it does not answer ('
    + routeNames893.size + ' routes, ' + docRows893.size + ' table rows)',
    missing893.length === 0 && extra893.length === 0 && docRows893.size === routeNames893.size,
    ['routes ' + routeNames893.size, 'rows ' + docRows893.size,
     'not on the page: ' + (missing893.join(', ') || 'none'),
     'on the page with no route: ' + (extra893.join(', ') || 'none')]);
  // The reference is a package file from here on: a clone that leaves docs/VERBS.md out fails this suite,
  // exactly like the two measured model records (AGENTS.md 9.1).
  check('T-893: the reference is read by this suite, so it is part of the package and its header names this suite as the authority',
    /The authority stays the suite/.test(doc893) && /verb_contract\.test\.cjs/.test(doc893),
    ['header names the executable contract']);
  console.log('  T-893 verb reference read: ' + routeNames893.size + ' dispatcher routes, '
    + docRows893.size + ' rows on the page, ' + missing893.length + ' gaps, ' + extra893.length + ' extras');
}

console.log('  client verbs with a resolved method:', Object.keys(methods).length,
  '| GET-cased:', Object.keys(methods).filter(function (k) { return methods[k] === 'GET'; }).length);
console.log('  ' + (fail ? '=== ' + fail + ' FAIL ===' : '=== ' + pass + ' pass, 0 fail ==='));
process.exitCode = fail ? 1 : 0;
