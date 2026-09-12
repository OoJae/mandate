import { connect, runCapability, textOf, RAW } from '../src/livepeer.mjs'
import { writeFileSync } from 'node:fs'
const IMG = 'https://agent.livepeer.org/a/aHR0cHM6Ly92M2IuZmFsLm1lZGlhL2ZpbGVzL2IvMGFhYTFkNmQvcEhqSlhnV2VWQzhWWlVwUEhSSkl4LmpwZw.a987100a76a2ec97/pHjJXgWeVC8VZUpPHRJIx.jpg'
const AUD = 'https://agent.livepeer.org/a/aHR0cHM6Ly92M2IuZmFsLm1lZGlhL2ZpbGVzL2IvMGFhYTFkOGQvSDRmMW81WDRkZVVIdlhsaDBtVkVGLndhdg.443036d1fd833933/H4f1o5X4deUHvXlh0mVEF.wav'
const cap = process.argv[2] || 'sync-lipsync-v3'
const c = await connect(RAW)
console.log(`submitting ${cap} (image + audio)…`)
const sub = await runCapability(c, cap, {
  async: true, source_url: IMG,
  inputs: { image_url: IMG, audio_url: AUD, video_url: IMG },
  idempotency_key: `mandate-s7b-${cap}-v1`,
}, { timeout: 700, requestTimeoutMs: 120000 })
console.log(sub.slice(0, 400))
const jobId = (sub.match(/mjob_[a-f0-9]+/) || [])[0]
if (!jobId) { console.log('no job id (may have run inline)'); process.exit(0) }
for (let i = 1; i <= 40; i++) {
  await new Promise(r => setTimeout(r, 15000))
  const t = textOf(await c.callTool({ name: 'get_create_media', arguments: { job_id: jobId } }))
  const status = (t.match(/^Media job \S+: (\w+)/m) || [])[1] || '?'
  const url = (t.match(/https?:\/\/\S+?\.(?:mp4|webm|mov)/i) || [])[0]
  console.log(`[${i}] ${status}${url ? ' -> ' + url : ''}`)
  if (url || status === 'done' || status === 'failed') {
    writeFileSync('spikes/out/s7b-result.json', JSON.stringify({ cap, jobId, status, url, text: t }, null, 2))
    console.log('\n' + t.slice(0, 900)); break
  }
}
await c.close()
