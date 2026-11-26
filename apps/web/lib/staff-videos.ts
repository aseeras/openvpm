import { z } from "zod";

/**
 * Videos an administrator keeps for the team: app walkthroughs, training
 * clips, demo recordings. They are listed in Settings > Videos, which only
 * administrators can open, and are never shown to clients or on public pages.
 * Each entry links to a video file the practice already hosts (for example on
 * its own website); the app stores only the link.
 */
export const STAFF_VIDEOS_MAX = 20;
export const STAFF_VIDEO_TITLE_MAX = 120;
export const STAFF_VIDEO_NOTE_MAX = 500;
export const STAFF_VIDEO_URL_MAX = 2048;

const httpsUrl = z
  .string()
  .trim()
  .max(STAFF_VIDEO_URL_MAX)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  }, "Use a full https:// link");

export const staffVideoInput = z
  .object({
    title: z.string().trim().min(1, "Add a title").max(STAFF_VIDEO_TITLE_MAX),
    url: httpsUrl,
    posterUrl: z.union([httpsUrl, z.literal("")]).optional(),
    note: z.string().trim().max(STAFF_VIDEO_NOTE_MAX).optional(),
  })
  .strict();

export const staffVideosInput = z
  .array(staffVideoInput)
  .max(STAFF_VIDEOS_MAX, `Keep at most ${STAFF_VIDEOS_MAX} videos`);

export type StaffVideo = {
  title: string;
  url: string;
  posterUrl: string | null;
  note: string | null;
};

export function normalizeStaffVideos(
  videos: z.infer<typeof staffVideosInput>,
): StaffVideo[] {
  return videos.map((video) => ({
    title: video.title,
    url: video.url,
    posterUrl: video.posterUrl || null,
    note: video.note || null,
  }));
}

/** Reads `settings.staffVideos`, skipping anything malformed. */
export function staffVideosFromSettings(settings: unknown): StaffVideo[] {
  if (!settings || typeof settings !== "object") return [];
  const raw = (settings as { staffVideos?: unknown }).staffVideos;
  if (!Array.isArray(raw)) return [];
  const videos: StaffVideo[] = [];
  for (const entry of raw.slice(0, STAFF_VIDEOS_MAX)) {
    const parsed = staffVideoInput.safeParse({
      title: (entry as { title?: unknown })?.title,
      url: (entry as { url?: unknown })?.url,
      posterUrl: (entry as { posterUrl?: unknown })?.posterUrl ?? "",
      note: (entry as { note?: unknown })?.note ?? "",
    });
    if (parsed.success) videos.push(...normalizeStaffVideos([parsed.data]));
  }
  return videos;
}
