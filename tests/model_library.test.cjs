// T-300 U-4 (2026-10-12): the model library explorer.
// What this suite exists to protect:
//   1. ONE TAG, NEVER TWO. The user's rule: "we must be able to overwrite the display if its wrong, but
//      showing two at the same time is not good". A row carries exactly one tag span, a curated override
//      wins over the endpoint's own answer, and a model nothing has described reads `unknown` rather than
//      borrowing the dispatch form's default.
//   2. THE LAYOUT RULE (user note 2026-10-12, after the Winamp screenshot): "we do not want that, our
//      single window we have should keep the vertical devised arrangement". The three panes live INSIDE
//      one section of the one vertical column, the section keeps minWidth 0 (the no-horizontal-scrollbar
//      contract from T-219) and the pane row wraps instead of forcing a width.
//   3. The counts next to the groups are the lane and view as a whole: typing a search filters the item
//      list and must not move the numbers a person is reading.
//   4. The task lane is a readout. Its models are chosen by the job kind in the text section, so its rows
//      say that instead of pretending a click selects something.
// Usage: node tests/model_library.test.cjs [path/to/client.js]
const path = require('path');
const { createRuntime, loadClient, openAllSections } = require('./react_shim.cjs');

const TARGET = process.argv[2] || path.join(__dirname, '..', 'lib', 'client.js');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label + (detail !== undefined ? '  ->  ' + JSON.stringify(detail) : '')); }
}
function flush() { let p = Promise.resolve(); for (let i = 0; i < 30; i++) p = p.then(function () {}); return p; }

const MODELS = {
  tts: [
    // T-378 (2026-10-14): the capability flags here are the ones the live host answers for those families
    // (get_models -> clone_required / clone_optional / default_voice / samples_only / design, lib/index.js:6218-6221),
    // so the grouping below is tested against real flag shapes and not against invented ones.
    { id: 'm-voice', family: 'voxcpm2', quant: 'bf16', loaded: true, task: 'tts', clone_optional: true, default_voice: true },
    { id: 'm-clone', family: 'voxcpm2', quant: 'q8', loaded: false, clone_required: true, task: 'clon' },
    // T-914 (2026-11-23): this row also carries the flag the host derives from the ENGINE-S record — the shape a
    // cast family has when this plugin-s own table has never heard of it (measured live the same day: two families
    // on one CPU slot row-flagged samples_only:false with no cast word at all, while the batch door accepted them).
    // Its role bucket stays where the pins above read it: that axis is about what a single-voice render needs from
    // the person, and a cast says nothing about that.
    { id: 'm-bare', family: 'unknownfamily', loaded: false, multi_speaker: true },  // no table row; one record word
    { id: 'm-override', family: 'chatterbox_turbo', quant: 'q5', loaded: false, task: 'tts', default_voice: true, tag: 'curated: no dialogue' },
    { id: 'm-samples', family: 'moss_ttsd', quant: 'q8', loaded: false, task: 'tts', samples_only: true },
    { id: 'm-design', family: 'qwen3_tts', loaded: false, task: 'vdes', design: true },
    // A task token this panel's tables do not describe. It must stay VISIBLE, in a bucket with a name,
    // and its tag must be the token itself rather than a guess borrowed from a nearby model.
    { id: 'm-weird', family: 'experimental', loaded: false, task: 'telepathy' },
  ],
  stt: [
    { id: 'm-asr', family: 'sense_asr', quant: 'q8', loaded: true, task: 'asr' },
    { id: 'm-diar', family: 'sortformer', loaded: false, task: 'diar' },
  ],
  task: [
    { id: 'm-sep', family: 'htdemucs', quant: 'q8', loaded: false, task: 'sep' },
    { id: 'm-gen', family: 'stable-audio', loaded: false, task: 'gen' },
  ],
};

let staleFlag = false;
const calls = [];
function host(url) {
  const u = String(url);
  calls.push(u);
  let body = { ok: true };
  if (/get_models/.test(u)) {
    const fn = /fn=(\w+)/.exec(u); const lane = fn ? fn[1] : 'tts';
    body = { ok: true, models: (MODELS[lane] || []).map(function (m) { return Object.assign({}, m); }), stale: staleFlag, as_of: 1727000000000 };
  } else if (/get_endpoints/.test(u)) body = { tts: { url: 'http://cpu1.test:8963', route: 'speech' }, stt: { url: 'http://cpu1.test:8962', route: 'tasks' } };
  else if (/server_status/.test(u)) body = { tts: { ok: true, loaded_model: 'm-voice' }, stt: { ok: true } };
  else if (/endpoint_registry/.test(u)) body = { ok: true, endpoints: [] };
  else if (/refresh_voices/.test(u)) body = { voices: ['voy_janeway'], builtins: ['alba'], builtins_source: 'mirror', default_voice: '' };
  else if (/voice_registry/.test(u)) body = { ok: true, voices: {
    voy_janeway: { local_copy: true, voice_origin: 'plugin', reference_text: 'shuttle two, on the double', reference_text_source: 'plugin', ref_dur_s: 13.1 },
    voy_doctor: { local_copy: false, voice_origin: 'plugin' },
    alba: { local_copy: true, voice_origin: 'plugin', reference_text: 'alba reference line', reference_text_source: 'plugin', ref_dur_s: 9.4 },
  } };
  else if (/playlist_list/.test(u)) body = { items: [], queues: { tts: { paused: false }, stt: { paused: false } } };
  else if (/queue_status/.test(u)) body = { ok: true, queues: { tts: { queued: 0 }, stt: { queued: 0 } } };
  return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(body); } });
}

const timer = { interval: function () { return function () {}; }, timeout: function () { return function () {}; } };
const doc = { addEventListener: function () {}, removeEventListener: function () {}, createElement: function (t) { return { tagName: t, click: function () {} }; }, body: { appendChild: function () {}, removeChild: function () {} } };

(async function main() {
  const shim = createRuntime();
  const client = loadClient(shim, { target: TARGET, fetch: host, timer: timer, document: doc });
  const comp = client.apply();
  if (!comp) throw new Error('panel did not register');
  let mark = 0;
  function commit() { const b = {}; const start = shim.rt.created.length; shim.render(comp(), b); shim.runEffects(); mark = start; return b; }
  function created() { return shim.rt.created.slice(mark); }
  function cls(c) { return created().filter(function (e) { return e.props && e.props.className === c; }); }
  function ownText(e) { const c = e.props && e.props.children; return (typeof c === 'string') ? c : ''; }
  function textOf(c) { return cls(c).map(ownText); }
  function nodeByText(re) { return created().filter(function (e) { return e.type === 'div' && re.test(ownText(e)); }); }
  function rows() { return cls('audio-play-lib-row'); }
  function rowFor(id) { return rows().filter(function (e) { return ownText(e).indexOf(id) >= 0 || JSON.stringify(e.props.children).indexOf('"' + id + '"') >= 0; })[0] || null; }

  let bag = commit(); await flush();
  await openAllSections(shim, comp);
  bag = commit(); await flush(); bag = commit(); await flush();

  // 1. the three panes exist, once each, inside the one section
  // T-300 CONTRACT CHANGE (user feedback 2026-10-12, 18:47): "currently we have three columns: LANE /
  // GROUP / Modellist -> reduce to two columns -> The 'sub-selection' Group might be dropped, or moved
  // below 'Lane' selector". The group nodes were MOVED under the lane nodes in the tree pane rather than
  // dropped, and the middle column is gone. The count assertion is not relaxed: it now also pins that the
  // middle pane's class renders nowhere, so the third column cannot come back by accident.
  check('U-4: the library renders TWO panes (tree with the groups under the lanes, then items) inside one section',
    cls('audio-play-lib-tree').length === 1 && cls('audio-play-lib-items').length === 1
      && cls('audio-play-lib-groups').length === 0,
    [cls('audio-play-lib-tree').length, cls('audio-play-lib-groups').length, cls('audio-play-lib-items').length]);
  const libSection = created().filter(function (e) { return e.type === 'div' && e.props && String(e.props.className || '').indexOf('audio-play-section') === 0; });
  const libPaneRow = cls('audio-play-lib-panes')[0];
  check('U-4 (the layout rule): the pane row WRAPS instead of fixing widths, so the panel keeps its single vertical column',
    !!libPaneRow && libPaneRow.props.style.flexWrap === 'wrap' && libPaneRow.props.style.minWidth === '0',
    libPaneRow && libPaneRow.props.style);
  check('U-4: every section keeps minWidth 0 (the T-219 rule that a narrow panel must not grow a horizontal scrollbar)',
    libSection.length >= 7 && !libSection.some(function (e) { return !e.props.style || e.props.style.minWidth !== '0'; }),
    libSection.map(function (e) { return e.props.style && e.props.style.minWidth; }));

  // 2. the tree names the three lanes the host actually answers, with counts.
  // The shim's created list is FLAT (one entry per element per render, no parent links), so a pane's own
  // children are never reachable as text. What is reachable is the leaf nodes, and a lane node IS a leaf:
  // its only child is the label string.
  function leafNodes(re) { return created().filter(function (e) { return e.type === 'div' && re.test(ownText(e)); }); }
  const treeTxt = leafNodes(/^(TTS|STT|TASK) \(\d+\)$/).map(ownText).join(' | ');
  check('U-4: the lane tree names TTS (7), STT (2) and TASK (2), the three lists the plugin already reads',
    /TTS \(7\)/.test(treeTxt) && /STT \(2\)/.test(treeTxt) && /TASK \(2\)/.test(treeTxt), treeTxt);

  // 3. ONE tag per row, never two side by side
  check('U-4: every row carries exactly one tag span (a row that showed two labels would show up here as a count mismatch)',
    rows().length === 7 && cls('audio-play-lib-tag').length === rows().length,
    [rows().length, cls('audio-play-lib-tag').length]);
  const rOv = rowFor('m-override');
  const rBare = rowFor('m-bare');
  // The row's own tag span, read out of the row's children rather than searched for in the whole tree.
  function tagOf(row) {
    const kids = (row && row.props && Array.isArray(row.props.children)) ? row.props.children : [];
    const t = kids.filter(function (k) { return k && k.props && k.props.className === 'audio-play-lib-tag'; });
    return { n: t.length, text: t.length ? String(t[0].props.children) : null };
  }
  check('U-4: a curated override REPLACES the endpoint answer instead of adding a second label',
    !!rOv && tagOf(rOv).n === 1 && tagOf(rOv).text === 'curated: no dialogue'
      && JSON.stringify(rOv.props.children).indexOf('single-voice') < 0,
    [tagOf(rOv), JSON.stringify(rOv.props.children)]);
  check('U-4: a model nothing has described reads unknown (amber), it does not borrow the dispatch default',
    !!rBare && JSON.stringify(rBare.props.children).indexOf('unknown') >= 0
      && cls('audio-play-lib-tag').some(function (t) { return t.props.children === 'unknown' && t.props.style.color === '#d29922'; }),
    rBare && JSON.stringify(rBare.props.children));
  // The hover names the tag exactly once. A row that had two vocabularies would name it twice, and the
  // count of occurrences is the whole assertion.
  check('U-4: the row hover names its tag exactly once (no second vocabulary hiding in the tooltip)',
    !!rOv && String(rOv.props.title).split('curated: no dialogue').length === 2,
    rOv && rOv.props.title);

  // 4. groups and counts, and the counts do not move when the item list is filtered.
  // T-378 (user ruling 2026-10-14, "Group by the five classes and offer no-voice", asked as "how should we sort
  // the engines that do cloning but are not listed to do so?"). On the TTS lane the group axis is the VOICE ROLE
  // the host's own flags describe, because the task category said nothing there: measured over the 27 models the
  // live panel offers, every one of them answers "speech synthesis", so the old group pane held exactly one
  // group. The five roles are the ones a person picking a TTS model is actually asking about.
  const GROUP_RE = /^(all|clone only|voice \+ clone|built-in voice|voice samples|voice design|no voice role|speech synthesis|audio generation|audio tools|voice conversion|speech analysis|ungrouped) \(\d+\)$/;
  const groupsBefore = leafNodes(GROUP_RE).map(ownText).join(' | ');
  check('T-378: the TTS lane groups by what the engine needs from you - clone only, voice + clone, built-in voice, '
      + 'voice samples, voice design - each with its count, and the pipeline category is not the axis here',
    /clone only \(1\)/.test(groupsBefore) && /voice \+ clone \(1\)/.test(groupsBefore)
      && /built-in voice \(1\)/.test(groupsBefore) && /voice samples \(1\)/.test(groupsBefore)
      && /voice design \(1\)/.test(groupsBefore) && /no voice role \(2\)/.test(groupsBefore)
      && /all \(7\)/.test(groupsBefore) && !/speech synthesis/.test(groupsBefore), groupsBefore);
  check('T-378: an entry the catalog has not described lands in a bucket that says the panel is not inventing a '
      + 'role for it, and its tag stays its own token',
    leafNodes(/^no voice role \(2\)$/).length === 1
      && cls('audio-play-lib-tag').some(function (t) { return t.props.children === 'telepathy'; }),
    [groupsBefore, cls('audio-play-lib-tag').map(function (t) { return t.props.children; })]);
  check('T-378: the role is named on the row itself, in the host\u2019s own words, so a cloning engine that is not '
      + 'listed as offering a voice says which one it is',
    /clone only: a reference voice is mandatory \(clone_required\)/.test(String(rowFor('m-clone').props.title))
      && /voice \+ clone: built-in voices work with no reference AND a short reference may be given/.test(String(rowFor('m-voice').props.title))
      && /voice design: the description IS the voice \(task vdes\)/.test(String(rowFor('m-design').props.title)),
    [String(rowFor('m-clone').props.title).slice(-120), String(rowFor('m-voice').props.title).slice(-120)]);
  // T-881 (2026-11-16): the row badge follows the family's real routes. The voice_samples row is named for
  // the route it takes (the operator's panel test of moss_ttsd: "why is ttsd listed as 'default voices' it's
  // not using any default voices iirc, it's multi speaker cloning for up to 5 voices!"); the family that can
  // render plain AND clone says both words instead of wearing the built-in-voice word alone.
  check('T-881: the voice_samples row is badged SAMPLES and carries no DEFAULT VOICE word',
    /SAMPLES/.test(JSON.stringify(rowFor('m-samples').props.children))
    && !/DEFAULT VOICE/.test(JSON.stringify(rowFor('m-samples').props.children)),
    JSON.stringify(rowFor('m-samples').props.children).slice(0, 200));
  check('T-881: a family flagged clone_optional AND default_voice is badged VOICE + CLONE — both routes it has',
    /VOICE \+ CLONE/.test(JSON.stringify(rowFor('m-voice').props.children)),
    JSON.stringify(rowFor('m-voice').props.children).slice(0, 200));
  check('T-914: a family the engine-s record names as cast-capable is badged CAST on the flag the host derives from that record — the badge no longer waits for a word this plugin typed by hand',
    /CAST/.test(JSON.stringify(rowFor('m-bare').props.children))
    && !/SAMPLES/.test(JSON.stringify(rowFor('m-bare').props.children))
    && !/CLONE/.test(JSON.stringify(rowFor('m-bare').props.children))
    && !/DEFAULT VOICE/.test(JSON.stringify(rowFor('m-bare').props.children)),
    JSON.stringify(rowFor('m-bare').props.children).slice(0, 200));
  check('T-914: and the row is not moved into a clone role it was never claimed to have — the group axis says what a single-voice render needs, and a cast says nothing about that',
    leafNodes(/^no voice role \(2\)$/).length === 1
      && !/voice samples|clone only|voice \+ clone|built-in voice|voice design/i.test(String(rowFor('m-bare').props.title || '')),
    [leafNodes(GROUP_RE).map(ownText).join(' | '), String(rowFor('m-bare').props.title || '').slice(0, 160)]);
  const search = cls('audio-play-lib-items')[0].props;   // the input lives in the items pane
  const input = created().filter(function (e) { return e.type === 'input' && e.props && /filter this list/.test(String(e.props.placeholder || '')); })[0];
  if (!input) throw new Error('the library search field is missing');
  input.props.onInput({ target: { value: 'clone' } });
  await flush(); commit(); await flush();
  const groupsAfterSearch = leafNodes(GROUP_RE).map(ownText).join(' | ');
  check('U-4: searching filters the item list and does NOT move the group counts a person is reading',
    groupsAfterSearch === groupsBefore && rows().length === 1 && JSON.stringify(rows()[0].props.children).indexOf('m-clone') >= 0,
    [groupsAfterSearch, rows().map(function (r) { return ownText(r); })]);
  input.props.onInput({ target: { value: '' } });
  await flush(); commit(); await flush();

  // 5. a group click filters the list
  const grp = nodeByText(/^voice samples \(1\)$/)[0];
  if (!grp) throw new Error('the voice samples group node is missing');
  grp.props.onClick(); await flush(); commit(); await flush();
  check('T-378: clicking a voice-role group shows only that role in the item list - the sample-driven clone stands '
      + 'alone, which is the sorting the ruling asked for',
    rows().length === 1 && JSON.stringify(rows()[0].props.children).indexOf('m-samples') >= 0,
    rows().map(function (r) { return ownText(r); }));
  nodeByText(/^all \(7\)$/)[0].props.onClick(); await flush(); commit(); await flush();

  // 6. T-300 CONTRACT CHANGE (user feedback 2026-10-12, 18:47): "The 'view' selector can be removed ->
  // not helpful, confusing, replace with Group selector". The all / loaded here / not loaded nodes are
  // gone, and the honest reason is written next to the code: the engines load on demand at dispatch, so
  // "not loaded" was the absence of an answer, not a state a model was in. The coverage did not move to a
  // weaker place - residency is now asserted WHERE it is actually shown, on the row itself.
  // The residency TOOLTIP stays (it is on the row, where the dot is); what must not exist is the node
  // you used to click to filter by it.
  check('T-300: no view selector came back (no "loaded here" / "not loaded" node renders anywhere)',
    leafNodes(/^(loaded here|not loaded)$/).length === 0
      && !created().some(function (e) { return /^(loaded here|not loaded)$/.test(ownText(e)); }),
    leafNodes(/^(loaded here|not loaded)$/).map(ownText));
  // T-373 (user 2026-10-14, live panel, verbatim): "the model list shows the previously loaded model as green -
  // this is confusing - the highlighting in the model sections should only highlight current selection 'for next
  // generation'". The FACT stays on every row and it stays where it was; only the evidence changed shape. A
  // filled dot means the lane has that build in memory right now, a hollow one means it does not, and the hover
  // says plainly that this is not what the panel will send next. Green is retired here because green elsewhere
  // in this panel (T-371) means "press this and work starts", and a row the person never picked was wearing it.
  check('U-4 / T-373: residency is on every row as a shape and a hover, not as a colour - no green dot and no green row on a model nobody selected',
    rows().length === 7
      && JSON.stringify(rowFor('m-voice').props.children).indexOf('\u25CF') >= 0
      && JSON.stringify(rowFor('m-clone').props.children).indexOf('\u25CB') >= 0
      && JSON.stringify(rowFor('m-voice').props.children).indexOf('#3fb950') < 0
      && JSON.stringify(rowFor('m-voice').props.children).indexOf('resident on TTS') >= 0
      && JSON.stringify(rowFor('m-voice').props.children).indexOf('not the same as what this panel will send next') >= 0
      && ((rowFor('m-voice').props.style || {}).background || '') === '#101016'
      && ((rowFor('m-clone').props.style || {}).background || '') === '#101016',
    rows().map(function (r) { return JSON.stringify(r.props.children).slice(0, 90); }));

  // 7. clicking a TTS row selects for TTS (the affordance the old chips had)
  const rSel = rowFor('m-clone');
  check('U-4: a TTS row is pickable and its hover says so in the old words',
    !!rSel && /click to select for TTS$/.test(String(rSel.props.title)), rSel && rSel.props.title);
  rSel.props.onClick(); await flush(); bag = commit(); await flush();
  check('U-4: the click lands on the same selection state the TTS select uses',
    bag.ModelLibraryPane && bag.ModelLibraryPane.selModel && bag.ModelLibraryPane.selModel.tts === 'm-clone',
    bag.ModelLibraryPane && bag.ModelLibraryPane.selModel);

  // 8. the TASK lane is a readout, not a picker
  nodeByText(/^TASK \(2\)$/)[0].props.onClick(); await flush(); commit(); await flush();
  const taskRows = rows();
  check('U-4: TASK rows say why a click does nothing instead of pretending to select',
    taskRows.length === 2 && taskRows.every(function (r) { return /CHOSEN BY THE JOB KIND/.test(String(r.props.title)); }),
    taskRows.map(function (r) { return String(r.props.title).slice(0, 80); }));
  // The panel keeps its OWN default for the task selection (the job-kind select has a picked model
  // whether the library was touched or not), so the honest assertion is that the click changed nothing:
  // the selection map is compared to itself, before and after.
  const selBefore = JSON.stringify(bag.ModelLibraryPane.selModel);
  taskRows[0].props.onClick(); await flush(); bag = commit(); await flush();
  check('U-4: clicking a TASK row changes no selection anywhere (no fake verb, no fake pick)',
    JSON.stringify(bag.ModelLibraryPane.selModel) === selBefore, [selBefore, bag.ModelLibraryPane.selModel]);
  // The tag must be the panel's OWN kind vocabulary — the same words the job-kind select uses — not a
  // third vocabulary invented for the library. These two strings are what the dispatch form says.
  check('U-4: the TASK lane tags its models with the dispatch form\'s own words, not a library-only vocabulary',
    cls('audio-play-lib-tag').map(function (t) { return t.props.children; }).join(',') === 'generate (sfx / music),separate',
    cls('audio-play-lib-tag').map(function (t) { return t.props.children; }));

  // 9. the refresh belongs to the lane being looked at
  const before = calls.length;
  const rb = cls('audio-play-lib-refresh')[0];
  check('U-4: the refresh button is labelled for the lane on screen', !!rb && rb.props.children === 'refresh task', rb && rb.props.children);
  rb.props.onClick(); await flush(); commit(); await flush();
  check('U-4: it re-reads THAT lane (get_models?fn=task), not always tts',
    calls.slice(before).some(function (u) { return /get_models\?fn=task/.test(u); }), calls.slice(before));

  // 10. a remembered list is labelled as remembered, and no Load/Unload button came back.
  // The label belongs to the lane on screen, so the test goes back to TTS first — a stale tts answer
  // while the TASK lane is showing must NOT paint a stale label, and that is worth knowing too.
  check('U-4: a stale answer for a lane that is NOT on screen paints no stale label on the lane you are looking at',
    cls('audio-play-lib-panes').length === 1 && !created().some(function (e) { return JSON.stringify(e.props.children || '').indexOf('cached list') >= 0; }),
    'a stale label was painted for the wrong lane');
  nodeByText(/^TTS \(7\)$/)[0].props.onClick(); await flush(); commit(); await flush();
  staleFlag = true;
  bag.ModelLibraryPane.refreshModels('tts'); await flush(); commit(); await flush();
  check('U-4: a cached list is labelled, not shown as live (the sentence the panel has always used)',
    created().some(function (e) { return JSON.stringify(e.props.children || '').indexOf('cached list') >= 0; }), 'no cached-list label');
  staleFlag = false;
  check('U-4: no Load / Unload button came back (the engines load on demand at dispatch)',
    !cls('audio-play-lib-row').length || !created().some(function (e) { return e.type === 'button' && /^(load|unload)$/i.test(ownText(e)); }),
    created().filter(function (e) { return e.type === 'button'; }).map(ownText).filter(function (t) { return /load|unload/i.test(t); }));

  // 11. THE VOICE LIBRARY (user request 2026-10-12: "same for the voice library"). Same explorer frame
  // around the SAME rows: VoiceList / VoiceRow are untouched, the frame only filters a copy of the map.
  check('U-4: the voice store gets the explorer frame too (tree + items), inside the same one column',
    cls('audio-play-voice-lib-tree').length === 1 && cls('audio-play-voice-lib-items').length === 1
      && cls('audio-play-voice-lib-panes')[0] && cls('audio-play-voice-lib-panes')[0].props.style.flexWrap === 'wrap'
      && cls('audio-play-voice-lib-panes')[0].props.style.minWidth === '0',
    [cls('audio-play-voice-lib-tree').length, cls('audio-play-voice-lib-items').length]);
  // T-547 (user 2026-10-17, verbatim): "in 'Voices' 'view' section: we have hardcoded views 'in use' and 'no
  // sample' and 'sample here' which are very useless, we should drop the 'view' selector for now and stick with
  // single 'groups sorting' to reduce ui-options-clutter". This scenario was BUILT by clicking those chips, so it is
  // re-pointed rather than deleted. What it really proved is that the tree counts the WHOLE store and that a filter
  // never makes a group look emptier than it is; that is still proved, on the axis that is left. The state a chip used
  // to name is now measured where it was always printed anyway - on the row itself.
  // One measured trap worth recording: with the voice chips gone, the regex this scenario used no longer matched
  // nothing - it matched the MODEL library's own "all (7)" chip, a different tree in the same panel. A pin that
  // silently starts measuring a neighbour is worse than a pin that fails, so the texts below are named exactly.
  const vStateChips547 = leafNodes(/^(sample here|no sample|in use) \(\d+\)$/).map(ownText);
  check('T-547: the three hardcoded state chips are gone from the voice tree, and the groups axis is what is left standing in it',
    vStateChips547.length === 0 && created().some(function (e) { return ownText(e) === 'all groups'; }),
    vStateChips547);
  const vGroupChipsText547 = function () {
    return created().map(ownText).filter(function (t547c) {
      return t547c === 'all groups' || /^ungrouped \(\d+\)$/.test(t547c);
    }).join(' | ');
  };
  const vCountsBefore = vGroupChipsText547();
  check('T-547: a voice the store holds no WAV for is still named that way on its own row - the state left the tree, it did not leave the panel',
    cls('audio-play-voice-row').length === 3
    && cls('audio-play-voice-row').some(function (r547) {
      return JSON.stringify(r547.props.children || {}).indexOf('no sample') >= 0;
    }),
    cls('audio-play-voice-row').map(ownText));
  const vInput = created().filter(function (e) { return e.type === 'input' && e.props && /filter the voices/.test(String(e.props.placeholder || '')); })[0];
  if (!vInput) throw new Error('the voice search field is missing');
  vInput.props.onInput({ target: { value: 'zzz' } }); await flush(); commit(); await flush();
  check('U-4, re-pointed by T-547: a filter that matches nothing says so honestly instead of claiming the store is empty, and the sentence names only the two axes that still exist - the third one it used to name is gone from the panel and from the sentence',
    created().some(function (e) { return /nothing matches this group or filter \(3 in the store\)/.test(ownText(e)); })
      && !created().some(function (e) { return /nothing matches this view/.test(ownText(e)); })
      && !created().some(function (e) { return /no voices yet/.test(ownText(e)); }),
    created().map(ownText).filter(function (t) { return /voices|filter/.test(t); }));
  vInput.props.onInput({ target: { value: '' } }); await flush(); commit(); await flush();
  // There is no "all" chip to press any more. The rows come back when the filter is cleared, which is the same fact
  // the press used to demonstrate, demonstrated by the rows instead of by a control.
  // U-4 measured the row affordances when every row carried a provenance chip. T-426 (user ruling 2026-10-16,
  // live panel) removed the "plugin" tag from voice entries: every name in the store is plugin-origin, so the chip
  // stated the default on every row and said nothing. The affordances the pin is really about are the controls a
  // row offers, and those are pinned by name now instead of being counted through a chip that no longer exists.
  check('U-4: the frame filters rows but does not move the tree counts, and the rows keep their own affordances (pick + delete + the group editor). The provenance chip is no longer one of them: T-426 removed the "plugin" tag from voice entries and reserved a chip for the exception only',
    vGroupChipsText547() === vCountsBefore && vGroupChipsText547().length > 0
      && cls('audio-play-voice-row').length === 3
      && cls('audio-play-voice-del').length === 3
      && cls('audio-play-voice-group-edit361').length === 3
      && !created().some(function (e) { return ownText(e) === 'plugin'; })
      && created().some(function (e) { return e.type === 'button' && /delete/.test(ownText(e)); }),
    [cls('audio-play-voice-row').length, cls('audio-play-voice-del').length, cls('audio-play-voice-group-edit361').length,
     created().filter(function (e) { return ownText(e) === 'plugin'; }).length]);

  check('T-362 (2026-10-14): a host that answers voice_registry WITHOUT a groups field is named as the reason — the panel does not report "no group filed yet" when the capability itself is not loaded',
    created().some(function (e) { return /groups are not reported by this host yet/.test(ownText(e)); })
      && !created().some(function (e) { return ownText(e) === 'no group filed yet'; }),
    created().map(ownText).filter(function (t) { return /group/i.test(t); }).slice(0, 4));
  const gNone362 = cls('audio-play-voice-groups-none361')[0];
  check('T-362: its hover names the fact that actually arrived (the field was absent) and what the panel refuses to do about it (paint a shelf it cannot fill)',
    !!gNone362 && /WITHOUT a groups field/.test(String((gNone362.props || {}).title || ''))
      && /will not paint a group shelf it cannot fill/.test(String((gNone362.props || {}).title || '')),
    gNone362 ? String((gNone362.props || {}).title || '').slice(0, 120) : 'no groups-none line rendered');
  check('T-362: the group controls are still there while the host is behind — the panel does not hide a capability it is waiting for, and it does not disable a row editor either',
    created().some(function (e) { return ownText(e) === 'all groups'; })
      && cls('audio-play-voice-group-edit361').length === 3,
    { all_pick: created().filter(function (e) { return ownText(e) === 'all groups'; }).length,
      editors: cls('audio-play-voice-group-edit361').length });

  // --- T-497 (user 2026-10-16): "in voices selection tree, add hardcoded group 'ungrouped' under 'all groups'".
  // This scenario is the harder of the two shapes to pin on: the host answers voice_registry WITHOUT a groups field,
  // so nothing is filed and the derived shelf is empty. A bucket that only appears when somebody files something
  // would be invisible here — which is exactly the hole the request named.
  {
    const ung497 = leafNodes(/^ungrouped \(\d+\)$/)[0];
    check('T-497: the hardcoded bucket sits under all groups, named and counted from the rows — in this scenario the host reports no groups field at all, so every voice is ungrouped and the chip has to say 3',
      !!ung497 && ownText(ung497) === 'ungrouped (3)',
      ung497 ? ownText(ung497) : 'no ungrouped chip rendered');
    const countsBefore497 = vGroupChipsText547();
    const rowsAll497 = cls('audio-play-voice-row').length;
    ung497.props.onClick(); await flush(); commit(); await flush();
    const shown497 = cls('audio-play-voice-group-shown361')[0];
    check('T-497: clicking it narrows to exactly the voices carrying no group, states its own numbers (showing 3 of 3), and moves NO count in the tree — the counts stay the counts of the whole store',
      cls('audio-play-voice-row').length === rowsAll497 && rowsAll497 === 3
      && !!shown497 && ownText(shown497) === 'showing 3 of 3'
      && vGroupChipsText547() === countsBefore497 && countsBefore497.length > 0,
      { rows: cls('audio-play-voice-row').length, shown_line: shown497 ? ownText(shown497) : 'none', tree: countsBefore497 });
    leafNodes(/^ungrouped \(3\)$/)[0].props.onClick(); await flush(); commit(); await flush();
    check('T-497: clicking it again drops the pick, exactly like a filed group does — the hardcoded chip is a filter over rows, not a second kind of control',
      cls('audio-play-voice-group-shown361').length === 0 && cls('audio-play-voice-row').length === 3,
      { shown_line_after_drop: cls('audio-play-voice-group-shown361').length, rows: cls('audio-play-voice-row').length });
    const src497 = require('fs').readFileSync(TARGET, 'utf8');
    check('T-497: the pick id is a sentinel, not the word — a person who files a REAL group named "ungrouped" gets its own chip and its own count, and neither can shadow the hardcoded bucket nor be shadowed by it',
      /var UNGROUPED361 = "__ungrouped__";/.test(src497)
      && /var groupLabel361 = function \(g361l\) \{ return g361l === UNGROUPED361 \? "ungrouped" : g361l; \};/.test(src497)
      && /g361p \+ " \(" \+ gIdx361\[g361p\] \+ "\)"/.test(src497),
      { sentinel: /var UNGROUPED361 = "__ungrouped__";/.test(src497), label_helper: /groupLabel361/.test(src497) });
  }

  // --- T-426 (user ruling 2026-10-16, live panel) -------------------------------------------------------------
  // "remove the 'plugin' tag from the voice entries and move those buttons to the outer right positions in playlist
  // style behind the group tag". The overflow half of T-426 stays delayed by the same ruling; this is the
  // tag-and-controls half, measured on the rows this suite already mounts.
  {
    const rows426 = cls('audio-play-voice-row');
    const clusters426 = cls('audio-play-voice-actions426');
    const kids426 = function (e426) { return [].concat((e426 && e426.props && e426.props.children) || []).filter(Boolean); };
    const clsOf426 = function (e426) { return String((e426 && e426.props && e426.props.className) || ''); };
    check('T-426: every voice row carries exactly ONE right-hand control cluster, and it is a child of the row it belongs to — containment read off the children of the row, because in this shim a parent is created after its children and a position comparison would lie',
      rows426.length === 3 && clusters426.length === 3
      && rows426.filter(function (r426) { return kids426(r426).some(function (k426) { return clsOf426(k426) === 'audio-play-voice-actions426'; }); }).length === 3,
      { rows: rows426.length, clusters: clusters426.length });
    check('T-426: the cluster is PUSHED right by its own margin-left auto — that is what makes "the outer right position" a rule about the row rather than wherever the last label happened to end',
      clusters426.length === 3 && clusters426.every(function (c426) { return c426.props && c426.props.style && c426.props.style.marginLeft === 'auto'; }),
      clusters426.map(function (c426) { return (c426.props && c426.props.style && c426.props.style.marginLeft) || 'none'; }));
    const seqs426 = clusters426.map(function (c426) {
      return kids426(c426).map(clsOf426).filter(function (x426) { return /voice-(group361|group-edit361|play448|del)/.test(x426); });
    });
    check('T-426: inside the cluster the order is the ruled one — the group tags first, then the controls BEHIND them (group editor, then play, then delete). Information on the left of the row, actions on the right, the way a playlist row reads',
      seqs426.every(function (q426) {
        const e426 = q426.indexOf('audio-play-voice-group-edit361');
        const dl426 = q426.indexOf('audio-play-voice-del');
        const pl426 = q426.indexOf('audio-play-voice-play448');
        const tg426 = q426.indexOf('audio-play-voice-group361');
        return e426 >= 0 && dl426 > e426 && (pl426 < 0 || pl426 > e426) && (tg426 < 0 || tg426 < e426);
      }),
      seqs426);
    check('T-426: nothing is left out in the open — a row has no delete button and no group editor as a direct child any more; both live inside its cluster',
      rows426.every(function (r426) {
        const direct426 = kids426(r426).map(clsOf426);
        return direct426.indexOf('audio-play-voice-del') < 0 && direct426.indexOf('audio-play-voice-group-edit361') < 0
          && direct426.indexOf('audio-play-voice-play448') < 0;
      }) && clusters426.every(function (c426) {
        const inCluster426 = kids426(c426).map(clsOf426);
        return inCluster426.indexOf('audio-play-voice-del') >= 0 && inCluster426.indexOf('audio-play-voice-group-edit361') >= 0;
      }),
      { direct_children: rows426.map(function (r426) { return kids426(r426).map(clsOf426).filter(Boolean); }),
        cluster_children: clusters426.map(function (c426) { return kids426(c426).map(clsOf426); }) });
    const src426 = require('fs').readFileSync(TARGET, 'utf8');
    check('T-426: the provenance tag is gone for the normal case and the exception names itself — a name imported while the shelf was the entity carries a "shelf import" chip; every other row carries no origin chip at all, because the plugin store IS the entity and a name in it was made here',
      /p\.origin === "shelf" \? voiceChip\("shelf import"/.test(src426)
      && !/voiceChip\(p\.origin === "shelf" \? "shelf" : "plugin"/.test(src426)
      && !/parts\.push\(h\("button", \{\s*\n\s*className: "audio-play-voice-del"/.test(src426),
      { exception_chip: /voiceChip\("shelf import"/.test(src426), old_plugin_chip_left: /voiceChip\(p\.origin === "shelf" \? "shelf" : "plugin"/.test(src426) });
  }


  // --- T-378 second half (user ruling 2026-10-14, "Group by the five classes AND offer no-voice"). The choice
  // itself is older than this ticket — T-227 built "no voice — let the model choose" and gated it on the host's
  // own refusal — but nothing in this suite ever read the gate, so the sorting ruling and the choice it goes with
  // are now pinned together: the choice is live on a role that can take it, and it is refused on the role that
  // cannot, in the same pane the sorting was just changed in.
  // The panel carries the no-voice choice in more than one select (the composer form, the dispatch form, the
  // shut strip's own control), so the locator reads EVERY one of them and the assertion is about all of them:
  // a gate that exists in one select and not in another is exactly the kind of half-fix this panel keeps
  // producing.
  const noVoiceOpts = function () {
    return created().filter(function (e) { return e.type === 'option' && /no voice/.test(ownText(e)); });
  };
  const nvRowA = rowFor('m-voice');
  if (!nvRowA) throw new Error('the m-voice row is missing from the library list');
  nvRowA.props.onClick(); await flush(); commit(); await flush();
  const nvA = noVoiceOpts();
  if (!nvA.length) throw new Error('no "no voice" option renders in this mount - the voice select is not reachable here');
  check('T-378: on a voice + clone model every no-voice control in the panel is offered, and one of them says '
      + 'plainly what it sends - no voice, no voice_ref, no reference_text',
    nvA.every(function (o) { return !o.props.disabled; })
      && nvA.some(function (o) { return /send no voice at all/.test(String(o.props.title || '')); }),
    nvA.map(function (o) { return [o.props.disabled, String(o.props.title || '').slice(0, 60)]; })[0]);
  const nvRowB = rowFor('m-clone');
  nvRowB.props.onClick(); await flush(); commit(); await flush();
  const nvB = noVoiceOpts();
  check('T-378: on a clone-only model every one of those controls is refused, and every one names the reason as '
      + 'the voice-clone family it is - offering the choice in one select and refusing it in another would be a '
      + 'refusal dressed up as a choice',
    nvB.length > 0 && nvB.every(function (o) { return o.props.disabled === true; })
      && nvB.every(function (o) { return /unavailable/i.test(ownText(o)); })
      && nvB.every(function (o) { return /voice-clone family/.test(String(o.props.title || '')); }),
    nvB.map(function (o) { return [o.props.disabled, ownText(o).slice(0, 60), String(o.props.title || '').slice(0, 70)]; }));
  const nvRowC = rowFor('m-samples');
  nvRowC.props.onClick(); await flush(); commit(); await flush();
  const nvC = noVoiceOpts();
  check('T-378: and a sample-driven clone keeps the choice everywhere too - the host does not refuse a voice-less '
      + 'job there, so the panel does not either',
    nvC.length > 0 && nvC.every(function (o) { return !o.props.disabled; }),
    nvC.map(function (o) { return o.props.disabled; }));

  console.log('=== ' + pass + ' pass, ' + fail + ' fail ===');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.log('THROW ' + (e && e.stack || e)); process.exit(1); });
