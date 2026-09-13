/**
 * Third-party verification: the decision, with no I/O.
 *
 * A platform holding only a file asks: was this made under a grant that still
 * stands? Only derivation edges published by producers the verifier trusts
 * decide the answer. Anyone can publish an edge claiming any file was made
 * under any grant, so an untrusted edge is shown, never believed.
 *
 *   CLEAR         every trusted edge traces to a live grant that permitted it
 *   TAINTED       some trusted edge does not (subStatus says why)
 *   UNKNOWN       no trusted edge for these bytes
 *   INCONCLUSIVE  the read behind the knowledge was incomplete
 *
 * The file is CLEAR only if every trusted edge is. Picking one edge would make
 * the verdict depend on row order, and would let a new grant launder bytes made
 * under one that was revoked.
 */
import { grantIsAuthentic, revocationOf } from './gate.mjs'
import { grantIriAddress } from './provenance.mjs'
import { asDateTime, normSha256 } from './rdf-term.mjs'

export const CLEAR = 'CLEAR'
export const TAINTED = 'TAINTED'
export const UNKNOWN = 'UNKNOWN'
export const INCONCLUSIVE = 'INCONCLUSIVE'

/** Most serious first; the headline reason is the most serious finding. */
const SEVERITY = ['REVOKED', 'UNAUTHORISED', 'MALFORMED', 'NOT_YET_VALID', 'EXPIRED']

function judgeEdge(k, d, nowMs) {
  const out = (verdict, subStatus, reason, grant = null) => ({
    derivation: d.id, derivationUal: d.ual ?? null, publisher: d.publisher, grant: grant?.id ?? d.authorizedUnder,
    grantUal: grant?.ual ?? null, grantor: grant?.publisher ?? null, verdict, subStatus, reason,
  })
  const owner = grantIriAddress(d.authorizedUnder)
  const grant = k.grants.find(g => g.id === d.authorizedUnder && grantIsAuthentic(g) && g.publisher === owner)
  if (!grant) return out(TAINTED, 'UNAUTHORISED', `cites grant ${d.authorizedUnder}, which no one entitled to has published`)

  const rev = revocationOf(grant, k.states)
  if (rev.revoked) {
    return out(TAINTED, 'REVOKED', rev.by.tier === 'context'
      ? `grant ${grant.id} has a revocation whose publisher cannot be established (${rev.by.graph})`
      : `grant ${grant.id} was revoked by ${grant.publisher}${rev.by.stateAt ? ` at ${rev.by.stateAt}` : ''}`, grant)
  }
  if (!grant.permitsCapability.includes(d.servedCapability)) {
    return out(TAINTED, 'UNAUTHORISED', `served by "${d.servedCapability}", which grant ${grant.id} never permitted`, grant)
  }
  const from = grant.validFrom ? asDateTime(grant.validFrom) : -Infinity
  const until = grant.validUntil ? asDateTime(grant.validUntil) : Infinity
  const derived = d.derivedAt ? asDateTime(d.derivedAt) : NaN
  // derivedAt is the producer's own claim: believed only when it incriminates.
  if (nowMs < from || derived < from) {
    return out(TAINTED, 'NOT_YET_VALID', `grant ${grant.id} is not valid before ${grant.validFrom}`, grant)
  }
  if (derived > until) {
    return out(TAINTED, 'UNAUTHORISED', `the producer records this render at ${d.derivedAt}, after grant ${grant.id} expired at ${grant.validUntil}`, grant)
  }
  if (nowMs > until) {
    return out(TAINTED, 'EXPIRED', `grant ${grant.id} expired at ${grant.validUntil}; it no longer covers use of this file`, grant)
  }
  return out(CLEAR, null, `authorised by ${grant.publisher} under ${grant.id}, served by "${d.servedCapability}"`, grant)
}

/**
 * @param {object} k       knowledge from readKnowledge({ sha256 })
 * @param {string} sha256
 * @param {object} [o]
 * @param {string} [o.now] ISO-8601 with an offset; defaults to the current time
 */
export function verifyKnowledge(k, sha256, { now = new Date().toISOString() } = {}) {
  const sha = normSha256(sha256)
  if (!sha) throw new TypeError('sha256 must be 64 hex characters')
  const nowMs = asDateTime(now)
  if (!Number.isFinite(nowMs)) throw new TypeError(`now must be ISO-8601 with an offset: ${JSON.stringify(now)}`)

  const edges = (k?.derivations ?? []).filter(d => d.outputSha256 === sha).sort((a, b) => String(a.ual ?? a.id).localeCompare(String(b.ual ?? b.id)))
  const trusted = edges.filter(d => d.trusted === true)
  const untrusted = edges.filter(d => d.trusted !== true).map(d => ({
    derivation: d.id, derivationUal: d.ual ?? null, publisher: d.publisher, grant: d.authorizedUnder,
  }))
  const forgeries = (k?.forgeries ?? []).filter(f => (f.claims?.outputSha256 ?? []).includes(sha))
  const base = { sha256: sha, subStatus: null, judgements: [], untrusted, forgeries, warnings: k?.warnings ?? [] }

  if (k?.consistency?.ok !== true) {
    return { ...base, verdict: INCONCLUSIVE, reason: `the graph read was incomplete: ${k?.consistency?.reason ?? 'no consistency result'}` }
  }

  const judgements = trusted.map(d => judgeEdge(k, d, nowMs))
  // A trusted producer's malformed edge for these bytes is its own record, and it is unreadable.
  const trustedProducers = new Set([...(k.trustedProducers ?? []), ...trusted.map(d => d.publisher)])
  for (const f of forgeries) {
    if (f.kind === 'malformed' && trustedProducers.has(f.publisher)) {
      judgements.push({ derivation: f.id, derivationUal: f.ual, publisher: f.publisher, grant: f.claims?.authorizedUnder?.[0] ?? null,
        grantUal: null, grantor: null, verdict: TAINTED, subStatus: 'MALFORMED', reason: `derivation ${f.id} is malformed: ${f.detail}` })
    }
  }

  if (judgements.length === 0) {
    return { ...base, verdict: UNKNOWN, reason: untrusted.length
      ? `no trusted producer has recorded these bytes; ${untrusted.length} edge(s) from untrusted publishers are shown but not believed`
      : 'no derivation edge for these bytes: not produced through a Mandate gate, or re-encoded after delivery' }
  }

  const tainted = judgements.filter(j => j.verdict === TAINTED)
    .sort((a, b) => SEVERITY.indexOf(a.subStatus) - SEVERITY.indexOf(b.subStatus))
  const head = tainted[0] ?? judgements[0]
  const count = judgements.length > 1 ? ` (${judgements.length} trusted edges; ${tainted.length} tainted)` : ''
  return {
    ...base,
    verdict: tainted.length ? TAINTED : CLEAR,
    subStatus: head.subStatus,
    reason: `${head.reason}${count}`,
    grantId: head.grant, grantUal: head.grantUal, grantor: head.grantor,
    judgements,
  }
}

/**
 * Everything a trusted producer recorded under a grant: the quarantine list a
 * revocation implies. Complete only if producers record every render, which the
 * CLI enforces by treating an unrecorded render as failed.
 */
export function blastRadius(grantId, derivations = []) {
  const assets = derivations.filter(d => d?.trusted === true && d.authorizedUnder === grantId)
    .sort((a, b) => String(a.ual ?? a.id).localeCompare(String(b.ual ?? b.id)))
  const unknown = assets.some(d => typeof d.billedUsd !== 'number' || !Number.isFinite(d.billedUsd))
  const micro = assets.reduce((m, d) => m + (Number.isFinite(d.billedUsd) ? Math.round(d.billedUsd * 1e6) : 0), 0)
  return { grantId, assets, totalBilledUsd: micro / 1e6, billedUnknown: unknown }
}
