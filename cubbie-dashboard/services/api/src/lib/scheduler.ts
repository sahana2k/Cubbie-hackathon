import { createHash } from "node:crypto";
import { CreateScheduleCommand, DeleteScheduleCommand, ResourceNotFoundException, UpdateScheduleCommand } from "@aws-sdk/client-scheduler";
import { SchedulerClient } from "@aws-sdk/client-scheduler";
import type { Task } from "@cubbie/shared";
import { VIEWS } from "@cubbie/shared";
import { env } from "./env";

const client = new SchedulerClient({});
const nameFor = (sub: string, taskId: string) => `t-${createHash("sha1").update(`${sub}:${taskId}`).digest("hex").slice(0, 40)}`;

/** When to nudge: 24 h before the deadline, or 2 h before when the deadline is closer than that. */
export function reminderTime(t: Task, now = Date.now()): Date | null {
  const due = t.dueAt ?? t.job?.followUpAt ?? t.job?.assessmentDeadline ?? null;
  if (!due || VIEWS[t.view].doneStatuses.includes(t.status)) return null;
  const d = Date.parse(due);
  for (const lead of [24 * 3600_000, 2 * 3600_000]) if (d - lead > now + 60_000) return new Date(d - lead);
  return null;
}

/** Idempotently create, move or delete the one-time EventBridge Scheduler schedule for a task. */
export async function syncReminder(sub: string, task: Task | null, taskId: string) {
  const Name = nameFor(sub, taskId);
  const at = task ? reminderTime(task) : null;
  if (!at) {
    try { await client.send(new DeleteScheduleCommand({ Name, GroupName: env.scheduleGroup })); }
    catch (e) { if (!(e instanceof ResourceNotFoundException)) throw e; }
    return;
  }
  const input = {
    Name, GroupName: env.scheduleGroup,
    ScheduleExpression: `at(${at.toISOString().slice(0, 19)})`, ScheduleExpressionTimezone: "UTC",
    FlexibleTimeWindow: { Mode: "OFF" as const }, ActionAfterCompletion: "DELETE" as const,
    Target: { Arn: env.reminderTargetArn, RoleArn: env.schedulerRoleArn, Input: JSON.stringify({ sub, taskId }) }
  };
  try { await client.send(new UpdateScheduleCommand(input)); }
  catch (e) { if (e instanceof ResourceNotFoundException) await client.send(new CreateScheduleCommand(input)); else throw e; }
}
