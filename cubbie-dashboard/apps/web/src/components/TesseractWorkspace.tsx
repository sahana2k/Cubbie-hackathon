import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { activeProjectTasks } from '../lib/projectTasks';
import { createPortal } from 'react-dom';
import { config } from '../config';
import { SetupDialog } from './SetupDialog';
import { TesseractInvite } from './TesseractInvite';
import { DiscordText } from './DiscordText';
import type { Names } from '../lib/discordMarkdown';

type ConnectionSettings = { guildId?: string; provider?: string; model?: string; baseUrl?: string; connected?: boolean; hasCredentials?: boolean };
function savedChannel(guild: string) { try { return localStorage.getItem(`tesseract.channel.${guild}`) || ''; } catch { return ''; } }
type Named = { id: string; name: string };
type ProjectTask = { id: number; title: string; description: string | null; owner_id: string | null; status: string; due_at: number | null };
type Snapshot = {
  project: { id: number; name: string; final_deadline: number | null; submitted_at: number | null } | null;
  members: Named[]; tasks: ProjectTask[];
  dependencies: { blocking_task_id: number; dependent_task_id: number; state: string }[];
  decisions: { id: number; summary: string; conflicts: string[]; required_approvers: string[]; approvals: string[]; message_id: string | null }[];
  meetings: { id: number; title: string; status: string; confirmed_start: number | null }[];
  requirements: { id: number; title: string; points: number | null }[];
};
type FeedEmbed = { title: string | null; description: string | null; color: string | null; url: string | null; fields: { name: string; value: string; inline: boolean }[]; footer: string | null };
type FeedMessage = { id: string; author: string; bot: boolean; at: number; text: string; embeds: FeedEmbed[]; attachments: { name: string; url: string }[]; url: string };
type Feed = { messages: FeedMessage[]; names: Names };
// Discord shows consecutive messages from one author within a few minutes as a single group.
const continues = (prev: FeedMessage | undefined, m: FeedMessage) => !!prev && prev.author === m.author && m.at - prev.at < 7 * 60_000;
async function request<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(`${config().apiUrl || '/api'}/tesseract${path}`, {
    method: data === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || 'Tesseract is unavailable.');
  return result as T;
}
const date = (value: number) => new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const labels: Record<string, string> = { proposed: 'Awaiting approval', confirmed: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done', overdue: 'Overdue', declined: 'Declined' };

export function TesseractWorkspace({ query, setupOnly = false }: { query: string; setupOnly?: boolean }) {
  const refreshRef = useRef<(() => Promise<void>) | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const [syncError, setSyncError] = useState('');
  const [revision, setRevision] = useState(0);
  const [servers, setServers] = useState<Named[]>([]);
  const [channels, setChannels] = useState<Named[]>([]);
  const [guild, setGuild] = useState('');
  const [channel, setChannel] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [feed, setFeed] = useState<Feed | null>(null);
  const [feedError, setFeedError] = useState('');
  const feedRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [settings, setSettings] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [provider, setProvider] = useState('anthropic');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [botToken, setBotToken] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [guildInput, setGuildInput] = useState('');
  const [savedSettings, setSavedSettings] = useState<ConnectionSettings>({});
  const [hasCredentials, setHasCredentials] = useState(false);
  const applySettings = (value: ConnectionSettings) => {
    setGuildInput(value.guildId || ''); setProvider(value.provider || 'anthropic');
    setModel(value.model || ''); setBaseUrl(value.baseUrl || ''); setApiKey(''); setBotToken('');
  };
  const openSettings = () => { applySettings(savedSettings); setSettings(true); setSetupOpen(true); };
  const selectChannel = (id: string) => {
    setChannel(id);
    try { localStorage.setItem(`tesseract.channel.${guild}`, id); } catch { /* storage optional */ }
  };
  const portal = document.getElementById('tesseract-chat');
  const connected = servers.length > 0;
  const discordUrl = guild && channel ? `https://discord.com/channels/${guild}/${channel}` : 'https://discord.com/app';

  useEffect(() => {
    let active = true;
    request<ConnectionSettings>('/settings').then(async saved => {
      if (!active) return;
      setSavedSettings(saved); applySettings(saved); setHasCredentials(!!saved.hasCredentials);
      if (!saved.connected) { setSettings(true); return; }
      const result = await request<{ servers: Named[] }>('/servers');
      if (!active) return;
      setServers(result.servers);
      setGuild(result.servers.find(s => s.id === saved.guildId)?.id || result.servers[0]?.id || '');
      setSettings(false); setError('');
    }).catch(e => { if (active) { setError(e.message); setSettings(true); } }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [revision]);
  useEffect(() => {
    setChannels([]); setChannel(''); setSnapshot(null);
    if (!guild) return;
    let active = true;
    request<{ channels: Named[] }>(`/channels?guild=${encodeURIComponent(guild)}`).then(result => {
      if (!active) return;
      setChannels(result.channels); setChannel(result.channels.find(c => c.id === savedChannel(guild))?.id || result.channels[0]?.id || '');
    }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, [guild, revision]);
  useEffect(() => {
    setSnapshot(null); setSyncedAt(null); setSyncError(''); setRefreshing(false);
    setFeed(null); setFeedError(''); stickRef.current = true;
    if (!guild || !channel) return;
    let active = true;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (!active || inFlight) return;
      clearTimeout(timer);
      inFlight = true;
      setRefreshing(true);
      try {
        const scope = `?guild=${encodeURIComponent(guild)}&channel=${encodeURIComponent(channel)}`;
        // A chat failure (e.g. missing Read Message History) must not block the board.
        const [result, chat] = await Promise.all([
          request<Snapshot>(`/snapshot${scope}`),
          request<Feed>(`/messages${scope}`).catch((e: Error) => e)
        ]);
        if (active) {
          // One snapshot updates owners, tasks, approvals and dependencies together.
          setSnapshot(result); setError(''); setSyncError(''); setSyncedAt(Date.now());
          if (chat instanceof Error) setFeedError(chat.message);
          else { setFeed(chat); setFeedError(''); }
        }
      } catch (e) {
        if (active) { setError((e as Error).message); setSyncError((e as Error).message); }
      } finally {
        inFlight = false;
        if (active) { setRefreshing(false); timer = setTimeout(poll, 5000); }
      }
    }
    refreshRef.current = poll;
    void poll();
    return () => { active = false; clearTimeout(timer); refreshRef.current = null; };
  }, [guild, channel]);
  useEffect(() => {
    // Follow new messages unless the user has scrolled up to read history.
    const el = feedRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [feed]);
  async function connect() {
    setBusy(true); setError('');
    try {
      const result = await request<{ servers: Named[] }>('/connect', { provider, model, baseUrl, botToken, apiKey, guildId: guildInput });
      const saved: ConnectionSettings = { guildId: guildInput, provider, model, baseUrl, connected: true, hasCredentials: true };
      setSavedSettings(saved); setHasCredentials(true);
      setServers(result.servers);
      setGuild(result.servers[0]?.id || ''); setRevision(r => r + 1); setSettings(false); setSetupOpen(false);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); setApiKey(''); setBotToken(''); }
  }
  async function disconnect() {
    setBusy(true);
    try { await request('/disconnect', {}); setServers([]); setGuild(''); setSnapshot(null); setHasCredentials(false); setSettings(true); return true; }
    catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); }
  }
  const members = [...(snapshot?.members || [])];
  for (const task of snapshot?.tasks || []) if (task.owner_id && !members.some(m => m.id === task.owner_id)) members.push({ id: task.owner_id, name: task.owner_id });
  const columns = [...members, { id: '', name: 'Unassigned' }];
  const filtered = activeProjectTasks(snapshot?.tasks || []).filter(t => `${t.title} ${t.description || ''} ${members.find(m => m.id === t.owner_id)?.name || ''}`.toLowerCase().includes(query.toLowerCase()));

  return <>
    {portal && !setupOnly && createPortal(<>
      <header className="ts-chat-head"><div className="dc-av">T</div><div><strong>Tesseract</strong><small>{connected ? 'Your Discord project teammate' : 'Connect your project group'}</small></div><div className="ts-chat-actions"><button className="ghost" type="button" disabled={refreshing || !guild || !channel} onClick={() => void refreshRef.current?.()} aria-label="Refresh task board" title="Refresh task board">{refreshing ? 'Syncing…' : '↻ Refresh'}</button><button type="button" className="ghost" onClick={() => settings ? setSettings(false) : openSettings()} aria-label="Discord connection settings">⚙</button></div></header>
      {connected && <p className="ts-sync-status" role="status">{syncError ? `Sync failed: ${syncError}` : refreshing ? 'Syncing task board…' : syncedAt ? `Board synced at ${new Date(syncedAt).toLocaleTimeString()}` : 'Waiting to sync…'}</p>}
      {connected && <div className="ts-selectors"><label className="field">Server<select aria-label="Discord server" value={guild} onChange={e => setGuild(e.target.value)}>{servers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label><label className="field">Channel<select aria-label="Discord channel" value={channel} onChange={e => selectChannel(e.target.value)}>{channels.map(c => <option key={c.id} value={c.id}># {c.name}</option>)}</select></label></div>}
      {connected ? <>
        <div className="ts-messages" ref={feedRef} aria-live="polite" aria-label="Latest Discord messages"
          onScroll={e => { const el = e.currentTarget; stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60; }}>
          {feedError ? <p className="ts-chat-empty">Couldn’t load messages: {feedError}</p>
            : !feed ? <p className="ts-chat-empty">Loading messages…</p>
            : !feed.messages.length ? <p className="ts-chat-empty">No messages in this channel yet.</p>
            : feed.messages.map((m, i) => { const grouped = continues(feed.messages[i - 1], m); return <article key={m.id} className={`ts-message${grouped ? ' ts-grouped' : ''}`}>
              {grouped ? <time className="ts-gutter-time" title={new Date(m.at).toLocaleString()}>{new Date(m.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time> : <div className="dc-av" data-bot={m.bot ? '1' : undefined}>{m.author[0]?.toUpperCase() || '?'}</div>}
              <div className="ts-message-body">
                {!grouped && <p className="dc-meta"><strong>{m.author}</strong>{m.bot && <span className="app-badge">APP</span>}<time title={new Date(m.at).toLocaleString()}>{date(m.at)}</time></p>}
                {m.text && <DiscordText text={m.text} names={feed.names} />}
                {m.embeds.map((e, j) => <div key={j} className="dm-embed" style={e.color ? { '--embed': e.color } as CSSProperties : undefined}>
                  {e.title && (e.url ? <a className="dm-embed-title" href={e.url} target="_blank" rel="noreferrer"><DiscordText text={e.title} names={feed.names} /></a> : <DiscordText className="dm dm-embed-title" text={e.title} names={feed.names} />)}
                  {e.description && <DiscordText text={e.description} names={feed.names} />}
                  {e.fields.length > 0 && <div className="dm-fields">{e.fields.map((f, k) => <div key={k} className={f.inline ? 'dm-field inline' : 'dm-field'}><DiscordText className="dm dm-field-name" text={f.name} names={feed.names} /><DiscordText text={f.value} names={feed.names} /></div>)}</div>}
                  {e.footer && <p className="dm-sub">{e.footer}</p>}
                </div>)}
                {m.attachments.map(a => <a key={a.url} className="ts-attachment" href={a.url} target="_blank" rel="noreferrer">📎 {a.name}</a>)}
                <a className="ts-jump" href={m.url} target="_blank" rel="noreferrer" aria-label={`Open message from ${m.author} in Discord`} title="Open in Discord">↗</a>
              </div>
            </article>; })}
        </div>
        <div className="ts-chat-foot"><p className="fine">Read-only view. Reply, upload and approve in Discord.</p><a className="primary" href={discordUrl} target="_blank" rel="noreferrer">Message in Discord ↗</a></div>
      </> : null}
    </>, portal)}
    {error && !setupOpen && connected && <p className="error" role="alert">{error}</p>}
    {loading && <p>Loading Discord connection…</p>}
    {(!loading || setupOnly) && (!connected || setupOnly) && <TesseractInvite onJoin={openSettings} />}
    {setupOpen && <SetupDialog onClose={() => { setSetupOpen(false); if (connected) setSettings(false); }} onDelete={connected && config().localApi ? () => { if (window.confirm('Disconnect Tesseract? Your project data will be kept.')) void disconnect().then(ok => { if (ok) setSetupOpen(false); }); } : undefined}>
    {error && <p className="error" role="alert">{error}</p>}
    {!loading && settings && config().localApi && <form className="set-card ts-connect" onSubmit={e => { e.preventDefault(); void connect(); }}>
      <header><h3>{connected ? 'Discord connection' : 'Connect your project'}</h3>{connected && <button type="button" className="ghost" onClick={() => setSettings(false)}>Back to board</button>}</header>
      <p>Connect your existing Discord bot and choose the model that runs Tesseract.</p>
      <div className="field-grid"><label className="field">Server ID<input required value={guildInput} onChange={e => setGuildInput(e.target.value)} inputMode="numeric" placeholder="Your Discord server ID" /></label><label className="field">Discord bot token<input required={!hasCredentials} type="password" autoComplete="off" value={botToken} onChange={e => setBotToken(e.target.value)} placeholder={hasCredentials ? "Saved — leave blank to keep" : "Bot token, not your personal token"} /></label></div>
      <div className="field-grid"><label className="field">LLM provider<select value={provider} onChange={e => setProvider(e.target.value)}><option value="anthropic">Anthropic / Claude</option><option value="openai">OpenAI</option><option value="gemini">Google Gemini</option><option value="groq">Groq</option><option value="openrouter">OpenRouter</option><option value="custom">Other compatible provider</option></select></label><label className="field">Model ID<input required value={model} onChange={e => setModel(e.target.value)} placeholder="Exact model ID from your provider" /></label></div>
      {provider === 'custom' && <label className="field">API base URL<input required type="url" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://your-provider.example/v1" /></label>}
      <label className="field">Provider API key<input required={!hasCredentials} type="password" autoComplete="off" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={hasCredentials ? "Saved — leave blank to keep" : "Your provider’s API key"} /></label>
      <p className="fine">Opening settings does not change the connection. Server ID, provider and model are saved locally. Leave secret fields blank to keep their current values. Secrets stay in server memory and need re-entry only after the server stops. Use a model with tool calling; PDF/image support depends on your provider. Discord bots connect to server channels, not personal group DMs.</p>
      <div className="row"><button className="primary" disabled={busy || !config().localApi}>{busy ? 'Saving…' : connected ? 'Save changes' : 'Connect Discord + LLM'}</button>{connected && <button className="ghost" type="button" disabled={busy} onClick={() => void disconnect()}>Disconnect</button>}</div>

    </form>}
    </SetupDialog>}
    {connected && !setupOnly && <>
      <div className="ts-toolbar"><div><strong>{snapshot?.project?.name || 'Your project board'}</strong><span className="fine"> {snapshot?.project?.submitted_at ? '· Submission confirmed' : snapshot?.project?.final_deadline ? `· Due ${date(snapshot.project.final_deadline)}` : '· Tasks grouped by teammate'}</span></div><button className="ghost" onClick={openSettings}>Connection settings</button></div>
      {snapshot && !snapshot.project && <div className="local-notice">Run <strong>/setup</strong> in this Discord channel, then ask everyone to <strong>/join</strong>. Upload the assignment with <strong>/rubric</strong> to create your claim board.</div>}
      {!snapshot && <p role="status">Loading project tasks…</p>}
      {snapshot && <div className="ts-board" style={{ '--cols': Math.max(columns.length, 1) } as CSSProperties}>
        {columns.map((person, i) => { const tasks = filtered.filter(t => (t.owner_id || '') === person.id); return <section key={person.id} className={`ts-column ts-tone-${i % 4}`} aria-label={`${person.name} tasks`}><header><div className="ts-person">{person.name[0]?.toUpperCase() || '?'}</div><div><h3>{person.name} <span>{tasks.length}</span></h3><p>{tasks.filter(t => !['done', 'declined', 'proposed'].includes(t.status)).length} active</p></div></header><div className="ts-cards">{tasks.map(t => { const blockers = snapshot?.dependencies.filter(d => d.dependent_task_id === t.id && d.state === 'active') || []; return <article key={t.id} className="ts-card"><span className={`ts-status ts-status-${t.status}`}>{labels[t.status] || t.status}</span><h4>{t.title}</h4>{t.description && <p>{t.description}</p>}{blockers.length > 0 && <p className="ts-blocked">Waiting on {blockers.map(d => snapshot?.tasks.find(x => x.id === d.blocking_task_id)?.title || `task #${d.blocking_task_id}`).join(', ')}</p>}<footer>{t.due_at ? <time className={t.status !== 'done' && t.due_at < Date.now() ? 'ts-late' : ''}>{date(t.due_at)}</time> : <span>No deadline</span>}<a href={discordUrl} target="_blank" rel="noreferrer">#{t.id} ↗</a></footer></article>; })}{!tasks.length && <p className="ts-no-tasks">{query ? 'No matching tasks' : person.id ? 'No active tasks' : 'Unclaimed rubric tasks appear here'}</p>}</div></section>; })}
      </div>}
      {!!snapshot?.decisions.length && <section className="ts-details"><h3>Waiting for approval</h3>{snapshot.decisions.map(d => <article key={d.id}><strong>{d.summary}</strong><p>{d.approvals.length} of {d.required_approvers.length} approvals · {d.required_approvers.filter(id => !d.approvals.includes(id)).map(id => members.find(m => m.id === id)?.name || id).join(', ')}</p>{d.conflicts.map((c, i) => <p key={i} className="ts-blocked">{c}</p>)}<a href={d.message_id ? `${discordUrl}/${d.message_id}` : discordUrl} target="_blank" rel="noreferrer">Review in Discord ↗</a></article>)}</section>}
      {!!snapshot?.meetings.length && <details className="ts-details"><summary>Meetings · {snapshot.meetings.length}</summary>{snapshot.meetings.map(m => <p key={m.id}>{m.title} · {m.status}{m.confirmed_start ? ` · ${date(m.confirmed_start)}` : ''}</p>)}</details>}
      {!!snapshot?.requirements.length && <details className="ts-details"><summary>Rubric · {snapshot.requirements.length} requirements</summary>{snapshot.requirements.map(r => <p key={r.id}>{r.title}{r.points != null ? ` · ${r.points} pts` : ''}</p>)}</details>}
      <p className="fine ts-hint">Use /meet for scheduling, /classes for private availability, /rescue for help, and /submitted to confirm submission. Agent activity appears in #tesseract-log.</p>
    </>}
  </>;
}
