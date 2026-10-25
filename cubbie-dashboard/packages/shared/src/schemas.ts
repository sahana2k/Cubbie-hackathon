import { z } from "zod";

const iso = z.string().datetime({ offset: true });
const nullableIso = iso.nullable().optional();

export const GradingSchema = z.object({
  section: z.string().max(120).nullable().optional(),
  studentsSubmitted: z.number().int().min(0).nullable().optional(),
  eligibleStudents: z.number().int().min(0).nullable().optional(),
  needsGrading: z.number().int().min(0).nullable().optional(),
  studentDueAt: nullableIso,
  gradingDueAt: nullableIso
});

export const JobSchema = z.object({
  statusEvidence: z.string().max(1000).nullable().optional(),
  statusMessageId: z.string().max(300).nullable().optional(),
  statusAt: nullableIso,
  interviewAt: nullableIso,
  company: z.string().min(1).max(200),
  role: z.string().min(1).max(200),
  location: z.string().max(200).nullable().optional(),
  applicationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  applicationDateEvidence: z.string().max(1000).nullable().optional(),
  confirmationAt: nullableIso,
  stage: z.enum(["applied", "assessment", "interview", "offer", "rejected", "withdrawn"]),
  nextAction: z.string().max(500).nullable().optional(),
  followUpAt: nullableIso,
  assessmentDeadline: nullableIso,
  assessmentDeadlineText: z.string().max(500).nullable().optional(),
  verifiedContacts: z.number().int().min(0).nullable().optional(),
  calendarState: z.enum(["none", "pending_approval", "created", "event_only", "failed"]).optional()
}).refine(j => !j.applicationDate || !!j.applicationDateEvidence, {
  message: "applicationDate needs applicationDateEvidence"
});

export const TaskInputSchema = z.object({
  id: z.string().max(120).optional(),
  view: z.enum(["student", "grader", "jobs"]),
  status: z.string().min(1).max(40),
  title: z.string().min(1).max(300),
  kind: z.enum(["assignment", "quiz", "exam", "discussion", "project", "reading", "grading",
    "application", "assessment", "interview", "follow_up", "task"]),
  course: z.string().max(120).nullable().optional(),
  dueAt: nullableIso,
  dueLabel: z.string().max(60).nullable().optional(),
  published: z.boolean().optional(),
  progress: z.number().min(0).max(100).optional(),
  points: z.number().min(0).nullable().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  source: z.enum(["canvas", "gmail", "cubbie", "manual", "discord", "calendar"]).default("manual"),
  sourceId: z.string().max(300).nullable().optional(),
  url: z.string().url().startsWith("https://").max(2000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  grading: GradingSchema.optional(),
  job: JobSchema.optional()
});
export type TaskInput = z.infer<typeof TaskInputSchema>;

export const TaskPatchSchema = TaskInputSchema.partial().omit({ id: true });

export const SendChatSchema = z.object({ text: z.string().min(1).max(4000), clientId: z.string().max(64).optional() });
export const SendDiscordSchema = z.object({ text: z.string().min(1).max(2000), channelId: z.string().max(40).optional() });

/** Payload a Cubbie Skill posts to /ingest/cubbie. Batches are validated whole before anything is written. */
export const IngestSchema = z.object({
  skill: z.enum(["canvas-grader-brief", "cubbridge", "canvas-student", "cubbie-dashboard-sync"]),
  checkedAt: iso,
  timeZone: z.string().max(64),
  sourceLabel: z.enum(["live_canvas", "connected_gmail", "supplied_snapshot", "saved_ledger"]),
  tasks: z.array(TaskInputSchema.extend({ sourceId: z.string().min(1).max(300) })).max(2000),
  coverageNotes: z.array(z.string().max(500)).max(50).default([])
});
export type IngestPayload = z.infer<typeof IngestSchema>;
