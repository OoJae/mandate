/**
 * Third-party verification: the decision, with no I/O.
 *
 * A platform holding only a file asks: was this made under a grant that still
 * stands? Only derivation edges published by producers the verifier trusts
 * decide the answer. Anyone can publish an edge claiming any file was made
 * under any grant, so an untrusted edge is shown, never believed.
 *
 *   CLEAR         every trusted edge traces to a live grant that permitted it
 *   TAINTED       some trusted edge does not, or a trusted producer's record for
 *                 these bytes could not be read (subStatus says why)
 *   UNKNOWN       no trusted edge for these bytes, or an edge cites a grant whose
 *                 owner's grants graph this verifier does not read and nothing it
 *                 did read taints the edge
 *   INCONCLUSIVE  the read behind the knowledge was incomplete
 *
 * The file is TAINTED if any judgement is; otherwise CLEAR only if every
 * judgement is. Picking one edge would make the verdict depend on row order, and
 * would let a new grant launder bytes made under one that was revoked.
 *
 * What CLEAR establishes, and what it does not: the grant was published by the
 * subject's own address, is not revoked, permitted the capability that served
 * the render, and its validity window covers both now and the render time the
 * producer recorded. A derivation edge does not record the use class, territory
 * or spend, so CLEAR says nothing about use class, territory, prohibited uses or
 * the spend ceiling; those are enforced only by the gate at render time.
 */
import { grantIsAuthentic, revocationOf, microUsd, isMalformedState, unattributedState, unreadableGrantCopies } from './gate.mjs'
import { grantIriAddress } from './provenance.mjs'
import { asDateTime, normSha256 } from './rdf-term.mjs'

export const CLEAR = 'CLEAR'
export const TAINTED = 'TAINTED'
export const UNKNOWN = 'UNKNOWN'
export const INCONCLUSIVE = 'INCONCLUSIVE'

/** Most serious first; the headline reason is the most serious finding. */
const SEVERITY = ['REVOKED', 'UNAUTHORISED', 'MALFORMED', 'NOT_YET_VALID', 'EXPIRED']

const CLEAR_SCOPE = 'CLEAR covers the grant\'s publisher, revocation, capability and validity window; '
  + 'it does not check use class, territory, prohibited uses or the spend ceiling'

const lower = v => (typeof v === 'string' ? v.toLowerCase() : null)
const byUal = (a, b) => String(a.ual ?? a.id).localeCompare(String(b.ual ?? b.id))

/** A validity bound as epoch ms: absent is open-ended, anything unreadable is NaN. */
const bound = (value, open) => (value === null || value === undefined ? open : asDateTime(value))

function judgeEdge(k, d, nowMs, unresolved) {
  const out = (verdict, subStatus, reason, grant = null) => ({
    derivation: d.id, derivationUal: d.ual ?? null, publisher: d.publisher, grant: grant?.id ?? d.authorizedUnder,
    grantUal: grant?.ual ?? null, grantor: grant?.publisher ?? null, verdict, subStatus, reason,
  })
  // A grant listed as unresolved may still have been read (its owner published it
  // into a graph this verifier does read). What was read is judged first: a
  // revocation or a defect the verifier can see is TAINTED, never UNKNOWN. The
  // unread owner's graph only stops a verdict from being CLEAR.
  const unread = unresolved.has(d.authorizedUnder)
  // Only the address embedded in the grant id may publish that grant. grantIsAuthentic
  // enforces that (with subject and grantor), case-insensitively, exactly as the gate
  // does; a second copy of the comparison here could never fail on its own, so a
  // mutation test could not tell whether it was protected.
  const found = k.grants.filter(g => g?.id === d.authorizedUnder && grantIsAuthentic(g)).sort(byUal)
  if (found.length === 0) {
    if (unread) {
      return out(UNKNOWN, null, `cites grant ${d.authorizedUnder}, which is recorded in a graph this verifier does not read `
        + `(no configured grants graph belongs to ${grantIriAddress(d.authorizedUnder) ?? 'its owner'})`)
    }
    return out(TAINTED, 'UNAUTHORISED', `cites grant ${d.authorizedUnder}, which no one entitled to has published`)
  }
  // Copies of one id could disagree, and picking one would make the verdict depend on row order.
  if (found.length > 1) return out(TAINTED, 'MALFORMED', `grant ${d.authorizedUnder} is published more than once, so which one applies cannot be established`, found[0])
  const grant = found[0]
  // The grantor's own second copy that did not parse is still a copy, perhaps the
  // one that narrows or ends the grant; the gate refuses it, and so does this.
  const unreadableCopy = unreadableGrantCopies(k.forgeries).get(grant.id) ?? 0
  if (unreadableCopy > 0) {
    return out(TAINTED, 'MALFORMED', `grant ${grant.id} is published more than once (${1 + unreadableCopy} copies, ${unreadableCopy} of them unreadable), so which one applies cannot be established`, grant)
  }

  const rev = revocationOf(grant, k.states)
  if (rev.revoked) {
    return out(TAINTED, 'REVOKED', rev.by.tier === 'context'
      ? `grant ${grant.id} has a revocation whose publisher cannot be established (${rev.by.graph})`
      : `grant ${grant.id} was revoked by ${grant.publisher}${rev.by.stateAt ? ` at ${rev.by.stateAt}` : ''}${isMalformedState(rev.by) ? ' (the revocation is malformed, and counts)' : ''}`, grant)
  }
  if (!Array.isArray(grant.permitsCapability)) {
    return out(TAINTED, 'MALFORMED', `grant ${grant.id} has an unreadable capability clause`, grant)
  }
  if (!grant.permitsCapability.includes(d.servedCapability)) {
    return out(TAINTED, 'UNAUTHORISED', `served by "${d.servedCapability}", which grant ${grant.id} never permitted`, grant)
  }
  const from = bound(grant.validFrom, -Infinity)
  const until = bound(grant.validUntil, Infinity)
  if (Number.isNaN(from) || Number.isNaN(until)) {
    return out(TAINTED, 'MALFORMED', `grant ${grant.id} has an unreadable validity window`, grant)
  }
  // derivedAt is the producer's own claim. Without it the render cannot be placed in the window at all.
  const derived = asDateTime(d.derivedAt)
  if (Number.isNaN(derived)) {
    return out(TAINTED, 'MALFORMED', `derivation ${d.id} has no readable render time (derivedAt)`, grant)
  }
  if (nowMs < from || derived < from) {
    return out(TAINTED, 'NOT_YET_VALID', `grant ${grant.id} is not valid before ${grant.validFrom}`, grant)
  }
  if (derived > until) {
    return out(TAINTED, 'UNAUTHORISED', `the producer records this render at ${d.derivedAt}, after grant ${grant.id} expired at ${grant.validUntil}`, grant)
  }
  if (nowMs > until) {
    return out(TAINTED, 'EXPIRED', `grant ${grant.id} expired at ${grant.validUntil}. The producer records this render at ${d.derivedAt}, `
      + 'inside the window, but that time is the producer\'s own claim, and the grant no longer covers any use of the file', grant)
  }
  if (unread) {
    return out(UNKNOWN, null, `grant ${grant.id} was read and permitted this render, but its owner's grants graph `
      + `(${grantIriAddress(grant.id) ?? 'its owner'}) is not read here, so a revocation published there would not be seen`, grant)
  }
  return out(CLEAR, null, `authorised by ${grant.publisher} under ${grant.id}, served by "${d.servedCapability}". ${CLEAR_SCOPE}`, grant)
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

  const list = v => (Array.isArray(v) ? v : [])
  // Compared case-insensitively, as forgery claims are: hand-built knowledge with
  // an uppercase hash must not hide a tainted edge for the same bytes.
  const edges = list(k?.derivations).filter(d => normSha256(d?.outputSha256) === sha).sort(byUal)
  const trusted = edges.filter(d => d.trusted === true)
  const untrusted = edges.filter(d => d.trusted !== true).map(d => ({
    derivation: d.id, derivationUal: d.ual ?? null, publisher: d.publisher, grant: d.authorizedUnder,
  }))
  const cited = new Set(edges.map(d => d.authorizedUnder))
  const claims = (f, field) => (Array.isArray(f?.claims?.[field]) ? f.claims[field] : [])
  // Records for these bytes, and rejected state assertions about a grant these bytes cite:
  // a verifier needs to see a revocation that did not parse as much as a forged edge.
  const forgeries = list(k?.forgeries).filter(f => claims(f, 'outputSha256').map(lower).includes(sha)
    || claims(f, 'stateOf').some(g => cited.has(g)) || (typeof f?.id === 'string' && cited.has(f.id)))
  const warnings = [...list(k?.warnings)]
  for (const s of list(k?.states)) {
    if (isMalformedState(s) && cited.has(s.stateOf)) {
      warnings.push(`a malformed state assertion ${s.ual ?? s.id ?? ''} about grant ${s.stateOf} counts as a revocation: ${list(s.problems).join('; ') || 'unreadable fields'}`)
    }
  }
  const base = { sha256: sha, subStatus: null, judgements: [], untrusted, forgeries, warnings }

  if (k?.consistency?.ok !== true) {
    return { ...base, verdict: INCONCLUSIVE, reason: `the graph read was incomplete: ${k?.consistency?.reason ?? 'no consistency result'}` }
  }
  // Hand-built knowledge missing a list must not read as "nothing there": no
  // states would mean no revocations, and no forgeries would hide a trusted
  // producer's unreadable record, so the file would verify CLEAR.
  for (const f of ['grants', 'states', 'derivations', 'forgeries']) {
    if (!Array.isArray(k[f])) return { ...base, verdict: INCONCLUSIVE, reason: `the knowledge is incomplete: knowledge.${f} is not a list` }
  }
  const orphan = unattributedState(k.states)
  if (orphan) {
    return { ...base, verdict: INCONCLUSIVE, reason: `the knowledge is incomplete: state ${orphan.ual ?? orphan.id ?? '(no id)'} has neither a publisher nor a tier` }
  }

  const unresolved = new Set(list(k.unresolvedGrants))
  const judgements = trusted.map(d => judgeEdge(k, d, nowMs, unresolved))
  // A trusted producer's record for these bytes that could not be read is still its record, and it is unreadable.
  // Knowledge built without the trusted flag falls back to the older rule: a malformed record from a trusted address.
  const trustedProducers = new Set([...list(k.trustedProducers), ...trusted.map(d => d.publisher)].map(lower))
  for (const f of forgeries.filter(f => claims(f, 'outputSha256').map(lower).includes(sha)).sort(byUal)) {
    const isTrusted = f.trusted === true || (f.trusted === undefined && f.kind === 'malformed' && trustedProducers.has(lower(f.publisher)))
    if (!isTrusted) continue
    judgements.push({ derivation: f.id, derivationUal: f.ual ?? null, publisher: f.publisher, grant: claims(f, 'authorizedUnder')[0] ?? null,
      grantUal: null, grantor: null, verdict: TAINTED, subStatus: 'MALFORMED',
      reason: `a trusted producer's record ${f.id} for these bytes could not be read (${f.kind}): ${f.detail}` })
  }

  if (judgements.length === 0) {
    return { ...base, verdict: UNKNOWN, reason: untrusted.length
      ? `no trusted producer has recorded these bytes; ${untrusted.length} edge(s) from untrusted publishers are shown but not believed`
      : 'no derivation edge for these bytes: not produced through a Mandate gate, re-encoded after delivery, '
        + 'or recorded in a graph this verifier does not read' }
  }

  const tainted = judgements.filter(j => j.verdict === TAINTED)
    .sort((a, b) => SEVERITY.indexOf(a.subStatus) - SEVERITY.indexOf(b.subStatus))
  const unknown = judgements.filter(j => j.verdict === UNKNOWN)
  const verdict = tainted.length ? TAINTED : unknown.length ? UNKNOWN : CLEAR
  const head = tainted[0] ?? unknown[0] ?? judgements[0]
  const count = judgements.length > 1 ? ` (${judgements.length} trusted edges; ${tainted.length} tainted${unknown.length ? `, ${unknown.length} unknown` : ''})` : ''
  return {
    ...base,
    verdict,
    subStatus: head.subStatus,
    reason: `${head.reason}${count}`,
    grantId: head.grant, grantUal: head.grantUal, grantor: head.grantor,
    judgements,
  }
}

/**
 * Everything a trusted producer recorded under a grant: the quarantine list a
 * revocation implies. Complete only if producers record every render, which the
 * CLI enforces by treating an unrecorded render as failed. Matches exact bytes
 * only. `unreadable` counts trusted records claiming this grant that could not
 * be read: they are renders too, but which files they name is not known.
 */
export function blastRadius(grantId, derivations = [], forgeries = []) {
  const assets = (Array.isArray(derivations) ? derivations : []).filter(d => d?.trusted === true && d.authorizedUnder === grantId).sort(byUal)
  const unreadable = (Array.isArray(forgeries) ? forgeries : []).filter(f => f?.trusted === true
    && Array.isArray(f.claims?.authorizedUnder) && f.claims.authorizedUnder.includes(grantId)).length
  const readable = d => typeof d.billedUsd === 'number' && Number.isFinite(d.billedUsd) && d.billedUsd >= 0
  const unknown = unreadable > 0 || assets.some(d => !readable(d))
  const micro = assets.reduce((m, d) => m + (readable(d) ? microUsd(d.billedUsd) : 0n), 0n)
  return { grantId, assets, totalBilledUsd: Number(micro) / 1e6, billedUnknown: unknown, unreadable }
}
