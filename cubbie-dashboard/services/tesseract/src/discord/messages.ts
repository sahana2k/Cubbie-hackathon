import type { Client, Message } from 'discord.js';
import * as repo from '../db/repo';
import { log } from '../core/log';
import { orchestrate, shouldScanPassively } from '../agents/orchestrator';
import { displayName, projectForChannel } from './context';
import { deliverOuts, postAgentTrace } from './deliver';

/** Every message in a project channel: remember it, answer @mentions, and passively pick up commitments. */
export async function handleMessage(client: Client, message: Message) {
  if (message.author.bot || !message.inGuild()) return;
  const me = client.user!;
  const mentioned = message.mentions.users.has(me.id) || (message.mentions.roles.size > 0 && message.mentions.roles.some(r => r.tags?.botId === me.id));
  const project = projectForChannel(message.channel);

  if (!project) {
    if (mentioned) await message.reply("Hi! I'm not set up in this channel yet. Run `/setup` here to make it a project channel, then tag me any time.");
    return;
  }

  const name = displayName(message.author, message.member);
  repo.upsertMember(project.id, message.author.id, name);
  // Replace raw mention tokens with readable names so Claude sees "@Maya", not "<@1234>".
  let text = message.content.replace(new RegExp(`<@!?${me.id}>`, 'g'), '').trim();
  text = text.replace(/<@!?(\d+)>/g, (_m, id) => `@${repo.memberName(project.id, id)} (id ${id})`);
  if (!text && !message.attachments.size) return;

  // Replying to one of our cards? Give the agents that context ("Confirmed" → which proposal).
  if (message.reference?.messageId) {
    const ref = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
    if (ref?.author.id === me.id) {
      const refText = ref.embeds[0]?.description ?? ref.content;
      const footer = ref.embeds[0]?.footer?.text ?? '';
      text = `${text}\n(replying to Tesseract message: "${refText.slice(0, 300)}" ${footer})`;
    }
  }
  repo.logChat(project.id, message.author.id, name, text, message.url);

  const isPassive = !mentioned;
  if (isPassive && !shouldScanPassively(project, text)) return;
  if (isPassive) repo.updateProject(project.id, { last_passive_at: Date.now() });

  let typing: NodeJS.Timeout | undefined;
  if (mentioned) {
    await message.channel.sendTyping().catch(() => null);
    typing = setInterval(() => message.channel.sendTyping().catch(() => null), 8000);
  }
  const started = Date.now();
  try {
    const res = await orchestrate({
      project, actorId: message.author.id, actorName: name, channelId: message.channelId, text: text || '(sent an attachment)',
      sourceUrl: message.url, mode: mentioned ? 'mention' : 'passive',
    });
    if (res.reply) {
      const sent = await message.reply({ content: res.reply, allowedMentions: { parse: ['users'], repliedUser: false } });
      repo.logChat(project.id, me.id, 'Tesseract', res.reply, sent.url);
    }
    await deliverOuts(client, res.outs, message.channelId);
    if (res.agents.length) void postAgentTrace(client, project.id, started, `${name}: ${text}`);
  } catch (e) {
    log.error('message handling failed', e);
    if (mentioned) await message.reply('⚠️ I hit an error thinking about that. Try again in a moment.').catch(() => null);
  } finally {
    if (typing) clearInterval(typing);
  }
}
