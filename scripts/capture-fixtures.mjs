/**
 * Capture live /api/query responses from the local DKG nodes as test fixtures,
 * using the resolver's own query builders so fixtures are exactly what the
 * resolver reads.
 *
 * The provenance resolver is tested against what real nodes return, including
 * the difference between a node that published a Knowledge Asset (its _meta
 * carries prov:wasAttributedTo) and a node that synced it (it does not), and
 * the node's intermittent omission of whole named graphs.
 *
 *   node scripts/capture-fixtures.mjs [--out test/fixtures/live]
 *
 * Read-only: SELECT queries only. Responses hold UALs, tx hashes and public
 * agent addresses — no tokens.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DkgNode } from '../src/dkg.mjs'
import * as Q from '../src/queries.mjs'

const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'test/fixtures/live'
const GRAPHS = {
  grants: { id: '0xeD1eeB64CaC09874257F05Fd6B51A55695ad0B69/mandate-grants', publisher: '0xed1eeb64cac09874257f05fd6b51a55695ad0b69' },
  derivations: { id: '0x8EaA4857B22dddbfb5ebC476087FEc39336e0CB5/mandate-derivations', publisher: '0x8eaa4857b22dddbfb5ebc476087fec39336e0cb5' },
}
const NODES = {
  grantor: new DkgNode({ home: '~/.dkg-mandate-grantor', port: 9201, name: 'grantor' }),
  producer: new DkgNode({ home: '~/.dkg-mandate-producer', port: 9202, name: 'producer' }),
}

async function stableRead(node, sparql, contextGraphId, attempts = 12) {
  // Read until the largest row count has been seen twice; record every count.
  const observed = []
  let best = null
  for (let i = 0; i < attempts; i++) {
    const rows = await node.queryJson(sparql, { contextGraphId, max: 5000 })
    observed.push(rows.length)
    const max = Math.max(...observed)
    if (rows.length === max) best = rows
    if (max > 0 && observed.filter(n => n === max).length >= 2) break
  }
  return { observed, rows: best ?? [] }
}

mkdirSync(out, { recursive: true })
for (const [nodeName, node] of Object.entries(NODES)) {
  for (const [role, { id, publisher }] of Object.entries(GRAPHS)) {
    const prefix = Q.vmPublisherPrefix(id, publisher)
    const reads = {
      meta: Q.metaQuery(id, { limit: 4999 }),
      content: Q.prefixContentQuery(prefix, { limit: 4999 }),
      count: Q.graphCountQuery(prefix),
    }
    for (const [kind, sparql] of Object.entries(reads)) {
      const { observed, rows } = await stableRead(node, sparql, id)
      const file = join(out, `${nodeName}-${role}-${kind}.json`)
      writeFileSync(file, JSON.stringify({ node: nodeName, contextGraphId: id, prefix, sparql, observedCounts: observed, bindings: rows }, null, 2) + '\n')
      console.log(`${file}  ${rows.length} rows  observed=[${observed.join(' ')}]`)
    }
  }
}
