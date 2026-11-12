#!/bin/bash
# Turns on the clinic's public appointment request page, so new clients can
# send a visit request with their contact details, pet and intake answers
# without creating an account. Requests stay unconfirmed until the clinic
# confirms them, exactly as when the page is published from
# Settings > Booking in the staff app.
#
#   sudo bash enable-public-booking.sh         # publish (safe to re-run)
#   sudo bash enable-public-booking.sh --off   # unpublish the page again
#
# Re-running keeps the page's link, hours and any visit types already picked.
# Everything it sets can be changed later in Settings > Booking.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
[ -f /root/zenpaws-admin.env ] || { echo "Run set-db-admin.sh first (no /root/zenpaws-admin.env)."; exit 1; }
. /root/zenpaws-admin.env
APP="https://${ZENPAWS_DOMAIN:-app.zenpawsdvm.com}"
SLUG="${SLUG:-zenpaws}"
PSQL=(psql "$MASTER_URL" -v ON_ERROR_STOP=1 -Atq)

PRACTICE=$("${PSQL[@]}" -c "select id from practices where deleted_at is null order by created_at limit 1")
[ -n "$PRACTICE" ] || { echo "No practice found. Nothing was changed."; exit 1; }

if [ "${1:-}" = "--off" ]; then
  "${PSQL[@]}" -c "update booking_pages set published = false, updated_at = now() where practice_id = '$PRACTICE' and deleted_at is null"
  echo "The appointment request page is unpublished. Nothing else was changed."
  exit 0
fi

TYPES=$("${PSQL[@]}" -c "select count(*) from appointment_types where practice_id = '$PRACTICE' and deleted_at is null")
[ "$TYPES" -gt 0 ] || { echo "There are no visit types yet. Add them in Settings > Appointment Types, then run this again. Nothing was changed."; exit 1; }

"${PSQL[@]}" -v practice="$PRACTICE" -v slug="$SLUG" <<'SQL'
with active_types as (
  select coalesce(jsonb_agg(id::text order by name), '[]'::jsonb) as ids
  from appointment_types
  where practice_id = :'practice' and deleted_at is null
),
existing as (
  select id, config from booking_pages
  where practice_id = :'practice' and deleted_at is null
  limit 1
),
wanted as (
  select
    -- Starting point for a new page; an existing page keeps its own settings.
    jsonb_build_object(
      'hours', jsonb_build_array(
        null,
        jsonb_build_object('open', '08:00', 'close', '18:00'),
        jsonb_build_object('open', '08:00', 'close', '18:00'),
        jsonb_build_object('open', '08:00', 'close', '18:00'),
        jsonb_build_object('open', '08:00', 'close', '18:00'),
        jsonb_build_object('open', '08:00', 'close', '18:00'),
        null),
      'autoConfirm', false,
      'leadTimeMinutes', 1440,
      'bookingWindowDays', 60,
      'welcomeText', 'Tell us about your pet and pick a time that suits you. We''ll confirm your visit by email.',
      'accentColor', '#1B78C2'
    )
    || coalesce((select config from existing), '{}'::jsonb)
    || jsonb_build_object(
      'allowNewClients', true,
      'intakeFieldKeys', jsonb_build_array(
        'serviceAddress', 'symptoms', 'concernOnset', 'currentMedications',
        'allergies', 'medicalHistory', 'diet', 'handlingNotes'),
      'bookableTypeIds', case
        when jsonb_array_length(coalesce((select config from existing)->'bookableTypeIds', '[]'::jsonb)) > 0
          then (select config from existing)->'bookableTypeIds'
        else (select ids from active_types)
      end
    ) as config
),
updated as (
  update booking_pages
  set published = true, config = (select config from wanted), updated_at = now()
  where id = (select id from existing)
  returning id
)
insert into booking_pages (practice_id, slug, published, config)
select :'practice', :'slug', true, (select config from wanted)
where not exists (select 1 from existing);
SQL

LIVE_SLUG=$("${PSQL[@]}" -c "select slug from booking_pages where practice_id = '$PRACTICE' and deleted_at is null and published limit 1")
echo
echo "Visit types people can request:"
"${PSQL[@]}" -c "select '  - ' || t.name from booking_pages b cross join lateral jsonb_array_elements_text(b.config->'bookableTypeIds') as picked(id) join appointment_types t on t.id::text = picked.id where b.practice_id = '$PRACTICE' and b.deleted_at is null order by t.name"
echo
echo "PUBLIC BOOKING IS ON: $APP/book/$LIVE_SLUG"
echo "New clients can request a visit there without an account. Change anything in Settings > Booking."
