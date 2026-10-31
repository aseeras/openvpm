#!/bin/bash
# Adds clinic admin (staff) logins to the ZenPaws OpenVPM server and checks
# that each one can sign in.
#   sudo bash create-admin.sh PASSWORD EMAIL "NAME" [EMAIL "NAME" ...]
# Every new admin gets the same starting password; each person should change
# it after their first sign-in. An email that already has a login is left
# untouched, so this never resets someone's existing password.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
[ -f /root/zenpaws-admin.env ] || { echo "Run set-db-admin.sh first (no /root/zenpaws-admin.env)."; exit 1; }
. /root/zenpaws-admin.env
APP="https://app.zenpawsdvm.com"
PSQL=(psql "$MASTER_URL" -v ON_ERROR_STOP=1 -Atq)

PW="${1:-}"; shift || true
[ ${#PW} -ge 8 ] || { echo "The password must be at least 8 characters. Nothing was changed."; exit 1; }
[ $# -ge 2 ] && [ $(($# % 2)) -eq 0 ] || { echo "usage: sudo bash create-admin.sh PASSWORD EMAIL \"NAME\" [EMAIL \"NAME\" ...]"; exit 1; }

HASH=$(PW="$PW" node -e 'console.log(require(process.argv[1]).hashSync(process.env.PW, 12))' \
  "$(cd /opt/openvpm/apps/web && node -p 'require.resolve("bcryptjs")')")

sign_in() {
  local jar csrf result
  jar=$(mktemp)
  csrf=$(curl -fsS -c "$jar" "$APP/api/auth/csrf" | sed -n 's/.*"csrfToken":"\([^"]*\)".*/\1/p')
  result=$(curl -sS -b "$jar" -c "$jar" -X POST "$APP/api/auth/callback/credentials" \
    --data-urlencode "csrfToken=$csrf" --data-urlencode "email=$1" --data-urlencode "password=$2" \
    --data-urlencode "json=true")
  rm -f "$jar"
  case "$result" in *error=*|"") echo "FAIL" ;; *) echo "OK" ;; esac
}

while [ $# -gt 0 ]; do
  EMAIL=$(echo "$1" | tr '[:upper:]' '[:lower:]'); NAME="$2"; shift 2
  created=$("${PSQL[@]}" -v email="$EMAIL" -v name="$NAME" -v hash="$HASH" <<'SQL'
insert into users (email, password_hash, name, role, practice_id, email_verified_at)
select :'email', :'hash', :'name', 'admin', p.id, now()
from (select id from practices where deleted_at is null order by created_at limit 1) p
on conflict (email) do nothing
returning id;
SQL
)
  if [ -n "$created" ]; then
    echo "$EMAIL: admin created. Sign-in check: $(sign_in "$EMAIL" "$PW")"
  else
    echo "$EMAIL: already has a login, left unchanged."
  fi
done
echo "DONE"
