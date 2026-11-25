#!/usr/bin/env python3
"""batch_part_extract.py — rebuild ONE batch part's input text as a dispatchable batch file.

Why this exists: a part that was cut at its frame ceiling (see batch_export.py's
`hit_frame_ceiling` / `truncated_parts`) does not need the whole scene rendered again. The
plugin row for that part still carries the exact text it was given, already tagged [S1..Sk]
in that part's cast order, so the part can be re-dispatched on its own — one take, one
budget, no re-rendering of the parts that came out fine.

The tags are stripped on the way out, because dispatch_batch builds part-local tags itself
and pre-tagged text would be spoken as literal text (audiobook/AGENTS.md).

It talks only to the plugin HTTP API. Safe to run while another part is rendering.

Usage:
  python3 batch_part_extract.py --job-id ap-0304 \
      --out <home>/projects/audiobook/stories_test/strek6/batches/batch_strek6_s01_v2_p2.json
  # then, once the frame-budget fix (T-176) is live:
  curl -s -X POST http://127.0.0.1:3080/api/deepamp/dispatch_batch \
    -H 'Content-Type: application/json' \
    -d '{"fn":"tts","model":"moss_ttsd","title":"strek6 scene 01 part 2 re-render",
         "file":"<the file above>","part_seconds":200,"cost_per_second":30,"max_speakers":4,
         "save_dir":"<home>/projects/audiobook/stories_test/strek6/audio/scene_01_v3"}'
"""
import argparse
import json
import os
import re
import sys
import urllib.request

ORIGIN_DEFAULT = os.environ.get("DSH_WEB_URL") or "http://127.0.0.1:3080"
TAG_RE = re.compile(r"^\[S(\d+)\]\s?(.*)$")
LINE_MAX = 4000


def api_get(origin, path, timeout=30):
    url = origin.rstrip("/") + "/api/deepamp" + path
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job-id", required=True, help="the part's job id, e.g. ap-0304")
    ap.add_argument("--out", required=True, help="batch JSON to write")
    ap.add_argument("--origin", default=ORIGIN_DEFAULT)
    ap.add_argument("--title", default=None, help="scene_config.title (default: the row's batch title)")
    ap.add_argument("--output-dir", default=None,
                    help="scene_config.output_dir (default: the row's save_dir, else the dir of --out)")
    args = ap.parse_args()

    try:
        d = api_get(args.origin, "/job_status?job_id=%s" % args.job_id)
    except (OSError, ValueError) as e:
        print("job_status failed: %s" % e, file=sys.stderr)
        return 2
    job = d.get("job") or d
    if not job.get("id"):
        print("no row for %s" % args.job_id, file=sys.stderr)
        return 2

    text = str(job.get("text") or "")
    cast = list(job.get("batch_cast") or job.get("speakers") or [])
    if not text.strip():
        print("row %s carries no text - nothing to rebuild" % args.job_id, file=sys.stderr)
        return 2
    if not cast:
        print("row %s carries no cast - cannot map [SN] tags to voice names" % args.job_id,
              file=sys.stderr)
        return 2

    dialogue, dropped = [], []
    for raw in text.split("\n"):
        line = raw.strip()
        if not line:
            continue
        m = TAG_RE.match(line)
        if m:
            idx = int(m.group(1)) - 1
            name = cast[idx] if 0 <= idx < len(cast) else None
            body = m.group(2).strip()
            if not name:
                dropped.append("tag S%s has no voice in this part's cast (%s)" % (m.group(1), cast))
                continue
        else:
            # Untagged continuation of the previous line: keep it attached to that speaker.
            if not dialogue:
                dropped.append("leading untagged line: %s" % line[:60])
                continue
            dialogue[-1]["text"] = (dialogue[-1]["text"] + " " + line).strip()
            name = dialogue[-1]["name"]
            body = dialogue[-1]["text"]
        if len(body) > LINE_MAX:
            dropped.append("line for %s is %s chars, over the %s per-take limit - split it in the script"
                           % (name, len(body), LINE_MAX))
            continue
        dialogue.append({"name": name, "text": body})

    if not dialogue:
        print("no usable lines recovered from %s" % args.job_id, file=sys.stderr)
        return 2

    out = os.path.abspath(args.out)
    out_dir = args.output_dir or job.get("save_dir") or os.path.dirname(out)
    if out_dir and not os.path.isabs(out_dir):
        print("output_dir must be absolute (got %s)" % out_dir, file=sys.stderr)
        return 2
    os.makedirs(os.path.dirname(out), exist_ok=True)
    doc = {
        "scene_config": {
            "title": args.title or ("%s (part %s of %s)" % (job.get("batch_title") or job["id"],
                                                             job.get("batch_part"), job.get("batch_parts"))),
            "engine": "audio.cpp moss_ttsd via audio-play plugin",
            "output_dir": out_dir,
            "default_format": "wav",
            "source_batch_id": job.get("batch_id") or "",
            "source_job_id": job["id"],
            "note": "Rebuilt from the plugin row %s by batch_part_extract.py. Do NOT pre-tag: "
                    "dispatch_batch assigns [S1..Sk] from the cast order of THIS file." % job["id"],
        },
        "dialogue": dialogue,
    }
    with open(out, "w") as f:
        json.dump(doc, f, indent=1)

    chars = sum(len(x["text"]) for x in dialogue)
    print("wrote %s" % out)
    print("  %s lines, %s chars, cast %s (from row %s, part %s/%s of batch %s)"
          % (len(dialogue), chars, ", ".join(cast), job["id"], job.get("batch_part"),
             job.get("batch_parts"), job.get("batch_id") or "-"))
    print("  this part rendered %s s of audio with max_frames %s (%s s ceiling)"
          % (job.get("duration"), job.get("max_frames"),
             round((job.get("max_frames") or 0) / 12.5, 2)))
    for why in dropped:
        print("  DROPPED: %s" % why)
    return 0 if not dropped else 1


if __name__ == "__main__":
    sys.exit(main())
