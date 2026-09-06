# agent-proxy — experiment results

**Goal.** Stop logging into every engine separately. Engines run on EC2, Fly, the NetSuite box and wherever
else; each one authenticates itself, each login expires on its own schedule, and an expired token on a remote
box reads as a broken agent rather than an expired login. One credential holder, N engines, was the idea.

**Status: experiment. Nothing is wired into the engine.** `proxy.mjs` is a standalone Node server (built-ins
only, no install) that runs both proxy modes on one port so the modes could be compared.

## Run it

```
node agent-proxy/proxy.mjs                      # :8080, upstream https://api.anthropic.com
curl localhost:8080/__proxy/health

PROXY_PORT=8080 PROXY_UPSTREAM=https://api.anthropic.com \
PROXY_ANTHROPIC_API_KEY=…  PROXY_ANTHROPIC_AUTH='Bearer …' \
PROXY_VERBOSE=1 node agent-proxy/proxy.mjs
```

Credentials are never logged. A credential-carrying header is reported as a scheme plus a sha256 prefix and a
length — enough to tell "the agent sent its own" from "we injected ours", and to notice a token changing,
without a secret reaching a log file.

## The two modes are not interchangeable

| | how the agent is pointed at it | what the proxy can see |
| --- | --- | --- |
| **Forward** | `HTTPS_PROXY=http://host:8080` | For an `https://` upstream: the hostname and byte counts. **No headers** — the client does TLS with the real server through a CONNECT tunnel. Reading them would mean terminating TLS with our own CA that every client must trust. |
| **Reverse** | `ANTHROPIC_BASE_URL=http://host:8080` | Everything. Headers readable, credentials injectable, upstream call made by us. |

Only reverse mode can hold credentials. Forward mode is still useful for egress control and for answering
"does this agent honour proxy env at all".

## Results (claude-code, 2026-09-06)

1. **Forward proxy — works.** `HTTPS_PROXY` honoured, every request tunnelled through us, turn completed.
   Also caught outbound telemetry to `http-intake.logs.us5.datadoghq.com`, which is its own useful finding for
   an egress-controlled box.
2. **Reverse proxy — works.** cc accepted a plain-HTTP `ANTHROPIC_BASE_URL`, and we saw the full request:
   `POST /v1/messages?beta=true` with `authorization: Bearer <115 chars>` (the subscription OAuth token, not
   an `sk-ant-` API key). Forwarded upstream, `200 OK`. So header visibility and injection are real.
3. **No local credential — the proxy never gets a chance.** With a clean `HOME`, cc printed
   `Not logged in · Please run /login` and **zero bytes reached the proxy**.

   This is the finding that decides the design. **The login check is local and happens before any network
   call.** No proxy — forward or reverse, Worker or VM — can supply a Claude Code login, because the gate sits
   upstream of the network entirely. The only way to satisfy it is a credential file present on the box.

4. **Latency — none worth counting.** Same endpoint, 5 runs each: **274ms direct, 277ms through the proxy**,
   which is inside the run-to-run spread. The proxy pipes rather than buffers, so on a streaming response the
   added hop is paid once at first token, not per token.

## What this means

- **Subscription (OAuth) cannot be centralised by a proxy.** Result 3 is structural, not a missing feature.
  Copying credential files out to each box is the only thing that would work, and that is account credential
  sharing — not a road to go down. Subscription auth is per-device by design, and subscription use needs a PTY
  besides.
- **API-key usage centralises cleanly, and is the supported way to do exactly this.** Claude Code reads
  `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` precisely so it can sit behind an LLM gateway. The gateway
  holds the real key; engines carry a gateway token or nothing; rotation happens in one place; no engine is
  ever logged in. That is the pain solved, without touching anyone's terms.
- **Headless already implies API billing** (`claude -p` no longer runs on a subscription), and the engines run
  headless. So the ToS-clean path is the path the engines are already on.

## Cloudflare Worker or VM?

- **Reverse proxy on a Worker: yes.** It is `fetch` in and `fetch` out, no raw sockets, and SSE streams pass
  straight through. Key in a Worker secret, or KV/DO if it needs rotating. Fits the stack we already run.
- **Forward/CONNECT proxy on a Worker: no.** A Worker cannot answer `CONNECT` and hold a raw tunnel. That one
  needs a VM.
- Since only reverse mode can carry credentials, a Worker is enough for the credential-holder job. Watch the
  wall-clock and subrequest limits against very long streaming turns; a Durable Object is the escape hatch.

## The pain that remains, and a cheap fix

For anything that must stay on a subscription and therefore on a PTY, per-box login is unavoidable. What is
avoidable is not *knowing*: an expired token currently surfaces as a generic agent failure. A health check
that names it — "auth expired on this box" — turns hours of confusion into a two-minute re-login. That is
worth more than it costs.
