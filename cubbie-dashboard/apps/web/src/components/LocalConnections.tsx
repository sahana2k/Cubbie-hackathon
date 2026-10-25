import { useEffect, useState } from "react";
import type { IntegrationStatus } from "@cubbie/shared/types";
import type { LocalApi, LocalConnections as Connections, LocalCourse } from "../api/types";

export function LocalConnections({ local, status, onError }: {
  local: LocalApi; status: IntegrationStatus | null; onError: (message: string) => void;
}) {
  const [connection, setConnection] = useState<Connections | null>(null);
  const [url, setUrl] = useState("https://canvas.asu.edu");
  const [token, setToken] = useState("");
  const [handle, setHandle] = useState("");
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
  return <div className="settings">
    <section className="set-card">
      <header><h3>Canvas</h3><span className={`pill ${connection?.canvasConnected ? "ok" : "warn"}`}>
        <i />{connection?.canvasConnected ? "Connected" : "Not connected"}</span></header>
      <p>Import real assignments into Coursework and Grading. Your token stays in this server’s memory and must be entered again after a restart.</p>
      {connection?.canvasAccount && <p className="fine">Canvas account: {connection.canvasAccount}</p>}
      <form onSubmit={event => { event.preventDefault(); void run("canvas", async () => {
        try {
          const result = await local.connectCanvas(url, token);
          setConnection(result); setCourses(result.courses); setShowOther(result.includeOtherCourses ?? false);
          setNotice(`Canvas connected. Current courses for ${result.currentTermLabel ?? "this term"} are selected, including your TA/grader courses.`);
        } finally { setToken(""); }
      }); }}>
        <label className="field"><span>Canvas address</span><input type="url" value={url} required onChange={event => setUrl(event.target.value)} /></label>
        <label className="field"><span>Personal Canvas test token</span><input type="password" value={token} required autoComplete="off" onChange={event => setToken(event.target.value)} /></label>
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
    </section>
    <section className="set-card">
      <header><h3>Your Cubbie iMessage conversation</h3><span className={`pill ${status?.imessageRelay === "online" ? "ok" : "warn"}`}>
        <i />{status?.imessageRelay === "online" ? "Connected on this Mac" : "Not connected"}</span></header>
      <p>Read your existing one-to-one Cubbie thread from Messages on this Mac. Other chats and group conversations are excluded. Text and supported image cards refresh automatically.</p>
      <form onSubmit={event => { event.preventDefault(); void run("messages", async () => {
        setConnection(await local.connectMessages(handle)); setNotice("Cubbie conversation connected. The left pane will refresh shortly.");
      }); }}>
        <label className="field"><span>Cubbie’s exact iMessage phone number or email</span>
          <input value={handle} required autoComplete="off" placeholder="Cubbie’s number, including country code" onChange={event => setHandle(event.target.value)} /></label>
        <p className="fine">Use the number/email shown in the Cubbie conversation’s info panel, not your own number. Messages must already be signed in and synced on this Mac.</p>
        <div className="row"><button className="primary" disabled={busy !== null || !handle.trim()}>{busy === "messages" ? "Connecting…" : "Connect Cubbie thread"}</button>
          <button type="button" className="ghost" disabled={busy !== null || !connection?.handle} onClick={() => void run("disconnect", async () => {
            await local.disconnectMessages(); await load(); setNotice("Cubbie thread disconnected.");
          })}>Disconnect thread</button></div>
      </form>
      <p className="fine">If macOS blocks reading: System Settings → Privacy &amp; Security → Full Disk Access → enable your terminal, then restart this server. Sending a message from the composer may also require Automation → Messages permission. Connecting alone sends nothing.</p>
      {status?.imessageError && <p className="error" role="alert">{status.imessageError}</p>}
      <p className="fine">Job list: when Cubbie sends your applications workbook (cubboard-jobs-…xlsx) in this thread, Job hunt updates automatically. Rejected applications are left out.</p>
      {status?.jobs?.lastImport && <p className="fine">Last job import: {status.jobs.imported ?? 0} applications from {status.jobs.workbook ?? "Cubbie’s workbook"}, {new Date(status.jobs.lastImport).toLocaleString()}{status.jobs.skipped ? ` (${status.jobs.skipped} rejected or withdrawn skipped)` : ""}.</p>}
      {status?.jobs?.error && <p className="error" role="alert">{status.jobs.error}</p>}
    </section>
    {notice && <p className="local-notice" role="status">{notice}</p>}
  </div>;
}
