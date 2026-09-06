// Types for contract.mjs — the shared proxy rules. Hand-written rather than generated: the contract is plain
// JavaScript so a Node server can import it with no build step, and this file is what lets the TypeScript
// Worker import the same source instead of keeping a second copy of the rules.

export const PATH_PREFIX: string
export const PROJECT_HEADER: string

export interface Upstream {
  base: string | null
  header?: (key: string) => Record<string, string>
  envKey?: string
  tunnelOnly?: boolean
}
export const UPSTREAMS: Record<string, Upstream>

export interface ParsedPath {
  projectId: string | null
  service: string | null    // '_health' | '_whoami' | '_key' | null
  provider: string | null
  rest: string
  arg: string | null
}
export function parsePath(pathname: string): ParsedPath

export function bearerOf(get: (name: string) => string | null): string | null
export function isProjectKey(v: string | null): boolean

export type Decision =
  | { ok: false; status: number; error: string }
  | { ok: true; attachKey: boolean; project: string | null }
export function decide(o: { projectId: string | null; sentCredential: string | null; proven: boolean }): Decision

export interface Usage { in: number; out: number }
export function usageFrom(obj: any): Usage | null
export function usageFromSseTail(tail: string): Usage | null
