/**
 * The honest end-to-end run, from the producer's own node, no stand-ins.
 *
 * Every timing printed here is measured on live Base Sepolia + two DKG v10
 * daemons. It exists so the demo video and README quote real numbers.
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const SUBJECT = process.argv[2] || `dana-${Date.now().toString(36).slice(-4)}`
const GRANT = `urn:mandate:grant:${SUBJECT}`
const t0 = Date.now()
const s = () => `+${((Date.now() - t0) / 1000).toFixed(0)}s`
const log = []
const note = (k, v) => { log.push({ at: s(), [k]: v }); console.log(`[${s().padStart(5)}] ${k}: ${v}`) }

const run = args => {
  try { return execFileSync('node', ['bin/mandate.mjs', ...args], { encoding: 'utf8', timeout: 600000 }) }
  catch (e) { return (e.stdout || '') + (e.stderr || '') }
}
const strip = x => x.replace(/\x1b\[[0-9;]*m/g, '')
const verdict = out => (strip(out).match(/PERMITTED under \S+|REFUSED — clause: [a-z-]+/) || ['?'])[0]

note('subject', SUBJECT)

const g = strip(run(['grant', '--subject', SUBJECT, '--capability', 'talking-head,sync-lipsync-v3',
  '--use-class', 'advertising', '--territory', 'GB', '--max-spend', '4']))
note('grant UAL', (g.match(/UAL\s+(\S+)/) || [])[1] ?? 'NONE')
note('grant tx', (g.match(/tx\s+(\S+)/) || [])[1] ?? 'NONE')

// Producer resolves from ITS OWN node until the anchored grant has synced.
let v
for (let i = 0; i < 15; i++) {
  v = verdict(run(['render', '--subject', SUBJECT, '--capability', 'talking-head']))
  if (v.startsWith('PERMITTED')) break
  await new Promise(r => setTimeout(r, 10000))
}
note('producer, own node, after grant', v)

const r = strip(run(['revoke', '--id', GRANT]))
note('revoke UAL', (r.match(/UAL\s+(\S+)/) || [])[1] ?? 'NONE')
const revokedAt = Date.now()

for (let i = 0; i < 20; i++) {
  v = verdict(run(['render', '--subject', SUBJECT, '--capability', 'talking-head']))
  if (v.startsWith('REFUSED')) break
  await new Promise(r => setTimeout(r, 8000))
}
note('producer, own node, after revoke', v)
note('cross-node revocation latency', `${((Date.now() - revokedAt) / 1000).toFixed(0)}s from revoke command returning`)

writeFileSync(`demo/e2e-${SUBJECT}.json`, JSON.stringify(log, null, 2))
console.log(`\nwrote demo/e2e-${SUBJECT}.json`)
