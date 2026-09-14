import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { judgeRun, exitCodeFor } from '../scripts/mutation-check.mjs'

// --- the mutation check never counts a hang as a kill ---------------------------------

test('mutation check: a timeout is not a kill, and only a failing test is', () => {
  assert.equal(judgeRun({ timedOut: true, code: null, counts: {} }, 1000).status, 'timeout')
  // node's own per-test timeout cancels tests without failing any
  assert.equal(judgeRun({ timedOut: false, code: 1, counts: { fail: 0, cancelled: 2 } }, 1000).status, 'timeout')
  assert.equal(judgeRun({ timedOut: false, code: 1, counts: { fail: 1, cancelled: 2 } }, 1000).status, 'killed')
  assert.equal(judgeRun({ timedOut: false, code: 1, counts: {} }, 1000).status, 'killed')
  assert.equal(judgeRun({ timedOut: false, code: 0, counts: { fail: 0 } }, 1000), null)
})

test('mutation check: a survivor, a timeout, a stale or an invalid entry each fail the run', () => {
  assert.equal(exitCodeFor({}), 0)
  for (const k of ['survived', 'timedOut', 'stale', 'invalid']) assert.equal(exitCodeFor({ [k]: 1 }), 1, k)
})

// --- workflow invariants ---------------------------------------------------------------
// Read as text, not parsed: the repository has no YAML parser, and these are
// line-level promises the workflow comments make.

const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')

/** The text of one top-level job: from `  name:` to the next two-space key. */
function job(yml, name) {
  const lines = yml.split('\n')
  const start = lines.findIndex(l => l === `  ${name}:`)
  assert.ok(start !== -1, `job ${name} exists`)
  const end = lines.findIndex((l, i) => i > start && /^ {2}[\w-]+:\s*$/.test(l))
  return lines.slice(start, end === -1 ? undefined : end).join('\n')
}
const runs = text => [...text.matchAll(/^\s*(?:- )?run: (.*)$|^ {10}(\S.*)$/gm)].map(m => m[1] ?? m[2])

test('release: the tarball is packed before anything is installed or run, with lifecycle scripts refused', () => {
  const pack = job(release, 'pack')
  assert.match(pack, /npm pack --ignore-scripts --pack-destination dist/)
  assert.doesNotMatch(pack, /npm (?:ci|install|i|test|run)\b|node --test|smoke-pack/)
  assert.doesNotMatch(pack, /id-token/)
  assert.match(pack, /has lifecycle scripts/)
})

test('release: the test job installs without scripts, and publish waits for it and checks the digest', () => {
  const t = job(release, 'test')
  const installs = runs(t).filter(r => /npm (?:ci|install)\b/.test(r))
  assert.ok(installs.length > 0)
  for (const r of installs) assert.match(r, /--ignore-scripts/, r)
  assert.match(t, /sha256sum --check --strict/)
  assert.doesNotMatch(t, /upload-artifact|outputs:/)
  const publish = job(release, 'publish')
  assert.match(publish, /needs: \[pack, test\]/)
  assert.match(publish, /environment: npm/)
  assert.match(publish, /sha256sum --check --strict/)
  assert.match(publish, /--provenance/)
  assert.doesNotMatch(publish, /actions\/checkout|npm (?:ci|test)\b/)
})

test('ci: installs run no scripts, and the namespace check sees untracked files', () => {
  const installs = runs(ci).filter(r => /npm (?:ci|install)\b/.test(r))
  assert.ok(installs.length >= 2)
  for (const r of installs) assert.match(r, /--ignore-scripts/, r)
  assert.match(ci, /git status --porcelain --untracked-files=all -- docs\/ns/)
  assert.doesNotMatch(ci, /git diff --name-only -- docs\/ns/)
})
