import { afterEach, describe, expect, it, vi } from "vitest";
import { quoProvider } from "../quo";
import { quoWebhookSignature, verifyQuoWebhook } from "../quo-signature";
import { describeQuoCallActivity, quoCallDedupeKey } from "../quo-calls";

const SECRET = `whsec_${Buffer.from("quo-test-signing-key").toString("base64")}`;

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.QUO_API_KEY;
});

describe("Quo provider send", () => {
  it("is unconfigured without an API key", async () => {
    expect(quoProvider.isConfigured()).toBe(false);
    const result = await quoProvider.send({
      to: "+15555550100",
      body: "hi",
      sender: { from: "+18135550100" },
    });
    expect(result.status).toBe("definite_failure");
  });

  it("posts to Quo with the raw key and the phone number id as sender", async () => {
    process.env.QUO_API_KEY = "key-123";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: { id: "AC123", status: "queued" } }),
          {
            status: 202,
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await quoProvider.send({
      to: "+15555550100",
      body: "Reminder",
      sender: { messagingServiceId: "PN1", from: "+18135550100" },
    });
    expect(result).toEqual({ status: "accepted", id: "AC123" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.quo.com/v1/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "key-123",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      content: "Reminder",
      from: "PN1",
      to: ["+15555550100"],
    });
  });

  it("treats a refused send as definite and rate limits as unknown", async () => {
    process.env.QUO_API_KEY = "key-123";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ message: "A2P Registration Not Approved" }),
            {
              status: 400,
            },
          ),
      ),
    );
    const refused = await quoProvider.send({
      to: "+15555550100",
      body: "x",
      sender: { from: "+18135550100" },
    });
    expect(refused.status).toBe("definite_failure");
    expect(refused.status !== "accepted" && refused.error).toContain("A2P");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 429 })),
    );
    const limited = await quoProvider.send({
      to: "+15555550100",
      body: "x",
      sender: { from: "+18135550100" },
    });
    expect(limited.status).toBe("outcome_unknown");
  });

  it("treats a network error as an unknown outcome", async () => {
    process.env.QUO_API_KEY = "key-123";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("reset"))),
    );
    const result = await quoProvider.send({
      to: "+15555550100",
      body: "x",
      sender: { from: "+18135550100" },
    });
    expect(result.status).toBe("outcome_unknown");
  });
});

describe("Quo webhook signature", () => {
  const rawBody = '{"type":"message.received"}';
  const now = 1_790_000_000_000;
  const timestamp = String(Math.floor(now / 1000));

  function headers(signature: string, ts = timestamp) {
    return new Headers({
      "webhook-id": "msg_1",
      "webhook-timestamp": ts,
      "webhook-signature": signature,
    });
  }

  const good = quoWebhookSignature({
    secret: SECRET,
    webhookId: "msg_1",
    timestamp,
    rawBody,
  })!;

  it("accepts a valid signature, including during rotation", () => {
    expect(
      verifyQuoWebhook({
        secret: SECRET,
        headers: headers(`v1,${good}`),
        rawBody,
        nowMs: now,
      }),
    ).toBe(true);
    expect(
      verifyQuoWebhook({
        secret: SECRET,
        headers: headers(`v1,bm9wZQ== v1,${good}`),
        rawBody,
        nowMs: now,
      }),
    ).toBe(true);
  });

  it("rejects tampered bodies, stale timestamps and missing secrets", () => {
    expect(
      verifyQuoWebhook({
        secret: SECRET,
        headers: headers(`v1,${good}`),
        rawBody: rawBody + " ",
        nowMs: now,
      }),
    ).toBe(false);
    expect(
      verifyQuoWebhook({
        secret: SECRET,
        headers: headers(`v1,${good}`),
        rawBody,
        nowMs: now + 10 * 60 * 1000,
      }),
    ).toBe(false);
    expect(
      verifyQuoWebhook({
        secret: undefined,
        headers: headers(`v1,${good}`),
        rawBody,
        nowMs: now,
      }),
    ).toBe(false);
  });
});

describe("Quo call inbox entries", () => {
  const base = {
    phoneNumberId: "PN1",
    externalPhone: "+18135550123",
    occurredAt: new Date("2026-11-01T12:00:00Z"),
    quoLink: null,
  };

  it("describes a missed call with voicemail", () => {
    const entry = describeQuoCallActivity({
      ...base,
      kind: "call",
      callId: "AC1",
      direction: "inbound",
      status: "unanswered",
      durationSeconds: 0,
      hasVoicemail: true,
    });
    expect(entry.subject).toBe("Missed call from (813) 555-0123");
    expect(entry.content).toBe(
      "Incoming call: missed, caller left a voicemail.",
    );
  });

  it("describes an answered call with its length", () => {
    const entry = describeQuoCallActivity({
      ...base,
      kind: "call",
      callId: "AC2",
      direction: "inbound",
      status: "answered",
      durationSeconds: 125,
      hasVoicemail: false,
    });
    expect(entry.subject).toBe("Call from (813) 555-0123");
    expect(entry.content).toBe("Incoming call: answered, 2:05 long.");
  });

  it("includes the voicemail transcript and a stable dedupe key", () => {
    const activity = {
      ...base,
      kind: "voicemail" as const,
      voicemailId: "VM1",
      durationSeconds: 18,
      transcript: "Hi, Luna needs a refill.",
      quoLink: "https://my.quo.com/inbox/x",
    };
    const entry = describeQuoCallActivity(activity);
    expect(entry.subject).toBe("Voicemail from (813) 555-0123");
    expect(entry.content).toBe(
      'Voicemail (0:18): "Hi, Luna needs a refill."\n\nOpen in Quo: https://my.quo.com/inbox/x',
    );
    expect(quoCallDedupeKey(activity)).toBe("quo:voicemail:VM1");
  });
  it("labels calls Quo's AI agent answered", () => {
    const entry = describeQuoCallActivity({
      ...base,
      kind: "call",
      callId: "AC3",
      direction: "inbound",
      status: "ai-handled",
      durationSeconds: 61,
      hasVoicemail: false,
    });
    expect(entry.subject).toBe("Call from (813) 555-0123");
    expect(entry.content).toBe(
      "Incoming call: answered by Quo's AI agent, 1:01 long.",
    );
  });

  it("lists what the caller told Quo's AI agent", () => {
    const activity = {
      ...base,
      kind: "summary" as const,
      callId: "AC4",
      handledByAiAgent: true,
      summary: ["Caller wants acupuncture for her dog."],
      nextSteps: ["Call back to book."],
      details: [
        { name: "Name", value: "Jane Doe" },
        { name: "Pet", value: "Luna" },
      ],
    };
    const entry = describeQuoCallActivity(activity);
    expect(entry.subject).toBe("AI agent call notes: (813) 555-0123");
    expect(entry.content).toBe(
      "Name: Jane Doe\nPet: Luna\n\nSummary:\n- Caller wants acupuncture for her dog.\n\nNext steps:\n- Call back to book.",
    );
    expect(quoCallDedupeKey(activity)).toBe("quo:summary:AC4");
  });
});
