/**
 * Install the packed tarball the way a stranger would, with no peers, and prove
 * the core works. Tests in this repo run against source; this runs against what
 * npm would actually ship.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = resolve(import.meta.dirname, '..')
const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })

const work = mkdtempSync(join(tmpdir(), 'mandate-smoke-'))
let failed = false
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failed = true
}

try {
  const packed = JSON.parse(sh('npm', ['pack', '--json', '--pack-destination', work], { cwd: repo }))[0]
  const tarball = join(work, packed.filename)
  const shipped = packed.files.map(f => f.path)
  check('tarball built', existsSync(tarball), `${packed.filename}, ${shipped.length} files, ${(packed.size / 1024).toFixed(1)} kB`)
  check('ships no spikes, demo, tests or docs', !shipped.some(p => /^(spikes|demo|test|docs|scripts)\//.test(p)))
  check('ships no .env', !shipped.some(p => /(^|\/)\.env$/.test(p)))
  for (const need of ['src/index.mjs', 'bin/mandate.mjs', 'vocab/mandate.ttl', 'LICENSE', 'README.md']) {
    check(`ships ${need}`, shipped.includes(need))
  }

  const app = join(work, 'app')
  sh('mkdir', ['-p', app])
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'smoke', private: true, type: 'module' }))
  sh('npm', ['install', tarball, '--omit=peer', '--no-audit', '--no-fund'], { cwd: app })

  const nm = join(app, 'node_modules')
  check('no peers installed', !existsSync(join(nm, '@modelcontextprotocol')) && !existsSync(join(nm, '@origintrail-official')))
  const installedDeps = sh('npm', ['ls', '--all', '--parseable', '--omit=peer'], { cwd: app })
    .trim().split('\n').filter(p => p.includes('node_modules')).length
  check('zero transitive dependencies', installedDeps === 1, `${installedDeps} package(s) in node_modules`)

  const core = sh('node', ['--input-type=module', '-e', `
    import { decide, verifyKnowledge, NS, STATE_REVOKED, CLEAR } from 'mandate-consent'
    import { readFileSync } from 'node:fs'
    const grant = { id: 'urn:g', grantor: 'did:a', subject: 's', permitsCapability: ['talking-head'],
      permitsUseClass: [], forbidsUseClass: [], territory: [], maxSpendUsd: 5 }
    const ok = decide({ subject: 's', capability: 'talking-head', at: '2026-09-13T00:00:00Z', estimatedUsd: 1 }, { grants: [grant] })
    const forged = decide({ subject: 's', capability: 'talking-head', at: '2026-09-13T00:00:00Z', estimatedUsd: 1 }, {
      grants: [grant],
      assertions: [
        { stateOf: 'urn:g', state: STATE_REVOKED, stateAuthor: 'did:a', stateAt: '2026-09-12T00:00:00Z' },
        { stateOf: 'urn:g', state: 'active', stateAuthor: 'did:producer', stateAt: '2026-09-12T12:00:00Z' },
      ] })
    const v = verifyKnowledge({ grants: [grant], assertions: [], derivations: [
      { outputSha256: 'h', servedCapability: 'talking-head', authorizedUnder: 'urn:g' }] }, 'h', { now: '2026-09-13T00:00:00Z' })
    const ttl = readFileSync(new URL(import.meta.resolve('mandate-consent/vocab/mandate.ttl')), 'utf8')
    console.log(JSON.stringify({ permit: ok.permit, forgedPermit: forged.permit, forgedClause: forged.clause,
      verdict: v.verdict, clear: CLEAR, ns: NS, ttlHasNs: ttl.includes(NS) }))
  `], { cwd: app })
  const r = JSON.parse(core.trim())
  check('core imports with no peers and permits a valid grant', r.permit === true)
  check('core rejects a forged state assertion', r.forgedPermit === false && r.forgedClause === 'not-revoked')
  check('core verifies from bytes', r.verdict === r.clear)
  check('vocabulary ships under the owned namespace', r.ttlHasNs && r.ns === 'https://oojae.github.io/mandate/ns/v1#')

  let help = ''
  try { sh(join(nm, '.bin', 'mandate'), [], { cwd: app }) } catch (e) { help = (e.stdout || '') + (e.stderr || '') }
  check('bin runs and prints help', /consent rail for generative media/.test(help))

  let peerError = ''
  try { sh('node', ['--input-type=module', '-e', "await import('mandate-consent/livepeer')"], { cwd: app }) }
  catch (e) { peerError = e.stderr || '' }
  check('adapter subpath fails clearly without its optional peer', /@modelcontextprotocol\/sdk/.test(peerError))
} catch (e) {
  console.error((e.stdout || '') + (e.stderr || '') || e.message)
  failed = true
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(failed ? '\nsmoke: FAILED' : '\nsmoke: passed')
process.exit(failed ? 1 : 0)
