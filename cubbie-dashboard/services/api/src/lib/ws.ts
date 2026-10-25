import { ApiGatewayManagementApiClient, GoneException, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import type { RealtimeEvent, RelayOutbound } from "@cubbie/shared";
import { listConnections, removeConnection } from "./db";
import { env } from "./env";

let client: ApiGatewayManagementApiClient | null = null;
const mgmt = () => (client ??= new ApiGatewayManagementApiClient({ endpoint: env.wsEndpoint }));

async function post(connectionId: string, data: unknown) {
  try {
    await mgmt().send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(JSON.stringify(data)) }));
    return true;
  } catch (err) {
    if (err instanceof GoneException || (err as { name?: string }).name === "GoneException") { await removeConnection(connectionId); return false; }
    throw err;
  }
}

/** Push an event to every open browser tab of this student. */
export async function pushToWeb(sub: string, event: RealtimeEvent) {
  const conns = (await listConnections(sub)).filter(c => c.role === "web");
  await Promise.all(conns.map(c => post(c.connectionId, event)));
}

/** Send a command to the student's iMessage relay. Returns false when no relay is online. */
export async function pushToRelay(sub: string, msg: RelayOutbound) {
  const conns = (await listConnections(sub)).filter(c => c.role === "relay");
  const results = await Promise.all(conns.map(c => post(c.connectionId, msg)));
  return results.some(Boolean);
}

export const relayOnline = async (sub: string) => (await listConnections(sub)).some(c => c.role === "relay");
