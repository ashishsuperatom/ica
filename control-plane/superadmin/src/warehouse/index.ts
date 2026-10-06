// THE DATA-WAREHOUSE MODULE (docs/warehouse-module-spec.md): the organisation's warehouse, inside this Worker. Every
// other part of the platform reaches it through here: the Data Source Bridge to read, Ingest to write, the access check
// for what a project may read. Which backend answers is decided here and nowhere else (today the cloud: Basin).

import { cloudWarehouse } from './cloud/index'
import type { ObjectStore } from './cloud/append'

export * from './bridge'
export { checkQuery, cleanGrant, type Grant } from './access'
export { explore, kindOf, ExploreRefusal, type ExploreRequest, type Profile, type ColumnProfile, type Spread, type Filter as ExploreFilter } from './explore'
export type { QueryAs } from './cloud/index'

/** R2 as the warehouse's object store. */
const r2Store = (bucket: string, r2: R2Bucket): ObjectStore => ({
  root: `s3://${bucket}`,
  async put(key, bytes) { await r2.put(key, bytes) },
  async get(key) { const o = await r2.get(key); return o ? new Uint8Array(await o.arrayBuffer()) : null },
})

/** The warehouse for this platform, from its settings: the account and bucket the catalog lives in, the tokens (secrets),
 *  the R2 binding the data files are written through. Missing any, the warehouse says it is not set up. */
export function warehouse(env: Env) {
  // One warehouse per isolate and settings: it keeps the catalog's prefix and what it said about the tables.
  const e = env as unknown as Record<string, any>
  const key = [e.WAREHOUSE_ACCOUNT_ID, e.WAREHOUSE_BUCKET, e.WAREHOUSE_CATALOG_TOKEN, e.WAREHOUSE_SQL_TOKEN, e.WAREHOUSE_CATALOG_URI, e.WAREHOUSE_SQL_ENDPOINT, !!e.WAREHOUSE].join('|')
  const kept = WAREHOUSES.get(key)
  if (kept) return kept
  const made = makeWarehouse(e)
  WAREHOUSES.set(key, made)
  return made
}
const WAREHOUSES = new Map<string, ReturnType<typeof cloudWarehouse>>()

function makeWarehouse(e: Record<string, any>) {
  const accountId = e.WAREHOUSE_ACCOUNT_ID as string | undefined, bucket = e.WAREHOUSE_BUCKET as string | undefined
  const catalogToken = e.WAREHOUSE_CATALOG_TOKEN as string | undefined
  const r2 = e.WAREHOUSE as R2Bucket | undefined
  const cfg = accountId && bucket && catalogToken ? { accountId, bucket, catalogToken, sqlToken: (e.WAREHOUSE_SQL_TOKEN as string | undefined) ?? catalogToken, catalogUri: e.WAREHOUSE_CATALOG_URI, sqlEndpoint: e.WAREHOUSE_SQL_ENDPOINT } : null
  return cloudWarehouse(cfg, cfg && r2 ? r2Store(bucket!, r2) : null)
}
