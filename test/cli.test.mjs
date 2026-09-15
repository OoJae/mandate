import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, readdirSync, mkdirSync, chmodSync, utimesSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { request as httpRequest } from 'node:http'
import { startFakeDkg } from './fixtures/fake-dkg-server.mjs'
import { loadEnvFile } from '../bin/config.mjs'
import { createHash } from 'node:crypto'
import { renderKey, pendingStore, grantLockPath } from '../src/pending.mjs'
import { consentScript } from '../src/scope.mjs'
import { EXIT_HELP } from '../bin/args.mjs'
import { GRANTS_CG, DERIVS_CG, ANA, PRODUCER, STRANGER, derivation, derivationKa } from './fixtures/build.mjs'
import { UNTIL, UNTIL_Z, UNTIL_DAY, UNTIL_SPOKEN, DAY_AFTER_UNTIL } from './fixtures/dates.mjs'
import { redact, waitMs, clearFor, taintedFor, blastLine, cliArgv, nodesArgv, DEMO_ENV_FILE } from '../demo/full.mjs'
import { cgIri } from '../src/queries.mjs'
import * as V from '../src/vocab.mjs'

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
      // Answers only after a while, like a slow poll or a render still running.
      if (r.delayMs) await new Promise(res => setTimeout(res, r.delayMs))
      if (r.throw) throw new Error(r.throw)
      // Never answers: with nothing else pending, the CLI process ends mid-call, like a crash.
      if (r.hang) await new Promise(() => {})
      return { structuredContent: r.structured, content: r.text ? [{ type: 'text', text: r.text }] : [], isError: r.isError === true }
    },
    async close() {},
  }
}
`
/*
 * The hook rewrites only src/livepeer.mjs. module.registerHooks (synchronous, in
 * this thread) exists from Node 22.15 and 23.5; the engines floor is 22.13, which
 * has only module.register (hooks in a worker thread, and deprecated from Node 26
 * with a warning on stderr). So the preload uses registerHooks where it exists and
 * register otherwise. MANDATE_TEST_HOOKS=register forces the fallback, so a Node
 * that has both still runs it.
 */
const HOOKS = client => `const rewrite = (url, r) => {
  if (!url.endsWith('/src/livepeer.mjs')) return r
  // register hands the source over as bytes (a Uint8Array on Node 22), registerHooks as a Buffer or string.
  const text = typeof r.source === 'string' ? r.source : new TextDecoder().decode(r.source)
  const source = text.replace('export async function connect(', 'async function realConnect(')
    + '\\nexport async function connect(surface) { return (await import(${JSON.stringify(client)})).fakeClient(surface) }\\n'
  return { ...r, source }
}
export function loadSync(url, context, nextLoad) { return rewrite(url, nextLoad(url, context)) }
export async function load(url, context, nextLoad) { return rewrite(url, await nextLoad(url, context)) }
`
const PRELOAD = hooks => `import * as mod from 'node:module'
if (typeof mod.registerHooks === 'function' && process.env.MANDATE_TEST_HOOKS !== 'register') {
  mod.registerHooks({ load: (await import(${JSON.stringify(hooks)})).loadSync })
} else {
  mod.register(${JSON.stringify(hooks)})
}
// Only loopback is reachable, so a hook that failed to apply ends the run at once
// instead of reaching the real Livepeer Agent.
const realFetch = globalThis.fetch
globalThis.fetch = (input, init) => {
  const host = new URL(input instanceof Request ? input.url : String(input)).hostname
  if (host !== '127.0.0.1' && host !== 'localhost') return Promise.reject(new Error('test harness: no network to ' + host))
  return realFetch(input, init)
}
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
  writeFileSync(join(work, 'livepeer-hooks.mjs'), HOOKS(pathToFileURL(join(work, 'fake-livepeer.mjs')).href))
  writeFileSync(join(work, 'preload.mjs'), PRELOAD(pathToFileURL(join(work, 'livepeer-hooks.mjs')).href))
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
  const before = publishes(grantor)
  const lp = consentLp('I consent to a talking head video of me for advertising.')
  // Off a terminal, the clip could never be confirmed: exit 3 before capture, even with --yes.
  const noTty = await mandate(consentGrant(), { lp })
  assert.equal(noTty.code, 3, noTty.stdout)
  assert.equal(json(noTty).reason, 'consent confirmation impossible')
  assert.deepEqual(noTty.calls, [])
  // Without --yes too: still exit 3, not a usage error, and still nothing requested.
  const noTtyNoYes = await mandate(consentGrant({ yes: null }), { lp })
  assert.equal(noTtyNoYes.code, 3, noTtyNoYes.stdout)
  assert.equal(json(noTtyNoYes).reason, 'consent confirmation impossible')
  assert.deepEqual(noTtyNoYes.calls, [])
  // On a terminal but in --json mode without --yes, the publish confirmation cannot be asked: exit 1 before capture.
  const jsonNoYes = await mandate(consentGrant({ yes: null }), { lp, tty: true })
  assert.equal(jsonNoYes.code, 1, jsonNoYes.stdout)
  assert.match(json(jsonNoYes).error, /pass --yes/)
  assert.deepEqual(jsonNoYes.calls, [])
  // Lowercase territory, a grants graph this node does not own, a past end date: exit 1, nothing requested.
  const cases = [
    [consentGrant({ territory: 'gb' }), {}],
    [consentGrant(), { MANDATE_GRANTS_CG: `${STRANGER}/other` }],
    [consentGrant({ 'valid-until': '2020-01-01T00:00:00Z' }), {}],
    [consentGrant({ 'use-class': 'Advertising' }), {}],
    [consentGrant({ 'valid-from': `${DAY_AFTER_UNTIL}T00:00:00Z`, 'valid-until': UNTIL_Z }), {}],
  ]
  for (const [args, env] of cases) {
    const r = await mandate(args, { lp, tty: true, env })
    assert.equal(r.code, 1, `${args.join(' ')}\n${r.stdout}${r.stderr}`)
    assert.deepEqual(r.calls, [], args.join(' '))
  }
  assert.equal(publishes(grantor), before)
})

const until = UNTIL
const scriptFor = (over = {}) => consentScript({ capability: ['talking-head'], useClass: ['advertising'], territory: [], validUntil: until, maxSpendUsd: '5', ...over })
const lastGrantQuads = () => grantor.calls.findLast(x => x.method === 'POST' && x.path === '/api/knowledge-assets').body.quads

test('D1/D2: a reading of the consent script is accepted without a typed answer, and carries the clip hash', async () => {
  const before = publishes(grantor)
  const lp = consentLp(scriptFor({ territory: ['GB'] }))
  const ok = await mandate(consentGrant({ subject: 'cara', territory: 'GB', 'valid-until': until }), { lp, tty: true })
  assert.equal(ok.code, 0, ok.stderr)
  const out = json(ok)
  assert.equal(out.granted, true)
  assert.equal(out.consent.confirmedBy, 'script')
  assert.equal(out.consent.scope.scriptMatch.matched, true)
  assert.match(out.grant.consentClipSha256, /^[0-9a-f]{64}$/)
  assert.doesNotMatch(ok.stderr, /Type /)
  assert.equal(publishes(grantor), before + 1)
})

test('D2: a reading of the script still needs a typed answer for what the script never says, and --json cannot give it', async () => {
  const before = publishes(grantor)
  const lp = consentLp(scriptFor())
  // No territory: the script never says "anywhere". In --json mode that is exit 3 before publishing.
  const jsonMode = await mandate(consentGrant({ subject: 'cara', 'valid-until': until }), { lp, tty: true, input: 'anywhere\n' })
  assert.equal(jsonMode.code, 3, jsonMode.stderr)
  assert.equal(json(jsonMode).reason, 'consent confirmation impossible')
  // Known before capture: no upload link, no clip, no paid transcription.
  assert.deepEqual(jsonMode.calls, [])
  assert.match(json(jsonMode).detail, /territory-unrestricted/)
  assert.equal(publishes(grantor), before)
  const wrong = await mandate(consentGrant({ subject: 'cara', 'valid-until': until, json: null }), { lp, tty: true, input: 'yes\n' })
  assert.equal(wrong.code, 3, wrong.stdout)
  assert.equal(publishes(grantor), before)
  // No ceiling: the script never says "none".
  const noCeiling = await mandate(consentGrant({ subject: 'cara', territory: 'GB', 'valid-until': until, 'max-spend': null }), { lp: consentLp(scriptFor({ territory: ['GB'], maxSpendUsd: null })), tty: true, input: 'none\n' })
  assert.equal(noCeiling.code, 3, noCeiling.stderr)
  assert.match(json(noCeiling).detail, /ceiling/)
  assert.deepEqual(noCeiling.calls, [])
  // With a territory and a ceiling, --json still captures: a reading of the script then needs no typed answer.
  const both = await mandate(consentGrant({ subject: 'cara', territory: 'GB', 'valid-until': until }), { lp: consentLp(scriptFor({ territory: ['GB'] })), tty: true })
  assert.equal(both.code, 0, both.stderr)
  assert.ok(both.calls.some(x => x.name === 'run_capability:nemotron-asr'))
  assert.equal(publishes(grantor), before + 1)
  const ok = await mandate(consentGrant({ subject: 'cara', 'valid-until': until, json: null }), { lp, tty: true, input: 'anywhere\n' })
  assert.equal(ok.code, 0, ok.stdout)
  assert.match(ok.stdout, /territory ANYWHERE/)
  assert.doesNotMatch(ok.stdout, /Type .*matches/)
  assert.match(ok.stdout, /consent clip [0-9a-f]{64}/)
  assert.equal(publishes(grantor), before + 2)
})

test('D2: a transcript that is not the script needs every typed answer, which --yes never skips, and is published without the clip hash', async () => {
  // Heuristically consent-like, but not a reading of the script.
  const lp = consentLp('I consent to a talking head video of me for advertising.')
  const before = publishes(grantor)
  const args = over => consentGrant({ subject: 'cara', 'valid-until': until, json: null, ...over })
  // --json on a terminal: the confirmation cannot be asked; exit 3, nothing published, the differences reported.
  // (With a territory: without one, --json stops before capture. The words never name GB, hence --force.)
  const jsonMode = await mandate(args({ json: true, territory: 'GB', force: true }), { lp, tty: true, input: `matches\nconsents\n${UNTIL_DAY}\n5\n` })
  assert.equal(jsonMode.code, 3, jsonMode.stderr)
  assert.equal(json(jsonMode).reason, 'consent confirmation impossible')
  assert.equal(json(jsonMode).consent.scope.scriptMatch.matched, false)
  assert.match(jsonMode.stderr, /NOT A READING OF THE CONSENT SCRIPT/)
  assert.match(jsonMode.stderr, /script\s+"I consent to talking head/)
  assert.match(jsonMode.stderr, /missing\s+\S/)
  // The transcript answer alone is wrong; every later answer is right: not confirmed.
  const noMatch = await mandate(args(), { lp, tty: true, input: `yes\nconsents\n${UNTIL_DAY}\n5\nanywhere\n` })
  assert.equal(noMatch.code, 3, noMatch.stdout)
  // The meaning answer alone is wrong.
  const noMeaning = await mandate(args(), { lp, tty: true, input: `matches\nmatches\n${UNTIL_DAY}\n5\nanywhere\n` })
  assert.equal(noMeaning.code, 3, noMeaning.stdout)
  // An unchecked term alone is wrong.
  const noDate = await mandate(args(), { lp, tty: true, input: `matches\nconsents\n${DAY_AFTER_UNTIL}\n5\nanywhere\n` })
  assert.equal(noDate.code, 3, noDate.stdout)
  // No answers at all (end of input): not confirmed.
  assert.equal((await mandate(args(), { lp, tty: true })).code, 3)
  assert.equal(publishes(grantor), before)

  const ok = await mandate(args(), { lp, tty: true, input: `matches\nconsents\n${UNTIL_DAY}\n5\nanywhere\n` })
  assert.equal(ok.code, 0, ok.stdout)
  assert.match(ok.stdout, new RegExp(`NOT CHECKED against the words — valid until ${UNTIL_DAY}`))
  assert.match(ok.stdout, /spend ceiling \$5/)
  assert.match(ok.stdout, /territory ANYWHERE/)
  assert.match(ok.stdout, /consent clip not attached/)
  assert.equal(publishes(grantor), before + 1)
  assert.ok(!lastGrantQuads().some(q => /consentClipSha256/.test(q.predicate)))
})

test('R18: --force never publishes past a failed transcription or a clip with no first-person consent', async () => {
  const before = publishes(grantor)
  const answers = `matches\n${new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10)}\n5\nanywhere\n`
  // A territory, so --json does not stop before capture on the unrestricted-territory question.
  const asrFailed = await mandate(consentGrant({ subject: 'dan', force: true, territory: 'GB' }), {
    lp: consentLp('', { asr: { structured: { ok: false, error: 'model unavailable' } } }), tty: true, input: answers,
  })
  assert.equal(asrFailed.code, 3, asrFailed.stderr)
  assert.match(json(asrFailed).consent.asrError, /model unavailable/)

  // Every typed answer a hand confirmation would need is given: still refused, because nobody said "I consent".
  const reported = await mandate(consentGrant({ subject: 'dan', force: true, json: null }), {
    lp: consentLp('She said she consents to a talking head video for advertising.'), tty: true,
    input: `matches\nconsents\n${new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10)}\n5\nanywhere\n`,
  })
  assert.equal(reported.code, 3, reported.stdout)
  assert.match(reported.stdout, /NO CONSENT SAID/)
  assert.equal(publishes(grantor), before)
})

test('item 11: a grant forced past unheard terms is published without the clip hash, so it never looks checked', async () => {
  const lp = consentLp('I consent to a talking head video of me.')
  const date = new Date(Date.now() + 90 * 864e5).toISOString().slice(0, 10)
  const before = publishes(grantor)
  // Without --force the unheard terms stop it before any question is asked.
  const unforced = await mandate(consentGrant({ subject: 'eve', territory: 'GB', json: null }), { lp, tty: true, input: `matches\nconsents\n${date}\n5\n` })
  assert.equal(unforced.code, 3, unforced.stdout)
  assert.match(unforced.stdout, /Not heard: .*advertising/)
  assert.equal(publishes(grantor), before)
  const r = await mandate(consentGrant({ subject: 'eve', force: true, territory: 'GB', json: null }), { lp, tty: true, input: `matches\nconsents\n${date}\n5\n` })
  assert.equal(r.code, 0, r.stdout)
  assert.match(r.stdout, /--force: the heuristics did not hear every requested term/)
  assert.match(r.stdout, /consent clip not attached .*clip sha256 [0-9a-f]{64}/)
  assert.equal(publishes(grantor), before + 1)
  assert.ok(!lastGrantQuads().some(q => /consentClipSha256/.test(q.predicate)))
})

test('D1: consent confirms only a reading of the script; anything else is exit 3 with the differences', async () => {
  const requested = { capability: ['talking-head'], useClass: ['advertising'], territory: ['GB'] }
  const args = ['consent', '--capability', 'talking-head', '--use-class', 'advertising', '--territory', 'GB', '--json']
  const ok = await mandate(args, { lp: consentLp(consentScript(requested)) })
  assert.equal(ok.code, 0, ok.stderr)
  assert.equal(json(ok).confirmed, true)
  const loose = await mandate(args, { lp: consentLp('I consent to a talking head video of me for advertising in the UK.') })
  assert.equal(loose.code, 3, loose.stderr)
  assert.equal(json(loose).confirmed, false)
  assert.match(loose.stderr, /NOT A READING OF THE CONSENT SCRIPT/)
  const contradicted = await mandate(args, { lp: consentLp(`${consentScript(requested)} But not for advertising.`) })
  assert.equal(contradicted.code, 8, contradicted.stderr)
})

test('harness: the fake Livepeer hook works through module.register too, the only hook API on the Node 22.13 floor', async () => {
  const requested = { capability: ['talking-head'], useClass: ['advertising'], territory: ['GB'] }
  const args = ['consent', '--capability', 'talking-head', '--use-class', 'advertising', '--territory', 'GB', '--json']
  // The deprecation warning module.register prints on Node 26 is not what is checked here.
  for (const env of [{}, { MANDATE_TEST_HOOKS: 'register', NODE_NO_WARNINGS: '1' }]) {
    const r = await mandate(args, { lp: consentLp(consentScript(requested)), env })
    assert.equal(r.code, 0, `${JSON.stringify(env)}: ${r.stderr}`)
    assert.equal(json(r).confirmed, true)
    assert.ok(r.calls.length > 0, 'the fake client answered')
  }
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
  // Outcome unknown: 9, as for `record`, never 5 ("render failed"), which a script would read as not billed.
  assert.equal(lost.code, 9, lost.stdout)
  assert.equal(json(lost).outcome, 'unknown')
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
  // Retryable, not permanent: the retry below succeeds once the node shows the asset published.
  assert.equal(json(blocked).stage, 'resume-unverified')
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
  const id = json(first).derivationId
  const retry = await mandate(['record', '--pending', json(first).pending, '--json'])
  assert.equal(retry.code, 0, retry.stdout)
  assert.equal(json(retry).derivation.name, name)
  assert.equal(json(retry).derivation.id, id)
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
  // A fixed-unit list price is a usable estimate.
  const fixed = { estimateUsd: 0.5, estimateSource: 'static list price', priceUnit: 'request' }
  store().save({ ...other, ...fixed, status: 'submitted', jobId: 'mjob_ora00001' })
  const over = await mandate(dry)
  assert.equal(over.code, 2)
  assert.equal(json(over).decision.clause, 'spend-ceiling')
  assert.equal(json(over).localPending.length, 1)
  assert.equal(json(over).localPending[0].billedUsd, 0.5)
  // Billed media not yet anchored counts too.
  store().save({ ...other, ...fixed, status: 'rendered', mediaUrl: mediaUrl('out-ora.mp4') }, { allowResolve: true })
  const rendered = await mandate(dry)
  assert.equal(rendered.code, 2, rendered.stdout)
  assert.equal(json(rendered).localPending[0].status, 'rendered')
  store().save({ ...other, status: 'dispatching', estimateUsd: null }, { allowResolve: true })
  const unknown = await mandate(dry)
  assert.equal(unknown.code, 2)
  assert.match(json(unknown).decision.reason, /unknown/)
  // Whatever its status says, a record that may be billed counts.
  store().save({ ...other, status: 'failed', mayHaveStarted: true }, { allowResolve: true })
  assert.equal((await mandate(dry)).code, 2)
  store().save({ ...other, status: 'failed', mayHaveStarted: false }, { allowResolve: true })
  assert.equal((await mandate(dry)).code, 0)
})

test('item 12: a pending estimate the operator shrank with --seconds is not trusted as the amount', async () => {
  const g = await newGrant('oto', { 'max-spend': '1' })
  const dry = renderArgs({ subject: `${ANA}:oto`, seconds: '1' })
  const other = { key: `mandate-${'2'.repeat(32)}`, capability: 'talking-head', grantId: g.id, createdAt: new Date().toISOString(), status: 'rendered', mediaUrl: mediaUrl('out-oto.mp4') }
  // A 1-second estimate of a per-second render, with no platform cost: unknown, which refuses under the ceiling.
  store().save({ ...other, estimateUsd: 0.168, estimateSource: 'static list price', priceUnit: 'second', costUsdEstimated: null })
  const shrunk = await mandate(dry)
  assert.equal(shrunk.code, 2, shrunk.stdout)
  assert.equal(json(shrunk).localPending[0].billedUsd, null)
  // A known cost smaller than the estimate: the larger counts.
  store().save({ ...other, estimateUsd: 0.9, estimateSource: 'static list price', priceUnit: 'second', costUsdEstimated: 0.1 })
  assert.equal(json(await mandate(dry)).localPending[0].billedUsd, 0.9)
  store().save({ ...other, status: 'recorded' })
})

test('D3: a possibly-billed render rerun that then fails cleanly stays unknown, keeps its key and history, and keeps counting', async () => {
  const g = await newGrant('vaa', { 'max-spend': '1' })
  const lost = await mandate(execArgs('vaa'), { lp: renderLp('vaa', { 'run_capability:talking-head': { throw: 'Request timed out' } }) })
  assert.equal(lost.code, 9, lost.stdout)
  const key = json(lost).pending
  const firstKey = lost.calls.find(x => x.name === 'run_capability:talking-head').args.idempotency_key
  const again = await mandate(execArgs('vaa'), { lp: renderLp('vaa', { 'run_capability:talking-head': { structured: { ok: false, error: 'insufficient credits' } } }) })
  assert.equal(again.code, 9, again.stdout)
  assert.equal(json(again).outcome, 'unknown')
  assert.equal(again.calls.find(x => x.name === 'run_capability:talking-head').args.idempotency_key, firstKey)
  const rec = store().load(key)
  assert.equal(rec.status, 'submitted')
  assert.equal(rec.mayHaveStarted, true)
  assert.equal(rec.attempts.length, 2)
  assert.equal(rec.idempotencyKey, firstKey)
  // Still counted, and still unknown to record.
  const other = await mandate(renderArgs({ subject: `${ANA}:vaa`, seconds: '1' }))
  assert.equal(other.code, 2, other.stdout)
  assert.equal(json(other).localPending.length, 1)
  assert.equal((await mandate(['record', '--pending', key, '--json'])).code, 9)
  // A spend-cap refusal on a further rerun does not erase it either.
  const capped = await mandate(execArgs('vaa'), { lp: renderLp('vaa', { spend_cap: { structured: { remaining_usd: 0.0001 } } }) })
  // The earlier attempt's outcome is still unknown, so this is 9 (unknown), not 10 (payment, nothing billed).
  assert.equal(capped.code, 9, capped.stdout)
  assert.equal(json(capped).outcome, 'unknown')
  assert.ok(!capped.calls.some(x => x.name.startsWith('run_capability')))
  const cappedText = await mandate(execArgs('vaa', { json: null }), { lp: renderLp('vaa', { spend_cap: { structured: { remaining_usd: 0.0001 } } }) })
  assert.equal(cappedText.code, 9, cappedText.stdout)
  assert.match(cappedText.stdout, /OUTCOME UNKNOWN/)
  assert.equal(store().load(key).status, 'submitted')
  assert.equal(store().load(key).attempts.length, 4)
  // With no earlier attempt open, the same cap is a plain payment refusal: 10.
  await newGrant('vak')
  const fresh = await mandate(execArgs('vak'), { lp: renderLp('vak', { spend_cap: { structured: { remaining_usd: 0.0001 } } }) })
  assert.equal(fresh.code, 10, fresh.stdout)
  assert.equal(json(fresh).outcome, 'failed')
  assert.ok(!fresh.calls.some(x => x.name.startsWith('run_capability')))
})

test('D3: a rerun without --idempotency-key reuses the key a possibly-billed render was sent with; a different key is refused before sending', async () => {
  await newGrant('vac')
  const lost = await mandate(execArgs('vac', { 'idempotency-key': 'custom-key-1' }), { lp: renderLp('vac', { 'run_capability:talking-head': { throw: 'Request timed out' } }) })
  const key = json(lost).pending
  assert.equal(store().load(key).idempotencyKey, 'custom-key-1')
  const other = await mandate(execArgs('vac', { 'idempotency-key': 'custom-key-2' }), { lp: renderLp('vac') })
  assert.equal(other.code, 1, other.stdout)
  assert.match(json(other).error, /custom-key-1/)
  assert.ok(!other.calls.some(x => x.name.startsWith('run_capability')))
  const again = await mandate(execArgs('vac'), { lp: renderLp('vac') })
  assert.equal(again.code, 0, again.stdout)
  assert.deepEqual(again.calls.filter(x => x.name === 'run_capability:talking-head').map(x => x.args.idempotency_key), ['custom-key-1'])
})

test('D3: a crashed legacy dispatching record is resumed under its own key and never downgraded; a live dispatch is not touched', async () => {
  const g = await newGrant('vaf', { 'max-spend': '1' })
  const key = keyFor(g.id)
  store().save({ key, idempotencyKey: key, status: 'dispatching', createdAt: new Date().toISOString(), subject: g.subject, capability: 'talking-head', grantId: g.id, estimateUsd: 0.84 })
  const again = await mandate(execArgs('vaf'), { lp: renderLp('vaf', { 'run_capability:talking-head': { structured: { ok: false, error: 'bad input' }, isError: true } }) })
  assert.equal(again.code, 9, again.stdout)
  assert.equal(again.calls.find(x => x.name === 'run_capability:talking-head').args.idempotency_key, key)
  assert.equal(store().load(key).status, 'submitted')

  const g2 = await newGrant('vag')
  const key2 = keyFor(g2.id)
  // Another process that is still alive (this test runner) is dispatching it, holding the key's lease as every dispatch does.
  store().save({ key: key2, idempotencyKey: key2, status: 'dispatching', createdAt: new Date().toISOString(), capability: 'talking-head', grantId: g2.id, attempts: [{ n: 1, pid: process.pid, startedAt: new Date().toISOString(), sentAt: new Date().toISOString() }] })
  const holder = store()
  const lease = holder.acquireLease(key2)
  try {
    const live = await mandate(execArgs('vag'), { lp: renderLp('vag') })
    assert.equal(live.code, 5, live.stdout)
    assert.equal(json(live).inFlight, true)
    assert.ok(!live.calls.some(x => x.name.startsWith('run_capability')))
  } finally {
    lease.release()
  }
  // With no lease held, the same live pid on the unfinished attempt is a crashed run's pid now
  // used by an unrelated process: the rerun takes the lease and resumes it under its own key.
  const resumed = await mandate(execArgs('vag'), { lp: renderLp('vag') })
  assert.equal(resumed.code, 0, resumed.stdout)
  assert.deepEqual(resumed.calls.filter(x => x.name === 'run_capability:talking-head').map(x => x.args.idempotency_key), [key2])
  assert.equal(store().load(key2).status, 'recorded')
})

test('an unreadable pending record is exit 9 naming the file, not a usage error', async () => {
  await newGrant('vae')
  mkdirSync(pendingDir(), { recursive: true })
  const bad = join(pendingDir(), `mandate-${'7'.repeat(32)}.json`)
  writeFileSync(bad, '{ not json')
  try {
    const r = await mandate(renderArgs({ subject: `${ANA}:vae` }))
    assert.equal(r.code, 9, r.stdout)
    assert.match(json(r).error, /mandate-7{32}\.json/)
    assert.match(json(r).file, /mandate-7{32}\.json/)
  } finally {
    rmSync(bad)
  }
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

test('APP-2: node text is stripped of control characters before printing, and a forged confirmed UAL is never printed', async () => {
  grantor.scenario.ualSuffix = `${ESC}[2J${ESC}[32mFORGED`
  grantor.scenario.txHash = `0x${'ab'.repeat(32)}${ESC}[2J`
  try {
    // A confirmed answer whose UAL is not chain-confirmed in shape is never
    // taken at its word: it is reconciled from the node's records, so the
    // forged suffix never reaches output at all.
    const r = await mandate(grantArgs({ subject: 'rex', json: null }))
    assert.equal(r.code, 0, r.stderr)
    assert.ok(!r.stdout.includes(ESC))
    assert.doesNotMatch(r.stdout, /FORGED/)
    assert.match(r.stdout, /UAL\s+did:dkg:base:84532\/0x[0-9a-f]{40}\/\d+\n/)
    // An unbound answer is reported from the node's own words: its error text
    // reaches output stripped of control characters, and a UAL or tx hash that
    // is not printable is dropped rather than printed.
    grantor.scenario.publish = 'unbound'
    grantor.scenario.unboundError = `${ESC}[2J${ESC}[31mFORGED binding`
    const u = await mandate(grantArgs({ subject: 'rex-unbound', json: null }))
    assert.equal(u.code, 7, u.stdout)
    assert.ok(!u.stdout.includes(ESC))
    assert.match(u.stdout, /FORGED binding/)
    const uj = await mandate(grantArgs({ subject: 'rex-unbound-json' }))
    assert.equal(uj.code, 7, uj.stdout)
    assert.ok(!uj.stdout.includes('\\u001b'), uj.stdout)
    assert.match(json(uj).error, /FORGED binding/)
    assert.equal(json(uj).ual, null)
    assert.equal(json(uj).txHash, null)
  } finally {
    delete grantor.scenario.ualSuffix
    delete grantor.scenario.txHash
    delete grantor.scenario.publish
    delete grantor.scenario.unboundError
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

/* Derivation retries, lost grant and revocation replies, exit codes, node scripts */

const sha = s => createHash('sha256').update(s).digest('hex')

/** A rendered, unrecorded record whose last derivation attempt is `attempt`, and the asset it names. */
function stuckRender(g, tag, attempt, { descriptor = null, extra = {} } = {}) {
  const key = `mandate-${sha(tag).slice(0, 32)}`
  const h = sha(`bytes of /out-${tag}.mp4`)
  const nonce = sha(`nonce ${tag}`).slice(0, 16)
  const name = `derivation-${h.slice(0, 16)}-${nonce}`
  const id = `urn:mandate:derivation:${h.slice(0, 16)}:${nonce}`
  if (descriptor) producer.assets.set(name, { quads: [], cg: DERIVS_CG, descriptor: { agentAddress: PRODUCER, ...descriptor } })
  store().save({
    key, idempotencyKey: key, status: 'rendered', createdAt: new Date().toISOString(), capability: 'talking-head', grantId: g.id,
    mediaUrl: mediaUrl(`out-${tag}.mp4`), jobId: null, costUsdEstimated: 0.5, derivationAttempt: { id, name, ual: null, txHash: null, stage: 'started', mayHaveSent: false, ...attempt }, ...extra,
  })
  return { key, name }
}
const assetCreates = (node, name) => node.calls.filter(x => x.method === 'POST' && x.path === '/api/knowledge-assets' && x.body.name === name).length

test('R3: a derivation publish that reported a transaction, or left no HTTP status, is never published again while the node shows it shared', async () => {
  const g = await newGrant('vad')
  const shared = { status: 'swm-shared', wmCurrentAssertion: '1'.repeat(64), swmCurrentAssertion: '1'.repeat(64) }
  const before = publishes(producer)
  // Even with a 4xx status saved, a reported transaction means it may have been sent.
  const withTx = stuckRender(g, 'vad-tx', { stage: 'publish', txHash: `0x${'cd'.repeat(32)}` }, { descriptor: shared, extra: { derivationPublishStatus: 409 } })
  const r1 = await mandate(['record', '--pending', withTx.key, '--json'])
  assert.equal(r1.code, 4, r1.stdout)
  assert.equal(json(r1).stage, 'resume-unverified')
  // An older `publish` attempt with no status kept: it may have followed a broadcast (a 500).
  const legacy = stuckRender(g, 'vad-legacy', { stage: 'publish' }, { descriptor: shared })
  const r2 = await mandate(['record', '--pending', legacy.key, '--json'])
  assert.equal(r2.code, 4, r2.stdout)
  assert.equal(json(r2).stage, 'resume-unverified')
  assert.equal(publishes(producer), before)
})

test('a published derivation whose _meta record the node does not show yet is retryable, and verified without publishing once it shows', async () => {
  const g = await newGrant('vam')
  const before = publishes(producer)
  const published = { status: 'vm-confirmed', state: 'published', publishedUal: `did:dkg:base:84532/${PRODUCER.toLowerCase()}/987654`, vmCurrentAssertion: '1'.repeat(64) }
  const stuck = stuckRender(g, 'vam', { stage: 'publish' }, { descriptor: published })
  // The node says published but its _meta graph has no record of the UAL: not a refusal, a wait.
  const r1 = await mandate(['record', '--pending', stuck.key, '--json'])
  assert.equal(r1.code, 4, r1.stdout)
  assert.equal(json(r1).stage, 'resume-unverified')
  assert.notEqual(store().load(stuck.key).derivationAttempt.stage, 'resume-refused')
  const text = await mandate(['record', '--pending', stuck.key])
  assert.equal(text.code, 4, text.stdout)
  assert.doesNotMatch(text.stdout, /will never publish this asset again/)
  assert.match(text.stdout, /retry it once the node shows the asset published/)
  // Once the chain record lands, the same attempt is verified, never published again.
  // (The fixture asset has no content, so its anchor is taken out again for the later tests.)
  const landed = producer.confirm(stuck.name)
  let r2
  try {
    r2 = await mandate(['record', '--pending', stuck.key, '--json'])
  } finally {
    world[DERIVS_CG].kas.splice(world[DERIVS_CG].kas.indexOf(landed), 1)
  }
  assert.equal(r2.code, 0, r2.stdout)
  assert.equal(json(r2).derivation.resumed, true)
  assert.equal(publishes(producer), before)
  assert.equal(assetCreates(producer, stuck.name), 0)
})

test('R3: a derivation publish refused with 4xx sent nothing, so the retry publishes the same asset', async () => {
  await newGrant('vah')
  producer.scenario.publish = 'refused'
  let first
  try {
    first = await mandate(execArgs('vah'), { lp: renderLp('vah') })
  } finally {
    delete producer.scenario.publish
  }
  assert.equal(first.code, 4, first.stdout)
  assert.equal(json(first).stage, 'publish')
  assert.equal(json(first).mayHaveSent, false)
  assert.equal(store().load(json(first).pending).derivationPublishStatus, 409)
  const retry = await mandate(['record', '--pending', json(first).pending, '--json'])
  assert.equal(retry.code, 0, retry.stdout)
  assert.equal(json(retry).derivation.name, json(first).asset)
  assert.equal(json(retry).derivation.resumed, true)
})

test('R3: an unbound attempt is never continued, even if the node later shows it sealed; a possibly-sent attempt with no asset is not recreated', async () => {
  const g = await newGrant('vai')
  const before = publishes(producer)
  const unbound = stuckRender(g, 'vai-unbound', { stage: 'unbound', ual: `did:dkg:base:84532/${PRODUCER}/999` }, { descriptor: { status: 'wm-sealed', wmCurrentAssertion: '1'.repeat(64) } })
  const r1 = await mandate(['record', '--pending', unbound.key, '--json'])
  assert.equal(r1.code, 4, r1.stdout)
  assert.equal(json(r1).stage, 'resume-refused')
  assert.match(r1.stdout, /never publish this asset again|resume-refused/)
  const text = await mandate(['record', '--pending', unbound.key])
  assert.match(text.stdout, /will never publish this asset again/)
  const sent = stuckRender(g, 'vai-sent', { stage: 'publish-transport', mayHaveSent: true })
  const r2 = await mandate(['record', '--pending', sent.key, '--json'])
  assert.equal(r2.code, 4, r2.stdout)
  assert.equal(json(r2).stage, 'resume-unverified')
  assert.match(json(r2).error, /no such asset/)
  assert.equal(assetCreates(producer, sent.name), 0)
  assert.equal(publishes(producer), before)
})

test('D5: a grant whose publish reply is lost reports its grant id and asset, and the same id is revocable once it lands', async () => {
  grantor.scenario.publish = 'lost'
  let first
  try {
    first = await mandate(grantArgs({ subject: 'vv5' }))
  } finally {
    delete grantor.scenario.publish
  }
  assert.equal(first.code, 7, first.stdout)
  const out = json(first)
  assert.equal(out.outcome, 'unknown')
  assert.equal(out.mayHaveSent, true)
  assert.match(out.grantId, new RegExp(`^urn:mandate:grant:${ANA}:vv5:[0-9a-f]{16}$`))
  assert.match(out.assetName, /^grant-vv5-[0-9a-f]{16}$/)
  // The check only reads, and never revokes a grant that has landed.
  assert.equal(out.check, `mandate blast-radius --grant ${out.grantId}`)
  const checkArgs = [...out.check.split(' ').slice(1), '--json']
  const publishedBefore = publishes(grantor) + publishes(producer)
  // Not landed yet: the check says so and publishes nothing.
  const early = await mandate(checkArgs)
  assert.equal(early.code, 0, early.stdout)
  assert.equal(json(early).grant, null)
  // The chain confirms it later: the check shows it live, still publishing nothing.
  grantor.confirm(out.assetName)
  const landed = await mandate(checkArgs)
  assert.equal(landed.code, 0, landed.stdout)
  assert.equal(json(landed).grant.id, out.grantId)
  assert.equal(json(landed).revoked, false)
  assert.equal(publishes(grantor) + publishes(producer), publishedBefore)
  // The follow-up revokes the same id, and renders refuse.
  const rv = await mandate(['revoke', '--id', out.grantId, '--yes', '--json'])
  assert.equal(rv.code, 0, rv.stdout)
  assert.equal(json(rv).revoked, true)
  const r = await mandate(renderArgs({ subject: `${ANA}:vv5` }))
  assert.equal(r.code, 2, r.stdout)
})

test('D5: the human output of a lost grant names the id, the asset and how to check it', async () => {
  grantor.scenario.publish = 'lost'
  let r
  try {
    r = await mandate(grantArgs({ subject: 'vv7', json: null }))
  } finally {
    delete grantor.scenario.publish
  }
  assert.equal(r.code, 7, r.stderr)
  assert.match(r.stdout, /GRANT OUTCOME UNKNOWN/)
  assert.match(r.stdout, new RegExp(`grantId\\s+urn:mandate:grant:${ANA}:vv7:[0-9a-f]{16}`))
  assert.match(r.stdout, /asset\s+grant-vv7-[0-9a-f]{16}/)
  assert.match(r.stdout, /Check whether it landed: mandate blast-radius --grant urn:mandate:grant:/)
  assert.doesNotMatch(r.stdout, /Check whether it landed: mandate revoke/)
  assert.match(r.stdout, /To end a grant that landed, run `mandate revoke --id urn:mandate:grant:/)
})

test('D5: a revocation whose publish reply is lost reports the grant id, state id and asset, and a check finds it once it lands', async () => {
  const g = await newGrant('vv8')
  grantor.scenario.publish = 'lost'
  let first
  try {
    first = await mandate(['revoke', '--id', g.id, '--yes', '--json'])
  } finally {
    delete grantor.scenario.publish
  }
  assert.equal(first.code, 7, first.stdout)
  const out = json(first)
  assert.equal(out.outcome, 'unknown')
  assert.equal(out.grantId, g.id)
  assert.match(out.stateId, /^urn:mandate:state:[0-9a-f]{16}$/)
  assert.match(out.assetName, /^revoke-vv8-[0-9a-f]{16}$/)
  assert.equal(out.check, `mandate blast-radius --grant ${g.id}`)
  const before = publishes(grantor)
  const notYet = await mandate([...out.check.split(' ').slice(1), '--json'])
  assert.equal(notYet.code, 0, notYet.stdout)
  assert.equal(json(notYet).revoked, false)
  grantor.confirm(out.assetName)
  const landed = await mandate([...out.check.split(' ').slice(1), '--json'])
  assert.equal(json(landed).revoked, true)
  assert.equal(publishes(grantor), before)
  const again = await mandate(['revoke', '--id', g.id, '--yes', '--json'])
  assert.equal(again.code, 0, again.stdout)
  assert.equal(json(again).alreadyRevoked, true)
})

test('render --at with --execute is refused before anything is resolved or dispatched', async () => {
  await newGrant('wat')
  const r = await mandate(execArgs('wat', { at: '2026-09-13T00:00:00Z' }), { lp: renderLp('wat') })
  assert.equal(r.code, 1, r.stdout)
  assert.match(json(r).error, /dry runs only/)
  assert.deepEqual(r.calls, [])
})

test('exit codes: the built-in help, README and CONTRACTS name the same codes, and help says what each covers', () => {
  const byCode = Object.fromEntries(EXIT_HELP)
  assert.match(byCode[3], /not a reading of the consent script/)
  assert.match(byCode[3], /--json/)
  assert.match(byCode[1], /off a terminal or with --json and no --yes/)
  assert.match(byCode[4], /unbound, resume-refused and the retryable resume-unverified/)
  assert.match(byCode[5], /already submitted/)
  assert.match(byCode[7], /unknown after send/)
  assert.match(byCode[9], /outcome is unknown/)
  assert.match(byCode[9], /stale/)
  assert.match(byCode[9], /pending file/)
  for (const doc of ['../README.md', '../docs/CONTRACTS.md']) {
    const text = readFileSync(new URL(doc, import.meta.url), 'utf8')
    for (const [code] of EXIT_HELP) assert.match(text, new RegExp(`^\\| ${code} \\|`, 'm'), `${doc} has a row for exit ${code}`)
  }
})

test('nodes.mjs: a reconcile reply with a null head or watermark is never current; doctor and sync exit 9', async () => {
  const odd = await startFakeDkg({ address: ANA_CHECKSUM, name: 'grantor', world, scenario: { reconcile: { headOrdinal: null } } })
  try {
    const env = { MANDATE_GRANTOR_HOME: homes.grantor, MANDATE_GRANTOR_PORT: String(odd.port) }
    const doctor = await mandate(['doctor', 'grantor'], { bin: NODES, env })
    assert.equal(doctor.code, 9, doctor.stdout + doctor.stderr)
    assert.match(doctor.stdout, /freshness unknown/)
    assert.doesNotMatch(doctor.stdout, /current \d/)
    odd.scenario.reconcile = { headOrdinal: null, watermarkAfter: null }
    const sync = await mandate(['sync', 'grantor'], { bin: NODES, env })
    assert.equal(sync.code, 9, sync.stdout + sync.stderr)
    assert.match(sync.stdout, /freshness unknown/)
    assert.doesNotMatch(sync.stdout, /: current/)
    // A real reply is still current, exit 0.
    delete odd.scenario.reconcile
    const fine = await mandate(['sync', 'grantor'], { bin: NODES, env })
    assert.equal(fine.code, 0, fine.stdout + fine.stderr)
    assert.match(fine.stdout, /: current \(\d+\/\d+\)/)
  } finally {
    await odd.close()
  }
})

test('R16: nodes.mjs up stops after starting the nodes, with exit 0 and no subscribe, while graph ids are placeholders', async () => {
  const home = join(work, 'dkg-up-grantor')
  const env = { MANDATE_GRANTS_CG: '0x<grantor agent address>/mandate-grants', MANDATE_DERIVATIONS_CG: '', MANDATE_GRANTOR_HOME: home }
  const before = grantor.calls.length
  const up = await mandate(['up', 'grantor'], { bin: NODES, env })
  assert.equal(up.code, 0, up.stdout + up.stderr)
  assert.match(up.stdout, /already running/)
  assert.match(up.stdout, /do not hold graph ids yet/)
  assert.ok(!grantor.calls.slice(before).some(x => /subscri|reconcile|connect/.test(x.path)))
})

test('item 15: the demo blast-radius line uses the CLI label and names unreadable records; the integration test decides at a fixed time', () => {
  const line = blastLine({ exitCode: 0, result: { assets: [{}], billedUnknown: false, totalBilledUsd: 0.84, unreadable: 2 } })
  assert.match(line, /as recorded by producers; not an invoice/)
  assert.doesNotMatch(line, /list price/)
  assert.match(line, /2 trusted record\(s\) under the grant UNREADABLE/)
  assert.doesNotMatch(blastLine({ result: { assets: [], billedUnknown: true, unreadable: 0 } }), /UNREADABLE/)
  const demo = readFileSync(new URL('../demo/full.mjs', import.meta.url), 'utf8')
  assert.match(demo, /if \(blast\.exitCode !== 0\) fail\('blast radius', blast\)/)
  const s6c = readFileSync(new URL('./integration/s6c.test.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(s6c, /at: new Date\(\)/)
  const at = s6c.match(/const DECIDE_AT = '([^']+)'/)?.[1]
  assert.ok(at && Date.parse(at) < Date.parse('2026-12-12T15:42:18Z'), 'the decision time is inside G2\'s validity window')
})

test('D3: a render that dies mid-dispatch is marked sent, so a rerun replays it under the key it was sent with', async () => {
  await newGrant('vaj')
  const crashed = await mandate(execArgs('vaj', { 'idempotency-key': 'custom-hang-1' }), { lp: renderLp('vaj', { 'run_capability:talking-head': { hang: true } }) })
  assert.notEqual(crashed.code, 0)
  assert.ok(crashed.calls.some(x => x.name === 'run_capability:talking-head'))
  const key = keyFor(store().list().find(r => r.idempotencyKey === 'custom-hang-1').grantId)
  const rec = store().load(key)
  assert.equal(rec.status, 'dispatching')
  assert.ok(rec.attempts.at(-1).sentAt)
  const again = await mandate(execArgs('vaj'), { lp: renderLp('vaj') })
  assert.equal(again.code, 0, again.stdout)
  assert.deepEqual(again.calls.filter(x => x.name === 'run_capability:talking-head').map(x => x.args.idempotency_key), ['custom-hang-1'])
})

/* Round three: derivation retries after an outage or a crash, settled jobs, unknown serving capability, doctor */

const deadPort = async () => {
  const s = createServer()
  await new Promise(r => s.listen(0, '127.0.0.1', r))
  const { port } = s.address()
  await new Promise(r => s.close(r))
  return port
}

test('R3: a retry that fails before reaching the node never erases a permanent stage or a saved publish status', async () => {
  const g = await newGrant('vxa')
  const before = publishes(producer)
  const unbound = stuckRender(g, 'vxa-unbound', { stage: 'unbound', ual: `did:dkg:base:84532/${PRODUCER}/998`, txHash: `0x${'ef'.repeat(32)}`, mayHaveSent: true }, { descriptor: { status: 'wm-sealed', wmCurrentAssertion: '1'.repeat(64) } })
  const down = await mandate(['record', '--pending', unbound.key, '--json'], { env: { MANDATE_PRODUCER_PORT: String(await deadPort()) } })
  assert.equal(down.code, 4, down.stdout)
  const kept = store().load(unbound.key).derivationAttempt
  assert.equal(kept.stage, 'unbound')
  assert.equal(kept.lastErrorStage, 'error')
  assert.equal(kept.mayHaveSent, true)
  const downText = await mandate(['record', '--pending', unbound.key], { env: { MANDATE_PRODUCER_PORT: String(await deadPort()) } })
  assert.match(downText.stdout, /will never publish this asset again/)
  // The node is back and shows the asset sealed: still never published again.
  const back = await mandate(['record', '--pending', unbound.key, '--json'])
  assert.equal(back.code, 4, back.stdout)
  assert.equal(json(back).stage, 'resume-refused')
  assert.equal(publishes(producer), before)

  // A publish refused with 4xx keeps that status through an outage, so the retry still continues it.
  producer.scenario.publish = 'refused'
  let first
  try {
    first = await mandate(execArgs('vxa'), { lp: renderLp('vxa') })
  } finally {
    delete producer.scenario.publish
  }
  assert.equal(first.code, 4, first.stdout)
  const refused = { key: json(first).pending }
  assert.equal(store().load(refused.key).derivationPublishStatus, 409)
  const down2 = await mandate(['record', '--pending', refused.key, '--json'], { env: { MANDATE_PRODUCER_PORT: String(await deadPort()) } })
  assert.equal(down2.code, 4, down2.stdout)
  assert.equal(store().load(refused.key).derivationAttempt.stage, 'publish')
  assert.equal(store().load(refused.key).derivationPublishStatus, 409)
  const retry = await mandate(['record', '--pending', refused.key, '--json'])
  assert.equal(retry.code, 0, retry.stdout)
  assert.equal(json(retry).derivation.resumed, true)
  // One refused publish on the first run, one on the retry: none during the outage.
  assert.equal(publishes(producer), before + 2)
})

test('R3: a resumed derivation attempt is marked in flight before vm/publish, so a crash mid-publish is never published again', async () => {
  const g = await newGrant('vxb')
  const shared = { status: 'swm-shared', wmCurrentAssertion: '1'.repeat(64), swmCurrentAssertion: '1'.repeat(64) }
  for (const [tag, attempt, extra] of [['vxb-share', { stage: 'share' }, {}], ['vxb-409', { stage: 'publish' }, { derivationPublishStatus: 409 }]]) {
    const stuck = stuckRender(g, tag, attempt, { descriptor: shared, extra })
    const file = join(pendingDir(), `${stuck.key}.json`)
    // What is on disk when vm/publish arrives is what a crash at that moment leaves.
    let atPublish = null
    const push = producer.calls.push
    producer.calls.push = function (x) {
      if (x.method === 'POST' && x.path?.endsWith('/vm/publish') && atPublish === null) atPublish = readFileSync(file, 'utf8')
      return push.call(this, x)
    }
    producer.scenario.publish = 'refused'
    try {
      await mandate(['record', '--pending', stuck.key, '--json'])
    } finally {
      producer.calls.push = push
      delete producer.scenario.publish
    }
    assert.ok(atPublish, `${tag}: the resume called vm/publish`)
    const onDisk = JSON.parse(atPublish)
    assert.equal(onDisk.derivationAttempt.stage, 'started', tag)
    assert.equal(onDisk.derivationPublishStatus, null, tag)
    // The process died there; the node still shows the asset shared, its transaction unknown.
    writeFileSync(file, atPublish)
    const before = publishes(producer)
    const retry = await mandate(['record', '--pending', stuck.key, '--json'])
    assert.equal(retry.code, 4, `${tag}: ${retry.stdout}`)
    assert.equal(json(retry).stage, 'resume-unverified', tag)
    assert.equal(publishes(producer), before, tag)
  }
})

test('D3: a job the platform reports failed is settled by record, stops counting, keeps its history, and can be rendered again', async () => {
  const g = await newGrant('vxc', { 'max-spend': '1' })
  const key = keyFor(g.id)
  const attempts = [{ n: 1, pid: 999_999_010, startedAt: new Date().toISOString(), sentAt: new Date().toISOString(), idempotencyKey: key, endedAt: new Date().toISOString(), status: 'submitted', jobId: 'mjob_vxcfail01', mayHaveStarted: true }]
  const base = { key, idempotencyKey: key, status: 'submitted', jobId: 'mjob_vxcfail01', mayHaveStarted: true, createdAt: new Date().toISOString(), subject: g.subject, capability: 'talking-head', grantId: g.id, estimateUsd: 0.84, estimateSource: 'static list price', priceUnit: 'second', inputs: { image_url: mediaUrl('in.jpg'), audio_url: mediaUrl('in.wav') }, attempts }
  store().save(base)
  // Counted while unresolved: a dry run of another request under the grant refuses on the ceiling.
  const blocked = await mandate(renderArgs({ subject: `${ANA}:vxc`, seconds: '1' }))
  assert.equal(blocked.code, 2, blocked.stdout)
  // A status that is not a certain failure settles nothing.
  const odd = await mandate(['record', '--pending', key, '--json'], { lp: { get_create_media: { structured: { status: 'mystery' } } } })
  assert.equal(odd.code, 9, odd.stdout)
  assert.equal(store().load(key).status, 'submitted')
  // A reply about another job settles nothing either.
  const otherJob = await mandate(['record', '--pending', key, '--json'], { lp: { get_create_media: { structured: { status: 'failed', job_id: 'mjob_someoneelse', error: 'x' } } } })
  assert.notEqual(otherJob.code, 0)
  assert.equal(store().load(key).status, 'submitted')
  // Nor a reply marked as an error whose status is not a failure.
  const flagged = await mandate(['record', '--pending', key, '--json'], { lp: { get_create_media: { structured: { status: 'done', url: mediaUrl('flagged.mp4') }, isError: true } } })
  assert.notEqual(flagged.code, 0)
  assert.equal(store().load(key).status, 'submitted')
  const r = await mandate(['record', '--pending', key, '--json'], { lp: { get_create_media: { structured: { status: 'failed', error: 'model crashed' } } } })
  assert.equal(r.code, 5, r.stdout)
  assert.equal(json(r).status, 'failed-confirmed')
  assert.equal(json(r).outcome, 'failed')
  const rec = store().load(key)
  assert.equal(rec.status, 'failed-confirmed')
  assert.equal(rec.attempts.length, 1)
  assert.equal(rec.jobId, 'mjob_vxcfail01')
  // Settled: record again asks nothing of Livepeer.
  const again = await mandate(['record', '--pending', key, '--json'], { lp: { get_create_media: { structured: { status: 'done', url: mediaUrl('never.mp4') } } } })
  assert.equal(again.code, 5, again.stdout)
  assert.deepEqual(again.calls, [])
  // No longer counted, and the same request renders again as a new attempt.
  const other = await mandate(renderArgs({ subject: `${ANA}:vxc`, seconds: '1' }))
  assert.equal(other.code, 0, other.stdout)
  assert.deepEqual(json(other).localPending, [])
  const rerun = await mandate(execArgs('vxc'), { lp: renderLp('vxc') })
  assert.equal(rerun.code, 0, rerun.stdout)
  assert.equal(store().load(key).status, 'recorded')
  assert.equal(store().load(key).attempts.length, 2)
})

test('a serving capability the platform names but that is not a capability is recorded as unknown, and no derivation is anchored', async () => {
  const g = await newGrant('vxd')
  const creates = () => producer.calls.filter(x => x.method === 'POST' && x.path === '/api/knowledge-assets').length
  const before = creates()
  const r = await mandate(execArgs('vxd'), { lp: renderLp('vxd', { 'run_capability:talking-head': { structured: { ok: true, status: 'done', url: mediaUrl('out-vxd.mp4'), capability_used: 'Flux Dev!', cost_usd_estimated: 0.84 } } }) })
  assert.equal(r.code, 4, r.stdout)
  assert.equal(json(r).stage, 'served-unknown')
  assert.equal(json(r).derivation, null)
  assert.doesNotMatch(r.stdout, /out-vxd\.mp4/)
  const rec = store().load(json(r).pending)
  assert.equal(rec.servedCapability, null)
  assert.equal(rec.servedCapabilityUnknown, true)
  assert.equal(rec.status, 'rendered')
  assert.equal(creates(), before)
  // A retry refuses the same way.
  const retry = await mandate(['record', '--pending', rec.key, '--json'])
  assert.equal(retry.code, 4, retry.stdout)
  assert.equal(creates(), before)

  // The same through record --pending for a background job.
  const key = `mandate-${sha('vxd-job').slice(0, 32)}`
  store().save({ key, idempotencyKey: key, status: 'submitted', jobId: 'mjob_vxdserved1', capability: 'talking-head', grantId: g.id, inputs: { image_url: mediaUrl('in.jpg') }, createdAt: new Date().toISOString() })
  const polled = await mandate(['record', '--pending', key, '--json'], { lp: { get_create_media: { structured: { status: 'done', url: mediaUrl('out-vxd-job.mp4'), capability_used: 'Flux Dev!' } } } })
  assert.equal(polled.code, 4, polled.stdout)
  assert.equal(json(polled).stage, 'served-unknown')
  assert.equal(store().load(key).servedCapability, null)
  assert.equal(creates(), before)
})

test('nodes.mjs doctor: subscriptions answering 403 still get the freshness check, and a node behind exits 9', async () => {
  let reconcile = { headOrdinal: 50, watermarkAfter: 1 }
  const stub = createServer((req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    req.resume()
    req.on('end', () => {
      if (req.url === '/api/agent/identity') return send(200, { agentAddress: ANA_CHECKSUM, agentDid: `did:dkg:agent:${ANA_CHECKSUM}` })
      if (req.url === '/api/info') return send(200, { peers: 1, version: '10.0.16', chain: { chainId: 'base:84532' } })
      if (req.url === '/api/context-graph/subscriptions') return send(403, { error: 'admin only' })
      if (req.url === '/api/context-graph/reconcile') return send(200, reconcile)
      send(404, { error: 'no route' })
    })
  })
  await new Promise(r => stub.listen(0, '127.0.0.1', r))
  try {
    const env = { MANDATE_GRANTOR_HOME: homes.grantor, MANDATE_GRANTOR_PORT: String(stub.address().port) }
    const behind = await mandate(['doctor', 'grantor'], { bin: NODES, env })
    assert.equal(behind.code, 9, behind.stdout + behind.stderr)
    assert.match(behind.stdout, /node-admin token/)
    assert.match(behind.stdout, /subscription unknown\s+BEHIND 1\/50/)
    reconcile = { headOrdinal: 5, watermarkAfter: 5 }
    const current = await mandate(['doctor', 'grantor'], { bin: NODES, env })
    assert.equal(current.code, 0, current.stdout + current.stderr)
    assert.match(current.stdout, /subscription unknown\s+current 5\/5/)
  } finally {
    stub.closeAllConnections?.()
    await new Promise(r => stub.close(r))
  }
})

/* ---------------------------------------------------------------------------
 * Round four: reviewing long transcripts, the spend-ceiling race, one process
 * per render key, clean reruns, trusted producers on record, the env file.
 * ------------------------------------------------------------------------- */

/** A proxy in front of the producer node that holds every vm/publish for `delayMs`, standing in for the chain wait. */
async function slowPublishProducer(delayMs) {
  const proxy = createServer((req, res) => {
    const go = () => {
      const up = httpRequest({ host: '127.0.0.1', port: producer.port, path: req.url, method: req.method, headers: req.headers }, ur => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res) })
      req.pipe(up)
    }
    if (req.method === 'POST' && req.url.endsWith('/vm/publish')) setTimeout(go, delayMs)
    else go()
  })
  await new Promise(r => proxy.listen(0, '127.0.0.1', r))
  return { env: { MANDATE_PRODUCER_PORT: String(proxy.address().port) }, close: () => { proxy.closeAllConnections?.(); proxy.close() } }
}
const creates = () => producer.calls.filter(x => x.method === 'POST' && x.path === '/api/knowledge-assets').length
const sleepMs = ms => new Promise(r => setTimeout(r, ms))

test('B2: a transcript a person must confirm is shown in full, and one too long to review is refused before any question', async () => {
  const tail = 'Actually, please delete this recording and my face, I have reconsidered all of it.'
  const opening = `I consent to talking head of my likeness for advertising in the UK until ${UNTIL_SPOKEN}. Spending is capped at 5 US dollars.`
  const args = consentGrant({ subject: 'cara', territory: 'GB', 'valid-until': until, json: null })
  const answers = `matches\nconsents\n${UNTIL_DAY}\n5\n`
  // Over the old 1200-character cut, with a control character and a line break inside: shown whole, the tail before the first question.
  const words = Array.from({ length: 30 }, () => 'pneumonoultramicroscopicsilicovolcanoconiosis').join(' ')
  const long = `${opening} ${words}\n${ESC}[2K ${tail}`
  assert.ok(long.length > 1400)
  const shown = await mandate(args, { lp: consentLp(long), tty: true, input: 'no\n' })
  assert.equal(shown.code, 3, shown.stdout)
  const at = shown.stdout.indexOf('Type matches')
  assert.ok(at > 0, shown.stdout)
  assert.ok(shown.stdout.lastIndexOf(`${words} [2K ${tail}`, at) > 0, 'the whole transcript, control characters stripped, is shown before the first confirmation')
  const extra = shown.stdout.slice(shown.stdout.indexOf('    extra '), at)
  assert.match(extra, /reconsidered all of it/, 'the extra words are shown in full too')
  assert.equal(extra.split('pneumonoultramicroscopicsilicovolcanoconiosis').length - 1, 30)
  assert.ok(!shown.stdout.includes(ESC))

  // Too long to review: refused (exit 3, re-record), no question asked, nothing published, whatever is typed.
  const before = publishes(grantor)
  const chatter = Array.from({ length: 30 }, (_, i) => `My family and I live in a small town and we enjoy the weekends together, item ${i}.`).join(' ')
  // Many words outside the script (more than can be listed whole), over 4000 characters in one word, and over 4000 characters of filler the extra list leaves out.
  for (const transcript of [`${opening} ${chatter} ${tail}`, `${opening} ${'y'.repeat(4000)} ${tail}`, `${opening} ${'the '.repeat(1400)}${tail}`]) {
    const refused = await mandate(args, { lp: consentLp(transcript), tty: true, input: answers })
    assert.equal(refused.code, 3, refused.stdout)
    assert.match(refused.stdout, /TOO LONG TO REVIEW/)
    assert.match(refused.stdout, /Re-record/)
    assert.doesNotMatch(refused.stdout, /Type matches/)
  }
  assert.equal(publishes(grantor), before)
  // Right at the character limit, it is still shown and asked.
  const edge = `${opening} ${'x'.repeat(4000 - opening.length - 1)}`
  assert.equal(edge.length, 4000)
  const atLimit = await mandate(args, { lp: consentLp(edge), tty: true, input: 'no\n' })
  assert.match(atLimit.stdout, /Type matches/)
  assert.ok(atLimit.stdout.includes(edge))
})

test('B3: parallel render --execute runs under a ceiling that fits one render dispatch exactly one', async () => {
  const g = await newGrant('cap', { 'max-spend': '1' })
  const lp = tag => renderLp(tag)
  const args = tag => execArgs('cap', { 'image-url': mediaUrl(`in-${tag}.jpg`) })
  // Held by this (live) process while the renders start: each resolves and decides with nothing pending,
  // then waits on the grant's lock. Released, each decides again under it.
  const lock = grantLockPath(pendingDir(), g.id)
  mkdirSync(pendingDir(), { recursive: true })
  writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: 'test' }))
  const running = ['a', 'b', 'c'].map(t => mandate(args(t), { lp: lp(`cap-${t}`) }))
  await sleepMs(2500)
  // Nothing is saved, let alone dispatched, while another process holds the grant's lock.
  assert.deepEqual(store().list().filter(r => r.grantId === g.id), [])
  rmSync(lock)
  const rs = await Promise.all(running)
  const dispatched = rs.filter(r => r.calls.some(x => x.name === 'run_capability:talking-head'))
  assert.equal(dispatched.length, 1, rs.map(r => r.stdout).join('\n'))
  assert.deepEqual(rs.map(r => r.code).sort(), [0, 2, 2])
  for (const r of rs.filter(x => x.code === 2)) assert.equal(json(r).decision.clause, 'spend-ceiling')
  const br = await mandate(['blast-radius', '--grant', g.id, '--json'])
  assert.equal(json(br).assets.length, 1)
  assert.equal(json(br).totalBilledUsd, 0.84)
})

test('B3: when another render uses up a grant while this one waits, a decision that moves to another grant is not dispatched', async () => {
  const a = await newGrant('duo', { 'max-spend': '1' })
  const b = await newGrant('duo', { 'max-spend': '1' })
  const first = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1))[0]
  const dry = await mandate(renderArgs({ subject: `${ANA}:duo` }))
  assert.equal(json(dry).decision.grantId, first.id)
  const lock = grantLockPath(pendingDir(), first.id)
  mkdirSync(pendingDir(), { recursive: true })
  writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token: 'test' }))
  const running = ['a', 'b'].map(t => mandate(execArgs('duo', { 'image-url': mediaUrl(`in-duo-${t}.jpg`) }), { lp: renderLp(`duo-${t}`) }))
  await sleepMs(2500)
  rmSync(lock)
  const rs = await Promise.all(running)
  assert.equal(rs.filter(r => r.calls.some(x => x.name === 'run_capability:talking-head')).length, 1, rs.map(r => r.stdout).join('\n'))
  const moved = rs.find(r => r.code !== 0)
  assert.equal(moved.code, 5, moved.stdout)
  assert.equal(json(moved).decisionChanged, true)
  assert.notEqual(json(moved).decision.grantId, first.id)
})

test('B3: a render this machine recorded counts against the ceiling until the knowledge read shows it', async () => {
  const g = await newGrant('cau', { 'max-spend': '1' })
  const dry = renderArgs({ subject: `${ANA}:cau` })
  assert.equal((await mandate(dry)).code, 0)
  const other = { key: `mandate-${'3'.repeat(32)}`, capability: 'talking-head', grantId: g.id, createdAt: new Date().toISOString(), status: 'recorded', costUsdEstimated: 0.84, mediaUrl: mediaUrl('out-cau.mp4') }
  store().save({ ...other, derivation: { id: 'urn:mandate:derivation:00000000000000cc:00000000000000cc', ual: null } })
  const unseen = await mandate(dry)
  assert.equal(unseen.code, 2, unseen.stdout)
  assert.equal(json(unseen).decision.clause, 'spend-ceiling')
  assert.equal(json(unseen).localPending[0].status, 'recorded')
  // With no derivation id there is nothing to match, as for a record from before this rule.
  store().save({ ...other, derivation: null })
  assert.equal((await mandate(dry)).code, 0)
})

test('B4: overlapping record --pending runs publish once; the second exits 5 at once and says why', async () => {
  const slow = await slowPublishProducer(2500)
  try {
    // A resumable attempt whose asset the node shows sealed (MW4), and one with no attempt yet (MW1).
    for (const [tag, attempt, descriptor] of [['mw4-share', { stage: 'share' }, { status: 'wm-sealed', wmCurrentAssertion: '1'.repeat(64) }], ['mw1-none', null, null]]) {
      const g = await newGrant(tag)
      const stuck = stuckRender(g, tag, attempt ?? {})
      if (descriptor) {
        const { id, name } = store().load(stuck.key).derivationAttempt
        producer.assets.set(name, { quads: [{ subject: id, predicate: 'x', object: 'y', graph: '' }], cg: DERIVS_CG, descriptor: { agentAddress: PRODUCER, ...descriptor } })
      }
      if (!attempt) { const rec = store().load(stuck.key); delete rec.derivationAttempt; store().save(rec) }
      const [p0, c0] = [publishes(producer), creates()]
      const [a, b] = await Promise.all([
        mandate(['record', '--pending', stuck.key, '--json'], slow),
        sleepMs(attempt ? 300 : 0).then(() => mandate(['record', '--pending', stuck.key, '--json'], slow)),
      ])
      assert.equal(publishes(producer) - p0, 1, `${tag}: ${a.stdout}\n${b.stdout}`)
      assert.ok(creates() - c0 <= 1, tag)
      const [won, lost] = a.code === 0 ? [a, b] : [b, a]
      assert.equal(won.code, 0, `${tag}: ${won.stdout}`)
      assert.equal(lost.code, 5, `${tag}: ${lost.stdout}`)
      assert.equal(json(lost).inFlight, true)
      assert.match(json(lost).error, /in use by another mandate process/)
      assert.equal(json(lost).mediaUrl, undefined)
      assert.equal(store().load(stuck.key).status, 'recorded')
      const br = await mandate(['blast-radius', '--grant', g.id, '--json'])
      assert.equal(br.code, 0, `${tag}: ${br.stdout}`)
      if (!attempt) assert.equal(json(br).assets.length, 1, tag)
    }
  } finally {
    slow.close()
  }
})

test('B4: a record while another record is still polling the same job exits 5, and the job gets one derivation', async () => {
  const g = await newGrant('race')
  const key = `mandate-${'7'.repeat(32)}`
  const now = new Date().toISOString()
  store().save({ key, idempotencyKey: key, status: 'submitted', jobId: 'mjob_race0001', mayHaveStarted: true, capability: 'talking-head', grantId: g.id, subject: g.subject, inputs: { image_url: mediaUrl('in.jpg') }, sourceUrl: null, estimateUsd: 0.84, estimateSource: 'static list price', priceUnit: 'second', createdAt: now, attempts: [{ n: 1, pid: 999_999_020, startedAt: now, sentAt: now, endedAt: now, status: 'submitted', jobId: 'mjob_race0001', mayHaveStarted: true }] })
  const done = { structured: { status: 'done', url: mediaUrl('race-out.mp4'), cost_usd_estimated: 0.5 } }
  const p0 = publishes(producer)
  const polling = mandate(['record', '--pending', key, '--json'], { lp: { get_create_media: [{ ...done, delayMs: 2500 }] } })
  await sleepMs(1000)
  const second = await mandate(['record', '--pending', key, '--json'], { lp: { get_create_media: [done] } })
  assert.equal(second.code, 5, second.stdout)
  assert.equal(json(second).inFlight, true)
  assert.deepEqual(second.calls, [])
  const first = await polling
  assert.equal(first.code, 0, first.stdout)
  assert.equal(publishes(producer) - p0, 1)
  assert.equal(store().load(key).status, 'recorded')
  assert.equal(json(await mandate(['blast-radius', '--grant', g.id, '--json'])).assets.length, 1)
})

test('B4: a record while render --execute is still committing the same key exits 5 and publishes nothing', async () => {
  // A subject no other test grants under, so the render decides under this grant and uses this key.
  const g = await newGrant('rex-lease')
  const key = keyFor(g.id)
  const slow = await slowPublishProducer(4000)
  try {
    const p0 = publishes(producer)
    const render = mandate(execArgs('rex-lease'), { lp: renderLp('rex-lease'), env: slow.env })
    // The render holds the key while its derivation publish waits.
    let ended = null
    render.then(r => { ended = r })
    for (let i = 0; i < 600 && !ended && store().load(key)?.derivationAttempt?.stage !== 'started'; i++) await sleepMs(50)
    assert.equal(store().load(key)?.derivationAttempt?.stage, 'started', ended ? `the render ended first (exit ${ended.code}, key ${JSON.parse(ended.stdout || '{}').pending ?? 'none'}, expected ${key}): ${ended.stderr}` : `never reached the derivation publish: ${JSON.stringify(store().load(key))}`)
    const record = await mandate(['record', '--pending', key, '--json'])
    assert.equal(record.code, 5, record.stdout)
    assert.equal(json(record).inFlight, true)
    const r = await render
    assert.equal(r.code, 0, r.stdout)
    assert.equal(publishes(producer) - p0, 1)
    // Once the render is done the key is free again.
    const after = await mandate(['record', '--pending', key, '--json'])
    assert.equal(after.code, 0, after.stdout)
    assert.equal(publishes(producer) - p0, 1)
  } finally {
    slow.close()
  }
})

test('B5: a rerun after a failed-confirmed record starts clean, so a possibly-billed rerun is never settled by the old job', async () => {
  const g = await newGrant('mw6', { 'max-spend': '5' })
  const key = keyFor(g.id)
  const now = new Date().toISOString()
  store().save({ key, idempotencyKey: key, status: 'submitted', jobId: 'mjob_mw6old001', mayHaveStarted: true, attempts: [{ n: 1, startedAt: now, pid: 999_999_021, idempotencyKey: key, sentAt: now, endedAt: now, status: 'submitted', jobId: 'mjob_mw6old001', mayHaveStarted: true }], createdAt: now, subject: g.subject, capability: 'talking-head', grantId: g.id, estimateUsd: 0.84, estimateSource: 'static list price', priceUnit: 'second', seconds: 5, inputs: { image_url: mediaUrl('in.jpg'), audio_url: mediaUrl('in.wav') } })
  const failed = { get_create_media: { structured: { status: 'failed', error: 'model crashed' } } }
  assert.equal((await mandate(['record', '--pending', key, '--json'], { lp: failed })).code, 5)
  // The rerun's transport error: it may have started, and has no job id of its own.
  const rerun = await mandate(execArgs('mw6'), { lp: renderLp('mw6', { 'run_capability:talking-head': { throw: 'fetch failed: other side closed' } }) })
  assert.equal(rerun.code, 9, rerun.stdout)
  assert.equal(json(rerun).jobId, null)
  const rec = store().load(key)
  assert.equal(rec.status, 'submitted')
  assert.equal(rec.jobId ?? null, null)
  assert.equal(rec.failedConfirmedAt, undefined)
  assert.equal(rec.attempts.length, 2)
  // The old outcome stays in the first attempt's history.
  assert.equal(rec.attempts[0].settled.jobId, 'mjob_mw6old001')
  assert.equal(rec.attempts[0].settled.jobStatus, 'failed')
  // record never polls the old job: the outcome is unknown.
  const again = await mandate(['record', '--pending', key, '--json'], { lp: failed })
  assert.equal(again.code, 9, again.stdout)
  assert.deepEqual(again.calls, [])
  assert.equal(store().load(key).status, 'submitted')
  // It keeps counting, and a different key is refused before anything is sent.
  const other = await mandate(execArgs('mw6', { 'idempotency-key': 'brand-new-key-mw6' }), { lp: renderLp('mw6') })
  assert.equal(other.code, 1, other.stdout)
  assert.ok(!other.calls.some(x => x.name.startsWith('run_capability')))
  const dry = await mandate(renderArgs({ subject: `${ANA}:mw6`, seconds: '1' }))
  assert.equal(json(dry).localPending.length, 1)
})

test('B6: record --pending refuses before publishing when the producer node is not a trusted producer', async () => {
  const g = await newGrant('mw5')
  const stuck = stuckRender(g, 'mw5', {})
  const rec = store().load(stuck.key); delete rec.derivationAttempt; store().save(rec)
  const [p0, c0] = [publishes(producer), creates()]
  const r = await mandate(['record', '--pending', stuck.key, '--json'], { env: { MANDATE_TRUSTED_PRODUCERS: STRANGER } })
  assert.equal(r.code, 1, r.stdout)
  assert.match(json(r).error, /not a trusted producer/)
  assert.equal(json(r).mediaUrl, undefined)
  assert.doesNotMatch(r.stdout, /out-mw5\.mp4/)
  assert.equal(publishes(producer), p0)
  assert.equal(creates(), c0)
  const left = store().load(stuck.key)
  assert.equal(left.status, 'rendered')
  assert.equal(left.derivationAttempt, undefined)
  // Under the configuration that trusts it, the same record goes through.
  assert.equal((await mandate(['record', '--pending', stuck.key, '--json'])).code, 0)
})

test('MW7: a replay whose job id matches a recorded derivation but whose bytes differ is anchored for its own bytes', async () => {
  const g = await newGrant('mw7', { 'max-spend': '50' })
  const one = await mandate(execArgs('mw7'), { lp: renderLp('mw7', { 'run_capability:talking-head': { structured: { ok: true, status: 'done', job_id: 'mjob_mw7job0001', url: mediaUrl('out-mw7-a.mp4'), cost_usd_estimated: 0.84 } } }) })
  assert.equal(one.code, 0, one.stdout)
  const p0 = publishes(producer)
  const two = await mandate(execArgs('mw7', { seconds: '6' }), { lp: renderLp('mw7', { 'run_capability:talking-head': { structured: { ok: true, status: 'done', job_id: 'mjob_mw7job0001', idempotency_replay: true, url: mediaUrl('out-mw7-b.mp4'), cost_usd_estimated: 0.84 } } }) })
  assert.equal(two.code, 0, two.stdout)
  assert.notEqual(json(two).derivation.existing, true)
  assert.equal(json(two).derivation.outputSha256, sha('bytes of /out-mw7-b.mp4'))
  assert.equal(publishes(producer), p0 + 1)
  const v = await mandate(['verify', '--url', mediaUrl('out-mw7-b.mp4'), '--json'])
  assert.equal(json(v).verdict, 'CLEAR', v.stdout)
  // The recorded bytes under another job id: not taken as that job's record either.
  const three = await mandate(execArgs('mw7', { seconds: '7' }), { lp: renderLp('mw7', { 'run_capability:talking-head': { structured: { ok: true, status: 'done', job_id: 'mjob_mw7job0002', idempotency_replay: true, url: mediaUrl('out-mw7-a.mp4'), cost_usd_estimated: 0.84 } } }) })
  assert.equal(three.code, 0, three.stdout)
  assert.notEqual(json(three).derivation.existing, true)
  assert.equal(publishes(producer), p0 + 2)
  // The same job and the same bytes: the existing record, nothing published.
  const four = await mandate(execArgs('mw7', { seconds: '8' }), { lp: renderLp('mw7', { 'run_capability:talking-head': { structured: { ok: true, status: 'done', job_id: 'mjob_mw7job0001', idempotency_replay: true, url: mediaUrl('out-mw7-a.mp4') } } }) })
  assert.equal(four.code, 0, four.stdout)
  assert.equal(json(four).derivation.existing, true)
  assert.equal(publishes(producer), p0 + 2)
})

test('revoke publishes an anchored revocation when the only one it sees is a row in its own merged view', async () => {
  const g = json(await mandate(grantArgs({ subject: 'ctx' }))).grant
  const stateId = 'urn:mandate:state:00000000000000cf'
  world[GRANTS_CG].graphs = [...(world[GRANTS_CG].graphs ?? []), { graph: `${cgIri(GRANTS_CG)}/context/1`, rows: [{ s: stateId, p: V.stateOf, o: g.id }, { s: stateId, p: V.state, o: '"revoked"' }] }]
  const before = publishes(grantor)
  const r = await mandate(['revoke', '--id', g.id, '--yes'])
  assert.equal(r.code, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /only in .*merged view/)
  assert.match(r.stdout, /REVOKED/)
  assert.equal(publishes(grantor), before + 1)
  // Now anchored: a second revoke publishes nothing.
  const again = await mandate(['revoke', '--id', g.id, '--yes', '--json'])
  assert.equal(json(again).alreadyRevoked, true)
  assert.equal(publishes(grantor), before + 1)
})

test('under a ceiling, a per-second estimate says it relies on --seconds', async () => {
  await newGrant('sec', { 'max-spend': '5' })
  const r = await mandate(renderArgs({ subject: `${ANA}:sec`, json: null }))
  assert.equal(r.code, 0, r.stdout)
  assert.match(r.stdout, /per second × --seconds 5, which is taken as given: it is not sent to Livepeer/)
  assert.match(json(await mandate(renderArgs({ subject: `${ANA}:sec` }))).price.note, /--seconds/)
  // No ceiling: no such note.
  await newGrant('sen', { 'max-spend': null })
  assert.equal(json(await mandate(renderArgs({ subject: `${ANA}:sen` }))).price.note, undefined)
})

test('B7: a .env in the working directory is never read; the env file comes from --env-path, MANDATE_ENV_FILE or $MANDATE_HOME', async () => {
  const cwdEnv = join(work, '.env')
  writeFileSync(cwdEnv, `MANDATE_TRUSTED_PRODUCERS=${STRANGER}\nMANDATE_CHECK_FRESHNESS=0\nMANDATE_VERIFIER_PORT=9\n`)
  const homeEnv = join(work, '.mandate', '.env')
  try {
    // Ignored: verify still trusts the configured producer, checks freshness, and says no env file was loaded.
    const v = await mandate(['verify', '--sha256', 'c'.repeat(64), '--json'])
    assert.equal(json(v).config.envFile, null)
    assert.equal(json(v).config.envFileSearched, homeEnv)
    assert.deepEqual(json(v).config.trustedProducers, [PRODUCER])
    assert.equal(json(v).config.checkFreshness, true)
    assert.equal(json(v).nodeRole, 'grantor')
    assert.doesNotMatch(v.stderr, /FRESHNESS CHECK OFF/)
    const text = await mandate(['verify', '--sha256', 'c'.repeat(64)])
    assert.match(text.stdout, /env file\s+none \(looked for .*\.mandate\/\.env; a \.env in the working directory is never read\)/)
    assert.match(text.stdout, new RegExp(`trusted producers\\s+${PRODUCER}`))

    // $MANDATE_HOME/.env is read, and status says so, with a visible freshness warning.
    writeFileSync(homeEnv, `MANDATE_TRUSTED_PRODUCERS=${STRANGER}\nMANDATE_CHECK_FRESHNESS=0\n`, { mode: 0o600 })
    const s = await mandate(['status'])
    assert.match(s.stdout, new RegExp(`env file\\s+${homeEnv.replace(/[.]/g, '\\.')} \\(MANDATE_HOME; 2 key\\(s\\) set from it`))
    assert.match(s.stdout, new RegExp(`trusted producers\\s+${STRANGER}`))
    assert.match(s.stdout, /FRESHNESS CHECK OFF/)
    const sj = await mandate(['status', '--json'])
    assert.equal(json(sj).config.envFile, homeEnv)
    assert.equal(json(sj).config.checkFreshness, false)
    assert.match(sj.stderr, /FRESHNESS CHECK OFF/)
    rmSync(homeEnv)

    // --env-path and MANDATE_ENV_FILE name one explicitly; the flag wins; the real environment wins over both.
    const named = join(work, 'named.env')
    writeFileSync(named, `MANDATE_TRUSTED_PRODUCERS=${ANA}\n`, { mode: 0o600 })
    const flagged = await mandate(['verify', '--sha256', 'c'.repeat(64), '--json', '--env-path', named], { env: { MANDATE_ENV_FILE: cwdEnv } })
    assert.equal(json(flagged).config.envFile, named)
    assert.deepEqual(json(flagged).config.trustedProducers, [ANA])
    const byVar = await mandate(['verify', '--sha256', 'c'.repeat(64), '--json'], { env: { MANDATE_ENV_FILE: named } })
    assert.equal(json(byVar).config.envFileSource, 'MANDATE_ENV_FILE')
    const real = await mandate(['verify', '--sha256', 'c'.repeat(64), '--json', '--env-path', named], { env: { MANDATE_TRUSTED_PRODUCERS: PRODUCER } })
    assert.deepEqual(json(real).config.trustedProducers, [PRODUCER])
    // An explicitly named file that is missing is a configuration error.
    const missing = await mandate(['status', '--json', '--env-path', join(work, 'nope.env')])
    assert.equal(missing.code, 1)
    assert.match(json(missing).error, /nope\.env .*cannot be read/)
    // --env-file is Node's own flag (it applies a NODE_OPTIONS from the file even after the script name): refused, pointing at --env-path.
    const nodeFlag = await mandate(['status', '--json', '--env-file', named])
    assert.equal(nodeFlag.code, 1)
    assert.match(nodeFlag.stderr, /--env-path/)
    // A file others can write to is loaded with a warning.
    writeFileSync(named, `MANDATE_TRUSTED_PRODUCERS=${ANA}\n`)
    chmodSync(named, 0o666)
    const loose = await mandate(['status', '--json', '--env-path', named])
    assert.match(loose.stderr, /world-writable/)
    chmodSync(named, 0o620)
    assert.match((await mandate(['status', '--json', '--env-path', named])).stderr, /group-writable/)
  } finally {
    rmSync(cwdEnv, { force: true })
    rmSync(homeEnv, { force: true })
  }
})

test('B7: the scripts read the same env file, never a working-directory .env, and the demo passes the repository\'s explicitly', async () => {
  const dir = mkdtempSync(join(work, 'scripts-env-'))
  const repo = new URL('..', import.meta.url).pathname
  writeFileSync(join(dir, '.env'), 'MANDATE_GRANTOR_HOME=/nonexistent/cwd\nNODE_TLS_REJECT_UNAUTHORIZED=0\n')
  const run = (script, args, env = {}) => new Promise(resolve => {
    const child = spawn(process.execPath, [join(repo, script), ...args], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
  // nodes.mjs init writes the grantor's config under the home it was configured with.
  const home = join(dir, 'dkg-home')
  const named = join(dir, 'named.env')
  writeFileSync(named, `MANDATE_GRANTOR_HOME=${home}\n`, { mode: 0o600 })
  const cwdOnly = await run('scripts/nodes.mjs', ['init', 'grantor'])
  assert.equal(cwdOnly.code, 0, cwdOnly.stderr)
  assert.equal(existsSync('/nonexistent/cwd/config.json'), false)
  assert.ok(existsSync(join(dir, '.dkg-mandate-grantor', 'config.json')), 'the default home, not the cwd .env one')
  const flagged = await run('scripts/nodes.mjs', ['init', 'grantor', '--env-path', named])
  assert.equal(flagged.code, 0, flagged.stderr)
  assert.ok(existsSync(join(home, 'config.json')))
  assert.equal((await run('scripts/nodes.mjs', ['init', 'grantor', '--env-path', join(dir, 'missing.env')])).code, 1)
  const nodeFlag = await run('scripts/nodes.mjs', ['init', 'grantor', '--env-file', named])
  assert.equal(nodeFlag.code, 1)
  assert.match(nodeFlag.stderr, /--env-path/)

  // publish-skill: a dry run that never reads the cwd .env, and reads a named one.
  // A skills/likeness-consent.md in the working directory is not the body: the repository's is.
  mkdirSync(join(dir, 'skills'))
  writeFileSync(join(dir, 'skills', 'likeness-consent.md'), 'planted skill body')
  const dry = await run('scripts/publish-skill.mjs', [])
  assert.equal(dry.code, 0, dry.stdout + dry.stderr)
  const repoBody = readFileSync(join(repo, 'skills', 'likeness-consent.md'), 'utf8')
  assert.match(dry.stdout, new RegExp(`^body\\s+${repoBody.length} / 20000$`, 'm'))
  assert.doesNotMatch(dry.stdout, /^body\s+18 \//m)
  assert.match(dry.stdout, /env file: none/)
  assert.doesNotMatch(dry.stdout, /NODE_TLS_REJECT_UNAUTHORIZED/)
  writeFileSync(named, 'NODE_TLS_REJECT_UNAUTHORIZED=0\nMANDATE_READ_MAX=10\n', { mode: 0o600 })
  const withFile = await run('scripts/publish-skill.mjs', ['--env-path', named])
  assert.equal(withFile.code, 0, withFile.stdout + withFile.stderr)
  assert.match(withFile.stdout, /^\.env: ignored NODE_TLS_REJECT_UNAUTHORIZED \(only MANDATE_\* and LIVEPEER_AGENT_KEY are read\)$/m)

  // The demo hands every command the repository's own env file.
  assert.equal(DEMO_ENV_FILE, join(repo, '.env'))
  const argvOf = cliArgv(['verify', '--url', 'https://x.test/a.mp4'])
  assert.deepEqual(argvOf.slice(-3), ['--env-path', join(repo, '.env'), '--json'])
  assert.equal(argvOf[0], join(repo, 'bin', 'mandate.mjs'))
  assert.deepEqual(nodesArgv(['sync', 'verifier']).slice(-2), ['--env-path', join(repo, '.env')])
  const demo = readFileSync(join(repo, 'demo', 'full.mjs'), 'utf8')
  assert.match(demo, /spawn\(process\.execPath, cliArgv\(args, opt\['env-path'\]\)/)
  assert.match(demo, /spawn\(process\.execPath, nodesArgv\(\['sync', role\], opt\['env-path'\]\)/)
  // .env.example says where the file is read from.
  const example = readFileSync(join(repo, '.env.example'), 'utf8')
  assert.match(example, /--env-path/)
  assert.match(example, /~\/\.mandate\/\.env/)
  assert.match(example, /working directory is NEVER read/)
})

test('B7: publish-ontology and every spike that reads bin/config.mjs load the CLI\'s env file, never a working-directory .env', async () => {
  const dir = mkdtempSync(join(work, 'ontology-env-'))
  const repo = new URL('..', import.meta.url).pathname
  // A vocab/mandate.ttl in the working directory (a folder someone sent) is never the one published.
  mkdirSync(join(dir, 'vocab'))
  writeFileSync(join(dir, 'vocab', 'mandate.ttl'), '@prefix owl: <http://www.w3.org/2002/07/owl#> .\n<https://x.test/o> owl:versionInfo "9.9.9" ; <https://x.test/p> "planted" .\n')
  writeFileSync(join(dir, '.env'), 'MANDATE_GRANTOR_PORT=1\n')
  const named = join(dir, 'named.env')
  writeFileSync(named, 'MANDATE_GRANTOR_PORT=2\nNODE_OPTIONS=--require=/nonexistent\n', { mode: 0o600 })
  const run = (args, cwd = dir) => new Promise(resolve => {
    const child = spawn(process.execPath, [join(repo, 'scripts', 'publish-ontology.mjs'), ...args], { cwd, env: { PATH: process.env.PATH, HOME: dir } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', d => { stdout += d })
    child.stderr.on('data', d => { stderr += d })
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
  const plain = await run([])
  assert.equal(plain.code, 0, plain.stderr)
  assert.match(plain.stdout, /^env file: none \(looked for .*\.mandate\/\.env\)$/m)
  const fromRepo = await run([], repo)
  const vocabLine = fromRepo.stdout.match(/^vocab \d+\.\d+\.\d+: \d+ triples$/m)?.[0]
  assert.ok(vocabLine, fromRepo.stdout + fromRepo.stderr)
  assert.ok(plain.stdout.split('\n').includes(vocabLine), `the repository's ontology, not the working directory's: ${plain.stdout}`)
  assert.doesNotMatch(plain.stdout, /9\.9\.9/)
  const flagged = await run(['--env-path', named])
  assert.equal(flagged.code, 0, flagged.stderr)
  assert.match(flagged.stdout, new RegExp(`^env file: ${named.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'))
  assert.match(flagged.stdout, /^vocab \d+\.\d+\.\d+: \d+ triples$/m)
  const missing = await run(['--env-path', join(dir, 'missing.env')])
  assert.equal(missing.code, 1)
  assert.match(missing.stderr, /cannot be read/)
  // Nothing imports bin/config.mjs's node settings without first loading the env file.
  for (const f of ['scripts/publish-ontology.mjs', 'spikes/s6-author-attestation.mjs', 'spikes/s6b-forge-authorship.mjs', 'spikes/s6c-forgery.mjs']) {
    const src = readFileSync(join(repo, f), 'utf8')
    assert.match(src, /^(?:const envFile = )?loadScriptEnv\(\)$/m, f)
  }
  const s6c = readFileSync(join(repo, 'spikes/s6c-forgery.mjs'), 'utf8')
  assert.match(s6c, /\.\.\.\(envFile\.path \? \['--env-path', envFile\.path\] : \[\]\)/)
  // The repository scripts find their files from their own location, never the working directory.
  assert.match(s6c, /^const REPO = join\(import\.meta\.dirname, '\.\.'\)$/m)
  assert.match(s6c, /run\(process\.execPath, \[MANDATE_BIN, /)
  for (const f of ['scripts/publish-ontology.mjs', 'scripts/publish-skill.mjs', 'spikes/s6c-forgery.mjs']) {
    const src = readFileSync(join(repo, f), 'utf8')
    assert.doesNotMatch(src, /(?:readFileSync|writeFileSync|execFile|run)\(\s*(?:process\.execPath,\s*\[\s*)?[`'"](?!\/)/, f)
  }
})

/* A consent clip answers one capture; a suspended or stale pending run never writes over another */

test('consent: the same clip is refused for a new grant from the same grantor, revoked or not, for any subject; nothing is published', async () => {
  const lp = consentLp(scriptFor({ territory: ['GB'] }), { tag: 'kept-recording' })
  const a = await mandate(consentGrant({ subject: 'rep', territory: 'GB', 'valid-until': until }), { lp, tty: true })
  assert.equal(a.code, 0, a.stdout)
  const first = json(a)
  assert.equal(first.consent.confirmedBy, 'script')
  const p0 = publishes(grantor)
  // Not revoked: refused.
  const live = await mandate(consentGrant({ subject: 'rep2', territory: 'GB', 'valid-until': until }), { lp, tty: true })
  assert.equal(live.code, 3, live.stdout)
  assert.equal(json(live).granted, false)
  assert.equal(json(live).reason, 'consent clip reused')
  assert.equal(json(live).usedBy[0].id, first.grant.id)
  assert.equal(json(live).usedBy[0].revoked, false)
  assert.equal(publishes(grantor), p0)
  // Revoked: refused too, and says so.
  assert.equal((await mandate(['revoke', '--id', first.grant.id, '--yes', '--json'])).code, 0)
  const p1 = publishes(grantor)
  const again = await mandate(consentGrant({ subject: 'rep', territory: 'GB', 'valid-until': until }), { lp, tty: true })
  assert.equal(again.code, 3, again.stdout)
  assert.match(json(again).detail, /already backs grant .*which was revoked; a recording is consent for the capture it was made for/)
  assert.equal(json(again).usedBy[0].revoked, true)
  assert.equal(publishes(grantor), p1)
  // A new recording is accepted.
  const fresh = await mandate(consentGrant({ subject: 'rep', territory: 'GB', 'valid-until': until }), { lp: consentLp(scriptFor({ territory: ['GB'] }), { tag: 'new-recording' }), tty: true })
  assert.equal(fresh.code, 0, fresh.stdout)
  assert.notEqual(json(fresh).grant.consentClipSha256, first.grant.consentClipSha256)
})

test('consent: a grant backed by a clip never starts before the clip; a past --valid-from is refused before anything is requested', async () => {
  const before = publishes(grantor)
  const lp = consentLp(scriptFor({ territory: ['GB'] }))
  for (const from of ['2020-01-01T00:00:00Z', new Date(Date.now() - 60_000).toISOString()]) {
    const r = await mandate(consentGrant({ subject: 'bea', territory: 'GB', 'valid-until': until, 'valid-from': from }), { lp, tty: true })
    assert.equal(r.code, 1, r.stdout + r.stderr)
    assert.match(json(r).error, /--valid-from \S+ is in the past; a grant with a consent clip cannot start before the clip is recorded/)
    assert.deepEqual(r.calls, [], from)
  }
  assert.equal(publishes(grantor), before)
  // Without --valid-from, the grant starts when the clip arrived, not when the command started.
  const started = Date.now()
  const ok = await mandate(consentGrant({ subject: 'bea', territory: 'GB', 'valid-until': until }), { lp: consentLp(scriptFor({ territory: ['GB'] })), tty: true })
  assert.equal(ok.code, 0, ok.stdout + ok.stderr)
  assert.equal(json(ok).consent.confirmedBy, 'script')
  assert.ok(Date.parse(json(ok).grant.validFrom) >= started, json(ok).grant.validFrom)
  // A start that was still ahead when the command began but passed while the clip was recorded moves to the clip's arrival.
  const soon = new Date(Date.now() + 4000).toISOString()
  const slow = { ...consentLp(scriptFor({ territory: ['GB'] })) }
  slow.get_upload = { ...slow.get_upload, delayMs: 6000 }
  const moved = await mandate(consentGrant({ subject: 'bea', territory: 'GB', 'valid-until': until, 'valid-from': soon }), { lp: slow, tty: true })
  assert.equal(moved.code, 0, moved.stdout + moved.stderr)
  assert.ok(Date.parse(json(moved).grant.validFrom) > Date.parse(soon), `${json(moved).grant.validFrom} is after ${soon}`)
  assert.match(moved.stderr, /passed while the clip was recorded; the grant starts when the clip arrived/)
  // A future start is kept as given.
  const later = new Date(Date.now() + 864e5).toISOString()
  const future = await mandate(consentGrant({ subject: 'bea', territory: 'GB', 'valid-until': until, 'valid-from': later }), { lp: consentLp(scriptFor({ territory: ['GB'] })), tty: true })
  assert.equal(future.code, 0, future.stdout + future.stderr)
  assert.equal(json(future).grant.validFrom, later)
  // A plain grant (no clip) may still start in the past.
  const plain = await mandate(grantArgs({ subject: 'bea', 'valid-from': '2020-01-01T00:00:00Z', 'valid-until': until }))
  assert.equal(plain.code, 0, plain.stdout + plain.stderr)
})

test('consent: the configuration and the grants the clip-reuse check reads are checked before a clip is requested', async () => {
  const before = publishes(grantor)
  const lp = consentLp(scriptFor({ territory: ['GB'] }))
  // No derivations graph configured: exit 1, no request_upload, nothing transcribed or published.
  const noDerivs = await mandate(consentGrant({ subject: 'bea', territory: 'GB', 'valid-until': until }), { lp, tty: true, env: { MANDATE_DERIVATIONS_CG: undefined } })
  assert.equal(noDerivs.code, 1, noDerivs.stdout + noDerivs.stderr)
  assert.match(json(noDerivs).error, /MANDATE_DERIVATIONS_CG/)
  assert.ok(!noDerivs.calls.some(x => x.name === 'request_upload'), JSON.stringify(noDerivs.calls))
  assert.deepEqual(noDerivs.calls, [])
  // A grants read that is not current: exit 9 before capture, not after a paid transcription.
  grantor.scenario.staleBy = 1
  try {
    const stale = await mandate(consentGrant({ subject: 'bea', territory: 'GB', 'valid-until': until }), { lp, tty: true })
    assert.equal(stale.code, 9, stale.stdout + stale.stderr)
    assert.equal(json(stale).reason, 'consent clip reuse not checked')
    assert.match(json(stale).detail, /cannot check whether a consent clip already backs a grant: stale view/)
    assert.deepEqual(stale.calls, [])
  } finally {
    delete grantor.scenario.staleBy
  }
  assert.equal(publishes(grantor), before)
  // A plain grant needs no derivations graph.
  const plain = await mandate(grantArgs({ subject: 'bea' }), { env: { MANDATE_DERIVATIONS_CG: undefined } })
  assert.equal(plain.code, 0, plain.stdout + plain.stderr)
})

async function submittedPendingRecord(tag, jobId) {
  const g = json(await mandate(grantArgs({ subject: tag })))
  const key = `mandate-${createHash('sha256').update(tag).digest('hex').slice(0, 32)}`
  const now = new Date().toISOString()
  store().save({ key, idempotencyKey: key, status: 'submitted', jobId, mayHaveStarted: true, capability: 'talking-head', grantId: g.grant.id, subject: g.grant.subject, inputs: { image_url: mediaUrl('in.jpg') }, sourceUrl: null, estimateUsd: 0.84, estimateSource: 'static list price', priceUnit: 'second', createdAt: now, attempts: [{ n: 1, pid: 999_999_050, startedAt: now, sentAt: now, endedAt: now, status: 'submitted', jobId, mayHaveStarted: true }] })
  return { g, key }
}

test('BLOCKER 3: record --pending never takes over a lease whose holder is alive here, however long it has not touched it (a suspended run)', async () => {
  const { key } = await submittedPendingRecord('lse', 'mjob_lse0000001')
  const lease = join(pendingDir(), `${key}.json.lease`)
  // This test process stands in for a suspended holder: alive, lease untouched for 2 hours.
  writeFileSync(lease, JSON.stringify({ pid: process.pid, host: hostname(), at: 'then', token: 'suspended' }))
  const old = new Date(Date.now() - 2 * 3600_000)
  utimesSync(lease, old, old)
  const k0 = world[DERIVS_CG].kas.length
  const r = await mandate(['record', '--pending', key, '--json'], { lp: { get_create_media: { structured: { status: 'done', url: mediaUrl('lse.mp4'), cost_usd_estimated: 0.5 } } } })
  assert.equal(r.code, 5, r.stdout)
  assert.equal(json(r).outcome, 'in-use')
  assert.equal(r.calls.length, 0)
  assert.equal(world[DERIVS_CG].kas.length, k0)
  assert.equal(store().load(key).status, 'submitted')
  assert.ok(readFileSync(lease, 'utf8').includes('suspended'))
  rmSync(lease)
})

test('BLOCKER 3: record --pending whose copy went stale during its poll writes nothing and publishes nothing', async () => {
  const { key } = await submittedPendingRecord('stl', 'mjob_stl0000001')
  const k0 = world[DERIVS_CG].kas.length
  const p0 = publishes(producer)
  const run = mandate(['record', '--pending', key, '--json'], { lp: { get_create_media: [{ structured: { status: 'running' } }, { structured: { status: 'done', url: mediaUrl('stl.mp4'), cost_usd_estimated: 0.5 } }] } })
  const log = join(work, `lp-${lpSeq}.log`)
  // Once its first poll has answered 'running' it waits 10 s holding the copy it
  // loaded; another write lands then (as a run that took the lease over would make).
  for (let i = 0; i < 600 && !(existsSync(log) && readFileSync(log, 'utf8').includes('get_create_media')); i++) await sleepMs(50)
  assert.ok(readFileSync(log, 'utf8').includes('get_create_media'), 'the record run reached its poll')
  await sleepMs(500)
  const s = store()
  s.save({ ...s.load(key), status: 'recorded', mediaUrl: mediaUrl('stl-other.mp4'), derivation: { id: 'urn:mandate:derivation:00000000000000dd:00000000000000dd', ual: 'did:dkg:x/9' } })
  const onDisk = readFileSync(join(pendingDir(), `${key}.json`), 'utf8')
  const r = await run
  assert.equal(r.code, 5, r.stdout)
  assert.match(json(r).error, /changed on disk/)
  assert.equal(readFileSync(join(pendingDir(), `${key}.json`), 'utf8'), onDisk)
  assert.equal(world[DERIVS_CG].kas.length, k0)
  assert.equal(publishes(producer), p0)
})
