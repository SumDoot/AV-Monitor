import os
from flask import Flask, render_template, send_from_directory, jsonify, abort

app = Flask(__name__)

# --- Configuration ---------------------------------------------------------

RECORDINGS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "recordings")
ALLOWED_EXTENSIONS = {".mp4", ".webm", ".mkv", ".mov", ".avi"}

# Link to AV input stream
DEFAULT_STREAM_URL = "udp://127.0.0.1:1234"

os.makedirs(RECORDINGS_DIR, exist_ok=True)


# --- Helpers -----------------------------------------------------------------

def human_size(num_bytes: int) -> str:
    """Format a byte count as a human-readable string (KB/MB/GB)."""
    size = float(num_bytes)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} {unit}"
        size /= 1024
    return f"{size:.1f} TB"


def list_recordings():
    """Return a list of dicts: name, size (bytes), size_human, for each video file."""
    files = []
    for entry in sorted(os.listdir(RECORDINGS_DIR)):
        path = os.path.join(RECORDINGS_DIR, entry)
        if not os.path.isfile(path):
            continue
        ext = os.path.splitext(entry)[1].lower()
        if ext not in ALLOWED_EXTENSIONS:
            continue
        size = os.path.getsize(path)
        files.append({
            "name": entry,
            "size": size,
            "size_human": human_size(size),
        })
    return files


# --- Routes --------------------------------------------------------------

@app.route("/")
def index():
    return render_template(
        "index.html",
        files=list_recordings(),
        default_stream_url=DEFAULT_STREAM_URL,
    )


@app.route("/api/files")
def api_files():
    """JSON list of files, used by the front-end refresh button."""
    return jsonify(list_recordings())


@app.route("/recordings/<path:filename>")
def serve_recording(filename):
    """Stream a video file. send_from_directory supports HTTP Range
    requests by default (conditional=True), which is what lets the
    browser seek/scrub through the video."""
    ext = os.path.splitext(filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        abort(404)
    return send_from_directory(RECORDINGS_DIR, filename, conditional=True)


if __name__ == "__main__":
    # host=0.0.0.0 so it's reachable from other devices on the network/AP
    app.run(host="0.0.0.0", port=5000, debug=True)
