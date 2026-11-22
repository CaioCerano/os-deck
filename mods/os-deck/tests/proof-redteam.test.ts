import type { EngineInterface } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { outcomeOf } from '../hooks/proof/checks'
import { counterFor } from '../hooks/proof/counts'
import * as grants from '../hooks/proof/grant'
import { readRevision } from '../hooks/proof/revision'
import { cancelSignal, runCheck } from '../hooks/proof/runner'
import { rootVerdict, taskVerdict } from '../hooks/proof/verdict'
import type { ProofAttempt, ProofCheck, ProofClaim, ProofGrant, ProofResult } from '../types'

// One test per finding of the core's red team, numbered as reported. Each failed on 0941038.

const unit: ProofCheck = { id: 'test', kind: 'test', description: '', argv: ['bun', 'test'], dir: '', timeoutS: 60, required: true, count: { parser: 'bun', minPassed: 2, maxSkipped: 0 } }
const lint: ProofCheck = { id: 'lint', kind: 'lint', description: '', argv: ['npm', 'run', 'lint'], dir: '', timeoutS: 60, required: true }

// ---------------------------------------------------------------- 1, 2, 12, 17: the revision

type Repo = { files: Record<string, string>; listed?: string[]; stderr?: string; root?: string; afterHash?: (r: Repo) => void; links?: string[]; excludesFile?: string }
const hashOf = (s: string) => {
  let h = 7
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return (h >>> 0).toString(16).padStart(8, '0').repeat(5)
}
const repo = (r: Repo) => {
  const root = r.root ?? 'C:/repo'
  const calls: string[][] = []
  const onDisk = (path: string) => Object.entries(r.files).find(([p]) => p.toLowerCase() === path.toLowerCase())?.[1] ?? ''
  const run = async (argv: string[], init?: { stdin?: string }) => {
    calls.push(argv)
    const ok = (stdout: string, stderr = '') => ({ exitCode: 0, stdout, stderr, isStdoutTruncated: false })
    if (argv.includes('--show-toplevel')) return ok(`${root}\n`)
    if (argv.includes('--git-path')) return ok('.git/info/exclude\n')
    if (argv.includes('--stage')) return ok((r.listed ?? Object.keys(r.files)).map(p => `100644 ${'a'.repeat(40)} 0\t${p}\0`).join(''))
    if (argv.includes('--others')) return ok('', r.stderr)
    if (argv.includes('hash-object')) {
      const out = (init?.stdin ?? '').split('\n').filter(Boolean).map(p => `${hashOf(onDisk(p))}\n`).join('')
      r.afterHash?.(r)
      return ok(out)
    }
    if (argv.includes('config') && r.excludesFile) return ok(`${r.excludesFile}\n`)
    if (argv.includes('config')) return { ...ok(''), exitCode: 1 }
    return ok('')
  }
  const list = async (path: string) => {
    const dir = path.slice(root.length + 1)
    const found = new Map<string, { name: string; kind: string; isLink: boolean }>()
    for (const p of Object.keys(r.files)) {
      if (dir && !p.toLowerCase().startsWith(`${dir.toLowerCase()}/`)) continue
      const [name = '', ...rest] = (dir ? p.slice(dir.length + 1) : p).split('/')
      const isLink = r.links?.includes(dir ? `${dir}/${name}` : name) === true
      found.set(name, { name, kind: isLink ? 'other' : rest.length ? 'dir' : 'file', isLink })
    }
    return [...found.values()]
  }
  return { $: { process: { run }, fs: { list, read: async () => '' } } as unknown as EngineInterface, root, calls }
}
const read = async (r: Repo) => {
  const w = repo(r)
  return readRevision(w.$, w.root)
}
const revOf = async (r: Repo) => {
  const x = await read(r)
  return x.ok ? x.revision : `NO: ${x.reason}`
}

test('1: a listing git warned about is not whole', async () => {
  expect(await revOf({ files: { 'a.ts': '1' }, stderr: "warning: could not open directory 'deep/': Filename too long" })).toContain('NO: git could not list it whole')
})

test('1: long paths are asked for', async () => {
  const w = repo({ files: { 'a.ts': '1' } })
  await readRevision(w.$, w.root)
  expect(w.calls.filter(a => a.includes('--others')).every(a => a.includes('core.longpaths=true'))).toBe(true)
})

test('2: a case-only rename changes the revision', async () => {
  expect(await revOf({ files: { 'A.txt': '1' }, listed: ['a.txt'] })).not.toBe(await revOf({ files: { 'a.txt': '1' } }))
  expect(await revOf({ files: { 'Lib/x': '1' }, listed: ['lib/x'] })).not.toBe(await revOf({ files: { 'lib/x': '1' } }))
})

test('2: a Windows device name is refused', async () => {
  for (const name of ['nul', 'sub/AUX.txt', 'com1', 'con.js', 'foo.', 'foo ', 'a.txt:stream']) expect(await revOf({ files: { [name]: '1' } })).toContain('Windows reads differently')
})

test('2: where case is kept, git is told not to fold it', async () => {
  const w = repo({ files: { 'a.txt': '1' }, root: '/repo' })
  await readRevision(w.$, w.root)
  expect(w.calls.filter(a => a.includes('--others')).every(a => a.includes('core.ignorecase=false'))).toBe(true)
})

test('12: a file added while hashing gives no revision', async () => {
  const r: Repo = { files: { 'a.ts': '1' }, afterHash: x => void (x.files['b.ts'] = '2') }
  expect(await revOf(r)).toContain('NO: it changed while being read')
})

test('12: a folder swapped for a link while hashing gives no revision', async () => {
  const r: Repo = { files: { 'sub/a.ts': '1' }, afterHash: x => void (x.links = ['sub']) }
  expect(await revOf(r)).toMatch(/NO: (a link|it changed while being read)/)
})

test('17: an ignore file git is pointed at gives no revision', async () => {
  expect(await revOf({ files: { 'a.ts': '1' }, excludesFile: '.git/hide' })).toContain('NO: an ignore file set in its git config')
})

test('mutation: content, every file of it, is in the revision', async () => {
  const base = await revOf({ files: { 'a.ts': '1', 'b.ts': '1' } })
  expect(await revOf({ files: { 'a.ts': '1', 'b.ts': '2' } })).not.toBe(base)
  expect(await revOf({ files: { 'a.ts': '2', 'b.ts': '1' } })).not.toBe(base)
  expect(await revOf({ files: { 'a.ts': '1', 'b.ts': '1' } })).toBe(base)
})

// ---------------------------------------------------------------- 3, 4: counts

type Line = string | [text: string, stream: 'stdout' | 'stderr']
const count = (parser: 'bun' | 'pass-fail-lines', lines: Line[]) => {
  const c = counterFor(parser) as unknown as { line: (text: string, stream?: string) => void; count: () => { passed: number; failed: number; skipped: number } | null }
  for (const l of lines) typeof l === 'string' ? c.line(l) : c.line(...l)
  return c.count()
}

test('3: an error outside any test is a failure', () => {
  expect(count('bun', [' 5 pass', ' 0 fail', ' 1 error', 'Ran 5 tests across 1 file.'])?.failed).toBe(1)
})

test('3: a failure behind a carriage return or an erase is seen', () => {
  for (const line of ['working…\r[FAIL] b', '\x1b[2K[FAIL] b', '\x1b[?25l[FAIL] b', '[FAIL]: b', '[FAIL] b\roverwritten']) expect(count('pass-fail-lines', ['[PASS] a', line])?.failed).toBe(1)
  expect(count('bun', [' 4 pass', '\x1b[2K 1 fail', 'Ran 5 tests across 1 file.'])?.failed).toBe(1)
})

test('3: one pipe cannot overwrite the failures of the other', () => {
  expect(count('bun', [[' 3 pass', 'stderr'], [' 2 fail', 'stderr'], [' 0 fail', 'stdout'], ['Ran 5 tests across 1 file.', 'stderr']])?.failed).toBe(2)
})

test('4: a second summary is no count', () => {
  const real: Line[] = [' 2 pass', ' 0 fail', 'Ran 2 tests across 1 file.']
  expect(count('bun', [' 500 pass', ' 0 fail', 'Ran 500 tests across 1 file.', ...real])).toBeNull()
  expect(count('bun', [...real.map(l => [l, 'stdout'] as Line), ...real.map(l => [l, 'stderr'] as Line)])).toBeNull()
})

// ---------------------------------------------------------------- 5, 6, 16, 18: what may run

const refuses = (argv: string[]) => expect(`${JSON.stringify(argv)} ${grants.checkProblem({ ...lint, argv }) === null ? 'allowed' : 'refused'}`).toBe(`${JSON.stringify(argv)} refused`)

test('5: a program Windows would resolve to another is refused', () => {
  for (const exe of ['C:/tool/lint', 'C:/tool/check.py', 'C:/x/a.txt:hid.exe', 'C:/x/t.exe ', 'C:/x/t.exe.', 'C:/x/../t.exe', 'check.py', 'lint.', 'C:/x/nul.exe']) refuses([exe])
  for (const exe of ['C:\\Program Files\\Godot\\godot.exe', 'C:/tools/lint.CMD', 'node', 'python3.12']) expect(grants.checkProblem({ ...lint, argv: [exe] })).toBeNull()
})

test('6: an argument a program would expand is refused', () => {
  for (const arg of ['@opts', '~/x.sh', 'tests/*.sh', 't?.sh', '[ab].sh', '{a,b}.sh']) refuses(['bash', arg])
})

test('16: every spelling of a network or device path is refused', () => {
  for (const arg of ['-r//host/s', '/logger:\\\\host\\s', ' //host/s', '\\??\\UNC\\host\\s', '/??/UNC/host/s', '\\Device\\Mup\\host\\s']) refuses(['node', arg])
  for (const exe of ['/??/UNC/host/t.exe', '/Device/Mup/host/t.exe']) refuses([exe])
  expect(grants.checkProblem({ ...lint, argv: ['node', 'https://example.com'] })).toBeNull()
})

test('18: a filler that draws as nothing is refused', () => {
  for (const arg of ['a\u3164b', 'a\u115fb', 'a\uffa0b', 'a\ufe0fb']) refuses(['node', arg])
})

test('18: a hostile stored description does not throw', () => {
  expect(() => grants.suggestedChecks([{ ...unit, description: { toString: 1 } }])).not.toThrow()
})

// ---------------------------------------------------------------- 8, 9, 10: the press

const offer = async (checks: ProofCheck[], scripts: { checkId: string; name: string; body: string }[] = []) =>
  (grants as unknown as { offerDigest: (root: string, c: ProofCheck[], s: unknown) => Promise<string> }).offerDigest('/repo', checks, scripts)
const press = (checks: ProofCheck[], drawnDigest: string, scripts: unknown[] = []) =>
  (grants.grantFrom as unknown as (p: unknown) => Promise<object>)({ session: 'S', root: '/repo', checks, scripts, drawnDigest, at: 1 })

test('8: a baseline other than the one drawn is refused', async () => {
  const drawn = await offer([unit])
  const weaker = { ...unit, count: { parser: 'bun' as const, minPassed: 1, maxSkipped: 99999 } }
  expect('refused' in (await press([weaker], drawn))).toBe(true)
  expect('grant' in (await press([unit], drawn))).toBe(true)
})

test('9: a script body other than the one drawn is refused', async () => {
  const shown = [{ checkId: 'lint', name: 'lint', body: 'eslint .' }]
  const drawn = await offer([lint], shown)
  expect('refused' in (await press([lint], drawn, [{ ...shown[0], body: 'node evil.js' }]))).toBe(true)
  expect('grant' in (await press([lint], drawn, shown))).toBe(true)
})

test('10: what a check runs is watched, present or not yet', () => {
  const files = new Map(['app/package.json', 'GNUmakefile', 'tests/run.sh', 'tools/x.js'].map(p => [p, 'h']))
  const watch = (argv: string[], dir = '') => (grants.watchedPaths as (c: ProofCheck[], f: Map<string, string>, root?: string) => string[])([{ ...lint, argv, dir }], files, 'C:/repo')
  expect(watch(['npm', '--prefix', 'app', 'test'])).toContain('app/package.json')
  expect(watch(['npm', '-w', 'app', 'test'])).toContain('app/package.json')
  expect(watch(['make', 'lint'])).toContain('GNUmakefile')
  expect(watch(['node', 'C:/repo/tools/x.js'])).toContain('tools/x.js')
  expect(watch(['node', '../tools/x.js'], 'app')).toContain('tools/x.js')
  expect(watch(['bash', '-c', 'tests/run.sh --fast'])).toContain('tests/run.sh')
  // Absent when allowed: appearing is a change.
  expect(watch(['make', 'lint'])).toContain('Makefile')
})

// ---------------------------------------------------------------- 7, 11: the verdict

const result = (over: Partial<ProofResult> = {}): ProofResult => ({ id: 'lint', kind: 'lint', description: '', execution: 'exited', source: 'os-deck-run', startedAt: 20, endedAt: 30, revision: 'A', exitCode: 0, count: null, summary: '', reason: null, ...over })
const attempt = (over: Partial<ProofAttempt> = {}): ProofAttempt => ({ id: 'a', session: 'S', root: '/repo', digest: 'D', trigger: 'auto', before: 'A', after: 'A', head: null, startedAt: 20, endedAt: 30, checks: [result()], ...over })
const grant: ProofGrant = { session: 'S', root: '/repo', checks: [lint], digest: 'D', auto: true, at: 10 }
const state = (attempts: ProofAttempt[]) => rootVerdict({ root: '/repo', session: 'S', grant, current: 'A', attempts, liveId: null }).state

test('7: an attempt older than the allowance does not count', () => {
  expect(state([attempt({ startedAt: 5, endedAt: 6 })])).toBe('pending')
})

test('7: the one recorded last decides, whatever the clock says', () => {
  const failed = attempt({ id: 'b', startedAt: 15, checks: [result({ exitCode: 1 })] })
  expect(state([attempt({ startedAt: 900 }), failed])).toBe('failed')
})

test('7: an attempt or result without an end is no pass', () => {
  expect(state([attempt({ endedAt: undefined as never })])).toBe('inconclusive')
  expect(state([attempt({ checks: [result({ endedAt: null })] })])).toBe('inconclusive')
})

test('7: a failure that is not a number is no pass', () => {
  expect(outcomeOf(lint, result({ count: { failed: '3' } as never })).result).toBe('inconclusive')
})

test('11: a claim of another session is never verified', () => {
  const claim: ProofClaim = { id: 'x', session: 'earlier', taskId: '1', subject: '', description: '', agentId: null, at: 1, hasBaseline: true, changes: [{ root: '/repo', paths: [{ path: 'a', hash: 'h' }], overlap: [] }], outside: [], withdrawn: false }
  const roots = new Map([['/repo', { verdict: { state: 'verified' as const, reason: '' }, hashes: new Map([['a', 'h']]) }]])
  expect((taskVerdict as unknown as (c: ProofClaim, r: typeof roots, s: string) => { state: string })(claim, roots, 'S').state).not.toBe('verified')
})

// ---------------------------------------------------------------- 13, 14, 15: the runner

type Piece = [text: string, stream?: 'stdout' | 'stderr']
const runner = (pieces: Piece[], o: { silent?: boolean; endsAfter?: number } = {}) => {
  const seen = { env: {} as Record<string, string>, after: [] as number[], childEnded: false, subscribed: 0 }
  let i = 0
  const $ = {
    clock: {
      now: async () => 1,
      after: (ms: number, fn: () => void) => {
        seen.after.push(ms)
        const t = o.silent ? setTimeout(fn, seen.after.length === 1 ? 5 : 500) : undefined
        return { cancel: () => (t === undefined ? undefined : clearTimeout(t)) }
      },
    },
    fs: { list: async () => [] },
    process: {
      spawn: (q: { env: Record<string, string> }) => {
        seen.env = q.env
        return {
          next: () => {
            if (o.silent) return new Promise(() => undefined)
            const p = pieces[i++]
            return Promise.resolve(p ? { done: false, value: { text: p[0], stream: p[1] ?? 'stdout' } } : { done: true, value: { code: 0, signal: null } })
          },
          return: () => new Promise(done => setTimeout(() => ((seen.childEnded = true), done({ done: true })), o.endsAfter ?? 1)),
        }
      },
    },
  } as unknown as EngineInterface
  return { $, seen }
}
const V = 'FAKEvalue1234567890'

test('14: a token split by the other pipe is masked', async () => {
  const w = runner([['GITHUB_TOKEN=gh'], ['progress\n', 'stderr'], [`p_${V}\n`]])
  expect((await runCheck(w.$, '/repo', lint, 'A', cancelSignal())).tail).not.toContain(V)
})

test('14: a secret whose head was cut away is masked', async () => {
  const body = `${'  filler\n'.repeat(2200)}  ${V}\n`
  for (const head of ['password: |\n', '-----BEGIN RSA PRIVATE KEY-----\n']) {
    const w = runner([[head], [body]])
    expect((await runCheck(w.$, '/repo', lint, 'A', cancelSignal())).tail).not.toContain(V)
  }
})

test('15: a stopped child is waited for, so the tree is read after it', async () => {
  const w = runner([], { silent: true, endsAfter: 60 })
  expect((await runCheck(w.$, '/repo', lint, 'A', cancelSignal())).result.execution).toBe('timed-out')
  expect(w.seen.childEnded).toBe(true)
})

// 13, output piling up on one promise, has no test here: the kit's intrinsics cannot be watched and it
// has no heap to read. It is why runner.ts replaces its waker each piece instead of racing one promise.

test('mutation: the time limit and the blanked credentials', async () => {
  const w = runner([])
  await runCheck(w.$, '/repo', lint, 'A', cancelSignal())
  expect(w.seen.after[0]).toBe(60_000)
  for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'NPM_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AZURE_CLIENT_SECRET']) expect(w.seen.env[name]).toBe('')
})

test('mutation: the digest holds every field of what runs', async () => {
  const base = await grants.digestOf('/repo', [unit])
  const others: [string, ProofCheck][] = [['/repo', { ...unit, kind: 'lint' }], ['/repo', { ...unit, timeoutS: 61 }], ['/repo', { ...unit, required: false }], ['/repo', { ...unit, count: { ...unit.count!, parser: 'pass-fail-lines' } }], ['/else', unit]]
  for (const [root, check] of others) expect(await grants.digestOf(root, [check])).not.toBe(base)
})
