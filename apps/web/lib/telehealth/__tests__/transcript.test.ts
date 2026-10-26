import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createVisitRoom,
  deleteTranscript,
  downloadTranscript,
  latestTranscript,
  startTranscription,
  stopTranscription,
} from "../daily";
import {
  formatTranscript,
  parseTranscriptVtt,
  transcriptDisclosure,
} from "../transcript";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function stubDaily() {
  vi.stubEnv("DAILY_API_KEY", "test-key");
  vi.stubEnv("DAILY_DOMAIN", "clinic");
  vi.stubEnv("DAILY_API_URL", "");
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("parseTranscriptVtt", () => {
  it("reads voice-tagged speakers and joins their consecutive cues", () => {
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:03.000
<v Dr. Blake>Hi Margaret, how is Rusty?</v>

2
00:00:03.500 --> 00:00:05.000
<v Margaret Ellis>Much better &amp; happier.</v>

3
00:00:05.500 --> 00:00:07.000
<v Margaret Ellis>He did the stairs twice.</v>
`;
    const lines = parseTranscriptVtt(vtt);
    expect(lines).toEqual([
      { speaker: "Dr. Blake", start: 1, text: "Hi Margaret, how is Rusty?" },
      { speaker: "Margaret Ellis", start: 3.5, text: "Much better & happier. He did the stairs twice." },
    ]);
    expect(formatTranscript(lines)).toBe(
      "Dr. Blake: Hi Margaret, how is Rusty?\nMargaret Ellis: Much better & happier. He did the stairs twice.",
    );
  });

  it("recognizes a known name prefix and keeps unlabeled text", () => {
    const vtt = "WEBVTT\r\n\r\n00:01:02.000 --> 00:01:04.000\r\nDr. Blake: Walk him over please.\r\n\r\n00:01:05.000 --> 00:01:06.000\r\nOkay: here he comes.\r\n";
    const lines = parseTranscriptVtt(vtt, ["Dr. Blake", "Margaret Ellis"]);
    expect(lines[0]).toEqual({ speaker: "Dr. Blake", start: 62, text: "Walk him over please." });
    // "Okay:" is not a participant, so it stays part of the words.
    expect(lines[1]).toEqual({ speaker: null, start: 65, text: "Okay: here he comes." });
  });

  it("ignores headers, notes and empty cues", () => {
    expect(parseTranscriptVtt("WEBVTT\n\nNOTE created by Daily\n\n00:00:01.000 --> 00:00:02.000\n\n")).toEqual([]);
  });
});

describe("transcriptDisclosure", () => {
  it("names the clinician, pet and practice and says audio is not kept", () => {
    const text = transcriptDisclosure({ clinicianName: "Dr. Blake", patientName: "Rusty", practiceName: "ZenPaws" });
    expect(text).toContain("Dr. Blake would like");
    expect(text).toContain("Rusty's record at ZenPaws");
    expect(text).toContain("not recorded or kept");
    expect(text).toContain("stop the transcript at any time");
  });
});

describe("Daily transcription", () => {
  it("creates rooms that can store a transcript", async () => {
    stubDaily();
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ name: "visit-x" }));
    vi.stubGlobal("fetch", fetchMock);
    await createVisitRoom();
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.properties.enable_transcription_storage).toBe(true);
  });

  it("starts and stops transcription for the room", async () => {
    stubDaily();
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ sent: "true" }));
    vi.stubGlobal("fetch", fetchMock);
    await startTranscription("visit-abc");
    await stopTranscription("visit-abc");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.daily.co/v1/rooms/visit-abc/transcription/start");
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ language: "en", punctuate: true });
    expect(fetchMock.mock.calls[1]![0]).toBe("https://api.daily.co/v1/rooms/visit-abc/transcription/stop");
  });

  it("picks the newest transcript for the room", async () => {
    stubDaily();
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        total_count: 2,
        data: [
          { transcriptId: "old", status: "t_finished", isVttAvailable: true, created_at: "2026-10-26T01:00:00Z" },
          { transcriptId: "new", status: "t_in_progress", isVttAvailable: false, created_at: "2026-10-26T02:00:00Z" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const info = await latestTranscript("visit-abc");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.daily.co/v1/transcript?room_name=visit-abc&limit=10");
    expect(info).toEqual({ transcriptId: "new", status: "t_in_progress", isVttAvailable: false, createdAt: "2026-10-26T02:00:00Z" });
  });

  it("downloads through the signed link and deletes Daily's copy", async () => {
    stubDaily();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ transcriptId: "t1", link: "https://files.example/t1.vtt?sig=1" }))
      .mockResolvedValueOnce(new Response("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v A>Hi</v>\n"))
      .mockResolvedValueOnce(jsonResponse({ deleted: true }));
    vi.stubGlobal("fetch", fetchMock);
    const vtt = await downloadTranscript("t1");
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.daily.co/v1/transcript/t1/access-link");
    expect(fetchMock.mock.calls[1]![0]).toBe("https://files.example/t1.vtt?sig=1");
    expect(vtt).toContain("<v A>Hi</v>");
    await deleteTranscript("t1");
    expect(fetchMock.mock.calls[2]![1].method).toBe("DELETE");
  });

  it("refuses a link that is not https", async () => {
    stubDaily();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ link: "http://insecure.example/t.vtt" })));
    await expect(downloadTranscript("t1")).rejects.toThrow();
  });
});
