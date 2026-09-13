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

/**
 * Hash the bytes behind a URL.
 *
 * Retries transient network failures: media hosts drop connections mid-body, and
 * a verifier that gives up on one closed socket reports nothing at all. An HTTP
 * error status is not retried — that is an answer, not a hiccup.
 */
export async function hashUrl(url, { attempts = 4, backoffMs = 1500 } = {}) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw Object.assign(new Error(`cannot fetch media: HTTP ${res.status}`), { final: true })
      return createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex')
    } catch (e) {
      if (e.final) throw e
      lastErr = e
      if (i < attempts - 1) await new Promise(r => setTimeout(r, backoffMs * 2 ** i))
    }
  }
  throw new Error(`cannot fetch media after ${attempts} attempts: ${lastErr?.cause?.code ?? lastErr?.message}`)
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
