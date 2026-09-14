import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { recordDerivation, reconcile } from '../src/derivation.mjs'
import { DkgWriteError } from '../src/dkg.mjs'

const SHA = 'ab'.repeat(32)
const NONCE = '0123456789abcdef'
const ID = `urn:mandate:derivation:${SHA.slice(0, 16)}:${NONCE}`
const NAME = `derivation-${SHA.slice(0, 16)}-${NONCE}`
const CG = `0x${'a1'.repeat(20)}/mandate-derivations`
const GRANT = `urn:mandate:grant:0x${'b2'.repeat(20)}:ana:${'c3'.repeat(8)}`
const base = { outputSha256: SHA, servedCapability: 'talking-head', authorizedUnder: GRANT, derivedAt: '2026-09-14T10:00:00Z', expectAuthor: `0x${'a1'.repeat(20)}` }

/** A producer node that records what it was asked to anchor. */
function fakeNode({ fail } = {}) {
  const calls = []
  return {
    calls,
    async identity() { calls.push({ identity: true }); return { agentDid: `did:dkg:agent:0x${'a1'.repeat(20)}` } },
    async sealShareAnchor(args) {
      calls.push(args)
      if (fail) throw fail
      return { name: args.name, ual: `did:dkg:base:84532/0x${'a1'.repeat(20)}/5`, txHash: '0xtx', merkleRoot: '0xroot', authorAddress: `0x${'a1'.repeat(20)}` }
    },
  }
}
const subjectOf = args => args.quads[0].subject

test('without an id, a fresh id and a matching asset name are minted', async () => {
  const n = fakeNode()
  const r = await recordDerivation(n, CG, base)
  assert.match(r.id, new RegExp(`^urn:mandate:derivation:${SHA.slice(0, 16)}:[0-9a-f]{16}$`))
  assert.equal(r.name, `derivation-${SHA.slice(0, 16)}-${r.id.split(':').at(-1)}`)
  assert.equal(n.calls[0].name, r.name)
  assert.equal(n.calls[0].resume, false)
  assert.equal(subjectOf(n.calls[0]), r.id)
})

test('a caller-supplied id is reused with its own asset name, and resume is passed through', async () => {
  const n = fakeNode()
  const r = await recordDerivation(n, CG, { ...base, id: ID, resume: true })
  assert.equal(r.id, ID)
  assert.equal(r.name, NAME)
  assert.equal(n.calls[0].name, NAME)
  assert.equal(n.calls[0].resume, true)
  assert.equal(subjectOf(n.calls[0]), ID)
  assert.equal(r.ual, `did:dkg:base:84532/0x${'a1'.repeat(20)}/5`)

  const n2 = fakeNode()
  const r2 = await recordDerivation(n2, CG, { ...base, name: NAME, resume: true })
  assert.equal(r2.id, ID, 'the id follows from a saved asset name')
  assert.equal(n2.calls[0].name, NAME)
})

test('a caller-supplied id or name is validated before anything is fetched or written', async () => {
  const bad = [
    [{ id: 'urn:mandate:derivation:xyz' }, /derivation id must look like/],
    [{ id: `${ID}>` }, /derivation id must look like/],
    [{ name: 'g1' }, /asset name must look like/],
    [{ id: ID, name: `derivation-${SHA.slice(0, 16)}-${'f'.repeat(16)}` }, /do not belong together/],
    [{ id: `urn:mandate:derivation:${'cd'.repeat(8)}:${NONCE}` }, /made for other bytes/],
    [{ resume: 'yes' }, /resume must be true or false/],
  ]
  for (const [over, why] of bad) {
    const n = fakeNode()
    await assert.rejects(recordDerivation(n, CG, { ...base, ...over }), why, JSON.stringify(over))
    assert.equal(n.calls.length, 0, `${JSON.stringify(over)}: the node is never called`)
  }
})

test('billedUsd must be finite and non-negative, or null, and is checked before the media is downloaded', async () => {
  // 1e21 and Number.MAX_VALUE are finite but cannot be written as a plain decimal.
  for (const billedUsd of [-1, NaN, Infinity, 1e21, Number.MAX_VALUE, '-0.5', '1e3', ' 5', '00.5', true, {}]) {
    let fetched = 0
    const n = fakeNode()
    const fetch = async () => { fetched++; return new Response('bytes') }
    await assert.rejects(recordDerivation(n, CG, { ...base, outputSha256: undefined, outputUrl: 'http://127.0.0.1:9/m.mp4', billedUsd, fetchOptions: { fetch, sleep: async () => {} } }),
      /billedUsd must be a finite non-negative amount/, String(billedUsd))
    assert.equal(fetched, 0, `${String(billedUsd)}: nothing downloaded`)
    assert.equal(n.calls.length, 0)
  }
  for (const billedUsd of [0, 0.25, 999999999999999.9, '4.50', null, undefined]) {
    const n = fakeNode()
    await recordDerivation(n, CG, { ...base, billedUsd })
    const amount = n.calls.at(-1).quads.find(q => q.predicate.endsWith('billedUsd'))
    assert.equal(Boolean(amount), billedUsd !== null && billedUsd !== undefined, String(billedUsd))
  }
})

test('fetchOptions reach the hashing of outputUrl', async () => {
  const body = 'rendered bytes'
  let seen
  const fetch = async (url, init) => { seen = { url: String(url), signal: init.signal }; return new Response(body) }
  const n = fakeNode()
  const r = await recordDerivation(n, CG, { ...base, outputSha256: undefined, outputUrl: 'https://media.example/out.mp4', fetchOptions: { fetch, maxBytes: 1024 } })
  assert.equal(seen.url, 'https://media.example/out.mp4')
  assert.equal(r.outputSha256, createHash('sha256').update(body).digest('hex'))

  const tooSmall = async () => new Response('x'.repeat(64))
  await assert.rejects(recordDerivation(fakeNode(), CG, { ...base, outputSha256: undefined, outputUrl: 'https://media.example/out.mp4', fetchOptions: { fetch: tooSmall, maxBytes: 8 } }), /limit/)
})

test('lastPublishUnknown reaches the node and must be a boolean', async () => {
  const n = fakeNode()
  await recordDerivation(n, CG, { ...base, id: ID, resume: true, lastPublishUnknown: true })
  assert.equal(n.calls[0].lastPublishUnknown, true)
  const n2 = fakeNode()
  await recordDerivation(n2, CG, base)
  assert.equal(n2.calls[0].lastPublishUnknown, false, 'defaults to false')
  const n3 = fakeNode()
  await assert.rejects(recordDerivation(n3, CG, { ...base, lastPublishUnknown: 'yes' }), /lastPublishUnknown must be true or false/)
  assert.equal(n3.calls.length, 0)
})

test('a failed anchor carries the derivation id and asset name so a retry can resume the same asset', async () => {
  const fail = new DkgWriteError('publishing did not confirm', { name: NAME, stage: 'publish-transport', mayHaveSent: true })
  const n = fakeNode({ fail })
  await assert.rejects(recordDerivation(n, CG, { ...base, id: ID }), e => e === fail && e.derivationId === ID && e.name === NAME && e.mayHaveSent === true)
})

test('reconcile counts only trusted derivation edges', () => {
  const billedJobs = [{ jobId: 'mjob_a' }, { jobId: 'mjob_b' }]
  const forged = reconcile({ billedJobs, derivations: [{ jobId: 'mjob_a', trusted: true }, { jobId: 'mjob_b', trusted: false }] })
  assert.equal(forged.complete, false, 'an untrusted edge must not hide an orphan')
  assert.deepEqual(forged.orphans, [{ jobId: 'mjob_b' }])
  assert.equal(forged.recorded, 1)
  assert.equal(forged.untrusted, 1)

  const unmarked = reconcile({ billedJobs: [{ jobId: 'mjob_a' }], derivations: [{ jobId: 'mjob_a' }] })
  assert.equal(unmarked.complete, false, 'an edge not marked trusted is not counted')
  for (const trusted of ['true', 1]) {
    const loose = reconcile({ billedJobs: [{ jobId: 'mjob_a' }], derivations: [{ jobId: 'mjob_a', trusted }] })
    assert.equal(loose.complete, false, `trusted: ${JSON.stringify(trusted)} is not trusted === true`)
  }

  const ok = reconcile({ billedJobs, derivations: [{ jobId: 'mjob_a', trusted: true }, { jobId: 'mjob_b', trusted: true }] })
  assert.equal(ok.complete, true)
})
