/**
 * The Mandate grant vocabulary.
 *
 * This file is the contribution. The point of publishing consent as RDF on a
 * shared graph — rather than holding it in a renderer's own database — is that
 * the party who grants permission is never the party who runs the render. An
 * open vocabulary is what lets a third party who trusts neither side check a
 * delivered file for themselves.
 */

/**
 * An IRI we control and that resolves: the spec page and the machine-readable
 * ontology are served from GitHub Pages at exactly this path. A vocabulary under
 * a domain someone else could register is a vocabulary someone else can redefine.
 */
export const NS = 'https://oojae.github.io/mandate/ns/v1#'
export const t = name => `${NS}${name}`

/** Classes. */
export const LikenessGrant = t('LikenessGrant')
export const GrantState    = t('GrantState')
export const Derivation    = t('Derivation')
export const Refusal       = t('Refusal')

/** LikenessGrant properties. */
export const grantor            = t('grantor')            // did:dkg:agent:0x…
export const subject            = t('subject')            // DECLARED identifier, never biometric
export const consentClipSha256  = t('consentClipSha256')
export const consentTranscript  = t('consentTranscript')
export const permitsCapability  = t('permitsCapability')  // exact Livepeer capability name
export const permitsUseClass    = t('permitsUseClass')
export const forbidsUseClass    = t('forbidsUseClass')
export const territory          = t('territory')
export const validFrom          = t('validFrom')
export const validUntil         = t('validUntil')
export const maxSpendUsd        = t('maxSpendUsd')

/**
 * GrantState properties.
 *
 * DKG v10 has no Knowledge Asset revocation primitive — we checked, and every
 * `revoke` in the node spec concerns X25519 encryption-key rotation. So
 * revocation here is an application-level convention over an append-only graph:
 * a state assertion authored by the grantor, where the newest grantor-authored
 * assertion wins.
 *
 * `stateAuthor` is the load-bearing property in this whole file. Because the
 * graph is append-only, "active" and "revoked" coexist forever, and anyone can
 * write a triple claiming a grant is still live. A resolver that does not check
 * who authored the state is not a gate at all — the producer simply writes
 * their own "not revoked" and wins.
 */
export const stateOf     = t('stateOf')      // → grant id
export const state       = t('state')        // 'active' | 'revoked'
export const stateAuthor = t('stateAuthor')  // MUST equal the grant's grantor
export const stateAt     = t('stateAt')      // ISO-8601

export const STATE_ACTIVE  = 'active'
export const STATE_REVOKED = 'revoked'

/** Derivation properties — what was made, and under whose permission. */
export const outputSha256     = t('outputSha256')
export const servedCapability = t('servedCapability')
export const servedModelId    = t('servedModelId')
export const authorizedUnder  = t('authorizedUnder')   // → grant id / UAL
export const loraId           = t('loraId')
export const sessionId        = t('sessionId')
export const billedUsd        = t('billedUsd')
export const derivedAt        = t('derivedAt')

/** Refusal properties — a refusal is evidence too, and it is free to produce. */
export const refusedCapability = t('refusedCapability')
export const refusedSubject    = t('refusedSubject')
export const deniedByClause    = t('deniedByClause')
export const spendAvoidedUsd   = t('spendAvoidedUsd')
export const refusedAt         = t('refusedAt')

/** The clauses a request is checked against, in the order the gate applies them. */
export const CLAUSES = [
  'grant-exists',
  'capability-permitted',
  'use-class-permitted',
  'territory-permitted',
  'validity-window',
  'not-revoked',
  'spend-ceiling',
]
