# reporting — the report renderer

Turns one `Answer` JSON into representations a human can read: **HTML**, **PNG**, and
(soon) **CSV**. It is a standalone Cloudflare Worker project — its own lockfile, its
own deploy, no source dependency on the engine plane.

```
   engine ──POST /render──▶  reporting  ──▶  { id, html, png, csv }
                                              │
                       whoever asked decides what to do with those URLs
```

## What this service does not know

It has never heard of Teams, email, Slack, or Outlook. It renders and stores; it does
not send. Callers ask for a report, get URLs back, and choose the surface themselves.
That boundary is the whole design — the previous approach (a bespoke Adaptive Card
renderer living inside the channel code) drifted away from the web UI precisely because
the renderer knew about its destination.

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
| email    | the *same* HTML with the CSS inlined (Outlook drops `<style>`) |

They cannot drift, because there is nothing to drift from.

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
test/
  sample.mjs          renders a representative report to test/out/ — run it and look
  fit.test.mjs        the reduction rules
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

GET  /r/:projectId/:id        HTML — COMPLETE, nothing dropped
GET  /r/:projectId/:id.png    PNG  — fitted, and says what it dropped
GET  /r/:projectId/:id.csv    CSV  — COMPLETE
GET  /sample /sample.png /sample.csv     no storage, no auth
```

The route is more specific than the control-plane's `*.superatom.site/*` wildcard, so
only `reports.*` lands here.

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
7. **Route tests are thin.** `fit.test.mjs` covers the reduction invariants — the part
   that can silently corrupt an answer. The worker's routes are verified by hand
   against the deployment, not by a test.

## Not built yet

The email CSS inliner and the admin app. CSV exists but is unreviewed — whether a report
should carry a data download at all is still open.
