import { randomUUID } from "node:crypto";
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from "aws-lambda";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { SendChatSchema, SendDiscordSchema, TaskInputSchema, TaskPatchSchema, type ChatMessage, type IntegrationStatus, type Task } from "@cubbie/shared";
import { z } from "zod";
import { newSecret, sha256, userFrom } from "../lib/auth";
import * as db from "../lib/db";
import { sendChannelMessage } from "../lib/discord";
import { env } from "../lib/env";
import { HttpError, json, parseBody, toResponse } from "../lib/http";
import { appsList, dueList, gradingList } from "../lib/text";
import { relayOnline } from "../lib/ws";

/**
 * One Lambda for the authenticated HTTP API (fewer cold starts, one place for auth and errors).
 * Routes are declared in infra/lib/api.ts and all point here.
 */
type Ctx = { sub: string; email?: string; event: APIGatewayProxyEventV2WithJWTAuthorizer; params: Record<string, string> };
type Route = [method: string, pattern: RegExp, handler: (c: Ctx) => Promise<APIGatewayProxyResultV2>];

const routes: Route[] = [
  ["GET", /^\/tasks$/, async ({ sub }) => json(200, { items: await db.listTasks(sub) })],

  ["POST", /^\/tasks$/, async ({ sub, event }) => {
    const input = parseBody(event, TaskInputSchema);
    const now = new Date().toISOString();
    const task: Task = { progress: 0, ...input, id: input.id ?? randomUUID(), createdAt: now, updatedAt: now } as Task;
    await db.putTask(sub, task);
    return json(201, task);
  }],

  ["PATCH", /^\/tasks\/(?<id>[^/]+)$/, async ({ sub, event, params }) => {
    const patch = parseBody(event, TaskPatchSchema);
    const cur = await db.getTask(sub, params.id);
    if (!cur) throw new HttpError(404, "That card no longer exists");
    const task = { ...cur, ...patch, id: cur.id, createdAt: cur.createdAt, updatedAt: new Date().toISOString() } as Task;
    await db.putTask(sub, task);
    return json(200, task);
  }],

  ["DELETE", /^\/tasks\/(?<id>[^/]+)$/, async ({ sub, params }) => { await db.deleteTask(sub, params.id); return json(204); }],

  ["GET", /^\/chat\/messages$/, async ({ sub, event }) => {
    const limit = Math.min(500, Number(event.queryStringParameters?.limit ?? 200) || 200);
    return json(200, { items: await db.listMessages(sub, limit) });
  }],

  /** Writes a "sending" message; the stream fan-out hands it to the relay, which sends it from Messages.app. */
  ["POST", /^\/chat\/messages$/, async ({ sub, event }) => {
    const { text, clientId } = parseBody(event, SendChatSchema);
    const msg: ChatMessage = { id: clientId ?? randomUUID(), direction: "out", text, at: new Date().toISOString(), status: "sending" };
    await db.upsertMessage(sub, msg);
    return json(202, msg);
  }],

  ["GET", /^\/discord\/messages$/, async ({ sub }) => json(200, { items: await db.listDiscord(sub) })],

  ["POST", /^\/discord\/messages$/, async ({ sub, email, event }) => {
    const { text, channelId } = parseBody(event, SendDiscordSchema);
    const profile = await db.getProfile(sub);
    if (!profile.discordUserId) throw new HttpError(409, "Link Discord first: run /link in Discord with the code from Settings");
    if (!channelId || !profile.mirrorChannels?.includes(channelId)) throw new HttpError(403, "Pick a channel you mirror on the board");
    const name = email?.split("@")[0] ?? "student";
    const sent = await sendChannelMessage(channelId, `**${name}** (via Cubbie Board): ${text}`);
    return json(201, { id: sent.id, channelId, channelName: channelId, author: name, text, at: sent.timestamp });
  }],

  /** One-time code the student types as /link <code> in Discord to connect the two accounts. */
  ["POST", /^\/discord\/link-code$/, async ({ sub }) => {
    const code = Math.random().toString(36).slice(2, 8).toUpperCase();
    await db.putItem({ PK: `LINKCODE#${code}`, SK: "META", sub, ttl: db.ttlIn(600) });
    return json(201, { code, expiresInSeconds: 600 });
  }],

  ["PUT", /^\/discord\/channels$/, async ({ sub, event }) => {
    const { channelIds } = parseBody(event, z.object({ channelIds: z.array(z.string().regex(/^\d{5,25}$/)).max(10) }));
    const profile = await db.getProfile(sub);
    for (const old of profile.mirrorChannels ?? []) if (!channelIds.includes(old)) await db.deleteItem(`CHANNEL#${old}`, `SUB#${sub}`);
    for (const id of channelIds) await db.putItem({ PK: `CHANNEL#${id}`, SK: `SUB#${sub}`, sub });
    await db.patchProfile(sub, { mirrorChannels: channelIds });
    return json(200, { channelIds });
  }],

  ["GET", /^\/integrations\/status$/, async ({ sub }) => {
    const [profile, online, devices] = await Promise.all([db.getProfile(sub), relayOnline(sub), db.getItem(db.U(sub), "DEVICE#primary")]);
    const status: IntegrationStatus = {
      mode: "live",
      imessageRelay: online ? "online" : devices ? "offline" : "not_set_up",
      relayDevice: (devices?.name as string | undefined) ?? null,
      discord: profile.discordUserId ? "linked" : "not_linked",
      discordGuild: profile.discordGuild ?? null,
      lastCubbieSync: profile.lastCubbieSync ?? null
    };
    return json(200, status);
  }],

  /** Mint the relay token for the student's Mac. Shown once; only the hash is stored. */
  ["POST", /^\/devices$/, async ({ sub, event }) => {
    const { name } = parseBody(event, z.object({ name: z.string().min(1).max(60) }));
    const old = await db.getItem<{ tokenHash: string }>(db.U(sub), "DEVICE#primary");
    if (old) await db.deleteItem(`DEVTOKEN#${old.tokenHash}`, "META");
    const token = newSecret("cbr");
    const tokenHash = sha256(token);
    await db.putItem({ PK: db.U(sub), SK: "DEVICE#primary", name, tokenHash, createdAt: new Date().toISOString() });
    await db.putItem({ PK: `DEVTOKEN#${tokenHash}`, SK: "META", sub, deviceId: "primary" });
    return json(201, { token, note: "Paste this into the relay's setup. It will not be shown again." });
  }],

  /** Key the student saves in Cubbie as CUBBIE_DASHBOARD_API_KEY so their Skill can sync to this board. */
  ["POST", /^\/ingest-keys$/, async ({ sub }) => {
    const key = newSecret("cbk");
    const keyHash = sha256(key);
    await db.putItem({ PK: `INGESTKEY#${keyHash}`, SK: "META", sub });
    await db.putItem({ PK: db.U(sub), SK: `INGESTKEY#${keyHash.slice(0, 12)}`, createdAt: new Date().toISOString() });
    return json(201, { key, envName: "CUBBIE_DASHBOARD_API_KEY" });
  }],

  ["PUT", /^\/profile$/, async ({ sub, event }) => {
    const { timezone } = parseBody(event, z.object({ timezone: z.string().max(64) }));
    await db.patchProfile(sub, { timezone });
    return json(200, { timezone });
  }],

  /** Weekly summary with Claude on Amazon Bedrock (Converse API, so the model is a config value). */
  ["POST", /^\/summary$/, async ({ sub }) => {
    if (!env.bedrockModelId) throw new HttpError(501, "Summaries are off: set BEDROCK_MODEL_ID in the stack config");
    const [tasks, profile] = await Promise.all([db.listTasks(sub), db.getProfile(sub)]);
    const tz = profile.timezone;
    const facts = `Classes:\n${dueList(tasks, tz, 12)}\n\nGrading:\n${gradingList(tasks, tz, 12)}\n\nJobs:\n${appsList(tasks, tz, 12)}`;
    const bedrock = new BedrockRuntimeClient({});
    const r = await bedrock.send(new ConverseCommand({
      modelId: env.bedrockModelId,
      system: [{ text: "You write a short, friendly weekly plan for a college student in plain text (no Markdown). Use only the facts given. Never invent deadlines or counts; if something says unavailable or not specified, keep that wording." }],
      messages: [{ role: "user", content: [{ text: facts }] }],
      inferenceConfig: { maxTokens: 600, temperature: 0.3 }
    }));
    const text = r.output?.message?.content?.map(c => ("text" in c ? c.text : "")).join("") ?? "";
    return json(200, { text });
  }]
];

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  try {
    const method = event.requestContext.http.method;
    const path = event.rawPath.replace(/^\/(api|v1)(?=\/)/, "");
    for (const [m, re, fn] of routes) {
      const match = method === m ? re.exec(path) : null;
      if (match) {
        const user = userFrom(event);
        const params = Object.fromEntries(Object.entries(match.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)]));
        return await fn({ ...user, event, params });
      }
    }
    return json(404, { message: "Not found" });
  } catch (err) {
    return toResponse(err);
  }
}
