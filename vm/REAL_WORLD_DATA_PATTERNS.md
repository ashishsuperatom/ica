# Real-world data patterns & heuristics (cross-project)

Running against real production data, the **same kinds of messiness recur everywhere**. This
is the accumulated, GENERAL knowledge an understanding system should carry into *any* new
data source — not facts about one project. Examples are tiny and illustrative only; we
synthesize these patterns across all projects into the system's prior.

## The three regimes of an understanding-system

Automatically turning messy production data into a *runnable* model of how an organization works
decomposes into three regimes. Everything else in this doc is detail inside one of them.

**Build the model** — turn mess into meaning:
- *Discovery* — what data exists, where, live vs. dead, volumes.
- *Semantics* — what each table/column MEANS in business terms (names are cryptic, undocumented).
- *Identity / entity resolution* — the real entities (incl. composites) and how they're identified with
  no FKs, IDs-encoded-as-text, and duplicates. Identity is DISCOVERED, not given. **The hardest square.**
- *Relationships* — how entities actually connect given broken/absent keys; each edge with coverage/confidence.
- *Conventions & invariants* — implicit rules (fiscal calendar, status codes, "active") and the constraints
  the data must obey (the over-determination structure you later verify against).
- *Data-quality as content* — don't just *clean* the mess, *model* it: where it's dirty/incomplete/stale,
  carried first-class so the model knows its own weak spots.
- *Measures* — the canonical (often contested) way to compute the quantities that matter.
- *Representation* — the substrate that makes the model runnable/simulable ("a model I can run to see how it behaves").

**Use the model** — turn questions into answers:
- *Planning* — navigate the model to an answer; the reuse-vs-explore controller. Do NOT hand the agent the
  whole unit library and force compose-by-default — that anchors it onto the wrong path.
- *Verification / epistemics* — challenge every answer against something it did NOT produce the same way
  (over-determination): coverage %, integrity of each join, reconciliation to a control total, shape-fit to
  the question, magnitude prior. Confidence = how many checks it survived. Reuse a unit because it just
  PASSED these, not because it exists.
- *Autonomy / control policy* — when to act, ask, explore, or stop; the compute/uncertainty budget.

**Keep the model true** — the regime almost everyone under-invests in, and where robustness actually lives:
- *Grounding / feedback* — how the system learns it was right or wrong: control totals, downstream
  consequences, human corrections. Without this there is no robustness.
- *Consolidation / evolution* — how the model grows and self-corrects from usage; provisional → durable;
  conflict resolution; forgetting stale facts.
- *Human-in-the-loop* — the experts who already know the truth are a data source; reconciling with them is
  part of the model.

Two load-bearing takeaways: **robustness lives in "keep the model true," not in the abstractions** — a
locally-correct-looking answer sails through when nothing grounds it. And an abstraction earns generality only
by surviving DIVERSE, adversarial cases, never by fitting the ones that created it (so a single dataset can't
produce robustly general units on its own).

Most of the patterns below are **build the model** detail; the *Standing modeling principles* cover **use** and
**keep true**.

Each pattern: **Reality** (what tends to be true) → **Heuristic** (what the system should do)
→ **Probe** (a cheap first-contact check).

---

1. **A business identifier is not the obvious column.**
   *Reality:* a human-quoted "<thing> number" is usually a domain document number, often a
   *string*, living in a non-obvious column/view — not the surrogate key or the similarly
   named integer column (which may be too small to even hold it). e.g. a quoted 10-digit
   "receipt no." is a text field, not the `int` `*No` column.
   *Heuristic:* never trust the obvious-named column; locate an identifier by searching for
   the value and checking type/length/range; reconcile the human name with the physical one.
   *Probe:* take one real id the user would quote and find which column actually holds it.

2. **One real-world entity, many surface forms.**
   *Reality:* the same place/party/product appears under multiple spellings, aliases,
   abbreviations, legacy names, and "X / X DEPOT" variants; users type exactly one of them.
   *Heuristic:* keep a structured, per-column alias/synonym layer; expand a term to its
   variants and verify which exist before filtering; auto-detect near-duplicate dimension
   values.
   *Probe:* cluster the distinct values of key dimensions; eyeball for near-duplicates.

3. **Dimensions are exposed as text; the keys are hidden.**
   *Reality:* reporting views surface human-readable names but omit the underlying IDs
   (which sit behind extra joins).
   *Heuristic:* prefer ID joins, but be ready to match on *verified exact* text when only
   names are exposed; always verify the value exists in the exact column you'll filter.
   *Probe:* for each filterable dimension, check whether a stable ID is reachable.

4. **Real subsets are sparse and skewed.**
   *Reality:* plausible combinations legitimately have zero rows; activity concentrates on a
   few entities; "obvious" queries return nothing not because they're wrong.
   *Heuristic:* measure density before trusting "no results"; treat empty as a valid answer
   distinct from error; in dev pick data-bearing examples.
   *Probe:* count rows for the asked slice AND a broader one to tell "empty" from "broken."

5. **Categories live in free-text type names, with traps.**
   *Reality:* classifications are embedded in inconsistent strings (abbreviations,
   misspellings) and collide with other attributes — a bare number may mean tons in one name
   and wheels/axles in another.
   *Heuristic:* class resolution needs domain rules (match the right pattern, exclude
   look-alikes), resolve to the dimension's IDs, then verify; never naive-`LIKE` a bare token.
   *Probe:* list distinct type/category names; look for the same number meaning different things.

6. **Many "sources of truth" for the same fact.**
   *Reality:* a value appears across base tables, views, snapshots, dated backup copies
   (`*_2024_08_26`), and pre-aggregated report tables — which subtly disagree.
   *Heuristic:* identify the canonical source; distrust dated duplicates and report rollups;
   cross-check counts before adopting a source.
   *Probe:* find tables/views sharing a column; compare counts/recency.

7. **Dates are plural and meaning-loaded.**
   *Reality:* multiple date columns (entry vs document vs delivery vs updated), mixed types,
   nulls; "last 30 days" depends entirely on *which* date and *as of when*.
   *Heuristic:* choose the business-correct date column explicitly; handle nulls; pin `asOf`
   and timezone.
   *Probe:* enumerate date columns of the fact table and their null rates.

8. **Null / blank / zero / sentinel all mean different things.**
   *Reality:* empty string vs `NULL` vs `0` vs `-1`/"N/A"/"NA" carry distinct meanings.
   *Heuristic:* treat them distinctly; don't sum/average/`COUNT` blindly; learn the sentinels.
   *Probe:* sample distinct low/edge values of important measures and flags.

9. **Encoded / ID-only columns are meaningless without their master.**
   *Reality:* status as `statusid=30`, type IDs, bit flags — opaque until joined/decoded.
   *Heuristic:* join to master/lookup tables; build a code→label decode layer.
   *Probe:* find `*Id`/`*statusid` columns and locate their lookup tables.

10. **Units, precision, and currency vary and are often unlabeled.**
    *Reality:* amounts/weights with no unit column; mixed currencies; silent rounding.
    *Heuristic:* confirm units/currency before computing; format deterministically; never
    assume implied units.
    *Probe:* check ranges/outliers of measures for unit inconsistencies.

11. **Free-text fields carry structured intent.**
    *Reality:* notes/remarks/instructions hold the real info (references, exceptions) that
    isn't in proper columns.
    *Heuristic:* pattern-extract from text when needed; flag the missing column for modeling.
    *Probe:* skim high-cardinality text columns for recurring structured content.

12. **Schema sprawl and naming drift.**
    *Reality:* hundreds of tables/views, dated backups, `vw_*`/`tmp_*` proliferation, naming
    conventions that differ across modules.
    *Heuristic:* rank candidates by usage/recency; prefer curated views; ignore backups/temp.
    *Probe:* group objects by prefix/recency; shortlist the live, used ones.

13. **Structured data hidden in free-text fields → use a stateful mapping unit.**
    *Reality:* an attribute that should be structured (a class, code, reference) is encoded
    inside a free-text column with unknown, growing variety and inconsistent forms — e.g. a
    vehicle "class" buried in names like `CONTAINER-12W-32FT`, `14 WHEELAR OPEN TRUCK`.
    *Heuristic:* build a dedicated unstructured→structured resolution unit that carries
    STRUCTURED CONTENT — a catalog of the varieties seen in *this* system, seeded by up-front
    analysis — and EVOLVES it: each run also scans live and flags new encodings to merge.
    Resolve to IDs, recognize "same as seen before," accumulate. (Seed in source now; JSON/DB later.)
    *Probe:* enumerate distinct values of suspect text columns; seed the catalog; re-scan periodically.

14. **One display name, many distinct entities (the inverse of #2).**
    *Reality:* distinct real entities legitimately share a display name — two different parties
    both named "RAMESH DANGI", each its own `PartyId`. Grouping/counting/deduping by the *name*
    silently merges them and UNDERCOUNTS (e.g. 59 vendor ids collapse to 55 names).
    *Heuristic:* an entity is its stable key (ID), never its display string. `GROUP BY`/`COUNT
    DISTINCT`/dedupe on the ID; carry the name only for display, and disambiguate (suffix the
    id) when a name is shared. Treat name as a label, identity as the key.
    *Probe:* compare `COUNT(DISTINCT id)` vs `COUNT(DISTINCT name)` for any entity you tally;
    a gap means shared names.

---

## Standing modeling principles

- **Separate unstructured resolution from structured compute.** Detect entities → resolve &
  verify (alias/search, scoped by `table.column`) → compute on verified keys (IDs/exact
  values), never on raw user text. The detect/resolve loop is the agent's; units verify+compute.
- **Verify before computing.** Anything that smells like unstructured user text gets
  resolved and confirmed against the real data first.
- **Empty ≠ wrong.** Always distinguish "no data" from "bad query."
- **Verify joins from the data, not from authority.** Domain confirmation is usually
  unavailable. Confirm a foreign-key/join by *cross-relation*: join it and sanity-check that
  the brought-in values are plausible and counts line up (a "vibe check"). Adopt the
  best-supported interpretation and proceed — correctness is provisional.
- **Units are revisable by archive-and-remap, not in-place edits.** When feedback shows a
  unit's logic/joins are wrong, author a NEW (immutable) unit; the concept remaps to it and
  the old unit is archived. This is the whole point of unitizing computation — it makes the
  system correctable without breaking running history.

## Onboarding probes to build

- A portable first-contact probe per new source: candidate ID columns, alias/near-dup
  clusters per dimension, per-entity density, text-only-vs-ID dimensions, date-column
  inventory, code/lookup tables, live-vs-backup object shortlist.
- Seed the per-project alias/`search` dictionary from detected near-duplicate clusters.
