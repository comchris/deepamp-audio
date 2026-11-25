#!/usr/bin/env python3
"""batch_export.py — pull the finished parts of a DeepAMP batch into a project directory.

Why this exists: `dispatch_batch` labels ordinary job rows, and the audio of every part is served
at /deepamp/<job_id>. From 2026-10-02 the plugin can deliver each finished part itself
(T-174 `save_dir`, naming <batch_id>_pNN.wav), but that is a host-side edit and a batch already
in flight when the edit lands has no save_dir. This script closes that gap with the SAME naming,
so a listener, batch_verify.py and the plugin all agree on one filename regardless of which path
delivered the file.

It talks only to the plugin HTTP API. It never touches the engine, so it is safe to run WHILE the
next part is rendering (rule 0.5 in audiobook/AGENTS.md).

Usage:
  python3 batch_export.py --batch-id b-343456 \
      --out <home>/projects/audiobook/stories_test/strek6/audio/scene_01_v3
  python3 batch_export.py --batch-id b-343456 --out DIR --wait   # poll until the batch is terminal
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

ORIGIN_DEFAULT = os.environ.get("DSH_WEB_URL") or "http://127.0.0.1:3080"
BATCH_ID_RE = re.compile(r"^b-\d{1,12}$")


def api_get(origin, path, timeout=30):
    url = origin.rstrip("/") + "/api/deepamp" + path
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def api_audio(origin, job_id, timeout=600):
    url = origin.rstrip("/") + "/deepamp/" + urllib.parse.quote(job_id)
    req = urllib.request.Request(url, headers={"Range": "bytes=0-"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def part_name(batch_id, part, ext="wav"):
    return "%s_p%02d.%s" % (batch_id, part or 0, ext)


def source_text_info(path):
    """T-260: the words a batch rendered, named by PATH and CONTENT, not by a title.

    A manifest that says "scene 1 v3" cannot be re-rendered by anyone but the person who
    typed it. A manifest that carries the path AND a hash of the text it came from says two
    things at once: where to look, and whether what is there now is still what was rendered.
    The hash is of the file as it is AT EXPORT TIME — if the author edited the chapter after
    the render, the hash is how the next reader finds that out. An unreadable path is recorded
    as an empty entry with the reason, never as a guess.
    """
    if not path:
        return {"path": "", "bytes": 0, "sha256": "", "why": "no --source-text given"}
    ap = os.path.abspath(path)
    try:
        with open(ap, "rb") as f:
            data = f.read()
    except OSError as e:
        return {"path": ap, "bytes": 0, "sha256": "", "why": "unreadable: %s" % e}
    return {"path": ap, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "why": ""}


def build_manifest(st, batch_id, out, ext, saved_names, source_text=None):
    """Write-side record of what this batch actually rendered.

    The legacy lane wrote batch_log_*.json into each versioned output dir; this is the
    plugin-lane equivalent, built from the plugin's own rows so the numbers are the
    engine's, not a listener's guess. `hit_frame_ceiling` is the truncation flag: a take
    that ends exactly at max_frames / 12.5 was STOPPED, not finished.

    T-260 adds the IDENTITY of a take to every part: which model and quant ran it, on which
    endpoint and host, the vetted engine options it rode (a seed is the whole point of a
    reproducible take), and the slice of script it rendered. Those keys come from the plugin's
    own rows (T-261), so they are what the engine was told, not what this script hoped.
    """
    parts = []
    for row in st.get("rows", []):
        name = part_name(batch_id, row.get("part"), ext)
        path = row.get("delivered_path") or os.path.join(out, name)
        mf = int(row.get("max_frames") or 0)
        dur = float(row.get("duration") or 0)
        ceiling = round(mf / 12.5, 2) if mf else 0.0
        parts.append({
            "part": row.get("part"),
            "job_id": row.get("job_id"),
            "status": row.get("status"),
            "cast": row.get("cast") or [],
            "audio_seconds": dur,
            "synth_seconds": round((row.get("elapsed_gen") or 0) / 1000),
            "max_frames": mf,
            "frame_ceiling_seconds": ceiling,
            "hit_frame_ceiling": bool(mf and dur and dur >= ceiling - 0.5),
            "file": path if os.path.exists(path) else "",
            "delivered_by_plugin": bool(row.get("delivered_path")),
            "deliver_error": row.get("deliver_error") or "",
            "route_url": row.get("route_url") or ("/deepamp/%s" % row.get("job_id")),
            "error": row.get("error") or "",
            # T-261 / T-260: what actually ran, and the slice of script it ran on.
            "part_chars": int(row.get("part_chars") or 0),
            "model": row.get("model") or "",
            "quant": row.get("quant") or "",
            "family": row.get("family") or "",
            "endpoint_id": row.get("endpoint_id") or "",
            "engine_host": row.get("host") or "",
            "options": row.get("options") or {},
            "options_source": row.get("options_source") or "",
            # T-264 / T-263: the rate this part ACTUALLY ran at, the seconds the split expected
            # from its own slice of script, and the drift between them. 0 / False when nothing was
            # measured — a part with no measured duration has no rate, and the manifest says so
            # rather than inventing one.
            "chars_per_sec": float(row.get("chars_per_sec") or 0),
            "rate_source": row.get("rate_source") or "",
            "expected_seconds": float(row.get("expected_seconds") or 0),
            "est_drift": float(row.get("est_drift") or 0),
            "over_run": bool(row.get("over_run")),
            # T-262: the verdict a batch_verify.py report attached to this part, if one was.
            # `speech_flag` is the tool's own word ("OK" / "SUSPECT"), `ratio_band` is the
            # plugin's calibrated band (ok / watch / warning) — both kept, neither renamed.
            "audit": row.get("audit") or None,
            "speech_ratio": (row.get("audit") or {}).get("speech_ratio"),
            "ratio_band": (row.get("audit") or {}).get("ratio_band") or "",
            "speech_flag": (row.get("audit") or {}).get("report_flag") or "",
            "non_speech_seconds": (row.get("audit") or {}).get("non_speech_seconds"),
            "diar_segments": (row.get("audit") or {}).get("diar_segments"),
        })
    return {
        "batch_id": batch_id,
        "title": st.get("title") or "",
        "save_dir": st.get("save_dir") or out,
        "parts": len(parts),
        "parts_ok": st.get("done"),
        "parts_failed": st.get("failed"),
        "audio_seconds": st.get("audio_seconds"),
        "truncated_parts": [p["part"] for p in parts if p["hit_frame_ceiling"]],
        "generated_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "part_files": sorted(saved_names) + [p["file"] for p in parts if p["delivered_by_plugin"] and p["file"]],
        "part_records": parts,
        # T-261: the scene-level identity, straight off batch_status.
        "model": st.get("model") or "",
        "quant": st.get("quant") or "",
        "family": st.get("family") or "",
        "options": st.get("options") or {},
        "options_source": st.get("options_source") or "",
        "script_chars": int(st.get("script_chars") or 0),
        # T-261: which hosts actually ran the parts of this scene (derived from the rows, so a
        # scene that spread over two machines is visible in the manifest, not only in the queue).
        "engine_hosts": ",".join(sorted({p["engine_host"] for p in parts if p["engine_host"]})) or "",
        # T-260: the words themselves are named by path + hash, and the parts add up to them.
        "source_text": source_text_info(source_text),
        "part_chars_sum": sum(p["part_chars"] for p in parts),
        # T-264: the scene's own measured rate — its script over its audio, which is the number
        # the planner's estimate (15) is judged against. Recorded here, never fed back into the
        # split (user decision 2026-10-12: no part-boundary drift in this wave).
        "measured_chars_per_sec": (round(sum(p["part_chars"] for p in parts)
                                         / sum(p["audio_seconds"] for p in parts), 2)
                                   if sum(p["audio_seconds"] for p in parts) > 0 else 0),
        # T-263 / T-262: the scene read as a set of verdicts, straight off batch_status, plus the
        # parts this export can name by number for each signal.
        "audit_summary": st.get("audit_summary") or {},
        "over_run_parts": [p["part"] for p in parts if p["over_run"]],
        "warning_parts": [p["part"] for p in parts if p["ratio_band"] == "warning"],
        "watch_parts": [p["part"] for p in parts if p["ratio_band"] == "watch"],
    }


def stitch_parts(out, batch_id, ext, paths):
    """Concatenate the parts into one listenable scene file with ffmpeg.

    Parts are takes of the SAME scene on the SAME engine, so they share sample rate, channel
    count and codec; `-c copy` concatenates them without re-encoding. Only offered when every
    part is present, because a scene missing its middle is worse than no scene at all.
    """
    if not paths:
        return None, "no part files to stitch"
    listp = os.path.join(out, "%s_concat.txt" % batch_id)
    dest = os.path.join(out, "%s_scene.%s" % (batch_id, ext))
    try:
        with open(listp, "w") as f:
            for p in paths:
                # Measured 2026-10-13 on b-517733: the plugin had already delivered each part into its own save_dir
                # (render_kitchen/), while the concat list was written into the export directory and carried bare
                # file names. The concat demuxer resolves a relative name against the LIST's directory, so ffmpeg
                # answered "Impossible to open .../render_kitchen_export/b-517733_p01.wav" for four files that all
                # existed one directory away. Absolute paths are the fix, and -safe 0 is what permits them.
                f.write("file '%s'\n" % os.path.abspath(p))
        r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0",
                            "-i", listp, "-c", "copy", dest],
                           capture_output=True, text=True, timeout=300)
        if r.returncode != 0:
            return None, "ffmpeg: %s" % (r.stderr or "").strip()[:300]
        dur = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                              "-of", "default=noprint_wrappers=1:nokey=1", dest],
                             capture_output=True, text=True, timeout=60).stdout.strip()
        os.remove(listp)
        return dest, dur
    except (OSError, subprocess.SubprocessError) as e:
        return None, str(e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--batch-id", required=True)
    ap.add_argument("--out", required=True, help="project audio dir, e.g. audio/scene_01_v3")
    ap.add_argument("--origin", default=ORIGIN_DEFAULT)
    ap.add_argument("--ext", default="wav", help="extension to write (matches the job format)")
    ap.add_argument("--wait", action="store_true", help="poll until no part is running/queued")
    ap.add_argument("--max-wait", type=int, default=7200)
    ap.add_argument("--stitch", action="store_true",
                    help="also write <batch_id>_scene.<ext>: the parts concatenated in order")
    ap.add_argument("--source-text", default="",
                    help="path of the text this scene was rendered from (T-260: recorded in the manifest as path + bytes + sha256)")
    args = ap.parse_args()

    if not BATCH_ID_RE.match(args.batch_id):
        print("batch_id looks wrong (expected b-<digits>): %s" % args.batch_id, file=sys.stderr)
        return 2
    out = os.path.abspath(args.out)
    os.makedirs(out, exist_ok=True)

    t0 = time.time()
    while True:
        try:
            st = api_get(args.origin, "/batch_status/%s" % urllib.parse.quote(args.batch_id))
        except (urllib.error.URLError, urllib.error.HTTPError) as e:
            print("batch_status failed: %s (is dsh web up?)" % e, file=sys.stderr)
            return 2
        if not st.get("ok"):
            print("batch_status: %s" % st.get("error"), file=sys.stderr)
            return 2
        if not args.wait or not st.get("running"):
            break
        if time.time() - t0 > args.max_wait:
            print("gave up after %d s, batch still running" % args.max_wait, file=sys.stderr)
            break
        print("  [%s] parts=%s done=%s running=%s" % (args.batch_id, st.get("parts"),
              st.get("done"), st.get("running")), file=sys.stderr)
        time.sleep(20)

    saved, skipped, missing = [], [], []
    for row in st.get("rows", []):
        name = part_name(args.batch_id, row.get("part"), args.ext)
        dest = os.path.join(out, name)
        if row.get("delivered_path"):
            # T-174 already delivered it; do not duplicate the file.
            skipped.append((row.get("job_id"), row.get("delivered_path")))
            continue
        if row.get("status") != "ok":
            missing.append((row.get("part"), row.get("job_id"), row.get("status")))
            continue
        try:
            data = api_audio(args.origin, row["job_id"])
        except (urllib.error.URLError, urllib.error.HTTPError) as e:
            missing.append((row.get("part"), row.get("job_id"), "download failed: %s" % e))
            continue
        if len(data) < 1000:
            missing.append((row.get("part"), row.get("job_id"), "suspiciously small: %d bytes" % len(data)))
            continue
        with open(dest, "wb") as f:
            f.write(data)
        saved.append((name, len(data), row.get("duration") or 0))

    print("batch %s: %s parts, %s saved, %s already delivered by the plugin, %s not available"
          % (args.batch_id, st.get("parts"), len(saved), len(skipped), len(missing)))
    for name, size, dur in saved:
        print("  saved %s  %s bytes  %s s audio  -> %s" % (name, size, dur, os.path.join(out, name)))
    for jid, path in skipped:
        print("  already delivered: %s -> %s" % (jid, path))
    for part, jid, why in missing:
        print("  NOT AVAILABLE part %s (%s): %s" % (part, jid, why))

    manifest = build_manifest(st, args.batch_id, out, args.ext,
                              [os.path.join(out, n) for n, _, _ in saved], args.source_text)
    mpath = os.path.join(out, "%s_manifest.json" % args.batch_id)
    try:
        with open(mpath, "w") as f:
            json.dump(manifest, f, indent=1)
        print("  manifest -> %s (%s parts, %s s audio, truncated: %s)"
              % (mpath, manifest["parts"], manifest["audio_seconds"],
                 manifest["truncated_parts"] or "none"))
        # T-260: the identity line. A manifest nobody can name is a manifest nobody can re-run.
        print("  identity: %s %s on %s (%s), %s script chars over %s parts (parts add up to %s), options: %s%s"
              % (manifest["model"] or "?", manifest["quant"] or "?", manifest["engine_hosts"],
                 manifest["family"] or "?", manifest["script_chars"], manifest["parts"],
                 manifest["part_chars_sum"],
                 json.dumps(manifest["options"]) if manifest["options"] else "none",
                 " [source " + manifest["options_source"] + "]" if manifest["options_source"] else ""))
        stxt = manifest["source_text"]
        print("  source text: %s (%s bytes, sha256 %s)%s"
              % (stxt["path"] or "not given", stxt["bytes"], stxt["sha256"][:16] or "-",
                 ("  [" + stxt["why"] + "]") if stxt["why"] else ""))
        # T-264 / T-263 / T-262: what the scene actually ran at, and what has been said about it.
        # The rate is recorded here, not fed back into the split; a scene nobody has verified
        # reports 0 audited parts and says so.
        asum = manifest.get("audit_summary") or {}
        print("  measured rate: %s chars per audio second (the split assumed 15), over-run parts: %s"
              % (manifest["measured_chars_per_sec"], manifest["over_run_parts"] or "none"))
        bands = asum.get("bands") or {}
        print("  verdicts: %s of %s parts audited, bands ok %s / watch %s / warning %s, worst ratio %s, warning parts: %s"
              % (asum.get("audited", 0), asum.get("parts", manifest["parts"]),
                 bands.get("ok", 0), bands.get("watch", 0), bands.get("warning", 0),
                 asum.get("worst_ratio") if asum.get("worst_ratio") is not None else "not measured",
                 manifest["warning_parts"] or "none"))
    except OSError as e:
        print("  manifest NOT written: %s" % e, file=sys.stderr)

    if args.stitch:
        if st.get("done") != st.get("parts"):
            print("  stitch skipped: only %s of %s parts are ok" % (st.get("done"), st.get("parts")),
                  file=sys.stderr)
        else:
            paths = []
            for row in sorted(st.get("rows", []), key=lambda r: r.get("part") or 0):
                cand = row.get("delivered_path") or os.path.join(out, part_name(args.batch_id,
                                                                                 row.get("part"), args.ext))
                if os.path.exists(cand):
                    paths.append(cand)
            if len(paths) != st.get("parts"):
                print("  stitch skipped: only %s of %s part files exist on disk"
                      % (len(paths), st.get("parts")), file=sys.stderr)
            else:
                dest, info = stitch_parts(out, args.batch_id, args.ext, paths)
                if dest:
                    print("  stitched %s  %s s  from %s parts in order" % (dest, info, len(paths)))
                else:
                    print("  stitch failed: %s" % info, file=sys.stderr)

    return 0 if not missing else 3


if __name__ == "__main__":
    sys.exit(main())
