// The Concept — the small, composable, EVALUATED unit the COMPOSER (System 2) writes programs from.
//
// WHY IT EXISTS
// A build is slow because ~70% of it is DISCOVERY (where's the data, how to compute it, what quirks bite).
// A concept memoises that discovery so the composer skips straight to writing. The composer does NO discovery
// and invents nothing — it READS concepts and REWRITES their compute into a fresh program. A concept is a
// GUIDE, never a runtime import: rich enough that no re-discovery is needed, small enough to compose.
//
// THE RICH-BUT-SMALL TENSION (the whole design)
//   • SMALL  = one coherent thing → several concepts COMPOSE into a question, and a single one can be
//              overridden per branch/user later without touching the rest.
//   • RICH   = a COMPLETE guide for that one thing — full recipe + the rules + the pitfalls — so the composer
//              needs zero discovery. You look at it and KNOW the approach is correct.
//
// WHERE THEY COME FROM
// Concepts are minted ONLY from EVALUATED analyses — the modeler (System 4) distills them AFTER the analyst
// (System 3) has verified an answer. Crucially it harvests BOTH the surface concepts a question named AND the
// nuanced ones discovered only by digging in (e.g. "for Milestone/Prepayment projects use custentity9, not the
// charge rate" — invisible in the question, found mid-analysis). So concept-minting is an OUTPUT of analysis,
// never a parse of question text. The composer combines proven concepts; anything not covered → analyst.
//
// A concept can span SEVERAL entities and SEVERAL ideas (forecast-revenue = project + project-type + rate +
// time-entry, with an embedded rule), and its compute is an ORDERED LIST of steps, not one query.
//
// STATUS: schema proposal on the `concept-fast-path` branch. Not yet a registered node kind / wired into the
// engine — it exists to be validated by the extractor against the real evaluated concepts + the question bank.

// TWO KINDS OF FIELD. The composer LLM sees only the GUIDE fields (phrase, what, entities, strategy, compute,
// represent, review) — keep those tight, since the composer already has the whole program context around them.
// The `meta` block is METADATA: retrieval ranking + audit + provenance. It is NOT fed to the composer at
// compose time. And `scope` is routing metadata (which concept wins), not guidance.
//
// PROSE IS CONCISE. `what`/`strategy`/`review.idea` carry ONLY the essential, non-obvious things — the rules a
// competent writer wouldn't already know. No restating the obvious, no long dossiers (that's what made the old
// heavy concepts unusable).
//
// REVIEW IS CONCEPT-SPECIFIC ONLY. Generic review ("numbers are positive", "state the scope") lives in the
// composer's own prompt — so pulling ten concepts doesn't repeat the same generic checks ten times. A concept's
// `review` holds only what is peculiar to THIS concept (e.g. "never blend currencies", "flag YTD if partial").
//
// NO CONTRADICTIONS ACROSS CONCEPTS. A shared intermediate (a join, a filter both need) should live in ONE
// concept the others reference — not be copied into each, where the copies can drift apart. (Enforcement is a
// later concern; the principle shapes how the modeler mints them.)

/** Inheritance level that minted the concept. user overrides branch overrides global (hierarchy is FUTURE — the
 *  field is here now so concepts are shaped for it; resolution isn't built yet). Routing metadata. */
export type ConceptScope = 'global' | 'branch' | 'user'

/** One step of the recipe: plain-language intent + the runnable query fragment that is its reference. */
export interface ConceptComputeStep {
  do: string             // what this step computes, in plain language
  query: string          // the runnable query fragment — the EXECUTABLE reference the composer rewrites from (never prose)
  source?: string        // datasource id this fragment runs against (a concept may cross sources)
}

/** Retrieval + audit only — NOT sent to the composer LLM at compose time. */
export interface ConceptMeta {
  coverage?: number      // 0..1 — how much of the population the compute covers
  confidence?: number    // 0..1 — how sure we are of the approach
  evidence?: string      // the proof from the minting analysis (why this is correct)
  mintedFrom?: string    // the evaluated program/analysis this was distilled from
}

export interface Concept {
  // ── GUIDE (the only fields the composer LLM sees — keep concise) ──
  phrase: string         // the searchable key — what a question calls this ("forecast revenue", "at-risk project")
  what: string           // ONE tight line — the concept itself, essentials only
  entities: string[]     // the entities/relations it touches (may be several)
  strategy: string       // the non-obvious rules & pitfalls only, so no re-discovery — concise, not a dossier
  compute: ConceptComputeStep[]                   // the proven recipe — ONE step for a simple concept, several for a compound one
  represent: { idea: string; snippet?: string }   // how to present THIS result (per-concept, not per-entity)
  review: { idea?: string; checks?: string[] }    // ONLY the checks specific to this concept (generic ones live in the composer prompt)

  // ── metadata (not fed to the composer at compose time) ──
  scope: ConceptScope    // routing: default 'global'; branch/user overrides come later
  meta?: ConceptMeta     // retrieval ranking + audit
}
