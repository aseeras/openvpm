import { describe, expect, it } from "vitest";
import {
  STAFF_VIDEOS_MAX,
  normalizeStaffVideos,
  staffVideosFromSettings,
  staffVideosInput,
} from "@/lib/staff-videos";

describe("staff videos", () => {
  it("reads saved videos and skips malformed entries", () => {
    const videos = staffVideosFromSettings({
      staffVideos: [
        { title: "App demo", url: "https://example.com/demo.mp4", posterUrl: null, note: null },
        { title: "No link" },
        { title: "Plain http", url: "http://example.com/a.mp4" },
        "junk",
      ],
    });
    expect(videos).toEqual([
      { title: "App demo", url: "https://example.com/demo.mp4", posterUrl: null, note: null },
    ]);
  });

  it("returns nothing when no videos are saved", () => {
    expect(staffVideosFromSettings(null)).toEqual([]);
    expect(staffVideosFromSettings({})).toEqual([]);
    expect(staffVideosFromSettings({ staffVideos: "x" })).toEqual([]);
  });

  it("accepts only https links without credentials", () => {
    const ok = staffVideosInput.safeParse([{ title: "A", url: "https://example.com/a.mp4" }]);
    expect(ok.success).toBe(true);
    for (const url of ["javascript:alert(1)", "http://example.com/a.mp4", "https://u:p@example.com/a.mp4", "not a url"]) {
      expect(staffVideosInput.safeParse([{ title: "A", url }]).success).toBe(false);
    }
  });

  it("caps the list and normalizes empty optional fields", () => {
    const many = Array.from({ length: STAFF_VIDEOS_MAX + 1 }, (_, i) => ({
      title: `V${i}`,
      url: "https://example.com/v.mp4",
    }));
    expect(staffVideosInput.safeParse(many).success).toBe(false);
    expect(
      normalizeStaffVideos([{ title: "A", url: "https://example.com/a.mp4", posterUrl: "", note: "" }]),
    ).toEqual([{ title: "A", url: "https://example.com/a.mp4", posterUrl: null, note: null }]);
  });
});
