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
 * up to ~20s, so this is a long poll, not a busy loop.
 */
export async function awaitCapture(client, token, { deadline = Date.now() + LINK_LIFETIME_MS, onPending, now = Date.now } = {}) {
  let polls = 0
  while (now() < deadline) {
    const r = await getUpload(client, token, 20)
    polls++
    if (r.url) return { ...r, polls }
    if (r.status === 'expired') return { url: null, status: 'expired', polls }
    onPending?.({ polls, remainingMs: deadline - now() })
  }
  return { url: null, status: 'expired', polls }
}

function looksLikeUrlOnly(s) {
  return /^\s*https?:\/\/\S+\s*$/.test(s)
}

/** Pull a transcript out of whatever shape the ASR result took. */
export function transcriptFrom(structured, text) {
  const candidates = [
    structured?.transcript, structured?.text, structured?.output?.text, structured?.output?.transcript,
    structured?.result?.text, structured?.run_output?.text, typeof structured?.output === 'string' ? structured.output : null,
    typeof structured?.run_output === 'string' ? structured.run_output : null,
  ]
  const found = candidates.find(v => typeof v === 'string' && v.trim())
  if (found) return found.trim()
  const t = String(text ?? '').replace(/^\s*(transcript|text)\s*:\s*/i, '').trim()
  return t || null
}

/** Transcribe the clip. Throws rather than returning an error message as if it were speech. */
export async function transcribe(client, url, { fetch = globalThis.fetch } = {}) {
  let res
  try {
    res = await callStrict(client, 'run_capability', {
      capability: 'nemotron-asr', source_url: url, inputs: { audio_url: url }, async: false, timeout: 120,
    }, { timeoutMs: 130_000 })
  } catch (e) {
    throw new ConsentError(`transcription failed: ${e.message}`, { stage: 'asr', raw: e.structured ?? e.text ?? null })
  }
  let transcript = transcriptFrom(res.structured, res.text)
  // Some capabilities answer with a link to their output instead of the output.
  const link = res.structured?.url ?? (transcript && looksLikeUrlOnly(transcript) ? transcript.trim() : null)
  if ((!transcript || looksLikeUrlOnly(transcript)) && link) {
    const r = await fetch(link, { signal: AbortSignal.timeout(30_000) })
    if (!r.ok) throw new ConsentError(`transcript link returned HTTP ${r.status}`, { stage: 'asr', raw: res.structured })
    const body = (await r.text()).slice(0, 100_000)
    try { transcript = transcriptFrom(JSON.parse(body), '') } catch { transcript = body.trim() }
  }
  if (!transcript || looksLikeUrlOnly(transcript)) throw new ConsentError('transcription returned no text', { stage: 'asr', raw: res.structured ?? res.text })
  return { transcript, raw: { structured: res.structured, text: res.text } }
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
