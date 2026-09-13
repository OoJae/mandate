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
 * The decision itself, with no I/O — same split as the gate, for the same
 * reason: the policy should be readable and testable on its own.
 */
export function verifyKnowledge(k, sha256, { now = new Date().toISOString() } = {}) {
  const derivation = k.derivations.find(d => d.outputSha256 === sha256)
  if (!derivation) {
    return {
      verdict: UNKNOWN, sha256,
      reason: 'no derivation edge for these bytes — this file was not produced through a Mandate gate, '
            + 'or it was re-encoded after delivery',
    }
  }

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
