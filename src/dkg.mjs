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

export class DkgHttpError extends Error {
  constructor(message, { status, path, body } = {}) {
    super(message)
    this.status = status
    this.path = path
    this.body = body
  }
}

/** A read returned more rows than the caller allowed; the result is incomplete, so nothing may be concluded from it. */
export class ReadTruncatedError extends Error {}

/**
 * A write stopped before its asset was confirmed on-chain.
 *
 * `stage` says where: create, share, author, publish, unbound (minted on-chain
 * but not bound to the context graph), or publish-transport (the node lost its
 * chain connection after a transaction may already have been sent). When a UAL
 * or transaction exists it is carried here, so the operator can see what was
 * spent instead of retrying blind and paying twice.
 */
export class DkgWriteError extends Error {
  constructor(message, { stage, status, body, ual = null, txHash = null, mayHaveSent = false } = {}) {
    super(message)
    this.stage = stage
    this.status = status
    this.body = body
    this.ual = ual
    this.txHash = txHash
    this.mayHaveSent = mayHaveSent
  }
}

const expandHome = p => p.replace(/^~(?=$|\/)/, process.env.HOME ?? '')

/** auth.token carries a `#` comment line; strip it. */
export function readToken(home) {
  return readFileSync(join(expandHome(home), 'auth.token'), 'utf8')
    .split('\n').map(l => l.trim())
    .find(l => l && !l.startsWith('#'))
}

const ASSET_NAME = /^[^\s/<>"{}|^`\\]{1,256}$/

export class DkgNode {
  /**
   * @param {object} o
   * @param {string} [o.home]   DKG_HOME, used to read auth.token lazily
   * @param {number} o.port
   * @param {string} [o.name]
   * @param {string} [o.token]  injected token (tests, or a token from elsewhere)
   * @param {Function} [o.fetch] injected fetch
   * @param {number} [o.timeoutMs]
   */
  constructor({ home, port, name, token, fetch: fetchImpl, timeoutMs = 60000, host = '127.0.0.1' } = {}) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid DKG node port: ${port}`)
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
    if (!this.home) throw new Error(`${this.name}: no auth token and no DKG home to read one from`)
    try {
      this._token = readToken(this.home)
    } catch (e) {
      throw new Error(`${this.name}: cannot read ${join(this.home, 'auth.token')} (${e.code ?? e.message}). `
        + 'Is the node initialised and has it been started once?')
    }
    return this._token
  }

  async request(method, path, body, { auth = true, timeoutMs = this.timeoutMs, okStatuses } = {}) {
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
    const text = await res.text()
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
   * an existing name with different content fails.
   */
  async sealShareAnchor({ name, contextGraphId, quads, expectAuthor, shareRetries = 3, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
    if (!ASSET_NAME.test(name)) throw new DkgWriteError(`invalid asset name: ${JSON.stringify(name)}`, { stage: 'create' })
    if (!Array.isArray(quads) || quads.length === 0) throw new DkgWriteError('no quads to write', { stage: 'create' })

    if (await this.descriptor(name, contextGraphId)) {
      throw new DkgWriteError(`asset ${name} already exists in ${contextGraphId}; names must be unique`, { stage: 'create' })
    }

    const created = await this.#stage('create', () =>
      this.request('POST', '/api/knowledge-assets', { contextGraphId, name, quads, finalize: true }, { okStatuses: [201] }))
    if (created.body?.status !== 'wm-sealed' || !created.body?.merkleRoot) {
      throw new DkgWriteError(`asset ${name} was not sealed (status ${created.body?.status ?? 'unknown'})`, { stage: 'create', status: created.status, body: created.body })
    }
    const authorAddress = String(created.body.authorAddress ?? '').toLowerCase()
    if (expectAuthor && authorAddress !== String(expectAuthor).toLowerCase()) {
      throw new DkgWriteError(`asset ${name} was sealed by ${authorAddress || 'an unknown author'}, expected ${expectAuthor}`, { stage: 'author', body: created.body })
    }

    const sharePath = `/api/knowledge-assets/${encodeURIComponent(name)}/swm/share`
    for (let attempt = 0; ; attempt++) {
      try {
        const shared = await this.request('POST', sharePath, { contextGraphId })
        if (shared.body?.swmShared !== true) {
          throw new DkgWriteError(`asset ${name} was not shared to SWM`, { stage: 'share', status: shared.status, body: shared.body })
        }
        break
      } catch (e) {
        // The one documented transient: the node reports a promote prerequisite
        // as temporarily unavailable. Anything else fails immediately.
        const transient = e instanceof DkgHttpError && e.status === 500 && /temporarily unavailable/i.test(String(e.body?.error ?? ''))
        if (e instanceof DkgWriteError) throw e
        if (!transient || attempt >= shareRetries) {
          throw new DkgWriteError(`sharing ${name} failed: ${e.message}`, { stage: 'share', status: e.status, body: e.body })
        }
        await sleep(1500 * 2 ** attempt)
      }
    }

    const publishPath = `/api/knowledge-assets/${encodeURIComponent(name)}/vm/publish`
    let published
    try {
      published = await this.request('POST', publishPath, { contextGraphId }, { okStatuses: [200, 207], timeoutMs: Math.max(this.timeoutMs, 480000) })
    } catch (e) {
      if (e instanceof DkgHttpError && (e.status === 503 || e.status === 504 || e.status === 0)) {
        // The node may have sent a transaction before losing its chain
        // connection. Retrying could mint twice, so reconcile from the node's
        // own lifecycle record instead.
        const d = await this.descriptor(name, contextGraphId).catch(() => null)
        if (d?.status === 'vm-confirmed' && d.publishedUal) {
          return { name, ual: d.publishedUal, txHash: null, merkleRoot: created.body.merkleRoot, authorAddress, reconciled: true }
        }
        throw new DkgWriteError(`publishing ${name} did not confirm (${e.message}); a transaction may have been sent — check the node before retrying`,
          { stage: 'publish-transport', status: e.status, body: e.body, mayHaveSent: true })
      }
      throw new DkgWriteError(`publishing ${name} failed: ${e.message}`, { stage: 'publish', status: e.status, body: e.body })
    }
    const b = published.body ?? {}
    if (published.status === 207) {
      throw new DkgWriteError(`asset ${name} was minted on-chain but not bound to ${contextGraphId}: ${b.contextGraphError ?? b.error ?? 'unknown error'}`,
        { stage: 'unbound', status: 207, body: b, ual: b.ual ?? null, txHash: b.txHash ?? null })
    }
    if (b.status !== 'confirmed' || !b.ual) {
      throw new DkgWriteError(`asset ${name} publish returned status ${b.status ?? 'unknown'}`, { stage: 'publish', status: published.status, body: b, ual: b.ual ?? null, txHash: b.txHash ?? null })
    }
    return {
      name,
      ual: b.ual,
      txHash: b.txHash ?? null,
      blockNumber: b.blockNumber ?? null,
      merkleRoot: b.merkleRoot ?? created.body.merkleRoot,
      authorAddress,
      assertionUri: created.body.assertionUri ?? null,
    }
  }

  async #stage(stage, fn) {
    try {
      return await fn()
    } catch (e) {
      if (e instanceof DkgWriteError) throw e
      throw new DkgWriteError(`${stage} failed: ${e.message}`, { stage, status: e.status, body: e.body })
    }
  }
}
