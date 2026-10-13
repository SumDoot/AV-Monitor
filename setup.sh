#!/usr/bin/env bash
# One-time setup for the MJPEG capture buffer on a Debian/Ubuntu/Armbian board.
#
#   sudo ./setup.sh                      use the defaults below
#   sudo AP_IP=10.0.0.1 ./setup.sh       override any default from the command line
#
# What it does:
#   1. installs ffmpeg, Flask, openssl and v4l-utils
#   2. generates a self-signed HTTPS certificate (needed for in-browser MP4 export)
#   3. installs a systemd service so the app starts on boot and restarts if it crashes
#
# Re-running is safe: existing certificates and config.env are left alone.
set -euo pipefail

# ---- things you may want to change -------------------------------------------
AP_IP="${AP_IP:-192.168.4.1}"            # the Pi's address on its own access point
HOSTNAME_FOR_CERT="${HOSTNAME_FOR_CERT:-cam.local}"
SERVICE_NAME="${SERVICE_NAME:-mjpeg-review}"
RUN_USER="${RUN_USER:-${SUDO_USER:-$USER}}"   # account the app runs as
EXTRA_PACKAGES="${EXTRA_PACKAGES:-}"     # e.g. "dnsmasq hostapd" if you set up the AP here later
# -------------------------------------------------------------------------------

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT="/etc/systemd/system/${SERVICE_NAME}.service"

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo: sudo ./setup.sh" >&2
  exit 1
fi

echo "==> Installing packages"
apt-get update -qq
apt-get install -y ffmpeg python3-flask openssl v4l-utils ${EXTRA_PACKAGES}

echo "==> Letting ${RUN_USER} read the capture device"
usermod -aG video "${RUN_USER}"

echo "==> HTTPS certificate"
if [[ -f "${APP_DIR}/cert.pem" && -f "${APP_DIR}/key.pem" ]]; then
  echo "    cert.pem and key.pem already exist, keeping them (delete both to regenerate)"
else
  (cd "${APP_DIR}" && ./gen-cert.sh "${AP_IP}" "${HOSTNAME_FOR_CERT}")
fi
chown "${RUN_USER}": "${APP_DIR}/cert.pem" "${APP_DIR}/key.pem"

echo "==> Service ${SERVICE_NAME}"
cat > "${UNIT}" <<UNIT_EOF
[Unit]
Description=MJPEG capture buffer
After=network.target

[Service]
User=${RUN_USER}
SupplementaryGroups=video
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/config.env
ExecStart=/usr/bin/python3 ${APP_DIR}/app.py
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT_EOF

systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service"

PORT="$(grep -E '^PORT=' "${APP_DIR}/config.env" | cut -d= -f2 || true)"
echo
echo "Done. Open https://${AP_IP}:${PORT:-8443} from a device on the access point."
echo "  settings:  ${APP_DIR}/config.env  (then: sudo systemctl restart ${SERVICE_NAME})"
echo "  logs:      journalctl -u ${SERVICE_NAME} -f"
echo "  stop/start: sudo systemctl stop|start ${SERVICE_NAME}"
