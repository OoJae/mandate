import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { checkSpokenScope, consentScript } from '../src/scope.mjs'
import { readFileSync } from 'node:fs'
import { captureConsent, awaitCapture, transcribe, transcriptFrom, ConsentError } from '../src/consent.mjs'
import { getUpload, saysExpired, uploadUrlFromText } from '../src/livepeer.mjs'
import { reconcile } from '../src/derivation.mjs'

const REQ = { capability: ['talking-head'], useClass: ['advertising'], territory: ['GB'] }
const scope = t => checkSpokenScope(t, REQ)

test('every requested term said plainly is matched', () => {
  const r = scope('I consent to a talking head video of my likeness for advertising in the United Kingdom.')
  assert.deepEqual([r.missing, r.contradicted], [[], []])
  assert.match(r.note, /mentions every requested term/)
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
    const viaLink = await transcribe(stubClient({ run_capability: [ok({ ok: true, url: `${srv.base}/t.json` }, `${srv.base}/t.json`)] }), 'https://x.test/c.mp4')
    assert.match(viaLink.transcript, /talking head/)
    await assert.rejects(transcribe(stubClient({ run_capability: [ok({ ok: true }, '')] }), 'https://x.test/c.mp4'), /no text/)
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
  const unrestricted = checkSpokenScope('I consent to a face swap video for advertising, only in the UK, for one week.', { capability: ['face-swap-video'], useClass: ['advertising'], territory: [] })
  assert.ok(passes(unrestricted))
  assert.deepEqual(unrestricted.unchecked, ['validity', 'ceiling', 'territory-unrestricted'])
  assert.match(unrestricted.note, /not checked against: validity, ceiling, territory-unrestricted/)
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
    ok({ status: 'submitted', job_id: 'mjob_93244be79885' }, 'Job mjob_93244be79885 is NOT done — poll get_create_media'),
    ok({ status: 'RUNNING', job_id: 'j_123' }, 'Job j_123 is running.'),
    ok({ status: 'failed', error: 'provider unavailable' }, 'Run failed: provider unavailable for nemotron-asr'),
    ok({ ok: false, error: 'no audio stream' }, 'nemotron-asr failed: no audio stream'),
    ok({ status: 'weird' }, 'I consent to a talking head for advertising in the UK.'),
    ok({ ok: true, capability: 'nemotron-asr' }, 'I consent to a talking head for advertising in the UK.'),
    ok(null, 'Job j_1 submitted; poll get_job'),
  ]) {
    await assert.rejects(transcribe(stubClient({ run_capability: [reply] }), CLIP), asrError('asr'), JSON.stringify(reply))
  }
})

test('text mixed with a link is refused', async () => {
  const mixed = ok({ ok: true, result: { text: 'I consent to a talking head. See https://storage.example/t.json' } })
  await assert.rejects(transcribe(stubClient({ run_capability: [mixed] }), CLIP), /mixed with a link/)
  const both = ok({ ok: true, result: { text: 'I consent to a talking head.' }, url: 'https://storage.example/t.json' })
  await assert.rejects(transcribe(stubClient({ run_capability: [both] }), CLIP), /both text and a link/)
})

test('a transcript link is fetched only as capped text or JSON, and never as the clip', async () => {
  const srv = await clipServer()
  const clip = `${srv.base}/clip.mp4`
  const via = path => transcribe(stubClient({ run_capability: [ok({ ok: true, url: `${srv.base}${path}` })] }), clip)
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
  assert.equal((await up(null, 'Uploaded: https://storage.example/clip.mp4.')).url, 'https://storage.example/clip.mp4')
  assert.equal((await up({ status: 'done' }, 'Uploaded: https://storage.example.com/u/abc/clip.mp4')).url, 'https://storage.example.com/u/abc/clip.mp4')
  assert.equal((await up({ status: 'pending' }, 'Still waiting. Share https://agent.livepeer.org/docs/uploads with the recorder.')).url, null)
  assert.equal((await up(null, 'Open https://agent.livepeer.org/u/23db6e65438e3934922a3c17 on your phone.')).url, null)
  const pending = await up({ status: 'pending' }, 'Almost: https://storage.example/clip.mp4')
  assert.deepEqual([pending.url, pending.status], [null, 'pending'])
  assert.equal((await up({ status: 'done', url: 'https://agent.livepeer.org/u/23db6e65438e3934922a3c17' }, '')).url, null)
  assert.equal(uploadUrlFromText('https://a.example/one.mp4 or https://b.example/two.mp4'), null)
  assert.equal((await up({ status: 'Done', url: 'https://agent.livepeer.org/a/clip.webm' }, '')).status, 'done')
})

test('a transcript link that is the clip URL is refused before anything is downloaded', async () => {
  const calls = []
  const spy = async url => { calls.push(String(url)); return new Response('I consent to a talking head for advertising in the UK.', { headers: { 'content-type': 'text/plain' } }) }
  const clip = 'https://storage.example/u/clip.mp4'
  await assert.rejects(transcribe(stubClient({ run_capability: [ok({ ok: true, url: `${clip}/` })] }), clip, { fetch: spy }), /consent clip itself/)
  assert.deepEqual(calls, [])
})

test('a term said only in a hedged sentence is missing, even when consent is said elsewhere', () => {
  const r = checkSpokenScope('I consent to a talking head. Would you use it for advertising?', { capability: ['talking-head'], useClass: ['advertising'] })
  assert.ok(r.missing.includes('advertising'), JSON.stringify(r.missing))
  assert.ok(!r.missing.includes('talking-head'))
  assert.equal(r.affirmative, true)
})
