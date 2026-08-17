# Messaging layer — channel-agnostic surfaces onto the engine

One shared layer that turns a chat message on any channel (Teams, Slack, …) into
an engine question and posts the answer back. The core and the ProjectDO never
know which channel they're serving — they only call a `ChannelAdapter`. Adding a
channel is one new adapter under `channels/`.

## Routing — project-scoped, in the URL (no KV, no global DO)

Ingress is one route on the hub Worker (`superatom-code-engine`):

```
POST /api/messaging/<projectId>/<channel>/<hook>
        ├ projectId → the ProjectDO (proj:<projectId>) = the WS hub for that project
        └ channel   → the adapter (teams | slack | …); <hook> is the channel's callback path
```

Because the projectId is in the URL, routing is stateless — the Worker reads it
straight from the path, no `tenant → project` lookup. (A future *shared* bot would
need that lookup; it slots in as a KV fallback, but per-project bots don't need it.)

## Who does what

```
Microsoft/Slack ──POST──▶ Worker ingress            ──▶ ProjectDO (owns the turn)  ◀─WS─▶ code-engine
                          • adapter.verifyInbound        • stores ConversationRef in state
                          • adapter.parseInbound         • relays `analyse` to the engine
                          • hand to ProjectDO            • on the WS answer EVENT (not a timer):
                          • return 200 fast                adapter.renderAnswer → adapter.sendReply
```

- **Worker** = stateless ingress only (verify + route + ack). It holds no socket.
- **ProjectDO** = the turn: the engine reply arrives as a WebSocket *event* at the
  DO, so the DO is where the reply is sent — proactively, via the channel's reply
  API, using the stored conversation reference. Event-driven; an alarm is only a
  stall-timeout, never the delivery path.

## Layout

```
core/channel.ts          the ChannelAdapter contract + shared types (InboundMessage, ConversationRef, ChannelSecrets)
channels/teams/adapter.ts Teams: BF-JWT verify · parse Activity · Adaptive Card · reply via BF REST API
channels/slack/adapter.ts Slack: placeholder implementing the same contract
index.ts                 the channel registry (name → adapter) + core re-exports
```

Adapters are pure `fetch` + Web Crypto — no Node-only SDKs — so they run in a
Worker / Durable Object.

## Open items (need an Azure bot to test)

- Teams `verifyInbound` presently only checks the bearer header is present; full
  Bot Framework JWT signature/issuer/audience validation is a TODO before prod.
- Per-project channel credentials (bot appId/secret) live in the ProjectDO state,
  set at onboarding — the admin action to set them is still to build.
- The ProjectDO virtual-connection relay (store ref → inject analyse → deliver the
  answer to the adapter) is the integration seam being wired.
