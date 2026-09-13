import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { checkSpokenScope, consentScript } from '../src/scope.mjs'
import { captureConsent, awaitCapture, transcribe, transcriptFrom } from '../src/consent.mjs'
import { reconcile } from '../src/derivation.mjs'

const REQ = { capability: ['talking-head'], useClass: ['advertising'], territory: ['GB'] }
const scope = t => checkSpokenScope(t, REQ)

test('every requested term said plainly is matched', () => {
  const r = scope('I consent to a talking head video of my likeness for advertising in the United Kingdom.')
  assert.deepEqual([r.missing, r.contradicted], [[], []])
  assert.match(r.note, /mentions every requested term/)
})

test('aliases count: UK and Britain for GB, ads for advertising', () => {
  assert.deepEqual(scope('I agree to talking head ads in the UK.').missing, [])
  assert.deepEqual(scope('I give my permission for a talking head commercial in Britain.').missing, [])
})

test('LP-5: a negated consent is a contradiction, not a pass', () => {
  const r = scope('I do not consent to a talking head for advertising in GB.')
  assert.ok(r.contradicted.includes('consent'))
  assert.ok(r.contradicted.includes('advertising'))
  assert.match(r.note, /CONTRADICTS/)
})

test('negation stays in its clause and does not cross a comma', () => {
  const r = checkSpokenScope('I consent to ads, but not political, in the UK. A talking head is fine.', { ...REQ, useClass: ['advertising', 'political'] })
  assert.deepEqual(r.contradicted, ['political'])
  assert.deepEqual(r.missing, [])
})

test('"except" excludes what follows it', () => {
  assert.deepEqual(scope('I agree to talking head adverts everywhere except the UK.').contradicted, ['GB'])
})

test('substrings are not words: rugby is not GB, used is not US, let us is not the United States', () => {
  const r = checkSpokenScope('I agree. We used it at the rugby, let us see.', { territory: ['GB', 'US'] })
  assert.deepEqual(r.missing.sort(), ['GB', 'US'])
})

test('"do not mind" is not a refusal', () => {
  assert.deepEqual(scope("I don't mind advertising in Britain, and I agree to a talking head.").contradicted, [])
})

test('capabilities must be said too', () => {
  assert.deepEqual(scope('I consent to advertising in the UK.').missing, ['talking-head'])
})

test('an empty transcript misses everything', () => {
  const r = scope('')
  assert.equal(r.empty, true)
  assert.equal(r.covered, 0)
})

test('the consent script is generated from the grant\'s own clauses, and passes its own check', () => {
  const script = consentScript({ ...REQ, validUntil: '2026-12-12T00:00:00Z', maxSpendUsd: 5 })
  assert.match(script, /talking head/)
  assert.match(script, /United Kingdom/)
  assert.match(script, /12 December 2026/)
  assert.deepEqual([scope(script).missing, scope(script).contradicted], [[], []])
})

/* ---------------------------- capture, stubbed ---------------------------- */

function stubClient(script) {
  const calls = []
  return {
    calls,
    async callTool({ name, arguments: args }) {
      calls.push({ name, args })
      const q = script[name]
      if (!q?.length) throw new Error(`unscripted ${name}`)
      const next = q.length > 1 ? q.shift() : q[0]
      return typeof next === 'function' ? next(args) : next
    },
  }
}
const ok = (structuredContent, text = '') => ({ structuredContent, content: [{ type: 'text', text }] })
const bad = text => ({ isError: true, content: [{ type: 'text', text }] })

async function clipServer() {
  const server = createServer((req, res) => { res.writeHead(200); res.end(req.url === '/t.json' ? JSON.stringify({ text: 'I consent to a talking head for advertising in the UK.' }) : 'clip-bytes') })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) }
}

test('LP-4: when transcription fails, capture reports it and no scope — never a silent pass', async () => {
  const srv = await clipServer()
  try {
    const client = stubClient({
      request_upload: [ok({ page_url: 'https://agent.livepeer.org/u/aaaaaaaaaaaaaaaaaaaaaaaa', token: 'aaaaaaaaaaaaaaaaaaaaaaaa' })],
      get_upload: [ok({ status: 'pending' }), ok({ status: 'done', url: `${srv.base}/clip.mp4` })],
      run_capability: [bad('nemotron-asr failed: unsupported media type video/mp4')],
    })
    const r = await captureConsent({ requested: REQ, client, onLink: () => {} })
    assert.equal(r.captured, true)
    assert.match(r.sha256, /^[0-9a-f]{64}$/)
    assert.equal(r.transcript, null)
    assert.equal(r.scope, null)
    assert.match(r.asrError, /unsupported media type/)
  } finally {
    await srv.close()
  }
})

test('waiting continues until the link expires, not a fixed number of polls', async () => {
  let t = 0
  const client = stubClient({ get_upload: [() => { t += 20_000; return ok({ status: 'pending' }) }] })
  const r = await awaitCapture(client, 'aaaaaaaaaaaaaaaaaaaaaaaa', { deadline: 30 * 60_000, now: () => t })
  assert.equal(r.url, null)
  assert.equal(r.polls, 90)
  const expired = await awaitCapture(stubClient({ get_upload: [ok({ status: 'expired' })] }), 'aaaaaaaaaaaaaaaaaaaaaaaa')
  assert.equal(expired.status, 'expired')
})

test('a transcript returned as a link is fetched; a bare URL is never treated as speech', async () => {
  const srv = await clipServer()
  try {
    const viaLink = await transcribe(stubClient({ run_capability: [ok({ ok: true, url: `${srv.base}/t.json` }, `${srv.base}/t.json`)] }), 'https://x.test/c.mp4')
    assert.match(viaLink.transcript, /talking head/)
    await assert.rejects(transcribe(stubClient({ run_capability: [ok({ ok: true }, '')] }), 'https://x.test/c.mp4'), /no text/)
  } finally {
    await srv.close()
  }
  assert.equal(transcriptFrom({ output: { text: ' hello ' } }, ''), 'hello')
  assert.equal(transcriptFrom(null, 'Transcript: I agree'), 'I agree')
})

/* -------------------------------- reconcile ------------------------------- */

test('reconcile flags a billed render with no derivation edge', () => {
  const r = reconcile({ billedJobs: [{ jobId: 'mjob_a' }, { jobId: 'mjob_b' }], derivations: [{ jobId: 'mjob_a' }] })
  assert.equal(r.complete, false)
  assert.equal(r.orphans.length, 1)
  assert.match(r.note, /INCOMPLETE/)
})

test('reconcile passes when every billed render is recorded', () => {
  assert.equal(reconcile({ billedJobs: [{ jobId: 'mjob_a' }], derivations: [{ jobId: 'mjob_a' }] }).complete, true)
})
