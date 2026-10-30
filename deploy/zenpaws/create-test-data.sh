#!/bin/bash
# Creates a clearly labeled demo family for trying video visits and house-call
# recording, or hides it again:
#   sudo bash create-test-data.sh           # create (safe to re-run)
#   sudo bash create-test-data.sh --remove  # hide the demo family again
# Demo records are named "(demo)". Removal soft-deletes them, the same way the
# app archives records, so nothing else in the chart history is touched.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
[ -f /root/zenpaws-admin.env ] || { echo "Run set-db-admin.sh first (no /root/zenpaws-admin.env)."; exit 1; }
. /root/zenpaws-admin.env
APP="https://app.zenpawsdvm.com"
PSQL=(psql "$MASTER_URL" -v ON_ERROR_STOP=1 -Atq)

if [ "${1:-}" = "--remove" ]; then
  "${PSQL[@]}" <<'SQL'
with demo as (
  select id from clients where last_name = 'Family (demo)' and deleted_at is null
), pets as (
  update patients set deleted_at = now() where client_id in (select id from demo) and deleted_at is null returning id
), visits as (
  update appointments set deleted_at = now() where client_id in (select id from demo) and deleted_at is null returning id
)
update clients set deleted_at = now() where id in (select id from demo);
SQL
  echo "Demo family hidden."
  exit 0
fi

existing=$("${PSQL[@]}" -c "select id from clients where last_name = 'Family (demo)' and deleted_at is null limit 1")
if [ -n "$existing" ]; then
  echo "The demo family already exists: $APP/clients/$existing"
  exit 0
fi

"${PSQL[@]}" > /tmp/zp-demo-ids <<'SQL'
with practice as (
  select id from practices where deleted_at is null order by created_at limit 1
), vet as (
  select u.id from users u, practice p
  where u.practice_id = p.id and u.deleted_at is null and u.role in ('veterinarian', 'admin')
  order by (u.role = 'veterinarian') desc, u.created_at limit 1
), loc as (
  select l.id from locations l, practice p where l.practice_id = p.id order by l.created_at limit 1
), client as (
  insert into clients (practice_id, first_name, last_name, email, phone)
  select p.id, 'Margaret', 'Family (demo)', 'demo-family@example.com', '(555) 010-0000' from practice p
  returning id, practice_id
), rusty as (
  insert into patients (practice_id, client_id, name, species, breed, sex, dob, photo_url)
  select c.practice_id, c.id, 'Rusty (demo)', 'canine', 'Golden Retriever', 'male_neutered', date '2014-04-01', '/demo/rusty.jpg' from client c
  returning id, practice_id, client_id
), pepper as (
  insert into patients (practice_id, client_id, name, species, breed, sex, dob, photo_url)
  select c.practice_id, c.id, 'Pepper (demo)', 'canine', 'Dachshund', 'female_spayed', date '2016-09-15', '/demo/pepper.jpg' from client c
  returning id
), past_visit as (
  -- A completed in-person visit makes Rusty an established patient.
  insert into appointments (practice_id, location_id, client_id, patient_id, doctor_id, start_time, end_time, status, notes)
  select r.practice_id, (select id from loc), r.client_id, r.id, (select id from vet),
         now() - interval '30 days', now() - interval '30 days' + interval '75 minutes', 'checked_out',
         'Demo: initial exam and first acupuncture session'
  from rusty r
  returning id
), house_call as (
  -- Today's house call, already in exam, for trying visit recording.
  insert into appointments (practice_id, location_id, client_id, patient_id, doctor_id, start_time, end_time, status, origin, notes)
  select r.practice_id, (select id from loc), r.client_id, r.id, (select id from vet),
         now() - interval '5 minutes', now() + interval '40 minutes', 'in_exam', 'field',
         'Demo: follow-up acupuncture house call'
  from rusty r
  returning id
), next_visit as (
  -- An upcoming acupuncture house call, for the home screen's "Coming up".
  insert into appointments (practice_id, location_id, client_id, patient_id, doctor_id, start_time, end_time, status, origin, notes)
  select r.practice_id, (select id from loc), r.client_id, r.id, (select id from vet),
         date_trunc('day', now()) + interval '4 days 15 hours', date_trunc('day', now()) + interval '4 days 15 hours 45 minutes', 'scheduled', 'field',
         'Demo: follow-up acupuncture'
  from rusty r
  returning id
)
select (select id from client), (select id from house_call), (select id from past_visit), (select id from next_visit);
SQL

IFS='|' read -r CLIENT_ID HOUSE_CALL_ID PAST_VISIT_ID _NEXT_VISIT_ID < /tmp/zp-demo-ids
rm -f /tmp/zp-demo-ids

# House-call screens need the ambulatory workspace switched on for the practice.
ambulatory=$("${PSQL[@]}" -c "select coalesce(settings->'ambulatoryWorkspace'->>'enabled','false') from practices where deleted_at is null order by created_at limit 1")
if [ "$ambulatory" != "true" ]; then
  "${PSQL[@]}" -c "update practices set settings = coalesce(settings,'{}'::jsonb) || jsonb_build_object('ambulatoryWorkspace', coalesce(settings->'ambulatoryWorkspace','{}'::jsonb) || '{\"enabled\": true}'::jsonb) where id = (select id from practices where deleted_at is null order by created_at limit 1)"
  echo "Switched on the house-call (ambulatory) workspace for the practice."
fi

cat <<MSG

Demo family created:
  Client:    Margaret Family (demo)       $APP/clients/$CLIENT_ID
  Rusty:     established (completed visit 30 days ago) -> can request video visits
  Pepper:    no visits yet -> shown greyed out for video visits
  House call in exam today for Rusty -> try "Record this visit":
             $APP/encounters/$HOUSE_CALL_ID

Remove later with: sudo bash /opt/openvpm/deploy/zenpaws/create-test-data.sh --remove
MSG
