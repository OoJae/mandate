/**
 * S8 — can the keyless tier still pay, and does idempotency_key replay?
 *
 * After Daydream sk_ keys were retired, it was unknown whether the keyless demo
 * tier still pays for inference. This runs the cheapest image capability twice
 * with one idempotency key: the first call must return media, the second should
 * come back as a replay rather than a second billed render.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { writeFileSync, mkdirSync } from 'node:fs'

const client = new Client({ name: 'mandate-s8', version: '0.1.0' }, { capabilities: {} })
await client.connect(new StreamableHTTPClientTransport(new URL('https://agent.livepeer.org/api/mcp/raw'),
  { requestInit: { headers: { 'X-Storyboard-Tool-Profile': 'lean' } } }))

const key = `mandate-s8-probe-${process.argv[2] ?? 'a'}`
const call = async label => {
  const t0 = Date.now()
  const r = await client.callTool({ name: 'run_capability', arguments: {
    capability: 'flux-schnell', async: false, timeout: 120, idempotency_key: key,
    prompt: 'a single green leaf on a white background, product photo',
    inputs: { width: 512, height: 512 },
  } }, undefined, { timeout: 150000 })
  const text = (r.content || []).map(c => c.text || '').join('\n')
  const out = { label, ms: Date.now() - t0, isError: !!r.isError, structuredContent: r.structuredContent ?? null, text: text.slice(0, 600) }
  console.log(`\n[${label}] ${out.ms}ms isError=${out.isError}`)
  console.log('  text:', text.slice(0, 300).replace(/\n/g, ' '))
  console.log('  structuredContent keys:', r.structuredContent ? Object.keys(r.structuredContent).join(', ') : '(none)')
  if (r.structuredContent) console.log('  replay:', r.structuredContent.idempotency_replay, '| cost:', JSON.stringify(r.structuredContent.cost ?? r.structuredContent.cost_paid_usd ?? null))
  return out
}
const first = await call('first')
const second = await call('second-same-key')
const usage = (await client.callTool({ name: 'me_usage', arguments: {} })).content.map(c => c.text).join('\n')
console.log('\nme_usage:', usage.slice(0, 400).replace(/\n/g, ' | '))
mkdirSync('spikes/out', { recursive: true })
writeFileSync('spikes/out/s8-report.json', JSON.stringify({ key, first, second, usage }, null, 2))
await client.close()
