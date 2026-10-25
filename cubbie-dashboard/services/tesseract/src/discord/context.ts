import type Anthropic from '@anthropic-ai/sdk';
import type { Attachment, Channel, GuildMember, User } from 'discord.js';
import * as repo from '../db/repo';
import { ActionError } from '../core/actions';

/** Threads inherit their parent channel's project. */
export function projectForChannel(channel: Channel | null): repo.Project | undefined {
  if (!channel) return undefined;
  const direct = repo.getProjectByChannel(channel.id);
  if (direct) return direct;
  if ('isThread' in channel && channel.isThread() && channel.parentId) return repo.getProjectByChannel(channel.parentId);
  return undefined;
}

export function displayName(user: User, member?: GuildMember | null | unknown): string {
  const m = member as GuildMember | undefined;
  return (m && typeof m === 'object' && 'displayName' in m ? m.displayName : null) ?? user.globalName ?? user.username;
}

const MAX_BYTES = 20 * 1024 * 1024;

/** Turns an uploaded rubric into Claude content blocks: PDFs and images go natively, text inline. */
export async function attachmentToBlocks(att: Attachment): Promise<Anthropic.ContentBlockParam[]> {
  if (att.size > MAX_BYTES) throw new ActionError('That file is over 20 MB — try a smaller PDF or a screenshot.');
  const type = (att.contentType ?? '').split(';')[0].toLowerCase();
  const name = att.name.toLowerCase();
  const res = await fetch(att.url);
  if (!res.ok) throw new ActionError(`Couldn't download the file from Discord (${res.status}).`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (type === 'application/pdf' || name.endsWith('.pdf')) {
    return [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') }, title: att.name }];
  }
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(type)) {
    return [{ type: 'image', source: { type: 'base64', media_type: type as 'image/png', data: buf.toString('base64') } }];
  }
  if (type.startsWith('text/') || /\.(txt|md|markdown|csv)$/.test(name)) {
    return [{ type: 'document', source: { type: 'text', media_type: 'text/plain', data: buf.toString('utf8').slice(0, 200_000) }, title: att.name }];
  }
  throw new ActionError('Rubric must be a PDF, text/markdown file, or an image (photo/screenshot). For Word docs, export to PDF first.');
}
