#!/usr/bin/env node
/**
 * Mutation check: prove the test suite notices when a security guard is removed.
 *
 *   node scripts/mutation-check.mjs [--only id,id…] [--jobs N] [--timeout-ms N]
 *                                   [--mutations file] [--json out.json] [--list] [--keep]
 *
 * Each entry in scripts/mutations.json names one guard: a file, an exact piece
 * of source (`find`) and what to put in its place (`replace`). For every entry
 * the repository is copied to a temporary directory (the real checkout is never
 * touched), the one replacement is applied, and the test files that can reach
 * the mutated module are run. A mutant is killed when a test fails. The check
 * fails when any mutant survives, because then a guard can be deleted and CI
 * stays green.
 *
 * It also fails when an entry is stale: `find` no longer occurs exactly once,
 * or the replacement does not parse. A refactor must update the list rather
 * than quietly drop a guard from it.
 *
 * Test selection follows relative imports and path strings from each test file
 * (including `${SRC}gate.mjs` style dynamic imports and spawned bin scripts) to
 * every module it can reach. An entry may name its own `tests` instead. Files
 * listed under `slowTests` run only for a mutant the other files did not kill,
 * so the CLI suite is not paid for every mutant.
 */
import { spawn } from 'node:child_process'
import {
  cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

const repo = resolve(import.meta.dirname, '..')

/* ------------------------------------------------------------------------- */
/* Arguments                                                                   */
/* ------------------------------------------------------------------------- */

function parseArgs(argv) {
  const o = { only: null, jobs: null, timeoutMs: 300_000, mutations: join(repo, 'scripts/mutations.json'), json: null, list: false, keep: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`)
      return argv[++i]
    }
    if (a === '--only') o.only = next().split(',').map(s => s.trim()).filter(Boolean)
    else if (a === '--jobs') o.jobs = Number(next())
    else if (a === '--timeout-ms') o.timeoutMs = Number(next())
    else if (a === '--mutations') o.mutations = resolve(next())
    else if (a === '--json') o.json = resolve(next())
    else if (a === '--list') o.list = true
    else if (a === '--keep') o.keep = true
    else throw new Error(`unknown option ${a}`)
  }
  if (o.jobs !== null && (!Number.isInteger(o.jobs) || o.jobs < 1)) throw new Error('--jobs must be a whole number of at least 1')
  if (!Number.isInteger(o.timeoutMs) || o.timeoutMs < 1000) throw new Error('--timeout-ms must be a whole number of at least 1000')
  return o
}

/* ------------------------------------------------------------------------- */
/* Which tests can reach which modules                                         */
/* ------------------------------------------------------------------------- */

const SOURCE_DIRS = ['src', 'bin', 'test']

function listMjs(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...listMjs(p))
    else if (name.endsWith('.mjs')) out.push(p)
  }
  return out
}

/**
 * Modules one file refers to, as repo-relative paths. Over-approximates on
 * purpose: running an extra test file costs time, missing one hides a survivor.
 */
function references(file, known) {
  const text = readFileSync(file, 'utf8')
  const found = new Set()
  const add = p => { const r = relative(repo, p); if (known.has(r)) found.add(r) }
  for (const m of text.matchAll(/['"`](\.{1,2}\/[\w./-]+\.mjs)['"`]/g)) add(resolve(dirname(file), m[1]))
  // new URL('../src/', import.meta.url) plus `${SRC}gate.mjs`
  const bases = [...text.matchAll(/['"`](\.{1,2}\/[\w./-]*\/)['"`]/g)].map(m => resolve(dirname(file), m[1]))
  for (const m of text.matchAll(/\$\{[\w.]+\}([\w-]+\.mjs)/g)) for (const b of bases) add(join(b, m[1]))
  return found
}

function dependencyMap() {
  const files = SOURCE_DIRS.flatMap(d => listMjs(join(repo, d)))
  const known = new Set(files.map(f => relative(repo, f)))
  const edges = new Map(files.map(f => [relative(repo, f), references(f, known)]))
  const reach = start => {
    const seen = new Set([start])
    const stack = [start]
    while (stack.length) for (const n of edges.get(stack.pop()) ?? []) if (!seen.has(n)) { seen.add(n); stack.push(n) }
    return seen
  }
  const tests = [...known].filter(f => /^test\/[^/]+\.test\.mjs$/.test(f)).sort()
  return { tests, reach: new Map(tests.map(t => [t, reach(t)])) }
}

function testsFor(mutant, deps) {
  if (Array.isArray(mutant.tests) && mutant.tests.length) return mutant.tests
  const hit = deps.tests.filter(t => deps.reach.get(t).has(mutant.file))
  // A module no test reaches is a guard nothing protects: run everything so the survivor is real.
  return hit.length ? hit : deps.tests
}

/* ------------------------------------------------------------------------- */
/* Mutants                                                                     */
/* ------------------------------------------------------------------------- */

function loadMutants(path) {
  const list = JSON.parse(readFileSync(path, 'utf8'))
  const mutants = Array.isArray(list) ? list : list.mutants
  const slowTests = Array.isArray(list?.slowTests) ? list.slowTests : []
  if (!Array.isArray(mutants)) throw new Error(`${path} must hold a list of mutants`)
  const ids = new Set()
  for (const m of mutants) {
    for (const k of ['id', 'file', 'find', 'guard']) if (typeof m[k] !== 'string' || !m[k]) throw new Error(`mutant ${JSON.stringify(m.id ?? m)} has no ${k}`)
    if (typeof m.replace !== 'string') throw new Error(`mutant ${m.id} has no replace`)
    if (m.find === m.replace) throw new Error(`mutant ${m.id} replaces its text with the same text`)
    if (ids.has(m.id)) throw new Error(`mutant id ${m.id} is used twice`)
    ids.add(m.id)
  }
  return { mutants, slowTests }
}

const occurrences = (text, needle) => {
  let n = 0
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) n++
  return n
}

/** Why a mutant cannot be applied to the current source, or null. */
function staleness(m) {
  const p = join(repo, m.file)
  if (!existsSync(p)) return `${m.file} does not exist`
  const n = occurrences(readFileSync(p, 'utf8'), m.find)
  if (n === 0) return `its search text is no longer in ${m.file}`
  if (n > 1) return `its search text occurs ${n} times in ${m.file}; make it unique`
  return null
}

/* ------------------------------------------------------------------------- */
/* Running                                                                     */
/* ------------------------------------------------------------------------- */

/** A copy of the repository to mutate. node_modules is linked, never copied; .env and .git stay behind. */
function makeCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'mandate-mutation-'))
  const skip = new Set(['node_modules', '.git', '.env', '.env.local'])
  for (const name of readdirSync(repo)) {
    if (skip.has(name)) continue
    cpSync(join(repo, name), join(dir, name), { recursive: true, filter: src => !/[/\\]spikes[/\\]out([/\\]|$)/.test(src) })
  }
  if (existsSync(join(repo, 'node_modules'))) symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'), 'dir')
  return dir
}

/** Environment for a test run: nothing that would point tests at live nodes or other sources. */
function testEnv() {
  const env = { ...process.env, NO_COLOR: '1' }
  for (const k of Object.keys(env)) if (k.startsWith('MANDATE_')) delete env[k]
  return env
}

function run(cmd, args, { cwd, timeoutMs }) {
  return new Promise(done => {
    const started = Date.now()
    const child = spawn(cmd, args, { cwd, env: testEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    let output = ''
    const keep = d => { output = (output + d).slice(-20_000) }
    child.stdout.on('data', keep)
    child.stderr.on('data', keep)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') }
    }, timeoutMs)
    child.on('close', code => {
      clearTimeout(timer)
      done({ code, timedOut, output, ms: Date.now() - started })
    })
  })
}

async function runMutant(m, copy, tests, timeoutMs, slow) {
  const path = join(copy, m.file)
  const original = readFileSync(path, 'utf8')
  const at = original.indexOf(m.find)
  const mutated = original.slice(0, at) + m.replace + original.slice(at + m.find.length)
  writeFileSync(path, mutated)
  try {
    // A mutant that does not parse would be "killed" by any test; that says nothing about the guard.
    const check = await run(process.execPath, ['--check', m.file], { cwd: copy, timeoutMs: 30_000 })
    if (check.code !== 0) return { status: 'invalid', ms: check.ms, detail: check.output.trim().split('\n').slice(0, 4).join(' | ') }
    // Fast files first; slow ones only for a mutant the fast ones did not kill.
    const phases = [tests.filter(t => !slow.has(t)), tests.filter(t => slow.has(t))].filter(p => p.length)
    let ms = check.ms
    for (const files of phases) {
      const r = await run(process.execPath, ['--test', ...files], { cwd: copy, timeoutMs })
      ms += r.ms
      if (r.timedOut) return { status: 'killed', ms, detail: `the tests did not finish within ${timeoutMs}ms` }
      if (r.code !== 0) {
        const fails = r.output.match(/ℹ fail (\d+)/)?.[1]
        const failing = [...r.output.matchAll(/^not ok \d+ - (.+)$/gm)].map(m => m[1]).slice(0, 3)
        return { status: 'killed', ms, detail: `${fails ? `${fails} failing test(s)` : `exit ${r.code}`}${failing.length ? `: ${failing.join('; ').slice(0, 160)}` : ''}`, files }
      }
    }
    return { status: 'survived', ms, detail: '' }
  } finally {
    writeFileSync(path, original)
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  const { mutants: all, slowTests } = loadMutants(o.mutations)
  const slow = new Set(slowTests)
  let mutants = all
  if (o.only) {
    const unknown = o.only.filter(id => !mutants.some(m => m.id === id))
    if (unknown.length) throw new Error(`no mutant named ${unknown.join(', ')}`)
    mutants = mutants.filter(m => o.only.includes(m.id))
  }
  const deps = dependencyMap()
  const plan = mutants.map(m => ({ m, tests: testsFor(m, deps), stale: staleness(m) }))

  if (o.list) {
    for (const { m, tests, stale } of plan) console.log(`${m.id}\n  ${m.file}: ${m.guard}\n  tests: ${tests.join(' ')}${stale ? `\n  STALE: ${stale}` : ''}`)
    return 0
  }

  const stale = plan.filter(p => p.stale)
  const runnable = plan.filter(p => !p.stale)
  const jobs = Math.min(o.jobs ?? Math.max(1, Math.ceil(availableParallelism() / 2)), Math.max(1, runnable.length))
  console.log(`mutation check: ${runnable.length} mutant(s), ${stale.length} stale, ${jobs} worker(s)`)
  for (const p of stale) console.log(`STALE     ${p.m.id} — ${p.stale}`)

  const copies = Array.from({ length: jobs }, makeCopy)
  const results = []
  let baselineFailed = null
  try {
    // Unmutated first: a suite that already fails, or cannot run here, would make every mutant look killed.
    const baselineTests = [...new Set(runnable.flatMap(p => p.tests))].sort()
    if (baselineTests.length) {
      const b = await run(process.execPath, ['--test', ...baselineTests], { cwd: copies[0], timeoutMs: o.timeoutMs })
      console.log(`baseline  ${b.code === 0 && !b.timedOut ? 'passes' : 'FAILS'} (${(b.ms / 1000).toFixed(1)}s, ${baselineTests.length} test files)`)
      if (b.code !== 0 || b.timedOut) baselineFailed = b.output.slice(-4000)
    }
    if (!baselineFailed) {
      const queue = [...runnable]
      await Promise.all(copies.map(async copy => {
        for (let p = queue.shift(); p; p = queue.shift()) {
          const r = await runMutant(p.m, copy, p.tests, o.timeoutMs, slow)
          results.push({ id: p.m.id, file: p.m.file, guard: p.m.guard, tests: p.tests, ...r })
          const label = { killed: 'killed   ', survived: 'SURVIVED ', invalid: 'INVALID  ' }[r.status]
          console.log(`${label} ${p.m.id} (${(r.ms / 1000).toFixed(1)}s${r.detail ? `, ${r.detail}` : ''})${r.status === 'killed' ? '' : `\n          ${p.m.file}: ${p.m.guard}`}`)
        }
      }))
    }
  } finally {
    if (o.keep) console.log(`copies kept in ${copies.join(' ')}`)
    else for (const c of copies) rmSync(c, { recursive: true, force: true })
  }

  const survived = results.filter(r => r.status === 'survived')
  const invalid = results.filter(r => r.status === 'invalid')
  if (o.json) {
    writeFileSync(o.json, `${JSON.stringify({
      baselineFailed: Boolean(baselineFailed), stale: stale.map(p => ({ id: p.m.id, file: p.m.file, reason: p.stale })),
      results: results.sort((a, b) => a.id.localeCompare(b.id)),
    }, null, 2)}\n`)
  }
  if (baselineFailed) {
    console.log(`\nThe unmutated test suite fails in the copy, so no mutant can be judged:\n${baselineFailed}`)
    return 2
  }
  console.log(`\n${results.length - survived.length - invalid.length} killed, ${survived.length} survived, ${invalid.length} invalid, ${stale.length} stale`)
  if (survived.length) console.log(`A guard can be removed without any test failing: ${survived.map(r => r.id).join(', ')}`)
  if (stale.length || invalid.length) console.log('Update scripts/mutations.json so every entry applies once and still parses.')
  return survived.length || stale.length || invalid.length ? 1 : 0
}

main().then(code => { process.exitCode = code }, e => {
  console.error(`mutation check could not run: ${e.message}`)
  process.exitCode = 2
})
