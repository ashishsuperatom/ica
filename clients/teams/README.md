# Microsoft Teams surface

A Teams **bot**: you @-mention it (or DM it) a question, it asks the Superatom
engine, and replies with the answer (prose + figures + a table as an Adaptive
Card). This is the quickest Teams experiment — a bot maps 1:1 onto the product's
question→answer model, and each Teams conversation becomes an engine session.

> A Teams **tab** (embedding `cloudflare/user-ui` inside Teams) is the other
> option and reuses the whole web UI — noted here as the alternative, not built.

## How it fits

The bot backend is a thin client. On each message it connects to the hub as a
`runtime` peer and speaks the shared envelope protocol (see `../README.md`):
`hello` → `analyse` → await `analyst:answer`. All the intelligence stays in the
engine; this process only bridges Teams ↔ hub.

```
Teams  ──Activity──▶  bot (/api/messages)  ──WS runtime──▶  hub ◀──▶ code-engine
       ◀─reply(card)──                     ◀──analyst:answer──
```

## Layout

```
appPackage/manifest.json   Teams app manifest (sideload this + icons as a .zip)
src/index.ts               restify server exposing POST /api/messages
src/bot.ts                 TeamsActivityHandler: message → engine → reply
src/engine-client.ts       the shared runtime handshake (hello → analyse → answer)
src/answer-card.ts         Answer → Adaptive Card / text
src/config.ts              env
```

## Run (local)

1. `cp .env.example .env` and fill in the values (see that file).
2. From this folder: `pnpm install`
3. `pnpm dev` — starts the bot on `PORT` (default 3978).
4. Expose `/api/messages` publicly (e.g. `dev tunnel` / ngrok) and point the Azure
   Bot resource's messaging endpoint at `https://<tunnel>/api/messages`.
5. Zip `appPackage/` (manifest + two icons — see `appPackage/README.md`) and
   sideload it in Teams (Apps → Manage your apps → Upload a custom app).

## Open items (scaffold TODOs)

- **Auth token.** The runtime handshake needs a project JWT (`SA_ENGINE_TOKEN`).
  The web app gets it via Clerk; a bot has no interactive login, so we need a
  service-token path for bots. Stubbed via env for now.
- **Long runs.** The analyst can take minutes; a bot turn shouldn't block that
  long. Scaffold sends typing indicators and awaits with a timeout. The real fix
  is proactive messaging: store the conversation reference, reply when the answer
  lands. Marked in `bot.ts`.
