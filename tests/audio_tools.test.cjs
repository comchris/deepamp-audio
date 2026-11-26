// T-715 (tools half): drives tools/index.js with a stub agents/tools/systemPrompt/audioPlay, the
// same way host.test.cjs drives lib/index.js. What it holds the component to:
//   1. the Config the loader validates (defaults, a switch off, a wrong type refused);
//   2. per-agent registration on agent.ctx, from agents.list() AND from agent/created, removed by
//      agent/disposed AND by this component's own effect teardown;
//   3. that each tool is a ToolDefinition the harness will accept (name, description, parameters with
//      the rules on the parameter, an output declaration), and that no tool claims a deadline it cannot honour;
//   4. that every call goes to the lane verb the panel would use, marked via:'agent';
//   5. that what comes back is bounded, and that a missing answer is reported as a fault;
//   6. the standing rule for a scene render, enforced as a tools/pre-execute `ask`.
const path = require('path');
  // T-744 (2026-11-07): the suite reads the renamed key first and the name it had before that
  // date after it, so an environment that still exports the old name points this run at the
  // copy it was meant to point at. The plugin itself follows the same order.
const TOOLS = process.env.DEEPAMP_TOOLS || process.env.AUDIO_PLAY_TOOLS || path.join(__dirname, '..', 'tools', 'index.js');

// A stand-in for the host service the host half provides. Every call is recorded so a test can say
// exactly which verb the lane was asked to run, with what body, and whether it came from an agent.
function makeLane715(answer) {
  const calls = [];
  const asks = [];
  return {
    calls: calls,
    asks: asks,
    service: {
      call(verb, opts) {
        calls.push({ verb: verb, opts: opts || {} });
        return Promise.resolve(answer === undefined ? { status: 200, json: { ok: true, verb: verb } } : answer(verb, opts));
      },
      ask(action, args) {
        asks.push({ action: action, args: args || {} });
        return { ok: true, held: true, action: action };
      },
    },
  };
}

// The scoped services of one agent, and the plugin ctx that owns them. Disposal is real here: a
// disposer taken from a scoped register actually removes what was registered, because the tests that
// ask about teardown are exactly the ones that need it to be true.
function makeToolCtx(lane, agents) {
  const bag = {
    registered: [],
    sections: [],
    events: {},
    effects: [],
    agents: agents || [],
  };
  function scoped() {
    return {
      tools: {
        register(def) {
          bag.registered.push(def);
          return function () {
            const i = bag.registered.indexOf(def);
            if (i >= 0) bag.registered.splice(i, 1);
          };
        },
      },
      systemPrompt: {
        section(spec) {
          bag.sections.push(spec);
          return function () {
            const i = bag.sections.indexOf(spec);
            if (i >= 0) bag.sections.splice(i, 1);
          };
        },
        getSectionOrder(name) { return 0; },
        getContextOrder(name) { return 0; },
      },
    };
  }
  const ctx = {
    audioPlay: lane.service,
    agents: { list: function () { return bag.agents.slice(); } },
    on(ev, cb) { (bag.events[ev] || (bag.events[ev] = [])).push(cb); },
    effect(fn, label) {
      const dispose = fn();
      bag.effects.push({ label: label, dispose: typeof dispose === 'function' ? dispose : function () {} });
      return function () {};
    },
  };
  bag.newAgent = function (name) { const a = { name: name, ctx: scoped() }; bag.agents.push(a); return a; };
  bag.fire = function (ev, payload) { return Promise.all((bag.events[ev] || []).map(function (cb) { return cb(payload); })); };
  bag.byName = function (name) { return bag.registered.filter(function (d) { return d.name === name; })[0]; };
  bag.toolNames = function () { return bag.registered.map(function (d) { return d.name; }).sort(); };
  return { ctx: ctx, bag: bag };
}

(async function main() {
  const mod = await import('file://' + TOOLS);
  let pass = 0, fail = 0;
  function ok(label, cond, extra) {
    if (cond) { pass++; console.log('  PASS  ' + label); }
    else { fail++; console.log('  FAIL  ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 300) : '')); }
  }
  const NAMES = ['audio_control', 'audio_render', 'audio_status', 'audio_voices'];

  // ---- 1. the Config, through the door the loader actually uses -----------------------------
  console.log('--- T-715 a: the Config the loader validates ---');
  ok('T-715 a1: the component declares the services it needs, including the host service by name',
    Array.isArray(mod.inject) && ['agents', 'tools', 'systemPrompt', 'audioPlay'].every(function (n) { return mod.inject.indexOf(n) >= 0; }),
    mod.inject);
  ok('T-715 a2: apply and inject are exported and Config is a schema', typeof mod.apply === 'function' && !!mod.Config && typeof mod.Config['~standard'] === 'object');

  const empty715 = mod.Config['~standard'].validate(undefined);
  // (T-903 contract change, 2026-11-20, at the operator's word: "that "scene door" makes no sense to me at all, why
  // should the user have to verify the agent triggering a batch/scene render ? can we deactivate it by default ?".)
  // The four tool switches keep their `true`. The switch this card moved is `scene_guard`, and it moved to OFF.
  ok('T-715 a3 (T-903 contract change): a row that declares nothing gets the whole tool set, and the scene ask is off',
    !empty715.issues && empty715.value.render === true && empty715.value.status === true
    && empty715.value.voices === true && empty715.value.control === true && empty715.value.scene_guard === false, empty715);
  const oneOff715 = mod.Config['~standard'].validate({ control: false });
  ok('T-715 a4: one switch off is honoured, and the fields it does not name keep their defaults',
    !oneOff715.issues && oneOff715.value.control === false && oneOff715.value.render === true, oneOff715.value);
  const badType715 = mod.Config['~standard'].validate({ render: 'yes' });
  ok('T-715 a5: a switch that is not a boolean is refused with the field named',
    !!badType715.issues && badType715.issues.some(function (i) { return (i.path || []).join('.') === 'render'; }), badType715.issues);
  const guardOn715b = mod.Config['~standard'].validate({ scene_guard: true });
  ok('T-903: the ask is a switch, not a word — a row that declares scene_guard:true still gets it, and the four tool switches beside it keep their defaults',
    !guardOn715b.issues && guardOn715b.value.scene_guard === true && guardOn715b.value.render === true
    && guardOn715b.value.control === true, guardOn715b.value);
  // What the loader door really does with a name this Config does not declare (measured for T-716 in
  // the installed cordis core): the validated object CARRIES it through. So the contract to hold this
  // component to is the one that matters to a row author — an undeclared name must not act like a
  // switch, and it must not take a tool away or add one. What it does not do, and is stated rather
  // than asserted here, is write an audit line the way the host half does: the Settings page only
  // offers the five declared fields, so an undeclared name can only come from a hand-written row.
  const unknown715 = mod.Config['~standard'].validate({ not_a_tool: true });
  const laneA6 = makeLane715();
  const A6 = makeToolCtx(laneA6);
  A6.bag.newAgent('a6');
  mod.apply(A6.ctx, unknown715.value);
  ok('T-715 a6: a name this Config does not declare is carried through and changes nothing at all',
    unknown715.value.not_a_tool === true && A6.bag.toolNames().join(',') === NAMES.join(','), A6.bag.toolNames());

  // ---- 2. per-agent registration, and both ways it is removed -------------------------------
  console.log('--- T-715 b: registration is per agent, and both teardowns remove it ---');
  const laneB = makeLane715();
  const B = makeToolCtx(laneB);
  B.bag.newAgent('existing'); // an agent that is already here when the component mounts
  mod.apply(B.ctx, empty715.value);
  ok('T-715 b1: an agent that already exists when the component mounts gets the tools',
    B.bag.toolNames().join(',') === NAMES.join(','), B.bag.toolNames());
  ok('T-715 b2: the lane facts are said once, in one scoped section, not in every tool',
    B.bag.sections.length === 1 && typeof B.bag.sections[0].text === 'string', B.bag.sections.length);
  ok('T-715 b3: the section is placed inside the tool band and after its last central entry',
    B.bag.sections[0].order === 3050, B.bag.sections[0].order);

  const created715 = B.bag.newAgent('fresh');
  await B.bag.fire('agent/created', { agent: created715 });
  ok('T-715 b4: an agent created later is given the same set on its own scope',
    B.bag.registered.length === 8, B.bag.registered.length);
  await B.bag.fire('agent/disposed', { agent: created715 });
  ok('T-715 b5: disposing that agent removes what was registered on it, and only that',
    B.bag.registered.length === 4, B.bag.registered.length);
  const teardownB = B.bag.effects.filter(function (e) { return /deepamp-tools/.test(String(e.label)); })[0];
  ok('T-715 b6: the component holds its own effect, named, so unloading it is a thing that can be seen',
    !!teardownB, B.bag.effects.map(function (e) { return e.label; }));
  if (teardownB) teardownB.dispose();
  ok('T-715 b7: unloading the component removes what was registered on the agents that remain',
    B.bag.registered.length === 0 && B.bag.sections.length === 0, [B.bag.registered.length, B.bag.sections.length]);

  // ---- 3. Config gating: a switch off means that tool is not offered ------------------------
  console.log('--- T-715 c: each tool is its own switch ---');
  const laneC = makeLane715();
  const C = makeToolCtx(laneC);
  C.bag.newAgent('c');
  mod.apply(C.ctx, oneOff715.value);
  ok('T-715 c1: with control off the panel-control tool is not registered and the rest still is',
    !C.bag.byName('audio_control') && ['audio_render', 'audio_status', 'audio_voices'].every(function (n) { return !!C.bag.byName(n); }),
    C.bag.toolNames());
  const allOff715 = mod.Config['~standard'].validate({ render: false, status: false, voices: false, control: false }).value;
  const laneC2 = makeLane715();
  const C2 = makeToolCtx(laneC2);
  C2.bag.newAgent('c2');
  mod.apply(C2.ctx, allOff715);
  ok('T-715 c2: with every tool off nothing is registered, and no section describes tools that are not there',
    C2.bag.registered.length === 0 && C2.bag.sections.length === 0, [C2.bag.registered.length, C2.bag.sections.length]);

  // ---- 4. each definition is a tool the harness will accept ---------------------------------
  // Built on a context with every switch on: what a shape test describes is the shipped shape, and a
  // tool that a different test turned off is not the same claim.
  console.log('--- T-715 d: the shape of a ToolDefinition ---');
  // T-903 (2026-11-20): the shipped default now leaves the scene ask off, so the config these later blocks mount
  // names the switch ON. The shipped-default case is asserted where it belongs (g0), not assumed here.
  const allOn715 = mod.Config['~standard'].validate({ scene_guard: true }).value;
  const laneD = makeLane715();
  const D = makeToolCtx(laneD);
  D.bag.newAgent('d');
  mod.apply(D.ctx, allOn715);
  const defs = NAMES.map(function (n) { return D.bag.byName(n); }).filter(Boolean);
  ok('T-715 d1: every definition carries the fields the tool runtime asks for',
    defs.length === 4 && defs.every(function (d) {
      return typeof d.name === 'string' && typeof d.description === 'string' && d.description.length > 40
        && d.parameters && typeof d.parameters === 'object' && d.output && d.output.schema
        && typeof d.output.schema === 'object' && typeof d.output.render === 'function'
        && typeof d.execute === 'function';
    }), defs.map(function (d) { return d && d.name; }));
  ok('T-715 d2: an output declaration renders to content and declares the one thing every lane answer holds',
    defs.every(function (d) {
      const r = d.output.render({}, { ok: true });
      return Array.isArray(r) && d.output.schema.type === 'object'
        && d.output.schema.properties && d.output.schema.properties.ok;
    }));
  ok('T-715 d3: a required parameter says so on the parameter, the way the harness declares one',
    NAMES.every(function (n) {
      const d = D.bag.byName(n);
      const params = Object.keys(d.parameters);
      return params.some(function (k) { return d.parameters[k].required === true; });
    }));
  ok('T-715 d4: no tool claims a deadline it cannot honour (a lane call is not cooperatively cancellable)',
    defs.every(function (d) { return d.timeoutMs === undefined && d.isConcurrencySafe === undefined; }));
  ok('T-715 d5: every action is chosen by a parameter that names its choices out loud',
    NAMES.every(function (n) {
      const d = D.bag.byName(n);
      const keyed = Object.keys(d.parameters).filter(function (k) { return d.parameters[k].required === true; });
      return keyed.length === 1 && Array.isArray(d.parameters[keyed[0]].enum) && d.parameters[keyed[0]].enum.length > 1;
    }), NAMES.map(function (n) { const d = D.bag.byName(n); return d ? Object.keys(d.parameters).filter(function (k) { return d.parameters[k].required; }) : null; }));
  const bytes715 = defs.reduce(function (n, d) { return n + Buffer.byteLength(JSON.stringify({ name: d.name, description: d.description, parameters: d.parameters })); }, 0);
  const sectionBytes715 = Buffer.byteLength(D.bag.sections[0] ? D.bag.sections[0].text : '');
  // The count is printed from the definitions that were actually registered, never written out in words:
  // a label that names a number by hand is a second number that can disagree with the first. The real
  // comparison — this against the bytes the same reads cost through bash and curl on the running host —
  // is measured in scratch/measure_t715_token_cost.mjs and recorded on the T-715 card, not asserted here,
  // because a test that reads the live host is a test that fails when the host is not there.
  console.log('  MEASURE  ' + defs.length + ' tool definitions: ' + bytes715 + ' bytes; one scoped section: ' + sectionBytes715
    + ' bytes; total model-facing text added per agent: ' + (bytes715 + sectionBytes715) + ' bytes');
  ok('T-715 d6: the model-facing text stays under the ceiling this card set for itself (16 KB per agent)',
    bytes715 + sectionBytes715 < 16000, { bytes: bytes715 + sectionBytes715 });

  // ---- 5. every call goes to the verb the panel would use, marked as an agent call ----------
  console.log('--- T-715 e: the verbs a tool actually asks for ---');
  const laneE = makeLane715();
  const E = makeToolCtx(laneE);
  E.bag.newAgent('e');
  mod.apply(E.ctx, allOn715);
  const run715 = function (name, args) { return E.bag.byName(name).execute(args, {}); };

  await run715('audio_render', { kind: 'take', text: 'hi', voice: 'kael', model: 'm', endpoint_id: 'primary' });
  ok('T-715 e1: a take is dispatch_tts, POST, with the fields named and nothing else',
    laneE.calls[0].verb === 'dispatch_tts' && laneE.calls[0].opts.method === 'POST'
    && laneE.calls[0].opts.body.text === 'hi' && laneE.calls[0].opts.body.voice === 'kael'
    && laneE.calls[0].opts.body.endpoint_id === 'primary', laneE.calls[0]);
  await run715('audio_render', { kind: 'scene', dialogue: [{ voice: 'kael', text: 'a' }], model: 'm', title: 'p-1' });
  await run715('audio_render', { kind: 'plan', file: '/tmp/x.json', model: 'm' });
  // (T-892 contract change, 2026-11-19, TODOS item 74 closed at the operator-s answer "Refuse at the door like T-890":
  // these two calls used to lean on the host filling a transcription model. The verb mapping this assertion measures
  // is unchanged, so the model is named here and the mapping stays under test; the refusal itself is asserted in the
  // T-892 block below, against the tool, where it now happens.)
  await run715('audio_render', { kind: 'transcribe', file_path: '/tmp/a.wav', model: 'qwen3_asr' });
  await run715('audio_render', { kind: 'analysis', file_path: '/tmp/a.wav', model: 'qwen3_asr' });
  // second request path. The verbs this assertion names are unchanged for every kind that came before it.
    ok('T-715 e2: scene is dispatch_batch, plan is batch_plan, transcribe is dispatch_stt, analysis is dispatch_speaker_asr',
    ['dispatch_batch', 'batch_plan', 'dispatch_stt', 'dispatch_speaker_asr'].join(',')
    === laneE.calls.slice(1).map(function (c) { return c.verb; }).join(','), laneE.calls.map(function (c) { return c.verb; }));
  await run715('audio_status', { what: 'slots', fn: 'stt' });
  await run715('audio_status', { what: 'slot_models', fn: 'tts', id: 'e-11' });
  await run715('audio_status', { what: 'job', job_id: 'ap-1' });
  await run715('audio_status', { what: 'recent' });
  ok('T-715 e3: a read asks for the read-only verbs, with the id on the query the host reads it from',
    laneE.calls[5].verb === 'endpoint_registry' && laneE.calls[5].opts.query.fn === 'stt'
    && laneE.calls[6].verb === 'endpoint_models' && laneE.calls[6].opts.body.id === 'e-11'
    && laneE.calls[7].verb === 'job_status' && laneE.calls[7].opts.query.job_id === 'ap-1'
    && laneE.calls[8].verb === 'lane_activity', laneE.calls.slice(5).map(function (c) { return c.verb; }));
  await run715('audio_voices', { what: 'register', name: 'new-voice', file_path: '/tmp/v.wav', asr_model: 'qwen3_asr' });
  await run715('audio_voices', { what: 'remove', name: 'new-voice' });
  await run715('audio_control', { what: 'play', job_id: 'ap-9' });
  ok('T-715 e4: a voice write is save_voice / delete_voice, and a panel request goes to the held-instruction seam, not to a verb',
    laneE.calls[9].verb === 'save_voice' && laneE.calls[9].opts.body.name === 'new-voice'
    && laneE.calls[10].verb === 'delete_voice'
    && laneE.asks.length === 1 && laneE.asks[0].action === 'play' && laneE.asks[0].args.job_id === 'ap-9',
    { verbs: laneE.calls.slice(9).map(function (c) { return c.verb; }), asks: laneE.asks });
  ok('T-715 e5: every lane call says it came from an agent, which is what lets the host tell the two callers apart',
    laneE.calls.every(function (c) { return c.opts.via === 'agent'; }), laneE.calls.map(function (c) { return c.opts.via; }));
  // T-800 (2026-11-12): the agent may arm or disengage the panel's auto-generation chain, at the operator's word
  // "Suggest and be able to arm it". It goes through the same held-instruction seam as play, stop and clear,
  // because only the panel can carry it out, and the prompt section is what tells the agent the state is there to
  // read rather than to guess at.
  const agCtl715 = await run715('audio_control', { what: 'auto_gen', mode: 'on' });
  const agTool715 = E.bag.byName('audio_control');
  const agSection715 = (E.bag.sections || []).map(function (s715) { return String(s715.text || ''); }).join(' ');
  const agAsk715 = laneE.asks.filter(function (a715) { return a715.action === 'auto_gen'; });
  ok('T-800: an arm asked by the agent reaches the held-instruction seam with its mode, like every other panel request, and the prompt section names both halves of what the lane answers - the chain state and the rows it started',
    agTool715.parameters.what.enum.indexOf('auto_gen') >= 0 && !!agTool715.parameters.mode
    && agAsk715.length === 1 && agAsk715[0].args.mode === 'on'
    && /auto_gen \(armed, off, or unknown/.test(agSection715) && /auto_started/.test(agSection715),
    { enum: agTool715.parameters.what.enum, asks: laneE.asks.map(function (a715) { return a715.action; }), prompt_names_chain_state: /auto_gen/.test(agSection715), prompt_names_marked_rows: /auto_started/.test(agSection715), held: agCtl715 });

  // T-826 (2026-11-13): the operator asked what happens when a row still waiting in the queue is cleared without
  // being cancelled first, and their expectation — "that should result in a cancel prior to clear, right ?" — is what
  // the panel actually does (lib/client.js clearAllRows367 cancels every queued row before it calls playlist_clear).
  // The tool's own sentence said the opposite: "running and queued rows stay". These four read the DEFINITION an
  // agent is handed, not the source text, because the definition is what an agent acts on.
  const whatDesc826 = String(agTool715.parameters.what.description || '');
  const toolDesc826 = String(agTool715.description || '');
  const srcFile826 = require('fs').readFileSync(TOOLS, 'utf8');
  const cnt826 = function (re826) { return (srcFile826.match(re826) || []).length; };
  ok('T-826: the clear half of that parameter says what the panel does — a row still waiting is taken out of the line first, so no queued row survives a clear, and doing so costs the endpoint nothing',
    /a row still waiting in the queue is taken out of the line first/.test(whatDesc826)
    && /no queued row survives a clear/.test(whatDesc826)
    && /costs the endpoint nothing/.test(whatDesc826),
    { clear_half: whatDesc826.slice(whatDesc826.indexOf('clear retires')) });
  ok('T-826: and the sentence that was wrong is gone — no line in this component still claims a queued row stays through a clear',
    cnt826(/running and queued rows stay/g) === 0 && /no queued row survives a clear/.test(whatDesc826),
    { old_claim_count: cnt826(/running and queued rows stay/g) });
  ok('T-826: the boundary is stated beside it — a row the lane is running is left alone, and only that row-s own control stops it',
    /A row the lane is running is left alone/.test(whatDesc826) && /only its own control stops it/.test(whatDesc826),
    { boundary_named: /A row the lane is running is left alone/.test(whatDesc826) });
  ok('T-826: the fact is said once — it lives on the parameter, not in the tool description, not in the scoped prompt section, not in the Config line that offers the tool',
    cnt826(/taken out of the line/g) === 1 && !/taken out of the line/.test(toolDesc826)
    && !/taken out of the line/.test(agSection715),
    { occurrences_in_the_component: cnt826(/taken out of the line/g), in_tool_description: /taken out of the line/.test(toolDesc826), in_prompt_section: /taken out of the line/.test(agSection715) });

  // ---- 6. bounded output, and a missing answer said as a fault ------------------------------
  console.log('--- T-715 f: bounded output ---');
  const wide715 = { ok: true, items: [], note: 'x'.repeat(1200) };
  for (let i = 0; i < 40; i++) wide715.items.push({ id: 'ap-' + i });
  const laneF = makeLane715(function () { return { status: 200, json: wide715 }; });
  const F = makeToolCtx(laneF);
  F.bag.newAgent('f');
  mod.apply(F.ctx, allOn715);
  const bounded715 = await F.bag.byName('audio_status').execute({ what: 'lane' }, {});
  // 28 dropped array entries plus the one long string below = 29. The number counts every cut the
  // bound made, which is the honest figure: a count of "what was array-only" would read as a complete
  // answer to anyone wondering whether anything else was taken out.
  ok('T-715 f1: a long list is cut short, and the answer says how much it left out',
    bounded715.items.length === 12 && bounded715.bounded && bounded715.bounded.dropped === 29
    && bounded715.bounded.array_max === 12, bounded715.bounded);
  ok('T-715 f2: a long string is cut, and the cut is visible as a cut',
    bounded715.note.length <= 404 && /\.\.\.$/.test(bounded715.note), String(bounded715.note).length);
  const laneG = makeLane715(function () { return { status: 502, json: null }; });
  const G = makeToolCtx(laneG);
  G.bag.newAgent('g');
  mod.apply(G.ctx, allOn715);
  const fault715 = await G.bag.byName('audio_status').execute({ what: 'lane' }, {});
  ok('T-715 f3: a call the lane did not answer is reported as a fault, not as an empty lane',
    fault715.ok === false && /no answer/.test(String(fault715.error)), fault715);

  // A payload made of many lists is the case a per-list limit does not bound. This is the shape the
  // live model-catalog read actually has, and the second limit is what makes the answer bounded.
  const many715 = { ok: true, groups: [] };
  for (let g715 = 0; g715 < 10; g715++) {
    const rows715 = [];
    for (let i715 = 0; i715 < 12; i715++) rows715.push({ id: 'm-' + g715 + '-' + i715 });
    many715.groups.push({ name: 'g' + g715, rows: rows715 });
  }
  const laneH2 = makeLane715(function () { return { status: 200, json: many715 }; });
  const H2 = makeToolCtx(laneH2);
  H2.bag.newAgent('h2');
  mod.apply(H2.ctx, allOn715);
  const manyOut715 = await H2.bag.byName('audio_status').execute({ what: 'lane' }, {});
  // The budget counts every entry the answer carries, containers included — 10 group objects plus the
  // 30 rows that fit in what is left is 40, which is the whole point: the ANSWER has a limit.
  const inner715 = manyOut715.groups.reduce(function (n, g) { return n + g.rows.length; }, 0);
  ok('T-715 f4: many lists are bounded as one answer, not twelve at a time, and the cut is still counted',
    manyOut715.groups.length === 10 && inner715 === 30 && (manyOut715.groups.length + inner715) === 40
    && manyOut715.bounded.dropped === 90 && manyOut715.bounded.items_max === 40,
    { inner: inner715, bounded: manyOut715.bounded });
  ok('T-715 f5: a bounded answer is smaller than the answer it came from, which is the point of the bound',
    JSON.stringify(manyOut715).length < JSON.stringify(many715).length,
    { bounded: JSON.stringify(manyOut715).length, original: JSON.stringify(many715).length });

  // ---- 7. the standing rule for a scene render, enforced -------------------------------------
  // T-903 (2026-11-20, at the operator's word — quoted at a3 above): the ask is OFF unless a row declares it, so this
  // block mounts its own ctx that declares `scene_guard:true` and reads the listener from THERE. The shipped default
  // is not left unasserted: g0 reads it off B, the ctx this suite mounted from a row that declares nothing.
  console.log('--- T-715 g: a scene render asks first, when the row asks for the ask ---');
  const guardOn715g = mod.Config['~standard'].validate({ scene_guard: true }).value;
  const laneBG = makeLane715();
  const BG = makeToolCtx(laneBG);
  BG.bag.newAgent('guarded');
  mod.apply(BG.ctx, guardOn715g);
  ok('T-903: the shipped shape installs no scene ask at all — a row that declares nothing gets four tools and no gate',
    (B.bag.events['tools/pre-execute'] || []).length === 0, B.bag.events['tools/pre-execute'] || []);
  const guardEvents = BG.bag.events['tools/pre-execute'] || [];
  ok('T-715 g1 (T-903: read off a ctx that declares the switch): the component registers one tools/pre-execute listener, on the plugin ctx',
    guardEvents.length === 1, guardEvents.length);
  const SENTINEL715 = { kind: 'next-was-called' };
  const next715 = function () { return Promise.resolve(SENTINEL715); };
  const askScene715 = await guardEvents[0]({ name: 'audio_render', arguments: { kind: 'scene', title: 'b-161107' } }, next715);
  ok('T-715 g2: a scene render returns ask, with the reason the operator sees in their own language',
    askScene715 && askScene715.kind === 'ask' && !!askScene715.reason
    && askScene715.displayReason && typeof askScene715.displayReason.en === 'string' && askScene715.displayReason.en.length > 20,
    askScene715);
  const take715 = await guardEvents[0]({ name: 'audio_render', arguments: { kind: 'take', text: 'hi' } }, next715);
  const other715 = await guardEvents[0]({ name: 'bash', arguments: { command: 'ls' } }, next715);
  ok('T-715 g3: everything else goes through next(), which is what a waterfall listener that does not own the decision must return',
    take715 === SENTINEL715 && other715 === SENTINEL715, [take715, other715]);
  const laneH = makeLane715();
  const H = makeToolCtx(laneH);
  H.bag.newAgent('h');
  const noGuard715 = mod.Config['~standard'].validate({ scene_guard: false }).value;
  mod.apply(H.ctx, noGuard715);
  ok('T-715 g4: an operator who turns the guard off gets no listener — the rule is a switch, not a wall',
    (H.bag.events['tools/pre-execute'] || []).length === 0, H.bag.events['tools/pre-execute'] || []);

  // ---- 8. T-839: the tools can ask for a generated take, and a length is the caller's ---------
  {
    console.log('--- T-839: a generated take through the tools, with an optional length ---');
    const laneI9 = makeLane715();
    const I9 = makeToolCtx(laneI9);
    I9.bag.newAgent('i9');
    mod.apply(I9.ctx, allOn715);
    const run9 = function (name, args) { return I9.bag.byName(name).execute(args, {}); };
    const renderDef9 = I9.bag.byName('audio_render');
    const kinds9 = (renderDef9.parameters.kind || {}).enum || [];
    // (T-899 contract change, 2026-11-20 Berlin, `TODOS.md` part one item 83(a) at the operator-s word
    // "usually 1 - explain in more detail and tag for current - still v0.1.0". The enum was six and is seven:
    // `convert` joins the kinds it joins, in the position a new kind takes — appended, never replacing one.
    // What the assertion guarded is unchanged, and it is still the order plus the count, so a kind that
    // displaced another would still fail here.)
    ok('T-839 a1 (T-899: seven kinds now, the new one appended beside the rest): the render tool offers a generation kind, and it sits with the kinds it joins rather than replacing one',
      kinds9.join(',') === 'take,generate,scene,plan,transcribe,analysis,convert' && kinds9.length === 7, kinds9);
    ok('T-839 a2: the new kind is described as what it is — one generated take from a prompt, and the row cannot name which side of the generator answered',
      /generate is one generated take from a prompt/.test(String(renderDef9.parameters.kind.description || ''))
      && /row cannot say which side it got/.test(String(renderDef9.parameters.kind.description || ''))
      && /a generated take from a prompt/.test(String(renderDef9.description || '')),
      { kind_description: String(renderDef9.parameters.kind.description || '').slice(0, 200) });
    ok('T-839 a3: the length rule lives on the parameter it governs, and it says both halves: leaving it out takes the length the model-s record declares, naming one is never replaced',
      !!renderDef9.parameters.duration_seconds && renderDef9.parameters.duration_seconds.type === 'number'
      && /Leave it out and the length comes from that model's own capability record, named on the row/.test(String(renderDef9.parameters.duration_seconds.description || ''))
      && /a length you name is never replaced/.test(String(renderDef9.parameters.duration_seconds.description || ''))
      && /For generate: how long the take should be, in seconds/.test(String(renderDef9.parameters.duration_seconds.description || '')),
      renderDef9.parameters.duration_seconds);
    ok('T-839 a4: the prompt field names both jobs it now serves, so a caller is not left guessing which kind it is for',
      /For take: the words to render\. For generate: the prompt that says what to generate/.test(String(renderDef9.parameters.text.description || '')),
      renderDef9.parameters.text);

    await run9('audio_render', { kind: 'generate', model: 'a_gen_model', text: 'a train passing under a bridge' });
    const c9a = laneI9.calls[0] || {};
    const c9aBody = (c9a.opts && c9a.opts.body) || {};
    ok('T-839 b1: a generated take goes to the task route with task_kind gen, marked as an agent call — not to the speech route a voice take uses',
      c9a.verb === 'dispatch_task' && c9a.opts && c9a.opts.method === 'POST' && c9aBody.task_kind === 'gen'
      && c9aBody.model === 'a_gen_model' && c9aBody.text === 'a train passing under a bridge'
      && c9a.opts && c9a.opts.via === 'agent', c9a);
    ok('T-839 b2: with no length named the tool adds NO options at all — the case the host fills from the model record is left exactly as the host expects it',
      c9a.verb === 'dispatch_task' && c9aBody.options === undefined && !('options' in c9aBody), c9aBody);
    await run9('audio_render', { kind: 'generate', model: 'a_gen_model', text: 'a glass bottle breaks on a tile floor', duration_seconds: 7, endpoint_id: 'e-11' });
    const c9b = laneI9.calls[1] || {};
    const c9bBody = (c9b.opts && c9b.opts.body) || {};
    ok('T-839 b4: the named length reaches the verb as options.duration_seconds, and a pin travels with it',
      c9b.verb === 'dispatch_task' && c9bBody.options && c9bBody.options.duration_seconds === '7'
      && c9bBody.endpoint_id === 'e-11' && c9b.opts && c9b.opts.via === 'agent', c9b.opts);
    await run9('audio_render', { kind: 'generate', model: 'a_gen_model', text: 'a take with no length asked', duration_seconds: 0 });
    const c9c = laneI9.calls[2] || {};
    const c9cBody = (c9c.opts && c9c.opts.body) || {};
    ok('T-839 b5: a length of zero is not a length — it is not sent, so the record fill still applies rather than a zero reaching the engine',
      c9c.verb === 'dispatch_task' && (c9cBody.options === undefined || !('duration_seconds' in (c9cBody.options || {}))), c9cBody);
    ok('T-839 b6: a generated take carries no voice and no file — it is not a voice render and not a transcription, and the tool does not offer those fields to it',
      c9b.verb === 'dispatch_task' && !('voice' in c9bBody) && !('file_path' in c9bBody) && !('dialogue' in c9bBody), c9bBody);

    const guardI9 = I9.bag.events['tools/pre-execute'] || [];
    const genAsk9 = await guardI9[0]({ name: 'audio_render', arguments: { kind: 'generate', model: 'm', text: 'x' } }, next715);
    ok('T-839 c1: the scene guard passes a generated take through — the standing ask is about a scene or an episode, and one take is neither',
      genAsk9 === SENTINEL715, genAsk9);

    const sec9 = (I9.bag.sections || []).map(function (s) { return String(s.text || ''); }).join(' ');
    ok('T-839 c2: the lane section claims only reads a tool can actually make — no playlist read is promised to an agent, and the chain state is still said as something to read and never to guess at',
      !/[Pp]laylist/.test(sec9) && /the lane read carries auto_gen/.test(sec9) && /auto_started/.test(sec9)
      && /Read it rather than inferring it/.test(sec9), sec9.slice(0, 300));

    const srcT9 = require('fs').readFileSync(TOOLS, 'utf8');
    ok('T-839 d1: the tool speaks the length under one name only — the wire key the host reads, never the name the capability record spells — and it reaches the host through that one key',
      /options = \{ duration_seconds: String\(args\.duration_seconds\) \}/.test(srcT9)
      && !/duration_sec(?!onds)\b/.test(srcT9), { wire_key_only: !/duration_sec\b/.test(srcT9) });
  }

  // ---- 9. T-852: the four descriptions read against the host, and the facts put where they belong ----
  {
    console.log('--- T-852: the pre-release read of the tool text, and the sentences it corrected ---');
    const laneJ9 = makeLane715();
    const J9 = makeToolCtx(laneJ9);
    J9.bag.newAgent('j9');
    mod.apply(J9.ctx, allOn715);
    const runJ9 = function (name, args) { return J9.bag.byName(name).execute(args, {}); };
    const rDef = J9.bag.byName('audio_render');
    const sDef = J9.bag.byName('audio_status');
    const vDef = J9.bag.byName('audio_voices');
    const srcJ9 = require('fs').readFileSync(TOOLS, 'utf8');
    // Every claim below is a claim about the host, so every one is checked against the host source in
    // the same breath. A tool description that agrees with nothing but itself is how this drift was made.
    const HOST = require('fs').readFileSync(path.join(__dirname, '..', 'lib', 'index.js'), 'utf8');

    ok('T-852 A: a batch line-s speaker is stated as required, because the host refuses a line without one — and the sentence that promised an invented speaker is gone',
      /Every line must name its speaker/.test(rDef.parameters.dialogue.items.properties.voice.description)
      && !/invent that speaker/.test(rDef.parameters.dialogue.items.properties.voice.description)
      && /has no voice\/name — every batch line must say who speaks/.test(HOST),
      rDef.parameters.dialogue.items.properties.voice.description);

    ok('T-852 B: the model parameter says what leaving it out actually does, and the outcomes it names are the ones the host really runs (T-875 contract change, 2026-11-16: the batch half of that sentence moved — the operator-s ruling on TODOS item 62 was "No default: the caller names a model", so a scene or a plan is now one of the outcomes that is REFUSED without a model. The description and the host are still pinned to each other; only which outcome they pin moved.)',
      // (T-930 contract change, 2026-11-26, at the operator-s word "2.2 ok" on the ruling "Cut only the
      // duplication, not the warnings - the refusal text is where the fact belongs": the same rule was
      // restated per kind across the parameters of one tool. It is stated once now. Re-expressed, not dropped -
      // AGENTS.md 8.5.)
      // (T-933 contract change, 2026-11-26, at the operator-s word "fix 3" on a read of the README: the exception this
      // clause pinned was true when T-852 wrote it (2026-11-14) and died with T-890 (2026-11-19), which made an
      // unnamed take refuse at the door like every other kind — `a take needs a model named` at `lib/index.js:15367`,
      // itself pinned at `tests/host.test.cjs:2305` and driven from the tool at line 527 below. Re-expressed to what
      // the host runs now, not dropped — AGENTS.md 8.5.)
      /Leaving it out is refused for every kind, a voice take included/.test(rDef.parameters.model.description)
      && /the refusal names the read that lists what the slot serves/.test(rDef.parameters.model.description)
      // (T-892 contract change, 2026-11-19: this clause pinned the carried name on the transcription kinds. The tool
      // now refuses those kinds instead, so the same clause pins the sentence that replaced it. Re-expressed, not
      // dropped — AGENTS.md 8.5.)
      // (T-930 contract change, same ruling: that per-kind sentence is one sentence now, so this clause pins what
      // replaces it — the pointer to the read the refusal itself names. The host-side clauses below still pin the
      // door: no carried default on either leg.)
      && /audio_status \(slot_models\)/.test(rDef.parameters.model.description)
      && /if \(!body\.model \|\| !isSafeToken\(body\.model\)\)/.test(HOST)
      // T-875 contract change (2026-11-16). This clause pinned the carried default on the batch leg. The
      // operator-s ruling on TODOS item 62 was "No default: the caller names a model", so the same clause now
      // pins the opposite fact on the same two sides of the seam: the default is gone from the host, the
      // refusal that replaces it is there, and the description names that outcome. Nothing else here moved.
      // (T-930 contract change, 2026-11-26, same ruling: the per-kind sentence — scene, plan, transcription, take,
      // generate — is one sentence now, so this clause pins that sentence. The host-side clauses below still pin
      // the fact this card was about: no leg of the lane carries a carried default.)
      // (T-933 contract change, 2026-11-26, same ruling as the clause above: the voice-take exception is gone. The
      // host-side clauses here still pin the door — no leg of the lane carries a carried default.)
      && /Leaving it out is refused for every kind, a voice take included/.test(rDef.parameters.model.description)
      && !/body\.model \|\| 'moss_ttsd'/.test(HOST)
      && /a batch needs a model named/.test(HOST)
      // (T-892 contract change, 2026-11-19: this clause pinned the transcription door-s carried name on the host side.
      // The door refuses now, so the clause pins the refusal in its place and the chain fills the ruling left alone.)
      && !/body\.model \|\| 'qwen3_asr'/.test(HOST)
      && /a transcription needs a model named — this plugin carries no default for it/.test(HOST)
      && /body\.asr_model \|\| 'qwen3_asr'/.test(HOST)
      && /var sobj = \{ model: job\.model,/.test(HOST),
      rDef.parameters.model.description.slice(0, 400));

    ok('T-852 B, the behaviour half: this is a description change, not a new behaviour — an omitted model still reaches the lane exactly as it did before this card',
      (function () {
        laneJ9.calls.length = 0;
        runJ9('audio_render', { kind: 'take', text: 'no model named here' });
        runJ9('audio_render', { kind: 'generate', text: 'a door closing' });
        const b0 = (laneJ9.calls[0] || {}).opts && ((laneJ9.calls[0].opts || {}).body || {});
        const b1 = (laneJ9.calls[1] || {}).opts && ((laneJ9.calls[1].opts || {}).body || {});
        return ((laneJ9.calls[0] || {}).verb === 'dispatch_tts') && b0.model === undefined
          && ((laneJ9.calls[1] || {}).verb === 'dispatch_task') && b1.model === undefined;
      })(), laneJ9.calls.map(function (c) { return c.verb; }));

    // T-892 (2026-11-19). The agent half of the same ruling, asserted where it happens: the tool turns the omission
    // away before it asks the lane for anything, so no verb is called and no row can exist.
    laneJ9.calls.length = 0;
    const out892 = await Promise.all([
      runJ9('audio_render', { kind: 'transcribe', file_path: '/tmp/x.wav' }),
      runJ9('audio_render', { kind: 'analysis', file_path: '/tmp/x.wav' }),
      runJ9('audio_voices', { what: 'register', name: 'vv892', file_path: '/tmp/v.wav' }),
    ]);
    ok('T-892: a transcription, a speaker analysis and a voice registration each name the model they want the lane to transcribe with, or this tool refuses them without making a single lane call (TODOS item 74, the operator-s word "the tools must name the model from the slot-s catalog")',
      laneJ9.calls.length === 0 && out892.length === 3 && out892.every(function (o) {
        return o && o.ok === false && /need(s)? a model named|needs an asr_model named/.test(String(o.error || ''))
          && /slot_models/.test(String(o.error || ''));
      }),
      out892.map(function (o) { return String((o || {}).error || '').slice(0, 130); }));

    // (T-880 contract change, 2026-11-16, at the operator's batch word "4. yes, go now!" on TODOS item 47: the chain's
    // last-resort constants now carry the ids the engines answer, hyphenated. The tool text this assertion reads is
    // unchanged; only the host default it cross-checks moved spelling. Re-expressed, not dropped — AGENTS.md 8.5.)
    ok('T-852 C: on analysis the model names the transcription model, and the speaker-separation model is named as something this tool does not name — which is what the host carries',
      /On analysis this names the transcription model/.test(rDef.parameters.model.description)
      && /speaker-separation model is the lane's own and is not named here/.test(rDef.parameters.model.description)
      && /asr_model: args\.model/.test(srcJ9)
      && /var DIAR_DEFAULT_MODEL663 = 'nemotron-3-diar'/.test(HOST),
      rDef.parameters.model.description.slice(0, 400));

    ok('T-852 D: the analysis kind is described as the chain it is — the speakers separated and then each one-s words transcribed',
      /analysis reads an audio file through the speaker-tagged chain/.test(rDef.parameters.kind.description)
      && /each one's words are transcribed/.test(rDef.parameters.kind.description)
      && !/analysis separates the speakers in an audio file/.test(rDef.parameters.kind.description),
      rDef.parameters.kind.description);

    ok('T-852 E: the refusal-before-a-row claim is narrowed to the gate that exists, and the voice half moved onto the voice parameter, where the host-s own branch lives',
      !/A model or a voice the lane does not have is refused/.test(rDef.description)
      && /A model the slot does not serve is refused/.test(rDef.description)
      // (T-930 contract change, 2026-11-26, at the operator-s word "2.2 ok" on the ruling "Cut only the
      // duplication, not the warnings - the refusal text is where the fact belongs": the same rule was
      // restated per kind across the parameters of one tool. It is stated once now. Re-expressed, not dropped -
      // AGENTS.md 8.5.)
      && /A name the registry holds is used as a sample/.test(rDef.parameters.voice.description)
      && /any other name is passed to the engine as a name/.test(rDef.parameters.voice.description)
      && /pluginVoiceFor\(voice\) \? 'upload' : 'name'/.test(HOST),
      { tool_description: rDef.description, voice_description: rDef.parameters.voice.description });

    ok('T-852 F: a health read with no slot id is stated as the whole-lane read it is, and the lane field no longer claims that read needs it',
      /For slot_health it is optional/.test(sDef.parameters.id.description)
      && /covers the primary and every registered entry/.test(sDef.parameters.id.description)
      && /slot_health without it reads both/.test(sDef.parameters.fn.description)
      && /var hId = body\.id;/.test(HOST) && /if \(hId === undefined\)/.test(HOST),
      { id: sDef.parameters.id.description, fn: sDef.parameters.fn.description });

    ok('T-852 G: the voice-name shape the tool states is the shape the host enforces — underscore allowed, and the 64-character cap said out loud',
      /underscore/.test(vDef.parameters.name.description)
      && /at most 64 characters/.test(vDef.parameters.name.description)
      && /\[a-z0-9\]\[a-z0-9_-\]\{0,63\}/.test(HOST)
      && !/\[a-z0-9-\]\./.test(vDef.parameters.name.description),
      vDef.parameters.name.description);

    const descTextsJ9 = [rDef, sDef, vDef, J9.bag.byName('audio_control')].map(function (d) { return String(d.description || ''); });
    ok('T-852: each new fact is said once — none of these sentences is repeated in a tool description or in the scoped lane section',
      !descTextsJ9.some(function (t) { return /must name its speaker|Leaving it out is not one behaviour|staged to the engine as a sample/.test(t); })
      && !/must name its speaker|Leaving it out|sent to the engine as a name|For slot_health it is optional/.test(String(J9.bag.sections[0].text || '')),
      { places_checked: descTextsJ9.length + 1 });

    const shownJ9 = [rDef, sDef, vDef, J9.bag.byName('audio_control')].reduce(function (n, d) {
      return n + String(d.description || '').length + String(d.name || '').length
        + Object.keys(d.parameters || {}).reduce(function (m, k) {
          return m + k.length + String((d.parameters[k] || {}).description || '').length;
        }, 0);
    }, 0) + String(J9.bag.sections[0].text || '').length;
    // (T-899, 2026-11-20. The ratchet moves: the convert kind adds one enum entry, two parameter descriptions
    // and three door refusals to what these four tools hand an agent. This is the same form of check the hover
    // measure carries — the number is counted from the definitions that were actually registered, and a rise
    // has to be a decision written down, not a drift. Measured on this card: 9 512 bytes of definitions plus
    // 1 653 of scoped section, and the figure below is the part this assertion has always counted.)
    ok('T-852 (T-899: the ceiling rises from 9 000 to 10 000 for the conversion door, counted here and not assumed): the overhead rule this component is built to keep still holds after the additions — what these four tools and their prompt section hand one agent, counted here',
      shownJ9 > 7000 && shownJ9 < 10000, { bytes_handed_to_one_agent: shownJ9 });

    ok('T-852: no verb, no route, no parameter name, no enum value and no tool name moved — the calls still land where they landed before',
      (function () {
        laneJ9.calls.length = 0;
        runJ9('audio_render', { kind: 'scene', dialogue: [{ voice: 'a_voice', text: 'line one' }] });
        runJ9('audio_render', { kind: 'plan', dialogue: [{ voice: '', text: 'a line with no speaker' }] });
        runJ9('audio_render', { kind: 'analysis', file_path: '/tmp/a.wav', model: 'an_asr_model' });
        const verbs = laneJ9.calls.map(function (c) { return c.verb; });
        const b1 = ((laneJ9.calls[1] || {}).opts || {}).body || {};
        const b2 = ((laneJ9.calls[2] || {}).opts || {}).body || {};
        return verbs.join(',') === 'dispatch_batch,batch_plan,dispatch_speaker_asr'
          && Array.isArray(b1.dialogue) && b1.dialogue[0].voice === ''
          && b2.asr_model === 'an_asr_model' && !('model' in b2);
      })(), laneJ9.calls.map(function (c) { return c.verb; }));
  }

  // ---- 10. T-879 (2026-11-16): the lane-call grace is one named number, and it is ratcheted ----
  // The operator tracked the work of better tool-call timeouts for v0.1.2+ ("please track for v 0.1.2+
  // that we implement better timeouts for the tool calls on the plugin side to prevent stuck agents",
  // TODOS.md part one item 65, version-targets item 24). This card builds none of that. What it closes
  // is the fact named when the item was opened: the 120 000 ms lane-call grace was pinned by no suite,
  // so it could drift silently before the v0.1.2 card ever opens. Every assertion here states today's
  // shape; a card that changes one of them re-expresses it with a dated (T-NNN contract change) note
  // (AGENTS.md 8.5) — the ratchet is the notice, not the design.
  {
    console.log('--- T-879: the lane-call grace is one named number, and a tool call cannot wait past it silently ---');
    const HOSTG = require('fs').readFileSync(path.join(__dirname, '..', 'lib', 'index.js'), 'utf8');
    const TOOLSG = require('fs').readFileSync(TOOLS, 'utf8');
    const declG = HOSTG.match(/var LANE_CALL_GRACE715 = \d+;/g) || [];
    ok('T-879 a1: the lane-call grace is declared exactly once, at 120000 ms — the number the operator asked to have tracked before it changes',
      declG.length === 1 && declG[0] === 'var LANE_CALL_GRACE715 = 120000;', declG);
    const usesG = (HOSTG.match(/LANE_CALL_GRACE715/g) || []).length;
    ok('T-879 a2: the constant appears exactly three times in the host half — its declaration, the watchdog, and the error sentence it names — so a fourth use (a per-verb override, a second door) lands here as a change, not absorbed',
      usesG === 3, { occurrences: usesG });
    const callBodyG = (function () {
      const m = /function laneCall715\(verb, opts\) \{[\s\S]*?\n  \}/.exec(HOSTG);
      return m ? m[0] : '';
    })();
    ok('T-879 a3: the watchdog uses the constant and not a literal, its answer names the number it waited for, and the settled guard means a late row answer cannot overwrite the fault the caller was given',
      /setTimeout\(function \(\) \{[\s\S]*?the lane did not answer within ' \+ LANE_CALL_GRACE715 \+ ' ms' \}\);/.test(callBodyG)
      && /, LANE_CALL_GRACE715\);/.test(callBodyG) && /if \(settled715\) return;/.test(callBodyG),
      callBodyG.slice(0, 120));
    ok('T-879 a4: the grace is one number for every verb — no per-verb timeout, no per-verb branch inside the lane call — which is exactly the shape the v0.1.2 item names to change, and the change must pass through this line',
      !!callBodyG && !/timeoutMs/.test(callBodyG) && !/switch \(verb\)|verbGrace|GRACE_FOR/.test(callBodyG),
      { lane_call_body_bytes: callBodyG.length });
    ok('T-879 a5: reaching the grace is a reported fault with no cancellation attached — the answer carries only ok:false and its reason, the lane call holds no abort or cancel call, and the row stays a row the caller can read with job_status',
      /finish715\(\{ ok: false, error: 'the lane did not answer within /.test(callBodyG)
      && !/\babort\b|cancelJob|\.cancel\(/.test(callBodyG),
      { cancels_inside_lane_call: /\babort\b|cancelJob|\.cancel\(/.test(callBodyG) });
    ok('T-879 a6: the watchdog is unref-ed — waiting on the lane never holds the process open — so a stuck agent is never made into a stuck host',
      /typeof watchdog715\.unref === 'function'\) watchdog715\.unref\(\);/.test(callBodyG), callBodyG.slice(-160));
    ok('T-879 a7: the tool half still declares no timeoutMs and still says why — the word occurs once, inside that reason sentence, and nowhere as an option — so the sentence the v0.1.2 card must change is pinned where it stands',
      (TOOLSG.match(/timeoutMs/g) || []).length === 1 && !/timeoutMs\s*:/.test(TOOLSG)
      && /no tool declares a `timeoutMs` because a lane call cannot be cooperatively cancelled from/.test(TOOLSG),
      { timeoutMs_occurrences: (TOOLSG.match(/timeoutMs/g) || []).length });
  }


  // ---- T-899 (2026-11-20, `TODOS.md` part one item 83(a), the operator-s word "usually 1 - explain in more
  // detail and tag for current - still v0.1.0"): the door onto voice exchange. The host has driven this route for
  // a while (dispatch_task, task_kind "vc" — it stages the reference sample, places the row, honours a pin, and
  // refuses before a row exists on a family that cannot read a speaker reference). What was missing was the tool
  // half, so an agent reached the route only through a raw verb. ----
  {
    const laneK9 = makeLane715();
    const K9 = makeToolCtx(laneK9);
    K9.bag.newAgent('k9');
    mod.apply(K9.ctx, allOn715);
    const runK9 = function (n9, a9) { return K9.bag.byName(n9).execute(a9, {}); };
    const cvRun9 = await runK9('audio_render', { kind: 'convert', source_job_id: 'ap-7', target_voice: 'kael', model: 'a_vc_model', endpoint_id: 'e-11' });
    const cvBody9 = (laneK9.calls[0] || {}).opts || {};
    ok('T-899: convert asks the SAME task route the verb asks — dispatch_task with task_kind vc, the source row, the registered voice, the model and the pin, and nothing else in the body',
      laneK9.calls.length === 1 && laneK9.calls[0].verb === 'dispatch_task' && cvBody9.method === 'POST'
      && cvBody9.body.task_kind === 'vc' && cvBody9.body.source_job_id === 'ap-7'
      && cvBody9.body.target_voice === 'kael' && cvBody9.body.model === 'a_vc_model' && cvBody9.body.endpoint_id === 'e-11',
      { calls: laneK9.calls.map(function (c9) { return c9.verb; }), body: cvBody9.body || null });
    ok('T-899: the tool sends no sample, no path and no text of its own — the body carries five keys, which is what keeps the staging leg and the reference channel the host-s',
      JSON.stringify(Object.keys(cvBody9.body || {}).sort()) === JSON.stringify(['endpoint_id','model','source_job_id','target_voice','task_kind']),
      { keys: Object.keys(cvBody9.body || {}).sort() });
    laneK9.calls.length = 0;
    const cvNoSrc9 = await runK9('audio_render', { kind: 'convert', target_voice: 'kael', model: 'a_vc_model' });
    const cvNoVoice9 = await runK9('audio_render', { kind: 'convert', source_job_id: 'ap-7', model: 'a_vc_model' });
    const cvNoModel9 = await runK9('audio_render', { kind: 'convert', source_job_id: 'ap-7', target_voice: 'kael' });
    ok('T-899: a conversion with no source row is refused by this tool before the lane is asked for anything, and the refusal names the read that answers it',
      cvNoSrc9.ok === false && /source_job_id/.test(String(cvNoSrc9.error)) && /audio_status/.test(String(cvNoSrc9.error))
      && laneK9.calls.length === 0, { error: String(cvNoSrc9.error).slice(0, 180), calls: laneK9.calls.length });
    ok('T-899: a conversion with no target voice is refused naming the voice registry read, and the tool says plainly that it sends no sample itself',
      cvNoVoice9.ok === false && /audio_voices/.test(String(cvNoVoice9.error)) && laneK9.calls.length === 0,
      { error: String(cvNoVoice9.error).slice(0, 180) });
    ok('T-899: a conversion with no model named is refused at the door naming the slot read — this tool carries no default and invents no conversion family',
      cvNoModel9.ok === false && /slot_models/.test(String(cvNoModel9.error)) && /no default/.test(String(cvNoModel9.error))
      && laneK9.calls.length === 0, { error: String(cvNoModel9.error).slice(0, 220), calls: laneK9.calls.length });
    const k9Def = K9.bag.byName('audio_render');
    ok('T-899: the door is described where a caller reads it — the kind sentence and the tool sentence both say a conversion exists, and both say the lane stages the reference',
      /convert turns audio that already exists on the lane into a registered voice/.test(String(k9Def.parameters.kind.description))
      && /voice conversion of a row that already holds audio/.test(String(k9Def.description))
      // (T-930 contract change, at the operator-s word "2.2 ok" on the ruling "cut only the duplication, not the
      // warnings - the refusal text is where the fact belongs"): the staging mechanism left the definition on
      // purpose, so the door is checked for the kind and for the two inputs a caller must name.
      && /the row that holds the audio to convert/.test(String(k9Def.parameters.source_job_id.description))
      && /the registered voice to convert the source into/.test(String(k9Def.parameters.target_voice.description))
      && !/lane stages/.test(String(k9Def.parameters.target_voice.description)),
      { kind: String(k9Def.parameters.kind.description).slice(-180) });
    ok('T-899: the refusals carry no model name and no voice name — the door points at reads, exactly as the other kinds do, so nothing in the tool half becomes a model choice',
      !/[A-Za-z0-9_-]+_vc_model/.test(String(cvNoModel9.error)) && !/kael/.test(String(cvNoVoice9.error)),
      { model_refusal: String(cvNoModel9.error).slice(0, 120), voice_refusal: String(cvNoVoice9.error).slice(0, 120) });
    // T-900 (the pre-freeze sanity pass, 2026-11-20): the boundary the new kind sits beside. `scene_guard` is a
    // tools/pre-execute gate keyed to kind:"scene" and this card did not widen it — a conversion is one voice over
    // audio that already exists, not a batch of takes — so the SAME listener hands the scene to the operator and
    // hands the conversion on to next(). Measured through the listener itself, which is where the decision lives:
    // a tool-s own execute() is not the gate and does not reach it.
    const guardFns9 = (K9.bag.events && K9.bag.events['tools/pre-execute']) || [];
    const nextK9 = function () { return Promise.resolve({ kind: 'next-was-called' }); };
    const guardAsk9 = guardFns9.length ? await guardFns9[0]({ name: 'audio_render', arguments: { kind: 'scene', dialogue: [{ voice: 'kael', text: 'a line' }] } }, nextK9) : null;
    const guardConv9 = guardFns9.length ? await guardFns9[0]({ name: 'audio_render', arguments: { kind: 'convert', source_job_id: 'ap-8', target_voice: 'kael', model: 'a_vc_model' } }, nextK9) : null;
    const guardOther9 = guardFns9.length ? await guardFns9[0]({ name: 'bash', arguments: { command: 'ls' } }, nextK9) : null;
    ok('T-900: the operator-s-call gate is one listener, it reaches a scene and stops there — the scene is put to the operator, the new conversion kind goes on to next(), and a call for another tool is untouched',
      guardFns9.length === 1 && !!guardAsk9 && guardAsk9.kind === 'ask' && !!guardAsk9.reason
      && !!guardConv9 && guardConv9.kind === 'next-was-called'
      && !!guardOther9 && guardOther9.kind === 'next-was-called',
      { listeners: guardFns9.length, scene: (guardAsk9 || {}).kind || null, convert: (guardConv9 || {}).kind || null, other_tool: (guardOther9 || {}).kind || null });
  }

  console.log('\n=== ' + pass + ' pass, ' + fail + ' fail ===');
  process.exitCode = fail ? 1 : 0;
})().catch(function (e) { console.log('HARNESS ERROR', e && e.stack); process.exitCode = 1; });
