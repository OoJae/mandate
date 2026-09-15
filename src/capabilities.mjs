/**
 * What Mandate knows about the capabilities it gates.
 *
 * Livepeer Agent publishes price and latency per capability but not an input
 * schema, so required inputs are recorded here only where a real render has
 * confirmed them. Anything else must be given explicit inputs, and is flagged
 * as unverified.
 */

/** Inputs confirmed by a real render (docs/SPIKES.md, S7). */
export const VERIFIED_INPUTS = Object.freeze({
  'sync-lipsync-v3': ['image_url', 'audio_url'],
  'talking-head': ['image_url', 'audio_url'],
})

/** An upper bound that stays under Node's 300s HTTP stream limit, with room for the transport. */
export const INLINE_BUDGET_S = 280
export const INLINE_REQUEST_MS = 290_000
/** Capabilities whose measured p95 is above this go through the async path and are polled. */
export const ASYNC_ABOVE_P95_MS = 200_000

/**
 * Check a render's inputs before any money is spent.
 * @returns {{ ok: boolean, missing: string[], verified: boolean }}
 */
export function checkInputs(capability, inputs = {}, { prompt } = {}) {
  const required = VERIFIED_INPUTS[capability]
  if (!required) {
    const given = Object.keys(inputs).length > 0 || Boolean(prompt)
    return { ok: given, missing: given ? [] : ['inputs'], verified: false }
  }
  const missing = required.filter(k => typeof inputs[k] !== 'string' || !inputs[k])
  return { ok: missing.length === 0, missing, verified: true }
}

/** Inline for fast or unmeasured capabilities; async and polled for slow ones. */
export function dispatchMode(describe) {
  const p95 = describe?.sla?.p95_ms
  return typeof p95 === 'number' && p95 > ASYNC_ABOVE_P95_MS ? 'async' : 'inline'
}

/**
 * A list-price estimate from a get_pricing row.
 * Returns null when the unit cannot be sized from what the caller provided.
 */
export function estimateFromPricing(row, { seconds, characters } = {}) {
  const price = row?.display_price_usd
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) return null
  switch (row.unit_kind) {
    case 'second': return Number.isFinite(seconds) && seconds > 0 ? price * seconds : null
    case 'call': case 'request': case 'image': case 'run': return price
    case 'character': return Number.isFinite(characters) ? price * characters / 1000 : null
    default: return null
  }
}

/** Static list prices, used only when live pricing cannot be read. */
export const STATIC_PRICES = Object.freeze({
  'talking-head': { display_price_usd: 0.168, unit_kind: 'second' },
  'sync-lipsync-v3': { display_price_usd: 0.13997, unit_kind: 'second' },
  lipsync: { display_price_usd: 0.14, unit_kind: 'second' },
  'heygen-twin': { display_price_usd: 0.105, unit_kind: 'second' },
  'face-swap-video': { display_price_usd: 0.024, unit_kind: 'second' },
  'face-swap-image': { display_price_usd: 0.009, unit_kind: 'call' },
})
