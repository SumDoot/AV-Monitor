#!/usr/bin/env bash

# Start ffmpeg to interface with the AV card.
ffmpeg -f v4l2 -i /dev/video0 -f mpegts udp://127.0.0.1:1234 &

# Starts the app in a virtual environment.
source venv/bin/activate
python app.py