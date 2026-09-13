import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DkgNode, DkgHttpError, DkgWriteError, ReadTruncatedError } from '../src/dkg.mjs'

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

test('a transport error after send is reconciled from the node record, never retried', async () => {
  const routes = happy({ publishStatus: 503, publishBody: { error: 'chain RPC transport' } })
  routes.push({ method: 'GET', path: /^\/api\/knowledge-assets\/g1\?/, body: { status: 'vm-confirmed', publishedUal: 'did:dkg:base:84532/0xa/10' } })
  const { n, calls } = node(routes)
  const r = await n.sealShareAnchor({ name: 'g1', contextGraphId: CG, quads: QUADS, sleep: noSleep })
  assert.equal(r.ual, 'did:dkg:base:84532/0xa/10')
  assert.equal(r.reconciled, true)
  assert.equal(calls.filter(c => c.path.includes('/vm/publish')).length, 1, 'publish must not be retried')
})

test('an unconfirmed transport error says a transaction may have been sent', async () => {
  const routes = happy({ publishStatus: 504, publishBody: { error: 'timeout' } })
  routes.push({ method: 'GET', path: /^\/api\/knowledge-assets\/g1\?/, body: { status: 'swm-shared' } })
  const { n } = node(routes)
  await assert.rejects(n.sealShareAnchor({ name: 'g1', contextGraphId: CG, quads: QUADS, sleep: noSleep }),
    e => e.stage === 'publish-transport' && e.mayHaveSent === true)
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
