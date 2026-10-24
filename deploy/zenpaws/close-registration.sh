#!/bin/bash
# Turns off public practice sign-up once the clinic's own practice exists.
# Undo with: sudo rm /etc/zenpaws/registration-closed && sudo bash caddy.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
[ -f /etc/openvpm.env ] || { echo "This is not the ZenPaws OpenVPM server (no /etc/openvpm.env). Open Lightsail > zenpaws-vpm > Connect using SSH and run it there."; exit 1; }

mkdir -p /etc/zenpaws
touch /etc/zenpaws/registration-closed

CADDY_SCRIPT=/opt/openvpm/deploy/zenpaws/caddy.sh
if [ ! -f "$CADDY_SCRIPT" ]; then
  CADDY_SCRIPT=$(mktemp)
  curl -fsSL https://raw.githubusercontent.com/aseeras/openvpm/zenpaws/deploy/zenpaws/caddy.sh -o "$CADDY_SCRIPT"
fi
bash "$CADDY_SCRIPT"
