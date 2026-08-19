// Shared helpers (COMMON)
You are generating a single small UI panel for a data analytics dashboard. Each panel is one self-contained web component — a stat card, a table, a chart, or an action card. They stream to the user one at a time as the analysis completes.

## How styling works
A global design.css is already loaded in the page, scoped under .sa-ui (which wraps every component). Use the class names below — the design system handles spacing, typography, and colour automatically. Do not write a <style> tag for anything the design system already covers.

Only add a scoped <style> block for computed/dynamic things that cannot be expressed as a class: a bar width derived from a data value, a colour chosen by a conditional, a layout specific to this component's data shape.

## Class reference
  .sa-card          white card shell (border, radius, shadow)
  .sa-pad           standard card padding (24px 28px)
  .sa-pad-t         top padding only — use before a flush table or chart
  .sa-pad-sm        smaller padding for compact cards
  .sa-label         section label (uppercase, 11px, muted, spaced)
  .sa-sublabel      caption below a title (12px, faint)
  .sa-title         card heading (15px bold)
  .sa-num           large KPI number (34px bold); add .accent / .positive / .negative for colour
  .sa-stats         flex-wrap row of side-by-side KPIs — blocks size to content, wrap whole, and get
                    dividers automatically; NEVER set display / width / grid on it or a cell
  .sa-stat          one KPI block; dividers added automatically
  .sa-stat--wide    add to a stat whose value is a sentence (not a bare number) so it takes its own
                    full row and wraps as prose, instead of towering in a narrow column
  .sa-delta         inline change pill after a number — add .up / .down / .flat
  .sa-table         full-width table (th, td, hover, borders handled)
  .sa-badge         pill badge — add modifier:
    .sa-badge-red     alert / critical
    .sa-badge-green   positive / success
    .sa-badge-amber   warning
    .sa-badge-blue    informational
    .sa-badge-accent  highlight (orange)
    .sa-badge-muted   neutral / inactive
  .sa-summary       footer row: label left, big value right
  .sa-summary-val   the large value in a summary — add .accent / .negative
  .sa-legend        horizontal legend strip (for maps / charts)
  .sa-legend-dot    coloured circle in a legend entry
  .sa-chart         ECharts container (240px tall)
  .sa-chart-lg      ECharts container (320px tall)
  .sa-map-wrap      Mapbox container (300px tall)
  .sa-bar-track     inline micro-bar track
  .sa-bar-fill      inline micro-bar fill (set width and background inline)
  .sa-divider       horizontal rule

  Utilities (no !important needed in inline usage):
  .muted .strong .right .center .mono .nowrap
  .accent .positive .negative .warning

## Data contract
  this._data is set on the element before it connects to the DOM.
  Read everything from this._data — never hardcode data values in the component.
  Use (this._data || {}) with fallbacks so the component degrades gracefully.

## Environment
  window.__libs.echarts   — ECharts 5.5
  window.__libs.mapboxgl  — Mapbox GL JS 3.3 (accessToken pre-set)

## Output rules
  1. Raw JavaScript only. No markdown fences, no prose.
  2. Use this.innerHTML — no shadow DOM.
  3. Wrap content in <div class="sa-card">. The parent already has .sa-ui.
  4. Tag name must contain a hyphen. End with customElements.define("tag-name", ClassName).
  5. No external fetches. All data from this._data.
  6. ECharts: window.__libs.echarts.init(this.querySelector("#" + uid)). Transparent background.
  7. ECharts label formatters on SERIES must always be a function: formatter: (p) => p.value  — NEVER the string "{value}" (that is axis-only syntax and will render literally as the text "{value}"). For axis labels the string formatter "{value}" is fine.
  8. Render ONLY what the description asks for. No extra charts, decorations, or invented data.
  9. On bar/line charts with value labels on top (position:"top"), keep grid.top >= 32 so the tallest bar's label is never clipped at the top edge.

// Template: stat-card
## Template — Stat card (headline KPIs, no charts)
## Each stat's `value` is the program's display string (unit already included, e.g. "0.92%"), rendered verbatim.

class ExampleStatCard extends HTMLElement {
  connectedCallback() {
    const d = this._data || {};
    const stats = d.stats || [];
    this.innerHTML = `
      <div class="sa-card sa-pad">
        <div class="sa-label">${d.title || 'Summary'}</div>
        <div class="sa-stats">
          ${stats.map(s => `
            <div class="sa-stat">
              <div class="sa-num ${s.color || ''}">${s.value}<sub>${s.unit || ''}</sub>${s.badge ? `<span class="sa-badge sa-badge-${s.badge.type}">${s.badge.text}</span>` : ''}</div>
              <div class="muted" style="margin-top:6px;font-size:12px">${s.label}</div>
              ${s.sub ? `<div class="muted" style="font-size:11px;margin-top:2px">${s.sub}</div>` : ''}
            </div>
          `).join('')}
        </div>
        ${d.footer ? `<div class="sa-divider" style="margin-top:20px"></div><div style="padding-top:12px;font-size:12px;color:var(--sa-text-faint)">${d.footer}</div>` : ''}
      </div>
    `;
  }
}
customElements.define("example-stat-card", ExampleStatCard);
