/**
 * The words a client is shown before a visit is recorded. The exact text and
 * its version are snapshotted into visit_recording_consents with the client's
 * answer, so changing the wording means bumping the version.
 */
export const VISIT_RECORDING_DISCLOSURE_VERSION = "2026-10-v1";

export const VISIT_RECORDING_DISCLOSURE = [
  "We would like to record the audio of today's visit to help write your pet's medical notes.",
  "The recording is turned into a written transcript, an AI assistant drafts the visit notes from it, and the veterinarian reviews and corrects those notes before anything is saved to your pet's record.",
  "The audio is deleted as soon as the transcript is ready. The transcript stays with this visit unless you ask us to delete it.",
  "You can say no, and you can ask us to stop recording at any time. Your pet's care will be the same either way.",
].join("\n\n");

/** How long a "yes" covers further recordings during the same visit. */
export const VISIT_RECORDING_CONSENT_TTL_MS = 12 * 60 * 60 * 1000;

/** Cap per visit so a stuck client cannot pile up audio objects. */
export const VISIT_RECORDINGS_PER_APPOINTMENT_LIMIT = 6;
