# Architecture and tech stack

Cubbie Dashboard is serverless on AWS except for two small long-running pieces: the Discord gateway bot (ECS
Fargate) and the iMessage relay (a Mac, because Apple offers no iMessage API). Everything is defined in
`infra/lib/stack.ts` and deploys with `cdk deploy`.

```
                        ┌──────────────────────── AWS ────────────────────────────────────────┐
 Browser ──HTTPS──► CloudFront ──► S3 (React build + config.json)                              │
    │                                                                                          │
    ├──HTTPS + JWT──► API Gateway HTTP API ──► Lambda "http" ───┐                              │
    │                                                           ▼                              │
    └──WSS──────────► API Gateway WebSocket ──► Lambda ws ──► DynamoDB (one table, Streams) ───┤
                               ▲                                │                              │
 Mac relay ──WSS (token)───────┘                                ▼                              │
 (Messages.app)                                     Lambda "fanout" (stream consumer)          │
                                                     │  push to browser / relay over WSS        │
                                                     └─ EventBridge Scheduler: one reminder     │
 Cubbie Skill ──HTTPS (x-cubbie-key)──► Lambda "ingest" ──► DynamoDB          per deadline ──► Lambda "reminder" ──► Discord DM
 Discord ──interactions──► Lambda "discordInteractions"                                        │
 Discord gateway ◄──► ECS Fargate bot ──► DynamoDB                    Daily cron ──► Lambda "dailyBrief"
                        └──────────────────────────────────────────────────────────────────────┘
```

## Stack, layer by layer

| Layer | Choice | Why this one |
| --- | --- | --- |
| Frontend | React 18, TypeScript, Vite | Small, fast builds; the same code builds a shareable single-file demo |
| Hosting | S3 (private) + CloudFront with Origin Access Control | Global CDN, HTTPS, no public bucket, strict security headers and CSP |
| Auth | Amazon Cognito user pool, Hosted UI, OAuth code + PKCE; optional Google sign-in | Managed sign-up, email verification and tokens; the API checks JWTs itself |
| API | API Gateway HTTP API + one router Lambda | Cheapest API Gateway flavor, built-in JWT authorizer, throttling at the stage |
| Realtime | API Gateway WebSocket API | Pushes chat messages, card changes, Discord messages and relay status to the browser |
| Compute | Lambda, Node.js 20 on Graviton (arm64), bundled by esbuild | Pay per request, about 20% cheaper than x86, cold starts under a second |
| Database | DynamoDB on-demand, single table, Streams, TTL, point-in-time recovery | No servers or capacity planning; streams drive all realtime fan-out |
| Scheduling | EventBridge Scheduler | One self-deleting schedule per deadline, plus the daily brief cron with a time zone |
| Discord bot | ECS Fargate (0.25 vCPU, arm64) in public subnets, no NAT gateway | The Discord gateway needs a persistent socket; skipping NAT saves about $30/month |
| AI | Amazon Bedrock (Claude via the Converse API) | Weekly plan from board facts; model is a config value; billed to AWS credits |
| Secrets | AWS Secrets Manager | Discord bot token and keys; read at runtime, never in env vars or code |
| Observability | CloudWatch Logs (JSON, 30-day retention), X-Ray tracing, CloudWatch alarms to SNS email | Errors and stuck stream records page you |
| Cost control | AWS Budgets alerts at 80% and 100% | Credits run out quietly otherwise |
| Infrastructure | AWS CDK v2 (TypeScript) | Same language as the app; one command deploys everything |
| CI/CD | GitHub Actions with OIDC to an IAM role | No long-lived AWS keys in GitHub |

## How each integration works

### iMessage (the Cubbie thread)

Apple has no public iMessage API, so the relay in `agents/imessage-relay` runs on a Mac signed in to the
student's Apple ID.

1. It polls `~/Library/Messages/chat.db` (read-only) every 1.5 s for rows newer than its saved cursor. The SQL is
   pinned to one chat: `chat_identifier` equals Cubbie's handle and `style = 45` (one-to-one). Group chats and
   every other conversation are never read.
2. New rows go up the WebSocket as `imessage.upsert`. The `ws` Lambda writes them to DynamoDB; the stream fan-out
   pushes them to every open browser tab.
3. When the student types on the board, `POST /chat/messages` stores a message with status `sending`. The fan-out
   sees the insert and sends `imessage.send` to the relay, which sends it with AppleScript (text passed as argv,
   so it can't inject script). The relay reports back and the bubble flips to Delivered, then Read.
4. If no relay is online, the bubble shows "Not delivered" right away instead of hanging.

**Where to run the relay.** On the student's own Mac (free, private, sleeps when the lid closes) or on an EC2 Mac
instance (always on). EC2 Mac needs a Dedicated Host with a 24-hour minimum and costs hundreds of dollars a month,
so it suits a team demo or an always-on service more than one student. It is the only AWS-hosted option, since
Messages only runs on macOS.

### Cubbie (data into the board)

Cubbie Skills can't call Cubbie's abilities from scripts and can't use MCP servers, but they can make HTTPS
requests. So data flows one way, from Cubbie to the board:

1. The `cubbie-dashboard-sync` Skill gathers what Cubbie already verified (Canvas due dates, the Canvas Grader
   Brief workload, the Cubbridge ledger export) and writes one JSON batch.
2. `scripts/push.py` posts it to `POST /ingest/cubbie` with the student's personal key in `x-cubbie-key`. The key
   is created on the board (Settings) and saved in Cubbie as `CUBBIE_DASHBOARD_API_KEY` through Cubbie's secure page.
3. The `ingest` Lambda validates the whole batch with zod before writing anything, derives a stable card id from
   each `sourceId` so re-syncs update instead of duplicating, never moves coursework backwards (if you dragged a card
   to Partly done, a sync that says To do keeps Partly done), and skips writes that change nothing.

### Discord

- **Slash commands** (`/due`, `/grading`, `/apps`, `/link`) hit the `discordInteractions` Lambda through the HTTP
  API. Every request's Ed25519 signature is verified. Replies are ephemeral.
- **Linking**: Settings gives a one-time code (10-minute TTL); `/link CODE` ties the Discord user to the board user.
- **Reminders**: the fan-out keeps one EventBridge Scheduler schedule per open deadline (24 h before, or 2 h before
  when closer). It moves when the date changes and is deleted when the card is done or removed.
- **Morning brief**: a daily cron (7:30 am America/Phoenix by default) DMs each linked student.
- **Channel mirror**: the Fargate bot listens to the gateway and writes messages from the channels a student chose
  into DynamoDB; the fan-out shows them on the Discord tab. Posting from the board goes through the bot as
  "name (via Cubbie Board)".

## Data model (single DynamoDB table)

| PK | SK | Item |
| --- | --- | --- |
| `USER#{sub}` | `PROFILE` | timezone, Discord link, mirrored channels, last sync |
| `USER#{sub}` | `TASK#{id}` | a card (all three views share one shape; see `packages/shared/src/types.ts`) |
| `USER#{sub}` | `MSG#{at}#{id}` | a Cubbie iMessage, plus a `MSGID#{id}` pointer for status updates |
| `USER#{sub}` | `DC#{at}#{id}` | mirrored Discord message, 30-day TTL |
| `USER#{sub}` | `CONN#{connectionId}` | open WebSocket (web or relay), 1-day TTL |
| `CONN#{id}` | `META` | reverse lookup on disconnect |
| `DEVTOKEN#{sha256}` / `INGESTKEY#{sha256}` | `META` | hashed relay token / sync key to owner |
| `DISCORD#{userId}` | `LINK` | Discord user to board user |
| `CHANNEL#{channelId}` | `SUB#{sub}` | who mirrors a channel |
| `LINKCODE#{code}` | `META` | one-time link code, 10-minute TTL |

Every query is by partition key; there are no scans on the request path. The only scan is the once-a-day brief,
which reads `PROFILE` items. At larger scale, add a GSI on linked profiles.

## Security and privacy

- Students only ever read their own partition: the user id comes from the verified JWT, never from the request.
- Relay tokens and sync keys are 192-bit random secrets shown once; only SHA-256 hashes are stored. Making a new
  one revokes the old one.
- The relay reads only the Cubbie one-to-one chat. Its config file is `0600`.
- The board never changes grades or submits anything; grading counts are read-only and never include student names,
  scores or submission contents.
- CloudFront sends HSTS, `X-Frame-Options: DENY`, and a CSP that only allows the API, the WebSocket, Cognito and
  Google Fonts.
- DynamoDB and S3 are encrypted at rest; the DynamoDB table has deletion protection and PITR in `prod`.

## Rough monthly cost for a small group (tens of students)

| Item | Approx. |
| --- | --- |
| Fargate bot (0.25 vCPU arm64) + its public IPv4 address | about $10–13 |
| Lambda, API Gateway, DynamoDB, Scheduler, CloudFront, S3 | a few dollars; much of it within the free tier |
| Cognito | free at this size |
| Bedrock weekly plans | cents per plan, depending on the model |
| Secrets Manager | about $0.40 |
| EC2 Mac relay (optional) | hundreds of dollars; the one expensive piece |

Prices change; check the AWS pricing pages. The stack sets a Budgets alert (default $50) when `alarmEmail` is set.

## Known limits and next steps

- The relay skips attachment-only messages in v1; text and emoji work.
- Web push notifications (service worker) would let the board nudge without Discord.
- A WAF needs a CloudFront-scoped web ACL in us-east-1; add it via a small second stack if the board goes public.
- Multi-account deploys (dev/prod) work by passing `-c stage=dev`.
