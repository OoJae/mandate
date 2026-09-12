/**
 * S7 — the success path actually renders.
 *
 * The reference likeness is SYNTHETIC on purpose. A demo about consent should
 * not use a real person's face to prove its point, and a generated subject
 * keeps the whole repo free of anyone's biometrics.
 */
import { connect, runCapability, textOf, RAW } from '../src/livepeer.mjs'
import { writeFileSync } from 'node:fs'

const c = await connect(RAW)
const out = {}

console.log('1/2  generating a SYNTHETIC reference portrait (flux-schnell, ~$0.003)…')
const img = await runCapability(c, 'flux-schnell', {
  prompt: 'studio headshot portrait of a fictional woman, neutral grey background, '
        + 'soft even lighting, facing camera, photorealistic, sharp focus',
  inputs: { width: 768, height: 768 },
  idempotency_key: 'mandate-s7-reference-portrait-v1',
}, { timeout: 300 })
console.log(img.slice(0, 700))
out.image = img

const url = (img.match(/https?:\/\/\S+?\.(?:png|jpg|jpeg|webp)/i) || [])[0]
  || (img.match(/https?:\/\/\S+/) || [])[0]?.replace(/[)\],.]+$/, '')
console.log('\nreference image url:', url)
out.imageUrl = url

if (!url) {
  console.log('no image url parsed — stopping before spending on talking-head')
  writeFileSync('spikes/out/s7-report.json', JSON.stringify(out, null, 2))
  process.exit(1)
}

// talking-head is omnihuman v1.5, which is AUDIO-DRIVEN: it rejects a bare text
// prompt with `missing field audio_url`. So speech comes first.
const LINE = 'This render was authorised by a grant I published myself.'
console.log('\n2/3  speech for the avatar (inworld-tts, ~$0.0105/1k chars)…')
const speech = await runCapability(c, 'inworld-tts', {
  prompt: LINE,
  idempotency_key: 'mandate-s7-tts-v1',
}, { timeout: 300 })
console.log(speech.slice(0, 500))
out.speech = speech
const audioUrl = (speech.match(/https?:\/\/\S+?\.(?:mp3|wav|m4a|ogg)/i) || [])[0]
  || (speech.match(/https?:\/\/\S+/) || [])[0]?.replace(/[)\],.]+$/, '')
console.log('audio url:', audioUrl)
out.audioUrl = audioUrl
if (!audioUrl) {
  writeFileSync('spikes/out/s7-report.json', JSON.stringify(out, null, 2))
  console.log('no audio url — stopping before spending on talking-head')
  process.exit(1)
}

console.log('\n3/3  talking-head from portrait + speech (~$0.168/s)…')
const th = await runCapability(c, 'talking-head', {
  source_url: url,
  inputs: { image_url: url, audio_url: audioUrl },
  idempotency_key: 'mandate-s7-talking-head-v2',
}, { timeout: 700 })
console.log(th.slice(0, 1200))
out.talkingHead = th

writeFileSync('spikes/out/s7-report.json', JSON.stringify(out, null, 2))
console.log('\nwrote spikes/out/s7-report.json')
await c.close()
