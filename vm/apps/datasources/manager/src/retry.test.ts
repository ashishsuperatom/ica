// Run:  cd vm && pnpm exec tsx --test apps/datasources/manager/src/retry.test.ts
//
// The valuable half of a retry is what it REFUSES to retry. Repeating a syntax error three times turns an
// instant, accurate failure into a slow one; repeating a statement that writes could apply it twice. Both are
// worse than not having retries at all, so both are pinned here.
import { test } from 'node:test'
import assert from 'node:assert'
import { withRetry } from './index.js'

const FAST = [1, 1, 1]
const failing = (times: number, message: string) => {
  let n = 0
  return async () => { if (n++ < times) throw new Error(message); return `ok after ${n}` }
}

test('a transient failure is retried and recovers', async () => {
  assert.equal(await withRetry(failing(2, 'HTTP 503 Service Unavailable'), 'src', FAST), 'ok after 3')
})

test('the shapes a flaky source actually reports are all recognised', async () => {
  // Bridges are HTTP, drivers or raw sockets, and each words the same outage differently.
  for (const m of ['HTTP 503 Service Unavailable', 'read ECONNRESET', 'connect ETIMEDOUT 10.0.0.1:443',
                   'socket hang up', 'request timed out', 'getaddrinfo EAI_AGAIN netsuite', '429 Too Many Requests',
                   'Service temporarily unavailable', 'HTTP 502 Bad Gateway']) {
    assert.equal(await withRetry(failing(1, m), 'src', FAST), 'ok after 2', m)
  }
})

test('a QUERY error is NOT retried — it fails once, immediately', async () => {
  // The point of the whole distinction. Waiting cannot fix a syntax error, and three attempts only delay
  // telling the caller something true.
  let calls = 0
  const bad = async () => { calls++; throw new Error(`Invalid SuiteQL: unknown identifier "custome"`) }
  await assert.rejects(withRetry(bad, 'src', FAST), /Invalid SuiteQL/)
  assert.equal(calls, 1, 'a permanent error must be attempted exactly once')
})

test('it gives up after the attempts are spent and reports the real error', async () => {
  let calls = 0
  const always = async () => { calls++; throw new Error('HTTP 503 Service Unavailable') }
  await assert.rejects(withRetry(always, 'src', FAST), /503/)
  assert.equal(calls, FAST.length + 1, 'one initial attempt plus one per delay')
})

test('when it gives up it SAYS it already tried — so the agent does not try again', async () => {
  // The failure this prevents: the agent reads a bare "503", reasons about it, and re-issues the query — the
  // expensive retry loop we removed, now running on top of the cheap one instead of instead of it.
  const always = async () => { throw new Error('HTTP 503 Service Unavailable') }
  await assert.rejects(withRetry(always, 'src', FAST), (e: Error) => {
    assert.match(e.message, /HTTP 503/, 'the real error survives')
    assert.match(e.message, /already retried 4 times/, 'and says how many times')
    assert.match(e.message, /not worth repeating/, 'in words an agent will act on')
    return true
  })
})

test('a bridge may classify its own failures, in both directions', async () => {
  // Not every source words an outage like an HTTP error. One that knows says so; one that does not gets the
  // default. And a bridge can call a failure PERMANENT that the default would otherwise sit and retry.
  let calls = 0
  const odd = async () => { calls++; if (calls < 2) throw new Error('ORA-12520: listener could not hand off'); return 'ok' }
  assert.equal(await withRetry(odd, 'src', FAST, () => true), 'ok', 'a source can opt a failure IN')

  calls = 0
  const looksTransient = async () => { calls++; throw new Error('HTTP 503 Service Unavailable') }
  await assert.rejects(withRetry(looksTransient, 'src', FAST, () => false))
  assert.equal(calls, 1, 'a source can opt a failure OUT, and it is tried exactly once')
})

test('a success on the first attempt costs nothing', async () => {
  let calls = 0
  assert.equal(await withRetry(async () => { calls++; return 'v' }, 'src', FAST), 'v')
  assert.equal(calls, 1)
})
