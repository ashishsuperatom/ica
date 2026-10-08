// The messages the platform answers itself — from its own records, no engine needed. Who may send each is the same
// rule for people and keys (shared/permissions.ts messageNeeds: the capability a message needs).

/** Messages the hub answers itself, from the platform's own records (no engine needed). */
export const HUB_MESSAGES = ['dsi:show', 'dsi:stats', 'dsi:snapshot', 'dsi:failures', 'dsi:describe', 'dsi:enable', 'dsi:build', 'job:list', 'job:get', 'session:list', 'session:read', 'program:list', 'program:publish', 'activity:list', 'decision:paths', 'decision:outcome', 'decision:states', 'decision:state', 'decision:change', 'decision:learn', 'artifact:record', 'artifact:decide', 'artifact:list', 'artifact:get', 'decision:register', 'warehouse:tables', 'warehouse:query', 'warehouse:explore', 'warehouse:queries', 'warehouse:queries:save', 'warehouse:queries:delete', 'warehouse:append', 'connector:catalog', 'connector:test', 'connector:introspect', 'connector:read', 'connector:act', 'connector:run', 'connector:calls',
  // The composition graph: held by the platform (superadmin/src/graph.ts), read and changed there.
  'graph:domains', 'graph:names', 'graph:show', 'graph:history', 'graph:compose', 'graph:suggestions', 'graph:concept', 'graph:domain', 'graph:agent', 'graph:join', 'graph:leave', 'graph:suggest', 'graph:decide', 'graph:publish', 'graph:versions', 'graph:version', 'graph:restore', 'graph:import', 'app:publish'] as const

/** The console's views (inspect:req) the platform answers itself, from the composition graph it holds — every other view
 *  is an engine's (what it holds: its files, tables, logs). Read by the platform to answer them and by the console to say
 *  who it is asking. */
export const PLATFORM_VIEWS = ['composition', 'compositionNode', 'compositionCompose', 'compositionColumns', 'graphSessions'] as const
