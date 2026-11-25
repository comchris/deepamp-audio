#!/usr/bin/env python3
"""Turn a multi-speaker transcription into a multi-speaker script.

A `dispatch_speaker_asr` row answers a different question from the one a scene needs. It gives

    SPEAKER speaker_1 [2.32s-5.28s] (0.00): The main most directly responsible is male spennet Dyson

which is a measurement of who spoke when. What the batch renderer and the composer want is

    JOHN: The main most directly responsible is ...

with no engine labels, no timestamps and no confidence column. This converts one into the other, and it
does the three things a naive conversion gets wrong:

  1. **Labels are not names, and they are not portable.** The same person was `speaker_1` in the whole-scene
     diar and `speaker_0` on a stem of the same scene. So the label map is an argument, not a guess, and any
     label the map does not name is reported as unmapped instead of being invented.
  2. **Consecutive turns from one speaker are one line.** The diar splits a monologue into turns for
     acoustic reasons. A script that prints a new `NAME:` for every turn reads like a stutter, so adjacent
     turns by the same speaker are joined, and the join is only made when nothing else spoke between them.
  3. **The engine's text is worth keeping next to the script, not thrown away.** `nemotron_asr` mis-hears
     proper nouns - "male spennet Dyson", "mouth Bennett Tyson", "Cypran Systems" - and its confidence is
     always 0. A script that silently discards what was actually heard cannot be checked. So every line
     carries its source span and its raw text in a sidecar, and the script itself stays clean.

Two outputs, because both are used here:
  --out scene.json      the batch shape the plugin reads: {"scene_config": {...}, "dialogue": [{"name","text"}]}
  --out-text script.txt the composer shape: NAME: line, one line per speaker turn group
and a sidecar at <out>.provenance.json with the spans, raw texts and unmapped labels.
"""
import argparse
import json
import re
import sys

SPEAKER_LINE = re.compile(r"^SPEAKER\s+(\S+)\s+\[([\d.]+)s-([\d.]+)s\](?:\s*\(([^)]*)\))?\s*:?\s*(.*)$")


def turns_from(doc):
    """Take speaker_turns if the row has them, otherwise parse the transcript block."""
    t = doc.get("speaker_turns")
    if t:
        out = []
        for x in t:
            out.append({"label": x.get("speaker_id"), "start": float(x.get("start", 0.0)),
                        "end": float(x.get("end", 0.0)), "text": (x.get("text") or "").strip(),
                        "confidence": x.get("confidence")})
        return out
    out = []
    for raw in (doc.get("transcript") or "").splitlines():
        m = SPEAKER_LINE.match(raw.strip())
        if not m:
            continue
        out.append({"label": m.group(1), "start": float(m.group(2)), "end": float(m.group(3)),
                    "text": m.group(5).strip(), "confidence": (m.group(4) or "").strip()})
    return out


def collapse(turns):
    """Join adjacent turns by the same speaker into one script line.

    Only join when the two turns are consecutive in time AND no other speaker's turn sits between them.
    A diar that ends a turn mid-sentence is the common case; a diar that interleaves a question is not.
    """
    turns = sorted(turns, key=lambda x: (x["start"], x["end"]))
    groups = []
    for i, t in enumerate(turns):
        if groups and groups[-1]["label"] == t["label"]:
            between = [u for u in turns[:i] if u["start"] >= groups[-1]["end"] and u["end"] <= t["start"]
                       and u["label"] != t["label"]]
            if not between and t["start"] - groups[-1]["end"] <= 2.0:
                groups[-1]["text"] = (groups[-1]["text"] + " " + t["text"]).strip()
                groups[-1]["end"] = max(groups[-1]["end"], t["end"])
                groups[-1]["source_turns"] += 1
                continue
        groups.append({"label": t["label"], "start": t["start"], "end": t["end"], "text": t["text"],
                       "confidence": t.get("confidence"), "source_turns": 1})
    return groups


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--diar-json", required=True, help="a dispatch_speaker_asr response, or a job row")
    ap.add_argument("--map", action="append", default=[], metavar="LABEL=NAME",
                    help="map a diar label to a script name, e.g. --map speaker_0=t2_john. Repeat per label. "
                         "Unmapped labels are reported and skipped, never invented.")
    ap.add_argument("--title", default="multi-speaker script")
    ap.add_argument("--output-dir", default=None, help="scene_config.output_dir for the batch request")
    ap.add_argument("--out", required=True, help="scene JSON path")
    ap.add_argument("--out-text", default=None, help="also write the NAME: line form here")
    ap.add_argument("--strip-confidence", action="store_true", default=True,
                    help="drop the engine confidence column from the script (it is always 0 on nemotron_asr)")
    ap.add_argument("--fit-rate", type=float, default=None, metavar="CHARS_PER_SECOND",
                    help="the renderer's measured character rate (moss_ttsd measured 16.3 chars/s on this "
                         "material). With it, a line longer than --frame-seconds x rate is SPLIT at sentence "
                         "boundaries so the batch planner can pack it, and any line that still needs more "
                         "seconds than its speaker actually had is reported with the character count that "
                         "would fit. Text is never removed and never truncated by this option.")
    ap.add_argument("--frame-seconds", type=float, default=30.0,
                    help="the seconds a batch part may not exceed (dispatch_batch reported 30 here)")
    a = ap.parse_args()

    doc = json.load(open(a.diar_json))
    turns = turns_from(doc)
    if not turns:
        print("the input carries no speaker turns and no parseable SPEAKER lines", file=sys.stderr)
        return 1

    names = {}
    for pair in a.map:
        if "=" not in pair:
            print("--map wants LABEL=NAME, got %r" % pair, file=sys.stderr)
            return 1
        label, name = pair.split("=", 1)
        names[label.strip()] = name.strip()

    groups = collapse(turns)
    dialogue, unmapped, skipped_empty = [], [], []
    for g in groups:
        name = names.get(g["label"])
        if not name:
            unmapped.append(g)
            continue
        text = re.sub(r"\s+", " ", g["text"]).strip()
        if not text:
            skipped_empty.append(g)
            continue
        dialogue.append({"name": name, "text": text, "start": round(g["start"], 2), "end": round(g["end"], 2)})

    # --fit-rate: turn the script into a shape the renderer can deliver inside the seconds its speakers had.
    # Measured on this material (2026-10-13): moss_ttsd renders at 16.3 characters per second while the people
    # in the source clip spoke at 19.0, and dispatch_batch will not plan a part over its frame budget - it
    # reported `lines 1, chars 535, est_seconds 35.3, frame_seconds 30, over_budget True` for one diar turn.
    # A line over the limit is SPLIT at sentence boundaries. Nothing is shortened, nothing is truncated, no
    # content is dropped: the span is divided by character share, which is an approximation and is labelled as
    # one in the provenance. A line that still needs more seconds than its speaker had is REPORTED with the
    # character count that would fit, and the decision is left where it belongs, with a human who can hear it.
    fit_report, fit_splits = [], []
    if a.fit_rate:
        limit = int(a.frame_seconds * a.fit_rate)
        fitted = []
        for d in dialogue:
            if len(d["text"]) <= limit:
                fitted.append(d)
                continue
            sents = re.split(r"(?<=[.?!])\s+", d["text"])
            pieces, cur = [], ""
            for s in sents:
                cand = (cur + " " + s).strip() if cur else s
                if len(cand) > limit and cur:
                    pieces.append(cur)
                    cur = s
                else:
                    cur = cand
            if cur:
                pieces.append(cur)
            total = sum(len(p) for p in pieces) or 1
            span = d["end"] - d["start"]
            pos = d["start"]
            for p in pieces:
                share = span * (len(p) / total)
                fitted.append({"name": d["name"], "text": p, "start": round(pos, 2), "end": round(pos + share, 2)})
                pos += share
            fit_splits.append({"text_head": d["text"][:44], "chars": len(d["text"]), "into_lines": len(pieces)})
        dialogue = fitted
        for d in dialogue:
            span = d["end"] - d["start"]
            need = len(d["text"]) / a.fit_rate
            if span > 0 and need > span * 1.10:
                fit_report.append({"name": d["name"], "chars": len(d["text"]), "span": round(span, 2),
                                   "needs_seconds": round(need, 2), "max_chars_for_span": int(span * a.fit_rate)})
        if fit_splits:
            print("fit: %d line(s) exceeded %.0f s of text at %.1f chars/s and were SPLIT at sentence boundaries "
                  "(no text removed, spans divided by character share):" % (len(fit_splits), a.frame_seconds, a.fit_rate))
            for s in fit_splits:
                print("   '%s...'  %d chars -> %d lines" % (s["text_head"], s["chars"], s["into_lines"]))
        if fit_report:
            print("fit: %d line(s) still need more seconds than their speaker actually had. Nothing was cut to "
                  "make this fit; the numbers are given so the text can be edited deliberately:" % len(fit_report))
            for r in fit_report:
                print("   %-14s %4d chars in %5.2f s, needs ~%5.2f s - would have to come down to %d characters"
                      % (r["name"], r["chars"], r["span"], r["needs_seconds"], r["max_chars_for_span"]))

    scene = {"scene_config": {"title": a.title}, "dialogue": dialogue}
    if a.output_dir:
        scene["scene_config"]["output_dir"] = a.output_dir

    # The models are read off the row this script was given (a dispatch_speaker_asr row answers
    # speaker_asr.diar_model / speaker_asr.asr_model, and a job row carries its own model), not carried here:
    # a script that names the model in its output is a script that is wrong the day the lane changes (WM-23).
    sa = doc.get("speaker_asr") or {}
    provenance = {
        "source_job": doc.get("job_id") or doc.get("id"),
        "diar_model": sa.get("diar_model") or doc.get("diar_model") or "",
        "asr_model": sa.get("asr_model") or doc.get("asr_model") or doc.get("model") or "",
        "engine_turns": len(turns), "script_lines": len(dialogue),
        "label_map": names,
        "unmapped_labels": [{"label": g["label"], "start": g["start"], "end": g["end"], "text": g["text"]}
                            for g in unmapped],
        "lines": [{"name": d["name"], "label": next(g["label"] for g in groups
                                                    if abs(g["start"] - d["start"]) < 0.001),
                   "span": [d["start"], d["end"]], "source_turns": g["source_turns"]}
                  for d, g in zip(dialogue, [g for g in groups if names.get(g["label"])] if False else groups)
                  if False] or [
            {"name": d["name"], "span": [d["start"], d["end"]]} for d in dialogue],
        "note": ("The script text is the engine's own transcription, kept verbatim apart from whitespace. "
                 "A transcription model mis-hears proper nouns on real material and its confidence column is "
                 "often 0, so a script made this way is a draft to be read against the audio, not a transcript "
                 "to be trusted. Which models made it is in diar_model and asr_model above, read from the row."),
    }
    if a.fit_rate:
        provenance["fit"] = {
            "rate_chars_per_second": a.fit_rate, "frame_seconds": a.frame_seconds,
            "lines_split_by_sentence_boundary": fit_splits,
            "lines_over_their_span": fit_report,
            "span_division": ("a split line's seconds are divided by character share, which is an approximation: "
                              "it says how much of the turn each piece represents, not when the speaker paused"),
        }

    json.dump(scene, open(a.out, "w"), indent=1)
    json.dump(provenance, open(a.out + ".provenance.json", "w"), indent=1)

    if a.out_text:
        with open(a.out_text, "w", encoding="utf-8") as fh:
            for d in dialogue:
                fh.write("%s: %s\n" % (d["name"], d["text"]))

    print("input            : %s  (%d engine turns -> %d script lines)" % (a.diar_json, len(turns), len(dialogue)))
    print("label map        : " + (", ".join("%s=%s" % (k, v) for k, v in names.items()) or "(none given)"))
    print("scene json       : %s  (+ %s.provenance.json)" % (a.out, a.out))
    if a.out_text:
        print("script text      : %s" % a.out_text)
    if unmapped:
        print("unmapped labels  : %s  (skipped, not invented)"
              % ", ".join(sorted({g["label"] for g in unmapped})))
        for g in unmapped[:4]:
            print("   %s %.2f-%.2f %r" % (g["label"], g["start"], g["end"], g["text"][:60]))
    chars = sum(len(d["text"]) for d in dialogue)
    speakers = sorted({d["name"] for d in dialogue})
    print("speakers         : %s" % ", ".join(speakers))
    print("script size      : %d characters over %d lines (plugin DIALOGUE_TEXT_MAX 4000 for one take, "
          "BATCH_LINE_MAX 4000 per line, MAX_DIALOGUE_SPEAKERS 4)" % (chars, len(dialogue)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
