import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readKnowledge, readPublisher } from '../src/resolve.mjs'
import { decide } from '../src/gate.mjs'
import { verifyKnowledge, CLEAR, INCONCLUSIVE } from '../src/verify-core.mjs'
import { memoryStateStore } from '../src/state-store.mjs'
import { cgIri } from '../src/queries.mjs'
import * as V from '../src/vocab.mjs'
import { FakeNode } from './fixtures/fake-node.mjs'
import {
  GRANTS_CG, DERIVS_CG, ANA, PRODUCER, STRANGER, ka, grant, grantKa, revocationKa, derivation, derivationKa,
} from './fixtures/build.mjs'

const SUBJECT = `${ANA}:ana`
const cfg = (over = {}) => ({ grantsCg: GRANTS_CG, derivationsCgs: [DERIVS_CG], sleep: async () => {}, ...over })
const req = (over = {}) => ({
  subject: SUBJECT, capability: 'talking-head', useClass: 'advertising', territory: 'GB',
  at: '2026-09-13T10:00:00Z', estimatedUsd: 1, ...over,
})
const world = (grants = [], derivs = [], extra = {}) => ({
  [GRANTS_CG]: { kas: grants, graphs: extra.grantGraphs ?? [] },
  [DERIVS_CG]: { kas: derivs, graphs: extra.derivGraphs ?? [] },
})

test('reads a subject\'s grant from the subject\'s own graph and permits', async () => {
  const g = grant()
  const k = await readKnowledge(new FakeNode({ world: world([grantKa(g)]) }), cfg(), { subject: SUBJECT })
  assert.equal(k.consistency.ok, true)
  assert.equal(k.grants.length, 1)
  assert.equal(decide(req(), k).permit, true)
})

test('reads are scoped to one publisher: a stranger\'s graphs are never read in full', async () => {
  const node = new FakeNode({ world: world([grantKa(grant())]) })
  await readKnowledge(node, cfg(), { subject: SUBJECT })
  const scoped = node.calls.filter(c => c.kind === 'content' || c.kind === 'count')
  assert.ok(scoped.length > 0)
  for (const c of scoped) assert.match(c.prefix, /\/_verifiable_memory\/0x[0-9a-f]{40}\/$/)
})

test('a whole result dropped on some attempts is recovered by merging attempts', async () => {
  const g = grant()
  const drop = ({ call }) => call % 2 === 0
  const k = await readKnowledge(new FakeNode({ world: world([grantKa(g), revocationKa(g.id)]), drop }), cfg(), { subject: SUBJECT })
  assert.equal(k.consistency.ok, true)
  assert.equal(k.states.length, 1)
  assert.equal(decide(req(), k).clause, 'not-revoked')
})

test('THE LIVE FAULT: a revocation graph silently omitted from every read refuses, never permits', async () => {
  const g = grant()
  const r = revocationKa(g.id)
  const drop = ({ graph, kind }) => kind === 'content' && graph === r.graph
  const k = await readKnowledge(new FakeNode({ world: world([grantKa(g), r]), drop }), cfg({ attempts: 3 }), { subject: SUBJECT })
  assert.equal(k.consistency.ok, false)
  assert.match(k.consistency.reason, /returned 0 of/)
  const d = decide(req(), k)
  assert.equal(d.permit, false)
  assert.equal(d.clause, 'read-inconsistent')
})

test('an unreachable node is an inconsistent read', async () => {
  const node = { name: 'down', queryJson: async () => { throw new Error('ECONNREFUSED') } }
  const k = await readKnowledge(node, cfg({ attempts: 2 }), { subject: SUBJECT })
  assert.equal(k.consistency.ok, false)
  assert.match(k.consistency.reason, /ECONNREFUSED/)
  assert.equal(decide(req(), k).clause, 'read-inconsistent')
})

test('a read past the row limit refuses rather than deciding from part of it', async () => {
  const k = await readKnowledge(new FakeNode({ world: world([grantKa(grant())]) }), cfg({ max: 5 }), { subject: SUBJECT })
  assert.equal(k.consistency.ok, false)
  assert.match(k.consistency.reason, /more than 5 rows/)
})

test('an empty answer is believed only after every attempt agrees', async () => {
  const node = new FakeNode({ world: world() })
  const k = await readKnowledge(node, cfg({ attempts: 3 }), { subject: SUBJECT })
  assert.equal(k.consistency.ok, true)
  assert.equal(node.calls.filter(c => c.kind === 'content').length, 6, 'three attempts each for grants and derivations')
})

test('local memory: an anchor seen once and then missing makes the read inconsistent', async () => {
  const g = grant()
  const r = revocationKa(g.id)
  const store = memoryStateStore()
  const first = await readKnowledge(new FakeNode({ world: world([grantKa(g), r]) }), cfg({ stateStore: store }), { subject: SUBJECT })
  assert.equal(first.consistency.ok, true)
  // The node now shows the grant but not the revocation, consistently.
  const later = await readKnowledge(new FakeNode({ world: world([grantKa(g)]) }), cfg({ stateStore: store }), { subject: SUBJECT })
  assert.equal(later.consistency.ok, false)
  assert.match(later.consistency.reason, /previously confirmed/)
  assert.equal(decide(req(), later).permit, false)
})

test('an unconfirmed anchor is accounted for but its content is never accepted', async () => {
  const g = grant()
  const k = await readKnowledge(new FakeNode({ world: world([grantKa(g, { status: 'tentative' })]) }), cfg(), { subject: SUBJECT })
  assert.equal(k.consistency.ok, true)
  assert.equal(k.grants.length, 0)
  assert.ok(k.warnings.some(w => /not a confirmed anchor/.test(w)))
})

test('spend counts only trusted producers\' derivations under each grant', async () => {
  const g = grant({ maxSpendUsd: 2 })
  const mine = derivationKa(derivation({ authorizedUnder: g.id, billedUsd: 1.5 }))
  const stranger = derivationKa(derivation({ authorizedUnder: g.id, billedUsd: 100 }), { publisher: STRANGER })
  const k = await readKnowledge(new FakeNode({ world: world([grantKa(g)], [mine, stranger]) }), cfg(), { subject: SUBJECT })
  const d = decide(req({ estimatedUsd: 0.4 }), k)
  assert.equal(d.permit, true)
  assert.equal(d.spend.priorUsd, 1.5)
  assert.equal(decide(req({ estimatedUsd: 0.6 }), k).clause, 'spend-ceiling')
})

test('forgeries outside the grantor\'s graph are found, attributed, and change nothing', async () => {
  const g = grant()
  const fakeActive = ka({ cg: GRANTS_CG, publisher: PRODUCER, quads: [
    { subject: 'urn:mandate:state:0000000000000001', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: V.GrantState },
    { subject: 'urn:mandate:state:0000000000000001', predicate: V.stateOf, object: g.id },
    { subject: 'urn:mandate:state:0000000000000001', predicate: V.state, object: '"active"' },
    { subject: 'urn:mandate:state:0000000000000001', predicate: V.stateAuthor, object: `did:dkg:agent:${ANA}` },
  ] })
  const fakeGrant = grantKa(grant({ permitsCapability: ['face-swap-video'] }), { publisher: PRODUCER })
  const node = new FakeNode({ world: world([grantKa(g), revocationKa(g.id), fakeActive, fakeGrant]) })
  const k = await readKnowledge(node, cfg(), { subject: SUBJECT })
  assert.equal(k.consistency.ok, true)
  const kinds = k.forgeries.map(f => f.kind).sort()
  assert.deepEqual(kinds, ['grant-not-by-subject', 'state-not-by-grantor'])
  for (const f of k.forgeries) {
    assert.equal(f.publisher, PRODUCER)
    assert.match(f.ual, new RegExp(`/${PRODUCER}/`))
    assert.equal(f.anchored, true)
    assert.ok(f.txHash)
  }
  const d = decide(req(), k)
  assert.equal(d.clause, 'not-revoked')
  assert.equal(decide(req({ capability: 'face-swap-video' }), k).permit, false)
})

test('a revocation in shared memory only warns', async () => {
  const g = grant()
  const swm = { graph: `${cgIri(GRANTS_CG)}/_shared_memory/${ANA}/0`, rows: [
    { s: 'urn:mandate:state:00000000000000aa', p: V.stateOf, o: g.id },
    { s: 'urn:mandate:state:00000000000000aa', p: V.state, o: '"revoked"' },
  ] }
  const k = await readKnowledge(new FakeNode({ world: world([grantKa(g)], [], { grantGraphs: [swm] }) }), cfg(), { subject: SUBJECT })
  assert.equal(decide(req(), k).permit, true)
  assert.ok(k.warnings.some(w => /shared memory/.test(w)))
})

test('a revocation only in the merged view, with no Verifiable Memory copy, refuses', async () => {
  const g = grant()
  const orphan = { graph: `${cgIri(GRANTS_CG)}/context/1`, rows: [
    { s: 'urn:mandate:state:00000000000000bb', p: V.stateOf, o: g.id },
    { s: 'urn:mandate:state:00000000000000bb', p: V.state, o: '"revoked"' },
  ] }
  const k = await readKnowledge(new FakeNode({ world: world([grantKa(g)], [], { grantGraphs: [orphan] }) }), cfg(), { subject: SUBJECT })
  const d = decide(req(), k)
  assert.equal(d.clause, 'not-revoked')
  assert.match(d.reason, /publisher cannot be established/)
})

test('a stranger\'s published revocation appears in the merged view too, but is judged by its publisher', async () => {
  const g = grant()
  const k = await readKnowledge(new FakeNode({ world: world([grantKa(g), revocationKa(g.id, { publisher: STRANGER })]) }), cfg(), { subject: SUBJECT })
  assert.equal(decide(req(), k).permit, true)
  assert.equal(k.forgeries[0].kind, 'state-not-by-grantor')
})

test('verify by file: edges from trusted producers, grants from the grantor they cite', async () => {
  const g = grant()
  const sha = 'a'.repeat(64)
  const node = new FakeNode({ world: world([grantKa(g)], [
    derivationKa(derivation({ outputSha256: sha, authorizedUnder: g.id, servedCapability: 'talking-head' })),
    derivationKa(derivation({ outputSha256: sha, authorizedUnder: g.id, servedCapability: 'face-swap-video' }), { publisher: STRANGER }),
  ]) })
  const k = await readKnowledge(node, cfg(), { sha256: sha })
  const v = verifyKnowledge(k, sha, { now: '2026-09-13T12:00:00Z' })
  assert.equal(v.verdict, CLEAR)
  assert.equal(v.untrusted.length, 1)
  assert.equal(v.untrusted[0].publisher, STRANGER)
})

test('verify is INCONCLUSIVE when the read is incomplete', async () => {
  const node = { name: 'down', queryJson: async () => { throw new Error('ECONNREFUSED') } }
  const k = await readKnowledge(node, cfg({ attempts: 1 }), { sha256: 'a'.repeat(64) })
  assert.equal(verifyKnowledge(k, 'a'.repeat(64), { now: '2026-09-13T12:00:00Z' }).verdict, INCONCLUSIVE)
})

test('readPublisher reports the attempts it used', async () => {
  const r = await readPublisher(new FakeNode({ world: world([grantKa(grant())]) }), {
    contextGraphId: GRANTS_CG, publisher: ANA, role: 'grants', sleep: async () => {},
  })
  assert.equal(r.consistency.ok, true)
  assert.equal(r.consistency.attempts, 1)
})
