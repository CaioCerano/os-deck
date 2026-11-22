// What the dock draws of Agent Proof, worked out from session state each time it draws. Evidence is this
// session's state alone: what was loaded from the store is only ever a line of history.
import type { ProofAttempt, ProofSession, ProofWork } from '../../types'
import { outcomeOf } from './checks'
import { reviewWorthy } from './lifecycle'
import type { ProofViewModel, RootView } from './model'
import { isReviewed, rootVerdict, taskVerdict } from './verdict'
import type { RootNow } from './verdict'

/** An earlier run in a word. Never "verified": that is said of content as it is now. */
export const pastLabel = (a: ProofAttempt): string =>
  a.checks.some(r => (r.execution === 'exited' && r.exitCode !== null && r.exitCode !== 0) || (r.count?.failed ?? 0) > 0)
    ? 'failed'
    : a.endedAt === null || a.checks.some(r => r.execution !== 'exited')
      ? 'incomplete'
      : 'ran'

/** The attempts this load is running, by root: any other without an end was interrupted. */
export type LiveRuns = ReadonlyMap<string, string>

export const rootsNow = (p: ProofSession, w: ProofWork, live: LiveRuns): RootView[] =>
  p.allowed.map(({ grant }) => {
    const { root } = grant
    const seen = w.seen.find(s => s.root === root)
    const verdict = rootVerdict({ root, session: p.session, grant, current: seen?.revision ?? null, attempts: p.attempts, liveId: live.get(root) ?? null })
    const { attempt } = verdict
    let baseline: RootView['baseline'] = null
    // Only a whole run, on content still here, can be accepted as what to expect.
    if (attempt && typeof attempt.endedAt === 'number' && attempt.before === attempt.after && seen?.revision === attempt.before) {
      for (const check of grant.checks) {
        if (!check.count || check.count.minPassed !== null) continue
        const result = attempt.checks.find(r => r.id === check.id)
        const count = result?.count
        if (result && count && count.passed > 0 && count.failed === 0 && result.exitCode === 0 && outcomeOf(check, result).result === 'inconclusive')
          baseline = { attemptId: attempt.id, checkId: check.id, passed: count.passed, skipped: count.skipped }
      }
    }
    return {
      root,
      name: root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? root,
      grant,
      // An unreadable root says which kind of unreadable.
      verdict: verdict.state === 'inconclusive' && seen && !seen.revision && seen.reason ? { ...verdict, reason: `${verdict.reason}: ${seen.reason}` } : verdict,
      revision: seen?.revision ?? null,
      checkedAt: seen?.at ?? null,
      paused: p.paused.find(x => x.root === root)?.paths ?? [],
      // Over every claim, not the newest of an id: a later empty one would take the earlier's place.
      unreviewed: p.claims.filter(c =>
        c.session === p.session &&
        (!c.hasBaseline || c.changes.some(change => change.root === root && change.paths.length > 0)) &&
        !p.reviews.some(r => r.claim === c.id),
      ).length,
      baseline,
    }
  })

export const presentProof = (p: ProofSession, w: ProofWork, live: LiveRuns, log: ProofViewModel['log'], now: number): ProofViewModel => {
  const roots = rootsNow(p, w, live)
  const at = new Map<string, RootNow>()
  for (const r of roots) {
    const seen = w.seen.find(s => s.root === r.root)
    at.set(r.root, { verdict: r.verdict, hashes: seen?.revision ? new Map(seen.files) : null })
  }
  const current = new Map(roots.map(r => [r.root, r.revision ?? '']))
  // One row a task: its newest claim of this session.
  const newest = new Map(p.claims.filter(c => c.session === p.session).map(c => [c.taskId, c]))
  const tasks = [...newest.values()].map(claim => {
    const own = claim.changes.filter(c => c.paths.length > 0).map(c => c.root)
    const shown = own.length > 0 ? own : roots.map(r => r.root)
    const runs = [...p.past, ...p.attempts.map(a => ({ root: a.root, at: a.startedAt, label: pastLabel(a) }))]
    return {
      claim,
      verdict: taskVerdict(claim, at, p.session),
      isReviewed: isReviewed(claim, p.reviews.filter(r => r.claim === claim.id).pop(), current),
      drawn: shown.map(root => ({ root, revision: current.get(root) ?? '' })),
      reviewWorthy: reviewWorthy(claim.changes.flatMap(c => c.paths.map(x => x.path))),
      earlier: runs.filter(x => shown.includes(x.root)).sort((a, b) => b.at - a.at).slice(0, 5).map(({ at: ran, label }) => ({ at: ran, label })),
    }
  })
  return { now, roots, tasks, openClaim: p.openClaim, draft: p.draft, log, notSaved: p.notSaved }
}
