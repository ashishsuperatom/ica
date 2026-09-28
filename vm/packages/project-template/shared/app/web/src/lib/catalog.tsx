// The catalog (dimensions, capabilities, windows) and the client, for every component below the shell.

import { createContext, useContext } from 'react'
import type { Client } from './client'
import type { Capability, Catalog, Dimension } from './wire'

export interface AppContextValue { catalog: Catalog; client: Client }
const AppContext = createContext<AppContextValue | null>(null)
export const AppProvider = AppContext.Provider

export function useApp(): AppContextValue {
  const v = useContext(AppContext)
  if (!v) throw new Error('useApp outside AppProvider')
  return v
}

export const capabilityOf = (c: Catalog, focus: string): Capability | undefined => c.capabilities.find((x) => x.focus === focus)
export const dimensionOf = (c: Catalog, key: string): Dimension | undefined => c.dimensions.find((x) => x.key === key)
export const dimLabel = (c: Catalog, key: string): string => dimensionOf(c, key)?.label ?? key

/** The scenarios in the order their roots appear, each with its root first and the rest after. */
export function scenarios(c: Catalog): { scenario: string; root?: Capability; others: Capability[] }[] {
  const order: string[] = []
  for (const cap of c.capabilities) if (!order.includes(cap.scenario)) order.push(cap.scenario)
  order.sort((a, b) => Number(!c.capabilities.some((x) => x.scenario === a && x.root)) - Number(!c.capabilities.some((x) => x.scenario === b && x.root)))
  return order.map((scenario) => ({ scenario, root: c.capabilities.find((x) => x.scenario === scenario && x.root), others: c.capabilities.filter((x) => x.scenario === scenario && !x.root) }))
}
