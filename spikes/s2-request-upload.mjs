/**
 * S2 — Consent-capture spike.
 *
 * Decides: does request_upload actually mint a phone-openable upload page, and
 * does get_upload return a hosted URL once a file lands? This is the demo's
 * signature beat — consent captured inside the conversation rather than by email.
 *
 * Run with WAIT=1 to hold open and poll for a real phone upload.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { writeFileSync } from 'node:fs'

const BASE = 'https://agent.livepeer.org/api/mcp/raw'
const KEY = process.env.LIVEPEER_AGENT_KEY

async function connect() {
  const h = { 'X-Storyboard-Tool-Profile': 'lean' }
  if (KEY) h['Authorization'] = `Bearer ${KEY}`
  const c = new Client({ name: 'mandate-spike-s2', version: '0.1.0' }, { capabilities: {} })
  await c.connect(new StreamableHTTPClientTransport(new URL(BASE), { requestInit: { headers: h } }))
  return c
}
const textOf = r => (r.content || []).map(c => c.text || '').join('\n')

const client = await connect()

console.log('--- request_upload { kind: "video" } ---')
const req = await client.callTool({ name: 'request_upload', arguments: { kind: 'video' } })
const reqText = textOf(req)
console.log(reqText)

const pageUrl = (reqText.match(/https:\/\/agent\.livepeer\.org\/u\/[a-f0-9]+/) || [])[0] || null
const token = (reqText.match(/\b[a-f0-9]{24}\b/) || [])[0] || null
console.log('\nparsed page_url:', pageUrl)
console.log('parsed token   :', token)

const out = { pageUrl, token, requestText: reqText, uploaded: null }

if (token && process.env.WAIT === '1') {
  console.log('\nOpen that link on a phone and record ~6s of video. Polling get_upload...')
  for (let i = 0; i < 12; i++) {
    const g = await client.callTool({ name: 'get_upload', arguments: { token, wait_seconds: 25 } })
    const t = textOf(g)
    if (/https?:\/\//.test(t) && !/still waiting|no upload|pending/i.test(t)) {
      console.log('\nUPLOAD RECEIVED:\n' + t)
      out.uploaded = t
      break
    }
    console.log(`  [${i + 1}/12] still waiting...`)
  }
} else if (token) {
  // Non-blocking probe: confirms the token is live and the tool answers correctly.
  const g = await client.callTool({ name: 'get_upload', arguments: { token, wait_seconds: 0 } })
  console.log('\n--- get_upload (wait_seconds: 0, nothing uploaded yet) ---')
  console.log(textOf(g))
  out.probe = textOf(g)
}

writeFileSync('spikes/out/s2-report.json', JSON.stringify(out, null, 2))
console.log('\nwrote spikes/out/s2-report.json')
await client.close()
