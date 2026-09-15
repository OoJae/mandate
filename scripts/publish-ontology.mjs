/**
 * Anchor the Mandate ontology in the DKG's system `ontology` context graph, from
 * the grantor's node, so any DKG node can read the vocabulary without trusting
 * this repository's web host.
 *
 *   node scripts/publish-ontology.mjs            (dry run: parse and count)
 *   node scripts/publish-ontology.mjs --publish  (one Base Sepolia publish)
 *   add --env-path <path> to read settings from that file (default ~/.mandate/.env)
 *
 * Writes the UAL and transaction to docs/evidence/ontology-<version>.json.
 *
 * The ontology it reads and the evidence it writes are this repository's,
 * found from the script's own location: run from any other folder (a delivery
 * someone sent, holding its own vocab/mandate.ttl), it still publishes Mandate's.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Parser } from 'n3'
import { GRANTOR, loadScriptEnv } from '../bin/config.mjs'
import { literalTerm, agentAddress } from '../src/rdf-term.mjs'
import { txLink } from '../bin/ui.mjs'

// The CLI's env file; a .env in the working directory is never read.
loadScriptEnv()

const REPO = join(import.meta.dirname, '..')
const OWL_VERSION = 'http://www.w3.org/2002/07/owl#versionInfo'
const ttl = readFileSync(join(REPO, 'vocab', 'mandate.ttl'), 'utf8')
const parsed = new Parser().parse(ttl)
const version = parsed.find(q => q.predicate.value === OWL_VERSION)?.object.value
if (!version) throw new Error('vocab/mandate.ttl has no owl:versionInfo')

const term = t => {
  if (t.termType === 'NamedNode') return t.value
  if (t.termType !== 'Literal') throw new Error(`unsupported term ${t.termType}`)
  // literalTerm refuses what DKG v10.0.16 cannot publish.
  if (t.language) return `${literalTerm(t.value, { field: 'ontology literal' })}@${t.language}`
  const dt = t.datatype?.value
  return dt && dt !== 'http://www.w3.org/2001/XMLSchema#string' ? literalTerm(t.value, { datatype: dt }) : literalTerm(t.value)
}
const quads = parsed.map(q => ({ subject: term(q.subject), predicate: term(q.predicate), object: term(q.object) }))
console.log(`vocab ${version}: ${quads.length} triples`)
if (!process.argv.includes('--publish')) process.exit(0)

const grantor = GRANTOR()
const author = agentAddress((await grantor.identity()).agentDid)
const name = `mandate-ontology-${version.replace(/\./g, '-')}-${Date.now().toString(36)}`
const t0 = Date.now()
const r = await grantor.sealShareAnchor({ name, contextGraphId: 'ontology', quads, expectAuthor: author })
const record = { version, triples: quads.length, name, ual: r.ual, txHash: r.txHash, explorer: txLink(r.ual, r.txHash), merkleRoot: r.merkleRoot, publishedAt: new Date().toISOString(), ms: Date.now() - t0 }
writeFileSync(join(REPO, 'docs', 'evidence', `ontology-${version}.json`), `${JSON.stringify(record, null, 2)}\n`)
console.log(JSON.stringify(record, null, 2))
