import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { anchorsFromMeta, checkConsistency, checkReturnedGraphs, reduceSlice, grantIriAddress } from '../src/provenance.mjs'
import { vmPublisherPrefix } from '../src/queries.mjs'
import { grantToQuads } from '../src/rdf.mjs'
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

test('content under the prefix from a graph with no anchor and not pending is inconsistent, with no graph count to catch it', () => {
  const g1 = grantKa(grant())
  const stray = grantKa(grant())
  const { anchors } = anchorsFromMeta(g1.metaRows, GRANTS_CG)
  const prefix = vmPublisherPrefix(GRANTS_CG, ANA)
  const contentRows = [...g1.contentRows, ...stray.contentRows]
  assert.equal(checkConsistency({ prefix, anchors, contentRows: g1.contentRows }).ok, true)
  const c = checkConsistency({ prefix, anchors, contentRows, visibleGraphCount: undefined })
  assert.equal(c.ok, false)
  assert.match(c.reason, /has no confirmed anchor/)
  // A graph the caller knows is pending is accounted for instead.
  assert.equal(checkConsistency({ prefix, anchors, contentRows, pendingGraphs: new Set([stray.graph]) }).ok, true)
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

test('the grantor\'s own state with a stateAuthor naming someone else still revokes, and says why', () => {
  const g = grant()
  const out = reduceGrants(read(grantKa(g), revocationKa(g.id, { publisher: ANA, author: STRANGER })))
  assert.equal(out.forgeries.length, 0)
  assert.equal(out.states.length, 1)
  assert.equal(out.states[0].state, 'revoked')
  assert.equal(out.states[0].malformed, true)
  assert.match(out.states[0].problems.join(), /stateAuthor .* does not name/)
  assert.ok(out.warnings.some(w => /counts as a revocation/.test(w)))
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

/* ------------------- rejected records and who they belong to ------------------- */

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const XSD = 'http://www.w3.org/2001/XMLSchema#'
const reduceDerivs = (r, trustedProducers = [PRODUCER]) =>
  reduceSlice({ role: 'derivations', anchors: anchorsFromMeta(r.metaRows, DERIVS_CG).anchors, contentRows: r.contentRows, trustedProducers })
const swap = (k, predicate, object) => { k.contentRows = k.contentRows.map(x => (x.p === predicate ? { ...x, o: object } : x)); return k }

test('a grant whose id names another address is a forgery, even when subject and grantor agree', () => {
  const g = grant({ id: `urn:mandate:grant:${STRANGER}:ana:0000000000000001` })
  const out = reduceGrants(read(grantKa(g)))
  assert.equal(out.grants.length, 0)
  assert.equal(out.forgeries[0].kind, 'grant-id-mismatch')
})

test('a trusted producer\'s edge whose id does not match its hash is a trusted forgery, not an edge', () => {
  const d = derivation({ authorizedUnder: grant().id, outputSha256: 'a'.repeat(64), id: `urn:mandate:derivation:${'b'.repeat(16)}:0000000000000001` })
  const out = reduceDerivs(read(derivationKa(d)))
  assert.equal(out.derivations.length, 0)
  assert.equal(out.forgeries[0].kind, 'derivation-id-mismatch')
  assert.equal(out.forgeries[0].trusted, true)
  assert.deepEqual(out.forgeries[0].claims.authorizedUnder, [d.authorizedUnder])
  assert.equal(reduceDerivs(read(derivationKa(d, { publisher: STRANGER }))).forgeries[0].trusted, false)
})

test('a trusted producer\'s legacy-format edge is a trusted forgery; a stranger\'s is only a warning', () => {
  const g = grant()
  const legacy = publisher => ka({ cg: DERIVS_CG, publisher, quads: [
    { subject: 'urn:mandate:derivation:legacy1', predicate: RDF_TYPE, object: V.Derivation },
    { subject: 'urn:mandate:derivation:legacy1', predicate: V.authorizedUnder, object: g.id },
    { subject: 'urn:mandate:derivation:legacy1', predicate: V.outputSha256, object: `"${'a'.repeat(64)}"` },
  ] })
  const mine = reduceDerivs(read(legacy(PRODUCER)))
  assert.equal(mine.forgeries[0].kind, 'legacy-format')
  assert.equal(mine.forgeries[0].trusted, true)
  assert.deepEqual(mine.forgeries[0].claims.outputSha256, ['a'.repeat(64)])
  const theirs = reduceDerivs(read(legacy(STRANGER)))
  assert.equal(theirs.forgeries.length, 0)
  assert.equal(theirs.warnings.length, 1)
})

test('a trusted edge with a negative billedUsd or no derivedAt is a trusted malformed forgery carrying its claims', () => {
  const d = derivation({ authorizedUnder: grant().id })
  const negative = swap(derivationKa(d), V.billedUsd, `"-1000"^^<${XSD}decimal>`)
  const out = reduceDerivs(read(negative))
  assert.equal(out.derivations.length, 0)
  assert.equal(out.forgeries[0].kind, 'malformed')
  assert.equal(out.forgeries[0].trusted, true)
  assert.deepEqual(out.forgeries[0].claims.billedUsd, ['-1000'])
  const undated = derivationKa(d)
  undated.contentRows = undated.contentRows.filter(x => x.p !== V.derivedAt)
  const u = reduceDerivs(read(ka({ cg: DERIVS_CG, publisher: PRODUCER, quads: undated.contentRows.map(x => ({ subject: x.s, predicate: x.p, object: x.o })) })))
  assert.equal(u.forgeries[0].kind, 'malformed')
  assert.match(u.forgeries[0].detail, /missing derivedAt/)
})

test('forgeries in a grants graph are trusted only under the address that owns what they claim', () => {
  const g = grant()
  const byProducer = reduceGrants(read(grantKa(g, { publisher: PRODUCER })))
  assert.equal(byProducer.forgeries[0].trusted, false)
  const dup = grantKa(g, { extraContent: [{ subject: g.id, predicate: V.maxSpendUsd, object: `"9"^^<${XSD}decimal>` }] })
  const mine = reduceGrants(read(dup))
  assert.equal(mine.forgeries[0].kind, 'malformed')
  assert.equal(mine.forgeries[0].trusted, true)
})

test('an unparseable cell is kept, so a present-but-odd ceiling makes the grant malformed instead of unlimited', () => {
  const g = grant({ maxSpendUsd: 5 })
  for (const cell of ['"5"^^xsd:decimal', `"5"^^<${XSD}decimal> `, { type: 'Literal', value: '5' }, `"${'5'.repeat(5000)}"`]) {
    const out = reduceGrants(read(swap(grantKa(g), V.maxSpendUsd, cell)))
    assert.equal(out.grants.length, 0, JSON.stringify(cell).slice(0, 40))
    assert.equal(out.forgeries[0].kind, 'malformed')
    assert.equal(out.forgeries[0].trusted, true)
  }
})

/* ------------------- the grantor's own state assertions ------------------- */

const ownState = (grantId, pairs) => {
  const id = 'urn:mandate:state:00000000000000d1'
  return ka({ cg: GRANTS_CG, publisher: ANA, quads: pairs.map(([predicate, object]) => ({ subject: id, predicate, object })) })
}
const wellFormed = (grantId, value = 'revoked') => [
  [RDF_TYPE, V.GrantState], [V.stateOf, grantId], [V.state, `"${value}"`], [V.stateAuthor, did(ANA)], [V.stateAt, `"2026-09-13T10:00:00Z"^^<${XSD}dateTime>`],
]
const variants = grantId => ({
  'offset-less stateAt': wellFormed(grantId).map(([p, o]) => [p, p === V.stateAt ? `"2026-09-13T10:00:00"^^<${XSD}dateTime>` : o]),
  'date-only stateAt': wellFormed(grantId).map(([p, o]) => [p, p === V.stateAt ? `"2026-09-13"^^<${XSD}date>` : o]),
  'duplicated stateAt': [...wellFormed(grantId), [V.stateAt, `"2026-09-14T10:00:00Z"^^<${XSD}dateTime>`]],
  'duplicated state': [...wellFormed(grantId), [V.state, '"revoked-again"']],
  'typed state literal': wellFormed(grantId).map(([p, o]) => [p, p === V.state ? `"active"^^<${XSD}token>` : o]),
  'state given as an IRI': wellFormed(grantId).map(([p, o]) => [p, p === V.state ? 'urn:mandate:state-value:revoked' : o]),
  'language-tagged active': wellFormed(grantId, 'active').map(([p, o]) => [p, p === V.state ? '"active"@en' : o]),
  'missing stateAuthor': wellFormed(grantId).filter(([p]) => p !== V.stateAuthor),
  'stateAuthor as a literal': wellFormed(grantId).map(([p, o]) => [p, p === V.stateAuthor ? `"${did(ANA)}"` : o]),
  'mismatched stateAuthor': wellFormed(grantId).map(([p, o]) => [p, p === V.stateAuthor ? did(STRANGER) : o]),
  '"active" with a mismatched stateAuthor': wellFormed(grantId, 'active').map(([p, o]) => [p, p === V.stateAuthor ? did(STRANGER) : o]),
  'missing state': wellFormed(grantId).filter(([p]) => p !== V.state),
  'unparseable state cell': wellFormed(grantId).map(([p, o]) => [p, p === V.state ? '"revoked"^^xsd:string' : o]),
})

for (const name of Object.keys(variants(grant().id))) {
  test(`the grantor's own state with ${name} yields a revoked state entry with its problems`, () => {
    const g = grant()
    const out = reduceGrants(read(grantKa(g), ownState(g.id, variants(g.id)[name])))
    assert.equal(out.states.length, 1, JSON.stringify(out.forgeries))
    const st = out.states[0]
    assert.equal(st.state, 'revoked')
    assert.equal(st.tier, 'vm')
    assert.equal(st.publisher, ANA)
    assert.equal(st.stateOf, g.id)
    assert.ok(st.ual)
    assert.equal(st.malformed, true)
    assert.ok(st.problems.length > 0)
  })
}

test('a well-formed "active" state is active and not malformed', () => {
  const g = grant()
  const out = reduceGrants(read(grantKa(g), ownState(g.id, wellFormed(g.id, 'active'))))
  assert.equal(out.states[0].state, 'active')
  assert.equal(out.states[0].malformed, undefined)
  assert.deepEqual(out.states[0].problems, [])
})

test('a GrantState whose stateOf cannot be read is unreadable, never silently dropped', () => {
  const g = grant()
  for (const stateOf of [[[V.stateOf, `"${g.id}"`]], [], [[V.stateOf, g.id], [V.stateOf, grant().id]]]) {
    const pairs = [...wellFormed(g.id).filter(([p]) => p !== V.stateOf), ...stateOf]
    const out = reduceGrants(read(grantKa(g), ownState(g.id, pairs)))
    assert.equal(out.states.length, 0)
    assert.equal(out.unreadable.length, 1)
    assert.match(out.unreadable[0].reason, /unreadable stateOf/)
  }
})

test('the grantor\'s own untyped statement whose stateOf about its own grant cannot be read is unreadable, not dropped', () => {
  const g = grant()
  const base = [[V.state, '"revoked"'], [V.stateAuthor, did(ANA)]]
  for (const [name, pairs] of Object.entries({
    'a literal stateOf': [[V.stateOf, `"${g.id}"`], ...base],
    'two stateOf values': [[V.stateOf, g.id], [V.stateOf, grant().id], ...base],
    'typed only LikenessGrant, literal stateOf': [[RDF_TYPE, V.LikenessGrant], [V.stateOf, `"${g.id}"`], ...base],
  })) {
    const out = reduceGrants(read(grantKa(g), ownState(g.id, pairs)))
    assert.equal(out.states.length, 0, name)
    assert.equal(out.unreadable.length, 1, name)
    assert.match(out.unreadable[0].reason, /unreadable stateOf/, name)
    assert.equal(out.forgeries.find(f => f.detail === 'unreadable stateOf')?.trusted, true, name)
  }
  // A literal stateOf naming someone else's grant is still not this publisher's statement.
  const foreign = reduceGrants(read(grantKa(g), ownState(g.id, [[V.stateOf, `"${grant({ owner: STRANGER, local: 'sam' }).id}"`], ...base])))
  assert.deepEqual([foreign.states.length, foreign.unreadable.length], [0, 0])
})

test('an object with an unreadable rdf:type is unreadable', () => {
  const g = grant()
  const k = grantKa(g)
  k.contentRows = k.contentRows.map(x => (x.p === RDF_TYPE ? { ...x, o: `"${x.o}"` } : x))
  assert.equal(reduceGrants(read(k)).unreadable.length, 1)
})

test('a grant under the subject\'s own prefix whose mandate:grantor names another agent is a forgery, not a grant', () => {
  // grantToQuads refuses this, so the grantor triple is swapped after serialising, as a hand-written publish would.
  const quads = grantToQuads(grant()).map(q => (q.predicate === V.grantor ? { ...q, object: did(STRANGER) } : q))
  assert.ok(quads.some(q => q.object === did(STRANGER)), 'fixture precondition')
  const out = reduceGrants(read(ka({ cg: GRANTS_CG, publisher: ANA, quads })))
  assert.equal(out.grants.length, 0)
  assert.equal(out.forgeries.length, 1)
  assert.equal(out.forgeries[0].kind, 'grantor-literal-mismatch')
  assert.equal(out.forgeries[0].trusted, true)
})

/* ------------------- objects typed more than one way, or not at all ------------------- */

test('contract 3: the grantor\'s own state also typed LikenessGrant is a revoked state entry, never a failed grant', () => {
  const g = grant()
  for (const id of [`urn:mandate:grant:${ANA}:ana:00000000000000c9`, g.id, 'urn:x:state:1']) {
    const pairs = [[RDF_TYPE, V.LikenessGrant], ...wellFormed(g.id, 'active')]
    const k = ka({ cg: GRANTS_CG, publisher: ANA, quads: pairs.map(([predicate, object]) => ({ subject: id, predicate, object })) })
    const out = reduceGrants(read(grantKa(g), k))
    assert.equal(out.states.length, 1, id)
    assert.equal(out.states[0].state, 'revoked')
    assert.equal(out.states[0].stateOf, g.id)
    assert.match(out.states[0].problems.join(), /also typed LikenessGrant/)
    assert.equal(out.forgeries.length, 0)
    assert.equal(out.grants.length, 1, 'the real grant is still read')
  }
})

test('contract 3: the grantor\'s own "active" co-typed Derivation, or with no GrantState type, counts as revoked', () => {
  const g = grant()
  const typed = [[RDF_TYPE, V.Derivation], ...wellFormed(g.id, 'active')]
  const untyped = wellFormed(g.id, 'active').filter(([p]) => p !== RDF_TYPE)
  const renamed = wellFormed(g.id, 'active').map(([p, o]) => [p, p === RDF_TYPE ? `${V.GrantState}V2` : o])
  for (const [name, pairs, problem] of [['co-typed', typed, /also typed Derivation/], ['untyped', untyped, /not typed GrantState/], ['renamed', renamed, /not typed GrantState.*unknown type GrantStateV2/]]) {
    const out = reduceGrants(read(grantKa(g), ownState(g.id, pairs)))
    assert.equal(out.states.length, 1, name)
    assert.equal(out.states[0].state, 'revoked', name)
    assert.match(out.states[0].problems.join(), problem, name)
  }
})

test('an untyped stateOf naming someone else\'s grant, in a stranger\'s prefix, is still ignored by the reducer', () => {
  const g = grant()
  const k = ka({ cg: GRANTS_CG, publisher: STRANGER, quads: [{ subject: 'urn:x:1', predicate: V.stateOf, object: g.id }, { subject: 'urn:x:1', predicate: V.state, object: '"active"' }] })
  const out = reduceGrants(read(grantKa(g), k))
  assert.deepEqual([out.states.length, out.forgeries.length], [0, 0])
})

test('contract 6: a trusted state with an unreadable stateOf is reported as a trusted malformed forgery with its claims', () => {
  const g = grant()
  const pairs = [...wellFormed(g.id).filter(([p]) => p !== V.stateOf), [V.stateOf, g.id], [V.stateOf, `"${g.id}"`]]
  const out = reduceGrants(read(grantKa(g), ownState(g.id, pairs)))
  const f = out.forgeries.find(x => x.detail === 'unreadable stateOf')
  assert.ok(f, JSON.stringify(out.forgeries))
  assert.equal(f.kind, 'malformed')
  assert.equal(f.trusted, true)
  assert.deepEqual(f.claims.stateOf, [g.id])
})

for (const [name, edit] of [
  ['no rdf:type', rows => rows.filter(x => x.p !== RDF_TYPE)],
  ['a foreign namespace type', rows => rows.map(x => (x.p === RDF_TYPE ? { ...x, o: 'https://example.org/mandate/v2#Derivation' } : x))],
  ['an unknown mandate type', rows => rows.map(x => (x.p === RDF_TYPE ? { ...x, o: `${V.Derivation}V2` } : x))],
  ['a Refusal type', rows => rows.map(x => (x.p === RDF_TYPE ? { ...x, o: V.Refusal } : x))],
]) {
  test(`item 5: a trusted producer's edge with ${name} is a trusted malformed forgery carrying its grant and bill`, () => {
    const d = derivation({ authorizedUnder: grant().id, billedUsd: 4.5 })
    const quads = edit(derivationKa(d).contentRows).map(x => ({ subject: x.s, predicate: x.p, object: x.o }))
    const out = reduceDerivs(read(ka({ cg: DERIVS_CG, publisher: PRODUCER, quads })))
    assert.equal(out.derivations.length, 0)
    assert.equal(out.forgeries.length, 1, JSON.stringify(out.warnings))
    assert.equal(out.forgeries[0].kind, 'malformed')
    assert.equal(out.forgeries[0].trusted, true)
    assert.deepEqual(out.forgeries[0].claims.authorizedUnder, [d.authorizedUnder])
    assert.deepEqual(out.forgeries[0].claims.billedUsd, ['4.5'])
    // A stranger's is not their record to answer for.
    const theirs = reduceDerivs(read(ka({ cg: DERIVS_CG, publisher: STRANGER, quads })))
    assert.deepEqual([theirs.derivations.length, theirs.forgeries.length], [0, 0])
  })
}

test('a trusted producer\'s plain Refusal names no grant or file and is not a forgery', () => {
  const quads = [{ subject: 'urn:mandate:refusal:1', predicate: RDF_TYPE, object: V.Refusal }, { subject: 'urn:mandate:refusal:1', predicate: V.deniedByClause, object: '"not-revoked"' }]
  assert.equal(reduceDerivs(read(ka({ cg: DERIVS_CG, publisher: PRODUCER, quads }))).forgeries.length, 0)
})

test('claims keep every value: a trusted record naming the grant fifth still names it', () => {
  const g = grant()
  const d = derivation({ authorizedUnder: g.id })
  const k = derivationKa(d)
  const others = Array.from({ length: 6 }, () => grant().id)
  const rows = k.contentRows.filter(x => x.p !== V.authorizedUnder)
  const extra = [...others.slice(0, 4), g.id, ...others.slice(4)].map(o => ({ ...k.contentRows.find(x => x.p === V.authorizedUnder), o }))
  const quads = [...rows, ...extra].map(x => ({ subject: x.s, predicate: x.p, object: x.o }))
  const out = reduceDerivs(read(ka({ cg: DERIVS_CG, publisher: PRODUCER, quads })))
  assert.equal(out.forgeries[0].trusted, true)
  assert.equal(out.forgeries[0].claims.authorizedUnder.length, 7)
  assert.ok(out.forgeries[0].claims.authorizedUnder.includes(g.id))
})

test('the graph count guard: more graphs visible than anchored plus pending is inconsistent', () => {
  const g1 = grantKa(grant())
  const { anchors } = anchorsFromMeta(g1.metaRows, GRANTS_CG)
  const prefix = vmPublisherPrefix(GRANTS_CG, ANA)
  assert.equal(checkConsistency({ prefix, anchors, contentRows: g1.contentRows, visibleGraphCount: 1 }).ok, true)
  assert.match(checkConsistency({ prefix, anchors, contentRows: g1.contentRows, visibleGraphCount: 2 }).reason, /shows 2 graphs .* but 1 are anchored/)
  assert.equal(checkConsistency({ prefix, anchors, contentRows: g1.contentRows, visibleGraphCount: 2, pendingGraphs: new Set([`${prefix}999`]) }).ok, true)
})

test('a clause value outside its pattern makes the grant malformed, never a value that matches nothing', () => {
  for (const [predicate, value, detail] of [
    [V.forbidsUseClass, '"Political"', 'invalid forbidsUseClass'],
    [V.permitsUseClass, '"Advertising"', 'invalid permitsUseClass'],
    [V.territory, '"gb"', 'invalid territory'],
    [V.permitsCapability, '"Talking Head"', 'invalid permitsCapability'],
  ]) {
    const k = grantKa(grant())
    const i = k.contentRows.findIndex(r => r.p === predicate)
    assert.ok(i >= 0, `fixture precondition: ${detail}`)
    k.contentRows[i] = { ...k.contentRows[i], o: value }
    const out = reduceGrants(read(k))
    assert.equal(out.grants.length, 0, detail)
    assert.equal(out.forgeries.length, 1, detail)
    assert.equal(out.forgeries[0].kind, 'malformed', detail)
    assert.equal(out.forgeries[0].detail, detail)
    assert.equal(out.forgeries[0].trusted, true, detail)
  }
})

test('a grant with no capability, or a window that ends before it starts, or a repeated clause value, is malformed', () => {
  const cases = [
    ['no permitsCapability', k => { k.contentRows = k.contentRows.filter(r => r.p !== V.permitsCapability) }],
    ['validUntil is not after validFrom', k => {
      const until = k.contentRows.find(r => r.p === V.validUntil)
      const from = k.contentRows.find(r => r.p === V.validFrom)
      assert.ok(until && from, 'fixture precondition: a window')
      from.o = until.o
    }],
    ['duplicate territory', k => { k.contentRows.push({ ...k.contentRows.find(r => r.p === V.territory) }) }],
  ]
  for (const [detail, change] of cases) {
    const k = grantKa(grant({ territory: ['GB'] }))
    change(k)
    const out = reduceGrants(read(k))
    assert.equal(out.grants.length, 0, detail)
    assert.equal(out.forgeries[0]?.kind, 'malformed', detail)
    assert.equal(out.forgeries[0].detail, detail)
  }
})

test('a trusted edge with an unreadable hash or grant IRI is a malformed forgery, not an edge; a state in a derivations graph is misplaced', () => {
  for (const [predicate, object, detail] of [
    [V.outputSha256, '"not-a-hash"', 'invalid outputSha256'],
    [V.authorizedUnder, '<urn:mandate:grant:bad"iri>', 'invalid authorizedUnder'],
  ]) {
    const d = derivation({ authorizedUnder: grant().id })
    const out = reduceDerivs(read(swap(derivationKa(d), predicate, object)))
    assert.equal(out.derivations.length, 0, detail)
    assert.equal(out.forgeries[0]?.kind, 'malformed', detail)
    assert.equal(out.forgeries[0].detail, detail)
  }
  const g = grant()
  const state = revocationKa(g.id)
  const k = ka({ cg: DERIVS_CG, publisher: PRODUCER, quads: state.contentRows.map(r => ({ subject: r.s, predicate: r.p, object: r.o })) })
  const out = reduceDerivs(read(k))
  assert.equal(out.states.length, 0)
  assert.equal(out.forgeries[0]?.kind, 'misplaced-state')
})
