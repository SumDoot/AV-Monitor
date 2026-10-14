## Untested on real hardware, only in testing mode!

# MJPEG capture buffer

Rolling video buffer for a CVBS/MJPEG capture card, built for a headless Orange Pi Zero 2W
(or any Linux board). The Pi never re-encodes video and never writes clips to disk.

- **ffmpeg** copies the card's MJPEG stream into a buffer held in RAM (`-c:v copy`, near-zero CPU).
- **Live view** is a plain multipart MJPEG stream in an `<img>` tag.
- **Pause and review** downloads the buffer to your phone/laptop. Scrubbing, frame stepping and
  choosing the clip range all happen in the browser.
- **Save as MP4** encodes H.264 in the browser (WebCodecs, hardware encoder where available),
  so the Pi does none of the work. **Save as MJPEG** just joins the frames, works everywhere.

## Setup

    sudo ./setup.sh                    # installs packages, makes the certificate, starts on boot

Open `https://192.168.4.1:8443` from a device on the Pi's access point and click through the
certificate warning once.

Change settings in `config.env`, then `sudo systemctl restart mjpeg-review`.
Logs: `journalctl -u mjpeg-review -f`. To run by hand instead:
`set -a; . ./config.env; set +a; python3 app.py`

## Files

| File | Job |
|---|---|
| `app.py` | Flask server and ffmpeg capture |
| `static/` | Web functionality |
| `tools/build_reference.py` | builds OSD reference from a clip with a good signal |
| `tests/test_quality.mjs` | checks the evaluator against a clip and synthetic damage |
| `config.env` | settings read by the service |
| `setup.sh`, `gen-cert.sh` | installation and certificate |

## Settings (environment variables)

These live in `config.env`.

| Variable | Default | Meaning |
|---|---|---|
| VIDEO_DEVICE | /dev/video1 | capture card |
| VIDEO_SIZE | 720x576 | must be a size the card offers as MJPEG |
| VIDEO_FPS | 30 | 25 for PAL, 30 for NTSC |
| BUFFER_SECONDS | 600 | rolling window length |
| MAX_BUFFER_MB | 500 | hard RAM cap, whichever limit is hit first trims the buffer |
| PORT | 8443 | |

Check what your card offers with `v4l2-ctl -d /dev/video1 --list-formats-ext`.

## Signal loss

If the AV signal drops, ffmpeg either exits with an error or stays alive without delivering frames.
Both are handled: a watchdog restarts ffmpeg after `STALL_SECONDS` without frames, and restarts back
off (2 s up to 15 s) while the card keeps failing. The page shows "No signal", and the footage from
before the loss stays in the buffer so you can still review and save it. The dead time is cut out of
the buffer's timeline, so a clip that spans a loss plays straight through and exports at the right speed.
Some cards keep sending flat grey frames when the signal is gone; the signal quality check below catches that as "No picture".

## Signal quality (OSD check)

The OSD is drawn onto the video by the flight controller, so it crosses the same radio link and
capture card as the picture, but we know exactly what it should look like. The two vertical dotted
lines never change, so the browser compares them with a reference and scores the signal 0 to 100:

| Measurement | Rises or falls when |
|---|---|
| contrast of the dots against their dark outline | the picture is blurred, dim or gone |
| jitter, how far each dot wanders sideways | horizontal sync trouble (line tearing), noise |
| noise, grain on the white dots | weak signal, snow |
| shift, how far the whole OSD has moved | the picture is displaced |

Labels: Good 85 and up, Fair 60 and up, Poor below that. "No picture" means a flat screen (what many
cards send with no signal). "No OSD" means the OSD cannot be read: heavy blur, or the OSD is switched off.

Where it shows: the live badge and status line (checked twice a second), a colour strip along the
bottom of the review timeline, and a readout for the frame under the playhead. All of this runs in
your browser, so the Pi does no extra work. With no `static/reference.json` the feature stays off.

**Making the reference.** The one in the package was built from the 720x576 test clip, which had been
converted to H.264. Build your own from the same card and settings the app uses:

1. With a clean signal and the OSD visible, record a few seconds and use **Save as MJPEG**.
2. On a PC: `pip install numpy opencv-python-headless`, then
   `python3 tools/build_reference.py clip.mjpeg`
3. Open `reference-preview.png`: both dotted lines should have a box around every dot.
4. Copy `static/reference.json` to the Pi (reload the page, no restart needed).

Rebuild it if you change the OSD layout, the card, or the video size (`VIDEO_SIZE` must match the
reference, otherwise the check switches itself off).

**Tuning.** The thresholds are in `QUALITY` at the top of `static/quality.js`. They were set from one
clean clip and synthetic damage (noise, tearing, blur, shifts, blackouts), not from real weak-signal
footage.

**Testing without the card.** `TEST_FILE=test.mkv python3 app.py` or setting `RUN_MODE = False` plays a video in a loop as if it
were the capture card (MJPEG files are used as they are, anything else is converted).
