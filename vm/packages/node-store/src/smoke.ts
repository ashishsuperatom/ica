import { NodeStore } from './index.js'

const s = new NodeStore(':memory:')

// A program that uses two units; one unit uses another (a dependency chain).
s.putNode({ id: 'prog:dead-stock', kind: 'program', label: 'dead-stock-by-branch',
  summary: 'dead stock situation across branches', file_path: 'programs/provisional/dead-stock.ts' })
s.putNode({ id: 'unit:find_dead_stock', kind: 'unit', label: 'find_dead_stock',
  summary: 'on-hand SKUs with no sale since now minus cutoff', file_path: 'units/find_dead_stock.ts',
  props: { params: { cutoff: { type: 'number', default: 90 } } } })
s.putNode({ id: 'unit:join_stock_sales', kind: 'unit', label: 'join_stock_sales',
  summary: 'join stock levels to sales velocity by sku' })
s.putNode({ id: 'unit:value_at_cost', kind: 'unit', label: 'value_at_cost',
  summary: 'qty on hand times unit cost' })

s.putEdge({ from: 'unit:find_dead_stock', to: 'unit:join_stock_sales', type: 'uses' })
s.putEdge({ from: 'unit:find_dead_stock', to: 'unit:value_at_cost', type: 'uses' })
s.putEdge({ from: 'prog:dead-stock', to: 'unit:find_dead_stock', type: 'uses' })
s.putEdge({ from: 'unit:find_dead_stock', to: 'prog:dead-stock', type: 'belongs_to' })

console.log('search "dead stock" ->', s.search('dead stock').map(h => `${h.label}(${h.score.toFixed(2)})`))
console.log('search kind=unit "sku" ->', s.search('sku', { kind: 'unit' }).map(h => h.label))
console.log('deps of prog ->', s.dependencies('prog:dead-stock').map(n => `${n.label}@${n.depth}`))
console.log('dependents of join_stock_sales ->', s.dependents('unit:join_stock_sales').map(n => `${n.label}@${n.depth}`))
console.log('neighbors out uses find_dead_stock ->', s.neighbors('unit:find_dead_stock', { type: 'uses' }).map(n => n.label))
console.log('getNode props ->', JSON.stringify(s.getNode('unit:find_dead_stock')?.props))

// time-travel: retire then confirm it drops from live search
s.retire('unit:value_at_cost')
console.log('after retire, search "cost" live ->', s.search('cost').map(h => h.label))
console.log('after retire, includeRetired ->', s.search('cost', { includeRetired: true }).map(h => h.label))

s.close()
console.log('OK')
