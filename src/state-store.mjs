/**
 * What this machine has already seen, so a later read cannot quietly forget it.
 *
 * Anchored Knowledge Assets are append-only. Once a resolver has seen a UAL, a
 * read that no longer shows it is incomplete, not evidence the asset went away;
 * and once it has accepted a revocation, no later read may un-revoke it. The
 * store remembers both per context graph.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** The local state file exists but cannot be read or parsed. A reader must stop, not start from empty memory. */
export class StateReadError extends Error {}

const empty = () => ({ version: 1, knownUals: {}, revocations: {} })

function normalise(data) {
  const out = empty()
  if (data && typeof data === 'object') {
    for (const [publisher, uals] of Object.entries(data.knownUals ?? {})) {
      if (Array.isArray(uals)) out.knownUals[publisher] = uals.filter(u => typeof u === 'string')
    }
    for (const [grantId, r] of Object.entries(data.revocations ?? {})) {
      if (r && typeof r === 'object') out.revocations[grantId] = r
    }
  }
  return out
}

/** Merge what a consistent read saw into a stored record. Never removes anything. */
export function remember(record, { publisher, uals = [], revocations = [] }) {
  const next = normalise(record)
  if (publisher) next.knownUals[publisher] = [...new Set([...(next.knownUals[publisher] ?? []), ...uals])].sort()
  for (const r of revocations) {
    if (!next.revocations[r.stateOf]) {
      next.revocations[r.stateOf] = { id: r.id, ual: r.ual, txHash: r.txHash ?? null, publisher: r.publisher, stateOf: r.stateOf, stateAt: r.stateAt ?? null }
    }
  }
  return next
}

export function memoryStateStore() {
  const records = new Map()
  return {
    load: key => normalise(records.get(key)),
    save: (key, record) => { records.set(key, structuredClone(normalise(record))) },
  }
}

export const defaultStateDir = () => join(process.env.MANDATE_HOME ?? join(homedir(), '.mandate'), 'state')

/** One JSON file per context graph under `dir` (mode 0700), written atomically with mode 0600. */
export function fileStateStore(dir = defaultStateDir()) {
  const file = key => join(dir, `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
  return {
    load(key) {
      try {
        return normalise(JSON.parse(readFileSync(file(key), 'utf8')))
      } catch (e) {
        if (e.code === 'ENOENT') return empty()
        throw new StateReadError(`cannot read local state ${file(key)}: ${e.message}`)
      }
    },
    save(key, record) {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      chmodSync(dir, 0o700)
      const target = file(key)
      const tmp = `${target}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(normalise(record), null, 2), { mode: 0o600 })
      renameSync(tmp, target)
    },
  }
}
