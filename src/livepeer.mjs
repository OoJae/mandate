/**
 * Livepeer Agent client.
 *
 * Two surfaces are pinned deliberately, and the reason matters to the product:
 *
 *  - `/api/mcp/raw` carries `run_capability`, which dispatches the capability you
 *    named and nothing else. The creative surface is documented to substitute
 *    models. A consent gate that the harness can quietly route around to a
 *    sibling model is not a gate, so every gated dispatch goes through raw.
 *
 *  - `/api/mcp/full` carries the LoRA lifecycle and `asset_lineage`, which exist
 *    on no other surface. It is used for lineage, never for gated dispatch.
 *
 * Header note: the documented `X-Livepeer Agent-Tool-Profile` contains a space,
 * which makes it an invalid HTTP header name that is silently ignored. The
 * header that actually works is `X-Storyboard-Tool-Profile`, and applying it to
 * the full surface trims 206 tools to 26 and hides the LoRA verbs — so it is
 * sent only to raw.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const BASE = 'https://agent.livepeer.org/api/mcp'

export const RAW = 'raw'
export const FULL = 'full'

function headers(surface) {
  const h = {}
  if (surface === RAW) h['X-Storyboard-Tool-Profile'] = 'lean'
  const key = process.env.LIVEPEER_AGENT_KEY
  // Claude Code / Cursor / Codex want a space after "Bearer"; Claude Desktop via
  // mcp-remote wants none. We talk HTTP directly, so the standard form is right.
  if (key) h['Authorization'] = `Bearer ${key}`
  return h
}

export async function connect(surface = RAW) {
  const client = new Client({ name: 'mandate', version: '0.1.0' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`${BASE}/${surface}`), { requestInit: { headers: headers(surface) } },
  ))
  return client
}

export const textOf = r => (r.content || []).map(c => c.text || '').join('\n')

/** Parse the prose `describe_capability` answer into something checkable. */
export function parseCapability(text) {
  const head = (text.split('\n')[0] || '')
  return {
    availability: (head.split('—')[1] || '').split('·')[0].trim() || 'unknown',
    kind: (head.split('·')[1] || '').trim() || '',
    price: (text.match(/price:\s*([^\n]+)/) || [])[1] || null,
    latency: (text.match(/latency:\s*([^\n]+)/) || [])[1] || null,
    text,
  }
}

export async function describeCapability(client, name) {
  return parseCapability(textOf(await client.callTool({
    name: 'describe_capability', arguments: { name },
  })))
}

/**
 * Mint a phone upload link. This is the primitive that turns consent from an
 * out-of-band email chain into a step inside the conversation, and it works
 * without a key.
 */
export async function requestUpload(client, kind = 'video') {
  const text = textOf(await client.callTool({ name: 'request_upload', arguments: { kind } }))
  return {
    pageUrl: (text.match(/https:\/\/agent\.livepeer\.org\/u\/[a-f0-9]+/) || [])[0] || null,
    token: (text.match(/\b[a-f0-9]{24}\b/) || [])[0] || null,
    text,
  }
}

export async function getUpload(client, token, waitSeconds = 20) {
  const text = textOf(await client.callTool({
    name: 'get_upload', arguments: { token, wait_seconds: waitSeconds },
  }))
  const url = (text.match(/https?:\/\/\S+\.(?:mp4|mov|jpg|jpeg|png|heic|webm|m4a|wav)\b/i) || [])[0] || null
  return { url, pending: !url, text }
}

/**
 * Dispatch a gated capability.
 *
 * Nothing in this module decides whether a dispatch is allowed — that is the
 * gate's job, and it runs before this is ever called. Keeping the two apart is
 * what makes the policy auditable in one file.
 */
export async function runCapability(client, capability, args, { timeout = 700, requestTimeoutMs } = {}) {
  // Two different clocks, and conflating them wastes money. `timeout` is the
  // server-side render budget; the MCP SDK imposes its own 60s request timeout,
  // and when that fires the render keeps going and is still billed. So the
  // transport timeout is always given room beyond the render budget.
  return textOf(await client.callTool(
    { name: 'run_capability', arguments: { capability, timeout, ...args } },
    undefined,
    { timeout: requestTimeoutMs ?? (timeout * 1000 + 60000) },
  ))
}

/** Second belt beneath our own ceiling check — see the note in gate.mjs. */
export async function setSpendCap(client, capUsd) {
  return textOf(await client.callTool({
    name: 'spend_cap', arguments: { action: 'set', cap_usd: capUsd },
  }))
}

export async function costReport(client, scope = 'session') {
  return textOf(await client.callTool({ name: 'get_cost_report', arguments: { scope } }))
}
