/**
 * Wording for the inbox message an appointment request creates. The same
 * message shows in the owner's portal Messages as "You", so it is written
 * the way the owner would read it: a friendly date and 12-hour time, no
 * staff notes, and the location only when the clinic has more than one.
 * Staff-only details (who the client is, whether they are new) belong in
 * the inbox alert, not here.
 */

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * "2026-12-15" + "15:30" -> "Tue, Dec 15, 2026, 3:30 PM". The inputs are the
 * clinic's wall-clock date and time, so no time zone conversion happens.
 * Anything that doesn't parse is returned as given.
 */
export function formatRequestedSlot(date: string, time: string): string {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{1,2}):(\d{2})/.exec(time);
  if (!d || !t) return `${date} ${time}`.trim();
  const [year, month, day] = [Number(d[1]), Number(d[2]), Number(d[3])];
  const when = new Date(Date.UTC(year, month - 1, day));
  if (
    when.getUTCFullYear() !== year ||
    when.getUTCMonth() !== month - 1 ||
    when.getUTCDate() !== day
  ) {
    return `${date} ${time}`.trim();
  }
  const hour = Number(t[1]);
  const minute = t[2]!;
  if (hour > 23 || Number(minute) > 59) return `${date} ${time}`.trim();
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  const ampm = hour < 12 ? "AM" : "PM";
  return `${WEEKDAYS[when.getUTCDay()]}, ${MONTHS[month - 1]} ${day}, ${year}, ${hour12}:${minute} ${ampm}`;
}

const NOTE_PREFIX = /^\[(Online|Portal) request\]\s*/;

export function appointmentRequestMessage(input: {
  petName: string;
  date: string;
  time: string;
  /** Shown only when the clinic has more than one location. */
  locationName?: string | null;
  locationCount: number;
  /** The visit reason or compiled request note; its "[Online request]" tag is dropped. */
  reason: string;
}): string {
  return [
    `Pet: ${input.petName}`,
    `Requested: ${formatRequestedSlot(input.date, input.time)}`,
    input.locationCount > 1 && input.locationName
      ? `Location: ${input.locationName}`
      : null,
    `Reason: ${input.reason.replace(NOTE_PREFIX, "")}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
