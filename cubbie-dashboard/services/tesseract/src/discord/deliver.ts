import type { Client, MessageCreateOptions, SendableChannels } from 'discord.js';
import * as repo from '../db/repo';
import type { Out } from '../core/actions';
import { log } from '../core/log';
import { agentEmoji } from '../agents/orchestrator';
import { claimBoardMessage, decisionMessage, meetingConfirmedMessage, meetingPollMessage } from './render';

export async function channelFor(client: Client, channelId: string): Promise<SendableChannels | null> {
  try {
    const ch = await client.channels.fetch(channelId);
    return ch && ch.isSendable() ? ch : null;
  } catch (e) {
    log.warn(`cannot fetch channel ${channelId}`, (e as Error).message);
    return null;
  }
}

export async function sendToProject(client: Client, projectId: number, payload: MessageCreateOptions | string) {
  const project = repo.getProject(projectId);
  if (!project) throw new Error(`Project ${projectId} is unavailable for delivery`);
  const ch = await channelFor(client, project.channel_id);
  if (!ch) throw new Error(`Project ${projectId} channel is unavailable for delivery`);
  return ch.send(typeof payload === 'string' ? { content: payload, allowedMentions: { parse: ['users'] } } : payload);
}

export async function dm(client: Client, userId: string, payload: MessageCreateOptions | string): Promise<boolean> {
  try {
    const user = await client.users.fetch(userId);
    await user.send(payload);
    return true;
  } catch (e) {
    log.warn(`DM to ${userId} failed (DMs closed?)`, (e as Error).message);
    return false;
  }
}

/** Delivers the side-effects produced by actions/agents. Cards remember their message ID for later edits. */
export async function deliverOuts(client: Client, outs: Out[], fallbackChannelId?: string) {
  const seenBoards = new Set<string>();
  for (const out of outs) {
    try {
      switch (out.kind) {
        case 'text':
          if (out.dmUserId) {
            const ok = await dm(client, out.dmUserId, out.text);
            if (!ok) await sendToProject(client, out.projectId, `<@${out.dmUserId}> ${out.text}`);
          } else await sendToProject(client, out.projectId, out.text);
          break;
        case 'decision': {
          const d = repo.getDecision(out.decisionId);
          if (!d) break;
          const ch = await channelFor(client, d.channel_id ?? fallbackChannelId ?? repo.getProject(d.project_id)!.channel_id);
          const msg = await ch?.send(decisionMessage(d));
          if (msg) repo.updateDecision(d.id, { message_id: msg.id, channel_id: msg.channelId });
          break;
        }
        case 'claim_board': {
          const key = out.taskIds.join(',');
          if (seenBoards.has(key)) break;
          seenBoards.add(key);
          await sendToProject(client, out.projectId, claimBoardMessage(repo.getProject(out.projectId)!, out.taskIds));
          break;
        }
        case 'meeting_poll': {
          const m = repo.getMeeting(out.meetingId)!;
          const ch = await channelFor(client, m.channel_id ?? repo.getProject(m.project_id)!.channel_id);
          const msg = await ch?.send(meetingPollMessage(m.id));
          if (msg) repo.updateMeeting(m.id, { message_id: msg.id, channel_id: msg.channelId });
          break;
        }
        case 'meeting_confirmed': {
          const m = repo.getMeeting(out.meetingId)!;
          await sendToProject(client, m.project_id, meetingConfirmedMessage(m.id));
          // refresh the original poll so it shows as closed
          if (m.channel_id && m.message_id) {
            const ch = await channelFor(client, m.channel_id);
            const msg = await ch?.messages.fetch(m.message_id).catch(() => null);
            await msg?.edit(meetingPollMessage(m.id) as any).catch(() => null);
          }
          break;
        }
      }
    } catch (e) {
      log.error(`deliver ${out.kind} failed`, e);
    }
  }
}

/** Re-render a decision card in place after a vote. */
export async function refreshDecisionCard(client: Client, decisionId: number) {
  const d = repo.getDecision(decisionId);
  if (!d?.channel_id || !d.message_id) return;
  const ch = await channelFor(client, d.channel_id);
  const msg = await ch?.messages.fetch(d.message_id).catch(() => null);
  await msg?.edit(decisionMessage(d) as any).catch(e => log.warn('card edit failed', e.message));
}

export const LOG_CHANNEL_NAME = 'tesseract-log';

/** Mirrors what the agents did for one message into #tesseract-log — the "glass box" view for judges and curious students. */
export async function postAgentTrace(client: Client, projectId: number, sinceMs: number, trigger: string) {
  const project = repo.getProject(projectId);
  if (!project) return;
  const rows = repo.agentLogSince(projectId, sinceMs);
  if (!rows.length) return;
  try {
    const guild = await client.guilds.fetch(project.guild_id);
    const channels = await guild.channels.fetch();
    const logCh = channels.find(c => c?.name === LOG_CHANNEL_NAME && c.isTextBased());
    if (!logCh || !logCh.isSendable()) return;
    const lines = rows.map(r => {
      let detail = r.detail ?? '';
      try {
        const j = JSON.parse(detail);
        if (j && typeof j === 'object') detail = JSON.stringify(j.input ?? j).slice(0, 160) + (j.error ? ` ❌ ${String(j.error).slice(0, 120)}` : '') + (Array.isArray(j.conflicts) && j.conflicts.length ? ` ⚠️ ${j.conflicts.join(' | ').slice(0, 200)}` : '');
      } catch { /* plain text */ }
      return `${agentEmoji(r.agent)} **${r.agent}** \`${r.action}\` ${detail.slice(0, 260)}`;
    });
    const header = `**#${project.name}** · trigger: ${trigger.slice(0, 120)}`;
    let chunk = header;
    for (const l of lines) {
      if ((chunk + '\n' + l).length > 1900) { await logCh.send({ content: chunk, allowedMentions: { parse: [] } }); chunk = ''; }
      chunk += '\n' + l;
    }
    if (chunk.trim()) await logCh.send({ content: chunk, allowedMentions: { parse: [] } });
  } catch (e) {
    log.debug('agent trace skipped', (e as Error).message);
  }
}
