# The composition graph

One graph. Everything an agent knows at the start of a session is composed from it, deterministically, and
nothing else teaches an agent anything. It is editable, viewable, versioned to the change, and every path says who
changed it and why. It is what the semantic graph, the strategy graph, the intent index and the prompt files were
each trying to be from one side.

## What is in it

**Nodes** are of a few kinds, and every node is a piece of text or a file with a stable id:

| kind | what it is | example |
|---|---|---|
| `domain` | a bounded set of intents, with a name and the intents in plain phrases | weekly utilisation |
| `part` | one section of a domain's knowledge, typed by its role | definitions · source · rule · process · answers · examples |
| `function` | a script the agent runs to read or compute, with its usage line and an `inspect` (how it works, loaded only on demand) | `weekly.mjs <from> <to>` |
| `action` | a function that changes something outside — creates, sends, updates — with its usage, its inspect, what it changes, and whether it confirms first | `reassign.mjs <person> <project> <hours>` |
| `tool` | a shell command the agent may run, with its usage line | `query` |
| `setting` | a value a rule reads by name | utilisation threshold = −0.3 |
| `rule` | a statement with a context it holds in (user, group, condition) | "hours on a utilisation screen means utilised hours" |
| `representation` | how a unit, a dimension or a time is shown | hours to one decimal, weeks by their Monday |
| `identity` | the first line of an agent | "You are Superatom's agent for … at this organisation" |

**Names and hashes.** A node's content is stored by its hash; a name points at a hash, as the concept graph and the
semantic graph did. Renaming moves the pointer; editing makes a new hash the name now points at; nothing that was
ever composed can change under a session that holds it.

**Edges** say what belongs to what and in what order: a domain *has* parts, functions, tools, settings; a rule
*applies at* a domain, a part or a function; a representation *governs* a unit; a level *carries* nodes.

**Levels**: `global` (Superatom), `organisation`, `user`. A node lives at one level. Composition walks the levels
outward and inward: the organisation's definitions, the user's rules, the global representations, all in one
prompt, the more specific overriding the more general by name.

## Atoms and composites (decided 2026-09-28, next to build)

Two kinds of node only. An **atom** is one piece of knowledge — a definition, a rule, a threshold, a worked example,
a query, a program — text or a file, never references. A **composite** holds no knowledge: it names its children in
order (atoms or composites) and how to lay them out (bullets, numbered, worked). A section is a composite of atoms, a
domain a composite of sections, higher ideas composites of domains; layers come from composites naming composites.

Duplicates: exact ones vanish by hash; same meaning in other words is consolidated offline (find alike, keep one,
repoint every composite, record the merge); same name, different meaning is refused at write.

Names are hyphenated phrases that say the meaning — `red-week`, `utilisation-threshold`, `placeholder-budget`,
`worst-of-four-rag` — lowercase words joined by hyphens, never one bare word. Atoms carry no domain prefix, so they
can be shared; a composite may say its place (`weekly-utilisation-definitions`). A name points at one node: a new
meaning under a taken name is refused, with the existing node shown.

Agents write the graph by a short guide the CLI enforces: one idea per atom; search before you write (writing
existing content returns its name); name by meaning; composites carry no knowledge; every change says who, why,
from what; an atom is edited only to correct it — a new meaning is a new atom, and composites move to it.

## Composition

`compose(domain, who)` → the system prompt and the files for a session:

1. the identity line for the domain;
2. the domain's parts in their order, each rendered by its type (bullets, numbered steps, worked examples);
3. the rules that apply, most specific first;
4. the representations the domain's units need;
5. the usage lines of its functions and tools;
6. the files to place in the folder: the functions' scripts.

Same inputs, same prompt, byte for byte. A session keeps what it was composed with in its folder and never
recomposes; the next session gets the graph as it is then. Today everything is composed up front and packaged
into the session; knowledge loaded during a session, on demand, is a later addition to the same graph.

## The answer

The answer starts with a line `:::answer`.

## Versions, time and provenance

Every node's content is stored by hash, as the semantic graph's store already does. A change is a row: which
node, from which hash to which, by whom, why, from what evidence, when. That gives, with no extra machinery:

- **time travel**: the graph as of any moment is the last change to each node before it;
- **who changed what path**: the change rows along any edge;
- **diff of a session**: what a session was composed with against the graph now;
- **undo**: a change back to the previous hash, itself recorded.

Edits come from four writers, all through the same operation: a person in the editor, the analyst reading session
folders, the consolidation job merging duplicates, and the platform recording a learned default. Each is a `by`.

## Where it lives

A project's `knowledge/` directory today; the same nodes in the project's SQLite tomorrow, with the directory as
the export and the import. The CLI is the one write path (add-node, set, link, remove, each with `--by --reason
--from`), the same discipline the semantic graph had. Reading is `compose`, `show`, `history`, `as-of`.

## What it replaces, and what it keeps

Replaces: the question grammar as an agent surface, the semantic graph's schema as the source of definitions, the
intent index, the personas, the rules in prompts, the strategy-graph prototype. Keeps: the store mechanics
(hash, change log), the datasource manager, the transport, the host, the composer, the narrator.

## Order of work

1. The node kinds and the store, with the CLI and `compose`, reading `knowledge/` as it is now. Weekly utilisation
   becomes the first graph, unchanged in content.
2. History: changes with by/reason/from, `as-of`, `history`, `diff` against a session folder.
3. The viewer: the graph as a page, a node, its history, a session against the graph.
4. Levels and rules: organisation and user nodes, with the override by name.
5. The second domain, written against the CLI, and the picker from the domains' intents.
