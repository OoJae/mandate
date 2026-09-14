/**
 * DKG v10 node client, over the node's HTTP API only.
 *
 * Each party in Mandate runs its own node with its own agent and auth token.
 * That separation is the point: the grantor publishes permission from a node
 * the producer does not control, and the chain binds what was published to the
 * address that published it.
 *
 * Earlier versions shelled out to the `dkg` CLI and scraped its human-readable
 * output with regexes, which fell over on a literal containing "row(s)" and hid
 * partial failures behind a tolerant exit-code mode. Every read and write now
 * goes through documented routes with JSON bodies and checked status codes.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { asIri, asString } from './rdf-term.mjs'
import { DKG, metaForUalsQuery, vmPrefix } from './queries.mjs'
import { anchorsFromMeta } from './provenance.mjs'

export class DkgHttpError extends Error {
  constructor(message, { status, path, body } = {}) {
    super(message)
    this.status = status
    this.path = path
    this.body = body
  }
}

/** The node's auth token could not be found or read, so nothing can be asked of the node. */
export class NodeTokenError extends Error {}

/** A read returned more rows than the caller allowed; the result is incomplete, so nothing may be concluded from it. */
export class ReadTruncatedError extends Error {}

/** An anchor could not be read at all, as opposed to read and found wanting. */
class AnchorUnreadableError extends Error {}

/**
 * A response body was larger than the client allows. It extends
 * ReadTruncatedError on purpose: a reader must treat an unread body exactly like
 * a truncated one and conclude nothing from it.
 */
export class ResponseTooLargeError extends ReadTruncatedError {
  constructor(message, { status, path, limit } = {}) {
    super(message)
    this.status = status
    this.path = path
    this.limit = limit
  }
}

/**
 * A write stopped before its asset was confirmed on-chain.
 *
 * `stage` says where: create, share, author, publish, unbound (minted on-chain
 * but not bound to the context graph), publish-transport (the publish answer
 * could not be trusted and a transaction may already have been sent),
 * resume-refused (the node's record of an existing asset rules out continuing
 * it) or resume-unverified (it could not be judged now; retry later). When a UAL
 * or transaction exists it is carried here, so the operator can see what was
 * spent instead of retrying blind and paying twice.
 */
export class DkgWriteError extends Error {
  constructor(message, { name, stage, status, body, ual = null, txHash = null, mayHaveSent = false } = {}) {
    super(message)
    // `name` is the asset name, so a caller can save it and resume the same
    // asset instead of minting a new one. It shadows Error#name only when given.
    if (typeof name === 'string' && name) this.name = name
    this.assetName = typeof name === 'string' ? name : null
    this.stage = stage
    this.status = status
    this.body = body
    this.ual = ual
    this.txHash = txHash
    this.mayHaveSent = mayHaveSent
  }
}
DkgWriteError.prototype.name = 'DkgWriteError'

const expandHome = p => p.replace(/^~(?=$|\/)/, process.env.HOME ?? '')

/** auth.token carries a `#` comment line; strip it. */
export function readToken(home) {
  return readFileSync(join(expandHome(home), 'auth.token'), 'utf8')
    .split('\n').map(l => l.trim())
    .find(l => l && !l.startsWith('#'))
}

const ASSET_NAME = /^[^\s/<>"{}|^`\\]{1,256}$/

/**
 * The shape of a chain-confirmed UAL. Only an unscoped tentative publish gets a
 * `/t<opId>` suffix, which never matches. A named (graph-scoped) asset keeps its
 * reserved plain UAL while still tentative (dkg-publisher.js sets
 * `ual = graphPublish?.scope.ual ?? .../t<opId>`), so this shape alone proves
 * nothing: the _meta anchor's "confirmed" status is what rejects those.
 */
const CONFIRMED_UAL = /^did:dkg:[a-z0-9]+:\d+\/(0x[0-9a-fA-F]{40})\/(\d+)$/

/** Largest response body read by default. Real query answers are a few MiB at the 5000-row limit. */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024

const bareHex = v => typeof v === 'string' ? v.trim().toLowerCase().replace(/^0x/, '') : ''

/** Statuses whose responses carry no body by definition (Fetch spec), so a null body is not an unknown size. */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304])

/**
 * Read a response body, stopping at `limit` bytes. Returns null when the body is
 * larger, or when its size cannot be bounded without buffering all of it.
 */
async function readCapped(res, limit) {
  // headers.get returns null for a missing header and Number(null) is 0, so a
  // missing length must not read as a declared empty body.
  const raw = res.headers?.get?.('content-length')
  const declared = typeof raw === 'string' && /^\s*\d+\s*$/.test(raw) ? Number(raw) : NaN
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel?.().catch(() => {})
    return null
  }
  if (!res.body?.getReader) {
    // Only an injected fetch gets here: undici always gives a stream. text()
    // buffers everything before its size is known, so it is called only when a
    // declared length already bounds it. Fail closed otherwise: an injected
    // fetch must return a streaming body or a content-length.
    if (!res.body && NULL_BODY_STATUSES.has(res.status)) return ''
    if (!Number.isFinite(declared)) return null
    const text = await res.text()
    return Buffer.byteLength(text) > limit ? null : text
  }
  const reader = res.body.getReader()
  const chunks = []
  let bytes = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > limit) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export class DkgNode {
  /**
   * @param {object} o
   * @param {string} [o.home]   DKG_HOME, used to read auth.token lazily
   * @param {number} o.port
   * @param {string} [o.name]
   * @param {string} [o.token]  injected token (tests, or a token from elsewhere)
   * @param {Function} [o.fetch] injected fetch
   * @param {number} [o.timeoutMs]
   * @param {number} [o.maxResponseBytes] responses larger than this are refused, not read
   */
  constructor({ home, port, name, token, fetch: fetchImpl, timeoutMs = 60000, host = '127.0.0.1', maxResponseBytes = MAX_RESPONSE_BYTES } = {}) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid DKG node port: ${port}`)
    // An undefined or NaN limit must not quietly turn the cap off.
    if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1) throw new Error(`invalid maxResponseBytes: ${maxResponseBytes}`)
    this.maxResponseBytes = maxResponseBytes
    this.home = home ? expandHome(home) : null
    this.port = port
    this.name = name ?? `dkg:${port}`
    this.base = `http://${host}:${port}`
    this._token = token ?? null
    this._fetch = fetchImpl ?? globalThis.fetch
    this.timeoutMs = timeoutMs
  }

  get token() {
    if (this._token) return this._token
    if (!this.home) throw new NodeTokenError(`${this.name}: no auth token and no DKG home to read one from`)
    try {
      this._token = readToken(this.home)
    } catch (e) {
      throw new NodeTokenError(`${this.name}: cannot read ${join(this.home, 'auth.token')} (${e.code ?? e.message}). `
        + 'Is the node initialised and has it been started once?')
    }
    return this._token
  }

  async request(method, path, body, { auth = true, timeoutMs = this.timeoutMs, okStatuses, maxBytes = this.maxResponseBytes } = {}) {
    const headers = { accept: 'application/json' }
    if (auth) headers.authorization = `Bearer ${this.token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    let res
    try {
      res = await this._fetch(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (e) {
      const code = e?.cause?.code ?? e?.name
      throw new DkgHttpError(`${this.name} unreachable at ${this.base} (${code ?? e.message})`, { status: 0, path })
    }
    let text
    try {
      text = await readCapped(res, maxBytes)
    } catch (e) {
      // A body cut off mid-read (socket drop, timeout) is a transport failure,
      // so a publish caller reconciles rather than trusting a partial answer.
      const code = e?.cause?.code ?? e?.name
      throw new DkgHttpError(`${this.name} ${method} ${path}: the response was cut off (${code ?? e.message})`, { status: 0, path })
    }
    if (text === null) {
      throw new ResponseTooLargeError(`${this.name} ${method} ${path} -> ${res.status}: the response is larger than ${maxBytes} bytes, or its size cannot be bounded; refusing to read it`,
        { status: res.status, path, limit: maxBytes })
    }
    let parsed
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
    if (okStatuses ? okStatuses.includes(res.status) : res.ok) return { status: res.status, body: parsed }
    const detail = typeof parsed === 'object' && parsed?.error ? parsed.error : String(text).slice(0, 300)
    throw new DkgHttpError(`${this.name} ${method} ${path} -> ${res.status}: ${detail}`, { status: res.status, path, body: parsed })
  }

  async identity() { return (await this.request('GET', '/api/agent/identity')).body }
  async info() { return (await this.request('GET', '/api/info')).body }
  /** Unauthenticated; includes the loopback multiaddr other local nodes can dial. */
  async status() { return (await this.request('GET', '/api/status', undefined, { auth: false })).body }
  async connect(multiaddr) { return (await this.request('POST', '/api/connect', { multiaddr })).body }
  async subscribe(contextGraphId, { includeSharedMemory = false } = {}) {
    return (await this.request('POST', '/api/context-graph/subscribe', { contextGraphId, includeSharedMemory, syncMode: 'always-on' })).body
  }

  /**
   * SPARQL SELECT over one context graph, returning raw binding cells.
   *
   * `max` is a hard ceiling: queries should use LIMIT max+1, and any response
   * over `max` rows throws ReadTruncatedError rather than returning a partial
   * set that could omit a revocation.
   */
  async queryJson(sparql, { contextGraphId, includeSharedMemory = false, view, max = 5000, timeoutMs } = {}) {
    if (!contextGraphId) throw new Error('queryJson requires a contextGraphId')
    const body = { sparql, contextGraphId }
    if (includeSharedMemory) body.includeSharedMemory = true
    if (view) body.view = view
    const { body: res } = await this.request('POST', '/api/query', body, { timeoutMs })
    const result = res?.result
    if (!result || result.type !== 'bindings' || !Array.isArray(result.bindings)) {
      throw new DkgHttpError(`${this.name} /api/query returned an unexpected shape`, { status: 200, path: '/api/query', body: res })
    }
    if (result.bindings.length > max) {
      throw new ReadTruncatedError(`${this.name}: query returned more than ${max} rows; refusing to reason over a partial result`)
    }
    return result.bindings
  }

  /**
   * Compare this node's copy of a context graph with the chain: `headOrdinal`
   * is how many assets are bound to the graph on-chain, `watermarkAfter` how
   * many this node holds after trying to catch up. Needs a node-admin token.
   */
  async reconcile(contextGraphId, { timeoutMs = 120_000 } = {}) {
    return (await this.request('POST', '/api/context-graph/reconcile', { contextGraphId }, { timeoutMs })).body
  }

  /** Fetch specific assets of a context graph from peers. Needs a node-admin token. */
  async fetchAssets(contextGraphId, uals, { peerIds, timeoutMs = 120_000 } = {}) {
    const body = { contextGraphId, uals }
    if (peerIds) body.peerIds = peerIds
    return (await this.request('POST', '/api/context-graph/fetch-assets', body, { timeoutMs })).body
  }

  async subscriptions() { return (await this.request('GET', '/api/context-graph/subscriptions')).body }

  /** The node's lifecycle record for a named asset, or null if it does not exist. */
  async descriptor(name, contextGraphId) {
    try {
      const q = `?contextGraphId=${encodeURIComponent(contextGraphId)}`
      return (await this.request('GET', `/api/knowledge-assets/${encodeURIComponent(name)}${q}`)).body
    } catch (e) {
      if (e instanceof DkgHttpError && e.status === 404) return null
      throw e
    }
  }

  /**
   * Create, write and seal an asset in Working Memory, share it to Shared
   * Working Memory, and publish it to Verifiable Memory — succeeding only when
   * the chain has confirmed it and it is bound to the context graph.
   *
   * Names must be unique: create is get-or-create on the node, and re-sealing
   * an existing name with different content fails. Without `resume` an
   * existing name is refused. With `resume` it is continued from the stage the
   * node reports (wm-sealed: share and publish; swm-shared: publish;
   * vm-confirmed: verified, never published again). Resuming continues the
   * content already sealed under that name, not `quads`: a retry is meant to
   * finish the earlier write, and the seal cannot be changed anyway.
   *
   * `lastPublishUnknown` says an earlier publish of this asset may have sent a
   * transaction (its outcome was never learned). Resume then never publishes:
   * a shared asset is left for the node to show confirmed, and the call throws
   * the retryable `resume-unverified`.
   */
  async sealShareAnchor({ name, contextGraphId, quads, expectAuthor, resume = false, lastPublishUnknown = false, shareRetries = 3, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
    if (typeof name !== 'string' || !ASSET_NAME.test(name)) throw new DkgWriteError(`invalid asset name: ${JSON.stringify(name)}`, { name, stage: 'create' })
    if (!Array.isArray(quads) || quads.length === 0) throw new DkgWriteError('no quads to write', { name, stage: 'create' })
    // A truthy string must not quietly mean "safe to publish again", nor a typo mean the opposite.
    if (typeof lastPublishUnknown !== 'boolean') throw new DkgWriteError('lastPublishUnknown must be true or false', { name, stage: 'create' })

    const existing = await this.descriptor(name, contextGraphId)
    if (existing && !resume) {
      throw new DkgWriteError(`asset ${name} already exists in ${contextGraphId}; names must be unique`, { name, stage: 'create' })
    }
    if (existing) return this.#resume(existing, { name, contextGraphId, expectAuthor, lastPublishUnknown, shareRetries, sleep })

    const created = await this.#stage('create', name, () =>
      this.request('POST', '/api/knowledge-assets', { contextGraphId, name, quads, finalize: true }, { okStatuses: [201] }))
    if (created.body?.status !== 'wm-sealed' || !created.body?.merkleRoot) {
      throw new DkgWriteError(`asset ${name} was not sealed (status ${created.body?.status ?? 'unknown'})`, { name, stage: 'create', status: created.status, body: created.body })
    }
    const authorAddress = String(created.body.authorAddress ?? '').toLowerCase()
    if (expectAuthor && authorAddress !== String(expectAuthor).toLowerCase()) {
      throw new DkgWriteError(`asset ${name} was sealed by ${authorAddress || 'an unknown author'}, expected ${expectAuthor}`, { name, stage: 'author', body: created.body })
    }
    const sealed = { merkleRoot: created.body.merkleRoot, authorAddress, assertionUri: created.body.assertionUri ?? null }
    await this.#share(name, contextGraphId, { shareRetries, sleep })
    return this.#publish(name, contextGraphId, sealed)
  }

  /** Continue an existing asset, or refuse when its state cannot be trusted. */
  async #resume(d, { name, contextGraphId, expectAuthor, lastPublishUnknown, shareRetries, sleep }) {
    const refuse = reason => {
      throw new DkgWriteError(`asset ${name} cannot be resumed: ${reason}; it will not be published again`, { name, stage: 'resume-refused', body: d, ual: d?.publishedUal ?? null })
    }
    // Not a verdict on the asset: something needed to judge it could not be
    // learned now, so a later retry may succeed. It never publishes.
    const unverified = (reason, { mayHaveSent = false } = {}) => {
      throw new DkgWriteError(`asset ${name} could not be verified yet: ${reason}; it was not published again — retry later`,
        { name, stage: 'resume-unverified', body: d, ual: d?.publishedUal ?? null, mayHaveSent })
    }
    const authorAddress = String(d.agentAddress ?? '').toLowerCase()
    if (expectAuthor && authorAddress !== String(expectAuthor).toLowerCase()) {
      refuse(`its record belongs to ${authorAddress || 'an unknown author'}, expected ${expectAuthor}`)
    }
    if (d.status === 'wm-sealed' || d.status === 'swm-shared') {
      const pointer = d.status === 'wm-sealed' ? d.wmCurrentAssertion : d.swmCurrentAssertion
      if (!/^[0-9a-f]{64}$/.test(bareHex(pointer))) refuse(`the node reports ${d.status} without a sealed assertion`)
      // A sealed draft never carries a published UAL; one that does is a
      // publish the node recorded inconsistently.
      if (d.publishedUal || d.vmCurrentAssertion) refuse(`the node reports ${d.status} but also a published assertion`)
      const sealed = { merkleRoot: `0x${bareHex(pointer)}`, authorAddress, assertionUri: d.assertionGraph ?? null }
      // A publish needs the asset shared first (the node answers 409 otherwise),
      // so a wm-sealed asset was never published and is safe to continue. A
      // shared one whose last publish may have sent a transaction is not: the
      // node records a mint only once it confirms, so publishing it again could
      // mint twice. Deliberate trade-off: if that publish in fact sent nothing,
      // the asset stays unpublished until an operator checks the chain.
      if (d.status === 'swm-shared' && lastPublishUnknown) {
        unverified('an earlier publish may have sent a transaction and the node still reports swm-shared', { mayHaveSent: true })
      }
      if (d.status === 'wm-sealed') await this.#share(name, contextGraphId, { shareRetries, sleep })
      return { ...(await this.#publish(name, contextGraphId, sealed)), resumed: true }
    }
    if (d.status === 'vm-confirmed') {
      const vm = bareHex(d.vmCurrentAssertion)
      const wm = bareHex(d.wmCurrentAssertion)
      if (vm && wm && vm !== wm) refuse('its working copy has changed since it was published')
      let anchor
      try {
        // The sealed root is whatever the node's pointers name; with neither
        // exposed there is nothing to compare, as on the lost-publish path.
        const root = vm || wm
        anchor = await this.#confirmAnchor(contextGraphId, { ual: d.publishedUal, merkleRoot: root ? `0x${root}` : null, descriptor: d, author: expectAuthor ?? authorAddress })
      } catch (e) {
        // A read that failed says nothing about the asset; refusing for good
        // would strand a derivation that is really anchored.
        if (e instanceof AnchorUnreadableError) unverified(e.message)
        refuse(e.message)
      }
      return { name, ual: anchor.ual, txHash: null, resumed: true }
    }
    refuse(`the node reports status ${d.status ?? 'unknown'}`)
  }

  async #share(name, contextGraphId, { shareRetries, sleep }) {
    const sharePath = `/api/knowledge-assets/${encodeURIComponent(name)}/swm/share`
    for (let attempt = 0; ; attempt++) {
      try {
        const shared = await this.request('POST', sharePath, { contextGraphId })
        if (shared.body?.swmShared !== true) {
          throw new DkgWriteError(`asset ${name} was not shared to SWM`, { name, stage: 'share', status: shared.status, body: shared.body })
        }
        return
      } catch (e) {
        // The one documented transient: the node reports a promote prerequisite
        // as temporarily unavailable. Anything else fails immediately.
        const transient = e instanceof DkgHttpError && e.status === 500 && /temporarily unavailable/i.test(String(e.body?.error ?? ''))
        if (e instanceof DkgWriteError) throw e
        if (!transient || attempt >= shareRetries) {
          throw new DkgWriteError(`sharing ${name} failed: ${e.message}`, { name, stage: 'share', status: e.status, body: e.body })
        }
        await sleep(1500 * 2 ** attempt)
      }
    }
  }

  async #publish(name, contextGraphId, { merkleRoot, authorAddress, assertionUri }) {
    const publishPath = `/api/knowledge-assets/${encodeURIComponent(name)}/vm/publish`
    const sealed = { merkleRoot, authorAddress, assertionUri }
    let published
    try {
      published = await this.request('POST', publishPath, { contextGraphId }, { okStatuses: [200, 207], timeoutMs: Math.max(this.timeoutMs, 480000) })
    } catch (e) {
      // The node's vm/publish route answers 4xx only for caller preconditions
      // it checks before any chain interaction (unshared or unsealed asset,
      // author selection, pricing policy, no funded wallet). Everything else —
      // a plain 500 for reverts and errors thrown after createKnowledgeAssets
      // returned, 502 for a publish that did not confirm, 503/504 for a lost
      // chain connection, status 0 or an unreadable body — can follow a
      // broadcast transaction, so it is reconciled, never reported as unsent.
      const beforeChain = e instanceof DkgHttpError && e.status >= 400 && e.status < 500
      if (!beforeChain) return this.#reconcileLost(name, contextGraphId, sealed, e)
      throw new DkgWriteError(`publishing ${name} failed: ${e.message}`, { name, stage: 'publish', status: e.status, body: e.body })
    }
    const b = published.body !== null && typeof published.body === 'object' ? published.body : {}
    if (published.status === 207) {
      throw new DkgWriteError(`asset ${name} was minted on-chain but not bound to ${contextGraphId}: ${b.contextGraphError ?? b.error ?? 'unknown error'}`,
        { name, stage: 'unbound', status: 207, body: b, ual: b.ual ?? null, txHash: b.txHash ?? null, mayHaveSent: true })
    }
    if (b.status !== 'confirmed' || !b.ual) {
      // The node sends 200 only for a confirmed publish, so a 200 saying
      // anything else (or nothing parseable) is an answer nobody can read:
      // treat it like a lost response rather than as proof nothing was sent.
      const e = new DkgHttpError(`${this.name} POST ${publishPath} -> ${published.status}: publish returned status ${b.status ?? 'unknown'}`,
        { status: published.status, path: publishPath, body: published.body })
      return this.#reconcileLost(name, contextGraphId, sealed, e)
    }
    return {
      name,
      ual: b.ual,
      txHash: b.txHash ?? null,
      blockNumber: b.blockNumber ?? null,
      merkleRoot: b.merkleRoot ?? merkleRoot,
      authorAddress,
      assertionUri,
    }
  }

  /**
   * After a publish whose answer cannot be trusted, learn the outcome from the
   * node's own records instead of retrying, which could mint twice. The
   * lifecycle descriptor alone is not proof: the node writes the same
   * vm-confirmed descriptor for a tentative, local-only publish. So success
   * also needs a confirmed UAL, the sealed merkle root, and a confirmed anchor
   * in the graph's _meta. Otherwise throw publish-transport, mayHaveSent true,
   * carrying any UAL or transaction the node reported.
   */
  async #reconcileLost(name, contextGraphId, { merkleRoot, authorAddress, assertionUri }, e) {
    const body = e?.body !== null && typeof e?.body === 'object' ? e.body : {}
    let d = null
    let why
    try {
      d = await this.descriptor(name, contextGraphId)
      if (d?.status !== 'vm-confirmed') throw new Error(`the node reports status ${d?.status ?? 'unknown'}`)
      const anchor = await this.#confirmAnchor(contextGraphId, { ual: d.publishedUal, merkleRoot, descriptor: d, author: authorAddress })
      return { name, ual: anchor.ual, txHash: anchor.txHash, merkleRoot, authorAddress, assertionUri, reconciled: true }
    } catch (err) {
      why = err.message
    }
    const reported = v => typeof v === 'string' && v ? v : null
    throw new DkgWriteError(`publishing ${name} did not confirm (${e?.message ?? e}; ${why}); a transaction may have been sent — check the node before retrying`,
      { name, stage: 'publish-transport', status: e?.status, body: e?.body, ual: reported(d?.publishedUal) ?? reported(body.ual), txHash: reported(body.txHash), mayHaveSent: true })
  }

  /**
   * Prove a published UAL from the node's own records, or throw saying why.
   *
   * The UAL must be chain-confirmed in shape and published by `author`; the
   * descriptor's VM pointer must equal the sealed merkle root when both are
   * known; and `<cg>/_meta` must hold an anchor for it that the resolver would
   * accept — the same anchorsFromMeta rules, so a write never succeeds on an
   * anchor readers then refuse to count. A failed read throws
   * AnchorUnreadableError, which says nothing about the asset itself.
   */
  async #confirmAnchor(contextGraphId, { ual, merkleRoot, descriptor, author }) {
    const m = typeof ual === 'string' ? ual.match(CONFIRMED_UAL) : null
    if (!m) throw new Error(`the recorded UAL ${JSON.stringify(ual ?? null)} is not a chain-confirmed UAL`)
    const publisher = m[1].toLowerCase()
    if (author && publisher !== String(author).toLowerCase()) throw new Error(`the recorded UAL ${ual} was not published by ${author}`)
    const vm = bareHex(descriptor?.vmCurrentAssertion)
    if (merkleRoot && vm && vm !== bareHex(merkleRoot)) throw new Error(`the published assertion ${vm} is not the one sealed (${bareHex(merkleRoot)})`)

    let rows
    try {
      rows = await this.queryJson(metaForUalsQuery(contextGraphId, [ual], { limit: 50, merkleRoot: true }), { contextGraphId, max: 50 })
    } catch (e) {
      throw new AnchorUnreadableError(`its anchor could not be read (${e.message})`)
    }
    // Only rows about this exact UAL. anchorsFromMeta keys anchors by the graph
    // a UAL derives, and a UAL naming another chain with the same address and
    // number derives the same graph, so its rows must not stand in for ours.
    const own = rows.filter(r => asIri(r.s) === ual)
    const expectedGraph = `${vmPrefix(contextGraphId)}${publisher}/${m[2]}`
    const { anchors, problems } = anchorsFromMeta(own, contextGraphId)
    const anchor = anchors.get(expectedGraph)
    if (!anchor) {
      const problem = problems.find(p => p.ual === ual)
      throw new Error(problem ? `the anchor for ${ual} is not acceptable: ${problem.reason}` : `no anchor for ${ual} in the graph's _meta`)
    }
    // _meta also records the root that was minted, and the query above asks for
    // it. A node that does not write it (none seen live) leaves the check out;
    // where rows carry it, it must be exactly one value equal to the sealed root.
    const roots = own.filter(r => asIri(r.p) === `${DKG}merkleRoot`).map(r => bareHex(asString(r.o)))
    if (merkleRoot && roots.length && (roots.length !== 1 || roots[0] !== bareHex(merkleRoot))) {
      throw new Error(`the anchor for ${ual} records merkle root ${roots.join(',')}, not the one sealed (${bareHex(merkleRoot)})`)
    }
    return { ual, txHash: anchor.txHash }
  }

  async #stage(stage, name, fn) {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof DkgWriteError) throw e
      throw new DkgWriteError(`${stage} failed: ${e.message}`, { name, stage, status: e.status, body: e.body })
    }
  }
}
