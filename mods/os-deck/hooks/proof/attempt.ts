// One attempt: the content read, each allowed check run, the content read again. The allowance is
// asked again before every check, and nothing runs where what was allowed is no longer what is there.
import type { EngineInterface } from 'claude-code'

import type { ProofAttempt, ProofGrant, ProofResult } from '../../types'
import { mayRun } from './grant'
import { readRevision } from './revision'
import { runCheck } from './runner'
import type { CancelSignal } from './runner'
import { changedSince, readWatched } from './watched'
import type { Watched } from './watched'

export type AttemptRequest = {
  id: string
  session: string
  grant: ProofGrant
  trigger: ProofAttempt['trigger']
  /** The draft's watched files: sha256 of their raw bytes as drawn at the press. */
  watched: Watched
  signal: CancelSignal
  /** Asked before each check: the session and its allowance can end while one runs. */
  isStillAllowed: () => Promise<boolean>
  /** Told as it begins and as each check ends, so the dock can draw it and a reload can find it. */
  onProgress: (attempt: ProofAttempt) => Promise<void>
}

export type Attempted =
  /** `changed`: what the checks run that changed meanwhile, whereupon the attempt cannot verify. */
  | { attempt: ProofAttempt; tails: [checkId: string, text: string][]; changed: string[] }
  | { notRun: string; changed: string[] }

const CHANGED = 'what it runs changed during the attempt'

/** Runs an attempt, or says why none was run. Never throws. */
export async function runAttempt($: EngineInterface, q: AttemptRequest): Promise<Attempted> {
  const { grant, signal } = q
  try {
    if (!(await mayRun(grant, q.session, grant.root)) || !(await q.isStillAllowed())) return { notRun: 'not allowed in this session', changed: [] }
    const start = await readRevision($, grant.root)
    if (!start.ok) return { notRun: `the content cannot be read: ${start.reason}`, changed: [] }
    const paths = q.watched.map(([path]) => path)
    const first = await readWatched($, grant.root, paths)
    // A manual press too: what a changed script runs is not what was allowed. From the disk, as git
    // does not list all that runs.
    let changed = changedSince(q.watched, first)
    if (changed.length > 0) return { notRun: 'what the checks run has changed since it was allowed', changed }

    let attempt: ProofAttempt = {
      id: q.id, session: q.session, root: grant.root, digest: grant.digest, trigger: q.trigger,
      before: start.revision, after: null, head: start.head, startedAt: await $.clock.now(), endedAt: null, checks: [],
    }
    await q.onProgress(attempt)
    const tails: [string, string][] = []
    for (const check of grant.checks) {
      let result: ProofResult
      let reason = signal.cancelled ? 'cancelled' : changed.length > 0 ? CHANGED : !(await q.isStillAllowed()) ? 'no longer allowed' : null
      if (!reason) {
        // Last, and immediately before: an earlier check, or anything else, can rewrite what this one runs.
        changed = changedSince(q.watched, await readWatched($, grant.root, paths), first.stamps)
        if (changed.length > 0) reason = CHANGED
      }
      if (reason) {
        const at = await $.clock.now()
        result = {
          id: check.id, kind: check.kind, description: check.description, execution: signal.cancelled ? 'cancelled' : 'unavailable',
          source: 'os-deck-run', startedAt: at, endedAt: at, revision: start.revision, exitCode: null, count: null, summary: '', reason,
        }
      } else {
        const ran = await runCheck($, grant.root, check, start.revision, signal)
        result = ran.result
        // Immediately after, by size and time as well: changed and put back ran all the same.
        changed = changedSince(q.watched, await readWatched($, grant.root, paths), first.stamps)
        const hasFailed = result.execution === 'exited' && (result.exitCode !== 0 || (result.count?.failed ?? 0) > 0)
        // A failure is never traded for the less certain answer.
        if (changed.length > 0 && !hasFailed) result = { ...result, execution: 'unavailable', exitCode: null, count: null, reason: CHANGED }
        tails.push([check.id, ran.tail])
      }
      attempt = { ...attempt, checks: [...attempt.checks, result] }
      await q.onProgress(attempt)
    }
    const end = await readRevision($, grant.root)
    // With no content after, nothing it passed can verify, an earlier check's pass included.
    attempt = { ...attempt, after: end.ok && changed.length === 0 ? end.revision : null, endedAt: await $.clock.now() }
    await q.onProgress(attempt)
    return { attempt, tails, changed }
  } catch {
    // Whatever was told as progress has no end, so it reads as interrupted.
    return { notRun: 'the attempt was interrupted', changed: [] }
  }
}
