# PROMPT_FIRST_SETUP — for a session that is setting this plugin up for the first time

This file is the doorway for a **first setup**: a plugin that has just been mounted, or a machine whose
audio lane has just been wired, or a person who has just installed this package and has heard nothing from
it yet. It is the sibling of `PROMPT_CODING.md` (a pass that changes the code) and `PROMPT_DOC_UPDATE.md`
(a pass that updates the documents). A session pointed here is here to **prove the lane works, in the order
a person would notice it**, and to report what it found.

## 1. Read order for a first setup

1. `AGENTS.md` (**package-local**, in the installed copy) — section 3 (how the plugin mounts and what a
   change needs to go live), section 4 (the verbs), section 5 (the rules that stop a session doing work twice).
   One thing it points at is **not** in the package and is not meant to be: `LOCALHOSTS.md` carries one
   machine's names, paths and ids and is gitignored on purpose. An installing session does not go looking for
   it — the equivalent answer here is `GET endpoint_registry`, which names this machine's slots.
2. `../AGENTS.md` (**the author's workspace file, not part of the package**). In an installed copy it is not
   there, and nothing in this procedure depends on it. What it holds that a setup could ever want is the
   operator's preference about which machine is kept off the lane — a decision, so it is **asked of the person
   in front of you**, never inferred from a file you do not have.
3. `docs/FACTS.md`, section "What a fresh install of this package actually gets" — what a new install has
   and does not have. Read it before anything is dispatched, so nothing here is a surprise.
4. This file — the procedure and the three test creations.
5. `docs/PROMPT_CODING.md` only if the setup turns into a code change.

**Installing this package is not a harness restart.** A bundle installed or enabled through the plugin manager
is applied to the live profile and the panel comes up with it; the restart sentence in `AGENTS.md` §3 is about a
**host-half code change already sitting in the tree** — the file `lib/index.js` is loaded when the harness boots,
so a changed tree needs the operator to restart, which is a different situation from an install and is never a
reason to restart a machine that only installed the package.

**One host requirement, and it is not the engine's:** the machine running the plugin needs `ffmpeg`, and
`ffprobe` where a file is read. Voice samples are normalized there, formats are converted there, and a bed is
mixed there — none of that is an engine job (`AGENTS.md` 5.11). Where that is missing the row says so plainly
(`ffmpeg is not found on the host running this plugin`); an engine that renders perfectly next to a host without
ffmpeg still cannot register a voice.

## 2. What to read before you dispatch anything

Nothing in this file names a model, an address or a port, and nothing you write about the setup should
either. Every one of those is read in the session that needs it:

1. `GET endpoint_registry?fn=tts` and `?fn=stt` — what slots exist, which are enabled, which the operator
   is holding.
2. `POST endpoint_health {fn,id}` — whether a slot answers. Liveness is `/health`, never `/status`.
3. `POST endpoint_models {fn,id}` — what that engine actually serves. A dispatch naming a model that list
   does not carry is refused, so the list is the choice-maker and this file is not.
4. `GET voice_modes?model=` and `GET voice_registry` — what kind of voice a model serves, and what voices
   exist. **A fresh install has zero voices**: every clone mode needs a sample registered first, and a model
   that declares its own speakers is the only path a new setup can render on without one.
5. `GET storage_status` — where the store is and what is in it.
6. `GET batch_text_list` — the presets that exist, and beside each one the model it was last run with and the side its
   folder names. A fresh install has never run a preset, so those fields are empty and a pick moves nothing: the pairing
   is written by a run, not by a document (`AGENTS.md` 5.18).

## 3. The three test creations, in this order

The order is not decoration. The first line is the one a person recognises as "the plugin is working", and
the last is the one that costs the most lane time. The durations are the ones the operator named for this
procedure (2026-11-14): the voice line is not given a length at all, the effect is asked for **5 seconds**,
and the music track is asked for **3 minutes**.

**The three starters ship with the package.** Their titles, as the picker shows them: under the voice folder
**"Deepamp, it really whips the lamas ass!"**, under the effect folder **"deepamp starter - the lama"**, under
the music folder **"deepamp starter - trance"**. A store that has none of them gets them written into
`texts/presets/<folder>/` the first time the preset list is read (`CHANGELOG.md` T-907, at the operator's word
"we should ship with our presets we defined as first setup play items , voice + sfx + music"); a starter a
person already has is left exactly as it is, so a setup that edited one keeps its edit. A starter is an ordinary
preset file: it can be renamed, edited or deleted, and nothing about the procedure depends on the name.

1. **The voice line, first.** The starter preset under the voice folder is picked and rendered as a plain
   single-voice take: **no length is named** — a spoken line renders at the length the words take. The
   model is the small speech package named in **§5 item 4**, or — if that node carries nothing from the set —
   the smallest speech model its catalog does list; the slot's own list stays the gate (`AGENTS.md` 5.2).
   The speaker is **that model's own default speaker** —
   the built-in the engine declares for it — not a registry clone, because a new setup has no registry yet.
   A model that declares no speakers at all is not the model for this step; say so and pick another.
2. **The effect, second.** The starter preset under the effect folder is picked and rendered with
   **`duration_seconds: 5`**. The prompt of that starter is a short caption that names **one** sound and says what
   must not be in it. That is the shape the operator ruled on 2026-11-15 (`CHANGELOG.md` T-866), and it **reverses
   the one-word rule this file carried** — a one-word prompt was measured answering with music, and a caption naming
   one event answered with the sound. Keep it to one event, and keep the length short: a longer window is filled with
   silence, not with more of the sound. The ten renders behind this are in `docs/FACTS.md`, "What an effect prompt
   has to say for the stable-audio family to answer it". A generator family that refuses a length (the option
   gate drops the key and the row says it was dropped) is a different shape of model — read the row's note
   instead of forcing the number. The generator for this step is the small effect package named in §5 item 4 —
   a five-second test does not need the largest generator the node carries, and the load and the download are both
   paid by the package size.
3. **The music track, third.** The starter preset under the music folder is picked and rendered with
   **`duration_seconds: 180`**. Then **offer the person a second and third take of the same prompt** and let
   them keep the one they like: a generated take is not deterministic, and the first one of a prompt is not
   necessarily the one. The operator's own words for why this is part of the procedure, recorded on
   `CHANGELOG.md` T-840: "not every generation is Beethoven". Say plainly what a repeat costs — a
   three-minute take is three minutes of the lane, and with one model resident per endpoint it is three
   minutes nothing else on that slot can use.

**One model per step, and what a switch costs.** With one model resident per endpoint (`AGENTS.md` 5.21),
**every different model across these three steps is a cold load**, and the first row after a quiet period pays it.
Measured on one CPU node on 2026-11-24 for the same one-sentence ask: a 289 MB speech package loaded in 2.9 s and
generated in 3.1 s; a 2.7 GB one in 21.4 s; a 5.9 GB one in 38.1 s. The set in §5 item 4 exists partly for that
reason. A slow first row after a quiet period is the load and not a fault — read `elapsed_load` off the row before
reporting anything.

**What a pick does, and what it does not.** The panel reads the side a preset carries off the folder it lives in and
prefills the length from that side — 5 s under the effect folder, 180 s under the music one — and the pick says out
loud what it wrote. A session going through the verbs names the number itself, which is what §4 item 2 asks for. What a
pick does not do in a first setup is choose the generator: with no pairing recorded nothing moves, and the panel says
that rather than leaving you to guess. The generator comes from the catalog read in §2 item 3, and a session says why it
chose the one it chose.

**A fourth creation is not part of this procedure.** A first setup proves the speech lane and the generator
lane. A multi-voice batch scene and a transcription are separate checks with their own costs, and they are
not asked for here.

## 4. Lengths: who decides what

1. A length a person or a session **names** is sent, and it is never replaced.
2. A generated take that names **no** length is filled from the model's own capability record, and the row
   names the record it came from (`AGENTS.md` section 5 item 17, `CHANGELOG.md` T-837). A first setup that
   wants the numbers above **names them**; it does not rely on that fill.
3. The generation ceiling gates a length a caller asked for. If a named length is over the ceiling the
   request is refused and says what the ceiling is — that is not a defect to work around by asking for less
   without telling the person.

## 5. Running a local engine: the localhost routine, measured 2026-11-14

Local or remote is the setup's choice, and this plugin cannot tell the difference and does not care
(`docs/FACTS.md`, "Where an audio.cpp engine runs"). What the plugin never does is start an engine,
download a model or install a service — so a local setup is an **agent action outside the plugin**, and it
needs the operator's word before a session does it. **And no helper script for any of it ships in this package** —
not for starting an engine, not for restarting one, not for building one. Node administration lives outside the
repository, on the node, with that node's own scripts; this package talks HTTP. The measured shape of that routine, from the run
recorded in `CHANGELOG.md` T-840:

1. **Build.** The engine is its own checkout and its own build tree; a built tree carries
   `build/bin/audiocpp_server`. A node's version is read from that checkout, never from a document.
2. **Config.** The server **refuses to start without `--config`**, and a static config with an **empty
   `models` array is refused unless `ui_management` is enabled** — the engine's own answer says so.
   `ui_management` on a build that has the native model manager lets a server run with no models declared
   and install them later.
   **The same door is what makes a clone or a convert possible at all.** A voice sample is staged to the engine
   with `POST /v1/ui/upload`, and that route is served only while the engine runs with its WebUI on **or** with
   `--ui-management` on; with neither, the engine answers `UI uploads are disabled`, the sample never gets there,
   and no voice can be registered or converted against that slot (`CHANGELOG.md` T-908). A setup that is going to
   clone turns one of the two on — and a setup that will not can leave both off.
3. **Model root.** With `ui_management` on, the model root defaults to **`<directory of the binary>/models`**,
   and the server **fails at boot if a file sits at that path** ("cannot create directories: Not a
   directory"). Measured on a checkout where `build/bin/models` was a 0-byte file. The root can be moved at
   runtime by the engine's own models-root verb; it is not a plugin setting.
   **A shared network path for models is an installation choice, not a requirement, and an installing agent should
   treat it as optional.** The engine reads its models from its own model root, and that root defaults to a directory
   beside the binary on that machine. A mount that several nodes read — the shape this fleet runs, where one downloaded
   package serves several engines and the same file is not copied to each box — is model **re-use over a network share**,
   and a setup with a local model directory on each node needs no share at all. Nothing in this plugin asks for one: the
   lane is HTTP, and a model path is the engine's business. Mounting a share, like a build or a unit edit, is node
   administration and not a plugin step.
 4. **Put the models there with the engine's own manager — a step the agent runs, on the node.** The tool that
   installs a package lives in that node's checkout: `tools/model_manager_v2.py` (`list`, `info`, `sizes`,
   `installed`, `install`, `uninstall`, `clean-partial`). The global flag comes first — `--specs-dir <checkout>/model_specs` —
   and `--models-root <root>` belongs to the sub-command; getting that order wrong is the usual first failure.
   The sequence, all of it run on a node on 2026-11-24: `installed` to see what is there; `sizes <id> …` for the
   cost **before** paying — it answers `size_bytes`, `installed` and `version_state` from the download source, and
   it answers for packages that are not on the machine too; `install <id> --models-root <root> --dry-run`; then
   `--check` to verify the remote files without downloading, then the install itself, with `--progress` when the
   download is worth watching; `clean-partial` if a download broke. Then `POST endpoint_models {fn,id}` — a model
   the engine has never been told about is not a model this plugin can be given.
   **Which packages: the set this package suggests, by role.** The node-s own spec directory is the authority for
   what exists — measured on 2026-11-24: 153 spec files on one node against 130 in a checkout on the DSH host, so
   read the node and never a copy — and the slot-s catalog stays the gate (`AGENTS.md` 5.2). What this package
   suggests for the three creations, with what each costs:

   | Step | Suggested package | Size | Status on this lane |
   |---|---|---|---|
   | the voice line | `kitten_tts_mini_0_8_orig` | 289 MB | **proven** — rendered through the starter line on 2026-11-24: load 2.9 s, generated 3.1 s, 4.07 s of audio |
   | the voice line, if a smaller package is wanted | `pocket_tts_english_q8_0` | 134 MB | **not rendered here** — prove it before relying on it; its prompt handling moved upstream in the same week |
   | the effect | `stable_audio_3_small_sfx_q8_0` | 1.68 GB | **proven** — the 5 s starter prompt answered 5 s: load 1.9 s, generated 22.0 s on a CPU node |
   | the music track | `stable_audio_3_medium_q8_0` | 3.58 GB | **proven** — a 300 s take answered in 1 532 s on a CPU node |

   A package that node-s specs do not offer is skipped and said; nothing in this table overrides the node. **What
   is deliberately not in the set:** the large effect and music packages on the same nodes (12.6 GB, 10 GB, 8.4 GB,
   7.7 GB) and the 5.9 GB speech package. Those are work choices for a real job. A first setup that reaches for one
   of them has paid a download and a cold load to prove a wiring, which is exactly what this section is meant to
   avoid.
5. **The wall on a long take is this plugin-s own.** An engine request from this plugin is a shell call, and since
   `CHANGELOG.md` T-912 it is run with **no deadline from the harness executor** (`onExpiry: 'none'`) and with this
   plugin-s own wall instead — `job_timeout_sec`, default 3600 s, Config range 30 … 7200, read with
   `GET job_timeout`. Nothing in the profile has to be raised to make a long take payable. What this replaced is
   worth one line of history because an installing agent will otherwise be told the opposite by older notes: on a
   stock profile the executor ends a shell call at 600 000 ms, and a first **music** take on a CPU node — which
   runs past ten minutes before it answers — was cut at ten minutes with no answer from the engine at all. Short
   calls (probes, model loads, the ffmpeg legs) keep the executor-s deadline, and that is safe because every one of them
   asks for a number well under 600 000 ms — the largest is 300 000 ms, and `tests/host.test.cjs` refuses any call that
   asks for more without going through the own wall. The **capture download** is the exception and now follows the
   same rule as an engine request: it asks 900 000 ms, which is above the stock clamp, so it runs with no executor
   deadline and this plugin-s own wall at that 900 s, and the row names the capture wall (`CHANGELOG.md` T-930). A row
   that ends at the wall names the wall, and the number it named is read with `GET job_timeout`
   (`AGENTS.md` 6, `CHANGELOG.md` T-908 for the wording of that row).
6. **Start and probe the engine directly.** `GET /health` answers the backend and how many models the config
   declares; `GET /v1/models` lists them with `loaded:false` until one is loaded. A model whose path does
   not exist on that machine is listed anyway — which is how you see the difference between "the engine is
   healthy" and "the engine has something to render".
7. **Then the plugin half.** `endpoint_add {fn,url}` → `POST endpoint_health {fn,id}` → `POST endpoint_models
   {fn,id}`. All three worked against a local CPU server on this host. The registry id it got was a new one
   from the global sequence, and it was enabled by default — **an enabled slot takes placements**, so a test
   slot is removed or paused as soon as the test is over, and the registry is re-read to show it is gone.
   `route` on that verb defaults to `speech`; the other answer is `tasks` — `speech` is the single-voice render
   path (`/v1/audio/speech`) and `tasks` is the tool-job path (`/v1/tasks/run`), so a slot that is to serve
   generated takes, cloning or transcription on an engine that answers there is added with `route: "tasks"`.
   Read which route that engine answers on; do not read it off a version number.
   **A promote drops that slot's catalog read.** `endpoint_promote {fn,id}` moves the entry to the primary lane
   and discards the model list read against `e-<n>`, so the procedure **ends** with `POST endpoint_models
   {fn:"tts", id:"primary"}` and the same for `stt` — the list every later step reads is `primary`.
8. **Where the routine stops without a model.** A dispatch pinned to that slot reached the engine and came
   back with the engine's own sentence carried through unchanged: `model path does not exist: <the path the
   config names>`. That is the whole boundary: build, config, start, register, health, catalog and dispatch
   all work with no model present; only the render does not.
9. **What a local render needs is a model file on that machine**, and on this host the shared model store is
   not mounted and no model file sits under the home directory. Say that plainly rather than copying
   gigabytes over the network without being asked.
10. **Clean up after the test.** `endpoint_remove` (or `endpoint_pause`) the slot you added, re-read
   `endpoint_registry` and show the answer, and stop the server you started. A failed test row stays in the
   lane with its error, and that is fine — a slot left enabled is not.

## 6. What to report when the setup is done

1. The row ids, in order, each with its status, the length it asked for and the length it produced.
2. Which slot each row ran on and which model answered — read from the row, not from what you meant to
   dispatch.
3. For the generator rows, whether a length was filled by the plugin and from which record.
4. What failed, in the engine's own words, and whether it was a capacity answer, a capability refusal or a
   missing model.
5. What you left changed: a slot added or removed, a preset read, the pairing a preset run wrote, nothing else.
6. If a row was **cut** rather than answered, say which wall cut it, and say it from the row: an engine row is cut
   at this plugin-s own `job_timeout_sec`, which the row names, and the number it names today is read with
   `GET job_timeout` (`CHANGELOG.md` T-912; the wording that names the wall is T-908). Say
   with it that a cut call does not stop the engine generating: the slot reads free while the node is still
   working on the take (`AGENTS.md` 6).
7. The last thing a setup leaves is a **fresh catalog of the primary slot on both lanes** — `POST endpoint_models
   {fn:"tts", id:"primary"}` and the same for `stt` — taken after any promote, because a promote discards the
   list read against the numbered slot (§5 item 7).

## 7. What this file deliberately does not carry

1. No model name, no address, no port, no count of slots, no statement about which machine is in play.
   Those are read (§2), and a document that carries them is wrong the next time the setup changes.
   **The one exception is the suggested package set in §5 item 4**, at the operator-s word of 2026-11-24: this file
   may name suggested packages **by role** and say what each costs. Nothing else in the package names a model, and
   even here the node is the gate — a suggestion is not a choice, and a package that node does not offer is skipped
   and said.
2. No version number and no target. Version targets live in `TODOS.md`.
3. No promise that a first setup is fast. A three-minute generated take is a lane reservation, and with one
   resident model per endpoint it is the most expensive line in this file.
4. No silent extra steps. A voice isolation pass, a batch scene, a transcription, a benchmark: none of them
   is part of a first setup, and a session that does one says which and why.
5. No name of a machine, no path of this machine, no account handle and no local id. A first setup is the same
   procedure on any machine; the names that make it run on this one are in `LOCALHOSTS.md`, which git does not track,
   and a store root is written as `<home>/.dsh/deepamp-audio` (`AGENTS.md` 8.10, the operator's ruling of 2026-11-15).
