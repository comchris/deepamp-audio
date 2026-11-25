#!/usr/bin/env python3
"""Verify a dispatch_batch render: who actually spoke, and was the text spoken.

Reads the plugin's own rows (batch_status / job_status), then for every finished part
dispatches nemotron_3_diar on the part's audio and (optionally) qwen3_asr, and compares
what the diarizer heard against the cast and script the plugin sent.

Usage:
  python3 scripts/batch_verify.py --batch-id b-123456 [--asr] [--max-wait 3600]
                                  [--out artifacts/batch_verify_<batch_id>]
                                  [--min-speech-ratio 0.70] [--chars-per-sec 15.0]

  python3 scripts/batch_verify.py --from-report artifacts/batch_verify_b-760790/report.json
                                  [--chars-per-sec 15.0] [--min-speech-ratio 0.70]
                                  [--script-source <home>/.dsh/deepamp-audio/state.json]
      Re-score an EXISTING report offline and write report_v2.json + report_v2.md next to it.
      This mode makes ZERO network calls: it never enters the HTTP helper (see _OFFLINE), and
      the scripted text it needs is read from the report itself or from --script-source (a JSON
      file on disk carrying the plugin's own rows). It dispatches nothing.

  python3 scripts/batch_verify.py --from-report <report.json> --speaker-audit
                                  [--manifest <batch_id>_manifest.json] [--save-audit audit.json]
                                  [--rerender-hint] [--speaker-audit-timeout 900] [--api-base URL]
      T-193 SPEAKER AUDIT (live): for every part of an already-verified batch, POST the part's own
      WAV to dispatch_speaker_asr and count how many speakers that lane actually hears. Writes
      report_v3.json + report_v3.md next to the report; this mode does NOT write report.json or
      report_v2.*. Parts are audited ONE AT A TIME, sequentially, in a plain for loop - the plugin
      serialises one job per machine, so this never fires parallel dispatches.

  python3 scripts/batch_verify.py --from-audit audit.json [--from-report <report.json>]
                                  [--rerender-hint] [--manifest <batch_id>_manifest.json]
      T-193 SPEAKER AUDIT (offline): re-judge a previously saved raw audit with ZERO network calls,
      through the SAME verdict code path the live audit uses. --from-report is optional and only
      brings the older diar / coverage / speech metrics along into the same v3 report.

WHAT THE SPEAKER AUDIT MEANS (T-193)
  diar_speakers_found  = number of DISTINCT speaker ids the dispatch_speaker_asr lane reports for
                         the part's audio (defaults: speaker_mode masked, speaker_min_frames 30 -
                         the knobs the measured 2026-10-04 sweep used).
  expected_speakers    = number of voices in that part's cast: the batch manifest's
                         part_records[].cast when --manifest is given, else the report's own cast.
  speaker_verdict      = SPEAKERS_OK (found == expected) | SPEAKER_SWITCH_MISSING (found <
                         expected) | TOO_MANY_SPEAKERS (found > expected) | UNVERIFIABLE (the lane
                         refused, errored or was unreachable; the part's WAV is missing; or the
                         part carries no cast to compare against).

  SPEAKER_SWITCH_MISSING claims exactly one thing: the diar frame probabilities see FEWER voices
  than the part's cast. It does NOT claim a line is missing - on b-760790 parts 3, 7 and 10 the
  words are all present (script coverage 0.963-0.983) and the second speaker's lines were rendered
  IN THE FIRST SPEAKER'S VOICE. It also never says WHICH voice collapsed: the lane's speaker ids
  are positional slots, not identities.

WHAT IT MEASURES PER PART
  status, cast sent, audio seconds, max_frames, diar turn count, speakers heard vs cast size
  (MATCH / MISMATCH), seconds per speaker, min confidence, script coverage with --asr, and
  since T-187a:

  speech_ratio        = (sum of diar turn durations) / (audio seconds of the part).
                        Measured on b-760790 (10 parts, 2 voices per take, 15 s references):
                        295.4 s of 424.2 s is speech = 0.696 overall, and parts 6 and 8 are
                        0.50 and 0.45 - half the take is silence-or-noise, which is exactly
                        what a listener hears as "strange pauses". A part under
                        --min-speech-ratio (default 0.70) is FLAGGED SUSPECT. SUSPECT IS A
                        FLAG, NOT A FAILURE: it changes no exit code, no per-part status and
                        no existing key.

  voice attribution   = per cast voice EXPECTED seconds (that voice's scripted characters /
                        --chars-per-sec) against the diar HEARD seconds. Default 15.0 chars/s
                        is the plugin's own BATCH_CHARS_PER_SEC (lib/index.js:1382); the
                        measured band on this lane is 12-20 chars per second of speech
                        (b-343456 part 2 = 12.0, part 1 = 20.4), so an expectation is a BAND,
                        not a promise. nemotron_3_diar emits turns with NO text, so diar
                        speaker ids are positional labels, not identities: the verdicts are
                        POSITIONAL (cast order against heard speakers ranked by seconds) and
                        say "a voice of this size was heard", never "this voice was heard".
                        That is the honest version of what b-760790 parts 3, 7 and 10 could
                        not say before (1 speaker heard against a cast of 2, coverage 0.963-
                        0.983 - a collapsed render and a merged diar track look identical).

NEW REPORT KEYS (all additive; report.json / report_v2.json)
  top level:  min_speech_ratio, chars_per_sec, matching_rule,
              totals {audio_seconds, speech_seconds, speech_ratio, suspect_parts}
  per part:   speech_seconds, speech_ratio, speech_flag ("SUSPECT" | "OK"),
              script_chars_per_voice {voice: chars}, expected_seconds_per_voice [floats in
              cast order], script_source ("job_row" | "report" | "script_source" | "none"),
              heard_seconds_ranked [{speaker, seconds}],
              voice_verdicts [{voice, expected_seconds, heard_speaker, heard_seconds, verdict}]
  verdicts:   PRESENT      heard >= 0.5 x expected
              SHORT        0 < heard < 0.5 x expected
              MISSING      no heard speaker left to match (fewer speakers heard than cast)
              UNVERIFIABLE diar produced no usable turns for the part
              NO_SCRIPT    the part's scripted text is not available (an older report.json
                           never stored it and no --script-source was given) - reported
                           instead of guessed

NEW SPEAKER-AUDIT KEYS (T-193; all additive, present only in a report that ran the audit -
report_v3.json / report_v3.md; a report with no audit renders byte-for-byte as before)
  top level:  speaker_audit_options {api_base, route, diar_model, diar_model_source, asr_model,
              asr_model_source, speaker_mode, speaker_min_frames, timeout_s} - the two `_source`
              keys name the authority that chose each model (`given_by_caller` /
              `live_catalog_read` / `named_fallback_*`), added 2026-11-11 by WM-42 item 5,
              speaker_totals {parts_audited, parts_speakers_ok, parts_speaker_switch_missing,
              parts_too_many_speakers, parts_unverifiable, rerender_parts, rerender_line},
              speaker_audit_rule
  per part:   diar_speakers_found (int), expected_speakers (int), speaker_verdict,
              speaker_audit {source ("live" | "saved_audit"), lane_job_id, lane_status,
              lane_error (the host's own sentence, verbatim), lane_stage, lane_refusal,
              request (the exact body sent), turns, speakers_found [ids],
              speakers_found_count, seconds_per_speaker {id: seconds}, expected_speakers,
              expected_cast, verdict, note, audio_path, elapsed_s, speaker_asr (the lane's own
              record, verbatim)}

Nothing here talks to the engine directly: every live call is a plugin route, so it is safe to
run while other plugin jobs are queued (the plugin serialises them).
"""
import argparse
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.request

ORIGIN = os.environ.get("DSH_WEB_URL") or "http://127.0.0.1:3080"
API = ORIGIN + "/api/deepamp/"
# --api-base overrides this for the speaker audit only; the default is the same URL the pre-T-193
# flags have always used, so an existing command line is unchanged.
API_BASE = API

# The plugin's diar transcript line is `SPEAKER <id> [start s-end s] (conf)` where <id> is
# whatever the engine returned - live format is `speaker_0`, not a bare digit (verified against
# rows ap-0291/ap-0292). A regex that required `(\d+)` parsed ZERO turns out of a real transcript.
TURN_RE = re.compile(
    r"^SPEAKER\s+(\S+)\s+\[([\d.]+)s\s*-\s*([\d.]+)s\](?:\s*\(([^)]*)\))?", re.I)

# Part text is tagged `[S1] ... [S2] ...` POSITIONALLY: lib/index.js:3586-3588 assigns tag k+1
# to cast slot k of THAT PART (part-local cast), so tag N is cast[N-1]. Same convention as
# batch_part_extract.py:33.
TAG_RE = re.compile(r"^\[S(\d+)\]\s?(.*)$")

DEFAULT_MIN_SPEECH_RATIO = 0.70
# 15.0 is the plugin's own split estimate (BATCH_CHARS_PER_SEC, lib/index.js:1382). It is the
# SLOW end of the measured band on this lane (12-20 chars per second of speech), so expected
# seconds read as a floor-ish band, not a promise.
DEFAULT_CHARS_PER_SEC = 15.0

MATCHING_RULE = (
    "voice verdicts are POSITIONAL, not identity-based: cast order is matched against the diar "
    "speakers ranked by heard seconds (highest first). nemotron_3_diar turns carry no text, so "
    "a diar speaker id is a slot, not a voice.")

# Set by --from-report. `call()` is the ONLY place this file touches the network, so refusing
# there makes "the offline mode makes no HTTP call" a property of the code path, not a promise.
_OFFLINE = False


def norm_speaker(raw):
    """`speaker_0` -> 0, `S2` -> 2, `0` -> 0, anything else kept verbatim."""
    s = str(raw if raw is not None else "").strip()
    m = re.search(r"(\d+)$", s)
    return int(m.group(1)) if m else (s or "?")


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def call(route, payload=None, timeout=60):
    if _OFFLINE:
        raise AssertionError(
            "offline mode: --from-report must not make any HTTP call (route %r)" % route)
    url = API_BASE + route
    if payload is None:
        req = urllib.request.Request(url)
    else:
        data = json.dumps(payload).encode()
        req = urllib.request.Request(url, data=data,
                                     headers={"Content-Type": "application/json"},
                                     method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def get_job(job_id):
    d = call("job_status?job_id=" + job_id)
    return d.get("job") or d


def wait_job(job_id, max_wait):
    """Poll a plugin row. This is a plugin queue poll, not an engine /status probe.

    Terminal statuses are the PLUGIN's words: ok / error / aborted / cancelled. (An earlier
    version of this file polled for "done"/"finished", which the plugin never emits, so every
    verification job burned the whole --max-wait before returning.)
    """
    t0 = time.time()
    while time.time() - t0 < max_wait:
        j = get_job(job_id)
        if j.get("status") in ("ok", "error", "aborted", "cancelled"):
            return j
        time.sleep(10)
    return get_job(job_id)


def turns_from_row(job):
    """Prefer the structured turns the plugin owns: {speaker_id, start, end, confidence, text}.

    The plugin stores turns in SECONDS on the row (job_status slices 300 of them), so the
    structured leg needs no parsing at all. The transcript is the fallback.
    """
    out = []
    for t in (job.get("speaker_turns") or []):
        if not isinstance(t, dict):
            continue
        out.append({
            "speaker_id": norm_speaker(t.get("speaker_id")),
            "start": num(t.get("start")) or 0.0,
            "end": num(t.get("end")) or 0.0,
            "confidence": num(t.get("confidence")),
        })
    return out


def parse_turns(transcript):
    turns = []
    for line in (transcript or "").splitlines():
        m = TURN_RE.match(line.strip())
        if not m:
            continue
        turns.append({
            "speaker_id": norm_speaker(m.group(1)),
            "start": num(m.group(2)) or 0.0,
            "end": num(m.group(3)) or 0.0,
            "confidence": num(m.group(4)),
        })
    return turns


def words(text):
    return re.findall(r"[a-z0-9']+", (text or "").lower())


def overlap_ratio(spoken, expected):
    a, b = words(spoken), words(expected)
    if not b:
        return None
    # multiset containment: how much of the expected script appears in the transcript
    pool = {}
    for w in a:
        pool[w] = pool.get(w, 0) + 1
    hit = 0
    for w in b:
        if pool.get(w, 0) > 0:
            pool[w] -= 1
            hit += 1
    return round(hit / len(b), 3)


# ---------------------------------------------------------------- T-187a: speech ratio + attribution

def script_chars_per_voice(text, cast):
    """Characters each cast slot speaks in a part's [S1..Sk] text.

    Tags are POSITIONAL (tag N = cast[N-1] of this part). An untagged line continues the
    previous speaker - same rule as batch_part_extract.py. Text tagged outside the part's cast
    is counted as `unmapped` rather than dropped silently.

    Returns (chars_by_cast_slot, unmapped_chars).
    """
    counts = [0] * len(cast)
    unmapped = 0
    cur = None
    for raw in (text or "").split("\n"):
        line = raw.strip()
        if not line:
            continue
        m = TAG_RE.match(line)
        if m:
            idx = int(m.group(1)) - 1
            body = m.group(2).strip()
            if 0 <= idx < len(counts):
                counts[idx] += len(body)
                cur = idx
            else:
                unmapped += len(body)
                cur = None
        elif cur is not None:
            counts[cur] += len(line)
        else:
            unmapped += len(line)
    return counts, unmapped


def heard_ranked(seconds_per_speaker):
    """[(speaker_id, seconds)] sorted by seconds descending; the id only breaks ties.

    The id is normalised with norm_speaker because JSON turns `seconds_per_speaker` keys into
    strings: without it the live path (int 0) and an offline re-score (str "0") would report
    the same speaker differently.
    """
    items = []
    for k, v in (seconds_per_speaker or {}).items():
        items.append((norm_speaker(k), num(v) or 0.0))
    return sorted(items, key=lambda kv: (-kv[1], str(kv[0])))


def voice_verdicts(cast, expected, ranked, diar_usable):
    """Verdict per NAMED cast voice, in cast order, against the heard speakers ranked by seconds.

    The pairing is positional (see MATCHING_RULE): cast slot 0 takes the biggest heard speaker,
    cast slot 1 the next, and so on. A cast voice with no scripted lines cannot be scored and
    is skipped (it is not part of cast_size either).
    """
    out = []
    pool = list(ranked)
    for i, voice in enumerate(cast):
        if not voice:
            continue
        exp = expected[i] if i < len(expected) else None
        rec = {"voice": voice, "expected_seconds": exp,
               "heard_speaker": None, "heard_seconds": None, "verdict": "MISSING"}
        if not diar_usable:
            rec["verdict"] = "UNVERIFIABLE"
        elif exp is None:
            rec["verdict"] = "NO_SCRIPT"
        elif not pool:
            rec["verdict"] = "MISSING"
        else:
            sid, hs = pool.pop(0)
            rec["heard_speaker"] = sid
            rec["heard_seconds"] = round(hs, 2)
            if hs >= 0.5 * exp:
                rec["verdict"] = "PRESENT"
            elif hs > 0:
                rec["verdict"] = "SHORT"
            else:
                # a matched diar speaker with 0 s of speech is not evidence of a voice
                rec["verdict"] = "MISSING"
        out.append(rec)
    return out


def add_part_metrics(info, min_ratio, chars_per_sec, script_text=None, script_origin="job_row"):
    """Attach the T-187a keys to one part record. Additive: no existing key is touched.

    `script_text` is the part's own [S1..Sk] text when the caller has it (the live path reads
    it off the job row -> script_origin "job_row"; --from-report reads it off --script-source
    -> "script_source"). If the record already carries `script_chars_per_voice` from an earlier
    run, that is reused so re-scoring stays self-contained and a different --chars-per-sec can
    still be applied.
    """
    cast = list(info.get("cast") or [])
    audio = num(info.get("audio_seconds"))

    # --- speech_ratio: how much of the take is inside a diar turn at all.
    # Summed from seconds_per_speaker (the same numbers an offline re-score has), so the live
    # and the offline path cannot drift apart by rounding.
    if "seconds_per_speaker" in info:
        speech = round(sum((num(v) or 0.0) for v in (info.get("seconds_per_speaker") or {}).values()), 2)
        ratio = round(speech / audio, 3) if audio else None
        info["speech_seconds"] = speech
        info["speech_ratio"] = ratio
        info["speech_flag"] = (None if ratio is None
                               else ("SUSPECT" if ratio < min_ratio else "OK"))

    # --- expected seconds per cast voice, from the part's own scripted text.
    stored = info.get("script_chars_per_voice")
    if stored is None and script_text:
        counts, unmapped = script_chars_per_voice(script_text, cast)
        stored = {}
        for i, v in enumerate(cast):
            if v:
                stored[v] = stored.get(v, 0) + counts[i]
        info["script_chars_per_voice"] = stored
        info["script_source"] = script_origin
        if unmapped:
            info["script_unmapped_chars"] = unmapped
    elif stored is not None:
        info["script_source"] = "report"
    elif info.get("script_source") is None:
        info["script_source"] = "none"

    expected = [round(stored[v] / chars_per_sec, 2) if stored and v in stored else None
                for v in cast]
    info["expected_seconds_per_voice"] = expected
    ranked = heard_ranked(info.get("seconds_per_speaker"))
    info["heard_seconds_ranked"] = [{"speaker": s, "seconds": round(sec, 2)} for s, sec in ranked]
    diar_usable = bool(info.get("turns")) and bool(ranked)
    info["voice_verdicts"] = voice_verdicts(cast, expected, ranked, diar_usable)
    return info


def add_report_totals(report):
    audio = 0.0
    speech = 0.0
    suspect = []
    for p in report.get("parts") or []:
        a = num(p.get("audio_seconds"))
        if a:
            audio += a
        s = num(p.get("speech_seconds"))
        if s:
            speech += s
        if p.get("speech_flag") == "SUSPECT":
            suspect.append(p.get("part"))
    report["totals"] = {
        "audio_seconds": round(audio, 2),
        "speech_seconds": round(speech, 2),
        "speech_ratio": (round(speech / audio, 3) if audio else None),
        "suspect_parts": suspect,
    }
    return report


def load_script_rows(path):
    """Offline source of a part's scripted text: a JSON file that carries the plugin's own rows.

    An OLD report.json stores the coverage SCORE but not the script it was scored against, so
    --from-report cannot invent expected seconds. It reads the text from disk instead: the
    plugin's persisted state file ({"playlist": [row, ...]}), a bare list of rows, or a
    {job_id: row} mapping. Rows are matched by job id first, then by (batch_id, batch_part).
    File read only - no HTTP.
    """
    with open(path) as f:
        doc = json.load(f)
    if isinstance(doc, dict):
        rows = doc.get("playlist") or doc.get("rows") or doc.get("jobs") or doc
    else:
        rows = doc
    by_job = {}
    by_part = {}
    if isinstance(rows, dict):
        # {job_id: row} - the key is the job id when the row does not carry one itself.
        rows = [dict(v, id=v.get("id") or k) if isinstance(v, dict) else v
                for k, v in rows.items()]
    for row in rows:
        if not isinstance(row, dict):
            continue
        text = row.get("text")
        if not text:
            continue
        jid = row.get("id") or row.get("job_id")
        if jid:
            by_job[str(jid)] = text
        if row.get("batch_id") is not None and row.get("batch_part") is not None:
            by_part[(str(row.get("batch_id")), row.get("batch_part"))] = text
    return {"by_job": by_job, "by_part": by_part}


def script_for_part(info, batch_id, rows):
    """The part's scripted text, matched by job id (exact) then by (batch_id, part)."""
    if not rows:
        return None
    jid = info.get("job_id")
    if jid and str(jid) in rows["by_job"]:
        return rows["by_job"][str(jid)]
    key = (str(batch_id or ""), info.get("part"))
    return rows["by_part"].get(key)


# ---------------------------------------------------------------- T-193: speaker audit (verify-then-rerender)
#
# WHY (measured 2026-10-04/05, TODOS.md T-193): on b-760790 the batch lane sent correct tagged text
# and a 2-voice cast for every part, but parts 3, 7 and 10 rendered the second speaker's lines IN
# THE FIRST SPEAKER'S VOICE. Two independent methods on the same audio agree: the nemotron_3_diar
# frame probabilities for part 3 (3912x8 float32) put 2802.9 of the total 2803.0 mass in column 0
# (argmax count 3912 / 0 / ...), and attribution-mode ASR transcribed the missing lines inside
# speaker_0's turns (part 7's `Or sabotaged.` came out as "For sabotage" glued to the next line).
# Part 1 - same two voices, longer alternating turns - split cleanly 71.52 s / 22.64 s, and part 5
# honored a 0.72 s second-speaker turn, so this is per-render stochastic model behaviour, not a
# length rule and not a lane artifact.
#
# THE AUDIT: ask the speaker-ASR lane how many speakers it actually hears in the part's WAV, compare
# that with the part's cast, and flag only the bad parts for a re-render. This code renders nothing,
# re-renders nothing, and dispatches nothing except the audit lane itself.
#
# THE LANE (lib/index.js handleDispatchSpeakerAsr; route contract lib/index.js:7262-7268):
#   POST <api_base>dispatch_speaker_asr
#   body {file_path, diar_model?, asr_model?, speaker_mode?, speaker_min_frames?,
#         speaker_threshold?, speaker_pad_frames?, speaker_mask?, speaker_segment_gap_sec?,
#         speaker_segment_max_sec?, lookahead_tokens?, max_tokens?, return_timestamps?, language?}
#   ok   {ok:true, job_id, transcript, speaker_turns:[{speaker_id,start,end,confidence,text}],
#         diar_options, asr_options, speaker_asr:{diar_model, asr_model, diar_options, asr_options,
#         remote_audio, artifact_file, artifact_path, artifact_kind, frames, speakers, bytes,
#         seglst_file, stage}}
#   fail {ok:false, job_id?, status?, error, speaker_asr?{... stage ...}}
# `start`/`end` are SECONDS (the route divides the engine's sample offsets by 16000), so the same
# turns_from_row() the diar lane already feeds is reused here. The route is BLOCKING like
# dispatch_stt: the response resolves when the row reaches a terminal state, so the HTTP timeout has
# to cover the whole two-model job (diar -> artifact -> asr), not just the enqueue.
# `return_frame_probabilities` is the route's own guarantee (always true there); this file never
# sends it, because sending false is a refusal.

SPEAKER_ASR_ROUTE = "dispatch_speaker_asr"
DEFAULT_API_BASE = API
DEFAULT_SPEAKER_AUDIT_TIMEOUT = 900
# Named FALLBACKS, not the choice. The pair a run audits with is read off the live STT catalog by
# audit_models() below; these two are what runs when that read answers nothing, and they are printed
# as the fallbacks they are. They are the pair the measured 2026-10-04 sweep used (TODOS.md T-193
# table, jobs ap-0386..ap-0397), which is why these two are the named ones.
# (WM-23 item 9, carried as WM-42 item 5; operator ruling of 2026-11-11, verbatim: "handle like the
# other 2 scripts!")
AUDIT_DIAR_MODEL = "nemotron_3_diar"
AUDIT_ASR_MODEL = "nemotron_asr"
# A diar model this audit chain cannot use, named by FAMILY because the refusal is about what the
# model produces: the sortformer diar variants do not produce the speaker_probabilities artifact this
# chain feeds on, and the lane refuses them. Naming the family covers every quant of it a catalog
# lists. This is a capability fact, not a preference - re-verify it against the lane after an engine
# update rather than trusting it across one.
AUDIT_DIAR_REFUSED_FAMILIES = ("sortformer_diar",)
AUDIT_SPEAKER_MODE = "masked"
AUDIT_SPEAKER_MIN_FRAMES = 30

V_SPEAKERS_OK = "SPEAKERS_OK"
V_SWITCH_MISSING = "SPEAKER_SWITCH_MISSING"
V_TOO_MANY = "TOO_MANY_SPEAKERS"
V_UNVERIFIABLE = "UNVERIFIABLE"

SPEAKER_AUDIT_RULE = (
    "speaker_verdict compares the number of DISTINCT speaker ids the dispatch_speaker_asr lane "
    "reports for the part's audio against the number of voices in that part's cast. "
    "SPEAKER_SWITCH_MISSING means the diar frame probabilities see FEWER voices than the cast: the "
    "WORDS may still all be present (measured on b-760790 parts 3, 7 and 10: script coverage "
    "0.963-0.983 with 1 speaker heard against a cast of 2). It does not claim a line is missing, "
    "and it does not say WHICH voice collapsed - the lane's speaker ids are positional slots. "
    "The speaker seconds are the lane's own turn seconds (this chain's diar turns carry padding), "
    "so they can read slightly wider than a plain diar run's seconds - the verdict uses the speaker "
    "COUNT only.")

FAILURE_NOTES = {
    "no_audio": "no call was made: the part's WAV is not on disk, so the speaker count was never measured",
    "unreachable": "no call succeeded: the plugin API is not answering, so the speaker count was never measured",
    "timeout": "the lane accepted the job and never answered within --speaker-audit-timeout; the speaker count for this part was never measured",
    "http": "the lane answered with a non-2xx status; no speaker count was returned",
    "bad_json": "the lane's answer was not JSON; no speaker count was returned",
    "not_audited": "this part has no entry in the saved audit file; no speaker count was measured",
    "skipped_chain": "not attempted: an earlier part of this run found the plugin API unreachable, and the audit does not keep calling into a dead API",
}


def api_url(route, base=None):
    """Full URL of a plugin route under the (possibly --api-base-overridden) API root."""
    return (base or API_BASE) + route


def classify_http_error(exc):
    """(kind, message) for a failed audit call. The kind decides what happens to the NEXT part.

    unreachable : the connection itself failed (refused / no listener / DNS). The plugin is not
                  answering, so every remaining part would fail the same way: the audit records the
                  same error on each of them instead of burning --speaker-audit-timeout per part.
    timeout     : the request was accepted and the lane did not answer in time. That is a fact about
                  THIS part's job, not about the plugin, so the next part is still tried.
    http        : the plugin answered with a non-2xx status. The body is recorded verbatim.
    bad_json    : the answer was not JSON.
    """
    if isinstance(exc, urllib.error.HTTPError):
        body = ""
        try:
            body = exc.read().decode("utf-8", "replace")[:600]
        except Exception:
            body = ""
        return "http", "HTTP %s %s%s" % (exc.code, exc.reason, (": " + body) if body else "")
    if isinstance(exc, socket.timeout):
        return "timeout", "the lane did not answer within the per-part timeout: %s" % exc
    if isinstance(exc, urllib.error.URLError):
        if isinstance(exc.reason, socket.timeout):
            return "timeout", "the lane did not answer within the per-part timeout: %s" % exc.reason
        return "unreachable", "plugin API unreachable at %s: %s" % (api_url(SPEAKER_ASR_ROUTE), exc.reason)
    if isinstance(exc, OSError):
        return "unreachable", "plugin API unreachable at %s: %s" % (api_url(SPEAKER_ASR_ROUTE), exc)
    if isinstance(exc, ValueError):
        return "bad_json", "lane answer was not JSON: %s" % exc
    return "http", "speaker audit call failed: %s" % exc


def speaker_audit_request(audio_path, diar_model=AUDIT_DIAR_MODEL, asr_model=AUDIT_ASR_MODEL,
                          speaker_mode=AUDIT_SPEAKER_MODE, speaker_min_frames=AUDIT_SPEAKER_MIN_FRAMES):
    """The audit body. Only the knobs this file sets are sent; everything else stays off the wire
    and the engine's own default applies (the plugin's own rule for this route)."""
    return {"file_path": audio_path,
            "diar_model": diar_model,
            "asr_model": asr_model,
            "speaker_mode": speaker_mode,
            "speaker_min_frames": speaker_min_frames}


_AUDIT_MODELS = None


def audit_models(args):
    """The pair this run audits with, and how each half of it was chosen. Resolved ONCE per run.

    A caller that names `--speaker-audit-diar-model` or `--speaker-audit-asr-model` is never
    second-guessed: what was named is used and recorded as given_by_caller. What is not named is
    read off the live catalog the audit lane itself serves (`get_models?fn=stt`), which answers
    `task` (`diar` / `asr`) and `loaded` per model: this chain needs one of each, and a model the
    engine already holds is preferred, because a default that forces a load on BOTH halves of a
    two-model chain is a cost, not a default. A diar model in AUDIT_DIAR_REFUSED_FAMILIES is not a
    candidate at all - the lane refuses that chain. The named fallbacks are used only when the read
    answers nothing, and the source recorded in the report says which of these happened.
    (WM-23 item 9 / WM-42 item 5: "handle like the other 2 scripts!" - the same shape
    `voice_solo_probe.py` and `agent_control.sh` use.)
    """
    global _AUDIT_MODELS
    if _AUDIT_MODELS is not None:
        return _AUDIT_MODELS
    named = {"diar": args.speaker_audit_diar_model, "asr": args.speaker_audit_asr_model}
    if named["diar"] and named["asr"]:
        _AUDIT_MODELS = {"diar_model": named["diar"], "asr_model": named["asr"],
                         "diar_source": "given_by_caller", "asr_source": "given_by_caller",
                         "catalog_read": None}
        return _AUDIT_MODELS
    rows, read_error = [], None
    try:
        rows = [m for m in (call("get_models?fn=stt").get("models") or [])
                if isinstance(m, dict) and m.get("id")]
    except Exception as exc:
        read_error = "%s" % exc

    def pick(task, fallback, refused_families=()):
        if named[task]:
            return named[task], "given_by_caller"
        if read_error is not None:
            return fallback, "named_fallback_after_failed_catalog_read"
        cands = [m for m in rows if m.get("task") == task
                 and m.get("family") not in refused_families]
        got = (next((m["id"] for m in cands if m.get("loaded")), None)
               or next((m["id"] for m in cands), None))
        if got:
            return got, "live_catalog_read"
        return fallback, "named_fallback_catalog_lists_none_for_that_task"

    diar, diar_src = pick("diar", AUDIT_DIAR_MODEL, AUDIT_DIAR_REFUSED_FAMILIES)
    asr, asr_src = pick("asr", AUDIT_ASR_MODEL)
    _AUDIT_MODELS = {"diar_model": diar, "asr_model": asr, "diar_source": diar_src,
                     "asr_source": asr_src, "catalog_read": api_url("get_models?fn=stt")}
    if read_error is not None:
        print("[verify] the STT catalog read at %s answered nothing (%s); auditing on the named "
              "fallbacks %s / %s - the lane may still refuse them, and the --speaker-audit-*-model "
              "flags override this." % (_AUDIT_MODELS["catalog_read"], read_error, diar, asr))
    else:
        n_d = len([m for m in rows if m.get("task") == "diar"
                   and m.get("family") not in AUDIT_DIAR_REFUSED_FAMILIES])
        n_a = len([m for m in rows if m.get("task") == "asr"])
        print("[verify] audit models resolved from the live catalog read at %s: diar=%s asr=%s "
              "(%d of %d listed models serve diar after the families this chain cannot use, %d serve "
              "asr; a loaded model was preferred%s)."
              % (_AUDIT_MODELS["catalog_read"], diar, asr, n_d, len(rows), n_a,
                 "" if any(m.get("loaded") for m in rows if m.get("task") in ("diar", "asr"))
                 else ", and none was loaded"))
    return _AUDIT_MODELS


def audit_options(args):
    """What this audit run actually used - recorded in both the report and the saved audit file.
    The two `_source` keys say which authority chose each model, so a later read of an old report
    can tell a named model from a resolved one."""
    chosen = audit_models(args)
    return {"api_base": api_url(""), "route": SPEAKER_ASR_ROUTE,
            "diar_model": chosen["diar_model"], "asr_model": chosen["asr_model"],
            "diar_model_source": chosen["diar_source"], "asr_model_source": chosen["asr_source"],
            "speaker_mode": args.speaker_mode, "speaker_min_frames": args.speaker_min_frames,
            "timeout_s": args.speaker_audit_timeout}


def audit_lane_live(audio_path, args):
    """ONE blocking POST to the audit lane. (request body, raw response, call failure).

    Sequential by construction: this is a plain blocking call and the caller loops over parts, so
    only one audit job is ever in flight. The plugin serialises one job per machine
    (max_loaded_models=1), and firing these in parallel would just queue them against each other.
    """
    chosen = audit_models(args)
    body = speaker_audit_request(audio_path, chosen["diar_model"], chosen["asr_model"],
                                 args.speaker_mode, args.speaker_min_frames)
    try:
        return body, call(SPEAKER_ASR_ROUTE, body, timeout=args.speaker_audit_timeout), None
    except AssertionError:
        raise  # the _OFFLINE guard is a programming error, never a part verdict
    except (urllib.error.HTTPError, urllib.error.URLError, socket.timeout, OSError, ValueError) as e:
        kind, msg = classify_http_error(e)
        return body, None, {"kind": kind, "error": msg}


def judge_speaker_audit(cast, lane, failure, source, audio_path=None, request=None, elapsed_s=None):
    """THE speaker rule, shared by the live audit, the saved-audit re-judge, the missing WAV and the
    unreachable API. The three modes differ only in what `lane` and `failure` hold.

    found    = number of DISTINCT speaker ids in the lane's speaker_turns (norm_speaker applied, so
               `speaker_0` and `0` are one speaker, exactly as the diar metrics already count them).
    expected = number of non-empty voices in the part's cast.

      found == expected -> SPEAKERS_OK
      found  < expected -> SPEAKER_SWITCH_MISSING
      found  > expected -> TOO_MANY_SPEAKERS
      lane refused / errored / unreachable, WAV missing, or no cast to compare against
                          -> UNVERIFIABLE

    Edge cases, all deliberate:
      found 0 on an ok lane  -> SPEAKER_SWITCH_MISSING, not UNVERIFIABLE: the lane answered, and its
                               answer is "no voice at all". The note says a silent part looks the same.
      lane refused mid-chain -> UNVERIFIABLE with the host's own sentence stored verbatim in
                               lane_error and the chain's own stage in lane_stage / speaker_asr.
      WAV not on disk        -> UNVERIFIABLE naming the path; NO HTTP call is made for that part.
      API unreachable        -> UNVERIFIABLE with the connection error; the run stops calling and
                               marks the remaining parts with the same recorded error.
      cast empty             -> UNVERIFIABLE: there is no expected count to compare against.
    """
    expected_cast = [c for c in (cast or []) if c]
    expected = len(expected_cast)
    rec = {"source": source, "verdict": V_UNVERIFIABLE,
           "lane_job_id": None, "lane_status": None, "lane_error": None, "lane_stage": None,
           "lane_refusal": None, "request": request, "turns": 0,
           "speakers_found": [], "speakers_found_count": 0, "seconds_per_speaker": {},
           "expected_speakers": expected, "expected_cast": expected_cast,
           "audio_path": audio_path, "elapsed_s": elapsed_s, "speaker_asr": None, "note": None,
           "call_failure_kind": None}

    if failure:
        rec["call_failure_kind"] = failure.get("kind")
        rec["lane_error"] = failure.get("error")
        rec["note"] = failure.get("note") or FAILURE_NOTES.get(failure.get("kind"),
                                                               "the lane produced no measurement")
        return rec

    if not isinstance(lane, dict):
        rec["lane_error"] = "lane returned no object response: %r" % (lane,)
        rec["note"] = FAILURE_NOTES["bad_json"]
        return rec

    sa = lane.get("speaker_asr")
    if isinstance(sa, dict):
        rec["speaker_asr"] = sa  # the lane's own record, verbatim
        rec["lane_stage"] = sa.get("stage")
        rec["lane_refusal"] = sa.get("refusal")
    rec["lane_job_id"] = lane.get("job_id")

    if lane.get("ok") is not True:
        # The host's own sentence, verbatim. Never paraphrased, never shortened.
        rec["lane_error"] = lane.get("error")
        rec["lane_status"] = lane.get("status")
        rec["note"] = ("the lane refused or failed; the speaker count for this part was never "
                       "measured, so nothing is claimed about its voices")
        return rec

    turns = turns_from_row(lane)
    per_spk = {}
    for t in turns:
        per_spk[t["speaker_id"]] = round(per_spk.get(t["speaker_id"], 0) + (t["end"] - t["start"]), 2)
    found = sorted({t["speaker_id"] for t in turns}, key=lambda s: (isinstance(s, str), s))
    rec["turns"] = len(turns)
    rec["seconds_per_speaker"] = per_spk
    rec["speakers_found"] = found
    rec["speakers_found_count"] = len(found)
    rec["lane_status"] = "ok"

    if not expected:
        rec["note"] = ("this part carries no cast, so there is no expected speaker count to compare "
                       "against - UNVERIFIABLE rather than a guess")
        return rec
    if len(found) == expected:
        rec["verdict"] = V_SPEAKERS_OK
        rec["note"] = ("the lane hears as many distinct speakers as the part has cast voices; it does "
                       "not say WHICH cast voice spoke - the lane's speaker ids are slots, not identities")
    elif len(found) < expected:
        rec["verdict"] = V_SWITCH_MISSING
        rec["note"] = ("the diar frame probabilities behind this lane see FEWER distinct voices than "
                       "the part's cast. The WORDS may all still be present - on b-760790 parts 3, 7 "
                       "and 10 script coverage was 0.963-0.983 with 1 speaker heard against a cast of "
                       "2 - so this flags the part for a re-render; it does not claim a line is "
                       "missing and it does not say which voice collapsed")
        if not found:
            rec["note"] += (". Note: 0 speakers heard - the lane answered and found no voice at all, "
                            "which is also what a silent part looks like")
    else:
        rec["verdict"] = V_TOO_MANY
        rec["note"] = ("the lane hears MORE distinct speakers than the part's cast: either the render "
                       "split one cast voice into two diar slots, or the diarizer split a voice across "
                       "a pause. Worth a listen before trusting the part")
    return rec


def attach_speaker_audit(info, audit):
    """Attach the audit to one part record. Additive: no existing key is touched."""
    info["speaker_audit"] = audit
    info["diar_speakers_found"] = audit.get("speakers_found_count")
    info["expected_speakers"] = audit.get("expected_speakers")
    info["speaker_verdict"] = audit.get("verdict")
    return info


def load_manifest(path):
    """Read a batch manifest (batch_export.py's <batch_id>_manifest.json) from disk. File read only.

    part_records[] is the render's own record of what each part was asked for - part, job_id, cast,
    audio_seconds, max_frames, file. That cast is the EXPECTED side of the speaker audit; the WAV
    path is the part the audit listens to.
    """
    with open(path) as f:
        doc = json.load(f)
    if not isinstance(doc, dict):
        raise ValueError("manifest is not an object: %s" % path)
    by_part = {}
    by_job = {}
    for r in (doc.get("part_records") or []):
        if not isinstance(r, dict):
            continue
        if r.get("part") is not None:
            by_part[r["part"]] = r
        if r.get("job_id"):
            by_job[str(r["job_id"])] = r
    return {"batch_id": doc.get("batch_id"), "title": doc.get("title"),
            "by_part": by_part, "by_job": by_job}


def load_manifest_arg(args):
    if not args.manifest:
        return None
    try:
        m = load_manifest(os.path.abspath(args.manifest))
    except (OSError, ValueError) as e:
        sys.exit("--manifest unreadable: %s (%s)" % (args.manifest, e))
    print("manifest: %s (%s part_records)" % (args.manifest, len(m["by_part"])))
    return m


def manifest_rec_for_part(info, manifest):
    """The manifest's own record for a part: matched by job id (exact) then by part number."""
    if not manifest:
        return None
    jid = info.get("job_id")
    if jid and str(jid) in manifest["by_job"]:
        return manifest["by_job"][str(jid)]
    return manifest["by_part"].get(info.get("part"))


def cast_for_part(info, manifest):
    """The part's cast: the manifest's part_records[].cast when a manifest was given, else the
    cast the report already carries. Never invented."""
    rec = manifest_rec_for_part(info, manifest)
    if rec and rec.get("cast"):
        return list(rec["cast"])
    return list(info.get("cast") or [])


def audio_path_for_part(info, manifest):
    """The WAV the audit listens to: manifest file first, then the report's own audio_path."""
    rec = manifest_rec_for_part(info, manifest)
    for cand in ((rec or {}).get("file"), info.get("audio_path"), info.get("delivered_path"),
                 info.get("output_path")):
        if cand:
            return cand
    return None


def audit_parts_live(report, args, manifest=None):
    """LIVE audit: one blocking dispatch_speaker_asr per part, sequentially. Returns the raw
    per-part records for --save-audit (the lane's own JSON, plus the call failure when there was one).
    """
    chosen = audit_models(args)
    print("\nspeaker audit: %s  diar_model=%s (%s) asr_model=%s (%s) speaker_mode=%s "
          "speaker_min_frames=%s timeout=%ss  (sequential, one part at a time)"
          % (api_url(SPEAKER_ASR_ROUTE), chosen["diar_model"], chosen["diar_source"],
             chosen["asr_model"], chosen["asr_source"],
             args.speaker_mode, args.speaker_min_frames, args.speaker_audit_timeout))
    raw = []
    unreachable = None
    for info in report.get("parts") or []:
        cast = cast_for_part(info, manifest)
        audio = audio_path_for_part(info, manifest)
        part_no = info.get("part")
        print("\n--- speaker audit part %s (%s) cast=%s audio=%s"
              % (part_no, info.get("job_id"), "|".join(cast) or "(none)", audio or "(none)"))
        body = None
        lane = None
        failure = None
        t0 = time.time()
        if unreachable is not None:
            failure = dict(unreachable)
            failure["note"] = FAILURE_NOTES["skipped_chain"]
        elif not audio:
            failure = {"kind": "no_audio",
                       "error": "no WAV path recorded for this part (no call was made)"}
        elif not os.path.isfile(audio):
            failure = {"kind": "no_audio", "error": "WAV file not found: %s (no call was made)" % audio}
        else:
            body, lane, failure = audit_lane_live(audio, args)
            if failure is not None and failure.get("kind") == "unreachable":
                unreachable = dict(failure)
        audit = judge_speaker_audit(cast, lane, failure, "live", audio_path=audio, request=body,
                                    elapsed_s=round(time.time() - t0, 1))
        attach_speaker_audit(info, audit)
        raw.append({"part": part_no, "job_id": info.get("job_id"), "status": info.get("status"),
                    "cast": cast, "audio_path": audio, "audio_seconds": info.get("audio_seconds"),
                    "request": body, "lane_response": lane, "call_failure": failure})
        print_part_audit(audit)
    report["speaker_audit_options"] = audit_options(args)
    report["speaker_audit_rule"] = SPEAKER_AUDIT_RULE
    return raw


def index_saved_audit(audit_doc):
    by_job = {}
    by_part = {}
    for r in (audit_doc.get("parts") or []):
        if not isinstance(r, dict):
            continue
        if r.get("job_id"):
            by_job[str(r["job_id"])] = r
        if r.get("part") is not None:
            by_part.setdefault(r["part"], r)
    return {"by_job": by_job, "by_part": by_part}


def audit_parts_saved(report, audit_doc, args, manifest=None):
    """OFFLINE audit: re-judge a saved raw audit. Zero network - both offline modes set _OFFLINE, so
    even a stray call() would raise before a socket. Same judge_speaker_audit() the live path uses.

    Records are matched to parts by job id first (exact), then by part number.
    """
    saved = index_saved_audit(audit_doc)
    print("\nspeaker audit (offline, from %s): %s saved part records re-judged, lane options=%s"
          % (args.from_audit, len(audit_doc.get("parts") or []),
             json.dumps(audit_doc.get("audit_options") or {})))
    matched = set()
    for info in report.get("parts") or []:
        cast = cast_for_part(info, manifest)
        audio = audio_path_for_part(info, manifest)
        rec = None
        jid = info.get("job_id")
        if jid and str(jid) in saved["by_job"]:
            rec = saved["by_job"][str(jid)]
        elif info.get("part") in saved["by_part"]:
            rec = saved["by_part"][info["part"]]
        if rec is not None:
            matched.add(id(rec))
            audio = audio or rec.get("audio_path")
            cast = cast or list(rec.get("cast") or [])
            lane = rec.get("lane_response")
            failure = rec.get("call_failure")
            if lane is None and failure is None:
                failure = {"kind": "not_audited",
                           "error": "the saved audit carries neither a lane response nor a call "
                                    "failure for this part"}
        else:
            lane = None
            failure = {"kind": "not_audited",
                       "error": "part %s (job %s) is not in the saved audit file (no call was made)"
                                % (info.get("part"), jid)}
        audit = judge_speaker_audit(cast, lane, failure, "saved_audit", audio_path=audio,
                                    request=(rec or {}).get("request"))
        attach_speaker_audit(info, audit)
        print_part_audit(audit)
    unmatched = [r for r in (audit_doc.get("parts") or []) if id(r) not in matched]
    if unmatched:
        print("    %s saved audit records matched no part in this report: %s"
              % (len(unmatched), ", ".join(str(r.get("part") or r.get("job_id")) for r in unmatched)))
    report["speaker_audit_options"] = audit_doc.get("audit_options") or audit_options(args)
    report["speaker_audit_rule"] = SPEAKER_AUDIT_RULE
    return []


def save_audit(path, report, raw_records, args):
    """Write the RAW per-part lane responses (job_id, speaker_turns, speaker_asr, error) so an audit
    can be re-judged later with --from-audit, without re-running either model.
    """
    doc = {"batch_id": report.get("batch_id"), "title": report.get("title"),
           "generated_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "audit_options": audit_options(args),
           "parts": raw_records}
    p = os.path.abspath(path)
    d = os.path.dirname(p)
    if d:
        os.makedirs(d, exist_ok=True)
    with open(p, "w") as f:
        json.dump(doc, f, indent=2)
    print("\nwrote raw audit -> %s (%s part records: the lane's own responses, re-judgeable with "
          "--from-audit)" % (p, len(raw_records)))


def load_audit(path):
    try:
        with open(path) as f:
            doc = json.load(f)
    except (OSError, ValueError) as e:
        sys.exit("--from-audit unreadable: %s (%s)" % (path, e))
    if not isinstance(doc, dict) or not isinstance(doc.get("parts"), list):
        sys.exit("--from-audit file has no parts[] list: %s" % path)
    return doc


def report_from_audit(audit_doc, args):
    """A report skeleton built from a saved audit alone (no --from-report): the parts carry the
    audit and the manifest facts, and nothing that was not measured here."""
    parts = []
    for r in audit_doc.get("parts") or []:
        if not isinstance(r, dict):
            continue
        parts.append({"part": r.get("part"), "job_id": r.get("job_id"), "status": r.get("status"),
                      "cast": list(r.get("cast") or []), "audio_seconds": r.get("audio_seconds"),
                      "audio_path": r.get("audio_path")})
    return {"batch_id": audit_doc.get("batch_id"), "title": audit_doc.get("title"), "parts": parts,
            "min_speech_ratio": args.min_speech_ratio, "chars_per_sec": args.chars_per_sec,
            "matching_rule": MATCHING_RULE,
            "recomputed_from_audit": os.path.abspath(args.from_audit)}


def add_speaker_totals(report):
    """Totals for the audit stage. Additive: `totals` (the T-187a block) is left exactly as it is."""
    audited = 0
    counts = {V_SPEAKERS_OK: 0, V_SWITCH_MISSING: 0, V_TOO_MANY: 0, V_UNVERIFIABLE: 0}
    rerender = []
    for p in report.get("parts") or []:
        a = p.get("speaker_audit")
        if not a:
            continue
        audited += 1
        v = a.get("verdict")
        counts[v] = counts.get(v, 0) + 1
        if v in (V_SWITCH_MISSING, V_TOO_MANY):
            rerender.append(p.get("part"))
    if audited == 0:
        return report
    try:
        rerender = sorted(rerender, key=lambda x: (str(type(x)), x))
    except TypeError:
        pass
    report["speaker_totals"] = {
        "parts_audited": audited,
        "parts_speakers_ok": counts.get(V_SPEAKERS_OK, 0),
        "parts_speaker_switch_missing": counts.get(V_SWITCH_MISSING, 0),
        "parts_too_many_speakers": counts.get(V_TOO_MANY, 0),
        "parts_unverifiable": counts.get(V_UNVERIFIABLE, 0),
        "rerender_parts": rerender,
        "rerender_line": ("re-render target parts: %s"
                          % (", ".join(str(p) for p in rerender) or "none")),
    }
    return report


def fmt_elapsed(audit):
    """Wall seconds this script spent waiting for the lane, or '-' when the audit was re-judged
    offline (a saved audit carries no timing, and inventing one would be a lie)."""
    e = audit.get("elapsed_s")
    return "%s s" % e if e is not None else "-"


def print_part_audit(audit):
    print("    speaker audit: diar heard %s speaker(s) %s, cast expects %s -> %s"
          % (audit.get("speakers_found_count"), audit.get("speakers_found"),
             audit.get("expected_speakers"), audit.get("verdict")))
    if audit.get("seconds_per_speaker"):
        ranked = heard_ranked(audit["seconds_per_speaker"])
        print("    speaker seconds: " + ", ".join("S%s=%.2f s" % (s, sec) for s, sec in ranked))
    if audit.get("lane_job_id"):
        print("    lane job %s  status=%s  stage=%s  turns=%s  waited=%s"
              % (audit["lane_job_id"], audit.get("lane_status"), audit.get("lane_stage"),
                 audit.get("turns"), fmt_elapsed(audit)))
    if audit.get("lane_error"):
        print("    lane error (verbatim): %s" % audit["lane_error"])
    if audit.get("note"):
        print("    note: %s" % audit["note"])


def print_speaker_totals(report):
    t = report.get("speaker_totals") or {}
    if not t:
        return
    print("\nspeaker audit totals: %s parts audited -> %s SPEAKERS_OK, %s SPEAKER_SWITCH_MISSING, "
          "%s TOO_MANY_SPEAKERS, %s UNVERIFIABLE"
          % (t.get("parts_audited"), t.get("parts_speakers_ok"), t.get("parts_speaker_switch_missing"),
             t.get("parts_too_many_speakers"), t.get("parts_unverifiable")))
    print(t.get("rerender_line"))


def rerender_targets(report):
    """Parts a re-render should target: the ones whose heard speaker count does not match the cast.
    UNVERIFIABLE parts are NOT re-render targets - they were never measured."""
    out = []
    for p in report.get("parts") or []:
        a = p.get("speaker_audit")
        if a and a.get("verdict") in (V_SWITCH_MISSING, V_TOO_MANY):
            out.append((p, a))
    return out


def print_rerender_hints(report, manifest=None):
    """Text only. This says what a human or agent would do next; it dispatches nothing and automates
    nothing."""
    print("\n--- rerender hint (text only: nothing here dispatches, re-renders or deletes) ---")
    targets = rerender_targets(report)
    if not targets:
        print("no part is flagged for a re-render")
        return
    for p, a in targets:
        rec = manifest_rec_for_part(p, manifest) or {}
        print("part %s  job_id %s  cast %s  audio %s"
              % (p.get("part"), p.get("job_id") or rec.get("job_id"),
                 "|".join(a.get("expected_cast") or []) or "(no cast recorded)",
                 a.get("audio_path") or rec.get("file") or "(no path recorded)"))
        print("   diar heard %s speaker(s) %s against a cast of %s -> %s"
              % (a.get("speakers_found_count"), a.get("speakers_found"), a.get("expected_speakers"),
                 a.get("verdict")))
        if a.get("seconds_per_speaker"):
            ranked = heard_ranked(a["seconds_per_speaker"])
            print("   speaker seconds: " + ", ".join("S%s=%.2f s" % (s, sec) for s, sec in ranked))
        print("   next step: re-render ONLY part %s of batch %s (the part row is %s) with the SAME "
              "cast and the SAME tagged text, then re-run this audit on the new WAV. Parts that are "
              "SPEAKERS_OK stay as they are; parts that are UNVERIFIABLE need the lane fixed or the "
              "WAV found, not a re-render."
              % (p.get("part"), report.get("batch_id"), p.get("job_id") or "unknown"))


def write_v3(report, out_dir):
    """report_v3.json + report_v3.md. report.json and report_v2.* are never written by an audit run."""
    with open(os.path.join(out_dir, "report_v3.json"), "w") as f:
        json.dump(report, f, indent=2)
    with open(os.path.join(out_dir, "report_v3.md"), "w") as f:
        f.write(render_md(report))
    print("\nwrote %s/report_v3.json and %s/report_v3.md" % (out_dir, out_dir))


def render_md(report):
    """report.md. The pre-T-187a lines are unchanged; the new lines are appended per part."""
    md = ["# Batch verify %s" % report.get("batch_id"), "",
          "title: %s  parts: %s" % (report.get("title"), len(report.get("parts") or [])), ""]
    t = report.get("totals") or {}
    if t:
        md.append("speech overall: %.1f s of %.1f s audio = %s  (SUSPECT under --min-speech-ratio %s: %s)"
                  % (t.get("speech_seconds") or 0, t.get("audio_seconds") or 0,
                     t.get("speech_ratio"), report.get("min_speech_ratio"),
                     ", ".join(str(p) for p in t.get("suspect_parts") or []) or "none"))
    if report.get("matching_rule"):
        md.append("")
        md.append(report["matching_rule"])
        md.append("expected seconds use %.1f chars per second of speech (measured band on this "
                  "lane: 12-20), so they are a band, not a promise."
                  % (report.get("chars_per_sec") or DEFAULT_CHARS_PER_SEC))
    # --- T-193 speaker audit totals. Guarded on the audit keys being present, so a report that
    # never ran the audit renders byte-for-byte as it did before T-193.
    st = report.get("speaker_totals") or {}
    if st:
        md.append("")
        md.append("speaker audit: %s parts audited -> %s SPEAKERS_OK, %s SPEAKER_SWITCH_MISSING, "
                  "%s TOO_MANY_SPEAKERS, %s UNVERIFIABLE"
                  % (st.get("parts_audited"), st.get("parts_speakers_ok"),
                     st.get("parts_speaker_switch_missing"), st.get("parts_too_many_speakers"),
                     st.get("parts_unverifiable")))
        md.append(st.get("rerender_line"))
        ao = report.get("speaker_audit_options") or {}
        if ao:
            md.append("audit lane: %s%s  diar_model %s (%s)  asr_model %s (%s)  speaker_mode %s  "
                      "speaker_min_frames %s  per-part timeout %s s"
                      % (ao.get("api_base"), ao.get("route"), ao.get("diar_model"),
                         ao.get("diar_model_source") or "source_not_recorded",
                         ao.get("asr_model"),
                         ao.get("asr_model_source") or "source_not_recorded",
                         ao.get("speaker_mode"), ao.get("speaker_min_frames"),
                         ao.get("timeout_s")))
    if report.get("speaker_audit_rule"):
        md.append("")
        md.append(report["speaker_audit_rule"])
    md.append("")
    for p in report.get("parts") or []:
        md.append("## part %s (%s) - %s" % (p.get("part"), p.get("job_id"), p.get("status")))
        md.append("- cast sent: %s" % "|".join(p.get("cast") or []))
        md.append("- audio: %.1f s  max_frames: %s" % (p.get("audio_seconds") or 0, p.get("max_frames")))
        if p.get("skipped"):
            md.append("- SKIPPED: %s" % p["skipped"])
        if p.get("diar_error"):
            md.append("- diar error: %s" % p["diar_error"])
        if "turns" in p:
            md.append("- heard %d turns, speakers %s (expected %d) -> %s"
                      % (p["turns"], p["speakers_heard"], p["cast_expected"],
                         "MATCH" if p["cast_match"] else "MISMATCH"))
            md.append("- seconds per speaker: %s" % json.dumps(p["seconds_per_speaker"]))
            md.append("- min confidence: %s" % p.get("min_confidence"))
        if "script_coverage" in p:
            md.append("- script coverage (ASR): %s" % p["script_coverage"])
        # --- T-187a
        if p.get("speech_ratio") is not None:
            md.append("- speech: %.1f s of %.1f s audio = %.3f -> %s"
                      % (p.get("speech_seconds") or 0, p.get("audio_seconds") or 0,
                         p["speech_ratio"], p.get("speech_flag")))
            if p.get("speech_flag") == "SUSPECT":
                rest = round((p.get("audio_seconds") or 0) - (p.get("speech_seconds") or 0), 1)
                md.append("  SUSPECT means: %.1f s of this part is NOT inside any diar speaker "
                          "turn (silence or noise, not a failed part) - this is what a listener "
                          "hears as a strange pause" % rest)
        exp_list = p.get("expected_seconds_per_voice") or []
        if any(e is not None for e in exp_list):
            md.append("- expected speech per cast voice (cast order, %s chars/s): %s"
                      % (report.get("chars_per_sec"),
                         ", ".join("%s=%s s" % (v, e) for v, e in
                                   zip(p.get("cast") or [], exp_list) if v)))
        elif p.get("voice_verdicts"):
            md.append("- expected speech per cast voice: NOT COMPUTABLE - this report carries no "
                      "scripted text for the part and no --script-source was given, so the "
                      "verdicts are NO_SCRIPT and nothing was guessed")
        if p.get("heard_seconds_ranked"):
            md.append("- heard speech ranked by seconds: %s"
                      % ", ".join("S%s=%.1f s" % (h["speaker"], h["seconds"])
                                  for h in p["heard_seconds_ranked"]))
        if p.get("voice_verdicts"):
            md.append("- voice verdicts (positional: cast order vs heard speakers ranked by "
                      "seconds, not identity):")
            for v in p["voice_verdicts"]:
                if v["verdict"] in ("MISSING", "UNVERIFIABLE", "NO_SCRIPT"):
                    md.append("  %s: %s (expected %s s)"
                              % (v["voice"], v["verdict"], v["expected_seconds"]))
                else:
                    md.append("  %s: %s (expected %s s vs heard S%s=%.1f s)"
                              % (v["voice"], v["verdict"], v["expected_seconds"],
                                 v["heard_speaker"], v["heard_seconds"]))
            if any(v["verdict"] == "MISSING" for v in p["voice_verdicts"]):
                md.append("  MISSING = the diarizer reported fewer speakers than the cast. With no "
                          "per-turn text the tool cannot say WHICH voice is absent - the positional "
                          "pairing simply ran out of heard speakers - so this is not evidence that "
                          "this particular voice is missing from the render.")
        # --- T-193 speaker audit (additive; absent when the part was not audited)
        a = p.get("speaker_audit")
        if a:
            md.append("- speaker audit (%s, lane job %s): diar heard %s distinct speaker(s) %s, "
                      "cast expects %s -> %s"
                      % (a.get("source"), a.get("lane_job_id"), a.get("speakers_found_count"),
                         a.get("speakers_found"), a.get("expected_speakers"), a.get("verdict")))
            if a.get("seconds_per_speaker"):
                ranked = heard_ranked(a["seconds_per_speaker"])
                md.append("  speaker seconds: %s"
                          % ", ".join("S%s=%.2f s" % (s, sec) for s, sec in ranked))
            if a.get("lane_status") == "ok":
                md.append("  lane turns: %s  stage: %s  waited: %s"
                          % (a.get("turns"), a.get("lane_stage"), fmt_elapsed(a)))
            sa = a.get("speaker_asr") or {}
            if sa:
                md.append("  lane record: frames %s  timeline speakers %s  artifact %s (%s B)  "
                          "stage %s" % (sa.get("frames"), sa.get("speakers"),
                                        sa.get("artifact_path") or sa.get("artifact_file"),
                                        sa.get("bytes"), sa.get("stage")))
            if a.get("audio_path"):
                md.append("  audio audited: %s" % a["audio_path"])
            if a.get("lane_error"):
                md.append("  lane error (verbatim, the host's own sentence): %s" % a["lane_error"])
            if a.get("lane_refusal") and a.get("lane_refusal") != a.get("lane_error"):
                md.append("  lane refusal (verbatim): %s" % a["lane_refusal"])
            if a.get("verdict") == V_SWITCH_MISSING:
                md.append("  SPEAKER_SWITCH_MISSING means the diar frame probabilities behind this "
                          "lane see FEWER voices than the part's cast. It does NOT mean a line is "
                          "missing: the words may all be present, rendered in the wrong voice. It "
                          "also does not say which voice collapsed - the lane's speaker ids are "
                          "positional slots, not identities.")
            elif a.get("verdict") == V_TOO_MANY:
                md.append("  TOO_MANY_SPEAKERS means the lane hears more distinct voices than the "
                          "part's cast: either one cast voice was split across two diar slots, or "
                          "the diarizer split one voice across a pause.")
            elif a.get("verdict") == V_UNVERIFIABLE:
                md.append("  UNVERIFIABLE means the speaker count for this part was never measured "
                          "(lane refusal, lane error, unreachable API, missing WAV, or no cast "
                          "recorded): no claim is made about its voices, and it is not a re-render "
                          "target until the measurement exists.")
            if a.get("note"):
                md.append("  note: %s" % a["note"])
        md.append("")
    return "\n".join(md)


# ---------------------------------------------------------------- modes

def run_live(args):
    manifest = load_manifest_arg(args)
    b = call("batch_status?batch_id=" + args.batch_id)
    if not b.get("ok"):
        sys.exit("batch_status failed: " + str(b.get("error")))
    rows = b.get("rows") or []
    print("batch %s  title=%s  parts=%s  done=%s failed=%s running=%s  audio_s=%s"
          % (b.get("batch_id"), b.get("title"), b.get("parts"), b.get("done"),
             b.get("failed"), b.get("running"), b.get("audio_seconds")))

    report = {"batch_id": args.batch_id, "title": b.get("title"), "parts": [],
              "min_speech_ratio": args.min_speech_ratio, "chars_per_sec": args.chars_per_sec,
              "matching_rule": MATCHING_RULE}

    for row in rows:
        # batch_status rows are a SUMMARY (job_id, part, status, cast, duration, output_path).
        # The script text and the full cast live on the job row, so fetch it: reading
        # rowOf-style keys (id / batch_part / batch_cast / text) off the summary silently
        # produced None for all of them and every part looked "not finished".
        part = row.get("part")
        jid = row.get("job_id")
        j = get_job(jid) if jid else {}
        cast = j.get("speakers") or row.get("cast") or []
        script = j.get("text") or ""
        # Prefer the delivered copy when the plugin delivered one: it is the file the project
        # directory keeps, so verifying it verifies the artifact a listener will actually play.
        audio_path = j.get("delivered_path") or row.get("delivered_path") or j.get("output_path") or row.get("output_path")
        expected_voices = len([c for c in cast if c])
        info = {"part": part, "job_id": jid, "status": row.get("status"),
                "cast": cast, "audio_seconds": row.get("duration"),
                "max_frames": row.get("max_frames"), "audio_path": audio_path}
        print("\n--- part %s (%s) status=%s cast=%s dur=%ss"
              % (part, jid, row.get("status"), "|".join(cast), row.get("duration")))

        if row.get("status") != "ok" or not audio_path:
            info["skipped"] = "no finished audio (status=%s)" % row.get("status")
            add_part_metrics(info, args.min_speech_ratio, args.chars_per_sec, script_text=script)
            report["parts"].append(info)
            continue

        # diarize: who actually spoke.
        # NOTE: `dispatch_stt` is a BLOCKING route - the plugin resolves the response only when
        # the job reaches a terminal state (it pushes a job waiter). A 60 s HTTP timeout therefore
        # killed the call before the diar ever answered. The HTTP timeout has to cover the whole
        # job, not just the enqueue. Measured 2026-10-13: `--max-wait 1` made the timeout 121 s and the whole run
        # died with TimeoutError inside urllib before any part was reported. --max-wait bounds how long this tool
        # waits for a PART to be delivered; it must not be what bounds a diarisation on a busy lane, so the HTTP
        # timeout now has a floor independent of it.
        d = call("dispatch_stt", {"fn": "stt", "model": "nemotron_3_diar",
                                  "file_path": audio_path}, timeout=max(1800, args.max_wait + 900))
        if not d.get("ok"):
            info["diar_error"] = d.get("error")
            add_part_metrics(info, args.min_speech_ratio, args.chars_per_sec, script_text=script)
            report["parts"].append(info)
            continue
        dj = wait_job(d["job_id"], args.max_wait)
        # Take whichever leg is more complete. The transcript is the full text; the row's
        # speaker_turns array is capped (400 at diar time, 300 through job_status, and only 100
        # survive a state restore - live proof: ap-0292 has 171 transcript lines but 100 stored
        # turns, and the truncated leg even reports a different speaker count).
        turns = parse_turns(dj.get("transcript"))
        if len(turns) < len(dj.get("speaker_turns") or []):
            turns = turns_from_row(dj)
        speakers = sorted({t["speaker_id"] for t in turns},
                          key=lambda s: (isinstance(s, str), s))
        per_spk = {}
        for t in turns:
            per_spk[t["speaker_id"]] = round(per_spk.get(t["speaker_id"], 0) + (t["end"] - t["start"]), 2)
        confs = [t["confidence"] for t in turns if t["confidence"] is not None]
        info.update({
            "diar_job": d["job_id"], "turns": len(turns), "speakers_heard": speakers,
            "seconds_per_speaker": per_spk,
            "min_confidence": min(confs) if confs else None,
            "cast_expected": expected_voices,
            "cast_match": len(speakers) == expected_voices,
            "transcript": dj.get("transcript") or "",
        })
        print("    diar %s: %d turns, heard speakers %s, expected %d -> %s"
              % (d["job_id"], len(turns), speakers, expected_voices,
                 "MATCH" if len(speakers) == expected_voices else "MISMATCH"))
        if per_spk:
            print("    seconds per speaker: " + ", ".join("S%s=%.1f" % (k, v) for k, v in sorted(
                per_spk.items(), key=lambda kv: (isinstance(kv[0], str), kv[0]))))
        if confs:
            print("    confidence min=%.2f" % min(confs))

        if args.asr:
            a = call("dispatch_stt", {"fn": "stt", "model": "qwen3_asr",
                                      "file_path": audio_path}, timeout=max(1800, args.max_wait + 900))
            if a.get("ok"):
                aj = wait_job(a["job_id"], args.max_wait)
                spoken = aj.get("transcript") or ""
                expected = re.sub(r"\[S\d+\]", " ", script)
                info["asr_job"] = a["job_id"]
                info["asr_text"] = spoken
                info["script_coverage"] = overlap_ratio(spoken, expected)
                print("    asr %s: script coverage %s" % (a["job_id"], info["script_coverage"]))
            else:
                info["asr_error"] = a.get("error")

        add_part_metrics(info, args.min_speech_ratio, args.chars_per_sec, script_text=script)
        print_part_metrics(info)
        report["parts"].append(info)

    add_report_totals(report)
    if args.speaker_audit:
        # T-193: a live audit run writes report_v3.* ONLY. report.json / report_v2.* are never
        # written by an audit run, so an audit can be re-run over the same batch dir safely.
        raw = audit_parts_live(report, args, manifest)
        add_speaker_totals(report)
        if args.save_audit:
            save_audit(args.save_audit, report, raw, args)
        write_v3(report, args.out)
        print_report_totals(report)
        print_speaker_totals(report)
        if args.rerender_hint:
            print_rerender_hints(report, manifest)
        return report
    with open(os.path.join(args.out, "report.json"), "w") as f:
        json.dump(report, f, indent=2)
    with open(os.path.join(args.out, "report.md"), "w") as f:
        f.write(render_md(report))
    print("\nwrote %s/report.json and %s/report.md" % (args.out, args.out))
    print_report_totals(report)
    return report


def print_part_metrics(info):
    if info.get("speech_ratio") is not None:
        print("    speech %.1f s of %.1f s = %.3f -> %s"
              % (info.get("speech_seconds") or 0, info.get("audio_seconds") or 0,
                 info["speech_ratio"], info.get("speech_flag")))
    for v in info.get("voice_verdicts") or []:
        print("    %-24s %-12s expected %s s  heard %s"
              % (v["voice"], v["verdict"], v["expected_seconds"],
                 ("S%s=%.1f s" % (v["heard_speaker"], v["heard_seconds"]))
                 if v["heard_speaker"] is not None else "-"))


def print_report_totals(report):
    t = report.get("totals") or {}
    print("\nspeech overall: %s s of %s s = %s   SUSPECT parts: %s"
          % (t.get("speech_seconds"), t.get("audio_seconds"), t.get("speech_ratio"),
             ", ".join(str(p) for p in t.get("suspect_parts") or []) or "none"))


def run_from_report(args):
    """Re-score an existing report.json. Plain --from-report is a ZERO-network path: it never enters
    the HTTP helper (see _OFFLINE), the scripted text it needs is read from the report itself or from
    --script-source, and it dispatches nothing.

    T-193 additions on the same part records:
      --from-audit <audit.json>  re-judge a saved raw audit (still zero network: _OFFLINE stays set)
      --speaker-audit            call the audit lane, one part at a time (_OFFLINE is NOT set, and
                                 the only route this mode can call is dispatch_speaker_asr)
    Either one writes report_v3.* and leaves report.json / report_v2.* alone.
    """
    global _OFFLINE
    _OFFLINE = not bool(args.speaker_audit)  # call() raises unless this run was told to audit live

    src = os.path.abspath(args.from_report)
    if not os.path.isfile(src):
        sys.exit("no such report.json: %s" % src)
    try:
        with open(src) as f:
            report = json.load(f)
    except ValueError as e:
        sys.exit("report.json is not readable JSON: %s (%s)" % (src, e))
    if not isinstance(report, dict) or not isinstance(report.get("parts"), list):
        sys.exit("report.json has no parts[] list: %s" % src)

    out_dir = os.path.dirname(src)
    manifest = load_manifest_arg(args)
    report["min_speech_ratio"] = args.min_speech_ratio
    report["chars_per_sec"] = args.chars_per_sec
    report["matching_rule"] = MATCHING_RULE
    report["recomputed_from"] = src

    rows = None
    if args.script_source:
        try:
            rows = load_script_rows(os.path.abspath(args.script_source))
        except (OSError, ValueError) as e:
            sys.exit("--script-source unreadable: %s (%s)" % (args.script_source, e))
        print("script source: %s (%s rows with text)"
              % (args.script_source, len(rows["by_job"])))

    if args.speaker_audit:
        print("recomputing %s  batch=%s parts=%s  (speaker audit LIVE: %s is the only route this "
              "mode calls, one part at a time, sequentially)"
              % (src, report.get("batch_id"), len(report["parts"]), api_url(SPEAKER_ASR_ROUTE)))
    else:
        print("recomputing %s  batch=%s parts=%s  (offline: no HTTP, no dispatch)"
              % (src, report.get("batch_id"), len(report["parts"])))
    for info in report["parts"]:
        add_part_metrics(info, args.min_speech_ratio, args.chars_per_sec,
                         script_text=script_for_part(info, report.get("batch_id"), rows),
                         script_origin="script_source")
        print_part_metrics(info)

    add_report_totals(report)
    if args.from_audit:
        # Offline re-judge: the raw lane responses are already on disk, so no model runs again.
        audit_parts_saved(report, load_audit(os.path.abspath(args.from_audit)), args, manifest)
    elif args.speaker_audit:
        raw = audit_parts_live(report, args, manifest)
        if args.save_audit:
            save_audit(args.save_audit, report, raw, args)
    if args.from_audit or args.speaker_audit:
        # An audit run writes report_v3.* only: report.json and report_v2.* are left alone.
        add_speaker_totals(report)
        write_v3(report, out_dir)
        print_report_totals(report)
        print_speaker_totals(report)
        if args.rerender_hint:
            print_rerender_hints(report, manifest)
        return report

    with open(os.path.join(out_dir, "report_v2.json"), "w") as f:
        json.dump(report, f, indent=2)
    with open(os.path.join(out_dir, "report_v2.md"), "w") as f:
        f.write(render_md(report))
    print("\nwrote %s/report_v2.json and %s/report_v2.md" % (out_dir, out_dir))
    print_report_totals(report)
    return report


def run_audit_only(args):
    """--from-audit with no --from-report: re-judge a saved raw audit on its own.

    ZERO network: _OFFLINE is set, so call() would raise, and this mode has no live leg at all. The
    parts carry what the audit file and (optionally) the manifest recorded - no diar / coverage /
    speech metrics are invented for a part that was not measured by those lanes here.
    """
    global _OFFLINE
    _OFFLINE = True

    audit_doc = load_audit(os.path.abspath(args.from_audit))
    manifest = load_manifest_arg(args)
    report = report_from_audit(audit_doc, args)
    print("re-judging %s  batch=%s parts=%s  (offline: no HTTP, no dispatch)"
          % (args.from_audit, report.get("batch_id"), len(report["parts"])))
    audit_parts_saved(report, audit_doc, args, manifest)
    add_speaker_totals(report)
    out_dir = args.out or os.path.dirname(os.path.abspath(args.from_audit))
    write_v3(report, out_dir)
    print_speaker_totals(report)
    if args.rerender_hint:
        print_rerender_hints(report, manifest)
    return report


def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--batch-id", default=None,
                    help="batch to verify live (plugin routes; dispatches diar + optional ASR)")
    ap.add_argument("--asr", action="store_true",
                    help="also run qwen3_asr per part and score the script coverage")
    ap.add_argument("--max-wait", type=int, default=3600,
                    help="seconds to wait for one verification job")
    ap.add_argument("--out", default=None)
    ap.add_argument("--min-speech-ratio", type=float, default=DEFAULT_MIN_SPEECH_RATIO,
                    help="flag a part SUSPECT under this speech_seconds/audio_seconds "
                         "(default %.2f). SUSPECT is a flag, not a failure: it changes no exit "
                         "code and no existing key." % DEFAULT_MIN_SPEECH_RATIO)
    ap.add_argument("--chars-per-sec", type=float, default=DEFAULT_CHARS_PER_SEC,
                    help="speaking rate used to turn scripted characters into expected seconds "
                         "(default %.1f, the plugin's own BATCH_CHARS_PER_SEC). Measured band on "
                         "this lane is 12-20 chars per second of SPEECH, so expected seconds are "
                         "a band, not a promise." % DEFAULT_CHARS_PER_SEC)
    ap.add_argument("--from-report", default=None, metavar="REPORT_JSON",
                    help="recompute ONLY the T-187a metrics from an existing report.json and "
                         "write report_v2.json + report_v2.md next to it. Makes ZERO network "
                         "calls and dispatches nothing. --out is ignored in this mode.")
    ap.add_argument("--script-source", default=None, metavar="JSON",
                    help="with --from-report: a JSON file on disk carrying the plugin's job rows "
                         "(its state file, a list of rows, or {job_id: row}) so an OLD report that "
                         "never stored the part text can still be scored per voice. File read only.")
    # --- T-193 speaker audit (verify-then-rerender). All new; no existing flag changes meaning.
    ap.add_argument("--speaker-audit", action="store_true",
                    help="run the speaker audit: POST each part's own WAV to dispatch_speaker_asr and "
                         "compare the speakers that lane hears with the part's cast. Combine it with "
                         "--batch-id (verify + audit in one pass) or with --from-report (audit an "
                         "already-verified batch WITHOUT re-dispatching diar). Writes report_v3.json + "
                         "report_v3.md only; report.json and report_v2.* are never written by an audit "
                         "run. Parts are audited ONE AT A TIME, sequentially - the plugin serialises "
                         "one job per machine, and this never fires parallel dispatches.")
    ap.add_argument("--from-audit", default=None, metavar="AUDIT_JSON",
                    help="re-judge a previously saved raw audit (written by --save-audit) with ZERO "
                         "network calls, through the same verdict code path the live audit uses. "
                         "Optionally combine with --from-report to bring the older diar / coverage / "
                         "speech metrics into the same report_v3.")
    ap.add_argument("--save-audit", default=None, metavar="AUDIT_JSON",
                    help="with a live --speaker-audit: write the RAW per-part lane responses (job_id, "
                         "speaker_turns, speaker_asr, error) so the audit can be re-judged later with "
                         "--from-audit without re-running either model.")
    ap.add_argument("--api-base", default=DEFAULT_API_BASE, metavar="URL",
                    help="plugin API root the audit lane is called under (default %s); the audit URL "
                         "is this plus 'dispatch_speaker_asr'." % DEFAULT_API_BASE)
    ap.add_argument("--speaker-audit-timeout", type=int, default=DEFAULT_SPEAKER_AUDIT_TIMEOUT,
                    help="seconds to wait for ONE audit lane call (default %d). The route is blocking "
                         "like dispatch_stt: the response resolves when the row is terminal, so this "
                         "has to cover the whole diar -> artifact -> asr chain."
                         % DEFAULT_SPEAKER_AUDIT_TIMEOUT)
    ap.add_argument("--speaker-mode", default=AUDIT_SPEAKER_MODE, choices=("masked", "attribution"),
                    help="nemotron_asr speaker_mode for the audit (default %s - the value the measured "
                         "2026-10-04 sweep used)" % AUDIT_SPEAKER_MODE)
    ap.add_argument("--speaker-min-frames", type=int, default=AUDIT_SPEAKER_MIN_FRAMES,
                    help="diar speaker_min_frames for the audit, in 10 ms output frames (default %d "
                         "= 0.3 s; the lane accepts 0..3000)" % AUDIT_SPEAKER_MIN_FRAMES)
    ap.add_argument("--speaker-audit-diar-model", default=None, metavar="MODEL",
                    help="diar model of the audit chain. Left out, it is read off the live STT "
                         "catalog the audit lane serves - by task, preferring a model the engine "
                         "already holds - and the families this chain cannot use are excluded (%s: "
                         "the lane refuses them, they cannot produce the speaker_probabilities "
                         "artifact this chain feeds on). The named fallback %s runs only when that "
                         "read answers nothing, and the report records which of the two happened."
                         % (", ".join(AUDIT_DIAR_REFUSED_FAMILIES), AUDIT_DIAR_MODEL))
    ap.add_argument("--speaker-audit-asr-model", default=None, metavar="MODEL",
                    help="asr model of the audit chain. Left out, it is read off the same live "
                         "catalog by the same rule; the named fallback is %s." % AUDIT_ASR_MODEL)
    ap.add_argument("--manifest", default=None, metavar="MANIFEST_JSON",
                    help="a batch_export.py <batch_id>_manifest.json: part_records[].cast is the "
                         "EXPECTED speaker count of each part and part_records[].file is the WAV the "
                         "audit listens to. File read only.")
    ap.add_argument("--rerender-hint", action="store_true",
                    help="print, for each flagged part, the exact next step a human or agent would "
                         "take (part number, job_id, cast, speakers found). Text only: it dispatches "
                         "nothing and automates nothing.")
    args = ap.parse_args()

    global API_BASE
    API_BASE = args.api_base.rstrip("/") + "/"

    if args.chars_per_sec <= 0:
        sys.exit("bad --chars-per-sec (must be > 0): %s" % args.chars_per_sec)
    # T-193 adds a third source of parts (--from-audit). The pre-T-193 message is kept verbatim for
    # the pre-T-193 combinations.
    if bool(args.batch_id) and bool(args.from_report):
        sys.exit("give exactly one of --batch-id (live verify) or --from-report <report.json>")
    if not (args.batch_id or args.from_report or args.from_audit):
        # T-639 (2026-10-25, reported from another session as "batch_verify.py requires a batch id"): the guard
        # above already accepts three inputs, but this message named two of them, so a caller who came with an
        # audit JSON was told to produce a batch id. The message now names every input the guard accepts.
        sys.exit("give exactly one of --batch-id (live verify), --from-report <report.json> or --from-audit <audit.json>")
    if args.speaker_audit and args.from_audit:
        sys.exit("--from-audit IS the offline audit: drop --speaker-audit, or drop --from-audit to "
                 "run the audit live")
    if args.save_audit and not (args.speaker_audit and not args.from_audit):
        sys.exit("--save-audit writes the raw responses of a LIVE --speaker-audit run; with "
                 "--from-audit the raw responses are already the input")
    if args.speaker_audit and not (args.batch_id or args.from_report):
        sys.exit("--speaker-audit needs a source of parts: --batch-id <b-NNNNNN> or --from-report "
                 "<report.json>")
    if args.speaker_audit_timeout <= 0:
        sys.exit("bad --speaker-audit-timeout (must be > 0): %s" % args.speaker_audit_timeout)
    if args.speaker_min_frames < 0 or args.speaker_min_frames > 3000:
        sys.exit("bad --speaker-min-frames (the lane accepts whole 10 ms frames 0..3000): %s"
                 % args.speaker_min_frames)

    if args.from_audit:
        report = run_audit_only(args) if not args.from_report else run_from_report(args)
    elif args.from_report:
        report = run_from_report(args)
    else:
        if not re.match(r"^b-\d{1,12}$", args.batch_id):
            sys.exit("bad batch_id (expected b-NNNNNN)")
        args.out = args.out or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                            "artifacts", "batch_verify_" + args.batch_id)
        os.makedirs(args.out, exist_ok=True)
        report = run_live(args)

    # A part the audit lane could not answer for is a real failure of the verification, and it is
    # reported as one - AFTER report_v3.* has been written, so the evidence is always on disk.
    st = (report or {}).get("speaker_totals") or {}
    if args.rerender_hint and not (args.speaker_audit or args.from_audit):
        # --rerender-hint on a report that ALREADY carries an audit (re-scoring a report_v3.json):
        # the hints come from the stored verdicts, and nothing is re-measured here.
        if st:
            print_rerender_hints(report, None)
        else:
            print("\n--rerender-hint: this report carries no speaker audit, so there is nothing to "
                  "name. Run --speaker-audit (live) or --from-audit <audit.json> first.")
    if st.get("parts_unverifiable"):
        print("\n%s of %s audited part(s) are UNVERIFIABLE (the lane refused, errored, was "
              "unreachable, or the WAV was missing): see %s"
              % (st["parts_unverifiable"], st.get("parts_audited"), "report_v3.md"))
        sys.exit(4)


if __name__ == "__main__":
    main()
