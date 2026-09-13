/**
 * Build Knowledge Asset rows exactly as a DKG v10.0.16 node returns them from
 * /api/query: content cells are the same wire terms Mandate writes (bare IRIs,
 * N-Triples literals), and _meta rows mirror test/fixtures/live/*-meta.json.
 */
import { grantToQuads, stateToQuads, derivationToQuads } from '../../src/rdf.mjs'
import { DKG, PROV_ATTRIBUTED, vmPrefix } from '../../src/queries.mjs'

export const GRANTS_CG = '0xeD1eeB64CaC09874257F05Fd6B51A55695ad0B69/mandate-grants'
export const DERIVS_CG = '0x8EaA4857B22dddbfb5ebC476087FEc39336e0CB5/mandate-derivations'
export const ANA = '0xed1eeb64cac09874257f05fd6b51a55695ad0b69'
export const PRODUCER = '0x8eaa4857b22dddbfb5ebc476087fec39336e0cb5'
export const STRANGER = '0x5555555555555555555555555555555555555555'
export const did = a => `did:dkg:agent:${a}`
const XSD_INT = '^^<http://www.w3.org/2001/XMLSchema#integer>'

let counter = 100
export const nextNumber = () => String(++counter)
const nonce = n => String(n).padStart(16, '0').slice(-16)

/** Rows for one anchored KA holding `quads`, published by `publisher` into `cg`. */
export function ka({ cg, publisher, quads, number = nextNumber(), attributed = false, status = 'confirmed',
  declaredCount, assertionGraph, extraContent = [] }) {
  const graph = `${vmPrefix(cg)}${publisher}/${number}`
  const ual = `did:dkg:base:84532/${publisher}/${number}`
  const contentRows = [...quads, ...extraContent].map(x => ({ g: graph, s: x.subject, p: x.predicate, o: x.object }))
  const metaRows = [
    { s: ual, p: `${DKG}kaUal`, o: ual },
    { s: ual, p: `${DKG}assertionGraph`, o: assertionGraph ?? graph },
    { s: ual, p: `${DKG}status`, o: `"${status}"` },
    { s: ual, p: `${DKG}confirmationKind`, o: '"transaction"' },
    { s: ual, p: `${DKG}transactionHash`, o: `"0x${'ab'.repeat(32)}"` },
    { s: ual, p: `${DKG}materializedVersion`, o: `"${46770000 + Number(number)}:0"` },
    { s: ual, p: `${DKG}publicTripleCount`, o: `"${declaredCount ?? contentRows.length}"${XSD_INT}` },
  ]
  if (attributed) metaRows.push({ s: ual, p: PROV_ATTRIBUTED, o: did(typeof attributed === 'string' ? attributed : publisher) })
  return { graph, ual, contentRows, metaRows }
}

export const grant = (over = {}) => {
  const owner = over.owner ?? ANA
  const local = over.local ?? 'ana'
  const n = ++counter
  return {
    id: over.id ?? `urn:mandate:grant:${owner}:${local}:${nonce(n)}`,
    grantor: over.grantor ?? did(owner),
    subject: over.subject ?? `${owner}:${local}`,
    permitsCapability: over.permitsCapability ?? ['talking-head', 'sync-lipsync-v3'],
    permitsUseClass: over.permitsUseClass ?? ['advertising'],
    forbidsUseClass: over.forbidsUseClass ?? ['political'],
    territory: over.territory ?? ['GB'],
    validFrom: over.validFrom ?? '2026-09-01T00:00:00Z',
    validUntil: over.validUntil ?? '2026-12-01T00:00:00Z',
    maxSpendUsd: over.maxSpendUsd === undefined ? 5 : over.maxSpendUsd,
  }
}

export const grantKa = (g, { publisher = ANA, ...rest } = {}) => ka({ cg: GRANTS_CG, publisher, quads: grantToQuads(g), ...rest })

export const revocationKa = (grantId, { publisher = ANA, author = publisher, at = '2026-09-13T10:00:00Z', ...rest } = {}) =>
  ka({ cg: GRANTS_CG, publisher, quads: stateToQuads({ id: `urn:mandate:state:${nonce(++counter)}`, stateOf: grantId, state: 'revoked', stateAuthor: did(author), stateAt: at }), ...rest })

export const derivation = (over = {}) => {
  const sha = over.outputSha256 ?? 'f'.repeat(64)
  return {
    id: over.id ?? `urn:mandate:derivation:${sha.slice(0, 16)}:${nonce(++counter)}`,
    outputSha256: sha,
    servedCapability: over.servedCapability ?? 'sync-lipsync-v3',
    authorizedUnder: over.authorizedUnder,
    derivedAt: over.derivedAt ?? '2026-09-13T11:00:00Z',
    jobId: over.jobId ?? 'mjob_test',
    billedUsd: over.billedUsd === undefined ? 0.84 : over.billedUsd,
  }
}

export const derivationKa = (d, { publisher = PRODUCER, cg = DERIVS_CG, ...rest } = {}) => ka({ cg, publisher, quads: derivationToQuads(d), ...rest })

/** Merge several KAs into one read of a context graph. */
export const read = (...kas) => ({
  contentRows: kas.flatMap(k => k.contentRows),
  metaRows: kas.flatMap(k => k.metaRows),
})

/**
 * Knowledge as readKnowledge would return it for these KAs, via the real
 * reducer, with a consistent read. Grants-CG KAs and derivations-CG KAs are
 * told apart by the graph they were built for.
 */
export async function knowledgeOf(kas, { trustedProducers = [PRODUCER], consistency = { ok: true, reason: null, attempts: 1 } } = {}) {
  const { anchorsFromMeta, reduceSlice } = await import('../../src/provenance.mjs')
  const out = { grants: [], states: [], derivations: [], forgeries: [], warnings: [], anchors: [], trustedProducers, consistency }
  for (const [cg, role] of [[GRANTS_CG, 'grants'], [DERIVS_CG, 'derivations']]) {
    const mine = kas.filter(k => k.graph.includes(`${cg}/`))
    const { anchors } = anchorsFromMeta(mine.flatMap(k => k.metaRows), cg)
    const slice = reduceSlice({ role, anchors, contentRows: mine.flatMap(k => k.contentRows), trustedProducers })
    for (const f of ['grants', 'states', 'derivations', 'forgeries', 'warnings']) out[f].push(...slice[f])
    out.anchors.push(...anchors.values())
  }
  return out
}
