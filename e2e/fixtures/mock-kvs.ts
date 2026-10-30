import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * A local stand-in for Amazon Kinesis Video Streams signaling, for browser
 * tests of video visits. It answers the control-plane calls the server makes
 * (create, describe, endpoint, ICE servers, delete) and relays signaling
 * messages between the clinician (master) and a client (viewer) over a
 * WebSocket, the way the real service does. Media still flows directly
 * between the two browsers.
 */
export type MockKvs = {
  /** Calls and socket events in order, for assertions. */
  log: string[];
  /** Channels that exist now, by ARN. */
  channels: Map<string, string>;
  close: () => Promise<void>;
};

export async function startMockKvs(port: number): Promise<MockKvs> {
  const origin = `127.0.0.1:${port}`;
  const log: string[] = [];
  const channels = new Map<string, string>();
  let master: WebSocket | null = null;
  const viewers = new Map<string, WebSocket>();

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      const input = body ? (JSON.parse(body) as Record<string, string>) : {};
      // The server must sign every call with its AWS credentials.
      const signed = /AWS4-HMAC-SHA256 Credential=\S+\/kinesisvideo\/aws4_request/.test(
        req.headers.authorization ?? "",
      );
      log.push(`${path} signed=${signed}`);
      res.setHeader("content-type", "application/json");
      const reply = (value: unknown) => res.end(JSON.stringify(value));
      switch (path) {
        case "/createSignalingChannel": {
          const arn = `arn:aws:kinesisvideo:us-east-2:111122223333:channel/${input.ChannelName}/1700000000000`;
          channels.set(arn, input.ChannelName!);
          return reply({ ChannelARN: arn });
        }
        case "/describeSignalingChannel": {
          const arn =
            input.ChannelARN ?? [...channels].find(([, name]) => name === input.ChannelName)?.[0];
          return reply({ ChannelInfo: { ChannelARN: arn, ChannelStatus: "ACTIVE" } });
        }
        case "/getSignalingChannelEndpoint":
          return reply({
            ResourceEndpointList: [
              { Protocol: "WSS", ResourceEndpoint: `ws://${origin}` },
              { Protocol: "HTTPS", ResourceEndpoint: `http://${origin}` },
            ],
          });
        case "/deleteSignalingChannel":
          channels.delete(input.ChannelARN!);
          return reply({});
        case "/v1/get-ice-server-config":
          return reply({ IceServerList: [] });
        default:
          res.statusCode = 404;
          return reply({});
      }
    });
  });

  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket, req) => {
    const query = new URL(req.url ?? "/", "http://x").searchParams;
    if (!query.get("X-Amz-Signature") || !channels.has(query.get("X-Amz-ChannelARN") ?? "")) {
      log.push("socket rejected");
      socket.close();
      return;
    }
    const clientId = query.get("X-Amz-ClientId");
    log.push(clientId ? "socket viewer" : "socket master");
    if (clientId) viewers.set(clientId, socket);
    else master = socket;
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as {
        action: string;
        messagePayload: string;
        recipientClientId?: string;
      };
      log.push(`${clientId ? "viewer" : "master"} ${message.action}`);
      const relayed = JSON.stringify({
        messageType: message.action,
        messagePayload: message.messagePayload,
        senderClientId: clientId ?? undefined,
      });
      if (clientId) master?.send(relayed);
      else if (message.recipientClientId) viewers.get(message.recipientClientId)?.send(relayed);
    });
    socket.on("close", () => {
      if (clientId) viewers.delete(clientId);
      else if (master === socket) master = null;
    });
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    log,
    channels,
    close: () =>
      new Promise((resolve) => {
        for (const client of sockets.clients) client.terminate();
        sockets.close();
        server.close(() => resolve());
      }),
  };
}
