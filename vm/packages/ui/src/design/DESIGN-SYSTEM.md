# The design system

Plain CSS on CSS variables — no Tailwind, no daisyUI, no preprocessor, no CSS-in-JS. This folder carries no project
vocabulary: lift it into the next project as it is. It is the slob design (`client/dabur/slob`) brought over as a
system and refined; the refinements are listed at the end. **Read the rules, then the primitive or block you are
about to use, then its snippet. Every rule below is an invariant: a component that breaks one is a bug.**

```
src/design/
  tokens.css        the one layer of decisions: colour, space, radius, elevation, type, motion, layers, sizes
  base.css          reset (preflight equivalent), fonts, focus policy, scrollbars, selection, the text roles
  primitives.css    one class family per thing (the vocabulary below)
  layout.css        the rooms: app shell, sidebar, thread (block frame, separator, branch bar), home
  charts.css        what surrounds a chart canvas (legend, pad, the ring's legend layouts)
  chart-theme.ts    the ECharts theme object derived from the tokens (colours, fonts, tooltip, legend)
  color.ts          the colour half for code: MEANING/ACCENT, STATE_ACCENT, ragAccent, tint(), paint(), read()
  index.css         imports the five sheets in reading order
src/lib/draft.ts    commit-on-close, once, for every control that stays open (Draft + useDraft)
```

## A step — the standard

Every program step (a block in an agent's session) reads the same way, by default, through the framework — nothing here
is the program's to lay out. In order, top to bottom:

1. **The block frame** — number, kicker, title, one line under it, its tools on hover (`BlockFrame`, rule 6).
2. **The filter row** — one system: slots on a grid (small / medium / large), each a dropdown with a search box whose
   choices are computed from the data in scope, each with its count and value; "Fewer / More", "Break down by" and
   "Clear all" in the same row (rule 19). Declared by the program, drawn by the platform.
3. **KPI cards** — a small uppercase label, one big figure coloured by its meaning, one line under it, an arrow when it
   opens something (`Kpi`). Flat: no shadow, no lift (Tokens, "No elevation").
4. **Words first** — a heading and two or three plain sentences, read like a chat answer: on the page, no box around
   it, no boxes inside boxes; parts set apart by space (`--part-gap`, `.sa-step`) and hairline rules only.
5. **Sections, one view each** — heading, one line (`says`), a note on the right, and the `ViewToggle`
   "table | chart ▾"; a section with a chart opens on the chart, its table a click away (rule 20).
6. **Tables closed** — a section that is only a table is one line, "▸ <title> · N rows", opening in place with its
   search, group-by and drill (rule 21).
7. **Rich components** (a stepper — `Track`) are welcome on the same terms: no shadows, few borders.
8. **Everything at once** — no scroll-snapping and no one-at-a-time reveal on a program's or agent's screen (rule 22).
   The ask agent's chat thread keeps its own unfolding.

## The rules (invariants)

1. **Values live in tokens.css only.** A primitive says `var(--sp-3)`, never `12px`. A component says a class,
   never a value. Missing a value? Add a token with what it means.
2. **Colour is meaning.** `--loss` / `--warn` / `--win` are the only red, amber and green, each a triple (`--x`,
   `--x-ink` for text, `--x-wash` for a background). `--series-1/2/3` say what a figure is about. `--primary` is for
   what can be done, never for data. Code goes through `ACCENT[meaning]`, `STATE_ACCENT[state]`, `ragAccent(word)`
   and `paint()`; a canvas is handed a resolved colour, never a variable.
3. **Space and radius from the scales.** `--sp-*` (4px steps, half steps where a control needs them) and
   `--r-xs/sm/md/lg/full`. Nothing between them.
4. **Type from the scale.** `--t-2xs … --t-2xl`, three weights, four leadings, four trackings. Figures are
   `tabular-nums` through `.sa-figure`.
5. **One motion.** `--dur-1` (120ms) for a state change, `--dur-2` (200ms) for a move, `--dur-settle` for a card
   reaching its height. Reduced motion turns them off in base.css.
6. **Hover-revealed actions.** A block's own tools — copy, collapse, remove — sit at `opacity: 0` and appear on
   `:hover`/`:focus-within` of their frame (`.sa-block__tools`). On a touch screen they simply stay. A section's view
   choice (table | chart ▾) is NOT one of them: it is always there, on the right of the section's head
   (`.sa-section__hover`), so a reader sees at once that the figures can be read another way.
7. **Naming.** `sa-thing`, `sa-thing__part`, `sa-thing--variant`; state by `data-*` or ARIA (`[data-active]`,
   `[aria-selected]`, `[data-state]`, `[data-on]`). A component may add a small stylesheet only for structure that
   is truly its own; it composes primitives for everything else.
8. **Text fits its track.** Every text that can outgrow its container either WRAPS (running text: descriptions,
   notes, footnotes, hints, reasons, alerts, toasts — `overflow-wrap: anywhere`) or TRUNCATES with an ellipsis and
   carries the full text in `title` (labels in controls, chips, triggers, options, table cells, legend items, KPI
   labels, next-move buttons, sidebar items, block and section titles, pills, tags). A row never holds two
   free-length texts side by side without one of them being the one that gives way (`flex: 1; min-width: 0`). Numbers
   never truncate — they get the room (`white-space: nowrap`; a KPI tile is never narrower than `--tile-w`) and the
   text beside them gives way. Nothing clips mid-word. A container that must scroll says so with its own scroll
   (`.sa-section__scroll`, `.sa-scroll`), never the page. Grids use `minmax(0, 1fr)`, never bare `1fr`, so a nowrap
   cell cannot force a track open. Nothing has a negative margin. The headless pass (`/tmp/f5-pw/check5.mjs`) opens
   the synthetic answer `public/mock/_stress.json` (90-character names, a 30-item legend) at 1400 and 390 wide and
   fails on any element whose content is wider than its track.
9. **Commit on close.** A control that stays open while it is used (a multi-select, a picker, a popover with many
   choices) edits a DRAFT and sends nothing while open; when it closes — click outside, Escape, Enter, blur — the
   draft is compared with the value in force when it opened, normalised (order-independent for sets): equal sends
   nothing, changed sends ONE move with the whole change. The draft is shown honestly while open (a tick appears at
   once; the trigger may read "editing"). Controls that close on choose (a single-choice select, a stepper click, a
   preset) commit on choose; a text or number input commits on blur or Enter. Implemented once in `lib/draft.ts`
   (`Draft`, `useDraft`) and used by every such control — never re-implemented per control.
10. **Popovers.** The search row holds one thing: the search box, with a short placeholder (`Search…`, or the noun:
    `Months…`). A selection count or a Clear goes in `.sa-popover__foot`, or is dropped where the trigger already
    says it. Text in a popover truncates with `title`; nothing clips mid-word. A popover is at least `--popover-w`
    (280px) wide and grows to its trigger's width.
11. **A filter option is a LABEL.** The source records the same thing once per subsidiary or type, each with its
    own key; a person filters by the label. `app:members` groups matches by label (`key: string | string[]`,
    `keys`, `recorded` when > 1); choosing one pushes every key it carries in one `push`; the chip reads the label
    once (never a key); the option row says "recorded N times" in its note when N > 1; a filter's value compares
    normalised (sorted, deduplicated) — `memberKeys`, `filterLabel` and `FilterAdd` in
    `components/question/QuestionControls.tsx`.
12. **A lens is display only.** Chart / ring / table, grid / table: the card's own hover toggle, remembered per
    browser, never sent to the server. What a block asks does not change when how it is drawn does.
13. **Ring only for parts of one whole.** The server marks a bars block `whole: true`; the client never guesses.
    One plain series, at most 12 slices; beyond that, bars. The ring is one of the section's pictures, behind the chart
    button's ▾ — drawn alone, never beside its bars (rule 20).
14. **Legend by size.** A legend is never dropped. ≤ 4 items: one row above the ring. 5–12: a column beside the
    ring, one item per row; the ring is a square as tall as the rows and the legend wraps beneath into columns when
    the row is too narrow. > 12: a scrolling list beneath a full-size ring, the whole capped. Bars with more than
    four series wrap their legend. In a legend item the NAME is the primary text and keeps at least `--legend-name`
    (140px, or 60% of the column) before it truncates; the value is secondary and shrinks first — full ("12 people ·
    15%") when there is room, the share alone when tight, gone below that — with the whole "name · value" in `title`.
    A legend column is at least `--legend-w` (220px); a ring + legend row narrower than that stacks the legend beneath.
15. **Placeholder, then query.** Opening a child block appends a placeholder (the move's label, a skeleton) and
    scrolls to it before the request is sent; the answer fills it; a refusal removes it and says why in a toast.
    An in-place edit keeps the block and dims it; a refusal there is a toast and the block stays as it was.
16. **Show what you have, ask anyway.** The client keeps a bounded, per-page-session cache of answers keyed by the
    normalised question (and the request that produced it; `lib/cache.ts`, 40 entries, least recently used
    evicted) and of members per (dimension, typed). A block opening on a question seen earlier shows that answer at
    once, marked "from earlier · time", and the request goes out regardless; the fresh answer replaces it in place,
    and when it is identical by JSON the shown object is kept so nothing re-renders. Nothing is ever served without
    being re-asked; the server is the only source of truth. Parts and parcels are the transport's, from
    `@superatom/transport` (the platform's `clients/transport.ts`, used by both ends): `HubClient` hands every
    outgoing message to its `sender` and every incoming frame to its `receiver`, and only whole messages are
    dispatched. No component, block or client code may look at `part` or `parcel`.
17. **A prose block never pretends to be a state.** A typed question at the foot of the thread (`AskBar`,
    `.sa-askbar`: sticky at the bottom, Enter sends, Shift+Enter breaks a line, one reading at a time per thread,
    the hint names the block it is asked from) goes to the thread's reader agent (`app:say`; the thread id keeps
    the reader's memory across asks) and is shown as a `said` block (`SaidBlock`: the question as its title with a
    "Reader" mark, the markdown as `.sa-prose` with no raw HTML and only safe links, and the calls it stands on as
    chips under "What this stands on"). It has no controls, no next moves, no lens; it cannot be filtered or moved
    from — a person moves on from the block above it, and a further ask is asked from the nearest state above. It
    keeps the placeholder-then-query behaviour ("reading… N s", with the last line the reader has said beneath —
    progress a person reads arrives as `narration` frames (matched to the pending request by `reqId`, or by the
    `qid` the request was seen with), fanned by the hub on the channels attached on every connect (`log:attach`
    narration, composer-log); a narrated line restarts the request's clock, is shown once (dedupe on qid+text) and
    never resolves it; an agent's own `agent:hello/event/chunk` frames are tolerated and only restart the clock; a typed question waits ten minutes of silence, everything else
    ninety seconds — `lib/pending.ts`); `app:refused` (nothing written in time) removes the placeholder with a toast. The reader is told a block's question, title, headline figures and notes — never rows.
18. **A second theme** is a second `:root[data-theme=…]` block in tokens.css redefining the same names.
19. **A filter's choices are computed, never typed.** A program declares its filters in its manifest
    (`package.filters`: `{ field, label, options, size?, noun?, unit? }`, docs/program-contract.md "Filters") — each on a
    field of its slice that can mean "all" (a nullable string, or a list of strings) and naming a function of the
    program that computes its choices from the data in the current scope: `[{ value, label, count, amount? }]`, every
    count above nothing, so choosing any choice can never give an empty result. The build refuses a filter with no such
    function, one the server side does not export, or choices written by hand, saying how to fix it; the platform
    refuses a choice that holds nothing. After every answer of the program the platform computes them and the answer
    carries the row (`:::filters <slice>.filters`, `Filters`), drawn the same on every screen: each filter in a slot of
    one grid — `small` one `--filter-slot`, `medium` two, `large` three, never a width of its own; the whole width where
    three do not fit — its name above a `Select` (one choice; "All" clears it) or a `MultiSelect` committed on close
    (rule 9), each choice's note its count and amount ("776 SKUs · 14.78 Cr"). The first `FILTERS_SHOWN` show, and any
    with a choice in force; "More (n)" / "Fewer" shows the rest; "Break down by" (`package.breakdown`) and "Clear all"
    end the same row. A filter narrows the view it is on: every change is one intent to the current block.
20. **One view at a time.** A section with a chart shows one view: it opens on its chart, the table is one click away,
    further pictures (a ring for parts of a whole) wait behind the chart button's ▾ — `useOneView(name, pictures)` gives
    the view in force and the `ViewToggle` "table | chart ▾" for the section's head. Never two charts of the same
    figures side by side. The choice is a lens (rule 12).
21. **Tables are closed by default.** A section that is only a table shows one line — `ClosedTable`, "▸ <title> · N
    rows", a hairline above it — and opens in place, with its search, group-by, sort, pages and drill; a chevron folds
    it again. Nothing is lost and nothing is asked again to open it. A table someone opened on purpose (a card opened
    from an answer, "Show the rows") is drawn open (`TablesOpen`).
22. **A program's step shows everything at once.** No scroll-snapping, no part waiting its turn: its filters, figures,
    words and sections are on the page together, apart by `--part-gap` (`.sa-step`). Only a question's answer in the
    chat thread unfolds as it arrives (`Answer` `arriving`); a program's answer is never drawn arriving.

**Nothing jumps (the user, 2026-10-06):** a screen does not load, change, then change again. From the first paint every
part holds the place and size it will have: figures render every tile (`Kpi loading`, one height loaded or not); charts
sit in a `ChartFrame` whose shimmer is as tall as the chart will be (legend and axis included) — loaded, the chart takes the height it needs, never clipped; a list is `RecordList` with `rows={null}`
(not yet read) — rows of the records' size, never "nothing here" that then fills — and with `pageSize` a page never
grows, with `search` anything is found whatever page it is on. Lists of things that grow (organisations, projects,
people) are lists with search and pages, never every one of them drawn as a card. Something that can only grow does so
at the bottom, below everything else.

## Which block for which data

- **KPI tile** (`Kpi`) — one figure with a state: the label, the number in its meaning's colour, one line of hint.
  Never a figure without a label; never more than one number per tile.
- **Figure** (headline + because) — the result of a what-if: one number, what it is compared against, the reasons.
- **Ring** — parts of ONE whole (`whole: true`), one plain series, ≤ 12 slices; otherwise bars. A picture of its own
  behind the bars' ▾ (rule 13), never beside them.
- **Bars** — comparing categories or periods; a `line` series is a marker (a target, a budget), never a bar.
- **Grid** — entity × period with a state per cell (under / over / ok / none). The first column stays put.
- **Table** — a list a person scans or sorts; closed until opened (rule 21); rows with a move open a child;
  `rowState` washes warning/critical rows only. Sorting is in the browser and the footer says so.
- **Filters** — the step's filter row (rule 19): declared by the program, its choices computed, drawn by the platform.
- **Facts** — one record: label / value pairs, two columns. **Text** — a reading the answer wrote.

## Primitives — reference

Each entry: what it is for · classes / props · defaults · when not · a minimal snippet.

### Button — `.sa-btn`
For any action with words. Variants `--primary` (the one main action on a screen), `--pill` (a next move), `--link`
(a quiet inline action such as Clear all); parts `__icon`, `__text` (truncates with `title`). Height `--control-h-sm`.
Not for icon-only actions (use the icon button) and not for navigation between blocks (a row or a next move is the
navigation). `<button className="sa-btn sa-btn--pill" title={label}><span className="sa-btn__text">{label}</span></button>`

### Icon button — `.sa-icon-btn`
An icon-only action with a tooltip. Sizes `--sm` (24), `--xs` (20), `--lg` (36); `--framed` for a stepper's −/+;
`--rotate` for a chevron that turns; `[aria-pressed]` for a toggle such as is/is not. Always `aria-label` + `title`.
Not for anything whose meaning is not obvious from the icon alone. `<button className="sa-icon-btn" aria-label="Copy" title="Copy"><Icon icon="lucide:copy" /></button>`

### Chip — `.sa-chip`
One filter on a question: `__dim` (the dimension, quiet), `__text` (the member, truncates), an `.sa-icon-btn--sm` to
drop it; `--not` for an exclusion. Chips live on the `.sa-question` line. Not for a state word (that is a pill).
`<span className="sa-chip" title="Pillar is CEC"><span className="sa-chip__dim">Pillar</span><span className="sa-chip__text">CEC</span>…</span>`

### Pill — `.sa-pill[data-state]`
A state word inside a table cell: ok / warning / critical (RAG words map through `rowStateOf`). Not for a filter.

### Badge · Dot · Avatar · Kbd
`.sa-badge` a step number in its accent (`style={{ background: ACCENT[accent] }}`); `.sa-dot` a status light;
`.sa-avatar` initials; `.sa-kbd` a key. None carries free text.

### Input · Field · Stepper — `.sa-input`, `.sa-field`, `.sa-stepper`
`.sa-input` (`--sm`, `--num` right-aligned tabular, `--text`); `.sa-field` = label + input; `.sa-stepper` = label,
framed −/+ buttons, a value. Defaults: an input commits on blur or Enter; a stepper commits on each click (rule 9).
Not for choosing from a list (use Select). `<label className="sa-field"><span className="sa-field__label">hard</span><input className="sa-input sa-input--sm sa-input--num" /></label>`

### Select — `components/ui/Select.tsx`
The one dropdown: an ARIA combobox with a search row, keyboard navigation, `variant` `field` | `chip` | `cell`,
`emptyLabel`, `allowCustom`, `lead`, and for options that come from elsewhere `onQuery` (debounced) + `loading`;
`autoOpen` for the second step of a two-step choice. Defaults: closes on choose and commits on choose; the trigger
truncates with `title`; the popover follows rule 10. Not for choosing several (MultiSelect) and not for a yes/no
that is better as two buttons. `<Select variant="chip" label="By" value={by} onChange={…} options={[{ value, label }]} emptyLabel="The whole" />`

### MultiSelect — `components/ui/MultiSelect.tsx`
Several from a long list with groups (`groups`, `groupsLabel`) and an "all" choice (`allLabel`); `value`/`onChange`
edit a draft, `onOpen`/`onClose` bracket it — pair with `useDraft` so one move is sent on close (rule 9). Count and
Clear are in the popover foot. Not for a single choice. See `WindowControl.tsx` (`Months`).

### Toggle group — `.sa-toggle` / `ViewToggle` / `useOneView`
A radiogroup of icon buttons: `ViewToggle` for how a section is drawn — "table | chart ▾": the table first, the picture
second, further pictures behind it — `.sa-toggle__btn--text` for short word presets (30 / 60 / 90). A view toggle is
display only (rule 12) and lives in a Section's `hoverActions`; `useOneView` (rule 20) gives a chart's section its view
and toggle, opening on the chart. Not for anything sent to the server.

### Card · Section — `.sa-card`, `components/ui/Section.tsx`
`Section` = a card with a head: `icon`, `accent` (sets `--accent`), `title`, `subtitle` (the one line under it; a
block's `says` fills it), `note` (right), `actions`,
`hoverActions` (rule 6), `footer`, `tinted` (+ `soft`) for a primary section. The body is one of `.sa-section__body`,
`__chart`, `__text`, `__scroll(--tall)`, a table, `.sa-dl`, `.sa-facts`; `__footnote` for a quiet last line. Title,
subtitle and note truncate with `title`. Not for a KPI (a tile) or a launcher (an action card).
`<Section icon="lucide:table" accent="series-1" title={t} note="81 rows" hoverActions={<ViewToggle … />}>…</Section>`

### KPI tile — `Kpi`, `.sa-kpi-grid`
`label`, `value`, `foot`, `accent` (from `STATE_ACCENT[state]`), `loading`, `onClick`. A small uppercase label, one big
figure in its meaning's colour, one line under it; with `onClick`, an arrow, and a border (never a lift or a shadow)
when pointed at. Label truncates with `title`, the number never does (`--tile-w`), the foot wraps. Grid: as many tiles
as fit at `--tile-w`. Not for two numbers.

### Table — `.sa-table`
Heads `th.l` (text) / default (figures right) / `.c`; sortable heads `th.is-sortable` + `.sa-table__head(--figure)`
+ `.sa-table__sort`; `tr.clickable` opens a child; `tr[data-state]` washes warning/critical; `td.wrap` for a cell
that should wrap; `--grid` with `td.cell[data-state]` and `.sticky`. Cells truncate and carry `title`. Wrap the table
in `.sa-section__scroll` (its own scroll, rule 8). `.sa-pager` beneath when paged. Sorting is client-side and says so.

### Skeleton · Spinner · Empty · Alert · Toast
`.sa-skeleton` (`Skeleton`) while a figure is on its way; `.sa-spinner(--lg)`; `Empty` with a `height` (`.sa-empty`) when there is
nothing to show — a sentence, never a blank; `.sa-alert` when something failed inside a block; toasts via
`notify(text, 'refused' | 'error' | 'note')` for a refusal, an error, a note — never for a success that is visible.

### Definition list · Facts · Words · Hash
`.sa-dl` (`--tight`) key/value rows inside a section; `.sa-facts` two-column label/value pairs (a record);
`.sa-words` + `.sa-word` names as tags (truncate + `title`); `.sa-hash` a definition hash (breaks anywhere).

### Action card · Sub card — `.sa-action-card`, `.sa-sub-card`, `.sa-sub-grid`
Launchers: an icon tile, a title (truncates), a line (wraps), a call to action. For a Home, never inside an answer.

### Disclosure — `.sa-disclosure`
A quiet line that opens more ("About these numbers"): summary with a chevron and meta, a panel card beneath.

### Closed table — `ClosedTable`, `.sa-closed`
A table's one line while closed (rule 21): a chevron, the title (truncates), "· N rows"; a hairline above. Opens in place.

### Filter row — `Filters`, `.sa-filters`, `.sa-filter[data-size]`
The step's filters (rule 19), on one grid of `--filter-slot` slots; `__label` above each dropdown; `__end` holds
Fewer/More, Break down by and Clear all. Drawn from a `filters` block the platform makes; never laid out by a program.

### Layout helpers
`.sa-stack(--3/--4)`, `.sa-row(--wrap/--tight)`, `.sa-grow`, `.sa-two-col(__span)`, `.sa-divider`, `.sa-busy`,
`.sa-step` (a program's step: its parts at once, `--part-gap` apart — rule 22).

## Charts — `Donut`, `StackedBars`
`StackedBars({ rows, labelKey, series[{ key, label, color: token, marker? }], format, onSelect, colorOf, channel })`:
horizontal bars, rounded ends, a `marker` series drawn across the row. `Donut({ slices[{ name, value, color }],
format, onSelect, channel, remembers, height })`: legend by size (rule 14). Both read `chartTheme()`; both point at
the same slice through `lib/highlight` when they share a `channel`. Colours in are resolved (`paint`, palette).

## Layout — the rooms
`.sa-app*` shell (topbar on a phone, sidebar drawer), `.sa-sidebar*` (`.sa-nav-item[data-active]`, `.sa-profile`),
`.sa-status` pill, `.sa-thread__column` > `.sa-thread__item` > `.sa-block` (`__head`, `.sa-badge`, `__title`,
`__subtitle`, `__tools`, `__body`), `.sa-separator`, `.sa-branchbar`/`.sa-branch`, `.sa-question` (the chips and
controls line), `.sa-next`, `.sa-track` (a case's steps: `Track({ steps[{ key, label, says, state: done | current |
ahead | skipped }], render })`, a step the caller can open wrapped by `render`), `.sa-skeleton-block`, `.sa-home*`.

## Block renderers — reference (`src/components/blocks/`)
All are pure: `({ block, onRow?, onRowWindow? }) => JSX`, registered in `index.tsx` (`RENDERERS`, typed so a missing
type fails `tsc`). Defaults every renderer inherits: a `Section` head with icon and accent; text fits its track;
`onRow` opens a child with a placeholder (rule 15); nothing here sends an `as`.
- `Kpis` — `.sa-kpi-grid` of `Kpi`; `state` → `STATE_ACCENT`.
- `Figure` — `.sa-headline` (number, compare line, because list).
- `Filters` — the step's filter row (rule 19), from the `filters` block the platform adds to a program's answer.
- `Bars` — one view at a time (`useOneView`, rule 20): `StackedBars` first, the table (`ChartTable`) one click away,
  and when `ringAllowed(block)` (rule 13) a `Donut` behind the ▾. `line` series → markers. First 30 rows charted, the
  note says so.
- `Trend`, `Pareto`, `Scatter` — their chart first, its table (`ChartTable`) one click away (rule 20).
- `Grid` — `.sa-table--grid` with a Grid/Table toggle and a pager at 40 rows.
- `Table` — closed until opened (`ClosedTable`, rule 21); sortable, paged at 50, `rowMove`/`rowWindow`/`rowState`,
  the sort footer.
- `Facts`, `Text`, `AboutBlock` (the sources block, from `app:about`).

## How to add a block type
1. `src/answer/blocks.ts`: add the shape to the `Block` union and a `case` in `readBlock` that normalises every field
   with a default (the server's JSON is untyped input; a missing field must not crash).
2. `src/components/blocks/<Name>.tsx`: a pure renderer on the primitives above — a `Section` and one body kind.
   Format values with `fmt(value, unit)`; colours through `ACCENT`/`STATE_ACCENT`; truncate + `title` per rule 8.
3. Register it in `RENDERERS` in `src/components/blocks/index.tsx`.
4. Fixture: add a block of the type to a recorded answer under `public/mock/` (or to `_stress.json` with long
   labels). Extend `src/test/render.test.tsx`: the fixture loop renders it; add an assertion for anything specific.
   Run the headless overflow pass (`node /tmp/f5-pw/check5.mjs` against `pnpm dev:mock` on :5199).
5. Add its entry to "Block renderers" above.

**Each control holds what belongs to it.** An assumption is a number a what-if turns (a rate, a share, a count of
weeks): the assume row shows only numeric assumptions, each a number field labelled by what it means, with its
default, and is absent otherwise. A grouping lives in the By control (a `day` calendar dimension is a `by` option,
never a filter). A comparison lives with the window: the range group ends with one "vs the period before" switch,
commit on choose, and the delta columns follow it. A capability may not declare a boolean or a grouping as an
assumption; the server refuses it. An enumeration is a `Select`; never a free-text box for a typed value.

**Modifiers live inside the control they modify, never between controls.** The is / is not of a filter being
added sits in the member list's head (`Select` `head`, an `OpToggle`); an existing chip reads "Status is not
Closed" and its words open a small `.sa-dropdown` — is / is not / remove — committing on choose (a flip is one move:
pop then push). A lone operator button between two controls reads as joining them and is a bug.

## How to add a control (something that edits the question)
1. Decide its commit mode (rule 9): closes on choose → `Select`/preset; stays open → `MultiSelect` + `useDraft`;
   typed → an input committing on blur/Enter.
2. Put it on the `.sa-question` line in `src/components/block/Controls.tsx` (or `WindowControl.tsx` for a window
   kind); it receives `onEdit(ops)` and sends `Op`s only (see `QuestionOp`); never a value the server does not
   understand.
3. Its options come from the catalog (`capabilityOf(catalog, focus)`: `honours`, `by`, `window`, `assume`) or from
   the answer (`used.assumptions`); never hard-coded.
4. Test: a `Draft` test in `render.test.tsx` if it drafts; render it in the stress fixture with long labels.
5. Add its entry above.

## Tokens (names)
Colour: `--ink --muted --faint --on-accent · --surface --surface-subtle --panel --page --sidebar --line
--line-strong --scrim · --primary --primary-strong --primary-wash --primary-ring --hover-wash · --series-1/2/3 ·
--loss(-ink,-line,-wash) --warn(-ink,-wash) --win(-ink,-wash) --neutral(-wash)`. Space: `--sp-0 … --sp-16`.
Radius: `--r-xs/sm/md/lg/full`. No elevation: **no shadows and nothing raised** (the user, 2026-10-09) — a thing is set apart by its border; a thing
pointed at shows a border or an outline (focus rings stay), never a shadow or a lift. `--shadow-*` resolve to none. Type: `--font --font-features
--t-2xs…--t-2xl --w-* --lh-* --track-*`. Motion: `--dur-1 --dur-2 --dur-settle --ease --ease-out`. Layers: `--z-*`.
Sizes: `--sidebar-w(-collapsed) --topbar-h --column-w --popover-w --control-h(-sm,-xs) --tile(-lg) --tile-w
--filter-slot --part-gap`.
Breakpoints (documented, not variables): 640 / 768 / 1024.

## What changed from slob, and why
- Meaning colours as a triple (`--loss/--warn/--win` + `-ink`/`-wash`); amber `#f59e0b` (slob's `#d97706` read as
  orange). Every pill, wash, cell, KPI and slice goes through the same three.
- One radius scale (4 / 6 / 9 / 14 / full); slob's 5, 7, 10, 11, 12 kept only where named (logo, pie corners,
  action tile, block head).
- One spacing scale with half steps; one motion (`--dur-1`, `--dur-2`); card head heights agree (11 / 15).
- Series colours named as series (`--series-1/2/3`), not as domain words.
- Focus policy in one place; charts derive from tokens through `chart-theme.ts`; one height token per control size.
- No `content-visibility: auto` on blocks (a chart initialised in a skipped block measured 0×0); no negative margins.
- Rules 8–15 are new: text fits its track, commit on close, popover rule, display-only lens, ring for wholes,
  legend by size, placeholder-then-query.
- The step standard (the user, 2026-11-11, from slob's screens): filters computed and drawn by the platform (19), one
  view per section opening on its chart — the ring-and-bars pair is gone (20) — tables closed (21), a program's step
  shown whole (22), cards flat (no lift).


## The semantic components (components/semantic, design/semantic.css)

A screen composes these and writes **no CSS of its own**; what it needs that is missing is added to the component it
belongs to, on the tokens. Each is named for what it is:

| Component | Is |
|---|---|
| `Form`, `Field`, `Choices` | a form in a block: fields stacked, its actions at the foot; a sent form **locks** (it became a record) |
| `Receipt` | what a sent form, a decision or a change became: its facts as pairs |
| `RecordList` | records in rows: columns declared once (`align: 'end'` for figures, `wrap` for prose); a row may open the next step |
| `Status` | the state of a thing in one word: ok · attention · critical · running · neutral |
| `AttentionList` | what needs a decision, worst first; each item opens its step |
| `ActionBar` | the paths at the end of a block |
| `Empty` | nothing here yet, said plainly, with what will appear |

Theming is token overrides only: a `:root[data-theme="…"]` block redefining the colour, radius and type tokens; no
component changes.
