import { connect, runCapability, textOf, RAW } from '../src/livepeer.mjs'
import { writeFileSync } from 'node:fs'

const IMG = 'https://agent.livepeer.org/a/aHR0cHM6Ly92M2IuZmFsLm1lZGlhL2ZpbGVzL2IvMGFhYTFkNmQvcEhqSlhnV2VWQzhWWlVwUEhSSkl4LmpwZw.a987100a76a2ec97/pHjJXgWeVC8VZUpPHRJIx.jpg'
const AUD = 'https://agent.livepeer.org/a/aHR0cHM6Ly92M2IuZmFsLm1lZGlhL2ZpbGVzL2IvMGFhYTFkOGQvSDRmMW81WDRkZVVIdlhsaDBtVkVGLndhdg.443036d1fd833933/H4f1o5X4deUHvXlh0mVEF.wav'
const KEY = process.argv[2] || 'mandate-s7-th-async-v4'

const c = await connect(RAW)
const sub = await runCapability(c, 'talking-head', {
  async: true, source_url: IMG, inputs: { image_url: IMG, audio_url: AUD },
  idempotency_key: KEY,
}, { timeout: 700, requestTimeoutMs: 120000 })
console.log(sub.slice(0, 400))

const jobId = (sub.match(/mjob_[a-f0-9]+/) || [])[0]
console.log('job:', jobId)
if (!jobId) process.exit(1)

for (let i = 1; i <= 40; i++) {
  await new Promise(r => setTimeout(r, 15000))
  const t = textOf(await c.callTool({ name: 'get_create_media', arguments: { job_id: jobId } }))
  const status = (t.match(/^Media job \S+: (\w+)/m) || [])[1] || 'unknown'
  const url = (t.match(/https?:\/\/\S+?\.(?:mp4|webm|mov)/i) || [])[0]
  console.log(`[${String(i).padStart(2)}] ${status}${url ? '  -> ' + url : ''}`)
  if (url || status === 'done' || status === 'failed') {
    writeFileSync('spikes/out/s7-talking-head.json', JSON.stringify({ jobId, status, url, text: t }, null, 2))
    console.log('\n=== FINAL ===\n' + t.slice(0, 1200))
    break
  }
}
await c.close()
