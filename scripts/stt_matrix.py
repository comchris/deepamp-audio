#!/usr/bin/env python3
"""
stt_matrix.py - run the transcription half of the lane across the CPU slots, one model at a time. (2026-11-08)

What it is: the STT counterpart of scripts/model_matrix.py, written as its own file on purpose. The two lanes are
not the same job. A TTS row asks an engine to speak a text; an STT row asks an engine to listen to a file, and
`dispatch_stt` resolves its HTTP response only when that row's turn completes (the plugin's own note at
lib/index.js:16713 and the rule in the project guide). A runner written for one would get the other wrong.

What it records per model, per slot: the row's status, its load time and its generation time, the length of the
audio it was given, what the engine answered with (a transcript, or - for a diarization model - the shape of the
answer it returned rather than a transcript), and, when a reference text is supplied, a token match against it.

What it does NOT claim: a transcript with no reference text is a transcript, not a correct transcript. A token
match against a real ASR output from a previous bench is a comparison between two machines, not a score against a
human transcript. Both are written into the record as what they are.

The audio. The operator's standing rule is that no synthetic test audio is created. This runner is given a file by
`--audio-file` and does not make one. The run of record 2026-11-08 used a 60-second real-speech extract the
operator had captured on 2026-09-05 (`yt-downloads/extracted/speech_samples/sample_0002_61s.wav`), and a second
pass used a take this plugin itself had rendered, whose text is known exactly - that is the one pass where a word
match means something.

Usage:
  python3 scripts/stt_matrix.py --origin http://127.0.0.1:3080 --audio-file <path>            # dry run
  python3 scripts/stt_matrix.py --origin http://127.0.0.1:3080 --audio-file <path> --go       # run it
  ... --reference-text-file <path>      # a text to score the transcripts against
  ... --slots primary,e-13 --limit 2 --out <dir> --job-timeout <s>
"""
import argparse
import datetime
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

STT_TASKS = ("asr", "diar")   # the tasks the stt verb takes; separation and effect tasks ride other verbs
TERMINAL = ("ok", "error", "cancelled", "aborted")


class Api:
    def __init__(self, origin):
        self.base = origin.rstrip("/") + "/api/deepamp"

    def _call(self, path, body=None, timeout=60):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method="POST" if body is not None else "GET")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8") or "{}")

    def get(self, path, timeout=60):
        return self._call(path, None, timeout)

    def post(self, path, body, timeout=60):
        return self._call(path, body, timeout)


def human(ms):
    ms = ms or 0
    return "-" if not ms else ("%.2fs" % (ms / 1000.0) if ms < 100000 else "%.1fs" % (ms / 1000.0))


def wav_seconds(path):
    """How long the audio this row was given actually is, read from the file itself. A transcription time means
    nothing without the length it was spent on: the honest number is the real-time factor as well as the seconds."""
    try:
        import wave
        with wave.open(path, "rb") as w:
            fr, n = w.getframerate(), w.getnframes()
        return round(n / float(fr), 2) if fr else 0.0
    except Exception:
        return 0.0


TOKEN = re.compile(r"[a-z0-9']+")


def tokens(text):
    return [t for t in TOKEN.findall(str(text or "").lower()) if t]


def token_match(reference, hypothesis):
    """What fraction of the reference's tokens appear in the hypothesis, counting repeats. Order is not scored
    here; a transcription that says the right words in the wrong order still tells you the model heard them."""
    ref = tokens(reference)
    hyp = tokens(hypothesis)
    if not ref:
        return None
    pool = {}
    for t in hyp:
        pool[t] = pool.get(t, 0) + 1
    hit = 0
    for t in ref:
        if pool.get(t, 0) > 0:
            pool[t] -= 1
            hit += 1
    return round(hit / float(len(ref)), 4)


def engine_build(url):
    if not url:
        return ""
    try:
        with urllib.request.urlopen(url + "/health", timeout=15) as r:
            h = json.load(r)
    except Exception as ex:
        return "engine /health unreadable (%s)" % ex
    return " ".join(str(h.get(k) or "") for k in ("version", "git", "git_date")).strip() or "no version field"


def engine_options(url):
    """The engine's own per-model option names, read once per slot."""
    out = {}
    note = ""
    if not url:
        return out, "no engine url for this slot"
    try:
        with urllib.request.urlopen(url + "/v1/models?include_params=true", timeout=25) as r:
            body = json.load(r)
    except Exception as ex:
        return out, "engine /v1/models unreadable (%s)" % ex
    for m in (body.get("data") or body.get("models") or []):
        if not isinstance(m, dict):
            continue
        mid = str(m.get("id") or "")
        if not mid:
            continue
        # `params` is a LIST of option records, not a mapping. Read the names out of it the way the engine
        # writes them; a model that declares nothing answers with an empty list and that is a real answer.
        ps = m.get("params") or []
        opts = [p.get("name") or p.get("key") or "?" for p in ps if isinstance(p, dict)]
        out[mid] = {"task": m.get("task") or "", "options": sorted(opts), "options_declared": bool(ps)}
    return out, ""


def resolve_audio(spec):
    """The audio every row is given. A single path, a comma-separated list, or a glob — a quality pass is one
    model across many files, which is the opposite shape from a model matrix, and one runner should serve both.
    Nothing here makes audio: every entry has to exist."""
    import fnmatch
    import glob as g
    out = []
    for part in [p.strip() for p in str(spec).split(",") if p.strip()]:
        p = os.path.abspath(part)
        if os.path.isfile(p):
            out.append(p)
            continue
        if any(ch in part for ch in "*?["):
            out.extend(os.path.abspath(x) for x in sorted(g.glob(part)))
            continue
        raise SystemExit("no such audio file: %s (this runner does not create one)" % part)
    out = [p for p in dict.fromkeys(out) if os.path.isfile(p)]
    if not out:
        raise SystemExit("no audio files matched: %s" % spec)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--origin", default=os.environ.get("DEEPAMP_API", "http://127.0.0.1:3080/api/deepamp").split("/api/")[0])
    ap.add_argument("--audio-file", required=True, help="the real audio every row is given. This tool makes no audio.")
    ap.add_argument("--reference-text-file", default="", help="score the transcripts against this text")
    ap.add_argument("--slots", default="", help="slot ids, comma separated. Default: every enabled, unheld stt slot.")
    ap.add_argument("--models", default="",
                    help="model ids, comma separated. Use it to run ONE transcription model across several files - "
                         "the shape a quality pass needs, which is the opposite of the shape a model matrix needs.")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--go", action="store_true", help="dispatch. Without it this is a dry run.")
    ap.add_argument("--job-timeout", type=float, default=0.0,
                    help="seconds to allow a row. 0 reads the plugin's own job_timeout.")
    ap.add_argument("--out", default="artifacts/stt_matrix")
    a = ap.parse_args()

    audios = resolve_audio(a.audio_file)
    src_seconds = {p: wav_seconds(p) for p in audios}
    reference = ""
    if a.reference_text_file:
        with open(a.reference_text_file) as f:
            reference = f.read()

    api = Api(a.origin)
    reg = api.get("/endpoint_registry?fn=stt", timeout=30)
    wanted = [s.strip() for s in a.slots.split(",") if s.strip()]
    slots = []
    prim = reg.get("primary") or {}
    if prim.get("url") and (not wanted or "primary" in wanted):
        slots.append({"id": "primary", "url": prim["url"], "host": prim.get("host") or ""})
    for e in reg.get("endpoints") or []:
        if e.get("id") in ("primary",) or not e.get("url"):
            continue
        if wanted and e.get("id") not in wanted:
            continue
        if not e.get("enabled", True) or e.get("held_by"):
            continue
        slots.append({"id": e["id"], "url": e["url"], "host": e.get("host") or ""})
    if not slots:
        raise SystemExit("no usable stt slot. Read endpoint_registry?fn=stt.")

    ceiling = a.job_timeout
    ceiling_source = "the --job-timeout flag"
    if not ceiling:
        try:
            ceiling = float(api.get("/job_timeout", timeout=20).get("seconds") or 0)
            ceiling_source = "the plugin's own job_timeout, read through GET job_timeout"
        except Exception as ex:
            ceiling = 1800.0
            ceiling_source = "a fallback of 1800 s (GET job_timeout unreadable: %s)" % ex

    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d_%H%M%S")
    out_dir = os.path.join(a.out if not os.path.isabs(a.out) else a.out, stamp)
    if a.out.startswith("scratch/"):
        out_dir = os.path.join(a.out, stamp)
    os.makedirs(out_dir, exist_ok=True)

    plan, slot_info = [], {}
    for s in slots:
        press = api.post("/endpoint_models", {"fn": "stt", "id": s["id"]}, timeout=90)
        ep = press.get("endpoint") or press
        names = [str(x) for x in (ep.get("models") or [])]
        eng, eng_note = engine_options(s["url"])
        cap = {}
        try:
            for m in api.get("/get_models?fn=stt", timeout=40).get("models") or []:
                cap[str(m.get("id") or "")] = m
        except Exception:
            pass
        slot_info[s["id"]] = dict(s, build_recorded=ep.get("build") or "", build_measured=engine_build(s["url"]),
                                  catalog_count=len(names), engine_catalog_count=len(eng), engine_read_note=eng_note)
        ids = [n for n in names if (not eng or n in eng)]
        if a.models:
            want = [m.strip() for m in a.models.split(",") if m.strip()]
            ids = [n for n in ids if n in want]
            missing = [m for m in want if m not in ids]
            if missing:
                print("slot %s: model(s) not in that catalog and not planned: %s" % (s["id"], ", ".join(missing)))
        rows = []
        for mid in ids:
            obj = dict(cap.get(mid) or {})
            task = obj.get("task") or (eng.get(mid) or {}).get("task") or ""
            if task not in STT_TASKS:
                continue
            rows.append((mid, obj, task))
        if a.limit:
            rows = rows[:a.limit]
        for mid, obj, task in rows:
            e = eng.get(mid) or {}
            for audio in audios:
                plan.append({"slot": s["id"], "model": mid, "family": obj.get("family") or mid,
                             "quant": obj.get("quant") or "", "task": task,
                             "audio_file": audio, "audio_seconds": src_seconds[audio],
                             "declared_options": e.get("options") or [],
                             "options_declared": e.get("options_declared", False),
                             "blocked": ""})
        if eng_note:
            print("slot %s engine read: %s" % (s["id"], eng_note))

    meta = {"created_utc": stamp, "origin": a.origin, "fn": "stt", "audio_files": audios,
            "audio_seconds": src_seconds, "reference_text_file": a.reference_text_file or "",
            "reference_tokens": len(tokens(reference)), "job_ceiling_s": ceiling,
            "job_ceiling_source": ceiling_source, "slots": [
                {k: v for k, v in s.items()} for s in slot_info.values()],
            "engine_note": "build_measured is the engine's own /health answer; build_recorded is what the plugin's "
                           "registry carries, which it writes by hand and never reads from an engine."}
    with open(os.path.join(out_dir, "plan.json"), "w") as f:
        json.dump({"meta": meta, "plan": plan}, f, indent=2)

    print("stt plan -> %s/plan.json" % out_dir)
    for sid, s in slot_info.items():
        print("slot %s@%s catalog=%d build_measured=%s" % (sid, s["host"], s["catalog_count"], s["build_measured"] or "-"))
    print("audio: %d file(s)" % len(audios))
    for p in audios:
        print("   %s (%.2f s)" % (p, src_seconds[p]))
    print("job window: %d s, taken from %s" % (int(ceiling), ceiling_source))
    print("%-8s %-20s %-20s %-6s %-6s %s" % ("SLOT", "MODEL", "FAMILY", "TASK", "QUANT", "NOTE"))
    for r in plan:
        print("%-8s %-20s %-20s %-6s %-6s %s" % (r["slot"], r["model"], r["family"], r["task"], r["quant"] or "?",
                                                 r["blocked"]))
    if not a.go:
        print("\nDRY RUN - nothing dispatched (%d rows planned). Re-run with --go" % len(plan))
        return 0

    results = []

    def read_row(job_id):
        try:
            d = api.get("/job_status?job_id=" + urllib.parse.quote(job_id), timeout=30)
            return d.get("job") or d
        except Exception:
            return {}

    def settled(js):
        if js.get("status") == "ok" and not (js.get("elapsed_gen") or js.get("duration")):
            return False   # status published before the row's own measurements landed
        return True

    def run_row(r):
        t0 = time.time()
        # dispatch_stt resolves when the row's turn completes, so this call is allowed to last as long as the
        # plugin's own window. If it does not answer in time the row is still running: find it on the lane.
        try:
            d = api.post("/dispatch_stt", {"fn": "stt", "model": r["model"], "file_path": r["audio_file"],
                                           "endpoint_id": r["slot"]}, timeout=int(ceiling) + 60)
        except Exception as ex:
            d = {"ok": False, "error": "dispatch_stt did not answer within %ds: %s" % (int(ceiling) + 60, ex)}
        if not d.get("ok"):
            row = dict(r, status="rejected", error=d.get("error", ""), wall_s=round(time.time() - t0, 2))
            print("   rejected: %s" % str(d.get("error"))[:150])
            return row
        job_id = d.get("job_id") or (d.get("job") or {}).get("id") or str(d.get("route_url", "")).split("/")[-1]
        js = d.get("job") or d
        if not js.get("status"):
            js = read_row(job_id)
        deadline = time.time() + ceiling
        while not settled(js) and js.get("status") not in TERMINAL and time.time() < deadline:
            time.sleep(3)
            js = read_row(job_id)
        while js.get("status") == "ok" and not settled(js) and time.time() < deadline + 300:
            time.sleep(5)
            js = read_row(job_id)
        transcript = str(js.get("transcript") or "")
        answer_keys = sorted(k for k in js.keys() if k not in (
            "id", "kind", "fn", "model", "status", "created", "queued_at", "started", "ended", "voice", "text",
            "file_path", "format", "endpoint_id", "activity", "error", "elapsed_load", "elapsed_gen", "duration",
            "route_url", "filename", "output_path", "size_bytes", "quant", "family", "model_path", "task"))
        row = dict(r, status=js.get("status"), job_id=job_id, stt_feed=js.get("stt_feed") or {},
                   elapsed_load_ms=js.get("elapsed_load", 0), elapsed_gen_ms=js.get("elapsed_gen", 0),
                   duration_s=js.get("duration", 0), size_bytes=js.get("size_bytes", 0),
                   output_path=js.get("output_path") or js.get("route_url", ""),
                   transcript=transcript[:4000], answer_fields=answer_keys,
                   error=js.get("error", ""), wall_s=round(time.time() - t0, 2),
                   rtf=round((js.get("elapsed_gen") or 0) / 1000.0 / r["audio_seconds"], 3) if r["audio_seconds"] else None,
                   token_match=token_match(reference, transcript) if reference else None)
        print("   %s  load=%s gen=%s rtf=%s match=%s fields=%s" % (
            row["status"], human(row["elapsed_load_ms"]), human(row["elapsed_gen_ms"]),
            row["rtf"] if row["rtf"] is not None else "-",
            row["token_match"] if row["token_match"] is not None else "-",
            ",".join(row["answer_fields"]) or "-"))
        if row["error"]:
            print("   error: %s" % str(row["error"])[:180])
        if transcript:
            print("   transcript: %s" % transcript[:160].replace("\n", " "))
        return row

    for r in plan:
        print("\n>> %s on %s (task=%s)" % (r["model"], r["slot"], r["task"]))
        results.append(run_row(r))

    with open(os.path.join(out_dir, "matrix.json"), "w") as f:
        json.dump({"meta": meta, "results": results}, f, indent=2)

    ok = sum(1 for r in results if r.get("status") == "ok")
    lines = ["# stt_matrix run %s" % stamp, "",
             "Audio: %d file(s), %s s each. Job window %d s from %s." % (
                 len(audios), ", ".join("%.1f" % src_seconds[p] for p in audios), int(ceiling), ceiling_source),
             "Reference text: %s" % (a.reference_text_file or "none - a transcript with no reference is not a score"),
             "",
             "| slot | model | family | task | quant | status | load | gen | rtf | match | note |",
             "|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in results:
        lines.append("| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |" % (
            r["slot"], r["model"], r["family"], r["task"], r["quant"] or "?", r.get("status"),
            human(r.get("elapsed_load_ms", 0)), human(r.get("elapsed_gen_ms", 0)),
            r.get("rtf") if r.get("rtf") is not None else "-",
            r.get("token_match") if r.get("token_match") is not None else "-",
            (r.get("error") or "")[:90]))
    lines += ["", "Build each measurement was made on:"]
    for sid, s in slot_info.items():
        lines.append("* `%s` @ `%s` - engine's own answer: `%s` (registry carries `%s`)"
                    % (sid, s["host"], s["build_measured"] or "-", s["build_recorded"] or "-"))
    lines += ["", "A `match` column is only meaningful when a reference text was given. A transcript is not a score.", ""]
    with open(os.path.join(out_dir, "SUMMARY.md"), "w") as f:
        f.write("\n".join(lines))

    print("\ndone: %d/%d ok - %s" % (ok, len(results), out_dir))
    print("REMINDER: a transcript is what the engine heard. Compare it against the audio before trusting it.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
