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
import { nonce16, normSha256, agentAddress, decimalTerm } from './rdf-term.mjs'
import { derivationToQuads } from './rdf.mjs'
import { hashUrl } from './verify.mjs'

/** Derivation ids and asset names share the output hash prefix and one nonce. */
const DERIVATION_ID = /^urn:mandate:derivation:([0-9a-f]{16}):([0-9a-f]{16})$/
const DERIVATION_NAME = /^derivation-([0-9a-f]{16})-([0-9a-f]{16})$/

function checkBilledUsd(v) {
  if (v === null || v === undefined) return null
  // Checked with the writer's own rule, which refuses non-numbers, NaN,
  // Infinity, negatives and strings like "1e3". It also refuses a finite number
  // too large for a plain decimal (1e21), which would otherwise fail only after
  // the media was downloaded and hashed, on every retry.
  try {
    decimalTerm(v, 'billedUsd')
  } catch (e) {
    throw new TypeError(`billedUsd must be a finite non-negative amount like 0.25, or null; got ${typeof v === 'string' ? JSON.stringify(v) : String(v)} (${e.message})`)
  }
  return v
}

/** The nonce a caller-supplied id and name agree on, or throw. Returns null when neither is given. */
function callerNonce(id, name) {
  let nonce = null
  let sha16 = null
  if (id !== undefined && id !== null) {
    const m = typeof id === 'string' ? id.match(DERIVATION_ID) : null
    if (!m) throw new TypeError(`derivation id must look like urn:mandate:derivation:<16 hex>:<16 hex>, got ${JSON.stringify(id)}`)
    ;[, sha16, nonce] = m
  }
  if (name !== undefined && name !== null) {
    const m = typeof name === 'string' ? name.match(DERIVATION_NAME) : null
    if (!m) throw new TypeError(`derivation asset name must look like derivation-<16 hex>-<16 hex>, got ${JSON.stringify(name)}`)
    if (nonce && (m[1] !== sha16 || m[2] !== nonce)) throw new TypeError(`derivation id ${id} and asset name ${name} do not belong together`)
    ;[, sha16, nonce] = m
  }
  return nonce ? { sha16, nonce } : null
}

/**
 * Record one derivation and anchor it in the producer's own context graph.
 *
 * Every edge gets its own IRI — the output hash prefix plus a random nonce —
 * so two renders of identical bytes stay two edges, and nobody can add
 * predicates to an existing edge by computing its IRI.
 *
 * A retry must not mint a second asset for the same render. So a caller may
 * pass back the `id` or `name` of an earlier attempt (both carry the same
 * nonce) with `resume: true`, and the earlier asset is finished instead. The
 * id's hash prefix must match the output, so a saved id cannot be reused for
 * other bytes. Pass `lastPublishUnknown: true` when that earlier attempt may
 * have sent a publish transaction: resume then verifies but never publishes.
 */
export async function recordDerivation(node, contextGraphId, {
  outputUrl, outputSha256, servedCapability, servedModelId = null, authorizedUnder,
  billedUsd = null, jobId = null, derivedAt = new Date().toISOString(), expectAuthor,
  id, name, resume = false, lastPublishUnknown = false, fetchOptions,
} = {}) {
  // Checked before anything is downloaded or written: an amount that cannot be
  // recorded must fail at once, not after a hash and an identity round trip.
  const billed = checkBilledUsd(billedUsd)
  const given = callerNonce(id, name)
  if (typeof resume !== 'boolean') throw new TypeError('resume must be true or false')
  if (typeof lastPublishUnknown !== 'boolean') throw new TypeError('lastPublishUnknown must be true or false')

  const sha = outputSha256 ? normSha256(outputSha256) : outputUrl ? await hashUrl(outputUrl, fetchOptions) : null
  if (!sha) throw new Error('recordDerivation needs outputUrl or a valid outputSha256')
  if (given && given.sha16 !== sha.slice(0, 16)) {
    throw new TypeError(`derivation ${id ?? name} was made for other bytes (sha256 ${given.sha16}…), not ${sha.slice(0, 16)}…`)
  }
  const nonce = given?.nonce ?? nonce16()
  const derivationId = `urn:mandate:derivation:${sha.slice(0, 16)}:${nonce}`
  const assetName = `derivation-${sha.slice(0, 16)}-${nonce}`
  const quads = derivationToQuads({ id: derivationId, outputSha256: sha, servedCapability, servedModelId, authorizedUnder, billedUsd: billed, jobId, derivedAt })
  const author = expectAuthor ?? agentAddress((await node.identity()).agentDid)
  let anchored
  try {
    anchored = await node.sealShareAnchor({ name: assetName, contextGraphId, quads, expectAuthor: author, resume, lastPublishUnknown })
  } catch (e) {
    // Carry the id alongside the asset name so the caller can save both and resume.
    if (e && typeof e === 'object' && !Object.isFrozen(e)) e.derivationId ??= derivationId
    throw e
  }
  return { id: derivationId, outputSha256: sha, ...anchored, name: anchored?.name ?? assetName }
}

/**
 * Reconcile billed calls against the graph.
 *
 * Every render the platform billed must have a derivation edge. Anything billed
 * but unrecorded is an orphan, and an orphan means the blast radius is
 * understated. Only edges from trusted producers count: anyone can publish an
 * edge naming a job id, so an untrusted one must not hide an orphan.
 */
export function reconcile({ billedJobs = [], derivations = [] }) {
  // Derivations carry the Livepeer job id the platform bills under. Fail
  // closed: an edge without trusted === true is not counted.
  const trusted = derivations.filter(d => d?.trusted === true)
  const byJob = new Set(trusted.map(d => d.jobId).filter(Boolean))
  const orphans = billedJobs.filter(j => !byJob.has(j.jobId))
  return {
    billed: billedJobs.length,
    recorded: trusted.length,
    untrusted: derivations.length - trusted.length,
    orphans,
    complete: orphans.length === 0,
    note: orphans.length
      ? `${orphans.length} billed render(s) have no derivation edge — the quarantine list is INCOMPLETE`
      : 'every billed render has a derivation edge',
  }
}
