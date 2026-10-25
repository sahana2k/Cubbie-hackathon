import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { BatchWriteCommand, type BatchWriteCommandOutput, DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { ChatMessage, DiscordMessage, Task } from "@cubbie/shared";
import { env } from "./env";

/**
 * Single-table design (table: TABLE_NAME, PK/SK strings, TTL attribute "ttl", stream NEW_AND_OLD_IMAGES)
 *
 *  PK                     SK                      item
 *  USER#{sub}             PROFILE                 timezone, discordUserId, discordGuild, lastCubbieSync
 *  USER#{sub}             TASK#{id}               Task
 *  USER#{sub}             MSG#{at}#{id}           ChatMessage (Cubbie thread only)
 *  USER#{sub}             MSGID#{id}              pointer to the MSG sort key, for status updates
 *  USER#{sub}             DC#{at}#{id}            mirrored Discord message (ttl 30 days)
 *  USER#{sub}             CONN#{connectionId}     open WebSocket: role web | relay
 *  USER#{sub}             DEVICE#{id}             iMessage relay device (name, lastSeen)
 *  USER#{sub}             INGESTKEY#{id}          Cubbie sync key metadata
 *  CONN#{connectionId}    META                    reverse lookup: sub, role
 *  DEVTOKEN#{sha256}      META                    relay token hash -> sub, deviceId
 *  INGESTKEY#{sha256}     META                    sync key hash -> sub
 *  DISCORD#{userId}       LINK                    Discord user -> sub
 *  CHANNEL#{channelId}    SUB#{sub}               Discord channels a student mirrors
 *  LINKCODE#{code}        META                    one-time Discord link code (ttl 10 min)
 */
export const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const T = () => env.table;
export const U = (sub: string) => `USER#${sub}`;
const ttlIn = (seconds: number) => Math.floor(Date.now() / 1000) + seconds;

export async function getItem<T = Record<string, unknown>>(PK: string, SK: string) {
  const r = await doc.send(new GetCommand({ TableName: T(), Key: { PK, SK } }));
  return r.Item as T | undefined;
}
export async function putItem(item: Record<string, unknown>) { await doc.send(new PutCommand({ TableName: T(), Item: item })); }
export async function deleteItem(PK: string, SK: string) { await doc.send(new DeleteCommand({ TableName: T(), Key: { PK, SK } })); }

async function queryAll<T>(PK: string, prefix: string, opts: { limit?: number; newestFirst?: boolean } = {}): Promise<T[]> {
  const out: T[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await doc.send(new QueryCommand({
      TableName: T(), KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": PK, ":sk": prefix }, ExclusiveStartKey,
      ScanIndexForward: !opts.newestFirst, Limit: opts.limit
    }));
    out.push(...((r.Items ?? []) as T[]));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey && (!opts.limit || out.length < opts.limit));
  return opts.limit ? out.slice(0, opts.limit) : out;
}

const strip = <T>(item: Record<string, unknown>): T => {
  const { PK, SK, ttl, entity, ...rest } = item; void PK; void SK; void ttl; void entity;
  return rest as T;
};

// ---------- tasks ----------
export const listTasks = async (sub: string) => (await queryAll<Record<string, unknown>>(U(sub), "TASK#")).map(i => strip<Task>(i));
export const getTask = async (sub: string, id: string) => { const i = await getItem(U(sub), `TASK#${id}`); return i ? strip<Task>(i) : undefined; };
export const putTask = (sub: string, t: Task) => putItem({ PK: U(sub), SK: `TASK#${t.id}`, entity: "task", sub, ...t });
export const deleteTask = (sub: string, id: string) => deleteItem(U(sub), `TASK#${id}`);

export async function putTasksBatch(sub: string, tasks: Task[]) {
  for (let i = 0; i < tasks.length; i += 25) {
    let RequestItems: Record<string, any> | undefined = {
      [T()]: tasks.slice(i, i + 25).map(t => ({ PutRequest: { Item: { PK: U(sub), SK: `TASK#${t.id}`, entity: "task", sub, ...t } } }))
    };
    for (let attempt = 0; RequestItems && Object.keys(RequestItems).length && attempt < 5; attempt++) {
      const r: BatchWriteCommandOutput = await doc.send(new BatchWriteCommand({ RequestItems }));
      RequestItems = r.UnprocessedItems && Object.keys(r.UnprocessedItems).length ? r.UnprocessedItems : undefined;
      if (RequestItems) await new Promise(res => setTimeout(res, 100 * 2 ** attempt));
    }
  }
}

// ---------- chat ----------
export async function listMessages(sub: string, limit = 200) {
  const items = await queryAll<Record<string, unknown>>(U(sub), "MSG#", { limit, newestFirst: true });
  return items.map(i => strip<ChatMessage>(i)).reverse();
}
export async function upsertMessage(sub: string, m: ChatMessage) {
  const ref = await getItem<{ msgSk: string }>(U(sub), `MSGID#${m.id}`);
  const msgSk = ref?.msgSk ?? `MSG#${m.at}#${m.id}`;
  await putItem({ PK: U(sub), SK: msgSk, entity: "chat", sub, ...m });
  if (!ref) await putItem({ PK: U(sub), SK: `MSGID#${m.id}`, msgSk });
}
export async function setMessageStatus(sub: string, id: string, status: ChatMessage["status"], guid?: string) {
  const ref = await getItem<{ msgSk: string }>(U(sub), `MSGID#${id}`);
  if (!ref) return;
  await doc.send(new UpdateCommand({
    TableName: T(), Key: { PK: U(sub), SK: ref.msgSk },
    UpdateExpression: guid ? "SET #s = :s, guid = :g" : "SET #s = :s",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: guid ? { ":s": status, ":g": guid } : { ":s": status }
  }));
  if (guid) await putItem({ PK: U(sub), SK: `MSGID#${guid}`, msgSk: ref.msgSk });
}

// ---------- discord mirror ----------
export async function listDiscord(sub: string, limit = 100) {
  const items = await queryAll<Record<string, unknown>>(U(sub), "DC#", { limit, newestFirst: true });
  return items.map(i => strip<DiscordMessage>(i)).reverse();
}
export const putDiscord = (sub: string, m: DiscordMessage) => putItem({ PK: U(sub), SK: `DC#${m.at}#${m.id}`, entity: "discord", sub, ttl: ttlIn(30 * 86400), ...m });

// ---------- websocket connections ----------
export type Conn = { connectionId: string; role: "web" | "relay"; deviceId?: string };
export async function addConnection(sub: string, c: Conn) {
  await putItem({ PK: U(sub), SK: `CONN#${c.connectionId}`, entity: "conn", ttl: ttlIn(86400), ...c });
  await putItem({ PK: `CONN#${c.connectionId}`, SK: "META", sub, ttl: ttlIn(86400), ...c });
}
export async function removeConnection(connectionId: string) {
  const meta = await getItem<{ sub: string }>(`CONN#${connectionId}`, "META");
  if (meta) await deleteItem(U(meta.sub), `CONN#${connectionId}`);
  await deleteItem(`CONN#${connectionId}`, "META");
  return meta;
}
export const connectionOwner = (connectionId: string) => getItem<{ sub: string; role: Conn["role"]; deviceId?: string }>(`CONN#${connectionId}`, "META");
export const listConnections = (sub: string) => queryAll<Conn>(U(sub), "CONN#");

// ---------- profile ----------
export type Profile = { timezone?: string; discordUserId?: string; discordGuild?: string; lastCubbieSync?: string; mirrorChannels?: string[] };
export const getProfile = async (sub: string) => (await getItem<Profile>(U(sub), "PROFILE")) ?? {};
export async function patchProfile(sub: string, patch: Profile) {
  const keys = Object.keys(patch) as (keyof Profile)[];
  if (!keys.length) return;
  await doc.send(new UpdateCommand({
    TableName: T(), Key: { PK: U(sub), SK: "PROFILE" },
    UpdateExpression: "SET " + keys.map((_, i) => `#k${i} = :v${i}`).join(", "),
    ExpressionAttributeNames: Object.fromEntries(keys.map((k, i) => [`#k${i}`, k])),
    ExpressionAttributeValues: Object.fromEntries(keys.map((k, i) => [`:v${i}`, patch[k]]))
  }));
}
export { ttlIn };
