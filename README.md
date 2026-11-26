a [DSH-Plugin](https://github.com/deepseek-ai/deepseek-harness) as control for [audio.cpp](https://github.com/0xShug0/audio.cpp) engines.
**A WIP vibe-coding hobby project, shared with the other apes.** This is not a product page.
This Third-party content is independently maintained and is NOT reviewed or endorsed by DeepSeek.
Please verify its source and assess any risks before using it.

![The DEEPAMP player window](docs/screenshots/v0.1.0/hero_player_music.png)

## 1. Humanoid-UI-sections

0. Player-window — includes DOT-MATRIX-Display-technology, 24h-clock, infinite music generation button 
1. [Playlist](docs/DETAILS_PLAYLIST.md) — One line per job/file. Optional: import of external streams
2. [Models](docs/DETAILS_MODELS.md) — Model database imported from audio.cpp
3. [Voices](docs/DETAILS_VOICES.md) — Local voice sample generation and tracking
4. [TTS / MUSIC / SFX](docs/DETAILS_TTS_MUSIC_SFX.md) — Manually trigger generation jobs
5. [TTSD, multi-speaker batch](docs/DETAILS_TTSD.md) — Multi-speaker-batch-processing
6. [STT, transcription](docs/DETAILS_STT.md) — Transcription and speaker ID extraction
7. [Auto-play Agent Session](docs/DETAILS_AUTOPLAY.md) — Auto-play DSH agent session output
8. [Advanced (Options, Remux)](docs/DETAILS_ADVANCED.md) — import of remote advanced model options
9. [Settings](docs/DETAILS_SETTINGS.md) — UI/UX tuning to Your liking
10. [Endpoints](docs/DETAILS_ENDPOINTS.md) — Machine/IP/Port/Engine catalog and health
11. [Logs](docs/DETAILS_LOGS.md) — Diagnosis, debug

**Where an engine runs is the setup's choice and not a rule of this package** 
   Nothing in this package is a speech engine. [audio.cpp](https://github.com/0xShug0/audio.cpp)
   is the C++ audio inference framework built on ggml, and it is what answers a request. What this package carries is
   the front-end in front of it: the panel, the endpoint registry, the queues and placement rules, the voice registry,
   the media capture, the audio store, and the four agent tools.  
**Multi-node job scheduling** A dispatch answers with a row and its id, not with audio. Jobs are placed across the
   slots that exist: a candidate on a machine holding none of this plugin's running jobs is chosen before one on a
   machine that already holds one. Allows ASYNC job processing across multiple CPUs/GPUs in the LAN. 
**What you can ask it for**
   1) A single-voice take in a registered voice — `audio_render {kind:"take", text:"Hello from DEEPAMP.", voice:"ent_data"}`.
   2) A music or effect take from a prompt, with a length named or not —
      `audio_render {kind:"generate", model:"…", text:"rain on a tin roof", duration_seconds:5}`. A take that names no
      length is filled from that model's own engine record, and the row says which record it came from.
   3) A multi-voice scene, rendered as bounded takes across the "TTSD" endpoints —
      `audio_render {kind:"scene", dialogue:[{"voice":"voy_doctor","text":"…"},{"text":"…"}]}`. 
   5) A transcription, which separates the speakers and transcribes each one.
   6) A preset under `texts/presets/<folder>/`: the prompt, the side its folder names, and the model that preset was
      last run with, reported back on the same listing that offered it.
**A voice registry that belongs to this front-end.** Voices are registered from a WAV the plugin can read, the
   plugin transcribes the sample for its reference text with the transcription model the caller names - `register` refuses
   without one — and a clone-sample is staged to the target engine before it is asked
   for; the authority for that number is `audio_voices {what:"list"}`.
**An endpoint registry** Which slot exists, whether it answers, what it serves, what it is
   holding: read with `endpoint_registry`, `endpoint_health`, `endpoint_models`, `queue_status`. 
**Four agent tools, each switchable on its own in DSH Plugin config.** A call needs no model name and no endpoint id: this front-end
   places the job and refuses what it cannot place.
**optional: Media imports with yt-dlp.** 

## 2. Architecture

1. **Async by construction.** Every dispatch returns a row, not a sound. Rows queue per slot, a row names the slot
   it is waiting on, and a row no slot can take says so instead of failing quietly. 

2. **CPU nodes, GPU nodes, or integrated GPU.** A node is only a machine with an engine built for the
   hardware it has — the same source, the same verbs, the same catalog shape. A CPU build needs no graphics hardware
   at all and renders several times slower than the take is long. [docs/MODELS_TEST_MATRIX.csv](docs/MODELS_TEST_MATRIX.csv)

3. **What a set costs: RAM, VRAM, disk.** 

   **a. Simple, fast, no clone — text-only TTS and STT.** Two small audio.cpp packages. The smallest served
   speech-synthesis packages are 181 MB, 288 MB and 343 MB, and the smallest transcription packages are 39 MB, 160 MB
   and 242 MB. **Disk: under 1 GB. RAM: 2 GB carries either one with headroom, 4 GB is comfortable.** VRAM: all of
   them fit an 8 GiB integrated GPU with a wide margin.

   **b. Cloning in good quality, plus music.** An effect-and-music pair plus a cloning package. Measured: the two
   Stable Audio 3 packages are 3.4 GB (Medium) and 1.6 GB (Small SFX); the Qwen3 TTS cloning packages in that
   directory are 2.7 GB, 4.0 GB and 6.6 GB by variant. **Disk: 8 GB to 12 GB for the set. RAM: 8 GB to 16 GB, sized
   by the largest single package you intend to load, not by the set.** VRAM: on 8 GiB each of these loads at q8
   except the 6.6 GB variant. GTT (Vulkan mapped RAM) works, too. 

   **c. TTSD multi-speaker, music and conversion — a working set of about ten packages.** Measured in that directory:
   the multi-speaker dialogue packages are 9.7 GB and 31.8 GB; the voice-conversion packages are 1.2 GB and 3.0 GB;
   the foley package is 12.0 GB; a longer-form story package is 18.1 GB; two index-and-conversion packages are 7.9 GB
   each; speaker counting is 190 MB to 404 MB. **Disk: 60 GB to 120 GB, and the quant you pick is most of that
   number — the same dialogue family is 31.8 GB in one build and 9.7 GB in another.** RAM: 32 GB free for the largest
   build, while a 12 GB build runs on a 16 GB node. VRAM: an 8 GiB integrated GPU is a stay-in-the-small-quants node —
   neither dialogue build fits it, the 1.2 GB and 3.0 GB conversion packages do, and that is a good use of such a node.

4. **What a generation costs against the clock, measured.** Three real rows from this setup's own records, on the
   two kinds of machine it runs on. The number is **engine wall-time per second of audio the take produced**, with the
   load leg excluded — that leg is a separate key on the same row, and it is seconds for a small package and tens of
   seconds for a large one.

   | what was made | the machine it ran on | engine seconds per audio second | what that means in practice |
   |---|---|---|---|
   | music and effects on `stable_audio_medium` | an older 4-core desktop CPU node, 35 W TDP, no GPU | **4.7 – 4.9×** (median of the plugin's own rows, 2026-11-10 and 2026-11-15; the 120 s take that produced the reference llama call took 569 s of engine wall) | a two-minute piece is a ten-minute job. It belongs on the node that has nothing else running, and it is the job that never blocks a short one on another node |
   | voice cloning on the Qwen3 TTS clone path | the same class of CPU node | **4.3 – 6.3×** (rows of 2026-10-13 and 2026-11-10) | a ten-second line is about a minute. A scene of many short lines is where a queue earns its keep |
   | the same two, on an old AMD RX 5700 8 GB card built with Vulkan | that card | **0.26×** for the small effects-and-music generator (120 s of audio in 30.8 s), **0.95 – 2.5×** for the clone path — and `stable_audio_medium` **did not finish**: `vk::Queue::submit: ErrorDeviceLost` 31.6 s in (all of it 2026-10-13) | an 8 GB card is faster than realtime on the small packages and unusable for a 3.4 GB one. The model has to fit the card, not the catalog |

   **What those numbers do and do not say.** They are dated rows, not a promise: the ratio moves with the quant, with
   the length, and with whether anything else is running on that box — measured 2026-11-15, two identical 20-second
   renders on one CPU slot cost 121.8 s and 196.9 s while a compile was competing for the same cores. The small
   text-only tier of item 5a is under 1× even on a CPU node (0.68× median, measured 2026-11-10), which is the point
   of the whole architecture: **a node that renders at 0.26× and a node that renders at 4.8×, taking turns, finish
   more audio per hour than either one alone**, and the fast one is what answers a short request while the slow one is
   busy. The plugin carries its own measured copy of these rates in `lib/index.js` and uses it to size a take budget
   before it dispatches, and it names where the number it used came from. The per-model records are
   [docs/MODELS_TEST_MATRIX.csv](docs/MODELS_TEST_MATRIX.csv) and [docs/MODELS_TABLE.md](docs/MODELS_TABLE.md).

5. **Model files on a network share: out of scope here, easy for you to add.** The plugin never touches the model
   directory — it names a model id and each engine opens its own path. So the packages can live on a local disk or on
   one share that every node mounts, and nothing in this package changes for that; it is the cheapest way to keep a
   single copy of a large catalog in a multi-node setup. What it costs is on the network, not in this plugin: a model
   load reads the whole file, so a link slower than a local disk shows up as a longer load time on the row, which is
   exactly where you would see it. Measured 2026-11-15 on the share this setup uses: a 1.6 GB package loaded in 0.9 s
   to 2.5 s. Your agent can help ;D

## 3. What changed recently
   see [CHANGELOG.md](CHANGELOG.md)

## 4. Quickstart
   point Your agent at [AGENTS.md](AGENTS.md) 

## 5. Slowstart

1. **What it needs.** A DSH harness at `>=0.2.2-rc.1` (`engines.dsh` in `package.json`) with a profile this bundle is
   mounted into. `@deepseek-ai/cordis ~4.1.0` as a peer dependency and `@deepseek-ai/schemastery ~3.19.0` as the one
   runtime dependency — both npm packages the profile resolves. A Node runtime: the host half is plain Node with no
   compiled part of its own. An audio.cpp engine reachable from that host, **local or remote as the setup has it**,
   added with `endpoint_add` and read back with `endpoint_registry`. A browser for the panel — it is the harness's own
   web client, and `audio_control` reaches it only while the panel is open. Then three shell tools, each needed only by
   the feature that uses it: `curl` for the endpoint health probes, the download reads and the station read; `ffmpeg`
   — with `ffprobe` where a file is read — for every step that happens **on this host** rather than on an engine:
   `mix_audio`, the remux controls, the normalization of a voice sample, the conversion of an imported file;
   `yt-dlp` for media capture, which is unavailable unless `ytdlp_path` names the binary. A host without ffmpeg
   renders from an engine perfectly and still cannot register a voice, and the row says so
   (`ffmpeg is not found on the host running this plugin`) instead of reporting an exit number. Nothing in this
   list installs an engine, downloads a model, or starts a service.
   And one thing to know before a long take: the wall on an engine request is this plugin-s own. `job_timeout_sec`
   (3600 s by default, read with `GET job_timeout`) is the number that times the call, because the call is run with
   no deadline from the harness shell executor and this plugin bounds it instead (`CHANGELOG.md` T-912). A music
   take on a CPU node runs past ten minutes and is payable without touching any profile setting; a row that ends at
   the wall says which wall ended it (`docs/PROMPT_FIRST_SETUP.md` §5 item 5).
2. **Install.** This package mounts as a Cordis bundle in a DSH profile. Two ways, both real: the harness's plugin
   manager (`list_bundles` then `install_bundle`, which can install from a registry or from a local path), or a `link:`
   dependency in the live profile's `package.json` — which is how this one is mounted. **Installing is not a
   restart**: an install or an enable applies to the live profile, and the panel comes up with it. The restart
   sentence is for a **host-half code change already sitting in the tree** — `lib/index.js` is loaded when the
   harness boots. A client-only change goes live on a browser refresh. The mount rows, what each waits for, and what
   a patch row does to a Config are in [AGENTS.md](AGENTS.md) section 3.
3. **Ask the reads first.** They are what every other call needs, and they are the authority for what this front-end
   has:
   ```bash
   curl -s  <harness>/api/deepamp/endpoint_registry?fn=tts     # the slots this plugin has
   curl -sX POST <harness>/api/deepamp/endpoint_models \
        -H 'Content-Type: application/json' -d '{"fn":"tts","id":"primary"}'   # what that engine serves
   curl -s  <harness>/api/deepamp/queue_status                 # what is queued, running or parked, and why
   ```
   `<harness>` is whatever the session is running at. It is not a constant of this page.
4. **A human's path is the panel.** Ask for one take in a voice you already have, register a voice from a WAV, ask for
   a transcription, watch what each slot is doing, play a rendered file back, read the plugin's own logs. The panel's
   settings live in the browser under `deepamp:*`, not in the plugin store.
5. **An agent's path is the tools.**
   ```text
   audio_render  {kind:"take", text:"Hello from DEEPAMP.", voice:"ent_data"}
   audio_render  {kind:"scene", dialogue:[{"voice":"voy_doctor","text":"…"},{"text":"…"}]}
   audio_render  {kind:"transcribe", file_path:"/absolute/path/to/a.wav", model:"<from audio_status slot_models>"}
   audio_render  {kind:"convert", source_job_id:"<a finished row>", target_voice:"<from audio_voices list>", model:"<from audio_status slot_models>"}
   audio_status  {what:"lane"}
   audio_voices  {what:"list"}
   audio_control {what:"play", job_id:"ap-1330"}
   audio_control {what:"auto_gen", mode:"on"}
   ```
   A second voice left out of a scene line is the model inventing that speaker, not a missing field. `audio_control`
   reaches the browser only while the panel is open — including that last line, which arms the panel's
   auto-generation chain; it starts on the next press of a generation control. `audio_status {what:"lane"}` and the
   playlist and row answers carry that chain's state (`auto_gen`) and mark the rows it started (`auto_started`);
   when no panel is open to report its own chain, those answers say they do not know.
6. **A dispatch answers with a row.** `{"ok":true,"job_id":"ap-…"}` — then `audio_status {what:"job", job_id:"…"}` or
   `job_status?job_id=` is how you follow it, and the take arrives later at `/deepamp/<job_id>`. Do not re-ask for a
   take you already hold an id for.
7. **Configuration is one table, and it is not here.** Precedence is environment > declared Config > the state file >
   the built-in default; every field and its range is in [AGENTS.md](AGENTS.md) section 6. A value out of range is
   refused and named in the boot audit.
8. **Where the rest of the documentation lives.** 
[AGENTS.md](AGENTS.md) is the agent guide: the verbs, what the plugin
refuses, how a job waits, how to work in this tree. [CHANGELOG.md](CHANGELOG.md) is what changed and what was
measured, newest first. [docs/FACTS.md](docs/FACTS.md) holds verified facts and dated measurements to cite instead of
re-investigating — a dated line there is a pointer to verify, not a current answer.
[docs/VERBS.md](docs/VERBS.md) is the verb reference for a person or an agent that calls the routes directly: what each
one is for, what its answer holds, and what it refuses instead — and the executable contract in
[tests/verb_contract.test.cjs](tests/verb_contract.test.cjs) is what keeps that page from drifting out of the routes
the plugin actually answers.
[docs/MODELS_TABLE.md](docs/MODELS_TABLE.md), [docs/MODELS_REMOTE.md](docs/MODELS_REMOTE.md),
[docs/MODEL_PROVENANCE.md](docs/MODEL_PROVENANCE.md) and [docs/MODELS_TEST_MATRIX.csv](docs/MODELS_TEST_MATRIX.csv)
are the measured model records; two of them are read by the host suite, so they are part of the package.
[docs/PROMPT_CODING.md](docs/PROMPT_CODING.md) the doorway for a coding pass and
[docs/PROMPT_FIRST_SETUP.md](docs/PROMPT_FIRST_SETUP.md) the doorway for a first setup — the three test creations, the
order they go in, the lengths they are asked for, and how a model is chosen for each from the engine's catalog rather
than from that file.

## 6. Disclaimer, thanks, licence

1. **Disclaimer.** This is one person's hobby project that happens to run every day. It carries no warranty and no
   support promise. It is not a speech engine, not a service, and not a hosted product: it is the front-end in front of
   engines it does not implement.
2. **How it was made.** **Fully vibed — no dumb ape touched the code.** Every line of this package, its tests and its
   documents were written in conversation between an operator and a model, and the operator's second question is what
   shaped them. That is stated here as what it is, not as a boast and not as a hedge: it is the reason the changelog
   reads the way it does.
3. **Thanks.** To [0xShug0](https://github.com/0xShug0/audio.cpp) and the audio.cpp contributors, for the thing that
   actually does the audio work and for a codebase readable enough to be worth reading. To **DeepSeek**, for DSH — the
   harness this plugin lives in and the reason an agent can reach the audio work at all. To **qwen**, for the coding, and
   especially **qwen3.8-Flash-next-IQ3_XXS**, which wrote most of this. To the **llama.cpp wizards** — the ggml and
   llama.cpp line the audio.cpp framework stands on. To **Strata**, for negative-entropy efficiency improvements. To
   **Nullsoft**, for what a player is allowed to look like. And to the
   operator who keeps asking the second question, which is where nearly every card in
   [CHANGELOG.md](CHANGELOG.md) came from.
4. **Licence.** [LICENSE](LICENSE) in this package is the Apache License, Version 2.0, verbatim — 11 357 B, 201 lines,
   placed 2026-11-07. 
      
**If you are an agent here to change this package:** read [AGENTS.md](AGENTS.md) first, and
[docs/PROMPT_CODING.md](docs/PROMPT_CODING.md) is the doorway if the work is to change the code. This page is about
the plugin and how it is used.
