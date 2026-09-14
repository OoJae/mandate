/**
 * CLI configuration.
 *
 * Deployment details — which nodes, which context graphs, which producers to
 * trust — belong to whoever runs Mandate, not to the library. Values come from
 * the environment, with a `.env` in the working directory filling in anything
 * unset (see `.env.example`).
 *
 * Only Mandate's own keys are read from `.env`. A `.env` is often shared or
 * copied between projects, and a stray NODE_OPTIONS or PATH in one should not
 * change how this process, or anything it starts, runs.
 */
import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { join } from 'node:path'
import { DkgNode } from '../src/dkg.mjs'
import { contextGraphAddress } from '../src/resolve.mjs'
import { assertContextGraphId } from '../src/queries.mjs'
import { fileStateStore } from '../src/state-store.mjs'
import { normAddress } from '../src/rdf-term.mjs'

export const ENV_KEY = /^(MANDATE_[A-Z0-9_]+|LIVEPEER_AGENT_KEY)$/

/** A configuration problem the operator fixes in the environment or .env; the CLI exits 1 for it. */
export class ConfigError extends Error {}

/** Copy allow-listed, unset keys from a .env file into `env`. */
export function loadEnvFile(path, env = process.env) {
  const loaded = []
  const ignored = []
  if (!existsSync(path)) return { loaded, ignored }
  for (const [k, v] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
    if (!ENV_KEY.test(k)) { ignored.push(k); continue }
    if (env[k] === undefined) { env[k] = v; loaded.push(k) }
  }
  return { loaded, ignored }
}

export const envLoad = loadEnvFile(join(process.cwd(), '.env'))

const env = (k, d) => process.env[k] ?? d

function node(role, defaults) {
  return new DkgNode({
    home: env(`MANDATE_${role}_HOME`, defaults.home),
    port: Number(env(`MANDATE_${role}_PORT`, defaults.port)),
    name: env(`MANDATE_${role}_NAME`, defaults.name),
  })
}

export const GRANTOR = () => node('GRANTOR', { home: '~/.dkg-mandate-grantor', port: '9201', name: 'mandate-grantor' })
export const PRODUCER = () => node('PRODUCER', { home: '~/.dkg-mandate-producer', port: '9202', name: 'mandate-producer' })

/** The independent read-only node a verifier runs, if one is configured. */
export const VERIFIER = () => (process.env.MANDATE_VERIFIER_PORT
  ? node('VERIFIER', { home: '~/.dkg-mandate-verifier', port: '9203', name: 'mandate-verifier' })
  : null)

const HELP = {
  MANDATE_GRANTS_CG: 'Create a public context graph on the grantor node, register it on-chain, and set MANDATE_GRANTS_CG=<agent-address>/<name> (several may be listed, comma-separated).',
  MANDATE_DERIVATIONS_CG: 'Create and register a context graph on the producer node for derivation edges, and set MANDATE_DERIVATIONS_CG=<producer-address>/<name> (several may be listed, comma-separated).',
}

/**
 * A comma-separated list of context graph ids. Unset gives [] when `optional`;
 * a value that is set but malformed (such as the .env.example placeholder)
 * always throws, so a typo is never read as "no graph".
 */
function cgList(key, { optional = false } = {}) {
  const raw = process.env[key]
  if (!raw || !raw.trim()) {
    if (optional) return []
    throw new ConfigError(`${key} is not set.\n  ${HELP[key]}\n  See .env.example.`)
  }
  const ids = raw.split(',').map(s => s.trim()).filter(Boolean)
  const out = []
  for (const cg of ids) {
    try {
      assertContextGraphId(cg)
    } catch {
      throw new ConfigError(`${key} must be a comma-separated list of 0x<40 hex>/<name>, got ${JSON.stringify(cg)}`)
    }
    if (!out.includes(cg)) out.push(cg)
  }
  if (!out.length) throw new ConfigError(`${key} lists no context graph`)
  return out
}

/** Every grants graph a reader consults. */
export const grantsCgs = () => cgList('MANDATE_GRANTS_CG')
/** Every derivations graph a reader consults. */
export const derivationsCgs = () => cgList('MANDATE_DERIVATIONS_CG')

/**
 * The graph ids for node setup, which must work before any graph exists: unset
 * or still the .env.example placeholder gives null instead of throwing.
 */
export function setupCgs() {
  try {
    return [...grantsCgs(), ...derivationsCgs()]
  } catch {
    return null
  }
}

/** The one configured graph a party writes to: the one namespaced under its own address. */
function ownGraph(key, list, address, role) {
  const a = normAddress(address)
  if (!a) throw new ConfigError(`the ${role} node reported no usable address`)
  const mine = list.filter(cg => contextGraphAddress(cg) === a)
  if (mine.length === 1) return mine[0]
  if (!mine.length) {
    throw new ConfigError(`${key} lists no graph owned by the ${role} node ${a} (it lists ${list.join(', ')}).\n  A party can only publish to a context graph namespaced under its own address.`)
  }
  throw new ConfigError(`${key} lists more than one graph owned by the ${role} node ${a} (${mine.join(', ')}); list only the one it publishes to`)
}

/** The grants graph the grantor node publishes grants and revocations to. */
export const grantsCgFor = address => ownGraph('MANDATE_GRANTS_CG', grantsCgs(), address, 'grantor')
/** The derivations graph the producer node publishes derivation edges to. */
export const derivationsCgFor = address => ownGraph('MANDATE_DERIVATIONS_CG', derivationsCgs(), address, 'producer')

/** The single grants graph, kept for callers that configure exactly one. */
export function grantsCg() {
  const list = grantsCgs()
  if (list.length > 1) throw new ConfigError('MANDATE_GRANTS_CG lists several graphs; this needs exactly one')
  return list[0]
}

/**
 * The producer's own graph for derivation edges, when exactly one is set.
 * Writing derivations into the grantor's graph would need write authority the
 * producer should not have.
 */
export function derivationsCg() {
  const list = derivationsCgs()
  if (list.length > 1) throw new ConfigError('MANDATE_DERIVATIONS_CG lists several graphs; this needs exactly one')
  return list[0]
}

/**
 * Producers whose derivation edges count: for spend under a grant, and for a
 * verifier's verdict. Anyone can publish an edge into an open graph, so the
 * default is only the addresses the derivations graphs are namespaced under.
 */
export function trustedProducers() {
  const raw = process.env.MANDATE_TRUSTED_PRODUCERS
  if (!raw) return [...new Set(derivationsCgs().map(contextGraphAddress))]
  return [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean).map(a => {
    const n = normAddress(a)
    if (!n) throw new ConfigError(`MANDATE_TRUSTED_PRODUCERS: ${JSON.stringify(a)} is not an address`)
    return n
  }))]
}

/** A positive whole number from the environment, or undefined to take the library default. */
function positiveInt(key) {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return undefined
  if (!/^[1-9]\d{0,8}$/.test(raw.trim())) throw new ConfigError(`${key} must be a positive whole number, got ${JSON.stringify(raw)}`)
  return Number(raw.trim())
}

/**
 * What readKnowledge needs, with local memory of anchors and revocations under
 * ~/.mandate/state. MANDATE_READ_MAX is the rows per query page and
 * MANDATE_READ_MAX_ROWS the most rows read from one publisher's prefix; past
 * that a read fails closed (INCONCLUSIVE) rather than reason over part of it.
 */
export function readConfig() {
  const cfg = {
    grantsCgs: grantsCgs(),
    derivationsCgs: derivationsCgs(),
    trustedProducers: trustedProducers(),
    stateStore: fileStateStore(),
    // Before deciding, compare the node's copy of each graph with the chain.
    checkFreshness: process.env.MANDATE_CHECK_FRESHNESS !== '0',
  }
  const max = positiveInt('MANDATE_READ_MAX')
  const maxRows = positiveInt('MANDATE_READ_MAX_ROWS')
  if (max !== undefined) cfg.max = max
  if (maxRows !== undefined) cfg.maxRows = maxRows
  return cfg
}
