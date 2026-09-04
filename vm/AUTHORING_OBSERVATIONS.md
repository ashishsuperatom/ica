# Authoring observations — what agent-written programs actually do

Sibling to `REAL_WORLD_DATA_PATTERNS.md`. That one collects how *data* is messy; this one collects how
*programs we generated* drift from what we intended.

**This is a log, not a rulebook.** Nothing here has earned a change to a prompt, a contract or the engine. The
point of writing them down is to find out whether a CATEGORY exists: one instance is an anecdote and tells you
nothing about where the fix belongs, while five of a kind tell you whether it wants a prompt line, an example,
a check, or nothing at all. Acting on the first sighting is how a generic engine fills up with rules about one
dataset — and how a prompt grows to the point where nothing in it is read carefully.

So: add sightings freely, resist fixing. When a heading has several entries, that is the signal to decide.

---

## How these were found

A scan over the program corpus (42 programs, 2026-09-04) for values that should have been decided at run time:
literal dates, literal years, entity ids inside filters, and defaults. Worth re-running after a batch of new
programs; it is cheap and these are not visible by eye.

```
cd <workspace>/programs
grep -rnoE "['\"][0-9]{4}-[0-9]{2}-[0-9]{2}['\"]" */program.ts */units/*.ts     # frozen dates
grep -rnoE "(===|==|:) ?20[0-9]{2}\b"             */program.ts */units/*.ts     # frozen years
grep -rnE  "=\s*'?[0-9]{5,}'?|IN \(\s*'?[0-9]{4,}" */program.ts */units/*.ts    # an entity id in a filter
grep -rhoE "params\??\.[a-zA-Z]+ \?\? [^,;)]{1,60}" */program.ts */units/*.ts | sort -u
```

What that scan found clean, which is the more important half: **no entity ids baked into any filter, in any
program**, and no frozen years. Sentinel dates are used correctly — `running-late-projects` excludes a
`2010-01-01` placeholder *in the data* while comparing real dates against `${asOf}`, which is exactly right and
should not be mistaken for a frozen date.

---

## A default that is a VALUE rather than a convention

The parameter exists; its default freezes one asking's answer for everyone.

| seen in | default |
|---|---|
| `utilisation-below-target-week-pillar` | `params?.weekStart ?? '2026-06-08'` — a frozen week; run next month, still reports June |
| `pl-revenue-*` | `params?.accountNumbers ?? DEFAULT_REVENUE_ACCOUNTS` — one asker's GL account list |
| (same family) | `params?.budgetCategoryId ?? 5` |
| (same family) | `params?.excludedPillarTeam ?? 'Generic - Forecasting Resources'` |

The distinction, which the authoring prompt already draws: a default should say **how to choose** ("the current
week") and not **what was chosen**. It is being applied to time and not to things that look like configuration.
`limit ?? 10` is a convention and fine.

Note this is the SAME confusion the concept modeller had with `parameters.default`, where it recorded one
question's account list as the default. Two places, one misunderstanding — which is the sort of thing that
suggests the fix, when there is enough to justify one, belongs in how a default is described rather than in
either place separately.

*Instances: 4. Enough to name; not yet acted on.*

---

## Raw source vocabulary reaching a reader

Values that are meaningful inside the source system and noise to the person reading the answer.

| seen in | what appeared |
|---|---|
| `view.customer.canonical` | *"Ricoh NZ is an active customer (Customer-20. Won (Signed Contract))"* |

Traced fully: not a bug and nothing hard-coded. The per-source description recommends `BUILTIN.DF` for a
display value; `BUILTIN.DF` returns NetSuite's *decorated* form, which prefixes the record type (`Customer-`);
and `20.` is genuinely part of the status name in this account's own configuration. The program reported
faithfully what it was told to read.

Interesting detail: a sibling concept (`project lifecycle status`) already prefers joining `entitystatus.name`
over `BUILTIN.DF` and so gets clean names — but only because *job* statuses in this account happen to carry no
prefix, so that concept never had to learn the lesson, and its name would not surface it on a customer question.

If this recurs, the fix is per-source (the description that recommends the technique) or a concept — never the
generic engine, where a rule about one vendor's display values does not belong.

*Instances: 1. An anecdote.*

---

## Two fields that disagree, both stated as fact

A record's own STATUS and a separate `isinactive` flag are not the same claim, and a program that reads one
while printing the other can contradict itself in a single sentence.

| seen in | what it produces |
|---|---|
| `view.customer.canonical` | *"… is an **active** customer (Customer-**Inactive**)"* — 6 customers |
| (same) | *"… is an **active** customer (Customer-2X. Lost Customer)"* — 5 customers |

Counted on 2026-09-04: of ~5,456 customers, 11 have `isinactive = 'F'` while their status says inactive or
lost. The program is not wrong about either field; it reports both and reconciles neither.

THE REASON THIS ONE MATTERS: the same lesson is already recorded for a different record type. The
`project lifecycle status` concept says *"Do NOT use `job.isinactive` to judge whether a project is active — it
is unreliable (10k+ Closed projects still flagged isinactive=F)"*. The flag behaves the same way on customers,
and the customer view used it — because the concept that knows is named for projects and would not surface on a
customer question.

So this is not really a program-authoring drift at all. It is knowledge the system HAS, filed under a name that
stops it being found. Worth watching for more of the same shape — a lesson learned once and re-learned per
record type — because that points at retrieval rather than at prompts.

*Instances: 2 (jobs, learned; customers, not). The first category here with a second sighting.*

---

## Generalising a contract further than intended

The answer contract says a figure is `{label, display, value}` (a headline) and `{label, display, sub}` (a KPI
item). Told separately that a table cell *may* be an object, an agent emitted `{value, display, unit}` for an
hours column — consistent reasoning from the shapes it had been given, not carelessness. The renderer did not
know that shape and printed `[object Object]`.

Worth noting because the lesson is not "the agent got it wrong": it applied the house pattern to a new place,
which is what we want it to do. The contract had two vocabularies for one idea and had not said where the
boundary was. (Now: a cell is the value, the COLUMN carries presentation, because the column is what names it.)

*Instances: 1. Resolved by making the contract consistent, so it may never recur.*
