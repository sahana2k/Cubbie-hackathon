import { execFile } from "node:child_process";

/**
 * Sends through Messages.app with AppleScript. Text and handle are passed as argv, never interpolated
 * into the script, so message content cannot inject AppleScript. First run asks for Automation permission.
 */
const SCRIPT = [
  "on run argv",
  "  set msg to item 1 of argv",
  "  set target to item 2 of argv",
  '  tell application "Messages"',
  "    set svc to 1st account whose service type = iMessage",
  "    send msg to participant target of svc",
  "  end tell",
  "end run"
];

export function sendIMessage(handle: string, text: string): Promise<void> {
  const args = SCRIPT.flatMap(line => ["-e", line]).concat([text, handle]);
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", args, { timeout: 20_000 }, (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
  });
}
