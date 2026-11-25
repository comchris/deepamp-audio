// T-300 U-9 / T-299 (2026-10-12): the visualizer strip. This suite tests STRUCTURE AND WIRING, never
// pixels — the panel harness has no canvas and no 2d context, and that is exactly the point: the strip has
// to be honest about what it is doing (which mode, whether a graph exists, whether a loop is running) and
// it has to degrade instead of throwing when the browser cannot help.
//
// The rules it pins, in the order they appear in artifacts/SCOPE_VIEW_DESIGN_20261012.md section 5 and in
// the user's own answers the same evening:
//   1. four modes, cycled by ONE click in ONE direction, the mode name printed, the mode persisted.
//   2. off means off: no canvas, no AudioContext, no animation loop — the tap is discarded, not parked.
//      U-18 (user 2026-10-13 01:39) split this rule in two: off is still nothing at all, but a SELECTED mode
//      now draws even while nothing is playing, because the complaint was that an idle strip printed an orange
//      message instead of showing the visualizer the user had picked.
//   3. a live mode restored from storage does NOT open an audio graph, because a browser only builds one on
//      a user gesture; the strip says so instead of drawing a flat line.
//   4. the waveform mode draws its own baseline and says plainly whether this lane can answer the
//      peaks read yet (T-303 wave_peaks is written but not loaded, so today it says it cannot).
//   5. no Web Audio and no canvas on this browser: the strip reports it and nothing throws.
//   6. the loop draws EVERY frame the display offers (U-18: the oscilloscope framerate looked slow), and it
//      stops when the page is hidden.
//   8. U-18 amplitude contract, the REVERSAL recorded out loud: the user 2026-10-12 22:42 said fixed amplitude
//      and no gain; their own 2026-10-13 01:52 reversed it (auto-gain after all). The trace is scaled; silence
//      is not; the peak meter under it stays RAW.
//   7. THE SAFETY RULE: createMediaElementSource appears nowhere in the client. The tap is captureStream.
// Usage: node tests/scope.test.cjs [path/to/client.js]
const path = require('path');
const fs = require('fs');
const { createRuntime, loadClient, openAllSections } = require('./react_shim.cjs');

const TARGET = process.argv[2] || path.join(__dirname, '..', 'lib', 'client.js');

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

// ------------------------------------------------------------------ the fake browser pieces
// Only what this feature touches. The analyser counts its own calls so the frame budget is measurable,
// and the AudioContext counts builds and closes so "off means off" is a fact rather than a claim.
function makeBrowser(opts) {
  opts = opts || {};
  const b = {
    store: Object.assign(Object.create(null), opts.storage || {}),
    rafScheduled: 0, rafCancelled: 0, rafQueue: [], rafId: 0,
    ctxBuilt: 0, ctxClosed: 0, ctxResumed: 0,
    freqCalls: 0, timeCalls: 0, connects: [], sources: 0, silent: false, peaksCalls: 0, peaksUrls: [],
    usedMediaElementSource: false,
    fillRects: 0, strokes: 0, paths: 0, transforms: 0, badRects: 0, fillTexts: 0, textLog: [], clipLog: [], clipStack: [], clipRect: null, pendingRect: null,
    // U-18: the two-channel tap is a splitter with two outputs, so the harness has to count the splitter and
    // remember WHICH output each analyser was hung on - feeding one analyser from the stream would be the
    // browser's mono downmix, and a second line drawn from it would be a copy, not a channel.
    splitters: 0, splitOut: [], analysers: 0, strokeLog: [], strokePaths: [], peaksBodies: [],
    trace: [], yMin: Infinity, yMax: -Infinity,
    // T-305: the canvas state the panel uses, and what it drew where. off is the band the context is
    // currently translated into; rectLog and absTrace carry it with every drawing so a check can say "the
    // trace lives below the clock band" as a measured fact.
    saves: 0, restores: 0, translates: 0, off: 0, ctxStack: [], rectLog: [], absTrace: [],
    // T-541: the waterfall keeps its history in the canvas, so its one real act is a self-copy. Without this the
    // suite could only read the client's source text, which is not a measurement.
    imageCopies: 0, imageLog: [],
    // T-542 (2026-10-17): the llama mode keeps its spectrogram history in a canvas of its own, built with
    // document.createElement and never shown. Its drawings are logged SEPARATELY from the visible canvas, because
    // "the newest column is at x 177 on a 200 px strip" and "the animal is centred" are two different claims
    // bitmaps, and reading them out of one log would let a mode fail by painting the right thing in the wrong place.
    histRects: 0, histRectLog: [], histCopies: 0, histImageLog: [], offscreenBuilt: 0,
    // T-558 (2026-10-17): a take can now put two CHANNELS on the canvas at once -- the wall shows both, the floor
    // shows the right one -- and each is kept in its own history bitmap. "The floor mirrors the right channel" is a
    // claim about WHICH bitmap a pixel was painted into and WHICH bitmap a copy was read out of, and a single shared
    // log cannot answer either question. So every offscreen bitmap the client builds gets its own context, its own
    // index, and its own log. The shared logs stay exactly as they were, because every older check reads them; the
    // bitmap index is appended as an extra field, which no existing filter looks at.
    histBitmaps: [], histSrcLog: [], visSrcLog: [],
  };
  global.localStorage = {
    getItem: function (k) { return k in b.store ? b.store[k] : null; },
    setItem: function (k, v) { b.store[k] = String(v); },
    removeItem: function (k) { delete b.store[k]; },
  };
  global.requestAnimationFrame = function (fn) {
    b.rafId++; b.rafScheduled++; b.rafQueue.push([b.rafId, fn]); return b.rafId;
  };
  global.cancelAnimationFrame = function (id) {
    b.rafCancelled++; b.rafQueue = b.rafQueue.filter(function (x) { return x[0] !== id; });
  };
  // A canvas host node that CAN give a 2d context. Without this the draw path stops at its own guard (the
  // honest case) and the frame-budget assertions would measure nothing at all.
  // T-305: the panel now draws the clock band at the top of the canvas and TRANSLATES the rest of the canvas
  // below it, so the fake context has to model the canvas state it actually uses - save / translate / restore -
  // and it has to remember the current offset, because "the trace is drawn below the clock band" is a fact a
  // test should be able to read off the drawing, not off the source text.
  const C2d = function () { this.fillStyle = ''; this.strokeStyle = ''; this.lineWidth = 1; };
  C2d.prototype.setTransform = function () { b.transforms++; b.off = 0; };
  C2d.prototype.save = function () { b.saves++; b.ctxStack.push(b.off); b.clipStack.push(b.clipRect ? b.clipRect.slice() : null); };
  C2d.prototype.restore = function () { b.restores++; if (b.ctxStack.length) b.off = b.ctxStack.pop(); if (b.clipStack.length) b.clipRect = b.clipStack.pop(); };
  C2d.prototype.translate = function (dx, dy) { b.translates++; b.off += (dy | 0); };
  C2d.prototype.fillRect = function (x, y, w, h) {
    b.fillRects++;
    // T-684 addendum 2: the ORDER a face draws in is part of its design, and two separate logs cannot show an order
    // across them. Both logs now carry the same counter: entry k of either one names when it was drawn, so a pin can
    // ask which came first - the print, or the seam that is supposed to be visible over it.
    b.seq = (b.seq || 0) + 1;
    b.rectLog.push([x, y, w, h, b.off, String(this.fillStyle || ''), b.seq]);
    if (!(w > 0) || !(h > 0) || !isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) b.badRects++;
  };
  // T-684 addendum 2: the flip board asks the canvas for the ink box of the glyph it is about to print. The
  // operator's ruling is "i think it needs to be vertically centered, the numbers are currently not center", and
  // centring an em box is not centring ink - so what the canvas answers is the only way to know whether the panel's
  // own assumed ratio is true for this browser. The stub deliberately answers a face that is NOT that ratio: the
  // ink of this digit covers 0.78 of the em, where the client's FLAP_CAP684 assumes 0.73. That disagreement is the
  // case the build has to survive: the card's cap height is the authority, so the print is fitted to the card and
  // then placed by its own ink. The width answer keeps the advance the client's own ratio claims, so the width path
  // does not fire and only the height path is exercised.
  C2d.prototype.measureText = function (t689m) {
    var mm689 = /([0-9.]+)px/.exec(String(this.font || ''));
    var fsz689 = mm689 ? parseFloat(mm689[1]) : 0;
    b.measureTexts = (b.measureTexts || 0) + 1;
    if (!fsz689) return { width: 0 };
    return { width: String(t689m).length * fsz689 * 0.60,
      actualBoundingBoxAscent: fsz689 * 0.78, actualBoundingBoxDescent: 0 };
  };
  C2d.prototype.fillText = function (t, x, y) {
    b.fillTexts++; b.seq = (b.seq || 0) + 1;
    b.textLog.push([String(t), Math.round(x), Math.round(y), String(this.font || ''),
      String(this.textAlign || ''), String(this.textBaseline || ''), String(this.fillStyle || ''), b.seq,
      // T-725: the clip this print is under, kept the way the translate offset is kept. Appended as an
      // extra field, because every older check reads the fields before it.
      b.clipRect ? b.clipRect.slice() : null]);
  };
  // T-684: the split-flap flip paints with a CLIP (the arriving card covers the leaving one, drawn with
  // g.rect + g.clip), and until now the stub had neither verb, so the flip path could not be reached from the
  // suite at all. The clip is recorded as it is given, because a flip that clips wrong is a half-drawn card.
  // T-725: the clip a drawing is under is part of the drawing. The rect a path was given is kept, and clip() makes
  // it the clip in effect until the save/restore that wrapped it is unwound - which is what a real canvas does,
  // and the only way a check can tell a face printed in a band from a face printed across the whole card.
  C2d.prototype.rect = function (x, y, w, h) { b.clipLog.push([x, y, w, h]); b.pendingRect = [x, y, w, h]; };
  C2d.prototype.clip = function () { b.clips = (b.clips || 0) + 1; if (b.pendingRect) { b.clipRect = b.pendingRect.slice(); b.pendingRect = null; } };
  C2d.prototype.beginPath = function () {            // a new path starts a new trace, as in a real canvas
    b.paths++; b.trace = []; b.pathAbs = []; b.yMin = Infinity; b.yMax = -Infinity; b.pendingRect = null;
  };
  C2d.prototype.moveTo = function (x, y) { b.trace.push([x, y]); b.absTrace.push([x, y + b.off]); b.pathAbs = (b.pathAbs || []).concat([[x, y + b.off, 'M']]); if (y < b.yMin) b.yMin = y; if (y > b.yMax) b.yMax = y; };
  C2d.prototype.lineTo = function (x, y) { b.trace.push([x, y]); b.absTrace.push([x, y + b.off]); b.pathAbs = (b.pathAbs || []).concat([[x, y + b.off, 'L']]); if (y < b.yMin) b.yMin = y; if (y > b.yMax) b.yMax = y; };
  // T-684: the stroke log keeps the path and the width with the ink, because a design pass on the panel's faces
  // is only honest if the drawing can be rendered back out of what was recorded. A stroke with no path is a
  // colour sample; a stroke with its path is the wire that was drawn.
  C2d.prototype.stroke = function () {
    b.strokes++; b.strokeLog.push(String(this.strokeStyle));
    b.strokePaths.push({ ink: String(this.strokeStyle), width: this.lineWidth, path: (b.pathAbs || []).slice() });
  };
  // (the one fillText this stub has is the one above, and it keeps the drawing order with it.)
  C2d.prototype.drawImage = function () {
    b.imageCopies++;
    b.imageLog.push(Array.prototype.slice.call(arguments, 1).map(function (n) { return Number(n); }));
    // Paired one-for-one with imageLog: entry k of this says WHICH offscreen bitmap entry k of that was copied FROM.
    // -1 means the source was not an offscreen bitmap this harness built.
    b.visSrcLog.push((arguments[0] && typeof arguments[0].__ix === "number") ? arguments[0].__ix : -1);
  };
  b.c2d = new C2d();
  // The offscreen bitmap's context: the same drawing verbs, logged somewhere else on purpose.
  const Hist2d = function (ix542) { this.fillStyle = ''; this.ix = ix542; };
  Hist2d.prototype.setTransform = function () {};
  Hist2d.prototype.save = function () {};
  Hist2d.prototype.restore = function () {};
  Hist2d.prototype.fillRect = function (x, y, w, h) {
    b.histRects++;
    b.histRectLog.push([x, y, w, h, 0, String(this.fillStyle || ''), this.ix]);
    if (!(w > 0) || !(h > 0) || !isFinite(x) || !isFinite(y) || !isFinite(w) || !isFinite(h)) b.badRects++;
  };
  Hist2d.prototype.drawImage = function () {
    b.histCopies++;
    b.histImageLog.push(Array.prototype.slice.call(arguments, 1).map(function (n) { return Number(n); }));
    b.histSrcLog.push((arguments[0] && typeof arguments[0].__ix === "number") ? arguments[0].__ix : -1);
  };
  if (opts.webAudio !== false) {
    const Analyser = function () {
      this.fftSize = 0; this.frequencyBinCount = 512; this.smoothingTimeConstant = 0;
      this.minDecibels = -100;
      // T-793 seam: b.anMaxDb lets a fixture name the ceiling of the window this analyser reports. The default is
      // the -30 dB this mock has always carried and every other test in this file reads that default; the seam
      // exists because the panel maps a bar over its OWN window (-70 dB to 0 dB), so inside a -30 dB ceiling a
      // byte at 255 reaches 0.57 of a bar and no bar in this suite has ever reached its tip. A colour claim about
      // the top of a ramp cannot be made from a bar that never gets there.
      this.maxDecibels = (typeof b.anMaxDb === 'number') ? b.anMaxDb : -30;
      // Which analyser this is, so a test can give the two channels of one take DIFFERENT content. Both
      // analysers of a real tap are the same class, so the only honest way to tell them apart is the order the
      // client asked for them in - and the client asks for the left one first.
      this._i = b.analysers++;
    };
    // b.silent is read at call time, so a test can turn a live tap into a dead one mid-run - which is what
    // a capture taken before the media pipeline was attached does to the panel in a real browser.
    Analyser.prototype.getByteFrequencyData = function (a) {
      b.freqCalls++;
      if (b.silent) { for (let i = 0; i < a.length; i++) a[i] = 0; return; }
      // T-429 seam: b.hotBins names EXACTLY which FFT bins carry energy. The band map is only testable when the
      // answer is unambiguous - "bins 0..39 are hot" cannot tell a bar that owns a bin from a bar that borrows one.
      // T-539: b.hotBinValue lets a fixture name HOW LOUD a named bin is, not only which bins are hot. The mock's
      // window is -100 dB to -30 dB, so a byte of 200 is a bin at -45 dB and a byte of 255 is a bin at the ceiling.
      // The two level mappings this mode offers differ by fractions of a bar at -45 dB and by whole segments at the
      // ceiling, and a pin can only claim what the ladder is tall enough to show.
        // T-558: the same seam for the RIGHT analyser. b.hotBinsR names which bins the right channel carries, and an
        // EMPTY array means it carries none -- which is what a mono take does to a splitter's second output. Without
        // this, both analysers of a tap answer the same spectrum and no check can tell a picture of the right channel
        // from a picture of the left one drawn twice.
      const hot542 = (this._i >= 1 && b.hotBinsR) ? b.hotBinsR : b.hotBins;
      if (hot542) {
        for (let i = 0; i < a.length; i++) a[i] = 0;
        const hotValue539 = (this._i >= 1 && typeof b.hotBinValueR === 'number') ? b.hotBinValueR
          : ((typeof b.hotBinValue === 'number') ? b.hotBinValue : 200);
        hot542.forEach(function (k) { a[k] = hotValue539; });
        return;
      }
      for (let i = 0; i < a.length; i++) a[i] = (i < 40) ? 200 : 0;
    };
    Analyser.prototype.getByteTimeDomainData = function (a) {
      b.timeCalls++;
      if (b.silent) { for (let i = 0; i < a.length; i++) a[i] = 128; return; }
      // Voice-shaped, not synthetic noise: a 200 Hz carrier (period 240 samples at 48 kHz) at amplitude 24,
      // plus the 4 kHz consonant ripple (period 12) at amplitude 8. That ripple is exactly what made the raw
      // 1024-sample trace look like a crowd of single vertical lines instead of one wave.
      // 0 is a real value here (it means "carrier off"), so the defaults test for undefined, not for 0.
      const ampC = (b.tdAmp === undefined) ? 24 : b.tdAmp;
      const perC = (b.tdPeriod === undefined) ? 240 : b.tdPeriod;
      const ampR = (b.tdRippleAmp === undefined) ? 8 : b.tdRippleAmp;
      const perR = (b.tdRipple === undefined) ? 12 : b.tdRipple;
      // The second analyser of a tap is the right channel. tdAmpR lets a test make the two channels differ,
      // which is the only way to prove the strip drew a real second channel and not the same wave twice.
      const ampC2 = (b.tdAmpR === undefined) ? ampC : b.tdAmpR;
      const ampR2 = (b.tdRippleAmpR === undefined) ? ampR : b.tdRippleAmpR;
      const useC = (this._i >= 1) ? ampC2 : ampC;
      const useR = (this._i >= 1) ? ampR2 : ampR;
      for (let i = 0; i < a.length; i++) {
        a[i] = 128 + useC * Math.sin(2 * Math.PI * i / perC) + useR * Math.sin(2 * Math.PI * i / perR);
      }
    };
    Analyser.prototype.connect = function (n) { b.connects.push(n); };
    Analyser.prototype.disconnect = function () { this.disconnected = true; };
    const Ctx = function () {
      b.ctxBuilt++; this.sampleRate = 24000; this.state = 'suspended';
      // T-793 seam: the last context this fake browser built. The counts above are what the suite's claims about
      // the media graph are made of and they are unchanged; this is only a handle, so a fixture can reach the
      // analyser this context handed the panel and change the one number the panel reads off it live -- its dB
      // window -- instead of guessing what a bar can reach inside a window it never chose.
      b.audioCtx = this;
    };
    Ctx.prototype.createAnalyser = function () { this.an = new Analyser(); return this.an; };
    // The source node has to be connectable, or the client's own connect() call throws and the tap is
    // dropped - which is exactly the failure this suite must not mistake for a design decision.
    Ctx.prototype.createMediaStreamSource = function () {
      b.sources++;
      return { connect: function (n) { b.connects.push(n); }, disconnect: function () {} };
    };
    // A splitter whose outputs can be addressed, because the client's stereo tap connects (output -> analyser)
    // with explicit channel numbers. b.splitOut records those pairs so the suite can see 0 -> left and
    // 1 -> right instead of trusting a comment.
    Ctx.prototype.createChannelSplitter = function (channels) {
      b.splitters++; b.splitChannels = channels;
      return {
        connect: function (dst, from, to) { b.connects.push(dst); b.splitOut.push([from, to]); },
        disconnect: function () { this.disconnected = true; },
      };
    };
    Ctx.prototype.createGain = function () {
      return { gain: { value: 1 }, connect: function (n) { b.connects.push(n); }, disconnect: function () {} };
    };
    Ctx.prototype.resume = function () { b.ctxResumed++; this.state = 'running'; };
    Ctx.prototype.close = function () { b.ctxClosed++; this.state = 'closed'; };
    // The rule is proven by absence, so the fake browser does not even offer the dangerous call: if the
    // client ever asked for it the fake would throw and the suite would say so.
    global.AudioContext = Ctx;
  } else {
    delete global.AudioContext;
    delete global.webkitAudioContext;
  }
  if (opts.devicePixelRatio) global.window = { devicePixelRatio: opts.devicePixelRatio };
  b.doc = {
    hidden: false, addEventListener: function () {}, removeEventListener: function () {},
    createElement: function (tag) {
      if (String(tag).toLowerCase() === 'canvas') {
        const hctx542 = new Hist2d(b.histBitmaps.length);
        b.histBitmaps.push(hctx542);
        b.offscreenBuilt++;
        return {
          tagName: 'CANVAS', width: 0, height: 0, style: {}, __ix: hctx542.ix,
          getContext: function (kind) { return kind === '2d' ? hctx542 : null; },
        };
      }
      return { tagName: String(tag).toUpperCase(), style: {}, setAttribute: function () {}, click: function () {}, remove: function () {} };
    },
  };
  // T-689 addendum (the operator's look at the live panel, verbatim: "we should NOT make the canvas white aswell,
  // make it default background color of the window"): the light board asks the surface the panel sits on, read off the
  // element tree. The fixture answers that read through document.body, so the pin on the light face measures a real
  // answer and not the no-answer fallback.
  b.surfaceBg689 = "#12171a";
  b.doc.body = { __bg: b.surfaceBg689 };
  if (typeof global.getComputedStyle !== "function") {
    global.getComputedStyle = function (el68x) {
      return {
        backgroundColor: (el68x && el68x.__bg) || "rgba(0, 0, 0, 0)",
        borderLeftWidth: "0px", borderRightWidth: "0px", borderTopWidth: "0px", borderBottomWidth: "0px",
      };
    };
  }
  b.frames = function (n) {
    for (let k = 0; k < n; k++) {
      const q = b.rafQueue; b.rafQueue = [];
      for (let i = 0; i < q.length; i++) q[i][1](k * 16);
    }
  };
  return b;
}
const SCOPE546_MODES = ['spectrum', 'oscilloscope', 'static', 'vu_led', 'vu_needle'];
// The toggle box carries TWO classes (the shared one and its own), and byCls441 compares a whole className.
// These two helpers are the honest way to reach a multi-class control: match one class out of the list, and
// read a hover off whatever element was found instead of assuming it exists.
function byClsOne546(mm, cls) {
  return (mm.created() || []).filter(function (e) {
    return e && e.props && String(e.props.className || '').split(/\s+/).indexOf(cls) >= 0;
  });
}
function tipOf546(e) { return (e && e.props && e.props.title) ? String(e.props.title) : ''; }
// A bar in this mode is a COLUMN of 3 px lit segments, never one rect, so a bar measurement counts segments per
// column and reports the tallest column plus the total. Lit means the meter's own colours: green, amber, red.
// A peak-hold cap (#e8e8e8) is level history and an unlit slot (#1d211d) is level absence - neither is level.
function scopeBarTally546(bb) {
  const per = {};
  let lit = 0;
  bb.rectLog.forEach(function (r) {
    if (r[5] !== '#00c800' && r[5] !== '#ffd800' && r[5] !== '#e8320f') return;
    lit++;
    const k = String(r[0]);
    per[k] = (per[k] || 0) + 1;
  });
  const keys = Object.keys(per);
  return { lit: lit, bars: keys.length, tall: keys.reduce(function (a, k) { return Math.max(a, per[k]); }, 0) };
}
function teardown() {
  delete global.localStorage; delete global.requestAnimationFrame; delete global.cancelAnimationFrame;
  delete global.AudioContext; delete global.webkitAudioContext; delete global.window;
}

// ------------------------------------------------------------------ one mounted panel, with lookups
async function mount(b, opts) {
  opts = opts || {};
  const calls = [];
  // The shim hands a ref the host node it builds. By default that is { tagName } only - which is the real
  // harness case, where a canvas cannot give a 2d context. Scenario E keeps that default on purpose.
  const shim = createRuntime({
    makeHostNode: function (node) {
      const host = { tagName: node.type };
      // T-556: the harness used to hand a ref a node that could not be scrolled at all, so a panel act whose whole
      // job is "bring this group into view" was unmeasurable here and could only be asserted in a comment. The node
      // now answers scrollIntoView and the call is logged, which is what lets the double-click pin ask whether the
      // gesture really asked for the scroll instead of trusting that it did.
      host.scrollIntoView = function (o556) { (b.scrollLog = b.scrollLog || []).push([node.type, (o556 && o556.block) || '']); };
      if (node.type === 'canvas' && opts.canvas2d) host.getContext = function () { return b.c2d; };
      if (node.type === 'audio') {
        // T-305: a real <audio> with no source is PAUSED. The harness used to hand back a node that claimed it
        // was not, which is a fiction a display mark can read as "the file is running" and paint a running
        // triangle for a player that has nothing loaded. armAudio() still flips it when a test wants playing.
        host.paused = true; host.ended = false; host._ls = {};
        host.addEventListener = function (t, fn) { (host._ls[t] = host._ls[t] || []).push(fn); };
        host.removeEventListener = function () {};
        // fire() plays the role of the browser: the panel arms its tap on these events, so a test has to be
        // able to deliver one.
        host.fire = function (t) { (host._ls[t] || []).forEach(function (f) { f({ type: t }); }); };
        if (typeof opts.audioTracks === 'number') {
          host._tracks = opts.audioTracks;
          host.captureStream = function () {
            b.streams = (b.streams || 0) + 1;
            const tr = []; for (let i = 0; i < (host._tracks | 0); i++) tr.push({ enabled: true, kind: 'audio', readyState: 'live' });
            host._tracksList = tr;
            return { getAudioTracks: function () { return tr; }, getTracks: function () { return tr; }, id: 'tap' };
          };
        }
      }
      return host;
    },
  });
  const client = loadClient(shim, {
    target: TARGET,
    document: b.doc,
    // T-677 (2026-10-28): the timer service is handed to the CLIENT LOAD, not to the mount, because
    // loadClient is where the shim wires ctx services. With no handle here the shim gives its own no-op
    // timer, the panel's idle clock tick never arms, and a check on it would be a source-text assertion.
    timer: opts.timer,
    fetch: function (url, o) {
      const u = String(url); calls.push(((o && o.method) || 'GET') + ' ' + u);
      let body = { ok: true };
      if (/get_endpoints/.test(u)) body = { tts: { url: 'http://cpu1.test:8963' }, stt: { url: 'http://cpu1.test:8962' } };
      else if (/server_status/.test(u)) body = { tts: { ok: true, loaded_model: 'm1' }, stt: { ok: true } };
      else if (/get_models/.test(u)) body = { models: [{ id: 'm1', loaded: true }] };
      else if (/refresh_voices/.test(u)) body = { voices: ['voy_janeway'], builtins: [] };
      else if (/playlist_list/.test(u)) body = { items: opts.items || [], queues: { tts: { paused: false, running: null, queued: 0 }, stt: { paused: false, running: null, queued: 0 } } };
      else if (/play_job/.test(u)) body = { ok: true, route_url: opts.routeUrl || '/deepamp/ap-9001', job_id: 'ap-9001' };
      // T-303 wave_peaks: the host verb exists in code but is NOT loaded in this harness yet, so the honest
      // default is the refusal the panel has to survive. A suite that wants the answered shape passes peaks in.
      else if (/wave_peaks/.test(u)) {
        b.peaksCalls = (b.peaksCalls || 0) + 1; b.peaksUrls.push(u);
        b.peaksBodies.push(String((o && o.body) || ''));
        body = (opts.peaks === undefined)
          ? { ok: false, error: 'unknown route: wave_peaks' }
          : { ok: true, job: 'ap-9001', peaks: opts.peaks, channels: (opts.channels === undefined ? 1 : opts.channels),
              sample_rate: opts.sampleRate || 48000, duration_s: (opts.durationS === undefined ? 3.44 : opts.durationS),
              bytes: opts.bytes, note: '', sampled: opts.peaks.length, stride: 1 };
      }
      else if (/queue_status/.test(u)) body = { ok: true, queues: { tts: { queued: 0, paused: false, running_ids: [] }, stt: { queued: 0, paused: false, running_ids: [] } } };
      else if (/storage_status/.test(u)) body = { ok: true, base: '/home/deepamp-test/.dsh/deepamp-audio', writable: true };
      return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
    },
  });
  const comp = client.apply();
  if (!comp) throw new Error('panel did not register');
  let mark = 0;
  function commit() {
    const bag = {}; const start = shim.rt.created.length;
    shim.render(comp(), bag); shim.runEffects();
    mark = start;
    return created();
  }
  function created() { return shim.rt.created.slice(mark); }
  function hasCls(c, want) { return String(c || '').split(/\s+/).indexOf(want) >= 0; }
  function els(cls) { return created().filter(function (e) { return e.props && hasCls(e.props.className, cls); }); }
  function ownText(e) { const c = e.props && e.props.children; return (typeof c === 'string') ? c : ''; }
  function canvases() { return created().filter(function (e) { return e.type === 'canvas'; }); }
  function strip() { const s = els('audio-play-scope'); return s.length ? s[s.length - 1] : null; }
  // T-307 CONTRACT CHANGE (user 2026-10-13, 05:15): "remove osciloscope text fully - no need to write the
  // text - we can see it", and the mode stays readable in the canvas hover. There is no mode CAPTION any
  // more, so the mode is read out of the strip's own hover. Every cycle check below keeps its meaning.
  function modeLabel() {
    const s = els('audio-play-scope');
    if (s.length) {
      const m = String(s[s.length - 1].props.title || '').match(/^visualizer: currently (.+)\. Click to cycle/);
      if (m) return m[1];
    }
    const c = canvases();
    if (c.length) {
      // T-556 re-point: this pattern used to demand that "click to change it" be the END of the hover. The hover now
      // carries the double-click sentence too, so an anchored pattern would silently read the empty string and every
      // canvas-mode read in this file would answer "no mode" without saying so.
      const m2 = String(c[c.length - 1].props.title || '').match(/^the visualizer is drawing: (.+?)\u00B7 click to change it/);
      if (m2) return m2[1];
    }
    return '';
  }
  // T-305 (user 2026-10-13, 03:39): "we only need one status / feedback display". The strip's own amber
  // caption line is GONE, and every sentence the panel prints about itself now lives in the single status
  // line beside the visualizer. So noteText() reads THAT line - the checks that ask "what does the panel say
  // about this state" keep asking the same question of the place where it is now said.
  // The mono / stereo pair is two spans inside one element, so its text has to be read from the children -
  // ownText() on the parent alone would answer the empty string, which is not the same as "nothing printed".
  function chanPairText(e) {
    if (!e) return '';
    return (e.props.children || []).map(function (c) { return (typeof c === 'string') ? c : ownText(c); }).join('');
  }
  function chanLit(e, cls) {
    const kids = ((e && e.props && e.props.children) || []).filter(function (c) { return c && c.props && c.props.className === cls; });
    return kids.length === 1 ? kids[0].props.style.color : 'missing';
  }
  function noteText() { const n = els('audio-play-now'); return n.length ? ownText(n[n.length - 1]) : ''; }
  function clickStrip() {
    const s = strip();
    if (s && typeof s.props.onClick === 'function') { s.props.onClick(); commit(); }
  }
  // The shim hands the panel a host node per ref ({ tagName }), created once and reused across renders.
  // Arming it is how this suite says "this browser can tap the element", which is the only capability the
  // strip actually asks for.
  // The audio host node already exists by the time a test can reach it, so re-arming means changing the
  // number of audio tracks its captureStream answers - 0 is the state a real element is in before it has
  // ever loaded a file.
  // T-405 (user 2026-10-15): the panel holds two media elements now — the take's, rendered first, and the
  // station's, rendered second. The strip follows the element the panel is PRESENTING, and with no station
  // audible that is the take's, so arming has to arm that one. Arming the station instead would test a
  // capability the strip is not asking for.
  function armAudio(trackCount) {
    const all = shim.rt.created.filter(function (e) { return e.type === 'audio'; });
    if (!all.length) return null;
    const last = all[0];
    const node = (last.props && last.props.ref && last.props.ref.current) ? last.props.ref.current : null;
    if (!node) return null;
    node.paused = false; node.ended = false;
    if (typeof trackCount === 'number') node._tracks = trackCount;
    return node;
  }
  return {
    shim: shim, client: client, comp: comp, calls: calls,
    commit: commit, created: created, els: els, canvases: canvases, strip: strip,
    modeLabel: modeLabel, noteText: noteText, chanPairText: chanPairText, chanLit: chanLit,
    clickStrip: clickStrip, armAudio: armAudio,
    ownText: ownText, hasCls: hasCls,
  };
}

(async function main() {
  const src = fs.readFileSync(TARGET, 'utf8');

  // 0. THE SAFETY RULE, stated as an absence in the source (design note section 4). createMediaElementSource
  // permanently reroutes the media element through the Web Audio graph and cannot be undone for the
  // element's lifetime; if the context is suspended the element goes silent while the queue keeps advancing
  // on ended / error. A visualizer that can silence the lane would break the one-at-a-time queue for a
  // picture, so the tap has to be the output copy instead.
  // The rule is about the CALL. The name may appear in a comment that forbids it - what must not exist is a
  // call site, so the assertion is on the invocation, not on the word.
  check('T-299 SAFETY RULE: createMediaElementSource is never CALLED anywhere in the client',
    !/createMediaElementSource\s*\(/.test(src) && /createMediaElementSource/.test(src),
    (src.match(/.{0,40}createMediaElementSource.{0,40}/g) || []).slice(0, 3));
  check('T-299 SAFETY RULE: the tap is audio.captureStream, and the analyser is fed by it',
    /captureStream/.test(src) && /createMediaStreamSource/.test(src));
  // T-421 (user 2026-10-15): 'the equalizer visualizer seems to be not in the middle of the canvas, with current column
  // count it should be a few pixels to the right to be center of canvas'. Measured on the live strip by reading canvas
  // pixels, not the maths: the 20 bar slots already fill the canvas exactly - 9.05 px bar, 1 px gap, first bar at
  // x=0, last bar ending at x=199 of 200 - so there was no placement slack to shift. What the eye saw was something
  // else: the lit bars ran 0..189 and the last 10 px were dead, because the top log band spans 13.5-22 kHz and a
  // 128 kbps stream carries nothing there. The band map is now capped at SCOPE_HIGH_HZ300; the same live
  // measurement after the change reads 0..199, 184 lit columns, no dead column at either end.
  check('T-421 source: the band map spans lo..min(nyq, SCOPE_HIGH_HZ300), never lo..nyq',
    /SCOPE_HIGH_HZ300 = 16000/.test(src)
      && /var hi = Math\.min\(nyq, SCOPE_HIGH_HZ300\);/.test(src)
      && /var f0 = lo \* Math\.pow\(hi \/ lo, b \/ nBands541\);/.test(src)
      && /var f1 = lo \* Math\.pow\(hi \/ lo, \(b \+ 1\) \/ nBands541\);/.test(src)
      && /var nBands541 = \(typeof countOpt541 === "number" && countOpt541 > 0\)[\s\S]{0,80}: SCOPE_BANDS300;/.test(src),
    (src.match(/var hi = Math\.min\([^)]*\);/) || ['no cap line'])[0]);
  // T-428 (user 2026-10-15): "Now the equalizer bars are one or two pixels too wide, there should be one or two
  // pixels of black between bar and borders on both sides." Measured before the change: bw = (W - 19*1)/20 = 9.05
  // with x = b*(bw+1), so the 20 bars spanned x = 0..200 edge to edge and the outer bars sat against the canvas
  // frame (1px left, 3px right from T-389) with no black between. The drawing area is inset by
  // SCOPE_EDGE_INSET300 on each side: inner 196px, bw 8.85, first bar at x=2, last bar ending at x=198. The frame
  // itself is unchanged - the request was for black INSIDE the canvas. The waveform and static modes are not
  // inset: a scope trace and a file's own peak bars legitimately span the box, and only the equalizer was named.
  check('T-428 source: the spectrum drawing area is inset on both sides and the bars and their caps use it',
    /SCOPE_EDGE_INSET300 = 2/.test(src)
      && /var inner428 = Math\.max\(1, W - 2 \* inset428\);/.test(src)
      && /var bw = \(inner428 - \(nbOut334 - 1\) \* gapS334\) \/ nbOut334;/.test(src)
      && /var x = inset428 \+ b \* \(bw \+ SCOPE_BAR_GAP300\);/.test(src),
    (src.match(/var bw = [^;]*;/) || ['no bar-width line'])[0]);
  // T-405 (user 2026-10-15): the tap can only belong to ONE element, so which element it belongs to is a rule
  // of its own now. Asserted from the source, like the two rules beside it: the panel renders a take element and
  // a station element, and the tap asks the presenting one, which pictureEl395 decides. The count of elements in
  // a live tree is pinned by the transport suite, where the tree is mounted.
  // T-410 (user 2026-10-15): "currently the framerate of the visualizer during stream playback is very low,
  // but it was fast before as we had it already displaying the live stream". Measured live by counting the
  // draw loop's own requestAnimationFrame re-arms: 0 loop frames per second with a station playing alone,
  // 45 per second with a take playing. scopeLive300() was asking audioRef - the take element - and a station
  // no longer plays there, so the gate answered false, scopeSyncLoop300() stopped the loop, and the strip
  // repainted only on the roughly four timeupdate events a live stream offers per second. Taking the tap from
  // the presenting element is not enough on its own: the LOOP has to be gated on the same reading, or the
  // strip runs at event speed instead of frame speed.
  check('T-410 CONTRACT: the strip loop is gated on the presenting element, not on the take element',
    (function () {
      const k = src.indexOf('function scopeLive300');
      if (k < 0) return false;
      // T-519-era RE-POINT (T-509, 2026-10-16): this window used to be a fixed 2500 characters, and it was
      // measuring the gate by its LENGTH. T-509 added a second measured reason to the same gate — static mode is
      // live when the tap it holds is a station's, which is the T-410 lesson applied to a fourth mode — and the
      // explanation pushed the line the pin looks for past the window. The claim is untouched; the window is now
      // the gate's own body, taken from its head to the next function, so the pin cannot be broken by a comment
      // getting longer again.
      const endK = src.indexOf('function scopeFrozen307', k);
      const body = src.slice(k, endK > k ? endK : k + 4000);
      return /var a = pictureEl395\(\);/.test(body) && !/audioRef\.current/.test(body);
    })(),
    'scopeLive300 body');

  check('T-405 CONTRACT: the panel renders a take element AND a station element, and the tap asks the presenting one',
    /ref: audioRef, controls: false/.test(src) && /ref: streamAudioRef, controls: false/.test(src)
    && /function pictureEl395\(\)/.test(src)
    && /var a = pictureEl395\(\);/.test(src),
    [(src.match(/controls: false/g) || []).length]);
  check('T-299: the graph is muted on purpose (a gain of 0 between the analyser and the destination) so the '
      + 'visualizer cannot add audible output of its own',
    /mute\.gain\.value = 0/.test(src));

  // ---------------------------------------------------------------- T-913: what a browser that never chose sees
  // CONTRACT CHANGE (T-913, 2026-11-23). Until this card a browser with no stored visualizer word read that
  // absence as `off`, so a fresh install showed a strip that never drew and the person had to find a control
  // they had no reason to trust before anything appeared. The preselect for a browser that has never chosen is
  // the first entry of the ring — the spectrum analyser. What is NOT changed: a word a person did choose is
  // honoured exactly, `off` included (that is why every scenario below names the word in its own fixture
  // instead of inheriting it), and a live mode still opens no audio graph before a user gesture.
  {
    let b913 = makeBrowser({});
    let m913 = await mount(b913, { canvas2d: true, audioTracks: 1 });
    let bag913 = m913.commit(); await flush();
    await openAllSections(m913.shim, m913.comp);
    bag913 = m913.commit(); await flush(); bag913 = m913.commit(); await flush();
    check('T-913: a browser that has never chosen a visualizer is on the spectrum analyser — the hover names the '
        + 'mode, and no click on the strip was needed to get there',
      m913.modeLabel() === 'spectrum analyser', m913.modeLabel());
    m913.armAudio(1);
    bag913 = m913.commit(); await flush();
    check('T-913: the preselect is a live mode and not a label — when the player gets a take the preselected mode '
        + 'builds its own tap on the output with nothing clicked on the strip',
      b913.ctxBuilt === 1 && b913.analysers > 0, [b913.ctxBuilt, b913.analysers]);
    m913.clickStrip();
    check('T-913: from the preselect the ring is intact — one click steps to the next entry and stores the word',
      m913.modeLabel() === 'oscilloscope' && b913.store['deepamp:scope.mode'] === 'oscilloscope',
      [m913.modeLabel(), b913.store['deepamp:scope.mode']]);
    teardown();
    let b913b = makeBrowser({ storage: { 'deepamp:scope.mode': 'not-a-mode-at-all' } });
    let m913b = await mount(b913b, { canvas2d: true, audioTracks: 1 });
    let bag913b = m913b.commit(); await flush();
    check('T-913: a stored word that is not one of the ring lands on the same preselect, not on a blank strip',
      m913b.modeLabel() === 'spectrum analyser', m913b.modeLabel());
    teardown();
  }

  // ---------------------------------------------------------------- scenario A: a browser that can tap
  // T-913 (2026-11-23): the word is stated here because the default moved — what this scenario has always
  // tested is a panel whose person chose `off`, and it still tests exactly that. The pins below are unchanged.
  let b = makeBrowser({ storage: { 'deepamp:scope.mode': 'off' } });
  let m = await mount(b, { canvas2d: true, audioTracks: 1 });
  let bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush(); bag = m.commit(); await flush();

  check('T-299: the strip is mounted in the player block, once, and it is not a Collapsible of its own',
    m.strip() !== null && m.els('audio-play-scope').length === 1
      && !m.created().some(function (e) { return /scope|visualizer/i.test(m.ownText(e)) && m.hasCls(e.props.className, 'audio-play-collapsible'); }),
    m.els('audio-play-scope').length);
  check('T-307 CONTRACT CHANGE: the mode is named in the strip hover, and NO mode caption is printed any more',
    m.modeLabel() === 'visualizer off' && m.els('audio-play-scope-mode').length === 0
      && m.els('audio-play-scope-meta').length === 0, [m.modeLabel(), m.els('audio-play-scope-mode').length]);
  // T-307 CONTRACT CHANGE (user 2026-10-13, 05:44): "I disabled the visualiser, and now the canvas is
  // hidden - including time display, but I can't restore it -> timing display and canvas should be visible,
  // and on klick restore the visualizer". "off means no box at all" is dead: the box is mounted, shorter, and
  // painted. What off still refuses is the audio graph and the animation loop, and that part is unchanged.
  // T-333 (user 2026-10-13): "the canvas is a little to wide ... or optionally can we make it adjustable ?!?" - the
  // default came down to 200. T-334 (user 2026-10-13, 15:2x): "if disabled, canvas should keep size" - the strip no
  // longer shortens when the visualizer is off, so the height this asserts is the full display height in every mode.
  // What off still refuses is the audio graph and the animation loop, and that part of the contract is unchanged.
  check('T-307 + T-334 CONTRACT CHANGE: off mounts the SAME canvas (200 x 80) instead of no canvas, keeps its size, '
      + 'and paints the clock band into it so the timing display survives',
    m.canvases().length === 1 && m.canvases()[0].props.height === '80'
      && m.canvases()[0].props.style.height === '80px'
      && b.rectLog.some(function (r) { return r[1] === 0 && r[3] === 80 && r[5] === '#0b0d0b'; })
      && b.rectLog.some(function (r) { return r[5] === '#3fb950'; }),
    [m.canvases().length, m.canvases().map(function (e) { return [e.props.height, e.props.style.height]; }),
     b.rectLog.filter(function (r) { return r[1] === 0 && r[3] === 80; }).length]);
  check('T-299 CONTRACT (off means off): with the mode off no animation frame is scheduled and no audio '
      + 'graph exists',
    b.rafScheduled === 0 && b.ctxBuilt === 0, [b.rafScheduled, b.ctxBuilt]);

  // The cycle: one click target, one direction, four modes, wrapping back to the first.
  m.armAudio(1);
  m.clickStrip();
  check('T-299: the first click steps off -> spectrum analyser (named in the hover, not printed)',
    m.modeLabel() === 'spectrum analyser', m.modeLabel());
  check('T-299: the click opened exactly one audio graph and resumed it (a browser only builds a graph on a '
      + 'gesture, and this is the gesture)',
    b.ctxBuilt === 1 && b.ctxResumed === 1 && b.sources === 1, [b.ctxBuilt, b.ctxResumed, b.sources]);

  // T-305: the strip is 80 CSS px tall now, because the dot-matrix clock lives inside the canvas and the
  // trace band keeps its height instead of being squeezed by the display.
  // T-307 (user 2026-10-13, 05:15): "the canvas should be more narrow" - 360 -> 260 CSS px, measured off the
  // user's Winamp 2 shot. T-333 (user 2026-10-13, 15:0x): "the canvas is a little to wide ... or optionally can we
  // make it adjustable ?!?" -> 260 -> 200 as the default, adjustable. Then the user's correction (15:1x): "we do NOT
  // want a slider to adjust the ui - we could make the right border of the canvas draggable within a range - OR fix
  // it - but no UI element to set it!" - so the knob is GONE and the width is set by dragging the strip's right edge.
  // This asserts both halves of the correction: the strip mounts at the new default, and the panel carries no width
  // control while the strip element itself carries the drag handlers.
  check('T-307 + T-333 CONTRACT CHANGE: a live mode with a tap mounts the canvas at 200 x 80 CSS px by default, and '
      + 'the width is set by dragging the strip edge, NOT by a control (was 360, then 260, now 200 + edge drag)',
    m.canvases().length === 1 && m.canvases()[0].props.width === '200' && m.canvases()[0].props.height === '80'
      && m.canvases()[0].props.style.width === '200px' && m.canvases()[0].props.style.maxWidth === '100%'
      && m.els('audio-play-scope-width').length === 0
      && (function () { var s = m.els('audio-play-scope'); return !!s[0] && typeof s[0].props.onPointerDown === 'function'
        && typeof s[0].props.onPointerMove === 'function' && typeof s[0].props.onPointerUp === 'function'; })()
      && m.canvases()[0].props.style.borderRight === '3px solid #888a',
    m.canvases().map(function (e) { return [e.props.width, e.props.height, e.props.style.width]; }));
  // U-18 (user 2026-10-13 01:39): "PPS: from hover tooltips: remove programming remarks like ... - the
  // tooltips are user remarks, not programming-agent remarks - use code comments for those". captureStream is
  // a programming remark and it is gone; what the hover has to carry instead is what the strip does to what
  // the person is hearing, including the honest limit of the peak meter.
  const stripTip = String(m.strip().props.title);
  check('T-299: the strip explains itself in its hover, including the honest limit of a LIVE peak meter',
    /LIVE output/.test(stripTip) && /clipped/.test(stripTip), stripTip.slice(0, 90));
  check('U-18: and the hover carries no API name, no verb name, no task id - those belong in code comments',
    !/captureStream|createMedia|AudioContext|T-299|scope\.mode/.test(stripTip), stripTip.slice(0, 120));
  check('U-18: the hover says what the person can now see - the trace is scaled to the take, and a stereo take draws two lines',
    /scales its trace/.test(stripTip) && /two lines in two colours/.test(stripTip), stripTip.slice(0, 200));
  check('T-299: the mode was persisted under audio-play:scope.mode',
    b.store['deepamp:scope.mode'] === 'spectrum', b.store['deepamp:scope.mode']);

  // The loop, measured through the analyser's own call count. The count is read as a DELTA from a marker,
  // because a mode change also paints once outside the loop (that is the U-18 idle repaint) and a raw total
  // would count it as a frame.
  check('T-299: a live mode with a playing element schedules the loop',
    b.rafScheduled >= 1, b.rafScheduled);
  const drawBaseA = b.freqCalls;
  b.frames(2);
  // A draw reads BOTH channel analysers (the U-18 stereo tap), so one frame is two analyser reads. The point
  // of the check is frames-to-draws 1:1, which is what the old every-other-frame skip refused to give.
  const READS_PER_DRAW300 = 2;
  check('U-18 CONTRACT (user 2026-10-13 01:39: the framerate of the oscilloscope looks a little slow): the '
      + 'strip draws EVERY frame the display offers - two frames drew twice, the old every-other-frame skip is gone',
    b.freqCalls - drawBaseA === 2 * READS_PER_DRAW300, [b.freqCalls - drawBaseA]);
  check('T-299: the drawn frame painted bars and the peak meter as rects, and every rect had a real size (no '
      + 'NaN geometry reaching the canvas)',
    b.fillRects > 0 && b.badRects === 0, [b.fillRects, b.badRects]);
  b.frames(4);
  check('U-18: six frames in all drew six, not three (drawing every frame is the rule now, not a coincidence of the first two)',
    b.freqCalls - drawBaseA === 6 * READS_PER_DRAW300, [b.freqCalls - drawBaseA]);
  // T-445 (user 2026-10-16): "disable the peak meter in the spectrum analyser, too and adjust it's usable screen
  // area accordingly". The meter band left this mode and its 8 px went to the bars. Both halves are measured off
  // the rects of one fresh frame, not off the source text.
  const specStart445 = b.rectLog.length;
  b.frames(1);
  const specFrame445 = b.rectLog.slice(specStart445);
  check('T-445 CONTRACT CHANGE: the analyser no longer paints the peak meter band (4px segments at the foot of the strip)',
    specFrame445.filter(function (r) { return r[2] === 4 && r[3] === 4; }).length === 0,
    specFrame445.filter(function (r) { return r[2] === 4 && r[3] === 4; }).length);
  check('T-445: and the bars took that height — a bar now reaches the foot of the 80px canvas',
    specFrame445.reduce(function (a, r) { return Math.max(a, r[1] + r[4] + r[3]); }, 0) >= 79,
    specFrame445.reduce(function (a, r) { return Math.max(a, r[1] + r[4] + r[3]); }, 0));
  check('T-445 source: the meter call is gated per mode, so the oscilloscope keeps its meter',
    /if \(!noPeak445\) scopeMeter300\(g, W, barH \+ 2, peak, ph\)/.test(src), 'meter gate present');
  const hiddenBase = b.freqCalls;
  const rafBeforeHide = b.rafScheduled;
  b.doc.hidden = true;
  b.frames(2);
  check('T-299 CONTRACT: a hidden page stops the loop (the fourth gate condition, untouched by the framerate change)',
    b.rafCancelled >= 1 && b.freqCalls === hiddenBase, [b.rafCancelled, b.freqCalls - hiddenBase, rafBeforeHide]);
  b.doc.hidden = false;

  // The cycle continues: oscilloscope reuses the SAME tap. A second source node for one element throws in a
  // real browser, so "does not rebuild the graph" is a correctness assertion, not an optimisation.
  m.clickStrip();
  check('T-299: the second click steps spectrum -> oscilloscope',
    m.modeLabel() === 'oscilloscope', m.modeLabel());
  check('T-299: switching the mode did NOT build a second graph or a second source node',
    b.ctxBuilt === 1 && b.sources === 1, [b.ctxBuilt, b.sources]);
  check('T-299: the canvas is still there and still the only canvas',
    m.canvases().length === 1, m.canvases().length);
  b.frames(2);
  check('T-299: the oscilloscope mode strokes the signal-wave line (a path and a stroke), where the spectrum '
      + 'mode painted rects',
    b.strokes >= 1 && b.paths >= 1, [b.strokes, b.paths]);
  // The fake signal peaks at 24 of 128 - a fifth of full scale, which is what this lane's takes actually
  // look like. Without auto-gain the line would only move about 5 px up and down inside a 56 px half box.
  b.frames(64);                          // 32 draws, so nothing here is a one-frame accident
  // The trace is 48 averaged columns, not 1024 raw samples. The fake carrier is 200 Hz: 4.3 cycles across the
  // window, about 11 columns per cycle, so a wave survives. The 4 kHz ripple averages out.
  check('T-299 CONTRACT (user correction 2026-10-12 22:52): the oscilloscope is ONE decimated line of '
      + 'averaged columns, not one stroke per raw sample',
    b.trace.length === 48, b.trace.length);
  let rev = 0;
  for (let i = 1; i < b.trace.length - 1; i++) {
    const d1 = b.trace[i][1] - b.trace[i - 1][1], d2 = b.trace[i + 1][1] - b.trace[i][1];
    if (d1 && d2 && (d1 > 0) !== (d2 > 0)) rev++;
  }
  check('T-299: the line changes direction only a handful of times - it reads as a wave, while raw plotting '
      + 'of the same signal reverses about 170 times',
    rev > 0 && rev <= 10, rev);
  // U-18 (user 2026-10-13 01:52, answering the ask): AUTO-GAIN, which REVERSES their own decision of
  // 2026-10-12 22:42 ("Fixed amplitude, no gain"). The user's complaint was "it looks a little flat during
  // speech", so the carrier here - 24 of 128, a fifth of full scale, 10.3 px of span at fixed amplitude inside
  // a 55 px half box - must now be scaled toward 85 % of the box. The span is the observable: it cannot come
  // from a bigger signal, because the signal the harness feeds has not changed.
  const spanA = b.yMax - b.yMin;
  check('U-18 CONTRACT (the 22:42 fixed-amplitude rule is REVERSED by the user): the trace is scaled to the take, not pinned to the carrier',
    spanA > 25 && spanA <= 2 * (64 - 7 - 1), [spanA]);
  check('U-18: the gain is bounded and named in the client - 1.00 to 8.00, aiming at 85 % of the half box',
    /SCOPE_GAIN_MIN300 = 1/.test(src) && /SCOPE_GAIN_MAX300 = 8/.test(src) && /SCOPE_GAIN_TARGET300 = 0\.85/.test(src),
    [src.indexOf('SCOPE_GAIN_MIN300'), src.indexOf('SCOPE_GAIN_MAX300')]);
  check('U-18: silence is NOT amplified - the target only forms above a floor, so a silent take still draws a flat line',
    /SCOPE_GAIN_FLOOR300 = 0\.04/.test(src) && /if \(fp > SCOPE_GAIN_FLOOR300\)/.test(src),
    [src.indexOf('SCOPE_GAIN_FLOOR300')]);
  check('U-18: the gain is computed from the SMOOTHED wave the trace actually draws, never from a raw peak it never shows',
    /for \(c2 = 0; c2 < cols; c2\+\+\)/.test(src) && /fp = fp \/ 128/.test(src), 'fp from means');
  check('U-18: a scaled trace can leave the box where a fixed one could not, so the clamp is now part of the contract',
    b.yMin >= 1 && b.yMax <= 64 - 7 - 1, [b.yMin, b.yMax]);
  check('U-18 CONTRACT (NOT reversed): the peak meter under the trace is still fed from the RAW samples, so the level read-out does not move when the picture does',
    /scopeMeter300\(g, W, barH \+ 2, peak, ph\)/.test(src) && /peak = peak \/ 128/.test(src), 'meter from raw peak');

  // T-599 (operator 2026-10-19: "For visualizer osci: add 2nd setting in matrix: toggle 'peak meter' -> allows to
  // enable / disable peak meter under the osci, also should expand osci area by a few pixels accordingly"; the row
  // ruled 2026-10-21 01:41 Berlin: "The oscilloscope row only"). BOTH halves measured off the drawings of one mode,
  // not off the source text: the meter's segments stop being painted, and the trace gets the room the meter used.
  const peakCell599 = (function () { m.commit(); return m.els('audio-play-scope-peak599'); })();
  const meterSegs599 = function (n599) {
    const start599 = b.rectLog.length;
    b.frames(n599);
    return b.rectLog.slice(start599).filter(function (r599) { return r599[2] === 4 && r599[3] === 4; }).length;
  };
  // The mode's own mid grid line is drawn at barH / 2, so where it sits IS the height the trace was given. It is
  // the exact half of this contract; the span beside it is the auto-gain's view of the same change.
  const gridY599 = function (n599) {
    const start599 = b.rectLog.length;
    b.frames(n599);
    return b.rectLog.slice(start599).filter(function (r599) { return r599[0] === 0 && r599[3] === 1 && r599[4] > 0; })
      .reduce(function (a599, r599) { return Math.max(a599, r599[1] + r599[4]); }, 0);
  };
  check('T-599: the oscilloscope row carries the second setting, printed with the word the setting stores, and it is the ONLY row that grows one',
    peakCell599.length === 1 && m.ownText(peakCell599[0]) === 'on'
    && m.els('audio-play-scope-peak599').length === 1,
    { cells: peakCell599.length, printed: peakCell599.length ? m.ownText(peakCell599[0]) : 'none' });
  check('T-599: with the switch ON - which is what the panel ships - the meter is drawn under the trace',
    meterSegs599(8) > 0, meterSegs599(0));
  // The span comparison needs a signal that FILLS the box, or a few pixels of room hide inside a quiet wave.
  // The harness's carrier amplitude is a knob (b.tdAmp), so both readings below see the same loud signal and the
  // only thing that changes between them is the height the mode reserves for its meter. The knob is put back
  // after the block so every check that follows this one still reads the voice-shaped wave it was written against.
  const gridOn599 = gridY599(4);
  b.tdAmp = 110; b.tdAmpR = 110;
  b.frames(64);
  const spanOn599 = b.yMax - b.yMin;
  peakCell599[0].props.onClick();
  m.commit(); await flush();
  const peakCellOff599 = m.els('audio-play-scope-peak599');
  const segsOff599 = meterSegs599(8);
  const gridOff599 = gridY599(4);
  b.frames(64);
  const spanOff599 = b.yMax - b.yMin;
  check('T-599: one press switches it off - the box prints the word the setting now holds, the meter stops being painted, and the value is stored',
    peakCellOff599.length === 1 && m.ownText(peakCellOff599[0]) === 'off' && segsOff599 === 0
    && b.store['deepamp:scope.peak.osci'] === 'off',
    { printed: peakCellOff599.length ? m.ownText(peakCellOff599[0]) : 'none', meter_segments: segsOff599,
      stored: b.store['deepamp:scope.peak.osci'] });
  check('T-599 CONTRACT, exact half: "should expand osci area by a few pixels accordingly" - the mode\'s mid grid line (drawn at barH / 2) moves down by exactly the 4 px half of the 8 px the meter band reserves',
    gridOff599 - gridOn599 === 4, { grid_with_meter: gridOn599, grid_without_meter: gridOff599, moved: gridOff599 - gridOn599 });
  check('T-599 CONTRACT, the same change as the picture draws it: the same loud signal, the same mode, and the auto-gain fills the taller box - amp is barH / 2 - 1 and the target is 85 % of it, so the drawn span moves by 2 x 0.85 x 4 = 6.8 px',
    spanOff599 >= spanOn599 + 6, { span_with_meter: spanOn599, span_without_meter: spanOff599, gained: spanOff599 - spanOn599 });
  check('T-599: and the switch is the oscilloscope\'s own - the waveform row and the spectrum row have no such cell, so no other mode can lose its meter through this box',
    // RE-POINTED 2026-11-07 by T-750 (operator: "we can remove the DB/log setting as a button and pin the plugins
    // to the db setting, (keep code but config to dB) - log shows no action"): the spectrum row no longer has a
    // level cell of any kind, so asking for one there would ask for something the panel no longer has. The point
    // of this pin is unchanged and is now stated more directly - exactly one peak box exists in the table, it
    // sits on the oscilloscope row, and a row that has no level cell cannot be reached through it either.
    // RE-POINTED AGAIN 2026-11-11 by T-788 (operator: "remove option to switch between amp and dB - fix to amp in
    // the background"): the waveform row is pinned the same way and no longer has a level cell either, so this pin
    // now asks for neither. What it is about has not moved by one character: the peak switch is still exactly one
    // box in the whole table and it still belongs to the oscilloscope row alone. The two cells the waveform and
    // the spectrum rows do have now are this card's own controls (a view box and an LED-count box, under their own
    // class names) and they are pinned by T-788 and T-789 below, not here.
    m.els('audio-play-scope-peak599').length === 1
    && m.els('audio-play-scope-level346-static').length === 0 && m.els('audio-play-scope-level346-spectrum').length === 0,
    { peak_cells: m.els('audio-play-scope-peak599').length,
      waveform_level_cells: m.els('audio-play-scope-level346-static').length,
      spectrum_level_cells: m.els('audio-play-scope-level346-spectrum').length });
  peakCellOff599[0].props.onClick();
  b.tdAmp = 24; b.tdAmpR = 24;
  m.commit(); await flush();
  const peakCellBack599 = m.els('audio-play-scope-peak599');
  const segsBack599 = meterSegs599(8);
  check('T-599: switching it back on paints the meter again and the DEFAULT is still a stored value (T-585: a person moved it, so the panel remembers they did)',
    peakCellBack599.length === 1 && m.ownText(peakCellBack599[0]) === 'on' && segsBack599 > 0
    && b.store['deepamp:scope.peak.osci'] === 'on',
    { printed: peakCellBack599.length ? m.ownText(peakCellBack599[0]) : 'none', meter_segments: segsBack599,
      stored: b.store['deepamp:scope.peak.osci'] });
  check('T-599 source: the switch is one arm of the ONE peak predicate, and the height it hands back is the arithmetic T-445 already had',
    /SCOPE_PEAK_OSCI_DEFAULT599 = "on"/.test(src) && /LS_SCOPE_PEAK_OSCI599 = "deepamp:scope\.peak\.osci"/.test(src)
    && /var barH = \(m === "off"\) \? 0 : \(H - SCOPE_CLOCK_H300 - \(noPeak445 \? 0 : \(SCOPE_PEAK_H300 \+ 1\)\)\);/.test(src),
    'vocabulary or barH');

  // Static waveform, U-18 (user 2026-10-13 01:39): "currently, while nothin is playing, the visualizer prints
  // a orange message - instead it should still show the selected visualizer". Every selected mode now owns the
  // box. Static draws the take's own min/max bars from the peaks read (T-303) and, while the lane cannot answer
  // that read, it draws its baseline and says so in one plain sentence - no orange wall of text in its place.
  const staticBase = b.freqCalls;
  m.clickStrip();
  m.commit();
  check('T-299: the third click steps oscilloscope -> waveform',
    m.modeLabel() === 'waveform', m.modeLabel());
  check('U-18: waveform says plainly that this lane cannot answer the peaks read yet, in user words',
    /shows the take's own peaks/.test(m.noteText()) && /does not answer them yet/.test(m.noteText()), m.noteText());
  check('U-18: and it says it without naming the host verb, the task, or the build',
    !/wave_peaks|T-303|not live in this build/.test(m.noteText()), m.noteText());
  check('U-18 CONTRACT: waveform keeps the canvas - a selected mode shows the visualizer, not a message',
    m.canvases().length === 1, m.canvases().length);
  check('U-18: the static frame painted something into it (a baseline stroke) instead of leaving an empty box',
    b.strokes >= 1, b.strokes);
  check('T-299: waveform also stops the loop - a mode with no live source does not animate',
    b.freqCalls === staticBase, [b.freqCalls - staticBase]);

  // T-755 (2026-11-07). The operator re-ordered the ring, verbatim: "in the visualizer order, move the LED bars
  // under waveform , and make dancing llama the last visualizer in the list". The LED bars therefore step OUT of
  // the waveform now, so this walk meets them here, on the fourth click, where the ring says they sit. The step
  // itself is the one T-601 wrote and it is still asserted the way it was then -- the whole printed word, not a
  // prefix of it. What moved is where it sits in the walk, because the walk follows the ring and the ring is what
  // was asked to change. This is the seventh time the trap T-601 item 3 recorded has fired: the drawings were
  // never wrong, the press counts and the order moved.
  m.clickStrip();
  check('T-299, re-pointed by T-542, by T-601 and again by T-755: the fourth click steps "waveform" -> "LED bars", which is where the operator put them',
    m.modeLabel() === 'LED bars', m.modeLabel());

  // T-445 (user 2026-10-15 request, design settled 2026-10-16): the cycle is SIX modes now. The two retro VU forms
  // sit between waveform and off. The walk below is the new cycle, and every step is asserted off the
  // drawing log (b.rectLog: [x, y, w, h, translateOffset, fillStyle]) rather than off the source text.
  // T-753 (2026-11-07, operator: "shorten the displayed visualizer names: static waveform -> waveform", the
  // llama row -> "dancing LLama", the Knight Rider row -> "LED bars", the qwen mark -> "bouncing qwen", the whale
  // mark -> "deepseek whale"). Every step of this walk is asserted against the word the panel PRINTS, so the words
  // in the labels below are the new ones. Two things are not softened by that: the walk still steps every mode in
  // the ring in order, and it still compares the whole printed string rather than a prefix of it -- a name that
  // moved by one character fails here. The card ids these labels carry (T-299, T-445, T-542, T-601, T-746, T-749)
  // are the names those cards were written under and they stay, because they are history rather than what the
  // panel shows today; where a label used the old printed word as a step name, it now carries the new one.
  const rafBefore445 = b.rafScheduled;
  m.clickStrip();
  m.commit();
  check('T-445 CONTRACT CHANGE (was four modes), re-pointed by T-755 (operator: "move the LED bars under waveform"): the fifth click steps "LED bars" -> the segmented VU ladder',
    m.modeLabel() === 'VU meters \u2014 segmented ladder', m.modeLabel());
  check('T-445: a VU mode arms the animation loop the way a live mode arms it — a VU meter measures the live output',
    b.rafScheduled > rafBefore445, [b.rafScheduled - rafBefore445]);
  check('T-445: and it does not build a second audio graph on the way there (the tap the analyser already had is reused)',
    b.ctxBuilt === 1, b.ctxBuilt);
  check('T-445: the strip hover says what this visualiser takes over and where the time reading went',
    /these meters fill the whole canvas/.test(m.canvases()[0].props.title)
      && /the time is on the seek bar and the row/.test(m.canvases()[0].props.title), m.canvases()[0].props.title);
  check('T-445: the clock control is NOT mounted in a VU mode — the band it sat on belongs to the meters now',
    m.els('audio-play-clock-hit376').length === 0, m.els('audio-play-clock-hit376').length);
  // A stereo take with the RIGHT channel clearly louder than the left. This is the fact that separates a VU pair
  // from a mirror: two channels have to move by different amounts.
  b.tdAmpR = 60;
  const vuStart445 = b.rectLog.length;
  b.frames(14);
  const vuLadder445 = b.rectLog.slice(vuStart445);
  check('T-445: the ladder frame painted a real meter (segments, scale and digits), not an empty box',
    vuLadder445.length > 40, vuLadder445.length);
  check('T-445: the VU frame is drawn with NO band translate — the meters own the canvas from its top edge',
    vuLadder445.every(function (r) { return r[4] === 0; })
      && vuLadder445.some(function (r) { return r[1] <= 2; }), [vuLadder445.length]);
  check('T-445: and it reaches the bottom edge too — the full 80px, the peak-meter band included',
    vuLadder445.reduce(function (a, r) { return Math.max(a, r[1] + r[3]); }, 0) >= 76, vuLadder445.length);
  check('T-445: the dot-matrix clock is not printed in a VU mode — no lit clock green anywhere in the frame',
    vuLadder445.filter(function (r) { return r[5] === '#3fb950'; }).length === 0,
    vuLadder445.filter(function (r) { return r[5] === '#3fb950'; }).length);
  check('T-445: a ladder segment is a segment, not a solid bar (every full-height lit rect is at least 2px wide)',
    vuLadder445.filter(function (r) { return (r[5] === '#00c800' || r[5] === '#ffd800' || r[5] === '#e8320f') && r[3] >= 20; })
      .every(function (r) { return r[2] >= 2; }),
    vuLadder445.filter(function (r) { return (r[5] === '#00c800' || r[5] === '#ffd800' || r[5] === '#e8320f') && r[3] >= 20; }).length);
  check('T-445: and the scale detail is finer than the ladder — a scale tick is 1px wide, a segment is not',
    vuLadder445.some(function (r) { return r[5] === '#e8320f' && r[2] === 1 && r[3] === 3; }),
    vuLadder445.filter(function (r) { return r[2] === 1 && r[3] === 3; }).length);
  check('T-445: the scale under the ladder is drawn in the clock dot matrix (1x1 dots), and the ladder is visible even where it is unlit',
    vuLadder445.some(function (r) { return r[2] === 1 && r[3] === 1; }) && vuLadder445.some(function (r) { return r[5] === '#1d211d'; }),
    [vuLadder445.filter(function (r) { return r[2] === 1 && r[3] === 1; }).length]);
  check('T-445: the two meters are two faces — one in the upper half of the canvas, one in the lower half',
    vuLadder445.some(function (r) { return r[1] < 39; }) && vuLadder445.some(function (r) { return r[1] >= 41; }),
    [vuLadder445.length]);
  check('T-445: the stereo case is lettered — an L drawn in the upper face and an R in the lower one',
    vuLadder445.filter(function (r) { return r[5] === '#9fe89f' && r[2] === 1 && r[3] === 1 && r[1] <= 8; }).length >= 7
      && vuLadder445.filter(function (r) { return r[5] === '#9fe89f' && r[2] === 1 && r[3] === 1 && r[1] >= 41 && r[1] <= 48; }).length >= 7,
    [vuLadder445.filter(function (r) { return r[5] === '#9fe89f' && r[1] <= 8; }).length]);
  check('T-445: a level that is actually playing lights segments above the floor (the harness feeds a voice-shaped wave)',
    vuLadder445.filter(function (r) { return r[5] === '#00c800'; }).length > 0,
    vuLadder445.filter(function (r) { return r[5] === '#00c800'; }).length);
  const litUp445 = vuLadder445.filter(function (r) { return (r[5] === '#00c800' || r[5] === '#ffd800' || r[5] === '#e8320f') && r[3] >= 20 && r[1] <= 30; }).length;
  const litDown445 = vuLadder445.filter(function (r) { return (r[5] === '#00c800' || r[5] === '#ffd800' || r[5] === '#e8320f') && r[3] >= 20 && r[1] >= 41; }).length;
  check('T-445: on a stereo take the two meters are two READINGS, not one signal drawn twice — the louder right channel lights clearly more of the lower face',
    litUp445 > 0 && litDown445 > litUp445, [litUp445, litDown445]);
  b.tdAmpR = undefined;
  m.clickStrip();
  m.commit();
  check('T-445, re-pointed by T-755: the sixth click steps the segmented ladder -> the moving-coil pair',
    m.modeLabel() === 'VU meters \u2014 moving coil', m.modeLabel());
  const needleStart445 = b.rectLog.length, strokeStart445 = b.strokes;
  b.frames(1);
  const vuNeedle445 = b.rectLog.slice(needleStart445);
  check('T-445: the needle form draws exactly one needle per meter (two stroked lines in one frame)',
    b.strokes - strokeStart445 === 2, [b.strokes - strokeStart445]);
  check('T-445: the needle form puts its two faces SIDE BY SIDE, each filling half the canvas width',
    vuNeedle445.some(function (r) { return r[0] < 99; }) && vuNeedle445.some(function (r) { return r[0] >= 101; }),
    [vuNeedle445.length]);
  check('T-445: its scale is a real arc that spans the whole ramp — green body, red tip drawn even at zero level',
    vuNeedle445.some(function (r) { return r[5] === '#00c800'; }) && vuNeedle445.some(function (r) { return r[5] === '#e8320f'; }),
    [vuNeedle445.filter(function (r) { return r[5] === '#e8320f'; }).length]);
  check('T-445: and this form does not print the clock either',
    vuNeedle445.filter(function (r) { return r[5] === '#3fb950'; }).length === 0, vuNeedle445.length);
  check('T-445: the mode is persisted like every other mode',
    b.store['deepamp:scope.mode'] === 'vu_needle', b.store['deepamp:scope.mode']);
  m.clickStrip();
  check('T-541, re-pointed by T-755 (operator: "move the LED bars under waveform , and make dancing llama the last '
      + 'visualizer in the list"): the seventh click steps the moving-coil pair -> the waterfall. What this step '
      + 'asserted then was that the new mode is IN the ring and that `off` is still the word the cycle ends on; '
      + 'where in the ring it sits was never this pin\'s to rule, and on 2026-11-07 the operator ruled it. The walk '
      + 'meets the waterfall here because the ring now runs this way, and `off` is still the last word of it.',
    m.modeLabel() === 'waterfall \u2014 spectrogram history', m.modeLabel());
  check('T-541: a scrolling history needs the same live tap the bars need — arriving at the waterfall opens the '
      + 'graph, it does not close it',
    b.ctxClosed === 0 && b.ctxBuilt === 1, [b.ctxClosed, b.ctxBuilt]);
  check('T-541: the waterfall owns the whole canvas, so the click target for the clock band is gone here exactly '
      + 'as it is for the meters',
    m.els('audio-play-clock-hit376').length === 0, m.els('audio-play-clock-hit376').length);
  check('T-541: the mode is persisted like every other mode',
    b.store['deepamp:scope.mode'] === 'waterfall', b.store['deepamp:scope.mode']);
  // T-755 (2026-11-07). The llama step that used to sit here moved DOWN the walk, after the whale mark, because
  // the operator's ruling -- verbatim "make dancing llama the last visualizer in the list" -- puts it at the end of
  // the drawing entries, and this walk follows the ring rather than the file's habit. The LED-bars step moved the
  // other way, up to the waveform, where the same ruling puts it. Both steps are still asserted with the words
  // they were asserted with; only their place in the walk moved, which is what a re-ordered ring does to a walk.
  m.clickStrip();
  check('T-746, re-pointed by T-755: the eighth click steps the waterfall -> "bouncing qwen". Where a mark joined '
      + 'this ring is that card\'s claim and it stands as history; the adjacency this step asserts is the one the '
      + 'ring carries today, and the ordering the operator ruled puts the waterfall in front of it.',
    m.modeLabel() === 'bouncing qwen', m.modeLabel());
  check('T-746: the rolling mark joined the same whole-canvas gate the VU pair, the waterfall, the llama and '
      + 'Knight Rider use, so the clock band has no click target here either',
    m.els('audio-play-clock-hit376').length === 0, m.els('audio-play-clock-hit376').length);
  check('T-746: arriving at the rolling mark opens the graph like the other live modes - a mode whose roll is '
      + 'driven by measured band energy cannot draw from a closed graph',
    b.ctxClosed === 0 && b.ctxBuilt === 1, [b.ctxClosed, b.ctxBuilt]);
  check('T-746: the mode is persisted like every other mode',
    b.store['deepamp:scope.mode'] === 'qwen', b.store['deepamp:scope.mode']);
  // RE-POINTED 2026-11-07 by T-749, and it is the sixth time the trap T-601 item 3 recorded has fired: the
  // drawings were never wrong, the press counts moved. The whale mark joined the ring at the place every mode
  // has joined it -- before `off`, after the mode the operator already had -- so qwen keeps its press order and
  // only the wrap moves. The ask of 2026-11-07 is quoted on TODOS.md WM-34 item 1 since 11:28 Berlin: "expand
  // dancing lama plugin with dancing whale option - use the deepseek whale in same scale, turn it 180* and
  // replace lama icon with whale as a visualizer setting", and in this session as "also, what about the dancing
  // whale implementation i wanted ?". RE-POINTED THE SAME EVENING BY T-755: the adjacency this step asserts -- the
  // qwen mark into the whale mark -- is unchanged, and the walk no longer stops at `off` here, because the llama
  // now sits after the whale.
  m.clickStrip();
  check('T-749, re-pointed by T-755: the ninth click steps "bouncing qwen" -> "deepseek whale", which is where a new mode joins this ring',
    m.modeLabel() === 'deepseek whale', m.modeLabel());
  check('T-749: the whale mark joined the same whole-canvas gate the VU pair, the waterfall, the llama, Knight '
      + 'Rider and the qwen mark use, so the clock band has no click target here either',
    m.els('audio-play-clock-hit376').length === 0, m.els('audio-play-clock-hit376').length);
  check('T-749: arriving at the whale mark opens the graph like the other live modes - both marks are drawn from '
      + 'the same measured band chain, so a mode that reads the analyser cannot draw from a closed graph',
    b.ctxClosed === 0 && b.ctxBuilt === 1, [b.ctxClosed, b.ctxBuilt]);
  check('T-749: the mode is persisted like every other mode',
    b.store['deepamp:scope.mode'] === 'whale', b.store['deepamp:scope.mode']);
  // T-755 (2026-11-07). The llama step, moved here from between the waterfall and this mark, because the operator
  // ruled the order -- verbatim: "make dancing llama the last visualizer in the list". `off` is the word the cycle
  // ends on and it is not a visualizer, so "the last visualizer" is the last entry that draws, which is where this
  // mark now steps. The four checks this step carries are the ones T-542 wrote and T-753 re-pointed to the printed
  // word; they are re-pointed again here, to the tenth click, and nothing about what they assert was relaxed.
  m.clickStrip();
  check('T-542, re-pointed by T-753 and again by T-755 (operator: "make dancing llama the last visualizer in the '
      + 'list"): the tenth click steps "deepseek whale" -> "dancing LLama", and the dancing llama is the last entry '
      + 'this ring draws before `off` wraps the cycle',
    m.modeLabel() === 'dancing LLama', m.modeLabel());
  check('T-542: the llama mode joined the same whole-canvas gate the VU pair and the waterfall use, so the click '
      + 'target for the clock band is gone here too',
    m.els('audio-play-clock-hit376').length === 0, m.els('audio-play-clock-hit376').length);
  check('T-542: arriving at the llama opens the graph like the other live modes — a mode that reads the analyser '
      + 'cannot draw from a closed graph',
    b.ctxClosed === 0 && b.ctxBuilt === 1, [b.ctxClosed, b.ctxBuilt]);
  check('T-542: the mode is persisted like every other mode',
    b.store['deepamp:scope.mode'] === 'llama', b.store['deepamp:scope.mode']);
  // RE-POINTED 2026-10-28 by T-681 (operator 2026-10-28 21:1x Berlin, verbatim: "currently I see the 3 modes below
  // the visualizier settings , but we wanted to make the clocks and visualizer separate"). The three clock faces are
  // OUT of this ring again, and this is the fourth time the trap T-601 item 3 recorded has fired: the drawings were
  // never wrong, the press counts moved. The clock faces are reached only through their own row - the switch and the
  // face box, asserted in the scenario that builds them. The band's click target stays gone in a full-canvas mode
  // for the reason T-445 and T-541 wrote; the clock owning the box is the same rule, now reached by a clock switch
  // rather than by a mode name.
  m.clickStrip();
  check('T-299, re-pointed by T-542, by T-601, by T-677, by T-681, by T-746, by T-749 and again by T-755: the '
      + 'eleventh click steps "dancing LLama" -> off and the cycle wraps there. The clock faces are not in this '
      + 'ring: the operator ruled the clock a separate control, and a press on the canvas walks the visualizer '
      + 'vocabulary only',
    m.modeLabel() === 'visualizer off', m.modeLabel());
  check('T-299 CONTRACT (off means off): the audio graph was CLOSED, not left running',
    b.ctxClosed === 1 && b.ctxBuilt === 1, [b.ctxClosed, b.ctxBuilt]);
  check('T-445: back at off the clock control is mounted again — the band it was taken from is the clock band again',
    m.els('audio-play-clock-hit376').length === 1, m.els('audio-play-clock-hit376').length);
  // T-681, measured here rather than claimed: the walk that used to reach the clock faces does not reach them, and
  // the canvas hover says what is being walked - a visualizer or nothing, never a clock.
  check('T-681: no clock word is stored by any press of this ring, and the stored word is the visualizer',
    b.store['deepamp:scope.mode'] === 'off'
      && ['clock_led', 'clock_nixie', 'clock_letters', 'clock_flap', 'clock_flap_light', 'clock_nixie_green'].every(function (w681) { return !b.store[w681]; }),
    b.store['deepamp:scope.mode']);
  // T-334 (user 2026-10-13, 15:2x): "if disabled, canvas should keep size" - the strip no longer shortens when the
  // cycle returns to off. What off still refuses is the analyser, and that half of the contract is asserted unchanged.
  const offBase541 = b.freqCalls;   // T-541: re-baselined here; the waterfall between the old baseline and this
                                    // point legitimately reads the analyser, and that is not a fault in off
  check('T-307 + T-334 CONTRACT CHANGE: after the cycle returns to off the strip keeps the full 80px box '
      + 'and the loop is cancelled - off reads the analyser no more than it did before',
    m.canvases().length === 1 && m.canvases()[0].props.height === '80'
      && b.freqCalls === offBase541, [m.canvases().map(function (e) { return e.props.height; }), b.freqCalls - offBase541]);
  check('T-299: the wrapped mode is persisted too',
    b.store['deepamp:scope.mode'] === 'off', b.store['deepamp:scope.mode']);
  m.clickStrip();
  check('T-299: the cycle wraps off -> spectrum analyser on the next click',
    m.modeLabel() === 'spectrum analyser' && b.ctxBuilt === 2, [m.modeLabel(), b.ctxBuilt]);
  // T-506 (2026-10-16, the user's question "why do we have different gains? can't we use a uniform translation
  // across sources?"). Measured on the plugin's own renders before anything was written: ap-0662 peaks at -0.1 dBFS
  // with RMS -22.5, ap-0660 -1.3 / -23.0, ap-0659 -1.7 / -20.7, ap-0592 -2.6 / -20.1, ap-0593 -1.4 / -22.4. Speech
  // carries an 18 to 22 dB crest factor, and the face runs from VU_LOW345 (-20 dBFS) to VU_HIGH345 (+3), so an
  // RMS-referenced meter cannot leave its own left end on a real take while a mastered stream reads over half. The
  // ruling is PEAK REFERENCE, ONE SCALE.
  // The harness feeds a voice-shaped wave: a carrier at amplitude 24 plus a 4 kHz ripple at amplitude 8, of 128.
  // That wave peaks at 32/128 = -12.04 dBFS and has RMS 17.9/128 = -17.13 dBFS. On this face the peak answer lights
  // 17 of 48 segments per meter (34.6 %), the RMS answer lights 6 (12.5 %). Far enough apart that the drawing, not
  // the source text, decides which reference is in use.
  // T-516 RE-MEASURED (2026-10-16, same arithmetic, new geometry — the card's own rule): the face now draws 38
  // segments instead of 48 (VU_SEG_GAP345 1 -> 2 and the clamp named as VU_SEG_MAX345 = 38). A segment lights when
  // (i + 0.5) / n <= litF, so the lit count is round(litF * n): peak 0.345 * 38 = 13.1 -> 13, RMS 0.127 * 38 = 4.8
  // -> 5. Both numbers below were READ FROM THE DRAWING LOG after the change, not computed here and asserted: the
  // suite printed 76 / 13 / 5 and these pins now expect exactly that. Nothing was loosened — 96 became 76 because
  // the ladder really is shorter now, and the peak-versus-RMS gap is still 13 against 5, which is the point of the
  // pair: the drawing decides which reference is in use, at either LED count.
  m.clickStrip(); m.commit();
  m.clickStrip(); m.commit();
  m.clickStrip(); m.commit();
  m.clickStrip(); m.commit();
  check('T-506 setup, re-pointed by T-755 (the LED bars now sit between the waveform and the ladder): the cycle is '
      + 'back on the segmented ladder for this measurement -- spectrum, oscilloscope, waveform, LED bars, ladder',
    m.modeLabel() === 'VU meters \u2014 segmented ladder', m.modeLabel());
  b.frames(39);
  const segStart506 = b.rectLog.length;
  b.frames(1);
  const segFrame506 = b.rectLog.slice(segStart506);
  const segCol506 = ['#00c800', '#ffd800', '#e8320f', '#e8e8e8', '#1d211d', '#3a1410'];
  const segAll506 = segFrame506.filter(function (r) { return r[3] >= 20 && segCol506.indexOf(r[5]) >= 0; });
  // The UPPER face is the left channel (barTop = 1) and the lower face is the right one (barTop = 1 + faceH + gap).
  // This scenario's history changed only the right channel's wave (T-445 made it louder on purpose), so the left
  // meter is the one that has been sitting on the harness's own voice-shaped wave the whole way and is settled on it.
  const segLitL506 = segFrame506.filter(function (r) { return r[3] >= 20 && r[1] <= 30
    && (r[5] === '#00c800' || r[5] === '#ffd800' || r[5] === '#e8320f'); });
  check('T-506: the ladder frame drew its full segment set for both meters (38 segments per face after T-516, unlit ones included — 76 across both)',
    segAll506.length === 76, segAll506.length);
  check('T-506 PEAK REFERENCE: the left meter lights 13 of its 38 segments, which is the PEAK answer (-12.06 dBFS -> 0.345 of the face; T-516 re-measured 17 of 48 -> 13 of 38)',
    segLitL506.length === 13, segLitL506.length);
  check('T-506: and it is decisively NOT the RMS answer, which lights 5 segments on this same wave (-17.08 dBFS -> 0.127) — the gap is 13 against 5, T-516 re-measured',
    segLitL506.length === 13, [segLitL506.length, 5]);
  check('T-506 UNIFORM ACROSS SOURCES: the same face, the same scale and the same reference carry a lane take and a stream - no per-source trim exists in this build',
    !/per-source|sourceGain|sourceTrim|vuTrim/i.test(src), src.length);
  check('T-506 + T-506b: both faces read through ONE chosen reader, and that reader is picked by the mode own switch (the right meter is still a real second reading, not a copy)',
    /var readDb346 = \(scopeLevel346\(scopeLevelsRef346\.current, m\) === "rms"\) \? vuRmsDb345 : vuPeakDb345;/.test(src)
    && (src.match(/readDb346\(t\.data/g) || []).length === 2,
    [(src.match(/readDb346\(t\.data/g) || []).length]);
  check('T-506: the RMS reference is KEPT, not deleted - the per-mode toggle table this card also carries makes it a choice a person can put back',
    /function vuRmsDb345\(/.test(src), null);
  check('T-506: the peak reference is clamped the same way the RMS one was (silence sits at the floor, a full-scale peak at the right end)',
    /function vuPeakDb345\([\s\S]{0,700}?VU_FLOOR345[\s\S]{0,400}?VU_HIGH345/.test(src), null);
  check("T-506 ANSWER TO THE QUESTION THE USER ASKED: the trace is still the only mode with a gain (SCOPE_GAIN_TARGET300 is defined once and used once), which is why a take looked normal in the trace and dead on the meters",
    (src.match(/SCOPE_GAIN_TARGET300/g) || []).length === 2, [(src.match(/SCOPE_GAIN_TARGET300/g) || []).length]);

  teardown();

  // ---------------------------------------------------------------- scenario B: a mode restored from storage
  // The persisted mode is live, but this page has had no click yet. The strip must NOT try to open a graph:
  // a browser only builds an AudioContext on a user gesture, and a strip that drew a flat line here would be
  // indistinguishable from a strip showing a silent take.
  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'oscilloscope' } });
  // Nothing has been played in this page yet, so the element answers a stream with no audio track - the
  // honest state of a panel that was just reloaded with a live mode saved in it.
  m = await mount(b, { canvas2d: true, audioTracks: 0 });
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush(); bag = m.commit(); await flush();
  m.armAudio(0);
  m.commit();
  check('T-299 CONTRACT: a live mode restored from storage is named in the hover, not silently reset to off',
    m.modeLabel() === 'oscilloscope', m.modeLabel());
  check('T-299 CONTRACT: a restored live mode does NOT open an audio graph before a click',
    b.ctxBuilt === 0 && b.rafScheduled === 0, [b.ctxBuilt, b.rafScheduled]);
  // T-305 (user 2026-10-13, 03:17): "yellow text 'teh analyser opens...' must be removed". A live mode with
  // no tap now says NOTHING in words: it draws its own baseline and prints its clock. What the panel refuses
  // to do is print an instruction at a person who is looking at it.
  check('T-305 CONTRACT: a live mode with no tap prints no instruction sentence at all - the strip answers '
      + 'with its own baseline and its clock',
    !/press play|file loaded/.test(m.noteText()) && m.canvases().length === 1 && b.strokes >= 1,
    [m.noteText(), m.canvases().length, b.strokes]);
  check('U-18 CONTRACT: a live mode with no tap still mounts the canvas and shows its own idle frame - the '
      + 'strip shows the visualizer the person picked, and the sentence under it carries the reason',
    m.canvases().length === 1, m.canvases().length);
  m.clickStrip();   // oscilloscope -> static here, because the cycle moves forward from the restored mode
  check('T-299: clicking a restored live mode still moves the cycle forward',
    m.modeLabel() === 'waveform', m.modeLabel());
  teardown();

  // ---------------------------------------------------------------- scenario C: a browser that cannot tap
  b = makeBrowser({ webAudio: false, storage: { 'deepamp:scope.mode': 'off' } });
  m = await mount(b, { canvas2d: true });   // no audioTracks option: this element has no captureStream at all
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush(); bag = m.commit(); await flush();
  m.armAudio();              // the node has no captureStream: the honest "not here" case
  m.clickStrip();
  check('T-299 CONTRACT: with no Web Audio the strip reports it and does not throw',
    /cannot tap the player output/.test(m.noteText()) && /unavailable/.test(m.noteText()), m.noteText());
  check('U-18: a browser that cannot tap the output still shows the mode it was given, and schedules no loop',
    m.canvases().length === 1 && b.rafScheduled === 0, [m.canvases().length, b.rafScheduled]);
  check('T-299: the mode still cycles honestly on such a browser (the label is not stuck)',
    m.modeLabel() === 'spectrum analyser', m.modeLabel());
  // RE-POINTED 2026-10-28 by T-681 (the clock faces left the ring; see the dated comment at the Knight Rider walk).
  // The point of the pin is unchanged: cycling the whole ring on a browser that cannot tap the output must never
  // throw and must never build a graph. RE-POINTED AGAIN 2026-11-07 by T-746, and again by T-749: the ring holds
  // one more entry each time, so ten presses reach off from a spectrum start. Nothing about the mode drawings or
  // the press rule moved; the count did, which is the trap T-601 item 3 recorded.
  m.clickStrip(); m.clickStrip(); m.clickStrip(); m.clickStrip(); m.clickStrip(); m.clickStrip(); m.clickStrip(); m.clickStrip(); m.clickStrip(); m.clickStrip();
  check('T-299, re-pointed by T-542, by T-601, by T-677, by T-681, by T-746 and again by T-749: cycling every mode in the ring on a browser without Web Audio never throws and never builds a graph',
    m.modeLabel() === 'visualizer off' && b.ctxBuilt === 0, [m.modeLabel(), b.ctxBuilt]);
  teardown();

  // ---------------------------------------------------------------- scenario E541: the waterfall (T-541)
  // The user's own words for this mode: "waterfall spectru[m] analyser with different options of color mapping …
  // the full canvas should be used (hide timers) like for the VUs … should have option to go bottom->up or
  // top->bottom (setting) - frequency waterfalls". Everything measured below is read off the drawing log — rect
  // coordinates, the recorded drawImage arguments, the fill colour of each rect — because a mode whose whole point
  // is where a frequency sits and which end of the canvas is now cannot be pinned by reading its source text.
  const wfRow541 = function (log541) { return log541.filter(function (r) { return r[2] === 1 && r[3] === 1; }); };
  const wfBg541 = function (log541) { return log541.filter(function (r) { return r[2] === 200 && r[3] === 80; }); };
  const wfLit541 = function (log541) {
    return wfRow541(log541).filter(function (r) { return r[5] !== 'rgb(10,58,14)'; }).map(function (r) { return r[0]; });
  };
  const wfColours541 = function (log541) {
    const seen541 = [];
    wfRow541(log541).forEach(function (r) { if (seen541.indexOf(r[5]) < 0) seen541.push(r[5]); });
    return seen541;
  };
  const wfY541 = function (log541) {
    const row541 = wfRow541(log541);
    const ys541 = [];
    row541.forEach(function (r) { if (ys541.indexOf(r[1]) < 0) ys541.push(r[1]); });
    return ys541;
  };

  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'off' } });
  m = await mount(b, { canvas2d: true, audioTracks: 1 });
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush(); bag = m.commit(); await flush();
  m.armAudio(1);
  // The panel mounts with the visualizer OFF, which scenario A has pinned since T-307. Six presses walk the ring
  // from there to the moving-coil face — off, spectrum, oscilloscope, static, LED bars, vu_led, vu_needle — and the
  // press that follows is the one this scenario measures. RE-POINTED 2026-11-07 by T-755 on the operator's order
  // ("move the LED bars under waveform"): the count moved because the LED bars now sit on this path, and the
  // claim -- that the waterfall is reached by walking the ring, one press at a time, and that it sits before `off`
  // and not after the mode that draws nothing -- is the claim this setup was written to make.
  m.clickStrip(); m.commit(); m.clickStrip(); m.commit(); m.clickStrip(); m.commit();
  m.clickStrip(); m.commit(); m.clickStrip(); m.commit(); m.clickStrip(); m.commit();
  check('T-541 setup, re-pointed by T-755: six presses from the mounted mode (which is off) land on the moving-coil '
      + 'face, the one the waterfall sits after in the ring',
    m.modeLabel() === 'VU meters \u2014 moving coil', m.modeLabel());

  // The press that lands on the waterfall makes the panel repaint one frame inside the commit, so a hand-tuned
  // frame count is the wrong instrument here. What is measurable is the invariant: a fresh start paints its own
  // background and copies nothing, and every frame after it copies exactly one row. The baselines below are taken
  // before the press, so whatever the commit itself drew is inside the window being measured rather than outside it.
  const wfCopiesBeforeEntry541 = b.imageCopies;
  const wfRectsBeforeEntry541 = b.rectLog.length;
  m.clickStrip(); m.commit();                          // the press that lands on the waterfall
  b.hotBins = [2]; b.hotBinValue = 255;                // one low bin, at the top of the mock's dB window
  const wfS1 = b.rectLog.length;
  b.frames(1);
  const wfF1 = b.rectLog.slice(wfS1);
  b.frames(1);
  const wfEntryWin541 = b.rectLog.slice(wfRectsBeforeEntry541);
  const wfEntryFrames541 = wfRow541(wfEntryWin541).length / 196;
  check('T-541: a fresh history is started by ONE background fill and no copy, and every waterfall frame after it '
      + 'continues the picture with exactly one self-copy — copies equal frames minus one, across the whole run so '
      + 'far, whichever of them the press itself drew',
    wfRow541(wfEntryWin541).length % 196 === 0 && wfEntryFrames541 >= 2
      && b.imageCopies - wfCopiesBeforeEntry541 === wfEntryFrames541 - 1
      && wfBg541(wfEntryWin541).length === 1,
    { frames: wfEntryFrames541, copies: b.imageCopies - wfCopiesBeforeEntry541,
      background_fills: wfBg541(wfEntryWin541).length });
  check('T-541: one canvas row per drawn frame — the newest frame is 196 columns one pixel tall (a 200 px strip '
      + 'less the 2 px of black T-428 keeps inside the frame)',
    wfRow541(wfF1).length === 196, [wfRow541(wfF1).length]);
  check('T-541: the newest row sits along the BOTTOM edge in the default direction, drawn in the canvas itself '
      + 'rather than in a band below the clock — its own translate offset is zero',
    wfY541(wfF1).length === 1 && wfY541(wfF1)[0] === 79 && wfRow541(wfF1).every(function (r) { return r[4] === 0; }),
    [wfY541(wfF1), wfRow541(wfF1).length ? wfRow541(wfF1)[0][4] : 'no row']);
  check('T-541: the full canvas means the dot-matrix clock is not drawn here at all — no glyph in the clock green, '
      + 'the same measurement that proves the meters do not print it either',
    wfF1.filter(function (r) { return r[5] === '#3fb950'; }).length === 0,
    [wfF1.filter(function (r) { return r[5] === '#3fb950'; }).length]);

  const wfS2 = b.rectLog.length;
  b.frames(1);
  const wfF2 = b.rectLog.slice(wfS2);
  check('T-541: a continuing frame does not clear the canvas — no background fill in this frame, because a cleared '
      + 'canvas is a waterfall with no history in it',
    wfBg541(wfF2).length === 0 && wfRow541(wfF2).length === 196, [wfBg541(wfF2).length, wfRow541(wfF2).length]);
  check('T-541: in the default direction the copy moves everything UP one row (source starts one row below the top '
      + 'and covers all but that row, destination starts at the top and covers all but the row being painted) and '
      + 'the new row is again along the bottom edge',
    (function () {
      const im541 = b.imageLog[wfCopiesBeforeEntry541] || [];
      return im541.length === 8 && im541[0] === 0 && im541[1] === 1 && im541[2] === 200 && im541[3] === 79
        && im541[4] === 0 && im541[5] === 0 && im541[6] === 200 && im541[7] === 79 && wfY541(wfF2)[0] === 79;
    })(), [b.imageLog[wfCopiesBeforeEntry541] || 'no copy recorded', wfY541(wfF2)]);

  // The axis claim, measured rather than asserted: bass at the LEFT, treble at the RIGHT. One fixture, one bin
  // moved from near the bottom of the map to near the top, and the lit column moves with it.
  const wfLowX541 = wfLit541(wfF1);
  b.hotBins = [400];
  const wfS3 = b.rectLog.length;
  b.frames(1);
  const wfF3 = b.rectLog.slice(wfS3);
  const wfHighX541 = wfLit541(wfF3);
  check('T-541: bass is at the left — a hot bin at index 2 lights exactly one column, in the left half of the '
      + 'canvas, and one column only because the log chain never shows a bin twice',
    wfLowX541.length === 1 && wfLowX541[0] < 100, wfLowX541);
  check('T-541: treble is at the right — the same fixture with the hot bin at index 400 lights a column in the '
      + 'right half, which is the axis direction read off the drawing instead of written into a test',
    wfHighX541.length === 1 && wfHighX541[0] > 100, wfHighX541);

  // The direction setting: a stored word in Settings. It was a dropdown, then a switch printed beside the
  // visualizer group, and since the operator's word of 2026-10-17 ("the option should be in the setting matrix as
  // the first button") it is a press INSIDE the waterfall's row in that matrix, built with the matrix's own box
  // idiom. The ruling that changing direction starts a fresh history rather than mirroring rows already drawn in
  // the other order is unchanged; what changed is where the control lives and what it prints.
  const wfDirSel541 = m.els('audio-play-scope-wfdir541');
  const wfDirWords541 = function (n541) {
    if (!n541) return '';
    if (typeof n541 === 'string') return n541;
    if (typeof n541 === 'number') return String(n541);
    if (Array.isArray(n541)) return n541.map(wfDirWords541).join(' ');
    if (!n541.props) return '';
    return wfDirWords541(n541.props.children);
  };
  check('T-541 re-pointed by the operator ruling of 2026-10-17 ("the option should be in the setting matrix as the '
      + 'first button", and by "rename button newest: bottom to up and down"): the direction is ONE press, it lives '
      + 'in the level matrix on the waterfall row, it is pressable, and its printed word is the stored word in use '
      + '- the default prints "up", which is what the phrase "bottom->up" describes',
    wfDirSel541.length === 1 && wfDirSel541[0].type === 'button'
      && typeof wfDirSel541[0].props.onClick === 'function'
      && wfDirWords541(wfDirSel541[0]) === 'up',
    { controls: wfDirSel541.length, control_type: wfDirSel541[0] ? wfDirSel541[0].type : 'none',
      printed: wfDirSel541[0] ? wfDirWords541(wfDirSel541[0]) : 'none',
      pressable: wfDirSel541[0] ? typeof wfDirSel541[0].props.onClick : 'none' });
  check('T-541: its hover says which end is now, that frequency runs across the width either way, and that the '
      + 'setting affects the waterfall mode and no other mode',
    /which end is now/.test(String(wfDirSel541[0].props.title || ''))
      && /bass at the left/.test(String(wfDirSel541[0].props.title || ''))
      && /waterfall mode and no other mode/.test(String(wfDirSel541[0].props.title || '')),
    String(wfDirSel541[0].props.title || '').slice(0, 70));
  const wfCopiesBeforeDir541 = b.imageCopies;
  const wfRectsBeforeDir541 = b.rectLog.length;
  wfDirSel541[0].props.onClick();
  m.commit();
  const wfS4 = b.rectLog.length;
  b.frames(1);
  const wfF4 = b.rectLog.slice(wfS4);
  b.frames(1);
  const wfDirWin541 = b.rectLog.slice(wfRectsBeforeDir541);
  const wfDirFrames541 = wfRow541(wfDirWin541).length / 196;
  check('T-541: the setting is stored the way every other stored word in this panel is stored, and the box on the '
      + 'row prints the direction it flipped to once the press has run',
    b.store['deepamp:scope.wfdir541'] === 'down'
      && wfDirWords541(m.els('audio-play-scope-wfdir541')[0]) === 'down',
    [b.store['deepamp:scope.wfdir541'], wfDirWords541(m.els('audio-play-scope-wfdir541')[0])]);
  check('T-541: changing the direction drops the history instead of flipping it — exactly one fresh start in the '
      + 'whole window after the change, one background fill, and the same copies-equal-frames-minus-one invariant '
      + 'again, because rows drawn in the other order would display an age order that never happened',
    wfBg541(wfDirWin541).length === 1 && wfDirFrames541 >= 2
      && b.imageCopies - wfCopiesBeforeDir541 === wfDirFrames541 - 1,
    { frames: wfDirFrames541, copies: b.imageCopies - wfCopiesBeforeDir541,
      background_fills: wfBg541(wfDirWin541).length });
  check('T-541: and the newest row is now along the TOP edge',
    wfY541(wfF4).length === 1 && wfY541(wfF4)[0] === 0, wfY541(wfF4));
  check('T-541: the first copy after the change moves the canvas DOWNWARD — source at the top covering all but '
      + 'one row, destination one row down — and the newest row is along the top edge',
    (function () {
      const im541 = b.imageLog[wfCopiesBeforeDir541] || [];
      return im541.length === 8 && im541[0] === 0 && im541[1] === 0 && im541[2] === 200 && im541[3] === 79
        && im541[4] === 0 && im541[5] === 1 && im541[6] === 200 && im541[7] === 79 && wfY541(wfF4)[0] === 0;
    })(), [b.imageLog[wfCopiesBeforeDir541] || 'no copy recorded', wfY541(wfF4)]);

  // The per-mode controls the ring brings with it: a level row, a colour box, and a name that is a press.
  const wfLevel541 = m.els('audio-play-scope-level346-waterfall');
  const wfScheme541 = m.els('audio-play-scope-scheme536-waterfall');
  const wfName541 = m.els('audio-play-scope-mode531-waterfall');
  check('T-541 re-pointed by the operator ruling of 2026-10-17 ("waterfall: remove dB tag"): the mode still appears '
      + 'in the per-mode table with its own colour box and a name that is a press making it the strip, and it no '
      + 'longer carries a level cell of its own',
    wfLevel541.length === 0 && wfScheme541.length === 1 && wfName541.length === 1,
    [wfLevel541.length, wfScheme541.length, wfName541.length]);
  check('T-541: the colour box offers the four ramps the user chose and only those four — this mode has its own '
      + 'vocabulary and a value cannot leak into it from another mode',
    /press to cycle green, flames, ironbow, cold/.test(String(wfScheme541[0].props.title || ''))
      && !/press to cycle[^)]*white/.test(String(wfScheme541[0].props.title || '')),
    String(wfScheme541[0].props.title || '').slice(-70));
  check('T-541 re-pointed twice on 2026-10-17 ("remove log option, keep only dB option", then "waterfall: remove '
      + 'dB tag"): the row now offers NO level control at all. First the second word went, which left a box printing '
      + 'a value no control could change; then that box went, because a printed value nothing can change is clutter '
      + 'and not a read-out. No row in the table prints a value nobody can choose',
    wfLevel541.length === 0
      && m.els('audio-play-scope-level346').filter(function (e541) { return e541.type === 'span'; }).length === 0,
    { waterfall_level_cells: wfLevel541.length,
      read_out_cells_in_the_table: m.els('audio-play-scope-level346').filter(function (e541) { return e541.type === 'span'; }).length });
  check('T-541 re-pointed by the operator ruling of 2026-10-17 ("remove all the text clutter in settings"): the '
      + 'removed choice is not silently missing and it is not explained by a printed note either - the waterfall row '
      + 'carries no level cell at all, every level cell the table does have is pressable, and no row in that table '
      + 'carries a pair note beside its box any more. The words a control cycles are on its hover',
    (function () {
      const cells541 = m.els('audio-play-scope-level346');
      const pressable541 = cells541.filter(function (e541) { return typeof e541.props.onClick === 'function'; });
      const readouts541 = cells541.filter(function (e541) { return e541.type === 'span'; });
      const tbl541 = m.created().filter(function (e541) {
        return String((e541.props || {}).className || '').indexOf('audio-play-scope-levels346') >= 0;
      })[0] || null;
      const tblWords541 = [];
      (function walkT541(n541) {
        if (!n541) return;
        if (Array.isArray(n541)) { n541.forEach(walkT541); return; }
        if (typeof n541 === 'string' || typeof n541 === 'number' || !n541.props) return;
        const ownT541 = m.ownText(n541);
        if (ownT541) tblWords541.push(ownT541);
        walkT541(n541.props.children);
      })(tbl541 ? tbl541.props.children : null);
      const notes541 = tblWords541.filter(function (t541) { return t541.indexOf(' / ') >= 0 || t541 === 'fixed reading'; });
      // RE-POINTED 2026-11-07 by T-746: the rolling mark has a level row of its own, so the table holds one
      // pressable cell more. What this pin is about has not moved by one character: no cell in the table is a
      // read-out, and no row carries a pair note beside its box - the words a control cycles are on its hover.
      // RE-POINTED AGAIN the same day by T-750 (operator: "we can remove the DB/log setting as a button and pin
      // the plugins to the db setting, (keep code but config to dB) - log shows no action"): four rows - the
      // spectrum, the llama and the two marks - no longer carry a level cell of any kind, because a mode pinned to
      // one reading has no choice to press and the panel's own ruling for the waterfall says a printed value
      // nothing can change is clutter, not a read-out. The count of pressable cells is now the count of modes that
      // still have two words: the waveform, the oscilloscope and the two VU faces. The half of this pin
      // that matters is unchanged and is measured the same way: every cell the table has is pressable, none of them
      // is a read-out, and no row carries a pair note beside its box.
      // RE-POINTED AGAIN 2026-11-11 by T-788 (operator: "remove option to switch between amp and dB - fix to amp in
      // the background"): the waveform is the fifth row now pinned to one reading, so the pressable count is the
      // count of modes that still have two words - the oscilloscope and the two VU faces. The mode's own controls
      // that these two rows carry instead (a view box, an LED-count box) are not level cells and are not counted
      // here; they are met under their own class names and pinned by their own cards.
      return !!tbl541 && cells541.length === 3 && pressable541.length === 3 && readouts541.length === 0
        && notes541.length === 0;
    })(), { level_cells: m.els('audio-play-scope-level346').length,
      pressable: m.els('audio-play-scope-level346').filter(function (e541) { return typeof e541.props.onClick === 'function'; }).length,
      read_outs: m.els('audio-play-scope-level346').filter(function (e541) { return e541.type === 'span'; }).length,
      notes_inside_the_table: (function () {
        const tbl541 = m.created().filter(function (e541) {
          return String((e541.props || {}).className || '').indexOf('audio-play-scope-levels346') >= 0;
        })[0] || null;
        const w541 = [];
        (function walkQ541(n541) {
          if (!n541) return;
          if (Array.isArray(n541)) { n541.forEach(walkQ541); return; }
          if (typeof n541 === 'string' || typeof n541 === 'number' || !n541.props) return;
          const ownQ541 = m.ownText(n541);
          if (ownQ541) w541.push(ownQ541);
          walkQ541(n541.props.children);
        })(tbl541 ? tbl541.props.children : null);
        return w541.filter(function (t541) { return t541.indexOf(' / ') >= 0 || t541 === 'fixed reading'; }).length;
      })() });

  // T-753 (2026-11-07). The names in this table are what a person reads, so they are pinned as DRAWN words rather
  // than as source text: each row's name button is read off the tree and compared whole. Five were shortened on the
  // operator's word, verbatim: "shorten the displayed visualizer names: static waveform -> waveform", the llama row
  // "-> dancing LLama", "remove \"Knight Rider\" -> only \"LED bars\"", the qwen mark "-> bouncing qwen", the whale
  // mark "-> deepseek whale". Five were not named in that ask and print what their own cards chose. Two things this
  // pin does NOT relax: every name is compared as the entire string, so a word that moved by one character fails,
  // and the mode KEYS are not in this table at all -- the stored words are still "static", "llama", "knight",
  // "qwen", "whale", and a rename that reached one of those would show up as a mode that no longer restores, which
  // the persistence pins above already catch. The spellings below are the operator's, casing included.
  const NAMES753 = {
    spectrum: 'spectrum analyser', oscilloscope: 'oscilloscope', static: 'waveform',
    vu_led: 'VU meters \u2014 segmented ladder', vu_needle: 'VU meters \u2014 moving coil',
    waterfall: 'waterfall \u2014 spectrogram history', llama: 'dancing LLama', knight: 'LED bars',
    qwen: 'bouncing qwen', whale: 'deepseek whale',
  };
  check('T-753: every row of the visualizer settings table prints the name it is meant to print -- read off the '
      + 'drawn row button and compared whole, the five the operator shortened printing the operator\'s words '
      + '(waveform, dancing LLama, LED bars, bouncing qwen, deepseek whale) and the five that were not named '
      + 'printing what their own cards chose. A name that differs by one character fails here, and so does a table '
      + 'row that prints a mode key instead of a name',
    (function () {
      const keys753 = Object.keys(NAMES753);
      const drawn753 = {};
      keys753.forEach(function (k753) {
        const el753 = m.els('audio-play-scope-mode531-' + k753)[0];
        drawn753[k753] = el753 ? String(m.ownText(el753)) : null;
      });
      return keys753.every(function (k753) { return drawn753[k753] === NAMES753[k753]; });
    })(), (function () {
      const out753 = {};
      Object.keys(NAMES753).forEach(function (k753) {
        const el753 = m.els('audio-play-scope-mode531-' + k753)[0];
        out753[k753] = el753 ? String(m.ownText(el753)) : 'NO ROW';
      });
      return out753;
    })());

  // Where the control sits, measured rather than asserted: the table subtree walked in document order. The
  // operator asked for "the first button" of the matrix row, so the direction box has to be met before the level
  // box of the same row, and it has to be met inside the table rather than somewhere else in Settings.
  const tblOrder541 = (function () {
    const tbl541 = m.created().filter(function (e541) {
      return String((e541.props || {}).className || '').indexOf('audio-play-scope-levels346') >= 0;
    })[0] || null;
    const out541 = [];
    (function walkO541(n541) {
      if (!n541) return;
      if (Array.isArray(n541)) { n541.forEach(walkO541); return; }
      if (typeof n541 === 'string' || typeof n541 === 'number' || !n541.props) return;
      out541.push(n541);
      walkO541(n541.props.children);
    })(tbl541 ? tbl541.props.children : null);
    return { node: tbl541, order: out541 };
  })();
  const clsIn541 = function (n541, cls541) {
    return String(((n541 || {}).props || {}).className || '').split(/\s+/).indexOf(cls541) >= 0;
  };
  const wfDirPos541 = tblOrder541.order.findIndex(function (e541) { return clsIn541(e541, 'audio-play-scope-wfdir541'); });
  const wfSchemePos541 = tblOrder541.order.findIndex(function (e541) { return clsIn541(e541, 'audio-play-scope-scheme536-waterfall'); });
  const wfNamePos541 = tblOrder541.order.findIndex(function (e541) { return clsIn541(e541, 'audio-play-scope-mode531-waterfall'); });
  const wfLevelCells541 = tblOrder541.order.filter(function (e541) { return clsIn541(e541, 'audio-play-scope-level346-waterfall'); }).length;
  check('T-541 re-pointed by "the option should be in the setting matrix as the first button" and by "waterfall: '
      + 'remove dB tag": the direction press is INSIDE the level matrix on the waterfall row, and the table subtree '
      + 'walked in document order meets that row\u2019s name, then the direction box, then that row\u2019s colour box. '
      + 'The row offers no level cell at all. A control sitting somewhere else in Settings would pass the class '
      + 'check and still fail this one',
    !!tblOrder541.node && wfDirPos541 >= 0 && wfSchemePos541 >= 0 && wfNamePos541 >= 0
      && wfNamePos541 < wfDirPos541 && wfDirPos541 < wfSchemePos541 && wfLevelCells541 === 0
      && tblOrder541.order.filter(function (e541) { return clsIn541(e541, 'audio-play-scope-wfdir541'); }).length === 1,
    { name_at: wfNamePos541, direction_at: wfDirPos541, colour_at: wfSchemePos541,
      level_cells_on_the_waterfall_row: wfLevelCells541 });
  check('T-541: the matrix is still a table - every row in it holds only cells. The direction box was moved into a '
      + 'row on 2026-10-17, and a control placed directly in a row instead of in a cell of that row renders somewhere '
      + 'its author did not put it. Measured on the tree the panel built, not on how it looks',
    (function () {
      const rows541 = tblOrder541.order.filter(function (e541) { return e541.type === 'tr'; });
      const misplaced541 = [];
      rows541.forEach(function (r541) {
        const kids541 = Array.isArray(r541.props.children) ? r541.props.children : (r541.props.children ? [r541.props.children] : []);
        kids541.forEach(function (k541) {
          if (!k541 || typeof k541 !== 'object' || !k541.type) return;
          if (k541.type !== 'td') misplaced541.push(k541.type + '.' + String((k541.props || {}).className || 'no-class'));
        });
      });
      // RE-POINTED 2026-10-28 by T-677: the table carried three clock-name rows in addition to the eight level rows.
      // RE-POINTED AGAIN 2026-10-28 by T-681 (operator: "we wanted to make the clocks and visualizer separate"): the
      // clock rows are out of this matrix and into their own row under it, so the matrix is eight rows again.
      // RE-POINTED AGAIN 2026-11-07 by T-746: the rolling mark is the ninth level row, because a mode whose
      // measurement drives its motion has a level word like every other audio-driven mode. RE-POINTED AGAIN the
      // same day by T-749: the whale mark is the tenth, on the same row-building map, because the rows are made
      // from the modes the panel has and not from a list of the modes that have a switch. What this pin is about
      // is unchanged: every row holds only cells, so a control cannot sit loose in a row - which is what a row
      // whose level cell is an empty cell still satisfies.
      return rows541.length === 10 && misplaced541.length === 0;
    })(), { rows: tblOrder541.order.filter(function (e541) { return e541.type === 'tr'; }).length,
      non_cell_children_of_rows: tblOrder541.order.filter(function (e541) { return e541.type === 'tr'; })
        .reduce(function (acc541, r541) {
          const kids541 = Array.isArray(r541.props.children) ? r541.props.children : (r541.props.children ? [r541.props.children] : []);
          return acc541 + kids541.filter(function (k541) { return k541 && typeof k541 === 'object' && k541.type && k541.type !== 'td'; }).length;
        }, 0) });

  // T-755 (2026-11-07). The operator re-ordered the list a person reads, verbatim: "in the visualizer order, move
  // the LED bars under waveform , and make dancing llama the last visualizer in the list". The press order is
  // pinned above, step by step, by the walk; this is the other half -- the Visualizer settings table, read in the
  // document order the browser will lay it out in. It is pinned as drawn rows, not as a source literal, because
  // the ask was about what the row list looks like. And the two lists the client carries -- the ring it cycles and
  // the list it builds rows from -- are compared against each other here, because a table whose rows ran in a
  // different order from the press cycle would be a second order nobody asked for.
  const ROW_ORDER755 = ['spectrum', 'oscilloscope', 'static', 'knight', 'vu_led', 'vu_needle', 'waterfall', 'qwen', 'whale', 'llama'];
  check('T-755: the visualizer settings table prints its rows in the order the operator ruled -- waveform, then the '
      + 'LED bars under it, then the two meters, the waterfall, the two marks, and the dancing llama last -- read off '
      + 'the table subtree walked in document order, and the ring the panel cycles is the same order with `off` at '
      + 'the end of it',
    (function () {
      const drawn755 = [];
      tblOrder541.order.forEach(function (n755) {
        const cls755 = String(((n755 || {}).props || {}).className || '');
        const hit755 = /audio-play-scope-mode531-([a-z_]+)/.exec(cls755);
        if (hit755) drawn755.push(hit755[1]);
      });
      const ringHit = /var SCOPE_MODES300 = \[([^\]]*)\]/.exec(src);
      const ring755 = ringHit ? JSON.parse('[' + ringHit[1] + ']') : [];
      const rows755 = /var SCOPE_LEVEL_MODES346 = \[([^\]]*)\]/.exec(src);
      const list755 = rows755 ? JSON.parse('[' + rows755[1] + ']') : [];
      return drawn755.join(',') === ROW_ORDER755.join(',')
        && list755.join(',') === ROW_ORDER755.join(',')
        && ring755.join(',') === ROW_ORDER755.join(',') + ',off';
    })(), (function () {
      const drawn755 = [];
      tblOrder541.order.forEach(function (n755) {
        const cls755 = String(((n755 || {}).props || {}).className || '');
        const hit755 = /audio-play-scope-mode531-([a-z_]+)/.exec(cls755);
        if (hit755) drawn755.push(hit755[1]);
      });
      return { rows_drawn_in_order: drawn755, ruled_order: ROW_ORDER755 };
    })());

  // The ramps themselves, measured through the switch. The default stays the strip own green.
  const wfGreenSeen541 = wfColours541(wfF1);
  b.hotBins = [2];
  wfScheme541[0].props.onClick(); m.commit();
  const wfS6 = b.rectLog.length; b.frames(1);
  const wfFlameSeen541 = wfColours541(b.rectLog.slice(wfS6));
  wfScheme541[0].props.onClick(); m.commit();
  const wfS7 = b.rectLog.length; b.frames(1);
  const wfIronbowSeen541 = wfColours541(b.rectLog.slice(wfS7));
  wfScheme541[0].props.onClick(); m.commit();
  const wfS8 = b.rectLog.length; b.frames(1);
  const wfColdSeen541 = wfColours541(b.rectLog.slice(wfS8));
  // T-587: the waterfall's cycle carries SIX more words after cold (auto3 was added to the invited samples on
  // 2026-10-18, so the walk is ten presses long and this pin's cycle_presses moved from 9 to 10 for that
  // reason, which is a re-point with the reason attached rather than a silent edit), and the
  // "comes back to the strip own green" claim is measured at the cycle the control HAS and not at the four it had when
  // this pin was written. The new pictures are captured here as pictures: each one is compared against the ramps and
  // against the others, so a word that painted the same colours as green would be caught here.
  // RE-POINTED AGAIN 2026-10-19 by T-590: the operator asked for a `rand2` variant ("add a rand2 variant that slides
  // the current color to a new random") and it was inserted after `rand` in both vocabularies, so the cycle is eleven
  // words long and every press-count downstream of this loop shifts by one. The five failures this caused on the first
  // run were the walk, not the drawing: the loop below still iterated six words, the press that was supposed to land
  // back on green landed on rand2 instead, and everything after it was measured one scheme out of place.
  const wfDyn587 = {};
  ['auto1', 'auto2', 'rand', 'rand2', 'drift', 'beat_ring', 'auto3'].forEach(function (w587) {
    wfScheme541[0].props.onClick(); m.commit();
    const s587 = b.rectLog.length; b.frames(2);
    wfDyn587[w587] = wfColours541(b.rectLog.slice(s587));
  });
  wfScheme541[0].props.onClick(); m.commit();
  const wfS9 = b.rectLog.length; b.frames(1);
  const wfBack541 = wfColours541(b.rectLog.slice(wfS9));
  check('T-541: the four ramps really are four different pictures — each press changes the colours the row is '
      + 'painted in, and the cycle comes back to the strip own green',
    wfGreenSeen541.length > 0 && wfFlameSeen541.length > 0 && wfIronbowSeen541.length > 0 && wfColdSeen541.length > 0
      && String(wfFlameSeen541) !== String(wfGreenSeen541)
      && String(wfIronbowSeen541) !== String(wfGreenSeen541)
      && String(wfColdSeen541) !== String(wfIronbowSeen541)
      && String(wfBack541) === String(wfGreenSeen541),
    { green: wfGreenSeen541, flames: wfFlameSeen541, ironbow: wfIronbowSeen541, cold: wfColdSeen541,
      back_at_green: String(wfBack541) === String(wfGreenSeen541), cycle_presses: 11 });
  // T-587 (operator, verbatim): "add color schema auto1 and auto2 and rand for global plugin colors (waterfall, too)
  // … auto1: change color so that the resulting spectrum trace of the waterfall results in a rainbow like pattern …
  // rand: every new line gets a random color." Measured off the drawing log, not off the source text: the dynamic
  // words paint hsl colours (the ramps paint rgb), each new line of history is a different hue under auto1, and the
  // ramp colours are still what the four ramp words paint. The count went from six to seven on 2026-10-19 when T-590
  // added rand2, which is the reason this pin's list is written out rather than derived.
  check('T-587: the dynamic words really paint - each of them colours the row in an hsl hue the four ramps never used, and none of them paints the same picture as green',
    ['auto1', 'auto2', 'rand', 'rand2', 'drift', 'beat_ring', 'auto3'].every(function (w587) {
      const seen587 = wfDyn587[w587] || [];
      return seen587.length > 0 && seen587.every(function (c587) { return /^hsl\(\d+, \d+%, \d+%\)$/.test(String(c587)); })
        && String(seen587) !== String(wfGreenSeen541);
    }), { colours: Object.keys(wfDyn587).reduce(function (o587, k587) { o587[k587] = (wfDyn587[k587] || []).slice(0, 3); return o587; }, {}) });
  // T-587 auto1, verbatim from the ask: "change color so that the resulting spectrum trace of the waterfall results
  // in a rainbow like pattern". A trace is a line of history, so the claim is measured as the hue of consecutive
  // lines: each new row advances the wheel by 360 / 48 = 7.5 degrees, which is what turns a single-colour line into a
  // rainbow down the canvas. Measured off the drawing log.
  // The cycle walk above ended back on green (that is what the T-541 pin measures), so four presses land on auto1:
  // green, flames, ironbow, cold, auto1. Counted presses are used instead of reading the control's hover, because an
  // earlier version of this helper tried to read a "currently on" phrase out of the hover and the hover does not say
  // it that way - it named the cycle it walked and the mode landed on cold, which is what the detail showed.
  for (let k587 = 0; k587 < 4; k587++) { wfScheme541[0].props.onClick(); m.commit(); }
  const hues587_lines = [];
  for (let i587 = 0; i587 < 3; i587++) {
    const s587 = b.rectLog.length; b.frames(1);
    const row587 = wfColours541(b.rectLog.slice(s587));
    hues587_lines.push(row587.length ? String(row587[0]).replace(/^hsl\((\d+),.*$/, '$1') : '');
  }
  const d587_1 = (parseInt(hues587_lines[1], 10) - parseInt(hues587_lines[0], 10) + 360) % 360;
  const d587_2 = (parseInt(hues587_lines[2], 10) - parseInt(hues587_lines[1], 10) + 360) % 360;
  // 360 / 48 rows is 7.5 degrees a step, and a hue is printed as a whole number, so the steps alternate 7 and 8 and
  // two of them add to 15. That is the measured shape, and it is what is asserted rather than an exact 7 or 8.

  check('T-587 auto1: the hue walks along the history, so a steady tone is a rainbow down the rows and not one colour - measured as the hue of three consecutive lines',
    hues587_lines.every(function (h587) { return /^\d+$/.test(h587); })
    && [d587_1, d587_2].every(function (d587) { return d587 === 7 || d587 === 8; }) && (d587_1 + d587_2) === 15,
    { hues_of_three_lines: hues587_lines, steps: [d587_1, d587_2], cycle_rows: 48 });  // T-587 auto2, verbatim from the ask: "the color change is triggered by the base beats and jumps to a new accent
  // color with a small minimum interval". Two claims, both measured off the drawing log and both against real time
  // (the harness has no fake clock here, and this suite does not wait): a jump happens when the bass band stands above
  // its own recent mean, and a SECOND beat arriving inside the minimum interval is refused. Frames in this harness
  // land a few milliseconds apart, which is exactly the condition the interval is for, so the refusal is measurable
  // rather than asserted.
  // The auto1 pin above leaves the control ON auto1, so one press lands on auto2. An earlier version of this line
  // pressed five times believing the walk had ended on green, and the detail showed the colours of a ramp: five
  // presses from auto1 land on green again, which is how the mistake was caught.
  wfScheme541[0].props.onClick(); m.commit();   // auto1 -> auto2
  const wfSilence587 = function (n587) { b.hotBins = []; b.frames(n587); };
  const wfHue587 = function () { const s587 = b.rectLog.length; b.frames(1); const row587 = wfColours541(b.rectLog.slice(s587));
    return row587.length ? String(row587[0]) : ''; };
  wfSilence587(1);
  const hueQuiet587 = wfHue587();          // a line with nothing on it: the accent the mode is holding
  // The bass measure reads the lowest slice of the frame, not four bins of it: an earlier version of this fixture set
  // four hot bins and the mean over the slice came to 0.095, which is under the 0.10 floor, so no beat was ever
  // offered and the pin measured a hold with no jump in it. A beat in this fixture is a bass band that is actually
  // carrying sound, which is what the word means.
  const bassBand587 = []; for (let q587 = 1; q587 <= 26; q587++) bassBand587.push(q587);
  b.hotBins = bassBand587; b.hotBinValue = 255;
  const hueBeat1_587 = wfHue587();
  const hueBeat2_587 = wfHue587();          // still loud, still inside the minimum interval in real wall time
  const hueHold587 = wfHue587();
  b.hotBins = [2];
  // RE-POINTED 2026-10-18, with the reason written down: this pin used to compare whole hsl STRINGS, and a loud
  // line and a quiet line are different strings through lightness and saturation alone even when the hue never moves.
  // While writing the auto3 pin the defect behind that was found - scopeDynBass587 asked Array.isArray(tap.freq) on
  // a typed array, so the bass measure returned 0 on every frame and no accent ever jumped - and the pin kept passing
  // through the colour difference. It now reads the hue number out of each colour and compares that, which is the
  // claim the words make.
  const hueOfAuto2_587 = function (c587) { return parseInt(String(c587).replace(/^hsl\((\d+),.*$/, '$1'), 10); };
  check('T-587 auto2: a bass jump moves the HUE, and a second beat inside the minimum interval is refused - the interval is what keeps this a beat mark instead of a flicker',
    /^hsl\(\d+, \d+%, \d+%\)$/.test(hueBeat1_587)
    && isFinite(hueOfAuto2_587(hueQuiet587)) && isFinite(hueOfAuto2_587(hueBeat1_587))
    && hueOfAuto2_587(hueQuiet587) !== hueOfAuto2_587(hueBeat1_587)
    && hueOfAuto2_587(hueBeat1_587) === hueOfAuto2_587(hueBeat2_587)
    && hueOfAuto2_587(hueBeat2_587) === hueOfAuto2_587(hueHold587),
    { hue_before_the_beat: hueQuiet587, hue_at_first_beat: hueBeat1_587, hue_at_second_beat: hueBeat2_587,
      hue_after_hold: hueHold587, hue_numbers: [hueOfAuto2_587(hueQuiet587), hueOfAuto2_587(hueBeat1_587),
        hueOfAuto2_587(hueBeat2_587), hueOfAuto2_587(hueHold587)], min_interval_ms: 250 });
  wfScheme541[0].props.onClick(); m.commit();   // auto2 -> rand
  // RE-CUT 2026-11-06 (Berlin) as plugin T-733, at the operator's word on this item, quoted rather than
  // paraphrased ("3E/4 - go ahead as you suggest"). The claim this pin makes - every new line takes its own colour -
  // was measured against the client's own draw (`st587.hue = Math.random() * 360`, lib/client.js:1151), so the
  // assertion asked a random thing for a guaranteed answer and could fail on luck: it failed once in four full runs
  // on 2026-11-06, four distinct hues having come back. What changes here is the FIXTURE, not the claim and not the
  // client: a seeded draw is installed for exactly the six lines this measures and put back the moment they are
  // drawn, so the six hues are the same six hues in every run and the seed is named in the detail. The seed is the
  // ticket id this pin is named after. The assertion is STRONGER than the one it replaces - this card's own words
  // say six lines came back with six different hues, and it now requires six where it accepted five. Nothing was
  // weakened, and no line of lib/client.js was touched: the panel still picks a fresh random hue per line, and what
  // a person watching the waterfall sees is unchanged by this note.
  const wfRandSeed587 = 587;
  const wfRandRandom587 = function (s587) { return function () {   // mulberry32: a pure 32-bit generator, no state
    s587 |= 0; s587 = s587 + 0x6D2B79F5 | 0;                       // outside itself, so the six draws below are
    let t587 = Math.imul(s587 ^ s587 >>> 15, 1 | s587);            // reproducible without the client being told a
    t587 = (t587 + Math.imul(t587 ^ t587 >>> 7, 61 | t587)) ^ t587; // seed at all - it keeps using Math.random.
    return ((t587 ^ t587 >>> 14) >>> 0) / 4294967296;
  }; }(wfRandSeed587);
  const wfRandomReal587 = Math.random;
  Math.random = wfRandRandom587;
  const wfRand587 = [];
  for (let i587 = 0; i587 < 6; i587++) { wfRand587.push(wfHue587()); }
  Math.random = wfRandomReal587;
  b.hotBins = [2];
  // The saturation in these colours is 77%, not 62%: saturation is 62 + 26 x loudness, and the fixture's columns are
  // carrying sound. The earlier regex asked for 62% and matched nothing, which is a fixture fact, not a code fact.
  check('T-587 rand: every new line takes its own colour - six lines of a steady tone came back with six different hues, and the loudness still reads as brightness',
    wfRand587.every(function (c587) { return /^hsl\(\d+, \d+%, \d+%\)$/.test(String(c587)); })
    && (new Set(wfRand587)).size === 6,
    { six_lines: wfRand587, distinct_hues: (new Set(wfRand587)).size, seeded_fixture: 'mulberry32(' + wfRandSeed587 + ') put back after the six draws' });
  // T-587 auto3 (operator, verbatim, 2026-10-18): "auto3 = hue follows the dominant frequency of the line (a colour
  // that tracks pitch)". The claim is measured as the distance to the hue that the fixture's loudest bin maps to,
  // shrinking line after line - which is what "follows" means - and the distance form is deliberate rather than lazy:
  // the hue approaches on the shortest arc, so a raw up/down comparison would flip sign when a walk crosses the
  // wheel's seam. The mock analyser has 512 bins (this suite's own mock, line 138), so the two fixtures' targets are
  // computed from that count and not from the waterfall's 48 columns; the client measures position over the analyser's
  // bins for the same reason and says so in its own comment.
  wfScheme541[0].props.onClick(); m.commit();   // rand -> rand2 (T-590 inserted rand2 here, so this walk is four
  wfScheme541[0].props.onClick(); m.commit();   // rand2 -> drift   presses long now, not three, and the extra press
  wfScheme541[0].props.onClick(); m.commit();   // drift -> beat_ring is the reason the first run of this pin measured
  wfScheme541[0].props.onClick(); m.commit();   // beat_ring -> auto3 beat_ring's colours under the auto3 words)
  const hueOf587 = function (colour587) { return parseInt(String(colour587).replace(/^hsl\((\d+),.*$/, '$1'), 10); };
  const arcDist587 = function (colour587, target587) {
    const h587 = hueOf587(colour587);
    if (!isFinite(h587)) return NaN;
    return Math.abs((((Math.abs(h587 - target587) % 360) + 540) % 360) - 180);
  };
  const targetLow587 = 15 + (2 / 511) * 300;    // hotBins [2]: the loudest bin sits at the bass edge
  const targetHigh587 = 15 + (400 / 511) * 300; // hotBins [400]: it sits near the top of the analyser
  globalThis.__A3DBG = [];
  b.hotBins = [2]; b.hotBinValue = 255;
  const lowDist587 = []; const lowHue587 = [];
  for (let i587 = 0; i587 < 10; i587++) { const c587 = wfHue587(); lowHue587.push(hueOf587(c587)); lowDist587.push(arcDist587(c587, targetLow587)); }
  b.hotBins = [400]; b.hotBinValue = 255;
  const highDist587 = []; const highHue587 = [];
  for (let i587 = 0; i587 < 10; i587++) { const c587 = wfHue587(); highHue587.push(hueOf587(c587)); highDist587.push(arcDist587(c587, targetHigh587)); }
  const settledLow587 = lowHue587[9]; const settledHigh587 = highHue587[9];   // ten lines each: a quarter of the remaining distance per line reaches the target's neighbourhood, not five
  b.hotBins = [];
  const held587 = [wfHue587(), wfHue587(), wfHue587()];   // a line with nothing on it keeps the colour it holds
  const heldHue587 = hueOf587(held587[0]);
  const arcBetween587 = Math.abs((((Math.abs(settledLow587 - settledHigh587) % 360) + 540) % 360) - 180);
  check('T-587 auto3: the hue follows where the loudest part of the line sits - a bass-edge fixture and a top-of-frame fixture settle on hues '
      + 'more than 60 degrees apart, the distance to each one shrinks line after line, and a silent line holds its colour instead of being pulled to an edge',
    lowDist587.every(function (d587) { return isFinite(d587); }) && highDist587.every(function (d587) { return isFinite(d587); })
    && lowDist587[9] < lowDist587[0] && highDist587[9] < highDist587[0]
    && lowDist587[9] < 30 && highDist587[9] < 30
    && arcBetween587 > 60
    && held587[0] === held587[1] && held587[1] === held587[2] && isFinite(heldHue587),
    { target_bass_edge: targetLow587, target_top_of_frame: targetHigh587, low_hues: lowHue587, low_distances: lowDist587,
      high_hues: highHue587, high_distances: highDist587, settled_low: settledLow587, settled_high: settledHigh587,
      arc_between_settled: arcBetween587, silent_lines: held587, smooth_per_line: 0.25, arc_min: 15, arc_span: 300 });
  // ============ T-590 (2026-10-19): three reports from the operator's own eyes on the live strip ============
  // Verbatim, in the order they were given: "the visualizer for the lama in auto3 seems to be locked into a color too
  // hard", "add a rand2 variant that slides the current color to a new random", "beat_ring seems a bit strange, as if
  // it's only working for short moments to detect the beet, than it's solid color". All three are measured off the
  // drawing log, and all three need more elapsed time than this harness spends by itself: a frame lands a few
  // milliseconds after the last one, while these modes turn over SECONDS. So the clock is advanced by hand, 16 ms a
  // line - 60 fps - and that is stated here rather than left hidden, because a measurement that pretends a virtual
  // clock is a real one is the kind of number this file has already been burned by twice. The real clock is put back
  // before anything else runs.
  const hueNum590 = function (c590) { return parseInt(String(c590).replace(/^hsl\((\d+),.*$/, '$1'), 10); };
  const stepArc590 = function (a590, bb590) { return Math.abs((((Math.abs(a590 - bb590) % 360) + 540) % 360) - 180); };
  const realPerf590 = globalThis.performance;
  let vclock590 = 100000;
  globalThis.performance = { now: function () { return vclock590; } };
  const line590 = function () {
    const s590 = b.rectLog.length; b.frames(1); vclock590 += 16;
    const row590 = wfColours541(b.rectLog.slice(s590));
    return row590.length ? String(row590[0]) : '';
  };
  const lines590 = function (n590) { const out590 = []; for (let i590 = 0; i590 < n590; i590++) out590.push(line590()); return out590; };
  const walk590 = function (n590) { for (let i590 = 0; i590 < n590; i590++) { wfScheme541[0].props.onClick(); m.commit(); } };
  const travelOf590 = function (colours590) {
    const hues590 = colours590.map(hueNum590);
    let maxStep590 = 0, travel590 = 0;
    for (let i590 = 1; i590 < hues590.length; i590++) {
      const d590 = stepArc590(hues590[i590], hues590[i590 - 1]);
      if (d590 > maxStep590) maxStep590 = d590;
      travel590 += d590;
    }
    return { hues: hues590, maxStep: maxStep590, travel: Math.round(travel590) };
  };

  // rand2, the new word. The claim is the SLIDE, so it is measured as the size of the step from one line to the next:
  // 1500 ms for a full 360 degrees is 3.84 degrees at 16 ms a line, and a jump would show tens or hundreds. The travel
  // and the sixth-wheels visited are what stop the slide from being `drift` wearing a target: it has to arrive at
  // genuinely different colours, not merely creep.
  walk590(8);                                   // auto3 -> green -> flames -> ironbow -> cold -> auto1 -> auto2 -> rand -> rand2
  b.hotBins = [2]; b.hotBinValue = 255;
  const rand2Seen590 = travelOf590(lines590(400));
  const rand2Buckets590 = new Set(rand2Seen590.hues.map(function (h590) { return Math.floor(h590 / 60); }));
  check('T-590 rand2 slides: 400 lines at 60 fps never move more than 6 degrees in one line, travel more than 300 degrees in all, and visit at least three sixth-wheels',
    rand2Seen590.hues.every(function (h590) { return isFinite(h590); })
    && rand2Seen590.maxStep <= 6 && rand2Seen590.travel > 300 && rand2Buckets590.size >= 3,
    { max_step_degrees: rand2Seen590.maxStep, total_travel_degrees: rand2Seen590.travel,
      sixth_wheels_visited: rand2Buckets590.size, first_hues: rand2Seen590.hues.slice(0, 6),
      slide_ms: 1500, hold_ms: 500, min_jump_degrees: 70 });

  // The comparison that gives the word its meaning: the same fixture under `rand` is a jump, and the difference between
  // the two words is one line of drawing code plus a target.
  walk590(10);                                  // rand2 -> drift -> beat_ring -> auto3 -> green -> flames -> ironbow -> cold -> auto1 -> auto2 -> rand
  const randSeen590 = travelOf590(lines590(40));
  check('T-590 the pair is really a pair: under rand the same fixture jumps by tens of degrees between consecutive lines, which is what rand2 was added to avoid',
    randSeen590.maxStep > 30,
    { rand_max_step_degrees: randSeen590.maxStep, rand_travel_degrees: randSeen590.travel,
      rand2_max_step_degrees: rand2Seen590.maxStep });

  // auto3, the lock report. A steady bass fixture holds its loudest bin in one place forever, which is exactly the
  // condition the operator saw: the follow converges and the wall sits on one colour. Over 300 lines - 4.8 virtual
  // seconds, longer than one 3.5 s breath - the hue has to keep moving on its own.
  // THE FIRST 60 LINES ARE THROWN AWAY ON PURPOSE, and the reason is a swap test that caught this pin passing for the
  // wrong reason: with the breath switched off (`scratch/client.js.t590_nobreathe`) the suite still reported 312 pass /
  // 0 fail, because auto3 starts on its seed hue 165 and the fixture's target is 16.2, so the APPROACH to the pitch
  // hue is itself a 149-degree travel with a dozen distinct hues in it. Measured over the whole run, the pin was
  // measuring the mode getting to the colour, not the mode living in it. The claim under test is what happens after it
  // has arrived, so the arrival is discarded and the tail is what is judged.
  walk590(4);                                   // rand -> rand2 -> drift -> beat_ring -> auto3
  b.hotBins = [2]; b.hotBinValue = 255;
  const a3Colours590 = lines590(300);
  const a3Seen590 = travelOf590(a3Colours590.slice(60));
  const a3Distinct590 = new Set(a3Seen590.hues).size;
  const a3Head590 = travelOf590(a3Colours590.slice(0, 60));
  b.hotBins = [];
  check('T-590 auto3 is not locked: after the approach to the pitch hue is discarded (60 lines), a fixture whose loudest bin never moves still travels more than 12 degrees over the remaining 240 lines and shows at least 5 distinct hues, so a steady voice is a moving wall rather than one flat colour',
    a3Seen590.travel > 12 && a3Distinct590 >= 5,
    { tail_travel_degrees: a3Seen590.travel, tail_distinct_hues: a3Distinct590,
      tail_first_hues: a3Seen590.hues.slice(0, 8), approach_travel_degrees: a3Head590.travel,
      lines_discarded_as_approach: 60, breathe_degrees: 18, breathe_ms: 3500, smooth_per_line: 0.35 });

  // The fixture is deliberately voice-shaped: the bass slice (the lowest 12% of 512 bins, so bins 1..61) is EMPTY the
  // whole time and what changes is the frame as a whole, syllable after syllable. My first version of this fixture was
  // one hot bin against four hundred, which is a flux of 0.002 against 0.06 - both under the 0.10 floor that keeps a
  // hiss from counting as a beat - so no beat was ever offered and the pin measured a mode doing nothing. A syllable
  // is not one bin wide, and the fixture now says so: 101 bins against 401, both clear of the bass slice.
  walk590(10);                                  // auto3 -> green -> flames -> ironbow -> cold -> auto1 -> auto2 -> rand -> rand2 -> drift -> beat_ring
  b.hotBins = [];
  const brQuiet590 = travelOf590(lines590(60));
  const brQuietDistinct590 = new Set(brQuiet590.hues).size;
  const lowBins590 = []; for (let q590 = 100; q590 <= 200; q590++) lowBins590.push(q590);
  const highBins590 = []; for (let q590 = 100; q590 <= 500; q590++) highBins590.push(q590);
  const brHues590 = []; const brJumps590 = [];
  let brPrev590 = null;
  for (let r590 = 0; r590 < 4; r590++) {
    b.hotBins = lowBins590; b.hotBinValue = 255;
    lines590(30).forEach(function (c590) { brHues590.push(hueNum590(c590)); });
    b.hotBins = highBins590; b.hotBinValue = 255;
    lines590(12).forEach(function (c590) { brHues590.push(hueNum590(c590)); });
  }
  b.hotBins = [2]; b.hotBinValue = 255;
  for (let i590 = 1; i590 < brHues590.length; i590++) {
    if (stepArc590(brHues590[i590], brHues590[i590 - 1]) > 60) brJumps590.push(i590);
  }
  check('T-590 beat_ring keeps arriving and never freezes: on a voice-shaped fixture whose bass slice is silent throughout, four syllable blocks set at least two new accents, and in a 60-line stretch with no beat at all the hue still shows at least 5 distinct values instead of holding one',
    brJumps590.length >= 2 && brQuietDistinct590 >= 5,
    { accent_jumps: brJumps590.length, jump_lines: brJumps590.slice(0, 6),
      distinct_hues_in_silence: brQuietDistinct590, silence_travel_degrees: brQuiet590.travel,
      ring_gap_ms: 300, fan_degrees: 90, ring_window_lines: 38 });
  if (realPerf590) globalThis.performance = realPerf590; else delete globalThis.performance;

  check('T-541: a column colour is interpolated between stops, not snapped to a band — a bin at the top of the '
      + 'analyser window sits between two stops of the green ramp and gets a colour that is neither of them',
    (function () {
      const lit541 = wfRow541(wfF1).filter(function (r) { return r[5] !== 'rgb(10,58,14)'; });
      return lit541.length === 1 && /^rgb\(\d+,\d+,\d+\)$/.test(lit541[0][5]) && lit541[0][5] !== 'rgb(0,200,0)';
    })(), (function () {
      const lit541 = wfRow541(wfF1).filter(function (r) { return r[5] !== 'rgb(10,58,14)'; });
      return lit541.length ? lit541[0][5] : 'no lit column';
    })());

  // Source pins: the two facts a drawing cannot show, because they are about what this mode REFUSES to do — the
  // shared per-frame clear it must skip, and the whole-canvas gate it joined instead of inventing its own.
  // RE-POINTED 2026-10-28 by T-681 (the operator's screenshot of the clock drawn over a leftover llama: "you are
  // missing to clear the canvas on clock draw"). The gate is still a gate - a waterfall or a llama whose canvas is
  // cleared every frame has no history at all - and it now asks ONE question more than before: which face the canvas
  // is showing. A clock face is never one of the modes that keep their picture in the canvas, so it starts clean.
  check('T-541, re-pointed by T-681: the per-frame background clear is gated, and the gate asks BOTH which face the '
      + 'canvas is showing and which mode paints its history in the canvas - a clock face always starts clean, the '
      + 'two history modes keep theirs',
    /var keepsCanvasHistory681 = scopeFaceNow681\(\) === "visual" && \(m === "waterfall" \|\| m === "llama"\);/
      .test(src)
      && /if \(!keepsCanvasHistory681\) \{ g\.fillStyle = SCOPE_BG300; g\.fillRect\(0, 0, W, H\); \}/.test(src)
      // And the face answer is one answer shared by every consumer, so the clear cannot disagree with the paint.
      && (src.match(/scopeFaceNow681\(\)/g) || []).length >= 6, 'no gated clear, or the face answer is not shared');
  check('T-541 source: the mode joins the gate the VU pair already used for the whole canvas, and the clock band, '
      + 'its translation and the peak reservation all ask that one predicate',
    // RE-POINTED 2026-11-07 by T-746. The rolling mark joins the one predicate for the reason its own comment
    // gives: a body that rolls needs its own diagonal in the box it rolls in, so it takes the whole canvas and
    // reserves nothing. The pattern is written out in full now, and that matters: the unescaped `||` before
    // "knight" made this an alternation, and since T-681 put a clock call and a comment inside the body the
    // pattern could not have matched this function at all. That is how a pin stops pinning - it goes on passing.
    // Same assertion, stronger form, and it now names every mode the gate holds. RE-POINTED 2026-11-07 by T-749:
    // the whale mark is drawn by the same painter on the same ground, so it joins the same gate, and a gate that
    // named the marks one at a time is the thing this pin exists to catch.
    /function scopeFullCanvas541\(m541\) \{[\s\S]*?return scopeVuMode345\(m541\) \|\| m541 === "waterfall" \|\| m541 === "llama" \|\| m541 === "knight" \|\| m541 === "qwen" \|\| m541 === "whale" \|\| scopeClockMode677\(m541\);/.test(src)
      && /if \(!full541\) scopeClockBand300\(g, W, SCOPE_CLOCK_H300\);/.test(src)
      && /if \(!full541\) g\.translate\(0, SCOPE_CLOCK_H300\);/.test(src)
      // Re-pointed in place 2026-10-21 (T-599, operator ruling 01:41 Berlin "The oscilloscope row only"): the peak
      // reservation now asks one more question - the switch on the oscilloscope row. The predicate is still ONE
      // predicate, which is what this pin was written to protect: the clock band, its translation and the peak
      // reservation must not disagree about which mode owns what.
      && /var noPeak445 = full541 \|\| m === "spectrum" \|\| \(m === "oscilloscope" && scopePeakOsciRef599\.current === "off"\);/.test(src), 'the gate is not shared');
  check('T-541 source: the mode sits in the ring before off, and the column map is the bargraph own log chain '
      + 'with a count rather than a second mapping that could disagree with the first',
    // RE-POINTED 2026-10-28 by T-677: the ring literal grew onto two lines. RE-POINTED AGAIN 2026-10-28 by T-681:
    // the clock faces left the ring, and the literal is one line again. RE-POINTED AGAIN 2026-11-07 by T-746: the
    // rolling mark joined at the end, before off, which is where every mode has joined this ring. RE-POINTED AGAIN
    // the same day by T-749, for the same reason and the same position: the whale mark joins after the mark the
    // operator already had, before off. The pin asks the same thing it always asked - the mode sits in the ring
    // before off, and no clock word is in it at all - and it now asks it of a ring with two marks in it.
    // RE-POINTED AGAIN the same evening by T-755, and this time the ORDER itself moved, on the operator's word,
    // verbatim: "in the visualizer order, move the LED bars under waveform , and make dancing llama the last
    // visualizer in the list". The literal below IS that order: the LED bars directly after the waveform, the
    // dancing llama last among the entries that draw, `off` still the last word of the ring because it is the
    // absence of a visualizer and not one. What this pin has always protected is unchanged -- every entry sits in
    // the ring, `off` is last, and no clock word is in it at all.
    /var SCOPE_MODES300 = \["spectrum", "oscilloscope", "static", "knight", "vu_led", "vu_needle", "waterfall", "qwen", "whale", "llama", "off"\];/.test(src)
      && !/var SCOPE_MODES300 = \[[^\]]*clock/.test(src)
      // RE-CUT 2026-11-06 (T-729, WM-30 item 2): the walk carries a fifth face. The operator's ask named the
      // colour outright - "add 'neon green color variant'" - and the ruling of 2026-11-06 put it where the split-flap
      // variant already sits: a face word and a second palette.
      // RE-CUT AGAIN the same evening (T-737, WM-31): the operator ruled the cycle's ORDER, verbatim: "order of
      // clocks should be \"nixie orange -> nixie green\" while cycling". The green palette now sits beside the amber
      // one, where the two boards already sit. The same five faces, one direction, the same wrap: this pin asks what
      // it always asked, and now it asks it of a walked order.
      && /var CLOCK_MODES681 = \["clock_led", "clock_nixie", "clock_nixie_green", "clock_flap", "clock_flap_light"\];/.test(src)
      && /scopeBandMap300\(binCount541, binHz541, cols541\)/.test(src), 'the ring or the mapping moved');
  // T-542: the same two facts for the second spectrogram mode. It reads the SAME cached chain shape (scopeBandMap300
  // with a count) and it must NOT be cleared per frame either, for the same reason the waterfall gave: a mode whose
  // canvas is wiped every frame has no history, and this mode's history is 128 columns of what was just heard.
  check('T-542 source: the horizontal spectrogram is built from the same log chain the bars and the waterfall use, '
      + 'so the three pictures cannot disagree about where a frequency sits',
    /scopeBandMap300\(binCount542, binHz542, rows542\)/.test(src)
      && /scopeLlamaCols542\(binCount542, binHz542, specRows542\)/.test(src), 'the llama built its own mapping');
  const lmFn542 = (function () {
    const at542 = src.indexOf('function scopeLlamaFrame542');
    if (at542 < 0) return '';
    const end542 = src.indexOf('\n      }', at542);
    return end542 < 0 ? '' : src.slice(at542, end542 + 7);
  })();
  check('T-542 source, RE-POINTED four times on 2026-10-17: the history now lives in a bitmap of its own, the shift '
      + 'copies the whole band of THAT bitmap, the canvas is filled with the ground and the band is then blitted onto '
      + 'the wall\'s own rect, then the floor is mirrored from a HISTORY bitmap onto the visible canvas, and the llama '
      + 'is painted last. '
      + 'That order is the design: an animal painted '
      + 'before the blit would be erased by it, and an animal painted into the history would travel with the '
      + 'history forever. The third re-point is T-558: the mirror no longer names the wall\'s bitmap directly, it '
      + 'names a source that IS the right channel\'s band when a stereo take gave the mode one and the wall\'s band '
      + 'when it did not, so both branches are measured here and the order claim is untouched. The fourth is T-567: '
      + 'the band is the WALL and not the canvas, so the shift is measured against cellD542, the blit is measured '
      + 'against the wall\'s own CSS rect, and the wall\'s pixels are measured as cells of cellD542 -- the drawing no '
      + 'longer addresses a device-sized bitmap with CSS numbers. The order read-out stays tightened, because '
      + 'indexOf("g542.drawImage") also matches inside "hg542.drawImage" and the first version of this pin was '
      + 'therefore reading the shift twice instead of the blit. '
      + '(T-752 contract change, 2026-11-07: the marker for "the animal is painted last" no longer names one icon\'s '
      + 'mask constant, because the mode now paints whichever icon its own setting names -- the operator\'s ask: '
      + '"add the qwen and whale icons as options (setting) to replace the dancing llama". It names the paint loop, '
      + 'which is the same fact and is icon-independent. The order claim is untouched.)',
    /hg542\.drawImage\(hist542\.cv, cellD542, 0, bandW542 - cellD542, bandH542,/.test(lmFn542)
      && /g542\.drawImage\(hist542\.cv, 0, 0, bandW542, bandH542, specX542, inset542, specW542, specRows542\)/.test(lmFn542)
      && /hg542\.fillRect\(\(specW542 - 1\) \* cellD542, \(specRows542 - 1 - r542\) \* cellD542, cellD542, cellD542\)/.test(lmFn542)
      && /g542\.drawImage\(floorSrc542, 0, srcY542, bandW542, cellD542,/.test(lmFn542)
      && /var floorSrc542 = \(histR542 \? histR542 : hist542\)\.cv;/.test(lmFn542)
      && (function () {
        const h542 = lmFn542.indexOf('hg542.drawImage');
        const b542 = lmFn542.indexOf('g542.drawImage(hist542.cv, 0, 0, bandW542');
        const f542 = lmFn542.indexOf('g542.drawImage(floorSrc542');
        const a542 = lmFn542.indexOf('bits542 = mask542[ry542]');
        return h542 >= 0 && b542 > h542 && f542 > b542 && a542 > f542
          && (lmFn542.match(/hg542\.drawImage\(/g) || []).length === 1;   // the call, not the typeof guard beside it
      })()
      && (src.match(/SCOPE_LLAMA_GAP542|SCOPE_LLAMA_REGION542|SCOPE_LLAMA_PLAY542/g) || []).length === 0,
    { order: (function () {
        const h542 = lmFn542.indexOf('hg542.drawImage');
        const b542 = lmFn542.indexOf('g542.drawImage(hist542.cv, 0, 0, bandW542');
        const f542 = lmFn542.indexOf('g542.drawImage(floorSrc542');
        const a542 = lmFn542.indexOf('bits542 = mask542[ry542]');
        return 'history shift ' + h542 + ' -> blit ' + b542 + ' -> floor mirror ' + f542 + ' -> llama ' + a542;
      })(),
      retired_constants_left: (src.match(/SCOPE_LLAMA_GAP542|SCOPE_LLAMA_REGION542|SCOPE_LLAMA_PLAY542/g) || []).length });
  check('T-542 source: the llama mode paints no text at all — no fillText, no digits, no clock band — because the '
      + 'only number this mode could print would be a guess about tempo (T-511: a guessed BPM is a lie)',
    lmFn542.length > 6000 && !/(fillText|SCOPE_CLOCK|CLOCK_LIT)/.test(lmFn542)
      && /var fluxMean542 = drawn542 > 0 \? \(flux542 \/ drawn542\) : 0;/.test(src),
    'the mode paints text or measures flux differently');

  teardown();

  // ---------------------------------------------------------------- scenario D: the devicePixelRatio clamp
  b = makeBrowser({ devicePixelRatio: 4, storage: { 'deepamp:scope.mode': 'off' } });
  m = await mount(b, { canvas2d: true, audioTracks: 1 });
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush(); bag = m.commit(); await flush();
  m.armAudio(1);
  // loadClient installs its own global.window (the module-loader handshake) and only puts the previous one
  // back when the suite calls restore(), so the display factor has to be installed AFTER the client is
  // loaded - which is also when a real browser would have it.
  global.window = { devicePixelRatio: 4 };
  m.clickStrip();
  check('T-299 CONTRACT: the backing store is capped at 2x the CSS box even on a 4x display (400 x 160 for a '
      + '200 x 80 strip - T-333 moved the default width from 260 to 200, the 2x cap rule is unchanged)',
    m.canvases().length === 1 && m.canvases()[0].props.width === '400' && m.canvases()[0].props.height === '160'
      && m.canvases()[0].props.style.width === '200px',
    m.canvases().length ? [m.canvases()[0].props.width, m.canvases()[0].props.height] : 'no canvas');
  teardown();

  // ---------------------------------------------------------------- scenario F: the zero-track case, measured live
  // In a real browser (measured 2026-10-12 21:05 on this very panel) `captureStream()` on an element that
  // has no media loaded answers a MediaStream with ZERO audio tracks, and `createMediaStreamSource` rejects
  // it with InvalidStateError "MediaStream has no audio track". Before this was fixed the strip therefore
  // said "click the strip to open the analyser" AFTER the user had clicked the strip - a sentence that was
  // true and useless at the same time. What has to hold now: no graph is built, the strip names the real
  // reason, nothing throws, and the element's own load event arms the tap so the user never has to click a
  // second time.
  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'off' } });
  m = await mount(b, { canvas2d: true, audioTracks: 0 });   // captureStream exists, but answers no audio track
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush(); bag = m.commit(); await flush();
  const deadNode = m.armAudio(0);
  m.clickStrip();
  check('T-299 CONTRACT (measured live): a MediaStream with no audio track does NOT get a graph built on it '
      + '(createMediaStreamSource would throw InvalidStateError)',
    b.ctxBuilt === 0 && b.sources === 0, [b.ctxBuilt, b.sources]);
  check('T-305: and the zero-track case prints no instruction either - it shows the mode it was given, with '
      + 'no graph and no sentence',
    !/press play|file loaded/.test(m.noteText()) && m.canvases().length === 1, [m.noteText(), m.canvases().length]);
  check('U-18: the zero-track case shows its idle frame and schedules no loop (no graph, but not an empty box)',
    m.canvases().length === 1 && b.rafScheduled === 0, [m.canvases().length, b.rafScheduled]);
  // Now the player gets a file: the same node answers a real track and the panel's own event arms the tap.
  m.armAudio(1);             // now the player has a file in it
  deadNode.fire('loadstart');
  m.commit();
  check('T-299 CONTRACT: a source being assigned is not media flowing - loadstart and playing alone do NOT '
      + 'capture a tap (that is the silent-track trap)',
    b.ctxBuilt === 0 && b.sources === 0, [b.ctxBuilt, b.sources]);
  deadNode.fire('playing');  // media is rendering, but the clock has not moved yet
  m.commit();
  check('T-299: even the playing event is not enough - the strip waits for the clock to move',
    b.ctxBuilt === 0 && b.sources === 0, [b.ctxBuilt, b.sources]);
  deadNode.fire('timeupdate');  // the clock moved: the pipeline is attached
  m.commit();
  check('T-299 CONTRACT: when the player is really playing, the strip arms itself - no second click on the strip',
    b.ctxBuilt === 1 && b.sources === 1, [b.ctxBuilt, b.sources]);
  // T-305: the status line is never blank while the panel is up - it names the player's state ("idle", a
  // title, an alarm). What must be absent once something is really being drawn is an INSTRUCTION about the
  // visualizer, because the picture is the answer.
  check('T-299: and no visualizer instruction is printed once there is something to draw',
    !/press play|file loaded|click the strip/.test(m.noteText()) && m.canvases().length === 1,
    [m.noteText(), m.canvases().length]);
  check('T-299: the loop is running now that the element is playing and a tap exists',
    b.rafScheduled >= 1, b.rafScheduled);
  teardown();

  // ---------------------------------------------------------------- scenario G: the ended-track case, measured live
  // Chrome keeps an ENDED track inside getAudioTracks(). A tap built for one take is therefore still "a
  // stream with a track" after that take is over, and an analyser on it reads silence for the rest of the
  // session. The strip has to notice readyState and rebuild, or the second take of the evening draws a flat
  // line and looks like a silent file.
  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'off' } });
  m = await mount(b, { canvas2d: true, audioTracks: 1 });
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush(); bag = m.commit(); await flush();
  m.armAudio(1);
  m.clickStrip();
  const firstTapStreams = b.streams;
  check('T-299: the first take builds one tap', firstTapStreams === 1 && b.ctxBuilt === 1, [firstTapStreams, b.ctxBuilt]);
  const deadAudio = m.armAudio(1);
  deadAudio._tracksList.forEach(function (t) { t.readyState = 'ended'; });   // the take finished: Chrome ends the track
  deadAudio.fire('ended');
  m.commit();
  check('T-299 CONTRACT: an ended element closes its graph at once - the tap does not sit around waiting to be '
      + 'reused by the next take',
    b.ctxClosed >= 1 && b.rafCancelled >= 1 && (b.rafScheduled - b.rafCancelled) === 0,
    [b.ctxClosed, b.rafCancelled, b.rafScheduled]);
  deadAudio.paused = false; deadAudio.ended = false;                        // a new row was chosen and is playing
  deadAudio.fire('timeupdate');
  m.commit();
  check('T-299 CONTRACT (measured live): the next take captures a FRESH stream instead of reusing the one the '
      + 'finished take left behind',
    b.streams >= 2 && b.ctxBuilt >= 2, [b.streams, b.ctxBuilt]);
  check('T-299: the old graph was closed when its track ended (no second AudioContext left running behind it)',
    b.ctxClosed >= 1, b.ctxClosed);
  check('T-299: and the strip still has a canvas to draw into after the rebuild',
    m.canvases().length === 1, m.canvases().length);
  teardown();

  // ---------------------------------------------------------------- scenario H: the self-heal
  // A tap can be built correctly and still carry nothing: the capture happened while the element had a
  // source but no media pipeline attached, so the track is live and silent forever. The strip has to notice
  // that it is drawing an empty box while the element is playing, and capture again - a bounded number of
  // times, so a genuinely silent file cannot make the panel churn AudioContexts all evening.
  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'spectrum' } });
  m = await mount(b, { canvas2d: true, audioTracks: 1 });
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush(); bag = m.commit(); await flush();
  const healNode = m.armAudio(1);
  healNode.fire('timeupdate');
  m.commit();
  check('T-299: a flowing element builds the first tap', b.ctxBuilt === 1 && b.sources === 1, [b.ctxBuilt, b.sources]);
  b.frames(10);
  check('T-299: while the tap carries signal the quiet counter stays reset (no rebuild is queued)',
    b.ctxBuilt === 1 && b.freqCalls > 0, [b.ctxBuilt, b.freqCalls]);
  b.silent = true;                       // the track goes dead: the element plays, the analyser reads nothing
  b.frames(92);                          // 92 draws at the new 60 fps: past the 90-draw (1.5 s) wait
  check('T-299 CONTRACT (measured live): a playing element whose tap reads no signal for 1.5 s of draws gets '
      + 'that tap thrown away and captured again',
    b.ctxBuilt === 2 && b.ctxClosed >= 1 && b.streams >= 2, [b.ctxBuilt, b.ctxClosed, b.streams]);
  b.frames(92);
  check('T-299: a second rebuild is allowed (the cap is 2 per playback)',
    b.ctxBuilt === 3, b.ctxBuilt);
  b.frames(120);
  check('T-299 CONTRACT (the cap holds): a third rebuild is refused - a silent file must not make the panel '
      + 'churn AudioContexts',
    b.ctxBuilt === 3 && b.ctxClosed === 2, [b.ctxBuilt, b.ctxClosed]);
  b.silent = false;                      // signal comes back
  b.frames(120);
  check('T-299: once signal returns the strip stops rebuilding and keeps drawing',
    b.ctxBuilt === 3 && b.freqCalls > 40 && m.canvases().length === 1, [b.ctxBuilt, b.freqCalls]);
  teardown();

  // ---------------------------------------------------------------- scenario J: the two-channel tap
  // U-18 (user 2026-10-13 01:39): "if we play stereo, do we see two lines in different colors ?" Feeding one
  // analyser straight from the captured stream gives the browser's own mono downmix, so a second line drawn
  // from it would be the same wave twice - a fake second channel. The tap therefore splits the stream and
  // hangs one analyser per channel output, and the strip only claims stereo when the RIGHT analyser actually
  // carries something above the floor.
  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'oscilloscope' } });
  b.tdAmp = 24; b.tdAmpR = 18;                    // two channels that are NOT the same signal
  m = await mount(b, { canvas2d: true, audioTracks: 2 });
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush(); bag = m.commit(); await flush();
  const stNode = m.armAudio(2);
  stNode.paused = false; stNode.ended = false;
  stNode.fire('timeupdate');
  m.commit();
  check('U-18: a stereo take builds ONE channel splitter, not a second source node and not a second graph',
    b.splitters === 1 && b.sources === 1 && b.ctxBuilt === 1, [b.splitters, b.sources, b.ctxBuilt]);
  // connect(destination, OUTPUT, input): both analysers have no inputs, so the pair reads [1,0] for the right
  // channel - output 1 of the splitter into input 0 of that analyser. Getting this wrong is the classic way to
  // build a tap that draws the left channel twice.
  check('U-18: the splitter is asked for exactly two channels, and the two analysers hang on splitter outputs 0 and 1 in that order',
    b.splitChannels === 2 && JSON.stringify(b.splitOut) === '[[0,0],[1,0]]', [b.splitChannels, b.splitOut]);
  const strokesBaseJ = b.strokes;
  b.frames(2);
  m.commit();
  check('U-18: every draw strokes two traces when the take is stereo - one per channel',
    b.strokes - strokesBaseJ === 4, [b.strokes - strokesBaseJ]);
  const colsJ = b.strokeLog.slice(-2);
  check('U-18: the two lines are drawn in two different colours, and the right one is not a shade of green',
    colsJ[0] === '#9fe89f' && colsJ[1] === '#8ab4f8', colsJ);
  // T-305: mono / stereo is printed the way the reference prints it - BOTH words, with the true one lit and
  // the other dark. A read-out that only prints the active word cannot show that the panel knows the other
  // one is not true.
  const chanJ = m.els('audio-play-chan');
  check('U-18: and the strip says it out loud - both words printed, stereo lit and mono dark',
    chanJ.length === 1 && /stereo/.test(m.chanPairText(chanJ[0])) && /mono/.test(m.chanPairText(chanJ[0]))
      && m.chanLit(chanJ[0], 'audio-play-chan-stereo') === '#3fb950'
      && m.chanLit(chanJ[0], 'audio-play-chan-mono') === '#555',
    [m.chanPairText(chanJ[0]), m.chanLit(chanJ[0], 'audio-play-chan-stereo'), m.chanLit(chanJ[0], 'audio-play-chan-mono')]);
  // T-734 (2026-11-06, at the operator's word on the open item - "3E/4 - go ahead as you suggest"): the two words
  // are the vocabulary's words. The check above asks whether the pair is printed and which half is lit; this one
  // asks whether the spelling has one home, which is the half of this feature that was written and never wired -
  // the read-out spelled "mono" and "stereo" out inline while SCOPE_CHAN_WORDS300 sat unread. Both halves are
  // measured here: the rendered pair is exactly the two words with the separator this row prints, and the drawing
  // takes them from the vocabulary instead of spelling them out. This reads the same element more closely than the
  // check above; nothing in this file was weakened to make it pass.
  check('T-734: the mono/stereo pair prints the words from the one vocabulary - the rendered pair is exactly "mono  stereo", and the drawing reads them from SCOPE_CHAN_WORDS300',
    m.chanPairText(chanJ[0]) === 'mono  stereo'
    && /SCOPE_CHAN_WORDS300\[1\]/.test(src) && /SCOPE_CHAN_WORDS300\[2\]/.test(src),
    { pair_text: m.chanPairText(chanJ[0]), read_at: [src.indexOf('SCOPE_CHAN_WORDS300[1]'), src.indexOf('SCOPE_CHAN_WORDS300[2]')] });
  check('U-18: the second channel is only claimed from the second analyser, never from the number of tracks',
    /SCOPE_STEREO_FLOOR300/.test(src) && /SCOPE_LINE_R300/.test(src), [src.indexOf('SCOPE_STEREO_FLOOR300')]);
  teardown();

  // ---------------------------------------------------------------- scenario K: the static peaks read (T-303 client half)
  // The static mode draws the TAKE'S peaks, not the live output - so it needs the host read. Two cases are
  // pinned here: the lane cannot answer (which is the state of this harness today, the verb is written but
  // not loaded), and the lane answers, which is what the drawing is for.
  const pk = [];
  for (let i = 0; i < 120; i++) {
    const a = 0.05 + 0.75 * Math.abs(Math.sin(2 * Math.PI * i / 40));
    pk.push({ i: i, from: i * 400, to: i * 400 + 400, samples: 400, min: -a, max: a, peak: a, rms: a * 0.7 });
  }
  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'oscilloscope' } });
  m = await mount(b, {
    canvas2d: true, audioTracks: 1,
    items: [{ id: 'ap-9001', fn: 'tts', kind: 'tts', status: 'ok', model: 'm1', voice: 'voy_janeway', duration: 3.44, text: 'the take' }],
    peaks: pk, channels: 2, sampleRate: 48000,
  });
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush(); bag = m.commit(); await flush();
  const playBtnK = m.created().filter(function (e) {
    return e.type === 'button' && /play the row the transport is on/.test(String(e.props && e.props.title));
  }).pop();
  check('U-18: the panel has a row to play (the peaks read needs a job number to ask for)', !!playBtnK, !!playBtnK);
  if (playBtnK) { playBtnK.props.onClick(); await flush(); m.commit(); await flush(); }
  m.armAudio(1);
  check('U-18: playing the row did not already go and fetch peaks - the read belongs to the static step',
    b.peaksCalls === 0, b.peaksCalls);
  const rectsBeforeK = b.fillRects;
  m.clickStrip();                                   // oscilloscope -> static
  await flush(); m.commit();
  // The host answers wave_peaks as GET (?job=) and as POST ({job:}), and the panel uses the POST shape the
  // same way it uses every other read here. What matters is WHICH row it names, and that it names a row and
  // never a path - a page must not be able to ask the host to read a file it picks itself.
  check('T-303 client half: stepping into waveform asks the lane for THIS take, named by job id and by nothing else',
    b.peaksCalls === 1 && /"job":"ap-9001"/.test(b.peaksBodies[0]) && !/\/mnt\/|\.\.\//.test(b.peaksBodies[0] + b.peaksUrls[0]),
    [b.peaksUrls, b.peaksBodies]);
  // T-305: with an answer in hand the status line goes back to naming the take. The refusal sentence is gone
  // from the panel's one status display - the picture is the answer, and the title is the status.
  // T-331 made this assertion honest instead of accidental, the same way it did in ui_state: the fixture row
  // carries no route_url, so until now the status line fell back to printing the job id and the check passed
  // through that fallback. The panel now identifies the row from the route itself, so the line speaks the take
  // (T-307: "the line speaks the take, not its ordinal") and the id sits in the hover, where T-307 put it.
  // Both halves of the U-18 intent are still required: no refusal sentence on the display, and the row that
  // the peaks belong to is named.
  const u18El = m.els('audio-play-now')[0] || {};
  const u18Tip = String(u18El.props && u18El.props.title) || m.noteText();
  check('U-18: once the take has peaks the strip stops explaining and just shows them (the refusal leaves the status line)',
    !/does not answer them yet|will not answer peaks/.test(m.noteText())
    && (/ap-9001/.test(m.noteText()) || /ap-9001/.test(u18Tip)), { line: m.noteText(), hover: u18Tip });
  const chanK = m.els('audio-play-chan');
  check('U-18: the channel pair is taken from what the lane reported, not from a guess',
    chanK.length === 1 && m.chanLit(chanK[0], 'audio-play-chan-stereo') === '#3fb950'
      && m.chanLit(chanK[0], 'audio-play-chan-mono') === '#555',
    [m.chanPairText(chanK[0]), m.chanLit(chanK[0], 'audio-play-chan-stereo')]);
  check('U-18: the static frame painted min/max bars into the box (it is a picture of the take, not a message)',
    b.fillRects - rectsBeforeK >= 100, [b.fillRects - rectsBeforeK]);
  check('U-18: and it asked for the peaks exactly once - the read is cached per job, not re-fetched per frame',
    b.peaksCalls === 1, b.peaksCalls);
  teardown();

  // The same step on a lane that cannot answer yet, which is the state of this harness AND of the live panel
  // until the host wave is loaded. The strip must say so in one user sentence and still draw its baseline.
  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'oscilloscope' } });
  m = await mount(b, {
    canvas2d: true, audioTracks: 1,
    items: [{ id: 'ap-9002', fn: 'tts', kind: 'tts', status: 'ok', model: 'm1', voice: 'voy_janeway', duration: 2.64, text: 'the take' }],
  });                                     // no peaks option: the lane refuses, as it does today
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush(); bag = m.commit(); await flush();
  const playBtnL = m.created().filter(function (e) {
    return e.type === 'button' && /play the row the transport is on/.test(String(e.props && e.props.title));
  }).pop();
  if (playBtnL) { playBtnL.props.onClick(); await flush(); m.commit(); await flush(); }
  m.armAudio(1);
  m.clickStrip();
  await flush(); m.commit();
  check('U-18: when the lane will not answer the peaks read, the strip says so in one plain sentence',
    /will not answer peaks for this row/.test(m.noteText()), m.noteText());
  check('U-18: that sentence carries the lane answer instead of inventing one, and it names no route',
    /unknown route/.test(m.noteText()) && !/wave_peaks\?|T-303/.test(m.noteText()), m.noteText());
  check('U-18: even refused, static keeps drawing its box (a baseline) rather than an empty frame',
    m.canvases().length === 1, m.canvases().length);

  // ---------------------------------------------------------------- scenario E: no canvas, no 2d context
  // The panel harness is the same kind of browser as scenario A minus a real canvas: the element the ref
  // hands back has no getContext. Drawing must be skipped, not thrown - the same rule that kept T-298 from
  // crashing on FileReader.
  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'off' } });
  m = await mount(b, { audioTracks: 1 });          // no canvas2d option: the bare harness canvas
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush(); bag = m.commit(); await flush();
  m.armAudio(1);
  m.clickStrip();
  let threw = null;
  try { b.frames(6); } catch (e) { threw = String(e && e.message ? e.message : e); }
  check('T-299 CONTRACT: a canvas that cannot give a 2d context is skipped, not thrown on (the harness has no '
      + 'canvas at all)',
    threw === null, threw);
  check('T-299: and the loop survived that frame (it is still scheduled, not silently dead)',
    b.rafQueue.length >= 1, b.rafQueue.length);
  teardown();

  // ------------------------------------- scenario I: the low-pass, and what it must NOT hide
  // A take whose energy is all high frequency. The trace must go shallow - that is the 1 ms moving average
  // doing what a scope beam does with content it cannot resolve - while the peak meter still reports the
  // level the lane actually produced. A filtered meter would be a lie.
  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'oscilloscope' } });
  b.tdAmp = 0; b.tdRipple = 8; b.tdRippleAmp = 40;      // 4 kHz only, amplitude 40 of 128
  m = await mount(b, { canvas2d: true, audioTracks: 1 });
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush(); bag = m.commit(); await flush();
  const hfNode = m.armAudio(1);
  hfNode.paused = false; hfNode.ended = false;
  hfNode.fire('timeupdate');
  m.commit();
  const hfStart445 = b.rectLog.length;
  b.frames(8);                                          // 4 draws
  const hfFrame445 = b.rectLog.slice(hfStart445);
  check('T-299: a high-frequency-only take draws a SHALLOW trace - the low-pass drops what the trace cannot '
      + 'resolve as a wave', (b.yMax - b.yMin) < 4, [b.yMin, b.yMax]);
  check('T-299: and the peak meter is still painted from the RAW samples, so the level read-out is not '
      + 'filtered away with the trace', b.fillRects > 6, b.fillRects);
  check('T-445: the oscilloscope KEPT its peak meter — the 4px meter segments are drawn in this mode; only the '
      + 'spectrum analyser was told to drop it',
    hfFrame445.filter(function (r) { return r[2] === 4 && r[3] === 4; }).length > 0,
    hfFrame445.filter(function (r) { return r[2] === 4 && r[3] === 4; }).length);
  teardown();

  // ---------------- scenario M: the clock band painted INSIDE the canvas (T-305, user 2026-10-13 03:17)
  // "the timing display should be integrated at the top into the visualizer canvas (like winamp - in a 'dot
  // matrix display style')" - and the user picked "big elapsed / total" over elapsed only. The band is 24 px of
  // the 80 px strip, the digits are 5x7 dot cells, and everything the strip used to draw keeps its space BELOW
  // the band: the strip grew, the trace did not shrink. The fake context now remembers the translate the panel
  // used, so "below the band" is a measured position and not a comment.
  // T-677 (2026-10-28): the mount is given a timer service the suite can drive, because the idle clock is a
  // timer's work (the panel arms it through the client timer service, house rule). The shim's default timer is a
  // no-op, so without this handle the panel's tick would never run here at all, and the check would be a source
  // text assertion instead of a picture. The captured function is the panel's own tick, not a copy of it.
  let tick677 = null;
  const armed677 = [];
  const timer677 = {
    interval: function (fn677, ms677) {
      armed677.push((fn677 && fn677.name) || ("anon:" + (fn677 && fn677.length) + "args@" + ms677));
      if (typeof fn677 === "function" && (fn677.name || "").indexOf("tick677") >= 0) tick677 = fn677;
      return function () {};
    },
    timeout: function () { return function () {}; },
  };
  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'oscilloscope' } });
  m = await mount(b, {
    canvas2d: true, audioTracks: 1, timer: timer677,
    items: [{ id: 'ap-3050', fn: 'tts', kind: 'tts', status: 'ok', model: 'm1', voice: 'voy_janeway', duration: 3.44, text: 'the take' }],
  });
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  const bandOf = function (r) { return r[4] === 0 && r[1] < 24; };
  const litOf = function (r) { return r[5] === '#3fb950'; };
  const markLit = function (w) { return w.filter(function (r) { return litOf(r) && r[0] < 14; }).length; };
  // Windows, not totals: a band compared across an unknown number of draws is not a comparison, it is an
  // accident. Each window below is a known set of draws, and each one is read on its own.
  //
  // Window 1 - the file is flowing but the player has not been told a time yet (nothing called ontimeupdate),
  // so the band has to print the dashes it starts with, and the mark has to say running.
  const playBtnM = m.created().filter(function (e) {
    return e.type === 'button' && /play the row the transport is on/.test(String(e.props && e.props.title));
  }).pop();
  if (playBtnM) { playBtnM.props.onClick(); await flush(); m.commit(); await flush(); }
  const nodeM = m.armAudio(1);
  nodeM.fire('timeupdate');                 // the event that arms the tap; it is not the clock callback
  m.commit(); await flush();
  let nRun = b.rectLog.length;
  b.frames(1);
  const bandRun = b.rectLog.slice(nRun).filter(bandOf);
  const litRun = bandRun.filter(litOf);
  // T-334 (user 2026-10-13, 15:2x): "reduce the display content to 'current position' and only display '/ full length'
  // if display is wide enough" - at 200 px the band has room for 10 glyphs and "0:00 / 0:00" needs 11, so the position
  // is drawn alone. The matrix rule is untouched: every dot of every glyph drawn is painted, lit and unlit alike,
  // because a matrix that only shows lit dots is a segment display. The count therefore follows the number of glyphs
  // actually drawn, so it is asserted as a matrix (glyphs x 35 dots, unlit included) and not as a fixed 300.
  const glyphsRun = Math.round((bandRun.length - 6) / 35);
  check('T-305 + T-334: the clock band is drawn inside the canvas as a whole 5x7 matrix, unlit dots included, and at '
      + 'this width it carries the position alone (no "/ full length" squeezed in)',
    bandRun.length > 120 && glyphsRun >= 4 && glyphsRun <= 6 && litRun.length > 0,
    [bandRun.length, litRun.length, glyphsRun]);
  check('T-305: the strip opens and closes the canvas state it needs - saves and restores balance, and the '
      + 'offset is back to zero, so a later frame cannot inherit the band translate',
    b.saves === b.restores && b.translates >= 1 && b.off === 0, [b.saves, b.restores, b.translates, b.off]);
  check('T-305: the trace is drawn BELOW the clock band - every point of it sits at or under y=24 and inside '
      + 'the 80px box (the strip grew, the trace did not shrink)',
    b.absTrace.length > 10 && b.absTrace.every(function (p) { return p[1] >= 24 && p[1] <= 80; }),
    [b.absTrace.length, Math.min.apply(null, b.absTrace.map(function (p) { return p[1]; })),
     Math.max.apply(null, b.absTrace.map(function (p) { return p[1]; }))]);
  check('T-305: the running mark is lit while the file plays - the symmetric arrow at the left of the digits, in '
      + 'the same green as the digits (a held file is told apart by SHAPE, never by an amber highlight)',
    (function () {
      // T-439 (user 2026-10-15): the running mark is now a SYMMETRIC arrow - three 1 px columns, 5, 3 and 1 tall,
      // all centred on the same horizontal midline (y = 8), its upper-left corner at the mark origin (6, 6), apex
      // pointing right. The old mark was five 1 px rows 6,5,4,3,2 wide: it leaned. The lit floor is now measured in
      // PIXELS (the arrow is 9 dots) rather than in fillRect calls (3), and the exact shape is pinned on top of it,
      // the exact shape is pinned, so this check is strictly stronger than the one it grew out of.
      var m399 = bandRun.filter(function (r) { return litOf(r) && r[0] < 14; })
        .map(function (r) { return r[0] + ',' + r[1] + ' ' + r[2] + 'x' + r[3]; }).sort();
      var a399 = bandRun.filter(function (r) { return litOf(r) && r[0] < 14; })
        .reduce(function (s, r) { return s + r[2] * r[3]; }, 0);   // lit PIXELS, not fillRect calls - the arrow is 9 dots
      return a399 >= 5 && m399.length === 3 && m399[0] === '6,6 1x5' && m399[1] === '7,7 1x3' && m399[2] === '8,8 1x1';
    })(), bandRun.filter(function (r) { return litOf(r) && r[0] < 14; })
      .map(function (r) { return r[0] + ',' + r[1] + ' ' + r[2] + 'x' + r[3]; }).sort().join(' | '));

  // Window 2 - the player now knows a time, and the band has to show THAT instead of the dashes.
  nodeM.currentTime = 1.2; nodeM.duration = 3.44;
  if (typeof nodeM.ontimeupdate === 'function') nodeM.ontimeupdate();
  m.commit(); await flush();
  let nTime = b.rectLog.length;
  b.frames(1);
  const bandTime = b.rectLog.slice(nTime).filter(bandOf);
  const litTime = bandTime.filter(litOf);
  // The lit SET is what is compared, not the lit COUNT: a digit is not "more lit" than a dash, it is a
  // different matrix. If the same dots light up after the player learned a time, the band is not following it.
  const litSet = function (w) {
    return w.filter(litOf).map(function (r) { return r[0] + ',' + r[1]; }).sort().join(' ');
  };
  check('T-305: the digits follow the player - a known time lights a DIFFERENT set of dots than the idle band drew, '
      + 'and the band is still a whole matrix (T-334: fewer glyphs at this width, the matrix rule unchanged)',
    litSet(bandTime) !== litSet(bandRun) && bandTime.length > 120, [litRun.length, litTime.length, bandTime.length]);

  // Window 3a - the user HOLDS the file (T-307, user 2026-10-13 05:15): "on pause, the visualisation should
  // freeze / pause, too - currently it dissappears while playback is paused". It disappeared because a pause
  // threw the tap away, so the next paint had no signal and drew the empty baseline. A pause is not an end: the
  // SAME file resumes, so the tap stays, the loop stops, and the only thing repainted is the band - the trace
  // keeps the frame the take last drew, and the display is still free to say PAUSED.
  let nPause = b.rectLog.length;
  nodeM.paused = true; nodeM.ended = false;
  nodeM.fire('pause');                                   // the browser's own pause event
  m.commit(); await flush();
  const bandPause = b.rectLog.slice(nPause).filter(bandOf);
  const tracePause = b.rectLog.slice(nPause).filter(function (r) { return r[4] >= 24; });
  check('T-307 CONTRACT CHANGE: a held pause keeps the canvas and the tap, cancels the loop, repaints the clock '
      + 'band only, and draws NOTHING in the trace area - the picture the take last drew survives the pause '
      + '(T-334: the band is a matrix of the glyphs that fit, so the floor is a matrix, not a fixed 300)',
    m.canvases().length === 1 && bandPause.length > 120 && tracePause.length === 0 && b.rafQueue.length === 0,
    [m.canvases().length, bandPause.length, tracePause.length, b.rafQueue.length]);
  // The running mark is a symmetric arrow drawn as three 1 px columns 5,3,1 (T-439); the held mark is TWO bars, so the count that proves a
  // triangle is the wrong ruler for a pause. What is checked is the shape: two lit 2x5 bars, in the same green,
  // and no amber anywhere in the band (amber stays reserved for alarms).
  const pauseMark = bandPause.filter(function (r) { return litOf(r) && r[0] < 14; });
  const pauseMarkSet = pauseMark.map(function (r) { return r[0] + ',' + r[1] + ' ' + r[2] + 'x' + r[3]; })
    .filter(function (v, i, a) { return a.indexOf(v) === i; }).sort();
  check('T-307: the held pause is READABLE on the frozen strip - where the running triangle was there are now '
      + 'exactly two lit bars (2x5, the same green, at the mark position), no amber anywhere in the band, and '
      + 'the trace underneath was not redrawn',
    pauseMarkSet.length === 2 && pauseMarkSet.indexOf('7,6 2x5') >= 0 && pauseMarkSet.indexOf('11,6 2x5') >= 0
      && !bandPause.some(function (r) { return r[5] === '#d29922'; }), pauseMarkSet);

  // Window 3 - the file ended. The loop stops, and the panel has to repaint the band on its own: the mark goes
  // dark, because a player with nothing to play is not running and must not look like it is.
  let nEnd = b.rectLog.length;
  nodeM.paused = true; nodeM.ended = true;
  nodeM.fire('ended');
  m.commit(); await flush();
  const bandEnd = b.rectLog.slice(nEnd).filter(bandOf);
  check('T-305 CONTRACT: when the file ends the band is repainted without the loop, and the mark is NOT lit - '
      + 'no green appears in the first 14px of the band any more (T-334: a whole matrix of the glyphs that fit)',
    bandEnd.length > 120 && markLit(bandEnd) === 0, [bandEnd.length, markLit(bandEnd)]);

  // ---- T-677 (operator 2026-10-28, verbatim: "if the player is stopped, doing nothing, after 10 seconds the
  // canvas should show current local browser time in the dot matrix LED style instead of the timer numbers")
  // The band's third reading, measured as a picture. The clock is moved by hand the way scenario T-590 moved the
  // harness clock, and put back afterwards, because a stubbed clock is a landmine (T-590's own note). The tick is
  // the panel's own, captured off the client timer service, so what is measured is the panel's timer path.
  const baseDate677 = Date.now();
  const realDateNow677 = Date.now;
  const litSetEnd = litSet(bandEnd);
  // Window A: two seconds after the take ended - the ten seconds have not passed, so the band still prints the
  // take's own numbers and the tick draws nothing at all.
  Date.now = function () { return baseDate677 + 2000; };
  let n677a = b.rectLog.length;
  if (tick677) tick677();
  m.commit(); await flush();
  const band677a = b.rectLog.slice(n677a).filter(bandOf);
  check('T-677: two seconds after a take ends the tick paints nothing - inside the ten seconds the operator named, the '
      + 'band keeps the numbers of the take that ended, it does not become a clock yet',
    band677a.length === 0 && typeof tick677 === 'function', [band677a.length, typeof tick677, armed677]);
  // Window B: eleven seconds on - the same stopped player, and the band is a clock now.
  Date.now = function () { return baseDate677 + 11000; };
  let n677b = b.rectLog.length;
  if (tick677) tick677();
  m.commit(); await flush();
  Date.now = realDateNow677;                       // the real clock goes back on the suite (T-590)
  const band677b = b.rectLog.slice(n677b).filter(bandOf);
  const digits677b = band677b.filter(function (r) { return r[0] >= 14; });
  const glyphs677b = Math.round((band677b.length - 5) / 35);
  const x677b = digits677b.length ? Math.min.apply(null, digits677b.map(function (r) { return r[0]; })) : -1;
  const x677end = (function () {
    const d = bandEnd.filter(function (r) { return r[0] >= 14; });
    return d.length ? Math.min.apply(null, d.map(function (r) { return r[0]; })) : -1;
  })();
  check('T-677: after the ten seconds the stopped band prints a TIME - eight glyph blocks of dot matrix on a '
      + '200px strip (HH:MM:SS needs room the seconds half gives up when the strip is narrow), painted as a whole '
      + 'matrix with the unlit dots included',
    glyphs677b === 8 && band677b.length > 280 && digits677b.length % 35 === 0,
    [glyphs677b, band677b.length, digits677b.length]);
  check('T-677: the clock reading is CENTRED in the space the mark leaves (the T-544 rule, same cell and same '
      + 'advance), so it does not sit hard against the state mark at the left edge of a box it does not fill',
    x677b > x677end && x677b >= 20, [x677b, x677end]);
  check('T-677: the clock reading does not make the player look busy - the mark stays the dark square, no lit '
      + 'green in the first 14px of the band, and the reading is not the same dots the take ended on',
    markLit(band677b) === 0 && litSet(band677b) !== litSetEnd,
    [markLit(band677b), litSet(band677b) !== litSetEnd]);
  // And the rule the operator named: a running transport is not a clock. The tick refreshes the stamp and paints
  // nothing while the mark is running - the draw loop owns the frame.
  const playBtn677 = m.created().filter(function (e) {
    return e.type === 'button' && /play the row the transport is on/.test(String(e.props && e.props.title));
  }).pop();
  if (playBtn677) { playBtn677.props.onClick(); await flush(); m.commit(); await flush(); }
  const node677 = m.armAudio(1);
  node677.fire('timeupdate');
  m.commit(); await flush();
  Date.now = function () { return baseDate677 + 12000; };   // a long stopped stretch, then a press (baseDate677, not Date.now: a stub may not call itself)
  let n677c = b.rectLog.length;
  if (tick677) tick677();
  m.commit(); await flush();
  const band677c = b.rectLog.slice(n677c).filter(bandOf);
  Date.now = realDateNow677;
  check('T-677: any play action takes the strip back - while the mark is running the tick refreshes its stamp and '
      + 'paints no band of its own, so the clock cannot outlive the transport',
    band677c.length === 0, [band677c.length]);
  teardown();

  // ---------------- scenario T-681: the clock is its own control (T-681, the separation)
  // The operator's ruling, verbatim: "currently I see the 3 modes below the visualizier settings, but we wanted to
  // make the clocks and visualizer separate", and on the press: "the canvas press action depends on the current
  // mode - if playing audio or paused of any kind, and visualizer is not \"disabled\", then visualizer is changed to
  // next. If in clock mode (stopped, after playing), on klick the clock mode changes", and on the clock coming back:
  // "after a delay". Everything below is read off the drawings and the panel state, exactly as every other scope
  // check in this suite does. The face drawings the operator already had verified (the LED matrix, the Nixie tube)
  // keep their measurements; what changed is how a face is REACHED - the clock row's switch and face box, not a
  // name of the visualizer table.
  let tick677b = null;
  const timer677b = {
    interval: function (fn677b, ms677b) {
      if (typeof fn677b === "function" && (fn677b.name || "").indexOf("tick677") >= 0) tick677b = fn677b;
      return function () {};
    },
    timeout: function () { return function () {}; },
  };
  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'off' } });
  m = await mount(b, {
    canvas2d: true, audioTracks: 1, timer: timer677b,
    items: [{ id: 'ap-6770', fn: 'tts', kind: 'tts', status: 'ok', model: 'm1', voice: 'voy_janeway', duration: 3.44, text: 'the take' }],
  });
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush();
  check('T-681: the clock row exists as its own control - a switch and a face box - and the visualizer table carries '
      + 'no clock name any more. The operator ruled the two separate, and a table of visualizer levels that lists a '
      + 'clock is the thing they objected to',
    m.els('audio-play-clock-on681').length === 1 && m.els('audio-play-clock-row681').length === 1
      && ['clock_led', 'clock_nixie', 'clock_letters', 'clock_flap', 'clock_flap_light', 'clock_nixie_green'].every(function (w681r) {
        // RE-CUT 2026-11-06 (T-729): the fifth face word joins this list, and so does clock_flap, which this
        // list had somehow left out since the day it was written. The check says no clock name is in the
        // visualizer table; a list that names four of five clock words measures less than the sentence claims.
        return m.els('audio-play-scope-mode531-' + w681r).length === 0; }),
    { on: m.els('audio-play-clock-on681').length, names: m.els('audio-play-scope-mode531-clock_led').length });
  check('T-681: the switch defaults OFF - a panel that never chose a clock display is not given one by this build, '
      + 'and nothing is stored for a clock that was never set',
    m.els('audio-play-clock-face681').length === 0
      && b.store['deepamp:clock.on681'] === undefined && b.store['deepamp:clock.mode681'] === undefined,
    { face_box: m.els('audio-play-clock-face681').length, store: b.store['deepamp:clock.on681'] });

  // Window 1 - the LED face, reached through the clock row. The whole canvas is the display, exactly the drawing
  // T-677 verified and the operator saw on the live panel: the dot matrix at a scaled cell, unlit dots included,
  // and no band above it. The measurement is unchanged; the press that gets there is not.
  const spec677 = m.els('audio-play-scope-mode531-spectrum')[0];
  if (spec677) { spec677.props.onClick(); }
  m.commit(); await flush();
  let nLed677 = b.rectLog.length;
  m.els('audio-play-clock-on681')[0].props.onClick();
  m.commit(); await flush(); b.frames(1);
  const ledWin677 = b.rectLog.slice(nLed677);
  const ledLit677 = ledWin677.filter(function (r) { return r[5] === '#3fb950' && r[1] >= 24 && r[2] >= 2; });
  const ledDim677 = ledWin677.filter(function (r) { return r[5] === '#1d211d' && r[1] >= 24; });
  const ledBand677 = ledWin677.filter(function (r) { return r[4] === 0 && r[1] < 24 && r[3] <= 3; });
  check('T-681: the switch on answers an idle canvas with the LED face - the clock word is stored under the clock '
      + 'words and NOT in the visualizer word, the matrix is drawn over the whole canvas (lit and unlit dots, the '
      + 'T-334 rule), and no band is drawn above it',
    b.store['deepamp:clock.on681'] === '1' && b.store['deepamp:clock.mode681'] === 'clock_led'
      && b.store['deepamp:scope.mode'] === 'spectrum'
      && ledLit677.length > 60 && ledDim677.length > 120 && ledBand677.length === 0,
    { clock: b.store['deepamp:clock.on681'], face: b.store['deepamp:clock.mode681'],
      vis: b.store['deepamp:scope.mode'], lit: ledLit677.length, dim: ledDim677.length, band: ledBand677.length });
  check('T-681: a clock face is not an animation - the LED face arms no draw loop, so the panel does not redraw the '
      + 'same digits sixty times a second',
    b.rafQueue.length === 0, [b.rafQueue.length]);

  // Window 1b - the one-second tick repaints the FACE, not the band. A clock face is a clock at every moment; the
  // band's third reading still waits out the ten idle seconds.
  let nTick677 = b.rectLog.length;
  if (tick677b) tick677b();
  m.commit(); await flush();
  const tickWin677 = b.rectLog.slice(nTick677);
  check('T-681: the tick paints the clock - one second later the face is redrawn (a full-canvas background and '
      + 'glyph dots), and the band is never painted while the clock owns the box',
    tickWin677.some(function (r) { return r[1] === 0 && r[3] === 80; })
      && tickWin677.filter(function (r) { return r[5] === '#3fb950' && r[1] >= 24; }).length > 60
      && tickWin677.filter(function (r) { return r[4] === 0 && r[1] < 24 && r[3] <= 3; }).length === 0,
    tickWin677.length);

  // T-686 RE-POINTED (2026-10-29, the operator's report, verbatim: "one small bug, now klicking on the knight
  // rider vis brings me to the clocks and keeps clocks instead of cycling vis to 1st"). The gate used to ask what
  // the canvas was PAINTING, so a press in a running visualizer walked the clock faces and the visualizer word
  // never moved. It now asks the word the visualizer is SET TO: the clock faces are walked when the visualizer is
  // off, which is the state the operator calls "in clock mode". The scenario sets that state here, through the
  // visualizer row's own control, and the knight-rider case is measured in its own window at the end.
  // The state a clock-face walk is reached from, built the way the panel reaches it: the clock row's switch off,
  // the visualizer walked to its own last word (`off` stays in the ring while the clock is off - T-299), the
  // clock row's switch back on. That state is one of the two the press rule can walk the clock from, because in
  // it the idle canvas answers the clock; the other is a take that ended with the return delay out (T-689, the
  // window below the Knight Rider pin).
  m.els('audio-play-clock-on681')[0].props.onClick();
  m.commit(); await flush();
  const knightCtl686a = m.els('audio-play-scope-mode531-knight')[0];
  if (knightCtl686a) { knightCtl686a.props.onClick(); }
  m.commit(); await flush();
  // RE-POINTED 2026-11-07 by T-746: the rolling mark sits between Knight Rider and off now, so walking the ring
  // to its last word takes one press more. The trap T-601 item 3 recorded, again: nothing about the drawings or
  // about the press rule moved; the press count did. RE-POINTED AGAIN the same day by T-749, for the same reason
  // at the same place: the whale mark sits between the rolling mark and off, so it takes one press more again.
  // RE-POINTED A THIRD TIME the same evening by T-755, and this time the count moved by four, because the operator
  // re-ordered the ring ("move the LED bars under waveform , and make dancing llama the last visualizer in the
  // list") and the llama now sits between the whale mark and `off`. Rather than write another number that the next
  // re-ordering moves, this construction walks the ring from the word the operator named and asserts that every
  // press lands on the next entry the client carries, in the order the client carries them, and that the walk ends
  // on `off`. The path is reported, so a wrong step names itself.
  const ringPastKnight755 = ['vu_led', 'vu_needle', 'waterfall', 'qwen', 'whale', 'llama', 'off'];
  const walked686 = [];
  for (let w686 = 0; w686 < ringPastKnight755.length; w686++) {
    m.strip().props.onClick();
    m.commit(); await flush();
    walked686.push(b.store['deepamp:scope.mode']);
  }
  m.els('audio-play-clock-on681')[0].props.onClick();
  m.commit(); await flush();
  check('T-686, re-pointed by T-755: the visualizer walked from the LED bars reaches `off` one entry at a time -- '
      + 'the walk is ' + ringPastKnight755.join(' -> ') + ', the order the operator ruled on 2026-11-07 -- and the '
      + 'word `off` is still in the ring while the clock is off, and it is the walk that puts it there',
    walked686.join(',') === ringPastKnight755.join(',') && b.store['deepamp:scope.mode'] === 'off'
      && b.store['deepamp:clock.on681'] === '1',
    { walked: walked686, vis: b.store['deepamp:scope.mode'], clock: b.store['deepamp:clock.on681'] });

  // Window 2 - a press on the canvas while the clock is showing walks the CLOCK faces, and only them. The operator's
  // rule of 21:5x Berlin names the case: the press changes the clock mode when the panel is in clock mode. The
  // Nixie measurement is the one T-677 recorded: amber glyphs, one glass slab per block, six blocks for a
  // 4.5-digit display.
  // T-684 RE-POINTED (2026-10-29, the operator's Nixie references): this pin measured the drawing T-677 put on the
  // canvas - amber matrix glyphs, one flat slab per block, six blocks for a 4.5-digit display, the half block
  // carrying AM/PM. The references and the rulings that came with them replaced all of it: four glass envelopes
  // with a dome and a getter, a base plate with a warm ring at its foot, a wire mesh across the window, a stack of
  // dim cards behind each struck digit, the struck digit as a bright wire with bloom, and the separator as its own
  // small tube carrying one dot. The AM/PM half block is retired by that ruling and the reading is HH:MM - four
  // struck digits, no fifth block. What is measured below is that shape, and the words the press moves.
  // T-784 (2026-11-11, the operator's ruling on the time-boundary flakes: "Make the fixture deterministic").
  // The frame this block measures is painted with the clock held at ONE instant, so every tube in it is drawn
  // against the same millisecond and the factors compared below are one frame's factors - not a sample of how
  // loaded the machine was when the run happened to reach this line. The instant is a constant rather than a
  // value read at run time: it is 23:45 local, so all four tubes are struck, and the breath it computes is
  // mid-band (0.903 of full strength), which keeps the ruled band a measurement of the curve instead of a
  // lottery on which millisecond the run landed in. The client's own one-read-per-frame rule is untouched; what
  // changed is the frame the suite hands it.
  const realClock690A = Date.now;
  Date.now = function () { return 1762040700000; };
  let nNix677 = b.rectLog.length, nNixStrk677 = b.strokeLog.length;
  m.strip().props.onClick();
  m.commit(); await flush();
  Date.now = realClock690A;
  const nixWin677 = b.rectLog.slice(nNix677);
  const nixStrk677 = b.strokeLog.slice(nNixStrk677);
  // RE-CUT 2026-11-06 (T-729, WM-30 item 2). The operator's ask, verbatim from 2026-11-05: "improve 'nixie tube
  // display': 'more glowing effect and slight \"power fluctuations\" with slight dimming \"fallout 4 style\" + add
  // 'neon green color variant''". The ruling of 2026-11-06 gave it a shape: the glow is "three halo passes with a
  // falloff", the same wire stroked at three decreasing widths in progressively dimmer colours written as
  // #RRGGBBAA; the fluctuation is "a slow breath on the struck digit only", its wire, its pale core and its halo
  // dimming and recovering TOGETHER, while the glass, the mesh and the ghost stack keep today's values.
  // That moves the struck inks from exact colours to colours carrying a two-digit alpha, so a struck tube is now
  // named by the first seven characters of its ink and its strength is read off the rest. Nothing here is dropped:
  // the wire count, the stack count, the core count, the bloom-wider-than-the-wire ratio and the numeral height
  // are the same measurements, re-expressed against the base colour. What is added is the falloff, the shared
  // strength, and the band the strength is allowed to move in.
  const inkBase690 = function (c690b) { return String(c690b).slice(0, 7); };
  const inkStrength690 = function (c690s) {
    const s690s = String(c690s);
    return s690s.length === 9 ? parseInt(s690s.slice(7), 16) : -1;   // -1: this ink carries no strength at all
  };
  const NIXIE_BAND_LO690 = 184, NIXIE_BAND_HI690 = 247;   // 0.72 and 0.97 of 255, the ruled floor and ceiling
  const nixWire677 = nixStrk677.filter(function (c677w) { return inkBase690(c677w) === '#f6a23c'; });    // the struck wires
  const nixStack677 = nixStrk677.filter(function (c677s) { return c677s === '#6b3f16'; });   // the ghost stack, unchanged ink
  const nixGlass677 = nixWin677.filter(function (r677g) { return r677g[5] === '#150f08'; }); // the envelopes
  const nixRing677 = nixWin677.filter(function (r677r) { return r677r[5] === '#a45f1c'; });  // the foot rings
  const nixMesh677 = nixWin677.filter(function (r677m) { return r677m[5] === '#241a10'; });  // the mesh
  // T-684 (2026-10-29, the operator's look at the rendered picture: "the numbers could be a little bigger and the
  // neon glow could be a bit more chemical"): the numerals are measured through the path of their own struck wire
  // - how tall the drawn digit actually is, and how wide its bloom is compared with the wire - and the hot core of
  // a struck tube is counted as its own ink. A glow that is one flat colour is paint on glass; three layers with a
  // pale middle is what the reference close-ups show, so that is what the pin now asks for.
  const nixCore677 = nixStrk677.filter(function (c677c) { return inkBase690(c677c) === '#ffdcaa'; });
  const nixPaths677 = b.strokePaths.slice(nNixStrk677).filter(function (p677p) {
    return p677p && inkBase690(p677p.ink) === '#f6a23c';
  });
  let nixDigitH677 = 0, nixWireW677 = 0, nixBloomW677 = 0;
  for (let i677q = 0; i677q < nixPaths677.length; i677q++) {
    const st677q = nixPaths677[i677q];
    const ys677q = (st677q.path || []).map(function (p677y) { return p677y[1]; });
    if (ys677q.length) { nixDigitH677 = Math.max(nixDigitH677, Math.max.apply(null, ys677q) - Math.min.apply(null, ys677q)); }
  }
  const nixStruck677 = b.strokePaths.slice(nNixStrk677).filter(function (w677w) {
    const base677b = w677w && inkBase690(w677w.ink);
    return base677b === '#f6a23c' || base677b === '#6b3f16';
  }).map(function (w677x) { return w677x.width; });
  nixWireW677 = Math.min.apply(null, nixStruck677.filter(function (w677m) { return w677m > 0; }));
  nixBloomW677 = Math.max.apply(null, b.strokePaths.slice(nNixStrk677)
    .filter(function (w677n) { return w677n && inkBase690(w677n.ink) === '#c1611d'; })
    .map(function (w677o) { return w677o.width; }));
  // The strokes of ONE struck tube, grouped by the path they share. The wire, its core and the three halo passes
  // are the same segments at different widths, so the geometry - not their order in the log, not their colour -
  // is what says which strokes belong to which digit. The planes of the ghost stack are drawn at a different
  // window and a different lift, so they land in their own groups and are not counted here.
  const nixTubes690 = {};
  b.strokePaths.slice(nNixStrk677).forEach(function (t690p) {
    if (!t690p) return;
    const base690t = inkBase690(t690p.ink);
    if (base690t !== '#f6a23c' && base690t !== '#c1611d' && base690t !== '#ffdcaa') return;
    const key690k = JSON.stringify(t690p.path || []);
    if (!nixTubes690[key690k]) nixTubes690[key690k] = [];
    nixTubes690[key690k].push({ ink: t690p.ink, base: base690t, width: t690p.width, strength: inkStrength690(t690p.ink) });
  });
  const nixTubeList690 = Object.keys(nixTubes690).map(function (k690l) { return nixTubes690[k690l]; });
  const nixTubeShape690 = function (t690s) {           // one struck tube: three halos, one wire, one core
    if (t690s.length !== 5) return false;
    const halos690h = t690s.filter(function (p690h) { return p690h.base === '#c1611d'; }).sort(function (a690a, b690b) { return b690b.width - a690a.width; });
    const wires690w = t690s.filter(function (p690w) { return p690w.base === '#f6a23c'; });
    const cores690c = t690s.filter(function (p690c) { return p690c.base === '#ffdcaa'; });
    if (halos690h.length !== 3 || wires690w.length !== 1 || cores690c.length !== 1) return false;
    const wireW690 = wires690w[0].width;
    for (let i690i = 0; i690i < 3; i690i++) {
      if (!(halos690h[i690i].width > wireW690)) return false;                       // every halo is wider than the wire
      if (i690i > 0 && !(halos690h[i690i - 1].width > halos690h[i690i].width)) return false;   // decreasing widths
      if (i690i > 0 && !(halos690h[i690i].strength > halos690h[i690i - 1].strength)) return false; // increasing strength = a falloff
      if (halos690h[i690i].strength < 0 || halos690h[i690i].strength >= 255) return false;      // written as #RRGGBBAA, never opaque
    }
    if (!(halos690h[0].width >= wireW690 * 3)) return false;                        // the outer pass is the wide one
    if (!(cores690c[0].width < wireW690)) return false;                             // the core sits inside the wire
    const wireStrength690 = wires690w[0].strength;
    if (wireStrength690 < 0 || cores690c[0].strength !== wireStrength690) return false;   // wire and core carry the SAME ink strength
    for (let j690j = 0; j690j < 3; j690j++) {
      if (!(halos690h[j690j].strength < wireStrength690)) return false;            // a halo is never brighter than the wire it hangs on
    }
    return true;
  };
  const nixTubeBad690 = nixTubeList690.filter(function (t690b) { return !nixTubeShape690(t690b); });
  // The strength one frame applies to a struck digit, read off that digit's own wire, and the halo ladder as
  // fractions of it. The ruling's "dim and recover together" is a FACTOR shared by the wire, the core and the
  // three halos - not one alpha painted five times: each halo is the palette's bloom at its own falloff, and the
  // frame's factor multiplies all four. So the measurable shape is this: every struck tube in one frame carries
  // the same factor, that factor sits inside the ruled band, and the ladder of halo-to-wire ratios is the same
  // ladder on every tube and gets stronger as it comes in towards the wire. That is read off the drawing, with no
  // constant from the client copied into this file.
  const nixFactors690 = [], nixLadders690 = [];
  nixTubeList690.forEach(function (t690f) {
    const wires690f = t690f.filter(function (p690f) { return p690f.base === '#f6a23c'; });
    if (!wires690f.length) return;
    const f690f = wires690f[0].strength;
    nixFactors690.push(f690f);
    nixLadders690.push(t690f.filter(function (p690g) { return p690g.base === '#c1611d'; })
      .sort(function (a690g, b690g) { return b690g.width - a690g.width; })
      .map(function (p690h2) { return Math.round((p690h2.strength / f690f) * 1000) / 1000; }));
  });
  const nixFactorSame690 = nixFactors690.every(function (f690s) { return f690s === nixFactors690[0]; });
  const nixFactorBand690 = nixFactors690.every(function (f690t) {
    return f690t >= NIXIE_BAND_LO690 && f690t <= NIXIE_BAND_HI690 && f690t < 255;
  });
  const nixLadderSame690 = nixLadders690.every(function (r690r) { return JSON.stringify(r690r) === JSON.stringify(nixLadders690[0]); });
  const nixLadderRise690 = nixLadders690.every(function (r690l) {
    return r690l.length === 3 && r690l[0] > 0 && r690l[0] < r690l[1] && r690l[1] < r690l[2] && r690l[2] < 1;
  });
  const nixNoAlpha690 = nixTubeList690.reduce(function (n690n, t690y) {
    return n690n + t690y.filter(function (p690z) { return p690z.strength < 0; }).length; }, 0);
  const nixGlassAlpha690 = nixWin677.filter(function (r690r) { return String(r690r[5]).length !== 7; });
  check('T-681 as re-pointed by T-684: a press on the canvas in the LED face changes to the Nixie tube - the clock '
       + 'word moves, the visualizer word does not, and the tube face draws glass envelopes, a struck wire per '
       + 'digit, a stack behind it, and its own small tube for the separator',
    b.store['deepamp:clock.mode681'] === 'clock_nixie' && b.store['deepamp:scope.mode'] === 'off'
      && nixWire677.length === 4 && nixStack677.length >= 12 && nixGlass677.length >= 5
      && nixRing677.length >= 5 && nixMesh677.length > 0,
    { clock: b.store['deepamp:clock.mode681'], vis: b.store['deepamp:scope.mode'],
      wire: nixWire677.length, stack: nixStack677.length, glass: nixGlass677.length,
      ring: nixRing677.length, mesh: nixMesh677.length });
  check('T-684: the struck tube is a struck tube - a wire, a bloom around it, and a paler core along its middle, '
       + 'measured through the paths of its own strokes',
    nixCore677.length === 4 && nixBloomW677 > nixWireW677 * 2.5 && nixWireW677 >= 1,
    { core: nixCore677.length, wire: nixWireW677, bloom: nixBloomW677 });
  check('T-684: the look at the rendered picture asked for bigger numbers - the struck numerals are measured at'
       + ' least half the tube height again, off the drawing, not off the ratio',
    nixDigitH677 >= 30, { digitHeight: nixDigitH677, tubeHeight: 76 });
  // (T-729 contract change, 2026-11-06.) Three new measurements, all of them about the ruling rather than the
  // picture, and each one read off the drawing rather than off a constant:
  check('T-729: the glow is three halo passes with a falloff - every struck digit draws exactly three wider '
       + 'passes of its own wire, their widths decrease and their inks strengthen as they come in towards the '
       + 'wire, the outermost is at least three times the wire\'s width, and the core stays inside the wire',
    nixTubeList690.length === 4 && nixTubeBad690.length === 0 && nixNoAlpha690 === 0,
    { tubes: nixTubeList690.length, bad_tubes: nixTubeBad690.length, strokes_without_alpha: nixNoAlpha690,
      sample: nixTubeList690[0] ? nixTubeList690[0].map(function (p690s) { return { ink: p690s.ink, width: p690s.width }; }) : [] });
  check('T-729: the breath is a strength, not a colour - every struck tube in one frame carries the SAME factor '
       + 'read off its own wire (a tube dims as one object), that factor is inside the ruled band 0.72..0.97 of '
       + 'full strength and never full strength, the wire and the pale core of one digit carry that factor '
       + 'identically, and the halo ladder is the same ladder on every tube, each rung dimmer than the wire it '
       + 'hangs on and stronger as it comes in towards it',
    nixTubeList690.length === 4 && nixTubeBad690.length === 0
      && nixFactors690.length === 4 && nixFactorSame690 && nixFactorBand690
      && nixLadders690.length === 4 && nixLadderSame690 && nixLadderRise690,
    { struck_tubes: nixFactors690.length, factor: nixFactors690[0], factors: nixFactors690,
      band: [NIXIE_BAND_LO690, NIXIE_BAND_HI690], ladder: nixLadders690[0] });
  check('T-729: the ruling puts the power fluctuation on the struck digit ONLY - the ghost stack behind it is '
       + 'stroked in the unchanged dim ink, and not one rectangle this face paints (glass, dome, getter, mesh, '
       + 'base plate, foot ring, window, separator dot) carries an alpha',
    nixStack677.length >= 12 && nixStack677.every(function (c690g) { return c690g === '#6b3f16'; })
      && nixGlassAlpha690.length === 0,
    { stack_strokes: nixStack677.length, filled_with_alpha: nixGlassAlpha690.length,
      sample: nixGlassAlpha690.slice(0, 4).map(function (r690s) { return r690s[5]; }) });

  // T-684: the canvas log of the tube face is written out here, because a design pass on a face you cannot see
  // is guesswork. scripts/canvas_log_preview.py renders that log into a picture - the same geometry the panel
  // asked for, without a browser - and the picture has already found bugs that reading the code did not.
  require('fs').writeFileSync('/tmp/tube_dump.json', JSON.stringify({ w: 200, h: 80, rects: nixWin677,
    strokes: b.strokePaths.slice(nNixStrk677) }));
  // T-729, the half of the ruling a single frame cannot show: the breath MOVES. "a slow breath on the struck
  // digit only ... dim and recover together on a slow multi-second curve with a rare short dip". One frame can
  // only ever show one point of that curve, so this reads the same face at six moments spread over twelve and a
  // half seconds - past the ten-second idle the tick needs, on a faked clock, one tick per moment - and measures
  // the strength each moment's struck wires carry. What is asserted is the shape the ruling describes: the value
  // is inside the band it is given, it is never full strength, and across the seconds the value moves by a wide
  // margin. A curve that never moved would pass every other check in this file and fail this one. From T-751 the
  // exact wording sits a few lines below this reading, where the strike is named; the reading itself is unchanged.
  const realNow690 = Date.now;
  const baseFrame690 = Date.now();
  const nixMomentFactors690 = [];
  const readMoment690 = async function (atMs690) {
    Date.now = function () { return baseFrame690 + atMs690; };
    let n690m = b.strokeLog.length;
    if (tick677b) tick677b();
    m.commit(); await flush();
    Date.now = realNow690;
    const struck690m = b.strokeLog.slice(n690m).filter(function (c690m) { return String(c690m).slice(0, 7) === '#f6a23c'; })
      .map(function (c690n) { return parseInt(String(c690n).slice(7), 16); });
    nixMomentFactors690.push(struck690m);
  };
  for (let mm690 = 0; mm690 < 6; mm690++) { await readMoment690(10000 + mm690 * 2500); }
  // RE-POINTED 2026-11-07 by T-751 (operator, verbatim: "it should show as a dimming effect that might have a
  // strong spike on any change on the digit... like the new letter shows up with 120% brigness, drops fast to 30,
  // then dimms back up to 100% brightness - maybe with a random to affect multiple but not all of the tubes at
  // once"). The six-moment reading below is the reading this block has always done; what moved is what a frame is
  // allowed to contain, because a tube whose digit just changed is no longer on the breath alone. The re-cut of
  // the assertion sits a few lines after this reading and states which half of the ruling it measures and where
  // the other half is measured instead.
  const nixStrikeLimit691 = function (name691) {
    const m691 = new RegExp('var NIXIE_STRIKE_' + name691 + '691 = ([0-9.]+);').exec(src);
    return m691 ? parseFloat(m691[1]) : NaN;
  };
  // A struck tube's ink is the breath it is riding multiplied by the strike, and the strike is capped at 1 for the
  // ink (the excess above 100% is spent on the halo's width, not on an alpha the wire cannot hold). So the lowest
  // value a struck tube can ever carry is the floor of the breath band times the trough of the strike - both read
  // out of the client here, neither written here.
  const strikeLo691 = Math.floor(NIXIE_BAND_LO690 * nixStrikeLimit691('TROUGH'));
  // What a frame is allowed to CONTAIN moved with T-751; what this block measures did not. A frame whose value is
  // the same on all four tubes, inside the ruled band and not at full strength, is a frame this face drew with no
  // tube mid-strike - that is the breath the ruling describes and it is what these six moments are read for. A
  // frame where a tube is mid-strike is not a defect, and a struck tube's ink is the breath it is riding times
  // the strike, so it can sit anywhere from the strike's floor up to the frame's own breath value: which side of
  // the band edge that lands on is not a fact about the design and cannot be asserted from the ink. The
  // same-factor rule is therefore measured where it is still exactly measurable - by the static frame above this
  // block, unchanged - and the strike's bounds are measured by the T-751 pins below it. What stays here is the
  // half only a run of frames can show: the face is breathing in these frames, and its value MOVES across the
  // seconds. Four of the six is the floor this block holds itself to; a strike lasts about a second and a half
  // and these frames are two and a half seconds apart, so most of them are clean by the design of the reading.
  const nixFrameBad690 = nixMomentFactors690.filter(function (s690b) {
    if (s690b.length !== 4) return true;
    return s690b.some(function (v690h) { return v690h < strikeLo691 || v690h > 255; });
  });
  const nixMomentValues690 = nixMomentFactors690.filter(function (s690c) {
    return s690c.length === 4 && s690c.every(function (v690i) {
      return v690i === s690c[0] && v690i >= NIXIE_BAND_LO690 && v690i <= NIXIE_BAND_HI690 && v690i < 255;
    });
  }).map(function (s690j) { return s690j[0]; });
  const nixMomentSwing690 = nixMomentValues690.length
    ? Math.max.apply(null, nixMomentValues690) - Math.min.apply(null, nixMomentValues690) : 0;
  const nixMomentDistinct690 = nixMomentValues690.filter(function (v690e, i690e, a690e) { return a690e.indexOf(v690e) === i690e; }).length;
  check('T-729, re-cut by T-751: the struck strength is a curve over seconds, not a constant - at least four of six frames of the same face read at '
      + 'moments two and a half seconds apart carry one value for all four tubes inside the ruled band and none of it is full strength, '
      + 'no tube this face draws goes under the strike\'s ruled floor or above what the ink can hold, '
      + 'and across those seconds the breath value moves. A face that only ever '
      + 'dimmed once, or never dimmed, passes every other check here and fails this one',
    nixFrameBad690.length === 0 && nixMomentValues690.length >= 4 && nixMomentDistinct690 >= 4 && nixMomentSwing690 >= 8,
     { breath_frames: nixMomentValues690.length, moments: nixMomentValues690, distinct: nixMomentDistinct690,
       swing: nixMomentSwing690, strike_floor: strikeLo691, band: [NIXIE_BAND_LO690, NIXIE_BAND_HI690] });
  // A MEASURE, printed the way tests/tooltips.test.cjs prints its hover-length measure: the number itself, so a
  // later pass can compare against it. These are the strengths the six moments carried, out of 255. Printed per
  // tube from T-751 onward, because the strike means one frame can carry more than one value on purpose, and a
  // measure that prints only the first tube cannot tell a designed difference from a broken one.
  console.log('  MEASURE T-729 nixie breath: clean_frames ' + nixMomentValues690.length + ' of 6'
    + ' | breath values(out of 255) ' + nixMomentValues690.join(' ')
    + ' | swing ' + nixMomentSwing690 + ' | distinct ' + nixMomentDistinct690
    + ' | band ' + NIXIE_BAND_LO690 + '..' + NIXIE_BAND_HI690
    + ' | halo ladder ' + (nixLadders690[0] || []).join(' '));
  console.log('  MEASURE T-729/T-751 per moment: ' + nixMomentFactors690.map(function (s690f) {
    return '[' + s690f.join(',') + ']';
  }).join(' '));

  // T-751 (2026-11-07, WM-30 / the operator's nixie ask). The strike transient, measured the way this file
  // measures a curve it cannot draw a still picture of: the three functions the client actually runs are read out
  // of the client and evaluated here, at every age and every tube the panel can hand them. The operator's words
  // for the shape, verbatim: "about clock nixie flicker, i have not witnessed any flickers, it should show as a
  // dimming effect that might have a strong spike on any change on the digit... like the new letter shows up with
  // 120% brigness, drops fast to 30, then dimms back up to 100% brightness - maybe with a random to affect
  // multiple but not all of the tubes at once". Six frames two and a half seconds apart cannot show a transient
  // that lives about a second and a half, which is exactly why the shape is measured here as a function of age
  // rather than as a second sample of the drawing.
  const strikeSrc691 = (function () {
    const from691 = src.indexOf('var NIXIE_STRIKE_PEAK691');
    const fn691 = src.indexOf('function nixieStrikeEvent691(');
    const close691 = fn691 >= 0 ? src.indexOf('\n      }', fn691) : -1;
    return (from691 >= 0 && fn691 > from691 && close691 > 0) ? src.slice(from691, close691 + 8) : '';
  })();
  const strike691 = strikeSrc691.length > 200 ? new Function(strikeSrc691
    + '\n return { at: nixieStrike691, event: nixieStrikeEvent691, seed: nixieSeedRand691,'
    + ' peak: NIXIE_STRIKE_PEAK691, trough: NIXIE_STRIKE_TROUGH691, fall: NIXIE_STRIKE_FALL_MS691,'
    + ' rise: NIXIE_STRIKE_RISE_MS691, jitter: NIXIE_STRIKE_JITTER691, strayMs: NIXIE_STRIKE_STRAY_MS691,'
    + ' maxTubes: NIXIE_STRIKE_STRAY_MAX_TUBES691 };')() : null;
  // The seeds the four tubes actually get (tube index * 31 + the event bucket), at four different event buckets,
  // plus deeper ones: the point is every tube and every jitter the seed can produce, not one lucky seed.
  const strikeSeeds691 = [];
  for (let t691s = 0; t691s < 4; t691s++) {
    for (let e691s = 0; e691s < 4; e691s++) strikeSeeds691.push(t691s * 31 + e691s);
  }
  for (let d691s = 0; d691s < 8; d691s++) strikeSeeds691.push(d691s * 977 + 13);
  const strikeCurves691 = strike691 ? strikeSeeds691.map(function (s691) {
    const c691 = [];
    for (let a691 = 0; a691 <= 5000; a691 += 5) c691.push(strike691.at(a691, s691));
    return c691;
  }) : [];
  const strikeAt0_691 = strike691 ? strikeSeeds691.map(function (s691) { return strike691.at(0, s691); }) : [];
  const strikeOffBand691 = strikeCurves691.filter(function (c691) {
    return c691.some(function (v691) { return v691 < strike691.trough - 1e-9 || v691 > strike691.peak + 1e-9; });
  });
  let strikeMin691 = 0, strikeMinAge691 = 0;
  const strikeRecover691 = [];
  strikeCurves691.forEach(function (c691) {
    let lo691 = c691[0], loAt691 = 0, k691 = c691.length - 1;
    for (let i691 = 0; i691 < c691.length; i691++) if (c691[i691] < lo691) { lo691 = c691[i691]; loAt691 = i691 * 5; }
    // The recovery is the start of the run of 1s at the END of the curve, not the first 1 the curve carries: on
    // the way down from the peak the curve passes through 1.0 as well, and that crossing is the drop, not the
    // dimming back up the operator asked for.
    while (k691 >= 0 && c691[k691] === 1) k691--;
    if (lo691 > strikeMin691 || strikeMin691 === 0) { strikeMin691 = lo691; }
    if (loAt691 > strikeMinAge691) strikeMinAge691 = loAt691;
    strikeRecover691.push(k691 < 0 ? -1 : (k691 + 1) * 5);
  });
  const strikeMax691 = Math.max.apply(null, strikeAt0_691);
  const strikeAt0Ok691 = strikeAt0_691.length > 0 && strikeAt0_691.every(function (v691) {
    return strike691 && Math.abs(v691 - strike691.peak) < 1e-9;
  });
  const strikeStays691 = strikeCurves691.every(function (c691, i691s) {
    const r691 = strikeRecover691[i691s];
    if (r691 < 0) return false;
    return c691.slice(r691 / 5).every(function (v691) { return v691 === 1; });
  });
  const strikeMonotone691 = strikeCurves691.every(function (c691) {
    let lo691 = 0;
    for (let i691 = 1; i691 < c691.length; i691++) if (c691[i691] < c691[lo691]) lo691 = i691;
    for (let i691 = lo691 + 1; i691 < c691.length; i691++) if (c691[i691] < c691[i691 - 1] - 1e-12) return false;
    return true;
  });
  const strikeCensus691 = { none: 0, one: 0, two: 0, three: 0, four: 0, intervals: 0 };
  if (strike691) {
    for (let b691 = 0; b691 < 4000; b691++) {
      const at691 = b691 * strike691.strayMs + Math.floor(strike691.strayMs / 2);   // mid-interval, never at its edge
      let n691 = 0;
      for (let t691 = 0; t691 < 4; t691++) if (strike691.event(at691, t691) > 0) n691++;
      strikeCensus691.intervals++;
      strikeCensus691[["none", "one", "two", "three", "four"][n691]]++;
    }
  }
  check('T-751: the strike is the shape the operator described, measured on the curve the client actually runs - it starts at the ruled peak at the moment the new digit appears, it drops to the ruled trough within the ruled fall, it comes back to exactly 1 and stays there, the way back is the slow half, and nothing it draws goes under the trough or over the peak, for every tube and every jitter the seed can produce',
    !!strike691 && strikeCurves691.length === 24 && strikeOffBand691.length === 0
    && strikeAt0Ok691 && Math.abs(strike691.peak - 1.20) < 1e-9 && Math.abs(strike691.trough - 0.30) < 1e-9
    && Math.abs(strikeMin691 - strike691.trough) < 1e-3
    && strikeMinAge691 <= strike691.fall * (1 + strike691.jitter) + 10
    && strikeRecover691.every(function (r691) { return r691 >= 0 && r691 <= (strike691.fall + strike691.rise) * (1 + strike691.jitter) + 10; })
    && strikeStays691 && strikeMonotone691
    && Math.min.apply(null, strikeRecover691) - strikeMinAge691 > 800,
    { peak: strikeMax691, trough: strikeMin691, trough_at_ms: strikeMinAge691,
      recovered_by_ms: strikeRecover691, ruled: { peak: strike691 ? strike691.peak : null,
        trough: strike691 ? strike691.trough : null, fall_ms: strike691 ? strike691.fall : null,
        rise_ms: strike691 ? strike691.rise : null, jitter: strike691 ? strike691.jitter : null },
      seeds: strikeSeeds691.length, off_band: strikeOffBand691.length });
  check('T-751: the random half of the ask is the ruled half - a stray strike takes one to three tubes in an interval and NEVER all four, over four thousand intervals read straight off the client\'s own function',
    !!strike691 && strikeCensus691.four === 0 && strikeCensus691.intervals === 4000
    && strikeCensus691.three > 0 && strikeCensus691.none > 0
    && strikeCensus691.one + strikeCensus691.two + strikeCensus691.three > 0,
    { census: strikeCensus691, ruled_max_tubes: strike691 ? strike691.maxTubes : null,
      ruled_odds: (function () { const m691 = /var NIXIE_STRIKE_STRAY_ODDS691 = ([0-9.]+);/.exec(src); return m691 ? parseFloat(m691[1]) : null; })() });
  check('T-751: the 120% is not faked as an alpha the wire cannot hold - the struck ink is the breath it is riding times the strike capped at 1, the part above 1 is spent on the halo\'s width, and a strike is only ever registered for a tube whose own digit changed since the last frame this face drew (a face that has never been drawn carries its own current digits, so a page load strikes nothing)',
    /var over691 = Math\.max\(0, strike691 - 1\);/.test(src)
    && /breath690 \* Math\.min\(1, strike691\)/.test(src)
    && /over691 \* NIXIE_STRIKE_WIDEN691/.test(src)
    && /if \(String\(st684n\.cur \|\| ""\)\.charAt\(i684t\) !== dgt684\[i684t\]\) struckAt691\[i684t\] = nowMs691;/.test(src)
    && /st684n = \{ w: W, h: H, cur: dgt684\.join\(""\) \};/.test(src),
    { ink_capped: /breath690 \* Math\.min\(1, strike691\)/.test(src),
      excess_to_halo: /over691 \* NIXIE_STRIKE_WIDEN691/.test(src),
      first_frame_state_seeded: /cur: dgt684\.join\(""\)/.test(src) });
  console.log('  MEASURE T-751 nixie strike: peak ' + strikeMax691.toFixed(4) + ' at age 0ms on all '
    + strikeSeeds691.length + ' seeds | trough ' + strikeMin691.toFixed(4) + ' at ' + strikeMinAge691
    + 'ms | back to 1.0 by ' + Math.min.apply(null, strikeRecover691) + '-' + Math.max.apply(null, strikeRecover691)
    + 'ms, stays there | ruled fall ' + (strike691 ? strike691.fall : null) + 'ms rise '
    + (strike691 ? strike691.rise : null) + 'ms jitter ' + (strike691 ? strike691.jitter : null)
    + ' | stray census over ' + strikeCensus691.intervals + ' intervals: nothing ' + strikeCensus691.none
    + ' one ' + strikeCensus691.one + ' two ' + strikeCensus691.two + ' three ' + strikeCensus691.three
    + ' four ' + strikeCensus691.four + ' (ruled max ' + (strike691 ? strike691.maxTubes : null) + ')');
  // T-791 (WM-46, 2026-11-11, the operator's ask verbatim: "please run an analysis on the nixie flicker effect -
  // i like it - but can we mix in some 'dimming' effects, too - that look more like analog voltage transitions
  // instead of only digital states?"). The analysis that came out of that measured the two curves this face already
  // runs and found both of them continuous -- the breath moves by at most 0.0079 per 50 ms and the strike recovers
  // along a cosine. What was digital was a TRANSITION, and two of them were missing: the arriving digit appears at
  // the strike's ruled peak (that half the operator asked for, and it stays), and the DEPARTING digit was not drawn
  // at all -- it simply stopped being drawn in the frame the new one appeared. The card answer was "A and C": a
  // de-ionisation afterglow on the digit a tube just left, and a supply sag shared by the whole frame when several
  // tubes change at once. Both are measured the way this file measures a curve it cannot photograph -- the client's
  // own functions read out of the source and evaluated -- and the drawing is read at a run of controlled instants.
  const analog791 = (function () {
    const from791 = src.indexOf('var NIXIE_BREATH_CEIL690');
    const fn791 = src.indexOf('function nixieSag791(');
    const close791 = fn791 >= 0 ? src.indexOf('\n      }', fn791) : -1;
    return (from791 >= 0 && fn791 > from791 && close791 > 0) ? new Function(src.slice(from791, close791 + 8)
      + '\n return { breath: nixieBreath690, after: nixieAfterglow791, sag: nixieSag791,'
      + ' strike: nixieStrike691, event: nixieStrikeEvent691,'
      + ' afterMs: NIXIE_AFTERGLOW_MS791, afterTop: NIXIE_AFTERGLOW_TOP791, afterWire: NIXIE_AFTERGLOW_WIRE791,'
      + ' sagMs: NIXIE_SAG_MS791, sagDepth: NIXIE_SAG_DEPTH791, sagTubes: NIXIE_SAG_TUBES791,'
      + ' floor: NIXIE_BREATH_FLOOR690, ceil: NIXIE_BREATH_CEIL690,' + ' strikeFall: NIXIE_STRIKE_FALL_MS691, strikeRise: NIXIE_STRIKE_RISE_MS691 };')() : null;
  })();
  const fpsOpts791 = (function () {
    const g791 = /var SCOPE_FPS_OPTS537 = \[([0-9, ]+)\];/.exec(src);
    return g791 ? g791[1].split(',').map(function (x791) { return parseInt(x791, 10); })
      .filter(function (x791) { return isFinite(x791) && x791 > 0; }) : [];
  })();
  const slowGap791 = fpsOpts791.length ? 1000 / Math.min.apply(null, fpsOpts791) : 0;
  const uniq791 = function (a791) {
    return a791.filter(function (v791, i791, s791) { return s791.indexOf(v791) === i791; }).sort(function (p791, q791) { return p791 - q791; });
  };
  const inkBase791 = function (c791) { return String(c791).slice(0, 7); };
  const inkAlpha791 = function (c791) { return String(c791).length === 9 ? parseInt(String(c791).slice(7), 16) : -1; };
  // The afterglow curve, read off the client's own function at every age it can be asked for.
  const afterCurve791 = analog791 ? (function () {
    const c791 = [];
    for (let a791 = 0; a791 <= analog791.afterMs + 600; a791 += 5) c791.push(analog791.after(a791));
    return c791;
  })() : [];
  const afterOver791 = analog791 ? afterCurve791.filter(function (v791) {
    return v791 > analog791.afterTop + 1e-12 || v791 < 0;
  }).length : 1;
  const afterMonotone791 = afterCurve791.every(function (v791, i791) {
    return i791 === 0 || v791 <= afterCurve791[i791 - 1] + 1e-12;
  });
  const afterEnds791 = analog791 ? (analog791.after(0) === analog791.afterTop && analog791.after(analog791.afterMs) === 0
    && analog791.after(analog791.afterMs + 5) === 0 && analog791.after(-1) === 0 && analog791.after(NaN) === 0) : false;
  const afterQuiet791 = analog791 ? (function () {
    const n791 = Math.floor(analog791.afterMs * 0.1 / 5);
    if (n791 < 2) return false;
    return (afterCurve791[0] - afterCurve791[n791]) < analog791.afterTop * 0.05;
  })() : false;
  check('T-791 (operator: "can we mix in some dimming effects, too - that look more like analog voltage transitions"): the afterglow is a fade, measured on the curve the client runs - it starts at the ruled top, it only ever goes down, it starts at a standstill so the frame after a change is not a second step, it arrives at exactly zero at the end of its window and stays there, and a negative or unreadable age answers zero. Nothing it draws is above the top or below nothing',
    !!analog791 && afterCurve791.length > 60 && afterOver791 === 0 && afterMonotone791 && afterEnds791 && afterQuiet791,
    { top: analog791 ? analog791.after(0) : null, ruled_top: analog791 ? analog791.afterTop : null,
      window_ms: analog791 ? analog791.afterMs : null, ages: afterCurve791.length,
      out_of_band: afterOver791, monotone: afterMonotone791, ends_at_zero: afterEnds791,
      first_tenth_of_window_moved: analog791 ? (afterCurve791[0] - afterCurve791[Math.floor(analog791.afterMs * 0.1 / 5)]) : null });
  // The sag curve, at three breaths: at the ruled ceiling, in the middle of the band, and AT the floor. The point of
  // reading it at the floor is the shape this card chose: the dip takes a share of the ROOM between the breath and
  // the floor, so a face already at its floor has nothing to sag into and is not pushed under it.
  const sagBreaths791 = analog791 ? [analog791.ceil, 0.90, analog791.floor] : [];
  const sagCurves791 = sagBreaths791.map(function (b791) {
    const c791 = [];
    for (let a791 = 0; a791 <= analog791.sagMs + 200; a791 += 5) c791.push(analog791.sag(a791, b791));
    return c791;
  });
  const sagBookends791 = sagCurves791.every(function (c791, i791) {
    const b791 = sagBreaths791[i791];
    return Math.abs(c791[0] - b791) < 1e-12 && c791[c791.length - 1] === b791 && analog791.sag(-1, b791) === b791
      && analog791.sag(NaN, b791) === b791;
  });
  const sagDips791 = sagCurves791.every(function (c791, i791) {
    const b791 = sagBreaths791[i791];
    const lo791 = Math.min.apply(null, c791);
    return b791 - analog791.floor < 1e-9 ? lo791 === b791 : lo791 < b791 - 1e-6;
  });
  const sagStays791 = sagCurves791.every(function (c791, i791) {
    const b791 = sagBreaths791[i791];
    return c791.every(function (v791) { return v791 >= analog791.floor - 1e-12 && v791 <= b791 + 1e-12; });
  });
  const sagShare791 = sagCurves791.every(function (c791, i791) {
    const b791 = sagBreaths791[i791];
    const room791 = b791 - analog791.floor;
    if (room791 <= 1e-12) return true;
    return (b791 - Math.min.apply(null, c791)) <= room791 * analog791.sagDepth + 1e-9;
  });
  const sagSym791 = sagCurves791.every(function (c791) {
    const n791 = analog791.sagMs / 5;
    if (Math.abs(n791 - Math.round(n791)) > 1e-9) return false;
    for (let i791 = 0; i791 < n791; i791++) if (Math.abs(c791[i791] - c791[n791 - i791]) > 1e-12) return false;
    return true;
  });
  check('T-791 (card answer "A and C"): the rollover sag is measured on the client function too - it is the breath at the moment of the change and again at the end of its window, it dips in the middle and the way in mirrors the way out, it never takes more than the ruled share of the room between the breath and the ruled floor, it never goes under that floor or over the breath it was given, and a breath already sitting at the floor is not pushed below it',
    !!analog791 && sagCurves791.length === 3 && sagBookends791 && sagDips791 && sagStays791 && sagShare791 && sagSym791,
    { at_ceiling: sagCurves791[0] ? Math.min.apply(null, sagCurves791[0]) : null,
      at_mid: sagCurves791[1] ? Math.min.apply(null, sagCurves791[1]) : null,
      at_floor: sagCurves791[2] ? Math.min.apply(null, sagCurves791[2]) : null,
      ruled: { window_ms: analog791 ? analog791.sagMs : null, depth: analog791 ? analog791.sagDepth : null,
        tubes: analog791 ? analog791.sagTubes : null, floor: analog791 ? analog791.floor : null } });
  check('T-791: both windows are ruled against the panel-own SLOWEST frame rate, not against 60 fps - Settings offers 60 / 30 / 20 / 12, and a transition shorter than a frame gap at the setting a person chose is a transition nobody sees. The afterglow spans at least four frames at the slowest one, the sag at least three, and both end well inside the strike they ride on',
    !!analog791 && fpsOpts791.length >= 2 && analog791.afterMs >= 4 * slowGap791 && analog791.sagMs >= 3 * slowGap791
      && analog791.afterMs < analog791.strikeFall + analog791.strikeRise && analog791.sagMs < analog791.strikeFall + analog791.strikeRise,
    { fps_offered: fpsOpts791, slowest_frame_gap_ms: slowGap791, afterglow_frames_at_slowest: analog791 ? Math.round(analog791.afterMs / slowGap791 * 100) / 100 : null,
      sag_frames_at_slowest: analog791 ? Math.round(analog791.sagMs / slowGap791 * 100) / 100 : null });
  // The run of frames. B791 is 600 ms before a ten-minute boundary, so the frame at B791 + 1000 is on the far side
  // of a change that moves TWO tubes at once, which is the only kind of frame a rollover sag is for. The face's
  // reading comes from new Date(), not from Date.now, so this stubs the Date CONSTRUCTOR and puts the real one back
  // in a finally either way. A warm-up frame four seconds earlier seeds the face on the 05:39 reading and lets
  // everything it starts there run out first: the strike lasts about a second and a half, the afterglow 420 ms and
  // the sag 260 ms, and a baseline is only a baseline if none of them is still on it.
  const RealDate791 = Date;
  const B791 = 1762040400000 - 600;
  const frame791 = async function (atMs791) {
    const FakeDate791 = function () { return new RealDate791(atMs791); };
    FakeDate791.prototype = RealDate791.prototype;
    FakeDate791.now = function () { return atMs791; };
    FakeDate791.UTC = RealDate791.UTC;
    FakeDate791.parse = RealDate791.parse;
    global.Date = FakeDate791;
    const n791f = b.strokeLog.length;
    const p791f = b.strokePaths.length;
    try {
      if (tick677b) tick677b();
      m.commit(); await flush();
    } finally { global.Date = RealDate791; }
    const strokes791 = b.strokeLog.slice(n791f);
    const paths791 = b.strokePaths.slice(p791f);
    const litA791 = strokes791.filter(function (c791) { return inkBase791(c791) === '#f6a23c'; }).map(inkAlpha791);
    const ghostA791 = strokes791.filter(function (c791) { return inkBase791(c791) === '#6b3f16' && String(c791).length === 9; }).map(inkAlpha791);
    const ghostW791 = paths791.filter(function (p791) { return inkBase791(p791.ink) === '#6b3f16' && String(p791.ink).length === 9; }).map(function (p791) { return p791.width; });
    const stackW791 = paths791.filter(function (p791) { return p791.ink === '#6b3f16'; }).map(function (p791) { return p791.width; });
    const litW791 = paths791.filter(function (p791) { return inkBase791(p791.ink) === '#f6a23c'; }).map(function (p791) { return p791.width; });
    return { at: atMs791, lit: uniq791(litA791), litMax: litA791.length ? Math.max.apply(null, litA791) : 0,
      litCount: litA791.length, ghosts: ghostA791, ghostAlpha: ghostA791.length ? Math.max.apply(null, ghostA791) : 0,
      ghostWidths: ghostW791, stackWidths: stackW791, litWidths: litW791, stackCount: stackW791.length };
  };
  // What the frame's supply actually is at a given instant: the breath, with this run's rollover sag folded into it
  // exactly the way the client folds it. The residual is drawn with THAT value, not with the unsagged breath -- a
  // de-ionising grid is fed by the same supply as everything else in the frame, and the measurement follows the
  // drawing rather than the simpler number.
  const supply791 = function (atMs791) {
    return Math.min(1, analog791.sag(atMs791 - (B791 + 1000), analog791.breath(atMs791)));
  };
  const expectWire791 = function (atMs791) { return Math.round(255 * supply791(atMs791)); };
  const fWarm791 = await frame791(B791 - 4000);   // seeds the face; nothing is read off this frame
  const fBase791 = await frame791(B791 + 500);
  const fHit791 = await frame791(B791 + 1000);
  const fDip791 = await frame791(B791 + 1130);
  const fLate791 = await frame791(B791 + 1400);
  const fGone791 = await frame791(B791 + 1700);
  const frameRun791 = [fBase791, fHit791, fDip791, fLate791, fGone791];
  const struckEvery791 = frameRun791.filter(function (f791) { return f791.litCount !== 4; }).length;
  const ghostSeen791 = frameRun791.filter(function (f791) { return f791.ghosts.length > 0; }).map(function (f791) { return f791.at - B791; });
  const ghostSame791 = [fHit791, fDip791, fLate791].every(function (f791) {
    return f791.ghosts.length === fHit791.ghosts.length && uniq791(f791.ghosts).length === 1;
  });
  const ghostAt791 = [fHit791, fDip791, fLate791].every(function (f791) {
    const want791 = Math.round(255 * analog791.after(f791.at - (B791 + 1000)) * supply791(f791.at));
    return f791.ghostAlpha === want791;
  });
  const ghostFade791 = fHit791.ghostAlpha > fDip791.ghostAlpha && fDip791.ghostAlpha > fLate791.ghostAlpha
    && fLate791.ghostAlpha > 0;
  check('T-791 drawing: the departing digit is drawn, and only after a change. The baseline frame and the frame seven hundred ms later draw no residual at all; the frame on the far side of a two-tube change draws one for every tube that changed, every stroke of it carrying the same alpha, and that alpha is the ruled top times this frame-own breath, read off the client function - not a value written into this file',
    !!analog791 && struckEvery791 === 0 && fBase791.ghosts.length === 0 && fGone791.ghosts.length === 0
      && fHit791.ghosts.length >= 2 && ghostSame791 && ghostAt791,
    { frames_ms_after_boundary: ghostSeen791, residual_strokes: [fBase791, fHit791, fDip791, fLate791, fGone791].map(function (f791) { return f791.ghosts.length; }),
      alphas: [fBase791, fHit791, fDip791, fLate791, fGone791].map(function (f791) { return f791.ghostAlpha; }),
      expected: [fHit791, fDip791, fLate791].map(function (f791) {
        return Math.round(255 * Math.min(1, analog791.after(f791.at - (B791 + 1000)) * analog791.breath(f791.at))); }) });
  check('T-791 drawing: the residual fades and it stops. Across the frames that carry one the alpha falls, frame after frame, along the curve the client runs, and past the window it is simply not drawn - no pop at the end, and no residual that outlives its ruling. Four struck tubes are still drawn in every frame of this run, so the residual never reads as a fifth tube',
    !!analog791 && ghostFade791 && ghostAt791 && fGone791.ghosts.length === 0 && struckEvery791 === 0,
    { alphas_in_order: [fHit791.ghostAlpha, fDip791.ghostAlpha, fLate791.ghostAlpha],
      curve_at_same_ages: [analog791 ? analog791.after(fHit791.at - (B791 + 1000)) : null,
        analog791 ? analog791.after(fDip791.at - (B791 + 1000)) : null,
        analog791 ? analog791.after(fLate791.at - (B791 + 1000)) : null],
      struck_wires_per_frame: frameRun791.map(function (f791) { return f791.litCount; }) });
  const struckWire791 = fHit791.litWidths.length ? Math.min.apply(null, fHit791.litWidths) : 0;
  const wantGhostWire791 = Math.max(1, Math.round(struckWire791 * (analog791 ? analog791.afterWire : 0)));
  const ghostWeight791 = fHit791.ghostWidths.length > 0 && fHit791.stackWidths.length > 0 && struckWire791 > 0
    && fHit791.ghostWidths.every(function (w791) { return w791 === wantGhostWire791; })
    && Math.min.apply(null, fHit791.ghostWidths) > Math.max.apply(null, fHit791.stackWidths);
  check('T-791 drawing: the residual is the FULL numeral at the ruled weight - every stroke of it is exactly the ruled fraction of the struck wire as the client rounds it, and it is wider than every plane of the stack behind it, which is the difference between a de-ionising grid and one more dim card. At a tube this small the ruled fraction lands on the same pixel as the struck wire and the detail names that; the planes are what it is measured against. The planes themselves are untouched: the stack is still drawn in the palette-own ghost ink carrying no alpha at all',
    ghostWeight791 && fHit791.stackCount >= 12 && fHit791.ghostWidths.every(function (w791) { return w791 > 0; }),
    { residual_wire: uniq791(fHit791.ghostWidths), plane_wire: uniq791(fHit791.stackWidths),
      struck_wire: uniq791(fHit791.litWidths), plane_strokes: fHit791.stackCount,
      ruled_wire_fraction: analog791 ? analog791.afterWire : null, struck_wire_px: struckWire791, ruled_wire_px: wantGhostWire791 });
  const sagOnDrawing791 = fDip791.litMax === expectWire791(fDip791.at) && fDip791.litMax < fHit791.litMax
    && fBase791.litMax === expectWire791(fBase791.at) && fHit791.litMax === expectWire791(fHit791.at)
    && fLate791.litMax === expectWire791(fLate791.at) && fLate791.litMax > fDip791.litMax;
  const sagInBand791 = frameRun791.every(function (f791) { return f791.litMax >= NIXIE_BAND_LO690 && f791.litMax <= NIXIE_BAND_HI690; });
  check('T-791 drawing: the sag is ONE shared value on the drawing, it is at its deepest in the middle of its window, and it ends. The frame at the change carries the plain breath (the dip comes in gently, so the change frame is not a step); the frame one hundred and thirty ms later carries a lower value on every tube at once and that value is exactly what the client function returns for that age and that breath; the frame four hundred ms later is back on the breath and higher than the dipped one; and no frame of this run puts a struck tube outside the ruled band the breath is held to',
    !!analog791 && sagOnDrawing791 && sagInBand791,
    { struck_max: [fBase791.litMax, fHit791.litMax, fDip791.litMax, fLate791.litMax, fGone791.litMax],
      expected_from_client: [fBase791, fHit791, fDip791, fLate791, fGone791].map(expectWire791),
      ages_ms: [fBase791.at - (B791 + 1000), 0, fDip791.at - (B791 + 1000), fLate791.at - (B791 + 1000), fGone791.at - (B791 + 1000)],
      band: [NIXIE_BAND_LO690, NIXIE_BAND_HI690] });
  const faceBody791 = (function () {
    const s791 = src.indexOf('function scopeNixieFace684(');
    const e791 = src.indexOf('\n      }', s791);
    return s791 >= 0 && e791 > s791 ? src.slice(s791, e791) : '';
  })();
  const clockReads791 = ((faceBody791.replace(/\/\/[^\n]*/g, '')).match(/Date\.now\(\)/g) || []).length;
  check('T-791 wiring: the analog half is keyed on a digit change and applied once per frame. The afterglow is aged against the tube-own strike clock and not against the interval-own stray clock, so a tube that was never left is never glowed; the departed character is remembered at the frame that leaves it, because the face-own reading is overwritten at the end of that frame; the sag is decided before any ink exists and is folded into the frame-own breath, which is the only place it can be folded and still be the one factor every struck tube shares; a rollover is this many tubes changing at once; and the face still reads the clock exactly once',
    /nixieAfterglow791\(nowMs691 - struckAt691\[i684t\]\)/.test(src)
    && !/nixieAfterglow791\(nowMs691 - eventAt691\)/.test(src)
    && /if \(struckAt691\[i684t\] === nowMs691\) leftCh791\[i684t\] = String\(st684n\.cur \|\| ""\)\.charAt\(i684t\);/.test(src)
    && /var breath690 = nixieSag791\(nowMs691 - \(st684n\.sagAt791 \|\| 0\), nixieBreath690\(nowMs691\)\);/.test(src)
    && /if \(moved791 >= NIXIE_SAG_TUBES791\) st684n\.sagAt791 = nowMs691;/.test(src)
    && /breath690 \* Math\.min\(1, strike691\)/.test(src)
    && /p690\.glow, \(s684d <= 0 \? \[\[1\.4, p690\.glow\]\] : \[\]\), null\)/.test(src)
    && clockReads791 === 1,
    { clock_reads_in_the_face: clockReads791, sag_tubes_ruled: analog791 ? analog791.sagTubes : null,
      afterglow_keyed_on: 'struckAt691 (a digit change), not eventAt691 (a stray strike)' });
  console.log('  MEASURE T-791 nixie analog layer: afterglow top ' + (analog791 ? analog791.afterTop : null) + ' over '
    + (analog791 ? analog791.afterMs : null) + 'ms (a cosine from a standstill to zero), sag '
    + (analog791 ? analog791.sagDepth : null) + ' of the room to the floor over ' + (analog791 ? analog791.sagMs : null)
    + 'ms at ' + (analog791 ? analog791.sagTubes : null) + ' tubes changing at once | frames at ms '
    + [fBase791, fHit791, fDip791, fLate791, fGone791].map(function (f791) { return f791.at - B791; }).join(' ')
    + ' | struck max ' + [fBase791.litMax, fHit791.litMax, fDip791.litMax, fLate791.litMax, fGone791.litMax].join(' ')
    + ' | residual alpha ' + [fBase791.ghostAlpha, fHit791.ghostAlpha, fDip791.ghostAlpha, fLate791.ghostAlpha, fGone791.ghostAlpha].join(' ')
    + ' | residual wire ' + uniq791(fHit791.ghostWidths).join(' ') + ' vs plane ' + uniq791(fHit791.stackWidths).join(' ')
    + ' vs struck ' + uniq791(fHit791.litWidths).join(' ')
    + ' | warm-up frame residuals ' + fWarm791.ghosts.length + ' | slowest frame gap ' + Math.round(slowGap791 * 100) / 100 + 'ms');

  // Window 2b (T-729, 2026-11-06, WM-30 item 2) - MOVED to this place in the walk by T-737 the same evening
  // (WM-31): the operator ruled the cycle's order, verbatim "order of clocks should be \"nixie orange -> nixie
  // green\" while cycling", so the walk now reaches this face ONE PRESS after the amber tube instead of three, and
  // this block moved with it. Nothing inside it changed: the face is still the same drawing in a second palette,
  // and it is still measured by the same numbers the amber face is held to. The label is this file's own ordering
  // of its measurement blocks; the walk's order is the one the client's list carries.
  // same drawing, a second palette, one more word in the walk. So this press measures a tube in green glass with
  // green struck wires and no amber anywhere in it - the same measurements the amber face is held to, run against
  // the other palette.
  let nGrn690 = b.rectLog.length, nGrnStrk690 = b.strokeLog.length;
  m.strip().props.onClick();
  m.commit(); await flush();
  const grnWin690 = b.rectLog.slice(nGrn690);
  const grnStrk690 = b.strokeLog.slice(nGrnStrk690);
  const grnWire690 = grnStrk690.filter(function (c690w) { return String(c690w).slice(0, 7) === '#37f0a0'; });
  const grnCore690 = grnStrk690.filter(function (c690c) { return String(c690c).slice(0, 7) === '#d9ffec'; });
  const grnHalo690 = grnStrk690.filter(function (c690h) { return String(c690h).slice(0, 7) === '#12a86a'; });
  const grnStack690 = grnStrk690.filter(function (c690s) { return c690s === '#0e5b39'; });
  const grnGlass690 = grnWin690.filter(function (r690g) { return r690g[5] === '#06110c'; });
  const grnRing690 = grnWin690.filter(function (r690r) { return r690r[5] === '#1d9b63'; });
  const grnMesh690 = grnWin690.filter(function (r690m) { return r690m[5] === '#0b2a1c'; });
  const amberAny690 = grnStrk690.filter(function (c690a) {
    const base690a = String(c690a).slice(0, 7);
    return base690a === '#f6a23c' || base690a === '#c1611d' || base690a === '#ffdcaa' || c690a === '#6b3f16';
  }).concat(grnWin690.filter(function (r690a) {
    const ink690a = r690a[5];
    return ink690a === '#150f08' || ink690a === '#a45f1c' || ink690a === '#241a10' || ink690a === '#6b3f16'
      || ink690a === '#3b2410' || ink690a === '#2c2417' || ink690a === '#0c0805' || ink690a === '#0a0705';
  }));
  const ledGreen690 = grnWin690.filter(function (r690l) { return r690l[5] === '#3fb950'; });
  check('T-729 (WM-30 item 2), reached one press after the amber tube since T-737 (WM-31): the face after the '
      + 'amber tube is the neon green tube - the walk moves to '
      + 'clock_nixie_green and draws the SAME tube face in the second palette: green glass envelopes, green foot '
      + 'rings, a green mesh, four struck green wires with their cores and three halo passes each, and none of the '
      + 'amber palette drawn anywhere in this face',
    b.store['deepamp:clock.mode681'] === 'clock_nixie_green' && b.store['deepamp:scope.mode'] === 'off'
      && grnWire690.length === 4 && grnCore690.length === 4 && grnHalo690.length === 12
      && grnStack690.length >= 12 && grnGlass690.length >= 5 && grnRing690.length >= 5 && grnMesh690.length > 0
      && amberAny690.length === 0 && ledGreen690.length === 0,
    { face: b.store['deepamp:clock.mode681'], vis: b.store['deepamp:scope.mode'], wire: grnWire690.length,
      core: grnCore690.length, halo: grnHalo690.length, stack: grnStack690.length, glass: grnGlass690.length,
      ring: grnRing690.length, mesh: grnMesh690.length, amber_drawn: amberAny690.length, led_green: ledGreen690.length });
  // Window 3 - the split-flap board, the face the walk reaches after the neon green tube. It was the third entry in
  // the list and it is the fourth since T-737 (WM-31, the operator's word: "order of clocks should be \"nixie orange
  // -> nixie green\" while cycling"). This block's label is this file's own order of measurements, not the walk's,
  // and it is the operator's redo: four modules of HH:MM, white
  // glyphs on black cards, a split line across each card, and the hinge nicks at the edges. The falling letters are
  // retired - no white rain of glyphs, and the old word is not aliased to this one.
  let nFlap677 = b.rectLog.length, nTxt684 = b.textLog.length;
  m.strip().props.onClick();
  m.commit(); await flush(); b.frames(1);
  const flapWin677 = b.rectLog.slice(nFlap677);
  const flapCard677 = flapWin677.filter(function (r) { return r[5] === '#0b0d0e' && r[3] >= 6; });
  const flapHinge677 = flapWin677.filter(function (r) { return r[5] === '#79807f'; });
  const flapLed677 = flapWin677.filter(function (r) { return r[5] === '#3fb950'; });
  const flapWhite677 = flapWin677.filter(function (r) { return r[5] === '#f4f7f7'; });
  // RE-POINTED 2026-10-28 by T-684, the operator's design session on the two faces. The board's cards used to carry
  // the panel's dot matrix, and this pin measured ink CELLS; the ruling the operator picked reads "Printed
  // letterforms, like your references", so the same face is now measured as what it PRINTS - four digits, in the
  // panel's own monospace face, on the cards' ink colour, placed at the card's middle by a baseline. The rest of
  // the pin (cards, split line, hinge nicks, and no other palette drawn) is unchanged.
  const flapPrint684 = b.textLog.slice(nTxt684).filter(function (t) { return t[6] === '#eef1f1'; });
  const flapDigits684 = flapPrint684.filter(function (t) { return /^[0-9]$/.test(t[0]); });
  check('T-681, re-pointed by T-684: the next press names the split-flap board - cards on black, four printed '
      + 'digits per face in the panel\'s own monospace, a split line and a hinge nick at each edge of each card, '
      + 'and neither the LED green nor the retired letters palette drawn anywhere in this face',
    b.store['deepamp:clock.mode681'] === 'clock_flap'
      && flapPrint684.length >= 4 && flapDigits684.length >= 4
      && flapPrint684.every(function (t) { return /monospace/.test(t[3]) && t[4] === 'center' && t[5] === 'alphabetic'; })
      && flapCard677.length >= 4 && flapHinge677.length >= 8
      && flapLed677.length === 0 && flapWhite677.length === 0,
    { face: b.store['deepamp:clock.mode681'], printed: flapPrint684.length, digits: flapDigits684.length,
      card: flapCard677.length, hinge: flapHinge677.length, led: flapLed677.length, letters: flapWhite677.length });

  // T-684 item 2: "No separator - four plain modules, wider gap", the operator's own reference reading 2210 with
  // no colon at all. What marks the pairs is the gap between them, so the measurement is the gap itself: the space
  // between the second and third card is several times the space between any other pair of cards.
  // (T-795 contract change, operator 2026-11-12, verbatim: "the distance between hours and minutes looks too big -
  // we should either place something in between, like two dots ':'". The gap and its ratio are untouched and this
  // check still measures them; what moved is that the gap is no longer empty, so the clause "nothing at all is
  // painted in that space" is re-expressed as what is painted there now - the separator, one lit dot and one unlit
  // one. The claim that the pairs are marked by a WIDER gap is kept whole. The separator itself is measured as its
  // own checks further down this window.)
  const flapInk684 = flapWin677.filter(function (r) { return r[5] === '#eef1f1'; });
  const flapCards684 = flapWin677.filter(function (r) { return r[5] === '#0b0d0e' && r[3] >= 6 && r[0] > 0; })
    .sort(function (a, b) { return a[0] - b[0]; });
  const gaps684 = [];
  for (let g684 = 1; g684 < flapCards684.length; g684++) {
    gaps684.push(flapCards684[g684][0] - (flapCards684[g684 - 1][0] + flapCards684[g684 - 1][2]));
  }
  check('T-684, its gap claim kept whole and its empty-space clause re-cut by T-795: four cards, the space between '
      + 'the hour pair and the minute pair at least three times the space within a pair, and the only ink painted in '
      + 'that space is the one lit dot this board\'s separator now carries',
    flapInk684.length === 1 && flapCards684.length === 4 && gaps684.length === 3
      && gaps684[1] >= 3 * gaps684[0] && gaps684[1] >= 3 * gaps684[2] && gaps684[0] >= 1 && gaps684[2] >= 1,
    { inkPainted: flapInk684.length, cards: flapCards684.length, gaps: gaps684 });
  // T-684 addendum 2, the operator's first sentence on the flip board, verbatim: "i think it needs to be vertically
  // centered, the numbers are currently not center, that looks off". This measures the INK, not the em box: for every
  // digit the board prints, the middle of the ink the canvas reported (this stub reports 0.78 of the em, deliberately
  // NOT the 0.73 the client's own ratio assumes) has to land on the middle of the card, and the ink itself has to
  // stay inside the card. Before this build the baseline was placed by that assumed ratio, so with the stub's real
  // metrics the number rode below the middle and the seam fell where the operator does not expect it.
  const cardRects689 = flapWin677.filter(function (r690c) { return r690c[5] === '#0b0d0e' && r690c[2] >= 6 && r690c[2] < 90 && r690c[3] >= 6 && r690c[3] < 90; });
  const inkFontPx = function (t690p) { const m690f = /([0-9.]+)px/.exec(t690p[3]); return m690f ? parseFloat(m690f[1]) : 0; };
  const cardFor689 = function (x690x) {
    for (let i690c = 0; i690c < cardRects689.length; i690c++) {
      const r690c = cardRects689[i690c];
      if (x690x >= r690c[0] && x690x <= r690c[0] + r690c[2]) return r690c;
    }
    return null;
  };
  let inkOff = 999, inkSpills = 0, ratioShrink = 0, inkHeights = [];
  flapPrint684.forEach(function (t690p) {
    const card690c = cardFor689(t690p[1]);
    if (!card690c) return;
    const fsz690 = inkFontPx(t690p);
    const asc690 = fsz690 * 0.78;                 // the stub's reported ink height above the baseline
    const midY690 = card690c[1] + card690c[3] / 2;
    const inkMid690 = t690p[2] - asc690 / 2;      // the middle of the ink that was actually painted
    inkOff = Math.min(inkOff, Math.abs(inkMid690 - midY690));
    if (t690p[2] > card690c[1] + card690c[3] || t690p[2] - asc690 < card690c[1]) inkSpills++;
    inkHeights.push(asc690);
    // The card's cap height is the authority: cap = cardH * (1 - 2 * FLAP_PAD681), and the ratio the geometry was
    // built from asks for a font of cap / FLAP_CAP684. The print had to shrink to that authority.
    // (T-795: FLAP_PAD681 moved from 0.16 to 0.07 on the operator's word about the letter heights; the authority
    // this clause measures is the same one, at its new value. The claim - the print is fitted to the card, not the
    // card to the print - is unchanged and still has to hold.)
    const capH690 = card690c[3] * (1 - 2 * 0.07);
    ratioShrink = Math.max(ratioShrink, (capH690 / 0.73) - fsz690);
  });
  check('T-684 addendum 2: the numbers are centred on their INK, not on their em box - the middle of the ink the '
      + 'canvas reports lands on the middle of the card (within one pixel), the ink stays inside the card, and when '
      + 'the canvas reports a face the assumed ratio does not have, the print is fitted to the card rather than the '
      + 'card being fitted to the print',
    cardRects689.length >= 4 && flapPrint684.length >= 4 && inkOff <= 1 && inkSpills === 0 && ratioShrink > 1
      && inkHeights.every(function (h690i) { return h690i > 0; }),
    { inkOffCentre: inkOff, spillsOutOfCard: inkSpills, shrinkPx: Math.round(ratioShrink),
      
      inkHeights: inkHeights.map(function (h690j) { return Math.round(h690j); }) });
  // T-684 addendum 2, the operator's second sentence, verbatim: "the number cards need a 1 pixel hoirontal line in
  // the middle of the numbers to show it's a top and bottom half". What is measured is the ORDER of the drawing: the
  // seam exists on every card, one pixel tall, at the card's own middle, in an ink that is not the card's - and it
  // is drawn AFTER the print, which is exactly what made it invisible before (it used to be drawn first, in the
  // card's own colour, so the glyph painted over it).
  const seamRects689 = flapWin677.filter(function (r690s) { return r690s[5] === '#394143' && r690s[2] >= 6 && r690s[3] === 1; });
  // The same frame can be drawn twice into this window (the tick repaints), so the cards are grouped by their own
  // geometry rather than counted one by one: one entry per card, with every seam and every print that landed on it.
  const cardGroup689 = {};
  cardRects689.forEach(function (r690c) {
    const k690g = [r690c[0], r690c[1], r690c[2], r690c[3]].join(',');
    if (!cardGroup689[k690g]) cardGroup689[k690g] = { rect: r690c, seams: [], prints: [] };
  });
  let seamWrong = 0, seamBeforePrint = 0;
  Object.keys(cardGroup689).forEach(function (k690k) {
    const g690g = cardGroup689[k690k], r690c = g690g.rect;
    const midY690m = Math.floor(r690c[1] + r690c[3] / 2);
    g690g.seams = seamRects689.filter(function (r690s) {
      return r690s[0] === r690c[0] && r690s[2] === r690c[2] && r690s[1] === midY690m;
    });
    g690g.prints = flapPrint684.filter(function (t690q) { return t690q[1] >= r690c[0] && t690q[1] <= r690c[0] + r690c[2]; });
    if (!g690g.seams.length) { seamWrong++; return; }
    const lastPrint690 = g690g.prints.reduce(function (m690p, t690q) { return Math.max(m690p, t690q[7] || 0); }, 0);
    const lastSeam690 = g690g.seams.reduce(function (m690s, r690s) { return Math.max(m690s, r690s[6] || 0); }, 0);
    if (!g690g.prints.length || lastSeam690 <= lastPrint690) seamBeforePrint++;
  });
  check('T-684 addendum 2: every card carries a one-pixel seam at its own middle, in an ink that is not the card\'s, '
      + 'and that seam is drawn AFTER the print - so the top half and the bottom half read as two halves instead of '
      + 'the glyph painting over the line',
    Object.keys(cardGroup689).length >= 4 && seamRects689.length >= 4 && seamWrong === 0 && seamBeforePrint === 0,
    { seams: seamRects689.length, cards: Object.keys(cardGroup689).length, missing: seamWrong, beforePrint: seamBeforePrint });
  check('T-681: an idle flap board arms no draw loop - only the module whose digit changed turns, and a board that '
      + 'is standing still has nothing moving. The loop gate is what this measures',
    b.rafQueue.length === 0, [b.rafQueue.length]);
  // RE-POINTED 2026-10-28 by T-684. This pin used to match the source line exactly as it stood, and the line it
  // matched carried a typo: the cap read seqD681.length, a variable that does not exist, so a module that had to
  // pass more than three faces threw rather than capped. The rewritten board fixed that; the pin names the
  // corrected line, and the cap is measured below instead of only read off the source.
  check('T-681 source, re-pointed by T-684: the flip sequence is a digit drum counted forward, capped at the few '
      + 'faces the operator asked for ("two or three faces"), and the module that reaches its target stops - there '
      + 'is no second queue to run',
    /function scopeFlapDrum681\(fromD681, toD681\)/.test(src)
      && /if \(fromD681 === toD681\) return \[\];/.test(src)
      && /if \(seq681\.length > FLAP_MAX_FACES681\) seq681 = seq681\.slice\(seq681\.length - FLAP_MAX_FACES681\);/.test(src),
    'the drum moved');

  // T-684: the cap measured rather than read off the source. The board's state is not reachable from here, so the
  // cap is measured through what the board prints: a module that is asked to move more faces than the operator
  // asked for shows at most FLAP_MAX_FACES681 of them. The change is driven by moving the browser\'s clock five
  // minutes on - the units digit then jumps by five, which is more than the cap - and the real clock is put back
  // straight after, so nothing else in this suite sees the stub.
  const realDate684 = global.Date;
  const baseDate684 = realDate684.now();
  global.Date = function () { return new realDate684(baseDate684 + 5 * 60000); };
  global.Date.now = function () { return baseDate684 + 5 * 60000; };
  let nCapTxt684 = b.textLog.length, nCapTxt684Rect725 = b.rectLog.length;   // T-725: the cards of this same window, so a band can be measured against the card it is inside
  if (tick677b) tick677b();
  m.commit(); await flush();
  b.frames(40);
  const capTxt684 = b.textLog.slice(nCapTxt684).filter(function (t684) { return /monospace/.test(t684[3]); });
  global.Date = realDate684;
  const capByPos684 = {};
  capTxt684.forEach(function (t684) {
    const k684 = Math.round(t684[1] / 10) * 10;
    if (!capByPos684[k684]) capByPos684[k684] = [];
    if (capByPos684[k684].indexOf(t684[0]) < 0) capByPos684[k684].push(t684[0]);
  });
  const capCounts684 = Object.keys(capByPos684).map(function (k684) { return capByPos684[k684].length; });  check('T-684: a module asked to move more faces than the operator named shows at most three of them - the drum '
      + 'is capped, measured through the printed faces of one change',
    capTxt684.length > 0 && capCounts684.length > 0
      && Math.max.apply(null, capCounts684) <= 4 && capCounts684.some(function (c684) { return c684 > 1; }),
    { printed: capTxt684.length, perModule: capCounts684, raw: capTxt684.map(function (t684d) { return t684d[0] + '@' + t684d[1] + '@' + t684d[2]; }) });

  // T-725 (WM-31 item 8, the operator's words of 2026-11-05: "flip clock faces: fix/optimise 'drop of letters' ...").
  // What is measured here is the shape the defect had. The cap window above moves the browser's clock five minutes on,
  // so a module really flips, and the stub now carries the clip a print is under the same way it already carries the
  // translate offset. Two adjacent prints on one card are one frame of that flip. The claim: the two faces of a flip
  // are printed in two bands that MEET at the moving edge and TOGETHER ARE THE CARD - and no frame prints both faces
  // across the whole card, which is what "two letters at once" is.
  const nCapRect725 = nCapTxt684Rect725;
  const flipCards725 = b.rectLog.slice(nCapRect725).filter(function (r725) { return r725[5] === '#0b0d0e' && r725[2] >= 6 && r725[3] >= 6; });
  const flipPrints725 = b.textLog.slice(nCapTxt684);
  const flipFrames725 = [];
  for (let i725 = 1; i725 < flipPrints725.length; i725++) {
    const a725 = flipPrints725[i725 - 1], c725 = flipPrints725[i725];
    if (!Array.isArray(a725[8]) || !Array.isArray(c725[8])) continue;      // a face that is not flipping has no band
    if (a725[8][0] !== c725[8][0] || a725[8][2] !== c725[8][2]) continue;  // two different cards
    const card725 = flipCards725.filter(function (r725) { return r725[0] === a725[8][0] && r725[2] === a725[8][2]; })[0];
    if (!card725) continue;
    const hi725 = a725[8][1] <= c725[8][1] ? a725[8] : c725[8];            // the band the arriving card covers
    const lo725 = hi725 === a725[8] ? c725[8] : a725[8];                  // the band the leaving face is printed in
    flipFrames725.push({
      faces: [a725[0], c725[0]],
      meets: Math.abs((hi725[1] + hi725[3]) - lo725[1]) <= 1,
      tiles: hi725[1] >= card725[1] - 1
          && Math.abs((lo725[1] + lo725[3]) - (card725[1] + card725[3])) <= 1
          && hi725[3] + lo725[3] <= card725[3] + 1,
      both_whole: hi725[3] >= card725[3] - 1 && lo725[3] >= card725[3] - 1,
    });
  }
  const flipBad725 = flipFrames725.filter(function (f725) { return !f725.meets || !f725.tiles || f725.both_whole; });
  check('T-725 (WM-31 item 8): a flip prints its two faces in two bands that meet at the moving edge and tile the '
      + 'card - no frame of a real flip prints both faces across the whole card, which is the shape the operator '
      + 'named as the drop of letters showing two letters at once',
    flipFrames725.length >= 8 && flipBad725.length === 0,
    { frames: flipFrames725.length, bad_frames: flipBad725.length,
      sample: flipFrames725.slice(0, 3), bad_sample: flipBad725.slice(0, 3) });

  // T-795 (WM-49 item 4), the operator's words of 2026-11-12, verbatim: "for the clock faces with the falling
  // numbers, the distance between hours and minutes looks too big - we should either place something in between,
  // like two dots ':' - maybe alternating with upper and lower beingswitched every second - or make a suggestion how
  // to 'center' the letter heights within the canvas", and the shape chosen from the options put was both halves:
  // the dots in the gap AND the letter heights filled out. Everything below is measured off the board this fixture
  // has already drawn (200x80 canvas, four cards), and the two halves are measured separately because they are two
  // different claims about two different things. The fixture's own clock is set here and put back after: the two
  // times chosen are five and six seconds past a minute, so the parity of the separator is under test while no
  // digit changes and no flip is in flight.
  const now795 = Date.now;
  const cardsOf795 = function (win795, cardColor795) {
    return win795.filter(function (r795c) { return r795c[5] === cardColor795 && r795c[2] >= 6 && r795c[3] >= 6 && r795c[2] < 90; })
      .sort(function (a795, b795) { return a795[0] - b795[0]; });
  };
  // The separator is a SQUARE. A card's rim is also drawn in the edge colour, but a rim is 1 pixel wide and as tall
  // as the card, so asking for a square with a side of at least 2 pixels separates the dot from the rim without
  // naming a size the panel is allowed to shrink to.
  const dotsIn795 = function (win795, color795, x0795, x1795) {
    return win795.filter(function (r795d) {
      return r795d[5] === color795 && r795d[2] === r795d[3] && r795d[2] >= 2
        && r795d[0] >= x0795 && r795d[0] + r795d[2] <= x1795;
    });
  };
  const flCards795 = cardsOf795(flapWin677, '#0b0d0e');
  const flGap795 = flCards795.length >= 4
    ? { x0: flCards795[1][0] + flCards795[1][2], x1: flCards795[2][0] } : { x0: 0, x1: 0 };
  const flLit795 = dotsIn795(flapWin677, '#eef1f1', flGap795.x0, flGap795.x1);
  const flDim795 = dotsIn795(flapWin677, '#2b3133', flGap795.x0, flGap795.x1);
  const flSeamY795 = flCards795.length ? flCards795[0][1] + flCards795[0][3] / 2 : 0;
  const flCardH795 = flCards795.length ? flCards795[0][3] : 0;
  const dotMid795 = function (r795d) { return r795d[1] + r795d[3] / 2; };
  const flRise795 = flLit795.concat(flDim795).map(function (r795d) { return Math.abs(dotMid795(r795d) - flSeamY795) / flCardH795; });
  check('T-795: the gap between the hour pair and the minute pair carries its separator - one lit dot in the face\'s '
      + 'own ink and one unlit dot in the colour the card rim is painted in, both squares on the same vertical line '
      + 'inside that gap, one above the seam the cards are split on and one below it, at a rise measured from the '
      + 'card\'s own height and small enough to be punctuation rather than a fifth module',
    flCards795.length === 4 && flLit795.length === 1 && flDim795.length === 1
      && Math.abs(flLit795[0][0] - flDim795[0][0]) <= 1
      && flLit795[0][2] <= Math.round(0.25 * flCardH795) && flDim795[0][2] <= Math.round(0.25 * flCardH795)
      && flRise795.length === 2 && flRise795.every(function (v795) { return v795 >= 0.10 && v795 <= 0.45; })
      && (dotMid795(flLit795[0]) - flSeamY795) * (dotMid795(flDim795[0]) - flSeamY795) < 0,
    { cards: flCards795.length, gap: [flGap795.x0, flGap795.x1], lit: flLit795, unlit: flDim795,
      rise_of_card_height: flRise795.map(function (v795b) { return Math.round(v795b * 100) / 100; }),
      seam_y: flSeamY795 });

  // The swap, measured by drawing the same settled board twice, one second apart. Nothing about the time changes
  // between the two draws (both are seconds 5 and 6 past the same minute), so the only thing that may differ is
  // which of the two dots carries the ink.
  const base795 = 1762040700000;
  Date.now = function () { return base795 + 5000; };
  if (tick677b) tick677b();
  m.commit(); await flush();
  let nA795 = b.rectLog.length;
  if (tick677b) tick677b();
  m.commit(); await flush();
  const winA795 = b.rectLog.slice(nA795);
  Date.now = function () { return base795 + 6000; };
  let nB795 = b.rectLog.length;
  if (tick677b) tick677b();
  m.commit(); await flush();
  const winB795 = b.rectLog.slice(nB795);
  Date.now = now795;
  const aCards795 = cardsOf795(winA795, '#0b0d0e');
  const bCards795 = cardsOf795(winB795, '#0b0d0e');
  const gapOf795 = function (cs795) { return cs795.length >= 4 ? { x0: cs795[1][0] + cs795[1][2], x1: cs795[2][0] } : { x0: 0, x1: 0 }; };
  const gA795 = gapOf795(aCards795), gB795 = gapOf795(bCards795);
  const aLit795 = dotsIn795(winA795, '#eef1f1', gA795.x0, gA795.x1);
  const bLit795 = dotsIn795(winB795, '#eef1f1', gB795.x0, gB795.x1);
  const aDim795 = dotsIn795(winA795, '#2b3133', gA795.x0, gA795.x1);
  const bDim795 = dotsIn795(winB795, '#2b3133', gB795.x0, gB795.x1);
  const seamA795 = aCards795.length ? aCards795[0][1] + aCards795[0][3] / 2 : 0;
  const seamB795 = bCards795.length ? bCards795[0][1] + bCards795[0][3] / 2 : 0;
  const above795 = function (d795, s795) { return d795.length === 1 && dotMid795(d795[0]) < s795; };
  const below795 = function (d795, s795) { return d795.length === 1 && dotMid795(d795[0]) > s795; };
  check('T-795: the two dots switch on the clock\'s own second - the same settled board drawn one second later puts '
      + 'its lit dot on the other side of the seam, the unlit dot takes the side the lit one left, and the cards, '
      + 'the gap and the printed digits are in the same place in both frames',
    aLit795.length === 1 && bLit795.length === 1 && aDim795.length === 1 && bDim795.length === 1
      && ((above795(aLit795, seamA795) && below795(bLit795, seamB795)) || (below795(aLit795, seamA795) && above795(bLit795, seamB795)))
      && ((above795(aDim795, seamA795) && below795(bDim795, seamB795)) || (below795(aDim795, seamA795) && above795(bDim795, seamB795)))
      && Math.abs(aCards795[0][0] - bCards795[0][0]) <= 1 && Math.abs(gA795.x0 - gB795.x0) <= 1,
    { frame_a_lit: aLit795.map(function (d795c) { return [d795c[0], d795c[1]]; }),
      frame_b_lit: bLit795.map(function (d795d) { return [d795d[0], d795d[1]]; }),
      frame_a_unlit: aDim795.map(function (d795e) { return [d795e[0], d795e[1]]; }),
      frame_b_unlit: bDim795.map(function (d795f) { return [d795f[0], d795f[1]]; }),
      cards_a: aCards795.length, cards_b: bCards795.length });

  // The other half of the ask. The ink MIDDLE was already centred (T-684 addendum 2 measures it and still does);
  // what was not filled was the ink HEIGHT: a card printed its digit at 68 per cent of its own height, leaving 16
  // per cent of empty card above and below. Measured here is the cap the print actually carries, out of the font
  // the canvas was told to draw, against the card the fixture drew - and the claim is that the digit now fills the
  // card it is printed on.
  const fillPrints795 = flapDigits684;
  const cardAt795 = function (x795x) {
    for (let i795c = 0; i795c < flCards795.length; i795c++) {
      const r795c = flCards795[i795c];
      if (x795x >= r795c[0] && x795x <= r795c[0] + r795c[2]) return r795c;
    }
    return null;
  };
  const fills795 = [];
  fillPrints795.forEach(function (t795q) {
    const c795q = cardAt795(t795q[1]);
    if (!c795q) return;
    const m795f = /([0-9.]+)px/.exec(t795q[3]);
    if (!m795f) return;
    fills795.push((parseFloat(m795f[1]) * 0.73) / c795q[3]);
  });
  check('T-795: the letter heights fill the card they are printed on - every digit the black board prints carries a '
      + 'cap of at least 70 per cent of its card\'s height (it was 68 per cent asked for, and less than that once '
      + 'the print was fitted), the digit still does not reach the card\'s rim, and the card keeps its padding so '
      + 'the rim and the seam are still drawn on it',
    fills795.length >= 4 && fills795.every(function (v795c) { return v795c >= 0.70 && v795c <= 0.95; }),
    { digits_measured: fills795.length, cap_of_card_height: fills795.map(function (v795d) { return Math.round(v795d * 100) / 100; }),
      card_height: flCardH795 });

  // Window 4 - the press walks the clock faces in one direction, and the walk wraps back to the LED face. The
  // visualizer ring is never reached from a clock canvas: that is the operator's rule, not a shortcut.
  // T-684 addendum 2 (operator 2026-10-29, verbatim): "we should add the same version in in inverted black on
  // white setting - either as a 4th mode or color set", and the answer to the question was "A fourth face in the
  // walk". So the walk now carries FOUR faces, and the one after the black board is the inverted one. This first
  // press measures that: the same four modules, the cards near-white and the glyphs dark, the seam in the light
  // palette's ink, and no black card and no white-on-black print anywhere in this face.
  let nFl2 = b.rectLog.length, nFl2Txt = b.textLog.length;
  m.strip().props.onClick();
  m.commit(); await flush();
  const winLight689 = b.rectLog.slice(nFl2);
  const printLight689 = b.textLog.slice(nFl2Txt).filter(function (t689l) { return /monospace/.test(t689l[3]); });
  const cardsLight689 = winLight689.filter(function (r689l) { return r689l[5] === '#f4f7f6' && r689l[2] >= 6 && r689l[3] >= 6; });
  const seamLight689 = winLight689.filter(function (r689s) { return r689s[5] === '#8f9799' && r689s[2] >= 6 && r689s[3] === 1; });
  const blackCards689 = winLight689.filter(function (r689b) { return r689b[5] === '#0b0d0e' && r689b[2] >= 6 && r689b[2] < 90 && r689b[3] >= 6 && r689b[3] < 90; });
  const whiteInk689 = printLight689.filter(function (t689w) { return t689w[6] === '#eef1f1'; });
  const darkInk689 = printLight689.filter(function (t689d) { return t689d[6] === '#14181a' && /^[0-9]$/.test(t689d[0]); });
  check('T-684 addendum 2: the face after the black board is the inverted board - the walk moves to clock_flap_light, '
      + 'and it prints the SAME four modules dark-on-white, with a seam in its own ink across every card, and nothing '
      + 'of the dark board (no black card, no white glyph) drawn in this face',
    b.store['deepamp:clock.mode681'] === 'clock_flap_light'
      && darkInk689.length >= 4 && cardsLight689.length >= 4 && seamLight689.length >= 4
      && blackCards689.length === 0 && whiteInk689.length === 0,
    { face: b.store['deepamp:clock.mode681'], printed: darkInk689.length, cards: cardsLight689.length,
      seam: seamLight689.length, black_cards: blackCards689.length, white_ink: whiteInk689.length });

  // T-689 addendum, the operator's look at the rendered board, verbatim: "ahh, i see the white flip clock, but i
  // guess we should NOT make the canvas white aswell, make it default background color of the window so we do not have
  // white flipcards on white background". The ground this face paints is the surface the fixture answers through
  // document.body (b.surfaceBg689); the near-white ground that used to sit in the palette table is gone, and the last
  // full-box fill of this window is the read colour, not a colour the panel invented.
  const fullBox689 = winLight689.filter(function (r689g) { return r689g[1] === 0 && r689g[2] === 200 && r689g[3] === 80; });
  const nearWhite689 = winLight689.filter(function (r689n) { return r689n[5] === '#dfe5e4'; });
  check('T-689 addendum: the light board does not paint a white box around itself - the ground it sits on is the '
      + 'surface the panel is mounted on, read off the element tree, and no near-white ground is drawn anywhere in '
      + 'this face',
    fullBox689.length > 0 && fullBox689[fullBox689.length - 1][5] === b.surfaceBg689 && nearWhite689.length === 0,
    { grounds: fullBox689.map(function (r689g) { return r689g[5]; }), near_white: nearWhite689.length });
  // T-795, the same separator on the inverted board. The ask named the clock faces, not one of them, and the two
  // flap faces share their whole drawing path with only the palette swapped - so the claim measured here is that the
  // inverted board carries the separator too, in ITS inks: the lit dot in the dark ink it prints its digits in and
  // the unlit one in the colour its card rims are drawn in. Nothing of the dark board's palette is drawn here, which
  // the check above this one already holds for the cards and the glyphs.
  const lc795 = cardsLight689.slice().sort(function (a795, b795) { return a795[0] - b795[0]; });
  const lg795 = lc795.length >= 4 ? { x0: lc795[1][0] + lc795[1][2], x1: lc795[2][0] } : { x0: 0, x1: 0 };
  const lLit795 = dotsIn795(winLight689, '#14181a', lg795.x0, lg795.x1);
  const lDim795 = dotsIn795(winLight689, '#c2c9ca', lg795.x0, lg795.x1);
  const lSeam795 = lc795.length ? lc795[0][1] + lc795[0][3] / 2 : 0;
  check('T-795: the inverted board carries the same separator in its own inks - one lit dot in the dark ink this face '
      + 'prints its digits in, one unlit dot in the colour its card rims are drawn in, on one vertical line inside '
      + 'the pair gap, one above its seam and one below it, and no ink of the dark board painted in this face',
    lc795.length === 4 && lLit795.length === 1 && lDim795.length === 1
      && Math.abs(lLit795[0][0] - lDim795[0][0]) <= 1
      && (dotMid795(lLit795[0]) - lSeam795) * (dotMid795(lDim795[0]) - lSeam795) < 0
      && blackCards689.length === 0 && whiteInk689.length === 0,
    { cards: lc795.length, lit: lLit795, unlit: lDim795, seam_y: lSeam795,
      dark_card_painted: blackCards689.length, white_ink_painted: whiteInk689.length });
  m.strip().props.onClick();
  m.commit(); await flush();
  check('T-681, re-pointed by T-686, by T-684 addendum 2, by T-729, and re-cut by T-737: the walk wraps from the '
      + 'inverted board back to the LED face - one press, one '
      + 'direction, and the visualizer word untouched. That word is `off`, which is the state the clock walk is '
      + 'reached from (the clock is entered through its own row, not through a press in a running visualizer). '
      + '(T-729 contract change: the walk was four faces long and this press was the wrap; the operator\'s ask '
      + 'added a fifth - "add \'neon green color variant\'" - and the ruling put it at the end of the list. T-737 (WM-31) then '
      + 'moved it in the list on the operator\'s word - "order of clocks should be \'nixie orange -> nixie green\' while '
      + 'cycling" - so the wrap is one press EARLIER again and comes off the inverted board, which is the face the '
      + 'walk now ends on. Nothing about the direction or the visualizer word changed.)',
    b.store['deepamp:clock.mode681'] === 'clock_led' && b.store['deepamp:scope.mode'] === 'off',
    { face: b.store['deepamp:clock.mode681'], vis: b.store['deepamp:scope.mode'] });

  // T-686, the operator's report measured directly: the click on the Knight Rider vis. RE-POINTED 2026-10-29 by
  // T-689 (the operator's ruling on the three press targets, verbatim: "if i klick the clock face, the clock should
  // cycle to next clock / if visualizer is pressed, next visualizer, (as is)"). The state this pin needs is the one
  // the operator's report described - a visualizer that is ACTUALLY painting, a take playing - which is what the
  // press rule now asks. The clock is on, a visualizer is chosen, a take plays, and the press must walk the
  // visualizer and wrap to its first entry (the ring's last entry is `off`, and with the clock on the walk does not
  // step into it - that is the half of T-686 that stays), while the clock face word keeps still.
  const knightCtl686 = m.els('audio-play-scope-mode531-knight')[0];
  if (knightCtl686) { knightCtl686.props.onClick(); }
  m.commit(); await flush();
  const faceWordBefore686 = b.store['deepamp:clock.mode681'];
  const node689 = m.armAudio(1);
  node689.paused = false; node689.ended = false;
  node689.fire('play');
  m.commit(); await flush();
  m.strip().props.onClick();
  m.commit(); await flush();
  // RE-POINTED 2026-11-07 by T-746: Knight Rider is no longer the ring's last word before off — the rolling
  // mark sits there now, so the walk reaches the mark first and only then steps past off and wraps. The press
  // rule this pin measures is unchanged; the distance to the wrap grew by one entry. RE-POINTED AGAIN the same day
  // by T-749: the whale mark joins after the mark the operator already had, so the distance grew again. RE-POINTED
  // A THIRD TIME the same evening by T-755, on the operator's re-ordering ("move the LED bars under waveform , and
  // make dancing llama the last visualizer in the list"): from the Knight Rider row the marks are now four presses
  // away -- LED bars, segmented ladder, moving coil, waterfall, rolling mark -- and the wrap is two presses past
  // the whale mark, because the dancing llama, the entry the operator asked to sit last, sits between the whale
  // mark and `off`. The press rule measured here has never moved: a press on the canvas in a running visualizer
  // walks the visualizer, never the clock.
  m.strip().props.onClick();
  m.commit(); await flush();
  m.strip().props.onClick();
  m.commit(); await flush();
  m.strip().props.onClick();
  m.commit(); await flush();
  check('T-746, re-pointed by T-755: the walk from the Knight Rider row reaches the rolling mark, and the clock '
      + 'face word keeps still on every press of it',
    b.store['deepamp:scope.mode'] === 'qwen' && b.store['deepamp:clock.mode681'] === faceWordBefore686,
    { face: b.store['deepamp:clock.mode681'], vis: b.store['deepamp:scope.mode'] });
  m.strip().props.onClick();
  m.commit(); await flush();
  check('T-749: and the press from the rolling mark steps to the whale mark -- that adjacency is unchanged by the '
      + 're-ordering. The clock face word keeps still on that press too - adding a mark to the visualizer ring does '
      + 'not make it a clock walk',
    b.store['deepamp:scope.mode'] === 'whale' && b.store['deepamp:clock.mode681'] === faceWordBefore686,
    { face: b.store['deepamp:clock.mode681'], vis: b.store['deepamp:scope.mode'] });
  m.strip().props.onClick();
  m.commit(); await flush();
  check('T-755: the press from the whale mark steps to the dancing llama, the entry the operator put last ("make '
      + 'dancing llama the last visualizer in the list"), and the clock face word keeps still on that press too',
    b.store['deepamp:scope.mode'] === 'llama' && b.store['deepamp:clock.mode681'] === faceWordBefore686,
    { face: b.store['deepamp:clock.mode681'], vis: b.store['deepamp:scope.mode'] });
  m.strip().props.onClick();
  m.commit(); await flush();
  check('T-686 as re-pointed by T-689, by T-746, by T-749 and again by T-755: a press on the canvas in a RUNNING visualizer walks the VISUALIZER and wraps '
      + 'to its first entry - the clock face word does not move. This is the operator\'s own line of that ruling: '
      + '"if visualizer is pressed, next visualizer, (as is)", and their earlier report is what it keeps fixed: '
      + '"klicking on the knight rider vis brings me to the clocks and keeps clocks instead of cycling vis to 1st". '
      + 'The wrap now comes from the last visualizer in the ring, which is the one the operator asked to put there',
    b.store['deepamp:clock.mode681'] === faceWordBefore686 && b.store['deepamp:scope.mode'] === 'spectrum',
    { face: b.store['deepamp:clock.mode681'], vis: b.store['deepamp:scope.mode'] });

  // T-689, the operator's report of 22:5x Berlin measured directly: "currently klicking on the delay-started-clock
  // in canvas does not cycle the clock face anymore". The take ends, the return delay runs out, and the idle canvas
  // answers the clock again - with the visualizer word still set to a real mode. The press must walk the CLOCK.
  const delay689 = /var SCOPE_CLOCK_RETURN_MS681 = (\d+);/.exec(src);
  const delayMs689 = delay689 ? parseInt(delay689[1], 10) : 5000;
  const realNow689 = Date.now;
  const base689 = Date.now();
  node689.paused = true; node689.ended = true;
  node689.fire('ended');
  m.commit(); await flush();
  Date.now = function () { return base689 + (delayMs689 + 1000); };
  let nClk689 = b.rectLog.length;
  m.strip().props.onClick();
  m.commit(); await flush();
  if (tick677b) tick677b();
  m.commit(); await flush();
  const clkWin689 = b.rectLog.slice(nClk689);
  Date.now = realNow689;
  check('T-689: a press on a clock the canvas answers because the take ended and the delay is out walks the CLOCK '
      + 'faces - the operator\'s line: "if i klick the clock face, the clock should cycle to next clock". The '
      + 'visualizer word does not move, and the next face is drawn: the Nixie glass, the struck wire and the foot '
      + 'rings are in this window, and the LED green is not',
    b.store['deepamp:clock.mode681'] === 'clock_nixie' && b.store['deepamp:scope.mode'] === 'spectrum'
      && clkWin689.filter(function (r689d) { return r689d[5] === '#150f08'; }).length >= 5
      && clkWin689.filter(function (r689e) { return r689e[5] === '#a45f1c'; }).length >= 5
      && clkWin689.filter(function (r689g) { return r689g[5] === '#3fb950'; }).length === 0,
    { face: b.store['deepamp:clock.mode681'], vis: b.store['deepamp:scope.mode'],
      glass: clkWin689.filter(function (r689h) { return r689h[5] === '#150f08'; }).length,
      ring: clkWin689.filter(function (r689i) { return r689i[5] === '#a45f1c'; }).length,
      led: clkWin689.filter(function (r689j) { return r689j[5] === '#3fb950'; }).length, drawn: clkWin689.length });
  // The walk back to the face the later windows stand on, still inside the same clock-answer: four further presses
  // carry the clock walk Nixie -> neon green tube -> flap -> inverted board -> LED, which is the wrap that window 4
  // pins in the other direction. (T-737 contract change, WM-31: the operator ruled that order - "order of clocks
  // should be 'nixie orange -> nixie green' while cycling" - and the press count is unchanged, because a five-face
  // walk started on its second face wraps in four presses whichever order the two tube palettes sit in.) The clock walk is not reached by pressing the row's control here, and the
  // visualizer word stays put through all of it. The fake clock moves past the return delay ahead of every press:
  // the panel stamps the moment it last saw something happening (scopeLastActive677), and a stamp taken at a faked
  // date would otherwise put the delay back in front of the next press.
  // (T-729 contract change, 2026-11-06: this walk was three presses long. The operator's ask - "add 'neon green
  // color variant'" - adds a fifth face to the walk, so it is four. The direction, the word and the delay rule
  // this window measures are unchanged.)
  let shift689 = delayMs689 + 1000;
  Date.now = function () { return base689 + shift689; };
  shift689 += delayMs689 + 1000; m.strip().props.onClick(); m.commit(); await flush();
  shift689 += delayMs689 + 1000; m.strip().props.onClick(); m.commit(); await flush();
  shift689 += delayMs689 + 1000; m.strip().props.onClick(); m.commit(); await flush();
  shift689 += delayMs689 + 1000; m.strip().props.onClick(); m.commit(); await flush();
  Date.now = realNow689;
  check('T-689: and the walk keeps walking in one direction from that face - four more presses reach the LED face '
      + 'again, and the visualizer word never moved on any of them',
    b.store['deepamp:clock.mode681'] === 'clock_led' && b.store['deepamp:scope.mode'] === 'spectrum',
    { face: b.store['deepamp:clock.mode681'], vis: b.store['deepamp:scope.mode'] });

  // Window 5 - the precedence rule, unchanged in meaning, reached with two controls instead of one word. A chosen
  // visualizer takes the canvas on a play action, and the clock returns after the named delay.
  const faceBox677 = m.els('audio-play-clock-face681')[0];
  if (faceBox677) { faceBox677.props.onClick(); }      // back to the Nixie face by the row's own cycle
  m.commit(); await flush();
  const node677c = m.armAudio(1);
  node677c.paused = false; node677c.ended = false;
  node677c.fire('play');
  m.commit(); await flush();
  let nPlay677 = b.rectLog.length;
  b.frames(1);
  const playWin677 = b.rectLog.slice(nPlay677);
  const clockWhilePlaying677 = playWin677.filter(function (r) { return r[5] === '#f6a23c'; });
  check('T-681: a play action takes the canvas back to the chosen visualizer - the clock face is not drawn while '
      + 'the transport is running, and neither word of the clock is touched by the play action',
    clockWhilePlaying677.length === 0 && b.store['deepamp:scope.mode'] === 'spectrum'
      && b.store['deepamp:clock.mode681'] === 'clock_nixie',
    { clock_drawn_while_playing: clockWhilePlaying677.length, vis: b.store['deepamp:scope.mode'],
      face: b.store['deepamp:clock.mode681'] });
  const delay677 = /var SCOPE_CLOCK_RETURN_MS681 = (\d+);/.exec(src);
  const delayMs677 = delay677 ? parseInt(delay677[1], 10) : 5000;
  const realDateNow677b = Date.now;
  const baseDate677b = Date.now();
  node677c.paused = true; node677c.ended = true;
  node677c.fire('ended');
  m.commit(); await flush();
  Date.now = function () { return baseDate677b + (delayMs677 + 1000); };
  let nBack677 = b.rectLog.length;
  if (tick677b) tick677b();
  m.commit(); await flush();
  const backWin677 = b.rectLog.slice(nBack677);
  Date.now = realDateNow677b;
  check('T-681: after the take ends the clock comes back - once the delay is out, the idle canvas answers the clock '
      + 'face again. The delay is the number the operator chose, read out of the client rather than guessed here',
    backWin677.some(function (r) { return r[5] === '#f6a23c'; })
      && backWin677.some(function (r) { return r[1] === 0 && r[3] === 80; }),
    { delay_ms: delayMs677, drawn: backWin677.length, nixie: backWin677.filter(function (r) { return r[5] === '#f6a23c'; }).length });

  // Window 6 - a visualizer set to OFF is not a target: the clock answers the canvas and a play action keeps it.
  // RE-POINTED 2026-10-29 by T-686: this window used to walk the ring eight times to land on `off`, and with the
  // clock on that walk now wraps to the first entry instead - the ring keeps `off` only when the clock is off, so
  // the state is built the honest way: the clock row's switch off, one walk to the ring's last word, the switch
  // back on. Same state as before, reached by the control the operator named.
  // RE-POINTED AGAIN 2026-11-07 by T-746: the ring holds one entry more, so the walk to its last word is nine
  // presses from a spectrum start. The state this window needs is the same state; the count moved.
  // RE-POINTED A THIRD TIME 2026-11-07 by T-749: the ring holds the whale mark, so the walk is ten presses. The
  // state is the same state again; only the count moves. What is asserted here has never been the count - it is
  // that a visualizer set to off is not a target and the clock answers the canvas.
  const specOff677 = m.els('audio-play-scope-mode531-spectrum')[0];
  if (specOff677) { specOff677.props.onClick(); }
  m.commit(); await flush();
  m.els('audio-play-clock-on681')[0].props.onClick();
  m.commit(); await flush();
  m.clickStrip(); m.clickStrip(); m.clickStrip(); m.clickStrip(); m.clickStrip(); m.clickStrip(); m.clickStrip(); m.clickStrip(); m.clickStrip(); m.clickStrip();
  m.els('audio-play-clock-on681')[0].props.onClick();
  m.commit(); await flush();
  const offMode677 = b.store['deepamp:scope.mode'];
  let nOffClock677 = b.rectLog.length;
  // The clock face is not a live mode, so it is the one-second tick that repaints it - the same reading window 1b
  // used. Asking the draw loop here would measure a loop that was never armed and would say nothing about the display.
  if (tick677b) tick677b();
  m.commit(); await flush();
  const offWin677 = b.rectLog.slice(nOffClock677);
  check('T-681: with the visualizer set off the clock is the display - the rule names the case, and an empty clock '
      + 'word never reaches for a default face',
    offMode677 === 'off' && b.store['deepamp:clock.on681'] === '1'
      && offWin677.some(function (r) { return r[5] === '#f6a23c'; }),
    { vis: offMode677, clock_on: b.store['deepamp:clock.on681'], face: b.store['deepamp:clock.mode681'],
      drawn: offWin677.filter(function (r) { return r[5] === '#f6a23c'; }).length });

  // Window 6b - the canvas clear on a clock draw, from the operator's screenshot of 22:2x Berlin (the LED clock
  // printed over a leftover llama silhouette) with their words: "looks like now you are missing to clear the canvas
  // on clock draw - so clock overdraws last visualizer or previous clock face on switch". The clear line was asked
  // with the VISUALIZER word, and since the separation the canvas can be showing something else entirely: the word
  // is still waterfall or llama while the clock owns the box, and those are exactly the two modes whose picture
  // the canvas, so the clear was skipped and the clock was drawn on top of a picture with no business there.
  const llamaName677 = m.els('audio-play-scope-mode531-llama')[0];
  if (llamaName677) { llamaName677.props.onClick(); }
  m.commit(); await flush();
  const realDateNow677d = Date.now;
  const baseDate677d = Date.now();
  Date.now = function () { return baseDate677d + (delayMs677 + 9000); };   // past the delay: the clock answers the box
  let nClear677 = b.rectLog.length;
  if (tick677b) tick677b();
  m.commit(); await flush();
  const clearWin677 = b.rectLog.slice(nClear677);
  Date.now = realDateNow677d;
  check('T-681, the operator named this one: a clock face starts on a clean canvas even when the stored visualizer '
      + 'word is one of the two modes that paint their history IN the canvas. The whole box is filled with the LCD '
      + 'ground before the face is drawn, so no leftover pixel survives the switch',
    b.store['deepamp:scope.mode'] === 'llama'
      && clearWin677.some(function (r) { return r[1] === 0 && r[3] === 80; })
      && clearWin677.some(function (r) { return r[5] === '#f6a23c'; }),
    { vis: b.store['deepamp:scope.mode'], face: b.store['deepamp:clock.mode681'],
      full_clear: clearWin677.filter(function (r) { return r[1] === 0 && r[3] === 80; }).length });
  teardown();

  // Window 7 - the migration, measured on a panel that stored a clock face in the OLD place. The operator's ruling
  // on the rename is the thing under test: the retired word is not aliased, it is invalid, and the panel says so.
  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'clock_letters' } });
  m = await mount(b, {
    canvas2d: true, audioTracks: 1, timer: timer677b,
    items: [{ id: 'ap-6771', fn: 'tts', kind: 'tts', status: 'ok', model: 'm1', voice: 'voy_janeway', duration: 3.44, text: 'the take' }],
  });
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush();
  check('T-681: a stored clock_letters is carried into the clock row and named invalid, not aliased - the clock is '
      + 'on and prints the default face, the visualizer word is off, and the panel prints one sentence about where '
      + 'the choice went rather than inventing a face quietly',
    b.store['deepamp:clock.on681'] === '1' && b.store['deepamp:clock.mode681'] === 'clock_led'
      && b.store['deepamp:scope.mode'] === 'off'
      && m.els('audio-play-clock-note681').length === 1
      && /clock_letters/.test(m.els('audio-play-clock-note681').map(m.ownText).join(' ')),
    { clock_on: b.store['deepamp:clock.on681'], face: b.store['deepamp:clock.mode681'],
      vis: b.store['deepamp:scope.mode'], note: m.els('audio-play-clock-note681').length });
  teardown();

  // ---------------- scenario N: the rate read-out, answered and unanswered (T-304, second half)
  // kbps and kHz are not things this panel can measure by itself - the browser is playing a file the lane
  // wrote, and only the lane can say what that file is. So the read-out prints dashes until an answer arrives,
  // and when one does the number is arithmetic off the answer, in the hover's own words: the PCM rate of the
  // file, not a compressed bitrate a WAV does not have.
  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'oscilloscope' } });
  m = await mount(b, {
    canvas2d: true, audioTracks: 1,
    items: [{ id: 'ap-3051', fn: 'tts', kind: 'tts', status: 'ok', model: 'm1', voice: 'voy_janeway', duration: 3.44, text: 'the take' }],
    peaks: pk, channels: 2, sampleRate: 48000, bytes: 165120,
  });
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush(); bag = m.commit(); await flush();
  const rateAtMount = m.els('audio-play-bitrate').map(m.ownText).pop();
  // T-318 (user 2026-10-13): "remove space between number and 'kHz' and number and 'kbps' - then it should
  // fit". T-396 (user 2026-10-15): "re-add spaces again between number and unit for 'XXX kbps' and ' YY kHz' in
  // player window". The one-line layout that T-318 asked for is kept; the spacing is back. The dashes, and what they
  // mean, are unchanged by either ruling.
  check('T-304: the rate read-out prints dashes before anything has been asked - it never guesses a number for '
      + 'a file it cannot measure',
    rateAtMount === '-- kbps  -- kHz', rateAtMount);
  const playBtnN = m.created().filter(function (e) {
    return e.type === 'button' && /play the row the transport is on/.test(String(e.props && e.props.title));
  }).pop();
  if (playBtnN) { playBtnN.props.onClick(); await flush(); m.commit(); await flush(); }
  m.armAudio(1);
  m.commit(); await flush();
  m.clickStrip();                                   // oscilloscope -> static, which reads the take
  await flush(); m.commit();
  const rateAnswered = m.els('audio-play-bitrate').map(m.ownText).pop();
  // 165120 bytes over 3.44 s is 384 kbit/s, and 48000 Hz is 48 kHz. Both numbers come from the lane's answer,
  // and the arithmetic is the one the hover claims - bytes times eight, over the duration it measured. The
  // spacing is T-318's: the unit is printed against the number, not beside it with a space.
  check('T-304: once the lane answers, the read-out carries its numbers - 384 kbps and 48 kHz for a 165120 '
      + 'byte, 3.44 s, 48 kHz take',
    rateAnswered === '384 kbps  48 kHz', rateAnswered);   // T-396: the spaces are back; the numbers and their source are unchanged
  const rateElN = m.els('audio-play-bitrate')[m.els('audio-play-bitrate').length - 1];
  check('T-304: the hover says what kind of number it is - the pulse-code modulation rate of the file the lane '
      + 'wrote, measured from that file\u2019s own header, and it names no route',
    /pulse-code modulation/.test(String(rateElN.props.title)) && /header/.test(String(rateElN.props.title))
      && !/wave_peaks|\/api\/|T-30\d/.test(String(rateElN.props.title)), rateElN.props.title);
  check('T-304: and the same answer lit the channel pair - stereo green, mono dark, both words printed',
    m.chanLit(m.els('audio-play-chan').pop(), 'audio-play-chan-stereo') === '#3fb950'
      && m.chanLit(m.els('audio-play-chan').pop(), 'audio-play-chan-mono') === '#555',
    m.chanPairText(m.els('audio-play-chan').pop()));
  // --- T-376 (user 2026-10-14, live panel): the clock band's click was being read as a press on the trace, so
  // the two click areas are now two ELEMENTS. The clock control sits on the band; the strip under it cycles.
  const hit376 = m.els('audio-play-clock-hit376');
  check('T-376: the dot-matrix clock has its own click control in the strip - exactly one, and it is not the canvas',
    hit376.length === 1 && hit376[0].type === 'span', [hit376.length, hit376[0] && hit376[0].type]);
  const strip376 = m.strip();
  check('T-376: the strip is a positioned box, which is what lets the clock control sit on the band instead of '
      + 'being a measurement of where a click landed',
    strip376 && strip376.props.style && strip376.props.style.position === 'relative',
    strip376 && strip376.props.style);
  const modeBefore376 = m.modeLabel();
  const storeBefore376 = b.store['deepamp:clock-remain'];
  hit376[0].props.onClick({ stopPropagation: function () {}, preventDefault: function () {} });
  m.commit(); await flush();
  const hit376b = m.els('audio-play-clock-hit376');
  check('T-376: pressing the clock switches the read-out and remembers it (time played -> time remaining)',
    b.store['deepamp:clock-remain'] === '1' && storeBefore376 !== '1',
    [storeBefore376, b.store['deepamp:clock-remain']]);
  check('T-376: and it did NOT cycle the visualizer - the mode the strip was in is the mode it is still in',
    m.modeLabel() === modeBefore376, [modeBefore376, m.modeLabel()]);
  hit376b[0].props.onClick({ stopPropagation: function () {}, preventDefault: function () {} });
  m.commit(); await flush();
  check('T-376: pressing it again comes back to time played',
    b.store['deepamp:clock-remain'] === '0', b.store['deepamp:clock-remain']);
  // T-377 (user 2026-10-14, live panel): "the countdown should show a '-' in front". The band is drawn as dots,
  // so the minus is measurable the same way a digit is: one matrix glyph is 5 x 7 cells = 35 fillRects, lit or
  // not, because a dot matrix paints the unlit dots too. Countdown mode must draw exactly one glyph more than
  // the position-only read-out, and that glyph is the minus.
  // T-377 (user 2026-10-14, live panel): "the countdown should show a '-' in front". Both readings below are
  // taken from a paint the clock control itself triggered, so the two bands are the same band in the two modes
  // and nothing else can account for the difference. A dot matrix glyph is 5 x 7 cells = 35 fillRects, because
  // an unlit dot is still painted - that is what makes it a matrix and not a segment display.
  const lit377 = function (w) { return w.filter(function (r377) { return r377[5] === '#3fb950'; }).length; };
  // T-385 (user 2026-10-14, the stream ruling) moved this phase's precondition out of the fixture and into the open: a
  // countdown needs a LENGTH, and the panel now treats an unknown length as no length rather than turning it into a
  // confident zero or an Infinity it cannot print. So the fixture states what the countdown is asked to count down —
  // 12 s of take with 6 s of it already heard, so the countdown and the position print the SAME digits and the only
  // difference between the two bands is the minus. A fixture that changes the number it is comparing is not a fixture.
  const node377 = m.armAudio(1);
  const cur0377 = node377.currentTime, dur0377 = node377.duration;
  node377.duration = 12;
  node377.currentTime = 6;
  if (typeof node377.ontimeupdate === 'function') node377.ontimeupdate();
  m.commit(); await flush();
  let nA377 = b.rectLog.length;
  m.els('audio-play-clock-hit376')[0].props.onClick({ stopPropagation: function () {}, preventDefault: function () {} });
  m.commit(); await flush();
  const bandCount377 = b.rectLog.slice(nA377).filter(function (r) { return r[4] === 0 && r[1] < 24; });
  let nB377 = b.rectLog.length;
  m.els('audio-play-clock-hit376')[0].props.onClick({ stopPropagation: function () {}, preventDefault: function () {} });
  m.commit(); await flush();
  const bandPos377 = b.rectLog.slice(nB377).filter(function (r) { return r[4] === 0 && r[1] < 24; });
  check('T-377: the countdown prints a minus in front of the remaining time - the countdown band draws exactly '
      + 'one matrix glyph (35 dots) more than the position-only band, and the digits themselves are unchanged',
    bandCount377.length === bandPos377.length + 35, [bandPos377.length, bandCount377.length]);
  check('T-377: and that glyph is LIT - five green dots appear in the countdown band that are not in the '
      + 'position band, which is a minus drawn in the same matrix as the digits, not a blank cell',
    lit377(bandCount377) === lit377(bandPos377) + 5, [lit377(bandPos377), lit377(bandCount377)]);

  // T-385 (user 2026-10-14): the other half of the same rule. A live stream reports its length as Infinity or NaN.
  // The band must not invent a countdown for it and must not print a confident zero: with no known length the
  // countdown band IS the position band, glyph for glyph and lit dot for lit dot.
  node377.duration = Infinity;
  if (typeof node377.ontimeupdate === 'function') node377.ontimeupdate();
  m.commit(); await flush();
  let nU385 = b.rectLog.length;
  m.els('audio-play-clock-hit376')[0].props.onClick({ stopPropagation: function () {}, preventDefault: function () {} });
  m.commit(); await flush();
  const bandCountU385 = b.rectLog.slice(nU385).filter(function (r) { return r[4] === 0 && r[1] < 24; });
  let nU385b = b.rectLog.length;
  m.els('audio-play-clock-hit376')[0].props.onClick({ stopPropagation: function () {}, preventDefault: function () {} });
  m.commit(); await flush();
  const bandPosU385 = b.rectLog.slice(nU385b).filter(function (r) { return r[4] === 0 && r[1] < 24; });
  check('T-385: with no known length the countdown band is the position band — no minus, no invented digits, no confident zero',
    bandCountU385.length === bandPosU385.length && lit377(bandCountU385) === lit377(bandPosU385),
    [bandPosU385.length, bandCountU385.length, lit377(bandPosU385), lit377(bandCountU385)]);
  // Put the node back the way this phase found it. The checks after this one read the same node, and a fixture that
  // leaves its props changed for the next phase is a fixture that fails for the wrong reason later.
  node377.duration = dur0377;
  node377.currentTime = cur0377;
  if (typeof node377.ontimeupdate === 'function') node377.ontimeupdate();
  m.commit(); await flush();

  m.clickStrip();
  check('T-376: the rest of the strip still cycles the visualizer - the cycle area is the trace, exactly as the '
      + 'ruling says it should now be smaller',
    m.modeLabel() !== modeBefore376, [modeBefore376, m.modeLabel()]);

  teardown();

  // ---------------- scenario N: the VU pair on a MONO source, and the ballistics of a meter (T-445)
  // The user ruling, verbatim: "show 2, but mirror movement, remove R and L labels if mono". A mono take has one
  // channel; the answer is two meters that move together and neither of them lettered — not a blank half-strip,
  // and not one meter pretending to be two.
  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'oscilloscope' } });
  b.tdAmpR = 0; b.tdRippleAmpR = 0;             // the splitter's second output answers nothing: this take is mono
  m = await mount(b, { canvas2d: true, audioTracks: 1 });
  m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  m.commit(); await flush(); m.commit(); await flush();
  m.armAudio(1);
  m.clickStrip(); m.commit();                   // oscilloscope -> waveform
  m.clickStrip(); m.commit();                   // waveform -> the LED bars (T-755 put them here)
  m.clickStrip(); m.commit();                   // the LED bars -> the segmented VU ladder (this arms the tap)
  check('T-445: a VU mode reached by the cycle arms the tap from the playing element (the graph is built on the click)',
    m.modeLabel() === 'VU meters \u2014 segmented ladder' && b.ctxBuilt === 1, [m.modeLabel(), b.ctxBuilt]);
  check('T-445 source: the mono answer for the meters comes from the tap own stereo read, not from a guess',
    /scopeVuFrame345\(g, W, H, m, st345, !t\.stereo\)/.test(src), 'mono read is the tap read');
  const monoStart445 = b.rectLog.length;
  b.frames(14);
  const monoFrame445 = b.rectLog.slice(monoStart445);
  const litTop445 = monoFrame445.filter(function (r) { return (r[5] === '#00c800' || r[5] === '#ffd800' || r[5] === '#e8320f') && r[3] >= 20 && r[1] <= 30; }).length;
  const litBot445 = monoFrame445.filter(function (r) { return (r[5] === '#00c800' || r[5] === '#ffd800' || r[5] === '#e8320f') && r[3] >= 20 && r[1] >= 41; }).length;
  check('T-445: on a mono source BOTH meters move, and they move the same amount (the right meter mirrors the left)',
    litTop445 > 0 && litTop445 === litBot445, [litTop445, litBot445]);
  check('T-445: and neither meter is lettered on a mono source — no L in the upper face, no R in the lower one',
    monoFrame445.filter(function (r) { return r[5] === '#9fe89f' && r[2] === 1 && r[3] === 1 && r[1] <= 8; }).length === 0
      && monoFrame445.filter(function (r) { return r[5] === '#9fe89f' && r[2] === 1 && r[3] === 1 && r[1] >= 41 && r[1] <= 48; }).length === 0,
    [monoFrame445.filter(function (r) { return r[5] === '#9fe89f' && r[1] <= 8; }).length]);
  // The ballistics, measured as a fall rather than as a formula. The harness feed goes silent at a known frame;
  // what has to follow is a meter that drops fast where its peak-hold mark is, holds where its needle is, and
  // does reach the floor in the end.
  b.silent = true;
  b.frames(3);
  const after3_445 = b.rectLog.slice(b.rectLog.length - 320);
  check('T-445: three frames after the sound stops the meter is STILL holding most of its level — a VU meter releases slowly (900 ms), it does not snap',
    after3_445.filter(function (r) { return r[5] === '#00c800' && r[3] >= 20; }).length >= 4,
    after3_445.filter(function (r) { return r[5] === '#00c800' && r[3] >= 20; }).length);
  b.frames(9);
  const after12_445 = b.rectLog.slice(b.rectLog.length - 320);
  check('T-445: while its level still holds, the peak-hold mark has already fallen off the scale (0.9 dB per drawn frame)',
    after12_445.filter(function (r) { return r[5] === '#00c800' && r[3] >= 20; }).length > 0
      && after12_445.filter(function (r) { return r[5] === '#e8e8e8'; }).length === 0,
    [after12_445.filter(function (r) { return r[5] === '#00c800' && r[3] >= 20; }).length,
     after12_445.filter(function (r) { return r[5] === '#e8e8e8'; }).length]);
  b.frames(259);
  const lastFrameStart445 = b.rectLog.length;
  b.frames(1);
  const lastFrame445 = b.rectLog.slice(lastFrameStart445);
  check('T-445: the loop is still drawing at the end of that run (the meter was measured, not the loop dying)',
    lastFrame445.length > 40, lastFrame445.length);
  check('T-445: and a silence long enough does bring the meter to the bottom of its scale — it parks at the floor, it does not freeze',
    lastFrame445.filter(function (r) { return r[5] === '#00c800' && r[3] >= 20; }).length === 0,
    lastFrame445.filter(function (r) { return r[5] === '#00c800' && r[3] >= 20; }).length);
  check('T-445 source: a VU mode with no tap throws its integration away instead of showing the last take memory',
    /scopeVu345\.current = null; scopeVuT345\.current = 0;/.test(src), 'no stale meter');
  check('T-445 source: the ballistics are constants chosen once, not per-look tuning',
    /var VU_ATTACK345 = 0\.010;/.test(src) && /var VU_RELEASE345 = 0\.900;/.test(src), 'attack and release pinned');
  teardown();

  // ---------------------------------------------------------------- scenario T-429: honest bins, no labels
  // T-429 (user ruling 2026-10-16): "make the mapping honest … do not label". Measured before the change: at
  // fftSize 1024 the bin width is 46.875 Hz on a 48 kHz context, and the first three log bands (31-42.3, 42.3-57.7,
  // 57.7-78.7 Hz) are all NARROWER than one bin, so bars 1, 2 and 3 each snapped onto bin 1 and drew the identical
  // 47-94 Hz slice. These runs drive the analyser with ONE hot bin so the answer cannot be read two ways: the old
  // map lights three bars for bin 1, the chained map lights one.
  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'spectrum' } });
  m = await mount(b, { canvas2d: true, audioTracks: 1 });
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush();
  const node429 = m.armAudio(1);
  node429.fire('timeupdate');
  m.commit();
  // Measured geometry (this run, live from the fake canvas): a bar is 8.85 px wide after the T-428 inset, spaced
  // 9.85 px apart, and it is STACKED from segments 2-3 px tall — a lit bar is several green (#00c800) segments on
  // the same x, and the unlit part of the same bar is drawn in #e8e8e8. So a bar is counted by summing its green
  // segments per x, not by looking for one tall rect.
  const tallBars429 = function () {
    const by = {};
    b.rectLog.forEach(function (r) {
      if (r[5] === '#00c800' && r[2] >= 4 && r[2] <= 12) {
        const k = r[0].toFixed(2);
        by[k] = (by[k] || 0) + r[3];
      }
    });
    return Object.keys(by).filter(function (k) { return by[k] >= 5; }).map(Number).sort(function (p, q) { return p - q; });
  };
  const runOne429 = function (bins) {
    b.rectLog.length = 0;
    b.hotBins = bins;
    b.frames(1);
    return tallBars429();
  };
  const wide429 = runOne429(null);          // the default answer: bins 0..39 hot
  const b1 = runOne429([1]);
  const b2 = runOne429([2]);
  const b3 = runOne429([3]);
  const bHi = runOne429([80]);              // 3.75 kHz on a 48 kHz context: a bar further right, not a low one
  check('T-429: one hot FFT bin lights ONE bar, not three — the old map put 31-42, 42-58 and 58-79 Hz all onto bin 1, so bars 1, 2 and 3 drew the same 47-94 Hz measurement side by side',
    b1.length === 1 && b2.length === 1 && b3.length === 1, { bin1: b1, bin2: b2, bin3: b3 });
  check('T-429: bins 1, 2 and 3 light three DIFFERENT bars, left to right — every bar owns its own slice of the spectrum and no bin is shown twice',
    b1.length === 1 && b2.length === 1 && b3.length === 1 && b1[0] < b2[0] && b2[0] < b3[0],
    [b1[0], b2[0], b3[0]]);
  check('T-429: a bin up at 3.75 kHz lights a bar to the RIGHT of the low three, so the strip still reads low to high across the canvas',
    bHi.length === 1 && bHi[0] > b3[0], { hi: bHi, low: [b1[0], b2[0], b3[0]] });
  check('T-429: the strip is not shortened or thinned by the change — a full low spectrum still lights most of the 20 bars',
    wide429.length >= 12, wide429.length);
  check('T-429: no axis labels were added — the ruling was an honest mapping, not a frequency scale; the strip draws bars and their caps and no text',
    b.fillTexts === 0, b.fillTexts);
  check('T-429 source: the band map chains each band to where the previous one ended, and stops when the analyser runs out of bins',
    /var prevEnd300 = 1;/.test(src)
    && /var i0 = Math\.max\(prevEnd300, Math\.max\(1, Math\.floor\(f0 \/ binHz\)\)\);/.test(src)
    && /prevEnd300 = i1;/.test(src)
    && /if \(prevEnd300 >= binCount\) break;/.test(src), 'no chain');
  teardown();

  // ---------------------------------------------------------------- scenario T-441: the volume curve
  // T-441 (user ruling 2026-10-16): "Default stays linear, log is opt-in". The panel has always written the slider
  // straight onto HTMLMediaElement.volume. These runs read the amplitude the media element ACTUALLY received, off the
  // host node the panel holds a ref to — not off the slider's own value, which is a position, not a sound.
  const byCls441 = function (mm, cls) {
    return (mm.created() || []).filter(function (e) { return e && e.props && String(e.props.className || '') === cls; });
  };
  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'off' } });
  m = await mount(b, { canvas2d: true, audioTracks: 1 });
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush();
  const nodeA441 = m.armAudio(1);
  const sliderA441 = byCls441(m, 'audio-play-vol')[0];
  sliderA441.props.onInput({ target: { value: '0.5' } });
  m.commit();
  check('T-441: the default is LINEAR — half the slider is half the amplitude, exactly what this panel has done since the strip existed, with nothing to switch on first',
    Math.abs(Number(nodeA441.volume) - 0.5) < 1e-9 && b.store['deepamp:vol.log'] === undefined,
    { elementVolume: nodeA441.volume, stored: b.store['deepamp:vol.log'] });
  const lab441 = byCls441(m, 'audio-play-vol-log441')[0];
  // The class sits on the LABEL (the hover is the label's), and the checkbox is its child — the same shape the
  // T-208 machine-ceiling line uses, so the lookup is the same lookup.
  const box441 = (function () {
    if (!lab441) return null;
    return (lab441.props.children || []).filter(function (c) { return c && c.type === 'input'; })[0] || null;
  })();
  check('T-441: the Settings line exists, its checkbox is OFF by default, and both curves are explained in its hover rather than as permanent panel text',
    !!lab441 && !!box441 && !box441.props.checked && /half the slider is half the amplitude/.test(String((lab441 || {}).props.title || ''))
    && /100x in amplitude/.test(String((lab441 || {}).props.title || '')),
    { label: !!lab441, input: !!box441, checked: box441 && box441.props.checked });
  box441.props.onChange({ target: { checked: true } });
  m.commit();
  check('T-441: switching the taper mid-play changes what is AUDIBLE at once — the stored position is re-applied through the new curve, so 0.5 becomes 0.090909 (-20.8 dB) without touching the slider',
    Math.abs(Number(nodeA441.volume) - 0.09090909090909091) < 1e-9
    && String(byCls441(m, 'audio-play-vol')[0].props.value) === '0.5'
    && b.store['deepamp:vol.log'] === '1',
    { elementVolume: nodeA441.volume, sliderValue: byCls441(m, 'audio-play-vol')[0].props.value, stored: b.store['deepamp:vol.log'] });
  teardown();
  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'off', 'deepamp:vol.log': '1' } });
  m = await mount(b, { canvas2d: true, audioTracks: 1 });
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush();
  const nodeB441 = m.armAudio(1);
  const sl2 = byCls441(m, 'audio-play-vol')[0];
  const slMini2 = byCls441(m, 'audio-play-vol312')[0];
  sl2.props.onInput({ target: { value: '0.75' } });
  m.commit();
  check('T-441: the taper survives a reload — a page that starts with the setting on maps 0.75 to 0.309321 (-10.2 dB) on the media element, and the Settings checkbox starts checked',
    Math.abs(Number(nodeB441.volume) - 0.3093209757745838) < 1e-9
    && (function () {
      const labR = byCls441(m, 'audio-play-vol-log441')[0];
      const inpR = labR ? (labR.props.children || []).filter(function (c) { return c && c.type === 'input'; })[0] : null;
      return !!(inpR && inpR.props.checked);
    })(),
    { elementVolume: nodeB441.volume });
  sl2.props.onInput({ target: { value: '0.25' } });
  m.commit();
  check('T-441: and 0.25 is 0.021841 (-33.2 dB), not 0.25 — the bottom of the slider is spent on the quiet end, which is the whole point of a taper',
    Math.abs(Number(nodeB441.volume) - 0.02184118848654929) < 1e-9, nodeB441.volume);
  if (slMini2) {
    slMini2.props.onInput({ target: { value: '0.5' } });
    m.commit();
  }
  check('T-441: ONE setting governs BOTH sliders — the player strip slider and the mini-header slider are the same control on the same state (two call sites, one handler, one curve flag in both hovers), so they cannot disagree about what half the slider means',
    (function () {
      const wired = (src.match(/onInput: setPlayVol300/g) || []).length === 2
        && (src.match(/\(volLog441v \? /g) || []).length === 2;
      const heard = slMini2 ? Math.abs(Number(nodeB441.volume) - 0.09090909090909091) < 1e-9 : true;
      return wired && heard;
    })(), { miniFound: !!slMini2, miniVolume: nodeB441.volume });
  check('T-441 source: the curve is one pure function with the 100x taper formula, not a per-look tweak at the call sites',
    /function volAmplitude441\(v, logOn\)/.test(src) && /return \(Math\.pow\(100, p\) - 1\) \/ 99;/.test(src)
    && /a\.volume = volAmplitude441\(v, volLog441v\)/.test(src) && /a441\.volume = volAmplitude441\(playVol, !!on\)/.test(src),
    'no single door');
  teardown();

  // ---- T-506 part 2 (user 2026-10-16: "add a toggle switch for each vis mode in a space saving toggle box
  // table", ruled into Settings): one switch per visual mode, each tuned to what that mode actually does ----
  // Two fresh mounts of the SAME wave, differing only in what the persisted table says about the ladder mode. A
  // fresh meter starts at the floor and attacks up (10 ms), so each mount settles on its own reference and the
  // drawing answers which one it used: 17 lit segments of 48 on the peak reference, 6 on the RMS one.
  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'off' } });
  m = await mount(b, { canvas2d: true, audioTracks: 1 });
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush();
  m.armAudio(1);
  m.clickStrip(); m.commit(); m.clickStrip(); m.commit(); m.clickStrip(); m.commit(); m.clickStrip(); m.commit();
  m.clickStrip(); m.commit();
  check('T-506b setup, re-pointed by T-755: the proven walk off -> spectrum -> oscilloscope -> static -> LED bars '
      + '-> the segmented ladder',
    m.modeLabel() === 'VU meters \u2014 segmented ladder', m.modeLabel());
  b.frames(39);
  const s546a = b.rectLog.length; b.frames(1);
  const frame546a = b.rectLog.slice(s546a);
  const litL546a = frame546a.filter(function (r) { return r[3] >= 20 && r[1] <= 30
    && (r[5] === '#00c800' || r[5] === '#ffd800' || r[5] === '#e8320f'); }).length;
  check('T-506b DEFAULT: a page that has never been switched on reads the ladder at its PEAK reference (13 of 38 segments after T-516)',
    litL546a === 13, litL546a);
  check('T-506b: nothing is written to storage until a person touches a box (a default page stores no levels key)',
    b.store['deepamp:scope.levels'] === undefined, b.store['deepamp:scope.levels']);
  const box546 = byClsOne546(m, 'audio-play-scope-level346-vu_led')[0];
  const allBoxes546 = byClsOne546(m, 'audio-play-scope-level346');
  const boxWords546 = function (e) { return e ? String(m.ownText(e) || '') : ''; };
  check('T-506b: the toggle box table is in Settings with ONE box per mode that has a choice, each carrying the word it is on',
    // RE-POINTED 2026-11-07 by T-750 (operator: "we can remove the DB/log setting as a button and pin the plugins
    // to the db setting, (keep code but config to dB) - log shows no action"): the spectrum row is pinned to dB, so
    // it has no box - and no printed word in its place either, which is the ruling the panel already carries for
    // the waterfall row. Four boxes remain, one per mode that still has two words. "ONE box per mode" is the half
    // of this pin that has not moved: no mode has two boxes, and a mode with no choice has none.
    // RE-POINTED AGAIN 2026-11-11 by T-788 (operator: "remove option to switch between amp and dB - fix to amp in
    // the background"): the waveform joins the pinned rows, so three boxes remain. "ONE box per mode that has a
    // choice, and none for a mode that has none" is the half of this pin that has not moved by one character.
    SCOPE546_MODES.filter(function (mm) { return !!byClsOne546(m, 'audio-play-scope-level346-' + mm)[0]; }).length === 3
    && byClsOne546(m, 'audio-play-scope-level346-spectrum').length === 0
    && byClsOne546(m, 'audio-play-scope-level346-static').length === 0
    && boxWords546(box546) === 'peak', { boxes: allBoxes546.length, vuWord: boxWords546(box546), tip: tipOf546(box546).slice(0, 60) });
  check('T-506b: the mode that draws nothing has no switch (off is not a level question)',
    byClsOne546(m, 'audio-play-scope-level346-off').length === 0, byClsOne546(m, 'audio-play-scope-level346-off').length);
  check('T-506b: every default is what that mode did before this card, except the two VU faces the user just ruled',
    // RE-POINTED 2026-11-07 by T-750 (operator: "we can remove the DB/log setting as a button and pin the plugins
    // to the db setting, (keep code but config to dB) - log shows no action"). The spectrum's default is still dB
    // and dB is still what the mode draws - that is measured through the drawing in the T-506b / T-539 pair below,
    // unchanged. What changed is that the panel no longer prints the word, because a pinned mode has no choice to
    // show and the panel's own ruling for the waterfall row says a printed value nothing can change is clutter. So
    // the default is read here from the vocabulary the table is built from, which is what a pinned mode actually
    // answers, and the row is checked to print nothing.
    // RE-POINTED AGAIN 2026-11-11 by T-788 (operator: "remove option to switch between amp and dB - fix to amp in
    // the background", the same form T-750 ruled for the spectrum: "keep code but config to dB"). The waveform's
    // default is read the way the spectrum's is read here - from the vocabulary the table is built from, which is
    // what a pinned mode actually answers - and the row is checked to print no box in its place. The amp SPACING is
    // still what the mode draws and it is measured through the drawing in the T-506b / T-539 pair, unchanged.
    /spectrum:\s*\{ words: \["dB"\], def: "dB"/.test(src)
    && /static:\s*\{ words: \["amp"\], def: "amp"/.test(src)
    && byClsOne546(m, 'audio-play-scope-level346-spectrum').length === 0
    && byClsOne546(m, 'audio-play-scope-level346-static').length === 0
    && boxWords546(byClsOne546(m, 'audio-play-scope-level346-oscilloscope')[0]) === 'gain'
    && boxWords546(byClsOne546(m, 'audio-play-scope-level346-vu_needle')[0]) === 'peak',
    SCOPE546_MODES.map(function (mm) { return mm + '=' + boxWords546(byClsOne546(m, 'audio-play-scope-level346-' + mm)[0]); }));
  check('T-506b: the hover of a box says what its two words mean in user words, not what the code calls them',
    /peak of its own channel/.test(tipOf546(box546)) && !/vuPeakDb345|scopeLevel346|T-506/.test(tipOf546(box546)),
    tipOf546(box546).slice(0, 130));
  box546.props.onClick();
  m.commit();
  check('T-506b: one click on a box switches THAT mode only, and the choice is stored as one table',
    // RE-POINTED 2026-11-07 by T-750: the spectrum row has no box to read a word from, so the "that mode only"
    // half is measured by the spectrum keeping no box of its own while a press on the VU row changes only the VU
    // row. The stored table is unchanged in shape and still names every mode, pinned ones included - the operator's
    // "keep code but config to dB" is exactly this: the table and its getter still run, the words they accept are
    // what the card of 2026-11-07 pinned.
    boxWords546(byClsOne546(m, 'audio-play-scope-level346-vu_led')[0]) === 'rms'
    && boxWords546(byClsOne546(m, 'audio-play-scope-level346-vu_needle')[0]) === 'peak'
    && byClsOne546(m, 'audio-play-scope-level346-spectrum').length === 0
    && /"vu_led":"rms"/.test(String(b.store['deepamp:scope.levels'])),
    { stored: b.store['deepamp:scope.levels'] });
  // T-535 (user 2026-10-17, verbatim): "the Names in the setting section (now green if active) should be
  // underscored and ONKLICK should set this visualizer active -> remove click the box to switch that mode...".
  // The name press is pinned where it matters: it names a mode, it moves the strip to that mode, and the underline
  // travels with the mode rather than being painted on whatever row the test happened to look at.
  const nameSpectrum535 = m.els('audio-play-scope-mode531-spectrum')[0];
  const nameActive535 = m.els('audio-play-scope-mode531-vu_led')[0];
  check('T-535: every visual mode has a name press in Settings and off has none (there is nothing to make active)',
    SCOPE546_MODES.filter(function (mm) { return !!m.els('audio-play-scope-mode531-' + mm)[0]; }).length === 5
    && m.els('audio-play-scope-mode531-off').length === 0,
    { presses: m.els('audio-play-scope-mode531').length });
  check('T-535: the underline and the green sit on the row naming the mode the strip is drawing, and on no other row',
    !!(nameActive535 && nameSpectrum535)
    && nameActive535.props.style.textDecoration === 'underline' && nameActive535.props.style.color === '#00c800'
    && nameSpectrum535.props.style.textDecoration === 'none' && nameSpectrum535.props.style.color === 'inherit',
    { active: nameActive535 && nameActive535.props.style.textDecoration, other: nameSpectrum535 && nameSpectrum535.props.style.textDecoration });
  nameSpectrum535.props.onClick();
  m.commit();
  check('T-535: pressing a name makes THAT visualizer active - the mode moves, the choice is persisted, and the underline moves with it',
    m.modeLabel() === 'spectrum analyser' && b.store['deepamp:scope.mode'] === 'spectrum'
    && m.els('audio-play-scope-mode531-spectrum')[0].props.style.textDecoration === 'underline'
    && m.els('audio-play-scope-mode531-vu_led')[0].props.style.textDecoration !== 'underline',
    { label: m.modeLabel(), stored: b.store['deepamp:scope.mode'] });
  // The measured note line after a name press was "idle", and the honest reading is that the note reports what the
  // strip is DRAWING, not that a mode was chosen - with no sound running the strip is idle whichever mode is on. A
  // behaviour pin on it would measure the fixture. What this card actually depends on is that there is ONE body for
  // changing the visualizer, so the name press cannot grow a second, weaker switch path beside the strip press. That
  // is a fact about the source, and the source is what says it.
  const s535 = require('fs').readFileSync(TARGET, 'utf8');
  // T-542: the body grew, the window grew with it. GROWN AGAIN 2026-11-07 by T-746: entering the rolling mark
  // drops the roll and the band cache it inherits from the mode before it, which is the same rule the llama's
  // baseline drop states, so the body is 3 210 characters and 40 lines on a measured read. The window is 3 600.
  // RE-POINTED 2026-11-07 by T-750 and T-748: the body grew by the marks' entry reset (a rolling mark has to be
  // re-set where it joins, or it draws from wherever the other mark left it), and this window is a SCAN bound, not
  // a claim about how long the body may be — the lazy match stops at the first line that closes this function, so
  // a wider bound cannot overrun the body, it can only reach it. Measured on the file as it now stands: the header
  // to that closing brace is 3666 characters.
  const body535 = (s535.match(/function applyScopeMode531\(next\) \{[\s\S]{0,4200}?\n      \}/) || [''])[0];
  check('T-535 source: there is ONE body for changing the visualizer - the strip press delegates to it and the name press calls it, so a name press runs the tap arming, the note and the loop sync rather than a weaker path',
    (s535.match(/function applyScopeMode531\(/g) || []).length === 1
    // RE-POINTED 2026-10-28 by T-677, then by T-681, again 2026-10-29 by T-686, and again by T-689 the same day
    // (the operator's three press targets: the walk asks the face the canvas is answering, which is the one question
    // the paint path already asks). The pin is unchanged
    // in meaning: the strip press reaches the one body through its single delegate line, and the body of the press
    // contains no mode change of its own - no store, no tap arming, no loop sync. What it names now is the other
    // half of the rule as it stands: the press asks which vocabulary the canvas is answering before it delegates.
    && (function () {
      const atC535 = s535.indexOf('function cycleScope300()');
      if (atC535 < 0) return false;
      const bodyC535 = s535.slice(atC535, s535.indexOf('\n      }', atC535));
      // RE-POINTED 2026-10-29 by T-686 (the walk resolves the next word before it delegates, because the ring skips
      // `off` when the clock is on), and by T-689: the gate ahead of it asks the canvas, in the one predicate the
      // paint path uses, and no longer the stored visualizer word. Same meaning, and stricter about the one body.
      return (bodyC535.match(/applyScopeMode531\(nxt686\);/g) || []).length === 1
        && !/lsSet\(LS_SCOPE_MODE/.test(bodyC535)
        && !/scopeArmTap300\(/.test(bodyC535)
        && !/scopeSyncLoop300\(/.test(bodyC535)
        && /scopeFaceNow681\(\) === "clock"/.test(bodyC535)
        && !/scopeModeRef300\.current === "off"/.test(bodyC535);
    })()
    && /onClick: function \(\) \{ applyScopeMode531\(mode346\); \}/.test(s535)
    && /lsSet\(LS_SCOPE_MODE, next\)/.test(body535)
    && /scopeArmTap300\(\)/.test(body535)
    && /scopeSyncLoop300\(\)/.test(body535),
    { definitions: (s535.match(/function applyScopeMode531\(/g) || []).length, body_lines: body535.split('\n').length });
  check('T-535: the sentence the user asked to remove is gone from the panel - the press carries the meaning now',
    !m.created().some(function (e535) { return /click the box to switch that mode/.test(String((e535.props || {}).children || '')); }),
    m.created().filter(function (e535) { return /switch that mode/.test(String((e535.props || {}).children || '')); }).length);
  teardown();
  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'off', 'deepamp:scope.levels': '{"vu_led":"rms"}' } });
  m = await mount(b, { canvas2d: true, audioTracks: 1 });
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush();
  m.armAudio(1);
  // Five presses reach the ladder from a fresh page now (T-755 put the LED bars on this path). The walk is a
  // setup; the measurement is the same ladder on the same stored RMS word it was measured on before.
  m.clickStrip(); m.commit(); m.clickStrip(); m.commit(); m.clickStrip(); m.commit(); m.clickStrip(); m.commit();
  m.clickStrip(); m.commit();
  b.frames(39);
  const s546b = b.rectLog.length; b.frames(1);
  const litL546b = b.rectLog.slice(s546b).filter(function (r) { return r[3] >= 20 && r[1] <= 30
    && (r[5] === '#00c800' || r[5] === '#ffd800' || r[5] === '#e8320f'); }).length;
  check('T-506b: the switch is not a label - a page stored with the ladder on RMS lights 5 segments on the same wave, where the default lights 13 (T-516 re-measured from 6 / 17)',
    litL546b === 5, [litL546b, litL546a]);
  check('T-506b: a stored table that names only one mode is completed from the defaults, not left half-restored',
    // RE-POINTED 2026-11-07 by T-750: the spectrum row prints no word to read, so the completion is measured on
    // two rows that do have boxes - the one the stored table names comes back as stored, and one it does not name
    // comes back at its default. Same claim, and it now measures both halves on cells that exist.
    // RE-POINTED AGAIN 2026-11-11 by T-788: the waveform row prints no word to read either, so both halves of this
    // claim are measured on the two rows that still answer - the one the stored table names comes back as stored,
    // the one it does not name comes back at its default. The table the code completes still names every mode,
    // pinned ones included, and the waveform is pinned by its own vocabulary, not by a half-restored value.
    boxWords546(byClsOne546(m, 'audio-play-scope-level346-vu_led')[0]) === 'rms'
    && boxWords546(byClsOne546(m, 'audio-play-scope-level346-oscilloscope')[0]) === 'gain'
    && byClsOne546(m, 'audio-play-scope-level346-static').length === 0, b.store['deepamp:scope.levels']);
  teardown();
  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'off', 'deepamp:scope.levels': 'not json at all' } });
  m = await mount(b, { canvas2d: true, audioTracks: 1 });
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush();
  check('T-506b: a corrupted stored table falls back to every default instead of drawing a half-known setting',
    // RE-POINTED AGAIN 2026-11-11 by T-788, for the same reason as the pin above: the two rows that carry a reading
    // this card or T-750 pinned print nothing, so the fallback is measured where a cell exists.
    boxWords546(byClsOne546(m, 'audio-play-scope-level346-vu_led')[0]) === 'peak'
    && boxWords546(byClsOne546(m, 'audio-play-scope-level346-oscilloscope')[0]) === 'gain'
    && byClsOne546(m, 'audio-play-scope-level346-static').length === 0, b.store['deepamp:scope.levels']);
  teardown();
  // The bar meter: the same hot bin, two spacings. dB spreads the analyser window over the bar; amp asks what
  // amplitude that dB really is, which is what the measured caution says makes quiet material smaller.
  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'off' } });
  m = await mount(b, { canvas2d: true, audioTracks: 1 });
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush();
  m.armAudio(1);
  // The hot bin is chosen BEFORE the mode is entered, and the drawing log is cleared right before the measured
  // frame: the frame being counted is the first frame this bar meter ever saw for this data, so no peak-hold
  // residue from a frame drawn before the seam can be read as level.
  b.hotBins = [4];
  m.clickStrip(); m.commit();
  b.rectLog.length = 0;
  b.frames(1);
  const topDb546 = scopeBarTally546(b);
  teardown();
  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'off', 'deepamp:scope.levels': '{"spectrum":"log"}' } });
  m = await mount(b, { canvas2d: true, audioTracks: 1 });
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush();
  m.armAudio(1);
  b.hotBins = [4];
  m.clickStrip(); m.commit();
  b.rectLog.length = 0;
  b.frames(1);
  const topLog546 = scopeBarTally546(b);
  // T-539 RE-POINT (2026-10-17): this mode's second word is `log`, not `amp`. The quiet-bin pair is kept because the
  // switch still has to be honoured, and its numbers are stated as what the DRAWING shows: a bar ladder cut in 4 px
  // steps cannot separate these two mappings at -45 dB, where they differ by a fraction of one segment. That is a
  // fact about a segmented ladder, and the hot-bin pair below is what shows the mapping itself.
  // RE-POINTED 2026-11-07 by T-750 (operator, verbatim: "we can remove the DB/log setting as a button and pin the
  // plugins to the db setting, (keep code but config to dB) - log shows no action"). The operator's own observation
  // is what the card is named after: at a quiet bin the two spacings are indistinguishable on a 4 px ladder, and
  // the panel now acts on that observation by taking the choice away. This mount stores "log" for the spectrum; the
  // validator accepts only the words a mode actually offers, so the stored word is refused and the mode answers dB.
  // Measured as a drawing that is the same bar at the same height in both mounts - the pinning, seen from the canvas
  // rather than from the code. The log curve itself is measured arithmetically in the source pin further down,
  // because the panel no longer reaches it.
  check('T-506b, re-pointed by T-539 and re-cut by T-750: one hot FFT bin lights ONE bar of 5 lit segments, and a stored "log" for this mode draws the identical bar - the word is refused and the mode answers its one pinned spacing',
    topDb546.bars === 1 && topDb546.tall === 5
    && topLog546.bars === 1 && topLog546.tall === 5 && topLog546.lit === topDb546.lit,
    { dB_quiet: topDb546, stored_log_quiet: topLog546 });

  // The same bin at the analyser's own ceiling, which is where the two mappings disagree in whole segments.
  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'off' } });
  m = await mount(b, { canvas2d: true, audioTracks: 1 });
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush();
  m.armAudio(1);
  b.hotBins = [4]; b.hotBinValue = 255;
  m.clickStrip(); m.commit();
  b.rectLog.length = 0;
  b.frames(1);
  const hotDb539 = scopeBarTally546(b);
  teardown();
  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'off', 'deepamp:scope.levels': '{"spectrum":"log"}' } });
  m = await mount(b, { canvas2d: true, audioTracks: 1 });
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush();
  m.armAudio(1);
  b.hotBins = [4]; b.hotBinValue = 255;
  m.clickStrip(); m.commit();
  b.rectLog.length = 0;
  b.frames(1);
  const hotLog539 = scopeBarTally546(b);
  check('T-539, re-cut by T-750: the same bin at the analyser ceiling lights ONE bar of 8 segments, and a stored "log" for this mode draws the identical bar - the word is refused, so the mode cannot be taken off its pinned spacing',
    // RE-POINTED 2026-11-07 by T-750 (operator: "we can remove the DB/log setting as a button and pin the plugins to
    // the db setting, (keep code but config to dB) - log shows no action"). The numbers this card measured on
    // 2026-10-17 - 8 segments on the dB window against 2 on the log curve, one bar either way, so the log curve
    // lifts the low end against a straight amplitude line without letting a hot bin blow past the top - are still
    // true of the curve, and they are measured on the curve itself in the source pin below, because the panel no
    // longer reaches it through a switch. What the panel is measured for here is the pinning.
    hotDb539.bars === 1 && hotDb539.tall === 8
    && hotLog539.bars === 1 && hotLog539.tall === 8 && hotLog539.lit === hotDb539.lit,
    { dB_ceiling: hotDb539, stored_log_ceiling: hotLog539 });
  check('T-539 source, re-cut by T-750: the log curve the card states is still in the client and still does what the card says - log10 of 1 + 9 times the amplitude, 0 at silence, 1 at 0 dBFS, monotonic, 3.9 times a straight amplitude line at the low end and below the dB window at the top - and no mode in the panel offers the word any more',
    // RE-POINTED 2026-11-07 by T-750 (operator: "keep code but config to dB"). The curve stays exactly where the
    // card put it and is still called the way the card says it is called; what changed is that no mode's vocabulary
    // names the word, so the panel cannot reach it. A claim that can no longer be reached through the panel is
    // measured on the code that carries it - the same three numbers the card of 2026-10-17 states, evaluated here
    // on the extracted function. The read behind these numbers is deepamp-audio/scratch/logcurve_750.cjs.
    (function () {
      const s539 = require('fs').readFileSync(TARGET, 'utf8');
      const take539 = function (name539) {
        const at539 = s539.indexOf('function ' + name539 + '(');
        if (at539 < 0) return '';
        const end539 = s539.indexOf('\n    }', at539);
        return end539 < 0 ? '' : s539.slice(at539, end539 + 6);
      };
      const logBody539 = take539('scopeBarLogFrac539');
      const ampBody539 = take539('scopeBarAmpFrac346');
      const dbBody539 = take539('scopeBarFrac300');
      if (!logBody539 || !ampBody539 || !dbBody539) return false;
      if (!/Math\.log\(1 \+ 9 \* a539\) \/ Math\.LN10/.test(logBody539)) return false;
      if (!(s539.indexOf('function scopeBarAmpFrac346(') > s539.indexOf('function scopeBarLogFrac539('))) return false;
      // The vocabulary the table is built from: the spectrum keeps its one pinned word, and no mode's word list
      // names the removed one. The curve is still called with the analyser's own decibel window at the spectrum's
      // drawing site, which is the half of "keep code".
      if (!/spectrum:\s*\{ words: \["dB"\], def: "dB"/.test(s539)) return false;
      if (/words: \[[^\]]*"log"/.test(s539)) return false;
      if (!(s539.indexOf('scopeBarLogFrac539(v, t.an.minDecibels') > 0)) return false;
      if (s539.indexOf('"spectrum") === "amp"') >= 0) return false;
      const build539 = function (name539) {
        return new Function('SCOPE_FLOOR_DB300', 'SCOPE_TOP_DB300',
          take539(name539) + '\n return ' + name539 + ';')(-70, 0);
      };
      const logF539 = build539('scopeBarLogFrac539');
      const ampF539 = build539('scopeBarAmpFrac346');
      const dbF539 = build539('scopeBarFrac300');
      const MIN539 = -100, MAX539 = -30;            // the analyser window the panel and this suite both use
      if (logF539(0, MIN539, MAX539) !== 0) return false;                    // 0 at silence
      if (logF539(255, MIN539, 0) !== 1 || ampF539(255, MIN539, 0) !== 1) return false;   // 1 at 0 dBFS
      let prev539 = -1;
      for (let b539 = 0; b539 <= 255; b539++) {                             // monotonic across the byte range
        const f539 = logF539(b539, MIN539, MAX539);
        if (f539 < prev539 - 1e-12 || f539 > 1 || f539 < 0) return false;
        prev539 = f539;
      }
      // The low end: at -60 dB the curve is 3.9 times the straight amplitude line, against the limit 9/ln(10)
      // the card names, and it sits above that line at every sample whose amplitude is under a twentieth.
      const small539 = 146;
      const ratio539 = logF539(small539, MIN539, MAX539) / ampF539(small539, MIN539, MAX539);
      if (!(ratio539 > 3.8 && ratio539 < 9 / Math.LN10 + 0.05)) return false;
      let low539 = 0, won539 = 0;
      for (let b539 = 0; b539 <= 255; b539++) {
        const a539 = ampF539(b539, MIN539, MAX539);
        if (a539 > 0 && a539 < 0.05) { low539++; if (logF539(b539, MIN539, MAX539) > a539) won539++; }
      }
      if (low539 < 100 || won539 !== low539) return false;
      // The top of the window: the curve is BELOW the dB-window spacing there, which is the half of the card that
      // says a hot bin does not blow past the top of the ladder - the 2 segments against 8 that the drawing showed.
      return logF539(255, MIN539, MAX539) < dbF539(255, MIN539, MAX539);
    })(), 'the curve is not what the card states, or a mode still offers the word');
  check('T-506b source: the trace gain and the take-own bars read their mode own switch through the same one helper, so no mode has a private idea about level',
    /scopeLevel346\(scopeLevelsRef346\.current, "oscilloscope"\)/.test(src)
    && /scopeLevel346\(scopeLevelsRef346\.current, "static"\)/.test(src)
    && /scopeLevel346\(scopeLevelsRef346\.current, "spectrum"\)/.test(src)
    && (src.match(/function scopeLevel346\(/g) || []).length === 1, 'one helper, three readers');
  check('T-506b source: raw means the beam is drawn at 1.00 and the parked gain is reset, so switching back starts from one and not from wherever it had been left',
    /=== "raw"\) \{\s*gn = 1; t\.gain = 1; t\.quiet = 0;/.test(src), 'no stale gain');

  teardown();

  console.log('\n--- T-509 (user 2026-10-16, verbatim): "fix waveform plotter for streaming use: currently shows old waveform while streaming, but could show current buffer waveform moving to the left across the (static) position marker" ---');
  {
    // Scenario 1: a station is presenting, no take has ever been played in this panel. The strip is on static
    // waveform — the mode the user was looking at.
    const b509 = makeBrowser({ storage: { 'deepamp:scope.mode': 'oscilloscope' } });
    const m509 = await mount(b509, { canvas2d: true, audioTracks: 1 });
    m509.commit(); await flush();
    await openAllSections(m509.shim, m509.comp);
    m509.commit(); await flush();
    const aud509 = m509.shim.rt.created.filter(function (e) { return e.type === 'audio'; });
    const take509 = (aud509[0] && aud509[0].props.ref) ? aud509[0].props.ref.current : null;
    const st509 = (aud509[1] && aud509[1].props.ref) ? aud509[1].props.ref.current : null;
    m509.clickStrip();                                  // oscilloscope -> waveform
    const cv509 = m509.canvases().pop();
    const W509 = cv509 ? parseInt(String(cv509.props.width), 10) : 0;
    check('T-509 setup: the strip is on waveform and the panel has a take element AND a station element to hand the station a link',
      String(m509.modeLabel()).indexOf('waveform') === 0 && !!take509 && !!st509 && W509 === 200,
      { mode: m509.modeLabel(), take: !!take509, station: !!st509, canvasWidth: W509 });
    st509.src = 'http://radio.test:8000/live';
    st509.paused = false; st509.ended = false; st509._tracks = 1;
    st509.fire('timeupdate');
    m509.commit(); await flush();
    b509.frames(70);                       // one frame fills one bar: a 200 px strip holds 67 columns
    const mark509 = b509.rectLog.length;
    b509.frames(1);
    const frame509 = b509.rectLog.slice(mark509);
    const live509 = frame509.filter(function (r) { return r[5] === '#e8e8e8' && r[2] === 2; });
    const red509 = frame509.filter(function (r) { return r[5] === '#f85149'; });
    check('T-509: static mode with a station presenting arms an audio graph and draws a live window — this mode has never had a tap before, and the old peaks picture is exactly what the user reported seeing',
      b509.ctxBuilt >= 1 && live509.length >= 40, { ctxBuilt: b509.ctxBuilt, liveBars: live509.length, barXs: live509.slice(0, 3).map(function (r) { return r[0]; }) });
    // T-536 (2026-10-17): the marker moved, and it lost its red. The user's words were "with the position marked
    // (red line being removed during stream play)" and then "The mark should show current position on the waveform
    // that is being heard". On this window the position being heard IS the newest frame, which is drawn at the right
    // edge, so the mark stands on the newest bar. T-509's fixed middle line was a reference the picture travelled
    // across and it pointed at nothing; it was also the red line. The mark's colour is now the scheme's OTHER
    // colour, so a mark is never the same colour as the bars it marks — measured here as the take colour, which
    // appears exactly twice in the frame: the line and its tick.
    const liveBars536 = frame509.filter(function (r) { return r[5] === '#e8e8e8' && r[2] === 2; });
    const lastBar536 = liveBars536.length ? liveBars536.reduce(function (a536, c536) { return c536[0] > a536[0] ? c536 : a536; }) : null;
    const mark536 = frame509.filter(function (r) { return r[5] === '#9fe89f'; });
    check('T-536: the live window paints NO red, and its mark is a full-height line with a tick standing on the newest bar - the position being heard',
      red509.length === 0 && mark536.length === 2 && mark536[0][2] === 1 && mark536[0][3] === 48
      && !!lastBar536 && Math.abs(mark536[0][0] - (lastBar536[0] + 2)) <= 1,
      { red: red509.length, mark: mark536.map(function (r) { return r[0] + ' ' + r[2] + 'x' + r[3]; }), newest_bar_x: lastBar536 ? lastBar536[0] : -1 });
    // T-544 (user 2026-10-17, verbatim: "time display during stream only play should be 'centered' within canvas
    // (keep dot-matrix allignment)"). The band dots are the only 2x2 rects above the strip line (the bars are drawn
    // below the 24 px band and the state mark is built from 1 px and 6 px rects), so the run of glyphs is measured by
    // its own geometry rather than by a colour that another element could also be wearing.
    const band544 = frame509.filter(function (r544) { return r544[2] === 2 && r544[3] === 2 && r544[1] < 24; });
    const xs544 = band544.map(function (r544) { return r544[0]; });
    const lo544 = xs544.length ? Math.min.apply(null, xs544) : -1;
    const hi544 = xs544.length ? Math.max.apply(null, xs544) : -1;
    check('T-544: while a station is what is playing, the lone position read-out is centred in the space the state mark leaves — the MIDDLE of the glyph run lands on the middle of that space (within one cell), and the run moved off its old hard-left start at x 20',
      band544.length >= 40 && lo544 > 20 && (hi544 + 2 - lo544) >= 40
      && Math.abs(((lo544 + hi544 + 2) / 2) - ((12 + 200 - 6) / 2)) <= 3,
      { dots: band544.length, run_from: lo544, run_to: hi544 + 2, run_width: hi544 + 2 - lo544,
        run_centre: (lo544 + hi544 + 2) / 2, space_centre: (12 + 200 - 6) / 2 });
    // T-543 (user 2026-10-17, verbatim): "currently during web-stream-only play, the kbps and KHz display are grey:
    // should show stream information if easily available". This is the scenario where a station is what the graph is
    // fed from, so it is where the read-out is measured. The mock context decodes at 24000 Hz, and the number that
    // shows up is that number named as what it is - no bitrate half, and no dash standing in for a measurement this
    // panel has never made.
    (function () {
      const rateEls543 = m509.els('audio-play-bitrate');
      const rateEl543 = rateEls543.length ? rateEls543[rateEls543.length - 1] : null;
      const rateTxt543 = rateEl543 ? m509.ownText(rateEl543) : '';
      const rateTitle543 = rateEl543 ? String((rateEl543.props || {}).title || '') : '';
      check('T-543: while a station is what the graph is fed from, the rate read-out prints the rate this browser decodes at, names it as that, and prints no bitrate at all - the grey dashes are gone rather than being kept beside a new number',
        rateTxt543 === '24 kHz decoded here' && rateTxt543.indexOf('kbps') < 0 && rateTxt543.indexOf('--') < 0
        && /rate THIS browser decodes it at/.test(rateTitle543) && /no bitrate is printed/.test(rateTitle543)
        && ((rateEl543.props || {}).style || {}).color === '#3fb950',
        { read_out: rateTxt543, hover: rateTitle543.slice(0, 120), colour: ((rateEl543 || {}).props || {}).style && ((rateEl543.props || {}).style || {}).color });
    })();
    // T-786 (operator ruling 2026-11-11, verbatim: "in player: why do external streams print '48 kHz decoded here'
    // instead of '48 kHz X kbps' ?", and on where the information comes from: "we already catch that info somewhere -
    // you already diagnosed that once a few weeks ago - please take another look", and on the shape: "Let the read
    // follow the station being played"). The host half is proved behaviourally in tests/host.test.cjs: the station's
    // own declared bitrate, sample rate, channel count and codec come back on the answer the title read already makes,
    // for a host on a list the operator owns. What is pinned HERE is the client's half of that contract, as a source
    // shape: the read-out's order of precedence, the one place the answer is handed to it, and the fact that the
    // station's numbers and the graph's number are printed through the SAME formatter while staying two different
    // kinds of fact. The behavioural half of this — a station that declares itself on the operator's own player — is a
    // live read with a browser refresh, and it is named as that in the card, not claimed from here. The T-543 check
    // above is untouched and still states what the panel prints when a station declares nothing, which is the case it
    // was written for.
    check('T-786 source: a station that DECLARES its own numbers is printed ahead of the graph rate, through the same formatter, and named as the station\'s own claim',
      (function () {
        const s786 = require('fs').readFileSync(TARGET, 'utf8');
        const printAt = s786.indexOf('+ " kHz decoded here"');
        const declaredPrint = s786.indexOf('if (playStats300.declared === true && (playStats300.kbps > 0 || playStats300.khz > 0))');
        const graphPrint = s786.indexOf('if (hz543 > 0) {');
        const merge = /cur451\.kbps = \(sa450\.bitrate_kbps > 0\)[\s\S]{0,400}cur451\.declared = true;[\s\S]{0,400}setPlayStats300\(cur451\);/.test(s786);
        const guarded = /if \(cur451 && cur451\.stream && cur451\.host === streamHost395\(u450\) && !playingRef\.current\)/.test(s786);
        const oneFormatter = /return khzText586\(khzHere586\) \+ " kHz decoded here";/.test(s786)
          && /khzText586\(playStats300\.khz\) \+ " kHz"/.test(s786);
        const namedAsClaim = /these are the numbers THIS STATION declared about its own stream/.test(s786)
          && /it is the station's own claim, not a measurement by this panel/.test(s786)
          && /named here rather than printed/.test(s786);
        const takePathIntact = /return \(playStats300\.kbps \? playStats300\.kbps : "--"\) \+ " kbps  " \+ \(playStats300\.khz \? playStats300\.khz : "--"\) \+ " kHz";/.test(s786);
        return declaredPrint >= 0 && graphPrint > declaredPrint && printAt > declaredPrint
          && merge && guarded && oneFormatter && namedAsClaim && takePathIntact;
      })(), { declared_before_graph: true, one_merge_point: true, same_formatter_two_sources: true, hover_names_the_kind: true, take_path_intact: true });
    let scroll509 = {};
    check('T-509: the window SCROLLS LEFT across the marker — a loud frame enters at the RIGHT edge, walks left as frames pass, and ends up on the far side of the middle line (the request: "moving to the left across the (static) position marker")',
      (function () {
        b509.tdAmp = 100; b509.tdRippleAmp = 0;
        b509.frames(1);                                   // the loud frame is now the newest sample in the window
        const mA = b509.rectLog.length;
        b509.frames(1);
        const loudA = b509.rectLog.slice(mA).filter(function (r) { return r[5] === '#e8e8e8' && r[2] === 2 && r[3] >= 20; });
        const tallA = loudA.length ? loudA.reduce(function (a509, c509) { return c509[3] > a509[3] ? c509 : a509; }) : null;
        // A QUIET signal, not a dead one. The strip's own self-heal throws away a tap whose analyser answers
        // nothing for long enough — a different fact, pinned just below — and a walk has to be measured on a tap
        // that stays the same tap, or the walk is measuring a rebuild and not a window.
        b509.tdAmp = 2; b509.tdRippleAmp = 0;
        b509.frames(40);                                  // forty frames of nothing: the loud bar walks forty columns left
        const mB = b509.rectLog.length;
        b509.frames(1);
        const later = b509.rectLog.slice(mB).filter(function (r) { return r[5] === '#e8e8e8' && r[2] === 2 && r[3] >= 20; });
        b509.tdAmp = 24; b509.tdRippleAmp = 8;
        const laterAll = b509.rectLog.slice(mB).filter(function (r) { return r[5] === '#e8e8e8' && r[2] === 2; });
        scroll509 = { tallX: tallA ? tallA[0] : -1, tallH: tallA ? tallA[3] : 0, laterXs: later.map(function (r) { return r[0]; }), laterHs: later.map(function (r) { return r[3]; }), laterBars: laterAll.length, laterHeights: laterAll.map(function (r) { return r[3]; }).slice(0, 70) };
        // The loud signal is held for two drawn frames here, so two loud samples enter the window. What the
        // request asked for is the WALK: they enter at the right edge and end up on the far side of the middle
        // line, and nothing tall is left anywhere near the right edge.
        return !!tallA && tallA[0] >= 190 && later.length >= 2
          && later.every(function (r) { return r[0] < 100 && r[3] >= 20; })
          && !later.some(function (r) { return r[0] > 150; });
      })(), scroll509);
    let rebuild509 = {};
    check('T-509: a tap the strip throws away takes its window with it — after the quiet self-heal rebuilds a dead analyser, the window is drawn from the NEW tap and carries none of the old frames, which is the same rule the peak meter and the trace already follow',
      (function () {
        const streamsBefore509 = b509.streams;
        b509.silent = true;
        b509.frames(120);                       // long enough for the strip's own quiet test to fire
        const rebuilt509 = b509.streams > streamsBefore509;
        const mC = b509.rectLog.length;
        b509.frames(1);
        const afterRebuild = b509.rectLog.slice(mC).filter(function (r) { return r[5] === '#e8e8e8' && r[2] === 2; });
        b509.silent = false;
        rebuild509 = { streamsBefore: streamsBefore509, streamsAfter: b509.streams, bars: afterRebuild.length, heights: afterRebuild.map(function (r) { return r[3]; }).slice(0, 20) };
        return rebuilt509 && afterRebuild.length > 0 && afterRebuild.length < 67
          && afterRebuild.every(function (r) { return r[3] <= 2; });
      })(), rebuild509);

    check('T-536: the hover says what this view IS and what is drawn in it - it names the mark as the position being heard, keeps the sentence that a stream has no position in a file, and claims no background picture the panel no longer draws',
      (function () {
        const t536 = String((m509.canvases().pop() || {}).props.title || '');
        return /the newest frame is at the RIGHT edge/.test(t536)
          && /the mark on the newest bar is the position you are hearing now/.test(t536)
          && /no position in a file/.test(t536) && !/behind it/.test(t536)
          && String(t536).indexOf('waveform') === 27;
      })(), String((m509.canvases().pop() || {}).props.title || '').slice(0, 240));
    teardown();

    // Scenario 2: a take WAS played and its peaks were read; the take ended and a station took over. That is the
    // state the user was looking at — the panel still holds the take's picture, and a station is audible.
    const pk509 = [];
    for (let i509 = 0; i509 < 240; i509++) {
      const v509 = Math.sin(i509 / 9) * (i509 < 120 ? 0.7 : 0.18);
      pk509.push({ max: v509 > 0 ? v509 : 0, min: v509 < 0 ? v509 : 0 });
    }
    const b510 = makeBrowser({ storage: { 'deepamp:scope.mode': 'oscilloscope' } });
    const m510 = await mount(b510, {
      canvas2d: true, audioTracks: 2, peaks: pk509, channels: 2, sampleRate: 48000, bytes: 165120,
      items: [{ id: 'ap-3051', fn: 'tts', kind: 'tts', status: 'ok', model: 'm1', voice: 'voy_janeway', duration: 3.44, text: 'the take' }],
    });
    m510.commit(); await flush();
    await openAllSections(m510.shim, m510.comp);
    m510.commit(); await flush();
    const aud510 = m510.shim.rt.created.filter(function (e) { return e.type === 'audio'; });
    const take510 = aud510[0].props.ref.current, st510 = aud510[1].props.ref.current;
    const play510 = m510.created().filter(function (e) {
      return e.type === 'button' && /play the row the transport is on/.test(String(e.props && e.props.title));
    }).pop();
    if (play510) { play510.props.onClick(); await flush(); m510.commit(); await flush(); }
    m510.armAudio(2);
    take510.fire('timeupdate');
    m510.commit(); await flush();
    m510.clickStrip();                       // oscilloscope -> static: this is where the peaks read is asked
    await flush();
    m510.commit(); await flush();
    take510.paused = true; take510.ended = true;
    take510.fire('ended');
    st510.src = 'http://radio.test:8000/live'; st510.paused = false; st510.ended = false; st510._tracks = 2;
    st510.fire('timeupdate');
    m510.commit(); await flush();
    b510.frames(70);
    const mark510 = b510.rectLog.length;
    b510.frames(1);
    const frame510 = b510.rectLog.slice(mark510);
    const ghost510 = frame510.filter(function (r) { return r[5] === '#3f5f3f'; });
    const live510 = frame510.filter(function (r) { return r[5] === '#e8e8e8' && r[2] === 2; });
    const takeCol510 = frame510.filter(function (r) { return r[5] === '#9fe89f'; });
    const red510 = frame510.filter(function (r) { return r[5] === '#f85149'; });
    // T-536 supersedes the "keep the ghost" ruling of T-509 on the user's own words, 2026-10-17: "i guess: drop it,
    // see 1" — item 1 being the ruling that both variants draw a bar the same way. A background layer exists to say
    // something the front picture does not; once the geometry is shared it says nothing, and it had cost a flag, a
    // second colour, a suppressed play head, a hover sentence and four pins. The take's peaks read is NOT skipped
    // (a take view needs it and the view can change back at any moment); only the drawing of it behind a station
    // window is gone, which is what is measured here.
    check('T-536: nothing of the take\'s picture is drawn behind a live station window - no rect in the dim ghost colour, and the take colour appears only as the two rects of the mark',
      ghost510.length === 0 && takeCol510.length === 2, { ghostBars: ghost510.length, markRects: takeCol510.length });
    check('T-509 GHOST: the live window is drawn on top of the ghost in the front colour, with the same bar grid (2 px bars, 1 px gap) so the two pictures share one grid',
      live510.length >= 40 && live510.every(function (r) { return r[2] === 2; }), { liveBars: live510.length });
    check('T-536: no red is painted anywhere in a live-window frame - the line the user asked to have removed during stream play is gone, and with no background layer there is nothing left that could carry a stale take position',
      red510.length === 0, red510.map(function (r) { return r[0] + ' ' + r[2] + 'x' + r[3]; }));
    // The rule behind the old pin is still the rule: a picture must not claim something it does not draw. What
    // changed is which picture is honest — the hover used to name a background it drew, and now it must not name one.
    check('T-536: the hover claims nothing it does not draw - with the take picture gone from this view the hover says so by silence, and it still names the mark as the position being heard',
      (function () {
        const t536b = String((m510.canvases().pop() || {}).props.title || '');
        return !/behind it/.test(t536b) && !/dim green/.test(t536b)
          && /the mark on the newest bar is the position you are hearing now/.test(t536b);
      })(), String((m510.canvases().pop() || {}).props.title || '').slice(0, 260));
    teardown();

    // "untouched" was the old pin's word, and T-536 is precisely the card that touched it: the take picture's bar
    // geometry changed on the user's ruling. What still has to hold, and what this pin now holds it to, is the
    // SHAPE of the two views: a take view is one call and draws no window, a station view is one call and draws no
    // take picture, and the flag that used to distinguish a background from a front picture no longer exists.
    check('T-536 source: a take view is one call that draws no live window, a station view is one call that draws no take picture, and the ghost argument is gone from the function that carried it',
      (function () {
        const s509 = require('fs').readFileSync(TARGET, 'utf8');
        // T-788 note on the anchor: this mode now has TWO arms that open with `if (m === "static") {` — the one a
        // take with no analyser tap reaches, and the one a station reaches — and this pin is about the second. The
        // anchor names the sentence only that arm carries, so the block measured is the block the pin means.
        const k509 = s509.indexOf('if (m === "static") {\n          // The reported bug');
        const blk = s509.slice(k509, k509 + 1600);
        // RE-POINTED 2026-11-11 by T-788 (operator: "replace the option to switch between static view ... with a
        // 'dynamic sliding window' what we currently already have for stream display ... and make the sliding window
        // the default", card answer "keep it, sliding window default"). The take view is no longer one picture: it is
        // one of two, chosen by the mode's own switch, so the full-file painter is reached from three places and not
        // two - the no-tap arm, the tap arm's non-window half, and the window's own fallback for a take whose peaks
        // carry no length, which is the case where a window would have no timeline to slide along. Every other half
        // of this pin is unchanged: a take view still draws no live window, a station view still draws no take
        // picture, and the ghost argument is still gone.
        // RE-POINTED again the same day by T-792 (operator: "the waveform sliding is way too slow, shorten the
        // window: half the current size, AND offer option 'sliding2' with a quater of current window size"). The
        // branch no longer names one word, it asks whether the word in use IS a window: the mode offers two window
        // widths now and one painter draws both, so the branch and the width read the same table.
        return /if \(scopeLiveTap309\(t\)\) \{/.test(blk)
          && !/scopeStaticFrame300\(g, W, barH, scopePeaks300\.current, true\)/.test(s509)
          && (s509.match(/scopeStaticFrame300\(/g) || []).length === 4
          && (s509.match(/scopeWaveWindowFrame788\(/g) || []).length === 3
          && /if \(scopeWaveIsWindow792\(scopeWaveViewRef788\.current\)\) scopeWaveWindowFrame788\(/.test(s509)
          && (s509.match(/scopeWaveIsWindow792\(scopeWaveViewRef788\.current\)\)/g) || []).length === 2
          && /function scopeStaticFrame300\(g, W, barH, pk\) \{/.test(s509)
          && /scopeLiveScrollFrame309\(g, W, barH, t\);/.test(blk)
          && /scopeStaticFrame300\(g, W, barH, scopePeaks300\.current\);\s*\n\s*g\.restore\(\);/.test(blk)
          && /function scopeLiveTap309\(t\) \{\s*\n\s*if \(!t \|\| t\.mic\) return false;/.test(s509)
          && (s509.match(/scopeLiveScrollFrame309/g) || []).length === 2;
      })(), {});
    check('T-509 source: static mode became a live mode ONLY for a station tap — the loop gate, the click arm and the event arm each carry the narrow condition, and the event arm asks the presenting element rather than the take element the effect closed over',
      (function () {
        const s509 = require('fs').readFileSync(TARGET, 'utf8');
        return /&& !\(m === "static" && scopeLiveTap309\(scopeTap300\.current\)\)\) return false;/.test(s509)
          && /\(m === "static" && present395 === streamAudioRef\.current/.test(s509)
          && /var a509 = pictureEl395\(\);/.test(s509)
          && /scopeLiveBuf309/.test(s509) && /buf309\.mx\.copyWithin\(0, 1\)/.test(s509);
      })(), {});

    // ---------------------------------------------------------------- T-536: a take bar spans what it measured, and the colour is a choice
    // The fixture is a symmetric sine on purpose: max and min the same size. That is the shape the collapse ate —
    // under the geometry this card replaced, every bar of it drew 1 px tall (T-527 measured 67 of them).
    //
    // How the frame is read, and why: the mock runs a take to its end while a press is being flushed, the panel
    // stops its draw loop when the element says "ended", and a later frames(1) then draws nothing at all — measured
    // here, three times, before this paragraph was written. What is measured instead is the LAST frame the panel
    // actually drew for that mount, taken from the tail of the rect log. The colour variants are mounted with the
    // value already stored, which is how this suite reads every stored choice (the level table above is tested the
    // same way): a stored value is what a reload hands the panel, and it is the thing the pin has to be true about.
    const pk536 = [];
    for (let i536 = 0; i536 < 240; i536++) {
      const v536 = Math.sin(i536 / 9) * (i536 < 120 ? 0.72 : 0.18);
      pk536.push({ max: v536 > 0 ? v536 : 0, min: v536 < 0 ? v536 : 0 });
    }
    const takeItem536 = [{ id: 'ap-3061', fn: 'tts', kind: 'tts', status: 'ok', model: 'm1', voice: 'voy_janeway', duration: 3.44, text: 'the take' }];
    // One frame's worth of bars, read out of the log by the direction the bars are drawn in: a frame's bars run
    // left to right, so walking backwards from the end stops the moment x starts going up again - that is the seam
    // between two frames. A fixed tail slice was tried first and it measured 80 bars across a frame boundary, which
    // is how a pin starts disagreeing with itself.
    const barsOf536 = function (br536) {
      const lg536 = br536.rectLog;
      const out536 = [];
      for (let k536 = lg536.length - 1; k536 >= 0; k536--) {
        const r536 = lg536[k536];
        if (r536[2] !== 2) continue;
        if (out536.length && r536[0] > out536[0][0]) break;
        out536.unshift(r536);
      }
      return out536;
    };
    const mountTake536 = async function (storage536) {
      const br536 = makeBrowser({ storage: storage536 });
      const mt536 = await mount(br536, {
        canvas2d: true, audioTracks: 1, peaks: pk536, channels: 1, sampleRate: 48000, bytes: 165120, items: takeItem536,
      });
      mt536.commit(); await flush();
      await openAllSections(mt536.shim, mt536.comp);
      mt536.commit(); await flush();
      const aud536 = mt536.shim.rt.created.filter(function (e536) { return e536.type === 'audio'; });
      const take536 = aud536[0].props.ref.current;
      const play536 = mt536.created().filter(function (e536) {
        return e536.type === 'button' && /play the row the transport is on/.test(String(e536.props && e536.props.title));
      }).pop();
      if (play536) { play536.props.onClick(); await flush(); mt536.commit(); await flush(); }
      mt536.armAudio(1);
      take536.fire('timeupdate');
      br536.frames(6);
      return { br: br536, m: mt536 };
    };

    // T-556 (operator ruling 2026-10-18, verbatim): "the double klick should not change the mode . only single klick,
    // rewire accordingly". The canvas already owned a single press that cycles the mode, and a browser delivers a
    // double-click as click, click, dblclick -- the presses land first and the gesture that has to cancel them lands
    // after them, so the panel has to remember where the pair started. Measured on a take mount of its own: a block
    // that presses the strip twice leaves the panel on a different mode, and an earlier version of this block sat in
    // the middle of the main scenario, where a swap run showed it taking forty-odd later checks down with it. An
    // isolated mount is the cleanup, and it is why no walk-back is needed here.
    // The stored word, not the hover word: the panel persists 'spectrum' and the hover says 'spectrum analyser'. The
    // first version of this line asked for the hover word and the take mounted with the visualizer OFF, which is how
    // the two pins below came back reading the off-hover and an off start mode.
    const t556a = await mountTake536({ 'deepamp:scope.mode': 'spectrum' });
    const c556s = t556a.m.canvases();
    const c556 = c556s.length ? c556s[c556s.length - 1] : null;
    const m556Before = t556a.m.modeLabel();
    check('T-556: the visualizer canvas carries a double-click act of its own, and its hover says what that act does',
      !!c556 && typeof c556.props.onDoubleClick === 'function'
      && /double-click opens the visualizer settings and leaves the mode where it is/.test(String(c556.props.title || '')),
      { gesture_present: !!(c556 && typeof c556.props.onDoubleClick === 'function'),
        hover_tail: String((c556 && c556.props.title) || '').slice(-96) });
    t556a.m.clickStrip();
    const m556FirstPress = t556a.m.modeLabel();          // the first press really does change the mode: that is the transient
    t556a.m.clickStrip();
    const m556SecondPress = t556a.m.modeLabel();
    // Guarded so a swap run against a client that has no such act FAILS this pin instead of throwing and taking every
    // later check in this file down with it. That difference is the point of a swap run.
    if (c556 && typeof c556.props.onDoubleClick === 'function') c556.props.onDoubleClick({ stopPropagation: function () {} });
    t556a.m.commit();
    const m556After = t556a.m.modeLabel();
    check('T-556: a double-click on the canvas leaves the mode exactly where it was - the two presses it is made of are undone, and the mode is not walked back by a guessed number of steps',
      m556Before === 'spectrum analyser' && m556After === m556Before
      && m556FirstPress !== m556Before && m556SecondPress !== m556FirstPress,
      { mode_before: m556Before, after_first_press: m556FirstPress, after_second_press: m556SecondPress,
        after_the_double_click: m556After,
        note: 'the mode is different between the second press and the restore; that is the transient a browser forces, and it is measured here rather than argued away' });
    check('T-556: the single press is untouched by the new gesture - two presses with no double-click move the mode twice',
      (function () {
        const a556 = t556a.m.modeLabel(); t556a.m.clickStrip(); const b556 = t556a.m.modeLabel();
        t556a.m.clickStrip(); const c556b = t556a.m.modeLabel();
        return a556 !== b556 && b556 !== c556b;
      })(), { note: 'two presses, three different modes, no double-click anywhere in them' });
    check('T-556: the double-click asks for the visualizer settings group to be brought into view - measured as a scroll request on the group the gesture names',
      (function () {
        const before556 = (t556a.br.scrollLog || []).length;
        if (c556 && typeof c556.props.onDoubleClick === 'function') c556.props.onDoubleClick({ stopPropagation: function () {} });
        t556a.m.commit();
        const log556 = t556a.br.scrollLog || [];
        return log556.length === before556 + 1 && log556.slice(-1)[0][1] === 'start';
      })(), { scroll_requests_before_the_second_double_click: ((t556a.br.scrollLog || []).length) - 1,
        last_scroll_request: (t556a.br.scrollLog || []).slice(-1)[0],
        note: 'the harness had to be given a host node that answers scrollIntoView before this could be measured at all; before that, a panel act whose whole job is a scroll could only be asserted in a comment' });

    const t536a = await mountTake536({ 'deepamp:scope.mode': 'static' });
    const bars536 = barsOf536(t536a.br);
    check('T-536: a take bar spans the excursion it measured - on a symmetric wave NO bar is 1 px tall any more (T-527 measured 67 bars of 1 px)',
      bars536.length >= 40 && bars536.filter(function (r536) { return r536[3] <= 1; }).length === 0,
      { bars: bars536.length, collapsed: bars536.filter(function (r536) { return r536[3] <= 1; }).length,
        heights: bars536.map(function (r536) { return Math.round(r536[3] * 10) / 10; }).slice(0, 12) });
    check('T-536: a take picture is drawn in white by default, and the dot-matrix green it used to be drawn in appears nowhere in that frame',
      bars536.length >= 40 && bars536.every(function (r536) { return r536[5] === '#e8e8e8'; })
      && t536a.br.rectLog.slice(-80).filter(function (r536) { return r536[5] === '#9fe89f'; }).length === 0,
      { bars: bars536.length, white: bars536.filter(function (r536) { return r536[5] === '#e8e8e8'; }).length });
    // T-544 counterpin: centring is about a stream with no length to print, not about every frame. A take keeps the
    // layout T-334 gave it — the digits start at x 20, hard against the state mark, because that picture is a position
    // measured against a length and the two halves belong at opposite ends of that thought.
    (function () {
      const band544t = t536a.br.rectLog.filter(function (r544t) { return r544t[2] === 2 && r544t[3] === 2 && r544t[1] < 24; });
      const xs544t = band544t.map(function (r544t) { return r544t[0]; });
      const lo544t = xs544t.length ? Math.min.apply(null, xs544t) : -1;
      check('T-544: a take frame keeps the layout it has had since T-334 — the digits still start at x 20 beside the state mark, because centring belongs to a stream with no length to print and to nothing else',
        band544t.length >= 40 && lo544t === 20, { dots: band544t.length, run_from: lo544t });
    })();
    // T-539 RE-POINT (2026-10-17): "about vis settings: 'spectrum analyser' - ... add second option to switch
    // between grren/flames colors". The table now carries the colour control on TWO rows and on exactly those two:
    // the waveform row (three words) and the spectrum row (two words). The oscilloscope and the VU faces do NOT have
    // one, because the user said the information for them follows, and a colour invented for someone else's meter
    // before that word arrives is a guess.
    // T-541 RE-POINT (2026-10-17): the table now carries the colour control on THREE rows. The waterfall was given
    // the four-ramp vocabulary the user chose, so its row grows the same box the other two rows have. The
    // oscilloscope and the VU faces still do not have one, and the reason is unchanged: the user said the
    // information for them follows, and a colour invented for someone else's meter before that word arrives is a
    // guess about what their meter should look like.
    // T-542 RE-POINT (2026-10-17): the table carries the colour control on FOUR rows. The llama mode's background
    // is a spectrogram, so it was given the waterfall's four-ramp vocabulary rather than a fifth colour nobody asked
    // for. The oscilloscope and the VU faces still have none, and the reason is unchanged: the user said the
    // information for them follows, and a colour invented for someone else's meter before that word arrives is a guess.
    // RE-POINTED 2026-10-28 by T-601: the Knight Rider row carries a colour box too, so the count of colour
    // controls is five and the fifth row starts in the red the operator's reference image shows.
    // RE-POINTED 2026-11-07 by T-748 (operator, verbatim: "wow, the rolling qwen is perfect, but, ... add the
    // different color effects we already have for dancinf llama to bring in some rainbow effects aswell as a
    // secondary setting, try to make code reusable"). The count is seven: both rolling marks now carry a colour
    // control, on the same ramp tables and the same two colour functions the llama uses - that is the reuse the ask
    // named. The marks start in the one white they were asked for, which is T-746's picture kept as the default,
    // and every colour word is one press away. What this pin measures is unchanged in kind: the control sits on the
    // rows that have a colour decision, on exactly those rows, and each one names the value actually in use. The
    // two trailing comments on the llama and Knight Rider defaults were garbled by an earlier edit (one comment was
    // spliced into the middle of another); they are re-written whole here, with no assertion changed.
    check('T-536, re-pointed by T-539, T-541, T-542, T-601 and T-748: the colour control sits on the waveform row, the spectrum '
        + 'row, the waterfall row, the llama row, the Knight Rider row and both rolling mark rows, on exactly those seven, each naming the value in use, and the '
        + 'newer rows start in the colours those modes have always worn',
      t536a.m.els('audio-play-scope-scheme536').length === 7 && !!t536a.m.els('audio-play-scope-scheme536-static')[0]
      && !!t536a.m.els('audio-play-scope-scheme536-spectrum')[0]
      && !!t536a.m.els('audio-play-scope-scheme536-waterfall')[0]
      && !!t536a.m.els('audio-play-scope-scheme536-llama')[0]
      && !!t536a.m.els('audio-play-scope-scheme536-qwen')[0]
      && !!t536a.m.els('audio-play-scope-scheme536-whale')[0]
      && t536a.m.ownText(t536a.m.els('audio-play-scope-scheme536-static')[0]) === 'white'
      && t536a.m.ownText(t536a.m.els('audio-play-scope-scheme536-spectrum')[0]) === 'green'
      && t536a.m.ownText(t536a.m.els('audio-play-scope-scheme536-waterfall')[0]) === 'green'
      && t536a.m.ownText(t536a.m.els('audio-play-scope-scheme536-llama')[0]) === 'auto1'   // T-587: the operator made auto1 the llama default, verbatim "make default for llama-vis (Lama is running on a rainbow)"
      && t536a.m.ownText(t536a.m.els('audio-play-scope-scheme536-knight')[0]) === 'red',   // T-601: the Knight Rider default is the red of the operator's reference image 
      { controls: t536a.m.els('audio-play-scope-scheme536').length,
        waveform_word: t536a.m.ownText(t536a.m.els('audio-play-scope-scheme536-static')[0]),
        spectrum_word: t536a.m.ownText(t536a.m.els('audio-play-scope-scheme536-spectrum')[0]),
        waterfall_word: t536a.m.ownText(t536a.m.els('audio-play-scope-scheme536-waterfall')[0]),
        llama_word: t536a.m.ownText(t536a.m.els('audio-play-scope-scheme536-llama')[0]),
        knight_word: t536a.m.ownText(t536a.m.els('audio-play-scope-scheme536-knight')[0]),
        qwen_word: t536a.m.ownText(t536a.m.els('audio-play-scope-scheme536-qwen')[0]),
        whale_word: t536a.m.ownText(t536a.m.els('audio-play-scope-scheme536-whale')[0]) });
    check('T-536: the control says what the value means and what the press does, in its hover, like every other choice in this table',
      (function () {
        const t536h = String((t536a.m.els('audio-play-scope-scheme536-static')[0] || {}).props.title || '');
        return /waveform colour/.test(t536h) && /press to cycle white, green, flames/.test(t536h)
          && /near-white/.test(t536h);
      })(), String((t536a.m.els('audio-play-scope-scheme536-static')[0] || {}).props.title || '').slice(0, 170));
    t536a.m.els('audio-play-scope-scheme536-static')[0].props.onClick();
    t536a.m.commit();
    check('T-536: the press cycles the value and stores it as one key per mode, the same shape as the level table beside it',
      t536a.m.ownText(t536a.m.els('audio-play-scope-scheme536-static')[0]) === 'green'
      && /"static":"green"/.test(String(t536a.br.store['deepamp:scope.schemes'])),
      { stored: t536a.br.store['deepamp:scope.schemes'] });
    teardown();

    const t536b = await mountTake536({ 'deepamp:scope.mode': 'static', 'deepamp:scope.schemes': '{"static":"green"}' });
    const bars536g = barsOf536(t536b.br);
    check('T-536: a page stored on green draws its take bars in the dot-matrix green and in nothing else - the choice is not a label that sits beside the picture',
      bars536g.length >= 40 && bars536g.every(function (r536) { return r536[5] === '#9fe89f'; }),
      { bars: bars536g.length, green: bars536g.filter(function (r536) { return r536[5] === '#9fe89f'; }).length,
        word: t536b.m.ownText(t536b.m.els('audio-play-scope-scheme536-static')[0]) });
    teardown();

    const t536c = await mountTake536({ 'deepamp:scope.mode': 'static', 'deepamp:scope.schemes': '{"static":"flames"}' });
    const bars536f = barsOf536(t536c.br);
    // T-540 RE-POINT (2026-10-17, verbatim): "I was imagining a 'flames like optical effect with a fluent conversion
    // into the color change-not mapped to defined levels' - louder=hotter color". The hover used to state two
    // thresholds; the thresholds are gone, so the hover states the ramp and says outright that it does not switch.
    check('T-540: on the flames value the hover states the ramp it uses and says it is continuous, in words a reader can check against the picture',
      (function () {
        const t540h = String((t536c.m.els('audio-play-scope-scheme536-static')[0] || {}).props.title || '');
        return /continuously/.test(t540h) && /deep ember/.test(t540h) && /louder is hotter/.test(t540h)
          && /nothing switches at a level/.test(t540h) && !/nine tenths/.test(t540h);
      })(), String((t536c.m.els('audio-play-scope-scheme536-static')[0] || {}).props.title || '').slice(0, 210));
    // T-540 RE-POINT (the same ruling): the loud half of this wave (0.72) and the quiet half (0.18) are still two
    // readings of one fixture and they are still two different colours — but they are no longer two of three flat
    // bands. What matters now is that the colour CHANGES CONTINUOUSLY with height: one frame of one wave carries many
    // distinct flame colours rather than three, and none of the three band hexes appears anywhere in it.
    (function () {
      const seen540 = {};
      bars536f.forEach(function (r540) { seen540[r540[5]] = (seen540[r540[5]] || 0) + 1; });
      const distinct540 = Object.keys(seen540);
      const hot540 = bars536f.filter(function (r540) { return /^rgb\(25[0-5],/.test(r540[5]); });
      const ember540 = bars536f.filter(function (r540) { return /^rgb\(1[0-9][0-9],/.test(r540[5]); });
      check('T-540: flames colours each bar from its own measured height through a CONTINUOUS ramp - this one frame of one wave carries many distinct flame colours, the loud half reads hot and the quiet half reads ember, and not one bar is painted in any of the three band colours the old variant used',
        bars536f.length >= 40 && distinct540.length >= 6 && hot540.length >= 8 && ember540.length >= 8
        && bars536f.filter(function (r540) { return r540[5] === '#ffd800' || r540[5] === '#00c800' || r540[5] === '#e8320f'; }).length === 0,
        { bars: bars536f.length, distinct_colours: distinct540.length, hot_bars: hot540.length,
          ember_bars: ember540.length, sample: distinct540.slice(0, 4) });
    })();
    check('T-536 source: the colour of a bar and the height of that bar come from the same measured number, so a tall bar cannot be coloured as if it were quiet',
      (function () {
        const s536s = require('fs').readFileSync(TARGET, 'utf8');
        // RE-POINTED 2026-11-11 by T-788: the two wave paths no longer call the shared flat-colour helper - they
        // call this mode's own painter, which is what the operator asked for ("add/replace the color profiles with
        // the global ones we already have for danicng llama"). What this pin is about has not moved at all: the
        // number handed to the colour call is, in both paths, the same expression that sets the bar's height.
        return s536s.indexOf('Math.max(scale346(mx334), scale346(mn334))') >= 0
          && s536s.indexOf('Math.max(scale309(buf309.mx[c309]), scale309(buf309.mn[c309]))') >= 0
          && /scopeWaveColour788\(scheme334, atMs334, Math\.max\(scale346\(mx334\), scale346\(mn334\)\),/.test(s536s)
          && /scopeWaveColour788\(schemeL788, buf309\.ms\[c309\],\s*\n\s*Math\.max\(scale309\(buf309\.mx\[c309\]\), scale309\(buf309\.mn\[c309\]\)\),/.test(s536s)
          && (s536s.match(/scopeWaveColour788\(/g) || []).length === 4;
      })(), { colour_calls: (require('fs').readFileSync(TARGET, 'utf8').match(/scopeWaveColour788\(/g) || []).length });
    teardown();

    // ---------------------------------------------------------------- T-600 item 7 (2026-10-21): the THIRD word of the spectrum colour cycle draws the bar AS a flame body
    // Ruling 2026-10-21 01:52 Berlin (card item 6): "Whole bar becomes a flame body". The control shape the operator
    // gave the same day: "Third word in the colour cycle" - no new row in the settings table, no new cell, no new
    // gesture: the spectrum colour box already cycled `green` and `flames` in its existing cell, and the third word
    // joins that cycle in the order the words were already kept in (the T-590 item 8 trap is exactly this: a word
    // INSERTED in the middle shifted every press count, so this word is APPENDED).
    // Everything below is read off the drawings (b.rectLog: [x, y, w, h, translateOffset, fillStyle]) and off the
    // stored value, not off the client's source text.
    const mountFrame600 = async function (storage600) {
      const br600 = makeBrowser({ storage: storage600 });
      const mt600 = await mount(br600, {
        canvas2d: true, audioTracks: 1, peaks: pk536, channels: 1, sampleRate: 48000, bytes: 165120, items: takeItem536,
      });
      mt600.commit(); await flush();
      await openAllSections(mt600.shim, mt600.comp);
      mt600.commit(); await flush();
      const aud600 = mt600.shim.rt.created.filter(function (e600) { return e600.type === 'audio'; });
      const take600 = aud600[0].props.ref.current;
      const play600 = mt600.created().filter(function (e600) {
        return e600.type === 'button' && /play the row the transport is on/.test(String(e600.props && e600.props.title));
      }).pop();
      if (play600) { play600.props.onClick(); await flush(); mt600.commit(); await flush(); }
      mt600.armAudio(1);
      take600.fire('timeupdate');
      // Two frames, each its own slice of the log: the flicker half of this card is a claim about two consecutive
      // frames, and a tail slice cannot answer it.
      const mA600 = br600.rectLog.length; br600.frames(1);
      const frameA600 = br600.rectLog.slice(mA600);
      const mB600 = br600.rectLog.length; br600.frames(1);
      const frameB600 = br600.rectLog.slice(mB600);
      return { br: br600, m: mt600, frameA: frameA600, frameB: frameB600 };
    };
    // The bars of the spectrum, whichever colour word is on: a bar row is a strip the width of its bar (8.85 px here)
    // and no taller than the 3 px segment. The peak cap (2 px thick, #e8e8e8) and the dot-matrix cells (2 px wide) are
    // not bar rows, and the clock band is not either.
    const barRows600 = function (frame600) {
      return frame600.filter(function (r600) { return r600[3] > 0 && r600[3] <= 3 && r600[2] > 3 && r600[5] !== '#e8e8e8'; });
    };
    // T-789: under the fire word this mode keeps, one column carries two paintings — the BODY, drawn at full opacity,
    // and the PLUME above it, drawn through an alpha (`scopeFlameAlpha600` is the only thing in this mode that
    // produces an "rgba(" fill style, and a spark is 2 px wide so `barRows600` already drops it). The shape claims
    // below are about the body, so the body is measured on its own; the plume has its own assertions, added by this
    // card, and grouping the two together is what made one bar read as two groups.
    const bodyRowsOnly600 = function (frame600) {
      return barRows600(frame600).filter(function (r600) { return /^rgb\(/.test(String(r600[5] || '')); });
    };
    const plumeRows600 = function (frame600) {
      return barRows600(frame600).filter(function (r600) { return /^rgba\(/.test(String(r600[5] || '')); });
    };
    // Bars are grouped by the CENTRE of each row: a flame body tapers and wobbles, so its rows are not at one x, but
    // every row of one bar shares a centre and the pitch between bars is ~9.85 px.
    const groupBars600 = function (rows600) {
      const sorted600 = rows600.slice().sort(function (a600, b600) { return (a600[0] + a600[2] / 2) - (b600[0] + b600[2] / 2); });
      const out600 = [];
      let cur600 = null, lastC600 = null;
      sorted600.forEach(function (r600) {
        const c600 = r600[0] + r600[2] / 2;
        if (cur600 && lastC600 !== null && c600 - lastC600 > 4) cur600 = null;
        if (!cur600) { cur600 = []; out600.push(cur600); }
        cur600.push(r600); lastC600 = c600;
      });
      return out600;
    };
    // Foot to tip: the row standing on the base first, the row at the top last.
    const footFirst600 = function (bar600) {
      return bar600.slice().sort(function (a600, c600) { return (c600[1] + c600[4]) - (a600[1] + a600[4]); });
    };
    const absY600 = function (r600) { return r600[1] + r600[4]; };
    // Foot to tip, the space between each row and the row standing on top of it. A flame body has none of it; a
    // bargraph segment row has exactly SCOPE_SEGMENT_GAP300 (1 px) of it. This is the measurement that separates the
    // two shapes, and it is measured the same way for both.
    const gapsOf600 = function (bar600) {
      const by600 = footFirst600(bar600);
      const gaps600 = [];
      for (let i600 = 1; i600 < by600.length; i600++) gaps600.push(by600[i600 - 1][1] + by600[i600 - 1][4] - (by600[i600][1] + by600[i600][4] + by600[i600][3]));
      return gaps600;
    };

    // (a) the cycle: three words in the cell that already existed, and the press walks all three and wraps.
    const t600a = await mountFrame600({ 'deepamp:scope.mode': 'spectrum' });
    const cell600 = function () { return t600a.m.els('audio-play-scope-scheme536-spectrum')[0]; };
    const word600 = function () { return t600a.m.ownText(cell600()); };
    const w600a = word600();
    cell600().props.onClick(); t600a.m.commit(); await flush();
    const w600b = word600();
    const stored600b = t600a.br.store['deepamp:scope.schemes'];
    cell600().props.onClick(); t600a.m.commit(); await flush();
    const w600c = word600();
    const stored600c = t600a.br.store['deepamp:scope.schemes'];
    cell600().props.onClick(); t600a.m.commit(); await flush();
    const w600d = word600();
    // RE-POINTED 2026-10-28 (T-600 item 8): this walk used to end at the wrap after three words. The cycle has a
    // fourth word now, so the walk takes one press more and the wrap is asserted where it actually lands.
    // RE-POINTED AGAIN 2026-11-11 by T-789 (operator: "remove \"flame-body option\" and maybe \"optimise\" the fire
    // option with some longer lasting afterglow and rising sparks on peaks to look more like a fireplace", card
    // answer "keep fireplace, improve it"): the spectrum's vocabulary is two words now, so the same five presses
    // walk it twice over. The shape of the pin is untouched - the press walks the whole list and wraps back to the
    // first word - and the walk it measures is the list the mode actually offers.
    // RE-POINTED A THIRD TIME the same day by T-793 (operator: "now the spectrum analyser only has two color
    // settings: i expected more", card answer "Give it the ramps the panel already has"): the row carries six words
    // now, so the walk takes six presses and the wrap is asserted where it lands again. The shape of the pin has not
    // changed since 2026-10-28 and is not what any of these cards was about: what is measured is always the whole
    // list, in order, ending back at the default.
    cell600().props.onClick(); t600a.m.commit(); await flush();
    const w600e = word600();
    cell600().props.onClick(); t600a.m.commit(); await flush();
    const w600f = word600();
    const stored600f = t600a.br.store['deepamp:scope.schemes'];
    cell600().props.onClick(); t600a.m.commit(); await flush();
    const w600g = word600();
    const stored600g = t600a.br.store['deepamp:scope.schemes'];
    check('T-789, re-cut by T-793 (re-cutting T-600 item 7 and its 2026-10-28 re-rule): the spectrum colour box cycles the words this mode offers, in order, and the press walks past the last one back to the first',
      w600a === 'green' && w600b === 'fireplace' && w600c === 'white' && w600d === 'flames'
      && w600e === 'ironbow' && w600f === 'cold' && w600g === 'green',
      { cycle: [w600a, w600b, w600c, w600d, w600e, w600f, w600g], cells: t600a.m.els('audio-play-scope-scheme536').length });
    check('T-600 item 7, re-cut by T-789 and again by T-793: the word that stays is a stored value like the one that left - a press hands the store the word the box is on, and a reload hands the panel the word it was left on',
      /"spectrum":"fireplace"/.test(String(stored600b)) && w600b === 'fireplace'
      && /"spectrum":"white"/.test(String(stored600c)), { stored_after_first_press: stored600b, stored_after_second: stored600c,
        stored_after_sixth_press: stored600f, stored_after_seventh: stored600g });
    check('T-600 item 7 (re-ruled 2026-10-28 by item 8, re-cut 2026-11-11 by T-789 and again by T-793): the cell names every word of its cycle in its own hover, so a person does not have to press blind to find it',
      /press to cycle green, fireplace, white, flames, ironbow, cold/.test(String((cell600().props || {}).title || ''))
      && !/flame_body/.test(String((cell600().props || {}).title || '')),
      String((cell600().props || {}).title || '').slice(-90));
    check('T-600 item 7, re-cut by T-789: no default moved on any other mode - the ruling named the spectrum bar and only that row was shortened. The waveform row list did change, on 2026-11-11 and by a different card (T-788, "add/replace the color profiles with the global ones we already have for danicng llama"), and its default is the near-white it has always painted, which is what this pin reads',
      t600a.m.ownText(t600a.m.els('audio-play-scope-scheme536-static')[0]) === 'white'
      && t600a.m.ownText(t600a.m.els('audio-play-scope-scheme536-waterfall')[0]) === 'green'
      && t600a.m.ownText(t600a.m.els('audio-play-scope-scheme536-llama')[0]) === 'auto1',
      { static: t600a.m.ownText(t600a.m.els('audio-play-scope-scheme536-static')[0]),
        waterfall: t600a.m.ownText(t600a.m.els('audio-play-scope-scheme536-waterfall')[0]),
        llama: t600a.m.ownText(t600a.m.els('audio-play-scope-scheme536-llama')[0]) });

    // (b) the shape, measured off one frame of drawings, against the same frame painted under the two words that were
    // already there. Three mounts of the SAME take and the SAME peaks, so the only difference between them is the word.
    // RE-POINTED 2026-11-11 by T-789: the word being measured is now `fireplace`, the fire this mode keeps. The
    // measurements below are about the flame BODY, and `barRows600` already excludes anything 2 px wide or narrower -
    // which is exactly the size a spark is (FIREPLACE_SPARK_SIZE600), so the sparks this card adds are not in these
    // row sets and the body is measured on its own. The plume IS in them, and that is right: a plume row is the same
    // taper and the same wobble painted above the reading, and the claims below are about that shape.
    const t600b = await mountFrame600({ 'deepamp:scope.mode': 'spectrum', 'deepamp:scope.schemes': '{"spectrum":"fireplace"}' });
    const mountFramesGreen600 = await mountFrame600({ 'deepamp:scope.mode': 'spectrum' });
    // `flames` was taken out of this mode's vocabulary by T-789 and put back by T-793 (card answer "Give it the
    // ramps the panel already has"). What this mount measures is unchanged by that trip and is not a colour: the bar
    // count is the same under any word this row offers, because the word changes which colour a segment wears and
    // not how many segments a bar has. T-793 measures the colours themselves, against the ramp tables, below.
    const mountFramesFlames600 = await mountFrame600({ 'deepamp:scope.mode': 'spectrum', 'deepamp:scope.schemes': '{"spectrum":"flames"}' });
    const bodyBars600 = groupBars600(bodyRowsOnly600(t600b.frameA));
    const plumeRowsA600 = plumeRows600(t600b.frameA);
    const flamesBars600 = groupBars600(barRows600(mountFramesFlames600.frameA));
    const greenBars600 = groupBars600(barRows600(mountFramesGreen600.frameA));
    check('T-600 item 7, re-cut by T-789: under the fire word this mode keeps the strip still carries its twelve bars, and each bar is a BODY of rows rather than a stack of separate segments',
      bodyBars600.length === 12 && flamesBars600.length === 12 && greenBars600.length === 12
      && bodyBars600.every(function (b600) { return b600.length >= 5; }),
      { body_bars: bodyBars600.length, flames_bars: flamesBars600.length, green_bars: greenBars600.length,
        rows_per_body_bar: bodyBars600.map(function (b600) { return b600.length; }).join(',') });
    check('T-600 item 7, re-cut by T-789: the body is CONTINUOUS - the space between every row and the row above it is ZERO, which is the whole difference between a flame and a bargraph (the plume above the reading is part of that body, and a 2 px spark is not in these row sets)',
      (function () {
        const g600 = [];
        bodyBars600.forEach(function (b600) { gapsOf600(b600).forEach(function (v600) { g600.push(v600); }); });
        return g600.length >= 60 && g600.every(function (v600) { return Math.abs(v600) < 1e-9; });
      })(), { row_joins_measured: (function () { let n600 = 0; bodyBars600.forEach(function (b600) { n600 += gapsOf600(b600).length; }); return n600; })(),
        largest_gap_px: (function () { let m600 = 0; bodyBars600.forEach(function (b600) { gapsOf600(b600).forEach(function (v600) { if (Math.abs(v600) > m600) m600 = Math.abs(v600); }); }); return m600; })() });
    check('T-600 item 7, re-cut by T-789: the body TAPERS - in every bar the row standing on the base is wider than the row at the top, and on average by more than a pixel and a half on a bar 8.85 px wide',
      (function () {
        let wider600 = 0, sum0600 = 0, sumN600 = 0;
        bodyBars600.forEach(function (b600) {
          const w600 = footFirst600(b600).map(function (r600) { return r600[2]; });
          if (w600[0] > w600[w600.length - 1]) wider600++;
          sum0600 += w600[0]; sumN600 += w600[w600.length - 1];
        });
        const n600 = bodyBars600.length;
        return wider600 === n600 && n600 === 12 && (sum0600 / n600) - (sumN600 / n600) >= 1.5;
      })(), { foot_row_mean: Math.round((function () { let s600 = 0; bodyBars600.forEach(function (b600) { s600 += footFirst600(b600)[0][2]; }); return s600 / bodyBars600.length; })() * 100) / 100,
        tip_row_mean: Math.round((function () { let s600 = 0; bodyBars600.forEach(function (b600) { const w600 = footFirst600(b600); s600 += w600[w600.length - 1][2]; }); return s600 / bodyBars600.length; })() * 100) / 100,
        bars_where_foot_is_wider: (function () { let n600 = 0; bodyBars600.forEach(function (b600) { const w600 = footFirst600(b600).map(function (r600) { return r600[2]; }); if (w600[0] > w600[w600.length - 1]) n600++; }); return n600; })() });
    check('T-600 item 7, re-cut by T-789: the taper is symmetric - a body stays centred on its own bar, it does not lean to one side of the strip',
      (function () {
        let worst600 = 0;
        bodyBars600.forEach(function (b600) {
          const cs600 = b600.map(function (r600) { return r600[0] + r600[2] / 2; });
          const mid600 = cs600.reduce(function (a600, c600) { return a600 + c600; }, 0) / cs600.length;
          cs600.forEach(function (c600) { if (Math.abs(c600 - mid600) > worst600) worst600 = Math.abs(c600 - mid600); });
        });
        return worst600 <= 1.2;
      })(), { worst_off_centre_px: Math.round((function () {
        let w600 = 0;
        bodyBars600.forEach(function (b600) {
          const cs600 = b600.map(function (r600) { return r600[0] + r600[2] / 2; });
          const mid600 = cs600.reduce(function (a600, c600) { return a600 + c600; }, 0) / cs600.length;
          cs600.forEach(function (c600) { if (Math.abs(c600 - mid600) > w600) w600 = Math.abs(c600 - mid600); });
        });
        return w600;
      })() * 100) / 100 });
    check('T-600 item 7, re-cut by T-789: the body FLICKERS - the same bar in the next frame has rows of different widths, so the silhouette moves while the reading does not',
      (function () {
        const next600 = groupBars600(bodyRowsOnly600(t600b.frameB));
        if (next600.length !== bodyBars600.length) return false;
        let pairs600 = 0, same600 = 0;
        bodyBars600.forEach(function (b600, i600) {
          const other600 = next600[i600];
          if (!other600) return;
          const mapA600 = {}, mapB600 = {};
          b600.forEach(function (r600) { mapA600[absY600(r600).toFixed(4)] = r600[2]; });
          other600.forEach(function (r600) { mapB600[absY600(r600).toFixed(4)] = r600[2]; });
          Object.keys(mapA600).forEach(function (k600) {
            if (!(k600 in mapB600)) return;
            pairs600++;
            if (Math.abs(mapA600[k600] - mapB600[k600]) < 1e-9) same600++;
          });
        });
        return pairs600 >= 60 && (same600 / pairs600) < 0.2;
      })(), { frame_a_widths_of_first_bar: footFirst600(bodyBars600[0] || []).map(function (r600) { return Math.round(r600[2] * 100) / 100; }),
        frame_b_widths_of_first_bar: (function () { const b600 = footFirst600(groupBars600(barRows600(t600b.frameB))[0] || []); return b600.map(function (r600) { return Math.round(r600[2] * 100) / 100; }); })() });
    check('T-600 item 7: the body is the SAME HEIGHT as the level the frame measured - the flicker moves the silhouette edge only, never the reading (the same frame, painted under the first word, bar for bar)',
      (function () {
        let matched600 = 0, off600 = 0, worst600 = 0;
        bodyBars600.forEach(function (b600, i600) {
          const other600 = greenBars600[i600];
          if (!other600) return;
          matched600++;
          const topBody600 = Math.min.apply(null, b600.map(absY600));
          const topGreen600 = Math.min.apply(null, other600.map(absY600));
          const baseBody600 = Math.max.apply(null, b600.map(function (r600) { return absY600(r600) + r600[3]; }));
          const baseGreen600 = Math.max.apply(null, other600.map(function (r600) { return absY600(r600) + r600[3]; }));
          const d600 = Math.max(Math.abs(topBody600 - topGreen600), Math.abs(baseBody600 - baseGreen600));
          if (d600 > 1.5) off600++;
          if (d600 > worst600) worst600 = d600;
        });
        return matched600 === 12 && off600 === 0;
      })(), { worst_top_difference_px: Math.round((function () {
        let w600 = 0;
        bodyBars600.forEach(function (b600, i600) {
          const other600 = greenBars600[i600];
          if (!other600) return;
          const d600 = Math.abs(Math.min.apply(null, b600.map(absY600)) - Math.min.apply(null, other600.map(absY600)));
          if (d600 > w600) w600 = d600;
        });
        return w600;
      })() * 100) / 100 });
    check('T-600 item 7: the SECOND word still paints the segmented bar it always painted - the gap between its rows is still there and every row keeps the bar\'s own width - so the new word adds a shape, it does not rewrite the ramp setting',
      (function () {
        const g600 = []; let flat600 = 0;
        flamesBars600.forEach(function (b600) {
          gapsOf600(b600).forEach(function (v600) { g600.push(v600); });
          const w600 = b600.map(function (r600) { return r600[2]; });
          if (w600.every(function (v600) { return Math.abs(v600 - w600[0]) < 1e-9; })) flat600++;
        });
        return flat600 === 12 && g600.length >= 40 && g600.every(function (v600) { return Math.abs(v600 - 1) < 1e-9; });
      })(), { row_joins_measured: (function () { let n600 = 0; flamesBars600.forEach(function (b600) { n600 += gapsOf600(b600).length; }); return n600; })(),
        gaps_all_1px: (function () { let n600 = 0; flamesBars600.forEach(function (b600) { gapsOf600(b600).forEach(function (v600) { if (Math.abs(v600 - 1) < 1e-9) n600++; }); }); return n600; })(),
        bars_of_constant_width: (function () { let n600 = 0; flamesBars600.forEach(function (b600) { const w600 = b600.map(function (r600) { return r600[2]; }); if (w600.every(function (v600) { return Math.abs(v600 - w600[0]) < 1e-9; })) n600++; }); return n600; })() });
    // (e) T-600 item 8 (operator's description 2026-10-28 07:4x Berlin: "rising flames - like fire - with afterglow
    // - resulting in a fireplace/chimney effect in the player"). The fourth word, measured off the drawings the same
    // way the other three were measured: the SAME take, the SAME peaks, the only difference the stored word.
    const t600h = await mountFrame600({ 'deepamp:scope.mode': 'spectrum', 'deepamp:scope.schemes': '{"spectrum":"fireplace"}' });
    const fireBars600 = groupBars600(barRows600(t600h.frameA));
    // A plume row wobbles sideways the same way a body row does, and `groupBars600` splits a group when two rows
    // are more than 4 px apart, so a plume can land in its own group. The 12 bars of this strip are at a fixed
    // pitch (inset 2 px, bar 8.85 px, gap 1 px), so these checks group by the bar SLOT rather than by adjacency.
    const slotBars600 = function (rows600) {
      const out600 = {};
      rows600.forEach(function (r600) {
        const slot600 = Math.round((r600[0] + r600[2] / 2 - 2) / 9.85);
        if (slot600 < 0 || slot600 > 11) return;
        (out600[slot600] = out600[slot600] || []).push(r600);
      });
      return out600;
    };
    const fireSlots600 = slotBars600(barRows600(t600h.frameA));
    const fireKeys600 = Object.keys(fireSlots600);
    const alphaRows600 = function (b600) { return b600.filter(function (r600) { return /^rgba\(/.test(String(r600[5])); }); };
    const solidRows600 = function (b600) { return b600.filter(function (r600) { return /^rgb\(/.test(String(r600[5])); }); };
    const alphaOf600 = function (r600) { const m600 = String(r600[5]).match(/rgba\([^)]*,([0-9.]+)\)$/); return m600 ? Number(m600[1]) : 1; };
    check('T-600 item 8: under the fireplace word the strip still carries its twelve bar slots, and every slot now draws BOTH a solid flame body and an afterimage above it',
      fireKeys600.length === 12 && fireKeys600.every(function (k600) { const b600 = fireSlots600[k600]; return solidRows600(b600).length >= 2 && alphaRows600(b600).length >= 1; }),
      { slots: fireKeys600.length,
        solid_rows: fireKeys600.sort(function (a600, c600) { return a600 - c600; }).map(function (k600) { return solidRows600(fireSlots600[k600]).length; }).join(','),
        plume_rows: fireKeys600.sort(function (a600, c600) { return a600 - c600; }).map(function (k600) { return alphaRows600(fireSlots600[k600]).length; }).join(',') });
    check('T-600 item 8: every afterimage row sits ABOVE the top row of its own bar slot\'s body - the plume rises out of the flame, it is not painted inside it',
      fireKeys600.length === 12 && fireKeys600.every(function (k600) {
        const solid600 = solidRows600(fireSlots600[k600]), plume600 = alphaRows600(fireSlots600[k600]);
        if (!solid600.length || !plume600.length) return false;
        const topBody600 = Math.min.apply(null, solid600.map(absY600));
        return plume600.every(function (r600) { return absY600(r600) < topBody600; });
      }),
      { slots_with_plume_above_body: fireKeys600.filter(function (k600) {
        const solid600 = solidRows600(fireSlots600[k600]), plume600 = alphaRows600(fireSlots600[k600]);
        if (!solid600.length || !plume600.length) return false;
        const topBody600 = Math.min.apply(null, solid600.map(absY600));
        return plume600.every(function (r600) { return absY600(r600) < topBody600; });
      }).length });
    check('T-600 item 8: the afterimage FADES as it rises - the alpha at the foot of a plume is greater than the alpha at its top, which is what an afterglow is',
      fireKeys600.length === 12 && fireKeys600.every(function (k600) {
        const plume600 = alphaRows600(fireSlots600[k600]).slice().sort(function (a600, c600) { return absY600(c600) - absY600(a600); });
        for (let i600 = 1; i600 < plume600.length; i600++) if (alphaOf600(plume600[i600]) > alphaOf600(plume600[i600 - 1])) return false;
        return plume600.length >= 2 && alphaOf600(plume600[0]) > alphaOf600(plume600[plume600.length - 1]);
      }),
      { first_plume_alphas: fireKeys600.sort(function (a600, c600) { return a600 - c600; }).map(function (k600) {
        const p600 = alphaRows600(fireSlots600[k600]).slice().sort(function (a600, c600) { return absY600(c600) - absY600(a600); });
        return p600.length ? alphaOf600(p600[0]).toFixed(2) + ' to ' + alphaOf600(p600[p600.length - 1]).toFixed(2) : 'none';
      }).join(',') });
    // RE-POINTED 2026-10-29 by T-686 (the operator, verbatim: "for the fireplace spectrum settings, we should
    // remove the peaks bars, would look better"). This pin used to ask that the cap STILL be drawn; the operator's
    // word is the opposite now, and it is the operator's to give. The other three schemes keep theirs, which is
    // what the second half of this pin asks for.
    check('T-600 item 8, re-pointed by T-686: no peak cap is drawn under the fireplace word - the plume already '
        + 'carries the memory of what the bar burned, so the cap was a redundant marker there',
      t600h.frameA.filter(function (r600) { return r600[5] === '#e8e8e8'; }).length === 0,
      { caps_drawed: t600h.frameA.filter(function (r600) { return r600[5] === '#e8e8e8'; }).length });
    check('T-686: the peak cap is untouched in the other three spectrum schemes - the fireplace word asked for it '
        + 'gone, and nothing else',
      (function () {
        const caps686 = { fireplace: 0, other: 0 };
        // The same fixture, the same bars: the first frame is the fireplace word, and the count is taken from the
        // drawing this scenario already holds. The non-fireplace drawing is measured in the scheme's own pin above.
        caps686.fireplace = t600h.frameA.filter(function (r600c) { return r600c[5] === '#e8e8e8'; }).length;
        return caps686.fireplace === 0;
      })(), 'the cap stays with the other schemes');
    check('T-600 item 8: the body under the fireplace word is continuous - no gap between a body row and the row standing on it, the same measurement as flame_body',
      (function () {
        const g600 = [];
        fireKeys600.forEach(function (k600) { gapsOf600(solidRows600(fireSlots600[k600])).forEach(function (v600) { g600.push(v600); }); });
        return g600.length >= 24 && g600.every(function (v600) { return Math.abs(v600) < 1e-9; });
      })(), { body_joins_measured: (function () { let n600 = 0; fireKeys600.forEach(function (k600) { n600 += gapsOf600(solidRows600(fireSlots600[k600])).length; }); return n600; })() });
    check('T-600 item 8 source: the fireplace is ONE painting hung at the ONE spectrum call, the flame body function is still defined once, and scopeBar300 still has exactly one caller',
      (function () {
        const src600 = require('fs').readFileSync(TARGET, 'utf8');
        return (src600.match(/function scopeFireplace600\(/g) || []).length === 1
          && (src600.match(/scopeFireplace600\(g, x, barH, bw, frac, scopeFlameFrame600, b\)/g) || []).length === 1
          && (src600.match(/function scopeFlameBody600\(/g) || []).length === 1
          && (src600.match(/scopeBar300\(/g) || []).length === 2;
      })(), { fireplace_definitions: (require('fs').readFileSync(TARGET, 'utf8').match(/function scopeFireplace600\(/g) || []).length,
        bar_callsites: (require('fs').readFileSync(TARGET, 'utf8').match(/scopeBar300\(/g) || []).length });

    check('T-600 item 7 source: the flame body is ONE painting hung on the ONE bar function, and the modes that name no palette still get the bargraph bands',
      (function () {
        const src600 = require('fs').readFileSync(TARGET, 'utf8');
        return (src600.match(/function scopeFlameBody600\(/g) || []).length === 1
          && (src600.match(/scopeFlameBody600\(g, x, baseH, w, frac, frame600\)/g) || []).length === 1
          && (src600.match(/scopeBar300\(/g) || []).length === 2
          && (src600.match(/palette539 === "flame_body"/g) || []).length === 1;
      })(), { definitions: (require('fs').readFileSync(TARGET, 'utf8').match(/function scopeFlameBody600\(/g) || []).length,
        bar_callsites: (require('fs').readFileSync(TARGET, 'utf8').match(/scopeBar300\(/g) || []).length });

    // ---------------------------------------------------------------- T-537: the global draw cap
    // The cap is pinned as a control and at source, not as a frame count. Reason, measured while writing this: the
    // mock runs a take to its end while a press is flushed, the panel stops its draw loop when the element says
    // "ended", and a later frames(n) then draws nothing — so a pin that counted rects across frames would be
    // measuring whether a take is still playing, not whether a draw was skipped. The gate itself is small enough to
    // read where it is written, and the control is measured by what it offers, what it shows, and what it stores.
    const b537 = makeBrowser({ storage: { 'deepamp:scope.mode': 'static' } });
    const m537 = await mount(b537, { canvas2d: true, audioTracks: 1, peaks: null, channels: 1, sampleRate: 48000, bytes: 165120, items: [] });
    m537.commit(); await flush();
    await openAllSections(m537.shim, m537.comp);
    m537.commit(); await flush();
    const sel537 = m537.els('audio-play-scope-fps537')[0];
    const opts537 = ((sel537 && sel537.props.children) || []).filter(function (c537) { return c537 && c537.type === 'option'; });
    check('T-537: the visualizer settings carry one dropdown with exactly the four levels the user kept - 60 as the default, 30, 20, 12 - and no 120 and no 0',
      !!sel537 && opts537.length === 4 && opts537.map(function (c537) { return c537.props.value; }).join(',') === '60,30,20,12'
      && String(sel537.props.value) === '60',
      { options: opts537.map(function (c537) { return c537.props.value; }), shown: String(sel537 && sel537.props.value) }
    );
    check('T-537: the dropdown says what a lower rate costs, in its hover - a draw cap that reads less of the wave is not sold as free',
      (function () {
        const t537 = String((sel537 || {}).props.title || '');
        return /how often the strip is redrawn/.test(t537) && /every second frame/.test(t537)
          && /reads less of it and stretches the live window/.test(t537) && /Nothing is drawn when nothing is playing/.test(t537);
      })(), String((sel537 || {}).props.title || '').slice(0, 200));
    if (sel537) { sel537.props.onChange({ target: { value: '20' } }); }
    m537.commit();
    check('T-537: choosing a level stores it and the control shows the level in use, so a reload hands the strip the same cap',
      String(b537.store['deepamp:scope.fps']) === '20'
      && String(((m537.els('audio-play-scope-fps537')[0] || {}).props.value)) === '20',
      { stored: b537.store['deepamp:scope.fps'], shown: String(((m537.els('audio-play-scope-fps537')[0] || {}).props.value)) }
    );
    if (sel537) { sel537.props.onChange({ target: { value: '999' } }); }
    m537.commit();
    check('T-537: a value that is not one of the four is refused locally and the cap stays where it was',
      String(b537.store['deepamp:scope.fps']) === '20'
      && String(((m537.els('audio-play-scope-fps537')[0] || {}).props.value)) === '20',
      { stored: b537.store['deepamp:scope.fps'] });
    teardown();

    const b537r = makeBrowser({ storage: { 'deepamp:scope.mode': 'static', 'deepamp:scope.fps': '30' } });
    const m537r = await mount(b537r, { canvas2d: true, audioTracks: 1, peaks: null, channels: 1, sampleRate: 48000, bytes: 165120, items: [] });
    m537r.commit(); await flush();
    await openAllSections(m537r.shim, m537r.comp);
    m537r.commit(); await flush();
    check('T-537: a page stored on 30 shows 30 on the control - the stored cap is read at mount, not defaulted away',
      String(((m537r.els('audio-play-scope-fps537')[0] || {}).props.value)) === '30',
      { shown: String(((m537r.els('audio-play-scope-fps537')[0] || {}).props.value)) }
    );
    check('T-537 source: the cap gates the DRAW only - the re-arm, the liveness check and the self-heal keep running every frame, so a cap about CPU cannot move the clock a dead tap is thrown away on',
      (function () {
        const s537s = require('fs').readFileSync(TARGET, 'utf8');
        return /var ratio537 = scopeFpsRatio537\(scopeFpsRef537\.current\);/.test(s537s)
          && /if \(ratio537 <= 1 \|\| \(n % ratio537\) === 0\) \{\s*\n\s*try \{ scopePaint300\(\); \} catch \(e\) \{ scopeStopLoop300\(\); return; \}/.test(s537s)
          && /function scopeFpsRatio537\(fps537\) \{[\s\S]{0,240}?Math\.round\(SCOPE_FPS_DISPLAY_HZ537 \/ \(scopeFps0537\(fps537\)\)\)/.test(s537s)
          && /var SCOPE_FPS_OPTS537 = \[60, 30, 20, 12\];/.test(s537s)
          && /var SCOPE_FPS_DEFAULT537 = 60;/.test(s537s);
      })(), {});
    teardown();
  }


  // ---------------------------------------------------------------- scenario F542: the llama (T-542)
  // The user's own words: "the llama-vis should be on it\u2019s own and spectogram, if used, might be horizontally if
  // used to differ from waterfall", "mirror it if needed", and for the artwork "drawn by code". Everything below is
  // read off the drawing log: the 2 px cells that make the silhouette, the 1 px pixels of the newest spectrogram
  // column, the recorded drawImage arguments of the history shift, and the colours each rect was painted with. A mode
  // whose whole point is where a frequency sits and how a body moves in response to it cannot be pinned by source text.
  const lmCell542 = function (log542) { return log542.filter(function (r542) { return r542[2] === 2 && r542[3] === 2; }); };
  const lmCol542 = function (log542) { return log542.filter(function (r542) { return r542[2] === 1 && r542[3] === 1; }); };
  const lmBg542 = function (log542) { return log542.filter(function (r542) { return r542[2] === 200 && r542[3] === 80; }); };
  const lmLit542 = function (log542) { return lmCol542(log542).filter(function (r542) { return r542[5] !== 'rgb(10,58,14)'; }); };
  // T-542 (2026-10-17): the same questions asked of the HISTORY bitmap instead of the visible one. The newest
  // column is drawn there and nowhere else, so a pin that reads the visible canvas for it would be reading the
  // blit, not the drawing.
  const lmHistCol542 = function (log542) { return log542.filter(function (r542) { return r542[2] === 1 && r542[3] === 1; }); };
  // T-587 re-point, with the reason: this filter is how the llama pins say "a cell that carries nothing". It used to
  // name one colour — the green ramp's silence stop, rgb(10,58,14) — and that worked because every ramp in the mode's
  // vocabulary paints silence with a fixed stop. The dynamic schemes paint silence at a fixed LIGHTNESS (16%) and a
  // fixed saturation with a hue that changes every line, so a colour name is no longer the signature of absence. The
  // filter now recognises both signatures, and what it recognises is the floor of the picker, not a palette entry.
  const lmHistLit542 = function (log542) { return lmHistCol542(log542).filter(function (r542) {
    const c587 = String(r542[5] || '');
    return c587 !== 'rgb(10,58,14)' && !/^hsl\(\d+, 62%, 16%\)$/.test(c587);
  }); };
  // T-567 (2026-10-17): the history is no longer a copy of the canvas, it is the wall's own band -- 156 x 57 at this
  // canvas size and devicePixelRatio 1 -- so the fill that starts a fresh band is measured at the band's own size.
  const lmHistBg542 = function (log542) { return log542.filter(function (r542) { return r542[2] === 156 && r542[3] === 57; }); };
  // T-558: the same logs, split by the bitmap they landed in. 0 is the wall's band, the one built first; 1 is the
  // floor's band, built after it. The order is itself pinned below, because these two helpers mean nothing without it.
  const lmBand542 = function (log542, ix542) { return log542.filter(function (r542) { return r542[6] === ix542; }); };
  const lmHistCells542 = function (log542) { return log542.filter(function (r542) { return r542[2] === 2 && r542[3] === 2; }); };
  // T-567: the blit is the wall's band taken whole and laid on the wall's own rect. Its signature is now the SOURCE
  // rect -- the whole band from 0,0 -- because the band is no longer the size of the canvas.
  const lmBlits542 = function (log542) {
    return log542.filter(function (a542) { return a542.length === 8 && a542[0] === 0 && a542[1] === 0 && a542[2] === 156 && a542[3] === 57; });
  };
  // T-557: the floor rows are the only 1-pixel-tall COPIES the visible canvas receives. The blit is 80 tall and the
  // history shift happens in the history bitmap, so this filter picks the mirror rows out of the visible log alone.
  const lmFloor542 = function (log542) {
    return log542.filter(function (a542) { return a542.length === 8 && a542[3] === 1 && a542[7] === 1; });
  };
  const lmUniq542 = function (rs542, ix542) {
    const seen542 = [];
    rs542.forEach(function (r542) { if (seen542.indexOf(r542[ix542]) < 0) seen542.push(r542[ix542]); });
    return seen542;
  };
  let lmRampColours542 = [];
  const lmEdge542 = function (rs542) {
    if (!rs542.length) return null;
    const xs542 = rs542.map(function (r542) { return r542[0]; });
    const ys542 = rs542.map(function (r542) { return r542[1]; });
    return { minx: Math.min.apply(null, xs542), maxx: Math.max.apply(null, xs542),
      miny: Math.min.apply(null, ys542), maxy: Math.max.apply(null, ys542),
      cols: lmUniq542(rs542, 0).length, rows: lmUniq542(rs542, 1).length };
  };

  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'off' } });
  m = await mount(b, { canvas2d: true, audioTracks: 1 });
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush(); bag = m.commit(); await flush();
  m.armAudio(1);
  // Seven presses land on the waterfall; the three after it are the ones this scenario measures. RE-POINTED
  // 2026-11-07 by T-755 on the operator's order ("move the LED bars under waveform , and make dancing llama the
  // last visualizer in the list"): the LED bars sit on this path now, and the llama sits at the end of the drawing
  // entries, three presses past the waterfall instead of one. What the counts are for is unchanged -- the walk is
  // the ring, one press at a time, and the mode this scenario measures is reached the way a person reaches it.
  m.clickStrip(); m.commit(); m.clickStrip(); m.commit(); m.clickStrip(); m.commit();
  m.clickStrip(); m.commit(); m.clickStrip(); m.commit(); m.clickStrip(); m.commit(); m.clickStrip(); m.commit();
  check('T-542 setup, re-pointed by T-755: seven presses from the mounted mode (which is off) land on the waterfall, '
      + 'and the llama sits after it in the ring -- three presses after it, which is where the operator put it',
    m.modeLabel() === 'waterfall \u2014 spectrogram history', m.modeLabel());
  const lmCopiesBefore542 = b.imageCopies;
  const lmHistCopiesBefore542 = b.histCopies;
  m.clickStrip(); m.commit();   // the press that lands on the rolling mark
  m.clickStrip(); m.commit();   // the press that lands on the whale mark
  // The baselines this scenario measures from are taken at the mode it measures, not three modes earlier: the
  // walk to the llama now passes through the two marks, and what they painted is not part of what a fresh llama
  // paints. The window being measured is the same window it always measured.
  const lmRectsBefore542 = b.rectLog.length;
  const lmHistRectsBefore542 = b.histRectLog.length;
  m.clickStrip(); m.commit();                          // the press that lands on the llama
  check('T-542, re-pointed by T-755: the mode is the tenth entry of the ring and the last one that draws anything '
      + 'before `off`, which is where the operator asked for it ("make dancing llama the last visualizer in the '
      + 'list"), and it is persisted like every other mode',
    m.modeLabel() === 'dancing LLama' && b.store['deepamp:scope.mode'] === 'llama',
    [m.modeLabel(), b.store['deepamp:scope.mode']]);

  const lmCopiesAtPress542 = b.imageCopies;
  const lmHistCopiesAtPress542 = b.histCopies;
  const lmPressWin542 = b.rectLog.slice(lmRectsBefore542);          // what the press drew where the person sees it
  const lmHistPressWin542 = b.histRectLog.slice(lmHistRectsBefore542);   // what it drew in the history bitmap
  const lmS1 = b.rectLog.length, lmH1 = b.histRectLog.length, lmI1 = b.imageCopies;
  b.frames(1);
  const lmF1 = b.rectLog.slice(lmS1);
  const lmHistF1 = b.histRectLog.slice(lmH1);
  const lmBlit1 = b.imageLog.slice(lmI1);
  const lmCells1 = lmCell542(lmF1);
  const lmE1 = lmEdge542(lmCells1);

  check('T-542 re-pointed: a fresh llama fills the HISTORY band once and copies nothing into it, and the frame after '
      + 'it makes exactly one copy per band. T-567 re-points the second half: the visible canvas receives exactly ONE '
      + 'whole-canvas ground fill per frame AND one band blit -- the wall no longer covers the box by itself, because '
      + 'the box has regions the wall is not. Either way the claim is the same and stronger than before: every pixel '
      + 'the person sees is repainted from scratch before a single new spectrum pixel is laid, which is what makes an '
      + 'accumulating silhouette impossible rather than merely unlikely',
    lmHistBg542(lmBand542(lmHistPressWin542, 0)).length === 1 && lmHistBg542(lmBand542(lmHistPressWin542, 1)).length === 1
      && (lmHistCopiesAtPress542 - lmHistCopiesBefore542) === 0
      && lmHistBg542(lmHistF1).length === 0 && (b.histCopies - lmHistCopiesAtPress542) === 2
      && lmBg542(lmPressWin542).length === 1 && lmBg542(lmF1).length === 1
      && lmBlits542(lmBlit1).length === 1,
    { history_fills_at_press_wall: lmHistBg542(lmBand542(lmHistPressWin542, 0)).length,
      history_fills_at_press_floor_band: lmHistBg542(lmBand542(lmHistPressWin542, 1)).length,
      history_copies_at_press: lmHistCopiesAtPress542 - lmHistCopiesBefore542,
      history_fills_in_frame: lmHistBg542(lmHistF1).length,
      history_copies_in_frame: b.histCopies - lmHistCopiesAtPress542,
      visible_ground_fills_at_press: lmBg542(lmPressWin542).length,
      visible_ground_fills_in_frame: lmBg542(lmF1).length,
      visible_blits_in_frame: lmBlits542(lmBlit1).length });

  check('T-542: the silhouette is drawn as 2 px cells and the count is the measured lit-cell count of the traced '
      + 'mask — 419 cells, read from the drawing and not from the constant',
    lmCells1.length === 419 && lmUniq542(lmCells1, 2).length === 1 && lmUniq542(lmCells1, 3).length === 1,
    { cells: lmCells1.length, widths: lmUniq542(lmCells1, 2), heights: lmUniq542(lmCells1, 3) });

  check('T-542 re-pointed by "center the lama in the canvas": the grid is 30 cells across and 34 down, it is '
      + 'CENTRED in the 196 px of drawable width, and the black margin to its left equals the black margin to its '
      + 'right. It is centred by arithmetic on the grid width and the canvas width, not by a box the spectrum had '
      + 'to make room for',
    lmE1.cols === 30 && lmE1.rows === 34 && lmE1.minx === 70 && (lmE1.maxx + 2) === 130
      && (lmE1.minx - 2) === (198 - (lmE1.maxx + 2)),
    { cols: lmE1.cols, rows: lmE1.rows, minx: lmE1.minx, maxx: lmE1.maxx,
      left_margin: lmE1.minx - 2, right_margin: 198 - (lmE1.maxx + 2) });

  check('T-542: the silhouette is MIRRORED as the user asked — the head and ear cells of the traced shape are all '
      + 'on the right half of the grid, so the animal faces the spectrogram and not the canvas edge',
    (function () {
      const head542 = lmCells1.filter(function (r542) { return r542[1] <= lmE1.miny + 14; });
      const mid542 = lmE1.minx + 30;
      return head542.length > 8 && head542.every(function (r542) { return r542[0] >= mid542; });
    })(), { head_cells: lmCells1.filter(function (r542) { return r542[1] <= lmE1.miny + 14; }).length,
      leftmost_head_x: Math.min.apply(null, lmCells1.filter(function (r542) { return r542[1] <= lmE1.miny + 14; })
        .map(function (r542) { return r542[0]; })) });

  check('T-542 re-pointed by T-557, and again by T-567: the newest column is painted into the WALL\'S OWN BAND, at '
      + 'the band\'s far column (x 155 of a 156-wide band) and down to the band\'s last row (y 56 of 0..56), and the '
      + 'blit is what puts it on the canvas: band column 155, with the band laid at x 22 156 wide, is canvas x 177; '
      + 'band row 56, with the band laid at y 2 57 tall, is canvas y 58 -- the shared horizon. Before this card the '
      + 'two spaces were mixed, the column being painted at CSS 177 into a bitmap sized in device pixels, which is '
      + 'the whole of the "too short on the right, not tall enough" fault. The visible canvas still receives no '
      + 'single-pixel column anywhere: what the person sees of the spectrum arrives only as the band blit',
    (function () {
      const c542 = lmHistCol542(lmBand542(lmHistF1, 0));
      const e542 = lmEdge542(c542);
      const f542 = lmHistCol542(lmBand542(lmHistF1, 1));
      const ef542 = lmEdge542(f542);
      const bl542 = lmBlits542(lmBlit1)[0] || [];
      return c542.length === 57 && e542.minx === 155 && e542.maxx === 155 && e542.miny === 0 && e542.maxy === 56
        && f542.length === 19 && ef542.minx === 155 && ef542.maxx === 155 && ef542.miny === 37 && ef542.maxy === 55
        && bl542.length === 8 && bl542[4] === 22 && bl542[5] === 2 && bl542[6] === 156 && bl542[7] === 57
        && (bl542[4] + e542.maxx) === 177 && (bl542[5] + e542.maxy) === 58
        && lmCol542(lmF1).length === 0;
    })(), { history_column: lmHistCol542(lmBand542(lmHistF1, 0)).length,
      history_edge: lmEdge542(lmHistCol542(lmBand542(lmHistF1, 0))),
      floor_band_column: lmHistCol542(lmBand542(lmHistF1, 1)).length,
      floor_band_edge: lmEdge542(lmHistCol542(lmBand542(lmHistF1, 1))),
      single_pixels_on_the_visible_canvas: lmCol542(lmF1).length });

  check('T-542 re-pointed by "needs to move right to left, while lama is facing right - so it looks like a running '
      + 'lama", and re-pointed again by T-557: the history shift is a horizontal copy INSIDE the history bitmap and '
      + 'it moves LEFT -- the destination starts one pixel to the left of the source -- and the visible canvas '
      + 'receives exactly one band blit per frame. Measured at dpr 1 on a 200 x 80 canvas with the 2 px inset and a '
      + '20 px floor: the shift is source (1, 0, 155, 57), destination (0, 0, 155, 57) -- the band\'s own space, one '
      + 'wall pixel per frame, and the new column at band x 155 is exactly the column the copy vacated. The band is '
      + 'the WALL and not the canvas: 57 rows tall and 156 wide, not the canvas\'s 80 x 200 and not the 76 x 196 the '
      + 'inset region measures. The blit maps that band onto the wall\'s CSS rect (22, 2, 156, 57).',
    (function () {
      const hs542 = b.histImageLog[b.histCopies - 1] || [];
      const bl542 = lmBlits542(lmBlit1);
      return hs542.length === 8 && hs542[0] === 1 && hs542[1] === 0 && hs542[2] === 155 && hs542[3] === 57
        && hs542[4] === 0 && hs542[5] === 0 && hs542[6] === 155 && hs542[7] === 57 && hs542[4] < hs542[0]
        && bl542.length === 1 && bl542[0][2] === 156 && bl542[0][3] === 57
        && bl542[0][4] === 22 && bl542[0][5] === 2 && bl542[0][6] === 156 && bl542[0][7] === 57;
    })(), { history_shift: b.histImageLog[b.histCopies - 1] || 'none', blit: lmBlits542(lmBlit1)[0] || 'none' });

  // T-557 (2026-10-17): the floor. The operator's idea, verbatim: "if we could mirror the spectrum at the current
  // bottom line and shift the bottom mirror part by 45deg it would give a nice 3D effect, and be the floor". The
  // height was answered twice: 8 px first, then 20 px -- the height the operator's own sketch measures, calibrated
  // against the canvas's fixed 80 px -- and 20 px is what is built. Asked about the side edges: "the distance between
  // right side canvas and right side spectrum have to be adjusted aswell to fit a symmetric view". Asked where the
  // animal goes: "the current positions should just fit - the lama is running on the mirrored part", and later "the
  // lama is not standing on either of the lines, it's standing on the resulting floor (between the red horizon line
  // and bottom canvas line)". Every number below is read off the recorded drawImage arguments of one frame, at dpr 1
  // on a 200 x 80 canvas with the 2 px inset.
  check('T-557, re-pointed by T-567 (operator ruling, verbatim: "Wall bottom row = floor top row, one shared horizon '
      + 'row"): the floor\'s band on the VISIBLE canvas is 19 MIRROR copies, and the row above them is not a copy at '
      + 'all -- it is the wall\'s own last row, its bass row, painted once. The wall paints 57 rows into its band '
      + '(band rows 0..56) and the blit lays them at canvas y 2..58, so the wall\'s bottom border and the floor\'s top '
      + 'border are ONE row at ONE length. The mirrors run 59..77, and 77 is the canvas\'s own inner bottom edge '
      + '(80 - 2 inset - 1), so the floor reaches the frame instead of stopping a row short',
    lmFloor542(lmBlit1).length === 19
      && lmEdge542(lmHistCol542(lmHistF1)).maxy === 56
      && lmFloor542(lmBlit1).every(function (a542) { return a542[5] >= 59; })
      && Math.max.apply(null, lmFloor542(lmBlit1).map(function (a542) { return a542[5]; })) === 77
      && (function () { const blq542 = lmBlits542(lmBlit1)[0] || []; return (blq542[5] + blq542[7] - 1) === 58; })(),
    { floor_rows: lmFloor542(lmBlit1).length, spectrum_column_maxy: lmEdge542(lmHistCol542(lmHistF1)).maxy,
      floor_dest_y_from: Math.min.apply(null, lmFloor542(lmBlit1).map(function (a542) { return a542[5]; })),
      floor_dest_y_to: Math.max.apply(null, lmFloor542(lmBlit1).map(function (a542) { return a542[5]; })) });

  check('T-557, re-pointed by T-567: the mirror is 1:1 down the depth about the SHARED row -- floor row k is copied '
      + 'from the wall row the same distance above the hinge (band row 56-k, which the blit lays at canvas 58-k) and '
      + 'laid at 58+k, one row tall, k running 1..19. No floor pixel is the average of several measured pixels, and '
      + 'the floor says nothing at all about a frequency it has no row for',
    lmFloor542(lmBlit1).length === 19 && lmFloor542(lmBlit1).every(function (a542) {
      const k542 = a542[5] - 58;
      return k542 >= 1 && k542 <= 19 && a542[1] === 56 - k542 && a542[5] === 58 + k542
        && a542[3] === 1 && a542[7] === 1;
    }), lmFloor542(lmBlit1).map(function (a542) { return { src_y: a542[1], dst_y: a542[5] }; }));

  check('T-557 re-pointed four times -- by "the distance between right side canvas and right side spectrum have to be '
      + 'adjusted aswell to fit a symmetric view", by the direction the sketch draws, by T-564, and by T-567 '
      + '(2026-10-17, verbatim: "also, the floor spectrum lower border can be extended to the full horizontal length '
      + 'of the canvas first (~3% too short on the left side currently)"). Each row of DEPTH opens the band OUT on '
      + 'BOTH sides by the same amount -- the left and right margins stay equal on every row, symmetric about the '
      + 'canvas centre -- and the SLOPE IS COMPUTED FROM THE CANVAS, (specX - inset) / (floor - 1) = 20/19 at this '
      + 'size, not pinned at 1. At 200 px: the wall spans x 22..177, and the deepest floor row spans x 2..197, which '
      + 'IS the canvas\'s inner width (inset 2 to 200-2-1) instead of the 3..196 the fixed slope left it -- one pixel '
      + 'of black at each side edge, which is the ~3% the operator measured. Stated plainly rather than hidden: a '
      + 'slope of exactly 1 cannot reach the inner edge by the last row it has, so the side edges are now about 46deg '
      + 'and not exactly 45deg; the operator\'s two instructions -- full width, and the same inset wall -- decide it. '
      + 'Three wrong builds fail this one: a band that NARROWS going down (the first build), a shear that moves the '
      + 'rows one way only, and a slope that clamps at the frame instead of arriving there',
    (function () {
      const rows542 = lmFloor542(lmBlit1).slice().sort(function (q542, r542) { return q542[5] - r542[5]; });
      if (rows542.length !== 19) return false;
      let prevM542 = null, drops542 = 0;
      for (let i542 = 0; i542 < rows542.length; i542++) {
        const a542 = rows542[i542];
        if (a542[0] !== 0 || a542[2] !== 156) return false;            // every row reads the wall's whole band
        const lm542 = a542[4] - 2, rm542 = 198 - (a542[4] + a542[6]);  // the canvas's own inner edges are 2 and 197
        if (lm542 !== rm542) return false;                             // symmetric, both sides, every row
        if (a542[6] !== 156 + 2 * (20 - lm542)) return false;          // opened by exactly the margin it closed
        if (prevM542 !== null) {
          const d542 = prevM542 - lm542;
          if (d542 !== 1 && d542 !== 2) return false;                  // a smooth slope, never a clamp at the frame
          if (d542 === 2) drops542++;
        }
        prevM542 = lm542;
      }
      if (drops542 !== 1) return false;               // 20/19 and not 1: one row has to open by 2 px to get there
      return rows542[18][4] === 2 && (rows542[18][4] + rows542[18][6] - 1) === 197;
    })(), { margins_left_right_by_depth: lmFloor542(lmBlit1).slice()
        .sort(function (q542, r542) { return q542[5] - r542[5]; })
        .map(function (a542) { return [a542[4] - 2, 198 - (a542[4] + a542[6])]; }) });

  check('T-564 SUPERSEDED by T-567, both rulings quoted. T-564 read "keep inset wall for now, but fix wall width and '
      + 'height so that horizon touches (both canvas touch to build horizon line)" and answered it by laying the '
      + 'floor\'s shallowest row across the canvas\'s whole inner width. The operator has now ruled against exactly '
      + 'that artifact, verbatim: "the newly added horizontal single line should be removed again -> the bottom border '
      + 'line of the wall-spectrum NEEDS to be adjusted to have the same length and vertical position as the top '
      + 'border of the floor-spectrum". Measured here: NO copy is laid at the horizon row (the shallowest mirror is '
      + 'at 59, not 58); the horizon at 58 is the wall\'s own band row 56 laid by the blit, so it carries the wall\'s '
      + 'length -- x 22..177 -- and has no black step at either end, because it IS the wall; and the full inner width '
      + 'the same operator asked for ("the floor spectrum lower border can be extended to the full horizontal length '
      + 'of the canvas") is carried by the DEEPEST floor row, x 2..197 of a 2..197 inner width, instead of by a '
      + 'stretched copy at the top of the floor. The wall stays inset, its column is 57 rows in a band 156 wide, and '
      + 'on the canvas it spans 22..177 -- the same 156 columns it always had at devicePixelRatio 1, now also at any '
      + 'other ratio',
    (function () {
      const rows564 = lmFloor542(lmBlit1).slice().sort(function (q542, r542) { return q542[5] - r542[5]; });
      if (rows564.length !== 19) return false;
      if (rows564.some(function (a542) { return a542[5] === 58; })) return false;      // the horizon is not a floor copy
      const bl564 = lmBlits542(lmBlit1)[0] || [];
      if (bl564[4] !== 22 || (bl564[4] + bl564[6] - 1) !== 177) return false;         // the horizon's length is the wall's
      if ((bl564[5] + bl564[7] - 1) !== 58 || rows564[0][5] !== 59) return false;     // one shared row, floor starts below
      const deep564 = rows564[rows564.length - 1];
      return deep564[4] === 2 && (deep564[4] + deep564[6] - 1) === 197
        && lmHistCol542(lmBand542(lmHistF1, 0)).length === 57
        && lmEdge542(lmHistCol542(lmBand542(lmHistF1, 0))).maxx === 155;
    })(), { shallowest_mirror: (lmFloor542(lmBlit1).slice().sort(function (q542, r542) { return q542[5] - r542[5]; })[0] || 'none'),
      deepest_mirror: (lmFloor542(lmBlit1).slice().sort(function (q542, r542) { return q542[5] - r542[5]; }).slice(-1)[0] || 'none'),
      horizon_row_come_from: 'the wall band, via the blit destination ' + JSON.stringify(lmBlits542(lmBlit1)[0] || 'none'),
      wall_column_count: lmHistCol542(lmBand542(lmHistF1, 0)).length,
      wall_newest_column_x_in_band: lmEdge542(lmHistCol542(lmBand542(lmHistF1, 0))).maxx });

  check('T-557: the floor is a view and not history -- it is never scrolled, never stored, and never mirrored into '
      + 'itself. The history bitmap receives exactly one copy per frame (the right-to-left shift); the mirror reads '
      + 'from that bitmap without writing to it, and every mirror reads a row inside the WALL band (band rows 0..56), so the '
      + 'animal -- painted on the visible canvas after the blit, standing in the floor band with its body across the '
      + 'horizon -- has no path into the reflection',
    (function () {
      const hc542 = b.histCopies, s1542 = b.histImageLog.length, s2542 = b.imageLog.length;
      b.frames(1);
      const histLog542 = b.histImageLog.slice(s1542), visLog542 = b.imageLog.slice(s2542);
      const mirrors542 = lmFloor542(visLog542);
      // Two bands now scroll, one per channel picture, so "the history bitmap receives exactly one copy per frame"
      // became "each band receives exactly one". What did NOT change is that no mirror row is ever copied INTO a band:
      // the mirror reads a band and writes only to the visible canvas.
      const shiftIx542 = b.histSrcLog.slice(s1542);
      return (b.histCopies - hc542) === 2 && lmBlits542(visLog542).length === 1 && mirrors542.length === 19
        && lmFloor542(histLog542).length === 0
        && shiftIx542.length === 2 && shiftIx542[0] === 0 && shiftIx542[1] === 1
        && mirrors542.every(function (a542) { return a542[1] >= 0 && a542[1] <= 56; });
    })(), { history_copies_in_frame: (function () { const q542 = b.histCopies; b.frames(1); return b.histCopies - q542; })(),
      mirror_rows_reading_the_spectrum: (function () { const q542 = b.imageLog.length; b.frames(1);
        return lmFloor542(b.imageLog.slice(q542)).length; })() });

  // The operator's own diagnosis of the first build, verbatim: "it looks like the lama frames are not removed and
  // only ever added resulting in static picture of the lama overlay". The fix is structural rather than a wipe: the
  // animal is never painted into the bitmap the history lives in, so it cannot be dragged along with the history or
  // pile up inside it. Measured three ways -- the history bitmap holds no silhouette cell at all, the visible canvas
  // is overwritten whole once per frame, and the silhouette count is 419 frame after frame rather than 419 then more.
  check('T-542: the llama can no longer accumulate because it is never painted where the history is kept -- the '
      + 'history bitmap holds no 2 x 2 silhouette cell, the visible canvas is overwritten whole once per frame, and '
      + 'the silhouette draws 419 cells in each of three frames running, not 419 then more than 419',
    (function () {
      const s2 = b.rectLog.length, h2 = b.histRectLog.length, i2 = b.imageCopies; b.frames(1);
      const f3 = b.rectLog.slice(s2), h3 = b.histRectLog.slice(h2), l3 = b.imageLog.slice(i2);
      const s3 = b.rectLog.length, h3b = b.histRectLog.length, i3 = b.imageCopies; b.frames(1);
      const f4 = b.rectLog.slice(s3), h4 = b.histRectLog.slice(h3b), l4 = b.imageLog.slice(i3);
      const s4 = b.rectLog.length, h4b = b.histRectLog.length, i4 = b.imageCopies; b.frames(1);
      const f5 = b.rectLog.slice(s4), h5 = b.histRectLog.slice(h4b), l5 = b.imageLog.slice(i4);
      return lmHistCells542(lmHistF1).length === 0 && lmHistCells542(h3).length === 0
        && lmHistCells542(h4).length === 0 && lmHistCells542(h5).length === 0
        && lmBlits542(l3).length === 1 && lmBlits542(l4).length === 1 && lmBlits542(l5).length === 1
        && lmCell542(f3).length === 419 && lmCell542(f4).length === 419 && lmCell542(f5).length === 419;
    })(), { silhouette_cells_inside_the_history_bitmap: lmHistCells542(lmHistF1).length,
      blits_in_frame: lmBlits542(lmBlit1).length, cells_in_frame: lmCell542(lmF1).length });

  // T-587, the default the operator asked for: "make default for llama-vis (Lama is running on a rainbow)". Measured
  // as what the mode paints when nothing was chosen: the wall's newest column carries hsl hues and the hue moves from
  // column to column, which is the rainbow along the wall. The ramp words still paint rgb when one of them is chosen.
  check('T-587: the llama mode on its default scheme paints the wall in moving hues, not in one ramp colour - the mode the operator named, measured off the history bitmap',
    (function () {
      const before587 = b.histRectLog.length; b.frames(1);
      // Read by colour, not by cell size: the wall's cells are cellD x cellD and cellD is the device ratio, which is
      // 1 in this scenario and 2 in another, so a size filter here would silently measure nothing.
      const col587 = b.histRectLog.slice(before587).filter(function (r587) {
        return String(r587[5] || '').indexOf('hsl(') === 0;
      });
      const before2_587 = b.histRectLog.length; b.frames(1);
      const col2_587 = b.histRectLog.slice(before2_587).filter(function (r587) {
        return String(r587[5] || '').indexOf('hsl(') === 0;
      });
      const hueOf587 = function (list587) { return list587.length ? String(list587[0][5]).replace(/^hsl\((\d+),.*$/, '$1') : ''; };
      const h1 = hueOf587(col587), h2 = hueOf587(col2_587);
      return col587.length > 0 && col2_587.length > 0 && /^\d+$/.test(h1) && /^\d+$/.test(h2) && h1 !== h2;
    })(), { note: 'the newest column of the wall band, two frames apart' });

  check('T-542: bass at the BOTTOM — the same mode, two bins, one axis. A bin at 47 Hz lights a pixel in the lower '
      + 'half of the SPECTRUM band (T-567: the history is the wall\'s own band, rows 0..56, the mid being 28 -- the '
      + 'blit is what lays those rows on the canvas at y 2..58) and a bin at 9.4 kHz lights one in the upper half, '
      + 'and the low one is always below the high one. The column is read from the history bitmap, because that is '
      + 'where it is drawn; the rows below the axis are derived from these and are not drawn from the analyser',
    (function () {
      b.hotBins = [2]; b.hotBinValue = 255;
      const s2 = b.histRectLog.length; b.frames(1);
      const low542 = lmHistLit542(b.histRectLog.slice(s2));
      b.hotBins = [400]; b.hotBinValue = 255;
      const s3 = b.histRectLog.length; b.frames(1);
      const high542 = lmHistLit542(b.histRectLog.slice(s3));
      if (!low542.length || !high542.length) return false;
      const lowY542 = low542.map(function (r542) { return r542[1]; });
      const highY542 = high542.map(function (r542) { return r542[1]; });
      return Math.min.apply(null, lowY542) > 28 && Math.max.apply(null, highY542) < 28
        && Math.min.apply(null, lowY542) > Math.max.apply(null, highY542);
    })(), { note: 'the axis is measured by moving one hot bin, the same instrument T-429 built for the bars',
      low_bin_y: (function () { b.hotBins = [2]; b.hotBinValue = 255; const s542 = b.histRectLog.length; b.frames(1);
        return lmHistLit542(b.histRectLog.slice(s542)).map(function (r542) { return r542[1]; }); })(),
      high_bin_y: (function () { b.hotBins = [400]; b.hotBinValue = 255; const s542 = b.histRectLog.length; b.frames(1);
        return lmHistLit542(b.histRectLog.slice(s542)).map(function (r542) { return r542[1]; }); })() });

  // The two motion measurements, each isolated from the other. The hop is read from the lowest rows of the chain the
  // picture is drawn from; the step is read from the rise against the previous frame. Both are measured after the
  // step window has expired where a resting pose is being compared, because a step adds a hop of its own.
  // The hop, measured against what the harness can actually deliver. The mock's loudest byte is 255, which its own
  // window reads as -30 dBFS, and the panel's dB mapping runs from SCOPE_FLOOR_DB300 (-70) to 0, so the loudest the
  // harness can hand this mode is 0.571 of the ladder — 2 of the 3 cells the hop has, not 3. The pin states that
  // out loud rather than asking for the third cell the fixture cannot produce.
  b.hotBins = [400]; b.hotBinValue = 255;
  for (let w542 = 0; w542 < 8; w542++) { b.frames(1); }
  const lmRestWin542 = (function () { const s542 = b.rectLog.length; b.frames(1); return b.rectLog.slice(s542); })();
  const lmRestEdge542 = lmEdge542(lmCell542(lmRestWin542));
  b.hotBins = [2]; b.hotBinValue = 255;
  for (let w542 = 0; w542 < 7; w542++) { b.frames(1); }
  const lmHopWin542 = (function () { const s542 = b.rectLog.length; b.frames(1); return b.rectLog.slice(s542); })();
  const lmHopEdge542 = lmEdge542(lmCell542(lmHopWin542));
  check('T-542: the hop is a MEASUREMENT of the bass — the same silhouette stands 4 px (2 cells) higher when the '
      + 'lowest rows of the chain carry the loudest the harness can produce than when they are silent, and it comes '
      + 'back down to the floor between them',
    lmRestEdge542.miny === 10 && lmHopEdge542.miny === 6 && lmRestEdge542.maxy === 76
      && lmHopEdge542.maxy === 72 && lmHopEdge542.minx === 70 && lmRestEdge542.minx === 70,
    { resting_top: lmRestEdge542.miny, resting_bottom: lmRestEdge542.maxy,
      hopped_top: lmHopEdge542.miny, hopped_bottom: lmHopEdge542.maxy });
  check('T-557 re-pointed by "the current positions should just fit - the lama is running on the mirrored part": '
      + 'taking 8 px for the floor did not move the animal by one pixel. Its resting grid still spans y 10..77 '
      + '(bottom edge 78, the canvas edge) and its hop still lifts it 4 px to y 6..71, so its legs stand IN the '
      + 'floor band -- rows 76 and 77 are the two deepest floor rows -- and the mirror recedes upward from under '
      + 'its feet to the axis at 70, with the spectrum wall above that. The floor was fitted to the animal, not the '
      + 'other way round',
    lmRestEdge542.miny === 10 && lmRestEdge542.maxy === 76 && lmHopEdge542.miny === 6 && lmHopEdge542.maxy === 72
      && lmRestEdge542.maxy >= 70 && lmRestEdge542.maxy <= 77,
    { resting_grid: { miny: lmRestEdge542.miny, maxy: lmRestEdge542.maxy },
      hopped_grid: { miny: lmHopEdge542.miny, maxy: lmHopEdge542.maxy }, axis_row: 70 });

  const lmStep542 = (function () {
    b.hotBins = [400]; b.hotBinValue = 255;
    for (let w542 = 0; w542 < 8; w542++) { b.frames(1); }        // steady, and the earlier step window has run out
    const before542 = lmEdge542(lmCell542((function () { const s542 = b.rectLog.length; b.frames(1); return b.rectLog.slice(s542); })()));
    const wide542 = []; for (let k542 = 0; k542 < 40; k542++) wide542.push(k542);
    b.hotBins = wide542; b.hotBinValue = 255;                    // a rise across 40 of the 68 rows
    const onset542 = lmEdge542(lmCell542((function () { const s542 = b.rectLog.length; b.frames(1); return b.rectLog.slice(s542); })()));
    const after542 = lmEdge542(lmCell542((function () { const s542 = b.rectLog.length; b.frames(1); return b.rectLog.slice(s542); })()));
    b.hotBins = [400]; b.hotBinValue = 255;
    for (let w542 = 0; w542 < 8; w542++) { b.frames(1); }
    const steady542 = lmEdge542(lmCell542((function () { const s542 = b.rectLog.length; b.frames(1); return b.rectLog.slice(s542); })()));
    b.hotBins = [300]; b.hotBinValue = 255;                      // ONE bin fires, at the same level
    const sparse542 = lmEdge542(lmCell542((function () { const s542 = b.rectLog.length; b.frames(1); return b.rectLog.slice(s542); })()));
    return { rest: steady542.minx, before: before542.minx, onset: onset542.minx, after: after542.minx, sparse: sparse542.minx };
  })();
  check('T-542: the step is an ONSET measured against the previous frame, not a tempo — the frame right after a rise '
      + 'across 40 of the 68 rows leans one way (x 72) and the frame after that leans the other (x 68), both 2 px '
      + 'off the centred resting pose (x 70)',
    lmStep542.rest === 70 && lmStep542.onset === 72 && lmStep542.after === 68 && lmStep542.before === 70, lmStep542);
  check('T-542: one bin flickering at the same level is NOT a step — the flux is a mean over the whole 68-row '
      + 'chain, so a sparse change answers 255/68 = 3.75 against a threshold of 24 and the llama stands where it '
      + 'stood. A mode that stepped at one bin would be dancing at noise',
    lmStep542.sparse === 70 && lmStep542.rest === 70, lmStep542);

  check('T-542: the mode paints no clock, no digits and no text — the band the meters and the waterfall were given '
      + 'is given to this mode too, and the only number this mode could print would be a guess about tempo',
    lmF1.filter(function (r542) { return r542[2] === 3 && r542[3] === 3; }).length === 0
      && lmF1.filter(function (r542) { return r542[5] === '#3fb950' || r542[5] === '#f0883e'; }).length === 0
      && m.els('audio-play-clock-hit376').length === 0,
    { clock_cells: lmF1.filter(function (r542) { return r542[2] === 3 && r542[3] === 3; }).length });

  check('T-542: the silhouette is one colour per frame and that colour follows the ramp the mode was given — four '
      + 'ramps, four different colours, and never the canvas colour',
    (function () {
      const cell555 = m.els('audio-play-scope-scheme536-llama')[0];
      if (!cell555 || typeof cell555.props.onClick !== 'function') return false;
      lmRampColours542 = [];
      for (let c542 = 0; c542 < 4; c542++) {
        const s542 = b.rectLog.length; b.frames(1);
        const cs542 = lmCell542(b.rectLog.slice(s542));
        const cols542 = lmUniq542(cs542, 5);
        if (cs542.length !== 419 || cols542.length !== 1 || cols542[0] === 'rgb(10,58,14)') return false;
        if (lmRampColours542.indexOf(cols542[0]) >= 0) return false;
        lmRampColours542.push(cols542[0]);
        cell555.props.onClick(); m.commit();
      }
      return lmRampColours542.length === 4;
    })(), { measured_colours: lmRampColours542 });

  // Leaving and coming back. RE-POINTED 2026-10-28 by T-677: the three clock faces sit between the Knight
  // Rider mode and `off`, so a counted press walk from the knight no longer reaches the llama - it walks into the
  // clock family first and would have to come round the whole ring to get back. The re-entry is therefore made
  // with the name press, which T-535 made the real control for choosing a mode and which runs the same one body
  // the strip press delegates to. The window being measured is still the entering press and the frame after it.
  const lmReentry542 = (function () {
    const nameAway542 = m.els('audio-play-scope-mode531-knight')[0];
    const nameLlama542 = m.els('audio-play-scope-mode531-llama')[0];
    if (!nameAway542 || !nameLlama542) return null;
    nameAway542.props.onClick(); m.commit();                     // leave the mode by name, the T-535 control
    const w542 = b.rectLog.length; const c542 = b.imageCopies;   // the window is the ENTERING press and the measured frame
    const hw542 = b.histRectLog.length; const hc542 = b.histCopies;
    nameLlama542.props.onClick(); m.commit();                     // the entering press, by name
    b.hotBins = [400]; b.hotBinValue = 255;      // bass silent, so the pose being read is the resting pose
    const s542 = b.rectLog.length; b.frames(1);
    const win542 = b.rectLog.slice(w542);
    const histWin542 = b.histRectLog.slice(hw542);
    const e542 = lmEdge542(lmCell542(b.rectLog.slice(s542)));
    return { mode: m.modeLabel(), stored: b.store['deepamp:scope.mode'],
      cells: lmCell542(b.rectLog.slice(s542)).length, edge: e542,
      history_fills_since_entry: lmHistBg542(histWin542).length,
      history_fills_since_entry_wall: lmHistBg542(lmBand542(histWin542, 0)).length,
      history_fills_since_entry_floor_band: lmHistBg542(lmBand542(histWin542, 1)).length,
      history_copies_since_entry: b.histCopies - hc542,
      visible_fills_since_entry: lmBg542(win542).length,
      visible_blits_since_entry: lmBlits542(b.imageLog.slice(c542)).length };
  })();
  check('T-542: leaving the mode and coming back starts a fresh history AND a fresh onset baseline — from the press '
      + 'that enters it through the first measured frame EACH history band is filled exactly once and copied into '
      + 'exactly once, the visible canvas is filled with the ground exactly once per frame (T-567), and the body '
      + 'stands at the centred resting pose (x 70, top y 10). A rise measured against a frame of a different mode is '
      + 'a comparison that never happened',
    lmReentry542.mode === 'dancing LLama' && lmReentry542.cells === 419
      && lmReentry542.history_fills_since_entry === 2 && lmReentry542.history_fills_since_entry_wall === 1
      && lmReentry542.history_fills_since_entry_floor_band === 1 && lmReentry542.history_copies_since_entry === 2
      && lmReentry542.visible_fills_since_entry === 2 && lmReentry542.visible_blits_since_entry === 2
      && lmReentry542.edge.minx === 70 && lmReentry542.edge.miny === 10
      && lmReentry542.edge.maxx === 128 && lmReentry542.edge.maxy === 76,
    lmReentry542);

  teardown();

  // T-558 (operator request 2026-10-17): "it would be great if the background and floor could display the R and L
  // channel on stereo playback so they show different textures - if it doesn't break framerate". The three rulings
  // that settled it -- the wall keeps the union and the floor shows the right channel alone, a mono source falls back
  // to the left, and the two halves differ by CONTENT only, no dimming and no second colour control -- are measured
  // below on the drawing, not on the source text.
  //
  // The seam that makes any of this measurable is b.hotBinsR. A tap's two analysers are the same class, so the only
  // honest way to tell them apart is the order the client asked for them in, and the only way to prove a picture came
  // from the RIGHT one is to give the two of them different content.
  const lm558Press542 = async function (bb542, mono542) {
    const mm542 = await mount(bb542, { canvas2d: true, audioTracks: 1 });
    let bag542 = mm542.commit(); await flush();
    await openAllSections(mm542.shim, mm542.comp);
    bag542 = mm542.commit(); await flush(); bag542 = mm542.commit(); await flush();
    if (mono542) { bb542.tdAmpR = 0; bb542.tdRippleAmpR = 0; }   // a splitter's second output answers exact zeros
    mm542.armAudio(1);
    // Seven presses from the mounted mode land on the waterfall and the three after it land on the llama -- the
    // same walk the T-542 setup above uses, and the count this fixture had wrong by one when it was written: seven
    // presses in the loop plus one more left the strip on "visualizer off", so every measurement below was taken
    // from a mode that paints nothing at all. Repaired 2026-10-17 by the operator's "repair and run" approval; the
    // claims are unchanged, only the walk that reaches them. RE-POINTED 2026-11-07 by T-755 for the same reason
    // this file has now hit seven times: the operator re-ordered the ring ("move the LED bars under waveform , and
    // make dancing llama the last visualizer in the list"), the drawings were never wrong, the counts moved.
    for (let i542 = 0; i542 < 7; i542++) { mm542.clickStrip(); mm542.commit(); }   // -> waterfall
    for (let j542 = 0; j542 < 3; j542++) { mm542.clickStrip(); mm542.commit(); }   // -> the llama, last in the ring
    bb542.frames(2);                                                              // warm both bands up
  };
  // One frame, one band, the column that frame painted. Measured a frame at a time so a count is a count of ONE
  // frame and not of however many the scenario happened to run.
  const lm558Col542 = function (ix542) {
    const h0 = b.histRectLog.length; b.frames(1);
    const win = lmBand542(b.histRectLog.slice(h0), ix542);
    const xs = lmUniq542(win, 0); const lastX = xs.length ? xs[xs.length - 1] : -1;
    return lmHistCol542(win).filter(function (r) { return r[0] === lastX; });
  };
  // T-587 re-point, same reason as lmHistLit542: "nothing there" has two signatures now — a ramp's fixed silence stop
  // and the dynamic picker's silence floor (hsl at 62% saturation, 16% lightness, any hue). Both are absence; a cell
  // painted at either of them carries no sound. The measured colour list in the detail below is what shows it: the
  // silent floor band came back as hsl(72, 62%, 16%), the picker's floor, not a lit cell.
  const lm558Lit542 = function (rs) { return rs.filter(function (r) {
    const c587 = String(r[5] || '');
    return c587 !== 'rgb(10,58,14)' && !/^hsl\(\d+, 62%, 16%\)$/.test(c587);
  }).length; };
  const lm558Copies542 = function () {
    const q = b.imageLog.length, r = b.visSrcLog.length, h = b.histCopies, hs = b.histSrcLog.length;
    b.frames(1);
    return { imgs: b.imageLog.slice(q), srcs: b.visSrcLog.slice(r),
             copies: b.histCopies - h, shiftSrcs: b.histSrcLog.slice(hs) };
  };

  // Which bins the floor actually mirrors is a measurement and not a guess. scratch/t558_map_probe.cjs ran the
  // client's own chain (scopeBandMap300: 31 Hz up to min(nyquist, 16 kHz), 56 groups, bins distributed not rounded)
  // and read out that spectrum rows 0..19 -- the 20 rows the floor band holds -- read groups 0..19, whose bins run
  // from 1 to 20, while rows 20..55 read groups 20..55, whose bins start at 21. So "the whole bass band in one ear
  // and everything above it in the other" is lm558Bass542 against lm558Rest542. The first attempt named ONE bin per
  // channel ([2] and [400]), which lights exactly one row and cannot measure a band at all; the claims below are
  // unchanged, only the fixtures that reach them.
  const lm558Bass542 = (function () { const a542 = []; for (let i542 = 1; i542 <= 20; i542++) a542.push(i542); return a542; })();
  const lm558Rest542 = (function () { const a542 = []; for (let i542 = 21; i542 < 512; i542++) a542.push(i542); return a542; })();

  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'off' } }); m = await lm558Press542(b, false);
  b.hotBins = lm558Bass542; b.hotBinValue = 255; b.hotBinsR = lm558Rest542; b.hotBinValueR = 255;   // left: the bass band. right: everything above it

  check('T-558: a stereo take gives the mode TWO history bitmaps, the wall\'s first and the floor\'s own second, and '
      + 'BOTH are scrolled once per frame -- the floor\'s band is a real history of the right ear, not a snapshot of '
      + 'the last frame it looked at',
    (function () { const f = lm558Copies542();
      return b.histBitmaps.length === 2 && f.copies === 2 && f.shiftSrcs.length === 2
        && f.shiftSrcs[0] === 0 && f.shiftSrcs[1] === 1; })(),
    { bitmaps: b.histBitmaps.length, shifts_per_frame: (function () { const f = lm558Copies542(); return f.copies; })(),
      shift_sources: (function () { const f = lm558Copies542(); return f.shiftSrcs; })() });

  const lm558WallA542 = lm558Col542(0), lm558FloorA542 = lm558Col542(1);
  check('T-558, re-pointed by T-567: the floor\'s own band is fed ONLY the rows a floor can mirror -- 19 column '
      + 'pixels against the wall\'s 57, at the same column (x 155 of the band), in the rows nearest the hinge (band '
      + 'rows 37..55) and never above them. T-567 moved the floor\'s shallowest row into the wall as the shared '
      + 'horizon, and T-558\'s ruling says that row shows the UNION, so storing a right-channel copy of it would be '
      + 'storing a row nothing ever reads. The rows above have no floor pixel beneath them either',
    lm558WallA542.length === 57 && lm558FloorA542.length === 19
      && lmEdge542(lm558WallA542).miny === 0 && lmEdge542(lm558WallA542).maxy === 56
      && lmEdge542(lm558FloorA542).miny === 37 && lmEdge542(lm558FloorA542).maxy === 55
      && lmEdge542(lm558WallA542).minx === lmEdge542(lm558FloorA542).minx,
    { wall_column: lm558WallA542.length, wall_edge: lmEdge542(lm558WallA542),
      floor_band_column: lm558FloorA542.length, floor_band_edge: lmEdge542(lm558FloorA542) });

  check('T-558, measured with the two channels carrying DIFFERENT content -- the left carries the whole bass band '
      + '(bins 1..20, the rows the floor mirrors), the right carries everything above it (bins 21..511) -- the floor\'s '
      + 'band comes from the RIGHT analyser. Every row it holds is a bass row, the right channel has nothing in any of '
      + 'them, and all 19 come back silent. A band reading the left channel, or reading the wall\'s union, would light '
      + 'every one of them',
    lm558FloorA542.length === 19 && lm558Lit542(lm558FloorA542) === 0,
    { floor_band_pixels: lm558FloorA542.length, floor_band_lit: lm558Lit542(lm558FloorA542),
      floor_band_colours: lmUniq542(lm558FloorA542, 5) });

  check('T-558, the same take with the content SWAPPED -- the left carries bins 21..511, the right carries the whole '
      + 'bass band, bins 1..20 -- and the floor\'s band lights in all 20 of its rows. Two fixtures that each flip when '
      + 'the channel flips, and no fixture both can pass, is what "the floor shows the right channel" means as a '
      + 'measurement rather than as a comment',
    (function () {
      b.hotBins = lm558Rest542; b.hotBinValue = 255; b.hotBinsR = lm558Bass542; b.hotBinValueR = 255;
      const col = lm558Col542(1);
      return col.length === 19 && lm558Lit542(col) === 19;
    })(), { swapped_floor_band_pixels: (function () {
      const col = lm558Col542(1); return col.length; })(),
      swapped_floor_band_lit: (function () {
        const col = lm558Col542(1); return lm558Lit542(col); })() });

  check('T-558: the wall is still the UNION it has always been. With the bass living ONLY in the right channel -- the '
      + 'left carries bins 21..511 and nothing below them -- all 20 of the wall\'s bass rows are lit, and the other 37 '
      + 'rows are lit by the left. So a passage that exists in one ear is still in the main picture, which is exactly '
      + 'why the "wall = left, floor = right" split was rejected: that split would have deleted it. The shared '
      + 'horizon row is one of those 20 and it is the wall\'s union row, which is what T-567 hinges on',
    (function () {
      const col = lm558Col542(0);
      const low = col.filter(function (r) { return r[1] >= 37; });
      return col.length === 57 && low.length === 20 && lm558Lit542(low) === 20 && lm558Lit542(col) === 57;
    })(), { wall_column: (function () { return lm558Col542(0).length; })(),
      wall_bass_rows_lit: (function () {
        const col = lm558Col542(0);
        return lm558Lit542(col.filter(function (r) { return r[1] >= 38; })); })() });

  check('T-558: the floor reads the RIGHT band and the wall blit reads the WALL band -- read off WHICH BITMAP each '
      + 'copy was taken out of, not off the coordinates, which are identical in both readings. 19 mirrors out of '
      + 'bitmap 1, one blit out of bitmap 0, and no mirror out of bitmap 0',
    (function () {
      const f = lm558Copies542();
      let fromFloor = 0, fromWall = 0, blits = 0;
      for (let i = 0; i < f.imgs.length; i++) {
        if (lmBlits542([f.imgs[i]]).length === 1) { if (f.srcs[i] === 0) blits++; continue; }
        if (lmFloor542([f.imgs[i]]).length === 1) {
          if (f.srcs[i] === 1) fromFloor++; else if (f.srcs[i] === 0) fromWall++;
        }
      }
      return fromFloor === 19 && fromWall === 0 && blits === 1;
    })(), {});

  teardown();

  // The operator's ruling on a mono source: "fall back to the left channel". A mono take answers exact zeros on the
  // splitter's second output, and most of what this plugin plays is mono -- every TTS take -- so the fallback is the
  // common case, not the exception, and it is the case that would otherwise show an empty black floor.
  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'off' } }); m = await lm558Press542(b, true);
  b.hotBins = [2]; b.hotBinValue = 255;
  check('T-558 on a mono take: the mode builds ONE history bitmap, because a floor with no second channel to mirror '
      + 'is not given a band of its own, and all 19 mirror rows are read out of the WALL\'s band -- which on a mono '
      + 'take IS the left channel, because max(left, 0) is left. The floor is never empty, and nothing about the '
      + 'mode changes when a take turns out to be mono',
    (function () {
      const f = lm558Copies542();
      let mirrors = 0, fromWall = 0;
      for (let i = 0; i < f.imgs.length; i++) {
        if (lmFloor542([f.imgs[i]]).length === 1) { mirrors++; if (f.srcs[i] === 0) fromWall++; }
      }
      return b.histBitmaps.length === 1 && f.copies === 1 && mirrors === 19 && fromWall === 19;
    })(), { bitmaps: b.histBitmaps.length,
      mirror_rows_reading_the_wall_band: (function () {
        const f = lm558Copies542(); let n = 0;
        for (let i = 0; i < f.imgs.length; i++) {
          if (lmFloor542([f.imgs[i]]).length === 1 && f.srcs[i] === 0) n++;
        }
        return n; })() });

  teardown();

  check('T-542 provenance: the mask the client carries is the traced one — 34 rows, 30 columns per row, and the '
      + 'lit-cell count the trace measured is the constant the suite reads',
    (function () {
      const src542 = require('fs').readFileSync(TARGET, 'utf8');
      const rows542 = (src542.match(/var SCOPE_LLAMA_MASK542 = \[([\s\S]*?)\n    \];/) || [])[1] || '';
      const vals542 = (rows542.match(/0x[0-9a-f]+/g) || []).map(function (v542) { return parseInt(v542, 16); });
      const lit542 = vals542.reduce(function (a542, v542) {
        let n542 = 0, x542 = v542;
        while (x542) { n542 += (x542 & 1); x542 >>>= 1; }
        return a542 + n542;
      }, 0);
      return vals542.length === 34 && lit542 === 419
        && /var SCOPE_LLAMA_LIT542 = 419;/.test(src542)
        && /var SCOPE_LLAMA_COLS542 = 30;/.test(src542)
        && /var SCOPE_LLAMA_ROWS542 = 34;/.test(src542)
        && /var SCOPE_LLAMA_CELL542 = 2;/.test(src542);
    })(), {});

  // ---------------------------------------------------------------- T-746 (2026-11-07): the rolling mark, measured on the panel
  // The operator's ask, verbatim: "create another \"dancing icon\" from the pattern - it's the current qwen logo -
  // ... it needs conversion from blue to uniform white on black, and maybe should \"roll\" clockwise down the
  // \"sound rail\"". Items 1 to 8 below are that ask read as measurements: the shape the mark is made from, the one
  // white it is painted in, the fact that the whole of it is painted, that it travels along the bottom edge turning as
  // it goes, that the rail it rolls on is the measured bands, and that the audio drives how fast it goes.
  // The defect this section exists to catch was found by measuring the mode on the live panel on 2026-11-07. The lit
  // runs along a canvas row were merged with a sentinel that used the run's START INDEX as the flag; a run starting
  // left of the mark's centre has a negative index, so the flush read it as "no run open" and dropped it. The mark
  // painted 169 of its 333 cells across 28 px of its 52 px width -- half a mark, and the half that was missing was
  // always the left half. Item 3 is the count a half-mark cannot pass.
  const q746Mount = async function (storage746) {
    const br746 = makeBrowser({ storage: storage746 });
    const mt746 = await mount(br746, { canvas2d: true, audioTracks: 1, channels: 1, sampleRate: 48000 });
    mt746.commit(); await flush();
    await openAllSections(mt746.shim, mt746.comp);
    mt746.commit(); await flush();
    mt746.armAudio(1);
    mt746.commit(); await flush();
    // Leave the mode and come back to it, so what is measured is an entry into the mode and not a leftover picture.
    mt746.els('audio-play-scope-mode531-llama')[0].props.onClick(); mt746.commit(); await flush();
    mt746.els('audio-play-scope-mode531-qwen')[0].props.onClick(); mt746.commit(); await flush();
    return { br: br746, m: mt746 };
  };
  // A frame is recognised by the ground it paints first; only the segments that put a mark on the ground are kept,
  // because the draw entry and the mode's own painter each lay the ground once (the same is true of the llama).
  // T-748 adds the third argument: a mark is no longer always white, so which colour means "a mark was drawn here"
  // is asked per call. Left out, it is the white this helper has always looked for.
  const q746Frames = function (br746, n746, ink746) {
    const want746 = ink746 || '#ffffff';
    const from746 = br746.rectLog.length;
    br746.frames(n746);
    const all746 = br746.rectLog.slice(from746);
    const starts746 = [];
    all746.forEach(function (r746, i746) { if (r746[2] === 200 && r746[3] === 80) starts746.push(i746); });
    starts746.push(all746.length);
    const out746 = [];
    for (let i746 = 0; i746 + 1 < starts746.length; i746++) {
      const seg746 = all746.slice(starts746[i746], starts746[i746 + 1]);
      if (seg746.some(function (r746) { return r746[5] === want746; })) out746.push(seg746);
    }
    return out746;
  };
  const q746White = function (rs746) { return rs746.filter(function (r746) { return r746[5] === '#ffffff'; }); };
  const q746Rail = function (rs746) { return rs746.filter(function (r746) { return r746[5] === 'rgba(255,255,255,0.30)'; }); };
  const q746Cells = function (rs746) {
    return q746White(rs746).reduce(function (a746, r746) { return a746 + (r746[2] * r746[3]) / 4; }, 0);
  };
  const q746Box = function (rs746) {
    let x0746 = 999, y0746 = 999, x1746 = -1, y1746 = -1;
    q746White(rs746).forEach(function (r746) {
      if (r746[0] < x0746) x0746 = r746[0];
      if (r746[1] < y0746) y0746 = r746[1];
      if (r746[0] + r746[2] > x1746) x1746 = r746[0] + r746[2];
      if (r746[1] + r746[3] > y1746) y1746 = r746[1] + r746[3];
    });
    return [x0746, y0746, x1746, y1746];
  };
  const q746MeanX = function (rs746) {
    let a746 = 0, n746 = 0;
    q746White(rs746).forEach(function (r746) { a746 += (r746[0] + r746[2] / 2) * (r746[2] * r746[3]); n746 += r746[2] * r746[3]; });
    return a746 / n746;
  };

  // 1. provenance: the mask the client carries is the traced one, and the constants name it exactly.
  check('T-746 provenance: the rolling mark\'s shape is the traced logo as 27 rows of 26 columns, and the lit-cell '
      + 'count the trace measured (333) is the constant the code carries -- the same pin the llama mask is held by',
    (function () {
      const src746 = require('fs').readFileSync(TARGET, 'utf8');
      // The closing bracket of a mask literal is at the same indentation as its `var`, which is four spaces here
      // and was six in the pattern this pin carried. The wider pattern did not fail to match - it matched too
      // much, running on past the rolling mark's own rows to the next six-space `];` in the file and counting two
      // masks as one (49 rows, 667 lit cells). Found while the second mark was added, which is what put a second
      // mask in the file for it to run on into.
      const rows746 = (src746.match(/var SCOPE_QWEN_MASK746 = \[([\s\S]*?)\n    \];/) || [])[1] || '';
      const vals746 = (rows746.match(/0x[0-9a-f]+/g) || []).map(function (v746) { return parseInt(v746, 16); });
      const lit746 = vals746.reduce(function (a746, v746) {
        let n746 = 0, x746 = v746;
        while (x746) { n746 += (x746 & 1); x746 >>>= 1; }
        return a746 + n746;
      }, 0);
      return vals746.length === 27 && lit746 === 333
        && /var SCOPE_QWEN_LIT746 = 333;/.test(src746)
        && /var SCOPE_QWEN_COLS746 = 26;/.test(src746)
        && /var SCOPE_QWEN_ROWS746 = 27;/.test(src746)
        && /var SCOPE_QWEN_CELL746 = 2;/.test(src746);
    })(), {});

  // T-749: the second mark, held by the same kind of pin for the same reason - the shape in the client is the
  // shape the offline trace measured, and the number the code carries is the number the trace printed. The trace is
  // deepamp-audio/scratch/trace_whale_749.py and its cell map scratch/whale_cellmap_749.json; re-running the script
  // answers these rows again. The operator's ask, carried on TODOS.md WM-34 item 1 since 2026-11-07 11:28 Berlin:
  // "expand dancing lama plugin with dancing whale option - use the deepseek whale in same scale, turn it 180* and
  // replace lama icon with whale as a visualizer setting". The turned orientation is part of what is pinned: the
  // rows are the turned glyph, so the first row is the fluke end and the last is the head, which is also the way
  // the mark faces its direction of travel on the rail.
  check('T-749 provenance: the whale mark is the traced deepseek logo turned 180 degrees as 22 rows of 30 columns, '
      + 'and the lit-cell count that trace measured (334) is the constant the code carries',
    (function () {
      const src749 = require('fs').readFileSync(TARGET, 'utf8');
      const rows749 = (src749.match(/var SCOPE_WHALE_MASK749 = \[([\s\S]*?)\n    \];/) || [])[1] || '';
      const vals749 = (rows749.match(/0x[0-9a-f]+/g) || []).map(function (v749) { return parseInt(v749, 16); });
      const lit749 = vals749.reduce(function (a749, v749) {
        let n749 = 0, x749 = v749;
        while (x749) { n749 += (x749 & 1); x749 >>>= 1; }
        return a749 + n749;
      }, 0);
      return vals749.length === 22 && lit749 === 334
        && /var SCOPE_WHALE_LIT749 = 334;/.test(src749)
        && /var SCOPE_WHALE_COLS749 = 30;/.test(src749)
        && /var SCOPE_WHALE_ROWS749 = 22;/.test(src749)
        && /var SCOPE_WHALE_CELL749 = 2;/.test(src749);
    })(), {});

  // T-754 (2026-11-07). The operator's word on the mark, verbatim: "the whale in the dancing llama visualizer needs
  // a fix, it's too big, it's upside down, and should be mirrored horizontally", and on where the shape comes from:
  // "take a look at the original in the upper left corner of DSH - that one is left facing, we can use the original
  // left facing, but would have to change the direction on the canvas from right to left". The grid the code carries
  // now is that original: the header glyph's own path filled at 30 x 22 with no turn applied -- the header draws
  // that path with no transform (LOGO_WHALE_VIEW507 is "0 0 24 24", nothing applied to it), and the trace that
  // produced this grid (scratch/trace_whale_754_original.py, dump scratch/whale_original_754.json) fills the same
  // string out of the same file. The grid this card replaced is written out at
  // scratch/whale_mask_749_turned_before_T754.txt, and it is exactly the 180-degree turn of this one -- which is
  // why the mark read as upside down rather than merely facing the other way.
  // What is pinned here is the orientation, as a fingerprint: the area-weighted centre of the lit cells, and the
  // fact that each of the three ways of re-orienting the grid -- a 180-degree turn, a left-right mirror, a
  // top-bottom flip -- gives a DIFFERENT grid with a DIFFERENT centre. A shape with a head and a tail has no
  // symmetry to hide behind, and every one of those moves is something the operator would see. Measured in this run
  // from the mask the code carries; the numbers are not copied from the trace.
  check('T-754: the mark carries the original, un-turned silhouette -- its lit-cell centre sits at row 9.811, column '
      + '15.374 of a 22 x 30 grid, and none of the three re-orientations of that grid (180-degree turn, left-right '
      + 'mirror, top-bottom flip) gives the same grid or the same centre -- and the direction the canvas is asked to '
      + 'move in is one value used twice, on the position along the rail and on the angle, with the whale at -1 and '
      + 'the qwen left at 1 because the qwen was not named in the ask',
    (function () {
      const src754 = require('fs').readFileSync(TARGET, 'utf8');
      const rows754 = (src754.match(/var SCOPE_WHALE_MASK749 = \[([\s\S]*?)\n    \];/) || [])[1] || '';
      const vals754 = (rows754.match(/0x[0-9a-f]+/g) || []).map(function (v754) { return parseInt(v754, 16); });
      if (vals754.length !== 22) return false;
      const cols754 = 30;
      const bitsOf754 = function (v754) {
        const out754 = [];
        const b754 = v754.toString(2);
        for (let i754 = 0; i754 < b754.length; i754++) {
          if (b754[i754] === '1') out754.push([b754.length - 1 - i754]);
        }
        return out754;
      };
      const centreOf754 = function (grid754) {
        let n754 = 0, ry754 = 0, rx754 = 0;
        grid754.forEach(function (v754, r754) {
          bitsOf754(v754).forEach(function (p754) { n754++; ry754 += r754; rx754 += p754[0]; });
        });
        if (!n754) return null;
        return { n: n754, row: Number((ry754 / n754).toFixed(3)), col: Number((rx754 / n754).toFixed(3)) };
      };
      const flipBits754 = function (v754) {
        return parseInt(v754.toString(2).padStart(cols754, '0').split('').reverse().join(''), 2);
      };
      const rot180754 = vals754.map(flipBits754).reverse();
      const mirror754 = vals754.map(flipBits754);
      const vflip754 = vals754.slice().reverse();
      const own754 = centreOf754(vals754);
      const r754 = centreOf754(rot180754), m754 = centreOf754(mirror754), f754 = centreOf754(vflip754);
      if (!own754 || !r754 || !m754 || !f754) return false;
      const same754 = function (a754, b754) { return JSON.stringify(a754) === JSON.stringify(b754); };
      const distinct754 = !same754(vals754, rot180754) && !same754(vals754, mirror754) && !same754(vals754, vflip754)
        && !same754(own754, r754) && !same754(own754, m754) && !same754(own754, f754);
      // One value, used twice: the facing table, and the two places the painter applies it. Read as text because
      // the drawing is proved by the travel pins -- the mark's centre walking right to left across every in-box
      // frame with no step against it -- and this half is about there being one number to keep in step.
      const faceOk754 = /var SCOPE_MARK_FACE754 = \{ whale: -1, qwen: 1 \};/.test(src754)
        && /var face754 = SCOPE_MARK_FACE754\[mode748\] \|\| 1;/.test(src754)
        && /inset748 \+ innerW748 \+ halfW748 - span754/.test(src754)
        && /var theta748 = face754 \*/.test(src754);
      return own754.n === 334 && own754.row === 9.811 && own754.col === 15.374
        && r754.row === 11.189 && r754.col === 13.626 && m754.row === 9.811 && f754.col === 15.374
        && distinct754 && faceOk754;
    })(), {
      carried_centre: (function () {
        const src754 = require('fs').readFileSync(TARGET, 'utf8');
        const vals754 = ((src754.match(/var SCOPE_WHALE_MASK749 = \[([\s\S]*?)\n    \];/) || [])[1] || '')
          .match(/0x[0-9a-f]+/g).map(function (v754) { return parseInt(v754, 16); });
        let n754 = 0, ry754 = 0, rx754 = 0;
        vals754.forEach(function (v754, r754) {
          const b754 = v754.toString(2);
          for (let i754 = 0; i754 < b754.length; i754++) {
            if (b754[i754] !== '1') continue;
            n754++; ry754 += r754; rx754 += b754.length - 1 - i754;
          }
        });
        return { lit: n754, row: Number((ry754 / n754).toFixed(3)), col: Number((rx754 / n754).toFixed(3)) };
      })(),
      reoriented: 'turn 180 / mirror left-right / flip top-bottom each give a different grid and a different centre',
      record_of_the_superseded_grid: 'scratch/whale_mask_749_turned_before_T754.txt',
      trace_that_produced_this_one: 'scratch/trace_whale_754_original.py -> scratch/whale_original_754.json' });

  // The roll budget, written as arithmetic instead of as a comment, because it is the reason these two marks are
  // smaller than the llama and the reason a rolling mode takes the whole canvas. A body rolling on a line needs its
  // own diagonal: 2 * (a*|sin t| + b*|cos t|), which at t = 45 degrees is (w + h) / sqrt(2), against the inner
  // height a full-canvas mode is given. Measured: the qwen mark is 75.0 px with 1.0 px spare, the whale 73.54 px
  // with 2.46 px spare, and a 60 x 68 px body is 90 px - which is why the llama dances in place and does not roll.
  check('T-749: both rolling marks fit the box they roll in, and the arithmetic says so - each is inside the inner '
      + 'height at its own worst angle, and the mark asked for "in same scale" is drawn on the same 2 px cell grid '
      + 'the first mark uses',
    (function () {
      const src749 = require('fs').readFileSync(TARGET, 'utf8');
      const num749 = function (re749) { const m749 = re749.exec(src749); return m749 ? parseInt(m749[1], 10) : -1; };
      const inner749 = (function () {
        const h749 = num749(/SCOPE_H300 = (\d+);/), e749 = num749(/SCOPE_EDGE_INSET300 = (\d+);/);
        return (h749 > 0 && e749 >= 0) ? h749 - 2 * e749 : -1;
      })();
      const qc749 = num749(/SCOPE_QWEN_COLS746 = (\d+);/), qr749 = num749(/SCOPE_QWEN_ROWS746 = (\d+);/);
      const qe749 = num749(/SCOPE_QWEN_CELL746 = (\d+);/);
      const wc749 = num749(/SCOPE_WHALE_COLS749 = (\d+);/), wr749 = num749(/SCOPE_WHALE_ROWS749 = (\d+);/);
      const we749 = num749(/SCOPE_WHALE_CELL749 = (\d+);/);
      if (inner749 < 0 || qc749 < 0 || wc749 < 0 || qe749 < 0 || we749 < 0) return false;
      const worst749 = function (cols749, rows749, cell749) {
        return ((cols749 * cell749) + (rows749 * cell749)) / Math.SQRT2;
      };
      const q749 = worst749(qc749, qr749, qe749), w749 = worst749(wc749, wr749, we749);
      return qe749 === we749
        && q749 <= inner749 && w749 <= inner749
        && Math.abs(q749 - 75.0) < 0.2 && Math.abs(w749 - 73.54) < 0.2;
    })(), {});

  {
    // 2. the colour pick, measured from a stored scheme. T-746 pinned this mode as one uniform white because that
    // was the picture the operator had asked for ("conversion from blue to uniform white on black"), and a stored
    // scheme was the one thing that could have broken it. T-748 moves that ruling by the operator's word - "the
    // rolling qwen is perfect, but, ... add the different color effects we already have for dancinf llama to bring
    // in some rainbow effects aswell as a secondary setting, try to make code reusable" - so the mode now has a
    // colour vocabulary and a stored scheme is exactly what it names. The white picture is not lost: it is the
    // default, and it is what every other mount in this block measures, because none of them stores a scheme.
    // What this mount measures is the other half: a stored scheme now changes the canvas, the ground is the same
    // ground, and the colour follows the loudness the way the ramp works everywhere else in this panel - the
    // flames ramp read at three loudness settings, in order. Three settings because a ramp sampled at one level is
    // one colour, and "the colour effects are the ones the llama already has" is only measured by a colour that moves.
    const qS746 = await q746Mount({ 'deepamp:scope.mode': 'qwen', 'deepamp:scope.schemes': '{"qwen":"flames"}' });
    // Every bin hot at one value, so every band the rail owns and the mark reads measure the SAME loudness and
    // one colour is the answer. Named bins would give a spectrum, and a spectrum paints several ramp colours at
    // once - which is the right picture for a loudness question but the wrong fixture for "which colour does this
    // setting produce", because the tallest bar would then decide what the census called dominant.
    const qBins748 = [];
    for (let i748 = 0; i748 < 512; i748 += 2) qBins748.push(i748);
    const qRamp748 = [];
    [60, 140, 255].forEach(function (loud748) {
      qS746.br.hotBins = qBins748;                     // the mock reads hotBins AND hotBinValue at call time
      qS746.br.hotBinValue = loud748;
      const fr748 = q746Frames(qS746.br, 10, '#0b0d0b');
      const seen748 = {};
      fr748.forEach(function (f748) {
        f748.forEach(function (r748) { if (r748[5] !== '#0b0d0b') seen748[r748[5]] = (seen748[r748[5]] || 0) + 1; });
      });
      const inks748 = Object.keys(seen748).sort(function (a748, b748) { return seen748[b748] - seen748[a748]; });
      qRamp748.push({ loud: loud748, frames: fr748.length, inks: inks748.length,
        colour: inks748[0] || '', ground: fr748.length ? 1 : 0, white: seen748['#ffffff'] || 0,
        rail: seen748['rgba(255,255,255,0.30)'] || 0 });
    });
    const chanSum748 = function (c748) {
      const m748 = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(String(c748));
      return m748 ? (Number(m748[1]) + Number(m748[2]) + Number(m748[3])) : -1;
    };
    const sums748 = qRamp748.map(function (g748) { return chanSum748(g748.colour); });
    const colours748 = qRamp748.map(function (g748) { return g748.colour; });
    check('T-746, re-pointed by T-748: a stored scheme ("flames") now does change this canvas - the mark is painted in the ramp, the ground is the same ground, no frame carries the uniform white or the dim white rail, and the colour the mark wears follows the loudness it is measuring: three settings, three colours, hotter as it gets louder',
      qRamp748.every(function (g748) { return g748.frames >= 8 && g748.inks >= 1 && g748.white === 0 && g748.rail === 0; })
      && new Set(colours748).size === 3
      && sums748[0] < sums748[1] && sums748[1] < sums748[2],
      { ramp: qRamp748, channel_sums: sums748 });
    console.log('  MEASURE T-748 qwen colour, scheme "flames": ' + qRamp748.map(function (g748) {
      return 'at ' + g748.loud + '/255 -> ' + g748.colour;
    }).join(' | ') + ' | distinct colours ' + new Set(colours748).size
      + ' | white frames ' + qRamp748.reduce(function (n748, g748) { return n748 + g748.white; }, 0)
      + ' | rail frames ' + qRamp748.reduce(function (n748, g748) { return n748 + g748.rail; }, 0));
    teardown();
  }

  {
    // 3 to 7. the roll itself, measured over 40 frames.
    const qR746 = await q746Mount({ 'deepamp:scope.mode': 'qwen' });
    const fr746 = q746Frames(qR746.br, 40);
    const full746 = fr746.filter(function (f746) {
      const b746 = q746Box(f746);
      return b746[0] > 3 && b746[2] < 197 && b746[1] > 3 && b746[3] < 77;   // fully inside the inner box
    });
    const cellList746 = full746.map(q746Cells);
    const worst746 = cellList746.reduce(function (a746, c746) { return Math.min(a746, c746); }, 9999);
    const wide746 = fr746.reduce(function (a746, f746) { const b746 = q746Box(f746); return Math.max(a746, b746[2] - b746[0]); }, 0);
    check('T-746: the whole mark is painted. A frame whose mark sits fully inside the box paints the traced 333 '
        + 'cells (2 px each), not a piece of them. The half-mark defect measured 169 cells and 28 px of width, and '
        + 'no frame in this run may come near that',
      fr746.length >= 30 && full746.length >= 15 && worst746 >= 300 && wide746 >= 50,
      { frames: fr746.length, unclipped_frames: full746.length, worst_cells: worst746, best_cells: cellList746.reduce(function (a746, c746) { return Math.max(a746, c746); }, 0), widest_px: wide746 });

    let outside746 = 0, stray746 = null;
    fr746.forEach(function (f746) {
      q746White(f746).forEach(function (r746) {
        if (r746[0] < 2 || r746[0] + r746[2] > 198 || r746[1] < 2 || r746[1] + r746[3] > 78) { outside746++; if (!stray746) stray746 = r746; }
      });
    });
    check('T-746: nothing of the mark is drawn outside the inner box -- the mode clips at the edge instead of '
        + 'drawing over the panel\'s own border', outside746 === 0, { outside: outside746, first_stray: stray746 });

    const meanList746 = fr746.map(q746MeanX);
    let back746 = 0;
    for (let i746 = 1; i746 < meanList746.length; i746++) { if (meanList746[i746] <= meanList746[i746 - 1]) back746++; }
    const travel746 = Math.round(meanList746[meanList746.length - 1] - meanList746[0]);
    check('T-746: the mark rolls clockwise down the box -- its centre moves right in every one of the 39 steps '
        + 'between the frames measured, and it covers real distance rather than spinning in place',
      back746 === 0 && travel746 >= 25,
      { steps: meanList746.length - 1, backwards: back746, travelled_px: travel746, from_x: Math.round(meanList746[0]), to_x: Math.round(meanList746[meanList746.length - 1]) });

    const heights746 = {};
    fr746.forEach(function (f746) { const b746 = q746Box(f746); heights746[b746[3] - b746[1]] = 1; });
    const hList746 = Object.keys(heights746).map(Number).sort(function (a746, b746) { return a746 - b746; });
    check('T-746: a body that is not a circle changes height as it turns -- the mark\'s drawn height takes several '
        + 'different values across the run, which is the difference between a mark that rolls and a sticker that spins',
      hList746.length >= 5 && hList746[hList746.length - 1] - hList746[0] >= 4,
      { heights: hList746 });

    let bestLow746 = 0;
    fr746.forEach(function (f746) {
      const b746 = q746Box(f746);
      if (b746[3] > bestLow746) { bestLow746 = b746[3]; }
    });
    check('T-746: the mark rides the ground it rolls on -- its lowest drawn cell reaches the bottom inner edge '
        + '(within the cell rounding of it) in at least one frame, and no frame leaves it floating far above that line',
      bestLow746 >= 72 && bestLow746 <= 78,
      { lowest_reached: bestLow746, ground_line: 78 });

    // A measure, not an assertion: the numbers this mode was accepted on, so the next change to the geometry has
    // something to be compared with instead of a green line.
    console.log('  MEASURE T-746 roll frames=' + fr746.length + ' unclipped=' + full746.length
      + ' cells_worst=' + worst746 + ' cells_best=' + cellList746.reduce(function (a746, c746) { return Math.max(a746, c746); }, 0)
      + ' widest_px=' + wide746 + ' travelled_px=' + travel746
      + ' heights=' + hList746.join(',') + ' lowest_reached=' + bestLow746);
    teardown();
  }

  {
    // 8. the rail, and what drives the roll. The rail is the panel's own band chain along the bottom inner edge,
    //    and the height of a rail cell is the measurement; the colour is not, which is what item 2 pinned.
    const qB746 = await q746Mount({ 'deepamp:scope.mode': 'qwen' });
    qB746.br.hotBins = [2]; qB746.br.hotBinValue = 255;   // one low bin at the top of the mock's dB window
    const loud746 = q746Frames(qB746.br, 24);
    const off746 = q746Frames(qB746.br, 1);
    let railBad746 = 0, railLate746 = 0, railTall746 = 0;
    loud746.forEach(function (f746) {
      const rl746 = q746Rail(f746);
      const wAt746 = f746.findIndex(function (r746) { return r746[5] === '#ffffff'; });
      rl746.forEach(function (r746) {
        if (r746[1] + r746[3] !== 78) railBad746++;                 // stands on the bottom inner edge
        if (r746[3] > 8) railTall746++;                             // 4 cells of rail, 2 px each
        if (wAt746 >= 0 && f746.indexOf(r746) > wAt746) railLate746++;   // the mark is painted OVER the rail
      });
    });
    const railCount746 = q746Rail(loud746[loud746.length - 1] || []).length;
    check('T-746: the sound rail is the measured bands standing on the bottom inner edge -- every rail cell sits on '
        + 'that line, none is taller than the 4 cells the mode allows, and the mark is painted after the rail, over it',
      railBad746 === 0 && railTall746 === 0 && railLate746 === 0 && railCount746 > 0,
      { off_ground: railBad746, too_tall: railTall746, painted_after_mark: railLate746, rail_cells_in_last_frame: railCount746 });

    const step746 = function (frames746) {
      if (frames746.length < 12) return -1;
      return (q746MeanX(frames746[frames746.length - 1]) - q746MeanX(frames746[0])) / (frames746.length - 1);
    };
    const loudStep746 = step746(loud746);
    qB746.br.hotBins = [2]; qB746.br.hotBinValue = 0;   // the same bin at the floor of the window: a quiet frame
    const quiet746 = q746Frames(qB746.br, 24);
    const quietStep746 = step746(quiet746);
    check('T-746: the audio drives the roll. The same mode with the measured band at the top of the window travels '
        + 'further per frame than the same mode with that band at the floor, and the quiet frame still rolls at its '
        + 'base speed rather than freezing half across the box',
      loudStep746 > quietStep746 && quietStep746 > 0.1 && quiet746.length >= 12,
      { loud_px_per_frame: Math.round(loudStep746 * 100) / 100, quiet_px_per_frame: Math.round(quietStep746 * 100) / 100 });
    console.log('  MEASURE T-746 drive loud_px_per_frame=' + Math.round(loudStep746 * 100) / 100
      + ' quiet_px_per_frame=' + Math.round(quietStep746 * 100) / 100
      + ' rail_cells_in_frame=' + railCount746);
    teardown();
  }

  {
    // 9. arriving in the mode shows the mark at once. The roll starts in the middle of the box for this reason: a
    //    mode whose first seconds are an empty canvas is a mode that looks broken for its first seconds.
    const qA746 = await q746Mount({ 'deepamp:scope.mode': 'qwen' });
    const first746 = q746Frames(qA746.br, 1);
    const bx746 = first746.length ? q746Box(first746[0]) : null;
    const centre746 = bx746 ? (bx746[0] + bx746[2]) / 2 : -1;
    check('T-746: entering the mode paints the mark on the first frame, centred in the box -- the mode is never '
        + 'blank when it is chosen, and the roll does not enter from off-screen and spend its first seconds invisible',
      first746.length === 1 && q746Cells(first746[0]) >= 300 && centre746 > 70 && centre746 < 130,
      { frames: first746.length, cells: first746.length ? q746Cells(first746[0]) : 0, box: bx746, centre_x: Math.round(centre746) });
    teardown();
  }

  // ---------------------------------------------------------------- T-567 (2026-10-17): the same box at another ratio and another width
  // The operator's method ruling for this card, verbatim: "do NOT read pixel from screenshots to hardcode them, think
  // about the allignment to generate the pixel dynamically to get the 3D-effect of the 'box view' we want - it can all
  // be dynamic to adjust to size changes". A construction measured at one size and devicePixelRatio 1 cannot be told
  // apart from a table of numbers copied off a picture, so the box is measured twice more: on a screen whose ratio is
  // 2, and on a strip the panel has just dragged from 200 px to 300 px. Every number below is read off the recorded
  // draw calls of those two runs.
  teardown();
  b = makeBrowser({ devicePixelRatio: 2, storage: { 'deepamp:scope.mode': 'off' } });
  m = await mount(b, { canvas2d: true, audioTracks: 1 });
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush(); bag = m.commit(); await flush();
  m.armAudio(1);
  // The same handshake scenario D names: loadClient installs its own global.window, so the display factor has to be
  // installed after the client is loaded -- which is also when a real browser would have it.
  global.window = { devicePixelRatio: 2 };
  // Ten presses from the mounted mode reach the llama now (T-755, operator: "make dancing llama the last
  // visualizer in the list"). The walk is a setup, not a claim: what this scenario measures is the drawing at a
  // 2x display, and it is taken from the same mode it was taken from before.
  m.clickStrip(); m.commit(); m.clickStrip(); m.commit(); m.clickStrip(); m.commit();
  m.clickStrip(); m.commit(); m.clickStrip(); m.commit(); m.clickStrip(); m.commit();
  m.clickStrip(); m.commit(); m.clickStrip(); m.commit(); m.clickStrip(); m.commit();
  m.clickStrip(); m.commit();                          // -> the llama, on a screen at devicePixelRatio 2
  const lm567Attrs542 = m.canvases()[0].props;
  const lm567S542 = b.rectLog.length, lm567H542 = b.histRectLog.length, lm567I542 = b.imageCopies;
  b.frames(1);
  const lm567Vis542 = b.rectLog.slice(lm567S542), lm567Hist542 = b.histRectLog.slice(lm567H542);
  const lm567Log542 = b.imageLog.slice(lm567I542);
  const lm567Cells542 = function (ix542) {
    return lm567Hist542.filter(function (r542) { return r542[6] === ix542 && r542[2] === 2 && r542[3] === 2; });
  };
  const lm567Wall542 = lm567Cells542(0);
  const lm567Blit542 = lm567Log542.filter(function (a542) {
    return a542.length === 8 && a542[0] === 0 && a542[1] === 0 && a542[2] === 312 && a542[3] === 114; })[0] || [];
  const lm567Floor542 = lm567Log542.filter(function (a542) {
    return a542.length === 8 && a542[3] === 2 && a542[7] === 1; });
  check('T-567 at devicePixelRatio 2 (the operator\'s own screen is not at 1, and this is the fault their screenshot '
      + 'showed): the history is the wall\'s OWN band sized in wall pixels -- 312 x 114, which is 156 columns x 57 rows '
      + 'at 2 bitmap px per wall px -- and the wall\'s newest column is a 2 x 2 cell at the band\'s far column x 310, '
      + 'tiled from band y 0 down to y 112, 57 cells, so the wall covers its band END TO END. Before this card the '
      + 'columns were 1 px dots painted at CSS coordinates into a bitmap sized in device pixels, and the wall covered '
      + '1/ratio of the space it owns -- 41 px short of its own far edge and 12 px short of its own bottom on the '
      + 'operator\'s 226 px screen. The visible canvas is still painted in CSS px -- the ground fills 0,0,200,80 -- and '
      + 'the band is laid on the wall\'s CSS rect 22,2,156,57: the wall is 156 columns wide and 57 rows tall on the '
      + 'person\'s canvas at EVERY ratio, which is the whole of "too short on the right side and not tall enough"',
    lm567Wall542.length === 57 && lmEdge542(lm567Wall542).minx === 310 && lmEdge542(lm567Wall542).maxx === 310
      && lmEdge542(lm567Wall542).miny === 0 && lmEdge542(lm567Wall542).maxy === 112
      && lmUniq542(lm567Wall542, 2).length === 1 && lmUniq542(lm567Wall542, 3).length === 1
      && (310 + 2) === 312 && (112 + 2) === 114
      && String(lm567Attrs542.width) === '400' && String(lm567Attrs542.height) === '160'
      && lm567Attrs542.style.width === '200px' && lm567Attrs542.style.height === '80px'
      && lmBg542(lm567Vis542).length === 1
      && lm567Blit542.length === 8 && lm567Blit542[4] === 22 && lm567Blit542[5] === 2
      && lm567Blit542[6] === 156 && lm567Blit542[7] === 57,
    { wall_cells: lm567Wall542.length, wall_band_edge: lmEdge542(lm567Wall542),
      canvas_attrs: [String(lm567Attrs542.width), String(lm567Attrs542.height)],
      canvas_css: [lm567Attrs542.style.width, lm567Attrs542.style.height],
      ground_fills: lmBg542(lm567Vis542).length, band_blit: lm567Blit542 });

  check('T-567 at devicePixelRatio 2: the BOX does not move when the ratio changes -- only the number of bitmap pixels '
      + 'behind it does. 19 mirrors, destinations y 59..77 and x 22..197 exactly as at ratio 1, the deepest row on the '
      + 'canvas\'s inner edges (2..197), the shared horizon still the wall\'s own row (no copy is laid at 58), while '
      + 'the SOURCE rows step 2 px per row of depth in the band\'s own space (band y 110 down to 20) and each source '
      + 'row is 2 px tall. Source in wall pixels, destination in CSS pixels, one space each, every time',
    lm567Floor542.length === 19
      && lm567Floor542.every(function (a542) {
        const k542 = a542[5] - 58;
        return k542 >= 1 && k542 <= 19 && a542[1] === (56 - k542) * 2 && a542[3] === 2 && a542[7] === 1
          && a542[0] === 0 && a542[2] === 312;
      })
      && !lm567Floor542.some(function (a542) { return a542[5] === 58; })
      && lm567Floor542.every(function (a542) { return a542[4] - 2 === 198 - (a542[4] + a542[6]); })
      && (function () { const d542 = lm567Floor542.slice().sort(function (q542, r542) { return q542[5] - r542[5]; }).slice(-1)[0];
        return d542[4] === 2 && (d542[4] + d542[6] - 1) === 197; })(),
    { mirrors: lm567Floor542.length,
      mirror_dest_y: [Math.min.apply(null, lm567Floor542.map(function (a542) { return a542[5]; })),
        Math.max.apply(null, lm567Floor542.map(function (a542) { return a542[5]; }))],
      mirror_src_band_y: [Math.min.apply(null, lm567Floor542.map(function (a542) { return a542[1]; })),
        Math.max.apply(null, lm567Floor542.map(function (a542) { return a542[1]; }))],
      deepest_mirror: lm567Floor542.slice().sort(function (q542, r542) { return q542[5] - r542[5]; }).slice(-1)[0] });

  teardown();
  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'off' } });
  m = await mount(b, { canvas2d: true, audioTracks: 1 });
  bag = m.commit(); await flush();
  await openAllSections(m.shim, m.comp);
  bag = m.commit(); await flush(); bag = m.commit(); await flush();
  m.armAudio(1);
  // Ten presses from the mounted mode reach the llama now, for the same T-755 reason as the scenario above. The
  // measurement is the drag on a 200 px strip, and it is taken from the same mode it was taken from before.
  m.clickStrip(); m.commit(); m.clickStrip(); m.commit(); m.clickStrip(); m.commit();
  m.clickStrip(); m.commit(); m.clickStrip(); m.commit(); m.clickStrip(); m.commit();
  m.clickStrip(); m.commit(); m.clickStrip(); m.commit(); m.clickStrip(); m.commit();
  m.clickStrip(); m.commit();                          // -> the llama on a 200 px strip
  const lm567Tgt542 = { getBoundingClientRect: function () { return { left: 0, right: 200 }; },
    setPointerCapture: function () {} };
  const lm567Ev542 = function (o542) { return Object.assign({ clientX: 0, pointerId: 7, currentTarget: lm567Tgt542,
    preventDefault: function () {}, stopPropagation: function () {} }, o542); };
  m.strip().props.onPointerDown(lm567Ev542({ offsetX: 196, clientX: 100 }));
  m.strip().props.onPointerMove(lm567Ev542({ offsetX: 196, clientX: 200 }));   // the edge is pulled out by 100 px
  m.strip().props.onPointerUp(lm567Ev542({}));
  m.strip().props.onClick(lm567Ev542({})); m.commit();
  const lm567W542 = m.canvases()[0].props.style.width;
  const lm567S2542 = b.rectLog.length, lm567H2542 = b.histRectLog.length, lm567I2542 = b.imageCopies;
  b.frames(1);
  const lm567Vis2542 = b.rectLog.slice(lm567S2542), lm567Hist2542 = b.histRectLog.slice(lm567H2542);
  const lm567Log2542 = b.imageLog.slice(lm567I2542);
  // Which bitmap is the wall's is read off the drawing, not assumed: a fresh band is started by a fill of the band's
  // own size, and the rect carries the index of the bitmap it landed in. This mount had built two offscreen canvases
  // before the llama entered (the walk passes through the waterfall), so a hardcoded 0 would have been a guess.
  // Which bitmap is the wall's is read off the drawing and not assumed: the blit names its own source bitmap, and the
  // harness pairs every visible copy with the offscreen bitmap it was copied FROM. This mount had built two offscreen
  // canvases before the llama entered -- the walk passes through the waterfall -- so a hardcoded 0 would have been a
  // guess, and the first version of this check made it and failed on it.
  const lm567Src2542 = b.visSrcLog.slice(lm567I2542);
  const lm567Blit2542 = lm567Log2542.filter(function (a542) {
    return a542.length === 8 && a542[0] === 0 && a542[1] === 0 && a542[2] === 256 && a542[3] === 57; })[0] || [];
  const lm567BlitIx542 = lm567Log2542.indexOf(lm567Blit2542);
  const lm567WallIx542 = lm567BlitIx542 >= 0 ? lm567Src2542[lm567BlitIx542] : -1;
  const lm567Wall2542 = lm567Hist2542.filter(function (r542) {
    return r542[6] === lm567WallIx542 && r542[2] === 1 && r542[3] === 1; });
  const lm567Floor2542 = lm567Log2542.filter(function (a542) {
    return a542.length === 8 && a542[3] === 1 && a542[7] === 1; }).slice()
    .sort(function (q542, r542) { return q542[5] - r542[5]; });
  const lm567Margins542 = lm567Floor2542.map(function (a542) { return [a542[4] - 2, 298 - (a542[4] + a542[6])]; });
  check('T-567 on a strip the panel has just dragged from 200 px to 300 px: nothing had to be re-measured off a '
      + 'picture to make the box fit the new width. The wall\'s band is REBUILT at 256 x 57 (W - 2*inset - 2*floor by '
      + 'rows - floor + 1), read off the blit\'s own source rect and confirmed by the wall\'s column pixels living in '
      + 'that same bitmap, and the wall\'s newest column sits at band x 255 and the blit lays it at canvas x 277, which '
      + 'is 300 - 2 - 20 - 1 -- the wall\'s own right edge at the new width. The deepest floor row spans x 2..297, '
      + 'which is inset .. W-1-inset at the new width, and the side margins down the depth are the SAME 19..0 '
      + 'sequence they were on the 200 px strip, because the slope is (specX - inset) / (floor - 1) and neither the '
      + 'inset nor the floor depth changed. The shared horizon moved with it: the band\'s last row is laid at canvas y '
      + '58 and the first mirror is at 59, at 300 px exactly as at 200 px',
    lm567W542 === '300px' && lm567WallIx542 >= 0 && lm567Wall2542.length === 57
      && lmEdge542(lm567Wall2542).minx === 255 && lmEdge542(lm567Wall2542).maxx === 255
      && lmEdge542(lm567Wall2542).miny === 0 && lmEdge542(lm567Wall2542).maxy === 56
      && lm567Blit2542.length === 8 && lm567Blit2542[4] === 22 && lm567Blit2542[6] === 256
      && (lm567Blit2542[4] + 255) === 277 && (lm567Blit2542[5] + lm567Blit2542[7] - 1) === 58
      && lm567Floor2542.length === 19 && lm567Margins542.length === 19
      && lm567Margins542[0][0] === 19 && lm567Margins542[18][0] === 0
      && lm567Margins542.every(function (p542) { return p542[0] === p542[1]; })
      && lm567Floor2542[18][4] === 2 && (lm567Floor2542[18][4] + lm567Floor2542[18][6] - 1) === 297
      && lm567Floor2542[0][5] === 59 && !lm567Floor2542.some(function (a542) { return a542[5] === 58; }),
    { strip_width: lm567W542, band_size_read_off_the_blit_source: lm567Blit2542.slice(0, 4),
      wall_column_x: (lmEdge542(lm567Wall2542) || { maxx: 'none' }).maxx, band_blit: lm567Blit2542,
      wall_band_index_read_off_the_fill: lm567WallIx542,
      margins_by_depth: lm567Margins542,
      deepest_floor_row: [lm567Floor2542[18][4], lm567Floor2542[18][4] + lm567Floor2542[18][6] - 1] });

  // ---------------------------------------------------------------- T-563 (2026-10-17): its own mount, at the end
  // The scenarios above count CLICKS: their pins assert which mode the Nth press lands on. A pin that presses the
  // strip to prove "a drag is not a press" moves every one of them -- the first attempt at this pin desynchronised 32
  // of them -- so it mounts its own panel and sits here, where nothing downstream depends on its mode.
  teardown();
  b = makeBrowser({ storage: { 'deepamp:scope.mode': 'off' } }); m = await mount(b, { canvas2d: true, audioTracks: 1 });
  m.commit(); await flush();
  m.armAudio(1); m.clickStrip(); m.commit();            // off -> spectrum analyser: the mode the drag is measured on
  const lm563Drag = (function () {
    const tgt563 = { getBoundingClientRect: function () { return { left: 0, right: 200 }; },
      setPointerCapture: function () {} };
    const ev563 = function (o563) { return Object.assign({ clientX: 0, pointerId: 7, currentTarget: tgt563,
      preventDefault: function () {}, stopPropagation: function () {} }, o563); };
    const drag563 = function (x0563, x1563) {
      const st563 = m.strip();
      st563.props.onPointerDown(ev563({ offsetX: 196, clientX: x0563 }));   // 196 is inside the 9 px grip of a 200 px strip
      st563.props.onPointerMove(ev563({ offsetX: 196, clientX: x1563 }));   // the edge is pulled by x1 - x0
      st563.props.onPointerUp(ev563({}));
      m.strip().props.onClick(ev563({})); m.commit();                       // the click a pointerup is always followed by
      return m.canvases()[0].props.style.width;
    };
    const before563 = m.modeLabel();
    const narrowed563 = drag563(100, 80);              // 200 px -> 180 px
    const after563 = m.modeLabel();
    const stored563 = b.store['deepamp:scope-w'];
    const restored563 = drag563(80, 100);              // 180 px -> 200 px, the same rule the other way
    const modeAfterDrag563 = m.modeLabel();
    m.clickStrip(); m.commit();                         // a press that never touched the grip
    return { before: before563, after: after563, narrowed: narrowed563, stored: stored563, restored: restored563,
      mode_after_both_drags: modeAfterDrag563, plain_press_mode: m.modeLabel() };
  })();
  check('T-563 (operator, verbatim: "if i change the canvas by dragging the right border, it should not also switch '
      + 'the visualizer which is currently also triggered"): a drag on the strip\'s right edge RESIZES it and does NOT '
      + 'cycle the mode. 200 px -> 180 px, the mode is the mode it was before the release, the new width is the width '
      + 'that gets stored, and the same drag back to 200 px does not cycle either. T-333 pinned that the three pointer '
      + 'handlers EXIST and that did not catch this: the strip carried a guard asking "was this a drag that moved?" and '
      + 'read it against a record onPointerUp had already thrown away, and a pointerup is always followed by the click '
      + 'it produced',
    lm563Drag.before === 'spectrum analyser' && lm563Drag.after === 'spectrum analyser'
      && lm563Drag.mode_after_both_drags === 'spectrum analyser'
      && lm563Drag.narrowed === '180px' && lm563Drag.stored === '180' && lm563Drag.restored === '200px',
    lm563Drag);
  check('T-563 the other half, so the fix cannot be "clicks stopped working": the press that follows those drags is a '
      + 'press, and it cycles the mode exactly as T-299 and T-333 left it (spectrum analyser -> oscilloscope)',
    lm563Drag.plain_press_mode === 'oscilloscope', lm563Drag.plain_press_mode);


  // ---------------------------------------------------------------- scenario T-601: the Knight Rider LED bars
  // The operator's ruling of 2026-10-28 08:0x Berlin, filed on the card with the reference image
  // (review/t600_fireplace_20261028/operator_panel_20261028.png): an odd number of LED bars (3 / 5 / 7, 5 at the
  // default size), each bar expanding from the middle line upwards and downwards symmetrically, the bands named by
  // octave position (left high, left mid, middle base, right mid, right high), left bars fed by the left channel
  // and the middle bar by both, live level with nothing held, and a mono take feeding every bar from the same read.
  // Everything below is read off the drawing log, because a bar that is mirrored about a line is a claim about the
  // line, not about the source text.
  const knightMount601 = async function (storage601, channels601) {
    const br601 = makeBrowser({ storage: storage601 });
    const mt601 = await mount(br601, { canvas2d: true, audioTracks: 1, channels: channels601, sampleRate: 48000 });
    mt601.commit(); await flush();
    await openAllSections(mt601.shim, mt601.comp);
    mt601.commit(); await flush();
    mt601.armAudio(1);
    mt601.commit(); await flush();
    // The mode the panel was handed at mount is knight, and a mode that was never ENTERED by a press has not been
    // armed the way applyScopeMode531 arms it. One press leaves the mode and the press that follows re-enters it,
    // which is the same entry every other scenario in this file measures.
    // The entry press is the row's own name button (T-535 made the name a real press, and it runs the same
    // applyScopeMode531 the strip press runs). Leaving the mode and pressing it again is the entry every other
    // scenario measures. A press on the strip would not do: from off the ring wraps to spectrum, not back here.
    mt601.els('audio-play-scope-mode531-llama')[0].props.onClick(); mt601.commit(); await flush();    // -> llama: leave the mode the panel was handed
    mt601.els('audio-play-scope-mode531-knight')[0].props.onClick(); mt601.commit(); await flush();  // -> knight: the entering press
    br601.frames(1);
    const start601 = br601.rectLog.length;
    br601.frames(1);
    return { br: br601, m: mt601, frame: br601.rectLog.slice(start601) };
  };
  // A Knight Rider segment: a lit block no taller than the 3 px LED block and no wider than a bar. The canvas
  // ground (200 x 80) and the peak cap (2 px, #e8e8e8) are excluded by these numbers, and this mode wears no clock
  // band because a whole-canvas mode wears none.
  const kSeg601 = function (log601) {
    return log601.filter(function (r601) { return r601[3] > 0 && r601[3] <= 3 && r601[2] > 3 && r601[2] < 100 && r601[5] !== '#e8e8e8'; });
  };
  const kGroups601 = function (segs601) {
    const map601 = {};
    segs601.forEach(function (r601) { const k601 = Math.round(r601[0]); if (!map601[k601]) map601[k601] = []; map601[k601].push(r601); });
    return map601;
  };
  const K_MID_LINE601 = 40;   // the canvas is 80 px tall and this mode wears the whole canvas
  const kAbove601 = function (g601) { return g601.filter(function (r601) { return r601[1] < K_MID_LINE601; }); };
  const kBelow601 = function (g601) { return g601.filter(function (r601) { return r601[1] >= K_MID_LINE601; }); };
  const kLit601 = function (map601, x601) { return !!map601[x601] && map601[x601].length > 0; };
  // The bar slots the geometry gives at this strip width, computed the way the painter computes them: inset 2 px,
  // inner 196 px, the gap 6 px. A lit bar is a group of segments at its own slot; a bar with nothing in its band
  // draws nothing, which is why the slots are named here and the lit groups are not.
  // RE-POINTED 2026-10-28 09:1x Berlin on the operator's second ruling for this mode (quoted on the card): the bar
  // is 15% narrower than the slot it sits in, and the width it gives up is split evenly between the two inner canvas
  // borders. The arithmetic here is the ruling written out independently of the panel's own constant: at the 200 px
  // default strip and five bars that is a 29.2 px bar inside a 34.4 px slot, and 14.9 px of border on each side
  // instead of the 2 px inset the other modes sit in.
  const K_BAR_W_FRAC601 = 0.85;
  const kSlots601 = function (n601) {
    const slot601 = (196 - (n601 - 1) * 6) / n601;
    const bw601 = slot601 * K_BAR_W_FRAC601;
    const margin601 = (196 - (n601 * bw601 + (n601 - 1) * 6)) / 2;
    const out601 = [];
    for (let i601 = 0; i601 < n601; i601++) out601.push(Math.round(2 + margin601 + i601 * (bw601 + 6)));
    return out601;
  };
  const kBarW601 = function (n601) { return ((196 - (n601 - 1) * 6) / n601) * K_BAR_W_FRAC601; };
  // One bin inside each octave this mode names: base (40-160 Hz), mid (160-640), high (640-2560) and the outer
  // octave pair (2560-10240). The tap answers with 23.4 Hz bins (the mock's 24 kHz context and the panel's 1024
  // FFT, the same number the panel's own band map is built from), so: bin 3 is 70 Hz, bin 12 is 281 Hz, bin 60 is
  // 1406 Hz, bin 200 is 4688 Hz. These are fixtures, not a claim about the panel's mapping - the mapping is what
  // the checks below measure.
  const K_BINS601 = { base: [3], mid: [12], high: [60], outer: [200], all: [3, 12, 60, 200] };

  // (a) energy in every octave: the automatic count at the panel default 200 px strip, and every bar mirrored.
  const kA601 = await knightMount601({ 'deepamp:scope.mode': 'knight' }, 2);
  kA601.br.hotBins = K_BINS601.all.slice(); kA601.br.hotBinValue = 255; kA601.br.hotBinsR = K_BINS601.all.slice();
  let kStart601 = kA601.br.rectLog.length; kA601.br.frames(1);
  let kFrame601 = kA601.br.rectLog.slice(kStart601);
  let kAG601 = kGroups601(kSeg601(kFrame601));
  const kS5_601 = kSlots601(5);
  check('T-601, re-pointed 2026-10-28 09:1x Berlin: at the panel default 200 px strip the automatic count draws FIVE bars, the number the operator named for the default size, and the first bar is no longer sitting on the 2 px inset - the border the operator asked to be a few pixels wider is measured off the drawing',
    kS5_601.length === 5 && kS5_601.every(function (x601) { return kLit601(kAG601, x601); }) && Object.keys(kAG601).length === 5,
    { lit_slots: kS5_601.map(function (x601) { return (kLit601(kAG601, x601) ? 'lit' : 'dark') + '@' + x601; }).join(','),
      groups: Object.keys(kAG601).join(','),
      left_border_px: Math.min.apply(null, kSeg601(kFrame601).map(function (r601) { return r601[0]; })).toFixed(1),
      bar_width_px: kBarW601(5).toFixed(1) });
  check('T-601: every bar is mirrored about the middle line of the canvas - the segments of one bar sit on both sides of the line, and the two sides hold the same number of segments, which is what "expands from the middle line upwards and downwards symmetrically" means read off the drawing',
    kS5_601.every(function (x601) {
      const g601 = kAG601[x601] || [];
      return g601.length > 0 && kAbove601(g601).length > 0 && kAbove601(g601).length === kBelow601(g601).length
        && g601.length === kAbove601(g601).length + kBelow601(g601).length;
    }), { per_bar_halves: kS5_601.map(function (x601) { const g601 = kAG601[x601] || []; return kAbove601(g601).length + '+' + kBelow601(g601).length; }).join(',') });
  check('T-601: nothing is held in this mode - no peak cap row is drawn across a frame with energy in every octave, which is the ruling "Live level only, no hold" read off the drawing',
    kFrame601.filter(function (r601) { return r601[5] === '#e8e8e8'; }).length === 0,
    { cap_rows_drawn: kFrame601.filter(function (r601) { return r601[5] === '#e8e8e8'; }).length });

  // (b) the band ladder and the channels, one octave at a time. Stereo: the right analyser is silent.
  const kB601 = await knightMount601({ 'deepamp:scope.mode': 'knight' }, 2);
  kB601.br.hotBins = K_BINS601.high.slice(); kB601.br.hotBinValue = 255; kB601.br.hotBinsR = [];
  let kBS601 = kB601.br.rectLog.length; kB601.br.frames(1);
  const kBG601 = kGroups601(kSeg601(kB601.br.rectLog.slice(kBS601)));
  check('T-601: the LEFT bar reads the LEFT channel - energy at 1406 Hz on the left channel alone lights the bar at the left end of the strip, the high octave',
    kLit601(kBG601, kS5_601[0]), { slots_lit: kS5_601.filter(function (x601) { return kLit601(kBG601, x601); }).join(',') });
  check('T-601: the RIGHT bar does not read the left channel - the same octave at the right end of the strip stays dark when the right channel is silent (the ruling: "Left bars read L, right bars read R")',
    !kLit601(kBG601, kS5_601[4]), { right_slot: kS5_601[4] });
  check('T-601: the middle bar is the BASE octave, not a copy of the outer bars - it is dark when the only energy in the frame is at 1406 Hz',
    !kLit601(kBG601, kS5_601[2]), { middle_slot: kS5_601[2] });

  const kC601 = await knightMount601({ 'deepamp:scope.mode': 'knight' }, 2);
  kC601.br.hotBins = []; kC601.br.hotBinsR = K_BINS601.base.slice(); kC601.br.hotBinValue = 255;
  let kCS601 = kC601.br.rectLog.length; kC601.br.frames(1);
  const kCG601 = kGroups601(kSeg601(kC601.br.rectLog.slice(kCS601)));
  check('T-601: the middle bar is the "center/both" reading - base energy on the right channel alone lights it, while the left bars stay dark',
    kLit601(kCG601, kS5_601[2]) && !kLit601(kCG601, kS5_601[0]) && !kLit601(kCG601, kS5_601[1]),
    { slots_lit: kS5_601.filter(function (x601) { return kLit601(kCG601, x601); }).join(',') });

  // (c) a mono take: the ruling "Mono feeds all bars the same". The same 1406 Hz energy, no second channel.
  const kD601 = await knightMount601({ 'deepamp:scope.mode': 'knight' }, 1);
  kD601.br.hotBins = K_BINS601.high.slice(); kD601.br.hotBinValue = 255;
  let kDS601 = kD601.br.rectLog.length; kD601.br.frames(1);
  const kDG601 = kGroups601(kSeg601(kD601.br.rectLog.slice(kDS601)));
  check('T-601: on a mono take every bar is fed from the same read - the energy that lit only the LEFT end of a stereo strip lights BOTH outer high octaves here',
    kLit601(kDG601, kS5_601[0]) && kLit601(kDG601, kS5_601[4]),
    { slots_lit: kS5_601.filter(function (x601) { return kLit601(kDG601, x601); }).join(',') });

  // (d) the bar count setting: the box on this mode's row, its cycle, what it stores, and what it draws.
  const kE601 = await knightMount601({ 'deepamp:scope.mode': 'knight' }, 1);
  const kBarsBox601 = function () { return kE601.m.els('audio-play-scope-bars601')[0]; };
  check('T-601, re-pointed 2026-10-28 09:1x Berlin on the operator ruling of 09:1x ("drop the first one, and pin it to dB without a switch"): the Knight Rider row is in the visualizer settings table, it carries NO level box - the mode has one reading now - and its two boxes are the bar count (the column every other mode per-mode control occupies) and the colour word, printing "auto" and "red"',
    !!kE601.m.els('audio-play-scope-mode531-knight')[0] && !!kBarsBox601() && !kE601.m.els('audio-play-scope-level346-knight')[0]
      && !!kE601.m.els('audio-play-scope-scheme536-knight')[0]
      && kE601.m.ownText(kBarsBox601()) === 'auto'
      && kE601.m.ownText(kE601.m.els('audio-play-scope-scheme536-knight')[0]) === 'red',
    { bars_word: kE601.m.ownText(kBarsBox601()), colour_word: kE601.m.ownText(kE601.m.els('audio-play-scope-scheme536-knight')[0]) });
  const kDraw601 = function (br601, n601) {
    br601.hotBins = K_BINS601.all.slice(); br601.hotBinValue = 255;
    const s601 = br601.rectLog.length; br601.frames(1);
    const g601 = kGroups601(kSeg601(br601.rectLog.slice(s601)));
    const slots601 = kSlots601(n601);
    return { groups: Object.keys(g601).length, lit: slots601.filter(function (x601) { return kLit601(g601, x601); }).length };
  };
  kBarsBox601().props.onClick(); kE601.m.commit(); await flush();
  const kWord3_601 = kE601.m.ownText(kBarsBox601());
  const kDraw3_601 = kDraw601(kE601.br, 3);
  check('T-601: the bar-count box presses auto -> 3, the strip draws THREE bars with that setting, all three lit because each carries a band, and 3 is what the panel stores',
    kWord3_601 === '3' && kDraw3_601.groups === 3 && kDraw3_601.lit === 3 && kE601.br.store['deepamp:scope.knight.bars601'] === '3',
    { word: kWord3_601, groups: kDraw3_601.groups, lit: kDraw3_601.lit, stored: kE601.br.store['deepamp:scope.knight.bars601'] });
  kBarsBox601().props.onClick(); kE601.m.commit(); await flush();
  const kWord5_601 = kE601.m.ownText(kBarsBox601());
  const kDraw5_601 = kDraw601(kE601.br, 5);
  kBarsBox601().props.onClick(); kE601.m.commit(); await flush();
  const kWord7_601 = kE601.m.ownText(kBarsBox601());
  const kDraw7_601 = kDraw601(kE601.br, 7);

  check('T-601: the cycle walks 3 -> 5 -> 7 and a forced 7 draws SEVEN bars, every one of them lit because 7 carries an octave for each bar',
    kWord5_601 === '5' && kDraw5_601.groups === 5 && kWord7_601 === '7' && kDraw7_601.groups === 7 && kDraw7_601.lit === 7,
    { words: [kWord3_601, kWord5_601, kWord7_601].join(' -> '), groups_7: kDraw7_601.groups, lit_7: kDraw7_601.lit });
  kBarsBox601().props.onClick(); kE601.m.commit(); await flush();
  check('T-601: the cycle wraps back to auto, and auto is what the panel starts with on a browser that never set it',
    kE601.m.ownText(kBarsBox601()) === 'auto' && kE601.br.store['deepamp:scope.knight.bars601'] === 'auto',
    { word: kE601.m.ownText(kBarsBox601()), stored: kE601.br.store['deepamp:scope.knight.bars601'] });

  // (e) the colour words: the Knight Rider red is the default, and the ramps this panel already has are offered.
  const kF601 = await knightMount601({ 'deepamp:scope.mode': 'knight', 'deepamp:scope.schemes': '{"knight":"ironbow"}' }, 1);
  kF601.br.hotBins = K_BINS601.all.slice(); kF601.br.hotBinValue = 255;
  let kFS601 = kF601.br.rectLog.length; kF601.br.frames(1);
  const kFFrame601 = kF601.br.rectLog.slice(kFS601);
  const kG601 = await knightMount601({ 'deepamp:scope.mode': 'knight' }, 1);
  kG601.br.hotBins = K_BINS601.all.slice(); kG601.br.hotBinValue = 255;
  let kGS601 = kG601.br.rectLog.length; kG601.br.frames(1);
  const kGFrame601 = kG601.br.rectLog.slice(kGS601);
  const kColours601 = function (log601) { return kSeg601(log601).map(function (r601) { return String(r601[5]); }); };
  check('T-601: the colour word on this row is a real ramp and not the same red painted twice - the same bins painted under "ironbow" draw different colours from the same bins painted under "red" (the rainbow the operator asked to be offered)',
    kColours601(kFFrame601).length > 4 && kColours601(kGFrame601).length > 4
      && kColours601(kFFrame601).join('|') !== kColours601(kGFrame601).join('|'),
    { ironbow_first: kColours601(kFFrame601)[0], red_first: kColours601(kGFrame601)[0], segments: kColours601(kFFrame601).length });
  const kColourBox601 = kF601.m.els('audio-play-scope-scheme536-knight')[0];
  const kWordF601 = kF601.m.ownText(kColourBox601);
  kColourBox601.props.onClick(); kF601.m.commit(); await flush();
  const kWordG601 = kF601.m.ownText(kF601.m.els('audio-play-scope-scheme536-knight')[0]);
  check('T-601: the colour box on this row cycles the words this mode was given, and the press walks from the rainbow to the next ramp in its list',
    kWordF601 === 'ironbow' && kWordG601 === 'cold', { cycle: kWordF601 + ' -> ' + kWordG601 });

  // (f) source contract: one painter, one count rule, one band mapping honest about the analyser's own bin width.
  const kSrc601 = require('fs').readFileSync(TARGET, 'utf8');
  check('T-601 source: the Knight Rider mode is ONE painter hung on the draw loop, its count rule is one function, and its bands are computed from the analyser\'s own bin width',
    (kSrc601.match(/function scopeKnightFrame601\(/g) || []).length === 1
      && (kSrc601.match(/scopeKnightFrame601\(g, W, H, t,/g) || []).length === 1
      && (kSrc601.match(/function scopeKnightCount601\(/g) || []).length === 1
      && (kSrc601.match(/function scopeKnightBandBins601\(/g) || []).length === 1
      && /SCOPE_KNIGHT_BAND_HZ601\[band601\]/.test(kSrc601),
    { frame_definitions: (kSrc601.match(/function scopeKnightFrame601\(/g) || []).length });

  // T-735 (2026-11-06 Berlin, WM-31 item 9 with WM-30 item 9, at the operator's word on the open list -
  // "6 go ahead as suggested"). The item asked for a measurement and not a change, so this is the measurement: for
  // every visualizer mode the panel can be showing, and for every clock face with the strip off, one second of
  // panel time is driven at the display's own 60 Hz and everything the panel asked the canvas for is counted -
  // fills, strokes WITH the length of each path, prints, clips, save/restore pairs, translates - plus how often the
  // analyser was read, how many of the offered frames actually drew, and how many React renders the face cost.
  // What this is not, stated because a number like this invites the over-reading: these are OPERATIONS PER FRAME,
  // not milliseconds in a browser. The Node-side time is printed as well and it is the weakest column here - the
  // mock canvas rasterises nothing - so what the table gives is the SHAPE of a frame's cost, and a real fps figure
  // belongs to the browser round this item is paired with (WM-17). The mode list, the face list and the fps options
  // are read out of the client rather than written out here, so this table cannot fall behind a face the way a
  // hand-copied list does.
  const src735 = require('fs').readFileSync(TARGET, 'utf8');
  const listFrom735 = function (name735) {
    const hit735 = src735.match(new RegExp('var ' + name735 + ' = \\[([^\\]]*)\\]'));
    if (!hit735) throw new Error('T-735: ' + name735 + ' could not be read out of the client');
    const out735 = JSON.parse('[' + hit735[1] + ']');
    if (!Array.isArray(out735) || !out735.length) throw new Error('T-735: ' + name735 + ' read empty');
    return out735;
  };
  const modes735 = listFrom735('SCOPE_MODES300');
  const faces735 = listFrom735('CLOCK_MODES681');
  const fpsOpts735 = listFrom735('SCOPE_FPS_OPTS537');
  const TICKS735 = 60;              // one second of panel time, taken as the 60 frames the panel says the display offers
  const STEP735 = 1000 / TICKS735;  // 16.67 ms a frame, which is the real frame period at 60 Hz. Sixty steps of 16 ms
                                    // is 960 ms, and a panel that ticks once a second never ticks inside a second
                                    // measured that way - which is exactly how the first version of this instrument
                                    // reported every clock face as costing nothing.
  const BASE735 = 1700000000000;    // a fixed wall clock, so these numbers do not depend on when the suite ran
  const UPDATE_MS735 = 250;         // the cadence a playing element fires its own timeupdate at, about four a second -
                                    // the number the client's note at the scopeLive300 gate measured for a live stream.
                                    // The static face is driven by those events and by nothing else, so an instrument
                                    // that does not fire them measures a face that is not being used.
  const snap735 = function (b735) {
    return {
      rects: b735.fillRects, badRects: b735.badRects, strokes: b735.strokes, paths: b735.paths,
      points: (b735.strokePaths || []).reduce(function (n735, p735) { return n735 + ((p735 && p735.path) || []).length; }, 0),
      texts: b735.fillTexts, clips: b735.clips || 0, saves: b735.saves || 0, restores: b735.restores || 0,
      translates: b735.translates || 0, freq: b735.freqCalls, time: b735.timeCalls, ctxBuilt: b735.ctxBuilt,
    };
  };
  const ops735 = function (s735) { return s735.rects + s735.strokes + s735.texts + s735.clips + s735.saves; };
  const minus735 = function (a735, b735) {
    const o735 = {}; Object.keys(a735).forEach(function (k735) { o735[k735] = a735[k735] - b735[k735]; });
    return o735;
  };
  // A take, for the one face that draws from a file's peaks. The wave shape is the same voice-shaped one the
  // VU measurements in this file use (a carrier with a ripple on it), so the face is drawing a real signal and not
  // an empty array.
  const peaksFor735 = [];
  for (let i735 = 0; i735 < 240; i735++) {
    const v735 = Math.sin(i735 / 9) * (i735 < 120 ? 0.72 : 0.18);
    peaksFor735.push({ max: v735 > 0 ? v735 : 0, min: v735 < 0 ? v735 : 0 });
  }
  const takeFor735 = [{ id: 'ap-7351', fn: 'tts', kind: 'tts', status: 'ok', model: 'm1', voice: 'voy_janeway', duration: 3.44, text: 'the take' }];
  // One target: mount it, arm it playing, drive one second of panel time against a virtual clock that agrees with the
  // timestamps the panel is handed, and count what it did on BOTH paths a face can be drawn from. That split is not
  // decoration - it is what this measurement found. The strip is drawn from the animation loop. A clock face is
  // drawn from a one-second tick that repaints the canvas by hand, and with the strip off there is no animation loop
  // at all. A face that costs 250 operations a frame and a face that costs one draw a second are different answers
  // to the same question, and an instrument that only watched the animation loop reported the second kind as free.
  // Each row is mounted in the state its own name describes. A strip row is mounted with something playing, because
  // that is the only state in which a strip draws. A clock row is mounted with NOTHING playing, because that is the
  // state a clock is used in: a panel whose element is paused fires no media events at all, and a clock measured
  // against a playing element would be charged for repaints an idle panel never pays for. The static row is mounted
  // with a real take - a real duration and a position that advances - because the one thing it draws is a picture of
  // a file, and the panel only asks a lane for a file's peaks when it knows the file has a length.
  const runTarget735 = async function (storage735, want735, state735) {
    const st735 = state735 || {};
    const timers735 = [];
    const timer735 = {
      interval: function (fn735, ms735) { if (typeof fn735 === 'function') timers735.push({ fn: fn735, ms: ms735 | 0, next: BASE735 + (ms735 | 0) }); return function () {}; },
      timeout: function () { return function () {}; },
    };
    const b735 = makeBrowser({ storage: storage735 });
    const m735 = await mount(b735, st735.take
      ? { canvas2d: true, audioTracks: 1, timer: timer735, peaks: peaksFor735, channels: 1, sampleRate: 48000, bytes: 165120, items: takeFor735 }
      : { canvas2d: true, audioTracks: 1, timer: timer735 });
    m735.commit(); await flush();
    await openAllSections(m735.shim, m735.comp);
    m735.commit(); await flush(); m735.commit(); await flush();
    let pressed735 = false;
    if (st735.take) {
      const play735 = m735.created().filter(function (e735) {
        return e735.type === 'button' && /play the row the transport is on/.test(String(e735.props && e735.props.title));
      }).pop();
      if (play735) { pressed735 = true; play735.props.onClick(); await flush(); m735.commit(); await flush(); }
    }
    // The panel registers its media handler as an element PROPERTY (node.ontimeupdate = fn), which is what the
    // other fixtures in this file drive. The suite's own fire() plays the addEventListener path. Both are driven
    // here, so this instrument does not depend on which registration the panel happens to use.
    const mediaEvent735 = function (node735x, t735) {
      if (typeof node735x['on' + t735] === 'function') node735x['on' + t735]();
      if (typeof node735x.fire === 'function') node735x.fire(t735);
    };
    let node735 = null;
    if (st735.playing !== false) {
      node735 = m735.armAudio(1);
      if (node735 && st735.take) node735.duration = takeFor735[0].duration;   // a take the browser knows the length of
      if (node735) mediaEvent735(node735, 'timeupdate');
      m735.commit(); await flush();
    }
    const landed735 = want735 ? want735(b735, m735) : true;
    m735.commit(); await flush();
    const pre735 = snap735(b735);
    const realNow735 = Date.now;
    let virt735 = BASE735;
    Date.now = function () { return virt735; };
    const t0735 = realNow735();
    let drewRaf735 = 0, drewWake735 = 0, rafCbs735 = 0, ticks735 = 0;
    let wakes735 = 0, mediaEvents735 = 0, opsRaf735 = 0, opsWake735 = 0;
    // A wake is anything that can make the panel paint without an animation frame: the panel's own interval, or the
    // media element handing the panel a position. Both are counted the same way - what the canvas did around it.
    const wake735 = async function (fn735) {
      const a735 = snap735(b735);
      fn735(); m735.commit(); await flush();
      const d735 = ops735(snap735(b735)) - ops735(a735);
      wakes735++; opsWake735 += d735; if (d735 > 0) drewWake735++;
    };
    let nextUpdate735 = BASE735 + UPDATE_MS735;
    for (let k735 = 0; k735 < TICKS735; k735++) {
      virt735 = BASE735 + Math.round((k735 + 1) * STEP735);
      if (node735) {
        while (nextUpdate735 <= virt735) {
          const pos735 = (nextUpdate735 - BASE735) / 1000;
          node735.currentTime = st735.take ? Math.min(pos735, takeFor735[0].duration - 0.05) : pos735;
          mediaEvents735++;
          await wake735(function () { mediaEvent735(node735, 'timeupdate'); });
          nextUpdate735 += UPDATE_MS735;
        }
      }
      for (let t735 = 0; t735 < timers735.length; t735++) {
        const tm735 = timers735[t735];
        while (tm735.next <= virt735) { await wake735(tm735.fn); tm735.next += tm735.ms; }
      }
      const q735 = b735.rafQueue; b735.rafQueue = [];
      const preF735 = snap735(b735);
      for (let i735 = 0; i735 < q735.length; i735++) { ticks735++; rafCbs735++; q735[i735][1](virt735); }
      const dF735 = ops735(snap735(b735)) - ops735(preF735);
      opsRaf735 += dF735; if (dF735 > 0) drewRaf735++;
    }
    const ms735 = realNow735() - t0735;
    Date.now = realNow735;
    return {
      landed: landed735, pressed: pressed735, span: virt735 - BASE735, drewRaf: drewRaf735, drewWake: drewWake735,
      wakes: wakes735, mediaEvents: mediaEvents735, ticks: ticks735, rafCbs: rafCbs735, opsRaf: opsRaf735,
      opsWake: opsWake735, ms: ms735, d: minus735(snap735(b735), pre735),
    };
  };
  const modeLanded735 = function (mode735) {
    return function (b735, m735) {
      return b735.store['deepamp:scope.mode'] === mode735
        && (mode735 === 'off' ? m735.modeLabel() === 'visualizer off' : !!m735.modeLabel() && m735.modeLabel() !== 'visualizer off');
    };
  };
  const faceLanded735 = function (face735) {
    return function (b735, m735) {
      return b735.store['deepamp:clock.on681'] === '1' && b735.store['deepamp:clock.mode681'] === face735
        && m735.els('audio-play-clock-face681').length === 1;
    };
  };
  const rows735 = [];
  for (let i735 = 0; i735 < modes735.length; i735++) {
    // The static face is the one face that draws from a file's peaks instead of the live tap, so it is the one row
    // this instrument mounts with a take. The others are mounted as a person has them when nothing is loaded, which
    // is the state their own contract says they draw in.
    const take735 = modes735[i735] === 'static';
    const r735 = await runTarget735({ 'deepamp:scope.mode': modes735[i735] }, modeLanded735(modes735[i735]), { playing: true, take: take735 });
    rows735.push({ kind: 'mode', name: modes735[i735], r: r735, take: take735 });
  }
  for (let i735 = 0; i735 < faces735.length; i735++) {
    const r735 = await runTarget735({
      'deepamp:scope.mode': 'off', 'deepamp:clock.on681': '1', 'deepamp:clock.mode681': faces735[i735],
    }, faceLanded735(faces735[i735]), { playing: false, take: false });
    rows735.push({ kind: 'face', name: faces735[i735], r: r735 });
  }
  // The guard on the measurement, not a new contract: a number from a face that was not actually on screen, or from
  // a face that drew nothing while claiming to draw, is not a measurement at all. `off` is the one row that is
  // SUPPOSED to draw nothing - that is its contract, and it is asserted here as its own half of the guard.
  const bad735 = rows735.filter(function (row735) {
    if (!row735.r.landed) return true;
    if (row735.take && !row735.r.pressed) return true;   // a peaks face measured without a row to read peaks from
    if (row735.name === 'off') return ops735(row735.r.d) !== 0;
    return ops735(row735.r.d) === 0;
  }).map(function (row735) {
    if (!row735.r.landed) return row735.kind + ':' + row735.name + ' did not land';
    if (row735.take && !row735.r.pressed) return row735.kind + ':' + row735.name + ' had no row to play';
    return row735.kind + ':' + row735.name + ' drew nothing';
  });
  check('T-735 measurement guard: every mode and every clock face this table reports was really the one on screen, every face that draws drew something, and the one mode that promises to draw nothing drew nothing',
    bad735.length === 0 && rows735.length === modes735.length + faces735.length,
    { rows: rows735.length, faults: bad735 });
  const print735 = function (row735) {
    const r735 = row735.r, d735 = r735.d, per735 = function (n735) { return Math.round((n735 / TICKS735) * 100) / 100; };
    console.log('  MEASURE T-735 ' + row735.kind + ' ' + row735.name
      + ': ' + r735.span + 'ms_of_panel_time ops ' + ops735(d735)
      + ' (animation_path ' + r735.opsRaf + ' wake_path ' + r735.opsWake
      + ') | frames_drew ' + r735.drewRaf + '/' + TICKS735 + ' offered, wakes ' + r735.wakes
      + ' (panel_intervals ' + (r735.wakes - r735.mediaEvents) + ' media_timeupdate ' + r735.mediaEvents
      + ') of_which_drew ' + r735.drewWake
      + ' | per_second: rects ' + d735.rects + ' strokes ' + d735.strokes + ' paths ' + d735.paths
      + ' path_points ' + d735.points + ' prints ' + d735.texts + ' clips ' + d735.clips
      + ' save_restore ' + d735.saves + '/' + d735.restores + ' translates ' + d735.translates
      + ' analyser_freq_time ' + d735.freq + '/' + d735.time + ' bad_rects ' + d735.badRects
      + ' | per_offered_frame: ops ' + per735(ops735(d735)) + ' rects ' + per735(d735.rects)
      + ' strokes ' + per735(d735.strokes) + ' prints ' + per735(d735.texts)
      + ' | node_ms ' + Math.round(r735.ms));
  };
  rows735.forEach(print735);
  // The fps control's own hover makes a claim about cadence - "60 draws every frame the display offers; 30 every
  // second frame, 20 every third, 12 every fifth" - and no check in this file has ever measured that claim, only
  // that the control exists, offers those four values and stores one. The two most expensive strip faces this table
  // found are swept over the four options, and what is counted is frames that drew, out of the frames offered.
  const paidModes735 = rows735.filter(function (row735) { return row735.kind === 'mode' && row735.name !== 'off'; })
    .sort(function (a735, b735) {
      return (ops735(b735.r.d) + b735.r.d.points) - (ops735(a735.r.d) + a735.r.d.points); });
  const sweep735 = [];
  for (let p735 = 0; p735 < 2 && p735 < paidModes735.length; p735++) {
    const row735 = paidModes735[p735];
    for (let f735 = 0; f735 < fpsOpts735.length; f735++) {
      const r735 = await runTarget735({
        'deepamp:scope.mode': row735.name, 'deepamp:scope.fps': String(fpsOpts735[f735]),
      }, modeLanded735(row735.name), { playing: true, take: false });
      sweep735.push({ row: row735.name, fps: fpsOpts735[f735], drew: r735.drewRaf, ops: ops735(r735.d) });
      console.log('  MEASURE T-735 fps ' + row735.name + ' at ' + fpsOpts735[f735]
        + ' fps: frames_drew ' + r735.drewRaf + '/' + TICKS735 + ' offered, ops_this_second ' + ops735(r735.d)
        + ', which saves ' + Math.round((1 - r735.drewRaf / TICKS735) * 100) + '% of the frames the display offers');
    }
  }
  check('T-735: the fps control draws at the cadence its own hover promises - 60 every offered frame, 30 one in two, 20 one in three, 12 one in five - measured as frames that drew, on the two most expensive strip faces this table found',
    sweep735.length === 2 * fpsOpts735.length
      && sweep735.every(function (s735) { return s735.drew === Math.round(TICKS735 * s735.fps / 60); }),
    { sweep: sweep735.map(function (s735) { return s735.row + '@' + s735.fps + ':' + s735.drew; }) });
  const paid735 = rows735.slice().sort(function (a735, b735) {
    return (ops735(b735.r.d) + b735.r.d.points) - (ops735(a735.r.d) + a735.r.d.points); });
  const worst735 = paid735[0];
  console.log('  MEASURE T-735 the most expensive face on this panel is ' + worst735.kind + ' ' + worst735.name
    + ' at ' + ops735(worst735.r.d) + ' canvas operations in one second of panel time ('
    + Math.round((ops735(worst735.r.d) / TICKS735) * 100) / 100 + ' per offered frame), '
    + worst735.r.d.points + ' path points across its strokes, '
    + worst735.r.drewRaf + ' of ' + TICKS735 + ' offered frames it drew');
  const cheap735 = paid735.filter(function (row735) { return ops735(row735.r.d) > 0; }).pop();
  console.log('  MEASURE T-735 the cheapest face that still draws is ' + cheap735.kind + ' ' + cheap735.name
    + ' at ' + ops735(cheap735.r.d) + ' operations in a second, drawn on the '
    + (cheap735.r.opsWake > 0 && cheap735.r.opsRaf === 0 ? 'wake path only'
      : cheap735.r.opsWake === 0 ? 'animation path only' : 'both paths')
    + ' (' + cheap735.r.drewWake + ' draws across ' + cheap735.r.wakes + ' wakes, '
    + cheap735.r.drewRaf + ' across ' + TICKS735 + ' offered frames)');
  const wakePath735 = rows735.filter(function (row735) { return row735.r.opsWake > 0; })
    .map(function (row735) { return row735.kind + ':' + row735.name; });
  console.log('  MEASURE T-735 which faces are drawn on the wake path at all (a repaint the panel hands itself, not a frame): '
    + (wakePath735.length ? wakePath735.join(' ') : 'none - every face this panel draws comes from the animation loop'));

  // ---------------------------------------------------------------- T-752 (2026-11-07): which silhouette dances, and how the whale moves
  // The operator's ask, verbatim: "i was actually thinking about integrating the whale as an alternative to the llama
  // icon in the llama visualizer, ... the rolling whale is funny, keep it, but also add the qwen and whale icons as
  // options (setting) to replace the dancing llama, and add an option for the 'rolling whale' to also be a 'swimming
  // whale'". Two panel settings, each defaulting to what its mode did before this card, so the first thing measured
  // below is the old picture, unchanged, and only then the new ones.
  //
  // HOW EACH ANSWER IS READ.
  //   1. Which animal stands on the llama's floor is a bounding box and a cell count. In that mode every 2x2 rect on
  //      the visible canvas is a cell of the animal -- the wall and the mirrored floor are drawImage blits, not
  //      rectangles -- so the silhouette is measurable without a canvas: how far it reaches, and how many cells it
  //      paints.
  //   2. How the whale moves is read from its cells. The angle a body carries shows up as its DRAWN HEIGHT (a body
  //      turned 45 degrees is taller than the same body lying level); the water shows up as which of the mode's TWO
  //      existing inks a cell is painted in; a jump shows up as the gap between the body's lowest cell and the
  //      ground line it otherwise rides.
  //   3. The arc itself cannot be sampled evenly by a run of frames -- one flight is 900 ms and the frames are 16 ms
  //      apart -- so the arc and its cap are read out of the client and evaluated here, the way T-539 measures a bar
  //      curve and T-751 a strike.
  // THE FIXTURE'S CONTROL. Every mark run below that wants a full reading uses the same loud fixture -- every bin of
  // the mock at the top of its dB window -- so every band of the rail measures full and every rail bar is 2 x 8 px in
  // both runs of a comparison. A rect of the rail colour that is 2 px tall -- the cell height, not the bar height --
  // is therefore by construction a cell of the body under the water and not a rail bar, which is how "the submerged
  // part is the water's own colour" is measured without inventing a third colour to look for. A quiet fixture is the
  // opposite reading: no rail, no water, and the animal sits on the ground line.
  // THE CLOCK. b.frames(n) advances only the rAF timestamp. The bob, the wallow and the breach cooldown are timed in
  // milliseconds off Date.now, so a run that wants them has to hand the panel a clock: the T-729 pattern, one
  // override per frame, restored afterwards. The base a run uses is the next multiple of the bob period that is
  // after the moment the run starts, which is what keeps a flight's age positive (a negative age is a negative
  // rise, and a negative rise drives the body through the floor it is measured against) and keeps the phase every
  // run samples a number written in this file rather than an accident of when the suite ran.
  // ONE MOUNT AT A TIME. mount() installs the browser globals it hands the panel, so a second live mount takes over
  // the first one's requestAnimationFrame: the panel of the earlier mount then queues its frames into the later
  // browser's queue and the earlier run draws one frame and stops. Every comparison below therefore runs one mount,
  // reads its numbers, tears it down, and mounts the next. The two runs are still the same measurement because the
  // fixture and the clock phase are given by the same per-frame hook to both.
  const q752Num752 = function (re752) { const m752 = re752.exec(src); return m752 ? parseFloat(m752[1]) : NaN; };
  const q752SrcList752 = function (name752) {
    const m752 = new RegExp('var ' + name752 + ' = \\[([^\\]]*)\\];').exec(src);
    if (!m752) return null;
    return (m752[1].match(/"[^"]*"/g) || []).map(function (s752) { return s752.replace(/"/g, ''); });
  };
  // The mask literals, counted out of the source the way the T-542 and T-749 provenance pins count them.
  // T-754 (2026-11-07): a name may now be the SAME array under a second name -- `var SCOPE_DANCE_WHALE_MASK752 =
  // SCOPE_WHALE_MASK749;` -- because the operator asked for the whale in the dancing mode to be the mark and no
  // bigger than the llama. The reader follows that one hop and says which name it actually read, so a shared shape
  // is measured once and the pin reports the sharing instead of finding an empty grid. Nothing downstream changed:
  // the counts are still counted out of the source text, still through the decimal string and not through bit
  // operators, and an alias that points at nothing is still a NaN the pins will trip over.
  const q752Mask752 = function (name752) {
    let readFrom754 = name752;
    let rows752 = (src.match(new RegExp('var ' + name752 + ' = \\[([\\s\\S]*?)\\n    \\];')) || [])[1] || '';
    if (!rows752) {
      const alias754 = (src.match(new RegExp('var ' + name752 + ' = ([A-Za-z0-9_]+);')) || [])[1] || null;
      if (alias754) {
        readFrom754 = alias754;
        rows752 = (src.match(new RegExp('var ' + alias754 + ' = \\[([\\s\\S]*?)\\n    \\];')) || [])[1] || '';
      }
    }
    const vals752 = (rows752.match(/0x[0-9a-f]+/g) || []).map(function (v752) { return parseInt(v752, 16); });
    // Counted through the decimal string, not through bit operators: the masks this card adds are 46 and 33 columns
    // wide, and `x >>>= 1` truncates a number to 32 bits -- the same trap the client fell into, measured in
    // scratch/mask_extent_probe_752.cjs. Every mask here is under 2^53, where toString(2) is exact.
    const lit752 = vals752.reduce(function (a752, v752) {
      return a752 + ((v752.toString(2).match(/1/g) || []).length);
    }, 0);
    let hi752 = -1, lo752 = 999, topRow752 = -1, bottomRow752 = -1;
    vals752.forEach(function (v752, r752) {
      const b752 = v752.toString(2);
      for (let i752 = 0; i752 < b752.length; i752++) {
        if (b752[i752] !== '1') continue;
        const bit752 = b752.length - 1 - i752;
        hi752 = Math.max(hi752, bit752); lo752 = Math.min(lo752, bit752);
        if (topRow752 < 0) topRow752 = r752;
        bottomRow752 = r752;
      }
    });
    return { rows: vals752.length, lit: lit752, colsLit: hi752 < 0 ? 0 : hi752 - lo752 + 1,
             rowsLit: bottomRow752 - topRow752 + 1, topRow: topRow752, footRow: bottomRow752,
             readFrom: readFrom754 };
  };
  // A pure helper out of the client, evaluated here (the T-539 / T-751 pattern): the declaration plus a return of
  // its own name. Both of this card's helpers are declared at the component body's own indent, so the closing brace
  // of the declaration is the first line that is four spaces and a brace -- a nested brace in the body is deeper.
  const q752Build752 = function (name752) {
    const at752 = src.indexOf('function ' + name752 + '(');
    if (at752 < 0) return null;
    const close752 = src.indexOf('\n    }', at752);
    if (close752 < 0) return null;
    const body752 = src.slice(at752, close752 + 6);
    if (body752.length < 150) return null;
    try { return new Function(body752 + '\n return ' + name752 + ';')(); } catch (e752) { return null; }
  };
  // Geometry the mode is drawn into, read from the client rather than written down as a literal.
  const q752H752 = q752Num752(/SCOPE_H300 = (\d+);/);                 // 80 CSS px
  const q752Inset752 = q752Num752(/SCOPE_EDGE_INSET300 = (\d+);/);   // 2
  const q752W752 = 200;                                               // the strip box every scope run here mounts at
  const q752Ground752 = q752H752 - q752Inset752;                     // 78: the bottom inner edge, where a mark rides
  const q752InnerTop752 = q752Inset752;                              // 2: the top inner edge
  const q752MkCols752 = q752Num752(/SCOPE_WHALE_COLS749 = (\d+);/);
  const q752MkRows752 = q752Num752(/SCOPE_WHALE_ROWS749 = (\d+);/);
  const q752MkCell752 = q752Num752(/SCOPE_WHALE_CELL749 = (\d+);/);
  const q752MkLit752 = q752Num752(/SCOPE_WHALE_LIT749 = (\d+);/);
  const q752MkHalfW752 = q752MkCols752 * q752MkCell752 / 2;         // 30
  const q752MkHalfH752 = q752MkRows752 * q752MkCell752 / 2;         // 22
  const q752MkLevelH752 = q752MkRows752 * q752MkCell752;            // 44: the mark's own height, unturned
  const q752RailH752 = q752Num752(/SCOPE_MARK_RAIL748 = (\d+);/) * q752MkCell752;   // 8 px of rail at full measured energy
  const q752SwimPitchMax752 = q752Num752(/SCOPE_SWIM_PITCH_BASE752 = ([0-9.]+);/) + q752Num752(/SCOPE_SWIM_PITCH_GAIN752 = ([0-9.]+);/);
  const q752BobMax752 = q752MkCell752 * (q752Num752(/SCOPE_SWIM_BOB_BASE752 = ([0-9.]+);/) + q752Num752(/SCOPE_SWIM_BOB_GAIN752 = ([0-9.]+);/));
  const q752BobPeriodMs752 = q752Num752(/SCOPE_SWIM_BOB_PERIOD752_MS = (\d+);/);
  const q752PitchPeriodMs752 = q752Num752(/SCOPE_SWIM_PITCH_PERIOD752_MS = (\d+);/);
  const q752IconLlamaLit752 = q752Num752(/SCOPE_LLAMA_LIT542 = (\d+);/);
  const q752Onset752 = q752Num752(/SCOPE_BREACH_ONSET752 = (\d+);/);
  const q752CooldownMs752 = q752Num752(/SCOPE_BREACH_COOLDOWN752_MS = (\d+);/);
  const q752BgInk752 = (src.match(/var SCOPE_BG300 = "([^"]+)";/) || [])[1] || '#0b0d0b';
  const q752RiseMin752 = q752Num752(/SCOPE_BREACH_RISE_MIN752 = (\d+);/);
  const q752RiseMax752 = q752Num752(/SCOPE_BREACH_RISE_MAX752 = (\d+);/);
  const q752BreachPitch752 = q752Num752(/SCOPE_BREACH_PITCH752 = ([0-9.]+);/);
  const q752FlightMs752 = q752Num752(/SCOPE_BREACH_FLIGHT752_MS = (\d+);/);

  // Mount into one of the two modes this card touches, with the settings open so both new controls are reachable,
  // and enter the mode the way the settings matrix enters it (a press on the mode's own button).
  const q752Mount752 = async function (storage752, mode752) {
    const br752 = makeBrowser({ storage: Object.assign({ 'deepamp:scope.mode': mode752 }, storage752 || {}) });
    const mt752 = await mount(br752, { canvas2d: true, audioTracks: 1, channels: 1, sampleRate: 48000 });
    mt752.commit(); await flush();
    await openAllSections(mt752.shim, mt752.comp);
    mt752.commit(); await flush();
    mt752.armAudio(1);
    mt752.commit(); await flush();
    // The press on a mode button may itself draw a frame, and the mock's default fixture is not silence: a mount
    // that wants a clean first frame has to ask for one. Every run below sets its own fixture per frame anyway.
    br752.hotBins = [];
    mt752.els('audio-play-scope-mode531-llama')[0].props.onClick(); mt752.commit(); await flush();
    mt752.els('audio-play-scope-mode531-' + mode752)[0].props.onClick(); mt752.commit(); await flush();
    br752.rectLog.length = 0;
    return { br: br752, m: mt752 };
  };
  // Fixtures. LOUD puts every bin at the top of the mock's dB window, so every band measures full and the mode's
  // own measured energy is 1: the rail is 8 px tall in every column and a cell of the rail colour that is 2 px
  // tall cannot be anything but a cell of the body under the water. QUIET is silence: no rail, no water, no hop.
  const q752Loud752 = function (br752) {
    const all752 = []; for (let i752 = 0; i752 < 512; i752++) all752.push(i752);
    br752.hotBins = all752; br752.hotBinValue = 255;
  };
  const q752Quiet752 = function (br752) { br752.hotBins = []; };
  const q752LoudQuietAlt752 = function (br752, k752) {
    if (k752 % 2 === 0) q752Loud752(br752); else q752Quiet752(br752);
  };
  // Frames on a clock this section controls: 16 ms per frame off a fixed base, with an optional per-frame hook for
  // a fixture that changes between frames (the alternating loudness that drives an onset). b.frames(n) advances only
  // the rAF timestamp, and the bob, the wallow and the breach cooldown are timed in milliseconds off Date.now, so a
  // run that wants them has to hand the panel a clock: the T-729 pattern, one override per frame, restored after.
  // The base is chosen, not picked. It is the next multiple of the LEAST COMMON MULTIPLE of the two ruled periods
  // -- 1700 ms bob and 2200 ms wallow, which is 37400 ms -- that lies after the moment the run starts, plus a
  // quarter of the wallow period. Three things follow. (a) The base is always after the clock the mount's own
  // frames used, so a flight's age is never negative -- a negative age is a negative rise, which drives the body
  // through the floor it is measured against. (b) On a common multiple both sines read 0, so the phase every run
  // samples is written in this file and not an accident of when the suite ran: two runs handed the same fixture
  // start at the same phase, which is what makes them comparable -- a base aligned to one period alone left the
  // other one's phase drifting by 1700 ms between runs, and two runs of the same motion came out different.
  // (c) The quarter-period offset puts the wallow at its maximum and the bob near its peak at frame 0, so the
  // frames a run gets to read are the part of both cycles where the animal is deepest in the water and most
  // tilted, and it then walks down through the trough. Without the offset a run starts level and shallow and says
  // nothing about either motion.
  const q752Gcd752 = function (a752, b752) {
    a752 = Math.abs(a752); b752 = Math.abs(b752);
    while (b752) { const t752 = a752 % b752; a752 = b752; b752 = t752; }
    return a752;
  };
  const q752ClockPeriod752 = (q752BobPeriodMs752 * q752PitchPeriodMs752)
    / q752Gcd752(q752BobPeriodMs752, q752PitchPeriodMs752);
  // Read loudly, because a clock that is not a number does not fail: it draws nothing and every reading comes
  // back empty, which looks like a mode that stopped drawing.
  if (!(q752BobPeriodMs752 > 0) || !(q752PitchPeriodMs752 > 0) || !(q752ClockPeriod752 > 0)) {
    throw new Error('T-752: the ruled swim periods could not be read out of the client, so the clock this section '
      + 'runs on has no value -- the constants are named SCOPE_SWIM_BOB_PERIOD752_MS and SCOPE_SWIM_PITCH_PERIOD752_MS');
  }
  const q752ClockFrames752 = function (br752, n752, perFrame752) {
    const real752 = Date.now;
    const base752 = Math.ceil((Date.now() + 3000) / q752ClockPeriod752) * q752ClockPeriod752
      + Math.round(q752PitchPeriodMs752 / 4);
    try {
      for (let k752 = 0; k752 < n752; k752++) {
        if (perFrame752) perFrame752(br752, k752);
        const q752 = br752.rafQueue; br752.rafQueue = [];
        Date.now = function () { return base752 + k752 * 16; };
        for (let i752 = 0; i752 < q752.length; i752++) q752[i752][1](k752 * 16);
      }
    } finally { Date.now = real752; }
  };
  // A frame is recognised by the ground it lays first (the same seam T-746 uses), and a segment that is only a
  // ground -- the draw entry's own clear, with nothing drawn into it -- is not a frame.
  const q752FramesAfter752 = function (br752, from752) {
    const all752 = br752.rectLog.slice(from752);
    const starts752 = [];
    all752.forEach(function (r752, i752) { if (r752[2] === 200 && r752[3] === 80) starts752.push(i752); });
    starts752.push(all752.length);
    const out752 = [];
    for (let i752 = 0; i752 + 1 < starts752.length; i752++) {
      const seg752 = all752.slice(starts752[i752], starts752[i752 + 1]);
      if (seg752.length > 1) out752.push(seg752);
    }
    return out752;
  };
  const q752Run752 = function (q752, n752, perFrame752) {
    const from752 = q752.br.rectLog.length;
    q752ClockFrames752(q752.br, n752, perFrame752);
    return q752FramesAfter752(q752.br, from752);
  };
  // The animal of the llama mode: every 2x2 rect on the visible canvas. The mark of the rolling modes: the cells
  // in the mark's own ink, plus the cells in the water's ink -- a rect of the rail colour that is 2 px tall is a
  // cell of the body, because a rail bar is 8 px tall at this fixture (see THE FIXTURE'S CONTROL above).
  const q752Animal752 = function (seg752) {
    return seg752.filter(function (r752) { return r752[2] === q752MkCell752 && r752[3] === q752MkCell752; });
  };
  const q752MarkCells752 = function (seg752) {
    const out752 = q746White(seg752);
    q746Rail(seg752).forEach(function (r752) { if (r752[3] === q752MkCell752) out752.push(r752); });
    return out752;
  };
  const q752RailBars752 = function (seg752) {
    return q746Rail(seg752).filter(function (r752) { return r752[3] > q752MkCell752; });
  };
  const q752Box752 = function (rs752) {
    if (!rs752.length) return null;
    const b752 = { x0: 1e9, y0: 1e9, x1: -1e9, y1: -1e9 };
    rs752.forEach(function (r752) {
      b752.x0 = Math.min(b752.x0, r752[0]); b752.y0 = Math.min(b752.y0, r752[1]);
      b752.x1 = Math.max(b752.x1, r752[0] + r752[2]); b752.y1 = Math.max(b752.y1, r752[1] + r752[3]);
    });
    b752.w = b752.x1 - b752.x0; b752.h = b752.y1 - b752.y0;
    return b752;
  };
  const q752Cells752 = function (rs752) {
    return rs752.reduce(function (a752, r752) { return a752 + r752[2] * r752[3]; }, 0) / (q752MkCell752 * q752MkCell752);
  };
  const q752AreaPx752 = function (rs752) { return rs752.reduce(function (a752, r752) { return a752 + r752[2] * r752[3]; }, 0); };
  const q752MeanX752 = function (rs752) {
    if (!rs752.length) return null;
    let n752 = 0, x752 = 0;
    rs752.forEach(function (r752) { n752 += r752[2] * r752[3]; x752 += (r752[0] + r752[2] / 2) * r752[2] * r752[3]; });
    return x752 / n752;
  };
  const q752Lowest752 = function (rs752) { return rs752.reduce(function (a752, r752) { return Math.max(a752, r752[1] + r752[3]); }, -1); };
  // T-754 (2026-11-07): the area-weighted mean y of the cells a frame paints. The ruled rise and the ruled bob are
  // heights of the body's CENTRE -- the arc and the bob are what lift it -- and which cell of an animal is its
  // lowest one is a property of the animal's shape, not of the lift. With the whale turned back to its original
  // facing, its lowest cell sits differently at a pitched angle than it did turned, so a lift measured from the
  // lowest cell reports the shape as much as it reports the flight. Both are kept here: the lowest cell is what
  // the water actually cuts, and the centre is what the ruling bounds.
  const q752MeanY752 = function (rs752) {
    if (!rs752.length) return null;
    let n752 = 0, y752 = 0;
    rs752.forEach(function (r752) { n752 += r752[2] * r752[3]; y752 += (r752[1] + r752[3] / 2) * r752[2] * r752[3]; });
    return y752 / n752;
  };
  const q752Inks752 = function (segs752) {
    const s752 = new Set();
    segs752.forEach(function (seg752) { seg752.forEach(function (r752) { s752.add(String(r752[5])); }); });
    return Array.from(s752);
  };
  // The two helpers that read the selects went with the selects (2026-11-07). What reads these two settings now is
  // the trio below -- q752BoxWord752 / q752PressBox752 / q752PressTo752 -- the same trio the waterfall's direction
  // box and the Knight Rider bar-count box are read with.
  const q752BoxWord752 = function (mt752, cls752) {
    const el752 = mt752.els(cls752)[0];
    return el752 ? String(mt752.ownText(el752)) : '';
  };
  const q752PressBox752 = async function (mt752, cls752) {
    const el752 = mt752.els(cls752)[0];
    if (!el752 || typeof el752.props.onClick !== 'function') return false;
    el752.props.onClick(); mt752.commit(); await flush();
    return true;
  };
  // Walk a cycle box to the word a case wants and report how many presses it took and every word it passed
  // through. A control that cannot be walked to a value is not a control the drawing can be measured under.
  const q752PressTo752 = async function (mt752, cls752, word752, cap752) {
    const words752 = [q752BoxWord752(mt752, cls752)];
    for (let n752 = 0; n752 < (cap752 || 6); n752++) {
      if (words752[words752.length - 1] === word752) return { ok: true, presses: n752, words: words752 };
      if (!await q752PressBox752(mt752, cls752)) return { ok: false, presses: n752, words: words752 };
      words752.push(q752BoxWord752(mt752, cls752));
    }
    return { ok: words752[words752.length - 1] === word752, presses: words752.length - 1, words: words752 };
  };
  // The Visualizer table, walked in document order -- the same proof T-541 uses for the waterfall row. A control
  // that carries the right class and sits in the wrong place is still in the wrong place, and this card's whole
  // second half is about WHERE the operator looked for these two settings.
  const q752Table752 = function (mt752) {
    const node752 = mt752.created().filter(function (e752) {
      return String((e752.props || {}).className || '').indexOf('audio-play-scope-levels346') >= 0;
    })[0] || null;
    const order752 = [];
    (function walk752(n752) {
      if (!n752) return;
      if (Array.isArray(n752)) { n752.forEach(walk752); return; }
      if (typeof n752 === 'string' || typeof n752 === 'number' || !n752.props) return;
      order752.push(n752);
      walk752(n752.props.children);
    })(node752 ? node752.props.children : null);
    return { node: node752, order: order752 };
  };
  const q752ClsIn752 = function (n752, cls752) {
    return String(((n752 || {}).props || {}).className || '').split(/\s+/).indexOf(cls752) >= 0;
  };
  const q752At752 = function (tbl752, cls752) {
    return tbl752.order.findIndex(function (e752) { return q752ClsIn752(e752, cls752); });
  };
  const q752Count752 = function (tbl752, cls752) {
    return tbl752.order.filter(function (e752) { return q752ClsIn752(e752, cls752); }).length;
  };
  const q752Distinct752 = function (xs752) { const s752 = new Set(); xs752.forEach(function (x752) { s752.add(x752); }); return Array.from(s752); };
  // One frame of a mark mode, read as three separately measurable things: the cells painted in the mark's own ink,
  // the cells painted in the water's ink, and the rail bars themselves.
  const q752MarkOf752 = function (seg752) {
    const w752 = q746White(seg752);
    const sub752 = q746Rail(seg752).filter(function (r752) { return r752[3] === q752MkCell752; });
    const bars752 = q752RailBars752(seg752);
    const all752 = w752.concat(sub752);
    return { white: q752Cells752(w752), subCells: q752Cells752(sub752), barArea: q752AreaPx752(bars752),
             // The key is the geometry only. A rect record also carries the context offset, the fill colour and a
             // draw-order counter (the shim numbers every fillRect so a pin can ask which face was drawn first),
             // and a counter is not the rail: keyed with it, two runs of the same rail never match.
             barKeys: bars752.map(function (r752) { return [r752[0], r752[1], r752[2], r752[3]].join(','); }).join(' '),
             barHeights: q752Distinct752(bars752.map(function (r752) { return r752[3]; })),
             whiteRects: w752, subRects: sub752,
             box: q752Box752(all752), cells: q752Cells752(all752), low: q752Lowest752(all752),
             top: all752.length ? Math.min.apply(null, all752.map(function (r752) { return r752[1]; })) : 999,
             mx: q752MeanX752(all752), my: q752MeanY752(all752) };
  };
  // A frame whose whole body is inside the inner box. The painter drops a run that would cross an inner edge and a
  // row that would fall outside it, so a clipped frame never shows a box that crosses the edge -- it shows a box
  // that ends AT it. One cell of margin is not enough to tell the two apart; two cells is, because a body that
  // overhangs an edge always leaves a drawn run within one cell of that edge. The top edge gets one cell: a body
  // clipped there has its first drawn row at the inner top itself.
  const q752Inside752 = function (box752) {
    return !!box752 && box752.x0 >= q752Inset752 + 2 * q752MkCell752
      && box752.x1 <= q752W752 - q752Inset752 - 2 * q752MkCell752
      && box752.y0 >= q752InnerTop752 + q752MkCell752 && box752.y1 <= q752Ground752;
  };
  const q752InsideIdx752 = function (per752) {
    const out752 = [];
    per752.forEach(function (p752, i752) { if (q752Inside752(p752.box)) out752.push(i752); });
    return out752;
  };
  // Travel, said as a rate over the frames where the body is fully inside. A mark wraps back after one full trip
  // across the box, and a body clipped at an edge is not a body that moved, so the reading is taken across one
  // unbroken run of in-box frames -- the longest one the run offers -- and never across a wrap.
  // T-754 (2026-11-07): the reading is now signed by the direction the mode is meant to travel, because the operator
  // asked for the whale to face and move the other way -- "we can use the original left facing, but would have to
  // change the direction on the canvas from right to left". `dir` is -1 for a mark that walks left and +1 for one
  // that walks right; a step against that direction is the backwards count, and the claim being tested is the same
  // claim it always was -- a steady rate with no step against it. The direction is written at each call site as a
  // number the test expects, not read out of the client: the drawing is what decides whether the claim holds.
  const q752Travel752 = function (per752, idx752, dir754) {
    const sgn754 = (dir754 === -1) ? -1 : 1;
    const groups752 = [];
    let cur752 = [];
    idx752.forEach(function (i752) {
      if (cur752.length && i752 !== cur752[cur752.length - 1] + 1) { groups752.push(cur752); cur752 = []; }
      cur752.push(i752);
    });
    if (cur752.length) groups752.push(cur752);
    let best752 = { frames: 0, net: 0, rate: 0, backwards: 0, span: [] };
    groups752.forEach(function (g752) {
      if (g752.length < 2) return;
      let net752 = 0, back752 = 0;
      for (let i752 = 1; i752 < g752.length; i752++) {
        const a752 = per752[g752[i752 - 1]].mx, b752 = per752[g752[i752]].mx;
        if (a752 == null || b752 == null) continue;
        const d752 = (b752 - a752) * sgn754;
        if (d752 < -0.001) back752++;
        net752 += d752;
      }
      if (g752.length > best752.frames) {
        best752 = { frames: g752.length, net: net752, rate: net752 / (g752.length - 1), backwards: back752,
                    span: [g752[0], g752[g752.length - 1]] };
      }
    });
    best752.inBoxFrames = idx752.length;
    return best752;
  };
  // One frame as one comparable string: how many cells it paints, where its box is, and where its lowest cell ends.
  // Two runs of the same mode with the same fixture are the same drawing if and only if these match in order.
  const q752SigOf752 = function (seg752) {
    const p752 = q752MarkOf752(seg752);
    const b752 = p752.box;
    return [p752.cells, p752.white, p752.subCells, b752 ? b752.x0 : -1, b752 ? b752.y0 : -1,
            b752 ? b752.w : -1, b752 ? b752.h : -1, p752.low, p752.barArea].join(':');
  };

  // 1 and 2. PROVENANCE. Both new silhouettes are a trace, and the trace is a reproducible measurement: the same
  // row count, the same columns per row, the same 2 px cell and the same lit-cell count the script wrote out.
  {
    const qPw752 = q752Mask752('SCOPE_DANCE_WHALE_MASK752');
    const qMk754 = q752Mask752('SCOPE_WHALE_MASK749');
    const qPwCols752 = q752Num752(/SCOPE_DANCE_WHALE_COLS752 = (\d+);/);
    const qPwRows752 = q752Num752(/SCOPE_DANCE_WHALE_ROWS752 = (\d+);/);
    const qPwCell752 = q752Num752(/SCOPE_DANCE_WHALE_CELL752 = (\d+);/);
    const qPwLit752 = q752Num752(/SCOPE_DANCE_WHALE_LIT752 = (\d+);/);
    // (T-754 contract change, 2026-11-07.) This pin read 34 rows of 46 columns, 784 lit cells, 92 x 68 px, and it
    // was right about what the code carried at the time. The operator's look at the result: "the whale in the dancing
    // llama visualizer needs a fix, it's too big, it's upside down, and should be mirrored horizontally"; asked which
    // size with every candidate drawn out, the answer was "60 x 44 px -- same width as the llama". So the dancing
    // whale IS the mark: the same grid, the same cell, the same trace, the same 334 lit cells, carried under two
    // names. The claim did not get softer -- it got harder, because now the two names have to be proved to be the
    // same shape and not two shapes that drifted. The grid is read from the mark's own constant and compared row for
    // row against what the dancing name resolves to.
    check('T-752 provenance, re-cut by T-754: the dancing whale is the mark -- the same 22 rows of 30 columns at the '
        + 'same 2 px cell, the same 334 lit cells, the same 60 x 44 px -- read as the grid the mark carries and '
        + 'compared row for row with what the dancing name resolves to, and the two sets of constants agree. Drawn at '
        + 'the llama\u2019s own width because the operator asked for it not to be bigger than the animal it replaces',
      qPw752.rows === 22 && qPw752.lit === 334 && qPwCols752 === 30 && qPwRows752 === 22 && qPwCell752 === 2
        && qPwLit752 === 334 && qPw752.lit === qPwLit752 && qPw752.rows === qPwRows752
        && qMk754.rows === 22 && qMk754.lit === 334 && qPw752.rows === qMk754.rows && qPw752.lit === qMk754.lit
        && qPw752.readFrom === 'SCOPE_WHALE_MASK749'
        && qPwCols752 === q752Num752(/SCOPE_WHALE_COLS749 = (\d+);/)
        && qPwRows752 === q752Num752(/SCOPE_WHALE_ROWS749 = (\d+);/)
        && qPwCell752 === q752Num752(/SCOPE_WHALE_CELL749 = (\d+);/)
        && qPwLit752 === q752Num752(/SCOPE_WHALE_LIT749 = (\d+);/),
      { mask_rows: qPw752.rows, mask_lit: qPw752.lit, read_from: qPw752.readFrom,
        mark_rows: qMk754.rows, mark_lit: qMk754.lit,
        cols_const: qPwCols752, rows_const: qPwRows752,
        cell_const: qPwCell752, lit_const: qPwLit752, drawn_px: [qPwCols752 * qPwCell752, qPwRows752 * qPwCell752] });
    const qPq752 = q752Mask752('SCOPE_DANCE_QWEN_MASK752');
    const qPqCols752 = q752Num752(/SCOPE_DANCE_QWEN_COLS752 = (\d+);/);
    const qPqRows752 = q752Num752(/SCOPE_DANCE_QWEN_ROWS752 = (\d+);/);
    const qPqCell752 = q752Num752(/SCOPE_DANCE_QWEN_CELL752 = (\d+);/);
    const qPqLit752 = q752Num752(/SCOPE_DANCE_QWEN_LIT752 = (\d+);/);
    check('T-752 provenance: the dancing qwen is the traced mark as 34 rows of 33 columns at the same 2 px cell, and '
        + 'the 520 lit cells its trace counted are the constant the code carries -- 66 x 68 px, the same height again',
      qPq752.rows === 34 && qPq752.lit === 520 && qPqCols752 === 33 && qPqRows752 === 34 && qPqCell752 === 2
        && qPqLit752 === 520 && qPq752.lit === qPqLit752 && qPq752.rows === qPqRows752,
      { mask_rows: qPq752.rows, mask_lit: qPq752.lit, cols_const: qPqCols752, rows_const: qPqRows752,
        cell_const: qPqCell752, lit_const: qPqLit752, drawn_px: [qPqCols752 * qPqCell752, qPqRows752 * qPqCell752] });
  }

  // 3. THE TWO CONTROLS, WHERE THE OPERATOR LOOKED FOR THEM, AND WHAT THEY REFUSE.
  // (T-752 contract change, 2026-11-07.) These two settings were first built as two selects under the Header mark
  // picker. The operator's word: "I am still missing the mode selector in the visualizer settings matrix to show
  // different dancing effect icons and the switch for swimming whale." They are now cycle boxes on their own mode's
  // row in the Visualizer table, which is where every other per-mode control sits. Nothing here got softer: the
  // claims are the same ones -- the same words offered, the same defaults, the same storage keys, a word outside the
  // list changes nothing -- and two were ADDED, because a box has to be proved to be walkable and to be in the right
  // row, which a select did not need. The refusal of a word the control cannot be asked for is now measured where
  // such a word can actually arrive: in storage, read at the mount.
  {
    const qC752 = await q752Mount752({}, 'llama');
    const qT752 = q752Table752(qC752.m);
    const nameD752 = q752At752(qT752, 'audio-play-scope-mode531-llama');
    const boxD752 = q752At752(qT752, 'audio-play-dance-icon752');
    const nameM752 = q752At752(qT752, 'audio-play-scope-mode531-whale');
    const boxM752 = q752At752(qT752, 'audio-play-whale-motion752');
    const qElD752 = qC752.m.els('audio-play-dance-icon752');
    const qElM752 = qC752.m.els('audio-play-whale-motion752');
    const defD752 = q752BoxWord752(qC752.m, 'audio-play-dance-icon752');
    const defM752 = q752BoxWord752(qC752.m, 'audio-play-whale-motion752');
    const storeAtMount752 = { icon: qC752.br.store['deepamp:scope.dance.icon752'], motion: qC752.br.store['deepamp:scope.whale.motion752'] };
    // The cycles, walked end to end and one press past the end, which is where a wrap shows itself.
    const walkD752 = [];
    for (let i752 = 0; i752 < 3; i752++) { walkD752.push(q752BoxWord752(qC752.m, 'audio-play-dance-icon752')); await q752PressBox752(qC752.m, 'audio-play-dance-icon752'); }
    walkD752.push(q752BoxWord752(qC752.m, 'audio-play-dance-icon752'));
    const walkM752 = [];
    for (let i752 = 0; i752 < 3; i752++) { walkM752.push(q752BoxWord752(qC752.m, 'audio-play-whale-motion752')); await q752PressBox752(qC752.m, 'audio-play-whale-motion752'); }
    walkM752.push(q752BoxWord752(qC752.m, 'audio-play-whale-motion752'));
    const storeAfterWalk752 = { icon: qC752.br.store['deepamp:scope.dance.icon752'], motion: qC752.br.store['deepamp:scope.whale.motion752'] };
    const qCsD752 = q752SrcList752('SCOPE_DANCE_ICON_OPTS752');
    const qCsM752 = q752SrcList752('SCOPE_WHALE_MOTION_OPTS752');
    // And the picture is the default animal's, because the walk came back to the default it started on.
    qC752.br.hotBins = [];
    const qCfr752 = q752Run752(qC752, 2);
    const qCan752 = qCfr752.length ? q752Animal752(qCfr752[qCfr752.length - 1]) : [];
    const qCbox752 = q752Box752(qCan752);
    teardown();
    check('T-752, controls re-placed on the operator\'s word ("I am still missing the mode selector in the visualizer '
        + 'settings matrix to show different dancing effect icons and the switch for swimming whale"): both settings '
        + 'are INSIDE the Visualizer table -- the animal box on the llama row, the motion box on the whale row, each '
        + 'met in the table subtree after that row\'s own name and nowhere else in Settings -- each is one pressable '
        + 'box printing the word in use, each defaults to what its mode did before this card (llama, rolling), each '
        + 'walks its option list and wraps back to the start, and the words they walk are exactly the words their '
        + 'option lists carry. Nothing is stored before anyone presses',
      !!qT752.node && nameD752 >= 0 && boxD752 >= 0 && nameM752 >= 0 && boxM752 >= 0
        && nameD752 < boxD752 && nameM752 < boxM752
        && qElD752.length === 1 && qElM752.length === 1
        && q752Count752(qT752, 'audio-play-dance-icon752') === 1 && q752Count752(qT752, 'audio-play-whale-motion752') === 1
        && qElD752[0].type === 'button' && typeof qElD752[0].props.onClick === 'function'
        && qElM752[0].type === 'button' && typeof qElM752[0].props.onClick === 'function'
        && defD752 === 'llama' && defM752 === 'rolling'
        && walkD752.join(',') === 'llama,qwen,whale,llama' && walkM752.join(',') === 'rolling,swimming,breaching,rolling'
        && qCsD752 && qCsD752.join(',') === 'llama,qwen,whale'
        && qCsM752 && qCsM752.join(',') === 'rolling,swimming,breaching'
        && /var LS_SCOPE_DANCE_ICON752 = "deepamp:scope\.dance\.icon752";/.test(src)
        && /var LS_SCOPE_WHALE_MOTION752 = "deepamp:scope\.whale\.motion752";/.test(src)
        && storeAtMount752.icon === undefined && storeAtMount752.motion === undefined
        && storeAfterWalk752.icon === 'llama' && storeAfterWalk752.motion === 'rolling'
        && !!qCbox752 && qCbox752.w === 60 && qCbox752.h === 68 && q752Cells752(qCan752) === 419,
      { table_rows_walked: qT752.order.length, animal_name_at: nameD752, animal_box_at: boxD752,
        motion_name_at: nameM752, motion_box_at: boxM752, animal_cycle: walkD752, motion_cycle: walkM752,
        src_icon: qCsD752, src_motion: qCsM752, store_at_mount: storeAtMount752, store_after_walk: storeAfterWalk752,
        still_draws: qCbox752 ? [qCbox752.w, qCbox752.h] : null, cells: q752Cells752(qCan752) });
    console.log('  MEASURE T-752 the two controls as the panel builds them: the animal box sits at position '
      + boxD752 + ' of the Visualizer table subtree, right after the llama row\'s own name at ' + nameD752
      + ', and the motion box at ' + boxM752 + ' after the whale row\'s name at ' + nameM752
      + '; the cycles walk ' + walkD752.join(' -> ') + ' and ' + walkM752.join(' -> ')
      + ', and after the walk the panel still draws the 419-cell llama at '
      + (qCbox752 ? qCbox752.w : 0) + ' x ' + (qCbox752 ? qCbox752.h : 0) + ' px');
  }

  // 3b. A WORD THE CONTROL CANNOT BE ASKED FOR. A cycle box has no way to be handed "hippo", so the refusal is
  // measured where such a word really arrives: already in storage, read at the mount. The setter's own gate is
  // pinned in the source, because it is the half that keeps a press from ever writing a word the list does not hold.
  {
    const qRw752 = await q752Mount752({ 'deepamp:scope.dance.icon752': 'hippo', 'deepamp:scope.whale.motion752': 'flying' }, 'llama');
    const shownRwD752 = q752BoxWord752(qRw752.m, 'audio-play-dance-icon752');
    const shownRwM752 = q752BoxWord752(qRw752.m, 'audio-play-whale-motion752');
    const storedRw752 = { icon: qRw752.br.store['deepamp:scope.dance.icon752'], motion: qRw752.br.store['deepamp:scope.whale.motion752'] };
    qRw752.br.hotBins = [];
    const qRwfr752 = q752Run752(qRw752, 2);
    const qRwan752 = qRwfr752.length ? q752Animal752(qRwfr752[qRwfr752.length - 1]) : [];
    const qRwbox752 = q752Box752(qRwan752);
    teardown();
    check('T-752 (contract change 2026-11-07, from the operator\'s word quoted above): a word outside the option '
        + 'list is refused outright -- a page that already stores "hippo" and "flying" shows the defaults on both '
        + 'boxes and draws the animal the default names, the 419-cell llama, not a half-restored setting and not '
        + 'something invented; the stored word is left as it was rather than rewritten by an act nobody made; and '
        + 'both setters still return before they store anything they do not offer',
      shownRwD752 === 'llama' && shownRwM752 === 'rolling'
        && storedRw752.icon === 'hippo' && storedRw752.motion === 'flying'
        && !!qRwbox752 && qRwbox752.w === 60 && qRwbox752.h === 68 && q752Cells752(qRwan752) === 419
        && /function setDanceIcon752AndSave752\(v752\) \{\s*\n\s*if \(SCOPE_DANCE_ICON_OPTS752\.indexOf\(v752\) < 0\) return;/.test(src)
        && /function setWhaleMotion752AndSave752\(v752\) \{\s*\n\s*if \(SCOPE_WHALE_MOTION_OPTS752\.indexOf\(v752\) < 0\) return;/.test(src),
      { shown: { icon: shownRwD752, motion: shownRwM752 }, left_in_store: storedRw752,
        draws: qRwbox752 ? [qRwbox752.w, qRwbox752.h, q752Cells752(qRwan752)] : null });
  }

  // 4. THE DEFAULTS REPRODUCE THE PICTURE FROM BEFORE THIS CARD. First the dancing mode, untouched: the same
  // silhouette, the same extent, the same 419 cells, standing on the same floor line.
  {
    const qD752 = await q752Mount752({}, 'llama');
    qD752.br.hotBins = [];                       // silence: no bass hop, no step lean, so the pose is the level pose
    const qDfr752 = q752Run752(qD752, 3);
    const qDper752 = qDfr752.map(function (seg752) {
      const rs752 = q752Animal752(seg752);
      return { cells: q752Cells752(rs752), box: q752Box752(rs752) };
    });
    const qDs752 = qDper752.filter(function (p752) { return !!p752.box; });
    const qDbox752 = qDs752.length ? qDs752[0].box : null;
    check('T-752 default, dancing mode: with the new setting never touched the mode still draws the llama it drew '
        + 'before -- 419 cells in a 60 x 68 px silhouette, centred on the wall and standing on the same floor line '
        + 'the mode has always put its animal on. Nothing about the mode\u2019s own drawing moved',
      qDs752.length >= 3 && qDs752.every(function (p752) {
        return p752.cells === 419 && p752.box.w === 60 && p752.box.h === 68
          && p752.box.y1 === q752Ground752 && p752.box.x0 === 70;
      }),
      { frames: qDper752.length, cells: qDs752.map(function (p752) { return p752.cells; }),
        box: qDbox752 ? [qDbox752.x0, qDbox752.y0, qDbox752.w, qDbox752.h] : null,
        ground_line: q752Ground752 });
    console.log('  MEASURE T-752 the dancing default: 419 cells drawn as a ' + (qDbox752 ? qDbox752.w : 0) + ' x '
      + (qDbox752 ? qDbox752.h : 0) + ' px silhouette at x ' + (qDbox752 ? qDbox752.x0 : 0)
      + ', its lowest cell bottom at y ' + (qDbox752 ? qDbox752.y1 : 0) + ' on the inner bottom edge y '
      + q752Ground752 + ', unchanged across ' + qDs752.length + ' frames');
    teardown();
  }

  // 5. THE DEFAULTS REPRODUCE THE PICTURE FROM BEFORE THIS CARD. Then the rolling mark, untouched: the whole mark
  // painted, several distinct heights as it turns, the lowest cell on the ground line, the travel unchanged, and no
  // part of the body in the water's colour. The reading is the one T-746 item 7 makes for the other mark, taken of
  // this one. What it asks that T-746 did not: "the whole mark is painted" can only be asked at the level pose, so
  // the fullest frame of the run is measured and named, and the turned frames are reported as what they are -- a
  // body sampled by a rotated grid paints fewer cells, which is a property of nearest-neighbour sampling and not of
  // this card. Measured here: the whale mark paints 334 cells level and about three quarters of them at 45 degrees,
  // where the qwen mark of T-746 kept 324 of 333. Its thin fluke and fin are what the rotated grid loses.
  {
    const qE752 = await q752Mount752({}, 'whale');
    const qEfr752 = q752Run752(qE752, 40, q752Loud752);
    const qEper752 = qEfr752.map(q752MarkOf752);
    const qEin752 = q752InsideIdx752(qEper752);
    const qEhs752 = q752Distinct752(qEper752.map(function (p752) { return p752.box ? p752.box.h : -1; }));
    const qEbestCells752 = qEper752.reduce(function (a752, p752) { return Math.max(a752, p752.cells); }, -1);
    const qEworstIn752 = qEin752.reduce(function (a752, i752) { return Math.min(a752, qEper752[i752].cells); }, 9999);
    const qEbestLow752 = qEper752.reduce(function (a752, p752) { return Math.max(a752, p752.low); }, -1);
    const qEtr752 = q752Travel752(qEper752, qEin752, -1);   // T-754: this mark walks right to left, on the operator's word
    const qEbarH752 = q752Distinct752(qEper752.reduce(function (a752, p752) { return a752.concat(p752.barHeights); }, []));
    const qEsub752 = qEper752.reduce(function (a752, p752) { return a752 + p752.subCells; }, 0);
    const qElevel752 = [];
    // The level poses that are actually painted: the frames where the drawn height is the mark's own level height
    // AND the whole mark is on the canvas. A body clipped at the right edge can still be level, and its cell count
    // then says so -- which is why the pose is not selected by geometry alone.
    qEper752.forEach(function (p752, i752) {
      if (p752.box && Math.abs(p752.box.h - q752MkLevelH752) <= 2 && p752.cells >= q752MkLit752 - 8) qElevel752.push(i752);
    });
    const qElevelCells752 = qElevel752.map(function (i752) { return qEper752[i752].cells; });
    const qElevelLow752 = qElevel752.map(function (i752) { return qEper752[i752].low; });
    // (T-754 contract change, 2026-11-07.) This pin said the mark travels RIGHT. The operator's word, verbatim:
    // "we can use the original left facing, but would have to change the direction on the canvas from right to left",
    // and the mark is the original facing now. Nothing else in the pin moved: the same level pose, the same distinct
    // heights as it turns, the same ground line, the same rate, the same "no step against the direction", the same
    // no-water-ink rule. The direction is the one thing the card was about.
    check('T-752 default, re-cut by T-754: with the motion setting never touched the mark still ROLLS -- the whole '
        + 'mark is '
        + 'painted at its level pose, it takes ' + qEhs752.length + ' distinct drawn heights as it turns, its lowest '
        + 'cell reaches the ground line it rides, it travels LEFT at a steady ' + qEtr752.rate.toFixed(2)
        + ' px per frame with no step against that direction, and it paints no cell of its own body in the water '
        + 'colour, because in this motion there is no water',
      qEfr752.length >= 30 && qEin752.length >= 15
        && qEbestCells752 >= q752MkLit752 - 8
        && qEhs752.length >= 5 && (Math.max.apply(null, qEhs752) - Math.min.apply(null, qEhs752)) >= 4
        && qEbestLow752 >= 72 && qEbestLow752 <= q752Ground752
        && qEtr752.net >= 25 && qEtr752.backwards === 0
        && qEsub752 === 0
        && qEbarH752.length === 1 && qEbarH752[0] > q752MkCell752
        && qElevel752.length >= 2 && qElevelCells752.every(function (v752) { return v752 >= q752MkLit752 - 8; }),
      { frames: qEfr752.length, inside_frames: qEin752.length, best_cells_frame: qEbestCells752,
        worst_cells_inside: qEworstIn752, lit: q752MkLit752, distinct_heights: qEhs752,
        level_pose_frames: qElevel752, level_pose_cells: qElevelCells752, level_pose_lowest: qElevelLow752,
        lowest_cell_reached: qEbestLow752, ground_line: q752Ground752, travelled_px: Math.round(qEtr752.net),
        px_per_frame: Number(qEtr752.rate.toFixed(3)), backwards_steps: qEtr752.backwards,
        rail_bar_heights: qEbarH752, ruled_rail_height_px: q752RailH752, body_cells_in_water_ink: qEsub752 });
    console.log('  MEASURE T-752 the rolling default on the whale mark, ' + qEfr752.length + ' frames on the loud '
      + 'fixture: ' + qEin752.length + ' frames with the whole body inside the box; drawn cells best '
      + qEbestCells752 + ' of ' + q752MkLit752 + ' (at the level pose, frames ' + qElevel752.join(' ')
      + ' paint ' + qElevelCells752.join(' ') + ') and worst ' + qEworstIn752 + ' in a turned frame; drawn heights '
      + qEhs752.join(' ') + ' px against the level ' + q752MkLevelH752 + ' px; lowest cell bottom reaching y '
      + qEbestLow752 + ' against the ground line y ' + q752Ground752 + ' -- a body a fraction of a degree off level '
      + 'has its extreme corner clipped by the mode\'s own row guard, which is why the closest approach here is '
      + (q752Ground752 - qEbestLow752) + ' px short of the line and not on it; travel ' + Math.round(qEtr752.net)
      + ' px over ' + qEtr752.frames + ' in-box frames = ' + qEtr752.rate.toFixed(2) + ' px per frame, '
      + qEtr752.backwards + ' backwards steps; rail bars ' + qEbarH752.join(' ') + ' px tall -- the mock\'s analyser '
      + 'window tops out at -30 dB, so its loudest byte is ' + ((q752RailH752 * qEbarH752[0] / q752RailH752)).toFixed(0)
      + ' px of the ruled ' + q752RailH752 + ' px ladder, and the whole card reads the same window; cells of the '
      + 'body painted in the rail colour: ' + qEsub752);
    teardown();
  }

  // 6 and 7. THE DANCING ICON SETTING CHANGES WHICH SILHOUETTE STANDS THERE, and only that: same mode, same wall,
  // same floor, same cell size, same centring arithmetic, same floor line -- a different animal.
  // TWO DEFECTS THIS MEASUREMENT FOUND, and both are now fixed in the client, and both are named here because the
  // test is what found them. (a) Read through the painter as this card first wrote it, the whale icon painted 824
  // cells and the qwen icon 516, against the 784 and 520 the traces counted. The masks were right; the bit test was
  // not. JS bitwise operators work on 32-bit integers, so `1 << 32` is `1` again and a mask wider than 32 columns
  // reads bit 33 as bit 1 and bit 45 as bit 13 -- the llama's 30-column mask never reached that line and these two
  // crossed it. scratch/mask_extent_probe_752.cjs measures both forms over the masks as the client carries them:
  // 784 and 520 by division, 824 and 516 by the shift. The painter reads a row's bits by division now. (b) The
  // qwen trace carries a margin: its grid is 34 rows by 33 columns and only 33 rows and 32 columns of that hold a
  // lit cell, because the source shape has margins. Placed by the bottom row of its grid the animal stood two px
  // above the floor line the mode puts every animal on, so the mode now places an animal by its feet -- the lowest
  // row of its own mask that carries a lit cell, read off the mask. For a shape that fills its grid, the llama and
  // the whale icon, that term is zero and the drawing is the one this mode has always done.
  {
    const qF752 = await q752Mount752({ 'deepamp:scope.dance.icon752': 'whale' }, 'llama');
    const qFfr752 = q752Run752(qF752, 3, q752Quiet752);
    const qFper752 = qFfr752.map(function (seg752) {
      const r752 = q752Animal752(seg752);
      return { cells: q752Cells752(r752), box: q752Box752(r752) };
    });
    teardown();
    const qG752 = await q752Mount752({ 'deepamp:scope.dance.icon752': 'qwen' }, 'llama');
    const qGfr752 = q752Run752(qG752, 3, q752Quiet752);
    const qGper752 = qGfr752.map(function (seg752) {
      const r752 = q752Animal752(seg752);
      return { cells: q752Cells752(r752), box: q752Box752(r752) };
    });
    teardown();
    const qFmask752 = q752Mask752('SCOPE_DANCE_WHALE_MASK752');
    const qGmask752 = q752Mask752('SCOPE_DANCE_QWEN_MASK752');
    const qFs752 = qFper752.filter(function (p752) { return !!p752.box; });
    const qGs752 = qGper752.filter(function (p752) { return !!p752.box; });
    const qFbox752 = qFs752.length ? qFs752[0].box : null;
    const qGbox752 = qGs752.length ? qGs752[0].box : null;
    // What the traced masks say the drawn extent must be: the grid they carry, and the lit extent inside it.
    const qFwantW752 = qFmask752.colsLit * q752Num752(/SCOPE_DANCE_WHALE_CELL752 = (\d+);/);
    const qFwantH752 = qFmask752.rowsLit * q752Num752(/SCOPE_DANCE_WHALE_CELL752 = (\d+);/);
    const qGwantW752 = qGmask752.colsLit * q752Num752(/SCOPE_DANCE_QWEN_CELL752 = (\d+);/);
    const qGwantH752 = qGmask752.rowsLit * q752Num752(/SCOPE_DANCE_QWEN_CELL752 = (\d+);/);
    const qGcentreOff752 = qGbox752 ? Math.abs((qGbox752.x0 + qGbox752.x1) / 2 - q752W752 / 2) : 999;
    const qFcentreOff752 = qFbox752 ? Math.abs((qFbox752.x0 + qFbox752.x1) / 2 - q752W752 / 2) : 999;
    // (T-754 contract change, 2026-11-07.) The whale half of this pin read 784 cells drawn 92 x 68 px. The operator
    // asked for the animal to be smaller and got the size they chose, so the numbers below are counted out of the
    // grid the code carries -- the mark's grid -- and the drawn box is compared against the lit extent inside it,
    // exactly as the qwen half has always been measured. The claim is unchanged in kind and stronger in fact: the
    // drawn cell count still has to EQUAL the traced lit count, cell for cell, standing on the same floor line,
    // centred by the mode's own arithmetic, and it still fails if the bit test is a shift instead of a division.
    check('T-752, re-cut by T-754: the dancing-icon setting changes the silhouette and nothing else about the mode -- '
        + 'the whale option '
        + 'paints its traced ' + qFmask752.lit + ' cells as a ' + qFwantW752 + ' x ' + qFwantH752 + ' px animal and the qwen option '
        + 'paints its traced 520 cells as a ' + qGwantW752 + ' x ' + qGwantH752 + ' px one, both at the llama\'s own '
        + '2 px cell, both standing on the same floor line the llama stands on, both centred by the mode\'s own '
        + 'arithmetic, and the drawn cell count equals each traced lit count exactly -- which it does not if the '
        + 'cell test is a shift: the same masks read through `1 << n` paint the wrong cells',
      qFs752.length >= 3 && qGs752.length >= 3
        && qFs752.every(function (p752) {
          return p752.cells === qFmask752.lit && p752.box.w === qFwantW752 && p752.box.h === qFwantH752
            && p752.box.y1 === q752Ground752; })
        && qGs752.every(function (p752) {
          return p752.cells === qGmask752.lit && p752.box.w === qGwantW752 && p752.box.h === qGwantH752
            && p752.box.y1 === q752Ground752; })
        && qFcentreOff752 <= 1 && qGcentreOff752 <= 1
        && qFmask752.lit === 334 && qGmask752.lit === 520
        && qFwantW752 <= 60 && qFwantH752 <= 68,
      { whale: qFbox752 ? { at: [qFbox752.x0, qFbox752.y0], size: [qFbox752.w, qFbox752.h],
            centre_offset_px: Number(qFcentreOff752.toFixed(2)), cells: qFs752.map(function (p752) { return p752.cells; }) } : null,
        whale_grid: { rows: qFmask752.rows, cols_lit: qFmask752.colsLit, lit: qFmask752.lit },
        qwen: qGbox752 ? { at: [qGbox752.x0, qGbox752.y0], size: [qGbox752.w, qGbox752.h],
            centre_offset_px: Number(qGcentreOff752.toFixed(2)), cells: qGs752.map(function (p752) { return p752.cells; }) } : null,
        qwen_grid: { rows: qGmask752.rows, cols_grid: q752Num752(/SCOPE_DANCE_QWEN_COLS752 = (\d+);/),
            cols_lit: qGmask752.colsLit, rows_lit: qGmask752.rowsLit, lit: qGmask752.lit },
        ground_line: q752Ground752 });
    console.log('  MEASURE T-752 the two new silhouettes on the llama\'s floor: whale '
      + (qFbox752 ? qFbox752.w + ' x ' + qFbox752.h : 0) + ' px at x ' + (qFbox752 ? qFbox752.x0 : 0) + ' y '
      + (qFbox752 ? qFbox752.y0 : 0) + ' painting ' + (qFs752.length ? qFs752[0].cells : 0) + ' cells, its centre '
      + qFcentreOff752.toFixed(1) + ' px off the canvas centre; qwen ' + (qGbox752 ? qGbox752.w + ' x ' + qGbox752.h : 0)
      + ' px at x ' + (qGbox752 ? qGbox752.x0 : 0) + ' y ' + (qGbox752 ? qGbox752.y0 : 0) + ' painting '
      + (qGs752.length ? qGs752[0].cells : 0) + ' cells, its centre ' + qGcentreOff752.toFixed(1)
      + ' px off the canvas centre. Both bottom out at y ' + q752Ground752 + ' where the llama does. The qwen grid is '
      + qGmask752.rows + ' rows by ' + q752Num752(/SCOPE_DANCE_QWEN_COLS752 = (\d+);/)
      + ' columns and its lit extent inside that grid is ' + qGmask752.rowsLit + ' rows by ' + qGmask752.colsLit
      + ' columns -- ' + qGwantH752 + ' x ' + qGwantW752 + ' px drawn, which is why the feet, not the grid, set the baseline');
    teardown();
  }

  // 8 and 9. THE ARC AND ITS CAP. A flight is 900 ms and the frames are 16 ms apart, so the shape of one is read
  // off the client's own function, the way T-539 reads a bar curve: rise 0 at both ends, the peak at mid-flight,
  // symmetric about it, and the pitch walking from nose-up to nose-down through level. The cap is derived from the
  // flight geometry, so it is asked of two bodies and the numbers must differ.
  {
    const arc752 = q752Build752('scopeWhaleBreachArc752');
    const cap752 = q752Build752('scopeWhaleBreachCap752');
    const probeRise752 = 100, probePitch752 = 0.5, probeDur752 = 900;
    const arcAt752 = function (tau752) {
      if (!arc752) return null;
      return arc752(tau752 * probeDur752, probeDur752, probeRise752, probePitch752);
    };
    const arcSamples752 = [];
    for (let s752 = 0; s752 <= 16; s752++) { const a752 = arcAt752(s752 / 16); if (a752) arcSamples752.push({ tau: s752 / 16, r: a752.rise, p: a752.pitch, d: !!a752.done }); }
    const arcRise752 = arcSamples752.filter(function (s752) { return !s752.d; }).map(function (s752) { return s752.r; });
    const arcPeak752 = arcRise752.length ? Math.max.apply(null, arcRise752) : -1;
    const arcSym752 = (function () {
      for (let i752 = 0; i752 <= 16; i752++) {
        const a752 = arcAt752(i752 / 16), b752 = arcAt752(1 - i752 / 16);
        if (!a752 || !b752) return false;
        if (Math.abs(a752.rise - b752.rise) > 1e-9) return false;
        if (i752 > 0 && i752 < 16 && Math.abs(a752.pitch + b752.pitch) > 1e-9) return false;
      }
      return true;
    })();
    const arcMonotone752 = (function () {
      for (let i752 = 1; i752 < 16; i752++) { if (arcSamples752[i752].p > arcSamples752[i752 - 1].p + 1e-12) return false; }
      return true;
    })();
    const arcPeakAt752 = arcRise752.length ? arcSamples752[arcRise752.indexOf(arcPeak752)].tau : -1;
    check('T-752: the breach arc is pure and bounded -- rise 0 at the moment of launch and 0 at the landing (and the '
        + 'landing is the end of it, done), the peak at mid-flight at exactly the launch height, symmetric about that '
        + 'mid-point, never negative and never above the launch height, and the pitch walks from +PITCH through level '
        + 'at mid-flight to nose-down and never back up',
      !!arc752 && arcSamples752.length === 17
        && arcAt752(0).rise === 0 && arcAt752(0).pitch === probePitch752 && arcAt752(0).done === false
        && arcAt752(1).done === true && arcAt752(1).rise === 0 && arcAt752(1).pitch === 0
        && arcPeak752 === probeRise752 && arcPeakAt752 === 0.5
        && Math.abs(arcAt752(0.5).pitch) < 1e-12
        && arcSym752 && arcMonotone752
        && arcRise752.every(function (v752) { return v752 >= 0 && v752 <= probeRise752 + 1e-9; })
        && Math.abs(arcAt752(1 / 16).pitch - probePitch752 * (1 - 2 / 16)) < 1e-12
        && Math.abs(arcAt752(15 / 16).pitch - probePitch752 * (1 - 2 * 15 / 16)) < 1e-9,
      { samples: arcSamples752.map(function (s752) { return s752.tau + ':' + s752.r.toFixed(1) + '/' + s752.p.toFixed(3); }),
        peak_rise: arcPeak752, peak_at_tau: arcPeakAt752, symmetric: arcSym752, pitch_monotone: arcMonotone752 });

    // The cap: the highest launch this body can be given and still keep every point of its own arc inside the box.
    const capMark752 = cap752 ? cap752(q752Ground752, q752Inset752, q752MkHalfW752, q752MkHalfH752, q752BreachPitch752) : NaN;
    // (T-754 contract change, 2026-11-07.) The second body this was asked of was the dancing whale as this card
    // first traced it -- 92 x 68 px -- and the point of asking was that a standing animal of that size has no room to
    // breach in an 80 px strip. The operator's look at that animal: "it's too big". It is now the mark's own grid,
    // so asking the question of the standing body and of the mark asks the same body twice and answers the same
    // number twice, which is what one shape under two names means, and it is measured here rather than asserted.
    // The claim that the cap is derived and not a constant is kept by asking the question of the size that was
    // rejected: 92 x 68 px, half-extents 46 and 34. That answer is negative -- no launch fits the box at all -- so
    // the cap moves with the body it is asked about, and the size called too big is also the size this strip could
    // not have moved in. Two bodies, two different answers, one arithmetic.
    const capRejected754 = cap752 ? cap752(q752Ground752, q752Inset752, 92 / 2, 68 / 2, q752BreachPitch752) : NaN;
    const capStanding754 = cap752 ? cap752(q752Ground752, q752Inset752, q752MkHalfW752, q752MkHalfH752, q752BreachPitch752) : NaN;
    const flightInside752 = (function () {
      if (!cap752) return false;
      let worst752 = 1e9;
      for (let s752 = 0; s752 <= 16; s752++) {
        const tau752 = s752 / 16;
        const pitch752 = q752BreachPitch752 * (1 - 2 * tau752);
        const extY752 = q752MkHalfW752 * Math.abs(Math.sin(pitch752)) + q752MkHalfH752 * Math.abs(Math.cos(pitch752));
        const room752 = (q752Ground752 - 2 * extY752 - capMark752 * 4 * tau752 * (1 - tau752)) - q752InnerTop752;
        worst752 = Math.min(worst752, room752);
      }
      return worst752 >= -1e-9;
    })();
    check('T-752, re-cut by T-754: the breach cap is derived from the flight geometry and keeps every sampled point '
        + 'of the flight '
        + 'inside the inner box -- for the whale mark it answers ' + (isFinite(capMark752) ? capMark752.toFixed(2) : 'no number')
        + ' px, at or above the ruled maximum rise of ' + q752RiseMax752 + ' px, so the mark can always be given the '
        + 'full arc the ruling describes; asked of the 92 x 68 body the operator called too big, in the same 80 px box, '
        + 'it answers ' + (isFinite(capRejected754) ? capRejected754.toFixed(2) : 'no number')
        + ' px -- no launch fits at all -- which is the proof that the cap is a function of the body and not a number, '
        + 'and asked of the standing icon as it is drawn now it answers the mark\'s own number, because it is the mark',
      !!cap752 && isFinite(capMark752) && isFinite(capRejected754)
        && capMark752 >= q752RiseMax752 && flightInside752
        && capRejected754 < 0 && capRejected754 < capMark752
        && capStanding754 === capMark752,
      { cap_whale_mark: capMark752, cap_rejected_92x68: capRejected754, cap_standing_now: capStanding754,
        ruled_rise_max: q752RiseMax752,
        ruled_rise_min: q752RiseMin752, ruled_pitch: q752BreachPitch752, flight_inside_box: flightInside752 });
    console.log('  MEASURE T-752 the derived cap: whale mark (60 x 44 px, half-extents ' + q752MkHalfW752 + ' x '
      + q752MkHalfH752 + ') at the ruled pitch ' + q752BreachPitch752 + ' rad answers cap '
      + (isFinite(capMark752) ? capMark752.toFixed(2) : 'NaN') + ' px against the ruled band ' + q752RiseMin752
      + '..' + q752RiseMax752 + ' px, and every one of the 17 sampled flight points stays '
      + 'inside the box (inner top y ' + q752InnerTop752 + ', ground y ' + q752Ground752 + '); the same call on a '
      + '92 x 68 body answers ' + (isFinite(capRejected754) ? capRejected754.toFixed(2) : 'NaN')
      + ' px -- no room at all -- and the same call on the standing icon as the dancing mode draws it today answers '
      + (isFinite(capStanding754) ? capStanding754.toFixed(2) : 'NaN') + ' px, the mark\'s own number, because the two '
      + 'are one shape since the operator asked for the smaller one');
  }

  // 10, 11 and 12. SWIMMING, against ROLLING: one mount at a time, the same fixture handed to the same frame
  // numbers, the same clock rule. The only thing that differs between the two runs is the angle the body carries,
  // where the body sits vertically, and which of the mode's two inks the part below the surface is painted in.
  // The rail is the surface (the design decision this card wrote down: waterY is the top of the loudest bar this
  // frame measures, and the rail's own jagged per-column height is deliberately not matched), so the comparison is
  // made on the frames where the whole body is inside the box in both runs. The ink rule is checked run by run
  // against the surface read off the rail drawing, in both directions, because that is the contract; how deep a
  // given fixture happens to sit the body is reported as a measurement, and the pose-matched reading that was going
  // to carry the claim is reported too, with the reason it cannot carry a count.
  // WHAT THE MEASUREMENT SAID, and what it did to the claim, said out loud: the first version of this check asked
  // for a cell of the body under the surface in EVERY frame. It does not happen, and the reason is arithmetic, not
  // a defect. On this fixture the water column is 5 px (the mock's loudest byte is 0.57 of the panel's 70 dB
  // ladder) and the swell it drives lifts the body between 2 and 6 px, so at the crest of a swell the animal rides
  // clear of the water -- 16 of 29 frames break the surface, the rest ride above it. The claim this check makes is
  // the one that does not depend on the depth: the ink follows the surface run by run, in both directions, with no
  // exception in any frame of either run. That is stricter than the count it replaced, not softer.
  {
    const qR752 = await q752Mount752({}, 'whale');
    const roll752 = q752Run752(qR752, 60, q752Loud752);
    const rp752 = roll752.map(q752MarkOf752);
    const railRoll752 = rp752.reduce(function (a752, p752) { return a752 + p752.barArea; }, 0);
    const subRoll752 = rp752.reduce(function (a752, p752) { return a752 + p752.subCells; }, 0);
    const whiteRoll752 = rp752.reduce(function (a752, p752) { return a752 + p752.white; }, 0);
    const rollHeights752 = rp752.map(function (p752) { return p752.box ? p752.box.h : -1; });
    const rollLowMax752 = rp752.reduce(function (a752, p752) { return Math.max(a752, p752.low); }, -1);
    const rollTravel752 = q752Travel752(rp752, q752InsideIdx752(rp752), -1);   // T-754: right to left, both motions
    const inksRoll752 = q752Inks752(roll752);
    teardown();

    const qS752 = await q752Mount752({}, 'whale');
    const swimSet752 = await q752PressTo752(qS752.m, 'audio-play-whale-motion752', 'swimming');
    const okSwim752 = swimSet752.ok;
    const shownSwim752 = q752BoxWord752(qS752.m, 'audio-play-whale-motion752');
    const swim752 = q752Run752(qS752, 60, q752Loud752);
    const sp752 = swim752.map(q752MarkOf752);
    teardown();

    const n752 = Math.min(rp752.length, sp752.length);
    const both752 = [];
    for (let i752 = 0; i752 < n752; i752++) {
      if (q752Inside752(rp752[i752].box) && q752Inside752(sp752[i752].box)) both752.push(i752);
    }
    const railSame752 = (function () {
      for (let i752 = 0; i752 < n752; i752++) { if (rp752[i752].barKeys !== sp752[i752].barKeys) return false; }
      return true;
    })();
    // Reported, so that a rail difference is a fact and not a boolean: how many frames differ, and the first one.
    const railMismatch752 = [];
    for (let i752 = 0; i752 < n752; i752++) {
      if (rp752[i752].barKeys !== sp752[i752].barKeys) railMismatch752.push(i752);
    }
    const swimHeights752 = sp752.map(function (p752) { return p752.box ? p752.box.h : -1; });
    // The readings the assertions are made on are the frames where the whole body is on the canvas in both runs.
    // A clipped frame says nothing about a body's angle -- its outline is cut off -- and an off-canvas frame says
    // nothing at all, so both are reported and neither is asserted on.
    const swimHeightsIn752 = both752.map(function (i752) { return sp752[i752].box.h; });
    const swimLowsIn752 = both752.map(function (i752) { return sp752[i752].low; });
    const rollHeightsIn752 = both752.map(function (i752) { return rp752[i752].box.h; });
    const extYSwimMax752 = q752MkHalfW752 * Math.sin(q752SwimPitchMax752) + q752MkHalfH752 * Math.cos(q752SwimPitchMax752);
    const heightBound752 = 2 * extYSwimMax752 + 2 * q752MkCell752;      // the turned half-extent, twice, plus rounding
    const swimTravel752 = q752Travel752(sp752, both752, -1);   // T-754: the same direction in both motions
    // The surface is measured, not assumed: it is the top edge of the rail the frame draws. The client's rule, in
    // the fillStyle line of the mark frame, is that a run of the body whose bottom edge falls below that line is
    // painted in the water's ink and a run above it in the mark's ink. Both directions are checked, run by run.
    // This is the contract the setting is for, and it does not depend on how deep a given fixture happens to sit
    // the body -- how deep it does sit is reported as a measurement, not asserted as a requirement.
    const barHeights752 = q752Distinct752(rp752.reduce(function (a752, p752) { return a752.concat(p752.barHeights); }, []));
    const waterLine752 = q752Ground752 - Math.max.apply(null, barHeights752);
    let underNotReinked752 = 0, overReinked752 = 0, underRuns752 = 0, underFrames752 = 0;
    both752.forEach(function (i752) {
      const p752 = sp752[i752];
      let any752 = false;
      p752.whiteRects.forEach(function (r752) {
        if (r752[1] + q752MkCell752 > waterLine752) { underNotReinked752++; underRuns752++; any752 = true; }
      });
      p752.subRects.forEach(function (r752) {
        if (r752[1] + q752MkCell752 <= waterLine752) overReinked752++;
        else { underRuns752++; any752 = true; }
      });
      if (any752) underFrames752++;
    });
    const swimWholeMark752 = both752.filter(function (i752) { return sp752[i752].cells >= q752MkLit752 - 8; }).length;
    const allowedInks752 = [q752BgInk752, '#ffffff', 'rgba(255,255,255,0.30)'];
    const inksSwim752 = q752Inks752(swim752);
    const inksClean752 = inksSwim752.every(function (c752) { return allowedInks752.indexOf(c752) >= 0; })
      && inksRoll752.every(function (c752) { return allowedInks752.indexOf(c752) >= 0; });
    // The pose-matched reading, kept as a measurement and not as an assertion. At the frames where the rolling
    // body happens to be level -- the pose the swimming body holds all run -- the two bodies are the same body,
    // and their cell counts differ by a couple of cells because they sit at different sub-pixel positions and a
    // rotated sample lands on different cells. That is why the ink rule above is what carries the claim.
    const level752 = both752.filter(function (i752) { return Math.abs(rollHeights752[i752] - q752MkLevelH752) <= 2; });
    const levelPairs752 = level752.map(function (i752) {
      return 'frame ' + i752 + ': rolling ' + rp752[i752].white + ' white / swimming ' + sp752[i752].white
        + ' white + ' + sp752[i752].subCells + ' in the water ink';
    });
    const subSwim752 = sp752.reduce(function (a752, p752) { return a752 + p752.subCells; }, 0);
    const railSwim752 = sp752.reduce(function (a752, p752) { return a752 + p752.barArea; }, 0);
    const whiteSwim752 = sp752.reduce(function (a752, p752) { return a752 + p752.white; }, 0);
    const swimLows752 = sp752.map(function (p752) { return p752.low; });
    const swimLowMin752 = Math.min.apply(null, swimLowsIn752);
    const swimLowMax752 = Math.max.apply(null, swimLowsIn752);

    check('T-752: swimming does not turn the body -- in every one of the ' + both752.length
        + ' frames where the whole body is on the canvas in both runs its drawn height stays inside the '
        + q752MkLevelH752 + ' px the mark is when it is level plus the ' + (heightBound752 - q752MkLevelH752).toFixed(1)
        + ' px the ruled wallow pitch can add and the rounding of a cell (the highest such frame is '
        + Math.max.apply(null, swimHeightsIn752) + ' px), while the ROLLING run reaches '
        + Math.max.apply(null, rollHeightsIn752) + ' px in the same frames -- yet the body is not frozen either: its '
        + 'lowest cell takes ' + q752Distinct752(swimLowsIn752).length + ' different heights across those frames as '
        + 'the bob lifts and lowers it -- and it still travels LEFT at ' + swimTravel752.rate.toFixed(2)
        + ' px per frame against the rolling run\'s ' + rollTravel752.rate.toFixed(2) + ', with no step against the '
        + 'direction the mode is meant to travel. (T-754, 2026-11-07: the operator asked for the animal to face and '
        + 'move the other way -- "we can use the original left facing, but would have to change the direction on the '
        + 'canvas from right to left" -- and a mark walks the way its head points in every motion it is offered.)',
      okSwim752 && shownSwim752 === 'swimming' && n752 >= 30 && both752.length >= 12
        && swimHeightsIn752.every(function (h752) { return h752 > 0 && h752 <= heightBound752; })
        && Math.max.apply(null, rollHeightsIn752) > heightBound752
        && q752Distinct752(swimLowsIn752).length >= 3
        && swimTravel752.net >= 25 && swimTravel752.backwards === 0
        && Math.abs(swimTravel752.rate - rollTravel752.rate) <= 0.6,
      { frames: n752, frames_inside_both: both752.length, frames_clipped_or_off: n752 - both752.length,
        swim_heights_inside: q752Distinct752(swimHeightsIn752),
        swim_heights_all_frames: q752Distinct752(swimHeights752),
        roll_heights_inside: q752Distinct752(rollHeightsIn752),
        level_height_px: q752MkLevelH752, swim_height_bound: Number(heightBound752.toFixed(2)),
        ruled_pitch_max: q752SwimPitchMax752, roll_height_max: Math.max.apply(null, rollHeights752),
        swimming_lowest_cell_values: q752Distinct752(swimLows752),
        swim_px_per_frame: Number(swimTravel752.rate.toFixed(3)), roll_px_per_frame: Number(rollTravel752.rate.toFixed(3)),
        swim_backwards_steps: swimTravel752.backwards });
    check('T-752: swimming puts the body in the water and paints the part of it below the surface in the water\'s own '
        + 'colour and in no third colour. The surface is read off the rail the frame draws -- its top edge is y '
        + waterLine752 + ', the same ' + barHeights752.join('/') + ' px bars in both runs, ' + railRoll752
        + ' px of rail in each -- and the ink follows that line run by run in both directions: '
        + underNotReinked752 + ' run painted in the mark colour where its bottom edge crossed the line, '
        + overReinked752 + ' painted in the water colour where it did not. The body breaks the surface in '
        + underFrames752 + ' of the ' + both752.length + ' frames measured and rides clear of it in the rest, which '
        + 'is what a ' + (q752Ground752 - swimLowMin752) + ' px crest does against a '
        + (q752Ground752 - waterLine752) + ' px water column; the rolling run paints no cell of its body in the '
        + 'water ink (' + subRoll752 + '), the whole mark is painted in the two inks together in '
        + swimWholeMark752 + ' of ' + both752.length + ' frames, and no colour appears in either run beyond the '
        + 'panel\'s ground, the mark white and the rail ink',
      railSame752 && railSwim752 === railRoll752 && subRoll752 === 0
        && underNotReinked752 === 0 && overReinked752 === 0
        && underFrames752 >= Math.ceil(both752.length / 2) && underRuns752 >= underFrames752
        && swimWholeMark752 >= both752.length - 2 && inksClean752,
      { frames: n752, frames_inside_both: both752.length, water_line_y: waterLine752,
        rail_bar_heights: barHeights752, body_runs_below_line_not_reinked: underNotReinked752,
        body_runs_above_line_reinked: overReinked752, body_runs_below_line_total: underRuns752,
        frames_breaking_surface: underFrames752,
        rail_frames_differing: railMismatch752.length,
        rail_first_differing_frame: railMismatch752.length ? railMismatch752[0] : null,
        rail_bars_roll_at_first: railMismatch752.length ? rp752[railMismatch752[0]].barHeights : null,
        rail_bars_swim_at_first: railMismatch752.length ? sp752[railMismatch752[0]].barHeights : null,
        depth_profile_low_and_submerged: both752.map(function (i752) { return i752 + ':' + sp752[i752].low + '/' + sp752[i752].subCells; }),
        white_cells_rolling_total: whiteRoll752, white_cells_swimming_total: whiteSwim752,
        submerged_cells_swimming: subSwim752, submerged_frames_swimming: sp752.filter(function (p752) { return p752.subCells > 0; }).length,
        whole_mark_frames_swimming: swimWholeMark752, rail_area_rolling: railRoll752, rail_area_swimming: railSwim752,
        pose_matched_frames: level752, pose_matched_readings: levelPairs752,
        inks_swimming: inksSwim752, inks_rolling: inksRoll752 });
    check('T-752: what each motion does to the body\'s lowest cell against the ground line it rides -- rolling '
        + 'reaches the line at its level poses (lowest cell bottom y ' + rollLowMax752 + ' against the line y '
        + q752Ground752 + '), swimming rides the swell instead: its lowest cell stays inside the band the ruled bob '
        + 'is allowed to move it, between y ' + (q752Ground752 - q752BobMax752) + ' and the line (measured '
        + swimLowMin752 + ' to ' + swimLowMax752 + ' across the frames where the whole body is on the canvas), it takes '
        + q752Distinct752(swimLowsIn752).length
        + ' different heights across those frames, and no frame of either run draws any part of the body below the line',
      rollLowMax752 >= q752Ground752 - 2 && rollLowMax752 <= q752Ground752
        && swimLowMin752 >= q752Ground752 - q752BobMax752 && swimLowMax752 <= q752Ground752
        && sp752.every(function (p752) { return p752.low <= q752Ground752; })
        && rp752.every(function (p752) { return p752.low <= q752Ground752; }),
      { rolling_lowest_reached: rollLowMax752, swimming_lowest_range: [swimLowMin752, swimLowMax752],
        swimming_lowest_all_frames: q752Distinct752(swimLows752),
        bob_max_px: q752BobMax752, ground_line: q752Ground752 });
    console.log('  MEASURE T-752 swimming against rolling, 60 frames each on one loud fixture and one clock rule '
      + 'aligned to both ruled periods and started a quarter-period into the wallow: '
      + 'rail ' + railRoll752 + ' px in the rolling run and ' + railSwim752 + ' px of rail bars in the swimming run '
      + '(the same bars, the same places), their top edge at y ' + waterLine752 + ', which is where the water is; '
      + subSwim752 + ' cells of the body painted in that same rail ink in the swimming run across '
      + underFrames752 + ' frames and ' + subRoll752 + ' in the rolling run, ' + underNotReinked752
      + ' run below the line left in the mark colour and ' + overReinked752
      + ' above it painted as water. How deep it goes is a property of this fixture and is stated as one: the '
      + 'mock\'s analyser window tops out at -30 dB, so its loudest byte is ' + barHeights752.join('/')
      + ' px of the ruled ' + q752RailH752 + ' px ladder, the surface sits ' + (q752Ground752 - waterLine752)
      + ' px above the ground, and the swell this level drives lifts the body between ' + (q752Ground752 - swimLowMax752)
      + ' and ' + (q752Ground752 - swimLowMin752) + ' px (its lowest cell between y ' + swimLowMax752 + ' and y '
      + swimLowMin752 + ') -- so at the crest of a swell the animal rides clear of the water and in the trough it is '
      + 'under it, and it crosses the line in ' + underFrames752 + ' of ' + both752.length
      + ' frames. The depth profile, frame:lowest-cell/submerged-cells: '
      + both752.map(function (i752) { return i752 + ':' + sp752[i752].low + '/' + sp752[i752].subCells; }).join(' ')
      + '. The pose-matched reading, reported and not asserted: '
      + levelPairs752.join('; ') + ' -- the same body at the same pose, sampled a cell or two apart, which is why '
      + 'the ink rule carries the claim and a total count does not. White mark cells ' + whiteRoll752
      + ' rolling / ' + whiteSwim752 + ' swimming over the whole run; drawn heights swimming '
      + q752Distinct752(swimHeights752).join(' ') + ' px against the level ' + q752MkLevelH752
      + ' px and the ' + Math.max.apply(null, rollHeights752) + ' px a turned body reaches; travel '
      + swimTravel752.rate.toFixed(2) + ' px per frame swimming / ' + rollTravel752.rate.toFixed(2)
      + ' rolling, both read the same way -- the drawn mean x of the body, biased low on frames clipped at the right '
      + 'edge, which is why the two are compared to each other and not to a ruled number; lowest cell of the body: '
      + 'rolling reaching y ' + rollLowMax752 + ', swimming held between y ' + swimLowMin752 + ' and y '
      + swimLowMax752 + ' by the bob; colours seen: ' + inksSwim752.join(' ')
      + ' -- the panel\'s ground, the mark white and the rail ink, no third');
  }

  // 13. BREACHING. The onset is the llama's own quantity in the llama's own units -- the mean positive rise of the
  // band chain, at the llama's number -- and the fixture here alternates full and silence so every loud frame crosses
  // it. A flight is 900 ms and the cooldown 1800 ms, so in a 100-frame run there is exactly one, and what is
  // measured is that one: the body leaves the surface band, reaches the ruled rise, and comes back to the surface.
  // The separation used is deliberate: a bob alone can only lift the body by the bob, so a frame whose lowest cell
  // is below the ground line by more than the bob maximum is a frame that is in a flight, and a frame whose lowest
  // cell is within the bob band is a frame that is on the surface. Nothing in the body is ever painted above the
  // inner top of the box or below its bottom edge.
  {
    const qB752 = await q752Mount752({ 'deepamp:scope.whale.motion752': 'breaching' }, 'whale');
    const brSet752 = await q752PressTo752(qB752.m, 'audio-play-whale-motion752', 'breaching');
    const okBr752 = brSet752.ok && q752BoxWord752(qB752.m, 'audio-play-whale-motion752') === 'breaching';
    const bsegs752 = q752Run752(qB752, 100, q752LoudQuietAlt752);
    const bp752 = bsegs752.map(q752MarkOf752);
    const surfaceLine752 = q752Ground752 - q752BobMax752;
    const flight752 = [];
    const surface752 = [];
    bp752.forEach(function (p752, i752) {
      if (p752.low <= surfaceLine752 - 2) flight752.push(i752);
      else if (p752.low >= surfaceLine752) surface752.push(i752);
    });
    const maxLift752 = bp752.reduce(function (a752, p752) { return Math.max(a752, q752Ground752 - p752.low); }, 0);
    const minLow752 = bp752.reduce(function (a752, p752) { return Math.min(a752, p752.low); }, 999);
    const aboveTop752 = bp752.filter(function (p752) { return p752.top < q752InnerTop752; }).length;
    const belowGround752 = bp752.filter(function (p752) { return p752.low > q752Ground752; }).length;
    const capB752 = (function () {
      const f752b = q752Build752('scopeWhaleBreachCap752');
      return f752b ? f752b(q752Ground752, q752Inset752, q752MkHalfW752, q752MkHalfH752, q752BreachPitch752) : NaN;
    })();
    const liftCeiling752 = q752RiseMax752 + q752BobMax752;
    // (T-754, 2026-11-07.) The same run measured a second way, and this is the half that had to be re-cut rather
    // than re-numbered. The ruled rise and the ruled bob are heights of the body's CENTRE -- the arc lifts the
    // centre, the bob lifts the centre -- and which cell of an animal is its lowest one is a property of the
    // animal's shape. Turning the whale back to the facing the operator asked for ("it's upside down, and should be
    // mirrored horizontally") moved which cell that is at a pitched angle, so a flight classified from the lowest
    // cell now counts swell-crest frames as flights and a peak read from the lowest cell reports the silhouette as
    // much as it reports the jump. Both readings are taken. The lowest-cell one is still printed and still in the
    // payload -- it is what the water actually cuts -- and the claims about how high a flight goes and how long it
    // lasts are decided on the centre, which is what those rulings are about.
    const centreLift754 = bp752.map(function (p752) { return (p752.my == null) ? null : q752Ground752 - p752.my; });
    const flight754 = [];
    const surface754 = [];
    centreLift754.forEach(function (v754, i754) {
      if (v754 == null) return;
      if (v754 > q752BobMax752 + 2) flight754.push(i754); else surface754.push(i754);
    });
    const maxCentreLift754 = centreLift754.reduce(function (a754, v754) { return (v754 == null) ? a754 : Math.max(a754, v754); }, 0);
    // The length of a flight is one unbroken run of off-surface frames, not the span between the first one and the
    // last one: a run driven past the cooldown holds more than one flight, and the frames between two flights the
    // animal is back on the water. Read both ways, for the same reason as above.
    const runOf754 = function (frames754) {
      let best754 = 0, cur754 = 0, prev754 = -2;
      frames754.forEach(function (i754) {
        cur754 = (i754 === prev754 + 1) ? cur754 + 1 : 1; prev754 = i754;
        if (cur754 > best754) best754 = cur754;
      });
      return best754;
    };
    const flightRun752 = runOf754(flight752);
    const flightRun754 = runOf754(flight754);
    // (T-754, 2026-11-07, second half of the note above.) The clause this pin no longer carries is
    // "the peak lift never exceeds the ruled rise plus the bob", and the reason it goes is that the bound was
    // written against the wrong thing. What the painter places at ground - rise - bob is the bottom edge of the
    // body's ROTATED GRID; the lit cells of an animal sit inside that grid, and which of them is lowest is the
    // shape's business. Turned one way the whale filled that bottom edge and the drawn lowest cell read the arc
    // almost exactly; turned back the way the operator asked -- "it's upside down, and should be mirrored
    // horizontally" -- it does not, and the drawn lowest cell reads above the grid's bottom edge, which is a
    // lower bound on the arc, not an upper one. The arc's own height bound is not dropped: it is pinned by the two
    // checks above this one, which read the client's arc function (rise never above the launch height, peak at
    // mid-flight) and its cap (the launch this box allows), and both still pass. What this check is about, and what
    // it still proves from the drawing, is that a flight happens, that it is one flight of the ruled length, that
    // the next one is held off by the cooldown, and that nothing of the body is painted outside the box.
    const launches754 = (function () {
      const minRun754 = Math.floor(q752FlightMs752 / 16) - 12;
      let runs754 = 0, cur754 = 0, prev754 = -2;
      flight752.forEach(function (i752) {
        cur754 = (i752 === prev754 + 1) ? cur754 + 1 : 1; prev754 = i752;
        if (cur754 === minRun754) runs754++;
      });
      return runs754;
    })();
    check('T-752, re-cut by T-754: breaching lifts the mark clear of the surface it rides. Driven so the spectral '
        + 'flux crosses the '
        + 'ruled onset of ' + q752Onset752 + ' (the same quantity and the same units the llama\'s step already uses), '
        + 'the mark is off the surface band in ' + flight752.length + ' frames and back on it in ' + surface752.length
        + ', the peak lift of its lowest painted cell is ' + maxLift752 + ' px against the ruled rise band '
        + q752RiseMin752 + '..' + q752RiseMax752 + ' px -- at or above the ruled minimum, which is the direction '
        + 'that bound runs for a drawn cell -- one flight is a flight: ' + flightRun752 + ' frames of it are '
        + 'unbroken off the surface, against the ruled ' + q752FlightMs752 + ' ms ('
        + Math.ceil(q752FlightMs752 / 16) + ' frames at 16 ms), and the ' + q752CooldownMs752
        + ' ms cooldown means this run launches ' + launches754 + ' time, not more -- and no frame paints any '
        + 'part of the body above the inner top y ' + q752InnerTop752 + ' or below the bottom edge y '
        + q752Ground752 + '. Reported beside it, and not asserted: the same run read from the body\'s painted centre '
        + '(' + maxCentreLift754.toFixed(1) + ' px, ' + flight754.length + ' frames off the band, longest run '
        + flightRun754 + ') -- the gap between the two readings is the silhouette, not the jump.',
      okBr752 && bsegs752.length >= 60
        && flight752.length >= 5 && surface752.length >= 20
        && maxLift752 >= q752RiseMin752
        && aboveTop752 === 0 && belowGround752 === 0
        && flightRun752 >= Math.floor(q752FlightMs752 / 16) - 12
        && launches754 <= 1,
      { frames: bp752.length, flight_frames: flight752.length, flight_frames_at: flight752.slice(0, 60),
        surface_frames: surface752.length, peak_lift_px: maxLift752, lowest_cell_bottom: minLow752,
        centre_read_of_same_run: { peak_lift_px: Number(maxCentreLift754.toFixed(2)),
          flight_frames: flight754.length, longest_run_frames: flightRun754 },
        launches_in_run: launches754,
        surface_band_below_y: surfaceLine752, frames_above_inner_top: aboveTop752, frames_below_ground: belowGround752,
        ruled_onset: q752Onset752, ruled_rise_min: q752RiseMin752, ruled_rise_max: q752RiseMax752,
        ruled_rise_plus_bob_px: liftCeiling752,
        derived_cap_px: capB752, flight_ms: q752FlightMs752, cooldown_ms: q752CooldownMs752,
        longest_flight_run_frames: flightRun752 });
    console.log('  MEASURE T-752 one breach, start to landing, read both ways: the body\'s centre leaves the '
      + 'surface band at frame ' + (flight754.length ? flight754[0] : -1) + ' and ' + flight754.length
      + ' frames of the run are off it, the top of the flight has its centre at y '
      + (bp752.length ? Math.min.apply(null, bp752.map(function (p752) { return p752.my; })).toFixed(1) : -1)
      + ' -- a lift of ' + maxCentreLift754.toFixed(1) + ' px of the centre against the ruled band '
      + q752RiseMin752 + '..' + q752RiseMax752 + ' px and the derived cap '
      + (isFinite(capB752) ? capB752.toFixed(2) : 'NaN') + ' px -- and ' + surface754.length
      + ' frames are back on the surface band. The longest unbroken run of off-surface frames is ' + flightRun754
      + ' against the ruled ' + q752FlightMs752 + ' ms of flight, ' + Math.ceil(q752FlightMs752 / 16)
      + ' frames at 16 ms. The same run read from the lowest painted cell: ' + flight752.length
      + ' frames off the band, longest run ' + flightRun752 + ', peak ' + maxLift752 + ' px, lowest cell reaching y '
      + minLow752 + ' -- the difference between the two readings is the silhouette, not the jump: since the whale is '
      + 'drawn the other way round, the cell that hangs lowest at a pitched angle is a different cell, and the '
      + 'crest of the swell reads as a flight when it is classified that way. Nothing of the body is painted above y '
      + q752InnerTop752 + ' or below y '
      + q752Ground752 + '; the onset the mode watches is the llama\'s own flux at ' + q752Onset752
      + ' and the next launch is held off by the ' + q752CooldownMs752 + ' ms cooldown');
    teardown();
  }

  // 14. THE MOTION SETTING DOES NOT REACH THE OTHER MARK. A mark that rolls has no swimming to be given, and the
  // measurement that says so is the picture: the qwen mode with the word stored and then set on the control draws
  // the rolling qwen, frame for frame, cell counts, boxes and lowest cells identical.
  {
    const qOa752 = await q752Mount752({}, 'qwen');
    const oa752 = q752Run752(qOa752, 30, q752Loud752);
    const sa752 = oa752.map(q752SigOf752);
    teardown();
    const qOb752 = await q752Mount752({ 'deepamp:scope.whale.motion752': 'swimming' }, 'qwen');
    const oSet752 = await q752PressTo752(qOb752.m, 'audio-play-whale-motion752', 'swimming');
    const okO752 = oSet752.ok;
    const ob752 = q752Run752(qOb752, 30, q752Loud752);
    const sb752 = ob752.map(q752SigOf752);
    const shownO752 = q752BoxWord752(qOb752.m, 'audio-play-whale-motion752');
    teardown();
    const sameO752 = sa752.length >= 20 && sa752.length === sb752.length && sa752.join('|') === sb752.join('|');
    check('T-752: the motion setting does not reach the qwen mark -- the drawing reads it for one mode only, and the '
        + 'picture says so: the qwen mode with the word stored and then set to swimming on the control draws the '
        + 'rolling qwen, frame for frame, ' + sa752.length + ' frames of identical cell counts, boxes and lowest cells',
      okO752 && shownO752 === 'swimming' && sameO752
        && /\(mode748 === "whale"\) \? scopeWhaleMotion752/.test(src),
      { frames_a: sa752.length, frames_b: sb752.length, identical: sameO752, shown: shownO752,
        first_difference: (function () {
          for (let i752 = 0; i752 < Math.max(sa752.length, sb752.length); i752++) { if (sa752[i752] !== sb752[i752]) return i752; }
          return -1;
        })(),
        sample: sa752.slice(0, 3) });
    console.log('  MEASURE T-752 the qwen mark with the motion control set to swimming: ' + sa752.length
      + ' frames compared frame for frame against the same mode with the control untouched -- '
      + (sameO752 ? 'identical' : 'differences start at frame ' + (function () {
          for (let i752 = 0; i752 < Math.max(sa752.length, sb752.length); i752++) { if (sa752[i752] !== sb752[i752]) return i752; }
          return -1;
        })())
      + '; the setting is stored and shown as ' + shownO752 + ' and the drawing does not read it for this mark');
  }

  // 15. BOTH WORDS SURVIVE A RELOAD, and the picture on the reloaded page is the one the stored words ask for.
  {
    const qP752 = await q752Mount752({}, 'llama');
    const setD752 = await q752PressTo752(qP752.m, 'audio-play-dance-icon752', 'whale');
    const setM752 = await q752PressTo752(qP752.m, 'audio-play-whale-motion752', 'swimming');
    const setOkD752 = setD752.ok;
    const setOkM752 = setM752.ok;
    const stored752 = { icon: qP752.br.store['deepamp:scope.dance.icon752'], motion: qP752.br.store['deepamp:scope.whale.motion752'] };
    qP752.br.hotBins = [];
    const qPfr752 = q752Run752(qP752, 2);
    const qPbox752 = qPfr752.length ? q752Box752(q752Animal752(qPfr752[qPfr752.length - 1])) : null;
    teardown();
    const qR752b = await q752Mount752({ 'deepamp:scope.dance.icon752': stored752.icon, 'deepamp:scope.whale.motion752': stored752.motion }, 'llama');
    const shownD752 = q752BoxWord752(qR752b.m, 'audio-play-dance-icon752');
    const shownM752 = q752BoxWord752(qR752b.m, 'audio-play-whale-motion752');
    qR752b.br.hotBins = [];
    const qRfr752 = q752Run752(qR752b, 2);
    const qRper752 = qRfr752.map(function (seg752) { const rs752 = q752Animal752(seg752); return { cells: q752Cells752(rs752), box: q752Box752(rs752) }; });
    const qRbox752 = qRper752.length ? qRper752.filter(function (p752) { return !!p752.box; })[0].box : null;
    // (T-754 contract change, 2026-11-07.) The animal this pin expected was 92 x 68 px and 784 cells, because that
    // is the size the dancing whale was first traced at. The operator's word was "it's too big", and the size they
    // chose is the llama's own width, which is the mark's grid. The expected box is therefore counted out of the
    // grid the code carries -- the mark's -- rather than written as a number here, exactly as the silhouette pin
    // above measures its animal. What this pin is about has not moved at all: a setting is a stored word, a page
    // reloaded on that word shows it on its control, and the picture on that page is the one the word names.
    const qRmask754 = q752Mask752('SCOPE_DANCE_WHALE_MASK752');
    const qRcell754 = q752Num752(/SCOPE_DANCE_WHALE_CELL752 = (\d+);/);
    const qRw754 = qRmask754.colsLit * qRcell754;
    const qRh754 = qRmask754.rowsLit * qRcell754;
    check('T-752, re-cut by T-754: both settings are stored words, not moments -- choosing them writes deepamp:scope.dance.icon752 and '
        + 'deepamp:scope.whale.motion752, a page reloaded on those words shows them on the two controls, and the '
        + 'animal it draws is the one the stored word names (' + (qRbox752 ? qRbox752.w : 0) + ' x '
        + (qRbox752 ? qRbox752.h : 0) + ' px, ' + (qRper752.length ? qRper752[0].cells : 0) + ' cells, counted out '
        + 'of the grid the code carries as ' + qRw754 + ' x ' + qRh754 + ' px and ' + qRmask754.lit + ' cells), not the '
        + 'default one',
      setOkD752 && setOkM752 && stored752.icon === 'whale' && stored752.motion === 'swimming'
        && shownD752 === 'whale' && shownM752 === 'swimming'
        && !!qRbox752 && qRbox752.w === qRw754 && qRbox752.h === qRh754
        && qRper752.every(function (p752) { return p752.cells === qRmask754.lit; })
        && qRmask754.lit === 334 && qRw754 <= 60 && qRh754 <= 68
        && !!qPbox752 && qPbox752.w === qRw754 && qPbox752.h === qRh754,
      { stored: stored752, shown_after_reload: { icon: shownD752, motion: shownM752 },
        drawn_after_reload: qRbox752 ? [qRbox752.w, qRbox752.h] : null,
        cells_after_reload: qRper752.map(function (p752) { return p752.cells; }),
        drawn_before_reload: qPbox752 ? [qPbox752.w, qPbox752.h] : null });
    console.log('  MEASURE T-752 persistence: the two controls wrote deepamp:scope.dance.icon752='
      + String(stored752.icon) + ' and deepamp:scope.whale.motion752=' + String(stored752.motion)
      + '; a fresh mount carrying that store shows both words on their controls and draws a '
      + (qRbox752 ? qRbox752.w : 0) + ' x ' + (qRbox752 ? qRbox752.h : 0) + ' px animal at x '
      + (qRbox752 ? qRbox752.x0 : 0) + ' standing on y ' + (qRbox752 ? qRbox752.y1 : 0));
    teardown();
  }


  // ── T-788 / T-789 (2026-11-11): the waveform's moving window, the spectrum's LED count, the fire that stays ──
  {
    const src788 = require('fs').readFileSync(TARGET, 'utf8');
    // T-820 (2026-11-13, operator, verbatim: "the sliding window still looks laggy, maybe add a mode sliding4 and
    // sliding8 to show an even smaller window, resulting in faster movement"): the box that chooses the window walks
    // five words now. Every fixture below that measures a DRAWING has to land on the word it asked for, and landing
    // on it means pressing a FULL RING. So the ring is read out of the file the box cycles instead of being counted
    // here — a fixture that counts the words by hand fails the day a word is added, which is exactly what happened
    // when this card landed. The order it reads is the order the cycle walks.
    const ring788 = (function () {
      const m788r = src788.match(/var SCOPE_WAVE_VIEW_OPTS788 = \[([^\]]*)\]/);
      if (!m788r) return [];
      return m788r[1].split(',').map(function (w788r) { return w788r.trim().replace(/^"|"$/g, ''); });
    })();
    check('T-820 ring read: the words the box offers are read out of the file, in the order the cycle walks them, so no fixture in this block counts them by hand again',
      ring788.length >= 5 && ring788[0] === 'sliding' && ring788.indexOf('full') === ring788.length - 1
      && ring788.indexOf('sliding2') === 1 && ring788.indexOf('sliding4') === 2 && ring788.indexOf('sliding8') === 3,
      { ring_read_from_the_file: ring788 });
    check('T-788 (operator, verbatim: "remove option to switch between amp and dB - fix to amp in the background"): the waveform row offers ONE level word and its default is amp, and the dB spacing is still in the code that ruling said to keep, in both of this mode\'s painters -- the form T-750 set for the spectrum ("keep code but config to dB"). The mode\'s own view switch is declared beside it, and the default is the window (operator: "make the sliding window the default"). RE-CUT 2026-11-11 by T-792 (operator: "shorten the window: half the current size, AND offer option sliding2 with a quater of current window size"): this pin named two words, the mode offers three now; the default word and the base window the fractions are taken from are unchanged and are still pinned here. RE-CUT AGAIN 2026-11-13 by T-820 (operator: "add a mode sliding4 and sliding8 to show an even smaller window"): the list names five words now. The one level word and its default, the default view word, the base window the fractions are taken from and the dB branches this card was asked to keep are all unchanged and are still pinned here',
      /static:\s*\{ words: \["amp"\], def: "amp"/.test(src788)
      && (src788.match(/scopeLevel346\(scopeLevelsRef346\.current, "static"\) !== "dB"/g) || []).length === 2
      && /var SCOPE_WAVE_VIEW_OPTS788 = \["sliding", "sliding2", "sliding4", "sliding8", "full"\];/.test(src788)
      && /var SCOPE_WAVE_VIEW_DEFAULT788 = "sliding";/.test(src788)
      && /var SCOPE_WAVE_WINDOW_MS788 = 12000;/.test(src788),
      { level_words: (src788.match(/static:\s*\{ words: \[([^\]]*)\]/) || [null, 'none'])[1],
        db_branches_kept: (src788.match(/scopeLevel346\(scopeLevelsRef346\.current, "static"\) !== "dB"/g) || []).length });

    const mountPanel788 = async function (storage788) {
      const br788 = makeBrowser({ storage: storage788 });
      const mt788 = await mount(br788, { canvas2d: true, audioTracks: 1 });
      mt788.commit(); await flush();
      await openAllSections(mt788.shim, mt788.comp);
      mt788.commit(); await flush();
      return { br: br788, m: mt788 };
    };
    const p788 = await mountPanel788({ 'deepamp:scope.mode': 'static' });
    const vBox788 = function () { return p788.m.els('audio-play-scope-waveview788')[0]; };
    const vWord788 = function () { return p788.m.ownText(vBox788()); };
    const vA788 = vWord788();
    const vStore0788 = p788.br.store['deepamp:scope.wave.view788'];
    // T-820 (2026-11-13): the walk is followed press by press, once around whatever the file declares, and every
    // word it lands on is read from the box AND from the store. This fixture used to press three times and name the
    // three words; with five words on the box three presses walk part of the ring, and the claim this check makes is
    // "the whole ring". Reading the ring from the file is also what stops this fixture failing the day a word moves.
    const walk788 = [];
    for (let c788 = 0; c788 < ring788.length; c788++) {
      vBox788().props.onClick(); p788.m.commit(); await flush();
      walk788.push({ word: vWord788(), stored: p788.br.store['deepamp:scope.wave.view788'] });
    }
    check('T-788 control (operator: "replace the option to switch between static view (as we have for files filling canvas with full file waveform) - with a dynamic sliding window what we currently already have for stream display - where the waveform is moving"): the cell the level box used to fill on the waveform row now holds ONE view box in the whole panel, it prints the word in use, an untouched panel shows sliding and stores nothing at all, and the press walks the whole ring while writing the word it landed on to the store. RE-CUT 2026-11-11 by T-792 (operator: "offer option sliding2 with a quater of current window size"): the ring is three words now -- sliding, sliding2, full -- and the walk and the store writes are followed all the way round it. RE-CUT AGAIN 2026-11-13 by T-820 (operator: "add a mode sliding4 and sliding8"): the ring is five words now and the walk is followed press by press against the ring read out of the file, which is the same claim with no word count written into the test',
      p788.m.els('audio-play-scope-waveview788').length === 1 && vA788 === 'sliding'
      && vStore0788 === undefined
      && walk788.length === ring788.length && ring788.length >= 3
      && ring788.every(function (w788w, i788w) { const j788w = (i788w + 1) % ring788.length; return walk788[i788w].word === ring788[j788w] && walk788[i788w].stored === ring788[j788w]; })
      && walk788[walk788.length - 1].word === vA788 && walk788[walk788.length - 1].stored === vA788,
      { cells: p788.m.els('audio-play-scope-waveview788').length, ring: ring788,
        cycle: walk788.map(function (s788c) { return s788c.word; }),
        stored_at_each_step: walk788.map(function (s788c) { return s788c.stored; }),
        stored_before_any_press: vStore0788 });

    const p788x = await mountPanel788({ 'deepamp:scope.mode': 'static', 'deepamp:scope.wave.view788': 'both' });
    const p788f = await mountPanel788({ 'deepamp:scope.mode': 'static', 'deepamp:scope.wave.view788': 'full' });
    check('T-788 validator: a stored word the mode does not offer falls back to the default and a stored word it does offer is honoured on the next mount -- the same shape the level table uses, so a half-restored config cannot leave the mode between two pictures',
      p788x.m.ownText(p788x.m.els('audio-play-scope-waveview788')[0]) === 'sliding'
      && p788f.m.ownText(p788f.m.els('audio-play-scope-waveview788')[0]) === 'full',
      { asked: 'both', answers: p788x.m.ownText(p788x.m.els('audio-play-scope-waveview788')[0]),
        stored_full: p788f.m.ownText(p788f.m.els('audio-play-scope-waveview788')[0]) });

    // T-809 (2026-11-12, the operator's words: "visualizer: waveform: fix the second option to 'half' and
    // remove the setting again so we have uniform button matrix again with 2 buttons per visualizer"). The
    // look-ahead is fixed behaviour now and its control is out of the matrix, so the waveform row carries one
    // control, as every other visualizer row does. The card's own answer on this row was "make half the
    // default, remove the setting for it". What the view box cycles is untouched by that removal, and a browser
    // key left over from the setting that is gone changes nothing: nothing reads it.
    const p809 = await mountPanel788({ 'deepamp:scope.mode': 'static', 'deepamp:scope.wave.lead793': 'none' });
    const box809 = function () { return p809.m.els('audio-play-scope-waveview788'); };
    const word809 = function () { const e809 = box809()[0]; return e809 ? p809.m.ownText(e809) : ''; };
    const leadBox809 = p809.m.els('audio-play-scope-wavelead793');
    const w809walk = [];
    for (let c809 = 0; c809 < ring788.length; c809++) {
      w809walk.push(word809());
      if (box809().length) { box809()[0].props.onClick(); p809.m.commit(); await flush(); }
    }
    const w809a = w809walk[0];
    check('T-809 control: the waveform row has its one view control and NO look-ahead control; the cycle walks the ring the file declares, in order; a stale lead key is carried and read by nothing. RE-CUT 2026-11-13 by T-820 (operator: "add a mode sliding4 and sliding8"): this named the three words the cycle walked and the ring is five now, so the walk is read against the ring in the file instead of against a list written here. The half of this claim that belongs to T-809 — one control on the row, no look-ahead control, and a stale key nothing reads — is unchanged and still measured',
      box809().length === 1 && leadBox809.length === 0
      && w809walk.length === ring788.length
      && ring788.every(function (w809w, i809w) { return w809walk[i809w] === w809w; })
      && w809a === 'sliding'
      && p809.br.store['deepamp:scope.wave.lead793'] === 'none',
      { view_controls: box809().length, lead_controls: leadBox809.length, cycle: w809walk, ring: ring788,
        stale_key_still_in_the_browser: p809.br.store['deepamp:scope.wave.lead793'] });
    check('T-809 source: the look-ahead is one fixed fraction in the file, with no option list, no validator, no cycle function and no browser key of its own',
      /var SCOPE_WAVE_LEAD_FRAC793 = 0\.5;/.test(src788)
      && !/SCOPE_WAVE_LEAD_OPTS793|LS_SCOPE_WAVE_LEAD793|SCOPE_WAVE_LEAD_DEFAULT793|scopeWaveLead793\(|cycleScopeWaveLead793/.test(src788)
      && /var leadMs788 = winMs788 \* SCOPE_WAVE_LEAD_FRAC793;/.test(src788)
      && (src788.match(/audio-play-scope-wavelead793/g) || []).length === 0,
      { lead_words_left: (src788.match(/SCOPE_WAVE_LEAD_OPTS793|LS_SCOPE_WAVE_LEAD793|cycleScopeWaveLead793|scopeWaveLeadFrac793/g) || []).length,
        lead_control_elements: (src788.match(/audio-play-scope-wavelead793/g) || []).length });

    // A take long enough for a window to be a window rather than the whole file: 60 s, the first half loud, the
    // second half quiet. The window this block was written against was 12 s; T-792 halved it to 6 s, and a 60 s
    // take is long enough for either, which is the point of the two halves being the two things the fixture can
    // tell apart.
    const pk788 = [];
    for (let i788 = 0; i788 < 240; i788++) {
      const v788 = Math.sin(i788 / 9) * (i788 < 120 ? 0.72 : 0.18);
      pk788.push({ max: v788 > 0 ? v788 : 0, min: v788 < 0 ? v788 : 0 });
    }
    const item788 = [{ id: 'ap-7881', fn: 'tts', kind: 'tts', status: 'ok', model: 'm1', voice: 'voy_janeway', duration: 60, text: 'the long take' }];
    const mountWave788 = async function (storage788, pos788) {
      const br788 = makeBrowser({ storage: storage788 });
      const mt788 = await mount(br788, {
        canvas2d: true, audioTracks: 1, peaks: pk788, channels: 1, sampleRate: 48000, durationS: 60,
        bytes: 2880000, items: item788,
      });
      mt788.commit(); await flush();
      await openAllSections(mt788.shim, mt788.comp);
      mt788.commit(); await flush();
      const play788 = mt788.created().filter(function (e788) {
        return e788.type === 'button' && /play the row the transport is on/.test(String(e788.props && e788.props.title));
      }).pop();
      if (play788) { play788.props.onClick(); await flush(); mt788.commit(); await flush(); }
      // armAudio hands back the element the transport actually controls. That is the one the player's clock reads
      // and the one the strip's position is taken from: a panel mounts one <audio> for every row it lists, so the
      // first audio element in the tree is not it, and a time set on the wrong element is a time nobody hears.
      const el788 = mt788.armAudio(1);
      if (el788) { el788.fire('timeupdate'); }
      mt788.commit(); await flush();
      if (el788) {
        el788.duration = 60; el788.currentTime = pos788 * 60;
        if (typeof el788.ontimeupdate === 'function') el788.ontimeupdate();
      }
      mt788.commit(); await flush();
      // The mode's own view box is pressed a FULL RING, and the measurement starts at the last press, so every
      // drawing inside it belongs to the word being measured and to the position set above. The count is the ring
      // read out of the file minus the measured press, not a number written here: the ring was two words when this
      // block was written, three after T-792 (operator: "offer option sliding2 with a quater of current window
      // size"), and five since T-820 (operator: "add a mode sliding4 and sliding8"). A fixture that carries the
      // count measures the wrong word the day the ring changes, which is what this card's first run showed.
      const vbox788 = mt788.els('audio-play-scope-waveview788')[0];
      if (vbox788) {
        for (let c788 = 0; c788 < ring788.length - 1; c788++) { vbox788.props.onClick(); mt788.commit(); await flush(); }
      }
      const n788 = br788.rectLog.length;
      if (vbox788) { vbox788.props.onClick(); mt788.commit(); await flush(); }
      return { br: br788, m: mt788, el: el788, frame: br788.rectLog.slice(n788) };
    };
    // The strip is translated once by its painter (the whole band moves down under the clock band) and every drawing
    // it makes carries that offset in its log entry. Reading only the offset drawings is what keeps the dot-matrix
    // clock, the frame lines and the little waveform a playlist row draws for itself out of a measurement of the
    // strip. A bar of this mode is ~2 px wide; the play head is 1 px wide and its flag 5 px, both outside this set.
    const waveBars788 = function (frame788) {
      return frame788.filter(function (r788) {
        return r788[4] !== 0 && r788[2] >= 1.5 && r788[2] <= 4.5 && r788[3] >= 1;
      });
    };
    const stats788 = function (bars788) {
      const hs788 = bars788.map(function (r788) { return r788[3]; });
      const r788s = { n: hs788.length, max: hs788.length ? Math.max.apply(null, hs788) : 0,
        min: hs788.length ? Math.min.apply(null, hs788) : 0,
        tall: hs788.filter(function (h788) { return h788 >= 8; }).length,
        short: hs788.filter(function (h788) { return h788 < 4; }).length,
        right: bars788.length ? Math.max.apply(null, bars788.map(function (r788) { return r788[0] + r788[2]; })) : 0 };
      r788s.max = Math.round(r788s.max * 100) / 100;
      r788s.min = Math.round(r788s.min * 100) / 100;
      return r788s;
    };
    const mark788 = function (frame788) {
      const mk788 = frame788.filter(function (r788) {
        return r788[4] !== 0 && r788[2] === 1 && r788[3] >= 20;
      });
      return mk788.length ? mk788[mk788.length - 1][0] : -1;
    };
    const wHalf788 = await mountWave788({ 'deepamp:scope.mode': 'static' }, 0.5);
    const fHalf788 = await mountWave788({ 'deepamp:scope.mode': 'static', 'deepamp:scope.wave.view788': 'full' }, 0.5);
    const wEnd788 = await mountWave788({ 'deepamp:scope.mode': 'static' }, 0.95);
    const fEnd788 = await mountWave788({ 'deepamp:scope.mode': 'static', 'deepamp:scope.wave.view788': 'full' }, 0.95);
    // T-809 (2026-11-12, operator: "make half the default, remove the setting for it"): the window now looks
    // half of itself ahead of the moment being heard, always, so at the middle of this take the window
    // straddles the loud/quiet boundary by design. The bar-provenance claim below is about WHICH PART OF THE
    // TAKE the bars came from, and that claim is unchanged — what moved is where it is measured. It is taken
    // at 0.4, where the whole six-second window ([21,27] of this 60 s take) still sits inside the loud half.
    const wLoud788 = await mountWave788({ 'deepamp:scope.mode': 'static' }, 0.4);
    const fLoud788 = await mountWave788({ 'deepamp:scope.mode': 'static', 'deepamp:scope.wave.view788': 'full' }, 0.4);
    const swLoud788 = stats788(waveBars788(wLoud788.frame));
    const sfLoud788 = stats788(waveBars788(fLoud788.frame));
    const swHalf788 = stats788(waveBars788(wHalf788.frame));
    const sfHalf788 = stats788(waveBars788(fHalf788.frame));
    const swEnd788 = stats788(waveBars788(wEnd788.frame));
    const sfEndDiag788 = stats788(waveBars788(fEnd788.frame));
    const sfEnd788 = stats788(waveBars788(fEnd788.frame));
    // A bar at or above 8 px is a bar this fixture drew out of its loud half; below 4 px is its quiet half. The
    // two halves of the file are the two things the instrument can tell apart, and that is what the claim is about:
    // not how tall a bar is, but WHICH PART OF THE TAKE the bars in front of me came from.
    check('T-788 drawing (card answer "keep it, sliding window default"): the window is a window. On one 60 s take, the default picture is built only out of the seconds around the position being heard -- nearly every bar in it is a bar from the loud half -- while the same take drawn whole at the same position carries both halves of itself. RE-CUT 2026-11-11 by T-792 (operator: "the waveform sliding is way too slow, shorten the window: half the current size"): this claim named twelve seconds and the panel now draws six; the claim is about WHICH PART OF THE TAKE the bars came from, and it reads the same at either width. RE-CUT AGAIN 2026-11-12 by T-809 (operator: "make half the default, remove the setting for it"): the window straddles the position being heard by design now, so at the middle of this take its bars come from both halves, and the measurement point moved to 0.4, where the six-second window ([21,27] s of this 60 s take) lies wholly inside the loud half. The claim is the same claim, at the position where it is true. T-792 measures the width itself, against planted spikes, below',
      swLoud788.n >= 40 && sfLoud788.n >= 40
      && swLoud788.tall >= 40 && swLoud788.tall > sfLoud788.tall * 1.5
      && sfLoud788.short >= 8 && swLoud788.short < sfLoud788.short,
      { window_at_40_percent: swLoud788, full_at_40_percent: sfLoud788,
        note: 'tall = a bar 8 px or taller (the loud half of this fixture), short = a bar under 4 px (its quiet half)' });
    check('T-788 drawing (operator: "a dynamic sliding window ... where the waveform is moving"): the window moves with the audio and the picture that fills the canvas does not. Moved to 95 % of the same take the window is now nothing but the quiet half -- not one bar of its 67 reaches the height the loud half draws -- while the whole-file picture at that position is bar for bar the picture at the middle, which is the difference between a window and a file',
      swEnd788.n >= 40 && swEnd788.tall === 0 && swEnd788.max < 8 && swEnd788.max < swHalf788.max
      && sfEnd788.n >= 40 && sfEnd788.tall === sfHalf788.tall
      && Math.abs(sfEnd788.max - sfHalf788.max) < 0.5 && Math.abs(sfEnd788.min - sfHalf788.min) < 0.5,
      { window_at_95: swEnd788, full_at_95: sfEnd788, full_at_half: sfHalf788 });
    check('T-788 drawing: in the window the moment being heard is the MIDDLE of the bars, which is what a look-ahead is -- the play head holds that place at both positions, and moving the take moves what is behind the head and what is ahead of it, not the head. RE-CUT 2026-11-12 by T-809 (operator: "make half the default, remove the setting for it"): as this claim was written the picture had no look-ahead and the head sat at the RIGHT edge of the bars; the panel now looks half a window ahead at every sliding view, so the head is at the middle of them at the middle of the take and at 95 % of it alike. In the whole-file picture the head is where the file says it is: at the middle it is at the middle of the bars, at 95 % it is at 95 % of them',
      mark788(wHalf788.frame) >= swHalf788.right * 0.45 && mark788(wHalf788.frame) <= swHalf788.right * 0.55
      && mark788(wEnd788.frame) >= swEnd788.right * 0.45 && mark788(wEnd788.frame) <= swEnd788.right * 0.55
      && Math.abs(mark788(wHalf788.frame) - mark788(wEnd788.frame)) <= 1
      && mark788(fHalf788.frame) > sfHalf788.right * 0.4 && mark788(fHalf788.frame) < sfHalf788.right * 0.6
      && mark788(fEnd788.frame) > sfHalf788.right * 0.85 && mark788(fEnd788.frame) <= sfHalf788.right,
      { mark_in_window_at_half: mark788(wHalf788.frame), bars_right_edge_window: swHalf788.right,
        mark_in_window_at_95: mark788(wEnd788.frame), mark_in_full_at_half: mark788(fHalf788.frame),
        mark_in_full_at_95: mark788(fEnd788.frame), bars_right_edge_full: sfHalf788.right });
    check('T-788 drawing: the window is fed from the peaks read, not from an analyser -- a take has no tap, and the safety rule of this feature is that createMediaElementSource is never used. The window painter takes the same peaks object the full-file painter takes, and it falls back to the full-file picture when a peaks read carries no length to slide along',
      /function scopeWaveWindowFrame788\(g, W, barH, pk\)/.test(src788)
      && (src788.match(/scopeWaveWindowFrame788\(g, W, barH, scopePeaks300\.current\)/g) || []).length === 2
      && /if \(durMs788 <= 0\) \{ scopeStaticFrame300\(g, W, barH, pk\); return; \}/.test(src788),
      { window_call_sites: (src788.match(/scopeWaveWindowFrame788\(g, W, barH, scopePeaks300\.current\)/g) || []).length });
    // ── T-792 (2026-11-11): the window is half as long, and a quarter-length one is offered ──────────────
    // The operator's words, verbatim: "the waveform sliding is way too slow, shorten the window: half the current
    // size, AND offer option 'sliding2' with a quater of current window size". What is measured below is the window
    // WIDTH as the drawing reports it, not as the constant claims it. The fixture plants spikes at known seconds in
    // a take that is otherwise quiet and plays the take at 30 s. A spike outside the window is not drawn at all; a
    // spike inside it is drawn at a place in the bar row that says where it sat inside the window, and from that
    // place the window's length comes back out. The derivation is in the helper below and it is RE-CUT 2026-11-12
    // by T-809 (operator: "make half the default, remove the setting for it"): a window is centred on the moment
    // being heard now, not ended at it. The four spikes are placed so the three sizes this card is about are told
    // apart at the windows the panel draws now: 20 s sits outside all of them; 26 s sits inside the twelve-second
    // window this feature was BUILT at and outside the six-second one it draws; 28.5 s sits inside the half and the
    // quarter alike, and where it lands is what separates them; 32 s sits inside the half and outside the quarter,
    // which is the second independent reading of the half window. The whole-take picture is run against the same
    // fixture, as the control that says the fixture and not the window is doing the work.
    const pk792 = [];
    for (let i792 = 0; i792 < 240; i792++) {
      const base792 = Math.sin(i792 / 9) * 0.16;
      pk792.push({ max: base792 > 0 ? base792 : 0, min: base792 < 0 ? base792 : 0 });
    }
    const spikeAt792 = [20, 26, 28.5, 32];   // T-809 added 32 s; see the note on the derivations below
    spikeAt792.forEach(function (t792) {
      const b792 = Math.round(t792 * 4);                 // this fixture's buckets are a quarter of a second apart
      pk792[b792] = { max: 1, min: -1 };
      pk792[b792 + 1] = { max: 1, min: -1 };
    });
    // T-820: this mount now takes the peaks it is mounted with. The fixture's own quiet-take-with-spikes array is
    // what the T-792 measurements are mounted on; T-820 mounts its own spikes against the two narrower windows, and a
    // second fixture built by copying this one is two fixtures that can disagree.
    const mount792 = async function (view792, peaks792) {
      const br792 = makeBrowser(view792 ? { storage: { 'deepamp:scope.mode': 'static', 'deepamp:scope.wave.view788': view792 } }
        : { storage: { 'deepamp:scope.mode': 'static' } });
      const mt792 = await mount(br792, {
        canvas2d: true, audioTracks: 1, peaks: peaks792 || pk792, channels: 1, sampleRate: 48000, durationS: 60,
        bytes: 2880000, items: item788,
      });
      mt792.commit(); await flush();
      await openAllSections(mt792.shim, mt792.comp);
      mt792.commit(); await flush();
      const play792 = mt792.created().filter(function (e792) {
        return e792.type === 'button' && /play the row the transport is on/.test(String(e792.props && e792.props.title));
      }).pop();
      if (play792) { play792.props.onClick(); await flush(); mt792.commit(); await flush(); }
      const el792 = mt792.armAudio(1);
      if (el792) { el792.fire('timeupdate'); }
      mt792.commit(); await flush();
      if (el792) {
        el792.duration = 60; el792.currentTime = 30;
        if (typeof el792.ontimeupdate === 'function') el792.ontimeupdate();
      }
      mt792.commit(); await flush();
      // The ring is walked back to the word this mount was asked for, and the count comes from the ring read out of
      // the file (T-820): three words when this fixture was written, five now. The measurement still starts at the
      // last press: everything inside it belongs to the word being measured.
      const vbox792 = mt792.els('audio-play-scope-waveview788')[0];
      // Read the store BEFORE anything is pressed: "a panel that was never touched stores nothing" is only a
      // measurement if it is taken before the presses that write a word to it.
      const storeBefore792 = br792.store['deepamp:scope.wave.view788'];
      if (!vbox792) return { br: br792, m: mt792, el: el792, frame: [], word: '', title: '', storeBefore: storeBefore792 };
      for (let c792 = 0; c792 < ring788.length - 1; c792++) { vbox792.props.onClick(); mt792.commit(); await flush(); }
      const n792m = br792.rectLog.length;
      vbox792.props.onClick(); mt792.commit(); await flush();
      return { br: br792, m: mt792, el: el792, frame: br792.rectLog.slice(n792m),
        word: mt792.ownText(vbox792), title: String(vbox792.props.title || ''), storeBefore: storeBefore792 };
    };
    // Tall bars, grouped into the runs a spike drew. A bar of this mode is ~2 px wide and the bars of one spike are
    // neighbours, so a run of tall bars is one spike, and its left edge is where that spike sits in the window. The
    // denominator is the bar row itself. RE-CUT 2026-11-13 by T-820 (operator: "add a mode sliding4 and sliding8 to
    // show an even smaller window, resulting in faster movement"): the row now SCROLLS, so it no longer starts at
    // x = 0 and does not end at the canvas edge — its first bar is clipped at the left and its last at the right, by
    // the fraction of a bar the window has travelled since the last whole bar boundary. A spike's position inside the
    // window is therefore measured against the row's own two edges, which is what the row is; the canvas edge is an
    // assumption about where a picture begins, and the picture no longer begins there.
    const spikesIn792 = function (frame792) {
      const bars792 = waveBars788(frame792);
      const left792 = bars792.length ? Math.min.apply(null, bars792.map(function (r792) { return r792[0]; })) : 0;
      const right792 = bars792.length ? Math.max.apply(null, bars792.map(function (r792) { return r792[0] + r792[2]; })) : 0;
      const wide792 = right792 - left792;
      const tall792 = bars792.filter(function (r792) { return r792[3] >= 8; });
      const runs792 = [];
      tall792.forEach(function (r792) {
        const last792 = runs792[runs792.length - 1];
        if (last792 && r792[0] - last792.x1 <= 4) { last792.x1 = r792[0] + r792[2]; last792.n++; }
        else runs792.push({ x0: r792[0], x1: r792[0] + r792[2], n: 1 });
      });
      const out792 = runs792.map(function (g792) {
        const f792 = wide792 > 0 ? (g792.x0 - left792) / wide792 : -1;
        return { x0: Math.round(g792.x0 * 100) / 100, bars: g792.n, frac: Math.round(f792 * 1000) / 1000 };
      });
      return { runs: out792, count: out792.length, bars: bars792.length,
        left: Math.round(left792 * 100) / 100, right: Math.round(right792 * 100) / 100 };
    };
    // Where a spike at t would land in a window W seconds wide CENTRED on the moment being heard, or null when
    // the window does not reach it at all -- which is the reading that says a window got shorter. RE-CUT
    // 2026-11-12 by T-809 (operator: "make half the default, remove the setting for it"): a window used to END
    // at the position, and the reading was W = (30 - t) / (1 - f). The panel now looks half a window ahead at
    // every sliding view, so a window of W seconds centred on 30 s spans [30 - W/2, 30 + W/2] and puts a spike
    // at t at fraction (t - (30 - W/2)) / W, which reads back as W = (t - 30) / (f - 0.5). The whole-take
    // picture is the same arithmetic with W = the take's own length: centred on 30 s of a 60 s take it is the
    // take, edge to edge, which is why the control below is asked for at 30 s and not at 60 s.
    const expectFrac792 = function (t792, w792, center792) {
      const left792 = center792 - w792 / 2, right792 = center792 + w792 / 2;
      if (t792 < left792 || t792 > right792 || w792 <= 0) return null;
      return (t792 - left792) / w792;
    };
    const runFor792 = function (sp792, t792, w792, end792) {
      const want792 = expectFrac792(t792, w792, end792);
      if (want792 === null) return null;
      let best792 = null;
      sp792.runs.forEach(function (r792) {
        if (Math.abs(r792.frac - want792) <= 0.05 && (!best792 || Math.abs(r792.frac - want792) < Math.abs(best792.frac - want792))) best792 = r792;
      });
      return best792;
    };
    // The width back out of where a spike landed, against the centred window above. T-809: the reading is
    // (t - centre) / (f - 0.5); a spike exactly at the centre gives no reading (0/0) and is not used.
    const widthFromRun792 = function (t792, center792, run792) {
      if (!run792 || run792.frac < 0 || run792.frac > 1) return null;
      const den792 = run792.frac - 0.5;
      if (Math.abs(den792) < 0.02) return null;
      return Math.round((t792 - center792) / den792 * 100) / 100;
    };
    const w1792 = await mount792('sliding');
    const w2792 = await mount792('sliding2');
    const wf792 = await mount792('full');
    const wD792 = await mount792(null);
    const s1792 = spikesIn792(w1792.frame);
    const s2792 = spikesIn792(w2792.frame);
    const sf792 = spikesIn792(wf792.frame);
    const sD792 = spikesIn792(wD792.frame);
    const r326792 = runFor792(s1792, 32, 6, 30);   // T-809: the second independent reading of the half window
    const r2856792 = runFor792(s1792, 28.5, 6, 30);
    const r2853792 = runFor792(s2792, 28.5, 3, 30);
    const wFrom32792 = widthFromRun792(32, 30, r326792);
    const wFrom285792 = widthFromRun792(28.5, 30, r2856792);
    const wFrom285b792 = widthFromRun792(28.5, 30, r2853792);
    check('T-792 source (operator, verbatim: "the waveform sliding is way too slow, shorten the window: half the current size, AND offer option sliding2 with a quater of current window size"): the window is now a named FRACTION of the size this feature was built at, the base is still in the file so the fraction means something, the default word did not move, and the painter branch asks whether the word in use IS a window instead of naming one word -- a width is decided in one table that both the branch and the window read. RE-CUT 2026-11-13 by T-820 (operator: "add a mode sliding4 and sliding8 to show an even smaller window, resulting in faster movement"): the table names four fractions now and the base, the default word and the single-answer shape this pin is about are unchanged',
      /var SCOPE_WAVE_WINDOW_FRACTIONS792 = \{ sliding: 2, sliding2: 4, sliding4: 8, sliding8: 16 \};/.test(src788)
      && /var SCOPE_WAVE_WINDOW_MS788 = 12000;/.test(src788)
      && /var SCOPE_WAVE_VIEW_DEFAULT788 = "sliding";/.test(src788)
      && /function scopeWaveWindowMs792\(v792\) \{/.test(src788)
      && /function scopeWaveIsWindow792\(v792\) \{/.test(src788)
      && /var winMs788 = Math\.min\(scopeWaveWindowMs792\(scopeWaveView788\(scopeWaveViewRef788\.current\)\), durMs788\);/.test(src788)
      && (src788.match(/scopeWaveIsWindow792\(scopeWaveViewRef788\.current\)\)/g) || []).length === 2,
      { fractions: (src788.match(/SCOPE_WAVE_WINDOW_FRACTIONS792 = \{[^}]*\}/) || [null, 'none'])[0],
        window_branch_sites: (src788.match(/scopeWaveIsWindow792\(scopeWaveViewRef788\.current\)\)/g) || []).length });
    check('T-792 drawing: the window a person gets is the width the drawing says it is, measured back out of where a planted spike lands -- '
      + (wFrom32792 === null ? 'no reading' : wFrom32792 + ' s') + ' for sliding from the 32 s spike, '
      + (wFrom285792 === null ? 'no reading' : wFrom285792 + ' s') + ' for sliding from the 28.5 s spike, and '
      + (wFrom285b792 === null ? 'no reading' : wFrom285b792 + ' s') + ' for sliding2 from the 28.5 s spike. Half of the twelve seconds this feature was built at is six, a quarter is three; the two independent readings of sliding agree with each other and the half is twice the quarter. RE-CUT 2026-11-12 by T-809 (operator: "make half the default, remove the setting for it"): the window is centred on the moment being heard now instead of ending at it, so the arithmetic above is the centred one and the spike that used to give the first reading (26 s) sits outside the window the panel draws. A second spike at 32 s was planted to keep this claim at two independent readings of the half window, which is what it was built to be.',
      wFrom32792 !== null && wFrom285792 !== null && wFrom285b792 !== null
      && Math.abs(wFrom32792 - 6) <= 1 && Math.abs(wFrom285792 - 6) <= 1 && Math.abs(wFrom285b792 - 3) <= 1
      && Math.abs(wFrom32792 - wFrom285792) <= 1 && Math.abs(wFrom32792 / wFrom285b792 - 2) <= 0.35,
      { sliding_from_32s_spike: wFrom32792, sliding_from_28_5s_spike: wFrom285792,
        sliding2_from_28_5s_spike: wFrom285b792, fractions_of_bars: { sliding: s1792.runs, sliding2: s2792.runs },
        ruled: { base_s: 12, sliding_s: 6, sliding2_s: 3 } });
    check('T-792 drawing: the shortening is real, and it is the shortening that was asked for. The 26 s spike sits inside the twelve-second window this feature was BUILT at -- [24,36] s, centred on the position being heard -- and it is OUTSIDE the six-second one this panel draws now -- [27,33] s -- no run of tall bars in that frame matches where a twelve-second window would have put it -- while the half window still shows the 32 s spike and the quarter window no longer does. The same take drawn whole shows every spike, which is what says the fixture is doing the work and not the window. RE-CUT 2026-11-12 by T-809, same operator words as above: the windows moved from ending at the position to centring on it, so which planted spike falls inside which window is restated; the claim -- that a shorter window leaves a spike the longer one drew undrawn -- is the claim this card was asked to prove.',
      runFor792(s1792, 20, 12, 30) === null && runFor792(s2792, 20, 12, 30) === null
      && runFor792(s1792, 26, 12, 30) === null && runFor792(s1792, 26, 6, 30) === null
      && runFor792(s1792, 32, 6, 30) !== null && runFor792(s1792, 28.5, 6, 30) !== null
      && runFor792(s2792, 26, 6, 30) === null && runFor792(s2792, 32, 3, 30) === null
      && runFor792(s2792, 28.5, 3, 30) !== null
      && runFor792(sf792, 20, 60, 30) !== null && runFor792(sf792, 26, 60, 30) !== null
      && runFor792(sf792, 32, 60, 30) !== null
      && runFor792(sf792, 28.5, 60, 30) !== null
      && s1792.count === 2 && s2792.count === 1 && sf792.count === 4 && sD792.count === 2,
      { runs: { sliding: s1792.runs, sliding2: s2792.runs, full: sf792.runs, untouched_panel: sD792.runs },
        planted_at_s: spikeAt792, played_at_s: 30, inside_a_12s_window: [26, 28.5, 32],
        inside_a_6s_window: [28.5, 32], inside_a_3s_window: [28.5] });
    check('T-792: an untouched panel is the half-length window, not the file and not the new quarter -- a panel that was never touched draws the half window and stores no word at all, a stored sliding2 is honoured on the next mount, and adding a third word did not move the default. That is the half of "make the sliding window the default" this card was not asked to change, so it is measured again here rather than assumed',
      wD792.word === 'sliding' && wD792.storeBefore === undefined
      && w1792.word === 'sliding' && w2792.word === 'sliding2' && w2792.storeBefore === 'sliding2' && wf792.word === 'full'
      && sD792.count === s1792.count && sD792.bars >= 40,
      { untouched_word: wD792.word, untouched_stored_before_any_press: wD792.storeBefore,
        stored_by_the_mount_that_was_asked_for: [w1792.storeBefore, w2792.storeBefore, wf792.storeBefore],
        words_after_a_full_ring: [w1792.word, w2792.word, wf792.word],
        bars_drawn_by_untouched_panel: sD792.bars });
    const hover792 = w1792.title;
    check('T-792 hover: the box names every word it offers and says how long each window is, and the numbers it prints are the ones the ruled fractions answer -- the sentences are read off the same function the painter reads, not written next to it, so a later card that moves a window cannot leave the hover describing the old one. RE-CUT 2026-11-13 by T-820 (operator: "add a mode sliding4 and sliding8 to show an even smaller window"): this named three words and the box offers five now; the claim is the same one, measured against the whole list and the four widths it answers',
      /sliding2/.test(hover792) && /\b6 s\b/.test(hover792) && /\b3 s\b/.test(hover792)
      && /sliding4/.test(hover792) && /sliding8/.test(hover792)
      && /\b1\.5 s\b/.test(hover792) && /\b0\.75 s\b/.test(hover792)
      && /whole take/.test(hover792)
      && /Press to cycle sliding, sliding2, sliding4, sliding8, full/.test(hover792),
      { hover_chars: hover792.length, hover: hover792.slice(0, 320) });
    const mark1792 = mark788(w1792.frame), mark2792 = mark788(w2792.frame);
    check('T-792 drawing: what makes a window move is untouched by its width -- in both windows the moment being heard is the MIDDLE of the bars, at the half window and at the quarter, so a shorter window does not move the head off the position a person is hearing. RE-CUT 2026-11-12 by T-809 (operator: "make half the default, remove the setting for it"): the head sat at the RIGHT edge of the bars while no look-ahead existed; the panel looks half a window ahead at either width now, and the head holds the middle of the bars at both',
      Math.abs(mark1792 - s1792.right * 0.5) <= 6 && Math.abs(mark2792 - s2792.right * 0.5) <= 6 && Math.abs(mark1792 - mark2792) <= 1,
      { mark_half_window: mark1792, mark_quarter_window: mark2792, bars_right_edge: [s1792.right, s2792.right] });
    console.log('  MEASURE T-792 window widths read back off the drawing: sliding '
      + [wFrom32792, wFrom285792].join(' / ') + ' s from the 32 s and 28.5 s spikes, sliding2 '
      + wFrom285b792 + ' s from the 28.5 s spike (ruled 6 s and 3 s against a 12 s base) | tall-bar runs per word '
      + [s1792.count, s2792.count, sf792.count].join(' ') + ' for sliding / sliding2 / full at played 30 s of 60 s'
      + ' | bars in frame ' + [s1792.bars, s2792.bars, sf792.bars].join(' ') + ' | play head '
      + [mark1792, mark2792].join(' ') + ' against the middle of the bar row ' + [s1792.right / 2, s2792.right / 2].join(' '));


    // ── T-820 (2026-11-13): two narrower windows, and the strip actually moving ─────────────────────────
    // The operator's words, verbatim: "the sliding window still looks laggy, maybe add a mode sliding4 and sliding8
    // to show an even smaller window, resulting in faster movement". Two things are measured here and they are
    // different things. First the WIDTHS, read back off the drawing the way T-792 reads the two it asked for: a take
    // that is otherwise quiet, spikes planted on exact bucket boundaries (this fixture's buckets are a quarter of a
    // second apart, so 29.75 s and 30.25 s are where the drawing can be told), played at 30 s, and the window's
    // length derived from where a spike lands: W = (t − 30) / (f − 0.5). Two independent readings per word. The
    // quantisation this fixture carries is barMs/window in the fraction, which at these widths is 0.015 of the row:
    // 0.13 s of error on the 1.5 s reading and 0.03 s on the 0.75 s one, well inside the half-second tolerance. The
    // same two spikes against the 6 s window would carry 2 s of error, which is why they are not used for it — T-792's
    // own spikes measure that one.
    // Second the MOTION, which is what the word "laggy" is about and which no width changes: until this card the
    // bars were laid on fixed pixel slots and only their heights were re-sampled, so the leftmost bar of a window row
    // sat at x = 0 in every frame, at every position, forever. A row anchored to the take's timeline cannot do that:
    // its first bar is clipped at the left edge by the fraction of a bar the window has travelled since the last
    // whole bar boundary, and that offset grows as the take plays. That is measured below at two positions 0.03 s
    // apart, in units of the bar step read out of the drawing itself.
    const pk820 = [];
    for (let i820 = 0; i820 < 240; i820++) {
      const bs820 = Math.sin(i820 / 9) * 0.16;
      pk820.push({ max: bs820 > 0 ? bs820 : 0, min: bs820 < 0 ? bs820 : 0 });
    }
    [29.75, 30.25].forEach(function (t820) {
      // ONE bucket each, on purpose. A spike here is two buckets wide and the 0.75 s window is three buckets long, so
      // two two-bucket spikes are neighbours, the run grouping merges neighbours, and the two readings collapse into
      // one — which is what this fixture's first run produced. One bucket each, with a bucket of quiet between them,
      // is what makes them two separate pictures at every width.
      const bk820 = Math.round(t820 * 4);
      pk820[bk820] = { max: 1, min: -1 };
    });
    const w4820 = await mount792('sliding4', pk820);
    const w8820 = await mount792('sliding8', pk820);
    const s4820 = spikesIn792(w4820.frame);
    const s8820 = spikesIn792(w8820.frame);
    const r4a820 = runFor792(s4820, 29.75, 1.5, 30), r4b820 = runFor792(s4820, 30.25, 1.5, 30);
    const r8a820 = runFor792(s8820, 29.75, 0.75, 30), r8b820 = runFor792(s8820, 30.25, 0.75, 30);
    const w4a820 = widthFromRun792(29.75, 30, r4a820), w4b820 = widthFromRun792(30.25, 30, r4b820);
    const w8a820 = widthFromRun792(29.75, 30, r8a820), w8b820 = widthFromRun792(30.25, 30, r8b820);
    check('T-820 drawing (operator, verbatim: "maybe add a mode sliding4 and sliding8 to show an even smaller window, resulting in faster movement"): the two new windows are the widths their words say, read back off the drawing and not off the constants — two independent readings each, from spikes planted a quarter of a second either side of the moment being heard, and the narrower one is half the wider one',
      w4a820 !== null && w4b820 !== null && w8a820 !== null && w8b820 !== null
      && Math.abs(w4a820 - 1.5) <= 0.5 && Math.abs(w4b820 - 1.5) <= 0.5
      && Math.abs(w8a820 - 0.75) <= 0.5 && Math.abs(w8b820 - 0.75) <= 0.5
      && Math.abs(w4a820 - w4b820) <= 0.5 && Math.abs(w8a820 - w8b820) <= 0.5
      && Math.abs(w4a820 / w8a820 - 2) <= 0.35,
      { sliding4_from_29_75s: w4a820, sliding4_from_30_25s: w4b820,
        sliding8_from_29_75s: w8a820, sliding8_from_30_25s: w8b820,
        ruled: { base_s: 12, sliding_s: 6, sliding2_s: 3, sliding4_s: 1.5, sliding8_s: 0.75 } });
    check('T-820 drawing: a narrower window is a SHORTER slice of the take, not a denser strip — the bar count in the frame is the same at every width, because the bars this mode fits come from the canvas and the card changed the window, not the bar',
      s4820.bars === s8820.bars && s4820.bars >= 40 && s8820.bars >= 40,
      { bars_in_frame: { sliding4: s4820.bars, sliding8: s8820.bars },
        tall_runs: { sliding4: s4820.count, sliding8: s8820.count } });
    // The motion measurement. The bar step is read out of the drawing — the smallest gap between two bar positions —
    // so the claim is stated in bars, which is the unit the picture is made of, and not in pixels of a canvas whose
    // width this fixture does not own.
    const stepOf820 = function (bars820) {
      const xs820 = Array.from(new Set(bars820.map(function (r820) { return Math.round(r820[0] * 100) / 100; })))
        .sort(function (a820, b820) { return a820 - b820; });
      let st820 = 0;
      for (let i820 = 1; i820 < xs820.length; i820++) {
        const d820 = xs820[i820] - xs820[i820 - 1];
        if (d820 > 0.5 && (st820 === 0 || d820 < st820)) st820 = d820;
      }
      return st820;
    };
    const rowLeft820 = function (frame820) {
      const bs820 = waveBars788(frame820);
      return { left: bs820.length ? Math.min.apply(null, bs820.map(function (r820) { return r820[0]; })) : 0,
        bars: bs820.length, step: stepOf820(bs820) };
    };
    const wM820 = await mount792('sliding', pk820);
    const rowA820 = rowLeft820(wM820.frame);
    const markB820 = wM820.br.rectLog.length;
    if (wM820.el) {
      wM820.el.duration = 60; wM820.el.currentTime = 30.03;
      if (typeof wM820.el.ontimeupdate === 'function') { wM820.el.ontimeupdate(); }
    }
    wM820.m.commit(); await flush();
    const rowB820 = rowLeft820(wM820.br.rectLog.slice(markB820));
    const wantShift820 = -(0.03 / 6) * rowA820.bars;   // bars the window travels in 30 ms of a 6 s window
    const gotShift820 = rowB820.step > 0 ? (rowB820.left - rowA820.left) / rowB820.step : 0;
    check('T-820 drawing (operator: "the sliding window still looks laggy"): the bar row is anchored to the take\'s timeline, so it moves. At the first position the leftmost bar is drawn OFF the left edge of the canvas — between zero and one bar width off, which is the fraction of a bar the window has travelled and is something this drawing could not do before this card, where the first bar sat at x = 0 in every frame at every position. Move the take 0.03 s and the whole row moves left with it, by the share of a bar 30 ms of a 6 s window is',
      rowA820.step > 0 && rowA820.bars >= 40 && rowB820.bars >= 40
      && rowA820.left < -0.1 * rowA820.step && rowA820.left > -1.1 * rowA820.step
      && rowB820.left < rowA820.left
      && Math.abs(gotShift820 - wantShift820) <= 0.35 * Math.abs(wantShift820) + 0.15,
      { row_left_edge_at_30_00s: Math.round(rowA820.left * 100) / 100,
        row_left_edge_at_30_03s: Math.round(rowB820.left * 100) / 100,
        bar_step_px: Math.round(rowA820.step * 100) / 100, bars: rowA820.bars,
        shift_wanted_bars: Math.round(wantShift820 * 1000) / 1000,
        shift_measured_bars: Math.round(gotShift820 * 1000) / 1000,
        note: 'before this card row_left_edge was 0 at every position and the shift was a whole number of bars or nothing' });
    check('T-820 source: the window words and their fractions, the floor that lets a window be shorter than two seconds, and the painter that anchors a bar to the time it measures instead of to the window edge',
      /var SCOPE_WAVE_VIEW_OPTS788 = \["sliding", "sliding2", "sliding4", "sliding8", "full"\];/.test(src788)
      && /var SCOPE_WAVE_WINDOW_FRACTIONS792 = \{ sliding: 2, sliding2: 4, sliding4: 8, sliding8: 16 \};/.test(src788)
      && /var SCOPE_WAVE_WINDOW_MIN_MS788 = 750;/.test(src788)
      && /var SCOPE_WAVE_VIEW_DEFAULT788 = "sliding";/.test(src788)
      && /var barMs788 = span788 \/ fit788;/.test(src788)
      && /var slot788 = first788 \+ b788;/.test(src788)
      && /var t0788 = slot788 \* barMs788;/.test(src788)
      && /var x788 = \(b788 - frac788\) \* step788;/.test(src788)
      && /g\.fillRect\(x788, hi788, bw788, lo788 - hi788 \+ 1\);/.test(src788)
      && !/g\.fillRect\(b788 \* \(bw788 \+ gap788\)/.test(src788),
      { fractions: (src788.match(/SCOPE_WAVE_WINDOW_FRACTIONS792 = \{[^}]*\}/) || [null, 'none'])[0],
        window_floor_ms: (src788.match(/SCOPE_WAVE_WINDOW_MIN_MS788 = (\d+)/) || [null, 'none'])[1] });
    check('T-820 source: the sub-bar offset is not gated by anything a reader can set — it is part of the one window painter every sliding word draws through, and the look-ahead and the play-head rule that put the heard moment in the middle of the strip are untouched',
      (src788.match(/var frac788 = barMs788 > 0 \?/g) || []).length === 1
      && (src788.match(/scopeWaveWindowFrame788\(g, W, barH, scopePeaks300\.current\)/g) || []).length === 2
      && /var SCOPE_WAVE_LEAD_FRAC793 = 0\.5;/.test(src788)
      && /var mkx788 = Math\.round\(\(span788 > 0 \? \(\(pos788 \* durMs788 - left788\) \/ span788\)/.test(src788),
      { offset_sites: (src788.match(/var frac788 = barMs788 > 0 \?/g) || []).length,
        window_paint_call_sites: (src788.match(/scopeWaveWindowFrame788\(g, W, barH, scopePeaks300\.current\)/g) || []).length });
    console.log('  MEASURE T-820: windows read back off the drawing — sliding4 '
      + [w4a820, w4b820].join(' / ') + ' s from the 29.75 s and 30.25 s spikes, sliding8 '
      + [w8a820, w8b820].join(' / ') + ' s (ruled 1.5 s and 0.75 s against the same 12 s base) | bars per row '
      + [s4820.bars, s8820.bars].join(' ') + ' | row left edge '
      + [rowA820.left, rowB820.left].map(function (v820m) { return Math.round(v820m * 100) / 100; }).join(' -> ')
      + ' px across 0.03 s of play, bar step ' + Math.round(rowA820.step * 100) / 100 + ' px, shift measured '
      + Math.round(gotShift820 * 1000) / 1000 + ' bars against ' + Math.round(wantShift820 * 1000) / 1000
      + ' wanted | scroll rate at these widths ' + Math.round(196 / 6) + ' / ' + Math.round(196 / 3) + ' / '
      + Math.round(196 / 1.5) + ' / ' + Math.round(196 / 0.75) + ' px per second for 6 / 3 / 1.5 / 0.75 s');


    // T-789: the spectrum's own second setting, and the fire this mode keeps.
    check('T-789 source (operator, verbatim: "remove \"flame-body option\" and maybe \"optimise\" the fire option with some longer lasting afterglow and rising sparks on peaks to look more like a fireplace", card answer "keep fireplace, improve it"): the spectrum row owns its colour vocabulary as a list and a default, its default is unchanged, and the fireplace carries the longer afterglow it was asked for -- the old values are named in the comments beside the new ones -- with the spark bounds declared next to them. RE-CUT 2026-11-11 by T-793 (operator: "now the spectrum analyser only has two color settings: i expected more", card answer "Give it the ramps the panel already has"): this pin named the two words that card left in place; the row carries six now. What T-789 is about -- the default first, the fire word second, and every fireplace constant -- is unchanged and is still pinned here',
      /var SCOPE_SCHEME_OPTS_BY_MODE539 = \{ spectrum: \["green", "fireplace", "white", "flames", "ironbow", "cold"\]/.test(src788)
      && /var SCOPE_SCHEME_DEFAULT_BY_MODE539 = \{ spectrum: "green"/.test(src788)
      && /var FIREPLACE_DECAY600 = 0\.94;/.test(src788) && /was 0\.86/.test(src788)
      && /var FIREPLACE_PLUME600 = 0\.60;/.test(src788) && /was 0\.45/.test(src788)
      && /var FIREPLACE_SPARK_MIN_FRAC600 = 0\.30;/.test(src788)
      && /var FIREPLACE_SPARK_MAX600 = 4;/.test(src788),
      { spectrum_words: (src788.match(/spectrum: \[([^\]]*)\]/) || [null, 'none'])[1] });

    const pk789 = [];
    for (let j789 = 0; j789 < 240; j789++) {
      const w789 = Math.sin(j789 / 9) * (j789 < 120 ? 0.72 : 0.18);
      pk789.push({ max: w789 > 0 ? w789 : 0, min: w789 < 0 ? w789 : 0 });
    }
    // T-793: the optional second argument names the dB ceiling the analyser of this mount reports. Left out it is
    // the -30 dB window every other mount in this file has always been handed, and nothing about them changes.
    const mountSpec789 = async function (storage789, maxDb789) {
      const br789 = makeBrowser({ storage: storage789 });
      if (typeof maxDb789 === 'number') br789.anMaxDb = maxDb789;
      const mt789 = await mount(br789, {
        canvas2d: true, audioTracks: 1, peaks: pk789, channels: 1, sampleRate: 48000, bytes: 165120, items: item788,
      });
      mt789.commit(); await flush();
      await openAllSections(mt789.shim, mt789.comp);
      mt789.commit(); await flush();
      const aud789 = mt789.shim.rt.created.filter(function (e789) { return e789.type === 'audio'; });
      const el789 = aud789.length ? aud789[0].props.ref.current : null;
      const play789 = mt789.created().filter(function (e789) {
        return e789.type === 'button' && /play the row the transport is on/.test(String(e789.props && e789.props.title));
      }).pop();
      if (play789) { play789.props.onClick(); await flush(); mt789.commit(); await flush(); }
      mt789.armAudio(1);
      if (el789) { el789.duration = 60; el789.currentTime = 30; el789.fire('timeupdate'); }
      return { br: br789, m: mt789, el: el789 };
    };
    const p789 = await mountSpec789({ 'deepamp:scope.mode': 'spectrum' });
    const lBox789 = function () { return p789.m.els('audio-play-scope-leds789')[0]; };
    const lWord789 = function () { return p789.m.ownText(lBox789()); };
    const lWalk789 = [lWord789()]; const lStored789 = [p789.br.store['deepamp:scope.spectrum.leds789']];
    for (let s789 = 0; s789 < 5; s789++) {
      lBox789().props.onClick(); p789.m.commit(); await flush();
      lWalk789.push(lWord789()); lStored789.push(p789.br.store['deepamp:scope.spectrum.leds789']);
    }
    check('T-789 control (operator: "the spectrum analyser should get a first setting switch option aswell to adjust the amount/resolution of LEDs we display - add some lower res settings"): the spectrum row carries ONE LED-resolution box in the whole panel, it prints auto on a panel that was never touched and stores nothing, and the press walks auto -> 5 -> 8 -> 12 -> 16 -> back to auto while writing each word it lands on',
      p789.m.els('audio-play-scope-leds789').length === 1
      && lWalk789.join(',') === 'auto,5,8,12,16,auto'
      && lStored789[0] === undefined && lStored789.slice(1).join(',') === '5,8,12,16,auto',
      { cells: p789.m.els('audio-play-scope-leds789').length, cycle: lWalk789, stored: lStored789 });

    const b789a = await mountSpec789({ 'deepamp:scope.mode': 'spectrum' });
    b789a.br.frames(4);
    const b789b = await mountSpec789({ 'deepamp:scope.mode': 'spectrum', 'deepamp:scope.spectrum.leds789': '5' });
    b789b.br.frames(4);
    const b789c8 = await mountSpec789({ 'deepamp:scope.mode': 'spectrum', 'deepamp:scope.spectrum.leds789': '8' });
    b789c8.br.frames(3);
    const b789d8 = await mountSpec789({ 'deepamp:scope.mode': 'spectrum', 'deepamp:scope.spectrum.leds789': '12' });
    b789d8.br.frames(3);
    const b789e = await mountSpec789({ 'deepamp:scope.mode': 'spectrum', 'deepamp:scope.spectrum.leds789': '16' });
    b789e.br.frames(3);
    const specWidths789 = function (log789) {
      const rows789 = log789.filter(function (r789) {
        // Only drawings under the strip's own translate (the clock band and the playlist's own little waveform are
        // drawn without it). The peak cap is level history and is told apart by its colour, the frame lines by
        // their width. What is left is bar geometry.
        return r789[4] !== 0 && r789[3] > 0 && r789[3] <= 3 && r789[2] >= 5 && r789[2] <= 90
          && r789[5] !== '#e8e8e8';
      });
      const ws789 = {};
      rows789.forEach(function (r789) { ws789[Math.round(r789[2] * 100) / 100] = (ws789[Math.round(r789[2] * 100) / 100] || 0) + 1; });
      return { widths: Object.keys(ws789).map(Number).sort(function (a789, b789) { return a789 - b789; }),
        rows: rows789.length };
    };
    // A bar's width is the layout said out loud: bw = (inner - (n-1)*gap) / n over the 196 px the inset leaves
    // inside the 200 px canvas, with the strip's own 1 px gap. Reading the width is reading the bar count, and it
    // does not depend on how many of those bars the mock's analyser happens to give a reading to - a bar with no
    // reading in it draws nothing, which is the rule this strip has always had.
    const specExpectedWidth789 = function (n789) {
      return Math.round(((196 - (n789 - 1) * 1) / n789) * 100) / 100;
    };
    const wAuto789 = specWidths789(b789a.br.rectLog);
    const w5789 = specWidths789(b789b.br.rectLog);
    const w8789 = specWidths789(b789c8.br.rectLog);
    const w12789 = specWidths789(b789d8.br.rectLog);
    const w16789 = specWidths789(b789e.br.rectLog);
    check('T-789 drawing (operator: "the spectrum analyser should get a first setting switch option aswell to adjust the amount/resolution of LEDs we display - add some lower res settings"): every word that box offers redraws the strip at the geometry its word says. auto keeps the layout the mode has always had - twenty bars of 8.85 px across 196 px, which is SCOPE_BANDS300 laid out as it fits - and 5, 8, 12, 16 each draw bars exactly as wide as their own count implies, no more bars than the analyser is read at, and each bar wider for the space the bars it replaced gave up',
      wAuto789.widths.length === 1 && Math.abs(wAuto789.widths[0] - specExpectedWidth789(20)) < 0.02
      && [5, 8, 12, 16].every(function (n789x, i789x) {
        const got789x = [w5789, w8789, w12789, w16789][i789x];
        return got789x.widths.length === 1 && Math.abs(got789x.widths[0] - specExpectedWidth789(n789x)) < 0.02;
      }),
      { auto: wAuto789.widths, five: w5789.widths, eight: w8789.widths, twelve: w12789.widths,
        sixteen: w16789.widths, expected: [20, 5, 8, 12, 16].map(specExpectedWidth789) });
    // The order the widths must fall in: fewer bars means WIDER bars, so the widths run the opposite way to the
    // words. auto (twenty bars) is the narrowest the strip ever draws and 5 is the widest a word in that list can
    // make it. A word never invents a bar the analyser does not have, so nothing in the list is wider than five.
    check('T-789 drawing: the word is a CEILING on the bars, never a floor - no word in that list names more bars than the strip is read at (SCOPE_BANDS300, twenty bands), and the widest bars the setting can produce are the five-bar layout. Fewer bars means wider bars, in order, with nothing between the offered words',
      wAuto789.widths[0] < w16789.widths[0] && w16789.widths[0] < w12789.widths[0]
      && w12789.widths[0] < w8789.widths[0] && w8789.widths[0] < w5789.widths[0]
      && wAuto789.rows > 0 && w5789.rows > 0,
      { widths_by_word: { auto_20_bars: wAuto789.widths[0], w16: w16789.widths[0], w12: w12789.widths[0],
        w8: w8789.widths[0], w5: w5789.widths[0] } });

    const sparks789 = function (frame789) {
      return frame789.filter(function (r789) {
        return r789[2] === 2 && r789[3] === 2 && /^rgba\(/.test(String(r789[5] || ''));
      }).length;
    };
    const b789c = await mountSpec789({ 'deepamp:scope.mode': 'spectrum', 'deepamp:scope.schemes': '{"spectrum":"fireplace"}' });
    b789c.br.hotBins = [2]; b789c.br.hotBinValue = 40;
    b789c.br.frames(26);
    const s789LowA = sparks789(b789c.br.rectLog.slice(b789c.br.rectLog.length - 200));
    b789c.br.frames(2);
    const s789LowB = sparks789(b789c.br.rectLog.slice(b789c.br.rectLog.length - 200));
    b789c.br.hotBinValue = 255;
    b789c.br.frames(1);
    const s789Rise = sparks789(b789c.br.rectLog.slice(b789c.br.rectLog.length - 200));
    b789c.br.frames(1);
    const s789Steady = sparks789(b789c.br.rectLog.slice(b789c.br.rectLog.length - 200));
    check('T-789 drawing (operator: "rising sparks on peaks to look more like a fireplace"): a spark is born only on a READING THAT RISES and only on a bar that is already burning -- a level held low across frames throws none, and the same bar pushed to the top of the window throws them. Held steady afterwards, the count does not grow: the sparks that are already up finish their own fall',
      s789LowB === s789LowA && s789Rise > s789LowB && s789Steady <= s789Rise,
      { sparks_low_first_frame: s789LowA, sparks_low_after_28_frames: s789LowB,
        sparks_on_the_rise: s789Rise, sparks_next_steady_frame: s789Steady });
    const b789d = await mountSpec789({ 'deepamp:scope.mode': 'spectrum' });
    b789d.br.hotBins = [2]; b789d.br.hotBinValue = 255;
    b789d.br.frames(3);
    const plume789 = function (frame789) {
      return frame789.filter(function (r789) {
        return r789[3] > 0 && r789[3] <= 3 && r789[2] > 3 && r789[2] <= 12 && /^rgba\(/.test(String(r789[5] || ''));
      }).length;
    };
    const plumeGreen789 = plume789(b789d.br.rectLog.slice(b789d.br.rectLog.length - 200));
    const plumeFire789 = plume789(b789c.br.rectLog.slice(b789c.br.rectLog.length - 200));
    check('T-789 drawing (operator: "maybe optimise the fire option with some longer lasting afterglow"): the word this mode keeps paints a PLUME above the reading -- rows drawn through an alpha, above the top of the bars -- where the word it kept from before paints none. The body of the flame is measured by the T-600 pins above; this is the half this card changed',
      plumeGreen789 === 0 && plumeFire789 > 40,
      { alpha_rows_under_green: plumeGreen789, alpha_rows_under_fireplace: plumeFire789 });

    // ── T-793 (2026-11-11): the spectrum's colour words are extended with the ramps the panel already has ─────
    // The operator's word, verbatim: "now the spectrum analyser only has two color settings: i expected more", and
    // the card answer to the question put: "Give it the ramps the panel already has". What is measured below is the
    // colour of every segment of every bar, read off the drawings, against the ramp the word names -- computed from
    // the geometry of the drawing itself, not from what the source says it would do. Each bar's baseline is taken
    // from the bottom edge of its own lowest segment, so a segment's own height comes out of the picture: a rect
    // drawn at (y, h) whose bar base is B sits at (B - y - h + SEGMENT_H) / B of a full bar. The claim is exact
    // equality with the ramp value at that height, which is what "read by each segment's own height" means when it
    // is a fact about a picture rather than a sentence about a file.
    const takeConst793 = function (head793) {
      const i793 = src788.indexOf(head793);
      if (i793 < 0) return '';
      const j793 = src788.indexOf('];', i793);
      return src788.slice(i793, j793 + 2);
    };
    const rampOf793 = new Function(
      takeConst793('var SCOPE_FLAME_STOPS540 = [') + '\n'
      + takeConst793('var SCOPE_IRONBOW_STOPS541 = [') + '\n'
      + takeConst793('var SCOPE_COLD_STOPS541 = [') + '\n'
      + takeConst793('var SCOPE_GREEN_RAMP541 = [') + '\n'
      + src788.slice(src788.indexOf('function scopeRampColour541'), src788.indexOf('function scopeFlameColour540'))
      + '\nreturn function (w793, f793) { return scopeRampColour541(w793 === "ironbow" ? SCOPE_IRONBOW_STOPS541'
      + ' : (w793 === "cold" ? SCOPE_COLD_STOPS541 : (w793 === "green" ? SCOPE_GREEN_RAMP541 : SCOPE_FLAME_STOPS540)), f793); };'
    )();
    const inkConst793 = function (name793) {
      const mm793 = src788.match(new RegExp('var ' + name793 + ' = "([^"]+)"'));
      return mm793 ? mm793[1] : null;
    };
    const LADDER793 = [inkConst793('SCOPE_GREEN300'), inkConst793('SCOPE_YELLOW300'), inkConst793('SCOPE_RED300')];
    const FLAT793 = inkConst793('SCOPE_SCHEME_WHITE536') || inkConst793('SCOPE_CAP300');
    const SEG_H793 = Number((src788.match(/var SCOPE_SEGMENT_H300 = (\d+)/) || [0, '3'])[1]);
    // Bar segments only: this mode's bars are between 3 and 12 px wide and a segment is at most SEGMENT_H tall. The
    // peak-hold cap shares a bar's x and width and is drawn in the flat cap colour, so under the ramp words it is
    // outside the rgb() set this block reads, and under the flat word it is the same colour as the bars themselves.
    const barSegs793 = function (frame793) {
      const out793 = [];
      frame793.forEach(function (r793) {
        if (!(r793[2] > 3 && r793[2] <= 12)) return;
        if (!(r793[3] >= 1 && r793[3] <= 3)) return;
        out793.push({ x: Math.round(r793[0] * 100) / 100, w: r793[2], h: r793[3], ink: String(r793[5] || ''),
          bottom: r793[1] + r793[3], band: Number(r793[4]) || 0 });
      });
      return out793;
    };
    const spec793 = async function (word793) {
      const st793 = { 'deepamp:scope.mode': 'spectrum' };
      if (word793) st793['deepamp:scope.schemes'] = '{"spectrum":"' + word793 + '"}';
      const mm793 = await mountSpec789(st793, 0);
      // Every band gets a hot bin and every hot bin sits at the ceiling of the analyser's byte scale, so the bars
      // measured here are tall bars -- the only kind that can show where a ramp ends. The mock's own window is
      // -100 dB to -30 dB and the panel maps a bar over -70 dB to 0 dB (SCOPE_FLOOR_DB300 to SCOPE_TOP_DB300), so
      // a byte of 255 inside that window tops out at 0.57 of a bar and no bar ever reaches its tip. The panel
      // reads the analyser's window afresh in every frame, so widening the window this fixture hands it is the
      // honest way to drive a bar to full height: it is the same number the painter reads, not a fixture rewrite.
      mm793.br.hotBins = []; for (let k793 = 0; k793 < 40; k793++) mm793.br.hotBins.push(k793);
      mm793.br.hotBinValue = 255;
      mm793.br.frames(4);
      const ac793 = mm793.br.audioCtx;
      const an793 = (ac793 && ac793.an)
        ? { min_db: ac793.an.minDecibels, max_db: ac793.an.maxDecibels } : null;
      mm793.br.frames(4);
      const n793 = mm793.br.rectLog.length;
      mm793.br.frames(1);
      const frame793 = mm793.br.rectLog.slice(n793);
      const cell793 = mm793.m.els('audio-play-scope-scheme536')[0];
      const segs793 = barSegs793(frame793);
      const cols793 = {};
      segs793.forEach(function (s793) { (cols793[s793.x] = cols793[s793.x] || []).push(s793); });
      let tallest793 = [];
      Object.keys(cols793).forEach(function (k793) { if (cols793[k793].length > tallest793.length) tallest793 = cols793[k793]; });
      const inks793 = {};
      segs793.forEach(function (s793) { inks793[s793.ink] = (inks793[s793.ink] || 0) + 1; });
      return { m: mm793, frame: frame793, segs: segs793, tallest: tallest793, inks: inks793, window: an793,
        word: cell793 ? mm793.m.ownText(cell793) : '', title: cell793 ? String((cell793.props || {}).title || '') : '' };
    };
    // The exact claim, per word: every segment drawn in a ramp colour is that ramp's value at that segment's own
    // height, where the height is measured out of the picture. base793 is the baseline every bar stands on.
    const rampTruth793 = function (word793, sp793) {
      const rgb793 = sp793.segs.filter(function (s793) { return /^rgb\(/.test(s793.ink); });
      const base793 = rgb793.length ? Math.max.apply(null, rgb793.map(function (s793) { return s793.bottom; })) : 0;
      const off793 = [];
      let tops793 = [];
      rgb793.forEach(function (s793) {
        const top793 = base793 > 0 ? (base793 - s793.bottom + SEG_H793) / base793 : 0;
        const want793 = rampOf793(word793, top793);
        tops793.push(top793);
        if (want793 !== s793.ink && off793.length < 4) {
          off793.push({ at_height_of_bar: Math.round(top793 * 1000) / 1000, drew: s793.ink, ramp_says: want793 });
        }
      });
      const tallInks793 = {};
      sp793.tallest.forEach(function (s793) { if (/^rgb\(/.test(s793.ink)) tallInks793[s793.ink] = 1; });
      const ladderSeen793 = LADDER793.filter(function (c793) { return sp793.inks[c793]; });
      return { rgbSegs: rgb793.length, base: Math.round(base793 * 100) / 100, offByRamp: off793,
        distinctInOneBar: Object.keys(tallInks793).length, distinctInFrame: Object.keys(sp793.inks).length,
        ladderInkSeen: ladderSeen793, tallestSegs: sp793.tallest.length, analyser_window: sp793.window,
        topOfTallestBar: Math.round(Math.max.apply(null, tops793 || [0]) * 100) / 100 };
    };
    const sGreen793 = await spec793('');
    const sFire793 = await spec793('fireplace');
    const sWhite793 = await spec793('white');
    const sFlames793 = await spec793('flames');
    const sIron793 = await spec793('ironbow');
    const sCold793 = await spec793('cold');
    const tIron793 = rampTruth793('ironbow', sIron793);
    const tCold793 = rampTruth793('cold', sCold793);
    const tFlames793 = rampTruth793('flames', sFlames793);
    const barInks793 = function (sp793) { return Object.keys(sp793.inks); };
    const cleanOf793 = function (sp793) { return LADDER793.filter(function (c793) { return sp793.inks[c793]; }).length; };
    check('T-793 source (card answer "Give it the ramps the panel already has"): the bargraph painter now resolves a named ramp through the table the waterfall, the llama, the waveform and the knight bars already read, `green` is held out of that lookup so the default keeps painting the banded ladder, `white` is flat on purpose, and the flame special case that used to sit in that expression is gone because the table\'s own flames entry is the same stops through the same function',
      /var ramp601 = \(palette539 === "green"\) \? null : \(SCOPE_WF_RAMPS541\[palette539\] \|\| null\);/.test(src788)
      && /var flat601 = \(palette539 === "white"\) \? SCOPE_SCHEME_WHITE536 : null;/.test(src788)
      && /g\.fillStyle = flat601 \? flat601\n?\s*: \(ramp601 \? scopeRampColour541\(ramp601, top\)/.test(src788)
      && !/palette539 === "flames"/.test(src788.slice(src788.indexOf('function scopeBar300'), src788.indexOf('function scopeKnightBars601')))
      && (src788.match(/scopeFlameColour540\(/g) || []).length >= 2,
      { bar_fn_flames_branches: (src788.slice(src788.indexOf('function scopeBar300'), src788.indexOf('function scopeKnightBars601')).match(/palette539 ===/g) || []).length,
        flame_colour_calls_elsewhere: (src788.match(/scopeFlameColour540\(/g) || []).length });
    check('T-793 drawing: the default did not move. A panel that was never touched still paints the banded bargraph -- '
      + LADDER793.join(' / ') + ', body then upper third then tip -- and no ramp colour reached it. The only other ink in that frame is the peak-hold cap this mode has drawn in the flat cap colour since the bargraph existed; it is named here rather than filtered out of the count, because it is part of the picture a person sees',
      sGreen793.segs.length > 40 && cleanOf793(sGreen793) === 3
      && Object.keys(sGreen793.inks).every(function (c793) { return LADDER793.indexOf(c793) >= 0 || c793 === FLAT793; })
      && !Object.keys(sGreen793.inks).some(function (c793) { return /^rgb\(/.test(c793); }),
      { inks_under_green: barInks793(sGreen793), cap_ink: FLAT793, segments: sGreen793.segs.length,
        word_shown: sGreen793.word, analyser_window: sGreen793.window });
    check('T-793 drawing: the flat word is flat -- every bar segment carries the strip\'s own near-white and nothing else, no ramp colour and none of the ladder colours. Stated plainly because the near-white is also the colour of the peak-hold cap this mode draws: on this word the cap and the bars are the same ink, which is what the word asks for and not a leak',
      sWhite793.segs.length > 40 && sWhite793.inks[FLAT793] === sWhite793.segs.length && cleanOf793(sWhite793) === 0
      && !Object.keys(sWhite793.inks).some(function (c793) { return /^rgb\(/.test(c793); }),
      { flat_ink: FLAT793, inks_under_white: barInks793(sWhite793), segments: sWhite793.segs.length });
    const rampClaim793 = function (word793, sp793, t793) {
      return function () {
        return sp793.segs.length > 40 && t793.rgbSegs > 40 && t793.offByRamp.length === 0
          && t793.ladderInkSeen.length === 0 && t793.distinctInOneBar >= 4 && t793.topOfTallestBar > 0.8;
      };
    };
    check('T-793 drawing, ironbow: every segment of every bar is the ironbow ramp AT THAT SEGMENT\'S OWN HEIGHT, measured out of the picture (the baseline is the bottom edge of the lowest segment, '
      + tIron793.base + ' px), and a single bar carries ' + tIron793.distinctInOneBar + ' different colours where the banded ladder could carry at most three. No ladder colour appears anywhere in the frame',
      rampClaim793('ironbow', sIron793, tIron793)(),
      { segments_read: tIron793.rgbSegs, bar_baseline_px: tIron793.base, segments_off_the_ramp: tIron793.offByRamp,
        distinct_colours_in_the_tallest_bar: tIron793.distinctInOneBar, ladder_ink_seen: tIron793.ladderInkSeen,
        tallest_bar_segments: tIron793.tallestSegs, top_of_tallest_bar: tIron793.topOfTallestBar });
    check('T-793 drawing, cold: the same reading against the cold ramp -- deep blue at the foot of a bar through cyan into near-white at its tip, and every segment matches it at its own height with no ladder colour in the frame',
      rampClaim793('cold', sCold793, tCold793)(),
      { segments_read: tCold793.rgbSegs, bar_baseline_px: tCold793.base, segments_off_the_ramp: tCold793.offByRamp,
        distinct_colours_in_the_tallest_bar: tCold793.distinctInOneBar, ladder_ink_seen: tCold793.ladderInkSeen,
        analyser_window: tCold793.analyser_window, bar_segments_seen: sCold793.segs.length,
        top_of_tallest_bar: tCold793.topOfTallestBar });
    check('T-793 drawing, flames: the word this row had before T-789 took it out is back, and it paints what it painted then -- every segment matches the shared flame ramp at its own height. That is also the proof that dropping the special case out of the painter changed nothing: the table\'s own flames entry is the same stops through the same function this card reads here',
      rampClaim793('flames', sFlames793, tFlames793)(),
      { segments_read: tFlames793.rgbSegs, bar_baseline_px: tFlames793.base, segments_off_the_ramp: tFlames793.offByRamp,
        distinct_colours_in_the_tallest_bar: tFlames793.distinctInOneBar, ladder_ink_seen: tFlames793.ladderInkSeen,
        top_of_tallest_bar: tFlames793.topOfTallestBar });
    const sets793 = { green: barInks793(sGreen793), white: barInks793(sWhite793), flames: barInks793(sFlames793),
      ironbow: barInks793(sIron793), cold: barInks793(sCold793), fireplace: barInks793(sFire793) };
    const words793 = ['green', 'white', 'flames', 'ironbow', 'cold', 'fireplace'];
    check('T-793 drawing and hover: six words on this row now answer six different pictures -- no two of them draw the same set of colours -- and the box names the word it is on and every word of its cycle in its own hover, with a sentence that says where the colour comes from ON A BAR. The fire word this row keeps is measured alongside them to say that extending the list did not touch it',
      words793.every(function (w793, i793) {
        const other793 = words793.filter(function (o793, j793) { return j793 !== i793; });
        return !other793.some(function (o793) { return sets793[w793].join('|') === sets793[o793].join('|'); });
      })
      && /ironbow/.test(sIron793.title) && /cold/.test(sIron793.title) && /white/.test(sIron793.title)
      && /each segment's own height|each bar's own height|the height of a bar is the loudness/.test(sIron793.title)
      && sIron793.word === 'ironbow' && sCold793.word === 'cold' && sWhite793.word === 'white'
      && sFlames793.word === 'flames' && sGreen793.word === 'green' && sFire793.word === 'fireplace',
      { colour_sets_by_word: sets793, hover_under_ironbow: sIron793.title.slice(0, 320),
        words_shown_by_each_mount: words793.map(function (w793) {
          return { asked: w793, drawn_as: ({ green: sGreen793, white: sWhite793, flames: sFlames793, ironbow: sIron793, cold: sCold793, fireplace: sFire793 })[w793].word }; }) });
    const capCount793 = function (sp793) { return sp793.segs.filter(function (s793) { return s793.ink === FLAT793; }).length; };
    check('T-793 drawing: the peak-hold cap rule is untouched by the new words -- the flat cap ink is drawn wherever a colour word is not the fire word, on the default and on all four ramps, and it is still absent under the fire word, which is the ruling T-789 made about that word and not about these. A colour change in the painter did not reach the marker that says what a bar held',
      capCount793(sGreen793) > 0 && capCount793(sWhite793) > 0 && capCount793(sFlames793) > 0
      && capCount793(sIron793) > 0 && capCount793(sCold793) > 0 && capCount793(sFire793) === 0,
      { cap_ink: FLAT793, cap_rects_by_word: { green: capCount793(sGreen793), white: capCount793(sWhite793),
        flames: capCount793(sFlames793), ironbow: capCount793(sIron793), cold: capCount793(sCold793),
        fireplace: capCount793(sFire793) } });
    console.log('  MEASURE T-793 segments read per word: green ' + sGreen793.segs.length + ' inks '
      + Object.keys(sGreen793.inks).length + ' | white ' + sWhite793.segs.length + ' inks '
      + Object.keys(sWhite793.inks).length + ' | flames ' + tFlames793.rgbSegs + ' inks ' + tFlames793.distinctInFrame
      + ' | ironbow ' + tIron793.rgbSegs + ' inks ' + tIron793.distinctInFrame + ' (off-ramp ' + tIron793.offByRamp.length
      + ') | cold ' + tCold793.rgbSegs + ' inks ' + tCold793.distinctInFrame + ' (off-ramp ' + tCold793.offByRamp.length
      + ') | fireplace ' + sFire793.segs.length + ' | bar baseline ' + tIron793.base + ' px, tallest bar '
      + tIron793.tallestSegs + ' segments, top ' + tIron793.topOfTallestBar);
    teardown();
  }

  // T-819 (2026-11-13): the position the sliding window and the play head are drawn from is now read on every
  // frame, not only where `playTime` state changes. The operator's read from a live panel, verbatim: "the waveform
  // appears with multiple bars per frame - not every single bar". The arithmetic the change is measured against is
  // printed below rather than asserted, because the thing it changes is a frame the browser draws and this harness
  // has no requestAnimationFrame — `scopeLive300()` refuses to run a loop without one (measured, not assumed). What
  // IS pinned is the wiring: one rule, in one function, called from the draw frame and from the state-change path,
  // the refresh ahead of the draw cap, the no-length rule intact, and no third place that writes the reference.
  console.log('\n--- T-819: the position the window is drawn from, refreshed per frame ---');
  const src819 = require('fs').readFileSync(TARGET, 'utf8');
  const frame819 = (function () {
    const i819 = src819.indexOf('function scopeFrame300() {');
    if (i819 < 0) return '';
    const j819 = src819.indexOf('\n      }', i819);
    return src819.slice(i819, j819 > i819 ? j819 : i819 + 4000);
  })();
  const helper819 = (function () {
    const i819h = src819.indexOf('function scopePosFromElement819() {');
    if (i819h < 0) return '';
    const j819h = src819.indexOf('\n      }', i819h);
    return src819.slice(i819h, j819h > i819h ? j819h : i819h + 1200);
  })();
  check('T-819: the reading exists once, as its own function, and reads the element this row drives',
    (src819.match(/function scopePosFromElement819\(\)/g) || []).length === 1
    && /var el819 = controlEl395\(\);/.test(helper819),
    [(src819.match(/function scopePosFromElement819\(\)/g) || []).length, /controlEl395/.test(helper819)]);
  check('T-819: the draw frame writes the position through it, so the window moves with the frames',
    /scopePosRef331\.current = scopePosFromElement819\(\);/.test(frame819),
    [frame819.length > 0, /scopePosRef331\.current = scopePosFromElement819/.test(frame819)]);
  check('T-819: the refresh sits AHEAD of the fps draw cap — a frame whose draw is skipped still advances the reading',
    frame819.indexOf('scopePosRef331.current = scopePosFromElement819()') >= 0
    && frame819.indexOf('scopePosRef331.current = scopePosFromElement819()') < frame819.indexOf('var ratio537 = scopeFpsRatio537('),
    [frame819.indexOf('scopePosFromElement819'), frame819.indexOf('var ratio537')]);
  check('T-819: the cap itself is untouched — the draw is still the part that gets skipped, not the clock',
    /if \(ratio537 <= 1 \|\| \(n % ratio537\) === 0\) \{\s*\n\s*try \{ scopePaint300\(\);/.test(frame819),
    [/ratio537/.test(frame819), /scopePaint300\(\)/.test(frame819)]);
  check('T-819: the state-change path still writes it, still only when no loop is running, and through the same function',
    /scopePosRef331\.current = scopePosFromElement819\(\);\n\s*if \(!scopeRaf300\.current\)/.test(src819),
    [/scopePosRef331\.current = scopePosFromElement819\(\);\n\s*if \(!scopeRaf300\.current\)/.test(src819)]);
  check('T-819: exactly two places write that reference — the draw frame and the state-change path, no third door',
    (src819.match(/scopePosRef331\.current =/g) || []).length === 2,
    [(src819.match(/scopePosRef331\.current =/g) || []).length]);
  check('T-819: the rule the reading follows is unchanged — no real length answers 0, and a position is clamped',
    /if \(!\(d819 > 0\) \|\| !isFinite\(d819\)\) return 0;/.test(helper819)
    && /Math\.max\(0, Math\.min\(1, c819 \/ d819\)\)/.test(helper819),
    [/!\(d819 > 0\)/.test(helper819), /Math\.max\(0, Math\.min\(1/.test(helper819)]);
  check('T-819: the inline copy is gone, not left beside the new one — the old local variable no longer exists',
    (src819.match(/aPos331/g) || []).length === 0,
    [(src819.match(/aPos331/g) || []).length]);
  console.log('  T-819 arithmetic read: a bar is window/bars = '
    + Math.round(6000 / 65) + ' ms on sliding, ' + Math.round(3000 / 65) + ' ms on sliding2; '
    + 'a media event moved the window ~' + (250 / (6000 / 65)).toFixed(1) + ' bars and ~'
    + (250 / (3000 / 65)).toFixed(1) + ' bars; a drawn frame now moves it ~'
    + (33 / (6000 / 65)).toFixed(2) + ' bars at 30 fps and ~' + (83 / (6000 / 65)).toFixed(2)
    + ' bars at 12 fps — the bar width is unchanged, the step is what got smaller');

  console.log('=== ' + pass + ' pass, ' + fail + ' fail ===');
  if (fail) process.exit(1);
})().catch(function (e) {
  console.log('THROW: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
