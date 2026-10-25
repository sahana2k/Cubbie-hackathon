# Deploy to AWS

Total time: about 30 minutes the first time. You need Node 20+, pnpm 9, Docker running, the AWS CLI signed in to
the account with your credits, and (for iMessage) a Mac.

## 1. Configure

Edit `infra/cdk.json` context:

| Key | Set it to |
| --- | --- |
| `alarmEmail` | your email, for error alarms and budget alerts |
| `monthlyBudgetUsd` | budget alert threshold (default 50) |
| `allowedOrigins` | extra origins allowed to sign in, e.g. `http://localhost:5173` for local dev against AWS |
| `bedrockModelId` | a Claude model ID enabled in Bedrock in your region (Bedrock console > Model access), or leave empty to turn off weekly plans |
| `discordBotEnabled` | leave `false` for the first deploy; set `true` after step 4 |
| `googleClientId`, `googleClientSecretArn` | optional Google sign-in |
| `customDomain`, `certificateArn` | optional; the ACM certificate must be in us-east-1 for CloudFront |
| `briefCron`, `briefTimeZone` | when the Discord morning brief goes out |

## 2. Build and deploy

```bash
pnpm install
pnpm build                        # builds apps/web/dist, which CDK uploads
cd infra
npx cdk bootstrap                 # once per account/region
npx cdk deploy
```

Note the outputs: `WebUrl`, `ApiUrl`, `WebSocketUrl`, `DiscordInteractionsUrl`, `DiscordSecretArn`.
Open `WebUrl`, create an account, and you'll land on an empty board.

## 3. Connect iMessage

1. On the board: Settings > iMessage > Create relay token.
2. On your Mac: follow `agents/imessage-relay/README.md` (install, `setup`, grant Full Disk Access and Automation).
3. The top bar shows "iMessage live" and your Cubbie thread appears on the left.

## 4. Connect Discord

1. Create an application at https://discord.com/developers/applications. Under Bot, create a bot, copy its token,
   and turn on the Message Content intent.
2. Store the credentials:
   ```bash
   aws secretsmanager put-secret-value --secret-id <DiscordSecretArn> \
     --secret-string '{"botToken":"...","publicKey":"<General Information > Public Key>","applicationId":"..."}'
   ```
3. In the developer portal, set Interactions Endpoint URL to `DiscordInteractionsUrl`. Discord sends a signed ping;
   the Lambda answers it.
4. Register slash commands once: `DISCORD_SECRET_ARN=<arn> pnpm --filter @cubbie/discord-bot register`
5. Invite the bot to your server (OAuth2 > URL Generator: scopes `bot` and `applications.commands`; permissions
   Read Messages, Send Messages).
6. Set `"discordBotEnabled": true` in `cdk.json` and run `npx cdk deploy` again to start the Fargate bot.
7. On the board: Settings > Discord > Get a link code, then run `/link CODE` in Discord. Paste the channel IDs you
   want mirrored and save.

## 5. Connect Cubbie

1. Push `skills/cubbie-dashboard-sync` to a public GitHub repo (or include it in your Skills repo).
2. Text Cubbie the link to install it.
3. On the board: Settings > Cubbie sync > Create sync key. When Cubbie sends the secure page for
   `CUBBIE_DASHBOARD_API_KEY`, paste the key there. Tell Cubbie your dashboard API URL (`ApiUrl`).
4. Text Cubbie "sync my dashboard". Cards appear within a second.
5. Optional: "every morning at 7, sync my dashboard" for a recurring sync.

## 6. CI/CD (GitHub Actions)

`.github/workflows/ci.yml` typechecks, tests and builds on every pull request.
`.github/workflows/deploy.yml` deploys `main` using OIDC. One-time setup:

1. IAM > Identity providers > add `token.actions.githubusercontent.com` (audience `sts.amazonaws.com`).
2. Create a role trusted by that provider for your repo (`repo:<owner>/<repo>:ref:refs/heads/main`) with permission
   to assume the CDK bootstrap roles (`cdk-*`).
3. Add repo secrets `AWS_DEPLOY_ROLE_ARN` and `AWS_REGION`.

## Local development against AWS

Add `http://localhost:5173` to `allowedOrigins`, redeploy, then create `apps/web/.env.local` from `.env.example`
with the stack outputs and run `pnpm dev`. Leave `VITE_API_URL` empty to go back to demo mode.

## Tear down

`npx cdk destroy`. In `prod` the DynamoDB table and the user pool are retained on purpose; delete them in the
console if you really want them gone.
