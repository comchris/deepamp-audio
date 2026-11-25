// Verifies the shell-safety helpers as shipped in lib/index.js (extracted and eval'd
// from the real source, not reimplemented) plus a real /bin/bash round-trip.
const fs = require('fs');
const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

const SRC = fs.readFileSync(require('path').join(__dirname, '..', 'lib', 'index.js'), 'utf8');
const startMark = '  // --- shell-safety helpers';
const endMark = '  // --- read helpers';const a = SRC.indexOf(startMark), b = SRC.indexOf(endMark);
if (a < 0 || b < 0 || b <= a) { console.log('FAIL: could not extract helper block'); process.exit(1); }
const block = SRC.slice(a, b) + '\nreturn { sq: sq, isSafeUrl: isSafeUrl, isSafeToken: isSafeToken, isSafePath: isSafePath };';
const H = (0, eval)('(function () {\n' + block + '\n})()');

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label); }
}

console.log('--- validators accept legitimate values ---');
ok('url http://cpu1.test:8963', H.isSafeUrl('http://cpu1.test:8963'));
ok('url http://10.0.0.10:8962', H.isSafeUrl('http://10.0.0.10:8962'));
ok('url with path', H.isSafeUrl('https://example.com/v1/models'));
ok('token qwen3-tts', H.isSafeToken('qwen3-tts'));
ok('token qwen3_asr', H.isSafeToken('qwen3_asr'));
ok('token f09bc93f7f', H.isSafeToken('f09bc93f7f'));
ok('path with space', H.isSafePath('/tmp/my file.wav'));
ok('path normal', H.isSafePath('/home/deepamp-test/projects/a/b.wav'));

console.log('\n--- validators reject injection payloads ---');
const BAD = [
  "http://x'; touch /tmp/ap_pwn; '",
  'http://x `touch /tmp/ap_pwn2`',
  'http://x;rm -rf /',
  'http://x$(id)',
  'javascript:alert(1)',
  'http://x y',
  "a'; touch /tmp/ap_pwn3; '",
  'a b',
  '$(id)',
  'a`x`',
];
for (const p of BAD) {
  const urlBad = !H.isSafeUrl(p);
  const tokBad = !H.isSafeToken(p);
  ok('rejected: ' + JSON.stringify(p).slice(0, 46), urlBad && tokBad);
}
const BADPATH = ["/tmp/a'; touch /tmp/ap_pwn4; '", '/tmp/$(id)', '/tmp/a\nb', '/tmp/a`x`', ''];
for (const p of BADPATH) ok('path rejected: ' + JSON.stringify(p).slice(0, 40), !H.isSafePath(p));

console.log('\n--- real /bin/bash round-trip: payload must stay ONE literal argument ---');
const sentinel = path.join(os.tmpdir(), 'ap_injection_sentinel');
try { fs.unlinkSync(sentinel); } catch (e) {}
// Build a command shaped exactly like the ones the plugin builds, with a hostile URL.
const hostile = "http://x'; touch " + sentinel + "; '";
const cmd = 'printf "[%s]" ' + H.sq(hostile + '/v1/models/load') + " -H '[Content-Type: application/json]'";
let out = '';
try { out = execFileSync('/bin/bash', ['-c', cmd], { encoding: 'utf8' }); }
catch (e) { out = 'EXEC ERROR ' + e.message; }
ok('payload rendered as one literal argument: ' + JSON.stringify(out.slice(0, 60)),
  out.indexOf('[' + hostile + '/v1/models/load]') === 0);
let sentinelExists = false;
try { fs.statSync(sentinel); sentinelExists = true; } catch (e) {}
ok('injected touch DID NOT run', !sentinelExists);

// Second round-trip: hostile output path in the base64 write command shape.
const hostile2 = "/tmp/x'; touch " + sentinel + "; '";
const cmd2 = 'printf "[%s]" ' + H.sq(hostile2);
let out2 = '';
try { out2 = execFileSync('/bin/bash', ['-c', cmd2], { encoding: 'utf8' }); } catch (e) { out2 = 'ERR'; }
ok('hostile path literal', out2 === '[' + hostile2 + ']');
let s2 = false;
try { fs.statSync(sentinel); s2 = true; } catch (e) {}
ok('injected touch (path) DID NOT run', !s2);

// Prove the OLD naive shape WAS vulnerable, so the fix is meaningful.
const naive = "printf '[%s]' '" + hostile + "/v1/models/load'";
let naiveOut = 'ERR';
try { naiveOut = execFileSync('/bin/bash', ['-c', naive], { encoding: 'utf8' }); } catch (e) { naiveOut = 'ERR ' + (e.message || '').slice(0, 30); }
let naiveRan = false;
try { fs.statSync(sentinel); naiveRan = true; } catch (e) {}
ok('control: old unescaped interpolation executed the payload (so the fix matters)', naiveRan);
console.log('  naive output: ' + JSON.stringify(naiveOut).slice(0, 70));
try { fs.unlinkSync(sentinel); } catch (e) {}

// T-252: the capability reader now writes the served page to a generated file and removes it.
// Both new shell legs go through sq(). Round-trip the EXACT command shapes against /bin/bash,
// with `curl` shadowed by a shell function so nothing here ever touches a network.
console.log('\n--- T-252 round-trips: the reader page fetch (-o <tmp>) and its guarded removal ---');
const s3 = path.join(os.tmpdir(), 'ap252_sentinel_fetch');
const s4 = path.join(os.tmpdir(), 'ap252_sentinel_rm');
try { fs.unlinkSync(s3); } catch (e) {}
try { fs.unlinkSync(s4); } catch (e) {}
const hostileTmp = "/home/deepamp-test/.dsh/deepamp-audio/cap_page_1-1'; touch " + s3 + "; '.html";
const hostileUrl = "http://x'; touch " + s4 + "; '/";
const curlShim = "curl() { printf '[%s]' \"$@\"; }";
const capCmd = curlShim + ' ; curl -sS -m 10 --max-filesize 4194304 -o ' + H.sq(hostileTmp)
  + " -w '%{http_code} %{size_download} %header{content-length}' " + H.sq(hostileUrl);
let out3 = '';
try { out3 = execFileSync('/bin/bash', ['-c', capCmd], { encoding: 'utf8' }); } catch (e) { out3 = 'EXEC ERROR ' + e.message; }
ok('T-252 page fetch: -o <tmp> and the URL each stay ONE literal argument (curl receives exactly 10 args, the hostile path and the hostile url intact)',
  out3 === '[-sS][-m][10][--max-filesize][4194304][-o][' + hostileTmp + '][-w][%{http_code} %{size_download} %header{content-length}][' + hostileUrl + ']',
  );
let s3ran = false, s4ran = false;
try { fs.statSync(s3); s3ran = true; } catch (e) {}
try { fs.statSync(s4); s4ran = true; } catch (e) {}
ok('T-252 page fetch: the payload inside the generated path did NOT run', !s3ran);
let out4 = '';
try { out4 = execFileSync('/bin/bash', ['-c', 'rm -f ' + H.sq("/home/deepamp-test/.dsh/deepamp-audio/cap_page_1-1'; touch " + s4 + "; '.html")], { encoding: 'utf8' }); } catch (e) { out4 = 'ERR'; }
let s4b = false;
try { fs.statSync(s4); s4b = true; } catch (e) {}
ok('T-252 removal: `rm -f \'+sq(path)` renders the hostile path as one literal and the payload did NOT run', !s4b);
try { fs.unlinkSync(s3); } catch (e) {}
try { fs.unlinkSync(s4); } catch (e) {}

console.log('\n=== ' + pass + ' pass, ' + fail + ' fail ===');
process.exitCode = fail ? 1 : 0;
