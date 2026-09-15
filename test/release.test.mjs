import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { judgeRun, exitCodeFor, runMutant, runQueue, parseArgs, parseShard, selectShard } from '../scripts/mutation-check.mjs'

// --- the mutation check never counts a hang as a kill ---------------------------------

test('mutation check: a timeout is not a kill, and only a failing test is', () => {
  assert.equal(judgeRun({ timedOut: true, code: null, counts: {} }, 1000).status, 'timeout')
  // node's own per-test timeout cancels tests without failing any
  assert.equal(judgeRun({ timedOut: false, code: 1, counts: { fail: 0, cancelled: 2 } }, 1000).status, 'timeout')
  assert.equal(judgeRun({ timedOut: false, code: 1, counts: { fail: 1, cancelled: 2 } }, 1000).status, 'killed')
  assert.equal(judgeRun({ timedOut: false, code: 1, counts: {} }, 1000).status, 'killed')
  assert.equal(judgeRun({ timedOut: false, code: 0, counts: { fail: 0 } }, 1000), null)
})

test('mutation check: a survivor, a timeout, a stale, an invalid or an unfinished entry each fail the run', () => {
  assert.equal(exitCodeFor({}), 0)
  for (const k of ['survived', 'timedOut', 'stale', 'invalid', 'unfinished']) assert.equal(exitCodeFor({ [k]: 1 }), 1, k)
})

test('mutation check: a run stopped by the whole-check budget is unfinished, never killed or a timeout', () => {
  assert.equal(judgeRun({ timedOut: true, outOfBudget: true, code: null, counts: {} }, 1000).status, 'unfinished')
  assert.equal(judgeRun({ timedOut: true, outOfBudget: true, code: 1, counts: { fail: 1 } }, 1000).status, 'unfinished')
  assert.equal(parseArgs(['--budget-minutes', '35']).budgetMs, 35 * 60_000)
  assert.equal(parseArgs([]).budgetMs, null)
  for (const bad of ['0', '-1', '1.5', 'x']) assert.throws(() => parseArgs(['--budget-minutes', bad]), /--budget-minutes/, bad)
})

test('mutation check: runMutant reports a mutant whose tests hang as TIMEOUT, not killed, and restores the source', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mandate-runmutant-'))
  try {
    const source = 'export const mode = "pass"\n'
    writeFileSync(join(dir, 'target.mjs'), source)
    // A live interval keeps the event loop busy, so the test neither finishes nor is
    // cancelled by node: only runMutant's own deadline ends it.
    writeFileSync(join(dir, 'guard.test.mjs'), [
      "import { test } from 'node:test'",
      "import { mode } from './target.mjs'",
      "test('guard', async () => {",
      "  if (mode === 'hang') await new Promise(() => setInterval(() => {}, 1000))",
      "  if (mode === 'fail') throw new Error('guard removed')",
      '})',
      '',
    ].join('\n'))
    const mutant = replace => ({ id: 'm', file: 'target.mjs', guard: 'g', find: '"pass"', replace })
    const slow = new Set()

    const started = Date.now()
    const hung = await runMutant(mutant('"hang"'), dir, ['guard.test.mjs'], 1000, slow)
    assert.equal(hung.status, 'timeout', JSON.stringify(hung))
    // The report names the files that were still running, so a TIMEOUT line is actionable.
    assert.match(hung.detail, /did not finish within 1000ms in guard\.test\.mjs$/)
    assert.ok(Date.now() - started < 30_000, 'the run was cut off at its deadline')
    assert.equal(readFileSync(join(dir, 'target.mjs'), 'utf8'), source)

    assert.equal((await runMutant(mutant('"fail"'), dir, ['guard.test.mjs'], 20_000, slow)).status, 'killed')
    assert.equal((await runMutant(mutant('"other"'), dir, ['guard.test.mjs'], 20_000, slow)).status, 'survived')
    assert.equal(readFileSync(join(dir, 'target.mjs'), 'utf8'), source)

    // The whole-check budget cuts a run short of its own per-phase timeout, as UNFINISHED.
    const cut = Date.now()
    const out = await runMutant(mutant('"hang"'), dir, ['guard.test.mjs'], 20_000, slow, Date.now() + 1000)
    assert.equal(out.status, 'unfinished', JSON.stringify(out))
    assert.ok(Date.now() - cut < 15_000, 'stopped at the budget, not at --timeout-ms')
    assert.equal(readFileSync(join(dir, 'target.mjs'), 'utf8'), source)

    // Once the budget is spent no mutant starts, and a survivor found earlier is still reported.
    const reported = []
    const plan = id => ({ m: { ...mutant('"other"'), id }, tests: ['guard.test.mjs'] })
    await runQueue([plan('a')], [dir], { timeoutMs: 20_000, slow, deadline: Date.now() + 60_000 }, r => reported.push(r))
    await runQueue([plan('b'), plan('c')], [dir], { timeoutMs: 20_000, slow, deadline: Date.now() - 1 }, r => reported.push(r))
    assert.deepEqual(reported.map(r => [r.id, r.status]), [['a', 'survived'], ['b', 'unfinished'], ['c', 'unfinished']])
    assert.match(reported[1].detail, /not started/)
    assert.equal(readFileSync(join(dir, 'target.mjs'), 'utf8'), source)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('mutation check: shards K/N for K = 1..N cover every entry exactly once', () => {
  const list = Array.from({ length: 350 }, (_, i) => i)
  for (let n = 1; n <= 7; n++) {
    const seen = []
    for (let k = 1; k <= n; k++) {
      const part = selectShard(list, parseShard(`${k}/${n}`))
      assert.ok(part.length >= Math.floor(list.length / n) && part.length <= Math.ceil(list.length / n), `${k}/${n}`)
      seen.push(...part)
    }
    assert.deepEqual(seen.sort((a, b) => a - b), list, `N=${n}`)
  }
  assert.deepEqual(selectShard(list, null), list)
  for (const bad of ['0/4', '5/4', '1/0', '4', 'a/b', '1/4x', '']) assert.throws(() => parseShard(bad), /--shard/, bad)
})

// --- workflow structure ----------------------------------------------------------------
// The repository has no YAML parser, so this is a strict one for the subset the
// workflows use: block mappings and sequences, `|` block scalars, flow sequences of
// scalars, quoted and plain scalars, comments. Anything else (anchors, aliases, flow
// mappings, folded scalars, tabs, duplicate keys) throws, so a workflow cannot hide a
// change behind syntax these checks do not read.

function parseWorkflow(src) {
  const raw = src.split('\n')
  const lines = []
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i]
    if (/^\s*(#.*)?$/.test(l)) continue
    if (/^ *\t/.test(l)) throw new Error(`line ${i + 1}: tab indentation`)
    const indent = l.match(/^ */)[0].length
    let text = l.slice(indent)
    let block = null
    if (/(?:^-|:) \|-?\s*$/.test(text)) {
      const body = []
      let j = i + 1
      for (; j < raw.length && (raw[j].trim() === '' || raw[j].match(/^ */)[0].length > indent); j++) body.push(raw[j])
      while (body.length && body[body.length - 1].trim() === '') body.pop()
      const base = Math.min(...body.filter(b => b.trim()).map(b => b.match(/^ */)[0].length))
      block = body.map(b => b.slice(base)).join('\n') + '\n'
      text = text.replace(/\|-?\s*$/, '').trimEnd()
      i = j - 1
    }
    lines.push({ n: i + 1, indent, text, block })
  }
  let pos = 0

  function scalar(t, n) {
    t = t.trim()
    if (/^[&*{>!%@`]/.test(t)) throw new Error(`line ${n}: unsupported syntax ${t}`)
    if (t.startsWith("'")) {
      const m = /^'((?:[^']|'')*)'\s*(#.*)?$/.exec(t)
      if (!m) throw new Error(`line ${n}: bad single-quoted scalar`)
      return m[1].replace(/''/g, "'")
    }
    if (t.startsWith('"')) {
      const m = /^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/.exec(t)
      if (!m) throw new Error(`line ${n}: bad double-quoted scalar`)
      return JSON.parse(`"${m[1]}"`)
    }
    if (t.startsWith('[')) {
      const m = /^\[(.*)\]\s*(#.*)?$/.exec(t)
      if (!m) throw new Error(`line ${n}: bad flow sequence`)
      return m[1].trim() === '' ? [] : m[1].split(',').map(x => {
        const v = scalar(x, n)
        if (typeof v !== 'string') throw new Error(`line ${n}: nested flow sequence`)
        return v
      })
    }
    return t.replace(/\s+#.*$/, '')
  }

  function parseNode(indent) {
    const first = lines[pos]
    if (!first || first.indent !== indent) throw new Error(`line ${first?.n}: expected indent ${indent}`)
    return /^-( |$)/.test(first.text) ? parseSeq(indent) : parseMap(indent)
  }

  function parseSeq(indent) {
    const out = []
    while (pos < lines.length && lines[pos].indent === indent && /^-( |$)/.test(lines[pos].text)) {
      const line = lines[pos]
      const rest = line.text.slice(1).trimStart()
      if (rest === '') {
        pos++
        out.push(parseNode(lines[pos].indent))
      } else if (/^[\w.$-]+:( |$)/.test(rest)) {
        // `- key: value` opens a mapping whose further keys sit at indent + 2
        lines[pos] = { ...line, indent: indent + 2, text: rest }
        out.push(parseMap(indent + 2))
      } else {
        if (line.block !== null) { out.push(line.block); pos++; continue }
        out.push(scalar(rest, line.n))
        pos++
      }
    }
    return out
  }

  function parseMap(indent) {
    const out = {}
    while (pos < lines.length && lines[pos].indent === indent) {
      const line = lines[pos]
      if (/^-( |$)/.test(line.text)) throw new Error(`line ${line.n}: sequence item inside a mapping`)
      const m = /^([\w.$-]+):(?: +(.*))?$/.exec(line.text)
      if (!m) throw new Error(`line ${line.n}: not a key: ${line.text}`)
      const key = m[1]
      if (Object.hasOwn(out, key)) throw new Error(`line ${line.n}: duplicate key ${key}`)
      pos++
      if (line.block !== null) out[key] = line.block
      else if (m[2] !== undefined && m[2].replace(/^#.*$/, '').trim() !== '') out[key] = scalar(m[2], line.n)
      else if (pos < lines.length && lines[pos].indent > indent) out[key] = parseNode(lines[pos].indent)
      else if (pos < lines.length && lines[pos].indent === indent && /^-( |$)/.test(lines[pos].text)) out[key] = parseSeq(indent)
      else out[key] = null
    }
    return out
  }

  const doc = parseMap(0)
  if (pos !== lines.length) throw new Error(`line ${lines[pos].n}: not read (indentation)`)
  return doc
}

const releaseText = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
const ciText = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const release = parseWorkflow(releaseText)
const ci = parseWorkflow(ciText)

/** Every value under `node`, with the key it sits under. */
function* walk(node, key = null) {
  yield [key, node]
  if (Array.isArray(node)) for (const v of node) yield* walk(v, key)
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) yield* walk(v, k)
}
const runsOf = job => job.steps.filter(s => 'run' in s).map(s => s.run)
const actionOf = step => step.uses?.split('@')[0]
const shellLines = run => run.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))

test('workflow parser: reads the subset, and refuses syntax it does not model', () => {
  assert.deepEqual(parseWorkflow('a:\n  b: [x, \'y\']\n  c: |\n    one\n    two\n  d:\n  - e: 1\n    f: "g # h" # c\n'),
    { a: { b: ['x', 'y'], c: 'one\ntwo\n', d: [{ e: '1', f: 'g # h' }] } })
  for (const bad of ['a: 1\na: 2\n', 'a: &x 1\n', 'a: *x\n', 'a: {b: 1}\n', 'a: >\n  x\n', 'a:\n  b: 1\n c: 2\n', 'a:\n\tb: 1\n']) {
    assert.throws(() => parseWorkflow(bad), undefined, JSON.stringify(bad))
  }
  assert.deepEqual(Object.keys(release.jobs), ['pack', 'test', 'publish'])
  assert.deepEqual(Object.keys(ci.jobs), ['test', 'mutation'])
})

test('workflows: every action is pinned to a commit, and no checkout keeps credentials', () => {
  for (const [name, wf] of [['release', release], ['ci', ci]]) {
    const uses = [...walk(wf)].filter(([k]) => k === 'uses').map(([, v]) => v)
    assert.ok(uses.length > 0)
    for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/, `${name}: ${u}`)
    for (const job of Object.values(wf.jobs)) {
      for (const step of job.steps) {
        if (actionOf(step) === 'actions/checkout') assert.equal(step.with?.['persist-credentials'], 'false', `${name}: checkout keeps credentials`)
      }
    }
  }
})

// Keys a workflow may use at each level. Anything else is refused rather than
// ignored: `env` (npm_config_script_shell=true makes `npm test` exit 0 without
// running a test, NODE_OPTIONS can preload code, a token can be added),
// `working-directory` (runs the step somewhere else), `container` and `services`
// (other images next to id-token), `defaults`, `shell` and `continue-on-error`
// (drop bash -e or hide a failure) all change what a step does without changing
// the command these checks read.
const WORKFLOW_KEYS = ['name', 'on', 'permissions', 'jobs']
const JOB_KEYS = ['runs-on', 'needs', 'permissions', 'outputs', 'environment', 'strategy', 'timeout-minutes', 'if', 'steps']
const STEP_KEYS = ['name', 'id', 'uses', 'with', 'run', 'env']
const WITH_KEYS = {
  'actions/checkout': ['persist-credentials'],
  'actions/setup-node': ['node-version', 'registry-url'],
  'actions/upload-artifact': ['name', 'path', 'if-no-files-found', 'retention-days'],
  'actions/download-artifact': ['artifact-ids', 'path', 'merge-multiple'],
}
// The only step environment: pack's outputs, read by the digest checks and the publish.
const STEP_ENV = { TARBALL: '${{ needs.pack.outputs.tarball }}', SHA256: '${{ needs.pack.outputs.sha256 }}' }
const subset = (keys, allowed, what) => {
  for (const k of keys) assert.ok(allowed.includes(k), `${what}: ${k} is not allowed`)
}

/**
 * Shell that can hide a failing command. bash -e ignores the exit status of every
 * pipeline stage but the last, of `a || b`, of `a; b` on one line when a is a test
 * (`if`), of background jobs, and of anything after `set +e`. The only pipes
 * allowed end in a stage that fails itself when its input is wrong or that only
 * counts or cuts text whose value is then compared.
 */
const PIPE_ENDS = ['sha256sum --check --strict', 'wc -l', "cut -d' ' -f1"]
function failOpen(run) {
  const found = []
  for (const line of shellLines(run)) {
    if (/\|\|/.test(line)) found.push(`|| in ${line}`)
    if (/(^|[^&>])&($|[^&>])/.test(line)) found.push(`background job in ${line}`)
    // A later step would inherit it: npm_config_script_shell, NODE_OPTIONS, a PATH entry.
    if (/GITHUB_ENV|GITHUB_PATH|\.npmrc/.test(line)) found.push(`environment for later steps in ${line}`)
    if (/\bset\s+[+-]/.test(line)) found.push(`set in ${line}`)
    if (/\b(trap|nohup|disown|eval|exec)\b/.test(line)) found.push(`${line}`)
    if (/^(?:true|:|exit 0)$|;\s*(?:true|:|exit 0)$|\bexit 0\b/.test(line)) found.push(`success forced in ${line}`)
    for (const m of line.matchAll(/(?<!\|)\|(?!\|)([^|)]*)/g)) {
      const stage = m[1].replace(/"\s*=.*$/, '').replace(/["\s]+$/, '').trim()
      if (!PIPE_ENDS.includes(stage)) found.push(`pipe into ${stage} in ${line}`)
    }
  }
  return found
}

test('workflow shell check: refuses constructs that hide a failure, and allows the digest pipes', () => {
  for (const bad of ['echo npm_config_script_shell=true >> "$GITHUB_ENV"', 'echo script-shell=true >> .npmrc', 'npm test | tee test.log', 'npm test || true', 'npm test || exit 0', 'npm test &', 'set +e\nnpm test', 'set +o pipefail', 'trap "exit 0" EXIT', 'npm test; true', 'true', ':', 'exit 0', 'npm test | cat', 'npm test | sha256sum', 'eval "$CMD"']) {
    assert.notDeepEqual(failOpen(bad), [], JSON.stringify(bad))
  }
  for (const good of ['npm test', 'echo "${SHA256}  dist/${TARBALL}" | sha256sum --check --strict', 'test "$(ls dist | wc -l)" = 1',
    'echo "sha256=$(sha256sum "dist/${tarball}" | cut -d\' \' -f1)" >> "$GITHUB_OUTPUT"', 'tarball="$(cd dist && ls *.tgz)"', 'if [ -n "$changes" ]; then', 'node x.mjs 2>&1']) {
    assert.deepEqual(failOpen(good), [], good)
  }
})

test('workflows: no step or job can fail open, run elsewhere, or run with another environment', () => {
  for (const [name, wf] of [['release', release], ['ci', ci]]) {
    subset(Object.keys(wf), WORKFLOW_KEYS, name)
    for (const [k] of walk(wf)) {
      // continue-on-error hides a failure; shell or defaults can drop bash -e.
      assert.ok(!['continue-on-error', 'shell', 'defaults', 'working-directory', 'container', 'services'].includes(k), `${name}: ${k}`)
    }
    for (const [jobName, job] of Object.entries(wf.jobs)) {
      const where = `${name}/${jobName}`
      subset(Object.keys(job), JOB_KEYS, where)
      assert.equal(job['runs-on'], 'ubuntu-latest', where)
      subset(Object.keys(job.strategy ?? {}), ['fail-fast', 'matrix'], `${where} strategy`)
      for (const step of job.steps) {
        subset(Object.keys(step), STEP_KEYS, `${where} step`)
        assert.ok(('uses' in step) !== ('run' in step), `${where}: a step must have exactly one of uses and run`)
        if ('with' in step) subset(Object.keys(step.with), WITH_KEYS[actionOf(step)] ?? [], `${where} ${actionOf(step)} with`)
        if ('env' in step) {
          assert.ok('run' in step, `${where}: env on an action`)
          for (const [k, v] of Object.entries(step.env)) assert.equal(v, STEP_ENV[k], `${where}: step env ${k}`)
        }
        assert.ok(!('if' in step), `${where}: a step has if:`)
      }
      for (const run of runsOf(job)) assert.deepEqual(failOpen(run), [], `${where}: ${run}`)
    }
  }
  assert.deepEqual(Object.keys(ci.jobs.test.strategy.matrix), ['node'])
  assert.deepEqual(Object.keys(ci.jobs.mutation.strategy.matrix), ['shard'])
  for (const [name, job] of Object.entries(release.jobs)) {
    assert.ok(!('if' in job), 'a release job has if:')
    assert.ok(!('strategy' in job) && !('timeout-minutes' in job), name)
    assert.equal('environment' in job, name === 'publish', `${name}: environment`)
  }
  assert.ok(!('if' in ci.jobs.test))
  assert.ok(!('environment' in ci.jobs.test) && !('environment' in ci.jobs.mutation))
  assert.equal(ci.jobs.mutation.if, "github.event_name == 'pull_request'")
})

test('release: every job pins the same exact Node release, and the comment says which', () => {
  const versions = Object.entries(release.jobs).map(([name, job]) => {
    const setup = job.steps.filter(s => actionOf(s) === 'actions/setup-node')
    assert.equal(setup.length, 1, name)
    return setup[0].with['node-version']
  })
  assert.equal(versions.length, 3)
  // A major like '24' resolves separately in each job, so pack and test could pack with different npms.
  assert.match(versions[0], /^\d+\.\d+\.\d+$/)
  assert.deepEqual(versions, versions.map(() => versions[0]))
  assert.match(releaseText, new RegExp(`\n *#[^\n]*\\b${versions[0].replaceAll('.', '\\.')}\\b`), 'the comment names the pinned release')
})

test('release: only publish can mint a token, in the npm environment, after pack and test', () => {
  assert.deepEqual(release.permissions, { contents: 'read' })
  assert.deepEqual(release.on, { push: { tags: ['v*'] } })
  for (const [name, job] of Object.entries(release.jobs)) {
    const perms = [...walk(job)].filter(([k]) => k === 'id-token')
    if (name === 'publish') assert.deepEqual(job.permissions, { contents: 'read', 'id-token': 'write' })
    else {
      assert.deepEqual(job.permissions, { contents: 'read' }, name)
      assert.deepEqual(perms, [], name)
    }
  }
  assert.ok(!('needs' in release.jobs.pack))
  assert.equal([release.jobs.test.needs].flat().join(','), 'pack')
  assert.deepEqual(release.jobs.publish.needs, ['pack', 'test'])
  assert.equal(release.jobs.publish.environment, 'npm')
  assert.deepEqual([...walk(ci)].filter(([k]) => k === 'id-token'), [])
  assert.deepEqual(ci.permissions, { contents: 'read' })
})

test('release: pack runs nothing but the pack, after refusing lifecycle scripts', () => {
  const pack = release.jobs.pack
  assert.deepEqual(pack.steps.map(s => actionOf(s) ?? s.name), [
    // names here, but every run is compared in full below
    'actions/checkout', 'actions/setup-node', 'Tag matches package.json',
    'The package has no lifecycle scripts to skip', 'Pack', 'actions/upload-artifact',
  ])
  assert.ok(!('cache' in pack.steps[1].with), 'no dependency cache in a release build')
  const [tag, lifecycle, packRun] = runsOf(pack)
  assert.equal(tag, 'test "v$(node -p "require(\'./package.json\').version")" = "${GITHUB_REF_NAME}"')
  assert.match(lifecycle, /^node -e '[^']*'\n$/)
  assert.deepEqual(shellLines(packRun), [
    'mkdir dist',
    'npm pack --ignore-scripts --pack-destination dist',
    'test "$(ls dist/*.tgz | wc -l)" = 1',
    'tarball="$(cd dist && ls *.tgz)"',
    'echo "tarball=${tarball}" >> "$GITHUB_OUTPUT"',
    'echo "sha256=$(sha256sum "dist/${tarball}" | cut -d\' \' -f1)" >> "$GITHUB_OUTPUT"',
  ])
  assert.ok(pack.steps.every(s => !('env' in s)), 'pack steps take no environment')
  assert.deepEqual(pack.steps[5].with, { name: 'package', path: 'dist/*.tgz', 'if-no-files-found': 'error', 'retention-days': '7' })
})

test('release: the lifecycle guard really refuses every lifecycle script', () => {
  const js = /^node -e '([^']*)'\n$/.exec(runsOf(release.jobs.pack)[1])[1]
  const dir = mkdtempSync(join(tmpdir(), 'mandate-lifecycle-'))
  try {
    const guard = scripts => {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts }))
      return spawnSync(process.execPath, ['-e', js], { cwd: dir, encoding: 'utf8' })
    }
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack', 'prepublish', 'prepublishOnly', 'publish', 'postpublish']) {
      const r = guard({ [hook]: 'echo hi' })
      assert.equal(r.status, 1, hook)
      assert.match(r.stderr, new RegExp(`lifecycle scripts: ${hook}`))
    }
    assert.equal(guard({ test: 'node --test' }).status, 0)
    assert.equal(guard(undefined).status, 0)
    // The real package passes it.
    assert.equal(spawnSync(process.execPath, ['-e', js], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }).status, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('release: test repacks and checks the digest before installing, then installs without scripts and tests', () => {
  const t = release.jobs.test
  // The command, never the name: `name: npm test` over `run: npm test | tee log` is still the pipe.
  assert.deepEqual(t.steps.map(s => actionOf(s) ?? s.run), [
    'actions/checkout', 'actions/setup-node', t.steps[2].run,
    'npm ci --ignore-scripts', 'npm test', 'node scripts/smoke-pack.mjs',
  ])
  const repack = t.steps[2]
  assert.equal(repack.name, 'This checkout packs to the tarball pack produced')
  assert.deepEqual(repack.env, { TARBALL: '${{ needs.pack.outputs.tarball }}', SHA256: '${{ needs.pack.outputs.sha256 }}' })
  assert.deepEqual(shellLines(repack.run), [
    'mkdir "${RUNNER_TEMP}/repack"',
    'npm pack --ignore-scripts --pack-destination "${RUNNER_TEMP}/repack"',
    'echo "${SHA256}  ${RUNNER_TEMP}/repack/${TARBALL}" | sha256sum --check --strict',
  ])
  assert.ok(!('outputs' in t))
  assert.ok(!t.steps.some(s => /upload-artifact|cache/.test(actionOf(s) ?? '')))
})

test('release: publish installs nothing from the project and publishes the checked tarball', () => {
  const p = release.jobs.publish
  assert.deepEqual(p.steps.map(s => actionOf(s) ?? s.name), [
    'actions/setup-node', 'actions/download-artifact', 'Tarball is the one pack produced', 'npm, pinned', 'Publish',
  ])
  assert.deepEqual(runsOf(p), [p.steps[2].run, p.steps[3].run, p.steps[4].run])
  assert.deepEqual(p.steps[4].env, { TARBALL: '${{ needs.pack.outputs.tarball }}' })
  assert.deepEqual(Object.keys(p.steps[0].with).sort(), ['node-version', 'registry-url'])
  assert.equal(p.steps[0].with['registry-url'], 'https://registry.npmjs.org')
  assert.deepEqual(p.steps[1].with, { 'artifact-ids': '${{ needs.pack.outputs.artifact-id }}', path: 'dist', 'merge-multiple': 'true' })
  assert.deepEqual(shellLines(p.steps[2].run), [
    'test "$(ls dist | wc -l)" = 1',
    'echo "${SHA256}  dist/${TARBALL}" | sha256sum --check --strict',
  ])
  assert.deepEqual(p.steps[2].env, { TARBALL: '${{ needs.pack.outputs.tarball }}', SHA256: '${{ needs.pack.outputs.sha256 }}' })
  assert.equal(p.steps[3].run, 'npm install --global --ignore-scripts npm@11.19.1')
  assert.equal(p.steps[4].run, 'npm publish "dist/${TARBALL}" --provenance --access public --ignore-scripts')
})

test('ci: installs run no scripts, and the test and mutation jobs run what they claim', () => {
  const t = ci.jobs.test
  assert.deepEqual(t.steps.map(s => actionOf(s) ?? s.run), [
    'actions/checkout', 'actions/setup-node', 'npm ci --ignore-scripts', 'npm test',
    t.steps[4].run, 'node scripts/smoke-pack.mjs', 'npm audit --omit=dev --omit=peer',
  ])
  assert.equal(t.steps[4].name, 'Namespace documents are current')
  // Its behaviour is run below; here, that it holds nothing else.
  assert.deepEqual(shellLines(t.steps[4].run), [
    'node scripts/build-vocab-docs.mjs',
    'changes="$(git status --porcelain --untracked-files=all -- docs/ns)"',
    'if [ -n "$changes" ]; then',
    'echo "docs/ns is not what scripts/build-vocab-docs.mjs generates; run it and commit:"',
    'echo "$changes"',
    'git diff -- docs/ns',
    'exit 1',
    'fi',
  ])
  assert.ok(!('continue-on-error' in (t.strategy ?? {})))

  assert.ok(t.steps.every(s => !('env' in s)), 'ci test steps take no environment')

  const m = ci.jobs.mutation
  assert.deepEqual(m.steps.map(s => actionOf(s) ?? s.run), ['actions/checkout', 'actions/setup-node', 'npm ci --ignore-scripts', m.steps[3].run])
  assert.ok(m.steps.every(s => !('env' in s)), 'mutation steps take no environment')
  const args = /^npm run test:mutation -- --jobs (\d+) --timeout-ms (\d+) --budget-minutes (\d+) --shard \$\{\{ matrix\.shard \}\}\/(\d+)$/.exec(m.steps[3].run)
  assert.ok(args, m.steps[3].run)
  const [jobs, timeoutMs, budgetMinutes, count] = args.slice(1).map(Number)
  // Every shard listed, so no part of scripts/mutations.json is silently skipped.
  assert.deepEqual(m.strategy.matrix.shard, Array.from({ length: count }, (_, i) => String(i + 1)))
  assert.equal(m.strategy['fail-fast'], 'false')

  // Sizing for a 4-vCPU ubuntu-latest runner. The CLI phase of one mutant takes about
  // 70 s locally; about one mutant in nine reaches it, and up to one in seven in a shard.
  const total = JSON.parse(readFileSync(new URL('../scripts/mutations.json', import.meta.url), 'utf8')).mutants.length
  const jobMinutes = Number(m['timeout-minutes'])
  assert.equal(jobs, 2, 'two workers on four vCPUs')
  assert.ok(Math.ceil(total / count) <= 60, `${Math.ceil(total / count)} mutants per shard; add shards`)
  // A phase timeout close to the CLI phase would turn a slow runner into TIMEOUTs.
  assert.ok(timeoutMs >= 4 * 70_000, `--timeout-ms ${timeoutMs}`)
  // One mutant whose two phases both run to the timeout still fits in the budget.
  assert.ok(2 * timeoutMs / 60_000 < budgetMinutes, 'budget below one mutant')
  // The check stops itself and prints its summary, survivors included, before the job is killed.
  assert.ok(budgetMinutes + 5 <= jobMinutes, `budget ${budgetMinutes} min, job ${jobMinutes} min`)
  // Heaviest shard at local speed: its share of the CLI mutants at 70 s, the rest at 5 s,
  // two workers and a baseline, three times over for a slower runner, inside the budget.
  const perShard = Math.ceil(total / count)
  const cli = Math.ceil(perShard / 7)
  const estimate = 3 * ((cli * 70 + (perShard - cli) * 5) / 2 + 70) / 60
  assert.ok(estimate < budgetMinutes, `a shard is estimated at ${estimate.toFixed(1)} min`)
  // The sizing comment names roughly the real count.
  const claimed = Number(/# About (\d+) mutants/.exec(ciText)?.[1])
  assert.ok(Math.abs(claimed - total) <= 50, `the ci.yml comment says about ${claimed} mutants; there are ${total}`)
})

test('ci: the namespace documents check fails on a modified or untracked file, and passes when current', () => {
  const run = ci.jobs.test.steps[4].run
  assert.match(run, /^node scripts\/build-vocab-docs\.mjs\n/)
  const git = spawnSync('git', ['--version'])
  const bash = spawnSync('bash', ['--version'])
  if (git.status !== 0 || bash.status !== 0) throw new Error('this test needs git and bash')
  const dir = mkdtempSync(join(tmpdir(), 'mandate-docs-check-'))
  try {
    const sh = (cmd, env = {}) => spawnSync('bash', ['-e', '-c', cmd], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
    mkdirSync(join(dir, 'scripts'))
    mkdirSync(join(dir, 'docs/ns/v1'), { recursive: true })
    // The generator stand-in rewrites or adds a file only when told to.
    writeFileSync(join(dir, 'scripts/build-vocab-docs.mjs'), [
      "import { mkdirSync, writeFileSync } from 'node:fs'",
      "if (process.env.GEN === 'modify') writeFileSync('docs/ns/v1/a.ttl', 'changed\\n')",
      "if (process.env.GEN === 'add') { mkdirSync('docs/ns/v1/9.9.9', { recursive: true }); writeFileSync('docs/ns/v1/9.9.9/a.ttl', 'new\\n') }",
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'docs/ns/v1/a.ttl'), 'original\n')
    const setup = sh('git init -q . && git add -A && git -c user.name=t -c user.email=t@example.invalid commit -q -m init')
    assert.equal(setup.status, 0, setup.stderr)

    assert.equal(sh(run).status, 0, 'current documents pass')
    const modified = sh(run, { GEN: 'modify' })
    assert.notEqual(modified.status, 0, 'a modified document fails')
    assert.match(modified.stdout, /docs\/ns is not what/)
    assert.equal(sh('git checkout -q -- docs/ns').status, 0)
    const added = sh(run, { GEN: 'add' })
    assert.notEqual(added.status, 0, 'an untracked document fails')
    assert.match(added.stdout, /9\.9\.9\/a\.ttl/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
