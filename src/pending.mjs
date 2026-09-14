/**
 * Renders in flight, on disk before any money is spent.
 *
 * A render is billed whether or not its derivation is ever recorded. If the
 * process dies between dispatch and the derivation anchoring, this record is
 * what lets `mandate record` finish the job instead of the media going
 * unaccounted, and its idempotency key is what stops a rerun billing twice.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, chmodSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const defaultPendingDir = () => join(process.env.MANDATE_HOME ?? join(homedir(), '.mandate'), 'pending')

const KEY = /^mandate-[0-9a-f]{32}$/

/**
 * Statuses a rerun must not overwrite. `submitted` holds a job id that is the
 * only way to find a render already running; `rendered` holds billed media not
 * yet anchored; `recorded` holds an anchored derivation that a replay would
 * record, and count against the ceiling, a second time.
 */
export const PROTECTED_STATUSES = Object.freeze(['recorded', 'submitted', 'rendered'])

export class PendingConflictError extends Error {
  constructor(existing) {
    super(`pending render ${existing.key} is already ${existing.status}; ${existing.status === 'recorded'
      ? 'it has been recorded, and rendering it again would bill and record it twice'
      : `finish it with \`mandate record --pending ${existing.key}\` instead of rendering it again`}`)
    this.name = 'PendingConflictError'
    this.key = existing.key
    this.status = existing.status
    this.existing = existing
  }
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const DERIVATION_ID = /^urn:mandate:derivation:[0-9a-f]{16}:[0-9a-f]{16}$/
const TX = /^0x[0-9a-fA-F]{64}$/
const PRINTABLE = /^[\x21-\x7e]{1,512}$/

/**
 * Check and merge what is known about a derivation publish attempt. The asset
 * name and id are fixed once set, so a retry reuses them instead of minting a
 * new asset; ual and txHash are never erased by a later attempt that did not
 * learn them; mayHaveSent, once true, stays true.
 */
export function mergeDerivationAttempt(previous = null, next = {}) {
  const prev = previous ?? {}
  const pick = (field, test, what) => {
    const v = next[field]
    if (v === undefined || v === null) return prev[field] ?? null
    if (typeof v !== 'string' || !test.test(v)) throw new Error(`invalid derivation ${what}: ${String(v).slice(0, 80)}`)
    return v
  }
  const name = pick('name', NAME, 'asset name')
  if (prev.name && name !== prev.name) throw new Error(`derivation asset name is already ${prev.name}; a retry must reuse it, not ${String(next.name).slice(0, 80)}`)
  const id = pick('id', DERIVATION_ID, 'id')
  if (prev.id && id !== prev.id) throw new Error(`derivation id is already ${prev.id}; a retry must reuse it`)
  if (next.mayHaveSent !== undefined && typeof next.mayHaveSent !== 'boolean') throw new Error('mayHaveSent must be true or false')
  const stage = next.stage === undefined ? (prev.stage ?? null) : next.stage
  if (stage !== null && (typeof stage !== 'string' || !/^[a-z][a-z-]{0,39}$/.test(stage))) throw new Error(`invalid derivation stage: ${String(stage).slice(0, 40)}`)
  return {
    id,
    name,
    ual: pick('ual', PRINTABLE, 'ual'),
    txHash: pick('txHash', TX, 'tx hash'),
    stage,
    mayHaveSent: prev.mayHaveSent === true || next.mayHaveSent === true,
  }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  return JSON.stringify(value ?? null)
}

/** The same request under the same grant always gets the same key; any change gets a new one. */
export function renderKey({ grantId, capability, inputs, prompt, sourceUrl, seconds }) {
  const digest = createHash('sha256').update(canonical({ grantId, capability, inputs: inputs ?? {}, prompt: prompt ?? null, sourceUrl: sourceUrl ?? null, seconds: seconds ?? null })).digest('hex')
  return `mandate-${digest.slice(0, 32)}`
}

export function pendingStore(dir = defaultPendingDir()) {
  const file = key => {
    if (!KEY.test(key)) throw new Error(`invalid pending render key: ${String(key).slice(0, 80)}`)
    return join(dir, `${key}.json`)
  }
  return {
    dir,
    save(record) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      chmodSync(dir, 0o700)
      const target = file(record.key)
      const tmp = `${target}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ ...record, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 })
      renameSync(tmp, target)
      return record
    },
    /**
     * Save a new render record, but refuse to overwrite one that is submitted,
     * rendered or recorded unless `overwrite` is set. Throws PendingConflictError
     * carrying the existing record.
     */
    create(record, { overwrite = false } = {}) {
      const existing = this.load(record.key)
      if (existing && !overwrite && PROTECTED_STATUSES.includes(existing.status)) throw new PendingConflictError(existing)
      return this.save(record)
    },
    /**
     * Note a derivation publish attempt on a record (see mergeDerivationAttempt).
     * Returns the saved record. Call it with the name and id before publishing,
     * so a crash mid-publish still leaves the name a retry must reuse.
     */
    noteDerivationAttempt(key, attempt) {
      const rec = this.load(key)
      if (!rec) throw new Error(`no pending render ${key}`)
      return this.save({ ...rec, derivationAttempt: mergeDerivationAttempt(rec.derivationAttempt, attempt) })
    },
    load(key) {
      try {
        return JSON.parse(readFileSync(file(key), 'utf8'))
      } catch (e) {
        if (e.code === 'ENOENT') return null
        throw e
      }
    },
    list() {
      try {
        return readdirSync(dir).filter(f => /^mandate-[0-9a-f]{32}\.json$/.test(f)).map(f => JSON.parse(readFileSync(join(dir, f), 'utf8')))
      } catch (e) {
        if (e.code === 'ENOENT') return []
        throw e
      }
    },
  }
}
