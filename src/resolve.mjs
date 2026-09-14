/**
 * Read what a DKG node knows about a subject, a grant or a file, and establish
 * who published each piece of it.
 *
 * The gate and the verifier are pure; this is the only module that queries a
 * node. It never reads a whole context graph. Grants and revocations for a
 * subject can only come from the subject's own address, and derivations that
 * count only from trusted producers, so each read is scoped to one publisher's
 * Verifiable Memory — nobody else publishing into an open context graph can
 * grow it or hide a revocation in it. Those reads are paged, so a large
 * publisher is read in full. Discovery queries outside those prefixes are the
 * exception: someone with write access to the graph can overflow them, which
 * refuses rather than permits (see "Discovery" below).
 *
 * DKG v10.0.16 intermittently leaves whole named graphs out of query results
 * (docs/SPIKES.md). Anchored data is append-only and the fault only omits, so
 * results from repeated attempts are merged, and a read is used only once the
 * merged result is complete by the node's own count and each anchor's declared
 * triple count. Otherwise the read is marked inconsistent: the gate refuses and
 * the verifier answers INCONCLUSIVE.
 */
import * as Q from './queries.mjs'
import { ReadTruncatedError, DkgHttpError } from './dkg.mjs'
import {
  anchorsFromMeta, checkConsistency, reduceSlice, grantIriAddress, checkReturnedGraphs,
} from './provenance.mjs'
import { asIri, asString, asInteger, subjectAddress, normAddress, normSha256 } from './rdf-term.mjs'
import { remember } from './state-store.mjs'

/**
 * `max` is the most rows one query may return: prefix reads are paged in steps
 * of `max`, and a discovery query past it fails the read. `maxRows` caps a whole
 * paged read of one publisher's prefix, so a runaway graph cannot exhaust memory.
 */
export const READ_DEFAULTS = Object.freeze({ attempts: 4, backoffMs: 250, max: 5000, maxRows: 250000 })

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
 * Every row of an ordered query, one page of `max` rows at a time. Each page
 * asks for one row more than it keeps, to know whether another page follows.
 * Past `maxRows` in total it throws ReadTruncatedError.
 */
async function readPages(node, build, { contextGraphId, max, maxRows }) {
  const rows = []
  for (let offset = 0; ; offset += max) {
    const page = await node.queryJson(build({ limit: max, offset }), { contextGraphId, max: max + 1 })
    rows.push(...page.slice(0, max))
    if (page.length <= max) return rows
    if (rows.length >= maxRows) throw new ReadTruncatedError(`more than ${maxRows} rows`)
  }
}

/**
 * Read one publisher's Verifiable Memory in one context graph.
 *
 * Returns the accepted objects, forgeries, and a consistency verdict. Never
 * throws for node faults — an unreachable node is an inconsistent read — but
 * does throw for programming errors such as an invalid context graph id.
 *
 * Only ever used for prefixes whose content decides: the grantor's and trusted
 * producers'. So an anchor that stays unconfirmed, or an object that cannot be
 * read, ends the read inconsistent rather than being set aside. Deliberate
 * trade-off: a publish left tentative in one's own prefix blocks decisions for
 * that publisher until it confirms, because a `_meta` record missing one row
 * looks exactly like that, and the content behind it may be a revocation.
 */
export async function readPublisher(node, {
  contextGraphId, publisher, role, trustedProducers = [], knownUals = [],
  attempts = READ_DEFAULTS.attempts, backoffMs = READ_DEFAULTS.backoffMs, max = READ_DEFAULTS.max,
  maxRows = READ_DEFAULTS.maxRows, sleep = wait,
}) {
  const address = normAddress(publisher)
  if (!address) throw new Error(`invalid publisher address: ${publisher}`)
  const prefix = Q.vmPublisherPrefix(contextGraphId, address)
  const meta = new Map()
  const graphs = new Map()
  let visible = -1
  let lastError = null
  let failed = 0
  let unreadableGraphRows = 0
  let result = null
  let used = 0

  for (let i = 0; i < attempts; i++) {
    used = i + 1
    if (i > 0) await sleep(backoffMs * 2 ** (i - 1))
    try {
      const [metaRows, countRows, contentRows] = await Promise.all([
        readPages(node, o => Q.metaQuery(contextGraphId, { ...o, publisher: address }), { contextGraphId, max, maxRows }),
        node.queryJson(Q.graphCountQuery(prefix), { contextGraphId, max }),
        readPages(node, o => Q.prefixContentQuery(prefix, o), { contextGraphId, max, maxRows }),
      ])
      for (const r of metaRows) meta.set(rowKey(r), r)
      const n = asInteger(countRows[0]?.n)
      if (Number.isFinite(n)) visible = Math.max(visible, n)
      // Anchored graphs are append-only and the node's fault only omits, so
      // rows seen on any attempt or page are unioned.
      for (const r of contentRows) {
        const g = asIri(r.g)
        if (!g) { unreadableGraphRows++; continue }
        if (!graphs.has(g)) graphs.set(g, new Map())
        graphs.get(g).set(rowKey(r), r)
      }
    } catch (e) {
      if (e instanceof ReadTruncatedError) {
        return failedRead({ contextGraphId, publisher: address, role, attempts: i + 1,
          reason: `the read under ${prefix} is over its row limit (${e.message}); refusing to decide from a partial read` })
      }
      lastError = e
      failed++
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
    // believed once every attempt agrees; and an unconfirmed anchor may be a
    // record with one row missing, so it is retried too.
    if (consistency.ok && anchors.size > 0 && problems.length === 0) break
  }

  if (!result) {
    return failedRead({ contextGraphId, publisher: address, role, attempts,
      reason: `${node.name ?? 'node'} did not answer: ${errorText(lastError)}` })
  }
  const { anchors, problems, pendingGraphs, contentRows, consistency } = result
  const accepted = contentRows.filter(r => !pendingGraphs.has(asIri(r.g)) || anchors.has(asIri(r.g)))
  const slice = reduceSlice({ role, anchors, contentRows: accepted, trustedProducers })
  const fail = reason => { if (consistency.ok) Object.assign(consistency, { ok: false, reason }) }
  if (problems.length) fail(`${problems[0].ual} under ${prefix} is not a confirmed anchor after ${used} attempts (${problems[0].reason})`)
  if (unreadableGraphRows) fail(`${unreadableGraphRows} row(s) under ${prefix} have an unreadable graph`)
  if (slice.unreadable.length) fail(`${slice.unreadable[0].ual ?? slice.unreadable[0].graph ?? prefix}: ${slice.unreadable[0].reason}`)
  if (failed && anchors.size === 0) {
    fail(`${failed} of ${used} attempts failed (${errorText(lastError)}); an empty read is believed only when every attempt answers`)
  }
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
    forgeries: [], warnings: [], unreadable: [], consistency: { ok: false, reason, attempts },
  }
}

/* ------------------------------------------------------------------------- */
/* Discovery outside the publisher's own prefix                               */
/* ------------------------------------------------------------------------- */

/*
 * Discovery queries scan a whole context graph, so anyone who can publish into
 * it can make them large. They use DISTINCT, so repeating a triple does not
 * multiply rows, but an asset with more than `max` distinct matching triples
 * still overflows one. Deliberate trade-off: an overflowing or failing
 * discovery query makes the read inconsistent (refuse / INCONCLUSIVE), because
 * the rows it would have returned include merged-view revocations. That lets a
 * party with write access to the graph deny service, never obtain a permit.
 */

class DiscoveryFailed extends Error {}

/** Query once, returning rows or null on a node fault. Truncation propagates. */
async function tryQuery(node, sparql, opts) {
  try {
    return await node.queryJson(sparql, opts)
  } catch (e) {
    if (e instanceof ReadTruncatedError) throw e
    return null
  }
}

const chunks = (list, size = 50) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size))

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
 *
 * Every query must answer on some attempt, or discovery fails. When the grantor
 * read holds states for these grants and this node materialises merged views
 * for that graph at all, the merged view must show at least one row: a view
 * that shows none has been left out of the answer, which is the node's omission
 * fault, and is retried like any other omission.
 *
 * Live v10.0.16 nodes materialise merged views only for data they published
 * themselves, so on any other node the view is legitimately empty. A one-row
 * probe decides whether the node holds any merged view for the graph; a node
 * that holds none can hold no merged-view-only revocation either. Deliberate
 * trade-off: a node that also leaves the probe's graph out of every attempt is
 * not caught by this check.
 */
async function discoverStates(node, { grantsCgs, derivationsCgs, grantIds, grantorReads, attempts, backoffMs, max, sleep }) {
  const rows = new Map()
  const failures = []
  const vmStateIds = () => new Set([
    ...grantorReads.flatMap(r => [...r.states, ...r.forgeries].map(x => x.id)),
    ...[...rows.values()].filter(r => r.graph.includes('/_verifiable_memory/')).map(r => r.s),
  ])
  const ids = new Set(grantIds)
  const queries = [
    ...grantsCgs.flatMap(cg => [{ cg, opts: { view: 'verifiable-memory' } }, { cg, opts: { includeSharedMemory: true } }]),
    ...derivationsCgs.map(cg => ({ cg, opts: {} })),
  ].flatMap(q => chunks(grantIds).map(batch => ({ ...q, batch })))
  queries.forEach((q, n) => { q.n = n })
  const answeredOnce = new Set()
  // The merged views that should show something: those of graphs whose grantor read holds a state about these grants.
  const expectView = new Set(grantorReads.filter(r => r.states.some(st => ids.has(st.stateOf) && st.tier === 'vm')).map(r => r.contextGraphId))
  const viewShown = cg => [...rows.values()].some(r => r.cg === cg && r.graph.startsWith(`${Q.cgIri(cg)}/context/`))
  const materialised = new Set()
  const probeAnswered = new Set()
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(backoffMs * 2 ** (i - 1))
    for (const cg of expectView) {
      if (materialised.has(cg)) continue
      const got = await tryQuery(node, Q.mergedViewProbeQuery(cg), { contextGraphId: cg, max, view: 'verifiable-memory' })
      if (!got) continue
      probeAnswered.add(cg)
      if (got.some(r => asIri(r.g)?.startsWith(`${Q.cgIri(cg)}/context/`))) materialised.add(cg)
    }
    for (const q of queries) {
      const got = await tryQuery(node, Q.stateSubjectsQuery(q.cg, q.batch, { limit: max }), { contextGraphId: q.cg, max, ...q.opts })
      if (!got) continue
      answeredOnce.add(q.n)
      for (const r of got) {
        const graph = asIri(r.g)
        const s = asIri(r.s)
        const o = asIri(r.o)
        if (!graph || !s || !o) continue
        rows.set(JSON.stringify([graph, s, o, r.v ?? null]), { cg: q.cg, graph, s, o, value: r.v === undefined ? null : asString(r.v) })
      }
    }
    const known = vmStateIds()
    const unexplained = [...rows.values()].filter(r => r.graph.includes('/context/') && !known.has(r.s))
    // A view that shows a row proves the node materialises it, whatever the probe said.
    for (const cg of expectView) if (viewShown(cg)) materialised.add(cg)
    const viewMissing = [...materialised].filter(cg => !viewShown(cg))
    const probesUnanswered = [...expectView].filter(cg => !probeAnswered.has(cg) && !materialised.has(cg))
    if (answeredOnce.size === queries.length && unexplained.length === 0 && viewMissing.length === 0 && probesUnanswered.length === 0) break
    if (i === attempts - 1) {
      if (answeredOnce.size !== queries.length) failures.push(`state discovery: ${queries.length - answeredOnce.size} of ${queries.length} queries never answered`)
      for (const cg of probesUnanswered) failures.push(`state discovery: the merged-view check for ${cg} never answered`)
      for (const cg of viewMissing) failures.push(`state discovery: the merged view of ${cg} was left out of every answer, though the grantor has published states for these grants`)
    }
  }
  return { rows: [...rows.values()], failures }
}

async function discoverGrants(node, { contextGraphs, subject, max }) {
  const rows = []
  for (const cg of contextGraphs) {
    const got = await tryQuery(node, Q.grantSubjectsQuery(cg, subject, { limit: max }), { contextGraphId: cg, max })
    if (!got) throw new DiscoveryFailed(`grant discovery in ${cg} did not answer`)
    for (const r of got) {
      const graph = asIri(r.g)
      const s = asIri(r.s)
      if (graph && s) rows.push({ cg, graph, s })
    }
  }
  return rows
}

const ualPrefixOf = anchors => anchors[0]?.ual.replace(/\/0x[0-9a-fA-F]{40}\/\d+$/, '') ?? null

/* ------------------------------------------------------------------------- */
/* Freshness                                                                   */
/* ------------------------------------------------------------------------- */

/** A reconcile counter as a non-negative integer, or null for anything else (null, '', '3.5', true). */
function ordinal(v) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? v : null
  if (typeof v === 'string' && /^(0|[1-9]\d{0,15})$/.test(v)) return Number(v)
  return null
}

/**
 * Is this node's copy of each context graph as long as the chain's?
 *
 * A node can stay subscribed and answer every query consistently while it has
 * silently stopped receiving another party's anchors (docs/SPIKES.md, S6c). A
 * stale node that is missing only a revocation would permit, so anything short
 * of a clear "current" is an inconsistent read: a watermark behind or ahead of
 * the head, a head or watermark that is not a number, and any HTTP error —
 * including 404 (not subscribed, or a mis-cased graph id), 409, 429 and 5xx.
 * Only 403, a token without node-admin rights, means the check cannot run at
 * all here; that is a warning. Deliberate trade-off: a node too old to have the
 * endpoint answers 404 and is refused along with the rest.
 */
export async function checkFreshness(node, contextGraphIds) {
  const failures = []
  const warnings = []
  const graphs = []
  const who = node.name ?? 'the node'
  for (const cg of contextGraphIds) {
    if (typeof node.reconcile !== 'function') {
      failures.push(`freshness of ${cg} cannot be checked: ${who} has no reconcile call`)
      continue
    }
    try {
      const r = await node.reconcile(cg)
      const head = ordinal(r?.headOrdinal)
      const have = ordinal(r?.watermarkAfter)
      graphs.push({ contextGraphId: cg, headOrdinal: head, watermark: have, status: r?.status ?? null })
      if (head === null || have === null) {
        failures.push(`freshness of ${cg} unknown: ${who} reported head ${JSON.stringify(r?.headOrdinal ?? null)} and watermark ${JSON.stringify(r?.watermarkAfter ?? null)}`)
      } else if (have < head) {
        failures.push(`stale view: ${who} holds ${have} of the ${head} assets anchored to ${cg} on-chain`)
      } else if (have > head || r?.status === 'watermark-ahead') {
        failures.push(`freshness of ${cg} unknown: ${who} holds ${have} assets but the chain reports ${head} (${r?.status ?? 'no status'})`)
      }
    } catch (e) {
      if (!(e instanceof DkgHttpError)) throw e
      const detail = String(e.body?.error ?? e.message).slice(0, 120)
      if (e.status === 403) warnings.push(`freshness of ${cg} not checked (403: ${detail})`)
      else failures.push(`freshness of ${cg} could not be established (${e.status || 'unreachable'}: ${detail})`)
    }
  }
  return { failures, warnings, graphs }
}

/**
 * Does the node hold these context graphs under exactly these ids? A graph id
 * whose address is written in another case, or a graph the node is not
 * subscribed to, reads as a consistent empty graph, which would say "no
 * revocations" and "no prior spend". Only asked about graphs that read empty.
 * A node that cannot list its subscriptions gives a warning.
 */
async function checkHeld(node, contextGraphIds) {
  const failures = []
  const warnings = []
  if (!contextGraphIds.length || typeof node.subscriptions !== 'function') return { failures, warnings }
  let list
  try {
    const body = await node.subscriptions()
    list = Array.isArray(body) ? body : body?.subscriptions
  } catch (e) {
    warnings.push(`could not confirm the node holds ${contextGraphIds.join(', ')}: ${String(e?.message ?? e).slice(0, 120)}`)
    return { failures, warnings }
  }
  if (!Array.isArray(list)) {
    warnings.push(`could not confirm the node holds ${contextGraphIds.join(', ')}: unexpected subscriptions answer`)
    return { failures, warnings }
  }
  for (const cg of contextGraphIds) {
    const ids = list.filter(x => x && x.subscribed !== false).map(x => x.contextGraphId)
    if (ids.includes(cg)) continue
    const other = ids.find(id => typeof id === 'string' && id.toLowerCase() === cg.toLowerCase())
    failures.push(other
      ? `context graph ${cg} is held by the node as ${other}; ids are case-sensitive, so this read would be empty`
      : `the node is not subscribed to context graph ${cg}, so its empty read proves nothing`)
  }
  return { failures, warnings }
}

/* ------------------------------------------------------------------------- */
/* Knowledge                                                                   */
/* ------------------------------------------------------------------------- */

const uniq = list => [...new Set(list)]

/** One entry per (UAL, id): the same record configured or read twice is still one record. */
function dedupeByUal(list) {
  const seen = new Map()
  for (const x of list) {
    const key = JSON.stringify([x.ual ?? x.graph ?? null, x.id ?? null, x.kind ?? null])
    if (!seen.has(key)) seen.set(key, x)
  }
  return [...seen.values()]
}

/**
 * Everything the gate or the verifier needs for one question.
 *
 * @param {DkgNode} node
 * @param {object} cfg
 * @param {string} [cfg.grantsCg]            one grants graph, or
 * @param {string[]} [cfg.grantsCgs]         several (both may be given; they are merged)
 * @param {string[]} [cfg.derivationsCgs]
 * @param {string[]} [cfg.trustedProducers]  default: the derivations graphs' own addresses
 * @param {{load, save}} [cfg.stateStore]    remembers anchors and revocations between reads
 * @param {boolean} [cfg.checkFreshness]     compare the node's copy of each graph with the chain first
 * @param {number} [cfg.max]                 rows per query page (default 5000)
 * @param {number} [cfg.maxRows]             rows in one publisher's whole prefix (default 250000)
 * @param {object} scope  exactly one of { subject }, { grantId }, { sha256 }
 *
 * `unresolvedGrants` lists grant ids cited by trusted derivations whose owner
 * has no configured grants graph namespaced under its address: whether they
 * stand cannot be decided from here. A grant missing from a configured graph
 * that was read consistently is not unresolved; it does not exist.
 */
export async function readKnowledge(node, cfg, scope = {}) {
  const grantsCgs = uniq([...(cfg.grantsCg === undefined ? [] : [cfg.grantsCg]), ...(cfg.grantsCgs ?? [])].map(Q.assertContextGraphId))
  if (!grantsCgs.length) throw new Error('readKnowledge needs grantsCg or grantsCgs')
  const derivationsCgs = uniq((cfg.derivationsCgs ?? []).map(Q.assertContextGraphId))
  const trustedProducers = uniq((cfg.trustedProducers ?? derivationsCgs.map(contextGraphAddress)).map(a => {
    const n = normAddress(a)
    if (!n) throw new Error(`invalid trusted producer address: ${a}`)
    return n
  }))
  const opts = {
    attempts: cfg.attempts ?? READ_DEFAULTS.attempts,
    backoffMs: cfg.backoffMs ?? READ_DEFAULTS.backoffMs,
    max: cfg.max ?? READ_DEFAULTS.max,
    maxRows: cfg.maxRows ?? READ_DEFAULTS.maxRows,
    sleep: cfg.sleep ?? wait,
  }
  if (!Number.isSafeInteger(opts.max) || opts.max < 1) throw new Error(`invalid read max: ${opts.max}`)
  if (!Number.isSafeInteger(opts.maxRows) || opts.maxRows < opts.max) throw new Error(`invalid read maxRows: ${opts.maxRows}`)
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
  let freshness = null
  if (cfg.checkFreshness) {
    freshness = await checkFreshness(node, uniq([...grantsCgs, ...derivationsCgs]))
    warnings.push(...freshness.warnings)
  }

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
    grantors = uniq(cited.filter(Boolean))
  }
  const grantorReads = []
  for (const a of grantors) for (const cg of grantsCgs) grantorReads.push(await read(cg, a, 'grants'))

  const grants = dedupeByUal(grantorReads.flatMap(r => r.grants))
  const states = dedupeByUal(grantorReads.flatMap(r => r.states))
  const forgeries = dedupeByUal([...grantorReads, ...derivationReads].flatMap(r => r.forgeries))
  let derivations = dedupeByUal(derivationReads.flatMap(r => r.derivations))
  for (const r of reads) warnings.push(...r.warnings)
  const allAnchors = dedupeByUal(reads.flatMap(r => r.anchors))
  const ualPrefix = ualPrefixOf(allAnchors)
  const failures = [...(freshness?.failures ?? []), ...reads.filter(r => !r.consistency.ok).map(r => `${r.role} of ${r.publisher}: ${r.consistency.reason}`)]

  // Graphs that read empty everywhere: make sure the node really holds them.
  const emptyCgs = uniq(reads.map(r => r.contextGraphId)).filter(cg => reads.filter(r => r.contextGraphId === cg).every(r => r.consistency.ok && r.anchors.length === 0))
  const held = await checkHeld(node, emptyCgs)
  failures.push(...held.failures)
  warnings.push(...held.warnings)

  // The grant ids this question turns on.
  const grantIds = scope.subject !== undefined ? uniq(grants.filter(g => g.subject === scope.subject).map(g => g.id))
    : scope.grantId !== undefined ? (grantIriAddress(scope.grantId) ? [scope.grantId] : [])
    : uniq(derivations.filter(d => d.outputSha256 === sha256).map(d => d.authorizedUnder))

  const discovered = []
  try {
    if (grantIds.length) {
      const { rows, failures: f } = await discoverStates(node, {
        grantsCgs, derivationsCgs, grantIds, grantorReads, ...opts,
      })
      failures.push(...f)
      const vmIds = new Set([...states, ...forgeries].map(x => x.id))
      for (const row of rows) if (row.graph.includes('/_verifiable_memory/')) vmIds.add(row.s)
      const seen = new Set()
      for (const row of rows) {
        const key = `${row.graph} ${row.s}`
        if (seen.has(key)) continue
        seen.add(key)
        const owner = grantIriAddress(row.o)
        const path = vmPath(row.cg, row.graph)
        const inGrants = grantsCgs.includes(row.cg)
        if (path && forgeries.some(f => f.graph === row.graph && f.id === row.s)) continue
        if (path) {
          if (inGrants && path.publisher === owner) {
            // The grantor's own graph: it must already be in the grantor read.
            const inRead = states.some(x => x.id === row.s && x.graph === row.graph)
              || grantorReads.some(r => r.pendingGraphs.includes(row.graph))
            if (!inRead) failures.push(`state ${row.s} is visible in ${row.graph} but missing from the grantor read`)
            continue
          }
          discovered.push({
            kind: inGrants ? 'state-not-by-grantor' : 'misplaced-state',
            detail: inGrants
              ? `published by ${path.publisher} for a grant belonging to ${owner}`
              : `a state assertion in a derivations graph is never accepted`,
            id: row.s, graph: row.graph, publisher: path.publisher, cg: row.cg,
            ual: ualPrefix ? `${ualPrefix}/${path.publisher}/${path.number}` : null, txHash: null,
            trusted: !inGrants && trustedProducers.includes(path.publisher),
            claims: { stateOf: [row.o], state: row.value === null ? [] : [row.value], subject: [], outputSha256: [], authorizedUnder: [], billedUsd: [] },
          })
        } else if (row.graph.startsWith(`${Q.cgIri(row.cg)}/_shared_memory/`)) {
          if (row.value !== 'active') {
            warnings.push(`an unanchored revocation of ${row.o} is in shared memory (${row.graph}); it takes effect only once anchored`)
          }
        } else if (inGrants && row.value !== 'active' && !vmIds.has(row.s)) {
          states.push({
            id: row.s, ual: null, txHash: null, graph: row.graph, publisher: null, stateOf: row.o,
            state: 'revoked', stateAuthor: null, stateAt: null, materializedVersion: null, tier: 'context',
          })
          warnings.push(`a revocation of ${row.o} appears only in the merged view ${row.graph}; its publisher cannot be established, so it is honoured`)
        }
      }
    }
    if (scope.subject !== undefined && subjectAddress(scope.subject)) {
      for (const row of await discoverGrants(node, { contextGraphs: uniq([...grantsCgs, ...derivationsCgs]), subject: scope.subject, max: opts.max })) {
        const path = vmPath(row.cg, row.graph)
        if (!path) continue
        const inGrants = grantsCgs.includes(row.cg)
        if (inGrants && path.publisher === subjectAddress(scope.subject)) continue
        if (forgeries.some(f => f.graph === row.graph && f.id === row.s)) continue
        discovered.push({
          kind: inGrants ? 'grant-not-by-subject' : 'misplaced-grant',
          detail: inGrants
            ? `published by ${path.publisher} for a subject belonging to ${subjectAddress(scope.subject)}`
            : 'a grant in a derivations graph is never accepted',
          id: row.s, graph: row.graph, publisher: path.publisher, cg: row.cg,
          ual: ualPrefix ? `${ualPrefix}/${path.publisher}/${path.number}` : null, txHash: null,
          trusted: !inGrants && trustedProducers.includes(path.publisher),
          claims: { subject: [scope.subject], stateOf: [], outputSha256: [], authorizedUnder: [], billedUsd: [] },
        })
      }
    }
    if (sha256) {
      for (const cg of derivationsCgs) {
        const got = await tryQuery(node, Q.derivationsBySha256Query(Q.vmPrefix(cg), sha256, { limit: opts.max }), { contextGraphId: cg, max: opts.max })
        if (!got) throw new DiscoveryFailed(`derivation discovery in ${cg} did not answer`)
        const rows = got.filter(r => {
          const p = vmPath(cg, asIri(r.g))
          return p && !trustedProducers.includes(p.publisher)
        })
        if (!rows.length) continue
        const uals = uniq(rows.map(r => vmPath(cg, asIri(r.g))).map(p => ualPrefix ? `${ualPrefix}/${p.publisher}/${p.number}` : null)).filter(Boolean)
        const metaRows = []
        for (const batch of chunks(uals)) {
          metaRows.push(...(await tryQuery(node, Q.metaForUalsQuery(cg, batch, { limit: opts.max }), { contextGraphId: cg, max: opts.max }) ?? []))
        }
        const { anchors } = anchorsFromMeta(metaRows, cg)
        const complete = checkReturnedGraphs({ anchors, contentRows: rows })
        if (!complete.ok) warnings.push(`untrusted derivation edges for this file were read incompletely: ${complete.reason}`)
        const slice = reduceSlice({ role: 'derivations', anchors, contentRows: rows, trustedProducers: [] })
        derivations = [...derivations, ...slice.derivations]
        discovered.push(...slice.forgeries)
      }
    }
  } catch (e) {
    if (e instanceof DiscoveryFailed) failures.push(e.message)
    else if (e instanceof ReadTruncatedError) failures.push(`a discovery query returned more than ${opts.max} rows; refusing to decide from a partial read`)
    else throw e
  }

  // Attach transactions to discovered forgeries, where their anchors can be read.
  const byCg = new Map()
  for (const f of discovered) if (f.ual && !f.txHash) {
    if (!byCg.has(f.cg)) byCg.set(f.cg, [])
    byCg.get(f.cg).push(f)
  }
  for (const [cg, list] of byCg) {
    const byUal = new Map()
    for (const batch of chunks(uniq(list.map(f => f.ual)))) {
      const metaRows = await tryQuery(node, Q.metaForUalsQuery(cg, batch, { limit: opts.max }), { contextGraphId: cg, max: opts.max })
        .catch(() => null)
      for (const a of anchorsFromMeta(metaRows ?? [], cg).anchors.values()) byUal.set(a.ual, a)
    }
    for (const f of list) {
      const a = byUal.get(f.ual)
      f.anchored = Boolean(a)
      f.txHash = a?.txHash ?? null
    }
  }
  forgeries.push(...dedupeByUal(discovered.map(({ cg, ...f }) => f)))

  // Local memory: revocations accepted before are never forgotten.
  for (const cg of grantsCgs) {
    const rec = record(cg)
    for (const id of grantIds) {
      const r = rec.revocations[id]
      if (r && !states.some(s => s.stateOf === id && s.tier === 'vm' && s.publisher === r.publisher && s.state === 'revoked')) {
        states.push({ ...r, graph: null, state: 'revoked', stateAuthor: null, materializedVersion: null, tier: 'vm', source: 'local-state' })
        warnings.push(`revocation ${r.ual ?? r.id} of ${id} was seen before but is missing from this read; it is still honoured`)
      }
    }
  }

  // Grants cited by trusted edges whose owner's grants graph is not configured here.
  const grantsOwners = new Set(grantsCgs.map(contextGraphAddress))
  const unresolvedGrants = uniq(derivations.filter(d => d.trusted === true).map(d => d.authorizedUnder))
    .filter(id => { const o = grantIriAddress(id); return Boolean(o) && !grantsOwners.has(o) })
    .sort()

  const consistency = {
    ok: failures.length === 0, reason: failures[0] ?? null, reasons: uniq(failures),
    attempts: Math.max(0, ...reads.map(r => r.consistency.attempts ?? 0)),
  }
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
    grantsCgs,
    anchors: allAnchors,
    grants,
    states,
    derivations,
    forgeries,
    unresolvedGrants,
    warnings: uniq(warnings),
    trustedProducers,
    freshness: freshness?.graphs ?? null,
    consistency,
    reads: reads.map(r => ({ contextGraphId: r.contextGraphId, publisher: r.publisher, role: r.role, anchors: r.anchors.length, consistency: r.consistency })),
  }
}
