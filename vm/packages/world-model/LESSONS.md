# Lessons from the decision-engine experiment

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
