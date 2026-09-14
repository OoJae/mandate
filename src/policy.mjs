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
 * its hyphenated words is a prohibited term ("explicit-ad" is refused).
 * Deliberate trade-off: that word match can refuse an innocent label such as
 * "adult-education"; refusing is the safe side of that mistake.
 */
export const PROHIBITED_USE_CLASSES = Object.freeze([
  'adult', 'sexual', 'deceptive-impersonation',
  'nsfw', 'porn', 'porno', 'pornography', 'pornographic', 'explicit', 'erotic', 'erotica',
  'nude', 'nudes', 'nudity', 'naked', 'sex', 'xxx', 'deepfake', 'impersonation', 'impersonate',
])

const PROHIBITED = new Set(PROHIBITED_USE_CLASSES)

/** Lowercase, with spaces, underscores and dots folded to single hyphens. */
export function normaliseUseClass(useClass) {
  return String(useClass).trim().toLowerCase().replace(/[\s_.]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

export function isProhibitedUseClass(useClass) {
  if (typeof useClass !== 'string') return false
  const label = normaliseUseClass(useClass)
  if (PROHIBITED.has(label) || PROHIBITED.has(label.replace(/-/g, ''))) return true
  return label.split('-').some(word => PROHIBITED.has(word))
}
