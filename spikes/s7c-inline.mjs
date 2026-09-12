/**
 * S7c — the inline path.
 *
 * Three async jobs (talking-head x2, sync-lipsync-v3) all died with
 * `runner_abandoned` at ~127-128s. Same timing, different capabilities: this is
 * the platform's async worker, not our integration. The platform's own error
 * text says short renders now run inline, so take that route.
 */
import { connect, runCapability, RAW } from '../src/livepeer.mjs'
import { writeFileSync } from 'node:fs'

const IMG = 'https://agent.livepeer.org/a/aHR0cHM6Ly92M2IuZmFsLm1lZGlhL2ZpbGVzL2IvMGFhYTFkNmQvcEhqSlhnV2VWQzhWWlVwUEhSSkl4LmpwZw.a987100a76a2ec97/pHjJXgWeVC8VZUpPHRJIx.jpg'
const AUD = 'https://agent.livepeer.org/a/aHR0cHM6Ly92M2IuZmFsLm1lZGlhL2ZpbGVzL2IvMGFhYTFkOGQvSDRmMW81WDRkZVVIdlhsaDBtVkVGLndhdg.443036d1fd833933/H4f1o5X4deUHvXlh0mVEF.wav'
const cap = process.argv[2] || 'sync-lipsync-v3'

const c = await connect(RAW)
const t0 = Date.now()
console.log(`${cap} inline (async:false)…`)
try {
  const out = await runCapability(c, cap, {
    async: false, source_url: IMG,
    inputs: { image_url: IMG, audio_url: AUD, video_url: IMG },
    idempotency_key: `mandate-s7c-${cap}-v1`,
  }, { timeout: 280, requestTimeoutMs: 290000 })
  const url = (out.match(/https?:\/\/\S+?\.(?:mp4|webm|mov)/i) || [])[0]
  console.log(`\n[${((Date.now() - t0) / 1000).toFixed(0)}s]`)
  console.log(out.slice(0, 900))
  if (url) {
    console.log('\nMEDIA URL:', url)
    writeFileSync('spikes/out/s7c-result.json', JSON.stringify({ cap, url, out }, null, 2))
  }
} catch (e) {
  console.log(`\n[${((Date.now() - t0) / 1000).toFixed(0)}s] FAILED: ${String(e.message).slice(0, 400)}`)
}
await c.close()
