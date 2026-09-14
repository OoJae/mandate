/**
 * Renders in flight, on disk before any money is spent.
 *
 * A render is billed whether or not its derivation is ever recorded. If the
 * process dies between dispatch and the derivation anchoring, this record is
 * what lets `mandate record` finish the job instead of the media going
 * unaccounted, and its idempotency key is what stops a rerun billing twice.
 *
 * Three rules keep a possibly-billed render from being lost:
 *  - its idempotency key never changes once saved, so a rerun is a replay;
 *  - it is never downgraded to `failed`, so it keeps counting against the
 *    ceiling until `mandate record` resolves it;
 *  - every dispatch is an attempt in `attempts[]`, so the history of what was
 *    sent survives a rerun.
 */
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const defaultPendingDir = () => join(process.env.MANDATE_HOME ?? join(homedir(), '.mandate'), 'pending')

const KEY = /^mandate-[0-9a-f]{32}$/

/**
 * Statuses a rerun must not overwrite. `submitted` holds a job id that is the
 * only way to find a render already running; `rendered` holds billed media not
 * yet anchored; `recorded` holds an anchored derivation that a replay would
 * record, and count against the ceiling, a second time. A `dispatching` or
 * `submitted` record that may have been sent is not overwritten either: a rerun
 * resumes it through beginAttempt.
 */
export const PROTECTED_STATUSES = Object.freeze(['recorded', 'submitted', 'rendered'])

export class PendingConflictError extends Error {
  constructor(existing, { inFlight = false } = {}) {
    super(`pending render ${existing.key} is already ${existing.status}; ${inFlight
      ? 'another mandate process is dispatching it now; wait for it to finish'
      : existing.status === 'recorded'
        ? 'it has been recorded, and rendering it again would bill and record it twice'
        : `finish it with \`mandate record --pending ${existing.key}\` instead of rendering it again`}`)
    this.name = 'PendingConflictError'
    this.key = existing.key
    this.status = existing.status
    this.existing = existing
    this.inFlight = inFlight
  }
}

/** A write that would break one of the rules above. Nothing is written. */
export class PendingInvariantError extends Error {
  constructor(message, { key = null } = {}) {
    super(message)
    this.name = 'PendingInvariantError'
    this.key = key
  }
}

/** A pending record that exists but cannot be read or parsed. Local state, not a usage mistake. */
export class PendingReadError extends Error {
  constructor(file, cause) {
    super(`cannot read pending render file ${file}: ${String(cause?.message ?? cause).slice(0, 200)}`)
    this.name = 'PendingReadError'
    this.file = file
    this.cause = cause
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

/**
 * Whether a record's render may have reached Livepeer without a definite
 * outcome. `submitted` and mayHaveStarted say so directly. A `dispatching`
 * record says so when an attempt was marked sent and never got an outcome that
 * ruled a start out; a record from before attempts were kept says so whenever
 * it is `dispatching`, since the only way to know is that it was not finished.
 */
export function mayBeBilled(rec) {
  if (!rec || typeof rec !== 'object') return false
  if (rec.status === 'rendered' || rec.status === 'recorded') return false
  if (rec.mayHaveStarted === true || rec.status === 'submitted') return true
  if (rec.status !== 'dispatching') return false
  if (!Array.isArray(rec.attempts)) return true
  return rec.attempts.some(a => a?.sentAt && a.mayHaveStarted !== false)
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

const processAlive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/** A lock older than this is from a crashed process; the critical sections it guards take milliseconds. */
const STALE_LOCK_MS = 30_000
const LOCK_TRIES = 40
const LOCK_WAIT_MS = 25
/** A short synchronous wait: the store is synchronous, and a held lock is released within milliseconds. */
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/**
 * @param dir where records live
 * @param isAlive whether a process id is still running (injectable for tests).
 *   Liveness is judged on this machine only: two machines sharing one
 *   MANDATE_HOME over a network filesystem are not protected from each other.
 */
export function pendingStore(dir = defaultPendingDir(), { isAlive = processAlive, now = () => new Date() } = {}) {
  const file = key => {
    if (typeof key !== 'string' || !KEY.test(key)) throw new Error(`invalid pending render key: ${String(key).slice(0, 80)}`)
    return join(dir, `${key}.json`)
  }
  const ensureDir = () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
  }
  const read = path => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'))
    } catch (e) {
      if (e.code === 'ENOENT') return null
      throw new PendingReadError(path, e)
    }
  }

  /**
   * Run `fn` holding an exclusive lock on one key. The lock is a file created
   * with 'wx', which fails if another process holds it, so two reruns cannot
   * both read an absent or resumable record and both dispatch.
   */
  const withLock = (key, fn) => {
    ensureDir()
    const lock = `${file(key)}.lock`
    for (let tries = 0; ; tries++) {
      try {
        const fd = openSync(lock, 'wx', 0o600)
        try { writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })) } finally { closeSync(fd) }
        break
      } catch (e) {
        if (e.code !== 'EEXIST') throw e
        if (tries >= LOCK_TRIES) throw new PendingConflictError({ key, status: 'locked' }, { inFlight: true })
        let holder = null
        try { holder = JSON.parse(readFileSync(lock, 'utf8')) } catch { /* half-written or gone: judged by age */ }
        let age = 0
        try { age = Date.now() - statSync(lock).mtimeMs } catch { continue }
        const stale = age > STALE_LOCK_MS || (holder && Number.isInteger(holder.pid) && holder.pid !== process.pid && !isAlive(holder.pid))
        if (stale) rmSync(lock, { force: true })
        else pause(LOCK_WAIT_MS)
      }
    }
    try {
      return fn()
    } finally {
      rmSync(lock, { force: true })
    }
  }

  const store = {
    dir,
    /**
     * Write a record, keeping the rules in the module header against what is
     * already on disk: a changed idempotency key is refused; attempts are kept
     * and never shortened; mayHaveStarted stays true once true; and `failed`
     * over a render that may be billed is saved as `submitted`, with the
     * attempt's own outcome kept as `lastOutcome`. That last one is deliberate:
     * refusing the write would lose the error the caller is about to report,
     * while saving `failed` would drop a possibly-billed render from the
     * ceiling. `allowResolve` lets `mandate record` settle it explicitly.
     * Returns what was written.
     */
    save(record, { allowResolve = false } = {}) {
      ensureDir()
      const target = file(record.key)
      const existing = read(target)
      let next = { ...record }
      if (existing) {
        if (existing.idempotencyKey && next.idempotencyKey !== undefined && next.idempotencyKey !== existing.idempotencyKey) {
          throw new PendingInvariantError(`pending render ${record.key} was sent with idempotency key ${existing.idempotencyKey}; a rerun must reuse it, not ${String(next.idempotencyKey).slice(0, 80)}`, { key: record.key })
        }
        if (existing.idempotencyKey && next.idempotencyKey === undefined) next.idempotencyKey = existing.idempotencyKey
        const before = Array.isArray(existing.attempts) ? existing.attempts : []
        if (next.attempts === undefined) {
          if (before.length) next.attempts = before
        } else if (!Array.isArray(next.attempts) || next.attempts.length < before.length) {
          throw new PendingInvariantError(`pending render ${record.key} has ${before.length} recorded attempt(s); a save cannot drop them`, { key: record.key })
        }
        if (!allowResolve && mayBeBilled(existing)) {
          if (existing.mayHaveStarted === true || existing.status === 'submitted' || next.status === 'failed') next.mayHaveStarted = true
          if (next.status === 'failed') {
            next = { ...next, status: 'submitted', lastOutcome: 'failed' }
          }
        }
      }
      const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
      const written = { ...next, updatedAt: now().toISOString() }
      writeFileSync(tmp, JSON.stringify(written, null, 2), { mode: 0o600 })
      renameSync(tmp, target)
      return written
    },
    /**
     * Save a new render record, but refuse to overwrite one that is submitted,
     * rendered or recorded, or one that may be billed, unless `overwrite` is
     * set. Throws PendingConflictError carrying the existing record. Taken under
     * the key's lock, so two processes cannot both pass the check.
     */
    create(record, { overwrite = false } = {}) {
      return withLock(record.key, () => {
        const existing = read(file(record.key))
        if (existing && !overwrite && (PROTECTED_STATUSES.includes(existing.status) || mayBeBilled(existing))) throw new PendingConflictError(existing)
        // An attempts list, even empty, marks a record as written by this
        // version, so a crash before anything is sent is not taken as a bill.
        return this.save({ ...record, attempts: record.attempts ?? existing?.attempts ?? [] })
      })
    },
    /**
     * Start a dispatch attempt for `record` (status is set to `dispatching`).
     *
     * - No record: it is created, with attempt 1.
     * - Submitted with a job id, rendered or recorded: PendingConflictError.
     * - Dispatching by a live process: PendingConflictError with inFlight.
     * - May be billed (sent with no outcome, submitted without a job id, or
     *   mayHaveStarted): resumed. The stored idempotency key is kept, and a
     *   different `record.idempotencyKey` is refused with PendingInvariantError,
     *   so the dispatch is a replay rather than a second bill.
     * - Otherwise (a clean failure): a new attempt, which may use a new key.
     *
     * Returns { record, resumed, attempt }.
     */
    beginAttempt(record) {
      return withLock(record.key, () => {
        const existing = read(file(record.key))
        const started = now().toISOString()
        const attemptOf = (n, idempotencyKey) => ({ n, startedAt: started, pid: process.pid, idempotencyKey })
        if (!existing) {
          const attempt = attemptOf(1, record.idempotencyKey ?? null)
          return { record: this.save({ ...record, status: 'dispatching', attempts: [attempt] }), resumed: false, attempt }
        }
        // A record from before attempts were kept gets its unknown history as attempt 1.
        const attempts = Array.isArray(existing.attempts)
          ? existing.attempts
          : [{ n: 1, legacy: true, status: existing.status ?? null, jobId: existing.jobId ?? null, idempotencyKey: existing.idempotencyKey ?? null, mayHaveStarted: mayBeBilled(existing) }]
        const last = attempts.at(-1)
        if (existing.status === 'dispatching' && last && !last.endedAt && last.pid !== undefined && last.pid !== process.pid && isAlive(last.pid)) {
          throw new PendingConflictError(existing, { inFlight: true })
        }
        if (existing.status === 'recorded' || existing.status === 'rendered' || (existing.status === 'submitted' && existing.jobId)) {
          throw new PendingConflictError(existing)
        }
        if (mayBeBilled(existing)) {
          const key = existing.idempotencyKey ?? record.idempotencyKey ?? null
          if (record.idempotencyKey !== undefined && existing.idempotencyKey && record.idempotencyKey !== existing.idempotencyKey) {
            throw new PendingInvariantError(`pending render ${record.key} may already be billed under idempotency key ${existing.idempotencyKey}; rerun it with that key, not ${String(record.idempotencyKey).slice(0, 80)}`, { key: record.key })
          }
          const attempt = attemptOf(attempts.length + 1, key)
          const { key: _k, idempotencyKey: _i, createdAt: _c, attempts: _a, ...fresh } = record
          const resumed = {
            ...existing, ...fresh,
            key: existing.key, idempotencyKey: key, createdAt: existing.createdAt ?? record.createdAt,
            status: 'dispatching', mayHaveStarted: true, resumedFrom: existing.status, attempts: [...attempts, attempt],
          }
          return { record: this.save(resumed), resumed: true, attempt }
        }
        const attempt = attemptOf(attempts.length + 1, record.idempotencyKey ?? null)
        const { idempotencyKey: _old, ...kept } = existing
        // A clean earlier failure never reached Livepeer, so its key carries no
        // bill; the new attempt may use its own. The earlier attempts stay.
        const target = file(record.key)
        const written = { ...kept, ...record, status: 'dispatching', attempts: [...attempts, attempt], updatedAt: started }
        const tmp = `${target}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
        writeFileSync(tmp, JSON.stringify(written, null, 2), { mode: 0o600 })
        renameSync(tmp, target)
        return { record: written, resumed: false, attempt }
      })
    },
    /** Mark the current attempt as sent. Call it immediately before run_capability. */
    markSent(key) {
      return withLock(key, () => {
        const rec = read(file(key))
        if (!rec) throw new Error(`no pending render ${key}`)
        const attempts = Array.isArray(rec.attempts) && rec.attempts.length ? [...rec.attempts] : [{ n: 1, startedAt: now().toISOString(), pid: process.pid, idempotencyKey: rec.idempotencyKey ?? null }]
        attempts[attempts.length - 1] = { ...attempts.at(-1), sentAt: now().toISOString() }
        return this.save({ ...rec, attempts })
      })
    },
    /**
     * Close the current attempt with its outcome and merge `fields` into the
     * record. The outcome's status, jobId, error kind and mayHaveStarted go in
     * the attempt history; the record status follows save()'s no-downgrade rule.
     */
    finishAttempt(key, fields = {}) {
      return withLock(key, () => {
        const rec = read(file(key))
        if (!rec) throw new Error(`no pending render ${key}`)
        if (fields.mayHaveStarted !== undefined && typeof fields.mayHaveStarted !== 'boolean') throw new PendingInvariantError('mayHaveStarted must be true or false', { key })
        const attempts = Array.isArray(rec.attempts) && rec.attempts.length ? [...rec.attempts] : [{ n: 1, pid: process.pid, idempotencyKey: rec.idempotencyKey ?? null }]
        const outcome = {
          endedAt: now().toISOString(),
          status: fields.status ?? null,
          jobId: fields.jobId ?? null,
          errorKind: fields.errorKind ?? null,
          ...(fields.mayHaveStarted === undefined ? {} : { mayHaveStarted: fields.mayHaveStarted }),
        }
        attempts[attempts.length - 1] = { ...attempts.at(-1), ...outcome }
        // An earlier attempt that may be billed keeps the whole record possibly
        // billed, even when this one failed cleanly. This attempt's own clean
        // failure is definitive for this attempt only.
        const billedBefore = !Array.isArray(rec.attempts)
          ? rec.mayHaveStarted === true || rec.status === 'submitted'
          : attempts.slice(0, -1).some(a => a?.mayHaveStarted === true || (a?.sentAt && a.mayHaveStarted !== false))
        let next = { ...rec, ...fields, attempts }
        if (billedBefore) {
          next.mayHaveStarted = true
          if (next.status === 'failed') next = { ...next, status: 'submitted', lastOutcome: 'failed' }
        }
        return this.save(next, { allowResolve: true })
      })
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
      return read(file(key))
    },
    list() {
      let names
      try {
        names = readdirSync(dir)
      } catch (e) {
        if (e.code === 'ENOENT') return []
        throw new PendingReadError(dir, e)
      }
      return names.filter(f => /^mandate-[0-9a-f]{32}\.json$/.test(f)).map(f => read(join(dir, f))).filter(Boolean)
    },
  }
  return store
}
