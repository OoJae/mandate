/**
 * Read what a DKG node knows about a subject, a grant or a file, and establish
 * who published each piece of it.
 *
 * The gate and the verifier are pure; this is the only module that queries a
 * node. It never reads a whole context graph. Grants and revocations for a
 * subject can only come from the subject's own address, and derivations that
 * count only from trusted producers, so each read is scoped to one publisher's
 * Verifiable Memory — nobody else publishing into an open context graph can
 * grow it, hide a revocation in it, or push it past its row limit.
 *
 * DKG v10.0.16 intermittently leaves whole named graphs out of query results
 * (docs/SPIKES.md). Anchored data is append-only and the fault only omits, so
 * results from repeated attempts are merged, and a read is used only once the
 * merged result is complete by the node's own count and each anchor's declared
 * triple count. Otherwise the read is marked inconsistent: the gate refuses and
 * the verifier answers INCONCLUSIVE.
 */
import * as Q from './queries.mjs'
import { ReadTruncatedError } from './dkg.mjs'
import {
  anchorsFromMeta, checkConsistency, reduceSlice, grantIriAddress, checkReturnedGraphs,
} from './provenance.mjs'
import { asIri, asString, asInteger, subjectAddress, normAddress, normSha256 } from './rdf-term.mjs'
import { remember } from './state-store.mjs'

export const READ_DEFAULTS = Object.freeze({ attempts: 4, backoffMs: 250, max: 5000 })

const wait = ms => new Promise(r => setTimeout(r, ms))
const rowKey = r => JSON.stringify([r.g ?? null, r.s, r.p, r.o, r.v ?? null])
const errorText = e => e?.message ?? String(e)

/** The address a context graph id is namespaced under. */
export const contextGraphAddress = id => Q.assertContextGraphId(id).split('/')[0].toLowerCase()

function vmPath(contextGraphId, graph) {
  const prefix = Q.vmPrefix(contextGraphId)
  if (typeof graph !== 'string' || !graph.startsWith(prefix)) return null
  const m = graph.slice(prefix.length).match(/^(0x[0-9a-f]{40})\/(\d+)$/)
  return m ? { publisher: m[1], number: m[2] } : null
}

/**
 * Read one publisher's Verifiable Memory in one context graph.
 *
 * Returns the accepted objects, forgeries, and a consistency verdict. Never
 * throws for node faults — an unreachable node is an inconsistent read — but
 * does throw for programming errors such as an invalid context graph id.
 */
export async function readPublisher(node, {
  contextGraphId, publisher, role, trustedProducers = [], knownUals = [],
  attempts = READ_DEFAULTS.attempts, backoffMs = READ_DEFAULTS.backoffMs, max = READ_DEFAULTS.max, sleep = wait,
}) {
  const address = normAddress(publisher)
  if (!address) throw new Error(`invalid publisher address: ${publisher}`)
  const prefix = Q.vmPublisherPrefix(contextGraphId, address)
  const meta = new Map()
  const graphs = new Map()
  let visible = -1
  let lastError = null
  let result = null
  let used = 0

  for (let i = 0; i < attempts; i++) {
    used = i + 1
    if (i > 0) await sleep(backoffMs * 2 ** (i - 1))
    try {
      const [metaRows, countRows, contentRows] = await Promise.all([
        node.queryJson(Q.metaQuery(contextGraphId, { limit: max, publisher: address }), { contextGraphId, max }),
        node.queryJson(Q.graphCountQuery(prefix), { contextGraphId, max }),
        node.queryJson(Q.prefixContentQuery(prefix, { limit: max }), { contextGraphId, max }),
      ])
      for (const r of metaRows) meta.set(rowKey(r), r)
      const n = asInteger(countRows[0]?.n)
      if (Number.isFinite(n)) visible = Math.max(visible, n)
      const byGraph = new Map()
      for (const r of contentRows) {
        const g = asIri(r.g)
        if (!g) continue
        if (!byGraph.has(g)) byGraph.set(g, new Map())
        byGraph.get(g).set(rowKey(r), r)
      }
      // A graph comes back whole or not at all; keep the fullest copy seen.
      for (const [g, rows] of byGraph) {
        if ((graphs.get(g)?.size ?? -1) < rows.size) graphs.set(g, rows)
      }
    } catch (e) {
      if (e instanceof ReadTruncatedError) {
        return failedRead({ contextGraphId, publisher: address, role, attempts: i + 1,
          reason: `more than ${max} rows under ${prefix}; refusing to decide from a partial read` })
      }
      lastError = e
      continue
    }

    const { anchors, problems } = anchorsFromMeta([...meta.values()], contextGraphId)
    const pendingGraphs = new Set(problems.map(p => p.graph))
    const contentRows = [...graphs.values()].flatMap(rows => [...rows.values()])
    const consistency = checkConsistency({
      prefix, anchors, contentRows, visibleGraphCount: visible < 0 ? undefined : visible, knownUals, pendingGraphs,
    })
    if (visible < 0 && consistency.ok) Object.assign(consistency, { ok: false, reason: 'the node did not report a graph count' })
    result = { anchors, problems, pendingGraphs, contentRows, consistency }
    // An empty answer is also what a dropped read looks like, so it is only
    // believed once every attempt agrees.
    if (consistency.ok && (anchors.size > 0 || i === attempts - 1)) break
  }

  if (!result) {
    return failedRead({ contextGraphId, publisher: address, role, attempts,
      reason: `${node.name ?? 'node'} did not answer: ${errorText(lastError)}` })
  }
  const { anchors, problems, pendingGraphs, contentRows, consistency } = result
  const accepted = contentRows.filter(r => !pendingGraphs.has(asIri(r.g)) || anchors.has(asIri(r.g)))
  const slice = reduceSlice({ role, anchors, contentRows: accepted, trustedProducers })
  return {
    contextGraphId, publisher: address, role, prefix,
    anchors: [...anchors.values()],
    pendingGraphs: [...pendingGraphs],
    ...slice,
    warnings: [...slice.warnings, ...problems.map(p => `${p.ual} is not a confirmed anchor (${p.reason}); its content is ignored`)],
    consistency: { ...consistency, attempts: used },
  }
}

function failedRead({ contextGraphId, publisher, role, attempts, reason }) {
  return {
    contextGraphId, publisher, role, prefix: null, anchors: [], pendingGraphs: [], grants: [], states: [], derivations: [],
    forgeries: [], warnings: [], consistency: { ok: false, reason, attempts },
  }
}

/* ------------------------------------------------------------------------- */
/* Discovery outside the publisher's own prefix                               */
/* ------------------------------------------------------------------------- */

/** Query once, returning rows or null on a node fault. Truncation propagates. */
async function tryQuery(node, sparql, opts) {
  try {
    return await node.queryJson(sparql, opts)
  } catch (e) {
    if (e instanceof ReadTruncatedError) throw e
    return null
  }
}

/**
 * Look for state rows about `grantIds` outside the grantor's own graphs.
 *
 * - Verifiable Memory under another address: a forgery, reported.
 * - Shared memory: unanchored, so a warning only.
 * - A merged view graph (`<cg>/context/<id>`) holding a state with no copy in
 *   any Verifiable Memory graph: its publisher cannot be established, so it is
 *   treated as a revocation. This only happens when a node holds confirmed data
 *   outside its Verifiable Memory graphs; a stranger's published state always
 *   has its Verifiable Memory copy, and is judged by its publisher instead.
 */
async function discoverStates(node, { grantsCg, derivationsCgs, grantIds, grantorReads, attempts, backoffMs, max, sleep }) {
  const rows = new Map()
  const failures = []
  const vmStateIds = () => new Set([
    ...grantorReads.flatMap(r => [...r.states, ...r.forgeries].map(x => x.id)),
    ...[...rows.values()].filter(r => r.graph.includes('/_verifiable_memory/')).map(r => r.s),
  ])
  const queries = [
    { cg: grantsCg, opts: { view: 'verifiable-memory' } },
    { cg: grantsCg, opts: { includeSharedMemory: true } },
    ...derivationsCgs.map(cg => ({ cg, opts: {} })),
  ]
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(backoffMs * 2 ** (i - 1))
    let answered = true
    for (const { cg, opts } of queries) {
      const got = await tryQuery(node, Q.stateSubjectsQuery(cg, grantIds, { limit: max }), { contextGraphId: cg, max, ...opts })
      if (!got) { answered = false; continue }
      for (const r of got) {
        const graph = asIri(r.g)
        const s = asIri(r.s)
        const o = asIri(r.o)
        if (!graph || !s || !o) continue
        rows.set(JSON.stringify([graph, s, o, r.v ?? null]), { cg, graph, s, o, value: r.v === undefined ? null : asString(r.v) })
      }
    }
    const known = vmStateIds()
    const unexplained = [...rows.values()].filter(r => r.graph.includes('/context/') && !known.has(r.s))
    if (answered && unexplained.length === 0) break
    if (!answered && i === attempts - 1) failures.push('state discovery queries did not all answer')
  }
  return { rows: [...rows.values()], failures }
}

async function discoverGrants(node, { contextGraphs, subject, max }) {
  const rows = []
  for (const cg of contextGraphs) {
    const got = await tryQuery(node, Q.grantSubjectsQuery(cg, subject, { limit: max }), { contextGraphId: cg, max })
    for (const r of got ?? []) {
      const graph = asIri(r.g)
      const s = asIri(r.s)
      if (graph && s) rows.push({ cg, graph, s })
    }
  }
  return rows
}

const ualPrefixOf = anchors => anchors[0]?.ual.replace(/\/0x[0-9a-fA-F]{40}\/\d+$/, '') ?? null

/* ------------------------------------------------------------------------- */
/* Knowledge                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Everything the gate or the verifier needs for one question.
 *
 * @param {DkgNode} node
 * @param {object} cfg
 * @param {string} cfg.grantsCg
 * @param {string[]} [cfg.derivationsCgs]
 * @param {string[]} [cfg.trustedProducers]  default: the derivations graphs' own addresses
 * @param {{load, save}} [cfg.stateStore]    remembers anchors and revocations between reads
 * @param {object} scope  exactly one of { subject }, { grantId }, { sha256 }
 */
export async function readKnowledge(node, cfg, scope = {}) {
  const grantsCg = Q.assertContextGraphId(cfg.grantsCg)
  const derivationsCgs = (cfg.derivationsCgs ?? []).map(Q.assertContextGraphId)
  const trustedProducers = (cfg.trustedProducers ?? derivationsCgs.map(contextGraphAddress)).map(a => {
    const n = normAddress(a)
    if (!n) throw new Error(`invalid trusted producer address: ${a}`)
    return n
  })
  const opts = {
    attempts: cfg.attempts ?? READ_DEFAULTS.attempts,
    backoffMs: cfg.backoffMs ?? READ_DEFAULTS.backoffMs,
    max: cfg.max ?? READ_DEFAULTS.max,
    sleep: cfg.sleep ?? wait,
  }
  const store = cfg.stateStore ?? null
  const records = new Map()
  const record = cg => {
    if (!records.has(cg)) records.set(cg, store ? store.load(cg) : { knownUals: {}, revocations: {} })
    return records.get(cg)
  }

  const scopes = ['subject', 'grantId', 'sha256'].filter(k => scope[k] !== undefined)
  if (scopes.length !== 1) throw new Error('readKnowledge needs exactly one of subject, grantId or sha256')
  const warnings = []
  const reads = []

  const read = async (cg, publisher, role) => {
    const r = await readPublisher(node, {
      contextGraphId: cg, publisher, role, trustedProducers, knownUals: record(cg).knownUals[publisher] ?? [], ...opts,
    })
    reads.push(r)
    return r
  }

  // Derivations from trusted producers: spend for a subject's grants, the
  // blast radius of a grant, or the edges for a file.
  const derivationReads = []
  for (const cg of derivationsCgs) {
    for (const producer of trustedProducers) derivationReads.push(await read(cg, producer, 'derivations'))
  }

  // Grantors whose graphs answer the question.
  let grantors = []
  let sha256 = null
  if (scope.subject !== undefined) {
    const a = subjectAddress(scope.subject)
    if (a) grantors = [a]
    else warnings.push(`subject ${JSON.stringify(String(scope.subject).slice(0, 80))} is not self-certifying (0x<address>:<name>); no grant can match it`)
  } else if (scope.grantId !== undefined) {
    const a = grantIriAddress(scope.grantId)
    if (a) grantors = [a]
    else warnings.push(`grant id ${JSON.stringify(String(scope.grantId).slice(0, 80))} is not a current-format grant id`)
  } else {
    sha256 = normSha256(scope.sha256)
    if (!sha256) throw new Error('sha256 must be 64 hex characters')
    const cited = derivationReads.flatMap(r => r.derivations).filter(d => d.outputSha256 === sha256).map(d => grantIriAddress(d.authorizedUnder))
    grantors = [...new Set(cited.filter(Boolean))]
  }
  const grantorReads = []
  for (const a of grantors) grantorReads.push(await read(grantsCg, a, 'grants'))

  const grants = grantorReads.flatMap(r => r.grants)
  const states = grantorReads.flatMap(r => r.states)
  const forgeries = [...grantorReads, ...derivationReads].flatMap(r => r.forgeries)
  let derivations = derivationReads.flatMap(r => r.derivations)
  for (const r of reads) warnings.push(...r.warnings)
  const allAnchors = reads.flatMap(r => r.anchors)
  const ualPrefix = ualPrefixOf(allAnchors)
  const failures = reads.filter(r => !r.consistency.ok).map(r => `${r.role} of ${r.publisher}: ${r.consistency.reason}`)

  // The grant ids this question turns on.
  const grantIds = scope.subject !== undefined ? grants.filter(g => g.subject === scope.subject).map(g => g.id)
    : scope.grantId !== undefined ? (grantIriAddress(scope.grantId) ? [scope.grantId] : [])
    : [...new Set(derivations.filter(d => d.outputSha256 === sha256).map(d => d.authorizedUnder))]

  const discovered = []
  try {
    if (grantIds.length) {
      const { rows, failures: f } = await discoverStates(node, {
        grantsCg, derivationsCgs, grantIds: grantIds.slice(0, 50), grantorReads, ...opts,
      })
      warnings.push(...f)
      const vmIds = new Set([...states, ...forgeries].map(x => x.id))
      for (const row of rows) if (row.graph.includes('/_verifiable_memory/')) vmIds.add(row.s)
      const seen = new Set()
      for (const row of rows) {
        const key = `${row.graph} ${row.s}`
        if (seen.has(key)) continue
        seen.add(key)
        const owner = grantIriAddress(row.o)
        const path = vmPath(row.cg, row.graph)
        if (path) {
          if (row.cg === grantsCg && path.publisher === owner) {
            // The grantor's own graph: it must already be in the grantor read.
            const inRead = [...states, ...forgeries].some(x => x.id === row.s)
              || grantorReads.some(r => r.pendingGraphs.includes(row.graph))
            if (!inRead) failures.push(`state ${row.s} is visible in ${row.graph} but missing from the grantor read`)
            continue
          }
          discovered.push({
            kind: row.cg === grantsCg ? 'state-not-by-grantor' : 'misplaced-state',
            detail: row.cg === grantsCg
              ? `published by ${path.publisher} for a grant belonging to ${owner}`
              : `a state assertion in a derivations graph is never accepted`,
            id: row.s, graph: row.graph, publisher: path.publisher, cg: row.cg,
            ual: ualPrefix ? `${ualPrefix}/${path.publisher}/${path.number}` : null, txHash: null,
            claims: { stateOf: [row.o], state: row.value === null ? [] : [row.value] },
          })
        } else if (row.graph.startsWith(`${Q.cgIri(row.cg)}/_shared_memory/`)) {
          if (row.value !== 'active') {
            warnings.push(`an unanchored revocation of ${row.o} is in shared memory (${row.graph}); it takes effect only once anchored`)
          }
        } else if (row.cg === grantsCg && row.value !== 'active' && !vmIds.has(row.s)) {
          states.push({
            id: row.s, ual: null, txHash: null, graph: row.graph, publisher: null, stateOf: row.o,
            state: 'revoked', stateAuthor: null, stateAt: null, materializedVersion: null, tier: 'context',
          })
          warnings.push(`a revocation of ${row.o} appears only in the merged view ${row.graph}; its publisher cannot be established, so it is honoured`)
        }
      }
    }
    if (scope.subject !== undefined && subjectAddress(scope.subject)) {
      for (const row of await discoverGrants(node, { contextGraphs: [grantsCg, ...derivationsCgs], subject: scope.subject, max: opts.max })) {
        const path = vmPath(row.cg, row.graph)
        if (!path) continue
        if (row.cg === grantsCg && path.publisher === subjectAddress(scope.subject)) continue
        if (forgeries.some(f => f.graph === row.graph && f.id === row.s)) continue
        discovered.push({
          kind: row.cg === grantsCg ? 'grant-not-by-subject' : 'misplaced-grant',
          detail: row.cg === grantsCg
            ? `published by ${path.publisher} for a subject belonging to ${subjectAddress(scope.subject)}`
            : 'a grant in a derivations graph is never accepted',
          id: row.s, graph: row.graph, publisher: path.publisher, cg: row.cg,
          ual: ualPrefix ? `${ualPrefix}/${path.publisher}/${path.number}` : null, txHash: null,
          claims: { subject: [scope.subject] },
        })
      }
    }
    if (sha256) {
      for (const cg of derivationsCgs) {
        const got = await tryQuery(node, Q.derivationsBySha256Query(Q.vmPrefix(cg), sha256, { limit: opts.max }), { contextGraphId: cg, max: opts.max })
        const rows = (got ?? []).filter(r => {
          const p = vmPath(cg, asIri(r.g))
          return p && !trustedProducers.includes(p.publisher)
        })
        if (!rows.length) continue
        const uals = [...new Set(rows.map(r => vmPath(cg, asIri(r.g))).map(p => ualPrefix ? `${ualPrefix}/${p.publisher}/${p.number}` : null))].filter(Boolean)
        const metaRows = uals.length ? await tryQuery(node, Q.metaForUalsQuery(cg, uals.slice(0, 50), { limit: opts.max }), { contextGraphId: cg, max: opts.max }) : []
        const { anchors } = anchorsFromMeta(metaRows ?? [], cg)
        const complete = checkReturnedGraphs({ anchors, contentRows: rows })
        if (!complete.ok) warnings.push(`untrusted derivation edges for this file were read incompletely: ${complete.reason}`)
        const slice = reduceSlice({ role: 'derivations', anchors, contentRows: rows, trustedProducers: [] })
        derivations = [...derivations, ...slice.derivations]
        discovered.push(...slice.forgeries)
      }
    }
  } catch (e) {
    if (!(e instanceof ReadTruncatedError)) throw e
    failures.push(`a discovery query returned more than ${opts.max} rows; refusing to decide from a partial read`)
  }

  // Attach transactions to discovered forgeries, where their anchors can be read.
  const byCg = new Map()
  for (const f of discovered) if (f.ual && !f.txHash) {
    if (!byCg.has(f.cg)) byCg.set(f.cg, [])
    byCg.get(f.cg).push(f)
  }
  for (const [cg, list] of byCg) {
    const uals = [...new Set(list.map(f => f.ual))].slice(0, 50)
    const metaRows = await tryQuery(node, Q.metaForUalsQuery(cg, uals, { limit: opts.max }), { contextGraphId: cg, max: opts.max })
      .catch(() => null)
    const { anchors } = anchorsFromMeta(metaRows ?? [], cg)
    const byUal = new Map([...anchors.values()].map(a => [a.ual, a]))
    for (const f of list) {
      const a = byUal.get(f.ual)
      f.anchored = Boolean(a)
      f.txHash = a?.txHash ?? null
    }
  }
  forgeries.push(...discovered.map(({ cg, ...f }) => f))

  // Local memory: revocations accepted before are never forgotten.
  const rec = record(grantsCg)
  for (const id of grantIds) {
    const r = rec.revocations[id]
    if (r && !states.some(s => s.stateOf === id && s.tier === 'vm' && s.publisher === r.publisher)) {
      states.push({ ...r, graph: null, state: 'revoked', stateAuthor: null, materializedVersion: null, tier: 'vm', source: 'local-state' })
      warnings.push(`revocation ${r.ual ?? r.id} of ${id} was seen before but is missing from this read; it is still honoured`)
    }
  }

  const consistency = { ok: failures.length === 0, reason: failures[0] ?? null, attempts: Math.max(0, ...reads.map(r => r.consistency.attempts ?? 0)) }
  if (store && consistency.ok) {
    for (const r of reads) {
      const next = remember(record(r.contextGraphId), {
        publisher: r.publisher,
        uals: r.anchors.map(a => a.ual),
        revocations: r.states.filter(s => s.state === 'revoked'),
      })
      records.set(r.contextGraphId, next)
      store.save(r.contextGraphId, next)
    }
  }

  return {
    scope: { ...scope },
    anchors: allAnchors,
    grants,
    states,
    derivations,
    forgeries,
    warnings: [...new Set(warnings)],
    trustedProducers,
    consistency,
    reads: reads.map(r => ({ contextGraphId: r.contextGraphId, publisher: r.publisher, role: r.role, anchors: r.anchors.length, consistency: r.consistency })),
  }
}
