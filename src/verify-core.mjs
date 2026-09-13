/**
 * Third-party verification: the decision, with no I/O.
 *
 * Split from verify.mjs so a platform can check a file against knowledge it
 * already holds without installing a DKG client or making a network call.
 */
import { effectiveState } from './gate.mjs'
import { STATE_REVOKED } from './vocab.mjs'

export const CLEAR = 'CLEAR'
export const TAINTED = 'TAINTED'
export const UNKNOWN = 'UNKNOWN'

/**
 * Judge one derivation edge on its own.
 */
function judgeEdge(k, derivation, sha256, now) {
  const grant = k.grants.find(g => g.id === derivation.authorizedUnder)
  if (!grant) {
    return {
      verdict: TAINTED, sha256, derivation,
      reason: `derivation cites grant ${derivation.authorizedUnder}, which is not present in this graph`,
    }
  }

  const st = effectiveState(grant, k.assertions, { now })
  if (st.state === STATE_REVOKED) {
    return {
      verdict: TAINTED, sha256, derivation, grant,
      reason: `the grant authorising this file was revoked at ${st.at} by ${grant.grantor}`,
      ignoredForgeries: st.ignoredForgeries,
    }
  }

  // The capability that actually served must itself have been permitted. A
  // derivation naming a capability outside the grant means the gate was bypassed.
  if (!grant.permitsCapability.includes(derivation.servedCapability)) {
    return {
      verdict: TAINTED, sha256, derivation, grant,
      reason: `served by "${derivation.servedCapability}", which grant ${grant.id} never permitted`,
    }
  }

  const expired = grant.validUntil && Date.parse(now) > Date.parse(grant.validUntil)
  return {
    verdict: expired ? TAINTED : CLEAR,
    sha256, derivation, grant,
    grantor: grant.grantor,
    reason: expired
      ? `the authorising grant expired at ${grant.validUntil}`
      : `authorised by ${grant.grantor} under ${grant.id}, served by "${derivation.servedCapability}"`,
    ignoredForgeries: st.ignoredForgeries,
  }
}

/**
 * The decision itself, with no I/O — same split as the gate, for the same
 * reason: the policy should be readable and testable on its own.
 *
 * The same bytes can carry more than one derivation edge. Every edge is judged,
 * and the file is CLEAR only if every edge is. Two reasons:
 *
 *  - Determinism. Picking "the first" edge makes the verdict depend on the order
 *    a SPARQL engine happens to return rows in.
 *  - Laundering. If one clear edge were enough, anyone could make a file made
 *    under a revoked grant look clean by linking the same hash to some unrelated
 *    live grant. A new grant can authorise new renders; it cannot retroactively
 *    clear an artifact whose authorisation was withdrawn.
 */
export function verifyKnowledge(k, sha256, { now = new Date().toISOString() } = {}) {
  const edges = k.derivations
    .filter(d => d.outputSha256 === sha256)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))

  if (edges.length === 0) {
    return {
      verdict: UNKNOWN, sha256, edges: 0,
      reason: 'no derivation edge for these bytes — this file was not produced through a Mandate gate, '
            + 'or it was re-encoded after delivery',
    }
  }

  const judged = edges.map(d => judgeEdge(k, d, sha256, now))
  const tainted = judged.find(j => j.verdict === TAINTED)
  const primary = tainted ?? judged[0]
  return {
    ...primary,
    edges: judged.length,
    judgements: judged.map(j => ({ derivation: j.derivation.id, grant: j.grant?.id ?? null, verdict: j.verdict, reason: j.reason })),
    reason: judged.length > 1
      ? `${primary.reason} (${judged.length} derivation edges for these bytes; ${judged.filter(j => j.verdict === TAINTED).length} tainted)`
      : primary.reason,
  }
}
