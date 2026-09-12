import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyKnowledge, CLEAR, TAINTED, UNKNOWN } from '../src/verify.mjs'
import { STATE_REVOKED, STATE_ACTIVE } from '../src/vocab.mjs'

const ANA = 'did:dkg:agent:0xANA'
const PROD = 'did:dkg:agent:0xPROD'
const SHA = 'f'.repeat(64)
const NOW = '2026-09-12T10:00:00Z'

const grant = (over = {}) => ({
  id: 'urn:mandate:grant:ana-001', grantor: ANA, subject: 'ana-7f3c',
  permitsCapability: ['talking-head'], permitsUseClass: ['advertising'],
  forbidsUseClass: [], territory: [],
  validFrom: '2026-09-01T00:00:00Z', validUntil: '2026-12-01T00:00:00Z',
  maxSpendUsd: 5, ...over,
})
const derivation = (over = {}) => ({
  id: 'urn:mandate:derivation:abc', outputSha256: SHA,
  servedCapability: 'talking-head', authorizedUnder: 'urn:mandate:grant:ana-001',
  billedUsd: 1.008, ...over,
})
const K = (over = {}) => ({ grants: [grant()], assertions: [], derivations: [derivation()], ...over })

test('CLEAR when the bytes trace to a live grant', () => {
  const r = verifyKnowledge(K(), SHA, { now: NOW })
  assert.equal(r.verdict, CLEAR)
  assert.equal(r.grantor, ANA)
})

test('UNKNOWN when the bytes are not in the graph at all', () => {
  const r = verifyKnowledge(K(), 'a'.repeat(64), { now: NOW })
  assert.equal(r.verdict, UNKNOWN)
  assert.match(r.reason, /no derivation edge/)
})

test('TAINTED once the authorising grant is revoked', () => {
  const r = verifyKnowledge(K({
    assertions: [{ stateOf: 'urn:mandate:grant:ana-001', state: STATE_REVOKED,
                   stateAuthor: ANA, stateAt: '2026-09-11T00:00:00Z' }],
  }), SHA, { now: NOW })
  assert.equal(r.verdict, TAINTED)
  assert.match(r.reason, /revoked/)
})

test('a forged "active" cannot launder an already-revoked file', () => {
  const r = verifyKnowledge(K({
    assertions: [
      { stateOf: 'urn:mandate:grant:ana-001', state: STATE_REVOKED, stateAuthor: ANA,  stateAt: '2026-09-11T00:00:00Z' },
      { stateOf: 'urn:mandate:grant:ana-001', state: STATE_ACTIVE,  stateAuthor: PROD, stateAt: '2026-09-11T12:00:00Z' },
    ],
  }), SHA, { now: NOW })
  assert.equal(r.verdict, TAINTED)
  assert.equal(r.ignoredForgeries.length, 1)
})

test('TAINTED when the derivation cites a grant absent from the graph', () => {
  const r = verifyKnowledge(K({ grants: [] }), SHA, { now: NOW })
  assert.equal(r.verdict, TAINTED)
  assert.match(r.reason, /not present in this graph/)
})

test('TAINTED when the serving capability was never permitted', () => {
  const r = verifyKnowledge(K({
    derivations: [derivation({ servedCapability: 'face-swap-video' })],
  }), SHA, { now: NOW })
  assert.equal(r.verdict, TAINTED)
  assert.match(r.reason, /never permitted/)
})

test('TAINTED once the grant has expired, even though it was valid at render time', () => {
  const r = verifyKnowledge(K(), SHA, { now: '2027-01-01T00:00:00Z' })
  assert.equal(r.verdict, TAINTED)
  assert.match(r.reason, /expired/)
})
