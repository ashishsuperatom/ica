// Avro object container files — just enough for Iceberg's manifests and manifest lists: write a file from a schema and
// records, read any file back by the schema in its header (null and deflate codecs). Longs are BigInt, so ids that do
// not fit in a double (snapshot ids) survive a round trip.

export type AvroSchema = string | { type: string; [k: string]: any } | AvroSchema[]
type Named = Map<string, AvroSchema>

const MAGIC = [0x4f, 0x62, 0x6a, 0x01]   // "Obj" 1
const enc = new TextEncoder(), dec = new TextDecoder()

class Out {
  private chunks: Uint8Array[] = []; private size = 0
  bytes(b: Uint8Array) { this.chunks.push(b); this.size += b.length }
  byte(n: number) { this.bytes(Uint8Array.of(n)) }
  long(v: bigint | number) {
    let n = BigInt(v); n = (n << 1n) ^ (n >> 63n)   // zigzag
    n = BigInt.asUintN(64, n)
    const out: number[] = []
    while (n > 0x7fn) { out.push(Number(n & 0x7fn) | 0x80); n >>= 7n }
    out.push(Number(n)); this.bytes(Uint8Array.from(out))
  }
  str(s: string) { const b = enc.encode(s); this.long(b.length); this.bytes(b) }
  blob(b: Uint8Array) { this.long(b.length); this.bytes(b) }
  done(): Uint8Array { const r = new Uint8Array(this.size); let o = 0; for (const c of this.chunks) { r.set(c, o); o += c.length } return r }
}

class In {
  o = 0
  constructor(public b: Uint8Array) {}
  byte() { return this.b[this.o++] }
  long(): bigint {
    let n = 0n, shift = 0n, x: number
    do { x = this.b[this.o++]; n |= BigInt(x & 0x7f) << shift; shift += 7n } while (x & 0x80)
    return (n >> 1n) ^ -(n & 1n)
  }
  take(n: number) { const r = this.b.subarray(this.o, this.o + n); this.o += n; return r }
  str() { return dec.decode(this.take(Number(this.long()))) }
}

const nameOf = (s: any, ns?: string) => (s.name.includes('.') || !ns ? s.name : `${ns}.${s.name}`)
function register(s: AvroSchema, named: Named, ns?: string) {
  if (Array.isArray(s)) { s.forEach((x) => register(x, named, ns)); return }
  if (typeof s === 'string') return
  if (s.type === 'record' || s.type === 'enum' || s.type === 'fixed') { named.set(nameOf(s, s.namespace ?? ns), s); named.set(s.name, s) }
  if (s.type === 'record') for (const f of s.fields) register(f.type, named, s.namespace ?? ns)
  if (s.type === 'array') register(s.items, named, ns)
  if (s.type === 'map') register(s.values, named, ns)
}
const resolve = (s: AvroSchema, named: Named): AvroSchema => (typeof s === 'string' && named.has(s) ? named.get(s)! : s)

function write(o: Out, s0: AvroSchema, v: any, named: Named) {
  const s = resolve(s0, named)
  if (Array.isArray(s)) {
    // a union: the first branch the value fits (null for null/undefined)
    const i = v === null || v === undefined ? s.findIndex((x) => x === 'null') : s.findIndex((x) => x !== 'null')
    if (i < 0) throw new Error(`avro: no branch of ${JSON.stringify(s)} for ${v}`)
    o.long(i); if (s[i] !== 'null') write(o, s[i], v, named); return
  }
  const t = typeof s === 'string' ? s : s.type
  switch (t) {
    case 'null': return
    case 'boolean': o.byte(v ? 1 : 0); return
    case 'int': case 'long': o.long(typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v)))); return
    case 'float': { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); o.bytes(b); return }
    case 'double': { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); o.bytes(b); return }
    case 'string': o.str(String(v)); return
    case 'bytes': o.blob(v); return
    case 'fixed': o.bytes(v); return
    case 'enum': o.long((s as any).symbols.indexOf(v)); return
    case 'array': { const a = v as any[]; if (a.length) { o.long(a.length); for (const x of a) write(o, (s as any).items, x, named) } o.long(0); return }
    case 'map': { const e = Object.entries(v ?? {}); if (e.length) { o.long(e.length); for (const [k, x] of e) { o.str(k); write(o, (s as any).values, x, named) } } o.long(0); return }
    case 'record': for (const f of (s as any).fields) write(o, f.type, v?.[f.name], named); return
    default: throw new Error(`avro: cannot write ${t}`)
  }
}

function read(i: In, s0: AvroSchema, named: Named): any {
  const s = resolve(s0, named)
  if (Array.isArray(s)) return read(i, s[Number(i.long())], named)
  const t = typeof s === 'string' ? s : s.type
  switch (t) {
    case 'null': return null
    case 'boolean': return i.byte() !== 0
    case 'int': return Number(i.long())
    case 'long': return i.long()
    case 'float': { const v = new DataView(i.b.buffer, i.b.byteOffset + i.o, 4).getFloat32(0, true); i.o += 4; return v }
    case 'double': { const v = new DataView(i.b.buffer, i.b.byteOffset + i.o, 8).getFloat64(0, true); i.o += 8; return v }
    case 'string': return i.str()
    case 'bytes': return i.take(Number(i.long()))
    case 'fixed': return i.take((s as any).size)
    case 'enum': return (s as any).symbols[Number(i.long())]
    case 'array': { const out: any[] = []; for (let n = Number(i.long()); n !== 0; n = Number(i.long())) { if (n < 0) { n = -n; i.long() } for (let k = 0; k < n; k++) out.push(read(i, (s as any).items, named)) } return out }
    case 'map': { const out: Record<string, any> = {}; for (let n = Number(i.long()); n !== 0; n = Number(i.long())) { if (n < 0) { n = -n; i.long() } for (let k = 0; k < n; k++) { const key = i.str(); out[key] = read(i, (s as any).values, named) } } return out }
    case 'record': { const out: Record<string, any> = {}; for (const f of (s as any).fields) out[f.name] = read(i, f.type, named); return out }
    default: throw new Error(`avro: cannot read ${t}`)
  }
}

/** An Avro container file: the schema, file metadata (strings), the records, uncompressed. */
export function writeAvro(schema: AvroSchema, records: any[], meta: Record<string, string> = {}): Uint8Array {
  const named: Named = new Map(); register(schema, named)
  const o = new Out()
  o.bytes(Uint8Array.from(MAGIC))
  const head: Record<string, Uint8Array> = { 'avro.schema': enc.encode(JSON.stringify(schema)), 'avro.codec': enc.encode('null') }
  for (const [k, v] of Object.entries(meta)) head[k] = enc.encode(v)
  o.long(Object.keys(head).length); for (const [k, v] of Object.entries(head)) { o.str(k); o.blob(v) } o.long(0)
  const sync = crypto.getRandomValues(new Uint8Array(16)); o.bytes(sync)
  if (records.length) {
    const body = new Out(); for (const r of records) write(body, schema, r, named)
    const b = body.done(); o.long(records.length); o.long(b.length); o.bytes(b); o.bytes(sync)
  }
  return o.done()
}

async function inflate(b: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate-raw')
  const stream = new Blob([b as unknown as ArrayBuffer]).stream().pipeThrough(ds)
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Read an Avro container file: its metadata and its records, by the schema it carries. */
export async function readAvro(bytes: Uint8Array): Promise<{ meta: Record<string, string>; schema: AvroSchema; records: any[] }> {
  const i = new In(bytes)
  if (!MAGIC.every((m, k) => bytes[k] === m)) throw new Error('avro: not an object container file')
  i.o = 4
  const meta: Record<string, string> = {}
  for (let n = Number(i.long()); n !== 0; n = Number(i.long())) { if (n < 0) { n = -n; i.long() } for (let k = 0; k < n; k++) { const key = i.str(); meta[key] = dec.decode(i.take(Number(i.long()))) } }
  const sync = i.take(16)
  const schema = JSON.parse(meta['avro.schema']) as AvroSchema
  const codec = meta['avro.codec'] ?? 'null'
  if (codec !== 'null' && codec !== 'deflate') throw new Error(`avro: the ${codec} codec is not read here`)
  const named: Named = new Map(); register(schema, named)
  const records: any[] = []
  while (i.o < bytes.length) {
    const count = Number(i.long()); const size = Number(i.long())
    const raw = i.take(size)
    const block = new In(codec === 'deflate' ? await inflate(raw) : raw)
    for (let k = 0; k < count; k++) records.push(read(block, schema, named))
    const s = i.take(16); if (!s.every((x, k) => x === sync[k])) throw new Error('avro: a block does not end in the file\'s sync marker')
  }
  return { meta, schema, records }
}
