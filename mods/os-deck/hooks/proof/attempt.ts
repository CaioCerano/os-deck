// One attempt: the content read, each allowed check run, the content read again. The allowance is
// asked again before every check, and nothing runs where what was allowed is no longer what is there.
import type { EngineInterface } from 'claude-code'

import type { ProofAttempt, ProofGrant, ProofResult } from '../../types'
import { mayRun } from './grant'
import { changedWatched } from './lifecycle'
import { readRevision } from './revision'
import { runCheck } from './runner'
import type { CancelSignal } from './runner'

export type AttemptRequest = {
  id: string
  session: string
  grant: ProofGrant
  trigger: ProofAttempt['trigger']
  /** The watched files as they were when allowed. */
  watched: readonly [path: string, hash: string | null][]
  signal: CancelSignal
  /** Asked before each check: the session and its allowance can end while one runs. */
  isStillAllowed: () => Promise<boolean>
  /** Told as it begins and as each check ends, so the dock can draw it and a reload can find it. */
  onProgress: (attempt: ProofAttempt) => Promise<void>
}

export type Attempted =
  | { attempt: ProofAttempt; tails: [checkId: string, text: string][] }
  | { notRun: string; changed: string[] }

/** Runs an attempt, or says why none was run. Never throws. */
export async function runAttempt($: EngineInterface, q: AttemptRequest): Promise<Attempted> {
  const { grant, signal } = q
  try {
    if (!(await mayRun(grant, q.session, grant.root)) || !(await q.isStillAllowed())) return { notRun: 'not allowed in this session', changed: [] }
    const start = await readRevision($, grant.root)
    if (!start.ok) return { notRun: `the content cannot be read: ${start.reason}`, changed: [] }
    // A manual press too: what a changed script runs is not what was allowed.
    const changed = changedWatched(q.watched, start.hashes)
    if (changed.length > 0) return { notRun: 'what the checks run has changed since it was allowed', changed }

    let attempt: ProofAttempt = {
      id: q.id, session: q.session, root: grant.root, digest: grant.digest, trigger: q.trigger,
      before: start.revision, after: null, head: start.head, startedAt: await $.clock.now(), endedAt: null, checks: [],
    }
    await q.onProgress(attempt)
    const tails: [string, string][] = []
    for (const check of grant.checks) {
      let result: ProofResult
      // An earlier check can rewrite what this one runs.
      const now = q.watched.length > 0 && attempt.checks.length > 0 ? await readRevision($, grant.root) : start
      const isSame = now.ok && changedWatched(q.watched, now.hashes).length === 0
      const reason = signal.cancelled ? 'cancelled' : !isSame ? 'what it runs changed during the attempt' : !(await q.isStillAllowed()) ? 'no longer allowed' : null
      if (reason) {
        const at = await $.clock.now()
        result = {
          id: check.id, kind: check.kind, description: check.description, execution: signal.cancelled ? 'cancelled' : 'unavailable',
          source: 'os-deck-run', startedAt: at, endedAt: at, revision: start.revision, exitCode: null, count: null, summary: '', reason,
        }
      } else {
        const ran = await runCheck($, grant.root, check, start.revision, signal)
        result = ran.result
        tails.push([check.id, ran.tail])
      }
      attempt = { ...attempt, checks: [...attempt.checks, result] }
      await q.onProgress(attempt)
    }
    const end = await readRevision($, grant.root)
    attempt = { ...attempt, after: end.ok ? end.revision : null, endedAt: await $.clock.now() }
    await q.onProgress(attempt)
    return { attempt, tails }
  } catch {
    // Whatever was told as progress has no end, so it reads as interrupted.
    return { notRun: 'the attempt was interrupted', changed: [] }
  }
}
