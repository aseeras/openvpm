import { z } from "zod";

/**
 * Pre-appointment check-in form that pet owners fill out before a visit.
 *
 * The catalog below drives the owner form, the staff chart card, and the
 * plain-text summary handed to clinical tools, so a question added here shows
 * up everywhere. Answers are owner-reported and unverified.
 */

export const CHECK_IN_FORM_VERSION = 1;
export const CHECK_IN_TEXT_MAX_LENGTH = 2_000;

type TextQuestion = {
  key: string;
  kind: "text";
  label: string;
  hint?: string;
  rows?: number;
};

type ChoiceQuestion = {
  key: string;
  kind: "choice";
  label: string;
  hint?: string;
  options: ReadonlyArray<{ value: string; label: string }>;
};

export type CheckInQuestion = TextQuestion | ChoiceQuestion;

export type CheckInSection = {
  key: string;
  title: string;
  intro?: string;
  questions: readonly CheckInQuestion[];
};

export const CHECK_IN_SECTIONS = [
  {
    key: "problems",
    title: "Problems and concerns",
    intro: "Tell us what is going on and what you would like us to look at.",
    questions: [
      {
        key: "mainConcerns",
        kind: "text",
        label: "What problems or concerns would you like help with?",
        hint: "For example: stiffness getting up, itchy skin, anxiety, limping on the back left leg",
        rows: 4,
      },
      {
        key: "concernHistory",
        kind: "text",
        label: "When did it start, and is it getting better or worse?",
      },
      {
        key: "betterOrWorse",
        kind: "text",
        label: "What makes it better or worse?",
        hint: "Time of day, weather, cold or heat, exercise, rest, meals",
      },
      {
        key: "pastDiagnoses",
        kind: "text",
        label: "Past diagnoses, surgeries, or treatments already tried",
        hint: "Include other vets, rehab, acupuncture, or anything that helped or didn't",
      },
    ],
  },
  {
    key: "habits",
    title: "Daily habits",
    intro: "A picture of a normal day helps us understand the whole animal.",
    questions: [
      {
        key: "energy",
        kind: "choice",
        label: "Energy level lately",
        options: [
          { value: "low", label: "Low or tired" },
          { value: "normal", label: "Normal" },
          { value: "high", label: "High or restless" },
          { value: "varies", label: "Up and down" },
        ],
      },
      {
        key: "activity",
        kind: "text",
        label: "Exercise and activity",
        hint: "Walks, play, how far, how often, any changes",
      },
      {
        key: "sleep",
        kind: "text",
        label: "Sleep and rest",
        hint: "Where they sleep, restless at night, panting, pacing",
      },
      {
        key: "temperature",
        kind: "choice",
        label: "Do they seek out warm or cool spots?",
        options: [
          { value: "warm", label: "Seeks warmth (sun, blankets, heaters)" },
          { value: "cool", label: "Seeks cool (tile floors, shade, AC)" },
          { value: "neither", label: "No preference" },
          { value: "unsure", label: "Not sure" },
        ],
      },
      {
        key: "thirst",
        kind: "choice",
        label: "Thirst",
        options: [
          { value: "less", label: "Drinks less than usual" },
          { value: "normal", label: "Normal" },
          { value: "more", label: "Drinks more than usual" },
        ],
      },
      {
        key: "bathroom",
        kind: "text",
        label: "Bathroom habits",
        hint: "Stool (soft, hard, frequency) and urine (amount, accidents)",
      },
      {
        key: "temperament",
        kind: "text",
        label: "Personality and behavior",
        hint: "Calm, anxious, social, sensitive to touch, anything we should know when handling them",
      },
    ],
  },
  {
    key: "food",
    title: "Food",
    questions: [
      {
        key: "appetite",
        kind: "choice",
        label: "Appetite",
        options: [
          { value: "poor", label: "Poor" },
          { value: "picky", label: "Picky" },
          { value: "normal", label: "Normal" },
          { value: "ravenous", label: "Always hungry" },
        ],
      },
      {
        key: "diet",
        kind: "text",
        label: "What do they eat?",
        hint: "Brand and type (kibble, canned, raw, home-cooked), how much, how often",
        rows: 3,
      },
      {
        key: "treats",
        kind: "text",
        label: "Treats, chews, and table food",
      },
      {
        key: "foodReactions",
        kind: "text",
        label: "Foods that disagree with them or cause reactions",
      },
    ],
  },
  {
    key: "medications",
    title: "Medications and supplements",
    questions: [
      {
        key: "medications",
        kind: "text",
        label: "Current medications",
        hint: "Name, dose, and how often (include flea, tick, and heartworm prevention)",
        rows: 3,
      },
      {
        key: "supplements",
        kind: "text",
        label: "Supplements, herbs, or CBD",
        hint: "Joint supplements, fish oil, probiotics, Chinese herbs, and similar",
      },
      {
        key: "allergies",
        kind: "text",
        label: "Allergies or bad reactions to medications or vaccines",
      },
    ],
  },
  {
    key: "goals",
    title: "Your goals",
    questions: [
      {
        key: "goals",
        kind: "text",
        label:
          "What would you most like to get out of this visit or treatment?",
        hint: "For example: more comfortable on walks, sleep through the night, fewer pain medications",
        rows: 3,
      },
      {
        key: "anythingElse",
        kind: "text",
        label: "Anything else you'd like us to know?",
      },
    ],
  },
] as const satisfies readonly CheckInSection[];

type AllQuestions = (typeof CHECK_IN_SECTIONS)[number]["questions"][number];
export type CheckInAnswerKey = AllQuestions["key"];

export const CHECK_IN_QUESTIONS: readonly CheckInQuestion[] =
  CHECK_IN_SECTIONS.flatMap((section) => [...section.questions]);

const answerText = z
  .string()
  .trim()
  .max(CHECK_IN_TEXT_MAX_LENGTH)
  .transform((value) => value || undefined)
  .optional();

function buildAnswersSchema() {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const question of CHECK_IN_QUESTIONS) {
    if (question.kind === "choice") {
      const values = question.options.map((option) => option.value) as [
        string,
        ...string[],
      ];
      shape[question.key] = z.enum(values).optional();
    } else {
      shape[question.key] = answerText;
    }
  }
  return z.object(shape).strict();
}

export type CheckInAnswers = Partial<Record<CheckInAnswerKey, string>>;

/** Strict input validation for submitted answers. */
export const checkInAnswersInput = buildAnswersSchema() as unknown as z.ZodType<
  CheckInAnswers,
  unknown
>;

/** Owner must tell us at least what the visit is about. */
export function checkInHasRequiredAnswers(answers: CheckInAnswers): boolean {
  return Boolean(answers.mainConcerns?.trim());
}

/** Stored document shape, versioned so the catalog can change later. */
export type StoredCheckInAnswers = {
  version: number;
  answers: CheckInAnswers;
};

export function toStoredCheckInAnswers(
  answers: CheckInAnswers,
): StoredCheckInAnswers {
  return { version: CHECK_IN_FORM_VERSION, answers: compactAnswers(answers) };
}

/** Read a stored row defensively: unknown keys and bad values are dropped. */
export function readStoredCheckInAnswers(value: unknown): CheckInAnswers {
  const raw =
    value && typeof value === "object" && "answers" in value
      ? (value as { answers: unknown }).answers
      : null;
  if (!raw || typeof raw !== "object") return {};
  const out: CheckInAnswers = {};
  for (const question of CHECK_IN_QUESTIONS) {
    const v = (raw as Record<string, unknown>)[question.key];
    if (typeof v !== "string" || !v.trim()) continue;
    if (
      question.kind === "choice" &&
      !question.options.some((option) => option.value === v)
    ) {
      continue;
    }
    out[question.key as CheckInAnswerKey] = v.slice(
      0,
      CHECK_IN_TEXT_MAX_LENGTH,
    );
  }
  return out;
}

function compactAnswers(answers: CheckInAnswers): CheckInAnswers {
  return Object.fromEntries(
    CHECK_IN_QUESTIONS.flatMap(({ key }) => {
      const v = answers[key as CheckInAnswerKey];
      return v ? [[key, v]] : [];
    }),
  ) as CheckInAnswers;
}

/** Human label for a stored answer (choice values become their label). */
export function checkInAnswerLabel(
  question: CheckInQuestion,
  value: string,
): string {
  if (question.kind !== "choice") return value;
  return (
    question.options.find((option) => option.value === value)?.label ?? value
  );
}

/** Short label used on the staff card and in summaries. */
const SUMMARY_LABELS: Record<CheckInAnswerKey, string> = {
  mainConcerns: "Concerns",
  concernHistory: "Onset and course",
  betterOrWorse: "Better or worse with",
  pastDiagnoses: "Past diagnoses and treatments",
  energy: "Energy",
  activity: "Activity",
  sleep: "Sleep",
  temperature: "Warm/cool preference",
  thirst: "Thirst",
  bathroom: "Stool and urine",
  temperament: "Temperament",
  appetite: "Appetite",
  diet: "Diet",
  treats: "Treats and extras",
  foodReactions: "Food reactions",
  medications: "Medications",
  supplements: "Supplements and herbs",
  allergies: "Allergies and reactions",
  goals: "Owner goals",
  anythingElse: "Other notes",
};

export function checkInSummaryLabel(key: CheckInAnswerKey): string {
  return SUMMARY_LABELS[key];
}

/**
 * Plain-text summary for clinical tools (assistant context, holistic workup).
 * Grouped by section; empty answers are skipped.
 */
export function formatCheckInForClinicalContext(
  answers: CheckInAnswers,
): string {
  const lines: string[] = [];
  for (const section of CHECK_IN_SECTIONS) {
    const sectionLines = section.questions.flatMap((question) => {
      const value = answers[question.key as CheckInAnswerKey];
      if (!value) return [];
      return [
        `- ${SUMMARY_LABELS[question.key as CheckInAnswerKey]}: ${checkInAnswerLabel(question, value).replace(/\s+/g, " ").trim()}`,
      ];
    });
    if (sectionLines.length > 0) {
      lines.push(`${section.title}:`, ...sectionLines);
    }
  }
  return lines.join("\n");
}
