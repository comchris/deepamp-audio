# PROMPT_CODING — for a session that is here to change this plugin's code

**What this file is.** The entry point for coding work, and nothing else. The `README.md` describes the plugin and
how the lane is used; this file is the short answer to "I am about to edit this package - what do I run, what do I
read first, and what does my change need in order to go live". It **points** at the rules, it does not restate them:
the rules live in `../AGENTS.md`, and where the two disagree `AGENTS.md` is the one that is authority. Written
2026-11-08 at the operator's ruling that the landing page must not lead with a coding quick start ("the page should
focus on the plugin and it's usage ... put coding specific information and testing stuff in a seperate .md file in
docs as PROMPT_... and point at it from AGENTS.md").

## 1. Read order for a coding pass

1. `../AGENTS.md` section 2 (what is in the tree), section 3 (how it mounts, what a change needs), section 8
   (working in this package), section 9 (the suites). Those four are the rules; this file is only the doorway.
2. `../AGENTS.md` section 4 and section 5 before touching a verb, a queue path, a placement rule or a tool - they say
   what the plugin already refuses, and a refusal that is already designed is not a bug to fix.
3. `../AGENTS.md` section 11 before proposing a change to placement, the capability bar, the endpoint brake, or the
   queue pump. Those halves were measured and settled; the measurements are in `FACTS.md`.
4. `../tests/verb_contract.test.cjs` before changing any HTTP method - it is the executable verb reference and it
   fails when the client's call switch and the host's gates disagree.
5. `../CHANGELOG.md` for the id a code comment cites, and `FACTS.md` for a measured number, instead of re-running
   an investigation that has already been done.
6. `PROMPT_DOC_UPDATE.md` if the change touches what a document claims - a verb, a control, a Config field, a
   refusal. A document that describes a thing that did not change is noise; a document that no longer matches a
   thing that did change is a defect.

## 2. The commands

1. `npm test` - 26 suites. They are **static-and-mock**: no engine is called, no audio is rendered, no server is
   started, and no test writes into a real store. A green run says the code in this tree behaves as the suites
   describe; it says nothing about a live engine, and it is not the same thing as a test run on the audio lane.
2. One suite: `node tests/<name>.test.cjs`. Run the affected suite while working, and the whole set before a chunk
   is called done.
3. Two files outside `tests/` are read with a real `readFileSync` and are part of the package: `MODELS_TABLE.md` and
   `MODEL_PROVENANCE.md` in this directory. The two captured engine pages the host suite reads are inside the tests
   tree at `tests/fixture/…` since 2026-11-12 (T-816) and are part of the package in exactly the same way. A copy
   that leaves any of them out fails. Editing those two documents is a code-adjacent change.
4. Full-run logs, pre-change copies and measured dumps go to `../scratch/`. Never into the old working tree
   (operator ruling 2026-11-06), and never into `docs/`.
5. `tests/tooltips.test.cjs` prints a hover-length measure over the panel. A measure is not a failure. `tests/
   handler.test.cjs` prints `handlers OK` and no count. A suite that prints no tally is not a suite that ran nothing.
   **And a tree total is only comparable if every suite was counted by the same rule** (measured 2026-11-16, at the
   T-877 tree run, from the two logs side by side): the 2026-11-16 T-876 summary recorded `model_matrix pass=0`
   while that suite answers `=== 16 pass, 0 fail ===` and its own log carries 16 PASS lines — the PASS lines of
   that suite are not indented, and the summary counted the indented form other suites print. So: read a tally
   from the suite-s own summary line, or re-run that suite and read its log; do not count a marker whose shape
   varies between suites. When a card quotes a whole-tree figure, it names the figure it is compared against and
   how that one was produced — a total that was produced by a different rule is not a baseline.

## 3. What a change needs to go live

1. A change to `lib/client.js` - a browser refresh. No restart, and no restart is owed for it.
2. A change to `lib/index.js`, `tools/index.js`, `cordis.patch.yml` or `package.json` - a harness restart, and a
   restart is the operator's explicit, per-restart OK. Never taken by an agent, and never run from inside the session
   that would be killed.
3. A change to a skill or a preset in the profile bundle - read when the next session starts; it needs no restart
   either, and it changes every session in that profile.
4. Nothing in this package starts or downloads an engine. If a remote does not answer, that is reported, not worked
   around locally.
5. **Checking a client change landed, in the live page.** The operator's word (2026-11-10): "you can read out the
   open tmux session for the token of DSH - it's usually one of the last lines". A script-driven page needs the
   **token URL**: the plain harness address answers "dsh web authentication required" and the page logs a single `401`.
   Read it from the pane that runs the harness — `tmux capture-pane -p -S -40 -t 0:0 | grep 'dsh web: http'` — and
   take the **last** line: a new token is printed at every restart, so an earlier one in the scrollback is not valid.
   Pass it as `DSH_GUI_URL` to a probe written against `playwright-core` (the form the probes in `../scratch/` use:
   `waitForFunction` on `[class*="audio-play-panel"]`, then read the panel's own DOM). Dispatch nothing, write no
   audio, and print the browser console: a clean verification is zero errors, zero warnings, zero failed requests. A
   headless page carries its own `localStorage`, so a probe never touches the operator's tab — which is also why a
   probe proves the served bundle while the operator's open tab still needs its own refresh.

## 4. The working rules, in one line each, with where the rule itself lives

1. Copy a file into `../scratch/` before changing it, named after the file and the change; if a copy was not taken,
   say so (`AGENTS.md` 8.1).
2. Never delete or weaken an assertion - re-express it with a dated `(T-NNN contract change)` note quoting the
   operator (`AGENTS.md` 8.5).
3. 8-12 new assertions for plumbing; a heavy assertion set only for a behaviour contract (`AGENTS.md` 8.6).
4. Work by code region with exact `file:line` anchors, not by ticket number (`AGENTS.md` 8.3). Host chunks under
   about 200 lines are done in the session.
5. No subagent in audio work while the fleet carries one GPU slot in play (workspace `../../AGENTS.md`, operator
   ruling 2026-11-01).
6. A changelog card is about twelve lines and ten items: the ruling, the measured before and after, the state word
   (`AGENTS.md` 8.9). Reasoning goes in the comment above the code.
7. Never start testing without the operator's word; never create synthetic test audio; never overwrite a prior result.
8. A tracked file of this package carries no private literal — no machine name or address, no absolute local path, no
   account handle, no local task id, no disk measurement. A role word ("the primary slot", "a CPU node") plus a pointer
   to `LOCALHOSTS.md` is the form, and a path is written in its general form (`<home>/.dsh/deepamp-audio`). A measured
   number stays; the address it was measured on does not (`AGENTS.md` 8.10, the operator's ruling of 2026-11-15).

## 5. Real-lane runs are not suites

1. A dispatch through the plugin - a take, a scene, a transcription, a probe of a model - is a **real-lane test**,
   not a suite. It queues a job, it answers with a job id, and the result arrives later. It is the kind of run the
   operator asks for by name, and it is what the measured model records in `MODELS_TABLE.md` and `MODELS_REMOTE.md`
   are made of.
2. A real-lane run writes its artifacts to `../artifacts/` under a dated directory, and its log to `../scratch/`. It
   names the endpoint and the model it actually asked for, read from that endpoint's own catalog at the time of the
   run - never from a name carried in a document.
3. The runner for a model sweep across slots is `../scripts/model_matrix.py`. It is dry-run unless `--go` is given, it
   takes its origin from the session's environment, it reads each slot's own catalog before it plans a row, and it
   pins every dispatch and keeps the run serialised, because an engine holds one model at a time. The older
   `audio-play-cordis/scripts/model_sweep.py` is the source-tree form of the same idea and it only ever reaches the
   primary slot. Both live in `../scripts/`, which no suite reads.
4. A run against a model an endpoint does not list is refused before anything is queued. That refusal is the
   capability bar doing its job, and it is a result to record, not a defect to fix.

## 6. What this file deliberately does not carry

1. No fleet state, no address, no port, no slot table - read `endpoint_registry`, `endpoint_health`,
   `endpoint_models`, `queue_status` in the session that needs the answer.
2. No model named as the model to use, and no count of what a catalog lists.
3. No Config table - it is in `../AGENTS.md` section 6, and a second copy of it would drift.
4. No verb list - `tests/verb_contract.test.cjs` is the reference, and a list in a document is a claim that can age.
