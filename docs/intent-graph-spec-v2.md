# The intent graph — the full specification (v2, 2026-11-11)

One document for the whole intent graph: what it is for, what it holds, how a message travels through it, how it learns,
who owns what, what is built and what is not. It brings together the user's specification of 2026-11-01 (kept as written in
`docs/intent-graph-spec.md`, its decisions above it), every decision taken since, and what was built and learnt from
using it. Where a later decision replaced an earlier one, this says so. `docs/intent-graph.md` describes the code.

---

## 1. Why

Concepts without hierarchy were found by search — and search missed the right concept, or found a wrong one and polluted
the agent's context. **Domains** (a root of a tree of concepts, picked per question, loaded whole) gave determinism and
follow-up, but grew too big for agents to follow, could not answer across domains, had to be designed by hand before the
questions were known (an ontology by another name), and had **no memory**: the correct method a person gives, or the way
found to answer, had nowhere to live.

So **the intent graph is the backbone**: every question starts at an intent, and it is how the system is trained.
Domains stay as a high-level selector of shared system concepts (§4.1) and as things a node links to — **no question is
routed by a domain**. What answers a question is its **intent node** and the **concepts** that node stands on.

## 2. Principles

1. **An intent is what a person asked, exactly** — a question or a request, as one message: `q1 + q2 + a request` is one
   intent, never a combination of nodes that each hold a part. How it is answered depends on exactly what was asked.
2. **Identity is meaning, not path or words.** The same question reached from anywhere is the same node; the path lives in
   the ways between nodes. Match by meaning, exactly: **a duplicate node is acceptable, a wrong match is a bug.**
3. **Every answer is provisional.** What is kept is the **process** of getting the answer — not the answer, which changes
   as the world does. Consistency is not correctness: "we can be consistently wrong".
4. **Concepts are the shared library; the node is the memory.** Like a large program: every definition, calculation, rule,
   where things live and how tables join is a **concept**, atomic, said once, referenced by name — never copied into a
   node (referential integrity: correct a formula once and everything using it is corrected). The node keeps **its own
   path through them**: the steps, how the question's values apply, which concepts each step uses, how it is shown.
5. **Not a program.** A node is knowledge an agent answers from — what to do, what was done before — never fixed code that
   runs on its own. Small computations may live in it (its checks, its signals), but everything goes through an agent.
6. **What people say is accumulated, never taken as truth.** Every person's variation is kept; none replaces another;
   what is essential settles later — by approval and by consolidation.
7. **Nothing is deleted.** A wrong variant is deprecated; a wrong node is removed (a new version that says so) and can be
   restored; every version is kept.
8. **Only what must be deterministic is made so.** Matching candidates, parametrising, what is offered, what is recorded
   — deterministic. Whether a message is the same intent, a match, or new — the composer's judgment.

## 3. The intent node

One node per intent — independent, reachable from any other, never inside another. It holds:

| part | what |
|---|---|
| **canonical form** | the question with its values made placeholders (`open purchase order value by {period}`), and every other canonical form a question matched to it had |
| **words** | how it was first asked; its title, a short form (≤5 words), a category, and "intent" (what is asked for, in general terms) |
| **agent and permission** | the agent that answers at it when not the session's own (the builder, a project's agent), and the capability needed to be answered there (none: everyone in the project) |
| **variants** | what is learnt about answering it, **per owner** (§6): the concepts it stands on (by name), the way (the path, in words), how it is shown, and its **paths** — where the way divides by situation (`when` → `how`). Every version kept; a wrong one deprecated |
| **the project's way** | every person's variant, accumulated; one **approved** by a curator; none approved → the most represented, marked unverified |
| **ways out** | edges to next intents, per owner: **asked** (a person asked it after this node; counted; whether it was a real follow-up) or **suggested** (by the learner, of a kind — §7), each with an optional **check** and its history |
| **passages** | every question answered at it: the person's words, how it was understood, its values, the answer, who asked, which agent, how it got here (matched, made, same) |
| **experience** | what it has met, as data: cases, signals, scenarios, surprises (§8) |
| **marks** | stale (and why); removed (who, when, why) |

**Kinds by role.** *Entry* nodes are where sessions start — they are simply all the nodes people have asked; *next*
nodes are reached through ways out. Any node can be both: the list of everything asked is flat; hierarchies are
**indexes over it** (categories, the tree view), never one canonical hierarchy.

## 4. A message in a session

### 4.1 The agents, and what they know

Every session has a **composer** (fast; the entry point; it answers from intents) and an **analyst** (a strong model —
Claude Code on Sonnet 5 by default, changeable in the agent profile; made only when a new intent needs it). One runs at a
time. Beside them, **roles** the composer hands to (the **connector**: one per person, sets up what they need to read a
source — no intent is made for that), and **agents of intent nodes** (a builder; a project's own) for those allowed.

What each knows comes **from the graph, never the code**: its role concept (`role/composer`, `role/analyst`, …, made of
atomic concepts, naming its tools), then the concepts of the session's **domain** — a selector that today always returns
the project's default domain, holding the system concepts every intent shares (how answers are given). These are composed
**once per conversation** and kept with it. The platform's **default concepts travel with the engine release**: a
project's copies change only when its engine moves to a release bringing other defaults — never because the platform was
deployed (2026-11-11; this replaces "platform defaults apply at once", 2026-11-05).

Tools by role (a role's `tools`, editable like any concept; each agent is given and answered only for its own):
- **composer**: `find-intent`, `get-intent`, `send-to-agent`, `sources`, `find-schema`, `get-schema`, `query`, `experience`
- **analyst**: `sources`, `find-schema`, `get-schema`, `query`, `find-concept` (only it explores; only it gets the
  exploring guidance)
- **connector**: `connections`, `sources`

### 4.2 The steps

1. **The question spelled out.** A message often leans on the conversation ("break it down by plant"). The composer writes
   it as a question that stands alone — whatever it leans on said in it, nothing added — the **understood** question,
   kept apart from the person's words on every passage.
2. **Candidates — deterministic.** `./find-intent "<understood>"`: the platform parametrises it (dates, periods, years,
   codes, numbers, quoted words, and the names the project's questions carry — learnt) into its canonical form. A node with
   exactly that canonical form is the **only** candidate; otherwise pure text search (idf-weighted terms) gives at most the
   **best five** — what each is, not its knowledge.
3. **The decision — the composer's, by meaning** (guided by `intent/match`: the same meaning exactly, partial is never a
   match; and `intent/same`: a refinement of the answer stays in its intent):
   - **it continues the intent it is in, or is exactly one candidate** → `./get-intent <id>` gives that intent's knowledge
     (the person's variant, else the project's; what it has met) — and **the intent got is the one the answer is given at**
     (the last one got; only the intent it is in or a candidate can be got). It answers from it.
   - **none of them** → `./send-to-agent analyst current-question`: a new intent; the analyst answers.
   - **a source the person has not connected, or the project does not have** → `./send-to-agent connector
     current-question`: the person's connector sets it up; no intent is made or learnt.
   - **not a request** (a greeting, thanks) → it answers; nothing is got, no node.
   The decision is read from what the composer **did** (got, sent) — never from a line in its answer (2026-11-10; this
   replaces the `:::node` marker, whose text parsing lost a correct match and made a duplicate).
4. **Who answers.** Matched → the composer, with the intent's knowledge. New → the **analyst**, given the person's question
   (filled in by the engine — the composer never rewrites it), the understood question, and word for word the questions
   asked since it last saw the conversation (their answers are in the session's answer history; STATE and history are
   shared, read as needed). The composer **never makes nodes**; a question sent to the analyst makes one — unless it was
   sent from the intent the session is in, in a situation its knowledge does not cover: then it stays there. A node with an
   agent of its own → that agent, for whoever may be answered there (otherwise they are told which permission it needs).
   At a matched intent the composer also sets what it found beside what the intent has met (§8): far from anything met, it
   says what is different and hands the question to the analyst.
5. **Kept.** The passage at its node; the way from the node before, counted; a matched question's canonical form added.
   The answer carries its node (id, title, matched | made | same, the agent, whether the project's way it used is
   approved) and **at most three next intents** (§7), shown in their own section at the end of the step; a click asks one.

### 4.3 When an intent ends

A conversation is `Q → A → refine → A → refine → A → Q2 …`: refinements (another field, a total at the bottom, a
correction) **stay in the intent**; a question asking for something else is another intent, even about the same things.
The composer judges it at every message (`intent/same`). Learning does **not** wait for the intent to end (§5).

## 5. Learning from each answer

After **every** answer — a person content with the first answer never asks again — a **clone** of the conversation that
answered works out, in the background, what it taught: Claude Code's transcript forked (`--resume --fork-session`, run
headless, the fork deleted), pi's session copied, opencode's forked by its server; codex (no fork) a fresh agent given the
turns. The person is never kept waiting; the clone's work never enters the conversation. **One learner per session**:
answers that arrive while it runs are learnt by one more run when it finishes.

Per intent of the session with turns not yet learnt, the learner writes (most often nothing is new):
1. **What the node is** — title, short form, category, intent — for a node the analyst made in this session.
2. **The names in its questions** (a customer, a site — not dates, periods, numbers or codes), so later questions with
   other names reach the same canonical form.
3. **Keep or not** — a greeting or thanks keeps nothing.
4. **Follows or not** — whether its first question built on the answer before (decides whether an "asked next" counts as
   a real follow-up).
5. **New concepts** — atomic, written at once as the **person's own** in the composition graph (provisional, theirs to
   use), each that holds for everyone **suggested** for everyone (an admin decides). Proposed first; each searched among
   the person's and the project's concepts; one that says the same is **reused**, never written again. A concept states
   the rule, never who asked for it. Learnt concepts are never in a draft someone else publishes.
6. **Concepts used** — by name.
7. **The person's variant** — the way (path through the concepts), how it is shown, its paths — only when it differs.
8. **New next intents** — only where they make sense, none is fine, at most three a run (§7).
9. **Retired next intents** — ones that rarely make sense or are never taken, with why.
10. **Experience** — signals, this run's case, scenarios (§8).

**Learning goes to the person's intent only** (2026-11-05): how a person wants it shown here ("in lakh"), or a rule for this
question, is theirs for this intent — nothing is taken further until consolidation decides. Nodes answered by an agent of
their own (builder, connector) are not learnt from.

## 6. Ownership — whose knowledge

Owners, down a tree: **Organisation → Project → Group | User.**
- **User**: every variant, case and preference starts with a person (their data, their access). A person with no variant of
  their own answers with the project's way, and their own grows from there.
- **Group**: by some rule — **planned**, not built.
- **Project (global)**: never used directly — the accumulation of everyone's variants. **Approved** by a curator
  (`project.curate`, its own capability): one person's variant becomes the project's way. With none approved, the most
  represented is used, marked **unverified**, and the agent treats it as a reference, not a rule. When every variant says
  the same, there is no disagreement.
- All owners' versions of one intent live **in the same node** (the same Durable Object): one node, many variations, one
  currently selected.
- Experience **rises** — from person to group, project, organisation — when the same signal and compatible expectations
  hold across several people's cases (judged by the learner, approved like a way) — **planned**.

## 7. Next intents

A node's ways out are **active**: each can carry a **check** — an option function (`docs/program-contract.md`, Options:
the same contract and runner as a program's options; one mechanism for "what next") — given the step's STATE, its answer
history (each answer's tables, by file name) and read-only services (a query), time-limited, that says whether that next
intent makes sense **after this answer**, and with what label. A check that is late or fails offers its question anyway
(the failure to the operators and into its history); only a check that ran and said no leaves it out.

**Kinds of suggested next intent** (all from the intent's purpose, sensible for anyone asking it, with any values):
- **interpolation** — what follows naturally: one step further on the same thing (a breakdown, the detail, another period)
- **extrapolation** — a different question the answer's data leads to
- **novelty** — a direction outside the data shown

**A pool that evolves.** Many per kind over time. After an answer:
1. **asked** ways that were real follow-ups first;
2. then for each kind, suggested ways ranked by `nextLikelihood = (held + 1) / (tried + 2) × (1 + taken)`, tried one after
   another — at most three per kind — the first whose check holds offered; one that failed three times in a row skipped;
3. then other asked ways, to fill the places;
4. **at most three** offered. Every check tried is kept (held, empty, failed); the learner sees that history and adds or
   retires.

Every way is tagged — asked by people, suggested by AI — with how often taken and its history, for provenance and tests.

## 8. Experience — what an intent has met

Beside its **way** (knowledge, in words), an intent keeps what it has **met**, as data to compute over — so an answer
unlike anything seen is noticed, and one like a situation met before is recognised. Nothing in it is about any one kind
of data: what to measure and keep is the learner's, per intent.
- **Case** — one run: its range, how it was worked out, its signals' values, its outcome's key figures, its scenario, and a
  surprise (why it is unlike what was met) or none.
- **Signal** — a quantity measured every time, chosen by the learner for the intent's purpose: why it tells situations
  apart, how it is computed, its kind, how its values are summarised.
- **Scenario** — a situation met, as a tree: what it is, its **expectation** (its signals' values), the path (`when`) that
  handles it.
- **Surprise** — evidence against expectation: one odd case stays beside the nearest scenario; a new scenario forms when
  surprises recur alike; two whose expectations became one merge. Known kinds of surprise are a platform concept
  (`experience/surprises`, editable); a new kind is named in a line, kept for the project, and promoted by consolidation.

**STATE and signals — the principle.** "If it is raining and the chair outside is red, a person takes an umbrella — because
of the rain, not the chair." A **signal** is a computation that says what really is the case; **STATE** is what maps
directly to what is done — which path is taken. Built: signals and scenarios per intent (the person's own), the paths a way
divides into. Planned: signals choosing the path deterministically, rising across owners (§6).

## 9. Seen and changed

- **The intent graph page** (user app and admin console): a **plain tree** — one line per intent, `[+] 01. TITLE …… 12
  answers`; a row opens to what was asked or suggested after it; deep down, the parents above fold into one line at the
  top, each a way back up; a loop shown once, never opened again. Beside it, the selected intent: what it is, how it is
  matched, who answers it, the project's way and each person's (**Approve**, a curator), its ways out with their checks,
  its answers and versions; **Change**, **Remove**, **Restore** for who runs the project.
- **Each answer** says which intent it was answered at, and offers its next intents.
- **sacli**: `sacli intent`, `intent show <id>`, `intent approve`, `intent remove --why`, `intent restore`,
  `intent surprises`, `specialists`.
- Read over HTTP from what the platform keeps — never the engine — so it shows while the engine is down.

## 10. Storage and consistency

- **One Durable Object per node** (`intent:<project>:<node id>`, ids `in-…`): the node (every version), marks, variants (per
  owner, every version), approvals, ways out (per owner, with checks and history), passages, experience (cases, signals,
  scenarios). **The ProjectDO** keeps the index: every node's canonical forms, search words, the concepts its variants use,
  its agent and permission, stale, answers; the ways between nodes; the names questions carry.
- **Staleness**: a knowledge version published marks stale every node whose variants use a changed concept (or a composite
  or domain made of one) — why, which version. Nothing is changed for it.
- **Removing** a badly formed node: by who runs the project, saying why; never matched, offered or answered at again; its
  history kept; restorable. The platform's own nodes stay.

## 11. What is built, what is not

| | status |
|---|---|
| Every message to the composer; the understood question; canonical form; exact-or-top-5 text candidates | **built** |
| The decision by tools (`get-intent`, `send-to-agent`), the answer given at the intent got | **built** (2026-11-10) |
| The analyst per session (Sonnet 5), the hand-off with fixed terms, the questions it missed | **built** |
| The connector hand-off (no intent made) | **built** (2026-11-10) |
| Learning after every answer, one learner per session, clones for every harness | **built** |
| Concepts proposed, searched, reused; the person's own; suggested for everyone | **built** |
| Variants per person, the project's way, approval (`project.curate`), most represented unverified | **built** |
| Next intents of three kinds, checks as option functions, the evolving pool, ≤3 offered | **built** |
| Experience per person: cases, signals, scenarios, surprises, known and new kinds | **built** (person level) |
| Removing and restoring a node; staleness on publish | **built** |
| The tree UI | **built** (2026-11-11) |
| Defaults travelling with the engine release | **built** (2026-11-11) |
| A small semantic model beside the text search | **not yet** (decided: text only for now) |
| Group intents | **planned** |
| Experience rising (person → group → project → organisation) | **planned** |
| **Consolidation** (System 4, offline, weekly): merging duplicate nodes, settling variants and paths, parametrising, promoting new kinds of surprise | **planned** |
| Telling a user-specific path from a project-wide one, deterministically | **open** |
| An intent's sources, judged by the learner (which sources and tables were really needed) | **planned** |
| Signals choosing a path deterministically (STATE → path) | **planned** |
| The composer handing work to a person's cell (long work, isolation) | **planned** (the cell is parked: `docs/cell-engine.md`) |

## 12. Known issues (2026-11-11)

- **Next-intent checks that read the answer's tables may never hold** — Procurement's RFQ checks ran 3–5 times, held 0;
  checks that query the source held. Whether an answer's tables reach `ctx.history[].data` needs looking at.
- **Duplicates from the old decision line** (before 2026-11-10) remain where a correct match was lost — e.g. Procurement's
  `in-mwaruzty9clcol` and the next intents suggested after it — for removal by who runs the project (or consolidation).
- `sacli intent --json` (the whole graph) leaves out each way's check; `sacli intent show <id>` has them.
- The engine does not yet log whether it handed its project new defaults.
