#!/bin/bash
# Connects the clinic's Quo (formerly OpenPhone) number to OpenVPM:
#  - texts and reminders sent from OpenVPM go out from the Quo number
#  - texts clients send to that number land in the Communications inbox
#  - calls and voicemails to that number are logged in the inbox
#
# Asks for the Quo API key without echoing it (Quo > Settings > API), finds
# the number in Quo, creates the Quo webhook, and stores everything only in
# /etc/openvpm.env and the database on this server.
#
# Usage:  sudo bash enable-quo.sh [+1NUMBER]
#   TEXTING_APPROVED=yes  turn on outgoing texts (only once Quo shows the
#                         carrier/A2P texting registration as approved)
#   DISPLAY_NAME="..."    business name exactly as registered for texting
#                         (defaults to the practice name in OpenVPM)
#   REPLACE_KEY=yes       ask for a new API key even if one is saved
#   LOCATION_ID=<uuid>    pick the clinic location when there is more than one
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
ENV_FILE=/etc/openvpm.env
[ -f "$ENV_FILE" ] || { echo "This is not the ZenPaws OpenVPM server (no $ENV_FILE). Open Lightsail > zenpaws-vpm > Connect using SSH and run it there."; exit 1; }
[ -f /root/zenpaws-admin.env ] || { echo "Run set-db-admin.sh first (no /root/zenpaws-admin.env)."; exit 1; }
. /root/zenpaws-admin.env

NUMBER="${1:-+18133413102}"
APP="https://${ZENPAWS_DOMAIN:-app.zenpawsdvm.com}"
WEBHOOK_URL="$APP/api/webhooks/quo"
QUO_API="https://api.quo.com"
QUO_VERSION="2026-03-30"
PSQL=(psql "$MASTER_URL" -v ON_ERROR_STOP=1 -Atq)

set_env() {
  local name="$1" value="$2"
  if grep -q "^${name}=" "$ENV_FILE"; then
    awk -v n="$name" -v v="$value" 'BEGIN{FS=OFS="="} $1==n {print n "=" v; next} {print}' "$ENV_FILE" > "$ENV_FILE.tmp"
    cat "$ENV_FILE.tmp" > "$ENV_FILE" && rm -f "$ENV_FILE.tmp"
  else
    printf '%s=%s\n' "$name" "$value" >> "$ENV_FILE"
  fi
}
env_value() { grep "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' || true; }
json_get() { python3 -c 'import json,sys; d=json.load(sys.stdin); exec(sys.argv[1])' "$1"; }

# 1. API key
[ "${REPLACE_KEY:-no}" = "yes" ] && sed -i '/^QUO_API_KEY=/d;/^QUO_WEBHOOK_SECRET=/d' "$ENV_FILE"
KEY="$(env_value QUO_API_KEY)"
if [ -n "$KEY" ]; then
  echo "A Quo API key is already saved; using it."
else
  read -r -s -p "Paste the Quo API key (Quo > Settings > API), then press Enter: " KEY
  echo
  KEY="$(printf '%s' "$KEY" | tr -d '[:space:]')"
  [ -n "$KEY" ] || { echo "No key entered. Nothing was changed."; exit 1; }
fi

# 2. Find the number in Quo (also proves the key works).
ENCODED_NUMBER="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$NUMBER")"
if ! PHONES="$(curl -fsS -H "Authorization: $KEY" -H "Quo-Api-Version: $QUO_VERSION" \
    "$QUO_API/phone-numbers?phoneNumber=$ENCODED_NUMBER&limit=10")"; then
  echo "Quo did not accept that API key (or could not be reached). Check the key in Quo > Settings > API. Nothing was changed."
  exit 1
fi
PHONE_ID="$(printf '%s' "$PHONES" | NUMBER="$NUMBER" json_get '
import os
rows = [r for r in d.get("data", []) if r.get("phoneNumber") == os.environ["NUMBER"]]
print(rows[0]["id"] if len(rows) == 1 else "")')"
[ -n "$PHONE_ID" ] || { echo "Quo has no number $NUMBER in this workspace. Check the number and the workspace the API key belongs to. Nothing was changed."; exit 1; }
echo "Found $NUMBER in Quo ($PHONE_ID)."

set_env QUO_API_KEY "$KEY"
unset KEY

# 3. Webhook (created once; Quo shows its signing secret only at creation).
if [ -n "$(env_value QUO_WEBHOOK_SECRET)" ]; then
  echo "Quo webhook already set up; keeping it."
else
  BODY="$(python3 -c 'import json,sys; print(json.dumps({"url": sys.argv[1], "label": "OpenVPM", "resourceIds": [sys.argv[2]], "events": ["message.received","message.delivered","message.failed","message.undelivered","call.completed","call.voicemail.completed"]}))' "$WEBHOOK_URL" "$PHONE_ID")"
  if ! CREATED="$(curl -fsS -X POST -H "Authorization: $(env_value QUO_API_KEY)" -H "Quo-Api-Version: $QUO_VERSION" \
      -H "Content-Type: application/json" -d "$BODY" "$QUO_API/webhooks")"; then
    echo "Quo would not create the webhook. Nothing else was changed; the API key is saved, so just run this again."
    exit 1
  fi
  SECRET="$(printf '%s' "$CREATED" | json_get 'print((d.get("data") or {}).get("key") or "")')"
  [ -n "$SECRET" ] || { echo "Quo created the webhook but returned no signing secret. Delete the 'OpenVPM' webhook in Quo > Settings > Webhooks and run this again."; exit 1; }
  set_env QUO_WEBHOOK_SECRET "$SECRET"
  unset SECRET
  echo "Quo webhook created: $WEBHOOK_URL"
fi

# 4. Clinic location + sender in the database.
if [ -n "${LOCATION_ID:-}" ]; then
  LOC_ROW="$("${PSQL[@]}" -F '|' -c "select practice_id, id from locations where id = '$LOCATION_ID' and deleted_at is null")"
else
  LOC_COUNT="$("${PSQL[@]}" -c "select count(*) from locations where deleted_at is null")"
  if [ "$LOC_COUNT" != "1" ]; then
    echo "There are $LOC_COUNT clinic locations. Rerun with LOCATION_ID=<id> set to one of:"
    "${PSQL[@]}" -F '  ' -c "select id, name from locations where deleted_at is null order by created_at"
    exit 1
  fi
  LOC_ROW="$("${PSQL[@]}" -F '|' -c "select practice_id, id from locations where deleted_at is null")"
fi
PRACTICE_ID="${LOC_ROW%%|*}"; LOC_ID="${LOC_ROW##*|}"
[ -n "$PRACTICE_ID" ] && [ -n "$LOC_ID" ] || { echo "Location not found."; exit 1; }

if [ "${TEXTING_APPROVED:-no}" = "yes" ]; then STATUS=active; ENABLED=true; else STATUS=pending; ENABLED=false; fi
"${PSQL[@]}" <<SQL
set app.rls_bypass = 'on';
insert into location_messaging (practice_id, location_id, provider, messaging_profile_id, sender_e164, number_source, registration_status, registration_detail, enabled)
values ('$PRACTICE_ID', '$LOC_ID', 'quo', '$PHONE_ID', '$NUMBER', 'hosted', '$STATUS', 'Texting registration is managed in Quo.', $ENABLED)
on conflict (location_id) do update set
  provider = excluded.provider,
  messaging_profile_id = excluded.messaging_profile_id,
  sender_e164 = excluded.sender_e164,
  number_source = excluded.number_source,
  registration_status = excluded.registration_status,
  registration_detail = excluded.registration_detail,
  enabled = excluded.enabled,
  deleted_at = null,
  updated_at = now();
SQL

NAME="${DISPLAY_NAME:-$("${PSQL[@]}" -c "select name from practices where id = '$PRACTICE_ID'")}"
set_env MESSAGING_PROVIDER quo
set_env QUO_PHONE_NUMBER "$NUMBER"
set_env QUO_PHONE_NUMBER_ID "$PHONE_ID"
set_env MESSAGING_REGISTERED_DISPLAY_NAME "$NAME"
chmod 640 "$ENV_FILE" && chown root:openvpm "$ENV_FILE"

systemctl restart openvpm
for i in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:3000/login && break; sleep 2; done

echo
echo "Quo is connected to OpenVPM for $NUMBER."
echo "  Incoming texts, calls and voicemails will show up in Communications."
if [ "$ENABLED" = true ]; then
  echo "  Outgoing texts are ON, sent as \"$NAME\"."
else
  echo "  Outgoing texts are OFF until Quo approves texting registration."
  echo "  When it is approved, run:  sudo TEXTING_APPROVED=yes bash $0 $NUMBER"
fi
