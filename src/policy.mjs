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
 * all refused. Words are split at hyphens and digits. A prohibited stem written
 * inside a longer word is refused too, by substring: "pornvideo", "deepfakevideo",
 * "sexualcontent", "adultvideo", "impersonator", "nudify" and "sexting".
 * Deliberate trade-offs: that word match can refuse an innocent label such as
 * "adult-education" or "explicitly-licensed", and the substring match an innocent
 * word such as "sextant", "nudibranch" or "adulterate"; refusing is the safe side
 * of that mistake. The substring stems are four letters or more, so "sussex" and
 * "unisex" still pass, and they are matched within one word, never across a
 * hyphen. "stripper", "striptease" and "catfish" are whole words, never
 * substrings, so "comic-strip" and "wire-strip" pass; "catfish-recipe" is
 * refused, another innocent label on the safe side. Honest labels such as
 * "undressing", "topless", "bdsm", "impostor" and "catfishing" are refused.
 *
 * The list is incomplete and always will be: it catches common honest labels,
 * not every word for these uses ("lingerie", "boudoir", "scam" and "voice-clone"
 * pass today). It is still only a label check: a determined mislabel, or
 * leetspeak such as "p0rn" that splits at the digit, passes. A grantor's
 * permitsUseClass list is the control that holds; this check is a floor under it.
 */
export const PROHIBITED_USE_CLASSES = Object.freeze([
  'adult', 'sexual', 'deceptive-impersonation',
  'nsfw', 'porn', 'porno', 'pornography', 'pornographic', 'explicit', 'erotic', 'erotica',
  'nude', 'nudes', 'nudity', 'naked', 'sex', 'xxx', 'deepfake', 'impersonation', 'impersonate',
  'lewd', 'hentai', 'x-rated', 'fetish', 'onlyfans', 'smut', 'kink', 'camgirl',
  'stripper', 'striptease', 'catfish',
])

const PROHIBITED = new Set(PROHIBITED_USE_CLASSES.map(t => t.replace(/-/g, '')))

/** Stems refused wherever they occur inside a single word. */
export const PROHIBITED_STEMS = Object.freeze([
  'porn', 'sexual', 'sext', 'adult', 'deepfake', 'impersonat', 'nudi', 'nude', 'naked', 'erotic', 'explicit',
  'nsfw', 'xxx', 'xrated', 'lewd', 'hentai', 'fetish', 'onlyfan', 'smut', 'kink', 'camgirl',
  'undress', 'topless', 'bdsm', 'impostor', 'imposter',
])

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
  if (words.some(w => PROHIBITED_STEMS.some(stem => w.includes(stem)))) return true
  for (let i = 0; i < words.length; i++) {
    let joined = ''
    for (let j = i; j < words.length; j++) {
      joined += words[j]
      if (forms(joined).some(f => PROHIBITED.has(f))) return true
    }
  }
  return false
}
