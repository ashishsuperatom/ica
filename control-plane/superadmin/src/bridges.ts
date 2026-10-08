// The code connectors' ready bridges — each bundled with its driver when the connectors are built
// (connectors/bridges/<name>.bridge.mjs → connectors/dist/bridges.json). The platform only: the code is never sent to a
// browser. A connection made with such a connector is given its bridge at once, so it runs whatever door it was made from.
import BRIDGES from '../../../connectors/dist/bridges.json'
import { CONNECTORS } from '../../shared/connectors.js'

/** A code connector's ready bridge, or null when it has none (a custom source's bridge is written for it). */
export function readyBridge(connectorId: string): string | null {
  const name = CONNECTORS.find((k) => k.id === connectorId)?.bridge
  return (name && (BRIDGES as Record<string, string>)[name]) || null
}
