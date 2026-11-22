import { expect, test } from 'claude-code/testing'

import { outcomeOf } from '../hooks/proof/checks'
import { isReviewed, rootVerdict, taskVerdict } from '../hooks/proof/verdict'
import type { RootFacts, RootNow } from '../hooks/proof/verdict'
import type { ProofAttempt, ProofCheck, ProofClaim, ProofGrant, ProofResult } from '../types'

const R = '/repo'
const unit: ProofCheck = { id: 'test', kind: 'test', description: 'tests', argv: ['t'], dir: '', timeoutS: 60, required: true, count: { parser: 'bun', minPassed: 148, maxSkipped: 2 } }
const types: ProofCheck = { id: 'typecheck', kind: 'typecheck', description: 'types', argv: ['c'], dir: '', timeoutS: 60, required: true }
const grant = (over: Partial<ProofGrant> = {}): ProofGrant => ({ session: 'S', root: R, checks: [unit, types], digest: 'D', auto: true, at: 1, ...over })
const ran = (check: ProofCheck, over: Partial<ProofResult> = {}): ProofResult => ({
  id: check.id, kind: check.kind, description: '', execution: 'exited', source: 'os-deck-run', startedAt: 2, endedAt: 3, revision: 'A',
  exitCode: 0, count: check.kind === 'test' ? { passed: 148, failed: 0, skipped: 0 } : null, summary: '', reason: null, ...over,
})
const attempt = (over: Partial<ProofAttempt> = {}): ProofAttempt => ({
  id: 'a1', session: 'S', root: R, digest: 'D', trigger: 'auto', before: 'A', after: 'A', head: null, startedAt: 2, endedAt: 4, checks: [ran(unit), ran(types)], ...over,
})
const facts = (over: Partial<RootFacts> = {}): RootFacts => ({ root: R, session: 'S', grant: grant(), current: 'A', attempts: [attempt()], liveId: null, ...over })
const state = (over: Partial<RootFacts> = {}) => rootVerdict(facts(over)).state

const claim = (over: Partial<ProofClaim> = {}): ProofClaim => ({
  id: 'S:1:1', session: 'S', taskId: '1', subject: 's', description: 'd', agentId: null, at: 1, hasBaseline: true,
  changes: [{ root: R, paths: [{ path: 'a.ts', hash: 'h1' }], overlap: [] }], outside: [], withdrawn: false, ...over,
})
const now = (verdict: RootNow['verdict']['state'] = 'verified', hashes: [string, string][] | null = [['a.ts', 'h1']]): RootNow => ({ verdict: { state: verdict, reason: verdict }, hashes: hashes && new Map(hashes) })
const task = (c: ProofClaim, roots: [string, RootNow][] = [[R, now()]]) => taskVerdict(c, new Map(roots), 'S').state

// ---------------------------------------------------------------- the whole table

test('every combination: verified exactly where all the evidence holds, and nowhere else', () => {
  const grants = [null, grant(), grant({ session: 'other' }), grant({ root: '/else' }), grant({ digest: 'E' }), grant({ checks: [] }), grant({ checks: [{ ...unit, required: false }] }), grant({ checks: [{ ...unit, count: undefined }] })]
  const currents = [null, '', 'A', 'B', 'C']
  const spans = [['A', 'A'], ['A', 'B'], ['A', null], ['', '']] as const
  const ends = [4, null]
  const lives = [null, 'a1']
  const executions = ['queued', 'running', 'exited', 'timed-out', 'cancelled', 'interrupted', 'unavailable'] as const
  const exits = [0, 1, null]
  const counts = [null, { passed: 148, failed: 0, skipped: 0 }, { passed: 147, failed: 0, skipped: 0 }, { passed: 148, failed: 1, skipped: 0 }, { passed: 148, failed: 0, skipped: 3 }, { passed: 0, failed: 0, skipped: 0 }]
  const wrong: string[] = []
  let checked = 0
  let verified = 0
  for (const g of grants) for (const current of currents) for (const [before, after] of spans) for (const endedAt of ends) for (const liveId of lives)
    for (const execution of executions) for (const exitCode of exits) for (const count of counts) {
      const checks = (g?.checks ?? []).map(c => (c.id === 'test' ? ran(c, { execution, exitCode, count, revision: before }) : ran(c, { revision: before })))
      const got = rootVerdict(facts({ grant: g, current, liveId, attempts: [attempt({ before, after, endedAt, checks })] })).state
      // Written from the definition, not from the code: all of it, or not verified.
      const shouldVerify =
        g !== null && g.session === 'S' && g.root === R && g.digest === 'D' && g.checks.some(c => c.required) && g.checks.every(c => c.kind !== 'test' || c.count !== undefined) &&
        endedAt !== null && Boolean(current) && current === before && current === after &&
        execution === 'exited' && exitCode === 0 && count?.passed === 148 && count.failed === 0 && count.skipped <= 2
      checked++
      if (got === 'verified') verified++
      if ((got === 'verified') !== shouldVerify && wrong.length < 5) wrong.push(JSON.stringify({ g, current, before, after, endedAt, liveId, execution, exitCode, count, got }))
    }
  expect(wrong).toEqual([])
  expect(checked).toBeGreaterThan(50_000)
  expect(verified).toBeGreaterThan(0)
})

// ---------------------------------------------------------------- one check

test('exit 0 with failed tests fails: a script ending in || true', () => {
  expect(outcomeOf(unit, ran(unit, { count: { passed: 145, failed: 3, skipped: 0 } })).result).toBe('fail')
})

test('no tests, too few or too many skipped never pass', () => {
  for (const count of [null, { passed: 0, failed: 0, skipped: 0 }, { passed: 1, failed: 0, skipped: 147 }, { passed: 147, failed: 0, skipped: 0 }, { passed: 148, failed: 0, skipped: 3 }, { passed: NaN, failed: 0, skipped: 0 }, { passed: 148, failed: -1, skipped: 0 }])
    expect(outcomeOf(unit, ran(unit, { count })).result).toBe('inconclusive')
})

test('a test passes nothing until a person accepted a baseline', () => {
  for (const minPassed of [null, 0, NaN]) expect(outcomeOf({ ...unit, count: { parser: 'bun', minPassed, maxSkipped: 2 } }, ran(unit)).result).toBe('inconclusive')
})

test('a result of another check or source does not count', () => {
  expect(outcomeOf(types, ran(unit)).result).toBe('inconclusive')
  expect(outcomeOf(types, ran(types, { source: 'agent' as never })).result).toBe('inconclusive')
})

// ---------------------------------------------------------------- roots

test('each state is reached', () => {
  expect(state({ attempts: [] })).toBe('pending')
  expect(state({ attempts: [attempt({ endedAt: null, after: null })], liveId: 'a1' })).toBe('verifying')
  expect(state()).toBe('verified')
  expect(state({ attempts: [attempt({ checks: [ran(unit, { exitCode: 1 }), ran(types)] })] })).toBe('failed')
  expect(state({ attempts: [attempt({ checks: [ran(types)] })] })).toBe('inconclusive')
  expect(state({ current: 'B' })).toBe('stale')
})

test('a running attempt of an earlier load reads as interrupted', () => {
  expect(state({ attempts: [attempt({ endedAt: null, after: null })] })).toBe('inconclusive')
})

test('a failure shows over an interruption or a change during the run', () => {
  const checks = [ran(unit, { exitCode: 1 }), ran(types)]
  expect(state({ attempts: [attempt({ checks, endedAt: null, after: null })] })).toBe('failed')
  expect(state({ attempts: [attempt({ checks, after: 'B' })], current: 'B' })).toBe('failed')
})

test('a forged or foreign attempt turns nothing green', () => {
  expect(state({ attempts: [attempt({ session: 'earlier' })] })).toBe('pending')
  expect(state({ attempts: [attempt({ digest: 'older definition' })] })).toBe('pending')
  expect(state({ attempts: [attempt({ root: '/else' })] })).toBe('pending')
  expect(state({ session: 'after-clear' })).toBe('pending')
})

test('a duplicated result, or one from other content, is no pass', () => {
  expect(state({ attempts: [attempt({ checks: [ran(unit), ran(unit), ran(types)] })] })).toBe('inconclusive')
  expect(state({ attempts: [attempt({ checks: [ran(unit, { revision: 'Z' }), ran(types)] })] })).toBe('inconclusive')
})

test('the latest attempt decides, not the best', () => {
  const bad = attempt({ id: 'a2', startedAt: 9, endedAt: 10, checks: [ran(unit, { exitCode: 1 }), ran(types)] })
  expect(state({ attempts: [attempt(), bad] })).toBe('failed')
  expect(state({ attempts: [attempt(), { ...bad, startedAt: 2 }] })).toBe('failed')
})

// ---------------------------------------------------------------- tasks: the review's false greens

test('reverted work is not verified by a later pass', () => {
  expect(task(claim(), [[R, now('verified', [['a.ts', 'h0']])]])).toBe('stale')
  expect(task(claim(), [[R, now('verified', [])]])).toBe('stale')
})

test("another task's work does not verify this one", () => {
  expect(task(claim({ changes: [{ root: R, paths: [{ path: 'a.ts', hash: 'h1' }], overlap: ['S:2:1'] }] }))).toBe('inconclusive')
})

test('a task that changed nothing is not verified', () => {
  expect(task(claim({ changes: [] }))).toBe('inconclusive')
  expect(task(claim({ changes: [{ root: R, paths: [], overlap: [] }] }))).toBe('inconclusive')
  expect(task(claim({ hasBaseline: false }))).toBe('inconclusive')
})

test('the worst of several roots wins, in either order', () => {
  const second = { root: '/two', paths: [{ path: 'b.ts', hash: 'h2' }], overlap: [] }
  const c = claim({ changes: [...claim().changes, second] })
  const two = (v: RootNow['verdict']['state']): [string, RootNow] => ['/two', now(v, [['b.ts', 'h2']])]
  expect(task(c, [[R, now('failed')], two('verified')])).toBe('failed')
  expect(task(c, [[R, now()], two('failed')])).toBe('failed')
  expect(task(c, [[R, now()]])).toBe('pending')
  expect(task(c, [[R, now()], two('verified')])).toBe('verified')
})

test('an edit outside the allowed roots blocks verified', () => {
  expect(task(claim({ outside: ['/elsewhere/x'] }))).toBe('inconclusive')
})

test('an unreadable root blocks verified', () => {
  expect(task(claim(), [[R, now('verified', null)]])).toBe('inconclusive')
})

test('a deletion holds while the file stays gone', () => {
  const c = claim({ changes: [{ root: R, paths: [{ path: 'a.ts', hash: null }], overlap: [] }] })
  expect(task(c, [[R, now('verified', [])]])).toBe('verified')
  expect(task(c)).toBe('stale')
})

test('a reopened claim is withdrawn', () => {
  expect(task(claim({ withdrawn: true }))).toBe('pending')
})

test('a review holds only for the content that was drawn', () => {
  const review = { claim: 'S:1:1', revisions: [{ root: R, revision: 'A' }], at: 5 }
  expect(isReviewed(claim(), review, new Map([[R, 'A']]))).toBe(true)
  expect(isReviewed(claim(), review, new Map([[R, 'B']]))).toBe(false)
  expect(isReviewed(claim({ id: 'S:1:2' }), review, new Map([[R, 'A']]))).toBe(false)
  expect(isReviewed(claim(), { ...review, revisions: [] }, new Map([[R, 'A']]))).toBe(false)
  expect(isReviewed(claim(), undefined, new Map([[R, 'A']]))).toBe(false)
})
