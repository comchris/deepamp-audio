# PLUGIN FACTS — read this instead of re-investigating

Compact, verified facts for `deepamp-audio`. Cite these in briefs. If a brief needs a fact that
is not here, that fact is NEW and must be verified once and added here.

Verified in this package on 2026-11-04 00:2x Berlin. Two mechanical checks were run over this whole file against
`lib/index.js`, `lib/client.js` and `tools/index.js` (`/tmp/facts_token_check.cjs`, `/tmp/facts_number_check.cjs`,
output in `audio-play-cordis/scratch/`):

1. **Every identifier this file names is either still in the source or names something that was never in this
   package.** 20 backticked tokens do not appear in the three sources, and each one is accounted for: engine-side
   config fields (`default_request_options`, `voice_presets`, `min_free_memory_mb`), fields of an engine's answer
   (`endpoint.models`, `status:ok`, `loaded:false`), packaged speaker ids (`Vivian`, `Ryan`), systemd and GPU
   literals (`WatchdogSec`, `sd_notify`, `mem_info_vram_used`, `glslc`, `GL_EXT_bfloat16`), one hostname with a port,
   and two pieces of prose. No verb, no plugin function, no constant in this file has gone missing.
2. **Of 95 distinct numbers, 89 appear in the source.** The 6 that do not: a line count in this header, a GPU model
   number, a port of a disabled lane, one source line reference, and two dated memory readings. The plugin's own
   bounds — the capability reader's TTLs and caps, the frame and take limits, the job timeout range — still match the
   code.
3. **What is NOT re-derived here is the semantic half.** Every behaviour claim below was written against a dated read
   of an engine or a node. A statement about what a machine did on 2026-10-07 or 2026-10-08 is a measurement with a
   date on it. Treat such a line as a pointer to verify, and read the live answer with the verbs this file names.

Sizes, re-measured 2026-11-04: `lib/index.js` 23 066 lines, `lib/client.js` 26 159 lines, `tools/index.js` 392
lines, 26 suites under `tests/`. The body carries the date it was last verified in the tree this copy was made from —
2026-10-07 22:55 Berlin, when those two files were 11 793 and 6 477 lines.

**What was taken out of this file on 2026-11-04, and why.** The Fleet table, the dated "live fleet" read under
Placement preference, and the machine literals in the last two sections are **fleet state**, and the operator's ruling
of 2026-11-03 (WM-27, "it's dynamic and should be taken from the plugins current settings") says fleet state is not a
document's content, dated or not: it is read in the session that needs it. Those lines were replaced by the verbs that
answer them. Nothing was deleted from the record — the full dated reads stand in the tree this copy was made from
(`audio-play-cordis/FACTS.md`) and in `CHANGELOG.md`. The **rules** those sections carried are kept, because a rule is
not a state: a dialogue batch stays off a slot the operator holds for single voice; a Vulkan unit is started by hand
before its slot is released; a lost GPU context is invisible to systemd; `MemoryPeak` on those units is not a leak
meter.

## Method rules (agreed 2026-10-07 and 2026-10-08, to stop doing work twice)

0. **Implement host changes under ~200 lines MYSELF.** A subagent costs re-derived context plus a double suite run for an
   80-line diff (T-255). Delegate only large or multi-file work, and in the brief: a tool-call ceiling, "run only the affected
   suite", "read only these ranges", "report 30 lines or less". Docs, skills and TODOS are always my own work.
1. **Group by code region, not by ticket number.** T-248a (reader) and T-252 (its transport) were one
   feature split in two; each re-derived the same code. One chunk = one region of one file.
2. **Anchor-first briefs.** Give exact `file:line` ranges and say "read only these ranges". Never let
   a subagent read the whole 11.8k-line host or the 8.9k-line test file.
3. **Evidence budget, tiered.**
   - Behaviour change: 11 suites once + pre-edit A/B on the affected suites only.
   - Plumbing / additive-only: 11 suites once + non-vacuity proof on the NEW assertions only.
   - Skip the second full suite run when the change is unreachable by default.
4. **Assertion cap:** 8-12 new assertions for plumbing; heavy assertion sets only for behaviour
   contracts. Never delete or weaken an assertion; re-express with a `(T-NNN contract change)` suffix.
5. **One short REPORT.md (<= 60 lines).** Separate transcripts only when a bug was found.
6. **Batch host chunks, then one restart.** Batch UI chunks into one client pass at the end.
7. Repro scripts stay out of the `*.test.cjs` glob (package.json:9 runs eleven suites).

## Engine (audio.cpp) — verified against a live Vulkan endpoint

- No specs route. `/v1/ui/specs`, `/v1/model_specs`, `/v1/ui/model_specs`, `/v1/capabilities`,
  `/v1/ui/models/specs` all `not_found`.
- Capability data lives ONLY in the served page `GET <endpoint>/`: **1 672 292 bytes**, everything
  inlined as minified JS literals (`moss_ttsd:[{name:"instruct",type:"text",...}]`, `default:!1`,
  `default:.6`). The map variable name changes every build (`kx` today) — locate by STRUCTURE.
- Reader `model_capabilities` (host, T-248a + T-252) parses that page to a temp file and answers:
  **126 families / 416 params / 112 specs**, `source: bundle | unknown`, TTL 600 000 ms (bundle) /
  30 000 ms (unknown), max 8 URLs, one request per miss, no poller, no perf-log record for reads.
- Speech body key is **`input`**, not `text`. `/v1/audio/voices` is GLOBAL (ignores `?model=`).
- Routes: `/v1/models`, `/v1/models/load|unload`, `/v1/ui/upload`, `/v1/ui/models/install|delete`,
  `/v1/audio/speech`, `/v1/audio/transcriptions*`, `/v1/batches/transcriptions`,
  `/v1/audio/alignments`, `/v1/tasks/run|batch|stream|unload_models|unload_all_models`.
- Engine upload root is `temp_directory_path()/("audiocpp-ui-" + microseconds)` and is `remove_all`'d
  at shutdown: **the directory is the engine process identity**.
- `max_loaded_models: 1` per engine → one running row per endpoint.
- Config supports per-model `load_options`, `session_options`, `default_request_options`,
  `voice_presets`; server-level `min_free_memory_mb`, `busy_timeout_ms`, `max_loaded_models`.
- `builtin_voices` exists for SIX families only: kitten_tts, kitten_tts2, kokoro_tts (54),
  pocket_tts (1: alba), kugelaudio (4), lfm2_audio (4).
- `qwen3_tts`: tasks tts/clone/design; needs speaker_reference (clone) and voice_design (design);
  wire option `instruction`, param `speaker`; presets are packaged speaker ids (`Vivian`, `Ryan`).
- `moss_ttsd`: tasks tts/clone; needs long_form + multi_speaker + speaker_reference; params
  instruct, temperature, top_p, top_k, repetition_penalty, **max_frames**; session knob `weight_type` only.

## What a built-in speaker name and a cast count are worth at the engine-s own door (measured 2026-11-23 Berlin, one CPU node, engine `dev 9999a82e 2026-11-23`)

1. **A cast is bounded by the engine, and the refusal says the number.** A five-voice scene — one line per speaker, five distinct registered voices, pinned to that node — was planned by this plugin with no refusal of its own and answered `500 VibeVoice 1.5B supports at most 4 reference speakers` at 0 bytes (`ap-1920`). That family-s own spec carries **no speaker-count field**: the bound exists only as a sentence in its `description`, so there is no number on the record to read and refuse above, and inventing one in a table is the shape of claim this lane refuses. The engine-s sentence is the answer and it is carried on the row. (`CHANGELOG.md` T-917/T-918 pass; `TODOS.md` item 87, closed on this measurement.)
2. **A built-in speaker name a record publishes is not a licence to render.** A name this plugin read from a model-s own published record — and echoed back inside its own refusal — was refused by the same runtime that published it: `500 unknown Kitten voice id: Aino`, and the identical sentence for the lowercased spelling (`ap-1919`, `ap-1921`), on a model whose only voice mode is `preset_speaker` with 256 names. What that runtime accepts instead is not readable from this side: `GET <engine>/v1/audio/voices` lists only the uploaded samples (13 of them), not built-in speakers. (`TODOS.md` item 75.)
3. **A model-s own built-in speaker name renders, once this side reads the model record at all.** Measured on the same node after `CHANGELOG.md` T-918: the request that had been refused at the door — that model, the name `dylan` — was accepted (`voice_mode: preset_speaker`) and rendered, 357 164 bytes, model load 21 401 ms (`ap-1922`). Read beside item 2 above, the two cases are not one rule: for that checkpoint the model-s own list is the id space the runtime takes, and for the other family the names it publishes are not. It is measurable per model, and it is measured per model, not assumed either way. (`TODOS.md` items 72 and 96, closed on this measurement.)
5. **A built-in voice list in an engine record is family-scoped; the runtime that accepts a name is package-scoped.** Measured 2026-11-24 (Berlin), one CPU node, engine `dev 9999a82e 2026-11-23`. That engine's own family spec (`kitten_tts.json`, in the node's model-spec directory) describes itself as covering two generations — "Native KittenTTS Mini 0.8 and multilingual KittenTTS 2 Mini" — and its `voice_id` enum is the union of both: 280 names, 16 languages, no per-package split. The checkpoint on the lane was the Mini 0.8 package, which that same text says is English-only and defaults to `Leo`. Three dispatches, in order: `Aino` refused, `unknown Kitten voice id: Aino` (`ap-1919`); `aino` refused with the identical sentence (`ap-1921`); **`Leo` rendered, 322 444 bytes, model load 3 433 ms (`ap-1923`)**. So the plain name is the right spelling, the accepted set is the loaded package's own speakers, and a name from the record is not a licence. The record offers a "package-qualified ID" form and gives **no example of it anywhere**, so that form cannot be constructed from the record — it is the engine's to document. (`TODOS.md` item 75, closed on this measurement; the wording consequence for this plugin's own answer is item 105.)

4. **This plugin holds two voice-name sources and they are not one list.** The voice-mode answer reads the family record **and** the model-s own published record (T-782); until `CHANGELOG.md` T-918 the reference_text door read only the family one — which is how one answer could offer nine built-in speakers while the other said that family lists none. Any later "is this name a built-in speaker" question reads both (`builtinVoicesKnown67` plus `capCachedModelVoices`) and tests the name with the case-folded membership the capability bar uses.

## Fleet (read 2026-10-07 22:55 — superseded as state; the table it carried is in `audio-play-cordis/FACTS.md`)

1. **What is no longer written here (operator ruling 2026-11-03, WM-27).** Which slot is `primary`, which is enabled
   or held, what an engine's catalog lists, what an entry's id is — read it in the session that needs it: `GET
   endpoint_registry?fn=tts|stt`, `POST endpoint_health {fn,id?}`, `POST endpoint_models {fn,id}`, `GET queue_status`.
   The ids this section carried (`e-1`, `e-5`, `e-6`, `e-8`) and its claim that the Vulkan node held both primaries
   are superseded several times over. Registry ids are a global sequence and are never reused, so a number carries no
   meaning beyond the entry it named.
2. **What stands as a rule.** The Vulkan node's engine units are **not started at boot**. Before either of its slots
   can serve the order is fixed: start the unit by hand, then release the slot (`endpoint_resume`, or clearing the
   operator hold). the privileged form needs no prompt there (the sudoers state itself is recorded in the workspace realm, not here), and the pair is started together.
3. **The operator's decision of 2026-10-07 stands**: a dialogue or batch render is not sent to a slot the operator is
   holding for single-voice work. `batch_allowed` on the registry entry is what says so, and it is read from the
   registry, not from this file. No model is banned by that rule.
4. `endpoint_promote {fn,id}` is the ONE set-as-primary verb. `endpoint_models` is POST-only, needs `{fn, id}`, answers
   under `endpoint.models`, and its cached answer drops on a promote.

## Measured GPU economics (gpu1, RX 5700 8 GB, q8)

- Generation ~4.7x faster than CPU; load ~4.7x slower. Warm load ~0.3 s, cold 32.7 s.
- `moss_ttsd_q8` **single voice works** (2.08 s audio, gen 118 021 ms cold).
- **Multi-speaker dialogue wedges it every time**, at ANY frame budget: `max_frames 64` (5.1 s of
  audio) still generated 153 s and then `vk::Queue::submit: ErrorDeviceLost`. `max_frames` bounds
  output length, not what the path loads. Cleared by `systemctl restart audio-cpp-vk.service`.
- **The CPU node's Vulkan backend stays DISABLED** (the standing rule of 2026-09-11). That rule does not extend to
  the separate Vulkan node. What a slot is currently doing is read with `GET endpoint_registry?fn=tts|stt`.

## GST-2 sweep result (135 probes, 45 models x 3 TTS endpoints)

30 rendered / 24 correct plugin refusals / 75 engine errors / 5 timeouts / 1 device-lost.
Errors: **28 wrong-lane** (`requires an audio ...` — ASR or separation model on the speech lane),
**17 `cannot load model ...: max_loaded_models`** (runtime state, not capability), 9 missing voice,
1 device-lost. TTS catalogs already contain `bs_roformer`, `mel_band_roformer`, `htdemucs_q8`,
`qwen3_asr`, `nemotron_asr`, `nemotron_3_diar` — the GST-1 models are on the engines with no verb.

## Plugin decisions that are settled (do not re-litigate)

- Prefer-primary: primary first when its lane is enabled, free and able; else node-first unless pinned.
- Retry re-pin: only while the endpoint is still enabled and available; else node-first on the next host.
- A placement WAIT is never a failure. A refusal is never a failure against the auto-pause ceiling.
- No host health poller; reads write no log records. A pin is evaluated alone and never falls back.
- Capability bar (decided 2026-10-07): **refuse by default from KNOWN capability, `force:true`
  overrides, `unknown` stays permissive.**
- Park keys on a queued row: `endpoint_pending`, `endpoint_wait`, `machine_wait`,
  `endpoint_slot_wait`, `endpoint_boot_wait`.

## Settled 2026-10-08 (do not re-litigate)

- **Multi-speaker moss_ttsd dialogue is not usable on the Vulkan card.** Measured on the same region, 9 parts each side:
  cpu2 CPU **9/9 ok**, gpu1 Vulkan **0/9 ok** (5 `ErrorDeviceLost`, 1 empty reply, 1 stale stage). Single-voice
  moss_ttsd on that card works. Dialogue goes to the CPU lane; `batch_allowed:false` on the Vulkan TTS primary enforces it.
- **`max_frames` bounds output length, not what the path loads.** 64 frames (5.1 s of audio) still generated 153 s and killed
  the GPU context. Frame budget is not a wedge fix.
- **Queue pump (T-255):** walks queued rows oldest-first, parks what it cannot start and CONTINUES. Per-endpoint FIFO via
  `rowLaneOf` + `ahead[lane]`; batch part order via `batchPredecessorOf` (`batch_id`, `batch_part - 1`); park key
  `batch_order_wait`. A parked row never blocks a different endpoint again.
- **Engine units are correct:** `Type=simple`, `KillMode=control-group`, `Delegate=no`, ExecStart the binary directly. A stop
  kills the engine cleanly (`Result=success`, `ExecMainStatus=0`). The gap is that a **wedged engine is not a failed engine**:
  the unit stayed `active` and `/health` answered `ok` for hours with a dead GPU context. No `WatchdogSec` on any of the six.
- **gpu1 memory readout (CORRECTED 2026-10-08, see the GPU probe section): amdgpu sysfs DOES expose it**
  as `/sys/class/drm/card2/device/mem_info_vram_used|mem_info_vram_total|mem_info_gtt_used|mem_info_gtt_total`. The
  earlier claim was a wrong attribute NAME (`.../device/mem/vram_used_mb`). systemd reports the cgroup RAM peak
  (`Consumed ... 144.2M memory peak`). Use `systemctl show -p MemoryPeak -p MemoryCurrent <unit>` for RAM; VRAM has
  interface there. cpu1 `TimeoutStopUSec=10 s` vs 90 s on cpu2 and gpu1.
- **Voice references are homogeneous:** all 13 in the plugin voice store (`~/.dsh/deepamp-audio/voices/`; the
  store was renamed from `~/.dsh/audio-play` on 2026-11-07 and the samples moved with it, nothing was recopied)
  are `pcm_s16le, 24000 Hz, mono, 16 bit`. Sample
  rate mismatch is NOT the garble cause. Suspect: reference length and the quality of `noplacelikelocalhost`.
- **Voice sample rule (user):** ~15 s, normal volume, a range of words; combine small chunks into one sample; re-verify by
  transcribing the rendered output.
- **Separation, SFX and music already have verbs:** `dispatch_task {task_kind: sep|gen|vc|s2s, model, file_path}` on the TTS
  endpoint; separation returns four WAVs in `named_audio_outputs`. GST-1's real gaps are mix-back, video remux, the voice-mode
  schema, an orchestrator, and (fixed) T-255.

## Capability bar (T-248b, landed in code 2026-10-08, live after the next restart)

- The engine's `capabilities` map is **per task**: `kokoro_tts` declares `tts:["built_in_voices","long_form"]`, while
  `pocket_tts` declares only `clone:["speaker_reference"]` and carries its built-in voices on the UI side
  (`builtin_voices ["alba"]`, `default_voice "alba"`). Keying a voice rule on `capability_needs` alone misses pocket_tts, which
  is exactly the family that errored live in GST-2 with no voice.
- Exactly six families in the gpu1 build report a built-in voice list: `kitten_tts, kitten_tts2, kokoro_tts, kugelaudio,
  lfm2_audio, pocket_tts`. `moss_ttsd` reports an EMPTY list, so a built-in-voice rule can never catch it.
- The bar (`capabilityGate` in `lib/index.js`) refuses from KNOWN capability only: a wire `task` that is not
  `tts/clon/vdes/clone/design`, a family whose declared tasks hold no speech task, or a built-in-voice family with no voice
  named. `force:true` overrides (row note `capability bar overridden (force:true): <rule>` + one `cap_override` record).
  UNKNOWN — no catalog entry, no matching family, empty task, unreadable page — stays permissive.
- A bar refusal happens before a row exists: no id spent, no `job outcome`, no endpoint paused, nothing counted against the
  auto-pause ceiling.
- Cost: the `FAMILY_CAPS` families (moss_ttsd, qwen3_tts) are answered from the catalog with NO capability page read, fetched
  catalog or not. A page read happens only for a family with no empirical row, through the reader's cache, once per endpoint
  per TTL. The bar lives BEFORE the T-248a reader section so the reader keeps its no-perf-write contract.

## Voice modes (T-248c, landed in code 2026-10-08, live after the next restart)

- Vocabulary, declared once in `lib/index.js`: `no_voice | preset_speaker | clone_sample | voice_design | dialogue_positional`.
- `GET voice_modes?fn=tts&model=<id>[&endpoint_id=e-N][&family=<key>]` answers what a model CAN serve, each mode carrying the
  engine fact that earned it. Unknown model -> `ok` with `known:false` and an empty list, never a refusal. One reader call at most.
- `no_voice` and `preset_speaker` are complementary and the built-in voice list decides which: a family that lists built-in
  voices needs a name, a family that lists none renders on its own voice.
- A dispatch may state `"voice_mode"`; the capability bar checks it against the engine record only (no record, no check) and
  `force:true` steps over it. The mode is derived for every row (cast -> dialogue_positional, dispatch_mode samples/upload ->
  clone_sample, name -> preset_speaker, no voice -> no_voice), stamped once in `enqueueTtsJob`, read in three places, and
  revalidated against the vocabulary every time.

## Two measurements worth not rediscovering

- `dispatch_stt` BLOCKS until its job reaches a terminal state — the response is resolved by a waiter. A short curl timeout on a
  transcription is not a failure: the row exists and is running. Fire many dispatches in parallel (one per STT endpoint) or poll
  `job_status?job_id=`, and read the transcript from the row's `transcript` field.
- `part_seconds: 30` derives `max_frames 375` = **30.08 s of audio**, and a dense part (70+ words) overruns it on both CPU and
  GPU: the take is cut mid-sentence at exactly 30.08 s. In strek6 scene 01's 30 s split, three of nine parts (77, 61 and 74
  words) hit the cap. Text loss in those parts is the budget, not the voice.

## Placement preference (T-228, 2026-10-08) — do not re-derive

1. `GET|POST /api/deepamp/prefer_primary` is a persisted settings switch, **default OFF**. (The route was
   `/api/audio-play/prefer_primary` when this line was written; T-718 moved the prefix 2026-11-03 — the verb and its
   behaviour are unchanged.) OFF is the T-203 / T-208 placement
   (node-first; inside the free-machine group the LRU clock decides, the primary included). ON moves the primary lane to the
   front of the FREE group only when it is eligible, unpaused, its slot free, its machine under the cap and known serving.
2. The preference is a re-sort INSIDE the free group, never a tier above it. Measured and rejected: a tier above the group costs
   15 assertions (T-208 a0/a/b, T-208 (f) x3, T-224 (d) x3, T-205a x3, T-203 x3) because it lets a busy primary machine outrank a
   free machine. A permanent in-group preference costs 6 assertions (the ones that say the primary is not special). Both are
   archived at `artifacts/t228_prefer_primary_20261008/`, and that directory is NOT in this package: it was never
   carried into it and lives in the source tree at `../../audio-play-cordis/artifacts/` (checked 2026-11-12). The two
   counts are stated in this line, and they are what the settled decision rests on.
3. A busy primary is not preferred: its slot test takes it out of the free group, so the next row goes to a free secondary. A
   paused primary, an offline primary, and an unknown primary are never preferred, and preference never parks a row with
   `endpoint_boot_wait`. A pin outranks the switch. The preference reads the cached health answer and starts no probe.
4. `dispatch_batch` places unpinned parts through the same rule (lib/index.js:8146), so with the switch ON an unpinned dialogue
   batch prefers the primary; the audiobook dispatch pins its CPU-only renders, and a pin is how a batch stays off the primary.
5. The live fleet is not written here (operator ruling 2026-11-03, WM-27): `GET endpoint_registry?fn=tts|stt` names every
   slot, which one is `primary`, and which are held, in the session that needs it. The dated read this line carried
   (2026-10-08: two host:port primaries plus four registry ids, and a note that the workspace index was stale on it)
   is superseded several times over and stands unchanged in `audio-play-cordis/FACTS.md`. What the read was for stands
   unchanged: placement preference is evaluated against what the registry says **now**, never against a copy of it in a
   document.

## Park reasons on a queued row (T-255 + T-244, 2026-10-08) — do not re-derive

1. Every queued row the pump walks carries EXACTLY ONE current park key: `endpoint_wait | endpoint_slot_wait | machine_wait |
   endpoint_boot_wait | endpoint_pending | batch_order_wait | lane_wait`. All six per-row keys are cleared at the top of each
   walked row and re-decided on that pass.
2. `lane_wait` (T-244) is the LANE reason: `{ paused_by: 'operator'|'auto_pause', reason, fn }`. `paused_by` is `auto_pause`
   exactly when `queues[fn].autoPaused` is non-empty (the T-206 wedge text rides inside it), otherwise `operator`. It is stamped
   by `pump()` at the point where the walk stops on a paused lane, on that row and every still-unwalked queued row.
3. `pause_fn` does not pump; `resume_fn` does; **`loadState` deliberately never pumps at boot** (a restart dispatches nothing),
   so restored rows in a forced-paused lane only get their reason at the first pump event. Do not "fix" that by pumping at boot.

## The engine-slot park (T-763, 2026-11-09) — do not re-derive

1. An engine's `cannot load model '<x>': max_loaded_models=1 and every loaded model is busy; retry later` is a
   **capacity** answer about an endpoint that is up and answering in about a second. Since T-763 it PARKS the row and
   spends nothing else: no `autoPauseEndpoint`, no entry in `failRun`, no `failStreak` / `wedgeStreak` / `busyStreak`
   movement, no lane pause. The operator's ruling is on `../../TODOS.md` WM-38 item 10(b) — asked whether such a
   refusal should cost the lane a strike, the answer chosen was "No: park and retry, do not count it".
2. The split is `job.err_slot_load_refuse`, set from `SLOT_LOAD_REFUSE_RE`. The OTHER half of
   `isSlotWedgedRejection` — `the previous request has likely wedged and cannot be cancelled` — keeps every behaviour
   T-649 gave it, the brake included. That half is the engine saying it is stuck; this half is the engine saying it is
   occupied. The routine `HTTP 503 server busy` answer is untouched too: it still runs the wait-for-slot ladder and
   the busy streak, and item 5 of "The wedge brake" below still stands.
3. What does the work instead of the brake is the engine-slot hold (`markEngineSlotHeld`, `ENGINE_SLOT_HOLD_MS` = the
   engine's own `busy_timeout_ms` 300 000). Since T-763 the pump gate in `startQueuedJob` reads it, so a row that
   already carries a placement — a pin, the primary lane, a row restored from the state file — parks instead of being
   sent back into the same refusal. Before this card the hold was consulted in placement and on the board only, which
   is why a pinned row walked into it twice. Measured 2026-11-09 on ap-1298 and ap-1301 (each refused in seconds, one
   healthy CPU endpoint taken out of the lane) against a slot still owned by ap-1300, a take a harness restart had
   orphaned on the plugin's side only.
4. The park is `endpoint_slot_wait` carrying `engine_hold` — the engine's own sentence — instead of `job_id`, because
   there is no plugin row to name as the holder; the panel quotes those words rather than inventing a neighbour
   (`slotWaitHolder763` in `lib/client.js`). It is bounded twice: `SLOT_PARK_MAX763` 3 re-dispatches per row, and
   `SLOT_WAIT_MAX_ARMS763` 10 one-shot re-check arms 30 000 ms apart per queue (10 × 30 s = the engine's own window,
   so a parked row is not left waiting for an unrelated event). After the row cap the row ends in error naming what
   was tried, and the endpoint is STILL not braked.
5. What did not change: an unpinned row is still re-placed onto a lane that is not held (T-649 (c) and its assertion
   stand unchanged), and a pinned row is not slid off its pin — a pin is evaluated alone and never falls back, so the
   answer to ap-1301 was never "render somewhere else", it was "wait for the slot you asked for".
6. **Why this answer reached one lane and not the other, measured 2026-11-15 and closed by T-869 that evening — do not
   re-derive it either.** All ten rows of the 2026-11-15 read-aloud split carried the same engine sentence, and the
   task-lane rows parked while the speech-lane rows ran the 20 / 40 / 60 s ladder and were written `cls: busy`. The
   difference is not a policy and not the model: `speechSpec` writes its response with `-o '<out>.part' && mv
   '<out>.part' '<out>'`, and `--fail-with-body` puts the body of a 4xx/5xx **inside the file the `-o` names**, so
   stdout is empty and `serverErrorOf` can only return curl's own line — `curl exit 22: curl: (22) The requested URL
   returned error: 503`. The classifiers that exist for the engine's sentence (`SLOT_WEDGED_RE`, `SLOT_LOAD_REFUSE_RE`)
   were never given it; the body was recovered afterwards by `sweepPart` / `capturePartBody`, which run after the
   whole retry ladder, so it arrived only as text on the row's error. The task route passes no `-o`, its body is on
   stdout, and it parked. **Since T-869 the speech call site hands `runEngine` the `.part` path, the bounded reader
   runs before anything is classified, and what it returns is given to those two classifiers and to nothing else** —
   every other classifier reads `err` as before — and `sweepPart` reuses that text instead of reading the file twice.
   Two test-side facts belong with this, because both hid the defect behind a green suite: the `speechFail` seam in
   `tests/host.test.cjs` answered the body on stdout **and** in the `.part`, a shape the real `-o` route cannot
   produce, and the two legs `capturePartBody` needs (`stat -c %s`, then `head -c 200`) are gated behind the
   session-identity engine options — a `speechFail` instance without them cannot reach that reader at all. Both are
   now available opt-in as `speechFail {partOnly:true, body:'…'}` and `partReadSeam869:true`. The rows this was
   measured on are `ap-1651`, `ap-1659`, `ap-1669`, `ap-1677`, `ap-1685` against `ap-1689`, and the dump is
   `scratch/ap1659_chunk_split_20261115.json`; the live re-check the operator asked for is `TODOS.md` part one
   items 48 and 52.

7. **The whole cycle measured on the live lane, 2026-11-17 23:25–23:52 Berlin — the park chain, the exhaustion, and the orphan behind it.** A pinned voice-less row (`ap-1733`, primary) met an engine whose slot was held by an orphan: a 30 s music generation the plugin had cancelled at 22:29 kept computing inside the engine. The perf log carries the chain minute for minute — `engine_capacity_park` at +2 s, +302 s and +604 s (the re-arms land on the engine's own 300 s window), `engine_capacity_park_exhausted` at +905 s on the fourth busy answer — and the row then ended in error naming the engine's own 503 sentence, with no brake, no lane pause and no ceiling credit spent (the same log carries 19 `no_brake_capacity_refusal` lines beside it). A later row (`ap-1734`) reached the OTHER half of the split and took its old behaviour whole: `model 'minimax-music3' is busy: current inference has run 5 919 342 ms (busy_timeout_ms=300000); the previous request has likely wedged and cannot be cancelled`. Recovery was a restart of the node's tts unit — the unit was "in use" only by that orphan, nothing waited for it; the unit and the cost are named on the session record — followed by the re-reads item 12 of the agent guide requires before any further dispatch. The park keys were re-read live and are correct in all three shapes: a row behind a plugin row names `job_id`; a row behind the engine names `engine_hold`; and a row the pump re-places names the out-of-play candidate it parked behind (`endpoint_wait` on the held GPU slot with `held_by:"operator"`) **while the row's own placement keys keep naming its pin** — a row pinned to the primary that is re-placed behind a held candidate is not un-pinned, and its `endpoint_id`/`endpoint_pinned` stay on the pin it holds.

## The wedge brake (T-246, 2026-10-08) — do not re-derive

1. A T-206 endpoint-evidence trigger (`slowPair` >= 2 consecutive failures averaging >= `SLOW_AVG_MS` 15 000 ms, or
   `connPair`, or `wedgeStreak >= WEDGE_MAX_STREAK` 3) now pauses the ENDPOINT the failing row ran on, not the fn lane.
   The lane pauses only when `endpointAvailableCount(fn) === 0` after that brake, or when the ceiling is crossed
   outright (`hard`). `WEDGE_MAX_STREAK`, `SLOW_AVG_MS`, the pair-partner discipline and the `wedgeReason` text are
   unchanged; capability and boot-window answers still take no wedge credit.
2. The brake is the same per-endpoint pause `endpoint_pause` writes. `autoPauseEndpoint` never sets `queues[fn].paused`,
   never errors a row, never dispatches, never starts a timer. Rows behind it stay queued with `endpoint_wait`.
3. `paused_by:'auto_pause'` and `pause_reason` appear on `endpoint_registry` / the primary view ONLY for a brake this
   session applied; an operator pause has neither key. `autoPauseInfo` is session-local (like `primaryHealth`): after a
   restart the pause survives (it is the endpoint's own persisted flag) but the who/why is gone, and a restored pause is
   treated as an operator's. `endpoint_pause` / `endpoint_resume` / `endpoint_update {paused}` clear the automatic record.
4. Releases: `resume_fn` releases every brake this session applied on that lane (automatic only). A row that walks into
   a brake on the endpoint it was already placed on fires one bounded pre-flight (`BOOT_MAX_PROBES` 4 per brake,
   `BOOT_REPROBE_MS` 15 000 ms apart); an online answer auto-resumes that endpoint (`ev: 'endpoint_auto_resume'`). An
   endpoint an operator paused is never auto-resumed.
5. The T-134 busy streak (`BUSY_MAX_STREAK`) STILL pauses the lane. That is a decision, not an oversight: a busy
   rejection means the slot is taken, and the busy streak crossing is itself a ceiling.
6. New perf events: `endpoint_auto_pause` (with `endpoints_left`), `endpoint_auto_resume` (probe-resume, or `by:
   'resume_fn'`). `auto_pause` keeps its meaning (the lane) and gained `endpoints_braked` / `endpoints_left`.

## Node units and the false-healthy wedge (T-254, 2026-10-08) — do not re-derive

1. **What the units were set to, and why it matters here** (read 2026-10-08; unit state is read on the node with
   `systemctl show`, not from this file). The active CPU engine units are `Type=simple`, `Restart=on-failure`,
   `TimeoutStopUSec=1min 30s`, `KillMode=control-group`. That shape is the whole problem: an engine that exits
   `Result=success` / `ExecMainStatus=0` after losing its GPU context is **not** restarted by `Restart=on-failure`, and
   a `WatchdogSec` on a `Type=simple` service that never calls `sd_notify` would kill healthy engines. So the brake is
   plugin-side (T-246), not unit-side. The drop-in file names and the per-unit values this line listed are this
   machine's configuration and stand in `audio-play-cordis/FACTS.md`.
2. **A lost GPU context does not make `audiocpp_server` fail in a way systemd can see.** On gpu1 it logged
   `radv/amdgpu: The CS has been cancelled because the context is lost` five times in ~11 h (Oct 07 16:00:00, 16:03:30;
   Oct 08 00:53:33, 00:59:40, 03:12:12) with `NRestarts=0` the whole time. One of those processes never exited (the unit's
   current main pid started 6.9 h later, by hand). When the engine does exit after one, it exits `Result=success` /
   `ExecMainStatus=0`, which `Restart=on-failure` does not restart. A bare `WatchdogSec` on a `Type=simple` engine with no
   `sd_notify` would kill healthy engines, so the answer is plugin-side (T-246), not unit-side.
3. `systemctl show -p MemoryPeak` is a **cgroup peak including mmap'd model pages** on these units (cpu1 cpu 59.2 GiB,
   cpu2 cpu 43.9 GiB peak vs 0.6 GB current RSS). It is not a leak meter. `/sys/class/drm/card*/device/mem/vram_used_mb`
   does not exist on gpu1 — **but `card2/device/mem_info_vram_used` / `mem_info_vram_total` / `mem_info_gtt_used` /
   `mem_info_gtt_total` do (measured 2026-10-08)**, so VRAM release after a stop IS verifiable there without any tool.
4. **How this host reaches the nodes is a property of this machine, not of the plugin**, so it is not carried here: the
   working SSH forms, which bare hostnames have no `known_hosts` entry, and where the privileged form needs no prompt, stand in
   the workspace realm (that older record and `LOCALHOSTS.md`), not in this file. What generalises: a node that does not answer is reported, never worked around by
   running the work locally.

## GST-1 mix verb (T-256, 2026-10-08) — do not re-derive

1. `POST mix_audio {bed_job_id, stem_id?, layers:[job_id|path], options:{bed_gain, layer_gain, delay_ms, rate}}` mixes
   rendered rows onto a bed with ONE local ffmpeg pass: no engine, no endpoint, no queue slot, no runner, no new row. The
   result is a NEW STEM on the bed row (`mix-ap-NNNN`), served by the existing `?stem=<id>` route and persisted with the row.
2. For a separation row the MAIN output is the FIRST stem (vocals). The bed is therefore chosen by STEM NAME
   (`back|bg|no_vocals|instrumental|accompan|music|sfx|bed|atmos`) or by an explicit `stem_id`; an ambiguous multi-stem bed
   is refused with its stem list, never guessed.
3. `delay_ms > 0` delays the layers, `delay_ms < 0` delays the BED (ffmpeg adelay cannot move audio earlier); the answer
   carries `delay_applied_to`. `rate` is atempo on the layers only. `amix=...:duration=longest:normalize=0` keeps levels.
4. **This host's ffmpeg is 7.1.5 and `adelay` has only `delays` + the boolean `all` — there is NO `all_delay` option**
   (`adelay=<ms>:all=1`). amix mixes 44.1 kHz stereo with 24 kHz mono happily. Any ffmpeg verb gets one real-file run:
   a command-string assertion alone let a rejected option through on the first attempt.
5. A failed ffmpeg adds NO stem to the row. Layer rules: a row must be `status:ok` with an output, a path must be under
   the plugin's store root (`<home>/.dsh/deepamp-audio` by default since 2026-11-07), at most 12 layers.

## gpu1 GPU fit and storage types (probe 2026-10-08) — do not re-derive

1. **VRAM readout exists**: `/sys/class/drm/card2/device/mem_info_vram_used` = 13.6 MB idle of
   `mem_info_vram_total` = 8 573 157 376 B (8.0 GiB); `mem_info_gtt_total` = 25 501 368 320 B (23.75 GiB aperture)
   over a 6 GiB-RAM box. The plugin does NOT need this and must not ssh for it — the agent reads it out-of-band.
2. **Storage type, not size, was the failure axis at small models.** q8_0 works on the Vulkan lane:
   citrinet_asr 41 MB rendered ok, htdemucs_q8 allocated +450 MB, bs_roformer_q8 allocated +1 809 MB (2 315 MB total).
   `moss_tts_nano` **bf16** 332 MB -> `vk::Queue::submit: ErrorDeviceLost`. `mel_band_roformer` **f16** 457 MB -> same.
3. **A lost Vulkan context is sticky.** After it, `voxcpm1` **q8_0** also failed with `ErrorDeviceLost`. The engine
   process never exited (`audio-cpp-vk NRestarts=0`, same main PID since 07:07, `ExecMainStatus=0`), `/health` still
   answered `{"status":"ok","backend":"vulkan","models":45}`, sysfs VRAM returned to 13.6 MB idle and every model read
   `loaded:false`. That is the false-healthy wedge: only a hand restart of the engine recovers it.
4. **The plugin knows the quant but never gates on it.** `quantOf()` reads it from the engine's `/v1/models` path and
   every row carries `quant` + `model_path`; the code comment says it is provenance, never a switch. The plugin does
   not know an endpoint's backend at all (the string `backend` appears in lib only in a comment about `/health`'s shape),
   so nothing today refuses a bf16/f16 build on the GPU lane.
5. Toolchain reason (measured 2026-10-06): Mesa 25.0.7 `glslc` on gpu1 lacks `GL_EXT_bfloat16`. gpu1 has 6 bf16
   builds, ~8 f16, 1 f32, the rest q8_0/q4_k. Not yet measured: whether f16 fails for all f16 models, and what size
   actually exceeds 8 GiB (the probe stopped at 848 MB because the device was already lost).
6. Live brake behaviour seen during the probe: `ev:auto_pause ... wedge_streak:3 endpoints_braked:"primary"
   endpoints_left:2` — the failing endpoint was braked, cpu2 and cpu1 stayed open, and the lane paused only on the
   3-failure ceiling. The parked row carried `lane_wait {paused_by:"auto_pause", reason:...}`. Open question: two of the
   three failures were **engine 400s from bad input** (`prepare() sample rate mismatch: expected 44100, got 24000`) and
   they still advanced `wedgeStreak`; only plugin-side capability rejections are excluded today.
7. Separation models want **44 100 Hz** input: feeding a 24 kHz render to `htdemucs_q8` / `bs_roformer` yields
   `prepare() sample rate mismatch` after the model has already been loaded onto the GPU.

## The panel's cost in a real browser, and whether it leaks (WM-17, T-736, measured 2026-11-06) — do not re-measure this from zero

Raw data: `scratch/wm17_round1..4_20261106.mjs` and their `.jsonl` (four runs against the live harness, headless
Chromium 153 driven through `playwright-core` 1.63, real take `ap-1000`, CDP `Performance.getMetrics` plus
`HeapProfiler.collectGarbage`, RSS from a `ps` process-tree walk). Card: `CHANGELOG.md` T-736. These are dated
measurements of one page on one machine, not a specification of the panel.

1. **No leak signature.** Twelve play-stop-settle rounds in one page: `JSEventListeners` reads **1020 after every
   round, twelve times out of twelve**; page nodes climb 7 a round through round 5 (7 324 → 7 352), one last step of 2, and then sit at 7 354 for the remaining seven samples; JS heap after a forced GC is +883 kB over the whole phase, front-loaded (+339, +160, +126 kB) and then
   noise inside a ±100 kB band; `<audio>` elements stay 3 and `Documents` stay 2 throughout. The shape is a warm-up
   reaching a level, not a per-take accumulation. The thing WM-17 exists to look for — a heap or listener count that
   does not come back down — is not present in this run.
2. **What the strip costs when it really draws.** Spectrum mode, on the strip's own 200×80 canvas: **237-239
   `fillRect` per painted frame at 57.8-58.8 painted frames a second, 13 760-13 969 `fillRect` a second**, reproduced
   across four independent 20 s windows, the whole spread inside 1.5 %. The clock face at rest: 285 rectangles per drawing, one
   drawing a second. The clock face **while a take plays**: 566 a second — the same 285-rectangle drawing issued
   about twice a second by the panel's wake path.
3. **The fps control works in a real browser, and this is what it moves.** Setting 60 / 30 / 20 / 12:
   58.2 / 29.4 / 19.8 / 12.0 painted frames a second, 13 784 / 6 977 / 4 708 / 2 864 `fillRect` a second, cost per
   painted frame unchanged at 237-239, and `requestAnimationFrame` still asked for 58-59 times a second at every
   setting — the control stops paintings, it does not slow the loop. Drawing work saved 0 / 49 / 66 / 79 %, while the
   page's total task time over the same window only moved to 1.00 / 0.99 / 0.90 / 0.86 of the 60 case. Drawing is not
   where this page's time goes: about 1 350 layout passes and 0.7 s of layout time per 20 s window are present with
   the visualizer **off** as well.
4. **Where the control is, for anyone scripting the panel.** The fps `select` is inside the Collapsible titled
   "Settings" (`lib/client.js:24876`, the select at `:24935`) and is **not in the DOM until that section is
   opened** — a script that looks for a section head saying "visualizer" never finds it. The strip is the span
   `.audio-play-scope` inside the row `.audio-play-scope-row`; a contains-match on that class prefix lands on the
   row, and clicking the row does nothing to a mode the span owns. The panel's own resolver is
   `root389.querySelector(".audio-play-scope")` at `:18827`. Read the mode from `localStorage['deepamp:scope.mode']`,
   not from a hover: at mount those keys are absent, because the panel writes a setting only when someone touches it.
5. **The mock instrument T-735 built is a faithful proxy for draw calls.** Mock spectrum 252 canvas operations per
   frame against the real 237-239; mock `clock_led` 281 operations a second against the real 285 per drawing at one
   drawing a second — within 6 % and 2 %. Where the mock table understates is where its rows deliberately stopped:
   its clock rows were mounted with nothing playing, so they describe a clock at rest, and a real panel repaints the
   clock about twice a second during playback.
6. **Limits of these numbers, stated so they are not over-read.** The page measured is the whole harness UI with the
   panel mounted in it, not the panel alone. Headless, no real display, no GPU compositor, one browser, one machine.
   Process RSS 632-634 MB over 7 browser processes at the start of a run and 707 MB over 8 after minutes of work,
   while the renderer process itself held 94 MB and ended at 96 MB — the growth is a new browser process appearing,
   not the renderer growing. `Memory.getDOMCountersForSnapshot`, the CDP method the WM-17 plan named, does not exist
   in this Chromium build; `Performance.getMetrics` carries Documents / Nodes / JSEventListeners instead. One run is
   never proof; four runs of the same task in one page is a shape, and the shape here says no per-take leak.

## The Nixie faces' power fluctuation and strike, and the order the clock cycle walks (T-729 / T-737 read 2026-11-06; the strike added T-751, measured 2026-11-07) — do not re-derive

Code: `lib/client.js` (the breath at `nixieBreath690` :21025, its constants :21017-21024; the strike constants
:21353-21366, `nixieSeedRand691` :21377, `nixieStrike691` :21390, `nixieStrikeEvent691` :21409, their composition in
`scopeNixieFace684` :21632-21650 and its digit-change detection at :21633; the application of the breath at
`scopeNixieFace684` :21162; the cycle's order in `CLOCK_MODES681` :478). Cards: `CHANGELOG.md` T-737, T-751. The suite
measures both every run — `tests/scope.test.cjs` prints its own `MEASURE T-729 nixie breath` and `MEASURE T-751 nixie
strike` lines, and the breath line now prints the four tube values per moment as well.

1. **Yes, the tube dims and recovers, and none of it is random.** A struck digit's lit wire, its pale core and all
   three halo passes are drawn at a strength that moves on a slow curve: middle 0.915, swing ±0.055, two periods of
   9.3 s and 13.7 s mixed 0.62/0.38, clamped to 0.72..0.97 — a tube is never drawn at full strength. On top of the
   curve, one 4-second interval in seven carries a dip of up to 0.16 with a sine in and out. The interval is picked
   by a bijection on the wall-clock bucket, not by `Math.random()`: irregular to look at, reproducible to measure.
   The only `Math.random()` in the client (2 calls) is the waterfall's random hue scheme, nothing on a clock face.
2. **It is one tube breathing, not several digits flickering.** One breath factor per frame is shared by every struck
   digit in that frame, and the suite asserts exactly that — **with one exception added by T-751: on a frame where a tube
   has just changed digit, that tube carries the breath it rides multiplied by its own strike, so it is deliberately NOT
   the same value as its neighbours.** The same-factor assertion is unchanged and is measured on a frame with no strike;
   the strike's bounds are measured on the curve. The dimming is carried as alpha inside the `#RRGGBBAA` ink
   (`nixieInk690` :21047) — no `globalAlpha`, no gradient, no `shadowBlur`. The glass envelopes, the mesh, the foot
   ring and the ghost stack behind the struck digit keep the palette's unchanged ink: the ruling put the fluctuation
   on the struck digit only. A per-ink factor per pass would read as three things flickering instead of one tube.
3. **Both tube faces, and only the tube faces.** The amber and the neon green palette share the same drawing path,
   so the green tube breathes with the same numbers. The LED dot matrix and both split-flap boards have no such
   effect. Measured shape from the suite's own run of 2026-11-06 21:5x Berlin: six sampled moments out of 255 read
   235 226 232 246 237 220, band 184..247, halo ladder 0.219 / 0.442 / 0.661 — the band is the ruled 0.72..0.97 in
   0-255 terms, and the moments move, which is the point of the measurement. **Re-measured 2026-11-07 after T-751, now
   printing the four tube values per moment: clean_frames 6 of 6, values 236 247 233 221 232 241, swing 26, band 184..247,
   same halo ladder.** The band and the ladder did not move; what moved is what the measurement can see, and the printing
   of the per-tube values is what found the mid-strike frames described in item 2.
4. **The cycle's order is one list, and it is now the operator's order.** `CLOCK_MODES681` carries the walk: a press
   on the canvas (`:22427`) or on the clock row's own box (`:25202`) steps to the next entry and wraps at the end,
   and the box's hover prints the names in that same order. Ruled 2026-11-06 by the operator, verbatim: "order of
   clocks should be \"nixie orange -> nixie green\" while cycling". The walk is `clock_led → clock_nixie →
   clock_nixie_green → clock_flap → clock_flap_light → clock_led`. Five faces, one direction, the same wrap, the
   same default face (`clock_led`); the two palettes of one drawing are adjacent, as the two boards already were.
5. **A struck digit gets a strike, and a strike is a digit change, not a timer (T-751).** The operator's ruling, verbatim:
   "i have not witnessed any flickers, it should show as a dimming effect that might have a strong spike on any change on
   the digit... like the new letter shows up with 120% brigness, drops fast to 30, then dimms back up to 100% brightness -
   maybe with a random to affect multiple but not all of the tubes at once". Four facts follow from that build and none of
   them are re-derivable from the code in one reading. **(a) The event is a change of the digit in that position** —
   `lib/client.js:21633` compares the face's own `cur` state against the digits it is about to draw, and a face is seeded
   with its current digits at `:21574`, so a page load or a first frame strikes nothing. **(b) The ruled shape is PEAK
   1.20 / TROUGH 0.30 / FALL 110 ms / RISE 1400 ms / JITTER 0.30** (:21353-21366), measured on the client's own extracted
   functions: peak 1.2000 at age 0 on all 24 seeds the four tubes and four event buckets produce, trough 0.3000 at 145 ms,
   back to exactly 1.0 by 1060-1955 ms and flat from there, nothing outside the band at any age from 0 to 5000 ms. **(c)
   The 120% is carried by the halo's width, not by an alpha** — the struck ink is `breath × min(1, strike)` (:21645) and
   the part above 1 goes to `NIXIE_STRIKE_WIDEN691` (:21648), so the deepest struck ink the face can reach is
   `floor(184 × 0.30) = 55` of 255, the band's floor times the trough, not 30% of white. **(d) The random half is capped
   at three tubes**: a stray strike is picked per 7 000 ms interval at 0.18 odds over a seed that carries the tube index
   and the event bucket, and the census over 4 000 intervals reads nothing 3 257 / one 246 / two 257 / three 240 / **four
   0**. Two defects were found only because the curve was measured rather than looked at: a seed fold that exceeded 2^53,
   and a multiplicative hash whose high bits cycled with period about 5 over an arithmetic seed sequence (per-tube counts
   3247 / 336 / 0 instead of a spread). A transient that lives about one and a half seconds cannot be asserted from six
   frames two and a half seconds apart; it is asserted as a function of age.

## A mark that rolls on the strip: the fit rule, the merge trap, the colour path, the level words, and what each mode costs (T-746 measured 2026-11-07; the whale, the colours and the level words added the same day by T-749, T-748 and T-750) — do not re-derive

Code: `lib/client.js` (`SCOPE_QWEN_MASK746` :923 and its constants :931-:934; `SCOPE_WHALE_MASK749` :973 and its
constants :980-:983; the mark vocabulary `SCOPE_MARK_SCHEME_OPTS748` :1036 and the per-mode defaults :1063; the level
vocabularies `SCOPE_LEVEL_OPTS346` :1482; the shared mark draw path :22380-22427 with its colour decision at
:22400-:22401 and its rail at :22364-:22366; the mode's liveness gates and the whole-canvas gate `scopeFullCanvas541`
:531-:539). Cards: `CHANGELOG.md` T-746, T-748, T-749, T-750. The measurements live in `tests/scope.test.cjs` as pins and
as the `MEASURE T-746`, `MEASURE T-748` and `MEASURE T-735 mode …` lines. Line numbers are as of 2026-11-07.

1. **The fit rule for a rolling body, and it is a hard one.** A non-circular body of half-axes `a` × `b` rolling on a
   line needs `2(a|sinθ| + b|cosθ|)` ≤ the drawable height at every angle. On the visualizer canvas (200 × 80 with the
   2 px edge inset, so a 196 × 76 inner box) a 2 px cell map is therefore capped at **26 × 27 cells = 52 × 54 px**, which
   needs 75.0 of the 76 available. The llama's 30 × 34 map (60 × 68 px) would need 90 px and cannot roll in this box.
   **This is a property of the strip, not a style choice**, and any mark meant to roll — the whale on WM-34, a user-supplied
   icon — has to be traced inside that budget or it will be clipped at some angle.
2. **The centre rides the support height, and that is the whole difference between rolling and spinning.** `θ = distance /
   half-height`, and the centre sits at `ground − (halfW|sinθ| + halfH|cosθ|)`. A body that is not a circle does not roll
   with its centre at a fixed height. Measured on the panel: the drawn height takes five distinct values across a 40-frame
   run (48, 50, 52, 54, 56 px) and the mark's lowest cell reaches the ground line. A mark whose centre stays put is a
   sticker that spins.
3. **The merge trap, in the house form.** Lit runs along a canvas row must be merged with a **separate open flag**; the
   run's start index is not a usable sentinel, because a run beginning left of the mark's centre has a negative index and
   a `run = -1` test reads it as "no run open". The defect painted 169 of 333 lit cells and 28 of 52 px of width, always
   the left half, while the geometry, the mask and the clip bounds were all correct. The drawings were never wrong — the
   counter that decided whether a run existed was.
4. **What the mode costs.** The rolling qwen mark is **6 435 canvas operations per 1 000 ms at 60 fps** — about 46 mark
   rects and 59 rail rects a frame. The 5 403 first read was the half-mark's cost and is superseded. The comparison table
   across the marks and the whale is item 10 below; read that one, not this line, when a second mark is in the question.
5. **A new visualizer mode is not one list entry.** Three gates decide whether a mode is ever drawn: the animation-loop
   liveness gate, the entry arm, and the flowing arm. A mode word added to `SCOPE_MODES300` but not to those three opens,
   reports "drew nothing", and looks broken rather than unwired. It also moves positional pins in `tests/scope.test.cjs` —
   a ring walk, two Settings counts, two press-count setups, one source-body window — and one pin that had been passing
   without matching since T-681 surfaced while this was being re-cut. Plan for six re-cuts, not one.
6. **How to check a drawing mode in a real browser without inventing a fixture.** Element-screenshot the canvas and read
   its pixels with `getImageData`: count the white cells, take their bounding box, and count the pixels that are neither
   the ground nor the mark. On the live panel today that read gave 331 cells, a box inside the inner box, and
   `other_pixels: 0` — which is a stronger statement than a screenshot and needs no new audio, no dispatch, and no model.
   The script is `scratch/qwen_roll_shot_20261107_T746.mjs`, on the WM-17 pattern.
7. **The whale is the fit rule answered, not a second drawing.** `SCOPE_WHALE_MASK749` :973 is 22 rows of 30-bit hex —
   30 × 22 cells at 2 px, **334 lit cells** — traced offline from the deepseek logo's own path data by
   `scratch/trace_whale_749.py` (a standard-library nonzero-winding polygon fill; this host has no SVG rasteriser), the
   chosen map being `scratch/whale_cellmap_749.json`. Its turned diagonal measures **73.54 px against the 76 px inner
   height**, 2.46 px of spare travel, where the qwen mark's 26 × 27 needs 74.96 and the llama's 60 × 68 needs 90. It is
   drawn **rotated 180°** (body right, fluke lower-left, facing its direction of travel) — the orientation the operator
   asked for, and the only one of the two candidates that rolls the way a rolling mark should; the comparison is in
   `scratch/whale_preview_749_rot180.png` and `…_mirrored.png`. A mask row 0 is the top of the mark and bit `cols-1-cc`
   is its leftmost cell, verified at theta = 0 against the qwen mask.
8. **A mark's colour comes from the engine the panel already had, and writing a new one was the mistake to avoid.**
   `scopeDynColour587(hue, frac)` paints `hsl(h, 62+26f%, 16+46f%)`, `scopeRampColour541(stops, frac)` samples a stored
   scheme, and `scopeDynPick587` / `scopeDynRef587` hand out the dynamic reference — all of them mode-agnostic and shared
   by the llama, the waterfall and both marks. The only new thing is `SCOPE_MARK_SCHEME_OPTS748` :1036, the eleven words
   (`white, green, flames, ironbow, cold, auto1, auto2, rand, rand2, drift, beat_ring`) carried into both marks' rows at
   :1056-:1057; `auto3` is not offered to a mark because it is the llama's own multi-stop drift. Both marks default to
   `white` (:1063). Measured with the scheme set to `flames` and every bin hot so the band reads one value:
   **rgb(122,31,10) at 60/255, rgb(158,55,7) at 140/255, rgb(255,160,0) at 255/255** — three distinct colours, 0 white
   frames, 0 rail-coloured frames. Two facts about the fixture that made this measurable: the mock analyser reads
   `hotBinValue` **only when `hotBins` is also set**, and it defaults to bins 0..39 at value 200 otherwise, so a partial
   hot list gives a partial answer and looks like a colour defect in the client when it is a defect in the fixture.
9. **No mode on this panel offers the `log` level word any more** (`grep -c 'words: \[[^]]*"log"' lib/client.js` answers
   0), and every mark, the spectrum and the waterfall are pinned to `dB` (`SCOPE_LEVEL_OPTS346` :1482). `oscilloscope`
   still offers `gain | raw`, `static` `amp | dB`, `vu_led` and `vu_needle` `peak | rms` — those are choices between two
   measurements, not the level scale the operator's ruling removed. `scopeBarLogFrac539` is unchanged and now unreachable
   from the panel; a browser key still holding `log` is refused by the level gate and the mode answers its pinned word. A
   vocabulary with one word renders an **empty table cell**, not a printed word nothing can change. The curve was measured
   before it was removed (`scratch/logcurve_750.cjs`): 0 at a silent byte, 1 at 0 dBFS, monotonic across the window, a
   log/dB ratio of 3.8910 at byte 146 against the theoretical 3.9087, 146 of 146 samples below that point drawing higher
   on log than on dB, and 0.1088 against 0.5714 at the top of the window.
10. **What each mark costs, on the same fixture and the same 1 000 ms of panel time.** `qwen` 6 435 operations (107.25 per
    offered frame), `whale` **6 978** (116.3 per offered frame, 15 ms of node time), `llama` 25 260 (421 per frame),
    `knight` 2 520, `waterfall` 11 880. The whale is 8 % over the qwen mark — which is what 334 lit cells against 333
    costs — and about a quarter of the llama. Both marks drew 60 of 60 offered frames at the default 60 fps.

## What a STOP leaves behind, and what a play press means afterwards (T-747, measured 2026-11-07) — do not re-derive

Code: `lib/client.js` (`lastStationRef747` :12171 with its two helpers :12172-:12173; written at the station starts
:12322 and :12354; cleared at :12303, :12311, :12408, :14660, :12623-:12624; read in `playWalked` :18401-:18412;
`stopStream395` :12238, `playbackIsHeld299` :18518, `resumePresented627` :18600, `controlEl395` :19782, the gate
`streamUrlCheck390` :1683). Card: `CHANGELOG.md` T-747. Line numbers are as of 2026-11-07.

1. **A station stopped by a press keeps nothing on its media element, and no reading rule can be made to answer for
   it.** `stopStream395()` pauses, `removeAttribute("src")`, `load()`. `playbackIsHeld299(a)` is false for an element
   the panel marked stopped (`playStopped307.current === true`), false for `a.ended === true`, and false for a fresh
   element with no src. `resumePresented627()` only ever answers for a HELD element, and `controlEl395()` names the
   station only while one is playing. So the resume door a play press asks first is closed, and any behaviour that has
   to survive a stop has to be remembered by the panel itself — that is what T-747 added, and why.
2. **"the browser would not start playback again - press play once more (a press is a fresh gesture)" is a RESUME-path
   message only.** Two sites: `:18504` (inside `togglePlaybackPause299`) and `:18573` (inside `resumeHeldPlayback627`),
   each the rejection of a `play()` on an element the panel was resuming. It cannot come from a station start, and it
   cannot come after a stop, because after a stop no resume is attempted. Asked on 2026-11-07 whether a reported
   play-after-stop bug was this message: it was not, and the real-browser run (item 5) is what settled it.
3. **The memory is written at the START, not at the stop, and it is dropped by anything that becomes the last thing
   played.** Written at both station starts (the T-401 plain retry and the normal one), carrying the url, the same
   `streamLabel395(label, host395)` label the station was named with, and the row id if it has one. Dropped by: a take
   through `startPlayback` (the one door every take walks through), a station that reached its own end, a station the
   plugin failed to fetch twice, a crossfade in "stop the stream" mode, and the link being forgotten (matched by row id
   **or** url — a link played from the import field carries no row id). A manual stop is the one case it survives.
4. **Two gates on the restart, and both are load-bearing.** It runs only when the panel is not presenting a station
   right now — written without that condition it broke 16 `stream_overlap` checks, because pressing play over a live
   station restarted the station instead of playing the row. And the url is passed back through `streamUrlCheck390`, so
   a Stream-input change made between the stop and the press is honoured by that setting's own refusal sentence instead
   of the press falling through to a playlist row.
5. **A press is a user activation, and that is measurable.** In a real headless Chromium with the **default** autoplay
   policy (no `--autoplay-policy` flag) and Playwright's trusted clicks: station playing (`paused:false`,
   `currentTime 2.34`, `readyState 4`) → transport STOP (`paused:true`, `currentTime 0`, `readyState 0`) → transport
   PLAY: the same link playing again (`paused:false`, `currentTime 2.39`, `readyState 3`), the take element empty the
   whole time, `navigator.userActivation.hasBeenActive` and `.isActive` both `true`, no page errors. A restart started
   from inside a click handler is the best case the autoplay policy has; a programmatic `element.click()` from
   `page.evaluate` is NOT a user activation and would not test this. Script:
   `scratch/last_station_shot_20261107_T747.mjs`, pictures `scratch/shots_20261107_T747_last_station/`.
6. **Two fixture facts, both learned the slow way today.** (a) The Stream-input select is rendered in the **Settings**
   section and nowhere else in the live panel; the client suites reach it without opening Settings because the harness
   mounts with every section open — a live-browser script has to open Settings first. (b) The panel's message row is
   read in a mock by its inline `style.background` (`#16203a` / `#3a1620`); in a real browser that selector finds
   nothing, because the browser serialises the shorthand differently — read the message off the screenshot or the mock,
   not off a live `style` lookup. The station fixtures to copy are `tests/pause_resume.test.cjs` (sections C, D and D2:
   `scenario()`, `importStream()`, `pressStop()`, `snap()`, `resumedEl()` / `freshEl()`, `m.toast()`) and
   `tests/stream_overlap.test.cjs` (the three overlap modes; `m.seen.hosts` is three media elements: take, station,
   crossfade tail).

## Generation cost per second of audio, per model (measured 2026-11-10 from the plugin's own rows) — do not re-derive

Answered `../TODOS.md` WM-41 item 5 ("analyse, then either do or drop"). The analysis was run on the plugin's own
state file, not on a new dispatch: `<home>/.dsh/deepamp-audio/state.json`, 200 rows, 182 `ok`, **140 of them
carrying both `elapsed_gen` and `duration`** — the two keys the ratio needs. Ratio = `elapsed_gen_s ÷ duration_s`,
median per model, minimum and maximum beside it because a median alone hides the spread.

1. **The ratio is stable per model, and it spans three orders of magnitude.** Rows ≥ 3 only.

   | lane | model | rows | median s-of-engine-wall per s-of-audio | min | max |
   |---|---|---|---|---|---|
   | stt | citrinet_asr | 41 | 0.06 | 0.04 | 0.50 |
   | stt | nemotron_3_diar | 3 | 0.11 | 0.11 | 0.20 |
   | stt | nemotron_asr | 27 | 0.30 | 0.28 | 0.37 |
   | tts | pocket_tts_en_q8 | 4 | 0.68 | 0.55 | 0.84 |
   | stt | moss_transcribe_diarize_q8_0 | 12 | 1.27 | 1.14 | 1.52 |
   | stt | qwen3_asr | 3 | 1.50 | 1.47 | 1.64 |
   | tts | stable_audio_medium | 6 | 4.69 | 4.54 | 4.85 |
   | tts | qwen3-tts | 4 | 6.26 | 4.79 | 8.61 |
   | tts | cosyvoice3 | 4 | 20.08 | 15.98 | 27.17 |

2. **What the number is, and what it is not.** It is the engine's wall time for the generation leg of a row that has
   already run. The load leg is a separate key on the same row — `elapsed_load` — and it is not in this ratio:
   `ap-1327` is the example, `elapsed_gen 6104 ms` beside `elapsed_load 4742 ms`, so the wall a person waits on is
   not the number in the table. It is not a pre-flight promise either: it says what a model did, on the machine it
   was placed on, with the model already loaded.
3. **`cost_per_second` is not this measurement.** The field exists on a row and in `dispatch_batch` as a
   **caller-declared** planning input (its comment is explicit: "A caller that knows its lane may declare the rate
   with `cost_per_second` on dispatch_batch", and a declared value outranks a measurement). Across those 140 rows it
   is `0` on every one — nobody has ever declared it. Naming this field after the measurement would be a lie about
   where the number came from.
4. **The estimate the plugin already has is elsewhere and it works.** The batch path estimates before it dispatches:
   `expected_seconds`, `chars_per_sec`, `est_drift`, `over_run`, `ratio_band`, with the floor
   `BATCH_BEST_SEC_PER_SEC = 20` on a caller-declared cost. That is a per-part pre-flight estimate built from the
   text, which is the only length that exists before a take is rendered.
5. **Why item 5 was dropped, in one line.** A pre-flight warn would multiply this ratio by the seconds of audio a job
   will produce, and for a text take that length does not exist before the row does — it is what the engine is being
   asked to make. Where the input length *is* known in advance (a transcription of a file, a batch part), the plugin
   already reads the file's duration or already estimates the part, and `queue_status` already says what is queued
   ahead of the row. The honest half of this item was the measurement above, and it is here now.

## The rate a take budget joins on, and how much of the lane that table actually covers (T-804, measured 2026-11-12) — do not re-derive

1. **What was measured, and how.** `lib/index.js` keeps a per-family table of seconds-of-engine-wall per
   second-of-audio (`RATE_MEASURED648`, fitted 2026-10-27 from 435 joined renders) and the take budget looks the
   chosen model up in it. The probe joined the table's keys against the plugin's own `perf_log.jsonl` (25 442 lines,
   all parsed) — script `scratch/review_20261112_rate_join_measure.cjs`, output
   `scratch/code_review_20261112/measure_rate_join_20261112.txt`. Restricted to the events that size a take
   (`render`, `synth`): **922 records hit a row, 606 did not**, so at that moment about 40% of the take-sizing
   decisions in this lane were being made at the lane median 6.11 s per s rather than at a measured rate. Across all
   model-bearing records in the log the split is 3 183 hit / 4 346 missed, over 69 distinct model strings against a
   table of 14 keys.
2. **The misses were not random.** Most were quant variants of families the table does have rows for — a `_bf16`,
   `_f16`, `_q4_k`, `_q8_0` or `_2` suffix on a name the lane had already timed. The worst direction was the one the
   table's own comment had already named: a slow family read at the lane median, which pays for 589 s of audio where
   its own row would pay for 92 s, so the over-budget warning fires far less often than it should.
3. **What T-804 changed.** The lookup is measured-first, inherited-second, lane-median-last. An exact row still
   wins; the longest matching key wins over a shorter one, so a suffixed id takes the nearer row; a variant of a
   family the table has a row for inherits that family's row through the same normalised-prefix rule the capability
   bar uses (`capNorm` and `rateFamilyOf648`, one normalisation definition). Measured against the ids this lane
   actually renders with, that recovers `moss_ttsd_bf16`, `moss_ttsd_q4_k`, `moss_ttsd_q8_0`, `kitten_tts2`,
   `qwen3-tts-bf16`, `omnivoice_f16`, `voxcpm2_6s`, `breeze_tts_2`, `kokoro-tts-en`.
4. **What was deliberately NOT done, and why (the operator's ruling).** A family the table has no row for is never
   borrowed from a variant of it: `chatterbox` does not take `chatterbox_turbo`'s 3.28 and `pocket_tts_en_bf16` does
   not take `pocket_tts_en_q8`'s 1.06. That step would assign a model a number this lane never timed for that model,
   and for `chatterbox` specifically the variant it would borrow from is the fast one. The families left unmeasured
   are recorded, not guessed: `chatterbox`, `pocket_tts_en_bf16`, `cosyvoice3`, `qwen3-voicedesign`,
   `moss_tts_nano`, `moss_tts_local`, `glm_tts`, `fish_audio`, `dramabox`, `index_tts2`, `kugelaudio`, `higgs_tts`,
   `lfm2_audio`, `fireredtts3`, `vibevoice_7b`, `vibevoice_15b`, `qwen3-customvoice`.
5. **The words the answer carries now, because a fallback is not a measurement.** `rate_source` is one of
   `measured:<id>@<date>` (this exact id was timed), `measured:family:<family>@<date>` (inherited from the family's
   row), `lane_median@<date>/<n> renders` (the lane median, nothing more), or `declared` (a caller's own
   `cost_per_second`, which still outranks all three). The last of these is unchanged. The lane-median answer used to
   be labelled `measured:lane@…`, which is the sentence this card exists to stop.
6. **What the table is, and what it is not.** It is 14 dated rows from 2026-10-27 and it needs a re-fit after the
   CPU engines restart — that instruction is in the code comment above it, and it is still true. Coverage is a
   measurement problem, not a rule problem: the only way to move the families in item 4 off the lane median is to
   render them and time them. `scripts/model_matrix.py` is the runner for that, and it is dry-run by default.

## Where an audio.cpp engine runs: local or remote is the setup's choice (operator correction 2026-11-11) — do not re-derive

1. **The operator's word, verbatim:** "audio.cpp is not only remote - also local audio.cpp - depends on user setup".
   Any sentence in this package that states "the engines are remote" as a property of the plugin is wrong; a setup may
   run an audio.cpp on the same machine as the harness, and this plugin cannot tell the difference and does not care.
2. **What the code actually assumes.** The host half reaches an endpoint through the registry, over HTTP, and the only
   thing it assumes about it is that the URL answers: `endpoint_add` takes a URL, `endpoint_health` probes it,
   `endpoint_models` reads its catalog, and a dispatch is refused for a model that catalog does not list. There is no
   remote-only branch in `lib/index.js`. What it does assume about an engine is `max_loaded_models=1` — one job per
   endpoint — and that a model file is where that engine can read it, which is why "local" means local to the engine,
   not local to this package.
3. **What this package never does:** start an engine, download a model, or install a service. `mix_audio` (one ffmpeg
   pass), media capture (yt-dlp, only when `ytdlp_path` names the binary), the takes trim and the local WAV header
   reads are the only local work it does, and none of it is inference.
4. **Where the operator's own setup is written instead:** the workspace `../../AGENTS.md`, section "Remote audio
   architecture" — which box is kept off the lane and why. That is a preference about one setup, not a property of the
   plugin, and what is in play today is read with `GET endpoint_registry?fn=tts|stt`.

## What a fresh install of this package actually gets (T-828 / T-829, measured 2026-11-13) — do not re-derive

1. **No audio, no voices, no samples.** `git ls-files` in this package: 89 files, **zero `.wav`**, and no `voices/` directory in the tree. The voice entity is the plugin store (`<store_root>/voices/` plus the registry inside its `state.json`), which is outside the package and outside git. A new install therefore starts with **0 voices** and every clone mode has to register a sample first. This is a fact about the delivery, not a defect to fix.
2. **The suites still run from a clone.** The two captured engine index pages the host suite reads live inside the tests tree (`tests/fixture/…`, moved there 2026-11-12 by T-816) and the two `docs/` records the suites read (`MODELS_TABLE.md`, `MODEL_PROVENANCE.md`) are tracked. Tracked total measured 2026-11-13: **19.3 MB**, of which `docs/screenshots/v0.1.0/` is 3.9 MB (16 PNGs) and the two fixture pages 3.6 MB. `scratch/`, `artifacts/` and pre-change copies are excluded by `.gitignore`.
3. **The store is created, not required.** At boot the host half runs `mkdir -p` for `tts`, `stt` and `voices` with the write policy rooted at **the parent of the store root**, because on a fresh machine the store root itself is missing. `texts/`, the uploads directory and every save directory are created by `ensureDir` at first use. A missing `state.json` is read as *no state* and the plugin runs on its built-in defaults; the file is written at the first change one of its verbs actually makes. No read path fails on a missing file.
4. **The store root is DERIVED, since 2026-11-13.** Built as `<home>/.dsh/deepamp-audio`, where the home is read through the same environment seam the declared keys use (`HOME`, revalidated as an absolute safe path). The process working directory is the named last resort; if neither resolves the root stays empty and the boot audit fires on that alone. Precedence is unchanged: environment > declared Config > the value the state file carries > this derived default. Before this line the default and the `specs_dir` fallback pair were literals naming one machine's user, and nothing in `cordis.patch.yml` declared either key, so those literals WERE the resolved values.
5. **The boot audit names where the default came from.** `store_dir_default_from` sits beside `store_dir` and `store_dir_default` in the `config_declared` boot record: `home`, `cwd`, or `none`. On this host the derived value is byte-identical to the literal it replaced, because the harness process carries `HOME` set to that home — verified against the running plugin's own `storage_status` answer before and after the change.
6. **The package ships no icon file, by the operator's decision.** `assets/logo-deepseek-whale.svg` and the `./tools/icon` package export were removed 2026-11-13 (the file moved to the workspace trashbin, never deleted). The header mark the panel draws is the inlined path string in `lib/client.js`, which is what it has always drawn. The harness's own documented forms for a plugin icon are a package root's `icon` manifest field or an exported `<specifier>/icon` carrying a **Base64 data URL**; this package supplies neither, and the tool row carries no icon image as a result. That was the choice made, stated so a later session does not "fix" it by re-exporting someone else's artwork.

## Two generator models on one engine carry ONE family record — the measurement that bars a name-based side guess (read 2026-11-14 on the live slot, the fact T-841 was built on) — do not re-derive

1. **The measurement.** On the live tts slot, `stable_audio_medium` and `stable_audio_sfx` are one family record (`stable_audio`) and one task (`gen`); `controlfoley` is its own family, also `gen`. The plugin's own mirror table carries `stable_audio: { cat: 'audio_generation', tasks: 'music sfx edit' }` (`lib/index.js:9373`) — one record that lists music, sfx and edit together, because that is what the engine's record says.
2. **What follows, and it is not a gap to close.** **No engine record names a side.** A capability read cannot tell an effect generator from a music generator, and a name-based guess is barred by this package's own rules (`AGENTS.md` 5.2, 5.3): no document names a model as the model to use, and a capability bar refuses only from known capability. A model id that contains the word `sfx` is not evidence of a side.
3. **The same fact is already load-bearing elsewhere in the host.** The ID3 tag writer refuses a genre frame for a generated take for exactly this reason: "A generated row records task_kind `gen` for BOTH music and effects, and its family record (`stable_audio`: `music sfx edit`) cannot tell them apart. No genre frame rather than a guessed one." (`lib/index.js:11366-11368`, since 2026-10-22.)
4. **What the plugin does have, and what T-841 therefore used.** One side-bearing fact: the folder a person put a preset under. `texts/presets/music/`, `texts/presets/sfx/`, `texts/presets/tts/` name a side; a preset under any other folder carries none and the code says nothing about it. The card is `CHANGELOG.md` T-841, the ruling is `TODOS.md` items 27 and 28, and the operator's words that fixed the design were **"The preset carries the model it was used with"** — a record of what a run did, not a mapping a person maintains.
5. **What is NOT in this fact.** It does not say the two models are equivalent, or that either is better for one side — it says the lane cannot know that from any record it can read. It does not license a per-side model table; the operator chose against one. And it does not apply to a prompt typed into a field: a hand-edited prompt carries no side and records nothing.

## Starting an audio.cpp server on this machine: the two things the engine itself refuses, and where its model root lands (measured 2026-11-14 against the local checkout at `<home>/gits/audio.cpp`) — do not re-derive

1. **`--config` is required unless the native WebUI is asked for.** `app/server/main.cpp:185`: no `--config` and no `--ui` throws `missing required --config argument (or use --ui for the native WebUI)`. This is the engine's own startup path, not a plugin assumption; DEEPAMP never starts an engine (see "Where an audio.cpp engine runs" above).
2. **A server config with an empty `models` array is refused unless UI management is on.** `app/server/config.cpp:324-325` throws `server config requires a non-empty models array unless ui_management is enabled`. Its own test states the rule the same way (`tests/unittests/test_server_config.cpp:612` `test_empty_models_require_ui_management`, `:627` "an empty static server config requires ui_management"). So an engine that is to load models on demand — the shape this plugin's whole design assumes — is started with `ui_management`, not with a static list.
3. **With `ui_management` on, the model root defaults beside the server binary.** `app/server/runtime.cpp:127-135`: the root is `<binary directory>/models`, and `std::filesystem::create_directories` is the non-throwing overload — a path that already exists as a **file** is not an error there, it is simply not a directory.
4. **On this machine that default path is occupied by a 0-byte file.** Measured 2026-11-14: `<home>/gits/audio.cpp/build/bin/models` is a 0-byte regular file (`-rwxr-xr-x`, dated 2026-08-31) sitting exactly where the default root would be created, beside `audiocpp_server`. It was left as it is: nothing in this tree or on that build tree was moved or deleted over it. A later session that starts a local engine with `ui_management` and finds its model root behaving oddly should check this path first rather than re-deriving the cause.
5. **What was actually run, so the boundary is on the record.** The CPU backend was started once on this host with a `--config` and stopped cleanly (`scratch/localhost_engine_stdout_20261114.log`, three lines: the engine's own CPU-backend warning, `audiocpp_server listening on http://127.0.0.1:8964`, `audiocpp_server stopped`). The engine's warning is worth keeping: "audio.cpp is optimized for CUDA. The cpu server backend is intended for portability and testing, but performance and model coverage may be lower than CUDA." A temporary slot for that run was registered and removed again; the registry is read with `endpoint_registry`, and no state from that experiment is carried in this file.

## A preset carries a side and a model pairing, and both are records of what happened (T-841, 2026-11-14) — do not re-derive

1. **Two records, no third source.** (a) A prompt that came from a preset under `texts/presets/<folder>/` carries the side that folder names (`music`, `sfx`, `tts`), read off the path (`presetSideFromPath841`, `lib/index.js:16375`) — the same reading the panel's picker and the T-836 length prefill already make. (b) A run records the pairing: that preset, the model the row actually ran on, and the time (`recordPresetUse841`, `:16403`; one `preset_use` log record per write).
2. **Where it is carried.** A row carries `preset_path` / `preset_name` / `preset_side` (clipped 500 / 120, the side gated to the three folder sides), persisted with the rows in the snapshot and the restore, and handed out by the bounded row view at `:5355-5359` — written only on a row that names a preset. `batch_text_list` reports the pairing back on the very entry that offered the preset: `used_model`, `used_side`, `used_at` (`:15825-15837`, `:15851-15864`), and **only where a record exists** — a preset nobody has run carries none of those keys.
3. **A reference that is not a preset path is refused and the prompt still runs.** `presetRef841` (`:16387`) validates the shape before a row exists: a safe path, none of the shell-ish characters, shaped `…/texts/presets/<folder>/<name>.json`. Anything else is refused as a reference, the refusal is said on the row, and the dispatch goes ahead. That is deliberate: the prompt is the person's work, the reference is metadata about it.
4. **What the panel does with the pairing, and what it says when there is nothing to do.** A pick whose folder names a generator side moves the generator selection to the model its preset was recorded with (`presetModelMove841`, `lib/client.js`), through the same membership and selection every other generator path reads, and the pick's own sentence says either that it moved or why nothing moved: no record yet, or a recorded model the live lists no longer carry (named as stale, nothing moved). A `tts/` preset is not a generator side and moves nothing. A hand-edited prompt sends no reference and records nothing.
5. **Three consequences a later session must not "improve".** The pairing is keyed by preset, not by run, and bounded. The save doors write only the three folders — the panel does not create a folder it has no rule for, and a folder a person made by hand is left alone. And the side reaches the crossfade: a row carrying the `sfx` side is never a side a fade moves, at any length, while the T-838 length floor stays the answer for a row nobody claimed a side for.

## What the engine names a package, and what a pairing recorded from a first run (read 2026-11-14 at `d38518a0`, on the live tts slot and in the plugin's own state) — do not re-derive

1. **The catalog still names no side, at the new commit.** `GET <engine>/v1/models` on the live slot after the update to `d38518a0` (v0.9.4-75) answers 60 models, and the three generator entries carry `id`, `family`, `task`, `path` and nothing else: `stable_audio_medium` → `Stable-Audio-3-Medium-GGUF/stable-audio-3-medium-q8_0.gguf`, `stable_audio_sfx` → `Stable-Audio-3-Small-SFX-GGUF/stable-audio-3-small-sfx-q8_0.gguf`, `controlfoley` → `ControlFoley-GGUF/controlfoley-large-44k-q8_0.gguf`. Both stable_audio ids are `family stable_audio`, `task gen`. **The mapping is not inverted and was not inverted before the update** — the name and the package agree, on the old build and on the new one.
2. **What the engine's own documentation does name is the package's main mode.** `docs/models/stable_audio.md` on that node states the Medium package's main mode as text-to-music, and for the Small SFX package: "Use this package for short sound effects … intended for SFX prompts instead of music prompts", with an 8-second example. So the distinction the earlier fact says the **catalog** cannot make, the upstream **documentation** does make — per package, in prose. That is a new fact, not a licence: a per-side model table is still the operator's ruling to give, and `AGENTS.md` 5.18 is written about records the plugin can read, which this is not.
3. **What was actually wrong was the record, not the engine.** The plugin's state file holds three `preset_uses` entries and **all three name `stable_audio_sfx`**, two of them on presets under `texts/presets/music/`. The cause is in the panel: the quick-music line has no model of its own — `quickMusicModel602()` (`lib/client.js:19257`) returns the generator form's currently selected model — so the first run of a music preset recorded whatever model happened to be selected at that moment, and `presetModelMove841` now replays that recorded model on every later pick of that preset. A wrong first run is a permanent wrong pairing until the record is changed.
4. **The rows say the same thing.** `playlist_list` reads: `ap-1521` and `ap-1524` carry `preset_side: "music"` with presets under `presets/music/` and ran on `stable_audio_sfx` at 180 s; `ap-1522` and `ap-1523` carry `preset_side: "sfx"` with the sfx preset and ran on `stable_audio_sfx` at 5 s — that half is correct. `preset_side` is read off the folder and is right in every row; the model is what the pairing carried wrongly.
5. **The upstream update touched none of this.** The files changed between `44ec8089` and `d38518a0` name no stable_audio model code: the generator-side changes are controlfoley (streaming, duration limits, tests), foley_translator, qwen3_asr diarization and the server UI. Nothing in that range explains or fixes a wrong model choice on a preset pick.
6. **Cleared the same day, at the operator-s ruling "Clear the 3 records + warn on a mismatch" (2026-11-14 17:56 Berlin).** `preset_uses` in the state file is now empty; the three entries named above are gone, and the mechanism that wrote them is unchanged — a run still records the model its row ran on. What was added instead is a warning on the pick: `presetModelMismatch857` (`lib/client.js:12920`, called at `:12967`) says, in one clause, when the model a picked preset was recorded with is also recorded under presets of the opposite side, and names the limit — the panel holds no record of which model belongs to which side. It is not gated on how many generators the live lists show, because a kind round-trip asks the host for no models at all (measured on that card), and a gate written on that read would switch the warning off in exactly the case it exists for. The card is `CHANGELOG.md` T-857. The same function named in item 3 as `lib/client.js:19257` is at `:19292` after that edit.

## `force:true` does not step over the plugin's own clone guard — ruled "Keep refusing" on 2026-11-13 — do not re-open

1. **What was measured (T-814, 2026-11-12).** A `force:true` dispatch steps over the engine capability bar. It does not
   step over the plugin's own `clone_required` bar, and the refusal names the lane it belongs in and spends no id. That
   behaviour is pinned in the suites.
2. **The question T-814 left open was whether it *should*.** The operator ruled on 2026-11-13: **"Keep refusing."** The
   reason carried with the ruling: a clone-required model with no reference sample does not answer an error — it renders a
   wrong-sounding take, and a silent wrong answer is exactly what the capability bar exists to stop.
3. **Nothing moved in `lib/index.js` for the ruling**, and `AGENTS.md` 11.2 already states the bar. This is the half
   that names the guard the bar does not reach. Retired from `TODOS.md` item 4 on 2026-11-14 (card T-864).

## No environment key has ever answered at any boot of this plugin (read 2026-11-08) — do not re-derive

1. **The measurement.** The plugin store's `perf_log.jsonl` carried 42 boot markers between 2026-10-17 and 2026-11-07
   (the `queue_op` / `verb:"plugin_version"` record the mount writes) and **not one `config_declared` record among
   them**, including the boot the operator took at 14:00:41 Berlin on 2026-11-07.
2. **Why it is empty, from the code.** The boot audit is written only when a key is declared, a declared key was
   rejected, or the patch named a key this plugin has no knob for (`lib/index.js:23073`), and its own comment states the
   case this plugin is in: "A plugin that was given nothing says nothing" (`:23070-23071`). `cordis.patch.yml` declares
   the host row's `id` and `name` and no `config:` block at all; the tool row declares none on purpose.
3. **The environment, read off the live process on 2026-11-08:** no `DEEPAMP_*` key and no `AUDIO_PLAY_*` key. So the
   rename T-744 built is correct and, on this machine, **unused** — the plugin runs entirely on its defaults plus what
   its state file carries, and the silence in the boot log is the designed behaviour, not a missing record. Retired from
   `TODOS.md` part two item 11 on 2026-11-14 (card T-864).

## A suite wrapper built from a directory listing cannot skip a suite (read 2026-11-08) — do not re-derive

1. **What was read:** the twelve `scratch/full_20261107_*.log` full-run logs, their `=== SUITE <name>` headers, and one
   label distinctive to the `transparency` suite — that label is what proves a suite ran rather than that a word appears.
2. **Two genuine omissions, both hand-typed lists:** two of those logs carry no line of that suite at all, one printing
   25 suite headers where its own re-run an hour later prints 26. A typed-out list missing one name.
3. **The apparent omissions in four earlier logs were a false positive, corrected at the time:** those logs carry no
   suite headers at all — a wrapper format that labels nothing — and a suite's own output never contains its own name, so
   a word-search for a suite name in them proves nothing.
4. **What `npm test` is:** `package.json` `scripts.test` names 26 suites and the tree holds 26 `*.test.cjs` files,
   checked both ways. Run the tree with `npm test`, never with a hand-typed list. Retired from `TODOS.md` part two item
   12 on 2026-11-14 (card T-864).

## A preset pick, end to end on the live lane (measured 2026-11-14 19:0x Berlin, at the operator's card answer "Run it now") — do not re-derive

1. **The dispatch half.** `POST dispatch_task` naming the preset path made `ap-1525`: `task_kind gen`, model
   `stable_audio_sfx`, 5 s named by the caller, pinned to one slot, finished `ok` at 882 044 B. The row carries
   `preset_path`, `preset_name` and `preset_side: sfx` — the side read off the folder the preset lives in.
2. **The pairing half.** The same listing that offered the preset (`batch_text_list`) reports that run back:
   `used_model stable_audio_sfx`, `used_side sfx`, with a timestamp; the other presets in the same answer carry those
   three fields as null, because nothing has run them. The state file now holds exactly one `preset_uses` record and it
   is that one. The lane log carries one `preset_use` line per pairing, five in total.
3. **The pick half, driven in a fresh browser against the live panel.** Opening the load field listed the presets of
   three folders — the list is filled when the control is opened, not before. Picking the sfx preset moved the form from
   a voice task on a clone model to a generator task on the model the preset was recorded with, put the preset's prompt
   in the prompt field, prefilled the length to 5 s off the folder, and said all of it in one notice sentence. Script
   and dump: `scratch/pick_proof_20261114.mjs`, `scratch/pick_proof_20261114.json`.
4. **What is still only suite-proven.** The T-857 mismatch clause — a pick whose recorded model is not the one the form
   is on warns, and says what it warns about. With a correct record in place nothing disagreed, so **no live pick has
   ever displayed it.** Historical rows `ap-1521` and `ap-1524` keep the wrong pairing where a record belongs:
   `preset_side: music` on presets under `presets/music/`, run on the sfx generator at 180 s.
5. **What this does not buy.** The agent tools still expose no preset verb — `tools/index.js` names no `batch_text`
   call — so this path is a panel path today. That gap is tracked at `TODOS.md` item 28's pointer.

## The engine builds this package is tested against (read 2026-11-15) — re-read before quoting, this one moves

1. **How each node is read, and nothing else.** A node's version comes from its own checkout over ssh on that node:
   `git log -1 --format='%h %ad %s' --date=short`, `git describe --tags`, `git rev-list --count HEAD..origin/main`,
   `ls -l <build-tree>/bin/audiocpp_server`, and `systemctl show -p ActiveEnterTimestamp <unit>`. The unit timestamp
   is the one that says which build is actually answering requests; the checkout says which source is on disk; when
   they disagree, the running process is the older one. Machine names are in `LOCALHOSTS.md` §2; this file uses role
   words.

2. **The upstream line as read at 2026-11-15 07:2x Berlin.** The newest commit on `origin/main` is
   `6b0260ec 2026-11-14 "Share MoE FFN and Gated DeltaNet graph construction (#1293)"`, which `git describe` calls
   **`v0.9.5-7-g6b0260ec`**. All three nodes' checkouts were at `d38518a0 2026-11-14 "Add Zonos models to the WebUI
   and default Audio8 TTS to Realistic (#1283)"` = **`v0.9.4-75-gd38518a0`**, each **8 commits** behind, and that is
   the build every render of 2026-11-14 and of the 2026-11-15 morning ran on.

3. **What was done on 2026-11-15, at the operator's word** (verbatim: "do schedule to update our 3 nodes and run the
   compiles as background jobs while doing other tasks, track our latest upstream build we test on in the docs").
   Both CPU nodes were pulled to `6b0260ec` and rebuilt in their existing trees with their existing configuration
   (`RelWithDebInfo`, `GGML_VULKAN:BOOL=OFF`, the same compiler), no re-configure beyond what cmake does itself, no
   engine restart, no model re-load. The primary node's build finished `rc=0`; its new `bin/audiocpp_server` is
   1 128 497 928 B stamped 2026-11-15 07:20:33, and the build log on that node is 600 lines. The second CPU node's
   build was still running when this line was written — read its state before quoting this item.

4. **A build is not a restart, and this is measurable, not rhetorical.** On the primary node the unit's
   `ActiveEnterTimestamp` is still `2026-11-14 16:52:35`, and `/proc/<pid>/exe` on the running server resolves to its
   own build path followed by **`(deleted)`**: the process holds the image it started with, the file it was built from
   has been replaced, and every request it answers today is answered by the `v0.9.4-75` build. Nothing about a
   compile changes what a row measures until that unit is restarted — and a restart drops every loaded model on that
   machine, so it is a decision with a cost, not a step to take quietly.

5. **The GPU node is not built, not restarted and not used, on the operator's word (2026-11-15, verbatim: "…it's
   disabled for a reason, the GPU is in use by an LLM, so we can't use it to render currently, always ASK me before
   using disabled nodes!" — the sentence names the machine, and that name is in `LOCALHOSTS.md` §2).** Its pull had
   already landed when its
   compile was stopped: that checkout now reads `6b0260ec` while its Vulkan build tree is half-built (stopped at
   77 %, no link step) and its `bin/audiocpp_server` is still the one stamped 2026-11-14 16:46. **Source and binary
   on that node disagree today** and nothing there was restarted. No render was ever sent to that node. What to do
   with that half-built tree is the operator's call — `TODOS.md` part one item 39.

6. **What a compile does to a row's numbers, measured on the same day.** Two renders of the same length on the same
   model on the same slot, minutes apart, cost **121 804 ms** and **196 853 ms** while a compile was running on that
   machine. That is a 1.6× spread on identical work and it is co-occurrence, not a controlled measurement — the point
   it supports is the smaller one: a compile competes for the same cores as a render, so a row timed during a build is
   not comparable with a row timed without one. Time a test batch and a node build apart, or read the timings as
   upper bounds.

7. **GPU node rebuilt at `2872e36e`, 2026-11-16, at the operator's instruction** (verbatim: "3.9 item39 - start a
   clean fresh rebuild from upstream now first in the background - afterwards, restart the service and do short test
   run for both lanes"). The node's checkout moved `6b0260ec` → `2872e36e 2026-11-16` (`v0.9.5-15-g2872e36e`) by a
   plain pull; the existing Vulkan tree was renamed aside untouched (`build_old_vk_pre_20261116`) and a fresh tree was
   configured (`RelWithDebInfo`, `GGML_VULKAN=ON`) and built with four jobs, ~20 minutes, `rc=0`.
   **What the fresh build refused — the requirement every future build of these units carries.** The first restart
   crash-looped both units with the engine's own sentence: `UI model management is not available in this build;
   reconfigure with -DAUDIOCPP_BUILD_NATIVE_MODEL_MANAGER=ON` — the units carry `--ui-management`, upstream gates that
   flag behind that build option at this commit, and the fresh tree answers that option OFF by default while the OLD
   tree's cmake cache had carried it ON. Reconfigured with it ON, `audiocpp_server` rebuilt, restarted: both units
   `active`, the models-root post-start hook OK, `/health` answers `engine_build "dev 2872e36e 2026-11-16"`,
   `backend:"vulkan"`.
   **The test run, both lanes, on the operator's word releasing both slots for it (both re-held after it).** TTS:
   `ap-1720`, pinned to the speech slot, model and voice taken from that slot's own catalog — ok, **cold load
   30 893 ms** (the expected state: fresh boot plus the ruled `idle_unload_ms 1800000` regime), **generation
   7 078 ms**, a 5.28 s take, 253 484 B. STT: `ap-1721` transcribed that very take on the transcription slot, on the
   model that slot lists for the task — the take's words came back complete. The lane was idle throughout; both slots
   read `held_by:"operator"` again after the run.
   **Cleanup per `AGENTS.md` 5.15** (build, restart, verify, re-read, then clear): `build_old_vk_pre_20261116` was
   removed from the node, 5.9 GB by `du`; the node's `df` reads the same free space before and after the step — that mount is
   ZFS and its accounting does not move with a single delete, which is stated instead of quoting a freed number.

8. **Re-read 2026-11-19 14:0x–14:1x Berlin, and this time the nodes were moved (the operator's ask, verbatim: "do update all nodes to latest versions and restart services on <the two CPU nodes> - keep service on <the GPU node> stopped after update").** The upstream tip read on each node's own checkout is `5e7273db 2026-11-19 "New Community Model: Granite Speech 5.0 2B (IBM) (#1332)"` = **`v0.9.5-34`**. Before the pull the two CPU checkouts sat at `6b0260ec 2026-11-14` = `v0.9.5-7`, **27 commits behind**, and the GPU checkout at `2872e36e 2026-11-16` = `v0.9.5-15`, **19 behind**; all three were taken to the tip with `git pull --ff-only` and rebuilt in the tree each node already had, no re-configure, each answering `BUILD_RC=0` with zero error-bearing lines: server 1 169 906 400 B at 14:03 on the primary CPU node, 1 211 709 528 B at 14:13 on the second CPU node, 1 284 461 632 B at 14:03 on the GPU node. The four CPU units were restarted after their slots were held — **14:05:29** on the primary node and **14:14:55** on the second — and the GPU node's two units were left `disabled` / `inactive` and verified to run nothing (no process whose `/proc/<pid>/exe` resolves to the server binary, no listener on either audio port). Catalogs after the restarts: **59** tts / **57** stt on the primary CPU node and **59** tts / **58** stt on the second — the same numbers as before the update, because what upstream added is converters and installable packages, not files this fleet's store holds. Card `CHANGELOG.md` T-888.

10. **Every name on both CPU catalogs has a record on this lane, and the one exception is refused by both ends at once (read 2026-11-19, the answer to the operator-s "5.2 any other untested / unknown models we should test ?").** The four live catalogs (59 tts / 57 stt on the primary CPU node, 59 tts / 58 stt on the second) were diffed against this plugin-s perf log — 111 distinct model names over 9 313 model-bearing records — after normalising the two spellings the sides use. No CPU name is untouched. `qwen3-tts-1.7b-custom` is the exception and it is a fault, not a gap: pinned to each CPU node the model loaded (29 145 ms and 24 879 ms) and the engine answered the identical `500 Qwen3 custom voice prefill requires speaker` on a request the lane sent as a clone (`voice_mode:"clone_sample"`, 0 bytes); with no voice named, this plugin-s own door refuses before a row exists ("is a voice-clone family — pick a voice (no built-in voice)"). The wire offers no way to learn what that engine wants: `/v1/models/specs` and `/v1/specs` answer 404, `GET <engine>/v1/audio/voices` on that slot answers the 13 clone voices registered on the shelf and nothing about the model-s speakers, and `/v1/models` carries no option fields. 31 names this lane has run are no longer on a live CPU catalog. Filed as `TODOS.md` part one items 72 and 73.

11. **What `kitten_tts` can do is answered two ways inside this plugin, and the engine-s own 500 decides which answer is wrong (measured 2026-11-19).** `GET voice_modes?fn=tts&model=kitten-tts` answers `known:true` with one mode, `preset_speaker`, naming 16 built-in voices from the model-s own engine record and offering no clone mode. The capability bar-s membership check (T-884) asks whether the FAMILY declares a clone leg in `capsOf` / `FAMILY_CAPS`, answers yes for `kitten_tts`, lets the dispatch through, and the payload goes out on the clone channel — the engine answers `500 unknown Kitten TTS request option: reference_text. The option may be misspelled or require a newer audio.cpp runtime. Supported options: <the upstream repository-s own list>` (`ap-1790`, load 348 ms, gen 2 022 ms, 0 bytes, 0 duration). For contrast, a take on the same slot naming one of the 16 (`ap-1785`, `Bella`) rendered 8.02 s of speech in 8 487 ms of generation after a 2 037 ms load. T-884-s rule refuses where both halves are known; this is the case where the two halves this plugin holds disagree. Filed as `TODOS.md` part one item 75; nothing was changed for this line.

12. **The two CPU lanes, measured end to end on 2026-11-19 (the pass is `CHANGELOG.md` T-891; the log is `scratch/regress_stt_20261119.log`).** Voice modes, one row each: `no_voice` on a `voice_samples` family (6.08 s, load 1 240 ms, gen 109 043 ms), `preset_speaker` on a built-in family naming one of its 16 (8.02 s, 2 037 ms, 8 487 ms), `clone_sample` with a stored registry voice staged to the second node (5.84 s, cold load 33 179 ms, gen 44 365 ms), and a stored voice asked of the `voice_samples` family refused at the door before a row exists. Both halves of the duration record answered as designed: a named 4 s came back `duration 4` with `options {"duration_seconds":"4"}`; an unnamed request came back `duration 120` with `note "length filled from the stable_audio record (params duration_sec default 120 s): this request named none"`. On the transcription lane: an asr family on each CPU node returned a transcript, the diar-then-asr chain (`dispatch_speaker_asr`) returned `speaker_turns` with its window (`speaker_0`, 0.32 s – 5.92 s) and its own text and reported both engine-side models, and a diar model asked of a slot that lists none was refused with that slot-s 57 names in the answer. Transcription is not word-exact on the short CPU builds and the two families made different errors on the same 6.08 s take. Live knob values: `job_timeout 7200`, `limit_one_per_host` off with cap 2 from the default, `takes_limit` `auto_delete` at 2 GiB, `stt_feed` resample / 16000 / **channels `source`** with `is_default:false` and diarization forced to 16 kHz mono, `auto_gen` `state:"unknown"` with no panel reporting. `unload_all_models` on both CPU speech slots: `unloaded_count:1` each, `models_list_updated:true`, `loaded_after:[]`.
13. **Every verb and every script in the package was exercised on 2026-11-19, read-only or bounded (logs `scratch/verb_pass_20261119.log`, `…pass2…`, `…pass3…`, `…pass4…`).** The dispatcher answers 103 verbs; the pass ran every read it could reach and every row-making verb that costs nothing but lane time, and left the destructive half (delete, clear, registry rewrite) untouched with the reason stated in the chat record. Rows it made: a take `ap-1797` (2.72 s, load 1 872 / gen 36 488 ms), a transcription `ap-1798` (6.1 s, load 34 255 ms — a cold model load on the transcription primary), a generated take `ap-1799` (the named `duration 3` kept, 529 244 B), a speaker chain `ap-1800` (6.08 s), a slice `ap-1801`, a format conversion `ap-1803` (mp3, 130 031 B), a chunk chain `ap-1814` (the verb ran its own diar pass: `nemotron-3-diar` 1 397 ms, `diar_lane:"batches"`), a resample `ap-1819` (44 100 Hz mono), an upload `ap-1820` (a real take sent back into the store, `row_kind:"upload"`), and three endings: `ap-1802` cancelled by `cancel_job`, `ap-1816` aborted by `abort_fn` (`error:"aborted by user"`), `ap-1817` taken out of the queue by `abort_job` (`action:"dequeued"`). Both queues were empty at the end and neither was left paused. **Verb shapes the pass had to learn from the code, because the first guess was wrong:** `resample_audio` needs `sample_rate` from a fixed list **and** a `reason` string naming the contract the copy is for; `diar_to_chunks` refuses a row whose output is a transcript rather than audio; `convert_item` writes only wav, ogg, mp3; `job_flag` accepts only six named tokens; `retry_job` takes only error or aborted rows (it re-ran the aborted one as `ap-1804`, ok); `wave_peaks` reads `?job=`, `log_tail` reads `?limit=`; `get_pipelines` is GET-only and pays a catalog join; `station_title` answers `st:"no_url"` when asked with no url; `auto_gen_state` is a POST that RECORDS the panel-s chain state ("held in memory only") and is not a read — the read is `queue_status`. The setter doors `job_timeout`, `limit_one_per_host` and `batch_split` were each POSTed their own current value, so the write half is proven and nothing changed.
14. **Four method probes, and the two blind spots in the executable verb contract (measured 2026-11-19; the card is `CHANGELOG.md` T-893).** `GET last_agent_message`, `GET import_path`, `GET job_flag` and `GET unload_all_models` each answer `method not allowed` — all four are POST-only doors, and `job_flag` is one the contract reader labels "GET only", because its block tests the method in a compound condition (`if (qfVerb !== 'job_flags' && method !== 'POST') { notAllowed(); }`) that matches neither strict pattern. `voice_registry` carries its gate on the same line as its opener (`if (parts[0] === 'voice_registry') {  if (method !== 'GET') { notAllowed(); return; }`) and the reader-s opener regex requires the line to end at `) {`, so that route is absent from its gate map entirely: the suite reads 102 routes where the dispatcher answers 103. Both are faults of the reader, not of the host, and they are filed as `TODOS.md` part one item 77 rather than fixed mid-pass. What the reading produced: `docs/VERBS.md` (103 routes, one table row each, the refusal vocabulary as it reads) and two pins in `tests/verb_contract.test.cjs` that compare **route names in both directions and never the labels** — 103 routes, 103 rows, 0 gaps, 0 extras; that suite 25 → 27, and the full pass 26 suites / 6 223 assertions / 0 fail (`scratch/regress_suites_893.txt` against the recorded 6 215 in `scratch/regress_suites.txt`).
15. **The catalog read answers tasks, and `sep` is not one of them — which is why a script cannot pick a separator (measured 2026-11-19; the card is `CHANGELOG.md` T-894).** `GET get_models?fn=tts` answered 30 rows: task `tts` 24, `clon` 5, `vdes` 1. `GET get_models?fn=stt` answered 13 rows: `asr` 10, `diar` 3. No row on either read carries a `sep` task, so a read of this verb cannot name a separator — a script that wants one either takes it from a flag or says it does not know. The same reads are what `scripts/voice_replace.sh` now uses for the other three model slots on its route (a task match first, then a model the engine already has loaded, then a placeholder with the reason), and the reads it made were a `tts`-task model for the scene render, `sortformer-diar` for diarisation and `qwen3_asr` for transcription. Beside that: a `save_voice` command a script had been printing carried no `asr_model` after T-892 made that field required, so the printed command would have been refused at the door — a card change reaching into a script's printed text is the fault this item exists to catch. The two catalog reads are not the same read and a script has to know which one it is using: on the same slot, `GET get_models?fn=tts` answered 30 rows (with `stale` and `as_of`) while `POST endpoint_models {fn:"tts",id:"primary"}` answered 59 names. The first is the capability-projected list and is the only one that carries `task`, which is what a pick-by-task needs; the second is the registry catalog. A model the projection does not carry is not pickable by the first read — which is the honest limit of the run-time pick T-894 added.
16. **`dramabox` clones through a parameter this plugin does not write — the row is made before anyone knows it cannot work (measured 2026-11-19; filed as `TODOS.md` part one item 80).** `ap-1825`: model `dramabox` q8_0 with the registered voice `t2_arnold`, `voice_mode:"clone_sample"`, 0 bytes, engine answer `500 unknown DramaBox request option: reference_text`, and the plugin's own outcome record carries `cls:"capability"`. The engine's own per-model parameter table for that family names `target_voice` (`audio_path`) as the reference voice and `reference_duration_sec` for the crop, and names no `reference_text`, `voice_samples` or `voice_ref`; the family the lane clones successfully (`cosyvoice3`) does name `reference_text`, which is the difference. The same model asked with no voice renders (`ap-1827`, `voice_mode:"no_voice"`), so this is the clone leg and not the model. Two related reads worth citing instead of re-deriving: `model_capabilities?fn=tts&family=dramabox` answers 13 parameters with `tasks:["tts"]` and `builtin_voices:[]`, while this package's own family table claims `tasks 'tts clone'` for the same family, and `voice_modes?fn=tts&model=dramabox` offers `no_voice` and `clone_sample` with the reason "the engine declares a clone task" — that sentence names the engine while the claim comes from this package-s table.

17. **Which families a stored voice can be handed to is written in the engine-s own parameter table, and a sweep of one CPU slot says it is a family class, not one family (measured 2026-11-19; the card is `CHANGELOG.md` T-895).** `GET model_capabilities?fn=tts&family=<name>` on the primary CPU slot answers **44 families carrying a parameter table**, and **11 of them name at least one of the three keys this lane writes for a stored voice** (`voice_samples`, `voice_ref`, `reference_text`) — those are the families the clone path serves today, and `cosyvoice3` is the example that shows why the same channel works there and not elsewhere. The other 33 name none of the three; among them, the ones that name a reference voice at all name it as a **file the engine reads** under a fourth key and a path type — `target_voice` (`audio_path`) on the diffusion family of item 16, `source_audio` and `target_voice` on a chunker family, `voice_embedding_file` (`path`) on an embedding family, `cfm_noise_file` and `ultimate_clone` on another. A parameter that is path-typed but says nothing about a speaker (`noise_file`), or carries the word "voice" under another shape (an enumerated `voice_id`, a `do_sample` switch), is not a reference channel and is not counted by the rule. Two reads on the same slot a caller has to tell apart: `GET get_models?fn=tts` answers 30 capability-projected rows carrying `task` (`tts` 24, `clon` 5, `vdes` 1), while `POST endpoint_models {fn:"tts",id:"primary"}` answers 59 **plain name strings** under `endpoint.models` — not dicts — and the second cannot answer a task question at all. What the rule produced is a word a caller can read before a row exists: `capability.why:"no_clone_channel_for_family"` with `capability.clone_channel` naming the parameter the family does take, and `voice_modes` carrying `clone_none_reason` where `clone_sample` is deliberately not offered. Pinned by 13 assertions in `tests/host.test.cjs` (the suite 2 664 → 2 677; full pass 26 suites / 6 236 / 0 fail, `scratch/regress_suites_895.txt`).

18. **A voice exchange is a request with TWO audios, and the engine-s own parameter table says which family reads which of them (read live and measured 2026-11-20 Berlin; the open line is `TODOS.md` part one item 83).** (i) This plugin-s own family table marks five families `voice_conversion` with wire tasks `vc` and `svc`, and a sixth family served on the speech lane declares `vc` among its tasks — so conversion is not a separate engine, it is a task on families this lane already places. (ii) **The generic wire shape is one audio in the request body plus one staged reference the server parses itself**: the source as the request audio, the target reference under `voice_ref`. That is the shape the engine-s protocol reads; several families additionally declare a `source_audio` and a `target_voice` parameter of type `audio_path`, whose own descriptions read "Voice conversion source WAV path; overrides audio_input" and "Voice conversion target WAV path; overrides the speaker reference". A family that declares those two is not asking for them: the plugin stopped sending the duplicate source on purpose, because a field the engine ignores looks like it is doing something. (iii) **One family declares no speaker reference at all** — it converts to the engine-s pretrained default voice whatever reference was uploaded and paid for — which is why the door refuses a registry voice on that family before the row exists instead of rendering a voice nobody asked for. (iv) **Measured end to end on a real dictation, on a CPU node:** a 20.87 s source in, a **20.88 s / 1 002 284 B** take out, model load **1 438 ms**, generation **153 762 ms**, the row naming the voice it converted to (`vc_target_voice`), and a fresh transcription of the converted take answering the same sentence as the transcription of the source — so the exchange kept the words and changed only who spoke them. (v) **The engine-s own webui carries the same records, not a private path:** its bundle embeds the model_specs this plugin reads and its runner posts `{model, request}` to the same `/v1/tasks/run` route, so nothing about conversion is reachable only from a browser. (vi) **The two doors on one store do not share a container list:** `convert_item` writes `wav`, `ogg`, `mp3` and refuses a `.webm` source naming the container it does not know, while the panel-s dictation upload accepts `.webm` and the transcription lane reads it through its own resampled feed — so the audio a person dictated to this plugin cannot be re-voiced inside the lane without a step outside it. (vii) The conversion never asks for a model name this document could supply: the model is read from the slot-s catalog, exactly as on every other lane.

9. **`/health` answers the engine's own build, and that is the field worth reading.** After the restarts all four CPU slots carry `engine_build "dev 5e7273db 2026-11-19"`, read off the endpoint itself with no ssh involved. The dated claim this package's code carries beside that field (measured 2026-10-21 on both CPU nodes, that the engine does not serve its own build) is **superseded**: the plugin already reads it and stores it. What is stale is the sibling field on the same registry entry — `build "v0.9.3-52-g76e99236"`, last written 2026-11-02 from a person's read of a checkout — which stayed two upgrades behind while the lane kept rendering. Filed as `TODOS.md` part one item 71; no source was changed for this line, and the code comment was left as written rather than re-cut in a records pass.

## The same model file answers under two ids on one engine (measured 2026-11-15 ~08:00 Berlin) — read the engine before quoting this

1. **What was read, and how.** `GET <engine>/v1/models` on both CPU engines, beside the plugin's own
   `POST endpoint_models {fn,id}`. The engine answers `{"object":"list","data":[…]}` and every entry carries `id`,
   `family`, `task`, `path`, `loaded`, and **`configured`** — the field that separates an entry the node's own config
   declares from one the engine found on its own. That field is what the engine's webui labels "Manual setup".
2. **The two engines are not identical.** The primary node's engine answers **61 entries — 60 `configured:true`, 1
   `configured:false`**. The second CPU node's engine answers **60 entries, none `configured:false`**. The extra id is
   `stable-audio-small-sfx`, and its `path` is byte-for-byte the file the configured id `stable_audio_sfx` already
   names: `Stable-Audio-3-Small-SFX-GGUF/stable-audio-3-small-sfx-q8_0.gguf`. **One file, two ids, on one engine.**
   The engine's own webui shows the same shape the operator screenshotted: a family card with a Package selector and
   Update / Download / Remove beside it, and the configured entry as its own row.
3. **Seen in our own reads, 50 s apart.** Two `endpoint_models` reads named the engine's resident model as
   `stable_audio_sfx` (07:49:22) and as `stable-audio-small-sfx` (07:50:12). Same file, two names, and the plugin's
   per-endpoint `loaded_models` read carries whichever the engine printed.
4. **What the plugin does with the two names, read from the code.** `rateNormKey648` (`lib/index.js:6862`) lowercases
   and turns `_` into `-`, so `stable_audio_sfx` becomes `stable-audio-sfx` and the auto-detected id becomes
   `stable-audio-small-sfx`. **Neither is a prefix of the other, so T-804's longest-matching-key rule does not join
   them.** `RATE_MEASURED648` (`:6832-6847`, 14 rows, fitted 2026-10-27) carries **no `stable_audio` row at all**, so
   today both spellings already fall to the lane median 6.11: the duplicate changes no number today, and it decides
   which name any future measurement of this family lands under.
5. **Why it is not only cosmetic.** Model ids are the keys this package's records use — `docs/MODELS_TABLE.md`,
   `docs/MODEL_PROVENANCE.md`, `docs/MODELS_TEST_MATRIX.csv`, the preset↔model pairing a run records (T-841
   `used_model`), and every row's own `model` field. A second id for one file splits that history in two: a preset
   that recorded one id is not paired with a take rendered under the other.
6. **The package files, measured today, on the shared store both engines read.** The SFX q8 file is
   **1 683 576 512 B stamped 2026-11-15 07:56:30** — written today by the engine's own webui update, and both nodes
   saw the same file at the same moment because it is one shared store. The Medium q8 file is 3 582 595 584 B stamped
   2026-08-25 18:54:46 and the webui still offers an update for it. The `Stable-Audio-3-Small-Music-GGUF` directory
   exists and is empty, which is what the webui's "0 of 2 packages installed" names. `docs/MODEL_PROVENANCE.md:128`
   carries 1683 MB and `up_to_date` for the SFX package and that matches the file as it now stands; **if the Medium
   package is updated, every size this package quotes goes stale with it — including the tier figures written into
   `README.md` on 2026-11-15 — and the two suite-read records have to be re-read in the same pass.**
7. **State.** Measured, open, and the direction is the operator's: `TODOS.md` part one item 41. Nothing on any node
   was changed by this reading, and no dispatch was sent under either spelling.

## How a model gets registered on an audio.cpp engine, and why our manual ids collide with the engine's own (measured 2026-11-15 ~08:30 Berlin, in the engine's source) — read the engine before quoting this

1. **Two ways in, and only one of them happens at boot.** `ServerState::load_models()` (`app/server/runtime.cpp:240`) iterates **`config_.models` and nothing else** — boot registration is the node's config list, there is no directory scan. The second way is `ServerState::handle_model_load` (`:323`), gated on `ui_management`, which is what the engine's own WebUI calls: it registers a model under **the id the WebUI posted**. That is how `stable-audio-small-sfx` entered the primary node's list on 2026-11-15 while `stable_audio_medium` did not.
2. **The rule that decides collision versus no collision, in the engine's own words.** `handle_model_load` builds the requested config, then `if (const auto configured = configured_models_.find(requested.id); …) inherit_configured_model_fields(…)` (`:370`), then looks the id up in `model_index_` (`:341`): **a match reuses the existing registration and reconfigures it in place; only a non-matching id reaches `models_.push_back` (`:394`) and creates a second entry.** Ids are compared as strings. `/v1/models` prints `configured:true|false` from `configured_models_.count(id)` (`parallel_runtime.cpp:2459`) — that is the field the WebUI renders as "Manual setup".
3. **So the collision is not a one-off, it is what happens to every model updated through the WebUI while our id differs in spelling from the engine's catalog id.** Measured against `webui/configs/models_catalog.json` (**220 entries**, ids quant-free and hyphenated, each carrying `display_name`, `family`, `task`, `mode`, `path`, `download_id`, and some carrying `session_options` and `min_vram_gb`): of the **60** ids the primary node's config declares, **37** match a catalog id after normalising `_` to `-` and **23** do not — and every one of those 23 still has a catalog counterpart, under the engine's spelling: `stable_audio_sfx` → `stable-audio-small-sfx`, `moss_ttsd_q8 / _q4_k / _bf16` → one id `moss-ttsd`, `htdemucs_q8 / _f16` → `htdemucs`, `mel_band_roformer_q8` → `mel-band-roformer`, `sortformer_diar_f16` → `sortformer-diar`, `omnivoice_f16` → `omnivoice`, `qwen3-tts-bf16` → `qwen3-tts`, `qwen3-customvoice` → `qwen3-tts-1.7b-custom`, `qwen3-voicedesign` → `qwen3-tts-1.7b-vdesign`, `pocket_tts_en_q8 / _bf16` → `pocket-tts` / `pocket-tts-small`, `mossformer2_ss_16k_f16` → `mossformer2`, `tf_gridnet_wsj0_2mix_f32` → `tf-gridnet`, `seed_vc_mlx` → `seed-vc` / `seed-vc-svc`, `fireredtts3` → `fireredtts3-base / -instruct / -instruct-vdesign`, `higgs_tts` → `higgs-audio-tts`, `fish_audio` → `fish-audio-s2-pro` / `fish-drama3`, `lfm2_audio` → `lfm2-audio-asr / -s2s / -tts`, `rvc_f16` → `rvc`. **Nothing is unreachable; the names differ, and six of our single ids map to several catalog entries** (`pocket`, `seed-vc`, `mossformer2`, `htdemucs`, `fireredtts3`, `lfm2`) — those are per-model decisions, not a rename.
4. **The engine's catalog carries knowledge this package carries nowhere.** `stable-audio-medium` in the catalog declares `min_vram_gb: 10` and `session_options.stable_audio.mem_saver: "true"`; `stable-audio-small-sfx` declares `min_vram_gb: 4`. That is the engine's own answer to why the medium generator lost its GPU context on an 8 GiB card (2026-10-13, `vk::Queue::submit: ErrorDeviceLost`) and it is a number a node can be checked against before a take is asked for.
5. **Where the WebUI writes, measured on the primary node.** The config carries no `models_root`, so the engine defaults it to `<binary directory>/models` (`runtime.cpp:137-148`), and on that node that path **is a symlink**: `…/build/linux-cpu-release/bin/models -> /mnt/llama/…`, created 2026-10-25. The unit also runs a helper that reports `audiocpp-set-models-root[8963]: OK models_root=/mnt/llama/audio.cpp is_default=false` and the engine logs `native WebUI model root changed to: "/mnt/llama/audio.cpp"` (journal, 2026-11-11 and 2026-11-14). **That is why the package file this package's records name was rewritten at 2026-11-15 07:56:30 by a WebUI update** — the engine's own model root already points at the shared store.
6. **What "no manual entries" would actually mean, stated before anyone does it.** With `models:` empty the engine boots with **zero registered models**, `/v1/models` answers an empty list, and this plugin — which refuses a model the target does not list — refuses everything until a WebUI registers one model at a time. The form that reaches the operator's goal instead is **the same config mechanism, with the engine's own ids**: keep `models:` as the boot registration, name each entry exactly as the catalog names it, and let the entry's `path` point at the file that node actually holds. One file, one id, the same id on two nodes running different quants, and a WebUI action then lands on the configured entry instead of adding a second one (`:341` / `:370` / `:394`).
7. **State.** Measured. The direction is the operator's ruling of 2026-11-15 ("i would like our manual entries to be gone if possible so we can rely on the vanilly registration of the files by audio.cpp … we will keep this setting on a per node basis within audio.cpp … our plugin will just use the same model name") and the open half is `TODOS.md` part one item 41. No node config was touched, no engine was restarted for this reading, and no dispatch was sent under a new name.

## What an effect prompt has to say for the stable-audio family to answer it (measured 2026-11-15 09:0x–10:0x Berlin, ten renders on one CPU slot) — the finding, the numbers, and the rule it produced

1. **The finding, in one line.** A one-word prompt on the small effects generator answers with **music**; a short caption that names **one** event and says what must not be in it answers with **that event**. Measured on one model, one file, one endpoint, with only the prompt text and the requested length changed between takes. It is not a tokenizer fault and it is not the wrong model — the text path demonstrably works.
2. **What the model file itself says, read from its header before any of this.** The effects package and the medium package carry a **byte-identical embedded model spec**: family `stable_audio`, display name "Stable Audio 3", tasks `music, sfx, edit`, capabilities `music: lyrics` / `sfx: prompt_generation` / `edit: prompt_editing`. Their weights differ (1 024 tensors against 1 336, different `general.name`), and **nothing in either file names which side it is** — the same fact `AGENTS.md` 5.18 states for the engine's capability records, now measured in the files. The text encoder's tokenizer is **embedded in the model file** (`t5gemma-b-b-ul2`: `config.json`, `special_tokens_map.json`, `tokenizer.json`, `tokenizer.model`, `tokenizer_config.json`, plus `model_config.json`): there is no separate tokenizer package that could be missing, and a "false tokenizer" explanation had no mechanism to stand on.
3. **The ten renders.** All on the second CPU node's tts slot, model `stable_audio_sfx`, quant `q8_0`, the small effects package. `ap-1561` and `ap-1564` ran on the engine as it stood; the other seven ran after that node's two units were restarted at 09:23:08 and verified at the same build. "ms per audio second" is `elapsed_gen ÷ requested length`, load excluded. "sound carried" is this plugin's own measurement on the stored file, present only where the row carries the note. Two of the four one-word takes were read in full; the other two carry the same prompt, length and endpoint and were not read individually. Row ids are the plugin's own and are local ids — they fall under the v0.1.1 sweep (`TODOS.md` part one item 38) if the operator rules they may not be tracked.

| row | prompt | length | load ms | gen ms | ms per audio s | sound carried | heard as |
|---|---|---|---|---|---|---|---|
| `ap-1561` | the single word `lama` | 5 s | 3 421 | 22 321 | 4 464 | no note | music, not the animal |
| `ap-1562`–`ap-1564` | the single word `lama` | 5 s | 1 145 (`ap-1564`) | 15 062 (`ap-1564`) | 3 012 (`ap-1564`) | no note | music, not the animal |
| `ap-1570` | "a single dog barking twice, close microphone, dry room, no music" | 10 s | 2 294 | 22 571 | 2 257 | 7.0 s of 10, 1.3 s of it at the end | the dog, as asked |
| `ap-1571` | "a steam train horn in a tunnel, no music" | 10 s | 891 | 21 335 | 2 134 | 9.3 s of 10, 0.7 s at the end | the horn, as asked |
| `ap-1572` | "a llama braying, single animal call, close microphone, dry room, no music, no drums" | 10 s | 845 | 21 128 | 2 113 | 9.0 s of 10, 1.0 s at the end | llama-like, ok |
| `ap-1573` | "a single llama vocalizing, one short animal cry, field recording, no music, no instruments" | 10 s | 1 085 | 21 583 | 2 158 | 5.6 s of 10, 4.4 s of it silence | llama-like, ok |
| `ap-1574` | the `ap-1572` caption | 5 s | 1 127 | 15 320 | 3 064 | no note | ok |
| `ap-1575` | the `ap-1573` caption | 5 s | 874 | 15 773 | 3 155 | no note | ok |

4. **Length: 5 s fills the window, 10 s does not.** The same two captions asked for 10 s carried 9.0 s and 5.6 s of sound — the second left **4.4 s of silence** in a 10 s file — and neither carried a sound-coverage note at 5 s. A single animal call is a short event and the model does not stretch it to fill a longer request; the extra length is silence, not more of the sound. **The panel's own prefill of 5 s for anything under the effect folder is therefore the right shape**, and asking longer costs engine time for silence: at 10 s the engine spent 2.1–2.3 s per audio second, at 5 s 3.0–3.2 s, so a longer take is cheaper per second and still less of it is sound.
5. **Cost, measured, for this package on a 4-core CPU node.** Load 0.9–3.4 s (a cold load after a boot 2.3–3.4 s, a warm load under a second), generate **2.1–3.2 s of engine time per second of audio** warm. The one-word takes on the file as it stood before this morning's WebUI update measured 5 327 ms per audio second (`ap-1557`, 5 s in 26 635 ms, the operator's own run) — quoted as a same-day reference, not as a controlled before-and-after, since that row's boot and node are not named in this reading.
6. **Why the one-word prompt produces music, stated as what is known and what is not.** Known: the prompt reaches the model (a dog, a horn and a llama each came back), and a one-word prompt returns the family's music prior. Not known: whether the word `lama` is absent from the model's conditioned vocabulary or too weak to displace the music prior — the model's training data is not in the file and this package cannot read it. What a session needs is not the cause but the rule: **name one event, name the microphone and the room if you want them, and say what must not be there** (`no music`, `no drums`, `no instruments`). The two captions that worked differ in wording and both worked; the exclusions are the part they share.
7. **What this changed in the package, at the operator's word.** The operator's words (2026-11-15): "ap-1572 and ap-1573 are 'lama-like' - sounds ok, should be a little shorter, maybe test 5 seconds so we know it's not the short duration at fault … and it seems we have to expand the startup preset for the 'llama call'". The effect starter preset's prompt is no longer the single word `lama`; it carries the `ap-1572` caption — the one that filled the window at both lengths. **That reverses T-833 (2026-11-13), which set it to one word at the operator's own word**, and `docs/PROMPT_FIRST_SETUP.md` §3 item 2, which carried the one-word rule as an instruction to an installing agent, now carries this rule instead. The card is `CHANGELOG.md` T-866. No code was touched: the panel reads the side off the folder and prefills 5 s from it, and the host passes the prompt through as given.
8. **State.** Measured, and the listening verdicts are the operator's, given in the chat of that morning. This is the record to cite instead of paying for another test series: a future session that wants an effect from a stable-audio generator should write a caption in this shape at 5 s, not a keyword at any length.

## How a node notices a model file changed, and what the engine's load and unload knobs do (measured 2026-11-15 ~10:3x Berlin, in the engine's source and in the node configs)

1. **Three things are separate, and only the files are shared:** the registered list (`/v1/models`, which is what this plugin reads as a catalog), the bytes at the paths that list points at, and the installed / update state the engine's webui shows. The first and the third are **per engine**; only the second is shared.
2. **Registration is per engine and there is no scan at boot.** `ServerState::load_models()` (`app/server/runtime.cpp:240`) iterates `config_.models` and nothing else; the only other way into the serving list is `handle_model_load` (`:323`), which is the webui's own call. **An id one node's webui registered exists on that node and nowhere else.**
3. **The update state is per engine too.** `package_installed` (`src/framework/package_manager/manager.cpp:134-140`) is satisfied only when every file the catalog lists for that package exists under `models_root / package.target_directory`, and the verdict is the per-file etag comparison of item 43's mechanism (`:905-925`). The scan that produces it runs only when **that engine's** `package-sizes` verb is called (`app/server/model_installer.cpp:602-650`), and the state it writes lives in a **fresh, uniquely named directory under that machine's system temp directory, created once per engine state** (`make_job_root()`, `:195-215`, called at `:258`) — not in one stable per-engine directory, and the files appear **only when a scan is asked for**. **Measured on the second CPU node: two such directories exist there, both created at 09:23:08 — the exact minute its two units were restarted — and both are empty.** The directory is a sign an engine started; the files are the sign a scan ran. **The sentence this section carried before, that "each engine writes its own state under its own `/tmp/audiocpp-model-installer-*`", was wrong in form and is corrected here**: the location is right, the per-engine stability is not, and the absence of the files is what means no scan has been asked for on that engine.
4. **`max_loaded_models` is an LRU cap, not a switch.** The engine's own wording: "keep at most n models resident in memory, unloading the **least recently used idle** model first; 1 enforces a single loaded model, **default 0 (no limit)**" (`app/server/main.cpp:113-115`). Both CPU node configs carry `max_loaded_models: 1`. **This section first reported that as "the only automatic eviction that exists today", and that was wrong for the same reason item 5 was: the other automatic eviction — the idle pass — has been running on these nodes since 2026-10-04** because the units carry the flag. What the two knobs cover between them is the whole of the automatic side: the cap bounds how many are resident at once, the idle pass returns them when nothing is using them.
5. **Idle unload is off in the engine's default — and ON on both CPU nodes, on the unit's ExecStart, since 2026-10-04. The sentence this item carried ("off on both CPU nodes") was wrong in effect, and the reason it was wrong is the method:** the key is not in the server JSON, so a reader who looks only at the JSON reports it unset. `int idle_unload_ms = 0;` (`app/server/config.h:109`) is the default and neither node's server JSON names the key — but `systemctl cat audio-cpp-cpu.service` on each CPU node shows a drop-in `audio-cpp-cpu.service.d/dynamic-models.conf`, dated **2026-10-04 20:41 on both nodes**, whose `ExecStart` carries `--ui-management --idle-unload-ms 3600000`, and the live process command lines of both units on both nodes carry it (`tr '\0' ' ' < /proc/<pid>/cmdline`). **The proof that it runs is the unit's own journal:** `sudo journalctl -u audio-cpp-cpu.service` on the second CPU node holds **85 lines of the form `[server] idle 3 847 931 ms: unloaded 1 model(s)`** since 2026-10-04, the idle spans all just over the configured hour, which is the engine's own log line for a pass that actually dropped something (`parallel_runtime.cpp:2540-2543`). The loop (`:2494-2509`) polls every `max(1000, idle_unload_ms / 10)` ms and calls `unload_idle_models()` once the time since `last_activity_ms_` reaches the value; `unload_idle_models` (`:2512-2545`) takes the busy lock of every resident model and its own comment is the important half: **"Never unload a model mid-inference; a busy model keeps its slot and the next idle pass retries it."** A quiet engine releases everything it holds; a working engine is never interrupted.
6. **What counts as activity for that clock, read at every site that writes it.** `last_activity_ms_` is written only by the load and run paths — `ensure_model_loaded_locked` (`parallel_runtime.cpp:755`), `run_model` (`:914`), `run_streaming_model_impl` (`:942`), `handle_batch_transcriptions_multipart` (`:1538`), `handle_generic_batch` (`:2188`). **A `GET /v1/models` catalog read and a `/health` probe do not reset it**, so this plugin's own catalog reads and health probes never keep a model resident — which is what makes an idle-unload measurement possible at all, and what a probe of it must respect: read once, after the window, not repeatedly during it. `unload_idle_models` restarts the clock only after it has actually unloaded something (`:2538-2542`), so it does not spin on attempts.
7. **Why the engine's default is off, stated as reasoning and not as opinion:** unloading costs a re-load on the next request, and for a server that serves one model continuously that cost buys nothing. It is the right default for a single-model server and the wrong one for an engine that hosts many models on demand — which is what these nodes are, and why the operator's ruling of 2026-11-15 ("we want it usually turned on by the agent and limit loaded models to 1 for ressources") is the pairing that fits this lane. **What the ruling changes on this fleet is the value, not the existence of the setting** — see `TODOS.md` part one item 44.
8. **What that pairing does for the file-update question.** With idle unload off, a model that has been loaded keeps serving the bytes it read at load time until it is evicted by some other model's load or the unit is restarted — so a file replaced on the shared store is invisible to that engine for as long as it stays resident. **With idle unload on, the memory is returned when the lane is quiet and the next request re-reads the current file.** It is not a notification mechanism; it is the removal of a stale hold, and it is the only one available without a verb this plugin does not have.
9. **The cost, measured the same morning on a CPU node with the small effects package:** cold load 2 294–3 421 ms against warm load 874–1 145 ms, generation 2.1–3.2 s of engine time per audio second warm, and a 5 s take carrying its sound with no silence left. So an idle unload costs **a few seconds on the first row after a quiet period**, more for a larger package, and the plugin records `elapsed_load` per row — which is how the cost is checked per model instead of guessed at. **A load that answers in a few hundred ms is the other case** (measured 2026-11-15 10:14, 397 ms at the engine for the same package right after a unit restart): the file is already in the page cache, and a mmap'd load costs little again. The cold figures above are the first read of a file the machine has not touched.
10. **Nothing in this plugin needs to change for it.** No part of the dispatch path asks whether a model is resident, the engine's "every loaded model is busy" answer is handled as a park (`AGENTS.md` 5.7), and `loaded_models` in a catalog read is a report. What does go stale is the plugin's cached read of what a slot holds, between reads — and it changes no decision the plugin makes.
11. **`POST /v1/models/unload` exists on the engine and this plugin does call it — the sentence this section carried here was wrong, and it is corrected in the section that follows this one.** `handle_model_unload` (`app/server/runtime.cpp:403-421`) answers 403 `dynamic model management is disabled` when `ui_management` is off, 404 `unknown model id: <id>` when the id is not registered, and otherwise takes the model's run lock, unloads it and answers `{"id":"…","loaded":false}`. Both node configs carry `ui_management: true`, and both units pass `--ui-management` on the ExecStart. The plugin's verbs are `load_model` and `unload_model` (`lib/index.js:23662-23675`, `loadUnload` at `:13829`, the URL built at `:13946`), and the panel's per-model `unload <model>` control reaches them (`lib/client.js:4297-4310`, `:18834`). **What this plugin had no verb for was the engine's "drop everything you hold"** — that gap was closed the same day by `T-867` (`unload_all_models`, `unloadAllModels` at `lib/index.js:13979`); the open half is now the value decision of item 44, not a missing verb.
12. **Named and not measured:** the engine also carries `--min-free-memory-mb` — "refuse a model load unless host **and** GPU each keep at least this many MiB free after the load; default 0 (guard disabled)" (`main.cpp:118-120`). It is the guard that would refuse a load instead of letting a machine fail, and **its GPU half has not been measured on a CPU-only node**, so it is recorded here and not proposed.
13. **State.** Applied on both units of one CPU node, staged on the other, and the ruled value is thirty minutes. On 2026-11-15 ~10:1x Berlin the tts unit of the second CPU node was changed from `3600000` to **`600000`** and restarted: `sudo systemctl daemon-reload` first, because **a drop-in edit is not read by systemd until the daemon reloads** — measured, the first restart left the old value in the live process cmdline and systemd said so ("The unit file, source configuration file or drop-ins … changed on disk. Run 'systemctl daemon-reload' to reload units"). After the reload and the second restart the live cmdline carries `--idle-unload-ms 600000`, `/health` answered `{"status":"ok","backend":"cpu","models":60,"ui":true,"ui_management":true,"git":"6b0260ec"}`, the stt unit of that node was left at 3600000, and no unit of the primary node was touched (the operator's word: delay the work there while downloads are in progress). A model was then loaded on that slot at 10:14:04 through the plugin's own verb (`{"ok":true,"loaded_after":["stable_audio_sfx"],"loaded_after_source":"engine","timings":{"ms_total":829,"ms_catalog":145,"ms_engine":397,"ms_refresh":286,"ms_plugin":431}}`) to start the idle clock, with **one** read scheduled 12 minutes later and nothing touching that engine in between (`scratch/probe_idle_node2_20261115.sh` → `scratch/idle_probe_20261115.log`). **Both halves of the proof landed, and they agree:** the unit's journal carries **`[server] idle 658166 ms: unloaded 1 model(s)` at 11:25:03 Berlin** — 658 s after that load, which is the 600 000 ms threshold plus the poll interval the loop is allowed to add — and the single scheduled read answered `loaded=False` for that model at 11:26:22. The measurement is only valid because of item 6: nothing touched that engine between the load and the read, and a catalog read would not have reset the clock anyway. Pre-change copy of the unit's drop-in, on the node: `audio-cpp-cpu.service.d/dynamic-models.conf.bak_20261115_pre_idle_600000`. **The fleet state, 2026-11-15 11:5x Berlin, after the operator set the value (verbatim: "3.1 i think 30 min is fine"): the value on this fleet is `--idle-unload-ms 1800000` — thirty minutes.** Both units of the second CPU node carry it in the cmdlines of their running processes, after their drop-ins were copied on the node (`dynamic-models.conf.bak_20261115_pre_idle_1800000`), `sudo systemctl daemon-reload`, and a restart of both; both answer `online:true http:200` through the plugin's own health verb and both catalogs read intact from the engine itself (60 rows on the tts side, 58 on the stt side, nothing resident on either). The `600000` above was the test value the proof was measured at, which is what made the timing legible; that unit now carries the fleet value like the rest. **Both units of the primary node are staged, not applied:** their drop-ins carry `1800000` and `daemon-reload` has been run there, and **neither unit was restarted**, because that node's model downloads were still writing files when this was checked (a 5.5 GB file with a modification time one minute before the check, fourteen model files written in the preceding two hours), so the running processes there still carry `3600000` and only the restart is outstanding, on the operator's word. **And the GPU node's two registered slots have no engine behind them at all** — no audio.cpp process, nothing listening on either audio port (both connections refused), no unit of any kind naming audio, read 2026-11-15 with `ps`, `ss -ltnp` and `systemctl list-units` on that machine; a registered slot and a running engine are different facts and this file had blurred them. What is running there is the LLM the operator's hold exists for. The open half is `TODOS.md` part one item 44.

 14. **The engine's package catalog is a read with a state, and it is not the engine's model list (measured 2026-11-15 ~23:1x Berlin, on both CPU-class slots).** `GET <engine>/v1/ui/models/package-sizes` answers `{data, message, state}`; a row carries `id`, `installed`, `size_bytes`, `version_state`, `local_revision`, `remote_revision`, `message`, a per-row `state`, `package{family, root, files, format}` and **`load_target{model_path, family, load_options, session_options}`** — the engine's own answer to "what file and what settings would this package load as". Both CPU-class slots answered **453 catalog packages, 84 installed**. **The two lists are different things:** that same engine's `/v1/models` listed **65**, and comparing them by the engine's own `load_target.model_path` against the engine's own listed `path` values gives **24 packages installed on the shared store and not listed by that engine — the same 24 on both nodes**, which is what one store under two unit configs looks like (the ids: `TODOS.md` item 56, list at `scratch/t870_gap_ids.txt`). **And "not ready" is a state of the read, never an empty catalog:** the CPU unit, minutes after its own unit restart, answered `state:"running"` / "Checking package sizes" with the same 453 rows carrying `state:"pending"`, `size_bytes:null` and `version_state:"unknown"`, and answered `state:"complete"` / "Package sizes are ready" a few minutes later; the other unit answered `complete` on the first ask. **A null size is not a zero size**, and a reader that treated the pending answer as an empty catalog would report zero installed packages on a healthy engine. The plugin's own read of this is `GET endpoint_library` and `libraryJoin641` (`library_state`, `retry_after_ms`), and what it publishes for the gap is `installed_not_configured` plus, since `CHANGELOG.md` T-870, `loadable_by_package_id`.
 15. **The engine's load verb takes a `package_id`, and when the field is empty nothing changes (read in the engine source 2026-11-15, on the build both CPU nodes run).** `POST /v1/models/load` is `handle_package_model_load` on a build with `AUDIOCPP_HAS_NATIVE_MODEL_MANAGER` (`app/server/runtime.cpp:442-465`, `app/server/parallel_runtime.cpp:495-519`): it reads `package_id` from the body and **when that field is empty it calls the ordinary `handle_model_load` unchanged**; when it is present the engine looks the package up in its own installer, answers `404 unknown package id` or `404 package is not installed` if it is not there, then resolves `path`, `family`, `load_options` and `session_options` from the package — **corrected 2026-11-16 by the live test at item 17: only `load_options` and `session_options` are merged with the caller's keys winning; `path` is set from the package unconditionally, and a caller-sent `family` must match the package's own or the request is refused 400** (`resolve_ui_package_model_load`, `app/server/server_ui.cpp:298-346`; the field gate `ui_model_load_package_id`, `:280-296`) — erases `package_id`, and hands the resolved body to the same load path. **What that means for a model an engine does not list:** it can be loaded by naming its package, with no node-config edit and no unit restart, and a composite model's component files come from the package rather than from anything this side guesses. **What was not proven live, said plainly because the sentence above would otherwise read as a measurement:** the one attempt made 2026-11-15 ~23:4x Berlin named a small installed-but-unlisted package and its `package_id` on a CPU slot and was answered by the engine's capacity guard in 11 ms (`cannot load model '…': max_loaded_models=1 and every loaded model is busy; retry later`) because a row of ours was running on that slot at that moment — the package-resolution half was never reached, so this item rests on the source and the catalog reads, not on that attempt. The same attempt caught the other case in the open, and reading it wrongly the first time is worth recording: the unload that would have freed the slot was refused with **`model '…' is busy: current inference has run 694 727 ms (busy_timeout_ms=300000); the previous request has likely wedged and cannot be cancelled`** — the `cannot be cancelled` form of AGENTS 5.7 item 7. **That run was not wedged.** It belonged to a row of ours that was running on that slot at that moment (`ap-1714`, an effects generator on the CPU slot, 706 604 B, and it ended `ok`), and the engine's own number says why it read as a wedge: `busy_timeout_ms` is **300 000**, while a long CPU generation ran **694 727 ms** and this plugin's own request wall is `job_timeout_sec 3600`. **So the engine's "likely wedged" sentence is a threshold, not an observation** — a run longer than five minutes is described as wedged while it is still producing, the per-model unload refuses it, and only the plugin's own wall knows the run is legitimate. Reading the row before calling a slot wedged is what turned a wrong reading into this sentence, and the row read is `job_status` / `queue_status`, not the engine's guess.
 16. **The spec JSON beside a model is not always what that model's handler enforces (measured 2026-11-15 ~23:4x Berlin, on three rows).** `model_specs/heartmula.json` on this host declares `tags` and `lyrics` both `required: false`, and the engine answered `HeartMuLa requires non-empty tags`; `model_specs/minimax_music3.json` declares `lyrics` **`required: true`** and the engine refused for want of it. A pre-dispatch check built on the specs' own `required` flags would catch the second case and give the first a **false clearance** — the runtime is stricter than the spec shipped beside it. The rows are `ap-1708`, `ap-1709`, `ap-1710` and the measurements sit on `TODOS.md` items 49 and 50.
  17. **A package-id load is proven on the engine, and the engine lists what it loads — as an unconfigured entry (measured 2026-11-16 ~00:3x–00:4x Berlin, live on a CPU speech slot, both through this plugin's verb and with this plugin out of the path; `CHANGELOG.md` T-870 / T-871).** Four things. **1. The load works and the engine resolves the package.** `POST <engine>/v1/models/load {"id":…,"package_id":…}` answered `{"id":"index_tts2_5_q8_0","loaded":true,"reconfigured":false}`; the same shape through `POST /api/deepamp/load_model` took 22 265 ms for a 3.5 GB package (engine leg 21 821 ms) and answered `load_via:"package_id"`, `model_listed_before_load:false`. **2. The engine's own model list gains the model.** That slot's `/v1/models` went **65 → 66 rows** and the new row reads `configured:false`; it is present at the first read after the load (+0 s, and again at +2 s and +5 s) and it is **still there after `models/unload`, with `loaded:false`**. So a package load does make a model listable by the engine — and this plugin's 64-name cap then drops it: the two names not stored on that slot are `kugelaudio` **and the model the load had just made listable**, with nothing on the answer saying a name was left out. That is why `TODOS.md` item 51 is now the blocker of item 56's auto-import half. **3. A body that names both `path` and `package_id` is refused.** `ui_model_load_package_id` (`app/server/server_ui.cpp:280-296`) answers 400 `send either path or package_id, not both`; `resolve_ui_package_model_load` (`:298-346`) sets `path` from the package unconditionally and refuses a caller-sent `family` that is not the package's. This was reached by a **second** load of the same model: the first had made the model listable, so the plugin's ordinary catalog copy of `path` came back into the body. **4. A package-id load is not a lane change.** A VAD package asked on the speech lane was refused in 167 ms with the engine's own sentence `FireRed VAD supports the VAD task` — the family's task gate is reached after the package resolves, so naming a package does not move a model between lanes. **Two reading rules come out of this and both are the reason the numbers above are safe to quote.** First: **this plugin's `model_listed_before_load` / `model_listed_after_load` are reads of the lane catalog** — `fetchModels(fn)` asks the **primary** engine — **not of the endpoint a named load talked to**; the answer names which one it read (`model_list_source`, since T-871) and `endpoint_models {fn, id}` is the read that answers the engine the call actually talked to. Second: **cite the engine's line numbers against the tree the nodes build from**, not against this host's checkout — the numbers in items 14–17 are of the engine tree at git HEAD `6b0260ec`, and this host's own checkout (`4efa3959`) contains none of those functions. The library answer on that slot, read fresh after the harness restart, published **10** loadable packages each carrying the engine's own `model_path` — that is the **directory**-scoped gap — beside the 453 / 84 / 24 file-scoped numbers at item 14; `TODOS.md` item 56 states both definitions and neither one corrects the other.
  18. **A load carries a task, the engine's default task is `tts`, and a family whose session wants another task refuses the load (read in the engine and measured live 2026-11-16 ~01:5x Berlin, on a CPU speech slot; `CHANGELOG.md` T-874).** `app/server/config.h:49-50` on the tree the node builds (git HEAD `6b0260ec`) is `std::string task = "tts"; std::string mode = "offline";` — those are what a load body that names no task lands on. The vocabulary is `src/framework/runtime/task_vocabulary.cpp:19`: `AudioGeneration` is spelled **`gen`** with the aliases `music`, `sfx`, `edit`, `audio_generation`. The gate sits in the model's own session constructor: `src/community_models/minimax_h3/session.cpp:83-85` throws **`MiniMax-H3 supports offline audio generation sessions`** when `task_.task != AudioGeneration || task_.mode != Offline`, and that "X supports … sessions" shape is how several families say the same thing (`index_tts2`, `higgs_audio_tts`, `voxtral_realtime`, `seed_vc`, `voxcpm2`). **What that costs this plugin, measured rather than inferred:** `load_model` with a `package_id` on a model the slot does not list was refused in **663 ms** with exactly that sentence (`ms_catalog 178`, `ms_engine 485`), because `loadBodyFor` (`lib/index.js:10556` onward) puts `task` and `mode` in the body only when the plugin has a catalog entry for that model — and a model the slot does not list has no entry, so the request arrives with no task and the engine's `tts` default answers for it. **The same package loaded on the engine directly, with the task named, loaded:** `POST <engine>/v1/models/load {"id":"minimax_h3_q4_k","package_id":"minimax_h3_q4_k","task":"gen","mode":"offline"}` answered `{"id":"minimax_h3_q4_k","loaded":true,"reconfigured":false}` in under a second, and that engine's `/v1/models` then carries the row as `configured:false, loaded:true, task:"gen", mode:"offline"` with `path` pointing at the package's own `dit.gguf`. **A load is not a read of the weights:** the server's resident set stayed at ~425 MB and the box's available memory did not move, so the 32.4 GB package is read at the first run, not at the load. **And the cap from item 17 is what stops the next step:** the same slot's engine list is 66 rows, this plugin stores 64 names for it, and the two it drops are the rows at **positions 64 and 65 of the engine's own order** — `kugelaudio` and the model the load had just made listable. A `dispatch_task {task_kind:"gen", model:…, endpoint_id:…, force:true}` against that slot was refused with "…is pinned but its own /v1/models catalog does not list model …" and **`force:true` did not reach it**: the override belongs to the capability bar, and this is the catalog-membership gate, which is a different gate. Two readings a session should keep from this: a package-id load is only half of making a model usable, because the session the family wants has to be named too; and a model the engine appends last is exactly the model this plugin's 64-name cap drops, every time. **SUPERSEDED IN PART THE SAME DAY, 2026-11-16 ~06:0x Berlin:** the bound that dropped those two names is **128** now — `CHANGELOG.md` T-875, on the operator-s ruling of that day, their words: "Raise the bound to 128". The measurements above are kept as what 64 did and are not restated as current behaviour. What the change does not touch is named there too: a catalog larger than the bound is still cut silently, and the shape of the fault — a bounded ANSWER being read as a capability bar — is unchanged by a bigger number (`TODOS.md` item 51 stays open for that half).

## Are these engines vanilla audio.cpp? (measured 2026-11-15 ~10:4x Berlin, on both CPU nodes, plus one live load/unload round trip on the second node)

The question the operator asked, verbatim: "are we sure the 'scan for new models' is something that is done by vanilla upstream audio.cpp (which is WAHT we should expect) or is it a function added by you previously, we might want to make sure our endpoints are 'vanilla audio.cpp' state first and not base our facts on modified versions!" This section is the answer to it, and it is the answer because it was measured, not because it was expected.

1. **Both engine checkouts are vanilla.** Primary node: `git rev-list --count origin/main..HEAD` → **0**, `HEAD..origin/main` → **0**, `git merge-base --is-ancestor HEAD origin/main` → yes, `git status --porcelain` → no lines. HEAD **is** the upstream tip `6b0260ec "Share MoE FFN and Gated DeltaNet graph construction (#1293)"`, `git describe` → `v0.9.5-7-g6b0260ec`, the remote is the configured upstream repository. Second node: HEAD `6b0260ec`, 0 ahead, and its only status entry is `?? run_build.sh` — an **untracked** helper script, no tracked file modified. **Nothing this project has done touched the engine, and no fact in this file is based on a modified engine.**
2. **The model scan and the WebUI model management are upstream code, not ours.** `app/server/model_installer.cpp` carries 7 commits in the upstream history, the first `9e085436 Mirek 2026-08-06 "WebUI - Initial native Svelte WebUI embedded inside audiocpp_server.exe (#185)"`, then `058d2be0 2026-08-09 "Improve native WebUI model management (#199)"`. The `models-root`, `install`, `install/stop`, `clean-partial`, `delete`, `install-status` and `package-sizes` verbs at `app/server/request_dispatch.h:81-105` are that same upstream feature. **The scan the operator was asking about is vanilla.**
3. **It is compiled in on both nodes.** `CMakeLists.txt:3628-3632` puts `model_installer.cpp`, the package-manager library and the define `AUDIOCPP_HAS_NATIVE_MODEL_MANAGER=1` behind `option(AUDIOCPP_BUILD_NATIVE_MODEL_MANAGER …)` (`CMakeLists.txt:149`), and `build/linux-cpu-release/CMakeFiles/audiocpp_server.dir/app/server/model_installer.cpp.o` exists in **both** build trees. In that build `POST /v1/models/load` reaches `handle_package_model_load` (`request_dispatch.h:64-68`, `app/server/runtime.cpp:442`): when the body names a **catalog package id** it is resolved through the package manager (`resolve_ui_package_model_load`) into a model-load body, and only then is `handle_model_load` called; with no package id it falls back to `handle_model_load`. **That is the vanilla form of "let the engine resolve the files from the model root", and `GET|POST /v1/ui/models-root` (`request_dispatch.h:81-85`) is the vanilla form of "point the engine at the share".**
4. **What vanilla detection is, and what it is not.** `directory_iterator` over `models_root` appears in the engine in exactly one place in the package manager — `src/framework/package_manager/manager.cpp:789`, inside `clean_partial`, which removes partial download directories — and `package_installed` (`:134-140`) is the catalog-listed-files test. **The vanilla mechanism is a catalog-to-disk match per package, on request; it is not a scan that registers loose model files it finds.** The other `directory_iterator` sites in the engine walk voice directories, embedding directories, sidecar roots, tool data and asset caches, not model files. So the operator's wish — "I would like the vanilla autodetection of the model files if pointed at the network share to be used" — has a real form in this build, and it is item 3: **a load that names a package id, plus a models root pointed at the share.** It is not a boot-time file scan, and item 41's plan has to be read against that.
5. **The unload verbs, both layers, measured live.** The engine side is item 11 of the section above. This plugin: `POST /api/deepamp/load_model` and `POST /api/deepamp/unload_model` (`lib/index.js:23662-23675`) call `loadUnload` (`:13829`), which posts `POST <engine>/v1/models/load|unload` (`:13946`, the path assembled from `'/v1/models/' + op`), refuses while a row is mid-way through a model on that endpoint (`:13916-13925`), and after the call re-reads the engine's own `/v1/models` and stamps `loaded_models` / `loaded_at` from the answer (`stampLoadedAfterOp490`, `:13793-13827`). The panel's control is the per-model `unload <model>` button in the endpoint row (`lib/client.js:4297-4310`) and its action maps to the `unload_model` route (`:18834`). **The round trip, run against the second node's tts slot with nothing else on that machine:** load answered `{"ok":true,"loaded_after":["stable_audio_sfx"],"loaded_after_source":"engine","timings":{"ms_total":1203,"ms_catalog":199,"ms_engine":513,"ms_refresh":491,"ms_plugin":690}}`; unload answered `{"ok":true,"loaded_after":[],"loaded_after_source":"engine","timings":{"ms_total":971,"ms_catalog":294,"ms_engine":174,"ms_refresh":503,"ms_plugin":797}}`; the same engine route called directly answered `{"id":"stable_audio_sfx","loaded":false}`. **Why an earlier pass said this plugin had no unload verb:** the search was for the literal `models/unload`, and the path in the code is assembled from two parts, so a literal search cannot find it. The lesson is a method one: a verb is found by reading the dispatch switch, not by grepping for the URL.
6. **What was genuinely missing, and it was small.** The engine has **`POST /v1/tasks/unload_models`** (a list of ids, `request_dispatch.h:148-149`, `app/server/runtime.cpp:2595`) and **`POST /v1/tasks/unload_all_models`** (`:151-152`, `app/server/parallel_runtime.cpp:2685-2703`), which walks every registered model, takes each busy lock — a model mid-inference is not dropped — and answers `{"unloaded":[ids]}`. **Nothing in this plugin reached either one**: `loadUnload` names one model and one engine, and the panel's control is per model. The operation "this engine, hold nothing" was one call on the engine's side and did not exist on ours. **CLOSED THE SAME DAY BY T-867.** Measured on the engine before anything was written: `POST /v1/tasks/unload_all_models` with an empty body answers `{"unloaded":[]}` on an engine that holds nothing, and it is reached from the dispatch switch with no `ui_management` gate around it (`request_dispatch.h:148-152` calls the handler directly), which is why the new verb does not consult the plugin's management-disabled memory. The list form was probed too: `{"ids":["…"]}` is refused with **"request requires a 'model_ids' string array"** — the key is `model_ids`, and `handle_unload_models` answers `{"unloaded":[…],"not_found":[…]}` (`parallel_runtime.cpp:2655-2680`); the new verb does not use it, because naming models is what `unload_model` already does. What exists now: `POST /api/deepamp/unload_all_models {fn, endpoint_id?}` (`unloadAllModels`, `lib/index.js:13979`), one `unload all` control in the panel's endpoint row (`lib/client.js:4314-4327`), and the same busy refusal as the per-model verb. Pinned by ten assertions in `tests/host.test.cjs` under `T-867` and by the method contract in `tests/verb_contract.test.cjs`.
7. **And one measured staleness, because it decides whether the control is even offered.** Before that round trip, this plugin's own read of the second node said `loaded_models: []` while the engine had `stable_audio_sfx` resident — the load answered in 513 ms, which is a model already mapped, not a cold load. `loaded_models` / `loaded_at` are written only by `endpoint_models` and by `stampLoadedAfterOp490`, and the panel builds the unload control from exactly those fields (`lib/client.js:4285-4310`), so **the control appears only after a fresh read of that engine**; a row whose read is old carries no unload control and says so in its hover. That is the design the panel already documents. Naming it here is what keeps a later session from reading it as a bug, and it is the third open half of item 45.
8. **State.** Read, plus one load and one unload on an idle slot, which left that node holding nothing. Then, on the same day and at the operator's "go for 2 - implement now", **the gap of item 6 was closed in code** (`T-867`: the host verb, the panel control, ten assertions in `tests/host.test.cjs` and the re-cut of the `T-653` stamp contract that the new call site moved). No node config was touched for that part and no unit was restarted for it; the host half needs a harness restart to go live, which the operator took on themselves. The idle-unload value of the section above was applied on one unit of this same node the same morning.

## What the GPU node cannot run, answered by the engine's own allocator: the big music package needs a 14.87 GiB graph buffer against a 7.98 GiB device (measured 2026-11-16 ~12:2x-14:0x Berlin, on the held GPU node's Vulkan lane; item 11 is the same package on a CPU node, at the operator's word)

The question the operator asked, verbatim: "do you think the GPU node would be able to handle the model?" and then, on their own numbers: "we have 8GB VRAM + 28GB or so GTT - make it a test run for the larger models on vulkan … if the remote node wedges, let me know for a reboot". This section is the measured answer, and it is a NO with a size attached to it.

1. **The device, read twice, agreeing.** The engine's own start-up line: `ggml_vulkan: 0 = AMD Radeon RX 5700 (RADV NAVI10) (radv) | uma: 0 | fp16: 1 | bf16: 0 | warp size: 32 | shared memory: 65536 | int dot: 0 | matrix cores: none`. The card's own sysfs at the same minute: `mem_info_vram_total = 8 573 157 376` (**7.98 GiB**), `mem_info_vis_vram_used = 254 636 032` — so the *dedicated* slice in use was 243 MB and everything else the GPU held was in the **GTT aperture, i.e. system RAM mapped for device use**. The machine: 4 cores, 28 GB total RAM. `uma: 0` says what that means: this is not a unified-memory part, the system-memory aperture is a mapping, not a shared pool.
2. **The package, read from the engine's own package manifest, not from a name:** `dit.gguf` 15 502 530 720 B, `text_encoder_q4_k.gguf` 15 270 376 000 B, `video_vae.gguf` 1 374 245 472 B, `audio_vae_folded_f16.gguf` 284 562 816 B — **32 401 364 480 B ≈ 30.2 GiB of weights**, in four files, the two largest 14.4 GiB and 14.2 GiB. A music render needs the text encoder, the DiT and the audio VAE, so the working set is not a slice of that.
3. **The load was never the problem, on either machine.** Naming the model id and the package id together on the engine's own load verb, with the task and mode named, answered `{"loaded":true,"reconfigured":false}` in **1.28 s** on the GPU node (and 1.2 s on the CPU node). That is the `T-870`/`T-871` shape working exactly as designed: the engine resolves the files and the family from its own package, and the load is a registration, not a mapping.
4. **What happened after it, in order, with the numbers.** The request was accepted and the engine began building. Its device counters went to `mem_info_vram_used 8 304 783 360` (**96.9 % of 7.98 GiB**) and `mem_info_gtt_used 8 796 520 448` (**8.19 GiB of system RAM mapped as device memory**) — 17.1 GB of GPU-visible memory held, while the server process itself sat at 90–390 MB of RSS. That state held for about five minutes. Then the request answered, at **335.4 s**, `http 500`, 85 bytes: `{"error":{"message":"failed to allocate MiniMax-H3 DiT graph","type":"server_error"}}`. The engine's three journal lines at that second are the whole answer:
   `ggml_vulkan: Device memory allocation of size 4 325 916 672 failed.`
   `ggml_vulkan: Requested buffer size exceeds device buffer size limit: ErrorOutOfDeviceMemory`
   `ggml_gallocr_reserve_n_impl: failed to allocate Vulkan0 buffer of size 14 871 241 728`
5. **The decisive point, and it is not about weights.** The failure is in `ggml_gallocr_reserve_n_impl` — the **compute graph allocator**, reserving the buffer set the DiT's graph needs at run time: **14 871 241 728 B (13.85 GiB) as one graph, of which a single 4.33 GB buffer could not be placed**. Weights in a package can be streamed, quantised or paged; a compute graph is a single contiguous reservation for activations and scratch, and it is sized by the model's shape, not by how much of it fits. **So the ceiling this model meets is not "8 GiB of weights in an 8 GiB card" — it is a 13.85 GiB graph on a 7.98 GiB device, and the GTT was already being used (8.19 GiB of it) when the reservation failed.** No placement knob and no host-memory preference changes that arithmetic; the earlier four-variant experiment of 2026-10-26 (this file, and the `T-650` items 24-35 record) already showed each of them ending in a device loss while host RAM stayed at 28.79-28.93 GB available.
6. **It did not wedge, and that is worth saying plainly because the operator asked to be told if it did.** The engine answered its own error, in 335 s, and released what it held: within 20 s the card read `mem_info_vram_used 16 056 320`, the unit stayed `active`, `/health` kept answering. **No reboot was needed and none was taken.** Contrast the other two shapes this file carries: the 2026-10-26 GPU presses ended in `vk::Queue::submit: ErrorDeviceLost` with the card still holding 8.53 GB of VRAM and 6.84 GB of GTT while the process RSS was 449 MB — that is a wedge, and only a unit restart clears it; and the CPU path of the same model **never answered at all** (a 30 s take cut by the caller at 7 200 s with 0 bytes, the engine still generating hours later). **The GPU path fails loudly, in minutes, with a size attached; the CPU path fails silently and indefinitely.** A session deciding where to send an over-large model should read that asymmetry as the useful half of this section.
7. **The other refusal in the same run, and it has nothing to do with memory.** The same node, the 12.6 GiB music package (13 527 605 600 B across five files, largest `language_model_q8_0` 9 889 350 208 B): loaded in **1.07 s**, then the render refused in **0.010 s** with `{"error":{"message":"MiniMax Music 3 requires lyrics","type":"server_error"}}`. Read in the engine: `src/community_models/minimax_music3/session.cpp` — `:273` takes the option `lyrics`, `:276-277` throws when it is empty, and `:158` declares the parameter `{"lyrics", "string", "Lyrics to sing.", true}` with the fourth field the required flag. **So the first press was not a GPU answer at all: it was a malformed request, and the package was never tested by it.** It was re-pressed minutes later with the option carried, and **that one worked**: `http 200` in **212.84 s**, 880 684 bytes, a real `RIFF/WAVE` — 4.99 s of audio, 2 channels at 44 100 Hz, 16-bit. Peak `mem_info_vram_used 8 560 594 944` (**7.97 GiB of the 7.98 GiB card — the device was completely full**) with peak `mem_info_gtt_used 3 117 334 528` (2.9 GiB), the unit `active` throughout, no error line, no lost context, nothing left resident after it. **42.7 s of generation for one second of audio**, against the 2026-10-26 measurement of the small effects family on this same card at ~4.4 s per second — an order of magnitude apart, and both usable.
8. **This plugin does know the required option, and neither of its doors asks for it.** The capability record, read live from the running plugin on both tts slots, source `model_params`, carries it in full: `{"name":"lyrics","type":"string","required":true,"description":"Lyrics to sing. Structure tags such as [verse] and [chorus] are supported."}` — so `speechOptionsGate` passes it through and a person can set it on the panel's Advanced (Options) board, which offers exactly the names the record declares. What does not carry it: `audio_render`'s `generate` kind builds `options` with `duration_seconds` only (`tools/index.js:204`), so **an agent cannot send a required family option through the tool half at all**, and nothing in the plugin's own preset library carries lyrics (the music presets are style prompts; a grep for the word across the store's texts answers nothing). Consequence as it stands today: a render on that family is reachable through the panel's Advanced board or a direct verb call, and not through the tools. That is `TODOS.md` **item 64**, and the shape of it is a refusal this plugin could make before a row exists — `required:true` is known capability, which is exactly what the capability bar is for (`AGENTS.md` 5.9).
9. **What this section does not say.** It does not say the GPU node cannot run music: the 2026-10-26 record has `stable_audio_medium` at 120.0 s answered `ok` there, and the small effects packages at 6-8 s with peak VRAM 3.3 GB and no lost context. It does not say a mid-sized music package cannot run there — **it does, measured the same hour: the 12.6 GiB one rendered 4.99 s of real audio in 212.84 s with the card full at 7.97 GiB and 2.9 GiB in the system-memory aperture, and no wedge** (item 7). What it says is that **this** package, at this graph size, is not a candidate for a 7.98 GiB device with a system-memory aperture, and that the number to compare against is the graph reservation, not the file sizes. The engine's own guard wording from 2026-10-26 said the same ceiling in its own words — "exceeds available vulkan memory (7.99 GiB)" — and today's sysfs total agrees with it 7 weeks later, which is why this section can be quoted instead of re-measured.
10. **State.** Measured on the held GPU node after the operator rebooted it and asked for its units to be started and its build verified (both are the same engine commit the CPU nodes run; `TODOS.md` item 39 carries that read). The two slots stayed held and the plugin's lane placed nothing there — every call in this section went to the engine directly. The unit was not restarted by this side, the node was not rebooted by this side, and the engine ended the run holding nothing.

    **The same package through the plugin lane, an hour and a half later, at the operator-s word (14:40-14:53 Berlin).** Asked which node should carry the 60-second take item 55 had been holding, the operator chose this one ("Run it on the GPU node instead") and, on the slots, "currently they can be used for testing" — so the speech slot was put back in play with `endpoint_resume` (its unit was already up and idle) and one row was pinned to it. Row `ap-1718` carried `options: {duration_seconds: "60", lyrics: <108 characters>}`, was placed on that slot with `endpoint_pinned: true`, loaded the package in **2.56 s**, and answered at **376.7 s**: `status: error`, `curl exit 22: failed to allocate MiniMax-H3 DiT graph`, 0 bytes, 0 duration. **Two things follow, and only those two.** (i) The graph wall of item 4 is not an artefact of calling the engine by hand: the same reservation failure is reached through this plugin-s own dispatch path, in the same order (load accepted, run refused), at the same wall — 335.4 s direct against 376.7 s through the lane. (ii) The lane half of a Vulkan slot now has one measured row on it: placement, a pin that did not fall back, the option carry (the 60 s ask and a 108-character lyric both reached the engine), the load cost, and an engine error captured on the row rather than lost. What is still untested on that slot is a successful render through the lane, not a failed one, and the transcription slot stayed held.
11. **The CPU half of the same question, measured at the operator's word, and it is the worse of the two shapes.** The ruling that produced it was about the CPU unit: "Restart it, then a 5 s and 10 s probe" — asked for because the unit was in use, and given. One CPU node, one engine, the **same 32 401 364 480 B package** the GPU node could not build (`minimax_h3_q4_k`), the same real preset prompt this lane has run before, nothing synthetic. Load by package id with the task named: `http 200` in **1.200739 s**, `{"loaded":true,"reconfigured":false}` — and the engine's own model count went from **65 to 66** across that call, which is the `T-875` item 18 shape seen a second time from the engine's own health answer. Then:
    1. **The 5-second request never answered.** `duration_seconds:"5"`, `seed:"42"`, the client allowed 7 200 s of its own: `http 000` at **7200.002042 s**, **0 bytes downloaded** — no HTTP status was ever returned, because no response was ever written. At that same moment the engine's process read **RSS 25 522 764 KB (24.3 GB resident), 393 % CPU, process elapsed 02:00:04**. Read again 88 s later it read **393 % CPU, 02:01:32** — still working. **A take of five seconds of audio had been generating for two hours on four cores and had produced nothing**, with no error line, no refusal, no exception, and nothing written to the store.
    2. **The 10-second press, asked one second after the first expired, was refused in 10 ms.** `http 503` at **0.010541 s**, 203 bytes: `{"error":{"message":"model 'minimax_h3_q4_k' is busy: current in…`. That is the engine-slot capacity answer this file already describes ("The engine-slot park") — a park, not a failure — and here it is the *evidence* that the first request was still holding the model slot two hours on. It is also the only answer the CPU path gave.
    3. **The machine was not out of memory, and that is what makes this a different fault from the GPU one.** `free` on that node at the same minute showed the machine nowhere near its limit. Nothing was denied. The work was accepted, the model was resident, the cores were busy, and the request simply had no bound inside the engine. The GPU path, on the same package, answered in **335.4 s** with a size attached and released what it held; the CPU path has no such point.
    4. **What a session should take from the pair.** Two ways a lane can fail an over-large model, and they are not equally survivable. The loud one costs five minutes and names the number to compare against. The quiet one costs hours of a machine, holds its RAM and its cores, parks every other request that wants that model, and is invisible until someone looks at `ps`. Item 6's sentence — the CPU path fails silently and indefinitely — is now measured at both ends: the 30 s take cut by the caller at 7 200 s with 0 bytes, and a 5 s take still generating two hours after it was asked for.
    5. **State, and what is still open on it.** Script `scratch/t877_probe.sh`, log `scratch/t877_probe.log`, the 203-byte 503 body kept as `scratch/t877_probe_s10.wav` (it is an error body, not audio, and it is named here so nobody mistakes the file for a take). As of 14:09 Berlin that unit is **still mid-generation** on the abandoned request: 24.3 GB resident, 393 % CPU, both CPU units `active`, `/health` answering `git 6b0260ec`. A unit restart would clear it, and `unload all` would not — the engine never unloads a model that is mid-inference — so it is the operator's call, asked for and not taken: the unit is in use, and this side has no work it wants back from that model. **Updated the same day at 14:2x Berlin, and the answer to the first half of the question put then is no.** The operator's word was, verbatim: "if node cpu1 is wedged, let me know and i can reboot it , otherwise restart audio.cpp as needed!" - and that node was **not** wedged: ssh answers at once, `up 8 days 15:08`, load average steady at 4.4 with 393 % of it being this one process, swap 0 used of 4, 32 GB available, `dmesg` carries nothing from this day (its newest entries are ceph workqueue notices and an apparmor denial from 2026-11-15), and both CPU units read `active`. No machine reboot was asked for; the unit was restarted under the standing permission of `AGENTS.md` 5.12, which is what that sentence gave.
 6. **The restart, measured, and what it freed.** the privileged restart form (`sudo systemctl restart audio-cpp-cpu`) on that node at **14:23:47**, unit `active` one second later, journal a clean start (`audiocpp_server listening on http://0.0.0.0:8963`, models root re-set to the shared store). **Before it, the engine was not wedged in the sense `AGENTS.md` 5.12 means:** `/health` answered `{"status":"ok","backend":"cpu","models":66,"git":"6b0260ec"}` and `/v1/models` answered normally **while the runaway inference was running** - the fault was one request with no bound inside the engine, not a lost device context, and a reboot of the machine would have bought nothing. What the restart cost, stated exactly: the abandoned 5-second request (2 h 16 min old by then, nothing written from it) and the loaded package. What it returned: `/health` answers **`models:65`** - the package is gone and the count is back to the pre-load number this item opened with - the new process reads **RSS 13 MB, 0.6 % CPU**, and that node went from most of its memory held to nearly all of it released, which is the 24.3 GB the request held, given back to the machine. The plugin's own reads were re-taken before anything was dispatched against that slot: `endpoint_health` `online:true, http:200`, `endpoint_models` `loaded_models:[]`, engine build `dev 6b0260ec` unchanged. **What that closes and what it does not:** it closes the held memory and the parked model slot; it closes nothing about the fault, which is that a CPU generation of this package carries no bound and no progress signal inside the engine - `journalctl` on this build shows no per-step inference line, so the `ps` counters are the only progress signal there is - and the same request shape asked again will do the same thing until something bounds it. **One distinction this record has to carry, because the probe did not go through the plugin:** every engine call site in `lib/index.js` hands that request a wall (`job_timeout_sec`, default 3 600 s, under the executor cap of `TODOS.md` part one item 63), so a row dispatched through this plugin would have had its HTTP call cut at that wall - and the engine would have gone on generating, because it does not cancel a running task when the client goes away (the `cannot be cancelled` answer of the section "The engine-slot park"). The probe called the engine directly with a client of its own at 7 200 s, which is the only reason it got to see the unbounded shape whole. Either way, the model slot stays held until the generation ends or the unit is restarted - which is what the 503 at sub-item 2 was telling us.

## Where the waveform read stops being exact: the bucket line, the stride line, and which one binds (T-820 / T-821 arithmetic, moved here from `TODOS.md` item 16 at the operator's word of 2026-11-17) — do not re-derive

1. **The two numbers the panel and the host hold.** The panel asks `wave_peaks` with `SCOPE_PEAKS_SLICES793 = 4000` buckets over the whole take (`lib/client.js`, raised from 2 000 by T-821 at the operator's card answer "Raise the panel's ask to 4000"); the host's ceiling is `PEAKS_SLICES_MAX = 4000` (`lib/index.js`) and the cross-half claim is pinned by `tests/verb_contract.test.cjs` — the panel's ask and the host's ceiling are read against each other and the check fails if either side moves. The sliding strip draws `fit = floor((W + gap) / (minBar + gap))` bars with `minBar = 2`, `gap = 1`; the measured bar count is **68**, not the early 65 estimate (T-820, `tests/scope.test.cjs` fixture rows).

2. **The bucket line, in one line:** a bar has its own measurement while `take length <= ask x window / (bars x 1000)`. At the ask of 4 000 and 68 bars the divisor is 17: **353 s at the 6 s window, 176 s at 3 s, 88 s at 1.5 s, 44 s at 0.75 s**. Past that line bars share buckets again — the coarse picture. (At the old ask of 2 000 every one of those lengths was half; the 2026-11-12 numbers of T-803 — 185 s / 92 s at its 65-bar estimate — are kept as history, superseded by the measured 68 and the raised ask.)

3. **A second line, independent of the ask.** The host analyses at most `PEAKS_MAX_SAMPLES = 4 000 000` samples per call and strides anything longer (`stride = ceil(samples / 4 000 000)`, the answer carries `sampled:true` and says so in its own `note`). At 48 kHz mono that line is **about 83 s**.

4. **Which line binds, by window:** for the WIDE windows the stride binds first — the 6 s window's 353 s bucket line is only reachable up to ~83 s, past which every second sample is read; for the NARROW windows the bucket line binds first (44 s and 88 s are both under 83 s). The strided behaviour itself is pinned in `tests/host.test.cjs` (a 4 200 000-sample read answers `sampled:true, stride:2`).

5. **Status of this record:** it was a MEASURE line printed by the suites and a paragraph on `TODOS.md` item 16; the operator's word of 2026-11-17 ("Move it to FACTS now") moved it here and closed that item. No code changed; the arithmetic is unchanged from what the suites print.

## An option value's shape is read from the record that declares the parameter (T-885, built and green 2026-11-17) — cite this instead of re-deriving it

1. **What is decided, and by whom.** Since T-885 the question "can this plugin put this value on the wire for this
   parameter?" is answered from the capability record of the endpoint the row was placed on, through one function
   (`optionValueVerdict885`, `lib/index.js`). A parameter the record declares: an enumerated one takes only its listed
   values, a switch its yes/no words, a number the `minimum`/`maximum` the record states, a string any text up to
   `OPTION_LONG_TEXT_MAX = 4000` characters or the record's own smaller `maximum` — line breaks, brackets and
   apostrophes included, control characters other than tab/LF/CR refused. A record may tighten that ceiling, never lift
   it. A parameter no record names keeps this plugin's own grammar (a number, or 120 characters of `[A-Za-z0-9._:,%\- ]`)
   and the wording T-868 pinned for it; a cold capability cache is a no-answer, not a refusal (AGENTS 5.9).
2. **The projection fact, found by the first run of the new assertions and worth knowing before anyone re-derives it.**
   The capability reader kept six keys for a family's `options.request` entries (`CAP_REQ_KEYS`, `lib/index.js:8221` as of this card),
   and none of them was a bound — so an engine page that says `{"name":"ensemble_takes","type":"int","min":1,"max":16}`
   reached this plugin's own record with no 16 in it. Since T-885 both halves carry both spellings: the engine spells its
   request bounds `min`/`max`, the UI-params half spells them `minimum`/`maximum`, and `optionSpecOf` reads either. What
   the widening does **not** reach is the panel: `lib/client.js` draws no range out of that projection, checked while
   writing the card.
3. **The speech lane's own gate is a different rule and was deliberately left alone.** `speechOptionsGate` enforces
   `OPTION_TEXT_RE` (240 characters, no line breaks) for the voice lane; no measured case asked for it to change, and
   that door's fail-closed rules are its own. A session that sees two different value rules on two lanes is looking at
   two lanes, not at an inconsistency.
4. **One question, asked once — and why that is the shape.** Three doors used to keep a copy of the grammar each: the
   cleaner (`cleanOptions`), the note door (`optionValueShapeNotes`), and the bar's own drop-preview inside
   `requiredOptionRefusal777`. The third is how the item-57 fault got worse than it looked: the bar predicted a drop
   using its own copy, so a value the cleaner would have carried could still be refused as uncarryable. All three call
   the one function now, and the refusal text states the rule the value broke rather than reciting one sentence for every
   family.


## A custom-voice checkpoint has no no-voice shape: the built-in speaker path IS the path (recorded 2026-11-26 Berlin; closes `TODOS.md` part one item 72 at the operator's word)

Measured 2026-11-19 on each CPU node (`ap-1782`, `ap-1783`) and re-measured 2026-11-23 after that node's engine update. The checkpoint is listed and loadable, and it renders **with a speaker name**: `GET voice_modes?fn=tts&model=<that model>` answers `known:true` and names **nine** built-in speakers taken from that model's own published record — the model-level harvest `CHANGELOG.md` T-782 added. Sent as a clone, the engine answered `500 … custom voice prefill requires speaker`; sent with no voice, this plugin's own door refused before a row existed, because that door had read only the **family** record, which names no built-in speaker for the family. `CHANGELOG.md` T-918 made the door read the same two sources the voice-mode read already read, and the render followed: load 21 401 ms, a take of 357 164 bytes, `voice_mode: preset_speaker` (`ap-1922`, 2026-11-23).

**What is recorded here instead of left as an open question:** that model has no no-voice shape at all, and never had one. A take on it is a speaker-name request; `no_voice` is not a mode it can serve, and a session that reads a `no_voice` offer for it is reading a stale answer about its family rather than the model's own record. Nothing was built for this line beyond T-918 — the panel and the door already answer from the record — and the operator's word on 2026-11-26, asked whether to change what the panel offers, was to record it and close it. **A second consequence the same reading carries, stated so it is not rediscovered:** a built-in speaker list taken from a **family** record is the union of that family's checkpoints, not the set one checkpoint takes — the scope of a list is now stated on the answers that hand one out (`CHANGELOG.md` T-928, `TODOS.md` part one item 105).


## The harness architecture cross-reference: what this package follows and what it does not (read 2026-11-26 Berlin; `TODOS.md` part one item 111, closed by this section)

**Method, stated so the pass can be redone.** The reference was read from the running installation, not from memory: the `dsh-doc` skill's own reference set (`@deepseek-ai/dsh-agent-preset/skills/dsh-doc/references/`: `practices.md`, `host-plugin.md`, `ui-plugin.md`, `configuration.md`, `tool-design.md`), the installed package READMEs the contracts live in (`dsh-client-modules`, `dsh-host-webserver`, `dsh-bash-local`), and — at the operator's word of 2026-11-26 ("fetch architecture") — the upstream `docs/architecture.md`, kept as a dated copy at `scratch/architecture_upstream_20261126.md` (19 135 bytes, ten sections; it is a map of the harness, not a document about plugins). Our side was read from `tools/index.js`, `lib/index.js`, `lib/client.js`, `package.json`, `cordis.patch.yml`, and live runtime inspection (`Config.listConfigs`, `endpoint_registry`, `voice_modes`). Only the disagreements are kept below. **No code was changed by this pass and no upstream report was written** (the workspace rule of 2026-11-10 stands).

### Mismatches — a documented mechanism the document names and this package does not use

1. **The route owner's request policy — none, measured.** `@deepseek-ai/dsh-host-webserver/README.md:132`: "**No server-wide authentication or origin policy** — route owners such as `dsh-client-connection` enforce their own request policy." Our route owner enforces nothing: a grep for any origin, peer-address or token check across the whole of `lib/index.js` returns only the comment that the panel calls same-origin. Every DEEPAMP verb, the file-serving prefix route, and the store reads are open to anything that can reach the harness HTTP port; today that port is loopback, so nothing is exposed, and `import_outside_store` widens what a body may name. This is the one finding with a real consequence, and it is the operator's call, not a quiet fix. Filed as `TODOS.md` part one item 117. **DECIDED AND BUILT 2026-11-26 (`CHANGELOG.md` T-931), at the operator-s choice, verbatim: "Origin rule only - no script breaks".** What the reading also corrected: the harness-s own seam is callable — `ctx.connection.requestRejection(request)` applies Connection-s Host/Origin checks **and browser authentication** to another Web route (401/403/undefined), `admit(request)` returns the signed-in Peer, and `allowsRemoteAuthorities` reads the deployment-s `trustedHosts`. Calling it would have asked every script and hand-run curl for the per-process launch token (`DSH_WEB_URL` carries none), so this lane takes the narrower policy instead: a request that carries an `Origin` must carry the authority the request was addressed to (default ports normalised); a caller with no `Origin` is untouched; the audio prefix `/deepamp` stays open. Seven pins in `tests/host.test.cjs` hold it, including that a foreign write is refused before its body is read. **This is not authentication** — a local program can still drive the lane, and that is the accepted shape while the port is loopback.
2. **Theme tokens — zero uses, measured.** `references/practices.md:34`: "Style with the theme tokens (`--dsw-alias-*`) that `cordis_inspect_query` `Theme` lists … literal colors are for artwork only." `lib/client.js` contains **0** references to `--dsw-alias-` and **495** literal hex colours. The panel is therefore a dark island in a light host page, and it does not follow the host's light/dark switch. This is the documented authority behind `TODOS.md` part two's colour items 14 and 43 — they were filed as "re-usage"; the cross-reference says what they should re-use. Filed as item 118.
3. **The Client locale service — not used for panel text.** `references/ui-plugin.md:13`: "Route visible UI text through the Client locale service." Every word the panel shows is a literal in `lib/client.js`; there is no locale path for UI strings. `tools/locale/en.json` covers only the display metadata of the tool row, which is the form the same documents ask for there. Filed as part of item 119.
4. **Display metadata for the host row — falls back, measured against the documented fallback.** `references/host-plugin.md:31-37,52`: Plugin Manager reads `meta.title` / `meta.description` from an exported `locale/*.json`, and "missing fields of a package-root plugin fall back to `package.json` `name` and `description`". This package has **no root `locale/`**, so the `deepamp-host` inventory entry shows the raw scoped name and the package.json sentence — legal, and not what the checklist asks. The **tool row is correct**: the same document says a subpath plugin "never reads a `package.json`; it exports `./search/locale/*.json` and `./search/icon` instead", and this package exports exactly `./tools/locale/en.json` and `./tools/icon` (verified in `package.json`). Filed as item 119.
5. **No detail document, so the bundle page is the README.** `references/host-plugin.md:34`: the page "shows the detail document that `meta.detail` names, otherwise the package README." We name none and ship no `docs/DETAIL.md` / `docs/preview.svg`, so Plugin Manager renders README.md — and README is the operator's own file, verified by them before it is written (their ruling of 2026-11-26, item 115). So this is a **decision waiting for the operator**, not a gap to fill here. Part of item 119.
6. **`files` is unset.** `references/host-plugin.md:36` asks that the patch, locales, the detail directory, the icon and every runtime file be listed in `files`. This package declares none. The same document states the consequence precisely: "`files` does not filter a linked directory" — so for a `link:` install as this one runs, the omission is inert; it bites only if the package is ever packed or published, which is the release-mechanics decision already deferred on `TODOS.md` part one item 13. No new item; this line records that the deferral has a documented cost.
7. **Configuration writes use our own channel, not the config editor.** `references/configuration.md:3-12`: plugin code "never persists configuration by reading, filtering, and rewriting the active profile's `cordis.patch.yml`"; to change its own configuration after `apply` returns, a plugin uses `ctx.get('configEditor')` and `editor.edit(entry, …)`, and "a field declared `.volatile()` updates in place". We never touch `configEditor` (a grep across `lib/` and `tools/` finds no use), and no Config field is declared `.volatile()`. Every user-facing switch (`limit_one_per_host`, `prefer_primary`, `stt_feed`, `takes_limit`, `job_timeout`, …) goes to the plugin's own state file under the store root, with the precedence `environment > declared Config > state file > built-in default` that `AGENTS.md` §6 states as a rule. The documented reason not to use the editor for these — "editing an ordinary field restarts the plugin so `apply` rebuilds its state" — is exactly the cost our design avoids, and `.volatile()` is the half that would make the documented mechanism usable here. Recorded, not changed; a move is a decision for the operator. Filed as item 120 (ask, do not act).
8. **Plugin-owned data lives in a file we wrote, not a storage service.** `references/practices.md:21`: "keep plugin-owned data in a storage service found through inspection." The state file is hand-rolled (a temp file plus rename under the store root). Nothing in the documents forbids this, and the file is the plugin's own contract with itself; recorded so a later pass knows it is a deviation and not an oversight.
9. **Tool descriptions state enforcement, and their size has never been measured.** `references/tool-design.md:11`: "Describe behavior, not implementation… omit internal mechanisms… and enforcement details." Ours do carry enforcement sentences ("refused before anything is queued", "a pin is evaluated alone and never falls back"), deliberately: a refusal that happens before a row exists is otherwise invisible to the caller. Measured at the same document's item 14 ("measure the change") — **and the first measurement of it was wrong, corrected the same day**: a source scan that summed description literals inside a fixed window after each tool name double-counted the next tool's parameters and printed 8 649. The number that is real is the schema an agent is actually handed, read from `Tool.listTools` on the live host: **`audio_render` 5 105 bytes, `audio_status` 1 419, `audio_voices` 1 606, `audio_control` 1 418 — 9 548 bytes, which is 21.0 % of the 45 487 bytes of tool schemas that agent carries (43 tools)**. Re-measured after the 2026-11-26 restart, with the trim in: **8 526 bytes, 19.2 % of 44 465 — the wording pass is -1 022 bytes (-10.7 % of the four)**. Re-measured again after the T-933 clause fix (the same evening): **8 529 bytes — `audio_render` 4 086, the other three unchanged — 19.2 % of 44 468**. The +3 bytes is that one corrected sentence; the number is quoted from the live schema read, never from source. Two of this package-s own attempts to measure this from the source were wrong (8 649, then an estimated -362): a scan of source string literals both overlaps into the next tool and under-counts concatenated multi-line descriptions. **The only method that answers is the schema the host is actually handed - `Tool.listTools` - and any future number for this must come from there.** A first-turn token comparison has still never been run for a tool-definition change in this package. The scoped prompt section was measured beside it: ~1.5 kB in three paragraphs, and it does **not** restate the tool rules, which is what `tool-design.md:13` asks for — that half is in order. Filed as item 121 (measure before editing; the wording half is the operator's call).
10. **A wording correction to an older record of ours, found by the same reading.** `AGENTS.md` §6 and the T-912 card say the plugin cannot know the shell executor's wall. The harness documents it: `@deepseek-ai/dsh-bash-local/README.md:46` states the **default `maxTimeoutMs` is 600 000 ms**, and `:65` states the exact escape T-912 built on — "Resolve with `onExpiry: 'none'` and await `execute` to run a command in the background; no deadline is armed." So: the *documented default* is knowable, the *effective per-profile value* is not (this profile's overlay raises it), and the shape T-912 uses is the documented one, not folklore. **And the reading found a real fault in our own code, not just a wording one:** `YTDLP_DOWNLOAD_TIMEOUT_MS = 900000` is above that documented clamp, and T-912 exempted only engine requests — so a long capture on a profile that had not raised `maxTimeoutMs` was cut at 600 s by a wall this lane never set. Built 2026-11-26 (T-930): the download leg now runs with no executor deadline and this plugin's own wall at the 900 s asked for, the abort names the capture wall, and a source assertion refuses any host-half call that asks 600 000 ms or more without going through that helper. Item 63's caveat stays true on its own terms.

### Verified agreements — kept short, so the pass is auditable and nothing above is read as a general complaint

1. The export form is the documented one: `export { apply, inject }` plus `export const Config`, no service class mixed in (`host-plugin.md:62`), and the live Config is projected through the documented inspection path — `Config.listConfigs {name:"@mepaw/deepamp-audio"}` answers one entry, `deepamp-host`, status `schema`.
2. `engines.dsh: ">=0.2.2-rc.1"` and a `@deepseek-ai/cordis` peer are declared — the gate `plugin_manager` uses is in place.
3. The browser half is the documented bundle-client form: `dsh.client {platform:"web"}` plus a `./client` export, the module registering through `window.__ModuleLoader__`, exactly what `dsh-client-modules/README.md:34` describes; it is React (`React.createElement`, one runtime `require("react")`), so `practices.md:33` is met, and it contributes through a slot (`slots.inject("shell.overlay", …)` / `slots.register(…)`) without appending a second application to `document.body` (`ui-plugin.md:13`).
4. Per-agent registrations keep their disposer in the plugin's own effect as well as on the agent context — `practices.md:2,19` in almost the same words as the comment at `tools/index.js:413-416`. Optional services are in `inject` (`practices.md:20`). The prompt half uses `ctx.systemPrompt.section()` and its order tie-break matches the documented rule (`practices.md:18`).
5. The scene gate is a `tools/pre-execute` ask, which is the documented place for a decision that must wait for a person (`practices.md:17`).
6. No `setInterval` exists in the host half; resources are registered inside `apply` with `ctx.effect` (`host-plugin.md:65`). No session event of a new type is appended anywhere (`practices.md:21`).
7. Bounded answers with a `bounded` note and a pointer to ask narrower — `tool-design.md:4,5` — are the existing behaviour, pinned by `AGENTS.md` §5.4.
8. The icon is exported as `./icon` and is 1 207 bytes, inside the 256 KiB limit (`host-plugin.md:52`).

### Does not apply here, recorded so a later session does not file it as a gap

1. Session projections (`practices.md:26-27`) and the projection seam: this plugin's state is lane state it owns, not state derived from the session log.
2. `ctx.credentials` (`configuration.md:12`): the plugin holds no secret; the registry holds URLs, the store holds files.
3. `ctx.tools.guard()` (`practices.md:17`): the capability bar's refusal is the plugin's own door, taken before a job row exists, not a policy over the tool pipeline.
