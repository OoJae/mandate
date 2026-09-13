/**
 * Capture live /api/query responses from the local DKG nodes as test fixtures.
 *
 * The provenance resolver is tested against what real nodes return, including
 * the difference between a node that published a Knowledge Asset (its _meta
 * carries prov:wasAttributedTo) and a node that synced it (it does not).
 *
 *   node scripts/capture-fixtures.mjs [--out test/fixtures/live]
 *
 * Read-only: it only runs SELECT queries. Responses hold UALs, tx hashes and
 * public agent addresses — no tokens.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'test/fixtures/live'
const NS = 'https://oojae.github.io/mandate/ns/v1#'
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const GRAPHS = {
  grants: '0xeD1eeB64CaC09874257F05Fd6B51A55695ad0B69/mandate-grants',
  derivations: '0x8EaA4857B22dddbfb5ebC476087FEc39336e0CB5/mandate-derivations',
}
const NODES = {
  grantor: { home: `${process.env.HOME}/.dkg-mandate-grantor`, port: 9201 },
  producer: { home: `${process.env.HOME}/.dkg-mandate-producer`, port: 9202 },
}

const token = home => readFileSync(join(home, 'auth.token'), 'utf8')
  .split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#'))

async function query(node, contextGraphId, sparql) {
  const r = await fetch(`http://127.0.0.1:${node.port}/api/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token(node.home)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sparql, contextGraphId }),
  })
  const body = await r.json()
  if (!r.ok) throw new Error(`${r.status} ${JSON.stringify(body).slice(0, 300)}`)
  return body
}

const cgIri = id => `did:dkg:context-graph:${id}`
const contentQuery = id => `SELECT ?g ?s ?p ?o WHERE {
  GRAPH ?g { ?s ?p ?o }
  FILTER(STRSTARTS(STR(?g), "${cgIri(id)}/_verifiable_memory/"))
  FILTER(STRSTARTS(STR(?p), "${NS}") || (?p = <${RDF_TYPE}> && STRSTARTS(STR(?o), "${NS}")))
} ORDER BY ?g ?s ?p ?o`
const metaQuery = id => `SELECT ?s ?p ?o WHERE {
  GRAPH <${cgIri(id)}/_meta> { ?s ?p ?o }
  FILTER(STRSTARTS(STR(?s), "did:dkg:base:"))
} ORDER BY ?s ?p ?o`

mkdirSync(out, { recursive: true })
for (const [nodeName, node] of Object.entries(NODES)) {
  for (const [role, id] of Object.entries(GRAPHS)) {
    for (const [kind, q] of [['content', contentQuery(id)], ['meta', metaQuery(id)]]) {
      // DKG v10.0.16's /api/query intermittently omits whole named graphs (its
      // graph-set index drops a graph after a failed existence probe). Read until
      // the largest row count has been seen twice, and keep every count observed,
      // so the flakiness itself is recorded as test data.
      const observed = []
      let stable = null
      for (let i = 0; i < 12 && !stable; i++) {
        const res = await query(node, id, q)
        observed.push(res.result.bindings.length)
        const max = Math.max(...observed)
        if (max > 0 && observed.filter(n => n === max).length >= 2) stable = res.result.bindings.length === max ? res : stable
        if (!stable && max > 0 && res.result.bindings.length === max && observed.filter(n => n === max).length >= 2) stable = res
      }
      const file = join(out, `${nodeName}-${role}-${kind}.json`)
      writeFileSync(file, JSON.stringify({ node: nodeName, contextGraphId: id, sparql: q, observedCounts: observed, response: stable?.result ?? { type: 'bindings', bindings: [] } }, null, 2) + '\n')
      console.log(`${file}  ${stable ? stable.result.bindings.length : 'UNSTABLE'} rows  observed=[${observed.join(' ')}]`)
    }
  }
}
