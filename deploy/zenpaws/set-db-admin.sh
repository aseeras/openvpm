#!/bin/bash
# Saves the database admin login on this server so updates can apply
# database changes (new tables, security rules). Asks for the Lightsail
# database master password without echoing it; everything else is read from
# /etc/openvpm.env. Then runs the updater, which now migrates.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
ENV_FILE=/etc/openvpm.env
[ -f "$ENV_FILE" ] || { echo "This is not the ZenPaws OpenVPM server (no $ENV_FILE). Open Lightsail > zenpaws-vpm > Connect using SSH and run it there."; exit 1; }
MASTER_USER="${MASTER_USER:-zpadmin}"

APP_URL=$(grep '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"')
[ -n "$APP_URL" ] || { echo "No DATABASE_URL in $ENV_FILE."; exit 1; }

read -r -s -p "Paste the Lightsail database master password (Lightsail > Databases > zenpaws-vpm-db > Connect > Show), then press Enter: " MASTER_PW
echo
[ -n "$MASTER_PW" ] || { echo "No password entered. Nothing was changed."; exit 1; }

# Build the admin URL from the app URL's host, port and database name.
read -r MASTER_URL APP_PW < <(APP_URL="$APP_URL" MASTER_PW="$MASTER_PW" MASTER_USER="$MASTER_USER" python3 - <<'PY'
import os
from urllib.parse import urlsplit, quote, unquote
u = urlsplit(os.environ["APP_URL"])
master = f"{u.scheme}://{quote(os.environ['MASTER_USER'], safe='')}:{quote(os.environ['MASTER_PW'], safe='')}@{u.hostname}:{u.port or 5432}{u.path}"
if u.query:
    master += "?" + u.query
print(master, unquote(u.password or ""))
PY
)
unset MASTER_PW

if ! PGCONNECT_TIMEOUT=10 psql "$MASTER_URL" -Atc "select 1" >/dev/null 2>&1; then
  echo "Could not sign in to the database with that password. Check it in Lightsail and try again. Nothing was changed."
  exit 1
fi

umask 077
printf "MASTER_URL='%s'\nOPENPIMS_APP_DB_PASSWORD='%s'\n" "$MASTER_URL" "$APP_PW" > /root/zenpaws-admin.env
chmod 600 /root/zenpaws-admin.env
unset MASTER_URL APP_PW
echo "Database admin login saved (readable by root only). Applying database updates..."

UPDATER=/usr/local/bin/zenpaws-update
[ -x "$UPDATER" ] || UPDATER="bash /opt/openvpm/deploy/zenpaws/update.sh"
$UPDATER
