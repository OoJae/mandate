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

test('INCONCLUSIVE when the knowledge carries no consistency result at all, even with a CLEAR-able edge', async () => {
  const k = await knowledgeOf([grantKa(g), edge()])
  assert.equal(verifyKnowledge(k, SHA, { now: NOW }).verdict, CLEAR)
  for (const consistency of [undefined, {}, { ok: 'true' }, { ok: 1 }]) {
    const r = verifyKnowledge({ ...k, consistency }, SHA, { now: NOW })
    assert.equal(r.verdict, INCONCLUSIVE, JSON.stringify(consistency))
    assert.match(r.reason, /incomplete/)
  }
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

/* Unreadable data never verifies CLEAR. */

const LATER = '2026-11-01T00:00:00Z'
const withGrant = async over => {
  const k = await knowledgeOf([grantKa(g), edge()])
  return { ...k, grants: [{ ...k.grants[0], ...over }] }
}

test('an unreadable validity date on the grant is TAINTED / MALFORMED', async () => {
  for (const over of [{ validUntil: 'not-a-date' }, { validUntil: '2026-12-01T00:00:00' }, { validUntil: new Date('2026-12-01T00:00:00Z') },
    { validUntil: '' }, { validFrom: 'soon' }, { validUntil: '2026-02-31T00:00:00Z' }]) {
    const r = verifyKnowledge(await withGrant(over), SHA, { now: NOW })
    assert.equal(r.verdict, TAINTED, JSON.stringify(over))
    assert.equal(r.subStatus, 'MALFORMED', JSON.stringify(over))
  }
  assert.equal(verifyKnowledge(await withGrant({ validFrom: null, validUntil: null }), SHA, { now: NOW }).verdict, CLEAR, 'absent bounds are open')
})

test('a trusted edge with no readable render time is TAINTED / MALFORMED', async () => {
  const k = await knowledgeOf([grantKa(g), edge()])
  for (const derivedAt of [undefined, null, 'yesterday']) {
    const r = verifyKnowledge({ ...k, derivations: [{ ...k.derivations[0], derivedAt }] }, SHA, { now: NOW })
    assert.equal(r.subStatus, 'MALFORMED', String(derivedAt))
  }
})

test('TAINTED / UNAUTHORISED when the producer records the render after the grant expired, even if now is inside the window', async () => {
  const r = verifyKnowledge(await knowledgeOf([grantKa(g), edge({ derivedAt: '2026-12-15T00:00:00Z' })]), SHA, { now: LATER })
  assert.equal(r.verdict, TAINTED)
  assert.equal(r.subStatus, 'UNAUTHORISED')
  assert.match(r.reason, /after grant .* expired/)
})

test('the grant must be published by the address its id names; case does not split an address', async () => {
  const foreign = await withGrant({ id: `urn:mandate:grant:${STRANGER}:ana:00000000000000aa` })
  const r = verifyKnowledge({ ...foreign, derivations: [{ ...foreign.derivations[0], authorizedUnder: `urn:mandate:grant:${STRANGER}:ana:00000000000000aa` }] }, SHA, { now: NOW })
  assert.equal(r.subStatus, 'UNAUTHORISED')
  const mixedCase = await withGrant({ publisher: ANA.replace(/[a-f]/g, c => c.toUpperCase()).replace('0X', '0x') })
  assert.equal(verifyKnowledge(mixedCase, SHA, { now: NOW }).verdict, CLEAR)
})

test('a trusted producer\'s rejected record for these bytes is TAINTED / MALFORMED whatever its kind', async () => {
  const k = await knowledgeOf([grantKa(g), edge()])
  const forgery = (kind, trusted) => ({ kind, trusted, detail: 'rejected', id: 'urn:mandate:derivation:x', ual: 'did:dkg:base:84532/x/1',
    publisher: PRODUCER, claims: { outputSha256: [SHA], authorizedUnder: [g.id], stateOf: [], subject: [], billedUsd: [] } })
  for (const kind of ['legacy-format', 'derivation-id-mismatch', 'malformed']) {
    const alone = verifyKnowledge({ ...k, derivations: [], forgeries: [forgery(kind, true)] }, SHA, { now: NOW })
    assert.equal(alone.verdict, TAINTED, kind)
    assert.equal(alone.subStatus, 'MALFORMED', kind)
    assert.equal(verifyKnowledge({ ...k, forgeries: [forgery(kind, true)] }, SHA, { now: NOW }).verdict, TAINTED, `${kind} beside a clear edge`)
  }
  assert.equal(verifyKnowledge({ ...k, forgeries: [forgery('legacy-format', false)] }, SHA, { now: NOW }).verdict, CLEAR)
})

test('an edge citing a grant kept in a graph this verifier does not read is UNKNOWN, not TAINTED', async () => {
  const k = await knowledgeOf([edge()])
  const r = verifyKnowledge({ ...k, unresolvedGrants: [g.id] }, SHA, { now: NOW })
  assert.equal(r.verdict, UNKNOWN)
  assert.match(r.reason, /graph this verifier does not read/)
  assert.equal(verifyKnowledge(k, SHA, { now: NOW }).subStatus, 'UNAUTHORISED', 'a grantor graph that is read and lacks the grant stays TAINTED')
  const g2 = grant({ permitsCapability: ['talking-head'] })
  const mixed = await knowledgeOf([grantKa(g2), edge(), edge({ authorizedUnder: g2.id })])
  assert.equal(verifyKnowledge({ ...mixed, unresolvedGrants: [g.id] }, SHA, { now: NOW }).verdict, UNKNOWN, 'CLEAR needs every judgement clear')
  const revoked = await knowledgeOf([grantKa(g2), revocationKa(g2.id), edge(), edge({ authorizedUnder: g2.id })])
  assert.equal(verifyKnowledge({ ...revoked, unresolvedGrants: [g.id] }, SHA, { now: NOW }).verdict, TAINTED, 'any TAINTED wins')
})

test('with no edge at all, the reason says the bytes may sit in a graph this verifier does not read', async () => {
  const r = verifyKnowledge(await knowledgeOf([grantKa(g)]), SHA, { now: NOW })
  assert.match(r.reason, /graph this verifier does not read/)
})

test('hand-built knowledge missing a list is INCONCLUSIVE, never CLEAR', async () => {
  const k = await knowledgeOf([grantKa(g), edge()])
  for (const f of ['grants', 'states', 'derivations']) {
    const { [f]: _, ...rest } = k
    assert.equal(verifyKnowledge(rest, SHA, { now: NOW }).verdict, INCONCLUSIVE, f)
  }
  assert.equal(verifyKnowledge({ ...k, states: 'none' }, SHA, { now: NOW }).verdict, INCONCLUSIVE)
  assert.equal(verifyKnowledge(await withGrant({ permitsCapability: 'talking-head-pro' }), SHA, { now: NOW }).subStatus, 'MALFORMED')
})

test('a grant id published twice is TAINTED / MALFORMED, whichever copy comes first', async () => {
  const g2 = { ...g, permitsCapability: ['sync-lipsync-v3'] }
  const results = []
  for (const order of [[grantKa(g), grantKa(g2)], [grantKa(g2), grantKa(g)]]) {
    const k = await knowledgeOf([...order, edge()])
    results.push(verifyKnowledge(k, SHA, { now: NOW }))
  }
  for (const r of results) { assert.equal(r.verdict, TAINTED); assert.equal(r.subStatus, 'MALFORMED'); assert.match(r.reason, /more than once/) }
  assert.equal(results[0].reason, results[1].reason)
})

test('rejected and malformed state assertions about a cited grant are reported', async () => {
  const k = await knowledgeOf([grantKa(g), edge()])
  const stateForgery = { kind: 'state-not-by-grantor', trusted: false, detail: 'x', id: 'urn:mandate:state:1', publisher: STRANGER,
    claims: { stateOf: [g.id], outputSha256: [], authorizedUnder: [], subject: [] } }
  const unrelated = { ...stateForgery, claims: { ...stateForgery.claims, stateOf: ['urn:mandate:grant:other'] } }
  const r = verifyKnowledge({ ...k, forgeries: [stateForgery, unrelated] }, SHA, { now: NOW })
  assert.deepEqual(r.forgeries, [stateForgery])
  assert.equal(r.verdict, CLEAR)
  const malformed = { id: 'urn:mandate:state:2', ual: 'did:dkg:base:84532/a/9', stateOf: g.id, state: 'revoked', tier: 'vm', publisher: ANA, malformed: true, problems: ['invalid stateAt'] }
  const m = verifyKnowledge({ ...k, states: [malformed] }, SHA, { now: NOW })
  assert.equal(m.subStatus, 'REVOKED')
  assert.ok(m.warnings.some(w => /malformed state assertion.*invalid stateAt/.test(w)))
})

test('verdict reasons say what EXPIRED and CLEAR do and do not establish', async () => {
  const k = await knowledgeOf([grantKa(g), edge()])
  assert.match(verifyKnowledge(k, SHA, { now: NOW }).reason, /does not check use class, territory, prohibited uses or the spend ceiling/)
  assert.match(verifyKnowledge(k, SHA, { now: '2027-01-01T00:00:00Z' }).reason, /producer's own claim/)
})

test('blast radius counts unreadable trusted records and totals exactly', () => {
  const d = billedUsd => ({ trusted: true, authorizedUnder: 'urn:g', billedUsd, ual: String(billedUsd) })
  const r = blastRadius('urn:g', [d(3e-7), d(3e-7)], [
    { trusted: true, claims: { authorizedUnder: ['urn:g'] } }, { trusted: false, claims: { authorizedUnder: ['urn:g'] } }])
  assert.equal(r.unreadable, 1)
  assert.equal(r.billedUnknown, true)
  assert.equal(r.totalBilledUsd, 0.000002)
  assert.equal(blastRadius('urn:g', [d(0.1), d(0.2)]).totalBilledUsd, 0.3)
  assert.equal(blastRadius('urn:g', [d(0.1)]).unreadable, 0)
})
