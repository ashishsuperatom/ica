// Types for the routing contract. Hand-written because the contract itself is plain .mjs: it is imported by
// a TypeScript Worker, a TypeScript engine, and a plain-Node proxy, and the one form all three read without a
// build step is JavaScript with types beside it.

export type Route = 'relay' | 'tunnel' | 'box'

export interface Provider {
  route: Route
  hosts?: string[]
  base?: string
  /** maps the path after the provider segment to the upstream URL, when it is not simply base + path */
  upstream?: (rest: string) => string
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
/** The upstream URL for a provider and the path after its segment. */
export declare function upstreamUrl(provider: string, rest: string): string

export declare function isDisabled(name: string): boolean
export declare function disabledReason(name: string): string | null
export declare function providersOn(route: Route): string[]
export declare function hostsOn(route: Route): string[]
export declare function allHosts(): string[]
export declare function boxSide(): { provider: string; envVar: string }[]
export declare function hostMatches(host: string, list: string[]): boolean

export declare function parsePath(pathname: string): {
  projectId: string | null
  tag: string | null
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

export declare function usageFrom(obj: any): { in: number; out: number; cacheRead: number; cacheWrite: number } | null
export declare function usageFromSseTail(tail: string): { in: number; out: number; cacheRead: number; cacheWrite: number } | null

export declare const HARNESSES: Record<string, { providers: string[] }>
export declare function providersForHarness(harness: string): string[]
export declare function harnessCanUse(harness: string, provider: string): boolean

/** A model's name without vendor prefix or variant, with `.`, `-`, `_` as one — what "the same model" means. */
export declare function modelKey(id: string): string
/** The id `available` uses for `model`; null when it has none or more than one. */
export declare function modelOn(model: string | undefined | null, available: string[]): string | null
/** Ids in `available` that look like `model`, best first. */
export declare function nearModels(model: string, available: string[], n?: number): string[]

/** What a usage tag may look like. */
export declare const TAG: RegExp
/** The proxy base for an agent's calls: project, tag (when given), provider. */
export declare function proxyBaseFor(platform: string, project: string, provider: string, tag?: string | null): string
/** True when the proxy counts this provider's calls; otherwise the engine reports them. */
export declare function countedByProxy(provider: string): boolean
