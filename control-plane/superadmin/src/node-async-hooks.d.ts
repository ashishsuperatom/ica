// The Node modules the Worker uses: AsyncLocalStorage, provided by the Workers runtime under nodejs_compat
// (wrangler.jsonc compatibility_flags). Declared here rather than pulling in every Node type.
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, fn: () => R): R
    getStore(): T | undefined
  }
}

// And the graph's content hashes (composition-graph store.ts): a synchronous sha-256, from the same runtime.
declare module 'node:crypto' {
  export function createHash(algorithm: 'sha256'): { update(data: string): { digest(encoding: 'hex'): string } }
}
