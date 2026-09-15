#!/usr/bin/env node
/**
 * Stand up and look after the local DKG nodes Mandate uses.
 *
 *   node scripts/nodes.mjs up [roles…]         init, start, subscribe, connect, sync
 *   node scripts/nodes.mjs init [roles…]       write each node's config.json (never overwrites)
 *   node scripts/nodes.mjs start [roles…]      start each daemon and wait for its API
 *   node scripts/nodes.mjs stop [roles…]
 *   node scripts/nodes.mjs subscribe [roles…]  subscribe to the grants and derivations graphs
 *   node scripts/nodes.mjs connect [roles…]    dial the other local nodes over loopback
 *   node scripts/nodes.mjs sync [roles…]       catch up with the chain
 *   node scripts/nodes.mjs doctor [roles…]     what is running, connected, subscribed and current
 *
 * Roles: grantor (9201), producer (9202), verifier (9203). The verifier is a
 * read-only node: it never publishes, so it needs no funded wallet. With no
 * roles given, commands act on grantor and producer, plus the verifier when
 * MANDATE_VERIFIER_PORT is set. Homes, ports and names come from the same
 * MANDATE_* variables as the CLI.
 *
 * `init` and `start` work before any context graph exists, because the graphs
 * can only be created on a running node. Until MANDATE_GRANTS_CG and
 * MANDATE_DERIVATIONS_CG hold real ids, `up` stops after starting the nodes and
 * says what to do next; `subscribe`, `connect` and `sync` need the ids and
 * refuse without them. Either variable may list several graphs, comma-separated.
 *
 * Settings come from the environment and the same env file as the CLI:
 * `--env-path <path>`, else MANDATE_ENV_FILE, else $MANDATE_HOME/.env (default
 * ~/.mandate/.env). A .env in the working directory is never read.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DkgNode, DkgHttpError } from '../src/dkg.mjs'
import { grantsCgs, derivationsCgs, setupCgs, trustedProducers, loadMandateEnv } from '../bin/config.mjs'
import { anchorsFromMeta } from '../src/provenance.mjs'
import { metaQuery } from '../src/queries.mjs'
import { contextGraphAddress } from '../src/resolve.mjs'
import { homeDirectory } from '../src/state-store.mjs'

const expandHome = p => p.replace(/^~(?=$|\/)/, () => homeDirectory())
const DEFAULTS = {
  grantor: { home: '~/.dkg-mandate-grantor', port: 9201, name: 'mandate-grantor' },
  producer: { home: '~/.dkg-mandate-producer', port: 9202, name: 'mandate-producer' },
  verifier: { home: '~/.dkg-mandate-verifier', port: 9203, name: 'mandate-verifier' },
}
const ROLES = Object.keys(DEFAULTS)

function roleConfig(role) {
  const d = DEFAULTS[role]
  const key = `MANDATE_${role.toUpperCase()}`
  return {
    role,
    home: expandHome(process.env[`${key}_HOME`] ?? d.home),
    port: Number(process.env[`${key}_PORT`] ?? d.port),
    name: process.env[`${key}_NAME`] ?? d.name,
  }
}
const nodeFor = rc => new DkgNode({ home: rc.home, port: rc.port, name: rc.name })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const say = (role, ...parts) => console.log(`${role.padEnd(9)} ${parts.join(' ')}`)

function dkgCli() {
  const require = createRequire(import.meta.url)
  try {
    return join(dirname(require.resolve('@origintrail-official/dkg/package.json')), 'dist', 'cli.js')
  } catch {
    throw new Error('the DKG node needs its package: npm install @origintrail-official/dkg')
  }
}

/** Run the dkg CLI for one node, with only the environment it needs. */
function runDkg(rc, args) {
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, DKG_HOME: rc.home }
    const child = spawn(process.execPath, [dkgCli(), ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { out += d })
    child.on('error', reject)
    child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`dkg ${args[0]} exited ${code}: ${out.trim().split('\n').slice(-3).join(' | ')}`))))
  })
}

async function init(rc) {
  const file = join(rc.home, 'config.json')
  if (existsSync(file)) return say(rc.role, `config exists at ${file}; left unchanged`)
  mkdirSync(rc.home, { recursive: true, mode: 0o700 })
  chmodSync(rc.home, 0o700)
  const config = {
    name: rc.name,
    apiPort: rc.port,
    listenPort: 0,
    nodeRole: 'edge',
    networkConfig: 'testnet',
    // Left empty until the graphs exist; `subscribe` adds them to the running node.
    contextGraphs: setupCgs() ?? [],
    autoUpdate: { enabled: false },
    auth: { enabled: true },
  }
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  say(rc.role, `wrote ${file} (testnet, edge, API :${rc.port}); wallets and token are generated on first start`)
  if (!config.contextGraphs.length) say(rc.role, 'no context graph ids yet; subscribe once MANDATE_GRANTS_CG and MANDATE_DERIVATIONS_CG are set')
}

async function start(rc) {
  const n = nodeFor(rc)
  try {
    await n.status()
    return say(rc.role, `already running on :${rc.port}`)
  } catch { /* not running */ }
  if (!existsSync(join(rc.home, 'config.json'))) throw new Error(`${rc.role}: no config in ${rc.home}; run init first`)
  await runDkg(rc, ['start'])
  // A first boot takes a couple of minutes before the API binds.
  for (let i = 0; i < 240; i++) {
    try {
      await nodeFor(rc).identity()
      return say(rc.role, `started on :${rc.port}`)
    } catch { await sleep(1000) }
  }
  throw new Error(`${rc.role}: daemon started but its API did not answer on :${rc.port}; see ${join(rc.home, 'daemon.log')}`)
}

async function stop(rc) {
  await runDkg(rc, ['stop']).then(() => say(rc.role, 'stopped'), e => say(rc.role, `stop: ${e.message}`))
}

async function subscribe(rc) {
  const n = nodeFor(rc)
  const current = await n.subscriptions().catch(() => null)
  for (const cg of [...grantsCgs(), ...derivationsCgs()]) {
    if (current?.subscriptions?.some(x => x.contextGraphId === cg && x.subscribed)) { say(rc.role, `already subscribed to ${cg}`); continue }
    // A new node can report its read authority as unavailable until its chain
    // reads succeed; public RPC endpoints time out often enough to matter.
    for (let attempt = 0; ; attempt++) {
      try {
        await n.subscribe(cg)
        say(rc.role, `subscribed to ${cg}`)
        break
      } catch (e) {
        if (!(e instanceof DkgHttpError && e.status === 503) || attempt >= 8) throw e
        say(rc.role, `subscribe ${cg}: ${e.status}, retrying`)
        await sleep(15_000)
      }
    }
  }
}

function loopbackAddr(status) {
  const addrs = status?.multiaddrs ?? []
  const peerId = status?.peerId
  const local = addrs.find(a => a.startsWith('/ip4/127.0.0.1/tcp/')) ?? addrs.find(a => a.includes('/tcp/') && !a.includes('/p2p-circuit'))
  if (!local) return null
  return local.includes('/p2p/') ? local : `${local}/p2p/${peerId}`
}

async function connect(rcs) {
  const up = []
  for (const rc of rcs) {
    try { up.push({ rc, status: await nodeFor(rc).status() }) } catch { say(rc.role, 'not running; skipped') }
  }
  for (const a of up) {
    for (const b of up) {
      if (a === b) continue
      const addr = loopbackAddr(b.status)
      if (!addr) { say(a.rc.role, `no dialable address for ${b.rc.role}`); continue }
      try {
        await nodeFor(a.rc).connect(addr)
        say(a.rc.role, `connected to ${b.rc.role}`)
      } catch (e) {
        say(a.rc.role, `could not connect to ${b.rc.role}: ${e.message}`)
      }
    }
  }
}

/** Addresses whose assets this node should hold, with the highest asset number it already has. */
async function knownPublishers(n, cg) {
  const addresses = new Set([...grantsCgs(), ...derivationsCgs()].map(contextGraphAddress).concat(trustedProducers()))
  const out = []
  for (const address of addresses) {
    let rows = []
    for (let i = 0; i < 3 && rows.length === 0; i++) rows = await n.queryJson(metaQuery(cg, { limit: 5000, publisher: address }), { contextGraphId: cg }).catch(() => [])
    const { anchors } = anchorsFromMeta(rows, cg)
    const numbers = [...anchors.values()].map(a => Number(a.number))
    out.push({ address, max: numbers.length ? Math.max(...numbers) : 0 })
  }
  return out
}

/**
 * Whether a reconcile reply shows the node current. Both numbers must be
 * whole and non-negative: in JavaScript `5 >= null` and `null >= null` are
 * true, so a reply missing either would otherwise read as current.
 */
function freshness(r) {
  const ok = v => Number.isInteger(v) && v >= 0
  if (!ok(r?.watermarkAfter) || !ok(r?.headOrdinal)) {
    return { unknown: true, current: false, detail: `the node reported watermark ${JSON.stringify(r?.watermarkAfter) ?? 'none'} and head ${JSON.stringify(r?.headOrdinal) ?? 'none'}` }
  }
  return { unknown: false, current: r.watermarkAfter >= r.headOrdinal }
}

async function sync(rc, rcs, { timeoutMs = 10 * 60_000 } = {}) {
  const n = nodeFor(rc)
  const info = await n.info()
  const chain = info?.chain?.chainId
  const peers = []
  for (const other of rcs) {
    if (other === rc) continue
    try { peers.push((await nodeFor(other).identity()).peerId) } catch { /* not running */ }
  }
  for (const cg of [...grantsCgs(), ...derivationsCgs()]) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      let r
      try {
        r = await n.reconcile(cg)
      } catch (e) {
        if (!(e instanceof DkgHttpError) || e.status === 0 || Date.now() > deadline) throw e
        say(rc.role, `${cg}: reconcile not ready (${e.status}: ${String(e.body?.error ?? e.message).slice(0, 100)}); retrying`)
        await sleep(15_000)
        continue
      }
      const f = freshness(r)
      if (f.unknown) { say(rc.role, `${cg}: freshness unknown (${f.detail}); not treated as current`); process.exitCode = 9; break }
      if (f.current) { say(rc.role, `${cg}: current (${r.watermarkAfter}/${r.headOrdinal})`); break }
      if (Date.now() > deadline) { say(rc.role, `${cg}: still behind after ${Math.round(timeoutMs / 1000)}s (${r.watermarkAfter}/${r.headOrdinal})`); process.exitCode = 9; break }
      const missing = r.headOrdinal - r.watermarkAfter
      say(rc.role, `${cg}: behind by ${missing}; fetching from peers`)
      // Asset numbers are per publisher; probe just past what this node holds.
      const uals = []
      if (chain) {
        for (const p of await knownPublishers(n, cg)) {
          for (let k = 1; k <= missing + 5; k++) uals.push(`did:dkg:${chain}/${p.address}/${p.max + k}`)
        }
      }
      // One probe per request: the node rejects a whole request if any UAL in
      // it belongs to another graph, and most probes past the known range do.
      let fetched = 0
      for (const ual of uals) {
        const f = await n.fetchAssets(cg, [ual], peers.length ? { peerIds: peers } : {}).catch(() => null)
        fetched += f?.fetchedAssets ?? 0
      }
      say(rc.role, `fetched ${fetched} asset(s); the node also reconciles on its own`)
      await sleep(5000)
    }
  }
}

async function doctor(rc) {
  const n = nodeFor(rc)
  try {
    const [id, info] = await Promise.all([n.identity(), n.info()])
    say(rc.role, `${rc.name} :${rc.port}  ${id.agentDid}  peers=${info.peers}  ${info.chain?.chainId ?? ''}  v${info.version}`)
  } catch (e) {
    say(rc.role, `unreachable: ${e.message}`)
    process.exitCode = 9
    return
  }
  // A token that may not list subscriptions (403) leaves them unknown, but the
  // freshness check still runs: a node that is behind is exit 9 either way.
  let subs = null
  try {
    subs = await n.subscriptions()
  } catch (e) {
    if (!(e instanceof DkgHttpError && e.status === 403)) throw e
    say('', '  subscriptions need a node-admin token; subscription unknown, freshness still checked')
  }
  for (const cg of [...grantsCgs(), ...derivationsCgs()]) {
    const s = subs?.subscriptions?.find(x => x.contextGraphId === cg)
    const r = await n.reconcile(cg).catch(e => ({ error: e.message }))
    const f = r.error ? { unknown: true, detail: r.error } : freshness(r)
    const fresh = f.unknown ? `freshness unknown (${f.detail})` : f.current ? `current ${r.watermarkAfter}/${r.headOrdinal}` : `BEHIND ${r.watermarkAfter}/${r.headOrdinal} — run sync`
    say('', `  ${cg}  ${subs === null ? 'subscription unknown' : s?.subscribed ? 'subscribed' : 'NOT SUBSCRIBED'}  ${fresh}`)
    if ((subs !== null && !s?.subscribed) || !f.current) process.exitCode = 9
  }
}

const [command, ...rest] = process.argv.slice(2)
if (process.argv.slice(2).some(a => /^--env-file(?:-if-exists)?(?:=|$)/.test(a))) {
  console.error('--env-file is read by Node.js itself, which applies a NODE_OPTIONS from that file; name the env file with --env-path <path> instead')
  process.exit(1)
}
const envAt = rest.indexOf('--env-path')
const envFlag = envAt === -1 ? undefined : rest[envAt + 1]
const args = envAt === -1 ? rest : [...rest.slice(0, envAt), ...rest.slice(envAt + 2)]
if (envAt !== -1 && (!envFlag || envFlag.startsWith('--'))) {
  console.error('--env-path needs a path')
  process.exit(1)
}
try {
  const loaded = loadMandateEnv({ flag: envFlag })
  for (const w of loaded.warnings) console.error(`warning: ${w}`)
} catch (e) {
  console.error(e.message)
  process.exit(1)
}
const explicit = args.filter(a => ROLES.includes(a))
const unknown = args.filter(a => !ROLES.includes(a))
const COMMANDS = ['up', 'init', 'start', 'stop', 'subscribe', 'connect', 'sync', 'doctor']
if (!COMMANDS.includes(command) || unknown.length) {
  console.error(`usage: node scripts/nodes.mjs <${COMMANDS.join('|')}> [${ROLES.join('|')}…] [--env-path <path>]${unknown.length ? `\nunknown: ${unknown.join(' ')}` : ''}`)
  process.exit(1)
}
const roles = explicit.length ? explicit : ['grantor', 'producer', ...(process.env.MANDATE_VERIFIER_PORT ? ['verifier'] : [])]
const rcs = roles.map(roleConfig)
const everyone = [...new Set([...roles, 'grantor', 'producer', ...(process.env.MANDATE_VERIFIER_PORT ? ['verifier'] : [])])].map(roleConfig)

try {
  // Graph ids are needed from here on; checked before touching any node.
  const needsGraphs = ['subscribe', 'connect', 'sync', 'doctor'].includes(command)
  if (needsGraphs) { grantsCgs(); derivationsCgs() }
  if (command === 'up' || command === 'init') for (const rc of rcs) await init(rc)
  if (command === 'up' || command === 'start') for (const rc of rcs) await start(rc)
  if (command === 'stop') for (const rc of rcs) await stop(rc)
  if (command === 'up' && !setupCgs()) {
    console.log([
      '',
      'The nodes are running, but MANDATE_GRANTS_CG and MANDATE_DERIVATIONS_CG do not hold graph ids yet.',
      'Next: create and register the grants graph on the grantor node and the derivations graph on the',
      'producer node, set both ids in your env file (~/.mandate/.env, or the file given with --env-path), then run:',
      '  node scripts/nodes.mjs subscribe && node scripts/nodes.mjs connect && node scripts/nodes.mjs sync',
    ].join('\n'))
    process.exit(0)
  }
  if (command === 'up' || command === 'subscribe') for (const rc of rcs) await subscribe(rc)
  if (command === 'up' || command === 'connect') await connect(everyone)
  if (command === 'up' || command === 'sync') for (const rc of rcs) await sync(rc, everyone)
  if (command === 'doctor') for (const rc of rcs) await doctor(rc)
} catch (e) {
  console.error(e.message)
  process.exitCode = 1
}
