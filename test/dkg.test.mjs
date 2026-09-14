import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DkgNode, DkgHttpError, DkgWriteError, ReadTruncatedError, ResponseTooLargeError } from '../src/dkg.mjs'

/** A fake daemon: routes are matched in order, each may be hit a limited number of times. */
function fakeFetch(routes) {
  const calls = []
  const fetch = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search
    const method = init.method
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ method, path, body, headers: init.headers })
    const route = routes.find(r => r.method === method && (r.path instanceof RegExp ? r.path.test(path) : r.path === path) && (r.times === undefined || r.times > 0))
    if (!route) return new Response(JSON.stringify({ error: `no fake route for ${method} ${path}` }), { status: 599 })
    if (route.times !== undefined) route.times--
    if (route.throw) throw route.throw
    return new Response(JSON.stringify(typeof route.body === 'function' ? route.body(body) : route.body), { status: route.status ?? 200 })
  }
  return { fetch, calls }
}

const node = routes => {
  const f = fakeFetch(routes)
  return { n: new DkgNode({ port: 9999, name: 'fake', token: 'tok', fetch: f.fetch }), calls: f.calls }
}
const noSleep = async () => {}
const CG = '0xabc/grants'
const QUADS = [{ subject: 'urn:x:1', predicate: 'urn:p:1', object: '"v"' }]

test('sends the bearer token and returns parsed JSON', async () => {
  const { n, calls } = node([{ method: 'GET', path: '/api/agent/identity', body: { agentAddress: '0xAbC' } }])
  assert.equal((await n.identity()).agentAddress, '0xAbC')
  assert.equal(calls[0].headers.authorization, 'Bearer tok')
})

test('status is read without a token', async () => {
  const { n, calls } = node([{ method: 'GET', path: '/api/status', body: { peerId: 'p' } }])
  await n.status()
  assert.equal(calls[0].headers.authorization, undefined)
})

test('an unreachable node is a clear error, not a crash', async () => {
  const err = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
  const { n } = node([{ method: 'GET', path: '/api/info', throw: err }])
  await assert.rejects(n.info(), e => e instanceof DkgHttpError && e.status === 0 && /unreachable.*ECONNREFUSED/.test(e.message))
})

test('a missing token file names the path instead of throwing ENOENT at construction', () => {
  const n = new DkgNode({ port: 9999, home: '/nonexistent-mandate-home' })
  assert.throws(() => n.token, /cannot read .*auth\.token/)
})

test('queryJson validates the response shape and refuses truncated results', async () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ s: `urn:x:${i}` }))
  const { n, calls } = node([
    { method: 'POST', path: '/api/query', times: 1, body: { result: { type: 'bindings', bindings: rows } } },
    { method: 'POST', path: '/api/query', times: 1, body: { result: { type: 'bindings', bindings: rows } } },
    { method: 'POST', path: '/api/query', times: 1, body: { result: { type: 'quads' } } },
  ])
  assert.equal((await n.queryJson('SELECT *', { contextGraphId: CG })).length, 3)
  assert.equal(calls[0].body.contextGraphId, CG)
  await assert.rejects(n.queryJson('SELECT *', { contextGraphId: CG, max: 2 }), ReadTruncatedError)
  await assert.rejects(n.queryJson('SELECT *', { contextGraphId: CG }), /unexpected shape/)
})

test('descriptor returns null for a missing asset', async () => {
  const { n } = node([{ method: 'GET', path: /^\/api\/knowledge-assets\/missing/, status: 404, body: { error: 'No knowledge asset' } }])
  assert.equal(await n.descriptor('missing', CG), null)
})

const happy = (over = {}) => [
  { method: 'GET', path: /^\/api\/knowledge-assets\/g1\?/, times: 1, status: 404, body: { error: 'No knowledge asset' } },
  { method: 'POST', path: '/api/knowledge-assets', status: 201, body: { status: 'wm-sealed', merkleRoot: '0xroot', authorAddress: '0xAUTHOR', assertionUri: 'a' } },
  { method: 'POST', path: '/api/knowledge-assets/g1/swm/share', body: { swmShared: true, promotedCount: 1 } },
  { method: 'POST', path: '/api/knowledge-assets/g1/vm/publish', status: over.publishStatus ?? 200,
    body: over.publishBody ?? { status: 'confirmed', ual: 'did:dkg:base:84532/0xauthor/7', txHash: '0xtx', blockNumber: 1 } },
]

test('sealShareAnchor succeeds only after a confirmed, bound publish', async () => {
  const { n, calls } = node(happy())
  const r = await n.sealShareAnchor({ name: 'g1', contextGraphId: CG, quads: QUADS, expectAuthor: '0xauthor', sleep: noSleep })
  assert.equal(r.ual, 'did:dkg:base:84532/0xauthor/7')
  assert.equal(r.txHash, '0xtx')
  assert.deepEqual(calls.map(c => c.method + ' ' + c.path.split('?')[0]), [
    'GET /api/knowledge-assets/g1', 'POST /api/knowledge-assets', 'POST /api/knowledge-assets/g1/swm/share', 'POST /api/knowledge-assets/g1/vm/publish'])
  assert.equal(calls[1].body.finalize, true)
})

test('an existing name is refused: names are never reused', async () => {
  const { n } = node([{ method: 'GET', path: /^\/api\/knowledge-assets\/g1\?/, body: { status: 'vm-confirmed' } }])
  await assert.rejects(n.sealShareAnchor({ name: 'g1', contextGraphId: CG, quads: QUADS }), e => e.stage === 'create' && /already exists/.test(e.message))
})

test('an asset sealed by a different author is refused before it is shared', async () => {
  const { n, calls } = node(happy())
  await assert.rejects(n.sealShareAnchor({ name: 'g1', contextGraphId: CG, quads: QUADS, expectAuthor: '0xsomeoneelse' }), e => e.stage === 'author')
  assert.ok(!calls.some(c => c.path.includes('/swm/share')))
})

test('the documented transient share failure is retried; other share errors are not', async () => {
  const routes = happy()
  routes.splice(2, 0, { method: 'POST', path: '/api/knowledge-assets/g1/swm/share', times: 1, status: 500, body: { error: 'A promote prerequisite is temporarily unavailable' } })
  const { n } = node(routes)
  assert.ok((await n.sealShareAnchor({ name: 'g1', contextGraphId: CG, quads: QUADS, sleep: noSleep })).ual)

  const r2 = happy()
  r2[2] = { method: 'POST', path: '/api/knowledge-assets/g1/swm/share', status: 409, body: { error: 'UNSEALED_SHARE_BLOCKED' } }
  const { n: n2 } = node(r2)
  await assert.rejects(n2.sealShareAnchor({ name: 'g1', contextGraphId: CG, quads: QUADS, sleep: noSleep }), e => e.stage === 'share')
})

test('a 207 publish is a hard failure that still reports what was minted', async () => {
  const { n } = node(happy({ publishStatus: 207, publishBody: { status: 'confirmed', ual: 'did:dkg:base:84532/0xa/9', txHash: '0xspent', contextGraphError: 'binding failed' } }))
  await assert.rejects(n.sealShareAnchor({ name: 'g1', contextGraphId: CG, quads: QUADS, sleep: noSleep }),
    e => e instanceof DkgWriteError && e.stage === 'unbound' && e.ual === 'did:dkg:base:84532/0xa/9' && e.txHash === '0xspent')
})

/* Lost publish responses: the descriptor alone is never proof of an anchor. */

const AUTHOR = '0x' + 'a1'.repeat(20)
const VCG = `${AUTHOR}/mandate-grants`
const ROOT = '0x' + 'ab'.repeat(32)
const VUAL = `did:dkg:base:84532/${AUTHOR}/10`
const DKGNS = 'http://dkg.io/ontology/'
const metaRows = ({ ual = VUAL, status = 'confirmed', graph, tx = '0xmetatx' } = {}) => {
  const [, addr, num] = ual.match(/\/(0x[0-9a-fA-F]{40})\/(\w+)$/) ?? [, AUTHOR, '10']
  const g = graph ?? `did:dkg:context-graph:${VCG}/_verifiable_memory/${addr.toLowerCase()}/${num}`
  return [
    { s: ual, p: `${DKGNS}kaUal`, o: ual },
    ...(status === null ? [] : [{ s: ual, p: `${DKGNS}status`, o: `"${status}"` }]),
    { s: ual, p: `${DKGNS}assertionGraph`, o: g },
    { s: ual, p: `${DKGNS}transactionHash`, o: `"${tx}"` },
  ]
}
const lost = ({ descriptor, meta = metaRows(), publishError = { status: 503, body: { error: 'chain RPC transport' } } } = {}) => [
  { method: 'GET', path: /^\/api\/knowledge-assets\/g1\?/, times: 1, status: 404, body: { error: 'No knowledge asset' } },
  { method: 'POST', path: '/api/knowledge-assets', status: 201, body: { status: 'wm-sealed', merkleRoot: ROOT, authorAddress: AUTHOR, assertionUri: 'a' } },
  { method: 'POST', path: '/api/knowledge-assets/g1/swm/share', body: { swmShared: true } },
  publishError.throw
    ? { method: 'POST', path: '/api/knowledge-assets/g1/vm/publish', throw: publishError.throw }
    : { method: 'POST', path: '/api/knowledge-assets/g1/vm/publish', status: publishError.status, body: publishError.body },
  { method: 'GET', path: /^\/api\/knowledge-assets\/g1\?/, body: descriptor ?? { status: 'vm-confirmed', state: 'published', publishedUal: VUAL, vmCurrentAssertion: ROOT.slice(2), agentAddress: AUTHOR } },
  { method: 'POST', path: '/api/query', body: { result: { type: 'bindings', bindings: meta } } },
]
const seal = n => n.sealShareAnchor({ name: 'g1', contextGraphId: VCG, quads: QUADS, expectAuthor: AUTHOR, sleep: noSleep })
const transportFailure = e => e instanceof DkgWriteError && e.stage === 'publish-transport' && e.mayHaveSent === true && e.name === 'g1'

test('a transport error after send is reconciled from the node record and its _meta anchor, never retried', async () => {
  const { n, calls } = node(lost())
  const r = await seal(n)
  assert.equal(r.ual, VUAL)
  assert.equal(r.txHash, '0xmetatx')
  assert.equal(r.reconciled, true)
  assert.equal(calls.filter(c => c.path.includes('/vm/publish')).length, 1, 'publish must not be retried')
  const q = calls.find(c => c.path === '/api/query')
  assert.equal(q.body.contextGraphId, VCG)
  assert.match(q.body.sparql, /_meta/)
})

test('a lost publish is not success when the descriptor carries a tentative UAL', async () => {
  const tentative = `did:dkg:base:84532/${AUTHOR}/t0f00`
  const { n, calls } = node(lost({ descriptor: { status: 'vm-confirmed', state: 'published', publishedUal: tentative, vmCurrentAssertion: ROOT.slice(2) } }))
  await assert.rejects(seal(n), e => transportFailure(e) && e.ual === tentative && /not a chain-confirmed UAL/.test(e.message))
  assert.ok(!calls.some(c => c.path === '/api/query'), 'a tentative UAL is refused before any anchor lookup')
})

test('a lost publish is not success when the descriptor is not vm-confirmed, even with a UAL and a confirmed _meta anchor', async () => {
  for (const status of ['swm-shared', 'wm-sealed', undefined]) {
    const { n, calls } = node(lost({ descriptor: { status, state: 'published', publishedUal: VUAL, vmCurrentAssertion: ROOT.slice(2), agentAddress: AUTHOR } }))
    await assert.rejects(seal(n), e => transportFailure(e) && /the node reports status/.test(e.message), String(status))
    assert.ok(!calls.some(c => c.path === '/api/query'), 'refused before any anchor lookup')
  }
})

test('a lost publish is not success when the published assertion is not the one sealed', async () => {
  const { n } = node(lost({ descriptor: { status: 'vm-confirmed', publishedUal: VUAL, vmCurrentAssertion: 'cd'.repeat(32) } }))
  await assert.rejects(seal(n), e => transportFailure(e) && /not the one sealed/.test(e.message))
})

test('a lost publish is not success without a confirmed anchor in _meta', async () => {
  for (const [label, meta, why] of [
    ['no anchor', [], /no anchor/],
    ['tentative status', metaRows({ status: 'tentative' }), /status tentative/],
    ['missing status', metaRows({ status: null }), /status missing/],
    ['wrong assertion graph', metaRows({ graph: `did:dkg:context-graph:${VCG}/_verifiable_memory/${AUTHOR}/11` }), /assertion graph/],
  ]) {
    const { n } = node(lost({ meta }))
    await assert.rejects(seal(n), e => transportFailure(e) && why.test(e.message), label)
  }
})

test('a lost publish is not success when the _meta read fails', async () => {
  const routes = lost()
  routes[5] = { method: 'POST', path: '/api/query', status: 500, body: { error: 'store unavailable' } }
  const { n } = node(routes)
  await assert.rejects(seal(n), e => transportFailure(e) && /could not be read/.test(e.message))
})

test('a lost publish is not success when the recorded UAL names another publisher', async () => {
  const other = `did:dkg:base:84532/0x${'b2'.repeat(20)}/10`
  const { n } = node(lost({ descriptor: { status: 'vm-confirmed', publishedUal: other }, meta: metaRows({ ual: other }) }))
  await assert.rejects(seal(n), e => transportFailure(e) && /was not published by/.test(e.message))
})

test('an unconfirmed transport error says a transaction may have been sent', async () => {
  const routes = happy({ publishStatus: 504, publishBody: { error: 'timeout' } })
  routes.push({ method: 'GET', path: /^\/api\/knowledge-assets\/g1\?/, body: { status: 'swm-shared' } })
  const { n } = node(routes)
  await assert.rejects(n.sealShareAnchor({ name: 'g1', contextGraphId: CG, quads: QUADS, sleep: noSleep }),
    e => e.stage === 'publish-transport' && e.mayHaveSent === true)
})

test('REAL: a lost response to a confirmed publish is reconciled to the UAL and transaction the node recorded', async () => {
  const name = 'forgery-b-00d9be2e29b46234'
  const rec = replay(name)
  const cg = rec[0].request.contextGraphId
  const out = rec.at(-1).response
  const [, addr, num] = out.ual.match(/\/(0x[0-9a-f]{40})\/(\d+)$/)
  const routes = routesFrom(name, cg)
  routes[routes.length - 1] = { method: 'POST', path: rec.at(-1).path, throw: Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET' } }) }
  routes.push(
    { method: 'GET', path: new RegExp(`^/api/knowledge-assets/${name}\\?`), body: { status: 'vm-confirmed', state: 'published', publishedUal: out.ual, vmCurrentAssertion: rec[0].response.merkleRoot.slice(2) } },
    { method: 'POST', path: '/api/query', body: { result: { type: 'bindings', bindings: [
      { s: out.ual, p: `${DKGNS}kaUal`, o: out.ual },
      { s: out.ual, p: `${DKGNS}status`, o: '"confirmed"' },
      { s: out.ual, p: `${DKGNS}assertionGraph`, o: `did:dkg:context-graph:${cg}/_verifiable_memory/${addr}/${num}` },
      { s: out.ual, p: `${DKGNS}transactionHash`, o: `"${out.txHash}"` },
    ] } } },
  )
  const { n } = node(routes)
  const r = await n.sealShareAnchor({ name, contextGraphId: cg, quads: QUADS, sleep: noSleep, expectAuthor: rec[0].response.authorAddress })
  assert.equal(r.ual, out.ual)
  assert.equal(r.txHash, out.txHash)
  assert.equal(r.reconciled, true)
})

/* Resume by name */

const existingAsset = descriptor => [
  { method: 'GET', path: /^\/api\/knowledge-assets\/g1\?/, body: descriptor },
  { method: 'POST', path: '/api/knowledge-assets', status: 201, body: { status: 'wm-sealed', merkleRoot: ROOT, authorAddress: AUTHOR } },
  { method: 'POST', path: '/api/knowledge-assets/g1/swm/share', body: { swmShared: true } },
  { method: 'POST', path: '/api/knowledge-assets/g1/vm/publish', body: { status: 'confirmed', ual: VUAL, txHash: '0xtx' } },
  { method: 'POST', path: '/api/query', body: { result: { type: 'bindings', bindings: metaRows() } } },
]
const resume = n => n.sealShareAnchor({ name: 'g1', contextGraphId: VCG, quads: QUADS, expectAuthor: AUTHOR, resume: true, sleep: noSleep })
const steps = calls => calls.map(c => c.method + ' ' + c.path.split('?')[0])

test('resume continues a sealed asset through share and publish without creating it again', async () => {
  const { n, calls } = node(existingAsset({ status: 'wm-sealed', wmCurrentAssertion: ROOT.slice(2), agentAddress: AUTHOR }))
  const r = await resume(n)
  assert.equal(r.ual, VUAL)
  assert.equal(r.txHash, '0xtx')
  assert.equal(r.resumed, true)
  assert.deepEqual(steps(calls), ['GET /api/knowledge-assets/g1', 'POST /api/knowledge-assets/g1/swm/share', 'POST /api/knowledge-assets/g1/vm/publish'])
})

test('resume publishes a shared asset without sharing it again', async () => {
  const { n, calls } = node(existingAsset({ status: 'swm-shared', swmCurrentAssertion: ROOT.slice(2), wmCurrentAssertion: ROOT.slice(2), agentAddress: AUTHOR }))
  assert.equal((await resume(n)).resumed, true)
  assert.deepEqual(steps(calls), ['GET /api/knowledge-assets/g1', 'POST /api/knowledge-assets/g1/vm/publish'])
})

test('resume of a verified published asset returns it and never publishes again', async () => {
  const { n, calls } = node(existingAsset({ status: 'vm-confirmed', state: 'published', publishedUal: VUAL, vmCurrentAssertion: ROOT.slice(2), wmCurrentAssertion: ROOT.slice(2), agentAddress: AUTHOR }))
  assert.deepEqual(await resume(n), { name: 'g1', ual: VUAL, txHash: null, resumed: true })
  assert.ok(!calls.some(c => c.method === 'POST' && c.path.startsWith('/api/knowledge-assets')))
})

test('resume refuses a tentative, unanchored, foreign or unknown asset and never publishes', async () => {
  const cases = [
    ['tentative', { status: 'vm-confirmed', publishedUal: `did:dkg:base:84532/${AUTHOR}/t1`, agentAddress: AUTHOR }, metaRows()],
    ['no _meta anchor', { status: 'vm-confirmed', publishedUal: VUAL, agentAddress: AUTHOR }, []],
    ['unconfirmed _meta anchor', { status: 'vm-confirmed', publishedUal: VUAL, agentAddress: AUTHOR }, metaRows({ status: 'tentative' })],
    ['no published UAL', { status: 'vm-confirmed', agentAddress: AUTHOR }, metaRows()],
    ['working copy changed', { status: 'vm-confirmed', publishedUal: VUAL, vmCurrentAssertion: ROOT.slice(2), wmCurrentAssertion: 'cd'.repeat(32), agentAddress: AUTHOR }, metaRows()],
    ['draft', { status: 'draft-open', agentAddress: AUTHOR }, metaRows()],
    ['unsealed share', { status: 'swm-shared-unsealed', agentAddress: AUTHOR }, metaRows()],
    ['sealed without a pointer', { status: 'wm-sealed', agentAddress: AUTHOR }, metaRows()],
    ['another author', { status: 'wm-sealed', wmCurrentAssertion: ROOT.slice(2), agentAddress: '0x' + 'b2'.repeat(20) }, metaRows()],
  ]
  for (const [label, descriptor, meta] of cases) {
    const routes = existingAsset(descriptor)
    routes[4].body = { result: { type: 'bindings', bindings: meta } }
    const { n, calls } = node(routes)
    await assert.rejects(resume(n), e => e instanceof DkgWriteError && e.stage === 'resume-refused' && e.name === 'g1', label)
    assert.ok(!calls.some(c => c.method === 'POST' && c.path.startsWith('/api/knowledge-assets')), `${label}: nothing is written`)
  }
})

test('write errors carry the asset name so the caller can resume it', async () => {
  const r = happy()
  r[2] = { method: 'POST', path: '/api/knowledge-assets/g1/swm/share', status: 409, body: { error: 'UNSEALED_SHARE_BLOCKED' } }
  const { n } = node(r)
  await assert.rejects(n.sealShareAnchor({ name: 'g1', contextGraphId: CG, quads: QUADS, sleep: noSleep }), e => e.stage === 'share' && e.name === 'g1' && e.assetName === 'g1')
  const { n: n2 } = node([{ method: 'GET', path: /^\/api\/knowledge-assets\/g1\?/, body: { status: 'vm-confirmed' } }])
  await assert.rejects(n2.sealShareAnchor({ name: 'g1', contextGraphId: CG, quads: QUADS }), e => e.stage === 'create' && e.name === 'g1')
  const r3 = happy()
  r3[1] = { method: 'POST', path: '/api/knowledge-assets', status: 500, body: { error: 'store unavailable' } }
  const { n: n3 } = node(r3)
  await assert.rejects(n3.sealShareAnchor({ name: 'g1', contextGraphId: CG, quads: QUADS }), e => e.stage === 'create' && e.name === 'g1')
})

/* Response size */

test('a response body over the limit is refused as a truncated read, whether declared or streamed', async () => {
  const declared = new DkgNode({ port: 9999, token: 't', maxResponseBytes: 1024,
    fetch: async () => new Response('{}', { status: 200, headers: { 'content-length': String(10 * 1024) } }) })
  await assert.rejects(declared.info(), e => e instanceof ResponseTooLargeError && e instanceof ReadTruncatedError && /larger than 1024 bytes/.test(e.message))

  let pulled = 0
  // Long enough to be far past the limit, but finite: a client that ignores the cap fails this test instead of hanging.
  const endless = () => new ReadableStream({ pull(c) { if (++pulled > 400) return c.close(); c.enqueue(new Uint8Array(512).fill(0x20)) } })
  const streamed = new DkgNode({ port: 9999, token: 't', maxResponseBytes: 4096, fetch: async () => new Response(endless(), { status: 200 }) })
  await assert.rejects(streamed.queryJson('SELECT *', { contextGraphId: CG }), ReadTruncatedError)
  assert.ok(pulled < 20, 'reading stops at the limit')

  const small = new DkgNode({ port: 9999, token: 't', maxResponseBytes: 4096, fetch: async () => new Response(JSON.stringify({ ok: 1 })) })
  assert.deepEqual(await small.info(), { ok: 1 })
})

test('the response limit cannot be switched off by a bad value', () => {
  for (const bad of [NaN, 0, -1, 1.5, '100', null]) {
    assert.throws(() => new DkgNode({ port: 9999, token: 't', maxResponseBytes: bad }), /maxResponseBytes/, String(bad))
  }
})

test('a body cut off mid-read is a transport error, so a publish reconciles instead of guessing', async () => {
  const broken = () => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"sta')); c.error(Object.assign(new Error('terminated'), { cause: { code: 'UND_ERR_SOCKET' } })) } })
  const n = new DkgNode({ port: 9999, token: 't', fetch: async () => new Response(broken()) })
  await assert.rejects(n.info(), e => e instanceof DkgHttpError && e.status === 0 && /cut off.*UND_ERR_SOCKET/.test(e.message))

  const routes = lost({ publishError: { status: 200, body: { status: 'confirmed', ual: VUAL, pad: 'x'.repeat(4096) } } })
  const f = fakeFetch(routes)
  const big = new DkgNode({ port: 9999, name: 'fake', token: 'tok', fetch: f.fetch, maxResponseBytes: 2048 })
  const r = await seal(big)
  assert.equal(r.reconciled, true, 'an unreadable publish response is reconciled from the anchor, not retried')
  assert.equal(f.calls.filter(c => c.path.includes('/vm/publish')).length, 1)
})

test('asset names with path or IRI-breaking characters are refused locally', async () => {
  const { n } = node([])
  for (const bad of ['a/b', 'a b', 'a<b', '']) {
    await assert.rejects(n.sealShareAnchor({ name: bad, contextGraphId: CG, quads: QUADS }), e => e.stage === 'create', bad)
  }
})

/* Replays of real v10.0.16 responses recorded by spikes/s6c-forgery.mjs */

import { readFileSync } from 'node:fs'
const recorded = JSON.parse(readFileSync(new URL('./fixtures/live/s6c-producer-writes.json', import.meta.url), 'utf8'))
const replay = name => recorded.filter(r => r.path === '/api/knowledge-assets' ? r.request?.name === name : r.path.includes(`/${name}/`))
const routesFrom = (name, cg) => [
  { method: 'GET', path: new RegExp(`^/api/knowledge-assets/${name}\\?`), status: 404, body: { error: 'not found' }, times: 1 },
  ...replay(name).map(r => ({ method: 'POST', path: r.path, status: r.status, body: r.response, times: 1 })),
]

test('REAL: a peer holding only a stub of another party\'s graph seals but cannot share; the write fails at share', async () => {
  const name = 'forgery-a-a92cfb76a7b92fa6'
  const cg = replay(name)[0].request.contextGraphId
  const { n, calls } = node(routesFrom(name, cg))
  await assert.rejects(n.sealShareAnchor({ name, contextGraphId: cg, quads: QUADS, sleep: noSleep }),
    e => e instanceof DkgWriteError && e.stage === 'share' && /temporarily unavailable/.test(e.message))
  assert.equal(calls.filter(c => c.path.endsWith('/swm/share')).length, 4, 'one attempt plus three retries of the documented transient')
  assert.ok(!calls.some(c => c.path.endsWith('/vm/publish')))
})

test('REAL: a confirmed publish returns the UAL and transaction the node reported', async () => {
  const name = 'forgery-b-00d9be2e29b46234'
  const rec = replay(name)
  const cg = rec[0].request.contextGraphId
  const { n } = node(routesFrom(name, cg))
  const r = await n.sealShareAnchor({ name, contextGraphId: cg, quads: QUADS, sleep: noSleep, expectAuthor: rec[0].response.authorAddress })
  assert.equal(r.ual, rec.at(-1).response.ual)
  assert.equal(r.txHash, rec.at(-1).response.txHash)
})

test('an unreadable or absent auth token throws NodeTokenError, so callers need not match its message', async () => {
  const { DkgNode: Node, NodeTokenError } = await import('../src/dkg.mjs')
  assert.throws(() => new Node({ port: 1, name: 'x' }).token, e => e instanceof NodeTokenError && /no auth token/.test(e.message))
  assert.throws(() => new Node({ port: 1, name: 'x', home: '/nonexistent-mandate-home' }).token, e => e instanceof NodeTokenError && /auth\.token/.test(e.message))
})
