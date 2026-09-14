/**
 * Opt-in, read-only integration test against the local DKG nodes.
 *
 *   MANDATE_INTEGRATION=1 npm run test:integration
 *
 * Replays the S6c result recorded in docs/SPIKES.md and docs/evidence/s6c-forgery.json
 * against whatever grantor (9201), producer (9202) and verifier (9203) nodes are
 * running here, and checks each one still gives the documented verdict for
 * subject 0xed1e…0b69:ana-s6c:
 *
 *   talking-head     PERMITTED under grant …8d37a4205f8391d7 only
 *   face-swap-video  REFUSED at capability-permitted
 *   G1               revoked, despite forgery (a)
 *   forgeries        exactly the three published from the producer's node
 *
 * Read-only by construction: every node gets a fetch that allows only
 * GET /api/status, /api/info, /api/agent/identity and POST /api/query, and the
 * test fails if anything else is attempted. The freshness check is off because
 * POST /api/context-graph/reconcile makes the node fetch and write; no state
 * store is passed, so nothing is written under ~/.mandate either.
 *
 * Skips cleanly when MANDATE_INTEGRATION is not set, or a node is not running
 * or has no readable auth token.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DkgNode } from '../../src/dkg.mjs'
import { readKnowledge } from '../../src/resolve.mjs'
import { decide, revocationOf } from '../../src/gate.mjs'

const GRANTOR = '0xed1eeb64cac09874257f05fd6b51a55695ad0b69'
const PRODUCER = '0x8eaa4857b22dddbfb5ebc476087fec39336e0cb5'
const SUBJECT = `${GRANTOR}:ana-s6c`
const GRANTS_CG = '0xeD1eeB64CaC09874257F05Fd6B51A55695ad0B69/mandate-grants'
const DERIVS_CG = '0x8EaA4857B22dddbfb5ebC476087FEc39336e0CB5/mandate-derivations'
const G1 = `urn:mandate:grant:${SUBJECT}:f5b751b4b13bb895`
const G2 = `urn:mandate:grant:${SUBJECT}:8d37a4205f8391d7`
const FORGERIES = [
  { ual: `did:dkg:base:84532/${PRODUCER}/3`, kind: 'misplaced-state' },
  { ual: `did:dkg:base:84532/${PRODUCER}/4`, kind: 'misplaced-grant' },
  { ual: `did:dkg:base:84532/${PRODUCER}/6`, kind: 'misplaced-grant' },
]

const ALLOWED = new Set(['GET /api/status', 'GET /api/info', 'GET /api/agent/identity', 'POST /api/query'])

const ROLES = [
  { role: 'grantor', port: 9201, home: '~/.dkg-mandate-grantor' },
  { role: 'producer', port: 9202, home: '~/.dkg-mandate-producer' },
  { role: 'verifier', port: 9203, home: '~/.dkg-mandate-verifier' },
].map(r => {
  const key = `MANDATE_${r.role.toUpperCase()}`
  return { ...r, port: Number(process.env[`${key}_PORT`] ?? r.port), home: process.env[`${key}_HOME`] ?? r.home }
})

const enabled = Boolean(process.env.MANDATE_INTEGRATION) && process.env.MANDATE_INTEGRATION !== '0'

/** A node whose transport refuses anything but the read-only calls, and records what was refused. */
function readOnlyNode({ role, port, home }) {
  const refused = []
  const guarded = async (url, init = {}) => {
    const u = new URL(url)
    const call = `${(init.method ?? 'GET').toUpperCase()} ${u.pathname}`
    if (!ALLOWED.has(call)) {
      refused.push(call)
      throw new Error(`integration test is read-only; refused ${call}`)
    }
    return fetch(url, init)
  }
  return { node: new DkgNode({ home, port, name: `mandate-${role}`, fetch: guarded, timeoutMs: 60_000 }), refused }
}

/** Why this node cannot be used here, or null. */
async function unusable(node) {
  try {
    await node.status()
  } catch (e) {
    return `not reachable on port ${node.port} (${e.message})`
  }
  try {
    void node.token
  } catch (e) {
    return e.message
  }
  return null
}

const request = capability => ({
  subject: SUBJECT, capability, useClass: 'advertising', territory: 'GB', at: new Date().toISOString(), estimatedUsd: 0.01,
})

for (const r of ROLES) {
  test(`S6c verdict from the ${r.role} node (read-only)`, { skip: enabled ? false : 'set MANDATE_INTEGRATION=1 to run against local nodes' }, async t => {
    const { node, refused } = readOnlyNode(r)
    const why = await unusable(node)
    if (why) return t.skip(`${r.role} node ${why}`)

    const cfg = { grantsCg: GRANTS_CG, derivationsCgs: [DERIVS_CG], trustedProducers: [PRODUCER], checkFreshness: false }
    // The node's documented omission fault can leave a read inconsistent; the
    // resolver retries within a read, and a few whole reads settle it.
    let k
    for (let i = 0; i < 3; i++) {
      k = await readKnowledge(node, cfg, { subject: SUBJECT })
      if (k.consistency.ok) break
    }
    assert.deepEqual(refused, [], 'only status, info, identity and query calls were made')
    assert.equal(k.consistency.ok, true, `read consistently: ${(k.consistency.reasons ?? [k.consistency.reason]).join('; ')}`)

    const ids = k.grants.map(g => g.id)
    assert.ok(ids.includes(G1) && ids.includes(G2), `both genuine grants are read (got ${ids.join(', ')})`)

    const talkingHead = decide(request('talking-head'), k)
    assert.equal(talkingHead.permit, true, `talking-head is permitted (${talkingHead.clause}: ${talkingHead.reason})`)
    assert.equal(talkingHead.grantId, G2, 'talking-head is permitted under G2 only')

    const faceSwap = decide(request('face-swap-video'), k)
    assert.equal(faceSwap.permit, false, 'face-swap-video is refused')
    assert.equal(faceSwap.clause, 'capability-permitted')

    const g1 = k.grants.find(g => g.id === G1)
    const revocation = revocationOf(g1, k.states)
    assert.equal(revocation.revoked, true, 'G1 is revoked despite the forged active state')
    assert.equal(revocation.by.publisher, GRANTOR)
    assert.equal(revocationOf(k.grants.find(g => g.id === G2), k.states).revoked, false, 'G2 is not revoked')

    // The three S6c forgeries are the records that claim this subject or its grants.
    const claims = (f, field) => (Array.isArray(f.claims?.[field]) ? f.claims[field] : [])
    const aboutS6c = f => claims(f, 'subject').includes(SUBJECT)
      || [...claims(f, 'stateOf'), ...claims(f, 'authorizedUnder')].some(id => id === G1 || id === G2)
    const show = list => JSON.stringify(list.map(f => ({ ual: f.ual, kind: f.kind, publisher: f.publisher })))
    const s6c = k.forgeries.filter(aboutS6c)
    assert.equal(s6c.length, 3, `exactly three forgeries about ana-s6c are reported (got ${show(s6c)})`)
    for (const want of FORGERIES) {
      const f = s6c.find(x => x.ual === want.ual)
      assert.ok(f, `forgery ${want.ual} is reported`)
      assert.equal(f.kind, want.kind)
      assert.equal(f.publisher, PRODUCER)
    }
    // Since the resolver stopped ignoring a trusted producer's legacy-format
    // records, the producer's pre-0.2.0 edge at …0cb5/1 (under the legacy grant
    // id urn:mandate:grant:eve-e3wr) is reported too. It claims nothing about
    // this subject; anything else unexpected fails here.
    const other = k.forgeries.filter(f => !aboutS6c(f))
    assert.ok(other.every(f => f.kind === 'legacy-format' && f.trusted === true && f.publisher === PRODUCER),
      `no other forgery is reported beyond the producer's legacy-format records (got ${show(other)})`)
    assert.deepEqual(refused, [], 'no call outside the read-only set was attempted')
  })
}
