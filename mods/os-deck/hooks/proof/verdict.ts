// The only producer of "verified". Pure: what is known goes in, a state and why comes out. The verdict
// is a root's, at one revision of its content; a task borrows it only where the work is shown to be its
// own and still there. Displayed, never stored.
import type { ProofAttempt, ProofClaim, ProofGrant, ProofReview } from '../../types'
import { outcomeOf } from './checks'

export type ProofState = 'pending' | 'verifying' | 'verified' | 'failed' | 'inconclusive' | 'stale'
export type Verdict = { state: ProofState; reason: string }
export type RootVerdict = Verdict & { attempt: ProofAttempt | null }

export type RootFacts = {
  root: string
  session: string
  grant: ProofGrant | null
  /** The content's revision now; null where it cannot be read. */
  current: string | null
  /** In the order they were recorded, from session state alone: the store's are history, never evidence. */
  attempts: readonly ProofAttempt[]
  /** The attempt this load is running; any other without an end was interrupted. */
  liveId: string | null
}

export const rootVerdict = (f: RootFacts): RootVerdict => {
  const { grant, current } = f
  if (!grant || grant.session !== f.session || grant.root !== f.root) return { state: 'pending', reason: 'not allowed in this session', attempt: null }
  let attempt: ProofAttempt | null = null
  for (const a of f.attempts) {
    if (a.session !== f.session || a.root !== f.root || a.digest !== grant.digest) continue
    // The one recorded last, never the one the clock calls newest.
    attempt = a
  }
  // Not from before this allowance. Where the last is, no earlier one stands in for it: that would keep
  // a green over the failure after it, were the clock set back.
  if (!attempt) return { state: 'pending', reason: grant.auto ? 'runs when the turn ends' : 'press verify', attempt }
  if (!(attempt.startedAt >= grant.at)) {
    // Only a failure is still said of it: that is never the looser answer.
    const last = attempt
    if (current && (current === last.before || current === last.after))
      for (const check of grant.checks) {
        const outcome = check.required ? outcomeOf(check, last.checks.find(r => r.id === check.id)) : null
        if (outcome?.result === 'fail') return { state: 'failed', reason: `${check.id}: ${outcome.reason}`, attempt: last }
      }
    return { state: 'pending', reason: 'press verify', attempt: null }
  }
  const is = (state: ProofState, reason: string): RootVerdict => ({ state, reason, attempt })
  if (attempt.endedAt === null && attempt.id === f.liveId) return is('verifying', 'checks are running')
  if (!current) return is('inconclusive', 'the content of this repository cannot be read')

  const { before, after, checks } = attempt
  const required = grant.checks.filter(c => c.required)
  const results = required.map(check => {
    const found = checks.filter(r => r.id === check.id)
    return { check, found, outcome: outcomeOf(check, found.length === 1 ? found[0] : undefined) }
  })
  // A failure is shown over anything less certain, on either state of the files it was seen on.
  const failed = results.find(x => x.outcome.result === 'fail')
  if (failed && (current === before || current === after)) return is('failed', `${failed.check.id}: ${failed.outcome.reason}`)
  if (typeof attempt.endedAt !== 'number' || !Number.isFinite(attempt.endedAt)) return is('inconclusive', 'the run was interrupted')
  if (!after) return is('inconclusive', checks.find(r => r.reason)?.reason ?? 'the run was interrupted')
  if (before !== after && current === after) return is('inconclusive', 'the files changed while the checks ran')
  if (current !== before || current !== after) return is('stale', failed ? 'changed since it failed' : 'changed since the checks ran')
  if (required.length === 0) return is('inconclusive', 'no check is required')
  for (const { check, found, outcome } of results) {
    if (found.length > 1) return is('inconclusive', `${check.id}: more than one result`)
    if (outcome.result !== 'pass') return is('inconclusive', `${check.id}: ${outcome.reason}`)
    if (found[0]?.revision !== before) return is('inconclusive', `${check.id}: ran on other content`)
  }
  return is('verified', results.map(x => `${x.check.id}: ${x.outcome.reason}`).join(', '))
}

export type RootNow = {
  verdict: Verdict
  /** The hash of a path now, null where it is gone; the whole is null where it cannot be read. */
  hashes: ReadonlyMap<string, string> | null
}

// The worst first. A failure is never hidden by anything; a green by everything.
const WORST: readonly ProofState[] = ['failed', 'verifying', 'inconclusive', 'stale', 'pending', 'verified']

export const taskVerdict = (claim: ProofClaim, roots: ReadonlyMap<string, RootNow>, session: string): Verdict => {
  if (claim.session !== session) return { state: 'pending', reason: 'claimed in another session' }
  if (claim.withdrawn) return { state: 'pending', reason: 'reopened' }
  const changes = claim.changes.filter(c => c.paths.length > 0)
  const found: Verdict[] = []
  if (!claim.hasBaseline) found.push({ state: 'inconclusive', reason: 'its start was not seen, so what it changed is not known' })
  else if (changes.length === 0) found.push({ state: 'inconclusive', reason: 'no change seen in an allowed repository' })
  if (claim.outside.length > 0) found.push({ state: 'inconclusive', reason: `edited outside the allowed repositories: ${claim.outside[0]}` })
  for (const change of changes) {
    if (change.overlap.length > 0) found.push({ state: 'inconclusive', reason: 'attribution unknown: another task or agent worked at the same time' })
    const now = roots.get(change.root)
    if (!now) {
      found.push({ state: 'pending', reason: 'its repository is not allowed in this session' })
      continue
    }
    found.push(now.verdict)
    const hashes = now.hashes
    if (!hashes) found.push({ state: 'inconclusive', reason: 'the content it changed cannot be read' })
    else if (change.paths.some(p => (hashes.get(p.path) ?? null) !== p.hash)) found.push({ state: 'stale', reason: 'changed since this claim' })
  }
  for (const state of WORST) {
    const hit = found.find(v => v.state === state)
    if (hit) return hit
  }
  return { state: 'inconclusive', reason: 'no evidence' }
}

/** The other axis: a person's review, good only for the content they were looking at. */
export const isReviewed = (claim: ProofClaim, review: ProofReview | undefined, current: ReadonlyMap<string, string | null>): boolean =>
  !!review &&
  !claim.withdrawn &&
  review.claim === claim.id &&
  review.revisions.length > 0 &&
  claim.changes.every(c => review.revisions.some(r => r.root === c.root)) &&
  review.revisions.every(r => r.revision !== '' && current.get(r.root) === r.revision)
