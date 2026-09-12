/**
 * The gate.
 *
 * Given a render request and the grant knowledge resolved from the DKG, decide
 * whether a Livepeer capability may be dispatched. The gate is deliberately
 * pure: no network, no clock of its own, no I/O. Everything it needs is passed
 * in, so the decision is reproducible and testable, and so a judge can read the
 * whole policy in one file.
 *
 * The effect of the knowledge here is REFUSAL, not improvement. That is the
 * whole thesis: delete the graph and you do not get a worse product, you get a
 * render tool with a consent checkbox.
 */
import { STATE_ACTIVE, STATE_REVOKED } from './vocab.mjs'

/** A refusal is free to produce: nothing was dispatched, so nothing was billed. */
const refuse = (clause, reason, extra = {}) => ({
  permit: false, clause, reason, ...extra,
})
const permit = (grantId, extra = {}) => ({
  permit: true, clause: null, reason: 'all clauses satisfied', grantId, ...extra,
})

/**
 * Resolve the current state of a grant from an append-only set of assertions.
 *
 * This is the single most important function in the project.
 *
 * The DKG is append-only: there is no delete, so a "revoked" assertion and an
 * "active" assertion coexist in the graph forever, and ANY agent can write a
 * triple claiming any grant is still live. If the resolver simply took the
 * newest assertion, the producer — the party with the strongest incentive to
 * keep rendering — would just write their own "active" and win.
 *
 * So state is only counted when the author IS the grantor named in the grant
 * itself. Everything else is ignored, and reported, so the forgery is visible
 * rather than silently dropped.
 */
export function effectiveState(grant, assertions, { now } = {}) {
  const mine = assertions.filter(a => a.stateOf === grant.id)
  const authentic = mine.filter(a => a.stateAuthor === grant.grantor)
  const forged = mine.filter(a => a.stateAuthor !== grant.grantor)

  const latest = authentic
    .slice()
    .sort((a, b) => Date.parse(a.stateAt) - Date.parse(b.stateAt))
    .pop()

  return {
    // A grant with no authentic state assertion is active: the grant's own
    // publication is the first assertion of intent.
    state: latest?.state ?? STATE_ACTIVE,
    at: latest?.stateAt ?? grant.validFrom ?? null,
    ignoredForgeries: forged.map(f => ({
      claimed: f.state, author: f.stateAuthor, at: f.stateAt,
    })),
    now: now ?? null,
  }
}

/**
 * Decide one request.
 *
 * `grants`     — candidate grants resolved from the graph for this subject
 * `assertions` — every state assertion seen, authentic or not
 * `priorSpendUsd` — already spent under the matched grant, from the derivation graph
 */
export function decide(request, { grants = [], assertions = [], priorSpendUsd = 0 } = {}) {
  const { subject, capability, useClass, territory, at, estimatedUsd = 0 } = request
  const when = Date.parse(at)

  // Clause 1 — a grant must exist for this declared subject at all.
  const forSubject = grants.filter(g => g.subject === subject)
  if (forSubject.length === 0) {
    return refuse('grant-exists',
      `no grant published for subject "${subject}"`,
      { spendAvoidedUsd: estimatedUsd })
  }

  // Walk the remaining clauses. We keep the most specific failure we saw so the
  // refusal message names the clause a human can actually act on, rather than a
  // generic "denied".
  let bestFailure = null
  const note = f => {
    if (!bestFailure || f.rank > bestFailure.rank) bestFailure = f
  }

  for (const g of forSubject) {
    // Clause 2 — the exact Livepeer capability must be named in the grant.
    // Capability names are matched exactly, never by prefix or family: a grant
    // for `face-swap-image` is not a grant for `face-swap-video`.
    if (!g.permitsCapability.includes(capability)) {
      note({ rank: 2, clause: 'capability-permitted', grantId: g.id,
        reason: `grant ${g.id} does not permit capability "${capability}" (permits: ${g.permitsCapability.join(', ') || 'none'})` })
      continue
    }

    // Clause 3 — use class. A forbid always beats a permit.
    if (g.forbidsUseClass?.includes(useClass)) {
      note({ rank: 3, clause: 'use-class-permitted', grantId: g.id,
        reason: `grant ${g.id} explicitly forbids use class "${useClass}"` })
      continue
    }
    if (g.permitsUseClass?.length && !g.permitsUseClass.includes(useClass)) {
      note({ rank: 3, clause: 'use-class-permitted', grantId: g.id,
        reason: `grant ${g.id} does not permit use class "${useClass}" (permits: ${g.permitsUseClass.join(', ')})` })
      continue
    }

    // Clause 4 — territory. An empty territory list means unrestricted.
    if (g.territory?.length && territory && !g.territory.includes(territory)) {
      note({ rank: 4, clause: 'territory-permitted', grantId: g.id,
        reason: `grant ${g.id} does not cover territory "${territory}" (covers: ${g.territory.join(', ')})` })
      continue
    }

    // Clause 5 — validity window.
    if (g.validFrom && when < Date.parse(g.validFrom)) {
      note({ rank: 5, clause: 'validity-window', grantId: g.id,
        reason: `grant ${g.id} is not valid until ${g.validFrom}` })
      continue
    }
    if (g.validUntil && when > Date.parse(g.validUntil)) {
      note({ rank: 5, clause: 'validity-window', grantId: g.id,
        reason: `grant ${g.id} expired at ${g.validUntil}` })
      continue
    }

    // Clause 6 — revocation, counting only assertions the grantor authored.
    const st = effectiveState(g, assertions, { now: at })
    if (st.state === STATE_REVOKED) {
      note({ rank: 6, clause: 'not-revoked', grantId: g.id,
        reason: `grant ${g.id} was revoked at ${st.at} by ${g.grantor}`,
        ignoredForgeries: st.ignoredForgeries })
      continue
    }

    // Clause 7 — spend ceiling. Enforced here, in our own resolver, rather than
    // relying on the platform's spend_cap: that tool documents its pre-flight
    // against create_media, and we dispatch through run_capability. Platform
    // spend_cap is set too, as a second belt, but this is the check we own.
    if (g.maxSpendUsd != null && estimatedUsd != null && priorSpendUsd + estimatedUsd > g.maxSpendUsd) {
      note({ rank: 7, clause: 'spend-ceiling', grantId: g.id,
        reason: `grant ${g.id} ceiling $${g.maxSpendUsd} would be exceeded (` +
                `$${priorSpendUsd.toFixed(4)} already spent + $${estimatedUsd.toFixed(4)} requested)` })
      continue
    }

    return permit(g.id, {
      grantor: g.grantor,
      ignoredForgeries: st.ignoredForgeries,
      estimatedUsd,
    })
  }

  return refuse(bestFailure.clause, bestFailure.reason, {
    grantId: bestFailure.grantId,
    spendAvoidedUsd: estimatedUsd,
    ignoredForgeries: bestFailure.ignoredForgeries ?? [],
  })
}
