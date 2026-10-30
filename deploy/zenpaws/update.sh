#!/bin/bash
# ZenPaws OpenVPM updater: installs itself as /usr/local/bin/zenpaws-update, then
# pulls the latest `zenpaws` branch, migrates, re-applies RLS, rebuilds, restarts.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
[ -f /etc/openvpm.env ] || { echo "This is not the ZenPaws OpenVPM server (no /etc/openvpm.env). Open Lightsail > zenpaws-vpm > Connect using SSH and run it there."; exit 1; }
LOG=/var/log/zenpaws-update.log
[ -n "${ZP_UPDATER_REEXEC:-}" ] || exec > >(tee -a "$LOG") 2>&1
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
# Sign in with Apple for the ZenPaws iPhone app (bundle id com.zenpawsdvm.client).
grep -q '^APPLE_SIGN_IN_CLIENT_IDS=' /etc/openvpm.env || echo 'APPLE_SIGN_IN_CLIENT_IDS=com.zenpawsdvm.client' >> /etc/openvpm.env
# Video visits run on Amazon (Kinesis Video Streams WebRTC) with the server's
# AWS credentials; the old third-party video settings are no longer used.
grep -q '^TELEHEALTH_VIDEO=' /etc/openvpm.env || echo 'TELEHEALTH_VIDEO=aws_kvs' >> /etc/openvpm.env
grep -q '^TELEHEALTH_VIDEO_REGION=.' /etc/openvpm.env || { sed -i '/^TELEHEALTH_VIDEO_REGION=/d' /etc/openvpm.env; echo 'TELEHEALTH_VIDEO_REGION=us-east-2' >> /etc/openvpm.env; }
sed -i '/^DAILY_API_KEY=/d; /^DAILY_DOMAIN=/d; /^DAILY_API_URL=/d' /etc/openvpm.env
# Saved-password autofill in the iPhone apps (staff and client), using the
# Apple Team ID already set up for portal app links.
TEAM_ID=$(sed -n 's/^APPLE_APP_LINK_APP_IDS=\([A-Z0-9]\{10\}\)\..*/\1/p' /etc/openvpm.env | head -1)
if [ -n "$TEAM_ID" ] && ! grep -q '^APPLE_WEB_CREDENTIAL_APP_IDS=' /etc/openvpm.env; then
  echo "APPLE_WEB_CREDENTIAL_APP_IDS=${TEAM_ID}.com.zenpawsdvm.staff,${TEAM_ID}.com.zenpawsdvm.client" >> /etc/openvpm.env
fi

BRANCH="${1:-zenpaws}"
cd /opt/openvpm
sudo -u openvpm git fetch --depth 1 origin "$BRANCH"
sudo -u openvpm git checkout -q -B "$BRANCH" FETCH_HEAD
echo "now at $(git rev-parse --short HEAD) on $BRANCH"

# If this update changes the updater itself, finish with the new version.
if [ -z "${ZP_UPDATER_REEXEC:-}" ] && ! cmp -s deploy/zenpaws/update.sh /usr/local/bin/zenpaws-update; then
  install -m 700 deploy/zenpaws/update.sh /usr/local/bin/zenpaws-update
  echo "updater changed; continuing with the new version"
  ZP_UPDATER_REEXEC=1 exec /usr/local/bin/zenpaws-update "$BRANCH"
fi

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
# Keep the previous builds' scripts and styles for two weeks: a page a phone
# or browser saved before this update still asks for them, and without them
# it shows up unstyled. Their file names are content hashes, so they never clash.
STATIC_ARCHIVE=/var/lib/zenpaws/next-static
mkdir -p "$STATIC_ARCHIVE"
cp -rn /opt/openvpm/apps/web/.next/static/. "$STATIC_ARCHIVE/"
find "$STATIC_ARCHIVE" -type f -mtime +14 -delete
cp -r "$STATIC_ARCHIVE" "$SA/apps/web/.next/static"
cp -r /opt/openvpm/apps/web/.next/static/. "$SA/apps/web/.next/static/"
chown -R openvpm:openvpm "$SA"

systemctl restart openvpm
for i in $(seq 1 30); do curl -fs -o /dev/null http://127.0.0.1:3000/login && break; sleep 3; done
# Report whether video visits came on (names only; no secret values).
for name in TELEHEALTH_VIDEO TELEHEALTH_VIDEO_REGION S3_ACCESS_KEY S3_SECRET_KEY; do
  grep -q "^${name}=." /etc/openvpm.env && echo "  ${name}: set" || echo "  ${name}: MISSING"
done
if curl -fsI http://127.0.0.1:3000/login | grep -qi 'kinesisvideo'; then
  echo "video visits: on (Amazon)"
else
  echo "WARNING: video visits are not on in this build; send these lines to support."
fi
curl -sS -o /dev/null -w "local /login HTTP %{http_code}\n" http://127.0.0.1:3000/login
echo "=== $(date -u +%FT%TZ) UPDATE COMPLETE"
