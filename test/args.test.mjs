import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, helpText, UsageError, EXIT, FLAGS, COMMANDS } from '../bin/args.mjs'

const SUBJ = '0xed1eeb64cac09874257f05fd6b51a55695ad0b69:ana'

test('parses a render request into typed values', () => {
  const { command, flags } = parseArgs(['render', '--subject', SUBJ, '--capability', 'talking-head', '--use-class=advertising', '--territory', 'GB', '--seconds', '6', '--execute'])
  assert.equal(command, 'render')
  assert.equal(flags.subject, SUBJ)
  assert.equal(flags.useClass, 'advertising')
  assert.equal(flags.execute, true)
})

test('a flag can never swallow the next flag as its value', () => {
  assert.throws(() => parseArgs(['render', '--subject', SUBJ, '--capability', 'x', '--use-class', 'ads', '--at', '--execute']),
    e => e instanceof UsageError && /--at needs a value, got the flag --execute/.test(e.message))
})

test('unknown flags and commands are usage errors, not silent defaults', () => {
  assert.throws(() => parseArgs(['revoke', '--grant', 'urn:mandate:grant:x']), /unknown flag --grant for revoke/)
  assert.throws(() => parseArgs(['destroy']), /unknown command/)
  assert.throws(() => parseArgs(['render', 'stray']), /unexpected argument/)
})

test('required flags are enforced, so revoke cannot default to someone else\'s grant', () => {
  assert.throws(() => parseArgs(['revoke']), /revoke requires --id/)
  assert.throws(() => parseArgs(['grant', '--subject', 'ana', '--capability', 'talking-head']), /requires --use-class/)
})

test('values are validated by type', () => {
  const base = ['render', '--subject', SUBJ, '--capability', 'talking-head', '--use-class', 'ads']
  assert.throws(() => parseArgs([...base, '--at', '2026-12-31T23:59']), /offset/)
  assert.throws(() => parseArgs([...base, '--seconds', '1e3']), /plain non-negative/)
  assert.throws(() => parseArgs([...base, '--inputs', '[1]']), /JSON object/)
  assert.throws(() => parseArgs([...base, '--source-url', 'file:///etc/passwd']), /http\(s\)/)
  assert.throws(() => parseArgs(['render', '--subject', 'ana-7f3c', '--capability', 'x', '--use-class', 'y']), /0x<grantor address>/)
  assert.throws(() => parseArgs(['verify', '--node', 'anywhere']), /one of verifier, grantor, producer/)
  assert.throws(() => parseArgs(['grant', '--subject', 'ana', '--capability', 'a,,b', '--use-class', 'x']), /list/)
  assert.equal(parseArgs([...base, '--at', '2026-12-31T23:59:00+02:00']).flags.at, '2026-12-31T21:59:00.000Z')
})

test('a flag given twice, or a boolean given a value, is refused', () => {
  assert.throws(() => parseArgs(['verify', '--url', 'https://a.b/x', '--url', 'https://a.b/y']), /more than once/)
  assert.throws(() => parseArgs(['render', '--execute=false']), /takes no value/)
})

test('help is generated from the flag table and lists every exit code', () => {
  const top = helpText()
  for (const c of Object.keys(COMMANDS)) assert.match(top, new RegExp(`\\b${c}\\b`))
  for (const code of Object.values(EXIT)) assert.match(top, new RegExp(`^\\s+${code}\\s`, 'm'))
  const render = helpText('render')
  for (const [n, , cmds] of FLAGS) if (cmds.includes('render')) assert.match(render, new RegExp(`--${n}\\b`))
  assert.doesNotThrow(() => parseArgs(['render', '--help']))
})

test('help, -h and --version parse as requests for help or the version, not unknown commands', () => {
  assert.deepEqual(parseArgs(['help']), { command: null, flags: { help: true } })
  assert.deepEqual(parseArgs(['help', 'render']), { command: 'render', flags: { help: true } })
  assert.deepEqual(parseArgs(['-h']), { command: null, flags: { help: true } })
  assert.equal(parseArgs(['render', '-h']).flags.help, true)
  assert.equal(parseArgs(['--version']).flags.version, true)
  assert.throws(() => parseArgs(['help', 'destroy']), /unknown command/)
})

test('grant terms are checked against the patterns a grant is written with, before anything is captured', () => {
  const grant = extra => parseArgs(['grant', '--subject', 'ana', '--capability', 'talking-head', '--use-class', 'advertising', ...extra])
  assert.throws(() => grant(['--territory', 'gb']), /in capitals, like GB/)
  assert.throws(() => grant(['--territory', 'GBR']), /in capitals/)
  assert.throws(() => parseArgs(['grant', '--subject', 'ana', '--capability', 'Talking-Head', '--use-class', 'advertising']), /lowercase capability/)
  assert.throws(() => parseArgs(['grant', '--subject', 'ana', '--capability', 'talking-head', '--use-class', 'Advertising']), /lowercase use classes/)
  assert.throws(() => grant(['--forbid', 'Political']), /lowercase use classes/)
  assert.deepEqual(grant(['--territory', 'GB,US']).flags.territory, ['GB', 'US'])
  assert.throws(() => parseArgs(['consent', '--use-class', 'advertising', '--territory', 'uk']), /in capitals/)
})

test('help text does not overclaim: verify reads the graph, the deny list is labels only, --force and --yes say what they never skip', () => {
  assert.doesNotMatch(helpText(), /bytes alone/)
  assert.match(helpText(), /verify .*recorded on the DKG/)
  const grant = helpText('grant')
  for (const label of ['adult', 'sexual', 'nsfw', 'deceptive-impersonation']) assert.match(grant, new RegExp(`\\b${label}\\b`))
  assert.match(grant, /Only the label is checked/)
  assert.match(grant, /--force .*Never overrides a failed transcription/)
  assert.match(grant, /--yes .*Never skips confirming a consent clip/)
})
