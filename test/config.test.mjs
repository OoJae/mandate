import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { envFileLocation, ConfigError, mandateHome } from '../bin/config.mjs'
import { absoluteSettingPath, defaultStateDir } from '../src/state-store.mjs'
import { defaultPendingDir } from '../src/pending.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BIN = join(ROOT, 'bin', 'mandate.mjs')
const GRANTS = '0xed1eeb64cac09874257f05fd6b51a55695ad0b69/mandate-grants'
const DERIVS = '0x8eaa4857b22dddbfb5ebc476087fec39336e0cb5/mandate-derivations'
const STRANGER = '0x1111111111111111111111111111111111111111'

const run = (args, { cwd, env }) => new Promise(res => {
  const c = spawn(process.execPath, args, { cwd, env: { PATH: process.env.PATH, NO_COLOR: '1', MANDATE_GRANTOR_PORT: '9', MANDATE_PRODUCER_PORT: '9', ...env } })
  let stdout = '', stderr = ''
  c.stdout.on('data', d => { stdout += d })
  c.stderr.on('data', d => { stderr += d })
  c.on('close', code => res({ code, stdout, stderr }))
})

/** A HOME with a real ~/.mandate/.env, and a delivery folder holding a planted `~/.mandate/.env` and `rel/.env`. */
function world() {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'mandate-config-')))
  const home = join(work, 'home')
  mkdirSync(join(home, '.mandate'), { recursive: true })
  writeFileSync(join(home, '.mandate', '.env'), `MANDATE_GRANTS_CG=${GRANTS}\nMANDATE_DERIVATIONS_CG=${DERIVS}\n`, { mode: 0o600 })
  const delivery = join(work, 'delivery')
  const planted = `MANDATE_GRANTS_CG=${GRANTS}\nMANDATE_DERIVATIONS_CG=${STRANGER}/fake\nMANDATE_TRUSTED_PRODUCERS=${STRANGER}\nMANDATE_CHECK_FRESHNESS=0\n`
  for (const d of [join(delivery, '~', '.mandate'), join(delivery, 'rel')]) {
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, '.env'), planted, { mode: 0o600 })
  }
  return { work, home, delivery }
}

test('B7 follow-up: a setting path expands a leading ~, treats empty as unset, and refuses anything still relative', () => {
  assert.equal(absoluteSettingPath(undefined, 'X'), undefined)
  assert.equal(absoluteSettingPath('', 'X'), undefined)
  assert.equal(absoluteSettingPath('~', 'X'), homedir())
  assert.equal(absoluteSettingPath('~/.mandate', 'X'), join(homedir(), '.mandate'))
  assert.equal(absoluteSettingPath('/abs/dir', 'X'), '/abs/dir')
  for (const bad of ['.mandate', './x', '~other/.mandate', ' ', 'rel/.env']) {
    assert.throws(() => absoluteSettingPath(bad, 'MANDATE_HOME'), e => e instanceof ConfigError && /MANDATE_HOME must be an absolute path/.test(e.message), bad)
  }
  assert.equal(mandateHome({}), join(homedir(), '.mandate'))
  assert.equal(mandateHome({ MANDATE_HOME: '' }), join(homedir(), '.mandate'))
  assert.equal(mandateHome({ MANDATE_HOME: '~/m' }), join(homedir(), 'm'))
  // envFileLocation: the same rules for MANDATE_ENV_FILE and MANDATE_HOME.
  assert.deepEqual(envFileLocation({ env: { MANDATE_ENV_FILE: '~/a.env' } }), { path: join(homedir(), 'a.env'), source: 'MANDATE_ENV_FILE', explicit: true })
  assert.deepEqual(envFileLocation({ env: { MANDATE_ENV_FILE: '', MANDATE_HOME: '~/m' } }), { path: join(homedir(), 'm', '.env'), source: 'MANDATE_HOME', explicit: false })
  assert.throws(() => envFileLocation({ env: { MANDATE_ENV_FILE: 'rel/.env' } }), /MANDATE_ENV_FILE must be an absolute path/)
  assert.throws(() => envFileLocation({ env: { MANDATE_HOME: '.mandate' } }), /MANDATE_HOME must be an absolute path/)
  assert.equal(envFileLocation({ flag: '~/f.env', env: {} }).path, join(homedir(), 'f.env'))
  // Local state uses the same resolver.
  const saved = process.env.MANDATE_HOME
  try {
    process.env.MANDATE_HOME = '~/st'
    assert.equal(defaultStateDir(), join(homedir(), 'st', 'state'))
    process.env.MANDATE_HOME = ''
    assert.equal(defaultStateDir(), join(homedir(), '.mandate', 'state'))
    process.env.MANDATE_HOME = 'st'
    assert.throws(() => defaultStateDir(), ConfigError)
    // So do pending renders, their grant locks and leases: one home for all three.
    process.env.MANDATE_HOME = '~/p'
    assert.equal(defaultPendingDir(), join(homedir(), 'p', 'pending'))
    process.env.MANDATE_HOME = ''
    assert.equal(defaultPendingDir(), join(homedir(), '.mandate', 'pending'))
    process.env.MANDATE_HOME = 'p'
    assert.throws(() => defaultPendingDir(), ConfigError)
  } finally {
    if (saved === undefined) delete process.env.MANDATE_HOME
    else process.env.MANDATE_HOME = saved
  }
})

test('B7 follow-up: a quoted ~ in MANDATE_HOME or MANDATE_ENV_FILE never reads the working directory; relative values exit 1', async () => {
  const { work, home, delivery } = world()
  const homeEnv = join(home, '.mandate', '.env')
  try {
    for (const env of [{ MANDATE_HOME: '~/.mandate' }, { MANDATE_ENV_FILE: '~/.mandate/.env' }, { MANDATE_HOME: '' }, { MANDATE_ENV_FILE: '', MANDATE_HOME: '' }]) {
      const r = await run([BIN, 'status'], { cwd: delivery, env: { HOME: home, ...env } })
      const label = JSON.stringify(env)
      assert.match(r.stdout, new RegExp(`env file\\s+${homeEnv.replace(/[.]/g, '\\.')} \\(`), label + r.stdout + r.stderr)
      assert.doesNotMatch(r.stdout, new RegExp(STRANGER), label)
      assert.doesNotMatch(r.stdout + r.stderr, /FRESHNESS CHECK OFF/, label)
      // The home state and pending renders live under is shown, so a split one is visible.
      assert.match(r.stdout, new RegExp(`mandate home\\s+${join(home, '.mandate').replace(/[.]/g, '\\.')} \\(local state`), label)
    }
    const other = await run([BIN, 'status', '--json'], { cwd: delivery, env: { HOME: home, MANDATE_HOME: '~/elsewhere' } })
    assert.equal(JSON.parse(other.stdout).config.mandateHome, join(home, 'elsewhere'), other.stderr)
    for (const env of [{ MANDATE_HOME: '.mandate' }, { MANDATE_ENV_FILE: 'rel/.env' }, { MANDATE_HOME: '~nobody/.mandate' }]) {
      const r = await run([BIN, 'status'], { cwd: delivery, env: { HOME: home, ...env } })
      const label = JSON.stringify(env)
      assert.equal(r.code, 1, label + r.stdout + r.stderr)
      assert.match(r.stderr, /(MANDATE_HOME|MANDATE_ENV_FILE) must be an absolute path/, label)
      assert.doesNotMatch(r.stdout, new RegExp(STRANGER), label)
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

test('B7 follow-up: MANDATE_HOME set in the env file is resolved the same way, and a relative one there exits 1', async () => {
  const { work, home, delivery } = world()
  try {
    const probe = `
      const { loadMandateEnv } = await import(${JSON.stringify(join(ROOT, 'bin', 'config.mjs'))})
      const { defaultStateDir } = await import(${JSON.stringify(join(ROOT, 'src', 'state-store.mjs'))})
      try {
        const l = loadMandateEnv({})
        console.log(JSON.stringify({ home: l.home, state: defaultStateDir() }))
      } catch (e) { console.log(JSON.stringify({ error: e.message, config: e.constructor.name })) }`
    const tildeFile = join(work, 'tilde.env')
    writeFileSync(tildeFile, 'MANDATE_HOME=~/x\n', { mode: 0o600 })
    const ok = await run(['--input-type=module', '-e', probe], { cwd: delivery, env: { HOME: home, MANDATE_ENV_FILE: tildeFile } })
    assert.deepEqual(JSON.parse(ok.stdout), { home: join(home, 'x'), state: join(home, 'x', 'state') }, ok.stderr)
    const relFile = join(work, 'rel.env')
    writeFileSync(relFile, 'MANDATE_HOME=.mandate\n', { mode: 0o600 })
    const bad = await run(['--input-type=module', '-e', probe], { cwd: delivery, env: { HOME: home, MANDATE_ENV_FILE: relFile } })
    const out = JSON.parse(bad.stdout)
    assert.equal(out.config, 'ConfigError', bad.stderr)
    assert.match(out.error, /MANDATE_HOME must be an absolute path[^]*set in the env file .*rel\.env/)
    const cli = await run([BIN, 'status'], { cwd: delivery, env: { HOME: home, MANDATE_ENV_FILE: relFile } })
    assert.equal(cli.code, 1, cli.stdout + cli.stderr)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})
