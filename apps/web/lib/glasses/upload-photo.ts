import {
  CLIENT_UPLOAD_TIMEOUT_MS,
  fetchWithClientTimeout,
} from "@/lib/client-fetch";

/**
 * Saves a glasses photo to the patient's chart as a clinical photo, the same
 * way the phone camera button does. Throws with a message staff can read.
 */
export async function uploadClinicalPhoto(file: File, patientId: string): Promise<void> {
  const body = new FormData();
  body.append("file", file);
  body.append("category", "patient-photos");
  body.append("purpose", "clinical");
  body.append("patientId", patientId);
  const res = await fetchWithClientTimeout(
    "/api/upload",
    {
      method: "POST",
      body,
      headers: { "Idempotency-Key": crypto.randomUUID() },
    },
    CLIENT_UPLOAD_TIMEOUT_MS,
  );
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? "Upload failed");
}
