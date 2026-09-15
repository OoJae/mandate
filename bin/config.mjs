/**
 * CLI configuration.
 *
 * Deployment details — which nodes, which context graphs, which producers to
 * trust — belong to whoever runs Mandate, not to the library. Values come from
 * the environment, with one env file filling in anything unset (see
 * `.env.example`). That file is, in order: the one named by `--env-path`, the
 * one named by MANDATE_ENV_FILE, else `$MANDATE_HOME/.env` (default
 * `~/.mandate/.env`).
 *
 * A `.env` in the working directory is never read. It decides which producers
 * a verifier trusts, which graphs it reads, whether freshness is checked and
 * where local state lives, and a folder someone else sent (a delivery with a
 * video and a `.env`) must not be able to change that by being the place
 * `mandate verify` is run from.
 *
 * Only Mandate's own keys are read from the file. An env file is often shared
 * or copied between projects, and a stray NODE_OPTIONS or PATH in one should
 * not change how this process, or anything it starts, runs.
 *
 * The flag is `--env-path`, not `--env-file`: Node.js (seen on v26) scans the
 * whole command line for `--env-file`, even after the script name, and applies
 * a NODE_OPTIONS from that file before any Mandate code runs.
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { join, resolve } from 'node:path'
import { DkgNode } from '../src/dkg.mjs'
import { contextGraphAddress } from '../src/resolve.mjs'
import { assertContextGraphId } from '../src/queries.mjs'
import { fileStateStore, ConfigError, absoluteSettingPath, mandateHome, homeDirectory } from '../src/state-store.mjs'
import { normAddress } from '../src/rdf-term.mjs'

export const ENV_KEY = /^(MANDATE_[A-Z0-9_]+|LIVEPEER_AGENT_KEY)$/

/** A configuration problem the operator fixes in the environment or .env; the CLI exits 1 for it. */
export { ConfigError, mandateHome }

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

/**
 * Where the env file is looked for: `flag` (--env-path), then MANDATE_ENV_FILE,
 * then `$MANDATE_HOME/.env`, with MANDATE_HOME (default ~/.mandate) taken from
 * the real environment. `explicit` is true for the first two, which must exist.
 *
 * MANDATE_ENV_FILE and MANDATE_HOME go through absoluteSettingPath: a leading
 * `~` is the home directory, empty is unset, and a relative value is a
 * ConfigError rather than a path under the working directory. A relative
 * --env-path is the operator's own command line, so it is resolved as typed
 * (after the same `~` expansion, for the `--env-path=~/x` form a shell leaves).
 */
export function envFileLocation({ flag, env = process.env } = {}) {
  if (typeof flag === 'string' && flag) return { path: resolve(flag.replace(/^~(?=$|\/)/, () => homeDirectory())), source: '--env-path', explicit: true }
  const named = absoluteSettingPath(env.MANDATE_ENV_FILE, 'MANDATE_ENV_FILE')
  if (named) return { path: named, source: 'MANDATE_ENV_FILE', explicit: true }
  return { path: join(mandateHome(env), '.env'), source: 'MANDATE_HOME', explicit: false }
}

/**
 * What loadMandateEnv did: `path` is the file loaded (null when none was),
 * `searched` where it looked, `home` the resolved MANDATE_HOME (under which
 * state and pending renders live) after the file loaded, and `warnings` anything
 * the operator should see.
 */
export const envLoad = { path: null, source: null, searched: null, home: null, loaded: [], ignored: [], warnings: [] }

/**
 * Load the env file (see envFileLocation) into `env`. An explicitly named file
 * that cannot be read is a ConfigError; a missing default file is not. A file
 * others can write to is loaded with a warning, since whoever can change it can
 * change which producers and graphs this machine trusts.
 */
export function loadMandateEnv({ flag, env = process.env } = {}) {
  Object.assign(envLoad, { path: null, source: null, searched: null, home: null, loaded: [], ignored: [], warnings: [] })
  const where = envFileLocation({ flag, env })
  Object.assign(envLoad, { source: where.source, searched: where.path })
  let st
  try {
    st = statSync(where.path)
  } catch (e) {
    if (e.code === 'ENOENT' && !where.explicit) return Object.assign(envLoad, { home: mandateHome(env) })
    throw new ConfigError(`the env file ${where.path} (from ${where.source}) cannot be read: ${e.code ?? e.message}`)
  }
  if (!st.isFile()) throw new ConfigError(`the env file ${where.path} (from ${where.source}) is not a file`)
  if (st.mode & 0o022) {
    envLoad.warnings.push(`the env file ${where.path} is ${st.mode & 0o002 ? 'world' : 'group'}-writable: whoever can change it can change which producers and graphs this machine trusts. Run: chmod 600 ${where.path}`)
  }
  let r
  try {
    r = loadEnvFile(where.path, env)
  } catch (e) {
    throw new ConfigError(`the env file ${where.path} (from ${where.source}) cannot be read: ${e.code ?? e.message}`)
  }
  Object.assign(envLoad, { path: where.path, loaded: r.loaded, ignored: r.ignored })
  // The file may itself set MANDATE_HOME (as ~/.mandate, say): check it now, so
  // a relative value stops every command here, not only the ones that touch state.
  try {
    envLoad.home = mandateHome(env)
  } catch (e) {
    if (e instanceof ConfigError && r.loaded.includes('MANDATE_HOME')) throw new ConfigError(`${e.message} (set in the env file ${where.path})`)
    throw e
  }
  return envLoad
}

/**
 * For a script run from the repository (publish-ontology, the spikes): load the
 * same env file as the CLI from `--env-path <path>` or `--env-path=<path>` in
 * `argv` (the two forms the CLI accepts; given more than once is refused), refusing Node's
 * own --env-file. Prints warnings and the file used; exits 1 on a bad flag or
 * an unreadable named file. Returns envLoad.
 */
export function loadScriptEnv(argv = process.argv.slice(2), { log = console.log, error = console.error, exit = process.exit } = {}) {
  if (argv.some(a => /^--env-file(?:-if-exists)?(?:=|$)/.test(a))) {
    error('--env-file is read by Node.js itself, which applies a NODE_OPTIONS from that file; name the env file with --env-path <path> instead')
    return exit(1)
  }
  // The CLI takes `--env-path <path>` and `--env-path=<path>`; so do scripts.
  const given = argv.filter(a => a === '--env-path' || a.startsWith('--env-path='))
  if (given.length > 1) {
    error('--env-path given more than once')
    return exit(1)
  }
  let flag
  if (given.length) {
    const at = argv.indexOf(given[0])
    const spaced = given[0] === '--env-path'
    flag = spaced ? argv[at + 1] : given[0].slice('--env-path='.length)
    // As in bin/args.mjs: only the spaced form can swallow the next flag.
    if (!flag || (spaced && flag.startsWith('--'))) {
      error('--env-path needs a path')
      return exit(1)
    }
  }
  let loaded
  try {
    loaded = loadMandateEnv({ flag })
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e
    error(e.message)
    return exit(1)
  }
  for (const w of loaded.warnings) error(`warning: ${w}`)
  log(loaded.path ? `env file: ${loaded.path}` : `env file: none (looked for ${loaded.searched})`)
  return loaded
}

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
