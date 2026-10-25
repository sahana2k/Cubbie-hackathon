import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import * as db from "../lib/db";
import { verifyInteraction } from "../lib/discord";
import { json } from "../lib/http";
import { appsList, dueList, gradingList } from "../lib/text";

/**
 * Discord interactions endpoint (slash commands). Set it as the "Interactions Endpoint URL" in the
 * Discord developer portal. Replies are ephemeral: only the student who ran the command sees them.
 *   /due      what is due soonest
 *   /grading  grading workload (counts never invented)
 *   /apps     job applications and next actions
 *   /link     link Discord to the board with the code from Settings
 */
const EPHEMERAL = 64;
const reply = (content: string) => json(200, { type: 4, data: { content: content.slice(0, 1900), flags: EPHEMERAL } });

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const body = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString() : event.body ?? "";
  const sig = event.headers["x-signature-ed25519"]; const ts = event.headers["x-signature-timestamp"];
  if (!sig || !ts || !(await verifyInteraction(sig, ts, body).catch(() => false))) return { statusCode: 401, body: "bad signature" };

  const i = JSON.parse(body);
  if (i.type === 1) return json(200, { type: 1 }); // PING

  const discordUserId: string | undefined = i.member?.user?.id ?? i.user?.id;
  const name: string = i.data?.name;
  if (!discordUserId) return reply("I couldn't tell who sent that.");

  if (name === "link") {
    const code = String(i.data.options?.[0]?.value ?? "").trim().toUpperCase();
    const rec = await db.getItem<{ sub: string }>(`LINKCODE#${code}`, "META");
    if (!rec) return reply("That code didn't work. Get a fresh one in the board's Settings, then run /link again.");
    await db.putItem({ PK: `DISCORD#${discordUserId}`, SK: "LINK", sub: rec.sub });
    await db.patchProfile(rec.sub, { discordUserId, discordGuild: i.guild_id ? (i.guild?.name ?? "Linked server") : "Direct messages" });
    await db.deleteItem(`LINKCODE#${code}`, "META");
    return reply("Linked 💙 You'll get reminders and a morning brief here. Try /due.");
  }

  const link = await db.getItem<{ sub: string }>(`DISCORD#${discordUserId}`, "LINK");
  if (!link) return reply("Link your board first: open Settings on the board, copy the code, and run /link <code>.");
  const [tasks, profile] = await Promise.all([db.listTasks(link.sub), db.getProfile(link.sub)]);
  const tz = profile.timezone;
  if (name === "due") return reply(dueList(tasks, tz));
  if (name === "grading") return reply(gradingList(tasks, tz));
  if (name === "apps") return reply(appsList(tasks, tz));
  return reply("I know /due, /grading, /apps and /link.");
}
