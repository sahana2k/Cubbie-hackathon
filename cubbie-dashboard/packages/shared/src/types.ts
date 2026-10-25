/**
 * Domain model shared by the web app, the Lambda API, the Discord bot and the iMessage relay.
 * Field meanings follow the canvas-grader-brief and Cubbridge Skill rules:
 *  - an unavailable count is null (shown as "Unavailable"), never 0
 *  - a student submission deadline is not a grading deadline
 *  - application_date is only set when evidenced; confirmation time is separate
 */

export type View = "student" | "grader" | "jobs";

export type TaskKind =
  | "assignment" | "quiz" | "exam" | "discussion" | "project" | "reading"
  | "grading"
  | "application" | "assessment" | "interview" | "follow_up"
  | "task";

export type Source = "canvas" | "gmail" | "cubbie" | "manual" | "discord" | "calendar";

export interface GradingInfo {
  section?: string | null;
  studentsSubmitted?: number | null;
  eligibleStudents?: number | null;
  needsGrading?: number | null;
  studentDueAt?: string | null;
  gradingDueAt?: string | null;
}

export interface JobInfo {
  company: string;
  role: string;
  location?: string | null;
  applicationDate?: string | null;
  applicationDateEvidence?: string | null;
  confirmationAt?: string | null;
  stage: "applied" | "assessment" | "interview" | "offer" | "rejected" | "withdrawn";
  nextAction?: string | null;
  followUpAt?: string | null;
  assessmentDeadline?: string | null;
  assessmentDeadlineText?: string | null;
  verifiedContacts?: number | null;
  calendarState?: "none" | "pending_approval" | "created" | "event_only" | "failed";
}

export interface Task {
  id: string;
  view: View;
  status: string;
  title: string;
  kind: TaskKind;
  course?: string | null;
  dueAt?: string | null;
  /** Shown when dueAt is null: "No due date" (explicitly unset) vs "Deadline unavailable" (not retrieved). */
  dueLabel?: string | null;
  progress?: number;
  points?: number | null;
  priority?: "low" | "medium" | "high";
  source: Source;
  sourceId?: string | null;
  url?: string | null;
  notes?: string | null;
  grading?: GradingInfo;
  job?: JobInfo;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  id: string;
  /** "in" = from Cubbie, "out" = from the student */
  direction: "in" | "out";
  text: string;
  at: string;
  status?: "sending" | "sent" | "delivered" | "read" | "failed";
  /** Apple message GUID when the message came through the relay */
  guid?: string | null;
  attachments?: { name: string; url?: string; mime?: string }[];
}

export interface DiscordMessage {
  id: string;
  channelId: string;
  channelName: string;
  author: string;
  bot?: boolean;
  text: string;
  at: string;
}

export interface IntegrationStatus {
  transport?: "local";
  canvas?: { connected: boolean; lastSync?: string | null; error?: string | null; coverageNotes?: string[] };
  imessageError?: string | null;
  imessageRelay: "online" | "offline" | "not_set_up";
  relayDevice?: string | null;
  discord: "linked" | "not_linked";
  discordGuild?: string | null;
  lastCubbieSync?: string | null;
  mode: "demo" | "live";
}

export type RealtimeEvent =
  | { type: "tasks.snapshot"; tasks: Task[] }
  | { type: "chat.snapshot"; messages: ChatMessage[] }
  | { type: "task.upsert"; task: Task }
  | { type: "task.delete"; id: string }
  | { type: "chat.upsert"; message: ChatMessage }
  | { type: "chat.typing"; typing: boolean }
  | { type: "discord.message"; message: DiscordMessage }
  | { type: "status"; status: IntegrationStatus };

/** Messages exchanged between the cloud and the macOS iMessage relay over the WebSocket API. */
export type RelayInbound =
  | { action: "relay.hello"; device: string; version: string }
  | { action: "imessage.upsert"; message: { guid: string; fromMe: boolean; text: string; at: string; status?: ChatMessage["status"] } }
  | { action: "imessage.sent"; clientId: string; guid?: string; ok: boolean; error?: string };

export type RelayOutbound =
  | { type: "imessage.send"; clientId: string; text: string }
  | { type: "relay.ping" };
