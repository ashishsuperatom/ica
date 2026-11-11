# example

What it shows, in one line. STATE (`example`):

- *Input:* `group` — one group, or null for all: the step's filter. Its choices are the groups that hold something in
  the current scope, worked out from the data (`groupOptions`), each with how many keys it holds and their amount.
- *Input:* `key` — one key, or null for all: set when a bar or a row is opened.
- *Derived:* `data` — at most 100 keys for the scope in force, with the total and the count from the source, fetched
  once per scope (`data.basis`).

Set an input (a click or words) and the view is worked out again.

Functions:
- `run` answers from the slice: the filter row, the headline figures, what stands out in words, the largest keys as
  bars, every key as a table.
- `row` answers a key clicked in the bars or the table: a new block below, the same view narrowed to that key.

Options (computed at each step, offered only where they hold):
- `everyKey` — with a key opened: back to every key in scope, saying how many more there are.
- `largestKey` — without a key opened: the key that carries a third or more of the total, opened.
