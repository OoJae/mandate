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
 * Self-declared `mandate:grantor` values are checked against that publisher;
 * disagreement makes the object a forgery, reported with the graph and UAL it
 * came from. A grantor's own state assertion about its own grant is different:
 * whatever else is wrong with it, it counts as a revocation (fail-closed), and
 * its problems are reported alongside it.
 *
 * Every forgery carries `trusted`: whether it sits where a trusted party
 * publishes — a trusted producer's prefix in a derivations graph, or the
 * prefix of the address owning the grant or subject it claims in a grants
 * graph. A trusted party's unreadable record is its own record, so the gate
 * and the verifier must not treat it as if it were not there.
 *
 * reduceSlice judges objects, not whether a read is complete. Knowledge composed
 * by hand from anchorsFromMeta and reduceSlice must also run the resolver's
 * consistency rules (readPublisher in src/resolve.mjs) before its
 * consistency.ok may be true: checkConsistency over each publisher's prefix
 * (graph count, per-anchor triple counts, no unanchored graph, no missing known
 * UAL), no anchorsFromMeta problem, no row with an unreadable graph, an empty
 * `unreadable` list from reduceSlice (a grantor's revocation with an unreadable
 * stateOf is only there), and an empty read believed only when every attempt
 * answered. The gate and the verifier trust that flag and cannot recheck it.
 */
import * as V from './vocab.mjs'
import { DKG, PROV_ATTRIBUTED, vmPrefix } from './queries.mjs'
import {
  parseCell, asIri, asString, asDecimal, asInteger, asDateTime, agentAddress, subjectAddress,
  isSha256, isSafeIri, normAddress, XSD,
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

/**
 * Group rows into objects per graph, then per subject. Never merges across
 * Knowledge Assets.
 *
 * An object cell that does not parse is kept as an invalid term, never dropped:
 * dropping it would turn a present-but-odd `maxSpendUsd` or `state` into a
 * missing one, which reads as "no ceiling" or "no revocation". Rows whose graph,
 * subject or predicate cannot be read are returned in `unreadableRows`.
 */
export function objectsByGraph(contentRows, unreadableRows = []) {
  const graphs = new Map()
  for (const row of contentRows) {
    const g = asIri(row.g)
    const s = asIri(row.s)
    const p = asIri(row.p)
    const o = parseCell(row.o) ?? { type: 'invalid', value: '' }
    if (!g || !s || !p) { unreadableRows.push(row); continue }
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

/**
 * Raw string values of a predicate, for reporting what a rejected object claimed.
 *
 * Every distinct value is kept. The gate counts a trusted forgery against a grant,
 * and the verifier against a file, only when its claims name them, so a cap would
 * let a record hide the value that matters behind a few others. Deliberate
 * trade-off: a report can be as long as the object, which the prefix read's row
 * limits already bound.
 */
const claimed = (obj, predicate) => [...new Set((obj.props.get(predicate) ?? []).map(t => t.value).filter(v => typeof v === 'string'))]

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

/** The one IRI a GrantState names in `stateOf`, or null when that cannot be read. */
function readStateOf(obj) {
  const values = obj.props.get(V.stateOf) ?? []
  return values.length === 1 && values[0].type === 'iri' ? values[0].value : null
}

/**
 * A state assertion by the publisher that owns the grant it names.
 *
 * Revocation is terminal and fail-closed: the state is "active" only when the
 * value is exactly the plain string "active" and nothing else about the object
 * is wrong. Any other value, and any malformed object — an offset-less or
 * repeated stateAt, a missing or mismatched stateAuthor, a typed or IRI state —
 * counts as revoked, with its problems listed. The grantor is the only party
 * who can write here, so a mistake in its own revocation must not un-revoke.
 */
function buildState(obj, anchor, stateOf, typeProblems = []) {
  const problems = [...typeProblems]
  const one = (predicate, { required = true } = {}) => {
    const values = obj.props.get(predicate) ?? []
    if (values.length === 0) { if (required) problems.push(`missing ${localName(predicate)}`); return undefined }
    if (values.length > 1) { problems.push(`${values.length} values for ${localName(predicate)}`); return undefined }
    return values[0]
  }
  const stateCell = one(V.state)
  const plain = stateCell?.type === 'literal' && !stateCell.lang && (!stateCell.datatype || stateCell.datatype === `${XSD}string`)
  if (stateCell && !plain) problems.push('state is not a plain string')
  const raw = plain ? stateCell.value : null
  const authorCell = one(V.stateAuthor)
  const stateAuthor = authorCell?.type === 'iri' ? authorCell.value : null
  if (authorCell && agentAddress(stateAuthor) !== anchor.publisher) {
    problems.push(`stateAuthor ${stateAuthor ?? JSON.stringify(String(authorCell.value).slice(0, 80))} does not name ${anchor.publisher}`)
  }
  const atCell = one(V.stateAt, { required: false })
  const stateAt = atCell ? asIso(atCell) : null
  if (atCell && Number.isNaN(stateAt)) problems.push('invalid stateAt')
  return {
    id: obj.id,
    ual: anchor.ual,
    txHash: anchor.txHash,
    graph: obj.graph,
    publisher: anchor.publisher,
    stateOf,
    state: raw === 'active' && problems.length === 0 ? 'active' : 'revoked',
    stateAuthor,
    stateAt: typeof stateAt === 'string' ? stateAt : null,
    materializedVersion: anchor.materializedVersion,
    tier: 'vm',
    malformed: problems.length ? true : undefined,
    problems,
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
    // Required: the verifier judges the render against the grant's window, and
    // a missing date must not read as "inside it".
    derivedAt: single(obj, V.derivedAt, asIso),
  }
}

const VM_PATH = /\/_verifiable_memory\/(0x[0-9a-f]{40})\/\d+$/

/**
 * Reduce one context graph's rows to accepted objects and forgeries.
 *
 * `unreadable` lists what cannot be judged at all: rows with an unreadable
 * graph, subject or predicate, objects with an unreadable rdf:type, and state
 * assertions whose `stateOf` cannot be read. In a read of the grantor's or a
 * trusted producer's own prefix, any of these makes the read inconsistent.
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
  const unreadable = []
  const trusted = trustedProducers.map(normAddress).filter(Boolean)
  const unreadableRows = []
  const objects = objectsByGraph(contentRows, unreadableRows)
  for (const row of unreadableRows) {
    unreadable.push({ graph: typeof row.g === 'string' ? row.g : null, id: null, ual: anchors.get(asIri(row.g))?.ual ?? null, reason: 'a row with an unreadable graph, subject or predicate' })
  }

  for (const obj of objects) {
    const anchor = anchors.get(obj.graph)
    const types = typesOf(obj)
    // Who sits at this path, from the path itself, so an unanchored graph is still placed.
    const pathPublisher = anchor?.publisher ?? obj.graph.match(VM_PATH)?.[1] ?? null
    const claims = {
      subject: claimed(obj, V.subject), stateOf: claimed(obj, V.stateOf),
      outputSha256: claimed(obj, V.outputSha256).map(v => v.toLowerCase()), authorizedUnder: claimed(obj, V.authorizedUnder),
      billedUsd: claimed(obj, V.billedUsd),
    }
    const isTrusted = () => {
      if (!pathPublisher) return false
      if (role === 'derivations') return trusted.includes(pathPublisher)
      const owners = [
        ...claims.subject.map(subjectAddress),
        ...claims.stateOf.map(grantIriAddress),
        types.includes(V.LikenessGrant) ? grantIriAddress(obj.id) : null,
      ]
      return owners.includes(pathPublisher)
    }
    const report = (kind, detail) => forgeries.push({
      kind, detail, id: obj.id, graph: obj.graph, ual: anchor?.ual ?? null, txHash: anchor?.txHash ?? null,
      publisher: anchor?.publisher ?? null, trusted: isTrusted(), claims,
    })
    if ((obj.props.get(RDF_TYPE) ?? []).some(t => t.type !== 'iri')) {
      unreadable.push({ graph: obj.graph, id: obj.id, ual: anchor?.ual ?? null, reason: `${obj.id} has an unreadable rdf:type` })
      if (anchor) report('malformed', 'unreadable rdf:type')
      continue
    }
    // An object with no Mandate type is skipped, unless it carries Mandate
    // predicates where a trusted party publishes: a trusted producer's record
    // with a missing or renamed type still names a grant and a bill, and a
    // grantor's untyped statement about its own grant is still its statement.
    const mandatePredicates = [...obj.props.keys()].some(p => p.startsWith(V.NS))
    if (!types.some(t => t.startsWith(V.NS)) && !(mandatePredicates && isTrusted())) continue
    if (!anchor) { report('unanchored', 'no confirmed anchor for this graph'); continue }
    // A grantor's own statement about its own grant is a state whatever else it is typed as (contract 3).
    const stateOfIri = role === 'grants' ? readStateOf(obj) : null
    // Also when the stateOf naming its own grant cannot be read (a literal, or one of
    // several values): the statement is the grantor's, so it fails closed below as an
    // unreadable state rather than vanishing because it carries no GrantState type.
    const ownState = role === 'grants' && (stateOfIri === null
      ? claims.stateOf.some(v => grantIriAddress(v) === anchor.publisher)
      : grantIriAddress(stateOfIri) === anchor.publisher)

    try {
      if (role === 'grants' && (types.includes(V.GrantState) || ownState)) {
        const stateOf = stateOfIri
        if (stateOf === null) {
          unreadable.push({ graph: obj.graph, id: obj.id, ual: anchor.ual, reason: `state ${obj.id} has an unreadable stateOf` })
          report('malformed', 'unreadable stateOf')
          continue
        }
        const owner = grantIriAddress(stateOf)
        if (!owner) { warnings.push(`ignored ${obj.id} in ${anchor.ual}: refers to a non-current grant id`); continue }
        if (owner !== anchor.publisher) { report('state-not-by-grantor', `published by ${anchor.publisher} for a grant belonging to ${owner}`); continue }
        // Checked before the grant branch: an object typed both a state and a grant
        // would otherwise be judged as a grant, fail as one, and lose the revocation.
        const typeProblems = [
          ...(types.includes(V.GrantState) ? [] : ['not typed GrantState']),
          ...[V.LikenessGrant, V.Derivation, V.Refusal].filter(t => types.includes(t)).map(t => `also typed ${localName(t)}`),
          ...types.filter(t => t.startsWith(V.NS) && ![V.GrantState, V.LikenessGrant, V.Derivation, V.Refusal].includes(t)).map(t => `unknown type ${localName(t)}`),
        ]
        const st = buildState(obj, anchor, stateOf, typeProblems)
        if (st.malformed) warnings.push(`state ${obj.id} in ${anchor.ual} is malformed (${st.problems.join('; ')}); it counts as a revocation of ${stateOf}`)
        states.push(st)
      } else if (types.includes(V.LikenessGrant)) {
        if (role !== 'grants') { report('misplaced-grant', `a grant in a ${role} graph is never accepted`); continue }
        if (!GRANT_IRI.test(obj.id)) { warnings.push(`ignored ${obj.id} in ${anchor.ual}: not a current-format grant id`); continue }
        const g = buildGrant(obj, anchor)
        if (!g.subjectAddress) { report('grant-subject-invalid', `subject ${JSON.stringify(g.subject)} is not self-certifying`); continue }
        if (g.subjectAddress !== g.publisher) { report('grant-not-by-subject', `published by ${g.publisher} for a subject belonging to ${g.subjectAddress}`); continue }
        if (g.grantorAddress !== g.publisher) { report('grantor-literal-mismatch', `mandate:grantor names ${g.grantor} but ${g.publisher} published it`); continue }
        if (grantIriAddress(g.id) !== g.publisher) { report('grant-id-mismatch', `grant id names ${grantIriAddress(g.id)} but ${g.publisher} published it`); continue }
        grants.push(g)
      } else if (types.includes(V.GrantState)) {
        // Only a derivations graph reaches here: every state in a grants graph took the first branch.
        report('misplaced-state', `a state assertion in a ${role} graph is never accepted`)
      } else if (types.includes(V.Derivation)) {
        if (role !== 'derivations') { report('misplaced-derivation', `a derivation in a ${role} graph is never accepted`); continue }
        if (!DERIVATION_IRI.test(obj.id)) {
          // A trusted producer's own record is never only a warning, whatever its id looks like.
          if (isTrusted()) report('legacy-format', 'not a current-format derivation id')
          else warnings.push(`ignored ${obj.id} in ${anchor.ual}: not a current-format derivation id`)
          continue
        }
        const d = buildDerivation(obj, anchor, trusted)
        if (!d.id.startsWith(`urn:mandate:derivation:${d.outputSha256.slice(0, 16)}:`)) { report('derivation-id-mismatch', 'id does not match outputSha256'); continue }
        derivations.push(d)
      } else if (role === 'derivations' && isTrusted()) {
        // A trusted producer's record with no Derivation type (absent, renamed, or a
        // later version's) is still its record: reported, so the spend and the file
        // it names are unknown rather than silently absent.
        const refusalOnly = types.length > 0 && types.every(t => t === V.Refusal)
          && !claims.outputSha256.length && !claims.authorizedUnder.length && !claims.billedUsd.length
        if (!refusalOnly) report('malformed', types.length ? `not a Derivation (typed ${types.join(', ')})` : 'no rdf:type')
      } else if (types.some(t => t.startsWith(V.NS) && t !== V.Refusal)) {
        warnings.push(`ignored ${obj.id} in ${anchor.ual}: unrecognised type ${types.filter(t => t.startsWith(V.NS)).join(', ')}`)
      }
    } catch (e) {
      if (!(e instanceof Malformed)) throw e
      report('malformed', e.message)
    }
  }
  return { grants, states, derivations, forgeries, warnings, unreadable }
}
