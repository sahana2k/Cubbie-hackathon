import type { ChatMessage, IntegrationStatus, RealtimeEvent, Task } from "@cubbie/shared/types";
import type { Api } from "./types";

/** Same-origin, loopback-only personal server. No demo responses or browser-stored credentials. */
export function createLocalApi(base: string): Api {
  const listeners = new Set<(event: RealtimeEvent) => void>();
  const previous = new Map<string, string>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  const emit = (event: RealtimeEvent) => listeners.forEach(fn => fn(event));
  async function call<T>(path: string, data?: unknown, method = data === undefined ? "GET" : "POST"): Promise<T> {
    const response = await fetch(base + path, { method, credentials: "same-origin", cache: "no-store",
      headers: { "content-type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message ?? `Local request failed (${response.status})`);
    return result as T;
  }
  async function poll() {
    if (polling || !listeners.size) return;
    polling = true;
    try {
      const [tasks, messages] = await Promise.all([
        call<{ items: Task[] }>("/tasks"), call<{ items: ChatMessage[] }>("/chat/messages")
      ]);
      const status = await call<IntegrationStatus>("/integrations/status");
      const events: RealtimeEvent[] = [{ type: "tasks.snapshot", tasks: tasks.items },
        { type: "chat.snapshot", messages: messages.items }, { type: "status", status }];
      for (const event of events) {
        const serialized = JSON.stringify(event);
        if (previous.get(event.type) !== serialized) { previous.set(event.type, serialized); emit(event); }
      }
    } catch {
      emit({ type: "status", status: { mode: "live", transport: "local", discord: "not_linked",
        imessageRelay: "offline", imessageError: "Local connection unavailable. Check that the dashboard server is running." } });
    } finally { polling = false; }
  }
  async function change<T>(path: string, data: unknown = {}, method = "POST"): Promise<T> {
    const result = await call<T>(path, data, method);
    void poll();
    return result;
  }
  const unavailable = async (): Promise<never> => { throw new Error("This action is not part of the local dashboard."); };
  return {
    mode: "live",
    local: {
      syncMessages: selected => change("/local/imessage/sync", { selected }),
      connections: () => call("/local/connections"),
      connectCanvas: (url, token) => change("/local/canvas/connect", { url, token }),
      syncCanvas: (courses, includeOtherCourses = false) => change("/local/canvas/sync", { courses, includeOtherCourses }),
      disconnectCanvas: () => change("/local/canvas/disconnect"),
      connectMessages: handle => change("/local/imessage/connect", { handle }),
      disconnectMessages: () => change("/local/imessage/disconnect")
    },
    listTasks: () => call<{ items: Task[] }>("/tasks").then(result => result.items),
    createTask: draft => change("/tasks", draft),
    updateTask: (id, patch) => change(`/tasks/${encodeURIComponent(id)}`, patch, "PATCH"),
    deleteTask: id => change(`/tasks/${encodeURIComponent(id)}`, {}, "DELETE"),
    listMessages: () => call<{ items: ChatMessage[] }>("/chat/messages").then(result => result.items),
    sendMessage: text => change("/chat/messages", { text }),
    listDiscord: async () => [], sendDiscord: unavailable,
    status: () => call("/integrations/status"),
    weeklySummary: () => change("/summary"),
    subscribe(fn) {
      listeners.add(fn);
      if (!timer) { void poll(); timer = setInterval(() => void poll(), 3000); }
      return () => { listeners.delete(fn); if (!listeners.size) { clearInterval(timer); timer = undefined; previous.clear(); } };
    }
  };
}
