import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Parser } from 'n3'
import {
  grantToQuads, grantToTurtle, stateToQuads, derivationToQuads, quadsToNTriples,
  UnpublishableLiteralError, InvalidIriError, TermError,
} from '../src/rdf.mjs'
import { asDecimal, asDateTime, parseCell } from '../src/rdf-term.mjs'
import * as V from '../src/vocab.mjs'

const ANA = '0xed1eeb64cac09874257f05fd6b51a55695ad0b69'
const ANA_DID = `did:dkg:agent:${ANA}`
const grant = (over = {}) => ({
  id: `urn:mandate:grant:${ANA}:ana:0123456789abcdef`,
  grantor: ANA_DID,
  subject: `${ANA}:ana`,
  permitsCapability: ['talking-head'],
  permitsUseClass: ['advertising'],
  forbidsUseClass: ['political'],
  territory: ['GB'],
  validFrom: '2026-09-01T00:00:00Z',
  validUntil: '2026-12-01T00:00:00Z',
  maxSpendUsd: 5,
  ...over,
})

test('grant quads use bare IRIs and typed N-Triples literals', () => {
  const quads = grantToQuads(grant())
  const ceiling = quads.find(x => x.predicate === V.maxSpendUsd)
  assert.equal(ceiling.object, '"5"^^<http://www.w3.org/2001/XMLSchema#decimal>')
  assert.equal(quads.find(x => x.predicate === V.grantor).object, ANA_DID)
})

test('everything the writer emits, the shared reader accepts unchanged', () => {
  const quads = grantToQuads(grant({ maxSpendUsd: 1000, validUntil: '2026-12-01T00:00:00+02:00' }))
  assert.equal(asDecimal(quads.find(x => x.predicate === V.maxSpendUsd).object), 1000)
  assert.equal(asDateTime(quads.find(x => x.predicate === V.validUntil).object), Date.parse('2026-11-30T22:00:00Z'))
  for (const x of quads) assert.notEqual(parseCell(x.object).type, 'invalid', x.object)
})

test('Turtle output is derived from the quads and round-trips through an RDF parser', () => {
  const parsed = new Parser().parse(grantToTurtle(grant()))
  assert.equal(parsed.length, grantToQuads(grant()).length)
  assert.equal(parsed.find(x => x.predicate.value === V.subject).object.value, `${ANA}:ana`)
})

test('a subject must belong to the grantor that publishes the grant', () => {
  assert.throws(() => grantToQuads(grant({ subject: 'ana-7f3c' })), /self-certifying/)
  assert.throws(() => grantToQuads(grant({ subject: `0x${'1'.repeat(40)}:ana` })), /belongs to/)
})

test('ids are validated, so a crafted id cannot inject triples', () => {
  assert.throws(() => grantToQuads(grant({ id: 'urn:mandate:grant:x> <urn:evil:y' })), InvalidIriError)
  assert.throws(() => derivationToQuads({ id: 'urn:mandate:derivation:a', outputSha256: 'f'.repeat(64),
    servedCapability: 'talking-head', authorizedUnder: 'not an iri', derivedAt: '2026-09-13T00:00:00Z' }), InvalidIriError)
})

test('malformed clause values are refused before they can be anchored', () => {
  assert.throws(() => grantToQuads(grant({ maxSpendUsd: 'abc' })), TermError)
  assert.throws(() => grantToQuads(grant({ maxSpendUsd: -1 })), TermError)
  assert.throws(() => grantToQuads(grant({ validUntil: '2026-12-31T23:59' })), /explicit offset/)
  assert.throws(() => grantToQuads(grant({ validUntil: '2026-08-01T00:00:00Z' })), /later than validFrom/)
  assert.throws(() => grantToQuads(grant({ territory: ['gb'] })), /territory/)
  assert.throws(() => grantToQuads(grant({ permitsCapability: [] })), /at least one/)
  assert.throws(() => grantToQuads(grant({ permitsUseClass: ['ads', 'ads'] })), /twice/)
})

test('a consent transcript is never published without explicit opt-in', () => {
  assert.throws(() => grantToQuads(grant({ consentTranscript: 'I agree' })), /allowTranscript/)
  const quads = grantToQuads(grant({ consentTranscript: 'I agree' }), { allowTranscript: true })
  assert.ok(quads.some(x => x.predicate === V.consentTranscript))
})

test('literals the node cannot publish are refused; with the guard off they escape correctly', () => {
  assert.throws(() => grantToQuads(grant({ consentTranscript: 'I consent to "ads"' }), { allowTranscript: true }),
    e => e instanceof UnpublishableLiteralError && /consentTranscript/.test(e.message))
  const text = 'I consent to "ads"\nin GB'
  const quads = grantToQuads(grant({ consentTranscript: text }), { allowTranscript: true, dkgSafe: false })
  const parsed = new Parser().parse(quadsToNTriples(quads))
  assert.equal(parsed.find(x => x.predicate.value === V.consentTranscript).object.value, text)
})

test('only revocations are written, and revocation is terminal', () => {
  const quads = stateToQuads({ id: 'urn:mandate:state:0123456789abcdef', stateOf: grant().id, state: 'revoked',
    stateAuthor: ANA_DID, stateAt: '2026-09-13T10:00:00Z' })
  assert.equal(quads.find(x => x.predicate === V.state).object, '"revoked"')
  assert.throws(() => stateToQuads({ id: 'urn:mandate:state:1', stateOf: grant().id, state: 'active',
    stateAuthor: ANA_DID, stateAt: '2026-09-13T10:00:00Z' }), /only 'revoked'/)
})

test('a derivation stores the job id under the one key reconcile joins on', () => {
  const quads = derivationToQuads({ id: 'urn:mandate:derivation:ffffffffffffffff:0123456789abcdef', outputSha256: 'f'.repeat(64),
    servedCapability: 'sync-lipsync-v3', authorizedUnder: grant().id, derivedAt: '2026-09-13T00:00:00Z',
    jobId: 'mjob_abc', sessionId: 'ignored-when-jobId-present', billedUsd: 0.84 })
  assert.equal(quads.find(x => x.predicate === V.sessionId).object, '"mjob_abc"')
  assert.throws(() => derivationToQuads({ id: 'urn:mandate:derivation:a', outputSha256: 'F'.repeat(64),
    servedCapability: 'talking-head', authorizedUnder: grant().id, derivedAt: '2026-09-13T00:00:00Z' }), /lowercase hex/)
})
