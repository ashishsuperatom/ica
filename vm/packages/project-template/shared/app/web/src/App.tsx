// Connect, load the catalog, then the shell: sidebar, the thread, the connection pill, the toasts.

import { useEffect, useMemo, useState } from 'react'
import AppShell from '@/components/layout/AppShell'
import Toasts from '@/components/ui/Toasts'
import { makeClient } from '@/lib/client'
import { AppProvider } from '@/lib/catalog'
import type { Catalog } from '@/lib/wire'
import { configure } from '@/lib/format'
import { ThreadProvider } from '@/runtime/thread'
import ThreadView from '@/components/thread/ThreadView'
import { useThread } from '@/runtime/thread'

type Load = { state: 'loading'; step: string } | { state: 'ready'; catalog: Catalog } | { state: 'failed'; why: string }

/** A pasted link with `?focus=<capability>` opens a fresh thread on it — once, on load. */
function DeepLink() {
  const thread = useThread()
  useEffect(() => {
    const focus = new URLSearchParams(location.search).get('focus')
    if (focus) thread.start(focus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

export default function App() {
  const client = useMemo(() => makeClient(), [])
  const [load, setLoad] = useState<Load>({ state: 'loading', step: 'Connecting…' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let mounted = true
    setLoad({ state: 'loading', step: client.status() === 'mock' ? 'Loading recorded answers…' : 'Connecting…' })
    client.connect()
    client.request({ t: 'app:catalog' }).then((r) => {
      if (!mounted) return
      if (r.t === 'app:catalog') { configure(r.catalog.project); document.title = `${r.catalog.project.name} · Superatom`; setLoad({ state: 'ready', catalog: r.catalog }) }
      else setLoad({ state: 'failed', why: r.t === 'app:error' ? r.error : r.t === 'app:refused' ? r.reason : 'The catalog did not arrive.' })
    }, (e: unknown) => mounted && setLoad({ state: 'failed', why: e instanceof Error ? e.message : String(e) }))
    return () => { mounted = false }
  }, [client, attempt])

  // A rejected connection (4001/4003) is said, not retried.
  const [, tick] = useState(0)
  useEffect(() => client.onStatus(() => tick((n) => n + 1)), [client])
  const status = client.status()
  const message = client.message()

  if (load.state === 'loading') {
    return (
      <div className="sa-splash">
        <div className="sa-splash__box">
          {status !== 'rejected' && <span className="sa-spinner sa-spinner--lg" />}
          <p className="sa-splash__text">{status === 'rejected' ? message : message || load.step}</p>
          {status === 'rejected' && <button className="sa-btn" onClick={() => location.reload()}>Reload</button>}
        </div>
      </div>
    )
  }
  if (load.state === 'failed') {
    return (
      <div className="sa-splash">
        <div className="sa-splash__box">
          <p className="sa-splash__text">Could not load the application.</p>
          <p className="sa-splash__why">{load.why}</p>
          <button className="sa-btn sa-btn--primary" onClick={() => setAttempt((n) => n + 1)}>Try again</button>
        </div>
      </div>
    )
  }
  return (
    <AppProvider value={{ catalog: load.catalog, client }}>
      <ThreadProvider client={client}>
        <DeepLink />
        <AppShell>
          <ThreadView />
        </AppShell>
        <Toasts />
      </ThreadProvider>
    </AppProvider>
  )
}
