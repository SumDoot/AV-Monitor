#!/usr/bin/env python3
"""
Build static/reference.json: the "what a clean OSD looks like" template the quality
evaluator compares live and recorded frames against.

It finds the two vertical dotted lines (the horizon preview) in a clip with a good signal,
and records for every dot: where it is, which pixels are its bright core and its dark outline,
and what those pixels normally look like.

Use a clip captured through the same card and settings the app will use, ideally one saved
with the page's "Save as MJPEG" button, with a clean signal and the OSD visible.

    pip install numpy opencv-python-headless        (ffmpeg must be on PATH)
    python3 tools/build_reference.py good-clip.mjpeg
    python3 tools/build_reference.py good-clip.mp4 --out static/reference.json --preview preview.png

Open the preview image: every detected dot should have a box around it.
"""
import argparse
import json
import subprocess
import sys

import cv2
import numpy as np


def probe_size(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
         "-of", "csv=p=0:s=x", path], capture_output=True, text=True)
    try:
        w, h = out.stdout.strip().split("x")
        return int(w), int(h)
    except ValueError:
        sys.exit("Could not read the video size. Is ffprobe installed and the file a video?")


def read_gray(path, w, h):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                         capture_output=True).stdout
    n = len(raw) // (w * h)
    if n < 10:
        sys.exit(f"Only {n} frames could be read from {path}.")
    return np.frombuffer(raw[: n * w * h], np.uint8).reshape(n, h, w)


def build(frames, white=150):
    # frames with no picture (the card's flat 'no signal' screen) must not shape the reference
    frames = frames[frames.reshape(len(frames), -1).std(1) > 8]
    if len(frames) < 10:
        sys.exit("Fewer than 10 frames with a picture. Use a clip where the signal is present.")
    sub = frames[:: max(1, len(frames) // 300)]
    med = np.median(sub, 0).astype(np.float32)
    p10 = np.percentile(sub, 10, 0).astype(np.float32)

    core = (p10 > white) & (med > white + 15)          # bright in 90% of frames
    n, lab, st, cen = cv2.connectedComponentsWithStats(core.astype(np.uint8), connectivity=8)
    blobs = [i for i in range(1, n) if st[i][4] >= 2 and st[i][2] <= 12 and st[i][3] <= 8]
    cx = {i: cen[i][0] for i in blobs}

    groups = []                                        # stack blobs that share an x position
    for i in sorted(blobs, key=lambda i: cx[i]):
        for gp in groups:
            if abs(np.mean([cx[j] for j in gp]) - cx[i]) <= 4:
                gp.append(i)
                break
        else:
            groups.append([i])
    groups = sorted((gp for gp in groups if len(gp) >= 8), key=lambda gp: np.mean([cx[j] for j in gp]))

    dots = []
    for li, gp in enumerate(groups):
        for i in sorted(gp, key=lambda i: cen[i][1]):
            x, y, w, h = (int(v) for v in st[i][:4])
            x0, y0 = x - 4, y - 4
            ww, hh = w + 8, h + 8
            m_core = lab[y0:y0 + hh, x0:x0 + ww] == i
            near = cv2.dilate(m_core.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
            vref = med[y0:y0 + hh, x0:x0 + ww]
            core_lvl = vref[m_core].mean()
            m_ring = near & ~m_core & (vref < core_lvl - 60)   # the dark outline the OSD draws
            if m_ring.sum() < 4 or core_lvl - vref[m_ring].mean() < 60:
                continue                                        # no clear outline: unusable as a reference
            ring_lvl = vref[m_ring].mean()
            mid = (core_lvl + ring_lvl) / 2
            wgt = np.clip(vref - mid, 0, None)
            xs = np.arange(x0, x0 + ww)[None, :]
            ys = np.arange(y0, y0 + hh)[:, None]
            core_idx = np.flatnonzero(m_core.ravel())
            ring_idx = np.flatnonzero(m_ring.ravel())
            dots.append(dict(
                line=li, x=x0, y=y0, w=ww, h=hh,
                core=core_idx.tolist(), ring=ring_idx.tolist(),
                refCore=[round(float(v), 1) for v in vref.ravel()[core_idx]],
                refRing=[round(float(v), 1) for v in vref.ravel()[ring_idx]],
                mid=round(float(mid), 2), cref=round(float(core_lvl - ring_lvl), 2),
                cx=round(float((wgt * xs).sum() / wgt.sum()), 3),
                cy=round(float((wgt * ys).sum() / wgt.sum()), 3)))
    return dots, frames, med


def frame_error(f, dots):
    """RMS difference between a frame's OSD pixels and the reference, relative to OSD contrast."""
    f = f.astype(np.float32)
    se = n = 0.0
    for d in dots:
        v = f[d["y"]:d["y"] + d["h"], d["x"]:d["x"] + d["w"]].ravel()
        a = v[d["core"]] - np.array(d["refCore"], np.float32)
        b = v[d["ring"]] - np.array(d["refRing"], np.float32)
        se += float((a * a).sum() + (b * b).sum())
        n += len(a) + len(b)
    return (se / n) ** 0.5 / float(np.mean([d["cref"] for d in dots]))


def core_noise(f, dots):
    """Grain on the OSD's flat white dots, in brightness levels (0-255), ignoring overall brightness changes."""
    f = f.astype(np.float32)
    ss = n = 0.0
    for d in dots:
        v = f[d["y"]:d["y"] + d["h"], d["x"]:d["x"] + d["w"]].ravel()[d["core"]]
        r = v - np.array(d["refCore"], np.float32)
        r -= r.mean()
        ss += float((r * r).sum())
        n += len(r) - 1
    return (ss / max(n, 1)) ** 0.5


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video", help="clip with a good signal (mjpeg, mkv, mp4, ...)")
    ap.add_argument("--out", default="static/reference.json")
    ap.add_argument("--preview", default="reference-preview.png")
    ap.add_argument("--white", type=int, default=150, help="lowest brightness of OSD white (default 150)")
    a = ap.parse_args()

    w, h = probe_size(a.video)
    dots, frames, med = build(read_gray(a.video, w, h), a.white)
    lines = sorted({d["line"] for d in dots})
    if len(lines) < 1 or len(dots) < 8:
        sys.exit("Could not find a dotted line of at least 8 dots with a dark outline.\n"
                 "Check that the OSD is visible in the clip, or lower --white.")

    sample = frames[:: max(1, len(frames) // 300)]
    err = np.array([frame_error(f, dots) for f in sample])
    noise = np.array([core_noise(f, dots) for f in sample])
    x0 = min(d["x"] for d in dots); y0 = min(d["y"] for d in dots)
    x1 = max(d["x"] + d["w"] for d in dots); y1 = max(d["y"] + d["h"] for d in dots)
    ref = dict(version=1, width=w, height=h, roi=dict(x=x0, y=y0, w=x1 - x0, h=y1 - y0),
               errClean=round(float(np.percentile(err, 95)), 4),
               noiseClean=round(float(np.percentile(noise, 95)), 2), source=a.video.split("/")[-1],
               frames=int(len(frames)), dots=dots)
    with open(a.out, "w") as fh:
        json.dump(ref, fh, separators=(",", ":"))

    vis = cv2.cvtColor(med.astype(np.uint8), cv2.COLOR_GRAY2BGR)
    for d in dots:
        cv2.rectangle(vis, (d["x"], d["y"]), (d["x"] + d["w"], d["y"] + d["h"]), (0, 255, 255) if d["line"] == 0 else (255, 200, 0), 1)
    cv2.imwrite(a.preview, vis[max(0, y0 - 20):y1 + 20, max(0, x0 - 20):x1 + 20])
    per = {l: sum(1 for d in dots if d["line"] == l) for l in lines}
    print(f"{len(dots)} dots on {len(lines)} line(s) {per}; normal error {ref['errClean']:.3f}, normal grain {ref['noiseClean']:.1f}")
    print(f"wrote {a.out} and {a.preview}")


if __name__ == "__main__":
    main()
