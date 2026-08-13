// Bootstrap for pool worker threads. Node runs a .mjs natively (no loader needed); we register tsx's
// ESM loader IN-THREAD here, then import the real TypeScript worker. (Passing execArgv:['--import','tsx']
// to the Worker did NOT work — Node reported "Unknown file extension .ts" — so we register here instead.)
import { register } from 'tsx/esm/api'
register()
await import('./worker.ts')
