/**
 * S6b — can the producer forge the grantor's authorship?
 *
 * S6 showed a seal carrying Ana's address when Ana's own node made it. That is
 * only meaningful if the producer CANNOT make a seal that says the same thing.
 * This spike tries to, from the producer's node, using Ana's address.
 */
import { PRODUCER, GRANTOR, loadScriptEnv } from '../bin/config.mjs'
import { grantToTurtle } from '../src/rdf.mjs'
import { writeFileSync } from 'node:fs'

// The CLI's env file (--env-path, MANDATE_ENV_FILE or ~/.mandate/.env); a working-directory .env is never read.
loadScriptEnv()

const producer = PRODUCER()
const grantor = GRANTOR()
const anaId = await grantor.identity()
const prodId = await producer.identity()

// The producer needs a context graph it can write to.
const CG = `${prodId.agentAddress}/mandate-forge-test`
try {
  await producer.cli(['context-graph', 'create', 'mandate-forge-test',
    '--access-policy', '0', '--subscribe'])
} catch { /* already exists */ }

const name = 'grant-forged-by-producer'
writeFileSync(`spikes/out/${name}.ttl`, grantToTurtle({
  id: 'urn:mandate:grant:forged',
  grantor: anaId.agentDid,           // claims Ana granted it
  subject: 'ana-7f3c',
  permitsCapability: ['talking-head'],
  permitsUseClass: ['advertising'],
  maxSpendUsd: 99,
}))

console.log('Producer will now try to seal a grant CLAIMING Ana as author.\n')
console.log('  producer address :', prodId.agentAddress)
console.log('  claimed author   :', anaId.agentAddress, '(Ana)\n')

let result = null, error = null
try {
  await producer.cli(['ka', 'create', name, '-c', CG,
    '-f', `spikes/out/${name}.ttl`, '--no-finalize'])
  result = await producer.api(`/api/knowledge-assets/${encodeURIComponent(name)}/wm/finalize`, {
    method: 'POST',
    body: JSON.stringify({ contextGraphId: CG, authorAgentAddress: anaId.agentAddress }),
  })
  console.log('finalize returned:\n', JSON.stringify(result, null, 2))
} catch (e) {
  error = e
  console.log('finalize REFUSED:', e.message.slice(0, 500))
}

console.log('\n================ S6b VERDICT ================')
if (error) {
  console.log('The node refused to seal on behalf of an agent it has no key for.')
  console.log('S6b GREEN — authorship cannot be forged at the seal.')
} else {
  const sealedAs = (result.authorAddress || '').toLowerCase()
  if (sealedAs === anaId.agentAddress.toLowerCase()) {
    console.log('S6b RED — the producer produced a seal bearing Ana\'s address.')
    console.log('Authorship alone is NOT sufficient; the resolver must verify the')
    console.log('EIP-712 signature against the grantor key, not trust authorAddress.')
  } else {
    console.log(`Seal fell back to the producer's own address: ${result.authorAddress}`)
    console.log('S6b GREEN — the node will not claim an author it cannot sign for.')
  }
}
