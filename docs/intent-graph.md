# The intent graph

Rebuilt 2026-11-01 from the user's specification (`docs/intent-graph-spec.md`, with the decisions taken with it). The
whole specification as it stands — vision, decisions, what is built and planned — is `docs/intent-graph-spec-v2.md`. The
earlier thinking is in `docs/intent-and-world-model.md`.

> **Words (2026-11-16):** what an intent keeps about answering it is its **method** (once called its "way", and in the code
> its "variant"): its steps, as pseudocode — SQL with the real names, code, words — with what varies in `{curly brackets}`;
> the concepts it stands on; how it is shown; where it branches; the programs it runs (set by the engine from what ran).
> Each person has their own; one is approved as the project's. `sacli intent method <id> <file>` writes one by hand — a
> proposal of one's own, or the project's at once for someone who curates it.

## What it is

The intent graph is the backbone: every question starts at an intent, and it is how the system is trained. Domains stay
in the composition graph, but no question is routed by one any more; concepts are what an intent's answers stand on.

An **intent node** is one thing people ask for, exactly as they asked it — `q1 + q2 + a request` in one message is one
node, never a combination of others. It holds:

- its **canonical form** — the question with its values made placeholders (`how many trips were completed in {period}`)
  — and every other canonical form a question matched to it had; the words it was first asked in; its title and intent;
- the **agent** that answers at it when it is not the session's (the builder, one the project made), and
  **who may be answered there** (a capability; none: everyone in the project);
- its **variants** — what is learnt about answering it, per person (`user:<id>`): the concepts it stands on (by name —
  the composition graph is the atomic knowledge base; never copied), the way to answer it (in words, not a program), how
  it is shown, and its **sub-paths** (where the way divides by the situation). Every version is kept; a wrong one is
  deprecated, never deleted;
- the **project's method** — every person's variant accumulated as a suggestion; one **approved** by a curator
  (`project.curate`); with none approved, the most represented is used, marked unverified. Nothing a person says is taken
  as truth by itself: it is kept as their variation, and what is essential settles later. A person with no variant of
  their own answers with the project's;
- its **ways out** — edges to the next intents, per person: **asked** (a person asked it after this node; counted) or
  **suggested** (by the clone that closed the intent), each with an optional **check**: an option function
  (`docs/program-contract.md`, Options — the same contract and runner as a program's options) saying whether that next
  intent makes sense after this answer;
- its **passages** — every question answered at it: the question, its values, the answer, who asked, which agent answered.

## A message in a session

Every message is matched first by the **IntentMatcher** (engine `intent-matcher.ts`; decided 2026-11-17 — before, the
composer matched inside its own turn, and it began working before it had decided: a new question cost minutes before it
reached the analyst, and a match could not be measured on its own). It decides only *what* a message is; the engine routes
on its decision. Then two agents answer: the **composer** (fast) and the **analyst** (Claude Code on Sonnet 5; made only
when a new intent needs it). What each knows from the start is the graph's, never the code's: **its own domain**
(platform-types `ICA_DOMAIN`: `intent-matcher-domain`, `composer-domain`, `analyst-domain`; the learner, connector, builder and
workbench ICAs each have theirs) — picked by the ICA, never by the question. The composer's and the analyst's share how to
answer and how to read the data (`answering`, `working-with-data`); the IntentMatcher's and the analyst's share what a match is
(`intent/match`, `intent/same`); each adds its own. One answers at a time, in the session's one folder; each is told the
turns the other answered that it has not seen (the answer history and STATE are shared, read as needed).
**An agent's tools are those its domain's concepts reference** — `{{tools.data}}`, `{{tools.agent}}`… (the tool tree,
docs/programs-design.md); every agent has `./inspect`. The IntentMatcher's model runs with no tools. The composer has the data
tools, `experience` and `send-to-agent` — no intent search: it is given the intent. The analyst has the data tools and
the intent tools (`find-intent`, `get-intent`, `choose-intent`, `experience`), and decides a question's intent again
itself. Each agent is told only its tools, and the engine answers each only for them (its turn's ticket names the agent).

1. **The match — the IntentMatcher.** Its cases:
   - **exact**: the conversation's first message, whose canonical form (below) is one an intent was asked as — that
     intent, no model.
   - **model** (the profile's `intent-matcher`, by default pi · OpenRouter · deepseek-v4.1-flash): after the first message it
     spells the message out as a question that stands alone, from the questions asked before it in the conversation (each
     with the intent it was answered at; never the answers) — the **understood** question, kept apart from the person's
     words on every passage (`question` / `understood`). The intents are searched by those words (a spelled-out question
     with an intent's exact canonical form is that intent); then it decides among the intent the conversation is in, those
     found, and the intents that usually come next from it: **same**, **matched** (exactly the same thing, `intent/match`),
     **new**, or **none** (not a request). No decision (the model failed, or chose what it was not offered) is said as
     such and treated as new.
   Every decision is a `match` record in the session's log (message, understood question, decision, node, how, time,
   candidates) — what matching is measured by. Identity is by meaning, not by the path: the same question reached from
   anywhere is the same node; the path lives in the ways between nodes.
2. **Candidates, by text — deterministic.** The platform parametrises a question (dates, periods, years, codes, numbers,
   quoted words, and the names the project's questions carry — learnt by closing intents) into its canonical form. The
   node with the same canonical form, when there is one, is the only candidate; otherwise pure text search (its words,
   idf-weighted — no semantic search) gives at most the best five — what each is, not its knowledge.
3. **Who answers — the engine routes on the decision.** Same or matched, the intent has a method: the **composer**, given
   that intent and its method (the person's, else the project's, and what it has met) — **the intent it was given is the
   one the answer is given at**. It hands the question to the analyst when the method does not fit what it finds, or the
   answer is far from anything the intent has met (`./send-to-agent analyst current-question`; the engine takes it from
   the tool's line in the turn's own events, ends the turn and records a `handoff`). Matched to an intent with no method
   yet, new, or no decision: the **analyst**, at once (a `handoff` from the IntentMatcher). Not a request: the composer, in
   words — one that reads the data anyway goes to the analyst. A node with an agent: that agent answers, for whoever may
   be answered there (otherwise they are told which permission it needs). A question that needs a connection the person
   has not made is found while answering, and handed to their **connector**.
   The analyst is given the person's question, the understood one, and, word for word, the questions asked since it last
   saw the conversation (their answers in the session's answer history). It decides the intent again with its own tools:
   one it chooses (`./choose-intent`) is the intent the answer is given at; none chosen, the question is a new intent and
   the node is made then (the composer never makes nodes). It answers as the composer would.
4. **Kept.** The passage at the node (made when new), the way from the node before counted, a matched question's
   canonical form added to the node. The answer carries its node (`answer.node`: id, title, matched | made | same, the
   agent, whether the project's method it used is approved) and the **next intents** on offer — the node's ways out (the
   person's own first, asked before suggested) whose check holds — shown as the step's next moves; one is asked by a click.

## Learning from each answer

After **every** answer — not when an intent ends: a person content with the first answer never asks again — a **clone**
of the conversation that answered (`vm/apps/engine/ica/clone.ts`) works out, in the background, what it taught: Claude
Code's transcript forked (`--resume <id> --fork-session`, run headless, the fork deleted), pi's session file copied and
deleted, opencode's session forked by its server; codex (no fork) gets a fresh agent given the turns. **One learner per
session** (`intent-learn.ts`): at most one clone runs at a time; answers that arrive while it runs start nothing more, and
when it finishes it runs once again over everything new since it began — most often it is quick, and runs once per
answer. Each run takes every intent of the session with turns not yet learnt from (`sessions/<sid>/intents-learnt.json`),
in one clone (two turns: it proposes concepts; each is searched among the person's and the project's concepts, and in a
second turn one that says the same is reused, never written again) — given what each intent stands on now — and keeps per
intent — like a large program, what many questions share lives once in **concepts** (every
definition and calculation, where each thing lives, how tables join, the business's rules: correct a formula there and
everything using it is corrected), and the intent keeps **its own path** through them (the steps, how the question's values
are applied, which concepts each step uses — so loading an intent's concepts answers it again for any period, customer or
value; what the person asks of how it is shown is this intent's, theirs — nothing is taken further until consolidation
decides): new atomic concepts as the person's own in the composition graph (each that
holds for everyone suggested for everyone — an admin decides), the person's variant (only when it differs), what the node
is (when the analyst made it in this session), the names in its questions, and **new suggested next intents only where they make
sense — none is fine, a kind may have none, never more than three a run** — — **interpolation** (what follows naturally: one step further on the same thing), **extrapolation** (a different
question the answer's data leads to), **novelty** (a direction outside the data shown). They belong to the intent, not to
one answer: each must make sense to anyone asking it, with any values, written from what the intent is for; each one's
check decides, each time it is answered, whether it makes sense then. Each is a node (found by its canonical form, else
made) with a way out carrying its kind and check. The suggested ones are a **pool that evolves**: every check tried after an
answer is kept as its history (made sense, empty, failed) beside how often people took it; after an answer the most likely
of each kind (`nextLikelihood`) are tried one after another — at most three, one failing three times in a row skipped — and
the first that makes sense is offered; the learner sees the history, adds new ones and retires weak ones. Asked ones are
offered first. An answer offers **at most three** next intents, in their own section at the end of the step. Most often nothing is new. Nodes answered by an
agent of their own (builder, connector) are not learnt from.

Consolidation — merging nodes that are the same intent, settling variants and paths — is offline and not built.

## Experience — what an intent has met (being built, 2026-11-07)

Beside its **way** (knowledge: text that names the concepts it stands on), an intent keeps what it has **met**, as data to
compute over — so that when it is answered again, an answer unlike anything it has seen is noticed, and one like a
situation met before is recognised. Nothing in it is about any one kind of data: what to keep, what to measure and how to
summarise it is the learner's, per intent; the platform keeps the JSON, by owner, and hands it back.

- **Case** — one run, as JSON: the data it covered (its range), how it was worked out, the values of its signals, its
  outcome's key figures, the scenario it belongs to, and a surprise (why it is unlike what was met) or none.
- **Signal** — something the intent measures each time, chosen by the learner: its purpose (why it tells situations
  apart), how it is worked out, its kind (a number, a distribution, a category …), how its values are summarised.
- **Scenario** — a situation met, as a tree (parent): what it is in a line, its **expectation** (its signals' values
  summarised as each signal says) and the branch of the way (`paths[].when`) that handles it. The platform counts its cases.
- **Surprise** — evidence against expectation: what grows the tree. One odd case stays beside the nearest scenario; a new
  scenario forms when surprises come back alike; two whose expectations have become one are merged. With few cases little
  is expected — an early surprise is not yet a new situation.

**Known kinds and new kinds — the same pattern one level up.** Inside an intent, cases form scenarios and a surprise
that recurs becomes a new scenario. Across intents, scenarios fall into **kinds**: (A) the **known kinds** of surprise —
a short list kept as a platform concept in the graph (`experience/surprises`: usual, drift, cycle, subgroup, scale,
concentrated, empty, threshold, combined, one-off, new-normal, rule-change, incomplete, stale, data-quality,
source-change, sources-disagree, restricted, method-branch, ambiguous, no-baseline, too-few), editable like any concept;
(B) a **new kind** — what none of them says. The list helps, never limits: the agent first asks, from the purpose, what
this answer is unlike, then whether a known kind says it; when none does it names the new kind in a line. New kinds are
kept for the project (`intent_new_kinds`: where met, how often; `sacli intent surprises`), and consolidation (System 4,
by a person for now) promotes the ones that recur into the known kinds.

Who does what. **The learner** (after every answer, the analyst's or the composer's clone) is told the purpose and what the
intent has met so far, and writes the run's case and any change to signals and scenarios (`intent:close` `experience`,
checked for its shape only). **The composer**, at a matched intent, is given its signals and scenarios (the cases are a
tool away: `./experience <intent>`, JSON, the asker's own); it answers with the intent's method and its tools, then sets what
it found beside what the intent has met — within one or near it, it answers; far from anything met, it says what is
different and hands the question to the analyst (its role, `agents/composer`). **Consolidation** (System 4, not built)
re-organises the tree: merges, splits, retires; an intent that keeps branching is a complex one.

Whose. Experience belongs to its owner, down the tree **Org → Project → Group | User**: cases always start with a person
(their data, their access); signals and scenarios start where they are learnt and **rise** — to the group, the project, the
org — when the same signal and compatible expectations hold across several people's cases (judged by the learner,
approved like a way). An agent reads from the nearest owner to the broadest. Built: the person's own (IntentDO `exp_cases`,
`exp_signals`, `exp_scenarios`). Not yet: rising, consolidation.

## Removing a node

A badly formed node — two intents in one, a wrong one — is **removed** by who runs the project, saying why: its next
version records who removed it, when and why. From then on it is never matched, offered as a next intent or answered at;
it drops out of the graph (listed apart as removed), stays readable with its whole history, and can be **restored** (its
next version again). Nothing is deleted. The platform's own nodes (for its agents) stay.

## Storage

- **IntentDO** — one per node, `intent:<project>:<node id>` (ids `in-…`), independent of every other: `node` (every
  version), `marks` (stale, passages), `variants` (per owner, every version, deprecated kept), `approvals`, `edges` (the
  ways out, per owner and tag, with checks), `passages`.
- **ProjectDO** — `intent_index` (every node: canonical form, search words, the concepts its variants use, agent, who
  may be answered, stale, answers), `intent_canon` (every canonical form a node was reached by), `intent_edges` (the ways
  between nodes, as each node keeps them, to read the graph at once), `intent_names` (the names questions carry, by
  kind), `session_agents`. Every project has the platform's node for its builder (`in-systembuilder`). Connecting a source
  is not an intent: the composer hands it to the person's connector (a role of the conversation, docs/connectors-plan.md 9e).

## Staleness

When a knowledge version is published, every node whose variants use a changed concept — or a composite or domain made
of one — is marked stale (why, which version). Nothing is changed for it.

## Agents of intent nodes

One of each per session, made when the session first reaches a node it answers at, kept for the session (its
conversation resumed across restarts — `sessions/<sid>/agents.json`; its folder `sessions/<sid>/work`). Superatom gives
every project the **builder** (`project.develop`: makes a program when asked; what it writes under `programs/<name>/` is
built as any program). A project's admins make others
(name, purpose, instructions, the capability needed, Claude Code or Codex) and give them to nodes. A turn ends when the
agent writes its note (`out/<turn>.md`).

## Where it is seen

- **Admin console → Knowledge → Intent graph**: a plain tree — one line per intent, each opening to what was asked or
  suggested after it (deep down, the parents above fold into one line at the top) — and beside it the selected intent: how it is matched, who answers it,
  the project's method and each person's (**Approve** for a curator), its ways out, answers and versions; **Change** for who
  runs the project. **Agents → Specialised agents**.
- **User UI → Intents**: the same views. Each answer says which intent it was answered at, and offers the next intents.
- **sacli**: `sacli intent`, `sacli intent show <id>`, `sacli intent approve <id> <user:id> <version>`,
  `sacli intent remove <id> --why "…"`, `sacli intent restore <id>`, `sacli specialists`.

## How it is reached

People read and change it over HTTP, from what the platform keeps — the engine is never asked, so it shows while the
engine is down:

| Route | Needs | |
|---|---|---|
| `GET /api/projects/<p>/intents` · `GET …/intents/<id>` | project.view | the graph; one node (variants, the project's method, ways out, passages, versions) |
| `PUT /api/projects/<p>/intents/<id>` | project.manage | a node changed (title, intent, its agent, who may be answered): a new version |
| `DELETE /api/projects/<p>/intents/<id>` · `POST …/intents/<id>/restore` | project.manage | a node removed (saying why) or restored — each a new version |
| `POST /api/projects/<p>/intents/<id>/approve` | project.curate | one person's variant approved as the project's method |
| `GET /api/projects/<p>/session-agents` | project.view | the agents, each saying whether the caller may use it |
| `POST …/session-agents` · `DELETE …/session-agents/<name>` | project.manage | the project's own, made or removed |

Screens call these through `control-plane/shared/api/user.ts` (anyone in the project), `admin.ts` (`projectAdminApi`:
who runs it; `projectCuratorApi`: a curator) — each given to a screen only for who holds it; sacli calls the same routes.

The engine uses the hub: `intent:find` · `intent:node` · `intent:pass` · `intent:close` · `intent:next` · `intent:agent`.

Code: `control-plane/superadmin/src/intent-do.ts`, `intents.ts`; `vm/apps/engine/intent.ts`, `intent-learn.ts`,
`intent-checks.ts`, `ica/clone.ts`, `session-seam.ts` (the decision), `app-seam.ts` (the two agents), `session-agents.ts`;
`vm/packages/platform-types/src/intent.ts` (shapes, canonical form, text search, the project's method);
`vm/packages/ui/src/components/semantic/IntentGraph.tsx`.
