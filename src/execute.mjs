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
import { decimalTerm } from './rdf-term.mjs'

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
/**
 * Signs that a reply is about a queued job. When one is present but no job id
 * in the accepted shape is, the job cannot be polled, and scanning the text for
 * a URL would take a quoted input or preview as the output.
 */
const QUEUED_TEXT = /\bmjob_|\bNOT done\b|\bget_create_media\b/i

/** Same rule as the graph writer (src/rdf.mjs), so a served capability can always be recorded. */
const CAPABILITY = /^[a-z0-9][a-z0-9-]{1,63}$/

const DONE = new Set(['done', 'succeeded', 'success', 'completed', 'complete', 'finished', 'ok'])
const FAILED = new Set(['failed', 'failure', 'error', 'errored', 'cancelled', 'canceled', 'aborted', 'abandoned', 'rejected', 'expired', 'timed_out', 'timeout'])
/** Statuses that mean "keep polling". Anything outside these three sets is unknown and stops the render. */
const IN_PROGRESS = new Set(['submitted', 'queued', 'pending', 'running', 'processing', 'in_progress', 'started', 'accepted', 'dispatched', 'waiting', 'scheduled', 'rendering', 'uploading'])

/**
 * Payment and credential problems, told apart from ordinary tool errors.
 * Word boundaries matter: "403 fetching image_url" is an input problem and
 * "accredited" is not "credit". A bare 401/403 is not enough, because the
 * platform also reports the status of fetching the render's own inputs, and
 * "allowance" alone is often a token or size limit, not money.
 */
const PAYMENT_TEXT = /\bHTTP 402\b|\b402 payment\b|\bpayment required\b|\bpayments?\b|\bpay for\b|\binsufficient (?:funds|credits?|balance)\b|\b(?:out of|no remaining|not enough|exhausted(?: your)?) (?:funds|credits?|balance)\b|\bspend(?:ing)? cap\b|\bover the cap\b|\b(?:credit|spend(?:ing)?|billing|usage) allowance\b|\bapi keys?\b|\bunauthori[sz]ed\b|\bpymthouse\b/i
/** Phrases that say money and nothing else. They outrank a structured code nobody taught this module. */
const STRONG_PAYMENT_TEXT = /\bHTTP 402\b|\b402 payment\b|\bpayment required\b|\binsufficient (?:funds|credits?|balance)\b|\b(?:out of|no remaining|not enough|exhausted(?: your)?) (?:funds|credits?|balance)\b/i
/** The account-only subset: an input host can answer "402 Payment Required", but not about this account's credits. */
const ACCOUNT_TEXT = /\binsufficient (?:funds|credits?|balance)\b|\b(?:out of|no remaining|not enough|exhausted(?: your)?) (?:funds|credits?|balance)\b/i
const PAYMENT_CODE = /^(?:payment[_-]required|insufficient[_-](?:funds|credits?|balance)|spend[_-]cap(?:[_-]exceeded)?|over[_-]cap|unauthori[sz]ed|invalid[_-]api[_-]key|api[_-]key[_-](?:invalid|retired|revoked|missing|expired)|no[_-]credits?|billing[_-]\w+)$/i
/** "… fetching image_url": a credential status about the render's own inputs, not the account. */
const INPUT_FETCH = /\b(?:fetch\w*|download\w*|retriev\w*)\b|\b[a-z]+_url\b/i
const CREDENTIAL_ONLY = /\bunauthori[sz]ed\b/i

function errorCode(structured) {
  if (!structured || typeof structured !== 'object') return null
  const e = structured.error
  for (const v of [structured.code, structured.error_code, structured.errorCode, e && typeof e === 'object' ? e.code : undefined, structured.status_code, structured.http_status]) {
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return null
}

/**
 * 'payment' or 'tool'. An HTTP status or a recognised payment code decides.
 * Any other structured code falls back to phrases that can only mean money,
 * so a generic "upstream_error" carrying "insufficient credits" is still
 * payment while one that mentions payment in passing is not.
 */
export function classifyFailure(structured, text = '') {
  // URLs are not words: an input stored under /payment/receipt.jpg says nothing about the account.
  const words = String(text ?? '').replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
    // A scheme-less host and path ("cdn.x/payment/receipt.jpg") is not words either.
    .replace(/(?<![\w./-])[a-z0-9-]+(?:\.[a-z0-9-]+)+\/\S*/gi, ' ')
  const inputFetch = INPUT_FETCH.test(words)
  const code = errorCode(structured)
  if (code && /^\d{3}$/.test(code)) {
    if (code === '402') return 'payment'
    // Text that can only mean money outranks a generic status code. A 401 or 403
    // about fetching an input is the input host's answer, so only account wording counts there.
    const credentialFetch = inputFetch && (code === '401' || code === '403')
    if ((credentialFetch ? ACCOUNT_TEXT : STRONG_PAYMENT_TEXT).test(words)) return 'payment'
    if (code === '401') return inputFetch ? 'tool' : 'payment'
    return 'tool'
  }
  if (code && PAYMENT_CODE.test(code)) return inputFetch && CREDENTIAL_ONLY.test(code) ? 'tool' : 'payment'
  if (code) return STRONG_PAYMENT_TEXT.test(words) ? 'payment' : 'tool'
  if (STRONG_PAYMENT_TEXT.test(words)) return 'payment'
  const soft = inputFetch ? words.replace(/\bunauthori[sz]ed\b/gi, ' ') : words
  return PAYMENT_TEXT.test(soft) ? 'payment' : 'tool'
}

const MEDIA_EXT = /\.(mp4|webm|mov|m4v|png|jpe?g|webp|gif|wav|mp3|m4a|ogg|flac)$/i

/**
 * Hosts that serve media under a path without a file extension. Anything else
 * must name a media file: a job or status page is not the output.
 */
const MEDIA_HOST_PATHS = [['agent.livepeer.org', '/a/']]
const bareHost = h => h.toLowerCase().replace(/\.$/, '')
function looksLikeMedia(n) {
  const x = new URL(n)
  if (MEDIA_EXT.test(x.pathname)) return true
  return MEDIA_HOST_PATHS.some(([host, prefix]) => bareHost(x.hostname) === host && x.pathname.startsWith(prefix) && x.pathname.length > prefix.length)
}

const normalise = u => { try { return new URL(u).toString() } catch { return null } }
/**
 * What makes two URLs the same resource for echo detection: host without a
 * default port or a trailing dot, and the percent-decoded path with repeated slashes collapsed.
 * Scheme, query and fragment are ignored, so an input echoed back over http,
 * with a resize query or with %70 for "p" is still the input.
 */
const pathKey = u => {
  try {
    const x = new URL(u)
    if (x.hostname.endsWith('.')) x.hostname = bareHost(x.hostname)
    let path = x.pathname
    try { path = decodeURIComponent(path) } catch { /* a malformed escape is compared as written */ }
    const port = x.port && x.port !== '80' && x.port !== '443' ? `:${x.port}` : ''
    return `${x.hostname.toLowerCase()}${port}${path.replace(/\/{2,}/g, '/')}`
  } catch { return null }
}

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

const STRUCTURED_URL_KEYS = ['url', 'output_url', 'media_url']

/**
 * The output URL of a render: the platform's structured `url` if present,
 * http(s) and media (a media file extension, or a known media host path); otherwise the first http(s) URL in the text with a media file
 * extension that is not one of the render's own inputs. When the platform names
 * a structured URL that is unusable (an input, another scheme, a page), the text is not
 * scanned: a reply that names its output wrongly is not trusted to quote it.
 */
export function extractMediaUrl(structured, text = '', inputUrls = []) {
  const inputs = new Set(collectInputUrls(inputUrls).map(pathKey).filter(Boolean))
  const usable = u => {
    const n = normalise(u)
    if (!n) return null
    const { protocol } = new URL(n)
    return (protocol === 'https:' || protocol === 'http:') && !inputs.has(pathKey(n)) ? n : null
  }
  let named = false
  for (const key of STRUCTURED_URL_KEYS) {
    const v = structured?.[key]
    if (v === undefined || v === null || v === '') continue
    named = true
    if (typeof v === 'string' && usable(v) && looksLikeMedia(usable(v))) return usable(v)
  }
  if (named) return null
  for (const m of String(text ?? '').match(/https?:\/\/[^\s<>"'`)\]]+/g) ?? []) {
    const n = usable(m.replace(/[.,;:]+$/, ''))
    if (n && MEDIA_EXT.test(new URL(n).pathname)) return n
  }
  return null
}

/**
 * The capability that served a render, and a warning when the platform named
 * one that cannot be recorded. The platform's claim wins; `fallback` (a text
 * "Capability:" line, then the requested capability) is used only when it
 * makes none. A claim that is not a capability name gives null rather than the
 * requested name, which would assert no substitution happened.
 */
function servedOf(structured, fallbacks = []) {
  for (const key of ['capability_used', 'capability']) {
    const v = structured?.[key]
    if (v === undefined || v === null) continue
    if (typeof v === 'string' && CAPABILITY.test(v)) return { capability: v, warning: null }
    return { capability: null, warning: `the platform named the serving capability ${clip(JSON.stringify(v)).slice(0, 80)}, which is not a capability name; it is left unknown` }
  }
  for (const v of fallbacks) {
    if (v === undefined || v === null) continue
    if (typeof v === 'string' && CAPABILITY.test(v)) return { capability: v, warning: null }
    return { capability: null, warning: `the serving capability ${clip(JSON.stringify(v)).slice(0, 80)} is not a capability name; it is left unknown` }
  }
  return { capability: null, warning: null }
}

/** The capability the platform says served the render; the requested one when it says nothing; null when what it says is unusable. */
export function served(structured, requested) {
  return servedOf(structured, [requested]).capability
}

/**
 * A list-price estimate the platform attached, or null with a warning. It must
 * be writable as a plain decimal on the graph (1e21 is finite but is not), or
 * every later commit of the billed render would fail.
 */
function costOf(structured) {
  const v = structured?.cost_usd_estimated
  if (v === undefined || v === null) return { usd: null, warning: null }
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) {
    try {
      decimalTerm(v, 'cost_usd_estimated')
      return { usd: v, warning: null }
    } catch { /* falls through to the warning */ }
  }
  return { usd: null, warning: `the platform's cost estimate ${clip(JSON.stringify(v) ?? String(v)).slice(0, 60)} cannot be recorded as an amount; it is left unknown` }
}

/**
 * A text header "Media job mjob_…: <status>", where the status may be several
 * words and may be followed by a duration in brackets.
 */
const STATUS_HEADER = /^\W*Media job (\S+): ([A-Za-z][A-Za-z_ -]{0,39}?)[ \t\r]*(?:\(|$)/m

/**
 * A reply's status, lower-cased with spaces and hyphens as underscores:
 * structured `status` first, then the header line of a text-only reply. Only
 * that header is read, so "poll … until status=done" in a queued reply is not
 * mistaken for a finished job, and a header naming a job other than `jobId` is
 * refused. `undefined` when there is none; `null` when a status is present but
 * not a readable word.
 */
function statusOf(s, text, jobId = null) {
  const m = String(text ?? '').match(STATUS_HEADER)
  // Checked before the structured status: a header about another job is a mismatch whatever else the reply says.
  if (m) {
    if (jobId && m[1].toLowerCase() !== jobId.toLowerCase()) {
      throw new RenderError(`the reply for job ${jobId} is about another job (${clip(m[1]).slice(0, 60)})`, { kind: 'tool', jobId, mayHaveStarted: true })
    }
  }
  if (s && s.status !== undefined && s.status !== null) {
    return typeof s.status === 'string' && /^[a-z_ -]{1,40}$/i.test(s.status.trim()) ? s.status.trim().toLowerCase().replace(/[ -]+/g, '_') : null
  }
  if (!m) return undefined
  return m[2].trim().toLowerCase().replace(/[ -]+/g, '_')
}

const textCapability = text => (String(text ?? '').match(/^Capability: ([a-z0-9][a-z0-9-]{1,63})\s*$/m) ?? [])[1]

const clip = v => String(v ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 400)

/** setTimeout fires at once for anything above this, which would turn a wait into a busy loop. */
const MAX_TIMER_MS = 2_147_483_647

function positive(name, v, fallback, { allowZero = false } = {}) {
  if (v === undefined) return fallback
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_TIMER_MS || (!allowZero && v === 0)) throw new RangeError(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} number of milliseconds no larger than ${MAX_TIMER_MS}`)
  return v
}

/** Poll options, checked before anything is dispatched so a bad one never strands a billed job. */
function pollOptions(poll) {
  if (poll !== undefined && poll !== null && (typeof poll !== 'object' || Array.isArray(poll))) throw new TypeError('poll must be an object')
  const { pollIntervalMs, maxWaitMs, sleep, now, onStatus } = poll ?? {}
  const interval = positive('pollIntervalMs', pollIntervalMs, 10_000, { allowZero: true })
  const maxWait = positive('maxWaitMs', maxWaitMs, 15 * 60_000, { allowZero: true })
  if (sleep !== undefined && typeof sleep !== 'function') throw new TypeError('sleep must be a function')
  if (now !== undefined && typeof now !== 'function') throw new TypeError('now must be a function')
  if (onStatus !== undefined && onStatus !== null && typeof onStatus !== 'function') throw new TypeError('onStatus must be a function')
  return { interval, maxWait }
}

/**
 * Poll a background job until it finishes, fails, or the wait runs out.
 * `inputUrls` are the render's own inputs, which are never taken as its output.
 * `capability` is the requested one, used for servedCapability when the job
 * does not name what served it.
 */
export async function pollJob(client, jobId, options = {}) {
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) {
    throw new RenderError(`cannot poll job ${clip(jobId).slice(0, 60)}: not a job id`, { kind: 'tool', jobId: null, mayHaveStarted: true })
  }
  const { interval, maxWait } = pollOptions(options)
  try {
    return await pollLoop(client, jobId, { ...options, interval, maxWait })
  } catch (e) {
    // The job exists and may be billed: whatever went wrong, the error keeps its id.
    if (e instanceof RenderError) throw e
    throw followError(jobId, e)
  }
}

function followError(jobId, e) {
  const wrapped = new RenderError(`job ${jobId} could not be followed: ${clip(e?.message ?? e).slice(0, 200)}`, { kind: 'tool', jobId, mayHaveStarted: true })
  wrapped.cause = e
  return wrapped
}

/** A reply's text parts, tolerating a content that is not a list or holds non-objects. */
const replyText = r => (Array.isArray(r?.content) ? r.content : []).map(c => (c && typeof c.text === 'string' ? c.text : '')).join('\n')

async function pollLoop(client, jobId, { inputUrls = [], interval, maxWait, sleep, now: clock = Date.now, onStatus, capability = null }) {
  const wait = sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  const now = () => {
    const t = clock()
    if (typeof t !== 'number' || !Number.isFinite(t)) throw new RenderError(`cannot time job ${jobId}: now() returned ${clip(String(t)).slice(0, 40)}`, { kind: 'tool', jobId, mayHaveStarted: true })
    return t
  }
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
      const text = replyText(r)
      if (s.job_id !== undefined && s.job_id !== null && (typeof s.job_id !== 'string' || s.job_id.toLowerCase() !== jobId.toLowerCase())) {
        throw new RenderError(`the reply for job ${jobId} is about another job (${clip(JSON.stringify(s.job_id)).slice(0, 60)})`, { kind: 'tool', jobId, structured: s, mayHaveStarted: true })
      }
      const status = statusOf(s, text, jobId)
      onStatus?.(status ?? 'unknown')
      // A tool error is never a result, whatever status it carries. The job id
      // is kept, so `mandate record` can look again.
      if (r.isError || FAILED.has(status)) {
        const msg = (typeof s.error === 'string' ? s.error : (s.error?.message ?? text)) || (r.isError ? `the platform marked the reply as an error (status ${status ?? 'none'})` : String(status))
        throw new RenderError(`job ${jobId} failed: ${clip(msg)}`, { kind: classifyFailure(s, `${msg} ${text}`), jobId, structured: s, mayHaveStarted: true })
      }
      const inputs = [...collectInputUrls(inputUrls), ...collectInputUrls(s.source_url), ...collectInputUrls(s.inputs)]
      if (DONE.has(status)) {
        const url = extractMediaUrl(s, text, inputs)
        if (!url) throw new RenderError(`job ${jobId} finished without a media URL`, { kind: 'no-media', jobId, structured: s, mayHaveStarted: true })
        const claimed = servedOf(s, [textCapability(text)])
        const who = servedOf(s, [textCapability(text), capability])
        const cost = costOf(s)
        return {
          url, structured: s, text, status, capability: claimed.capability,
          servedCapability: who.capability, costUsdEstimated: cost.usd,
          warnings: [who.warning, cost.warning].filter(Boolean),
        }
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

const TIMEOUT = /timed? ?out|deadline[_ ]exceeded|-32001|ETIMEDOUT|UND_ERR_(?:HEADERS|BODY|CONNECT)_TIMEOUT/i
/** Platform wording for a render that outlived the call but was not stopped. */
const STILL_RUNNING = /\bmay still (?:complete|finish|succeed|be running|be rendering)\b|\b(?:continues?|keeps? running|still running|runs?) in the background\b|\bstill (?:running|rendering|processing)\b/i

/**
 * Run one render.
 * @returns {{ url, jobId, replay, servedCapability, costUsdEstimated, mode, warnings }}
 */
export async function dispatchRender(client, {
  capability, inputs = {}, prompt, sourceUrl, idempotencyKey, mode = 'inline', onJob, poll = {},
}) {
  pollOptions(poll ?? {})
  const pollWith = poll ?? {}
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
      // The platform answered with an error. That usually means no job, but a
      // platform-side timeout ("may still complete") can leave one rendering
      // with no id, so that wording keeps the render recoverable. Trade-off: a
      // provider error that merely mentions a timeout is kept recoverable too.
      const said = `${e.message} ${e.text ?? ''}`
      const { jobId, malformed } = readJobId(e.structured, e.text)
      const stillRunning = TIMEOUT.test(said) || STILL_RUNNING.test(said)
      throw new RenderError(`${e.message}${malformed ? ' (its job id was not in the expected form)' : ''}`, {
        kind: stillRunning ? 'timeout' : classifyFailure(e.structured, said), jobId, structured: e.structured ?? null,
        mayHaveStarted: jobId != null || malformed || stillRunning,
      })
    }
    // No answer at all. The request may have reached the platform and be
    // rendering (and billing) now, so this is never reported as a plain failure.
    const timedOut = e?.name === 'TimeoutError' || TIMEOUT.test(`${e?.message} ${e?.code ?? ''} ${e?.cause?.code ?? ''} ${e?.cause?.name ?? ''}`)
    throw new RenderError(`run_capability did not return: ${clip(e?.message)}`, { kind: timedOut ? 'timeout' : 'tool', jobId: null, mayHaveStarted: true })
  }
  structured = structured && typeof structured === 'object' ? structured : null
  const { jobId, malformed } = readJobId(structured, text)
  if (structured?.ok === false) {
    // Classified before the job id is judged, so a refused payment is still a
    // payment. A malformed id still means something may have been created.
    // Wording that the render outlived the call keeps it recoverable, as for a tool error.
    const msg = typeof structured.error === 'string' ? structured.error : (structured.error?.message ?? text)
    const said = `${msg} ${text}`
    const outlived = TIMEOUT.test(said) || STILL_RUNNING.test(said)
    throw new RenderError(`run_capability reported failure: ${clip(msg)}`, { kind: outlived ? 'timeout' : classifyFailure(structured, said), jobId, structured, mayHaveStarted: outlived || jobId != null || malformed })
  }
  if (malformed) {
    throw new RenderError(`run_capability returned a job id that is not in the expected form: ${clip(JSON.stringify(structured.job_id)).slice(0, 80)}`, { kind: 'tool', structured, mayHaveStarted: true })
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
  // With a job id, only a done status with a usable structured media URL is
  // taken as the result. Anything else (no status, an echoed input, a poll
  // page, about:blank) is polled, and the text is never scanned: it can quote
  // the inputs or a preview, which would be anchored as the output.
  const inlineUrl = DONE.has(status) ? extractMediaUrl(structured, '', inputUrls) : null
  // A finished reply with a structured media URL may still mention get_create_media in passing.
  if (!inlineUrl) {
    if (!jobId && QUEUED_TEXT.test(String(text ?? ''))) {
      throw new RenderError('run_capability describes a queued job but gives no job id in the expected form, so it cannot be polled', { kind: 'tool', structured, mayHaveStarted: true })
    }
  }
  const queued = IN_PROGRESS.has(status) || (jobId != null && !inlineUrl)
  if (queued) {
    if (!jobId) throw new RenderError('run_capability queued a job but returned no job id', { kind: 'tool', structured, mayHaveStarted: true })
    let done
    try {
      onJob?.(jobId)
      done = await pollJob(client, jobId, { ...pollWith, capability, inputUrls: [...inputUrls, ...collectInputUrls(pollWith.inputUrls ?? [])] })
    } catch (e) {
      if (e instanceof RenderError) throw e
      throw followError(jobId, e)
    }
    const first = costOf(structured)
    const warnings = [...done.warnings, ...(done.costUsdEstimated === null ? [first.warning] : [])].filter(Boolean)
    return { url: done.url, jobId, replay, mode: 'async', servedCapability: done.servedCapability, costUsdEstimated: done.costUsdEstimated ?? first.usd, warnings }
  }
  // Only reached with a job id when inlineUrl was found, and the structured URL is read before any text.
  const url = extractMediaUrl(structured, text, inputUrls)
  if (!url) throw new RenderError('the render returned no media URL', { kind: 'no-media', jobId, structured, mayHaveStarted: true })
  const who = servedOf(structured, [capability])
  const cost = costOf(structured)
  return { url, jobId, replay, mode: 'inline', servedCapability: who.capability, costUsdEstimated: cost.usd, warnings: [who.warning, cost.warning].filter(Boolean) }
}

/**
 * A job id from structured content or text, only in the accepted shape. A
 * structured id in any other shape is reported as malformed (and never
 * returned), so each caller decides what it means rather than it hiding a
 * payment refusal.
 */
function readJobId(structured, text) {
  const given = structured?.job_id
  if (given !== undefined && given !== null) {
    return typeof given === 'string' && JOB_ID.test(given) ? { jobId: given, malformed: false } : { jobId: null, malformed: true }
  }
  return { jobId: (String(text ?? '').match(JOB_ID_IN_TEXT) ?? [])[0] ?? null, malformed: false }
}
