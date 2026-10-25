import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DIR = join(homedir(), ".cubbie-relay");
const FILE = join(DIR, "config.json");
const STATE = join(DIR, "state.json");

export interface Config {
  /** Cubbie's iMessage handle exactly as it appears in Messages (phone number like +15551234567, or email). */
  cubbieHandle: string;
  /** wss://{api-id}.execute-api.{region}.amazonaws.com/prod */
  wsUrl: string;
  /** Relay token from the board: Settings > iMessage > Set up this Mac */
  token: string;
  deviceName: string;
}

export function loadConfig(): Config {
  const fromEnv = process.env.CUBBIE_HANDLE && process.env.CUBBIE_WS_URL && process.env.CUBBIE_RELAY_TOKEN;
  if (fromEnv) return { cubbieHandle: process.env.CUBBIE_HANDLE!, wsUrl: process.env.CUBBIE_WS_URL!, token: process.env.CUBBIE_RELAY_TOKEN!, deviceName: process.env.CUBBIE_DEVICE_NAME ?? "Mac" };
  if (!existsSync(FILE)) throw new Error("Not set up yet. Run: cubbie-relay setup");
  return JSON.parse(readFileSync(FILE, "utf8"));
}

export function saveConfig(c: Config) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
  chmodSync(FILE, 0o600);
}

export function loadCursor(): number {
  try { return JSON.parse(readFileSync(STATE, "utf8")).lastRowId ?? 0; } catch { return 0; }
}
export function saveCursor(lastRowId: number) {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(STATE, JSON.stringify({ lastRowId }), { mode: 0o600 });
}
