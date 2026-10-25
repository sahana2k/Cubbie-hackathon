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
  syncMessages(selected?: string): Promise<LocalConnections & { candidates?: string[] }>;
  connections(): Promise<LocalConnections>;
  connectCanvas(url: string, token: string): Promise<LocalConnections>;
  syncCanvas(courses: Pick<LocalCourse, "id" | "view">[], includeOtherCourses?: boolean): Promise<{ imported: number; coverageNotes: string[] }>;
  disconnectCanvas(): Promise<void>;
  connectMessages(handle: string): Promise<LocalConnections>;
  disconnectMessages(): Promise<void>;
}

/** Local dashboard API. Credentials are handled by the server on this Mac. */
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
  weeklySummary(): Promise<{ text: string }>;
  reset?(): Promise<void>;
}
