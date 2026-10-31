#!/bin/bash
# Creates clearly labeled test logins for checking the live app end to end, or
# removes them again:
#   sudo ZP_FRONT_DESK_HASH='...' ZP_TECH_HASH='...' ZP_CLIENT_HASH='...' \
#     bash create-test-users.sh            # create (safe to re-run)
#   sudo bash create-test-users.sh --remove  # remove the test logins and records
#
# Each *_HASH is a bcrypt hash of that login's password, made by whoever hands
# out the passwords, so no password is typed on or stored by this server.
#
# What it creates (all named "(test)"):
#   - Staff: front desk and technician logins. Neither is a veterinarian, so
#     neither shows up as a bookable provider.
#   - Client "Casey Tester (test)" with a pet "Biscuit (test)", a completed
#     visit last month, and a portal username/password. No upcoming visit is
#     created, so no real booking slot is taken.
# Removal soft-deletes, the same way the app archives records.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
[ -f /root/zenpaws-admin.env ] || { echo "Run set-db-admin.sh first (no /root/zenpaws-admin.env)."; exit 1; }
. /root/zenpaws-admin.env
APP="https://app.zenpawsdvm.com"
PSQL=(psql "$MASTER_URL" -v ON_ERROR_STOP=1 -Atq)

FRONT_DESK_EMAIL="test-frontdesk@zenpawsdvm.test"
TECH_EMAIL="test-tech@zenpawsdvm.test"
CLIENT_EMAIL="test-client@zenpawsdvm.test"
PORTAL_USERNAME="zp-test-client"

if [ "${1:-}" = "--remove" ]; then
  "${PSQL[@]}" <<SQL
with staff as (
  update users set deleted_at = now(), session_version = session_version + 1
  where email in ('$FRONT_DESK_EMAIL', '$TECH_EMAIL') and deleted_at is null returning id
), test_client as (
  select id from clients where last_name = 'Tester (test)' and deleted_at is null
), account as (
  update portal_accounts set deleted_at = now() where client_id in (select id from test_client) and deleted_at is null returning id
), sessions as (
  update portal_sessions set revoked_at = now() where client_id in (select id from test_client) and revoked_at is null returning id
), pets as (
  update patients set deleted_at = now() where client_id in (select id from test_client) and deleted_at is null returning id
), visits as (
  update appointments set deleted_at = now() where client_id in (select id from test_client) and deleted_at is null returning id
)
update clients set deleted_at = now() where id in (select id from test_client);
SQL
  echo "Test logins removed."
  exit 0
fi

for v in ZP_FRONT_DESK_HASH ZP_TECH_HASH ZP_CLIENT_HASH; do
  case "${!v:-}" in
    '$2'[aby]'$'*) ;;
    *) echo "$v must be a bcrypt hash. Nothing was changed."; exit 1 ;;
  esac
done

"${PSQL[@]}" \
  -v fd_email="$FRONT_DESK_EMAIL" -v tech_email="$TECH_EMAIL" \
  -v client_email="$CLIENT_EMAIL" -v username="$PORTAL_USERNAME" \
  -v fd_hash="$ZP_FRONT_DESK_HASH" -v tech_hash="$ZP_TECH_HASH" -v client_hash="$ZP_CLIENT_HASH" \
  > /tmp/zp-test-ids <<'SQL'
begin;

-- Staff logins. Re-running resets their passwords.
insert into users (email, password_hash, name, role, practice_id, email_verified_at)
select e.email, e.hash, e.name, e.role::user_role, p.id, now()
from (values
  (:'fd_email', :'fd_hash', 'Front Desk (test)', 'front_desk'),
  (:'tech_email', :'tech_hash', 'Technician (test)', 'technician')
) as e(email, hash, name, role),
(select id from practices where deleted_at is null order by created_at limit 1) p
on conflict (email) do update
  set password_hash = excluded.password_hash, deleted_at = null,
      session_version = users.session_version + 1, updated_at = now();

-- Test client, pet and visits, created once.
with practice as (
  select id from practices where deleted_at is null order by created_at limit 1
), existing as (
  select id from clients where last_name = 'Tester (test)' and deleted_at is null
), vet as (
  select u.id from users u, practice p
  where u.practice_id = p.id and u.deleted_at is null and u.role in ('veterinarian', 'admin')
  order by (u.role = 'veterinarian') desc, u.created_at limit 1
), loc as (
  select l.id from locations l, practice p where l.practice_id = p.id order by l.created_at limit 1
), client as (
  insert into clients (practice_id, first_name, last_name, email, phone)
  select p.id, 'Casey', 'Tester (test)', :'client_email', '(555) 010-0199' from practice p
  where not exists (select 1 from existing)
  returning id, practice_id
), pet as (
  insert into patients (practice_id, client_id, name, species, breed, sex, dob)
  select c.practice_id, c.id, 'Biscuit (test)', 'canine', 'Beagle', 'male_neutered', date '2018-06-01' from client c
  returning id, practice_id, client_id
), past_visit as (
  insert into appointments (practice_id, location_id, client_id, patient_id, doctor_id, start_time, end_time, status, notes)
  select b.practice_id, (select id from loc), b.client_id, b.id, (select id from vet),
         now() - interval '30 days', now() - interval '30 days' + interval '60 minutes', 'checked_out',
         'Test: initial exam'
  from pet b
  returning id
)
select 1 from past_visit;

-- Portal login for the test client. Re-running resets the password.
insert into portal_accounts (practice_id, client_id, username, password_hash)
select c.practice_id, c.id, :'username', :'client_hash'
from clients c where c.last_name = 'Tester (test)' and c.deleted_at is null
on conflict (username) where deleted_at is null do update
  set password_hash = excluded.password_hash, failed_attempts = 0, locked_until = null, updated_at = now();

commit;
select id from clients where last_name = 'Tester (test)' and deleted_at is null limit 1;
SQL

CLIENT_ID=$(tail -1 /tmp/zp-test-ids)
rm -f /tmp/zp-test-ids

cat <<MSG

Test logins ready (passwords are the ones you were given):
  Staff, front desk:   $FRONT_DESK_EMAIL    $APP/login
  Staff, technician:   $TECH_EMAIL          $APP/login
  Client portal:       $PORTAL_USERNAME      $APP/portal
  Test client record:  Casey Tester (test)  $APP/clients/$CLIENT_ID

Remove later with: sudo bash /opt/openvpm/deploy/zenpaws/create-test-users.sh --remove
MSG
