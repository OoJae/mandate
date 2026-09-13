/**
 * Uses no grant can authorise.
 *
 * Some requests are refused whatever a grant says and whatever an operator
 * passes: sexual content of a real person and deceptive impersonation. A consent
 * clip cannot make these safe — the person recorded may not understand what they
 * are agreeing to, or may not be the person depicted — so the gate refuses them
 * before it reads any grant. This matches the norm in skills/likeness-consent.md.
 */
export const PROHIBITED_USE_CLASSES = Object.freeze(['adult', 'sexual', 'deceptive-impersonation'])

export const isProhibitedUseClass = useClass => PROHIBITED_USE_CLASSES.includes(useClass)
