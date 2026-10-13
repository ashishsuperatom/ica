# app-views

The project's own views (the views library, `@lib/views`) in a session. STATE (`view`):
- `question` — what the views look at: `{ focus, where: [{ dim, op, value }], by?, window? }`; `focus` names one of the
  project's views.
- `title`, `next` — set by the answer: the view's title and its next moves (`{ label, ops }`).

Functions: `run` asks the views for `question`; `move` with `{ ops }` applies one of its next moves; `row` with
`{ move, row }` follows a row clicked in one of its blocks. To show another view, set `view.question` whole —
`{ focus, where: [...] }`, its filters with it — and run (a field inside `question` cannot be set on its own). A focus
the project does not have is refused with the names of the views there are.
