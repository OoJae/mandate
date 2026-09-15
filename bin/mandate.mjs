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
  readConfig, envLoad, loadMandateEnv, trustedProducers, ConfigError,
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
import { renderKey, pendingStore, mayBeBilled, FAILED_CONFIRMED, PendingConflictError, PendingInvariantError, PendingReadError } from '../src/pending.mjs'
import { StateReadError } from '../src/state-store.mjs'

/**
 * The longest transcript a person is asked to review, in characters after
 * control characters are stripped. A transcript is always shown in full when a
 * person must confirm it; one longer than this is refused (re-record) rather
 * than cut, because nobody can be asked to confirm words they were not shown,
 * and a consent statement never needs this many.
 */
const TRANSCRIPT_REVIEW_MAX = 4000
/**
 * For a transcript far longer than the script, src/scope.mjs does not align it
 * and lists only the first 50 words outside the script. A list that long may
 * be cut, so it is refused like an over-long transcript rather than shown in part.
 */
const EXTRA_WORDS_REVIEW_MAX = 49

/** Untrusted words for a person to review: every character kept except controls, with line breaks and tabs as spaces. */
const reviewText = v => clean(v, Infinity).replace(/[\t\n]+/g, ' ')

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

/**
 * A grant or revocation write that failed. The ids are generated before the
 * write, so they are always reported: when the outcome is unknown (a
 * transaction may have been sent) the operator needs the exact id to check,
 * and to revoke, the write that may still land, rather than publishing a
 * second one under a new id and losing track of the first.
 */
function writeFailed(out, e, { what, ids, assetName, contextGraphId, node, check, checkHow, extra = {} }) {
  const code = exitFor(e)
  const unknown = e.mayHaveSent === true
  const ual = typeof e.ual === 'string' && PRINTABLE.test(e.ual) ? e.ual : null
  const txHash = typeof e.txHash === 'string' && TX_HASH.test(e.txHash) ? e.txHash : null
  const stage = typeof e.stage === 'string' && STAGE.test(e.stage) ? e.stage : 'error'
  out.line(c.red(`\n  ${what.toUpperCase()} ${unknown ? 'OUTCOME UNKNOWN' : 'NOT PUBLISHED'} — ${clean(e.message, 400)}`))
  for (const [k, v] of Object.entries(ids)) out.line(`  ${k.padEnd(11)} ${v}`)
  out.line(`  asset       ${assetName} on ${clean(node, 60)}`)
  out.line(c.dim(`  stage       ${stage}`))
  if (ual) out.line(`  UAL         ${clean(ual, 300)}`)
  if (txHash) out.line(`  tx          ${txHash}`)
  if (unknown) {
    out.line(c.yellow(`\n  A transaction may have been sent, so this ${what} may still land on-chain. Do not publish it again under a new id.`))
    out.line(`  Check whether it landed: ${check}`)
    out.line(c.dim(`  That ${checkHow}\n`))
  } else {
    out.line('')
  }
  out.result({
    ...extra, outcome: unknown ? 'unknown' : 'failed', error: clean(e.message, 600), stage, ...ids, assetName, contextGraphId,
    ual, txHash, mayHaveSent: unknown, check: unknown ? check : null, exitCode: code,
  })
  return code
}

/**
 * Print, and return for the result, the configuration a command runs under:
 * which env file was loaded (or none), the resolved Mandate home (local state
 * and pending renders), the trusted producers and graphs in effect, and a
 * visible warning when the freshness check is off.
 */
function configInEffect(out, cfg = null) {
  const settle = get => { try { return { value: get(), error: null } } catch (e) { return { value: null, error: String(e.message).split('\n')[0] } } }
  const grants = cfg ? { value: cfg.grantsCgs, error: null } : settle(grantsCgs)
  const derivs = cfg ? { value: cfg.derivationsCgs, error: null } : settle(derivationsCgs)
  const trusted = cfg ? { value: cfg.trustedProducers, error: null } : settle(trustedProducers)
  const checkFreshness = cfg ? cfg.checkFreshness === true : process.env.MANDATE_CHECK_FRESHNESS !== '0'
  out.line(envLoad.path
    ? c.dim(`  env file           ${clean(envLoad.path, 300)} (${envLoad.source}; ${envLoad.loaded.length} key(s) set from it${envLoad.loaded.length ? `: ${envLoad.loaded.join(', ')}` : ''})`)
    : c.dim(`  env file           none (looked for ${clean(envLoad.searched ?? '', 300)}; a .env in the working directory is never read)`))
  if (envLoad.ignored.length) out.line(c.dim(`  env file: ignored ${envLoad.ignored.join(', ')} (only MANDATE_* and LIVEPEER_AGENT_KEY are read)`))
  // Where local state and pending renders live: two runs that print different
  // homes do not share revocations seen, pending spend or locks.
  out.line(c.dim(`  mandate home       ${clean(envLoad.home ?? '', 300)} (local state, pending renders and their locks)`))
  for (const [label, got] of [['trusted producers', trusted], ['grants graphs', grants], ['derivations graphs', derivs]]) {
    out.line(got.error ? c.yellow(`  ${label.padEnd(18)} ${clean(got.error, 300)}`) : c.dim(`  ${label.padEnd(18)} ${got.value.map(v => clean(v, 120)).join(', ') || 'none'}`))
  }
  if (!checkFreshness) {
    out.notice(c.yellow('  ⚠ FRESHNESS CHECK OFF (MANDATE_CHECK_FRESHNESS=0): nodes are not compared with the chain, so a node that is behind can miss a revocation and nothing here would show it'))
  }
  return {
    envFile: envLoad.path, envFileSource: envLoad.path ? envLoad.source : null, envFileSearched: envLoad.searched, envKeysLoaded: [...envLoad.loaded], envFileWarnings: [...envLoad.warnings],
    mandateHome: envLoad.home,
    trustedProducers: trusted.value, grantsCgs: grants.value, derivationsCgs: derivs.value, checkFreshness,
  }
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
  const config = configInEffect(out)
  out.result({ nodes: rows, config })
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
  // Checked before the --yes rule, so a consent grant off a terminal is always
  // exit 3 (consent cannot be confirmed), with or without --yes.
  if (flags.withConsent && !prompter.possible()) {
    const reason = 'a consent clip must be confirmed by a person typing at a terminal, and --yes does not skip that; run this from a terminal'
    out.line(c.red(`\n  NOT STARTED — ${reason}. No clip was requested and nothing was published.\n`))
    out.result({ granted: false, reason: 'consent confirmation impossible', detail: reason })
    return EXIT.CONSENT_UNCONFIRMED
  }
  if (!flags.yes && (!prompter.possible() || out.json)) throw new UsageError('not on a terminal: pass --yes to publish without confirmation')
  // What the consent script never says (an unrestricted territory, no ceiling)
  // needs a typed answer even after a perfect reading of it, and --json cannot
  // give one: known now, so no clip is requested or paid to transcribe.
  const alwaysAsked = flags.withConsent ? consentQuestions({ scope: { unchecked: ['validity', 'ceiling'] } }, grant, true) : []
  if (alwaysAsked.length && out.json) {
    const reason = `the consent script never covers ${alwaysAsked.map(q => q.item).join(', ')}, so a person must confirm ${alwaysAsked.length > 1 ? 'those' : 'that'} by typing at a terminal without --json; --yes does not skip it`
    out.line(c.red(`\n  NOT STARTED — ${reason}. No clip was requested and nothing was published.\n`))
    out.result({ granted: false, reason: 'consent confirmation impossible', detail: reason })
    return EXIT.CONSENT_UNCONFIRMED
  }

  let consent = null
  let consentSummary = null
  if (flags.withConsent) {
    await livepeer()
    // The one object both the printed script and the transcript check are built
    // from: a different object would compare the words with another script.
    const requested = { capability: flags.capability, useClass: permitted, territory: grant.territory, validUntil, maxSpendUsd: grant.maxSpendUsd }
    const r = await captureAndCheck(flags, out, requested, { allowForce: true })
    consentSummary = r.summary
    if (r.code !== EXIT.OK) {
      out.result({ granted: false, consent: r.summary })
      return r.code
    }
    // A recording answers one capture. The same clip (a replay, or the file kept
    // from an earlier grant, revoked or not) is refused, so withdrawn consent is
    // never republished as fresh. Checked against this grantor's anchored grants;
    // a grant confirmed by hand carries no clip hash and cannot be matched.
    const reuse = await clipAlreadyUsed(grantor, subject, r.consent?.sha256)
    if (reuse.code !== EXIT.OK) {
      out.line((reuse.code === EXIT.INCONCLUSIVE ? c.yellow : c.red)(`\n  NOT PUBLISHED — ${reuse.reason}. Nothing was published.\n`))
      out.result({ granted: false, reason: reuse.code === EXIT.INCONCLUSIVE ? 'consent clip reuse not checked' : 'consent clip reused', detail: reuse.reason, usedBy: reuse.usedBy, consent: r.summary })
      return reuse.code
    }
    const questions = consentQuestions(r.consent, grant, r.scriptMatched)
    if (questions.length && (!prompter.possible() || out.json)) {
      const reason = r.scriptMatched
        ? `the words never covered ${questions.map(q => q.item).join(', ')}, so a person must confirm ${questions.length > 1 ? 'those' : 'that'} by typing at a terminal without --json; --yes does not skip it`
        : 'the words are not a reading of the consent script, so a person must confirm them by typing at a terminal without --json; --yes does not skip that'
      out.line(c.red(`\n  NOT CONFIRMED — ${reason}. Nothing was published.\n`))
      out.result({ granted: false, reason: 'consent confirmation impossible', detail: reason, consent: r.summary })
      return EXIT.CONSENT_UNCONFIRMED
    }
    if (!await confirmConsent(out, prompter, questions, grant, r)) {
      out.line(c.red('\n  Not confirmed. Nothing was published.\n'))
      out.result({ granted: false, reason: 'consent not confirmed', consent: r.summary })
      return EXIT.CONSENT_UNCONFIRMED
    }
    consent = r.consent
    // Only a reading of the consent script carries the clip hash: on the graph,
    // a grant with a clip hash always means the words were checked by the closed
    // script match. A grant a person confirmed by hand, forced or not, is
    // published without it; the hash stays in this command's result.
    // Deliberate trade-off: that grant loses its link to the clip.
    grant.consentClipSha256 = r.scriptMatched ? consent.sha256 : null
    consentSummary = { ...r.summary, forced: r.forced, scriptMatched: r.scriptMatched, confirmedBy: r.scriptMatched ? 'script' : 'operator', publishedClipHash: grant.consentClipSha256 !== null }
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
  if (consent) out.line(`  consent clip ${grant.consentClipSha256 ?? c.yellow(`not attached (not a reading of the consent script; confirmed by the operator; clip sha256 ${consent.sha256})`)}`)
  out.line(c.dim(`  graph        ${cg}`))
  out.line(c.dim(`\n  Publishing to Verifiable Memory is permanent and costs gas on ${grantor.name}.`))
  await confirm(flags, out, prompter, '\n  Publish this grant?', subject.split(':')[1])

  const assetName = `grant-${subject.split(':')[1]}-${nonce}`
  out.line(c.dim(`\n  sealing, sharing and anchoring ${assetName} on ${grantor.name}…`))
  let r
  try {
    r = await grantor.sealShareAnchor({ name: assetName, contextGraphId: cg, quads, expectAuthor: address })
  } catch (e) {
    if (!(e instanceof DkgWriteError)) throw e
    return writeFailed(out, e, {
      what: 'grant', ids: { grantId: grant.id }, assetName, contextGraphId: cg, node: grantor.name,
      // The check only reads: a command that revokes once the grant has landed is never offered as a check.
      check: `mandate blast-radius --grant ${grant.id}`,
      checkHow: `only reads the grants graph (from the producer node, which may lag the grantor): "not found in the grants graph" means it has not landed or not synced yet, so check again later; a UAL means it landed. To end a grant that landed, run \`mandate revoke --id ${grant.id}\`.`,
      extra: { granted: false, grant, consent: consentSummary },
    })
  }
  out.line(c.green(`\n  GRANTED  ${grant.id}`))
  anchoredLines(out, r)
  out.line(c.dim('\n  Renew by publishing a new grant; a revocation ends this one for good.\n'))
  out.result({ granted: true, grant, contextGraphId: cg, ual: r.ual, txHash: r.txHash, name: r.name, explorer: txLink(r.ual, r.txHash), consent: consentSummary })
  return EXIT.OK
}

/**
 * Whether a consent clip already backs a grant this grantor anchored, as
 * { code, reason, usedBy }: OK when it does not, CONSENT_UNCONFIRMED when it
 * does, INCONCLUSIVE when the grants graph could not be read completely (a clip
 * that cannot be shown unused is not published).
 */
async function clipAlreadyUsed(grantor, subject, sha256) {
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
    return { code: EXIT.INCONCLUSIVE, reason: 'the consent clip has no usable sha256, so it cannot be checked against earlier grants', usedBy: [] }
  }
  const k = await readKnowledge(grantor, readConfig(), { subject })
  if (!k.consistency.ok) {
    return { code: EXIT.INCONCLUSIVE, reason: `cannot check whether this consent clip already backs a grant: ${clean(k.consistency.reason, 300)}`, usedBy: [] }
  }
  const usedBy = k.grants.filter(g => g?.consentClipSha256 === sha256).map(g => ({ id: g.id, subject: g.subject, ual: g.ual ?? null, revoked: revocationOf(g, k.states).revoked === true }))
  if (!usedBy.length) return { code: EXIT.OK, reason: null, usedBy }
  return {
    code: EXIT.CONSENT_UNCONFIRMED,
    reason: `this consent clip (sha256 ${sha256}) already backs grant ${clean(usedBy[0].id, 200)}${usedBy[0].revoked ? ', which was revoked' : ''}; a recording is consent for the capture it was made for, never for a new grant. Record a new clip`,
    usedBy,
  }
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
 * What a person still has to confirm by typing, as { item, text, expect }.
 *
 * A reading of the consent script needs nothing about its words: the script
 * names the capabilities, use classes, territories, the end date and a ceiling
 * when there is one. What it never says still needs a person: no ceiling at
 * all, and an unrestricted territory. Anything that is not a reading of the
 * script needs the whole confirmation: that the transcript is what the clip
 * says, that it is consent to exactly these terms, and every term the words
 * were not checked against.
 */
function consentQuestions(r, grant, scriptMatched) {
  const unchecked = [...new Set([...(Array.isArray(r.scope?.unchecked) ? r.scope.unchecked : ['validity', 'ceiling']),
    ...(grant.territory.length ? [] : ['territory-unrestricted'])])]
  const saidByScript = item => (item === 'validity' && Boolean(grant.validUntil)) || (item === 'ceiling' && grant.maxSpendUsd != null)
  const items = scriptMatched ? unchecked.filter(i => !saidByScript(i)) : unchecked
  const questions = scriptMatched ? [] : [
    { item: 'transcript', text: 'the transcript above is what the person says in the clip', expect: 'matches' },
    { item: 'meaning', text: 'the person consents to exactly the terms above, with no condition, exclusion, coercion or retraction anywhere in the clip', expect: 'consents' },
  ]
  return [...questions, ...items.map(item => ({ item, ...uncheckedItem(item, grant) }))]
}

/**
 * The confirmation a person gives after watching the clip. Not skippable by
 * --yes or --force: a transcript that is not the consent script was never
 * checked by anything but heuristics, which can surface a refusal but never
 * confirm consent.
 */
async function confirmConsent(out, prompter, questions, grant, r) {
  if (!questions.length) return true
  out.notice(c.bold('\n  Confirm the consent clip. --yes does not skip this.'))
  if (!r.scriptMatched) {
    out.notice(c.yellow('  The words are not a reading of the consent script, so nothing about them was confirmed automatically. Watch the clip.'))
    if (r.forced) out.notice(c.yellow('  --force: the heuristics did not hear every requested term.'))
    out.notice(c.yellow('  A grant confirmed here is published without the clip hash.'))
  }
  for (const q of questions) {
    const label = ['transcript', 'meaning'].includes(q.item) ? 'CONFIRM' : 'NOT CHECKED against the words'
    out.notice(c.yellow(`\n  ${label} — ${q.text}`))
    const got = await prompter.ask(`  Is that right? Type ${c.bold(q.expect)}: `)
    if (got !== q.expect) return false
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
  // Only a revocation other nodes can see ends the grant for them: one anchored
  // in Verifiable Memory (or remembered from this machine's own anchor). A row
  // only in this node's merged view (tier context) is not, so it is published.
  const visible = existing.all.filter(s => s?.tier === 'vm')
  if (existing.revoked && !visible.length) {
    out.line(c.yellow(`\n  ⚠ ${grantId} shows as revoked only in ${grantor.name}'s own merged view, with no anchored revocation other nodes can see; publishing one.`))
  }
  if (visible.length) {
    out.line(c.dim(`\n  ${grantId} is already revoked${visible[0].ual ? ` (${clean(visible[0].ual, 200)})` : ''}. Nothing was published.\n`))
    out.result({ revoked: true, alreadyRevoked: true, by: visible[0] })
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
  const stateId = `urn:mandate:state:${nonce}`
  const quads = stateToQuads({ id: stateId, stateOf: grantId, state: 'revoked', stateAuthor: `did:dkg:agent:${address}`, stateAt: at })
  const assetName = `revoke-${grant.subject.split(':')[1]}-${nonce}`
  out.line(c.dim(`\n  sealing, sharing and anchoring ${assetName} on ${grantor.name}…`))
  let r
  try {
    r = await grantor.sealShareAnchor({ name: assetName, contextGraphId: cg, quads, expectAuthor: address })
  } catch (e) {
    if (!(e instanceof DkgWriteError)) throw e
    return writeFailed(out, e, {
      what: 'revocation', ids: { grantId, stateId }, assetName, contextGraphId: cg, node: grantor.name,
      check: `mandate blast-radius --grant ${grantId}`,
      checkHow: `only reads the grants graph (from the producer node, which may lag the grantor): "revoked" means it landed. If it still shows live after the nodes sync, \`mandate revoke --id ${grantId}\` publishes another revocation, which is harmless: any one revocation ends the grant for good.`,
      extra: { revoked: false, at },
    })
  }
  out.line(c.red(`\n  REVOKED  ${grantId}`))
  out.line(`  at          ${at}`)
  anchoredLines(out, r)
  out.line(c.dim('\n  Other nodes refuse once they sync this anchor, typically within about a minute.'))
  out.line(c.dim('  Until then a producer resolving from a node that has not synced may still permit.\n'))
  out.result({ revoked: true, grantId, at, contextGraphId: cg, ual: r.ual, txHash: r.txHash, explorer: txLink(r.ual, r.txHash) })
  return EXIT.OK
}

const finiteNonNegative = v => typeof v === 'number' && Number.isFinite(v) && v >= 0

/**
 * The producer node's address, once it is one of the trusted producers.
 * Anything it anchors otherwise would not count toward spend under this
 * configuration, so neither a render nor a record goes ahead from it.
 */
async function trustedProducerAddress(producer, cfg, consequence) {
  const address = agentAddress((await producer.identity()).agentDid)
  if (!address || !cfg.trustedProducers.includes(address)) {
    throw new ConfigError(`the producer node ${address ?? '(no address)'} is not a trusted producer (MANDATE_TRUSTED_PRODUCERS: ${cfg.trustedProducers.join(', ') || 'none'}), so its derivations would not count toward spend; ${consequence}`)
  }
  return address
}

/** Local render records that may already be billed but have no derivation on the graph yet. */
const OPEN_STATUSES = ['dispatching', 'submitted', 'rendered']

/**
 * Spend from this machine's own renders that are not yet recorded as
 * derivations, as extra trusted entries for the gate. A render billed but not
 * yet anchored still counts against the ceiling, and so does any record that
 * may be billed whatever its status (an earlier attempt with an unknown
 * outcome). The request being run again under its own key is left out,
 * because rerunning it recovers that same render.
 *
 * The amount is never smaller than what recording it will write: the
 * platform's cost when it gave one (or the estimate, if that is larger), else
 * the same rule billedFor applies, so an estimate the operator shrank with
 * --seconds counts as unknown (which refuses under a ceiling) rather than as
 * the small number.
 *
 * A render this machine recorded counts too while its derivation is not in
 * the knowledge the gate decides from (`knownDerivationIds`): knowledge read
 * before another render on this machine finished would otherwise not see its
 * spend at all.
 */
function localPendingSpend(records, request, knownDerivationIds = new Set()) {
  const entries = []
  for (const rec of records) {
    const recordedUnseen = rec?.status === 'recorded' && typeof rec.derivation?.id === 'string' && !knownDerivationIds.has(rec.derivation.id)
    if (!(OPEN_STATUSES.includes(rec?.status) || mayBeBilled(rec) || recordedUnseen) || typeof rec.grantId !== 'string') continue
    if (rec.key === renderKey({ ...request, grantId: rec.grantId })) continue
    const known = billedFor(rec).usd
    const billedUsd = finiteNonNegative(rec.costUsdEstimated) && finiteNonNegative(rec.estimateUsd) ? Math.max(rec.costUsdEstimated, rec.estimateUsd) : known
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
  let lease = null
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
    /** Local pending spend and a decision from it, over the same knowledge. */
    const decideWith = records => {
      const local = localPendingSpend(records, request, new Set(k.derivations.map(x => x?.id).filter(id => typeof id === 'string')))
      const decision = decide({ subject, capability, useClass, territory, at, estimatedUsd }, local.length ? { ...k, derivations: [...k.derivations, ...local] } : k)
      const counted = local.filter(e => k.grants.some(g => g?.subject === subject && g.id === e.authorizedUnder))
      return { d: decision, counted, localPending: counted.map(e => ({ key: e.id.slice('local-pending:'.length), status: e.status, grantId: e.authorizedUnder, billedUsd: e.billedUsd })) }
    }
    const refused = (d, localPending) => {
      out.line(c.red(`\n  REFUSED — clause: ${d.clause}`))
      out.line(`  ${clean(d.reason, 400)}`)
      out.line(c.green(`\n  $0 spent${d.spend.estimateUsd == null ? '' : `; ~$${d.spend.estimateUsd.toFixed(4)} not spent (${price.source})`}`) + c.dim(' — the capability was never invoked'))
      out.line(c.dim('  No render was dispatched.\n'))
      out.result({ decision: d, price, localPending })
      return d.clause === 'read-inconsistent' ? EXIT.INCONCLUSIVE : d.clause === 'malformed-request' ? EXIT.USAGE : EXIT.REFUSED
    }
    let { d, counted, localPending } = decideWith(pending.list())
    if (counted.length) out.line(c.dim(`  counting ${counted.length} local render(s) not yet recorded on the graph (${counted.map(e => e.status).join(', ')}) against this subject's grants`))
    // The gate trusts --seconds for a per-second price; nothing sends it to Livepeer or checks it against the inputs.
    if (d.spend?.ceilingUsd != null && seconds !== undefined && ['second', 'character'].includes(price.unit)) {
      price.note = `under this grant's $${d.spend.ceilingUsd} ceiling, the ~$${estimatedUsd == null ? '?' : estimatedUsd.toFixed(4)} estimate is per ${price.unit} × --seconds ${seconds}, which is taken as given: it is not sent to Livepeer or checked against the inputs, and the render is billed for its real length`
      out.line(c.yellow(`  ⚠ ${price.note}`))
    }
    printForgeries(out, d.forgeries)
    printWarnings(out, d.warnings)

    if (!d.permit) return refused(d, localPending)

    out.line(c.green(`\n  PERMITTED under ${clean(d.grantId, 200)}`))
    out.line(c.dim(`  published by ${clean(d.publisher, 60)}${d.grantUal ? ` as ${clean(d.grantUal, 200)}` : ''}`))
    if (!flags.execute) {
      out.line(c.dim('\n  --execute not set; stopping before dispatch (no spend).\n'))
      out.result({ decision: d, price, localPending, executed: false })
      return EXIT.OK
    }

    // A render whose derivation would not count, or could not be written, must
    // not be paid for: the ceiling would never see it.
    const producerAddress = await trustedProducerAddress(resolver, cfg, 'nothing was dispatched')
    derivationsCgFor(producerAddress)

    const key = renderKey({ grantId: d.grantId, ...request })
    const notDispatched = (e, ex) => {
      out.line(c.yellow(`\n  NOT DISPATCHED — pending render ${key} is ${e.inFlight ? 'in use by another mandate process now' : `already ${clean(ex.status, 20)}`}${ex.jobId ? ` (job ${clean(ex.jobId, 60)})` : ''}.`))
      out.line(c.dim(e.inFlight ? '  Wait for that process to finish, then check it with: mandate record --pending ' + key + '\n' : `  Finish it with: mandate record --pending ${key}\n`))
      out.result({ decision: d, price, executed: false, pending: key, status: ex.status, inFlight: e.inFlight === true, jobId: ex.jobId ?? null })
      return EXIT.RENDER_FAILED
    }
    // Held for this render's whole life (dispatch, polling, the derivation
    // write), so a `record` or another render of the same key never works on it
    // at the same time: that one exits 5 at once rather than wait.
    try {
      lease = pending.acquireLease(key)
    } catch (e) {
      if (!(e instanceof PendingConflictError)) throw e
      return notDispatched(e, { status: 'in use' })
    }
    // The same request under the same grant has the same key. A record that
    // holds a running job, billed media or an anchored derivation is never
    // overwritten by a rerun; one that may be billed is resumed as a new
    // attempt under its stored key, keeping its history and its place in
    // local pending spend.
    //
    // Under the grant's lock, local pending spend is read again and the gate
    // decides again, and the `dispatching` record (which counts in local
    // pending spend) is saved before the lock is released: parallel renders
    // under one grant on this machine each see the others before deciding.
    let begun
    let changed = null
    try {
      begun = pending.withGrantLock(d.grantId, () => {
        const again = decideWith(pending.list())
        if (!again.d.permit || again.d.grantId !== d.grantId) {
          changed = again
          return null
        }
        localPending = again.localPending
        // A render that may already be billed is replayed under the key it was sent
        // with, so leaving out --idempotency-key reuses the stored one instead of
        // sending the derived key and billing a second time. A different explicit
        // key is refused by the store (PendingInvariantError) before anything is sent.
        const idempotencyKey = flags.idempotencyKey ?? (mayBeBilled(pending.load(key)) ? undefined : key)
        return pending.beginAttempt({
          key, ...(idempotencyKey === undefined ? {} : { idempotencyKey }), status: 'dispatching', createdAt: new Date().toISOString(),
          subject, capability, useClass, territory, seconds: seconds ?? null, inputs, prompt: flags.prompt ?? null, sourceUrl: flags.sourceUrl ?? null,
          grantId: d.grantId, grantUal: d.grantUal, estimateUsd: estimatedUsd, estimateSource: price.source, priceUnit: price.unit ?? null,
        })
      })
    } catch (e) {
      if (e instanceof PendingInvariantError) throw withExit(e, EXIT.USAGE)
      if (!(e instanceof PendingConflictError)) throw e
      const ex = e.existing
      if (ex.status === 'recorded') {
        out.line(c.yellow(`\n  ALREADY RECORDED — this render was made and recorded before (${clean(ex.derivation?.ual ?? 'no UAL', 200)}).`))
        out.line(c.dim('  Nothing was dispatched: rendering it again would bill it and count it against the ceiling twice.\n'))
        out.result({ decision: d, price, executed: false, alreadyRecorded: true, pending: key, mediaUrl: ex.mediaUrl ?? null, derivation: ex.derivation ?? null })
        return EXIT.OK
      }
      return notDispatched(e, ex)
    }
    if (changed) {
      if (!changed.d.permit) {
        out.line(c.yellow('\n  Another render under this grant on this machine was dispatched first; deciding again with it counted:'))
        return refused(changed.d, changed.localPending)
      }
      out.line(c.yellow(`\n  NOT DISPATCHED — while waiting for another render on this machine, the decision moved to ${clean(changed.d.grantId, 200)}. Run the command again.\n`))
      out.result({ decision: changed.d, price, executed: false, localPending: changed.localPending, decisionChanged: true })
      return EXIT.RENDER_FAILED
    }
    let sendKey = begun.record.idempotencyKey
    if (!sendKey) sendKey = pending.save({ ...pending.load(key), idempotencyKey: key }).idempotencyKey
    if (begun.resumed) {
      out.line(c.yellow(`\n  resuming pending render ${key}: an earlier attempt may have reached Livepeer (attempt ${begun.attempt.n}); replaying it under idempotency key ${clean(sendKey, 80)}`))
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
        // This attempt sent nothing. An earlier attempt that may be billed keeps
        // the record submitted (the store never downgrades it to failed).
        const after = pending.finishAttempt(key, { status: 'failed', mayHaveStarted: false, errorKind: 'spend-cap', error: 'over the account 24h budget; not dispatched' })
        const stillOpen = after.status !== 'failed'
        out.line(c.red(`\n  NOT DISPATCHED — ~$${estimatedUsd.toFixed(4)} exceeds the account's remaining 24h budget of $${remaining.toFixed(2)}.`))
        if (stillOpen) out.line(c.yellow(`  OUTCOME UNKNOWN — an earlier attempt of pending render ${key} may still have rendered and been billed; it keeps counting against the ceiling. Re-run this command later to recover it.`))
        out.line('')
        out.result({ decision: d, price, executed: false, pending: key, status: after.status, outcome: stillOpen ? 'unknown' : 'failed', spendCap: { checked: true, remainingUsd: remaining, note: null } })
        // An earlier attempt's unknown outcome wins over the cap: 9, as for any render whose outcome is unknown.
        return stillOpen ? EXIT.INCONCLUSIVE : EXIT.PAYMENT
      } else {
        Object.assign(spendCap, { checked: true, remainingUsd: remaining })
      }
    } catch (e) {
      spendCap.note = `could not read the account spend cap (${clean(e.message, 120)})`
    }
    if (spendCap.note) out.line(c.dim(`  note: ${spendCap.note}`))

    const describe = await LP.describeCapability(client, capability).catch(() => null)
    const mode = dispatchMode(describe)
    pending.save({ ...pending.load(key), mode })
    out.line(c.dim(`\n  pending render ${key}`))
    out.line(c.dim(`  dispatching ${capability} via run_capability on /api/mcp/raw (${mode}, no model substitution)…`))

    const t0 = Date.now()
    let rendered
    try {
      // Marked sent before the call: a crash from here on leaves a record that may be billed.
      pending.markSent(key)
      rendered = await LP.dispatchRender(client, {
        capability, inputs, prompt: flags.prompt, sourceUrl: flags.sourceUrl, idempotencyKey: sendKey, mode,
        onJob: jobId => { pending.save({ ...pending.load(key), status: 'submitted', jobId }); out.line(c.dim(`  job ${clean(jobId, 60)} queued; polling`)) },
      })
    } catch (e) {
      const saved = pending.load(key) ?? begun.record
      const jobId = e.jobId ?? saved.jobId ?? null
      // A render that may have started may be running and billed. It stays
      // recoverable: by its job id when there is one, by its idempotency key when not.
      const recoverable = e.mayHaveStarted === true || Boolean(jobId)
      const after = pending.finishAttempt(key, { status: recoverable ? 'submitted' : 'failed', jobId, mayHaveStarted: recoverable, errorKind: e.kind ?? null, error: clean(e.message, 600) })
      // An earlier attempt with an unknown outcome keeps the whole render
      // unknown even when this attempt failed cleanly.
      const unknown = after.status === 'submitted'
      out.line(c.red(`\n  RENDER ${unknown ? 'NOT CONFIRMED' : 'FAILED'} — ${clean(e.message, 400)}`))
      if (jobId) {
        out.line(c.dim(`  job ${clean(jobId, 60)} may still be running or finished; run \`mandate record --pending ${key}\` to collect and record it.`))
      } else if (unknown) {
        out.line(c.yellow(recoverable
          ? '  The request may have reached Livepeer and be rendering, and billed, now.'
          : '  This attempt failed, but an earlier attempt may have reached Livepeer and been billed; it keeps counting against the ceiling.'))
        out.line(c.dim(`  Re-run the same command: it reuses idempotency key ${clean(sendKey, 80)}, so a finished render is returned rather than billed again.`))
      }
      out.line('')
      out.result({ decision: d, price, executed: true, rendered: false, pending: key, recoverable: unknown, outcome: unknown ? 'unknown' : 'failed', error: clean(e.message, 600), kind: e.kind ?? null, jobId, attempts: after.attempts?.length ?? null })
      // Unknown outcome is 9, as for `record`: a script must not read it as "not billed".
      return unknown ? EXIT.INCONCLUSIVE : e.kind === 'payment' ? EXIT.PAYMENT : e.kind === 'unknown-status' ? EXIT.INCONCLUSIVE : EXIT.RENDER_FAILED
    }
    const renderMs = Date.now() - t0
    // servedCapability is null when the platform named something that is not a
    // capability. It is recorded as unknown, never as the requested one, and
    // commitDerivation refuses to anchor it (see servedUnknown).
    const servedCapability = rendered.servedCapability ?? null
    pending.finishAttempt(key, { status: 'rendered', mayHaveStarted: true, jobId: rendered.jobId ?? null, mediaUrl: rendered.url, servedCapability, servedCapabilityUnknown: servedCapability === null, costUsdEstimated: finiteNonNegative(rendered.costUsdEstimated) ? rendered.costUsdEstimated : null, replay: rendered.replay === true, renderMs })
    out.line(c.dim(`  rendered in ${Math.round(renderMs / 1000)}s${rendered.replay ? ' (idempotent replay: not billed again)' : ''}; recording the derivation before releasing the media…`))
    for (const w of Array.isArray(rendered.warnings) ? rendered.warnings : []) out.line(c.yellow(`  ⚠ ${clean(w, 240)}`))
    if (rendered.servedCapability != null && rendered.servedCapability !== capability) {
      out.line(c.yellow(`  ⚠ the platform reports ${clean(rendered.servedCapability, 60)} served this render, not ${capability}; it is recorded as served`))
    }
    return await commitDerivation(out, pending, pending.load(key), { decision: d, price, spendCap, localPending })
  } finally {
    lease?.release()
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

/**
 * Stages at which a derivation write certainly never reached vm/publish, so
 * the same asset can be continued without asking the node first. `publish` is
 * not one of them: see lastPublishUnknown.
 */
const RESUMABLE_STAGES = new Set(['create', 'share', 'author'])

/** Stages after which the asset must never be published again, whatever the node shows later. */
const PERMANENT_STAGES = new Set(['unbound', 'resume-refused'])

/**
 * Whether the last publish of this derivation's asset may have sent a
 * transaction without the outcome being learned. Only two things say it did
 * not: the attempt stopped before publish was ever called, or publish was
 * refused with a 4xx (which the node's route sends only before any chain call)
 * and nothing reported a UAL or transaction. A `publish` attempt saved by an
 * older version, with no HTTP status kept, counts as unknown.
 */
function lastPublishUnknown(rec, attempt) {
  if (attempt.mayHaveSent === true || attempt.ual || attempt.txHash) return true
  if (RESUMABLE_STAGES.has(attempt.stage)) return false
  const status = rec.derivationPublishStatus
  if (attempt.stage === 'publish' && Number.isInteger(status) && status >= 400 && status < 500) return false
  return true
}

/**
 * Why an earlier derivation attempt must not be continued now, or null, as
 * { stage, message, permanent }. An asset minted but unbound, or one the node
 * refused to resume, is never published again (permanent). After a publish of
 * unknown outcome, only node states that cannot mint twice are continued:
 * nothing created yet, sealed but not shared, or already published (which
 * resume only verifies). A shared asset is left until the node shows it
 * published; that block is retryable, and the library enforces the same rule
 * through lastPublishUnknown.
 */
async function resumeBlock(producer, cg, rec, attempt) {
  if (PERMANENT_STAGES.has(attempt.stage)) {
    return { stage: 'resume-refused', permanent: true, message: `the last attempt to record asset ${attempt.name} ended at stage ${attempt.stage}${attempt.ual ? ` (${attempt.ual})` : ''}; publishing it again could mint a second asset` }
  }
  if (!lastPublishUnknown(rec, attempt)) return null
  let d
  try {
    d = await producer.descriptor(attempt.name, cg)
  } catch (e) {
    return { stage: 'resume-unverified', permanent: false, message: `could not read asset ${attempt.name} from ${producer.name} to check it is safe to continue (${e.message})` }
  }
  if (d === null && attempt.mayHaveSent !== true) return null
  if (d?.status === 'wm-sealed' || d?.status === 'vm-confirmed') return null
  return { stage: 'resume-unverified', permanent: false, message: `a transaction may already have been sent for asset ${attempt.name} (the node reports ${d?.status ?? 'no such asset'}); publishing it again could mint a second asset` }
}

const PRINTABLE = /^[\x21-\x7e]{1,512}$/
const TX_HASH = /^0x[0-9a-fA-F]{64}$/
const STAGE = /^[a-z][a-z-]{0,39}$/

/** Anchor a rendered file's derivation, then — and only then — print its URL. */
async function commitDerivation(out, pending, rec, extra = {}) {
  const producer = PRODUCER()
  let attempt = rec.derivationAttempt?.name ? rec.derivationAttempt : null
  const fail = (e, { blocked = null } = {}) => {
    // This process lost the key's lease, or its copy of the record is older than
    // what is on disk: another process owns the render now, so nothing is written.
    if (e instanceof PendingConflictError) throw e
    const stage = blocked ? blocked.stage : (typeof e?.stage === 'string' && STAGE.test(e.stage) ? e.stage : 'error')
    const ual = typeof e?.ual === 'string' && PRINTABLE.test(e.ual) ? e.ual : null
    const txHash = typeof e?.txHash === 'string' && TX_HASH.test(e.txHash) ? e.txHash : null
    const mayHaveSent = e?.mayHaveSent === true
    const message = blocked ? blocked.message : e?.message
    if (attempt && !blocked) {
      try { rec = pending.noteDerivationAttempt(rec.key, { stage, ual, txHash, mayHaveSent }) } catch { /* keep what is already saved */ }
    }
    // The HTTP status of a publish refusal is what tells a 4xx (sent nothing)
    // from an older record whose `publish` stage may have followed a broadcast.
    // A generic error learned nothing about the publish, so the saved status stays.
    const publishStatus = !blocked && stage === 'publish' && Number.isInteger(e?.status) ? e.status : null
    const saved = { ...(pending.load(rec.key) ?? rec), status: 'rendered', error: clean(message, 600), stage, ...(blocked || stage === 'error' ? {} : { derivationPublishStatus: publishStatus }) }
    pending.save(saved)
    const known = saved.derivationAttempt ?? {}
    const permanent = blocked ? blocked.permanent : PERMANENT_STAGES.has(stage) || PERMANENT_STAGES.has(known.stage)
    const waiting = !permanent && (stage === 'resume-unverified' || known.mayHaveSent === true)
    out.line(c.red(`\n  DERIVATION ${blocked ? 'NOT RETRIED' : 'FAILED TO COMMIT'} — treating this render as failed.`))
    out.line(c.red(`  ${clean(message, 400)}`))
    if (known.name) out.line(c.dim(`  asset ${clean(known.name, 120)}${known.ual ? `  UAL ${clean(known.ual, 200)}` : ''}${known.txHash ? `  tx ${clean(known.txHash, 70)}` : ''}`))
    if (known.mayHaveSent) out.line(c.yellow('  A transaction may have been sent. Check the node before doing anything else.'))
    out.line(c.dim('  The render exists and was billed, so its URL is withheld until it is recorded.'))
    out.line(c.dim(permanent
      ? `  \`mandate record --pending ${rec.key}\` will never publish this asset again: it may already be minted. Check its UAL or transaction on the explorer; the render keeps counting against the ceiling on this machine.\n`
      : waiting
        ? `  \`mandate record --pending ${rec.key}\` never publishes this asset again while its last publish is unknown; retry it once the node shows the asset published (or sealed), and it is verified rather than minted again.\n`
        : `  Retry with: mandate record --pending ${rec.key}\n`))
    out.result({
      ...extra, executed: true, rendered: true, derivation: null, pending: rec.key, error: clean(message, 600), stage,
      asset: known.name ?? null, derivationId: known.id ?? null, ual: known.ual ?? null, txHash: known.txHash ?? null, mayHaveSent: known.mayHaveSent === true,
    })
    return EXIT.DERIVATION_FAILED
  }

  // Fail closed on a serving capability the platform named but that is not a
  // capability name. Recording the requested one would claim no substitution
  // happened, and verify would read CLEAR under a capability the grant may not
  // permit; there is no marker a grant could never permit, so nothing is
  // anchored. Trade-off: the render stays billed and unrecorded, its URL
  // withheld, and it keeps counting against the ceiling on this machine.
  if (rec.servedCapabilityUnknown === true) {
    const message = `the platform named a serving capability that is not a capability name, so what served this render is unknown; a derivation under ${clean(rec.capability, 64)} could verify CLEAR under the wrong capability, so none is anchored`
    pending.save({ ...(pending.load(rec.key) ?? rec), status: 'rendered', error: message, stage: 'served-unknown' })
    out.line(c.red('\n  DERIVATION NOT RECORDED — the serving capability is unknown.'))
    out.line(c.red(`  ${message}`))
    out.line(c.dim('  The render exists and may be billed, so its URL is withheld and it keeps counting against the ceiling on this machine.\n'))
    out.result({ ...extra, executed: true, rendered: true, derivation: null, pending: rec.key, error: message, stage: 'served-unknown', servedCapability: null })
    return EXIT.DERIVATION_FAILED
  }

  // Before anything is hashed, looked up or published: a derivation from a
  // producer this configuration does not trust would not count toward spend,
  // yet recording it would release the media and drop the render from local
  // pending spend. Refused as render refuses (exit 1), leaving the record as it is.
  let address
  try {
    address = agentAddress((await producer.identity()).agentDid)
  } catch (e) {
    return fail(e)
  }
  const trusted = readConfig().trustedProducers
  if (!address || !trusted.includes(address)) {
    throw new ConfigError(`the producer node ${address ?? '(no address)'} is not a trusted producer (MANDATE_TRUSTED_PRODUCERS: ${trusted.join(', ') || 'none'}), so its derivations would not count toward spend; nothing was recorded, and pending render ${rec.key} is left ${rec.status}`)
  }

  try {
    const cg = derivationsCgFor(address)
    const sha = await hashUrl(rec.mediaUrl)

    // An idempotent replay returns a render the platform already billed. If a
    // trusted producer already recorded it, recording it again would count its
    // spend twice, so the existing edge is used instead.
    if (rec.replay === true) {
      const k = await readKnowledge(producer, readConfig(), { grantId: rec.grantId })
      if (!k.consistency.ok) throw withExit(new Error(`cannot tell whether this replayed render is already recorded: ${k.consistency.reason}`), EXIT.DERIVATION_FAILED)
      // The bytes must be the ones recorded, and a job id on both sides must agree: a job id alone never vouches for other bytes.
      const existing = k.derivations.find(x => x?.trusted === true && x.authorizedUnder === rec.grantId && x.outputSha256 === sha && !(rec.jobId && x.jobId && x.jobId !== rec.jobId))
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
    let unknownPublish = false
    if (attempt) {
      const blocked = await resumeBlock(producer, cg, rec, attempt)
      if (blocked) return fail(null, { blocked })
      resume = true
      unknownPublish = lastPublishUnknown(rec, attempt)
      // Marked in flight before the resume may call vm/publish, exactly like a
      // first attempt: `started` is not resumable, so a crash mid-publish leaves
      // a stage the next retry checks against the node. The saved publish status
      // belongs to the earlier attempt and goes. Trade-off: a resume that dies
      // before publishing (a lost share reply) then waits for the node to show
      // the asset sealed or published instead of continuing at once.
      rec = pending.noteDerivationAttempt(rec.key, { stage: 'started' })
      rec = pending.save({ ...rec, derivationPublishStatus: null })
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
      id: attempt.id, name: attempt.name, resume, lastPublishUnknown: unknownPublish, expectAuthor: address,
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

/** Job statuses that end a job without media: the same set src/execute.mjs polls for. */
const JOB_FAILED_STATUSES = new Set(['failed', 'failure', 'error', 'errored', 'cancelled', 'canceled', 'aborted', 'abandoned', 'rejected', 'expired', 'timed_out', 'timeout'])

/**
 * Whether a poll error is the platform saying this very job failed: a
 * RenderError for the same job id whose reply carries one of those statuses.
 * A timeout, an unrecognised status, a job with no media or a reply about
 * another job say nothing certain, and stay unresolved.
 */
function jobFailedForCertain(e, jobId) {
  if (e?.constructor?.name !== 'RenderError' || !['tool', 'payment'].includes(e.kind)) return false
  if (typeof jobId !== 'string' || e.jobId !== jobId) return false
  const status = e.structured?.status
  if (typeof status !== 'string') return false
  const s = status.trim().toLowerCase().replace(/[ -]+/g, '_')
  if (!JOB_FAILED_STATUSES.has(s)) return false
  const other = e.structured.job_id
  return other === undefined || other === null || (typeof other === 'string' && other.toLowerCase() === jobId.toLowerCase())
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
  // The key's lease is held for the whole record (polling and the derivation
  // write), and a render holds it for its whole life, so two processes never
  // work on one render at once: this one exits 5 at once instead of waiting.
  let lease
  try {
    lease = pending.acquireLease(flags.pending)
  } catch (e) {
    if (!(e instanceof PendingConflictError)) throw e
    out.line(c.yellow(`\n  NOT RECORDED HERE — ${clean(e.message, 400)}\n`))
    out.result({ pending: flags.pending, inFlight: true, outcome: 'in-use', error: clean(e.message, 600) })
    return EXIT.RENDER_FAILED
  }
  try {
    return await recordPending(flags, out, pending)
  } finally {
    lease.release()
  }
}

/** `record --pending`, holding the key's lease: the record is loaded only now, so nothing read before the lease is acted on. */
async function recordPending(flags, out, pending) {
  let rec = pending.load(flags.pending)
  if (!rec) throw new UsageError(`no pending render ${flags.pending} in ${pending.dir}`)
  if (rec.status === 'recorded') {
    out.line(c.dim(`\n  already recorded: ${clean(rec.derivation?.ual, 200)}\n`))
    out.result({ ...rec })
    return EXIT.OK
  }
  if (rec.status === FAILED_CONFIRMED) {
    out.line(c.dim(`\n  ${rec.key}: job ${clean(rec.jobId ?? 'none', 60)} was reported failed and is settled (${clean(rec.error ?? '', 200)}); nothing to record.\n`))
    const { mediaUrl, ...shown } = rec
    out.result({ ...shown, outcome: 'failed' })
    return EXIT.RENDER_FAILED
  }
  if (!rec.mediaUrl) {
    if (!rec.jobId) {
      const unknown = rec.status === 'dispatching' || mayBeBilled(rec)
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
      const done = await LP.pollJob(client, rec.jobId, { inputUrls: [rec.sourceUrl, rec.inputs], maxWaitMs: 10 * 60_000, capability: rec.capability })
      // Both are validated by pollJob: null when the platform's value could not be recorded.
      const servedCapability = done.servedCapability ?? null
      pending.save({ ...rec, status: 'rendered', mediaUrl: done.url, servedCapability, servedCapabilityUnknown: servedCapability === null, costUsdEstimated: finiteNonNegative(done.costUsdEstimated) ? done.costUsdEstimated : null })
      for (const w of Array.isArray(done.warnings) ? done.warnings : []) out.line(c.yellow(`  ⚠ ${clean(w, 240)}`))
      if (done.servedCapability != null && done.servedCapability !== rec.capability) {
        out.line(c.yellow(`  ⚠ the platform reports ${clean(done.servedCapability, 60)} served this render, not ${clean(rec.capability, 60)}; it is recorded as served`))
      }
    } catch (e) {
      if (jobFailedForCertain(e, rec.jobId)) {
        // Settled with allowResolve: the history stays, and it stops counting
        // toward local pending spend (see FAILED_CONFIRMED for the trade-off).
        const settled = pending.save({ ...rec, status: FAILED_CONFIRMED, error: clean(e.message, 600), errorKind: e.kind ?? null, failedConfirmedAt: new Date().toISOString(), jobStatus: clean(e.structured.status, 40) }, { allowResolve: true })
        out.line(c.red(`\n  JOB FAILED — ${clean(e.message, 300)}`))
        out.line(c.dim(`  The platform reports job ${clean(rec.jobId, 60)} as ${clean(e.structured.status, 40)}. Marked ${FAILED_CONFIRMED}: it no longer counts against the ceiling on this machine, and its attempts are kept.\n`))
        const { mediaUrl, ...shown } = settled
        out.result({ ...shown, error: clean(e.message, 600), kind: e.kind ?? null, outcome: 'failed' })
        return e.kind === 'payment' ? EXIT.PAYMENT : EXIT.RENDER_FAILED
      }
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
 *
 * Closed world: only a reading of the consent script (scope.confirmed) is
 * accepted without a person. Anything else comes back with scriptMatched
 * false, for the caller to put to a typed confirmation or refuse. The
 * heuristics can only refuse more: a contradiction (exit 8), no first-person
 * consent, or a failed transcription are never overridable, and requested
 * terms the heuristics did not hear need --force where the command allows it.
 */
async function captureAndCheck(flags, out, requested, { allowForce = false } = {}) {
  await livepeer()
  const { captureConsent, consentScript } = await import('../src/consent.mjs')
  const force = allowForce && flags.force
  const script = consentScript(requested)
  out.line(c.bold('\nConsent capture\n'))
  out.notice('  Ask the person being depicted to record themselves reading these words exactly (anything else needs a person to confirm it by hand):')
  out.notice(c.bold(`\n    "${script}"\n`))
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
  const transcript = reviewText(r.transcript)
  const transcriptTooLong = transcript.length > TRANSCRIPT_REVIEW_MAX
  out.notice(transcriptTooLong
    ? `\n  transcript  (${transcript.length} characters: over the ${TRANSCRIPT_REVIEW_MAX}-character review limit, so it is not shown)\n`
    : `\n  transcript  "${transcript}"\n`)
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
  const sm = r.scope.scriptMatch
  // Both fields, so a scope result from an older library that lacks them is never a match.
  const scriptMatched = r.scope.confirmed === true && sm?.matched === true
  if (scriptMatched) {
    out.line(c.green('\n  The transcript is a reading of the consent script, with nothing contradicted.'))
    return { code: EXIT.OK, consent: r, summary, forced: false, scriptMatched: true }
  }
  // Shown on stderr too in --json mode: a person deciding about the clip needs them.
  out.notice(c.yellow('\n  NOT A READING OF THE CONSENT SCRIPT — the words cannot be confirmed automatically.'))
  const missingWords = Array.isArray(sm?.missing) ? reviewText(sm.missing.join(' ')) : ''
  const extraWords = Array.isArray(sm?.extra) ? reviewText(sm.extra.join(' ')) : ''
  // Never cut: words a person confirms are shown whole, or the clip is refused.
  const extraCount = Array.isArray(sm?.extra) ? sm.extra.length : 0
  if (transcriptTooLong || extraCount > EXTRA_WORDS_REVIEW_MAX || extraWords.length > TRANSCRIPT_REVIEW_MAX || missingWords.length > TRANSCRIPT_REVIEW_MAX) {
    const reason = transcriptTooLong || extraWords.length > TRANSCRIPT_REVIEW_MAX || missingWords.length > TRANSCRIPT_REVIEW_MAX
      ? `the transcript is ${transcript.length} characters, over the ${TRANSCRIPT_REVIEW_MAX}-character limit a person can be asked to review in full`
      : `${extraCount} or more words are outside the consent script, more than the ${EXTRA_WORDS_REVIEW_MAX} that can be listed in full for review`
    out.line(c.red(`\n  TOO LONG TO REVIEW — ${reason}. Nothing is confirmed from words that were not all shown. Re-record: the person reads the consent script, and nothing else.\n`))
    return { code: EXIT.CONSENT_UNCONFIRMED, summary: { ...summary, reason: 'transcript too long to review' } }
  }
  out.notice(`    script      "${reviewText(script)}"`)
  out.notice(`    transcript  (above)`)
  out.notice(`    missing    ${missingWords || '(nothing)'}`)
  out.notice(`    extra       ${extraWords || '(nothing)'}`)
  // Without an affirmative first-person "I consent", nothing else said is consent.
  if (r.scope.affirmative !== true) {
    out.line(c.red('\n  NO CONSENT SAID — the clip has no affirmative first-person consent ("I consent", "I agree", "I give permission"). --force does not override this.\n'))
    return { code: EXIT.CONSENT_UNCONFIRMED, summary }
  }
  let forced = false
  if (r.scope.missing.length) {
    out.line(c.yellow(`\n  Not heard: ${r.scope.missing.join(', ')}.`))
    if (!force) {
      out.line(c.yellow(`  Re-record reading the script, narrow the request${allowForce ? ', or pass --force to confirm the clip by hand' : ''}.\n`))
      return { code: EXIT.CONSENT_UNCONFIRMED, summary }
    }
    forced = true
    out.line(c.yellow('  --force: continuing to a typed confirmation. The transcript above is what was actually said.'))
  }
  return { code: EXIT.OK, consent: r, summary, forced, scriptMatched: false }
}

async function cmdConsent(flags, out) {
  // Nothing is granted here, so there is no typed confirmation: only a reading of the script is confirmed.
  const requested = { capability: flags.capability ?? [], useClass: flags.useClass, territory: flags.territory ?? [] }
  const r = await captureAndCheck(flags, out, requested)
  if (r.code === EXIT.OK && !r.scriptMatched) {
    out.line(c.yellow('\n  UNCONFIRMED — not a reading of the consent script. A grant from this clip would need a person to confirm it by hand.\n'))
    out.result({ ...r.summary, confirmed: false })
    return EXIT.CONSENT_UNCONFIRMED
  }
  out.result({ ...r.summary, confirmed: r.code === EXIT.OK })
  if (r.code === EXIT.OK) {
    const unchecked = (r.consent.scope.unchecked ?? []).filter(i => i !== 'validity' && i !== 'ceiling')
    out.line(c.green('  Confirmed: the clip reads the consent script.'))
    out.line(c.yellow(`  This check named no end date or ceiling${unchecked.length ? `, and not: ${unchecked.join(', ')}` : ''}. A grant states and checks its own.\n`))
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
  const config = configInEffect(out, cfg)
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
  out.result({ ...r, node: node.name, nodeRole: role, config })
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
  if (e instanceof DkgWriteError) return ['unbound', 'publish', 'publish-transport', 'resume-refused', 'resume-unverified'].includes(e.stage) || e.mayHaveSent === true ? EXIT.DKG_ANCHOR_FAILED : EXIT.DKG_WRITE_FAILED
  if (e instanceof DkgHttpError || e instanceof ReadTruncatedError || e instanceof FetchBytesError) return EXIT.INCONCLUSIVE
  // Local state that exists but cannot be read is not an operator's typing mistake.
  if (e instanceof NodeTokenError || e instanceof StateReadError || e instanceof PendingReadError) return EXIT.INCONCLUSIVE
  if (e instanceof PendingInvariantError) return EXIT.USAGE
  if (e instanceof PendingConflictError) return EXIT.RENDER_FAILED
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
    loadMandateEnv({ flag: flags.envPath })
    for (const w of envLoad.warnings) console.error(c.yellow(`  ⚠ ${clean(w, 600)}`))
    return await COMMAND_FNS[command](flags, out, prompter)
  } catch (e) {
    const code = exitFor(e)
    if (out.json) {
      console.log(JSON.stringify({ error: clean(e.message, 1000), stage: e.stage ?? null, assetName: e.assetName ?? null, file: e.file ?? null, ual: e.ual ?? null, txHash: e.txHash ?? null, mayHaveSent: e.mayHaveSent ?? false, exitCode: code }, null, 2))
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
