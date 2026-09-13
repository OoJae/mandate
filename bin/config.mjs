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

function requiredCg(key, help) {
  const cg = process.env[key]
  if (!cg) throw new Error(`${key} is not set.\n  ${help}\n  See .env.example.`)
  try {
    return assertContextGraphId(cg)
  } catch {
    throw new Error(`${key} must look like 0x<40 hex>/<name>, got ${JSON.stringify(cg)}`)
  }
}

/** The public context graph grants and revocations are published to. */
export const grantsCg = () => requiredCg('MANDATE_GRANTS_CG',
  'Create a public context graph on the grantor node, register it on-chain, and set MANDATE_GRANTS_CG=<agent-address>/<name>.')

/**
 * The producer's own graph for derivation edges. Writing derivations into the
 * grantor's graph would need write authority the producer should not have.
 */
export const derivationsCg = () => requiredCg('MANDATE_DERIVATIONS_CG',
  'Create and register a context graph on the producer node for derivation edges, and set MANDATE_DERIVATIONS_CG=<producer-address>/<name>.')

/**
 * Producers whose derivation edges count: for spend under a grant, and for a
 * verifier's verdict. Anyone can publish an edge into an open graph, so the
 * default is only the derivations graph's own address.
 */
export function trustedProducers() {
  const raw = process.env.MANDATE_TRUSTED_PRODUCERS
  if (!raw) return [contextGraphAddress(derivationsCg())]
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(a => {
    const n = normAddress(a)
    if (!n) throw new Error(`MANDATE_TRUSTED_PRODUCERS: ${JSON.stringify(a)} is not an address`)
    return n
  })
}

/** What readKnowledge needs, with local memory of anchors and revocations under ~/.mandate/state. */
export function readConfig() {
  return {
    grantsCg: grantsCg(),
    derivationsCgs: [derivationsCg()],
    trustedProducers: trustedProducers(),
    stateStore: fileStateStore(),
    // Before deciding, compare the node's copy of each graph with the chain.
    checkFreshness: process.env.MANDATE_CHECK_FRESHNESS !== '0',
  }
}
