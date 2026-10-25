import type { ChatMessage, DiscordMessage, IntegrationStatus, RealtimeEvent, Task } from "@cubbie/shared/types";
import { getIdToken } from "../auth/cognito";
import type { Api, TaskDraft } from "./types";

/**
 * Live adapter: API Gateway HTTP API (Cognito JWT authorizer) for reads/writes and the
 * API Gateway WebSocket API for realtime events (chat, task changes, Discord, relay status).
 */
export function createHttpApi(baseUrl: string, wsUrl: string): Api {
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await getIdToken();
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) }
    });
    if (res.status === 204) return undefined as T;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body?.message ?? `Request failed (${res.status})`);
    return body as T;
  }

  const subs = new Set<(e: RealtimeEvent) => void>();
  let socket: WebSocket | null = null;
  let retry = 0;
  let closed = false;

  async function connect() {
    if (closed || socket) return;
    const token = await getIdToken();
    const ws = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}&role=web`);
    socket = ws;
    ws.onopen = () => { retry = 0; };
    ws.onmessage = ev => {
      try { const e = JSON.parse(ev.data) as RealtimeEvent; subs.forEach(fn => fn(e)); } catch { /* ignore malformed frames */ }
    };
    ws.onclose = () => {
      socket = null;
      if (closed || subs.size === 0) return;
      const delay = Math.min(30_000, 1000 * 2 ** retry++);
      setTimeout(connect, delay);
    };
  }

  return {
    mode: "live",
    listTasks: () => call<{ items: Task[] }>("/tasks").then(r => r.items),
    createTask: (d: TaskDraft) => call<Task>("/tasks", { method: "POST", body: JSON.stringify(d) }),
    updateTask: (id, patch) => call<Task>(`/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
    deleteTask: id => call<void>(`/tasks/${encodeURIComponent(id)}`, { method: "DELETE" }),
    listMessages: () => call<{ items: ChatMessage[] }>("/chat/messages?limit=200").then(r => r.items),
    sendMessage: text => call<ChatMessage>("/chat/messages", { method: "POST", body: JSON.stringify({ text, clientId: crypto.randomUUID() }) }),
    listDiscord: () => call<{ items: DiscordMessage[] }>("/discord/messages?limit=100").then(r => r.items),
    sendDiscord: (text, channelId) => call<DiscordMessage>("/discord/messages", { method: "POST", body: JSON.stringify({ text, channelId }) }),
    status: () => call<IntegrationStatus>("/integrations/status"),
    createRelayToken: name => call<{ token: string }>("/devices", { method: "POST", body: JSON.stringify({ name }) }),
    createSyncKey: () => call<{ key: string; envName: string }>("/ingest-keys", { method: "POST", body: "{}" }),
    createDiscordLinkCode: () => call<{ code: string; expiresInSeconds: number }>("/discord/link-code", { method: "POST", body: "{}" }),
    setDiscordChannels: channelIds => call<{ channelIds: string[] }>("/discord/channels", { method: "PUT", body: JSON.stringify({ channelIds }) }),
    weeklySummary: () => call<{ text: string }>("/summary", { method: "POST", body: "{}" }),
    endpoints: () => ({ apiUrl: baseUrl, wsUrl }),
    subscribe(fn) {
      subs.add(fn); closed = false; void connect();
      return () => { subs.delete(fn); if (subs.size === 0) { closed = true; socket?.close(); socket = null; } };
    }
  };
}
