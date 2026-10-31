#!/bin/bash
# Turns on "Continue with Apple" and "Continue with Google" for clients signing
# in to the portal in a web browser. Asks for each provider's id (and Google's
# secret, typed without echoing); press Enter to leave a provider as it is.
# Usage: sudo bash enable-web-sign-in.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
ENV_FILE=/etc/openvpm.env
[ -f "$ENV_FILE" ] || { echo "This is not the ZenPaws OpenVPM server (no $ENV_FILE). Open Lightsail > zenpaws-vpm > Connect using SSH and run it there."; exit 1; }

set_env() {
  local name="$1" value="$2"
  sed -i "/^${name}=/d" "$ENV_FILE"
  printf '%s=%s\n' "$name" "$value" >> "$ENV_FILE"
}

read -r -p "Apple Services ID (for example com.zenpawsdvm.web), or Enter to skip: " APPLE_ID
if [ -n "$APPLE_ID" ]; then
  [[ "$APPLE_ID" =~ ^[A-Za-z0-9.-]{3,255}$ ]] || { echo "That doesn't look like a Services ID."; exit 1; }
  set_env APPLE_SIGN_IN_WEB_SERVICES_ID "$APPLE_ID"
fi

read -r -p "Google OAuth client ID (ends in .apps.googleusercontent.com), or Enter to skip: " GOOGLE_ID
if [ -n "$GOOGLE_ID" ]; then
  [[ "$GOOGLE_ID" =~ ^[A-Za-z0-9.-]+\.apps\.googleusercontent\.com$ ]] || { echo "That doesn't look like a Google client ID."; exit 1; }
  read -r -s -p "Google OAuth client secret (hidden as you type): " GOOGLE_SECRET; echo
  [[ "$GOOGLE_SECRET" =~ ^[A-Za-z0-9_-]{10,128}$ ]] || { echo "That doesn't look like a Google client secret."; exit 1; }
  set_env GOOGLE_SIGN_IN_CLIENT_ID "$GOOGLE_ID"
  set_env GOOGLE_SIGN_IN_CLIENT_SECRET "$GOOGLE_SECRET"
fi

chmod 640 "$ENV_FILE" && chown root:openvpm "$ENV_FILE"
systemctl restart openvpm
for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:3000/login && break; sleep 2; done
grep -q '^APPLE_SIGN_IN_WEB_SERVICES_ID=.' "$ENV_FILE" && echo "Continue with Apple: on" || echo "Continue with Apple: off"
grep -q '^GOOGLE_SIGN_IN_CLIENT_ID=.' "$ENV_FILE" && echo "Continue with Google: on" || echo "Continue with Google: off"
echo "WEB SIGN-IN UPDATED"
