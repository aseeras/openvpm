#!/bin/bash
# Creates a clearly labeled demo client and pet for trying the Holistic (TCVM)
# workup, or hides them again:
#   sudo bash create-holistic-demo.sh           # create (safe to re-run)
#   sudo bash create-holistic-demo.sh --remove  # hide the demo client again
#
# What it creates (all named "(demo)"):
#   - Client "Jordan Holistic (demo)" and dog "Bear (demo)", a 12-year-old
#     Labrador with slowly worsening hind-end weakness.
#   - A completed exam 3 weeks ago with weight and vitals, a signed visit note,
#     and an active problem ("hind-end weakness").
#   - An acupuncture house call 3 days out, with the owner's pre-visit
#     check-in already filled in (seeks cool floors, thirsty, restless at
#     night), which the workup reads as owner-reported context.
# Then sign in as a veterinarian or admin, open Bear and press
# "Holistic workup". Workups are drafts and are never saved to the chart.
#
# Removal soft-deletes, the same way the app archives records. The signed
# visit note stays attached to the hidden pet, since signed notes can't be
# deleted.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
[ -f /root/zenpaws-admin.env ] || { echo "Run set-db-admin.sh first (no /root/zenpaws-admin.env)."; exit 1; }
. /root/zenpaws-admin.env
APP="${ZP_APP_URL:-https://app.zenpawsdvm.com}"
PSQL=(psql "$MASTER_URL" -v ON_ERROR_STOP=1 -Atq)
LAST_NAME='Holistic (demo)'

if [ "${1:-}" = "--remove" ]; then
  "${PSQL[@]}" <<'SQL'
with demo as (
  select id from clients where last_name = 'Holistic (demo)' and deleted_at is null
), check_ins as (
  update appointment_check_ins set deleted_at = now() where client_id in (select id from demo) and deleted_at is null returning id
), problems as (
  update problem_list set deleted_at = now() where patient_id in (select id from patients where client_id in (select id from demo)) and deleted_at is null returning id
), pets as (
  update patients set deleted_at = now() where client_id in (select id from demo) and deleted_at is null returning id
), visits as (
  update appointments set deleted_at = now() where client_id in (select id from demo) and deleted_at is null returning id
)
update clients set deleted_at = now() where id in (select id from demo);
SQL
  echo "Holistic demo client hidden."
  exit 0
fi

existing=$("${PSQL[@]}" -c "select p.id from patients p join clients c on c.id = p.client_id where c.last_name = '$LAST_NAME' and c.deleted_at is null and p.deleted_at is null limit 1")
if [ -n "$existing" ]; then
  echo "The holistic demo already exists. Bear (demo): $APP/patients/$existing"
  exit 0
fi

vet_count=$("${PSQL[@]}" -c "select count(*) from users u join practices p on p.id = u.practice_id where p.deleted_at is null and u.deleted_at is null and u.role in ('veterinarian', 'admin') and p.id = (select id from practices where deleted_at is null order by created_at limit 1)")
[ "$vet_count" -gt 0 ] || { echo "No veterinarian or admin login in the practice. Nothing was changed."; exit 1; }

"${PSQL[@]}" > /tmp/zp-holistic-ids <<'SQL'
begin;
with practice as (
  select id from practices where deleted_at is null order by created_at limit 1
), vet as (
  select u.id, u.name from users u, practice p
  where u.practice_id = p.id and u.deleted_at is null and u.role in ('veterinarian', 'admin')
  order by (u.role = 'veterinarian') desc, u.created_at limit 1
), loc as (
  select l.id from locations l, practice p where l.practice_id = p.id order by l.created_at limit 1
), client as (
  insert into clients (practice_id, first_name, last_name, email, phone)
  select p.id, 'Jordan', 'Holistic (demo)', 'holistic-demo@example.com', '(555) 010-0001' from practice p
  returning id, practice_id
), bear as (
  insert into patients (practice_id, client_id, name, species, breed, sex, dob)
  select c.practice_id, c.id, 'Bear (demo)', 'canine', 'Labrador Retriever', 'male_neutered',
         (now() - interval '12 years 3 months')::date from client c
  returning id, practice_id, client_id
), past_visit as (
  insert into appointments (practice_id, location_id, client_id, patient_id, doctor_id, start_time, end_time, status, notes)
  select b.practice_id, (select id from loc), b.client_id, b.id, (select id from vet),
         now() - interval '21 days', now() - interval '21 days' + interval '60 minutes', 'checked_out',
         'Demo: exam for hind-end weakness'
  from bear b
  returning id, practice_id, patient_id
), vitals as (
  insert into vital_signs (practice_id, patient_id, appointment_id, recorded_by, recorded_at,
                           temperature_c, heart_rate_bpm, respiratory_rate_bpm, weight_kg,
                           body_condition_score, pain_score, mucous_membrane, notes)
  select v.practice_id, v.patient_id, v.id, (select id from vet), now() - interval '21 days',
         38.6, 96, 28, 34.5, 6, 3, 'pink, slightly dry', 'Panting in exam room; tongue looks red and dry.'
  from past_visit v
  returning id
), soap as (
  insert into soap_notes (practice_id, patient_id, appointment_id, author_id, author_name, status,
                          finalized_at, finalized_by, finalizer_name, subjective, objective, assessment, plan)
  select v.practice_id, v.patient_id, v.id, vt.id, vt.name, 'finalized',
         now() - interval '21 days', vt.id, vt.name,
         'Owner reports 4 months of slowly worsening hind-end weakness. Slow to rise, scuffs back toes on walks, worse after long walks and in the evening. Restless and panting at night. Seeks cool tile floors. Drinking more than before.',
         'BAR. BCS 6/9, 34.5 kg. Bilateral hind limb muscle atrophy. Decreased hip extension with discomfort, worse on the right. Delayed conscious proprioception in both hind paws, right worse than left. Lumbosacral pain on palpation. No urinary or fecal incontinence.',
         'Hind-end weakness: osteoarthritis of both hips likely, with possible early lumbosacral disease or degenerative myelopathy (proprioceptive deficits).',
         'Start carprofen 2.2 mg/kg twice daily with food. Chem panel before and 3 weeks after starting. Discussed lumbosacral and hip radiographs; owner will consider. Recheck with acupuncture in 3 weeks.'
  from past_visit v, vet vt
  returning id
), problem as (
  insert into problem_list (practice_id, patient_id, description, status, onset_date)
  select b.practice_id, b.id, 'Hind-end weakness (suspect hip OA, rule out lumbosacral disease / degenerative myelopathy)', 'active',
         (now() - interval '4 months')::date
  from bear b
  returning id
), next_visit as (
  insert into appointments (practice_id, location_id, client_id, patient_id, doctor_id, start_time, end_time, status, origin, notes)
  select b.practice_id, (select id from loc), b.client_id, b.id, (select id from vet),
         date_trunc('day', now()) + interval '3 days 15 hours', date_trunc('day', now()) + interval '3 days 16 hours', 'scheduled', 'field',
         'Demo: acupuncture house call (try the Holistic workup)'
  from bear b
  returning id, practice_id, client_id, patient_id
), check_in as (
  insert into appointment_check_ins (practice_id, appointment_id, patient_id, client_id, answers, submitted_via, submitted_at)
  select n.practice_id, n.id, n.patient_id, n.client_id,
    jsonb_build_object('version', 1, 'answers', jsonb_build_object(
      'mainConcerns', 'His back legs are getting weaker. He struggles to get up and his back feet drag on walks.',
      'concernHistory', 'Started about 4 months ago and is slowly getting worse.',
      'betterOrWorse', 'Worse after long walks, in the evening and on hot days. Better after resting on a cool floor.',
      'pastDiagnoses', 'Told he has arthritis in his hips.',
      'energy', 'varies',
      'activity', 'Two short walks a day. He used to swim.',
      'sleep', 'Restless at night, pants and changes spots a lot.',
      'temperature', 'cool',
      'thirst', 'more',
      'bathroom', 'Stools are normal to a bit dry. Urinates a lot.',
      'temperament', 'Gentle and eager to please, a bit more anxious lately.',
      'appetite', 'normal',
      'diet', 'Dry kibble (lamb and rice), 3 cups a day.',
      'treats', 'Peanut butter biscuits, carrots.',
      'medications', 'Carprofen since the last visit.',
      'supplements', 'Fish oil.',
      'allergies', 'None known.',
      'goals', 'Keep him comfortable and able to go on walks.'
    )),
    'link', now() - interval '1 hour'
  from next_visit n
  returning id
)
select (select id from client), (select id from bear), (select id from next_visit),
       (select count(*) from vitals) + (select count(*) from soap) + (select count(*) from problem) + (select count(*) from check_in);
commit;
SQL

IFS='|' read -r CLIENT_ID BEAR_ID NEXT_VISIT_ID _COUNT < <(grep '|' /tmp/zp-holistic-ids | tail -1)
rm -f /tmp/zp-holistic-ids

cat <<MSG

Holistic demo created:
  Client:  Jordan Holistic (demo)   $APP/clients/$CLIENT_ID
  Pet:     Bear (demo), 12 y Labrador, hind-end weakness
           $APP/patients/$BEAR_ID/holistic
  Chart:   signed exam note 3 weeks ago, vitals, active problem
  Owner check-in filled in for the house call in 3 days

Sign in as a veterinarian or admin, open Bear and press "Holistic workup".
Try: tongue "red, dry, little coating"; pulse "thready, rapid, weak in the
rear positions"; take a tongue photo with your phone; pick the treatments.

Remove later with: sudo bash create-holistic-demo.sh --remove
MSG
