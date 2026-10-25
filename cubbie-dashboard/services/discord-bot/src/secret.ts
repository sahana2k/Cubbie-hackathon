import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export type DiscordSecret = { botToken: string; publicKey: string; applicationId: string };
export async function loadSecret(): Promise<DiscordSecret> {
  if (process.env.DISCORD_BOT_TOKEN) {
    return { botToken: process.env.DISCORD_BOT_TOKEN, publicKey: process.env.DISCORD_PUBLIC_KEY ?? "", applicationId: process.env.DISCORD_APPLICATION_ID ?? "" };
  }
  const sm = new SecretsManagerClient({});
  const r = await sm.send(new GetSecretValueCommand({ SecretId: process.env.DISCORD_SECRET_ARN }));
  return JSON.parse(r.SecretString ?? "{}");
}
