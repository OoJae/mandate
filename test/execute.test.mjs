import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dispatchRender, extractMediaUrl, pollJob, RenderError } from '../src/execute.mjs'
import { callStrict, LivepeerToolError } from '../src/livepeer.mjs'
import { checkInputs, dispatchMode, estimateFromPricing } from '../src/capabilities.mjs'
import { sha256OfUrl, FetchBytesError } from '../src/fetch-bytes.mjs'
import { renderKey, pendingStore } from '../src/pending.mjs'

const IMG = 'https://agent.livepeer.org/a/img.jpg'
const AUD = 'https://agent.livepeer.org/a/voice.wav'
const OUT = 'https://agent.livepeer.org/a/out.mp4?sig=abc'

/** A scripted MCP client: each tool name maps to a list of responses, consumed in order. */
function stubClient(script) {
  const calls = []
  return {
    calls,
    async callTool({ name, arguments: args }, _schema, opts) {
      calls.push({ name, args, opts })
      const queue = script[name]
      if (!queue?.length) throw new Error(`unscripted call ${name}`)
      const next = queue.length > 1 ? queue.shift() : queue[0]
      if (next instanceof Error) throw next
      return next
    },
  }
}
const ok = (structuredContent, text = '') => ({ structuredContent, content: [{ type: 'text', text }] })
const err = (structuredContent, text) => ({ isError: true, structuredContent, content: [{ type: 'text', text }] })

test('inline renders force the blocking path and stay under the 300s stream limit', async () => {
  const client = stubClient({ run_capability: [ok({ ok: true, capability: 'sync-lipsync-v3', url: OUT, cost_usd_estimated: 0.7 })] })
  const r = await dispatchRender(client, { capability: 'sync-lipsync-v3', inputs: { image_url: IMG, audio_url: AUD }, idempotencyKey: 'mandate-k' })
  assert.equal(r.url, OUT)
  assert.equal(r.costUsdEstimated, 0.7)
  const { args, opts } = client.calls[0]
  assert.equal(args.async, false)
  assert.ok(args.timeout <= 280)
  assert.ok(opts.timeout < 300_000)
  assert.equal(args.idempotency_key, 'mandate-k')
})

test('a platform error is a failure, never a result', async () => {
  const client = stubClient({ run_capability: [err({ error: 'provider stream ended' }, 'SDK /inference failed: stream ended before returning a result')] })
  await assert.rejects(dispatchRender(client, { capability: 'face-swap-image', inputs: { image_url: IMG } }),
    e => e instanceof RenderError && e.kind === 'tool' && /stream ended/.test(e.message))
  await assert.rejects(callStrict(stubClient({ x: [err(null, 'nope')] }), 'x'), LivepeerToolError)
})

test('payment and credential failures are told apart', async () => {
  const client = stubClient({ run_capability: [err(null, 'Daydream `sk_` API keys are retired and can no longer pay for inference')] })
  await assert.rejects(dispatchRender(client, { capability: 'talking-head', inputs: { image_url: IMG, audio_url: AUD } }), e => e.kind === 'payment')
})

test('THE LOGGED CASE: a queued job is polled to completion instead of exiting 0 with nothing', async () => {
  const client = stubClient({
    run_capability: [ok({ status: 'submitted', job_id: 'mjob_93244be79885' }, 'Job mjob_93244be79885 is NOT done — poll get_create_media')],
    get_create_media: [ok({ status: 'queued' }), ok({ status: 'running' }), ok({ status: 'done', url: OUT, source_url: IMG, cost_usd_estimated: 1.01, capability: 'talking-head' })],
  })
  let job
  const r = await dispatchRender(client, { capability: 'talking-head', inputs: { image_url: IMG, audio_url: AUD }, onJob: id => { job = id }, poll: { sleep: async () => {} } })
  assert.equal(job, 'mjob_93244be79885')
  assert.equal(r.url, OUT)
  assert.equal(r.mode, 'async')
  assert.equal(client.calls.filter(c => c.name === 'get_create_media').length, 3)
})

test('a failed job surfaces its error and job id', async () => {
  const client = stubClient({ get_create_media: [err({ status: 'failed', error: 'no heartbeat for 127s' }, 'failed')] })
  await assert.rejects(pollJob(client, 'mjob_1cec6bfe884c', { sleep: async () => {} }), e => e.jobId === 'mjob_1cec6bfe884c' && /heartbeat/.test(e.message))
})

test('a job that outlives the wait is a timeout that keeps its job id for recovery', async () => {
  let t = 0
  const client = stubClient({ get_create_media: [ok({ status: 'running' })] })
  await assert.rejects(pollJob(client, 'mjob_aaaaaaaaaaaa', { sleep: async () => { t += 60_000 }, now: () => t, maxWaitMs: 120_000 }),
    e => e.kind === 'timeout' && e.jobId === 'mjob_aaaaaaaaaaaa')
})

test('no media URL is a failure', async () => {
  const client = stubClient({ run_capability: [ok({ ok: true }, `Rendered from ${IMG}`)] })
  await assert.rejects(dispatchRender(client, { capability: 'sync-lipsync-v3', inputs: { image_url: IMG, audio_url: AUD } }), e => e.kind === 'no-media')
})

test('media URLs: structured first, never an echoed input, query strings kept, any media extension', () => {
  assert.equal(extractMediaUrl({ url: OUT }, '', [IMG]), OUT)
  assert.equal(extractMediaUrl(null, `input ${IMG} → output https://v3b.fal.media/files/x.wav.`, [IMG]), 'https://v3b.fal.media/files/x.wav')
  assert.equal(extractMediaUrl(null, `input ${IMG}`, [IMG]), null)
  assert.equal(extractMediaUrl({ url: 'javascript:alert(1)' }, 'https://h.test/a.webp?x=1'), 'https://h.test/a.webp?x=1')
})

test('required inputs are checked before any dispatch', () => {
  assert.deepEqual(checkInputs('sync-lipsync-v3', { image_url: IMG }), { ok: false, missing: ['audio_url'], verified: true })
  assert.equal(checkInputs('sync-lipsync-v3', { image_url: IMG, audio_url: AUD }).ok, true)
  assert.deepEqual(checkInputs('heygen-twin', {}), { ok: false, missing: ['inputs'], verified: false })
})

test('slow capabilities go async; fast and unmeasured ones inline', () => {
  assert.equal(dispatchMode({ sla: { p95_ms: 180_000 } }), 'inline')
  assert.equal(dispatchMode({ sla: { p95_ms: 400_000 } }), 'async')
  assert.equal(dispatchMode({ sla: null }), 'inline')
})

test('estimates need a size for metered units, and are null otherwise', () => {
  const row = { display_price_usd: 0.13997, unit_kind: 'second' }
  assert.equal(estimateFromPricing(row, {}), null)
  assert.ok(Math.abs(estimateFromPricing(row, { seconds: 6 }) - 0.83982) < 1e-9)
  assert.equal(estimateFromPricing({ display_price_usd: 0.009, unit_kind: 'call' }), 0.009)
  assert.equal(estimateFromPricing({ display_price_usd: 1, unit_kind: 'megapixel' }, { seconds: 1 }), null)
})

test('render keys are stable for the same request and change with anything that matters', () => {
  const r = { grantId: 'urn:g', capability: 'sync-lipsync-v3', inputs: { image_url: IMG, audio_url: AUD }, seconds: 6 }
  assert.equal(renderKey(r), renderKey({ ...r, inputs: { audio_url: AUD, image_url: IMG } }))
  assert.notEqual(renderKey(r), renderKey({ ...r, seconds: 7 }))
  assert.notEqual(renderKey(r), renderKey({ ...r, grantId: 'urn:h' }))
  assert.match(renderKey(r), /^mandate-[0-9a-f]{32}$/)
})

test('pending renders are private files that survive a crash', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'mandate-pending-')), 'pending')
  try {
    const store = pendingStore(dir)
    const key = renderKey({ grantId: 'urn:g', capability: 'x' })
    store.save({ key, status: 'dispatching' })
    store.save({ ...store.load(key), status: 'rendered', mediaUrl: OUT })
    assert.equal(store.load(key).status, 'rendered')
    assert.equal(store.list().length, 1)
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.equal(statSync(join(dir, `${key}.json`)).mode & 0o777, 0o600)
    assert.throws(() => store.load('../../etc/passwd'), /invalid pending render key/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hashing streams, caps size, refuses non-http URLs and does not retry HTTP errors', async () => {
  const body = Buffer.alloc(300_000, 7)
  let hits = 0
  const server = createServer((req, res) => {
    hits++
    if (req.url === '/missing') { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'content-type': 'video/mp4' })
    res.end(body)
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const r = await sha256OfUrl(`${base}/a.mp4`)
    assert.equal(r.sha256, createHash('sha256').update(body).digest('hex'))
    assert.equal(r.bytes, body.length)
    await assert.rejects(sha256OfUrl(`${base}/a.mp4`, { maxBytes: 1000 }), FetchBytesError)
    const before = hits
    await assert.rejects(sha256OfUrl(`${base}/missing`, { sleep: async () => {} }), /HTTP 404/)
    assert.equal(hits, before + 1)
    await assert.rejects(sha256OfUrl('file:///etc/passwd'), /only http\(s\)/)
  } finally {
    await new Promise(r => server.close(r))
  }
})
