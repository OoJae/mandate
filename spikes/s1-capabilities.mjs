/**
 * S1 — Capability verification spike.
 *
 * Decides: are the capabilities Mandate gates actually registered and available?
 * Connects keyless to the live Livepeer Agent MCP endpoint, enumerates the tool
 * surfaces, and calls describe_capability on every capability in the gated set.
 *
 * Writes spikes/out/s1-*.json as committed fixtures.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { writeFileSync } from 'node:fs'

const BASE = 'https://agent.livepeer.org/api/mcp'
const KEY = process.env.LIVEPEER_AGENT_KEY // optional; keyless demo works without

// The capabilities Mandate gates. Success path must be registered+available.
// flux-lora-training is expected to be unregistered — it lives on the REFUSAL path only.
const GATED = [
  'talking-head', 'face-swap-image', 'face-swap-video', 'lipsync',
  'sync-lipsync-v3', 'heygen-twin', 'nemotron-asr', 'flux-lora-training',
]

function headers(lean = true) {
  const h = {}
  if (lean) h['X-Storyboard-Tool-Profile'] = 'lean'
  if (KEY) h['Authorization'] = `Bearer ${KEY}`
  return h
}

async function connect(surface, lean = true) {
  const url = new URL(surface ? `${BASE}/${surface}` : BASE)
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: headers(lean) },
  })
  const client = new Client({ name: 'mandate-spike', version: '0.1.0' }, { capabilities: {} })
  await client.connect(transport)
  return client
}

async function main() {
  const report = { auth: KEY ? 'bearer' : 'keyless', surfaces: {}, capabilities: {} }

  for (const [surface, lean] of [['raw', true], ['full', false]]) {
    try {
      const client = await connect(surface, lean)
      const { tools } = await client.listTools()
      report.surfaces[surface] = { lean, count: tools.length, names: tools.map(t => t.name).sort() }
      console.log(`[${surface}] ${tools.length} tools (lean=${lean})`)
      const want = surface === 'raw'
        ? ['run_capability', 'request_upload', 'get_upload', 'describe_capability',
           'get_pricing', 'get_cost_report', 'spend_cap']
        : ['submit_lora_train', 'get_lora_train', 'apply_lora', 'list_lora_attachments',
           'asset_lineage', 'import_asset', 'voice_create', 'publish_skill']
      for (const w of want) {
        const has = tools.some(t => t.name === w)
        console.log(`   ${has ? 'YES' : ' - '}  ${w}`)
      }
      await client.close()
    } catch (e) {
      report.surfaces[surface] = { error: String(e?.message || e) }
      console.log(`[${surface}] FAILED: ${e?.message || e}`)
    }
  }

  // describe_capability on the gated set, via whichever surface carries it
  let client
  try {
    client = await connect('raw')
  } catch (e) {
    console.log('cannot reach raw surface for describe_capability:', e?.message)
    writeFileSync('spikes/out/s1-report.json', JSON.stringify(report, null, 2))
    return
  }

  console.log('\n--- describe_capability on the gated set ---')
  for (const cap of GATED) {
    try {
      const r = await client.callTool({ name: 'describe_capability', arguments: { name: cap } })
      const text = (r.content || []).map(c => c.text || '').join('\n')
      // describe_capability answers in prose, not JSON. Parse the header line:
      //   "<name> — <availability> · <kind>\nprice: ~$X/unit ...\nlatency: p50 As / p95 Bs ..."
      const head = (text.split('\n')[0] || '')
      const availability = (head.split('—')[1] || '').split('·')[0].trim() || 'unknown'
      const kind = (head.split('·')[1] || '').trim() || ''
      const price = (text.match(/price:\s*([^\n]+)/) || [])[1] || 'n/a'
      const latency = (text.match(/latency:\s*([^\n]+)/) || [])[1] || 'n/a'
      report.capabilities[cap] = { availability, kind, price, latency, text }
      const flag = availability === 'available' ? 'OK  ' : '!!  '
      console.log(`  ${flag}${cap.padEnd(20)} ${availability.padEnd(28)} ${price}`)
    } catch (e) {
      report.capabilities[cap] = { error: String(e?.message || e) }
      console.log(`  ${cap.padEnd(20)} ERROR ${e?.message || e}`)
    }
  }
  await client.close()

  writeFileSync('spikes/out/s1-report.json', JSON.stringify(report, null, 2))
  console.log('\nwrote spikes/out/s1-report.json')
}

main().catch(e => { console.error('FATAL', e); process.exit(1) })
