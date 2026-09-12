import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, effectiveState } from '../src/gate.mjs'
import { STATE_ACTIVE, STATE_REVOKED } from '../src/vocab.mjs'

const ANA      = 'did:dkg:agent:0xeD1eeB64CaC09874257F05Fd6B51A55695ad0B69'
const PRODUCER = 'did:dkg:agent:0x8EaA4857B22dddbfb5ebC476087FEc39336e0CB5'

const grant = (over = {}) => ({
  id: 'urn:mandate:grant:1',
  grantor: ANA,
  subject: 'ana-7f3c',
  consentClipSha256: 'a'.repeat(64),
  permitsCapability: ['talking-head', 'face-swap-image'],
  permitsUseClass: ['advertising'],
  forbidsUseClass: ['political'],
  territory: ['GB', 'US'],
  validFrom: '2026-09-01T00:00:00Z',
  validUntil: '2026-12-01T00:00:00Z',
  maxSpendUsd: 5,
  ...over,
})

const req = (over = {}) => ({
  subject: 'ana-7f3c',
  capability: 'talking-head',
  useClass: 'advertising',
  territory: 'GB',
  at: '2026-09-12T10:00:00Z',
  estimatedUsd: 1.008,
  ...over,
})

test('permits when every clause is satisfied', () => {
  const d = decide(req(), { grants: [grant()] })
  assert.equal(d.permit, true)
  assert.equal(d.grantId, 'urn:mandate:grant:1')
})

test('refuses when no grant exists for the subject', () => {
  const d = decide(req({ subject: 'someone-else' }), { grants: [grant()] })
  assert.equal(d.permit, false)
  assert.equal(d.clause, 'grant-exists')
  assert.equal(d.spendAvoidedUsd, 1.008)
})

test('capability is matched exactly, not by family', () => {
  // A grant for face-swap-image is NOT a grant for face-swap-video.
  const d = decide(req({ capability: 'face-swap-video' }), { grants: [grant()] })
  assert.equal(d.permit, false)
  assert.equal(d.clause, 'capability-permitted')
})

test('refuses an unregistered capability that was never granted', () => {
  // flux-lora-training is `experimental` on the live platform. It lives on the
  // refusal path precisely because a refusal never invokes the capability.
  const d = decide(req({ capability: 'flux-lora-training', estimatedUsd: 2.10 }),
    { grants: [grant()] })
  assert.equal(d.permit, false)
  assert.equal(d.clause, 'capability-permitted')
  assert.equal(d.spendAvoidedUsd, 2.10)
})

test('an explicit forbid beats a permit', () => {
  const d = decide(req({ useClass: 'political' }), { grants: [grant()] })
  assert.equal(d.permit, false)
  assert.equal(d.clause, 'use-class-permitted')
})

test('refuses outside the territory and outside the validity window', () => {
  assert.equal(decide(req({ territory: 'FR' }), { grants: [grant()] }).clause,
    'territory-permitted')
  assert.equal(decide(req({ at: '2027-01-01T00:00:00Z' }), { grants: [grant()] }).clause,
    'validity-window')
})

test('refuses when the grant ceiling would be exceeded', () => {
  const d = decide(req({ estimatedUsd: 1 }), { grants: [grant()], priorSpendUsd: 4.5 })
  assert.equal(d.permit, false)
  assert.equal(d.clause, 'spend-ceiling')
})

// ---------------------------------------------------------------------------
// Revocation, and the forgery it invites.
// ---------------------------------------------------------------------------

test('refuses after the grantor revokes', () => {
  const d = decide(req(), {
    grants: [grant()],
    assertions: [{
      stateOf: 'urn:mandate:grant:1', state: STATE_REVOKED,
      stateAuthor: ANA, stateAt: '2026-09-12T09:59:00Z',
    }],
  })
  assert.equal(d.permit, false)
  assert.equal(d.clause, 'not-revoked')
})

test('THE FORGERY: a producer cannot un-revoke a grant by writing their own state', () => {
  // Ana revokes. The producer then appends a NEWER "active" assertion — which
  // the append-only graph happily stores. If the resolver took the latest
  // assertion, the producer would win and the gate would be theatre.
  const d = decide(req(), {
    grants: [grant()],
    assertions: [
      { stateOf: 'urn:mandate:grant:1', state: STATE_REVOKED,
        stateAuthor: ANA,      stateAt: '2026-09-12T09:59:00Z' },
      { stateOf: 'urn:mandate:grant:1', state: STATE_ACTIVE,
        stateAuthor: PRODUCER, stateAt: '2026-09-12T09:59:30Z' }, // newer, forged
    ],
  })
  assert.equal(d.permit, false, 'a forged state assertion must not resurrect a revoked grant')
  assert.equal(d.clause, 'not-revoked')
  assert.equal(d.ignoredForgeries.length, 1)
  assert.equal(d.ignoredForgeries[0].author, PRODUCER)
})

test('a forged revocation by a stranger cannot block a live grant', () => {
  // The check cuts both ways: a third party must not be able to DoS a grant
  // by writing a revocation they had no authority to write.
  const d = decide(req(), {
    grants: [grant()],
    assertions: [{
      stateOf: 'urn:mandate:grant:1', state: STATE_REVOKED,
      stateAuthor: PRODUCER, stateAt: '2026-09-12T09:59:00Z',
    }],
  })
  assert.equal(d.permit, true, 'only the grantor may revoke')
  assert.equal(d.ignoredForgeries.length, 1)
})

test('effectiveState defaults to active and reports forgeries it ignored', () => {
  const g = grant()
  assert.equal(effectiveState(g, []).state, STATE_ACTIVE)
  const st = effectiveState(g, [
    { stateOf: g.id, state: STATE_REVOKED, stateAuthor: PRODUCER, stateAt: '2026-09-12T09:00:00Z' },
  ])
  assert.equal(st.state, STATE_ACTIVE)
  assert.equal(st.ignoredForgeries.length, 1)
})

test('the newest AUTHENTIC assertion wins, regardless of insertion order', () => {
  const g = grant()
  const st = effectiveState(g, [
    { stateOf: g.id, state: STATE_REVOKED, stateAuthor: ANA, stateAt: '2026-09-12T09:00:00Z' },
    { stateOf: g.id, state: STATE_ACTIVE,  stateAuthor: ANA, stateAt: '2026-09-10T09:00:00Z' },
  ])
  assert.equal(st.state, STATE_REVOKED)
})
