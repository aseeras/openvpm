#!/bin/bash
# ZenPaws OpenVPM updater: installs itself as /usr/local/bin/zenpaws-update, then
# pulls the latest `zenpaws` branch, migrates, re-applies RLS, rebuilds, restarts.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
[ -f /etc/openvpm.env ] || { echo "This is not the ZenPaws OpenVPM server (no /etc/openvpm.env). Open Lightsail > zenpaws-vpm > Connect using SSH and run it there."; exit 1; }
LOG=/var/log/zenpaws-update.log
exec > >(tee -a "$LOG") 2>&1
echo "=== $(date -u +%FT%TZ) update started"

# Database admin settings live only on the server (/root/zenpaws-admin.env, root-only).
# Without them, code-only updates still work; schema migrations are skipped.
HAVE_DB_ADMIN=0
if [ -f /root/zenpaws-admin.env ]; then . /root/zenpaws-admin.env; HAVE_DB_ADMIN=1; fi
if [ "$(readlink -f "$0" 2>/dev/null)" != /usr/local/bin/zenpaws-update ] && [ -f "$0" ]; then
  install -m 700 "$0" /usr/local/bin/zenpaws-update
fi

# Quote the display-name From address so the env file also parses in bash.
sed -i 's#^EMAIL_FROM=ZenPaws <noreply@zenpawsdvm.com>$#EMAIL_FROM="ZenPaws <noreply@zenpawsdvm.com>"#' /etc/openvpm.env

BRANCH="${1:-zenpaws}"
cd /opt/openvpm
sudo -u openvpm git fetch --depth 1 origin "$BRANCH"
sudo -u openvpm git checkout -q -B "$BRANCH" FETCH_HEAD
echo "now at $(git rev-parse --short HEAD) on $BRANCH"

# Front-end config (public redirects, and the closed-registration rule if set).
bash /opt/openvpm/deploy/zenpaws/caddy.sh

sudo -u openvpm -H bash -c 'cd /opt/openvpm && pnpm install --frozen-lockfile'
if [ "$HAVE_DB_ADMIN" = 1 ]; then
  sudo -u openvpm -H env DATABASE_URL="$MASTER_URL" bash -c 'cd /opt/openvpm && pnpm db:migrate'
  sudo -u openvpm -H env DATABASE_URL="$MASTER_URL" OPENPIMS_APP_DB_PASSWORD="$OPENPIMS_APP_DB_PASSWORD" bash -c 'cd /opt/openvpm && pnpm db:rls'
else
  echo "NOTE: /root/zenpaws-admin.env missing; skipped db:migrate and db:rls"
fi

sudo -u openvpm -H bash -c 'set -a; . /etc/openvpm.env; set +a; export NODE_ENV=production NODE_OPTIONS=--max-old-space-size=3072; cd /opt/openvpm && pnpm build --filter=@openpims/web'
SA=/opt/openvpm/apps/web/.next/standalone
rm -rf "$SA/apps/web/public" "$SA/apps/web/.next/static"
cp -r /opt/openvpm/apps/web/public "$SA/apps/web/public"
cp -r /opt/openvpm/apps/web/.next/static "$SA/apps/web/.next/static"
chown -R openvpm:openvpm "$SA"

systemctl restart openvpm
for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:3000/login && break; sleep 3; done
curl -sS -o /dev/null -w "local /login HTTP %{http_code}\n" http://127.0.0.1:3000/login
echo "=== $(date -u +%FT%TZ) UPDATE COMPLETE"
