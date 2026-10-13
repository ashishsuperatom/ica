// THE VIEWS LIBRARY — a project's own views: questions its data answers with no model, each the same every time.
//
//   import { ask } from '@lib/views'
//   const reply = await ask({ t: 'app:start', focus: 'revenue' }, ctx)     // in a program's function
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
}

/** One request to the project's views (`app:start | app:ask | app:move | app:catalog | app:members`), answered.
 *  The reply is `app:answer` (the answer: title, blocks, next moves, what it stood on), `app:refused` (a sentence) or
 *  `app:error`. */
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
    sources: async () => [],
  })
  return reply
}
