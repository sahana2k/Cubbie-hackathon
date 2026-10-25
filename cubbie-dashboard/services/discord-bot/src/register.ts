import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { loadSecret } from "./secret.js";

/** Run once after deploy (or when commands change): pnpm --filter @cubbie/discord-bot register */
const commands = [
  new SlashCommandBuilder().setName("due").setDescription("What's due soonest on your Cubbie board"),
  new SlashCommandBuilder().setName("grading").setDescription("Your TA grading workload"),
  new SlashCommandBuilder().setName("apps").setDescription("Job applications and next actions"),
  new SlashCommandBuilder().setName("link").setDescription("Link Discord to your Cubbie board")
    .addStringOption(o => o.setName("code").setDescription("Code from the board's Settings").setRequired(true))
].map(c => c.toJSON());

const { botToken, applicationId } = await loadSecret();
await new REST().setToken(botToken).put(Routes.applicationCommands(applicationId), { body: commands });
console.log(`Registered ${commands.length} global commands`);
