#!/bin/bash
# Lets an Apple ID open a staff login in the ZenPaws VPM app with "Sign in
# with Apple" straight away. Apple IDs not listed can't get in (unless their
# owner turns it on from the menu while signed in with a password). The staff
# login must already exist. The Apple ID email and login email may be the same.
# Usage: sudo bash allow-apple-id.sh APPLE_ID_EMAIL STAFF_LOGIN_EMAIL [APPLE_ID_EMAIL STAFF_LOGIN_EMAIL ...]
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
ENV_FILE=/etc/openvpm.env
[ -f "$ENV_FILE" ] || { echo "This is not the ZenPaws OpenVPM server (no $ENV_FILE). Open Lightsail > zenpaws-vpm > Connect using SSH and run it there."; exit 1; }
[ $# -ge 2 ] && [ $(( $# % 2 )) -eq 0 ] || { echo "Usage: sudo bash $0 APPLE_ID_EMAIL STAFF_LOGIN_EMAIL [...]"; exit 1; }

EMAIL_RE='^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
current=$(sed -n 's/^APPLE_STAFF_APPLE_IDS=//p' "$ENV_FILE" | tail -1)
while [ $# -gt 0 ]; do
  apple=$(printf '%s' "$1" | tr 'A-Z' 'a-z'); login=$(printf '%s' "$2" | tr 'A-Z' 'a-z'); shift 2
  [[ "$apple" =~ $EMAIL_RE && "$login" =~ $EMAIL_RE ]] || { echo "Not an email: $apple or $login"; exit 1; }
  # Replace any earlier entry for this Apple ID.
  current=$(printf '%s' "$current" | tr ',' '\n' | awk -F= -v a="$apple" 'NF && $1 != a' | paste -sd, -)
  current="${current:+$current,}${apple}=${login}"
done
sed -i '/^APPLE_STAFF_APPLE_IDS=/d' "$ENV_FILE"
printf 'APPLE_STAFF_APPLE_IDS=%s\n' "$current" >> "$ENV_FILE"
grep -q '^APPLE_STAFF_SIGN_IN_CLIENT_IDS=' "$ENV_FILE" || echo 'APPLE_STAFF_SIGN_IN_CLIENT_IDS=com.zenpawsdvm.staff' >> "$ENV_FILE"

chmod 640 "$ENV_FILE" && chown root:openvpm "$ENV_FILE"
systemctl restart openvpm
for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:3000/login && break; sleep 2; done
echo "Apple IDs allowed for staff logins:"
printf '%s\n' "$current" | tr ',' '\n' | sed 's/=/ -> /; s/^/  /'
echo "APPLE ID SIGN-IN UPDATED"
