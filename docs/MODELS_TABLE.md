# audio.cpp engine model matrix — plugin usability

> **This file is a dated read and it is a test dependency.** Added 2026-11-04. `tests/host.test.cjs` reads this file
> with a real `readFileSync` and pins specific rows: the `fish-audio-s2-pro` row must still say "clone voice
> required", the `moss_ttsd` rows must still be absent, and one assertion deliberately records
> that **this table is stale** about the tool tasks and that `TASK_ALLOW` proves it (`:15951`). A row here is a
> fixture, so it is not edited to look current — the staleness is what the suite is proving. What the plugin actually
> serves today is read live: `POST endpoint_models {fn,id}` or `GET <engine>/v1/models`. The `:8963` / `:8962` in the
> line below are the ports of the day on the node named there; a slot's URL today comes from `GET
> endpoint_registry?fn=tts|stt`.

**The model ids in this table are the engines' own ids (T-878, 2026-11-16).** The ids this record used
before that date were this record's own names for files, and a name no engine answers cannot be matched
to a run. 73 of the 90 rows of this record and of `MODEL_PROVENANCE.md` were re-keyed to the id each
row's own file or webui package is served under, from two engine reads captured on the day and kept in
this package's `scratch/` (`GET <engine>/v1/models`, which answers `id`, `family`, `task` and `path`, and
`GET <engine>/v1/ui/models/package-sizes`, which answers the webui package id and the file it loads). The
builder is `scratch/records_recut_ids.py`, the map it produced is `scratch/records_recut_map_20261116.csv`
with its report beside it, the rows it wrote are listed in `scratch/records_recut_applied_20261116.txt`,
and the pre-change copies of both records are the `.bak_20261116_pre_records_recut_t878` copies in the same
directory. **Fifteen rows were not re-keyed and are carried unchanged on purpose:** they name a file or a
package no engine answers today, which is a fact about the shelf and not a spelling to fix. **Two rows
resolve to two ids** — one `sortformer` file answers under two ids on one engine — and they were left
alone for that reason; that finding is `TODOS.md` part one item 41. **CLOSED 2026-11-16:** the duplicate
entry was removed from both CPU nodes' stt server JSONs, at the operator's word of 2026-11-16 ("we do not want
any double registrations anymore") — on each node the second entry for the same file was deleted and its explicit
`busy_timeout_ms` and live-ingest timeout merged into the kept entry, a pre-change copy was taken on the node, and
the unit was restarted with the lane idle. The re-reads: the second CPU node answers 62 ids and the primary node
61, and on both `sortformer-diar` is the only id for that q8 file (the `sortformer_diar_f16` row names a different
file and stands). Both rows are re-keyed like every other row. The four assertions that read these
rows were re-expressed with a dated `(T-878 contract change)` note, not dropped (`AGENTS.md` 8.5).

**Re-read 2026-11-26 (Berlin) — the records half of `TODOS.md` part one item 41, at the operator's word.** The
same join was run again, this time against a fresh read of the two CPU slots in play: `GET <engine>/v1/models` on
each, captured in this package's `scratch/` as `item41_engine_models_8963_20261126.json` and
`item41_engine_models_8962_20261126.json` (64 ids between the two). The builder is
`scratch/item41_recut_measure_20261126.py` and the map it wrote is `scratch/item41_recut_map_20261126.csv`; the
pre-change copies of all three records are the `.bak_20261126_pre_item41_records_pass` copies beside them. The join
order is the engine's own: the exact id, then the engine's normalisation (`_` for `-`), then the file the row names.
**Across all three measured records — this table, `MODEL_PROVENANCE.md` and `MODELS_TEST_MATRIX.csv` — 30 rows carry
an id no live catalog answers: 8 of them are the same model under a spelling the engine no longer uses, and 22 name a
file or a package no engine answers today and are carried unchanged, as the fifteen above were.** The 22 names are in
the map file; they are not repeated here. **In this table nothing was re-keyed, and that is the measured result, not
a decision to skip:** the two rows whose id is still live (`index_tts2`, `moss_tts_nano`) name the f16 and the bf16
file, and those two ids serve the q8_0 files today — renaming them would attach this record's reads to packages it
never measured. Three rows name a model no catalog answers (`higgs_tts`, `qwen3-voicedesign`, `fun_asr_nano`); they
stay as records of the shelf. In the companion records three rows were re-keyed, in each case because the file the
row names is the file that id serves today: `sortformer_diar` in `MODEL_PROVENANCE.md`, and `vibevoice_7b` and
`glm_tts` in `MODELS_TEST_MATRIX.csv`; one further CSV row (`moss_ttsd`, bf16) was left and marked for the same
reason the two rows above were left. **Two things this pass did not touch, stated so they are not looked for:** the
preset-to-model pairings a run records, which live in the plugin's own state file and not in this repository, and
whose split-history consequence is already written in `docs/FACTS.md`, section "The same model file answers under two
ids on one engine"; and the two measured-rate rows in `lib/index.js` keyed on the old spelling, which were re-checked
and left — a measured rate cannot be renamed onto a file it was not measured on, and the family row is what resolves
today (a quant-suffixed id with no row of its own falls to the lane median, as that item states). The four
assertions in `tests/host.test.cjs` that read these rows are untouched, and the suite was re-run green.

**One operator-stated quality note, carried here because the operator said it about a row of this record
(2026-11-16, the operator-s word; the measured row beside the judgement is in `docs/FACTS.md`).** A take this lane rendered on the `glm-tts` row was judged poor by
the operator, verbatim: "quality of the GLM-TTS take is bad, should not be a favored model currently,". It
is recorded as their word with its date attached, **not** as a status in a measured column and **not** as a
recommendation: the row's measured columns are unchanged, the model stays listed, and a record says what
exists rather than what to use.

Source of truth: live `GET :8963/v1/models` on **2026-09-20** (identical catalog on :8962 —
both endpoints share `/mnt/llama/audio.cpp` and the same 41 wired config entries).
"usable in plugin as" follows the plugin's own `TASK_ALLOW` + capability derivation
(`lib/index.js`): TTS panel = wire tasks `tts|clon|vdes`, STT panel = `asr`.

**Columns "tested by agent", "verified by user", "words/min" are intentionally empty.**
They are filled in a dedicated test session on user request, with dedicated test
sentences and voices discussed with the user beforehand (AGENTS.md: ask before
testing, no synthetic test text, user judges quality). words/min measured from the
perf log (`perf_stats`) words + ms fields.

| model id | engine impl (family) | NFS model file | quant | usable in plugin as | tested by agent | verified by user | words/min |
|---|---|---|---|---|---|---|---|
| `higgs_tts` | higgs_audio_tts | `/mnt/llama/audio.cpp/Higgs-Audio-v3-TTS-4B-GGUF/higgs-audio-v3-tts-4b-q8_0.gguf` | q8_0 | TTS (built-in voice ok; clone optional) | | | |
| `index_tts2` | index_tts2 | `/mnt/llama/audio.cpp/IndexTTS2-GGUF/index-tts2-f16.gguf` | f16 | TTS (built-in voice ok; clone optional) | | | |
| `moss_tts_nano` | moss_tts_nano | `/mnt/llama/audio.cpp/MOSS-TTS-Nano-100M-GGUF/moss-tts-nano-100m-bf16.gguf` | bf16 | TTS (built-in voice ok; clone optional) | | | |
| `omnivoice` | omnivoice | `/mnt/llama/audio.cpp/OmniVoice-GGUF/omnivoice-q8_0.gguf` | q8_0 | TTS (built-in voice ok; clone optional) | | | |
| `omnivoice_f16` | omnivoice | `/mnt/llama/audio.cpp/OmniVoice-GGUF/omnivoice-f16.gguf` | f16 | TTS (built-in voice ok; clone optional) | | | |
| `pocket_tts_en_bf16` | pocket_tts | `/mnt/llama/audio.cpp/PocketTTS-GGUF/english/pocket-tts-english-bf16.gguf` | bf16 | TTS (built-in voice ok; clone optional) | | | |
| `pocket-tts` | pocket_tts | `/mnt/llama/audio.cpp/PocketTTS-GGUF/english/pocket-tts-english-q8_0.gguf` | q8_0 | TTS (built-in voice ok; clone optional) | | | |
| `qwen3-tts-1.7b-custom` | qwen3_tts | `/mnt/llama/audio.cpp/Qwen3-TTS-12Hz-1.7B-CustomVoice-GGUF/qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf` | q8_0 | TTS (voice required + ref_text) | | | |
| `qwen3-tts-1.7b` | qwen3_tts | `/mnt/llama/audio.cpp/Qwen3-TTS-12Hz-1.7B-Base-GGUF/qwen3-tts-12hz-1.7b-base-q8_0_v2.gguf` | q8_0 | TTS (voice required + ref_text) | | | |
| `qwen3-tts-bf16` | qwen3_tts | `/mnt/llama/audio.cpp/Qwen3-TTS-12Hz-1.7B-Base-GGUF/qwen3-tts-12hz-1.7b-base-bf16.gguf` | bf16 | TTS (voice required + ref_text) | | | |
| `supertonic` | supertonic | `/mnt/llama/audio.cpp/Supertonic-3-GGUF/supertonic-3-q8_0.gguf` | q8_0 | TTS (built-in voice ok; clone optional) | | | |
| `vibevoice` | vibevoice | `/mnt/llama/audio.cpp/VibeVoice-1.5B-GGUF/vibevoice-1.5b-q8_0.gguf` | q8_0 | TTS (built-in voice ok; clone optional) | | | |
| `vibevoice-7b` | vibevoice | `/mnt/llama/audio.cpp/VibeVoice-7B-GGUF/vibevoice-7b-q8_0.gguf` | q8_0 | TTS (built-in voice ok; clone optional) | | | |
| `voxcpm1` | voxcpm1 | `/mnt/llama/audio.cpp/VoxCPM1-GGUF/voxcpm-0.5b-q8_0-audiovae-f16.gguf` | q8_0 | TTS (built-in voice ok; clone optional) | | | |
| `voxcpm2` | voxcpm2 | `/mnt/llama/audio.cpp/VoxCPM2-GGUF/voxcpm2-bf16.gguf` | bf16 | TTS (built-in voice ok; clone optional) | | | |
| `breeze-tts-clone` | breeze_tts | `/mnt/llama/audio.cpp/Breeze-TTS-2-GGUF/breeze-tts-2-q8_0.gguf` | q8_0 | TTS (clone voice required) | | | |
| `chatterbox` | chatterbox | `/mnt/llama/audio.cpp/Chatterbox-GGUF/chatterbox-q8_0.gguf` | q8_0 | TTS (clone voice required) | | | |
| `cosyvoice3` | cosyvoice3 | `/mnt/llama/audio.cpp/CosyVoice3-GGUF/cosyvoice3-q8_0.gguf` | q8_0 | TTS (clone voice required) | | | |
| `fish-audio-s2-pro` | fish_audio | `/mnt/llama/audio.cpp/Fish-Audio-S2-Pro-GGUF/fish-audio-s2-pro-q8_0.gguf` | q8_0 | TTS (clone voice required) | | | |
| `glm-tts` | glm_tts | `/mnt/llama/audio.cpp/GLM-TTS-Q8/Text to audio (TTS)/GLM-TTS_Q8.gguf` | Q8 | TTS (clone voice required) | | | |
| `moss-tts-local` | moss_tts_local | `/mnt/llama/audio.cpp/MOSS-TTS-Local-v1.5-GGUF/moss-tts-local-v1.5-q8_0.gguf` | q8_0 | TTS (clone voice required) | | | |
| `qwen3-voicedesign` | qwen3_tts | `/mnt/llama/audio.cpp/Qwen3-TTS-12Hz-1.7B-VoiceDesign-GGUF/qwen3-tts-12hz-1.7b-voicedesign-bf16.gguf` | bf16 | TTS (voice-design — description instead of voice) | | | |
| `canary-asr` | canary_asr | `/mnt/llama/audio.cpp/Canary-180M-Flash-GGUF/canary-180m-flash-f32.gguf` | f32 | STT | | | |
| `citrinet-asr` | citrinet_asr | `/mnt/llama/audio.cpp/Citrinet-ASR-GGUF/citrinet-asr-q8_0.gguf` | q8_0 | STT | | | |
| `fun_asr_nano` | fun_asr_nano | `/mnt/llama/audio.cpp/Fun-ASR-Nano-2512-GGUF/fun-asr-nano-2512-f16.gguf` | f16 | STT | | | |
| `kroko-asr` | kroko_asr | `/mnt/llama/audio.cpp/Kroko-ASR-GGUF/kroko-en-community-64-l-q8_0.gguf` | q8_0 | STT | | | |
| `qwen3_asr` | qwen3_asr | `/mnt/llama/audio.cpp/Qwen3-ASR-1.7B-GGUF/qwen3-asr-1.7b-f16.gguf` | f16 | STT | | | |
| `sense-asr` | sense_asr | `/mnt/llama/audio.cpp/SenseVoice-Small-GGUF/sensevoice-small-q8-audiocpp-v1.gguf` | q8 | STT | | | |
| `vibevoice-asr` | vibevoice_asr | `/mnt/llama/audio.cpp/VibeVoice-ASR-GGUF/vibevoice-asr-q8_0.gguf` | q8_0 | STT | | | |
| `voxtral-realtime` | voxtral_realtime | `/mnt/llama/audio.cpp/Voxtral-Mini-4B-Realtime-2602-GGUF/voxtral-mini-4b-realtime-2602-q8_0.gguf` | q8_0 | STT | | | |
| `bs-roformer` | bs_roformer | `/mnt/llama/audio.cpp/BS-RoFormer-ep368-GGUF/bs-roformer-ep368-q8_0.gguf` | q8_0 | TOOLS (`dispatch_task {task_kind:'sep'}`) | | | |
| `mel_band_roformer` | mel_band_roformer | `/mnt/llama/audio.cpp/Mel-Band-RoFormer-GGUF/mel-band-roformer-f16.gguf` | f16 | TOOLS (`dispatch_task {task_kind:'sep'}`) | | | |
| `mel-band-roformer` | mel_band_roformer | `/mnt/llama/audio.cpp/Mel-Band-RoFormer-GGUF/mel-band-roformer-q8_0.gguf` | q8_0 | TOOLS (`dispatch_task {task_kind:'sep'}`) | | | |
| `htdemucs` | htdemucs | `/mnt/llama/audio.cpp/HTDemucs-GGUF/htdemucs-q8_0.gguf` | q8_0 | TOOLS (`dispatch_task {task_kind:'sep'}`) | | | |
| `htdemucs_f16` | htdemucs | `/mnt/llama/audio.cpp/HTDemucs-GGUF/htdemucs-f16.gguf` | f16 | TOOLS (`dispatch_task {task_kind:'sep'}`) | | | |
| `sortformer-diar` | sortformer_diar | `/mnt/llama/audio.cpp/Sortformer-Diar-4spk-v1-GGUF/sortformer-diar-4spk-v1-q8_0.gguf` | q8_0 | no (task `diar` not wired in plugin) | | | |
| `sortformer_diar_f16` | sortformer_diar | `/mnt/llama/audio.cpp/Sortformer-Diar-4spk-v1-GGUF/sortformer-diar-4spk-v1-f16.gguf` | f16 | no (task `diar` not wired in plugin) | | | |
| `personaplex` | personaplex | `/mnt/llama/audio.cpp/PersonaPlex-GGUF/personaplex-7b-v1-q4_k.gguf` | q4_k | no (task `s2s` not wired in plugin) | | | |
| `vevo2` | vevo2 | `/mnt/llama/audio.cpp/Vevo2-GGUF/vevo2-f16.gguf` | f16 | no (task `vc` not wired in plugin) | | | |
| `controlfoley` | controlfoley | `/mnt/llama/audio.cpp/ControlFoley-GGUF/controlfoley-large-44k-q8_0.gguf` | q8_0 | no (task `gen` not wired in plugin) | | | |
| `stable-audio-medium` | stable_audio | `/mnt/llama/audio.cpp/Stable-Audio-3-Medium-GGUF/stable-audio-3-medium-q8_0.gguf` | q8_0 | no (task `gen` not wired in plugin) | | | |
| `stable-audio-small-sfx` | stable_audio | `/mnt/llama/audio.cpp/Stable-Audio-3-Small-SFX-GGUF/stable-audio-3-small-sfx-q8_0.gguf` | q8_0 | no (task `gen` not wired in plugin) | | | |

## Notes for the future test session

- Engine constraint: `max_loaded_models=1` — every model switch pays a load; measure
  load and generation SEPARATELY (perf log records `ev:"load"` and `ev:"synth"` per
  attempt — `perf_stats` aggregates avg load ms and avg gen ms per endpoint+model).
- Clone voices for the session: use plugin registry voices (voy_doctor, voy_janeway,
  voy_neelix, bijan voices) — they dispatch inline (voice_ref base64), so they work on
  EVERY model that accepts clone references, no per-engine setup.
- `qwen3_tts` family: dispatch MUST carry voice + reference_text (ICL mode); the plugin
  supplies both from its registry. Clone-required families (`task=clon`) need a
  reference too; default-voice families render with no voice.
- Language tags: TTS wants FULL names ("English"; codes 500), STT accepts both.
- Mos-ttsd (:8960) is a SEPARATE system (batch production, pre-registered voices,
  clone_voice is manual scp+reload) — not part of this table.

## Quant default guidance (2026-10-02, upstream docs/reports/gguf_q8_performance.md)

Measured on CUDA; our fleet is CPU-only, so the VRAM columns do not transfer and the speed
ratios are indicative only. Full cross-reference:
the quant/provenance record of 2026-10-02 stayed in the old source tree, which is not carried into this package and is not on this machine (checked 2026-11-27)
and is not in this package (checked 2026-11-12).

- `qwen3-tts` = `q8_0_v2` is the upstream-recommended clone package (speaker-sensitive
  tensors kept at 16-bit storage). CONFIRMED - do not default to `qwen3-tts-bf16`.
- `higgs_tts` q8_0 is the largest measured Q8 win (1.38-1.53x warmed, 1.41x long-form).
  Our own higgs cell has never actually run (the runner sent the family name).
- `pocket_tts`: prefer `pocket_tts_en_q8` (1.01-1.21x) over `pocket_tts_en_bf16`; keep the
  bf16 row as the control.
- `voxtral_realtime`: upstream reports q4_k faster than q8_0 with effectively identical
  transcripts - candidate, verify on our audio first.
- `voxcpm2`: our file is bf16; the upstream catalog entry carries
  `session_options {"voxcpm2.weight_type": "q8_0"}` - worth one measured comparison.
- Rule to keep: quantise the backbone, never the heads or the codec encoder
  (`voxcpm1 q8_0-audiovae-f16` and `qwen3-tts q8_0_v2` already follow it; `voxcpm2-bf16` is
  the outlier). A plain q4_k of a delay-prompt family speaks the first turn and stops.

## Separation models, measured on 2026-10-13 (T-325)

One input, one engine host, one plugin route: `work/chunk_20s_441k.wav`, 20.00 s, 44100 Hz mono.

1. **`mel_band_roformer_q8` — 421 457 ms** (`ap-0062`), 241 M on the shelf.
2. **`mel_band_roformer` f16 — 534 477 ms** (`ap-0048`), 436 M on the shelf.
3. **`bs_roformer` q8_0 — never finished** the same chunk; the job was cancelled at 1081 s (`ap-0050`).
4. Model load is 1554-3645 ms in every case, so the separation stage is the whole cost. q8 is 21 %
   faster than f16 on the same material, and both roformers beat bs_roformer by a margin that is a
   measurement rather than an extrapolation. **Default for voice-sample work: `mel_band_roformer_q8`.**
5. Both roformers return exactly two named stems, `vocals` and `instrumental`, the second derived as
   mixture-minus-vocals. htdemucs is the multi-stem family and is the wrong tool for a voices / non-voices
   split; the plugin's own rule already treats its deliverables as void for this workflow.
6. **44100 Hz is a hard contract.** A 48 kHz master was refused twice with `RoFormer prepare() sample rate
   mismatch: expected 44100, got 48000`. Keep 48 kHz only for the samples cut afterwards.
7. **Cost scales with the length of the window, not with how much speech is in it.** Splitting a 257 s scene
   into windows that run on two engines is the lever that exists without new assets.
8. The engine config, not the plugin, bounds a separation: `busy_timeout_ms` is per model —
   `bs_roformer` 3 600 000, `mel_band_roformer` 7 200 000, `htdemucs_q8` / `_f16` 900 000,
   `moss_transcribe_diarize` 3 600 000, `sortformer` 1 800 000 (the last two read out of the server JSONs on the
   nodes, 2026-10-16 — they were in use for months and had never been written down here). A new model entry
   has to carry its own timeout, and a diarise window that runs past its timeout is a failed window, not a slow one.
9. **An engine will not swap a loaded model under `max_loaded_models=1`.** `ap-0058` and `ap-0060` both ended
   with `cannot load model 'mel_band_roformer': max_loaded_models=1 and every loaded model is busy`, and
   `POST unload_model` answered after 180 s with `{"ok":false,"error":"unload failed: server returned no
   error body"}` leaving the model loaded. The engines run `--idle-unload-ms 3600000`; a restart of the engine
   unit is the reliable way to free a slot. `cancel_job` does not release one.
10. **Installing a model is three steps, not one:** download it to the shelf with
    `audio.cpp/tools/model_manager_v2.py install <package> --models-root /mnt/llama/audio.cpp`, add an entry to
    each server JSON (`<home>/audio-cpp-cpu-server.json`, `...-cpu2-server.json`) with its path and
    `busy_timeout_ms`, then restart the engine unit. A file on the shelf is invisible until step two. After a
    restart, re-probe `POST endpoint_models {fn,id}` before trusting a pinned dispatch — a pin evaluated
    against a cached model list refused a model the engine already served.
11. **Never route separation to the Vulkan lane** (`gpu1`, `ErrorDeviceLost` history).

## Re-read 2026-11-14 (Berlin) — what the live catalogs answer today

**The table above was not edited.** `tests/host.test.cjs` reads it as a fixture: it pins the `fish_audio` row's
"clone voice required", the absence of any `moss_ttsd` row, and the phrase "not wired in plugin" as the proof that this
table is stale. A row there is a test input. This section is the dated read; the rows stay as the 2026-09-20 record.

1. How it was read: `GET endpoint_registry?fn=tts` and `?fn=stt`, then `POST endpoint_models {fn,id}` against the
   primary and every registered entry of both lanes — six slots, three machines. The dump is
   `scratch/model_reads_20261114.json`; it carries each slot's id, host, whether it is enabled or held, and its full
   model list. Two slots are held by the operator and one of those reports no unit online, which is what a held slot
   looks like from this side.
2. **Every model id this table names is still listed by at least one slot today.** 42 rows checked, none missing from
   the live union. Nothing here has been withdrawn from the engines, and the families and quants this table records are
   the ones still on the shelves.
3. **24 ids are listed today that this table does not carry.** Named because a dated catalog read is what this file is
   for — this is not a model choice: `chatterbox_turbo`, `dramabox`, `fireredtts3`, `firered_vad_f32`, `kitten_tts`,
   `kitten_tts2`, `kokoro-tts`, `kugelaudio`, `lfm2_audio`, `moss_transcribe_diarize_q8_0`, `moss_ttsd_bf16`,
   `moss_ttsd_q4_k`, `moss_ttsd_q8`, `mossformer2_ss_16k_f16`, `nemotron_3_diar`, `nemotron_asr`,
   `nemotron_transcribe_iq4_nl`, `qwen3_forced_aligner_0_6b_q8_0`, `rvc_f16`, `sam_audio_small`, `seed_vc_mlx`,
   `smart_turn_v3_2_f32`, `sortformer_diar_4spk_v1_q8_0`, `tf_gridnet_wsj0_2mix_f32`. The multi-voice dialogue family
   and the diarisation family are the two this package now builds work on, and neither had a row here.
4. **The "usable in plugin as" column is stale in a named way, and that staleness is what the suite is proving.**
   `TASK_ALLOW` in `lib/index.js` reads `stt: { asr, diar }` and `task: { sep, gen, vc, s2s }` today. So the rows that
   say `gen`, `vc`, `s2s` and `diar` are "not wired in plugin" are wrong about the plugin: the three generator rows in
   this table have been dispatched by this package many times since, and a diar answer is what the speaker-tagged
   transcription lane returns. Today's answer is the live read, not this column.
5. **What this pass did not re-verify:** the `.gguf` paths, byte sizes and `version_state` on the shelf — that is
   `MODEL_PROVENANCE.md`'s subject and that shelf is legacy — and each model's capability page. The node-side config
   read is in the re-read section of `MODELS_REMOTE.md`.

## Re-read 2026-11-15 (Berlin) — five generator models were registered, and each one names the input it actually needs

**The table above was not edited again**, for the same reason the section before names: `tests/host.test.cjs` reads those
rows as a fixture. This is the dated read of one test sweep, and the rows stay as the 2026-09-20 record. The run records
are `scratch/matrix_block_*_20261115.jsonl` (and `…_D_20261115_recut_20261115.jsonl`, the corrected copy of the one block
whose row states were written before their rows ended), `scratch/findings_20261115_error_classes.md`,
`scratch/music_engine_options_20261115.json` (the engines' own parameter records for these five) and
`scratch/slot_model_counts_20261115.json`.

1. **How they got listed, and what does not list them.** Five generator models were registered on all six units by
   appending config entries whose id, family, task and mode were taken from the engine's own catalog and whose path was
   the engine's own package load target. Model-entry counts per unit: 60→65, 57→62, 60→65, 58→63, 51→56, 52→57 — each
   write re-parsed with the entry order and count asserted. **A unit restart alone does not make a downloaded model
   listable**: the engine fills its runnable set from `config_.models` (`app/server/runtime.cpp:240-270`) or from a load
   made through its own UI (`:393-394`, which marks that row `configured:false`), and there is no startup scan of
   installed packages. On the shared store a download stages as `.<Package>-GGUF.<number>/` and is renamed on completion,
   with a `.audiocpp-package-<pkg>.json` marker beside it; installed packages on that store went from 78 to 83.
2. **What each of the five asks for, from the refusals they actually produced** — a capability fact, not a model choice:
   1. `heartmula` — `tags` required and non-empty (`ap-1635` refused with "HeartMuLa requires non-empty tags", `ap-1639`
      rendered with them). It accepts the length in the spelling this lane sends.
   2. `ace-step` — a `route` enum (`text2music` default; also `cover`, `complete`, `extract`, `repaint`, `lego`), plus
      `lyrics`, `language`, `negative_prompt`; its `duration_sec` default is **-1, which is the model's own planner
      choosing the length**. Rendered with the route named (`ap-1640`).
   3. `minimax-music3` — `lyrics` **required**, and **no style, prompt or tags field at all**: every other declared
      parameter is a generation knob (`num_inference_steps`, `guidance_scale`, `ar_guidance_scale`, `top_k`, `seed`,
      `ensemble_takes`…). It is a composite of five files, and which ones it loads is decided as in item 4 below.
   4. `moss-soundeffect-v2` — declares `duration_sec` (default 10, max 30) and its request handler **refuses
      `duration_seconds`**, the spelling this lane uses (`ap-1634`, `ap-1638`).
   5. `mulacover` — `melody_file`, `chord_file`, `drum_file` (MIDI paths the engine reads on its own machine), `bpm`,
      `tags`, `lyrics`, `duration_sec` default 300; it also refuses `duration_seconds` (`ap-1636`). It was not
      dispatched: this workspace holds no MIDI file, and a cover model with nothing to cover is not a test.
3. **Two of them rendered, load and generation kept apart.** Both requests carried the same real prompt preset and
   `duration_seconds: "30"`, and both takes were read back from the written files rather than taken from the row's claim.

   | model | the node it ran on | options that worked | load | generation | what came out |
   |---|---|---|---|---|---|
   | `heartmula` (7.66 GB) | a CPU node | `tags` + `duration_seconds` | 46 317 ms | 1 072 482 ms | 30.08 s, 48 000 Hz, stereo, 16-bit, 5 775 404 B |
   | `ace-step` (11.5 GB) | the Vulkan node | `route: text2music` + `duration_seconds` | 3 035 ms | 249 300 ms | 30.0 s, 48 000 Hz, stereo, 16-bit, 5 760 044 B |

   Same family, same request, about 36 times realtime on CPU against about 8 times realtime on the card — the ratio, not
   a recommendation, and it is why a heavy generator model belongs on the node that has the card.
4. **A composite model's parts are named by defaults that followed a different quant than the installed package.** The
   engine asked for `language_model_q4_0.gguf` while the package on the store carries `language_model_q8_0.gguf`
   9 889 350 208 B, `transformer_q8_0.gguf` 2 606 842 688 B, `rvq_depth_decoder_q8_0.gguf` 714 028 960 B,
   `condition_encoder.gguf` 100 678 368 B and `vocoder.gguf` 216 705 376 B — which is exactly the file list that same
   engine's own spec declares for its `minimax_music3_q8_0` package. Read in the engine: the option is looked up under
   the **qualified** name `minimax_music3.language_model_gguf` and falls back to the q4_0 file name when it is absent
   (`src/community_models/minimax_music3/session.cpp:85-86`); the `<family>.<option>` defaults are applied at
   `app/server/config.cpp:449-456`, including to a model loaded dynamically; the helper a dynamic load uses to take
   fields from the configured entry does **not** carry `session_options` (`app/server/config.cpp:458-468`); and a request
   body never reaches that path at all (`app/server/runtime.cpp:739`, the session is built from the model's own config).
   Sending the three names as request options changed nothing (`ap-1645`). What works is the server-level
   `default_session_options` block with the qualified keys, written into all six unit configs with a
   `.bak_20261115_pre_qualified_session_options` copy on each node and the model-entry counts asserted unchanged. After
   that the engine's refusal moved from a missing part to its own contract error (`ap-1647`, `ap-1648`), which is the
   proof the parts half is settled.
5. **Two voice-clone families rendered with a voice named** — the same two rows that the capability bar had refused for
   not naming one, which is the bar doing its job rather than blocking a test. Both carried a registry voice and both rows
   report `voice_mode: clone_sample`: `chatterbox` load 1 097 ms, generation 253 349 ms, 19.6 s out, 24 000 Hz mono,
   940 844 B (`ap-1642`); `cosyvoice3` load 12 851 ms, generation 393 905 ms, 19.24 s out, 923 564 B (`ap-1643`).
6. **One model name is cut off two slots, silently.** Every slot was read against its own engine
   (`scratch/slot_model_counts_20261115.json`): the two CPU **speech** slots' engines answer **65** models each and this
   plugin's stored lists carry **64** each, and the name missing from both is `kugelaudio`, an ordinary `tts` model the
   engines list as configured. The two **transcription** slots match their engines exactly (63 and 63, 62 and 62). The
   bound is `MAX_ENDPOINT_MODELS = 64` (`lib/index.js:1653`, applied in `endpointModelNames` at `:9555-9563`) and the cut
   carries no note on the answer. The Vulkan node's two slots answered no engine at the time of this read — their units
   were stopped on the operator's word that evening — and the lists held for them are 56 and 57 from before the stop.
7. **What this pass did not settle, said so it is not read as settled.** `minimax-music3` has not rendered here: its
   required `lyrics` cannot ride this plugin's option value rule (`TODOS.md` part one item 57), and the parts question
   above is fixed while the lyric question is open. **Corrected 2026-11-17:** the lyric half of that sentence is
   closed — `CHANGELOG.md` T-885 makes the value rule read the parameter's own record, brackets and line breaks included.
   What this line still records is the other half: `minimax-music3` has still not rendered here, and that needs a row on
   the lane, not a rule. `mulacover` was never dispatched. A 30 GB generator model is
   downloading on one node and is registered nowhere yet. The two generator families that refuse `duration_seconds` are
   still refusing it, and the row that asked with the engine's own spelling was aborted by a harness restart before it
   produced a take (`ap-1641`), so that half is measured up to acceptance and not to audio.

