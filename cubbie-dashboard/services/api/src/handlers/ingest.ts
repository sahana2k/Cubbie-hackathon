import { createHash } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { IngestSchema, type Task } from "@cubbie/shared";
import { sha256 } from "../lib/auth";
import * as db from "../lib/db";
import { HttpError, json, parseBody, toResponse } from "../lib/http";

/**
 * POST /ingest/cubbie, called by the cubbie-dashboard-sync Skill from the student's Cubbie sandbox.
 * Auth: x-cubbie-key header (the student's CUBBIE_DASHBOARD_API_KEY). The batch is validated whole
 * before anything is written, and tasks are keyed by sourceId so re-syncs update instead of duplicating.
 * Status the student set on the board is kept: a sync never moves a card backwards.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const key = event.headers["x-cubbie-key"];
    if (!key || key.length > 200) throw new HttpError(401, "Missing x-cubbie-key");
    const owner = await db.getItem<{ sub: string }>(`INGESTKEY#${sha256(key)}`, "META");
    if (!owner) throw new HttpError(401, "Unknown key. Create a new one in Settings and save it in Cubbie.");
    if ((event.body?.length ?? 0) > 5_000_000) throw new HttpError(413, "Batch too large (5 MB max)");

    const payload = parseBody(event, IngestSchema);
    const sub = owner.sub;
    const existing = new Map((await db.listTasks(sub)).map(t => [t.id, t]));
    const now = new Date().toISOString();

    const tasks: Task[] = payload.tasks.map(input => {
      const id = "src_" + createHash("sha1").update(input.sourceId).digest("hex").slice(0, 20);
      const prev = existing.get(id);
      const merged = { ...input, id, createdAt: prev?.createdAt ?? now, updatedAt: now } as Task;
      if (prev) {
        merged.status = keepStudentStatus(prev, merged);
        merged.progress = Math.max(prev.progress ?? 0, merged.progress ?? 0);
        merged.notes = prev.notes ?? merged.notes;
      }
      return merged;
    });

    // Skip writes that change nothing so the stream does not fan out no-op events.
    const changed = tasks.filter(t => {
      const prev = existing.get(t.id);
      if (!prev) return true;
      const { updatedAt: _a, ...a } = prev; const { updatedAt: _b, ...b } = t; void _a; void _b;
      return JSON.stringify(a) !== JSON.stringify(b);
    });
    await db.putTasksBatch(sub, changed);
    await db.patchProfile(sub, { lastCubbieSync: payload.checkedAt, timezone: payload.timeZone });

    return json(200, { received: tasks.length, written: changed.length, unchanged: tasks.length - changed.length, coverageNotes: payload.coverageNotes });
  } catch (err) {
    return toResponse(err);
  }
}

const ORDER: Record<string, string[]> = {
  student: ["todo", "in_progress", "partial", "done"],
  grader: ["todo", "in_progress", "partial", "done"],
  jobs: ["applied", "assessment", "interview", "offer", "closed"]
};
/** Jobs follow the hiring stage from mail; coursework keeps whichever status is further along. */
function keepStudentStatus(prev: Task, next: Task) {
  if (next.view === "jobs") return next.status;
  const order = ORDER[next.view];
  return order.indexOf(prev.status) > order.indexOf(next.status) ? prev.status : next.status;
}
