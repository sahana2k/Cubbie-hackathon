# Cubbie iMessage relay (macOS)

Apple has no public iMessage API, so the board talks to Cubbie through a small agent on a Mac that is signed in
to your Apple ID. It does two things and nothing else:

1. Watches `~/Library/Messages/chat.db` for new messages in the one-to-one chat with Cubbie's handle and sends
   them to the board over a WebSocket. Group chats and every other conversation are filtered out in the SQL query
   itself, so they never leave your Mac.
2. When you type to Cubbie on the board, sends that text from Messages.app with AppleScript.

## Set up (about 5 minutes)

1. On the board, open Settings > iMessage > Set up this Mac. Copy the WebSocket URL and the relay token (shown once).
2. On the Mac:
   ```bash
   cd agents/imessage-relay && npm install && npm run build
   node dist/index.js setup      # paste Cubbie's handle, the URL and the token
   node dist/index.js            # first run backfills the last 100 messages
   ```
3. Grant permissions when macOS asks: Full Disk Access for Terminal (or the node binary) so it can read Messages,
   and Automation > Messages so it can send.
4. Keep it running with the LaunchAgent: edit the two paths in `com.cubbie.relay.plist`, copy it to
   `~/Library/LaunchAgents/`, then `launchctl load ~/Library/LaunchAgents/com.cubbie.relay.plist`.

## Always-on option: EC2 Mac

If you don't want to depend on a personal laptop, run the same relay on an Amazon EC2 Mac instance
(`mac2.metal`, Apple silicon) with a dedicated Apple ID used only for Cubbie. EC2 Mac requires a Dedicated Host
with a 24-hour minimum allocation, so it fits a team or always-on demo better than one student. See
`docs/ARCHITECTURE.md` for the trade-offs.

## Privacy

- Reads are pinned to Cubbie's handle and to one-to-one chats (`chat.style = 45`).
- The token only lets this Mac post to your board; it can't read your board data. Revoke it any time by making a
  new one on the board.
- Config lives in `~/.cubbie-relay/` with `0600` permissions.
