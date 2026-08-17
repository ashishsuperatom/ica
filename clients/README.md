# Client surfaces

Alternative front-ends onto the **same** Superatom engine. The web app
(`cloudflare/user-ui`) is the first surface; these are the others.

Every surface is a thin client — it owns only presentation and input. It never
talks to the code-engine directly. It connects to the hub as a **`runtime`**
peer over WebSocket and speaks the exact same envelope protocol the web UI uses:

```
1. open   wss://<hub>/_ws/<projectId>?token=<jwt>
2. hello  { type: "hello", token, role: "runtime" }
3. ask    { to: { type: "code-engine" }, payload: { t: "analyse", question, projectId, role, sessionId, questionId } }
4. recv   envelopes; the answer arrives as payload { t: "analyst:answer", category, answer, timing, sid, qid }
          (also: machine:waking, analyst:status, analyst:chunk, tick, error)
```

So a new surface = (a) that surface's SDK for receiving user input + rendering,
plus (b) the shared engine-client that does the handshake above. Keep (b)
identical across surfaces; only (a) differs.

## Surfaces

| Folder    | What                                   | Status              |
|-----------|----------------------------------------|---------------------|
| `teams/`  | Microsoft Teams bot                    | scaffolded          |
| `slack/`  | Slack app (bot / slash command)        | placeholder         |
| `android/`| Android native app                     | placeholder         |
| `ios/`    | iOS native app                         | placeholder         |

The `cloudflare/user-ui` web app stays where it is — this folder is only for the
additional surfaces.
