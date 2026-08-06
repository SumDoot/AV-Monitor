# FPV-spectator-DVR
This is a project that takes an AV input from my FPV goggles and records it internally while also allowing others around you to watch by connecting to its wifi hotspot connection.


## Hardware
It uses an OrangePi Zero 2W (since i could not get a Raspberry device...) as the main brain of the device. It has a AV to USB adapter added to it, i used some random one that i could get locally but others might work similarly :)

I also added a power circuit so that i can power both my goggles and this device from my powerbank with one cable. It takes in 9V via a USB-PD power board, then using 2 buck converters its adapted to 8.4v (fully charged 2S for goggles) and 5V (Pi, capture card, 5V cooling fan).

On the Pi itself i didn't want to use the external ports so i connected the power to the GPIO pin array and the USB pins to the 24pin expansion connector, both USB ports and the HDMI are only used for first setup.

The 5V fan is salvaged from an old laptop, i run it at full speed without using the control pins.


## Recordings File Manager + Player

Simple Flask app: top half is a video player, bottom half is a scrollable
list of files (name + size) pulled from a `recordings/` folder. A "Live
Stream" button is wired up as a placeholder for a default video source.

### Layout

```
videofm/
  app.py                 # Flask app
  requirements.txt
  templates/index.html
  static/style.css
  recordings/             # put your .mp4/.webm/.mkv/.mov/.avi files here
  deploy/
    setup_ap.sh           # turns the Pi into a WiFi AP + installs the systemd service
    flaskapp.service       # systemd unit for the Flask app
```

### Run locally

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
mkdir -p recordings   # already created; drop video files in here
python app.py
```

Visit `http://<device-ip>:5000/`.

### Default / live stream placeholder

In `app.py`, set:

```python
DEFAULT_STREAM_URL = "https://your-stream-url/stream.m3u8"
```

Until you set this, the "Live Stream" button stays disabled. A common way
to get an actual live URL from a Pi camera later: run `mediamtx` (or
`ffmpeg`) on the Pi to re-stream the camera as RTSP/HLS, then point
`DEFAULT_STREAM_URL` at that.

### Deploying to a headless Pi as an Access Point + setup page

1. Copy the whole `videofm/` folder to the Pi (e.g. `/home/pi/videofm`).
2. On the Pi:
   ```bash
   cd /home/pi/videofm
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt
   ```
3. Edit `deploy/flaskapp.service` if your username or install path differ
   from `pi` / `/home/pi/videofm`.
4. Edit the config block at the top of `deploy/setup_ap.sh` (SSID,
   password, country code, etc).
5. Run the setup script:
   ```bash
   sudo bash deploy/setup_ap.sh
   sudo reboot
   ```
6. After reboot, connect to the Pi's WiFi network (SSID/password from the
   script), then browse to `http://192.168.4.1:5000/`.

### Note on Raspberry Pi OS Bookworm

Bookworm uses NetworkManager instead of `dhcpcd`. If `deploy/setup_ap.sh`
doesn't apply cleanly (no `dhcpcd.conf`/`systemctl status dhcpcd`), create
the hotspot with `nmcli` instead and skip the dhcpcd/hostapd/dnsmasq steps:

```bash
sudo nmcli device wifi hotspot ifname wlan0 ssid "PiVideoSetup" password "changeme123"
```

You'd still want the `flaskapp.service` systemd unit installed so the app
starts on boot — that part of the script is independent of the networking
approach.
