/**
 * RDF terms: the one place that parses what a DKG node returns and validates
 * what Mandate writes.
 *
 * Writer and reader share these functions on purpose. If they disagreed — the
 * writer accepting "1e3" as a decimal that the reader then rejects — a grant
 * could be anchored on-chain, paid for, and read back as malformed forever.
 */
import { randomBytes } from 'node:crypto'

export const XSD = 'http://www.w3.org/2001/XMLSchema#'

export class TermError extends Error {}
export class InvalidIriError extends TermError {}

/**
 * DKG v10.0.16 cannot publish a literal containing a double quote or a line
 * break, however it is escaped: the node unescapes its input, re-serialises to
 * N-Quads without re-escaping, and fails to parse its own output (probe table in
 * docs/SPIKES.md). Refusing gives a clear error naming the field instead of an
 * opaque node failure, and never silently rewrites someone's words.
 */
export class UnpublishableLiteralError extends TermError {}

const MAX_CELL = 4096

const DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/
const INTEGER = /^(0|[1-9]\d*)$/
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const AGENT_DID = /^did:dkg:agent:(0x[0-9a-fA-F]{40})$/
const SUBJECT = /^(0x[0-9a-f]{40}):([a-z0-9][a-z0-9-]{0,62})$/
const SHA256 = /^[0-9a-f]{64}$/
// Characters N-Triples forbids inside <IRI>, plus whitespace.
const SAFE_IRI = /^(?:urn:[a-z0-9][a-z0-9-]{0,31}:|did:[a-z0-9]+:|https?:\/\/)[^\s<>"{}|\\^`]+$/i

/* ------------------------------------------------------------------------- */
/* Reading /api/query cells                                                   */
/* ------------------------------------------------------------------------- */

function unescapeLiteral(body) {
  return body.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|["\\nrtbf'])/g, (_, e) => {
    switch (e[0]) {
      case 'n': return '\n'
      case 'r': return '\r'
      case 't': return '\t'
      case 'b': return '\b'
      case 'f': return '\f'
      case '"': return '"'
      case "'": return "'"
      case '\\': return '\\'
      default: return String.fromCodePoint(parseInt(e.slice(1), 16))
    }
  })
}

/**
 * Normalise one binding cell to {type, value, datatype, lang}.
 *
 * The daemon returns cells as bare strings — IRIs unbracketed, literals quoted
 * with an optional ^^<datatype> or @lang suffix — or as SPARQL-JSON objects.
 * Anything that fits neither shape comes back as type 'invalid' so callers can
 * reject the row rather than guess.
 */
export function parseCell(cell) {
  if (cell === null || cell === undefined) return null
  if (typeof cell === 'object') {
    // Already a parsed term.
    if (cell.type === 'iri' || cell.type === 'invalid') return cell
    const value = cell.value === undefined || cell.value === null ? '' : String(cell.value)
    if (value.length > MAX_CELL) return { type: 'invalid', value: value.slice(0, 64) }
    // SPARQL-JSON uses 'uri' and 'typed-literal'; parsed terms use 'iri'.
    if (cell.type === 'uri') return { type: 'iri', value }
    if (cell.type === 'bnode') return { type: 'bnode', value }
    if (cell.type === 'literal' || cell.type === 'typed-literal') {
      return { type: 'literal', value, datatype: cell.datatype ?? null, lang: cell.lang ?? cell['xml:lang'] ?? null }
    }
    return { type: 'invalid', value: value.slice(0, 64) }
  }
  const s = String(cell)
  if (s.length > MAX_CELL) return { type: 'invalid', value: s.slice(0, 64) }
  if (s.startsWith('"')) {
    let i = 1
    for (; i < s.length; i++) {
      if (s[i] === '\\') { i++; continue }
      if (s[i] === '"') break
    }
    if (i >= s.length) return { type: 'invalid', value: s.slice(0, 64) }
    const value = unescapeLiteral(s.slice(1, i))
    const rest = s.slice(i + 1)
    if (rest === '') return { type: 'literal', value, datatype: null, lang: null }
    const dt = rest.match(/^\^\^<([^>]+)>$/)
    if (dt) return { type: 'literal', value, datatype: dt[1], lang: null }
    const lang = rest.match(/^@([a-zA-Z]+(?:-[a-zA-Z0-9]+)*)$/)
    if (lang) return { type: 'literal', value, datatype: null, lang: lang[1] }
    return { type: 'invalid', value: s.slice(0, 64) }
  }
  if (s.startsWith('_:')) return { type: 'bnode', value: s.slice(2) }
  if (s.startsWith('<') && s.endsWith('>')) return { type: 'iri', value: s.slice(1, -1) }
  return { type: 'iri', value: s }
}

export function asIri(cell) {
  const t = parseCell(cell)
  return t?.type === 'iri' ? t.value : null
}

export function asString(cell) {
  const t = parseCell(cell)
  if (t?.type !== 'literal') return null
  if (t.datatype && t.datatype !== `${XSD}string`) return null
  return t.value
}

function literalLexical(cell, allowedTypes) {
  const t = parseCell(cell)
  if (t?.type !== 'literal') return null
  if (t.datatype && !allowedTypes.includes(t.datatype)) return null
  return t.value
}

/** Strict non-negative decimal. Anything else — "1e3", "-1", " ", "0x10" — is NaN. */
export function asDecimal(cell) {
  let v
  if (typeof cell === 'number') v = Number.isFinite(cell) && cell >= 0 ? formatDecimal(cell) : null
  else if (typeof cell === 'string' && DECIMAL.test(cell)) v = cell
  else v = literalLexical(cell, [`${XSD}decimal`, `${XSD}integer`])
  return v !== null && DECIMAL.test(v) ? Number(v) : NaN
}

/** Plain positional notation; never exponent form, trailing zeros only trimmed after the point. */
function formatDecimal(n) {
  let s = n.toFixed(6)
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  return s
}

export function asInteger(cell) {
  const v = literalLexical(cell, [`${XSD}integer`, `${XSD}nonNegativeInteger`, `${XSD}long`])
  return v !== null && INTEGER.test(v) ? Number(v) : NaN
}

/** ISO-8601 with an explicit offset, as epoch milliseconds; otherwise NaN. */
export function asDateTime(cell) {
  const v = typeof cell === 'string' && !cell.startsWith('"') ? cell : literalLexical(cell, [`${XSD}dateTime`])
  return v !== null && DATETIME.test(v) ? Date.parse(v) : NaN
}

/* ------------------------------------------------------------------------- */
/* Identities                                                                 */
/* ------------------------------------------------------------------------- */

export function normAddress(address) {
  return typeof address === 'string' && ADDRESS.test(address) ? address.toLowerCase() : null
}

/** did:dkg:agent:0x… → lowercase address, else null. */
export function agentAddress(did) {
  const m = typeof did === 'string' ? did.match(AGENT_DID) : null
  return m ? m[1].toLowerCase() : null
}

/**
 * Self-certifying subjects: `0x<address>:<local>`. Only that address can publish
 * grants or revocations for the subject, so claiming someone else's subject is
 * not a matter of writing the right string.
 */
export function subjectAddress(subject) {
  const m = typeof subject === 'string' ? subject.match(SUBJECT) : null
  return m ? m[1] : null
}

export function isSubject(subject) {
  return subjectAddress(subject) !== null
}

export function makeSubject(address, local) {
  const a = normAddress(address)
  const subject = `${a}:${String(local).toLowerCase()}`
  if (!a || !SUBJECT.test(subject)) {
    throw new TermError(`invalid subject: address ${address}, local part ${JSON.stringify(local)} `
      + '(local part: lowercase letters, digits and hyphens, up to 63 characters)')
  }
  return subject
}

export function isSha256(value) {
  return typeof value === 'string' && SHA256.test(value)
}

export function normSha256(value) {
  return typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() : null
}

export function isSafeIri(value) {
  return typeof value === 'string' && value.length <= 512 && SAFE_IRI.test(value)
}

export function assertSafeIri(value, field = 'iri') {
  if (!isSafeIri(value)) throw new InvalidIriError(`${field} is not a safe IRI: ${JSON.stringify(String(value).slice(0, 80))}`)
  return value
}

export function nonce16() {
  return randomBytes(8).toString('hex')
}

/* ------------------------------------------------------------------------- */
/* Writing wire terms                                                         */
/* ------------------------------------------------------------------------- */

export function iriTerm(value, field) {
  return assertSafeIri(value, field)
}

export function literalTerm(value, { field = 'value', datatype = null, dkgSafe = true } = {}) {
  const str = String(value)
  if (dkgSafe && /["\r\n]/.test(str)) {
    throw new UnpublishableLiteralError(
      `${field} contains a double quote or line break, which DKG v10 cannot publish: ${JSON.stringify(str.slice(0, 60))}`)
  }
  const escaped = str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return datatype ? `"${escaped}"^^<${datatype}>` : `"${escaped}"`
}

/** Serialise a decimal the reader will accept, or throw. */
export function decimalTerm(value, field = 'decimal') {
  let lexical
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new TermError(`${field} must be a finite number >= 0, got ${value}`)
    lexical = formatDecimal(value)
  } else if (typeof value === 'string' && DECIMAL.test(value)) {
    lexical = value
  } else {
    // Strings like "1e3", "-1", " 5" or "0x10" are refused rather than coerced:
    // the reader would reject them, and a silent reinterpretation of a spend
    // ceiling is exactly the kind of error that must never reach the chain.
    throw new TermError(`${field} must be a plain non-negative decimal like 5 or 4.25, got ${JSON.stringify(value)}`)
  }
  return literalTerm(lexical, { field, datatype: `${XSD}decimal` })
}

/** Serialise a dateTime the reader will accept, normalised to UTC, or throw. */
export function dateTimeTerm(value, field = 'dateTime') {
  const ms = value instanceof Date ? value.getTime() : asDateTime(String(value))
  if (!Number.isFinite(ms)) {
    throw new TermError(`${field} must be ISO-8601 with an explicit offset (e.g. 2026-12-31T23:59:00Z), got ${JSON.stringify(value)}`)
  }
  return literalTerm(new Date(ms).toISOString(), { field, datatype: `${XSD}dateTime` })
}

/** Render one wire term as N-Triples / Turtle. */
export function ntriplesTerm(term) {
  return term.startsWith('"') ? term : `<${term}>`
}
