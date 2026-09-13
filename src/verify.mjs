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
import { verifyKnowledge } from './verify-core.mjs'

export { CLEAR, TAINTED, UNKNOWN, verifyKnowledge } from './verify-core.mjs'

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
