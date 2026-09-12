/**
 * The derivation ledger.
 *
 * A revocation is only as honest as this file. When Ana revokes, the product
 * claims it can enumerate everything ever made under her grant — and that claim
 * is a lie the moment one render slips through unrecorded.
 *
 * So derivations are written EAGERLY and TRANSACTIONALLY: a render result is
 * not returned to the caller until its derivation edge is committed. An
 * uncommitted derivation is treated as a FAILED RENDER, even though the media
 * exists and has been billed. That is the deliberate trade — we would rather
 * report a render as failed than hold media we cannot account for.
 */
import { createHash } from 'node:crypto'
import { writeFileSync, mkdirSync } from 'node:fs'
import { derivationToTurtle } from './rdf.mjs'

const OUT = 'spikes/out/derivations'

export async function sha256OfUrl(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`cannot hash output: HTTP ${res.status}`)
  return createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex')
}

/**
 * Record one derivation and commit it before the caller sees the media.
 *
 * Two addressing schemes have to be reconciled: Livepeer indexes lineage by
 * project/session, and this graph is indexed by output content hash. Both keys
 * are stored on every edge so the two can be joined later — missing that join
 * is how a quarantine list silently becomes incomplete.
 */
export async function recordDerivation(node, contextGraphId, {
  outputUrl, servedCapability, servedModelId, authorizedUnder,
  loraId = null, sessionId = null, billedUsd = 0, jobId = null,
}) {
  const outputSha256 = await sha256OfUrl(outputUrl)
  const id = `urn:mandate:derivation:${outputSha256.slice(0, 16)}`
  const ttl = derivationToTurtle({
    id, outputSha256, servedCapability, servedModelId, authorizedUnder,
    loraId, sessionId: sessionId ?? jobId, billedUsd,
    derivedAt: new Date().toISOString(),
  })

  mkdirSync(OUT, { recursive: true })
  const path = `${OUT}/${outputSha256.slice(0, 16)}.ttl`
  writeFileSync(path, ttl)

  const name = `derivation-${outputSha256.slice(0, 16)}`
  // `ka create --share` is NOT atomic: it can seal into Working Memory and then
  // fail the SWM promote. Retry the share rather than assume it landed.
  const created = await node.createKA(name, contextGraphId, path, { share: true })
  if (created.status !== 'swm-shared') {
    await node.cli(['ka', 'share', name, '-c', contextGraphId])
  }
  return { id, outputSha256, path, name, ...created }
}

/**
 * Reconcile billed calls against the graph.
 *
 * This is the check that keeps the quarantine claim honest: every render the
 * platform billed us for must have a derivation edge. Anything billed but
 * unrecorded is an orphan, and an orphan means the blast radius is understated.
 */
export function reconcile({ billedJobs = [], derivations = [] }) {
  const bySession = new Set(derivations.map(d => d.sessionId).filter(Boolean))
  const orphans = billedJobs.filter(j => !bySession.has(j.jobId))
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
