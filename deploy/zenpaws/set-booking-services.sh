#!/bin/bash
# Sets up the public appointment request page with the visits ZenPaws offers,
# in place of the general-practice starter visit types (dental cleaning,
# surgery, vaccination and so on), and shows the ZenPaws logo on it.
#
#   sudo bash set-booking-services.sh          # apply (safe to re-run)
#   sudo bash set-booking-services.sh --show   # only list what is set now
#
# What it changes:
#   - Adds the ZenPaws visit types below if they are missing (by name).
#     Existing visit types are not deleted or renamed, and stay usable on
#     the staff schedule; they just stop appearing on the request page.
#   - Makes the request page offer only the ZenPaws visit types.
#   - Sets the practice logo to the website's icon if no logo is set yet.
# Everything can be changed later in Settings > Appointment Types and
# Settings > Booking.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
[ -f /root/zenpaws-admin.env ] || { echo "Run set-db-admin.sh first (no /root/zenpaws-admin.env)."; exit 1; }
. /root/zenpaws-admin.env
APP="https://${ZENPAWS_DOMAIN:-app.zenpawsdvm.com}"
LOGO_URL="${LOGO_URL:-https://zenpawsdvm.com/apple-touch-icon.png}"
PSQL=(psql "$MASTER_URL" -v ON_ERROR_STOP=1 -Atq)

PRACTICE=$("${PSQL[@]}" -c "select id from practices where deleted_at is null order by created_at limit 1")
[ -n "$PRACTICE" ] || { echo "No practice found. Nothing was changed."; exit 1; }

show() {
  local slug
  slug=$("${PSQL[@]}" -c "select slug from booking_pages where practice_id = '$PRACTICE' and deleted_at is null limit 1")
  echo "Visit types on the request page:"
  "${PSQL[@]}" -c "select '  - ' || t.name || ' (' || t.duration_minutes || ' min)' from booking_pages b cross join lateral jsonb_array_elements_text(b.config->'bookableTypeIds') as picked(id) join appointment_types t on t.id::text = picked.id and t.deleted_at is null where b.practice_id = '$PRACTICE' and b.deleted_at is null order by t.duration_minutes desc, t.name"
  echo "Logo: $("${PSQL[@]}" -c "select coalesce(logo_url, '(none)') from practices where id = '$PRACTICE'")"
  [ -n "$slug" ] && echo "Page: $APP/book/$slug"
}

if [ "${1:-}" = "--show" ]; then show; exit 0; fi

HAS_PAGE=$("${PSQL[@]}" -c "select count(*) from booking_pages where practice_id = '$PRACTICE' and deleted_at is null")
[ "$HAS_PAGE" -gt 0 ] || { echo "There is no request page yet. Run enable-public-booking.sh first. Nothing was changed."; exit 1; }

"${PSQL[@]}" -v practice="$PRACTICE" -v logo="$LOGO_URL" <<'SQL'
begin;

create temporary table wanted_types (name text, minutes int, color text, sort int) on commit drop;
insert into wanted_types values
  ('Initial exam & first acupuncture', 90, '#C2410C', 1),
  ('Follow-up acupuncture',            45, '#0D9488', 2),
  ('Rehab & therapeutic exercise',     45, '#2563EB', 3),
  ('Herbal / food-therapy consult',    30, '#65A30D', 4),
  ('Telehealth recheck',               15, '#7C3AED', 5);

insert into appointment_types (practice_id, name, duration_minutes, color, requires_doctor)
select :'practice', w.name, w.minutes, w.color, 1
from wanted_types w
where not exists (
  select 1 from appointment_types t
  where t.practice_id = :'practice' and t.deleted_at is null
    and lower(t.name) = lower(w.name)
);

update booking_pages b
set config = b.config || jsonb_build_object('bookableTypeIds', (
      select jsonb_agg(t.id::text order by w.sort)
      from wanted_types w
      join lateral (
        select id from appointment_types t
        where t.practice_id = :'practice' and t.deleted_at is null
          and lower(t.name) = lower(w.name)
        order by t.created_at
        limit 1
      ) t on true
    )),
    updated_at = now()
where b.practice_id = :'practice' and b.deleted_at is null;

update practices
set logo_url = :'logo', updated_at = now()
where id = :'practice' and coalesce(logo_url, '') = '';

commit;
SQL

echo "DONE."
show
