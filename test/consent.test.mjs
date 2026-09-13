import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkSpokenScope } from '../src/scope.mjs'
import { reconcile } from '../src/derivation.mjs'

test('spoken scope reports coverage rather than deciding', () => {
  const r = checkSpokenScope(
    'I consent to my likeness being used for advertising in the GB territory.',
    { useClass: ['advertising'], territory: ['GB'] })
  assert.equal(r.missing.length, 0)
  assert.match(r.note, /mentions every requested term/)
})

test('a term that was never spoken is surfaced, not silently accepted', () => {
  const r = checkSpokenScope(
    'I agree to my likeness being used for advertising.',
    { useClass: ['advertising', 'political'], territory: ['GB'] })
  assert.ok(r.missing.includes('political'))
  assert.ok(r.missing.includes('GB'))
  assert.match(r.note, /review before granting/)
})

test('a clip with no consent language at all is flagged', () => {
  const r = checkSpokenScope('Hello, testing one two three.', { useClass: [] })
  assert.ok(r.missing.includes('consent'))
})

test('reconcile flags a billed render with no derivation edge', () => {
  const r = reconcile({
    billedJobs: [{ jobId: 'mjob_a' }, { jobId: 'mjob_b' }],
    derivations: [{ jobId: 'mjob_a' }],
  })
  assert.equal(r.complete, false)
  assert.equal(r.orphans.length, 1)
  assert.match(r.note, /INCOMPLETE/)
})

test('reconcile passes when every billed render is recorded', () => {
  const r = reconcile({
    billedJobs: [{ jobId: 'mjob_a' }],
    derivations: [{ jobId: 'mjob_a' }],
  })
  assert.equal(r.complete, true)
})
