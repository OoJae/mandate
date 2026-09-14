import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dispatchRender, extractMediaUrl, pollJob, RenderError, collectInputUrls, served, classifyFailure } from '../src/execute.mjs'
import { callStrict, LivepeerToolError } from '../src/livepeer.mjs'
import { checkInputs, dispatchMode, estimateFromPricing } from '../src/capabilities.mjs'
import { sha256OfUrl, FetchBytesError } from '../src/fetch-bytes.mjs'
import { renderKey, pendingStore, PendingConflictError, mergeDerivationAttempt } from '../src/pending.mjs'
import { verifyMedia, hashUrl } from '../src/verify.mjs'

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

// --- closure fixes: render lifecycle -------------------------------------------------

const text = t => ({ content: [{ type: 'text', text: t }] })
// The replies the platform actually sent during the spikes: text only, no structured content.
const LOGGED_QUEUED = 'Job mjob_93244be79885 is NOT done — poll get_create_media({ job_id: "mjob_93244be79885" }) until status=done to get the media URL.'
const LOGGED_FAILED = 'Media job mjob_640913486506: failed (129s)\nCapability: talking-head\nError: The background worker running this job stopped responding (no heartbeat for 128s after it started). No media was produced.'
const TH = { capability: 'talking-head', inputs: { image_url: IMG, audio_url: AUD }, idempotencyKey: 'mandate-k' }
const noSleep = { sleep: async () => {} }
const ESC = String.fromCharCode(27)

test('an inline call that times out on the client with no job id may still be rendering', async () => {
  const client = stubClient({ run_capability: [Object.assign(new Error('Request timed out'), { code: -32001 })] })
  await assert.rejects(dispatchRender(client, TH), e => e instanceof RenderError && e.kind === 'timeout' && e.jobId === null && e.mayHaveStarted === true)
  const dropped = stubClient({ run_capability: [new Error('socket hang up')] })
  await assert.rejects(dispatchRender(dropped, TH), e => e.kind === 'tool' && e.mayHaveStarted === true)
})

test('a text-only queued inline reply is polled, and its text is never scanned for a URL', async () => {
  const client = stubClient({
    run_capability: [text(`${LOGGED_QUEUED}\nPreview of source: ${IMG}?w=512 and https://cdn.test/preview.png`)],
    get_create_media: [text('Media job mjob_93244be79885: Running (40s)'), text(`Media job mjob_93244be79885: done\nCapability: talking-head\nInput: ${IMG}?w=512\nOutput: https://cdn.test/out.mp4`)],
  })
  let job
  const r = await dispatchRender(client, { ...TH, onJob: j => { job = j }, poll: noSleep })
  assert.equal(job, 'mjob_93244be79885')
  assert.equal(r.url, 'https://cdn.test/out.mp4')
  assert.equal(r.mode, 'async')
  assert.equal(client.calls.filter(c => c.name === 'get_create_media').length, 2)
})

test('a text-only failed job fails at once instead of polling until the wait runs out', async () => {
  const client = stubClient({ get_create_media: [text(LOGGED_FAILED)] })
  await assert.rejects(pollJob(client, 'mjob_640913486506', noSleep), e => e.kind === 'tool' && /heartbeat/.test(e.message) && e.mayHaveStarted)
  assert.equal(client.calls.length, 1)
})

test('status words and job ids are compared case-insensitively', async () => {
  const client = stubClient({
    run_capability: [ok({ status: 'Queued', job_id: 'mjob_93244BE79885' }, 'queued https://cdn.test/prev.png')],
    get_create_media: [ok({ status: 'RUNNING' }), ok({ status: 'Completed', url: OUT })],
  })
  const r = await dispatchRender(client, { ...TH, poll: noSleep })
  assert.equal(r.url, OUT)
  assert.equal(r.jobId, 'mjob_93244BE79885')
  const upper = stubClient({ run_capability: [text('Job mjob_93244BE79885 is NOT done')], get_create_media: [ok({ status: 'done', url: OUT })] })
  assert.equal((await dispatchRender(upper, { ...TH, mode: 'async', poll: noSleep })).jobId, 'mjob_93244BE79885')
})

test('an unrecognised status stops the render instead of polling to a timeout', async () => {
  const client = stubClient({ get_create_media: [ok({ status: 'quarantined' })] })
  let t = 0
  await assert.rejects(pollJob(client, 'mjob_aaaaaaaaaaaa', { sleep: async () => { t += 10_000 }, now: () => t }),
    e => e.kind === 'unknown-status' && e.jobId === 'mjob_aaaaaaaaaaaa' && e.mayHaveStarted)
  assert.equal(client.calls.length, 1)
  const first = stubClient({ run_capability: [ok({ status: 'on_hold', job_id: 'mjob_aaaaaaaaaaaa' })] })
  await assert.rejects(dispatchRender(first, TH), e => e.kind === 'unknown-status')
  const none = stubClient({ get_create_media: [ok({}, 'nothing useful')] })
  await assert.rejects(pollJob(none, 'mjob_aaaaaaaaaaaa', noSleep), e => e.kind === 'unknown-status')
})

test('a dropped poll is retried, not treated as the end of a billed render', async () => {
  const client = stubClient({ get_create_media: [new Error('fetch failed'), ok({ status: 'done', url: OUT })] })
  assert.equal((await pollJob(client, 'mjob_aaaaaaaaaaaa', noSleep)).url, OUT)
  await assert.rejects(pollJob(stubClient({}), 'mjob_$(rm -rf)', noSleep), e => e.kind === 'tool' && e.jobId === null)
})

test('a malformed structured job id is refused rather than saved or printed', async () => {
  const client = stubClient({ run_capability: [ok({ status: 'submitted', job_id: `mjob_abc${ESC}[2Jdef` })] })
  await assert.rejects(dispatchRender(client, TH), e => e instanceof RenderError && /expected form/.test(e.message) && e.mayHaveStarted)
})

test('ok:false is classified for payment too', async () => {
  const client = stubClient({ run_capability: [ok({ ok: false, error: 'insufficient credit on this account' })] })
  await assert.rejects(dispatchRender(client, TH), e => e.kind === 'payment' && e.mayHaveStarted === false)
})

test('payment classification uses word boundaries and prefers structured codes', () => {
  assert.equal(classifyFailure(null, '403 fetching image_url'), 'tool')
  assert.equal(classifyFailure(null, 'input from an accredited source could not be decoded'), 'tool')
  assert.equal(classifyFailure(null, 'HTTP 401 fetching audio_url'), 'tool')
  assert.equal(classifyFailure(null, 'insufficient credits'), 'payment')
  assert.equal(classifyFailure({ code: 'payment_required' }, 'request rejected'), 'payment')
  assert.equal(classifyFailure({ error: { code: 'provider_error' } }, 'provider mentions payment in passing'), 'tool')
  assert.equal(classifyFailure({ status_code: 402 }, ''), 'payment')
})

test('async polling never returns one of the render\'s own inputs, however nested', async () => {
  const nested = { image_url: IMG, refs: [{ audio: AUD }] }
  assert.deepEqual(collectInputUrls({ a: nested, b: [IMG, { c: AUD }] }).sort(), [IMG, IMG, AUD, AUD].sort())
  const client = stubClient({
    run_capability: [ok({ status: 'submitted', job_id: 'mjob_abcdef123456' })],
    get_create_media: [ok({ status: 'done' }, `Job done. image_url=${IMG} audio=${AUD}`)],
  })
  await assert.rejects(dispatchRender(client, { capability: 'talking-head', inputs: nested, poll: noSleep }), e => e.kind === 'no-media')
  const direct = stubClient({ get_create_media: [ok({ status: 'done' }, `image ${IMG}`)] })
  await assert.rejects(pollJob(direct, 'mjob_abcdef123456', { ...noSleep, inputUrls: [{ deep: [IMG] }] }), e => e.kind === 'no-media')
  const reported = stubClient({ get_create_media: [ok({ status: 'done', inputs: { refs: [{ image_url: IMG }] } }, `made from ${IMG}`)] })
  await assert.rejects(pollJob(reported, 'mjob_abcdef123456', noSleep), e => e.kind === 'no-media')
  const inline = stubClient({ run_capability: [ok({ ok: true }, `refs ${AUD}`)] })
  await assert.rejects(dispatchRender(inline, { capability: 'x-cap', inputs: nested }), e => e.kind === 'no-media')
})

test('an unusable cost estimate is dropped rather than recorded', async () => {
  for (const bad of ['0.84', -1, Number.NaN, Infinity, { usd: 1 }]) {
    const client = stubClient({ run_capability: [ok({ ok: true, url: OUT, cost_usd_estimated: bad })] })
    assert.equal((await dispatchRender(client, TH)).costUsdEstimated, null, String(bad))
  }
  const queued = stubClient({ run_capability: [ok({ status: 'submitted', job_id: 'mjob_abcdef123456', cost_usd_estimated: 0.84 })], get_create_media: [ok({ status: 'done', url: OUT, cost_usd_estimated: 'lots' })] })
  assert.equal((await dispatchRender(queued, { ...TH, poll: noSleep })).costUsdEstimated, 0.84)
})

test('served() reports substitution, and a text-only job reports its capability', async () => {
  assert.equal(served({ capability_used: 'lipsync' }, 'talking-head'), 'lipsync')
  assert.equal(served(null, 'talking-head'), 'talking-head')
  const client = stubClient({
    run_capability: [text(LOGGED_QUEUED)],
    get_create_media: [text('Media job mjob_93244be79885: done\nCapability: face-swap-video\nOutput: https://cdn.test/out.mp4')],
  })
  assert.equal((await dispatchRender(client, { ...TH, poll: noSleep })).servedCapability, 'face-swap-video')
})

// --- closure fixes: fetch-bytes --------------------------------------------------------

const stream = (chunks, { failAfter = false } = {}) => {
  const queue = [...chunks]
  return new ReadableStream({
    pull(c) {
      if (queue.length) return c.enqueue(queue.shift())
      if (failAfter) c.error(new TypeError('terminated'))
      else c.close()
    },
  })
}
const fakeRes = (body, headers = {}, status = 200) => ({ ok: status < 400, status, headers: new Headers(headers), body })

test('an undefined, null or NaN maxBytes never switches the size cap off', async () => {
  const fetch = async () => fakeRes(stream([new Uint8Array(10)]), { 'content-length': String(600 * 1024 * 1024) })
  for (const maxBytes of [undefined, null]) {
    await assert.rejects(sha256OfUrl('https://h.test/a.mp4', { maxBytes, fetch }), /over the 536870912-byte limit/)
  }
  await assert.rejects(sha256OfUrl('https://h.test/a.mp4', { maxBytes: Number('nope'), fetch }), e => e instanceof FetchBytesError && /maxBytes/.test(e.message))
  await assert.rejects(sha256OfUrl('https://h.test/a.mp4', { timeoutMs: -5, fetch }), /timeoutMs/)
})

test('the byte cap is one budget across every retry', async () => {
  let sent = 0
  const fetch = async () => { sent += 600; return fakeRes(stream([new Uint8Array(600)], { failAfter: true })) }
  await assert.rejects(sha256OfUrl('https://h.test/a.mp4', { maxBytes: 1000, attempts: 4, fetch, sleep: async () => {} }), /budget/)
  assert.ok(sent <= 1200, `sent ${sent} bytes`)
})

test('the timeout is one deadline across every retry', async () => {
  const fetch = (_u, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
  const t0 = Date.now()
  await assert.rejects(sha256OfUrl('https://h.test/a.mp4', { timeoutMs: 150, attempts: 4, backoffMs: 0, fetch }), /timed out/)
  assert.ok(Date.now() - t0 < 450, `took ${Date.now() - t0}ms`)
})

test('a response with no body fails once instead of being retried', async () => {
  let hits = 0
  const fetch = async () => { hits++; return fakeRes(null, {}, 204) }
  await assert.rejects(sha256OfUrl('https://h.test/a.mp4', { fetch, sleep: async () => {} }), /no body/)
  assert.equal(hits, 1)
})

test('verifyMedia and hashUrl pass fetch options through', async () => {
  let calls = 0
  const fetch = async () => { calls++; return fakeRes(stream([new Uint8Array(10)]), { 'content-length': '5000' }) }
  await assert.rejects(verifyMedia({}, {}, 'https://h.test/a.mp4', { fetchOptions: { fetch, maxBytes: 100 } }), /over the 100-byte limit/)
  assert.equal(calls, 1)
  const small = async () => fakeRes(stream([new Uint8Array([1, 2, 3])]))
  assert.equal(await hashUrl('https://h.test/a.mp4', { fetch: small }), createHash('sha256').update(Buffer.from([1, 2, 3])).digest('hex'))
})

// --- closure fixes: pending records -----------------------------------------------------

test('a rerun cannot overwrite a submitted, rendered or recorded pending record', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'mandate-pending-')), 'pending')
  try {
    const store = pendingStore(dir)
    const key = renderKey({ grantId: 'urn:g', capability: 'x' })
    store.create({ key, status: 'dispatching' })
    store.create({ key, status: 'dispatching', again: true })
    store.save({ ...store.load(key), status: 'failed' })
    store.create({ key, status: 'dispatching' })
    for (const status of ['submitted', 'rendered', 'recorded']) {
      store.save({ key, status, jobId: 'mjob_aaaaaaaaaaaa' })
      assert.throws(() => store.create({ key, status: 'dispatching' }), e => e instanceof PendingConflictError && e.status === status && e.existing.jobId === 'mjob_aaaaaaaaaaaa')
      assert.equal(store.load(key).status, status)
    }
    store.create({ key, status: 'dispatching' }, { overwrite: true })
    assert.equal(store.load(key).status, 'dispatching')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a derivation attempt keeps its asset name, ual, tx hash and mayHaveSent across retries', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'mandate-pending-')), 'pending')
  try {
    const store = pendingStore(dir)
    const key = renderKey({ grantId: 'urn:g', capability: 'y' })
    const name = 'derivation-0123456789abcdef-fedcba9876543210'
    const id = 'urn:mandate:derivation:0123456789abcdef:fedcba9876543210'
    const tx = `0x${'ab'.repeat(32)}`
    store.save({ key, status: 'rendered' })
    store.noteDerivationAttempt(key, { id, name, stage: 'started' })
    store.noteDerivationAttempt(key, { stage: 'publish-transport', ual: 'did:dkg:base:84532/0xabc/7', txHash: tx, mayHaveSent: true })
    const after = store.noteDerivationAttempt(key, { stage: 'unbound', mayHaveSent: false })
    assert.deepEqual(after.derivationAttempt, { id, name, ual: 'did:dkg:base:84532/0xabc/7', txHash: tx, stage: 'unbound', mayHaveSent: true })
    assert.deepEqual(store.load(key).derivationAttempt, after.derivationAttempt)
    assert.throws(() => store.noteDerivationAttempt(key, { name: 'derivation-0123456789abcdef-0000000000000000' }), /must reuse/)
    assert.throws(() => mergeDerivationAttempt(null, { txHash: '0xnope' }), /tx hash/)
    assert.throws(() => mergeDerivationAttempt(null, { ual: `did:dkg:x${ESC}[2J` }), /ual/)
    assert.throws(() => mergeDerivationAttempt(null, { name: '../x' }), /asset name/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
