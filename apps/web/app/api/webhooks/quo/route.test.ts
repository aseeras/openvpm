import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { quoWebhookSignature } from "@/lib/messaging/quo-signature";

const mocks = vi.hoisted(() => ({
  ingestSmsProviderEvent: vi.fn(async (_input: unknown) => ({
    eventId: "00000000-0000-0000-0000-000000000002",
    duplicate: false,
    conflict: false,
  })),
  projectSmsProviderEvent: vi.fn(async (_eventId: string) => ({
    outcome: "projected",
  })),
  logQuoCallActivity: vi.fn(async (_activity: unknown) => "logged"),
  openVpmSentThroughQuo: vi.fn(async (_id: string) => true),
}));

vi.mock("@/lib/messaging/sms-provider-events", () => ({
  ingestSmsProviderEvent: mocks.ingestSmsProviderEvent,
  projectSmsProviderEvent: mocks.projectSmsProviderEvent,
}));
vi.mock("@/lib/messaging/quo-calls", () => ({
  logQuoCallActivity: mocks.logQuoCallActivity,
  openVpmSentThroughQuo: mocks.openVpmSentThroughQuo,
}));

const { POST } = await import("./route");

const SECRET = `whsec_${Buffer.from("quo-route-key").toString("base64")}`;

function signedRequest(
  payload: unknown,
  opts: { badSignature?: boolean } = {},
) {
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = quoWebhookSignature({
    secret: SECRET,
    webhookId: "wh_1",
    timestamp,
    rawBody,
  });
  return new Request("https://app.example.test/api/webhooks/quo", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": "wh_1",
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${opts.badSignature ? "AAAA" : signature}`,
    },
    body: rawBody,
  });
}

const context = {
  phoneNumberId: "PN1",
  conversationId: "CN1",
  senderIdentifier: "+15555550199",
  recipientIdentifiers: ["+18133413102"],
  participants: { workspace: ["+18133413102"], external: ["+15555550199"] },
};

beforeEach(() => {
  process.env.QUO_WEBHOOK_SECRET = SECRET;
});

afterEach(() => {
  vi.clearAllMocks();
  mocks.openVpmSentThroughQuo.mockResolvedValue(true);
  delete process.env.QUO_WEBHOOK_SECRET;
});

describe("Quo webhook", () => {
  it("rejects unsigned events before persistence", async () => {
    const response = await POST(
      signedRequest(
        { id: "EV1", type: "message.received" },
        { badSignature: true },
      ),
    );
    expect(response.status).toBe(401);
    expect(mocks.ingestSmsProviderEvent).not.toHaveBeenCalled();
  });

  it("persists an inbound text before projecting it", async () => {
    const response = await POST(
      signedRequest({
        id: "EV1",
        type: "message.received",
        data: {
          resource: {
            id: "AC-msg-1",
            direction: "incoming",
            text: "STOP",
            status: "received",
            createdAt: new Date().toISOString(),
          },
          context,
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.ingestSmsProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "quo",
        kind: "inbound",
        providerEventId: "EV1",
        providerMessageId: "AC-msg-1",
        fromE164: "+15555550199",
        toE164: "+18133413102",
        messagingProfileId: "PN1",
        messageBody: "STOP",
        inboundClassification: "stop",
      }),
    );
    expect(mocks.projectSmsProviderEvent).toHaveBeenCalled();
  });

  it("records delivery only for texts OpenVPM sent", async () => {
    const event = {
      id: "EV2",
      type: "message.delivered",
      data: {
        resource: {
          id: "AC-out-1",
          direction: "outgoing",
          status: "delivered",
        },
        context,
      },
    };
    await POST(signedRequest(event));
    expect(mocks.ingestSmsProviderEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "quo",
        kind: "delivery",
        providerMessageId: "AC-out-1",
        providerEventType: "message.delivered",
        deliveryClassification: "delivered",
      }),
    );

    vi.clearAllMocks();
    mocks.openVpmSentThroughQuo.mockResolvedValue(false);
    const response = await POST(signedRequest(event));
    expect(response.status).toBe(200);
    expect(mocks.ingestSmsProviderEvent).not.toHaveBeenCalled();
  });

  it("logs completed calls and voicemails", async () => {
    await POST(
      signedRequest({
        id: "EV3",
        type: "call.completed",
        data: {
          resource: {
            id: "AC-call",
            direction: "incoming",
            status: "unanswered",
            createdAt: "2026-11-01T12:00:00.000Z",
            duration: 0,
            hasVoicemail: true,
          },
          context,
          links: { quo: "https://my.quo.com/inbox/x" },
        },
      }),
    );
    expect(mocks.logQuoCallActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "call",
        callId: "AC-call",
        phoneNumberId: "PN1",
        direction: "inbound",
        externalPhone: "+15555550199",
        status: "unanswered",
        hasVoicemail: true,
        quoLink: "https://my.quo.com/inbox/x",
      }),
    );

    await POST(
      signedRequest({
        id: "EV4",
        type: "call.voicemail.completed",
        data: {
          resource: {
            id: "AC-vm",
            voicemailId: "VM1",
            from: "+15555550199",
            to: "+18133413102",
            transcript: "Please call back",
            duration: 12,
          },
          context,
        },
      }),
    );
    expect(mocks.logQuoCallActivity).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "voicemail",
        voicemailId: "VM1",
        externalPhone: "+15555550199",
        transcript: "Please call back",
      }),
    );
  });

  it("logs the AI agent's call notes once the summary is ready", async () => {
    const summaryEvent = (processingStatus: string) => ({
      id: "EV6",
      type: "call.summary.completed",
      createdAt: "2026-11-01T12:02:00.000Z",
      data: {
        resource: {
          callId: "AC-call",
          processingStatus,
          summary: ["Caller wants a visit."],
          nextSteps: ["Call back."],
          fromPhoneNumber: null,
          handledByAiAgent: true,
          jobs: [
            {
              name: "Intake",
              result: {
                data: [
                  { name: "Name", value: "Jane" },
                  { name: "Pets", value: 2 },
                ],
              },
            },
          ],
        },
        context,
      },
    });
    await POST(signedRequest(summaryEvent("in-progress")));
    expect(mocks.logQuoCallActivity).not.toHaveBeenCalled();

    await POST(signedRequest(summaryEvent("completed")));
    expect(mocks.logQuoCallActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "summary",
        callId: "AC-call",
        phoneNumberId: "PN1",
        externalPhone: "+15555550199",
        handledByAiAgent: true,
        summary: ["Caller wants a visit."],
        nextSteps: ["Call back."],
        details: [
          { name: "Name", value: "Jane" },
          { name: "Pets", value: "2" },
        ],
      }),
    );
  });

  it("acknowledges events it does not use", async () => {
    const response = await POST(
      signedRequest({
        id: "EV5",
        type: "call.ringing",
        data: { resource: { id: "AC-call" }, context },
      }),
    );
    expect(response.status).toBe(200);
    expect(mocks.ingestSmsProviderEvent).not.toHaveBeenCalled();
    expect(mocks.logQuoCallActivity).not.toHaveBeenCalled();
  });
});
