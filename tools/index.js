// DEEPAMP audio tools: four model-facing tools that drive the audio lane through the
// service the host half of this package provides (`ctx.provide('audioPlay', ...)` in
// lib/index.js).
//
// WHY THIS IS A SEPARATE COMPONENT AND NOT MORE CODE IN lib/index.js
// The DSH way of deciding who may use a tool is composition, not per-agent code: a tool belongs to
// a plugin row and the profile or the preset decides whether that row mounts (measured 2026-11-03 on
// the installed harness's shipped tool plugins: 85 `ctx.tools.register(` call sites against two each
// of `ctx.tools.restrict(` and `.guard(` — subtraction is the exception, a row is the rule). So this
// file is its own subpath plugin with its own row in cordis.patch.yml beside `deepamp-host`.
// That is what makes it work for someone who has only the default presets: they get the lane where
// they enable the row, the panel keeps working when they do not, the token cost follows a
// composition the operator controls, and nothing here depends on a private preset existing.
//
// WHAT THIS FILE DOES NOT OWN
// No audio behaviour. Every tool call goes to `lane()`, which calls the host service, which hands
// the request to the same dispatcher the browser panel's RPCs go through. The validation, the model
// catalog gate, the endpoint placement, the queue, the refusals — all of it is the plugin's existing
// single implementation, reached through a different front door. A tool that reimplemented a verb
// would be a second thing that can be wrong.
//
// WHAT THIS FILE DOES OWN
// The model-facing shape only: what to ask for, what to leave out, how much comes back, and when an
// action must ask the operator first. The card's rule is "low token overhead", and the two levers
// that decide it are the parameter rules (a model that has to guess makes an extra call, a model
// that is told does not) and the size of what a call returns (bounded, with the id or path that
// retrieves the rest, never a log or a JSON dump).
//
// The tools are registered per agent, on `agent.ctx`, and the disposer for each is held in this
// plugin's own effect too, so unloading this component and disposing an agent both remove it.
import z from '@deepseek-ai/schemastery';

// Declared so the loader parks this component until every one of these is live: the host row of
// this package provides `audioPlay`, so when that row is not mounted this one parks and registers
// nothing, instead of throwing in a profile that has no audio lane.
const inject = ['agents', 'tools', 'systemPrompt', 'audioPlay'];

// Each tool is its own switch, which is how the Settings page shows them and how an operator turns
// one off without turning the lane off. Every field is optional with a default: the loader validates
// the row config through this schema before apply() sees it, and a wrong-typed declared value throws
// at activation, so a row that declares nothing gets the whole set and a row that declares one
// boolean keeps the others at their default.
export const Config = z.object({
  render: z.boolean().default(true).description('Offer the tool that puts a job on the audio lane.'),
  status: z.boolean().default(true).description('Offer the read-only tool that reports what the lane is doing.'),
  voices: z.boolean().default(true).description('Offer the voice-registry tool.'),
  control: z.boolean().default(true).description('Offer the tool that asks the browser panel to play, stop, or clear.'),
  // T-903 (2026-11-20, at the operator's word): the default moved to OFF. The ask duplicated a decision the operator
  // had already made by naming the scene and the model, and the rule it stood for — a scene is never re-rendered
  // without the operator saying so — is what their own request satisfies. A row that wants the ask declares
  // `config: { scene_guard: true }`, and the gate itself is unchanged.
  scene_guard: z.boolean().default(false).description('Ask the operator before an agent renders a scene or episode. Off by default since T-903; declare it to turn the ask back on.'),
});

// --- the one door to the lane ---------------------------------------------------------------
// `via:'agent'` is what lets the host tell an agent-made change apart from a panel click: the lane
// records agent actions and holds agent instructions for the panel; the host side of that is the
// `via:'agent'` handling in lib/index.js. The host service's own bounded grace is what a call waits
// on; no tool declares a `timeoutMs` because a lane call cannot be cooperatively cancelled from
// here, and a deadline this code cannot honour is a claim about behaviour that is not true.
function lane(audioPlay, verb, opts) {
  return audioPlay.call(verb, Object.assign({}, opts, { via: 'agent' }));
}

// Bounded output, stated as bounded. Every verb here answers an object; arrays are cut to a length
// that fits a context and the answer says how many it left out, so a partial read is never read as
// a complete one. The id or the path a kept entry carries is how the rest is retrieved — that is
// the point of the bound, not a side effect of it.
var ARRAY_MAX715 = 12;
var ITEMS_MAX715 = 40;
var TEXT_MAX715 = 400;
var DEPTH_MAX715 = 6;

function bounded715(value) {
  var dropped = 0;
  var kept715 = 0;
  function trim(v, depth) {
    if (Array.isArray(v)) {
      // Two limits, and both are needed. Twelve out of any one list keeps a single list readable;
      // ITEMS_MAX across the whole answer is what bounds the ANSWER, because a payload made of many
      // lists is not bounded by a per-list limit — measured on the running lane, the model-catalog
      // read has enough arrays inside it that 12 per list still lands near 17 KB. The count of what
      // was left out is reported either way, so a short answer never reads like a complete one.
      var room715 = Math.max(0, Math.min(ARRAY_MAX715, ITEMS_MAX715 - kept715));
      var keep715 = v.slice(0, room715);
      kept715 += keep715.length;
      if (v.length > keep715.length) dropped += v.length - keep715.length;
      return keep715.map(function (x) { return trim(x, depth + 1); });
    }
    if (v && typeof v === 'object') {
      if (depth >= DEPTH_MAX715) { dropped++; return '[deeper than ' + DEPTH_MAX715 + ' levels — ask for one id]'; }
      var out = {};
      Object.keys(v).forEach(function (k) { out[k] = trim(v[k], depth + 1); });
      return out;
    }
    if (typeof v === 'string' && v.length > TEXT_MAX715) { dropped++; return v.slice(0, TEXT_MAX715) + '...'; }
    return v;
  }
  var trimmed = trim(value, 0);
  if (dropped > 0) {
    if (trimmed && typeof trimmed === 'object' && !Array.isArray(trimmed)) {
      trimmed.bounded = { dropped: dropped, array_max: ARRAY_MAX715, items_max: ITEMS_MAX715,
        note: 'this read was cut short. Ask for one id, one slot, or one path for the full record.' };
    } else {
      trimmed = { value: trimmed, bounded: { dropped: dropped } };
    }
  }
  return trimmed;
}

// The canonical output declaration every tool must carry. The values are the lane's own answers,
// which differ per verb, so the schema declares the shape an answer holds — an `ok` — without
// requiring it: a bounded answer comes back wrapped. A caller of the tool is given the render, not
// the value, so the render says the answer — and the bound above is what keeps that text a size.
function jsonOut715() {
  return {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: { ok: { type: 'boolean' } },
    },
    render: function (_args, value) { return [{ type: 'text', text: JSON.stringify(value) }]; },
  };
}

// A tool's answer is the lane's answer, bounded. A call that could not reach the lane at all is
// said as a fault rather than as an empty result, because an empty result reads like "nothing is
// running" and that is a different fact.
function laneAnswer715(answer) {
  if (!answer || !answer.json) {
    return { ok: false, error: 'the lane gave no answer' + (answer && answer.status ? ' (http ' + answer.status + ')' : '') };
  }
  return bounded715(answer.json);
}

// --- the four tools -------------------------------------------------------------------------
// Each definition below follows one rule set: describe behaviour rather than implementation, put a
// parameter's rule on the parameter, state each fact once, and leave out the constraints that are
// obvious from the parameter's own name and type. The names are the ones agreed for this lane, and a
// tool name is part of its contract: renaming one changes what every session has already been told.

function renderTool715(audioPlay) {
  return {
    name: 'audio_render',
    description:
      'Put one job on the DEEPAMP audio lane: a single-voice take, a generated take from a prompt, a multi-voice scene, a plan for a scene, a transcription of an audio file, or a voice conversion of a row that already holds audio. The lane queues its work — the answer is the job row and its id, and the audio arrives later, never in this conversation. A model the slot does not serve is refused.',
    parameters: {
      kind: {
        type: 'string', required: true,
        enum: ['take', 'generate', 'scene', 'plan', 'transcribe', 'analysis', 'convert'],
        description:
          'What kind of job. take is one voice speaking text. generate is one generated take from a prompt — music or a sound effect, whichever side of the generator the model you name serves; the row cannot say which side it got. scene is a multi-voice dialogue rendered as a batch. plan works a scene out and answers what it would do, dispatching nothing. transcribe turns an audio file into text. analysis reads an audio file through the speaker-tagged chain: the speakers are separated and each one\'s words are transcribed. convert turns audio that already exists on the lane into a registered voice: source_job_id names the row holding the audio, target_voice names the voice to convert into.',
      },
      text: { type: 'string', description: 'For take: the words to render. For generate: the prompt that says what to generate.' },
      voice: {
        type: 'string',
        description:
          'For take: a voice name from the registry (audio_voices, list). Leave it out for a model that needs no voice. A design model takes no voice at all — its voice is shaped by instructions, and a voice given with it is dropped. A name the registry holds is used as a sample; any other name is passed to the engine as a name, and a refusal about it is the engine\'s, after the row exists.',
      },
      instructions: { type: 'string', description: 'For a design model: how the voice should sound.' },
      duration_seconds: {
        type: 'number',
        description:
          'For generate: how long the take should be, in seconds. Leave it out and the length comes from that model\'s own capability record, named on the row; a length you name is never replaced.',
      },
      model: {
        type: 'string',
        description:
          'A model the slot this job aims at actually serves. Read it with audio_status (slot_models) first — naming a model from memory is the usual reason a dispatch is refused. On analysis this names the transcription model; the speaker-separation model is the lane\'s own and is not named here. Leaving it out is refused for every kind, a voice take included, and the refusal names the read that lists what the slot serves.',
      },
      file_path: { type: 'string', description: 'For transcribe and analysis: an absolute path to an audio file the plugin may read.' },
      dialogue: {
        type: 'array',
        description: 'For scene and plan: the ordered lines of the scene. Give either dialogue or file, not both — a dialogue array is used when both are present.',
        items: {
          type: 'object',
          properties: {
            voice: { type: 'string', description: 'A registry voice name for this line. Every line must name its speaker: a line with no voice is refused before any part row exists.' },
            text: { type: 'string', description: 'What this speaker says. A [S1]-style marker at the front is removed: the lane writes those markers itself.' },
          },
        },
      },
      file: { type: 'string', description: 'For scene and plan: an absolute path to a batch document the plugin can read.' },
      source_job_id: {
        type: 'string',
        description:
          'For convert: the row that holds the audio to convert — from audio_status (recent), or a row this session dispatched.',
      },
      target_voice: {
        type: 'string',
        description:
          'For convert: the registered voice to convert the source into (audio_voices, list).',
      },
      title: { type: 'string', description: 'For scene and plan: the name the render is filed under.' },
      endpoint_id: {
        type: 'string',
        description:
          'Only when the operator has named a slot: primary, or an e-<digits> id from audio_status (slots). A pin is evaluated alone and never falls back to another slot. Leave it out and the lane places the job itself.',
      },
    },
    output: jsonOut715(),
    execute: function (args) {
      var kind = args.kind;
      if (kind === 'take') {
        return lane(audioPlay, 'dispatch_tts', { method: 'POST', body: {
          text: args.text, voice: args.voice, model: args.model, instructions: args.instructions,
          endpoint_id: args.endpoint_id,
        } }).then(laneAnswer715);
      }
      // A generated take goes to the task route, not the speech route: it is the one lane where the
      // plugin's own placement, ceilings and option rules apply. A length is sent only when one was named,
      // and it goes under options.duration_seconds — the key the host's ceiling gate and option gate read.
      // With no length named nothing is added here, which is the case the host fills from the model record.
      if (kind === 'generate') {
        var genBody715 = { task_kind: 'gen', model: args.model, text: args.text, endpoint_id: args.endpoint_id };
        var genLen715 = Number(args.duration_seconds);
        if (args.duration_seconds !== undefined && args.duration_seconds !== null && isFinite(genLen715) && genLen715 > 0) {
          genBody715.options = { duration_seconds: String(args.duration_seconds) };
        }
        return lane(audioPlay, 'dispatch_task', { method: 'POST', body: genBody715 }).then(laneAnswer715);
      }
      if (kind === 'scene' || kind === 'plan') {
        var body = { model: args.model, dialogue: args.dialogue, file: args.file, title: args.title, endpoint_id: args.endpoint_id };
        return lane(audioPlay, kind === 'scene' ? 'dispatch_batch' : 'batch_plan', { method: 'POST', body: body }).then(laneAnswer715);
      }
      // T-892 (TODOS item 74, the operator-s answer of 2026-11-19: "Refuse at the door like T-890 — the tools must name
      // the model from the slot-s catalog"). The host door refuses an unnamed transcription now; this half refuses one
      // before the tool asks the lane for anything, and names the read that answers the question.
      if ((kind === 'transcribe' || kind === 'analysis') && !String(args.model || '')) {
        return Promise.resolve({ ok: false, error: 'a transcription and a speaker analysis both need a model named — this tool carries no default for it. Read what the slot you aim at serves with audio_status {what:"slot_models", fn:"stt"} and name one of those.' });
      }
      if (kind === 'transcribe') {
        return lane(audioPlay, 'dispatch_stt', { method: 'POST', body: {
          file_path: args.file_path, model: args.model, endpoint_id: args.endpoint_id,
        } }).then(laneAnswer715);
      }
      if (kind === 'analysis') {
        return lane(audioPlay, 'dispatch_speaker_asr', { method: 'POST', body: {
          file_path: args.file_path, asr_model: args.model, endpoint_id: args.endpoint_id,
        } }).then(laneAnswer715);
      }
      // T-899 (TODOS part one item 83(a), the operator-s word of 2026-11-20: "usually 1 - explain in more detail
      // and tag for current - still v0.1.0"). Voice exchange — turning audio that already exists into a registered
      // voice — is a route the host door has driven for a while (dispatch_task, task_kind "vc"): it stages the
      // reference sample, places the row, honours a pin, and refuses before the row exists on a family that cannot
      // read a speaker reference at all. What was missing was the door on the agent side, so the route was reachable
      // only through a raw verb — and a raw verb leaves to the caller the things this plugin already knows how to do.
      // Nothing new is built here: this maps onto the same verb, so there is one request path, one staging leg, one
      // capability bar, rather than a second copy of them living in the tool half.
      if (kind === 'convert') {
        // Three refusals at the door, each naming the read that answers the question, none of them carrying a
        // default. This is the shape T-890 and T-892 settled for the other kinds: refuse before the lane is asked
        // for anything, and never invent a model — a tool cannot know which family a model name belongs to, and a
        // guess about a conversion family is exactly the fault the host bar exists to stop.
        if (!String(args.source_job_id || '')) {
          return Promise.resolve({ ok: false, error: 'a conversion needs the row that holds the audio — source_job_id. Read it with audio_status (recent), or name a row this session dispatched.' });
        }
        if (!String(args.target_voice || '')) {
          return Promise.resolve({ ok: false, error: 'a conversion needs a target voice — a registered voice name, from audio_voices (list). This tool sends no sample and no path: the lane stages the voice-s own sample onto the endpoint that renders the take.' });
        }
        if (!String(args.model || '')) {
          return Promise.resolve({ ok: false, error: 'a conversion needs a model named — this tool carries no default for it. Read what the slot you aim at lists with audio_status (slot_models); the lane refuses a model that slot does not list, and refuses a family that cannot read a speaker reference, before a row exists.' });
        }
        return lane(audioPlay, 'dispatch_task', { method: 'POST', body: {
          task_kind: 'vc', model: args.model, source_job_id: args.source_job_id,
          target_voice: args.target_voice, endpoint_id: args.endpoint_id,
        } }).then(laneAnswer715);
      }
      return Promise.resolve({ ok: false, error: 'unknown kind' });
    },
  };
}

function statusTool715(audioPlay) {
  return {
    name: 'audio_status',
    description:
      'Read what the audio lane is doing now: what is queued or running, which slots exist, whether a slot answers, what one slot serves, or one job by its id. A read changes nothing. A long list is cut short and says how much it left out; the id or path it names is how you get the rest.',
    parameters: {
      what: {
        type: 'string', required: true,
        enum: ['lane', 'slots', 'slot_health', 'slot_models', 'job', 'models', 'storage', 'recent'],
        description:
          'lane is queue state across both lanes, including which machines already hold jobs. slots is the endpoint registry for one lane. slot_health probes whether a slot answers, right now. slot_models is what one slot serves (needs id). job is one job row (needs job_id). models is the plugin\'s model audit across its slots. storage is what the store holds. recent is what the lane tools have already done.',
      },
      fn: { type: 'string', enum: ['tts', 'stt'], description: 'Which lane. slots and slot_models need it; lane answers both lanes at once; slot_health without it reads both.' },
      id: { type: 'string', description: 'For slot_models: the slot to ask about, from slots — primary, or an e-<digits> id. For slot_health it is optional, and with no id that read covers the primary and every registered entry of the lane it is asked of.' },
      job_id: { type: 'string', description: 'For job: the row id, as a render answer or a recent entry named it.' },
    },
    output: jsonOut715(),
    execute: function (args) {
      var what = args.what;
      if (what === 'lane') return lane(audioPlay, 'queue_status', {}).then(laneAnswer715);
      if (what === 'slots') return lane(audioPlay, 'endpoint_registry', { query: { fn: args.fn || 'tts' } }).then(laneAnswer715);
      if (what === 'slot_health') return lane(audioPlay, 'endpoint_health', { method: 'POST', body: { fn: args.fn, id: args.id } }).then(laneAnswer715);
      if (what === 'slot_models') return lane(audioPlay, 'endpoint_models', { method: 'POST', body: { fn: args.fn, id: args.id } }).then(laneAnswer715);
      if (what === 'job') return lane(audioPlay, 'job_status', { query: { job_id: args.job_id } }).then(laneAnswer715);
      if (what === 'models') return lane(audioPlay, 'models_audit', {}).then(laneAnswer715);
      if (what === 'storage') return lane(audioPlay, 'storage_status', {}).then(laneAnswer715);
      if (what === 'recent') return lane(audioPlay, 'lane_activity', { query: { since: 0 } }).then(laneAnswer715);
      return Promise.resolve({ ok: false, error: 'unknown what' });
    },
  };
}

function voicesTool715(audioPlay) {
  return {
    name: 'audio_voices',
    description:
      'The voice registry this plugin holds: list it, register a voice from a WAV the plugin can read, remove one, ask what kind of voice request a model can serve, or measure how much of a voice sample is sound. A voice is a name plus the sample and transcript this plugin stores; nothing here is copied to an engine by hand.',
    parameters: {
      what: {
        type: 'string', required: true,
        enum: ['list', 'register', 'remove', 'modes', 'measure'],
        description:
          'list is the registry as this plugin holds it. register adds a voice from a sample. remove takes one out. modes answers what kinds of voice request one model can serve. measure reports how much of a voice sample is sound rather than silence.',
      },
      name: { type: 'string', description: 'For register: the new name — letters, digits, underscore and hyphen, starting with a letter or digit, at most 64 characters. The same shape gates the speaker a batch line names. For remove and measure: the voice to act on.' },
      file_path: { type: 'string', description: 'For register: an absolute path to a WAV the plugin can read.' },
      asr_model: { type: 'string', description: 'For register: the transcription model that reads the sample for its reference text. A model the slot does not serve is refused.' },
      model: { type: 'string', description: 'For modes: the model to ask about.' },
      fn: { type: 'string', enum: ['tts', 'stt'], description: 'For modes: which lane the model is on. Leave it out to ask about the tts lane.' },
      all: { type: 'boolean', description: 'For measure: true measures the whole registry once instead of one voice.' },
    },
    output: jsonOut715(),
    execute: function (args) {
      var what = args.what;
      if (what === 'list') return lane(audioPlay, 'voice_registry', {}).then(laneAnswer715);
      if (what === 'register') {
        // T-892: registering a voice asks the lane to transcribe the sample, so this tool names the model that does it.
        if (!String(args.asr_model || '')) {
          return Promise.resolve({ ok: false, error: 'register needs an asr_model named — this tool carries no default for it. Read what the transcription slot serves with audio_status {what:"slot_models", fn:"stt"} and name one of those.' });
        }
        return lane(audioPlay, 'save_voice', { method: 'POST', body: {
          name: args.name, file_path: args.file_path, asr_model: args.asr_model,
        } }).then(laneAnswer715);
      }
      if (what === 'remove') return lane(audioPlay, 'delete_voice', { method: 'POST', body: { name: args.name } }).then(laneAnswer715);
      if (what === 'modes') return lane(audioPlay, 'voice_modes', { query: { fn: args.fn || 'tts', model: args.model } }).then(laneAnswer715);
      if (what === 'measure') return lane(audioPlay, 'voice_speech_probe', { method: 'POST', body: { name: args.name, all: args.all } }).then(laneAnswer715);
      return Promise.resolve({ ok: false, error: 'unknown what' });
    },
  };
}

function controlTool715(audioPlay) {
  return {
    name: 'audio_control',
    description:
      'Ask the browser panel to do its own transport: play one finished take, stop what it is playing, or clear its finished rows. It can also arm or disengage the panel\'s auto-generation chain (auto_gen with a mode). The instruction is held for the panel and carried out only while the panel is open — the answer says that, instead of claiming it happened.',
    parameters: {
      what: {
        type: 'string', required: true,
        enum: ['play', 'stop', 'clear', 'auto_gen'],
        description:
          'play starts one finished row in the panel (needs job_id; a queued or failed row has no take to hear). stop is the panel\'s own stop button: it stops the take, or the station when the station is what is playing. clear retires finished rows; a row still waiting in the queue is taken out of the line first, so no queued row survives a clear, and that costs the endpoint nothing. A row the lane is running is left alone — only its own control stops it. No audio file is deleted.',
      },
      mode: { type: 'string', description: 'For auto_gen only: "on" arms the panel\'s chain (its next press of generate is what starts it, which is the shape that control has) or "off" disengages it. Rows the chain already dispatched keep running either way. auto_gen without a mode is refused.' },
      job_id: { type: 'string', description: 'For play: the id of a finished row, from an audio_render answer or audio_status (recent).' },
    },
    output: jsonOut715(),
    execute: function (args) {
      var held = audioPlay.ask(args.what, { job_id: args.job_id, mode: args.mode });
      return Promise.resolve(bounded715(held));
    },
  };
}

// --- the standing rule that is enforced rather than remembered --------------------------------
// A scene or an episode is never re-rendered without the operator's word, and the rule is enforced
// rather than remembered: a `tools/pre-execute` listener is where that belongs — it may await, and it
// may answer `ask`, which is the decision that puts the question to the operator before the call
// runs. A `ctx.tools.guard()` cannot do it — a guard is synchronous and can only deny. The listener
// owns nothing else, so every other call goes straight through `next()`, which is what a waterfall
// listener that does not own the decision must return.
// T-903 (2026-11-20): what this gate is mounted ON is now something a row declares. The shipped default is off, so
// the rule is carried by the operator naming the scene and the model, and this listener is what an operator adds
// when they want the question asked out loud before the call runs.
function sceneGuard715(ctx) {
  ctx.on('tools/pre-execute', function (exec, next) {
    if (exec.name !== 'audio_render') return next();
    var args = exec.arguments || {};
    if (args.kind !== 'scene') return next();
    return Promise.resolve({
      kind: 'ask',
      reason: 'a scene or episode render is the operator\'s call, not the agent\'s',
      displayReason: {
        en: 'Render this scene or episode? A scene is rendered as a batch of takes, and the standing rule is that one is never re-rendered without the operator saying so.',
      },
    });
  });
}

// The lane-level facts no single tool definition can carry. Kept short on purpose: the rules of each
// tool live in that tool's own description and parameters, and repeating them here would be a second
// place for the same fact to drift.
// No central section name fits an audio lane (the central allocation ends at MCP_SERVERS 3100 and
// resumes at TOOLS_SDK 5000), so this position is chosen inside the tool band, after its last
// central entry. A number is a plain number in that allocation; ties are broken by section name.
var LANE_SECTION_ORDER715 = 3050;

function laneSection715(scoped) {
  return scoped.systemPrompt.section({
    name: 'deepamp:lane',
    order: LANE_SECTION_ORDER715,
    text:
      'The DEEPAMP audio lane is a queue, not a call that returns audio: a render answers with a job id and the lane runs it, so do not wait for audio inside a turn and do not ask again for a take you already hold an id for. What the lane holds — its slots, what each one serves, its voices, its settings — is the operator\'s control surface: read it with the audio tools rather than assuming it.'
      + 'Auto-generation is the panel keeping a generation running ahead of what is playing. Its state is reported to you: the lane read carries auto_gen (armed, off, or unknown when no panel is reporting), and a row the chain started carries auto_started on it. Read it rather than inferring it - a chain lives in a browser and this plugin runs none. After a first setup you have done for the operator (an endpoint that answers and a take that came back well) it is worth mentioning once, in plain words, as something they can turn on: arming it is their press, or yours through audio_control (auto_gen, mode on) while the panel is open, and the chain starts on the next press of a generation control either way.'
      + 'On a first run - a slot that has just been added, a voice registry that is empty, a lane that has rendered nothing yet - the procedure is a document in this package: docs/PROMPT_FIRST_SETUP.md, the same file the agent guide points at. It carries the three test creations in order and the length each one is asked for, how a model is chosen for each from the catalog rather than from that file, and the routine for an engine on this machine with what it needs and where it stops. Read it before setting a machine up instead of inventing an order of your own.',
  });
}

// --- per-agent installation -----------------------------------------------------------------
// Registered on the agent's own scope, so one agent's tools are removed with that agent, and held
// here as well, so unloading this component removes them too. Both halves are needed: unloading a
// plugin does not by itself dispose what was registered on an agent context.
function install(agent, ctx, config) {
  var scoped = agent.ctx;
  var audioPlay = ctx.audioPlay;
  var disposers = [];
  var register = function (disposer) { disposers.push(disposer); };
  try {
    // The section is about the tools. With none of them mounted it would describe a lane this agent
    // has no way to touch, so it is registered only when at least one tool is.
    if (config.render || config.status || config.voices || config.control) register(laneSection715(scoped));
    if (config.render) register(scoped.tools.register(renderTool715(audioPlay)));
    if (config.status) register(scoped.tools.register(statusTool715(audioPlay)));
    if (config.voices) register(scoped.tools.register(voicesTool715(audioPlay)));
    if (config.control) register(scoped.tools.register(controlTool715(audioPlay)));
  } catch (e) {
    for (var i = disposers.length - 1; i >= 0; i--) { try { disposers[i](); } catch (e2) { /* already gone */ } }
    throw e;
  }
  return function () {
    for (var j = disposers.length - 1; j >= 0; j--) { try { disposers[j](); } catch (e3) { /* already gone */ } }
  };
}

function apply(ctx, config) {
  var resolved = {
    render: config.render !== undefined ? config.render : true,
    status: config.status !== undefined ? config.status : true,
    voices: config.voices !== undefined ? config.voices : true,
    control: config.control !== undefined ? config.control : true,
    scene_guard: config.scene_guard !== undefined ? config.scene_guard : false,   // T-903: off unless a row declares it
  };
  var installed = new Map();
  var maybeInstall = function (agent) {
    if (installed.has(agent)) return;
    installed.set(agent, install(agent, ctx, resolved));
  };
  for (var agent of ctx.agents.list()) maybeInstall(agent);
  ctx.on('agent/created', function (payload) { maybeInstall(payload.agent); });
  ctx.on('agent/disposed', function (payload) {
    var dispose = installed.get(payload.agent);
    if (dispose) dispose();
    installed.delete(payload.agent);
  });
  if (resolved.scene_guard) sceneGuard715(ctx);
  ctx.effect(function () {
    return function () {
      installed.forEach(function (dispose) { dispose(); });
      installed.clear();
    };
  }, 'deepamp-tools.scopedTools()');
}

export { apply, inject };
