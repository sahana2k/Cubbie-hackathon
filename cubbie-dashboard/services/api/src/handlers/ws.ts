import type { APIGatewayProxyResultV2, APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import type { ChatMessage, RelayInbound } from "@cubbie/shared";
import { sha256, verifyIdToken } from "../lib/auth";
import * as db from "../lib/db";
import { pushToWeb } from "../lib/ws";

type ConnectEvent = APIGatewayProxyWebsocketEventV2 & { queryStringParameters?: Record<string, string> };
const ok = { statusCode: 200, body: "" };

/**
 * $connect: browsers send ?token=<Cognito ID token>&role=web; the Mac relay sends ?device=<relay token>&role=relay.
 */
export async function connect(event: ConnectEvent): Promise<APIGatewayProxyResultV2> {
  const q = event.queryStringParameters ?? {};
  const connectionId = event.requestContext.connectionId;
  try {
    if (q.role === "relay" && q.device) {
      const dev = await db.getItem<{ sub: string; deviceId: string }>(`DEVTOKEN#${sha256(q.device)}`, "META");
      if (!dev) return { statusCode: 401, body: "Unknown relay token" };
      await db.addConnection(dev.sub, { connectionId, role: "relay", deviceId: dev.deviceId });
      await notifyStatus(dev.sub);
      return ok;
    }
    if (q.token) {
      const user = await verifyIdToken(q.token);
      await db.addConnection(user.sub, { connectionId, role: "web" });
      return ok;
    }
    return { statusCode: 401, body: "Missing credentials" };
  } catch {
    return { statusCode: 401, body: "Invalid credentials" };
  }
}

export async function disconnect(event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResultV2> {
  const meta = await db.removeConnection(event.requestContext.connectionId);
  if (meta && (meta as { role?: string }).role === "relay") await notifyStatus(meta.sub);
  return ok;
}

/** $default: frames from the relay (new iMessages in the Cubbie thread, send confirmations). */
export async function message(event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResultV2> {
  const owner = await db.connectionOwner(event.requestContext.connectionId);
  if (!owner || owner.role !== "relay") return { statusCode: 403, body: "" };
  let frame: RelayInbound;
  try { frame = JSON.parse(event.body ?? "{}"); } catch { return { statusCode: 400, body: "" }; }

  switch (frame.action) {
    case "relay.hello":
      await db.putItem({ PK: db.U(owner.sub), SK: "DEVICE#primary", ...(await db.getItem(db.U(owner.sub), "DEVICE#primary")), name: frame.device.slice(0, 60), version: frame.version.slice(0, 20), lastSeen: new Date().toISOString() });
      await notifyStatus(owner.sub);
      break;
    case "imessage.upsert": {
      const m = frame.message;
      if (!m?.guid || typeof m.text !== "string") break;
      const msg: ChatMessage = { id: m.guid, guid: m.guid, direction: m.fromMe ? "out" : "in", text: m.text.slice(0, 8000), at: m.at, status: m.fromMe ? (m.status ?? "delivered") : undefined };
      await db.upsertMessage(owner.sub, msg); // stream fan-out pushes it to the browser
      break;
    }
    case "imessage.sent":
      await db.setMessageStatus(owner.sub, frame.clientId, frame.ok ? "delivered" : "failed", frame.guid);
      break;
  }
  return ok;
}

async function notifyStatus(sub: string) {
  const [profile, conns, dev] = await Promise.all([db.getProfile(sub), db.listConnections(sub), db.getItem(db.U(sub), "DEVICE#primary")]);
  await pushToWeb(sub, {
    type: "status",
    status: {
      mode: "live",
      imessageRelay: conns.some(c => c.role === "relay") ? "online" : dev ? "offline" : "not_set_up",
      relayDevice: (dev?.name as string | undefined) ?? null,
      discord: profile.discordUserId ? "linked" : "not_linked",
      discordGuild: profile.discordGuild ?? null,
      lastCubbieSync: profile.lastCubbieSync ?? null
    }
  });
}
