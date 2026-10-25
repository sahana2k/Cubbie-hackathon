import 'dotenv/config';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`);
  return v;
}

export const config = {
  get discordToken() { return req('DISCORD_TOKEN'); },
  get discordClientId() { return req('DISCORD_CLIENT_ID'); },
  guildId: process.env.DISCORD_GUILD_ID || '',
  get anthropicKey() { return req('ANTHROPIC_API_KEY'); },
  get llmKey() { return process.env.LLM_API_KEY || req('ANTHROPIC_API_KEY'); },
  model: process.env.LLM_MODEL || process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
  fastModel: process.env.LLM_MODEL || process.env.CLAUDE_FAST_MODEL || 'claude-haiku-5-5',
  defaultTimezone: process.env.DEFAULT_TIMEZONE || 'America/Phoenix',
  databasePath: process.env.DATABASE_PATH || './data/mergemates.db',
  schedulerIntervalMs: Number(process.env.SCHEDULER_INTERVAL_SECONDS || 60) * 1000,
  logLevel: (process.env.LOG_LEVEL || 'info') as 'debug' | 'info' | 'warn' | 'error',
};
