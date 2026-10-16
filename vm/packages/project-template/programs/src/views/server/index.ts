// THE VIEWS LIBRARY — a project's own views: questions its data answers with no model, each the same every time.
//
// A program that names "views" in its manifest's "uses" imports `ask` from the library and, in one of its functions:
//   const reply = await ask({ t: 'app:start', focus: 'revenue' }, ctx)
//
// `server/app/` holds it: the view engine (index, loader, resolve, state, windows, read — the same in every project,
// kept in step from the template) and the project's own part (project.mjs, facts.mjs, dimensions.mjs, lib/, and
// capabilities/<view>/ — one folder per view). The engine reads the facts through the program's context, so a view runs
// as the person asking, with their data access, like everything else a program does. doc.md says how to write a view.
// @ts-ignore — the engine is plain JavaScript
import { handle } from './app/index.mjs'

type Services = {
  program(domain: string, file: string, args?: (string | number)[], o?: { notes?: boolean }): Promise<unknown>
  settings(domain: string): Promise<Record<string, unknown>>
  /** How the organisation reads time, money and words (the platform's configuration). */
  config(): { locale: string; currency: string | null; financialYear: { startMonth: number } | { months: { name: string; from: string; to: string }[] } } & Record<string, unknown>
}

/** One request to the project's views (`app:start | app:ask | app:move | app:check | app:catalog | app:members`), answered.
 *  The reply is `app:answer` (the answer: title, blocks, next moves, what it stood on), `app:checked` ({ problems }: what
 *  is wrong with a whole question, for app:check), `app:refused` (a sentence) or `app:error`. */
export async function ask(payload: Record<string, unknown>, ctx: { services: Services; today?: string }): Promise<Record<string, any>> {
  let reply: Record<string, any> = { t: 'app:error', error: 'the views gave no reply' }
  await handle(payload, {
    ...(ctx.today ? { today: ctx.today } : {}),
    reply: (m: Record<string, any>) => { reply = m },
    run: async (domain: string, file: string, args: string[]) => {
      const r = await ctx.services.program(domain, file, args, { notes: true }) as { data: unknown; notes: string[] }
      return { rows: r.data, notes: r.notes }
    },
    settings: (domain: string) => ctx.services.settings(domain),
    config: () => ctx.services.config(),
    sources: async () => [],
  })
  return reply
}
