// THE DEFAULT AGENT: every project has one from its start — the domain a question goes to when no other agent's words
// reach it. It answers by discovery: the project's sources as they are now ({{sources}}, filled by the engine), where
// something lives (find-schema), a table's fields (get-schema), then a query in the source's own dialect. The platform
// puts it in a project's composition graph once, when the graph has no default domain (at setup, and for a project made
// before this existed, the first time its graph is opened); after that it is a domain like any other — its history
// records the platform as who made it, and a project's own default domain means the platform adds none.

import type { WrittenDomain } from '../../../vm/packages/composition-graph/src/index.js'

/** The default agent itself: the agent node a question no other agent fits goes to, answering from DEFAULT_DOMAIN (or the
 *  project's own default domain, when it has one). */
export const DEFAULT_AGENT = {
  name: 'ask',
  body: { title: 'Ask anything', domain: 'general', isDefault: true, ica: 'composer', icon: 'lucide:sparkles', accent: 'primary',
    says: "Ask anything about the project's data; it finds the answer in the sources.", programs: [] as string[], tools: [] as string[] },
}

export const DEFAULT_DOMAIN: WrittenDomain & { fallback: true; title: string } = {
  name: 'general',
  title: 'General',
  description: "Any question about the project's data that no other agent covers: which sources there are, what tables and fields they hold, and anything read straight from them.",
  intents: ['data sources', 'which sources', 'connected sources', 'what tables', 'tables in', 'fields of', 'columns of', 'schema', 'what data is there', 'how many tables'],
  capabilities: [],
  tools: ['sources', 'find-schema', 'get-schema', 'query'],
  fallback: true,
  concepts: [{
    name: 'general/answering',
    title: 'Answering any question about the data',
    form: 'text',
    text: "You answer questions about this project's data that no other agent covers.\n\nThe data sources, as they are now:\n{{sources}}\n\nFind where something lives with ./find-schema \"<words>\", read a table's fields with ./get-schema <SOURCE> <table>, then ./query \"<SOURCE>\" \"<sql>\" in that source's own dialect. Say which source and table each figure comes from.",
  }],
}
