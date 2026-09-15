import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('the spec page names the DKG-anchored copy as the fixed version, never a web path', () => {
  const page = readFileSync(new URL('../docs/ns/v1/index.html', import.meta.url), 'utf8')
  const anchored = JSON.parse(readFileSync(new URL('../docs/evidence/ontology-1.1.0.json', import.meta.url), 'utf8'))
  assert.ok(page.includes(anchored.ual), 'the 1.1.0 anchor UAL is on the page')
  assert.doesNotMatch(page, /fixed at <code>https?:/)
  const version = quads.find(q => q.predicate.value === 'http://www.w3.org/2002/07/owl#versionInfo').object.value
  if (version !== anchored.version) assert.match(page, new RegExp(`${version.replace(/\./g, '\\.')}.*not anchored`))
})

const RDFS = 'http://www.w3.org/2000/01/rdf-schema#'
const RDF_PROPERTY = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#Property'

/** Every term the ontology types, with the annotations it lacks: [iri, [missing]]. */
function undocumented(qs) {
  const typed = new Map()
  for (const q of qs) {
    if (q.predicate.value !== RDF_TYPE || !q.subject.value.startsWith(V.NS)) continue
    const kinds = typed.get(q.subject.value) ?? new Set()
    kinds.add(q.object.value)
    typed.set(q.subject.value, kinds)
  }
  const out = []
  for (const [iri, kinds] of typed) {
    const need = kinds.has(RDF_PROPERTY) ? ['label', 'comment', 'domain', 'range'] : ['label', 'comment']
    const missing = need.filter(n => {
      const values = qs.filter(q => q.subject.value === iri && q.predicate.value === `${RDFS}${n}`)
      if (values.length !== 1) return true
      const o = values[0].object
      return n === 'label' || n === 'comment' ? o.termType !== 'Literal' || !o.value.trim() || o.language !== 'en' : o.termType !== 'NamedNode'
    })
    if (missing.length) out.push([iri, missing])
  }
  return out
}

test('every property has one English label and comment, a domain and a range; every class a label and comment', () => {
  const properties = new Set(quads.filter(q => q.predicate.value === RDF_TYPE && q.object.value === RDF_PROPERTY).map(q => q.subject.value))
  assert.equal(properties.size, 28, 'README counts 28 properties')
  assert.equal([...inOntology].filter(i => !properties.has(i)).length, 4, 'README counts 4 classes')
  assert.deepEqual(undocumented(quads), [])
  // The check itself notices each missing annotation.
  const cut = ttl.replace(/(mandate:consentTranscript\n(?:.*\n)*?)    rdfs:range xsd:string \.\n/, '$1    rdfs:label "again"@en .\n')
  assert.notEqual(cut, ttl)
  assert.deepEqual(undocumented(new Parser().parse(cut)).map(([i, m]) => [i.slice(V.NS.length), m]), [['consentTranscript', ['label', 'range']]])
  const noComment = ttl.replace(/(mandate:Derivation\n    a rdfs:Class , owl:Class ;\n    rdfs:label "Derivation"@en) ;\n    rdfs:comment "[^"]*"@en \./, '$1 .')
  assert.notEqual(noComment, ttl)
  assert.deepEqual(undocumented(new Parser().parse(noComment)).map(([i, m]) => [i.slice(V.NS.length), m]), [['Derivation', ['comment']]])
})

test('scripts/publish-skill.mjs reads only Mandate keys from its env file ($MANDATE_HOME/.env), and says which it ignored', () => {
  const repo = new URL('..', import.meta.url).pathname
  const dir = mkdtempSync(join(tmpdir(), 'mandate-publish-skill-'))
  try {
    mkdirSync(join(dir, 'skills'))
    copyFileSync(join(repo, 'skills/likeness-consent.md'), join(dir, 'skills/likeness-consent.md'))
    // HOME is dir, so the default env file is dir/.mandate/.env; a working-directory .env is never read.
    mkdirSync(join(dir, '.mandate'))
    writeFileSync(join(dir, '.mandate', '.env'), 'NODE_TLS_REJECT_UNAUTHORIZED=0\nHTTPS_PROXY=http://127.0.0.1:9\nMANDATE_READ_MAX=10\n', { mode: 0o600 })
    const env = { PATH: process.env.PATH, HOME: dir }
    const r = spawnSync(process.execPath, [join(repo, 'scripts/publish-skill.mjs')], { cwd: dir, env, encoding: 'utf8', timeout: 30_000 })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const ignored = /^\.env: ignored (.*) \(only MANDATE_\* and LIVEPEER_AGENT_KEY are read\)$/m.exec(r.stdout)
    assert.ok(ignored, r.stdout)
    assert.deepEqual(ignored[1].split(', ').sort(), ['HTTPS_PROXY', 'NODE_TLS_REJECT_UNAUTHORIZED'])
    assert.match(r.stdout, new RegExp(`^env file: ${join(dir, '.mandate', '.env').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
    assert.match(r.stdout, /dry run/)
    assert.doesNotMatch(r.stderr, /NODE_TLS_REJECT_UNAUTHORIZED/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
