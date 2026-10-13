#!/usr/bin/env python3
"""
MJPEG rolling-buffer server.

ffmpeg copies the capture card's MJPEG stream (no re-encoding, almost no CPU)
into a rolling buffer that lives only in RAM. The browser can:

  - watch the live stream          GET /live
  - pull the buffer to review it   GET /api/buffer
  - export MP4 (encoded in the browser with WebCodecs) or raw MJPEG

Nothing is ever written to disk on the Pi.

Settings come from environment variables (defaults in brackets):
  VIDEO_DEVICE [/dev/video0]   VIDEO_SIZE [720x576]   VIDEO_FPS [25]
  BUFFER_SECONDS [60]          MAX_BUFFER_MB [150]    PORT [8443]
  TLS_CERT [cert.pem]          TLS_KEY [key.pem]
"""
import collections
import mimetypes
import os
import struct
import subprocess
import threading
import time

from flask import Flask, Response, abort, jsonify, request, send_from_directory

# set to True to run on the Pi using the capture device
# set to False to use the test file instead of a capture device 
RUN_MODE = False  

# Some systems serve .mjs as text/plain, which browsers refuse for ES modules.
mimetypes.add_type("text/javascript", ".mjs")

HERE = os.path.dirname(os.path.abspath(__file__))

DEVICE = os.environ.get("VIDEO_DEVICE", "/dev/video1") if RUN_MODE else os.path.join(HERE, "test.mkv")
SIZE = os.environ.get("VIDEO_SIZE", "720x576")
FPS = int(os.environ.get("VIDEO_FPS", "25"))
BUFFER_SECONDS = int(os.environ.get("BUFFER_SECONDS", "60"))
MAX_BUFFER_MB = int(os.environ.get("MAX_BUFFER_MB", "150"))
PORT = int(os.environ.get("PORT", "8443"))
STALL_SECONDS = float(os.environ.get("STALL_SECONDS", "5"))     # no frames for this long: restart ffmpeg
SIGNAL_TIMEOUT = float(os.environ.get("SIGNAL_TIMEOUT", "2"))   # no frames for this long: report "no signal"
TEST_FILE = os.environ.get("TEST_FILE", "")                      # play this video in a loop instead of the capture card
CERT = os.environ.get("TLS_CERT", os.path.join(HERE, "cert.pem"))
KEY = os.environ.get("TLS_KEY", os.path.join(HERE, "key.pem"))

app = Flask(__name__, static_folder=os.path.join(HERE, "static"), static_url_path="/static")


class FrameBuffer:
    """Thread-safe rolling buffer of JPEG frames, trimmed by age and by total size."""

    def __init__(self, max_seconds, max_bytes, nominal_fps, gap_seconds=1.0):
        self.max_seconds = max_seconds
        self.max_bytes = max_bytes
        self.nominal_interval = 1.0 / nominal_fps
        self.gap_seconds = gap_seconds
        self.cond = threading.Condition()
        self.frames = collections.deque()  # (seq, buffer_time, jpeg_bytes)
        self.bytes = 0
        self.next_seq = 0
        self.last_real = None   # real monotonic time of the newest frame
        self.skipped = 0.0      # total signal-loss time removed from the buffer's timeline

    def add(self, data):
        real = time.monotonic()
        with self.cond:
            # After a signal loss, close the gap: the frame after it follows the one before
            # it by one normal interval. Otherwise the timeline (and the exported frame rate)
            # would include the dead time.
            if self.last_real is not None and real - self.last_real > self.gap_seconds:
                self.skipped += (real - self.last_real) - self.nominal_interval
            self.last_real = real
            now = real - self.skipped
            self.frames.append((self.next_seq, now, data))
            self.next_seq += 1
            self.bytes += len(data)
            while self.frames and (
                now - self.frames[0][1] > self.max_seconds or self.bytes > self.max_bytes
            ):
                self.bytes -= len(self.frames.popleft()[2])
            self.cond.notify_all()

    def snapshot(self, seconds=None):
        with self.cond:
            frames = list(self.frames)  # frames are immutable bytes, so this is cheap
        if seconds and frames:
            cutoff = frames[-1][1] - seconds
            frames = [f for f in frames if f[1] >= cutoff]
        return frames

    def wait_newer(self, last_seq, timeout=5.0):
        """Block until a frame newer than last_seq exists; return the newest frame or None."""
        with self.cond:
            self.cond.wait_for(lambda: self.next_seq - 1 > last_seq, timeout)
            if self.frames and self.frames[-1][0] > last_seq:
                return self.frames[-1]
        return None

    def stats(self):
        with self.cond:
            n = len(self.frames)
            span = (self.frames[-1][1] - self.frames[0][1]) if n > 1 else 0.0
            size = self.bytes
            age = (time.monotonic() - self.last_real) if self.last_real is not None else None
        fps = (n - 1) / span if span > 0 else 0.0
        return n, span, fps, size, age


buffer = FrameBuffer(BUFFER_SECONDS, MAX_BUFFER_MB * 1024 * 1024, FPS)
capture_state = {"running": False, "error": ""}


def split_jpegs(stream, on_frame):
    """Cut a byte stream of back-to-back JPEGs into frames (SOI ff d8 ... EOI ff d9)."""
    buf = bytearray()
    while True:
        chunk = stream.read(65536)
        if not chunk:
            return
        buf += chunk
        while True:
            soi = buf.find(b"\xff\xd8")
            if soi < 0:
                del buf[:-1]  # keep a trailing 0xff in case the marker is split
                break
            eoi = buf.find(b"\xff\xd9", soi + 2)
            if eoi < 0:
                if soi > 0:
                    del buf[:soi]
                if len(buf) > 8 * 1024 * 1024:  # runaway garbage, start over
                    buf.clear()
                break
            end = eoi + 2
            on_frame(bytes(buf[soi:end]))
            del buf[:end]


def log(msg):
    print(f"[capture] {msg}", flush=True)


def capture_loop():
    cmd = [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-f", "v4l2", "-input_format", "mjpeg",
            "-video_size", SIZE, "-framerate", str(FPS),
            "-i", DEVICE,
            "-c:v", "copy",          # no re-encoding
            "-f", "mjpeg", "pipe:1",
        ] if RUN_MODE else [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            "-re", "-stream_loop", "-1", "-i", DEVICE,
            "-c:v", "copy",          # no re-encoding
            "-f", "mjpeg", "pipe:1",
        ]
    failures = 0
    while True:
        stderr_tail = collections.deque(maxlen=4)
        try:
            proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0
            )
        except FileNotFoundError:
            capture_state.update(running=False, error="ffmpeg is not installed")
            log("ffmpeg is not installed")
            time.sleep(5)
            continue

        started = time.monotonic()
        frames_this_run = [0]
        done = threading.Event()

        def drain_stderr():
            for line in iter(proc.stderr.readline, b""):
                stderr_tail.append(line.decode(errors="replace").strip())

        def count(data):
            frames_this_run[0] += 1
            buffer.add(data)

        def watchdog():
            # With the AV signal gone, ffmpeg often stays alive but delivers nothing.
            # Kill it so the loop below restarts it cleanly.
            while not done.wait(1.0):
                last = buffer.last_real if frames_this_run[0] else None
                idle = time.monotonic() - (last if last is not None else started)
                if idle > STALL_SECONDS:
                    stderr_tail.append(f"no frames for {idle:.0f} s")
                    proc.kill()
                    return

        threading.Thread(target=drain_stderr, daemon=True).start()
        threading.Thread(target=watchdog, daemon=True).start()
        capture_state.update(running=True, error="")
        try:
            split_jpegs(proc.stdout, count)
        finally:
            done.set()
            proc.kill()
            proc.wait()

        reason = " ".join(stderr_tail) or "capture stopped"
        capture_state.update(running=False, error=reason)
        failures = 0 if frames_this_run[0] else failures + 1
        delay = min(2 * 2 ** max(0, failures - 1), 15)  # 2, 2, 4, 8, 15 s ... while it keeps failing
        log(f"ffmpeg stopped after {frames_this_run[0]} frames ({reason}); restarting in {delay} s")
        time.sleep(delay)


# ---------------------------------------------------------------- routes

@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/status")
def status():
    n, span, fps, size, age = buffer.stats()
    return jsonify(
        capturing=age is not None and age < SIGNAL_TIMEOUT,   # frames are arriving right now
        signal_lost_for=None if age is None else round(age, 1),
        error=capture_state["error"],
        frames=n,
        seconds=round(span, 1),
        fps=round(fps, 2),
        megabytes=round(size / 1048576, 1),
        size=SIZE,
        buffer_seconds=BUFFER_SECONDS,
    )


@app.get("/live")
def live():
    boundary = "frame"

    def generate():
        last = -1
        while True:
            frame = buffer.wait_newer(last)
            if frame is None:
                continue
            last, _, data = frame  # a slow client simply skips frames
            yield (
                b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length: "
                + str(len(data)).encode()
                + b"\r\n\r\n" + data + b"\r\n"
            )

    resp = Response(generate(), mimetype=f"multipart/x-mixed-replace; boundary={boundary}")
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/api/buffer")
def get_buffer():
    """
    Snapshot of the buffer as one binary download:
      uint32 frame_count
      then per frame: uint32 jpeg_length, uint32 time_ms (relative to first frame), jpeg bytes
    All integers little-endian. ?seconds=N limits it to the most recent N seconds.
    """
    seconds = request.args.get("seconds", type=float)
    frames = buffer.snapshot(seconds)
    if len(frames) < 2:
        abort(503, description="Buffer is empty. Check the capture device.")

    t0 = frames[0][1]
    total = 4 + sum(8 + len(f[2]) for f in frames)

    def generate():
        yield struct.pack("<I", len(frames))
        for _, t, data in frames:
            yield struct.pack("<II", len(data), int((t - t0) * 1000))
            yield data

    resp = Response(generate(), mimetype="application/octet-stream")
    resp.headers["Content-Length"] = str(total)
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/favicon.ico")
def favicon():
    return "", 204


@app.errorhandler(503)
def unavailable(err):
    return jsonify(error=err.description), 503


if __name__ == "__main__":
    threading.Thread(target=capture_loop, daemon=True).start()

    tls = (CERT, KEY) if os.path.exists(CERT) and os.path.exists(KEY) else None
    if tls is None:
        print("No cert.pem/key.pem found: serving plain HTTP. Live view and review work,")
        print("but browsers only allow MP4 export on HTTPS. Run ./gen-cert.sh to fix that.")
    app.run(host="0.0.0.0" if RUN_MODE else "127.0.0.1", port=PORT, ssl_context=tls, threaded=True)
