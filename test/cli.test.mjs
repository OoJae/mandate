import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, readdirSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { startFakeDkg } from './fixtures/fake-dkg-server.mjs'
import { loadEnvFile } from '../bin/config.mjs'
import { renderKey, pendingStore } from '../src/pending.mjs'
import { GRANTS_CG, DERIVS_CG, ANA, PRODUCER, STRANGER, derivation, derivationKa } from './fixtures/build.mjs'
import { redact, waitMs, clearFor, taintedFor } from '../demo/full.mjs'

const BIN = new URL('../bin/mandate.mjs', import.meta.url).pathname
const NODES = new URL('../scripts/nodes.mjs', import.meta.url).pathname
const ANA_CHECKSUM = '0xeD1eeB64CaC09874257F05Fd6B51A55695ad0B69'
const ESC = String.fromCharCode(27)

let work, grantor, producer, world, media, lpSeq = 0
const homes = {}

/*
 * A stand-in for Livepeer Agent. The CLI runs with a module hook that replaces
 * only connect() in src/livepeer.mjs, so the real execute, consent and CLI code
 * talks to a scripted client. Replies come from a JSON scenario per command,
 * keyed by tool (run_capability by capability); each call takes the next reply
 * and the last one repeats. Every call is appended to a log.
 */
const FAKE_CLIENT = `import { readFileSync, appendFileSync } from 'node:fs'
export async function fakeClient() {
  const scenario = process.env.MANDATE_TEST_LP ? JSON.parse(readFileSync(process.env.MANDATE_TEST_LP, 'utf8')) : {}
  if (scenario.connectError) throw new Error(scenario.connectError)
  const counts = {}
  return {
    async callTool({ name, arguments: args }) {
      const key = name === 'run_capability' ? 'run_capability:' + args.capability : name
      if (process.env.MANDATE_TEST_LP_LOG) appendFileSync(process.env.MANDATE_TEST_LP_LOG, JSON.stringify({ name: key, args }) + '\\n')
      const list = scenario[key]
      if (!list) throw new Error('fake livepeer has no reply for ' + key)
      const replies = Array.isArray(list) ? list : [list]
      counts[key] = (counts[key] ?? -1) + 1
      const r = replies[Math.min(counts[key], replies.length - 1)]
      if (r.throw) throw new Error(r.throw)
      return { structuredContent: r.structured, content: r.text ? [{ type: 'text', text: r.text }] : [], isError: r.isError === true }
    },
    async close() {},
  }
}
`
const PRELOAD = client => `import { registerHooks } from 'node:module'
registerHooks({
  load(url, context, nextLoad) {
    const r = nextLoad(url, context)
    if (!url.endsWith('/src/livepeer.mjs')) return r
    const source = String(r.source).replace('export async function connect(', 'async function realConnect(')
      + '\\nexport async function connect(surface) { return (await import(${JSON.stringify(client)})).fakeClient(surface) }\\n'
    return { ...r, source }
  },
})
if (process.env.MANDATE_TEST_TTY === '1') process.stdin.isTTY = true
`

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'mandate-cli-'))
  world = { [GRANTS_CG]: { kas: [] }, [DERIVS_CG]: { kas: [] } }
  grantor = await startFakeDkg({ address: ANA_CHECKSUM, name: 'grantor', world })
  producer = await startFakeDkg({ address: PRODUCER, name: 'producer', world })
  for (const role of ['grantor', 'producer']) {
    const dir = mkdtempSync(join(work, `home-${role}-`))
    writeFileSync(join(dir, 'auth.token'), '# token\ntest-token\n')
    homes[role] = dir
  }
  writeFileSync(join(work, 'fake-livepeer.mjs'), FAKE_CLIENT)
  writeFileSync(join(work, 'preload.mjs'), PRELOAD(pathToFileURL(join(work, 'fake-livepeer.mjs')).href))
  // Media the fake platform hands back: each path has its own bytes.
  media = createServer((req, res) => {
    if (req.url.startsWith('/missing')) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'content-type': req.url.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream' })
    res.end(`bytes of ${req.url}`)
  })
  await new Promise(r => media.listen(0, '127.0.0.1', r))
})
after(async () => {
  await grantor.close()
  await producer.close()
  media.closeAllConnections?.()
  await new Promise(r => media.close(r))
  rmSync(work, { recursive: true, force: true })
})

const mediaUrl = path => `http://127.0.0.1:${media.address().port}/${path}`

/**
 * Run the CLI. `lp` is a fake Livepeer scenario (the module hook is loaded only
 * then); `tty` makes stdin look like a terminal and `input` is what is typed.
 */
function mandate(args, { env = {}, lp = null, tty = false, input = '', bin = BIN } = {}) {
  const extra = {}
  const nodeArgs = []
  let log = null
  if (lp) {
    const n = ++lpSeq
    writeFileSync(join(work, `lp-${n}.json`), JSON.stringify(lp))
    log = join(work, `lp-${n}.log`)
    Object.assign(extra, { MANDATE_TEST_LP: join(work, `lp-${n}.json`), MANDATE_TEST_LP_LOG: log })
    nodeArgs.push('--import', pathToFileURL(join(work, 'preload.mjs')).href)
  }
  if (tty) extra.MANDATE_TEST_TTY = '1'
  return new Promise(resolve => {
    const child = spawn(process.execPath, [...nodeArgs, bin, ...args], {
      cwd: work,
      env: {
        PATH: process.env.PATH, HOME: work, NO_COLOR: '1', MANDATE_LIVE_PRICES: '0',
        MANDATE_HOME: join(work, '.mandate'),
        MANDATE_GRANTOR_HOME: homes.grantor, MANDATE_GRANTOR_PORT: String(grantor.port),
        MANDATE_PRODUCER_HOME: homes.producer, MANDATE_PRODUCER_PORT: String(producer.port),
        MANDATE_GRANTS_CG: GRANTS_CG, MANDATE_DERIVATIONS_CG: DERIVS_CG,
        ...extra, ...env,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.stdin.end(input)
    child.on('close', code => {
      const calls = log && existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
      resolve({ code, stdout, stderr, calls })
    })
  })
}
const json = r => JSON.parse(r.stdout)
/** Build argv from defaults, with named flags replaced or removed (null). */
function argv(command, defaults, over = {}) {
  const flags = { ...defaults, ...over }
  return [command, ...Object.entries(flags).filter(([, v]) => v !== null).flatMap(([k, v]) => (v === true ? [`--${k}`] : [`--${k}`, v]))]
}
const grantArgs = over => argv('grant', { subject: 'ana', capability: 'talking-head', 'use-class': 'advertising', territory: 'GB', 'max-spend': '5', yes: true, json: true }, over)
const renderArgs = over => argv('render', { subject: `${ANA}:ana`, capability: 'talking-head', 'use-class': 'advertising', territory: 'GB', seconds: '5', json: true }, over)

test('help exits 0; usage errors exit 1', async () => {
  assert.equal((await mandate([])).code, 0)
  assert.equal((await mandate(['render', '--help'])).code, 0)
  for (const argv of [['help'], ['-h'], ['help', 'render'], ['render', '-h']]) {
    const r = await mandate(argv)
    assert.equal(r.code, 0, argv.join(' '))
    assert.match(r.stdout, /mandate/)
  }
  const v = await mandate(['--version'])
  assert.equal(v.code, 0)
  assert.match(v.stdout, /^mandate \d+\.\d+\.\d+/)
  assert.equal((await mandate(['revoke'])).code, 1)
  assert.equal((await mandate(renderArgs({ at: '2026-09-13T00:00:00Z', execute: true }))).code, 1)
  assert.equal((await mandate(['verify', '--sha256', 'a'.repeat(64), '--url', 'https://x.test/a.mp4'])).code, 1)
})

test('grant anchors, prints the UAL and tx, and the producer\'s render is then permitted', async () => {
  const g = await mandate(grantArgs())
  assert.equal(g.code, 0, g.stderr)
  const out = json(g)
  assert.equal(out.granted, true)
  assert.equal(out.grant.subject, `${ANA}:ana`)
  assert.match(out.grant.id, new RegExp(`^urn:mandate:grant:${ANA}:ana:[0-9a-f]{16}$`))
  assert.match(out.ual, /^did:dkg:base:84532\//)
  assert.match(out.explorer, /^https:\/\/sepolia\.basescan\.org\/tx\/0x/)

  const r = await mandate(renderArgs())
  assert.equal(r.code, 0, r.stdout)
  assert.equal(json(r).decision.permit, true)
  assert.equal((await mandate(renderArgs({ capability: 'face-swap-video' }))).code, 2)
})

test('two grants for the same subject get distinct ids and asset names', async () => {
  const a = json(await mandate(grantArgs()))
  const b = json(await mandate(grantArgs()))
  assert.notEqual(a.grant.id, b.grant.id)
  assert.notEqual(a.name, b.name)
})

test('grant refuses prohibited use classes and subjects belonging to another address', async () => {
  assert.equal((await mandate(grantArgs({ 'use-class': 'advertising,adult' }))).code, 1)
  const r = await mandate(grantArgs({ subject: `${STRANGER}:ana` }))
  assert.equal(r.code, 1)
  assert.match(json(r).error, /can only grant for its own subjects/)
})

test('without --yes off a terminal, grant publishes nothing', async () => {
  const before = grantor.calls.filter(c => c.method === 'POST' && c.path === '/api/knowledge-assets').length
  const r = await mandate(grantArgs({ yes: null }))
  assert.equal(r.code, 1)
  assert.equal(grantor.calls.filter(c => c.method === 'POST' && c.path === '/api/knowledge-assets').length, before)
})

test('revoke refuses a grant this node did not publish, without publishing', async () => {
  const before = grantor.calls.length
  const foreign = `urn:mandate:grant:${STRANGER}:ana:0000000000000001`
  const r = await mandate(['revoke', '--id', foreign, '--yes', '--json'])
  assert.equal(r.code, 2)
  assert.equal(json(r).reason, 'not published by this node')
  assert.ok(grantor.calls.slice(before).every(c => c.method !== 'POST' || c.path === '/api/query'))
})

test('revoke refuses a grant id that was never anchored', async () => {
  const r = await mandate(['revoke', '--id', `urn:mandate:grant:${ANA}:ana:00000000000000ff`, '--yes', '--json'])
  assert.equal(r.code, 2)
  assert.equal(json(r).reason, 'grant not found')
})

test('revoke anchors, render then refuses, and a second revoke publishes nothing', async () => {
  const bea = json(await mandate(grantArgs({ subject: 'bea' })))
  assert.equal(bea.granted, true)
  const r = await mandate(['revoke', '--id', bea.grant.id, '--yes', '--json'])
  assert.equal(r.code, 0, r.stdout)
  assert.equal(json(r).revoked, true)
  const d = await mandate(renderArgs({ subject: `${ANA}:bea` }))
  assert.equal(d.code, 2)
  assert.equal(json(d).decision.clause, 'not-revoked')
  const again = await mandate(['revoke', '--id', bea.grant.id, '--yes', '--json'])
  assert.equal(again.code, 0)
  assert.equal(json(again).alreadyRevoked, true)
})

test('a KA minted but not bound exits 7 and reports its UAL and transaction', async () => {
  const bad = await startFakeDkg({ address: ANA_CHECKSUM, name: 'grantor', world: { [GRANTS_CG]: { kas: [] } }, scenario: { publish: 'unbound' } })
  try {
    const r = await mandate(grantArgs(), { env: { MANDATE_GRANTOR_PORT: String(bad.port) } })
    assert.equal(r.code, 7)
    const out = json(r)
    assert.equal(out.stage, 'unbound')
    assert.match(out.ual, /^did:dkg:/)
    assert.match(out.txHash, /^0x/)
  } finally {
    await bad.close()
  }
})

test('a failed share exits 6 and never reports success', async () => {
  const bad = await startFakeDkg({ address: ANA_CHECKSUM, name: 'grantor', world: { [GRANTS_CG]: { kas: [] } }, scenario: { share: 'fail' } })
  try {
    const r = await mandate(grantArgs(), { env: { MANDATE_GRANTOR_PORT: String(bad.port) } })
    assert.equal(r.code, 6)
    assert.equal(json(r).stage, 'share')
    assert.ok(!bad.calls.some(c => c.path.endsWith('/vm/publish')))
  } finally {
    await bad.close()
  }
})

test('render refuses with exit 9 when the node is unreachable', async () => {
  const r = await mandate(renderArgs(), { env: { MANDATE_PRODUCER_PORT: '1' } })
  assert.equal(r.code, 9)
  assert.equal(json(r).decision.clause, 'read-inconsistent')
})

test('status reports an unreachable node without crashing', async () => {
  const r = await mandate(['status', '--json'], { env: { MANDATE_PRODUCER_HOME: join(work, 'missing') } })
  assert.equal(r.code, 9)
  const nodes = json(r).nodes
  assert.equal(nodes.find(n => n.role === 'grantor').reachable, true)
  assert.match(nodes.find(n => n.role === 'producer').error, /auth\.token/)
})

test('verify by hash reads the grants its trusted edges cite', async () => {
  const r = await mandate(['verify', '--sha256', 'b'.repeat(64), '--json'])
  assert.equal(r.code, 2)
  assert.equal(json(r).verdict, 'UNKNOWN')
  assert.match(json(r).node, /grantor/)
})

test('.env supplies only Mandate\'s own keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mandate-env-'))
  try {
    writeFileSync(join(dir, '.env'), 'MANDATE_GRANTS_CG=0x0000000000000000000000000000000000000001/g\nNODE_OPTIONS=--require=/tmp/evil.js\nPATH=/tmp\nLIVEPEER_AGENT_KEY=app_x_pmth_y\n')
    const env = {}
    const r = loadEnvFile(join(dir, '.env'), env)
    assert.deepEqual(Object.keys(env).sort(), ['LIVEPEER_AGENT_KEY', 'MANDATE_GRANTS_CG'])
    assert.deepEqual(r.ignored.sort(), ['NODE_OPTIONS', 'PATH'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('local state is private to the user', () => {
  const dir = join(work, '.mandate', 'state')
  assert.equal(statSync(dir).mode & 0o777, 0o700)
  for (const f of readdirSync(dir)) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600)
})

test('under a ceiling, a per-second capability with no --seconds refuses and says why', async () => {
  const r = await mandate(renderArgs({ subject: `${ANA}:ana`, seconds: null }))
  assert.equal(r.code, 2)
  assert.equal(json(r).decision.clause, 'spend-ceiling')
  assert.equal(json(r).price.source, 'static list price')
})

test('render --execute checks required inputs before anything is dispatched', async () => {
  const r = await mandate(renderArgs({ capability: 'sync-lipsync-v3', 'image-url': 'https://x.test/a.jpg', execute: true }))
  assert.equal(r.code, 1)
  assert.match(json(r).error, /needs audio_url/)
})

test('record with nothing pending lists nothing', async () => {
  const r = await mandate(['record', '--json'])
  assert.equal(r.code, 0)
  assert.deepEqual(json(r).pending, [])
})

test('render refuses with exit 9 on a node that is behind the chain', async () => {
  const stale = await startFakeDkg({ address: PRODUCER, name: 'producer', world, scenario: { staleBy: 1 } })
  try {
    const r = await mandate(renderArgs(), { env: { MANDATE_PRODUCER_PORT: String(stale.port) } })
    assert.equal(r.code, 9)
    assert.match(json(r).decision.reason, /stale view/)
  } finally {
    await stale.close()
  }
})

/* ---------------------------------------------------------------------------
 * Consent capture, rendering and recording against a scripted Livepeer.
 * ------------------------------------------------------------------------- */

const pendingDir = () => join(work, '.mandate', 'pending')
const store = () => pendingStore(pendingDir())
const publishes = node => node.calls.filter(x => x.method === 'POST' && x.path.endsWith('/vm/publish')).length

/** A fake Livepeer that captures one clip and transcribes it as `transcript` (or fails ASR). */
function consentLp(transcript, { tag = String(++lpSeq), asr } = {}) {
  const clip = mediaUrl(`clip-${tag}.mp4`)
  return {
    request_upload: { structured: { page_url: 'https://agent.livepeer.org/u/0123abcd', token: 'a'.repeat(24), expires_at: new Date(Date.now() + 600_000).toISOString() } },
    get_upload: { structured: { status: 'done', url: clip, mime: 'video/mp4' } },
    'run_capability:nemotron-asr': asr ?? { structured: { ok: true, capability: 'nemotron-asr', output_kind: 'text', result: { text: transcript }, source_url: clip, inputs: { audio_url: clip } } },
  }
}

const consentGrant = over => grantArgs({ 'with-consent': true, territory: null, ...over })

test('R9: a grant that cannot be published fails before any consent clip is requested or transcribed', async () => {
  const lp = consentLp('I consent to a talking head video of me for advertising.')
  // Off a terminal, the clip could never be confirmed: exit 3 before capture, even with --yes.
  const noTty = await mandate(consentGrant(), { lp })
  assert.equal(noTty.code, 3, noTty.stdout)
  assert.equal(json(noTty).reason, 'consent confirmation impossible')
  assert.deepEqual(noTty.calls, [])
  // Lowercase territory, a grants graph this node does not own, a past end date: exit 1, nothing requested.
  const cases = [
    [consentGrant({ territory: 'gb' }), {}],
    [consentGrant(), { MANDATE_GRANTS_CG: `${STRANGER}/other` }],
    [consentGrant({ 'valid-until': '2020-01-01T00:00:00Z' }), {}],
    [consentGrant({ 'use-class': 'Advertising' }), {}],
    [consentGrant({ 'valid-from': '2026-12-02T00:00:00Z', 'valid-until': '2026-12-01T00:00:00Z' }), {}],
  ]
  for (const [args, env] of cases) {
    const r = await mandate(args, { lp, tty: true, env })
    assert.equal(r.code, 1, `${args.join(' ')}\n${r.stdout}${r.stderr}`)
    assert.deepEqual(r.calls, [], args.join(' '))
  }
  assert.equal(grantor.calls.filter(x => x.method === 'POST' && x.path === '/api/knowledge-assets' && x.body.name?.startsWith('grant-ana-')).length >= 0, true)
})

test('R12: a captured clip needs typed confirmation of its transcript and every unchecked term, which --yes does not skip', async () => {
  const lp = consentLp('I consent to a talking head video of me for advertising.')
  const before = publishes(grantor)
  // The typed answers are wrong: nothing is published, exit 3.
  const wrong = await mandate(consentGrant({ subject: 'cara' }), { lp, tty: true, input: 'matches\nyes\nyes\nyes\n' })
  assert.equal(wrong.code, 3, wrong.stderr)
  assert.equal(json(wrong).reason, 'consent not confirmed')
  assert.equal(publishes(grantor), before)
  // No answers at all (end of input): not confirmed.
  assert.equal((await mandate(consentGrant({ subject: 'cara' }), { lp, tty: true })).code, 3)

  const until = '2026-12-01T00:00:00.000Z'
  const ok = await mandate(consentGrant({ subject: 'cara', 'valid-until': until }), { lp, tty: true, input: `matches\n2026-12-01\n5\nanywhere\n` })
  assert.equal(ok.code, 0, ok.stderr)
  const out = json(ok)
  assert.equal(out.granted, true)
  assert.match(out.grant.consentClipSha256, /^[0-9a-f]{64}$/)
  assert.equal(out.consent.forced, false)
  assert.deepEqual(out.consent.scope.unchecked.sort(), ['ceiling', 'territory-unrestricted', 'validity'])
  assert.match(ok.stderr, /NOT CHECKED against the words — valid until 2026-12-01/)
  assert.match(ok.stderr, /spend ceiling \$5/)
  assert.match(ok.stderr, /territory ANYWHERE/)
  assert.equal(publishes(grantor), before + 1)
})

test('R18: --force never publishes past a failed transcription or a clip with no first-person consent', async () => {
  const before = publishes(grantor)
  const answers = `matches\n${new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10)}\n5\nanywhere\n`
  const asrFailed = await mandate(consentGrant({ subject: 'dan', force: true }), {
    lp: consentLp('', { asr: { structured: { ok: false, error: 'model unavailable' } } }), tty: true, input: answers,
  })
  assert.equal(asrFailed.code, 3, asrFailed.stderr)
  assert.match(json(asrFailed).consent.asrError, /model unavailable/)

  const reported = await mandate(consentGrant({ subject: 'dan', force: true }), {
    lp: consentLp('She said she consents to a talking head video for advertising.'), tty: true,
    input: `matches\n${new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10)}\n5\nanywhere\n`,
  })
  assert.equal(reported.code, 3, reported.stderr)
  assert.equal(json(reported).consent.scope.affirmative, false)
  assert.equal(publishes(grantor), before)
})

test('item 11: a grant forced past a missing term is published without the clip hash, so it never looks checked', async () => {
  const lp = consentLp('I consent to a talking head video of me.')
  const r = await mandate(consentGrant({ subject: 'eve', force: true, territory: 'GB' }), { lp, tty: true, input: 'matches\n' + new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10) + '\n5\n' })
  assert.equal(r.code, 0, r.stderr)
  const out = json(r)
  assert.equal(out.consent.forced, true)
  assert.equal(out.consent.publishedClipHash, false)
  assert.equal(out.grant.consentClipSha256, null)
  assert.match(out.consent.sha256, /^[0-9a-f]{64}$/)
})

/* Rendering */

const renderLp = (tag, over = {}) => ({
  get_pricing: { structured: { capabilities: [{ name: 'talking-head', unit_kind: 'second', display_price_usd: 0.168 }] } },
  spend_cap: { structured: { remaining_usd: 100 } },
  describe_capability: { structured: { name: 'talking-head' } },
  'run_capability:talking-head': { structured: { ok: true, status: 'done', url: mediaUrl(`out-${tag}.mp4`), cost_usd_estimated: 0.84 } },
  ...over,
})
const execArgs = (subject, over = {}) => renderArgs({ subject: `${ANA}:${subject}`, execute: true, 'image-url': mediaUrl('in.jpg'), 'audio-url': mediaUrl('in.wav'), ...over })
const keyFor = (grantId, seconds = 5) => renderKey({ grantId, capability: 'talking-head', inputs: { image_url: mediaUrl('in.jpg'), audio_url: mediaUrl('in.wav') }, seconds })
async function newGrant(subject, over = {}) {
  const g = await mandate(grantArgs({ subject, ...over }))
  assert.equal(g.code, 0, g.stdout)
  return json(g).grant
}

test('render --execute records the derivation; an unlabelled fallback price is not called live and a skipped spend cap says so', async () => {
  await newGrant('fay')
  const r = await mandate(execArgs('fay'), {
    lp: renderLp('fay', {
      get_pricing: { structured: { capabilities: [{ name: 'talking-head', unit_kind: 'second', display_price_usd: 0.168, source: 'static_fallback' }] } },
      spend_cap: { structured: { cap_usd: 50 } },
    }),
  })
  assert.equal(r.code, 0, r.stdout)
  const out = json(r)
  assert.doesNotMatch(out.price.source, /^live/)
  assert.match(out.price.source, /not live/)
  assert.equal(out.spendCap.checked, false)
  assert.match(out.spendCap.note, /remaining_usd/)
  assert.equal(out.billedUsd, 0.84)
  assert.match(out.derivation.ual, /^did:dkg:/)
  assert.equal(store().load(out.pending).status, 'recorded')
})

test('item 12: with no platform cost, a per-second render is recorded as billed unknown, not as the operator\'s --seconds estimate', async () => {
  await newGrant('gil', { 'max-spend': null })
  const r = await mandate(execArgs('gil'), { lp: renderLp('gil', { 'run_capability:talking-head': { structured: { ok: true, status: 'done', url: mediaUrl('out-gil.mp4') } } }) })
  assert.equal(r.code, 0, r.stdout)
  assert.equal(json(r).billedUsd, null)
  assert.match(json(r).billedUsdSource, /unknown/)
})

test('R14: a rerun never re-dispatches a recorded, submitted or rendered render', async () => {
  const g = await newGrant('hal')
  const key = keyFor(g.id)
  const base = { key, idempotencyKey: key, createdAt: new Date().toISOString(), subject: g.subject, capability: 'talking-head', grantId: g.id }
  store().save({ ...base, status: 'recorded', mediaUrl: mediaUrl('out-hal.mp4'), derivation: { id: 'urn:x', ual: 'did:dkg:base:84532/0xabc/1' } })
  const recorded = await mandate(execArgs('hal'), { lp: renderLp('hal') })
  assert.equal(recorded.code, 0, recorded.stdout)
  assert.equal(json(recorded).alreadyRecorded, true)
  assert.ok(!recorded.calls.some(x => x.name.startsWith('run_capability')))

  store().save({ ...base, status: 'submitted', jobId: 'mjob_abc1234' })
  const submitted = await mandate(execArgs('hal'), { lp: renderLp('hal') })
  assert.equal(submitted.code, 5)
  assert.equal(json(submitted).status, 'submitted')
  assert.ok(!submitted.calls.some(x => x.name.startsWith('run_capability')))
  assert.equal(store().load(key).jobId, 'mjob_abc1234')
})

test('item 8: an inline call that times out with no job id stays recoverable, and rerunning the same command recovers it', async () => {
  await newGrant('ivy')
  const lost = await mandate(execArgs('ivy'), { lp: renderLp('ivy', { 'run_capability:talking-head': { throw: 'Request timed out' } }) })
  assert.equal(lost.code, 5, lost.stdout)
  const out = json(lost)
  assert.equal(out.recoverable, true)
  const rec = store().load(out.pending)
  assert.equal(rec.status, 'submitted')
  assert.equal(rec.mayHaveStarted, true)

  // record says the outcome is unknown and points to a rerun (R22).
  const rec1 = await mandate(['record', '--pending', out.pending, '--json'])
  assert.equal(rec1.code, 9)
  assert.equal(json(rec1).outcome, 'unknown')

  const again = await mandate(execArgs('ivy'), { lp: renderLp('ivy') })
  assert.equal(again.code, 0, again.stdout)
  assert.equal(store().load(out.pending).status, 'recorded')
})

test('R22 and R21: a render stuck in dispatching is unknown, and the pending list never shows unrecorded media', async () => {
  const key = `mandate-${'d'.repeat(32)}`
  store().save({ key, idempotencyKey: key, status: 'dispatching', capability: 'talking-head', createdAt: new Date().toISOString() })
  const r = await mandate(['record', '--pending', key, '--json'])
  assert.equal(r.code, 9)
  assert.match(r.stdout, /"rerun": true/)

  const k2 = `mandate-${'e'.repeat(32)}`
  store().save({ key: k2, status: 'rendered', capability: 'talking-head', mediaUrl: 'https://cdn.example/secret-output.mp4', createdAt: new Date().toISOString() })
  const list = await mandate(['record', '--json'])
  assert.equal(list.code, 0)
  assert.doesNotMatch(list.stdout, /secret-output/)
  assert.equal(json(list).pending.find(p => p.key === k2).hasMedia, true)
})

test('R8: record --pending records the capability the platform says served the job, and never an echoed input', async () => {
  const g = await newGrant('jon')
  const key = `mandate-${'f'.repeat(32)}`
  const inputs = { image_url: mediaUrl('portrait.jpg'), audio_url: mediaUrl('in.wav') }
  store().save({ key, idempotencyKey: key, status: 'submitted', jobId: 'mjob_served01', capability: 'talking-head', grantId: g.id, inputs, sourceUrl: null, createdAt: new Date().toISOString() })
  const echoed = await mandate(['record', '--pending', key, '--json'], { lp: { get_create_media: { structured: { status: 'done', url: inputs.image_url } } } })
  assert.equal(echoed.code, 5, echoed.stdout)
  assert.equal(json(echoed).kind, 'no-media')

  const r = await mandate(['record', '--pending', key, '--json'], { lp: { get_create_media: { structured: { status: 'done', url: mediaUrl('out-jon.mp4'), capability_used: 'face-swap-video', cost_usd_estimated: 0.5 } } } })
  assert.equal(r.code, 0, r.stdout)
  assert.equal(json(r).servedCapability, 'face-swap-video')
  const asset = producer.assets.get(json(r).derivation.name)
  assert.ok(asset.quads.some(q => /face-swap-video/.test(q.object)))
})

test('R3: a failed derivation publish keeps its asset name, UAL, tx and stage, and a retry never mints again', async () => {
  await newGrant('kim')
  producer.scenario.publish = 'unbound'
  let first
  try {
    first = await mandate(execArgs('kim'), { lp: renderLp('kim') })
  } finally {
    delete producer.scenario.publish
  }
  assert.equal(first.code, 4, first.stdout)
  const out = json(first)
  assert.equal(out.stage, 'unbound')
  assert.match(out.asset, /^derivation-[0-9a-f]{16}-[0-9a-f]{16}$/)
  assert.match(out.ual, /^did:dkg:/)
  assert.match(out.txHash, /^0x[0-9a-f]{64}$/)
  assert.doesNotMatch(first.stdout, /out-kim/)
  const attempt = store().load(out.pending).derivationAttempt
  assert.equal(attempt.name, out.asset)
  assert.equal(attempt.stage, 'unbound')

  const before = publishes(producer)
  const retry = await mandate(['record', '--pending', out.pending, '--json'])
  assert.equal(retry.code, 4, retry.stdout)
  assert.equal(json(retry).stage, 'resume-refused')
  assert.equal(publishes(producer), before)
})

test('R3: after a lost publish response the asset is not published again until the node shows it confirmed, then it is resumed', async () => {
  await newGrant('lea')
  producer.scenario.publish = 'lost'
  let first
  try {
    first = await mandate(execArgs('lea'), { lp: renderLp('lea') })
  } finally {
    delete producer.scenario.publish
  }
  assert.equal(first.code, 4, first.stdout)
  const out = json(first)
  assert.equal(out.stage, 'publish-transport')
  assert.equal(out.mayHaveSent, true)

  const before = publishes(producer)
  const blocked = await mandate(['record', '--pending', out.pending, '--json'])
  assert.equal(blocked.code, 4)
  assert.equal(json(blocked).stage, 'resume-refused')
  assert.match(json(blocked).error, /swm-shared/)
  assert.equal(publishes(producer), before)

  producer.confirm(out.asset)
  const done = await mandate(['record', '--pending', out.pending, '--json'])
  assert.equal(done.code, 0, done.stdout)
  assert.equal(json(done).derivation.name, out.asset)
  assert.equal(json(done).derivation.resumed, true)
  assert.equal(publishes(producer), before)
})

test('R3: a retry after a failed share continues the same asset instead of creating another', async () => {
  await newGrant('max')
  producer.scenario.share = 'fail'
  let first
  try {
    first = await mandate(execArgs('max'), { lp: renderLp('max') })
  } finally {
    delete producer.scenario.share
  }
  assert.equal(first.code, 4, first.stdout)
  const name = json(first).asset
  const retry = await mandate(['record', '--pending', json(first).pending, '--json'])
  assert.equal(retry.code, 0, retry.stdout)
  assert.equal(json(retry).derivation.name, name)
  assert.equal(producer.calls.filter(x => x.method === 'POST' && x.path === '/api/knowledge-assets' && x.body.name?.startsWith(name.slice(0, 27))).length, 1)
})

test('R14: an idempotent replay of a render already on the graph is not recorded or counted again', async () => {
  await newGrant('ned')
  const first = await mandate(execArgs('ned'), { lp: renderLp('ned', { 'run_capability:talking-head': { structured: { ok: true, status: 'done', job_id: 'mjob_ned00001', url: mediaUrl('out-ned.mp4'), cost_usd_estimated: 0.84 } } }) })
  assert.equal(first.code, 0, first.stdout)
  const key = json(first).pending
  // The local record was lost mid-run; the platform replays the same job.
  store().save({ ...store().load(key), status: 'dispatching', derivation: undefined, derivationAttempt: undefined, mediaUrl: undefined })
  const before = publishes(producer)
  const replay = await mandate(execArgs('ned'), { lp: renderLp('ned', { 'run_capability:talking-head': { structured: { ok: true, status: 'done', job_id: 'mjob_ned00001', url: mediaUrl('out-ned.mp4'), idempotency_replay: true } } }) })
  assert.equal(replay.code, 0, replay.stdout)
  assert.equal(json(replay).derivation.existing, true)
  assert.equal(publishes(producer), before)
})

test('item 12: renders on this machine not yet recorded count against the ceiling', async () => {
  const g = await newGrant('ora', { 'max-spend': '1' })
  const dry = renderArgs({ subject: `${ANA}:ora` })
  assert.equal((await mandate(dry)).code, 0)
  const other = { key: `mandate-${'1'.repeat(32)}`, capability: 'talking-head', grantId: g.id, createdAt: new Date().toISOString() }
  store().save({ ...other, status: 'submitted', jobId: 'mjob_ora00001', estimateUsd: 0.5 })
  const over = await mandate(dry)
  assert.equal(over.code, 2)
  assert.equal(json(over).decision.clause, 'spend-ceiling')
  assert.equal(json(over).localPending.length, 1)
  store().save({ ...other, status: 'dispatching', estimateUsd: null })
  const unknown = await mandate(dry)
  assert.equal(unknown.code, 2)
  assert.match(json(unknown).decision.reason, /unknown/)
  store().save({ ...other, status: 'failed' })
  assert.equal((await mandate(dry)).code, 0)
})

test('render --execute refuses to pay for a render whose derivation would not count toward spend', async () => {
  await newGrant('pia')
  const r = await mandate(execArgs('pia'), { lp: renderLp('pia'), env: { MANDATE_TRUSTED_PRODUCERS: STRANGER } })
  assert.equal(r.code, 1, r.stdout)
  assert.match(json(r).error, /not a trusted producer/)
  assert.ok(!r.calls.some(x => x.name.startsWith('run_capability')))
})

/* Exit codes, node roles, sanitising and configuration */

test('R23: media, token and Livepeer credential failures are not usage errors', async () => {
  const fetchFailed = await mandate(['verify', '--url', mediaUrl('missing.mp4'), '--json'])
  assert.equal(fetchFailed.code, 9, fetchFailed.stdout)
  const noToken = await mandate(['revoke', '--id', `urn:mandate:grant:${ANA}:ana:0000000000000001`, '--yes', '--json'], { env: { MANDATE_GRANTOR_HOME: join(work, 'missing') } })
  assert.equal(noToken.code, 9, noToken.stdout)
  const badHome = join(work, 'bad-state-home')
  mkdirSync(join(badHome, 'state'), { recursive: true })
  writeFileSync(join(badHome, 'state', `${GRANTS_CG.replace(/[^A-Za-z0-9._-]/g, '_')}.json`), '{ not json')
  const badState = await mandate(['blast-radius', '--grant', `urn:mandate:grant:${ANA}:ana:0000000000000001`, '--json'], { env: { MANDATE_HOME: badHome } })
  assert.equal(badState.code, 9, badState.stdout)
  assert.match(json(badState).error, /cannot read local state/)
  await newGrant('quin')
  const credential = await mandate(execArgs('quin'), { lp: { connectError: 'Streamable HTTP error: 401 Unauthorized' } })
  assert.equal(credential.code, 10, credential.stdout)
  const unreachable = await mandate(execArgs('quin'), { lp: { connectError: 'fetch failed: ECONNREFUSED' } })
  assert.equal(unreachable.code, 9, unreachable.stdout)
})

test('verify reports the node role it actually read from, and a named verifier must exist', async () => {
  const fallback = await mandate(['verify', '--sha256', 'c'.repeat(64), '--json'])
  assert.equal(json(fallback).nodeRole, 'grantor')
  const named = await mandate(['verify', '--sha256', 'c'.repeat(64), '--node', 'verifier', '--json'])
  assert.equal(named.code, 1)
  assert.match(json(named).error, /no verifier node is configured/)
})

test('APP-2: a UAL or tx hash from the node is stripped of control characters before printing', async () => {
  grantor.scenario.ualSuffix = `${ESC}[2J${ESC}[32mFORGED`
  grantor.scenario.txHash = `0x${'ab'.repeat(32)}${ESC}[2J`
  try {
    const r = await mandate(grantArgs({ subject: 'rex', json: null }))
    assert.equal(r.code, 0, r.stderr)
    assert.ok(!r.stdout.includes(ESC))
    assert.match(r.stdout, /FORGED/)
  } finally {
    delete grantor.scenario.ualSuffix
    delete grantor.scenario.txHash
  }
})

test('blast radius counts a trusted producer\'s unreadable record under the grant', async () => {
  const g = await newGrant('sol')
  const bad = derivation({ id: `urn:mandate:derivation:${'0'.repeat(16)}:0000000000000abc`, outputSha256: 'e'.repeat(64), authorizedUnder: g.id })
  world[DERIVS_CG].kas.push(derivationKa(bad))
  const r = await mandate(['blast-radius', '--grant', g.id, '--json'])
  assert.equal(r.code, 0, r.stdout)
  assert.equal(json(r).unreadable, 1)
  assert.equal(json(r).billedUnknown, true)
  const text = await mandate(['blast-radius', '--grant', g.id])
  assert.match(text.stdout, /unreadable\s+1 trusted record/)
  // billedUsd is what producers recorded (the platform's cost when given), not a list-price estimate or an invoice.
  assert.match(text.stdout, /as recorded by producers; not an invoice/)
  assert.doesNotMatch(text.stdout, /estimated at list price/)
})

test('R31: graph variables take lists, and grant publishes to the graph under the grantor\'s own address', async () => {
  const other = `${STRANGER}/other-grants`
  world[other] = { kas: [] }
  const r = await mandate(grantArgs({ subject: 'tia' }), { env: { MANDATE_GRANTS_CG: `${other},${GRANTS_CG}`, MANDATE_DERIVATIONS_CG: `${DERIVS_CG},${STRANGER}/d` } })
  assert.equal(r.code, 0, r.stdout)
  assert.equal(json(r).contextGraphId, GRANTS_CG)
  assert.equal(grantor.calls.findLast(x => x.path === '/api/knowledge-assets').body.contextGraphId, GRANTS_CG)
  const bad = await mandate(grantArgs({ subject: 'tia' }), { env: { MANDATE_GRANTS_CG: `${GRANTS_CG},0x<grantor>/x` } })
  assert.equal(bad.code, 1)
})

test('R16: nodes.mjs init and start work before graph ids exist; subscribe refuses without them', async () => {
  const home = join(work, 'dkg-new-grantor')
  const placeholder = { MANDATE_GRANTS_CG: '0x<grantor agent address>/mandate-grants', MANDATE_DERIVATIONS_CG: '', MANDATE_GRANTOR_HOME: home }
  const init = await mandate(['init', 'grantor'], { bin: NODES, env: placeholder })
  assert.equal(init.code, 0, init.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).contextGraphs, [])
  // start finds the (fake) node already running without needing graph ids.
  const start = await mandate(['start', 'grantor'], { bin: NODES, env: { ...placeholder, MANDATE_GRANTOR_HOME: homes.grantor } })
  assert.equal(start.code, 0, start.stderr)
  assert.match(start.stdout, /already running/)
  const before = grantor.calls.length
  const sub = await mandate(['subscribe', 'grantor'], { bin: NODES, env: { ...placeholder, MANDATE_GRANTOR_HOME: homes.grantor } })
  assert.equal(sub.code, 1)
  assert.match(sub.stderr, /MANDATE_GRANTS_CG/)
  assert.equal(grantor.calls.length, before)

  const home2 = join(work, 'dkg-new-producer')
  const listed = await mandate(['init', 'producer'], { bin: NODES, env: { MANDATE_PRODUCER_HOME: home2, MANDATE_GRANTS_CG: `${GRANTS_CG},${STRANGER}/g2` } })
  assert.equal(listed.code, 0, listed.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(home2, 'config.json'), 'utf8')).contextGraphs, [GRANTS_CG, `${STRANGER}/g2`, DERIVS_CG])
})

test('R25 and item 15: demo runs are ignored by git, redact transcripts and private links, and check the grant they verify', () => {
  assert.match(readFileSync(new URL('../.gitignore', import.meta.url), 'utf8'), /^demo\/runs\/$/m)
  const run = { steps: [{ result: { consent: { transcript: 'I consent, my name is Ana', sha256: 'a'.repeat(64) }, mediaUrl: 'https://cdn.example/out.mp4?sig=secret', explorer: 'https://sepolia.basescan.org/tx/0x12' } }], lines: 'RENDERED https://cdn.example/out.mp4?sig=secret' }
  const text = JSON.stringify(redact(run))
  assert.doesNotMatch(text, /Ana|sig=secret|cdn\.example/)
  assert.match(text, /sepolia\.basescan\.org\/tx\/0x12/)
  assert.match(text, /"sha256":"a{64}"/)
  for (const bad of ['abc', '', '0', '-5', '1e3', 'NaN', '99999999']) assert.throws(() => waitMs(bad), /--wait-seconds/)
  assert.equal(waitMs('600'), 600_000)
  const g = 'urn:mandate:grant:x'
  assert.equal(clearFor({ result: { verdict: 'CLEAR', grantId: 'urn:mandate:grant:other' } }, g), false)
  assert.equal(clearFor({ result: { verdict: 'CLEAR', grantId: g } }, g), true)
  assert.equal(taintedFor({ result: { verdict: 'TAINTED', subStatus: 'MALFORMED', grantId: g } }, g), false)
  assert.equal(taintedFor({ result: { verdict: 'TAINTED', subStatus: 'REVOKED', grantId: g } }, g), true)
})
