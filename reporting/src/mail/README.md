# Mail relay

`POST https://mail.superatom.ai/send` accepts a fully formed email and sends it through
Cloudflare Email Sending as `reports@superatom.ai`. On the `mail.superatom.ai` hostname
only `/send` is exposed; every other path returns 404, so the mail host is not a second
report host.

This is not a renderer. It does not import `src/render/`, `src/store.ts` or `src/types.ts`,
does not read R2, does not look up a report and does not create a PDF. The caller composes
the HTML/text and supplies attachments already encoded. The relay authenticates the app,
checks the request against that app's registry entry, and forwards it.

Run `pnpm -C reporting check:mail` to enforce the isolation boundaries (no `console`, no
`fetch`, no R2/storage imports).

## Request

```
POST /send
Authorization: Bearer <per-app token>
Content-Type: application/json

{
  "id": "slob-123",                 // idempotency key; unique per email in this app
  "tag": "approval",                // optional; ignored by the relay
  "from_name": "SLOB Action Planning",
  "to": ["ashish@superatom.ai"],
  "cc": ["ops@superatom.ai"],       // optional
  "subject": "…",
  "html": "<!doctype html>…",       // at least one of html/text
  "text": "…",
  "attachments": [
    { "filename": "report.pdf", "content": "<base64>", "type": "application/pdf" }
  ]
}
```

Success is `200 { "id": "<Cloudflare message id>" }` (a duplicate returns the original id,
plus `"duplicate": true`). Failure is a generic `{ "error": "…" }`; it never echoes a
recipient, subject, body or Cloudflare error text.

`id` is the idempotency key. Repeating it with different content returns the first result
and does **not** send the new content — callers must mint a new `id` for a new email.

## Scope enforced by the Worker

The token's registry entry is authoritative. The token cannot widen its own scope.

| Check | Rule |
|---|---|
| sender | `reports@superatom.ai` (Cloudflare binding allowlist too) |
| recipients | bare addresses, exactly the registry domains; for SLOB that is `dabur.com` and `superatom.ai`; no subdomains, display names, quotes or whitespace |
| recipient count | at most 50 (after `to` + `cc`, before deduplication) |
| `from_name` | if present, exactly the registry value |
| subject | 1–998 characters, no control characters |
| body | at least one of `html`/`text`; each at most 512 KiB |
| attachments | at most 32; PDF, CSV, XLSX, PNG, JPEG; extension must match the MIME type; safe filename; base64 only; at most 4 MiB encoded each |
| whole message | at most 5 MiB, including a 64 KiB header allowance |
| HTTP body | at most 8 MiB; JSON only; no `Origin` header |

`cc` recipients are deduplicated against `to` (first occurrence wins). Unknown JSON fields
are ignored; `bcc` is not supported.

Status mapping for provider failures:

| Status | Meaning |
|---|---|
| `400` | malformed request, bad recipient, bad attachment, bad subject |
| `401` | missing/invalid/expired token |
| `403` | browser `Origin` present |
| `409` | ambiguous previous attempt (`unknown`) — **do not retry this id** |
| `413` | message too large |
| `415` | not JSON |
| `422` | suppressed recipient, too many recipients/attachments, or a definite rejection |
| `429` | rate/daily limit; retry later |
| `500` | misconfiguration or unexpected failure |
| `503` | sender not ready/suspended; retry later |

The VM should treat `409` and every `4xx` other than `429` as terminal for that outbox
row, and may retry `429`/`503` later. A `409` means a prior attempt may have delivered;
retrying risks a duplicate.

## Tokens and secrets

Cloudflare secrets (never in `wrangler.jsonc` or the repository):

| Secret | Purpose |
|---|---|
| `MAIL_SIGNING_KEYS` | JSON registry, one entry per app: `{ "<kid>": { "key": "<base64 32-byte>", "project": "<project>", "domains": ["dabur.com", "superatom.ai"], "fromName": "<display name>" } }` |
| `MAIL_DEDUPE_KEY` | separate HMAC key, at least 32 bytes; long-lived; not rotated with signing keys |

Vars:

| Var | Default | Purpose |
|---|---|---|
| `MAIL_FROM` | `reports@superatom.ai` | sender address; must be in the binding allowlist |
| `MAIL_ALLOWED_DOMAINS` | `dabur.com` | comma-separated global allowlist; every registry domain must be in it (SLOB config: `dabur.com,superatom.ai`) |
| `MAIL_REPLY_TO` | unset | optional reply address; no mailbox is assumed |

The token is `v1.<base64url payload>.<HMAC-SHA256>`. The payload carries the key id,
expiry, project, recipient domains and display name. The Worker looks the key id up in
the registry, verifies the signature, then checks every claim against that entry. A token
is therefore tied to one app's project and recipient-domain set.

### Mint

Generate a signing key for the app, add it to the registry, set the secret, then mint:

```sh
openssl rand -base64 32        # the app's signing key; keep it in the password manager
```

Add one entry to the registry JSON (never commit it):

```json
{
  "slob-prod": {
    "key": "<the generated key>",
    "project": "slob-prod",
    "domains": ["dabur.com", "superatom.ai"],
    "fromName": "SLOB Action Planning"
  }
}
```

Set the same JSON as `MAIL_SIGNING_KEYS` in Cloudflare, then mint from it:

```sh
MAIL_SIGNING_KEYS='{"slob-prod":{"key":"<key>","project":"slob-prod","domains":["dabur.com","superatom.ai"],"fromName":"SLOB Action Planning"}}' \
  pnpm -C reporting mail:token --kid slob-prod --days 90
```

The token goes to stdout; everything else goes to stderr. Give the token to the app
(SLOB: `/srv/slob/.env` `MAILER_KEY`, root-only). Never put a token or key in git, a
shell history file, chat or a log. The `--key` option exists for local use, but it does
not print the key: save the key yourself and set it in `MAIL_SIGNING_KEYS`.

Rotation: add a new `kid`, mint a token, deploy/update the app, then remove the old
`kid`. Revocation: remove the app's entry; its token immediately gets `401`. The default
token lifetime is 90 days (up to 366).

## Delivery ledger

One SQLite-backed Durable Object per project, named after the registry's `project`:

```
deliveries(key TEXT PRIMARY KEY, status TEXT, at INTEGER, message_id TEXT)
```

`key = HMAC-SHA256(MAIL_DEDUPE_KEY, project:id)`. `status` is `sending` or `sent`;
`message_id` is Cloudflare's id. Rows are pruned after 7 days. There is no content in the
object, R2, KV or Worker logs. The project alone scopes the key, so adding a recipient
domain does not change the idempotency key of an email already in flight.

- First request atomically inserts `sending`, then sends.
- Success updates to `sent` and returns the message id.
- A definite pre-send failure deletes the claim, so a later request may try again.
- An ambiguous failure leaves `sending`; later requests get `409 unknown` and never
  resend automatically.

A crash between the claim and Cloudflare accepting the message also leaves `sending`.
That is the deliberate no-duplicate trade-off: a possible email can be lost, but a report
is never sent twice. The VM's outbox row will eventually be marked failed with `unknown`;
an operator can inspect Cloudflare and decide whether to issue a new `id`.

## Cloudflare and DNS

- Email Sending is onboarded on `superatom.ai`; the binding allowlist is only
  `reports@superatom.ai`.
- Sending DNS is on `cf-bounce.superatom.ai` (MX, SPF, DKIM). Do not add MX/SPF/DKIM
  records to `mail.superatom.ai`; it is an HTTP endpoint only.
- **Email preview off** (it retains sent content for about seven days).
- **Drop suppressed recipients off** (on can silently drop and still look successful).
- Expected authentication: DKIM `d=superatom.ai` via selector `cf-bounce`, which aligns
  with the existing strict DMARC. Confirm on the first real send: `spf=pass`,
  `dkim=pass`, `dmarc=pass`.

## First deploy

```sh
cd reporting
pnpm check:mail
pnpm test
npx wrangler secret put MAIL_SIGNING_KEYS   # paste the registry JSON
npx wrangler secret put MAIL_DEDUPE_KEY     # paste a fresh openssl rand -base64 32
pnpm deploy
```

Then send a real test to `ashish@superatom.ai` (never a Dabur address during setup),
inspect the received headers for SPF/DKIM/DMARC, and repeat the same `id` to confirm no
second message is sent. Real Dabur recipients are chosen by the SLOB app when it sends a
report, not by a relay smoke test.
