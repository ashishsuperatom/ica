# Model access — how an agent reaches a model, in one place

Every coding agent on every box reaches its model one of two ways, decided per provider by the routing contract
(`vm/packages/agent-contract/contract.mjs`). Nothing else decides it; when this page and the contract disagree,
the contract is right and this page is stale.

## The two routes

| route | providers | how | who holds the credential |
|---|---|---|---|
| **proxy** | `opencode-go`, `anthropic` (relay) | the agent sends to `https://proxy.<platform>/p/<project>/<provider>/…` with `Authorization: Bearer <project key>`; the Cloudflare worker (`control-plane/superadmin/src/proxy/`) proves the project, attaches the real provider key from the vault, forwards, and meters tokens per project | the vault; the box never sees it |
| **tunnel** | `openai-codex` | the ChatGPT backend refuses a base URL, so codex keeps its real URL and its TLS session; the box's traffic to `chatgpt.com` / `auth.openai.com` goes through a CONNECT tunnel on the EC2 relay (`tunnel.<platform>:443`, `agent-proxy/`), authenticated with the project id and key | the box: `codex login` writes `~/.codex/auth.json`; the vault's `openai-codex` entry is that access token, seeded by hand, and expires with it |

A box declares it expects its credentials from the platform by carrying `SUPERATOM_PLATFORM`, `ICA_PROJECT` and
`ICA_KEY` (`vm/apps/engine/ica/box-credentials.ts`). A box without them is a laptop paying with its own logins.

## How the engine configures pi (`vm/apps/engine/ica/pi.ts`)

For a proxied provider the engine takes the model from pi's catalog, sets `model.baseUrl` to the proxy path and
`model.apiKey` to the project key, and tells the runtime the same key in memory (`setRuntimeApiKey`); nothing is
written to disk. For a tunnelled provider the URL is left alone and `ica/proxy-dispatcher.ts` routes only the named
hosts through the tunnel.

## What a project key grants

The project's pooled allowance on the providers the proxy allows, and a code-engine seat on the hub. It does not
read the vault, reach another project, or use anyone's ChatGPT or Claude login. Ten wrong keys throttle the
project for five minutes. Rotation is in the admin console (`/api/project-key/<id>/rotate`).

## Giving a team access

The kit at `~/Desktop/superatom-model-access/` (README, `chat.mjs`, `agent.mjs`, `.env.example`) is what to hand
over: three values in `.env`, one `fetch` for a call, one pi session for an agent. It pins provider `opencode-go`
and model `deepseek-v4.1-flash`.

## Credential expiry

- OpenCode Go and Anthropic relay: API keys in the vault, no expiry.
- Codex: the vault holds the short-lived ChatGPT access token; the console warns three days before it expires;
  re-seed = `codex login` on a box, then paste the new access token into Credentials as `codex1` /
  `openai-codex`. The lasting fix is to store the refresh token beside it and let the proxy refresh (not built).
