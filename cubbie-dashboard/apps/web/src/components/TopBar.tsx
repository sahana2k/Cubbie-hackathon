import { Icon } from "./Icon";
import cubbieLogo from "../assets/cubbie-icon.png";
import type { IntegrationStatus, View } from "@cubbie/shared/types";
import { VIEWS, VIEW_ORDER } from "@cubbie/shared/views";

interface Props {
  view: View; onView: (v: View) => void;
  query: string; onQuery: (q: string) => void;
  status: IntegrationStatus | null;
  theme: "light" | "dark"; onTheme: () => void;
  pane: "chat" | "board"; onPane: (p: "chat" | "board") => void;
  graderAvailable: boolean;
  settingsOpen: boolean; onSettings: () => void;
  discordOpen: boolean; onDiscord: () => void;
  onReset?: () => void;
}

export function TopBar({ view, onView, query, onQuery, status, theme, onTheme, pane, onPane, onReset, graderAvailable, settingsOpen, onSettings, discordOpen, onDiscord }: Props) {
  return (
    <header className="topbar">
      <div className="brand">
        <img className="cubboard-logo" src={cubbieLogo} alt="" />
        <span className="wordmark">cubboard</span>
      </div>

      <nav className="view-switch" aria-label="Dashboard view">
        {VIEW_ORDER.map(v => (
          <button key={v} disabled={v === "grader" && !graderAvailable} title={v === "grader" && !graderAvailable ? "No TA/Grader role is available in Canvas settings" : undefined} className={v === view ? "on" : ""} aria-pressed={v === view} onClick={() => onView(v)}>
            <Icon name={v} /><span className="long">{VIEWS[v].label}</span><span className="short">{VIEWS[v].short}</span>
          </button>
        ))}
      </nav>

      <div className="pane-switch" role="tablist" aria-label="Pane">
        <button role="tab" aria-selected={pane === "chat"} className={pane === "chat" ? "on" : ""} onClick={() => onPane("chat")}><Icon name="chat" />Cubbie</button>
        <button role="tab" aria-selected={pane === "board"} className={pane === "board" ? "on" : ""} onClick={() => onPane("board")}><Icon name="board" />Board</button>
      </div>

      <label className="search">
        <span className="sr">Search tasks</span>
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M13 13l4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
        <input value={query} onChange={e => onQuery(e.target.value)} placeholder="Search tasks, courses, companies" />
      </label>

      <div className="status-pills">
        {status?.mode === "demo" && (
          <button className="pill demo" onClick={onReset} title="Fictional sample data. Click to reset it.">Demo data</button>
        )}
        <span className={`pill ${status?.imessageRelay === "online" ? "ok" : "warn"}`} title={status?.relayDevice ? `Relay: ${status.relayDevice}` : "iMessage relay"}>
          <i />iMessage {status?.imessageRelay === "online" ? "live" : status?.imessageRelay === "offline" ? "offline" : "not set up"}
        </span>
        {status?.transport === "local"
          ? <span className={`pill ${status.canvas?.connected ? "ok" : "warn"}`}><i />Canvas {status.canvas?.connected ? "connected" : "not connected"}</span>
          : null}
        <button className={`nav-toggle ${discordOpen ? "on" : ""}`} aria-pressed={discordOpen} onClick={onDiscord} title="Toggle Discord panel"><Icon name="discord" />Discord <span>{discordOpen ? "On" : "Off"}</span></button>
        <button className={`icon-btn ${settingsOpen ? "on" : ""}`} onClick={onSettings} aria-label="Settings" aria-pressed={settingsOpen} title="Settings"><Icon name="settings" /></button>
        <button className="icon-btn" onClick={onTheme} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>
          {theme === "dark"
            ? <svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="4" fill="currentColor" /><g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">{[0, 45, 90, 135, 180, 225, 270, 315].map(a => <line key={a} x1="10" y1="1.8" x2="10" y2="3.6" transform={`rotate(${a} 10 10)`} />)}</g></svg>
            : <svg viewBox="0 0 20 20"><path d="M15.5 12.8A6.5 6.5 0 017.2 4.5a6.5 6.5 0 108.3 8.3z" fill="currentColor" /></svg>}
        </button>
      </div>
    </header>
  );
}
