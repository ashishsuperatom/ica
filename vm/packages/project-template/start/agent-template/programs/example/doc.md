# example

What it shows, in one line. STATE (`example`):

- *Input:* `filter` — one key, or null for all. Set it (a click or words) and the view is worked out again.
- *Derived:* `data` — at most 100 rows for the filter in force, with the total and the count from the source, fetched once per filter (`data.basis`).

Functions:
- `run` answers from the slice.
- `row` answers a key clicked in the table: a new block below, the same view narrowed to that key.

Options (computed at each step, offered only where they hold):
- `everyKey` — with a filter in force: back to every key, saying how many more there are.
- `largestKey` — without a filter: the key that carries a third or more of the total, opened.
