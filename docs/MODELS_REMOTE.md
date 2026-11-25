# audio.cpp remote model + voice stores (cpu1) — canonical paths, 2026-09-19

Read this before touching model paths, voice dirs, or WebUI downloads.

**These are this fleet's paths, not a requirement of the plugin** (clarified 2026-11-19 at the operator's word). The
models store here is a **network share every node mounts**, and its whole purpose is model re-use: one downloaded package
serves several engines instead of being copied to each box. An engine runs from its own model root — the default is a
directory beside the binary — and a setup that keeps model files local on each node needs no share, no mount and no
privileged access. That is the same boundary stated in `AGENTS.md` §5 item 12: the lane is HTTP, and a mount, a build or a
unit edit is node administration.

## Canonical locations

| What | Path | Notes |
|---|---|---|
| Models store (models-root) | `/mnt/llama/audio.cpp` | Shared by both CPU endpoints. Set at runtime via `POST /v1/ui/models-root`, persisted in the unit drop-ins + `ExecStartPost <home>/bin/audiocpp-set-models-root.sh`. NFS share — every node and both endpoints see the same files. |
| Server configs | `<home>/audio-cpp-cpu-server.json` / `audio-cpp-cpu2-server.json` | `models[]` entries: `{id, family, path (exact .gguf), task, mode}`. 41 wired entries each since 2026-09-19 (auto-wire, see below). Backups `.bak_*` beside them — NEVER delete. |
| Units | `audio-cpp-cpu.service` (8963 tts) / `audio-cpp-cpu2.service` (8962 stt) | ssh `<the-node-account>@cpu1.test` (the account is in `LOCALHOSTS.md` §9). Drop-ins `dynamic-models.conf` carry `--voice-dir /mnt/llama/audio.cpp/voices/registered --ui-management --idle-unload-ms 3600000`. |
| Shared voice dir (NAME resolution) | `/mnt/llama/audio.cpp/voices/registered/` | `--voice-dir` of both units. Operator-managed now: pre-placed names like `bijan_0048` resolve here per-request. The plugin no longer copies files here (see below). |
| Plugin voice registry | `~/.dsh/deepamp-audio/voices/<name>.wav` + `state.json["voices"]` | The plugin's own clone voices. Samples live on the PLUGIN HOST; dispatch sends them inline as `voice_ref` base64 — no server-side file needed. |
| Old local voice dir | the old voice directory under this host's projects tree (no longer on disk) | DEPRECATED (node-local, root of the "test voice not selectable" bug). Nothing reads it anymore. |

## How a voice resolves at dispatch (T-76, no-ssh design)

1. **Registry voice** (saved via `save_voice`/`design_voice`): the plugin sends
   `voice_ref: {type:"base64", data:...}` + `reference_text` — native speech-route support
   (`runtime.cpp`, decoded cap `kMaxVoiceRefBytes` = 5 MiB ≈ 60 s at 24 kHz mono pcm16).
   Works against EVERY endpoint, needs no ssh, survives server restarts and temp wipes.
2. **Server-listed voice** (e.g. `bijan_0048`): plain `voice: "<name>"` →
   `<voice-dir>/<name>.wav` resolves per-request (no restart). The plugin still sends its
   captured `reference_text` when it has one.
3. No voice-registration HTTP endpoint exists (`/v1/audio/voices` is GET-only), and
   `POST /v1/ui/upload` is the webui's SESSION-scoped reference upload: files land in the
   server temp dir and are `remove_all`-ed at shutdown (`remove_all` runtime.cpp ~1075).
   Never rely on it for persistence.

## Downloads → catalog registration

The webui downloads into the models store, but a new GGUF only appears in `/v1/models`
once it is declared in the server config (or dynamically registered via `/v1/models/load`).

**Current tool: `scripts/wire_shelf.py` (2026-10-02, T-169).** Every audio.cpp GGUF is
self-describing — its header carries `audiocpp.model_spec.json` with family, tasks, modes and
packages — so this tool reads the SHELF instead of a hand-maintained table: it walks the models
root, keeps every already-wired entry verbatim (ids stay stable for jobs and habits), derives
id/family/task/mode for every unwired file from its own spec, and applies a per-endpoint POLICY
(`--deny family|id`, `--max-mb N`) which is how a node says "this endpoint must never be offered
moss_ttsd". Report-only by default; `--apply` writes `<config>.bak_shelf_<stamp>` first, stages a
tmp file, validates the JSON, then commits. It never restarts a unit and never touches a model
file. Naming overrides for NEW entries come from `--id-map FILE` (JSON `"shelf path": "id"`); the
built-in `ID_HINTS` remain the fallback.

After a webui download: re-run `wire_shelf.py` (report), review, `--apply`, then restart the units,
or the model stays invisible to `/v1/models` (the plugin reads the live catalog — nothing is
hardcoded).

`scripts/wire_scan.py` (2026-09-19) is the SUPERSEDED path: its `TABLE` mapped each shelf file to
the official `webui/configs/models_catalog.json` by hand, and a table that omits a file is exactly
how `nemotron_3_diar` went invisible after a restart (T-164). Kept for history and for its
scratch-port-8999 validation idea; do not extend the TABLE.

## Inventory of `/mnt/llama/audio.cpp` (42 GGUFs, 41 wired, 2026-09-19 snapshot)

> Snapshot date matters: `nemotron_3_diar` was wired on 2026-10-02 (T-164), so BOTH configs now
> carry **43** entries. `python3 scripts/wire_shelf.py` (report-only) is the way to read the true
> current state; this section is the historical wiring record, not the live count.

Live on both endpoints: 41 models — clon 6, tts 15, asr 8, sep 4, gen 3, diar 2,
vdes 1, vc 1, s2s 1. Wording of task = wire token from the catalog.

Key new wiring beyond the original 13: `qwen3-voicedesign` (vdes — voice design),
`qwen3-customvoice`, `qwen3-tts-bf16`, `higgs_tts`, `index_tts2`, `moss_tts_nano`,
`pocket_tts_en_bf16/q8`, `supertonic`, `vibevoice_7b`, `vibevoice_15b`, `voxcpm1`,
`omnivoice_f16`, `canary_asr`, `citrinet_asr`, `kroko_asr`, `vibevoice_asr`,
`voxtral_realtime`, `sortformer_diar_f16`, `vevo2` (vc), `personaplex` (s2s),
`controlfoley` (gen), `stable_audio_medium` / `stable_audio_sfx` (gen),
`bs_roformer` / `mel_band_roformer` / `mel_band_roformer_q8` / `htdemucs_q8` / `htdemucs_f16` (sep).
`mel_band_roformer_q8` was added on 2026-10-13: the GGUF was installed onto the shared NFS shelf with
`audio.cpp/tools/model_manager_v2.py install mel_band_roformer_q8_0 --models-root /mnt/llama/audio.cpp`, the entry
was written into each node's server JSON (configs copied to `<name>.bak.20261013` first), and the engine units were
restarted. A file on the shelf is invisible to an engine until the JSON carries it.

**The two diar models, read from their own GGUF specs (2026-10-02, one header read over ssh, no
engine call).** `nemotron_3_diar`: tasks [diar], modes **offline + streaming**, capabilities
`{diar:[speaker_turns]}`, and NO audio-length ceiling in its spec — it also answers on
`/v1/batches/transcriptions` because it implements `IBatchedOfflineVoiceTaskSession`. Its request
options are turn-shaping knobs the plugin never sends: `speaker_threshold` (float, default 0.5),
`speaker_min_frames` (int, default 0, 10 ms output frames) and `speaker_pad_frames` (default 0);
session options add `latency_profile`, `spkcache_len/fifo_len/chunk_len`, `graph_arena_mb` (1024)
and `weight_context_mb` (1024). `sortformer_diar`: `runtime::IOfflineVoiceTaskSession` ONLY, so the
batches route answers 400 `configured model does not provide native offline batching` and the plugin
re-routes it through `/v1/tasks/run`; in practice it tops out around 120 s of audio. That
asymmetry is why `batch_verify.py` diarizes with nemotron, and why a 148 s batch part is in-spec.

EXCLUDED: `Llama-OuteTTS-1.0-1B-Q8/model.gguf` — 15-byte Git-LFS pointer (broken
download). The server refuses to boot with it in config. It is the one shelf file with no usable
header, so `wire_shelf.py` reports it as `skipped: no embedded model spec` rather than wiring it;
re-fetch via the webui and it is picked up from its own spec, with `--deny` / `--max-mb` available
if it should stay off an endpoint anyway.

F16 quants: the official catalog ships **fish / chatterbox / GLM as Q8 only** — no
F16/FB16 package exists for those three (chatterbox-turbo is a separate Q8 package).
The Q8 files are what the configs reference.

Registered clone voices (shared dir, operator-placed): `bijan_0048.wav` (+ prompt_text),
`test.wav` (placed via the pre-T-76 scp flow — kept). Plugin-registry voices are
independent of the shared dir entirely.

# Catalog survey for multi-speaker handling and voice creation (2026-10-13)

Method, stated so it can be repeated: `python3 tools/model_manager_v2.py list` for the install catalog,
`model_manager_v2.py sizes <id>` for the download size and whether the id is installable at all,
`model_manager_v2.py installed --models-root /mnt/llama/audio.cpp` for what is already on the shelf, and
`ls src/models/` in the checkout for what the **build** can actually serve. The last step matters: a catalog id with
no family directory is a download you cannot run.

## Installed onto the shelf by this survey (all on `/mnt/llama`, so every node sees them)

| id | bytes | shelf path |
|----|-------|-----------|
| `mossformer2_ss_16k_f16` | 112 087 076 | `/mnt/llama/audio.cpp/MossFormer2-GGUF/mossformer2-ss-16k-f16.gguf` |
| `tf_gridnet_wsj0_2mix_f32` | 32 792 096 | `/mnt/llama/audio.cpp/TF-GridNet-GGUF/tf-gridnet-wsj0-2mix-f32.gguf` |
| `smart_turn_v3_2_f32` | 32 014 304 | `/mnt/llama/audio.cpp/Smart-Turn-v3-GGUF/smart-turn-v3.2-f32.gguf` |
| `firered_vad_f32` | 2 368 032 | `/mnt/llama/audio.cpp/FireRedVAD-GGUF/firered-vad-f32.gguf` |
| `sortformer_diar_4spk_v1_q8_0` | 175 662 720 | `/mnt/llama/audio.cpp/Sortformer-Diar-4spk-v1-GGUF/` (already there since Sep 20, alongside `...-f16.gguf` 247 915 232 B since Aug 25) |

Shelf free space after this: 396 G of 2.8 T.

## What each of these changes about the workflow

1. **Speaker-on-speaker separation is a different problem from voice-versus-accompaniment, and we have been
   pretending it is the same one.** `mel_band_roformer` and `bs_roformer` return `vocals` and `instrumental`; they do
   not separate John from Sarah. `mossformer2_ss_16k` and `tf_gridnet_wsj0_2mix` are speech-separation models - the
   wsj0_2mix name says it: two overlapping speakers in, two streams out. That is exactly the gap that contaminated
   John's clone sample, and no amount of cutting or gating can close it, because the contamination is in the stem.
2. **A second diarisation model was already on the shelf and unused.** `sortformer_diar_4spk_v1` in q8_0 and f16,
   sitting there since August and September, never carried by the engine JSON, so the plugin could not see it. Every
   conclusion this run drew about who spoke when came from `nemotron_3_diar` alone, with no second opinion available.
3. **Real VAD instead of an energy detector.** `firered_vad_f32` is 2.3 MB. Every sample length reported in this run
   came from `scripts/simple_vad.py`, a stdlib RMS gate with a hand-picked threshold (0.005 for a mixture, 0.001 for a
   stem), and its disagreement with diar speech ran 74-94 % across three files. A model VAD is cheap enough that the
   guess is no longer excusable.
4. **Turn detection.** `smart_turn_v3_2_f32` (30 MB) is a turn-boundary model, which is what "who is speaking now"
   actually means in dialogue, as opposed to "who spoke in this window".
5. **Transcribe-and-diarise in one pass.** `moss_transcribe_diarize_q8_0` (1 132 110 560 B) does both, which is the
   shape our `dispatch_speaker_asr` already asks for as two models.

## Candidates measured but not installed, with the reason

1. `sam_audio_small_f32` 5 640 890 208 B - extract a named speaker from a mixture; the direct answer to contaminated
   samples, but large and not yet known to run acceptably on 4-core CPU boxes.
2. `qwen3_forced_aligner_0_6b_q8_0` 1 129 966 496 B - word-level timing, which would replace diar edges as the source
   of cut boundaries. `mms_forced_aligner_300m_q8_0` is **not installable by this tool**: `download kind 'unsupported'`.
3. `dramabox_q8_0` 18 942 803 808 B - dramatic multi-speaker dialogue TTS, the most on-point creation candidate and
   the largest; needs a RAM decision before it is worth a download.
4. `personaplex_7b_v1_q4_k` 7 860 681 248 B, `vevo2_orig` 7 449 615 488 B (`vevo2_f16` is **already installed**),
   `fish_audio_s2_pro_q8_0` 6 317 911 232 B, `fireredtts3_instruct_q8_0` 4 149 192 928 B, `neutts_2e_orig`
   3 016 181 288 B, `qwen3_tts_1_7b_voicedesign_q8_0` 2 816 988 960 B (`..._voicedesign_bf16` **already installed**),
   `dots_tts_edit_q8_0` 2 962 805 408 B, `meanvc2_120ms_40ms_f32` 1 629 326 784 B, `omnivoice_q8_0` 1 350 288 416 B,
   `rvc_f16` 1 260 188 416 B, `irodori_tts_600m_v3_voicedesign_q8_0` 1 272 140 064 B, `chatterbox_turbo_q8_0`
   699 101 408 B.
5. `sortformer_diar_v2_1_f32_gguf_local` and `sortformer_diar_v2_1_f32_local` are **not installable by
   `model_manager_v2`** (`download kind 'unsupported'`; the tool says to use `tools/model_manager.py` for legacy
   composite or converter installs).

## Already on the shelf, invisible to the plugin, because no engine JSON carries them

From `model_manager_v2.py installed`: `vevo2_f16`, `voxcpm2_bf16`, `voxcpm1_0_5b_q8_0`, `chatterbox_q8_0`,
`cosyvoice3_q8_0`, `fish_audio_s2_pro_q8_0`, `glm_tts_q8_0`, `higgs_audio_tts_4b_q8_0`, `index_tts2_f16`,
`qwen3_tts_1_7b_base_q8_0`, `qwen3_tts_1_7b_customvoice_q8_0`, `qwen3_tts_1_7b_voicedesign_bf16`,
`qwen3_asr_1_7b_f16`, `fun_asr_nano_2512_f16`, `kroko_asr_community_q8_0`, `sensevoice_small_q8`, `vibevoice_1_5b_q8_0`,
`vibevoice_7b_q8_0`, `vibevoice_asr_q8_0`, `voxtral_realtime_q8_0`, `controlfoley_large_44k_q8_0`,
`stable_audio_3_medium_q8_0`, `stable_audio_3_small_sfx_q8_0`, `supertonic_3_q8_0`, `htdemucs_q8_0`, `htdemucs_f16`,
`mel_band_roformer_f16`. A model that is on the shelf but not in the JSON cannot be dispatched, and "we have no
alternative" is not something to conclude from the plugin's model list alone.

## Shelf permissions are part of an install (measured 2026-10-13)

`/mnt/llama` is one ceph share mounted on every node, but the account is not the same uid everywhere: on cpu2 the engine account holds the lower of the two ids, on cpu1 the higher one (the numbers are `LOCALHOSTS.md` §9). Model directories created by an install run as that node's engine account and come out `mode=700`, so
the other node cannot traverse them - `ls` answers "Keine Berechtigung" and `test -r` on the .gguf answers NO, while
the same path reads fine on the owning node. Older model directories on the share are `mode=777 uid=101000`, which is
why the long-standing roformer lane never showed this.

An engine config that names a model the engine cannot open is a startup-time failure, not a dispatch-time one, so the
order is fixed: install, `chmod 755` the new directories, verify `test -r` from every node that will load them, and
only then add the entry to the engine JSON. The registration tool used here prints `SKIP (file absent)` for a path it
cannot read, which is what kept cpu1's 8962 from being handed two models it could not open.

## rvc_f16 on the shelf, and the permission trap hit a third time (measured 2026-10-13)

`rvc_f16` (1 260 188 416 B, the family's default package) is installed at `/mnt/llama/audio.cpp/RVC-GGUF/rvc-f16.gguf`.
The family spec (`model_specs/rvc.json`) says `category: voice_conversion`, **`tasks: ["vc"]`**, `modes: ["offline"]`,
`languages: ["language_agnostic"]`, `status: experimental` - which is why it belongs on the 8963 lane and nowhere else.
It is registered in both TTS engine configs (`id / path / family`, the three fields `model_config_from_json` requires);
each config went from 48 to **49 models**, each edit backed up as `audio-cpp-cpu-server.json.bak5.20261013`. The running
engines still report 46 models until they are restarted, so the model is *dispatchable on paper only* right now.

The install came in **mode `drwx------` owned by cpu1's engine account** - and `test -r` from cpu2, whose engine account carries the other id
answered **NOT READABLE**, the same failure that made two earlier installs invisible to a second node. `chmod 755` on the
directory and `644` on the file, then `test -r` re-run **from cpu2**, came back READABLE. Only then was the model
registered. The order is not a preference: install, chmod, prove readability from every node that will load it, then
register - registering first produces a config entry the engine answers with `SKIP (file absent)` and a model that looks
registered while no lane can load it.

Two smaller facts from the same install. The first attempt, run over ssh on cpu2 while that box was saturated by two
`moss_ttsd` renders, died with `ConnectionResetError: [Errno 104] Connection reset by peer` partway through the download
and left `.RVC-GGUF.d_hsnwb7` (mode 700, owned by that node's engine account) behind; the retry from cpu1 completed the same package in one go.
`clean-partial rvc_f16` reported "cleaned 0 partial download directories" - it does not recognise that abandoned staging
directory, so a failed install leaves litter that the tool will not clean, and the litter is unreadable from the other
node. Do not run a model install on a node that is generating.

## Re-read 2026-11-14 (Berlin) — the paths and units above, checked on the node

1. **Checked, still true:** the models root exists; both server config files named here are present on that node;
   both units answer `active` to `systemctl is-active`; the shared registered-voice directory named here exists. Read
   over one ssh session, read-only, nothing written.
2. **The wired-entry count is no longer 41.** The two config files now carry 60 and 57 `models[]` entries. The task
   split read from those files: 27 `tts` / 5 `clon` / 1 `vdes` / 9 `asr` / 3 `diar` / 7 `sep` / 3 `gen` / 3 `vc` / 2
   `s2s` on one endpoint, and 22 / 5 / 1 / 10 / 4 / 5 / 3 / 2 / 2 plus one each of `vad`, `turn` and `align` on the
   other. The `vad`, `turn` and `align` tasks are new since this file was written and are not in the plugin's
   `TASK_ALLOW`, so a slot offering them is offering tasks this plugin does not dispatch.
3. **The new families are on disk**, which is what makes the 24-id difference in `MODELS_TABLE.md` a store change and
   not a catalog glitch: the dialogue family, three diarisation stores, three ASR stores, the voice-conversion store,
   the RVC store, a forced-aligner store, a SAM-audio store, a VAD store and a turn-taking store all have their own
   directories under the models root. Listed with one bounded `ls` over the same ssh session.
4. **What this pass did not touch:** the unit drop-ins, the `--voice-dir` arguments, the models-root setting, and the
   config files themselves. Nothing was written on the node. The paths above are still the paths to use.

## Re-read 2026-11-15 (Berlin) — five generator entries on every unit, a composite model's parts named in config, and one idle-unload value the config files do not carry

1. **How it was read.** The six live server configs were pulled over ssh into `scratch/fleet_cfgs_20261115_evening/`
   and read from those copies, and each unit was read with `systemctl cat` plus the live process command line of the
   running server. **Nothing on any node was written by this read**, and no unit was restarted by it. Every config path
   named in the sections above is still the path the unit's `--config` argument names.
2. **The five generator entries are on all six units, and the numbers agree with what the engines answer.** Measured from
   the configs: model entries 65, 62, 65, 63, 56 and 57 — the same counts the six slots answer over the plugin's
   `endpoint_models` and the engines' own `/v1/models` on the same evening (`scratch/slot_model_counts_20261115.json`).
   `models[]` entries carry `ace-step`, `heartmula`, `minimax-music3`, `moss-soundeffect-v2` and `mulacover` on every
   unit, and the `gen` task count on each unit is **8** where the 2026-11-14 read above recorded 3. The id, family,
   task and mode of each new entry came from the engine's own catalog; the path came from the engine's own package load
   target. The `vad`, `turn` and `align` entries named in the section above are still there and still outside this
   plugin's `TASK_ALLOW`.
3. **Each config edit was staged before it was written and re-parsed after it**, with the model-entry list and its order
   asserted unchanged, and a dated copy taken on the node before each write. The copies that exist on the nodes today,
   listed because a record that names a backup should name one that is really there:
   `audio-cpp-<unit>-server.json.bak_20261115_pre_music_models`, `…_pre_catalog_ids`, `…_pre_q8_dirfix`,
   `…_pre_minimax_session_options` and `…_pre_qualified_session_options`. The first of the two session-options passes
   wrote the component names **unqualified** on the model entry and the engine still answered that the part file did not
   exist; the second wrote them under their qualified keys, on the model entry **and** in the server-level
   `default_session_options`, and the engine's refusal moved to its own contract error. Both forms are in the configs
   today. The engine code that decides which of the two it reads is quoted in `MODELS_TABLE.md`, the re-read of
   2026-11-15, item 4.
4. **`max_loaded_models: 1` is in every one of the six config files. `idle_unload_ms` is in none of them.** On this
   fleet that knob lives on the unit — in the `ExecStart` line of the base unit on one node, and in
   `/etc/systemd/system/audio-cpp-<unit>.service.d/dynamic-models.conf` on the other two — so **a config-only look
   reports the idle knob missing**, and the value has to be read from `systemctl cat` and from the running process.
   Read that way, all four units that were running at this moment carried `--idle-unload-ms 1800000` in their actual
   command lines. The value the fleet ran before today was not uniform and the drop-in copies on the nodes say what it
   was: `dynamic-models.conf.bak_20261115_pre_idle_1800000` on both units of one CPU node and on both units of the
   other CPU node, and `…_pre_idle_600000` beside one of those — that is, 3 600 000 on one node's pair and 600 000 on
   one unit of the other before the change to 1 800 000. **This supersedes the note `TODOS.md` part one item 44
   carried**, which said the primary node's pair was left at 3 600 000: those two units were brought to 1 800 000 the
   same day and restarted at 17:33 and 17:34 (Berlin), and their process command lines are what this item reports.
   A drop-in edit needs `sudo systemctl daemon-reload` before a restart reads it, and a restart of a unit drops every
   model it holds.
5. **Unit state at the moment of this read**, said as a dated read and not as fleet state: four units on the two CPU
   nodes `active`, the two units on the node with the card `inactive` — stopped by hand on the operator's word that
   evening because that GPU is doing other work — and one of the primary node's drop-ins,
   `10-timeout-stop.conf`, is `TimeoutStopSec=90s`, which is a shutdown-timing setting and not an idle setting. The
   order for the stopped pair, if it is ever brought back, is the one the workspace guide states: start the unit, then
   release the slot.
6. **The store moved with this work.** Installed packages on the shared models store went from 78 to 83 during this
   sweep, and a download lands as a hidden `.<Package>-GGUF.<number>/` directory that is renamed when it completes, with
   a `.audiocpp-package-<pkg>.json` marker beside the package. **A model that has only been downloaded is not usable
   from this side**: the engine fills its runnable set from its own config's `models[]` or from a load made through the
   node's UI, and there is no startup scan of installed packages — so a unit restart never lists a downloaded model, and
   the entry has to be written. That is the open half of `TODOS.md` part one items 55 and 56. A 30 GB generator package
   was still downloading on one node at the time of this read and is in no config yet.
7. **What this read did not do:** nothing written, no unit restarted, no slot promoted or resumed, no `--voice-dir`,
   `ExecStartPost` or models-root hook line changed, and the two stopped units were read but not started. The counts in
   item 2 are a measurement of the configs, not a claim about what any engine had loaded at that moment.

