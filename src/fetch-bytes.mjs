/**
 * Hash the bytes behind a URL, safely.
 *
 * The verifier is meant to be wired into places that receive files from
 * strangers, so this never buffers a whole response, never follows a scheme
 * other than http(s), stops at a size limit, and gives up after a timeout.
 *
 * Trust boundary: this does not restrict hosts. It follows redirects, and a
 * URL (or a redirect) naming localhost, a private address or a cloud metadata
 * endpoint is fetched like any other; what comes back differs by target (HTTP
 * status, size, network error), so a caller who relays errors leaks a little
 * about what it can reach. A platform that hashes uploader-supplied URLs must
 * run this where it cannot reach internal services, or pass its own `fetch`
 * that enforces an allow-list.
 */
import { createHash } from 'node:crypto'

export class FetchBytesError extends Error {
  constructor(message, { status = null, final = false } = {}) {
    super(message)
    this.name = 'FetchBytesError'
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

/**
 * An option left out (or undefined or null) takes its default. One that is
 * given but unusable is refused: a NaN or negative size must never quietly
 * turn the cap off.
 */
function option(opts, name, { integer = false, min }) {
  const v = opts[name]
  if (v === undefined || v === null) return FETCH_DEFAULTS[name]
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || (integer && !Number.isInteger(v))) {
    throw new FetchBytesError(`${name} must be a finite ${integer ? 'whole ' : ''}number of at least ${min}, got ${String(v).slice(0, 40)}`, { final: true })
  }
  return v
}

async function hashOnce(u, { maxBytes, budget, deadline, fetch, now }) {
  const remainingMs = deadline - now()
  if (remainingMs <= 0) throw new FetchBytesError('timed out fetching media', { final: true })
  const res = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(remainingMs) })
  if (!res.ok) throw new FetchBytesError(`cannot fetch media: HTTP ${res.status}`, { status: res.status, final: true })
  if (!res.body) throw new FetchBytesError(`cannot fetch media: HTTP ${res.status} with no body`, { status: res.status, final: true })
  const declared = Number(res.headers.get('content-length'))
  if (res.headers.get('content-length') !== null && Number.isFinite(declared) && declared > Math.min(maxBytes, budget.left)) {
    await res.body.cancel().catch(() => {})
    throw new FetchBytesError(declared > maxBytes
      ? `media is ${declared} bytes, over the ${maxBytes}-byte limit`
      : `media is ${declared} bytes, more than is left of the ${maxBytes}-byte budget after earlier attempts`, { final: true })
  }
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of res.body) {
    bytes += chunk.byteLength
    budget.left -= chunk.byteLength
    if (bytes > maxBytes) throw new FetchBytesError(`media exceeds the ${maxBytes}-byte limit`, { final: true })
    if (budget.left < 0) throw new FetchBytesError(`fetching media used the whole ${maxBytes}-byte budget across retries`, { final: true })
    hash.update(chunk)
  }
  return { sha256: hash.digest('hex'), bytes }
}

/**
 * SHA-256 of a URL's body, streamed. Retries dropped connections — media hosts
 * close sockets mid-body — but not HTTP errors, size violations or bad URLs.
 *
 * `maxBytes` and `timeoutMs` are one budget and one deadline for the whole call,
 * retries included, so a hostile host cannot make it read four times the cap or
 * wait four times the timeout. The trade-off is deliberate: a large file whose
 * connection drops late may run out of budget and fail rather than be retried.
 */
export async function sha256OfUrl(url, opts = {}) {
  const maxBytes = option(opts, 'maxBytes', { min: 1 })
  const timeoutMs = option(opts, 'timeoutMs', { min: 1 })
  const attempts = option(opts, 'attempts', { integer: true, min: 1 })
  const backoffMs = option(opts, 'backoffMs', { min: 0 })
  const fetch = opts.fetch ?? globalThis.fetch
  const sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  const now = opts.now ?? Date.now
  const u = httpUrl(url)
  const deadline = now() + timeoutMs
  const budget = { left: maxBytes }
  let last
  let tried = 0
  for (let i = 0; i < attempts; i++) {
    tried++
    try {
      return await hashOnce(u, { maxBytes, budget, deadline, fetch, now })
    } catch (e) {
      if (e instanceof FetchBytesError && e.final) throw e
      last = e
      if (now() >= deadline) break
      if (i < attempts - 1) await sleep(Math.min(backoffMs * 2 ** i, Math.max(0, deadline - now())))
    }
  }
  const why = last?.cause?.code ?? last?.name ?? last?.message
  if (now() >= deadline) throw new FetchBytesError(`timed out fetching media after ${tried} attempt${tried === 1 ? '' : 's'} within ${timeoutMs}ms: ${why}`)
  throw new FetchBytesError(`cannot fetch media after ${tried} attempts: ${why}`)
}
