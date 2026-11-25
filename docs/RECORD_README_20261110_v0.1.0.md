> **This file is a record, not the landing page.** It is `README.md` as it stood on 2026-11-10 for `0.1.0`, kept on
> 2026-11-11 when the landing page was rewritten; the rewrite is card **T-785** in `../CHANGELOG.md`. Its own text was
> not edited. Its links were written relative to the package root, so read them from here one level up: `AGENTS.md`
> means `../AGENTS.md`, `docs/…` means the file in this directory. Its status section describes what was true on
> 2026-11-10 and is superseded by `../CHANGELOG.md` and `../../TODOS.md`.

# deepamp-audio

The **DEEPAMP** audio lane as a Cordis bundle: a browser panel, the host half that places audio jobs on
remote audio.cpp engines, and a component that puts that lane in front of an agent as four tools. Single-
voice TTS, transcription, multi-voice scene rendering, a voice registry, an endpoint registry and queues.

Mounted in the live profile as `@<scope>/deepamp-audio` `0.1.0` through a `link:` dependency of the profile's
`package.json`. Its HTTP prefix is `/api/deepamp`, its audio files are served under `/deepamp`, its panel
row is `deepamp`, and its agent tools are `audio_render`, `audio_status`, `audio_voices`, `audio_control`.

**For an agent working in this package, read [AGENTS.md](AGENTS.md) — that is the guide, and
[docs/PROMPT_CODING.md](docs/PROMPT_CODING.md) is the doorway if the work is to change the code. This page is the
landing page for the plugin itself: what the lane is, how it is used through the panel, the tools and the verbs, and
where each document lives.**

A WIP vibe-coding hobby project, shared with the other apes. It runs every day on one operator's machines. It is
not a product page and does not pretend to be one.

**The audio itself is [audio.cpp](https://github.com/0xShug0/audio.cpp)** — the C++ audio inference framework
built on ggml. Nothing in this package is a speech engine. What this package carries is the **lane**: the panel,
the endpoint registry, the queues and placement rules, the voice registry, the media capture, and the four agent
tools that put the lane in front of an agent. audio.cpp is what answers a request, its catalog is what a dispatch
is allowed to name, and the measured records of what those engines answered are under [docs/](docs/).

## The player window

The panel is one window: a player on top, a transport under it, and one collapsible section per job kind. These
are the player window itself, shot from the running build - not a mock-up and not the whole harness page. A take
of a registered voice is playing in both frames; the ticker names it, the visualizer is rendering it, and the
rows below are real rows from the lane.

[![The DEEPAMP player window with a take playing, at desktop width](docs/screenshots/v0.1.0/hero__playing__968x1464.png)](docs/DETAILS_PLAYLIST.md)

[![The same player window at phone width](docs/screenshots/v0.1.0/hero__playing__904x1592.png)](docs/DETAILS_PLAYLIST.md)

Shot 2026-11-10 against `0.1.0` with the panel's own playlist cap set to 6 rows so the frame stays a hero and
not a wall. The layout was measured at three widths: at a 1600 px and a 960 px window the player renders at the
same 484 CSS px, so those two frames are the same size and only one is linked here; a 480 px window narrows the
player to 451 CSS px and that is the second frame. `docs/PROMPT_DOC_UPDATE.md` asks for three widths; in this
layout two of them are one width, and that is recorded rather than hidden. Every shot in this page is named and
listed in [docs/screenshots/v0.1.0/manifest.json](docs/screenshots/v0.1.0/manifest.json).

## 1. How it is used

The lane has three doors into it. They reach the same verbs and the same queue, and a job that enters through one of
them is visible from the other two.

1. **The panel, in the browser.** The panel row is `deepamp`. From it you ask for one take in a voice you already
   have, register a voice from a WAV the plugin can read, ask for a transcription of an audio file, watch the queue
   and what each endpoint slot serves, play a rendered file back, and read the plugin's own logs. Rendered audio is
   served under `/deepamp/<job_id>`. The panel's settings live in the browser, not in the plugin store.
2. **The four agent tools.** `audio_render` (a take, a multi-voice scene, a plan for a scene, a transcription, a
   speaker separation), `audio_status` (what the lane is doing, what a slot serves, one job by its id, what the store
   holds), `audio_voices` (the voice registry, and what kind of voice request a model can serve), `audio_control`
   (ask the open panel to play, stop, or clear its finished rows). Each one is switchable on its own. A call needs no
   model name and no endpoint id: the lane places the job and refuses what it cannot place.
   ```text
   audio_render  {kind:"take", text:"Hello from the lane.", voice:"ent_data_short"}
   audio_status  {what:"lane"}
   audio_voices  {what:"list"}
   audio_control {what:"play", job_id:"ap-0300"}
   ```
3. **The HTTP verbs.** Everything the panel and the tools do goes through `POST|GET /api/deepamp/<verb>` on the
   harness's own HTTP surface; the harness's address is whatever the session is running at, it is not a constant of
   this page. The reads are the first thing to ask, because they are what the other calls need:
   ```bash
   curl -s  <harness>/api/deepamp/endpoint_registry?fn=tts      # the slots this lane has
   curl -sX POST <harness>/api/deepamp/endpoint_models \
        -H 'Content-Type: application/json' -d '{"fn":"tts","id":"primary"}'   # what that engine serves
   curl -s  <harness>/api/deepamp/queue_status                  # what is queued, running, or parked, and why
   ```
   A dispatch names a model, and the plugin refuses one the target endpoint's catalog does not list - so the model a
   real request carries is read from that endpoint at that moment, never copied from a document. Multi-voice scene
   rendering is `POST dispatch_batch` with a batch file: the plugin splits the scene into bounded takes, queues them
   across the endpoints, and reports the parts.
4. **What a dispatch answers.** A row and its id, not the audio. The lane is a queue: the take arrives later, at
   `/deepamp/<job_id>`, and `job_status` is how you follow it. A row that is waiting carries the reason it is
   waiting, and waiting is not a failure.
5. **If you are here to change this package rather than use it:** the coding and testing facts - the suites, what a
   change needs in order to go live, the read order for a coding pass - are in **[docs/PROMPT_CODING.md](docs/PROMPT_CODING.md)**
   and in [AGENTS.md](AGENTS.md). This page stays about the plugin and how the lane is used.

## 2. Layout

1. `lib/index.js` — the host half: endpoint registry, per-lane queues and placement, TTS/STT and batch
   dispatch, voice registry, media capture, the audio store, the HTTP surface.
2. `lib/client.js` — the browser half: the DEEPAMP panel. Ships through the `./client` export.
3. `tools/index.js` — the four agent tools plus one scoped system-prompt section.
4. `tests/` — the 26 suites. `tests/verb_contract.test.cjs` is the executable verb reference.
5. `docs/` — the measured records and the per-section user guides. `docs/screenshots/` holds panel images.
6. `artifacts/` — captured engine pages the host suite reads as fixtures, plus dated run archives.
7. `AGENTS.md` — the agent guide. `CHANGELOG.md` — completed cards, newest first.

## 3. Configuration

Precedence is **environment > declared Config > the value the state file carries > the built-in default**.
Every field, its range and its environment name is in [AGENTS.md](AGENTS.md) section 6. A value out of
range is refused and named in the boot audit; a key the Config does not declare is carried through
unchanged but named there, so a typo in a patch file shows up instead of vanishing.

## 4. Where the documentation lives

1. [AGENTS.md](AGENTS.md) — the rules an agent needs: the verbs, what the plugin refuses, how a job waits,
   how to work in the tree, and the settled decisions not to re-litigate.
2. [CHANGELOG.md](CHANGELOG.md) — what changed and what was measured, newest first.
3. [docs/FACTS.md](docs/FACTS.md) — verified facts and dated measurements, to cite instead of
   re-investigating. A dated line there is a pointer to verify, not a current answer.
4. [docs/MODELS_TABLE.md](docs/MODELS_TABLE.md), [docs/MODELS_REMOTE.md](docs/MODELS_REMOTE.md),
   [docs/MODEL_PROVENANCE.md](docs/MODEL_PROVENANCE.md), [docs/MODELS_TEST_MATRIX.csv](docs/MODELS_TEST_MATRIX.csv)
   — the measured model records. Two of them are read by the host suite, so they are part of the package.
5. **The section index — one shot per panel section, each pointing at its guide.** The shots were taken
   2026-11-10 against `0.1.0`; the guides are still placeholders marked WIP, and each shot is the player
   window holding that section open, so a guide written later has its frame already named. The names carry
   the version, the section, the state shown and the pixel size, and every one is listed in
   [docs/screenshots/v0.1.0/manifest.json](docs/screenshots/v0.1.0/manifest.json).
   1. [Playlist](docs/DETAILS_PLAYLIST.md) — [playlist__open__968x1836.png](docs/screenshots/v0.1.0/playlist__open__968x1836.png),
      the list with real rows of every kind and the row controls.
   2. [Models](docs/DETAILS_MODELS.md) — [models__open__968x2584.png](docs/screenshots/v0.1.0/models__open__968x2584.png),
      the model tree read from the engines.
   3. [Voices](docs/DETAILS_VOICES.md) — [voices__voices_registered__968x3906.png](docs/screenshots/v0.1.0/voices__voices_registered__968x3906.png),
      the registered voices with their controls.
   4. [TTS/MUSIC/SFX](docs/DETAILS_TTS_MUSIC_SFX.md) — [tts_music_sfx__open__968x1504.png](docs/screenshots/v0.1.0/tts_music_sfx__open__968x1504.png),
      the single-voice request form.
   5. [TTSD (multi-speaker batch)](docs/DETAILS_TTSD.md) — [ttsd__open__968x1720.png](docs/screenshots/v0.1.0/ttsd__open__968x1720.png),
      the scene form and its parts.
   6. [STT (transcription)](docs/DETAILS_STT.md) — [stt__open__968x1230.png](docs/screenshots/v0.1.0/stt__open__968x1230.png),
      the transcription form and its file input.
   7. [Auto-play Agent Session](docs/DETAILS_AUTOPLAY.md) — [autoplay__open__968x1286.png](docs/screenshots/v0.1.0/autoplay__open__968x1286.png),
      the agent-side controls.
   8. [Advanced (Options, Remux)](docs/DETAILS_ADVANCED.md) — [advanced__open__968x2214.png](docs/screenshots/v0.1.0/advanced__open__968x2214.png),
      the options block and the remux controls.
   9. [Settings](docs/DETAILS_SETTINGS.md) — [settings__settings_open__968x3906.png](docs/screenshots/v0.1.0/settings__settings_open__968x3906.png),
      the persisted settings the plugin reads back.
   10. [Endpoints](docs/DETAILS_ENDPOINTS.md) — [endpoints__endpoints_loaded__968x2030.png](docs/screenshots/v0.1.0/endpoints__endpoints_loaded__968x2030.png),
      the slot list with each engine's catalog count and health.
   11. [Logs](docs/DETAILS_LOGS.md) — [logs__logs_open__968x2756.png](docs/screenshots/v0.1.0/logs__logs_open__968x2756.png),
      the page log and the host lane log read.
   The two caps the shots were taken under are the panel's own controls, not staging: the playlist frames were
   taken with `limit playlist lines displayed` at 6 and 12, and the logs frame with its own cap at 20, the
   largest value it offers. A shot of a section that was too long for any frame was not faked by cropping.
6. [docs/PROMPT_DOC_UPDATE.md](docs/PROMPT_DOC_UPDATE.md) — the standing instructions for a document pass: the
   README layout, the screenshot round and what a shot must show, the file-naming rules per version, the layout a
   `DETAILS_*.md` is to take, and the tone. Written 2026-11-06 at the operator's ruling; the pass that fills the
   placeholders and shoots the panel follows it.
7. [docs/PROMPT_CODING.md](docs/PROMPT_CODING.md) — the doorway for a session that is here to change this package's
   code: the suites and what a green run does and does not say, what a change needs in order to go live, the read
   order for a coding pass. It points at [AGENTS.md](AGENTS.md) instead of restating the rules. Added 2026-11-08 at
   the operator's ruling that this page carries the plugin and its usage, not a coding quick start.
8. [docs/screenshots/](docs/screenshots/) — the images these documents use, one directory per plugin version.
   `docs/screenshots/v0.1.0/` holds the 14 shots listed above plus the manifest that names where each came from.
   Working frames that were not chosen stay in `scratch/shots_20261110_docs/`; playwright-cli's own debugging
   output never belongs in `docs/`.
9. Open work is not in this package: it is in the workspace tracker, `../TODOS.md`, as WM cards.

## 5. What this package deliberately does not carry

1. No address, no port, no fleet table. Slot state is read with `endpoint_registry`, `endpoint_health`,
   `endpoint_models`, `queue_status`.
2. No model named as the model to use. A dispatch names a model, and the plugin refuses one the target
   endpoint's catalog does not list, so the catalog is the authority.
3. No machine preference. Which box is kept off the audio lane is the operator's and lives in the workspace
   guide, not in a plugin file.
4. No engine is started or downloaded here. If a remote does not answer, it reports that.
5. `git init` has not been run in this directory. It needs the operator's explicit authorisation, and the
   first commit needs a `.gitignore` that keeps out `scratch/`, `node_modules/` and the other temp state.

## 6. Status, as measured on 2026-11-10

1. **Version.** `0.1.0` is this tree as it stands - the operator's ruling of 2026-11-07. The next targets
   (v0.1.1 the first bugfix release plus the section guides, v0.1.2 the colour work, v0.2.0 the long rewrites)
   are in the workspace tracker, not here.
2. **Tests.** 26 suites, `npm test`, last full run `RC=0` with 5 677 assertion lines and 0 failures
    (`scratch/suite_full_20261110g.log`; the count is of the `  PASS ` lines - most suites print a per-suite
    total, several do not, and the render suite prints its own total as "N pass, 0 throw", so a total quoted from
    the summary lines alone is lower than the real one). They are
    static-and-mock: no engine is called, no audio is rendered, no server is started. A green run says the
    package is consistent with its own contracts. It does not say an engine answered.
3. **Open.** The eleven section guides are still `WIP` placeholders - their screenshots now exist, their text
   does not. Two host-side changes are coded and tested but not live in this running harness, because a host
   change waits for a restart the operator has not given yet. One suite fixture in `tests/scope.test.cjs` is
   time-sensitive and has flaked twice; the honest repair is a frozen clock in that fixture. All three are on
   `../TODOS.md`.
4. **Known limits, stated plainly.** Every engine this plugin drives has `max_loaded_models=1`, so one job per
   endpoint and a queued row is normal, not broken. A pinned row is evaluated alone and never falls back to
   another slot. `audio_control` reaches the browser only while the panel is open. The panel is a narrow column
   in the harness layout - 484 CSS px at a desktop width - and it is a panel, not a page. The plugin never
   starts a local audio server and never downloads a model.
5. **Licence.** `LICENSE` in this package is the Apache License, Version 2.0, verbatim — 11 357 B, 201 lines, put
   there on 2026-11-07. Two halves of it are unfinished and are stated here rather than papered over: the
   appendix's `Copyright [yyyy] [name of copyright owner]` line is still the unfilled template, and
   `package.json` carries no `license` field while it does carry `"private": true`. Filling the copyright line and
   naming the licence in the manifest are the operator's call, and both are the first thing a public upload needs.
   An earlier line of this page said there was no `LICENSE` file. That was wrong, and it is corrected here.
