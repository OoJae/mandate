/**
 * Compare what a person said against what is about to be granted.
 *
 * This surfaces mismatches for a human; it does not decide consent. It is
 * deliberately literal: whole words and a short alias table, never "close
 * enough". Three outcomes per term:
 *
 *   matched       the term (or an alias) was said, not negated
 *   missing       it was never said — the operator may re-record, narrow the
 *                 grant, or knowingly override with --force
 *   contradicted  it was said in a negated clause ("not for advertising",
 *                 "anything except the UK") — never overridable
 *
 * Negation is judged within a clause: text is split at sentence punctuation and
 * at "but", "except", "however" and "although", so "ads, but not political" negates
 * only "political".
 */

const CONSENT = ['consent', 'agree', 'authorise', 'authorize', 'permission', 'allow', 'permit', 'approve', 'happy for', 'give my permission']

const USE_CLASS_ALIASES = {
  advertising: ['advertising', 'advertisement', 'advertisements', 'advert', 'adverts', 'ads', 'ad', 'commercial', 'commercials', 'marketing'],
  political: ['political', 'politics', 'campaign', 'campaigns', 'election', 'elections'],
  entertainment: ['entertainment', 'film', 'films', 'movie', 'movies', 'tv', 'television', 'show', 'shows'],
  education: ['education', 'educational', 'training', 'teaching'],
  editorial: ['editorial', 'news', 'journalism'],
  internal: ['internal', 'internal use', 'in house'],
}

const CAPABILITY_ALIASES = {
  'talking-head': ['talking head', 'talking heads', 'avatar', 'video of me talking', 'video of me speaking'],
  'sync-lipsync-v3': ['lip sync', 'lipsync', 'lip syncing', 'dub', 'dubbing', 'dubbed'],
  lipsync: ['lip sync', 'lipsync', 'lip syncing', 'dub', 'dubbing', 'dubbed'],
  'face-swap-image': ['face swap', 'faceswap', 'swap my face', 'face swapping'],
  'face-swap-video': ['face swap', 'faceswap', 'swap my face', 'face swapping'],
  'heygen-twin': ['digital twin', 'twin', 'avatar'],
}

// Two-letter codes that are also everyday words are never matched as codes.
const TERRITORY_EXTRA = { GB: ['uk', 'u k', 'britain', 'great britain', 'the united kingdom'], US: ['usa', 'u s', 'u s a', 'america', 'the united states'] }
const SAFE_CODE_TOKENS = new Set(['gb', 'uk', 'usa', 'uae'])

const NEGATORS = ['not', 'no', 'never', 'without', 'refuse', 'deny', 'except', 'excluding', 'exclude', 'nor', 'cannot', 'forbid', 'prohibit', 'dont', 'wont', 'withdraw', 'revoke']
const NOT_NEGATING = ['do not mind', 'dont mind', 'not only', 'no problem', 'not a problem', 'no objection', 'no objections', 'without hesitation']

const regionNames = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }) } catch { return null }
})()

/** Lowercase, expand contractions, and reduce to space-separated words. */
export function normalise(text) {
  return ` ${String(text ?? '').toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/\b(do|does|did|is|are|was|were|could|would|should|have|has|had)n't\b/g, '$1 not')
    .replace(/\bwon't\b/g, 'will not').replace(/\bcan't\b/g, 'can not').replace(/\bcannot\b/g, 'can not')
    .replace(/[^a-z0-9.;!?,]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `
}

function aliasesFor(kind, term) {
  const words = String(term).toLowerCase().replace(/-/g, ' ')
  if (kind === 'use') return [...new Set([...(USE_CLASS_ALIASES[term] ?? []), words])]
  if (kind === 'capability') return [...new Set([...(CAPABILITY_ALIASES[term] ?? []), words])]
  if (kind === 'territory') {
    const code = String(term).toUpperCase()
    const name = regionNames?.of(code)
    const list = [...(TERRITORY_EXTRA[code] ?? [])]
    if (name && name !== code) list.push(name.toLowerCase(), `the ${name.toLowerCase()}`)
    if (SAFE_CODE_TOKENS.has(code.toLowerCase())) list.push(code.toLowerCase())
    return [...new Set(list)]
  }
  return [words]
}

/**
 * Where a phrase occurs in a clause, and whether a negator governs it. A
 * negator reaches back at most six words and never across a comma.
 */
function occurrences(clauseText, phrase) {
  const found = []
  const needle = ` ${phrase} `
  const plain = clauseText.replace(/,/g, ' ')
  let at = plain.indexOf(needle)
  while (at !== -1) {
    const before = clauseText.slice(0, at + 1)
    const window = ` ${before.slice(before.lastIndexOf(',') + 1).trim().split(' ').slice(-6).join(' ')} `
    const guarded = NOT_NEGATING.some(p => window.includes(` ${p} `))
    found.push({ negated: !guarded && NEGATORS.some(n => window.includes(` ${n} `)) })
    at = plain.indexOf(needle, at + 1)
  }
  return found
}

/**
 * A term is contradicted if any mention is negated, sits after "except" or
 * "excluding", or shares a clause with a refusal of consent itself.
 */
function judge(parts, phrases, term, kind) {
  let matched = false
  let contradicted = false
  const heard = new Set()
  for (const clause of parts) {
    for (const phrase of phrases) {
      for (const o of occurrences(clause.text, phrase)) {
        heard.add(phrase)
        if (o.negated || clause.excluded || clause.refused) contradicted = true
        else matched = true
      }
    }
  }
  return { term, kind, matched: matched && !contradicted, contradicted, heard: [...heard] }
}

/**
 * @param {string} transcript
 * @param {{ useClass?: string[], territory?: string[], capability?: string[] }} requested
 */
export function checkSpokenScope(transcript, requested = {}) {
  const norm = normalise(transcript)
  // Split into clauses, remembering which follow an exclusion word.
  const raw = norm.split(/([.;!?]| but | except | however | although | excluding )/)
  const parts = []
  let excluded = false
  for (const piece of raw) {
    if (/^( except | excluding )$/.test(piece)) { excluded = true; continue }
    if (/^([.;!?]| but | however | although )$/.test(piece)) { excluded = false; continue }
    if (piece.trim()) parts.push({ text: ` ${piece.replace(/\s*,\s*/g, ' , ').replace(/\s+/g, ' ').trim()} `, excluded })
  }

  for (const p of parts) p.refused = CONSENT.some(phrase => occurrences(p.text, phrase).some(o => o.negated))
  const checks = [judge(parts, CONSENT, 'consent', 'consent')]
  for (const c of requested.capability ?? []) checks.push(judge(parts, aliasesFor('capability', c), c, 'capability'))
  for (const u of requested.useClass ?? []) checks.push(judge(parts, aliasesFor('use', u), u, 'use'))
  for (const t of requested.territory ?? []) checks.push(judge(parts, aliasesFor('territory', t), t, 'territory'))

  const contradicted = checks.filter(c => c.contradicted).map(c => c.term)
  const missing = checks.filter(c => !c.matched && !c.contradicted).map(c => c.term)
  return {
    checks,
    missing,
    contradicted,
    covered: checks.filter(c => c.matched).length,
    total: checks.length,
    empty: norm.trim().length === 0,
    note: contradicted.length
      ? `spoken consent CONTRADICTS: ${contradicted.join(', ')} — this cannot be granted`
      : missing.length
        ? `spoken consent does not mention: ${missing.join(', ')} — review before granting`
        : 'spoken consent mentions every requested term',
  }
}

/** A plain script for the person to read, generated from the grant's clauses. */
export function consentScript({ capability = [], useClass = [], territory = [], validUntil, maxSpendUsd } = {}) {
  const list = xs => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`)
  const caps = capability.map(c => (CAPABILITY_ALIASES[c]?.[0] ?? c.replace(/-/g, ' ')))
  const places = territory.map(t => regionNames?.of(t.toUpperCase()) ?? t)
  const parts = [`I consent to ${list(caps) || 'generated media'} of my likeness`]
  if (useClass.length) parts.push(`for ${list(useClass)}`)
  if (places.length) parts.push(`in ${list(places)}`)
  if (validUntil) parts.push(`until ${new Date(validUntil).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}`)
  let script = `${parts.join(' ')}.`
  if (maxSpendUsd != null) script += ` Spending is capped at ${maxSpendUsd} US dollars.`
  return script
}
