/**
 * A local HTTP server speaking the DKG v10 daemon routes Mandate uses, backed
 * by FakeNode, so CLI tests run the real client, parser and exit codes.
 *
 * Publishing a KA adds it to the in-memory world with a confirmed anchor, so a
 * grant published by one command is read back by the next.
 *
 * Asset descriptors carry the lifecycle fields a v10 node keeps (agentAddress
 * and the bare-hex wm/swm/vm pointers), so a write can be resumed. `scenario`
 * is read on every request, so a test can change it between commands:
 *   create: 'fail'      share: 'fail'
 *   publish: 'unbound'  (207, minted but not bound)
 *   publish: 'lost'     (503 after send; the asset stays shared until confirm(name))
 *   ualSuffix, txHash   (what a successful publish reports)
 */
import { createServer } from 'node:http'
import { FakeNode } from './fake-node.mjs'
import { ka } from './build.mjs'

export async function startFakeDkg({ address, name = 'fake', token = 'test-token', world = {}, scenario = {} }) {
  const node = new FakeNode({ world, name })
  const assets = new Map()
  const calls = []
  const did = `did:dkg:agent:${address}`
  const root = '1'.repeat(64)

  /** Anchor an asset as published, as the chain would after a lost response. */
  const publishAsset = assetName => {
    const a = assets.get(assetName)
    const published = ka({ cg: a.cg, publisher: address.toLowerCase(), quads: a.quads })
    ;(world[a.cg] ??= { kas: [] }).kas ??= []
    world[a.cg].kas.push(published)
    a.descriptor = { ...a.descriptor, status: 'vm-confirmed', state: 'published', publishedUal: published.ual, vmCurrentAssertion: root }
    return published
  }

  const send = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    let body = ''
    for await (const chunk of req) body += chunk
    const json = body ? JSON.parse(body) : {}
    calls.push({ method: req.method, path: url.pathname, body: json })
    if (url.pathname !== '/api/status' && req.headers.authorization !== `Bearer ${token}`) return send(res, 401, { error: 'unauthorized' })

    if (url.pathname === '/api/agent/identity') return send(res, 200, { agentAddress: address, agentDid: did })
    if (url.pathname === '/api/info') return send(res, 200, { version: '10.0.16', peers: 1, chain: { chainId: 'base:84532' } })
    if (url.pathname === '/api/status') return send(res, 200, { name })
    if (url.pathname === '/api/context-graph/reconcile') {
      const n = (world[json.contextGraphId]?.kas ?? []).length
      const behind = scenario.staleBy ?? 0
      return send(res, 200, { contextGraphId: json.contextGraphId, status: behind ? 'pending' : 'current', headOrdinal: n + behind, watermarkBefore: n, watermarkAfter: n })
    }
    if (url.pathname === '/api/context-graph/subscriptions') {
      return send(res, 200, { subscriptions: Object.keys(world).map(id => ({ contextGraphId: id, subscribed: true })) })
    }
    if (url.pathname === '/api/query') {
      try {
        const bindings = await node.queryJson(json.sparql, { contextGraphId: json.contextGraphId, includeSharedMemory: json.includeSharedMemory, view: json.view, max: 100000 })
        return send(res, 200, { result: { type: 'bindings', bindings } })
      } catch (e) {
        return send(res, 400, { error: e.message })
      }
    }
    const m = url.pathname.match(/^\/api\/knowledge-assets(?:\/([^/]+))?(?:\/(swm\/share|vm\/publish))?$/)
    if (m) {
      const [, rawName, action] = m
      const assetName = rawName ? decodeURIComponent(rawName) : json.name
      if (req.method === 'GET') {
        const a = assets.get(assetName)
        return a ? send(res, 200, a.descriptor) : send(res, 404, { error: 'not found' })
      }
      if (!action) {
        if (scenario.create === 'fail') return send(res, 500, { error: 'store unavailable' })
        if (assets.has(assetName)) return send(res, 409, { error: 'exists' })
        assets.set(assetName, { quads: json.quads, cg: json.contextGraphId, descriptor: { status: 'wm-sealed', agentAddress: address, wmCurrentAssertion: root } })
        return send(res, 201, { status: 'wm-sealed', merkleRoot: `0x${root}`, authorAddress: address, assertionUri: `urn:x:${assetName}` })
      }
      const a = assets.get(assetName)
      if (!a) return send(res, 404, { error: 'not found' })
      if (action === 'swm/share') {
        if (scenario.share === 'fail') return send(res, 500, { error: 'share rejected' })
        a.descriptor = { ...a.descriptor, status: 'swm-shared', swmCurrentAssertion: root }
        return send(res, 200, { swmShared: true })
      }
      const txHash = scenario.txHash ?? `0x${'ab'.repeat(32)}`
      if (scenario.publish === 'unbound') {
        const minted = ka({ cg: a.cg, publisher: address.toLowerCase(), quads: a.quads })
        return send(res, 207, { ual: minted.ual, txHash, contextGraphError: 'binding reverted' })
      }
      if (scenario.publish === 'lost') return send(res, 503, { error: 'chain connection lost' })
      const published = publishAsset(assetName)
      return send(res, 200, { status: 'confirmed', ual: `${published.ual}${scenario.ualSuffix ?? ''}`, txHash, blockNumber: 1 })
    }
    return send(res, 404, { error: `no route ${url.pathname}` })
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return {
    port: server.address().port, token, world, calls, assets, scenario,
    confirm: publishAsset,
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r) }),
  }
}
