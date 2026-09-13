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
 */
import { isProhibitedUseClass } from './policy.mjs'
import { grantIriAddress } from './provenance.mjs'
import { agentAddress, subjectAddress, isSubject, asDateTime } from './rdf-term.mjs'

const CAPABILITY = /^[a-z0-9][a-z0-9-]{1,63}$/
const USE_CLASS = /^[a-z][a-z0-9-]{0,31}$/
const TERRITORY = /^[A-Z]{2}$/

const micro = usd => Math.round(usd * 1e6)
const fromMicro = m => m / 1e6
const finiteNonNegative = v => typeof v === 'number' && Number.isFinite(v) && v >= 0

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

/**
 * Revocation state of one grant. Terminal: any accepted revocation, at any time,
 * ends the grant — renewing means publishing a new grant id. A revocation
 * counts when its anchor's address is the grant's publisher, or when it appears
 * in a merged view with no publisher at all (the resolver's context tier).
 * Shared-memory revocations are not anchored and only warn.
 */
export function revocationOf(grant, states = []) {
  const about = states.filter(s => s?.stateOf === grant.id)
  const counted = about.filter(s => s.state !== 'active' && (
    (s.tier === 'vm' && typeof s.publisher === 'string' && s.publisher.toLowerCase() === grant.publisher.toLowerCase())
    || s.tier === 'context'))
  counted.sort((a, b) => String(a.ual ?? a.id).localeCompare(String(b.ual ?? b.id)))
  return { revoked: counted.length > 0, by: counted[0] ?? null, all: counted }
}

/**
 * Spend already committed under a grant, from trusted producers' derivations.
 * `unknown` when any of them carries no billed amount.
 */
export function priorSpendFor(grantId, derivations = []) {
  const under = derivations.filter(d => d?.trusted === true && d.authorizedUnder === grantId)
  const unknown = under.some(d => !finiteNonNegative(d.billedUsd))
  const total = under.reduce((m, d) => m + (finiteNonNegative(d.billedUsd) ? micro(d.billedUsd) : 0), 0)
  return { usd: fromMicro(total), unknown, derivations: under.length }
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
  for (const f of ['grants', 'states', 'derivations']) if (!Array.isArray(k[f])) return `knowledge.${f} is not a list`
  if (k.consistency?.ok !== true) return k.consistency?.reason ?? 'knowledge carries no consistency result'
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
  const candidates = named.filter(grantIsAuthentic).sort((a, b) => String(a.id).localeCompare(String(b.id)))
  for (const g of named) if (!grantIsAuthentic(g)) warnings.push(`ignored grant ${g.id}: not published by ${subjectAddress(subject)}`)
  if (candidates.length === 0) {
    return refuse('grant-exists', `no grant published by ${subjectAddress(subject)} for subject "${subject}"`)
  }

  // Each grant is checked on its own, clause by clause; the refusal names the
  // furthest clause any grant reached, since that is the one a person can act on.
  let best = null
  const fail = (rank, clause, g, reason, spend) => {
    if (!best || rank > best.rank) best = { rank, clause, g, reason, spend }
  }

  for (const g of candidates) {
    if (!Array.isArray(g.permitsCapability) || !g.permitsCapability.includes(capability)) {
      fail(1, 'capability-permitted', g, `grant ${g.id} does not permit capability "${capability}" (permits: ${(g.permitsCapability ?? []).join(', ') || 'none'})`)
      continue
    }
    if ((g.forbidsUseClass ?? []).includes(useClass)) {
      fail(2, 'use-class-permitted', g, `grant ${g.id} forbids use class "${useClass}"`)
      continue
    }
    if ((g.permitsUseClass ?? []).length && !g.permitsUseClass.includes(useClass)) {
      fail(2, 'use-class-permitted', g, `grant ${g.id} does not permit use class "${useClass}" (permits: ${g.permitsUseClass.join(', ')})`)
      continue
    }
    if ((g.territory ?? []).length && !g.territory.includes(territory)) {
      fail(3, 'territory-permitted', g, `grant ${g.id} does not cover territory "${territory}" (covers: ${g.territory.join(', ')})`)
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

    const prior = priorSpendFor(g.id, knowledge.derivations)
    const ceiling = g.maxSpendUsd
    const spend = { priorUsd: prior.usd, estimateUsd, ceilingUsd: ceiling ?? null, unknown: prior.unknown || estimateUsd === null }
    if (ceiling !== null && ceiling !== undefined) {
      if (!finiteNonNegative(ceiling)) { fail(6, 'spend-ceiling', g, `grant ${g.id} has an unreadable spend ceiling`, spend); continue }
      if (spend.unknown) {
        fail(6, 'spend-ceiling', g, `grant ${g.id} has a $${ceiling} ceiling and the ${estimateUsd === null ? 'cost of this render' : 'spend already committed'} is unknown`, spend)
        continue
      }
      if (prior.usd === null || micro(prior.usd) + micro(estimateUsd) > micro(ceiling)) {
        fail(6, 'spend-ceiling', g, `grant ${g.id} ceiling $${ceiling} would be exceeded ($${prior.usd.toFixed(4)} already spent + $${estimateUsd.toFixed(4)} estimated)`, spend)
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
