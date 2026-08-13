// ── Question classifier (RETIRED — kept as a stub) ────────────────────────────
// The analyst now decides its own answer-shape inside its prompt, so we no longer pre-classify. This
// file stays for two reasons: (1) `Category` / `CATEGORIES` are the shared category vocabulary used
// across the code and by the analyst's answer-shape files; (2) a real classifier will come back as a
// cheap PRE-AGENT guardrail (route/screen a question before it reaches the expensive analyst).
//
// What it used to do (to rebuild): one OpenRouter call to a small, fast model (Gemini 2.5 Flash Lite,
// `google/gemini-2.5-flash-lite`, temperature 0, ~8 max tokens) with a system prompt listing the
// categories by answer-shape; it returned the single category word. See git history for the full prompt.

export type Category =
  | 'simple_lookup'    // read one stored value for one named entity, no math
  | 'complex_lookup'   // an aggregate / derived number over many rows (sum, count, avg, ratio, top-N, group-by)
  | 'comparison'       // two+ scopes computed the same way, then diffed
  | 'causal'           // a "why did X change / what drove it" question
  | 'counterfactual'   // a hypothetical "what if" — recompute with a changed assumption
  | 'analysis'         // open-ended, multi-step (the general bucket)

export const CATEGORIES: Category[] = ['simple_lookup', 'complex_lookup', 'comparison', 'causal', 'counterfactual', 'analysis']

// Stub: returns nothing meaningful (the analyst self-classifies now). Left callable for easy revival.
export async function classify(_question: string): Promise<{ category: Category; ms: number }> {
  return { category: 'analysis', ms: 0 }
}
