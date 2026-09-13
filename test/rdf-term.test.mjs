import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCell, asIri, asString, asDecimal, asInteger, asDateTime, agentAddress, subjectAddress,
  makeSubject, isSafeIri, literalTerm, decimalTerm, dateTimeTerm, normSha256, UnpublishableLiteralError,
  TermError, XSD,
} from '../src/rdf-term.mjs'

test('parses cells exactly as the live node returns them', () => {
  assert.deepEqual(parseCell('did:dkg:agent:0xed1eeb64cac09874257f05fd6b51a55695ad0b69'),
    { type: 'iri', value: 'did:dkg:agent:0xed1eeb64cac09874257f05fd6b51a55695ad0b69' })
  assert.deepEqual(parseCell('"confirmed"'), { type: 'literal', value: 'confirmed', datatype: null, lang: null })
  assert.deepEqual(parseCell(`"12"^^<${XSD}integer>`), { type: 'literal', value: '12', datatype: `${XSD}integer`, lang: null })
  assert.equal(parseCell('"hi"@en').lang, 'en')
})

test('accepts SPARQL-JSON cells too', () => {
  assert.equal(asIri({ type: 'uri', value: 'urn:x:y' }), 'urn:x:y')
  assert.equal(asDecimal({ type: 'literal', value: '5', datatype: `${XSD}decimal` }), 5)
})

test('unescapes N-Triples escapes inside literals', () => {
  assert.equal(asString(String.raw`"a\"b\\cA"`), 'a"b\\cA')
})

test('malformed cells come back invalid rather than guessed', () => {
  assert.equal(parseCell('"unterminated').type, 'invalid')
  assert.equal(parseCell('"x"junk').type, 'invalid')
  assert.equal(parseCell('"' + 'a'.repeat(5000) + '"').type, 'invalid')
})

test('an IRI is never read as a string, and a literal never as an IRI', () => {
  assert.equal(asString('did:dkg:agent:0xabc'), null)
  assert.equal(asIri('"did:dkg:agent:0xabc"'), null)
})

test('decimals are strict: exotic numerals are NaN, not coerced', () => {
  for (const ok of ['0', '5', '1.25', `"4"^^<${XSD}decimal>`]) assert.ok(Number.isFinite(asDecimal(ok)), ok)
  for (const bad of ['"1e3"', '"-1"', '" "', '"0x10"', '"01"', '"NaN"', '"Infinity"', `"5"^^<${XSD}string>`]) {
    assert.ok(Number.isNaN(asDecimal(bad)), bad)
  }
  assert.equal(asInteger(`"12"^^<${XSD}integer>`), 12)
  assert.ok(Number.isNaN(asInteger('"1.5"')))
})

test('dateTimes need an explicit offset; local-time strings are rejected', () => {
  assert.equal(asDateTime('2026-12-31T23:59:00Z'), Date.parse('2026-12-31T23:59:00Z'))
  assert.equal(asDateTime('2026-12-31T23:59:00+01:00'), Date.parse('2026-12-31T23:59:00+01:00'))
  for (const bad of ['2026-12-31T23:59', '2026-12-31', 'garbage', '--execute', '']) assert.ok(Number.isNaN(asDateTime(bad)), bad)
})

test('addresses are normalised to lowercase so case never splits an identity', () => {
  assert.equal(agentAddress('did:dkg:agent:0xeD1eeB64CaC09874257F05Fd6B51A55695ad0B69'), '0xed1eeb64cac09874257f05fd6b51a55695ad0b69')
  assert.equal(agentAddress('did:dkg:agent:nope'), null)
  assert.equal(normSha256('A'.repeat(64)), 'a'.repeat(64))
})

test('self-certifying subjects carry exactly one grantor address', () => {
  const s = makeSubject('0xeD1eeB64CaC09874257F05Fd6B51A55695ad0B69', 'Ana')
  assert.equal(s, '0xed1eeb64cac09874257f05fd6b51a55695ad0b69:ana')
  assert.equal(subjectAddress(s), '0xed1eeb64cac09874257f05fd6b51a55695ad0b69')
  for (const bad of ['ana-7f3c', '0xed1e:ana', '0xed1eeb64cac09874257f05fd6b51a55695ad0b69:', '0xed1eeb64cac09874257f05fd6b51a55695ad0b69:-ana',
    '0xED1EEB64CAC09874257F05FD6B51A55695AD0B69:ana']) assert.equal(subjectAddress(bad), null, bad)
  assert.throws(() => makeSubject('0xnot', 'ana'), TermError)
})

test('IRIs are validated so an id cannot inject extra triples', () => {
  assert.ok(isSafeIri('urn:mandate:grant:0xed1e:ana:0123456789abcdef'))
  assert.ok(isSafeIri('did:dkg:agent:0xed1eeb64cac09874257f05fd6b51a55695ad0b69'))
  for (const bad of ['urn:x:y> <urn:evil', 'urn:x:y z', 'javascript:alert(1)', 'urn:x:"y"', '']) assert.equal(isSafeIri(bad), false, bad)
})

test('the writer refuses literals the node cannot publish, naming the field', () => {
  assert.throws(() => literalTerm('say "hi"', { field: 'note' }), e => e instanceof UnpublishableLiteralError && /note/.test(e.message))
  assert.throws(() => literalTerm('a\nb'), UnpublishableLiteralError)
  assert.equal(literalTerm('tab\there'), '"tab\\there"')
})

test('writer and reader agree: every value the writer emits reads back identically', () => {
  for (const v of ['0', '5', '4.5', 1.008, 3]) assert.ok(Number.isFinite(asDecimal(decimalTerm(v))), String(v))
  // Regression: a trailing-zero trim once turned 1000 into "1", silently dividing a spend ceiling.
  for (const v of [1000, 10, '1000', 0.5]) assert.equal(asDecimal(decimalTerm(v)), Number(v), String(v))
  for (const bad of ['1e3', -1, NaN, 'abc', Infinity]) assert.throws(() => decimalTerm(bad), TermError, String(bad))
  const dt = dateTimeTerm('2026-12-31T23:59:00+02:00')
  assert.equal(asDateTime(dt), Date.parse('2026-12-31T21:59:00Z'))
  assert.throws(() => dateTimeTerm('2026-12-31T23:59'), TermError)
})
