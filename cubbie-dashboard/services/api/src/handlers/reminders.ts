import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import * as db from "../lib/db";
import { sendDM } from "../lib/discord";
import { env } from "../lib/env";
import { appsList, dueList, gradingList, isOpen, reminderText } from "../lib/text";

/** Target of the one-time EventBridge Scheduler schedules created in lib/scheduler.ts. */
export async function reminder(input: { sub: string; taskId: string }) {
  const [task, profile] = await Promise.all([db.getTask(input.sub, input.taskId), db.getProfile(input.sub)]);
  if (!task || !isOpen(task) || !profile.discordUserId) return { skipped: true };
  await sendDM(profile.discordUserId, reminderText(task, profile.timezone));
  return { sent: true };
}

/** Daily cron (EventBridge Scheduler, 7:30 am America/Phoenix by default): morning brief to linked students. */
export async function dailyBrief() {
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  let sent = 0;
  do {
    const page = await db.doc.send(new ScanCommand({
      TableName: env.table, FilterExpression: "SK = :p AND attribute_exists(discordUserId)",
      ExpressionAttributeValues: { ":p": "PROFILE" }, ExclusiveStartKey
    }));
    for (const p of page.Items ?? []) {
      const sub = String(p.PK).slice(5);
      const tasks = await db.listTasks(sub);
      const tz = p.timezone as string | undefined;
      const parts = [`Morning brief`, `Classes:\n${dueList(tasks, tz, 4)}`];
      if (tasks.some(t => t.view === "grader" && isOpen(t))) parts.push(`Grading:\n${gradingList(tasks, tz, 3)}`);
      if (tasks.some(t => t.view === "jobs" && isOpen(t))) parts.push(`Jobs:\n${appsList(tasks, tz, 3)}`);
      try { await sendDM(p.discordUserId as string, parts.join("\n\n")); sent++; } catch (e) { console.error("brief failed", sub, e); }
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return { sent };
}
