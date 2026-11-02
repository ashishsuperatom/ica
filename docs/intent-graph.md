# The intent graph

Rebuilt 2026-11-01 from the user's specification (`docs/intent-graph-spec.md`, with the decisions taken with it). The
earlier thinking is in `docs/intent-and-world-model.md`.

## What it is

The intent graph is the backbone: every question starts at an intent, and it is how the system is trained. Domains stay
in the composition graph, but no question is routed by one any more; concepts are what an intent's answers stand on.

An **intent node** is one thing people ask for, exactly as they asked it — `q1 + q2 + a request` in one message is one
node, never a combination of others. It holds:

- its **canonical form** — the question with its values made placeholders (`how many trips were completed in {period}`)
  — and every other canonical form a question matched to it had; the words it was first asked in; its title and intent;
- the **agent** that answers at it when it is not the session's (the builder, the connector, one the project made), and
  **who may be answered there** (a capability; none: everyone in the project);
- its **variants** — what is learnt about answering it, per person (`user:<id>`): the concepts it stands on (by name —
  the composition graph is the atomic knowledge base; never copied), the way to answer it (in words, not a program), how
  it is shown, and its **sub-paths** (where the way divides by the situation). Every version is kept; a wrong one is
  deprecated, never deleted;
- the **project's way** — every person's variant accumulated as a suggestion; one **approved** by a curator
  (`project.curate`); with none approved, the most represented is used, marked unverified. Nothing a person says is taken
  as truth by itself: it is kept as their variation, and what is essential settles later. A person with no variant of
  their own answers with the project's;
- its **ways out** — edges to the next intents, per person: **asked** (a person asked it after this node; counted) or
  **suggested** (by the clone that closed the intent), each with an optional **check**: an option function
  (`docs/program-contract.md`, Options — the same contract and runner as a program's options) saying whether that next
  intent makes sense after this answer;
- its **passages** — every question answered at it: the question, its values, the answer, who asked, which agent answered.

## A message in a session

Every session has two agents: the **composer** (fast; the entry point) and the **analyst** (Claude Code on Sonnet 5;
made only when a new intent needs it). One runs at a time, in the session's one folder; each is told the turns the other
answered that it has not seen (the answer history and STATE are shared, read as needed).

1. **Candidates, by text.** The platform parametrises the message (dates, periods, years, codes, numbers, quoted words,
   and the names the project's questions carry — learnt by closing intents) into its canonical form. The node with the
   same canonical form, when there is one, is the only candidate; otherwise pure text search (its words, idf-weighted —
   no semantic search) gives at most the best five.
2. **The composer decides — always.** Nothing skips it. It is given the intent the session is at and the candidates,
   each with its knowledge (the person's variant, else the project's), and decides by meaning, guided by the concepts
   `intent/match` (the same meaning exactly; partial is never a match) and `intent/same` (a refinement of the answer stays
   in its intent): `:::node same | <id> | new | none`.
3. **Who answers.** Same, or a candidate: the composer answers from that intent's knowledge. A question that is new — or
   the intent it is in, in a situation its knowledge does not cover — the composer sends to the **analyst** with its tool
   `./send-to-agent analyst "<the question>"` (its own instructions, the platform's — first in what it is told, before any
   concept) and its turn ends there. The analyst is given only that question: its own instructions say what it is, what a
   session is (its answer history and STATE, beside its folder) and what it writes; then the shared concepts (how to
   answer) and its own (`intent/new`). It answers as the composer would — the answer is presented the same way. A question
   sent to the analyst is a new intent, and the node is made then (the composer never makes nodes); sent from the intent
   the session is in, it stays there. A candidate the composer could not answer is never recorded as a match. A node with
   an agent: that agent answers, for whoever may be answered there (otherwise they are told which permission it needs). Not
   a request: answered, no node.
4. **Kept.** The passage at the node (made when new), the way from the node before counted, a matched question's
   canonical form added to the node. The answer carries its node (`answer.node`: id, title, matched | made | same, the
   agent, whether the project's way it used is approved) and the **next intents** on offer — the node's ways out (the
   person's own first, asked before suggested) whose check holds — shown as the step's next moves; one is asked by a click.

## Learning from each answer

After **every** answer — not when an intent ends: a person content with the first answer never asks again — a **clone**
of the conversation that answered (`vm/apps/engine/ica/clone.ts`) works out, in the background, what it taught: Claude
Code's transcript forked (`--resume <id> --fork-session`, run headless, the fork deleted), pi's session file copied and
deleted, opencode's session forked by its server; codex (no fork) gets a fresh agent given the turns. **One learner per
session** (`intent-learn.ts`): at most one clone runs at a time; answers that arrive while it runs start nothing more, and
when it finishes it runs once again over everything new since it began — most often it is quick, and runs once per
answer. Each run takes every intent of the session with turns not yet learnt from (`sessions/<sid>/intents-learnt.json`),
in one clone turn, and keeps per intent — like a large program, what many questions share lives once in **concepts** (every
definition and calculation, where each thing lives, how tables join, the business's rules: correct a formula there and
everything using it is corrected), and the intent keeps **its own path** through them (the steps, how the question's values
are applied, which concepts each step uses — so loading an intent's concepts answers it again for any period, customer or
value): new atomic concepts as the person's own in the composition graph (each that
holds for everyone suggested for everyone — an admin decides), the person's variant (only when it differs), what the node
is (when the analyst made it in this session), the names in its questions, and **new suggested next intents — at most one
of each kind, three in all, each run, only where the pool needs them** — — **interpolation** (what follows naturally: one step further on the same thing), **extrapolation** (a different
question the answer's data leads to), **novelty** (a direction outside the data shown). They belong to the intent, not to
one answer: each must make sense to anyone asking it, with any values, written from what the intent is for; each one's
check decides, each time it is answered, whether it makes sense then. Each is a node (found by its canonical form, else
made) with a way out carrying its kind and check. The suggested ones are a **pool that evolves**: every check tried after an
answer is kept as its history (made sense, empty, failed) beside how often people took it; after an answer the most likely
of each kind (`nextLikelihood`) are tried one after another — at most three, one failing three times in a row skipped — and
the first that makes sense is offered; the learner sees the history, adds new ones and retires weak ones. Asked ones are
offered first. Most often nothing is new. Nodes answered by an
agent of their own (builder, connector) are not learnt from.

Consolidation — merging nodes that are the same intent, settling variants and paths — is offline and not built.

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
  kind), `session_agents`. Every project has the platform's nodes for its agents (`in-systembuilder`,
  `in-systemconnector`).

## Staleness

When a knowledge version is published, every node whose variants use a changed concept — or a composite or domain made
of one — is marked stale (why, which version). Nothing is changed for it.

## Agents of intent nodes

One of each per session, made when the session first reaches a node it answers at, kept for the session (its
conversation resumed across restarts — `sessions/<sid>/agents.json`; its folder `sessions/<sid>/work`). Superatom gives
every project the **builder** (`project.develop`: makes a program when asked; what it writes under `programs/<name>/` is
built as any program) and the **connector** (`project.connectors`: connects a source; its code is published through the
one door, and a new source's connection made for a person who also holds `project.data`). A project's admins make others
(name, purpose, instructions, the capability needed, Claude Code or Codex) and give them to nodes. A turn ends when the
agent writes its note (`out/<turn>.md`).

## Where it is seen

- **Admin console → Knowledge → Intent graph**, drawn as the composition graph is: columns — every intent, what was asked
  next after the one selected, what after that — and beside them the selected intent: how it is matched, who answers it,
  the project's way and each person's (**Approve** for a curator), its ways out, answers and versions; **Change** for who
  runs the project. **Agents → Specialised agents**.
- **User UI → Intents**: the same views. Each answer says which intent it was answered at, and offers the next intents.
- **sacli**: `sacli intent`, `sacli intent show <id>`, `sacli intent approve <id> <user:id> <version>`,
  `sacli intent remove <id> --why "…"`, `sacli intent restore <id>`, `sacli specialists`.

## How it is reached

People read and change it over HTTP, from what the platform keeps — the engine is never asked, so it shows while the
engine is down:

| Route | Needs | |
|---|---|---|
| `GET /api/projects/<p>/intents` · `GET …/intents/<id>` | project.view | the graph; one node (variants, the project's way, ways out, passages, versions) |
| `PUT /api/projects/<p>/intents/<id>` | project.manage | a node changed (title, intent, its agent, who may be answered): a new version |
| `DELETE /api/projects/<p>/intents/<id>` · `POST …/intents/<id>/restore` | project.manage | a node removed (saying why) or restored — each a new version |
| `POST /api/projects/<p>/intents/<id>/approve` | project.curate | one person's variant approved as the project's way |
| `GET /api/projects/<p>/session-agents` | project.view | the agents, each saying whether the caller may use it |
| `POST …/session-agents` · `DELETE …/session-agents/<name>` | project.manage | the project's own, made or removed |

Screens call these through `control-plane/shared/api/user.ts` (anyone in the project), `admin.ts` (`projectAdminApi`:
who runs it; `projectCuratorApi`: a curator) — each given to a screen only for who holds it; sacli calls the same routes.

The engine uses the hub: `intent:find` · `intent:node` · `intent:pass` · `intent:close` · `intent:next` · `intent:agent`.

Code: `control-plane/superadmin/src/intent-do.ts`, `intents.ts`; `vm/apps/engine/intent.ts`, `intent-learn.ts`,
`intent-checks.ts`, `ica/clone.ts`, `session-seam.ts` (the decision), `app-seam.ts` (the two agents), `session-agents.ts`;
`vm/packages/platform-types/src/intent.ts` (shapes, canonical form, text search, the project's way);
`vm/packages/ui/src/components/semantic/IntentGraph.tsx`.
