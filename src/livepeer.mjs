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
  const client = new Client({ name: 'mandate', version: '0.2.0' }, { capabilities: {} })
  await client.connect(new StreamableHTTPClientTransport(
    new URL(`${BASE}/${surface}`), { requestInit: { headers: headers(surface) } },
  ))
  return client
}

export const textOf = r => (r.content || []).map(c => c.text || '').join('\n')

/** A tool call the platform answered with isError. */
export class LivepeerToolError extends Error {
  constructor(message, { tool, structured = null, text = '' } = {}) {
    super(message)
    this.tool = tool
    this.structured = structured
    this.text = text
  }
}

/**
 * Call a tool and return its structured and text content; throw when the
 * platform marks the result as an error. Earlier versions read only the text
 * and treated an error message as a result.
 */
export async function callStrict(client, name, args = {}, { timeoutMs } = {}) {
  const r = await client.callTool({ name, arguments: args }, undefined, timeoutMs ? { timeout: timeoutMs } : undefined)
  const text = textOf(r)
  const structured = r.structuredContent ?? null
  if (r.isError) {
    const detail = structured?.error ?? text
    throw new LivepeerToolError(`${name} failed: ${String(detail).slice(0, 500)}`, { tool: name, structured, text })
  }
  return { structured, text }
}

/** The capability's detail card: price, latency SLA, availability. */
export async function describeCapability(client, name) {
  return (await callStrict(client, 'describe_capability', { name })).structured
}

/** The live rate-card row for one capability, or null if the platform has none. */
export async function getPricing(client, name) {
  const { structured } = await callStrict(client, 'get_pricing', { name })
  return structured?.capabilities?.find(c => c.name === name) ?? null
}

/**
 * Read the account's rolling 24h spend cap. Mandate never sets it: the cap is
 * the operator's, and a grant's ceiling is enforced by the gate instead.
 */
export async function readSpendCap(client) {
  return (await callStrict(client, 'spend_cap', { action: 'read' })).structured
}

/**
 * Mint a phone upload link. This is the primitive that turns consent from an
 * out-of-band email chain into a step inside the conversation, and it works
 * without a key.
 */
export async function requestUpload(client, kind = 'video') {
  const { structured, text } = await callStrict(client, 'request_upload', { kind })
  return {
    pageUrl: structured?.page_url ?? (text.match(/https:\/\/agent\.livepeer\.org\/u\/[a-f0-9]+/) || [])[0] ?? null,
    token: structured?.token ?? (text.match(/\b[a-f0-9]{24}\b/) || [])[0] ?? null,
    expiresAt: structured?.expires_at ?? null,
    text,
  }
}

const UPLOAD_DONE = new Set(['done', 'complete', 'completed', 'uploaded', 'received', 'ready', 'succeeded', 'success'])
const MEDIA_EXT = /\.(mp4|m4v|mov|webm|mkv|3gp|m4a|mp3|wav|ogg|oga|opus|aac|flac|caf)$/i

/** The capture page itself, or any other page on the agent site that is not hosted media. */
function isAgentPage(u) {
  return u.hostname === 'agent.livepeer.org' && !u.pathname.startsWith('/a/')
}

// The clip's hash becomes the evidence, so it is only fetched over TLS. Plain
// http is allowed for loopback alone, where there is no network to tamper with.
function parsedHttps(s) {
  try {
    const u = new URL(String(s))
    if (u.protocol === 'https:') return u
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ? u : null
  } catch { return null }
}

/**
 * Only "expired" said as a fact counts: "not expired yet" and "hasn't expired"
 * are still waiting.
 */
export function saysExpired(text) {
  const t = String(text ?? '')
  return /\bexpired\b/i.test(t) && !/(\bnot|\bnever|n't|\bhasnt|\bisnt)\s+(yet\s+|been\s+|already\s+)?expired\b/i.test(t)
}

/**
 * A clip URL named in the reply text, used only when the structured reply has
 * none. It must look like hosted media — an agent.livepeer.org/a/ path or a
 * media file extension — so a docs or capture-page link is never hashed as the
 * clip. Two different candidates are ambiguous and give none.
 */
export function uploadUrlFromText(text) {
  const found = new Set()
  for (const raw of String(text ?? '').match(/https:\/\/[^\s<>"'\]\[)(]+/g) ?? []) {
    const u = parsedHttps(raw.replace(/[.,;:!?]+$/, ''))
    if (!u || isAgentPage(u)) continue
    if (u.hostname === 'agent.livepeer.org' || MEDIA_EXT.test(u.pathname)) found.add(u.href)
  }
  return found.size === 1 ? [...found][0] : null
}

export async function getUpload(client, token, waitSeconds = 20) {
  const { structured, text } = await callStrict(client, 'get_upload', { token, wait_seconds: waitSeconds })
  const given = typeof structured?.status === 'string' ? structured.status.trim().toLowerCase() : null
  const status = given ?? (saysExpired(text) ? 'expired' : null)
  let url = null
  // A status that is not a finished upload wins over any link in the reply.
  if (status === null || UPLOAD_DONE.has(status)) {
    const s = parsedHttps(structured?.url)
    if (s && !isAgentPage(s)) url = s.href
    else if (structured?.url == null) url = uploadUrlFromText(text)
  }
  return { url, status: url ? (status ?? 'done') : (status && !UPLOAD_DONE.has(status) ? status : 'pending'), pending: !url, mime: structured?.mime ?? null, text, structured }
}

/**
 * Dispatch a capability and return its text. Throws on a platform error.
 *
 * Nothing in this module decides whether a dispatch is allowed — that is the
 * gate's job, and it runs before this is ever called.
 */
export async function runCapability(client, capability, args, { timeout = 280, requestTimeoutMs } = {}) {
  // Two different clocks: `timeout` is the server-side render budget; the MCP
  // SDK has its own request timeout, and when that fires the render keeps going
  // and is still billed. The transport always gets room beyond the budget.
  const { text } = await callStrict(client, 'run_capability', { capability, timeout, ...args },
    { timeoutMs: requestTimeoutMs ?? (timeout * 1000 + 10_000) })
  return text
}

export async function costReport(client, scope = 'session') {
  return (await callStrict(client, 'get_cost_report', { scope })).text
}
