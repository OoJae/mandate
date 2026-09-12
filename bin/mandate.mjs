#!/usr/bin/env node
/**
 * Mandate CLI.
 *
 * `render` is the whole argument in one command: resolve the grant knowledge
 * from a graph the producer does not own, decide, and only then spend money.
 */
import { PRODUCER, GRANTOR } from '../src/dkg.mjs'
import { readKnowledge, priorSpendFor, blastRadius } from '../src/resolve.mjs'
import { decide } from '../src/gate.mjs'
import * as LP from '../src/livepeer.mjs'
import { grantToTurtle, stateToTurtle } from '../src/rdf.mjs'
import { captureConsent } from '../src/consent.mjs'
import { writeFileSync, mkdirSync } from 'node:fs'

const GRANTS_CG = process.env.MANDATE_GRANTS_CG
  ?? '0xeD1eeB64CaC09874257F05Fd6B51A55695ad0B69/mandate-grants'

// Live list prices, verified via describe_capability. Labelled as estimates
// everywhere they are shown: get_cost_report is Livepeer's estimate at list
// price, not an invoice, and failed renders are still billed. The one exact
// figure is spend avoided by a refusal — nothing was called, so it is not an
// estimate at all.
const PRICE_PER_SEC = {
  'talking-head': 0.168,
  'face-swap-video': 0.024,
  'lipsync': 0.14,
  'heygen-twin': 0.105,
}
const PRICE_FLAT = { 'face-swap-image': 0.009, 'flux-lora-training': 2.10 }

const estimate = (capability, seconds = 6) =>
  PRICE_FLAT[capability] ?? (PRICE_PER_SEC[capability] ?? 0) * seconds

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : def
}
const has = name => process.argv.includes(`--${name}`)

const c = {
  red: s => `\x1b[31m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  dim: s => `\x1b[2m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
}

async function cmdRender() {
  const subject = arg('subject', 'ana-7f3c')
  const capability = arg('capability', 'talking-head')
  const useClass = arg('use-class', 'advertising')
  const territory = arg('territory', 'GB')
  const seconds = Number(arg('seconds', '6'))
  const at = arg('at', new Date().toISOString())
  const estimatedUsd = estimate(capability, seconds)

  console.log(c.bold('\nMandate — consent gate\n'))
  console.log(`  subject     ${subject}`)
  console.log(`  capability  ${capability}`)
  console.log(`  use class   ${useClass}`)
  console.log(`  territory   ${territory}`)
  console.log(`  estimate    $${estimatedUsd.toFixed(4)} ${c.dim('(list price, not an invoice)')}`)

  // Which node resolves. The producer is the honest default — it is the party
  // that must not be able to vouch for itself. `--resolver grantor` exists only
  // so the permit path can be exercised before the two nodes can sync, which
  // needs an on-chain context-graph registration and therefore gas.
  const resolver = arg('resolver', 'producer') === 'grantor' ? GRANTOR() : PRODUCER()
  process.stdout.write(c.dim(`\n  resolving grant knowledge from ${resolver.name}… `))
  const k = await readKnowledge(resolver, GRANTS_CG)
  console.log(c.dim(`${k.grants.length} grant(s), ${k.assertions.length} state assertion(s)`))

  const candidate = k.grants.find(g => g.subject === subject)
  const priorSpendUsd = candidate ? priorSpendFor(candidate.id, k.derivations) : 0

  const d = decide(
    { subject, capability, useClass, territory, at, estimatedUsd },
    { grants: k.grants, assertions: k.assertions, priorSpendUsd },
  )

  if (d.ignoredForgeries?.length) {
    console.log(c.yellow(`\n  ⚠ ignored ${d.ignoredForgeries.length} state assertion(s) not authored by the grantor:`))
    for (const f of d.ignoredForgeries) {
      console.log(c.yellow(`      "${f.claimed}" claimed by ${f.author}`))
    }
  }

  if (!d.permit) {
    console.log(c.red(`\n  REFUSED — clause: ${d.clause}`))
    console.log(`  ${d.reason}`)
    console.log(c.green(`\n  spend avoided: $${d.spendAvoidedUsd.toFixed(4)} ` +
      c.dim('(exact — the capability was never invoked)')))
    console.log(c.dim('\n  No Livepeer call was made.\n'))
    process.exitCode = 2
    return
  }

  console.log(c.green(`\n  PERMITTED under ${d.grantId}`))
  console.log(c.dim(`  authored by ${d.grantor} — a node this producer does not control`))

  if (!has('execute')) {
    console.log(c.dim('\n  --execute not set; stopping before dispatch (no spend).\n'))
    return
  }

  console.log(c.dim('\n  dispatching via run_capability on /api/mcp/raw (no model substitution)…'))
  const client = await LP.connect(LP.RAW)
  try {
    const grant = k.grants.find(g => g.id === d.grantId)
    if (grant?.maxSpendUsd != null) await LP.setSpendCap(client, grant.maxSpendUsd)
    const out = await LP.runCapability(client, capability, {
      prompt: arg('prompt', 'A friendly spokesperson speaking to camera.'),
      source_url: arg('source-url', undefined),
    })
    console.log('\n' + out)
  } finally {
    await client.close()
  }
}

async function cmdStatus() {
  for (const mk of [GRANTOR, PRODUCER]) {
    const n = mk()
    try {
      const [id, info] = await Promise.all([n.identity(), n.info()])
      console.log(`${c.green('●')} ${n.name.padEnd(18)} :${n.port}  ${id.agentDid}  peers=${info.peers}`)
    } catch (e) {
      console.log(`${c.red('●')} ${n.name.padEnd(18)} :${n.port}  ${c.red('unreachable')} ${e.message.slice(0, 60)}`)
    }
  }
}

async function cmdBlastRadius() {
  const resolver = arg('resolver', 'producer') === 'grantor' ? GRANTOR() : PRODUCER()
  const k = await readKnowledge(resolver, GRANTS_CG)
  const grantId = arg('grant', k.grants[0]?.id)
  const r = blastRadius(grantId, k.derivations)
  console.log(c.bold(`\nQuarantine list for ${grantId}\n`))
  console.log(`  LoRAs:  ${r.loras.length ? r.loras.join(', ') : c.dim('none')}`)
  console.log(`  assets: ${r.assets.length}`)
  for (const a of r.assets) console.log(`    ${a.outputSha256?.slice(0, 16)}… via ${a.servedCapability}`)
  console.log(`  billed under this grant: $${r.totalBilledUsd.toFixed(4)} ${c.dim('(estimated at list price)')}\n`)
}

/**
 * Author a grant ON THE GRANTOR'S NODE.
 *
 * This runs against the grantor daemon on purpose. The producer cannot seal a
 * grant naming Ana as author — its node refuses, because it holds no key for
 * her — and that refusal is what makes the whole scheme worth anything.
 */
async function cmdGrant() {
  const grantor = GRANTOR()
  const id = await grantor.identity()
  const subject = arg('subject', 'ana-7f3c')
  const name = arg('name', `grant-${subject}`)
  const grantId = arg('id', `urn:mandate:grant:${subject}`)

  const requested = {
    useClass: arg('use-class', 'advertising').split(','),
    territory: arg('territory', 'GB').split(','),
  }

  let consent = null
  if (has('with-consent')) {
    console.log(c.bold('\nCapturing consent in the conversation\n'))
    consent = await captureConsent({
      requested,
      onLink: url => {
        console.log('  Open this on the phone of the person being depicted:')
        console.log(c.bold(`    ${url}`))
        console.log(c.dim('  Record ~6 seconds saying what you agree to. Waiting…\n'))
      },
    })
    if (!consent.captured) {
      console.log(c.red('  No clip arrived before the link expired. Not granting.\n'))
      process.exitCode = 2
      return
    }
    console.log(c.green(`  clip received  sha256 ${consent.sha256.slice(0, 32)}…`))
    if (consent.scope) {
      console.log(`  spoken scope   ${consent.scope.covered}/${consent.scope.total} terms mentioned`)
      console.log(c.dim(`  ${consent.scope.note}`))
      if (consent.scope.missing.length && !has('force')) {
        console.log(c.yellow('\n  Spoken consent does not cover everything requested.'))
        console.log(c.yellow('  Re-record, narrow the grant, or pass --force to proceed anyway.\n'))
        process.exitCode = 3
        return
      }
    }
  }

  const grant = {
    id: grantId,
    grantor: id.agentDid,
    subject,
    consentClipSha256: consent?.sha256 ?? undefined,
    permitsCapability: arg('capability', 'talking-head,face-swap-image').split(','),
    permitsUseClass: requested.useClass,
    forbidsUseClass: arg('forbid', 'political,adult').split(','),
    territory: requested.territory,
    validFrom: arg('valid-from', new Date().toISOString()),
    validUntil: arg('valid-until', new Date(Date.now() + 90 * 864e5).toISOString()),
    maxSpendUsd: Number(arg('max-spend', '5')),
  }

  mkdirSync('spikes/out', { recursive: true })
  const path = `spikes/out/${name}.ttl`
  writeFileSync(path, grantToTurtle(grant))

  console.log(c.dim(`\n  sealing on ${grantor.name} …`))
  const r = await grantor.createKA(name, GRANTS_CG, path, { share: true })
  if (r.status !== 'swm-shared') {
    console.log(c.dim('  share did not complete on create; retrying (it is not atomic)…'))
    await grantor.cli(['ka', 'share', name, '-c', GRANTS_CG])
  }
  console.log(c.green(`\n  GRANTED  ${grantId}`))
  console.log(`  author      ${id.agentDid}`)
  console.log(`  merkle root ${r.merkleRoot ?? c.dim('n/a')}`)
  console.log(`  capabilities ${grant.permitsCapability.join(', ')}`)
  console.log(`  ceiling     $${grant.maxSpendUsd}\n`)
}

/** Revoke. Authored by the grantor, or it counts for nothing. */
async function cmdRevoke() {
  const grantor = GRANTOR()
  const id = await grantor.identity()
  const grantId = arg('id', 'urn:mandate:grant:ana-7f3c')
  const at = new Date().toISOString()
  const name = `state-${grantId.split(':').pop()}-revoked-${Date.now().toString(36)}`
  const path = `spikes/out/${name}.ttl`
  mkdirSync('spikes/out', { recursive: true })
  writeFileSync(path, stateToTurtle({
    id: `urn:mandate:state:${name}`, stateOf: grantId,
    state: 'revoked', stateAuthor: id.agentDid, stateAt: at,
  }))
  const r = await grantor.createKA(name, GRANTS_CG, path, { share: true })
  if (r.status !== 'swm-shared') await grantor.cli(['ka', 'share', name, '-c', GRANTS_CG])
  console.log(c.red(`\n  REVOKED ${grantId}`))
  console.log(`  by ${id.agentDid} at ${at}`)
  console.log(c.dim('  shared to SWM; the gate refuses on the next resolve.\n'))
}

async function cmdConsent() {
  const r = await captureConsent({
    requested: { useClass: arg('use-class', 'advertising').split(','), territory: arg('territory', 'GB').split(',') },
    onLink: url => console.log(`\n  Open on a phone: ${c.bold(url)}\n  ${c.dim('waiting…')}`),
  })
  console.log(r.captured ? c.green(`\n  captured  sha256 ${r.sha256}`) : c.red('\n  nothing uploaded'))
  if (r.transcript) console.log(`\n  transcript: ${String(r.transcript).slice(0, 400)}`)
  if (r.scope) console.log(`  ${r.scope.note}\n`)
}

const cmd = process.argv[2]
const table = {
  render: cmdRender, status: cmdStatus, 'blast-radius': cmdBlastRadius,
  grant: cmdGrant, revoke: cmdRevoke, consent: cmdConsent,
}
if (!table[cmd]) {
  console.log(`
${c.bold('mandate')} — a consent rail for generative media

  status                    show both DKG nodes and their agent DIDs
  grant [--with-consent]    author a grant ON THE GRANTOR'S node
  consent                   capture a consent clip via a phone link
  render [--execute]        resolve the grant, decide, and only then spend
  revoke --id <grant>       revoke, as the grantor
  blast-radius              everything produced under a grant

  render  : --subject --capability --use-class --territory --seconds --at --resolver
  grant   : --subject --capability --use-class --territory --forbid --max-spend --with-consent
`)
  process.exit(1)
}
table[cmd]().catch(e => { console.error(c.red(`\n${e.message}\n`)); process.exit(1) })
