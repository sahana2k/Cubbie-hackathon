# Cubbie board — local dashboard

Canvas, your one-to-one Cubbie iMessage conversation, and Tesseract run on your Mac. No AWS account, cloud deployment, Gmail connection, or sign-in is required.

```sh
pnpm install
pnpm live --port 8788
```

Open http://127.0.0.1:8788. Use the gear icon for Connected Accounts. Enter your Canvas access token, review current courses and import assignments. Press Sync on the iMessage card to discover the saved Cubbie conversation or a contact named Cubbie. If more than one match is found, choose one. The terminal running the server needs Full Disk Access; Contacts access may be requested for contact lookup. No messages are sent by Sync.

Click Join Discord to open the connection modal. Enter your existing Discord bot token, server ID, model/provider and API key. The connection uses the bundled Tesseract service from commit `f61f529ab76578ff2511f4ede3e8e1d9fb2ffd66`. `pnpm live` builds Tesseract and the frontend before starting the Python dashboard, including on a fresh checkout. If you start Python directly instead, the Connect action also prepares a missing service build automatically. No remote-service URL is required.

Credentials stay in dashboard-server memory and need re-entry after a restart. Closing the modal keeps the bot running; Delete connection disconnects the bot without deleting project history. Opening setup never sends a Discord message.


The coursework, grading, job hunt and project boards retain the repository's original design. The Connected Accounts page has Canvas and iMessage cards, with Tesseract as a separate invitation. There is no Gmail account connector.

Run `pnpm test` for frontend, local-server and Tesseract tests.
