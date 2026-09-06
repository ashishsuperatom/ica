# Credentials — where they live and how to add one

**One sealed document holds everything**, at key `agent-credentials` in the `CREDENTIALS` KV namespace:

```
agent-credentials  (AES-256-GCM, v1.<iv>.<ciphertext>)
  entries: [ { id, provider, value, groups?, note, addedAt } ]   the credentials
  groups:  { projectId → "prod" | "test" | … }                   who may use what
  spent:   { entryId → epoch-ms until it is tried again }        what is exhausted
```

The **master key** is the only thing outside it — a Worker secret, `CREDENTIALS_MASTER_KEY`. That is what makes
a KV dump useless on its own. Decryption is ~0.02ms, so the whole document is read and unsealed on each
request and every question is answered from memory.

One document rather than a key each: one read, one decrypt, and every change atomic — a credential can never
exist without the policy that governs it. Values are never returned by an admin read, never logged, never
listed. The only way one leaves is to a box that asked and proved which project it is.

Neither proxy holds provider keys any more. The EC2 box carries only its own project credential and fetches
what it needs from the vault, caching for ten minutes and re-asking when a provider rejects a key.

**Never in git:** `agent-proxy/.env`, `agent-proxy/.deploy.env`, `vm/projects/*/.env`, `*.pem`. All gitignored;
check with `git check-ignore -v <file>` before assuming.

---

## Two kinds of credential, and the difference decides everything

**API keys** (OpenRouter, opencode-go, Anthropic API) are *deployment* credentials. They don't expire, they can
be held centrally, and the proxy attaches them per request. These get the full treatment: pools, groups,
automatic fallback when one runs out.

**Subscriptions** (ChatGPT/codex, Claude) are *interactive* credentials. Someone signs in on a laptop with a
browser. They expire. They cannot be attached by the proxy for ChatGPT, because that backend refuses any
relayed request — so the tunnel carries bytes it cannot read, and the credential has to be **on the box**.

That asymmetry is the thing to remember: an API key is chosen per *request*, a subscription is chosen per
*boot*.

---

## Adding an API key

### 1. Get the value

| provider | where it comes from |
|---|---|
| **opencode-go** | already on a laptop that has logged in: `~/.local/share/opencode/auth.json` → `['opencode-go'].key` |
| **OpenRouter** | openrouter.ai dashboard → Keys → create. Make one **per group** (prod / test / uat / experiments) so one project cannot spend another's budget |
| **Anthropic API** | platform.claude.com → API keys |

### 2. Add it to the vault (superadmin)

```bash
curl -X POST https://<admin-host>/api/credentials/entry \
  -H "authorization: Bearer <superadmin JWT>" -H 'content-type: application/json' \
  -d '{"id":"or-prod","provider":"openrouter","groups":["prod"],"note":"production"}' \
  --data-urlencode value@-      # the value, never on the command line where it reaches shell history
```

`id` is stable and is what appears in logs (`KEY ISSUED openrouter/or-prod`). Order in the document is
preference: the first usable entry wins. `groups` omitted means any group may use it.

### 3. Put the project in a group

```bash
curl -X POST https://<admin-host>/api/credentials/group \
  -H "authorization: Bearer <superadmin JWT>" -H 'content-type: application/json' \
  -d '{"projectId":"…","group":"prod"}'
```

An unassigned project is `default`, which is deliberately the least privileged — a project nobody has
classified should not inherit production's quota by accident.

### Check it

```bash
curl -s https://proxy.superatom.site/_health        # entries, providers, whether the vault decrypts
curl -s .../p/<projectId>/_key/<provider> -H "authorization: Bearer <sk-proj-…>"
                                                    # what a box would actually be handed; keyId says which
```

`keyId: null` means the vault had nothing and a fallback environment key was used — worth noticing, because it
means that project's group has no capacity of its own.

**Seeding by hand** (what was done first): build the JSON, seal it with a fresh master key, then upload both.
`wrangler kv key put` defaults to a LOCAL simulated store — `--remote` is mandatory, and without it the write
appears to succeed and the Worker sees nothing.

```bash
npx wrangler kv key put --remote --namespace-id <CREDENTIALS id> agent-credentials --path <sealed file>
cat <master> | npx wrangler secret put CREDENTIALS_MASTER_KEY
```

---

## Adding a subscription

### ChatGPT / codex

Someone signs in on a laptop — there is no way around the browser:

```bash
codex login          # writes ~/.codex/auth.json
```

The `access_token` in that file lasts **10 days** and is refreshed by a refresh token. So a subscription is not
a set-and-forget secret: whatever you store goes stale, which is why the box fetches rather than bakes.

Add it to the vault as `provider: "openai-codex"`. **It lasts 10 days**, so this is the one entry that has to
be re-seeded on a schedule — and when it lapses the symptom is an agent that looks broken rather than a token
that looks expired. The engine asks for one at boot:

```
GET /p/<projectId>/_key/openai-codex     →  { provider, keyId, key }
```

and writes it in with `codex login --with-access-token`. **Rotation means the box re-fetching**, not the proxy
substituting — the tunnel cannot see the credential to change it.

Hold several entries (`codex1`, `codex2`, …). When one subscription is spent it is marked, and boxes pick up
the next on their following fetch.

### Claude subscription (claude-code)

```bash
claude setup-token   # one year, prints once, saves nothing
```

This one is **not** a proxy credential. claude-code refuses to make any request without a local login — we
proved it: with a clean `HOME` it prints `Not logged in` and *zero bytes* reach a proxy. So the token goes in
the box's environment:

```
CLAUDE_CODE_OAUTH_TOKEN=<the token>
```

It draws on the subscription rather than extra usage — confirmed on the consent screen ("Contribute to your
Claude subscription usage"), by `authMethod: oauth_token` / `apiProvider: firstParty`, and by $0.00 Console
spend against $0.01 credits with auto-reload off.

---

## The EC2 box

The box holds **no provider keys**. Only its own identity, so it can prove which project it is and fetch the
rest from the vault. `.env` is mode 600 and **never synced** by `deploy.sh` — a redeploy cannot overwrite it
with whatever happened to be on a laptop.

```bash
ssh -i <key> ubuntu@<host>
cat > ~/agent-proxy/.env <<'EOF'
PROXY_PORT=443
PROXY_VERIFY_URL=https://proxy.superatom.site
PROXY_PROJECT=<projectId>
PROXY_PROJECT_KEY=<sk-proj-…>
EOF
chmod 600 ~/agent-proxy/.env
cd ~/agent-proxy && pm2 restart ecosystem.config.cjs --update-env && pm2 save
```

Host and key for deploying live in `agent-proxy/.deploy.env` (gitignored). `./deploy.sh` syncs source and
restarts under pm2.

---

## When a key runs out

The proxy marks it spent in KV with a cooldown and moves to the next candidate, so an agent never sees the
failure. Expiry clears it — nothing has to remember to unmark it.

That works for the reverse-proxied providers. For ChatGPT it cannot: the credential is on the box, inside TLS
we deliberately cannot read, so the box has to ask for a new one. Boxes should re-fetch `_key/openai-codex` on
an auth failure, not only at boot.
