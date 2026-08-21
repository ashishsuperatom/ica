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

## Deployed

`https://reports.superatom.site` — `/sample.png` is the image, `/sample` the complete
HTML, `POST /render` and `POST /preview` take an Answer. The route is more specific
than the control-plane's `*.superatom.site/*` wildcard, so only `reports.*` lands here.

## Not built yet

The worker itself (`/render`, `/r/:id`, `/r/:id.png`), the ReportDO, signed URLs, R2
caching, CSV, the email CSS inliner, and the admin app. Decisions already taken for
those: reports are immutable (re-answering mints a new id, so a shared link keeps
showing what the recipient was told); the signed URL *is* the credential, because Teams'
CDN and Outlook's image proxy send no auth headers, so links need a TTL and a
per-project signing key that can be rotated; and the PNG renders lazily on first hit,
so a report nobody opens is never paid for.
