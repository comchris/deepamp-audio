#!/usr/bin/env python3
"""
probe_two_20261108.py - the two follow-ups the first probe run produced. (2026-11-08)

1. Higgs with max_tokens raised (WM-36 5). The first attempt never reached the engine: the plugin's own options
   gate refused it with "no capability record for family higgs_audio_tts on endpoint primary". The gate reads a
   capability record that is filled by a model_capabilities / endpoint_models read, so this run asks for that
   record first and then re-sends the same take with the option the engine named. Whatever the answer is, it says
   whether the fix is a value or a missing record.
2. SenseASR with the chunk mode the engine declared (WM-36 11). The refusal was "Silero VAD 16k model only
   supports sample_rate=16000 ... or select another audio_chunk_mode supported by the ASR model", and the model's
   own spec declares audio_chunk_mode: auto | fixed | vad | none. This asks the plugin to pass it. If the plugin
   refuses the key, that is the answer to "do we need hard limits per model" - the lever the engine offers is not
   reachable through this plugin today.

No new audio: the same real 60 s speech sample the STT matrix used.
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

ORIGIN = os.environ.get("DEEPAMP_API", "http://127.0.0.1:3080/api/deepamp")
AUDIO = os.environ.get("DEEPAMP_PROBE_AUDIO", "")
if not AUDIO:
    sys.exit("DEEPAMP_PROBE_AUDIO must name the WAV to send: this tracked script carries no path of this "
             "machine (private-data sweep 2026-11-18, TODOS item 38 class (b3)).")
TEXT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scratch", "matrix_text_20261108.txt")
TERMINAL = ("ok", "error", "cancelled", "aborted")


def get(path, timeout=60):
    with urllib.request.urlopen(ORIGIN.rstrip("/") + path, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8") or "{}")


def post(path, body, timeout=120):
    req = urllib.request.Request(ORIGIN.rstrip("/") + path, data=json.dumps(body).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8") or "{}")


def wait_row(job_id, ceiling=1500):
    deadline = time.time() + ceiling
    js = {}
    while time.time() < deadline:
        time.sleep(4)
        try:
            js = get("/job_status?job_id=" + urllib.parse.quote(str(job_id)))
        except Exception:
            continue
        js = js.get("job") or js
        if js.get("status") in TERMINAL:
            if js.get("status") == "ok" and not (js.get("elapsed_gen") or js.get("duration")):
                continue
            return js
    return js


out = {}
text = open(TEXT_FILE).read().strip()

print("== 1. capability record for the Higgs family on the primary TTS slot")
try:
    caps = get("/model_capabilities?fn=tts&id=primary", timeout=90)
    fams = caps.get("families") or {}
    rec = fams.get("higgs_audio_tts")
    out["capability_read"] = {"ok": caps.get("ok"), "source": caps.get("source"), "families_answered": len(fams),
                             "higgs_declared": sorted((rec or {}).get("options", {}).keys()) if rec else None}
    print("   ok=%s source=%s families=%d higgs=%s" % (caps.get("ok"), caps.get("source"), len(fams),
          (out["capability_read"]["higgs_declared"] or "no record")[:220]))
except Exception as ex:
    out["capability_read"] = {"error": str(ex)}
    print("   read failed: %s" % ex)

print("== 2. the same Higgs take with max_tokens raised")
try:
    d = post("/dispatch_tts", {"fn": "tts", "model": "higgs_tts", "text": text, "voice": "kael",
                               "endpoint_id": "primary", "options": {"max_tokens": 4096}})
    if not d.get("ok"):
        out["higgs_raised"] = {"status": "refused", "error": d.get("error")}
        print("   refused: %s" % str(d.get("error"))[:200])
    else:
        jid = d.get("job_id") or (d.get("job") or {}).get("id")
        js = wait_row(jid)
        out["higgs_raised"] = {"status": js.get("status"), "job_id": jid,
                               "elapsed_load_ms": js.get("elapsed_load", 0), "elapsed_gen_ms": js.get("elapsed_gen", 0),
                               "duration_s": js.get("duration", 0), "error": str(js.get("error") or "")}
        print("   %s load=%.2f gen=%.2f dur=%s %s" % (js.get("status"), (js.get("elapsed_load") or 0) / 1000.0,
              (js.get("elapsed_gen") or 0) / 1000.0, js.get("duration", 0), str(js.get("error") or "")[:160]))
except Exception as ex:
    out["higgs_raised"] = {"error": str(ex)}
    print("   dispatch did not answer: %s" % ex)

print("== 3. SenseASR with the chunk mode its own spec declares")
for mode in ("fixed", "none"):
    try:
        d = post("/dispatch_stt", {"fn": "stt", "model": "sense_asr", "file_path": AUDIO,
                                   "endpoint_id": "primary", "options": {"audio_chunk_mode": mode}}, timeout=900)
        if not d.get("ok"):
            out["sense_chunk_" + mode] = {"status": "refused", "error": d.get("error")}
            print("   %s refused: %s" % (mode, str(d.get("error"))[:220]))
        else:
            js = d.get("job") or {}
            jid = js.get("id") or d.get("job_id")
            if js.get("status") not in TERMINAL and jid:
                js = wait_row(jid)
            out["sense_chunk_" + mode] = {"status": js.get("status"), "job_id": jid,
                                          "elapsed_load_ms": js.get("elapsed_load", 0),
                                          "elapsed_gen_ms": js.get("elapsed_gen", 0),
                                          "chars": len(str(js.get("transcript") or "")),
                                          "error": str(js.get("error") or "")}
            print("   %s -> %s chars=%d %s" % (mode, js.get("status"), len(str(js.get("transcript") or "")),
                   str(js.get("error") or "")[:200]))
    except Exception as ex:
        out["sense_chunk_" + mode] = {"error": str(ex)}
        print("   %s did not answer: %s" % (mode, ex))

with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scratch", "probe_two_20261108.json"), "w") as f:
    json.dump(out, f, indent=2)
print("\ndone")
