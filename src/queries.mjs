/**
 * SPARQL for the provenance resolver. Pure string builders, no I/O.
 *
 * Every content query reads whole Knowledge Asset graphs — never cherry-picked
 * triples — so the resolver can check each graph against the triple count its
 * on-chain anchor declares. GRAPH ?g stays at the top level: the node's scoped
 * query route rejects GRAPH variables nested inside UNION.
 *
 * Prefix and `_meta` reads are ordered and paged (LIMIT/OFFSET), so a publisher
 * with thousands of Knowledge Assets can still be read in full. Discovery
 * queries use DISTINCT, so repeating a marker triple does not multiply rows.
 */
import { assertSafeIri, normAddress, isSha256, literalTerm } from './rdf-term.mjs'
import * as V from './vocab.mjs'

export const DKG = 'http://dkg.io/ontology/'
export const PROV_ATTRIBUTED = 'http://www.w3.org/ns/prov#wasAttributedTo'

export const META_PREDICATES = [
  `${DKG}kaUal`, `${DKG}assertionGraph`, `${DKG}status`, `${DKG}confirmationKind`,
  `${DKG}transactionHash`, `${DKG}materializedVersion`, `${DKG}publicTripleCount`, PROV_ATTRIBUTED,
]

const CG_ID = /^0x[0-9a-fA-F]{40}\/[A-Za-z0-9._-]{1,128}$/

export function assertContextGraphId(id) {
  if (typeof id !== 'string' || !CG_ID.test(id)) throw new Error(`invalid context graph id: ${JSON.stringify(id)}`)
  return id
}

export const cgIri = id => `did:dkg:context-graph:${assertContextGraphId(id)}`
export const vmPrefix = id => `${cgIri(id)}/_verifiable_memory/`
export const vmPublisherPrefix = (id, address) => {
  const a = normAddress(address)
  if (!a) throw new Error(`invalid publisher address: ${address}`)
  return `${vmPrefix(id)}${a}/`
}

const str = s => JSON.stringify(s)

/**
 * LIMIT one row more than a page holds, so the caller can tell whether another
 * page follows, and OFFSET past the pages already read.
 */
function page(limit, offset) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`invalid query limit: ${limit}`)
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`invalid query offset: ${offset}`)
  return ` LIMIT ${limit + 1}${offset ? ` OFFSET ${offset}` : ''}`
}

const metaPredicates = () => META_PREDICATES.map(p => `<${p}>`).join(', ')

/**
 * Anchor rows: one set per KA UAL, restricted to the predicates the resolver
 * trusts. With `publisher`, only that address's KAs — so nobody else publishing
 * into an open context graph can grow the read past its limit.
 */
export function metaQuery(contextGraphId, { limit, publisher, offset = 0 }) {
  const only = publisher === undefined ? '' : (() => {
    const a = normAddress(publisher)
    if (!a) throw new Error(`invalid publisher address: ${publisher}`)
    return `\n  FILTER(CONTAINS(LCASE(STR(?s)), ${str(`/${a}/`)}))`
  })()
  return `SELECT ?s ?p ?o WHERE {
  GRAPH <${cgIri(contextGraphId)}/_meta> { ?s ?p ?o }
  FILTER(STRSTARTS(STR(?s), "did:dkg:"))${only}
  FILTER(?p IN (${metaPredicates()}))
} ORDER BY ?s ?p ?o${page(limit, offset)}`
}

const UAL_IRI = /^did:dkg:[a-z0-9]+:\d+\/0x[0-9a-fA-F]{40}\/\d+$/

/**
 * Anchor rows for specific UALs — to attach transactions to reported forgeries.
 * `merkleRoot: true` also asks for `dkg:merkleRoot`, which the writer compares
 * with the root it sealed. The resolver does not ask for it: it has no sealed
 * root to compare, and an extra row per asset would only use up its row limits.
 * (A live v10.0.16 node writes it on the UAL as bare hex, checked 2026-09-14.)
 */
export function metaForUalsQuery(contextGraphId, uals, { limit, merkleRoot = false }) {
  if (!uals.length || uals.some(u => !UAL_IRI.test(u))) throw new Error('metaForUalsQuery needs valid UALs')
  const predicates = merkleRoot ? `${metaPredicates()}, <${DKG}merkleRoot>` : metaPredicates()
  return `SELECT ?s ?p ?o WHERE {
  GRAPH <${cgIri(contextGraphId)}/_meta> { ?s ?p ?o }
  FILTER(?s IN (${uals.map(u => `<${u}>`).join(', ')}))
  FILTER(?p IN (${predicates}))
} LIMIT ${limit + 1}`
}

/** How many Verifiable Memory graphs the node can currently see under a prefix. */
export function graphCountQuery(prefix) {
  return `SELECT (COUNT(DISTINCT ?g) AS ?n) WHERE {
  GRAPH ?g { ?s ?p ?o }
  FILTER(STRSTARTS(STR(?g), ${str(prefix)}))
}`
}

/** Every triple of every Verifiable Memory graph under a prefix, one ordered page at a time. */
export function prefixContentQuery(prefix, { limit, offset = 0 }) {
  return `SELECT ?g ?s ?p ?o WHERE {
  GRAPH ?g { ?s ?p ?o }
  FILTER(STRSTARTS(STR(?g), ${str(prefix)}))
} ORDER BY ?g ?s ?p ?o${page(limit, offset)}`
}

/**
 * Every triple of each Verifiable Memory graph under `prefix` that contains a
 * matching marker triple. One KA per graph, so this returns whole KAs.
 *
 * DISTINCT matters: without it a graph holding k marker triples returns every
 * triple k times, and a small asset from anyone could push the query past its
 * row limit.
 */
function markedContentQuery(prefix, markerPredicate, markerObject, { limit }) {
  return `SELECT DISTINCT ?g ?s ?p ?o WHERE {
  GRAPH ?g { ?m <${markerPredicate}> ${markerObject} . ?s ?p ?o }
  FILTER(STRSTARTS(STR(?g), ${str(prefix)}))
} LIMIT ${limit + 1}`
}

export function derivationsBySha256Query(prefix, sha256, opts) {
  if (!isSha256(sha256)) throw new Error('sha256 must be 64 lowercase hex characters')
  return markedContentQuery(prefix, V.outputSha256, literalTerm(sha256), opts)
}

export function derivationsByGrantQuery(prefix, grantId, opts) {
  return markedContentQuery(prefix, V.authorizedUnder, `<${assertSafeIri(grantId, 'grantId')}>`, opts)
}

/**
 * State-shaped rows about the given grants, anywhere in the context graph, with
 * the state value each claims — for forgery reporting, shared-memory warnings
 * and the merged-view twin check.
 */
export function stateSubjectsQuery(contextGraphId, grantIds, { limit }) {
  const ids = [].concat(grantIds)
  if (!ids.length) throw new Error('stateSubjectsQuery needs at least one grant id')
  return `SELECT DISTINCT ?g ?s ?o ?v WHERE {
  GRAPH ?g { ?s <${V.stateOf}> ?o . OPTIONAL { ?s <${V.state}> ?v } }
  FILTER(STRSTARTS(STR(?g), ${str(`${cgIri(contextGraphId)}/`)}))
  FILTER(?o IN (${ids.map(id => `<${assertSafeIri(id, 'grantId')}>`).join(', ')}))
} LIMIT ${limit + 1}`
}

/**
 * One merged-view graph (`<cg>/context/<id>`) of a context graph, if the node
 * holds any. Live v10.0.16 nodes materialise merged views only for data they
 * published themselves, so a node without any cannot be expected to show one.
 */
export function mergedViewProbeQuery(contextGraphId) {
  return `SELECT ?g WHERE {
  GRAPH ?g { ?s ?p ?o }
  FILTER(STRSTARTS(STR(?g), ${str(`${cgIri(contextGraphId)}/context/`)}))
} LIMIT 1`
}

/** Grant-shaped rows for a subject, anywhere in the context graph — for forgery reporting. */
export function grantSubjectsQuery(contextGraphId, subject, { limit }) {
  return `SELECT DISTINCT ?g ?s WHERE {
  GRAPH ?g { ?s <${V.subject}> ${literalTerm(subject, { field: 'subject' })} }
  FILTER(STRSTARTS(STR(?g), ${str(`${cgIri(contextGraphId)}/`)}))
} LIMIT ${limit + 1}`
}
