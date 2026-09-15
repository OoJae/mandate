/**
 * The gate.
 *
 * Given a render request and the knowledge resolved from the DKG, decide whether
 * a Livepeer capability may be dispatched. Pure: no network, no clock, no I/O,
 * so a decision is reproducible and the whole policy reads in one file.
 *
 * It fails closed. A malformed request, an incomplete read, an unparseable
 * value, or a spend that cannot be known all refuse. And it trusts publishers,
 * not claims: the resolver attributes every grant and revocation to the address
 * that anchored it, and the gate re-checks that attribution here, so knowledge
 * assembled by hand gets the same scrutiny as knowledge read from a node.
 *
 * That scrutiny covers attribution, not completeness. The gate believes
 * `knowledge.consistency.ok`, so a caller composing knowledge by hand from
 * anchorsFromMeta and reduceSlice (src/provenance.mjs) instead of readKnowledge
 * must also run the resolver's consistency rules (readPublisher in
 * src/resolve.mjs) and set ok to false when any of them fails:
 *   - checkConsistency over each publisher's prefix: the node's graph count
 *     matches the anchors, every anchored graph returns its declared triple
 *     count, no returned graph lacks a confirmed anchor, and no previously seen
 *     UAL is missing;
 *   - no anchorsFromMeta problem (an unconfirmed anchor may hide a revocation);
 *   - no content row with an unreadable graph;
 *   - an empty `unreadable` list from reduceSlice: a grantor's revocation whose
 *     stateOf cannot be read lands there, not in `states`, so skipping this rule
 *     loses the revocation and the gate permits;
 *   - an empty read believed only when every attempt answered.
 * readKnowledge also reads merged-view and shared-memory revocations, remembered
 * anchors and revocations, and (with checkFreshness) the node's lag behind the
 * chain; hand-built knowledge without them has none of those protections.
 */
import { isProhibitedUseClass } from './policy.mjs'
import { grantIriAddress } from './provenance.mjs'
import { agentAddress, subjectAddress, isSubject, asDateTime } from './rdf-term.mjs'

const CAPABILITY = /^[a-z0-9][a-z0-9-]{1,63}$/
const USE_CLASS = /^[a-z][a-z0-9-]{0,31}$/
const TERRITORY = /^[A-Z]{2}$/

const finiteNonNegative = v => typeof v === 'number' && Number.isFinite(v) && v >= 0

/**
 * A USD amount as whole micro-dollars (BigInt), rounded up unless `down`.
 *
 * Money is compared in integers so that float addition never decides a
 * ceiling. Amounts are rounded up, the same way the writer records them
 * (src/rdf-term.mjs), so a positive amount always counts as at least one
 * micro-dollar and a run of tiny renders cannot slip under a ceiling. Binary
 * noise such as 0.8400000000000001 is not treated as extra precision. A ceiling
 * is rounded down: both directions err towards refusing.
 */
export function microUsd(usd, { down = false } = {}) {
  if (!finiteNonNegative(usd)) throw new TypeError(`not a non-negative amount: ${usd}`)
  if (usd >= 1e21) return BigInt(Math.ceil(usd)) * 1000000n
  const fixed = usd.toFixed(6)
  const m = BigInt(fixed.replace('.', ''))
  const diff = usd - Number(fixed)
  const tol = Math.max(1e-12, usd * 4 * Number.EPSILON)
  if (!down && diff > tol) return m + 1n
  if (down && diff < -tol) return m - 1n
  // The tolerance above is for binary noise on an amount that already has
  // micro-dollar digits. A positive amount that rounds to 0 has none, so however
  // small (1e-13, Number.MIN_VALUE) it counts as one micro-dollar.
  if (!down && m === 0n && usd > 0) return 1n
  return m
}

const usdOfMicro = m => Number(m) / 1e6

/** Is this list usable as a clause list? null/undefined is an empty list; a string never is. */
const clauseList = v => (v === null || v === undefined ? [] : Array.isArray(v) ? v : null)

/**
 * Whether a grant is accepted as published by the subject it names: the anchor's
 * address, the subject's address, the grant id's address and the grantor DID
 * must all be the same.
 */
export function grantIsAuthentic(g) {
  if (!g || g.tier !== 'vm') return false
  const a = typeof g.publisher === 'string' ? g.publisher.toLowerCase() : null
  return Boolean(a) && subjectAddress(g.subject) === a && grantIriAddress(g.id) === a && agentAddress(g.grantor) === a
}

/** The tiers the resolver attributes a state to. */
const STATE_TIERS = new Set(['vm', 'context', 'swm'])

/**
 * Is this state's malformed flag set? Anything but absent or exactly false counts:
 * hand-built knowledge writing "true" or 1 must not un-revoke.
 */
export const isMalformedState = s => s?.malformed !== undefined && s.malformed !== null && s.malformed !== false

/**
 * The first state that cannot be attributed at all: no publisher and no tier the
 * resolver produces. Nothing says whose it is or where it was read, so it cannot
 * be judged as a revocation or set aside; the knowledge is incomplete.
 */
export function unattributedState(states) {
  return (Array.isArray(states) ? states : []).find(s => s && typeof s === 'object'
    && typeof s.publisher !== 'string' && !STATE_TIERS.has(s.tier)) ?? null
}

/**
 * Revocation state of one grant. Terminal: any accepted revocation, at any time,
 * ends the grant — renewing means publishing a new grant id. A revocation
 * counts when its anchor's address is the grant's publisher, or when it appears
 * in a merged view with no publisher at all (the resolver's context tier).
 * Shared-memory revocations are not anchored and only warn.
 *
 * Only the grantor can write a state that counts, so its own states fail closed:
 * one marked malformed counts whatever its state field says (a mistake in a
 * revocation must not un-revoke), and one carrying no tier the resolver
 * produces (hand-built knowledge) cannot be read as anything but a revocation.
 */
export function revocationOf(grant, states = []) {
  const about = states.filter(s => s?.stateOf === grant.id)
  const counted = about.filter(s => {
    const byGrantor = typeof s.publisher === 'string' && s.publisher.toLowerCase() === grant.publisher.toLowerCase()
    if (byGrantor && !STATE_TIERS.has(s.tier)) return true
    const revokes = s.state !== 'active' || isMalformedState(s)
    return revokes && ((s.tier === 'vm' && byGrantor) || s.tier === 'context')
  })
  counted.sort((a, b) => String(a.ual ?? a.id).localeCompare(String(b.ual ?? b.id)))
  return { revoked: counted.length > 0, by: counted[0] ?? null, all: counted }
}

/**
 * Unreadable copies of grant ids, counted by id: records the reducer rejected
 * whose id is a grant id and whose publisher is the address that id names. Only
 * that address can publish a copy; anyone else's is a forgery, not a copy. The
 * gate refuses a grant with one, and the verifier does not call it CLEAR.
 */
export function unreadableGrantCopies(forgeries = []) {
  const unreadableCopies = new Map()
  for (const f of Array.isArray(forgeries) ? forgeries : []) {
    if (typeof f?.id !== 'string' || typeof f.publisher !== 'string') continue
    // Only the address an id names can publish a copy of it: anyone else's is a forgery, not a copy.
    if (grantIriAddress(f.id) !== f.publisher.toLowerCase()) continue
    unreadableCopies.set(f.id, (unreadableCopies.get(f.id) ?? 0) + 1)
  }
  return unreadableCopies
}

/**
 * Spend already committed under a grant, from trusted producers' derivations,
 * in whole micro-dollars.
 *
 * `unknown` when any of them carries no billed amount, or when a trusted
 * producer's record claiming this grant could not be read (a rejected edge is
 * still a render someone may have paid for; counting it as $0 would reopen the
 * ceiling).
 */
function spendUnder(grantId, derivations = [], forgeries = []) {
  const under = (Array.isArray(derivations) ? derivations : []).filter(d => d?.trusted === true && d.authorizedUnder === grantId)
  const unreadable = (Array.isArray(forgeries) ? forgeries : []).filter(f => f?.trusted === true
    && Array.isArray(f.claims?.authorizedUnder) && f.claims.authorizedUnder.includes(grantId)).length
  const unknown = unreadable > 0 || under.some(d => !finiteNonNegative(d.billedUsd))
  const micro = under.reduce((m, d) => m + (finiteNonNegative(d.billedUsd) ? microUsd(d.billedUsd) : 0n), 0n)
  return { micro, unknown, derivations: under.length, unreadable }
}

export function priorSpendFor(grantId, derivations = [], forgeries = []) {
  const s = spendUnder(grantId, derivations, forgeries)
  return { usd: usdOfMicro(s.micro), unknown: s.unknown, derivations: s.derivations }
}

function requestProblem(r) {
  if (!r || typeof r !== 'object') return 'request must be an object'
  if (!isSubject(r.subject)) return `subject ${JSON.stringify(r.subject)} is not self-certifying (0x<address>:<name>)`
  if (typeof r.capability !== 'string' || !CAPABILITY.test(r.capability)) return `capability ${JSON.stringify(r.capability)} is not a capability name`
  if (typeof r.useClass !== 'string' || !USE_CLASS.test(r.useClass)) return `use class ${JSON.stringify(r.useClass)} is missing or invalid`
  if (typeof r.territory !== 'string' || !TERRITORY.test(r.territory)) return `territory ${JSON.stringify(r.territory)} must be an ISO 3166-1 alpha-2 code`
  if (!Number.isFinite(asDateTime(r.at))) return `at ${JSON.stringify(r.at)} must be ISO-8601 with an offset`
  if (r.estimatedUsd !== null && r.estimatedUsd !== undefined && !finiteNonNegative(r.estimatedUsd)) return `estimatedUsd ${JSON.stringify(r.estimatedUsd)} must be a non-negative number or null`
  return null
}

function knowledgeProblem(k) {
  if (!k || typeof k !== 'object') return 'no knowledge was supplied'
  // forgeries too: without it a trusted producer's unreadable record under a
  // grant would be missed, and its spend would read as nothing.
  for (const f of ['grants', 'states', 'derivations', 'forgeries']) if (!Array.isArray(k[f])) return `knowledge.${f} is not a list`
  if (k.consistency?.ok !== true) return k.consistency?.reason ?? 'knowledge carries no consistency result'
  const orphan = unattributedState(k.states)
  if (orphan) return `state ${orphan.ual ?? orphan.id ?? '(no id)'} about ${orphan.stateOf ?? '(no grant)'} has neither a publisher nor a tier`
  return null
}

/**
 * Decide one request.
 *
 * @param {object} request   { subject, capability, useClass, territory, at, estimatedUsd }
 *                           estimatedUsd null means the price is unknown
 * @param {object} knowledge from readKnowledge
 */
export function decide(request, knowledge) {
  const forgeries = Array.isArray(knowledge?.forgeries) ? knowledge.forgeries : []
  const warnings = [...(Array.isArray(knowledge?.warnings) ? knowledge.warnings : [])]
  const estimateUsd = finiteNonNegative(request?.estimatedUsd) ? request.estimatedUsd : null
  const base = {
    grantId: null, grantUal: null, grantTx: null, publisher: null, tier: null, forgeries, warnings,
    spend: { priorUsd: null, estimateUsd, ceilingUsd: null, unknown: estimateUsd === null },
  }
  const refuse = (clause, reason, extra = {}) => ({ permit: false, clause, reason, ...base, ...extra })

  const bad = requestProblem(request)
  if (bad) return refuse('malformed-request', bad)
  if (isProhibitedUseClass(request.useClass)) {
    return refuse('use-class-prohibited', `use class "${request.useClass}" is never permitted, whatever a grant says`)
  }
  const unreadable = knowledgeProblem(knowledge)
  if (unreadable) return refuse('read-inconsistent', `grant knowledge is incomplete: ${unreadable}`)

  const { subject, capability, useClass, territory } = request
  const when = asDateTime(request.at)

  const named = knowledge.grants.filter(g => g?.subject === subject)
  const byKey = (a, b) => String(a.id).localeCompare(String(b.id)) || String(a.ual).localeCompare(String(b.ual))
  const candidates = named.filter(grantIsAuthentic).sort(byKey)
  for (const g of named) if (!grantIsAuthentic(g)) warnings.push(`ignored grant ${g.id}: not published by ${subjectAddress(subject)}`)
  if (candidates.length === 0) {
    return refuse('grant-exists', `no grant published by ${subjectAddress(subject)} for subject "${subject}"`)
  }
  // One id published twice cannot be told apart: revocations and spend are keyed
  // by id, so the copies would share one spend pool and the looser clauses would
  // win. Neither copy is used.
  const copies = new Map()
  for (const g of knowledge.grants.filter(grantIsAuthentic)) copies.set(g.id, (copies.get(g.id) ?? 0) + 1)
  // A copy the reducer rejected counts too, when it sits in the prefix of the
  // address its id names: it is the grantor's own second copy, perhaps the one
  // that narrows the grant, and ignoring it would leave the looser copy in force.
  const unreadableCopies = unreadableGrantCopies(forgeries)

  // Each grant is checked on its own, clause by clause; the refusal names the
  // furthest clause any grant reached, since that is the one a person can act on.
  let best = null
  const fail = (rank, clause, g, reason, spend) => {
    if (!best || rank > best.rank) best = { rank, clause, g, reason, spend }
  }

  for (const g of candidates) {
    const unreadableCopy = unreadableCopies.get(g.id) ?? 0
    if (copies.get(g.id) + unreadableCopy > 1) {
      const n = copies.get(g.id) + unreadableCopy
      fail(0, 'grant-exists', g, `grant ${g.id} is published more than once (${n} copies${unreadableCopy ? `, ${unreadableCopy} of them unreadable` : ''}), so which one applies cannot be established`)
      continue
    }
    // Clause lists must be real lists: String.prototype.includes would let
    // "advertising" match "ad".
    if (!Array.isArray(g.permitsCapability) || !g.permitsCapability.includes(capability)) {
      fail(1, 'capability-permitted', g, `grant ${g.id} does not permit capability "${capability}" (permits: ${(Array.isArray(g.permitsCapability) ? g.permitsCapability.join(', ') : '') || 'none'})`)
      continue
    }
    const forbids = clauseList(g.forbidsUseClass)
    const permits = clauseList(g.permitsUseClass)
    const territories = clauseList(g.territory)
    if (!forbids || !permits) {
      fail(2, 'use-class-permitted', g, `grant ${g.id} has an unreadable use-class clause`)
      continue
    }
    if (forbids.includes(useClass)) {
      fail(2, 'use-class-permitted', g, `grant ${g.id} forbids use class "${useClass}"`)
      continue
    }
    if (permits.length && !permits.includes(useClass)) {
      fail(2, 'use-class-permitted', g, `grant ${g.id} does not permit use class "${useClass}" (permits: ${permits.join(', ')})`)
      continue
    }
    if (!territories) {
      fail(3, 'territory-permitted', g, `grant ${g.id} has an unreadable territory clause`)
      continue
    }
    if (territories.length && !territories.includes(territory)) {
      fail(3, 'territory-permitted', g, `grant ${g.id} does not cover territory "${territory}" (covers: ${territories.join(', ')})`)
      continue
    }
    const from = g.validFrom == null ? -Infinity : asDateTime(g.validFrom)
    const until = g.validUntil == null ? Infinity : asDateTime(g.validUntil)
    if (Number.isNaN(from) || Number.isNaN(until)) {
      fail(4, 'validity-window', g, `grant ${g.id} has an unreadable validity window`)
      continue
    }
    if (when < from) { fail(4, 'validity-window', g, `grant ${g.id} is not valid until ${g.validFrom}`); continue }
    if (when > until) { fail(4, 'validity-window', g, `grant ${g.id} expired at ${g.validUntil}`); continue }

    const rev = revocationOf(g, knowledge.states)
    if (rev.revoked) {
      const by = rev.by
      fail(5, 'not-revoked', g, by.tier === 'context'
        ? `grant ${g.id} has a revocation in the merged view ${by.graph} whose publisher cannot be established`
        : `grant ${g.id} was revoked by ${g.publisher}${by.stateAt ? ` at ${by.stateAt}` : ''}${by.ual ? ` (${by.ual})` : ''}`)
      continue
    }

    const prior = spendUnder(g.id, knowledge.derivations, forgeries)
    const ceiling = g.maxSpendUsd
    const spend = { priorUsd: usdOfMicro(prior.micro), estimateUsd, ceilingUsd: ceiling ?? null, unknown: prior.unknown || estimateUsd === null }
    if (ceiling !== null && ceiling !== undefined) {
      if (!finiteNonNegative(ceiling)) { fail(6, 'spend-ceiling', g, `grant ${g.id} has an unreadable spend ceiling`, spend); continue }
      if (spend.unknown) {
        const what = estimateUsd === null ? 'cost of this render'
          : prior.unreadable ? `spend already committed (${prior.unreadable} trusted record(s) under it could not be read)` : 'spend already committed'
        fail(6, 'spend-ceiling', g, `grant ${g.id} has a $${ceiling} ceiling and the ${what} is unknown`, spend)
        continue
      }
      // One exact integer comparison: prior and estimate rounded up, ceiling down.
      const estimateMicro = microUsd(estimateUsd)
      if (prior.micro + estimateMicro > microUsd(ceiling, { down: true })) {
        fail(6, 'spend-ceiling', g, `grant ${g.id} ceiling $${ceiling} would be exceeded ($${usdOfMicro(prior.micro).toFixed(6)} already spent + $${usdOfMicro(estimateMicro).toFixed(6)} estimated)`, spend)
        continue
      }
    }

    return {
      permit: true, clause: null, reason: 'all clauses satisfied',
      ...base,
      grantId: g.id, grantUal: g.ual ?? null, grantTx: g.txHash ?? null, publisher: g.publisher, tier: g.tier,
      spend,
    }
  }

  return refuse(best.clause, best.reason, {
    grantId: best.g.id, grantUal: best.g.ual ?? null, grantTx: best.g.txHash ?? null, publisher: best.g.publisher, tier: best.g.tier,
    ...(best.spend ? { spend: best.spend } : {}),
  })
}
