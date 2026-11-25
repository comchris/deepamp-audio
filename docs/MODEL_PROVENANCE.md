# audio.cpp model provenance & repair tracker (cpu1 NFS)

> **This file is a dated read, it is a test dependency, and the shelf it describes is legacy.** Added 2026-11-04.
> `tests/host.test.cjs` reads it with a real `readFileSync` and pins one row: `fish-audio-s2-pro` must still carry
> task `clon`, "TTS (clone)", `up_to_date`, because the plugin's curated override cites this table as its
> evidence. So the rows are fixtures and are not edited to look current. What this file is about — the model files on
> the NFS shelf — is the **legacy** shelf: since plugin T-217 the plugin's own voice store is the single voice entity
> and `lib/index.js` contains no shelf step. Today a model's availability is read from the endpoint's catalog (`GET
> endpoint_models {fn,id}`) and a voice is registered through the plugin's verbs. The file stays as the record of that
> 2026-09-20 remediation.

**The first column of every table here is the engine's own model id since T-878 (2026-11-16); the webui
package id each row already carried is unchanged and is still what the downloader answers.** The re-key came
from the engines' own two reads (`GET <engine>/v1/models` for the runnable id and the file it serves,
`GET <engine>/v1/ui/models/package-sizes` for the package id and the file it loads); the builder, the map
and the list of rows written are `scratch/records_recut_ids.py`, `scratch/records_recut_map_20261116.csv`
and `scratch/records_recut_applied_20261116.txt`, and the pre-change copies are the
`.bak_20261116_pre_records_recut_t878` copies beside them. **Fifteen rows across the two records were not
re-keyed and are carried unchanged:** they name a file or a package no engine answers today, and a record
that says so is more useful than one that quietly renames it. The second table's rows are the 2026-09-20
repair verdicts and those verdicts were not touched.

Status doc for the "unknown / mismatched model files" remediation. Companion to
`MODELS_TABLE.md` (engine matrix + test columns) and `MODELS_REMOTE.md` (paths).
Taken **2026-09-20**. This file tracks repair progress; it does **not** carry test
verdicts — those stay in `MODELS_TABLE.md` for the dedicated test session (T-98).

## Source of truth

The audio.cpp WebUI downloader is the authority on what a model *should* be:

- `GET http://127.0.0.1:8963/v1/ui/models/package-sizes` → one row per download
  package: `{id, installed, version_state, local_revision, remote_revision, size_bytes}`.
  `version_state` ∈ `not_installed | up_to_date | update_available | unknown`.
  This is what the Models page shows as "Version unknown".
- `model_specs/*.json` (engine git checkout) = the downloader's package manifests
  (file lists + `download` source). The GGUF quants all resolve to the HF repo
  **`audio-cpp/audio.cpp-gguf`** @ `main`.
- `POST /v1/ui/models/install {"id": <pkg>, "overwrite": true}` → the remote engine
  re-fetches the official file into the models-root (`/mnt/llama/audio.cpp`) and
  writes the install manifest. This is the sanctioned "let audio.cpp handle the file"
  path — we never touch `/mnt/llama` ourselves and never run anything locally.

### What `unknown` actually means (from `manager.cpp` `inventory()`)

`installed` is true (all package files present) but the server **has no install
manifest** for the package, so it cannot compare per-file ETags to the official
repo → provenance unverifiable. Root cause: those files were placed by the
2026-09-19 auto-wire / manual migration (T-74), **not** downloaded through the
downloader, so no `.audiocpp-package-<id>.json` manifest was ever written. It is a
metadata gap *and* a real integrity gap: without a manifest nothing proved the bytes
match the official build (see the size mismatches below).

Repair = one `POST /v1/ui/models/install {overwrite:true}`; the installer stages to
a temp file then `rename()`s it into place (atomic — a currently-loaded model keeps
its old inode until it reloads, so a live endpoint is never corrupted mid-download).

## Live snapshot (2026-09-20, 41 wired models, both endpoints share the store)

Distribution (pre-fix): 208 not_installed · 34 up_to_date · 7 unknown · 0 rogue
(0 rogue = every shelf GGUF filename matches an official `model_specs` package;
nothing is misnamed).

## The 7 `unknown` packages

| plugin id | webui download pkg | task | plugin use | on-disk (pre) | official dl | note | status |
|---|---|---|---|---|---|---|---|
| `sortformer_diar` | `sortformer_diar_4spk_v1_q8_0` | diar | not wired | 176 MB | 176 MB | size matches | **DONE** 2026-09-20 (validation install; flipped up_to_date) |
| `omnivoice_f16` | `omnivoice_f16` | tts | TTS | **1.40 GB** | **1.64 GB** | **SIZE MISMATCH — wrong/partial file** | **DONE** 2026-09-20 (re-download, now up_to_date 1.64 GB) |
| `qwen3-tts-bf16` | `qwen3_tts_1_7b_base_bf16` | tts | TTS | **1.39 GB** | **4.20 GB** | **SIZE MISMATCH — ~1/3 expected (bad build)** | **DONE** 2026-09-20 (re-download, now up_to_date 4.20 GB) |
| `qwen3-tts` | `qwen3_tts_1_7b_base_q8_0` | tts | TTS | 2.70 GB | 2.70 GB | size matches, no manifest | **DONE** 2026-09-20 (re-download, now up_to_date) |
| `qwen3-customvoice` | `qwen3_tts_1_7b_customvoice_q8_0` | tts | TTS | 2.82 GB | 2.82 GB | size matches, no manifest | **DONE** 2026-09-20 (re-download, now up_to_date) |
| `cosyvoice3` | `cosyvoice3_q8_0` | clon | TTS (clone) | 2.26 GB | 2.26 GB | size matches, no manifest | **DONE** 2026-09-20 (re-download, now up_to_date) |
| `controlfoley` | `controlfoley_large_44k_q8_0` | gen | **not wired** | 12.56 GB | 12.56 GB | size matches; plugin cannot dispatch `gen` | **DONE** 2026-09-20 (re-download per user; now up_to_date — store fully clean) |

**RESULT 2026-09-20 (verified via `GET /v1/ui/models/package-sizes`, state=complete):**
distribution moved **34 up_to_date / 7 unknown → 41 up_to_date / 0 unknown**. Every wired
model now carries an install-manifest with verified official bytes. The 5 plugin-usable
TTS files + controlfoley re-downloaded from `audio-cpp/audio.cpp-gguf` @ main; `qwen3-tts-bf16`
in particular went from a 1.39 GB truncated file to the real 4.20 GB build, and
`omnivoice_f16` from 1.40 GB to 1.64 GB.

- **Plugin-usable TTS unknowns (5):** `omnivoice_f16`, `qwen3-tts-bf16`, `qwen3-tts`,
  `qwen3-customvoice`, `cosyvoice3` → ~13.6 GB to re-download. Two of them
  (`qwen3-tts-bf16`, `omnivoice_f16`) are size-mismatched and almost certainly wrong
  builds — the strongest "mismatched" cases; re-download is a real fix, not cosmetic.
- **Non-plugin (1):** `controlfoley` (gen, 12.56 GB, size matches) — plugin does not
  wire `gen`; re-download is only for whole-store provenance cleanliness.
- `sortformer_diar` (diar, 0.18 GB) already repaired as the pipeline validation.

### Repair command (run one at a time, endpoints must be idle — no dispatch/load during)

```bash
ssh <the-node-account>@cpu1.test 'curl -s -X POST http://127.0.0.1:8963/v1/ui/models/install \
  -H "Content-Type: application/json" -d "{\"id\":\"<pkg>\",\"overwrite\":true}"'
# watch: GET /v1/ui/models/install-status ; then re-run package-sizes to confirm up_to_date
```

## Full 41-wired-model provenance table

<table>
<tr><td>See table below (sorted by plugin id). version_state = webui downloader verdict; repair marks the remediation.</td></tr>
</table>

| plugin id | family | task | usable in plugin | NFS file (basename) | on-disk MB | webui download pkg | version_state | repair |
|---|---|---|---|---|---|---|---|---|
| `breeze-tts-clone` | breeze_tts | clon | TTS (clone) | `breeze-tts-2-q8_0.gguf` | 5079 | `breeze_tts_2_q8_0` | up_to_date | — |
| `bs-roformer` | bs_roformer | sep | not wired | `bs-roformer-ep368-q8_0.gguf` | 172 | `bs_roformer_q8_0` | up_to_date | — |
| `canary-asr` | canary_asr | asr | STT | `canary-180m-flash-f32.gguf` | 757 | `canary_180m_flash_f32` | up_to_date | — |
| `chatterbox` | chatterbox | clon | TTS (clone) | `chatterbox-q8_0.gguf` | 2088 | `chatterbox_q8_0` | up_to_date | — |
| `citrinet-asr` | citrinet_asr | asr | STT | `citrinet-asr-q8_0.gguf` | 40 | `citrinet_asr_q8_0` | up_to_date | — |
| `controlfoley` | controlfoley | gen | not wired | `controlfoley-large-44k-q8_0.gguf` | 12556 | `controlfoley_large_44k_q8_0` | unknown | optional |
| `cosyvoice3` | cosyvoice3 | clon | TTS (clone) | `cosyvoice3-q8_0.gguf` | 2257 | `cosyvoice3_q8_0` | unknown | re-download |
| `fish-audio-s2-pro` | fish_audio | clon | TTS (clone) | `fish-audio-s2-pro-q8_0.gguf` | 6317 | `fish_audio_s2_pro_q8_0` | up_to_date | — |
| `fun_asr_nano` | fun_asr_nano | asr | STT | `fun-asr-nano-2512-f16.gguf` | 1675 | `fun_asr_nano_2512_f16` | up_to_date | — |
| `glm-tts` | glm_tts | clon | TTS (clone) | `GLM-TTS_Q8.gguf` | 5143 | `glm_tts_q8_0` | up_to_date | — |
| `higgs_tts` | higgs_audio_tts | tts | TTS | `higgs-audio-v3-tts-4b-q8_0.gguf` | 5095 | `higgs_audio_tts_4b_q8_0` | up_to_date | — |
| `htdemucs_f16` | htdemucs | sep | not wired | `htdemucs-f16.gguf` | 84 | `htdemucs_f16` | up_to_date | — |
| `htdemucs` | htdemucs | sep | not wired | `htdemucs-q8_0.gguf` | 61 | `htdemucs_q8_0` | up_to_date | — |
| `index_tts2` | index_tts2 | tts | TTS | `index-tts2-f16.gguf` | 4646 | `index_tts2_f16` | up_to_date | — |
| `kroko-asr` | kroko_asr | asr | STT | `kroko-en-community-64-l-q8_0.gguf` | 167 | `kroko_asr_community_q8_0` | up_to_date | — |
| `mel_band_roformer` | mel_band_roformer | sep | not wired | `mel-band-roformer-f16.gguf` | 456 | `mel_band_roformer_f16` | up_to_date | — |
| `moss-tts-local` | moss_tts_local | clon | TTS (clone) | `moss-tts-local-v1.5-q8_0.gguf` | 7512 | `moss_tts_local_v1_5_q8_0` | up_to_date | — |
| `moss_tts_nano` | moss_tts_nano | tts | TTS | `moss-tts-nano-100m-bf16.gguf` | 332 | `moss_tts_nano_100m_bf16` | up_to_date | — |
| `omnivoice` | omnivoice | tts | TTS | `omnivoice-q8_0.gguf` | 1350 | `omnivoice_q8_0` | up_to_date | — |
| `omnivoice_f16` | omnivoice | tts | TTS | `omnivoice-f16.gguf` | 1400 | `omnivoice_f16` | unknown | re-download |
| `personaplex` | personaplex | s2s | not wired | `personaplex-7b-v1-q4_k.gguf` | 7860 | `personaplex_7b_v1_q4_k` | up_to_date | — |
| `pocket_tts_en_bf16` | pocket_tts | tts | TTS | `pocket-tts-english-bf16.gguf` | 219 | `pocket_tts_english_bf16` | up_to_date | — |
| `pocket-tts` | pocket_tts | tts | TTS | `pocket-tts-english-q8_0.gguf` | 127 | `pocket_tts_english_q8_0` | up_to_date | — |
| `qwen3-tts-1.7b-custom` | qwen3_tts | tts | TTS | `qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf` | 2817 | `qwen3_tts_1_7b_customvoice_q8_0` | unknown | re-download |
| `qwen3-tts-1.7b` | qwen3_tts | tts | TTS | `qwen3-tts-12hz-1.7b-base-q8_0_v2.gguf` | 2695 | `qwen3_tts_1_7b_base_q8_0` | unknown | re-download |
| `qwen3-tts-bf16` | qwen3_tts | tts | TTS | `qwen3-tts-12hz-1.7b-base-bf16.gguf` | 1394 | `qwen3_tts_1_7b_base_bf16` | unknown | re-download |
| `qwen3-voicedesign` | qwen3_tts | vdes | TTS (design) | `qwen3-tts-12hz-1.7b-voicedesign-bf16.gguf` | 4179 | `qwen3_tts_1_7b_voicedesign_bf16` | up_to_date | — |
| `qwen3_asr` | qwen3_asr | asr | STT | `qwen3-asr-1.7b-f16.gguf` | 4087 | `qwen3_asr_1_7b_f16` | up_to_date | — |
| `sense-asr` | sense_asr | asr | STT | `sensevoice-small-q8-audiocpp-v1.gguf` | 254 | `sensevoice_small_q8` | up_to_date | — |
| `sortformer-diar` | sortformer_diar | diar | not wired | `sortformer-diar-4spk-v1-q8_0.gguf` | 175 | `sortformer_diar_4spk_v1_q8_0` | up_to_date (fixed 2026-09-20) | DONE |
| `sortformer_diar_f16` | sortformer_diar | diar | not wired | `sortformer-diar-4spk-v1-f16.gguf` | 247 | `sortformer_diar_4spk_v1_f16` | up_to_date | — |
| `stable-audio-medium` | stable_audio | gen | not wired | `stable-audio-3-medium-q8_0.gguf` | 3582 | `stable_audio_3_medium_q8_0` | up_to_date | — |
| `stable-audio-small-sfx` | stable_audio | gen | not wired | `stable-audio-3-small-sfx-q8_0.gguf` | 1683 | `stable_audio_3_small_sfx_q8_0` | up_to_date | — |
| `supertonic` | supertonic | tts | TTS | `supertonic-3-q8_0.gguf` | 454 | `supertonic_3_q8_0` | up_to_date | — |
| `vevo2` | vevo2 | vc | not wired | `vevo2-f16.gguf` | 5021 | `vevo2_f16` | up_to_date | — |
| `vibevoice` | vibevoice | tts | TTS | `vibevoice-1.5b-q8_0.gguf` | 3224 | `vibevoice_1_5b_q8_0` | up_to_date | — |
| `vibevoice-7b` | vibevoice | tts | TTS | `vibevoice-7b-q8_0.gguf` | 10581 | `vibevoice_7b_q8_0` | up_to_date | — |
| `vibevoice-asr` | vibevoice_asr | asr | STT | `vibevoice-asr-q8_0.gguf` | 9858 | `vibevoice_asr_q8_0` | up_to_date | — |
| `voxcpm1` | voxcpm1 | tts | TTS | `voxcpm-0.5b-q8_0-audiovae-f16.gguf` | 847 | `voxcpm1_0_5b_q8_0` | up_to_date | — |
| `voxcpm2` | voxcpm2 | tts | TTS | `voxcpm2-bf16.gguf` | 4772 | `voxcpm2_bf16` | up_to_date | — |
| `voxtral-realtime` | voxtral_realtime | asr | STT | `voxtral-mini-4b-realtime-2602-q8_0.gguf` | 5104 | `voxtral_realtime_q8_0` | up_to_date | — |

## Plugin dynamic refresh + sorting (verification note)

- **Refresh is fully live.** `refreshModels()` calls `get_models` → the host
  `fetchModels()` hits `GET <endpoint>/v1/models` every time; nothing is hardcoded
  (`lib/index.js` `fetchModels`). A new wired model appears on the next refresh with
  no plugin change. Re-downloading a file does **not** change `/v1/models` (same id +
  path), so the plugin list is unaffected — the fix is at the byte/provenance layer.
- **Sorting: DONE 2026-09-20.** `refreshModels()` now sorts `r.models` by `id`
  (`localeCompare`) once at ingestion, so the TTS/STT dropdowns, the ModelsPane chips,
  and the first-listed fallback all agree on a stable alphabetical order instead of the
  arbitrary server-config order the engine returns (client.js only → browser refresh).

## Design capability & built-in speakers (2026-09-20 analysis)

- **Design-capable families = the engine accepts an `instruction`/`instruct` option**
  (speech body `instructions` → `options["instruction"]`, runtime.cpp:1998). Per
  `model_specs` `tasks`, among **wired** models the design-capable families are:
  **`qwen3_tts`** (base, customvoice, voicedesign), **`omnivoice`** (q8 + f16),
  **`voxcpm2`**, **`breeze_tts`**. Not only qwen. (Design-capable but **not wired**
  here: `firered_audio`, `fireredtts3`, `irodori_tts`, `moss_voicegen` — would surface
  automatically if those models get wired, they share the option.)
- **How the plugin treats design now:** a `vdes`-task model (`qwen3-voicedesign`) is
  design-only — the description is the voice, no voice select. The others were wired as
  `tts`/`clon`, so the plugin never offered design UI for them even though the engine
  accepts an instruction. `qwen3-customvoice` specifically honours `custom_voice.instruct`
  (session.cpp:620) = the emotion/style fine control that was requested.
- **Interface change made (client.js, browser refresh):** a client-side
  `DESIGN_FAMILIES = [qwen3_tts, omnivoice, voxcpm2, breeze_tts]` set drives (a) a
  "◆ design" tag + purple highlight on those model chips/options, and (b) an optional
  **Style / emotion instruction** textarea for design-capable non-vdes models (voice
  select stays). Dispatch forwards it as `instructions`; the engine consumes it per
  family. No host change — the `instructions` key already rides through (verified).
- **Built-in / engine-included speakers:** the engine voice endpoint is **process-wide**
  (`GET /v1/audio/voices` always returns `["bijan_0048","test"]`, ignores `?model=`), so
  it reports **no** per-model speakers. The only families that declare bundled speakers
  in `model_specs` are **`pocket_tts` (`alba`, wired)** and **`kokoro_tts` (54 voices,
  NOT wired)** — which is why `alba` is the sole engine voice ever listed. Other models'
  "voices" are clone references (server-dir / registry / uploaded), not presets. To list
  more named speakers we would have to wire `kokoro_tts`; there is no hidden per-model
  speaker list to surface for the currently wired models.

## Open follow-ups found this pass

- The plugin's `models_audit` host route is **non-functional on this node**: it scans
  `/mnt/llama/audio.cpp` and the engine-checkout paths under the home tree of the machine the host runs on, via the shell, but those live on
  cpu1, not on this DSH host — so `GET /api/audio-play/models_audit` (the route name of the
  day this was written) returns
  `{ok:false,error:"store scan failed"}`. The webui `package-sizes` endpoint (used here)
  is the working equivalent. Worth re-pointing/removing that route (consented restart).
  **DONE 2026-10-25 (T-641 items 10.2 / 16): this bullet is superseded, and the diagnosis was right.**
  The local scan is gone from `lib/index.js`; `models_audit` now asks each engine its own
  `GET /v1/ui/models-root` and `GET /v1/ui/models/package-sizes` (the "working equivalent" named
  above) and joins them to that lane's configured model paths, per endpoint. The new verb
  `GET endpoint_library {fn?,id?,fresh?}` answers the same read on its own. What this file's bullet
  did not know then: the census is a **job** (the first GET answers `pending`), it covers **packages
  the downloader knows** (403 rows measured 2026-10-25, both CPU nodes) and not arbitrary files on
  the shelf, so the audit states `census_covers_packages_only:true` instead of claiming a file audit.
  Host-side code: it goes live on the operator's restart OK, not before.

## Re-read 2026-11-14 (Berlin) — what this snapshot does and does not still describe

**No row above was edited.** `tests/host.test.cjs` reads this file with a real `readFileSync` and pins the
`fish_audio` row — task `clon`, "TTS (clone)", `up_to_date` — because the plugin's curated display tag cites this
table as its evidence. That row is a fixture.

1. The 41 wired models this snapshot lists are **all still listed** by at least one slot today, checked against the
   live catalogs read on 2026-11-14 (`scratch/model_reads_20261114.json`; the model-by-model comparison is written up
   in the re-read section of `MODELS_TABLE.md`). Nothing this file recorded as repaired has gone missing.
2. **The shelf has grown by 24 ids since this snapshot**, among them the multi-voice dialogue family, three
   diarisation models, three ASR models, a voice-conversion model, an RVC model, a forced aligner and several small
   speech models. The names and the count are in `MODELS_TABLE.md`'s re-read section. They are not rows here: this
   file is the record of the 2026-09-20 remediation, and a remediation record does not grow by absorbing models it
   never saw.
3. **What was not re-checked:** the per-file byte sizes and the `version_state` of each package against the engine's
   downloader. That read is a `GET /v1/ui/models/package-sizes` against one engine and it belongs to a session that is
   repairing the shelf, not to this pass. The `not_installed` / `up_to_date` counts above are 2026-09-20 numbers.
4. **What is unchanged about this file's own status:** the shelf is legacy for the plugin (T-217 — the plugin's voice
   store is the single voice entity, and no `ssh` or `scp` step is in the host half), and a model's availability today
   is read from the endpoint's catalog. This file stays the record of that remediation.
