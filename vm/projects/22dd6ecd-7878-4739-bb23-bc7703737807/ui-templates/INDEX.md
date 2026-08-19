# Component templates (this project)

- **stat-card** — 2–4 large headline KPI numbers side by side. Use for totals, counts, averages, key metrics.
  When: The answer has a small number of important aggregate values worth calling out prominently.
  Code: ui-templates/stat-card.js
- **table** — Rows of data with named columns. Supports inline mini-bar, badges, bold values, summary footer.
  When: The answer has a ranked list, breakdown by item, or multi-column structured data.
  Code: ui-templates/table.js
- **chart-bar** — ECharts bar chart. Vertical or horizontal. Supports stacked series, per-bar labels.
  When: Comparing values across a small number of named categories (branches, products, regions).
  Code: ui-templates/chart-bar.js
- **chart-line** — ECharts line chart. Smooth curves, area fill, multi-series.
  When: The data has a real time series — dates, weeks, months as the x-axis. Never use for categorical data.
  Code: ui-templates/chart-line.js
- **map** — Mapbox GL map with marker pins. Light style. Supports popup labels and colour-coded categories.
  When: The data has lat/lng coordinates — branch locations, delivery routes, regional data.
  Code: ui-templates/map.js
- **recommendation** — Action card — table of decisions with priority badges (High/Medium/Low), optional value column, summary footer.
  When: The answer includes recommended actions, next steps, or prioritised decisions.
  Code: ui-templates/recommendation.js
- **prose** — A short paragraph/sentence COMPUTED from the data (data-driven narrative). Reads this._data so it stays correct when the data changes.
  When: Any narrative that states specific values, names, or insights — use this instead of a plain text item, which would go stale.
  Code: ui-templates/prose.js