#!/usr/bin/env bash
#
# Turns a headless Raspberry Pi's WiFi into a standalone Access Point,
# so you can connect to it directly (e.g. from a phone) and reach the
# Flask app at http://192.168.4.1:5000/ as a "setup page".
#
# Tested approach: hostapd + dnsmasq, static IP via dhcpcd.
# Works on Raspberry Pi OS Bullseye/Buster (dhcpcd-based networking).
#
# NOTE: Raspberry Pi OS Bookworm switched to NetworkManager by default.
# If `systemctl status dhcpcd` doesn't exist on your image, use nmcli
# instead, e.g.:
#   sudo nmcli device wifi hotspot ifname wlan0 ssid "PiSetup" password "12345678"
# and skip the rest of this script.
#
# Run as root: sudo bash setup_ap.sh

set -euo pipefail

# ---- Configuration (edit these) --------------------------------------------
AP_SSID="PiVideoSetup"
AP_PASSPHRASE="changeme123"   # min 8 chars
AP_IFACE="wlan0"
AP_IP="192.168.4.1"
AP_SUBNET="192.168.4.0/24"
DHCP_RANGE_START="192.168.4.10"
DHCP_RANGE_END="192.168.4.50"
COUNTRY_CODE="US"             # your 2-letter WiFi regulatory country code
# -----------------------------------------------------------------------------

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root: sudo bash setup_ap.sh" >&2
  exit 1
fi

echo "==> Installing hostapd and dnsmasq..."
apt-get update
apt-get install -y hostapd dnsmasq

echo "==> Stopping services while we configure them..."
systemctl stop hostapd || true
systemctl stop dnsmasq || true

echo "==> Setting a static IP for ${AP_IFACE} via dhcpcd..."
if ! grep -q "interface ${AP_IFACE}" /etc/dhcpcd.conf 2>/dev/null; then
  cat >> /etc/dhcpcd.conf <<EOF

# --- Added by setup_ap.sh ---
interface ${AP_IFACE}
    static ip_address=${AP_IP}/24
    nohook wpa_supplicant
EOF
fi

echo "==> Configuring dnsmasq (DHCP server for AP clients)..."
DNSMASQ_CONF="/etc/dnsmasq.conf"
if [[ -f "$DNSMASQ_CONF" ]]; then
  mv "$DNSMASQ_CONF" "${DNSMASQ_CONF}.orig.$(date +%s)"
fi
cat > "$DNSMASQ_CONF" <<EOF
interface=${AP_IFACE}
dhcp-range=${DHCP_RANGE_START},${DHCP_RANGE_END},255.255.255.0,24h
domain-needed
bogus-priv
EOF

echo "==> Configuring hostapd (the AP itself)..."
cat > /etc/hostapd/hostapd.conf <<EOF
interface=${AP_IFACE}
driver=nl80211
ssid=${AP_SSID}
hw_mode=g
channel=7
wmm_enabled=0
macaddr_acl=0
auth_algs=1
ignore_broadcast_ssid=0
wpa=2
wpa_passphrase=${AP_PASSPHRASE}
wpa_key_mgmt=WPA-PSK
wpa_pairwise=TKIP
rsn_pairwise=CCMP
country_code=${COUNTRY_CODE}
EOF

sed -i 's|^#DAEMON_CONF=.*|DAEMON_CONF="/etc/hostapd/hostapd.conf"|' /etc/default/hostapd
if ! grep -q '^DAEMON_CONF="/etc/hostapd/hostapd.conf"' /etc/default/hostapd; then
  echo 'DAEMON_CONF="/etc/hostapd/hostapd.conf"' >> /etc/default/hostapd
fi

echo "==> Unmasking and enabling services..."
systemctl unmask hostapd
systemctl enable hostapd
systemctl enable dnsmasq

echo "==> Installing the Flask app as a systemd service..."
SERVICE_SRC="$(dirname "$0")/flaskapp.service"
if [[ -f "$SERVICE_SRC" ]]; then
  cp "$SERVICE_SRC" /etc/systemd/system/flaskapp.service
  systemctl daemon-reload
  systemctl enable flaskapp.service
  echo "    (edit /etc/systemd/system/flaskapp.service if your app path/user differ)"
else
  echo "    flaskapp.service not found next to this script — skipping, install it manually."
fi

echo ""
echo "==> Done. Reboot to apply networking changes: sudo reboot"
echo "==> After reboot, connect to WiFi network '${AP_SSID}' (password: ${AP_PASSPHRASE})"
echo "==> Then browse to: http://${AP_IP}:5000/"
