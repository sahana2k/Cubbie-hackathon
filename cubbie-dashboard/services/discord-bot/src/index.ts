import { createServer } from "node:http";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { Client, Events, GatewayIntentBits, type Message } from "discord.js";
import { loadSecret } from "./secret.js";

/**
 * Long-running Discord gateway bot (ECS Fargate, 0.25 vCPU). It mirrors messages from the channels a
 * student chose into DynamoDB; the stream fan-out Lambda then pushes them to that student's board.
 * Slash commands are handled separately by the interactions Lambda, so this process stays small.
 */
const TABLE = process.env.TABLE_NAME!;
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

async function subscribers(channelId: string): Promise<string[]> {
  const r = await doc.send(new QueryCommand({ TableName: TABLE, KeyConditionExpression: "PK = :pk", ExpressionAttributeValues: { ":pk": `CHANNEL#${channelId}` } }));
  return (r.Items ?? []).map(i => i.sub as string);
}

async function mirror(msg: Message) {
  if (!msg.inGuild() || !msg.content) return;
  const subs = await subscribers(msg.channelId);
  if (!subs.length) return;
  const at = msg.createdAt.toISOString();
  const item = {
    id: msg.id, channelId: msg.channelId, channelName: "name" in msg.channel ? msg.channel.name : msg.channelId,
    author: msg.member?.displayName ?? msg.author.username, bot: msg.author.bot, text: msg.content.slice(0, 2000), at
  };
  const ttl = Math.floor(Date.now() / 1000) + 30 * 86400;
  await Promise.all(subs.map(sub => doc.send(new PutCommand({ TableName: TABLE, Item: { PK: `USER#${sub}`, SK: `DC#${at}#${msg.id}`, entity: "discord", sub, ttl, ...item } }))));
}

async function main() {
  const { botToken } = await loadSecret();
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  client.once(Events.ClientReady, c => console.log(`Discord bot ready as ${c.user.tag} in ${c.guilds.cache.size} servers`));
  client.on(Events.MessageCreate, m => { mirror(m).catch(err => console.error("mirror failed", err)); });
  client.on(Events.Error, err => console.error("gateway error", err));
  await client.login(botToken);

  // ECS container health check target
  createServer((_, res) => { res.writeHead(client.isReady() ? 200 : 503).end(client.isReady() ? "ok" : "starting"); }).listen(8080);
  const stop = () => { client.destroy().finally(() => process.exit(0)); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
}
main().catch(err => { console.error(err); process.exit(1); });
