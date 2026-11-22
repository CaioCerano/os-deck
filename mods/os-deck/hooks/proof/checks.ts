// What one executed check shows, worked out from what was observed each time it is asked. Nothing
// stores "pass", so nothing stored can be a pass.
import type { ProofCheck, ProofResult } from '../../types'

export type Outcome = { result: 'pass' | 'fail' | 'inconclusive'; reason: string }

const inconclusive = (reason: string): Outcome => ({ result: 'inconclusive', reason })
const fail = (reason: string): Outcome => ({ result: 'fail', reason })
const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

const NOT_FINISHED: Record<Exclude<ProofResult['execution'], 'exited'>, string> = {
  queued: 'not run',
  running: 'still running',
  'timed-out': 'timed out',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
  unavailable: 'could not run',
}

/**
 * A failure needs only one sign: a non-zero exit, or a failed test. A pass needs every sign: a clean
 * exit, and for a test a count with none failed and within what the person accepted.
 */
export const outcomeOf = (check: ProofCheck, r: ProofResult | undefined): Outcome => {
  if (!r) return inconclusive('no result')
  if (r.id !== check.id || r.kind !== check.kind || r.source !== 'os-deck-run') return inconclusive('the result is not of this check')
  if (r.execution !== 'exited') return inconclusive(NOT_FINISHED[r.execution] ?? 'did not finish')
  const c = r.count
  if (c && isCount(c.failed) && c.failed > 0) return fail(`${c.failed} failed`)
  if (typeof r.exitCode !== 'number' || !Number.isSafeInteger(r.exitCode)) return inconclusive('no exit code')
  if (r.exitCode !== 0) return fail(`exit ${r.exitCode}`)
  if (check.kind !== 'test' && !check.count) return { result: 'pass', reason: 'exit 0' }
  // From here an exit code is not enough: runners exit 0 having run nothing.
  const rule = check.count
  if (!rule) return inconclusive('exit 0, but no way to count the tests')
  if (!c || !isCount(c.passed) || !isCount(c.failed) || !isCount(c.skipped)) return inconclusive('exit 0, but no test count in the output')
  if (c.passed === 0) return inconclusive('exit 0, but no test passed')
  if (!isCount(rule.minPassed) || rule.minPassed === 0) return inconclusive(`${c.passed} passed; accept that as the baseline`)
  if (c.passed < rule.minPassed) return inconclusive(`${c.passed} passed, fewer than the ${rule.minPassed} accepted`)
  if (!isCount(rule.maxSkipped) || c.skipped > rule.maxSkipped) return inconclusive(`${c.skipped} skipped, more than the ${rule.maxSkipped} accepted`)
  return { result: 'pass', reason: `${c.passed} passed` }
}
