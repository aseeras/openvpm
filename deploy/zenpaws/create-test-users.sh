#!/bin/bash
# Creates clearly labeled test logins for checking the live app end to end, or
# removes them again:
#   sudo ZP_FRONT_DESK_HASH='...' ZP_TECH_HASH='...' ZP_CLIENT_HASH='...' \
#     bash create-test-users.sh            # create (safe to re-run)
#   sudo bash create-test-users.sh --remove  # remove the test logins and records
#   sudo bash create-test-users.sh --status  # show whether they exist
#
# Each *_HASH is a bcrypt hash of that login's password, made by whoever hands
# out the passwords, so no password is typed on or stored by this server.
#
# What it creates (all named "(test)"):
#   - Staff: front desk and technician logins. Neither is a veterinarian, so
#     neither shows up as a bookable provider.
#   - Client "Casey Tester (test)" with a portal username/password and two
#     pets, Biscuit and Mochi, each with a past visit, visit notes, weights,
#     vaccines, a prescription and lab results. One lab follow-up is assigned
#     to the front desk login, and so is a portal message from the client.
#     There is an unpaid invoice and one upcoming visit at 6:00 AM Eastern two
#     weeks out, before clinic hours, so no real booking slot is taken.
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

if [ "${1:-}" = "--status" ]; then
  echo "Staff test logins (email | role | active | sign-in practice):"
  "${PSQL[@]}" -c "select u.email, u.role, u.deleted_at is null, p.name from users u join practices p on p.id = u.practice_id where u.email in ('$FRONT_DESK_EMAIL', '$TECH_EMAIL')"
  echo "Portal test login (username | failed attempts | locked until):"
  "${PSQL[@]}" -c "select username, failed_attempts, coalesce(locked_until::text, 'not locked') from portal_accounts where username = '$PORTAL_USERNAME' and deleted_at is null"
  echo "Test client records (client | pets | visits):"
  "${PSQL[@]}" -c "select c.first_name || ' ' || c.last_name, (select count(*) from patients where client_id = c.id and deleted_at is null), (select count(*) from appointments where client_id = c.id and deleted_at is null) from clients c where c.last_name = 'Tester (test)' and c.deleted_at is null"
  echo "Practices on this server:"
  "${PSQL[@]}" -c "select name, deleted_at is null from practices order by created_at"
  exit 0
fi

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
), labs as (
  update lab_results set deleted_at = now() where patient_id in (select id from patients where client_id in (select id from test_client)) and deleted_at is null returning id
), bills as (
  update invoices set deleted_at = now() where client_id in (select id from test_client) and deleted_at is null returning id
), messages as (
  update communications set deleted_at = now() where client_id in (select id from test_client) and deleted_at is null returning id
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

-- Test client, pets and their history, created once. To rebuild it, run
-- --remove and then this script again.
select set_config('zp.client_email', :'client_email', true),
       set_config('zp.fd_email', :'fd_email', true),
       set_config('zp.tech_email', :'tech_email', true);
do $$
declare
  practice uuid;
  loc uuid;
  vet uuid;
  vet_name text;
  tech uuid;
  front_desk uuid;
  client uuid;
  biscuit uuid;
  mochi uuid;
  biscuit_visit uuid;
  mochi_visit uuid;
  inv uuid;
begin
  if exists (select 1 from clients where last_name = 'Tester (test)' and deleted_at is null) then
    return;
  end if;
  select id into practice from practices where deleted_at is null order by created_at limit 1;
  select id into loc from locations where practice_id = practice order by created_at limit 1;
  select id, name into vet, vet_name from users
  where practice_id = practice and deleted_at is null and role in ('veterinarian', 'admin')
  order by (role = 'veterinarian') desc, created_at limit 1;
  select id into tech from users where email = current_setting('zp.tech_email');
  select id into front_desk from users where email = current_setting('zp.fd_email');

  insert into clients (practice_id, first_name, last_name, email, phone, address, city, state, zip, notes)
  values (practice, 'Casey', 'Tester (test)', current_setting('zp.client_email'), '(555) 010-0199',
          '100 Test Lane', 'Tampa', 'FL', '33601', 'Test client for trying the app. Not a real person.')
  returning id into client;

  insert into patients (practice_id, client_id, name, species, breed, sex, dob, color)
  values (practice, client, 'Biscuit (test)', 'canine', 'Beagle', 'male_neutered', date '2018-06-01', 'Tricolor')
  returning id into biscuit;
  insert into patients (practice_id, client_id, name, species, breed, sex, dob, color)
  values (practice, client, 'Mochi (test)', 'feline', 'Domestic Shorthair', 'female_spayed', date '2020-03-10', 'Gray tabby')
  returning id into mochi;

  -- Past visits with the clinic's veterinarian.
  insert into appointments (practice_id, location_id, client_id, patient_id, doctor_id, start_time, end_time, status, notes)
  values (practice, loc, client, biscuit, vet, now() - interval '30 days', now() - interval '30 days' + interval '60 minutes',
          'checked_out', 'Test: initial exam and first acupuncture session')
  returning id into biscuit_visit;
  insert into appointments (practice_id, location_id, client_id, patient_id, doctor_id, start_time, end_time, status, notes)
  values (practice, loc, client, mochi, vet, now() - interval '60 days', now() - interval '60 days' + interval '45 minutes',
          'checked_out', 'Test: wellness exam')
  returning id into mochi_visit;

  -- One upcoming visit at 6:00 AM Eastern, two weeks out, before clinic hours
  -- so it never takes a slot a real client could book.
  insert into appointments (practice_id, location_id, client_id, patient_id, doctor_id, start_time, end_time, status, origin, notes)
  values (practice, loc, client, biscuit, vet,
          (date_trunc('day', now() at time zone 'America/New_York') + interval '14 days 6 hours') at time zone 'America/New_York',
          (date_trunc('day', now() at time zone 'America/New_York') + interval '14 days 6 hours 45 minutes') at time zone 'America/New_York',
          'scheduled', 'field', 'Test: follow-up acupuncture (not a real appointment)');

  -- Visit notes.
  insert into soap_notes (practice_id, patient_id, appointment_id, author_id, author_name, subjective, objective, assessment, plan, status)
  values (practice, biscuit, biscuit_visit, vet, vet_name,
          'Test record. Owner reports stiffness getting up in the mornings for about a month.',
          'Test record. T 101.4F, HR 92, RR 20. Mild discomfort on lumbar palpation. Weight 12.4 kg.',
          'Test record. Mild lumbar muscle tension, likely age related.',
          'Test record. Acupuncture today. Recheck in 2 weeks. Carprofen as needed.',
          'finalized');
  insert into soap_notes (practice_id, patient_id, appointment_id, author_id, author_name, subjective, objective, assessment, plan, status)
  values (practice, mochi, mochi_visit, vet, vet_name,
          'Test record. Annual wellness visit. Eating and drinking normally.',
          'Test record. T 101.8F, HR 180, RR 28. Weight 4.6 kg. Bright and alert.',
          'Test record. Healthy adult cat.',
          'Test record. FVRCP booster given. Recheck thyroid level.',
          'finalized');

  -- Weights, vaccines and a prescription.
  insert into patient_weights (patient_id, weight_kg, recorded_at, recorded_by) values
    (biscuit, 12.9, now() - interval '120 days', vet),
    (biscuit, 12.4, now() - interval '30 days', vet),
    (mochi, 4.6, now() - interval '60 days', vet);
  insert into vaccination_records (practice_id, patient_id, vaccine_name, lot_number, manufacturer, administered_by, administered_at, next_due_date) values
    (practice, biscuit, 'Rabies (1 year) (test)', 'TEST-LOT-1', 'Test Manufacturer', vet, now() - interval '30 days', (now() + interval '335 days')::date),
    (practice, mochi, 'FVRCP (test)', 'TEST-LOT-2', 'Test Manufacturer', vet, now() - interval '60 days', (now() + interval '305 days')::date);
  insert into prescriptions (practice_id, patient_id, medication_name, dosage, frequency, quantity, refills_remaining,
                             prescribed_by, start_date, end_date, status, instructions)
  values (practice, biscuit, 'Carprofen (test)', '25mg', 'BID with food', 60, 1, vet,
          (now() - interval '30 days')::date, (now() + interval '30 days')::date, 'active',
          'Test prescription. Not for dispensing.');

  -- Lab results: one finished with its follow-up assigned to the front desk
  -- test login, one still waiting on results.
  insert into lab_results (practice_id, patient_id, appointment_id, test_name, result_value, unit,
                           reference_range_low, reference_range_high, status, result_flag, ordered_by, completed_at,
                           follow_up_status, follow_up_assigned_to, follow_up_note, follow_up_due_at)
  values (practice, biscuit, biscuit_visit, 'Chemistry panel ALT (test)', '58', 'U/L', 10, 125, 'completed', 'normal',
          coalesce(tech, vet), now() - interval '29 days',
          'open', coalesce(front_desk, vet), 'Test: call the owner to share normal results.', now() + interval '3 days');
  insert into lab_results (practice_id, patient_id, appointment_id, test_name, status, ordered_by)
  values (practice, mochi, mochi_visit, 'Total T4 (test)', 'pending', vet);

  -- An unpaid invoice for Biscuit's visit.
  insert into invoices (practice_id, client_id, patient_id, appointment_id, status, subtotal, tax, total, paid_amount, due_date)
  values (practice, client, biscuit, biscuit_visit, 'sent', 135.00, 0, 135.00, 0, (now() + interval '14 days')::date)
  returning id into inv;
  insert into invoice_items (invoice_id, description, quantity, unit_price, total, item_type, taxable)
  values (inv, 'Follow-up acupuncture (test)', 1, 135.00, 135.00, 'service', false);

  -- A portal message from the client, assigned to the front desk test login.
  insert into communications (practice_id, client_id, channel, direction, subject, content, status, assigned_to)
  values (practice, client, 'portal', 'inbound', 'Question about Biscuit (test)',
          'Test message: Is it OK to walk Biscuit the day after acupuncture?', 'delivered', front_desk);
end $$;

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
