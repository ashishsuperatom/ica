// What this browser remembers about how a reader likes to look at things: which view a section was left in, which
// slices of a ring they had switched off. None of it says anything about the data, so none of it belongs in the thread,
// in the URL or on the server — it is one person's preference on one machine, and it stays there.
//
// Storage can be missing, full or blocked (a private window, a locked-down browser). Every read and write is guarded:
// when it fails the app simply forgets, which is a smaller thing to go wrong than a screen that will not draw.

// Kept per project, so two dashboards in one browser never read each other's preferences.
const PREFIX = `sa.${(import.meta.env.VITE_PROJECT_ID as string | undefined) ?? 'local'}.`
const KEY = (name: string) => `${PREFIX}${name}`

export function recall<T>(name: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(KEY(name))
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function remember(name: string, value: unknown) {
  try {
    localStorage.setItem(KEY(name), JSON.stringify(value))
  } catch {
    // Out of room. None of this is worth protecting — a view and a few switched-off slices per chart — so throw all of
    // ours away and keep the one thing being asked for. Everything else goes back to its default, which is correct,
    // just not what that reader had chosen.
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k)
      localStorage.setItem(KEY(name), JSON.stringify(value))
    } catch {
      // not remembered; nothing else changes
    }
  }
}
