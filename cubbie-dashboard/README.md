# Cubbie Dashboard

A Jira-style board for college life that sits next to your Cubbie iMessage thread. Cubbie already tracks your
coursework, your TA grading and your job applications in iMessage; this puts all of it on one screen you can drag
around, with the Cubbie chat on the left and Discord one tab away.

- **Three views**: Classes (student), Grading (TA / grader / IA), Job hunt (applications, assessments, follow-ups)
- **Board, Upcoming, Next 7 days, Discord, Settings** tabs on the right
- **Live iMessage thread with Cubbie** on the left, through a small relay on your Mac
- **Discord**: mirrored channels, `/due` `/grading` `/apps` slash commands, reminders and a morning brief by DM
- **Runs on AWS**, serverless, deployed with one CDK command

Data comes in through the `cubbie-dashboard-sync` Cubbie Skill, which packages what Cubbie's
`canvas-grader-brief` and Cubbridge workflows already verified and posts it to your board. The board follows the
same rules: an unavailable count shows "Unavailable", never 0; a student deadline is never labeled as a grading
deadline; an application date only appears with evidence.

## Try it in 30 seconds (demo mode, no AWS)

For your **real Canvas account and Cubbie iMessage thread on this Mac**, use the [private local connection setup](docs/LOCAL-LIVE.md). Build the frontend and run `python3 services/local/server.py`, then open http://127.0.0.1:8787/ → Settings. No real accounts are connected until you configure them locally.

```bash
pnpm install
pnpm dev            # http://localhost:5173
```

With no API configured, the app runs on fictional seed data and answers chat messages from the board
("what's due this week", "what needs grading", "my applications", "add lab report due friday").
Changes persist in your browser. Click **Demo data** in the top bar to reset.

## Repository map

| Path | What it is |
| --- | --- |
| `apps/web` | React 18 + TypeScript + Vite single-page app (the board and the chat) |
| `packages/shared` | Domain types, view/column definitions and zod schemas shared by every package |
| `services/api` | Lambda handlers: HTTP API, WebSocket, DynamoDB stream fan-out, ingest, reminders, Discord interactions |
| `services/discord-bot` | Discord gateway bot (ECS Fargate) that mirrors chosen channels; slash-command registration |
| `agents/imessage-relay` | macOS agent that syncs only the Cubbie chat and sends messages from Messages.app |
| `skills/cubbie-dashboard-sync` | Cubbie Skill that pushes verified data to the board |
| `infra` | AWS CDK app (TypeScript) for the whole stack |
| `docs/ARCHITECTURE.md` | Tech stack, data flows, data model, security, costs |
| `docs/DEPLOY.md` | Step-by-step deployment and setup |

## Scripts

```bash
pnpm dev              # web app in demo mode
pnpm typecheck        # all packages
pnpm test             # unit tests
pnpm build            # build everything
pnpm build:preview    # one self-contained index.html of the demo, for sharing
pnpm deploy           # cdk deploy (see docs/DEPLOY.md first)
```

## Requirements

Node 20+, pnpm 9, an AWS account (the stack fits comfortably in AWS credits), Docker for building the Discord bot
image during deploy, and a Mac signed in to Messages for the iMessage relay.

## License

Apache-2.0, matching the Cubbie hackathon kit.

## Discord group projects with Tesseract

The Discord tab now has a server conversation pane and a task board grouped by teammate, backed by the bundled Tesseract agents. Run `corepack pnpm build:tesseract` followed by `corepack pnpm live`, then connect your Discord bot and preferred LLM in the Discord tab. See [Tesseract setup and verification](docs/tesseract.md) for bot permissions, provider keys, and supported workflows.
