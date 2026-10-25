#!/usr/bin/env node
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import WebSocket from "ws";
import { ChatDb } from "./chatdb.js";
import { loadConfig, loadCursor, saveConfig, saveCursor } from "./config.js";
import { sendIMessage } from "./send.js";

const VERSION = "1.0.0";
const POLL_MS = 1500;

async function setup() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const cubbieHandle = (await rl.question("Cubbie's iMessage number or email (as shown in Messages): ")).trim();
  const wsUrl = (await rl.question("WebSocket URL (Settings > iMessage on the board): ")).trim();
  const token = (await rl.question("Relay token (shown once on the board): ")).trim();
  const deviceName = (await rl.question(`Name for this Mac [${hostname()}]: `)).trim() || hostname();
  rl.close();
  saveConfig({ cubbieHandle, wsUrl, token, deviceName });
  try { new ChatDb(cubbieHandle); console.log("Messages database is readable."); }
  catch { console.log("Can't read Messages yet. Give your terminal (or node) Full Disk Access in System Settings > Privacy & Security, then run again."); }
  console.log("Saved. Start the relay with: cubbie-relay   (or load the LaunchAgent, see README)");
}

function run() {
  const cfg = loadConfig();
  const db = new ChatDb(cfg.cubbieHandle);
  let cursor = loadCursor();
  let ws: WebSocket | null = null;
  let backoff = 1000;
  const pending: string[] = []; // frames queued while offline
  const recentOut: { rowid: number; delivered: boolean; read: boolean }[] = [];

  const send = (frame: unknown) => {
    const s = JSON.stringify(frame);
    if (ws?.readyState === WebSocket.OPEN) ws.send(s); else { pending.push(s); if (pending.length > 500) pending.shift(); }
  };

  const connect = () => {
    const url = `${cfg.wsUrl}?role=relay&device=${encodeURIComponent(cfg.token)}`;
    ws = new WebSocket(url);
    ws.on("open", () => {
      backoff = 1000;
      console.log("Connected to Cubbie Dashboard");
      send({ action: "relay.hello", device: cfg.deviceName, version: VERSION });
      while (pending.length && ws?.readyState === WebSocket.OPEN) ws.send(pending.shift()!);
      if (cursor === 0) { for (const r of db.latest(100)) push(r); }
    });
    ws.on("message", async raw => {
      let msg: any; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "imessage.send" && typeof msg.text === "string") {
        try { await sendIMessage(cfg.cubbieHandle, msg.text); send({ action: "imessage.sent", clientId: msg.clientId, ok: true }); }
        catch (err) { console.error("send failed", err); send({ action: "imessage.sent", clientId: msg.clientId, ok: false, error: String(err).slice(0, 200) }); }
      }
    });
    ws.on("close", code => {
      ws = null;
      if (code === 1008 || code === 4001) console.error("Token rejected. Make a new relay token on the board and run: cubbie-relay setup");
      setTimeout(connect, backoff); backoff = Math.min(60_000, backoff * 2);
    });
    ws.on("error", err => console.error("socket error:", err.message));
    // API Gateway closes idle sockets after 10 minutes; keep it alive.
    const keepalive = setInterval(() => { if (ws?.readyState === WebSocket.OPEN) ws.ping(); else clearInterval(keepalive); }, 5 * 60_000);
  };

  const push = (r: ReturnType<ChatDb["since"]>[number]) => {
    send({ action: "imessage.upsert", message: { guid: r.guid, fromMe: r.fromMe, text: r.text, at: r.at, status: r.fromMe ? (r.read ? "read" : r.delivered ? "delivered" : "sent") : undefined } });
    cursor = Math.max(cursor, r.rowid);
    if (r.fromMe) { recentOut.push({ rowid: r.rowid, delivered: r.delivered, read: r.read }); if (recentOut.length > 20) recentOut.shift(); }
  };

  const tick = () => {
    try {
      const rows = db.since(cursor);
      for (const r of rows) push(r);
      if (rows.length) saveCursor(cursor);
      // Pick up Delivered -> Read changes on my recent messages.
      if (recentOut.length) {
        for (const r of db.recentOutgoingStatus(recentOut[0].rowid - 1)) {
          const known = recentOut.find(x => x.rowid === r.rowid);
          if (known && (known.read !== r.read || known.delivered !== r.delivered)) { Object.assign(known, { read: r.read, delivered: r.delivered }); push(r); }
        }
      }
    } catch (err) { console.error("read failed (Full Disk Access?)", err); }
  };

  connect();
  setInterval(tick, POLL_MS);
  console.log(`Watching the Cubbie thread (${cfg.cubbieHandle}). Other chats are never read.`);
}

if (process.argv[2] === "setup") void setup(); else run();
