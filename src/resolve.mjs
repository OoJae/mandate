/**
 * Read grant knowledge out of the DKG and shape it for the gate.
 *
 * The gate itself is pure and knows nothing about SPARQL or nodes. This module
 * is the only place that talks to the graph, so the policy stays readable and
 * the I/O stays testable in isolation.
 */
import * as V from './vocab.mjs'
import { parseQueryTable } from './sparql-table.mjs'

const SELECT_ALL = `SELECT ?s ?p ?o WHERE { ?s ?p ?o }`

/** Group flat (s,p,o) rows into objects, keeping repeated predicates as arrays. */
function group(rows) {
  const bySubject = new Map()
  for (const { s, p, o } of rows) {
    if (!s) continue
    if (!bySubject.has(s)) bySubject.set(s, { id: s })
    const obj = bySubject.get(s)
    const prev = obj[p]
    if (prev === undefined) obj[p] = o
    else if (Array.isArray(prev)) prev.push(o)
    else obj[p] = [prev, o]
  }
  return [...bySubject.values()]
}

const many = v => (v === undefined ? [] : Array.isArray(v) ? v : [v])
const one = v => (Array.isArray(v) ? v[0] : v)
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'

const isType = (o, t) => many(o[RDF_TYPE]).includes(t)

function toGrant(o) {
  return {
    id: o.id,
    grantor: one(o[V.grantor]),
    subject: one(o[V.subject]),
    consentClipSha256: one(o[V.consentClipSha256]) ?? null,
    permitsCapability: many(o[V.permitsCapability]),
    permitsUseClass: many(o[V.permitsUseClass]),
    forbidsUseClass: many(o[V.forbidsUseClass]),
    territory: many(o[V.territory]),
    validFrom: one(o[V.validFrom]) ?? null,
    validUntil: one(o[V.validUntil]) ?? null,
    maxSpendUsd: o[V.maxSpendUsd] != null ? Number(one(o[V.maxSpendUsd])) : null,
  }
}

function toState(o) {
  return {
    id: o.id,
    stateOf: one(o[V.stateOf]),
    state: one(o[V.state]),
    stateAuthor: one(o[V.stateAuthor]),
    stateAt: one(o[V.stateAt]),
  }
}

function toDerivation(o) {
  return {
    id: o.id,
    outputSha256: one(o[V.outputSha256]),
    servedCapability: one(o[V.servedCapability]),
    servedModelId: one(o[V.servedModelId]) ?? null,
    authorizedUnder: one(o[V.authorizedUnder]),
    loraId: one(o[V.loraId]) ?? null,
    sessionId: one(o[V.sessionId]) ?? null,
    billedUsd: o[V.billedUsd] != null ? Number(one(o[V.billedUsd])) : 0,
    derivedAt: one(o[V.derivedAt]) ?? null,
  }
}

/**
 * Pull every grant, state assertion and derivation edge a node can see across
 * one or more context graphs.
 *
 * State assertions are returned WITHOUT filtering by author. Authenticity is
 * decided in the gate, not here, so that a forged assertion is visible and
 * reportable rather than silently dropped on the way in.
 */
export async function readKnowledge(node, contextGraphs) {
  // Each party writes to a graph it owns — grants and revocations in the
  // grantor's, derivations in the producer's — so a reader usually needs several.
  const graphs = [].concat(contextGraphs)
  const outs = await Promise.all(graphs.map(cg => node.query(cg, SELECT_ALL)))
  const out = outs.join('\n')
  const objects = group(outs.flatMap(parseQueryTable))
  return {
    grants: objects.filter(o => isType(o, V.LikenessGrant)).map(toGrant),
    assertions: objects.filter(o => isType(o, V.GrantState)).map(toState),
    derivations: objects.filter(o => isType(o, V.Derivation)).map(toDerivation),
    raw: out,
  }
}

/** Spend already committed under a grant, summed from the derivation graph. */
export function priorSpendFor(grantId, derivations) {
  return derivations
    .filter(d => d.authorizedUnder === grantId)
    .reduce((sum, d) => sum + (d.billedUsd || 0), 0)
}

/**
 * Everything produced under a grant — the quarantine list a revocation implies.
 * Completeness depends on derivation edges being written eagerly at render time;
 * an unwritten derivation is treated as a failed render for exactly this reason.
 */
export function blastRadius(grantId, derivations) {
  const direct = derivations.filter(d => d.authorizedUnder === grantId)
  const loras = [...new Set(direct.map(d => d.loraId).filter(Boolean))]
  const viaLora = derivations.filter(d => d.loraId && loras.includes(d.loraId) && !direct.includes(d))
  return {
    loras,
    assets: [...direct, ...viaLora],
    totalBilledUsd: [...direct, ...viaLora].reduce((s, d) => s + (d.billedUsd || 0), 0),
  }
}
