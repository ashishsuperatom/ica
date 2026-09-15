# Building a semantic graph

A model is built in the graph store, one operation at a time — never by editing a file. People and agents use the same
operations, through the same command-line tool, `semantic-graph` (`bin/semantic-graph`; in a project's shared workspace,
`./semantic-graph`, recording the agent as who made each change). The terms are defined in `CONCEPTS.md`.

## The store

The model lives in the project's SQLite file beside its memory (`semantic-graph.sqlite`), in these tables (one store can
hold several models, listed in `g_model`):

| table | holds |
|---|---|
| `g_node` | entities, calendars, facts, measures, attributes, conditions, equations — each with a stable id, its properties, and whether it is confirmed |
| `g_edge` | arrows: from an object to an object, with a role, a kind, and whether it may be empty |
| `g_binding` | where an object's rows are: the source, its statement or program, and the column of each arrow, attribute and measure |
| `g_program` | programs that produce an object's rows |
| `g_setting` | the model's settings (reporting currency, time zone) |
| `g_change` | every operation asked: who, when, why, where it came from, what it changed — or why it was refused |

Ids are what a question names: `Store`, `Sale.units` (a measure), `Store.opened` (an attribute), `Sale.store` (an arrow),
`condition:active store`.

The schema questions are checked against is **derived** from the store. Each accepted change is published as a new
version of the schema by hash, so every answer still names the exact version it ran on.

## Operations

Every operation is checked before anything is written. It is refused, with the reason, when:

- **it would duplicate** — a name, or a synonym, that already means something else in the model (unless the sharing
  is deliberate);
- **it would break the model** — the derived schema would have a problem it did not have before (a money measure with
  no currency, a grain that is not total, a condition on nothing);
- **it would leave something dangling** — removing a node something else refers to (an arrow into an entity, a
  condition a fact is kept to, a measure a weighted average is weighted by).

An accepted operation is written in one transaction with its change record.

| operation | what it does |
|---|---|
| `add-entity <Name>` | a thing with identity; `--members`, `--names`, `--description`, `--synonyms` |
| `add-calendar <Name> --level <day\|week\|month\|quarter\|year>` | a calendar level |
| `add-fact <Name>` | recorded events; `--history current` when the source keeps no earlier state |
| `add-arrow <Owner.role> <Target>` | a link; `--kind grain\|belongs\|as-of\|version\|rollup\|self`, `--partial` |
| `add-measure <Fact.name>` | `--unit`, `--kind flow\|stock\|value-per-unit`, `--aggregate`, `--currency <path>`, `--of`, `--weight`, `--versions`, `--over-time` |
| `add-attribute <Owner.name> --type text\|date\|number\|flag` | a value; `--members` for listed text values |
| `add-condition <name> --on <Object> --where <filters>` | a named condition |
| `add-equation <Object> <path> <path>` | two paths that must agree |
| `set <id> <property> <value>` | description, synonyms, members, names, defaults, kept-to, history, grain, unit, … |
| `rename <id> <new name>` | renames, and rewrites everything that refers to it |
| `remove <id>` | refused while anything refers to it |
| `promote-attribute <Owner.attr> <Entity>` | turns an attribute into an entity and an arrow to it, rewriting the conditions that used it |
| `bind <Object>` | where its rows are: `--source`, `--sql` or `--program`, `--key`, `--label`, `--columns` |
| `add-program <name>` | a program that produces an object's rows: `--produces`, `--reads`, `--code <file>` |
| `set-setting <key> <value>`, `set-conversion` | organisation settings; how money converts |

Reading: `overview`, `show <id>`, `dimensions <Fact>…`, `paths <Fact> <Object>`, `check`, `history <id>`, `changes`.
`prompt` prints the guide an agent is given to use the tool, written from the tool's own command table and versioned by
its content (`prompt --json` gives `{ version, text }`): wherever an agent needs it, take it from here rather than copying it.
Moving: `export <dir>` writes the model as files for review; `import <dir>` builds a model from such files, one recorded
operation per node.

Every operation takes `--by <who>`, `--reason <why>` and `--from <where it came from>` (a document, a concept, feedback),
kept in its change record, and `--json` for output a program reads.
