/**
 * Hash the bytes behind a URL, safely.
 *
 * The verifier is meant to be wired into places that receive files from
 * strangers, so this never buffers a whole response, never follows a scheme
 * other than http(s), stops at a size limit, and gives up after a timeout.
 * A platform that hands it uploader-supplied URLs should still run it where it
 * cannot reach internal services.
 */
import { createHash } from 'node:crypto'

export class FetchBytesError extends Error {
  constructor(message, { status = null, final = false } = {}) {
    super(message)
    this.status = status
    this.final = final
  }
}

export const FETCH_DEFAULTS = Object.freeze({ maxBytes: 512 * 1024 * 1024, timeoutMs: 120_000, attempts: 4, backoffMs: 1500 })

function httpUrl(url) {
  let u
  try { u = new URL(url) } catch { throw new FetchBytesError(`not a URL: ${String(url).slice(0, 80)}`, { final: true }) }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new FetchBytesError(`only http(s) URLs can be hashed, got ${u.protocol}`, { final: true })
  return u
}

async function hashOnce(u, { maxBytes, timeoutMs, fetch }) {
  const res = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new FetchBytesError(`cannot fetch media: HTTP ${res.status}`, { status: res.status, final: true })
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {})
    throw new FetchBytesError(`media is ${declared} bytes, over the ${maxBytes}-byte limit`, { final: true })
  }
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of res.body) {
    bytes += chunk.byteLength
    if (bytes > maxBytes) throw new FetchBytesError(`media exceeds the ${maxBytes}-byte limit`, { final: true })
    hash.update(chunk)
  }
  return { sha256: hash.digest('hex'), bytes }
}

/**
 * SHA-256 of a URL's body, streamed. Retries dropped connections — media hosts
 * close sockets mid-body — but not HTTP errors, size violations or bad URLs.
 */
export async function sha256OfUrl(url, opts = {}) {
  const { maxBytes, timeoutMs, attempts, backoffMs } = { ...FETCH_DEFAULTS, ...opts }
  const fetch = opts.fetch ?? globalThis.fetch
  const sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  const u = httpUrl(url)
  let last
  for (let i = 0; i < attempts; i++) {
    try {
      return await hashOnce(u, { maxBytes, timeoutMs, fetch })
    } catch (e) {
      if (e instanceof FetchBytesError && e.final) throw e
      last = e
      if (i < attempts - 1) await sleep(backoffMs * 2 ** i)
    }
  }
  throw new FetchBytesError(`cannot fetch media after ${attempts} attempts: ${last?.cause?.code ?? last?.name ?? last?.message}`)
}
