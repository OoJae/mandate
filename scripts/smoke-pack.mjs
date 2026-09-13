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
    import { decide, verifyKnowledge, NS, CLEAR, makeSubject } from 'mandate-consent'
    import { readFileSync } from 'node:fs'
    const ANA = '0xed1eeb64cac09874257f05fd6b51a55695ad0b69'
    const PRODUCER = '0x8eaa4857b22dddbfb5ebc476087fec39336e0cb5'
    const subject = makeSubject(ANA, 'ana')
    const grant = { id: 'urn:mandate:grant:' + subject + ':0000000000000001', publisher: ANA, tier: 'vm',
      grantor: 'did:dkg:agent:' + ANA, subject, permitsCapability: ['talking-head'], permitsUseClass: [],
      forbidsUseClass: [], territory: [], validFrom: null, validUntil: null, maxSpendUsd: 5 }
    const k = over => ({ grants: [grant], states: [], derivations: [], forgeries: [], warnings: [], consistency: { ok: true }, ...over })
    const request = { subject, capability: 'talking-head', useClass: 'advertising', territory: 'GB', at: '2026-09-13T00:00:00Z', estimatedUsd: 1 }
    const ok = decide(request, k())
    const forged = decide(request, k({ grants: [{ ...grant, publisher: PRODUCER }] }))
    const unrevoked = decide(request, k({ states: [
      { stateOf: grant.id, state: 'revoked', tier: 'vm', publisher: ANA },
      { stateOf: grant.id, state: 'active', tier: 'vm', publisher: PRODUCER }] }))
    const partial = decide(request, k({ consistency: { ok: false, reason: 'graph omitted' } }))
    const v = verifyKnowledge(k({ derivations: [{ id: 'urn:mandate:derivation:aaaaaaaaaaaaaaaa:0000000000000001',
      outputSha256: 'a'.repeat(64), servedCapability: 'talking-head', authorizedUnder: grant.id, publisher: PRODUCER, trusted: true }] }),
      'a'.repeat(64), { now: '2026-09-13T00:00:00Z' })
    const ttl = readFileSync(new URL(import.meta.resolve('mandate-consent/vocab/mandate.ttl')), 'utf8')
    console.log(JSON.stringify({ permit: ok.permit, forgedClause: forged.clause, unrevokedClause: unrevoked.clause,
      partialClause: partial.clause, verdict: v.verdict, clear: CLEAR, ns: NS, ttlHasNs: ttl.includes(NS) }))
  `], { cwd: app })
  const r = JSON.parse(core.trim())
  check('core imports with no peers and permits a valid grant', r.permit === true)
  check('core refuses a grant published by anyone but its subject', r.forgedClause === 'grant-exists')
  check('core keeps a revocation against a forged "active"', r.unrevokedClause === 'not-revoked')
  check('core refuses on an incomplete read', r.partialClause === 'read-inconsistent')
  check('core verifies from bytes', r.verdict === r.clear)
  check('vocabulary ships under the owned namespace', r.ttlHasNs && r.ns === 'https://oojae.github.io/mandate/ns/v1#')

  let help = ''
  let helpExit = 0
  try { help = sh(join(nm, '.bin', 'mandate'), [], { cwd: app }) } catch (e) { help = (e.stdout || '') + (e.stderr || ''); helpExit = e.status }
  check('bin runs and prints help, exiting 0', helpExit === 0 && /consent rail for generative media/.test(help))
  let usageExit = 0
  try { sh(join(nm, '.bin', 'mandate'), ['revoke'], { cwd: app }) } catch (e) { usageExit = e.status }
  check('a usage error exits 1', usageExit === 1)

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
