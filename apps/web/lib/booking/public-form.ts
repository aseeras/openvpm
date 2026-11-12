import type { PatientSpecies } from "@/lib/patients/species";

/**
 * Shows a wall-clock request time ("14:30") the way the visitor reads times
 * on their own device ("2:30 PM" in the US, "14:30" in most of Europe).
 * The value sent to the server stays the plain "HH:MM" string.
 */
export function formatBookingTime(time: string, locale?: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return time;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return time;
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(2000, 0, 1, hours, minutes)));
}

/** Shows a "YYYY-MM-DD" request date as e.g. "Tue, Nov 17". */
export function formatBookingDate(date: string, locale?: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(
    new Date(
      Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])),
    ),
  );
}

/**
 * Pet-type choices for pet owners on the public request form: everyday words
 * instead of the clinical species names staff see, companion animals first,
 * and farm or large animals grouped below so they stay available to mixed and
 * ambulatory practices without crowding the list for small-animal clinics.
 */
export const PUBLIC_BOOKING_SPECIES_GROUPS: ReadonlyArray<{
  label: string | null;
  options: ReadonlyArray<{ value: PatientSpecies; label: string }>;
}> = [
  {
    label: null,
    options: [
      { value: "canine", label: "Dog" },
      { value: "feline", label: "Cat" },
      { value: "rabbit", label: "Rabbit" },
      { value: "avian", label: "Bird" },
      { value: "reptile", label: "Reptile" },
    ],
  },
  {
    label: "Farm and large animals",
    options: [
      { value: "equine", label: "Horse" },
      { value: "bovine", label: "Cattle" },
      { value: "ovine", label: "Sheep" },
      { value: "caprine", label: "Goat" },
      { value: "porcine", label: "Pig" },
      { value: "poultry", label: "Poultry" },
      { value: "camelid", label: "Alpaca or llama" },
    ],
  },
  { label: null, options: [{ value: "other", label: "Other" }] },
];
