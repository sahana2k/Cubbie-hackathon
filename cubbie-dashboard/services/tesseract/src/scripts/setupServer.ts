/**
 * Builds the Tesseract layout inside your hackathon Discord server:
 *   📚 Tesseract (category)
 *     #welcome           read-only intro + how-to (pinned)
 *     #project-chat      the group project channel (Tesseract lives here)
 *     #tesseract-log    live trace of what each AI agent did (great for judges)
 *     🔊 study-room      voice channel for meetings
 *
 * Usage:
 *   npm run setup-server
 *   npm run setup-server -- --project "CSE 360 Team Project" --deadline "Dec 5 11:59pm" --course "CSE 360"
 * With --project/--deadline it also creates the project record bound to #project-chat,
 * so the team can start talking immediately (they can still /rubric afterwards).
 * Safe to re-run: existing channels are reused.
 */
import { ChannelType, Client, EmbedBuilder, Events, GatewayIntentBits, PermissionFlagsBits, type Guild, type TextChannel } from 'discord.js';
import { config } from '../config';
import { initDb } from '../db/index';
import * as repo from '../db/repo';
import { parseWhen } from '../core/time';
import { scheduleSubmissionGuards } from '../core/actions';
import { helpEmbed } from '../discord/interactions';
import { commandJson } from '../discord/commands';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function ensureText(guild: Guild, name: string, parentId: string, topic: string, readOnly = false): Promise<TextChannel> {
  const existing = guild.channels.cache.find(c => c.name === name && c.type === ChannelType.GuildText) as TextChannel | undefined;
  if (existing) return existing;
  return guild.channels.create({
    name, type: ChannelType.GuildText, parent: parentId, topic,
    permissionOverwrites: readOnly ? [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages] },
      { id: guild.members.me!.id, allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages] },
    ] : [],
  });
}

async function main() {
  if (!config.guildId) throw new Error('Set DISCORD_GUILD_ID in .env (right-click your server → Copy Server ID).');
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(config.discordToken);
  await new Promise<void>(r => client.once(Events.ClientReady, () => r()));
  const guild = await client.guilds.fetch(config.guildId);
  await guild.channels.fetch();
  await guild.members.fetchMe();
  console.log(`Configuring "${guild.name}"…`);

  let category = guild.channels.cache.find(c => c.name === '📚 Tesseract' && c.type === ChannelType.GuildCategory);
  if (!category) category = await guild.channels.create({ name: '📚 Tesseract', type: ChannelType.GuildCategory });

  const welcome = await ensureText(guild, 'welcome', category.id, 'How Tesseract works', true);
  const projectChat = await ensureText(guild, 'project-chat', category.id, 'Your group project. Talk normally — tag @Tesseract any time.');
  await ensureText(guild, 'tesseract-log', category.id, 'Live trace of what the Planner, Dependency, Meeting and Accountability agents did.', true);
  if (!guild.channels.cache.find(c => c.name === 'study-room' && c.type === ChannelType.GuildVoice))
    await guild.channels.create({ name: 'study-room', type: ChannelType.GuildVoice, parent: category.id });

  const pins = await welcome.messages.fetchPinned().catch(() => null);
  if (!pins || pins.size === 0) {
    const intro = new EmbedBuilder().setColor(0x7c5cff).setTitle('👋 Meet Tesseract')
      .setDescription(`Your group project finally has a project manager — and nobody has to be it.\n\nHead to ${projectChat} and:\n1. Everyone runs \`/join\`\n2. Add class times with \`/classes add\` (private)\n3. Upload the rubric with \`/rubric\`\n4. Talk normally. Tag **@Tesseract** with anything.`);
    const m = await welcome.send({ embeds: [intro, helpEmbed()] });
    await m.pin().catch(() => null);
  }

  await guild.commands.set(commandJson);
  console.log(`✅ Slash commands registered (${commandJson.length}).`);

  const projectName = arg('project');
  const deadlineText = arg('deadline');
  if (projectName && deadlineText) {
    initDb(config.databasePath);
    const deadline = parseWhen(deadlineText, config.defaultTimezone);
    if (deadline == null) throw new Error(`Could not parse --deadline "${deadlineText}"`);
    let p = repo.getProjectByChannel(projectChat.id);
    if (!p) p = repo.createProject({ guild_id: guild.id, channel_id: projectChat.id, name: projectName, course: arg('course') ?? null, final_deadline: deadline, timezone: config.defaultTimezone, created_by: client.user!.id });
    else repo.updateProject(p.id, { name: projectName, final_deadline: deadline, course: arg('course') ?? p.course });
    scheduleSubmissionGuards(repo.getProject(p.id)!);
    await projectChat.send({ content: `🚀 **${projectName}** is set up here. Final deadline <t:${Math.floor(deadline / 1000)}:F>. Everyone run \`/join\`, then upload the rubric with \`/rubric\`.` });
    console.log(`✅ Project "${projectName}" bound to #project-chat (deadline ${new Date(deadline).toISOString()}).`);
  }

  console.log(`✅ Done. Open #project-chat in "${guild.name}".`);
  await client.destroy();
}

main().catch(e => { console.error('❌', e.message ?? e); process.exit(1); });
