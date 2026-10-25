import type { DynamoDBStreamEvent } from "aws-lambda";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { ChatMessage, DiscordMessage, Task } from "@cubbie/shared";
import { syncReminder } from "../lib/scheduler";
import { pushToRelay, pushToWeb } from "../lib/ws";

/**
 * DynamoDB Streams fan-out. Every write (from the API, the relay, the ingest Skill or the Discord bot)
 * reaches the browser here, so all writers stay simple and the UI is always consistent.
 *  - TASK#   -> task.upsert / task.delete to the browser, and the reminder schedule is synced
 *  - MSG#    -> chat.upsert to the browser; a new outgoing "sending" message goes to the relay
 *  - DC#     -> discord.message to the browser
 */
export async function handler(event: DynamoDBStreamEvent) {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const img = record.dynamodb?.NewImage ? unmarshall(record.dynamodb.NewImage as never) : null;
      const old = record.dynamodb?.OldImage ? unmarshall(record.dynamodb.OldImage as never) : null;
      const item = (img ?? old) as Record<string, any> | null;
      if (!item || typeof item.PK !== "string" || !item.PK.startsWith("USER#")) continue;
      const sub = item.PK.slice(5);
      const sk: string = item.SK;
      const { PK, SK, ttl, entity, sub: _s, ...data } = item; void PK; void SK; void ttl; void entity; void _s;

      if (sk.startsWith("TASK#")) {
        if (record.eventName === "REMOVE") { await pushToWeb(sub, { type: "task.delete", id: sk.slice(5) }); await syncReminder(sub, null, sk.slice(5)); }
        else { await pushToWeb(sub, { type: "task.upsert", task: data as Task }); await syncReminder(sub, data as Task, sk.slice(5)); }
      } else if (sk.startsWith("MSG#") && img) {
        const msg = data as ChatMessage;
        await pushToWeb(sub, { type: "chat.upsert", message: msg });
        if (record.eventName === "INSERT" && msg.direction === "out" && msg.status === "sending") {
          const delivered = await pushToRelay(sub, { type: "imessage.send", clientId: msg.id, text: msg.text });
          if (!delivered) await pushToWeb(sub, { type: "chat.upsert", message: { ...msg, status: "failed" } });
        }
      } else if (sk.startsWith("DC#") && img) {
        await pushToWeb(sub, { type: "discord.message", message: data as DiscordMessage });
      }
    } catch (err) {
      console.error("fanout failed", err);
      if (record.dynamodb?.SequenceNumber) failures.push({ itemIdentifier: record.dynamodb.SequenceNumber });
    }
  }
  return { batchItemFailures: failures };
}
