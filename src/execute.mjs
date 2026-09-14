/**
 * Dispatching a permitted render and getting its media back.
 *
 * Only called after the gate has permitted the request. Everything here is
 * about not losing money or media: inline renders stay under Node's 300s stream
 * limit, slow capabilities go through a background job that is polled, a tool
 * error is a failure (never a result), and the media URL is taken from the
 * platform's structured result rather than the first URL in some text.
 *
 * The platform's replies seen in practice are often text only ("Media job
 * mjob_…: failed (129s)"), so statuses are read from structured content first
 * and from that header line second, and anything not recognised stops the
 * render rather than being guessed at.
 */
import { callStrict, LivepeerToolError } from './livepeer.mjs'
import { INLINE_BUDGET_S, INLINE_REQUEST_MS } from './capabilities.mjs'

export class RenderError extends Error {
  /**
   * kind: tool | payment | timeout | no-media | unknown-status
   * mayHaveStarted: the render may be running or billed even though no result
   * came back, so the caller must keep it recoverable rather than call it failed.
   */
  constructor(message, { kind = 'tool', jobId = null, structured = null, mayHaveStarted = jobId != null } = {}) {
    super(message)
    this.name = 'RenderError'
    this.kind = kind
    this.jobId = jobId
    this.structured = structured
    this.mayHaveStarted = mayHaveStarted
  }
}

/** Job ids are printed and saved to disk, so only this shape is accepted from the platform. */
export const JOB_ID = /^mjob_[a-z0-9]{6,32}$/i
const JOB_ID_IN_TEXT = /\bmjob_[a-z0-9]{6,32}\b/i

const DONE = new Set(['done', 'succeeded', 'success', 'completed', 'complete', 'finished', 'ok'])
const FAILED = new Set(['failed', 'failure', 'error', 'errored', 'cancelled', 'canceled', 'aborted', 'abandoned', 'rejected', 'expired', 'timed_out', 'timeout'])
/** Statuses that mean "keep polling". Anything outside these three sets is unknown and stops the render. */
const IN_PROGRESS = new Set(['submitted', 'queued', 'pending', 'running', 'processing', 'in_progress', 'started', 'accepted', 'dispatched', 'waiting', 'scheduled', 'rendering', 'uploading'])

/**
 * Payment and credential problems, told apart from ordinary tool errors.
 * Word boundaries matter: "403 fetching image_url" is an input problem and
 * "accredited" is not "credit". A bare 401/403 is not enough, because the
 * platform also reports the status of fetching the render's own inputs.
 */
const PAYMENT_TEXT = /\bHTTP 402\b|\b402 payment\b|\bpayments?\b|\bpay for\b|\binsufficient (?:funds|credits?|balance)\b|\b(?:out of|no remaining|not enough|exhausted(?: your)?) (?:funds|credits?|balance)\b|\bspend(?:ing)? cap\b|\bover the cap\b|\ballowance\b|\bapi keys?\b|\bunauthori[sz]ed\b|\bpymthouse\b/i
const PAYMENT_CODE = /^(?:payment[_-]required|insufficient[_-](?:funds|credits?|balance)|spend[_-]cap(?:[_-]exceeded)?|over[_-]cap|unauthori[sz]ed|invalid[_-]api[_-]key|api[_-]key[_-](?:invalid|retired|revoked|missing|expired)|no[_-]credits?|billing[_-]\w+)$/i

function errorCode(structured) {
  if (!structured || typeof structured !== 'object') return null
  const e = structured.error
  for (const v of [structured.code, structured.error_code, structured.errorCode, e && typeof e === 'object' ? e.code : undefined, structured.status_code, structured.http_status]) {
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return null
}

/** 'payment' or 'tool'. A structured error code decides when there is one; the text only when there is not. */
export function classifyFailure(structured, text = '') {
  const code = errorCode(structured)
  if (code) {
    if (/^\d{3}$/.test(code)) return code === '401' || code === '402' ? 'payment' : 'tool'
    return PAYMENT_CODE.test(code) ? 'payment' : 'tool'
  }
  return PAYMENT_TEXT.test(String(text)) ? 'payment' : 'tool'
}

const MEDIA_EXT = /\.(mp4|webm|mov|m4v|png|jpe?g|webp|gif|wav|mp3|m4a|ogg|flac)$/i

const normalise = u => { try { return new URL(u).toString() } catch { return null } }
/** Origin and path only: an input echoed back with a resize or signature query is still the input. */
const pathKey = u => { try { const x = new URL(u); return `${x.origin}${x.pathname}` } catch { return null } }

/** Every string anywhere inside a render's inputs, however deeply nested. */
export function collectInputUrls(value, out = [], seen = new Set()) {
  if (typeof value === 'string') {
    out.push(value)
  } else if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value)
    for (const v of Array.isArray(value) ? value : Object.values(value)) collectInputUrls(v, out, seen)
  }
  return out
}

/**
 * The output URL of a render: the platform's structured `url` if present and
 * http(s); otherwise the first http(s) URL in the text with a media file
 * extension that is not one of the render's own inputs.
 */
export function extractMediaUrl(structured, text = '', inputUrls = []) {
  const inputs = new Set(collectInputUrls(inputUrls).map(pathKey).filter(Boolean))
  const usable = u => {
    const n = normalise(u)
    if (!n) return null
    const { protocol } = new URL(n)
    return (protocol === 'https:' || protocol === 'http:') && !inputs.has(pathKey(n)) ? n : null
  }
  for (const key of ['url', 'output_url', 'media_url']) {
    const v = structured?.[key]
    if (typeof v === 'string' && usable(v)) return usable(v)
  }
  for (const m of String(text ?? '').match(/https?:\/\/[^\s<>"'`)\]]+/g) ?? []) {
    const n = usable(m.replace(/[.,;:]+$/, ''))
    if (n && MEDIA_EXT.test(new URL(n).pathname)) return n
  }
  return null
}

/** The capability the platform says served the render; the requested one when it says nothing. */
export function served(structured, requested) {
  return structured?.capability_used ?? structured?.capability ?? requested
}

/** A list-price estimate the platform attached, or null. Anything else would fail every later commit. */
function costOf(structured) {
  const v = structured?.cost_usd_estimated
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

/** A structured url of any of the recognised keys. */
const hasStructuredUrl = s => ['url', 'output_url', 'media_url'].some(k => typeof s?.[k] === 'string' && s[k])

/**
 * A reply's status, lower-cased: structured `status` first, then the
 * "Media job mjob_…: <status>" header line of a text-only reply. Only that
 * header is read, so "poll … until status=done" in a queued reply is not
 * mistaken for a finished job. `undefined` when there is none; `null` when a
 * status is present but not a readable word.
 */
function statusOf(s, text) {
  if (s && s.status !== undefined && s.status !== null) {
    return typeof s.status === 'string' && /^[a-z_ -]{1,40}$/i.test(s.status.trim()) ? s.status.trim().toLowerCase().replace(/[ -]/g, '_') : null
  }
  const m = String(text ?? '').match(/^\W*Media job \S+: ([A-Za-z_-]{1,40})\b/m)
  return m ? m[1].toLowerCase().replace(/-/g, '_') : undefined
}

const textCapability = text => (String(text ?? '').match(/^Capability: ([a-z0-9][a-z0-9-]{1,63})\s*$/m) ?? [])[1]

const clip = v => String(v ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 400)

function positive(name, v, fallback, { allowZero = false } = {}) {
  if (v === undefined) return fallback
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (!allowZero && v === 0)) throw new RangeError(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} number of milliseconds`)
  return v
}

/**
 * Poll a background job until it finishes, fails, or the wait runs out.
 * `inputUrls` are the render's own inputs, which are never taken as its output.
 */
export async function pollJob(client, jobId, { inputUrls = [], pollIntervalMs, maxWaitMs, sleep, now = Date.now, onStatus } = {}) {
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) {
    throw new RenderError(`cannot poll job ${clip(jobId).slice(0, 60)}: not a job id`, { kind: 'tool', jobId: null, mayHaveStarted: true })
  }
  const interval = positive('pollIntervalMs', pollIntervalMs, 10_000, { allowZero: true })
  const maxWait = positive('maxWaitMs', maxWaitMs, 15 * 60_000, { allowZero: true })
  const wait = sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  const start = now()
  let lastStatus = 'running'
  let s = {}
  for (;;) {
    let r = null
    try {
      r = await client.callTool({ name: 'get_create_media', arguments: { job_id: jobId } })
    } catch (e) {
      // A dropped poll says nothing about the job, which keeps running on the
      // server. Retry until the wait runs out instead of abandoning a billed render.
      lastStatus = `unreachable (${clip(e?.message).slice(0, 80)})`
    }
    if (r) {
      s = r.structuredContent && typeof r.structuredContent === 'object' ? r.structuredContent : {}
      const text = (r.content ?? []).map(c => c.text ?? '').join('\n')
      const status = statusOf(s, text)
      onStatus?.(status ?? 'unknown')
      const inputs = [...collectInputUrls(inputUrls), ...collectInputUrls(s.source_url), ...collectInputUrls(s.inputs)]
      if (DONE.has(status)) {
        const url = extractMediaUrl(s, text, inputs)
        if (!url) throw new RenderError(`job ${jobId} finished without a media URL`, { kind: 'no-media', jobId, structured: s, mayHaveStarted: true })
        return { url, structured: s, text, status, capability: served(s, textCapability(text) ?? null) }
      }
      if (FAILED.has(status) || (r.isError && status === undefined)) {
        const msg = typeof s.error === 'string' ? s.error : (s.error?.message ?? text)
        throw new RenderError(`job ${jobId} failed: ${clip(msg)}`, { kind: classifyFailure(s, `${msg} ${text}`), jobId, structured: s, mayHaveStarted: true })
      }
      if (!IN_PROGRESS.has(status)) {
        // A status nobody taught this code could be terminal. Polling it for
        // fifteen minutes would only turn it into a misleading timeout.
        throw new RenderError(`job ${jobId} reported a status Mandate does not recognise (${status === undefined ? 'none' : clip(s.status ?? status).slice(0, 60)}); check it with \`mandate record\``, { kind: 'unknown-status', jobId, structured: s, mayHaveStarted: true })
      }
      lastStatus = status
    }
    if (now() - start >= maxWait) throw new RenderError(`job ${jobId} still ${lastStatus} after ${Math.round(maxWait / 1000)}s`, { kind: 'timeout', jobId, structured: s, mayHaveStarted: true })
    await wait(interval)
  }
}

const TIMEOUT = /timed? ?out|-32001|ETIMEDOUT|UND_ERR_(?:HEADERS|BODY|CONNECT)_TIMEOUT/i

/**
 * Run one render.
 * @returns {{ url, jobId, replay, servedCapability, costUsdEstimated, mode }}
 */
export async function dispatchRender(client, {
  capability, inputs = {}, prompt, sourceUrl, idempotencyKey, mode = 'inline', onJob, poll = {},
}) {
  const base = { capability, idempotency_key: idempotencyKey }
  if (prompt) base.prompt = prompt
  if (sourceUrl) base.source_url = sourceUrl
  if (Object.keys(inputs).length) base.inputs = inputs
  const inputUrls = [...collectInputUrls(sourceUrl), ...collectInputUrls(inputs)]

  let structured
  let text
  try {
    ;({ structured, text } = mode === 'async'
      ? await callStrict(client, 'run_capability', { ...base, async: true, timeout: 700 }, { timeoutMs: 120_000 })
      : await callStrict(client, 'run_capability', { ...base, async: false, timeout: INLINE_BUDGET_S }, { timeoutMs: INLINE_REQUEST_MS }))
  } catch (e) {
    if (e instanceof LivepeerToolError) {
      // The platform answered with an error, so it did not hand back a running job.
      const jobId = jobIdOf(e.structured, e.text)
      throw new RenderError(e.message, { kind: classifyFailure(e.structured, `${e.message} ${e.text ?? ''}`), jobId, structured: e.structured ?? null, mayHaveStarted: jobId != null })
    }
    // No answer at all. The request may have reached the platform and be
    // rendering (and billing) now, so this is never reported as a plain failure.
    const timedOut = e?.name === 'TimeoutError' || TIMEOUT.test(`${e?.message} ${e?.code ?? ''}`)
    throw new RenderError(`run_capability did not return: ${clip(e?.message)}`, { kind: timedOut ? 'timeout' : 'tool', jobId: null, mayHaveStarted: true })
  }
  structured = structured && typeof structured === 'object' ? structured : null
  const jobId = jobIdOf(structured, text)
  if (structured?.ok === false) {
    const msg = typeof structured.error === 'string' ? structured.error : (structured.error?.message ?? text)
    throw new RenderError(`run_capability reported failure: ${clip(msg)}`, { kind: classifyFailure(structured, `${msg} ${text}`), jobId, structured, mayHaveStarted: jobId != null })
  }

  const replay = structured?.idempotency_replay === true
  const status = statusOf(structured, '')
  if (status !== undefined && !IN_PROGRESS.has(status) && !DONE.has(status)) {
    if (FAILED.has(status)) {
      const msg = typeof structured.error === 'string' ? structured.error : text
      throw new RenderError(`run_capability reported ${status}: ${clip(msg)}`, { kind: classifyFailure(structured, `${msg} ${text}`), jobId, structured, mayHaveStarted: true })
    }
    throw new RenderError(`run_capability reported a status Mandate does not recognise (${clip(structured.status).slice(0, 60)})`, { kind: 'unknown-status', jobId, structured, mayHaveStarted: true })
  }
  // A job id without a structured media URL means the render was queued, even
  // when the reply is text only. Its text is never scanned for a URL: it can
  // quote the inputs, and a quoted input would be anchored as the output.
  const queued = IN_PROGRESS.has(status) || (jobId && !hasStructuredUrl(structured))
  if (queued) {
    if (!jobId) throw new RenderError('run_capability queued a job but returned no job id', { kind: 'tool', structured, mayHaveStarted: true })
    onJob?.(jobId)
    const done = await pollJob(client, jobId, { ...poll, inputUrls: [...inputUrls, ...collectInputUrls(poll.inputUrls ?? [])] })
    return {
      url: done.url, jobId, replay, mode: 'async', servedCapability: served(done.structured, done.capability ?? capability),
      costUsdEstimated: costOf(done.structured) ?? costOf(structured),
    }
  }
  const url = extractMediaUrl(structured, text, inputUrls)
  if (!url) throw new RenderError('the render returned no media URL', { kind: 'no-media', jobId, structured, mayHaveStarted: true })
  return { url, jobId, replay, mode: 'inline', servedCapability: served(structured, capability), costUsdEstimated: costOf(structured) }
}

/** A job id from structured content or text, only in the accepted shape. A malformed structured id is refused. */
function jobIdOf(structured, text) {
  const given = structured?.job_id
  if (given !== undefined && given !== null) {
    if (typeof given === 'string' && JOB_ID.test(given)) return given
    throw new RenderError(`run_capability returned a job id that is not in the expected form: ${clip(JSON.stringify(given)).slice(0, 80)}`, { kind: 'tool', structured, mayHaveStarted: true })
  }
  return (String(text ?? '').match(JOB_ID_IN_TEXT) ?? [])[0] ?? null
}
