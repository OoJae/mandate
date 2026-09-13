import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Parser } from 'n3'
import * as V from '../src/vocab.mjs'

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const ttl = readFileSync(new URL('../vocab/mandate.ttl', import.meta.url), 'utf8')
const quads = new Parser().parse(ttl)

const inCode = new Set(Object.entries(V)
  .filter(([k, v]) => k !== 'NS' && typeof v === 'string' && v.startsWith(V.NS))
  .map(([, v]) => v))
const inOntology = new Set(quads
  .filter(q => q.predicate.value === RDF_TYPE && q.subject.value.startsWith(V.NS))
  .map(q => q.subject.value))

test('every IRI the code writes is defined in the ontology', () => {
  const missing = [...inCode].filter(i => !inOntology.has(i))
  assert.deepEqual(missing, [], `defined in vocab.mjs but not in mandate.ttl: ${missing.join(', ')}`)
})

test('the ontology defines nothing the code does not use', () => {
  const extra = [...inOntology].filter(i => !inCode.has(i))
  assert.deepEqual(extra, [], `defined in mandate.ttl but not in vocab.mjs: ${extra.join(', ')}`)
})

test('the ontology and JSON-LD context use the code namespace', () => {
  assert.ok(ttl.includes(`@prefix mandate: <${V.NS}>`))
  const ctx = JSON.parse(readFileSync(new URL('../vocab/context.jsonld', import.meta.url), 'utf8'))
  assert.equal(ctx['@context'].mandate, V.NS)
  assert.equal(Object.keys(ctx['@context']).filter(k => !['@version', 'mandate', 'xsd'].includes(k)).length, inCode.size)
})

test('the published namespace documents are current', () => {
  // docs/ns/v1 is what GitHub Pages serves at the namespace IRI. If this fails,
  // run `node scripts/build-vocab-docs.mjs`.
  for (const f of ['mandate.ttl', 'context.jsonld']) {
    assert.equal(
      readFileSync(new URL(`../docs/ns/v1/${f}`, import.meta.url), 'utf8'),
      readFileSync(new URL(`../vocab/${f}`, import.meta.url), 'utf8'),
      `docs/ns/v1/${f} is stale`)
  }
})

test('every predicate and class the serialisers actually emit is defined in the ontology', async () => {
  const { grantToQuads, stateToQuads, derivationToQuads } = await import('../src/rdf.mjs')
  const A = '0xed1eeb64cac09874257f05fd6b51a55695ad0b69'
  const quads = [
    ...grantToQuads({ id: `urn:mandate:grant:${A}:ana:0000000000000001`, grantor: `did:dkg:agent:${A}`, subject: `${A}:ana`,
      consentClipSha256: 'a'.repeat(64), consentTranscript: 'I agree', permitsCapability: ['talking-head'], permitsUseClass: ['advertising'],
      forbidsUseClass: ['political'], territory: ['GB'], validFrom: '2026-09-01T00:00:00Z', validUntil: '2026-12-01T00:00:00Z', maxSpendUsd: 5 }, { allowTranscript: true }),
    ...stateToQuads({ id: 'urn:mandate:state:0000000000000001', stateOf: `urn:mandate:grant:${A}:ana:0000000000000001`, state: 'revoked', stateAuthor: `did:dkg:agent:${A}`, stateAt: '2026-09-02T00:00:00Z' }),
    ...derivationToQuads({ id: 'urn:mandate:derivation:aaaaaaaaaaaaaaaa:0000000000000001', outputSha256: 'a'.repeat(64), servedCapability: 'talking-head',
      servedModelId: 'm', loraId: 'l', jobId: 'mjob_x', authorizedUnder: `urn:mandate:grant:${A}:ana:0000000000000001`, billedUsd: 1, derivedAt: '2026-09-02T00:00:00Z' }),
  ]
  const emitted = new Set(quads.flatMap(q => [q.predicate, q.predicate === RDF_TYPE ? q.object : null]).filter(i => i && i.startsWith(V.NS)))
  const undefinedTerms = [...emitted].filter(i => !inOntology.has(i))
  assert.deepEqual(undefinedTerms, [])
})
