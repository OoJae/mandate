/**
 * S6c — forgery, live, from the producer's own node.
 *
 * The adversarial study showed v0.1.0 believed self-declared authors: a
 * producer could write a state naming the grantor and un-revoke a grant, or
 * write a grant naming the grantor and have it permitted. This spike does
 * exactly that on Base Sepolia, then reads the result back from both nodes.
 *
 *   1. The grantor (CLI, its own node) grants G1 and G2 for subject ana-s6c,
 *      and revokes G1.
 *   2. The producer (its own node, straight to the DKG API — the CLI refuses)
 *      anchors three forgeries:
 *        a. an "active" state for G1 whose stateAuthor is the grantor
 *        b. a grant for ana-s6c, naming the grantor, in its own derivations graph
 *        c. a grant for ana-s6c naming itself as grantor, in the grants graph
 *      (a) and (c) target the grants graph; if this node cannot write there, the
 *      refusal is recorded and they go to the derivations graph instead.
 *   3. Both nodes resolve the subject. Expected: talking-head PERMITTED under G2
 *      only, face-swap-video REFUSED, G1 still revoked, and every forgery
 *      reported with its UAL and transaction.
 *
 *   node spikes/s6c-forgery.mjs            (spends ~6 Base Sepolia publishes)
 *   node spikes/s6c-forgery.mjs --reread   (step 3 only, from the saved evidence)
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync, readFileSync } from 'node:fs'
import { GRANTOR, PRODUCER, grantsCg, derivationsCg, readConfig } from '../bin/config.mjs'
import { readKnowledge } from '../src/resolve.mjs'
import { decide, revocationOf } from '../src/gate.mjs'
import { memoryStateStore } from '../src/state-store.mjs'
import { DkgNode, DkgWriteError } from '../src/dkg.mjs'
import { literalTerm, dateTimeTerm, nonce16, agentAddress } from '../src/rdf-term.mjs'
import * as V from '../src/vocab.mjs'

const run = promisify(execFile)
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const log = []
const say = (...parts) => { const line = parts.join(' '); log.push(line); console.log(line) }
const evidence = { startedAt: new Date().toISOString(), grantor: {}, forgeries: [], reads: {} }

async function cli(args) {
  const t = Date.now()
  try {
    const { stdout } = await run(process.execPath, ['bin/mandate.mjs', ...args, '--yes', '--json'], { maxBuffer: 1 << 24 })
    return { code: 0, ms: Date.now() - t, out: JSON.parse(stdout) }
  } catch (e) {
    return { code: e.code, ms: Date.now() - t, out: e.stdout ? JSON.parse(e.stdout) : { error: e.message } }
  }
}

// Record every write response the producer's node gives, with no credentials.
const recorded = []
const recordingFetch = async (url, init) => {
  const res = await fetch(url, init)
  const text = await res.text()
  if (init?.method === 'POST' && !String(url).endsWith('/api/query')) {
    recorded.push({ path: new URL(url).pathname, request: JSON.parse(init.body ?? 'null'), status: res.status, response: text ? JSON.parse(text) : null })
  }
  return new Response(text, { status: res.status, headers: res.headers })
}

const grantorNode = GRANTOR()
const base = PRODUCER()
const producer = new DkgNode({ home: base.home, port: base.port, name: base.name, fetch: recordingFetch })
const ana = agentAddress((await grantorNode.identity()).agentDid)
const prod = agentAddress((await producer.identity()).agentDid)
const SUBJECT = `${ana}:ana-s6c`
const REREAD = process.argv.includes('--reread')
let g1, g2, r1
if (REREAD) {
  Object.assign(evidence, JSON.parse(readFileSync('docs/evidence/s6c-forgery.json', 'utf8')), { reads: {} })
  log.push(...readFileSync('docs/evidence/s6c-forgery.txt', 'utf8').split('\n').filter(l => !/^\s|^$|node, resolved|^wrote|not synced/.test(l)))
  g1 = { out: evidence.grantor.G1 }
  say(`\nre-read at ${new Date().toISOString()}`)
}
if (!REREAD) {
say(`grantor ${ana}  producer ${prod}  subject ${SUBJECT}`)

/* 1. Genuine grants and a revocation, through the CLI on the grantor's node */
const grantFlags = caps => ['grant', '--subject', 'ana-s6c', '--capability', caps, '--use-class', 'advertising', '--territory', 'GB', '--max-spend', '5']
g1 = await cli(grantFlags('talking-head'))
if (g1.code !== 0) throw new Error(`G1 grant failed: ${JSON.stringify(g1.out)}`)
say(`G1 granted in ${g1.ms}ms  ${g1.out.grant.id}  ${g1.out.ual}  tx ${g1.out.txHash}`)
g2 = await cli(grantFlags('talking-head'))
if (g2.code !== 0) throw new Error(`G2 grant failed: ${JSON.stringify(g2.out)}`)
say(`G2 granted in ${g2.ms}ms  ${g2.out.grant.id}  ${g2.out.ual}  tx ${g2.out.txHash}`)
r1 = await cli(['revoke', '--id', g1.out.grant.id])
if (r1.code !== 0) throw new Error(`G1 revoke failed: ${JSON.stringify(r1.out)}`)
say(`G1 revoked in ${r1.ms}ms  ${r1.out.ual}  tx ${r1.out.txHash}`)
evidence.grantor = { G1: g1.out, G2: g2.out, revokeG1: r1.out }

/* 2. Forgeries, anchored by the producer */
const q = (s, p, o) => ({ subject: s, predicate: p, object: o })
const anaDid = `did:dkg:agent:${ana}`
const now = new Date().toISOString()

const activeId = `urn:mandate:state:${nonce16()}`
const forgedActive = [
  q(activeId, RDF_TYPE, V.GrantState), q(activeId, V.stateOf, g1.out.grant.id), q(activeId, V.state, literalTerm('active')),
  q(activeId, V.stateAuthor, anaDid), q(activeId, V.stateAt, dateTimeTerm(now)),
]
const fakeGrant = (id, grantor) => [
  q(id, RDF_TYPE, V.LikenessGrant), q(id, V.grantor, grantor), q(id, V.subject, literalTerm(SUBJECT)),
  q(id, V.permitsCapability, literalTerm('face-swap-video')), q(id, V.permitsCapability, literalTerm('talking-head')),
  q(id, V.permitsUseClass, literalTerm('advertising')), q(id, V.maxSpendUsd, literalTerm('1000', { datatype: 'http://www.w3.org/2001/XMLSchema#decimal' })),
]
// Grant ids in the grantor's own format, so only publisher checks can reject them.
const namingAna = `urn:mandate:grant:${SUBJECT}:${nonce16()}`
const namingSelf = `urn:mandate:grant:${SUBJECT}:${nonce16()}`

const plans = [
  { key: 'a', what: '"active" state for G1 naming the grantor as author', quads: forgedActive, targets: [grantsCg(), derivationsCg()] },
  { key: 'b', what: 'grant for the subject naming the grantor, in the producer\'s own graph', quads: fakeGrant(namingAna, anaDid), targets: [derivationsCg()] },
  { key: 'c', what: 'grant for the subject naming the producer as grantor', quads: fakeGrant(namingSelf, `did:dkg:agent:${prod}`), targets: [grantsCg(), derivationsCg()] },
]
for (const p of plans) {
  const attempts = []
  for (const cg of p.targets) {
    const name = `forgery-${p.key}-${nonce16()}`
    const t = Date.now()
    try {
      const r = await producer.sealShareAnchor({ name, contextGraphId: cg, quads: p.quads, expectAuthor: prod })
      attempts.push({ contextGraphId: cg, ok: true, ms: Date.now() - t, ual: r.ual, txHash: r.txHash })
      say(`(${p.key}) anchored in ${cg} in ${Date.now() - t}ms  ${r.ual}  tx ${r.txHash}`)
      break
    } catch (e) {
      if (!(e instanceof DkgWriteError)) throw e
      attempts.push({ contextGraphId: cg, ok: false, stage: e.stage, status: e.status ?? null, error: e.message, ual: e.ual, txHash: e.txHash })
      say(`(${p.key}) refused in ${cg} at ${e.stage}: ${e.message.slice(0, 160)}`)
      if (e.ual || e.mayHaveSent) break
    }
  }
  evidence.forgeries.push({ key: p.key, what: p.what, attempts })
}

}

/* 3. Both nodes resolve */
const cfg = () => ({ ...readConfig(), stateStore: memoryStateStore() })
const expectForgeries = evidence.forgeries.filter(f => f.attempts.some(a => a.ok)).length
const summarise = (k, d) => ({
  consistency: k.consistency, grants: k.grants.map(g => g.id), states: k.states.map(s => ({ id: s.id, stateOf: s.stateOf, publisher: s.publisher, ual: s.ual })),
  forgeries: k.forgeries.map(f => ({ kind: f.kind, id: f.id, publisher: f.publisher, ual: f.ual, txHash: f.txHash, anchored: f.anchored ?? null, detail: f.detail })),
  decisions: d,
})
for (const [label, node] of [['producer', PRODUCER()], ['grantor', grantorNode]]) {
  const t = Date.now()
  let k
  for (;;) {
    k = await readKnowledge(node, cfg(), { subject: SUBJECT })
    const ready = k.consistency.ok && k.grants.length === 2 && k.states.length >= 1 && k.forgeries.length >= expectForgeries
    if (ready) break
    if (Date.now() - t > 6 * 60_000) { say(`${label}: not synced after 6 minutes; recording what it sees`); break }
    await new Promise(r => setTimeout(r, 10_000))
  }
  const req = capability => ({ subject: SUBJECT, capability, useClass: 'advertising', territory: 'GB', at: new Date().toISOString(), estimatedUsd: 1 })
  const d = { talkingHead: decide(req('talking-head'), k), faceSwap: decide(req('face-swap-video'), k) }
  const g1Grant = k.grants.find(g => g.id === g1.out.grant.id)
  const g1Revoked = g1Grant ? revocationOf(g1Grant, k.states).revoked : null
  say(`\n${label} node, resolved after ${Date.now() - t}ms`)
  say(`  talking-head     ${d.talkingHead.permit ? `PERMITTED under ${d.talkingHead.grantId}` : `REFUSED ${d.talkingHead.clause}`}`)
  say(`  face-swap-video  ${d.faceSwap.permit ? `PERMITTED under ${d.faceSwap.grantId}` : `REFUSED ${d.faceSwap.clause}`}`)
  say(`  G1 revoked       ${g1Revoked}`)
  for (const f of k.forgeries) say(`  forgery ${f.kind.padEnd(22)} ${f.publisher}  ${f.ual}  tx ${f.txHash ?? 'unread'}`)
  evidence.reads[label] = { ms: Date.now() - t, g1Revoked, ...summarise(k, {
    talkingHead: { permit: d.talkingHead.permit, clause: d.talkingHead.clause, grantId: d.talkingHead.grantId },
    faceSwap: { permit: d.faceSwap.permit, clause: d.faceSwap.clause, grantId: d.faceSwap.grantId },
  }) }
}

evidence.finishedAt = new Date().toISOString()
writeFileSync('docs/evidence/s6c-forgery.json', JSON.stringify(evidence, null, 2))
writeFileSync('docs/evidence/s6c-forgery.txt', log.join('\n') + '\n')
if (!REREAD) writeFileSync('test/fixtures/live/s6c-producer-writes.json', JSON.stringify(recorded, null, 2))
say('\nwrote docs/evidence/s6c-forgery.{json,txt} and test/fixtures/live/s6c-producer-writes.json')
