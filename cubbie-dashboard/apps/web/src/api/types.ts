import type { ChatMessage, DiscordMessage, IntegrationStatus, RealtimeEvent, Task } from "@cubbie/shared/types";

export type TaskDraft = Partial<Task> & Pick<Task, "view" | "status" | "title" | "kind">;

export interface LocalCourse {
  id: number; name: string; roles: string[]; view: "student" | "grader" | "skip";
  enrollmentView?: "student" | "grader" | "skip";
  activity?: "current" | "past" | "future" | "unknown"; activityReason?: string; termName?: string;
}
export interface LocalConnections {
  canvasConnected: boolean; canvasUrl: string; canvasAccount?: string; courses: LocalCourse[];
  handle: string; lastSync?: string; coverageNotes?: string[]; canvasError?: string; imessageError?: string;
  currentTermLabel?: string; includeOtherCourses?: boolean;
}
export interface LocalApi {
  connections(): Promise<LocalConnections>;
  connectCanvas(url: string, token: string): Promise<LocalConnections>;
  syncCanvas(courses: Pick<LocalCourse, "id" | "view">[], includeOtherCourses?: boolean): Promise<{ imported: number; coverageNotes: string[] }>;
  disconnectCanvas(): Promise<void>;
  connectMessages(handle: string): Promise<LocalConnections>;
  disconnectMessages(): Promise<void>;
  syncJobs(): Promise<{ imported: number; active: number; skipped: number; workbook: string }>;
}

/** Everything the UI needs. The demo adapter and the live AWS adapter both implement it. */
export interface Api {
  local?: LocalApi;
  mode: "demo" | "live";
  listTasks(): Promise<Task[]>;
  createTask(draft: TaskDraft): Promise<Task>;
  updateTask(id: string, patch: Partial<Task>): Promise<Task>;
  deleteTask(id: string): Promise<void>;
  listMessages(): Promise<ChatMessage[]>;
  sendMessage(text: string): Promise<ChatMessage>;
  listDiscord(): Promise<DiscordMessage[]>;
  sendDiscord(text: string, channelId: string): Promise<DiscordMessage>;
  status(): Promise<IntegrationStatus>;
  subscribe(fn: (e: RealtimeEvent) => void): () => void;
  /** Settings: secrets are returned once and never shown again. */
  createRelayToken(name: string): Promise<{ token: string }>;
  createSyncKey(): Promise<{ key: string; envName: string }>;
  createDiscordLinkCode(): Promise<{ code: string; expiresInSeconds: number }>;
  setDiscordChannels(channelIds: string[]): Promise<{ channelIds: string[] }>;
  weeklySummary(): Promise<{ text: string }>;
  endpoints(): { apiUrl: string; wsUrl: string };
  reset?(): Promise<void>;
}
