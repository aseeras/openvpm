#!/bin/bash
# Lets one-time portal sign-in links open in the ZenPaws iPhone app.
# Usage: sudo bash enable-ios-app-links.sh <APPLE_TEAM_ID>
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
ENV_FILE=/etc/openvpm.env
[ -f "$ENV_FILE" ] || { echo "This is not the ZenPaws OpenVPM server (no $ENV_FILE). Open Lightsail > zenpaws-vpm > Connect using SSH and run it there."; exit 1; }
TEAM_ID="${1:-}"
[[ "$TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || { echo "Usage: sudo bash $0 <10-character Apple Team ID>"; exit 1; }

VALUE="${TEAM_ID}.com.zenpawsdvm.client"
if grep -q '^APPLE_APP_LINK_APP_IDS=' "$ENV_FILE"; then
  sed -i "s#^APPLE_APP_LINK_APP_IDS=.*#APPLE_APP_LINK_APP_IDS=${VALUE}#" "$ENV_FILE"
else
  printf 'APPLE_APP_LINK_APP_IDS=%s\n' "$VALUE" >> "$ENV_FILE"
fi
# Saved passwords also fill in inside the staff and client apps.
CREDENTIAL_APPS="${TEAM_ID}.com.zenpawsdvm.staff,${TEAM_ID}.com.zenpawsdvm.client"
if grep -q '^APPLE_WEB_CREDENTIAL_APP_IDS=' "$ENV_FILE"; then
  sed -i "s#^APPLE_WEB_CREDENTIAL_APP_IDS=.*#APPLE_WEB_CREDENTIAL_APP_IDS=${CREDENTIAL_APPS}#" "$ENV_FILE"
else
  printf 'APPLE_WEB_CREDENTIAL_APP_IDS=%s\n' "$CREDENTIAL_APPS" >> "$ENV_FILE"
fi
systemctl restart openvpm
for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:3000/login && break; sleep 2; done
curl -fsS http://127.0.0.1:3000/.well-known/apple-app-site-association && echo
echo "App links are on for ${VALUE}."
