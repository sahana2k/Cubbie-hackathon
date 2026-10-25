import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatMessage, DiscordMessage, IntegrationStatus, RealtimeEvent, Task, View } from "@cubbie/shared/types";
import { VIEWS } from "@cubbie/shared/views";
import { api, type TaskDraft } from "./api";
import { Icon, type IconName } from "./components/Icon";
import { Board } from "./components/Board";
import { ChatPane } from "./components/ChatPane";
import { TesseractWorkspace } from "./components/TesseractWorkspace";
import { Settings } from "./components/Settings";
import { TaskDrawer } from "./components/TaskDrawer";
import { TopBar } from "./components/TopBar";
import { Upcoming } from "./components/Upcoming";
import { WeekView } from "./components/WeekView";
import { dashboardTasks, matches, summary } from "./lib/derive";

type Tab = "board" | "upcoming" | "week" | "discord" | "settings";
const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "board", label: "Board", icon: "board" }, { id: "upcoming", label: "List view", icon: "list" }, { id: "week", label: "Calendar view", icon: "calendar" }
];

function initialView(): View {
  const h = location.hash.slice(1);
  return h === "grader" || h === "jobs" || h === "student" ? h : "student";
}
function initialTheme(): "light" | "dark" {
  try { const t = localStorage.getItem("cubbie.theme"); if (t === "light" || t === "dark") return t; } catch { /* ignore */ }
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function App() {
  const [view, setView] = useState<View>(initialView);
  const [tab, setTab] = useState<Tab>("board");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [, setDiscord] = useState<DiscordMessage[]>([]);
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [typing, setTyping] = useState(false);
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [focusKey, setFocusKey] = useState(0);
  const [pane, setPane] = useState<"chat" | "board">("board");
  const [theme, setTheme] = useState(initialTheme);
  const [allViews, setAllViews] = useState(false);
  const graderAvailable = status?.mode === "demo" || status?.canvas?.graderAvailable === true || (!api.local && tasks.some(t => t.view === "grader"));

  useEffect(() => {
    if (status && !graderAvailable && view === "grader") setView("student");
  }, [graderAvailable, view, status]);

  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("cubbie.theme", theme); } catch { /* ignore */ }
  }, [theme]);

  useEffect(() => {
    if (location.hash.slice(1) !== view) history.replaceState(null, "", `#${view}`);
    const onHash = () => setView(initialView());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [view]);

  const load = useCallback(async () => {
    try {
      const [t, m, d, s] = await Promise.all([api.listTasks(), api.listMessages(), api.listDiscord(), api.status()]);
      setTasks(t); setMessages(m); setDiscord(d); setStatus(s);
    } catch (e) { setError((e as Error).message); }
  }, []);

  useEffect(() => {
    void load();
    return api.subscribe((e: RealtimeEvent) => {
      if (e.type === "tasks.snapshot") setTasks(e.tasks);
      else if (e.type === "chat.snapshot") setMessages(e.messages);
      else if (e.type === "task.upsert") setTasks(ts => { const i = ts.findIndex(t => t.id === e.task.id); if (i < 0) return [...ts, e.task]; const c = ts.slice(); c[i] = e.task; return c; });
      else if (e.type === "task.delete") setTasks(ts => ts.filter(t => t.id !== e.id));
      else if (e.type === "chat.upsert") setMessages(ms => { const i = ms.findIndex(m => m.id === e.message.id); if (i < 0) return [...ms, e.message]; const c = ms.slice(); c[i] = e.message; return c; });
      else if (e.type === "chat.typing") setTyping(e.typing);
      else if (e.type === "discord.message") setDiscord(ds => (ds.some(d => d.id === e.message.id) ? ds : [...ds, e.message]));
      else if (e.type === "status") setStatus(e.status);
    });
  }, [load]);

  const guard = async (p: Promise<unknown>) => { try { await p; } catch (e) { setError((e as Error).message); } };

  const [today, setToday] = useState(() => new Date().toDateString());
  useEffect(() => {
    const timer = window.setInterval(() => setToday(new Date().toDateString()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const selectedTasks = useMemo(() => dashboardTasks(tasks), [tasks, today]);
  const visible = useMemo(() => selectedTasks.filter(t => (allViews && tab === "upcoming" ? true : t.view === view) && matches(t, query)), [selectedTasks, view, query, allViews, tab]);
  const openTask = tasks.find(t => t.id === openId) ?? null;

  const ask = (prompt: string) => { setDraft(prompt); setOpenId(null); setPane("chat"); setFocusKey(k => k + 1); };
  const move = (id: string, statusId: string) => {
    const t = tasks.find(x => x.id === id); if (!t || t.status === statusId) return;
    const patch: Partial<Task> = { status: statusId };
    if (VIEWS[t.view].doneStatuses.includes(statusId) && t.view !== "jobs") patch.progress = 100;
    if (t.view === "jobs" && t.job) patch.job = { ...t.job, stage: statusId === "closed" ? "rejected" : (statusId as NonNullable<Task["job"]>["stage"]) };
    setTasks(ts => ts.map(x => (x.id === id ? { ...x, ...patch } : x)));
    void guard(api.updateTask(id, patch));
  };

  const syncJobs = api.local ? async () => {
    const result = await api.local!.syncJobs();
    const [updatedTasks, updatedStatus] = await Promise.all([api.listTasks(), api.status()]);
    setTasks(updatedTasks); setStatus(updatedStatus);
    setView("jobs"); setTab("board"); setPane("board"); setQuery("");
    return `${result.active} active application${result.active === 1 ? "" : "s"} synced to Job hunt.${result.skipped ? ` ${result.skipped} rejected, withdrawn or closed skipped.` : ""}`;
  } : undefined;

  return (
    <div className={`app pane-${pane}`}>
      <TopBar view={view} onView={v => { setView(v); setPane("board"); }} query={query} onQuery={setQuery} status={status}
        theme={theme} onTheme={() => setTheme(t => (t === "dark" ? "light" : "dark"))} pane={pane} onPane={setPane}
        graderAvailable={graderAvailable} settingsOpen={tab === "settings"} onSettings={() => { setTab(t => t === "settings" ? "board" : "settings"); setPane("board"); }}
        discordOpen={tab === "discord"} onDiscord={() => { setTab(t => t === "discord" ? "board" : "discord"); setPane("board"); }}
        onReset={api.reset ? () => void api.reset!().then(load) : undefined} />

      <main className="split">
        {tab === "discord" ? <aside id="tesseract-chat" className="chat ts-chat" aria-label="Discord connection" /> : <ChatPane messages={messages} typing={typing} status={status} draft={draft} onDraft={setDraft} focusKey={focusKey}
          onSend={text => void guard(api.sendMessage(text))} onSyncJobs={syncJobs} />}

        <section className="work" aria-label="Dashboard">
          <div className="work-head">
            <div>
              <h1>{tab === "settings" ? "Settings" : tab === "discord" ? "Group project" : view === "student" ? "Coursework" : view === "grader" ? "Grading" : "Job hunt"}</h1>
              <p className="summary">{tab === "discord" ? "Your group project, in four dimensions." : tab === "settings" ? "Connect iMessage, Cubbie and Discord." : summary(view, visible)}</p>
            </div>
            <div className="tabs" role="tablist" aria-label="Dashboard sections">
              {TABS.map(t => (
                <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}
                  disabled={tab === "discord"} title={tab === "discord" ? "Turn Discord off to use this view" : undefined}><Icon name={t.icon} />{t.label}</button>
              ))}
            </div>
          </div>

          {error && <p className="error" role="alert">{error} <button onClick={() => { setError(null); void load(); }}>Reload</button></p>}

          <div className="work-body">
            {tab === "board" && <Board view={view} tasks={visible} onMove={move} onOpen={setOpenId} onCreate={(d: TaskDraft) => void guard(api.createTask(d))} />}
            {tab === "upcoming" && (
              <>
                <label className="toggle"><input type="checkbox" checked={allViews} onChange={e => setAllViews(e.target.checked)} /> Show coursework, grading and jobs together</label>
                <Upcoming tasks={visible} onOpen={setOpenId} showView={allViews} />
              </>
            )}
            {tab === "week" && <WeekView tasks={visible} onOpen={setOpenId} />}
            {tab === "discord" && <TesseractWorkspace query={query} />}
            {tab === "settings" && <Settings api={api} status={status} onError={setError} />}
          </div>
        </section>
      </main>

      {openTask && (
        <TaskDrawer task={openTask} onClose={() => setOpenId(null)} onAsk={ask}
          onSave={(id, patch) => { void guard(api.updateTask(id, patch)); setOpenId(null); }}
          onDelete={id => { void guard(api.deleteTask(id)); setOpenId(null); }} />
      )}
    </div>
  );
}
