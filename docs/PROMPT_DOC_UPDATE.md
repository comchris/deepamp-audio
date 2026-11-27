# PROMPT_DOC_UPDATE — how a session updates README.md and the rest of the docs, screenshots included

**What this file is.** The standing instructions for the document pass. Run it after a version change, after a
panel section changes what it shows or what a control does, after a verb or a tool parameter changes shape, or when
a feature becomes worth a small example. It is a procedure, not a document about the plugin. Follow the order
below. A document that changes because the thing it describes did not change is noise: leave it alone.

## 1. Before touching anything

1. Copy every file you are about to change into `scratch/` first: `<file>.bak_<YYYYMMDD>_pre_doc_update`.
2. Read `README.md`, the `DETAILS_*.md` you are about to touch, and the newest card in `CHANGELOG.md`.
   Do not write into a document you have not read in this session. If the pass touches what a first setup does — a
   starter preset, a length asked for on a first run, how a model is chosen for a test creation — read
   `PROMPT_FIRST_SETUP.md` too: it is the procedure an installing agent follows, and it is a document this pass can
   make wrong.
3. Read the live thing you are describing — the panel, the verb, the config — instead of trusting the older
   sentence. A document is a claim about the current build.
4. **Write a role word, not a name** (the operator's rule of 2026-11-15, `AGENTS.md` 8.10). A page names a machine as
   "the primary slot" or "a CPU node" and a store as `<home>/.dsh/deepamp-audio`; the machine names, this machine's
   absolute paths, the account handle and the local ids belong in `LOCALHOSTS.md`, which `.gitignore` names. A
   measurement keeps its numbers and loses its address. The pass over the records written before that rule covers
   everything, fixtures included, and is filed for v0.1.1 (`TODOS.md` part one item 38) — it is not this pass's to do
   unasked.

## 2. The screenshot round

1. `screenshots/` holds only images a document uses. The working output of playwright-cli goes to
   `scratch/shots_<YYYYMMDD>/`; a shot is copied into `screenshots/` only after it has been chosen for a
   document. This directory is not a debugging dump.
2. A shot shows the panel doing its job: a real take playing, a visualizer actually rendering, a real voice in
   the registry, an endpoint row that has a model loaded, a transcript arriving. Never a synthetic string, never
   an empty panel, never a fixture standing in for the real state. The concrete form of this was named by the
   operator on 2026-11-14, in three parts, verbatim: "the auto-play screenshot should show 2 active slots with
   active settings", "the other textboxes should show typed in examples for some texts and funny jokes", "but that
   can wait for next release". So, for the next version's round: the auto-play frame shows two armed slots with
   their session selects chosen and their play buttons live, and a field a frame shows is a field with text typed
   into it. Read against the frames on disk (checked 2026-11-14): the auto-play frame shows one slot with its arm
   checkbox empty and its session select on `(newest session)`, and the TTS/MUSIC/SFX frame shows an empty text field
   and an empty preset-name field. Those frames are not re-shot for this; it is a requirement on the next round.
   The same round carries the operator-s second named ask of 2026-11-14, verbatim: "we want the player in playing
   state and have a different model and voice selected - not always showing the same content, and also showing
   different visualizer or clock faces". So: the player window in these frames is playing, not idle; the model select
   and the voice select do not carry the same pair in every frame; and the display block is shown in more than one
   visualizer mode and in more than one clock face — the lists of both are the mode label table and `CLOCK_MODES681`
   in `lib/client.js`, and they are not copied into this file. Tracked as `TODOS.md` part one items 13(b) and 13(c),
   target v0.1.1, card `CHANGELOG.md` T-860.
3. Each `DETAILS_<SECTION>.md` carries one full-resolution screenshot of that section, and a second frame only when
   that section opens a window and the operator asks for that window on its own. Not a gallery. The second case was
   ruled 2026-11-14, the operator-s words: "the ttsd file should also show a snapshot of the multi-speaker dialouge
   edit window as a standalone picture showing a short example batch" — so `DETAILS_TTSD.md` carries the section
   frame and the batch-editor frame, and the example written in the guide is the example shown in the frame.
4. The README hero is ONE frame of the player in action at the panel's own rendered size (operator ruling
   2026-11-11, verbatim: "header hero section with screenshot of the player playing in native resolution"), and it is
   placed with **no shot prose under it** — same operator, same day, verbatim: **"no \"shot\"explanations of the
   screenshots!"** A frame's date, size, state and origin are carried by its FILE NAME and by `manifest.json` in the
   version directory; a document does not explain a picture in prose, and the other captures of the same frame stay in
   the version directory without being named on the page. Measured 2026-11-10, a 1600 px window and a 960 px window
   render the same 484 CSS px column, so those captures are one size — that fact lives in the manifest, not on the page.
5. Visualizers: one shot per visualizer mode the panel offers, same take, same frame, only the mode changed, so
   a reader can tell them apart side by side. The round shows the modes as a set rather than one mode repeated
   through the other frames, and the clock faces are treated the same way — more than one of them appears in the
   set. The operator-s word of 2026-11-14: "also showing different visualizer or clock faces".
6. No debug chrome in a shot: no console overlay, no cursor, no clipped panel, no browser chrome, no test marks.
7. Audio in a shot is not needed to prove it works; the alt text names what is in the frame and there is no caption,
   and the example in the text is runnable.

## 3. Names, and what a new version does

1. Path shape: `screenshots/v<version>/<section>__<state>__<width>x<height>.png`. `<version>` is read from
   `package.json`, never from memory.
2. Hero shape: `screenshots/v<version>/hero__<state>__<width>x<height>.png`.
3. `<section>` is the stem of the DETAILS file: `tts_music_sfx`, `stt`, `voices`, `endpoints`, `settings`,
   `logs`, `models`, `playlist`, `autoplay`, `advanced`, `ttsd`. A frame of a window that section opens names the
   window after the stem — `ttsd_editor__open__2688x2002.png` is the batch editor window the TTSD section opens —
   and the state list below is unchanged by that.
4. `<state>` names what is happening in the frame, from this fixed list: `idle`, `open`, `playing`,
   `visualizer_<mode>`, `queue_running`, `transcribing`, `voices_registered`, `endpoints_loaded`,
   `settings_open`, `logs_open`.
5. A new version re-shoots the same set, with the same `<state>` names, into the new version directory. Same
   states, new directory — so two versions of the panel can be read side by side, section against section.
6. Never overwrite a shot with a re-shoot of the same version: add `__r2`. Never delete a version directory; an
   old set is the record of what that version looked like.
7. README and the DETAILS files link only the current version's directory. Older directories stay on disk and
   reachable, unlinked.

## 4. README.md — the layout

1. Title, one line saying what it is, then the tag, kept as it is: **a WIP vibe-coding hobby project, shared
   with the other apes.** That line is not marketing and is not removed for looking better.
2. Hero block: one frame of the player in action at its native rendered size, placed with no shot prose under it —
   see rule 2.4, re-ruled 2026-11-11.
3. What this is and what this is not, in plain sentences.
4. **What it needs, then how it is used.** The requirements come first in the quickstart and are read off the manifest
   and the code, never from memory: the harness version `engines.dsh` requires, the peer and runtime dependencies
   `package.json` names, a Node runtime, an audio.cpp engine reachable from that host (local or remote, as the setup
   has it), a browser for the panel, and the shell tool each optional feature uses — `curl` for the health probes and
   the reads that fetch, `ffmpeg` for the mix and remux, `yt-dlp` for capture, which is unavailable unless
   `ytdlp_path` names the binary. Nothing in that list installs an engine or downloads a model. Then the usage: the
   panel, the four agent tools, the HTTP verbs, each with one small real example, and what a dispatch answers. **The
   coding and testing facts are not on this page** (operator ruling 2026-11-08, verbatim: "it
   should not point out a quickstart on 'how to code' the page should focus on the plugin and it's usage you can opt to
   put coding specific information and testing stuff in a seperate .md file in docs as PROMPT_... and point at it from
   AGENTS.md"). They are in `PROMPT_CODING.md`, which README, `AGENTS.md` section 1 and section 9, and the document map
   all point at. The other prompt file in that directory, `PROMPT_FIRST_SETUP.md`, is not a coding file and is not a
    place to put a coding fact: it is the procedure for a first setup — the test creations and the lengths they are
    asked for, the order they go in, how a model is chosen for each from the catalog rather than from that file, and
    the routine for an engine on the machine with what it needs and where it stops. It is pointed at by `AGENTS.md`
    section 1 and section 10, and by the `deepamp:lane` section of the agent component; a document pass that changes
    what a first setup does owes that file a read (section 1 item 2). The mount rows and the Config table stay where they live - `AGENTS.md` sections 3 and 6 - and README
   carries a pointer to them, never a copy.
5. **audio.cpp, linked and named as the thing that actually does the audio work, and named as what it is: an engine
   this package is a front-end for.** This package contains no speech engine. The engines are
   [audio.cpp](https://github.com/0xShug0/audio.cpp), the C++ audio inference framework built on ggml; this plugin is
   the front-end in front of it, and it runs multiple models on demand. **Where an engine runs is the setup's choice:
   local or remote** (operator correction 2026-11-11, verbatim: "audio.cpp is not only remote - also local audio.cpp -
   depends on user setup"), so no page of this package says "remote engines" as a fact about the plugin; which one a
   job lands on is read with `endpoint_registry`. The link appears in the first third of the page and again where the
   sections are listed. The URL was read from our own clone at `<home>/gits/audio.cpp` (2026-11-06, at
   `4efa3959`, 2026-10-24); re-verify it when the clone is updated. Engine build facts and model facts are dated lines
   in `FACTS.md`, not claims here.
6. Features, each carrying one small real example: a request, a tool call, or a panel action. Short enough to
   read in ten seconds, real enough to run.
7. Section index: one screenshot per section, each linked to its `DETAILS_*.md`.
8. Config: a pointer to the Config table in `AGENTS.md`. Never a second copy of that table.
9. Status and known limits, stated plainly. Then the closing block, in this order: **disclaimer** (no warranty, no
   support promise, what this is not); **how it was made**, in the operator's own words, verbatim: **"fully vibed - no
   dumb ape touched the code"**, stated as what it is and not as a boast or a hedge; **thanks** — the engine and its
   authors, the harness, the model the coding was done with where the operator names one, the frameworks and tools it
   stands on, the people whose voices are in the registry, and the operator; then **licence**, with its unfinished
   halves named rather than papered over. A model named in the thanks is a credit for work done, not a model chosen for
   a dispatch: the rule that no document names a model as the model to use is untouched by it.

## 5. A DETAILS file — the layout

Re-ruled 2026-11-14 at the operator-s card, verbatim: "sentences like … -> remove - is redundant / also drop section 'What is deliberately not here.' / we want to explain each section in short and have a details section if needed for complex stuff / focus the guides more on the user who wants a fast explanation - no long sentences that have no meaning". Items 1 and 6 changed. The rest of the layout stands.

1. **One line that names what the section does, in plain functional words.** The operator-s own shape, verbatim: "TTS covers Text to Audio for speech, music, sfx, …" and "TTSD is fur multi-voice dialogue generation", with the rule behind both: "keep it simple, stupid" (the emoticon they typed is not carried here, per the no-emoji rule). No sentence about the guide itself, no second sentence, and no line that restates what the list below it already says.
2. **The full-resolution screenshot of the section**, and the frame of a window it opens when that window is what the section is for and the operator asked for it (§2 item 3).
3. **What is on the screen, top to bottom.** One short clause per control.
4. **How to use it.** One small example the reader can copy, in the words they would type.
5. **What it refuses.** One line each, and each line says what happens.
6. **A Details block, only where something is genuinely not obvious from the controls** — a bound, a clamp, a state a reader would otherwise guess wrong. If nothing qualifies, the guide carries no Details block.

A pointer to the guide that carries a related subject goes inside the line that needs it, not into a section of its own. One closing line naming README, AGENTS and CHANGELOG is allowed. A guide is read in one screen: it stays around 30 lines, and a guide that grows past that is carrying something that belongs in another file.

## 6. Tone

1. Technical, blunt, humble, retro. Say what a thing does and what it does not do.
2. No advertising. Banned as a class: powerful, seamless, cutting-edge, revolutionary, effortless, unlock,
   next-generation, supercharge, "take it to the next level".
3. Numbers instead of adjectives: a measured count, a dated read, a real duration. Where there is no number, say
   nothing rather than flatter.
4. Small and human is allowed and expected: this is one person's hobby project that happens to run every day. It
   is not a product page and does not pretend to be one.
5. No emojis. Plain status words: DONE, OK, BROKEN, WIP, PENDING.
6. Numbered lists, not bullets, in anything written for discussion.

## 7. The check before the pass is closed

1. Grep every image path you wrote and confirm the file exists at that exact name.
2. Confirm no document links a path that no longer exists, and no file in `docs/` sits unlinked from the README
   and from the document map in `AGENTS.md`.
3. Confirm the line limits hold: README stays short, `AGENTS.md` stays inside 300 soft / 400 hard, a changelog
   card stays around twelve lines.
4. Confirm no emoji, no banned adjective, no model named as the model to use, no address or port, no fleet state
   in a guide (WM-23, WM-27).
5. Run `npm test` when the pass touched a file a suite reads with a real read — `docs/MODELS_TABLE.md`,
   `docs/MODEL_PROVENANCE.md`, the fixture pages under `tests/fixture/`, or any code. A prose-only change does not
   need it; say which you ran and which you skipped, and keep the log in `scratch/`.
6. Record the pass in `TODOS.md` part one, under the open card. A card in `CHANGELOG.md` is asked for when the
   pass made a decision, not when it retyped a paragraph.

## 8. What this file does not decide

Whether the three model records get merged into one; the `.gitignore` payload and the contents of the first
commit; whether a version tag is cut; the Windows and other-OS text; the value of the panel's info link. Those
are the operator's calls and they live in `TODOS.md`.
