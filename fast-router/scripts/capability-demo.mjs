// Explore the RAW zero-shot capability of the GLiNER2 model — arbitrary intent taxonomies, multi-label
// classification, and NER across domains. Calls the model directly (not the fast-router suggest path),
// so nothing is domain-hardcoded: every label set below is passed at call time.
//   node scripts/capability-demo.mjs
import { GLiNER2ONNXRuntime } from '@lmoe/gliner-onnx'

const t0 = Date.now()
const model = await GLiNER2ONNXRuntime.fromPretrained(process.env.GLINER_MODEL || 'lmo3/gliner2-multi-v1-onnx')
console.log(`model loaded in ${Date.now() - t0}ms\n`)

const pct = (v) => `${(v * 100).toFixed(0)}%`
async function cls(tag, text, labels, multi = false) {
  const r = await model.classify(text, labels, { multiLabel: multi, threshold: 0 })
  const sorted = Object.entries(r).sort((a, b) => b[1] - a[1])
  console.log(`[${tag}] "${text}"`)
  console.log('   ' + sorted.map(([k, v], i) => `${i === 0 ? '▸ ' : ''}${k} ${pct(v)}`).join('  ·  ') + '\n')
}
async function ner(tag, text, labels) {
  const ents = await model.extractEntities(text, labels)
  console.log(`[${tag}] "${text}"`)
  console.log('   labels: ' + labels.join(', '))
  console.log('   → ' + (ents.length ? ents.map(e => `${e.text} = ${e.label} (${pct(e.score)})`).join('   ') : '(nothing found)') + '\n')
}

console.log('═══════ 1. INTENT CLASSIFICATION — different taxonomies / domains ═══════\n')
await cls('customer-support', 'My internet has been down for three days and nobody will help me.',
  ['billing issue', 'technical problem', 'cancellation', 'refund request', 'general inquiry'])
await cls('e-commerce', 'Can I return these shoes if they do not fit?',
  ['browse products', 'place order', 'compare items', 'file complaint', 'return or refund'])
await cls('banking', 'Someone made a charge on my card that I did not authorize.',
  ['check balance', 'transfer money', 'report fraud', 'loan inquiry', 'replace card'])
await cls('freight-analytics', 'show me total revenue by branch for last year',
  ['lookup', 'analysis', 'edit', 'action', 'unknown'])
await cls('freight-analytics', 'delete the duplicate vendor entry for the Raipur branch',
  ['lookup', 'analysis', 'edit', 'action', 'unknown'])

console.log('═══════ 2. MULTI-LABEL — sentiment & topic tagging ═══════\n')
await cls('sentiment', 'The delivery was fast but the product quality was disappointing.',
  ['positive', 'negative', 'neutral'], true)
await cls('topic-tags', 'The new AI chip sent the company stock to record highs this quarter.',
  ['sports', 'politics', 'technology', 'health', 'finance'], true)
await cls('urgency', 'URGENT: production database is down and customers cannot check out.',
  ['critical', 'high', 'normal', 'low'], true)

console.log('═══════ 3. NER — same model, five different domains ═══════\n')
await ner('general', 'Tim Cook announced in Cupertino that Apple will report earnings on May 2.',
  ['person', 'organization', 'location', 'date'])
await ner('medical', 'The patient was given 500mg of amoxicillin for a throat infection and later reported nausea.',
  ['drug', 'dosage', 'symptom', 'condition'])
await ner('legal', 'In Roe v. Wade the Supreme Court ruled in 1973 under the Fourteenth Amendment.',
  ['party', 'court', 'year', 'legal provision'])
await ner('finance', 'Tesla reported 25.2 billion dollars in revenue for Q3, beating analyst estimates.',
  ['company', 'money amount', 'financial metric', 'time period'])
await ner('freight', 'Full vendor review for Dahej to Udaipur on 14-wheeler trucks from the Raipur branch.',
  ['origin', 'destination', 'vehicle type', 'branch'])

process.exit(0)
