import type { ChatMessage, DiscordMessage, IntegrationStatus, RealtimeEvent, Task } from "@cubbie/shared/types";
import { seedChat, seedDiscord, seedTasks } from "../data/seed";
import { cubbieReply } from "./cubbieBrain";
import type { Api, TaskDraft } from "./types";

const KEY = "cubbie-dashboard-demo-v1";
type State = { tasks: Task[]; chat: ChatMessage[]; discord: DiscordMessage[]; seededAt: string };

function load(): State {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as State;
      // Re-seed after a day so relative dates stay meaningful.
      if (Date.now() - Date.parse(s.seededAt) < 20 * 3600_000) return s;
    }
  } catch { /* storage unavailable: fall through to fresh seed */ }
  const now = new Date();
  return { tasks: seedTasks(now), chat: seedChat(now), discord: seedDiscord(now), seededAt: now.toISOString() };
}

const uid = () => Math.random().toString(36).slice(2, 10);

export function createDemoApi(): Api {
  let state = load();
  const subs = new Set<(e: RealtimeEvent) => void>();
  const emit = (e: RealtimeEvent) => subs.forEach(fn => fn(e));
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ } };
  const status: IntegrationStatus = { imessageRelay: "online", relayDevice: "Demo Mac", discord: "linked", discordGuild: "Cubbie Study", lastCubbieSync: new Date(Date.now() - 6 * 60_000).toISOString(), mode: "demo" };

  const putTask = (t: Task) => {
    const i = state.tasks.findIndex(x => x.id === t.id);
    if (i >= 0) state.tasks[i] = t; else state.tasks.push(t);
    save(); emit({ type: "task.upsert", task: t });
  };

  const api: Api = {
    mode: "demo",
    async listTasks() { return structuredClone(state.tasks); },
    async createTask(d: TaskDraft) {
      const now = new Date().toISOString();
      const t: Task = { source: "manual", progress: 0, ...d, id: uid(), createdAt: now, updatedAt: now } as Task;
      putTask(t); return t;
    },
    async updateTask(id, patch) {
      const cur = state.tasks.find(t => t.id === id);
      if (!cur) throw new Error("Task not found");
      const t = { ...cur, ...patch, id, updatedAt: new Date().toISOString() };
      putTask(t); return t;
    },
    async deleteTask(id) {
      state.tasks = state.tasks.filter(t => t.id !== id);
      save(); emit({ type: "task.delete", id });
    },
    async listMessages() { return structuredClone(state.chat); },
    async sendMessage(text) {
      const msg: ChatMessage = { id: uid(), direction: "out", text, at: new Date().toISOString(), status: "delivered" };
      state.chat.push(msg); save();
      emit({ type: "chat.upsert", message: msg });
      const result = cubbieReply(text, state.tasks);
      setTimeout(() => emit({ type: "chat.typing", typing: true }), 450);
      result.replies.forEach((reply, i) => {
        setTimeout(() => {
          if (i === 0 && result.create) {
            const now = new Date().toISOString();
            putTask({ ...result.create, id: uid(), createdAt: now, updatedAt: now } as Task);
          }
          const m: ChatMessage = { id: uid(), direction: "in", text: reply, at: new Date().toISOString() };
          state.chat.push(m);
          const last = state.chat.filter(x => x.direction === "out").pop();
          if (last) last.status = "read";
          save();
          emit({ type: "chat.upsert", message: m });
          if (last) emit({ type: "chat.upsert", message: { ...last } });
          emit({ type: "chat.typing", typing: i < result.replies.length - 1 });
        }, 1300 + i * 1100);
      });
      return msg;
    },
    async listDiscord() { return structuredClone(state.discord); },
    async sendDiscord(text, channelId) {
      const ch = state.discord.find(m => m.channelId === channelId);
      const m: DiscordMessage = { id: uid(), channelId, channelName: ch?.channelName ?? channelId, author: "you", text, at: new Date().toISOString() };
      state.discord.push(m); save(); emit({ type: "discord.message", message: m });
      return m;
    },
    async status() { return status; },
    async createRelayToken() { return { token: "cbr_demo_" + uid() + uid() }; },
    async createSyncKey() { return { key: "cbk_demo_" + uid() + uid(), envName: "CUBBIE_DASHBOARD_API_KEY" }; },
    async createDiscordLinkCode() { return { code: uid().slice(0, 6).toUpperCase(), expiresInSeconds: 600 }; },
    async setDiscordChannels(channelIds) { return { channelIds }; },
    async weeklySummary() {
      const open = state.tasks.filter(t => !["done", "offer", "closed"].includes(t.status));
      const cls = open.filter(t => t.view === "student").length, grade = open.filter(t => t.view === "grader").length, jobs = open.filter(t => t.view === "jobs").length;
      return { text: `This week: ${cls} class items, ${grade} grading tasks and ${jobs} open applications. Start with STP 420 Quiz 6 tonight, then finish the ENG 302 proposal since it's already late. Block two hours for Lab 4 grading before Project 2's deadline. On the job side, send the Harbor Robotics follow-up today.\n\n(Demo text. In the live app this comes from Claude on Amazon Bedrock, using only your board's facts.)` };
    },
    endpoints() { return { apiUrl: "https://<api-id>.execute-api.<region>.amazonaws.com", wsUrl: "wss://<ws-id>.execute-api.<region>.amazonaws.com/prod" }; },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn); }; },
    async reset() {
      try { localStorage.removeItem(KEY); } catch { /* ignore */ }
      state = load(); save();
    }
  };
  return api;
}
