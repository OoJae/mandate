/**
 * Dispatching a permitted render and getting its media back.
 *
 * Only called after the gate has permitted the request. Everything here is
 * about not losing money or media: inline renders stay under Node's 300s stream
 * limit, slow capabilities go through a background job that is polled, a tool
 * error is a failure (never a result), and the media URL is taken from the
 * platform's structured result rather than the first URL in some text.
 */
import { callStrict, LivepeerToolError } from './livepeer.mjs'
import { INLINE_BUDGET_S, INLINE_REQUEST_MS } from './capabilities.mjs'

export class RenderError extends Error {
  /** kind: tool | payment | timeout | no-media */
  constructor(message, { kind = 'tool', jobId = null, structured = null } = {}) {
    super(message)
    this.kind = kind
    this.jobId = jobId
    this.structured = structured
  }
}

const PAYMENT = /\b(401|402|403)\b|payment|insufficient|allowance|credit|spend cap|over the cap|api key|unauthori[sz]ed|pymthouse/i
const MEDIA_EXT = /\.(mp4|webm|mov|m4v|png|jpe?g|webp|gif|wav|mp3|m4a|ogg|flac)$/i

const normalise = u => { try { return new URL(u).toString() } catch { return null } }

/**
 * The output URL of a render: the platform's structured `url` if present and
 * http(s); otherwise the first http(s) URL in the text with a media file
 * extension that is not one of the render's own inputs.
 */
export function extractMediaUrl(structured, text = '', inputUrls = []) {
  const inputs = new Set(inputUrls.map(normalise).filter(Boolean))
  const usable = u => {
    const n = normalise(u)
    if (!n) return null
    const { protocol } = new URL(n)
    return (protocol === 'https:' || protocol === 'http:') && !inputs.has(n) ? n : null
  }
  for (const key of ['url', 'output_url', 'media_url']) {
    const v = structured?.[key]
    if (typeof v === 'string' && usable(v)) return usable(v)
  }
  for (const m of String(text).match(/https?:\/\/[^\s<>"'`)\]]+/g) ?? []) {
    const n = usable(m.replace(/[.,;:]+$/, ''))
    if (n && MEDIA_EXT.test(new URL(n).pathname)) return n
  }
  return null
}

const failure = (e, jobId = null) => {
  const text = `${e.message} ${e.text ?? ''}`
  return new RenderError(e.message, { kind: PAYMENT.test(text) ? 'payment' : 'tool', jobId, structured: e.structured ?? null })
}

function served(structured, requested) {
  return structured?.capability_used ?? structured?.capability ?? requested
}

/** Poll a background job until it finishes, fails, or the wait runs out. */
export async function pollJob(client, jobId, { pollIntervalMs = 10_000, maxWaitMs = 15 * 60_000, sleep, now = Date.now, onStatus } = {}) {
  const wait = sleep ?? (ms => new Promise(r => setTimeout(r, ms)))
  const start = now()
  for (;;) {
    const r = await client.callTool({ name: 'get_create_media', arguments: { job_id: jobId } })
    const s = r.structuredContent ?? {}
    const text = (r.content ?? []).map(c => c.text ?? '').join('\n')
    onStatus?.(s.status ?? 'unknown')
    if (s.status === 'done' || s.status === 'succeeded' || s.status === 'completed') {
      const url = extractMediaUrl(s, text, [s.source_url].filter(Boolean))
      if (!url) throw new RenderError(`job ${jobId} finished without a media URL`, { kind: 'no-media', jobId, structured: s })
      return { url, structured: s }
    }
    if (s.status === 'failed' || s.status === 'cancelled' || (r.isError && !s.status)) {
      const msg = s.error ?? text
      throw new RenderError(`job ${jobId} failed: ${String(msg).slice(0, 400)}`, { kind: PAYMENT.test(String(msg)) ? 'payment' : 'tool', jobId, structured: s })
    }
    if (now() - start > maxWaitMs) throw new RenderError(`job ${jobId} still ${s.status ?? 'running'} after ${Math.round(maxWaitMs / 1000)}s`, { kind: 'timeout', jobId, structured: s })
    await wait(pollIntervalMs)
  }
}

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
  const inputUrls = [sourceUrl, ...Object.values(inputs)].filter(v => typeof v === 'string')

  let structured
  let text
  try {
    ;({ structured, text } = mode === 'async'
      ? await callStrict(client, 'run_capability', { ...base, async: true, timeout: 700 }, { timeoutMs: 120_000 })
      : await callStrict(client, 'run_capability', { ...base, async: false, timeout: INLINE_BUDGET_S }, { timeoutMs: INLINE_REQUEST_MS }))
  } catch (e) {
    if (e instanceof LivepeerToolError) throw failure(e)
    const timedOut = /timed? ?out|-32001|UND_ERR/i.test(`${e.message} ${e.code ?? ''}`)
    throw new RenderError(`run_capability did not return: ${e.message}`, { kind: timedOut ? 'timeout' : 'tool' })
  }
  if (structured?.ok === false) throw new RenderError(`run_capability reported failure: ${String(structured.error ?? text).slice(0, 400)}`, { structured })

  const replay = structured?.idempotency_replay === true
  const jobId = structured?.job_id ?? (text.match(/\bmjob_[a-z0-9]{6,32}\b/) ?? [])[0] ?? null
  const submitted = structured?.status === 'submitted' || structured?.status === 'queued' || structured?.status === 'running'
  if (submitted || (mode === 'async' && jobId && !structured?.url)) {
    if (!jobId) throw new RenderError('run_capability queued a job but returned no job id', { structured })
    onJob?.(jobId)
    const done = await pollJob(client, jobId, poll)
    return {
      url: done.url, jobId, replay, mode: 'async', servedCapability: served(done.structured, capability),
      costUsdEstimated: done.structured.cost_usd_estimated ?? structured?.cost_usd_estimated ?? null,
    }
  }
  const url = extractMediaUrl(structured, text, inputUrls)
  if (!url) throw new RenderError('the render returned no media URL', { kind: 'no-media', jobId, structured })
  return { url, jobId, replay, mode: 'inline', servedCapability: served(structured, capability), costUsdEstimated: structured?.cost_usd_estimated ?? null }
}
