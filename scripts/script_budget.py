#!/usr/bin/env python3
"""Predict whether each line of a multi-speaker script fits the time its speaker actually had.

Why this exists (2026-10-13, T-327): dispatch_batch plans parts against a frame budget and reports
`over_budget` per PART, after the work is queued. On the kitchen re-voicing run (b-111327) part 2 came
back `lines 1, chars 535, est_seconds 35.3, frame_seconds 30, over_budget True` - one diar turn whose
text cannot be spoken inside the seconds that turn actually occupied (19.12 s in the original). The lane
then spends tens of minutes on a CPU render that is known in advance to land outside the margin. This
tool answers that question before the lane is asked for anything, from the diarisation the script was
imported from.

The renderer's rate is read off a batch plan response (chars -> est_seconds), so the estimate is this
model's measured rate, not a guess about speech.

Exit codes: 0 every line fits; 1 at least one line cannot; 2 the inputs do not line up.
"""
import argparse
import json
import re
import sys

SPEAKER_LINE = re.compile(r"^\s*([A-Za-z0-9_.-]{1,64})\s*:\s*(.*)$")


def load(path):
    d = json.load(open(path))
    return d if isinstance(d, dict) else {}


def main():
    ap = argparse.ArgumentParser(description="predict per-line fit against the speaker's own seconds")
    ap.add_argument("--script", required=True, help="NAME: text file, or a scene JSON with a dialogue list")
    ap.add_argument("--diar-json", help="the dispatch_speaker_asr response the script came from (carries speaker_turns)")
    ap.add_argument("--map", action="append", default=[], metavar="LABEL=NAME", help="diar label to speaker name, repeat per label")
    ap.add_argument("--plan", help="a dispatch_batch response, to read the renderer's chars-per-second rate off its own estimates")
    ap.add_argument("--chars-per-second", type=float, help="rate to use instead of reading it from --plan")
    ap.add_argument("--frame-seconds", type=float, default=30.0, help="the frame budget a part may not exceed (batch default 30)")
    ap.add_argument("--tolerance", type=float, default=0.10, help="fraction of a span that may be overrun before it counts as a failure")
    ap.add_argument("--out", help="write the per-line table here as JSON")
    a = ap.parse_args()

    lines = []
    if a.script.endswith(".json"):
        d = load(a.script)
        for l in (d.get("dialogue") or []):
            if isinstance(l, dict) and l.get("name") and l.get("text"):
                lines.append({"name": str(l["name"]), "text": str(l["text"]), "start": l.get("start"), "end": l.get("end")})
    else:
        for raw in open(a.script, encoding="utf-8"):
            m = SPEAKER_LINE.match(raw.rstrip("\n"))
            if m:
                lines.append({"name": m.group(1), "text": m.group(2), "start": None, "end": None})
    if not lines:
        print("NOT COMPARABLE: the script carries no NAME: text lines")
        return 2

    rate = a.chars_per_second
    rate_src = "--chars-per-second"
    if rate is None and a.plan:
        p = load(a.plan)
        tot_c = 0
        tot_s = 0.0
        for part in (p.get("parts") or []):
            c = part.get("chars") or 0
            s = part.get("est_seconds") or 0
            if c and s:
                tot_c += c
                tot_s += float(s)
        if tot_c and tot_s:
            rate = tot_c / tot_s
            rate_src = "read off %s: %d chars over %.1f estimated seconds" % (a.plan, tot_c, tot_s)
    if rate is None:
        print("NOT COMPARABLE: no render rate available (pass --plan <batch response> or --chars-per-second)")
        return 2

    label_map = {}
    for m in a.map:
        if "=" not in m:
            print("NOT COMPARABLE: --map wants LABEL=NAME, got " + m)
            return 2
        k, v = m.split("=", 1)
        label_map[k.strip()] = v.strip()

    span_s = {}
    turn_counts = {}
    turns_by_name = {}
    if a.diar_json:
        dd = load(a.diar_json)
        for t in (dd.get("speaker_turns") or []):
            nm = label_map.get(str(t.get("speaker_id")))
            if not nm:
                continue
            span_s[nm] = span_s.get(nm, 0.0) + max(0.0, float(t.get("end", 0)) - float(t.get("start", 0)))
            turn_counts[nm] = turn_counts.get(nm, 0) + 1
            turns_by_name.setdefault(nm, []).append(max(0.0, float(t.get("end", 0)) - float(t.get("start", 0))))

    # Pairing is by ORDER within a speaker, the same rule scripts/timing_compare.py uses after the render:
    # the k-th line a speaker speaks is measured against the k-th turn that speaker was given. When the two
    # counts differ the pairing is stated as approximate rather than forced, because a script that merged
    # two turns into one line is not the same shape as the diar that produced it.
    seen_by_name = {}
    pairing_note = {}
    for nm in turns_by_name:
        n_lines = len([l for l in lines if l["name"] == nm])
        n_turns = len(turns_by_name[nm])
        if n_lines != n_turns:
            pairing_note[nm] = "%d script lines against %d diar turns - paired in order, the extra %s is unmatched" % (
                n_lines, n_turns, "lines" if n_lines > n_turns else "turns")

    rows = []
    bad = 0
    for i, l in enumerate(lines):
        chars = len(l["text"])
        est = chars / rate
        own = span_s.get(l["name"]) if a.diar_json else None
        idx = seen_by_name.get(l["name"], 0)
        seen_by_name[l["name"]] = idx + 1
        # A script imported by scripts/transcript_to_script.py carries the seconds its speaker actually had
        # ON THE LINE, because the line came from a diar turn. That is the honest budget and it survives a
        # merge (two turns became one line, and the line carries the whole span). Index pairing is the
        # fallback for a hand-written NAME: text script, and it is labelled as the fallback it is.
        span_src = "paired by index"
        turn_span = None
        if l.get("start") is not None and l.get("end") is not None:
            try:
                turn_span = max(0.0, float(l["end"]) - float(l["start"]))
                span_src = "the line's own seconds"
            except (TypeError, ValueError):
                turn_span = None
        if turn_span is None and l["name"] in turns_by_name and idx < len(turns_by_name[l["name"]]):
            turn_span = turns_by_name[l["name"]][idx]
        over = None
        verdict = "no diar span for this speaker"
        if turn_span is not None and turn_span > 0:
            over = est - turn_span
            room = int(turn_span * rate)
            if over <= turn_span * a.tolerance:
                verdict = "FITS (%.2f s, %s)" % (turn_span, span_src)
            else:
                verdict = "OVERRUN by %.1f s against %.2f s (%s) - the text would have to come down to about %d characters" % (
                    over, turn_span, span_src, room)
                bad += 1
        elif own is not None and own > 0:
            verdict = "no turn left to pair with this line (speaker has %.2f s across %d turns)" % (own, turn_counts.get(l["name"], 0))
        if est > a.frame_seconds and (turn_span is None or over is not None and over <= turn_span * a.tolerance):
            verdict += "; a part may not exceed %.0f s, so split the line" % a.frame_seconds
            bad += 1
        rows.append({"line": i + 1, "name": l["name"], "chars": chars, "est_seconds": round(est, 2),
                     "paired_turn_seconds": None if turn_span is None else round(turn_span, 2),
                     "span_source": span_src if turn_span is not None else "none",
                     "max_chars_to_fit_turn": None if turn_span is None else int(turn_span * rate),
                     "speaker_seconds_in_diar": None if own is None else round(own, 2),
                     "surplus_seconds": None if over is None else round(over, 2), "verdict": verdict,
                     "text_head": l["text"][:70]})

    print("script            : %s  (%d lines, %d speakers)" % (a.script, len(lines), len({l["name"] for l in lines})))
    print("render rate       : %.1f chars/second (%s)" % (rate, rate_src))
    print("frame budget      : %.0f s per part, tolerance %.0f%% of a speaker's own seconds" % (a.frame_seconds, a.tolerance * 100))
    if a.diar_json:
        print("diar              : %s" % a.diar_json)
        for nm in sorted(span_s):
            print("   %-14s %2d turns  %.2f s of speech" % (nm, turn_counts.get(nm, 0), span_s[nm]))
        for nm in sorted(pairing_note):
            print("   pairing %s: %s" % (nm, pairing_note[nm]))
    print("per line")
    for r in rows:
        print("   %2d %-14s %4d chars  ~%5.1f s  speaker %s  %s" % (
            r["line"], r["name"], r["chars"], r["est_seconds"],
            "-" if r["speaker_seconds_in_diar"] is None else "%5.2f s" % r["speaker_seconds_in_diar"], r["verdict"]))
    total_est = sum(r["est_seconds"] for r in rows)
    total_own = sum(v for v in span_s.values())
    if total_own:
        print("totals            : text needs ~%.1f s, the speakers had %.2f s between them (%s)" % (
            total_est, total_own, "the whole scene fits" if total_est <= total_own * (1 + a.tolerance) else "the whole scene overruns"))
    if a.out:
        json.dump({"script": a.script, "rate_chars_per_second": rate, "rate_source": rate_src,
                   "frame_seconds": a.frame_seconds, "tolerance": a.tolerance, "lines": rows}, open(a.out, "w"), indent=2)
        print("wrote", a.out)
    if bad:
        print("VERDICT: %d line(s) cannot be spoken inside the time their speaker actually had" % bad)
        return 1
    print("VERDICT: every line fits its speaker's own seconds and the part budget")
    return 0


if __name__ == "__main__":
    sys.exit(main())
