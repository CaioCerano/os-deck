import type { EngineInterface } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { outcomeOf } from '../hooks/proof/checks'
import { counterFor } from '../hooks/proof/counts'
import { checkProblem, digestOf, grantFrom, offerDigest, mayRun, setupProblem, suggestedChecks } from '../hooks/proof/grant'
import { KILL_WAIT_MS, cancelSignal, runCheck } from '../hooks/proof/runner'
import type { ProofCheck } from '../types'

const check = (over: Partial<ProofCheck> = {}): ProofCheck => ({
  id: 'test', kind: 'test', description: 'tests', argv: ['bun', 'test'], dir: '', timeoutS: 60, required: true, count: { parser: 'bun', minPassed: 3, maxSkipped: 0 }, ...over,
})

type Piece = { stream: 'stdout' | 'stderr'; text: string }
type Script = { pieces?: (Piece | string)[]; code?: number | null; signal?: string | null; silent?: boolean; refuse?: Error; links?: string[]; fireTimer?: boolean }

/** A child that writes what the script says. `silent` never yields and never ends, its return included. */
const world = (s: Script = {}) => {
  const spawned: { argv: string[]; cwd: string; env: Record<string, string> }[] = []
  const seen = { returned: 0, timerCancelled: 0 }
  const pieces = [...(s.pieces ?? [])]
  const $ = {
    clock: {
      now: async () => 1,
      after: (ms: number, fn: () => void) => {
        if (s.fireTimer || ms === KILL_WAIT_MS) setTimeout(fn, 5)
        return { cancel: () => void (seen.timerCancelled += 1) }
      },
    },
    fs: { list: async () => [{ name: 'app', kind: 'dir', isLink: s.links?.includes('app') === true }, { name: 'file', kind: 'file', isLink: false }] },
    process: {
      spawn: (request: { argv: string[]; cwd: string; env: Record<string, string> }) => {
        spawned.push(request)
        return {
          next: () => {
            if (s.refuse) return Promise.reject(s.refuse)
            if (s.silent) return new Promise(() => undefined)
            const p = pieces.shift()
            if (p !== undefined) return Promise.resolve({ done: false, value: typeof p === 'string' ? { stream: 'stdout', text: p } : p })
            return Promise.resolve({ done: true, value: { code: s.code === undefined ? 0 : s.code, signal: s.signal ?? null } })
          },
          return: () => {
            seen.returned += 1
            return new Promise(() => undefined)
          },
        }
      },
    },
  } as unknown as EngineInterface
  return { $, spawned, seen }
}

const run = async (s: Script = {}, c = check()) => {
  const w = world(s)
  return { ...w, ...(await runCheck(w.$, '/repo', c, 'REV', cancelSignal())) }
}
const count = (parser: 'bun' | 'pass-fail-lines', text: string) => {
  const counter = counterFor(parser)
  for (const line of text.split('\n')) counter.line(line)
  return counter.count()
}

// ---------------------------------------------------------------- counts

test('bun: the summary of a real run', () => {
  expect(count('bun', '(pass) a [1.00ms]\n\n 152 pass\n 0 fail\nRan 152 tests across 5 files. [8.83s]')).toEqual({ passed: 152, failed: 0, skipped: 0 })
  expect(count('bun', ' 3 pass\n 2 skip\n 1 todo\n 1 fail\nRan 7 tests across 1 file. [1ms]')).toEqual({ passed: 3, failed: 1, skipped: 3 })
  expect(count('bun', '\x1b[32m 4 pass\x1b[0m\r\n 0 fail\r\nRan 4 tests across 1 file. [1ms]\r')).toEqual({ passed: 4, failed: 0, skipped: 0 })
})

test('bun: no summary, or one that does not add up, is no count', () => {
  for (const text of ['', ' 5 pass\n 0 fail', 'Ran 5 tests across 1 file.', ' 5 pass\n 0 fail\nRan 9 tests across 1 file.']) expect(count('bun', text)).toBeNull()
})

test('bun: a failure is kept, in a broken or an earlier summary', () => {
  expect(count('bun', ' 1 pass\n 2 fail\nRan 9 tests across 1 file.')?.failed).toBe(2)
  expect(count('bun', ' 1 pass\n 1 fail\nRan 2 tests across 1 file.\n 9 pass\n 0 fail\nRan 9 tests across 1 file.')?.failed).toBe(1)
})

test('lines: each test a line', () => {
  expect(count('pass-fail-lines', '[PASS] tests/a.gd  SUMMARY 4\n[FAIL] tests/b.gd\n[SKIP] c\n  [PASS] indented is output\n[PASSED] no')).toEqual({ passed: 1, failed: 1, skipped: 1 })
  expect(count('pass-fail-lines', 'nothing ran')).toBeNull()
})

// ---------------------------------------------------------------- the runner

test('a run is observed: exit, count, revision', async () => {
  const { result, spawned } = await run({ pieces: [' 3 pa', 'ss\n 0 fail\n', 'Ran 3 tests across 1 file.'] })
  expect([result.execution, result.exitCode, result.revision]).toEqual(['exited', 0, 'REV'])
  expect(result.count).toEqual({ passed: 3, failed: 0, skipped: 0 })
  expect(outcomeOf(check(), result).result).toBe('pass')
  expect(spawned[0]?.argv).toEqual(['bun', 'test'])
  expect(spawned[0]?.cwd).toBe('/repo')
  expect(spawned[0]?.env.GITHUB_TOKEN).toBe('')
})

test('the two pipes do not mix their half lines', async () => {
  const { result } = await run({ pieces: [{ stream: 'stderr', text: ' 3 pa' }, { stream: 'stdout', text: 'noise' }, { stream: 'stderr', text: 'ss\n 0 fail\nRan 3 tests across 1 file.\n' }] })
  expect(result.count?.passed).toBe(3)
})

test('exit 0 with failures fails, exit 0 with zero tests does not pass', async () => {
  expect(outcomeOf(check(), (await run({ pieces: [' 2 pass\n 1 fail\nRan 3 tests across 1 file.\n'] })).result).result).toBe('fail')
  expect(outcomeOf(check(), (await run({ pieces: [' 0 pass\n 0 fail\nRan 0 tests across 1 file.\n'] })).result).result).toBe('inconclusive')
  expect(outcomeOf(check(), (await run({ pieces: ['done\n'] })).result).result).toBe('inconclusive')
})

test('a count outlasts far more output than is kept', async () => {
  const c = check({ count: { parser: 'pass-fail-lines', minPassed: 1, maxSkipped: 0 } })
  const { result, tail } = await run({ pieces: ['[FAIL] first\n', ...Array.from({ length: 40 }, () => `${'x'.repeat(2000)}\n`), '[PASS] last\n'] }, c)
  expect(result.count).toEqual({ passed: 1, failed: 1, skipped: 0 })
  expect(tail.length).toBeLessThanOrEqual(4000)
  expect(result.summary).toBe('[PASS] last')
})

test('a silent child ends at its time limit', async () => {
  const { result, seen } = await run({ silent: true, fireTimer: true })
  expect(result.execution).toBe('timed-out')
  expect(seen.returned).toBe(1)
  expect(outcomeOf(check(), result).result).toBe('inconclusive')
})

test('a silent child can be cancelled', async () => {
  const w = world({ silent: true })
  const signal = cancelSignal()
  const pending = runCheck(w.$, '/repo', check(), 'REV', signal)
  setTimeout(() => signal.cancel(), 5)
  expect((await pending).result.execution).toBe('cancelled')
  expect([w.seen.returned, w.seen.timerCancelled]).toEqual([1, 1])
})

test('cancelled before it started runs nothing', async () => {
  const w = world()
  const signal = cancelSignal()
  signal.cancel()
  expect((await runCheck(w.$, '/repo', check(), 'REV', signal)).result.execution).toBe('cancelled')
  expect(w.spawned).toEqual([])
})

test('a missing program, and a killed child, are no results', async () => {
  const missing = await run({ refuse: new Error("ENOENT: Command 'bun' not found") })
  expect(missing.result.execution).toBe('unavailable')
  expect(missing.result.reason).toContain('ENOENT')
  expect((await run({ code: null, signal: 'SIGKILL' })).result.execution).toBe('interrupted')
})

test('an unsafe definition or folder runs nothing', async () => {
  for (const [c, s] of [[check({ argv: ['./run'] }), {}], [check({ dir: '../up' }), {}], [check({ dir: 'app' }), { links: ['app'] }], [check({ dir: 'absent' }), {}]] as const) {
    const { result, spawned } = await run(s, c)
    expect(result.execution).toBe('unavailable')
    expect(spawned).toEqual([])
  }
})

test('the tail and the summary are masked', async () => {
  const V = 'FAKEvalue1234567890'
  const { result, tail } = await run({ pieces: [`GITHUB_TOKEN=ghp_${V}\n`] })
  expect(tail + result.summary).not.toContain(V)
  const cut = await run({ pieces: [`${'x\n'.repeat(9000)}BODY${V}\n-----END RSA PRIVATE KEY-----\n`] })
  expect(cut.tail).not.toContain(V)
})

// ---------------------------------------------------------------- what may be allowed

test('commands that would not be what was shown are refused', () => {
  const bad = [['./t.sh'], ['tools/run'], ['\\\\host\\share\\t.exe'], ['//host/t'], ['npm', 'a&calc'], ['npm', '%PATH%'], ['node', '//host/s.js'], ['node', '--require=\\\\host\\s'], ['node', 'a\u202eb'], ['node', 'a\nb'], ['node', '-e', "token='x'"], []]
  for (const argv of bad) expect(`${JSON.stringify(argv)} ${checkProblem(check({ argv })) === null ? 'allowed' : 'refused'}`).toBe(`${JSON.stringify(argv)} refused`)
  for (const argv of [['npm', 'run', 'lint'], ['bash', 'tests/run_all.sh'], ['C:\\Program Files\\Godot\\godot.exe', '--headless'], ['claude', 'plugin', 'test', 'mods/os-deck'], ['node', 'https://x']]) expect(checkProblem(check({ argv }))).toBeNull()
})

test('a root, a folder and a set are checked too', () => {
  expect(setupProblem('//host/share', [check()])).not.toBeNull()
  expect(setupProblem('/repo', [])).not.toBeNull()
  expect(setupProblem('/repo', [check({ required: false })])).not.toBeNull()
  expect(setupProblem('/repo', [check(), check()])).not.toBeNull()
  for (const dir of ['/abs', 'C:/x', 'a/../b', 'a\\b']) expect(checkProblem(check({ dir }))).not.toBeNull()
})

test('a press allows what was drawn, automatic unless manual was chosen', async () => {
  const checks = [check()]
  const drawnDigest = await offerDigest('/repo', checks, [])
  const press = { session: 'S', root: '/repo', checks, scripts: [], drawnDigest, at: 1 }
  const ok = await grantFrom(press)
  expect('grant' in ok && ok.grant.auto).toBe(true)
  const manual = await grantFrom({ ...press, auto: false })
  expect('grant' in manual && manual.grant.auto).toBe(false)
  expect('refused' in (await grantFrom({ ...press, checks: [check({ argv: ['bun', 'other'] })] }))).toBe(true)
  expect('refused' in (await grantFrom({ ...press, session: '' }))).toBe(true)
})

test('a grant allows this session and these bytes only', async () => {
  const checks = [check()]
  const made = await grantFrom({ session: 'S', root: '/repo', checks, scripts: [], drawnDigest: await offerDigest('/repo', checks, []), at: 1 })
  if (!('grant' in made)) throw new Error(made.refused)
  expect(await mayRun(made.grant, 'S', '/repo')).toBe(true)
  expect(await mayRun(made.grant, 'after-clear', '/repo')).toBe(false)
  expect(await mayRun(made.grant, 'S', '/other')).toBe(false)
  expect(await mayRun({ ...made.grant, checks: [check({ argv: ['bun', 'evil'] })] }, 'S', '/repo')).toBe(false)
  expect(await mayRun(null, 'S', '/repo')).toBe(false)
})

test('accepting a baseline does not change what runs', async () => {
  expect(await digestOf('/repo', [check()])).toBe(await digestOf('/repo', [check({ count: { parser: 'bun', minPassed: 99, maxSkipped: 4 } })]))
  expect(await digestOf('/repo', [check()])).not.toBe(await digestOf('/repo', [check({ dir: 'app' })]))
})

test('a forged store gives suggestions, never an allowance', () => {
  const out = suggestedChecks([{ ...check(), auto: true, session: 'S', digest: 'x' }, { ...check({ id: 'evil', argv: ['//host/x'] }) }, null, 'junk'])
  expect(out.length).toBe(1)
  expect(Object.keys(out[0] as object).sort()).toEqual(['argv', 'count', 'description', 'dir', 'id', 'kind', 'required', 'timeoutS'])
})

test('a child does not look for programs in the repository it runs in', async () => {
  const { spawned } = await run()
  // A .cmd shim on PATH asks cmd, which looks in the current folder first unless told not to.
  expect(spawned[0]?.env.NoDefaultCurrentDirectoryInExePath).toBe('1')
})
