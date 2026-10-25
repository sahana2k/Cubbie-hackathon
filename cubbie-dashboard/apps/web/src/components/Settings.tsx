import { useState } from "react";
import type { IntegrationStatus } from "@cubbie/shared/types";
import type { Api } from "../api";
import { chatStamp, localZone } from "../lib/dates";
import { LocalConnections } from "./LocalConnections";

/** Connections: iMessage relay, Cubbie sync key, Discord link, and the weekly plan. */
export function Settings({ api, status, onError }: { api: Api; status: IntegrationStatus | null; onError: (m: string) => void }) {
  const [relay, setRelay] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [channels, setChannels] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { apiUrl, wsUrl } = api.endpoints();

  if (api.local) return <LocalConnections local={api.local} status={status} onError={onError} />;

  const run = async (id: string, fn: () => Promise<void>) => {
    setBusy(id);
    try { await fn(); } catch (e) { onError((e as Error).message); } finally { setBusy(null); }
  };

  return (
    <div className="settings">
      <section className="set-card">
        <header><h3>iMessage</h3><span className={`pill ${status?.imessageRelay === "online" ? "ok" : "warn"}`}><i />{status?.imessageRelay === "online" ? `Live on ${status.relayDevice ?? "your Mac"}` : status?.imessageRelay === "offline" ? "Relay offline" : "Not set up"}</span></header>
        <p>The relay runs on a Mac signed in to your Apple ID. It syncs only your one-to-one chat with Cubbie, and sends what you type here from Messages.</p>
        <ol className="steps">
          <li>On the Mac: <code>cd agents/imessage-relay &amp;&amp; npm install &amp;&amp; npm run build &amp;&amp; node dist/index.js setup</code></li>
          <li>Paste this WebSocket URL: <code className="copy">{wsUrl}</code></li>
          <li>Paste a relay token. Making a new one disconnects the old Mac.</li>
        </ol>
        {relay ? <Secret value={relay} label="Relay token" /> : (
          <button className="primary" disabled={busy === "relay"} onClick={() => run("relay", async () => setRelay((await api.createRelayToken("My Mac")).token))}>Create relay token</button>
        )}
      </section>

      <section className="set-card">
        <header><h3>Cubbie sync</h3><span className="pill">{status?.lastCubbieSync ? `Last sync ${chatStamp(status.lastCubbieSync)}` : "Never synced"}</span></header>
        <p>Cubbie fills this board using the <code>cubbie-dashboard-sync</code> Skill. Text Cubbie the Skill's GitHub link to install it, then save this key when Cubbie sends you the secure page. Never paste it into the chat.</p>
        <dl className="kv"><dt>Dashboard API URL</dt><dd><code className="copy">{apiUrl}</code></dd><dt>Key name in Cubbie</dt><dd><code>CUBBIE_DASHBOARD_API_KEY</code></dd></dl>
        {key ? <Secret value={key} label="Sync key" /> : (
          <button className="primary" disabled={busy === "key"} onClick={() => run("key", async () => setKey((await api.createSyncKey()).key))}>Create sync key</button>
        )}
      </section>

      <section className="set-card">
        <header><h3>Discord</h3><span className={`pill ${status?.discord === "linked" ? "ok" : "warn"}`}><i />{status?.discord === "linked" ? `Linked${status.discordGuild ? ` to ${status.discordGuild}` : ""}` : "Not linked"}</span></header>
        <p>Add the Cubbie Board bot to your server, then run <code>/link</code> with a code from here. Reminders and the morning brief arrive as Discord DMs.</p>
        {code ? <p className="code-big">/link {code}<span>Expires in 10 minutes</span></p> : (
          <button className="ghost" disabled={busy === "code"} onClick={() => run("code", async () => setCode((await api.createDiscordLinkCode()).code))}>Get a link code</button>
        )}
        <label className="field"><span>Channels to show on the board (channel IDs, comma separated)</span>
          <input value={channels} onChange={e => setChannels(e.target.value)} placeholder="1234567890123456789, 2345678901234567890" />
        </label>
        <div className="row">
          <button className="ghost" disabled={busy === "ch"} onClick={() => run("ch", async () => {
            const ids = channels.split(/[\s,]+/).filter(Boolean);
            if (ids.some(id => !/^\d{5,25}$/.test(id))) throw new Error("Channel IDs are numbers. In Discord, turn on Developer Mode and use Copy Channel ID.");
            await api.setDiscordChannels(ids); setSaved(`Showing ${ids.length} channel${ids.length === 1 ? "" : "s"}`);
          })}>Save channels</button>
          {saved && <span className="fine">{saved}</span>}
        </div>
      </section>

      <section className="set-card">
        <header><h3>Weekly plan</h3><span className="pill">Times in {localZone}</span></header>
        <p>A short plan for the week, written from your board. It never invents deadlines or counts.</p>
        <button className="primary" disabled={busy === "sum"} onClick={() => run("sum", async () => setSummary((await api.weeklySummary()).text))}>{busy === "sum" ? "Writing…" : "Write my weekly plan"}</button>
        {summary && <p className="summary-out">{summary}</p>}
      </section>
    </div>
  );
}

function Secret({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="secret">
      <span className="fine">{label}, shown once. Copy it now.</span>
      <div className="row"><code className="copy">{value}</code>
        <button className="ghost" onClick={() => { void navigator.clipboard?.writeText(value).then(() => setCopied(true)); }}>{copied ? "Copied" : "Copy"}</button>
      </div>
    </div>
  );
}
