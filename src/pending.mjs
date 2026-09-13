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
