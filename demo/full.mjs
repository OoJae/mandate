#!/usr/bin/env node
/**
 * The whole product, end to end, using only the `mandate` CLI.
 *
 *   consent on a phone → grant → a refused capability → a gated render →
 *   its derivation anchored → verify CLEAR on an independent node → revoke →
 *   the producer refuses → verify TAINTED → blast radius
 *
 * Every step is a real command against real services: Livepeer Agent, three
 * DKG v10 nodes and Base Sepolia. The run is written to demo/runs/<timestamp>/
 * as run.json (every command's JSON result) and run.txt (a readable log with
 * explorer links). Both are meant to be committed as evidence, so the consent
 * transcript and every link-accessible URL (the clip, the inputs, the rendered
 * media) are redacted before they are written; block explorer links stay.
 * demo/runs/ is git-ignored all the same: check a run before committing it.
 *
 * With --consent the grant step asks the operator to confirm the clip at this
 * terminal; the CLI never lets --yes skip that.
 *
 *   node demo/full.mjs --image-url <url> --audio-url <url> --seconds 5 [--consent] [--subject ana]
 *
 * Without --consent the grant is published without a consent clip, and the log
 * says so. Spends one render (~$0.70 at list price for 5s of sync-lipsync-v3)
 * and three Base Sepolia publishes.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

/** The longest a step may be retried while nodes sync: one day. */
const MAX_WAIT_SECONDS = 86_400

/** --wait-seconds as milliseconds, or throw: a NaN deadline would retry forever. */
export function waitMs(value) {
  const s = String(value ?? '').trim()
  if (!/^\d+$/.test(s) || Number(s) < 1 || Number(s) > MAX_WAIT_SECONDS) {
    throw new Error(`--wait-seconds must be a whole number of seconds from 1 to ${MAX_WAIT_SECONDS}, got ${JSON.stringify(value)}`)
  }
  return Number(s) * 1000
}

/** Public block explorer links are evidence; every other URL may grant access to private media. */
const PUBLIC_URL = /^https:\/\/(?:sepolia\.)?basescan\.org\//
const URL_IN_TEXT = /https?:\/\/[^\s"'<>)\]]+/g
const digest = v => createHash('sha256').update(String(v)).digest('hex').slice(0, 12)

/**
 * A copy of a run safe to write into the repository: transcripts are replaced
 * by their length and a hash, and link-accessible URLs by a hash, wherever they
 * appear. A hash lets a reader match two mentions of one URL without holding it.
 */
export function redact(value, key = '') {
  if (typeof value === 'string') {
    if (/transcript/i.test(key)) return `[transcript redacted: ${value.length} characters, sha256 ${digest(value)}]`
    return value.replace(URL_IN_TEXT, u => (PUBLIC_URL.test(u) ? u : `[url redacted sha256 ${digest(u)}]`))
  }
  if (Array.isArray(value)) return value.map(v => redact(v, key))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]))
  return value
}

/** Verify said CLEAR about this grant, not some other edge on the same bytes. */
export const clearFor = (step, grantId) => step.result?.verdict === 'CLEAR' && step.result?.grantId === grantId

/** Verify said TAINTED because this grant was revoked. */
export const taintedFor = (step, grantId) => step.result?.verdict === 'TAINTED' && step.result?.subStatus === 'REVOKED' && step.result?.grantId === grantId

async function main() {
  const { values: opt } = parseArgs({
    options: {
      subject: { type: 'string', default: `ana-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}` },
      capability: { type: 'string', default: 'sync-lipsync-v3' },
      refused: { type: 'string', default: 'face-swap-video' },
      'image-url': { type: 'string' },
      'audio-url': { type: 'string' },
      seconds: { type: 'string', default: '5' },
      consent: { type: 'boolean', default: false },
      'consent-kind': { type: 'string', default: 'video' },
      'wait-seconds': { type: 'string', default: '600' },
    },
  })
  if (!opt['image-url'] || !opt['audio-url']) {
    console.error('usage: node demo/full.mjs --image-url <url> --audio-url <url> [--seconds 5] [--consent] [--subject name] [--wait-seconds 600]')
    process.exit(1)
  }
  let WAIT_MS
  try {
    WAIT_MS = waitMs(opt['wait-seconds'])
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }

  const started = new Date()
  const dir = join('demo', 'runs', started.toISOString().replace(/[:.]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const run = { startedAt: started.toISOString(), options: opt, steps: [] }
  const lines = []
  const t0 = Date.now()
  const stamp = () => `[+${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s]`
  const log = (...parts) => {
    const line = `${stamp()} ${parts.join(' ')}`
    lines.push(line)
    console.log(line)
  }
  const save = () => {
    writeFileSync(join(dir, 'run.json'), JSON.stringify(redact(run), null, 2))
    writeFileSync(join(dir, 'run.txt'), `${lines.map(l => redact(l)).join('\n')}\n`)
  }

  /**
   * Run one CLI command with --json; stderr (links, progress) goes straight to
   * the terminal. An interactive step also reads the terminal, for the consent
   * confirmation.
   */
  function mandate(args, label, { interactive = false } = {}) {
    return new Promise(resolve => {
      const began = Date.now()
      const child = spawn(process.execPath, ['bin/mandate.mjs', ...args, '--json'], { stdio: [interactive ? 'inherit' : 'ignore', 'pipe', 'inherit'] })
      let stdout = ''
      child.stdout.on('data', d => { stdout += d })
      child.on('close', code => {
        let result
        try { result = JSON.parse(stdout) } catch { result = { unparsed: stdout.slice(0, 2000) } }
        const step = { label, args, exitCode: code, ms: Date.now() - began, result }
        run.steps.push(step)
        save()
        resolve(step)
      })
    })
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const nodesSync = role => new Promise(resolve => {
    const child = spawn(process.execPath, ['scripts/nodes.mjs', 'sync', role], { stdio: ['ignore', 'ignore', 'inherit'] })
    child.on('close', resolve)
  })

  /** Repeat a command until `done(step)`; a stale node is synced rather than waited on. */
  async function until(args, label, done) {
    const deadline = Date.now() + WAIT_MS
    for (let i = 1; ; i++) {
      const step = await mandate(args, `${label} (attempt ${i})`)
      if (done(step)) return step
      if (Date.now() > deadline) return step
      const stale = /stale view/.test(JSON.stringify(step.result))
      if (stale) await nodesSync(args.includes('verify') ? 'verifier' : 'producer')
      await sleep(stale ? 1000 : 10_000)
    }
  }

  function fail(message, step) {
    log(`FAILED — ${message}`)
    if (step) log(`  exit ${step.exitCode}: ${JSON.stringify(redact(step.result)).slice(0, 600)}`)
    run.failed = message
    save()
    process.exit(1)
  }

  const anchored = r => `${r.ual}${r.explorer ? `\n           ${r.explorer}` : r.txHash ? `  tx ${r.txHash}` : ''}`

  /* 0. Nodes */
  const status = await mandate(['status'], 'status')
  for (const n of status.result.nodes ?? []) log(`node ${n.role.padEnd(9)} ${n.reachable ? `${n.agentDid} peers=${n.peers}` : n.configured ? 'UNREACHABLE' : 'not configured'}`)
  if (status.exitCode !== 0) fail('a configured node is unreachable', status)

  /* 1–2. Consent and grant, on the grantor's node */
  const grantArgs = ['grant', '--subject', opt.subject, '--capability', opt.capability, '--use-class', 'advertising', '--territory', 'GB', '--max-spend', '5', '--valid-until', new Date(Date.now() + 30 * 864e5).toISOString(), '--yes']
  if (opt.consent) grantArgs.push('--with-consent', '--consent-kind', opt['consent-kind'])
  log(opt.consent ? 'consent: capturing on a phone, then granting' : 'grant: publishing WITHOUT a consent clip (run with --consent for the full flow)')
  const grant = await mandate(grantArgs, 'grant', { interactive: opt.consent })
  if (grant.exitCode !== 0) fail('grant', grant)
  const g = grant.result
  if (opt.consent) {
    const c = g.consent ?? {}
    log(`consent clip sha256 ${c.sha256 ?? 'none'}${c.bytes ? ` (${c.bytes} bytes${c.mime ? `, ${c.mime}` : ''})` : ''}; ${g.grant.consentClipSha256 ? 'attached to the grant' : 'NOT attached (forced)'}`)
    if (c.scope) log(`spoken scope: ${c.scope.checks.map(k => `${k.term} ${k.matched ? 'said' : k.contradicted ? 'CONTRADICTED' : 'not said'}`).join(', ')}`)
    if (c.scope?.unchecked?.length) log(`confirmed by the operator, not checked against the words: ${c.scope.unchecked.join(', ')}`)
  }
  log(`GRANTED  ${g.grant.id}`)
  log(`  UAL     ${anchored(g)}`)

  /* 3. A capability the grant never named: refused on the producer's node, for free */
  const refused = await until(['render', '--subject', g.grant.subject, '--capability', opt.refused, '--use-class', 'advertising', '--territory', 'GB', '--seconds', opt.seconds],
    'render refused capability', s => s.exitCode === 2 && s.result.decision?.clause === 'capability-permitted')
  if (refused.result.decision?.clause !== 'capability-permitted') fail(`expected ${opt.refused} to be refused by capability-permitted`, refused)
  log(`REFUSED  ${opt.refused}: ${refused.result.decision.clause} — ${refused.result.decision.reason}`)

  /* 4. The gated render, once the producer's node has the grant */
  const renderArgs = ['render', '--subject', g.grant.subject, '--capability', opt.capability, '--use-class', 'advertising', '--territory', 'GB', '--seconds', opt.seconds]
  const permitted = await until(renderArgs, 'render dry run', s => s.exitCode === 0 && s.result.decision?.grantId === g.grant.id)
  if (permitted.exitCode !== 0 || permitted.result.decision?.grantId !== g.grant.id) fail('the producer never permitted the render under the new grant', permitted)
  log(`PERMITTED on the producer's node under ${permitted.result.decision.grantId}; estimate ~$${permitted.result.price.usd?.toFixed(4)}`)
  // The same input shape as the S7c render that succeeded inline.
  const render = await mandate([...renderArgs, '--execute', '--source-url', opt['image-url'], '--image-url', opt['image-url'], '--audio-url', opt['audio-url'], '--video-url', opt['image-url']], 'render --execute')
  if (render.exitCode !== 0) fail('render', render)
  const d = render.result.derivation
  log(`RENDERED ${render.result.mediaUrl}`)
  log(`  job     ${render.result.jobId ?? '(inline)'}`)
  log(`  sha256  ${d.outputSha256}`)
  log(`  derivation ${anchored(d)}`)

  /* 5. Verify on the independent node */
  const verifyArgs = ['verify', '--url', render.result.mediaUrl, '--node', 'verifier']
  const clear = await until(verifyArgs, 'verify before revoke', s => clearFor(s, g.grant.id))
  if (!clearFor(clear, g.grant.id)) fail(`verify never returned CLEAR under ${g.grant.id}`, clear)
  log(`VERIFY   CLEAR on ${clear.result.node} — ${clear.result.reason}`)

  /* 6. Revoke */
  const revoke = await mandate(['revoke', '--id', g.grant.id, '--yes'], 'revoke')
  if (revoke.exitCode !== 0) fail('revoke', revoke)
  const revokedAt = Date.now()
  log(`REVOKED  ${g.grant.id}`)
  log(`  UAL     ${anchored(revoke.result)}`)

  /* 7. The producer refuses the same render */
  const after = await until(renderArgs, 'render after revoke', s => s.exitCode === 2 && s.result.decision?.clause === 'not-revoked')
  if (after.result.decision?.clause !== 'not-revoked') fail('the producer did not refuse after the revocation', after)
  log(`REFUSED  on the producer's node ${Math.round((Date.now() - revokedAt) / 1000)}s after the revocation anchored: ${after.result.decision.reason}`)

  /* 8. The same bytes are now tainted */
  const tainted = await until(verifyArgs, 'verify after revoke', s => taintedFor(s, g.grant.id))
  if (!taintedFor(tainted, g.grant.id)) fail(`verify never returned TAINTED / REVOKED under ${g.grant.id}`, tainted)
  log(`VERIFY   TAINTED / ${tainted.result.subStatus} on ${tainted.result.node} — the file did not change; the grant did`)

  /* 9. Blast radius */
  const blast = await mandate(['blast-radius', '--grant', g.grant.id], 'blast-radius')
  log(`BLAST    ${blast.result.assets?.length ?? 0} asset(s) under the revoked grant, ${blast.result.billedUnknown ? 'billed amount unknown' : `~$${blast.result.totalBilledUsd?.toFixed(4)} billed at list price`}`)

  run.finishedAt = new Date().toISOString()
  run.ok = true
  save()
  log(`done in ${Math.round((Date.now() - t0) / 1000)}s; wrote ${dir}/run.json and run.txt (transcripts and private URLs redacted)`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
