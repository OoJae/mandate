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
import { connect, requestUpload, getUpload, callStrict, saysExpired, LivepeerToolError, RAW } from './livepeer.mjs'
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
 *
 * A tool error is the platform answering, not the network failing: one that
 * says the link expired or does not exist ends the wait at once, and so do
 * TOOL_ERROR_LIMIT identical ones in a row. A status that is neither a known
 * wait nor a finished upload also ends it, reported as itself. Deliberate
 * trade-off: a new pending status the platform starts using ends the wait
 * early, which costs a new link, never a false capture.
 */
export async function awaitCapture(client, token, { deadline = Date.now() + LINK_LIFETIME_MS, onPending, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), retryMs = 3000 } = {}) {
  let polls = 0
  let errors = 0
  let lastError = null
  let sameToolError = 0
  while (now() < deadline) {
    let r
    try {
      r = await getUpload(client, token, 20)
    } catch (e) {
      polls++
      errors++
      if (e instanceof LivepeerToolError) {
        const said = `${e.text ?? ''} ${e.message}`
        if (saysExpired(said)) return { url: null, status: 'expired', polls, errors, lastError: e.message }
        if (PERMANENT_TOOL_ERROR.test(said)) return { url: null, status: 'failed', polls, errors, lastError: e.message }
        sameToolError = e.message === lastError ? sameToolError + 1 : 1
        if (sameToolError >= TOOL_ERROR_LIMIT) return { url: null, status: 'failed', polls, errors, lastError: e.message }
      } else sameToolError = 0
      lastError = e.message
      onPending?.({ polls, remainingMs: deadline - now(), error: e.message })
      if (now() < deadline) await sleep(retryMs)
      continue
    }
    polls++
    sameToolError = 0
    if (r.url) return { ...r, polls, errors }
    if (!UPLOAD_WAITING.has(r.status)) return { url: null, status: r.status, polls, errors, lastError }
    onPending?.({ polls, remainingMs: deadline - now() })
  }
  return { url: null, status: 'expired', polls, errors, lastError }
}

// getUpload reports 'pending' when it has no status at all.
const UPLOAD_WAITING = new Set(['pending', 'waiting', 'awaiting', 'awaiting_upload', 'uploading', 'receiving', 'processing', 'queued', 'open', 'created', 'active', 'in_progress', 'in-progress'])
const PERMANENT_TOOL_ERROR = /\b(unknown|invalid|not found|no such|does not exist|not exist|unauthori[sz]ed|forbidden)\b/i
const TOOL_ERROR_LIMIT = 5

const ZERO_WIDTH = /[\u200b-\u200f\u2060\ufeff]/g
const hasLink = s => /\bhttps?:\/\/|\bwww\./i.test(String(s).replace(ZERO_WIDTH, ''))
function looksLikeUrlOnly(s) {
  return /^\s*(\[[^\]]*\]\()?https?:\/\/\S+?\)?\s*$/.test(String(s).replace(ZERO_WIDTH, ''))
}

// A text-only reply that reads like the platform talking about a job, not a
// person talking. Only consulted when there is no structured reply at all.
const STATUS_TEXT = /\b(job|poll|polling|submitted|queued|running|pending|in progress|processing|please wait|could not be processed|unavailable|failed|failure|error|status|get_job|get_create_media|call \w+ to|capability|nemotron|asr)\b|→/i

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

// Percent-encoding, repeated and trailing slashes name the same file on most
// hosts, so they are undone before comparing: %65xample.mp4 is example.mp4.
function canonicalPath(pathname) {
  let p = pathname
  try { p = decodeURIComponent(p) } catch { /* malformed escapes stay as they are */ }
  return p.replace(/\/{2,}/g, '/').replace(/\/+$/, '')
}

function sameResource(a, b) {
  try {
    const x = new URL(a)
    const y = new URL(b)
    return x.origin === y.origin && canonicalPath(x.pathname) === canonicalPath(y.pathname)
  } catch { return String(a).trim() === String(b).trim() }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Why this reply, or a part of it, says the transcription did not succeed, or
 * null. Looked for at the top level and inside result, output and run_output,
 * two levels deep (result.result), and in every element of an array there,
 * because a failure can be reported at any of them.
 */
function failureOf(reply) {
  const layers = []
  const walk = (x, depth) => {
    if (Array.isArray(x)) { for (const y of x) walk(y, depth); return }
    if (!x || typeof x !== 'object') return
    layers.push(x)
    if (depth < 2) for (const k of ['result', 'output', 'run_output']) walk(x[k], depth + 1)
  }
  walk(reply, 0)
  const said = v => String(v?.message ?? v).slice(0, 300)
  for (const o of layers) {
    if (o.ok === false || o.success === false) return `transcription failed: ${said(o.error ?? o.message ?? 'the platform answered ok: false')}`
    if (o.error) return `transcription failed: ${said(o.error)}`
    // Flags outside the live shape, read the strict way: a success that is
    // present but not true, any failed, errors or error_message that says
    // something, and a result the platform marks partial or truncated (the
    // lost tail could be a retraction).
    if ('success' in o && o.success !== true) return `transcription failed: success is ${said(JSON.stringify(o.success))}`
    if (o.failed != null && o.failed !== false) return 'transcription failed: the platform marked it failed'
    if (Array.isArray(o.errors) ? o.errors.length > 0 : o.errors != null && o.errors !== '' && !(typeof o.errors === 'object' && !Object.keys(o.errors).length)) return `transcription failed: ${said(JSON.stringify(o.errors))}`
    if (o.error_message != null && o.error_message !== '') return `transcription failed: ${said(o.error_message)}`
    for (const flag of ['partial', 'truncated', 'incomplete']) {
      if (o[flag] != null && o[flag] !== false) return `transcription is ${flag}; what was cut off may change what was said`
    }
    for (const field of ['status', 'state', 'job_status', 'phase']) {
      if (o[field] == null) continue
      const status = typeof o[field] === 'string' ? o[field].trim().toLowerCase() : ''
      if (!status) return `transcription returned an unreadable ${field}`
      if (ASR_PENDING.has(status)) return `transcription has not finished (${field} ${status}); nothing was heard yet`
      if (!ASR_DONE.has(status)) return `transcription ended with ${field} ${status}`
    }
  }
  return null
}

/** A transcript candidate outside result.text that reads like the platform talking about a job. */
function platformTextIn(reply) {
  const loose = [reply?.text, reply?.transcript, typeof reply?.output === 'string' ? reply.output : null, typeof reply?.run_output === 'string' ? reply.run_output : null]
  return loose.some(v => typeof v === 'string' && !looksLikeUrlOnly(v) && STATUS_TEXT.test(v))
}

/**
 * Fetch a transcript the ASR answered with a link to. The body is capped, must
 * be declared as plain text or JSON, must decode as UTF-8, and must not be the
 * clip itself — a video whose metadata reads "I consent" is not a transcript.
 */
async function fetchTranscriptLink(link, sourceUrl, { fetch, timeoutMs, maxBytes }) {
  let u
  try { u = new URL(link) } catch { throw new ConsentError('transcript link is not a URL', { stage: 'asr' }) }
  // The words become the evidence of what was consented to, so they travel over
  // TLS as the clip does. Plain http is allowed for loopback alone. This is
  // stricter than allowing http to the clip's own host: that host is no safer
  // from someone on the path.
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) throw new ConsentError(`transcript link must use https, got ${u.protocol}//${u.hostname}`, { stage: 'asr' })
  if (sameResource(u.href, sourceUrl)) throw new ConsentError('transcription answered with the consent clip itself, not a transcript', { stage: 'asr' })
  let r
  try {
    r = await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    throw new ConsentError(`transcript link could not be fetched: ${e.message}`, { stage: 'asr' })
  }
  const cancel = () => r.body?.cancel?.().catch(() => {})
  if (!r.ok) { cancel(); throw new ConsentError(`transcript link returned HTTP ${r.status}`, { stage: 'asr' }) }
  // fetch follows redirects, so the https rule is checked again on where it
  // ended: an https link that redirects to plain http lets anyone on the path
  // write the words.
  if (r.url) {
    let final
    try { final = new URL(r.url) } catch { cancel(); throw new ConsentError('transcript link redirected to something that is not a URL', { stage: 'asr' }) }
    if (final.protocol !== 'https:' && !(final.protocol === 'http:' && LOOPBACK.has(final.hostname))) { cancel(); throw new ConsentError(`transcript link redirected off https, to ${final.protocol}//${final.hostname}`, { stage: 'asr' }) }
  }
  if (r.url && sameResource(r.url, sourceUrl)) { cancel(); throw new ConsentError('transcript link redirects to the consent clip itself', { stage: 'asr' }) }
  const type = r.headers.get('content-type') ?? ''
  if (!TEXT_TYPES.test(type)) { cancel(); throw new ConsentError(`transcript link is ${type || 'of no declared type'}, not text or JSON`, { stage: 'asr' }) }
  const declared = Number(r.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) { cancel(); throw new ConsentError(`transcript is ${declared} bytes, over the ${maxBytes}-byte limit`, { stage: 'asr' }) }
  const chunks = []
  let bytes = 0
  try {
    for await (const chunk of r.body ?? []) {
      bytes += chunk.byteLength
      // Throwing out of for-await cancels the stream, so nothing more is read.
      if (bytes > maxBytes) throw new ConsentError(`transcript exceeds the ${maxBytes}-byte limit`, { stage: 'asr' })
      chunks.push(chunk)
    }
  } catch (e) {
    // A dropped socket or a timeout mid-body is still a transcription failure.
    if (e instanceof ConsentError) throw e
    throw new ConsentError(`transcript link failed while reading: ${e?.message ?? e}`, { stage: 'asr' })
  }
  // A body shorter than the length it declared was cut off, and the cut-off
  // tail could be a retraction. Only checked when the body is not re-encoded,
  // since a compressed body's declared length is not its decoded length.
  const encoding = (r.headers.get('content-encoding') ?? '').trim().toLowerCase()
  if (Number.isFinite(declared) && r.headers.get('content-length') != null && (encoding === '' || encoding === 'identity') && bytes !== declared) {
    throw new ConsentError(`transcript is truncated: ${bytes} of ${declared} declared bytes`, { stage: 'asr' })
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
    const reply = parsed && typeof parsed === 'object' ? parsed : { value: parsed }
    // The linked document can report its own failure, as the reply can.
    const failed = failureOf(reply)
    if (failed) throw new ConsentError(`transcript link: ${failed}`, { stage: 'asr' })
    if (platformTextIn(reply)) throw new ConsentError('transcript link returned a platform status message, not speech', { stage: 'asr' })
    const t = transcriptFrom(reply, '')
    if (!t) throw new ConsentError('transcript JSON has no transcript field', { stage: 'asr' })
    return t
  }
  if (STATUS_TEXT.test(body)) throw new ConsentError('transcript link returned a platform status message, not speech', { stage: 'asr' })
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
  // Only the live shape is read: a structured reply that says ok: true. Plain
  // text alone carries no provenance and no failure flags to check.
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw fail('transcription returned no structured result; plain text cannot be checked as speech')
  const failed = failureOf(s)
  if (failed) throw fail(failed)
  if (s.ok !== true) throw fail('transcription did not answer ok: true')
  if (s.job_id && !transcriptFrom(s, '') && !s.url) throw fail(`transcription was queued as job ${String(s.job_id).slice(0, 60)}, not finished`)
  if (platformTextIn(s)) throw fail('transcription returned a platform status message, not speech')
  for (const [field, want] of [['capability', 'nemotron-asr'], ['requested_capability', 'nemotron-asr']]) {
    if (s[field] != null && s[field] !== want) throw fail(`transcription was served by ${String(s[field]).slice(0, 60)}, not ${want}`)
  }
  // The live reply names what served it and what it heard. Without both, the
  // words could be of any model and any input.
  if (s.capability == null && s.requested_capability == null) throw fail('transcription does not say which capability served it')
  if (s.source_url == null && s.inputs?.audio_url == null) throw fail('transcription does not say which clip it heard')
  if (s.output_kind != null && s.output_kind !== 'text') throw fail(`transcription returned ${String(s.output_kind).slice(0, 40)} output, not text`)
  // The words must be of this clip, not of some other input.
  for (const heard of [s.source_url, s.inputs?.audio_url]) {
    if (heard != null && !sameResource(heard, url)) throw fail('transcription reports a different source than the consent clip')
  }
  let transcript = transcriptFrom(s, res.text)
  // Speech that reads like a job report and has no first-person word is the
  // platform talking ("Job submitted. Call get_job to poll."), not a person.
  if (transcript && !looksLikeUrlOnly(transcript) && STATUS_TEXT.test(transcript) && !/\b(i|we|my|me|our|us)\b/i.test(transcript)) throw fail('transcription returned a platform status message, not speech')
  if (transcript && hasLink(transcript) && !looksLikeUrlOnly(transcript)) throw fail('transcription returned text mixed with a link; it cannot be read as speech')
  // Some capabilities answer with a link to their output instead of the output.
  const bare = transcript && looksLikeUrlOnly(transcript) ? transcript.replace(ZERO_WIDTH, '').match(/https?:\/\/[^\s)]+/)[0] : null
  const link = typeof s.url === 'string' ? s.url : bare
  if (!transcript || bare) {
    if (!link) throw fail('transcription returned no text')
    transcript = await fetchTranscriptLink(link, url, { fetch, timeoutMs, maxBytes })
    if (hasLink(transcript)) throw fail('the fetched transcript contains a link; it cannot be read as speech')
  } else if (typeof s.url === 'string') {
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
