import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Q from '../src/queries.mjs'

const CG = '0xeD1eeB64CaC09874257F05Fd6B51A55695ad0B69/mandate-grants'
const ANA = '0xed1eeb64cac09874257f05fd6b51a55695ad0b69'

test('context graph ids and publisher addresses are validated before they reach SPARQL', () => {
  assert.throws(() => Q.cgIri('0xabc/x> } DROP ALL { <'), /invalid context graph id/)
  assert.throws(() => Q.vmPublisherPrefix(CG, 'not-an-address'), /invalid publisher/)
  assert.throws(() => Q.metaQuery(CG, { limit: 10, publisher: '0x12"' }), /invalid publisher/)
  assert.equal(Q.vmPublisherPrefix(CG, ANA.toUpperCase().replace('0X', '0x')), `did:dkg:context-graph:${CG}/_verifiable_memory/${ANA}/`)
})

test('every read asks for one row more than it will accept, so truncation is detectable', () => {
  const p = Q.vmPublisherPrefix(CG, ANA)
  for (const q of [Q.metaQuery(CG, { limit: 100 }), Q.prefixContentQuery(p, { limit: 100 }),
    Q.stateSubjectsQuery(CG, [`urn:mandate:grant:${ANA}:ana:0000000000000001`], { limit: 100 }),
    Q.grantSubjectsQuery(CG, `${ANA}:ana`, { limit: 100 })]) {
    assert.match(q, /LIMIT 101$/)
  }
})

test('the publisher-scoped meta read filters on the UAL path', () => {
  assert.match(Q.metaQuery(CG, { limit: 1, publisher: ANA }), new RegExp(`CONTAINS\\(LCASE\\(STR\\(\\?s\\)\\), "/${ANA}/"\\)`))
  assert.doesNotMatch(Q.metaQuery(CG, { limit: 1 }), /CONTAINS/)
})

test('ids and hashes that would break out of an IRI or literal are refused', () => {
  const p = Q.vmPublisherPrefix(CG, ANA)
  assert.throws(() => Q.stateSubjectsQuery(CG, ['urn:mandate:grant:x> } . { ?a ?b ?c'], { limit: 1 }), /safe IRI/)
  assert.throws(() => Q.stateSubjectsQuery(CG, [], { limit: 1 }), /at least one/)
  assert.throws(() => Q.derivationsBySha256Query(p, 'F'.repeat(64), { limit: 1 }), /sha256/)
  assert.throws(() => Q.metaForUalsQuery(CG, ['did:dkg:base:84532/x> ?p ?o'], { limit: 1 }), /valid UALs/)
})

test('prefix and _meta reads are ordered and paged, so a large publisher can be read in full', () => {
  const p = Q.vmPublisherPrefix(CG, ANA)
  for (const build of [o => Q.prefixContentQuery(p, o), o => Q.metaQuery(CG, { ...o, publisher: ANA })]) {
    assert.match(build({ limit: 100 }), /ORDER BY \?\w+ \?\w+ \?\w+( \?\w+)? LIMIT 101$/)
    assert.match(build({ limit: 100, offset: 300 }), /ORDER BY .* LIMIT 101 OFFSET 300$/)
    assert.throws(() => build({ limit: 100, offset: -1 }), /invalid query offset/)
    assert.throws(() => build({ limit: 0 }), /invalid query limit/)
  }
})

test('discovery queries are DISTINCT, so repeated marker triples cannot multiply rows', () => {
  const p = Q.vmPrefix(CG)
  assert.match(Q.derivationsBySha256Query(p, 'a'.repeat(64), { limit: 1 }), /^SELECT DISTINCT \?g \?s \?p \?o/)
  assert.match(Q.derivationsByGrantQuery(p, `urn:mandate:grant:${ANA}:ana:0000000000000001`, { limit: 1 }), /^SELECT DISTINCT/)
  assert.match(Q.stateSubjectsQuery(CG, [`urn:mandate:grant:${ANA}:ana:0000000000000001`], { limit: 1 }), /^SELECT DISTINCT \?g \?s \?o \?v/)
  assert.match(Q.grantSubjectsQuery(CG, `${ANA}:ana`, { limit: 1 }), /^SELECT DISTINCT \?g \?s/)
})
