/**
 * The third-party check.
 *
 * A distributor, ad network, or platform is handed a finished file and nothing
 * else. No relationship with the producer, no relationship with the depicted
 * person, no reason to trust either. It hashes the bytes, finds the derivation
 * edge, follows `authorizedUnder` to the grant, and decides for itself.
 *
 * This is the argument for a public verifiable graph over a vendor database, and
 * it is why the grant clauses are published while the media never is. It also
 * covers the case C2PA cannot: platform recompression strips an embedded
 * manifest, but the content hash of the delivered file still resolves here.
 */
import { createHash } from 'node:crypto'
import { readKnowledge } from './resolve.mjs'
import { effectiveState } from './gate.mjs'
import { STATE_REVOKED } from './vocab.mjs'

export const CLEAR = 'CLEAR'
export const TAINTED = 'TAINTED'
export const UNKNOWN = 'UNKNOWN'

export async function hashUrl(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`cannot fetch media: HTTP ${res.status}`)
  return createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex')
}

/**
 * Verify a delivered file from its bytes alone.
 *
 * `node` is the VERIFIER's own node — deliberately not the producer's. Nothing
 * here asks the producer anything.
 */
export async function verifyMedia(node, contextGraph, mediaUrl, { now = new Date().toISOString() } = {}) {
  const sha256 = await hashUrl(mediaUrl)
  const k = await readKnowledge(node, contextGraph)
  return verifyKnowledge(k, sha256, { now })
}

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
