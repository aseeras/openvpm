import { VISIT_RECORDING_CONSENT_TTL_MS } from "./disclosure";

/** Database and app server clocks may disagree slightly. */
const CLOCK_SKEW_ALLOWANCE_MS = 5 * 60 * 1000;

/**
 * A visit may be recorded only while the client's most recent answer for that
 * visit is "yes" and was given within the consent window. A later "no"
 * always wins over an earlier "yes".
 */
export function consentIsActive(
  latest: { action: string; occurredAt: Date | string } | null,
  now = Date.now(),
): boolean {
  if (latest?.action !== "granted") return false;
  const age = now - new Date(latest.occurredAt).getTime();
  return (
    age >= -CLOCK_SKEW_ALLOWANCE_MS && age <= VISIT_RECORDING_CONSENT_TTL_MS
  );
}
