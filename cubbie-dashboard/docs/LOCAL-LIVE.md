# Connect your own Canvas and Cubbie iMessage thread on this Mac

This private local mode serves the existing dashboard and its real-data API on loopback. It needs Python 3.10+ and the existing frontend build. It does not require AWS, a relay token, or an external message bridge. It never loads demo data or generates simulated Cubbie replies.

```bash
cd /Users/mahi/Downloads/Cubbie-Hackathon/cubbie-dashboard
corepack pnpm install --filter @cubbie/web... --frozen-lockfile --ignore-scripts
corepack pnpm --filter @cubbie/web build
python3 services/local/server.py
```

Open http://127.0.0.1:8787/ and select **Settings**. Keep this terminal running. To stop, press Control-C. Do not expose this local server through a public tunnel: it is a personal same-Mac connection, not a hosted multi-user service. The original AWS deployment remains available separately.

## Canvas

1. Sign in to https://canvas.asu.edu in your own browser. In Account → Settings → Approved Integrations, create a short-lived personal development token if permitted by ASU. If the option is absent, ask ASU Canvas support about allowed API access. This personal test mode is not a distributed OAuth integration.
2. Enter the token only in the local dashboard's password field. It is passed to the loopback Python process and kept in memory, never saved to disk or browser storage, never exposed through the API, and never sent in a chat. After a server restart, reconnect. Revoke the token in Canvas when finished testing.
3. Click **Connect Canvas**, confirm the shown account, and choose **Student**, **TA / grader**, or **Skip** for each returned course. Unknown roles default to Skip; selecting a role does not grant permissions.
4. Click **Import selected courses**. Classes and Grading fill with real assignment records. Import is read-only toward Canvas. Student due dates stay separate from grading deadlines. Actual submitted-student totals stay null unless verified; grade buckets are not treated as submissions. Failed courses are listed and existing records are preserved. No bulk course file downloads are needed, so the Cubbie oversized-file sync failure is not part of this path.

This imports the assignment pages returned by Canvas, not every external LMS tool or every course file. Use the import button to refresh; chat polls automatically, Canvas does not silently sync in the background. Board edits and deletes affect only the local snapshot and can be overwritten/restored by a later Canvas import. Disconnecting clears the in-memory token but retains the imported snapshot. Connecting a different Canvas account removes the previous account's imported Canvas tasks.

## iMessage

1. Messages on this Mac must already show your Cubbie conversation. Signing in on a phone alone does not establish a local Messages database.
2. In Settings, enter **Cubbie's** exact phone number (with country code) or iMessage email, found in the conversation's info panel. Do not enter your own number.
3. Click **Connect Cubbie thread**. The reader queries only that one-to-one thread and displays its latest 200 messages. Group chats and all other handles are excluded in SQL. Supported PNG/JPEG/GIF/WebP attachments under Messages' attachment directory are shown only if joined to that selected conversation. The local preview limit is 20 MB per image. Unavailable cloud-only attachments cannot be displayed. Some macOS encoded text may remain unsupported rather than being guessed.
4. If reading is denied, open System Settings → Privacy & Security → Full Disk Access and enable the terminal used to run this server; quit/reopen that terminal and restart the server. Reading is read-only.
5. Use the dashboard's Send action only when you intend to send a real message to the configured conversation. macOS may request Automation → Messages permission. The server does not send anything on connect/import/startup. A send confirmation is not a delivery/read receipt. If sending times out, check Messages before retrying.

Message bodies are read from the local Messages database on refresh, not copied into the dashboard's task store. Its handle, selected course settings, and task snapshots live under `~/.config/cubboard-dashboard/`, with private file permissions. These are actual personal records; keep them out of a public repository. Canvas tokens remain memory-only. Requests require a same-origin local session cookie and the server refuses non-loopback Host headers.

## Verify

```bash
python3 -m unittest discover -s services/local -p 'test_*.py'
corepack pnpm --filter @cubbie/web build
```

Local tests use fictional SQLite fixtures and stubbed Canvas results. They do not access your real account, your real message database, or send any messages. Live connection testing requires you to enter your Canvas token locally, choose the Cubbie handle, and grant macOS permissions. Discord, remote Cubbie sandbox ingestion, and cloud notifications still require the AWS deployment; the local Settings screen does not pretend they are connected.
