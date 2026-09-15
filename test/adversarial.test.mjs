/**
 * Every attack from the adversarial study, replayed as graph data.
 *
 * Each case publishes Knowledge Assets — the attacker's under the attacker's own
 * address, as the chain forces — and asserts the safe outcome through the whole
 * read path: node query, resolver, gate or verifier.
 *
 * The same file runs against an older implementation:
 *
 *   git worktree add /tmp/mandate-v010 v0.1.0
 *   MANDATE_SRC=/tmp/mandate-v010/src node --test test/adversarial.test.mjs
 *
 * v0.1.0 read every graph through the dkg CLI's table output and trusted
 * self-declared authors. Every case must fail there: a case that passes on
 * v0.1.0 proves nothing about what changed, so cases whose own fault a table
 * read cannot expose also carry an attack v0.1.0 gets wrong.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as V from '../src/vocab.mjs'
import { FakeNode } from './fixtures/fake-node.mjs'
import {
  GRANTS_CG, DERIVS_CG, ANA, PRODUCER, STRANGER, did, ka, grant, grantKa, revocationKa, derivation, derivationKa,
} from './fixtures/build.mjs'

const SRC = process.env.MANDATE_SRC ? `${pathToFileURL(resolve(process.env.MANDATE_SRC)).href}/` : new URL('../src/', import.meta.url).href
const gate = await import(`${SRC}gate.mjs`)
const resolver = await import(`${SRC}resolve.mjs`)
const verifier = await import(`${SRC}verify-core.mjs`)
const CURRENT = typeof resolver.readPublisher === 'function'

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const DEC = '^^<http://www.w3.org/2001/XMLSchema#decimal>'
const DT = '^^<http://www.w3.org/2001/XMLSchema#dateTime>'
const SUBJECT = `${ANA}:ana`
const NOW = '2026-09-13T12:00:00Z'
const SHA = 'c'.repeat(64)
const req = (over = {}) => ({
  subject: SUBJECT, capability: 'talking-head', useClass: 'advertising', territory: 'GB', at: NOW, estimatedUsd: 1, ...over,
})
const raw = (subject, pairs) => pairs.map(([predicate, object]) => ({ subject, predicate, object }))
const state = (id, grantId, value, author, at) => raw(id, [
  [RDF_TYPE, V.GrantState], [V.stateOf, grantId], [V.state, `"${value}"`], [V.stateAuthor, did(author)], [V.stateAt, `"${at}"${DT}`],
])

/* -------------------------------------------------------------------------- */
/* Harness: the same world through either implementation                      */
/* -------------------------------------------------------------------------- */

const cgOf = k => (k.graph.includes(`${GRANTS_CG}/`) ? GRANTS_CG : DERIVS_CG)

/** v0.1.0 read `dkg query` table output; render exactly that. */
function cliTable(rows) {
  const cell = v => (v.startsWith('"') ? v.slice(1, v.lastIndexOf('"')) : v)
  const body = rows.map(r => [cell(r.s), cell(r.p), cell(r.o)])
  const widths = [0, 1, 2].map(i => Math.max(1, ...body.map(b => b[i].length)))
  const line = cols => cols.map((c, i) => c.padEnd(widths[i])).join('  ')
  return [line(['s', 'p', 'o']), line(widths.map(w => '─'.repeat(w))), ...body.map(line), '', `${rows.length} row(s)`].join('\n')
}

/**
 * `fault(node)` wraps the node with a fault of its own, and `cfg` adds reader
 * configuration. Both apply to the current implementation only: v0.1.0 read a
 * CLI table and had neither, so cases using them also carry an attack it gets wrong.
 */
async function knowledge(kas, scope, { drop, rowOrder = rows => rows, fault = node => node, cfg = {}, mergedView } = {}) {
  if (CURRENT) {
    const world = {}
    for (const k of kas) (world[cgOf(k)] ??= { kas: [] }).kas.push(k)
    const node = fault(new FakeNode({ world, drop: drop ? q => q.graph !== undefined && drop(q.graph) : undefined, mergedView }))
    return resolver.readKnowledge(node, { grantsCg: GRANTS_CG, derivationsCgs: [DERIVS_CG], sleep: async () => {}, attempts: 2, ...cfg }, scope)
  }
  const node = {
    query: async cg => cliTable(rowOrder(kas.filter(k => cgOf(k) === cg).flatMap(k => k.contentRows)).filter(r => !drop?.(r.g))),
  }
  return resolver.readKnowledge(node, [GRANTS_CG, DERIVS_CG])
}

async function render(kas, request = req(), opts) {
  const k = await knowledge(kas, { subject: request.subject }, opts)
  if (CURRENT) return gate.decide(request, k)
  const candidate = k.grants.find(g => g.subject === request.subject)
  const priorSpendUsd = candidate ? resolver.priorSpendFor(candidate.id, k.derivations) : 0
  return gate.decide(request, { grants: k.grants, assertions: k.assertions, priorSpendUsd })
}

async function verify(kas, sha = SHA, now = NOW, opts) {
  return verifier.verifyKnowledge(await knowledge(kas, { sha256: sha }, opts), sha, { now })
}

/**
 * A producer's well-formed "active" naming Ana, later than any real state. Cases
 * whose own fault a table read never exposes (v0.1.0 saw no wire cells and had no
 * row limits) pair it in, so the case still fails where authors were
 * self-declared: a resolver that drops Ana's revocation, or believes this, permits.
 */
const forgedActive = grantId => ka({ cg: GRANTS_CG, publisher: PRODUCER,
  quads: state('urn:mandate:state:00000000000000fa', grantId, 'active', ANA, '2026-09-13T23:30:00Z') })

const edgeFor = (grantId, over = {}) => derivation({ outputSha256: SHA, authorizedUnder: grantId, servedCapability: 'talking-head', derivedAt: '2026-09-13T11:00:00Z', ...over })

/* -------------------------------------------------------------------------- */
/* SEC-1 — un-revoking someone else's grant                                   */
/* -------------------------------------------------------------------------- */

for (const where of ['derivations', 'grants']) {
  test(`SEC-1: a producer's newer "active" naming Ana, in the ${where} graph, does not un-revoke`, async () => {
    const g = grant()
    const forged = ka({ cg: where === 'grants' ? GRANTS_CG : DERIVS_CG, publisher: PRODUCER,
      quads: state('urn:mandate:state:00000000000000f1', g.id, 'active', ANA, '2026-09-13T11:00:00Z') })
    const kas = [grantKa(g), revocationKa(g.id, { at: '2026-09-13T10:00:00Z' }), forged, derivationKa(edgeFor(g.id))]
    const d = await render(kas)
    assert.equal(d.permit, false)
    assert.equal(d.clause, 'not-revoked')
    assert.notEqual((await verify(kas)).verdict, verifier.CLEAR)
  })
}

/* -------------------------------------------------------------------------- */
/* SEC-2 — inventing a grant                                                  */
/* -------------------------------------------------------------------------- */

test('SEC-2: a grant for Ana published by the producer gets no permit and no CLEAR', async () => {
  const fake = grant({ permitsCapability: ['talking-head', 'face-swap-video'] })
  for (const cg of [GRANTS_CG, DERIVS_CG]) {
    const kas = [
      cg === GRANTS_CG ? grantKa(fake, { publisher: PRODUCER }) : ka({ cg, publisher: PRODUCER, quads: grantKa(fake).contentRows.map(r => ({ subject: r.s, predicate: r.p, object: r.o })) }),
      derivationKa(edgeFor(fake.id)),
    ]
    assert.equal((await render(kas)).permit, false)
    assert.notEqual((await verify(kas)).verdict, verifier.CLEAR)
  }
})

/* -------------------------------------------------------------------------- */
/* SEC-3 — griefing with a far-future state                                   */
/* -------------------------------------------------------------------------- */

test('SEC-3: a stranger\'s far-future "revoked" naming Ana cannot block a live grant', async () => {
  const g = grant()
  const grief = ka({ cg: GRANTS_CG, publisher: STRANGER, quads: state('urn:mandate:state:00000000000000f3', g.id, 'revoked', ANA, '9999-12-31T00:00:00Z') })
  // A live node materialises merged views only for data it published itself, so a
  // stranger's state reaches the gate's node with no merged-view copy.
  assert.equal((await render([grantKa(g), grief], req(), { mergedView: false })).permit, true)
})

/* -------------------------------------------------------------------------- */
/* SEC-4 — widening a grant with one triple                                   */
/* -------------------------------------------------------------------------- */

test('SEC-4: an extra permitsCapability/territory triple in another KA does not widen a grant', async () => {
  const g = grant({ permitsCapability: ['talking-head'], territory: ['GB'] })
  const widen = ka({ cg: DERIVS_CG, publisher: PRODUCER, quads: raw(g.id, [[V.permitsCapability, '"face-swap-video"'], [V.territory, '"FR"']]) })
  const d = await render([grantKa(g), widen], req({ capability: 'face-swap-video', territory: 'FR' }))
  assert.equal(d.permit, false)
})

test('SEC-4: a non-numeric ceiling does not disable the spend clause', async () => {
  const g = grant()
  const bad = grantKa(g)
  bad.contentRows = bad.contentRows.map(r => (r.p === V.maxSpendUsd ? { ...r, o: `"lots"${DEC}` } : r))
  assert.equal((await render([bad], req({ estimatedUsd: 1000 }))).permit, false)
})

/* -------------------------------------------------------------------------- */
/* SEC-5 — laundering through a colliding derivation IRI                      */
/* -------------------------------------------------------------------------- */

test('SEC-5: a second authorizedUnder on the same derivation IRI cannot clear a revoked render', async () => {
  const revoked = grant()
  const live = grant()
  const d = edgeFor(revoked.id)
  const launder = ka({ cg: DERIVS_CG, publisher: STRANGER, quads: raw(d.id, [[V.authorizedUnder, live.id]]) })
  const r = await verify([launder, grantKa(revoked), grantKa(live), revocationKa(revoked.id), derivationKa(d)])
  assert.equal(r.verdict, verifier.TAINTED)
})

/* -------------------------------------------------------------------------- */
/* SEC-6 — a literal that looks like a table footer                           */
/* -------------------------------------------------------------------------- */

test('SEC-6: a literal containing "row(s)" hides nothing that follows it', async () => {
  const g = grant({ maxSpendUsd: 5 })
  const bait = ka({ cg: GRANTS_CG, publisher: STRANGER, quads: raw('urn:bait', [['http://www.w3.org/2000/01/rdf-schema#label', '"3 row(s)"']]) })
  // Row order is the store's choice; this is the order that hides the ceiling and the revocation.
  const late = r => r.p === V.maxSpendUsd || r.s.startsWith('urn:mandate:state:')
  const rowOrder = rows => [...rows.filter(r => !late(r) && r.s !== 'urn:bait'), ...rows.filter(r => r.s === 'urn:bait'), ...rows.filter(late)]
  const d = await render([grantKa(g), revocationKa(g.id), bait], req({ estimatedUsd: 1000 }), { rowOrder })
  assert.equal(d.permit, false)
})

/* -------------------------------------------------------------------------- */
/* COR — fail-open inputs                                                     */
/* -------------------------------------------------------------------------- */

test('COR-1: an unparseable request time against an expired grant refuses', async () => {
  const g = grant({ validUntil: '2026-09-02T00:00:00Z' })
  for (const at of [undefined, 'garbage', '--execute']) assert.equal((await render([grantKa(g)], req({ at }))).permit, false, String(at))
})

test('COR-2: an unknown price under a ceiling refuses', async () => {
  assert.equal((await render([grantKa(grant({ maxSpendUsd: 5 }))], req({ estimatedUsd: null }))).permit, false)
})

test('COR-2: a stranger\'s negative billedUsd opens no headroom', async () => {
  const g = grant({ maxSpendUsd: 5 })
  const spent = derivationKa(edgeFor(g.id, { outputSha256: 'd'.repeat(64), billedUsd: 4.5 }))
  const credit = ka({ cg: DERIVS_CG, publisher: STRANGER, quads: raw('urn:mandate:derivation:eeeeeeeeeeeeeeee:0000000000000001', [
    [RDF_TYPE, V.Derivation], [V.outputSha256, `"${'e'.repeat(64)}"`], [V.servedCapability, '"talking-head"'],
    [V.authorizedUnder, g.id], [V.billedUsd, `"-1000"${DEC}`],
  ]) })
  assert.equal((await render([grantKa(g), spent, credit], req({ estimatedUsd: 1 }))).permit, false)
})

test('COR-3: spend under the grant that matches, not the subject\'s first grant', async () => {
  const g1 = grant({ id: `urn:mandate:grant:${ANA}:ana:0000000000000001`, permitsCapability: ['face-swap-image'], maxSpendUsd: 4 })
  const g2 = grant({ id: `urn:mandate:grant:${ANA}:ana:0000000000000002`, permitsCapability: ['talking-head'], maxSpendUsd: 4 })
  const spent = derivationKa(edgeFor(g2.id, { billedUsd: 3.9 }))
  const d = await render([grantKa(g1), grantKa(g2), spent], req({ estimatedUsd: 1 }))
  assert.equal(d.permit, false)
  assert.equal(d.clause, 'spend-ceiling')
})

test('COR-4: a request with no territory does not pass a GB-only grant', async () => {
  assert.equal((await render([grantKa(grant({ territory: ['GB'] }))], req({ territory: undefined }))).permit, false)
})

test('COR-6: revocation holds on timestamp ties, in either row order, and for any spelling', async () => {
  const g = grant()
  const at = '2026-09-13T10:00:00Z'
  const rev = ka({ cg: GRANTS_CG, publisher: ANA, quads: state('urn:mandate:state:00000000000000a1', g.id, 'revoked', ANA, at) })
  const act = ka({ cg: GRANTS_CG, publisher: ANA, quads: state('urn:mandate:state:00000000000000a2', g.id, 'active', ANA, at) })
  assert.equal((await render([grantKa(g), rev, act])).permit, false)
  assert.equal((await render([grantKa(g), act, rev])).permit, false)
  const upper = ka({ cg: GRANTS_CG, publisher: ANA, quads: state('urn:mandate:state:00000000000000a3', g.id, 'REVOKED', ANA, at) })
  assert.equal((await render([grantKa(g), upper])).permit, false)
})

test('COR-7: a file under a grant not valid until 2030 does not verify CLEAR', async () => {
  const g = grant({ validFrom: '2030-01-01T00:00:00Z', validUntil: '2031-01-01T00:00:00Z' })
  assert.notEqual((await verify([grantKa(g), derivationKa(edgeFor(g.id))])).verdict, verifier.CLEAR)
})

test('COR-8: a revocation from a tool that writes the DID in mixed case still revokes', async () => {
  const g = grant()
  const mixed = `0x${ANA.slice(2).toUpperCase()}`
  const rev = ka({ cg: GRANTS_CG, publisher: ANA, quads: state('urn:mandate:state:00000000000000b1', g.id, 'revoked', mixed, NOW) })
  rev.contentRows = rev.contentRows.map(r => (r.p === V.stateAuthor ? { ...r, o: `did:dkg:agent:${mixed}` } : r))
  assert.equal((await render([grantKa(g), rev])).permit, false)
})

/* -------------------------------------------------------------------------- */
/* DOC-7 — a partial read                                                     */
/* -------------------------------------------------------------------------- */

test('DOC-7: a read that silently misses the revocation graph refuses', async () => {
  const g = grant()
  const rev = revocationKa(g.id)
  const d = await render([grantKa(g), rev], req(), { drop: graph => graph === rev.graph })
  assert.equal(d.permit, false)
})

/* -------------------------------------------------------------------------- */
/* R4 — the grantor's own revocation, written slightly wrong                  */
/* -------------------------------------------------------------------------- */

const XSD_NS = 'http://www.w3.org/2001/XMLSchema#'
const ownRevocation = (grantId, edit) => {
  const id = 'urn:mandate:state:00000000000000c1'
  const pairs = edit([
    [RDF_TYPE, V.GrantState], [V.stateOf, grantId], [V.state, '"revoked"'], [V.stateAuthor, did(ANA)], [V.stateAt, `"2026-09-13T10:00:00Z"${DT}`],
  ])
  return ka({ cg: GRANTS_CG, publisher: ANA, quads: raw(id, pairs) })
}
const setP = (predicate, object) => pairs => pairs.map(([p, o]) => [p, p === predicate ? object : o])
const R4_CASES = {
  'an offset-less stateAt': setP(V.stateAt, `"2026-09-13T10:00:00"${DT}`),
  'a date-only stateAt': setP(V.stateAt, `"2026-09-13"^^<${XSD_NS}date>`),
  'a duplicated stateAt': pairs => [...pairs, [V.stateAt, `"2026-09-12T10:00:00Z"${DT}`]],
  'a typed state literal': setP(V.state, `"revoked"^^<${XSD_NS}token>`),
  'a state given as an IRI': setP(V.state, 'urn:mandate:revoked'),
  'a missing stateAuthor': pairs => pairs.filter(([p]) => p !== V.stateAuthor),
  'a mismatched stateAuthor': setP(V.stateAuthor, did(STRANGER)),
  'an unparseable state cell': setP(V.state, '"revoked"^^xsd:string'),
  'a second type, LikenessGrant': pairs => [...pairs, [RDF_TYPE, V.LikenessGrant]],
  'a second type, Derivation': pairs => [...pairs, [RDF_TYPE, V.Derivation]],
  'no rdf:type': pairs => pairs.filter(([p]) => p !== RDF_TYPE),
  'a renamed type': setP(RDF_TYPE, `${V.GrantState}V2`),
}

for (const [name, edit] of Object.entries(R4_CASES)) {
  test(`R4: Ana's own revocation with ${name} still refuses and never verifies CLEAR`, async () => {
    const g = grant()
    const kas = [grantKa(g), ownRevocation(g.id, edit), forgedActive(g.id), derivationKa(edgeFor(g.id))]
    const d = await render(kas)
    assert.equal(d.permit, false)
    if (CURRENT) assert.equal(d.clause, 'not-revoked')
    assert.notEqual((await verify(kas)).verdict, verifier.CLEAR)
  })
}

test('R4: Ana\'s own revocation whose stateOf is a literal refuses as an unreadable read', async () => {
  const g = grant()
  const kas = [grantKa(g), ownRevocation(g.id, setP(V.stateOf, `"${g.id}"`)), forgedActive(g.id), derivationKa(edgeFor(g.id))]
  assert.equal((await render(kas)).permit, false)
  assert.notEqual((await verify(kas)).verdict, verifier.CLEAR)
})

test('R4: Ana\'s own untyped statement whose stateOf is a literal refuses as an unreadable read', async () => {
  const g = grant()
  const id = 'urn:mandate:state:00000000000009c2'
  const untyped = ka({ cg: GRANTS_CG, publisher: ANA, quads: raw(id, [[V.stateOf, `"${g.id}"`], [V.state, '"revoked"'], [V.stateAuthor, did(ANA)]]) })
  const kas = [grantKa(g), untyped, forgedActive(g.id), derivationKa(edgeFor(g.id))]
  const d = await render(kas)
  assert.equal(d.permit, false)
  if (CURRENT) assert.equal(d.clause, 'read-inconsistent')
  assert.notEqual((await verify(kas)).verdict, verifier.CLEAR)
})

/* -------------------------------------------------------------------------- */
/* SEC-6 — cells that do not parse                                            */
/* -------------------------------------------------------------------------- */

for (const cell of ['"5"^^xsd:decimal', `"5"${DEC} `, `"${'5'.repeat(5000)}"`]) {
  test(`SEC-6: a ceiling cell that does not parse (${cell.slice(0, 20)}) is not "no ceiling"`, async () => {
    const g = grant({ maxSpendUsd: 5 })
    const bad = grantKa(g)
    bad.contentRows = bad.contentRows.map(r => (r.p === V.maxSpendUsd ? { ...r, o: cell } : r))
    // A stranger's second ceiling for the same grant id, read first. The odd cell must not
    // leave the stranger's value (or none) as the ceiling.
    const widen = ka({ cg: GRANTS_CG, publisher: STRANGER, quads: raw(g.id, [[V.maxSpendUsd, `"100000"${DEC}`]]) })
    assert.equal((await render([widen, bad], req({ estimatedUsd: 1000 }))).permit, false)
  })
}

/* -------------------------------------------------------------------------- */
/* SEC-5 / R20 — flooding discovery                                           */
/* -------------------------------------------------------------------------- */

test('R20: a stranger asset repeating a file\'s hash as a marker does not turn TAINTED into INCONCLUSIVE', async () => {
  const g = grant()
  // 80 marker triples: a query without DISTINCT returns 80 x 80 = 6400 rows, past the 5000-row limit.
  const flood = ka({ cg: DERIVS_CG, publisher: STRANGER, quads: Array.from({ length: 80 }, (_, i) => ({ subject: `urn:x:${i}`, predicate: V.outputSha256, object: `"${SHA}"` })) })
  const r = await verify([grantKa(g), revocationKa(g.id), forgedActive(g.id), derivationKa(edgeFor(g.id)), flood])
  assert.equal(r.verdict, verifier.TAINTED)
})

test('R20: a stranger asset with more distinct state rows than a query holds denies service, never grants it', async () => {
  const g = grant()
  // Deliberate trade-off: discovery that overflows fails closed. 2600 distinct values, repeated in the merged view, pass 5000 rows.
  const s = 'urn:x:flood'
  const flood = ka({ cg: GRANTS_CG, publisher: STRANGER, quads: [
    { subject: s, predicate: V.stateOf, object: g.id },
    ...Array.from({ length: 2600 }, (_, i) => ({ subject: s, predicate: V.state, object: `"v${i}"` })),
  ] })
  const d = await render([grantKa(g), flood])
  assert.equal(d.permit, false)
  if (CURRENT) assert.equal(d.clause, 'read-inconsistent')
})

/* -------------------------------------------------------------------------- */
/* R5 / R7 — reads that used to fail open or lock up                          */
/* -------------------------------------------------------------------------- */

test('R7: a producer with more recorded renders than one query holds still enforces the ceiling', async () => {
  const g = grant({ maxSpendUsd: 5 })
  const other = grant()
  // A stranger's negative billedUsd rides along, so a reader with no row limit (v0.1.0) still has something to get wrong.
  const credit = ka({ cg: DERIVS_CG, publisher: STRANGER, quads: raw('urn:mandate:derivation:eeeeeeeeeeeeeeee:0000000000000002', [
    [RDF_TYPE, V.Derivation], [V.outputSha256, `"${'e'.repeat(64)}"`], [V.servedCapability, '"talking-head"'],
    [V.authorizedUnder, g.id], [V.billedUsd, `"-1000"${DEC}`],
  ]) })
  const derivs = [
    ...Array.from({ length: 750 }, (_, i) => derivationKa(edgeFor(other.id, { outputSha256: i.toString(16).padStart(64, '0'), billedUsd: 0.01 }))),
    derivationKa(edgeFor(g.id, { outputSha256: 'e'.repeat(64), billedUsd: 4.5 })),
    credit,
  ]
  const d = await render([grantKa(g), grantKa(other), ...derivs], req({ estimatedUsd: 1 }))
  assert.equal(d.permit, false)
  assert.equal(d.clause, 'spend-ceiling')
})

/* -------------------------------------------------------------------------- */
/* Contract 3 — a revocation typed as a grant as well                         */
/* -------------------------------------------------------------------------- */

for (const id of [`urn:mandate:grant:${ANA}:ana:00000000000000c9`, 'the grant id itself']) {
  test(`contract 3: Ana's revocation typed both GrantState and LikenessGrant, with ${id.startsWith('urn:') ? 'a grant-format id' : id}, refuses and taints`, async () => {
    const g = grant()
    const sid = id.startsWith('urn:') ? id : g.id
    const rev = ka({ cg: GRANTS_CG, publisher: ANA, quads: raw(sid, [
      [RDF_TYPE, V.GrantState], [RDF_TYPE, V.LikenessGrant], [V.stateOf, g.id], [V.state, '"revoked"'], [V.stateAuthor, did(ANA)], [V.stateAt, `"2026-09-13T10:00:00Z"${DT}`],
    ]) })
    const kas = [grantKa(g), rev, forgedActive(g.id), derivationKa(edgeFor(g.id))]
    const d = await render(kas)
    assert.equal(d.permit, false)
    if (CURRENT) assert.equal(d.clause, 'not-revoked')
    const v = await verify(kas)
    assert.equal(v.verdict, verifier.TAINTED)
    if (CURRENT) assert.equal(v.subStatus, 'REVOKED')
  })
}

/* -------------------------------------------------------------------------- */
/* Item 5 — a trusted producer's own record that does not parse               */
/* -------------------------------------------------------------------------- */

const strangerCredit = grantId => ka({ cg: DERIVS_CG, publisher: STRANGER, quads: raw('urn:mandate:derivation:eeeeeeeeeeeeeeee:0000000000000003', [
  [RDF_TYPE, V.Derivation], [V.outputSha256, `"${'e'.repeat(64)}"`], [V.servedCapability, '"talking-head"'],
  [V.authorizedUnder, grantId], [V.billedUsd, `"-1000"${DEC}`], [V.derivedAt, `"2026-09-13T11:00:00Z"${DT}`],
]) })
const withRows = (k, edit) => {
  k.contentRows = edit(k.contentRows)
  k.metaRows = k.metaRows.map(r => (r.p.endsWith('publicTripleCount') ? { ...r, o: `"${k.contentRows.length}"^^<http://www.w3.org/2001/XMLSchema#integer>` } : r))
  return k
}
const TRUSTED_REJECTED = {
  'a negative billedUsd': rows => rows.map(r => (r.p === V.billedUsd ? { ...r, o: `"-1000"${DEC}` } : r)),
  'a legacy id': rows => rows.map(r => ({ ...r, s: 'urn:mandate:derivation:legacy-1' })),
  'an id that does not match its hash': rows => rows.map(r => ({ ...r, s: 'urn:mandate:derivation:0000000000000000:0000000000000001' })),
  'no derivedAt': rows => rows.filter(r => r.p !== V.derivedAt),
  'two billedUsd values': rows => [...rows, { ...rows.find(r => r.p === V.billedUsd), o: `"0.1"${DEC}` }],
  'a string-typed billedUsd': rows => rows.map(r => (r.p === V.billedUsd ? { ...r, o: '"4.5"^^<http://www.w3.org/2001/XMLSchema#string>' } : r)),
  'no rdf:type': rows => rows.filter(r => r.p !== RDF_TYPE),
  'a later version\'s type': rows => rows.map(r => (r.p === RDF_TYPE ? { ...r, o: `${V.Derivation}V2` } : r)),
}

for (const [name, edit] of Object.entries(TRUSTED_REJECTED)) {
  test(`item 5: the trusted producer's $4.50 render recorded with ${name} still counts: ceiling refuses, file taints`, async () => {
    const g = grant({ maxSpendUsd: 5 })
    const sha = 'd'.repeat(64)
    const spent = () => withRows(derivationKa(edgeFor(g.id, { outputSha256: sha, billedUsd: 4.5 })), edit)
    const d = await render([grantKa(g), spent(), strangerCredit(g.id)], req({ estimatedUsd: 1 }))
    assert.equal(d.permit, false)
    if (CURRENT) {
      assert.equal(d.clause, 'spend-ceiling')
      assert.equal(d.spend.unknown, true)
    }
    assert.equal((await verify([grantKa(g), spent()], sha)).verdict, verifier.TAINTED)
    if (CURRENT) {
      const k = await knowledge([grantKa(g), spent()], { grantId: g.id })
      assert.equal(verifier.blastRadius(g.id, k.derivations, k.forgeries).unreadable, 1)
    }
  })
}

/* -------------------------------------------------------------------------- */
/* R5 / R6 / R19 / DKG-3 — reads that fail, and must not read as empty        */
/* -------------------------------------------------------------------------- */

const isPrefixRead = sparql => !sparql.includes('?m <') && !/^SELECT (DISTINCT )?\?g \?s( \?o \?v)? WHERE/.test(sparql)
/** A node whose answers pass through `fn(sparql, opts, inner)`; returning undefined keeps the real answer. */
const faulty = fn => inner => ({
  name: 'faulty', calls: inner.calls, subscriptions: inner.subscriptions, reconcile: inner.reconcile,
  queryJson: async (sparql, o) => (await fn(sparql, o, inner)) ?? inner.queryJson(sparql, o),
})

test('R5: the derivations graph answering empty once and then erroring does not read as no prior spend', async () => {
  const g = grant({ maxSpendUsd: 5 })
  const kas = [grantKa(g), derivationKa(edgeFor(g.id, { outputSha256: 'd'.repeat(64), billedUsd: 4.5 })), strangerCredit(g.id)]
  let calls = 0
  const fault = faulty(async (sparql, o) => {
    if (o.contextGraphId !== DERIVS_CG || !isPrefixRead(sparql)) return undefined
    if (++calls > 3) throw new Error('ECONNRESET')
    return sparql.includes('COUNT(DISTINCT ?g)') ? [{ n: '"0"^^<http://www.w3.org/2001/XMLSchema#integer>' }] : []
  })
  const d = await render(kas, req({ estimatedUsd: 1 }), { fault })
  assert.equal(d.permit, false)
  if (CURRENT) assert.equal(d.clause, 'read-inconsistent')
})

test('R6: state discovery that never answers does not skip the merged-view revocation it would have found', async () => {
  const g = grant()
  // The revocation exists only in this node's merged view, where only discovery can see it.
  // v0.1.0 reads no merged view: it has only the producer's forged "active" to get wrong.
  const kas = [grantKa(g), forgedActive(g.id), derivationKa(edgeFor(g.id))]
  const s = 'urn:mandate:state:00000000000000bb'
  const withView = node => Object.assign(node, { world: { ...node.world, [GRANTS_CG]: { ...node.world[GRANTS_CG],
    graphs: [{ graph: `did:dkg:context-graph:${GRANTS_CG}/context/1`, rows: [{ s, p: V.stateOf, o: g.id }, { s, p: V.state, o: '"revoked"' }] }] } } })
  const fault = node => faulty(async (sparql, o) => { if (o.view === 'verifiable-memory' && sparql.includes(V.stateOf)) throw new Error('timeout') })(withView(node))
  if (CURRENT) assert.equal((await render(kas, req(), { fault: withView })).clause, 'not-revoked', 'precondition: discovery that answers finds it')
  const d = await render(kas, req(), { fault })
  assert.equal(d.permit, false)
  if (CURRENT) assert.equal(d.clause, 'read-inconsistent')
})

test('R6: derivation discovery for a file that never answers is INCONCLUSIVE, not CLEAR', async () => {
  const g = grant()
  const kas = [grantKa(g), revocationKa(g.id), forgedActive(g.id), derivationKa(edgeFor(g.id))]
  const v = await verify(kas, SHA, NOW, { fault: faulty(async sparql => { if (sparql.includes('?m <')) throw new Error('timeout') }) })
  assert.notEqual(v.verdict, verifier.CLEAR)
  if (CURRENT) assert.equal(v.verdict, verifier.INCONCLUSIVE)
})

test('a revocation whose anchor never confirms in Ana\'s own prefix refuses rather than being set aside', async () => {
  const g = grant()
  const kas = [grantKa(g), revocationKa(g.id, { status: 'tentative' }), forgedActive(g.id)]
  const d = await render(kas)
  assert.equal(d.permit, false)
  if (CURRENT) assert.equal(d.clause, 'read-inconsistent')
})

test('a trusted render whose anchor never confirms in the producer\'s prefix does not vanish from spend', async () => {
  const g = grant({ maxSpendUsd: 5 })
  const kas = [grantKa(g), derivationKa(edgeFor(g.id, { outputSha256: 'd'.repeat(64), billedUsd: 4.5 }), { status: 'tentative' }), strangerCredit(g.id)]
  const d = await render(kas, req({ estimatedUsd: 1 }))
  assert.equal(d.permit, false)
  if (CURRENT) assert.equal(d.clause, 'read-inconsistent')
})

test('DKG-3: a failed reconcile is not a fresh node', async () => {
  const g = grant()
  const kas = [grantKa(g), revocationKa(g.id), forgedActive(g.id)]
  const { DkgHttpError } = CURRENT ? await import(`${SRC}dkg.mjs`) : {}
  const fault = node => Object.assign(node, { reconcile: async () => { throw new DkgHttpError('boom', { status: 500, body: { error: 'internal' } }) } })
  const d = await render(kas, req(), { fault, cfg: { checkFreshness: true } })
  assert.equal(d.permit, false)
  if (CURRENT) assert.equal(d.clause, 'read-inconsistent')
})

test('R19: a mis-cased derivations graph id on a node that cannot list subscriptions is not zero prior spend', async () => {
  const g = grant({ maxSpendUsd: 5 })
  const kas = [grantKa(g), derivationKa(edgeFor(g.id, { outputSha256: 'd'.repeat(64), billedUsd: 4.5 })), strangerCredit(g.id)]
  const { DkgHttpError } = CURRENT ? await import(`${SRC}dkg.mjs`) : {}
  const fault = node => Object.assign(node, {
    subscriptions: async () => { throw new DkgHttpError('boom', { status: 500 }) },
    reconcile: async () => { throw new DkgHttpError('forbidden', { status: 403, body: { error: 'admin token required' } }) },
  })
  const d = await render(kas, req({ estimatedUsd: 1 }), { fault, cfg: { derivationsCgs: [DERIVS_CG.toLowerCase()], trustedProducers: [PRODUCER], checkFreshness: true } })
  assert.equal(d.permit, false)
  if (CURRENT) assert.equal(d.clause, 'read-inconsistent')
})

/* -------------------------------------------------------------------------- */
/* D6 — cancelling a merged-view-only revocation with a borrowed subject IRI  */
/* -------------------------------------------------------------------------- */

const ORPHAN = 'urn:mandate:state:00000000000009b9'
/** This node's merged view holds a revocation of `grantId` under ORPHAN, with no Verifiable Memory copy anywhere. */
const orphanView = grantId => node => Object.assign(node, { world: { ...node.world, [GRANTS_CG]: { ...node.world[GRANTS_CG],
  graphs: [{ graph: `did:dkg:context-graph:${GRANTS_CG}/context/9`, rows: [{ s: ORPHAN, p: V.stateOf, o: grantId }, { s: ORPHAN, p: V.state, o: '"revoked"' }] }] } } })

test('D6: a stranger\'s Verifiable Memory state reusing the subject IRI does not cancel a merged-view-only revocation', async () => {
  const g = grant()
  // v0.1.0 reads no merged view: it has only the producer's forged "active" to get wrong.
  const base = [grantKa(g), forgedActive(g.id), derivationKa(edgeFor(g.id))]
  if (CURRENT) assert.equal((await render(base, req(), { fault: orphanView(g.id) })).clause, 'not-revoked', 'precondition: the view alone refuses')
  for (const value of ['active', 'revoked']) {
    const borrowed = ka({ cg: GRANTS_CG, publisher: STRANGER, quads: state(ORPHAN, g.id, value, STRANGER, '2026-09-13T11:00:00Z') })
    const d = await render([...base, borrowed], req(), { fault: orphanView(g.id) })
    assert.equal(d.permit, false, value)
    if (CURRENT) assert.equal(d.clause, 'not-revoked', value)
    assert.notEqual((await verify([...base, borrowed], SHA, NOW, { fault: orphanView(g.id) })).verdict, verifier.CLEAR, value)
  }
})

test('D6: a trusted producer\'s misplaced state reusing the subject IRI does not cancel a merged-view-only revocation', async () => {
  const g = grant()
  const borrowed = ka({ cg: DERIVS_CG, publisher: PRODUCER, quads: state(ORPHAN, g.id, 'active', ANA, '2026-09-13T11:00:00Z') })
  const d = await render([grantKa(g), forgedActive(g.id), borrowed], req(), { fault: orphanView(g.id) })
  assert.equal(d.permit, false)
  if (CURRENT) assert.equal(d.clause, 'not-revoked')
})

test('D6: another grantor\'s own state reusing the subject IRI does not cancel a merged-view-only revocation', async () => {
  const g = grant()
  const sams = grant({ owner: STRANGER, local: 'sam' })
  // Sam's own, genuine state about Sam's own grant, under the same IRI as the view row about Ana's grant.
  const samState = ka({ cg: GRANTS_CG, publisher: STRANGER, quads: state(ORPHAN, sams.id, 'active', STRANGER, '2026-09-13T11:00:00Z') })
  const kas = [grantKa(g), grantKa(sams, { publisher: STRANGER }), samState, forgedActive(g.id),
    derivationKa(edgeFor(g.id)), derivationKa(edgeFor(sams.id))]
  const v = await verify(kas, SHA, NOW, { fault: orphanView(g.id) })
  assert.equal(v.verdict, verifier.TAINTED)
})
