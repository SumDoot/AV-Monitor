import os
import time
import threading
from pathlib import Path

import cv2
from flask import Flask, Response, jsonify, render_template, request


# ============================================================
# Configuration
# ============================================================

VIDEO_FILE = "test.mkv"
BUFFER_DIR = Path("buffer")

# How long each DVR segment should be.
SEGMENT_LENGTH = 10

# Maximum amount of segments retained.
# 180 * 10 seconds = 30 minutes.
MAX_SEGMENTS = 180

# Simulated input FPS.
# Set to None to use the FPS reported by OpenCV.
SIMULATED_FPS = None

# JPEG quality used for the internal DVR.
JPEG_QUALITY = 85


# ============================================================
# Flask
# ============================================================

app = Flask(__name__)

BUFFER_DIR.mkdir(exist_ok=True)


# ============================================================
# Shared DVR state
# ============================================================

class Segment:
    def __init__(self, filename, start, duration, quality):
        self.filename = filename
        self.start = start
        self.duration = duration
        self.quality = quality

    def to_dict(self):
        return {
            "filename": self.filename,
            "start": self.start,
            "duration": self.duration,
            "quality": self.quality,
        }


segments = []

buffer_lock = threading.Lock()

# Relative DVR time.
dvr_time = 0.0

running = True


# ============================================================
# Fake signal evaluator
# ============================================================

def evaluate_frame(frame, frame_number):
    """
    Fake signal-quality evaluator.

    Returns a value from 0.0 to 1.0.

    Replace this later with the actual signal evaluator.
    """

    # --------------------------------------------------------
    # Test mode 1: constant quality
    # --------------------------------------------------------

    # return 1.0


    # --------------------------------------------------------
    # Test mode 2: slowly changing quality
    # --------------------------------------------------------

    # import math
    # return (math.sin(frame_number / 100.0) + 1) / 2


    # --------------------------------------------------------
    # Test mode 3: deliberately create bad sections
    # --------------------------------------------------------

    position = (frame_number // 150) % 4

    if position == 0:
        return 1.0       # green

    if position == 1:
        return 0.75      # green/yellow

    if position == 2:
        return 0.4       # yellow

    return 0.1           # red


# ============================================================
# DVR capture
# ============================================================

def capture_loop():

    global dvr_time

    cap = cv2.VideoCapture(VIDEO_FILE)

    if not cap.isOpened():
        print(f"ERROR: Could not open {VIDEO_FILE}")
        return

    source_fps = cap.get(cv2.CAP_PROP_FPS)

    if not source_fps or source_fps <= 0:
        source_fps = 30

    fps = SIMULATED_FPS or source_fps

    print(f"Source FPS: {source_fps}")
    print(f"Simulation FPS: {fps}")

    frame_interval = 1.0 / fps

    frame_number = 0

    while running:

        # ----------------------------------------------------
        # Create a new segment
        # ----------------------------------------------------

        segment_start = dvr_time

        filename = f"{int(segment_start):010d}.avi"
        path = BUFFER_DIR / filename

        fourcc = cv2.VideoWriter_fourcc(*"MJPG")

        writer = cv2.VideoWriter(
            str(path),
            fourcc,
            fps,
            (
                int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
                int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
            ),
        )

        if not writer.isOpened():
            print("ERROR: Could not create segment")
            return

        qualities = []

        segment_frames = int(fps * SEGMENT_LENGTH)

        print(f"Recording {filename}")

        segment_start_real = time.perf_counter()

        for _ in range(segment_frames):

            frame_start = time.perf_counter()

            ret, frame = cap.read()

            if not ret:

                # Loop source video.
                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)

                ret, frame = cap.read()

                if not ret:
                    print("ERROR: Could not read frame")
                    break

            # ------------------------------------------------
            # Fake signal evaluator
            # ------------------------------------------------

            quality = evaluate_frame(frame, frame_number)

            qualities.append(quality)

            # ------------------------------------------------
            # Store frame
            # ------------------------------------------------

            writer.write(frame)

            frame_number += 1

            # ------------------------------------------------
            # Advance relative DVR clock
            # ------------------------------------------------

            dvr_time += frame_interval

            # ------------------------------------------------
            # Real-time playback
            # ------------------------------------------------

            elapsed = time.perf_counter() - frame_start
            delay = frame_interval - elapsed

            if delay > 0:
                time.sleep(delay)

        writer.release()

        actual_duration = dvr_time - segment_start

        if qualities:
            average_quality = sum(qualities) / len(qualities)
        else:
            average_quality = 0

        segment = Segment(
            filename,
            segment_start,
            actual_duration,
            average_quality,
        )

        # ----------------------------------------------------
        # Add segment to buffer
        # ----------------------------------------------------

        with buffer_lock:

            segments.append(segment)

            # ------------------------------------------------
            # Delete old segments
            # ------------------------------------------------

            while len(segments) > MAX_SEGMENTS:

                old = segments.pop(0)

                try:
                    (BUFFER_DIR / old.filename).unlink()
                except FileNotFoundError:
                    pass


# ============================================================
# API
# ============================================================

@app.route("/api/buffer")
def buffer_info():

    with buffer_lock:

        if segments:
            start = segments[0].start
            end = segments[-1].start + segments[-1].duration
        else:
            start = 0
            end = 0

        return jsonify({
            "start": start,
            "end": end,
            "live": end,
            "duration": end - start,
            "segments": [
                s.to_dict()
                for s in segments
            ]
        })


@app.route("/api/segment/<filename>")
def segment(filename):

    path = BUFFER_DIR / filename

    if not path.exists():
        return "Segment not found", 404

    # OpenCV video isn't ideal for browser playback directly.
    # This endpoint is mainly here for debugging.
    return Response(
        path.read_bytes(),
        mimetype="video/x-msvideo"
    )


# ============================================================
# UI
# ============================================================

@app.route("/")
def index():
    return render_template("index.html")


# ============================================================
# Main
# ============================================================

if __name__ == "__main__":

    capture_thread = threading.Thread(
        target=capture_loop,
        daemon=True
    )

    capture_thread.start()

    app.run(
        host="127.0.0.1",
        port=5000,
        threaded=True
    )