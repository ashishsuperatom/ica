# example

What it shows, in one line. STATE (`example`):

- *Input:* `filter` — one key, or null for all. Set it (a click or words) and the view is worked out again.
- *Derived:* `data` — the rows for the filter in force and the total, fetched once per filter (`data.basis`).

Functions:
- `run` answers from the slice.
- `row` narrows to a key clicked in the table (in place: the same view, filtered).

Actions: `clear` lifts the filter.
