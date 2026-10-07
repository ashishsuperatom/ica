// ── THE PLATFORM'S FILES: one place that says where each kind lives, how large it may be, and how it is checked ──────
//
// Every file the platform keeps is in the PACKAGES bucket, under its kind and its project — so everything of a project
// can be found (and removed) by prefix, and nothing is put anywhere this module does not name. docs/storage.md is the
// index of all storage; this is the code behind its R2 part.
//
//   parcel      parcel/<project>/<sha256>                        a message body too large for the wire (parcels.ts)
//   program     programs/<project>/<sha256>.json                 a program's bundle (program-catalogue.ts)
//   dashboard   dashboard/<project>/<dashboard>/<build>/<path>   a dashboard build's files (worker.ts)
//   attachment  attachments/<project>/<session>/<sha256>         a file a person added to a session (user-hub.ts)
//
// A content-addressed kind is checked against its name (the bytes hash to it). A session's files sit under the session,
// so removing a session removes them by prefix — no counting who else refers to the same file.

export const LIMITS = {
  /** A message body beside the wire: a table of some hundred thousand rows, not a file upload. */
  parcel: 64 * 1024 * 1024,
  /** A program's bundle (its source and built files as JSON). */
  program: 16 * 1024 * 1024,
  /** One file of a dashboard build, and a whole build. */
  dashboardFile: 25 * 1024 * 1024,
  dashboardBuild: 200 * 1024 * 1024,
  /** A file a person adds to a session. */
  attachment: 20 * 1024 * 1024,
} as const

const ID = /^[\w-]{1,80}$/
const HASH = /^[0-9a-f]{64}$/
const must = (ok: boolean, what: string) => { if (!ok) throw new FileRefusal(400, what) }

export class FileRefusal extends Error { constructor(public status: number, message: string) { super(message) } }

/** Where each kind lives. Every key the platform writes is made here. */
export const keyOf = {
  parcel: (project: string, hash: string) => { must(ID.test(project) && HASH.test(hash), 'a parcel is named by its project and hash'); return `parcel/${project}/${hash}` },
  program: (project: string, hash: string) => { must(ID.test(project) && HASH.test(hash), 'a program is named by its project and hash'); return `programs/${project}/${hash}.json` },
  dashboardBuild: (project: string, dashboard: string, build: string) => { must(ID.test(project) && /^[^/]{1,120}$/.test(dashboard) && /^[^/]{1,80}$/.test(build), 'a build is named by its project, dashboard and id'); return `dashboard/${project}/${dashboard}/${build}` },
  attachment: (project: string, session: string, hash: string) => { must(ID.test(project) && ID.test(session) && HASH.test(hash), 'a session file is named by its project, session and hash'); return `attachments/${project}/${session}/${hash}` },
}
/** Everything of one kind for a project, or for one session — what a removal lists. */
export const prefixOf = {
  parcels: (project: string) => { must(ID.test(project), 'a project id'); return `parcel/${project}/` },
  session: (project: string, session: string) => { must(ID.test(project) && ID.test(session), 'a project and session id'); return [`attachments/${project}/${session}/`] },
}

/** A size within its kind's limit, or a refusal saying the limit. */
export function checkSize(kind: keyof typeof LIMITS, bytes: number): void {
  if (bytes <= 0) throw new FileRefusal(400, 'the file is empty')
  if (bytes > LIMITS[kind]) throw new FileRefusal(413, `at most ${Math.round(LIMITS[kind] / 1024 / 1024)} MB (${kind})`)
}

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('')
}


