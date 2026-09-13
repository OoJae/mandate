import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Parser } from 'n3'
import { grantToTurtle, UnpublishableLiteralError, setDkgSafe } from '../src/rdf.mjs'
import * as V from '../src/vocab.mjs'

const withTranscript = transcript => ({
  id: 'urn:mandate:grant:t', grantor: 'did:dkg:agent:0xA', subject: 's',
  consentTranscript: transcript, permitsCapability: ['talking-head'],
})

test('a literal DKG v10 cannot publish is refused with the field named, not rewritten', () => {
  for (const bad of ['I consent to "advertising"', 'line one\nline two', 'carriage\rreturn']) {
    assert.throws(() => grantToTurtle(withTranscript(bad)),
      e => e instanceof UnpublishableLiteralError && /consentTranscript/.test(e.message))
  }
})

test('characters the node does accept pass through and round-trip', () => {
  const ok = 'It’s “fine”\twith tabs, backslashes \\ and apostrophes'
  const q = new Parser().parse(grantToTurtle(withTranscript(ok))).find(x => x.predicate.value === V.consentTranscript)
  assert.equal(q.object.value, ok)
})

test('with the DKG guard off, quotes and line breaks are escaped as valid Turtle', () => {
  setDkgSafe(false)
  try {
    const text = 'I consent to "advertising"\nin GB'
    const ttl = grantToTurtle(withTranscript(text))
    for (const m of ttl.matchAll(/"((?:[^"\\]|\\.)*)"/g)) assert.ok(!/[\r\n]/.test(m[1]))
    const q = new Parser().parse(ttl).find(x => x.predicate.value === V.consentTranscript)
    assert.equal(q.object.value, text)
  } finally {
    setDkgSafe(true)
  }
})
