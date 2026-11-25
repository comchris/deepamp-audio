#!/usr/bin/env python3
"""Solo one-sentence probe: render ONE line per voice, on a model read from the live catalog, so a
human can hear each voice alone, before trusting it inside a four-voice take.

Why this exists: b-343456 rendered part 1 with a 2-voice cast and it sounded fine; parts 2 and 3
carried all four voices and the listener reported the audio breaking down after the first voice
plus strange pauses and background noise. A mixed take cannot tell those two stories apart - only
a solo take can. This script produces exactly that: one short real line, one voice, one job.

The line is taken from a real batch file (the scene's own dialogue), never invented: this lane is
ref-continuation based and invented probe text is how you get a voice that only sounds right on
probe text.

Usage:
  python3 scripts/voice_solo_probe.py \
      --voices ent_data_short,ent_worf_short,voy_doctor,noplacelikelocalhost \
      --from-batch <home>/projects/audiobook/stories_test/strek6/batches/batch_strek6_s01_v2.json \
      --pick median

  # or with your own sentence, identical for every voice (better for A/B comparison):
  python3 scripts/voice_solo_probe.py --voices voy_doctor,bijan --text "Number One, run the diagnostic again."

Notes:
- moss_ttsd is a `samples_only` family: it clones through `voice_samples` (server-side WAV paths),
  so a solo probe MUST dispatch as `speakers:[name]`, never `voice:<name>` (the plugin refuses the
  latter with a named error).
- `dispatch_tts` is NON-blocking (it answers job_id right away); `dispatch_stt` is BLOCKING (it
  answers when the job is terminal). This script polls job_status, which is a plugin queue poll,
  not an engine /status probe.
- Each probe is queued FIFO on the TTS endpoint, so probes queue behind whatever is rendering.
"""

import argparse
import json
import os
import sys
import time
import urllib.request

ORIGIN = os.environ.get("DSH_WEB_URL") or "http://127.0.0.1:3080"
API = ORIGIN + "/api/deepamp/"

# The named fallback, not the default. A model a script carries is a claim with no date, and the one
# this file used to carry had gone stale in exactly the way the workspace rule exists to prevent: the
# live catalog read of 2026-11-10 lists `moss_ttsd_q8`, `moss_ttsd_q4_k` and `moss_ttsd_bf16` and NOT
# plain `moss_ttsd`, so the model this script asked for by default was one the lane would refuse. The
# model is read from the lane (see resolve_model); this line is only what runs when the read fails.
MODEL_FALLBACK = "moss_ttsd_q8"

TERMINAL = ("ok", "error", "aborted", "cancelled")


def call(route, payload=None, timeout=120):
    url = API + route
    if payload is None:
        req = urllib.request.Request(url)
    else:
        data = json.dumps(payload).encode()
        req = urllib.request.Request(url, data=data,
                                     headers={"Content-Type": "application/json"},
                                     method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def resolve_model():
    """Read the live catalog and choose a model this script can actually use.

    This script's whole job is to render one sentence per REGISTERED voice, so a model that cannot
    take a sample is not a candidate: the catalog answer carries `clone_required` / `clone_optional`
    per model, and those are what this reads. A model the engine already has loaded is preferred — a
    default that forces a 60-120 s model load is a cost, not a default. The named fallback at the end
    is used only when the read answers nothing, and it is printed as the fallback it is. Which model
    SHOULD be used is still the caller's call: `--model` wins and is never second-guessed here.
    (WM-23 item 9, plugin card T-775: "the other scripts should have default fallbacks".)
    """
    try:
        models = call("get_models?fn=tts").get("models") or []
    except Exception as exc:
        print("[probe] the catalog read at %s answered nothing (%s); running on the named fallback %s "
              "— the lane may still refuse it, and --model overrides this." % (API, exc, MODEL_FALLBACK))
        return MODEL_FALLBACK, "named_fallback_after_failed_read"
    rows = [m for m in models if isinstance(m, dict) and m.get("id")]
    clonable = [m for m in rows if m.get("clone_required") or m.get("clone_optional")]
    pick = (next((m["id"] for m in clonable if m.get("loaded")), None)
            or next((m["id"] for m in clonable), None)
            or next((m["id"] for m in rows), None))
    if not pick:
        print("[probe] the catalog at %s listed no model; running on the named fallback %s." % (API, MODEL_FALLBACK))
        return MODEL_FALLBACK, "named_fallback_empty_catalog"
    print("[probe] model resolved from the live catalog read at %s: %s (%d of %d listed models take a "
          "voice sample; a loaded model was preferred%s)."
          % (API, pick, len(clonable), len(rows),
             "" if any(m.get("loaded") for m in clonable) else ", and none was loaded"))
    return pick, "live_catalog_read"


def get_job(job_id):
    d = call("job_status?job_id=" + job_id)
    return d.get("job") or d


def wait_job(job_id, max_wait):
    t0 = time.time()
    while time.time() - t0 < max_wait:
        j = get_job(job_id)
        if j.get("status") in TERMINAL:
            return j
        time.sleep(10)
    return get_job(job_id)


def pick_lines(doc, voices, mode):
    """Choose one line per voice out of a real batch file."""
    dlg = doc.get("dialogue") or doc.get("items") or []
    by_voice = {}
    for e in dlg:
        n = str(e.get("name") or "").strip()
        t = str(e.get("text") or "").strip()
        if n in voices and t:
            by_voice.setdefault(n, []).append(t)
    out = {}
    for v in voices:
        cands = by_voice.get(v) or []
        if not cands:
            out[v] = None
            continue
        if mode == "shortest":
            out[v] = min(cands, key=len)
        elif mode == "longest":
            out[v] = max(cands, key=len)
        else:  # median: closest to 110 chars, i.e. a full thought, never a 1-3 word stub
            out[v] = min(cands, key=lambda t: abs(len(t) - 110))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--voices", required=True, help="comma-separated plugin registry names")
    ap.add_argument("--model", default=None,
                    help="render on this model. With no --model the model is read from the live "
                         "catalog (get_models?fn=tts) and the choice is printed; a read that answers "
                         "nothing falls back to the named fallback and says so.")
    ap.add_argument("--from-batch", default=None, help="batch JSON to take the probe line from")
    ap.add_argument("--text", default=None,
                    help="use this exact sentence for every voice instead of scene lines")
    ap.add_argument("--pick", choices=["median", "shortest", "longest"], default="median")
    ap.add_argument("--max-wait", type=int, default=3600, help="seconds to wait for one probe")
    ap.add_argument("--play", action="store_true",
                    help="queue each finished probe into the playlist so it can be listened to")
    ap.add_argument("--out", default=None, help="where to write probe_manifest.json")
    args = ap.parse_args()

    voices = [v.strip() for v in args.voices.split(",") if v.strip()]
    if not voices:
        sys.exit("no voices given")

    model, model_source = (args.model, "given_by_caller") if args.model else resolve_model()

    lines = {}
    if args.text:
        lines = {v: args.text for v in voices}
    elif args.from_batch:
        with open(args.from_batch, "r", encoding="utf-8") as f:
            lines = pick_lines(json.load(f), voices, args.pick)
    else:
        sys.exit("give either --text or --from-batch")

    missing = [v for v in voices if not lines.get(v)]
    if missing:
        print("no probe line found for: " + ", ".join(missing)
              + " (that voice does not speak in this batch file)")

    out_dir = args.out or os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                       "artifacts", "voice_probe_" + time.strftime("%Y%m%d_%H%M%S"))
    os.makedirs(out_dir, exist_ok=True)

    manifest = {"model": model, "model_source": model_source,
                "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "probes": []}

    # Dispatch first, then wait: the queue is FIFO on one endpoint, so all probes enqueue in
    # order and render one after another without this script sitting between them.
    dispatched = []
    for v in voices:
        text = lines.get(v)
        if not text:
            continue
        r = call("dispatch_tts", {"fn": "tts", "model": model,
                                  "speakers": [v], "text": text,
                                  "title": "solo probe " + v})
        if not r.get("ok"):
            err = str(r.get("error") or "")
            print("DISPATCH FAILED %s: %s" % (v, err))
            manifest["probes"].append({"voice": v, "dispatch_error": err})
            # This script dispatches `speakers:[name]`, which the lane accepts on a voice_samples family only.
            # The first refusal of that kind is an answer about the MODEL, not about this voice, so the rest of
            # the list is certain to fail the same way: stop and say what to change instead of queueing N rows
            # that are each refused at the door.
            if "voice_samples" in err:
                print("STOP: this script sends speakers:[name], which the lane takes on a voice_samples family "
                      "only. Name such a model with --model, or read the vocabulary with "
                      "audio_status {what:\"voice_modes\"} / GET voice_modes?fn=tts&model=<id>.")
                manifest["stopped_reason"] = "speakers is not accepted on the model named"
                break
            continue
        dispatched.append((v, text, r["job_id"], r.get("route_url")))
        print("queued %-24s job %s  (%d chars)" % (v, r["job_id"], len(text)))

    for v, text, jid, route in dispatched:
        j = wait_job(jid, args.max_wait)
        entry = {"voice": v, "job_id": jid, "status": j.get("status"),
                 "text": text, "chars": len(text),
                 "audio_seconds": j.get("duration"),
                 "elapsed_load_s": round((j.get("elapsed_load") or 0) / 1000, 1),
                 "elapsed_gen_s": round((j.get("elapsed_gen") or 0) / 1000, 1),
                 "output_path": j.get("output_path"),
                 "listen_url": ORIGIN + (route or ("/deepamp/" + jid)),
                 "error": j.get("error") or ""}
        if args.play and j.get("status") == "ok" and j.get("output_path"):
            p = call("play_file", {"path": j["output_path"], "title": "solo probe " + v})
            entry["playlist_row"] = p.get("job_id") or None
        manifest["probes"].append(entry)
        print("  %-24s %-6s %5.1f s audio  load %5.1f s  gen %6.1f s  %s"
              % (v, entry["status"], entry["audio_seconds"] or 0,
                 entry["elapsed_load_s"], entry["elapsed_gen_s"], entry["listen_url"]))

    with open(os.path.join(out_dir, "probe_manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    print("manifest -> " + os.path.join(out_dir, "probe_manifest.json"))


if __name__ == "__main__":
    main()
