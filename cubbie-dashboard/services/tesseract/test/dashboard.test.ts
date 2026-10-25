import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Client } from 'discord.js';
import { expect, it, vi } from 'vitest';
import { startDashboard } from '../src/dashboard';
import * as repo from '../src/db/repo';
import { ALEX, freshProject } from './helpers';

it('finds project channels and returns actual assignments scoped to the selected channel', async () => {
  const project = freshProject();
  const task = repo.createTask({ project_id: project.id, title: 'Build the API', owner_id: ALEX, status: 'confirmed', source_url: 'https://discord.com/channels/g1/c1/m1' });
  const channel = (id: string, name: string) => ({ id, name, viewable: true, isTextBased: () => true, isThread: () => false });
  const channels = new Map([['general', channel('general', 'general')], ['c1', channel('c1', 'project')]]);
  const guild = { id: 'g1', name: 'Team', channels: { cache: channels, fetch: async () => channels }, members: { cache: new Map(), fetch: vi.fn() } };
  const client = { isReady: () => true, guilds: { cache: new Map([['g1', guild]]) }, users: { cache: new Map() } } as unknown as Client;
  vi.stubEnv('TESSERACT_BRIDGE_TOKEN', 'test-token');
  vi.stubEnv('DISCORD_GUILD_ID', 'g1');
  const server = startDashboard(client)!;
  try {
    await once(server, 'listening');
    const get = async (path: string) => {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`, { headers: { Authorization: 'Bearer test-token' } });
      expect(response.status).toBe(200);
      return response.json();
    };
    const result = await get('/channels?guild=g1');
    expect(result.channels.find((c: { id: string }) => c.id === 'c1').project.activeTasks).toBe(1);
    const snapshot = await get('/snapshot?guild=g1&channel=c1');
    expect(snapshot.tasks[0]).toMatchObject({ id: task.id, owner_id: ALEX, status: 'confirmed', source_url: task.source_url });
    expect(snapshot.members).toContainEqual({ id: ALEX, name: 'Alex' });
    expect((await get('/snapshot?guild=g1&channel=general')).tasks).toEqual([]);
    repo.updateTask(task.id, { status: 'done' });
    expect((await get('/channels?guild=g1')).channels.find((c: { id: string }) => c.id === 'c1').project.activeTasks).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    vi.unstubAllEnvs();
  }
});
