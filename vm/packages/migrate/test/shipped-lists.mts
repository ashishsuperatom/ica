// Every migration list in the repository, by the database it migrates — for the lock that keeps shipped migrations from
// ever changing (shipped.test.mts). A new database's list is added here.
import * as cp from '../../../../control-plane/superadmin/src/migrations.ts'
import { MIGRATIONS as compositionGraph } from '../../composition-graph/src/store.ts'
import { MIGRATIONS as datasourceIndex } from '../../datasource-index/src/store.ts'
import { MIGRATIONS as agentSessions } from '../../../apps/engine/agent-sessions.ts'
import { MIGRATIONS as queryCache } from '../../../apps/datasources/manager/src/query-cache.ts'
import type { Migration } from '../src/index.ts'

export const LISTS: Record<string, Migration[]> = {
  'ProjectDO': cp.PROJECT_MIGRATIONS, 'OrgDO': cp.ORG_MIGRATIONS, 'GlobalDO': cp.GLOBAL_MIGRATIONS,
  'SessionDO': cp.SESSION_MIGRATIONS, 'UserDO': cp.USER_MIGRATIONS, 'GraphDO': cp.GRAPH_MIGRATIONS,
  'engine composition graph': compositionGraph, 'engine datasource index': datasourceIndex,
  'engine agent sessions': agentSessions, 'datasource manager query cache': queryCache,
}
