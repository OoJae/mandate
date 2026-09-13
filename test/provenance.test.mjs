import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { anchorsFromMeta, checkConsistency, checkReturnedGraphs, reduceSlice, grantIriAddress } from '../src/provenance.mjs'
import { vmPublisherPrefix } from '../src/queries.mjs'
import { asInteger } from '../src/rdf-term.mjs'
import * as V from '../src/vocab.mjs'
import { GRANTS_CG, DERIVS_CG, ANA, PRODUCER, STRANGER, did, ka, grant, grantKa, revocationKa, derivation, derivationKa, read } from './fixtures/build.mjs'

const live = f => JSON.parse(readFileSync(new URL(`./fixtures/live/${f}.json`, import.meta.url), 'utf8'))

/* ----------------------------- live fixtures ----------------------------- */

for (const node of ['grantor', 'producer']) {
  test(`live ${node} node: every grant-graph anchor parses and the read is consistent`, () => {
    const meta = live(`${node}-grants-meta`)
    const { anchors, problems } = anchorsFromMeta(meta.bindings, meta.contextGraphId)
    assert.equal(problems.length, 0)
    assert.equal(anchors.size, 9)
    for (const a of anchors.values()) assert.equal(a.publisher, ANA)
    const c = checkConsistency({ prefix: meta.prefix, anchors, contentRows: live(`${node}-grants-content`).bindings,
      visibleGraphCount: asInteger(live(`${node}-grants-count`).bindings[0].n) })
    assert.deepEqual(c, { ok: true, reason: null })
  })
}

test('a synced node has no prov:wasAttributedTo, and its anchors are still accepted from the graph path', () => {
  const meta = live('producer-grants-meta')
  assert.ok(!meta.bindings.some(b => b.p.endsWith('wasAttributedTo')), 'fixture precondition')
  assert.equal(anchorsFromMeta(meta.bindings, meta.contextGraphId).anchors.size, 9)
})

test('live flake patterns were recorded: the producer returned empty reads for valid queries', () => {
  assert.ok(live('producer-grants-count').observedCounts.includes(0))
})

/* -------------------------------- anchors -------------------------------- */

test('an anchor must be confirmed, self-linked, and derive its own graph', () => {
  const g = grantKa(grant())
  assert.equal(anchorsFromMeta(g.metaRows, GRANTS_CG).anchors.size, 1)
  assert.equal(anchorsFromMeta(grantKa(grant(), { status: 'tentative' }).metaRows, GRANTS_CG).problems.length, 1)
  const wrongGraph = grantKa(grant(), { assertionGraph: `did:dkg:context-graph:${GRANTS_CG}/_verifiable_memory/${STRANGER}/1` })
  assert.match(anchorsFromMeta(wrongGraph.metaRows, GRANTS_CG).problems[0].reason, /does not match/)
})

test('wasAttributedTo, where present, must name the path address', () => {
  assert.equal(anchorsFromMeta(grantKa(grant(), { attributed: true }).metaRows, GRANTS_CG).anchors.size, 1)
  assert.equal(anchorsFromMeta(grantKa(grant(), { attributed: STRANGER }).metaRows, GRANTS_CG).problems.length, 1)
})

/* ------------------------------ consistency ------------------------------ */

test('a dropped graph, a short graph, or a vanished anchor makes the read inconsistent', () => {
  const g1 = grantKa(grant()); const r1 = revocationKa(grant().id)
  const r = read(g1, r1)
  const { anchors } = anchorsFromMeta(r.metaRows, GRANTS_CG)
  const prefix = vmPublisherPrefix(GRANTS_CG, ANA)
  assert.equal(checkConsistency({ prefix, anchors, contentRows: r.contentRows, visibleGraphCount: 2 }).ok, true)
  // The revocation's graph silently omitted — exactly the live flake.
  assert.equal(checkConsistency({ prefix, anchors, contentRows: g1.contentRows, visibleGraphCount: 2 }).ok, false)
  assert.equal(checkConsistency({ prefix, anchors, contentRows: r.contentRows, visibleGraphCount: 1 }).ok, false)
  assert.equal(checkConsistency({ prefix, anchors, contentRows: r.contentRows.slice(1), visibleGraphCount: 2 }).ok, false)
  // An empty _meta read: content with no anchors.
  assert.equal(checkConsistency({ prefix, anchors: new Map(), contentRows: r.contentRows, visibleGraphCount: 2 }).ok, false)
  // An anchor seen before is gone now.
  assert.match(checkConsistency({ prefix, anchors, contentRows: r.contentRows, visibleGraphCount: 2, knownUals: ['did:dkg:base:84532/x/1'] }).reason, /missing/)
})

test('marker-filtered reads require each returned graph to be anchored and complete', () => {
  const d = derivationKa(derivation({ authorizedUnder: grant().id }))
  const { anchors } = anchorsFromMeta(d.metaRows, DERIVS_CG)
  assert.equal(checkReturnedGraphs({ anchors, contentRows: d.contentRows }).ok, true)
  assert.equal(checkReturnedGraphs({ anchors, contentRows: d.contentRows.slice(2) }).ok, false)
  assert.equal(checkReturnedGraphs({ anchors: new Map(), contentRows: d.contentRows }).ok, false)
})

/* -------------------------------- objects -------------------------------- */

const reduceGrants = r => reduceSlice({ role: 'grants', anchors: anchorsFromMeta(r.metaRows, GRANTS_CG).anchors, contentRows: r.contentRows })

test('a genuine grant from the subject\'s own address is accepted with its provenance', () => {
  const g = grant()
  const k = grantKa(g)
  const out = reduceGrants(read(k))
  assert.equal(out.grants.length, 1)
  assert.equal(out.grants[0].publisher, ANA)
  assert.equal(out.grants[0].ual, k.ual)
  assert.equal(out.forgeries.length, 0)
})

test('ATTACK: a grant for Ana published by anyone else is a forgery, whatever it claims', () => {
  // The producer publishes a grant naming Ana's DID as grantor for Ana's subject.
  const forged = grant()
  const out = reduceGrants(read(grantKa(forged, { publisher: PRODUCER })))
  assert.equal(out.grants.length, 0)
  assert.equal(out.forgeries[0].kind, 'grant-not-by-subject')
  assert.equal(out.forgeries[0].publisher, PRODUCER)
})

test('ATTACK: a state naming Ana as author, published by the producer, is a forgery', () => {
  const g = grant()
  const out = reduceGrants(read(grantKa(g), revocationKa(g.id, { publisher: PRODUCER, author: ANA })))
  assert.equal(out.states.length, 0)
  assert.equal(out.forgeries[0].kind, 'state-not-by-grantor')
})

test('ATTACK: grants and states in a derivations graph are never accepted', () => {
  const g = grant()
  const k = ka({ cg: DERIVS_CG, publisher: ANA, quads: grantKa(g).contentRows.map(r => ({ subject: r.s, predicate: r.p, object: r.o })) })
  const out = reduceSlice({ role: 'derivations', anchors: anchorsFromMeta(k.metaRows, DERIVS_CG).anchors, contentRows: k.contentRows })
  assert.equal(out.grants.length, 0)
  assert.equal(out.forgeries[0].kind, 'misplaced-grant')
})

test('ATTACK: an extra triple cannot widen a grant, because objects never merge across KAs', () => {
  const g = grant()
  const widening = ka({ cg: GRANTS_CG, publisher: STRANGER, quads: [{ subject: g.id, predicate: V.permitsCapability, object: '"face-swap-video"' }] })
  const out = reduceGrants(read(grantKa(g), widening))
  assert.equal(out.grants.length, 1)
  assert.deepEqual(out.grants[0].permitsCapability, ['talking-head', 'sync-lipsync-v3'])
})

test('a grant with a duplicated single-valued predicate is malformed, not merged', () => {
  const g = grant()
  const k = grantKa(g, { extraContent: [{ subject: g.id, predicate: V.maxSpendUsd, object: '"1000"^^<http://www.w3.org/2001/XMLSchema#decimal>' }] })
  const out = reduceGrants(read(k))
  assert.equal(out.grants.length, 0)
  assert.equal(out.forgeries[0].kind, 'malformed')
})

test('a stateAuthor literal that disagrees with the publisher is a forgery', () => {
  const g = grant()
  const out = reduceGrants(read(grantKa(g), revocationKa(g.id, { publisher: ANA, author: STRANGER })))
  assert.equal(out.forgeries[0].kind, 'state-author-mismatch')
})

test('any state value other than exactly "active" counts as revoked', () => {
  const g = grant()
  const r = revocationKa(g.id)
  r.contentRows = r.contentRows.map(x => x.p === V.state ? { ...x, o: '"REVOKED-ish"' } : x)
  const out = reduceGrants(read(grantKa(g), r))
  assert.equal(out.states[0].state, 'revoked')
})

test('legacy-format grants are ignored with a warning, not treated as attacks', () => {
  const legacy = ka({ cg: GRANTS_CG, publisher: ANA, quads: [
    { subject: 'urn:mandate:grant:dana-5i66', predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: V.LikenessGrant },
  ] })
  const out = reduceGrants(read(legacy))
  assert.equal(out.grants.length, 0)
  assert.equal(out.forgeries.length, 0)
  assert.equal(out.warnings.length, 1)
})

test('derivations are attributed to their publisher and marked trusted only for configured producers', () => {
  const d = derivation({ authorizedUnder: grant().id })
  const r = read(derivationKa(d), derivationKa({ ...derivation({ authorizedUnder: grant().id }) }, { publisher: STRANGER }))
  const out = reduceSlice({ role: 'derivations', anchors: anchorsFromMeta(r.metaRows, DERIVS_CG).anchors, contentRows: r.contentRows, trustedProducers: [PRODUCER] })
  assert.equal(out.derivations.length, 2)
  assert.deepEqual(out.derivations.map(x => x.trusted).sort(), [false, true])
})

test('grant IRIs carry their grantor address', () => {
  assert.equal(grantIriAddress(grant().id), ANA)
  assert.equal(grantIriAddress('urn:mandate:grant:dana-5i66'), null)
})
