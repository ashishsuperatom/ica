// The KV shape both the vault and the worker use. Everything else that was here — pools, groups, values,
// exhaustion — now lives in ONE sealed document; see vault.ts for why.
export interface KV {
  get(key: string, type?: 'text' | 'json'): Promise<any>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
  list(opts: { prefix: string }): Promise<{ keys: { name: string }[] }>
}
