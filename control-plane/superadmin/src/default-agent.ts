// THE DEFAULT AGENT AND THE WORKBENCH: every project has both from its start, each on its own domain — one of the
// platform's defaults (platform-types default-concepts.ts: composer, workbench-domain), put in before them. The platform
// puts each in a project's composition graph once, when the graph has none; after that it is an agent like any other —
// its history records the platform as who made it.

/** The default agent itself: where a question asked with no agent picked goes — the session's composer, on its domain. */
export const DEFAULT_AGENT = {
  name: 'ask',
  body: { title: 'Ask anything', domain: 'composer', isDefault: true, ica: 'composer', icon: 'lucide:sparkles', accent: 'primary',
    says: "Ask anything about the project's data; it finds the answer in the sources.", programs: [] as string[], tools: [] as string[] },
}

// THE WORKBENCH: an agent every project has, for those who develop it — a session agent of its own kind (ica
// "workbench") that takes every message itself: no intent is looked for or learnt, no narrator stands between; the
// person works with it hands-on, in sessions that last.
export const WORKBENCH_AGENT = {
  name: 'workbench',
  body: { title: 'Workbench', domain: 'workbench-domain', ica: 'workbench', icon: 'lucide:hammer', accent: 'neutral',
    says: 'Work hands-on with an agent — any task, in sessions that last.', programs: [] as string[], tools: [] as string[] },
}
