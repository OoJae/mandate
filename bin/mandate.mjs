#!/usr/bin/env node
/**
 * Mandate CLI.
 *
 * `render` is the whole argument in one command: resolve grant knowledge from
 * graphs the producer does not control, decide, and only then spend money.
 *
 * Every command succeeds only when what it claims has happened: a grant or
 * revocation is reported only once it is anchored on-chain, and a refusal or an
 * incomplete read exits non-zero with the code from bin/args.mjs.
 */
import { createInterface } from 'node:readline/promises'
import { parseArgs, helpText, UsageError, EXIT } from './args.mjs'
import { GRANTOR, PRODUCER, VERIFIER, grantsCg, derivationsCg, readConfig, envLoad } from './config.mjs'
import { c, clean, txLink, makeOutput } from './ui.mjs'
import { readKnowledge } from '../src/resolve.mjs'
import { decide, revocationOf } from '../src/gate.mjs'
import { blastRadius } from '../src/verify-core.mjs'
import { verifyKnowledge, hashUrl, CLEAR, TAINTED, INCONCLUSIVE } from '../src/verify.mjs'
import { grantToQuads, stateToQuads } from '../src/rdf.mjs'
import { recordDerivation } from '../src/derivation.mjs'
import { DkgWriteError, DkgHttpError } from '../src/dkg.mjs'
import { isProhibitedUseClass, PROHIBITED_USE_CLASSES } from '../src/policy.mjs'
import { grantIriAddress } from '../src/provenance.mjs'
import { TermError, makeSubject, subjectAddress, agentAddress, nonce16 } from '../src/rdf-term.mjs'

// The Livepeer client needs the optional @modelcontextprotocol/sdk peer. Only
// commands that talk to Livepeer load it.
async function livepeer() {
  try {
    return await import('../src/livepeer.mjs')
  } catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND' && /@modelcontextprotocol\/sdk/.test(e.message)) {
      throw new UsageError('This command talks to Livepeer Agent and needs the optional peer:\n  npm install @modelcontextprotocol/sdk')
    }
    throw e
  }
}

// List prices verified via describe_capability. Estimates, labelled as such
// everywhere they are shown.
const PRICE_PER_SEC = {
  'talking-head': 0.168, 'face-swap-video': 0.024, lipsync: 0.14, 'sync-lipsync-v3': 0.13997, 'heygen-twin': 0.105,
}
const PRICE_FLAT = { 'face-swap-image': 0.009, 'flux-lora-training': 2.10 }

function estimate(capability, seconds) {
  if (capability in PRICE_FLAT) return PRICE_FLAT[capability]
  const perSec = PRICE_PER_SEC[capability]
  return perSec == null ? null : perSec * seconds
}

const shortAddr = a => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : 'unknown')

/** Ask for typed confirmation before spending gas on a permanent write. */
async function confirm(flags, out, prompt, expected) {
  if (flags.yes) return
  if (!process.stdin.isTTY || out.json) throw new UsageError('not on a terminal: pass --yes to publish without confirmation')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question(`${prompt} Type ${c.bold(expected)} to publish: `)).trim()
    if (answer !== expected) throw new UsageError('not confirmed; nothing was published')
  } finally {
    rl.close()
  }
}

function anchoredLines(out, r) {
  out.line(`  UAL         ${r.ual}`)
  if (r.txHash) out.line(`  tx          ${r.txHash}`)
  const link = txLink(r.ual, r.txHash)
  if (link) out.line(c.dim(`              ${link}`))
}

function printForgeries(out, forgeries = []) {
  if (!forgeries.length) return
  out.line(c.yellow(`\n  ⚠ ${forgeries.length} object(s) rejected — published by an address not entitled to them:`))
  for (const f of forgeries.slice(0, 10)) {
    out.line(c.yellow(`      ${f.kind}: ${clean(f.id, 120)} by ${f.publisher ?? 'unknown'}${f.ual ? ` (${f.ual})` : ''}`))
    out.line(c.dim(`        ${clean(f.detail, 200)}`))
  }
  if (forgeries.length > 10) out.line(c.dim(`      …and ${forgeries.length - 10} more (use --json)`))
}

function printWarnings(out, warnings = []) {
  for (const w of warnings.slice(0, 5)) out.line(c.dim(`  note: ${clean(w, 240)}`))
}

/* ------------------------------------------------------------------------- */

async function cmdStatus(flags, out) {
  const rows = []
  for (const [role, make] of [['grantor', GRANTOR], ['producer', PRODUCER], ['verifier', VERIFIER]]) {
    let n = null
    try {
      n = make()
      if (!n) { rows.push({ role, configured: false }); continue }
      const [id, info] = await Promise.all([n.identity(), n.info()])
      rows.push({ role, configured: true, reachable: true, name: n.name, port: n.port, agentDid: id.agentDid, peers: info.peers, chain: info.chain?.chainId ?? null, version: info.version })
      out.line(`${c.green('●')} ${role.padEnd(9)} ${String(n.name).padEnd(18)} :${n.port}  ${id.agentDid}  peers=${info.peers}  ${c.dim(`${info.chain?.chainId ?? ''} v${info.version}`)}`)
    } catch (e) {
      rows.push({ role, configured: true, reachable: false, port: n?.port ?? null, error: clean(e.message, 300) })
      out.line(`${c.red('●')} ${role.padEnd(9)} ${String(n?.name ?? '').padEnd(18)} ${n ? `:${n.port}` : ''}  ${c.red('unreachable')}  ${c.dim(clean(e.message, 160))}`)
    }
  }
  const verifier = rows.find(r => r.role === 'verifier')
  if (!verifier.configured) out.line(c.dim('○ verifier  not configured (MANDATE_VERIFIER_PORT); verify reads from the grantor node'))
  for (const [label, get] of [['grants graph', grantsCg], ['derivations graph', derivationsCg]]) {
    try { out.line(c.dim(`  ${label.padEnd(18)} ${get()}`)) } catch (e) { out.line(c.yellow(`  ${label.padEnd(18)} ${e.message.split('\n')[0]}`)) }
  }
  if (envLoad.ignored.length) out.line(c.dim(`  .env: ignored ${envLoad.ignored.join(', ')} (only MANDATE_* and LIVEPEER_AGENT_KEY are read)`))
  out.result({ nodes: rows })
  return rows.some(r => r.configured && !r.reachable) ? EXIT.INCONCLUSIVE : EXIT.OK
}

/**
 * Publish a grant from the grantor's own node. The chain binds it to that
 * node's address, and only that address can grant or revoke for the subjects
 * it names, so this has to run where the grantor's key is.
 */
async function cmdGrant(flags, out) {
  const grantor = GRANTOR()
  const id = await grantor.identity()
  const address = agentAddress(id.agentDid)
  if (!address) throw new Error(`${grantor.name} reported an unusable agent DID: ${clean(id.agentDid, 80)}`)

  const subject = flags.subject.includes(':') ? flags.subject : makeSubject(address, flags.subject)
  if (subjectAddress(subject) !== address) {
    throw new UsageError(`subject ${subject} belongs to ${subjectAddress(subject) ?? 'no address'}; this node is ${address} and can only grant for its own subjects`)
  }
  const permitted = flags.useClass
  const prohibited = permitted.filter(isProhibitedUseClass)
  if (prohibited.length) throw new UsageError(`use class ${prohibited.join(', ')} can never be granted (${PROHIBITED_USE_CLASSES.join(', ')} are always refused)`)
  const forbids = flags.forbid ?? []
  const overlap = forbids.filter(u => permitted.includes(u))
  if (overlap.length) throw new UsageError(`--forbid and --use-class both list ${overlap.join(', ')}`)

  let consent = null
  if (flags.withConsent) {
    out.line(c.bold('\nCapturing consent in the conversation\n'))
    const { captureConsent } = await (async () => { await livepeer(); return import('../src/consent.mjs') })()
    consent = await captureConsent({
      requested: { useClass: permitted, territory: flags.territory ?? [] },
      onLink: url => {
        out.line('  Open this on the phone of the person being depicted:')
        out.line(c.bold(`    ${clean(url, 300)}`))
        out.line(c.dim('  Record a short clip saying what you agree to. Waiting…\n'))
      },
    })
    if (!consent.captured) {
      out.line(c.red('  No clip arrived before the link expired. Not granting.\n'))
      out.result({ granted: false, reason: 'no consent clip' })
      return EXIT.CONSENT_UNCONFIRMED
    }
    out.line(c.green(`  clip received  sha256 ${consent.sha256}`))
    if (consent.scope) {
      out.line(`  spoken scope   ${consent.scope.covered}/${consent.scope.total} terms mentioned`)
      if (consent.scope.missing.length && !flags.force) {
        out.line(c.yellow('\n  Spoken consent does not cover everything requested. Re-record, narrow the grant, or pass --force.\n'))
        out.result({ granted: false, reason: 'spoken consent incomplete', missing: consent.scope.missing })
        return EXIT.CONSENT_UNCONFIRMED
      }
    }
  }

  const now = Date.now()
  const nonce = nonce16()
  const grant = {
    id: `urn:mandate:grant:${subject}:${nonce}`,
    grantor: `did:dkg:agent:${address}`,
    subject,
    consentClipSha256: consent?.sha256 ?? null,
    permitsCapability: flags.capability,
    permitsUseClass: permitted,
    forbidsUseClass: forbids,
    territory: flags.territory ?? [],
    validFrom: flags.validFrom ?? new Date(now).toISOString(),
    validUntil: flags.validUntil ?? new Date(now + 90 * 864e5).toISOString(),
    maxSpendUsd: flags.maxSpend ?? null,
  }
  const quads = grantToQuads(grant)

  out.line(c.bold('\nGrant'))
  out.line(`  id           ${grant.id}`)
  out.line(`  subject      ${subject}`)
  out.line(`  capabilities ${grant.permitsCapability.join(', ')}`)
  out.line(`  use classes  ${permitted.join(', ')}${forbids.length ? c.dim(`  (forbids ${forbids.join(', ')})`) : ''}`)
  out.line(`  territory    ${grant.territory.length ? grant.territory.join(', ') : 'unrestricted'}`)
  out.line(`  valid        ${grant.validFrom} → ${grant.validUntil}`)
  out.line(`  ceiling      ${grant.maxSpendUsd == null ? 'none' : `$${grant.maxSpendUsd}`}`)
  out.line(c.dim(`\n  Publishing to Verifiable Memory is permanent and costs gas on ${grantor.name}.`))
  await confirm(flags, out, '\n  Publish this grant?', subject.split(':')[1])

  out.line(c.dim(`\n  sealing, sharing and anchoring on ${grantor.name}…`))
  const r = await grantor.sealShareAnchor({ name: `grant-${subject.split(':')[1]}-${nonce}`, contextGraphId: grantsCg(), quads, expectAuthor: address })
  out.line(c.green(`\n  GRANTED  ${grant.id}`))
  anchoredLines(out, r)
  out.line(c.dim('\n  Renew by publishing a new grant; a revocation ends this one for good.\n'))
  out.result({ granted: true, grant, ual: r.ual, txHash: r.txHash, name: r.name, explorer: txLink(r.ual, r.txHash) })
  return EXIT.OK
}

/** Revoke a grant this node published. Terminal: renewal means a new grant. */
async function cmdRevoke(flags, out) {
  const grantor = GRANTOR()
  const address = agentAddress((await grantor.identity()).agentDid)
  const grantId = flags.id
  const owner = grantIriAddress(grantId)
  if (!owner) {
    out.line(c.red(`\n  ${clean(grantId, 120)} is not a current-format grant id; nothing to revoke.\n`))
    out.result({ revoked: false, reason: 'not a grant id' })
    return EXIT.REFUSED
  }
  if (owner !== address) {
    out.line(c.red(`\n  REFUSED — ${grantId} belongs to ${owner}; this node is ${address}.`))
    out.line(c.dim('  Only the address that published a grant can revoke it. Nothing was published.\n'))
    out.result({ revoked: false, reason: 'not published by this node', owner, node: address })
    return EXIT.REFUSED
  }

  const k = await readKnowledge(grantor, readConfig(), { grantId })
  if (!k.consistency.ok) {
    out.line(c.yellow(`\n  INCONCLUSIVE — cannot confirm the grant's current state: ${clean(k.consistency.reason, 300)}\n`))
    out.result({ revoked: false, reason: 'read inconsistent', consistency: k.consistency })
    return EXIT.INCONCLUSIVE
  }
  const grant = k.grants.find(g => g.id === grantId)
  if (!grant) {
    out.line(c.red(`\n  REFUSED — ${grantId} is not anchored in ${grantsCg()} on ${grantor.name}. Nothing was published.\n`))
    out.result({ revoked: false, reason: 'grant not found' })
    return EXIT.REFUSED
  }
  const existing = revocationOf(grant, k.states)
  if (existing.revoked) {
    out.line(c.dim(`\n  ${grantId} is already revoked${existing.by.ual ? ` (${existing.by.ual})` : ''}. Nothing was published.\n`))
    out.result({ revoked: true, alreadyRevoked: true, by: existing.by })
    return EXIT.OK
  }

  out.line(c.bold(`\nRevoke ${grantId}`))
  out.line(`  subject   ${grant.subject}`)
  out.line(`  grant     ${grant.ual}`)
  out.line(c.dim('\n  Revocation is permanent: this grant can never be used again.'))
  await confirm(flags, out, '\n  Publish this revocation?', 'revoke')

  const nonce = nonce16()
  const at = new Date().toISOString()
  const quads = stateToQuads({ id: `urn:mandate:state:${nonce}`, stateOf: grantId, state: 'revoked', stateAuthor: `did:dkg:agent:${address}`, stateAt: at })
  out.line(c.dim(`\n  sealing, sharing and anchoring on ${grantor.name}…`))
  const r = await grantor.sealShareAnchor({ name: `revoke-${grant.subject.split(':')[1]}-${nonce}`, contextGraphId: grantsCg(), quads, expectAuthor: address })
  out.line(c.red(`\n  REVOKED  ${grantId}`))
  out.line(`  at          ${at}`)
  anchoredLines(out, r)
  out.line(c.dim('\n  Other nodes refuse once they sync this anchor, typically within about a minute.'))
  out.line(c.dim('  Until then a producer resolving from a node that has not synced may still permit.\n'))
  out.result({ revoked: true, grantId, at, ual: r.ual, txHash: r.txHash, explorer: txLink(r.ual, r.txHash) })
  return EXIT.OK
}

async function cmdRender(flags, out) {
  const { subject, capability, useClass } = flags
  const territory = flags.territory
  if (flags.execute && flags.at) throw new UsageError('--at decides as of another time and is for dry runs only; it cannot be combined with --execute')
  const at = flags.at ?? new Date().toISOString()
  const seconds = flags.seconds === undefined ? 6 : Number(flags.seconds)
  const estimatedUsd = estimate(capability, seconds)

  out.line(c.bold('\nMandate — consent gate\n'))
  out.line(`  subject     ${subject}`)
  out.line(`  capability  ${capability}`)
  out.line(`  use class   ${useClass}`)
  out.line(`  territory   ${territory ?? c.yellow('not given')}`)
  out.line(`  estimate    ${estimatedUsd == null ? c.yellow('unknown (no list price)') : `~$${estimatedUsd.toFixed(4)}`} ${c.dim('(list price, not an invoice)')}`)

  // The producer resolves from its own node: the party that must not be able to vouch for itself.
  const resolver = PRODUCER()
  out.line(c.dim(`\n  resolving from ${resolver.name}…`))
  const k = await readKnowledge(resolver, readConfig(), { subject })
  out.line(c.dim(`  ${k.grants.length} grant(s), ${k.states.length} revocation(s), ${k.derivations.length} trusted derivation(s), read in ${k.consistency.attempts} attempt(s)`))

  const d = decide({ subject, capability, useClass, territory, at, estimatedUsd }, k)
  printForgeries(out, d.forgeries)
  printWarnings(out, d.warnings)

  if (!d.permit) {
    out.line(c.red(`\n  REFUSED — clause: ${d.clause}`))
    out.line(`  ${clean(d.reason, 400)}`)
    out.line(c.green(`\n  not spent: ${d.spend.estimateUsd == null ? 'unknown' : `~$${d.spend.estimateUsd.toFixed(4)} at list price`}`) + c.dim(' (the capability was never invoked)'))
    out.line(c.dim('  No Livepeer call was made.\n'))
    out.result({ decision: d })
    return d.clause === 'read-inconsistent' ? EXIT.INCONCLUSIVE : d.clause === 'malformed-request' ? EXIT.USAGE : EXIT.REFUSED
  }

  out.line(c.green(`\n  PERMITTED under ${d.grantId}`))
  out.line(c.dim(`  published by ${d.publisher}${d.grantUal ? ` as ${d.grantUal}` : ''}`))
  if (!flags.execute) {
    out.line(c.dim('\n  --execute not set; stopping before dispatch (no spend).\n'))
    out.result({ decision: d, executed: false })
    return EXIT.OK
  }

  const LP = await livepeer()
  out.line(c.dim('\n  dispatching via run_capability on /api/mcp/raw (no model substitution)…'))
  const client = await LP.connect(LP.RAW)
  let text
  try {
    const inputs = { ...(flags.inputs ?? {}) }
    if (flags.imageUrl) inputs.image_url = flags.imageUrl
    if (flags.audioUrl) inputs.audio_url = flags.audioUrl
    if (flags.videoUrl) inputs.video_url = flags.videoUrl
    text = await LP.runCapability(client, capability, {
      source_url: flags.sourceUrl,
      inputs: Object.keys(inputs).length ? inputs : undefined,
      prompt: flags.prompt,
      idempotency_key: flags.idempotencyKey,
    }, { timeout: 280 })
  } catch (e) {
    out.line(c.red(`\n  RENDER FAILED — ${clean(e.message, 400)}\n`))
    out.result({ decision: d, executed: true, rendered: false, error: clean(e.message, 400) })
    return EXIT.RENDER_FAILED
  } finally {
    await client.close()
  }
  const mediaUrl = (text.match(/https?:\/\/\S+?\.(?:mp4|webm|mov|png|jpg|jpeg|webp|wav|mp3)\b/i) || [])[0]
  if (!mediaUrl) {
    out.line(c.red('\n  RENDER FAILED — the result carried no media URL.\n'))
    out.line(c.dim(`  ${clean(text, 600)}`))
    out.result({ decision: d, executed: true, rendered: false, error: 'no media URL' })
    return EXIT.RENDER_FAILED
  }

  // The media is released only once its derivation is anchored.
  const producer = PRODUCER()
  try {
    const rec = await recordDerivation(producer, derivationsCg(), {
      outputUrl: mediaUrl, servedCapability: capability, authorizedUnder: d.grantId,
      billedUsd: estimatedUsd, jobId: (text.match(/mjob_[a-f0-9]+/) || [])[0] ?? null,
    })
    out.line(c.green(`\n  RENDERED  ${clean(mediaUrl, 400)}`))
    out.line(`  derivation  ${rec.id}`)
    out.line(`  sha256      ${rec.outputSha256}`)
    anchoredLines(out, rec)
    out.line('')
    out.result({ decision: d, executed: true, rendered: true, mediaUrl, derivation: rec })
    return EXIT.OK
  } catch (e) {
    out.line(c.red('\n  DERIVATION FAILED TO COMMIT — treating this render as failed.'))
    out.line(c.red(`  ${clean(e.message, 400)}`))
    if (e.ual) out.line(c.dim(`  minted but unbound: ${e.ual}${e.txHash ? ` tx ${e.txHash}` : ''}`))
    out.line(c.dim('  The render was billed but is not accounted for, so its URL is withheld.\n'))
    out.result({ decision: d, executed: true, rendered: true, derivation: null, error: clean(e.message, 400), stage: e.stage ?? null })
    return EXIT.DERIVATION_FAILED
  }
}

async function cmdConsent(flags, out) {
  await livepeer()
  const { captureConsent } = await import('../src/consent.mjs')
  const r = await captureConsent({
    requested: { useClass: flags.useClass, territory: flags.territory ?? [] },
    onLink: url => out.line(`\n  Open on a phone: ${c.bold(clean(url, 300))}\n  ${c.dim('waiting…')}`),
  })
  out.line(r.captured ? c.green(`\n  captured  sha256 ${r.sha256}`) : c.red('\n  nothing uploaded'))
  if (r.transcript) out.line(`\n  transcript: ${clean(r.transcript, 400)}`)
  if (r.scope) out.line(`  ${clean(r.scope.note, 300)}\n`)
  out.result({ captured: r.captured, sha256: r.sha256 ?? null, transcript: r.transcript ?? null, scope: r.scope ?? null })
  return r.captured ? EXIT.OK : EXIT.CONSENT_UNCONFIRMED
}

/** The third-party check. Takes a file and asks neither party. */
async function cmdVerify(flags, out) {
  if (Boolean(flags.url) === Boolean(flags.sha256)) throw new UsageError('verify needs exactly one of --url or --sha256')
  const choice = flags.node ?? 'verifier'
  let node = choice === 'grantor' ? GRANTOR() : choice === 'producer' ? PRODUCER() : VERIFIER()
  let label
  if (choice === 'verifier' && !node) {
    node = GRANTOR()
    label = "the grantor's node (no verifier node configured) — independent of the producer, not of the grantor"
  } else {
    label = choice === 'verifier' ? 'an independent read-only node'
      : choice === 'grantor' ? "the grantor's node — independent of the producer, not of the grantor"
        : "the producer's own node — not independent of the producer"
  }

  out.line(c.bold('\nThird-party verification\n'))
  if (flags.url) out.line(`  file      ${clean(flags.url, 120)}`)
  out.line(c.dim(`  reading   ${node.name} — ${label}`))
  const sha256 = flags.sha256 ?? await hashUrl(flags.url)
  out.line(`  sha256    ${sha256}`)

  const k = await readKnowledge(node, readConfig(), { sha256 })
  const r = verifyKnowledge(k, sha256)
  printForgeries(out, r.forgeries)
  printWarnings(out, r.warnings)
  if (r.untrusted.length) out.line(c.dim(`  ${r.untrusted.length} edge(s) from untrusted publishers shown but not believed`))
  const paint = r.verdict === CLEAR ? c.green : r.verdict === TAINTED ? c.red : c.yellow
  out.line(paint(`\n  ${r.verdict}${r.subStatus ? ` / ${r.subStatus}` : ''}`))
  out.line(`  ${clean(r.reason, 400)}\n`)
  out.result({ ...r, node: node.name, nodeRole: choice })
  return r.verdict === CLEAR ? EXIT.OK : r.verdict === INCONCLUSIVE ? EXIT.INCONCLUSIVE : EXIT.REFUSED
}

async function cmdBlastRadius(flags, out) {
  const grantId = flags.grant
  const k = await readKnowledge(PRODUCER(), readConfig(), { grantId })
  if (!k.consistency.ok) {
    out.line(c.yellow(`\n  INCONCLUSIVE — ${clean(k.consistency.reason, 300)}\n`))
    out.result({ grantId, consistency: k.consistency })
    return EXIT.INCONCLUSIVE
  }
  const grant = k.grants.find(g => g.id === grantId) ?? null
  const rev = grant ? revocationOf(grant, k.states) : null
  const r = blastRadius(grantId, k.derivations)
  out.line(c.bold(`\nQuarantine list for ${grantId}\n`))
  printWarnings(out, k.warnings)
  out.line(`  grant   ${grant ? `${grant.ual}  ${rev.revoked ? c.red('revoked') : c.green('live')}` : c.yellow('not found in the grants graph')}`)
  out.line(`  assets  ${r.assets.length} ${c.dim('(recorded by trusted producers)')}`)
  for (const a of r.assets) out.line(`    ${a.outputSha256.slice(0, 16)}…  ${a.servedCapability}  ${c.dim(a.ual)}`)
  out.line(`  billed  ${r.billedUnknown ? 'unknown' : `~$${r.totalBilledUsd.toFixed(4)}`} ${c.dim('(estimated at list price)')}\n`)
  out.result({ grantId, grant, revoked: rev?.revoked ?? null, ...r })
  return EXIT.OK
}

const COMMAND_FNS = {
  status: cmdStatus, grant: cmdGrant, revoke: cmdRevoke, render: cmdRender,
  consent: cmdConsent, verify: cmdVerify, 'blast-radius': cmdBlastRadius,
}

function exitFor(e) {
  if (e instanceof UsageError || e instanceof TermError) return EXIT.USAGE
  if (e instanceof DkgWriteError) return ['unbound', 'publish', 'publish-transport'].includes(e.stage) ? EXIT.DKG_ANCHOR_FAILED : EXIT.DKG_WRITE_FAILED
  if (e instanceof DkgHttpError) return EXIT.INCONCLUSIVE
  return EXIT.USAGE
}

async function main(argv) {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (e) {
    if (!(e instanceof UsageError)) throw e
    console.error(`${e.message}\n\nRun \`mandate --help\` for usage.`)
    return EXIT.USAGE
  }
  const { command, flags } = parsed
  if (!command || flags.help) {
    console.log(helpText(command))
    return EXIT.OK
  }
  const out = makeOutput({ json: flags.json })
  try {
    return await COMMAND_FNS[command](flags, out)
  } catch (e) {
    const code = exitFor(e)
    if (out.json) {
      console.log(JSON.stringify({ error: clean(e.message, 1000), stage: e.stage ?? null, ual: e.ual ?? null, txHash: e.txHash ?? null, mayHaveSent: e.mayHaveSent ?? false, exitCode: code }, null, 2))
    } else {
      console.error(c.red(`\n  ${clean(e.message, 1000)}`))
      if (e instanceof DkgWriteError) {
        console.error(c.red(`  stage: ${e.stage}`))
        if (e.ual) console.error(`  UAL: ${e.ual}`)
        if (e.txHash) console.error(`  tx:  ${e.txHash}${txLink(e.ual, e.txHash) ? `  ${txLink(e.ual, e.txHash)}` : ''}`)
        if (e.mayHaveSent) console.error(c.yellow('  A transaction may have been sent. Check the node before retrying.'))
      }
      console.error('')
    }
    return code
  }
}

process.exitCode = await main(process.argv.slice(2))
