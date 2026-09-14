/**
 * Compare what a person said against what is about to be granted.
 *
 * Two layers, and only the first can confirm anything.
 *
 *   scriptMatch   closed world. The transcript is compared word by word with
 *                 consentScript(requested), after both are put in one canonical
 *                 form (see scriptWords). `confirmed` is true only for a reading
 *                 of the script with nothing contradicted. Anything else,
 *                 however consent-like, is UNCONFIRMED and needs a person.
 *   heuristics    open world, below. They can never confirm a transcript; they
 *                 exist to show a person what was heard and to stop a refusal
 *                 outright (`contradicted`). No list of refusals is complete,
 *                 which is why they no longer decide anything on their own.
 *
 * Limits of the closed world, named: the script's words are what is compared,
 * not what the person meant by them ("in Georgia" read from the script names
 * the country the grant says); up to SCRIPT_MAX_MISSES short non-critical words
 * may be dropped; and a use or territory term the heuristics match anywhere in
 * the transcript need not sit in the consent clause ("My cousin works in
 * advertising"), which is harmless only because such a transcript is never a
 * script match.
 *
 * The heuristics surface mismatches for a human; they do not decide consent. They are
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
  // Contractions typed without an apostrophe, and exclusions and refusals the first list missed.
  'havent', 'hasnt', 'hadnt', 'mustnt', 'neednt', 'shant', 'mightnt', 'save', 'bar', 'barring', 'minus', 'sans', 'beyond', 'excepted',
  'unacceptable', 'dealbreaker', 'nay', 'negative', 'scrap', 'pass',
])
// A negated clause with one of these ("not in France either") reaches back to the clause before it.
const ADDITIVE = new Set(['either', 'neither', 'nor', 'too', 'also', 'same'])
const NEGATOR_PHRASES = ['off limits', 'off the table', 'other than', 'rather than', 'instead of', 'no way', 'no one', 'out of the question', 'else than', 'draw the line', 'away from', 'leave out', 'no go', 'hard no', 'right out']
// Refusing consent itself: anywhere in the transcript, consent is contradicted.
const REFUSAL_STEMS = ['refus', 'withh', 'declin', 'reject', 'object', 'oppos', 'withdr', 'revok', 'revoc', 'deny', 'denie', 'denial', 'veto', 'disagree', 'disapprov', 'dissent', 'unwilling', 'forbid', 'forbad', 'prohibit', 'disallow', 'retract', 'rescind']
const RETRACTIONS = ['kidding', 'joking', 'joke', 'jk', 'lying', 'lied', 'sarcastic', 'sarcasm', 'pretend', 'pretending', 'pretended',
  'take that back', 'take it back', 'scratch that', 'change my mind', 'changed my mind', 'forget it', 'forget that', 'never mind', 'nevermind', 'disregard', 'cancel', 'not serious',
  'take back', 'strike that', 'delete that', 'undo', 'lie', 'lies', 'psych', 'facetious', 'yeah right', 'as if', 'dead body', 'your dreams', 'my dreams',
  'hell freezes', 'pigs fly', 'another life', 'april fool', 'april fools', 'ignore', 'ha ha', 'haha', 'lol', 'not true',
  // Coercion or dictation said anywhere taints the whole recording, not only its own sentence.
  'forced', 'duress', 'coerced', 'threatened', 'made me', 'told me to', 'repeat after']
// Phrases that contain a negator but do not negate. Only the phrase's own words
// are removed; any other negator in the clause still counts ("I don't mind no ads").
// "not only" is deliberately absent: it swallowed a real negator ("not only wrong").
const NOT_NEGATING = ['would not mind', 'do not mind', 'dont mind', 'not mind', 'no problem', 'no problems', 'not a problem', 'no objection', 'no objections',
  'without hesitation', 'without reservation', 'nothing else', 'nowhere else', 'noone else', 'nobody else', 'no other purpose', 'no other use', 'no other uses', 'no more than', 'not more than', 'no later than', 'not later than', 'not to exceed', 'not exceeding', 'no longer than']

// A sentence with any of these is a question, a conditional or reported speech:
// it can neither give consent nor satisfy a term.
const HEDGE_WORDS = new Set(['if', 'provided', 'providing', 'assuming', 'suppose', 'supposing', 'whether', 'would', 'could', 'might', 'maybe', 'perhaps', 'possibly', 'probably', 'hypothetically', 'imagine', 'before', 'once',
  'said', 'say', 'says', 'saying', 'told', 'tell', 'tells', 'telling', 'ask', 'asks', 'asked', 'asking', 'claim', 'claims', 'claimed', 'quote', 'quoting', 'according', 'supposedly', 'apparently', 'reportedly', 'allegedly',
  'think', 'thinks', 'thought', 'believe', 'believes', 'guess', 'wonder', 'heard', 'rumour', 'rumor',
  'wrote', 'writes', 'written', 'stated', 'read', 'reads', 'reading', 'script', 'repeat', 'conditional', 'conditionally', 'when', 'whenever', 'after', 'pending'])
const HEDGE_PHRASES = ['as long as', 'so long as', 'in case', 'on condition', 'on the condition', 'subject to', 'in return for', 'in exchange for', 'states that', 'states i', 'states we', 'only when', 'want me to', 'wants me to', 'wanted me to', 'is what', 'was what', 'expect me to']
const QUESTION_OPENERS = /^ (do|does|did|can|could|would|will|shall|should|may|might|must|is|are|am|was|were|have|has) (i|we|you|they|he|she|it|this|that) /

// Consent words, used to recognise a refusal of consent ("I do not consent").
const CONSENT_WORDS = /\b(consent\w*|agree\w*|permission\w*|authori[sz]\w*|allow\w*|permit\w*|approv\w*|happy for)\b/
// Between the subject and the verb, only these may appear: "I hereby consent",
// "we do agree". "I used to consent" and "I will only consent" are not consent.
// Before the subject, these make the clause a question even without a question mark (ASR drops it).
const BEFORE_SUBJECT = new Set(['do', 'does', 'did', 'can', 'could', 'should', 'will', 'shall', 'may', 'must', 'would', 'why', 'how', 'what', 'when', 'whether'])
const ADVERBS = new Set(['hereby', 'do', 'fully', 'freely', 'happily', 'gladly', 'willingly', 'also', 'really', 'absolutely', 'completely', 'explicitly', 'voluntarily', 'knowingly', 'truly', 'formally', 'now', 'both', 'all'])

const UNIVERSAL = / (everything|anything|anywhere|everywhere|all|any|whatever|wherever|anyone|anybody|everyone|everybody|nothing|nowhere|nobody|noone|none|every|each)(?= )/
// After "but", a clause of nothing but requested terms is an exclusion: "for editorial and education but advertising".
const BARE_EXCLUSION_FILLER = new Set(['the', 'a', 'an', 'for', 'in', 'of', 'and', 'or', 'any', 'all'])

const regionNames = (() => {
  try { return new Intl.DisplayNames(['en'], { type: 'region' }) } catch { return null }
})()

/** Lowercase, expand contractions, and reduce to space-separated words and clause punctuation. */
export function normalise(text) {
  return ` ${String(text ?? '').toLowerCase()
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
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
  const base = name.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ')
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

/** Whether a clause says nothing but known terms and a few joining words. */
function isOnlyTerms(text) {
  let t = ` ${text.replace(/,/g, ' ').replace(/\s+/g, ' ').trim()} `
  for (const p of [...knownPhrases()].sort((a, b) => b.length - a.length)) t = t.split(` ${p} `).join(' ')
  return words(t).every(w => BARE_EXCLUSION_FILLER.has(w)) && t.trim() !== text.trim()
}

/** An affirmative first-person consent verb in this clause, or null. */
function affirmativeIn(text) {
  const w = words(text)
  for (let i = 0; i < w.length; i++) {
    if (w[i] !== 'i' && w[i] !== 'we') continue
    if (BEFORE_SUBJECT.has(w[i - 1])) continue
    let j = i + 1
    while (j < w.length && ADVERBS.has(w[j])) j++
    const v = w[j]
    // "I agree that it is wrong" and "I agree with the critics" agree with an opinion, not to a use.
    if (['consent', 'agree'].includes(v) && (w[j + 1] === undefined || w[j + 1] === 'to' || w[j + 1] === 'for')) return v
    // "I allow my lawyer to decide" gives the decision to someone else.
    if (['authorise', 'authorize', 'allow'].includes(v) && (w[j + 1] === 'you' || !w.slice(j + 1, j + 4).includes('to'))) return v
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
  // At any distance within the sentence: "all kinds of uses you like but advertising".
  norm = norm.replace(/[^.;!?]+/g, sentence => {
    const at = sentence.search(UNIVERSAL)
    return at === -1 ? sentence : sentence.slice(0, at) + sentence.slice(at).replace(/ but (?=\S)/g, ' except ')
  })

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
    const parts = s.text.split(/ (but|however|although|though|whereas) /)
    for (let p = 0; p < parts.length; p += 2) {
      const text = ` ${parts[p].trim()} `
      if (!text.trim() || text.trim() === ',') continue
      const bareExclusion = parts[p - 1] === 'but' && isOnlyTerms(text)
      clauses.push({ text, sentence: si, negated: bareExclusion || hasNegator(text), consentWord: CONSENT_WORDS.test(text) })
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
  // Closed world: only a reading of the script is confirmed. The heuristics can
  // still contradict it (a hard stop), but they can never confirm anything else.
  const scriptMatch = matchScript(transcript, requested)
  const confirmed = scriptMatch.matched && contradicted.length === 0
  const differences = [scriptMatch.missing.length ? `missing: ${scriptMatch.missing.join(' ')}` : '', scriptMatch.extra.length ? `extra: ${scriptMatch.extra.join(' ')}` : ''].filter(Boolean).join('; ')
  return {
    checks,
    missing,
    contradicted,
    covered: checks.filter(c => c.matched).length,
    total: checks.length,
    empty: norm.trim().length === 0,
    affirmative: checks[0].matched,
    unchecked,
    script: consentScript(requested),
    scriptMatch,
    confirmed,
    note: contradicted.length
      ? `spoken consent CONTRADICTS: ${contradicted.join(', ')} — this cannot be granted`
      : !scriptMatch.matched
        ? `spoken consent is not a reading of the consent script (${differences || 'nothing was said'}) — UNCONFIRMED; a person must read the transcript`
        : `spoken consent reads the consent script; the words were not checked against: ${unchecked.join(', ')} — confirm these explicitly`,
  }
}

/* ------------------------- the consent script, closed world ------------------------- */

// The heuristics above can only ever list the refusals someone thought of. The
// only transcript confirmed without a person reading it is one that says the
// generated script and nothing else: every script word in order, every term
// word exactly, and nothing extra but a few sounds that carry no meaning.

// ASR drops short words; it may drop at most this many non-critical script
// words ("to", "of", "my", "for", "in", "and", "spending", "is", "at",
// "dollars") and still match. A critical word is never allowed to go missing.
// Deliberately stricter than the minimum: besides I, consent and every term
// word, "until", the date, "capped" and the amount are critical too.
export const SCRIPT_MAX_MISSES = 2
// Unaligned transcript words that may be ignored. Deliberately short and closed:
// no negators, no conjunctions ("but", "and"), no conditionals, and not "right"
// ("yeah right") or "like".
const SCRIPT_FILLER = new Set(['um', 'umm', 'uh', 'uhh', 'er', 'erm', 'ah', 'hmm', 'mm', 'hi', 'hello', 'hey', 'so', 'okay', 'ok', 'yes', 'yeah', 'well', 'a', 'an', 'the'])

const MONTHS = new Set(['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'])
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen']
const ONES_ORD = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth']
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, twentieth: 20, thirtieth: 30 }
const UNIT = new Map([...ONES.map((w, i) => [w, i]), ...ONES_ORD.map((w, i) => [w, i])])

/** A number said in words below 100 at tokens[i]: { v, next } or null. */
function below100(t, i) {
  if (t[i] in TENS) {
    const u = UNIT.get(t[i + 1])
    return u >= 1 && u <= 9 ? { v: TENS[t[i]] + u, next: i + 2 } : { v: TENS[t[i]], next: i + 1 }
  }
  return UNIT.has(t[i]) ? { v: UNIT.get(t[i]), next: i + 1 } : null
}

function belowThousand(t, i) {
  const a = below100(t, i)
  if (!a || t[a.next] !== 'hundred') return a
  let j = a.next + 1
  if (t[j] === 'and' && below100(t, j + 1)) j++
  const b = below100(t, j)
  return { v: a.v * 100 + (b?.v ?? 0), next: b?.next ?? j }
}

/** Number words to digits: "five" 5, "thirteenth" 13, "twenty twenty six" 2026, "two point five" 2 point 5. */
function numbersToDigits(t) {
  const out = []
  for (let i = 0; i < t.length;) {
    let n = belowThousand(t, i)
    if (!n) { out.push(t[i]); i++; continue }
    if (t[n.next] === 'thousand') {
      let j = n.next + 1
      if (t[j] === 'and' && belowThousand(t, j + 1)) j++
      const b = belowThousand(t, j)
      n = { v: n.v * 1000 + (b?.v ?? 0), next: b?.next ?? j }
    } else if ((t[i] === 'nineteen' || t[i] === 'twenty') && n.next === i + 1) {
      // A year said in pairs: "twenty twenty six", "nineteen ninety". Only a
      // cardinal 19 or 20 starts one, so "twelfth twenty twenty six" stays 12 2026.
      const y = below100(t, n.next)
      if (y && y.v >= 10) n = { v: n.v * 100 + y.v, next: y.next }
    }
    out.push(String(n.v))
    i = n.next
  }
  return out
}

/** Words of one piece of speech, in the one canonical form both sides are compared in. */
export function scriptWords(text) {
  const s = ` ${String(text ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')} `
    .replace(/&/g, ' and ')
    .replace(/\$\s*(\d[\d,]*(?:\.\d+)?)/g, ' $1 dollars ')
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    // 5.00 is 5 and 2.50 is 2 point 5, so a spoken "two point five" can match either.
    .replace(/(\d+)\.(\d+)/g, (_, a, b) => { const f = b.replace(/0+$/, ''); return f ? ` ${a} point ${f.split('').join(' ')} ` : ` ${a} ` })
    .replace(/\b(\d+)(?:st|nd|rd|th)\b/g, '$1')
    // U.K., U.S.A.: letters joined, so they are one word like UK and USA.
    .replace(/\b[a-z](?:\.[a-z])+\.?/g, m => m.replace(/\./g, ''))
    .replace(/[^a-z0-9]+/g, ' ')
  let t = s.trim().split(' ').filter(Boolean)
  t = t.flatMap(w => ({ lipsync: ['lip', 'sync'], lipsyncing: ['lip', 'syncing'], faceswap: ['face', 'swap'], st: ['saint'] })[w] ?? [w])
  t = numbersToDigits(t)
  // Token by token, so neighbouring forms ('UK, UK') never overlap.
  const out = []
  for (let i = 0; i < t.length; i++) {
    const w = t[i]
    const last = out.at(-1)
    if (w === 'u' && t[i + 1] === 's' && t[i + 2] === 'a') { out.push('usa'); i += 2; continue }
    if (w === 'u' && (t[i + 1] === 'k' || t[i + 1] === 's')) { out.push(`u${t[i + 1]}`); i++; continue }
    // 'two point five zero' is 2 point 5, and 'five point zero' is 5, as digits are.
    if (w === 'point' && /^\d+$/.test(last ?? '')) {
      let j = i + 1
      const digits = []
      while (/^\d$/.test(t[j] ?? '')) digits.push(t[j++])
      while (digits.at(-1) === '0') digits.pop()
      if (j > i + 1) { if (digits.length) out.push('point', ...digits); i = j - 1; continue }
    }
    // Every spoken form of the currency is one word: US dollars, USD, dollar.
    if (w === 'dollars' || w === 'dollar' || w === 'usd') {
      if (['us', 'usa', 'american'].includes(last)) out.pop()
      else if (last === 'states' && out.at(-2) === 'united') out.splice(-2)
      out.push('dollars')
      continue
    }
    // Dates in the script's own order: day, month, year.
    if (w === 'of' && /^\d{1,2}$/.test(last ?? '') && MONTHS.has(t[i + 1])) continue
    if (MONTHS.has(w)) {
      const k = t[i + 1] === 'the' ? i + 2 : i + 1
      if (/^\d{1,2}$/.test(t[k] ?? '') && !(/^\d{1,2}$/.test(last ?? ''))) { out.push(t[k], w); i = k; continue }
    }
    out.push(w)
  }
  return out.flatMap(w => (w === 'uk' ? ['united', 'kingdom'] : w === 'us' || w === 'usa' ? ['united', 'states'] : [w]))
}

/** The script as pieces of text, each marked critical or not. consentScript joins them; nothing else writes the words. */
function scriptPieces({ capability = [], useClass = [], territory = [], validUntil, maxSpendUsd } = {}) {
  const pieces = []
  const add = (text, critical = false) => pieces.push({ text, critical })
  const list = xs => xs.forEach((x, i) => { if (i) add(i === xs.length - 1 ? ' and ' : ', '); add(x, true) })
  const caps = capability.map(c => (CAPABILITY_ALIASES[c]?.[0] ?? String(c).replace(/-/g, ' ')))
  // A parenthesis is not spoken: "Myanmar (Burma)" is read as Myanmar.
  const places = territory.map(t => (regionNames?.of(String(t).toUpperCase()) ?? String(t)).replace(/\s*\([^)]*\)\s*/g, ' ').trim())
  add('I consent', true)
  add(' to ')
  list(caps.length ? caps : ['generated media'])
  add(' of my likeness')
  if (useClass.length) { add(' for '); list(useClass) }
  if (places.length) { add(' in '); list(places) }
  if (validUntil) { add(' '); add('until', true); add(' '); add(new Date(validUntil).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }), true) }
  add('.')
  if (maxSpendUsd != null) { add(' Spending is '); add('capped', true); add(' at '); add(String(maxSpendUsd), true); add(' US dollars.') }
  return pieces
}

/**
 * Whether a transcript is a reading of the script: an alignment (longest common
 * subsequence, critical words weighted so they are never traded for others)
 * with no critical word missing, at most SCRIPT_MAX_MISSES other words missing,
 * and every unaligned transcript word in SCRIPT_FILLER.
 */
export function matchScript(transcript, requested = {}) {
  const want = scriptPieces(requested).flatMap(p => scriptWords(p.text).map(w => ({ w, critical: p.critical })))
  const got = scriptWords(transcript)
  const n = want.length
  const m = got.length
  // A transcript many times longer than the script is not a reading of it, and
  // aligning a megabyte of words would cost n x m memory for nothing.
  if (m > 4 * n + 64) return { matched: false, missing: [], extra: got.filter(w => !SCRIPT_FILLER.has(w)).slice(0, 50) }
  const score = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const skip = Math.max(score[i + 1][j], score[i][j + 1])
      score[i][j] = want[i].w === got[j] ? Math.max(skip, score[i + 1][j + 1] + (want[i].critical ? 1000 : 1)) : skip
    }
  }
  const missing = []
  const extra = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (want[i].w === got[j] && score[i][j] === score[i + 1][j + 1] + (want[i].critical ? 1000 : 1)) { i++; j++ } else if (score[i + 1][j] >= score[i][j + 1]) { missing.push(want[i]); i++ } else { extra.push(got[j]); j++ }
  }
  while (i < n) missing.push(want[i++])
  while (j < m) extra.push(got[j++])
  const meaningful = extra.filter(w => !SCRIPT_FILLER.has(w))
  const matched = m > 0 && meaningful.length === 0 && !missing.some(x => x.critical) && missing.length <= SCRIPT_MAX_MISSES
  return { matched, missing: missing.map(x => x.w), extra: meaningful }
}

/** A plain script for the person to read, generated from the grant's clauses. */
export function consentScript(requested = {}) {
  return scriptPieces(requested).map(p => p.text).join('')
}
