import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decide, revocationOf, priorSpendFor, grantIsAuthentic } from '../src/gate.mjs'
import { CLAUSES } from '../src/vocab.mjs'
import { ANA, PRODUCER, STRANGER, grant, grantKa, revocationKa, derivation, derivationKa, knowledgeOf } from './fixtures/build.mjs'

const SUBJECT = `${ANA}:ana`
const req = (over = {}) => ({
  subject: SUBJECT, capability: 'talking-head', useClass: 'advertising', territory: 'GB',
  at: '2026-09-12T10:00:00Z', estimatedUsd: 1.008, ...over,
})
const K = (...kas) => knowledgeOf(kas)

test('permits when every clause is satisfied, naming the grant\'s anchor', async () => {
  const g = grant()
  const k = await K(grantKa(g))
  const d = decide(req(), k)
  assert.equal(d.permit, true)
  assert.equal(d.grantId, g.id)
  assert.match(d.grantUal, /^did:dkg:base:84532\//)
  assert.ok(d.grantTx)
  assert.equal(d.publisher, ANA)
  assert.equal(d.tier, 'vm')
})

test('clauses are listed in the order the gate applies them', () => {
  assert.deepEqual(CLAUSES, ['malformed-request', 'use-class-prohibited', 'read-inconsistent', 'grant-exists',
    'capability-permitted', 'use-class-permitted', 'territory-permitted', 'validity-window', 'not-revoked', 'spend-ceiling'])
})

test('malformed requests refuse before anything else', async () => {
  const k = await K(grantKa(grant()))
  for (const bad of [
    { subject: 'ana-7f3c' }, { subject: undefined }, { capability: 'Talking Head' }, { useClass: undefined },
    { territory: undefined }, { territory: 'gb' }, { at: undefined }, { at: 'garbage' }, { at: '--execute' },
    { at: '2026-09-12T10:00:00' }, { estimatedUsd: -1 }, { estimatedUsd: NaN }, { estimatedUsd: '1' },
  ]) {
    const d = decide(req(bad), k)
    assert.equal(d.permit, false, JSON.stringify(bad))
    assert.equal(d.clause, 'malformed-request', JSON.stringify(bad))
  }
})

test('prohibited use classes refuse whatever the grant says', async () => {
  const k = await K(grantKa(grant({ permitsUseClass: ['adult', 'deceptive-impersonation'], forbidsUseClass: [] })))
  for (const useClass of ['adult', 'sexual', 'deceptive-impersonation']) {
    assert.equal(decide(req({ useClass }), k).clause, 'use-class-prohibited')
  }
})

test('knowledge without a consistent read refuses', async () => {
  const k = await knowledgeOf([grantKa(grant())], { consistency: { ok: false, reason: 'graph dropped' } })
  const d = decide(req(), k)
  assert.equal(d.clause, 'read-inconsistent')
  assert.match(d.reason, /graph dropped/)
  assert.equal(decide(req(), { grants: k.grants, states: [], derivations: [] }).clause, 'read-inconsistent')
})

test('refuses when no grant exists for the subject', async () => {
  const d = decide(req({ subject: `${ANA}:someone-else` }), await K(grantKa(grant())))
  assert.equal(d.clause, 'grant-exists')
  assert.equal(d.spend.estimateUsd, 1.008)
})

test('capability is matched exactly, not by family', async () => {
  const k = await K(grantKa(grant({ permitsCapability: ['face-swap-image'] })))
  assert.equal(decide(req({ capability: 'face-swap-video' }), k).clause, 'capability-permitted')
})

test('an explicit forbid beats a permit', async () => {
  const k = await K(grantKa(grant({ permitsUseClass: ['advertising', 'political'], forbidsUseClass: ['political'] })))
  assert.equal(decide(req({ useClass: 'political' }), k).clause, 'use-class-permitted')
})

test('refuses outside the territory and outside the validity window', async () => {
  const k = await K(grantKa(grant()))
  assert.equal(decide(req({ territory: 'FR' }), k).clause, 'territory-permitted')
  assert.equal(decide(req({ at: '2027-01-01T00:00:00Z' }), k).clause, 'validity-window')
  assert.equal(decide(req({ at: '2026-08-01T00:00:00Z' }), k).clause, 'validity-window')
})

test('offsets are honoured: the same instant in two time zones decides the same', async () => {
  const k = await K(grantKa(grant({ validUntil: '2026-12-01T00:00:00Z' })))
  assert.equal(decide(req({ at: '2026-12-01T08:59:00+09:00' }), k).permit, true)
  assert.equal(decide(req({ at: '2026-12-01T09:01:00+09:00' }), k).clause, 'validity-window')
})

test('refuses when the grant ceiling would be exceeded', async () => {
  const g = grant({ maxSpendUsd: 5 })
  const k = await K(grantKa(g), derivationKa(derivation({ authorizedUnder: g.id, billedUsd: 4.5 })))
  const d = decide(req({ estimatedUsd: 1 }), k)
  assert.equal(d.clause, 'spend-ceiling')
  assert.deepEqual(d.spend, { priorUsd: 4.5, estimateUsd: 1, ceilingUsd: 5, unknown: false })
  assert.equal(decide(req({ estimatedUsd: 0.5 }), k).permit, true, 'exactly at the ceiling is allowed')
})

test('under a ceiling, an unknown price refuses; without one it does not', async () => {
  assert.equal(decide(req({ estimatedUsd: null }), await K(grantKa(grant({ maxSpendUsd: 5 })))).clause, 'spend-ceiling')
  const open = decide(req({ estimatedUsd: null }), await K(grantKa(grant({ maxSpendUsd: null }))))
  assert.equal(open.permit, true)
  assert.equal(open.spend.unknown, true)
})

test('spend is computed per grant, not taken from the subject\'s first grant', async () => {
  const g1 = grant({ id: `urn:mandate:grant:${ANA}:ana:0000000000000001`, maxSpendUsd: 4 })
  const g2 = grant({ id: `urn:mandate:grant:${ANA}:ana:0000000000000002`, maxSpendUsd: 4 })
  const spent = (id, usd) => derivationKa(derivation({ authorizedUnder: id, billedUsd: usd }))
  const permitsUnderG1 = decide(req({ estimatedUsd: 1 }), await K(grantKa(g1), grantKa(g2), spent(g2.id, 3.9)))
  assert.equal(permitsUnderG1.grantId, g1.id)
  const bothSpent = decide(req({ estimatedUsd: 1 }), await K(grantKa(g1), grantKa(g2), spent(g1.id, 3.9), spent(g2.id, 3.9)))
  assert.equal(bothSpent.clause, 'spend-ceiling')
})

test('a trusted derivation with no billed amount makes spend unknown', () => {
  const s = priorSpendFor('urn:g', [{ trusted: true, authorizedUnder: 'urn:g', billedUsd: null }, { trusted: true, authorizedUnder: 'urn:g', billedUsd: 1 }])
  assert.deepEqual(s, { usd: 1, unknown: true, derivations: 2 })
  assert.equal(priorSpendFor('urn:g', [{ trusted: false, authorizedUnder: 'urn:g', billedUsd: 99 }]).usd, 0)
})

test('refuses after the grantor revokes', async () => {
  const g = grant()
  const d = decide(req(), await K(grantKa(g), revocationKa(g.id)))
  assert.equal(d.clause, 'not-revoked')
  assert.match(d.reason, new RegExp(ANA))
})

test('revocation is terminal: a later "active" from the grantor does not restore the grant', async () => {
  const g = grant()
  const k = await K(grantKa(g), revocationKa(g.id, { at: '2026-09-10T00:00:00Z' }))
  k.states.push({ ...k.states[0], id: 'urn:mandate:state:x', state: 'active', stateAt: '2026-09-11T00:00:00Z' })
  assert.equal(decide(req(), k).clause, 'not-revoked')
})

test('revocationOf counts the grant publisher\'s own states and unattributable merged-view states only', () => {
  const g = { id: 'urn:g', publisher: ANA }
  const s = over => ({ stateOf: 'urn:g', state: 'revoked', tier: 'vm', publisher: ANA, ...over })
  assert.equal(revocationOf(g, [s()]).revoked, true)
  assert.equal(revocationOf(g, [s({ publisher: ANA.toUpperCase().replace('0X', '0x') })]).revoked, true)
  assert.equal(revocationOf(g, [s({ publisher: PRODUCER })]).revoked, false)
  assert.equal(revocationOf(g, [s({ tier: 'swm' })]).revoked, false)
  assert.equal(revocationOf(g, [s({ tier: 'context', publisher: null })]).revoked, true)
  assert.equal(revocationOf(g, [s({ state: 'active' })]).revoked, false)
})

test('hand-built knowledge gets the same provenance checks', async () => {
  const k = await K(grantKa(grant()))
  const forged = { ...k.grants[0], publisher: PRODUCER }
  assert.equal(grantIsAuthentic(forged), false)
  assert.equal(decide(req(), { ...k, grants: [forged] }).clause, 'grant-exists')
  assert.equal(decide(req(), { ...k, grants: [{ ...k.grants[0], tier: 'swm' }] }).clause, 'grant-exists')
  assert.equal(decide(req(), { ...k, grants: [{ ...k.grants[0], grantor: `did:dkg:agent:${STRANGER}` }] }).clause, 'grant-exists')
})

test('an unreadable validity window or ceiling on a hand-built grant refuses', async () => {
  const k = await K(grantKa(grant()))
  assert.equal(decide(req(), { ...k, grants: [{ ...k.grants[0], validUntil: 'not-a-date' }] }).clause, 'validity-window')
  assert.equal(decide(req(), { ...k, grants: [{ ...k.grants[0], maxSpendUsd: NaN }] }).clause, 'spend-ceiling')
})

test('the refusal names the furthest clause any grant reached', async () => {
  const g1 = grant({ id: `urn:mandate:grant:${ANA}:ana:0000000000000001`, permitsCapability: ['face-swap-image'] })
  const g2 = grant({ id: `urn:mandate:grant:${ANA}:ana:0000000000000002`, territory: ['US'] })
  const d = decide(req(), await K(grantKa(g1), grantKa(g2)))
  assert.equal(d.clause, 'territory-permitted')
  assert.equal(d.grantId, g2.id)
})

test('the decision does not depend on the order grants or states are listed in', async () => {
  const g1 = grant({ id: `urn:mandate:grant:${ANA}:ana:0000000000000001` })
  const g2 = grant({ id: `urn:mandate:grant:${ANA}:ana:0000000000000002` })
  const k = await K(grantKa(g1), grantKa(g2), revocationKa(g1.id))
  const a = decide(req(), k)
  const b = decide(req(), { ...k, grants: [...k.grants].reverse(), states: [...k.states].reverse() })
  assert.deepEqual(a, b)
  assert.equal(a.grantId, g2.id)
})
