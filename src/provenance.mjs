/**
 * The provenance reducer: turns raw rows from a DKG node into knowledge the
 * gate can trust, with no I/O.
 *
 * Nothing here believes a literal about who wrote something. An object is
 * attributed to the address in the Verifiable Memory graph that holds it,
 *
 *   did:dkg:context-graph:<cg>/_verifiable_memory/<address>/<n>
 *
 * which the chain binds to its author: a Knowledge Asset's id is
 * (author << 96) | n, and sync rechecks the on-chain Merkle root. That graph
 * must be anchored by a confirmed `_meta` record whose UAL derives it, and it
 * must contain exactly the number of triples the anchor declares.
 *
 * Self-declared `mandate:grantor` and `mandate:stateAuthor` values are checked
 * against that publisher; disagreement makes the object a forgery, reported
 * with the graph and UAL it came from.
 */
import * as V from './vocab.mjs'
import { DKG, PROV_ATTRIBUTED, vmPrefix } from './queries.mjs'
import {
  parseCell, asIri, asString, asDecimal, asInteger, asDateTime, agentAddress, subjectAddress,
  isSha256, isSafeIri, normAddress,
} from './rdf-term.mjs'

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const UAL = /^did:dkg:[a-z0-9]+:\d+\/(0x[0-9a-fA-F]{40})\/(\d+)$/
const GRANT_IRI = /^urn:mandate:grant:(0x[0-9a-f]{40}):([a-z0-9][a-z0-9-]{0,62}):([0-9a-f]{16})$/
const DERIVATION_IRI = /^urn:mandate:derivation:([0-9a-f]{16}):([0-9a-f]{16})$/
const CAPABILITY = /^[a-z0-9][a-z0-9-]{1,63}$/
const USE_CLASS = /^[a-z][a-z0-9-]{0,31}$/
const TERRITORY = /^[A-Z]{2}$/

/** A grant IRI's embedded grantor address, or null for anything else. */
export function grantIriAddress(id) {
  const m = typeof id === 'string' ? id.match(GRANT_IRI) : null
  return m ? m[1] : null
}

/* ------------------------------------------------------------------------- */
/* Anchors                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Confirmed Knowledge Asset anchors from `<cg>/_meta` rows.
 *
 * Returns Map<assertionGraph, anchor>. A record is an anchor only if its subject
 * is a UAL that self-links through dkg:kaUal, its status is "confirmed", and its
 * dkg:assertionGraph equals the graph the UAL derives. prov:wasAttributedTo is
 * written only on the publishing node; where present it must name the same
 * address. Records failing a check are returned in `problems`.
 */
export function anchorsFromMeta(metaRows, contextGraphId) {
  const bySubject = new Map()
  for (const row of metaRows) {
    const s = asIri(row.s)
    const p = asIri(row.p)
    if (!s || !p) continue
    if (!bySubject.has(s)) bySubject.set(s, new Map())
    const props = bySubject.get(s)
    if (!props.has(p)) props.set(p, [])
    props.get(p).push(row.o)
  }

  const anchors = new Map()
  const problems = []
  const prefix = vmPrefix(contextGraphId)
  for (const [s, props] of bySubject) {
    const values = p => props.get(p) ?? []
    const m = s.match(UAL)
    if (!m) continue
    if (!values(`${DKG}kaUal`).map(asIri).includes(s)) continue
    const publisher = m[1].toLowerCase()
    const number = m[2]
    const expectedGraph = `${prefix}${publisher}/${number}`
    const problem = reason => problems.push({ ual: s, graph: expectedGraph, publisher, reason })

    const statuses = values(`${DKG}status`).map(asString)
    if (statuses.length !== 1 || statuses[0] !== 'confirmed') { problem(`status ${statuses.join(',') || 'missing'}`); continue }
    const graphs = values(`${DKG}assertionGraph`).map(asIri)
    if (graphs.length !== 1 || graphs[0] !== expectedGraph) { problem(`assertionGraph ${graphs.join(',') || 'missing'} does not match ${expectedGraph}`); continue }
    const attributed = values(PROV_ATTRIBUTED).map(asIri)
    if (attributed.some(a => agentAddress(a) !== publisher)) { problem(`wasAttributedTo ${attributed.join(',')} does not name ${publisher}`); continue }
    const counts = values(`${DKG}publicTripleCount`).map(asInteger)
    if (counts.length !== 1 || !Number.isFinite(counts[0])) { problem('publicTripleCount missing or invalid'); continue }

    anchors.set(expectedGraph, {
      ual: s,
      graph: expectedGraph,
      publisher,
      number,
      contextGraphId,
      publicTripleCount: counts[0],
      txHash: values(`${DKG}transactionHash`).map(asString)[0] ?? null,
      materializedVersion: values(`${DKG}materializedVersion`).map(asString)[0] ?? null,
      confirmationKind: values(`${DKG}confirmationKind`).map(asString)[0] ?? null,
    })
  }
  return { anchors, problems }
}

/* ------------------------------------------------------------------------- */
/* Consistency                                                                 */
/* ------------------------------------------------------------------------- */

function countRowsByGraph(contentRows, prefix = '') {
  const counts = new Map()
  for (const row of contentRows) {
    const g = asIri(row.g)
    if (!g || !g.startsWith(prefix)) continue
    counts.set(g, (counts.get(g) ?? 0) + 1)
  }
  return counts
}

/**
 * Is this read of one Verifiable Memory prefix complete?
 *
 * DKG v10.0.16 intermittently omits whole named graphs from query results. A
 * read counts only when the node's visible graph count equals the number of
 * anchors under the prefix, every anchored graph returned exactly its declared
 * triple count, no returned graph lacks an anchor, and every anchor seen on an
 * earlier read is still present.
 */
export function checkConsistency({ prefix, anchors, contentRows, visibleGraphCount, knownUals = [], pendingGraphs = new Set() }) {
  const under = [...anchors.values()].filter(a => a.graph.startsWith(prefix))
  const pendingUnder = [...pendingGraphs].filter(g => g.startsWith(prefix) && !anchors.has(g))
  const rowsByGraph = countRowsByGraph(contentRows, prefix)
  const fail = reason => ({ ok: false, reason })
  // A graph whose _meta record exists but is not confirmed may or may not be
  // visible yet; it is accounted for, and its content is never accepted.
  if (visibleGraphCount !== undefined
    && (visibleGraphCount < under.length || visibleGraphCount > under.length + pendingUnder.length)) {
    return fail(`node shows ${visibleGraphCount} graphs under ${prefix} but ${under.length} are anchored`)
  }
  for (const a of under) {
    const n = rowsByGraph.get(a.graph) ?? 0
    if (n !== a.publicTripleCount) return fail(`${a.ual} returned ${n} of ${a.publicTripleCount} triples`)
  }
  for (const g of rowsByGraph.keys()) {
    if (!anchors.has(g) && !pendingGraphs.has(g)) return fail(`graph ${g} has no confirmed anchor`)
  }
  const present = new Set(under.map(a => a.ual))
  const missing = knownUals.filter(u => !present.has(u))
  if (missing.length) return fail(`previously confirmed ${missing[0]} is missing from this read`)
  return { ok: true, reason: null }
}

/**
 * Consistency for a marker-filtered read (e.g. derivations for one file): every
 * returned graph must be anchored and complete. Graphs dropped entirely are
 * caught by the prefix graph count, which the caller checks as well.
 */
export function checkReturnedGraphs({ anchors, contentRows }) {
  for (const [g, n] of countRowsByGraph(contentRows)) {
    const a = anchors.get(g)
    if (!a) return { ok: false, reason: `graph ${g} has no confirmed anchor` }
    if (n !== a.publicTripleCount) return { ok: false, reason: `${a.ual} returned ${n} of ${a.publicTripleCount} triples` }
  }
  return { ok: true, reason: null }
}

/* ------------------------------------------------------------------------- */
/* Objects                                                                     */
/* ------------------------------------------------------------------------- */

/** Group rows into objects per graph, then per subject. Never merges across Knowledge Assets. */
export function objectsByGraph(contentRows) {
  const graphs = new Map()
  for (const row of contentRows) {
    const g = asIri(row.g)
    const s = asIri(row.s)
    const p = asIri(row.p)
    const o = parseCell(row.o)
    if (!g || !s || !p || !o || o.type === 'invalid') continue
    if (!graphs.has(g)) graphs.set(g, new Map())
    const subjects = graphs.get(g)
    if (!subjects.has(s)) subjects.set(s, { graph: g, id: s, props: new Map() })
    const props = subjects.get(s).props
    if (!props.has(p)) props.set(p, [])
    props.get(p).push(o)
  }
  return [...graphs.values()].flatMap(subjects => [...subjects.values()])
}

const typesOf = obj => (obj.props.get(RDF_TYPE) ?? []).filter(t => t.type === 'iri').map(t => t.value)
const localName = p => p.split('#').pop()

class Malformed extends Error {}

/** An xsd:dateTime cell as a UTC ISO string, or NaN when it is not strict ISO-8601 with an offset. */
const asIso = cell => {
  const ms = asDateTime(cell)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : NaN
}

/** Raw string values of a predicate, for reporting what a rejected object claimed. */
const claimed = (obj, predicate) => (obj.props.get(predicate) ?? []).map(t => t.value).filter(v => typeof v === 'string').slice(0, 4)

function single(obj, predicate, read, { required = true } = {}) {
  const values = obj.props.get(predicate) ?? []
  if (values.length === 0) {
    if (required) throw new Malformed(`missing ${localName(predicate)}`)
    return undefined
  }
  if (values.length > 1) throw new Malformed(`${values.length} values for ${localName(predicate)}`)
  const v = read(values[0])
  if (v === null || (typeof v === 'number' && Number.isNaN(v))) throw new Malformed(`invalid ${localName(predicate)}`)
  return v
}

function many(obj, predicate, pattern) {
  const values = (obj.props.get(predicate) ?? []).map(asString)
  if (values.some(v => v === null || !pattern.test(v))) throw new Malformed(`invalid ${localName(predicate)}`)
  if (new Set(values).size !== values.length) throw new Malformed(`duplicate ${localName(predicate)}`)
  return values
}

function buildGrant(obj, anchor) {
  const grantor = single(obj, V.grantor, asIri)
  const subject = single(obj, V.subject, asString)
  const grant = {
    id: obj.id,
    ual: anchor.ual,
    txHash: anchor.txHash,
    graph: obj.graph,
    publisher: anchor.publisher,
    grantor,
    grantorAddress: agentAddress(grantor),
    subject,
    subjectAddress: subjectAddress(subject),
    permitsCapability: many(obj, V.permitsCapability, CAPABILITY),
    permitsUseClass: many(obj, V.permitsUseClass, USE_CLASS),
    forbidsUseClass: many(obj, V.forbidsUseClass, USE_CLASS),
    territory: many(obj, V.territory, TERRITORY),
    validFrom: single(obj, V.validFrom, asIso, { required: false }) ?? null,
    validUntil: single(obj, V.validUntil, asIso, { required: false }) ?? null,
    maxSpendUsd: single(obj, V.maxSpendUsd, asDecimal, { required: false }) ?? null,
    consentClipSha256: single(obj, V.consentClipSha256, asString, { required: false }) ?? null,
    tier: 'vm',
  }
  if (grant.permitsCapability.length === 0) throw new Malformed('no permitsCapability')
  if (grant.validFrom && grant.validUntil && !(Date.parse(grant.validUntil) > Date.parse(grant.validFrom))) throw new Malformed('validUntil is not after validFrom')
  if (grant.consentClipSha256 !== null && !isSha256(grant.consentClipSha256)) throw new Malformed('invalid consentClipSha256')
  return grant
}

function buildState(obj, anchor) {
  const raw = single(obj, V.state, asString)
  return {
    id: obj.id,
    ual: anchor.ual,
    txHash: anchor.txHash,
    graph: obj.graph,
    publisher: anchor.publisher,
    stateOf: single(obj, V.stateOf, asIri),
    // Revocation is terminal and fail-closed: any value other than exactly
    // "active" counts as revoked, and "active" itself changes nothing.
    state: raw === 'active' ? 'active' : 'revoked',
    stateAuthor: single(obj, V.stateAuthor, asIri),
    stateAt: single(obj, V.stateAt, asIso, { required: false }) ?? null,
    materializedVersion: anchor.materializedVersion,
    tier: 'vm',
  }
}

function buildDerivation(obj, anchor, trustedProducers) {
  const sha = single(obj, V.outputSha256, asString)
  if (!isSha256(sha)) throw new Malformed('invalid outputSha256')
  const cap = single(obj, V.servedCapability, asString)
  if (!CAPABILITY.test(cap)) throw new Malformed('invalid servedCapability')
  const authorizedUnder = single(obj, V.authorizedUnder, asIri)
  if (!isSafeIri(authorizedUnder)) throw new Malformed('invalid authorizedUnder')
  return {
    id: obj.id,
    ual: anchor.ual,
    txHash: anchor.txHash,
    graph: obj.graph,
    publisher: anchor.publisher,
    trusted: trustedProducers.includes(anchor.publisher),
    outputSha256: sha,
    servedCapability: cap,
    servedModelId: single(obj, V.servedModelId, asString, { required: false }) ?? null,
    authorizedUnder,
    jobId: single(obj, V.sessionId, asString, { required: false }) ?? null,
    billedUsd: obj.props.has(V.billedUsd) ? single(obj, V.billedUsd, asDecimal) : null,
    derivedAt: single(obj, V.derivedAt, asIso, { required: false }) ?? null,
  }
}

/**
 * Reduce one context graph's rows to accepted objects and forgeries.
 *
 * @param {object} o
 * @param {'grants'|'derivations'} o.role
 * @param {Map} o.anchors                 from anchorsFromMeta
 * @param {Array} o.contentRows           g/s/p/o rows
 * @param {string[]} [o.trustedProducers] addresses whose derivations decide verdicts
 */
export function reduceSlice({ role, anchors, contentRows, trustedProducers = [] }) {
  const grants = []
  const states = []
  const derivations = []
  const forgeries = []
  const warnings = []
  const trusted = trustedProducers.map(normAddress).filter(Boolean)

  for (const obj of objectsByGraph(contentRows)) {
    const anchor = anchors.get(obj.graph)
    const types = typesOf(obj)
    const report = (kind, detail) => forgeries.push({
      kind, detail, id: obj.id, graph: obj.graph, ual: anchor?.ual ?? null, txHash: anchor?.txHash ?? null,
      publisher: anchor?.publisher ?? null,
      claims: {
        subject: claimed(obj, V.subject), stateOf: claimed(obj, V.stateOf),
        outputSha256: claimed(obj, V.outputSha256).map(v => v.toLowerCase()), authorizedUnder: claimed(obj, V.authorizedUnder),
      },
    })
    if (!types.some(t => t.startsWith(V.NS))) continue
    if (!anchor) { report('unanchored', 'no confirmed anchor for this graph'); continue }

    try {
      if (types.includes(V.LikenessGrant)) {
        if (role !== 'grants') { report('misplaced-grant', `a grant in a ${role} graph is never accepted`); continue }
        if (!GRANT_IRI.test(obj.id)) { warnings.push(`ignored ${obj.id} in ${anchor.ual}: not a current-format grant id`); continue }
        const g = buildGrant(obj, anchor)
        if (!g.subjectAddress) { report('grant-subject-invalid', `subject ${JSON.stringify(g.subject)} is not self-certifying`); continue }
        if (g.subjectAddress !== g.publisher) { report('grant-not-by-subject', `published by ${g.publisher} for a subject belonging to ${g.subjectAddress}`); continue }
        if (g.grantorAddress !== g.publisher) { report('grantor-literal-mismatch', `mandate:grantor names ${g.grantor} but ${g.publisher} published it`); continue }
        if (grantIriAddress(g.id) !== g.publisher) { report('grant-id-mismatch', `grant id names ${grantIriAddress(g.id)} but ${g.publisher} published it`); continue }
        grants.push(g)
      } else if (types.includes(V.GrantState)) {
        if (role !== 'grants') { report('misplaced-state', `a state assertion in a ${role} graph is never accepted`); continue }
        const s = buildState(obj, anchor)
        const owner = grantIriAddress(s.stateOf)
        if (!owner) { warnings.push(`ignored ${obj.id} in ${anchor.ual}: refers to a non-current grant id`); continue }
        if (owner !== s.publisher) { report('state-not-by-grantor', `published by ${s.publisher} for a grant belonging to ${owner}`); continue }
        if (agentAddress(s.stateAuthor) !== s.publisher) { report('state-author-mismatch', `mandate:stateAuthor names ${s.stateAuthor} but ${s.publisher} published it`); continue }
        states.push(s)
      } else if (types.includes(V.Derivation)) {
        if (role !== 'derivations') { report('misplaced-derivation', `a derivation in a ${role} graph is never accepted`); continue }
        if (!DERIVATION_IRI.test(obj.id)) { warnings.push(`ignored ${obj.id} in ${anchor.ual}: not a current-format derivation id`); continue }
        const d = buildDerivation(obj, anchor, trusted)
        if (!d.id.startsWith(`urn:mandate:derivation:${d.outputSha256.slice(0, 16)}:`)) { report('derivation-id-mismatch', 'id does not match outputSha256'); continue }
        derivations.push(d)
      }
    } catch (e) {
      if (!(e instanceof Malformed)) throw e
      report('malformed', e.message)
    }
  }
  return { grants, states, derivations, forgeries, warnings }
}
