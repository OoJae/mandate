/**
 * CLI configuration.
 *
 * Deployment details — which nodes, which context graph — belong to whoever runs
 * Mandate, not to the library. Values come from the environment, with a `.env`
 * in the working directory filling in anything unset (see `.env.example`).
 */
import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { join } from 'node:path'
import { DkgNode } from '../src/dkg.mjs'
import { defaultWorkDir } from '../src/derivation.mjs'
import { contextGraphAddress } from '../src/resolve.mjs'
import { fileStateStore } from '../src/state-store.mjs'
import { normAddress } from '../src/rdf-term.mjs'

const envFile = join(process.cwd(), '.env')
if (existsSync(envFile)) {
  for (const [k, v] of Object.entries(parseEnv(readFileSync(envFile, 'utf8')))) {
    if (process.env[k] === undefined) process.env[k] = v
  }
}

const env = (k, d) => process.env[k] ?? d

export const GRANTOR = () => new DkgNode({
  home: env('MANDATE_GRANTOR_HOME', '~/.dkg-mandate-grantor'),
  port: Number(env('MANDATE_GRANTOR_PORT', '9201')),
  name: env('MANDATE_GRANTOR_NAME', 'mandate-grantor'),
})

export const PRODUCER = () => new DkgNode({
  home: env('MANDATE_PRODUCER_HOME', '~/.dkg-mandate-producer'),
  port: Number(env('MANDATE_PRODUCER_PORT', '9202')),
  name: env('MANDATE_PRODUCER_NAME', 'mandate-producer'),
})

/** Read lazily, so `mandate` with no arguments still prints help. */
export function grantsCg() {
  const cg = process.env.MANDATE_GRANTS_CG
  if (!cg) {
    throw new Error('MANDATE_GRANTS_CG is not set.\n'
      + '  Create a public context graph on the grantor node, register it on-chain, and set\n'
      + '  MANDATE_GRANTS_CG=<agent-address>/<name> in the environment or in .env.\n'
      + '  See .env.example.')
  }
  return cg
}

/**
 * The producer's own graph for derivation edges. Writing derivations into the
 * grantor's graph would need write authority the producer should not have, and
 * a peer that has only synced a graph's anchored data cannot write to it anyway.
 */
export function derivationsCg() {
  const cg = process.env.MANDATE_DERIVATIONS_CG
  if (!cg) {
    throw new Error('MANDATE_DERIVATIONS_CG is not set.\n'
      + '  Create and register a context graph on the producer node for derivation edges, and set\n'
      + '  MANDATE_DERIVATIONS_CG=<producer-address>/<name>. See .env.example.')
  }
  return cg
}

export const workDir = () => env('MANDATE_WORK_DIR', defaultWorkDir())

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
  }
}
