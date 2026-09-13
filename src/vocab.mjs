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
 * The namespace resolves: the spec page and the machine-readable ontology are
 * served from this repository's GitHub Pages at exactly this path. Pages can be
 * changed by whoever controls the repository, so the fixed copy of each version
 * is the one anchored on the DKG (see README) and the versioned path under
 * ns/v1/<version>/.
 */
export const NS = 'https://oojae.github.io/mandate/ns/v1#'
export const t = name => `${NS}${name}`

/** Classes. */
export const LikenessGrant = t('LikenessGrant')
export const GrantState    = t('GrantState')
export const Derivation    = t('Derivation')
export const Refusal       = t('Refusal')

/** LikenessGrant properties. */
export const grantor            = t('grantor')            // did:dkg:agent:0x…, checked against the anchoring address
export const subject            = t('subject')            // 0x<grantor address>:<name>; declared, never biometric
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
 * DKG v10 has no Knowledge Asset revocation primitive — every `revoke` in the
 * node spec concerns X25519 encryption-key rotation. So revocation is an
 * application convention over an append-only graph: a revocation anchored by
 * the address that anchored the grant, and terminal.
 *
 * Who wrote it is the load-bearing question, and the answer is never a value in
 * the triples. Anyone can write `stateAuthor` naming the grantor; only the
 * grantor's address can anchor a Knowledge Asset under its own path in
 * Verifiable Memory. src/provenance.mjs attributes by that path.
 */
export const stateOf     = t('stateOf')      // → grant id
export const state       = t('state')        // 'revoked'; anything else is treated as revoked
export const stateAuthor = t('stateAuthor')  // descriptive; must match the anchoring address
export const stateAt     = t('stateAt')      // ISO-8601

export const STATE_ACTIVE  = 'active'
export const STATE_REVOKED = 'revoked'

/** Derivation properties — what was made, and under whose permission. */
export const outputSha256     = t('outputSha256')
export const servedCapability = t('servedCapability')
export const servedModelId    = t('servedModelId')
export const authorizedUnder  = t('authorizedUnder')   // → grant id / UAL
export const loraId           = t('loraId')
export const sessionId        = t('sessionId')         // the platform job id
export const billedUsd        = t('billedUsd')
export const derivedAt        = t('derivedAt')

/** Refusal properties — defined for integrators; the reference implementation does not publish refusals. */
export const refusedCapability = t('refusedCapability')
export const refusedSubject    = t('refusedSubject')
export const deniedByClause    = t('deniedByClause')
export const spendAvoidedUsd   = t('spendAvoidedUsd')
export const refusedAt         = t('refusedAt')

/** The clauses a request is checked against, in the order the gate applies them. */
export const CLAUSES = [
  'malformed-request',
  'use-class-prohibited',
  'read-inconsistent',
  'grant-exists',
  'capability-permitted',
  'use-class-permitted',
  'territory-permitted',
  'validity-window',
  'not-revoked',
  'spend-ceiling',
]
