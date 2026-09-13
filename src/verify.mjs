/**
 * The third-party check.
 *
 * A distributor, ad network, or platform is handed a finished file. It has no
 * relationship with the producer or the depicted person and no reason to trust
 * either. Given the graph ids to read and the producers whose records it
 * accepts, it hashes the bytes, finds the derivations, follows each to its grant,
 * and decides for itself.
 *
 * This is the argument for a public verifiable graph over a vendor database, and
 * it is why the grant clauses are published while the media never is. It
 * complements embedded provenance such as C2PA rather than replacing it: it
 * matches exact bytes only, so a re-encoded file has a new hash and verifies
 * UNKNOWN.
 */
import { readKnowledge } from './resolve.mjs'
import { verifyKnowledge } from './verify-core.mjs'
import { sha256OfUrl } from './fetch-bytes.mjs'

export { CLEAR, TAINTED, UNKNOWN, INCONCLUSIVE, verifyKnowledge } from './verify-core.mjs'
export { FetchBytesError } from './fetch-bytes.mjs'

/** SHA-256 of the bytes behind an http(s) URL, streamed with a size cap and timeout. */
export async function hashUrl(url, opts) {
  return (await sha256OfUrl(url, opts)).sha256
}

/**
 * Verify a delivered file from its bytes alone.
 *
 * `node` should be the verifier's own node, not the producer's. `cfg` is the
 * readKnowledge configuration: the grants graph, the derivations graphs, and
 * which producers' edges the verifier believes.
 */
export async function verifyMedia(node, cfg, mediaUrl, { now = new Date().toISOString() } = {}) {
  const sha256 = await hashUrl(mediaUrl)
  const k = await readKnowledge(node, cfg, { sha256 })
  return verifyKnowledge(k, sha256, { now })
}
