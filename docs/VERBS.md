# The verbs: every route this plugin answers

**What this page is.** A reference for the people and agents who call the plugin directly. The panel presses these
routes for you; this page is for the times you press them yourself — from a script, from `curl`, or from the four
agent tools. Every route the dispatcher answers is here: the method it takes, what it gives back, and what it
refuses instead. The shapes were read out of the dispatcher and checked against live answers on 2026-11-19.

**The authority stays the suite.** `tests/verb_contract.test.cjs` reads the panel's call switch and the host's method
gates and fails when the two disagree — it is executable and it cannot drift, and an assertion in it now requires
every host route to be named on this page and this page to name no route the host does not answer. **What this page
carries that the suite does not is the prose**: what a verb is for, what its answer holds, and what its refusals say.
Where a method here and the suite disagree, the suite is right and this page is stale.

**How to call.** Every route sits under the plugin's own prefix on the harness's HTTP surface —
`/api/deepamp/<verb>`. The harness's address comes from the session that needs it; it is not a constant of this
package. Reads are `GET`, with the argument in the query (`?fn=tts&id=e-11`). Writes are `POST` with a JSON body and
`content-type: application/json`. No token is involved on the harness's own port.

**Three rules every route obeys.**

1. **The wrong method answers `method not allowed` and nothing else happens.** A `GET` on a `POST only` route and a
   `POST` on a `GET only` route are refused before the verb runs.
2. **A body that misses a field the door needs is refused before a row exists.** No job id is spent, no file is
   written, nothing is queued. `dispatch_refuse` records it in the performance log.
3. **A model the slot you aim at does not serve is refused, and no door fills a model for you.** All four dispatch
   doors — take, transcription, scene, generated task — answer the same sentence when the request names no model.
   Read what the slot serves first: `endpoint_models` below, or the agent tool `audio_status {what:"slot_models"}`.

**What this page does not carry.** No model name as the model to use, no machine name, no address, no port, no store
path on this machine. A slot is named by its role (`primary`, or `e-<digits>` from `endpoint_registry`), a store is
written `<home>/.dsh/deepamp-audio`, and fleet state — which slot is enabled or held, what an engine's catalog
answers — is read in the session that needs it, never copied here.

**The method column** uses exactly three words: `GET only`, `POST only`, `GET or POST`.

---

## 1. Making sound

| Route | Method | What it does | What it answers, or refuses |
|---|---|---|---|
| `dispatch_tts` | POST only | One voice, one text: a single-voice take. | `job_id`, `route_url`, `status`, `voice_mode` (how the voice was taken), the endpoint it landed on. Refuses an unnamed model ("a take needs a model named — this plugin carries no default for it…"), a model the slot does not list, a malformed voice or model name, and a `speakers` list on a family that does not take samples. |
| `dispatch_stt` | POST only | Transcribes audio: `file_path` for a file this plugin can read, or `source_job_id` for a row it already made. | The transcript **inline** plus the `job_id`. Refuses an unnamed model ("a transcription needs a model named…"), a path it cannot read, and an unknown `source_job_id`. It blocks until the row reaches a terminal state — a short client timeout is not a failure. |
| `dispatch_speaker_asr` | POST only | The speaker-tagged chain: diarisation with frame probabilities, then transcription of each speaker. | `transcript` in the tagged form plus `speaker_turns` with the spans, and `speaker_asr` naming which diar and which transcription model did it. Takes optional `diar_model` and `asr_model`. |
| `dispatch_task` | POST only | A named task kind — `sep` (separation), `gen` (generation), `vc` (voice conversion), `s2s`. Body carries `task_kind`, `model`, the text or the input row, and `options`. | `job_id` and the row. Refuses a task the model does not serve, an option the model's own record requires and the request does not carry, and a request with no model named. |
| `dispatch_batch` | POST only | A multi-voice scene, split into bounded parts on one endpoint. Body carries `dialogue` or `file`, `model`, and optionally `max_speakers`, `part_seconds`, `cost_per_second`, `save_dir`, an endpoint pin. | `batch_id` and the part rows. Refuses a line with no speaker, an unnamed model, and a cast over the speaker cap. |
| `batch_plan` | POST only | The same scene request **worked out and answered, dispatching nothing**. | `dry_run:true`, `would_dispatch`, the cast, the part split, and `over_budget` per part. This is the read that says whether a scene is worth queueing. |
| `cast_preview` | POST only | Names in, names out: what the lane actually holds for the speaker names a person typed. | Per name: a plugin voice, an engine builtin, or nothing. No path is ever answered. |
| `dl_format` | GET or POST | The container every new take is written in. GET reports the current format and the choices; POST `{"format":…}` sets it. | |

## 2. Reading the lane

| Route | Method | What it answers |
|---|---|---|
| `queue_status` | GET only | Both queues: `paused`, `auto_paused`, the running ids, `queued`, `slots` (max and used), `host_cap` and where that cap comes from, `machines` keyed by host, and `auto_gen` as the panel last reported it or `unknown`. |
| `lane_activity` | GET only | What the lane has been doing, read as activity rather than queue position. |
| `job_status` | GET only `?job_id=ap-XXXX` | One row, whole: status, kind, model, family, quant, endpoint, timings (`elapsed_load` and `elapsed_gen` **separately**), duration, size, output path, error. A row also answers at its own URL (`/deepamp/ap-XXXX`). |
| `job_flags` | GET only | Every flagged row: the token, the note, the timestamp, and a count. |
| `playlist_list` | GET only `?page_size=` | The rows the panel lists, newest first, each with its live queued or running state, and `auto_gen` beside them. |
| `batch_status` | GET only `/batch_status/<batch_id>` | A batch: title, part count, done, failed, the model it ran on, and the parts with their cast and status. **`parts` is answered as a count**, not a list — a part is read by its own id. |
| `sessions_list` | GET only | The agent sessions the plugin has seen. |
| `last_agent_message` | POST only | The last agent message the plugin received, as the panel saw it. |
| `plugin_version` | GET only | The package name, its version, and where it was loaded from. |
| `server_status` | GET only | Per lane: whether the slot answers and which model it currently holds loaded. |
| `storage_status` | GET only | The store roots: exists, writable, free and total bytes, and any error per root. |
| `get_save_paths` | GET only | The output directories in use and their defaults. |
| `get_endpoints` | GET only | The short endpoint view: the url and route per lane. The full registry is `endpoint_registry`. |
| `perf_log` | GET or POST | GET: whether the plugin writes its own performance log, and the file. POST `{"on":true|false}`: the toggle. |
| `perf_stats` | GET only | Counters over that log: what the lane has been doing and how long it took. |
| `perf_tail` | GET only | The tail of the performance log, as records. |
| `log_tail` | GET or POST | The lane log, a page at a time. The limit parameter is **`limit`**. |
| `models_audit` | GET only | The audit view over the model rows: what the plugin believes each slot serves, and where each row came from. |

## 3. Models, catalogs and the capability bar

| Route | Method | What it does | What it answers, or refuses |
|---|---|---|---|
| `get_models` | GET only `?fn=tts\|stt` (optionally `&id=primary\|e-<digits>`) | The catalog for one lane, as this plugin holds it. With `id`, that one slot's own `/v1/models`, read now and held as that slot's answer (T-922). | Per model: id, family, task, mode, quant, path, loaded, and the clone flags, plus `served_by` naming the slot the row was read from. The answer also carries `fleet.slots` — the lane's slots and what was last held about each — and a `fleet.note` when another slot declares models this list does not carry. |
| `endpoint_models` | POST only `{fn, id}` | What **one slot** serves, read from that engine and stored. | The list, plus `models_raw` (what the engine really answered), `models_bounded` (whether a bound cut it) and `capability_partial`. A bare `{fn}` is refused: `id is required (e-<digits>, from endpoint_registry)`. |
| `endpoint_library` | GET only `?fn[&id][&fresh=1]` | What an engine **owns on disk**, joined to the lane's configured rows. Answers per endpoint on purpose. `fresh=1` skips the five-minute cache. | An engine without its UI management answers that it has no library. |
| `model_capabilities` | GET or POST | The capability record for a family: the parameters a request may carry, their types and defaults, and the parameters that record says a request **must** carry. | A family with no record says so rather than guessing. |
| `voice_modes` | GET only `?fn&model` | The voice-mode vocabulary a model answers — `no_voice`, `preset_speaker`, `clone_sample`, `voice_design`, `dialogue_positional` — and where the record came from. | The same vocabulary is answered for families whose **request shapes** differ, so this read does not tell you which body fields a family takes. The door tells you when you send the wrong one, and it never refuses an unknown model. |
| `voice_groups` | GET or POST | The registered voices grouped by label, with counts. | |
| `voice_ceiling` | GET or POST | How many distinct voices one take may carry. GET reports the cap, the default and the range; POST `{"voices":N}` sets it. | |
| `generation_ceiling` | GET or POST | The ceiling on a generated take's length. GET reports ceiling, default, max and whether limits apply; POST `{"ceiling_s":N}` sets it. | |
| `get_pipelines` | GET only | The wiring view (which task kinds sit on which lane) joined with the catalogs. **GET only, and slow**: it pays the catalog reads, so a client with a short timeout can mistake an empty response for an empty answer. Ask with a longer wall. |
| `endpoint_health` | POST only `{fn[, id]}` | Whether a slot answers, probed now — `/health`, five seconds, cached, never polled. |
| `endpoint_registry` | GET only `?fn` | The whole registry for one lane: every entry with its id, host, url, route, enabled, batch_allowed, hold state and any saved catalog. |
| `endpoint_failures` | GET or POST | The failures this plugin recorded against its slots, each with the reason it carries. |

## 4. Voices

| Route | Method | What it does | What it answers, or refuses |
|---|---|---|---|
| `voice_registry` | GET only | The voices this plugin holds: each name with its reference text, its sample and its measured length. |
| `refresh_voices` | GET only `?fn[&model]` | What the **engine** says about voices right now. With no model named it answers no builtins at all (`builtins_source:"none"`) — that is not an empty registry. |
| `voice_speech_probe` | POST only `{"name":…}` or `{"all":true}` | How much of a voice sample is speech and how much is silence: `speech_s`, `file_s`, `silence_s`, `tail_s`. |
| `save_voice` | POST only `{name, file_path, asr_model}` | Register a voice from a WAV this plugin can read. The reference text is transcribed **by the model the caller names** — this door carries no default either. |
| `delete_voice` | POST only `{name}` | Take a voice out of the registry. A name must match the plugin's own shape rule. |
| `design_voice` | POST only `{model, name, …}` | A designed voice: the request carries the description of how the voice should sound rather than a sample. |

## 5. Scene text and batch documents

| Route | Method | What it does |
|---|---|---|
| `batch_text_list` | GET only | The saved scene texts and presets, with their paths, sizes and — for a preset — the model and side it was last run with. |
| `batch_text_load` | GET or POST `?path=` | One of them, read back. |
| `batch_text_save` | POST only | Save a scene text. |
| `batch_text_update` | POST only | Replace the text of one that exists. |
| `batch_text_delete` | POST only | Remove one. A delete is a delete: this is the door, not a move. |
| `batch_file_list` | GET only `?kind=` | The batch documents the store holds, with title and kind. |
| `batch_file_load` | GET or POST `?path=` | One of them, read back as a document. |
| `batch_file_save` | POST only | Save a batch document. |
| `batch_file_update` | POST only | Replace one. |
| `batch_file_delete` | POST only | Remove one. |
| `batch_audit_attach` | POST only | Ingest a verification report into the rows of a batch, so the audit sits with the render it audited. |
| `batch_split` | GET or POST | Whether a scene the agent imports is split automatically. GET reports `enabled`, `part_seconds`, `max_parts`, `chars_per_second` and the seconds a part gets; POST `{"enabled":…}` sets it. |

## 6. Work on a row after it exists

| Route | Method | What it does | What it needs, or refuses |
|---|---|---|---|
| `slice_job` | POST only | A time slice of a take, as a new row (`job_id`, `start_s`, `end_s`, optional `label`). | Writes a **new** file; the source row is untouched. |
| `resample_audio` | POST only | A copy of a row's audio at another rate and channel count. | `audio_job_id` (with optional `stem_id`) or `audio_path`; `sample_rate` from a fixed list (8 000 … 96 000); **and** a `reason` string naming the contract the copy is for. Writes a new file. |
| `convert_item` | POST only | One row into another container, as a new row. | `format` must be `wav`, `ogg` or `mp3` — anything else is refused by name. The original row and its file stay. |
| `diar_to_chunks` | POST only | The speaker chain run over one row and the per-speaker chunks written. | `source_job_id` (a separation, take or file row) or `file_path`. Refuses a row whose output is a transcript rather than audio. Runs its own diarisation and says which model did it. |
| `mix_audio` | POST only | Rendered rows mixed onto a separation bed stem, with local ffmpeg. No engine, no queue slot, no new row — the result is a new stem on the bed row. | A bed row with stems to mix onto. An ambiguous bed is refused with its stem list, never guessed. At most 12 layers, and any path must sit under the store root. |
| `remux_video` | POST only | Re-mux a video row's audio into a new item. | A video row, or a file this plugin can read. |
| `wave_peaks` | GET or POST `?job=ap-XXXX&slices=N` | The waveform peaks of a row's file, for a drawing. | The parameter is **`job`**, not `job_id`. An ask above the ceiling is clamped and the answer says it was truncated. |
| `upload_audio` | POST only `{name, data_b64}` | A file a browser holds, written once into the store and listed as a row, so it can be played, transcribed, or used to make a voice. | Base64 in the body, so the body is large — a shell argument is the wrong way to send it. |
| `capture_url` | POST only `{url}` | Fetch a URL's media into the store as a row. The one door that goes out to the network. |
| `import_path` | POST only `{path}` | Import a file that lives on this machine into the store as a row. | A path it may read. Whether a path **outside** the store is importable at all is `import_outside_store`. |
| `import_outside_store` | GET or POST | The setting that opens or closes that door. GET reports it; POST `{"enabled":…}` sets it. |
| `ytdlp_path` | GET or POST | The capture binary: GET reads the configured path and what the binary last said about itself; POST `{"path":…}` sets it. |

## 7. Endings, holds and retries

| Route | Method | What it does | What it answers, or refuses |
|---|---|---|---|
| `cancel_job` | POST only `{job_id}` | Ask for a row to be killed. | `action:"kill_requested"`, `status:"aborted"`. A row that already finished answers "job already <status>" rather than pretending. |
| `abort_job` | POST only `{job_id}` | Take a **queued** row out of the line. | `action:"dequeued"`. A row the lane is running is left alone — only its own control stops it. |
| `abort_fn` | POST only `{fn}` | Abort what a lane is running now. | The queue state after the kill. The row ends `error:"aborted by user"`. |
| `retry_job` | POST only `{job_id}` | Run an **error or aborted** row again, as a new row. | Refuses anything else: "only error/aborted rows can be retried". |
| `pause_fn` | POST only `{fn}` | Hold a queue. Held work stays queued; nothing is lost. |
| `resume_fn` | POST only `{fn}` | Let a held queue run again. |
| `job_flag` | POST only `{job_id, flag[, note]}` | Flag a row for a human. | The flag must be one of six tokens: `noise`, `quiet`, `clipped`, `wrong_text`, `wrong_speaker`, `needs_investigation`. Anything else is refused with the list. |
| `job_flag_clear` | POST only `{job_id[, flag]}` | Clear a flag, or every flag on that row. |
| `playlist_delete` | POST only `{job_id[, delete_file]}` | Remove one row from the playlist, and its file only when the request says to. |
| `playlist_clear` | POST only `[{keep}]` | Retire **finished** rows only. A running or queued row stays, and a queued row a caller asks to clear is taken out of the line first. **No audio file is ever deleted here** — disk cleanup is `delete_all_audio`, and that door is not for tidying. |
| `delete_all_audio` | POST only `{confirm}` | Delete the generated audio in the store. **This is the destructive door, and it asks for a confirm field for a reason**: an empty body once removed a day of takes. |

## 8. The endpoint registry, as a control

| Route | Method | What it does |
|---|---|---|
| `endpoint_add` | POST only `{fn, url, …}` | Register a slot. Ids come from a global sequence and are never reused, so a number means only the entry it was given. |
| `endpoint_update` | POST only `{fn, id, …}` | Change an entry: url, route, enabled, batch_allowed. It answers the entry rather than "nothing to change". |
| `endpoint_remove` | POST only `{fn, id[, clear]}` | Remove an entry. |
| `endpoint_pause` | POST only `{fn, id}` | Hold a slot. A held slot takes no new work; rows already on it are not cut off. |
| `endpoint_resume` | POST only `{fn, id}` | Release a held slot. The order stays "start the unit, then release the slot". |
| `endpoint_promote` | POST only `{fn, id}` | Make one entry the primary for its lane. This is the one set-as-primary verb. |
| `endpoint_clear` | POST only `{fn}` | Remove every entry of a lane. The explicit way to empty a registry — and the reason nothing else does it by accident. |
| `set_endpoint` | POST only `{fn, url[, route][, force]}` | The older single-slot setting, kept so an older caller still lands somewhere sensible. |
| `prefer_primary` | GET or POST | Whether placement prefers the primary slot when more than one can serve. It is a re-sort **inside** the free group, never a tier above it. |
| `endpoint_failures_clear` | GET or POST `{fn[, id]}` | Throw away the failure history for a slot. That history is how a slot's recent behaviour is known. |

**A held slot is not an invitation.** An entry can carry an operator hold, and a hold covers the **machine** behind
the slot, not only the dispatch. Ask before putting work on such a machine, and the order for a slot whose engine is
not running is fixed: start the unit, then release the slot.

## 9. The engine's model slots, and the knobs

| Route | Method | What it is |
|---|---|---|
| `load_model` | POST only | Ask a slot to load a model. A `package_id` supplies the file and the family; a body that names both `path` and `package_id` is refused by the engine. |
| `unload_model` | POST only | Ask a slot to drop one model it holds. A model mid-inference is refused. |
| `unload_all_models` | POST only `{fn[, endpoint_id]}` | Ask a slot to drop everything it holds, without depending on what this plugin last read as loaded. |
| `job_timeout` | GET or POST `{"seconds":N}` | How long one engine request may run before the plugin calls the row finished. Cutting the call is not a wall on the work. |
| `takes_limit` | GET or POST | What the store does as the takes grow: `off`, `limit`, or `auto_delete` with a byte cap. |
| `stt_feed` | GET or POST | How audio is fed to a transcription (`resample` or the source's own shape), the rate, and the channel rule. A speaker chain is fed at its own fixed shape whatever this says. |
| `limit_one_per_host` | GET or POST `{"enabled":…}` | The soft cap on how many jobs one machine may hold at once. An environment override outranks the switch. |
| `origin_policy` | GET only | **A security setting, and it has no write half**: what the lane admits beyond its own origin — the declared `allowed_origins` list, whether it carries `*`, what was refused at boot, and the listener facts read from the carrier. The door is opened in the patch file, never by a page. |
| `generation_ceiling`, `voice_ceiling` | GET or POST | The two ceilings themselves, in section 3. |
| `disable_generation_limits` | GET or POST `{"enabled":…}` | Turn the generation ceilings off. Turning them off is a deliberate act, not a tidy-up. |
| `set_save_path` | POST only `{fn, dir}` | Point an output lane at another directory. |
| `auto_gen_state` | POST only | **A write, not a read**: this is the panel reporting its own auto-generation chain, held in memory only. Read the chain state with `queue_status`. |

## 10. Station and playback

| Route | Method | What it does |
|---|---|---|
| `station_hosts` | GET or POST | The hosts the station read is allowed to follow, and which one is the default. |
| `station_title` | GET or POST `?url` or `{url[, force]}` | What a station is playing right now, read from the station being played. With no url it answers `st:"no_url"`. |
| `play_job` | POST only `{job_id}` | Ask the panel to play a row. |
| `play_file` | POST only `{file_path}` | Ask the panel to play a file from disk. |

Both playback doors ask the **browser** to make sound, and the panel carries the request only while it is open. From
an agent the tool for that is `audio_control {what:"play", job_id:…}`, and an action asked with no panel open is
reported as held, not done.

## 11. The refusal vocabulary, as it actually reads (measured 2026-11-19)

1. `a take needs a model named — this plugin carries no default for it. Read what the slot you aim at lists with POST endpoint_models …` — `dispatch_tts`, no model.
2. `a transcription needs a model named — this plugin carries no default for it. … or choose one in the Model select of the transcription section.` — `dispatch_stt`, no model.
3. `speakers was sent as an empty list — one entry per speaker (an empty string means an invented speaker)…` — a scene line with no speaker.
4. `speakers is only valid on a voice_samples family … model <id> does not take voice_samples` — the wrong request shape for the family.
5. `unknown model id: <name>` — the engine's own answer, when a name reaches it. This plugin's gate refuses a name its catalog does not list **before** the engine sees it.
6. `sample_rate is required and must be one of 8000 … 96000` / `reason is required: say which contract this copy is for` — `resample_audio`.
7. `format must be one of wav, ogg, mp3 — the containers this door can write. Asked for: "<x>"` — `convert_item`.
8. `flag must be a lowercase token, 1-24 chars: noise, quiet, clipped, wrong_text, wrong_speaker, needs_investigation` — `job_flag`.
9. `only error/aborted rows can be retried` — `retry_job`.
10. `source row <id> output is a transcript (.txt), not audio` — `diar_to_chunks`.
11. `id is required (e-<digits>, from endpoint_registry)` — `endpoint_models` with no slot named.
12. `method not allowed` — the wrong method, before anything runs.
13. `unknown route` — a name the dispatcher does not have. Check the spelling before believing it is a missing feature: a label pasted into a URL produces this too (`job_timeout(no-op)` did).
14. `this origin is not allowed on the audio lane: the request carries Origin "<x>", which is not the address this server is answering. A program that sends no Origin (curl, a script) is unaffected.` — a request that carries an `Origin` from **another address**. Answered **403**, before the body is read: the only 4xx on this surface that is not about the body. The panel is same-origin, so it is never seen; a caller with no `Origin` at all is never seen. This is the request policy this route owner takes (`dsh-host-webserver` says route owners enforce their own) and it is **not** authentication (`CHANGELOG.md` T-931, `TODOS.md` item 117).

Every one of these happens **before a row exists**: no id spent, nothing counted against a ceiling. A refusal is a
fact about the request, not a fault in the lane.

## 12. How to use this page

1. **Read before you dispatch.** `endpoint_registry` for the slots, `endpoint_models` for what one slot serves,
   `model_capabilities` and `voice_modes` for what a model takes. Each of those reads is cheaper than the row a
   refusal prevents.
2. **Plan a scene before you queue it.** `batch_plan` answers the cast, the split and the budget and dispatches
   nothing; `cast_preview` answers whether the lane has the names you intend to speak with.
3. **Ask narrowly.** Answers are bounded — a cut answer carries a `bounded` note that says so and tells you to ask
   for one id, one slot or one path. Re-asking broadly does not un-cut it.
4. **Do not call the destructive doors to tidy.** `delete_all_audio`, `playlist_clear`, `endpoint_clear` and the
   `*_delete` routes do exactly what their names say. This package keeps files out of git rather than deleting them.
5. **A slow read is not a failed read.** `get_pipelines` pays a catalog join; `dispatch_stt` blocks until its row
   finishes. Both are answered by the row, which exists whether or not your client waited.
