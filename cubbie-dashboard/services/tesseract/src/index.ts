import { Client, Events, GatewayIntentBits, Partials, ActivityType } from 'discord.js';
import http from 'http';
import { createMessage } from './claude/client';
import { startDashboard } from './dashboard';
import { config } from './config';
import { initDb, closeDb, getDb } from './db/index';
import { log } from './core/log';
import { healthHandler } from './core/health';
import { commandJson } from './discord/commands';
import { handleInteraction } from './discord/interactions';
import { checkInteractionRouting } from './discord/interaction-routing';
import { handleMessage } from './discord/messages';
import { dm, sendToProject } from './discord/deliver';
import { startScheduler } from './scheduler/reminders';

async function main() {
  // Fail at startup instead of accepting commands with missing credentials.
  void config.discordToken;
  void config.discordClientId;
  void config.llmKey;
  if (process.env.TESSERACT_BRIDGE_TOKEN) {
    try {
      const probe = await createMessage({ model: config.model, max_tokens: 128,
        tools: [{ name: 'connection_check', description: 'Verify tool calling', input_schema: { type: 'object', properties: {} } }],
        tool_choice: { type: 'tool', name: 'connection_check' },
        messages: [{ role: 'user', content: 'Call connection_check with empty arguments.' }] });
      if (!probe.content.some(b => b.type === 'tool_use' && b.name === 'connection_check')) throw new Error('Tool calling unavailable');
    } catch {
      process.stdout.write('TESSERACT_ERROR LLM verification failed. Check your provider, API key, model ID and tool-calling support.\n');
      process.exit(1);
    }
  }
  if (!Number.isFinite(config.schedulerIntervalMs) || config.schedulerIntervalMs < 1000) {
    throw new Error('SCHEDULER_INTERVAL_SECONDS must be at least 1');
  }
  const port = Number(process.env.PORT || 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT');
  initDb(config.databasePath);
  log.info(`database ready at ${config.databasePath}`);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,   // privileged: enable in Developer Portal → Bot
      GatewayIntentBits.GuildMembers,     // privileged: enable in Developer Portal → Bot
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  let stopping = false;
  let scheduler: ReturnType<typeof startScheduler> | undefined;
  const inFlight = new Set<Promise<unknown>>();
  const track = (work: () => Promise<unknown>) => {
    if (stopping) return;
    const pending = Promise.resolve().then(work).catch(e => log.error('event handler failed', e))
      .finally(() => { inFlight.delete(pending); });
    inFlight.add(pending);
  };

  client.once(Events.ClientReady, c => track(async () => {
    try {
      checkInteractionRouting(await c.application.fetch());
    } catch (error) {
      const message = error instanceof Error && error.message.startsWith('Slash commands are routed')
        ? error.message : 'Could not verify Discord slash-command delivery. Check the bot application permissions and reconnect.';
      if (process.env.TESSERACT_BRIDGE_TOKEN) process.stdout.write(`TESSERACT_ERROR ${message}\n`);
      else log.error(message);
      c.destroy();
      closeDb();
      process.exitCode = 1;
      return;
    }
    log.info(`logged in as ${c.user.tag} — in ${c.guilds.cache.size} server(s)`);
    c.user.setActivity('your group project', { type: ActivityType.Watching });
    // Guild-scoped registration is instant, so every server the bot is in gets commands on boot.
    for (const g of c.guilds.cache.values()) {
      if (config.guildId && g.id !== config.guildId) continue;
      await g.commands.set(commandJson).then(() => log.info(`slash commands registered in "${g.name}"`))
        .catch(e => log.warn(`command registration failed in ${g.name}`, e.message));
    }
    if (stopping) return;
    scheduler = startScheduler({
      channel: (projectId, payload) => sendToProject(client, projectId, payload),
      dm: (userId, payload) => dm(client, userId, payload),
    }, config.schedulerIntervalMs);
    log.info(`reminder worker running every ${config.schedulerIntervalMs / 1000}s`);
    startDashboard(client);
  }));

  client.on(Events.GuildCreate, g => {
    if (config.guildId && g.id !== config.guildId) return;
    g.commands.set(commandJson).then(() => log.info(`joined "${g.name}", commands registered`)).catch(e => log.warn('register on join failed', e.message));
  });
  client.on(Events.InteractionCreate, i => { if (!config.guildId || !i.guildId || i.guildId === config.guildId) track(() => handleInteraction(client, i)); });
  client.on(Events.MessageCreate, m => { if (!config.guildId || m.guildId === config.guildId) track(() => handleMessage(client, m)); });
  client.on(Events.Error, e => log.error('discord client error', e));

  const server = port ? http.createServer(healthHandler(() => {
    if (stopping || !client.isReady() || !scheduler?.healthy()) return false;
    getDb().prepare('SELECT 1').get();
    return true;
  })).listen(port, '0.0.0.0', () => log.info(`health check on :${port}/health`)) : undefined;

  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${sig} received, shutting down`);
    // Bound shutdown, but let active deliveries finish before closing SQLite.
    const deadline = setTimeout(() => {
      log.error('shutdown timed out; pending work may need retry');
      process.exit(1);
    }, 25_000);
    deadline.unref();
    server?.close();
    await scheduler?.stop();
    await Promise.allSettled([...inFlight]);
    await client.destroy();
    closeDb();
    clearTimeout(deadline);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', e => log.error('unhandled rejection', e));

  await client.login(config.discordToken);
}

main().catch(e => { log.error('fatal', e); process.exit(1); });
