### AGGREGATE / COMPLEX LOOKUP

A number (or ranked set) computed over the whole population — sum / count / average / max-min /
top-N / group-by. Ground it in the model's **measure** (`base`/`column`/`agg`) and respect its
**additivity** (never SUM a non-additive measure). Compute in ONE query at the source; do not loop.
Return the FULL set, mark the highlighted rows, and when you cap to top-N include the TRUE total count.
