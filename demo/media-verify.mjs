/**
 * Real media, verified from its bytes, before and after revocation.
 *
 * Reuses a sync-lipsync-v3 render Livepeer already produced, so this costs no
 * render and cannot hit the async-worker defect. What it proves:
 *
 *   the producer authors and anchors a derivation for the real MP4
 *   a node that is not the producer's verifies the same bytes: CLEAR
 *   the grantor revokes on their own node
 *   the same bytes, unchanged, now verify: TAINTED
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { PRODUCER, GRANTOR, grantsCg, derivationsCg, workDir } from '../bin/config.mjs'
import { recordDerivation } from '../src/derivation.mjs'
import { hashUrl } from '../src/verify.mjs'
import { verifyKnowledge } from '../src/verify-core.mjs'
import { readKnowledge } from '../src/resolve.mjs'

const MP4 = process.env.MANDATE_DEMO_MEDIA
  ?? 'https://agent.livepeer.org/a/aHR0cHM6Ly92M2IuZmFsLm1lZGlhL2ZpbGVzL2IvMGFhYTFkZTEvb2FfNmpUdUc1d25FVUsxdTNFbnZoX1FGSVlEVmN0Lm1wNA.ac3392fd47ef1448/oa_6jTuG5wnEUK1u3Envh_QFIYDVct.mp4'
const SUBJECT = process.argv[2] || `eve-${Date.now().toString(36).slice(-4)}`
const GRANT = `urn:mandate:grant:${SUBJECT}`
const CG = grantsCg()
const DCG = derivationsCg()
const READ = [CG, DCG]

const t0 = Date.now()
const log = []
const note = (k, v) => {
  const at = `+${((Date.now() - t0) / 1000).toFixed(0)}s`
  log.push({ at, [k]: v })
  console.log(`[${at.padStart(5)}] ${k}: ${v}`)
}
const strip = x => x.replace(/\x1b\[[0-9;]*m/g, '')
const cli = args => {
  try { return strip(execFileSync('node', ['bin/mandate.mjs', ...args], { encoding: 'utf8', timeout: 600000 })) }
  catch (e) { return strip((e.stdout || '') + (e.stderr || '')) }
}
const until = async (fn, ok, { every = 10000, tries = 20 } = {}) => {
  let r
  for (let i = 0; i < tries; i++) {
    try { r = await fn() } catch (e) { r = { verdict: 'ERROR', reason: e.message } }
    if (ok(r)) return r
    await new Promise(res => setTimeout(res, every))
  }
  return r
}

note('subject', SUBJECT)
const g = cli(['grant', '--subject', SUBJECT, '--capability', 'sync-lipsync-v3',
  '--use-class', 'advertising', '--territory', 'GB', '--max-spend', '4'])
note('grant UAL', (g.match(/UAL\s+(\S+)/) || [])[1] ?? 'NONE')

const rec = await recordDerivation(PRODUCER(), DCG, {
  outputUrl: MP4,
  servedCapability: 'sync-lipsync-v3',
  servedModelId: 'fal-ai/sync-lipsync/v3/image-to-video',
  authorizedUnder: GRANT,
  billedUsd: 0.6999,
  jobId: 's7c-inline',
  workDir: workDir(),
})
note('derivation author', 'producer node')
note('derivation sha256', rec.outputSha256)
note('derivation UAL', rec.ual ?? 'NONE')

// The verifier runs on a node that is not the producer's, and asks the producer
// nothing. It hashes the delivered bytes once, then watches the graph.
const verifier = GRANTOR()
const sha = await hashUrl(MP4)
note('verifier hashed delivered file', sha)
const check = async () => verifyKnowledge(await readKnowledge(verifier, READ), sha)
const before = await until(check, r => r.verdict === 'CLEAR')
note('verify before revocation', `${before.verdict} — ${before.reason}`)

const r = cli(['revoke', '--id', GRANT])
note('revoke UAL', (r.match(/UAL\s+(\S+)/) || [])[1] ?? 'NONE')
const revokedAt = Date.now()

const after = await until(check, x => x.verdict === 'TAINTED', { every: 8000, tries: 25 })
note('verify after revocation', `${after.verdict} — ${after.reason}`)
// Re-fetch at the end to show nothing about the file changed between the verdicts.
const shaAfter = await hashUrl(MP4)
note('delivered file unchanged', shaAfter === sha ? `yes (${shaAfter.slice(0, 16)}…)` : `NO — ${shaAfter}`)
note('revocation to TAINTED', `${((Date.now() - revokedAt) / 1000).toFixed(0)}s`)

writeFileSync(`demo/media-verify-${SUBJECT}.json`, JSON.stringify(log, null, 2))
console.log(`\nwrote demo/media-verify-${SUBJECT}.json`)
