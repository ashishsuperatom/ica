// The one Node module the Worker uses: AsyncLocalStorage, provided by the Workers runtime under nodejs_compat
// (wrangler.jsonc compatibility_flags). Declared here rather than pulling in every Node type.
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    run<R>(store: T, fn: () => R): R
    getStore(): T | undefined
  }
}
