#!/bin/bash
# Creates a second, clearly labeled demo client and pet for trying the
# Holistic (TCVM) workup with a fuller chart, or hides them again:
#   sudo bash create-holistic-demo-2.sh           # create (safe to re-run)
#   sudo bash create-holistic-demo-2.sh --remove  # hide the demo client again
#
# What it creates (all named "(demo)"):
#   - Client "Riley Holistic Two (demo)" and dog "Daisy (demo)", a 10-year-old
#     spayed Golden Retriever with itchy, greasy skin, recurring yeast ear
#     infections and weight gain.
#   - Two signed visit notes (8 weeks and 2 weeks ago) with weights and
#     vitals, three active problems and a suspected chicken food allergy.
#   - An acupuncture house call 2 days out, with the owner's pre-visit
#     check-in filled in (seeks warmth, low thirst, soft stools, sluggish).
# Clinical photos (tongue, skin, ear) are added through the app itself so
# they are stored exactly like photos a vet takes.
#
# Removal soft-deletes, the same way the app archives records. Signed visit
# notes and the allergy record stay attached to the hidden pet, since the app
# never deletes those records.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
[ -f /root/zenpaws-admin.env ] || { echo "Run set-db-admin.sh first (no /root/zenpaws-admin.env)."; exit 1; }
. /root/zenpaws-admin.env
APP="${ZP_APP_URL:-https://app.zenpawsdvm.com}"
PSQL=(psql "$MASTER_URL" -v ON_ERROR_STOP=1 -Atq)
LAST_NAME='Holistic Two (demo)'

if [ "${1:-}" = "--remove" ]; then
  "${PSQL[@]}" <<'SQL'
with demo as (
  select id from clients where last_name = 'Holistic Two (demo)' and deleted_at is null
), pet_ids as (
  select id from patients where client_id in (select id from demo)
), check_ins as (
  update appointment_check_ins set deleted_at = now() where client_id in (select id from demo) and deleted_at is null returning id
), problems as (
  update problem_list set deleted_at = now() where patient_id in (select id from pet_ids) and deleted_at is null returning id
), pets as (
  update patients set deleted_at = now() where client_id in (select id from demo) and deleted_at is null returning id
), visits as (
  update appointments set deleted_at = now() where client_id in (select id from demo) and deleted_at is null returning id
)
update clients set deleted_at = now() where id in (select id from demo);
SQL
  echo "Second holistic demo client hidden."
  exit 0
fi

existing=$("${PSQL[@]}" -c "select p.id from patients p join clients c on c.id = p.client_id where c.last_name = '$LAST_NAME' and c.deleted_at is null and p.deleted_at is null limit 1")
if [ -n "$existing" ]; then
  echo "The second holistic demo already exists. Daisy (demo): $APP/patients/$existing/holistic"
  exit 0
fi

vet_count=$("${PSQL[@]}" -c "select count(*) from users u where u.deleted_at is null and u.role in ('veterinarian', 'admin') and u.practice_id = (select id from practices where deleted_at is null order by created_at limit 1)")
[ "$vet_count" -gt 0 ] || { echo "No veterinarian or admin login in the practice. Nothing was changed."; exit 1; }

"${PSQL[@]}" > /tmp/zp-holistic2-ids <<'SQL'
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
  select p.id, 'Riley', 'Holistic Two (demo)', 'holistic-demo-2@example.com', '(555) 010-0002' from practice p
  returning id, practice_id
), daisy as (
  insert into patients (practice_id, client_id, name, species, breed, sex, dob)
  select c.practice_id, c.id, 'Daisy (demo)', 'canine', 'Golden Retriever', 'female_spayed',
         (now() - interval '10 years 2 months')::date from client c
  returning id, practice_id, client_id
), visit1 as (
  insert into appointments (practice_id, location_id, client_id, patient_id, doctor_id, start_time, end_time, status, notes)
  select d.practice_id, (select id from loc), d.client_id, d.id, (select id from vet),
         now() - interval '56 days', now() - interval '56 days' + interval '60 minutes', 'checked_out',
         'Demo: itchy skin and ear recheck'
  from daisy d
  returning id, practice_id, patient_id
), visit2 as (
  insert into appointments (practice_id, location_id, client_id, patient_id, doctor_id, start_time, end_time, status, notes)
  select d.practice_id, (select id from loc), d.client_id, d.id, (select id from vet),
         now() - interval '14 days', now() - interval '14 days' + interval '45 minutes', 'checked_out',
         'Demo: skin and ear recheck, diet trial check'
  from daisy d
  returning id, practice_id, patient_id
), vitals1 as (
  insert into vital_signs (practice_id, patient_id, appointment_id, recorded_by, recorded_at,
                           temperature_c, heart_rate_bpm, respiratory_rate_bpm, weight_kg,
                           body_condition_score, pain_score, mucous_membrane, notes)
  select v.practice_id, v.patient_id, v.id, (select id from vet), now() - interval '56 days',
         38.4, 88, 24, 36.8, 7, 1, 'pink, moist', 'Greasy coat with a yeasty odor; red, waxy ears.'
  from visit1 v
  returning id
), vitals2 as (
  insert into vital_signs (practice_id, patient_id, appointment_id, recorded_by, recorded_at,
                           temperature_c, heart_rate_bpm, respiratory_rate_bpm, weight_kg,
                           body_condition_score, pain_score, mucous_membrane, notes)
  select v.practice_id, v.patient_id, v.id, (select id from vet), now() - interval '14 days',
         38.3, 84, 22, 37.4, 7, 1, 'pale pink, moist', 'Still itchy; ears improved but not clear.'
  from visit2 v
  returning id
), soap1 as (
  insert into soap_notes (practice_id, patient_id, appointment_id, author_id, author_name, status,
                          finalized_at, finalized_by, finalizer_name, subjective, objective, assessment, plan)
  select v.practice_id, v.patient_id, v.id, vt.id, vt.name, 'finalized',
         now() - interval '56 days', vt.id, vt.name,
         'Itchy for about 2 years, worse each summer and in humid weather. Licks paws, rubs face, scratches belly and armpits. Right ear shaking and odor for 3 weeks. Gained weight, sluggish after meals, soft stools. Seeks sunny spots and blankets.',
         'BCS 7/9, 36.8 kg. Greasy seborrhea with erythema and mild alopecia on ventral abdomen, axillae and inguinal folds; lichenification in the folds. Interdigital erythema all paws. Right ear canal erythematous with brown waxy discharge; ear cytology: many Malassezia yeast, few cocci. Skin cytology (abdomen): Malassezia overgrowth. T4 normal.',
         'Atopic dermatitis with secondary Malassezia dermatitis and right Malassezia otitis externa. Suspected cutaneous adverse food reaction (chicken). Overweight.',
         'Oclacitinib 16 mg once daily. Chlorhexidine/miconazole shampoo twice weekly. Ear cleaner and topical antifungal ear medication for 14 days. Start hydrolyzed protein diet trial (8 weeks, no chicken treats). Recheck in 6 weeks.'
  from visit1 v, vet vt
  returning id
), soap2 as (
  insert into soap_notes (practice_id, patient_id, appointment_id, author_id, author_name, status,
                          finalized_at, finalized_by, finalizer_name, subjective, objective, assessment, plan)
  select v.practice_id, v.patient_id, v.id, vt.id, vt.name, 'finalized',
         now() - interval '14 days', vt.id, vt.name,
         'Owner says itching is about 40 percent better on oclacitinib and the diet, but still licks paws at night. Ears less smelly. Stools still soft. Gained more weight; tired on walks.',
         'BCS 7/9, 37.4 kg. Less erythema on abdomen, still greasy coat and mild odor. Right ear canal mild erythema, small amount of brown wax; cytology: few yeast. Left ear normal. Paws: mild interdigital erythema.',
         'Atopic dermatitis, partially controlled. Right otitis externa improving. Weight gain on current plan. Owner interested in acupuncture and food therapy alongside conventional care.',
         'Continue oclacitinib and diet trial. Ear cleaning twice weekly. Reduce daily food by 10 percent. Refer for TCVM consult (acupuncture, herbs, food therapy). Recheck in 4 weeks.'
  from visit2 v, vet vt
  returning id
), problems as (
  insert into problem_list (practice_id, patient_id, description, status, onset_date)
  select d.practice_id, d.id, x.description, x.status::problem_status, x.onset::date
  from daisy d, (values
    ('Atopic dermatitis with recurrent Malassezia dermatitis', 'chronic', now() - interval '2 years'),
    ('Recurrent right Malassezia otitis externa', 'active', now() - interval '3 months'),
    ('Overweight (BCS 7/9)', 'active', now() - interval '6 months')
  ) as x(description, status, onset)
  returning id
), allergy as (
  insert into patient_allergies (patient_id, allergen, reaction, severity, noted_by)
  select d.id, 'Chicken (suspected food allergy)', 'Itchy skin and ear flare-ups', 'mild', (select id from vet)
  from daisy d
  returning id
), next_visit as (
  insert into appointments (practice_id, location_id, client_id, patient_id, doctor_id, start_time, end_time, status, origin, notes)
  select d.practice_id, (select id from loc), d.client_id, d.id, (select id from vet),
         date_trunc('day', now()) + interval '2 days 15 hours', date_trunc('day', now()) + interval '2 days 16 hours', 'scheduled', 'field',
         'Demo: TCVM consult and acupuncture house call'
  from daisy d
  returning id, practice_id, client_id, patient_id
), check_in as (
  insert into appointment_check_ins (practice_id, appointment_id, patient_id, client_id, answers, submitted_via, submitted_at)
  select n.practice_id, n.id, n.patient_id, n.client_id,
    jsonb_build_object('version', 1, 'answers', jsonb_build_object(
      'mainConcerns', 'Itchy skin, smelly greasy coat and her right ear keeps getting infected. She has also put on weight.',
      'concernHistory', 'Itching for about 2 years, worse every summer. Ear infections on and off for 3 months.',
      'betterOrWorse', 'Worse in hot, humid weather and after treats. A little better after baths and on the new diet.',
      'pastDiagnoses', 'Allergies (atopic dermatitis), yeast ear infections, maybe a chicken allergy.',
      'energy', 'low',
      'activity', 'Short walks twice a day; gets tired and lies down halfway.',
      'sleep', 'Sleeps a lot during the day. Licks her paws at night.',
      'temperature', 'warm',
      'thirst', 'less',
      'bathroom', 'Stools are soft and sometimes mucousy. Urine normal.',
      'temperament', 'Sweet, easygoing, a bit of a worrier. Loves food.',
      'appetite', 'ravenous',
      'diet', 'Hydrolyzed protein prescription kibble, 3.5 cups a day.',
      'treats', 'Was getting chicken jerky; now only kibble pieces and green beans.',
      'medications', 'Oclacitinib (Apoquel) once a day. Ear cleaner twice a week. Medicated shampoo twice a week.',
      'supplements', 'Fish oil.',
      'allergies', 'Maybe chicken.',
      'goals', 'Stop the itching and ear infections, help her lose weight, and use less medication if possible.'
    )),
    'link', now() - interval '2 hours'
  from next_visit n
  returning id
)
select (select id from client), (select id from daisy), (select id from next_visit),
       (select count(*) from vitals1) + (select count(*) from vitals2) + (select count(*) from soap1)
       + (select count(*) from soap2) + (select count(*) from problems) + (select count(*) from allergy)
       + (select count(*) from check_in);
commit;
SQL

IFS='|' read -r CLIENT_ID DAISY_ID _NEXT_VISIT_ID _COUNT < <(grep '|' /tmp/zp-holistic2-ids | tail -1)
rm -f /tmp/zp-holistic2-ids

cat <<MSG

Second holistic demo created:
  Client:  Riley Holistic Two (demo)   $APP/clients/$CLIENT_ID
  Pet:     Daisy (demo), 10 y Golden Retriever, itchy greasy skin and yeast ears
           $APP/patients/$DAISY_ID/holistic
  Chart:   2 signed visit notes, weights and vitals, 3 problems, chicken allergy
  Owner check-in filled in for the house call in 2 days

Remove later with: sudo bash create-holistic-demo-2.sh --remove
MSG
