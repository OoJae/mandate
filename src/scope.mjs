/**
 * Compare what a person said against what is about to be granted.
 *
 * This surfaces mismatches for a human; it does not decide consent. It is
 * deliberately literal and deliberately suspicious: whole words, a short alias
 * table, and any sign of refusal counts against the grant. A false refusal
 * costs a re-recording; a false pass publishes a grant the person never gave,
 * so every rule below errs towards refusing. Three outcomes per term:
 *
 *   matched       said plainly, in a statement, with no refusal near it
 *   missing       never said, or only said in a question, a conditional or
 *                 reported speech — the operator may re-record, narrow the
 *                 grant, or knowingly override with --force
 *   contradicted  said in a clause that also carries a negation or exclusion
 *                 ("not for advertising", "anything but the UK", "advertising?
 *                 no.") — never overridable
 *
 * Consent itself needs an affirmative first-person clause: "I consent", "we
 * agree", "I give permission", "I authorise", "I allow", "I am happy for".
 * "Do I consent?", "I would consent if they paid me" and "he said I consent"
 * are not consent. Any refusal verb ("withhold", "decline", "object"...) or a
 * retraction ("just kidding") anywhere contradicts consent outright.
 *
 * Clauses are split at sentence punctuation and at "but", "however",
 * "although", "though" and "whereas" — never at commas, because a negation
 * distributes over a spoken list ("I do not consent to a talking head,
 * advertising or the UK").
 *
 * What the words are never compared with — the validity window, the spend
 * ceiling, and an empty territory list meaning "anywhere" — is returned in
 * `unchecked` so the caller can ask for explicit confirmation.
 */

const USE_CLASS_ALIASES = {
  // "campaign" is dropped from political (a marketing campaign is not political),
  // "show", "film" and bare "tv" from entertainment ("show my family", "film me",
  // "TV ads"), and "training" from education (it also means model training).
  advertising: ['advertising', 'advertisement', 'advertisements', 'advert', 'adverts', 'ads', 'ad', 'commercial', 'commercials', 'marketing'],
  political: ['political', 'politics', 'election', 'elections', 'political campaign', 'political campaigns'],
  entertainment: ['entertainment', 'films', 'movie', 'movies', 'tv show', 'tv shows', 'tv series', 'television show', 'television series'],
  education: ['education', 'educational', 'teaching'],
  editorial: ['editorial', 'news', 'journalism'],
  internal: ['internal', 'internal use', 'in house'],
}

// No alias is shared between two capabilities: "face swap" alone and "avatar"
// said nothing about which product was meant.
const CAPABILITY_ALIASES = {
  'talking-head': ['talking head', 'talking heads', 'video of me talking', 'video of me speaking'],
  'sync-lipsync-v3': ['lip sync', 'lipsync', 'lip syncing', 'dub', 'dubbing', 'dubbed'],
  lipsync: ['lip sync', 'lipsync', 'lip syncing', 'dub', 'dubbing', 'dubbed'],
  'face-swap-image': ['face swap image', 'face swap images', 'face swapped image', 'face swap photo', 'face swap picture'],
  'face-swap-video': ['face swap video', 'face swap videos', 'face swapped video'],
  'heygen-twin': ['digital twin'],
}

// Two-letter codes that are also everyday words are never matched as codes.
// "America" is not the United States: South America, Central America.
const TERRITORY_EXTRA = { GB: ['uk', 'u k', 'britain', 'great britain', 'the united kingdom'], US: ['usa', 'u s', 'u s a', 'the united states'] }
const SAFE_CODE_TOKENS = new Set(['gb', 'uk', 'usa', 'uae'])
// A place name after one of these is a different place: South Sudan, Northern
// Ireland, New Mexico, Papua New Guinea, American Samoa.
const TERRITORY_BLOCKED_BEFORE = new Set(['north', 'south', 'east', 'west', 'northern', 'southern', 'eastern', 'western', 'central', 'new', 'papua', 'equatorial', 'french', 'dutch', 'british', 'american', 'caribbean', 'latin', 'upper', 'lower', 'outer', 'inner', 'greater', 'lesser', 'st', 'saint', 'sint'])
const TERRITORY_BLOCKED_AFTER = new Set(['islands', 'island', 'isles', 'bissau', 'virgin', 'outlying', 'minor', 'city', 'state', 'states', 'province', 'county', 'territory', 'territories', 'sar',
  'dollar', 'dollars', 'pound', 'pounds', 'sterling', 'based', 'citizen', 'citizens', 'government', 'company'])

// Words whose presence anywhere in a clause makes every term in that clause
// contradicted, before or after the term, however far away.
const NEGATOR_WORDS = new Set([
  'not', 'no', 'never', 'nor', 'neither', 'none', 'nothing', 'nobody', 'noone', 'nowhere', 'nope', 'nah', 'without',
  'except', 'excepting', 'excluding', 'exclude', 'excludes', 'excluded', 'exclusion', 'exception', 'unless',
  'dont', 'wont', 'cant', 'didnt', 'doesnt', 'isnt', 'arent', 'wasnt', 'werent', 'shouldnt', 'wouldnt', 'couldnt', 'aint',
  'outside', 'besides', 'apart', 'aside', 'against', 'hate', 'dislike', 'ban', 'bans', 'banned', 'stop', 'avoid',
  'fear', 'afraid', 'worried', 'uncomfortable', 'unhappy', 'reluctant', 'hesitant', 'false', 'untrue', 'zero', 'forget',
])
// A negated clause with one of these ("not in France either") reaches back to the clause before it.
const ADDITIVE = new Set(['either', 'neither', 'nor', 'too', 'also', 'same'])
const NEGATOR_PHRASES = ['off limits', 'off the table', 'other than', 'rather than', 'instead of', 'no way', 'no one']
// Refusing consent itself: anywhere in the transcript, consent is contradicted.
const REFUSAL_STEMS = ['refus', 'withh', 'declin', 'reject', 'object', 'oppos', 'withdr', 'revok', 'revoc', 'deny', 'denie', 'denial', 'veto', 'disagree', 'disapprov', 'dissent', 'unwilling', 'forbid', 'forbad', 'prohibit', 'disallow']
const RETRACTIONS = ['kidding', 'joking', 'joke', 'jk', 'lying', 'lied', 'sarcastic', 'sarcasm', 'pretend', 'pretending', 'pretended',
  'take that back', 'take it back', 'scratch that', 'change my mind', 'changed my mind', 'forget it', 'forget that', 'never mind', 'nevermind', 'disregard', 'cancel', 'not serious']
// Phrases that contain a negator but do not negate. Only the phrase's own words
// are removed; any other negator in the clause still counts ("I don't mind no ads").
const NOT_NEGATING = ['would not mind', 'do not mind', 'dont mind', 'not mind', 'not only', 'no problem', 'no problems', 'not a problem', 'no objection', 'no objections',
  'without hesitation', 'without reservation', 'nothing else', 'nowhere else', 'noone else', 'nobody else', 'no other purpose', 'no other use', 'no other uses', 'no more than', 'not more than', 'no later than', 'not later than', 'not to exceed', 'not exceeding', 'no longer than']

// A sentence with any of these is a question, a conditional or reported speech:
// it can neither give consent nor satisfy a term.
const HEDGE_WORDS = new Set(['if', 'provided', 'providing', 'assuming', 'suppose', 'supposing', 'whether', 'would', 'could', 'might', 'maybe', 'perhaps', 'possibly', 'probably', 'hypothetically', 'imagine', 'before', 'once',
  'said', 'say', 'says', 'saying', 'told', 'tell', 'tells', 'telling', 'ask', 'asks', 'asked', 'asking', 'claim', 'claims', 'claimed', 'quote', 'quoting', 'according', 'supposedly', 'apparently', 'reportedly', 'allegedly',
  'think', 'thinks', 'thought', 'believe', 'believes', 'guess', 'wonder', 'heard', 'rumour', 'rumor'])
const HEDGE_PHRASES = ['as long as', 'so long as', 'in case', 'on condition', 'only when', 'want me to', 'wants me to', 'wanted me to', 'is what', 'was what', 'expect me to']
const QUESTION_OPENERS = /^ (do|does|did|can|could|would|will|shall|should|may|might|must|is|are|am|was|were|have|has) (i|we|you|they|he|she|it|this|that) /

// Consent words, used to recognise a refusal of consent ("I do not consent").
const CONSENT_WORDS = /\b(consent\w*|agree\w*|permission\w*|authori[sz]\w*|allow\w*|permit\w*|approv\w*|happy for)\b/
// Between the subject and the verb, only these may appear: "I hereby consent",
// "we do agree". "I used to consent" and "I will only consent" are not consent.
const ADVERBS = new Set(['hereby', 'do', 'fully', 'freely', 'happily', 'gladly', 'willingly', 'also', 'really', 'absolutely', 'completely', 'explicitly', 'voluntarily', 'knowingly', 'truly', 'formally', 'now', 'both', 'all'])

const regionNames = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }) } catch { return null }
})()

/** Lowercase, expand contractions, and reduce to space-separated words and clause punctuation. */
export function normalise(text) {
  return ` ${String(text ?? '').toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[’‘`´]/g, "'")
    .replace(/…/g, '.')
    .replace(/\bwon't\b/g, 'will not').replace(/\bcan't\b/g, 'can not').replace(/\bshan't\b/g, 'shall not').replace(/\bain't\b/g, 'is not')
    .replace(/\b([a-z]+)n't\b/g, '$1 not')
    .replace(/\bcannot\b/g, 'can not')
    .replace(/\bi'm\b/g, 'i am').replace(/\b(we|they|you)'re\b/g, '$1 are').replace(/\b(i|we)'d\b/g, '$1 would')
    .replace(/\b(i|we)'ll\b/g, '$1 will').replace(/\b(i|we)'ve\b/g, '$1 have')
    // U.K., U.S.A.: the dots are not sentence ends. Neither is a decimal point.
    .replace(/\b(?:[a-z]\.){2,}/g, m => m.replace(/\./g, ' '))
    .replace(/(\d)\.(\d)/g, '$1$2')
    .replace(/[^a-z0-9.;!?,]+/g, ' ')
    .replace(/\bad (hoc|lib|libitum|infinitum|nauseam)\b/g, 'ad$1')
    .replace(/\bno one\b/g, 'noone')
    .replace(/\s+/g, ' ')
    .trim()} `
}

function territoryName(code) {
  const name = regionNames?.of(code)
  if (!name || name === code) return []
  const base = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&/g, ' and ')
  const names = [base, base.replace(/\s*\(.*\)\s*/g, ' ')]
  return names.map(n => n.replace(/[^a-z0-9]+/g, ' ').trim()).filter(Boolean)
}

function aliasesFor(kind, term) {
  const words = String(term).toLowerCase().replace(/-/g, ' ')
  if (kind === 'use') return [...new Set([...(USE_CLASS_ALIASES[term] ?? []), words])]
  if (kind === 'capability') return [...new Set([...(CAPABILITY_ALIASES[term] ?? []), words])]
  if (kind === 'territory') {
    const code = String(term).toUpperCase()
    const list = [...(TERRITORY_EXTRA[code] ?? [])]
    for (const n of territoryName(code)) list.push(n, `the ${n}`)
    if (SAFE_CODE_TOKENS.has(code.toLowerCase())) list.push(code.toLowerCase())
    return [...new Set(list)]
  }
  return [words]
}

let knownTermPhrases = null
/** Every alias and place name, so "Not political." reads as a clause about something, not a bare "no". */
function knownPhrases() {
  if (knownTermPhrases) return knownTermPhrases
  const set = new Set([...Object.values(USE_CLASS_ALIASES).flat(), ...Object.values(CAPABILITY_ALIASES).flat(), ...Object.values(TERRITORY_EXTRA).flat()])
  for (let a = 65; a < 91; a++) for (let b = 65; b < 91; b++) for (const n of territoryName(String.fromCharCode(a, b))) set.add(n)
  knownTermPhrases = [...set]
  return knownTermPhrases
}

const has = (text, phrase) => text.includes(` ${phrase} `)
const words = text => text.replace(/,/g, ' ').trim().split(/\s+/).filter(Boolean)

/** The clause with guard phrases removed, so their own negators do not count. */
function unguarded(text) {
  let t = text.replace(/[,.;!?]/g, ' ').replace(/\s+/g, ' ')
  for (const g of NOT_NEGATING) t = t.split(` ${g} `).join(' ')
  return t
}

function hasNegator(text) {
  const t = unguarded(text)
  return words(t).some(w => NEGATOR_WORDS.has(w) || REFUSAL_STEMS.some(s => w.startsWith(s))) || NEGATOR_PHRASES.some(p => has(t, p))
}

function hasRefusal(text) {
  return words(unguarded(text)).some(w => REFUSAL_STEMS.some(s => w.startsWith(s)))
}

function isHedged(sentence) {
  if (sentence.question || QUESTION_OPENERS.test(sentence.text)) return true
  const t = sentence.text.replace(/,/g, ' ').replace(/\s+/g, ' ')
  return words(t).some(w => HEDGE_WORDS.has(w)) || HEDGE_PHRASES.some(p => has(t, p))
}

/** Where a phrase occurs in a clause, as character spans. */
function spans(clauseText, phrase, kind) {
  const found = []
  const plain = clauseText.replace(/,/g, ' ')
  const needle = ` ${phrase} `
  let at = plain.indexOf(needle)
  while (at !== -1) {
    const start = at + 1
    const end = start + phrase.length
    let ok = true
    if (kind === 'territory') {
      const before = plain.slice(0, start).trim().split(' ').at(-1)
      const after = plain.slice(end).trim().split(' ')[0]
      if (TERRITORY_BLOCKED_BEFORE.has(before) || TERRITORY_BLOCKED_AFTER.has(after)) ok = false
    }
    if (ok) found.push({ start, end, phrase })
    at = plain.indexOf(needle, at + 1)
  }
  return found
}

/** An affirmative first-person consent verb in this clause, or null. */
function affirmativeIn(text) {
  const w = words(text)
  for (let i = 0; i < w.length; i++) {
    if (w[i] !== 'i' && w[i] !== 'we') continue
    let j = i + 1
    while (j < w.length && ADVERBS.has(w[j])) j++
    const v = w[j]
    if (['consent', 'agree', 'authorise', 'authorize', 'allow'].includes(v)) return v
    if (v === 'give') {
      let k = j + 1
      if (['my', 'our'].includes(w[k])) k++
      if (['full', 'explicit', 'express'].includes(w[k])) k++
      if (w[k] === 'permission') return 'give permission'
    }
    if ((v === 'am' && w[i] === 'i') || (v === 'are' && w[i] === 'we')) {
      let k = j + 1
      while (['very', 'really', 'perfectly', 'completely', 'fully', 'more', 'than', 'quite'].includes(w[k])) k++
      if (w[k] === 'happy' && w[k + 1] === 'for') return `${v} happy for`
    }
  }
  return null
}

/**
 * @param {string} transcript
 * @param {{ useClass?: string[], territory?: string[], capability?: string[], validUntil?: string, maxSpendUsd?: number|string|null }} requested
 */
export function checkSpokenScope(transcript, requested = {}) {
  let norm = normalise(transcript)
  // "everything but advertising", "any country but the UK": this "but" excludes.
  norm = norm.replace(/ (everything|anything|anywhere|everywhere|all|any|whatever|wherever|anyone|anybody|everyone|everybody|nothing|nowhere|nobody|noone|none|every|each)((?: [a-z0-9]+){0,2}) but /g, ' $1$2 except ')

  // Sentences, then clauses within each.
  const sentences = []
  const pieces = norm.split(/([.;!?]+)/)
  for (let i = 0; i < pieces.length; i += 2) {
    const text = ` ${pieces[i].replace(/\s*,\s*/g, ' , ').replace(/\s+/g, ' ').trim()} `
    if (!text.trim()) continue
    sentences.push({ text, question: (pieces[i + 1] ?? '').includes('?') })
  }
  const clauses = []
  sentences.forEach((s, si) => {
    s.hedged = isHedged(s)
    for (const piece of s.text.split(/ (?:but|however|although|though|whereas) /)) {
      const text = ` ${piece.trim()} `
      if (text.trim() && text.trim() !== ',') clauses.push({ text, sentence: si, negated: hasNegator(text), consentWord: CONSENT_WORDS.test(text) })
    }
  })

  const wanted = [{ term: 'consent', kind: 'consent', phrases: [] }]
  for (const c of requested.capability ?? []) wanted.push({ term: c, kind: 'capability', phrases: aliasesFor('capability', c) })
  for (const u of requested.useClass ?? []) wanted.push({ term: u, kind: 'use', phrases: aliasesFor('use', u) })
  for (const t of requested.territory ?? []) wanted.push({ term: t, kind: 'territory', phrases: aliasesFor('territory', t) })

  // Every mention of every requested term, by clause.
  const mentions = []
  clauses.forEach((cl, ci) => {
    wanted.forEach((w, wi) => {
      for (const phrase of w.phrases) for (const s of spans(cl.text, phrase, w.kind)) mentions.push({ wi, ci, ...s })
    })
  })
  // One stretch of speech never satisfies two different terms.
  for (const m of mentions) {
    m.ambiguous = mentions.some(o => o.wi !== m.wi && o.ci === m.ci && o.start < m.end && m.start < o.end)
  }
  const known = knownPhrases()
  clauses.forEach((cl, ci) => {
    cl.aboutSomething = cl.consentWord || mentions.some(m => m.ci === ci) || known.some(p => has(cl.text.replace(/,/g, ' '), p))
  })

  // A clause that refuses consent taints its whole sentence. A bare refusal with
  // nothing of its own ("No.", "I don't.", "Absolutely not.") answers the clause
  // before it; with nothing before it, it refuses consent.
  let consentContradicted = false
  const why = []
  const taintedSentences = new Set()
  const taintedClauses = new Set()
  clauses.forEach((cl, ci) => {
    if (cl.negated && cl.consentWord) { taintedSentences.add(cl.sentence); consentContradicted = true; why.push('consent is said in a negated clause') }
    if (cl.negated && (!cl.aboutSomething || words(cl.text).some(w => ADDITIVE.has(w)))) {
      let back = ci - 1
      while (back >= 0 && !clauses[back].aboutSomething) back--
      if (back < 0) { consentContradicted = true; why.push('the recording opens with a refusal') } else {
        taintedClauses.add(back)
        if (clauses[back].consentWord) { consentContradicted = true; why.push('a refusal follows the consent') }
      }
    }
  })
  if (hasRefusal(norm)) { consentContradicted = true; why.push('a refusal verb was said') }
  const unguardedAll = unguarded(norm)
  if (RETRACTIONS.some(r => has(unguardedAll, r))) { consentContradicted = true; why.push('the statement was retracted') }

  const clauseRefuses = ci => clauses[ci].negated || taintedClauses.has(ci) || taintedSentences.has(clauses[ci].sentence)

  const checks = wanted.map((w, wi) => {
    const heard = new Set()
    let matched = false
    let contradicted = false
    const notes = []
    if (w.kind === 'consent') {
      clauses.forEach((cl, ci) => {
        const verb = affirmativeIn(cl.text)
        if (cl.consentWord) for (const m of cl.text.match(new RegExp(CONSENT_WORDS.source, 'g')) ?? []) heard.add(m)
        if (!verb) return
        if (clauseRefuses(ci)) return
        if (sentences[cl.sentence].hedged) { notes.push('consent was only said in a question, a condition or reported speech'); return }
        matched = true
      })
      contradicted = consentContradicted
      if (contradicted) notes.push(...why)
      else if (!matched) notes.push('no affirmative first-person consent was said')
    } else {
      for (const m of mentions.filter(x => x.wi === wi)) {
        heard.add(m.phrase)
        if (clauseRefuses(m.ci)) { contradicted = true; continue }
        if (m.ambiguous) { notes.push(`"${m.phrase}" could mean more than one requested term`); continue }
        if (sentences[clauses[m.ci].sentence].hedged) { notes.push('only said in a question, a condition or reported speech'); continue }
        matched = true
      }
    }
    return { term: w.term, kind: w.kind, matched: matched && !contradicted, contradicted, heard: [...heard], notes: [...new Set(notes)] }
  })

  const unchecked = ['validity', 'ceiling']
  if (!(requested.territory ?? []).length) unchecked.push('territory-unrestricted')
  if (!(requested.useClass ?? []).length) unchecked.push('use-class-unrestricted')
  if (!(requested.capability ?? []).length) unchecked.push('capability-unrestricted')

  const contradicted = checks.filter(c => c.contradicted).map(c => c.term)
  const missing = checks.filter(c => !c.matched && !c.contradicted).map(c => c.term)
  return {
    checks,
    missing,
    contradicted,
    covered: checks.filter(c => c.matched).length,
    total: checks.length,
    empty: norm.trim().length === 0,
    affirmative: checks[0].matched,
    unchecked,
    note: contradicted.length
      ? `spoken consent CONTRADICTS: ${contradicted.join(', ')} — this cannot be granted`
      : missing.length
        ? `spoken consent does not mention: ${missing.join(', ')} — review before granting`
        : `spoken consent mentions every requested term; the words were not checked against: ${unchecked.join(', ')} — confirm these explicitly`,
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
