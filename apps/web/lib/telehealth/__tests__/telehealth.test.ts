import { afterEach, describe, expect, it, vi } from "vitest";
import { KinesisVideoClient } from "@aws-sdk/client-kinesis-video";
import { KinesisVideoSignalingClient } from "@aws-sdk/client-kinesis-video-signaling";
import {
  channelConnection,
  createVisitChannel,
  deleteVisitChannel,
  signSignalingUrl,
  telehealthVideoConfigured,
} from "../kvs";
import { telehealthSettings, TELEHEALTH_REASONS } from "../visits";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const CHANNEL_ARN =
  "arn:aws:kinesisvideo:us-east-2:111122223333:channel/openvpm-visit-abc/1700000000000";

function stubVideo() {
  vi.stubEnv("TELEHEALTH_VIDEO", "aws_kvs");
  vi.stubEnv("TELEHEALTH_VIDEO_REGION", "");
  vi.stubEnv("VISIT_RECORDING_TRANSCRIBE_REGION", "");
  vi.stubEnv("S3_REGION", "us-east-2");
  vi.stubEnv("S3_ACCESS_KEY", "AKIDEXAMPLE");
  vi.stubEnv("S3_SECRET_KEY", "secret-example");
  vi.stubEnv("KVS_ENDPOINT", "");
}

describe("telehealthSettings", () => {
  it("treats missing or malformed settings as not accepting", () => {
    expect(telehealthSettings(null).accepting).toBe(false);
    expect(telehealthSettings({ telehealth: "yes" }).accepting).toBe(false);
    expect(
      telehealthSettings({ telehealth: { accepting: "true" } }).accepting,
    ).toBe(false);
    expect(
      telehealthSettings({ telehealth: { accepting: true } }).accepting,
    ).toBe(true);
  });

  it("offers a fixed list of visit reasons", () => {
    expect(TELEHEALTH_REASONS).toContain("Something else");
  });
});

describe("Amazon video channels", () => {
  it("is off unless turned on with a region and credentials", () => {
    stubVideo();
    expect(telehealthVideoConfigured()).toBe(true);
    vi.stubEnv("TELEHEALTH_VIDEO", "");
    expect(telehealthVideoConfigured()).toBe(false);
    stubVideo();
    vi.stubEnv("S3_SECRET_KEY", "");
    expect(telehealthVideoConfigured()).toBe(false);
    stubVideo();
    vi.stubEnv("S3_REGION", "not a region!");
    expect(telehealthVideoConfigured()).toBe(false);
  });

  it("creates one single-master channel per visit and waits for it", async () => {
    stubVideo();
    const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
    let describes = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(KinesisVideoClient.prototype, "send").mockImplementation(async (command: any) => {
      sent.push({ name: command.constructor.name, input: command.input });
      if (command.constructor.name === "CreateSignalingChannelCommand") return { ChannelARN: CHANNEL_ARN };
      describes += 1;
      return { ChannelInfo: { ChannelARN: CHANNEL_ARN, ChannelStatus: describes > 1 ? "ACTIVE" : "CREATING" } };
    });
    await expect(createVisitChannel("abc")).resolves.toEqual({ channelArn: CHANNEL_ARN });
    expect(sent[0]).toMatchObject({
      name: "CreateSignalingChannelCommand",
      input: { ChannelName: "openvpm-visit-abc", ChannelType: "SINGLE_MASTER" },
    });
    expect(describes).toBe(2);
  });

  it("signs a viewer connection without handing out the secret key", async () => {
    stubVideo();
    vi.spyOn(KinesisVideoClient.prototype, "send").mockImplementation(async () => ({
      ResourceEndpointList: [
        { Protocol: "WSS", ResourceEndpoint: "wss://v-1234.kinesisvideo.us-east-2.amazonaws.com" },
        { Protocol: "HTTPS", ResourceEndpoint: "https://r-1234.kinesisvideo.us-east-2.amazonaws.com" },
      ],
    }));
    vi.spyOn(KinesisVideoSignalingClient.prototype, "send").mockImplementation(async () => ({
      IceServerList: [{ Uris: ["turn:1.2.3.4:443?transport=udp"], Username: "u", Password: "p", Ttl: 300 }],
    }));
    const connection = await channelConnection({ channelArn: CHANNEL_ARN, role: "VIEWER", clientId: "client-1" });
    const url = new URL(connection.signalingUrl);
    expect(url.protocol).toBe("wss:");
    expect(url.host).toBe("v-1234.kinesisvideo.us-east-2.amazonaws.com");
    expect(url.searchParams.get("X-Amz-ChannelARN")).toBe(CHANNEL_ARN);
    expect(url.searchParams.get("X-Amz-ClientId")).toBe("client-1");
    expect(url.searchParams.get("X-Amz-Credential")).toMatch(/^AKIDEXAMPLE\/\d{8}\/us-east-2\/kinesisvideo\/aws4_request$/);
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(connection.signalingUrl).not.toContain("secret-example");
    expect(connection.iceServers[0]!.urls[0]).toBe("stun:stun.kinesisvideo.us-east-2.amazonaws.com:443");
    expect(connection.iceServers[1]).toEqual({ urls: ["turn:1.2.3.4:443?transport=udp"], username: "u", credential: "p" });
  });

  it("matches an independent SigV4 reference signature", async () => {
    // Reference value computed by hand from the SigV4 spec for these inputs.
    const url = new URL(
      await signSignalingUrl({
        endpoint: "wss://v-1.kinesisvideo.us-east-2.amazonaws.com",
        channelArn:
          "arn:aws:kinesisvideo:us-east-2:111122223333:channel/openvpm-visit-abc/1700000000000",
        clientId: "client-1",
        region: "us-east-2",
        credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret-example" },
        signingDate: new Date("2026-01-02T03:04:05Z"),
      }),
    );
    expect(url.searchParams.get("X-Amz-Date")).toBe("20260102T030405Z");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("299");
    expect(url.searchParams.get("X-Amz-Signature")).toBe(
      "dae81c0a6f88f1ef208837d69439268916c1bfac05ea5b7fa0aa2abb64d47e81",
    );
  });

  it("treats an already-deleted channel as closed", async () => {
    stubVideo();
    const { ResourceNotFoundException } = await import("@aws-sdk/client-kinesis-video");
    vi.spyOn(KinesisVideoClient.prototype, "send").mockImplementation(async () => {
      throw new ResourceNotFoundException({ message: "gone", $metadata: {} });
    });
    await expect(deleteVisitChannel(CHANNEL_ARN)).resolves.toBeUndefined();
  });
});

describe("security headers for video visits", () => {
  async function headersWith(video: string, region: string) {
    vi.stubEnv("TELEHEALTH_VIDEO", video);
    vi.stubEnv("TELEHEALTH_VIDEO_REGION", region);
    vi.stubEnv("KVS_ENDPOINT", "");
    vi.resetModules();
    const mod = await import("../../security-headers.js");
    const byKey = Object.fromEntries(
      (mod.securityHeaders as Array<{ key: string; value: string }>).map(
        (h) => [h.key, h.value],
      ),
    );
    return byKey;
  }

  it("allows only the region's signaling endpoint and this site's camera", async () => {
    const headers = await headersWith("aws_kvs", "us-east-2");
    expect(headers["Content-Security-Policy"]).toMatch(
      /connect-src [^;]*wss:\/\/\*\.kinesisvideo\.us-east-2\.amazonaws\.com/,
    );
    expect(headers["Content-Security-Policy"]).not.toContain("frame-src");
    expect(headers["Content-Security-Policy"]).not.toContain("'unsafe-eval'");
    expect(headers["Permissions-Policy"]).toContain("camera=(self)");
    expect(headers["Permissions-Policy"]).toContain("microphone=(self)");
  });

  it("keeps the camera blocked when video visits are not configured", async () => {
    const headers = await headersWith("", "us-east-2");
    expect(headers["Content-Security-Policy"]).not.toContain("kinesisvideo");
    expect(headers["Permissions-Policy"]).toContain("camera=()");
  });
});
