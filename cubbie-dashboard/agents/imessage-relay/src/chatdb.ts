import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Read-only access to ~/Library/Messages/chat.db. Every query is pinned to the ONE chat whose
 * identifier is Cubbie's handle, so no other conversation ever leaves the Mac.
 * Requires Full Disk Access for the process running the relay (System Settings > Privacy & Security).
 */
const APPLE_EPOCH = 978307200; // 2001-01-01 in Unix seconds

export interface Row { rowid: number; guid: string; text: string; fromMe: boolean; at: string; delivered: boolean; read: boolean }

export class ChatDb {
  private db: Database.Database;
  private handles: string[];
  constructor(cubbieHandle: string, path = join(homedir(), "Library/Messages/chat.db")) {
    this.db = new Database(path, { readonly: true, fileMustExist: true });
    this.db.pragma("query_only = ON");
    // Messages stores phone numbers with +country code; also accept the bare form.
    const digits = cubbieHandle.replace(/[^\d+]/g, "");
    this.handles = [...new Set([cubbieHandle, digits, digits.startsWith("+") ? digits : `+1${digits}`])];
  }

  private readonly sql = `
    SELECT m.ROWID AS rowid, m.guid, m.text, m.attributedBody, m.is_from_me, m.date, m.is_delivered, m.is_read, m.date_read
    FROM message m
    JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
    JOIN chat c ON c.ROWID = cmj.chat_id
    WHERE c.chat_identifier IN (SELECT value FROM json_each(?))
      AND c.style = 45            -- 45 = one-to-one chat (43 = group); never read group chats
      AND m.ROWID > ?
      AND m.associated_message_type = 0   -- skip tapbacks
    ORDER BY m.ROWID ASC
    LIMIT ?`;

  since(rowid: number, limit = 200): Row[] {
    const rows = this.db.prepare(this.sql).all(JSON.stringify(this.handles), rowid, limit) as any[];
    return rows.map(r => this.toRow(r)).filter((r): r is Row => !!r);
  }

  /** Latest N rows, used on first run to backfill the thread. */
  latest(n = 100): Row[] {
    const max = this.db.prepare(`SELECT COALESCE(MAX(ROWID), 0) AS m FROM message`).get() as { m: number };
    const rows = this.since(Math.max(0, max.m - 50_000), 50_000);
    return rows.slice(-n);
  }

  /** Delivery/read state for my recent messages, so the board can show Delivered/Read. */
  recentOutgoingStatus(sinceRowId: number): Row[] {
    return this.since(sinceRowId, 500).filter(r => r.fromMe);
  }

  private toRow(r: any): Row | null {
    const text: string | null = r.text ?? decodeAttributedBody(r.attributedBody);
    if (!text) return null; // attachments-only messages are skipped in v1
    const ns = Number(r.date);
    const seconds = ns > 1e12 ? ns / 1e9 : ns; // macOS 10.13+ stores nanoseconds
    return {
      rowid: r.rowid, guid: r.guid, text: text.replace(/\uFFFC/g, "").trim(), fromMe: r.is_from_me === 1,
      at: new Date((seconds + APPLE_EPOCH) * 1000).toISOString(), delivered: r.is_delivered === 1, read: Number(r.date_read) > 0
    };
  }
}

/**
 * On recent macOS versions `text` is often NULL and the body lives in `attributedBody`
 * (an NSKeyedArchiver typedstream). The string follows the "NSString" class marker with a
 * length prefix: 1 byte, or 0x81 + uint16 LE, or 0x82 + uint32 LE.
 */
export function decodeAttributedBody(buf: Buffer | null): string | null {
  if (!buf) return null;
  const marker = buf.indexOf("NSString");
  if (marker < 0) return null;
  let p = marker + "NSString".length + 5;
  if (p >= buf.length) return null;
  let len = buf[p]; p += 1;
  if (len === 0x81) { len = buf.readUInt16LE(p); p += 2; }
  else if (len === 0x82) { len = buf.readUInt32LE(p); p += 4; }
  if (p + len > buf.length) return null;
  return buf.subarray(p, p + len).toString("utf8");
}
