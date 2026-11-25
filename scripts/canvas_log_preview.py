#!/usr/bin/env python3
"""Render a recorded canvas log back into a picture.

The panel's faces are drawings on a browser canvas, and this session has no browser to look at them
with. The scope suite's stub records every rectangle and every stroke the panel asks for (tests/
scope.test.cjs keeps the ink, the width and the path with the stroke), so the honest way to review a
face during a design pass is to render that log: the same geometry the panel asked for, drawn in the
order it was asked for, without a browser in the loop. This is not a screenshot of the panel and does
not pretend to be - it carries no device-pixel-ratio scaling, no antialiasing, and no alpha compositing
beyond what the log states.

Usage:
  python3 scripts/canvas_log_preview.py <log.json> <out.png> [--scale N]

The log JSON has {"w","h","rects":[[x,y,w,h,off,ink]],"strokes":[{"ink","width","path":[[x,y],...]}]}.
"""
import json
import sys
from PIL import Image, ImageDraw


def parse_ink(value):
    value = str(value).strip()
    if value.startswith("#"):
        hex_part = value[1:]
        if len(hex_part) == 6:
            return tuple(int(hex_part[i:i + 2], 16) for i in (0, 2, 4))
    return (255, 0, 255)  # an ink this script cannot read, drawn loudly


def main():
    args = [a for a in sys.argv[1:]]
    scale = 1
    for flag in ("--scale", "-s"):
        while flag in args:
            i = args.index(flag)
            scale = int(args[i + 1])
            del args[i:i + 2]
    log_path, out_path = args[0], args[1]

    data = json.load(open(log_path))
    width, height = int(data["w"]), int(data["h"])
    img = Image.new("RGB", (width * scale, height * scale), (11, 13, 11))  # the panel's own ground
    draw = ImageDraw.Draw(img)

    for rect in data.get("rects", []):
        x, y, w, h = rect[0], rect[1], rect[2], rect[3]
        if w <= 0 or h <= 0:
            continue
        draw.rectangle([x * scale, y * scale, (x + w) * scale - 1, (y + h) * scale - 1],
                       fill=parse_ink(rect[5] if len(rect) > 5 else ""))
    for stroke in data.get("strokes", []):
        path = stroke.get("path") or []
        if len(path) < 2:
            continue
        ink = parse_ink(stroke.get("ink", ""))
        pen_w = max(1, int(round(float(stroke.get("width", 1)) * scale)))
        # A path is a set of subpaths, and each one starts at its own moveTo. Joining every consecutive pair of
        # points anyway is what put a diagonal across a digit that was never drawn with one - the recorded verb
        # ('M' or 'L', tests/scope.test.cjs) is what tells the two apart.
        subpaths, current = [], []
        for point in path:
            verb = point[2] if len(point) > 2 else "L"
            if verb == "M" and current:
                subpaths.append(current)
                current = []
            current.append((point[0] * scale, point[1] * scale))
        if current:
            subpaths.append(current)
        for pts in subpaths:
            for a, b in zip(pts, pts[1:]):
                draw.line([a, b], fill=ink, width=pen_w)

    if "--keep" in args or "-k" in args:
        pass  # an enlarged view for judging a design; the pixels are not 1:1 and that is stated
    elif scale != 1:
        img = img.resize((width, height))  # downscale back for a faithful 1:1 view
    img.save(out_path)
    print("wrote", out_path, img.size)


if __name__ == "__main__":
    main()
