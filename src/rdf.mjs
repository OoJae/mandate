/**
 * Turtle serialisation for the Mandate vocabulary.
 *
 * Grants are written as RDF because the whole argument for a shared graph is
 * that someone else's agent — a distributor, an auditor, a platform — can read
 * a grant without our code, our schema docs, or our permission.
 */
import * as V from './vocab.mjs'

const lit = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
const iri = s => `<${s}>`
const term = s => (/^(https?:|urn:|did:)/.test(s) ? iri(s) : lit(s))

const PREFIX = `@prefix mandate: <${V.NS}> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`

/** Serialise one grant. Clause data only — never media, names, or biometrics. */
export function grantToTurtle(g) {
  const rows = []
  const add = (p, o) => rows.push(`  ${iri(p)} ${o} ;`)

  add(V.grantor, iri(g.grantor))
  add(V.subject, lit(g.subject))
  if (g.consentClipSha256) add(V.consentClipSha256, lit(g.consentClipSha256))
  if (g.consentTranscript) add(V.consentTranscript, lit(g.consentTranscript))
  for (const c of g.permitsCapability ?? []) add(V.permitsCapability, lit(c))
  for (const u of g.permitsUseClass ?? []) add(V.permitsUseClass, lit(u))
  for (const u of g.forbidsUseClass ?? []) add(V.forbidsUseClass, lit(u))
  for (const t of g.territory ?? []) add(V.territory, lit(t))
  if (g.validFrom) add(V.validFrom, `${lit(g.validFrom)}^^xsd:dateTime`)
  if (g.validUntil) add(V.validUntil, `${lit(g.validUntil)}^^xsd:dateTime`)
  if (g.maxSpendUsd != null) add(V.maxSpendUsd, `"${g.maxSpendUsd}"^^xsd:decimal`)

  return `${PREFIX}
${iri(g.id)}
  a ${iri(V.LikenessGrant)} ;
${rows.join('\n')}
.
`
}

/**
 * Serialise a state assertion.
 *
 * `stateAuthor` is written explicitly even though the KA seal also carries an
 * author: the resolver must be able to decide authenticity from the triples
 * alone, so that a third party reading the graph reaches the same verdict we do.
 */
export function stateToTurtle(s) {
  return `${PREFIX}
${iri(s.id)}
  a ${iri(V.GrantState)} ;
  ${iri(V.stateOf)} ${iri(s.stateOf)} ;
  ${iri(V.state)} ${lit(s.state)} ;
  ${iri(V.stateAuthor)} ${iri(s.stateAuthor)} ;
  ${iri(V.stateAt)} ${lit(s.stateAt)}^^xsd:dateTime ;
.
`
}

/** Serialise a derivation edge: what was made, and under whose permission. */
export function derivationToTurtle(d) {
  const rows = []
  const add = (p, o) => rows.push(`  ${iri(p)} ${o} ;`)
  add(V.outputSha256, lit(d.outputSha256))
  add(V.servedCapability, lit(d.servedCapability))
  if (d.servedModelId) add(V.servedModelId, lit(d.servedModelId))
  add(V.authorizedUnder, term(d.authorizedUnder))
  if (d.loraId) add(V.loraId, lit(d.loraId))
  if (d.sessionId) add(V.sessionId, lit(d.sessionId))
  if (d.billedUsd != null) add(V.billedUsd, `"${d.billedUsd}"^^xsd:decimal`)
  add(V.derivedAt, `${lit(d.derivedAt)}^^xsd:dateTime`)
  return `${PREFIX}
${iri(d.id)}
  a ${iri(V.Derivation)} ;
${rows.join('\n')}
.
`
}
