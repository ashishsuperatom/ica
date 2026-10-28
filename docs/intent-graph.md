# The intent graph

Built 2026-10-28, from the design in the user's words (kept with the earlier thinking in `docs/intent-and-world-model.md`).

## What it is

The composition graph holds what the organisation knows (domains, concepts); it stays as it is. The **intent graph** holds
what people ask for and how they move between those things: it is the decision graph, and the memory of how the system
behaves. Each **intent node** is one kind of request:

- its **intent**, in words — never a schema; the agent that made it may add its own keys (`about`);
- the **knowledge it links to** — a domain, or a concept (atomic or composite) of the composition graph, **by name: linked,
  never copied**, so a change is made once and every node that depends on it is known;
- the **agent that answers at it**, when it is not the composer (the builder, the connector, an agent the project made);
- its **passages** — every question answered at it, with the answer: its memory and the history of its answers;
- its **ways out** — edges to the nodes people went to next, counted, per scope (a person's own, a group's, everyone's).

A session is a path through the graph: question[n] → answer is one instance of a node.

## A question in a session

1. **Place it.** The session stands at a node (the node of the last answer on its path), or nowhere at its start. The
   platform gives that node, the nodes people went to from it (the asker's own ways first), the nodes that read like the
   question, the domains, and the specialised agents the asker may use. A small, fast model (the narrator's) decides:
   - a node answers it **completely** (the same request, possibly for another item, person or period) → **followed**;
   - none does → **made**: a new node is described — its title, intent, the knowledge it links to, and an agent only when
     the person asks for that agent's kind of work (a program built, a source connected);
   - the message only reacts to the answer just given → **stayed** at the node.
   A message it cannot place is still answered: a new node on the domain its words reach. Placing is the exploration step —
   the search for the right knowledge happens once, when a node is made; reaching a node afterwards brings its knowledge.
2. **Answer it at the node.** The composer is built on the first node's domain; a later node's linked knowledge is given
   to it once, when the path first needs it. A node with an agent is answered by the session's agent instead — when the
   asker holds what that agent needs (their capabilities, stamped by the platform on what they send); otherwise they are
   told plainly which permission it needs.
3. **Keep what happened.** The passage is kept at the node (a new node is made then), the way from the node before is
   counted, and the answer carries its node (`answer.node`: id, title, followed | made | stayed).

Consolidation — merging nodes that are the same intent, splitting one that hides two, settling variants — is not built:
online, two paths are never known to be the same; that is for a later, offline step.

## Specialised agents of a session

One of each per session, made only when the session first reaches a node that needs it (zero cost until then), and kept for
the session: the same agent — its conversation resumed across engine restarts (`sessions/<sid>/agents.json`) — and the same
folder, the session's own (`sessions/<sid>/work`), every time. Superatom gives every project two:

- **builder** (needs `project.develop`) — makes a program when the person asks for one, never to answer a question; what
  it writes under `programs/<name>/` is built by the engine as any program is, kept as the person's own until published;
- **connector** (needs `project.connectors`) — connects a source, or fixes or changes how one is connected.

A project's admins (`project.manage`) make others — a name, what it is for, its instructions, the capability a person
needs, Claude Code or Codex — in the admin console (Specialised agents), the user UI (Intents) or `sacli specialists`.
A turn ends when the agent writes its note for the person (`out/<turn>.md`).

## Storage

- **IntentDO** — one per cluster: `intent:<project>:<cluster>`. A node's id is `<cluster>-<unique>`; the cluster is what
  the node is mostly about (its first linked domain), so the nodes people move between are read together, and a node can
  still be given a Durable Object of its own (a cluster of its own) later. Tables: `nodes` (as now, with its stale mark),
  `node_versions` (every version — a node changes only by a new one; read as of any moment), `edges`, `passages`.
- **ProjectDO** — `intent_index`: every node of the project in one place to search (title, intent, links, agent, stale,
  answers); `session_agents`: the project's own specialised agents.

## Staleness

When a knowledge version is published, every node linking to a changed name — or to a composite or domain made of one,
followed upward — is marked stale (why, and which version). Nothing is changed for it; it is there to be looked at again.

## Where it is seen

- **Admin console → Knowledge → Intent graph**: the graph drawn left to right from where conversations start; a node
  chosen shows its intent, knowledge, agent, versions, ways out and answers. **Agents → Specialised agents**.
- **User UI → Intents**: the same views; each answer says which node it was answered at.
- **sacli**: `sacli intent`, `sacli intent show <id>`, `sacli specialists`.

## Messages

| From | Message | |
|---|---|---|
| engine | `intent:context` · `intent:record` · `intent:agent` | place a question; keep what happened; an agent's instructions |
| people | `intent:graph` · `intent:node` (project.view) · `intent:write` (project.manage) | read the graph and a node; change one |
| people | `agents:list` (project.view) · `agents:save` · `agents:remove` (project.manage) | the specialised agents |

Code: `control-plane/superadmin/src/intent-do.ts`, `intents.ts`; `vm/apps/engine/intent.ts`, `session-agents.ts`,
`agents/builder/`; `vm/packages/platform-types/src/intent.ts`; `vm/packages/ui/src/components/semantic/IntentGraph.tsx`.
