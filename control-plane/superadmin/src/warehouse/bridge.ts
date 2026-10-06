// THE WAREHOUSE'S TWO FACES, kept small and apart (docs/warehouse-module-spec.md):
//
//   DataSourceBridge   what the rest of Superatom reads through: an organisation's tables, a table's columns, a query.
//                      Nothing outside this module knows which backend answers (today the cloud: Basin; a local
//                      Iceberg stack later, behind the same interface).
//   Ingest             how data gets in: a table made for an organisation, rows appended to it. Separate from the
//                      query side; the Workers and Durable Objects that receive data call it.
//
// Tables are named plainly ("orders"); the backend places them in the organisation's own namespace.

export type ColumnType = 'string' | 'long' | 'int' | 'double' | 'float' | 'boolean' | 'date' | 'timestamptz' | 'timestamp'
export const COLUMN_TYPES: ColumnType[] = ['string', 'long', 'int', 'double', 'float', 'boolean', 'date', 'timestamptz', 'timestamp']
export interface Column { name: string; type: ColumnType; required?: boolean }
export interface TableInfo {
  name: string; columns: Column[]
  /** Rows as the current snapshot counts them (absent when it did not count), and when it was written. */
  rows?: number; appended?: number
}
export interface QueryResult { columns: string[]; rows: Record<string, unknown>[]; truncated: boolean }

export interface DataSourceBridge {
  /** Whether a backend is set up (else every call says so). */
  readonly configured: boolean
  tables(org: string): Promise<TableInfo[]>
  describe(org: string, table: string): Promise<TableInfo | null>
  /** Read-only SQL over the organisation's tables, named plainly; at most `limit` rows come back. */
  query(org: string, sql: string, opts?: { limit?: number }): Promise<QueryResult>
}

export interface Ingest {
  readonly configured: boolean
  createTable(org: string, table: TableInfo): Promise<void>
  append(org: string, table: string, rows: Record<string, unknown>[]): Promise<{ snapshot: string; rows: number }>
}

export class WarehouseRefusal extends Error {}
export const NOT_CONFIGURED = 'the warehouse is not set up on this platform (no catalog token or bucket)'

/** An organisation's namespace in the shared catalog: one per organisation, never per project. */
export const namespaceOf = (org: string) => `org_${org.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`
export const TABLE_NAME = /^[a-z][a-z0-9_]{0,62}$/
