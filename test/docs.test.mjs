// Doc claims checked against the code they describe, so the docs cannot drift from it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const R = new URL('..', import.meta.url).pathname
const read = p => readFileSync(R + p, 'utf8')
const README = read('README.md'), DESIGN = read('DESIGN.md'), CONTRACTS = read('docs/CONTRACTS.md'), SPIKES = read('docs/SPIKES.md')
const scope = read('src/scope.mjs'), cli = read('bin/mandate.mjs'), pending = read('src/pending.mjs'), config = read('bin/config.mjs')
const flat = s => s.replace(/\s+/g, ' ')

test('configuration: no doc tells a reader to create a working-directory .env; each names the lookup order', () => {
  for (const [n, d] of [['README', README], ['DESIGN', DESIGN], ['CONTRACTS', CONTRACTS]]) {
    assert.doesNotMatch(d, /cp \.env\.example \.env\b/, `${n} copies .env.example into the working directory`)
    assert.doesNotMatch(flat(d), /read from `\.env`/, `${n} says settings are read from .env`)
    assert.match(d, /~\/\.mandate\/\.env/, `${n} names ~/.mandate/.env`)
    assert.match(d, /--env-path/, `${n} names --env-path`)
    assert.match(d, /MANDATE_ENV_FILE/, `${n} names MANDATE_ENV_FILE`)
    assert.match(flat(d), /working directory is never read/, `${n} says a working-directory .env is never read`)
  }
  assert.match(config, /'--env-path'/)
  assert.match(README, /chmod 600 ~\/\.mandate\/\.env/)
  // --env-file is only ever mentioned as refused
  for (const d of [README, CONTRACTS]) for (const m of flat(d).matchAll(/(?:^|\. )((?:(?!\. ).)*--env-file(?:(?!\. ).)*)/g)) assert.match(m[0], /refus|Node/, m[0])
})

test('filler: CONTRACTS lists exactly SCRIPT_FILLER, README does not call hesitation sounds filler', () => {
  const code = scope.match(/const SCRIPT_FILLER = new Set\(\[([^\]]*)\]\)/)[1].match(/'([^']+)'/g).map(s => s.slice(1, -1)).sort()
  const m = flat(CONTRACTS).match(/filler is exactly: `([^`]+)`/)
  assert.ok(m, 'CONTRACTS states the filler list')
  assert.deepEqual(m[1].split(' ').sort(), code)
  assert.doesNotMatch(flat(README), /filler \(`um`/)
  for (const d of [README, DESIGN, CONTRACTS]) assert.match(flat(d), /hesitation/i)
  assert.doesNotMatch(flat(CONTRACTS), /`\$5`, `5 dollars`, `five US dollars` and `5 USD` to `5 dollars`/)
  assert.match(CONTRACTS, /usdollars/)
})

test('review: the 4000-character full-transcript rule is stated, matching the code', () => {
  const max = cli.match(/const TRANSCRIPT_REVIEW_MAX = (\d+)/)[1]
  const extra = Number(cli.match(/const EXTRA_WORDS_REVIEW_MAX = (\d+)/)[1]) + 1
  for (const d of [README, CONTRACTS]) {
    assert.match(flat(d), new RegExp(`${max} characters`))
    assert.match(flat(d), new RegExp(`${extra} or more`))
    assert.match(flat(d), /in full/)
  }
})

test('locks: per-grant lock and per-key lease, and what a second process sees', () => {
  assert.match(pending, /grant-\$\{createHash\('sha256'\)/)
  assert.match(pending, /\$\{file\(key\)\}\.lease/)
  assert.match(pending, /LEASE_HEARTBEAT_MS = 5_000/)
  assert.match(pending, /GRANT_LOCK_TRIES = 600/)
  const c = flat(CONTRACTS)
  assert.match(c, /grant-<sha256>\.lock/)
  assert.match(c, /<key>\.json\.lease/)
  assert.match(c, /about 15 s/)
  assert.match(c, /every 5 s/)
  assert.match(c, /outcome: 'in-use'/)
  assert.match(c, /decisionChanged/)
  const r = flat(README)
  assert.match(r, /in use by another mandate process/)
})

test('ceiling: concurrent processes on one machine yes, across machines no; --seconds is taken as given', () => {
  for (const d of [README, DESIGN, CONTRACTS]) {
    assert.match(flat(d), /not across machines|across machines is not|not enforced across machines/i)
    assert.match(flat(d), /--seconds/)
  }
  assert.match(cli, /which is taken as given/)
})

test('limits: the ones still open are named, and the closed ones are no longer called limits', () => {
  const r = flat(README), c = flat(CONTRACTS), g = flat(DESIGN)
  assert.match(r, /lingerie/)
  assert.match(c, /mayHaveStarted/)
  assert.match(c, /ns\/v2|later vocabulary version/)
  assert.match(r, /CI run/)
  // The verifier now refuses a grantor's own unreadable duplicate, as the gate does.
  assert.match(read('src/verify-core.mjs'), /unreadableGrantCopies\(k\.forgeries\)/)
  assert.match(c, /unreadableGrantCopies/)
  for (const d of [r, c, g]) {
    assert.doesNotMatch(d, /verifier does not (yet|apply)|judgeEdge` does not yet|can still say `CLEAR`/)
    assert.doesNotMatch(d, /reading ending in one is still confirmed|are not seen as questions|some question marks are not seen/)
  }
  // Every question mark the docs name is in the matcher's class.
  assert.match(scope, /\\u037e/)
  for (const cp of ['055e', '1367', '1945', '2cfa', 'a60f', 'a6f7']) assert.match(scope, new RegExp(`\\\\u${cp}`), cp)
  assert.match(c, /U\+037E/)
})

test('scripts: every script or spike that reads bin/config.mjs is named as loading the env file', () => {
  assert.match(flat(README), /scripts\/publish-ontology\.mjs` and the live spikes read their settings/)
  assert.match(flat(CONTRACTS), /loadScriptEnv\(argv\)/)
  assert.match(flat(DESIGN), /--budget-minutes/)
})

test('round six: the home directory, the consent start date, the pre-capture checks, the lease rule and the closed world are documented as coded', () => {
  const r = flat(README), c = flat(CONTRACTS)
  const store = read('src/state-store.mjs')
  assert.match(store, /HOME is empty or relative; set MANDATE_HOME to an absolute path/)
  for (const d of [r, c]) assert.match(d, /HOME is empty or relative; set MANDATE_HOME to an absolute path/)
  assert.match(cli, /a grant with a consent clip cannot start before the clip is recorded/)
  assert.match(c, /a grant with a consent clip cannot start before the clip is recorded/)
  assert.match(r, /A grant backed by a clip never starts before the clip/)
  assert.match(cli, /await readClipHistory\(grantor, subject\)[^]*await livepeer\(\)[^]*clipAlreadyUsed\(history, /)
  assert.match(c, /readClipHistory/)
  assert.match(r, /a missing `MANDATE_DERIVATIONS_CG` is exit 1 here/)
  assert.match(pending, /!holdsLease\(record\.key\) && isAlive\(last\.pid\)/)
  assert.match(c, /only while this store does not hold the key's lease/)
  assert.match(r, /a rerun holding the key's lease resumes it/)
  assert.match(scope, /\\p\{Co\}\\p\{Cn\}/)
  assert.match(c, /private-use \(`\\p\{Co\}`\), unassigned \(`\\p\{Cn\}`/)
  assert.match(r, /private-use character/)
})
