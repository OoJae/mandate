/**
 * S6 — who authored the grant?
 *
 * The whole security claim is that the permission was written by the depicted
 * person, not by the company that profits from rendering her. That claim is only
 * true if the seal's author address is HERS and the producer never held her key.
 *
 * This spike creates a draft on Ana's node, finalizes it, and reports the
 * author address the seal actually carries.
 */
import { GRANTOR, PRODUCER } from '../src/dkg.mjs'
import { grantToTurtle } from '../src/rdf.mjs'
import { writeFileSync } from 'node:fs'

const grantor = GRANTOR()
const producer = PRODUCER()
const CG = process.env.MANDATE_GRANTS_CG
  ?? '0xeD1eeB64CaC09874257F05Fd6B51A55695ad0B69/mandate-grants'

const anaId = await grantor.identity()
const prodId = await producer.identity()
console.log('grantor  agent:', anaId.agentDid)
console.log('producer agent:', prodId.agentDid)

const name = `grant-s6-${anaId.agentAddress.slice(2, 8).toLowerCase()}`
const ttl = grantToTurtle({
  id: `urn:mandate:grant:s6-${anaId.agentAddress.slice(2, 8).toLowerCase()}`,
  grantor: anaId.agentDid,
  subject: 'ana-7f3c',
  permitsCapability: ['talking-head'],
  permitsUseClass: ['advertising'],
  validFrom: '2026-09-01T00:00:00Z',
  validUntil: '2026-12-01T00:00:00Z',
  maxSpendUsd: 5,
})
writeFileSync(`spikes/out/${name}.ttl`, ttl)

// Leave the draft editable so finalize is a separate, inspectable step.
console.log('\n-- creating WM draft on the GRANTOR node (no finalize) --')
const created = await grantor.cli([
  'ka', 'create', name, '-c', CG, '-f', `spikes/out/${name}.ttl`, '--no-finalize',
])
console.log(created.trim().split('\n').slice(-6).join('\n'))

console.log('\n-- finalize: POST /api/knowledge-assets/{name}/wm/finalize --')
let sealed
try {
  sealed = await grantor.api(`/api/knowledge-assets/${encodeURIComponent(name)}/wm/finalize`, {
    method: 'POST',
    body: JSON.stringify({ contextGraphId: CG }),
  })
  console.log(JSON.stringify(sealed, null, 2))
} catch (e) {
  console.log('finalize error:', e.message.slice(0, 600))
  process.exit(1)
}

const author = sealed.authorAddress ?? sealed.author ?? null
console.log('\n================ S6 VERDICT ================')
console.log('seal authorAddress :', author)
console.log('grantor  address   :', anaId.agentAddress)
console.log('producer address   :', prodId.agentAddress)
const okGrantor = author && author.toLowerCase() === anaId.agentAddress.toLowerCase()
const notProducer = author && author.toLowerCase() !== prodId.agentAddress.toLowerCase()
console.log(`\nauthored by the grantor      : ${okGrantor ? 'YES' : 'NO'}`)
console.log(`NOT authored by the producer : ${notProducer ? 'YES' : 'NO'}`)
console.log(okGrantor && notProducer
  ? '\nS6 GREEN — the seal proves the grantor wrote the permission.'
  : '\nS6 RED — the security claim does not hold as configured.')
writeFileSync('spikes/out/s6-report.json', JSON.stringify({ sealed, anaId, prodId }, null, 2))
