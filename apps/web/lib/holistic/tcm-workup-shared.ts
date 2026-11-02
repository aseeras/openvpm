/**
 * Holistic workup types and formatting that the browser can import. The AI
 * call lives in tcm-workup.ts, which is server-only (it pulls in provider
 * SDKs that need Node built-ins).
 */

export const TCM_WORKUP_MAX_PHOTOS = 6;

export interface TcmPattern {
  name: string;
  confidence: "high" | "moderate" | "low";
  evidence: string[];
}

export interface TcmPointPlan {
  code: string;
  name: string;
  location: string;
  rationale: string;
  pregnancyCaution: boolean;
}

export interface TcmWorkup {
  summary: string;
  eightPrinciples: {
    yinYang: string;
    interiorExterior: string;
    hotCold: string;
    excessDeficiency: string;
  } | null;
  zangFu: string[];
  patterns: TcmPattern[];
  photoFindings: Array<{ photo: string; observation: string }>;
  treatmentPrinciple: string;
  acupuncture: {
    points: TcmPointPlan[];
    technique: string;
    schedule: string;
  } | null;
  laser: {
    points: TcmPointPlan[];
    areas: string[];
    dose: string;
    schedule: string;
    cautions: string;
  } | null;
  exercises: Array<{ name: string; instructions: string; frequency: string }>;
  herbs: Array<{
    formula: string;
    rationale: string;
    dosing: string;
    cautions: string;
    inReference: boolean;
  }>;
  food: {
    energetics: string;
    recommend: string[];
    avoid: string[];
    notes: string;
  } | null;
  cautions: string[];
  followUp: string;
  /** Points the model suggested that are not in the reference list. */
  droppedPoints: string[];
}

/** Plain-text version for pasting into the visit note. */
export function formatTcmWorkupAsText(workup: TcmWorkup): string {
  const out: string[] = [];
  const push = (heading: string, lines: string[]) => {
    const body = lines.filter(Boolean);
    if (body.length > 0) out.push(`${heading}\n${body.join("\n")}`);
  };

  push("TCVM ASSESSMENT", [workup.summary]);
  push(
    "Pattern(s)",
    workup.patterns.map(
      (p) =>
        `- ${p.name} (${p.confidence})${p.evidence.length ? `: ${p.evidence.join("; ")}` : ""}`,
    ),
  );
  if (workup.eightPrinciples) {
    const e = workup.eightPrinciples;
    push("Eight principles", [
      [e.yinYang, e.interiorExterior, e.hotCold, e.excessDeficiency]
        .filter(Boolean)
        .join(" / "),
    ]);
  }
  push("Photo findings", workup.photoFindings.map((f) => `- ${f.photo}: ${f.observation}`));
  push("Treatment principle", [workup.treatmentPrinciple]);
  if (workup.acupuncture) {
    push("Acupuncture", [
      ...workup.acupuncture.points.map(
        (p) => `- ${p.code} ${p.name}${p.rationale ? `: ${p.rationale}` : ""}`,
      ),
      workup.acupuncture.technique && `Technique: ${workup.acupuncture.technique}`,
      workup.acupuncture.schedule && `Schedule: ${workup.acupuncture.schedule}`,
    ].filter((l): l is string => Boolean(l)));
  }
  if (workup.laser) {
    push("Laser", [
      workup.laser.points.length
        ? `Points: ${workup.laser.points.map((p) => p.code).join(", ")}`
        : "",
      workup.laser.areas.length ? `Areas: ${workup.laser.areas.join(", ")}` : "",
      workup.laser.dose && `Dose: ${workup.laser.dose}`,
      workup.laser.schedule && `Schedule: ${workup.laser.schedule}`,
      workup.laser.cautions && `Cautions: ${workup.laser.cautions}`,
    ]);
  }
  push(
    "Therapeutic exercise",
    workup.exercises.map(
      (e) => `- ${e.name}: ${e.instructions}${e.frequency ? ` (${e.frequency})` : ""}`,
    ),
  );
  push(
    "Chinese herbal medicine",
    workup.herbs.map(
      (h) =>
        `- ${h.formula}: ${h.rationale}${h.dosing ? ` Dosing: ${h.dosing}` : ""}${h.cautions ? ` Cautions: ${h.cautions}` : ""}`,
    ),
  );
  if (workup.food) {
    push("Food therapy", [
      workup.food.energetics,
      workup.food.recommend.length ? `Recommend: ${workup.food.recommend.join(", ")}` : "",
      workup.food.avoid.length ? `Avoid: ${workup.food.avoid.join(", ")}` : "",
      workup.food.notes,
    ]);
  }
  push("Cautions", workup.cautions.map((c) => `- ${c}`));
  push("Follow-up", [workup.followUp]);
  return out.join("\n\n");
}
