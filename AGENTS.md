# deepamp-audio — agent guide

The DEEPAMP audio plugin: a browser panel, the host half that places audio jobs on an audio.cpp engine running
multiple models on demand — **local or remote as the setup has it** — and a component that puts that front-end in front
of an agent as four tools. This file is the **agent-facing** guide. It carries the rules and the pointers. It does not
carry fleet state, measured history, or the operator's machine preferences — those have their own homes, named in
section 10.

## 1. Read order

1. The workspace guide `../AGENTS.md` — **the author's workspace file, not part of this package**. In an
   installed copy it is not on disk, and nothing in this package depends on it being there: it carries
   workspace-wide rules (no deletes, backups, no emojis, numbered lists, restart safety, delegation) and one
   machine owner's decisions about which machine is kept off the audio lane. A session working from an
   installed copy asks the person in front of it that question instead of reading a file it does not have.
   Everything else in this read order **is** package-local.
2. This file — what the plugin does, what it refuses, and how to work inside it.
3. `README.md` — the landing page for the plugin: what it is (one front-end for an audio.cpp engine running multiple
   models on demand) and how it is used through the panel, the four tools and the verbs, and where each document lives.
   It carries no coding quick start (operator ruling 2026-11-08: "the page should focus on the plugin and it's usage").
4. `docs/PROMPT_CODING.md` — **the doorway for coding work.** The suites and what a green run does and does not say,
   what a change needs in order to go live, the read order for a coding pass. It points at the sections of this file
   instead of restating them; this file stays the authority for the rules.
5. `docs/PROMPT_FIRST_SETUP.md` — **the doorway for a first setup.** A plugin that has just been mounted, a lane that
   has just been wired, a machine that has heard nothing from this package yet: that file carries the three test
   creations and their durations, the order they go in, how a model is chosen for each, and the local-engine routine
   with what it needs and where it stops. It carries no model name, no address and no fleet state, and it is the
   procedure an installing agent follows rather than a description of one machine.
6. `docs/` — the measured records and the section guides (section 10).
7. `CHANGELOG.md` — completed cards, newest first. An id cited in a code comment resolves here.

Open work for this plugin **is in this package**: `TODOS.md`, created 2026-11-12 at the operator's word —
**"we should create a project-internal TODOS.md file and move all open items for versions > 0.1.0 in there"**,
and on its scope: **"we should do 1+3 … but we should first try to close more cards so we have to move less and
can move more into changelog as done!"** Its part one is the open-cards index — every open item of this plugin,
one line each; its part two is the **version targets** section (v0.1.0 as it stands today, v0.1.1, v0.1.2, v0.2.0),
moved there whole from the workspace `../TODOS.md` with its item numbering unchanged, ruled by the operator
2026-11-07. The **WM cards** stay in `../TODOS.md`: they are the operator's rulings in date order and several are
cross-project, and `TODOS.md` part one points at them rather than replacing them. A card keeps its `T-` id in
`CHANGELOG.md`; the version target is written only on the TODOS line.

## 2. What is in the tree

1. `lib/index.js` — the host half: endpoint registry, per-lane queues and placement, TTS/STT and batch
   dispatch, voice registry, media capture, the audio store, the HTTP surface. Runs in the host fiber.
2. `lib/client.js` — the browser half: the DEEPAMP panel. Ships through the `./client` export and is
   loaded by the client-module scan, not by a patch row.
3. `tools/index.js` — the agent-facing component: four tools plus one scoped system-prompt section.
   Optional: the panel and every verb work without it.
4. `tools/locale/en.json` — the title and description the Bundle page shows for that component row.
5. `cordis.patch.yml` — two composition rows: `deepamp-host` and `tool-deepamp-audio`.
6. `tests/` — 26 suites. `npm test` runs them all.
7. `tests/fixture/<card>/fixture/` — the two captured engine index pages the host suite reads as fixtures. They are
   test inputs and they sit with the tests that read them. `artifacts/` is dated run output and is excluded by this
   package's `.gitignore`; these two were moved out of it on 2026-11-12 (T-816) because a clone of the package could
   not run its own suites while they lived there.
8. `docs/` — the dated measurement records (`MODELS_TABLE.md`, `MODELS_REMOTE.md`,
   `MODEL_PROVENANCE.md`, `MODELS_TEST_MATRIX.csv`, `FACTS.md`), the section guides (`DETAILS_*.md`, each with its own
   full-resolution screenshot and its guide text), the three prompt files (`PROMPT_DOC_UPDATE.md`,
   `PROMPT_CODING.md`, `PROMPT_FIRST_SETUP.md`), the superseded landing page kept as `RECORD_README_20261110_v0.1.0.md`, and `docs/screenshots/`.
9. `scripts/` — the helper scripts that drive this package's real-lane work (`agent_control.sh`,
   `batch_export.py`, `batch_part_extract.py`, `batch_verify.py`, `voice_replace.sh`, `voice_solo_probe.py`,
   `model_matrix.py`, and `canvas_log_preview.py`, which renders the canvas log a client suite records back into
   a picture — the way a drawn face is reviewed when no browser is in the loop, and never a screenshot of the
   panel). They are **not part of the plugin's runtime and no suite reads them**; `model_matrix.py` is
   the two-node model runner added 2026-11-08, and it takes its origin from the session's environment rather than
   from a constant in the file.
10. `scratch/` — this package's own working files: full-run logs, pre-change copies, measured dumps.
   Temp state, not a deliverable, and the first thing a `.gitignore` should keep out.
11. `LOCALHOSTS.md` — **this machine's names and paths**, and it is in `.gitignore` on purpose: git never tracks
    it, so it is in no clone, no tag and no published package. Machine names, this machine's absolute paths, the
    account handle and the local ids live there; every document in the repository carries a role word and points
    at it (section 8 item 10).
12. `examples/` — **a sample a session can copy, not a fixture a suite reads.** One checked-in multi-voice batch
    document (a short two-speaker scene, its dialogue taken from a scene this lane has rendered) plus the guide that
    says how to use it and what a checked-in sample must not carry: no model name, no machine name or address, no
    absolute local path, no `output_dir`, no claim to be a test. No suite reads this directory, and putting a file
    here is not adding a test input — a fixture a suite depends on lives under `tests/fixture/`. Added 2026-11-16
    to close the operator's request of 2026-11-12 (`TODOS.md` part two item 15); the card is `CHANGELOG.md` T-873.

## 3. How it mounts, and what a change needs to go live

`package.json` declares `dsh.bundle.patch`, so `cordis.patch.yml` is the composition layer.

| Row id | Name | Loads | Waits for |
|---|---|---|---|
| `deepamp-host` | `@<scope>/deepamp-audio` | `lib/index.js` via the `.` export | `webServer`, `shell`, `fs`, `timer` |
| `tool-deepamp-audio` | `@<scope>/deepamp-audio/tools` | `tools/index.js` via `./tools` | `agents`, `tools`, `systemPrompt`, `audioPlay` |

1. The browser half is not a row. A second row naming the same package would load `lib/index.js` twice
   and throw on duplicate route registration.
2. If the host row is not live, the tool row parks and registers nothing.
3. The tool row is the switch for the agent-facing half. Per-tool choice lives in that row's Config.
4. A patch row naming an `id` and a `config` **replaces** that row's config wholesale; it is not
   deep-merged. Fields it does not name keep their defaults.
5. **A client-only change goes live on a browser refresh. A host-side change needs a harness restart,
   and a restart needs the operator's explicit, per-restart OK — never taken by an agent, and never
   run from inside the session that would be killed.**
   **Ruled 2026-11-16, at the operator's word, verbatim: "stop waiting for harness restarts, just assume that
   user can do it on request and tell user when to do it by \"RESTART HARNESS NOW\"".** The shape that follows:
   a host half is built and tested as soon as it can be, and **no work is scheduled around a restart** — nothing
   is deferred, split, or held because it would need one. When a built-and-green host half is genuinely ready to
   go live, the agent says **RESTART HARNESS NOW**, names plainly what becomes live when the operator presses
   it, and keeps working on everything that does not need it. The press itself stays the operator's, per-restart,
   exactly as before — what changed is only that the agent no longer waits.

## 4. The verbs

Routes are `POST|GET /api/deepamp/<verb>`; rendered audio is served under `/deepamp`. The panel's
browser keys are `deepamp:*`.

1. A read verb sent with the wrong method gets `405 {"ok":false,"error":"method not allowed"}`. The
   method each verb accepts is pinned by `tests/verb_contract.test.cjs`, which reads the client's call
   switch and the host's gates and fails when the two disagree. **That suite is the verb reference: it
   is executable and it cannot drift.** Do not maintain a verb list in a document.
2. A refusal about the *content* of a body answers `200` with `{"ok":false,"error":"…"}` and the reason.
   Whether that should be a 4xx is an open question, not a defect to fix quietly.
3. Engine liveness is `/health`, never `/status` — `/status` blocks while an engine is rendering.
4. `endpoint_models` is **POST-only** and needs `{fn, id}`; a bare `{fn}` is refused. A GET on it is answered `405`
   like any verb sent with the wrong method — the guides that called it a GET were corrected on 2026-11-07 (WM-26),
   and `tests/host.test.cjs` pins the gate. `endpoint_promote {fn,id}` is the one
   set-as-primary verb. Registry ids are a global sequence and are never reused, so a number carries no
   meaning beyond the entry it names.
5. The four agent tools: `audio_render` (take, generate, scene, plan, transcribe, analysis, convert — the last one
   turns a row that already holds audio into a registered voice, and it asks the same task route the verbs ask),
   `audio_status` (lane,
   slots, slot health and models, one job, store, recent), `audio_voices` (list, register, remove,
   modes, measure), `audio_control` (play a row, stop, clear the playlist, arm or disengage the panel's
   auto-generation chain). Each is independently
   switchable through the tool row's Config.

## 5. Rules that stop a session doing work twice

1. **The lane is a queue, not a call that returns audio.** A dispatch answers with a job row and its id;
   the audio arrives later. Do not re-ask for a take you already hold an id for, and do not wait for
   audio inside a turn.
2. **No document names a model as the model to use.** A dispatch must name a model, and the plugin
   refuses one the target endpoint's catalog does not list. Read it: `POST endpoint_models {fn,id}` — the verb is a
   POST because it goes and asks that engine and stores what it answered — or the
   engine's own `/v1/models`. This is a workspace rule, not a style preference.
3. **No fleet state in a document, dated or not.** Which slot is `primary`, which is held, what a catalog
   answers, whether a node's unit is running: read it in the session that needs it with
   `endpoint_registry`, `endpoint_health`, `endpoint_models`, `queue_status`. What a guide may carry is a
   rule and a pointer.
4. **Answers are bounded** — 12 entries per list, 40 per answer, 400 characters of text, depth 6. A cut
   answer carries a `bounded` note that says so and tells the reader to ask for one id, one slot, or one
   path. Ask narrowly instead of re-asking broadly.
5. **`audio_control` does not act on the browser by itself.** It hands the action to the panel through
   `audioPlay.ask`, and the panel carries it out only while it is open. An action asked with no panel
   open is reported as held, not done.
6. **`dispatch_stt` blocks until its job reaches a terminal state.** A short client timeout on a
   transcription is not a failure: the row exists and is running. Fire dispatches in parallel per STT
   endpoint or poll `job_status?job_id=`, and read the transcript from the row.
7. **A placement wait is never a failure, and a refusal is never a failure against the auto-pause
   ceiling.** A queued row carries exactly one current park key: `endpoint_wait | endpoint_slot_wait |
   machine_wait | endpoint_boot_wait | endpoint_pending | batch_order_wait | lane_wait`. `lane_wait`
   names who paused the lane (`operator` or `auto_pause`). Beside whichever key it carries, a parked row also
   carries `park_reason`: one word from the closed set `endpoint_disabled | machine | slot | lane | batch_order |
   boot`, written by the gate that parks the row and cleared with the key by the stamp that places it, so a row
   never names a reason it is not in. The word says which kind of wait it is; the key names who or what it waits
   for. `loadState` deliberately never pumps at boot:
   restored rows in a forced-paused lane get their reason at the first pump event. Do not "fix" that.
   An engine's `cannot load model …: every loaded model is busy; retry later` answer is a CAPACITY answer about a
   healthy endpoint: the row parks (bounded, on the engine's own guard window) and it spends no brake, no pause and no
   ceiling credit; that park carries `endpoint_slot_wait` with `engine_hold` — the engine's own sentence — because
   there is no plugin row to name as the holder. The engine's `cannot be cancelled` answer is the other case and still
   brakes. Both halves and the measurements are in `docs/FACTS.md`, section "The engine-slot park".
8. **Placement.** Default is node-first: a candidate on a machine holding zero of the plugin's running
   jobs is chosen before one on a machine that already holds one; the same-machine second endpoint is the
   secondary option under a soft cap of 2 jobs per machine. `prefer_primary` is a persisted switch,
   default OFF, and it is a re-sort *inside* the free group, never a tier above it. A pin
   (`endpoint_id`) is evaluated alone and never falls back. A pin outranks the switch. A paused, offline
   or unknown primary is never preferred.
9. **The capability bar refuses from KNOWN capability only.** An unknown model or an unreadable capability
   page stays permissive; `force:true` steps over the bar and leaves a row note and one override record.
   A bar refusal happens before a row exists: no id spent, nothing counted against any ceiling.
   **A family-s record also names which parameters a request MUST carry, and that flag is KNOWN capability
   too** (T-877): a required option the request does not carry is refused by the same bar, on both doors —
   the speech lane and the generated-take lane — and the refusal names the parameter, says which record the
   requirement came from (the engine-s, where this side has read one; this plugin-s own dated row
   otherwise), and says whether the request carried nothing at all or carried a value this lane cannot
   send. Three things are NOT refusals under this rule, and each is the old behaviour kept: a name this
   plugin supplies itself (from the voice registry, or from its own request field) is not a missing one; a
   record that declares nothing required refuses nothing; and a family this plugin answers from its own
   empirical rows keeps the mechanism it already has. A dispatch pays no capability page read for this
   check — the tasks-lane half reads a record only where one is already held.
   **The shape of a value an option carries is read from that same record (T-885).** A parameter the record
   declares takes what it declares: an enumerated one only its listed values, a switch its yes/no words, a
   number its own bounds, a string any text up to this plugin's 4 000-character ceiling or the record's own
   smaller maximum — line breaks and brackets included. A parameter no record names keeps this lane's own
   grammar, and a capability cache that is cold is a no-answer, not a refusal. The three doors that ask the
   question — the cleaner, the note door, and the bar's own drop-preview — ask it once, through one
   function, and a refusal says which bound the value broke. What a record can do to that ceiling is tighten
   it, never lift it.
10. **Voice modes have one vocabulary**, declared once in the host: `no_voice | preset_speaker |
    clone_sample | voice_design | dialogue_positional`. A family that lists built-in voices needs a name;
    a family that lists none renders on its own voice. `GET voice_modes` answers what a model can serve
    and never refuses an unknown model.
11. **`mix_audio` is local ffmpeg**, not an engine job: one pass, no endpoint, no queue slot, no new row.
    The result is a new stem on the bed row. A multi-stem bed is chosen by stem name or by an explicit
    `stem_id`; an ambiguous one is refused with its stem list, never guessed. At most 12 layers, and any
    path must be under the plugin's store root.
12. **A wedged engine is not a failed engine.** An engine that loses its GPU context can keep answering
    `/health` with `ok` for hours while every model reads `loaded:false`, and a unit that exits
    `Result=success` is not restarted by `Restart=on-failure`. The plugin's answer is the endpoint brake,
    not a watchdog. Only a hand restart of the engine recovers the context. **And that hand may be the
    agent's (operator ruling 2026-11-08, verbatim: "please update docs so that you are always allowed to
    restart the remote endpoints after wedge or after updates without explicit user auth").** After a wedge,
    and after an update, an agent restarts the node's own unit over ssh on that node and says what it did:
    which unit, on which node, and what the restart cost — a restart drops every loaded model and any
    in-flight job on that machine's lanes, so a run in progress is invalidated by it and the slot is
    re-read (`endpoint_health`, `endpoint_models`) before anything is dispatched against it. **The restart is a
    privileged action on these units, and the privilege is read on the node, not assumed here:** a plain
    `systemctl stop|restart` asked over a non-root ssh session is refused (`Interactive authentication required` on
    one CPU node, `Access denied` on the other, measured 2026-11-08), and the privilege that makes a restart work is **read on the node and never
    assumed here**: the sudoers state that answers it is a fact about this fleet and it lives in the workspace realm
    (`LOCALHOSTS.md` of this package and the workspace index), not in this repository — so the form that works is
    `sudo systemctl restart <unit>`. **And one clarification, stated because a session gets it wrong: nothing about
    USING this plugin needs a privileged account on a remote — the lane is plain HTTP. A privileged action appears only
    where an agent installs or updates an endpoint: a build, a unit or config edit, a restart of a unit.** A refused `systemctl` is not a
    stopped engine: check the unit state after asking, because a build can run beside a server that was never stopped. What the ruling
    does **not** change, stated because the sentence it sits next to is an assertion and not a suggestion:
    the local rule stands — nothing here starts a **local** audio server or downloads a model, and a restart
    of a remote is never a substitute for a remote that is gone; if it does not answer after the restart,
    report it. An operator hold on a slot is still the operator's: restarting a held slot's unit does not
    release the hold, and the order for that lane stays "start the unit, then release the slot". The
    harness-restart rule of section 3 is untouched — that one is about this session's own process and needs
    its own per-restart OK. **Restated and widened 2026-11-12, at the operator's word: "you may always restart
    remote audio.cpp units it not in use - do not ask me for that on every update - update your docs
    accordingly".** The permission is unconditional for a remote audio.cpp unit **that is not in use** — no row
    running on it, no batch or scene in progress on that machine, nothing the operator is mid-way through. A
    session does not ask for it again at each update or each build. What the permission does not buy is
    interrupting work in progress: when a unit is in use, the restart is asked for. What it always carries is the
    rest of this item — name the unit and the node, say what the restart cost, and re-read `endpoint_health` and
    `endpoint_models` before anything is dispatched against it.
13. `scene_guard` is the switch that turns a scene or episode render into an ask rather than an agent decision. It is a
    `tools/pre-execute` gate for those kinds only; everything else passes through. **It is OFF by default since
    `CHANGELOG.md` T-903 (2026-11-20, at the operator's word): a scene the operator named is already their decision, and
    the ask duplicated it.** A row that wants the ask declares `config: { scene_guard: true }` on the tool row. The gate
    itself is unchanged, and the rule it stands for — a scene is never re-rendered without the operator saying so — is
    unchanged too: what moved is that naming the scene and the model is the saying-so.
14. **Isolating a voice is an offered step, not a stage of cloning** (operator ruling 2026-11-09, verbatim: "maybe
    should make the voice-isolation a more 'optional' task for automated voice cloning", and the shape chosen from the
    options put: agent practice only, **off unless asked**). The plugin has no isolation step and needs none —
    `save_voice` normalizes the sample and takes `reference_text` from the transcription lane, and that half is already
    optional (`transcribe:false` with a `ref_text` given). What was not optional was the agent's own pipeline. The
    expensive part of this lane is a separation pass: measured 2026-11-09 on one CPU slot, same source, one separator at
    ~2.5x realtime and another at ~20x (names, lengths and numbers: `docs/MODELS_TEST_MATRIX.csv` and `../TODOS.md`
    WM-38 item 11(f) — this file carries the ratio, not the models). So: a source that is already one clean voice is
    registered as it is, and nothing is paid for isolation. It is asked for when the source is known to carry music or
    more than one speaker, it is then done on the **shortest clip that holds the voice** — a `diar_to_chunks`
    sentence-aligned clip, not the window (WM-38 item 7(d), closed by this item) — and it lands as its own named row,
    never inside the registration. A session that skips it says it skipped it.
15. **Build hygiene on the nodes (operator ruling 2026-11-11, verbatim: "delete old audio.cpp versions to free disk
    space … we do not want to copy them over the LAN").** A superseded engine build — an old `build/<tree>` or a
    `prev_<commit>` rollback binary — is **deleted** once a newer build is running and verified on that node. The
    workspace habit of moving stale things into `OLD_ignore/` does **not** extend to node build artifacts, and copying
    them to the shared model store is not a way of keeping them either: **a move inside one filesystem frees nothing**,
    which is exactly what the first pass of this measured: the same free space before and after. The order is: build in the
    existing tree, restart the unit, verify health and catalog, re-read the slot, **then** clear the superseded build.
    What is worth keeping is the code and not the binaries — a small code-only archive of this package plus the
    workspace index files, made locally in the workspace backup directory (named at the workspace
    root; the first was made the same day: 6.9 MB, 149 entries, all 26 suites inside). **And nothing a node holds is ever archived here (operator's word 2026-11-12:
    "do NOT backup remote audio.cpp versions - those are on git").** A node's source is its own git checkout and its
    version is read from it — `git describe` on that checkout answers what it is, and a slot's own health and model
    reads answer what is running. No engine build tree, no binary and no copy of a node's checkout goes into a
    backup or onto the shared store. What is archived is this package's own code, locally, as above.
16. **The auto-generation chain is the panel's; the host relays what the panel says about it.** The panel presses
    its own generator when a take of its own finishes, and nothing in `lib/index.js` runs a chain. The panel reports
    its chain state to the host, the host holds that report **in memory**, and answers it beside the reads a caller
    already makes — `auto_gen` in `queue_status` and `playlist_list`, and `auto_started` on a row the live report
    names. Nothing of it is persisted, and when no panel has reported recently the answer says **unknown** rather
    than off: a closed panel and a disengaged chain look identical from this side, and choosing between them would
    be the plugin inventing a state. Arming it is the person's press on the panel, or the agent's through
    `audio_control {what:"auto_gen", mode:"on"}`, held for the panel like every other browser request. Do not "fix"
    the missing host-side record — that absence is the design.
17. **A generated take that names no length is filled from the model's own record.** At the moment the row's
   options reach the engine — the first point where the node is known, so the record read is that node's — a
   `gen` row carrying no length takes the number that node's capability record declares as that parameter's
   default. The row names the fill and which record it came from, the lane log carries one record per fill, and
   the panel needs no change to show it: the number lands in the row's own options. The record spells the
   parameter `duration_sec` (measured in both captured engine pages the suites read); the wire name stays
   `duration_seconds`, and only one spelling is ever sent, because the engine throws when two spellings of one
   knob disagree. **Nothing is filled, and each of these is the old behaviour kept, not a new refusal:** a
   caller that named a length under either spelling (a person's number outranks a record's); a record that is
   unreadable or declares no entry for that parameter; a default that is zero, negative or not a number — a
   non-positive `duration_sec` is the engine's own planner choosing, and a planner is not a length; a family
   whose option gate already refuses the key (controlfoley, `OPTION_DENY`); a declared default above the
   generation ceiling, which is **not** bent into the ceiling — the row says why it carries no length. **The
   ceiling gates a number a CALLER asked for; a record's default is not one, and the fill never walks through
   that gate.** The panel's two prefill numbers are browser-side and the host half holds no copy of them, so
   the fill has no plugin default and no family-name guess to fall back on: no record, no claim. **A length a
   caller names arrives as `options.duration_seconds`** — from the panel's duration field, from `audio_render`'s
   `generate` kind (T-839), or from a direct verb call — and a named length is never replaced by a fill. The
   card is `CHANGELOG.md` T-837, and the tool half of it is `CHANGELOG.md` T-839.
18. **The side a preset carries is read off its folder, and the model a preset carries is the model it was run
   with.** Two records, both read from what happened, and no third source. A prompt that came from a preset under
   `texts/presets/<folder>/` names its side — `music`, `sfx` or `tts` — and the plugin reads that off the path, the
   same reading the panel-s picker makes; a prompt typed into a field carries no side, and nothing is invented for
   it. A run records the pairing: the preset, the model that row ran on, and the time, reported back on the same
   listing that offered the preset (`used_model` / `used_side` on a `batch_text_list` entry). **Why this is not done
   by naming a model per side: no engine record names a side.** Two generator models on one slot were measured on
   the same family and the same task (`gen`), so a capability read cannot tell an effect generator from a music
   generator and a name-based guess is barred (item 3 above). What a folder a person chose IS a record of, is what
   they meant. Three consequences a session must not "improve": a pick may move the generator selection to the model
   its preset was recorded with, and it says it moved or says why nothing moved (a model the live lists no longer
   carry names itself as stale and nothing moves); a row that carries the `sfx` side is never a side a crossfade
   moves, at any length, while the length floor of T-838 stays the answer for a row nobody claimed a side for; a
   reference that is not a preset path is dropped and said on the row, and the dispatch still runs. The pairing is
   keyed by preset and not by run, bounded, and persisted with the rows. The card is `CHANGELOG.md` T-841; the
   ruling it implements is `TODOS.md` items 27 and 28.
19. **A hover is three short clauses, and a log line is one line.** A hover says what the control is, what the press
   would do, and which state decides it — in that order, and nothing else. What a dispatch checks before it acts,
   what a refusal lists, and the ways a chain can stop itself belong to the row or the line that answers, which is
   where a person actually reads them; a hover that recites them is a wall nobody reads. The same holds for a log
   record: one line naming the event and the fields a reader needs, never a serialized state object. The measure is
   executable — `tests/tooltips.test.cjs` reads every hover the panel and the player window hand out, prints the
   list, and refuses a change that adds to it — so brevity is checked, not asked for again.

20. **A held or disabled slot takes its machine with it — ask before using that machine (operator ruling 2026-11-15,
    verbatim: "…it's disabled for a reason, the GPU is in use by an LLM, so we can't use it to render currently,
    always ASK me before using disabled nodes!" — the sentence names the machine, and that name is in
    `LOCALHOSTS.md` §2).** A slot the operator
    holds is off the lane because of something no read from this side can see: the hardware behind it is doing other
    work. So the hold covers the **machine**, not only the dispatch. Nothing is sent to that slot, and nothing is
    compiled, built, benchmarked or measured on that machine either, until the operator says so for that machine — a
    build is CPU work and it competes with whatever that box is already doing. What is always allowed without asking is
    a read: `endpoint_health`, `endpoint_models`, and a read-only `git` / `systemctl show` / `ps` look over ssh. Item
    12's restart permission is not widened by this item and does not widen it — that one is a permission to restart a
    unit **that is not in use**, and a held node is a machine the operator is using for something else. The local
    reason for this particular hold is written in `LOCALHOSTS.md` §2; the open half is `TODOS.md` part one item 39.

21. **The engine's resource knobs are the agent's to set — keep `max_loaded_models` at 1 and turn idle unload on (operator ruling 2026-11-15, verbatim: "we want it usually turned on by the agent and limit loaded models to 1 for ressources").** What each one does, read in the engine rather than inferred: `max_loaded_models` keeps at most n models resident and evicts the **least recently used idle** one, `1` being what enforces one model per engine, and the engine's own default is **no limit**; `idle_unload_ms` unloads **every resident model** after that many milliseconds with no model load or run — **never one that is mid-inference**, which keeps its slot until the next pass — and the next request re-loads lazily from disk, the engine's default being **off**. **Why this pairing is the right one for this lane:** one resident model with idle unload off is the state in which a node holds a model's memory after the work has finished *and* keeps serving bytes older than a model file the engine's own webui replaced on the shared store; with idle unload on the memory is returned when the lane is quiet and the next request reads the current file. **What it costs:** the first row after a quiet period pays a cold load again — measured on a CPU node with the small effects package, 2.3–3.4 s cold against 0.9–1.1 s warm, more for a larger package — and the plugin records `elapsed_load` per row, so the cost is measurable per model rather than guessable. **Nothing in `lib/` is needed for it:** no part of the dispatch path asks whether a model is resident, `loaded_models` is a read for reporting, and the engine's own busy answer stays a park (item 7). **What it is not:** a free change. It is a key in that node's server JSON or a flag on its `ExecStart`, and it takes effect only on a restart of that unit — so item 12 governs it: unconditional when the unit is not in use, asked for when it is. The value this fleet runs is **`idle_unload_ms 1800000` — thirty minutes** (the operator's word of 2026-11-15, verbatim: "3.1 i think 30 min is fine"), and what is applied, staged or outstanding per node is `TODOS.md` part one item 44. **The engine's "drop everything you hold" is a verb of this plugin since `T-867`** — `POST /api/deepamp/unload_all_models {fn, endpoint_id?}` and one `unload all` control in the endpoint row, with the same busy refusal as the per-model verb and no dependence on what this plugin last read as loaded; what is open on that card is the read-freshness half, not the verb and not the package-id load half — that half was built by `T-870` and corrected by `T-871`: `load_model` accepts a `package_id`, and when it is named the engine's own package supplies the file and the family, because the engine bars a body that names `path` and `package_id` together and overwrites a caller's `path` either way (`docs/FACTS.md` item 17). **What that half does not carry, measured 2026-11-16 and read at `docs/FACTS.md` item 18 before it is rediscovered:** a load names no *session*, because the task and mode a body carries come from the slot's catalog entry and a model the slot does not list has none — so a family whose session is not the engine's default refuses the load, and naming the task on the engine's own verb is what makes such a package loadable. And the model a load makes listable is the model the model-list bound of `TODOS.md` item 51 dropped, because the engine appends it last: that bound was **64** when this was measured and is **128** since the operator's ruling of 2026-11-16 (`CHANGELOG.md` T-875), which covers what the engines on this fleet answer today — the silent cut above the bound and the shape of the fault (a bounded answer read as a capability bar) are still open on that item. **And before a session reports one of these knobs as unset, it reads the node:** on this fleet the value lives on the unit's `ExecStart` **drop-in**, not in the server JSON, so a config-only look reports it missing — read `systemctl cat <unit>` and the live process cmdline, and know that a drop-in edit needs `sudo systemctl daemon-reload` before a restart will see it. **The next card id is read from `CHANGELOG.md` — its newest card — not carried here** (a number written in a guide goes stale the moment a card is written; this one had fallen two cards behind when it was found on 2026-11-17). The mechanism is `docs/FACTS.md`, "How a node notices a model file changed, and what the engine's load and unload knobs do"; the engine's vanilla state and the measured load/unload round trip are `docs/FACTS.md`, "Are these engines vanilla audio.cpp?".

## 6. Configuration

Precedence for anything this plugin can be told from more than one place:
**environment > declared Config > the value the state file carries > the built-in default.** A declared
value outranks a persisted one on purpose: the patch file is the operator saying what this plugin runs
with. A key held by the environment or the Config is never written into the state file, and what the
state file already carried for it is preserved verbatim — removing a Config line returns the state the
plugin was actually given. Nothing in the code trusts a declared value before revalidating it: a value out
of range is refused and named in the boot audit, and a key the Config does not declare is carried through
unchanged but **named** there, so a typo in a patch file shows up instead of vanishing.

| Field | Type | Range / values | What it is |
|---|---|---|---|
| `store_dir` | string, absolute | — | Root of the plugin store: `tts`, `stt`, `voices`, the state file. Env `DEEPAMP_STORE_DIR`. |
| `specs_dir` | string, absolute | — | Engine model-spec JSONs read when a catalog is audited. Env `DEEPAMP_SPECS_DIR`. |
| `ytdlp_path` | string, absolute | empty leaves capture unavailable | The yt-dlp binary the media-capture lane uses. Env `DEEPAMP_YTDLP_PATH`. |
| `tts_dir` | string, absolute | — | Where rendered audio is written, inside the write policy the render route enforces. |
| `job_timeout_sec` | number | 30 … 7200 | Seconds a single engine request may run. The range was 30 … 3600 until 2026-11-16 (`CHANGELOG.md` T-876, the operator's ruling: "Widen the Config range for job_timeout_sec"); the **default is still 3600**, and what the lane runs on is read with `GET job_timeout`, never carried here. **Since `CHANGELOG.md` T-912 (2026-11-23, at the operator's word: "having to raise the value harness-wide is the wrong direction … is there no possibility for the plugin to set a different timeout on a per call basis ?") an engine request is run with no deadline from the harness shell executor and this plugin's own wall**, so the whole range is payable on any profile and **no profile setting has to be raised to make a long take payable**. The wall is re-armed against the time actually left rather than trusted once, and a cancel the row already carries is chained into it, so a hand cancel stays a cancel and never reads as a wall. Short calls — probes, model loads, ffmpeg, capture — keep the executor's deadline; their numbers sit far below it (`TODOS.md` item 63 still states plainly that the two-hour ceiling itself has not been measured on a run). **A wall on the call is not a wall on the work**: cutting the HTTP call does not stop the engine generating or free the model slot (`docs/FACTS.md`, "The engine-slot park"). |
| `generation_ceiling_s` | number | 0 … 3600 | Longest take the plugin will ask an engine for. `0` is no ceiling. |
| `perf_log` | boolean | — | Whether the plugin writes its own performance log. |
| `import_outside_store` | boolean | — | Whether importing a file that lives outside the store is allowed. |
| `takes_limit.mode` | string | `off` \| `limit` \| `auto_delete` | How the take-size cap behaves. |
| `takes_limit.max_bytes` | number | 1 MiB … 1 TiB | The byte line for that mode. |
| `stt_feed.mode` | string | `resample` \| `original` | The audio shape the transcription lane is fed. |
| `stt_feed.rate` | number | 8000 … 48000 (eight fixed rates) | Sample rate for that lane. |
| `stt_feed.channels` | string | `mono` \| `stereo` \| `source` | Channel count for that lane. |

**The transcription feed is left at its default — `resample / 16000 / mono` — on the operator's ruling of
2026-11-11, and that is the safe shape, not the best one.** It is the default because a fractional ratio to a
model's front end is the case that answers `http 200` with an **empty transcript**: a silent wrong answer, which is
worse than a slower one. **This should be adjusted upward for better quality whenever the operator states a
preference** — a higher rate, or the source's own shape, is a legitimate choice once it is a stated one, and it is
one settings write away (`GET|POST stt_feed`, eight fixed rates). A session that has a quality reason to raise it
says so and raises it; a session that has no stated preference leaves it alone. The diar lane is not covered by
this setting at all: it is 16 kHz mono always, whatever the Settings carry.

One knob is not a Config field: the per-machine job cap. It is a persisted Settings switch
(`limit_one_per_host`) overridable by `DEEPAMP_MAX_JOBS_PER_HOST` (1 … 8), and the environment
outranks the switch. The environment is offered for the three path fields only, never for policy knobs.

The environment keys are named with the package. They carried `AUDIO_PLAY_*` names until 2026-11-07, when the
operator ruled the rename ("Rename the env keys to DEEPAMP_* too"); the old names are still read, **after** the
new one, for a dated transition, and the boot audit names which key actually answered. The same applies to
`DEEPAMP_LOW_SPACE_BYTES` (the storage warning threshold, not a Config field either) and to `DEEPAMP_API` in
`scripts/`. Nothing about the precedence changed.

## 7. Where state lives

1. The plugin store under `store_dir`: rendered audio, transcriptions, voices, the state file. The default
   is `<home>/.dsh/deepamp-audio`. It was `<home>/.dsh/audio-play` until 2026-11-07, when the operator
   ruled the conversion ("we need a full conversion of the store" — to the store root named at the
   workspace root, `../AGENTS.md`, which is where this machine's path is written — then
   "yes, i would like the final change") — the ruling of 2026-11-05 that kept the store named with the old
   word was reversed by that word, and the analysis that led to it is on `../TODOS.md` WM-31 item 19. The
   move was a rename of the directory plus a rewrite of the paths the state file carries (298 literals);
   nothing was copied and nothing was deleted. A store root is a **data location**, not a package name: it
   is resolved at boot (environment, then Config, then this default) and a Config line must give an
   absolute path, because `~` is not expanded and a relative root would mean a different store depending on
   who asked.
2. The state file holds only what this plugin's own verbs were asked to change. It is not a copy of the
   Config.
3. The panel keeps its settings in the browser under `deepamp:*`. They belong to the browser, not to the
   store. The one-time carry from `audio-play:*` is `carryOldSettings718` in `lib/client.js`: it runs
   once, moves a value only where the new key is still empty, and records that it ran.
4. The panel's CSS class names were deliberately not renamed: three suites key on them, and a class name
   is not a user-visible word.

## 8. Working in this package

1. **Take a copy before you change a file**, into `scratch/` of this package, and name it after the file
   and the change. If a copy was not taken before a change, say that — do not rebuild one from a backup
   and call it the pre-change copy.
2. **Test logs and dumps go to `deepamp-audio/scratch/`** (operator ruling 2026-11-06: no test output
   into the old working tree). Nothing in `tests/` writes outside the package unless an environment
   variable names a path.
3. **Group work by code region, not by ticket number.** One chunk is one region of one file. Anchor-first
   briefs: exact `file:line` ranges, and read only those ranges.
4. **Host chunks under ~200 lines are done in the session**; delegate only large or multi-file work, and
   put a tool-call ceiling, "run only the affected suite" and a report length in the brief. While the
   fleet carries one GPU slot in play, no subagent is used in audio work at all.
5. **Never delete or weaken an assertion.** Re-express it with a dated `(T-NNN contract change)` note that
   says which ruling moved it and quotes the operator's words. A test that no longer matches the design is
   re-cut, not dropped.
6. An assertion cap of 8-12 new assertions for plumbing; heavy assertion sets only for behaviour
   contracts. Repro scripts stay out of the `*.test.cjs` glob.
7. Batch host chunks, then one restart; batch UI chunks into one client pass at the end.
8. Card identifiers and quoted operator text belong in `CHANGELOG.md` and in the tracker, not in the
   sources. Reasoning lives in the comment above the code it explains.
9. A changelog card is short: the ruling, the measured before and after, the state word. Development
   history and superseded intermediate notes do not travel.
10. **Private data is not tracked inside this repository (the operator's rule of 2026-11-15).** An account
    handle, a home directory or an absolute local path, a machine name or address, a local task id, a
    credential state, a backup location or a disk measurement does not belong in a tracked file of this
    package. **The place for them is `LOCALHOSTS.md`, which this package's `.gitignore` names**: it sits with
    the package, git never tracks it, and it carries the machine names, this machine's paths, the account
    handle and the ids. A repository document carries the **role word** ("the primary slot", "a CPU node") and
    a pointer to that file, and where a path must be named it is named in its general form
    (`<home>/.dsh/deepamp-audio`). The workspace-level form of the same rule is `../AGENTS.md`; the ruling and
    the facts moved out are `../TODOS.md` WM-53; the pass over the records written before the rule is
    `TODOS.md` part one item 38.

## 9. Tests

**A coding pass starts at `docs/PROMPT_CODING.md`** — the commands, what a green run does and does not say, and the
read order. The rules below are the authority; that file is the doorway, and it points here rather than copying this.

`npm test` runs 26 suites. They are static-and-mock: no engine is called, no audio is rendered, no server
is started, and no test writes into a real store. Every suite resolves the file it tests as
`path.join(__dirname, '..', 'lib', …)`, so the suites test the tree they are in.

1. Three files outside `tests/` are read with a real `readFileSync` and are part of the package: `docs/MODELS_TABLE.md`,
   `docs/MODEL_PROVENANCE.md`, and `docs/VERBS.md` — `tests/verb_contract.test.cjs` compares that file-s table rows
   against the routes it reads out of the host and fails when the two disagree (`CHANGELOG.md` T-893; this line said
   TWO until the pre-freeze sanity pass, `CHANGELOG.md` T-900). The two captured engine pages the host suite reads
   live inside the tests tree at `tests/fixture/…` since 2026-11-12 (T-816) and are part of the package in exactly
   the same way. A copy that leaves any of them out fails. Editing those `docs/` records is a code-adjacent change.
2. One assertion reads a real chapter file from another project, inside a `try`; when it is not there the
   suite prints that it was skipped, not passed.
3. `tests/react_shim.cjs` is the React stand-in the client suites render against. A fixture, not a
   dependency.
4. `tests/tooltips.test.cjs` reads every hover the panel and the player window hand out, prints the list with its
   lengths, and carries one assertion: the count of hovers over 3 lines and the length of the longest one may not
   rise above the numbers measured 2026-11-14. The list itself is a measure, not a failure; the ratchet is the check.
5. Never start testing without an explicit request. Never create synthetic test audio. Never overwrite
   prior results.

## 10. The document map

| Where | What lives there | Is it authority for |
|---|---|---|
| `../AGENTS.md` | workspace rules, the operator's machine preferences | what a session must do anywhere in the tree, which box is kept off the lane |
| `README.md` | the plugin and its usage: what it is, the three doors into it, where each document lives. Its superseded form is kept as a dated record, `docs/RECORD_README_20261110_v0.1.0.md` | what a person or a git host sees first. It carries no coding quick start (operator ruling 2026-11-08) and no explanation of its own pictures (operator ruling 2026-11-11) |
| this file | the rules above | how to act inside this plugin |
| `CHANGELOG.md` | completed cards, newest first | what changed and what was measured, as history |
| `docs/FACTS.md` | verified facts and dated measurements | a fact to cite instead of re-investigating — a dated line is a pointer to verify, not a current answer |
| `docs/MODELS_TABLE.md`, `docs/MODELS_REMOTE.md`, `docs/MODEL_PROVENANCE.md`, `docs/MODELS_TEST_MATRIX.csv` | the measured model records | a dated measurement, never a model choice |
| `docs/VERBS.md` | the verb table: one row per route, with the method it accepts | what a verb is named and how it is called — `tests/verb_contract.test.cjs` reads this file against the host and fails when the two disagree, so it is a test input and not a description |
| `docs/DETAILS_*.md` | one user-facing guide per panel section, with that section-s screenshot; one of them also carries a frame of the window that section opens | today: all eleven carry their guide text. The layout they take is `docs/PROMPT_DOC_UPDATE.md` section 5, re-ruled 2026-11-14 (`CHANGELOG.md` T-858, T-859, T-861) |
| `docs/screenshots/` | the images the documents actually use, one directory per plugin version | what the panel looked like in a named version. Never a debugging dump: playwright-cli's working output stays in `scratch/shots_<date>/` |
| `docs/PROMPT_DOC_UPDATE.md` | the standing instructions for a document pass | how to update README and the section guides, what a screenshot must show, how the shot files are named, the tone |
| `docs/PROMPT_CODING.md` | the doorway for a coding pass: the commands, what a green run does and does not say, what a change needs to go live, the read order | where a session that is here to change the code starts. It is a pointer file: the rules it points at are in this file, and this file stays the authority. Added 2026-11-08 at the operator's ruling that the landing page carries usage, not a coding quick start |
| `docs/PROMPT_FIRST_SETUP.md` | the doorway for a first setup: what to read before anything is dispatched, the three test creations and the lengths they are asked for, how a model is chosen for each, and the local-engine routine with what it needs and where it stops | where a session that is setting this plugin up for the first time starts. Added 2026-11-14 at the operator's word on `TODOS.md` item 24 — the starter presets stay as they are and become instructions for an installing agent, and this file is where those instructions live |
| `TODOS.md` (this package) | the plugin's open work: part one the open-cards index (one line each), part two the version-targets section moved here whole from `../TODOS.md` | what is open on this plugin, and the only place a version target is written |
| `examples/` | one checked-in multi-voice batch document and the guide that says how to use a sample and what a sample may not carry | what a batch document looks like to a session that has never built one. It is not a test input and not a fixture: no suite reads it, and a fixture belongs under `tests/fixture/` |
| `../TODOS.md` | open work as WM cards; its version-targets section is now a four-line pointer here | the operator's rulings in date order, and the cross-project cards |
| `scratch/` | this package's logs, pre-change copies, dumps | nothing. Temp state |

The layout, the naming rules and the tone rules were ruled by the operator on 2026-11-06 (WM-33) and are written
in `docs/PROMPT_DOC_UPDATE.md`. **The screenshot round was RUN 2026-11-10** against `0.1.0`: `docs/screenshots/v0.1.0/`
holds one shot per panel section plus the player-window hero, named by the rule in that prompt file, with
`manifest.json` naming where each frame came from, and README carries the hero and the section index. Working frames
that were not chosen are in `scratch/shots_20261110_docs/`. The text of the eleven `DETAILS_*.md` guides was the half
that round left open — the shots are their frames, not their content. All eleven carry it now, written 2026-11-14
under the layout re-ruled that day (`CHANGELOG.md` T-858, T-859, T-861).

## 11. Settled — do not re-litigate

1. Prefer-primary is a re-sort inside the free group, never a tier above it. Both alternatives were
   measured and rejected, and the assertion counts that proved it are stated in `docs/FACTS.md`. The archive
   those lines pointed at, `artifacts/t228_prefer_primary_20261008/`, was never carried into this package and
   lives in the source tree at `../audio-play-cordis/artifacts/` (checked 2026-11-12).
2. A capability bar that refuses from known capability, overrides with `force:true`, and stays permissive
   on unknown.
3. The endpoint brake pauses the endpoint a failing row ran on; the lane pauses only when no endpoint is
   left or a ceiling is crossed outright. A busy streak still pauses the lane — that is a decision.
4. The queue pump walks queued rows oldest-first, parks what it cannot start, and continues. A parked row
   never blocks a different endpoint.
5. Multi-speaker dialogue on the Vulkan card is not usable; single-voice on that card is. A frame budget
   bounds output length, not what the path loads, so it is not a fix for a wedge.
6. Separation models want 44 100 Hz input; feeding them a 24 kHz render fails after the model is already
   loaded. Voice reference samples are homogeneous in this registry, so sample-rate mismatch is not a
   garble explanation.
7. The plugin reads a model's quant for provenance and never gates on it.
8. **A preset control is ONE control, drawn once and mounted by every form that carries one.** The row that loads a
   preset, the name to save it under, the save doors and the clear door are one drawing shared by the music / sfx
   form and the voice form; a per-form copy of that row is the drift this rule exists to prevent, and "uniform
   across the different engine types" is the operator-s word for it (2026-11-13). Two corollaries were ruled in the
   same breath: **one load field** — a clear door acts on the preset that field is showing and carries no second copy
   of the store — and **all kinds offered in every form** ("Leave it as today: all kinds everywhere"), which is a
   decision and not an oversight, and the panel names which field a pick went to instead of moving it silently. The
   card is `CHANGELOG.md` T-830.
   **One named exception, stated so this rule is not read as a claim about every preset list in the panel: the player
   window-s quick music line offers the music side, and only the music side.** It is not a second copy of the preset
   row — it drives the same picker function and the same dispatch the form uses — but its list is the music folder
   only, and a preset under `presets/sfx/` or any other folder is not on that line and stays on the form-s own
   picker. That is the approved shape, not an oversight: the finding was raised 2026-11-14 in the client review as a
   conflict with the sentence above, and the operator-s word was "Your recommendations for 1,2,3,4 sound good,
   implement accordingly" on the recommendation to **name the line as an exception rather than widen it**. A line of
   one height in the player is not a form-s preset row, and this rule does not reach it; what the rule reaches is a
   second copy of the preset row itself. The card is `CHANGELOG.md` T-847.
9. Fleet state, addresses, ports and model choices are read, never carried. The details behind 1-8, with
   their dates and measurements, are in `docs/FACTS.md`.
