// Types for the routing contract. Hand-written because the contract itself is plain .mjs: it is imported by
// a TypeScript Worker, a TypeScript engine, and a plain-Node proxy, and the one form all three read without a
// build step is JavaScript with types beside it.

export type Route = 'relay' | 'tunnel' | 'box'

export interface Provider {
  route: Route
  hosts?: string[]
  base?: string
  header?: (key: string) => Record<string, string>
  envKey?: string
  envVar?: string
  /** Set to a reason to turn a provider off. Both proxies refuse it; nothing relays. */
  disabled?: string
}

export declare const PATH_PREFIX: string
export declare const PROJECT_HEADER: string
export declare const PROVIDERS: Record<string, Provider>
export declare const UPSTREAMS: Record<string, Provider>

export declare function isDisabled(name: string): boolean
export declare function disabledReason(name: string): string | null
export declare function providersOn(route: Route): string[]
export declare function hostsOn(route: Route): string[]
export declare function allHosts(): string[]
export declare function boxSide(): { provider: string; envVar: string }[]
export declare function hostMatches(host: string, list: string[]): boolean

export declare function parsePath(pathname: string): {
  projectId: string | null
  service: string | null
  provider: string | null
  rest: string
  arg: string | null
}

export declare function bearerOf(get: (h: string) => string | null): string | null
export declare function isProjectKey(v: string | null): boolean

export declare function decide(a: { projectId: string | null; sentCredential: string | null; proven: boolean }):
  | { ok: false; status: number; error: string }
  | { ok: true; attachKey: boolean; project: string | null }

export declare function usageFrom(obj: any): { in: number; out: number } | null
export declare function usageFromSseTail(tail: string): { in: number; out: number } | null
