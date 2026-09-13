/**
 * mandate-consent — the core.
 *
 * Everything reachable from this entry point runs with no npm packages
 * installed: the vocabulary, the gate, Turtle serialisation, third-party
 * verification, the revocation blast radius, and billing reconciliation. It is
 * the part meant to be dropped into any render harness, whatever it uses to talk
 * to a knowledge graph.
 *
 * The DKG node client (mandate-consent/dkg) speaks the node's HTTP API with no
 * dependencies. The adapters that do need peers live on subpaths:
 *   mandate-consent/livepeer  — Livepeer Agent client  (peer: @modelcontextprotocol/sdk)
 *   mandate-consent/consent   — consent capture        (peer: @modelcontextprotocol/sdk)
 */
export * as vocab from './vocab.mjs'
export { NS, STATE_ACTIVE, STATE_REVOKED, CLAUSES } from './vocab.mjs'

export { decide, revocationOf, priorSpendFor, grantIsAuthentic } from './gate.mjs'
export { PROHIBITED_USE_CLASSES } from './policy.mjs'
export { grantToQuads, stateToQuads, derivationToQuads, grantToTurtle, stateToTurtle, derivationToTurtle } from './rdf.mjs'
export { verifyKnowledge, blastRadius, CLEAR, TAINTED, UNKNOWN, INCONCLUSIVE } from './verify-core.mjs'
export { readKnowledge, readPublisher, READ_DEFAULTS } from './resolve.mjs'
export { anchorsFromMeta, checkConsistency, reduceSlice } from './provenance.mjs'
export { memoryStateStore, fileStateStore } from './state-store.mjs'
export { makeSubject, subjectAddress, TermError, InvalidIriError, UnpublishableLiteralError } from './rdf-term.mjs'
export { reconcile } from './derivation.mjs'
export { checkSpokenScope } from './scope.mjs'
