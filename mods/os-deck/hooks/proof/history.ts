// Agent Proof's records in the plugin store, a file any process of the person's can write. So it is
// read as hostile: each field checked, a malformed record dropped, and what is read made unable to
// stand as evidence. One key a record, so two sessions never write over each other.
import type { EngineInterface } from 'claude-code'

import type { ProofAttempt, ProofCheck, ProofClaim, ProofCount, ProofExecution, ProofKind, ProofResult, ProofReview } from '../../types'
import { dirKey, shorten } from '../core'
import { flushHistory, inTurn } from '../history'
import { redact } from '../redact'
import { setupProblem, suggestedChecks } from './grant'
import type { ProofRecords } from './model'
import { isLocalPath } from './revision'

// Neither `os-deck:day:` nor `plan-history:`, the prefixes hooks/history.ts prunes.
const PREFIX = 'os-deck:proof:'
/**
 * a attempt, c claim, r review, d definition. Each record's bytes, and how many a root and all roots
 * keep: 1.4 MiB at the most, of the 4 MiB the whole dock shares.
 */
const LIMITS = {
  a: { bytes: 6144, perRoot: 50, inAll: 100 },
  c: { bytes: 5120, perRoot: 50, inAll: 100 },
  r: { bytes: 2048, perRoot: 50, inAll: 100 },
  d: { bytes: 4096, perRoot: 1, inAll: 24 },
} as const
type Kind = keyof typeof LIMITS
/** Deletes a save: each rewrites the store's file. */
const MAX_DELETES = 64
/** A time further ahead than this is forged or broken, and would outlive every true record. */
const AHEAD_MS = 86_400_000
/** On the session of every record read back, which is then no live session's. */
const STORED = 'stored:'

const KINDS: readonly string[] = ['test', 'typecheck', 'lint', 'build'] satisfies ProofKind[]
const EXECUTIONS: readonly string[] = ['queued', 'running', 'exited', 'timed-out', 'cancelled', 'interrupted', 'unavailable'] satisfies ProofExecution[]

// ---------------------------------------------------------------- fields

type Fields = Record<string, unknown>
const fieldsOf = (v: unknown): Fields | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Fields) : null)

/** An id or a hash: short, all of it showing, and nothing redaction would change. */
const idOf = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' && v.length <= 160 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(v) && redact(v) === v ? v : null
/** Free text: masked whole, then cut, so no cut splits a secret out of its rule. */
const textOf = (v: unknown, max: number): string | null => (typeof v === 'string' ? shorten(redact(v), max) : null)
const timeOf = (v: unknown): number | null => (typeof v === 'number' && v >= 0 && v <= 8.64e15 ? Math.floor(v) : null)
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

/** The first `max` of a list; null where it is no list, or one of those is malformed. */
const listOf = <T>(v: unknown, max: number, each: (x: unknown) => T | null): T[] | null => {
  if (!Array.isArray(v)) return null
  const out: T[] = []
  for (const x of v.slice(0, max)) {
    const item = each(x)
    if (item === null) return null
    out.push(item)
  }
  return out
}

const countOf = (v: unknown): ProofCount | null => {
  const f = fieldsOf(v)
  return f && isCount(f.passed) && isCount(f.failed) && isCount(f.skipped) ? { passed: f.passed, failed: f.failed, skipped: f.skipped } : null
}

const resultOf = (v: unknown, width: number): ProofResult | null => {
  const f = fieldsOf(v)
  if (!f || f.source !== 'os-deck-run' || !KINDS.includes(f.kind as string) || !EXECUTIONS.includes(f.execution as string)) return null
  const id = idOf(f.id)
  const revision = idOf(f.revision)
  const description = textOf(f.description, Math.min(width, 80))
  const summary = textOf(f.summary, width)
  const reason = textOf(f.reason, Math.min(width, 120))
  const startedAt = timeOf(f.startedAt)
  const endedAt = timeOf(f.endedAt)
  const count = countOf(f.count)
  if (!id || !revision || description === null || summary === null || startedAt === null) return null
  if ((f.reason !== null && reason === null) || (f.endedAt !== null && endedAt === null) || (f.count !== null && !count)) return null
  if (f.exitCode !== null && !Number.isSafeInteger(f.exitCode)) return null
  return { id, kind: f.kind as ProofKind, description, execution: f.execution as ProofExecution, source: 'os-deck-run', startedAt, endedAt, revision, exitCode: f.exitCode as number | null, count, summary, reason }
}

const attemptOf = (v: unknown, width: number): ProofAttempt | null => {
  const f = fieldsOf(v)
  // Cut short, a list of results would hide the one that failed.
  if (!f || (f.trigger !== 'auto' && f.trigger !== 'manual') || !Array.isArray(f.checks) || f.checks.length > 8) return null
  const id = idOf(f.id)
  const session = idOf(f.session)
  const root = textOf(f.root, 400)
  const digest = idOf(f.digest)
  const before = idOf(f.before)
  const after = idOf(f.after)
  const head = idOf(f.head)
  const startedAt = timeOf(f.startedAt)
  const endedAt = timeOf(f.endedAt)
  const checks = listOf(f.checks, 8, x => resultOf(x, width))
  if (!id || !session || !root || !digest || !before || startedAt === null || !checks) return null
  if ((f.after !== null && !after) || (f.head !== null && !head) || (f.endedAt !== null && endedAt === null)) return null
  return { id, session, root, digest, trigger: f.trigger, before, after, head, startedAt, endedAt, checks }
}

/** `size` bounds every list. At least one is kept of each, so cutting never turns some into none. */
const claimOf = (v: unknown, size: number): ProofClaim | null => {
  const f = fieldsOf(v)
  if (!f || typeof f.hasBaseline !== 'boolean' || typeof f.withdrawn !== 'boolean') return null
  const id = idOf(f.id)
  const session = idOf(f.session)
  const taskId = idOf(f.taskId)
  const agentId = idOf(f.agentId)
  const subject = textOf(f.subject, 160)
  const description = textOf(f.description, 300)
  const at = timeOf(f.at)
  const outside = listOf(f.outside, Math.min(size, 8), x => textOf(x, 200))
  const changes = listOf(f.changes, Math.min(size, 8), x => {
    const change = fieldsOf(x)
    const root = textOf(change?.root, 300)
    const overlap = listOf(change?.overlap, Math.min(size, 8), idOf)
    const paths = listOf(change?.paths, size, y => {
      const p = fieldsOf(y)
      const path = textOf(p?.path, 200)
      const hash = idOf(p?.hash)
      return p && path !== null && (p.hash === null || hash) ? { path, hash } : null
    })
    return root && overlap && paths ? { root, paths, overlap } : null
  })
  if (!id || !session || !taskId || subject === null || description === null || at === null || !outside || !changes) return null
  if (f.agentId !== null && !agentId) return null
  return { id, session, taskId, subject, description, agentId, at, hasBaseline: f.hasBaseline, changes, outside, withdrawn: f.withdrawn }
}

const reviewOf = (v: unknown): ProofReview | null => {
  const f = fieldsOf(v)
  // Never cut: a review of fewer roots holds in more cases.
  if (!f || !Array.isArray(f.revisions) || f.revisions.length === 0 || f.revisions.length > 16) return null
  const claim = idOf(f.claim)
  const at = timeOf(f.at)
  const revisions = listOf(f.revisions, 16, x => {
    const r = fieldsOf(x)
    const root = textOf(r?.root, 300)
    const revision = idOf(r?.revision)
    return root && revision ? { root, revision } : null
  })
  return claim && at !== null && revisions ? { claim, revisions, at } : null
}

/** A definition, whole or not at all: one required check fewer would pass more easily. */
const checksOf = (root: string, v: unknown): ProofCheck[] | null => {
  if (!Array.isArray(v) || v.length > 8) return null
  const plain = listOf(v, 8, x => {
    const f = fieldsOf(x)
    if (!f || !idOf(f.id) || typeof f.kind !== 'string' || typeof f.dir !== 'string' || typeof f.description !== 'string') return null
    if (!Array.isArray(f.argv) || !f.argv.every(a => typeof a === 'string')) return null
    if (f.count === undefined) return f
    const count = fieldsOf(f.count)
    if (!count || typeof count.parser !== 'string') return null
    if (count.minPassed !== null && !isCount(count.minPassed)) return null
    return isCount(count.maxSkipped) ? f : null
  })
  if (!plain) return null
  // suggestedChecks reads only what was shown above to be of its type, and judges it.
  const checks = suggestedChecks(plain)
  return checks.length === plain.length && setupProblem(root, checks) === null ? checks : null
}

// ---------------------------------------------------------------- keys

/** One spelling of a root: git's and the engine's differ in slashes and, on Windows, in case. */
const spellRoot = (root: string) => {
  const s = root.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s
}
const keyOf = (kind: Kind, root: string, at: number, id: string) => `${PREFIX}${kind}:${dirKey(spellRoot(root))}:${at}:${dirKey(id)}`
const attemptKey = (root: string, a: ProofAttempt) => keyOf('a', root, a.startedAt, `${a.session} ${a.id}`)
const claimKey = (root: string, c: ProofClaim) => keyOf('c', root, c.at, `${c.session} ${c.id}`)
const reviewKey = (root: string, r: ProofReview) => keyOf('r', root, r.at, r.claim)

type Key = { key: string; kind: Kind; root: string; at: number }

const keyParts = (key: string): Key | null => {
  if (key.length > 255 || !key.startsWith(PREFIX)) return null
  const m = /^([acrd]):([0-9a-z]{1,7}-[0-9a-z]{1,7}):(\d{1,16}):[0-9a-z]{1,7}-[0-9a-z]{1,7}$/.exec(key.slice(PREFIX.length))
  return m ? { key, kind: m[1] as Kind, root: m[2] as string, at: Number(m[3]) } : null
}

const newestFirst = (a: Key, b: Key) => b.at - a.at || (a.key < b.key ? 1 : -1)

// ---------------------------------------------------------------- saving

/**
 * Which keys go, from the keys alone: no value is read, and it is one sort however many there are. The
 * key being saved always stays.
 */
const doomedOf = (all: readonly string[], saving: string, now: number): string[] => {
  const doomed: string[] = []
  const records: Key[] = []
  for (const key of new Set([saving, ...all])) {
    if (!key.startsWith(PREFIX)) continue
    const parts = keyParts(key)
    if (parts && (key === saving || parts.at <= now + AHEAD_MS)) records.push(parts)
    else if (key !== saving) doomed.push(key)
  }
  records.sort((a, b) => (a.key === saving ? -1 : b.key === saving ? 1 : newestFirst(a, b)))
  const kept = new Map<string, number>()
  for (const { key, kind, root } of records) {
    const ofRoot = kept.get(`${kind}:${root}`) ?? 0
    const ofKind = kept.get(kind) ?? 0
    if (ofRoot >= LIMITS[kind].perRoot || ofKind >= LIMITS[kind].inAll) doomed.push(key)
    else kept.set(`${kind}:${root}`, ofRoot + 1).set(kind, ofKind + 1)
  }
  return doomed.slice(0, MAX_DELETES)
}

/** Deletes what is past the bounds, and says how many went. */
async function prune($: EngineInterface, saving: string, now: number): Promise<number> {
  try {
    const doomed = doomedOf(await $.store.keys(), saving, now)
    for (const key of doomed) await $.store.delete(key)
    return doomed.length
  } catch {
    return 0
  }
}

async function write($: EngineInterface, key: string, value: unknown, now: number): Promise<boolean> {
  try {
    await $.store.set(key, value)
  } catch {
    // Perhaps full: once more, only if records past the bounds made room.
    if ((await prune($, key, now)) === 0) return false
    await $.store.set(key, value)
  }
  // After the write, so whichever session saves last sees every record and leaves the bound true.
  await prune($, key, now)
  return true
}

const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length

/** The first form that fits its bound, as stored beside its root; null where none does. */
const fitted = <T>(kind: Kind, root: string, forms: readonly (() => T | null)[]): { record: T; value: unknown } | null => {
  const shownRoot = redact(spellRoot(root))
  for (const form of forms) {
    const record = form()
    if (record === null) return null
    const value = { root: shownRoot, record }
    if (bytesOf(value) <= LIMITS[kind].bytes) return { record, value }
  }
  return null
}

/** Saves an attempt, again under the same key as it ends. */
export async function saveAttempt($: EngineInterface, attempt: ProofAttempt): Promise<boolean> {
  try {
    const root = attempt.root
    if (!isLocalPath(root)) return false
    const made = fitted('a', root, [160, 60, 20].map(width => () => attemptOf(attempt, width)))
    if (!made) return false
    // Queued, so the attempt's end is not overtaken by its start.
    return await inTurn(async () => write($, attemptKey(root, made.record), made.value, await $.clock.now()))
  } catch {
    return false
  }
}

/** Saves a claim, again under the same key when it is withdrawn. */
export async function saveClaim($: EngineInterface, root: string, claim: ProofClaim): Promise<boolean> {
  try {
    if (!isLocalPath(root)) return false
    const made = fitted('c', root, [40, 12, 4, 1].map(size => () => claimOf(claim, size)))
    if (!made) return false
    return await inTurn(async () => write($, claimKey(root, made.record), made.value, await $.clock.now()))
  } catch {
    return false
  }
}

export async function saveReview($: EngineInterface, root: string, review: ProofReview): Promise<boolean> {
  try {
    if (!isLocalPath(root)) return false
    const made = fitted('r', root, [() => reviewOf(review)])
    if (!made) return false
    return await inTurn(async () => write($, reviewKey(root, made.record), made.value, await $.clock.now()))
  } catch {
    return false
  }
}

/** Saves what to suggest next time. Never the allowance. */
export async function saveChecks($: EngineInterface, root: string, checks: readonly ProofCheck[]): Promise<boolean> {
  try {
    const made = fitted('d', root, [() => checksOf(root, checks)])
    if (!made) return false
    return await inTurn(async () => {
      const now = await $.clock.now()
      return write($, keyOf('d', root, Math.floor(now), 'checks'), made.value, now)
    })
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- loading

const storedSession = (session: string) => (session.startsWith(STORED) ? session : `${STORED}${session}`)

// A verdict takes an attempt of the live session and a claim whose start was seen: these are neither.
// A run whose end was not saved is shown interrupted.
const asHistory = (a: ProofAttempt): ProofAttempt => ({
  ...a,
  session: storedSession(a.session),
  checks: a.checks.map(r => (r.execution === 'queued' || r.execution === 'running' ? { ...r, execution: 'interrupted' } : r)),
})
const asClaimed = (c: ProofClaim): ProofClaim => ({ ...c, session: storedSession(c.session), hasBaseline: false })

/** A root's records, oldest first. Nothing in them allows or verifies. Never throws. */
export async function loadRecords($: EngineInterface, root: string): Promise<ProofRecords> {
  const out: ProofRecords = { claims: [], attempts: [], reviews: [], checks: [] }
  try {
    if (!isLocalPath(root)) return out
    await flushHistory()
    const now = await $.clock.now()
    const here = dirKey(spellRoot(root))
    const shownRoot = redact(spellRoot(root))
    const mine: Key[] = []
    for (const key of await $.store.keys()) {
      const parts = keyParts(key)
      if (parts && parts.root === here && parts.at <= now + AHEAD_MS) mine.push(parts)
    }
    mine.sort(newestFirst)
    const taken: Record<Kind, number> = { a: 0, c: 0, r: 0, d: 0 }
    const chosen = mine.filter(x => (taken[x.kind] += 1) <= LIMITS[x.kind].perRoot)
    const values = await Promise.all(chosen.map(x => $.store.get(x.key).catch(() => null)))
    const reviewed = new Set<string>()
    for (let i = 0; i < chosen.length; i++) {
      const { key, kind } = chosen[i] as Key
      const stored = fieldsOf(values[i])
      // Two roots can share a hash, so the record says whose it is.
      if (!stored || stored.root !== shownRoot) continue
      try {
        if (bytesOf(stored) > LIMITS[kind].bytes) continue
        // Each must be under the key it would be saved at, or one record could be many.
        if (kind === 'a') {
          const attempt = attemptOf(stored.record, 160)
          if (attempt && attemptKey(root, attempt) === key) out.attempts.push({ ...asHistory(attempt), root })
        } else if (kind === 'c') {
          const claim = claimOf(stored.record, 40)
          if (claim && claimKey(root, claim) === key) out.claims.push(asClaimed(claim))
        } else if (kind === 'r') {
          const review = reviewOf(stored.record)
          if (!review || reviewKey(root, review) !== key || reviewed.has(review.claim)) continue
          reviewed.add(review.claim)
          out.reviews.push(review)
        } else {
          out.checks = checksOf(root, stored.record) ?? []
        }
      } catch {
        // That record alone is dropped.
      }
    }
    out.attempts.reverse()
    out.claims.reverse()
    out.reviews.reverse()
  } catch {
    // A store that cannot be read is no history.
  }
  return out
}
