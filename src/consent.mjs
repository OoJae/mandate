/**
 * Consent capture, inside the conversation.
 *
 * Consent today is a PDF in a shared drive: not machine-readable, not queryable
 * at render time, not revocable, and held by the party doing the rendering.
 * `request_upload` is the primitive that changes that — the agent mints a link,
 * the depicted person opens it on their own phone, and six seconds of recorded
 * speech becomes the evidence the grant is built on.
 *
 * What we do NOT do: identify anyone from the clip. There is no face-embedding
 * capability on Livepeer, and a hash of an embedding cannot be both
 * non-invertible and stable across photos. So the subject identifier is
 * DECLARED, and the clip is human-auditable evidence bound to it by hash.
 * Declining to do biometric identification is a deliberate product decision,
 * not a gap.
 */
import { createHash } from 'node:crypto'
import { connect, requestUpload, getUpload, runCapability, RAW } from './livepeer.mjs'

/** Mint a phone-openable capture link. Free, and works without a key. */
export async function beginCapture(client, kind = 'video') {
  const { pageUrl, token, text } = await requestUpload(client, kind)
  if (!token) throw new Error(`request_upload returned no token:\n${text}`)
  return { pageUrl, token }
}

/** Hold for the upload. Each call parks server-side for ~20s. */
export async function awaitCapture(client, token, { attempts = 12 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const r = await getUpload(client, token, 20)
    if (r.url) return r
  }
  return { url: null, pending: true }
}

export async function sha256Of(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`could not fetch consent clip: HTTP ${res.status}`)
  return createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex')
}

/** Transcribe the clip so the SPOKEN scope can be checked against the requested scope. */
export async function transcribe(client, url) {
  const out = await runCapability(client, 'nemotron-asr', {
    source_url: url, inputs: { audio_url: url },
  }, { timeout: 300 })
  return out
}

/**
 * Compare what was said against what is about to be granted.
 *
 * This is deliberately a weak, transparent check that SURFACES a mismatch for a
 * human rather than deciding by itself. A confident-looking NLP scope matcher
 * would be the kind of thing that silently approves the wrong grant, which is
 * precisely the failure this product exists to prevent.
 */
export function checkSpokenScope(transcript, requested) {
  const said = (transcript || '').toLowerCase()
  const checks = []
  const seen = term => said.includes(String(term).toLowerCase())

  checks.push({ term: 'consent', matched: /\b(consent|agree|authorise|authorize|permission|allow)\b/.test(said) })
  for (const u of requested.useClass ?? []) checks.push({ term: u, matched: seen(u) })
  for (const t of requested.territory ?? []) checks.push({ term: t, matched: seen(t) })

  const missing = checks.filter(c => !c.matched).map(c => c.term)
  return {
    checks,
    missing,
    covered: checks.filter(c => c.matched).length,
    total: checks.length,
    // Never "verified" — we report coverage and let a person decide.
    note: missing.length
      ? `spoken consent does not mention: ${missing.join(', ')} — review before granting`
      : 'spoken consent mentions every requested term',
  }
}

/** The whole capture flow, for the CLI. */
export async function captureConsent({ requested, onLink, attempts = 12 } = {}) {
  const client = await connect(RAW)
  try {
    const { pageUrl, token } = await beginCapture(client, 'video')
    onLink?.(pageUrl)
    const got = await awaitCapture(client, token, { attempts })
    if (!got.url) return { captured: false, pageUrl, token }
    const sha256 = await sha256Of(got.url)
    let transcript = null, scope = null
    try {
      transcript = await transcribe(client, got.url)
      scope = checkSpokenScope(transcript, requested ?? {})
    } catch (e) {
      transcript = `transcription unavailable: ${e.message}`
    }
    return { captured: true, pageUrl, token, url: got.url, sha256, transcript, scope }
  } finally {
    await client.close()
  }
}
