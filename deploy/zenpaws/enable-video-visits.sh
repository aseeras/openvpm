#!/bin/bash
# Turns on telehealth video visits (Daily, daily.co). Asks for the Daily API
# key without echoing it, looks up the account's Daily domain, stores both in
# /etc/openvpm.env, and rebuilds so the browser security headers allow the
# clinic's video rooms.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
ENV_FILE=/etc/openvpm.env
[ -f "$ENV_FILE" ] || { echo "This is not the ZenPaws OpenVPM server (no $ENV_FILE). Open Lightsail > zenpaws-vpm > Connect using SSH and run it there."; exit 1; }

set_env() {
  local name="$1" value="$2"
  if grep -q "^${name}=" "$ENV_FILE"; then
    awk -v n="$name" -v v="$value" 'BEGIN{FS=OFS="="} $1==n {print n "=" v; next} {print}' "$ENV_FILE" > "$ENV_FILE.tmp"
    cat "$ENV_FILE.tmp" > "$ENV_FILE" && rm -f "$ENV_FILE.tmp"
  else
    printf '%s=%s\n' "$name" "$value" >> "$ENV_FILE"
  fi
}

read -r -s -p "Paste the Daily API key (Daily dashboard > Developers), then press Enter: " KEY
echo
[ -n "$KEY" ] || { echo "No key entered. Nothing was changed."; exit 1; }

DOMAIN=$(curl -fsS -H "Authorization: Bearer $KEY" https://api.daily.co/v1/ \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("domain_name",""))' 2>/dev/null || true)
if ! [[ "$DOMAIN" =~ ^[a-z0-9-]{1,63}$ ]]; then
  echo "Daily did not accept that key (or returned no domain). Check the key and try again. Nothing was changed."
  exit 1
fi

set_env DAILY_API_KEY "$KEY"
set_env DAILY_DOMAIN "$DOMAIN"
unset KEY
chmod 640 "$ENV_FILE" && chown root:openvpm "$ENV_FILE"
echo "Daily account found: ${DOMAIN}.daily.co. Rebuilding the app (a few minutes)..."

UPDATER=/usr/local/bin/zenpaws-update
[ -x "$UPDATER" ] || UPDATER="bash /opt/openvpm/deploy/zenpaws/update.sh"
$UPDATER
echo "Video visits are set up. In OpenVPM open 'Video visits' and click 'Start taking video visits'."
