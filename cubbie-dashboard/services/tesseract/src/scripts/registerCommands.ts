/**
 * Optional: the bot already registers commands in every server on startup.
 * Use this to register without running the bot, or globally with --global.
 */
import { REST, Routes } from 'discord.js';
import { config } from '../config';
import { commandJson } from '../discord/commands';

async function main() {
  const rest = new REST().setToken(config.discordToken);
  const global = process.argv.includes('--global');
  if (global || !config.guildId) {
    await rest.put(Routes.applicationCommands(config.discordClientId), { body: commandJson });
    console.log(`✅ Registered ${commandJson.length} global commands (can take up to an hour to appear).`);
  } else {
    await rest.put(Routes.applicationGuildCommands(config.discordClientId, config.guildId), { body: commandJson });
    console.log(`✅ Registered ${commandJson.length} commands in guild ${config.guildId}.`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
