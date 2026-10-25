import { useMemo, useState } from "react";
import type { DiscordMessage, IntegrationStatus } from "@cubbie/shared/types";
import { chatStamp } from "../lib/dates";

export function DiscordPanel({ messages, status, onSend, onSetup }: { messages: DiscordMessage[]; status: IntegrationStatus | null; onSend: (text: string, channelId: string) => void; onSetup: () => void }) {
  const channels = useMemo(() => {
    const m = new Map<string, string>();
    messages.forEach(x => m.set(x.channelId, x.channelName));
    return [...m.entries()];
  }, [messages]);
  const [ch, setCh] = useState<string>(channels[0]?.[0] ?? "updates");
  const [text, setText] = useState("");
  const list = messages.filter(m => m.channelId === ch);
  const name = channels.find(c => c[0] === ch)?.[1] ?? ch;

  if (status?.discord !== "linked") {
    return (
      <div className="discord-empty">
        <h3>Link Discord</h3>
        <p>Get your morning brief and overdue follow-ups in Discord, and use /due, /grading and /apps in any server with the Cubbie Board bot.</p>
        <button className="primary" onClick={onSetup}>Link Discord in Settings</button>
      </div>
    );
  }

  return (
    <div className="discord">
      <aside className="dc-side">
        <p className="dc-guild">{status.discordGuild ?? "Your server"}</p>
        {channels.map(([id, n]) => (
          <button key={id} className={id === ch ? "on" : ""} onClick={() => setCh(id)}><span aria-hidden="true">#</span>{n}</button>
        ))}
        <p className="dc-help">Slash commands: /due, /grading, /apps, /link</p>
      </aside>
      <section className="dc-main" aria-label={`Discord channel ${name}`}>
        <header className="dc-head"><span aria-hidden="true">#</span>{name}</header>
        <div className="dc-scroll">
          {list.map(m => (
            <div key={m.id} className="dc-msg">
              <div className="dc-av" aria-hidden="true" data-bot={m.bot ? "1" : "0"}>{m.author[0]?.toUpperCase()}</div>
              <div>
                <p className="dc-meta"><strong>{m.author}</strong>{m.bot && <span className="app-badge">App</span>}<time>{chatStamp(m.at)}</time></p>
                <p className="dc-text">{m.text}</p>
              </div>
            </div>
          ))}
        </div>
        <form className="dc-compose" onSubmit={e => { e.preventDefault(); if (text.trim()) { onSend(text.trim(), ch); setText(""); } }}>
          <input value={text} onChange={e => setText(e.target.value)} placeholder={`Message #${name}`} aria-label={`Message #${name}`} />
        </form>
      </section>
    </div>
  );
}
