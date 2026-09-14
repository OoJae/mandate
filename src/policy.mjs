/**
 * Uses no grant can authorise.
 *
 * Some requests are refused whatever a grant says and whatever an operator
 * passes: sexual content of a real person and deceptive impersonation. A consent
 * clip cannot make these safe — the person recorded may not understand what they
 * are agreeing to, or may not be the person depicted — so the gate refuses them
 * before it reads any grant. This matches the norm in skills/likeness-consent.md.
 *
 * This is a check on the use-class LABEL the operator declares, nothing more. It
 * never looks at the prompt or the media, so a sexual render labelled
 * "advertising" is not caught here. To make an honest mislabel harder, labels are
 * normalised and common synonyms are refused, and a label is refused when any of
 * its words, or any run of adjacent words written together, is a prohibited term
 * after common inflections are removed: "explicit-ad", "deepfakes",
 * "impersonating", "sexualised", "deep-fakes", "x-rated-clip" and "nsfw18" are
 * all refused. Words are split at hyphens and digits.
 * Deliberate trade-off: that word match can refuse an innocent label such as
 * "adult-education" or "explicitly-licensed"; refusing is the safe side of that
 * mistake. It is still only a label check: a determined mislabel passes.
 */
export const PROHIBITED_USE_CLASSES = Object.freeze([
  'adult', 'sexual', 'deceptive-impersonation',
  'nsfw', 'porn', 'porno', 'pornography', 'pornographic', 'explicit', 'erotic', 'erotica',
  'nude', 'nudes', 'nudity', 'naked', 'sex', 'xxx', 'deepfake', 'impersonation', 'impersonate',
  'lewd', 'hentai', 'x-rated', 'fetish', 'onlyfans', 'smut', 'kink', 'camgirl',
])

const PROHIBITED = new Set(PROHIBITED_USE_CLASSES.map(t => t.replace(/-/g, '')))

// Longest first, so "sexualised" loses "ised" before it could lose only "d".
const SUFFIXES = ['isations', 'izations', 'isation', 'ization', 'ising', 'izing', 'ised', 'ized', 'ises', 'izes',
  'ness', 'ings', 'ally', 'ing', 'ers', 'ies', 'ity', 'ed', 'es', 'er', 'ly', 'al', 'ic', 's', 'y']

/** Lowercase, with spaces, underscores and dots folded to single hyphens. */
export function normaliseUseClass(useClass) {
  return String(useClass).trim().toLowerCase().replace(/[\s_.]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

/** A word and the stems left after removing one common inflection, with and without a restored final e. */
function forms(word) {
  const out = [word]
  for (const suffix of SUFFIXES) {
    if (word.length > suffix.length + 2 && word.endsWith(suffix)) {
      const stem = word.slice(0, -suffix.length)
      out.push(stem, `${stem}e`)
    }
  }
  return out
}

export function isProhibitedUseClass(useClass) {
  if (typeof useClass !== 'string') return false
  const words = normaliseUseClass(useClass).split(/[^a-z]+/).filter(Boolean)
  for (let i = 0; i < words.length; i++) {
    let joined = ''
    for (let j = i; j < words.length; j++) {
      joined += words[j]
      if (forms(joined).some(f => PROHIBITED.has(f))) return true
    }
  }
  return false
}
