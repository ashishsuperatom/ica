// ODATA — what every connector to an OData service needs, written once (v2 and v4; a v3 service is read as v2 is). The
// generic `odata` connector, SAP S/4HANA and Business Central are each a few lines on top of it.
//
//   parseXml          a small XML reader (elements, attributes, namespaces, text), enough for an EDMX document; no
//                     DTD is ever expanded
//   readMetadata      a service's $metadata → its entity sets, their entity types (properties, keys, inherited ones),
//                     navigation properties and referential constraints, and what its annotations say of each (SAP's
//                     sap:label / sap:quickinfo, Core.Description, Common.Label — inline or in <Annotations> blocks)
//   entitiesOf        entity sets as the contract's entities: fields typed from their EDM types, keys, `references`
//                     (entity.property) from referential constraints, descriptions from annotations
//   serviceRootOf     the service root from whatever URL a person pastes (an entity set's, $metadata's, a key's)
//   signIn            the headers that sign a request in: none, basic, an API key in a header, OAuth client credentials
//                     (a token fetched once and kept until it expires)
//   odataSource       one service as the engine reads it: its metadata (kept a few minutes), its entities, and reads —
//                     $filter built from equalities (each value written as its EDM type asks) or given raw, $select,
//                     $orderby, $top, paging by d.__next (v2) and @odata.nextLink (v4), and /$count
//
// A query names an entity set and, beyond the contract's filters and limit, OData's own options:
//   {"entity": "Products", "filters": {"CategoryID": 1}, "filter": "UnitPrice gt 20", "select": ["ProductName"],
//    "orderby": "UnitPrice desc", "limit": 50}       — or "count": true for how many rows match.

import { ConnectorError, refusal, request, saidIn } from './api'
import type { ConnectorContext, Entity, Field, ReadRequest, ReadResult } from './contract'

// ── A SMALL XML READER ─────────────────────────────────────────────────────────────────────────────────────────────
// Elements with their local name and namespace (resolved from xmlns declarations), their attributes (as written, and
// by namespace for prefixed ones), their children and their text. Comments, processing instructions and a DOCTYPE are
// skipped; the five XML entities and character references are decoded; nothing else is expanded.

export interface XmlElement {
  /** Its local name (EntityType, not edm:EntityType). */
  name: string
  /** Its namespace's URI ('' when none). */
  ns: string
  /** Its attributes as written (sap:label, Name). */
  attrs: Record<string, string>
  /** Its prefixed attributes by namespace URI and local name. */
  nsAttrs: { ns: string; local: string; value: string }[]
  children: XmlElement[]
  text: string
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decodeXml = (s: string) => s.indexOf('&') < 0 ? s : s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] !== '#') return XML_ENTITIES[e] ?? m
  const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
  return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m
})
const splitName = (q: string): [string, string] => { const i = q.indexOf(':'); return i < 0 ? ['', q] : [q.slice(0, i), q.slice(i + 1)] }

export function parseXml(text: string): XmlElement {
  const bad = (why: string) => new ConnectorError(`the XML could not be read: ${why}`)
  const doc: XmlElement = { name: '#document', ns: '', attrs: {}, nsAttrs: [], children: [], text: '' }
  const stack: { el: XmlElement; qname: string; scope: Record<string, string> }[] = [{ el: doc, qname: '', scope: { xml: 'http://www.w3.org/XML/1998/namespace' } }]
  const ATTR = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let i = 0
  while (i < text.length) {
    const top = stack[stack.length - 1]
    const lt = text.indexOf('<', i)
    if (lt < 0) { top.el.text += decodeXml(text.slice(i)); break }
    if (lt > i) top.el.text += decodeXml(text.slice(i, lt))
    if (text.startsWith('<!--', lt)) { const e = text.indexOf('-->', lt + 4); if (e < 0) throw bad('a comment is not closed'); i = e + 3; continue }
    if (text.startsWith('<![CDATA[', lt)) { const e = text.indexOf(']]>', lt + 9); if (e < 0) throw bad('a CDATA section is not closed'); top.el.text += text.slice(lt + 9, e); i = e + 3; continue }
    if (text.startsWith('<?', lt)) { const e = text.indexOf('?>', lt + 2); if (e < 0) throw bad('a processing instruction is not closed'); i = e + 2; continue }
    if (text.startsWith('<!', lt)) {
      // A DOCTYPE, with any internal subset: skipped whole. The entities it may declare are never expanded.
      let depth = 0, j = lt + 2
      for (; j < text.length; j++) { const c = text[j]; if (c === '[') depth++; else if (c === ']') depth--; else if (c === '>' && depth <= 0) break }
      i = j + 1; continue
    }
    if (text[lt + 1] === '/') {
      const e = text.indexOf('>', lt); if (e < 0) throw bad('a closing tag is not closed')
      const qname = text.slice(lt + 2, e).trim()
      if (stack.length < 2 || top.qname !== qname) throw bad(`</${qname}> closes ${stack.length < 2 ? 'nothing' : `<${top.qname}>`}`)
      stack.pop(); i = e + 1; continue
    }
    // A start tag runs to its first '>' outside a quoted attribute value.
    let j = lt + 1, quote = ''
    for (; j < text.length; j++) { const c = text[j]; if (quote) { if (c === quote) quote = '' } else if (c === '"' || c === "'") quote = c; else if (c === '>') break }
    if (j >= text.length) throw bad('a tag is not closed')
    let body = text.slice(lt + 1, j)
    const selfClosing = body.endsWith('/'); if (selfClosing) body = body.slice(0, -1)
    const m = /^[^\s/>]+/.exec(body); if (!m) throw bad('a tag has no name')
    const qname = m[0]
    const raw: [string, string][] = []
    ATTR.lastIndex = qname.length
    for (let a: RegExpExecArray | null; (a = ATTR.exec(body)); ) raw.push([a[1], decodeXml(a[2] ?? a[3] ?? '')])
    let scope = top.scope
    if (raw.some(([k]) => k === 'xmlns' || k.startsWith('xmlns:'))) {
      scope = { ...scope }
      for (const [k, v] of raw) if (k === 'xmlns') scope[''] = v; else if (k.startsWith('xmlns:')) scope[k.slice(6)] = v
    }
    const [prefix, local] = splitName(qname)
    const el: XmlElement = { name: local, ns: scope[prefix] ?? '', attrs: {}, nsAttrs: [], children: [], text: '' }
    for (const [k, v] of raw) {
      if (k === 'xmlns' || k.startsWith('xmlns:')) continue
      el.attrs[k] = v
      const [p, l] = splitName(k)
      if (p) el.nsAttrs.push({ ns: scope[p] ?? '', local: l, value: v })
    }
    top.el.children.push(el)
    if (!selfClosing) stack.push({ el, qname, scope })
    i = j + 1
  }
  if (stack.length > 1) throw bad(`<${stack[stack.length - 1].qname}> is not closed`)
  if (!doc.children[0]) throw bad('there is no element in it')
  return doc.children[0]
}

/** The children of an element with this local name. */
export const kids = (el: XmlElement | undefined, name: string) => (el?.children ?? []).filter((c) => c.name === name)
/** An attribute: by namespace URI and local name when `ns` is given, else as written. */
export const attr = (el: XmlElement | undefined, name: string, ns?: string) => !el ? undefined : ns === undefined ? el.attrs[name] : el.nsAttrs.find((a) => a.ns === ns && a.local === name)?.value

// ── A SERVICE'S METADATA ───────────────────────────────────────────────────────────────────────────────────────────

const SAP = 'http://www.sap.com/Protocols/SAPData'
const sapAttr = (el: XmlElement | undefined, name: string) => attr(el, name, SAP) ?? attr(el, `sap:${name}`)

export interface ODataProperty {
  name: string
  /** Its type as the metadata writes it (Edm.Decimal, NS.Address, Collection(Edm.String)). */
  edm: string
  type: Field['type']
  nullable: boolean
  label?: string
  description?: string
  /** SAP: it may not be filtered on (sap:filterable="false"). */
  unfilterable?: boolean
  /** SAP: a read of its set must filter on it (sap:required-in-filter="true"). */
  requiredInFilter?: boolean
}
export interface ODataNavigation { name: string; /** The entity type it leads to (qualified). */ target: string; many: boolean; /** This type's property → the target's property (a referential constraint). */ constraints: { property: string; referenced: string }[] }
export interface ODataEntityType { qname: string; name: string; base?: string; keys: string[]; properties: ODataProperty[]; navigations: ODataNavigation[]; label?: string; description?: string }
export interface ODataEntitySet {
  name: string
  /** Its entity type (qualified). */
  type: string
  label?: string
  description?: string
  /** SAP: it can be read on its own (sap:addressable is not "false"). */
  addressable: boolean
  /** v4: where each navigation property leads (its path → an entity set's name). */
  bindings: Record<string, string>
}
export interface ODataMetadata { version: 2 | 4; namespaces: string[]; sets: ODataEntitySet[]; types: Map<string, ODataEntityType>; enums: Set<string> }

const EDM: Record<string, Field['type']> = {
  'Edm.String': 'string', 'Edm.Guid': 'string', 'Edm.Boolean': 'boolean', 'Edm.Byte': 'integer', 'Edm.SByte': 'integer', 'Edm.Int16': 'integer',
  'Edm.Int32': 'integer', 'Edm.Int64': 'integer', 'Edm.Single': 'number', 'Edm.Double': 'number', 'Edm.Decimal': 'number', 'Edm.Date': 'date',
  'Edm.DateTime': 'timestamp', 'Edm.DateTimeOffset': 'timestamp', 'Edm.Time': 'string', 'Edm.TimeOfDay': 'string', 'Edm.Duration': 'string',
  'Edm.Binary': 'string', 'Edm.Stream': 'string',
}
const collectionOf = (t: string) => /^Collection\((.+)\)$/.exec(t)?.[1]

/** A label and a longer description as one description: both when they differ. */
const describe = (label?: string, description?: string) => label && description && description.trim() !== label.trim() ? `${label} — ${description}` : (label || description || undefined)

/** Read a service's $metadata (EDMX, v2 or v4). */
export function readMetadata(xml: string): ODataMetadata {
  const root = parseXml(xml)
  if (root.name !== 'Edmx') throw new ConnectorError(`this is not an OData service's $metadata (its document is <${root.name}>, not <edmx:Edmx>)`)
  const version: 2 | 4 = Number.parseFloat(attr(root, 'Version') ?? '1') >= 4 ? 4 : 2
  const schemas = kids(root, 'DataServices').flatMap((d) => kids(d, 'Schema'))
  // A type is named by its schema's namespace or its alias: both are kept, the namespace as the one name.
  const alias = new Map<string, string>()
  for (const s of schemas) { const ns = attr(s, 'Namespace') ?? ''; alias.set(ns, ns); const a = attr(s, 'Alias'); if (a) alias.set(a, ns) }
  const qualify = (t: string): string => { const c = collectionOf(t); if (c) return `Collection(${qualify(c)})`; const i = t.lastIndexOf('.'); if (i < 0) return t; const ns = alias.get(t.slice(0, i)); return ns !== undefined ? `${ns}.${t.slice(i + 1)}` : t }

  // What annotations say, by target: inline <Annotation> children, and <Annotations Target="…"> blocks of the schema.
  const notes = new Map<string, { label?: string; description?: string }>()
  const noteOf = (target: string) => notes.get(target) ?? notes.set(target, {}).get(target)!
  const takeAnnotations = (target: string, els: XmlElement[]) => {
    for (const a of els) {
      const term = attr(a, 'Term') ?? '', last = term.slice(term.lastIndexOf('.') + 1)
      const value = attr(a, 'String') ?? kids(a, 'String')[0]?.text?.trim()
      if (!value) continue
      const n = noteOf(target)
      if (last === 'Label' && !n.label) n.label = value
      else if ((last === 'Description' || last === 'QuickInfo' || last === 'LongDescription') && !n.description) n.description = value
    }
  }
  const targetOf = (t: string) => { const [head, ...rest] = t.split('/'); return [qualify(head), ...rest].join('/') }
  for (const s of schemas) for (const block of kids(s, 'Annotations')) takeAnnotations(targetOf(attr(block, 'Target') ?? ''), kids(block, 'Annotation'))

  const enums = new Set<string>(), complex = new Set<string>(), defs = new Map<string, string>()
  for (const s of schemas) {
    const ns = attr(s, 'Namespace') ?? ''
    for (const e of kids(s, 'EnumType')) enums.add(`${ns}.${attr(e, 'Name')}`)
    for (const c of kids(s, 'ComplexType')) complex.add(`${ns}.${attr(c, 'Name')}`)
    for (const d of kids(s, 'TypeDefinition')) defs.set(`${ns}.${attr(d, 'Name')}`, attr(d, 'UnderlyingType') ?? 'Edm.String')
  }
  const typeOf = (edm: string): Field['type'] => {
    if (collectionOf(edm)) return 'json'
    if (EDM[edm]) return EDM[edm]
    if (/^Edm\.(Geography|Geometry)/.test(edm)) return 'json'
    if (enums.has(edm)) return 'string'
    if (complex.has(edm)) return 'json'
    if (defs.has(edm)) return typeOf(defs.get(edm)!)
    return 'string'
  }

  // v2: associations, with their ends (type, multiplicity) and referential constraints.
  const assoc = new Map<string, { ends: Record<string, { type: string; many: boolean }>; principal?: { role: string; props: string[] }; dependent?: { role: string; props: string[] } }>()
  for (const s of schemas) {
    const ns = attr(s, 'Namespace') ?? ''
    for (const a of kids(s, 'Association')) {
      const ends: Record<string, { type: string; many: boolean }> = {}
      for (const e of kids(a, 'End')) ends[attr(e, 'Role') ?? ''] = { type: qualify(attr(e, 'Type') ?? ''), many: attr(e, 'Multiplicity') === '*' }
      const rc = kids(a, 'ReferentialConstraint')[0]
      const side = (n: string) => { const x = kids(rc, n)[0]; return x ? { role: attr(x, 'Role') ?? '', props: kids(x, 'PropertyRef').map((p) => attr(p, 'Name') ?? '') } : undefined }
      assoc.set(`${ns}.${attr(a, 'Name')}`, { ends, principal: side('Principal'), dependent: side('Dependent') })
    }
  }

  const types = new Map<string, ODataEntityType>()
  for (const s of schemas) {
    const ns = attr(s, 'Namespace') ?? ''
    for (const t of kids(s, 'EntityType')) {
      const name = attr(t, 'Name') ?? '', qname = `${ns}.${name}`
      takeAnnotations(qname, kids(t, 'Annotation'))
      const tn = notes.get(qname)
      const properties: ODataProperty[] = kids(t, 'Property').map((p) => {
        const pname = attr(p, 'Name') ?? '', edm = qualify(attr(p, 'Type') ?? 'Edm.String')
        takeAnnotations(`${qname}/${pname}`, kids(p, 'Annotation'))
        const n = notes.get(`${qname}/${pname}`)
        const sapLabel = sapAttr(p, 'label'), sapInfo = sapAttr(p, 'quickinfo') ?? sapAttr(p, 'heading')
        // SAP marks a date held as Edm.DateTime with sap:display-format="Date": a day, not a moment.
        const type = edm === 'Edm.DateTime' && sapAttr(p, 'display-format') === 'Date' ? 'date' : typeOf(edm)
        return { name: pname, edm, type, nullable: attr(p, 'Nullable') !== 'false', label: sapLabel ?? n?.label, description: sapInfo ?? n?.description,
          ...(sapAttr(p, 'filterable') === 'false' ? { unfilterable: true } : {}), ...(sapAttr(p, 'required-in-filter') === 'true' ? { requiredInFilter: true } : {}) }
      })
      const navigations: ODataNavigation[] = kids(t, 'NavigationProperty').map((n) => {
        const nname = attr(n, 'Name') ?? ''
        const rel = attr(n, 'Relationship')
        if (rel) {   // v2: the association names both ends; a constraint whose dependent end is this one is a foreign key here
          const a = assoc.get(qualify(rel)), from = attr(n, 'FromRole') ?? '', to = attr(n, 'ToRole') ?? ''
          const end = a?.ends[to]
          const constraints = a?.dependent?.role === from && a.principal ? a.dependent.props.map((p, i) => ({ property: p, referenced: a.principal!.props[i] })) : []
          return { name: nname, target: end?.type ?? '', many: !!end?.many, constraints }
        }
        const ty = qualify(attr(n, 'Type') ?? ''), c = collectionOf(ty)
        return { name: nname, target: c ?? ty, many: !!c, constraints: c ? [] : kids(n, 'ReferentialConstraint').map((r) => ({ property: attr(r, 'Property') ?? '', referenced: attr(r, 'ReferencedProperty') ?? '' })) }
      })
      types.set(qname, { qname, name, base: attr(t, 'BaseType') ? qualify(attr(t, 'BaseType')!) : undefined, keys: kids(kids(t, 'Key')[0], 'PropertyRef').map((k) => attr(k, 'Name') ?? ''), properties, navigations,
        label: sapAttr(t, 'label') ?? tn?.label, description: tn?.description })
    }
  }
  // v2: an association whose constraint has no navigation property on its dependent side still says how they join.
  for (const a of assoc.values()) {
    if (!a.principal || !a.dependent) continue
    const dep = types.get(a.ends[a.dependent.role]?.type ?? ''), principal = a.ends[a.principal.role]?.type
    if (!dep || !principal) continue
    const pairs = a.dependent.props.map((p, i) => ({ property: p, referenced: a.principal!.props[i] }))
    if (!dep.navigations.some((n) => n.target === principal && n.constraints.length)) dep.navigations.push({ name: '', target: principal, many: false, constraints: pairs })
  }

  const sets: ODataEntitySet[] = []
  for (const s of schemas) for (const c of kids(s, 'EntityContainer')) {
    const cname = `${attr(s, 'Namespace')}.${attr(c, 'Name')}`
    for (const es of kids(c, 'EntitySet')) {
      const name = attr(es, 'Name') ?? ''
      takeAnnotations(`${cname}/${name}`, kids(es, 'Annotation'))
      const n = notes.get(`${cname}/${name}`)
      const bindings: Record<string, string> = {}
      for (const b of kids(es, 'NavigationPropertyBinding')) { const target = attr(b, 'Target') ?? ''; bindings[attr(b, 'Path') ?? ''] = target.slice(target.lastIndexOf('/') + 1) }
      sets.push({ name, type: qualify(attr(es, 'EntityType') ?? ''), label: sapAttr(es, 'label') ?? n?.label, description: n?.description, addressable: sapAttr(es, 'addressable') !== 'false', bindings })
    }
  }
  return { version, namespaces: schemas.map((s) => attr(s, 'Namespace') ?? ''), sets, types, enums }
}

/** An entity type with what it inherits: its keys, properties and navigation properties, its base's first. */
export function resolvedType(meta: ODataMetadata, qname: string): ODataEntityType | undefined {
  const own = meta.types.get(qname); if (!own) return undefined
  const seen = new Set([qname]); let keys = own.keys, properties = own.properties, navigations = own.navigations
  for (let b = own.base; b && !seen.has(b); ) {
    seen.add(b); const base = meta.types.get(b); if (!base) break
    if (!keys.length) keys = base.keys
    properties = [...base.properties, ...properties]; navigations = [...base.navigations, ...navigations]; b = base.base
  }
  return { ...own, keys, properties, navigations }
}

/** The entity sets as the contract's entities, each named `prefix` + its name. */
export function entitiesOf(meta: ODataMetadata, o: { prefix?: string; only?: (set: ODataEntitySet) => boolean } = {}): Entity[] {
  const prefix = o.prefix ?? ''
  const setOfType = (qname: string) => meta.sets.find((s) => s.type === qname)
  const out: Entity[] = []
  for (const set of meta.sets) {
    if (!set.addressable || (o.only && !o.only(set))) continue
    const t = resolvedType(meta, set.type); if (!t) continue
    const refs = new Map<string, string>(), links: string[] = []
    for (const n of t.navigations) {
      const target = (n.name && set.bindings[n.name]) || setOfType(n.target)?.name
      if (!target) continue
      for (const c of n.constraints) if (c.property && c.referenced && !refs.has(c.property)) refs.set(c.property, `${prefix}${target}.${c.referenced}`)
      if (n.name) links.push(`${n.name} → ${prefix}${target} (${n.many ? 'many' : 'one'})`)
    }
    const needed = t.properties.filter((p) => p.requiredInFilter).map((p) => p.name)
    const said = describe(set.label ?? t.label, set.description ?? t.description)
    const description = [said, links.length ? `Linked: ${links.join(', ')}.` : '', needed.length ? `A read must filter on ${needed.join(', ')}.` : ''].filter(Boolean).join(' ')
    out.push({
      name: `${prefix}${set.name}`, ...(set.label ?? t.label ? { label: set.label ?? t.label } : {}), ...(description ? { description } : {}),
      fields: t.properties.map((p) => {
        const key = t.keys.includes(p.name), d = describe(p.label, p.description)
        return { name: p.name, type: p.type, ...(d ? { description: d } : {}), ...(key ? { key: true } : {}), ...(refs.has(p.name) ? { references: refs.get(p.name) } : {}), nullable: key ? false : p.nullable }
      }),
    })
  }
  return out
}

// ── WHERE A SERVICE IS ─────────────────────────────────────────────────────────────────────────────────────────────

/** The service root (ending in /) from what a person pastes: the root itself, its $metadata, an entity set's URL, one
 *  entity's (a key in brackets), with or without query options. A `.svc` ends a root; so does SAP's
 *  /sap/opu/odata/sap/<SERVICE> (v2) and /sap/opu/odata4/sap/<group>/<repository>/sap/<service>/<version> (v4).
 *  Otherwise a trailing $-segment and anything from the first segment holding a key are dropped. */
export function serviceRootOf(pasted: string): string {
  let u: URL
  try { u = new URL(String(pasted ?? '').trim()) } catch { throw new ConnectorError(`"${pasted}" is not a web address (https://…)`) }
  if (!/^https?:$/.test(u.protocol)) throw new ConnectorError(`"${pasted}" is not a web address (https://…)`)
  const path = u.pathname
  const known = /^(.*?\.svc)(?=\/|$)/i.exec(path) ?? /^(.*?\/sap\/opu\/odata\/sap\/[^/]+)/i.exec(path) ?? /^(.*?\/sap\/opu\/odata4\/sap\/[^/]+\/[^/]+\/sap\/[^/]+\/\d{4})/i.exec(path)
  let root: string
  if (known) root = known[1]
  else {
    const parts = path.split('/').filter(Boolean)
    const cut = parts.findIndex((p) => p.startsWith('$') || (/\(.*\)$/.test(p) && !/^\(S\(/.test(p)))
    root = '/' + (cut < 0 ? parts : parts.slice(0, cut)).join('/')
  }
  return `${u.origin}${root.replace(/\/+$/, '')}/`
}

// ── SIGNING IN ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** How a connection signs in: what the generic connector's form asks (auth, user, password, apiKeyHeader, apiKey,
 *  tokenUrl, clientId, clientSecret, scope). */
export type SignIn =
  | { kind: 'none' }
  | { kind: 'basic'; user: string; password: string }
  | { kind: 'api-key'; header: string; key: string }
  | { kind: 'oauth-client'; tokenUrl: string; clientId: string; clientSecret: string; scope?: string }

/** The sign-in a connection's settings and secrets name (auth: none, basic, api-key, oauth-client). */
export function signInOf(settings: Record<string, any>, secrets: Record<string, string>): SignIn {
  const auth = String(settings.auth || 'none')
  if (auth === 'basic') return { kind: 'basic', user: String(settings.user ?? ''), password: String(secrets.password ?? '') }
  if (auth === 'api-key') return { kind: 'api-key', header: String(settings.apiKeyHeader || 'APIKey'), key: String(secrets.apiKey ?? '') }
  if (auth === 'oauth-client') return { kind: 'oauth-client', tokenUrl: String(settings.tokenUrl ?? ''), clientId: String(settings.clientId ?? ''), clientSecret: String(secrets.clientSecret ?? ''), scope: settings.scope ? String(settings.scope) : undefined }
  return { kind: 'none' }
}

const tokens = new WeakMap<ConnectorContext, Map<string, { token: string; until: number }>>()

/** An OAuth access token by the client-credentials grant, kept until a minute before it expires. The client's id and
 *  secret go in the form (client_secret_post); a token endpoint that refuses them there is asked again with them as
 *  basic authentication (client_secret_basic), as some (SAP's among them) want. */
export async function clientCredentials(ctx: ConnectorContext, s: { tokenUrl: string; clientId: string; clientSecret: string; scope?: string }, renew = false): Promise<string> {
  const cache = tokens.get(ctx) ?? tokens.set(ctx, new Map()).get(ctx)!
  const key = `${s.tokenUrl}\n${s.clientId}\n${s.scope ?? ''}`
  const kept = cache.get(key)
  if (kept && !renew && kept.until > Date.now()) return kept.token
  if (!/^https:\/\//i.test(s.tokenUrl)) throw new ConnectorError(`the token URL is not an https:// address ("${s.tokenUrl}")`)
  if (!s.clientId || !s.clientSecret) throw new ConnectorError('signing in needs the client id and the client secret')
  const host = new URL(s.tokenUrl).host
  const form = (withSecret: boolean) => new URLSearchParams({ grant_type: 'client_credentials', ...(withSecret ? { client_id: s.clientId, client_secret: s.clientSecret } : {}), ...(s.scope ? { scope: s.scope } : {}) }).toString()
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
  let r = await request(ctx, s.tokenUrl, { method: 'POST', headers, body: form(true) })
  if (!r.ok && (r.status === 400 || r.status === 401) && /invalid_client|unauthori[sz]ed/i.test(r.text)) {
    const again = await request(ctx, s.tokenUrl, { method: 'POST', headers: { ...headers, authorization: `Basic ${Buffer.from(`${encodeURIComponent(s.clientId)}:${encodeURIComponent(s.clientSecret)}`).toString('base64')}` }, body: form(false) })
    if (again.ok) r = again
  }
  if (!r.ok) throw new ConnectorError(`the sign-in at ${host} was refused (${r.status}): ${saidIn(r.text).slice(0, 300)}`, r.status)
  let data: any
  try { data = JSON.parse(r.text) } catch { throw new ConnectorError(`${host} answered the sign-in with something other than a token`) }
  if (typeof data?.access_token !== 'string') throw new ConnectorError(`${host} answered the sign-in without a token: ${saidIn(r.text).slice(0, 200)}`)
  const seconds = Number(data.expires_in) || 3600
  cache.set(key, { token: data.access_token, until: Date.now() + Math.max(30, seconds - 60) * 1000 })
  return data.access_token
}

/** The headers that sign a request in; `renew` asks for a new token (one was refused). */
export type Signer = (renew?: boolean) => Promise<Record<string, string>>
export function signerOf(ctx: ConnectorContext, s: SignIn): Signer {
  return async (renew = false) => {
    if (s.kind === 'basic') { if (!s.user) throw new ConnectorError('signing in needs a user name'); return { authorization: `Basic ${Buffer.from(`${s.user}:${s.password}`).toString('base64')}` } }
    if (s.kind === 'api-key') { if (!s.key) throw new ConnectorError('signing in needs the API key'); return { [s.header]: s.key } }
    if (s.kind === 'oauth-client') return { authorization: `Bearer ${await clientCredentials(ctx, s, renew)}` }
    return {}
  }
}

// ── READING A SERVICE ──────────────────────────────────────────────────────────────────────────────────────────────

export interface ODataService {
  /** Where its entity sets are read (ending in /). */
  root: string
  /** Its $metadata (default: root + $metadata). Relative next links are resolved against it, as OData says. */
  metadataUrl?: string
  /** Query parameters every request carries (SAP's sap-client). */
  params?: Record<string, string>
  /** The entity sets as read at the root, when they are not the metadata's own (Business Central's are a company's
   *  navigation properties): each set's name is its path under the root. */
  sets?: (meta: ODataMetadata) => ODataEntitySet[]
}

const withParams = (url: string, params?: Record<string, string>) => {
  const extra = Object.entries(params ?? {}).filter(([k, v]) => v !== '' && !new RegExp(`[?&]${k.replace(/[^\w-]/g, '')}=`).test(url))
  return extra.length ? `${url}${url.includes('?') ? '&' : '?'}${extra.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}` : url
}

const csrf = new WeakMap<ConnectorContext, { token: string; cookie: string }>()

/** One GET, signed: a refused token renewed once; a CSRF token fetched once if the system asks for one (SAP may, though
 *  a read needs none); its text, or a refusal in words. */
export async function odataGet(ctx: ConnectorContext, sign: Signer, url: string, accept: string): Promise<{ text: string; headers: Headers }> {
  let renew = false
  for (let attempt = 0; attempt < 3; attempt++) {
    const c = csrf.get(ctx)
    const r = await request(ctx, url, { headers: { accept, ...(await sign(renew)), ...(c ? { 'x-csrf-token': c.token, ...(c.cookie ? { cookie: c.cookie } : {}) } : {}) } })
    if (r.ok) return r
    if (r.status === 401 && !renew && (await sign()).authorization?.startsWith('Bearer ')) { renew = true; continue }
    if (r.status === 403 && /required/i.test(r.headers.get('x-csrf-token') ?? '') && !c) {
      const f = await ctx.fetch(url, { headers: { accept, ...(await sign()), 'x-csrf-token': 'Fetch' } })
      const token = f.headers.get('x-csrf-token') ?? ''
      const cookie = (typeof (f.headers as any).getSetCookie === 'function' ? (f.headers as any).getSetCookie() as string[] : [f.headers.get('set-cookie') ?? '']).map((x) => x.split(';')[0]).filter(Boolean).join('; ')
      await f.text().catch(() => {})
      if (token && !/required/i.test(token)) { csrf.set(ctx, { token, cookie }); continue }
    }
    throw refusal(r.status, r.text)
  }
  throw new ConnectorError(`${new URL(url).host} kept refusing`)
}

const metaCache = new WeakMap<ConnectorContext, Map<string, { at: number; meta: Promise<ODataMetadata> }>>()
const META_TTL = 5 * 60_000

/** A service's metadata, read and kept a few minutes (a change shows within that time). */
export function metadataOf(ctx: ConnectorContext, sign: Signer, svc: ODataService, fresh = false): Promise<ODataMetadata> {
  const url = withParams(svc.metadataUrl ?? `${svc.root}$metadata`, svc.params)
  const cache = metaCache.get(ctx) ?? metaCache.set(ctx, new Map()).get(ctx)!
  const kept = cache.get(url)
  if (kept && !fresh && Date.now() - kept.at < META_TTL) return kept.meta
  const meta = odataGet(ctx, sign, url, 'application/xml').then(({ text }) => {
    if (!/<(\w+:)?Edmx[\s>]/.test(text)) throw new ConnectorError(`${url.split('?')[0]} did not answer with an OData service's $metadata${/<html/i.test(text) ? ' (it sent a web page — perhaps a sign-in page)' : ''}`)
    return readMetadata(text)
  })
  cache.set(url, { at: Date.now(), meta })
  meta.catch(() => cache.delete(url))
  return meta
}

/** A value written as an OData literal of its property's type (v2 and v4 differ for dates, GUIDs and some numbers);
 *  a property of no known type takes the value's own. A value that cannot be its type is refused, so nothing a person
 *  or an agent gives can change the filter's meaning. */
export function literal(value: unknown, edm: string | undefined, version: 2 | 4, enums?: Set<string>): string {
  if (value === null) return 'null'
  const v = String(value)
  const no = (what: string) => new ConnectorError(`"${v}" is not ${what}`)
  const quoted = `'${v.replace(/'/g, "''")}'`
  const t = edm ?? (typeof value === 'number' ? (Number.isInteger(value) ? 'Edm.Int64' : 'Edm.Double') : typeof value === 'boolean' ? 'Edm.Boolean' : 'Edm.String')
  const INT = /^-?\d+$/, NUM = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/
  switch (t) {
    case 'Edm.Boolean': if (v === 'true' || v === 'false') return v; throw no('true or false')
    case 'Edm.Byte': case 'Edm.SByte': case 'Edm.Int16': case 'Edm.Int32': if (INT.test(v)) return v; throw no('a whole number')
    case 'Edm.Int64': if (INT.test(v)) return version === 2 && edm ? `${v}L` : v; throw no('a whole number')
    case 'Edm.Decimal': if (NUM.test(v)) return version === 2 ? `${v}M` : v; throw no('a number')
    case 'Edm.Double': if (NUM.test(v)) return version === 2 && edm ? `${v}d` : v; throw no('a number')
    case 'Edm.Single': if (NUM.test(v)) return version === 2 ? `${v}f` : v; throw no('a number')
    case 'Edm.Guid': if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return version === 2 ? `guid'${v}'` : v; throw no('a GUID')
    case 'Edm.Date': if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v; throw no('a date (2024-01-31)')
    case 'Edm.DateTime': {   // v2: a moment without a zone
      const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?))?/.exec(v); if (!m) throw no('a date (2024-01-31) or a time (2024-01-31T09:00:00)')
      return `datetime'${m[1]}T${(m[2] ?? '00:00:00').padEnd(8, ':00')}'`
    }
    case 'Edm.DateTimeOffset': {
      const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:\d{2})?)?$/.exec(v); if (!m) throw no('a date (2024-01-31) or a time (2024-01-31T09:00:00Z)')
      const iso = `${m[1]}T${(m[2] ?? '00:00:00').length === 5 ? `${m[2]}:00` : m[2] ?? '00:00:00'}${m[3] ?? 'Z'}`
      return version === 2 ? `datetimeoffset'${iso}'` : iso
    }
    case 'Edm.Time': if (/^-?P[\dDTHMS.]+$/.test(v)) return `time'${v}'`; throw no('a time span (PT9H30M)')
    case 'Edm.TimeOfDay': if (/^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v)) return v; throw no('a time of day (09:30:00)')
    case 'Edm.Duration': if (/^-?P[\dDTHMS.]+$/.test(v)) return `duration'${v}'`; throw no('a duration (PT9H30M)')
  }
  if (enums?.has(t)) { if (/^[\w]+$/.test(v)) return `${t}${quoted}`; throw no('one of its values') }
  return quoted
}

const NAME = /^[\p{L}_][\p{L}\p{N}_]*$/u
const PATH = /^[\p{L}_][\p{L}\p{N}_]*(\/[\p{L}_][\p{L}\p{N}_]*)*$/u
const listOf = (v: unknown) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => String(x).trim()).filter(Boolean)

/** The query options of a read: $filter from equalities (a list of values: any of them) and a raw filter, $select,
 *  $orderby. Names are checked against the entity type, so a typo says what there is. */
export function optionsOf(meta: ODataMetadata, type: ODataEntityType, req: ReadRequest): { filter: string; select: string[]; orderby: string[] } {
  const props = new Map(type.properties.map((p) => [p.name, p]))
  const known = (n: string) => props.has(n) || type.navigations.some((x) => x.name === n)
  const unknown = (n: string) => new ConnectorError(`${type.name} has no property "${n}" (its properties: ${type.properties.slice(0, 40).map((p) => p.name).join(', ')}${type.properties.length > 40 ? ', …' : ''})`)
  const parts: string[] = []
  for (const [k, v] of Object.entries((req.filters ?? {}) as Record<string, unknown>)) {
    if (!PATH.test(k)) throw new ConnectorError(`"${k}" is not a property name`)
    if (!known(k.split('/')[0])) throw unknown(k)
    const p = props.get(k)
    const one = (x: unknown) => `${k} eq ${literal(x, p?.edm, meta.version, meta.enums)}`
    if (Array.isArray(v)) { if (!v.length) throw new ConnectorError(`the filter on ${k} lists no values`); parts.push(v.length === 1 ? one(v[0]) : `(${v.map(one).join(' or ')})`) }
    else if (v !== null && typeof v === 'object') throw new ConnectorError(`the filter on ${k} is a value or a list of values; write anything else in "filter" (OData's own syntax)`)
    else parts.push(one(v))
  }
  const raw = req.query?.filter
  if (raw !== undefined && raw !== null && String(raw).trim()) parts.unshift(parts.length ? `(${String(raw).trim()})` : String(raw).trim())
  const select = listOf(req.query?.select)
  for (const s of select) { if (!PATH.test(s)) throw new ConnectorError(`"${s}" is not a property name`); if (!known(s.split('/')[0])) throw unknown(s) }
  const orderby = listOf(req.query?.orderby)
  for (const o of orderby) { const m = /^(\S+)(\s+(asc|desc))?$/i.exec(o); if (!m || !PATH.test(m[1])) throw new ConnectorError(`"${o}" is not an ordering (a property, then asc or desc)`); if (!known(m[1].split('/')[0])) throw unknown(m[1]) }
  return { filter: parts.join(' and '), select, orderby }
}

/** A row as the engine keeps it: OData's own bookkeeping (__metadata, @odata.*, links not expanded) left out, v2's
 *  /Date(…)/ as ISO times (a day when the property is a date), and numbers sent as text (Decimal, Int64) as numbers
 *  when that loses nothing. */
export function rowOf(raw: Record<string, unknown>, props: Map<string, ODataProperty>): Record<string, unknown> {
  const clean = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(clean)
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (Array.isArray(o.results) && Object.keys(o).every((k) => k === 'results' || k.startsWith('__'))) return clean(o.results)   // a v2 expanded collection
      return Object.fromEntries(Object.entries(o).filter(([k, x]) => !k.startsWith('__') && !k.includes('@') && !(x && typeof x === 'object' && '__deferred' in (x as object))).map(([k, x]) => [k, clean(x)]))
    }
    return v
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('__') || k.includes('@') || (v && typeof v === 'object' && '__deferred' in (v as object))) continue
    const p = props.get(k)
    let x: unknown = clean(v)
    if (typeof x === 'string') {
      const d = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(x)
      if (d) { const iso = new Date(Number(d[1])).toISOString(); x = p?.type === 'date' ? iso.slice(0, 10) : iso }
      else if (p && (p.type === 'number' || p.type === 'integer') && /^-?\d+(\.\d+)?$/.test(x) && x.replace(/[-.]/g, '').replace(/^0+(?=\d)/, '').length <= 15) x = Number(x)
    }
    out[k] = x
  }
  return out
}

/** The rows of one page and where the next starts, whatever the answer's shape: v2 ({ d: { results, __next } } or
 *  { d: [...] }), v4 ({ value, @odata.nextLink }), v3's light JSON ({ value, odata.nextLink }), or one entity. */
export function pageOf(data: any): { rows: Record<string, unknown>[]; next: string | null } {
  if (data && typeof data === 'object' && 'd' in data) {
    const d = data.d
    const rows = Array.isArray(d) ? d : Array.isArray(d?.results) ? d.results : d && typeof d === 'object' ? [d] : []
    return { rows, next: typeof d?.__next === 'string' ? d.__next : null }
  }
  if (data && typeof data === 'object' && Array.isArray(data.value)) return { rows: data.value, next: data['@odata.nextLink'] ?? data['odata.nextLink'] ?? null }
  return { rows: data && typeof data === 'object' ? [data] : [], next: null }
}

/** One service as the engine reads it. */
export function odataSource(ctx: ConnectorContext, sign: Signer, svc: ODataService) {
  const meta = async (fresh = false): Promise<ODataMetadata> => { const m = await metadataOf(ctx, sign, svc, fresh); return svc.sets ? { ...m, sets: svc.sets(m) } : m }
  const base = new URL(svc.metadataUrl ?? `${svc.root}$metadata`)
  const setIn = (m: ODataMetadata, name: string) => {
    const set = m.sets.find((s) => s.name === name)
    if (!set) throw new ConnectorError(`the service has no entity set "${name}" (its entity sets: ${m.sets.slice(0, 40).map((s) => s.name).join(', ')}${m.sets.length > 40 ? ', …' : ''})`)
    const type = resolvedType(m, set.type)
    if (!type) throw new ConnectorError(`the service's $metadata does not describe ${set.type}, the type of ${name}`)
    return { set, type }
  }
  const getJson = async (url: string) => {
    const { text } = await odataGet(ctx, sign, withParams(url, svc.params), 'application/json')
    try { return JSON.parse(text) } catch { throw new ConnectorError(`${url.split('?')[0]} did not answer with JSON${/<html/i.test(text) ? ' (it sent a web page — perhaps a sign-in page)' : ''}`) }
  }
  const source = {
    svc,
    metadata: meta,
    /** Its entity sets as entities. */
    async entities(o: { prefix?: string; only?: (set: ODataEntitySet) => boolean } = {}) { return entitiesOf(await meta(), o) },
    /** Read an entity set: the query's options, a page at a time to the limit. A cursor is a next link this service
     *  gave (nothing else is followed with its credentials). */
    async read(setName: string, req: ReadRequest): Promise<ReadResult> {
      const m = await meta()
      const { set, type } = setIn(m, setName)
      const o = optionsOf(m, type, req)
      const q: string[] = []
      if (o.filter) q.push(`$filter=${encodeURIComponent(o.filter)}`)
      if (req.query?.count === true) {
        const text = (await odataGet(ctx, sign, withParams(`${svc.root}${set.name}/$count${q.length ? `?${q.join('&')}` : ''}`, svc.params), 'text/plain')).text.trim()
        const n = Number(text)
        if (!Number.isFinite(n)) throw new ConnectorError(`${set.name}/$count answered "${text.slice(0, 80)}", not a number`)
        return { rows: [{ count: n }], total: n }
      }
      const limit = Math.max(1, Math.min(Number(req.limit) || 100, 5000))
      if (o.select.length) q.push(`$select=${encodeURIComponent(o.select.join(','))}`)
      if (o.orderby.length) q.push(`$orderby=${encodeURIComponent(o.orderby.join(','))}`)
      q.push(`$top=${limit}`)
      if (m.version === 2) q.push('$format=json')
      let url: string | null = `${svc.root}${set.name}?${q.join('&')}`
      if (req.cursor) {
        const c = new URL(String(req.cursor), base)
        if (c.origin !== base.origin) throw new ConnectorError('a cursor is a next link this service gave')
        url = c.href
      }
      const props = new Map(type.properties.map((p) => [p.name, p]))
      const rows: Record<string, unknown>[] = []
      while (url && rows.length < limit) {
        const page = pageOf(await getJson(url))
        rows.push(...page.rows.map((r) => rowOf(r, props)))
        const next: URL | null = page.next ? new URL(page.next, base) : null
        if (next && next.origin !== base.origin) throw new ConnectorError(`the service's next page is on another host (${next.host}); it is not followed`)
        url = next ? next.href : null
      }
      return { rows: rows.slice(0, limit), next: url }
    },
    /** One row of the first entity set (of those named, if any) that can be read without a filter: what a test reads. */
    async sample(names: string[] = []): Promise<{ set: string | null; rows: number }> {
      const m = await meta()
      const set = m.sets.find((s) => s.addressable && (!names.length || names.includes(s.name)) && !resolvedType(m, s.type)?.properties.some((p) => p.requiredInFilter))
      if (!set) return { set: null, rows: 0 }
      return { set: set.name, rows: (await source.read(set.name, { entity: set.name, limit: 1 })).rows.length }
    },
  }
  return source
}

/** What an agent is told about querying an OData service (after its own description). */
export const QUERY_HELP = 'A read may add OData\'s own options: {"entity": "<entity set>", "filters": {"<property>": value, "<other>": [any, of, these]}, "filter": "<an OData $filter>", "select": ["<property>", …], "orderby": "<property> desc", "limit": n}; {"entity": "…", "filters": {…}, "count": true} counts the rows that match. filters are equalities, each value written as its property\'s type asks. filter is OData\'s own syntax: eq ne gt ge lt le, and or not, parentheses; strings in single quotes (a quote doubled: \'O\'\'Brien\'); contains(Name,\'x\') and startswith(Name,\'x\') in OData v4, substringof(\'x\',Name) in v2; dates bare in v4 (2024-01-31, 2024-01-31T00:00:00Z), datetime\'2024-01-31T00:00:00\' in v2. A property path into a linked entity is written with a slash (Customer/Country).'
