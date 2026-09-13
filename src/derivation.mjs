/**
 * The derivation ledger.
 *
 * A revocation is only as honest as this file. When a grantor revokes, the
 * product claims it can enumerate everything made under the grant — and that
 * claim is false the moment one render slips through unrecorded.
 *
 * So derivations are written eagerly and must be anchored before the caller is
 * given the media. An unrecorded derivation is treated as a failed render, even
 * though the media exists and was billed: better to report a render as failed
 * than to hold media a revocation cannot account for.
 */
import { nonce16, normSha256, agentAddress } from './rdf-term.mjs'
import { derivationToQuads } from './rdf.mjs'
import { hashUrl } from './verify.mjs'

/**
 * Record one derivation and anchor it in the producer's own context graph.
 *
 * Every edge gets its own IRI — the output hash prefix plus a random nonce —
 * so two renders of identical bytes stay two edges, and nobody can add
 * predicates to an existing edge by computing its IRI.
 */
export async function recordDerivation(node, contextGraphId, {
  outputUrl, outputSha256, servedCapability, servedModelId = null, authorizedUnder,
  billedUsd = null, jobId = null, derivedAt = new Date().toISOString(), expectAuthor,
} = {}) {
  const sha = outputSha256 ? normSha256(outputSha256) : await hashUrl(outputUrl)
  if (!sha) throw new Error('recordDerivation needs outputUrl or a valid outputSha256')
  const nonce = nonce16()
  const id = `urn:mandate:derivation:${sha.slice(0, 16)}:${nonce}`
  const quads = derivationToQuads({ id, outputSha256: sha, servedCapability, servedModelId, authorizedUnder, billedUsd, jobId, derivedAt })
  const author = expectAuthor ?? agentAddress((await node.identity()).agentDid)
  const anchored = await node.sealShareAnchor({ name: `derivation-${sha.slice(0, 16)}-${nonce}`, contextGraphId, quads, expectAuthor: author })
  return { id, outputSha256: sha, ...anchored }
}

/**
 * Reconcile billed calls against the graph.
 *
 * Every render the platform billed must have a derivation edge. Anything billed
 * but unrecorded is an orphan, and an orphan means the blast radius is
 * understated.
 */
export function reconcile({ billedJobs = [], derivations = [] }) {
  // Derivations carry the Livepeer job id the platform bills under.
  const byJob = new Set(derivations.map(d => d.jobId).filter(Boolean))
  const orphans = billedJobs.filter(j => !byJob.has(j.jobId))
  return {
    billed: billedJobs.length,
    recorded: derivations.length,
    orphans,
    complete: orphans.length === 0,
    note: orphans.length
      ? `${orphans.length} billed render(s) have no derivation edge — the quarantine list is INCOMPLETE`
      : 'every billed render has a derivation edge',
  }
}
