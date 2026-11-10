// THE SOURCES A CONVERSATION MAY READ (docs/connectors-plan.md 9g) — one function for every read (the ticket carries its
// answer: the datasource manager lists and reads only those; find-schema and get-schema show only those). The project's
// sources, narrowed by the conversation's domain (its rule: only these, or all but these — composed once, with the domain),
// then by the person (nothing yet: the same). null: every one.

export type SourcesRule = { only?: string[]; remove?: string[] } | null | undefined

export function sourcesFor(all: string[], o: { domain?: SourcesRule }): string[] | null {
  const r = o.domain
  if (!r || (!r.only && !r.remove)) return null
  let list = r.only ? all.filter((s) => r.only!.includes(s)) : [...all]
  if (r.remove) list = list.filter((s) => !r.remove!.includes(s))
  return list
}
