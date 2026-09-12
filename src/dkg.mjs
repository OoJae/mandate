/**
 * DKG v10 node client.
 *
 * Each party in Mandate is a separate daemon with its own DKG_HOME, its own
 * agent DID and its own auth token. That separation is the point: the grantor
 * authors permission on a node the producer does not control, which is the one
 * thing a renderer's own database can never establish about itself.
 */
import { readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const CLI = 'node_modules/@origintrail-official/dkg/dist/cli.js'

/** auth.token carries a `#` comment line; strip it. */
export function readToken(home) {
  return readFileSync(`${home}/auth.token`, 'utf8')
    .split('\n').map(l => l.trim())
    .find(l => l && !l.startsWith('#'))
}

export class DkgNode {
  constructor({ home, port, name }) {
    this.home = home.replace(/^~/, process.env.HOME)
    this.port = port
    this.name = name
    this.base = `http://127.0.0.1:${port}`
    this.token = readToken(this.home)
  }

  async api(path, init = {}) {
    const r = await fetch(`${this.base}${path}`, {
      ...init,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'content-type': 'application/json',
        ...(init.headers || {}),
      },
    })
    const text = await r.text()
    let body
    try { body = JSON.parse(text) } catch { body = text }
    if (!r.ok) {
      const err = new Error(`DKG ${path} -> ${r.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`)
      err.status = r.status
      err.body = body
      throw err
    }
    return body
  }

  identity() { return this.api('/api/agent/identity') }
  info()     { return this.api('/api/info') }

  /** Shell out to the CLI for lifecycle verbs, with this node's DKG_HOME. */
  async cli(args, { timeout = 240000 } = {}) {
    const { stdout, stderr } = await run('node', [CLI, ...args], {
      env: { ...process.env, DKG_HOME: this.home },
      timeout,
      maxBuffer: 32 * 1024 * 1024,
    })
    return (stdout || '') + (stderr || '')
  }

  /**
   * SPARQL against a context graph.
   *
   * `--include-shared-memory` is not optional in practice: a Knowledge Asset
   * that has been shared to SWM but not registered on-chain returns "No results"
   * without it, which reads as data loss and is not.
   */
  async query(contextGraph, sparql, { sharedMemory = true } = {}) {
    const args = ['query', contextGraph, '-q', sparql]
    if (sharedMemory) args.push('--include-shared-memory')
    return this.cli(args)
  }

  /** Seal a Knowledge Asset from a Turtle file and share it WM -> SWM. */
  async createKA(name, contextGraphId, turtlePath, { share = true, preSignedAuthorAttestation } = {}) {
    const args = ['ka', 'create', name, '-c', contextGraphId, '-f', turtlePath]
    if (share) args.push('--share')
    if (preSignedAuthorAttestation) {
      args.push('--pre-signed-author-attestation', preSignedAuthorAttestation)
    }
    const out = await this.cli(args)
    return {
      raw: out,
      status: (out.match(/Status:\s*(\S+)/) || [])[1] || null,
      assertionUri: (out.match(/Assertion URI:\s*(\S+)/) || [])[1] || null,
      merkleRoot: (out.match(/Merkle root:\s*(\S+)/) || [])[1] || null,
    }
  }
}

/** The two parties, as the demo runs them. */
export const GRANTOR = () => new DkgNode({
  home: '~/.dkg-mandate-grantor', port: 9201, name: 'mandate-grantor',
})
export const PRODUCER = () => new DkgNode({
  home: '~/.dkg-mandate-producer', port: 9202, name: 'mandate-producer',
})

/** Parse the CLI's table output back into rows of {var: value}. */
export function parseQueryTable(out) {
  const lines = out.split('\n')
  const sep = lines.findIndex(l => /^[─\s]+$/.test(l) && l.includes('─'))
  if (sep < 1) return []
  const header = lines[sep - 1]
  // Column starts are wherever a run of dashes begins on the separator line.
  const cols = []
  const re = /─+/g
  let m
  while ((m = re.exec(lines[sep]))) cols.push({ start: m.index, end: m.index + m[0].length })
  const names = cols.map(c => header.slice(c.start, c.end).trim())
  const rows = []
  for (const line of lines.slice(sep + 1)) {
    if (!line.trim() || /row\(s\)/.test(line)) break
    const row = {}
    cols.forEach((c, i) => { row[names[i]] = line.slice(c.start, c.end).trim() })
    rows.push(row)
  }
  return rows
}
