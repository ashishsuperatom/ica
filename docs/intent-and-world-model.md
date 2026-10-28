# Intent, decisions and the world model — design ideas (nothing built)

On 2026-10-28 every implementation of these ideas was removed, to be rebuilt from fresh as one system: the decision
memory (`vm/packages/decision`, the DecisionDO, later the WorldModelDO's experiences and recognition), the world model
(`vm/packages/world-model`, its engine adapter and journal) and the first intent package (`vm/packages/intent`). They had
been built one after another, each partial, overlapping the others, and nothing visible used them. What is kept is the
thinking: the user's words, the designs, and the lessons. The design of what gets built next starts here.

## What the system is for (the user's words, kept as said)
**The intent tree (the user, 2026-10-20 — being designed).** "To create an intent graph — not really graph, it's really a
tree." "One of the mistakes we could make is that we surface everything that the data can provide. We want to start from
intent and go through the path; the intent itself can be a tree, because there could be follow-up intents, and based on
different scenarios it can go a different path." "Because there could be duplicates in different paths, we do not
directly use it. This is just an index that points to actual real concepts. The concepts themselves are distributed in
other places, and referential integrity is still built using that." (Earlier, 2026-09-17: "the tree is not really that
big — we can get answers in less than 5 seconds"; "referential integrity is the most important part — if we don't get it
right we'll never be able to modify something, because there will be duplicates"; the agent suggests, a very
intelligent model consolidates from time to time, "consolidation itself is a step in the history, so nothing is ever
gone". 2026-09-28: "intent is everything and usage is everything — we should design the world with respect to the
usage." The decision-engine lesson: a tree whose nodes kept copies of knowledge drifted; nodes hold only statistics and
pointers, as MCTS statistics sit on a shared game tree.)

**One system, not many partial ideas (the user, 2026-10-20).** "How should one develop the world model and intent tree —
what's the linkage between the stable attractor and our intent tree, and before we had discussed the decision tree. What
about the process tree. We can't have too many kinds of ideas which are doing partial work — we need a unifying system,
implemented with an ideal structure, but with the current system." "This exists as a sub-system of the entire world of
AI agents and AI models being created — we have to play with the whole economy, otherwise we will get left behind:
whatever is unique to us, we excel there and improve there; whatever others are using and the direction that succeeds,
we want to be able to take advantage of. We are already doing this — the ICA is just a wrapper around claude-code and
codex and pi; when claude-code gets better, we also get better. But given that no one has an intent engine or a world
model that we can use, we have to build that ourselves."

**A canonical intent works only for the first question (the user, 2026-10-20).** "I tried this method, where I made the
intent canonical with params — like 'find <things> for <value>' — but this works only for a small area, the first
intent in a session. If we ask this question as a follow-up, as the 4th question, it doesn't work the way I want,
because it needs to be within the context of what we discussed in the 3 intents before this." "What we want is: the
session itself has an intent. Imagine a session as a tree — based on which node we are in, the intent has a different
meaning, or at least a different output. What the system does could have some standard thing for that intent, but
outside of that standard thing there is so much that can change based on the actual history." "We talked about
I → (STATE, ANSWER_HISTORY, CONTEXT) → NEXT_ANSWER. This idea is good, but it's ideal; I need an implementation of this
which works practically. It was also before we realised that the STATE we thought of as part of the model is actually
just some filters. That's not STATE. So more thinking or experimentation is required to get this right."

**The start intent, the hidden goal, and a STATE independent of the path (the user, 2026-10-21).** "This is also one of
the reasons I didn't like the block UI alone — I click on something and it takes me to a new block, and it's hardcoded in
the block itself. The blocks could be a correct representation of what they show, but in a session they don't make much
sense: based on what I click, it should produce a new block which depends on what we are actually trying to do." The
two most important things: "1. the start intent — the question the user starts with; 2. the goal of the session — they
can start from some intent but they will have a hidden goal they are trying to achieve."

What a person keeps doing at a step is remembered and shown to them upfront — "that's the decision model for the system
itself"; every sub-path taken is remembered, "and based on that next time we suggest them". The goal can turn out to be
any of several ends, decided only as the session goes. "We can't know what path they
take. They take some path through natural-language questions → that becomes the input to our builder agent, which
builds the node (here, a program) that answers the STATE the user is in." "I would really like a system where the STATE
is independent of the path. So we need some kind of compression of the session so far, so that we can call it a STATE —
and a way to know when we are already in the same STATE, which is difficult: how do you know it's the same, almost the
same, or different? This is a big problem, and a stable-attractor-like solution is required."

**The intent tree first (the user, 2026-10-21).** "We'll start from an intent. We'll first have an intent tree; the
intent tree is what we first work on, and from there we'll figure out." "How do we build an intent tree? They will keep
changing — it's an evolving system. How do I do it so that it settles? If there is some truth to the system, it should
settle. But how do we do that evolution?" "An organisation will have so many intents they can start with. It's a big
giant tree, and any question they ask, we should be able to match to some specific intent and give only that portion of
the intent tree to the chat agent, so that the agent knows what is possible, and then it can go and explore the intent
tree." "Here I'm still thinking about the starting point, the first intent. After that, things will change, because
state comes into the picture, and the state could be complex." A structured state (the current focus, a few goals)
could exist, "but it should not be dependent on that state — it could be almost anything, and the intents could work on
top of them." "Whenever we search for an intent, it should show us the tree highlighting that specific part — not
everything: imagine a tree with 1000 nodes; I search for something and get only the part I should focus on, and the
rest is compressed or hidden, expanded only to my view, whichever part the search found. I think that would be the
first starting point. And then we should be able to build this intent tree, and everything should be guided from here."


## 2026-10-21, later (discussion)
- The intent tree is a categorisation of intents — the direction someone wants to go — not a record of sessions; how an intent is answered depends on state and path and lives elsewhere. "Let's just get the first intent correct."
- Per project, not per organisation.
- Seeded with some defaults, but almost everything is grown: developers first create questions and set things up; an agent goes through everything available (the data sets) and creates intents; also the question path — questions asked become intents.

## 2026-10-21, later still (discussion)
- Each entry carries tags for how it came to be: generated by AI or by a person; reviewed by a person or by AI — "at least the separation between what was created by a human and what was reviewed by AI"; consolidation uses them.
- Not two trees (a categorisation tree and a session tree would "have issues"): "one evolving giant tree". One tree per user, holding all the questions they asked and every path they can take from anywhere; from those, the project's (global) one. A new user inherits from the project's. A person (e.g. in a role) who builds many paths: how to promote them to the project's — to be figured out.
- That one tree is the attractor tree discussed before; inside it, domains or concepts are reused (referential integrity), it can be modified, and programs are embedded in it.

## Why two kinds of intent (the user, 2026-10-21)
- Domains exist because concept search was slow and, worse, could miss the right concept or load a wrong one and pollute the context; so a question picks a domain and the domain brings all its knowledge — a template. Problems as it grows: too many concepts loaded whether used or not; a question linking to another domain is never reached; not decided by usage (only consolidation fixes it); hence the ability to search other domains too.
- Reason for intent as a CATEGORY: when things grow big, a tree that holds only meaning — the direction to explore — without loading everything; from the intent, load the whole domain or only the concepts that intent needs.
- Reason for intent as WHAT NEXT: depends on the state, the data, how the user wants the flow, the goal.
- Question: two different kinds, or one unified system?

## Bootstrapping, and "isn't the movement another tree?" (the user, 2026-10-21)
- A domain's list of concepts is curated by someone; it could also come from usage (100 sessions → which concepts were used → domains). But usage failed before: when the agent could not find the right concept, questions went unanswered or wrong, so there was nothing for usage to curate. Hence initialising and bootstrapping the domain is very important; only after that can usage take over.
- "If the intent is a tree of one kind, and moving from one place to another is kept as a history, isn't that another tree? Why say they unify into one tree — the way you explain it, they are two trees."

## Agreed in discussion (2026-10-21)
- Referential integrity is primarily about CONCEPTS — they define what is true in the organisation; intents only refer to them.
- Both are needed: "the file system is a tree of how the files are organised, but how we work on top of it and move from one place to another defines the task at hand." One set of intents; a meaning tree over them; the movement across them (a path per session, a web of counted transitions across sessions).

## Simplified (the user, 2026-10-21): STATE → OPTIONS
"It's getting complex; let's do this: we will only have STATE → what options we have (background agents will keep generating different options). And the first intent never starts from empty: it can have a state carried from when the user went to sleep and came back to work after some time. Even if it's empty, we start from a list of all possible starting options — which was anyway the StartIntent system." "It covers everything and, theory-wise, seems complete."

## Same state? (the user, 2026-10-21)
"I don't know the answer to that question, but one thing I know: I'll never do partial matches — that is where all the problems come from, whether something is matching or not. You said something about matching at a higher abstraction — a hierarchy of things. I don't know how to fit that, but normally I go for whether it's fully matching or not matching."

## 2026-10-21 — after the desk (user's words, kept)
- "this could work, the whole idea… in the simplest form, this definitely work."
- Two things were done from the sessions: domains made, and the home dashboard made. An agent could do both — create
  domains, or if not a domain then at least concepts.
- "we cannot have too many domains being created from every chart" → need a user memory system (remember) AND the
  domain system; open question: how much goes in the domain, how much in memory.
- "finally the user themselves know what they want"
- Correction: the split is not by content. "the UI and the way we want it to be represented could also be going to the
  domain because the user themselves could be admin who is really building it… the negotiation person… goes into
  memory. But the user who is building it… goes into the domain."
- Convergence: "we need some kind of control theory like system so that it converges to truth."
- "there has to be some truth decided by the organization or the project… some things they are in agreement and they
  just do it… how do you know what is really truth? Sometimes all we have is agreement and sometimes we mandate a truth
  for the project. So both should be possible."
- A modeler (like the old concept modeler), an intelligent model (claude-code), reads sessions and creates the state;
  append-only, can change, time travel.
- Using STATE: an answer gives ~3 options below. Level 1: a click puts a new question, the composer does it. Later: a
  click runs a pre-generated program — no AI, because it falls within the same state. The program must notice data it
  doesn't fit → back to the composer loop, given the intent and the states walked (not the whole answer history):
  "we are stuck, help us out" → new scenario / new state / a different path → another option below.
- "either it can be done by the coding agent or it can be done by a program… any point anything could happen… design
  it so that it is cohesive and it feels one single system"
- On 4: if earlier steps were done by programs, the composer needs that part of the history backfilled or it loses
  context — LAZY: while programs do the work with no AI, nothing is appended to the composer; only when it is needed.
- 2026-10-21: "let's build this and we'll experiment… if it works good then we'll progress further." (step 1 first)
- 2026-10-21 after testing composer-made options: an option offered something the workspace cannot do ("ask Leader
  Enterprises to refresh its quote" → "I can't contact suppliers from this workspace"). "it should not be giving a
  suggestion now — the suggestion really has to come as a separate part of a separate process, once the world model or
  the decision intelligence has been learned… in the beginning how can it give suggestion, it hasn't seen enough use
  cases." "every suggestion is also like a program… a quick program… should not affect anything else… just finds out
  whether that suggestion makes sense… bounded to the current state and the current answer history and the context… if
  it is a program then it will always be correct and if it doesn't make sense then that suggestion will not come."
- Options are ONE category: "we can have only one category of things, the programs one also and this one also. Finally,
  we have to just give them some options." One strip, at the end of the step, whatever offers them.
- 2026-10-21 options in the PROGRAM CONTRACT: "the suggestions or path that comes below every program is a fn — which
  takes the current STATE, the CONTEXT, the ANSWER_HISTORY, gives us valid options after doing computation — not
  predefined terms. So the options themselves are fns — as long as we do it that way the future agents or humans would
  be bound to build the proper way."
- Naming (2026-10-21): "They are not actually actions — actions are something we do to make some effect in the outside
  world. This is just what's the next available options for the user to explore. If we send an email — that's an action.
  If we make a delivery of some product through the API then that's an action. We haven't reached actions yet."
- THE GOAL (2026-10-22, user's words): "The user asks a question -> We add that to the Intent Graph at right place. Then
  for each node in there we try to find what are the paths any user can take (based on the data they have - or when
  external data-agent comes - on that data). This can happen constantly in the background - by long running agent. They
  keep looking at user questions and what they are picking from the UI and they keep expanding this graph. This
  computational graph can then answer question - can do automated reports, do counterfactual, can do simulations, do
  prediction and take action, and we will finally say we have understanding of the ORG."
  Known issues: 1. which state (node) are we in — partial match. 2. when to extend; multi-step extrapolation can go the
  wrong way — tell AI-generated paths (and how often used) from paths that came from user interaction.

## 2026-10-27 — what the system should do from the beginning (the user's words, condensed faithfully)
1. Someone (mostly an admin) asks; no data connectors → the composer opens the connector agent and sets up a connection
   (a built-in connector or a new one) just to answer; then still tries to answer the first question.
2. The DSI is not built → "wait, I am building the data sources index", with updates until done.
3. No domains/concepts → the composer can't answer → an analyst:ica, a long-running agent, gets a comprehensive answer
   valid for the scenario (as much time as needed); then looks at all domains and decides what new domain/concept to
   create; then the admin gets the first answer. Next questions the composer can answer.
4. The admin asks a 2nd question / follow-up; domain+concept exist so they get an answer — but maybe not the answer we'd
   give with more time. Behind the scenes another long-running agent sees how often a question is asked, decides which
   answers to make better, creates better concepts, may create programs (conditions met, user permitted).
5. The intent graph: basically a tree — could be a list of canonical questions ordered by high-level category; for each, a
   graph of nodes with STATE (signals + evaluators); long-running agents keep looking at the data and the current node,
   predicting what could be asked next and what to do — a graph that keeps expanding by exploration — without duplicating
   concepts. "At no point we are completely certain of the actual truth — we could be wrong — and a better definition or
   way appears — we want referential integrity: change in one place and know which other tree or path from the intent is
   stale — not update immediately but a stale flag — when the user comes to the same intent, update the changed nodes
   lazily." This is the decision engine. Hypothesis: understanding is really INTENT -> OUTPUT PROGRAM; cover every intent
   they normally ask → answer questions, predict, explain, take action.
- 2026-10-28 (not to implement now — "very important, otherwise it gets polluted with lots of concepts"): domains compose
  concepts so nothing is searched (search missed concepts); it doesn't scale — domains grow weaker/bigger, follow-ups
  cross domains, concepts duplicate across domains. Search failed because there was no decision node: if we knew what
  could be asked next there is nothing to search — put it in the context. Load the tree partially and lazily: 5, 7 or
  10 items at a time, loading more only when the conversation goes in a direction not anticipated.
  Focus: proactiveness, the decision node (= the world model), signals and evaluators — "we'll figure out as we go".

## 2026-10-28 — matching a question, and what settles (discussion)
- **The real problem is matching.** "The questions will be in natural language → if we try to match an existing node —
  but ideally should build a new node — that's where the problem happens. This is exploration vs exploitation. We need
  to know exactly that this intent matches an existing one completely (how do we decide it's a complete match). If we
  solve this problem everything else is simple."
- **No schema in front of the model.** "Every time we create some kind of domain-specific language — goal, subject,
  measure, constraint, horizon — what if the question doesn't match that? We are stuck by whatever you are deciding. I
  want the ability of the coding agent, the large language models, the AI agents deciding things, and eventually they
  should settle into some kind of structure. I don't want to start from some structure. I have done it multiple times and
  every time it fails."
- **A node gives only a direction; the agent writes the keys.** "In the node we can give some general direction but let
  the agent write keys outside of what we have given — so it can design based on each scenario and use case — we only
  give a very high-level system design and let it create the actual keys inside."
- **Early cost is the point** — paying to explore is how reliable nodes are built.
- **Scope as nodes and paths.** Global / group / user: "for the same situation we might do something else — or we encode
  that difference in the node — then it's just nodes and paths."
- **Variation settles offline.** "Even with the exact context, many times if an agent runs there will be some difference.
  The number of variations will expand until it settles, and we will have to solve it through offline consolidation."
- **Parallel duplicates are normal.** "Many parallel paths which are supposed to be the same, happening at different
  times — or two users doing the same thing at the same time because consolidation has not happened. They happen
  separately, but eventually we have to merge them, if required."
- **Context by neighbourhood** (see the 2026-10-28 note above): load the part of the graph around where the conversation
  stands, a few items at a time; more only when it turns somewhere unexpected — instead of domains composing everything.

### The approach tried that day (the `intent` package, removed with the rest)
- A node defined by **precedent**, not by fields: a body the agent wrote (its own keys), the questions it answered and
  was confirmed for (precedents), the ones that looked like it and were not, each with why (distinctions), the answers
  explored for it (variants), and how to compute it (its method: the queries that answered it).
- **Matching:** a shortlist (where people went next from here; nodes whose questions read alike) → a model judges whether
  a candidate answers the message COMPLETELY, against its body, precedents and distinctions (partial = no) → the message
  is also answered fresh several times → the candidate's method, adapted, is run on the data → a model judges whether it
  agrees with the fresh answers. Agree: a precedent. Disagree, or no candidate: a new node, and a distinction on the old.
- **A complete match = observed agreement** between reuse and exploration, not a definition written in advance.
- **Graduation:** a node that keeps agreeing runs on its method alone, spot-checked; a correction or a failed check
  demotes it. Consolidation merges agreeing variants into programs and splits nodes that hide two intents.
- **Merging never deletes:** a merged node points to the one it went into, so every reference still resolves; a merge is
  a recorded change and can be undone. Merge when replaying each node's precedents through the other gives the same
  answers; keep apart (with a distinction) when not.
- Two layers were proposed: *intent* (what is asked, what to compute — from words) and *world model* (what the computed
  situation means, what to do — from numbers, learned from choices and outcomes), joined at decision nodes.

## The world model — design of intent (it was vm/packages/world-model/DESIGN.md)
A design of intent, not of mechanism. It will change as practical limits show up; when it does, this page changes with
it (what it replaces is removed, not kept beside).

## Understanding

An internal model of a system that can

1. **predict** — what will happen, given a situation or an input;
2. **explain** — itself, and why it thinks something will happen;
3. **act** — prediction + a goal + a preference → a policy that chooses;

and that **learns**, and can answer **counterfactuals** (what if we had done otherwise).

The package is that model, used as `model.<fn>`: `model.predict(…)`, `model.explain(…)`, `model.decide(…)`,
`model.whatIf(…)`, `model.learn(…)`.

## A core of its own

- **Standalone.** It works without Superatom: its own package, its own tests, no import of anything of ours.
- **It needs infrastructure, through interfaces it declares** — a log to append to and read back, a store for what it
  computes, a clock, word that something changed, a way to be run later. Superatom implements them in **one adapter**;
  tests and standalone use pass in-memory ones.
- **Removable.** If it proves not practical yet, deleting the package and its one adapter breaks nothing else.
- **No domain.** Situations, actions, goals and rewards are given to it; it knows none of its own.

## In Superatom

- **The engine runs it** — near the data (read only through the datasource manager).
- **The platform remembers** — the record of situations, choices and outcomes is the truth, kept in the project's
  Durable Object (today's DecisionDO, renamed for this); the engine keeps what it computes from it as a cache, rebuilt
  from the record whenever needed.
- **It runs when asked, when something changes, and from time to time** — a question or an intent; a source's data or an
  outcome arriving; a schedule. Long-running work is an engine workload like any other.

## Models: many small ones now

- **Now: many small, independent models** — each for an intent or a category of things.
- **Later:** models of whole subsystems, then of the whole organisation.
- **No composition now.** We do not know yet how models will compose, and building for composition early makes the
  task at hand less expressive. Each small model is free to be what its problem needs.
- **Referential integrity instead.** Everything is said once and referred to by its identity — a model, a signal, an
  action, a thing in the world (a supplier, a requisition) — so that when a better system arrives, a change is made in
  one place, not in many.

## Learning

- **From what people do (imitation)** — a person starts with an intent, sees a situation and its signals, takes a path,
  and keeps taking paths. What they pick is itself the output of a model; we learn it from their trajectories.
- **From rewards, where they exist** — a computational model that scores an outcome, in the fields that have one; and
  real outcomes, which arrive late, because the world has to change and effects take time. A decision opens an episode
  with an identity; its outcome attaches to it whenever it comes, or never.
- **A learning loop of its own** — learning runs separately from people using the system: usage records, the loop
  learns, the model improves.

## Start simple

The first version is deliberately small — one kind of small model, learning from recorded trajectories — and grows
only when a real use needs more. The code from `~/try/decision-engine` (signals, state as the output of signals,
fingerprints, Beta statistics with confidence, the record as the truth, promotion) is brought in here as the starting
point, with its lessons kept; that folder is then deleted.

## Open

- Where goals and preferences come from — stated by people, learned from what they do, or both.
- How models compose into subsystem and organisation models.

## Lessons (from the decision-engine experiment; it was vm/packages/world-model/LESSONS.md)
Kept from the experiment this package started from (it lived in `~/try/decision-engine`; deleted 2026-10-18). The wrong
turns are as load-bearing as the final design — losing them would mean re-discovering the same bugs later.

- **"A state is just a filter/view over the raw data."** That framing caps you at whatever fields already exist and how
  they are arranged. A state is the *output of evaluating signals*, not a view of the input: `computeState()` runs each
  signal against the raw context, and the state is the resulting sparse activation pattern. A filter can only select
  data already shaped the way you expect; a signal can discover a trend, a threshold crossing or a best-option ranking
  that sits in no single field.
- **"State is a thing I can look up or match against."** An atomic-state matcher keyed on how *specific* a stored pattern
  was proved brittle: a tiny perturbation snapped the match to a different stored state — specificity-ranking has no
  notion of "close". State is *recomputed fresh* from whichever signals are active, so nearby inputs that activate the
  same signals the same way are, by construction, the same state.
- **"A state needs a fixed schema / DSL to even ask about it."** It fell apart on evolving data. Signals find a role by
  type and shape (`FIND_NUMERIC`, `FIND_TIMESERIES`), never by a key name.
- **"If the fingerprint is the same, the situation must mean the same thing."** Two unrelated metrics with the same shape
  hash identically — *shape without meaning*. Left unresolved on purpose: attaching meaning needs a person or an LLM (in
  Superatom: concepts); fixing it inside the fingerprint would bring back the fixed schema.
- **"A decision tree can own copies of the knowledge at each node."** The same knowledge duplicated across nodes drifted
  out of sync — a referential-integrity failure. Nodes hold only *statistics and pointers* (counts per
  fingerprint/action), never a copy of the knowledge, the way MCTS statistics sit on a shared game tree.
- **"The exact numeric identity of a signal should drive the fingerprint."** A harmless weight tweak minted a new
  fingerprint and cold-started the statistics. Identity is split in two: `signalId()` (exact, with weights — for
  evaluation) and `structuralId()` (only the shape of the question — for the fingerprint).
- **"Then bucketing the output score is enough."** A weight swing that flipped the winner still landed in the same bucket.
  The fingerprint also carries `drivingCriterion` — which criterion drove the winning score — so a real regime change
  changes the fingerprint even when the bucket does not.
- **"Partial pooling across org/group/person is a pure win."** A thin group (two members) was skewed by one diverging
  member, and a new hire inherited the wrong bias. Not fixed — fine at real scale; a real limit of pooling at small N.
- **"A clean-looking scoring function for an off-policy threshold estimate is trustworthy."** A purity score looked
  convergent but was gameable: past the true boundary, one side was dominated by whatever the bootstrapping policy
  already did there. Score a candidate only on records where the action actually taken matches what the candidate would
  have prescribed (off-policy evaluation) — and trust it only within the explored support of that policy.

## The decision memory — as it was built (2026-10-05, the stable-attractor pattern) and why it went unused
The pattern's source: `docs/stable-attractor-associative-memory-source.md`. Every intent in a session was recorded as an
experience, and every step was recognised against decision states — but the screens stopped showing what it recognised
when the options strip replaced it, the learner was never run beyond its first version, and nothing else read it.

One **decision memory** per project, in its own Durable Object (WorldModelDO — the DecisionDO, renamed 2026-10-18 when the world model's journal joined it): every decision state is collected there,
because recognising a situation means searching all of them. It is not the session's STATE. Following the stable
attractor pattern (`docs/stable-attractor-associative-memory-source.md`):

- **Experience** — each passage through a step: its cues (language: the agent, the domain, the question, the STATE's
  values as phrases), the **world** as it was (the figures the step showed — each program's answer can name them), the
  STATE's hash, the **path taken** next (the intent: a control's ops, an action, a call, or words), and later its
  **outcome** (a decision recorded, approved, abandoned, reversed). The memory of the data that passed through.
- **Decision state** (an attractor) — a situation recognised from experiences: its description in language, its cues,
  the **paths** possible from it with the **reasoning** for each and their record (taken, succeeded, failed), the range
  of the world it was seen in, and its evidence (the experiences supporting or contradicting it). A decision state can
  hold other decision states (specialisations: "revenue + finance" and, when evidence shows it differs,
  "revenue + finance + 003"). Specificity is earned: one general state until evidence splits it.
- **Recognition (the hot path, deterministic, no model):** a step's cues → the associative index (phrases 1–4 words,
  BM25-like, user → group → global scope as a ranking factor, strength from the record) → the matching decision states
  → is the world still like the one each was learned in (each figure within the range seen, or how far it moved)?
- **What a state does:**
  - **learned, world similar** — offer its paths first, with their reasoning and record, one click each; exploring
    (asking the agent) is always still there;
  - **learned, world changed** — offer its paths marked with what moved ("seen 12–18, now 31"), and suggest checking
    with the agent before taking one;
  - **not learned** (nothing matches well, or the evidence is thin or competing) — explore: the agent answers and the
    programs' own actions are offered; the experience is recorded, so it can become memory.
  Memory is advisory, never authoritative; contradictions are kept as competing states until evidence explains them.
- **The first learner** (built): the plainest honest learning so the memory is never empty — a step people reached at
  least twice (one agent, the same STATE) becomes a decision state of the paths they took, each with how often; it
  writes only through the named operations, so a better learner (System 4) replaces it with nothing else changing.
- **Learning is a separate path** (assumed working): it reads experiences and outcomes and changes decision states
  only through named operations — create, reinforce, weaken, merge, generalise, specialise, supersede, split, compete,
  invalidate — each recorded with who, when and why; nothing is erased; any decision state can be read as of any moment.

#### How it routed

```
step (block) ──► cues + world ──► decision memory: recognise
                                   ├─ learned · similar  ──► its paths (one click) + explore
                                   ├─ learned · changed  ──► its paths, flagged + "check with the agent"
                                   └─ not learned        ──► explore: the agent, the programs' actions
person takes a path ──► new step ──► experience recorded (cues, world, path)
decision recorded / approved / abandoned ──► artifact (right) ──► outcome of the experiences that led to it
slow path (System 3/4) ──► reads questions and experiences ──► proposes decision states, programs, dashboards
                           (as suggestions: owners decide; published versions; lineage kept)
```
