// SUPERATOM'S CONNECTORS FOR A TEST PLATFORM: they are released apart from the platform (docs/connectors-plan.md 9b), so a
// test platform's registry is filled first — every connector as built (connectors/dist/released.json), through the real
// release door with the test's release token, as the release job does.
import RELEASED from '../../../../connectors/dist/released.json'

export const RELEASE_TOKEN = 'test-release-token'
/** What a test platform binds for the release door. */
export const releaseBindings = { CONNECTOR_RELEASE_TOKEN: RELEASE_TOKEN }
/** The lines a test's own harness adds: the GlobalDO and the release door (a full-Worker harness has both already). */
export const releaseHarness = {
  imports: `import { releaseConnector } from '../superatom-connectors.ts'\nexport { GlobalDO } from '../global-do.ts'`,
  route: `if (u.pathname === '/api/superatom/connectors/release') return releaseConnector(env, req)`,
}

/** Release every connector (or those named) into a test platform's registry. */
export async function releaseAll(dispatch: (url: string, init: RequestInit) => Promise<Response>, only?: string[]): Promise<void> {
  for (const r of RELEASED as { manifest: any; code: string }[]) {
    if (only && !only.includes(r.manifest.id)) continue
    const { hash: _h, bytes: _b, ...manifest } = r.manifest
    const res = await dispatch('http://x/api/superatom/connectors/release', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${RELEASE_TOKEN}` }, body: JSON.stringify({ manifest, code: r.code }) })
    if (!res.ok) throw new Error(`${r.manifest.id} was not released: ${await res.text()}`)
  }
}
