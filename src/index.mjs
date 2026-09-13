/**
 * mandate-consent — the core.
 *
 * Everything reachable from this entry point runs with no npm packages
 * installed: the vocabulary, the gate, Turtle serialisation, third-party
 * verification, the revocation blast radius, and billing reconciliation. It is
 * the part meant to be dropped into any render harness, whatever it uses to talk
 * to a knowledge graph.
 *
 * The adapters that do need peers live on subpaths:
 *   mandate-consent/dkg       — DKG v10 node client   (peer: @origintrail-official/dkg)
 *   mandate-consent/livepeer  — Livepeer Agent client  (peer: @modelcontextprotocol/sdk)
 *   mandate-consent/consent   — consent capture        (peer: @modelcontextprotocol/sdk)
 */
export * as vocab from './vocab.mjs'
export { NS, STATE_ACTIVE, STATE_REVOKED, CLAUSES } from './vocab.mjs'

export { decide, effectiveState } from './gate.mjs'
export { grantToTurtle, stateToTurtle, derivationToTurtle } from './rdf.mjs'
export { verifyKnowledge, CLEAR, TAINTED, UNKNOWN } from './verify-core.mjs'
export { readKnowledge, blastRadius, priorSpendFor } from './resolve.mjs'
export { reconcile } from './derivation.mjs'
export { checkSpokenScope } from './scope.mjs'
export { parseQueryTable } from './sparql-table.mjs'
