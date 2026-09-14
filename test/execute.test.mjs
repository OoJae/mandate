import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dispatchRender, extractMediaUrl, pollJob, RenderError, collectInputUrls, served, classifyFailure } from '../src/execute.mjs'
import { callStrict, LivepeerToolError } from '../src/livepeer.mjs'
import { checkInputs, dispatchMode, estimateFromPricing } from '../src/capabilities.mjs'
import { sha256OfUrl, FetchBytesError } from '../src/fetch-bytes.mjs'
import { renderKey, pendingStore, PendingConflictError, PendingInvariantError, PendingReadError, mergeDerivationAttempt, mayBeBilled } from '../src/pending.mjs'
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
  // A structured URL that is present but unusable is not replaced by a guess from the text.
  assert.equal(extractMediaUrl({ url: 'javascript:alert(1)' }, 'https://h.test/a.webp?x=1'), null)
  assert.equal(extractMediaUrl({ url: '' }, 'https://h.test/a.webp?x=1'), 'https://h.test/a.webp?x=1')
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
/**
 * Settles `promise` or fails after `ms`. A guard whose removal only makes a test
 * hang proves nothing (the mutation check counts a timeout as a failure, not a
 * kill), so a test that could hang when its guard is gone gets its own deadline.
 * The timer only fires while the code under test yields to real timers.
 */
function within(promise, ms, what) {
  let timer
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}: still pending after ${ms}ms`)), ms) })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer))
}
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
  // A no-op sleep and no wait: if the first reply's status were not refused, this fails at once instead of polling for minutes.
  await assert.rejects(dispatchRender(first, { ...TH, poll: { sleep: async () => {}, maxWaitMs: 0 } }), e => e.kind === 'unknown-status')
  assert.equal(first.calls.length, 1)
  const none = stubClient({ get_create_media: [ok({}, 'nothing useful')] })
  // A fake clock with no wait: were the empty status polled instead of refused, this
  // ends at once as kind timeout rather than spinning a no-op sleep forever.
  let u = 0
  await assert.rejects(pollJob(none, 'mjob_aaaaaaaaaaaa', { sleep: async ms => { u += ms }, now: () => u, maxWaitMs: 0 }), e => e.kind === 'unknown-status')
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

// --- round two: render lifecycle ------------------------------------------------------

test('a reply with a job id and no done status is polled, even when it carries a structured url', async () => {
  for (const url of [`${IMG}?w=512`, 'about:blank', 'https://agent.livepeer.org/jobs/mjob_abcdef123456', 'https://cdn.test/preview.png']) {
    const client = stubClient({
      run_capability: [ok({ job_id: 'mjob_abcdef123456', url }, 'Job mjob_abcdef123456 is NOT done. Preview https://cdn.test/preview.png')],
      get_create_media: [ok({ status: 'done', url: 'https://cdn.test/out.mp4' })],
    })
    const r = await dispatchRender(client, { ...TH, poll: noSleep })
    assert.equal(r.url, 'https://cdn.test/out.mp4', url)
    assert.equal(r.mode, 'async', url)
    assert.equal(client.calls.filter(c => c.name === 'get_create_media').length, 1, url)
  }
  // Done, with a job id and a usable structured url: that is the result, no poll.
  const inline = stubClient({ run_capability: [ok({ status: 'done', job_id: 'mjob_abcdef123456', url: OUT })] })
  assert.equal((await dispatchRender(inline, TH)).mode, 'inline')
  // Done, with a job id, but the structured url is an echoed input: polled, not scanned.
  const echoed = stubClient({
    run_capability: [ok({ status: 'done', job_id: 'mjob_abcdef123456', url: IMG }, 'thumb https://cdn.test/thumb.jpg')],
    get_create_media: [ok({ status: 'done', url: 'https://cdn.test/out.mp4' })],
  })
  assert.equal((await dispatchRender(echoed, { ...TH, poll: noSleep })).url, 'https://cdn.test/out.mp4')
})

test('a queued reply whose job id is not in the accepted shape stops instead of scanning the text', async () => {
  const long = stubClient({ run_capability: [text('Job mjob_0123456789abcdef0123456789abcdef01 is NOT done — poll get_create_media. Source: https://cdn.test/src.png')] })
  await assert.rejects(dispatchRender(long, TH), e => e instanceof RenderError && e.kind === 'tool' && e.mayHaveStarted === true && e.jobId === null)
  assert.equal(long.calls.length, 1)
})

test('an echoed input is recognised across scheme, percent-encoding, repeated slashes, host case and default port', () => {
  const img = 'https://agent.livepeer.org/a/xx.a9/pHj.jpg'
  for (const echo of [img.replace('https:', 'http:'), 'https://agent.livepeer.org/a/xx.a9/%70Hj.jpg', 'https://agent.livepeer.org/a//xx.a9/pHj.jpg', 'https://AGENT.livepeer.org:443/a/xx.a9/pHj.jpg#x']) {
    assert.equal(extractMediaUrl(null, `output ${echo}`, [{ cfg: { image: { url: img } } }]), null, echo)
    assert.equal(extractMediaUrl({ url: echo }, 'https://cdn.test/thumb.jpg', [img]), null, echo)
  }
  assert.equal(extractMediaUrl(null, 'output https://agent.livepeer.org/a/xx.a9/pHj2.jpg', [img]), 'https://agent.livepeer.org/a/xx.a9/pHj2.jpg')
})

test('a finished job whose structured url is an input is no-media, even with another media link in its text', async () => {
  const client = stubClient({ get_create_media: [ok({ status: 'done', url: IMG }, 'Media job mjob_abcdef123456: done\nsee https://cdn.test/thumb.jpg')] })
  await assert.rejects(pollJob(client, 'mjob_abcdef123456', { ...noSleep, inputUrls: [IMG] }), e => e.kind === 'no-media')
})

test('pollJob never takes a reply marked isError as a result', async () => {
  const structured = stubClient({ get_create_media: [{ isError: true, structuredContent: { status: 'done', url: 'https://cdn.test/o.mp4' }, content: [] }] })
  await assert.rejects(pollJob(structured, 'mjob_abcdef123456', noSleep), e => e instanceof RenderError && e.kind === 'tool' && e.jobId === 'mjob_abcdef123456' && e.mayHaveStarted)
  const header = stubClient({ get_create_media: [{ isError: true, content: [{ type: 'text', text: 'Media job mjob_abcdef123456: done\nhttps://cdn.test/o.mp4' }] }] })
  await assert.rejects(pollJob(header, 'mjob_abcdef123456', noSleep), e => e.kind === 'tool')
  const bare = stubClient({ get_create_media: [err(null, 'worker lost')] })
  await assert.rejects(pollJob(bare, 'mjob_abcdef123456', noSleep), e => e.kind === 'tool' && /worker lost/.test(e.message))
  const running = stubClient({ get_create_media: [err({ status: 'running' }, 'upstream hiccup'), ok({ status: 'done', url: OUT })] })
  await assert.rejects(pollJob(running, 'mjob_abcdef123456', noSleep), e => e.kind === 'tool')
})

test('pollJob refuses a reply about another job, and reads multi-word text statuses', async () => {
  const other = stubClient({ get_create_media: [text('Media job mjob_zzzzzz999999: done\nOutput: https://cdn.test/other.mp4')] })
  await assert.rejects(pollJob(other, 'mjob_abcdef123456', noSleep), e => e.kind === 'tool' && /another job/.test(e.message))
  const structured = stubClient({ get_create_media: [ok({ status: 'done', job_id: 'mjob_zzzzzz999999', url: 'https://cdn.test/other.mp4' })] })
  await assert.rejects(pollJob(structured, 'mjob_abcdef123456', noSleep), e => /another job/.test(e.message))
  const same = stubClient({ get_create_media: [ok({ status: 'done', job_id: 'MJOB_ABCDEF123456', url: OUT })] })
  assert.equal((await pollJob(same, 'mjob_abcdef123456', noSleep)).url, OUT)
  const words = stubClient({ get_create_media: [text('Media job mjob_abcdef123456: in progress (20s)'), text('Media job mjob_abcdef123456: In-Progress'), text('Media job mjob_abcdef123456: done\nOutput: https://cdn.test/out.mp4')] })
  assert.equal((await pollJob(words, 'mjob_abcdef123456', noSleep)).url, 'https://cdn.test/out.mp4')
  assert.equal(words.calls.length, 3)
  // "until status=done" in a queued reply is not the header, so it is not a finished job.
  const queuedText = stubClient({ get_create_media: [text(`${LOGGED_QUEUED}\nOutput: https://cdn.test/out.mp4`)] })
  // No wait on a fake clock, so polling the queued text instead of refusing it ends as a timeout, not a hang.
  let t = 0
  await assert.rejects(pollJob(queuedText, 'mjob_93244be79885', { sleep: async ms => { t += ms }, now: () => t, maxWaitMs: 0 }), e => e.kind === 'unknown-status')
})

test('the served capability and cost are always writable: anything else is null with a warning', async () => {
  for (const bad of ['', 5, 'Talking Head', 'x'.repeat(80)]) {
    const client = stubClient({ run_capability: [ok({ ok: true, url: OUT, capability_used: bad })] })
    const r = await dispatchRender(client, TH)
    assert.equal(r.servedCapability, null, String(bad))
    assert.ok(r.warnings.some(w => /not a capability name/.test(w)), String(bad))
    assert.equal(served({ capability_used: bad }, 'talking-head'), null)
  }
  const good = await dispatchRender(stubClient({ run_capability: [ok({ ok: true, url: OUT, capability_used: 'lipsync' })] }), TH)
  assert.equal(good.servedCapability, 'lipsync')
  assert.deepEqual(good.warnings, [])
  for (const huge of [1e21, 1e300]) {
    const r = await dispatchRender(stubClient({ run_capability: [ok({ ok: true, url: OUT, cost_usd_estimated: huge })] }), TH)
    assert.equal(r.costUsdEstimated, null, String(huge))
    assert.ok(r.warnings.some(w => /cannot be recorded/.test(w)))
  }
  const polled = await pollJob(stubClient({ get_create_media: [ok({ status: 'done', url: OUT, capability_used: '', cost_usd_estimated: 1e21 })] }), 'mjob_abcdef123456', { ...noSleep, capability: 'talking-head' })
  assert.equal(polled.servedCapability, null)
  assert.equal(polled.costUsdEstimated, null)
  assert.equal(polled.warnings.length, 2)
  const byText = await pollJob(stubClient({ get_create_media: [text('Media job mjob_abcdef123456: done\nOutput: https://cdn.test/out.mp4')] }), 'mjob_abcdef123456', { ...noSleep, capability: 'talking-head' })
  assert.equal(byText.servedCapability, 'talking-head')
})

test('payment classification ignores URLs, input-fetch credential errors and token allowances', () => {
  assert.equal(classifyFailure(null, 'HTTP 401 Unauthorized fetching image_url'), 'tool')
  assert.equal(classifyFailure(null, 'HTTP 401 Unauthorized fetching audio_url'), 'tool')
  assert.equal(classifyFailure({ status_code: 401 }, 'fetching image_url failed'), 'tool')
  assert.equal(classifyFailure({ status_code: 401 }, 'bad bearer token'), 'payment')
  assert.equal(classifyFailure({ status_code: 403 }, 'unauthorized'), 'tool')
  assert.equal(classifyFailure({ http_status: 500 }, 'insufficient credits'), 'tool')
  assert.equal(classifyFailure(null, 'fetch failed for https://x.example/payment/receipt.jpg'), 'tool')
  assert.equal(classifyFailure(null, 'prompt exceeds the token allowance'), 'tool')
  assert.equal(classifyFailure(null, 'monthly credit allowance used up'), 'payment')
  assert.equal(classifyFailure(null, 'Unauthorized: bad bearer token'), 'payment')
  assert.equal(classifyFailure({ code: 'upstream_error' }, 'insufficient credits'), 'payment')
  assert.equal(classifyFailure({ code: -32602 }, 'insufficient funds'), 'payment')
  assert.equal(classifyFailure({ code: 'unauthorized' }, 'while fetching source_url'), 'tool')
  assert.equal(classifyFailure({ code: 'unauthorized' }, 'bad key'), 'payment')
})

test('a platform error that says the render timed out or continues is kept recoverable; other errors are not', async () => {
  for (const said of ['Render exceeded the 280s inline budget and timed out. It may still complete; check get_create_media.', 'run_capability stopped waiting; the render continues in the background']) {
    const client = stubClient({ run_capability: [err(null, said)] })
    await assert.rejects(dispatchRender(client, TH), e => e.kind === 'timeout' && e.jobId === null && e.mayHaveStarted === true, said)
  }
  const plain = stubClient({ run_capability: [err({ error: 'provider stream ended' }, 'no media produced')] })
  await assert.rejects(dispatchRender(plain, TH), e => e.kind === 'tool' && e.mayHaveStarted === false)
  const body = Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('Body Timeout Error'), { code: 'UND_ERR_BODY_TIMEOUT', name: 'BodyTimeoutError' }) })
  await assert.rejects(dispatchRender(stubClient({ run_capability: [body] }), TH), e => e.kind === 'timeout' && e.mayHaveStarted === true)
})

test('a malformed job id on an error reply does not hide a payment refusal, and keeps it recoverable', async () => {
  const okFalse = stubClient({ run_capability: [ok({ ok: false, error: 'insufficient credits', job_id: 'bad id' })] })
  await assert.rejects(dispatchRender(okFalse, TH), e => e.kind === 'payment' && e.jobId === null && e.mayHaveStarted === true)
  const isError = stubClient({ run_capability: [err({ error: 'insufficient credits', job_id: 'nope!' }, 'x')] })
  await assert.rejects(dispatchRender(isError, TH), e => e.kind === 'payment' && e.jobId === null && e.mayHaveStarted === true)
})

test('invalid poll options fail before anything is dispatched', async () => {
  // The job answers 'failed' at once, so options that slipped through would end in a
  // RenderError after a dispatch (failing the assertions) instead of polling forever.
  const failing = () => stubClient({
    run_capability: [ok({ status: 'submitted', job_id: 'mjob_abcdef123456' })],
    get_create_media: [ok({ status: 'failed', error: 'no' })],
  })
  for (const poll of [{ maxWaitMs: Number.NaN }, { pollIntervalMs: -1 }, { maxWaitMs: 3e9 }, { sleep: 'soon' }]) {
    const client = failing()
    let job = null
    await within(assert.rejects(dispatchRender(client, { ...TH, onJob: j => { job = j }, poll }), e => e instanceof RangeError || e instanceof TypeError, JSON.stringify(poll)), 2000, JSON.stringify(poll))
    assert.equal(client.calls.length, 0)
    assert.equal(job, null)
  }
  await within(assert.rejects(pollJob(failing(), 'mjob_abcdef123456', { maxWaitMs: Number.NaN }), RangeError), 2000, 'pollJob NaN')
})

test('the poll wait ends at maxWaitMs, not later', async () => {
  let t = 0
  const client = stubClient({ get_create_media: [ok({ status: 'running' })] })
  await assert.rejects(pollJob(client, 'mjob_aaaaaaaaaaaa', { sleep: async ms => { t += ms }, now: () => t, pollIntervalMs: 10_000, maxWaitMs: 30_000 }), e => e.kind === 'timeout')
  assert.equal(client.calls.length, 4)
})

// --- round two: fetch-bytes ------------------------------------------------------------

const iterBody = (items, { hang = false } = {}) => ({
  async *[Symbol.asyncIterator]() {
    for (const i of items) yield i
    if (hang) await new Promise(() => {})
  },
  cancel: async () => {},
})

test('string chunks from a custom fetch are counted by their byte length', async () => {
  const fetch = async () => fakeRes(iterBody(['a'.repeat(1000)]))
  await assert.rejects(sha256OfUrl('https://h.test/a.mp4', { maxBytes: 10, fetch }), /limit/)
  const small = await sha256OfUrl('https://h.test/a.mp4', { fetch: async () => fakeRes(iterBody(['héllo'])) })
  assert.equal(small.sha256, createHash('sha256').update(Buffer.from('héllo', 'utf8')).digest('hex'))
  assert.equal(small.bytes, 6)
  await assert.rejects(sha256OfUrl('https://h.test/a.mp4', { fetch: async () => fakeRes(iterBody([{ length: 3 }])) }), /body chunk/)
})

test('the deadline holds even when a custom fetch ignores the abort signal', async () => {
  const t0 = Date.now()
  // Each wait has its own deadline, so a missing guard fails here instead of hanging.
  await within(assert.rejects(sha256OfUrl('https://h.test/a.mp4', { timeoutMs: 150, attempts: 1, fetch: async () => fakeRes(iterBody([new Uint8Array(4)], { hang: true })) }), /timed out/), 800, 'hanging body read')
  await within(assert.rejects(sha256OfUrl('https://h.test/a.mp4', { timeoutMs: 150, attempts: 1, fetch: () => new Promise(() => {}) }), /timed out/), 800, 'hanging fetch')
  assert.ok(Date.now() - t0 < 900, `took ${Date.now() - t0}ms`)
  await assert.rejects(sha256OfUrl('https://h.test/a.mp4', { timeoutMs: 3e9 }), e => e instanceof FetchBytesError && /timeoutMs/.test(e.message))
  await assert.rejects(sha256OfUrl('https://h.test/a.mp4', { attempts: Number.NaN }), e => e instanceof FetchBytesError && /attempts must be/.test(e.message))
})

test('one deadline: a connection that drops late is retried only for what is left of it', async () => {
  let n = 0
  const fetch = (_u, { signal }) => {
    n++
    if (n === 1) {
      return Promise.resolve(fakeRes(new ReadableStream({ pull: c => new Promise(r => setTimeout(r, 180)).then(() => c.error(new TypeError('terminated'))) })))
    }
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
  }
  const t0 = Date.now()
  await assert.rejects(sha256OfUrl('https://h.test/a.mp4', { timeoutMs: 200, attempts: 4, backoffMs: 0, fetch }), /timed out fetching media after \d+ attempts? within 200ms/)
  assert.ok(Date.now() - t0 < 380, `took ${Date.now() - t0}ms`)
})

test('a retry whose declared size is more than the budget left is refused before reading', async () => {
  let n = 0
  let read = false
  const fetch = async () => {
    n++
    if (n === 1) return fakeRes(stream([new Uint8Array(600)], { failAfter: true }))
    return fakeRes(new ReadableStream({ pull(c) { read = true; c.enqueue(new Uint8Array(600)); c.close() } }, { highWaterMark: 0 }), { 'content-length': '600' })
  }
  await assert.rejects(sha256OfUrl('https://h.test/a.mp4', { maxBytes: 1000, attempts: 2, fetch, sleep: async () => {} }), /more than is left/)
  assert.equal(read, false)
})

// --- round two: pending records ----------------------------------------------------------

const tmpStore = (opts) => {
  const dir = join(mkdtempSync(join(tmpdir(), 'mandate-pending-')), 'pending')
  return { dir, store: pendingStore(dir, opts), done: () => rmSync(dirname(dir), { recursive: true, force: true }) }
}
const dirname = p => p.slice(0, p.lastIndexOf('/'))
const ID = 'urn:mandate:derivation:0123456789abcdef:fedcba9876543210'

test('a derivation attempt refuses a changed id and invalid id, stage or mayHaveSent', () => {
  assert.throws(() => mergeDerivationAttempt({ id: ID }, { id: 'urn:mandate:derivation:0123456789abcdef:0000000000000000' }), /must reuse/)
  assert.throws(() => mergeDerivationAttempt(null, { id: 'urn:other:1' }), /invalid derivation id/)
  assert.throws(() => mergeDerivationAttempt(null, { stage: 'Publish Now' }), /invalid derivation stage/)
  assert.throws(() => mergeDerivationAttempt(null, { mayHaveSent: 'yes' }), /mayHaveSent/)
})

test('D3: a possibly-billed render keeps its key, its attempts and its place in pending spend', () => {
  const { store, done } = tmpStore({ isAlive: () => false })
  try {
    const key = renderKey({ grantId: 'urn:g', capability: 'd3' })
    const first = store.beginAttempt({ key, idempotencyKey: key, capability: 'talking-head' })
    assert.equal(first.resumed, false)
    assert.equal(first.record.attempts.length, 1)
    store.markSent(key)
    // An inline timeout: no job id, may have started.
    store.finishAttempt(key, { status: 'submitted', jobId: null, mayHaveStarted: true, errorKind: 'timeout' })
    assert.equal(mayBeBilled(store.load(key)), true)
    // A rerun under another key would bill again.
    assert.throws(() => store.beginAttempt({ key, idempotencyKey: `mandate-${'f'.repeat(32)}`, capability: 'talking-head' }), PendingInvariantError)
    assert.throws(() => store.save({ ...store.load(key), idempotencyKey: `mandate-${'f'.repeat(32)}` }), PendingInvariantError)
    const again = store.beginAttempt({ key, idempotencyKey: key, capability: 'talking-head' })
    assert.equal(again.resumed, true)
    assert.equal(again.record.idempotencyKey, key)
    assert.equal(again.record.attempts.length, 2)
    store.markSent(key)
    // The retry fails cleanly (payment refused). The first attempt may still be billed.
    const after = store.finishAttempt(key, { status: 'failed', mayHaveStarted: false, errorKind: 'payment' })
    assert.equal(after.status, 'submitted')
    assert.equal(after.mayHaveStarted, true)
    assert.equal(after.attempts[1].status, 'failed')
    assert.equal(after.attempts[0].status, 'submitted')
    assert.equal(mayBeBilled(store.load(key)), true)
    // A plain save cannot downgrade it or drop its history either.
    assert.equal(store.save({ ...store.load(key), status: 'failed', mayHaveStarted: false }).status, 'submitted')
    assert.equal(store.load(key).mayHaveStarted, true)
    assert.throws(() => store.save({ ...store.load(key), attempts: [] }), PendingInvariantError)
    // mandate record may resolve it explicitly.
    assert.equal(store.save({ ...store.load(key), status: 'rendered', mediaUrl: OUT }).status, 'rendered')
  } finally {
    done()
  }
})

test('a clean failure is not billed, so a rerun may start afresh with a new key', () => {
  const { store, done } = tmpStore({ isAlive: () => false })
  try {
    const key = renderKey({ grantId: 'urn:g', capability: 'clean' })
    store.beginAttempt({ key, idempotencyKey: key })
    store.markSent(key)
    assert.equal(store.finishAttempt(key, { status: 'failed', mayHaveStarted: false, errorKind: 'payment' }).status, 'failed')
    assert.equal(mayBeBilled(store.load(key)), false)
    const next = store.beginAttempt({ key, idempotencyKey: `mandate-${'e'.repeat(32)}` })
    assert.equal(next.resumed, false)
    assert.equal(next.record.idempotencyKey, `mandate-${'e'.repeat(32)}`)
    assert.equal(next.record.attempts.length, 2)
    // A record created but never sent (crash before dispatch) is not billed.
    const k2 = renderKey({ grantId: 'urn:g', capability: 'unsent' })
    store.create({ key: k2, idempotencyKey: k2, status: 'dispatching' })
    assert.equal(mayBeBilled(store.load(k2)), false)
    assert.equal(store.save({ ...store.load(k2), status: 'failed' }).status, 'failed')
  } finally {
    done()
  }
})

test('a dispatching record is protected: a crashed one is resumed, a live one is refused, a legacy one is not overwritten', () => {
  let alive = true
  const { store, done } = tmpStore({ isAlive: () => alive })
  try {
    const key = renderKey({ grantId: 'urn:g', capability: 'crash' })
    store.save({ key, idempotencyKey: key, status: 'dispatching', attempts: [{ n: 1, pid: 999_999_001, startedAt: '2026-09-14T00:00:00Z', idempotencyKey: key, sentAt: '2026-09-14T00:00:01Z' }] })
    assert.throws(() => store.beginAttempt({ key, idempotencyKey: key }), e => e instanceof PendingConflictError && e.inFlight === true)
    assert.throws(() => store.create({ key, idempotencyKey: key, status: 'dispatching' }), PendingConflictError)
    alive = false
    const r = store.beginAttempt({ key, idempotencyKey: key })
    assert.equal(r.resumed, true)
    assert.equal(r.record.attempts.length, 2)
    const legacy = renderKey({ grantId: 'urn:g', capability: 'legacy' })
    store.save({ key: legacy, idempotencyKey: legacy, status: 'dispatching' })
    assert.throws(() => store.create({ key: legacy, idempotencyKey: legacy, status: 'dispatching' }), PendingConflictError)
    const resumed = store.beginAttempt({ key: legacy, idempotencyKey: legacy })
    assert.equal(resumed.resumed, true)
    assert.equal(resumed.record.attempts[0].legacy, true)
    const withJob = renderKey({ grantId: 'urn:g', capability: 'job' })
    store.save({ key: withJob, idempotencyKey: withJob, status: 'submitted', jobId: 'mjob_aaaaaaaaaaaa' })
    assert.throws(() => store.beginAttempt({ key: withJob, idempotencyKey: withJob }), e => e instanceof PendingConflictError && !e.inFlight)
  } finally {
    done()
  }
})

test('a held lock is waited on and then refused; a stale one is cleared', () => {
  let alive = true
  const { dir, store, done } = tmpStore({ isAlive: () => alive })
  try {
    const key = renderKey({ grantId: 'urn:g', capability: 'lock' })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${key}.json.lock`), JSON.stringify({ pid: 999_999_002 }))
    assert.throws(() => store.beginAttempt({ key, idempotencyKey: key }), e => e instanceof PendingConflictError && e.inFlight)
    assert.equal(store.load(key), null)
    alive = false
    assert.equal(store.beginAttempt({ key, idempotencyKey: key }).resumed, false)
  } finally {
    done()
  }
})

test('two processes starting the same render at once: exactly one dispatches', async () => {
  const { dir, done } = tmpStore()
  try {
    const key = renderKey({ grantId: 'urn:g', capability: 'race' })
    const src = new URL('../src/pending.mjs', import.meta.url).href
    const script = `
      const { pendingStore } = await import(${JSON.stringify(src)})
      const store = pendingStore(${JSON.stringify(dir)})
      await new Promise(r => setTimeout(r, Math.max(0, ${Date.now() + 400} - Date.now())))
      try {
        const r = store.beginAttempt({ key: ${JSON.stringify(key)}, idempotencyKey: ${JSON.stringify(key)} })
        console.log(r.resumed ? 'resumed' : 'created')
        await new Promise(r => setTimeout(r, 800))
      } catch (e) { console.log(e.name) }
    `
    const run = () => new Promise(resolve => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script])
      let out = ''
      child.stdout.on('data', d => { out += d })
      child.on('close', () => resolve(out.trim()))
    })
    const results = await Promise.all([run(), run(), run(), run()])
    assert.equal(results.filter(r => r === 'created').length, 1, results.join(','))
    assert.equal(results.filter(r => r === 'resumed').length, 0, results.join(','))
    assert.equal(results.filter(r => r === 'PendingConflictError').length, 3, results.join(','))
  } finally {
    done()
  }
})

test('an unreadable pending record is a PendingReadError naming the file', () => {
  const { dir, store, done } = tmpStore()
  try {
    const key = renderKey({ grantId: 'urn:g', capability: 'corrupt' })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${key}.json`), '{ not json')
    assert.throws(() => store.load(key), e => e instanceof PendingReadError && e.file.endsWith(`${key}.json`))
    assert.throws(() => store.list(), PendingReadError)
  } finally {
    done()
  }
})
