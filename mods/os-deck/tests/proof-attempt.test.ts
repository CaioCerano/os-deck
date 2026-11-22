import type { EngineInterface } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { runAttempt } from '../hooks/proof/attempt'
import type { AttemptRequest } from '../hooks/proof/attempt'
import { digestOf } from '../hooks/proof/grant'
import { cancelSignal } from '../hooks/proof/runner'
import { rootVerdict } from '../hooks/proof/verdict'
import type { ProofAttempt, ProofCheck, ProofGrant } from '../types'

const base64Of = (text: string) => btoa([...new TextEncoder().encode(text)].map(b => String.fromCharCode(b)).join(''))
const sha = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('')
const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const ORIGINAL = 'allowed'
type World = { write: (path: string, text: string, at?: number) => void }
type Odd = { ignored?: Record<string, string>; links?: string[]; restoreBeforeRevision?: boolean }
const lint: ProofCheck = { id: 'lint', kind: 'lint', description: '', argv: ['npm', 'run', 'lint'], dir: '', timeoutS: 60, required: true }
const build: ProofCheck = { ...lint, id: 'build', kind: 'build', argv: ['npm', 'run', 'build'] }

/** A repository of one package.json, whose content `onSpawn` may change as a check runs. */
const world = (onSpawn: (n: number, w: World) => unknown = () => undefined, odd: Odd = {}) => {
  let spawns = 0
  let time = 1
  const disk = new Map([['package.json', { text: ORIGINAL, time }], ...Object.entries(odd.ignored ?? {}).map(([path, text]) => [path, { text, time }] as const)])
  const write = (path: string, text: string, at?: number) => void disk.set(path, { text, time: at ?? ++time })
  const run = async (argv: string[]) => {
    const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: false })
    if (argv.includes('--show-toplevel')) return ok('/repo\n')
    if (argv.includes('--git-path')) return ok('.git/info/exclude\n')
    if (argv.includes('--stage')) return ok(`100644 ${A} 0\tpackage.json\0`)
    if (argv.includes('config')) return { ...ok(''), exitCode: 1 }
    if (argv.includes('hash-object')) {
      // Back as it was in time for the read of the content, with its size and time as well.
      if (odd.restoreBeforeRevision && spawns > 0) disk.set('package.json', { text: ORIGINAL, time: 1 })
      return ok(`${disk.get('package.json')?.text === ORIGINAL ? A : B}\n`)
    }
    if (argv.includes('ls-files')) return ok('')
    return ok(`${'c'.repeat(40)}\n`)
  }
  const spawn = () => {
    spawns += 1
    onSpawn(spawns, { write })
    return { next: async () => ({ done: true, value: { code: 0, signal: null } }), return: async () => ({ done: true }) }
  }
  const $ = {
    clock: { now: async () => 5, after: () => ({ cancel: () => undefined }) },
    fs: {
      read: async (path: string, options?: { as?: string }) => {
        const held = disk.get(path.slice('/repo/'.length))
        return options?.as === 'bytes' ? { base64: base64Of(held?.text ?? '') } : ''
      },
      list: async (path: string) =>
        path !== '/repo' ? [] : [...disk].map(([name, held]) => {
          const isLink = odd.links?.includes(name) === true
          return { name, kind: isLink ? 'other' : 'file', isLink, size: held.text.length, mtimeMs: held.time }
        }),
    },
    process: { run, spawn },
  } as unknown as EngineInterface
  return { $, write, spawns: () => spawns }
}

const request = async (over: Partial<AttemptRequest> = {}) => {
  const checks = [lint, build]
  const grant: ProofGrant = { session: 'S', root: '/repo', checks, digest: await digestOf('/repo', checks), auto: true, at: 1 }
  const told: ProofAttempt[] = []
  const q: AttemptRequest = {
    id: 'a1', session: 'S', grant, trigger: 'auto', watched: [['package.json', await sha(ORIGINAL)]], signal: cancelSignal(),
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
    const { q } = await request({ trigger, watched: [['package.json', await sha('other')]] })
    const got = await runAttempt(w.$, q)
    expect('notRun' in got && got.changed).toEqual(['package.json'])
    expect(w.spawns()).toBe(0)
  }
})

test('a check that rewrites the next one stops it', async () => {
  const w = world((n, w) => n === 1 && w.write('package.json', 'other'))
  const { q } = await request()
  const got = await runAttempt(w.$, q)
  if (!('attempt' in got)) throw new Error(got.notRun)
  expect(w.spawns()).toBe(1)
  expect(got.attempt.checks[1]?.reason).toBe('what it runs changed during the attempt')
  expect(stateOf(q, got.attempt, got.attempt.after ?? '')).not.toBe('verified')
})

test('files changed during the last check do not verify', async () => {
  const w = world((n, w) => n === 2 && w.write('package.json', 'other'))
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

test('a watched file appearing in another case runs nothing', async () => {
  const w = world()
  // Absent as `Package.json` when allowed; here now as `package.json`, which the same programs load.
  const { q } = await request({ watched: [['Package.json', null]] })
  const got = await runAttempt(w.$, q)
  expect('notRun' in got && got.changed).toEqual(['Package.json'])
  expect(w.spawns()).toBe(0)
})

test('C1: a watched file git ignores appears or changes: nothing runs', async () => {
  for (const [path, was] of [['.npmrc', null], ['local.js', 'process.exit(1)']] as const) {
    const w = world(undefined, { ignored: { [path]: 'node-options=--require=./helper.cjs' } })
    const { q } = await request({ watched: [[path, was === null ? null : await sha(was)]] })
    const got = await runAttempt(w.$, q)
    expect('notRun' in got && got.changed).toEqual([path])
    expect(w.spawns()).toBe(0)
  }
})

test('C1: an ignored file a check writes stops the next one', async () => {
  const w = world((n, w) => n === 1 && w.write('.npmrc', 'node-options=--require=./helper.cjs'))
  const { q } = await request({ watched: [['.npmrc', null]] })
  const got = await runAttempt(w.$, q)
  if (!('attempt' in got)) throw new Error(got.notRun)
  expect(w.spawns()).toBe(1)
  expect(got.changed).toEqual(['.npmrc'])
  expect(stateOf(q, got.attempt, got.attempt.before)).toBe('inconclusive')
})

test('M3: changed during the last check, put back before the content is read again', async () => {
  const w = world((n, w) => n === 2 && w.write('package.json', 'evil'), { restoreBeforeRevision: true })
  const { q } = await request()
  const got = await runAttempt(w.$, q)
  if (!('attempt' in got)) throw new Error(got.notRun)
  expect(stateOf(q, got.attempt, got.attempt.before)).toBe('inconclusive')
  expect(got.attempt.checks[1]?.reason).toBe('what it runs changed during the attempt')
})

test('M3: changed and put back while the check ran', async () => {
  for (const at of [1, 2]) {
    const w = world((n, w) => {
      if (n !== at) return
      w.write('package.json', 'evil')
      w.write('package.json', ORIGINAL)
    })
    const { q } = await request()
    const got = await runAttempt(w.$, q)
    if (!('attempt' in got)) throw new Error(got.notRun)
    expect(w.spawns()).toBe(at)
    expect(stateOf(q, got.attempt, got.attempt.before)).toBe('inconclusive')
    expect(got.changed).toEqual(['package.json'])
  }
})

test('M3: a change by an optional check voids what passed before it', async () => {
  const checks = [lint, { ...build, required: false }]
  const grant: ProofGrant = { session: 'S', root: '/repo', checks, digest: await digestOf('/repo', checks), auto: true, at: 1 }
  const w = world((n, w) => n === 2 && w.write('.npmrc', 'x'))
  const { q } = await request({ grant, watched: [['.npmrc', null]] })
  const got = await runAttempt(w.$, q)
  if (!('attempt' in got)) throw new Error(got.notRun)
  expect(stateOf(q, got.attempt, got.attempt.before)).toBe('inconclusive')
})

test('immediately before a check: changed while the allowance was asked', async () => {
  let asked = 0
  const w = world()
  const { q } = await request({
    isStillAllowed: async () => {
      if (++asked === 2) w.write('package.json', 'evil')
      return true
    },
  })
  const got = await runAttempt(w.$, q)
  expect(w.spawns()).toBe(0)
  if ('attempt' in got) expect(stateOf(q, got.attempt, got.attempt.before)).toBe('inconclusive')
})

test('a watched file that cannot be read is changed', async () => {
  const w = world(undefined, { links: ['package.json'] })
  const { q } = await request()
  const got = await runAttempt(w.$, q)
  expect(w.spawns()).toBe(0)
  expect('attempt' in got).toBe(false)
})

test('once changed, nothing more runs, though it is all as it was by then', async () => {
  const w = world((n, w) => n === 1 && w.write('package.json', 'evil'))
  const { q } = await request({ onProgress: async a => void (a.checks.length === 1 && w.write('package.json', ORIGINAL, 1)) })
  const got = await runAttempt(w.$, q)
  if (!('attempt' in got)) throw new Error(got.notRun)
  expect(w.spawns()).toBe(1)
  expect(stateOf(q, got.attempt, got.attempt.before)).toBe('inconclusive')
})

test('N11: an attempt with no content after says why, where it is known', () => {
  const why = 'what it runs changed during the attempt'
  const grant = { session: 'S', root: '/repo', checks: [], digest: 'D', auto: true, at: 1 }
  const result = { id: 'lint', kind: 'lint' as const, description: '', execution: 'unavailable' as const, source: 'os-deck-run' as const, startedAt: 2, endedAt: 3, revision: 'A', exitCode: null, count: null, summary: '', reason: why }
  const attempt = { id: 'a', session: 'S', root: '/repo', digest: 'D', trigger: 'auto' as const, before: 'A', after: null, head: null, startedAt: 2, endedAt: 3, checks: [result] }
  expect(rootVerdict({ root: '/repo', session: 'S', grant, current: 'B', attempts: [attempt], liveId: null }).reason).toBe(why)
})
