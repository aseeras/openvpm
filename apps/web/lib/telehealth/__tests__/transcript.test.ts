import { describe, expect, it } from "vitest";
import { formatChannelTranscript } from "@/lib/visit-recordings/aws";
import { transcriptDisclosure } from "../transcript";

const word = (content: string, start: string, channel: string) => ({
  type: "pronunciation",
  start_time: start,
  alternatives: [{ confidence: "0.99", content }],
  channel_label: channel,
});
const mark = (content: string, channel: string) => ({
  type: "punctuation",
  alternatives: [{ confidence: "0.0", content }],
  channel_label: channel,
});

// Shaped like a real Amazon Transcribe channel-identification result.
const output = {
  results: {
    transcripts: [{ transcript: "unused" }],
    channel_labels: {
      number_of_channels: 2,
      channels: [
        {
          channel_label: "ch_0",
          items: [
            word("How", "0.1", "ch_0"), word("is", "0.3", "ch_0"), word("Rusty", "0.5", "ch_0"), mark("?", "ch_0"),
            word("Great", "4.0", "ch_0"), mark(".", "ch_0"),
          ],
        },
        {
          channel_label: "ch_1",
          items: [
            word("Much", "1.2", "ch_1"), word("better", "1.5", "ch_1"), mark(",", "ch_1"),
            word("thanks", "1.9", "ch_1"), mark(".", "ch_1"),
          ],
        },
      ],
    },
  },
};

describe("formatChannelTranscript", () => {
  it("labels each channel with its person and keeps turns in time order", () => {
    expect(formatChannelTranscript(output, ["Dr. Blake", "Margaret Ellis"])).toBe(
      "Dr. Blake: How is Rusty?\nMargaret Ellis: Much better, thanks.\nDr. Blake: Great.",
    );
  });

  it("falls back to numbered speakers and to the plain transcript", () => {
    expect(formatChannelTranscript(output, []).split("\n")[0]).toBe("Speaker 1: How is Rusty?");
    expect(
      formatChannelTranscript({ results: { transcripts: [{ transcript: " just text " }] } }, ["A", "B"]),
    ).toBe("just text");
    expect(formatChannelTranscript(null, ["A"])).toBe("");
  });
});

describe("transcriptDisclosure", () => {
  it("says what is recorded, that audio is deleted, and that it can be stopped", () => {
    const text = transcriptDisclosure({ clinicianName: "Dr. Blake", patientName: "Rusty", practiceName: "ZenPaws" });
    expect(text).toContain("Dr. Blake would like");
    expect(text).toContain("records the call audio (not video)");
    expect(text).toContain("audio is deleted as soon as the transcript is made");
    expect(text).toContain("Rusty's record at ZenPaws");
    expect(text).toContain("stop the transcript at any time");
  });
});
