import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, statSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { startFakeDkg } from './fixtures/fake-dkg-server.mjs'
import { loadEnvFile } from '../bin/config.mjs'
import { GRANTS_CG, DERIVS_CG, ANA, PRODUCER, STRANGER } from './fixtures/build.mjs'

const run = promisify(execFile)
const BIN = new URL('../bin/mandate.mjs', import.meta.url).pathname
const ANA_CHECKSUM = '0xeD1eeB64CaC09874257F05Fd6B51A55695ad0B69'

let work, grantor, producer, world
const homes = {}

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
})
after(async () => {
  await grantor.close()
  await producer.close()
  rmSync(work, { recursive: true, force: true })
})

async function mandate(args, { env = {} } = {}) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], {
      cwd: work,
      env: {
        PATH: process.env.PATH, HOME: work, NO_COLOR: '1', MANDATE_LIVE_PRICES: '0',
        MANDATE_HOME: join(work, '.mandate'),
        MANDATE_GRANTOR_HOME: homes.grantor, MANDATE_GRANTOR_PORT: String(grantor.port),
        MANDATE_PRODUCER_HOME: homes.producer, MANDATE_PRODUCER_PORT: String(producer.port),
        MANDATE_GRANTS_CG: GRANTS_CG, MANDATE_DERIVATIONS_CG: DERIVS_CG,
        ...env,
      },
    })
    return { code: 0, stdout, stderr }
  } catch (e) {
    return { code: e.code, stdout: e.stdout, stderr: e.stderr }
  }
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
