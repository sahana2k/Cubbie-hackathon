/** Private bridge: the Python dashboard owns its lifecycle and session authentication. */
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { Client } from 'discord.js';
import { projectForChannel } from './discord/context';
import * as repo from './db/repo';

export function startDashboard(client: Client) {
  const token = process.env.TESSERACT_BRIDGE_TOKEN;
  if (!token) return;
  const server = http.createServer(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${token}`);
    const reply = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(403, { message: 'Forbidden' });
    try {
      const url = new URL(req.url!, 'http://localhost');
      if (req.method !== 'GET') return reply(405, { message: 'Use Discord to send messages and approve changes.' });
      if (!client.isReady()) return reply(503, { message: 'Discord is reconnecting.' });
      const guilds = [...client.guilds.cache.values()].filter(g => !process.env.DISCORD_GUILD_ID || g.id === process.env.DISCORD_GUILD_ID);
      if (url.pathname === '/servers') return reply(200, { servers: guilds.map(g => ({ id: g.id, name: g.name })), provider: process.env.LLM_PROVIDER || 'anthropic', model: process.env.LLM_MODEL || '' });
      const guild = guilds.find(g => g.id === url.searchParams.get('guild'));
      if (!guild) return reply(404, { message: 'Choose a connected server.' });
      const channelCollection = url.pathname === '/channels' ? await guild.channels.fetch() : guild.channels.cache;
      const channels = [...channelCollection.values()].filter(c => c?.isTextBased() && c.viewable);
      if (url.pathname === '/channels') return reply(200, { channels: channels.map(c => {
        const project = projectForChannel(c!);
        return { id: c!.id, name: c!.name, project: project ? { name: project.name,
          activeTasks: repo.listTasks(project.id).filter(t => !['done', 'declined'].includes(t.status)).length } : null };
      }) });
      const channel = channels.find(c => c?.id === url.searchParams.get('channel'));
      if (!channel || !channel.isTextBased()) return reply(404, { message: 'Channel is unavailable to this bot.' });
      if (url.pathname === '/snapshot') {
        const project = projectForChannel(channel);
        const tasks = project ? repo.listTasks(project.id) : [];
        const members = project ? repo.listMembers(project.id).map(m => ({ id: m.discord_id, name: m.display_name })) : [];
        const missingOwners = [...new Set(tasks.map(t => t.owner_id).filter((id): id is string => !!id && !members.some(m => m.id === id)))];
        const uncached = missingOwners.filter(id => !guild.members.cache.has(id));
        if (uncached.length) await guild.members.fetch({ user: uncached }).catch(() => undefined);
        for (const id of missingOwners) members.push({ id, name: guild.members.cache.get(id)?.displayName || client.users.cache.get(id)?.username || 'Discord teammate' });
        return reply(200, { project: project ? { id: project.id, name: project.name, final_deadline: project.final_deadline, submitted_at: project.submitted_at } : null,
          members, tasks, dependencies: project ? repo.listDependencies(project.id) : [],
          meetings: project ? repo.listMeetings(project.id) : [],
          decisions: project ? repo.listDecisions(project.id, 'pending').map(d => ({ id: d.id, summary: d.summary, conflicts: d.conflicts, required_approvers: d.required_approvers, approvals: d.approvals, message_id: d.message_id })) : [],
          requirements: project ? repo.listRequirements(project.id) : [] });
      }
      if (url.pathname === '/messages') {
        // Read-only feed of the latest channel messages; sending stays in Discord.
        const fetched = await channel.messages.fetch({ limit: 50 });
        const messages = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp).map(m => ({
          id: m.id, author: m.member?.displayName || m.author.globalName || m.author.username, bot: m.author.bot, at: m.createdTimestamp,
          text: m.content,
          embeds: m.embeds.map(e => ({ title: e.title, description: e.description, color: e.hexColor, url: e.url,
            fields: e.fields.map(f => ({ name: f.name, value: f.value, inline: !!f.inline })), footer: e.footer?.text ?? null })),
          attachments: [...m.attachments.values()].map(a => ({ name: a.name, url: a.url })), url: m.url }));
        // Raw <@id>, <@&id> and <#id> tokens are resolved here so the browser never needs guild access.
        const raw = messages.map(m => [m.text, ...m.embeds.flatMap(e => [e.title, e.description, e.footer, ...e.fields.flatMap(f => [f.name, f.value])])].join('\n')).join('\n');
        const ids = (pattern: RegExp) => [...new Set([...raw.matchAll(pattern)].map(x => x[1]))];
        const users = ids(/<@!?(\d+)>/g);
        const missing = users.filter(id => !guild.members.cache.has(id));
        if (missing.length) await guild.members.fetch({ user: missing }).catch(() => undefined);
        const names: Record<string, string> = {};
        for (const id of users) {
          const name = guild.members.cache.get(id)?.displayName ?? client.users.cache.get(id)?.username;
          if (name) names[`@${id}`] = name;
        }
        for (const id of ids(/<@&(\d+)>/g)) { const role = guild.roles.cache.get(id); if (role) names[`@&${id}`] = role.name; }
        for (const id of ids(/<#(\d+)>/g)) { const c = guild.channels.cache.get(id); if (c) names[`#${id}`] = c.name; }
        return reply(200, { messages, names });
      }
      reply(404, { message: 'Not found' });
    } catch {
      reply(502, { message: 'Discord could not load this channel. Check bot permissions and try again.' });
    }
  });
  server.listen(0, '127.0.0.1', () => {
    const addr = server.address() as { port: number };
    process.stdout.write(`TESSERACT_READY ${addr.port}\n`);
  });
  return server;
}

