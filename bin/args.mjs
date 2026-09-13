/**
 * The CLI's one flag table, parser and exit codes.
 *
 * Every flag is declared once, with its type, the commands that accept it and
 * its help text. Parsing is strict: an unknown flag, a missing or flag-like
 * value, or a value of the wrong type is a usage error, never a silent default.
 * That matters for a consent gate — `render --at --execute` used to set the
 * request time to the string "--execute" while still dispatching a paid render.
 */
import { asDecimal, asDateTime, isSafeIri, isSubject, normSha256 } from '../src/rdf-term.mjs'

export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 1,
  REFUSED: 2,
  CONSENT_UNCONFIRMED: 3,
  DERIVATION_FAILED: 4,
  RENDER_FAILED: 5,
  DKG_WRITE_FAILED: 6,
  DKG_ANCHOR_FAILED: 7,
  CONSENT_CONTRADICTED: 8,
  INCONCLUSIVE: 9,
  PAYMENT: 10,
})

export const EXIT_HELP = [
  [EXIT.OK, 'success, permitted, CLEAR'],
  [EXIT.USAGE, 'usage error'],
  [EXIT.REFUSED, 'refused by the gate; TAINTED or UNKNOWN'],
  [EXIT.CONSENT_UNCONFIRMED, 'consent not confirmed (transcription failed or terms missing)'],
  [EXIT.DERIVATION_FAILED, 'render succeeded but its derivation failed to commit'],
  [EXIT.RENDER_FAILED, 'render failed'],
  [EXIT.DKG_WRITE_FAILED, 'DKG write failed before anchoring'],
  [EXIT.DKG_ANCHOR_FAILED, 'DKG anchor not confirmed'],
  [EXIT.CONSENT_CONTRADICTED, 'consent contradicted; never overridable'],
  [EXIT.INCONCLUSIVE, 'node unreachable or read inconsistent'],
  [EXIT.PAYMENT, 'Livepeer payment or credential problem'],
]

export class UsageError extends Error {}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

const TYPES = {
  string: v => v,
  bool: () => true,
  list: (v, flag) => {
    const items = v.split(',').map(s => s.trim())
    if (items.some(i => !TOKEN.test(i))) throw new UsageError(`--${flag} expects a comma-separated list of names, got ${JSON.stringify(v)}`)
    return items
  },
  decimal: (v, flag) => {
    if (Number.isNaN(asDecimal(v))) throw new UsageError(`--${flag} expects a plain non-negative number like 5 or 4.25, got ${JSON.stringify(v)}`)
    return v
  },
  iso: (v, flag) => {
    if (Number.isNaN(asDateTime(v))) throw new UsageError(`--${flag} expects an ISO-8601 time with an offset, like 2026-12-31T23:59:00Z, got ${JSON.stringify(v)}`)
    return new Date(asDateTime(v)).toISOString()
  },
  url: (v, flag) => {
    let u
    try { u = new URL(v) } catch { throw new UsageError(`--${flag} expects a URL, got ${JSON.stringify(v)}`) }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new UsageError(`--${flag} must be an http(s) URL`)
    return u.toString()
  },
  json: (v, flag) => {
    let parsed
    try { parsed = JSON.parse(v) } catch { throw new UsageError(`--${flag} expects a JSON object, got invalid JSON`) }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new UsageError(`--${flag} expects a JSON object`)
    return parsed
  },
  iri: (v, flag) => {
    if (!isSafeIri(v)) throw new UsageError(`--${flag} expects an IRI like urn:mandate:grant:…, got ${JSON.stringify(v)}`)
    return v
  },
  subject: (v, flag) => {
    if (!isSubject(v)) throw new UsageError(`--${flag} expects a subject like 0x<grantor address>:<name>, got ${JSON.stringify(v)}`)
    return v
  },
  sha256: (v, flag) => {
    const s = normSha256(v)
    if (!s) throw new UsageError(`--${flag} expects 64 hex characters`)
    return s
  },
}

const enumOf = values => (v, flag) => {
  if (!values.includes(v)) throw new UsageError(`--${flag} must be one of ${values.join(', ')}, got ${JSON.stringify(v)}`)
  return v
}

export const COMMANDS = {
  status: 'show the configured DKG nodes, their agents and connections',
  grant: "author a grant on the grantor's node (optionally capturing consent first)",
  consent: 'capture a consent clip through a phone link and check its spoken scope',
  render: 'resolve grants, decide, and only with --execute dispatch the render',
  revoke: 'revoke a grant, as the grantor that published it',
  verify: 'check a delivered file from its bytes alone',
  'blast-radius': 'everything produced under a grant',
  record: 'finish recording a render whose derivation did not commit (lists pending renders without --pending)',
}

/** [name, type, commands, help, {required, default}] */
export const FLAGS = [
  ['help', 'bool', ['*'], 'show help'],
  ['json', 'bool', ['*'], 'print one machine-readable result object'],

  ['subject', 'string', ['grant'], 'the depicted person: a name (prefixed with this node\'s address) or a full subject', { required: ['grant'] }],
  ['subject', 'subject', ['render'], 'subject as 0x<grantor address>:<name>', { required: ['render'] }],
  ['capability', 'list', ['grant', 'consent'], 'Livepeer capabilities the grant permits', { required: ['grant'] }],
  ['capability', 'string', ['render'], 'the Livepeer capability to dispatch', { required: ['render'] }],
  ['use-class', 'list', ['grant', 'consent'], 'permitted use classes, e.g. advertising', { required: ['grant', 'consent'] }],
  ['use-class', 'string', ['render'], 'the use class of this render', { required: ['render'] }],
  ['territory', 'list', ['grant', 'consent'], 'ISO country codes the grant covers; omit for unrestricted'],
  ['territory', 'string', ['render'], 'the ISO country code this render is for'],
  ['forbid', 'list', ['grant'], 'use classes to forbid explicitly (adult and deceptive impersonation are always forbidden)'],
  ['max-spend', 'decimal', ['grant'], 'lifetime spend ceiling in USD across renders under this grant'],
  ['valid-from', 'iso', ['grant'], 'grant start time (default now)'],
  ['valid-until', 'iso', ['grant'], 'grant end time (default 90 days)'],
  ['with-consent', 'bool', ['grant'], 'capture a consent clip on a phone before granting'],
  ['consent-kind', enumOf(['video', 'audio']), ['grant', 'consent'], 'what the phone link records (default video)'],
  ['force', 'bool', ['grant'], 'grant even if the spoken consent does not mention every requested term'],
  ['yes', 'bool', ['grant', 'revoke'], 'publish without the typed confirmation (required when not on a terminal)'],

  ['seconds', 'decimal', ['render'], 'expected output duration in seconds; required for a cost estimate on per-second capabilities'],
  ['at', 'iso', ['render'], 'decide as of this time (dry runs only; refused with --execute)'],
  ['execute', 'bool', ['render'], 'dispatch the render if permitted'],
  ['inputs', 'json', ['render'], 'capability inputs as a JSON object'],
  ['source-url', 'url', ['render'], 'shorthand for the primary input URL'],
  ['image-url', 'url', ['render'], 'shorthand for inputs.image_url'],
  ['audio-url', 'url', ['render'], 'shorthand for inputs.audio_url'],
  ['video-url', 'url', ['render'], 'shorthand for inputs.video_url'],
  ['prompt', 'string', ['render'], 'text prompt, for capabilities that take one'],
  ['idempotency-key', 'string', ['render'], 'override the derived idempotency key'],

  ['id', 'iri', ['revoke'], 'the grant IRI to revoke', { required: ['revoke'] }],
  ['url', 'url', ['verify'], 'the delivered file'],
  ['sha256', 'sha256', ['verify'], 'the delivered file\'s SHA-256, instead of --url'],
  ['node', enumOf(['verifier', 'grantor', 'producer']), ['verify'], 'which node reads the graph (default verifier)'],
  ['grant', 'iri', ['blast-radius'], 'the grant IRI', { required: ['blast-radius'] }],
  ['pending', 'string', ['record'], 'the pending render key printed by render --execute'],
]

const camel = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())

function flagFor(command, name) {
  return FLAGS.find(([n, , cmds]) => n === name && (cmds.includes(command) || cmds.includes('*')))
}

export function parseArgs(argv) {
  const args = [...argv]
  const command = args[0] && !args[0].startsWith('--') ? args.shift() : null
  if (command && !COMMANDS[command]) throw new UsageError(`unknown command ${JSON.stringify(command)}`)
  const flags = {}
  const seen = new Set()
  while (args.length) {
    const raw = args.shift()
    if (!raw.startsWith('--')) throw new UsageError(`unexpected argument ${JSON.stringify(raw)}`)
    const eq = raw.indexOf('=')
    const name = raw.slice(2, eq === -1 ? undefined : eq)
    const def = flagFor(command ?? '*', name)
    if (!def) {
      const valid = FLAGS.filter(([, , c]) => c.includes(command) || c.includes('*')).map(([n]) => `--${n}`)
      throw new UsageError(`unknown flag --${name}${command ? ` for ${command}` : ''}. Valid: ${[...new Set(valid)].join(' ')}`)
    }
    if (seen.has(name)) throw new UsageError(`--${name} given more than once`)
    seen.add(name)
    const [, type] = def
    if (type === 'bool') {
      if (eq !== -1) throw new UsageError(`--${name} takes no value`)
      flags[camel(name)] = true
      continue
    }
    let value = eq !== -1 ? raw.slice(eq + 1) : args.shift()
    if (value === undefined || value === '') throw new UsageError(`--${name} needs a value`)
    if (eq === -1 && value.startsWith('--')) throw new UsageError(`--${name} needs a value, got the flag ${value}`)
    const coerce = typeof type === 'function' ? type : TYPES[type]
    flags[camel(name)] = coerce(value, name)
  }
  if (command && !flags.help) {
    for (const [n, , cmds, , opts] of FLAGS) {
      if (opts?.required?.includes(command) && cmds.includes(command) && flags[camel(n)] === undefined) {
        throw new UsageError(`${command} requires --${n}`)
      }
    }
  }
  return { command, flags }
}

export function helpText(command) {
  const lines = []
  if (!command) {
    lines.push('mandate — a consent rail for generative media', '', 'Commands:')
    for (const [c, h] of Object.entries(COMMANDS)) lines.push(`  ${c.padEnd(14)} ${h}`)
    lines.push('', 'Run `mandate <command> --help` for its flags.', '', 'Exit codes:')
    for (const [code, h] of EXIT_HELP) lines.push(`  ${String(code).padStart(2)}  ${h}`)
    return lines.join('\n')
  }
  lines.push(`mandate ${command} — ${COMMANDS[command]}`, '', 'Flags:')
  for (const [n, type, cmds, help, opts] of FLAGS) {
    if (!cmds.includes(command) && !cmds.includes('*')) continue
    const t = type === 'bool' ? '' : ` <${typeof type === 'function' ? 'value' : type}>`
    const req = opts?.required?.includes(command) ? ' (required)' : ''
    lines.push(`  --${n}${t}`.padEnd(30) + ` ${help}${req}`)
  }
  return lines.join('\n')
}
