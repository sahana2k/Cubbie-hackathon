# Tesseract in Cubbie Board

The Discord tab replaces the iMessage pane with a live Discord channel feed and the Canvas board with tasks grouped by project member. Other tabs retain the existing dashboard. It uses the bundled `services/tesseract` agent runtime, originally integrated from the local MergeMates project, with its SQLite records and approval rules. No sample tasks are inserted.

## Run locally

Requires Node 24+, Python 3.10+, and Corepack. From `cubbie-dashboard`:

```sh
corepack pnpm install
corepack pnpm build:tesseract
corepack pnpm live
```

Open http://127.0.0.1:8787 and select **Discord**. The existing AWS deployment is unchanged; the new Tesseract connection runs through the personal local server, not the AWS API.

1. Create a dedicated Discord bot in the [Developer Portal](https://discord.com/developers/applications). Enable Message Content and Server Members privileged intents.
2. Install it with `bot` and `applications.commands` scopes. Grant View Channels, Read Message History, Send Messages, Embed Links and Attach Files in your project channel. Create `#tesseract-log` and grant the bot access there too. Use a dedicated bot because startup registers the Tesseract slash commands in the selected server.
3. Enable Discord Developer Mode and copy your server ID. Enter it with the bot token in the dashboard.
4. Choose Anthropic, OpenAI, Gemini, Groq, OpenRouter, or an HTTPS OpenAI-compatible provider. Enter your API key and exact model ID. Connecting makes a small LLM tool-call request to verify the credentials and model. The model must support tool calling; PDF/image input support varies by provider.
5. Select your server and channel. Run `/setup` in Discord, have each teammate `/join`, and upload the rubric with `/rubric`.

Bots support server channels, not personal Discord group DMs. The feed refreshes every five seconds and shows the latest 50 messages, including card text and attachment links. Use **Message in Discord** or a message link to send as yourself, upload files, vote, claim work or approve a change. The dashboard intentionally has no endpoint that can impersonate a Discord member or approve on another member's behalf.

## Included agent workflows

- Planner: passive commitments, rubric extraction and task claim cards.
- Dependency Manager: blockers, cycle checks, hand-off warnings and completion notifications.
- Meeting Coordinator: private recurring availability, meeting polls, consent, calendar files and reminders.
- Accountability Manager: reminder preferences, overdue check-ins, rescue proposals, rubric readiness and explicit submission confirmation.
- Router, shared SQLite state, constraint checking, approval cards and agent trace delivery to `#tesseract-log`.

Use `/help` for the full command list. `/classes` manages private availability, `/settings` controls reminders, `/meet` proposes a meeting, `/rescue` proposes recovery, `/readiness` checks the rubric, and `/submitted` asks the designated submitter to confirm delivery. The dashboard shows pending approvals separately from confirmed work, plus dependencies, meetings and rubric requirements. Private class labels are never included in its snapshot.

## Credentials and lifecycle

The local API retains its loopback Host, session-cookie and Origin checks. Bot tokens and API keys are passed to a child process through its environment, never saved to browser storage, SQLite or connection configuration. Password fields are cleared after each connection attempt. Disconnect stops the bot and reminders. Closing the local server also stops it; keep the server running for scheduled reminders. Re-enter credentials after restart. Project records persist under the dashboard's private state folder in a database scoped to the server ID. When that database has no project for the selected server, the dashboard reuses an existing matching project in the sibling `mergemates/data/mergemates.db`. This keeps existing assignments live without copying or resetting them. For a different bot database location, set `TESSERACT_DATABASE_PATH` to its absolute path before starting the dashboard. Stop any separately running MergeMates bot before connecting the dashboard so only one bot worker processes events and reminders.

The internal Node bridge binds an ephemeral loopback port and requires a random bearer token known only to the local server. It exposes read-only, server-scoped snapshots and omits class schedules. The custom provider receives your API key and project context; enter only an endpoint you trust.

## Verify

```sh
corepack pnpm build:tesseract
corepack pnpm test:tesseract
corepack pnpm test:local
```

Live verification requires real Discord and LLM credentials: connect, create a project, join two members, make a self-commitment and a proposed assignment to another member, accept it from that member's Discord account, and check both board updates. Test a rubric upload, meeting vote, rescue proposal and submission confirmation in a test server before relying on the scheduled workflow. Automated tests cover core consent rules, dependency cycles, scheduling, reminders, provider tool translation and local API access checks; they do not make live provider calls.
