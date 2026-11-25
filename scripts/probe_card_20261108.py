#!/usr/bin/env python3
"""
probe_card_20261108.py - the small, named probes that WM-36 items 1, 2, 5 and 10 asked for. (2026-11-08)

Not a matrix. Each probe here exists to answer ONE question that a 64-row run could not answer, because the
question is about a boundary, not about a pass rate:

  A  How long a reference sample do the VoxCPM encoders accept? (WM-36 2) The matrix said `kael` at 16.1 s is over
     the capacity of the AudioVAE encoder on both nodes. The honest way to find the line is to walk down the lengths
     this plugin's own voice registry already carries - 15.1 s, 11.3 s, 10.2 s - and see where the refusal stops.
     No new audio is made: every sample here is a voice the registry already holds.
  B  Is VibeVoice renderable at all through this plugin, and in what shape? (WM-36 1) Four rows said "prompt has no
     valid Speaker N: lines". The engine wants numbered speakers. This probe sends numbered speakers.
  C  Does raising `max_tokens` fix the Higgs refusal? (WM-36 5) The engine's own sentence said to raise it and the
     spec declares the option. The plugin's options gate already accepts it for a family that declares it. So the
     probe is the same text, the same node, with max_tokens raised - and the answer is either a take or a refusal.
  D  Why does one CPU node load a model in half the time of the other? (WM-36 11) Generation totals agree within
     0.2 % and load medians are 5.2 s against 10.8 s. The only way to tell a cache effect from a machine effect is
     to ask the same node for the same model twice and read both numbers.

Everything is dispatched through the plugin, pinned to a named slot, and recorded. No audio is created here.
"""
import datetime
import json
import os
import sys
import time
import urllib.parse
import urllib.request

ORIGIN = os.environ.get("DEEPAMP_API", "http://127.0.0.1:3080/api/deepamp")
TERMINAL = ("ok", "error", "cancelled", "aborted")
TEXT_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scratch", "matrix_text_20261108.txt")


class Api:
    def __init__(self, origin):
        self.base = origin.rstrip("/")

    def get(self, path, timeout=45):
        with urllib.request.urlopen(self.base + path, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8") or "{}")

    def post(self, path, body, timeout=90):
        data = json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method="POST")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8") or "{}")


def wait_row(api, job_id, ceiling=1800):
    deadline = time.time() + ceiling
    js = {}
    while time.time() < deadline:
        time.sleep(4)
        try:
            d = api.get("/job_status?job_id=" + urllib.parse.quote(str(job_id)))
        except Exception:
            continue
        js = d.get("job") or d
        if js.get("status") in TERMINAL:
            if js.get("status") == "ok" and not (js.get("elapsed_gen") or js.get("duration")):
                continue  # status published before its own measurements landed
            return js
    return js


def main():
    api = Api(ORIGIN)
    text = open(TEXT_FILE).read().strip()
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d_%H%M%S")
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "artifacts", "probes", stamp)
    os.makedirs(out_dir, exist_ok=True)

    probes = []
    # A. the sample-length ladder, on one node, on both VoxCPM quants.
    for model in ("voxcpm1", "voxcpm2"):
        for voice, seconds in (("skynet", 15.1), ("ent_q_test", 11.3), ("bijan", 10.2)):
            probes.append(("A_sample_len", {"fn": "tts", "model": model, "text": text, "voice": voice,
                                            "endpoint_id": "primary"}, {"voice": voice, "sample_s": seconds}))
    # B. VibeVoice in the shape its own prompt format asks for.
    dlg = ("Speaker 1: Wait, if I can ask that - if I can ask who, then who I need to use?\n"
           "Speaker 2: You can ask. The answer is that you keep the same voice for the whole scene.\n"
           "Speaker 1: Then keep it, and read the rest of it the same way.")
    probes.append(("B_vibe_speakers", {"fn": "tts", "model": "vibevoice_7b", "text": dlg,
                                       "endpoint_id": "e-11"}, {"shape": "numbered Speaker lines, no voice"}))
    probes.append(("B_vibe_speakers_15b", {"fn": "tts", "model": "vibevoice_15b", "text": dlg,
                                           "endpoint_id": "e-11"}, {"shape": "numbered Speaker lines, no voice"}))
    # C. the same Higgs row with the option the engine named, raised.
    probes.append(("C_higgs_max_tokens", {"fn": "tts", "model": "higgs_tts", "text": text, "voice": "kael",
                                          "endpoint_id": "primary", "options": {"max_tokens": 4096}},
                   {"raised": "max_tokens 4096 (the engine's default on that row was 2048)"}))
    # D. the same model asked of the same node twice, on both nodes.
    for slot in ("primary", "e-11"):
        for n in (1, 2):
            probes.append(("D_load_repeat", {"fn": "tts", "model": "pocket_tts_en_q8", "text": text,
                                             "voice": "kael", "endpoint_id": slot}, {"pass": n, "slot": slot}))

    results = []
    for name, body, note in probes:
        print("\n>> %s %s" % (name, json.dumps({k: v for k, v in body.items() if k != "text"})[:150]))
        try:
            d = api.post("/dispatch_tts", body, timeout=120)
        except Exception as ex:
            print("   dispatch did not answer: %s" % ex)
            results.append(dict(probe=name, note=note, body=body, status="dispatch_error", error=str(ex)))
            continue
        if not d.get("ok"):
            print("   refused: %s" % str(d.get("error"))[:180])
            results.append(dict(probe=name, note=note, body=body, status="refused", error=d.get("error")))
            continue
        job_id = d.get("job_id") or (d.get("job") or {}).get("id")
        js = wait_row(api, job_id)
        row = dict(probe=name, note=note, body={k: v for k, v in body.items() if k != "text"},
                   job_id=job_id, status=js.get("status"),
                   elapsed_load_ms=js.get("elapsed_load", 0), elapsed_gen_ms=js.get("elapsed_gen", 0),
                   duration_s=js.get("duration", 0), file_name=js.get("filename") or "",
                   error=str(js.get("error") or ""))
        results.append(row)
        print("   %s load=%s gen=%s dur=%s" % (row["status"],
              (row["elapsed_load_ms"] or 0) / 1000.0, (row["elapsed_gen_ms"] or 0) / 1000.0, row["duration_s"]))
        if row["error"]:
            print("   error: %s" % row["error"][:200])
        with open(os.path.join(out_dir, "probe.json"), "w") as f:
            json.dump({"created_utc": stamp, "probes": results}, f, indent=2)

    print("\ndone -> %s" % out_dir)


if __name__ == "__main__":
    sys.exit(main())
