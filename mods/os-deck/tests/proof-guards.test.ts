import type { EngineInterface } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { outcomeOf } from '../hooks/proof/checks'
import { counterFor } from '../hooks/proof/counts'
import { checkProblem, digestOf, grantFrom, mayRun, offerDigest, setupProblem, suggestedChecks } from '../hooks/proof/grant'
import { readRevision } from '../hooks/proof/revision'
import { cancelSignal, runCheck } from '../hooks/proof/runner'
import { isReviewed, rootVerdict, taskVerdict } from '../hooks/proof/verdict'
import type { RootFacts, RootNow } from '../hooks/proof/verdict'
import { gitHashRaw } from '../hooks/safe-git'
import type { ProofAttempt, ProofCheck, ProofClaim, ProofResult } from '../types'

// A test for each guard that could be deleted with the suite still green. Each pins the guard's own
// reason, so falling over on the way is not a pass.

const lint: ProofCheck = { id: 'lint', kind: 'lint', description: '', argv: ['npm', 'run', 'lint'], dir: '', timeoutS: 60, required: true }
const unit: ProofCheck = { ...lint, id: 'test', kind: 'test', count: { parser: 'bun', minPassed: 2, maxSkipped: 0 } }
const res = (over: Partial<ProofResult> = {}): ProofResult => ({ id: 'lint', kind: 'lint', description: '', execution: 'exited', source: 'os-deck-run', startedAt: 2, endedAt: 3, revision: 'A', exitCode: 0, count: null, summary: '', reason: null, ...over })
const att = (over: Partial<ProofAttempt> = {}): ProofAttempt => ({ id: 'a', session: 'S', root: '/r', digest: 'D', trigger: 'auto', before: 'A', after: 'A', head: null, startedAt: 2, endedAt: 4, checks: [res()], ...over })
const root = (over: Partial<RootFacts> = {}) =>
  rootVerdict({ root: '/r', session: 'S', grant: { session: 'S', root: '/r', checks: [lint], digest: 'D', auto: true, at: 1 }, current: 'A', attempts: [att()], liveId: null, ...over })

// ---------------------------------------------------------------- verdict

test('an unreadable root says so', () => {
  expect(root({ current: null })).toMatchObject({ state: 'inconclusive', reason: 'the content of this repository cannot be read' })
})

test('a failure is shown only on the content it was seen on', () => {
  expect(root({ current: 'Z', attempts: [att({ checks: [res({ exitCode: 1 })] })] })).toMatchObject({ state: 'stale', reason: 'changed since it failed' })
})

test('two results of one check are neither a pass nor a failure', () => {
  expect(root({ attempts: [att({ checks: [res(), res()] })] })).toMatchObject({ state: 'inconclusive', reason: 'lint: more than one result' })
  expect(root({ attempts: [att({ checks: [res({ exitCode: 1 }), res()] })] }).state).toBe('inconclusive')
})

const claim = (over: Partial<ProofClaim> = {}): ProofClaim => ({ id: 'c', session: 'S', taskId: '1', subject: '', description: '', agentId: null, at: 1, hasBaseline: true, changes: [{ root: '/r', paths: [{ path: 'a', hash: 'h' }, { path: 'b', hash: 'h' }], overlap: [] }], outside: [], withdrawn: false, ...over })
const now = (state: RootNow['verdict']['state'], b = 'h'): RootNow => ({ verdict: { state, reason: state }, hashes: new Map([['a', 'h'], ['b', b]]) })
const task = (c: ProofClaim, roots: [string, RootNow][]) => taskVerdict(c, new Map(roots), 'S')

test('every changed path is held, not the first', () => {
  expect(task(claim(), [['/r', now('verified', 'other')]]).state).toBe('stale')
})

test('no change says so', () => {
  expect(task(claim({ changes: [] }), [])).toMatchObject({ state: 'inconclusive', reason: 'no change seen in an allowed repository' })
})

test('the order of the worst', () => {
  const second = { root: '/two', paths: [{ path: 'a', hash: 'h' }], overlap: [] }
  const c = claim({ changes: [...claim().changes, second] })
  expect(task(c, [['/r', now('verifying')], ['/two', now('failed')]]).state).toBe('failed')
  expect(task(c, [['/r', now('stale')], ['/two', now('inconclusive')]]).state).toBe('inconclusive')
})

test('each guard of a review', () => {
  const good = { claim: 'c', revisions: [{ root: '/r', revision: 'A' }], at: 2 }
  const at = new Map([['/r', 'A'], ['/two', 'A'], ['/none', '']])
  expect(isReviewed(claim(), good, at)).toBe(true)
  expect(isReviewed(claim({ withdrawn: true }), good, at)).toBe(false)
  expect(isReviewed(claim({ changes: [] }), { ...good, revisions: [] }, at)).toBe(false)
  expect(isReviewed(claim({ changes: [{ root: '/two', paths: [], overlap: [] }] }), good, at)).toBe(false)
  expect(isReviewed(claim({ changes: [] }), { ...good, revisions: [{ root: '/none', revision: '' }] }, at)).toBe(false)
})

// ---------------------------------------------------------------- one check

test('each guard of an outcome', () => {
  const why = (check: ProofCheck, r: ProofResult) => outcomeOf(check, r).reason
  expect(why(lint, res({ id: 'other' }))).toBe('the result is not of this check')
  expect(why(lint, res({ kind: 'build' }))).toBe('the result is not of this check')
  expect(why(lint, res({ exitCode: '0' as never }))).toBe('no exit code')
  expect(outcomeOf({ ...lint, count: unit.count }, res()).result).toBe('inconclusive')
  const t = (count: unknown, check = unit) => why(check, res({ id: 'test', kind: 'test', count: count as never }))
  expect(t({ passed: 2, failed: 0, skipped: '0' })).toBe('exit 0, but a count not understood')
  expect(t({ passed: 0, failed: 0, skipped: 0 })).toBe('exit 0, but no test passed')
  expect(t({ passed: 2, failed: 0, skipped: 0 }, { ...unit, count: { parser: 'bun', minPassed: 2, maxSkipped: null as never } })).toContain('skipped')
})

// ---------------------------------------------------------------- what may be allowed

test('each guard of a definition', () => {
  const why = (over: Partial<ProofCheck>) => checkProblem({ ...lint, ...over })
  for (const ch of '&|<>^%!"') expect(why({ argv: ['node', `a${ch}b`] })).toBe('a character cmd would read as its own')
  expect(why({ kind: 'deploy' as never })).toBe('an unknown kind of check')
  expect(why({ id: 'Not An Id' })).toBe('an id not understood')
  expect(why({ argv: ['node', ''] })).toBe('no command')
  expect(why({ argv: Array(25).fill('node') })).toBe('no command')
  expect(why({ argv: ['node', 'a'.repeat(50), ...Array(10).fill('abcde fghij '.repeat(4).trim())] })).toBe('a command too long to show whole')
  expect(why({ dir: 'a/'.repeat(101) + 'a' })).toBe('a folder not understood')
  for (const dir of ['/abs', './x', 'a/..', 'a b*']) expect(why({ dir })).toBe('a folder outside the repository')
  for (const timeoutS of [0, 1.5, 3601]) expect(why({ timeoutS })).toBe('a time limit out of range')
  expect(why({ required: 1 as never })).toBe('no word on whether it is required')
  expect(why({ count: { parser: 'jest' as never, minPassed: 1, maxSkipped: 0 } })).toBe('a count format not known')
})

test('each guard of a set', () => {
  expect(setupProblem('/r', Array.from({ length: 9 }, (_, i) => ({ ...lint, id: `c${i}` })))).toBe('more than 8 checks')
  expect(setupProblem('/r', [lint, { ...lint, id: 'b', timeoutS: 0 }])).toBe('b: a time limit out of range')
})

test('a press refuses a bad set it was shown, and keeps its own copy', async () => {
  const bad = [{ ...lint, timeoutS: 0 }]
  expect(await grantFrom({ session: 'S', root: '/r', checks: bad, scripts: [], drawnDigest: await offerDigest('/r', bad, []), at: 1 })).toEqual({ refused: 'lint: a time limit out of range' })
  const mine = [{ ...lint, argv: [...lint.argv] }]
  const got = await grantFrom({ session: 'S', root: '/r', checks: mine, scripts: [], drawnDigest: await offerDigest('/r', mine, []), at: 1 })
  mine[0]!.argv[2] = 'deploy'
  expect('grant' in got && got.grant.checks[0]?.argv).toEqual(['npm', 'run', 'lint'])
})

test('a grant is held to the session, the root and the rules', async () => {
  const make = async (checks: ProofCheck[], session = 'S', at = '/r') => ({ session, root: at, checks, digest: await digestOf(at, checks), auto: true, at: 1 })
  expect(await mayRun(await make([lint], ''), '', '/r')).toBe(false)
  expect(await mayRun({ ...(await make([lint])), digest: await digestOf('/two', [lint]) }, 'S', '/two')).toBe(false)
  expect(await mayRun(await make([{ ...lint, timeoutS: 0 }]), 'S', '/r')).toBe(false)
})

test('suggestions are masked and few', () => {
  const V = 'FAKEvalue1234567890'
  expect(JSON.stringify(suggestedChecks([{ ...lint, description: `token=${V}` }]))).not.toContain(V)
  expect(suggestedChecks(Array.from({ length: 20 }, (_, i) => ({ ...lint, id: `c${i}` }))).length).toBe(8)
})

// ---------------------------------------------------------------- revision

type Disk = { rows?: string[]; entries?: Record<string, [name: string, kind: string][]>; top?: number; where?: [number, string]; read?: Error; hash?: [number, string, boolean?]; root?: string }
const H = 'a'.repeat(40)
const row = (path: string, mode = '100644') => `${mode} ${H} 0\t${path}\0`
const revision = async (d: Disk = {}) => {
  const at = d.root ?? 'C:/r'
  const reads: string[] = []
  const out = (exitCode: number, stdout: string, cut = false) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: cut })
  const run = async (argv: string[]) => {
    if (argv.includes('--show-toplevel')) return out(d.top ?? 0, `${at}\n`)
    if (argv.includes('--git-path')) return out(...(d.where ?? [0, '.git/info/exclude\n']))
    if (argv.includes('--stage')) return out(0, (d.rows ?? [row('a')]).join(''))
    if (argv.includes('hash-object')) return d.hash ? out(...d.hash) : out(0, `${H}\n`)
    return argv.includes('config') ? out(1, '') : out(0, '')
  }
  const list = async (path: string) => {
    const found = (d.entries ?? { '': [['a', 'file']] })[path.slice(at.length + 1)]
    if (!found) throw new Error('ENOTDIR')
    return found.map(([name, kind]) => ({ name, kind, isLink: false }))
  }
  const read = async (path: string) => {
    reads.push(path)
    if (d.read) throw d.read
    return ''
  }
  const r = await readRevision({ process: { run }, fs: { list, read } } as unknown as EngineInterface, at)
  return { got: r.ok ? r.revision : r.reason, reads }
}
const OK = /^[0-9a-f]{64}$/

test('each guard of a revision', async () => {
  expect((await revision()).got).toMatch(OK)
  expect((await revision({ top: 128 })).got).toBe('not the top of a git repository')
  expect((await revision({ read: new Error('ENOENT: no such file') })).got).toMatch(OK)
  expect((await revision({ where: [128, ''] })).got).toBe('its exclude file cannot be read')
  const unc = await revision({ where: [0, '//host/share/exclude\n'] })
  expect([unc.got, unc.reads]).toEqual(['its exclude file cannot be read', []])
  expect((await revision({ rows: [row('a', '100755')] })).got).not.toBe((await revision()).got)
  expect((await revision({ rows: Array.from({ length: 20_001 }, (_, i) => row(`f${i}`)) })).got).toBe('more than 20000 files')
  expect((await revision({ entries: { '': [['a', 'other']] } })).got).toBe('something that is not a regular file')
  expect((await revision({ entries: { '': [['a', 'file'], ['A', 'file']] } })).got).toBe('two names differing only in case')
  expect((await revision({ rows: [row('a/b')], entries: { '': [['a', 'file']] } })).got).toBe('git and the disk disagree on which files exist')
  expect((await revision({ entries: { '': [['A', 'file']] } })).got).toMatch(OK)
  for (const hash of [[1, `${H}\n`], [0, `${H}\n`, true]] as const) expect((await revision({ hash: [...hash] as never })).got).toBe('its files could not all be hashed')
  expect((await revision({ hash: [0, 'not-a-hash\n'] })).got).toBe('git gave a hash not understood')
})

test('the raw hash keeps every hardening', async () => {
  let seen: { argv: string[]; init: any } | null = null
  const $ = { process: { run: async (argv: string[], init: unknown) => ((seen = { argv, init }), { exitCode: 0 }) } } as unknown as EngineInterface
  await gitHashRaw($, '/r', ['a'])
  const { argv, init } = seen as unknown as { argv: string[]; init: any }
  for (const part of ['--no-filters', 'core.fsmonitor=false', 'safe.bareRepository=explicit', 'core.longpaths=true', '--no-optional-locks']) expect(argv).toContain(part)
  expect(argv[argv.indexOf('-C') + 1]).toBe('/r')
  expect(init.env).toEqual({ GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'none' })
  expect(init.timeoutMs).toBe(30_000)
})

// ---------------------------------------------------------------- runner and counts

const run = async (o: { text?: string; code?: number | null; signal?: string | null; refuse?: string; root?: string; dir?: string } = {}) => {
  let sent = false
  let spawns = 0
  const $ = {
    clock: { now: async () => 1, after: () => ({ cancel: () => undefined }) },
    fs: { list: async () => [{ name: 'file', kind: 'file', isLink: false }] },
    process: {
      spawn: () => {
        spawns += 1
        return {
          return: async () => ({ done: true }),
          next: async () => {
            if (o.refuse) throw new Error(o.refuse)
            if (o.text && !sent) return ((sent = true), { done: false, value: { stream: 'stdout', text: o.text } })
            return { done: true, value: { code: o.code === undefined ? 0 : o.code, signal: o.signal ?? null } }
          },
        }
      },
    },
  } as unknown as EngineInterface
  const { result } = await runCheck($, o.root ?? '/r', { ...lint, dir: o.dir ?? '' }, 'A', cancelSignal())
  return { result, spawns }
}

test('each guard of a run', async () => {
  expect((await run({ text: `${'word '.repeat(100)}\n` })).result.summary.length).toBe(160)
  const remote = await run({ root: '//host/share' })
  expect([remote.result.reason, remote.spawns]).toEqual(['the root is not a folder on this machine', 0])
  expect((await run({ dir: 'file' })).result.reason).toBe('its folder is not there, or is a link')
  expect((await run({ code: null })).result.execution).toBe('interrupted')
  expect((await run({ code: 0, signal: 'SIGKILL' })).result.execution).toBe('interrupted')
  expect((await run({ refuse: 'spawn failed: token=FAKEvalue1234567890' })).result.reason).not.toContain('FAKEvalue')
})

test('a stop asked for late still stops', () => {
  const signal = cancelSignal()
  signal.cancel()
  let stopped = false
  signal.onCancel(() => (stopped = true))
  expect(stopped).toBe(true)
})

test('a count is only the summary at the margin, whole', () => {
  const count = (lines: string[]) => {
    const c = counterFor('bun')
    for (const l of lines) c.line(l)
    return c.count()
  }
  expect(count(['        9 pass', ' 0 fail', 'Ran 9 tests across 1 file.'])).toBeNull()
  expect(count([' 9 pass the salt', ' 0 fail', 'Ran 9 tests across 1 file.'])).toBeNull()
})

test('an error count in a margin is no summary line', () => {
  const c = counterFor('bun')
  for (const l of [' 9 pass', ' 0 fail', '        1 error', 'Ran 9 tests across 1 file.']) c.line(l)
  expect(c.count()).toEqual({ passed: 9, failed: 0, skipped: 0 })
})

test('an attempt without an after is interrupted', () => {
  expect(root({ attempts: [att({ after: null })] })).toMatchObject({ state: 'inconclusive', reason: 'the run was interrupted' })
})

test('a space at either end is refused', () => {
  for (const arg of [' a', 'a ']) expect(checkProblem({ ...lint, argv: ['node', arg] })).toBe('a space at either end')
})

test('the rest of what decides a revision', async () => {
  expect((await revision({ rows: ['not a row\0'] })).got).toBe('git listed it in a form not understood')
  expect((await revision({ rows: [row('sub/a')], entries: { '': [['sub', 'dir']], sub: [['a', 'file'], ['.git', 'dir']] } })).got).toBe('a repository nested in it')
  const withExclude = async (text: string) => {
    const H40 = `${H}\n`
    const run = async (argv: string[]) => {
      const stdout = argv.includes('--show-toplevel') ? 'C:/r\n' : argv.includes('--git-path') ? '.git/info/exclude\n' : argv.includes('--stage') ? row('a') : argv.includes('hash-object') ? H40 : ''
      return { exitCode: argv.includes('config') ? 1 : 0, stdout, stderr: '', isStdoutTruncated: false }
    }
    const r = await readRevision({ process: { run }, fs: { list: async () => [{ name: 'a', kind: 'file', isLink: false }], read: async () => text } } as unknown as EngineInterface, 'C:/r')
    return r.ok ? r.revision : r.reason
  }
  expect(await withExclude('one')).not.toBe(await withExclude('two'))
  expect(await withExclude('\ufffd')).toBe('its exclude file cannot be read')
})

test('a line too long to hold is not kept', async () => {
  expect((await run({ text: `${'word '.repeat(900)}\n` })).result.summary).toBe('•••')
})

test('a stopped run keeps what it had counted', async () => {
  let fire = () => {}
  let sent = false
  const $ = {
    clock: { now: async () => 1, after: (_ms: number, fn: () => void) => ((fire = fn), { cancel: () => undefined }) },
    fs: { list: async () => [] },
    process: {
      spawn: () => ({
        return: async () => ({ done: true }),
        next: async () => {
          if (!sent) return ((sent = true), { done: false, value: { stream: 'stdout', text: '[FAIL] a\n' } })
          setTimeout(() => fire(), 2)
          return new Promise(() => undefined)
        },
      }),
    },
  } as unknown as EngineInterface
  const { result } = await runCheck($, '/r', { ...unit, count: { parser: 'pass-fail-lines', minPassed: 1, maxSkipped: 0 } }, 'A', cancelSignal())
  expect([result.execution, result.count]).toEqual(['timed-out', { passed: 0, failed: 1, skipped: 0 }])
})

test('a program named whole must be there', async () => {
  let spawns = 0
  const $ = {
    clock: { now: async () => 1, after: () => ({ cancel: () => undefined }) },
    fs: { list: async () => [], stat: async () => Promise.reject(new Error('ENOENT')) },
    process: { spawn: () => ((spawns += 1), { next: async () => ({ done: true, value: { code: 0, signal: null } }) }) },
  } as unknown as EngineInterface
  const { result } = await runCheck($, '/r', { ...lint, argv: ['C:/tools/absent.exe'] }, 'A', cancelSignal())
  expect([result.reason, spawns]).toEqual(['its program is not there', 0])
})

test('a failure written over by a pass stays a failure', () => {
  const c = counterFor('pass-fail-lines')
  c.line('[FAIL] b\r[PASS] b')
  expect(c.count()).toEqual({ passed: 0, failed: 1, skipped: 0 })
})
