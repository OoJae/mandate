/**
 * Consent capture, inside the conversation.
 *
 * Consent today is a PDF in a shared drive: not machine-readable, not queryable
 * at render time, not revocable, and held by the party doing the rendering.
 * `request_upload` changes that: the agent mints a link, the depicted person
 * opens it on their own phone and records themselves saying what they agree to,
 * and the clip's hash becomes the evidence the grant is built on.
 *
 * The clip goes to Livepeer Agent to be hosted and transcribed. It never goes
 * to the DKG; only its SHA-256 does.
 *
 * What this does NOT do: identify anyone from the clip. The subject identifier
 * is declared, and the clip is human-auditable evidence bound to it by hash.
 *
 * It fails closed. No transcript means the spoken scope was not checked, and
 * the caller must treat that as unconfirmed, never as a pass.
 */
import { connect, requestUpload, getUpload, callStrict, RAW } from './livepeer.mjs'
import { checkSpokenScope, consentScript } from './scope.mjs'
import { sha256OfUrl } from './fetch-bytes.mjs'

export { checkSpokenScope, consentScript }

export class ConsentError extends Error {
  constructor(message, { stage, raw = null } = {}) {
    super(message)
    this.stage = stage
    this.raw = raw
  }
}

const LINK_LIFETIME_MS = 30 * 60_000

/** Mint a phone-openable capture link. Free, and works without a key. */
export async function beginCapture(client, kind = 'video') {
  const r = await requestUpload(client, kind)
  if (!r.token || !r.pageUrl) throw new ConsentError('request_upload returned no link', { stage: 'link', raw: r.text })
  return r
}

/**
 * Wait for the upload until the link expires. Each call parks server-side for
 * up to ~20s, so this is a long poll, not a busy loop. A poll that throws (a
 * dropped connection, a platform hiccup) is retried after a pause: the person
 * may be mid-recording, and one bad poll must not throw their clip away.
 */
export async function awaitCapture(client, token, { deadline = Date.now() + LINK_LIFETIME_MS, onPending, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), retryMs = 3000 } = {}) {
  let polls = 0
  let errors = 0
  let lastError = null
  while (now() < deadline) {
    let r
    try {
      r = await getUpload(client, token, 20)
    } catch (e) {
      polls++
      errors++
      lastError = e.message
      onPending?.({ polls, remainingMs: deadline - now(), error: e.message })
      if (now() < deadline) await sleep(retryMs)
      continue
    }
    polls++
    if (r.url) return { ...r, polls, errors }
    if (TERMINAL_UPLOAD.has(r.status)) return { url: null, status: r.status, polls, errors, lastError }
    onPending?.({ polls, remainingMs: deadline - now() })
  }
  return { url: null, status: 'expired', polls, errors, lastError }
}

const TERMINAL_UPLOAD = new Set(['expired', 'failed', 'error', 'cancelled', 'canceled', 'rejected'])

const ZERO_WIDTH = /[\u200b-\u200f\u2060\ufeff]/g
const hasLink = s => /\bhttps?:\/\/|\bwww\./i.test(String(s).replace(ZERO_WIDTH, ''))
function looksLikeUrlOnly(s) {
  return /^\s*(\[[^\]]*\]\()?https?:\/\/\S+?\)?\s*$/.test(String(s).replace(ZERO_WIDTH, ''))
}

// A text-only reply that reads like the platform talking about a job, not a
// person talking. Only consulted when there is no structured reply at all.
const STATUS_TEXT = /\b(job|poll|polling|submitted|queued|running|pending|in progress|failed|failure|error|status|get_job|get_create_media|call \w+ to|capability|nemotron|asr)\b|→/i

/**
 * Pull a transcript out of whatever shape the ASR result took. A structured
 * reply without a transcript field gives null: its text is a summary written
 * by the platform, never speech.
 */
export function transcriptFrom(structured, text) {
  const candidates = [
    structured?.transcript, structured?.text, structured?.output?.text, structured?.output?.transcript,
    structured?.result?.text, structured?.result?.transcript, structured?.run_output?.text, typeof structured?.output === 'string' ? structured.output : null,
    typeof structured?.run_output === 'string' ? structured.run_output : null,
  ]
  const found = candidates.find(v => typeof v === 'string' && v.trim())
  if (found) return found.trim()
  if (structured && typeof structured === 'object' && Object.keys(structured).length) return null
  const raw = String(text ?? '')
  const labelled = /^\s*(transcript|text)\s*:\s*/i.test(raw)
  const t = raw.replace(/^\s*(transcript|text)\s*:\s*/i, '').trim()
  if (!t || (!labelled && STATUS_TEXT.test(t))) return null
  return t
}

const ASR_DONE = new Set(['done', 'complete', 'completed', 'succeeded', 'success', 'ok', 'finished'])
const ASR_PENDING = new Set(['submitted', 'queued', 'pending', 'running', 'processing', 'in_progress', 'in-progress', 'started', 'accepted'])
const TRANSCRIPT_MAX_BYTES = 1024 * 1024
const TEXT_TYPES = /^(text\/plain|application\/json|application\/[a-z0-9.+-]*\+json)\b/i

function sameResource(a, b) {
  try {
    const x = new URL(a)
    const y = new URL(b)
    return x.origin === y.origin && x.pathname.replace(/\/+$/, '') === y.pathname.replace(/\/+$/, '')
  } catch { return String(a).trim() === String(b).trim() }
}

/**
 * Fetch a transcript the ASR answered with a link to. The body is capped, must
 * be declared as plain text or JSON, must decode as UTF-8, and must not be the
 * clip itself — a video whose metadata reads "I consent" is not a transcript.
 */
async function fetchTranscriptLink(link, sourceUrl, { fetch, timeoutMs, maxBytes }) {
  let u
  try { u = new URL(link) } catch { throw new ConsentError('transcript link is not a URL', { stage: 'asr' }) }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ConsentError(`transcript link must be http(s), got ${u.protocol}`, { stage: 'asr' })
  if (sameResource(u.href, sourceUrl)) throw new ConsentError('transcription answered with the consent clip itself, not a transcript', { stage: 'asr' })
  let r
  try {
    r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    throw new ConsentError(`transcript link could not be fetched: ${e.message}`, { stage: 'asr' })
  }
  const cancel = () => r.body?.cancel?.().catch(() => {})
  if (!r.ok) { cancel(); throw new ConsentError(`transcript link returned HTTP ${r.status}`, { stage: 'asr' }) }
  if (r.url && sameResource(r.url, sourceUrl)) { cancel(); throw new ConsentError('transcript link redirects to the consent clip itself', { stage: 'asr' }) }
  const type = r.headers.get('content-type') ?? ''
  if (!TEXT_TYPES.test(type)) { cancel(); throw new ConsentError(`transcript link is ${type || 'of no declared type'}, not text or JSON`, { stage: 'asr' }) }
  const declared = Number(r.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) { cancel(); throw new ConsentError(`transcript is ${declared} bytes, over the ${maxBytes}-byte limit`, { stage: 'asr' }) }
  const chunks = []
  let bytes = 0
  for await (const chunk of r.body ?? []) {
    bytes += chunk.byteLength
    if (bytes > maxBytes) throw new ConsentError(`transcript exceeds the ${maxBytes}-byte limit`, { stage: 'asr' })
    chunks.push(chunk)
  }
  let body
  try {
    body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } catch {
    throw new ConsentError('transcript link did not return UTF-8 text', { stage: 'asr' })
  }
  if (body.includes('\u0000')) throw new ConsentError('transcript link returned binary data', { stage: 'asr' })
  if (/json/i.test(type)) {
    let parsed
    try { parsed = JSON.parse(body) } catch { throw new ConsentError('transcript link returned invalid JSON', { stage: 'asr' }) }
    const t = transcriptFrom(parsed && typeof parsed === 'object' ? parsed : { value: parsed }, '')
    if (!t) throw new ConsentError('transcript JSON has no transcript field', { stage: 'asr' })
    return t
  }
  return body.trim()
}

/**
 * Transcribe the clip. Throws rather than returning an error message, a job
 * status, or a link as if it were speech.
 */
export async function transcribe(client, url, { fetch = globalThis.fetch, timeoutMs = 30_000, maxBytes = TRANSCRIPT_MAX_BYTES } = {}) {
  let res
  try {
    res = await callStrict(client, 'run_capability', {
      capability: 'nemotron-asr', source_url: url, inputs: { audio_url: url }, async: false, timeout: 120,
    }, { timeoutMs: 130_000 })
  } catch (e) {
    throw new ConsentError(`transcription failed: ${e.message}`, { stage: 'asr', raw: e.structured ?? e.text ?? null })
  }
  const s = res.structured
  const raw = s ?? res.text
  const fail = message => new ConsentError(message, { stage: 'asr', raw })
  if (s && typeof s === 'object') {
    const status = typeof s.status === 'string' ? s.status.trim().toLowerCase() : null
    if (s.ok === false) throw fail(`transcription failed: ${String(s.error ?? s.message ?? 'the platform answered ok: false').slice(0, 300)}`)
    if (s.error) throw fail(`transcription failed: ${String(s.error.message ?? s.error).slice(0, 300)}`)
    if (status && ASR_PENDING.has(status)) throw fail(`transcription has not finished (status ${status}); nothing was heard yet`)
    if (status && !ASR_DONE.has(status)) throw fail(`transcription ended with status ${status}`)
    if (s.status != null && !status) throw fail('transcription returned an unreadable status')
    if (s.job_id && !transcriptFrom(s, '') && !s.url) throw fail(`transcription was queued as job ${String(s.job_id).slice(0, 60)}, not finished`)
    for (const [field, want] of [['capability', 'nemotron-asr'], ['requested_capability', 'nemotron-asr']]) {
      if (s[field] != null && s[field] !== want) throw fail(`transcription was served by ${String(s[field]).slice(0, 60)}, not ${want}`)
    }
    if (s.output_kind != null && s.output_kind !== 'text') throw fail(`transcription returned ${String(s.output_kind).slice(0, 40)} output, not text`)
    // The words must be of this clip, not of some other input.
    for (const heard of [s.source_url, s.inputs?.audio_url]) {
      if (heard != null && !sameResource(heard, url)) throw fail('transcription reports a different source than the consent clip')
    }
  }
  let transcript = transcriptFrom(s, res.text)
  if (transcript && hasLink(transcript) && !looksLikeUrlOnly(transcript)) throw fail('transcription returned text mixed with a link; it cannot be read as speech')
  // Some capabilities answer with a link to their output instead of the output.
  const bare = transcript && looksLikeUrlOnly(transcript)
    ? transcript.replace(ZERO_WIDTH, '').match(/https?:\/\/[^\s)]+/)[0]
    : (!s && looksLikeUrlOnly(res.text ?? '') ? String(res.text).replace(ZERO_WIDTH, '').match(/https?:\/\/[^\s)]+/)[0] : null)
  const link = typeof s?.url === 'string' ? s.url : bare
  if (!transcript || bare) {
    if (!link) throw fail('transcription returned no text')
    transcript = await fetchTranscriptLink(link, url, { fetch, timeoutMs, maxBytes })
    if (hasLink(transcript)) throw fail('the fetched transcript contains a link; it cannot be read as speech')
  } else if (typeof s?.url === 'string') {
    throw fail('transcription returned both text and a link; it cannot be read as speech')
  }
  if (!transcript) throw fail('transcription returned no text')
  return { transcript, raw: { structured: s, text: res.text } }
}

/**
 * The whole capture flow. Returns what happened; the caller decides what a
 * missing or contradicted term means. `transcript` is null and `asrError` set
 * when the words could not be checked.
 */
export async function captureConsent({ requested = {}, kind = 'video', onLink, onPending, client: given } = {}) {
  const client = given ?? await connect(RAW)
  try {
    const link = await beginCapture(client, kind)
    const deadline = link.expiresAt ? Date.parse(link.expiresAt) || Date.now() + LINK_LIFETIME_MS : Date.now() + LINK_LIFETIME_MS
    onLink?.(link.pageUrl, { expiresAt: new Date(deadline).toISOString() })
    const got = await awaitCapture(client, link.token, { deadline, onPending })
    if (!got.url) return { captured: false, pageUrl: link.pageUrl, status: got.status }
    const { sha256, bytes } = await sha256OfUrl(got.url, { maxBytes: 60 * 1024 * 1024 })
    let transcript = null
    let asrError = null
    let asrRaw = null
    try {
      ;({ transcript, raw: asrRaw } = await transcribe(client, got.url))
    } catch (e) {
      asrError = e.message
      asrRaw = e.raw ?? null
    }
    return {
      captured: true, pageUrl: link.pageUrl, url: got.url, mime: got.mime, bytes, sha256,
      transcript, asrError, scope: transcript ? checkSpokenScope(transcript, requested) : null,
      raw: { upload: got.structured ?? null, asr: asrRaw },
    }
  } finally {
    if (!given) await client.close()
  }
}
