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
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { parseArgs, helpText, UsageError, EXIT } from './args.mjs'
import {
  GRANTOR, PRODUCER, VERIFIER, grantsCgs, derivationsCgs, grantsCgFor, derivationsCgFor,
  readConfig, envLoad, ConfigError,
} from './config.mjs'
import { c, clean, txLink, makeOutput } from './ui.mjs'
import { readKnowledge } from '../src/resolve.mjs'
import { decide, revocationOf } from '../src/gate.mjs'
import { blastRadius } from '../src/verify-core.mjs'
import { verifyKnowledge, hashUrl, CLEAR, TAINTED, INCONCLUSIVE } from '../src/verify.mjs'
import { FetchBytesError } from '../src/fetch-bytes.mjs'
import { grantToQuads, stateToQuads } from '../src/rdf.mjs'
import { recordDerivation } from '../src/derivation.mjs'
import { DkgWriteError, DkgHttpError, ReadTruncatedError, NodeTokenError } from '../src/dkg.mjs'
import { isProhibitedUseClass, PROHIBITED_USE_CLASSES } from '../src/policy.mjs'
import { grantIriAddress } from '../src/provenance.mjs'
import { TermError, makeSubject, subjectAddress, agentAddress, nonce16 } from '../src/rdf-term.mjs'
import { checkInputs, dispatchMode, estimateFromPricing, STATIC_PRICES } from '../src/capabilities.mjs'
import { renderKey, pendingStore, PendingConflictError } from '../src/pending.mjs'
import { StateReadError } from '../src/state-store.mjs'

/** An exit code chosen where an error was caught, for errors whose class alone says too little. */
const EXIT_CODE = Symbol('mandate.exitCode')
function withExit(e, code) {
  if (e && typeof e === 'object' && !Object.isFrozen(e) && e[EXIT_CODE] === undefined) e[EXIT_CODE] = code
  return e
}

/** Payment and credential wording in a Livepeer or transport failure. */
const CREDENTIAL = /\b(?:401|402|403)\b|unauthori[sz]ed|forbidden|\bapi[ _-]?keys?\b|\bpayments?\b|insufficient (?:funds|credits?|balance)|\bcredits?\b/i
const livepeerExit = e => (CREDENTIAL.test(`${e?.message ?? ''} ${e?.text ?? ''} ${e?.code ?? ''}`) ? EXIT.PAYMENT : EXIT.INCONCLUSIVE)

// The Livepeer client needs the optional @modelcontextprotocol/sdk peer. Only
// commands that talk to Livepeer load it.
async function livepeer() {
  try {
    const [client, execute] = await Promise.all([import('../src/livepeer.mjs'), import('../src/execute.mjs')])
    return { ...client, ...execute }
  } catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND' && /@modelcontextprotocol\/sdk/.test(e.message)) {
      throw new UsageError('This command talks to Livepeer Agent and needs the optional peer:\n  npm install @modelcontextprotocol/sdk')
    }
    throw e
  }
}

/** Connect to Livepeer Agent; a failure is a credential (10) or reachability (9) problem, never a usage error. */
async function connectLivepeer(LP) {
  try {
    return await LP.connect(LP.RAW)
  } catch (e) {
    throw withExit(e, livepeerExit(e))
  }
}

const isFallbackPrice = (structured, row) => [...Object.values(row ?? {}), ...Object.values(structured ?? {})]
  .some(v => typeof v === 'string' && /static[ _-]?fallback/i.test(v))

/**
 * A list-price estimate: from get_pricing when the Livepeer client is
 * available, otherwise from the static table. Always an estimate, and labelled;
 * a price the platform itself marks as a static fallback is never called live.
 */
async function priceEstimate(capability, seconds, client, LP) {
  let row = null
  let source = 'static list price'
  if (client) {
    try {
      const { structured } = await LP.callStrict(client, 'get_pricing', { name: capability })
      const found = structured?.capabilities?.find(x => x?.name === capability) ?? null
      if (found) {
        row = found
        source = isFallbackPrice(structured, found) ? 'Livepeer static fallback list price (not live)' : 'live list price'
      }
    } catch { /* fall back to the static table */ }
  }
  row ??= STATIC_PRICES[capability] ?? null
  if (!row) return { usd: null, source: 'no list price', unit: null }
  return { usd: estimateFromPricing(row, { seconds }), source, unit: row.unit_kind ?? null, perUnit: row.display_price_usd }
}

function renderInputs(flags) {
  const inputs = { ...(flags.inputs ?? {}) }
  if (flags.imageUrl) inputs.image_url = flags.imageUrl
  if (flags.audioUrl) inputs.audio_url = flags.audioUrl
  if (flags.videoUrl) inputs.video_url = flags.videoUrl
  return inputs
}

/**
 * Typed answers read from the terminal. Lines are buffered, so answers typed
 * ahead are not lost between questions. In --json mode the questions go to
 * stderr and the result stays alone on stdout.
 */
function makePrompter(out) {
  let rl = null
  let lines = null
  return {
    possible: () => Boolean(process.stdin.isTTY),
    async ask(question) {
      if (!rl) {
        rl = createInterface({ input: process.stdin, terminal: false })
        lines = rl[Symbol.asyncIterator]()
      }
      ;(out.json ? process.stderr : process.stdout).write(question)
      const { value, done } = await lines.next()
      return done ? null : String(value).trim()
    },
    close() { rl?.close() },
  }
}

/** Ask for typed confirmation before spending gas on a permanent write. `--yes` skips this one. */
async function confirm(flags, out, prompter, prompt, expected) {
  if (flags.yes) return
  if (!prompter.possible() || out.json) throw new UsageError('not on a terminal: pass --yes to publish without confirmation')
  const answer = await prompter.ask(`${prompt} Type ${c.bold(expected)} to publish: `)
  if (answer !== expected) throw new UsageError('not confirmed; nothing was published')
}

function anchoredLines(out, r) {
  out.line(`  UAL         ${clean(r.ual, 300)}`)
  if (r.txHash) out.line(`  tx          ${clean(r.txHash, 100)}`)
  const link = txLink(r.ual, r.txHash)
  if (link) out.line(c.dim(`              ${link}`))
}

function printForgeries(out, forgeries = []) {
  if (!forgeries.length) return
  // A trusted party's own record that could not be read matters more than a stranger's forgery.
  const sorted = [...forgeries].sort((a, b) => Number(b?.trusted === true) - Number(a?.trusted === true))
  const trusted = sorted.filter(f => f?.trusted === true).length
  out.line(c.yellow(`\n  ⚠ ${forgeries.length} object(s) rejected${trusted ? `, ${trusted} of them from a trusted grantor or producer` : ' — published by an address not entitled to them'}:`))
  for (const f of sorted.slice(0, 10)) {
    const paint = f?.trusted === true ? c.red : c.yellow
    out.line(paint(`      ${f.trusted === true ? 'TRUSTED ' : ''}${clean(f.kind, 40)}: ${clean(f.id, 120)} by ${clean(f.publisher ?? 'unknown', 60)}${f.ual ? ` (${clean(f.ual, 120)})` : ''}`))
    out.line(c.dim(`        ${clean(f.detail, 200)}`))
  }
  if (forgeries.length > 10) out.line(c.dim(`      …and ${forgeries.length - 10} more (use --json)`))
}

function printWarnings(out, warnings = []) {
  const legacy = warnings.filter(w => /not a current-format|non-current grant id/.test(w))
  const rest = warnings.filter(w => !legacy.includes(w))
  if (legacy.length) out.line(c.dim(`  note: ignored ${legacy.length} object(s) in the 0.1.0 id format (use --json to list them)`))
  for (const w of rest.slice(0, 5)) out.line(c.dim(`  note: ${clean(w, 240)}`))
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
      out.line(`${c.green('●')} ${role.padEnd(9)} ${clean(n.name, 40).padEnd(18)} :${n.port}  ${clean(id.agentDid, 100)}  peers=${clean(info.peers, 10)}  ${c.dim(`${clean(info.chain?.chainId ?? '', 40)} v${clean(info.version, 20)}`)}`)
    } catch (e) {
      rows.push({ role, configured: true, reachable: false, port: n?.port ?? null, error: clean(e.message, 300) })
      out.line(`${c.red('●')} ${role.padEnd(9)} ${clean(n?.name ?? '', 40).padEnd(18)} ${n ? `:${n.port}` : ''}  ${c.red('unreachable')}  ${c.dim(clean(e.message, 160))}`)
    }
  }
  const verifier = rows.find(r => r.role === 'verifier')
  if (!verifier.configured) out.line(c.dim('○ verifier  not configured (MANDATE_VERIFIER_PORT); verify reads from the grantor node'))
  for (const [label, get] of [['grants graphs', grantsCgs], ['derivations graphs', derivationsCgs]]) {
    try { out.line(c.dim(`  ${label.padEnd(18)} ${get().join(', ')}`)) } catch (e) { out.line(c.yellow(`  ${label.padEnd(18)} ${e.message.split('\n')[0]}`)) }
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
async function cmdGrant(flags, out, prompter) {
  const grantor = GRANTOR()
  const id = await grantor.identity()
  const address = agentAddress(id.agentDid)
  if (!address) throw new Error(`${grantor.name} reported an unusable agent DID: ${clean(id.agentDid, 80)}`)

  const subject = flags.subject.includes(':') ? flags.subject : makeSubject(address, flags.subject)
  if (subjectAddress(subject) !== address) {
    throw new UsageError(`subject ${clean(subject, 120)} belongs to ${subjectAddress(subject) ?? 'no address'}; this node is ${address} and can only grant for its own subjects`)
  }
  const permitted = flags.useClass
  const prohibited = permitted.filter(isProhibitedUseClass)
  if (prohibited.length) throw new UsageError(`use class ${prohibited.join(', ')} can never be granted (declared labels ${PROHIBITED_USE_CLASSES.join(', ')} are always refused)`)
  const forbids = flags.forbid ?? []
  const overlap = forbids.filter(u => permitted.includes(u))
  if (overlap.length) throw new UsageError(`--forbid and --use-class both list ${overlap.join(', ')}`)

  const now = Date.now()
  const validFrom = flags.validFrom ?? new Date(now).toISOString()
  const validUntil = flags.validUntil ?? new Date(now + 90 * 864e5).toISOString()
  if (Date.parse(validUntil) <= Date.parse(validFrom)) throw new UsageError(`--valid-until ${validUntil} must be after the start ${validFrom}`)
  if (Date.parse(validUntil) <= now) throw new UsageError(`--valid-until ${validUntil} has already passed; the grant could never be used`)

  const nonce = nonce16()
  const grant = {
    id: `urn:mandate:grant:${subject}:${nonce}`,
    grantor: `did:dkg:agent:${address}`,
    subject,
    consentClipSha256: null,
    permitsCapability: flags.capability,
    permitsUseClass: permitted,
    forbidsUseClass: forbids,
    territory: flags.territory ?? [],
    validFrom,
    validUntil,
    maxSpendUsd: flags.maxSpend ?? null,
  }
  // Everything that could stop the publish is checked before a consent clip is
  // recorded and paid to transcribe: the terms can be written (a placeholder
  // stands in for the clip hash), there is a graph to write them to, and the
  // confirmations this run needs can be given.
  grantToQuads({ ...grant, consentClipSha256: '0'.repeat(64) })
  const cg = grantsCgFor(address)
  if (!flags.yes && (!prompter.possible() || out.json)) throw new UsageError('not on a terminal: pass --yes to publish without confirmation')

  let consent = null
  let consentSummary = null
  if (flags.withConsent) {
    if (!prompter.possible()) {
      const reason = 'a consent clip must be confirmed by a person typing at a terminal, and --yes does not skip that; run this from a terminal'
      out.line(c.red(`\n  NOT STARTED — ${reason}. No clip was requested and nothing was published.\n`))
      out.result({ granted: false, reason: 'consent confirmation impossible', detail: reason })
      return EXIT.CONSENT_UNCONFIRMED
    }
    await livepeer()
    const requested = { capability: flags.capability, useClass: permitted, territory: grant.territory, validUntil, maxSpendUsd: grant.maxSpendUsd }
    const r = await captureAndCheck(flags, out, requested, { allowForce: true })
    consentSummary = r.summary
    if (r.code !== EXIT.OK) {
      out.result({ granted: false, consent: r.summary })
      return r.code
    }
    if (!await confirmConsent(out, prompter, r.consent, grant, r.forced)) {
      out.line(c.red('\n  Not confirmed. Nothing was published.\n'))
      out.result({ granted: false, reason: 'consent not confirmed', consent: r.summary })
      return EXIT.CONSENT_UNCONFIRMED
    }
    consent = r.consent
    // A forced grant is not a checked one, so it does not carry the clip hash a
    // checked grant carries: on the graph, a grant with a clip hash always means
    // the words were checked. The hash stays in this command's result.
    // Deliberate trade-off: the forced grant loses its link to the clip.
    grant.consentClipSha256 = r.forced ? null : consent.sha256
    consentSummary = { ...r.summary, forced: r.forced, publishedClipHash: grant.consentClipSha256 !== null }
  }
  const quads = grantToQuads(grant)

  out.line(c.bold('\nGrant'))
  out.line(`  id           ${grant.id}`)
  out.line(`  subject      ${subject}`)
  out.line(`  capabilities ${grant.permitsCapability.join(', ')}`)
  out.line(`  use classes  ${permitted.join(', ')}${forbids.length ? c.dim(`  (forbids ${forbids.join(', ')})`) : ''}`)
  out.line(`  territory    ${grant.territory.length ? grant.territory.join(', ') : c.yellow('ANYWHERE (unrestricted)')}`)
  out.line(`  valid        ${grant.validFrom} → ${grant.validUntil}`)
  out.line(`  ceiling      ${grant.maxSpendUsd == null ? 'none' : `$${grant.maxSpendUsd}`}`)
  if (consent) out.line(`  consent clip ${grant.consentClipSha256 ?? c.yellow(`not attached (forced past missing terms; clip sha256 ${consent.sha256})`)}`)
  out.line(c.dim(`  graph        ${cg}`))
  out.line(c.dim(`\n  Publishing to Verifiable Memory is permanent and costs gas on ${grantor.name}.`))
  await confirm(flags, out, prompter, '\n  Publish this grant?', subject.split(':')[1])

  out.line(c.dim(`\n  sealing, sharing and anchoring on ${grantor.name}…`))
  const r = await grantor.sealShareAnchor({ name: `grant-${subject.split(':')[1]}-${nonce}`, contextGraphId: cg, quads, expectAuthor: address })
  out.line(c.green(`\n  GRANTED  ${grant.id}`))
  anchoredLines(out, r)
  out.line(c.dim('\n  Renew by publishing a new grant; a revocation ends this one for good.\n'))
  out.result({ granted: true, grant, contextGraphId: cg, ual: r.ual, txHash: r.txHash, name: r.name, explorer: txLink(r.ual, r.txHash), consent: consentSummary })
  return EXIT.OK
}

/** What each unchecked item means for this grant, and the word a person must type to accept it. */
function uncheckedItem(item, grant) {
  switch (item) {
    case 'validity': return { text: `valid until ${grant.validUntil}; the words were never compared with this date`, expect: grant.validUntil.slice(0, 10) }
    case 'ceiling': return grant.maxSpendUsd == null
      ? { text: 'NO spend ceiling: renders under this grant are unlimited in cost', expect: 'none' }
      : { text: `spend ceiling $${grant.maxSpendUsd}; the words were never compared with this amount`, expect: String(grant.maxSpendUsd) }
    case 'territory-unrestricted': return { text: 'territory ANYWHERE: the grant is not restricted to any country', expect: 'anywhere' }
    default: return { text: `${item}: not compared with the words`, expect: item }
  }
}

/**
 * The confirmation a person gives after watching the clip. Not skippable by
 * --yes or --force: the transcript is a machine's reading of the clip, and the
 * validity window, the ceiling and an unrestricted territory were never
 * compared with the words at all.
 */
async function confirmConsent(out, prompter, r, grant, forced) {
  const unchecked = [...new Set([...(Array.isArray(r.scope?.unchecked) ? r.scope.unchecked : ['validity', 'ceiling']),
    ...(grant.territory.length ? [] : ['territory-unrestricted'])])]
  out.notice(c.bold('\n  Confirm the consent clip. --yes does not skip this.'))
  out.notice(`  Watch the clip. The words were checked only for consent, the capabilities, the use classes${grant.territory.length ? ' and the territories' : ''}.`)
  if (forced) out.notice(c.yellow('  --force: some requested terms were not said; the grant will not carry the clip hash.'))
  const answer = await prompter.ask(`\n  Is the transcript above what the person says in the clip? Type ${c.bold('matches')}: `)
  if (answer !== 'matches') return false
  for (const item of unchecked) {
    const { text, expect } = uncheckedItem(item, grant)
    out.notice(c.yellow(`\n  NOT CHECKED against the words — ${text}`))
    const got = await prompter.ask(`  Did the person agree to this? Type ${c.bold(expect)}: `)
    if (got !== expect) return false
  }
  return true
}

/** Revoke a grant this node published. Terminal: renewal means a new grant. */
async function cmdRevoke(flags, out, prompter) {
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
  const cfg = readConfig()
  const cg = grantsCgFor(address)

  const k = await readKnowledge(grantor, cfg, { grantId })
  if (!k.consistency.ok) {
    out.line(c.yellow(`\n  INCONCLUSIVE — cannot confirm the grant's current state: ${clean(k.consistency.reason, 300)}\n`))
    out.result({ revoked: false, reason: 'read inconsistent', consistency: k.consistency })
    return EXIT.INCONCLUSIVE
  }
  const grant = k.grants.find(g => g.id === grantId)
  if (!grant) {
    out.line(c.red(`\n  REFUSED — ${grantId} is not anchored in ${cfg.grantsCgs.join(', ')} on ${grantor.name}. Nothing was published.\n`))
    out.result({ revoked: false, reason: 'grant not found' })
    return EXIT.REFUSED
  }
  const existing = revocationOf(grant, k.states)
  if (existing.revoked) {
    out.line(c.dim(`\n  ${grantId} is already revoked${existing.by.ual ? ` (${clean(existing.by.ual, 200)})` : ''}. Nothing was published.\n`))
    out.result({ revoked: true, alreadyRevoked: true, by: existing.by })
    return EXIT.OK
  }

  out.line(c.bold(`\nRevoke ${grantId}`))
  out.line(`  subject   ${clean(grant.subject, 200)}`)
  out.line(`  grant     ${clean(grant.ual, 200)}`)
  out.line(c.dim(`  graph     ${cg}`))
  out.line(c.dim('\n  Revocation is permanent: this grant can never be used again.'))
  await confirm(flags, out, prompter, '\n  Publish this revocation?', 'revoke')

  const nonce = nonce16()
  const at = new Date().toISOString()
  const quads = stateToQuads({ id: `urn:mandate:state:${nonce}`, stateOf: grantId, state: 'revoked', stateAuthor: `did:dkg:agent:${address}`, stateAt: at })
  out.line(c.dim(`\n  sealing, sharing and anchoring on ${grantor.name}…`))
  const r = await grantor.sealShareAnchor({ name: `revoke-${grant.subject.split(':')[1]}-${nonce}`, contextGraphId: cg, quads, expectAuthor: address })
  out.line(c.red(`\n  REVOKED  ${grantId}`))
  out.line(`  at          ${at}`)
  anchoredLines(out, r)
  out.line(c.dim('\n  Other nodes refuse once they sync this anchor, typically within about a minute.'))
  out.line(c.dim('  Until then a producer resolving from a node that has not synced may still permit.\n'))
  out.result({ revoked: true, grantId, at, contextGraphId: cg, ual: r.ual, txHash: r.txHash, explorer: txLink(r.ual, r.txHash) })
  return EXIT.OK
}

const finiteNonNegative = v => typeof v === 'number' && Number.isFinite(v) && v >= 0

/** Local render records that may already be billed but have no derivation on the graph yet. */
const OPEN_STATUSES = ['dispatching', 'submitted', 'rendered']

/**
 * Spend from this machine's own renders that are not yet recorded as
 * derivations, as extra trusted entries for the gate. A render billed but not
 * yet anchored still counts against the ceiling: its cost if the platform gave
 * one, its list-price estimate otherwise, and unknown (which refuses under a
 * ceiling) when neither is known. The request being run again under its own
 * key is left out, because rerunning it recovers that same render.
 */
function localPendingSpend(records, request) {
  const entries = []
  for (const rec of records) {
    if (!OPEN_STATUSES.includes(rec?.status) || typeof rec.grantId !== 'string') continue
    if (rec.key === renderKey({ ...request, grantId: rec.grantId })) continue
    const billedUsd = finiteNonNegative(rec.costUsdEstimated) ? rec.costUsdEstimated : finiteNonNegative(rec.estimateUsd) ? rec.estimateUsd : null
    entries.push({ id: `local-pending:${rec.key}`, trusted: true, local: true, authorizedUnder: rec.grantId, billedUsd, status: rec.status })
  }
  return entries
}

async function cmdRender(flags, out) {
  const { subject, capability, useClass } = flags
  const territory = flags.territory
  if (flags.execute && flags.at) throw new UsageError('--at decides as of another time and is for dry runs only; it cannot be combined with --execute')
  const at = flags.at ?? new Date().toISOString()
  const seconds = flags.seconds === undefined ? undefined : Number(flags.seconds)
  const inputs = renderInputs(flags)

  if (flags.execute) {
    const check = checkInputs(capability, inputs, { prompt: flags.prompt })
    if (!check.ok) {
      throw new UsageError(check.verified
        ? `${capability} needs ${check.missing.join(' and ')} (pass --${check.missing[0].replace('_', '-')} or --inputs)`
        : `${capability} has no verified input schema; pass its inputs explicitly with --inputs '{…}' or --prompt`)
    }
  }
  const cfg = readConfig()

  // Executing needs Livepeer anyway. A dry run uses it for live prices when the
  // client is installed, unless MANDATE_LIVE_PRICES=0 asks for static prices.
  let LP = null
  let client = null
  if (flags.execute || process.env.MANDATE_LIVE_PRICES !== '0') {
    try {
      LP = await livepeer()
      client = await connectLivepeer(LP)
    } catch (e) {
      if (flags.execute) throw e
    }
  }
  try {
    const price = await priceEstimate(capability, seconds, client, LP)
    const estimatedUsd = price.usd

    out.line(c.bold('\nMandate — consent gate\n'))
    out.line(`  subject     ${subject}`)
    out.line(`  capability  ${capability}`)
    out.line(`  use class   ${useClass}`)
    out.line(`  territory   ${territory ?? c.yellow('not given')}`)
    out.line(`  estimate    ${estimatedUsd == null ? c.yellow(`unknown${price.unit === 'second' && seconds === undefined ? ' (pass --seconds)' : ''}`) : `~$${estimatedUsd.toFixed(4)}`} ${c.dim(`(${price.source}${price.unit === 'second' && seconds ? ` × ${seconds}s` : ''}; not an invoice)`)}`)

    // The producer resolves from its own node: the party that must not be able to vouch for itself.
    const resolver = PRODUCER()
    out.line(c.dim(`\n  resolving from ${resolver.name} (:${resolver.port})…`))
    const k = await readKnowledge(resolver, cfg, { subject })
    out.line(c.dim(`  ${k.grants.length} grant(s), ${k.states.length} revocation(s), ${k.derivations.length} trusted derivation(s), read in ${k.consistency.attempts} attempt(s)`))

    const pending = pendingStore()
    const request = { capability, inputs, prompt: flags.prompt, sourceUrl: flags.sourceUrl, seconds }
    const local = localPendingSpend(pending.list(), request)
    const d = decide({ subject, capability, useClass, territory, at, estimatedUsd }, local.length ? { ...k, derivations: [...k.derivations, ...local] } : k)
    const counted = local.filter(e => k.grants.some(g => g?.subject === subject && g.id === e.authorizedUnder))
    if (counted.length) out.line(c.dim(`  counting ${counted.length} local render(s) not yet recorded on the graph (${counted.map(e => e.status).join(', ')}) against this subject's grants`))
    printForgeries(out, d.forgeries)
    printWarnings(out, d.warnings)
    const localPending = counted.map(e => ({ key: e.id.slice('local-pending:'.length), status: e.status, grantId: e.authorizedUnder, billedUsd: e.billedUsd }))

    if (!d.permit) {
      out.line(c.red(`\n  REFUSED — clause: ${d.clause}`))
      out.line(`  ${clean(d.reason, 400)}`)
      out.line(c.green(`\n  $0 spent${d.spend.estimateUsd == null ? '' : `; ~$${d.spend.estimateUsd.toFixed(4)} not spent (${price.source})`}`) + c.dim(' — the capability was never invoked'))
      out.line(c.dim('  No render was dispatched.\n'))
      out.result({ decision: d, price, localPending })
      return d.clause === 'read-inconsistent' ? EXIT.INCONCLUSIVE : d.clause === 'malformed-request' ? EXIT.USAGE : EXIT.REFUSED
    }

    out.line(c.green(`\n  PERMITTED under ${clean(d.grantId, 200)}`))
    out.line(c.dim(`  published by ${clean(d.publisher, 60)}${d.grantUal ? ` as ${clean(d.grantUal, 200)}` : ''}`))
    if (!flags.execute) {
      out.line(c.dim('\n  --execute not set; stopping before dispatch (no spend).\n'))
      out.result({ decision: d, price, localPending, executed: false })
      return EXIT.OK
    }

    // A render whose derivation would not count, or could not be written, must
    // not be paid for: the ceiling would never see it.
    const producerAddress = agentAddress((await resolver.identity()).agentDid)
    if (!producerAddress || !cfg.trustedProducers.includes(producerAddress)) {
      throw new ConfigError(`the producer node ${producerAddress ?? '(no address)'} is not a trusted producer (MANDATE_TRUSTED_PRODUCERS), so its derivations would not count toward spend; nothing was dispatched`)
    }
    derivationsCgFor(producerAddress)

    const key = renderKey({ grantId: d.grantId, ...request })
    const idempotencyKey = flags.idempotencyKey ?? key
    const record = {
      key, idempotencyKey, status: 'dispatching', createdAt: new Date().toISOString(),
      subject, capability, useClass, territory, seconds: seconds ?? null, inputs, prompt: flags.prompt ?? null, sourceUrl: flags.sourceUrl ?? null,
      grantId: d.grantId, grantUal: d.grantUal, estimateUsd: estimatedUsd, estimateSource: price.source, priceUnit: price.unit ?? null,
    }
    // The same request under the same grant has the same key. A record that
    // holds a running job, billed media or an anchored derivation is never
    // overwritten by a rerun: that would lose the job or record it twice.
    try {
      pending.create(record)
    } catch (e) {
      if (!(e instanceof PendingConflictError)) throw e
      const ex = e.existing
      if (ex.status === 'submitted' && !ex.jobId) {
        // Sent but never answered: rerunning under the same idempotency key is how it is recovered.
        pending.save({ ...record, recoveredFrom: 'submitted without a job id' })
      } else if (ex.status === 'recorded') {
        out.line(c.yellow(`\n  ALREADY RECORDED — this render was made and recorded before (${clean(ex.derivation?.ual ?? 'no UAL', 200)}).`))
        out.line(c.dim('  Nothing was dispatched: rendering it again would bill it and count it against the ceiling twice.\n'))
        out.result({ decision: d, price, executed: false, alreadyRecorded: true, pending: key, mediaUrl: ex.mediaUrl ?? null, derivation: ex.derivation ?? null })
        return EXIT.OK
      } else {
        out.line(c.yellow(`\n  NOT DISPATCHED — pending render ${key} is already ${ex.status}${ex.jobId ? ` (job ${clean(ex.jobId, 60)})` : ''}.`))
        out.line(c.dim(`  Finish it with: mandate record --pending ${key}\n`))
        out.result({ decision: d, price, executed: false, pending: key, status: ex.status, jobId: ex.jobId ?? null })
        return EXIT.RENDER_FAILED
      }
    }

    // The account's own 24h cap is read, never changed. When it cannot be
    // evaluated the render still goes ahead, but the operator is told.
    const spendCap = { checked: false, remainingUsd: null, note: null }
    try {
      const cap = await LP.readSpendCap(client)
      const remaining = cap?.remaining_usd
      if (typeof remaining !== 'number' || !Number.isFinite(remaining)) {
        spendCap.note = 'the spend_cap reply has no numeric remaining_usd, so the account\'s 24h budget was not checked'
      } else if (estimatedUsd == null) {
        spendCap.remainingUsd = remaining
        spendCap.note = 'the cost of this render is unknown, so the account\'s 24h budget was not checked'
      } else if (estimatedUsd > remaining) {
        pending.save({ ...record, status: 'failed', error: 'over the account 24h budget; not dispatched' })
        out.line(c.red(`\n  NOT DISPATCHED — ~$${estimatedUsd.toFixed(4)} exceeds the account's remaining 24h budget of $${remaining.toFixed(2)}.\n`))
        out.result({ decision: d, price, executed: false, spendCap: { checked: true, remainingUsd: remaining, note: null } })
        return EXIT.PAYMENT
      } else {
        Object.assign(spendCap, { checked: true, remainingUsd: remaining })
      }
    } catch (e) {
      spendCap.note = `could not read the account spend cap (${clean(e.message, 120)})`
    }
    if (spendCap.note) out.line(c.dim(`  note: ${spendCap.note}`))

    const describe = await LP.describeCapability(client, capability).catch(() => null)
    const mode = dispatchMode(describe)
    pending.save({ ...(pending.load(key) ?? record), mode })
    out.line(c.dim(`\n  pending render ${key}`))
    out.line(c.dim(`  dispatching ${capability} via run_capability on /api/mcp/raw (${mode}, no model substitution)…`))

    const t0 = Date.now()
    let rendered
    try {
      rendered = await LP.dispatchRender(client, {
        capability, inputs, prompt: flags.prompt, sourceUrl: flags.sourceUrl, idempotencyKey, mode,
        onJob: jobId => { pending.save({ ...(pending.load(key) ?? record), status: 'submitted', jobId }); out.line(c.dim(`  job ${clean(jobId, 60)} queued; polling`)) },
      })
    } catch (e) {
      const saved = pending.load(key) ?? record
      const jobId = e.jobId ?? saved.jobId ?? null
      // A render that may have started may be running and billed. It stays
      // recoverable: by its job id when there is one, by its idempotency key when not.
      const recoverable = e.mayHaveStarted === true || Boolean(jobId)
      pending.save({ ...saved, status: recoverable ? 'submitted' : 'failed', jobId, mayHaveStarted: recoverable, errorKind: e.kind ?? null, error: clean(e.message, 600) })
      out.line(c.red(`\n  RENDER ${recoverable ? 'NOT CONFIRMED' : 'FAILED'} — ${clean(e.message, 400)}`))
      if (jobId) {
        out.line(c.dim(`  job ${clean(jobId, 60)} may still be running or finished; run \`mandate record --pending ${key}\` to collect and record it.`))
      } else if (recoverable) {
        out.line(c.yellow('  The request may have reached Livepeer and be rendering, and billed, now.'))
        out.line(c.dim(`  Re-run the same command: it reuses idempotency key ${idempotencyKey}, so a finished render is returned rather than billed again.`))
      }
      out.line('')
      out.result({ decision: d, price, executed: true, rendered: false, pending: key, recoverable, error: clean(e.message, 600), kind: e.kind ?? null, jobId })
      return e.kind === 'payment' ? EXIT.PAYMENT : e.kind === 'unknown-status' ? EXIT.INCONCLUSIVE : EXIT.RENDER_FAILED
    }
    const renderMs = Date.now() - t0
    pending.save({ ...(pending.load(key) ?? record), status: 'rendered', jobId: rendered.jobId, mediaUrl: rendered.url, servedCapability: rendered.servedCapability, costUsdEstimated: finiteNonNegative(rendered.costUsdEstimated) ? rendered.costUsdEstimated : null, replay: rendered.replay === true, renderMs })
    out.line(c.dim(`  rendered in ${Math.round(renderMs / 1000)}s${rendered.replay ? ' (idempotent replay: not billed again)' : ''}; recording the derivation before releasing the media…`))
    if (rendered.servedCapability !== capability) {
      out.line(c.yellow(`  ⚠ the platform reports ${clean(rendered.servedCapability, 60)} served this render, not ${capability}; it is recorded as served`))
    }
    return await commitDerivation(out, pending, pending.load(key), { decision: d, price, spendCap, localPending })
  } finally {
    await client?.close().catch(() => {})
  }
}

/**
 * What to record as billed. The platform's own cost when it gave one. Otherwise
 * the list-price estimate, but only when it was labelled as a list price and
 * does not scale with a number the operator typed (--seconds): an estimate the
 * operator can shrink must not become the recorded spend. Anything else is
 * recorded as unknown, which refuses later renders under a ceiling — a
 * deliberate trade-off against letting an unknown cost count as small.
 */
function billedFor(rec) {
  if (finiteNonNegative(rec.costUsdEstimated)) return { usd: rec.costUsdEstimated, source: 'Livepeer cost estimate' }
  const labelled = typeof rec.estimateSource === 'string' && /list price/.test(rec.estimateSource)
  const fixedUnit = typeof rec.priceUnit === 'string' && !['second', 'character'].includes(rec.priceUnit)
  if (finiteNonNegative(rec.estimateUsd) && labelled && fixedUnit) return { usd: rec.estimateUsd, source: `estimate (${rec.estimateSource})` }
  return { usd: null, source: 'unknown: the platform reported no cost' }
}

/** Stages at which a derivation publish certainly sent no transaction, so the same asset can be continued. */
const RESUMABLE_STAGES = new Set(['create', 'share', 'author', 'publish'])

/**
 * Why an earlier derivation attempt must not be continued, or null. An asset
 * minted but unbound, or one the node refused to resume, is never published
 * again. After an attempt that may have sent a transaction — or one that died
 * without saying — only states that cannot mint twice are continued: nothing
 * created yet, sealed but not shared, or already published (which resume only
 * verifies).
 */
async function resumeBlock(producer, cg, attempt) {
  if (attempt.stage === 'unbound' || attempt.stage === 'resume-refused') {
    return `the last attempt to record asset ${attempt.name} ended at stage ${attempt.stage}${attempt.ual ? ` (${attempt.ual})` : ''}; publishing it again could mint a second asset`
  }
  if (attempt.mayHaveSent !== true && RESUMABLE_STAGES.has(attempt.stage)) return null
  let d
  try {
    d = await producer.descriptor(attempt.name, cg)
  } catch (e) {
    return `could not read asset ${attempt.name} from ${producer.name} to check it is safe to continue (${e.message})`
  }
  if (d === null && attempt.mayHaveSent !== true) return null
  if (d?.status === 'wm-sealed' || d?.status === 'vm-confirmed') return null
  return `a transaction may already have been sent for asset ${attempt.name} (the node reports ${d?.status ?? 'no such asset'}); publishing it again could mint a second asset`
}

const PRINTABLE = /^[\x21-\x7e]{1,512}$/
const TX_HASH = /^0x[0-9a-fA-F]{64}$/
const STAGE = /^[a-z][a-z-]{0,39}$/

/** Anchor a rendered file's derivation, then — and only then — print its URL. */
async function commitDerivation(out, pending, rec, extra = {}) {
  const producer = PRODUCER()
  let attempt = rec.derivationAttempt?.name ? rec.derivationAttempt : null
  const fail = (e, { blocked = null } = {}) => {
    const stage = blocked ? 'resume-refused' : (typeof e?.stage === 'string' && STAGE.test(e.stage) ? e.stage : 'error')
    const ual = typeof e?.ual === 'string' && PRINTABLE.test(e.ual) ? e.ual : null
    const txHash = typeof e?.txHash === 'string' && TX_HASH.test(e.txHash) ? e.txHash : null
    const mayHaveSent = e?.mayHaveSent === true
    const message = blocked ?? e?.message
    if (attempt && !blocked) {
      try { rec = pending.noteDerivationAttempt(rec.key, { stage, ual, txHash, mayHaveSent }) } catch { /* keep what is already saved */ }
    }
    const saved = { ...(pending.load(rec.key) ?? rec), status: 'rendered', error: clean(message, 600), stage }
    pending.save(saved)
    const known = saved.derivationAttempt ?? {}
    const stuck = blocked || stage === 'unbound' || stage === 'resume-refused' || known.mayHaveSent === true
    out.line(c.red(`\n  DERIVATION ${blocked ? 'NOT RETRIED' : 'FAILED TO COMMIT'} — treating this render as failed.`))
    out.line(c.red(`  ${clean(message, 400)}`))
    if (known.name) out.line(c.dim(`  asset ${clean(known.name, 120)}${known.ual ? `  UAL ${clean(known.ual, 200)}` : ''}${known.txHash ? `  tx ${clean(known.txHash, 70)}` : ''}`))
    if (known.mayHaveSent) out.line(c.yellow('  A transaction may have been sent. Check the node before doing anything else.'))
    out.line(c.dim('  The render exists and was billed, so its URL is withheld until it is recorded.'))
    out.line(c.dim(stuck
      ? `  \`mandate record --pending ${rec.key}\` will not publish this asset again until the node shows it sealed or published.\n`
      : `  Retry with: mandate record --pending ${rec.key}\n`))
    out.result({
      ...extra, executed: true, rendered: true, derivation: null, pending: rec.key, error: clean(message, 600), stage,
      asset: known.name ?? null, derivationId: known.id ?? null, ual: known.ual ?? null, txHash: known.txHash ?? null, mayHaveSent: known.mayHaveSent === true,
    })
    return EXIT.DERIVATION_FAILED
  }

  try {
    const address = agentAddress((await producer.identity()).agentDid)
    const cg = derivationsCgFor(address)
    const sha = await hashUrl(rec.mediaUrl)

    // An idempotent replay returns a render the platform already billed. If a
    // trusted producer already recorded it, recording it again would count its
    // spend twice, so the existing edge is used instead.
    if (rec.replay === true) {
      const k = await readKnowledge(producer, readConfig(), { grantId: rec.grantId })
      if (!k.consistency.ok) throw withExit(new Error(`cannot tell whether this replayed render is already recorded: ${k.consistency.reason}`), EXIT.DERIVATION_FAILED)
      const existing = k.derivations.find(x => x?.trusted === true && x.authorizedUnder === rec.grantId && ((rec.jobId && x.jobId === rec.jobId) || x.outputSha256 === sha))
      if (existing) {
        const derivation = { id: existing.id, ual: existing.ual ?? null, txHash: null, outputSha256: existing.outputSha256, existing: true }
        pending.save({ ...rec, status: 'recorded', derivation })
        out.line(c.green(`\n  RENDERED  ${clean(rec.mediaUrl, 400)}`))
        out.line(c.dim(`  an idempotent replay of a render already recorded as ${clean(existing.ual ?? existing.id, 200)}; not recorded or counted again`))
        out.line('')
        out.result({ ...extra, executed: true, rendered: true, replay: true, pending: rec.key, mediaUrl: rec.mediaUrl, jobId: rec.jobId ?? null, derivation })
        return EXIT.OK
      }
    }

    let resume = false
    if (attempt) {
      const blocked = await resumeBlock(producer, cg, attempt)
      if (blocked) return fail(null, { blocked })
      resume = true
    } else {
      const nonce = nonce16()
      attempt = { id: `urn:mandate:derivation:${sha.slice(0, 16)}:${nonce}`, name: `derivation-${sha.slice(0, 16)}-${nonce}` }
      // Saved before publishing, so a crash mid-publish still leaves the name a retry must reuse.
      rec = pending.noteDerivationAttempt(rec.key, { ...attempt, stage: 'started' })
    }

    const billed = billedFor(rec)
    const servedCapability = rec.servedCapability ?? rec.capability
    const r = await recordDerivation(producer, cg, {
      outputSha256: sha, servedCapability, authorizedUnder: rec.grantId, billedUsd: billed.usd, jobId: rec.jobId ?? null,
      id: attempt.id, name: attempt.name, resume, expectAuthor: address,
    })
    rec = pending.noteDerivationAttempt(rec.key, { stage: 'recorded', ual: PRINTABLE.test(r.ual ?? '') ? r.ual : null, txHash: TX_HASH.test(r.txHash ?? '') ? r.txHash : null })
    const derivation = { id: r.id, name: r.name, ual: r.ual, txHash: r.txHash ?? null, outputSha256: r.outputSha256, resumed: r.resumed === true }
    pending.save({ ...rec, status: 'recorded', derivation })
    out.line(c.green(`\n  RENDERED  ${clean(rec.mediaUrl, 400)}`))
    out.line(`  derivation  ${r.id}${r.resumed ? c.dim('  (finished an earlier attempt)') : ''}`)
    out.line(`  sha256      ${r.outputSha256}`)
    out.line(`  capability  ${clean(servedCapability, 64)}`)
    out.line(`  billed      ${billed.usd == null ? c.yellow('unknown') : `~$${billed.usd}`} ${c.dim(`(${billed.source})`)}`)
    anchoredLines(out, r)
    out.line('')
    out.result({
      ...extra, executed: true, rendered: true, pending: rec.key, mediaUrl: rec.mediaUrl, jobId: rec.jobId ?? null,
      servedCapability, billedUsd: billed.usd, billedUsdSource: billed.source,
      derivation: { ...derivation, explorer: txLink(r.ual, r.txHash) },
    })
    return EXIT.OK
  } catch (e) {
    return fail(e)
  }
}

/** Finish a render whose derivation did not commit, or list the ones waiting. */
async function cmdRecord(flags, out) {
  const pending = pendingStore()
  if (!flags.pending) {
    // A render is released only once recorded, so an unrecorded one's media URL is not listed.
    const open = pending.list().filter(r => r.status !== 'recorded').map(({ mediaUrl, ...r }) => ({ ...r, hasMedia: Boolean(mediaUrl) }))
    out.line(c.bold(`\n${open.length} pending render(s)\n`))
    for (const r of open) out.line(`  ${r.key}  ${clean(r.status, 20).padEnd(11)} ${clean(r.capability, 64)}  ${clean(r.jobId ?? '', 60)}  ${c.dim(clean(r.createdAt, 40))}`)
    out.line('')
    out.result({ pending: open })
    return EXIT.OK
  }
  let rec = pending.load(flags.pending)
  if (!rec) throw new UsageError(`no pending render ${flags.pending} in ${pending.dir}`)
  if (rec.status === 'recorded') {
    out.line(c.dim(`\n  already recorded: ${clean(rec.derivation?.ual, 200)}\n`))
    out.result({ ...rec })
    return EXIT.OK
  }
  if (!rec.mediaUrl) {
    if (!rec.jobId) {
      const unknown = rec.status === 'dispatching' || (rec.status === 'submitted' && rec.mayHaveStarted !== false)
      if (unknown) {
        out.line(c.yellow(`\n  ${rec.key} was sent to Livepeer but no answer was saved (${clean(rec.error ?? rec.status, 200)}).`))
        out.line(c.yellow('  It may have rendered and been billed. Its outcome is unknown.'))
        out.line(c.dim(`  Re-run the same \`mandate render --execute\` command: it reuses idempotency key ${clean(rec.idempotencyKey ?? rec.key, 80)}, so a finished render is returned rather than billed again.\n`))
        const { mediaUrl, ...shown } = rec
        out.result({ ...shown, outcome: 'unknown', rerun: true })
        return EXIT.INCONCLUSIVE
      }
      out.line(c.red(`\n  ${rec.key} never produced a job or media (${clean(rec.error ?? rec.status, 200)}); nothing to record.\n`))
      out.result({ ...rec })
      return EXIT.RENDER_FAILED
    }
    const LP = await livepeer()
    const client = await connectLivepeer(LP)
    try {
      const done = await LP.pollJob(client, rec.jobId, { inputUrls: [rec.sourceUrl, rec.inputs], maxWaitMs: 10 * 60_000 })
      const servedCapability = LP.served(done.structured, done.capability ?? rec.capability)
      const cost = done.structured?.cost_usd_estimated
      pending.save({ ...rec, status: 'rendered', mediaUrl: done.url, servedCapability, costUsdEstimated: finiteNonNegative(cost) ? cost : null })
      if (servedCapability !== rec.capability) {
        out.line(c.yellow(`  ⚠ the platform reports ${clean(servedCapability, 60)} served this render, not ${clean(rec.capability, 60)}; it is recorded as served`))
      }
    } catch (e) {
      pending.save({ ...rec, error: clean(e.message, 600), errorKind: e.kind ?? null })
      out.line(c.red(`\n  job ${clean(rec.jobId, 60)}: ${clean(e.message, 300)}\n`))
      const { mediaUrl, ...shown } = rec
      out.result({ ...shown, error: clean(e.message, 600), kind: e.kind ?? null })
      return e.kind === 'payment' ? EXIT.PAYMENT : e.kind === 'unknown-status' ? EXIT.INCONCLUSIVE : e.kind === 'timeout' ? EXIT.INCONCLUSIVE : EXIT.RENDER_FAILED
    } finally {
      await client.close().catch(() => {})
    }
    rec = pending.load(rec.key)
  }
  return commitDerivation(out, pending, rec)
}

/**
 * Capture a consent clip and check what was said against what is requested.
 * Contradictions, a missing first-person consent and a failed transcription
 * are never overridable. Other missing terms are, with --force, where the
 * command allows it.
 */
async function captureAndCheck(flags, out, requested, { allowForce = false } = {}) {
  await livepeer()
  const { captureConsent, consentScript } = await import('../src/consent.mjs')
  const force = allowForce && flags.force
  out.line(c.bold('\nConsent capture\n'))
  out.notice('  Ask the person being depicted to record themselves saying, in their own words, something like:')
  out.notice(c.bold(`\n    "${consentScript(requested)}"\n`))
  const kind = flags.consentKind ?? 'video'
  let r
  try {
    r = await captureConsent({
      requested, kind,
      onLink: (url, { expiresAt }) => {
        out.notice(`  Open this on their phone (records ${kind}; valid until ${clean(expiresAt, 40)}):`)
        out.notice(c.bold(`    ${clean(url, 300)}`))
        out.notice(c.dim('  Waiting for the upload…'))
      },
      onPending: ({ polls, remainingMs }) => { if (polls % 6 === 0) out.notice(c.dim(`  still waiting (${Math.round(remainingMs / 60000)} min left)`)) },
    })
  } catch (e) {
    throw withExit(e, e instanceof UsageError ? EXIT.USAGE : e instanceof FetchBytesError ? EXIT.INCONCLUSIVE : livepeerExit(e))
  }
  const summary = { captured: r.captured, sha256: r.sha256 ?? null, bytes: r.bytes ?? null, mime: r.mime ?? null, transcript: r.transcript ?? null, asrError: r.asrError ?? null, scope: r.scope ?? null }
  if (!r.captured) {
    out.line(c.red('\n  No clip arrived before the link expired. Nothing was granted.\n'))
    return { code: EXIT.CONSENT_UNCONFIRMED, summary }
  }
  out.line(c.green(`\n  clip received  sha256 ${r.sha256}  (${r.bytes} bytes)`))
  if (r.asrError || !r.scope) {
    out.line(c.red(`  transcription failed: ${clean(r.asrError ?? 'no transcript', 300)}`))
    out.line(c.dim(`  The spoken scope could not be checked, and --force does not override that.${kind === 'video' ? ' Re-record; audio only (--consent-kind audio) may transcribe more reliably.' : ' Re-record.'}\n`))
    return { code: EXIT.CONSENT_UNCONFIRMED, summary }
  }
  out.notice(`\n  transcript  "${clean(r.transcript, 1200)}"\n`)
  for (const chk of r.scope.checks) {
    const mark = chk.contradicted ? c.red('✗ contradicted') : chk.matched ? c.green('✓ said') : c.yellow('? not said')
    // Shown on stderr too in --json mode: a person confirming the clip needs them.
    out.notice(`    ${mark.padEnd(24)} ${chk.kind.padEnd(10)} ${chk.term}${chk.heard?.length ? c.dim(`  (heard: ${chk.heard.map(h => clean(h, 40)).join(', ')})`) : ''}`)
    for (const n of Array.isArray(chk.notes) ? chk.notes : []) out.notice(c.dim(`        ${clean(n, 200)}`))
  }
  if (r.scope.contradicted.length) {
    out.line(c.red(`\n  CONTRADICTED — the clip says no to: ${r.scope.contradicted.join(', ')}. This cannot be overridden.\n`))
    return { code: EXIT.CONSENT_CONTRADICTED, summary }
  }
  // Without an affirmative first-person "I consent", nothing else said is consent.
  if (r.scope.affirmative !== true) {
    out.line(c.red('\n  NO CONSENT SAID — the clip has no affirmative first-person consent ("I consent", "I agree", "I give permission"). --force does not override this.\n'))
    return { code: EXIT.CONSENT_UNCONFIRMED, summary }
  }
  let forced = false
  if (r.scope.missing.length) {
    out.line(c.yellow(`\n  Not said: ${r.scope.missing.join(', ')}.`))
    if (!force) {
      out.line(c.yellow(`  Re-record, narrow the request${allowForce ? ', or pass --force after reviewing the clip' : ''}.\n`))
      return { code: EXIT.CONSENT_UNCONFIRMED, summary }
    }
    forced = true
    out.line(c.yellow('  --force: continuing. The transcript above is what was actually said.'))
  }
  if (Array.isArray(r.scope.unchecked) && r.scope.unchecked.length) {
    out.line(c.yellow(`  Not checked against the words: ${r.scope.unchecked.join(', ')}.`))
  }
  return { code: EXIT.OK, consent: r, summary, forced }
}

async function cmdConsent(flags, out) {
  const requested = { capability: flags.capability ?? [], useClass: flags.useClass, territory: flags.territory ?? [] }
  const r = await captureAndCheck(flags, out, requested)
  out.result(r.summary)
  if (r.code === EXIT.OK) {
    const unchecked = r.consent.scope.unchecked ?? []
    out.line(c.green('  Every requested term was said.'))
    if (unchecked.length) out.line(c.yellow(`  The words were not checked against: ${unchecked.join(', ')}. Confirm these with the person before granting.\n`))
    else out.line('')
  }
  return r.code
}

/** The third-party check: a file, the configured graphs, and neither party's word. */
async function cmdVerify(flags, out) {
  if (Boolean(flags.url) === Boolean(flags.sha256)) throw new UsageError('verify needs exactly one of --url or --sha256')
  let role = flags.node ?? 'verifier'
  let node = role === 'grantor' ? GRANTOR() : role === 'producer' ? PRODUCER() : VERIFIER()
  let label
  if (role === 'verifier' && !node) {
    // Asked for by name, a verifier that does not exist is an error, not a quiet fallback.
    if (flags.node) throw new ConfigError('--node verifier was given, but no verifier node is configured (set MANDATE_VERIFIER_PORT)')
    node = GRANTOR()
    role = 'grantor'
    label = "the grantor's node (no verifier node configured) — independent of the producer, not of the grantor"
  } else {
    label = role === 'verifier' ? 'an independent read-only node'
      : role === 'grantor' ? "the grantor's node — independent of the producer, not of the grantor"
        : "the producer's own node — not independent of the producer"
  }
  const cfg = readConfig()

  out.line(c.bold('\nThird-party verification\n'))
  if (flags.url) out.line(`  file      ${clean(flags.url, 120)}`)
  out.line(c.dim(`  reading   ${node.name} — ${label}`))
  const sha256 = flags.sha256 ?? await hashUrl(flags.url)
  out.line(`  sha256    ${sha256}`)

  const k = await readKnowledge(node, cfg, { sha256 })
  const r = verifyKnowledge(k, sha256)
  printForgeries(out, r.forgeries)
  printWarnings(out, r.warnings)
  if (r.untrusted.length) out.line(c.dim(`  ${r.untrusted.length} edge(s) from untrusted publishers shown but not believed`))
  const paint = r.verdict === CLEAR ? c.green : r.verdict === TAINTED ? c.red : c.yellow
  out.line(paint(`\n  ${r.verdict}${r.subStatus ? ` / ${r.subStatus}` : ''}`))
  out.line(`  ${clean(r.reason, 400)}\n`)
  out.result({ ...r, node: node.name, nodeRole: role })
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
  const r = blastRadius(grantId, k.derivations, k.forgeries)
  out.line(c.bold(`\nQuarantine list for ${grantId}\n`))
  printWarnings(out, k.warnings)
  out.line(`  grant   ${grant ? `${clean(grant.ual, 200)}  ${rev.revoked ? c.red('revoked') : c.green('live')}` : c.yellow('not found in the grants graph')}`)
  out.line(`  assets  ${r.assets.length} ${c.dim('(recorded by trusted producers; exact bytes only — a re-encoded copy has another hash)')}`)
  for (const a of r.assets) out.line(`    ${a.outputSha256.slice(0, 16)}…  ${clean(a.servedCapability, 64)}  ${c.dim(clean(a.ual, 200))}`)
  if (r.unreadable) out.line(c.red(`  unreadable  ${r.unreadable} trusted record(s) under this grant could not be read (their files are unknown)`))
  out.line(`  billed  ${r.billedUnknown ? c.yellow('unknown') : `~$${r.totalBilledUsd.toFixed(4)}`} ${c.dim('(as recorded by producers; not an invoice)')}\n`)
  out.result({ grantId, grant, revoked: rev?.revoked ?? null, ...r })
  return EXIT.OK
}

const COMMAND_FNS = {
  status: cmdStatus, grant: cmdGrant, revoke: cmdRevoke, render: cmdRender,
  consent: cmdConsent, verify: cmdVerify, 'blast-radius': cmdBlastRadius, record: cmdRecord,
}

/**
 * Exit code for an error that reached the top. 1 is kept for mistakes the
 * operator makes in flags or configuration; an unreachable node, an
 * unreadable token or local state, a media download that failed and a
 * Livepeer failure are not usage errors.
 */
function exitFor(e) {
  if (e?.[EXIT_CODE] !== undefined) return e[EXIT_CODE]
  if (e instanceof UsageError || e instanceof TermError || e instanceof ConfigError) return EXIT.USAGE
  if (e instanceof DkgWriteError) return ['unbound', 'publish', 'publish-transport', 'resume-refused'].includes(e.stage) ? EXIT.DKG_ANCHOR_FAILED : EXIT.DKG_WRITE_FAILED
  if (e instanceof DkgHttpError || e instanceof ReadTruncatedError || e instanceof FetchBytesError) return EXIT.INCONCLUSIVE
  if (e instanceof NodeTokenError || e instanceof StateReadError) return EXIT.INCONCLUSIVE
  const kind = e?.constructor?.name
  if (kind === 'RenderError') return e.kind === 'payment' ? EXIT.PAYMENT : e.kind === 'unknown-status' ? EXIT.INCONCLUSIVE : EXIT.RENDER_FAILED
  if (kind === 'LivepeerToolError' || kind === 'ConsentError') return livepeerExit(e)
  return EXIT.USAGE
}

function version() {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return 'unknown'
  }
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
  if (flags.version) {
    console.log(`mandate ${version()}`)
    return EXIT.OK
  }
  if (!command || flags.help) {
    console.log(helpText(command))
    return EXIT.OK
  }
  const out = makeOutput({ json: flags.json })
  const prompter = makePrompter(out)
  try {
    return await COMMAND_FNS[command](flags, out, prompter)
  } catch (e) {
    const code = exitFor(e)
    if (out.json) {
      console.log(JSON.stringify({ error: clean(e.message, 1000), stage: e.stage ?? null, ual: e.ual ?? null, txHash: e.txHash ?? null, mayHaveSent: e.mayHaveSent ?? false, exitCode: code }, null, 2))
    } else {
      console.error(c.red(`\n  ${clean(e.message, 1000)}`))
      if (e instanceof DkgWriteError) {
        console.error(c.red(`  stage: ${clean(e.stage, 40)}`))
        if (e.assetName) console.error(`  asset: ${clean(e.assetName, 200)}`)
        if (e.ual) console.error(`  UAL: ${clean(e.ual, 300)}`)
        if (e.txHash) console.error(`  tx:  ${clean(e.txHash, 100)}${txLink(e.ual, e.txHash) ? `  ${txLink(e.ual, e.txHash)}` : ''}`)
        if (e.mayHaveSent) console.error(c.yellow('  A transaction may have been sent. Check the node before retrying.'))
      }
      console.error('')
    }
    return code
  } finally {
    prompter.close()
  }
}

process.exitCode = await main(process.argv.slice(2))
