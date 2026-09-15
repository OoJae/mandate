import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readKnowledge, readPublisher } from '../src/resolve.mjs'
import { decide } from '../src/gate.mjs'
import { verifyKnowledge, CLEAR, INCONCLUSIVE } from '../src/verify-core.mjs'
import { memoryStateStore, fileStateStore, StateReadError } from '../src/state-store.mjs'
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

test('a read past the total row limit refuses rather than deciding from part of it', async () => {
  const k = await readKnowledge(new FakeNode({ world: world([grantKa(grant())]) }), cfg({ max: 5, maxRows: 10 }), { subject: SUBJECT })
  assert.equal(k.consistency.ok, false)
  assert.match(k.consistency.reason, /over its row limit \(more than 10 rows\)/)
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

test('an anchor that stays unconfirmed in the grantor\'s own prefix is retried, never accepted, and ends inconsistent', async () => {
  const g = grant()
  const node = new FakeNode({ world: world([grantKa(g, { status: 'tentative' })]) })
  const k = await readKnowledge(node, cfg({ attempts: 3 }), { subject: SUBJECT })
  assert.equal(k.consistency.ok, false)
  assert.match(k.consistency.reason, /is not a confirmed anchor after 3 attempts \(status tentative\)/)
  assert.equal(k.grants.length, 0)
  assert.equal(decide(req(), k).clause, 'read-inconsistent')
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

test('a stranger\'s published revocation is judged by its publisher', async () => {
  const g = grant()
  const kas = [grantKa(g), revocationKa(g.id, { publisher: STRANGER })]
  // A live node that did not publish the stranger's state holds no merged-view copy of it.
  const k = await readKnowledge(new FakeNode({ world: world(kas), mergedView: false }), cfg(), { subject: SUBJECT })
  assert.equal(decide(req(), k).permit, true)
  assert.equal(k.forgeries[0].kind, 'state-not-by-grantor')
  // Trade-off: only a copy under the grant owner's prefix explains a merged-view row, so on a
  // node that materialised the stranger's state (the stranger's own node) the view copy refuses.
  const own = await readKnowledge(new FakeNode({ world: world(kas) }), cfg(), { subject: SUBJECT })
  assert.equal(decide(req(), own).clause, 'not-revoked')
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

test('a forgery found by both the producer read and discovery is reported once', async () => {
  const g = grant()
  const misplaced = ka({ cg: DERIVS_CG, publisher: PRODUCER, quads: [
    { subject: 'urn:mandate:state:00000000000000cc', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: V.GrantState },
    { subject: 'urn:mandate:state:00000000000000cc', predicate: V.stateOf, object: g.id },
    { subject: 'urn:mandate:state:00000000000000cc', predicate: V.state, object: '"active"' },
    { subject: 'urn:mandate:state:00000000000000cc', predicate: V.stateAuthor, object: `did:dkg:agent:${ANA}` },
  ] })
  const k = await readKnowledge(new FakeNode({ world: world([grantKa(g)], [misplaced]) }), cfg(), { subject: SUBJECT })
  assert.equal(k.forgeries.filter(f => f.id === 'urn:mandate:state:00000000000000cc').length, 1)
})

test('DKG-3: a node behind the chain is an inconsistent read, however consistent its answers', async () => {
  const g = grant()
  const node = new FakeNode({ world: world([grantKa(g)]) })
  node.reconcile = async cg => ({ status: cg === GRANTS_CG ? 'pending' : 'current', headOrdinal: cg === GRANTS_CG ? 2 : 0, watermarkAfter: cg === GRANTS_CG ? 1 : 0 })
  const k = await readKnowledge(node, cfg({ checkFreshness: true }), { subject: SUBJECT })
  assert.equal(k.consistency.ok, false)
  assert.match(k.consistency.reason, /stale view: fake holds 1 of the 2 assets/)
  assert.equal(decide(req(), k).clause, 'read-inconsistent')
})

test('a node that cannot report freshness gives a warning, not a refusal', async () => {
  const node = new FakeNode({ world: world([grantKa(grant())]) })
  const { DkgHttpError } = await import('../src/dkg.mjs')
  node.reconcile = async () => { throw new DkgHttpError('forbidden', { status: 403, body: { error: 'requires a node-level admin token' } }) }
  const k = await readKnowledge(node, cfg({ checkFreshness: true }), { subject: SUBJECT })
  assert.equal(k.consistency.ok, true)
  assert.ok(k.warnings.some(w => /freshness .* not checked \(403/.test(w)))
})

/* ------------------------------ fail-open reads ------------------------------ */

const { DkgHttpError } = await import('../src/dkg.mjs')
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const XSD_INT = '^^<http://www.w3.org/2001/XMLSchema#integer>'
const isPrefixRead = sparql => !sparql.includes('?m <') && !/^SELECT (DISTINCT )?\?g \?s( \?o \?v)? WHERE|^SELECT DISTINCT \?g \?s \?o \?v/.test(sparql)
/** A node that answers through `inner` unless `fault` returns rows or throws. */
const wrap = (inner, fault) => ({ name: 'flaky', calls: inner.calls, queryJson: async (sparql, o) => (await fault(sparql, o)) ?? inner.queryJson(sparql, o) })

test('R5: one empty answer followed by failed attempts is not believed', async () => {
  const g = grant({ maxSpendUsd: 2 })
  const inner = new FakeNode({ world: world([grantKa(g)], [derivationKa(derivation({ authorizedUnder: g.id, billedUsd: 1.5 }))]) })
  let calls = 0
  const node = wrap(inner, async (sparql, o) => {
    if (o.contextGraphId !== DERIVS_CG || !isPrefixRead(sparql)) return null
    if (++calls > 3) throw new Error('timeout')
    return sparql.includes('COUNT(DISTINCT ?g)') ? [{ n: `"0"${XSD_INT}` }] : []
  })
  const k = await readKnowledge(node, cfg(), { subject: SUBJECT })
  assert.equal(k.consistency.ok, false)
  assert.match(k.consistency.reason, /3 of 4 attempts failed .*timeout.*every attempt answers/)
  assert.equal(decide(req(), k).clause, 'read-inconsistent')
})

test('R5: failed attempts followed by one empty answer are not believed either', async () => {
  const inner = new FakeNode({ world: world([grantKa(grant())]) })
  let calls = 0
  const node = wrap(inner, async (sparql, o) => {
    if (o.contextGraphId !== DERIVS_CG || !isPrefixRead(sparql)) return null
    if (++calls <= 9) throw new Error('503')
    return null
  })
  const k = await readKnowledge(node, cfg(), { subject: SUBJECT })
  assert.equal(k.consistency.ok, false)
  assert.match(k.consistency.reason, /attempts failed/)
})

test('a node that does not report a graph count is an inconsistent read', async () => {
  const inner = new FakeNode({ world: world([grantKa(grant())]) })
  const node = wrap(inner, async sparql => (sparql.includes('COUNT(DISTINCT ?g)') ? [] : null))
  const k = await readKnowledge(node, cfg({ attempts: 2 }), { subject: SUBJECT })
  assert.equal(k.consistency.ok, false)
  assert.match(k.consistency.reason, /did not report a graph count/)
})

test('R6: state discovery that never answers makes the read inconsistent, so a merged-view revocation is not skipped', async () => {
  const g = grant()
  const orphan = { graph: `${cgIri(GRANTS_CG)}/context/1`, rows: [
    { s: 'urn:mandate:state:00000000000000bb', p: V.stateOf, o: g.id },
    { s: 'urn:mandate:state:00000000000000bb', p: V.state, o: '"revoked"' },
  ] }
  const inner = new FakeNode({ world: world([grantKa(g)], [], { grantGraphs: [orphan] }) })
  const node = wrap(inner, async (sparql, o) => { if (o.view === 'verifiable-memory') throw new Error('timeout') })
  const k = await readKnowledge(node, cfg(), { subject: SUBJECT })
  assert.equal(k.consistency.ok, false)
  assert.match(k.consistency.reason, /state discovery: 1 of \d+ queries never answered/)
  assert.equal(decide(req(), k).permit, false)
})

test('R6: grant discovery that does not answer makes the read inconsistent', async () => {
  const inner = new FakeNode({ world: world([grantKa(grant())]) })
  const node = wrap(inner, async sparql => { if (/^SELECT DISTINCT \?g \?s WHERE/.test(sparql)) throw new Error('timeout') })
  const k = await readKnowledge(node, cfg(), { subject: SUBJECT })
  assert.equal(k.consistency.ok, false)
  assert.match(k.consistency.reason, /grant discovery .* did not answer/)
})

test('R6: discovery covers every grant id, not the first fifty', async () => {
  const grants = Array.from({ length: 60 }, () => grant())
  const orphans = grants.map((g, i) => {
    const s = `urn:mandate:state:${String(i).padStart(16, '0')}`
    return { graph: `${cgIri(GRANTS_CG)}/context/1`, rows: [{ s, p: V.stateOf, o: g.id }, { s, p: V.state, o: '"revoked"' }] }
  })
  const k = await readKnowledge(new FakeNode({ world: world(grants.map(g => grantKa(g)), [], { grantGraphs: orphans }) }), cfg(), { subject: SUBJECT })
  assert.equal(k.consistency.ok, true)
  assert.equal(k.states.filter(s => s.tier === 'context').length, 60)
  assert.equal(decide(req(), k).clause, 'not-revoked')
})

test('discovery retries when the merged view is left out, and fails when it is left out of every answer', async () => {
  const g = grant()
  const kas = [grantKa(g), revocationKa(g.id)]
  // The node leaves the view out of the state discovery answer only; its one-row probe still shows the node holds one.
  const stripView = n => async (sparql, o) => {
    if (o.view !== 'verifiable-memory' || !sparql.includes(V.stateOf) || n.left-- <= 0) return null
    return (await inner.queryJson(sparql, o)).filter(r => !String(r.g).includes('/context/'))
  }
  let inner = new FakeNode({ world: world(kas) })
  const once = await readKnowledge(wrap(inner, stripView({ left: 1 })), cfg(), { subject: SUBJECT })
  assert.equal(once.consistency.ok, true)
  inner = new FakeNode({ world: world(kas) })
  const always = await readKnowledge(wrap(inner, stripView({ left: Infinity })), cfg({ attempts: 3 }), { subject: SUBJECT })
  assert.equal(always.consistency.ok, false)
  assert.match(always.consistency.reason, /merged view of .* was left out of every answer/)
})

test('a node that materialises no merged view (it did not publish the data) reads consistently and honours the revocation', async () => {
  const g = grant()
  const node = new FakeNode({ world: world([grantKa(g), revocationKa(g.id)]), mergedView: false })
  const k = await readKnowledge(node, cfg({ attempts: 2 }), { subject: SUBJECT })
  assert.equal(k.consistency.ok, true, k.consistency.reason)
  assert.equal(decide(req(), k).clause, 'not-revoked')
  assert.ok(node.calls.some(c => c.kind === 'content' && c.prefix?.endsWith('/context/')), 'the merged-view probe ran')
})

test('a merged-view probe that never answers fails closed', async () => {
  const g = grant()
  const inner = new FakeNode({ world: world([grantKa(g), revocationKa(g.id)]), mergedView: false })
  const node = wrap(inner, async sparql => { if (/\/context\/"\)\)\s*\} LIMIT 1$/.test(sparql)) throw new Error('timeout') })
  const k = await readKnowledge(node, cfg({ attempts: 2 }), { subject: SUBJECT })
  assert.equal(k.consistency.ok, false)
  assert.match(k.consistency.reason, /merged-view check for .* answered on 0 of 2 attempts/)
})

test('a discovery query past the row limit fails closed', async () => {
  const g = grant()
  const flood = ka({ cg: GRANTS_CG, publisher: STRANGER, quads: Array.from({ length: 30 }, (_, i) => ({ subject: `urn:x:${i}`, predicate: V.stateOf, object: g.id })) })
  const k = await readKnowledge(new FakeNode({ world: world([grantKa(g), flood]) }), cfg({ max: 20 }), { subject: SUBJECT })
  assert.equal(k.consistency.ok, false)
  assert.match(k.consistency.reason, /discovery query returned more than 20 rows/)
})

test('a state visible in the grantor\'s own graph but missing from the grantor read makes the read inconsistent', async () => {
  const g = grant()
  const rev = revocationKa(g.id)
  const full = new FakeNode({ world: world([grantKa(g), rev]) })
  const partial = new FakeNode({ world: world([grantKa(g)]) })
  const node = { name: 'split', queryJson: (sparql, o) => (isPrefixRead(sparql) ? partial : full).queryJson(sparql, o) }
  const k = await readKnowledge(node, cfg(), { subject: SUBJECT })
  assert.equal(k.consistency.ok, false)
  assert.ok(k.consistency.reasons.some(r => /visible in .* but missing from the grantor read/.test(r)), k.consistency.reasons.join('\n'))
})

/* ------------------------------ pending anchors ------------------------------ */

const withoutMetaRow = (kaRows, predicate) => r => !(r.s === kaRows.ual && r.p === predicate)

for (const [what, predicate] of [['status', 'http://dkg.io/ontology/status'], ['publicTripleCount', 'http://dkg.io/ontology/publicTripleCount'], ['assertionGraph', 'http://dkg.io/ontology/assertionGraph']]) {
  test(`a revocation whose ${what} _meta row is missing on the first attempt is retried and counted`, async () => {
    const g = grant()
    const rev = revocationKa(g.id)
    const inner = new FakeNode({ world: world([grantKa(g), rev]) })
    let first = true
    const node = wrap(inner, async (sparql, o) => {
      if (!sparql.includes('/_meta>') || sparql.includes('?s IN') || o.contextGraphId !== GRANTS_CG || !first) return null
      first = false
      return (await inner.queryJson(sparql, o)).filter(withoutMetaRow(rev, predicate))
    })
    const k = await readKnowledge(node, cfg(), { subject: SUBJECT })
    assert.equal(k.consistency.ok, true)
    assert.equal(decide(req(), k).clause, 'not-revoked')
  })

  test(`a revocation whose ${what} _meta row is always missing ends inconsistent`, async () => {
    const g = grant()
    const rev = revocationKa(g.id)
    const inner = new FakeNode({ world: world([grantKa(g), rev]) })
    const node = wrap(inner, async (sparql, o) => (sparql.includes('/_meta>') && !sparql.includes('?s IN')
      ? (await inner.queryJson(sparql, o)).filter(withoutMetaRow(rev, predicate)) : null))
    const k = await readKnowledge(node, cfg({ attempts: 2 }), { subject: SUBJECT })
    assert.equal(k.consistency.ok, false)
    assert.equal(decide(req(), k).permit, false)
  })
}

test('a trusted derivation whose _meta status row is always missing ends inconsistent, so its spend is not lost', async () => {
  const g = grant({ maxSpendUsd: 2 })
  const d = derivationKa(derivation({ authorizedUnder: g.id, billedUsd: 1.5 }))
  const inner = new FakeNode({ world: world([grantKa(g)], [d]) })
  const node = wrap(inner, async (sparql, o) => (sparql.includes('/_meta>') && !sparql.includes('?s IN')
    ? (await inner.queryJson(sparql, o)).filter(withoutMetaRow(d, 'http://dkg.io/ontology/status')) : null))
  const k = await readKnowledge(node, cfg({ attempts: 2 }), { subject: SUBJECT })
  assert.equal(k.consistency.ok, false)
  assert.equal(decide(req(), k).clause, 'read-inconsistent')
})

test('a GrantState in the grantor\'s own prefix with an unreadable stateOf makes the read inconsistent', async () => {
  const g = grant()
  const s = 'urn:mandate:state:00000000000000e1'
  const bad = ka({ cg: GRANTS_CG, publisher: ANA, quads: [
    { subject: s, predicate: RDF_TYPE, object: V.GrantState }, { subject: s, predicate: V.stateOf, object: `"${g.id}"` },
    { subject: s, predicate: V.state, object: '"revoked"' }, { subject: s, predicate: V.stateAuthor, object: `did:dkg:agent:${ANA}` },
  ] })
  const k = await readKnowledge(new FakeNode({ world: world([grantKa(g), bad]) }), cfg({ attempts: 1 }), { subject: SUBJECT })
  assert.equal(k.consistency.ok, false)
  assert.match(k.consistency.reason, /unreadable stateOf/)
})

/* ------------------------------ freshness ------------------------------ */

const freshNode = reconcile => Object.assign(new FakeNode({ world: world([grantKa(grant())]) }), { reconcile })

for (const status of [0, 401, 404, 409, 429, 500, 503]) {
  test(`freshness: a reconcile answering ${status || 'a transport error'} refuses`, async () => {
    const node = freshNode(async () => { throw new DkgHttpError('boom', { status, body: { error: 'not subscribed locally' } }) })
    const k = await readKnowledge(node, cfg({ checkFreshness: true }), { subject: SUBJECT })
    assert.equal(k.consistency.ok, false)
    assert.match(k.consistency.reason, /freshness of .* could not be established/)
  })
}

for (const [name, reply] of [
  ['a null head', { status: 'error', headOrdinal: null, watermarkAfter: 1 }],
  ['a null head and watermark', { headOrdinal: null, watermarkAfter: null }],
  ['a missing head', { watermarkAfter: 1 }],
  ['a non-numeric head', { headOrdinal: 'twelve', watermarkAfter: 1 }],
  ['a fractional watermark', { headOrdinal: 2, watermarkAfter: 1.5 }],
  ['a watermark ahead of the head', { status: 'current', headOrdinal: 1, watermarkAfter: 5 }],
  ['a watermark-ahead status', { status: 'watermark-ahead', headOrdinal: 3, watermarkAfter: 3 }],
  ['an empty reply', null],
]) {
  test(`freshness: ${name} refuses`, async () => {
    const k = await readKnowledge(freshNode(async () => reply), cfg({ checkFreshness: true }), { subject: SUBJECT })
    assert.equal(k.consistency.ok, false)
    assert.match(k.consistency.reason, /freshness of .* unknown/)
  })
}

test('freshness: numeric strings are accepted as counters', async () => {
  const k = await readKnowledge(freshNode(async () => ({ status: 'current', headOrdinal: '1', watermarkAfter: '1' })), cfg({ checkFreshness: true }), { subject: SUBJECT })
  assert.equal(k.consistency.ok, true)
})

test('freshness: a node with no reconcile call refuses when the check was asked for', async () => {
  const k = await readKnowledge(new FakeNode({ world: world([grantKa(grant())]) }), cfg({ checkFreshness: true }), { subject: SUBJECT })
  assert.equal(k.consistency.ok, false)
  assert.match(k.consistency.reason, /no reconcile call/)
})

/* ------------------------------ paging and limits ------------------------------ */

test('R7: a producer with more rows than one query page is read in full, not refused', async () => {
  const g = grant({ maxSpendUsd: 1000 })
  const other = grant()
  const derivs = [
    ...Array.from({ length: 40 }, () => derivationKa(derivation({ authorizedUnder: other.id, billedUsd: 0.01 }))),
    ...Array.from({ length: 5 }, () => derivationKa(derivation({ authorizedUnder: g.id, billedUsd: 2 }))),
  ]
  const node = new FakeNode({ world: world([grantKa(g), grantKa(other)], derivs) })
  const k = await readKnowledge(node, cfg({ max: 50 }), { subject: SUBJECT })
  assert.equal(k.consistency.ok, true, k.consistency.reason)
  assert.equal(k.derivations.length, 45)
  assert.ok(node.calls.filter(c => c.kind === 'content' && c.contextGraphId === DERIVS_CG).length > 3, 'paged')
  assert.equal(decide(req({ estimatedUsd: 1 }), k).spend.priorUsd, 10)
})

test('R7: a graph omitted from one page is caught by the counts and recovered on a later attempt', async () => {
  const g = grant()
  const derivs = Array.from({ length: 20 }, () => derivationKa(derivation({ authorizedUnder: g.id, billedUsd: 0.1 })))
  const drop = ({ kind, call, graph }) => kind === 'content' && call < 8 && graph === derivs[3].graph
  const k = await readKnowledge(new FakeNode({ world: world([grantKa(g)], derivs), drop }), cfg({ max: 30 }), { subject: SUBJECT })
  assert.equal(k.consistency.ok, true, k.consistency.reason)
  assert.equal(k.derivations.length, 20)
})

/* ------------------------------ local memory ------------------------------ */

test('a remembered revocation missing from a later read is still honoured', async () => {
  const g = grant()
  const store = memoryStateStore()
  // Only the revocation was remembered (no anchor list), so nothing but revocation memory protects this read.
  store.save(GRANTS_CG, { knownUals: {}, revocations: { [g.id]: { id: 'urn:mandate:state:00000000000000f9', ual: `did:dkg:base:84532/${ANA}/999`, publisher: ANA, stateOf: g.id } } })
  const k = await readKnowledge(new FakeNode({ world: world([grantKa(g)]) }), cfg({ stateStore: store }), { subject: SUBJECT })
  assert.ok(k.warnings.some(w => /seen before but is missing from this read/.test(w)))
  assert.equal(decide(req(), k).clause, 'not-revoked')
})

test('a remembered revocation is not cancelled by an "active" state from the same publisher', async () => {
  const g = grant()
  const store = memoryStateStore()
  store.save(GRANTS_CG, { knownUals: {}, revocations: { [g.id]: { id: 'urn:mandate:state:00000000000000f9', ual: null, publisher: ANA, stateOf: g.id } } })
  const s = 'urn:mandate:state:00000000000000fa'
  const active = ka({ cg: GRANTS_CG, publisher: ANA, quads: [
    { subject: s, predicate: RDF_TYPE, object: V.GrantState }, { subject: s, predicate: V.stateOf, object: g.id },
    { subject: s, predicate: V.state, object: '"active"' }, { subject: s, predicate: V.stateAuthor, object: `did:dkg:agent:${ANA}` },
  ] })
  const k = await readKnowledge(new FakeNode({ world: world([grantKa(g), active]) }), cfg({ stateStore: store }), { subject: SUBJECT })
  assert.equal(decide(req(), k).clause, 'not-revoked')
})

/* ------------------------------ graph ids ------------------------------ */

test('R19: a context graph id held under another case is an inconsistent read, not an empty one', async () => {
  const lower = `${DERIVS_CG.split('/')[0].toLowerCase()}/mandate-derivations`
  const node = new FakeNode({ world: { ...world([grantKa(grant())]), [lower]: { kas: [] } } })
  node.subscriptions = async () => ({ subscriptions: [{ contextGraphId: GRANTS_CG, subscribed: true }, { contextGraphId: DERIVS_CG, subscribed: true }] })
  const k = await readKnowledge(node, cfg({ derivationsCgs: [lower] }), { subject: SUBJECT })
  assert.equal(k.consistency.ok, false)
  assert.match(k.consistency.reason, /held by the node as 0x8EaA.*case-sensitive/)
  const ok = await readKnowledge(node, cfg(), { subject: SUBJECT })
  assert.equal(ok.consistency.ok, true)
})

test('R19: an empty graph the node is not subscribed to is inconsistent; a node that cannot list subscriptions warns', async () => {
  const node = new FakeNode({ world: world([grantKa(grant())]) })
  node.subscriptions = async () => ({ subscriptions: [{ contextGraphId: GRANTS_CG, subscribed: true }] })
  const k = await readKnowledge(node, cfg(), { subject: SUBJECT })
  assert.equal(k.consistency.ok, false)
  assert.match(k.consistency.reason, /not subscribed to context graph/)
  node.subscriptions = async () => { throw new DkgHttpError('forbidden', { status: 403 }) }
  const w = await readKnowledge(node, cfg(), { subject: SUBJECT })
  assert.equal(w.consistency.ok, true)
  assert.ok(w.warnings.some(x => /could not confirm the node holds/.test(x)))
})

/* ------------------------------ several graphs ------------------------------ */

const OTHER_CG = `${STRANGER}/stranger-grants`

test('grantsCgs: a grant from a second configured grants graph is read, and only unconfigured owners are unresolved', async () => {
  const theirs = grant({ owner: STRANGER, local: 'sam' })
  const nobody = grant({ owner: '0x7777777777777777777777777777777777777777', local: 'x' })
  const mine = grant()
  const shaA = 'a'.repeat(64)
  const shaB = 'b'.repeat(64)
  const w = {
    [GRANTS_CG]: { kas: [grantKa(mine)] },
    [OTHER_CG]: { kas: [ka({ cg: OTHER_CG, publisher: STRANGER, quads: (await import('../src/rdf.mjs')).grantToQuads(theirs) })] },
    [DERIVS_CG]: { kas: [
      derivationKa(derivation({ outputSha256: shaA, authorizedUnder: theirs.id, servedCapability: 'talking-head' })),
      derivationKa(derivation({ outputSha256: shaB, authorizedUnder: nobody.id, servedCapability: 'talking-head' })),
      derivationKa(derivation({ outputSha256: shaB, authorizedUnder: mine.id, servedCapability: 'talking-head' })),
    ] },
  }
  const a = await readKnowledge(new FakeNode({ world: w }), cfg({ grantsCg: GRANTS_CG, grantsCgs: [OTHER_CG, GRANTS_CG] }), { sha256: shaA })
  assert.equal(a.consistency.ok, true, a.consistency.reason)
  assert.deepEqual(a.grantsCgs, [GRANTS_CG, OTHER_CG])
  assert.equal(a.grants.length, 1)
  assert.equal(verifyKnowledge(a, shaA, { now: '2026-09-13T12:00:00Z' }).verdict, CLEAR)
  const b = await readKnowledge(new FakeNode({ world: w }), cfg({ grantsCg: GRANTS_CG, grantsCgs: [OTHER_CG] }), { sha256: shaB })
  assert.deepEqual(b.unresolvedGrants, [nobody.id])
  // Ana's graph is configured and read: her grant is resolved even had it been missing.
  assert.ok(!b.unresolvedGrants.includes(mine.id))
  const single = await readKnowledge(new FakeNode({ world: w }), cfg(), { sha256: shaA })
  assert.deepEqual(single.unresolvedGrants, [theirs.id, nobody.id].sort())
  const v = verifyKnowledge(single, shaA, { now: '2026-09-13T12:00:00Z' })
  assert.equal(v.verdict, 'UNKNOWN')
  assert.match(v.reason, /graph this verifier does not read/)
})

test('grantsCgs: a configured grantor graph that lacks the grant is not unresolved', async () => {
  const missing = grant()
  const sha = 'd'.repeat(64)
  const k = await readKnowledge(new FakeNode({ world: world([], [derivationKa(derivation({ outputSha256: sha, authorizedUnder: missing.id }))]) }), cfg(), { sha256: sha })
  assert.equal(k.consistency.ok, true)
  assert.deepEqual(k.unresolvedGrants, [])
})

test('duplicate producers and derivations graphs in the configuration do not double spend', async () => {
  const g = grant({ maxSpendUsd: 2 })
  const node = new FakeNode({ world: world([grantKa(g)], [derivationKa(derivation({ authorizedUnder: g.id, billedUsd: 0.8 }))]) })
  const k = await readKnowledge(node, cfg({ derivationsCgs: [DERIVS_CG, DERIVS_CG], trustedProducers: [PRODUCER, PRODUCER.replace('0x8eaa', '0x8EAA')] }), { subject: SUBJECT })
  assert.deepEqual(k.trustedProducers, [PRODUCER])
  assert.equal(k.reads.filter(r => r.role === 'derivations').length, 1)
  assert.equal(k.derivations.length, 1)
  assert.equal(decide(req({ estimatedUsd: 1 }), k).spend.priorUsd, 0.8)
})

test('duplicate reads of one derivation are counted once', async () => {
  const g = grant({ maxSpendUsd: 2 })
  const node = new FakeNode({ world: world([grantKa(g)], [derivationKa(derivation({ authorizedUnder: g.id, billedUsd: 0.8 }))]) })
  const k = await readKnowledge(node, cfg({ trustedProducers: [PRODUCER, PRODUCER] }), { subject: SUBJECT })
  assert.equal(k.derivations.length, 1)
})

test('R6: derivation discovery for a file that does not answer makes the read inconsistent', async () => {
  const g = grant()
  const sha = 'a'.repeat(64)
  const inner = new FakeNode({ world: world([grantKa(g)], [derivationKa(derivation({ outputSha256: sha, authorizedUnder: g.id }))]) })
  const node = wrap(inner, async sparql => { if (sparql.includes('?m <')) throw new Error('timeout') })
  const k = await readKnowledge(node, cfg(), { sha256: sha })
  assert.equal(k.consistency.ok, false)
  assert.match(k.consistency.reason, /derivation discovery .* did not answer/)
})

test('a row with an unreadable graph cell in a prefix read makes the read inconsistent', async () => {
  const inner = new FakeNode({ world: world([grantKa(grant())]) })
  const node = wrap(inner, async (sparql, o) => {
    if (!sparql.includes('GRAPH ?g { ?s ?p ?o }') || sparql.includes('COUNT') || o.contextGraphId !== GRANTS_CG) return null
    return [...await inner.queryJson(sparql, o), { g: '"not a graph"', s: 'urn:x', p: V.state, o: '"revoked"' }]
  })
  const k = await readKnowledge(node, cfg({ attempts: 1 }), { subject: SUBJECT })
  assert.equal(k.consistency.ok, false)
  assert.match(k.consistency.reason, /unreadable graph/)
})

test('a local state file that cannot be parsed throws StateReadError rather than starting from empty memory', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'mandate-state-'))
  writeFileSync(join(dir, 'g.json'), '{ not json')
  assert.throws(() => fileStateStore(dir).load('g'), e => e instanceof StateReadError && /cannot read local state/.test(e.message))
  assert.deepEqual(fileStateStore(dir).load('absent').knownUals, {})
})

/* ------------------------------ second-round residuals ------------------------------ */

const DT = '^^<http://www.w3.org/2001/XMLSchema#dateTime>'
const ownActive = (grantId, id = 'urn:mandate:state:00000000000000a1') => ka({ cg: GRANTS_CG, publisher: ANA, quads: [
  { subject: id, predicate: RDF_TYPE, object: V.GrantState }, { subject: id, predicate: V.stateOf, object: grantId },
  { subject: id, predicate: V.state, object: '"active"' }, { subject: id, predicate: V.stateAuthor, object: `did:dkg:agent:${ANA}` },
  { subject: id, predicate: V.stateAt, object: `"2026-09-13T08:00:00Z"${DT}` },
] })

test('D6: a probe and merged view both left out on the first attempt only do not settle "no merged view"', async () => {
  const g = grant()
  const s = 'urn:mandate:state:0000000000000078'
  const view = { graph: `${cgIri(GRANTS_CG)}/context/9`, rows: [{ s, p: V.stateOf, o: g.id }, { s, p: V.state, o: '"revoked"' }] }
  const inner = new FakeNode({ world: world([grantKa(g), ownActive(g.id)], [], { grantGraphs: [view] }) })
  let probes = 0
  let states = 0
  const node = wrap(inner, async (sparql, o) => {
    const isProbe = /\/context\/"\)\)\s*\} LIMIT 1$/.test(sparql)
    const isStates = sparql.includes(V.stateOf) && o.view === 'verifiable-memory'
    if (!(isProbe && ++probes === 1) && !(isStates && ++states === 1)) return null
    return (await inner.queryJson(sparql, o)).filter(r => !String(r.g).includes('/context/'))
  })
  const k = await readKnowledge(node, cfg(), { subject: SUBJECT })
  assert.equal(k.consistency.ok, true, k.consistency.reason)
  assert.equal(k.states.filter(x => x.tier === 'context').length, 1)
  assert.equal(decide(req(), k).clause, 'not-revoked')
})

test('D6: on a node with no merged view, "no view" is believed only after the probe answers empty on every attempt', async () => {
  const g = grant()
  const node = new FakeNode({ world: world([grantKa(g), ownActive(g.id)]), mergedView: false })
  const k = await readKnowledge(node, cfg({ attempts: 3 }), { subject: SUBJECT })
  assert.equal(k.consistency.ok, true, k.consistency.reason)
  assert.equal(node.calls.filter(c => c.kind === 'content' && c.prefix?.endsWith('/context/')).length, 3)
  // A probe that fails on one of those attempts leaves it unsettled.
  let n = 0
  const inner = new FakeNode({ world: world([grantKa(g), ownActive(g.id)]), mergedView: false })
  const flaky = wrap(inner, async sparql => { if (/\/context\/"\)\)\s*\} LIMIT 1$/.test(sparql) && ++n === 2) throw new Error('timeout') })
  const f = await readKnowledge(flaky, cfg({ attempts: 3 }), { subject: SUBJECT })
  assert.equal(f.consistency.ok, false)
  assert.match(f.consistency.reason, /merged-view check for .* answered on 2 of 3 attempts/)
})

test('a merged-view-only revocation whose "active" row comes first is still a revocation', async () => {
  const g = grant()
  const s = 'urn:mandate:state:0000000000000077'
  for (const values of [['"active"', '"revoked"'], ['"revoked"', '"active"']]) {
    const view = { graph: `${cgIri(GRANTS_CG)}/context/9`, rows: [{ s, p: V.stateOf, o: g.id }, ...values.map(o => ({ s, p: V.state, o }))] }
    const k = await readKnowledge(new FakeNode({ world: world([grantKa(g)], [], { grantGraphs: [view] }) }), cfg(), { subject: SUBJECT })
    assert.equal(k.consistency.ok, true)
    assert.equal(decide(req(), k).clause, 'not-revoked', values.join())
  }
})

test('a shared-memory state whose "active" row comes first still warns of the unanchored revocation', async () => {
  const g = grant()
  const s = 'urn:mandate:state:00000000000000ab'
  const swm = { graph: `${cgIri(GRANTS_CG)}/_shared_memory/${ANA}/0`, rows: [{ s, p: V.stateOf, o: g.id }, { s, p: V.state, o: '"active"' }, { s, p: V.state, o: '"revoked"' }] }
  const k = await readKnowledge(new FakeNode({ world: world([grantKa(g)], [], { grantGraphs: [swm] }) }), cfg(), { subject: SUBJECT })
  assert.ok(k.warnings.some(w => /unanchored revocation .* shared memory/.test(w)))
})

for (const [name, subscriptions, pattern] of [
  ['a transport error', async () => { throw new DkgHttpError('unreachable', { status: 0 }) }, /could not confirm the node holds .*unreachable/],
  ['a 500', async () => { throw new DkgHttpError('boom', { status: 500 }) }, /could not confirm the node holds .*500/],
  ['a 404', async () => { throw new DkgHttpError('not found', { status: 404 }) }, /could not confirm the node holds .*404/],
  ['an unexpected answer', async () => ({ graphs: [] }), /unexpected subscriptions answer/],
]) {
  test(`R19: when listing subscriptions gives ${name}, an empty graph under a mis-cased id is not believed`, async () => {
    const g = grant({ maxSpendUsd: 2 })
    const node = new FakeNode({ world: world([grantKa(g)], [derivationKa(derivation({ authorizedUnder: g.id, billedUsd: 1.9 }))]) })
    node.subscriptions = subscriptions
    const k = await readKnowledge(node, cfg({ derivationsCgs: [DERIVS_CG.toLowerCase()], trustedProducers: [PRODUCER] }), { subject: SUBJECT })
    assert.equal(k.consistency.ok, false)
    assert.match(k.consistency.reason, pattern)
    assert.equal(decide(req(), k).clause, 'read-inconsistent')
  })
}

test('R19: a node with no subscriptions call warns that an empty graph was not confirmed', async () => {
  const k = await readKnowledge(new FakeNode({ world: world([grantKa(grant())]) }), cfg(), { subject: SUBJECT })
  assert.equal(k.consistency.ok, true)
  assert.ok(k.warnings.some(w => /could not confirm the node holds .*no subscriptions call/.test(w)))
})

test('R19: a graph the freshness check found current is not asked about again', async () => {
  const node = new FakeNode({ world: world([grantKa(grant())]) })
  node.reconcile = async () => ({ status: 'current', headOrdinal: 0, watermarkAfter: 0 })
  node.subscriptions = async () => { throw new DkgHttpError('boom', { status: 500 }) }
  const k = await readKnowledge(node, cfg({ checkFreshness: true }), { subject: SUBJECT })
  assert.equal(k.consistency.ok, true, k.consistency.reason)
})

test('D7: a grant read from a configured graph named under another address is not unresolved, and its revocation is judged', async () => {
  const sam = grant({ owner: STRANGER, local: 'sam' })
  const sha = 'e'.repeat(64)
  const { grantToQuads } = await import('../src/rdf.mjs')
  const node = new FakeNode({ world: world(
    [ka({ cg: GRANTS_CG, publisher: STRANGER, quads: grantToQuads(sam) }), revocationKa(sam.id, { publisher: STRANGER })],
    [derivationKa(derivation({ outputSha256: sha, authorizedUnder: sam.id, servedCapability: 'talking-head' }))],
  ) })
  const k = await readKnowledge(node, cfg(), { sha256: sha })
  assert.equal(k.consistency.ok, true, k.consistency.reason)
  assert.equal(k.grants.length, 1)
  assert.deepEqual(k.states.map(s => s.state), ['revoked'])
  assert.deepEqual(k.unresolvedGrants, [])
  const v = verifyKnowledge(k, sha, { now: '2026-09-13T12:00:00Z' })
  assert.equal(v.verdict, 'TAINTED')
  assert.equal(v.subStatus, 'REVOKED')
})

test('the graph count guard end to end: a revocation left out of _meta and content but still counted is inconsistent', async () => {
  const g = grant()
  const gk = grantKa(g)
  const rk = revocationKa(g.id)
  const inner = new FakeNode({ world: world([gk, rk]), mergedView: false })
  const node = wrap(inner, async (sparql, o) => (/COUNT/.test(sparql) ? null
    : (await inner.queryJson(sparql, o)).filter(r => r.s !== rk.ual && r.g !== rk.graph)))
  const k = await readKnowledge(node, cfg({ attempts: 2 }), { subject: SUBJECT })
  assert.equal(k.consistency.ok, false)
  assert.match(k.consistency.reason, /node shows 2 graphs .* but 1 are anchored/)
  assert.equal(decide(req(), k).clause, 'read-inconsistent')
})

test('a node that answers a second spelling of a graph id with the same assets does not double spend', async () => {
  const g = grant({ maxSpendUsd: 2 })
  const inner = new FakeNode({ world: world([grantKa(g)], [derivationKa(derivation({ authorizedUnder: g.id, billedUsd: 0.8 }))]) })
  const alias = DERIVS_CG.toLowerCase()
  // Rewrites the alias to the real id in each query and back in each answer, as a node resolving ids case-insensitively would.
  const swapText = (v, from, to) => (typeof v === 'string' ? v.split(from).join(to) : v)
  const node = {
    name: 'alias', calls: inner.calls,
    subscriptions: async () => [{ contextGraphId: DERIVS_CG }, { contextGraphId: alias }, { contextGraphId: GRANTS_CG }],
    queryJson: async (sparql, o) => {
      if (o.contextGraphId !== alias) return inner.queryJson(sparql, o)
      const rows = await inner.queryJson(swapText(sparql, alias, DERIVS_CG), { ...o, contextGraphId: DERIVS_CG })
      return rows.map(r => Object.fromEntries(Object.entries(r).map(([key, v]) => [key, swapText(v, DERIVS_CG, alias)])))
    },
  }
  const k = await readKnowledge(node, cfg({ derivationsCgs: [DERIVS_CG, alias], trustedProducers: [PRODUCER] }), { subject: SUBJECT })
  assert.equal(k.consistency.ok, true, k.consistency.reason)
  assert.equal(k.reads.filter(r => r.role === 'derivations').length, 2)
  assert.equal(k.derivations.length, 1)
  assert.equal(decide(req({ estimatedUsd: 1 }), k).spend.priorUsd, 0.8)
})

test('a misplaced state that only discovery sees is a trusted forgery under a trusted producer, untrusted under a stranger', async () => {
  const g = grant()
  const misplaced = publisher => ka({ cg: DERIVS_CG, publisher, quads: [
    { subject: 'urn:mandate:state:00000000000000cd', predicate: RDF_TYPE, object: V.GrantState },
    { subject: 'urn:mandate:state:00000000000000cd', predicate: V.stateOf, object: g.id },
    { subject: 'urn:mandate:state:00000000000000cd', predicate: V.state, object: '"active"' },
  ] })
  for (const [publisher, trusted] of [[PRODUCER, true], [STRANGER, false]]) {
    const full = new FakeNode({ world: world([grantKa(g)], [misplaced(publisher)]) })
    const partial = new FakeNode({ world: world([grantKa(g)]) })
    const node = { name: 'split', queryJson: (sparql, o) => (isPrefixRead(sparql) ? partial : full).queryJson(sparql, o) }
    const k = await readKnowledge(node, cfg(), { subject: SUBJECT })
    const f = k.forgeries.find(x => x.id === 'urn:mandate:state:00000000000000cd')
    assert.equal(f?.kind, 'misplaced-state')
    assert.equal(f.trusted, trusted)
  }
})

test('contract 3 end to end: the grantor\'s own revocation also typed LikenessGrant refuses, with or without a merged view', async () => {
  const g = grant()
  const id = `urn:mandate:grant:${ANA}:ana:00000000000000c9`
  const rev = ka({ cg: GRANTS_CG, publisher: ANA, quads: [
    { subject: id, predicate: RDF_TYPE, object: V.GrantState }, { subject: id, predicate: RDF_TYPE, object: V.LikenessGrant },
    { subject: id, predicate: V.stateOf, object: g.id }, { subject: id, predicate: V.state, object: '"revoked"' },
    { subject: id, predicate: V.stateAuthor, object: `did:dkg:agent:${ANA}` }, { subject: id, predicate: V.stateAt, object: `"2026-09-13T09:00:00Z"${DT}` },
  ] })
  for (const mergedView of [true, false]) {
    const k = await readKnowledge(new FakeNode({ world: world([grantKa(g), rev]), mergedView }), cfg({ attempts: 2 }), { subject: SUBJECT })
    assert.equal(k.consistency.ok, true, k.consistency.reason)
    assert.equal(k.states.length, 1)
    assert.equal(decide(req(), k).clause, 'not-revoked')
  }
})

test('D6 one view per graph: a second view graph left out of the first attempt only is caught', async () => {
  // G1's own revocation gives this node a merged view (context/1), so a view is expected;
  // G2 is revoked only in a second view graph, context/9, which the first answer leaves out.
  const g1 = grant()
  const g2 = grant()
  const s = 'urn:mandate:state:00000000000009a9'
  const view = { graph: `${cgIri(GRANTS_CG)}/context/9`, rows: [{ s, p: V.stateOf, o: g2.id }, { s, p: V.state, o: '"revoked"' }] }
  const kas = [grantKa(g1), grantKa(g2), revocationKa(g1.id)]
  const clean = await readKnowledge(new FakeNode({ world: world(kas, [], { grantGraphs: [view] }) }), cfg(), { subject: SUBJECT })
  assert.equal(clean.consistency.ok, true, clean.consistency.reason)
  const node = new FakeNode({
    world: world(kas, [], { grantGraphs: [view] }),
    drop: ({ graph }) => graph?.endsWith('/context/9') && node.calls.filter(c => c.kind === 'states').length <= 3,
  })
  const k = await readKnowledge(node, cfg(), { subject: SUBJECT })
  assert.equal(k.consistency.ok, false)
  assert.match(k.consistency.reason, /shows 2 merged view graphs on different attempts/)
  const d = decide(req(), k)
  assert.equal(d.permit, false)
  // Seen on the same attempts, two view graphs are not a split.
  assert.equal(clean.states.filter(x => x.tier === 'context').length, 1)
  assert.equal(decide(req(), clean).clause, 'not-revoked')
})

test('D6: an expected view that shows on the first attempt still gets a second attempt', async () => {
  const g = grant()
  const node = new FakeNode({ world: world([grantKa(g), revocationKa(g.id)]) })
  const k = await readKnowledge(node, cfg(), { subject: SUBJECT })
  assert.equal(k.consistency.ok, true, k.consistency.reason)
  const perAttempt = node.calls.filter(c => c.kind === 'states').length
  const bare = new FakeNode({ world: world([grantKa(grant())]) })
  await readKnowledge(bare, cfg(), { subject: SUBJECT })
  // No state is expected in the bare world, so discovery stops after one attempt; with a view expected it takes two.
  assert.equal(perAttempt, 2 * bare.calls.filter(c => c.kind === 'states').length)
})

test('R19: a subscriptions entry whose subscribed flag is not exactly true is not held', async () => {
  const g = grant({ maxSpendUsd: 5 })
  for (const subscribed of ['false', 'true', 1, null]) {
    const node = new FakeNode({ world: world([grantKa(g)], [derivationKa(derivation({ authorizedUnder: g.id, billedUsd: 4.5 }))]) })
    const entry = { contextGraphId: DERIVS_CG.toLowerCase(), subscribed }
    node.subscriptions = async () => [{ contextGraphId: GRANTS_CG, subscribed: true }, entry]
    const k = await readKnowledge(node, cfg({ derivationsCgs: [DERIVS_CG.toLowerCase()], trustedProducers: [PRODUCER] }), { subject: SUBJECT })
    assert.equal(k.consistency.ok, false, String(subscribed))
    assert.match(k.consistency.reason, /not subscribed to context graph/)
  }
  const missing = new FakeNode({ world: world([grantKa(g)], [derivationKa(derivation({ authorizedUnder: g.id, billedUsd: 4.5 }))]) })
  missing.subscriptions = async () => [{ contextGraphId: DERIVS_CG.toLowerCase() }]
  const km = await readKnowledge(missing, cfg({ derivationsCgs: [DERIVS_CG.toLowerCase()], trustedProducers: [PRODUCER] }), { subject: SUBJECT })
  assert.equal(km.consistency.ok, false)
  assert.match(km.consistency.reason, /not subscribed to context graph/)
  const held = new FakeNode({ world: world([grantKa(g)], [derivationKa(derivation({ authorizedUnder: g.id, billedUsd: 4.5 }))]) })
  held.subscriptions = async () => [{ contextGraphId: DERIVS_CG.toLowerCase(), subscribed: true }]
  const kh = await readKnowledge(held, cfg({ derivationsCgs: [DERIVS_CG.toLowerCase()], trustedProducers: [PRODUCER] }), { subject: SUBJECT })
  assert.equal(kh.consistency.ok, true, kh.consistency.reason)
})

test('a grant permitting only editorial, read from the node, refuses advertising at use-class-permitted', async () => {
  const g = grant({ permitsUseClass: ['editorial'], forbidsUseClass: [] })
  const k = await readKnowledge(new FakeNode({ world: world([grantKa(g)]) }), cfg(), { subject: SUBJECT })
  assert.equal(k.consistency.ok, true)
  assert.deepEqual(k.grants[0].permitsUseClass, ['editorial'])
  const d = decide(req({ useClass: 'advertising' }), k)
  assert.equal(d.permit, false)
  assert.equal(d.clause, 'use-class-permitted')
  assert.equal(decide(req({ useClass: 'editorial' }), k).permit, true)
})

test('with the freshness check off, every read says so in its warnings', async () => {
  for (const over of [{}, { checkFreshness: false }]) {
    const k = await readKnowledge(new FakeNode({ world: world([grantKa(grant())]) }), cfg(over), { subject: SUBJECT })
    assert.equal(k.consistency.ok, true)
    assert.ok(k.warnings.some(w => /^freshness not checked/.test(w)), JSON.stringify(over))
    assert.ok(decide(req(), k).warnings.some(w => /^freshness not checked/.test(w)), 'the decision carries it')
  }
  const node = new FakeNode({ world: world([grantKa(grant())]) })
  node.reconcile = async () => ({ status: 'current', headOrdinal: 1, watermarkAfter: 1 })
  const checked = await readKnowledge(node, cfg({ checkFreshness: true }), { subject: SUBJECT })
  assert.ok(!checked.warnings.some(w => /^freshness not checked/.test(w)), 'no such warning when the check ran')
})

test('a revocation a consistent read accepts is remembered by that read, and honoured when a later read misses it', async () => {
  const g = grant()
  const store = memoryStateStore()
  const first = await readKnowledge(new FakeNode({ world: world([grantKa(g), revocationKa(g.id)]) }), cfg({ stateStore: store }), { subject: SUBJECT })
  assert.equal(first.consistency.ok, true)
  const saved = store.load(GRANTS_CG)
  assert.equal(saved.revocations[g.id]?.stateOf, g.id, 'the read saved the revocation it accepted')
  // Forget the anchors, so only the remembered revocation protects the next read.
  store.save(GRANTS_CG, { ...saved, knownUals: {} })
  const later = await readKnowledge(new FakeNode({ world: world([grantKa(g)]) }), cfg({ stateStore: store }), { subject: SUBJECT })
  assert.ok(later.warnings.some(w => /seen before but is missing from this read/.test(w)))
  assert.equal(decide(req(), later).clause, 'not-revoked')
})
