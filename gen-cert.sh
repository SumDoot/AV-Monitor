#!/usr/bin/env bash
# Makes a self-signed certificate so browsers treat the page as a secure context
# (required for in-browser MP4 encoding). Usage: ./gen-cert.sh [ip] [hostname]
set -euo pipefail
IP="${1:-192.168.4.1}"
HOST="${2:-cam.local}"
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 365 \
  -keyout key.pem -out cert.pem -subj "/CN=${HOST}" \
  -addext "subjectAltName=DNS:${HOST},IP:${IP}" \
  -addext "basicConstraints=CA:FALSE" \
  -addext "extendedKeyUsage=serverAuth"
chmod 600 key.pem
echo "Wrote cert.pem and key.pem for ${HOST} / ${IP}"
