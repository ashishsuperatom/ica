# reporting — the report renderer and mail relay

Turns one `Answer` JSON into representations a human can read: **HTML**, **PNG**, and
CSV. It is a standalone Cloudflare Worker project — its own lockfile, its own deploy,
no source dependency on the engine plane. The same Worker also hosts a small,
deliberately separate mail relay for callers whose only outbound route is
`*.superatom.ai`.

```
   engine ──POST /render──▶  reporting  ──▶  { id, html, png, csv }
                                              │
                       whoever asked decides what to do with those URLs

   VM ─────POST /send────▶  reporting/mail ──▶  Cloudflare Email Sending
                           (no render, no report lookup, no content storage)
```

## What these two paths do not know

The **render path** has never heard of Teams, email, Slack, or Outlook. It renders and
stores; callers ask for a report, get URLs back, and choose the surface themselves.
That boundary is the whole design — the previous approach (a bespoke Adaptive Card
renderer living inside the channel code) drifted away from the web UI precisely because
the renderer knew about its destination.

The **mail path** is separate in the other direction: it accepts a fully formed email
and sends it. It does not import the renderer, read R2, look up a report, create a PDF or
store content. The VM's templates compose the HTML; the relay only authenticates,
validates and forwards it.

## How an image is made without a browser

[Takumi](https://github.com/kane50613/takumi) (`@takumi-rs/wasm`) is a Rust HTML/CSS
layout + raster engine compiled to WebAssembly, ~1.5MB gzipped, with a Cloudflare
Workers entry point. It parses our HTML, applies the `<style>` block through a real CSS
cascade (Servo's Stylo), lays out, and rasterises — inside the Worker.

So there is exactly **one renderer** and three consumers of its output:

| surface | what it gets |
|---|---|
| browser  | the HTML, served as-is |
| image    | the *same* HTML, handed to Takumi |
| email    | caller-supplied HTML, forwarded by the mail relay |

The first two cannot drift, because there is nothing to drift from. Email is deliberately
not a third renderer: the VM already composes its own table-and-inline-style templates,
and the relay must never become a report generator.

**Chosen over Satori** (the better-known option) because Satori supports flexbox only —
no grid, no float, no cascade — which would have forced the report layout to be
re-authored for the image. Takumi costs ~360KB more and gives grid, block/inline/float,
real selectors, and PDF output from the same document. Measured, gzipped:
`satori + resvg-wasm = 1.14MB`, `takumi = 1.50MB`.

### Two things about Takumi that are not obvious

- **`devicePixelRatio` does not scale the output.** A PNG has no DPR — Takumi's raster
  is exactly its layout size. A crisp 2× image is made by laying the whole document out
  at twice the size, so every px in the stylesheet is pre-multiplied by `scale`
  (`theme.ts`) and the frame width matches. Setting `devicePixelRatio` alone changes
  nothing (verified).
- **Give the report no explicit width.** The render frame defines the width and the
  report fills it. Setting `width: 1000px` *and* padding overflowed the frame and
  silently clipped the right edge — titles cut mid-word, table columns lost.

## Fitting a report into an image

HTML and CSV are always **complete**. Only the image is constrained, and two rules
govern every reduction (`render/fit.ts`):

1. **Never re-order or re-rank.** The engine chose the row order for a reason we cannot
   see from here. Re-sorting to fit would silently change what the answer *means*. We
   only truncate a tail, in place.
2. **Never hide a reduction.** Anything dropped is announced in the artefact itself
   ("+229 more rows — view the full report"), in the accent colour, so an image is never
   mistaken for the whole answer.

Beyond that: the first column is always kept (a table of numbers with no labels is
worse than no table); a `total` row survives even when the rows it sums do not (it is
the one line that still tells the truth about rows you cannot see); and the height
budget is enforced by **measuring** the laid-out document and cutting rows until it
fits, because real height is driven as much by prose and wrapped cells as by row count.

Limits are parameters, not constants (`DEFAULT_LIMITS`) — the kind of value that should
eventually be learned from real reports rather than fixed by us today.

## Themes

A theme is a set of tokens **plus a chrome mode**, because the product's two looks
differ structurally, not just chromatically:

| theme | chrome | source |
|---|---|---|
| `editorial` *(default)* | `rule` — heavy 1.5px ink rules, hairlines, no boxes | the live answer card (`control-plane/user-ui/src/App.tsx`, `ANSWER_CSS`) |
| `paper` | `card` — rounded surfaces on tinted paper | the design system (`control-plane/user-ui/public/design.css`) |

Both come from the **same markup** (`html.ts`); the stylesheet decides whether
`.sa-card` is a box or is structurally inert. That is what stops a new theme from
forking the renderer.

Note `editorial` has **no positive colour** — good news is just ink, and only bad news
is tinted (amber `#8a5a12`, not red; the live card reserves red for errors). `positive`
is therefore optional on a theme rather than assumed.

Tokens are substituted as literal values rather than emitted as `var()`: Outlook is
unreliable with custom properties. Artefacts are light-only — a baked image cannot
respond to a viewer's theme.

### Rendering-engine gotchas found the hard way

- **A flex row, not `inline-block`, for the accent pill.** As an inline-block the box
  was sized before `white-space` applied and the background was clipped mid-word.
- **No bare text nodes inside a flex container** — they become anonymous items and lay
  out unpredictably. Every child is an explicit element.
- **Register a `generic: 'sans-serif'` font.** A theme's font *stack* only resolves if
  something claims the generic family; otherwise every glyph is tofu.
- **No backticks in this file's CSS comments** — the stylesheet is a template literal
  and one will end it.

## Fonts

Inter (400/600/700) in `assets/fonts/`, registered as the `sans-serif` generic so both
themes' font stacks resolve to it. Fonts must be registered with the renderer **once
per isolate**, not per render.

## Layout

```
src/
  types.ts            the Answer shape (vendored — see the note in the file) + report types
  render/
    fit.ts            the image-only reduction rules
    theme.ts          tokens + the stylesheet they bake into
    html.ts           Answer → HTML  (the single renderer)
    image.ts          HTML → PNG via Takumi
  mail/               the isolated mail relay; see src/mail/README.md
    token.ts          per-app token verification/minting
    validate.ts       recipient/attachment/body rules
    delivery.ts       exactly-once state machine + dedupe key
    delivery-do.ts    one SQLite Durable Object per project (metadata only)
    handler.ts        POST /send
test/
  sample.mjs          renders a representative report to test/out/ — run it and look
  fit.test.mjs        the reduction rules
  mail.test.mjs       token, validation, handler and delivery-state tests
scripts/
  check-mail-isolation.mjs   fails if mail/ reaches into render/storage or logs
  mint-mail-token.mjs        mints one app token
```

## Running it

```sh
pnpm install
pnpm sample     # writes test/out/report.png + report.html
pnpm test
```

## Deployed — `https://reports.superatom.site`

```
POST /render                  Bearer service token
     { projectId, questionId, answer, title?, category?, theme? }
  →  { id, html, png, csv, expiresAt }

POST /send                    Bearer per-app token
     { id, tag?, from_name, to, cc?, subject, html?, text?, attachments? }
  →  { id }                   (or a generic { error } with a 4xx/5xx status)

GET  /r/:projectId/:id        HTML — COMPLETE, nothing dropped
GET  /r/:projectId/:id.png    PNG  — fitted, and says what it dropped
GET  /r/:projectId/:id.csv    CSV  — COMPLETE
GET  /sample /sample.png /sample.csv     no storage, no auth
```

The `reports.*` route is more specific than the control-plane's `*.superatom.site/*`
wildcard, so only `reports.*` lands there. `mail.superatom.ai/*` is a second, separate
route in the same Worker; on that hostname only `/send` is exposed — everything else
returns 404 rather than serving the renderer.

### Identity: (projectId, questionId)

The id is `HMAC-SHA256(SIGNING_KEY, "projectId:questionId")`, truncated to 22 chars.
That is idempotent (a retried POST returns the same report — verified), predictable (a
caller holding the qid can derive the URL without storing a second id), and
unguessable, which matters because **the id IS the credential**: Teams' CDN and
Outlook's image proxy fetch the PNG with no cookies and no auth headers, so nothing but
the URL can carry authority. Anyone with the link can view the report — inherent to the
surfaces, bounded by the 30-day TTL, and revocable wholesale by rotating the key.

A report is **immutable**: a re-POST of the same qid returns the existing report
untouched (`reused: true`) rather than overwriting it. Overwriting only the JSON would
leave already-cached renders disagreeing with the page. A re-ask is a new qid, so it is
naturally a new report, and a shared link keeps showing what its recipient was told.

### Three cache tiers, cheapest first

Edge (`caches.default`) → R2 → render. The PNG renders **lazily on first request**, so
the POST path stays fast (a live turn is waiting on it) and a report nobody opens is
never paid for. Persisting and edge-caching happen in `waitUntil`, after the response.
The `x-cache` header reports which tier served it — note the copy placed in the cache is
built separately, or every edge hit would forever echo the `miss` of the render that
populated it.

### Storage

R2 (`frontend-packages`, everything under the `reporting/` prefix). Not KV — it is
eventually consistent, and the flow is *POST → share URL → a CDN fetches it seconds
later from another region*, exactly where KV can 404 on a report that exists. Not a
Durable Object — a report is immutable and read globally; a DO would pin every read to
one region for coordination we do not need. Expiry is enforced on read rather than by a
bucket lifecycle rule — but deletion IS one: R2 lifecycle rules take a prefix condition,
so `reporting-expiry` expires objects under `reporting/` after 31 days and cannot reach
anything else in the shared bucket. The rule works on object age, so it only matches our
`expiresAt` while `TTL_DAYS` is a constant; the extra day keeps the read path (410 Gone)
authoritative and makes deletion a pure cost cleanup.

### Mail relay storage

`POST /send` uses no R2 and no KV. Exactly-once coordination lives in a SQLite-backed
Durable Object per project (`MAIL_DELIVERY`, one object named after the project). Its one
table is:

```
deliveries(key TEXT PRIMARY KEY, status TEXT, at INTEGER, message_id TEXT)
```

`key` is `HMAC(MAIL_DEDUPE_KEY, project:id)`; `status` is only `sending` or `sent`;
`message_id` is Cloudflare's id. That is all. There is **no recipient, subject, body,
attachment, error text or request in storage**. Rows older than 7 days are pruned, and the
object's alarm keeps the table bounded.

The state machine is the exact-once guarantee:

- first request inserts `sending` atomically, then calls Cloudflare;
- success stores `sent` + message id; later requests return the same id without sending;
- a definite pre-send error deletes the claim, so a retry may try again;
- an ambiguous error (timeout, `E_DELIVERY_FAILED`, an exception) leaves `sending` and the
  next request gets `409 { "error": "unknown" }` — it is never resent automatically.

A crash between the claim and Cloudflare accepting the mail also leaves `sending`: the
relay chooses a possible lost email over a possible duplicate. An operator can inspect
Cloudflare and issue a new `id` if needed.

## Who actually fetches the image (measured)

A report image in a Teams card is **not** fetched by the viewer's device. Captured from
a live card:

```
user-agent:       Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview
                  Preview/0.5 skype-url-preview@microsoft.com
cf-connecting-ip: 52.112.49.196        (Microsoft)
cf-ipcountry:     MY                   (a Microsoft datacentre, not the user)
```

It is Microsoft's server-side link-preview crawler, with a hardcoded legacy UA, fetching
**once** and then serving every viewer on every device from Microsoft's own cache. A
user tapping the image on their phone produces no request here at all.

Three consequences, all load-bearing:

1. **Per-device rendering is impossible.** There is no device signal, and one message is
   viewed on many devices anyway. A "mobile variant" cannot be chosen at send time or at
   fetch time. Don't try. Render one image that works everywhere, at 2× so tap-to-zoom
   is legible — verified on a real phone.
2. **The image must be self-sufficient the instant it is fetched.** There is no second
   chance to renegotiate size, format or content.
3. **Our caching matters less than expected for Teams** — expect roughly one render per
   report regardless of audience size. The edge/R2 tiers mostly serve the HTML page.

## Image format

PNG, and measured rather than assumed: at 2× the same report is **271KB as PNG, 374KB as
WebP, 599KB as JPEG**. Takumi's WASM build has no lossy WebP encoder (`quality: 80` and
`quality: 60` produce byte-identical output), and JPEG is the wrong codec for flat colour
and sharp text. The real size lever is `scale`: 2× 271KB → 1.5× 192KB → 1× 122KB. Revisit
if a lossy WebP encoder lands.

### Mail relay: settings and tokens

The full contract is in `src/mail/README.md`. The operational facts:

- Cloudflare secrets: `MAIL_SIGNING_KEYS` (JSON registry, one entry per app) and
  `MAIL_DEDUPE_KEY` (a separate long-lived HMAC key). Vars: `MAIL_FROM` and
  `MAIL_ALLOWED_DOMAINS` (`dabur.com,superatom.ai`). SLOB's registry entry allows both:
  `dabur.com` for the customer and `superatom.ai` for internal/test recipients.
- Mint one token per app, never one shared token:
  `pnpm -C reporting mail:token --kid slob-prod --days 3650` with `MAIL_SIGNING_KEYS` set.
  That is a 10-year token for the unattended SLOB VM. Give the token to the app; keep the
  signing key in Cloudflare and a password manager. Revoke by removing the `kid` from
  `MAIL_SIGNING_KEYS` — no VM login needed. (`--days 0` is also accepted for no expiry,
  but 10 years is the better backstop.)
- Rotate by adding a new `kid`, issuing a token, then removing the old `kid`. Revoke by
  removing the app's entry; its token gets `401`.
- On the Cloudflare Email Sending domain: **Email preview off** (it retains content for
  about seven days) and **Drop suppressed recipients off**. Sending DNS lives on
  `cf-bounce.superatom.ai`; `mail.superatom.ai` is HTTP only and has no MX/SPF/DKIM.
- The VM sets `MAILER_URL=https://mail.superatom.ai/send` and `MAILER_KEY=<token>` in
  `/srv/slob/.env`. Treat `409` and every `4xx` other than `429` as terminal for that
  outbox row; `429`/`503` may be retried later. Confirm the first real send passes
  `spf=pass`, `dkim=pass`, `dmarc=pass`.

## Known gaps

Ordered by how likely each is to bite.

1. **Only Latin glyphs ship.** `assets/fonts/` is Inter 400/600/700 — Latin, punctuation
   and currency symbols. Verified good: `₹`, `→`, `—`, `·`. Anything in Devanagari,
   CJK, Arabic, Thai or Cyrillic will render as **tofu**, silently, in the image only
   (the HTML page uses the viewer's system fonts and will look fine, which makes the
   bug easy to miss). Fix is a subset font per script, loaded lazily from R2 by
   codepoint range — Takumi's `FontLoader` supports exactly that.
3. **No access control on read, by design.** Anyone with a link sees the report. The PNG
   *has* to work this way (Teams' CDN sends no auth), but the HTML page carries the
   COMPLETE data and is arguably more sensitive than the image. Worth revisiting whether
   the page should require a session while the image stays open.
4. **A theme is a request parameter, not a project setting.** Per-project branding needs
   somewhere to live before it is real.
5. **Concurrent first-hits render more than once.** Two requests for a cold PNG both
   render. Wasteful, not wrong (rendering is idempotent), and the cache closes the
   window quickly.
6. **Timing headers read 0 in production.** Workers freeze `Date.now()` between I/O as a
   timing side-channel defence, so in-request wall clock is unmeasurable. Local
   `wrangler dev` numbers are the real ones.
7. **Render route tests are thin.** `fit.test.mjs` covers the reduction invariants — the
   part that can silently corrupt an answer. The render routes are verified by hand
   against the deployment. The mail path has unit tests for its token, validation,
   handler and state machine, but its SQLite Durable Object is covered by a real deploy
   rather than a local Workers runtime test.

## Not built yet

The email CSS inliner and the admin app. CSV exists but is unreviewed — whether a report
should carry a data download at all is still open.
