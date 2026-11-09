// THE PLATFORM'S OWN SOURCE'S CODE (SA-WAREHOUSE): the only connector code the platform carries (connectors/dist/bridges.json,
// built with it). Every other connector is Superatom's or an organisation's, read from its registry (docs/connectors-plan.md
// 9b). The platform only: the code is never sent to a browser.
import BRIDGES from '../../../connectors/dist/bridges.json'
import { CONNECTORS } from '../../shared/connectors.js'

/** The platform's own source's bridge, or null for any other connector. */
export function readyBridge(connectorId: string): string | null {
  const name = CONNECTORS.find((k) => k.id === connectorId)?.bridge
  return (name && (BRIDGES as Record<string, string>)[name]) || null
}
