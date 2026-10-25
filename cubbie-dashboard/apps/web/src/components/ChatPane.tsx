import { useEffect, useRef } from "react";
import type { ChatMessage, IntegrationStatus } from "@cubbie/shared/types";
import { chatStamp } from "../lib/dates";

interface Props {
  messages: ChatMessage[];
  typing: boolean;
  status: IntegrationStatus | null;
  draft: string;
  onDraft: (s: string) => void;
  onSend: (text: string) => void;
  focusKey: number;
}

const SUGGESTIONS = ["what's due this week", "what needs grading", "my applications", "add lab report due friday"];

export function ChatPane({ messages, typing, status, draft, onDraft, onSend, focusKey }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" }); }, [messages.length, typing]);
  useEffect(() => { if (focusKey) input.current?.focus(); }, [focusKey]);

  const lastOut = [...messages].reverse().find(m => m.direction === "out");
  const submit = () => { const t = draft.trim(); if (!t || (status?.transport === "local" && status.imessageRelay !== "online")) return; onSend(t); onDraft(""); };

  return (
    <section className="chat" aria-label="iMessage conversation with Cubbie">
      <header className="chat-head">
        <div className="avatar" aria-hidden="true">c</div>
        <div className="who">
          <strong>Cubbie</strong>
          <span>{status?.imessageRelay === "online" ? `iMessage, synced through ${status.relayDevice ?? "your Mac"}` : status?.transport === "local" ? "Connect your Cubbie conversation in Settings." : "iMessage relay offline. Messages will send when your Mac reconnects."}</span>
        </div>
      </header>

      <div className="chat-scroll" ref={scroller}>
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const next = messages[i + 1];
          const showStamp = !prev || Date.parse(m.at) - Date.parse(prev.at) > 15 * 60_000;
          const tail = !next || next.direction !== m.direction || Date.parse(next.at) - Date.parse(m.at) > 60_000;
          return (
            <div key={m.id} className="msg-row">
              {showStamp && <div className="stamp">{chatStamp(m.at)}</div>}
              <div className={`bubble ${m.direction === "out" ? "me" : "them"} ${tail ? "tail" : ""} ${m.status === "failed" ? "failed" : ""}`}>
                {m.text}
                {m.attachments?.map((attachment, index) => attachment.url && attachment.mime?.startsWith("image/")
                  ? <a href={attachment.url} target="_blank" rel="noreferrer" key={index} className="message-image"><img src={attachment.url} alt={attachment.name || "Cubbie image card"} loading="lazy" /></a>
                  : <span className="fine" key={index}>{attachment.name}</span>)}
              </div>
              {m === lastOut && m.status && m.status !== "sending" && (
                <div className="receipt">{m.status === "failed" ? "Not delivered. Check Messages before retrying." : m.status === "read" ? "Read" : m.status === "sent" ? "Sent" : "Delivered"}</div>
              )}
              {m.status === "sending" && <div className="receipt">Sending</div>}
            </div>
          );
        })}
        {typing && <div className="bubble them tail typing" aria-label="Cubbie is typing"><span /><span /><span /></div>}
      </div>

      <div className="chat-suggest" aria-label="Suggestions">
        {SUGGESTIONS.map(s => <button key={s} disabled={status?.transport === "local" && status.imessageRelay !== "online"} onClick={() => onSend(s)}>{s}</button>)}
      </div>

      <form className="composer" onSubmit={e => { e.preventDefault(); submit(); }}>
        <textarea
          ref={input}
          rows={1}
          value={draft}
          placeholder="iMessage"
          aria-label="Message Cubbie"
          onChange={e => onDraft(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
        />
        <button type="submit" className="send" aria-label="Send" disabled={!draft.trim() || (status?.transport === "local" && status.imessageRelay !== "online")}>
          <svg viewBox="0 0 20 20"><path d="M10 15.5V5M5.5 9.5L10 5l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </form>
    </section>
  );
}
