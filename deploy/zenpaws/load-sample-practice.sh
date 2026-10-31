#!/bin/bash
# Fills the practice with a made-up client list so the app can be shown and
# tried as if it were in daily use, or takes it out again:
#   sudo bash load-sample-practice.sh              # load (once; re-running does nothing)
#   sudo bash load-sample-practice.sh --off-hours  # same, but today's and upcoming visits sit at
#                                                  # 6:00-7:30 AM so no bookable slot is taken
#   sudo bash load-sample-practice.sh --status     # show what is loaded
#   sudo bash load-sample-practice.sh --remove     # take all of it out again
#
# What it loads: 18 households and 26 pets (all owners' last names end in
# "(demo)", emails are @example.com, phones are 555-01xx), with eight months
# of house-call history for an integrative / acupuncture practice: visits,
# finalized visit notes, weights, prior vaccines, prescriptions, lab results,
# invoices, client messages and care reminders, plus visits today and over
# the next three weeks.
#
# Everything is registered as the practice's sample data, so:
#   - Settings > Data > "Remove sample data" in the app also removes it, and
#   - appointment and vaccine reminder jobs skip these clients.
# Removal soft-deletes, the same way the app archives records.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
if [ -z "${MASTER_URL:-}" ]; then
  [ -f /root/zenpaws-admin.env ] || { echo "Run set-db-admin.sh first (no /root/zenpaws-admin.env)."; exit 1; }
  . /root/zenpaws-admin.env
fi
APP="${ZP_APP_URL:-https://app.zenpawsdvm.com}"
PSQL=(psql "$MASTER_URL" -v ON_ERROR_STOP=1 -Atq)
MARK="zenpaws-sample"

PRACTICE_SQL="(select id from practices where deleted_at is null order by created_at limit 1)"

if [ "${1:-}" = "--status" ]; then
  "${PSQL[@]}" -F ' ' <<SQL
select 'Sample households:', count(*) from clients where external_source = '$MARK' and deleted_at is null;
select 'Sample pets:      ', count(*) from patients where external_source = '$MARK' and deleted_at is null;
select 'Sample visits:    ', count(*) from appointments a join clients c on c.id = a.client_id
  where c.external_source = '$MARK' and a.deleted_at is null;
select 'Upcoming visits:  ', count(*) from appointments a join clients c on c.id = a.client_id
  where c.external_source = '$MARK' and a.deleted_at is null and a.start_time > now();
SQL
  exit 0
fi

if [ "${1:-}" = "--remove" ]; then
  "${PSQL[@]}" -v mark="$MARK" <<SQL
begin;
select pg_advisory_xact_lock(hashtextextended('openvpm:demo-data:' || $PRACTICE_SQL::text, 0));
create temp table zp_c on commit drop as select id from clients where external_source = :'mark' and practice_id = $PRACTICE_SQL;
create temp table zp_p on commit drop as select id from patients where client_id in (select id from zp_c);
create temp table zp_a on commit drop as select id from appointments where client_id in (select id from zp_c);
create temp table zp_i on commit drop as select id from invoices where client_id in (select id from zp_c);
update soap_notes set deleted_at = now() where patient_id in (select id from zp_p) and deleted_at is null;
update lab_results set deleted_at = now() where patient_id in (select id from zp_p) and deleted_at is null;
update prescriptions set deleted_at = now() where patient_id in (select id from zp_p) and deleted_at is null;
update vaccination_records set deleted_at = now() where patient_id in (select id from zp_p) and deleted_at is null;
update care_reminders set deleted_at = now() where patient_id in (select id from zp_p) and deleted_at is null;
update patient_weights set deleted_at = now() where patient_id in (select id from zp_p) and deleted_at is null;
update invoice_items set deleted_at = now() where invoice_id in (select id from zp_i) and deleted_at is null;
update invoices set deleted_at = now() where id in (select id from zp_i) and deleted_at is null;
update communications set deleted_at = now() where client_id in (select id from zp_c) and deleted_at is null;
update appointments set deleted_at = now() where id in (select id from zp_a) and deleted_at is null;
update patients set deleted_at = now() where id in (select id from zp_p) and deleted_at is null;
update clients set deleted_at = now() where id in (select id from zp_c) and deleted_at is null;
-- Mark the practice's sample data as cleared, like the app's own button.
update practices set settings = jsonb_set(settings, '{demoData,clearedAt}', to_jsonb(to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
where id = $PRACTICE_SQL and settings ? 'demoData';
commit;
SQL
  echo "Sample practice data removed."
  exit 0
fi

OFF_HOURS=0
[ "${1:-}" = "--off-hours" ] && OFF_HOURS=1

existing=$("${PSQL[@]}" -c "select count(*) from clients where external_source = '$MARK' and deleted_at is null and practice_id = $PRACTICE_SQL")
if [ "$existing" != "0" ]; then
  echo "Sample practice data is already loaded ($existing households). To rebuild it, run --remove first."
  exit 0
fi

"${PSQL[@]}" -o /dev/null -v mark="$MARK" -v off_hours="$OFF_HOURS" <<'SQL'
begin;
select set_config('zp.mark', :'mark', true), set_config('zp.off_hours', :'off_hours', true);

create temp table zp_people (n int, first_name text, last_name text, street text, city text, zip text) on commit drop;
insert into zp_people values
  (1, 'Maria', 'Alvarez', '418 Bayshore Ct', 'Tampa', '33606'),
  (2, 'James', 'Whitfield', '2211 Palmetto St', 'Clearwater', '33765'),
  (3, 'Priya', 'Natarajan', '97 Heron Way', 'Lutz', '33549'),
  (4, 'Tom', 'Kowalski', '1530 Gulf Blvd', 'St. Petersburg', '33706'),
  (5, 'Denise', 'Carter', '640 Live Oak Ln', 'Brandon', '33511'),
  (6, 'Kevin', 'Nguyen', '3307 Mangrove Dr', 'Tampa', '33611'),
  (7, 'Linda', 'Okafor', '85 Sandpiper Cir', 'Wesley Chapel', '33544'),
  (8, 'Robert', 'Haines', '1209 Cypress Pt', 'Dunedin', '34698'),
  (9, 'Sofia', 'Moretti', '502 Coral Ave', 'Tampa', '33629'),
  (10, 'Grace', 'Liu', '77 Pelican Pl', 'Safety Harbor', '34695'),
  (11, 'Marcus', 'Bell', '2840 Magnolia Rd', 'Riverview', '33569'),
  (12, 'Ellen', 'Fischer', '415 Osprey Ln', 'Odessa', '33556'),
  (13, 'Andre', 'Dubois', '1902 Seagrape Dr', 'St. Petersburg', '33704'),
  (14, 'Hannah', 'Brooks', '33 Egret St', 'Tampa', '33609'),
  (15, 'Carlos', 'Mendez', '761 Banyan Blvd', 'Largo', '33771'),
  (16, 'Janet', 'Sullivan', '1488 Tarpon Way', 'Palm Harbor', '34683'),
  (17, 'Omar', 'Haddad', '209 Citrus Park Dr', 'Tampa', '33625'),
  (18, 'Beth', 'Lindqvist', '56 Pineapple Ln', 'Apollo Beach', '33572');

-- theme picks the visit story; visits is how many past visits; kg is weight.
create temp table zp_pets (k int, owner int, name text, species species, breed text, sex sex, dob date,
                           color text, theme text, visits int, kg numeric) on commit drop;
insert into zp_pets values
  (1, 1, 'Luna', 'canine', 'Labrador Retriever', 'female_spayed', date '2013-05-02', 'Yellow', 'arthritis', 5, 31.5),
  (2, 1, 'Mango', 'feline', 'Domestic Shorthair', 'male_neutered', date '2019-08-14', 'Orange tabby', 'wellness', 1, 5.4),
  (3, 2, 'Duke', 'canine', 'German Shepherd', 'male_neutered', date '2014-01-20', 'Black and tan', 'arthritis', 4, 36.8),
  (4, 3, 'Chai', 'feline', 'Siamese', 'female_spayed', date '2009-11-03', 'Seal point', 'ckd', 4, 3.6),
  (5, 3, 'Ginger', 'feline', 'Domestic Longhair', 'female_spayed', date '2015-04-18', 'Calico', 'gi', 2, 4.9),
  (6, 4, 'Oscar', 'canine', 'Dachshund', 'male_neutered', date '2018-02-11', 'Red', 'ivdd', 5, 9.1),
  (7, 5, 'Bella', 'canine', 'Golden Retriever', 'female_spayed', date '2012-09-09', 'Golden', 'hospice', 3, 27.2),
  (8, 6, 'Kona', 'canine', 'Australian Shepherd', 'male', date '2020-06-30', 'Blue merle', 'seizure', 3, 22.4),
  (9, 6, 'Pip', 'rabbit', 'Holland Lop', 'female_spayed', date '2021-03-12', 'Broken orange', 'wellness', 1, 1.8),
  (10, 7, 'Max', 'canine', 'Labrador Retriever', 'male_neutered', date '2019-07-04', 'Chocolate', 'rehab', 4, 34.0),
  (11, 8, 'Biscuit', 'canine', 'Cavalier King Charles Spaniel', 'female_spayed', date '2016-12-01', 'Blenheim', 'allergy', 2, 8.3),
  (12, 9, 'Nico', 'canine', 'Italian Greyhound', 'male_neutered', date '2017-10-22', 'Fawn', 'anxiety', 2, 6.0),
  (13, 9, 'Stella', 'feline', 'Maine Coon', 'female_spayed', date '2011-02-14', 'Brown tabby', 'arthritis', 3, 6.7),
  (14, 10, 'Mochi', 'canine', 'Shiba Inu', 'female_spayed', date '2018-05-25', 'Red sesame', 'allergy', 3, 10.2),
  (15, 11, 'Tank', 'canine', 'French Bulldog', 'male_neutered', date '2019-01-16', 'Brindle', 'ivdd', 4, 12.6),
  (16, 12, 'Willow', 'feline', 'Ragdoll', 'female_spayed', date '2008-07-07', 'Blue bicolor', 'ckd', 3, 4.1),
  (17, 12, 'Sage', 'canine', 'Border Collie', 'female_spayed', date '2015-03-03', 'Black and white', 'rehab', 3, 18.5),
  (18, 13, 'Bruno', 'canine', 'Boxer', 'male_neutered', date '2013-08-28', 'Fawn', 'hospice', 2, 29.0),
  (19, 14, 'Penny', 'canine', 'Beagle', 'female_spayed', date '2014-11-11', 'Tricolor', 'arthritis', 3, 13.4),
  (20, 15, 'Rocco', 'canine', 'Pit Bull Terrier', 'male_neutered', date '2016-04-05', 'Blue', 'allergy', 2, 27.9),
  (21, 15, 'Lola', 'feline', 'Domestic Shorthair', 'female_spayed', date '2017-09-19', 'Tortoiseshell', 'anxiety', 2, 4.3),
  (22, 16, 'Winston', 'canine', 'Pembroke Welsh Corgi', 'male_neutered', date '2015-06-21', 'Red and white', 'ivdd', 3, 13.8),
  (23, 17, 'Zara', 'canine', 'Standard Poodle', 'female_spayed', date '2012-12-12', 'Apricot', 'arthritis', 4, 21.3),
  (24, 17, 'Felix', 'feline', 'Domestic Shorthair', 'male_neutered', date '2010-10-10', 'Black and white', 'gi', 3, 5.0),
  (25, 18, 'Hazel', 'canine', 'Golden Retriever', 'female_spayed', date '2021-01-08', 'Golden', 'wellness', 1, 28.1),
  (26, 18, 'Toby', 'canine', 'Miniature Schnauzer', 'male_neutered', date '2011-04-30', 'Salt and pepper', 'seizure', 3, 8.8);

create temp table zp_themes (theme text, svc text, price numeric, s1 text, s2 text, o text, a text, p1 text, p2 text,
                             rx text, rx_dose text, rx_freq text, rx_qty int, rx_note text, reminder text) on commit drop;
insert into zp_themes values
  ('arthritis', 'Acupuncture and laser therapy', 125,
   'Owner reports stiffness rising after rest and reluctance on stairs over the last few months. Still eager on walks but tires after 15 minutes.',
   'Owner reports easier mornings since the last session and more willing to use the stairs. Mild stiffness after long walks.',
   'BAR. Decreased hip extension bilaterally, crepitus both stifles. Muscle tension and trigger points along the lumbar epaxials. Pain score 3/10.',
   'Osteoarthritis, hips and stifles, with secondary myofascial pain.',
   'Dry needle acupuncture: GV20, BL23, BL40, GB30, GB34, ST36, Bai Hui. Class IV laser to hips and stifles. Start joint supplement. Recheck in 2 weeks.',
   'Acupuncture repeated at the same points plus electroacupuncture across the lumbar segment. Laser to hips. Continue home exercises. Recheck in 3 weeks.',
   'Gabapentin', '100 mg', 'Every 12 hours as needed for discomfort', 60, 'May cause sleepiness. Give with food.',
   'Acupuncture recheck'),
  ('ivdd', 'Electroacupuncture', 135,
   'Yelped when picked up two days ago, reluctant to jump on the couch. Restricted at home per previous vet. Eating and urinating normally.',
   'Owner reports no further yelping and walking more confidently. Still on crate rest between short leash walks.',
   'Guarded posture, kyphotic. Pain on palpation T13-L2. Conscious proprioception slightly delayed in both hind limbs. Ambulatory.',
   'Intervertebral disc disease, thoracolumbar, grade 2, conservative management.',
   'Electroacupuncture along the thoracolumbar spine, Hua Tuo Jia Ji points, BL23, GV14, ST36. Strict rest 4 weeks. Recheck in 1 week.',
   'Electroacupuncture repeated. Proprioception improved. Begin gentle controlled leash walks. Recheck in 2 weeks.',
   'Gabapentin', '50 mg', 'Every 8 to 12 hours', 45, 'Continue strict rest. Call if walking gets worse.',
   'Neuro recheck'),
  ('ckd', 'Acupuncture and fluid therapy', 110,
   'Drinking more water and slightly less interested in food. Weight trending down. Vomits hairballs about once a week.',
   'Appetite better on the days after treatment. Owner giving subcutaneous fluids three times a week without trouble.',
   'Quiet, alert. Mild dehydration, about 5 percent. Kidneys small and firm on palpation. Body condition 4/9.',
   'Chronic kidney disease, IRIS stage 2, with reduced appetite.',
   'Acupuncture: BL23, KI3, ST36, GV20. Subcutaneous fluids 100 mL given. Start renal diet transition. Bloodwork submitted.',
   'Acupuncture repeated. Fluids 100 mL. Continue renal diet and home fluids. Recheck kidney values in 3 months.',
   'Mirtazapine transdermal', '2 mg', 'Apply to inner ear once daily', 1, 'Wear gloves when applying. For appetite.',
   'Kidney values recheck'),
  ('anxiety', 'Acupuncture for anxiety', 95,
   'Pacing and panting during thunderstorms and when left alone. Chewed door frame last week.',
   'Owner reports calmer evenings and less pacing during the last storm.',
   'Hypervigilant on arrival, settled after 10 minutes with treats. Physical exam otherwise unremarkable.',
   'Situational anxiety and noise aversion.',
   'Acupuncture: GV20, Yin Tang, HT7, PC6. Start calming herbal blend. Discussed desensitization plan. Recheck in 4 weeks.',
   'Acupuncture repeated. Continue herbal blend and desensitization. Recheck as needed.',
   'Shen Calmer (herbal)', '0.5 g', 'Twice daily with food', 100, 'Herbal formula. Continue during storm season.',
   'Anxiety follow-up'),
  ('rehab', 'Laser and rehabilitation session', 105,
   'Eight weeks after knee surgery (TPLO). Toe-touching on the operated leg and stiff after naps.',
   'Bearing more weight on the operated leg and sitting squarely now. Home exercises going well.',
   'Grade 2/5 lameness right hind. Muscle loss right thigh, 3 cm less than left. Incision well healed. Stifle stable.',
   'Post-operative rehabilitation after right TPLO.',
   'Class IV laser to the stifle. Range of motion and sit-to-stand exercises shown to owner. Recheck in 2 weeks.',
   'Laser repeated. Added cavaletti rails and hill walking. Lameness grade 1/5. Recheck in 3 weeks.',
   'Carprofen', '75 mg', 'Once daily with food', 30, 'Stop and call if vomiting or black stool.',
   'Rehab progress check'),
  ('allergy', 'Integrative dermatology consult', 115,
   'Licking paws and scratching ears for several weeks, worse in summer. Tried an over-the-counter shampoo.',
   'Itching about half of what it was. Paws less red. Owner keeping up with weekly baths.',
   'Interdigital redness all four paws, mild redness in both ear canals, no discharge. Coat otherwise healthy.',
   'Environmental allergic skin disease, seasonal flare.',
   'Started cooling herbal formula and omega-3 fatty acids. Medicated bath weekly. Recheck in 3 weeks.',
   'Continue herbs and fatty acids. Taper itch medication to every other day. Recheck in 6 weeks.',
   'Apoquel', '16 mg', 'Twice daily for 14 days, then once daily', 30, 'Taper as directed.',
   'Skin recheck'),
  ('gi', 'Herbal medicine consult', 90,
   'Vomiting two to three times a week for two months, sometimes after meals. Stool soft.',
   'Vomiting down to once in two weeks. Stool firmer on the new diet.',
   'Thin, body condition 4/9. Mildly thickened intestines on palpation. Hydration normal.',
   'Chronic enteropathy, suspected food responsive.',
   'Diet trial with hydrolyzed protein for 8 weeks. Started digestive herbal formula. Acupuncture ST36, CV12, BL21.',
   'Continue diet trial and herbs. Acupuncture repeated. Recheck in 4 weeks.',
   'Cerenia', '16 mg', 'Once daily as needed for vomiting', 10, 'Give only on days with nausea.',
   'Diet trial recheck'),
  ('seizure', 'Acupuncture, neurologic support', 120,
   'Two seizures last month, each under two minutes. On phenobarbital from the previous vet. Owner keeping a seizure log.',
   'No seizures since the last visit per the owner''s log. Mild hind end weakness in the evenings.',
   'Normal mentation. Cranial nerves normal. Mild ataxia hind limbs. Weight stable.',
   'Idiopathic epilepsy, managed with phenobarbital; acupuncture as support.',
   'Acupuncture: GV20, GV14, Yin Tang, GB20, LIV3. Phenobarbital level drawn. Continue seizure log.',
   'Acupuncture repeated. Phenobarbital level within range. Recheck in 4 weeks.',
   'Phenobarbital', '30 mg', 'Every 12 hours', 60, 'Do not stop suddenly.',
   'Phenobarbital level check'),
  ('hospice', 'Comfort care visit', 140,
   'Slowing down a lot. Sleeps most of the day, sometimes reluctant to eat. Family wants to keep her comfortable at home.',
   'Comfortable most days per the family. Appetite fair with warmed food. Quality of life score 21/30.',
   'Thin, body condition 3/9. Muscle wasting. Mild pain on spinal palpation. Gums pale pink.',
   'Geriatric decline with chronic pain; hospice and comfort care.',
   'Acupuncture for comfort and appetite: GV20, ST36, BL20, BL21. Quality of life scale reviewed with the family. Pain plan started.',
   'Acupuncture repeated. Reviewed quality of life together. Family knows how to reach us any time.',
   'Gabapentin', '300 mg', 'Every 12 hours', 60, 'For comfort. May cause sleepiness.',
   'Comfort care check-in'),
  ('wellness', 'Wellness exam (house call)', 85,
   'Doing well at home. No concerns. Due for a wellness check.',
   'Doing well at home.',
   'Bright and alert. Teeth with mild tartar. Heart and lungs normal. Body condition 5/9.',
   'Healthy adult.',
   'Discussed diet and dental care. Continue current routine. Next wellness exam in 12 months.',
   'Continue current routine.',
   null, null, null, null, null,
   'Annual wellness exam');

do $$
declare
  practice uuid;
  tz text;
  vet uuid;
  vet_name text;
  loc uuid;
  off_hours boolean := current_setting('zp.off_hours') = '1';
  mark text := current_setting('zp.mark');
  -- external ids stay unique even after an earlier load was removed
  batch text := to_char(clock_timestamp(), 'YYYYMMDDHH24MISS');
  today date;
  pp record;
  pt record;
  th record;
  client_id uuid;
  pet_id uuid;
  appt uuid;
  slot timestamptz;
  status appointment_status;
  i int;
  weight numeric;
  inv uuid;
  note uuid;
  type_id uuid;
  ids jsonb := '{"clientIds":[],"patientIds":[],"appointmentIds":[],"soapNoteIds":[],"vaccinationIds":[],"invoiceIds":[],"invoiceItemIds":[],"communicationIds":[]}';
  last_visit uuid;
  last_visit_at timestamptz;
  today_pets int[] := array[1, 6, 16];
  next_pets int[] := array[3, 4, 7, 8, 10, 12, 13, 14, 15, 17, 18, 19, 22, 23, 26];
begin
  perform setseed(0.42);
  select id, coalesce(nullif(timezone, ''), 'America/New_York') into practice, tz
  from practices where deleted_at is null order by created_at limit 1;
  perform pg_advisory_xact_lock(hashtextextended('openvpm:demo-data:' || practice::text, 0));
  select id, name into vet, vet_name from users
  where practice_id = practice and deleted_at is null and role in ('veterinarian', 'admin')
  order by (role = 'veterinarian') desc, created_at limit 1;
  select id into loc from locations where practice_id = practice and deleted_at is null
  order by is_primary desc, created_at limit 1;
  today := (now() at time zone tz)::date;

  -- Visit slots, in the practice's time zone, that the veterinarian has free.
  create temp table zp_slots on commit drop as
  select ((d + t) at time zone tz) as starts, false as used
  from generate_series(today - 240, today + 21, interval '1 day') g(d0)
  cross join lateral (select g.d0::date as d) dd
  cross join unnest(case
      when off_hours and dd.d >= today then array[time '06:00', time '07:00']
      else array[time '09:00', time '10:30', time '13:00', time '14:30', time '16:00'] end) t
  where extract(isodow from dd.d) < 6 or dd.d = today;
  delete from zp_slots s where exists (
    select 1 from appointments a
    where a.practice_id = practice and a.deleted_at is null and a.status <> 'cancelled'
      and (a.doctor_id = vet or a.doctor_id is null)
      and a.start_time < s.starts + interval '60 minutes' and a.end_time > s.starts);

  for pp in select * from zp_people order by n loop
    insert into clients (practice_id, first_name, last_name, email, phone, address, city, state, zip,
                         preferred_contact_method, notes, external_source, external_id, created_at)
    values (practice, pp.first_name, pp.last_name || ' (demo)',
            lower(pp.first_name || '.' || pp.last_name) || '@example.com',
            '(813) 555-01' || lpad(pp.n::text, 2, '0'), pp.street, pp.city, 'FL', pp.zip,
            (array['email','phone','sms','email']::contact_method[])[1 + pp.n % 4],
            'Sample client for demos. Not a real person.', mark, 'client-' || pp.n || '-' || batch,
            now() - interval '250 days' + (pp.n * interval '3 days'))
    returning id into client_id;
    ids := jsonb_set(ids, '{clientIds}', ids->'clientIds' || to_jsonb(client_id::text));

    for pt in select * from zp_pets where owner = pp.n order by k loop
      select * into th from zp_themes where theme = pt.theme;
      select id into type_id from appointment_types
      where practice_id = practice and deleted_at is null
        and name ilike case pt.theme when 'wellness' then '%wellness%' when 'rehab' then '%rehab%'
                                     when 'hospice' then '%comfort%' else '%acupunct%' end
      order by created_at limit 1;

      insert into patients (practice_id, client_id, name, species, breed, sex, dob, color, external_source, external_id, created_at)
      values (practice, client_id, pt.name, pt.species, pt.breed, pt.sex, pt.dob, pt.color, mark, 'pet-' || pt.k || '-' || batch,
              now() - interval '245 days' + (pp.n * interval '3 days'))
      returning id into pet_id;
      ids := jsonb_set(ids, '{patientIds}', ids->'patientIds' || to_jsonb(pet_id::text));

      -- Vaccines on record from the previous clinic.
      if pt.species in ('canine', 'feline') then
        with v as (
          insert into vaccination_records (practice_id, patient_id, vaccine_name, manufacturer, lot_number,
                                           administered_at, next_due_date, dose_type, licensed_duration_months)
          select practice, pet_id, x.name, x.maker, 'DEMO-' || (1000 + pt.k * 7 + x.o), x.given, (x.given + x.months * interval '1 month')::date,
                 'booster', x.months
          from (values
            (1, 'Rabies (3 year)', 'Zoetis', now() - (200 + pt.k * 23) * interval '1 day', 36),
            (2, case when pt.species = 'canine' then 'DHPP' else 'FVRCP' end,
                case when pt.species = 'canine' then 'Merck' else 'Boehringer Ingelheim' end,
                now() - (120 + pt.k * 13) * interval '1 day', 12)
          ) x(o, name, maker, given, months)
          returning id)
        select ids || jsonb_build_object('vaccinationIds', (ids->'vaccinationIds') || coalesce(jsonb_agg(id::text), '[]'))
        into ids from v;
      end if;

      if pt.k in (1, 6, 11) then
        insert into patient_allergies (patient_id, allergen, reaction, severity, noted_by, noted_at)
        values (pet_id, (array['Chicken','Meloxicam','Bee stings'])[1 + pt.k % 3],
                (array['Itchy skin and ear flares','Vomiting','Facial swelling'])[1 + pt.k % 3], 'moderate', vet, now() - interval '200 days');
      end if;

      -- Past house calls, a few weeks apart, ending in the last month or so.
      last_visit := null;
      for i in 1..pt.visits loop
        select starts into slot from zp_slots
        where not used and starts < now() - interval '2 hours' and starts::date < today
        order by abs(extract(epoch from starts - (now() - ((pt.visits - i) * 21 + 6 + pt.k % 9) * interval '1 day')))
        limit 1;
        update zp_slots set used = true where starts = slot;
        status := case when (pt.k + i) % 13 = 0 then 'cancelled' when (pt.k + i) % 17 = 0 then 'no_show'
                       else 'checked_out' end;
        insert into appointments (practice_id, location_id, client_id, patient_id, doctor_id, type_id,
                                  start_time, end_time, status, origin, notes, created_at)
        values (practice, loc, client_id, pet_id, vet, type_id, slot, slot + interval '60 minutes', status, 'field',
                case when i = 1 then 'New patient: ' else 'Follow-up: ' end || lower(th.svc) || ' at home',
                slot - interval '10 days')
        returning id into appt;
        ids := jsonb_set(ids, '{appointmentIds}', ids->'appointmentIds' || to_jsonb(appt::text));
        continue when status <> 'checked_out';

        weight := round(pt.kg * (1 + ((pt.k * 7 + i * 3) % 7 - 3) / 100.0), 1);
        insert into patient_weights (patient_id, weight_kg, recorded_at, recorded_by)
        values (pet_id, weight, slot + interval '10 minutes', vet);

        insert into soap_notes (practice_id, patient_id, appointment_id, author_id, author_name,
                                subjective, objective, assessment, plan, status,
                                finalized_at, finalized_by, finalizer_name, created_at)
        values (practice, pet_id, appt, vet, vet_name,
                case when i = 1 then th.s1 else th.s2 end,
                'Weight ' || weight || ' kg. ' || th.o, th.a,
                case when i = 1 then th.p1 else th.p2 end, 'finalized',
                slot + interval '75 minutes', vet, vet_name, slot + interval '15 minutes')
        returning id into note;
        ids := jsonb_set(ids, '{soapNoteIds}', ids->'soapNoteIds' || to_jsonb(note::text));

        -- Invoice: house call fee plus the treatment. The most recent few are still open.
        insert into invoices (practice_id, client_id, patient_id, appointment_id, status, subtotal, tax, total,
                              paid_amount, due_date, created_at)
        values (practice, client_id, pet_id, appt,
                case when i < pt.visits or slot < now() - interval '40 days' or pt.k % 3 <> 0 then 'paid'
                     when slot < now() - interval '30 days' then 'overdue' else 'sent' end::invoice_status,
                th.price + 65, 0, th.price + 65,
                case when i < pt.visits or slot < now() - interval '40 days' or pt.k % 3 <> 0 then th.price + 65 else 0 end,
                (slot + interval '30 days')::date, slot + interval '80 minutes')
        returning id into inv;
        ids := jsonb_set(ids, '{invoiceIds}', ids->'invoiceIds' || to_jsonb(inv::text));
        with it as (
          insert into invoice_items (invoice_id, description, quantity, unit_price, total, item_type, taxable, created_at)
          values (inv, 'House call fee', 1, 65, 65, 'service', false, slot + interval '80 minutes'),
                 (inv, th.svc, 1, th.price, th.price, 'service', false, slot + interval '80 minutes')
          returning id)
        select ids || jsonb_build_object('invoiceItemIds', (ids->'invoiceItemIds') || jsonb_agg(id::text)) into ids from it;

        last_visit := appt;
        last_visit_at := slot;
        if i = 1 and th.rx is not null then
          insert into prescriptions (practice_id, patient_id, appointment_id, medication_name, dosage, frequency, quantity,
                                     refills_remaining, prescribed_by, start_date, end_date, status, instructions, created_at)
          values (practice, pet_id, appt, th.rx, th.rx_dose, th.rx_freq, th.rx_qty, 2, vet, slot::date,
                  (slot + interval '180 days')::date,
                  case when slot + interval '180 days' < now() then 'completed' else 'active' end::prescription_status,
                  th.rx_note, slot + interval '70 minutes');
        end if;
      end loop;

      -- Lab work for the kidney cats, seizure dogs and one senior dog.
      if last_visit is not null and pt.theme in ('ckd', 'seizure') or pt.k = 1 then
        insert into lab_results (practice_id, patient_id, appointment_id, test_name, result_value, unit,
                                 reference_range_low, reference_range_high, status, result_flag, ordered_by,
                                 completed_at, reviewed_at, reviewed_by, created_at)
        select practice, pet_id, last_visit, x.test, x.val, x.unit, x.lo, x.hi,
               case when pt.k = 1 then 'completed' else 'reviewed' end::lab_status,
               x.flag::lab_result_flag, vet, last_visit_at + interval '1 day',
               case when pt.k = 1 then null else last_visit_at + interval '2 days' end,
               case when pt.k = 1 then null else vet end, last_visit_at + interval '20 minutes'
        from (values
          ('ckd', 'Creatinine', case when pt.k = 4 then '2.2' else '3.1' end, 'mg/dL', 0.8, 2.4, case when pt.k = 4 then 'normal' else 'abnormal' end),
          ('ckd', 'SDMA', (16 + pt.k % 5)::text, 'ug/dL', 0, 14, 'abnormal'),
          ('ckd', 'Urine specific gravity', '1.018', null, 1.035, 1.060, 'abnormal'),
          ('seizure', 'Phenobarbital level', (24 + pt.k % 6)::text, 'ug/mL', 15, 40, 'normal'),
          ('seizure', 'ALT', (60 + pt.k * 2)::text, 'U/L', 10, 125, 'normal'),
          ('arthritis', 'ALT', '64', 'U/L', 10, 125, 'normal'),
          ('arthritis', 'Creatinine', '1.3', 'mg/dL', 0.5, 1.8, 'normal')
        ) x(theme, test, val, unit, lo, hi, flag)
        where x.theme = pt.theme;
      end if;

      if th.reminder is not null and pt.visits > 1 or pt.theme = 'wellness' then
        insert into care_reminders (practice_id, patient_id, title, due_date, created_by, notes)
        values (practice, pet_id, th.reminder,
                today + case when pt.theme = 'wellness' then 300 else 10 + pt.k % 25 end - case when pt.k % 7 = 0 then 40 else 0 end,
                vet, 'Sample reminder.');
      end if;

      -- Visits today, and over the next three weeks.
      if pt.k = any(today_pets) or pt.k = any(next_pets) then
        select starts into slot from zp_slots
        where not used and case when pt.k = any(today_pets) then starts::date = today
                                else starts::date > today end
        order by case when pt.k = any(today_pets) then 0 else abs(extract(epoch from starts - (now() + (1 + pt.k % 20) * interval '1 day'))) end,
                 starts
        limit 1;
        if slot is not null then
          update zp_slots set used = true where starts = slot;
          status := case when slot + interval '60 minutes' < now() then 'checked_out'
                         when slot < now() + interval '3 days' then 'confirmed' else 'scheduled' end;
          insert into appointments (practice_id, location_id, client_id, patient_id, doctor_id, type_id,
                                    start_time, end_time, status, origin, notes, created_at)
          values (practice, loc, client_id, pet_id, vet, type_id, slot, slot + interval '60 minutes', status, 'field',
                  'Follow-up: ' || lower(th.svc) || ' at home', now() - interval '12 days')
          returning id into appt;
          ids := jsonb_set(ids, '{appointmentIds}', ids->'appointmentIds' || to_jsonb(appt::text));
          if status = 'checked_out' then
            insert into soap_notes (practice_id, patient_id, appointment_id, author_id, author_name,
                                    subjective, objective, assessment, plan, status,
                                    finalized_at, finalized_by, finalizer_name, created_at)
            values (practice, pet_id, appt, vet, vet_name, th.s2, 'Weight ' || pt.kg || ' kg. ' || th.o, th.a, th.p2,
                    'finalized', slot + interval '75 minutes', vet, vet_name, slot + interval '15 minutes')
            returning id into note;
            ids := jsonb_set(ids, '{soapNoteIds}', ids->'soapNoteIds' || to_jsonb(note::text));
          end if;
          if status = 'confirmed' then
            with c as (
              insert into communications (practice_id, client_id, channel, direction, subject, content, status, created_at)
              values (practice, client_id, 'email', 'outbound', 'Reminder: ' || pt.name || '''s house call',
                      'Hi ' || pp.first_name || ', this is a reminder that Dr. ' ||
                      regexp_replace(split_part(regexp_replace(vet_name, '^Dr\.?\s+', ''), ',', 1), '^.*\s', '') || ' will visit ' ||
                      pt.name || ' on ' || to_char(slot at time zone tz, 'FMDay, FMMonth FMDD "at" FMHH12:MI AM') || '.',
                      'delivered', now() - interval '1 day')
              returning id)
            select ids || jsonb_build_object('communicationIds', (ids->'communicationIds') || jsonb_agg(id::text)) into ids from c;
          end if;
        end if;
      end if;
    end loop;
  end loop;

  -- A few client messages waiting in the inbox, two of them unread.
  with c as (
    insert into communications (practice_id, client_id, channel, direction, subject, content, status, read_at, created_at)
    select practice, cl.id, m.channel::comm_channel, 'inbound', m.subject, m.body, 'delivered', m.read_at, m.at
    from (values
      ('client-3', 'portal', 'Chai''s appetite', 'Chai ate a full meal this morning for the first time in a week! Should we keep the fluids at three times a week?', null::timestamptz, now() - interval '3 hours'),
      ('client-5', 'portal', 'Bella', 'Bella had a rough night, panting and restless. Is it OK to give the gabapentin a bit early?', null, now() - interval '50 minutes'),
      ('client-11', 'sms', null, 'Tank is walking so much better. Thank you! See you next week.', now() - interval '1 day', now() - interval '1 day 2 hours'),
      ('client-9', 'email', 'Storm season', 'Nico did great during the last storm with the herbs. Can we get a refill before we run out?', now() - interval '2 days', now() - interval '2 days 4 hours'),
      ('client-17', 'portal', 'Felix diet trial', 'Felix has not vomited in 10 days on the new food. Can he have treats?', now() - interval '4 days', now() - interval '4 days 1 hour')
    ) m(ext, channel, subject, body, read_at, at)
    join clients cl on cl.external_source = mark and cl.external_id = m.ext || '-' || batch and cl.practice_id = practice
    returning id)
  select ids || jsonb_build_object('communicationIds', (ids->'communicationIds') || jsonb_agg(id::text)) into ids from c;

  -- Register everything as the practice's sample data, merged with any earlier
  -- sample data, so the app can remove it and skips it for reminders.
  update practices p set settings = coalesce(p.settings, '{}'::jsonb) || jsonb_build_object('demoData',
    (select jsonb_object_agg(k.key, coalesce(p.settings->'demoData'->k.key, '[]'::jsonb) || k.value) from jsonb_each(ids) k)
    || jsonb_build_object(
      'problemIds', coalesce(p.settings->'demoData'->'problemIds', '[]'::jsonb),
      'productIds', coalesce(p.settings->'demoData'->'productIds', '[]'::jsonb),
      'clearedAt', null))
  where p.id = practice;
end $$;
commit;
SQL

"${PSQL[@]}" -F ' ' <<SQL
select 'Loaded', count(*), 'households,' from clients where external_source = '$MARK' and deleted_at is null;
select '      ', count(*), 'pets,' from patients where external_source = '$MARK' and deleted_at is null;
select '      ', count(*), 'visits (' || count(*) filter (where a.start_time::date >= current_date) || ' today or upcoming).'
  from appointments a join clients c on c.id = a.client_id where c.external_source = '$MARK' and a.deleted_at is null;
SQL
cat <<MSG

Open the app: $APP  (Schedule, Clients, Messages, Billing)
Remove it any time: Settings > Data > "Remove sample data", or
  sudo bash /opt/openvpm/deploy/zenpaws/load-sample-practice.sh --remove
MSG
