import {
  ChannelProtocol,
  ChannelRole,
  CreateSignalingChannelCommand,
  DeleteSignalingChannelCommand,
  DescribeSignalingChannelCommand,
  GetSignalingChannelEndpointCommand,
  KinesisVideoClient,
  ResourceInUseException,
  ResourceNotFoundException,
} from "@aws-sdk/client-kinesis-video";
import {
  GetIceServerConfigCommand,
  KinesisVideoSignalingClient,
} from "@aws-sdk/client-kinesis-video-signaling";
import { Hash } from "@smithy/hash-node";
import { SignatureV4 } from "@smithy/signature-v4";

/**
 * Video visits run as plain WebRTC between the clinician's and the client's
 * browsers. Amazon Kinesis Video Streams only introduces the two (signaling)
 * and, when a direct path is blocked, relays the media (TURN). Each visit
 * gets its own signaling channel in the clinic's AWS account; it is deleted
 * when the visit ends. Calls are never recorded by the service.
 */

const AWS_TIMEOUT_MS = 15_000;
/** Signed signaling links only need to live long enough to connect. */
const SIGNED_URL_TTL_SECONDS = 299;
const CHANNEL_PREFIX = "openvpm-visit-";

interface VideoConfig {
  region: string;
  credentials: { accessKeyId: string; secretAccessKey: string };
  /** Overridable only so tests can point at a local stand-in. */
  endpoint?: string;
}

function env(name: string): string | undefined {
  const trimmed = process.env[name]?.trim();
  return trimmed ? trimmed : undefined;
}

function videoConfig(): VideoConfig | null {
  if (env("TELEHEALTH_VIDEO") !== "aws_kvs") return null;
  const region =
    env("TELEHEALTH_VIDEO_REGION") ??
    env("VISIT_RECORDING_TRANSCRIBE_REGION") ??
    env("S3_REGION");
  const accessKeyId = env("S3_ACCESS_KEY");
  const secretAccessKey = env("S3_SECRET_KEY");
  if (!region || !/^[a-z0-9-]{4,32}$/.test(region)) return null;
  if (!accessKeyId || !secretAccessKey) return null;
  return {
    region,
    credentials: { accessKeyId, secretAccessKey },
    endpoint: env("KVS_ENDPOINT"),
  };
}

/** The region video signaling runs in, for the content security policy. */
export function telehealthVideoRegion(): string | null {
  return videoConfig()?.region ?? null;
}

export function telehealthVideoConfigured(): boolean {
  return videoConfig() !== null;
}

export class TelehealthVideoUnavailableError extends Error {
  constructor(message = "Video visits are not set up on this server.") {
    super(message);
    this.name = "TelehealthVideoUnavailableError";
  }
}

function requireConfig(): VideoConfig {
  const config = videoConfig();
  if (!config) throw new TelehealthVideoUnavailableError();
  return config;
}

function controlPlane(config: VideoConfig): KinesisVideoClient {
  return new KinesisVideoClient({
    region: config.region,
    credentials: config.credentials,
    endpoint: config.endpoint,
    requestHandler: { requestTimeout: AWS_TIMEOUT_MS },
  });
}

export function visitChannelName(visitId: string): string {
  return `${CHANNEL_PREFIX}${visitId}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Create the visit's private signaling channel and wait until it is usable. */
export async function createVisitChannel(visitId: string): Promise<{ channelArn: string }> {
  const config = requireConfig();
  const client = controlPlane(config);
  const ChannelName = visitChannelName(visitId);
  let channelArn: string | undefined;
  try {
    const created = await client.send(
      new CreateSignalingChannelCommand({
        ChannelName,
        ChannelType: "SINGLE_MASTER",
        SingleMasterConfiguration: { MessageTtlSeconds: 60 },
      }),
    );
    channelArn = created.ChannelARN;
  } catch (error) {
    // A retry after a timeout finds the channel it already made.
    if (!(error instanceof ResourceInUseException)) throw error;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { ChannelInfo } = await client.send(
      new DescribeSignalingChannelCommand(
        channelArn ? { ChannelARN: channelArn } : { ChannelName },
      ),
    );
    channelArn = ChannelInfo?.ChannelARN ?? channelArn;
    if (ChannelInfo?.ChannelStatus === "ACTIVE" && channelArn) return { channelArn };
    if (ChannelInfo?.ChannelStatus === "DELETING") break;
    await sleep(500);
  }
  throw new TelehealthVideoUnavailableError("The video call could not be set up. Try again.");
}

export type VideoConnection = {
  /** Signed wss:// link to the visit's signaling channel. */
  signalingUrl: string;
  iceServers: { urls: string[]; username?: string; credential?: string }[];
  role: "MASTER" | "VIEWER";
  clientId: string | null;
};

function strictEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Presign the signaling WebSocket so the browser never holds AWS keys. */
export async function signSignalingUrl(input: {
  endpoint: string;
  channelArn: string;
  clientId: string | null;
  region: string;
  credentials: VideoConfig["credentials"];
  signingDate?: Date;
}): Promise<string> {
  const endpoint = new URL(input.endpoint);
  const query: Record<string, string> = { "X-Amz-ChannelARN": input.channelArn };
  if (input.clientId) query["X-Amz-ClientId"] = input.clientId;
  const signer = new SignatureV4({
    service: "kinesisvideo",
    region: input.region,
    credentials: input.credentials,
    sha256: Hash.bind(null, "sha256"),
  });
  const signed = await signer.presign(
    {
      method: "GET",
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      port: endpoint.port ? Number(endpoint.port) : undefined,
      path: "/",
      query,
      headers: { host: endpoint.host },
    },
    { expiresIn: SIGNED_URL_TTL_SECONDS, signingDate: input.signingDate },
  );
  const search = Object.entries(signed.query ?? {})
    .map(([key, value]) => `${strictEncode(key)}=${strictEncode(String(value))}`)
    .join("&");
  return `${endpoint.protocol}//${endpoint.host}/?${search}`;
}

/**
 * One person's way into a visit's call: the clinician connects as the
 * channel's master, the client as a viewer with its own client id.
 */
export async function channelConnection(input: {
  channelArn: string;
  role: "MASTER" | "VIEWER";
  clientId?: string;
}): Promise<VideoConnection> {
  const config = requireConfig();
  const clientId = input.role === "VIEWER" ? (input.clientId ?? null) : null;
  if (input.role === "VIEWER" && !clientId) throw new TelehealthVideoUnavailableError();
  const { ResourceEndpointList } = await controlPlane(config).send(
    new GetSignalingChannelEndpointCommand({
      ChannelARN: input.channelArn,
      SingleMasterChannelEndpointConfiguration: {
        Protocols: [ChannelProtocol.WSS, ChannelProtocol.HTTPS],
        Role: input.role === "MASTER" ? ChannelRole.MASTER : ChannelRole.VIEWER,
      },
    }),
  );
  const endpointFor = (protocol: string) =>
    ResourceEndpointList?.find((entry) => entry.Protocol === protocol)?.ResourceEndpoint;
  const wss = endpointFor("WSS");
  const https = endpointFor("HTTPS");
  if (!wss || !https) throw new TelehealthVideoUnavailableError();

  const signaling = new KinesisVideoSignalingClient({
    region: config.region,
    credentials: config.credentials,
    endpoint: https,
    requestHandler: { requestTimeout: AWS_TIMEOUT_MS },
  });
  const { IceServerList } = await signaling.send(
    new GetIceServerConfigCommand({
      ChannelARN: input.channelArn,
      ClientId: clientId ?? undefined,
      Service: "TURN",
    }),
  );
  const iceServers: VideoConnection["iceServers"] = [
    { urls: [`stun:stun.kinesisvideo.${config.region}.amazonaws.com:443`] },
    ...(IceServerList ?? []).map((server) => ({
      urls: server.Uris ?? [],
      username: server.Username,
      credential: server.Password,
    })),
  ];

  const signalingUrl = await signSignalingUrl({
    endpoint: wss,
    channelArn: input.channelArn,
    clientId,
    region: config.region,
    credentials: config.credentials,
  });
  return { signalingUrl, iceServers, role: input.role, clientId };
}

/** Delete the channel so nobody can reconnect to a finished visit. */
export async function deleteVisitChannel(channelArn: string): Promise<void> {
  const config = requireConfig();
  try {
    await controlPlane(config).send(new DeleteSignalingChannelCommand({ ChannelARN: channelArn }));
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return;
    throw error;
  }
}
