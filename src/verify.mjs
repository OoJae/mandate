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

/**
 * SHA-256 of the bytes behind an http(s) URL, streamed with a size cap and timeout.
 * `opts` go to sha256OfUrl unchanged: maxBytes, timeoutMs, attempts, fetch.
 */
export async function hashUrl(url, opts = {}) {
  return (await sha256OfUrl(url, opts ?? {})).sha256
}

/**
 * Verify a delivered file from its bytes, the configured grants and derivations
 * graphs, and the producers this verifier trusts. The file itself carries no
 * metadata that is believed; everything else comes from those graphs.
 *
 * `node` should be the verifier's own node, not the producer's. `cfg` is the
 * readKnowledge configuration: the grants graph, the derivations graphs, and
 * which producers' edges the verifier believes.
 *
 * `mediaUrl` is fetched from wherever it points, redirects included. If it
 * comes from an uploader, run this where it cannot reach internal services, or
 * pass `fetchOptions.fetch` that enforces an allow-list (see fetch-bytes.mjs).
 * `fetchOptions` also sets maxBytes, timeoutMs and attempts.
 */
export async function verifyMedia(node, cfg, mediaUrl, { now = new Date().toISOString(), fetchOptions = {} } = {}) {
  const sha256 = await hashUrl(mediaUrl, fetchOptions)
  const k = await readKnowledge(node, cfg, { sha256 })
  return verifyKnowledge(k, sha256, { now })
}
