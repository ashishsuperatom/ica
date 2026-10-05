# app-views

The project's own views (its application's capabilities) in a session. STATE (`view`):
- `question` — what the application looks at: `{ focus, where: [{ dim, op, value }], by?, window? }` in its own terms.
- `title`, `next` — set by the answer: the view's title and the application's next moves (`{ label, ops }`).

Functions: `run` asks the application for `question`; `move` with `{ ops }` applies one of its next moves; `row` with
`{ move, row }` follows a row clicked in one of its blocks. To show
another view, set `view.question.focus` (and its filters) and run.
