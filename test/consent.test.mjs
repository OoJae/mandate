import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { checkSpokenScope, consentScript, matchScript, scriptWords } from '../src/scope.mjs'
import { readFileSync } from 'node:fs'
import { captureConsent, awaitCapture, transcribe, transcriptFrom, ConsentError } from '../src/consent.mjs'
import { getUpload, saysExpired, uploadUrlFromText } from '../src/livepeer.mjs'
import { reconcile } from '../src/derivation.mjs'

const REQ = { capability: ['talking-head'], useClass: ['advertising'], territory: ['GB'] }
const scope = t => checkSpokenScope(t, REQ)

test('every requested term said plainly is matched by the heuristics, but only the script is confirmed', () => {
  const r = scope('I consent to a talking head video of my likeness for advertising in the United Kingdom.')
  assert.deepEqual([r.missing, r.contradicted], [[], []])
  // "video" is not in the script: a person must read it.
  assert.deepEqual(r.scriptMatch, { matched: false, missing: [], extra: ['video'] })
  assert.equal(r.confirmed, false)
  assert.match(r.note, /UNCONFIRMED/)
  const read = scope(consentScript(REQ))
  assert.equal(read.confirmed, true)
  assert.match(read.note, /reads the consent script/)
})

test('aliases count: UK and Britain for GB, ads for advertising', () => {
  assert.deepEqual(scope('I agree to talking head ads in the UK.').missing, [])
  assert.deepEqual(scope('I give my permission for a talking head commercial in Britain.').missing, [])
})

test('LP-5: a negated consent is a contradiction, not a pass', () => {
  const r = scope('I do not consent to a talking head for advertising in GB.')
  assert.ok(r.contradicted.includes('consent'))
  assert.ok(r.contradicted.includes('advertising'))
  assert.match(r.note, /CONTRADICTS/)
})

test('negation stays in its clause: "but" starts a new one', () => {
  const r = checkSpokenScope('I consent to ads in the UK, but not political. A talking head is fine.', { ...REQ, useClass: ['advertising', 'political'] })
  assert.deepEqual(r.contradicted, ['political'])
  assert.deepEqual(r.missing, [])
})

test('"except" excludes: the UK is contradicted (and, deliberately, the rest of its clause too)', () => {
  assert.ok(scope('I agree to talking head adverts everywhere except the UK.').contradicted.includes('GB'))
})

test('substrings are not words: rugby is not GB, used is not US, let us is not the United States', () => {
  const r = checkSpokenScope('I agree. We used it at the rugby, let us see.', { territory: ['GB', 'US'] })
  assert.deepEqual(r.missing.sort(), ['GB', 'US'])
})

test('"do not mind" is not a refusal', () => {
  assert.deepEqual(scope("I don't mind advertising in Britain, and I agree to a talking head.").contradicted, [])
})

test('capabilities must be said too', () => {
  assert.deepEqual(scope('I consent to advertising in the UK.').missing, ['talking-head'])
})

test('an empty transcript misses everything', () => {
  const r = scope('')
  assert.equal(r.empty, true)
  assert.equal(r.covered, 0)
})

test('the consent script is generated from the grant\'s own clauses, and passes its own check', () => {
  const script = consentScript({ ...REQ, validUntil: '2026-12-12T00:00:00Z', maxSpendUsd: 5 })
  assert.match(script, /talking head/)
  assert.match(script, /United Kingdom/)
  assert.match(script, /12 December 2026/)
  assert.deepEqual([scope(script).missing, scope(script).contradicted], [[], []])
})

/* ---------------------------- capture, stubbed ---------------------------- */

function stubClient(script) {
  const calls = []
  return {
    calls,
    async callTool({ name, arguments: args }) {
      calls.push({ name, args })
      const q = script[name]
      if (!q?.length) throw new Error(`unscripted ${name}`)
      const next = q.length > 1 ? q.shift() : q[0]
      return typeof next === 'function' ? next(args) : next
    },
  }
}
const ok = (structuredContent, text = '') => ({ structuredContent, content: [{ type: 'text', text }] })
// The live nemotron-asr reply shape: ok, what served it, and what it heard.
const asrOk = (clip, fields = {}, text = '') => ok({ ok: true, capability: 'nemotron-asr', output_kind: 'text', source_url: clip, inputs: { audio_url: clip }, ...fields }, text)
const bad = text => ({ isError: true, content: [{ type: 'text', text }] })

async function clipServer() {
  const server = createServer((req, res) => {
    if (req.url === '/t.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ text: 'I consent to a talking head for advertising in the UK.' })) }
    if (req.url === '/t.txt') { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('I consent to a talking head for advertising in the UK.') }
    if (req.url === '/meta.mp4') { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end('ftypmp42 udta I consent to a talking head for advertising in the UK.') }
    if (req.url === '/big.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('I consent. '.repeat(120_000)) }
    if (req.url === '/binary.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(Buffer.from([0xff, 0xfe, 0x00, 0x49])) }
    if (req.url === '/to-clip') { res.writeHead(302, { location: '/clip.mp4' }); return res.end() }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('clip-bytes')
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => { server.close(r); server.closeAllConnections() }) }
}

test('LP-4: when transcription fails, capture reports it and no scope — never a silent pass', async () => {
  const srv = await clipServer()
  try {
    const client = stubClient({
      request_upload: [ok({ page_url: 'https://agent.livepeer.org/u/aaaaaaaaaaaaaaaaaaaaaaaa', token: 'aaaaaaaaaaaaaaaaaaaaaaaa' })],
      get_upload: [ok({ status: 'pending' }), ok({ status: 'done', url: `${srv.base}/clip.mp4` })],
      run_capability: [bad('nemotron-asr failed: unsupported media type video/mp4')],
    })
    const r = await captureConsent({ requested: REQ, client, onLink: () => {} })
    assert.equal(r.captured, true)
    assert.match(r.sha256, /^[0-9a-f]{64}$/)
    assert.equal(r.transcript, null)
    assert.equal(r.scope, null)
    assert.match(r.asrError, /unsupported media type/)
  } finally {
    await srv.close()
  }
})

test('waiting continues until the link expires, not a fixed number of polls', async () => {
  let t = 0
  const client = stubClient({ get_upload: [() => { t += 20_000; return ok({ status: 'pending' }) }] })
  const r = await awaitCapture(client, 'aaaaaaaaaaaaaaaaaaaaaaaa', { deadline: 30 * 60_000, now: () => t })
  assert.equal(r.url, null)
  assert.equal(r.polls, 90)
  const expired = await awaitCapture(stubClient({ get_upload: [ok({ status: 'expired' })] }), 'aaaaaaaaaaaaaaaaaaaaaaaa')
  assert.equal(expired.status, 'expired')
})

test('a transcript returned as a link is fetched; a bare URL is never treated as speech', async () => {
  const srv = await clipServer()
  try {
    const viaLink = await transcribe(stubClient({ run_capability: [asrOk('https://x.test/c.mp4', { url: `${srv.base}/t.json` }, `${srv.base}/t.json`)] }), 'https://x.test/c.mp4')
    assert.match(viaLink.transcript, /talking head/)
    await assert.rejects(transcribe(stubClient({ run_capability: [asrOk('https://x.test/c.mp4')] }), 'https://x.test/c.mp4'), /no text/)
  } finally {
    await srv.close()
  }
  assert.equal(transcriptFrom({ output: { text: ' hello ' } }, ''), 'hello')
  assert.equal(transcriptFrom(null, 'Transcript: I agree'), 'I agree')
})

/* -------------------------------- reconcile ------------------------------- */

test('reconcile flags a billed render with no derivation edge', () => {
  const r = reconcile({ billedJobs: [{ jobId: 'mjob_a' }, { jobId: 'mjob_b' }], derivations: [{ jobId: 'mjob_a', trusted: true }] })
  assert.equal(r.complete, false)
  assert.equal(r.orphans.length, 1)
  assert.match(r.note, /INCOMPLETE/)
})

test('reconcile passes when every billed render is recorded', () => {
  assert.equal(reconcile({ billedJobs: [{ jobId: 'mjob_a' }], derivations: [{ jobId: 'mjob_a', trusted: true }] }).complete, true)
})

/* ------------------ spoken scope, adversarial (false passes) ------------------ */

// A false refusal costs a re-recording; a false pass publishes a grant nobody gave.
const passes = r => r.missing.length === 0 && r.contradicted.length === 0

test('R1: exclusions after a universal or with "other than", "apart from", "outside" contradict', () => {
  for (const [t, term] of [
    ['I consent to everything but advertising. Talking head in the UK is fine.', 'advertising'],
    ['I consent to a talking head in the UK for any purpose other than advertising.', 'advertising'],
    ['I consent to a talking head for films, apart from advertising, in the UK.', 'advertising'],
    ['I consent to a talking head in the UK for anything aside from advertising.', 'advertising'],
    ['I consent to a talking head for advertising anywhere outside the UK.', 'GB'],
    ['I consent to a talking head for advertising in every country but the UK.', 'GB'],
  ]) {
    const r = scope(t)
    assert.ok(r.contradicted.includes(term), `${t} → ${JSON.stringify(r.contradicted)}`)
  }
})

test('R2: a negator after the term, far before it, or behind a comma still contradicts', () => {
  for (const [t, term] of [
    ['I consent to a talking head in the UK. Advertising? No.', 'advertising'],
    ['I consent to a talking head in the UK. Advertising is not okay.', 'advertising'],
    ['I consent to a talking head in the UK. I do not want this used in any way for advertising.', 'advertising'],
    ['I consent to a talking head in the UK. I refuse, under any circumstances, advertising.', 'advertising'],
    ['I consent to a talking head in the UK. Advertising is forbidden.', 'advertising'],
    ['I consent to a talking head in the UK; ads are off limits.', 'advertising'],
    ['Nobody has my consent to a talking head for advertising in the UK.', 'consent'],
    ['I do not consent to a talking head, advertising or the UK.', 'GB'],
    ['I consent to a talking head for advertising in the UK... NOT!', 'advertising'],
    ['I consent to a talking head for advertising in the UK. I dont.', 'consent'],
  ]) {
    const r = scope(t)
    assert.ok(r.contradicted.includes(term), `${t} → ${JSON.stringify(r.contradicted)}`)
  }
})

test('refusal verbs contradict consent: withhold, decline, reject, object, oppose', () => {
  for (const t of [
    'I withhold consent to a talking head for advertising in the UK.',
    'I decline to consent to a talking head for advertising in the UK.',
    'I reject consent to a talking head for advertising in the UK.',
    'I object to a talking head for advertising in the UK. I consent to education only.',
    'I oppose a talking head for advertising in the UK.',
    'I have no objection to refusing consent to a talking head for advertising in the UK.',
    'I agree to a talking head for ads in the UK. Just kidding.',
  ]) {
    const r = scope(t)
    assert.ok(r.contradicted.includes('consent'), `${t} → ${JSON.stringify(r)}`)
    assert.equal(r.affirmative, false)
  }
})

test('a guard phrase removes only its own words: "I don\'t mind no ads" refuses ads', () => {
  const r = scope("I agree to a talking head in the UK, I don't mind no ads.")
  assert.ok(r.contradicted.includes('advertising'))
  assert.ok(scope("I don't mind saying I won't agree to a talking head for advertising in the UK.").contradicted.includes('consent'))
  assert.ok(scope('Without hesitation I refuse to consent to a talking head for advertising in the UK.').contradicted.includes('consent'))
  assert.ok(scope('I consent to a talking head for ads. No problem, not in the UK.').contradicted.includes('GB'))
})

test('questions, conditionals and reported speech are not consent', () => {
  for (const t of [
    'Do I consent to a talking head for advertising in the UK?',
    'I consent to a talking head for advertising in the UK?',
    'I would consent to a talking head for advertising in the UK if they paid me.',
    'If they paid me, I consent to a talking head for advertising in the UK.',
    'He said I consent to a talking head for advertising in the UK.',
    'My agent asked whether I consent to a talking head for advertising in the UK.',
    'I consent to a talking head for advertising in the UK as long as I get paid.',
  ]) {
    const r = scope(t)
    assert.equal(r.affirmative, false, t)
    assert.ok(!passes(r), t)
    assert.ok(r.missing.includes('consent') || r.contradicted.includes('consent'), t)
  }
})

test('consent needs an affirmative first-person clause', () => {
  for (const t of [
    'She consents to a talking head for advertising in the UK.',
    'They consent to a talking head for advertising in the UK.',
    'I used to consent to a talking head for advertising in the UK.',
    'I will only consent to a talking head for advertising in the UK next year.',
    'Consent to a talking head for advertising in the UK.',
  ]) {
    const r = scope(t)
    assert.equal(r.affirmative, false, t)
    assert.ok(r.missing.includes('consent') || r.contradicted.includes('consent'), t)
  }
  for (const t of [
    'I consent to a talking head for advertising in the UK.',
    'We agree to a talking head for advertising in the UK.',
    'I give permission for a talking head for advertising in the UK.',
    'I hereby authorise a talking head for advertising in the UK.',
    'I allow a talking head for advertising in the UK.',
    "I'm happy for a talking head to be used for advertising in the U.K.",
  ]) {
    const r = scope(t)
    assert.equal(r.affirmative, true, t)
    assert.ok(passes(r), `${t} → ${JSON.stringify(r)}`)
  }
})

test('R10: ambiguous aliases satisfy nothing', () => {
  assert.ok(checkSpokenScope('I consent to a talking head for our marketing campaign.', { useClass: ['political'], capability: ['talking-head'] }).missing.includes('political'))
  assert.ok(checkSpokenScope('I consent to a talking head to show my family.', { useClass: ['entertainment'] }).missing.includes('entertainment'))
  assert.ok(checkSpokenScope('I consent to a face swap image.', { capability: ['face-swap-video'] }).missing.includes('face-swap-video'))
  assert.ok(checkSpokenScope('I consent to an avatar video.', { capability: ['heygen-twin'] }).missing.includes('heygen-twin'))
  assert.ok(checkSpokenScope('I consent to a talking head avatar.', { capability: ['talking-head', 'heygen-twin'] }).missing.includes('heygen-twin'))
  // One stretch of speech never satisfies two requested terms.
  assert.deepEqual(checkSpokenScope('I consent to lip sync.', { capability: ['lipsync', 'sync-lipsync-v3'] }).missing, ['lipsync', 'sync-lipsync-v3'])
  assert.deepEqual(checkSpokenScope('I consent to a face swap video.', { capability: ['face-swap-video'] }).missing, [])
})

test('R11: a place name inside a longer place name is not that place', () => {
  for (const [t, code] of [
    ['I consent to advertising in South America.', 'US'],
    ['I consent to advertising in America.', 'US'],
    ['I consent to advertising in Northern Ireland.', 'IE'],
    ['I consent to advertising in New Mexico.', 'MX'],
    ['I consent to advertising in New Jersey.', 'JE'],
    ['I consent to advertising in Papua New Guinea.', 'GN'],
    ['I consent to advertising in the UK, paid in U.S. dollars.', 'US'],
  ]) assert.ok(checkSpokenScope(t, { territory: [code] }).missing.includes(code), t)
  assert.deepEqual(checkSpokenScope('I consent to advertising in the United States.', { territory: ['US'] }).missing, [])
  assert.deepEqual(checkSpokenScope('I consent to advertising in Ireland.', { territory: ['IE'] }).missing, [])
})

test('R12: what the words were not checked against is listed, so the caller must confirm it', () => {
  const req = { capability: ['face-swap-video'], useClass: ['advertising'], territory: [] }
  const unrestricted = checkSpokenScope('I consent to a face swap video for advertising, only in the UK, for one week.', req)
  assert.ok(passes(unrestricted))
  assert.equal(unrestricted.confirmed, false)
  assert.deepEqual(unrestricted.unchecked, ['validity', 'ceiling', 'territory-unrestricted'])
  const read = checkSpokenScope(consentScript(req), req)
  assert.equal(read.confirmed, true)
  assert.match(read.note, /not checked against: validity, ceiling, territory-unrestricted/)
  assert.deepEqual(scope('I consent to a talking head for advertising in the UK.').unchecked, ['validity', 'ceiling'])
})

test('the consent script for several terms still passes, and so does a ceiling said aloud', () => {
  const req = { capability: ['talking-head', 'face-swap-video'], useClass: ['advertising', 'education'], territory: ['GB', 'US'], validUntil: '2026-12-12T00:00:00Z', maxSpendUsd: 5 }
  const r = checkSpokenScope(consentScript(req), req)
  assert.deepEqual([r.missing, r.contradicted], [[], []])
  assert.ok(passes(scope('We agree to a talking head for ads in the UK, no more than five dollars.')))
  assert.ok(passes(scope('I consent to a talking head for advertising in the UK and nowhere else. Nothing else.')))
  assert.ok(!passes(scope('I consent to a talking head for advertising in the UK. Nothing else is not okay.'))) // the guard removes only its own words
})

/* ------------------------- transcription, live shape ------------------------- */

const liveAsr = JSON.parse(readFileSync(new URL('./fixtures/live/asr-nemotron-run-capability.json', import.meta.url)))
const liveExpired = JSON.parse(readFileSync(new URL('./fixtures/live/asr-get-upload-expired.json', import.meta.url)))
const CLIP = liveAsr.structuredContent.source_url
const asrError = stage => e => e instanceof ConsentError && e.stage === stage

test('the captured nemotron-asr response yields its transcript', async () => {
  assert.equal(transcriptFrom(liveAsr.structuredContent, ''), 'This render was authorized by a grant I published myself.')
  const r = await transcribe(stubClient({ run_capability: [ok(liveAsr.structuredContent, 'nemotron-asr: done')] }), CLIP)
  assert.equal(r.transcript, 'This render was authorized by a grant I published myself.')
  // It is not consent: no first-person consent clause.
  assert.equal(checkSpokenScope(r.transcript, REQ).affirmative, false)
})

test('a transcript of a different source than the clip is refused', async () => {
  await assert.rejects(transcribe(stubClient({ run_capability: [ok(liveAsr.structuredContent)] }), 'https://agent.livepeer.org/a/other.mp4'), asrError('asr'))
  const swapped = { ...liveAsr.structuredContent, capability: 'whisper-large' }
  await assert.rejects(transcribe(stubClient({ run_capability: [ok(swapped)] }), CLIP), /served by whisper-large/)
})

test('a failed or pending status is never read as speech', async () => {
  for (const reply of [
    asrOk(CLIP, { status: 'submitted', job_id: 'mjob_93244be79885' }, 'Job mjob_93244be79885 is NOT done — poll get_create_media'),
    asrOk(CLIP, { status: 'RUNNING', job_id: 'j_123' }, 'Job j_123 is running.'),
    asrOk(CLIP, { status: 'failed', error: 'provider unavailable' }, 'Run failed: provider unavailable for nemotron-asr'),
    asrOk(CLIP, { ok: false, error: 'no audio stream' }, 'nemotron-asr failed: no audio stream'),
    asrOk(CLIP, { status: 'weird' }, 'I consent to a talking head for advertising in the UK.'),
    ok({ ok: true, capability: 'nemotron-asr' }, 'I consent to a talking head for advertising in the UK.'),
    ok(null, 'Job j_1 submitted; poll get_job'),
  ]) {
    await assert.rejects(transcribe(stubClient({ run_capability: [reply] }), CLIP), asrError('asr'), JSON.stringify(reply))
  }
})

test('text mixed with a link is refused', async () => {
  const mixed = asrOk(CLIP, { result: { text: 'I consent to a talking head. See https://storage.example/t.json' } })
  await assert.rejects(transcribe(stubClient({ run_capability: [mixed] }), CLIP), /mixed with a link/)
  const both = asrOk(CLIP, { result: { text: 'I consent to a talking head.' }, url: 'https://storage.example/t.json' })
  await assert.rejects(transcribe(stubClient({ run_capability: [both] }), CLIP), /both text and a link/)
})

test('a transcript link is fetched only as capped text or JSON, and never as the clip', async () => {
  const srv = await clipServer()
  const clip = `${srv.base}/clip.mp4`
  const via = path => transcribe(stubClient({ run_capability: [asrOk(clip, { url: `${srv.base}${path}` })] }), clip)
  try {
    assert.match((await via('/t.txt')).transcript, /talking head/)
    await assert.rejects(via('/clip.mp4'), /consent clip itself/)
    await assert.rejects(via('/to-clip'), /consent clip itself/)
    await assert.rejects(via('/meta.mp4'), /video\/mp4, not text or JSON/)
    await assert.rejects(via('/big.txt'), /byte limit/)
    await assert.rejects(via('/binary.txt'), asrError('asr'))
  } finally {
    await srv.close()
  }
})

test('capture reports a pending transcription as an ASR error, with no scope', async () => {
  const srv = await clipServer()
  try {
    const client = stubClient({
      request_upload: [ok({ page_url: 'https://agent.livepeer.org/u/aaaaaaaaaaaaaaaaaaaaaaaa', token: 'aaaaaaaaaaaaaaaaaaaaaaaa' })],
      get_upload: [ok({ status: 'done', url: `${srv.base}/clip.mp4` })],
      run_capability: [ok({ status: 'queued', job_id: 'j_9' }, 'I consent to a talking head for advertising in the UK.')],
    })
    const r = await captureConsent({ requested: REQ, client, onLink: () => {} })
    assert.equal(r.scope, null)
    assert.match(r.asrError, /not finished/)
  } finally {
    await srv.close()
  }
})

/* ------------------------------ upload polling ------------------------------ */

test('LP-7: one failed poll does not abort the wait', async () => {
  let t = 0
  let calls = 0
  const client = { async callTool() {
    calls++
    if (calls === 2) throw new Error('fetch failed')
    return calls < 3 ? ok({ status: 'pending' }) : ok({ status: 'done', url: 'https://agent.livepeer.org/a/clip.mp4' })
  } }
  const slept = []
  const r = await awaitCapture(client, 'aaaaaaaaaaaaaaaaaaaaaaaa', { deadline: 30 * 60_000, now: () => (t += 20_000), sleep: async ms => { slept.push(ms) } })
  assert.equal(r.url, 'https://agent.livepeer.org/a/clip.mp4')
  assert.equal(r.errors, 1)
  assert.equal(slept.length, 1)
})

test('the captured expired get_upload ends the wait', async () => {
  const r = await awaitCapture(stubClient({ get_upload: [ok(liveExpired.structuredContent, liveExpired.text)] }), liveExpired.structuredContent.token)
  assert.equal(r.status, 'expired')
  const textOnly = await getUpload(stubClient({ get_upload: [ok(null, liveExpired.text)] }), liveExpired.structuredContent.token)
  assert.equal(textOnly.status, 'expired')
})

test('"not expired" is not expired', async () => {
  assert.equal(saysExpired('Upload session abc is not expired yet; still waiting.'), false)
  assert.equal(saysExpired("It hasn't expired."), false)
  const r = await getUpload(stubClient({ get_upload: [ok(null, 'Upload session abc is not expired yet; still waiting.')] }), 'abc')
  assert.equal(r.status, 'pending')
})

test('the text URL fallback: trailing punctuation, real /u/ media paths, no docs links, no override of pending', async () => {
  const up = async (structured, text) => getUpload(stubClient({ get_upload: [ok(structured, text)] }), 'abc')
  assert.equal((await up(null, 'Uploaded: https://agent.livepeer.org/a/clip.mp4.')).url, 'https://agent.livepeer.org/a/clip.mp4')
  assert.equal((await up({ status: 'done' }, 'Uploaded: https://agent.livepeer.org/a/abc/clip.mp4')).url, 'https://agent.livepeer.org/a/abc/clip.mp4')
  // Media on any other host is never taken from prose.
  assert.equal((await up(null, 'Uploaded: https://storage.example/clip.mp4.')).url, null)
  assert.equal((await up({ status: 'done' }, 'Uploaded: https://storage.example.com/u/abc/clip.mp4')).url, null)
  assert.equal((await up({ status: 'pending' }, 'Still waiting. Share https://agent.livepeer.org/docs/uploads with the recorder.')).url, null)
  assert.equal((await up(null, 'Open https://agent.livepeer.org/u/23db6e65438e3934922a3c17 on your phone.')).url, null)
  const pending = await up({ status: 'pending' }, 'Almost: https://storage.example/clip.mp4')
  assert.deepEqual([pending.url, pending.status], [null, 'pending'])
  assert.equal((await up({ status: 'done', url: 'https://agent.livepeer.org/u/23db6e65438e3934922a3c17' }, '')).url, null)
  assert.equal(uploadUrlFromText('https://agent.livepeer.org/a/one.mp4 or https://agent.livepeer.org/a/two.mp4'), null)
  assert.equal((await up({ status: 'Done', url: 'https://agent.livepeer.org/a/clip.webm' }, '')).status, 'done')
})

test('a transcript link that is the clip URL is refused before anything is downloaded', async () => {
  const calls = []
  const spy = async url => { calls.push(String(url)); return new Response('I consent to a talking head for advertising in the UK.', { headers: { 'content-type': 'text/plain' } }) }
  const clip = 'https://storage.example/u/clip.mp4'
  await assert.rejects(transcribe(stubClient({ run_capability: [asrOk(clip, { url: `${clip}/` })] }), clip, { fetch: spy }), /consent clip itself/)
  assert.deepEqual(calls, [])
})

test('a term said only in a hedged sentence is missing, even when consent is said elsewhere', () => {
  const r = checkSpokenScope('I consent to a talking head. Would you use it for advertising?', { capability: ['talking-head'], useClass: ['advertising'] })
  assert.ok(r.missing.includes('advertising'), JSON.stringify(r.missing))
  assert.ok(!r.missing.includes('talking-head'))
  assert.equal(r.affirmative, true)
})

/* ------------------- D1: spoken consent is closed-world ------------------- */

const FULL = { ...REQ, validUntil: '2026-12-13T00:00:00Z', maxSpendUsd: 5 }
const SCRIPT = consentScript(FULL)

test('D1: a clean reading of the script is confirmed, and says which words it compared', () => {
  assert.equal(SCRIPT, 'I consent to talking head of my likeness for advertising in United Kingdom until 13 December 2026. Spending is capped at 5 US dollars.')
  const r = checkSpokenScope(SCRIPT, FULL)
  assert.deepEqual(r.scriptMatch, { matched: true, missing: [], extra: [] })
  assert.equal(r.confirmed, true)
  assert.equal(r.script, SCRIPT)
  assert.deepEqual(r.contradicted, [])
})

test('D1: realistic ASR renderings of the script are still confirmed', () => {
  for (const t of [
    'Um, so, hi. I consent to a talking-head of my likeness for advertising in the U.K. until the 13th of December 2026. Spending is capped at five US dollars. Okay.',
    'i consent to talking head of my likeness for advertising in the uk until december 13th, twenty twenty-six. spending is capped at $5',
    'I consent to talking head of my likeness for advertising in the United Kingdom until thirteenth December two thousand and twenty six. Spending is capped at 5 dollars.',
    'Uh, I consent to talking head of likeness for advertising in UK until 13 December 2026. Spending capped at 5 USD. Yes.',
    'I consent to talking head of my likeness for advertising in United Kingdom until December the 13th 2026. Spending is capped at $5.00.',
  ]) {
    const r = checkSpokenScope(t, FULL)
    assert.equal(r.confirmed, true, `${t} -> ${JSON.stringify(r.scriptMatch)} ${JSON.stringify(r.contradicted)}`)
  }
  const lip = { capability: ['lipsync'], useClass: ['advertising', 'education'], territory: ['GB', 'US'], maxSpendUsd: '2.50' }
  assert.equal(consentScript(lip), 'I consent to lip sync of my likeness for advertising and education in United Kingdom and United States. Spending is capped at 2.50 US dollars.')
  for (const t of [
    'I consent to lipsync of my likeness for advertising and education in the U.K. and the U.S.A. Spending is capped at two point five dollars.',
    'I consent to lip-sync of my likeness for advertising and education in the UK and the US. Spending is capped at $2.5.',
  ]) assert.equal(checkSpokenScope(t, lip).confirmed, true, `${t} -> ${JSON.stringify(matchScript(t, lip))}`)
})

test('D1: a missing critical word, a third missing word, a changed number or any extra word is not a match', () => {
  const differs = (t, missing, extra) => {
    const m = matchScript(t, FULL)
    assert.equal(m.matched, false, t)
    if (missing) assert.deepEqual(m.missing, missing, t)
    if (extra) assert.deepEqual(m.extra, extra, t)
    assert.equal(checkSpokenScope(t, FULL).confirmed, false, t)
  }
  differs(SCRIPT.replace('advertising ', ''), ['advertising'], [])
  differs(SCRIPT.replace('I consent', 'consent'), ['i'], [])
  differs(SCRIPT.replace('until 13', 'until 12'), ['13'], ['12'])
  differs(SCRIPT.replace('at 5', 'at 50'), ['5'], ['50'])
  differs(SCRIPT.replace(' of my likeness', ''), ['of', 'my', 'likeness'], [])
  // Two non-critical words may go missing (ASR drops short words); not three.
  assert.equal(matchScript(SCRIPT.replace(' of my', ''), FULL).matched, true)
  differs(SCRIPT.replace('for advertising', 'not for advertising'), [], ['not'])
  differs(SCRIPT.replace('in United Kingdom', 'in United Kingdom but'), [], ['but'])
  differs(`${SCRIPT} Yeah right.`, [], ['right'])
  differs('', null, [])
})

// Every phrasing the verifiers used against the heuristics. None of them is a
// reading of the script, so none may be confirmed, whatever the heuristics say.
const ADVERSARIAL = [
  'I consent to a talking head. Advertising in the UK is evil.',
  'I consent to this recording. The talking head for advertising in the UK is something else.',
  'I consent to being filmed for this recording only. They want a talking head for advertising in the UK.',
  'I consent to a talking head. Advertising companies in the UK keep calling me.',
  'I consent to a talking head of Tom Cruise for advertising in the UK.',
  'I consent to a talking head for everything in the UK but advertising.',
  'I consent to a talking head for advertising in every country in Europe but the UK.',
  'I consent to a talking head for advertising in all the countries of the world but the UK.',
  'I consent to a talking head in the UK for all kinds of things but advertising.',
  'I consent to a talking head in the UK for editorial, education and entertainment but advertising.',
  'I consent to a talking head in the UK for all kinds of uses but advertising.',
  'I consent to a talking head in the UK for any purpose you like but advertising.',
  'I consent to a talking head in the UK save for advertising.',
  'I consent to a talking head in the UK for any purpose save advertising.',
  'I consent to a talking head in the UK for any purpose bar advertising.',
  'I consent to a talking head in the UK barring advertising.',
  'I consent to a talking head in the UK minus advertising.',
  'I consent to a talking head in the UK for any purpose, advertising excepted.',
  'I consent to a talking head for advertising anywhere else than the UK.',
  'I consent to a talking head for advertising everywhere beyond the UK.',
  'I consent to a talking head in the UK for anything bar advertising.',
  'I consent to a talking head in the UK for anything save for advertising.',
  'I consent to a talking head for advertising in the UK. Advertising is unacceptable.',
  'I consent to a talking head for advertising in the UK. Advertising is out of the question.',
  'I consent to a talking head in the UK; advertising is right out.',
  'I consent to a talking head in the UK. Advertising is a dealbreaker.',
  'I consent to a talking head in the UK. Advertising is where I draw the line.',
  'I consent to a talking head in the UK. Keep advertising away from me.',
  'I consent to a talking head in the UK. Advertising: negative.',
  'I consent to a talking head in the UK. Advertising, nay.',
  'I consent to a talking head in the UK. Advertising. Nuh uh.',
  'I consent to a talking head in the UK. Advertising: I pass.',
  'I consent to a talking head in the UK. As for advertising, the answer is negative.',
  'I consent to a talking head for advertising in the UK. Scrap the advertising.',
  'I consent to a talking head for advertising in the UK. Leave out the advertising.',
  'I consent to a talking head for advertising in the UK. Advertising? Pass.',
  'I consent to a talking head in the UK. I havent agreed to advertising.',
  'I consent to a talking head in the UK. Advertising mustnt happen.',
  'I consent to a talking head in the UK for advertising. I take back my consent.',
  'I consent to a talking head in the UK for advertising. I retract that.',
  'I consent to a talking head in the UK for advertising. I rescind that.',
  'I consent to a talking head in the UK for advertising. Strike that.',
  'I consent to a talking head in the UK for advertising. Undo.',
  'I consent to a talking head in the UK for advertising. That was a lie.',
  'I consent to a talking head for advertising in the UK. Psych!',
  'I consent to a talking head for advertising in the UK. I am being facetious.',
  'I consent to a talking head for advertising in the UK. Yeah right.',
  'I consent to a talking head for advertising in the UK. As if.',
  'I consent to a talking head for advertising in the UK. Over my dead body.',
  'I consent to a talking head for advertising in the UK. In your dreams.',
  'I consent to a talking head for advertising in the UK when hell freezes over.',
  'I consent to a talking head for advertising in the UK when pigs fly.',
  'I consent to a talking head for advertising in the UK... in another life.',
  'I consent to a talking head for advertising in the UK only in my dreams.',
  'I consent to a talking head in the UK for advertising. April fools.',
  'I consent to a talking head in the UK for advertising. Ignore what I just said.',
  'I consent to talking head for advertising in the UK. Ha ha.',
  'We agree that a talking head for advertising in the UK is creepy.',
  'I agree with the critics: a talking head for advertising in the UK is exploitation.',
  'I allow my lawyer to decide on a talking head for advertising in the UK.',
  'I agree that a talking head for advertising in the UK is wrong.',
  'My manager wrote: I consent to a talking head for advertising in the UK.',
  'Repeat after me: I consent to a talking head for advertising in the UK.',
  'I am reading this script: I consent to a talking head for advertising in the UK.',
  'I am being forced. I consent to a talking head for advertising in the UK.',
  'Under duress, I consent to a talking head for advertising in the UK.',
  'The contract states I consent to a talking head for advertising in the UK.',
  'She wrote I consent to a talking head for advertising in the UK.',
  'I consent to a talking head for advertising in the UK. They told me to say that.',
  'I consent to a talking head for advertising in the UK. I am being forced to read this.',
  'I consent to a talking head for advertising in the UK on the condition that they pay me.',
  'I consent to a talking head for advertising in the UK when they pay me.',
  'I consent to a talking head for advertising in the UK subject to payment.',
  'and do I consent to a talking head for advertising in the UK',
  'why should I consent to a talking head for advertising in the UK',
  'I consent to a talking head in the UK. Advertising is not only wrong, it is disgusting.',
  'I consent to a talking head. My cousin works in advertising in the UK.',
]

test('D1: no adversarial phrasing is confirmed, nor the same phrasing wrapped around a reading of the script', () => {
  for (const t of ADVERSARIAL) {
    const r = scope(t)
    assert.equal(r.confirmed, false, t)
    assert.equal(r.scriptMatch.matched, false, t)
  }
  const base = consentScript(REQ)
  for (const t of [
    base.replace('for advertising', 'for everything but advertising'),
    base.replace('in United Kingdom', 'in every country in the world but the United Kingdom'),
    base.replace('for advertising', 'for any purpose save advertising'),
    `${base} That was a lie.`,
    `${base} Just kidding.`,
    `${base} I take back my consent.`,
    `Repeat after me: ${base}`,
    `Under duress, ${base}`,
    `${base} On the condition that they pay me.`,
    `Why should ${base}`,
    base.replace('I consent', 'I do not consent'),
    base.replace('for advertising', 'for advertising, no'),
  ]) {
    const r = scope(t)
    assert.equal(r.confirmed, false, `${t} -> ${JSON.stringify(r.scriptMatch)}`)
  }
  // The refusal heuristics still stop these outright.
  assert.ok(scope(`${base} That was a lie.`).contradicted.includes('consent'))
  assert.ok(scope(base.replace('I consent', 'I do not consent')).contradicted.includes('consent'))
})

test('D1: the script for every territory normalises cleanly and confirms its own reading', () => {
  const names = new Intl.DisplayNames(['en'], { type: 'region' })
  for (let a = 65; a < 91; a++) {
    for (let b = 65; b < 91; b++) {
      const code = String.fromCharCode(a, b)
      const name = names.of(code)
      if (!name || name === code || /^Pseudo/.test(name)) continue
      const req = { capability: ['talking-head'], useClass: ['advertising'], territory: [code], validUntil: '2027-01-01T00:00:00Z', maxSpendUsd: 12.5 }
      const r = checkSpokenScope(consentScript(req), req)
      assert.equal(r.scriptMatch.matched, true, `${code} ${consentScript(req)} ${JSON.stringify(r.scriptMatch)}`)
    }
  }
  assert.doesNotMatch(consentScript({ territory: ['MM'] }), /\(/)
  assert.deepEqual(scriptWords('St. Kitts & Nevis, Côte d’Ivoire'), ['saint', 'kitts', 'and', 'nevis', 'cote', 'd', 'ivoire'])
})

test('D1: a script reading that the refusal heuristics contradict is not confirmed', () => {
  // A term whose own words read as a refusal: the script matches, the hard stop still wins.
  const req = { capability: ['never-ending'], useClass: ['advertising'] }
  const r = checkSpokenScope(consentScript(req), req)
  assert.equal(r.scriptMatch.matched, true)
  assert.ok(r.contradicted.length > 0)
  assert.equal(r.confirmed, false)
  assert.match(r.note, /CONTRADICTS/)
})

test('D1: filler is closed: no negator, conjunction or conditional is ever ignored', () => {
  for (const w of ['not', 'no', 'but', 'and', 'if', 'unless', 'when', 'right', 'never', 'except']) {
    assert.equal(matchScript(`${SCRIPT} ${w}`, FULL).matched, false, w)
  }
  for (const w of ['um', 'uh', 'so', 'okay', 'yes', 'hello']) assert.equal(matchScript(`${w} ${SCRIPT} ${w}`, FULL).matched, true, w)
})

/* ------------------ heuristics: refusals the first round missed ------------------ */

test('heuristics: new exclusions, refusals, contractions and retractions contradict', () => {
  for (const [t, term] of [
    ['I consent to a talking head in the UK for all kinds of uses but advertising.', 'advertising'],
    ['I consent to a talking head for advertising in any country in the world but the UK.', 'GB'],
    ['I consent to a talking head in the UK for editorial, education and entertainment but advertising.', 'advertising'],
    ['I consent to a talking head in the UK for anything bar advertising.', 'advertising'],
    ['I consent to a talking head in the UK save for advertising.', 'advertising'],
    ['I consent to a talking head in the UK minus advertising.', 'advertising'],
    ['I consent to a talking head for advertising everywhere beyond the UK.', 'GB'],
    ['I consent to a talking head for advertising in the UK. Advertising is out of the question.', 'advertising'],
    ['I consent to a talking head for advertising in the UK. Advertising is unacceptable.', 'advertising'],
    ['I consent to a talking head for advertising in the UK. Leave out the advertising.', 'advertising'],
    ['I consent to a talking head in the UK. I havent agreed to advertising.', 'advertising'],
    ['I consent to a talking head in the UK. Advertising mustnt happen.', 'advertising'],
    ['I consent to a talking head in the UK. Advertising is not only wrong, it is disgusting.', 'advertising'],
    ['I consent to a talking head for advertising in the UK. That was a lie.', 'consent'],
    ['I consent to a talking head in the UK for advertising. I take back my consent.', 'consent'],
    ['I consent to a talking head in the UK for advertising. I rescind that.', 'consent'],
    ['I consent to a talking head for advertising in the UK when pigs fly.', 'consent'],
    ['I consent to a talking head for advertising in the UK. I am being forced to read this.', 'consent'],
    ['I consent to a talking head for advertising in the UK. They told me to say that.', 'consent'],
  ]) {
    const r = scope(t)
    assert.ok(r.contradicted.includes(term), `${t} -> ${JSON.stringify(r.contradicted)}`)
  }
  // "anything" is one of the universals that turns a later "but" into an exclusion.
  // The clause after "but" is more than a term, so only the universal rule catches it.
  assert.ok(scope('I consent to a talking head in the UK for anything you would like but advertising, obviously.').contradicted.includes('advertising'))
})

test('heuristics: agreeing with an opinion, delegating, unpunctuated questions and conditions are not affirmative', () => {
  for (const t of [
    'I agree that a talking head for advertising in the UK is wrong.',
    'We agree with the critics about a talking head for advertising in the UK.',
    'I allow my lawyer to decide on a talking head for advertising in the UK.',
    'and do I consent to a talking head for advertising in the UK',
    'why should I consent to a talking head for advertising in the UK',
    'I consent to a talking head for advertising in the UK on the condition that they pay me.',
    'I consent to a talking head for advertising in the UK subject to payment.',
    'The contract states I consent to a talking head for advertising in the UK.',
    'She wrote I consent to a talking head for advertising in the UK.',
  ]) assert.equal(scope(t).affirmative, false, t)
  assert.equal(scope('I authorise you to make a talking head for advertising in the UK.').affirmative, true)
  assert.equal(scope('I consent to advertising in the United States.').affirmative, true)
})

/* ------------------ transcription: failures at any depth ------------------ */

test('a failure marker nested in result or output, or in state, success or job_status, is never speech', async () => {
  const said = { text: 'I consent to a talking head for advertising in the UK.' }
  for (const [fields, why] of [
    [{ result: { ...said, ok: false } }, /ok: false/],
    [{ result: { ...said, status: 'failed' } }, /status failed/],
    [{ result: { ...said, error: 'model crashed; partial' } }, /model crashed/],
    [{ output: { ...said, state: 'failed' } }, /state failed/],
    [{ run_output: { ...said, success: false } }, /ok: false/],
    [{ state: 'failed', result: said }, /state failed/],
    [{ job_status: 'failed', result: said }, /job_status failed/],
    [{ phase: 'running', result: said }, /not finished/],
    [{ success: false, result: said }, /ok: false/],
    [{ status: 'failed', result: said }, /status failed/],
  ]) {
    await assert.rejects(transcribe(stubClient({ run_capability: [asrOk(CLIP, fields)] }), CLIP), e => asrError('asr')(e) && why.test(e.message), JSON.stringify(fields))
  }
  // Without ok: true, without provenance, or as plain text alone: refused.
  await assert.rejects(transcribe(stubClient({ run_capability: [asrOk(CLIP, { ok: undefined, result: said })] }), CLIP), /ok: true/)
  await assert.rejects(transcribe(stubClient({ run_capability: [ok({ ok: true, source_url: CLIP, result: said })] }), CLIP), /which capability/)
  await assert.rejects(transcribe(stubClient({ run_capability: [ok({ ok: true, capability: 'nemotron-asr', result: said })] }), CLIP), /which clip/)
  await assert.rejects(transcribe(stubClient({ run_capability: [ok(null, said.text)] }), CLIP), /no structured result/)
})

test('platform status text in a transcript field is not speech', async () => {
  for (const fields of [
    { output: 'Job submitted, poll get_job' },
    { output: 'Job submitted for me, poll get_job' },
    { text: 'Processing... please wait' },
    { result: { text: 'Job submitted. Call get_job to poll.' } },
    { result: { text: 'Sorry, the audio could not be processed.' } },
  ]) {
    await assert.rejects(transcribe(stubClient({ run_capability: [asrOk(CLIP, fields)] }), CLIP), /platform status message/, JSON.stringify(fields))
  }
  // Speech with a first-person word is still speech, even with a word like "status".
  const r = await transcribe(stubClient({ run_capability: [asrOk(CLIP, { result: { text: 'I consent, whatever my status.' } })] }), CLIP)
  assert.equal(r.transcript, 'I consent, whatever my status.')
})

test('a transcript link must use https unless it is loopback', async () => {
  const spy = []
  const fetch = async u => { spy.push(String(u)); return new Response('I consent to a talking head for advertising in the UK.', { headers: { 'content-type': 'text/plain' } }) }
  await assert.rejects(transcribe(stubClient({ run_capability: [asrOk(CLIP, { url: 'http://storage.example/t.txt' })] }), CLIP, { fetch }), /must use https/)
  await assert.rejects(transcribe(stubClient({ run_capability: [asrOk(CLIP, { url: 'http://agent.livepeer.org/a/t.txt' })] }), CLIP, { fetch }), /must use https/)
  assert.deepEqual(spy, [])
  assert.match((await transcribe(stubClient({ run_capability: [asrOk(CLIP, { url: 'https://storage.example/t.txt' })] }), CLIP, { fetch })).transcript, /talking head/)
})

test('a transcript body that fails mid-stream is a ConsentError at stage asr, and an oversize body is cancelled', async () => {
  const erroring = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('I ')); c.error(new Error('socket hang up')) } }), { headers: { 'content-type': 'text/plain' } })
  await assert.rejects(transcribe(stubClient({ run_capability: [asrOk(CLIP, { url: 'https://storage.example/t.txt' })] }), CLIP, { fetch: erroring }), e => asrError('asr')(e) && /socket hang up/.test(e.message))
  let cancelled = false
  const endless = async () => new Response(new ReadableStream({
    pull(c) { c.enqueue(new Uint8Array(4096).fill(0x61)) },
    cancel() { cancelled = true },
  }), { headers: { 'content-type': 'text/plain' } })
  await assert.rejects(transcribe(stubClient({ run_capability: [asrOk(CLIP, { url: 'https://storage.example/t.txt' })] }), CLIP, { fetch: endless, maxBytes: 10_000 }), /byte limit/)
  assert.equal(cancelled, true)
})

test('a JSON transcript link that reports its own failure, or a plain-text status, is refused', async () => {
  const serve = (body, type) => async () => new Response(body, { headers: { 'content-type': type } })
  const via = f => transcribe(stubClient({ run_capability: [asrOk(CLIP, { url: 'https://storage.example/t' })] }), CLIP, { fetch: f })
  await assert.rejects(via(serve(JSON.stringify({ status: 'failed', text: 'I consent' }), 'application/json')), /status failed/)
  await assert.rejects(via(serve(JSON.stringify({ ok: false, text: 'I consent' }), 'application/json')), /ok: false/)
  await assert.rejects(via(serve(JSON.stringify({ result: { error: 'partial', text: 'I consent' } }), 'application/json')), /partial/)
  await assert.rejects(via(serve('Job queued, poll later', 'text/plain')), /platform status message/)
  assert.equal((await via(serve(JSON.stringify({ text: 'I consent to a talking head.' }), 'application/json'))).transcript, 'I consent to a talking head.')
})

test('percent-encoding and doubled slashes do not disguise the clip as its transcript', async () => {
  const calls = []
  const spy = async url => { calls.push(String(url)); return new Response('I consent', { headers: { 'content-type': 'text/plain' } }) }
  for (const link of ['https://agent.livepeer.org/a/%65xample.mp4', 'https://agent.livepeer.org//a/example.mp4', 'https://AGENT.livepeer.org/a/example.mp4/']) {
    await assert.rejects(transcribe(stubClient({ run_capability: [asrOk(CLIP, { url: link })] }), CLIP, { fetch: spy }), /consent clip itself/, link)
  }
  assert.deepEqual(calls, [])
  // The final URL after redirects is compared the same way.
  const redirected = async () => Object.defineProperty(new Response('I consent', { headers: { 'content-type': 'text/plain' } }), 'url', { value: 'https://agent.livepeer.org/a/%65xample.mp4' })
  await assert.rejects(transcribe(stubClient({ run_capability: [asrOk(CLIP, { url: 'https://storage.example/t.txt' })] }), CLIP, { fetch: redirected }), /redirects to the consent clip/)
})

/* ------------------ upload polling: permanent answers end the wait ------------------ */

test('a get_upload tool error that says expired or unknown ends the wait at once; transport errors are retried', async () => {
  let t = 0
  const opts = { deadline: 30 * 60_000, now: () => (t += 1000), sleep: async () => {} }
  const expired = await awaitCapture(stubClient({ get_upload: [bad('Upload session expired')] }), 'abc', opts)
  assert.deepEqual([expired.status, expired.polls], ['expired', 1])
  const unknown = await awaitCapture(stubClient({ get_upload: [bad('unknown upload token')] }), 'abc', opts)
  assert.deepEqual([unknown.status, unknown.polls], ['failed', 1])
  assert.match(unknown.lastError, /unknown upload token/)
  // The same unexplained tool error, again and again: stop after five.
  const same = await awaitCapture(stubClient({ get_upload: [bad('upstream said no')] }), 'abc', opts)
  assert.deepEqual([same.status, same.polls], ['failed', 5])
  // A transport error is the network, not the platform: keep waiting.
  let calls = 0
  const flaky = { async callTool() { calls++; if (calls < 8) throw new Error('fetch failed'); return ok({ status: 'done', url: 'https://agent.livepeer.org/a/clip.mp4' }) } }
  assert.equal((await awaitCapture(flaky, 'abc', opts)).url, 'https://agent.livepeer.org/a/clip.mp4')
})

test('an unknown upload status ends the wait and is reported as itself, not as expired', async () => {
  let t = 0
  for (const status of ['not_found', 'invalid', 'gone']) {
    const r = await awaitCapture(stubClient({ get_upload: [ok({ status })] }), 'abc', { deadline: 60_000, now: () => (t += 1000) })
    assert.deepEqual([r.status, r.polls], [status, 1])
  }
  const waiting = await awaitCapture(stubClient({ get_upload: [() => { t += 20_000; return ok({ status: 'waiting' }) }] }), 'abc', { deadline: t + 60_000, now: () => t })
  assert.equal(waiting.status, 'expired')
  assert.ok(waiting.polls > 1)
})

test('saysExpired reads typographic apostrophes and hyphens as the plain ones', async () => {
  assert.equal(saysExpired('Session abc hasn’t expired; still waiting.'), false)
  assert.equal(saysExpired('It isn’t expired.'), false)
  assert.equal(saysExpired('Status: not-expired'), false)
  assert.equal(saysExpired('That upload link expired — I can make a new one.'), true)
  const r = await getUpload(stubClient({ get_upload: [ok(null, 'Session abc hasn’t expired; still waiting.')] }), 'abc')
  assert.equal(r.status, 'pending')
})

test('the text URL fallback: only agent.livepeer.org/a/ media, only when nothing says the upload is still to come', async () => {
  const up = async (structured, text) => getUpload(stubClient({ get_upload: [ok(structured, text)] }), 'abc')
  assert.equal((await up(null, 'Waiting for upload. See https://docs.livepeer.org/guide.mp4')).url, null)
  assert.equal((await up(null, 'Not expired yet, waiting. Example: https://agent.livepeer.org/a/example.mp4')).url, null)
  assert.equal((await up(null, 'Not‑expired yet. https://agent.livepeer.org/a/example.mp4')).url, null)
  // No structured status: the text must say the upload arrived.
  assert.equal((await up(null, 'Here is a sample: https://agent.livepeer.org/a/example.mp4')).url, null)
  assert.equal((await up(null, 'Received: https://agent.livepeer.org/a/abc.mp4')).url, 'https://agent.livepeer.org/a/abc.mp4')
  assert.equal((await up({ status: 'done' }, 'Still uploading, see https://agent.livepeer.org/a/abc.mp4')).url, null)
  assert.equal((await up({ status: 'done' }, 'https://agent.livepeer.org/a/abc.mp4')).url, 'https://agent.livepeer.org/a/abc.mp4')
})

test('a transcript link body with a NUL byte is binary, even when it decodes as UTF-8', async () => {
  const nul = async () => new Response('I consent to a talking head\x00 for advertising in the UK.', { headers: { 'content-type': 'text/plain' } })
  await assert.rejects(transcribe(stubClient({ run_capability: [asrOk(CLIP, { url: 'https://storage.example/t.txt' })] }), CLIP, { fetch: nul }), /binary data/)
})

test('D1: a transcript far longer than the script is not aligned, and not a match', () => {
  const long = `${SCRIPT} ${'um '.repeat(5000)}`
  const t0 = Date.now()
  const r = matchScript(long, FULL)
  assert.equal(r.matched, false)
  assert.ok(Date.now() - t0 < 2000)
})
