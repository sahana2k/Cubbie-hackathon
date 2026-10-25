# Cubbie board — local dashboard

Canvas, your one-to-one Cubbie iMessage conversation, and Tesseract run on your Mac. No AWS account, cloud deployment, Gmail connection, or sign-in is required.

```sh
pnpm install
pnpm --filter @cubbie/web build
python3 services/local/server.py --port 8788
```

Open http://127.0.0.1:8788. Use the gear icon for Connected Accounts. Enter your Canvas access token, review current courses and import assignments. Press Sync on the iMessage card to discover the saved Cubbie conversation or a contact named Cubbie. If more than one match is found, choose one. The terminal running the server needs Full Disk Access; Contacts access may be requested for contact lookup. No messages are sent by Sync.

Click Join Discord to open the remote-service connection modal. Enter the URL and bridge connection key of your already running Tesseract service. Bot credentials and the AI model stay on that server; no local bot build or new Discord application is required. The bridge key stays in local server memory. Closing the modal keeps the connection; Delete connection disconnects the dashboard without stopping the remote bot or deleting project history.

The service must expose the Tesseract read API (`/servers`, `/channels`, `/snapshot`, `/messages`). Use HTTPS, or an SSH tunnel such as `ssh -L 8791:127.0.0.1:REMOTE_BRIDGE_PORT user@HOST`, then connect to `http://127.0.0.1:8791`. A Discord invite, server ID, and bot token are not the service URL or its bridge key.

The coursework, grading, job hunt and project boards retain the repository's original design. The Connected Accounts page has Canvas and iMessage cards, with Tesseract as a separate invitation. There is no Gmail account connector.

Run `pnpm test` for frontend, local-server and Tesseract tests.
