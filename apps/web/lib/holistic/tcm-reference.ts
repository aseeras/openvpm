/**
 * Reference material for the holistic (TCVM) workup: veterinary acupoints,
 * common patterns, classical herbal formulas, and food energetics.
 *
 * The AI workup is grounded in this list. Acupoints it suggests are checked
 * against ACUPOINTS and dropped when unknown, so a clinician never sees an
 * invented point. Formulas outside HERBAL_FORMULAS are kept but flagged as
 * unverified. Locations are canine transpositional unless noted; they are a
 * memory aid, not a substitute for the clinician's training.
 */

export type Modality = "acupuncture" | "laser" | "exercise" | "herbs" | "food";

export const MODALITIES: ReadonlyArray<{ id: Modality; label: string }> = [
  { id: "acupuncture", label: "Acupuncture" },
  { id: "laser", label: "Laser therapy" },
  { id: "exercise", label: "Therapeutic exercise" },
  { id: "herbs", label: "Chinese herbal medicine" },
  { id: "food", label: "Food therapy" },
];

export interface Acupoint {
  code: string;
  name: string;
  location: string;
  actions: string;
  /** Avoid or use with care in pregnancy. */
  pregnancyCaution?: boolean;
}

export const ACUPOINTS: readonly Acupoint[] = [
  // Lung / Large Intestine
  { code: "LU-7", name: "Lie Que", location: "Medial forearm, just proximal to the radial styloid", actions: "Cough, neck and head conditions, releases the exterior" },
  { code: "LI-4", name: "He Gu", location: "Between the first and second metacarpals (dewclaw area)", actions: "Analgesia, face and mouth, immune support, wind", pregnancyCaution: true },
  { code: "LI-10", name: "Shou San Li", location: "Lateral forearm, 2 cun distal to LI-11", actions: "Forelimb pain or weakness, GI support, immune" },
  { code: "LI-11", name: "Qu Chi", location: "Lateral end of the cubital crease with the elbow flexed", actions: "Clears heat, pruritus, immune, elbow and forelimb pain" },
  { code: "LI-15", name: "Jian Yu", location: "Cranial and distal to the acromion", actions: "Shoulder pain and lameness" },
  { code: "LI-20", name: "Ying Xiang", location: "Lateral to the nostril", actions: "Nasal congestion, rhinitis" },
  // Stomach / Spleen
  { code: "ST-25", name: "Tian Shu", location: "2 cun lateral to the umbilicus", actions: "Large Intestine alarm point; diarrhea, constipation" },
  { code: "ST-35", name: "Du Bi", location: "Lateral to the patellar ligament (lateral eye of the stifle)", actions: "Stifle pain" },
  { code: "ST-36", name: "Zu San Li", location: "Lateral to the tibial crest, 3 cun distal to ST-35", actions: "Master point for GI, tonifies Qi and Blood, immune, hindlimb weakness" },
  { code: "ST-37", name: "Shang Ju Xu", location: "3 cun distal to ST-36", actions: "Lower sea point of Large Intestine; colitis, diarrhea" },
  { code: "ST-40", name: "Feng Long", location: "Lateral leg, midway between the stifle and the lateral malleolus", actions: "Resolves phlegm and damp, cough, lipomas" },
  { code: "ST-44", name: "Nei Ting", location: "Between the second and third digits of the hind paw", actions: "Clears Stomach heat, gingivitis, digit pain" },
  { code: "SP-3", name: "Tai Bai", location: "Medial hind paw, proximal to the second metatarsophalangeal joint", actions: "Tonifies Spleen, resolves damp" },
  { code: "SP-6", name: "San Yin Jiao", location: "3 cun proximal to the medial malleolus, caudal border of the tibia", actions: "Tonifies Spleen, Liver, and Kidney Yin; GI, urinary, reproductive", pregnancyCaution: true },
  { code: "SP-9", name: "Yin Ling Quan", location: "Medial tibia, in the depression distal to the medial condyle", actions: "Resolves damp, urinary, stifle" },
  { code: "SP-10", name: "Xue Hai", location: "Medial thigh, 2 cun proximal to the patella", actions: "Cools and moves Blood; pruritus, skin disease" },
  // Heart / Pericardium / Small Intestine / Triple Heater
  { code: "HT-7", name: "Shen Men", location: "Caudolateral carpus, at the crease next to the accessory carpal bone", actions: "Calms Shen; anxiety, restlessness, sleep" },
  { code: "PC-6", name: "Nei Guan", location: "Medial forearm, 2 cun proximal to the carpal crease between the flexor tendons", actions: "Nausea, vomiting, calming, chest and heart" },
  { code: "SI-3", name: "Hou Xi", location: "Lateral forepaw, proximal to the fifth metacarpophalangeal joint", actions: "Neck and back pain, opens the Governing Vessel" },
  { code: "SI-9", name: "Jian Zhen", location: "Caudal to the shoulder, in the depression caudal to the deltoid", actions: "Shoulder and forelimb pain" },
  { code: "TH-5", name: "Wai Guan", location: "Lateral forearm, 2 cun proximal to the carpal crease between radius and ulna", actions: "Releases the exterior, forelimb pain, ear" },
  { code: "TH-17", name: "Yi Feng", location: "Caudal to the ear base, in the depression behind the mandible", actions: "Ear disease, facial paralysis" },
  // Bladder
  { code: "BL-10", name: "Tian Zhu", location: "Dorsal neck, caudal to the occiput lateral to the midline", actions: "Neck pain and stiffness" },
  { code: "BL-11", name: "Da Zhu", location: "1.5 cun lateral to the dorsal midline at T1", actions: "Influential point for bone; arthritis, cervical pain" },
  { code: "BL-13", name: "Fei Shu", location: "1.5 cun lateral to the dorsal midline at T3", actions: "Lung association point; cough, respiratory, skin" },
  { code: "BL-14", name: "Jue Yin Shu", location: "1.5 cun lateral to the dorsal midline at T4", actions: "Pericardium association point; calming" },
  { code: "BL-15", name: "Xin Shu", location: "1.5 cun lateral to the dorsal midline at T5", actions: "Heart association point; anxiety, heart" },
  { code: "BL-17", name: "Ge Shu", location: "1.5 cun lateral to the dorsal midline at T7", actions: "Influential point for Blood; anemia, skin, hiccups" },
  { code: "BL-18", name: "Gan Shu", location: "1.5 cun lateral to the dorsal midline at T10", actions: "Liver association point; eyes, tendons, Liver Qi stagnation" },
  { code: "BL-19", name: "Dan Shu", location: "1.5 cun lateral to the dorsal midline at T11", actions: "Gallbladder association point" },
  { code: "BL-20", name: "Pi Shu", location: "1.5 cun lateral to the dorsal midline at T12", actions: "Spleen association point; appetite, diarrhea, Qi deficiency" },
  { code: "BL-21", name: "Wei Shu", location: "1.5 cun lateral to the dorsal midline at T13", actions: "Stomach association point; vomiting, appetite" },
  { code: "BL-22", name: "San Jiao Shu", location: "1.5 cun lateral to the dorsal midline at L1", actions: "Triple Heater association point; fluid metabolism" },
  { code: "BL-23", name: "Shen Shu", location: "1.5 cun lateral to the dorsal midline at L2", actions: "Kidney association point; Kidney deficiency, back pain, urinary, hindlimb weakness" },
  { code: "BL-25", name: "Da Chang Shu", location: "1.5 cun lateral to the dorsal midline at L5", actions: "Large Intestine association point; colitis, constipation, low back pain" },
  { code: "BL-26", name: "Guan Yuan Shu", location: "1.5 cun lateral to the dorsal midline at L6", actions: "Lumbar pain, reproductive" },
  { code: "BL-28", name: "Pang Guang Shu", location: "Lateral to the median sacral crest at the second sacral foramen", actions: "Bladder association point; urinary incontinence, cystitis" },
  { code: "BL-40", name: "Wei Zhong", location: "Center of the popliteal crease", actions: "Back and hindlimb pain, clears heat from skin" },
  { code: "BL-54", name: "Zhi Bian", location: "Between the greater trochanter and the ischiatic tuberosity", actions: "Hip pain, hindlimb paresis" },
  { code: "BL-60", name: "Kun Lun", location: "Between the lateral malleolus and the calcaneal tendon", actions: "Analgesia, back and hindlimb pain", pregnancyCaution: true },
  { code: "BL-62", name: "Shen Mai", location: "Distal to the lateral malleolus", actions: "Back pain, calming, opens the Yang Qiao vessel" },
  { code: "BL-67", name: "Zhi Yin", location: "Lateral aspect of the fifth digit of the hind paw at the nail bed", actions: "Head and eye conditions, malpresentation", pregnancyCaution: true },
  // Kidney
  { code: "KID-1", name: "Yong Quan", location: "Under the metatarsal pad of the hind paw", actions: "Revival point, calming, cools heat" },
  { code: "KID-3", name: "Tai Xi", location: "Between the medial malleolus and the calcaneal tendon", actions: "Source point; tonifies Kidney Yin and Yang, hindlimb weakness" },
  { code: "KID-6", name: "Zhao Hai", location: "Distal to the medial malleolus", actions: "Nourishes Yin, calming, throat dryness" },
  { code: "KID-7", name: "Fu Liu", location: "2 cun proximal to KID-3, cranial to the calcaneal tendon", actions: "Tonifies Kidney, regulates sweating and fluids, edema" },
  { code: "KID-27", name: "Shu Fu", location: "Ventral chest, between the manubrium and first rib", actions: "Cough, dyspnea" },
  // Gallbladder / Liver
  { code: "GB-20", name: "Feng Chi", location: "Depression caudal to the occiput between the brachiocephalicus and splenius", actions: "Expels wind, neck pain, eyes, headache, vestibular" },
  { code: "GB-21", name: "Jian Jing", location: "Cranial to the scapula, midway between the dorsal midline and the acromion", actions: "Neck and shoulder pain", pregnancyCaution: true },
  { code: "GB-29", name: "Ju Liao", location: "Cranial to the greater trochanter", actions: "Hip pain, hip dysplasia" },
  { code: "GB-30", name: "Huan Tiao", location: "Craniodorsal to the greater trochanter", actions: "Hip pain, hindlimb paresis" },
  { code: "GB-34", name: "Yang Ling Quan", location: "Cranial and distal to the head of the fibula", actions: "Influential point for tendons and ligaments; stifle, Liver Qi stagnation" },
  { code: "GB-39", name: "Xuan Zhong", location: "3 cun proximal to the lateral malleolus, cranial border of the fibula", actions: "Influential point for marrow; neck pain, anemia" },
  { code: "LIV-3", name: "Tai Chong", location: "Dorsal hind paw, between the second and third metatarsals proximally", actions: "Moves Liver Qi, calming, eyes, pain" },
  { code: "LIV-13", name: "Zhang Men", location: "Free end of the 11th rib", actions: "Spleen alarm point, influential point for Zang organs" },
  { code: "LIV-14", name: "Qi Men", location: "Sixth intercostal space ventral to the costochondral junction", actions: "Liver alarm point; Liver Qi stagnation" },
  // Governing and Conception Vessels
  { code: "GV-1", name: "Hou Hai", location: "Between the anus and the base of the tail", actions: "Diarrhea, rectal prolapse, tail paralysis" },
  { code: "GV-4", name: "Ming Men", location: "Dorsal midline between L2 and L3", actions: "Tonifies Kidney Yang, back pain" },
  { code: "GV-14", name: "Da Zhui", location: "Dorsal midline between C7 and T1", actions: "Clears heat, immune, fever, neck pain" },
  { code: "GV-20", name: "Bai Hui", location: "Dorsal midline of the head, on a line joining the cranial ear margins", actions: "Calms Shen, raises Yang, seizures, cognition" },
  { code: "GV-26", name: "Ren Zhong", location: "Nasal philtrum, ventral to the nostrils", actions: "Emergency revival point, shock" },
  { code: "CV-4", name: "Guan Yuan", location: "Ventral midline, 3 cun caudal to the umbilicus", actions: "Small Intestine alarm point; tonifies Yuan Qi, urinary, reproductive" },
  { code: "CV-6", name: "Qi Hai", location: "Ventral midline, 1.5 cun caudal to the umbilicus", actions: "Tonifies Qi, weakness" },
  { code: "CV-12", name: "Zhong Wan", location: "Ventral midline, midway between the umbilicus and the xiphoid", actions: "Stomach alarm point; vomiting, appetite, damp" },
  { code: "CV-17", name: "Shan Zhong", location: "Ventral midline at the fourth intercostal space", actions: "Pericardium alarm point, influential point for Qi; cough, chest" },
  // Classical veterinary points
  { code: "Bai-hui", name: "Bai Hui (lumbosacral)", location: "Dorsal midline at the lumbosacral space, between L7 and S1", actions: "Hindlimb paresis, back pain, tonifies Yang" },
  { code: "Shen-shu", name: "Shen Shu (classical)", location: "1.5 cun lateral to Bai-hui", actions: "Kidney support, hindlimb weakness" },
  { code: "Shen-peng", name: "Shen Peng", location: "1.5 cun cranial to Shen-shu", actions: "Hindlimb weakness, lumbar pain" },
  { code: "Shen-jiao", name: "Shen Jiao", location: "1.5 cun caudal to Shen-shu", actions: "Hindlimb weakness, lumbosacral pain" },
  { code: "Hua-tuo-jia-ji", name: "Hua Tuo Jia Ji", location: "Paravertebral points 0.5 cun lateral to the dorsal midline, T1 through L7", actions: "Spinal pain, IVDD, paresis at the affected segments" },
  { code: "Jing-jia-ji", name: "Jing Jia Ji", location: "Lateral cervical points over the cervical vertebrae", actions: "Neck pain, cervical spondylomyelopathy" },
  { code: "An-shen", name: "An Shen", location: "Midway between GB-20 and TH-17", actions: "Calming, insomnia, anxiety, seizures" },
  { code: "Da-feng-men", name: "Da Feng Men", location: "Dorsal midline of the head at the external sagittal crest, rostral to the occiput", actions: "Expels wind; seizures, vestibular disease" },
  { code: "Er-jian", name: "Er Jian", location: "Tip of the ear (bled with a needle)", actions: "Clears heat, fever, heat stroke, pruritus" },
  { code: "Wei-jian", name: "Wei Jian", location: "Tip of the tail", actions: "Clears heat, fever, revival" },
  { code: "Liu-feng", name: "Liu Feng", location: "Interdigital webs of the hind paw", actions: "Digit pain, hindlimb paresis, interdigital dermatitis" },
  { code: "Yin-tang", name: "Yin Tang", location: "Dorsal midline between the eyes", actions: "Calming, anxiety, nasal congestion" },
];

const ACUPOINT_INDEX = new Map(
  ACUPOINTS.map((point) => [normalizePointCode(point.code), point]),
);

/** Normalize "st36", "ST 36", "St-36", "Bai Hui" to one comparable key. */
export function normalizePointCode(code: string): string {
  const compact = code.trim().toUpperCase().replace(/[\s_.]+/g, "-");
  const meridian = compact.match(/^(LU|LI|ST|SP|HT|SI|BL|KID|KI|PC|TH|TE|SJ|GB|LIV|LR|GV|CV)-?(\d{1,2})$/);
  if (!meridian) return compact;
  const aliases: Record<string, string> = {
    KI: "KID",
    TE: "TH",
    SJ: "TH",
    LR: "LIV",
  };
  const channel = aliases[meridian[1]!] ?? meridian[1]!;
  return `${channel}-${Number(meridian[2])}`;
}

export function findAcupoint(code: string): Acupoint | undefined {
  return ACUPOINT_INDEX.get(normalizePointCode(code));
}

export interface HerbalFormula {
  name: string;
  /** Pinyin name; the match key. */
  aliases?: string[];
  pattern: string;
  uses: string;
  cautions?: string;
}

export const HERBAL_FORMULAS: readonly HerbalFormula[] = [
  { name: "Du Huo Ji Sheng Tang", pattern: "Wind-Cold-Damp Bi with Liver and Kidney deficiency", uses: "Chronic osteoarthritis, stiffness worse in cold and damp weather" },
  { name: "Bu Yang Huan Wu Tang", pattern: "Qi deficiency with Blood stagnation (Wei syndrome)", uses: "Hindlimb paresis, IVDD recovery, degenerative myelopathy support", cautions: "Contains blood-moving herbs; caution with anticoagulants, NSAIDs, before surgery" },
  { name: "Shen Tong Zhu Yu Tang", pattern: "Qi and Blood stagnation", uses: "Acute or chronic back pain, post-trauma pain", cautions: "Blood-moving; avoid in pregnancy, caution with anticoagulants" },
  { name: "You Gui Wan", pattern: "Kidney Yang deficiency", uses: "Geriatric hindlimb weakness, cold-seeking, urinary incontinence" },
  { name: "Jin Gui Shen Qi Wan", pattern: "Kidney Qi and Yang deficiency", uses: "Polyuria, incontinence, weakness in older animals" },
  { name: "Liu Wei Di Huang Wan", pattern: "Kidney Yin deficiency", uses: "Heat-seeking cool surfaces, night panting, early chronic kidney disease, older cats" },
  { name: "Zhi Bai Di Huang Wan", pattern: "Kidney Yin deficiency with deficient heat", uses: "Yin deficiency with heat signs, hyperthyroid-type presentations" },
  { name: "Xiao Yao San", pattern: "Liver Qi stagnation with Spleen deficiency", uses: "Stress-related GI upset, irritability, behavior" },
  { name: "Chai Hu Shu Gan San", pattern: "Liver Qi stagnation", uses: "Irritability, aggression, flank pain, stress" },
  { name: "Tian Ma Gou Teng Yin", pattern: "Liver Yang rising, internal Liver Wind", uses: "Seizures, vestibular episodes, hypertension-type presentations", cautions: "Adjunct only; do not change anticonvulsant drugs without the prescribing vet" },
  { name: "Si Jun Zi Tang", pattern: "Spleen Qi deficiency", uses: "Poor appetite, soft stool, fatigue" },
  { name: "Shen Ling Bai Zhu San", pattern: "Spleen Qi deficiency with damp", uses: "Chronic soft stool or diarrhea, weight loss" },
  { name: "Bu Zhong Yi Qi Tang", pattern: "Spleen Qi deficiency with sinking Qi", uses: "Prolapse, incontinence, chronic fatigue" },
  { name: "Bai Tou Weng Tang", pattern: "Damp-Heat in the Large Intestine", uses: "Acute colitis with mucus or blood, tenesmus" },
  { name: "Bao He Wan", pattern: "Food stagnation", uses: "Dietary indiscretion, bloating, foul breath" },
  { name: "Ping Wei San", pattern: "Damp accumulation in the Spleen and Stomach", uses: "Nausea, poor appetite, greasy tongue coat" },
  { name: "Gui Pi Tang", pattern: "Heart and Spleen Qi and Blood deficiency", uses: "Anxiety, poor sleep, poor appetite, pale tongue" },
  { name: "Tian Wang Bu Xin Dan", pattern: "Heart Yin deficiency", uses: "Night restlessness, anxiety in older animals, cognitive decline" },
  { name: "Si Wu Tang", pattern: "Blood deficiency", uses: "Dry coat, dandruff, pale tongue, post-illness recovery" },
  { name: "Ba Zhen Tang", pattern: "Qi and Blood deficiency", uses: "Weakness, anemia support, post-surgical recovery" },
  { name: "Xiao Feng San", pattern: "Wind-Heat or Damp-Heat in the skin", uses: "Acute pruritus, allergic dermatitis, red skin" },
  { name: "Long Dan Xie Gan Tang", pattern: "Liver and Gallbladder Damp-Heat", uses: "Otitis externa, hot moist skin, urinary damp-heat", cautions: "Cold and draining; short courses only, avoid in Spleen deficiency" },
  { name: "Ba Zheng San", pattern: "Damp-Heat in the Bladder", uses: "Cystitis, urinary crystals with heat signs" },
  { name: "Bu Fei Tang", pattern: "Lung Qi deficiency", uses: "Chronic weak cough, exercise intolerance" },
  { name: "Mai Men Dong Tang", pattern: "Lung and Stomach Yin deficiency", uses: "Dry non-productive cough, collapsing trachea support" },
  { name: "Er Chen Tang", pattern: "Damp-Phlegm", uses: "Productive cough, lipomas, phlegm accumulation" },
  { name: "Yin Qiao San", pattern: "Exterior Wind-Heat", uses: "Acute upper respiratory signs with fever" },
  { name: "Gui Zhi Tang", pattern: "Exterior Wind-Cold with deficiency", uses: "Mild acute illness in weak or older patients" },
  { name: "Wei Qi Booster (Yu Ping Feng San)", aliases: ["Yu Ping Feng San"], pattern: "Wei Qi deficiency", uses: "Recurrent infections, immune support" },
  { name: "Di Tan Tang", pattern: "Phlegm misting the Heart", uses: "Cognitive dysfunction, disorientation" },
];

const FORMULA_INDEX = new Map<string, HerbalFormula>();
for (const formula of HERBAL_FORMULAS) {
  FORMULA_INDEX.set(normalizeFormulaName(formula.name), formula);
  for (const alias of formula.aliases ?? []) {
    FORMULA_INDEX.set(normalizeFormulaName(alias), formula);
  }
}

export function normalizeFormulaName(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, "");
}

export function findFormula(name: string): HerbalFormula | undefined {
  return FORMULA_INDEX.get(normalizeFormulaName(name));
}

export type FoodEnergy = "hot" | "warm" | "neutral" | "cool" | "cold";

/**
 * Food energetics as commonly taught in TCVM food therapy. Sources differ on
 * a few items; these are starting points the clinician adjusts.
 */
export const FOOD_ENERGETICS: ReadonlyArray<{
  food: string;
  energy: FoodEnergy;
  kind: "protein" | "grain" | "vegetable" | "fruit" | "other";
}> = [
  { food: "Lamb", energy: "hot", kind: "protein" },
  { food: "Venison", energy: "warm", kind: "protein" },
  { food: "Chicken", energy: "warm", kind: "protein" },
  { food: "Shrimp", energy: "warm", kind: "protein" },
  { food: "Salmon", energy: "warm", kind: "protein" },
  { food: "Beef", energy: "neutral", kind: "protein" },
  { food: "Pork", energy: "neutral", kind: "protein" },
  { food: "Eggs", energy: "neutral", kind: "protein" },
  { food: "Sardines", energy: "neutral", kind: "protein" },
  { food: "Whitefish or cod", energy: "cool", kind: "protein" },
  { food: "Turkey", energy: "cool", kind: "protein" },
  { food: "Duck", energy: "cool", kind: "protein" },
  { food: "Rabbit", energy: "cool", kind: "protein" },
  { food: "Clams", energy: "cold", kind: "protein" },
  { food: "Oats", energy: "warm", kind: "grain" },
  { food: "White rice", energy: "neutral", kind: "grain" },
  { food: "Brown rice", energy: "neutral", kind: "grain" },
  { food: "Barley", energy: "cool", kind: "grain" },
  { food: "Millet", energy: "cool", kind: "grain" },
  { food: "Pumpkin", energy: "warm", kind: "vegetable" },
  { food: "Sweet potato", energy: "neutral", kind: "vegetable" },
  { food: "Carrots", energy: "neutral", kind: "vegetable" },
  { food: "Green beans", energy: "neutral", kind: "vegetable" },
  { food: "Broccoli", energy: "cool", kind: "vegetable" },
  { food: "Celery", energy: "cool", kind: "vegetable" },
  { food: "Spinach", energy: "cool", kind: "vegetable" },
  { food: "Kale", energy: "cool", kind: "vegetable" },
  { food: "Blueberries", energy: "cool", kind: "fruit" },
  { food: "Apple", energy: "cool", kind: "fruit" },
  { food: "Pear", energy: "cool", kind: "fruit" },
  { food: "Ginger", energy: "warm", kind: "other" },
  { food: "Cinnamon", energy: "hot", kind: "other" },
  { food: "Tofu", energy: "cool", kind: "other" },
];

/** Plain-text reference block embedded in the AI prompt. */
export function referenceForPrompt(modalities: readonly Modality[]): string {
  const sections: string[] = [];
  if (modalities.includes("acupuncture") || modalities.includes("laser")) {
    sections.push(
      "ACUPOINTS (use ONLY these codes):\n" +
        ACUPOINTS.map(
          (p) =>
            `${p.code} ${p.name}: ${p.actions}${p.pregnancyCaution ? " [pregnancy caution]" : ""}`,
        ).join("\n"),
    );
  }
  if (modalities.includes("herbs")) {
    sections.push(
      "HERBAL FORMULAS (prefer these):\n" +
        HERBAL_FORMULAS.map(
          (f) =>
            `${f.name}: ${f.pattern}. ${f.uses}${f.cautions ? ` Caution: ${f.cautions}` : ""}`,
        ).join("\n"),
    );
  }
  if (modalities.includes("food")) {
    sections.push(
      "FOOD ENERGETICS:\n" +
        FOOD_ENERGETICS.map((f) => `${f.food}: ${f.energy}`).join("\n"),
    );
  }
  if (modalities.includes("laser")) {
    sections.push(
      "LASER GUIDANCE: Typical photobiomodulation doses are 2-4 J/cm2 for superficial tissue and 6-10 J/cm2 for deep or chronic musculoskeletal tissue; acupoint laser 1-4 J per point. Follow the device protocol. Contraindications: directly over the eyes, known or suspected neoplasia, the pregnant uterus; use caution over open growth plates and dark or tattooed skin.",
    );
  }
  if (modalities.includes("herbs")) {
    sections.push(
      "HERB DOSING NOTE: Concentrated TCVM granule formulas are commonly given at about 0.5 g per 10-20 lb (4.5-9 kg) body weight twice daily. Always defer to the product label.",
    );
  }
  return sections.join("\n\n");
}
