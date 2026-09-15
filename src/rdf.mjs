/**
 * Serialisation for the Mandate vocabulary.
 *
 * Grants are written as RDF because the whole argument for a shared graph is
 * that someone else's agent — a distributor, an auditor, a platform — can read
 * a grant without our code, our schema docs, or our permission.
 *
 * The primary output is wire quads ({subject, predicate, object} with bare IRIs
 * and N-Triples literals), which is what the DKG node's HTTP write API takes.
 * Turtle is derived from the same quads, so the two can never disagree.
 *
 * Every value is validated with the same functions the resolver uses to read
 * it back (src/rdf-term.mjs). A grant that would be read back as malformed is
 * refused here, before it can be anchored and paid for.
 */
import * as V from './vocab.mjs'
import {
  TermError, iriTerm, literalTerm, decimalTerm, dateTimeTerm, ntriplesTerm,
  agentAddress, subjectAddress, isSha256, asDateTime,
} from './rdf-term.mjs'

export { UnpublishableLiteralError, InvalidIriError, TermError } from './rdf-term.mjs'

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const CAPABILITY = /^[a-z0-9][a-z0-9-]{1,63}$/
const USE_CLASS = /^[a-z][a-z0-9-]{0,31}$/
const TERRITORY = /^[A-Z]{2}$/

const q = (subject, predicate, object) => ({ subject, predicate, object })

function tokens(values, pattern, field, { required = false } = {}) {
  const list = values === undefined || values === null ? [] : [].concat(values)
  if (required && list.length === 0) throw new TermError(`${field} must list at least one value`)
  const seen = new Set()
  for (const v of list) {
    if (typeof v !== 'string' || !pattern.test(v)) throw new TermError(`${field} has an invalid value: ${JSON.stringify(v)}`)
    if (seen.has(v)) throw new TermError(`${field} lists ${JSON.stringify(v)} twice`)
    seen.add(v)
  }
  return list
}

/**
 * Quads for one likeness grant. Clause data only — never media, names or
 * biometrics.
 *
 * `consentTranscript` is refused unless `allowTranscript` is set: a transcript
 * is the depicted person's own words, and a public Verifiable Memory graph is
 * permanent. Publish its hash, not the text.
 */
export function grantToQuads(g, { dkgSafe = true, allowTranscript = false } = {}) {
  const id = iriTerm(g.id, 'id')
  const grantorAddr = agentAddress(g.grantor)
  if (!grantorAddr) throw new TermError(`grantor must be a did:dkg:agent DID, got ${JSON.stringify(g.grantor)}`)
  const subjectAddr = subjectAddress(g.subject)
  if (!subjectAddr) {
    throw new TermError(`subject must be self-certifying, <grantor address>:<name>, got ${JSON.stringify(g.subject)}`)
  }
  if (subjectAddr !== grantorAddr) {
    throw new TermError(`subject ${g.subject} belongs to ${subjectAddr}, not to the grantor ${grantorAddr}`)
  }

  const capabilities = tokens(g.permitsCapability, CAPABILITY, 'permitsCapability', { required: true })
  const permits = tokens(g.permitsUseClass, USE_CLASS, 'permitsUseClass')
  const forbids = tokens(g.forbidsUseClass, USE_CLASS, 'forbidsUseClass')
  const territory = tokens(g.territory, TERRITORY, 'territory')

  const out = [
    q(id, RDF_TYPE, V.LikenessGrant),
    q(id, V.grantor, iriTerm(g.grantor, 'grantor')),
    q(id, V.subject, literalTerm(g.subject, { field: 'subject', dkgSafe })),
  ]
  if (g.consentClipSha256 !== undefined && g.consentClipSha256 !== null) {
    if (!isSha256(g.consentClipSha256)) throw new TermError('consentClipSha256 must be 64 lowercase hex characters')
    out.push(q(id, V.consentClipSha256, literalTerm(g.consentClipSha256, { field: 'consentClipSha256' })))
  }
  if (g.consentTranscript !== undefined && g.consentTranscript !== null) {
    if (!allowTranscript) {
      throw new TermError('consentTranscript would publish the depicted person\'s words permanently; '
        + 'publish consentClipSha256 instead, or pass allowTranscript explicitly')
    }
    out.push(q(id, V.consentTranscript, literalTerm(g.consentTranscript, { field: 'consentTranscript', dkgSafe })))
  }
  for (const c of capabilities) out.push(q(id, V.permitsCapability, literalTerm(c, { field: 'permitsCapability' })))
  for (const u of permits) out.push(q(id, V.permitsUseClass, literalTerm(u, { field: 'permitsUseClass' })))
  for (const u of forbids) out.push(q(id, V.forbidsUseClass, literalTerm(u, { field: 'forbidsUseClass' })))
  for (const t of territory) out.push(q(id, V.territory, literalTerm(t, { field: 'territory' })))

  if (g.validFrom !== undefined && g.validFrom !== null) out.push(q(id, V.validFrom, dateTimeTerm(g.validFrom, 'validFrom')))
  if (g.validUntil !== undefined && g.validUntil !== null) out.push(q(id, V.validUntil, dateTimeTerm(g.validUntil, 'validUntil')))
  if (g.validFrom && g.validUntil && !(asDateTime(new Date(g.validUntil).toISOString()) > asDateTime(new Date(g.validFrom).toISOString()))) {
    throw new TermError('validUntil must be later than validFrom')
  }
  if (g.maxSpendUsd !== undefined && g.maxSpendUsd !== null) out.push(q(id, V.maxSpendUsd, decimalTerm(g.maxSpendUsd, 'maxSpendUsd')))
  return out
}

/**
 * Quads for a revocation.
 *
 * Only 'revoked' is written: revocation is terminal per grant IRI, and renewal
 * means publishing a new grant. `stateAuthor` is descriptive — the resolver
 * attributes the assertion to whoever published it, and treats a stateAuthor
 * that disagrees with the publisher as a forgery.
 */
export function stateToQuads(s, { dkgSafe = true } = {}) {
  if (s.state !== 'revoked') throw new TermError(`only 'revoked' states are written; got ${JSON.stringify(s.state)}`)
  const id = iriTerm(s.id, 'id')
  if (!agentAddress(s.stateAuthor)) throw new TermError(`stateAuthor must be a did:dkg:agent DID, got ${JSON.stringify(s.stateAuthor)}`)
  return [
    q(id, RDF_TYPE, V.GrantState),
    q(id, V.stateOf, iriTerm(s.stateOf, 'stateOf')),
    q(id, V.state, literalTerm(s.state, { field: 'state', dkgSafe })),
    q(id, V.stateAuthor, iriTerm(s.stateAuthor, 'stateAuthor')),
    q(id, V.stateAt, dateTimeTerm(s.stateAt, 'stateAt')),
  ]
}

/** Quads for a derivation edge: what was made, and under whose permission. */
export function derivationToQuads(d, { dkgSafe = true } = {}) {
  const id = iriTerm(d.id, 'id')
  if (!isSha256(d.outputSha256)) throw new TermError('outputSha256 must be 64 lowercase hex characters')
  if (typeof d.servedCapability !== 'string' || !CAPABILITY.test(d.servedCapability)) {
    throw new TermError(`servedCapability has an invalid value: ${JSON.stringify(d.servedCapability)}`)
  }
  const out = [
    q(id, RDF_TYPE, V.Derivation),
    q(id, V.outputSha256, literalTerm(d.outputSha256, { field: 'outputSha256' })),
    q(id, V.servedCapability, literalTerm(d.servedCapability, { field: 'servedCapability' })),
    q(id, V.authorizedUnder, iriTerm(d.authorizedUnder, 'authorizedUnder')),
    q(id, V.derivedAt, dateTimeTerm(d.derivedAt, 'derivedAt')),
  ]
  if (d.servedModelId) out.push(q(id, V.servedModelId, literalTerm(d.servedModelId, { field: 'servedModelId', dkgSafe })))
  if (d.loraId) out.push(q(id, V.loraId, literalTerm(d.loraId, { field: 'loraId', dkgSafe })))
  // mandate:sessionId holds the platform job id, so reconcile() can join billed
  // jobs to derivation edges on one key.
  const jobId = d.jobId ?? d.sessionId
  if (jobId) out.push(q(id, V.sessionId, literalTerm(jobId, { field: 'jobId', dkgSafe })))
  if (d.billedUsd !== undefined && d.billedUsd !== null) out.push(q(id, V.billedUsd, decimalTerm(d.billedUsd, 'billedUsd')))
  return out
}

/** N-Triples (valid Turtle) for a list of wire quads. */
export function quadsToNTriples(quads) {
  return quads.map(x => `${ntriplesTerm(x.subject)} ${ntriplesTerm(x.predicate)} ${ntriplesTerm(x.object)} .`).join('\n') + '\n'
}

export const grantToTurtle = (g, opts) => quadsToNTriples(grantToQuads(g, opts))
export const stateToTurtle = (s, opts) => quadsToNTriples(stateToQuads(s, opts))
export const derivationToTurtle = (d, opts) => quadsToNTriples(derivationToQuads(d, opts))
