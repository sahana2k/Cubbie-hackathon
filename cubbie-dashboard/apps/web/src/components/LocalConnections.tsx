import { useEffect, useState } from "react";
import canvasLogo from "../assets/canvas-logo.jpeg";
import type { IntegrationStatus } from "@cubbie/shared/types";
import type { LocalApi, LocalConnections as Connections, LocalCourse } from "../api/types";

export function LocalConnections({ local, status, onError }: {
  local: LocalApi; status: IntegrationStatus | null; onError: (message: string) => void;
}) {
  const [connection, setConnection] = useState<Connections | null>(null);
  const [url, setUrl] = useState("https://canvas.asu.edu");
  const [token, setToken] = useState("");
  const [handle, setHandle] = useState("");
  const [candidates, setCandidates] = useState<string[]>([]);
  const [courses, setCourses] = useState<LocalCourse[]>([]);
  const [showOther, setShowOther] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const load = async () => {
    const value = await local.connections();
    setConnection(value); setUrl(value.canvasUrl); setHandle(value.handle); setCourses(value.courses);
    setShowOther(value.includeOtherCourses ?? false);
  };
  useEffect(() => { void load().catch(error => onError((error as Error).message)); }, [local]);
  const run = async (action: string, fn: () => Promise<void>) => {
    setBusy(action); setNotice("");
    try { await fn(); } catch (error) { onError((error as Error).message); } finally { setBusy(null); }
  };
  return <div className="settings connected-accounts">
    <details className="set-card canvas-account">
      <summary className="canvas-account-summary"><div className="account-title"><img className="account-logo" src={canvasLogo} alt="" /><h3>Canvas</h3></div><span className="account-caret" aria-hidden="true">⌄</span></summary>
      {connection?.canvasAccount && <div className="canvas-account-identity"><span aria-hidden="true">✓</span>{connection.canvasAccount}</div>}
      <div className="canvas-expanded">
      <p>Import real assignments into Coursework and Grading. Your access token stays on this Mac.</p>
      {connection?.canvasAccount && <p className="fine">Canvas account: {connection.canvasAccount}</p>}
      <form onSubmit={event => { event.preventDefault(); void run("canvas", async () => {
        try {
          const result = await local.connectCanvas(url, token);
          setConnection(result); setCourses(result.courses); setShowOther(result.includeOtherCourses ?? false);
          const selected = result.courses.filter(course => course.view !== 'skip' && course.activity === 'current').map(({ id, view }) => ({ id, view }));
          if (selected.length) {
            const imported = await local.syncCanvas(selected, false); await load();
            setNotice(`Canvas verified. Imported ${imported.imported} assignments from your current courses.${imported.coverageNotes.length ? ' Some courses could not be read.' : ''}`);
          } else setNotice('Canvas verified. No current courses were selected; review the available courses below.');
        } finally { setToken(""); }
      }); }}>
        <details className="canvas-origin"><summary>Canvas address</summary><label className="field"><span>Canvas address</span><input type="url" value={url} required onChange={event => setUrl(event.target.value)} /></label></details>
        <label className="field"><span>Enter Access Token</span><input type="password" placeholder="Enter Access Token" value={token} required autoComplete="off" onChange={event => setToken(event.target.value)} /></label>
        <p className="fine">Create a short-lived personal test token in Canvas → Account → Settings → Approved Integrations, if your school permits it. Never send it in a chat.</p>
        <button className="primary" disabled={busy !== null || !token.trim()}>{busy === "canvas" ? "Connecting…" : "Connect Canvas"}</button>
      </form>
      {courses.length > 0 && <>
        <p><strong>{connection?.currentTermLabel ?? "Current term"}</strong> · Current student and TA/grader courses</p>
        <label className="toggle"><input type="checkbox" checked={showOther} onChange={event => {
          const checked = event.target.checked; setShowOther(checked);
          if (!checked) setCourses(values => values.map(course => course.activity !== "current" ? { ...course, view: "skip" } : course));
        }} /> Show other courses ({courses.filter(course => course.activity !== "current").length})</label>
        <div className="local-courses">
          {courses.filter(course => showOther || course.activity === "current").map(course => <label className="local-course" key={course.id}>
            <span>{course.name}<small>{course.roles.join(", ") || "Choose your role"}{course.termName ? ` · ${course.termName}` : ""}</small>
              {course.activityReason && <small>{course.activityReason}</small>}</span>
            <select aria-label={`Role for ${course.name}`} value={course.view} onChange={event => setCourses(values => values.map(value =>
              value.id === course.id ? { ...value, view: event.target.value as LocalCourse["view"] } : value))}>
              <option value="skip">Skip</option><option value="student">Student</option>{(course.enrollmentView === "grader" || course.roles.some(role => ["ta", "teacher", "taenrollment", "teacherenrollment"].includes(role))) && <option value="grader">TA / grader</option>}
            </select>
          </label>)}
        </div>
        {!courses.some(course => course.activity === "current") && <p className="fine">No current courses could be established. Use Show other courses to review the available dates and labels.</p>}
        <p className="fine">Current courses use Canvas dates where available, otherwise the semester and year in the term name. Older, future, and undated courses are skipped by default. Import reads Canvas; editing a card here does not change Canvas.</p>
        <div className="row">
          <button className="primary" disabled={busy !== null || !connection?.canvasConnected || !courses.some(course => course.view !== "skip")}
            onClick={() => void run("sync", async () => {
              const result = await local.syncCanvas(courses.filter(course => course.view !== "skip" && (showOther || course.activity === "current")).map(({ id, view }) => ({ id, view })), showOther);
              await load(); setNotice(`Imported ${result.imported} assignments.${result.coverageNotes.length ? " Some courses could not be read; see below." : ""}`);
            })}>{busy === "sync" ? "Importing assignments…" : "Import selected courses"}</button>
          <button className="ghost" disabled={busy !== null || !connection?.canvasConnected} onClick={() => void run("disconnect", async () => {
            await local.disconnectCanvas(); await load(); setNotice("Canvas disconnected. Existing board records remain as a snapshot.");
          })}>Disconnect Canvas</button>
        </div>
      </>}
      {connection?.lastSync && <p className="fine">Last imported: {new Date(connection.lastSync).toLocaleString()}</p>}
      {(status?.canvas?.coverageNotes ?? connection?.coverageNotes)?.map(note => <p className="fine" key={note}>{note}</p>)}
      {status?.canvas?.error && <p className="error">{status.canvas.error}</p>}
      </div>
    </details>
    <section className="reach-cubbie" aria-labelledby="reach-cubbie-title">
      <div className="message-sync-row"><span id="reach-cubbie-title">iMessage</span>{handle && <small>{handle}</small>}
        <button className="phone-sync" aria-label="Sync Cubbie number" disabled={busy !== null} onClick={() => void run('messages', async () => {
          const value = await local.syncMessages(); setConnection(value); setHandle(value.handle); setCandidates(value.candidates || []);
          setNotice(value.candidates?.length ? 'Choose your Cubbie conversation below.' : 'Cubbie conversation synced.');
        })}>{busy === 'messages' ? 'Syncing…' : '↻ Sync'}</button>
      </div>
      {candidates.map(candidate => <button className="ghost" key={candidate} onClick={() => void run('messages', async () => { const value = await local.syncMessages(candidate); setConnection(value); setHandle(value.handle); setCandidates([]); setNotice('Cubbie conversation linked.'); })}>{candidate}</button>)}
      {status?.imessageError && <p className="error" role="alert">{status.imessageError}</p>}
    </section>
    {notice && <p className="local-notice" role="status">{notice}</p>}
  </div>;
}
