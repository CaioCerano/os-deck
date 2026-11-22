import type { EngineInterface } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { runAttempt } from '../hooks/proof/attempt'
import type { AttemptRequest } from '../hooks/proof/attempt'
import { digestOf } from '../hooks/proof/grant'
import { cancelSignal } from '../hooks/proof/runner'
import { rootVerdict } from '../hooks/proof/verdict'
import type { ProofAttempt, ProofCheck, ProofGrant } from '../types'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const lint: ProofCheck = { id: 'lint', kind: 'lint', description: '', argv: ['npm', 'run', 'lint'], dir: '', timeoutS: 60, required: true }
const build: ProofCheck = { ...lint, id: 'build', kind: 'build', argv: ['npm', 'run', 'build'] }

/** A repository of one package.json, whose content `onSpawn` may change as a check runs. */
const world = (onSpawn: (n: number, set: (hash: string) => void) => void = () => undefined) => {
  let hash = A
  let spawns = 0
  const run = async (argv: string[]) => {
    const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false })
    if (argv.includes('--show-toplevel')) return ok('/repo\n')
    if (argv.includes('--git-path')) return ok('.git/info/exclude\n')
    if (argv.includes('--stage')) return ok(`100644 ${A} 0\tpackage.json\0`)
    if (argv.includes('hash-object')) return ok(`${hash}\n`)
    if (argv.includes('ls-files')) return ok('')
    return ok(`${'c'.repeat(40)}\n`)
  }
  const spawn = () => {
    spawns += 1
    onSpawn(spawns, h => (hash = h))
    return { next: async () => ({ done: true, value: { code: 0, signal: null } }), return: async () => ({ done: true }) }
  }
  const $ = {
    clock: { now: async () => 5, after: () => ({ cancel: () => undefined }) },
    fs: { read: async () => '', list: async () => [{ name: 'package.json', kind: 'file', isLink: false }] },
    process: { run, spawn },
  } as unknown as EngineInterface
  return { $, spawns: () => spawns }
}

const request = async (over: Partial<AttemptRequest> = {}) => {
  const checks = [lint, build]
  const grant: ProofGrant = { session: 'S', root: '/repo', checks, digest: await digestOf('/repo', checks), auto: true, at: 1 }
  const told: ProofAttempt[] = []
  const q: AttemptRequest = {
    id: 'a1', session: 'S', grant, trigger: 'auto', watched: [['package.json', A]], signal: cancelSignal(),
    isStillAllowed: async () => true, onProgress: async a => void told.push(a), ...over,
  }
  return { q, told }
}
const stateOf = (q: AttemptRequest, attempt: ProofAttempt, current: string) =>
  rootVerdict({ root: '/repo', session: 'S', grant: q.grant, current, attempts: [attempt], liveId: null }).state

test('a clean attempt verifies, and is told as it goes', async () => {
  const w = world()
  const { q, told } = await request()
  const got = await runAttempt(w.$, q)
  if (!('attempt' in got)) throw new Error(got.notRun)
  expect(w.spawns()).toBe(2)
  expect(told.map(a => [a.checks.length, a.endedAt !== null])).toEqual([[0, false], [1, false], [2, false], [2, true]])
  expect(stateOf(q, got.attempt, got.attempt.before)).toBe('verified')
})

test('a changed script runs nothing, automatic or by press', async () => {
  for (const trigger of ['auto', 'manual'] as const) {
    const w = world()
    const { q } = await request({ trigger, watched: [['package.json', B]] })
    const got = await runAttempt(w.$, q)
    expect('notRun' in got && got.changed).toEqual(['package.json'])
    expect(w.spawns()).toBe(0)
  }
})

test('a check that rewrites the next one stops it', async () => {
  const w = world((n, set) => n === 1 && set(B))
  const { q } = await request()
  const got = await runAttempt(w.$, q)
  if (!('attempt' in got)) throw new Error(got.notRun)
  expect(w.spawns()).toBe(1)
  expect(got.attempt.checks[1]?.reason).toBe('what it runs changed during the attempt')
  expect(stateOf(q, got.attempt, got.attempt.after ?? '')).not.toBe('verified')
})

test('files changed during the last check do not verify', async () => {
  const w = world((n, set) => n === 2 && set(B))
  const { q } = await request({ watched: [] })
  const got = await runAttempt(w.$, q)
  if (!('attempt' in got)) throw new Error(got.notRun)
  expect(stateOf(q, got.attempt, got.attempt.after ?? '')).toBe('inconclusive')
})

test('an allowance that ends midway stops the rest', async () => {
  let asked = 0
  const w = world()
  const { q } = await request({ isStillAllowed: async () => ++asked < 3 })
  const got = await runAttempt(w.$, q)
  if (!('attempt' in got)) throw new Error(got.notRun)
  expect(w.spawns()).toBe(1)
  expect(got.attempt.checks[1]?.reason).toBe('no longer allowed')
})

test('another session, or other bytes, run nothing', async () => {
  for (const over of [{ session: 'after-clear' }, {}] as const) {
    const w = world()
    const { q } = await request(over)
    const bad = 'session' in over ? q : { ...q, grant: { ...q.grant, checks: [{ ...lint, argv: ['npm', 'run', 'other'] }] } }
    const got = await runAttempt(w.$, bad)
    expect('notRun' in got && got.notRun).toBe('not allowed in this session')
    expect(w.spawns()).toBe(0)
  }
})

test('cancelled before a check runs none', async () => {
  const w = world()
  const signal = cancelSignal()
  signal.cancel()
  const { q } = await request({ signal })
  const got = await runAttempt(w.$, q)
  if (!('attempt' in got)) throw new Error(got.notRun)
  expect(got.attempt.checks.map(c => c.execution)).toEqual(['cancelled', 'cancelled'])
  expect(w.spawns()).toBe(0)
})
