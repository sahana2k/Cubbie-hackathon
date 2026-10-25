import { verify, createPublicKey } from "node:crypto";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { env } from "./env";

type DiscordSecret = { botToken: string; publicKey: string; applicationId: string; clientSecret?: string };
let cached: DiscordSecret | null = null;
const sm = new SecretsManagerClient({});

export async function discordSecret(): Promise<DiscordSecret> {
  if (cached) return cached;
  const r = await sm.send(new GetSecretValueCommand({ SecretId: env.discordSecretArn }));
  cached = JSON.parse(r.SecretString ?? "{}") as DiscordSecret;
  return cached;
}

async function rest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { botToken } = await discordSecret();
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`https://discord.com/api/v10${path}`, {
      ...init, headers: { authorization: `Bot ${botToken}`, "content-type": "application/json", ...(init.headers ?? {}) }
    });
    if (res.status === 429) { const j = (await res.json().catch(() => ({ retry_after: 1 }))) as { retry_after?: number }; await new Promise(r => setTimeout(r, (j.retry_after ?? 1) * 1000)); continue; }
    if (!res.ok) throw new Error(`Discord ${res.status}: ${await res.text()}`);
    return (res.status === 204 ? undefined : await res.json()) as T;
  }
  throw new Error("Discord rate limit");
}

export const sendChannelMessage = (channelId: string, content: string) =>
  rest<{ id: string; timestamp: string }>(`/channels/${channelId}/messages`, { method: "POST", body: JSON.stringify({ content, allowed_mentions: { parse: [] } }) });

export async function sendDM(discordUserId: string, content: string) {
  const ch = await rest<{ id: string }>("/users/@me/channels", { method: "POST", body: JSON.stringify({ recipient_id: discordUserId }) });
  return sendChannelMessage(ch.id, content);
}

/** Discord signs every interaction with Ed25519; reject anything that does not verify. */
export async function verifyInteraction(signature: string, timestamp: string, body: string) {
  const { publicKey } = await discordSecret();
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(publicKey, "hex")]);
  const key = createPublicKey({ key: spki, format: "der", type: "spki" });
  return verify(null, Buffer.from(timestamp + body), key, Buffer.from(signature, "hex"));
}
