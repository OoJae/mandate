import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyKnowledge, blastRadius, CLEAR, TAINTED, UNKNOWN, INCONCLUSIVE } from '../src/verify-core.mjs'
import * as V from '../src/vocab.mjs'
import { ANA, PRODUCER, STRANGER, grant, grantKa, revocationKa, derivation, derivationKa, knowledgeOf } from './fixtures/build.mjs'

const SHA = 'f'.repeat(64)
const NOW = '2026-09-12T10:00:00Z'
const g = grant({ permitsCapability: ['talking-head'] })
const edge = (over = {}, opts = {}) => derivationKa(derivation({ outputSha256: SHA, authorizedUnder: g.id, servedCapability: 'talking-head', derivedAt: '2026-09-12T09:00:00Z', ...over }), opts)

test('CLEAR when the bytes trace through a trusted edge to a live grant', async () => {
  const r = verifyKnowledge(await knowledgeOf([grantKa(g), edge()]), SHA, { now: NOW })
  assert.equal(r.verdict, CLEAR)
  assert.equal(r.grantor, ANA)
  assert.equal(r.subStatus, null)
})

test('uppercase hex finds the same file', async () => {
  assert.equal(verifyKnowledge(await knowledgeOf([grantKa(g), edge()]), SHA.toUpperCase(), { now: NOW }).verdict, CLEAR)
})

test('UNKNOWN when the bytes are not in the graph at all', async () => {
  const r = verifyKnowledge(await knowledgeOf([grantKa(g), edge()]), 'a'.repeat(64), { now: NOW })
  assert.equal(r.verdict, UNKNOWN)
  assert.match(r.reason, /no derivation edge/)
})

test('INCONCLUSIVE when the read was incomplete', async () => {
  const k = await knowledgeOf([grantKa(g), edge()], { consistency: { ok: false, reason: 'dropped graph' } })
  const r = verifyKnowledge(k, SHA, { now: NOW })
  assert.equal(r.verdict, INCONCLUSIVE)
  assert.match(r.reason, /dropped graph/)
})

test('an edge from an untrusted publisher is shown, not believed', async () => {
  const r = verifyKnowledge(await knowledgeOf([grantKa(g), edge({}, { publisher: STRANGER })]), SHA, { now: NOW })
  assert.equal(r.verdict, UNKNOWN)
  assert.equal(r.untrusted.length, 1)
  assert.equal(r.untrusted[0].publisher, STRANGER)
})

test('TAINTED / REVOKED once the authorising grant is revoked by its grantor', async () => {
  const r = verifyKnowledge(await knowledgeOf([grantKa(g), edge(), revocationKa(g.id)]), SHA, { now: NOW })
  assert.equal(r.verdict, TAINTED)
  assert.equal(r.subStatus, 'REVOKED')
})

test('a revocation published by anyone else changes nothing', async () => {
  const r = verifyKnowledge(await knowledgeOf([grantKa(g), edge(), revocationKa(g.id, { publisher: PRODUCER, author: ANA })]), SHA, { now: NOW })
  assert.equal(r.verdict, CLEAR)
})

test('TAINTED / UNAUTHORISED when the cited grant was never published by its owner', async () => {
  const r = verifyKnowledge(await knowledgeOf([edge()]), SHA, { now: NOW })
  assert.equal(r.verdict, TAINTED)
  assert.equal(r.subStatus, 'UNAUTHORISED')
})

test('TAINTED / UNAUTHORISED when the serving capability was never permitted', async () => {
  const r = verifyKnowledge(await knowledgeOf([grantKa(g), edge({ servedCapability: 'face-swap-video' })]), SHA, { now: NOW })
  assert.equal(r.subStatus, 'UNAUTHORISED')
  assert.match(r.reason, /never permitted/)
})

test('TAINTED / EXPIRED once the grant has expired, distinct from revoked', async () => {
  const r = verifyKnowledge(await knowledgeOf([grantKa(g), edge()]), SHA, { now: '2027-01-01T00:00:00Z' })
  assert.equal(r.verdict, TAINTED)
  assert.equal(r.subStatus, 'EXPIRED')
})

test('TAINTED / NOT_YET_VALID before validFrom, now or by the producer\'s own record', async () => {
  const future = grant({ permitsCapability: ['talking-head'], validFrom: '2030-01-01T00:00:00Z', validUntil: '2031-01-01T00:00:00Z' })
  const k = await knowledgeOf([grantKa(future), edge({ authorizedUnder: future.id })])
  assert.equal(verifyKnowledge(k, SHA, { now: NOW }).subStatus, 'NOT_YET_VALID')
  const early = await knowledgeOf([grantKa(g), edge({ derivedAt: '2026-08-01T00:00:00Z' })])
  assert.equal(verifyKnowledge(early, SHA, { now: NOW }).subStatus, 'NOT_YET_VALID')
})

test('a bad now is an error, not a verdict', async () => {
  const k = await knowledgeOf([grantKa(g), edge()])
  assert.throws(() => verifyKnowledge(k, SHA, { now: 'yesterday' }), /now must be ISO-8601/)
  assert.throws(() => verifyKnowledge(k, 'xyz', { now: NOW }), /sha256/)
})

test('a live grant cannot launder bytes already produced under a revoked one', async () => {
  const g2 = grant({ permitsCapability: ['talking-head'] })
  const k = await knowledgeOf([grantKa(g), grantKa(g2), revocationKa(g.id), edge(), edge({ authorizedUnder: g2.id })])
  const r = verifyKnowledge(k, SHA, { now: NOW })
  assert.equal(r.verdict, TAINTED)
  assert.equal(r.subStatus, 'REVOKED')
  assert.equal(r.judgements.length, 2)
  const reversed = verifyKnowledge({ ...k, derivations: [...k.derivations].reverse(), grants: [...k.grants].reverse() }, SHA, { now: NOW })
  assert.deepEqual(reversed, r)
})

test('a trusted edge with two authorizedUnder values is TAINTED / MALFORMED, in either order', async () => {
  const g2 = grant({ permitsCapability: ['talking-head'] })
  for (const [first, second] of [[g.id, g2.id], [g2.id, g.id]]) {
    const d = derivation({ outputSha256: SHA, authorizedUnder: first, servedCapability: 'talking-head' })
    const k = await knowledgeOf([grantKa(g), grantKa(g2), revocationKa(g.id),
      derivationKa(d, { extraContent: [{ subject: d.id, predicate: V.authorizedUnder, object: second }] })])
    const r = verifyKnowledge(k, SHA, { now: NOW })
    assert.equal(r.verdict, TAINTED)
    assert.equal(r.subStatus, 'MALFORMED')
  }
})

test('CLEAR when every trusted edge is clear', async () => {
  const g2 = grant({ permitsCapability: ['talking-head'] })
  const r = verifyKnowledge(await knowledgeOf([grantKa(g), grantKa(g2), edge(), edge({ authorizedUnder: g2.id })]), SHA, { now: NOW })
  assert.equal(r.verdict, CLEAR)
  assert.equal(r.judgements.length, 2)
})

test('blast radius lists trusted edges under a grant and totals their billing', async () => {
  const k = await knowledgeOf([grantKa(g), edge({ billedUsd: 0.84 }), edge({ outputSha256: 'e'.repeat(64), billedUsd: 0.16 }), edge({}, { publisher: STRANGER })])
  const r = blastRadius(g.id, k.derivations)
  assert.equal(r.assets.length, 2)
  assert.equal(r.totalBilledUsd, 1)
  assert.equal(r.billedUnknown, false)
})
