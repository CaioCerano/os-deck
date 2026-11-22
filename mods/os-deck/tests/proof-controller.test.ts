import type { EngineInterface } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import * as proof from '../hooks/proof/controller'
import { presentProof } from '../hooks/proof/present'
import { EMPTY_PROOF, EMPTY_WORK } from '../hooks/proof/state'
import type { Plan, ProofSession, ProofWork, TaskStatus } from '../types'

// The lifecycle end to end through the controller, on a repository, a store and a clock made of plain
// objects: task events and presses in, what the dock would draw out.

const ROOT = '/repo'
const pause = (ms: number) => new Promise(done => setTimeout(done, ms))
let sessions = 0

const world = (ROOT = '/repo') => {
  const files: Record<string, string> = { 'package.json': JSON.stringify({ scripts: { test: 'bun test' } }), 'a.ts': 'one' }
  const w = {
    files,
    session: `S${++sessions}`,
    spawned: [] as string[][],
    git: 0,
    toasts: [] as string[],
    agents: [] as { status: string }[],
    watching: 0,
    hold: null as Promise<void> | null,
    ignored: [] as string[],
    missing: [] as string[],
    dangling: [] as string[],
    links: {} as Record<string, string>,
    output: ' 3 pass\n 0 fail\nRan 3 tests across 1 file.\n',
    code: 0,
    store: new Map<string, unknown>(),
    p: EMPTY_PROOF as ProofSession,
    work: EMPTY_WORK as ProofWork,
    now: 1_000,
  }
  const hash = (s: string) => {
    let h = 7
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
    return (h >>> 0).toString(16).padStart(8, '0').repeat(5)
  }
  const run = async (argv: string[], init?: { stdin?: string }) => {
    w.git += 1
    const ok = (stdout: string, exitCode = 0) => ({ exitCode, stdout, stderr: '', isStdoutTruncated: false })
    if (argv.includes('--show-toplevel')) return ok(`${ROOT}\n`)
    if (argv.includes('--git-path')) return ok('.git/info/exclude\n')
    if (argv.includes('--stage')) return ok(Object.keys(files).sort().filter(f => !w.ignored.includes(f)).map(f => `100644 ${'a'.repeat(40)} 0\t${f}\0`).join(''))
    if (argv.includes('hash-object')) return ok((init?.stdin ?? '').split('\n').filter(Boolean).map(f => `${hash(files[f] ?? '')}\n`).join(''))
    if (argv.includes('config') || argv.includes('HEAD')) return ok('', 1)
    return ok('')
  }
  const $ = {
    session: { id: async () => w.session, cwd: async () => ROOT },
    clock: {
      now: async () => ++w.now,
      // Short waits run at once and limits never: nothing here is slow.
      after: (ms: number, fn: () => void) => {
        const t = ms <= 500 ? setTimeout(fn, 1) : undefined
        return { cancel: () => (t === undefined ? undefined : clearTimeout(t)) }
      },
      every: () => {
        let isOn = true
        w.watching += 1
        const cancel = () => {
          if (isOn) w.watching -= 1
          isOn = false
        }
        return { cancel }
      },
    },
    agent: { list: async () => w.agents },
    ui: { toast: (text: string) => void w.toasts.push(text) },
    store: {
      get: async (k: string) => w.store.get(k),
      set: async (k: string, v: unknown) => void w.store.set(k, JSON.parse(JSON.stringify(v))),
      delete: async (k: string) => void w.store.delete(k),
      keys: async () => [...w.store.keys()],
    },
    fs: {
      list: async (path: string) =>
        path.toLowerCase() === ROOT.toLowerCase() ? [{ name: '.git', kind: 'dir', size: 0, isLink: false }, ...Object.keys(files).map(name => ({ name, kind: 'file', size: files[name]!.length, isLink: false }))] : [],
      read: async (path: string, options?: { as?: string }) => {
        const text = files[path.slice(ROOT.length + 1)] ?? ''
        return options?.as === 'bytes' ? { base64: btoa(String.fromCharCode(...new TextEncoder().encode(text))) } : text
      },
      stat: async (path: string) => {
        if (w.dangling.includes(path)) return { kind: 'other', size: 0, mtimeMs: 0, isLink: true }
        if (w.missing.includes(path)) throw new Error('ENOENT')
        return { kind: 'file', size: 1, mtimeMs: 0, isLink: false, realPath: w.links[path] ?? (path.toLowerCase().startsWith(`${ROOT.toLowerCase()}/`) || path.toLowerCase() === ROOT.toLowerCase() ? ROOT + path.slice(ROOT.length) : path) }
      },
    },
    process: {
      run,
      spawn: (q: { argv: string[] }) => {
        w.spawned.push(q.argv)
        let sent = false
        return {
          next: async () => {
            if (w.hold) await w.hold
            return sent ? { done: true, value: { code: w.code, signal: null } } : ((sent = true), { done: false, value: { stream: 'stdout', text: w.output } })
          },
          return: async () => ({ done: true }),
        }
      },
    },
  } as unknown as EngineInterface
  const ops = {
    proof: async () => w.p,
    setProof: async (fn: (p: ProofSession) => ProofSession) => void (w.p = fn(w.p)),
    work: async () => w.work,
    setWork: async (fn: (x: ProofWork) => ProofWork) => void (w.work = fn(w.work)),
  }

  const statuses = new Map<string, TaskStatus>()
  const plan = (): Plan => ({
    tasks: [...statuses].map(([id, status]) => ({ id, subject: `task ${id}`, activeForm: '', status, group: [], blockedBy: [], agents: [], startedAt: null, doneAt: null, source: 'task' as const })),
  })
  const task = async (taskId: string, status: TaskStatus) => {
    const before = plan()
    statuses.set(taskId, status)
    await proof.proofTaskChanged($, ops, { before, after: plan(), taskId, agentId: null, description: null })
  }
  const endTurn = async (reason = 'answer') => {
    await proof.proofTurnEnded($, ops, { isMain: true, reason })
    // Until it does nothing more, rather than for a time a busy machine can outlast.
    let before = ''
    for (let quiet = 0, i = 0; quiet < 6 && i < 120; i++) {
      await pause(25)
      const now = `${w.git} ${w.spawned.length} ${w.p.attempts.map(x => x.checks.length)}`
      quiet = now === before ? quiet + 1 : 0
      before = now
    }
  }
  const allow = async (auto = true) => {
    await proof.proofCommand($, ops, 'setup', true)
    await proof.pressAllow($, ops, ROOT, w.p.draft?.digest ?? '', auto)
  }
  const work = async (id = '1', text = 'two') => {
    await task(id, 'in_progress')
    files['a.ts'] = text
    await task(id, 'completed')
  }
  const view = async () => {
    await proof.refreshProof($, ops)
    return presentProof(w.p, w.work, proof.liveRuns(), null, w.now)
  }
  const accept = async () => {
    const b = (await view()).roots[0]!.baseline!
    await proof.pressBaseline($, ops, ROOT, b.attemptId, b.checkId, b.passed, b.skipped)
  }
  return { w, $, ops, task, endTurn, allow, work, view, accept }
}

test('nothing runs, and no git, before a press', async () => {
  const { w, $, ops, work, endTurn } = world()
  await work()
  await endTurn()
  const said = await proof.proofCommand($, ops, 'setup', true)
  expect(said).toContain('Nothing has run')
  expect(w.p.draft?.checks.map(c => c.argv)).toEqual([['npm', 'run', 'test']])
  expect([w.git, w.spawned.length]).toEqual([0, 0])
})

test('only what the person typed sets up or runs', async () => {
  const { w, $, ops } = world()
  for (const args of ['setup', 'check test -- bun test', 'run']) expect(await proof.proofCommand($, ops, args, false)).toBe('OS-Deck proof: type this command yourself.')
  expect([w.p.draft, w.spawned.length]).toEqual([null, 0])
})

test('claimed, run at the turn end, baseline accepted: verified; then changed: stale', async () => {
  const { w, allow, work, endTurn, view, accept } = world()
  await allow()
  expect(w.p.allowed[0]?.grant.auto).toBe(true)
  await work()
  expect((await view()).tasks[0]?.verdict.state).toBe('pending')
  expect(w.spawned).toEqual([])
  await endTurn()
  expect(w.spawned).toEqual([['npm', 'run', 'test']])
  expect((await view()).tasks[0]?.verdict.state).toBe('inconclusive')
  await accept()
  const done = await view()
  expect(done.tasks[0]?.verdict.state).toBe('verified')
  expect(done.tasks[0]?.isReviewed).toBe(false)
  w.files['a.ts'] = 'three'
  expect((await view()).tasks[0]?.verdict.state).toBe('stale')
})

test('a failing run is failed, and is not run again unless owed', async () => {
  const { w, allow, work, endTurn, view } = world()
  await allow()
  w.output = ' 2 pass\n 1 fail\nRan 3 tests across 1 file.\n'
  await work()
  await endTurn()
  expect((await view()).tasks[0]?.verdict.state).toBe('failed')
  await endTurn()
  expect(w.spawned.length).toBe(1)
})

test('an interrupted turn runs nothing', async () => {
  const { w, allow, work, endTurn } = world()
  await allow()
  await work()
  await endTurn('aborted')
  expect(w.spawned).toEqual([])
})

test('a run waits for the agents still at work', async () => {
  const { w, $, ops, allow, work, endTurn } = world()
  await allow()
  await work()
  w.agents = [{ status: 'running' }]
  await endTurn()
  expect(w.spawned).toEqual([])
  w.agents = []
  await proof.proofTurnEnded($, ops, { isMain: false, reason: 'answer' })
  await pause(80)
  expect(w.spawned.length).toBe(1)
})

test('manual only waits for the press', async () => {
  const { w, $, ops, allow, work, endTurn } = world()
  await allow(false)
  await work()
  await endTurn()
  expect(w.spawned).toEqual([])
  await proof.pressVerify($, ops, ROOT)
  await pause(80)
  expect(w.spawned.length).toBe(1)
})

test('a script changed after the press runs nothing, automatic or pressed', async () => {
  const { w, $, ops, allow, work, endTurn, view } = world()
  await allow()
  await work()
  w.files['package.json'] = JSON.stringify({ scripts: { test: 'node evil.js' } })
  await endTurn()
  await proof.pressVerify($, ops, ROOT)
  await pause(80)
  expect(w.spawned).toEqual([])
  expect((await view()).roots[0]?.paused).toEqual(['package.json'])
})

test('resume shows setup again and allows nothing itself', async () => {
  const { w, $, ops, allow } = world()
  await allow()
  const watched = JSON.stringify(w.p.allowed[0]?.watched)
  w.files['package.json'] = JSON.stringify({ scripts: { test: 'bun test --bail' } })
  await proof.pressResume($, ops, ROOT)
  expect(w.p.draft?.scripts[0]?.body).toBe('bun test --bail')
  expect(JSON.stringify(w.p.allowed[0]?.watched)).toBe(watched)
})

test('a body changed between draw and press is refused', async () => {
  const { w, $, ops } = world()
  await proof.proofCommand($, ops, 'setup', true)
  const drawn = w.p.draft?.digest ?? ''
  w.files['package.json'] = JSON.stringify({ scripts: { test: 'node evil.js' } })
  await proof.pressAllow($, ops, ROOT, drawn, true)
  expect(w.p.allowed).toEqual([])
  expect(w.toasts[0]).toContain('the checks changed since they were shown')
})

test('a new session id ends every allowance and all evidence', async () => {
  const { w, $, ops, allow, work, endTurn, accept, view } = world()
  await allow()
  await work()
  await endTurn()
  await accept()
  expect((await view()).tasks[0]?.verdict.state).toBe('verified')
  w.session = `${w.session}-after-clear`
  await proof.proofSessionStarted($, ops)
  const after = await view()
  expect([after.roots, after.tasks, w.p.attempts]).toEqual([[], [], []])
})

test('saved runs come back as history alone', async () => {
  const { w, $, ops, allow, work, endTurn, accept, view } = world()
  await allow()
  await work()
  await endTurn()
  await accept()
  await pause(30)
  expect(w.p.notSaved).toBe(false)
  w.session = `${w.session}-next`
  await proof.proofCommand($, ops, 'setup', true)
  expect(w.p.draft?.source).toBe('saved')
  expect(w.p.draft?.checks[0]?.count?.minPassed).toBe(3)
  expect(w.p.past.length).toBeGreaterThan(0)
  expect([w.p.allowed, w.p.attempts, (await view()).tasks]).toEqual([[], [], []])
})

test('a reopened task withdraws its claim', async () => {
  const { w, allow, work, task } = world()
  await allow()
  await work()
  await task('1', 'in_progress')
  expect(w.p.claims.map(c => c.withdrawn)).toEqual([true])
})

test('overlapping tasks do not verify on each other', async () => {
  const { w, allow, task, endTurn, accept, view } = world()
  await allow()
  await task('1', 'in_progress')
  await task('2', 'in_progress')
  w.files['a.ts'] = 'two'
  await task('1', 'completed')
  await task('2', 'completed')
  await endTurn()
  await accept()
  const seen = await view()
  expect(seen.roots[0]?.verdict.state).toBe('verified')
  expect(seen.tasks.map(t => t.verdict.state)).toEqual(['inconclusive', 'inconclusive'])
})

test('a review binds to what was drawn', async () => {
  const { w, $, ops, allow, work, view } = world()
  await allow()
  await work()
  const t = (await view()).tasks[0]!
  await proof.pressReview($, ops, t.claim.id, t.drawn)
  expect((await view()).tasks[0]?.isReviewed).toBe(true)
  w.files['a.ts'] = 'three'
  expect((await view()).tasks[0]?.isReviewed).toBe(false)
})

// ---------------------------------------------------------------- what the red team got past

const planWith = (tasks: { id: string; subject: string; status: TaskStatus }[]): Plan => ({
  tasks: tasks.map(t => ({ ...t, activeForm: '', group: [], blockedBy: [], agents: [], startedAt: null, doneAt: null, source: 'task' as const })),
})
const claimed = { id: '1', subject: 'task 1', status: 'completed' as const }
const moved: [name: string, before: Plan, after: Plan][] = [
  ['renamed', planWith([claimed]), planWith([{ ...claimed, subject: 'security audit' }])],
  ['deleted', planWith([claimed]), planWith([])],
  ['deleted, unremembered', planWith([]), planWith([])],
  ['created again', planWith([]), planWith([{ ...claimed, status: 'pending' }])],
  ['started again, unremembered', planWith([]), planWith([{ ...claimed, status: 'in_progress' }])],
]
for (const [name, before, after] of moved)
  test(`C2: a claimed task ${name} keeps no claim`, async () => {
    const { w, $, ops, allow, work } = world()
    await allow()
    await work()
    await proof.proofTaskChanged($, ops, { before, after, taskId: '1', agentId: null, description: null })
    expect(w.p.claims.map(c => c.withdrawn)).toEqual([true])
  })

test('C3: a clock set back does not hide a failure', async () => {
  const { w, $, ops, allow, work, endTurn, accept, view } = world()
  await allow()
  await work()
  await endTurn()
  await accept()
  w.now -= 500
  w.output = ' 0 pass\n 3 fail\nRan 3 tests across 1 file.\n'
  await proof.pressVerify($, ops, ROOT)
  await pause(80)
  expect(w.spawned.length).toBe(2)
  expect((await view()).roots[0]?.verdict.state).not.toBe('verified')
})

test('C3: a clock set back does not freeze the content seen', async () => {
  const { w, allow, work, endTurn, accept, view } = world()
  await allow()
  await work()
  await endTurn()
  await accept()
  expect((await view()).roots[0]?.verdict.state).toBe('verified')
  w.now -= 500
  w.files['a.ts'] = 'three'
  expect((await view()).roots[0]?.verdict.state).toBe('stale')
})

test('C3: a new allowance takes no evidence from the one before, whatever the clock', async () => {
  const { w, allow, work, endTurn, accept, view } = world()
  await allow()
  await work()
  await endTurn()
  await accept()
  w.now -= 500
  await allow()
  expect((await view()).roots[0]?.verdict.state).toBe('pending')
  expect(w.p.attempts).toEqual([])
})

test('H4: a resume keeps the watch', async () => {
  const { w, $, ops } = world()
  await proof.proofSessionStarted($, ops)
  expect(w.watching).toBe(1)
  await proof.proofSessionEnded(ops, 'resume' as never)
  expect(w.watching).toBe(1)
})

test('H5: a command runs nothing: a link could have sent it', async () => {
  const { w, $, ops, allow } = world()
  await allow(false)
  expect(await proof.proofCommand($, ops, 'run', true)).toContain('press verify')
  await pause(80)
  expect(w.spawned).toEqual([])
})

for (const how of ['allowed again as manual only', 'a turn started'])
  test(`H6: a queued automatic run does not start once ${how}`, async () => {
    const first = world('/rep1')
    const second = world()
    await first.allow(false)
    await second.allow()
    let release = () => undefined as void
    first.w.hold = new Promise(done => (release = done))
    await proof.pressVerify(first.$, first.ops, '/rep1')
    await second.work()
    await second.endTurn()
    expect(second.w.spawned).toEqual([])
    if (how === 'a turn started') await proof.proofTurnStarted(second.ops)
    else await second.allow(false)
    release()
    await pause(120)
    expect(second.w.spawned).toEqual([])
  })

test("H7: another agent's edit inside a task leaves attribution unknown", async () => {
  const { w, $, ops, allow, task, endTurn, accept, view } = world()
  await allow()
  await task('1', 'in_progress')
  w.files['a.ts'] = 'two'
  await proof.proofToolRan($, ops, `${ROOT}/a.ts`, 'agent-other')
  await task('1', 'completed')
  await endTurn()
  await accept()
  expect((await view()).tasks[0]?.verdict.state).toBe('inconclusive')
})

test("H7: its own agent's edit is its own", async () => {
  const { w, $, ops, allow, task, endTurn, accept, view } = world()
  await allow()
  await task('1', 'in_progress')
  w.files['a.ts'] = 'two'
  await proof.proofToolRan($, ops, `${ROOT}/a.ts`, null)
  await task('1', 'completed')
  await endTurn()
  await accept()
  expect((await view()).tasks[0]?.verdict.state).toBe('verified')
})

test('H7: an edit through a link out of the repository is outside', async () => {
  const { w, $, ops, allow, task } = world()
  await allow()
  await task('1', 'in_progress')
  w.files['a.ts'] = 'two'
  w.links[`${ROOT}/linked/x.ts`] = '/elsewhere/x.ts'
  await proof.proofToolRan($, ops, `${ROOT}/linked/x.ts`, null)
  await task('1', 'completed')
  expect(w.p.claims[0]?.outside).toEqual(['/elsewhere/x.ts'])
})

test('H9: what a press refused, a second press cannot allow', async () => {
  const { w, $, ops } = world()
  await proof.proofCommand($, ops, 'setup', true)
  const drawn = w.p.draft?.digest ?? ''
  w.files['package.json'] = JSON.stringify({ scripts: { test: 'node evil.js' } })
  await proof.pressAllow($, ops, ROOT, drawn, true)
  expect(w.p.draft).toBe(null)
})

test('M1: a completion with no baseline still owes a run', async () => {
  const { w, allow, task, endTurn } = world()
  await allow()
  w.files['a.ts'] = 'two'
  await task('1', 'completed')
  await endTurn()
  expect(w.spawned.length).toBe(1)
})

test('M2: discarded while allowing, nothing is allowed', async () => {
  const { w, $, ops } = world()
  await proof.proofCommand($, ops, 'setup', true)
  const drawn = w.p.draft?.digest ?? ''
  const { run } = $.process
  // Discarded once the press is past its first look at the draft.
  ;($ as unknown as { process: { run: unknown } }).process.run = (...args: Parameters<typeof run>) => {
    w.p = { ...w.p, draft: null }
    return run(...args)
  }
  await proof.pressAllow($, ops, ROOT, drawn, true)
  expect(w.p.allowed).toEqual([])
})

test('L4: a drive in another case is the same repository', async () => {
  const { w, $, ops } = world('C:/repo')
  await proof.proofCommand($, ops, 'setup c:/repo', true)
  expect(w.p.draft?.root).toBe('C:/repo')
})

test('L5: another session id, with no end seen, draws no old evidence', async () => {
  const { w, allow, work, endTurn, accept, view } = world()
  await allow()
  await work()
  await endTurn()
  await accept()
  w.session = `${w.session}-resumed`
  expect((await view()).tasks).toEqual([])
})

test('L1: a run that kept no output shows none of the run before', async () => {
  const { w, $, ops, allow, work, endTurn } = world()
  await allow()
  await work()
  await endTurn()
  w.files['package.json'] = JSON.stringify({ scripts: { test: 'bun test --bail' } })
  await proof.pressVerify($, ops, ROOT)
  await pause(80)
  await proof.pressShowLog(ops, ROOT, 'test')
  expect(proof.logShown()?.text).toBe('no output kept')
})

test('L2: the runs that use up claims are kept past a hundred', async () => {
  const { w, $, ops, allow, work, endTurn } = world()
  await allow()
  await work()
  await endTurn()
  const ran = w.p.attempts[0]!
  w.p = { ...w.p, attempts: Array.from({ length: 150 }, (_, i) => ({ ...ran, id: `kept${i}` })) }
  await proof.pressVerify($, ops, ROOT)
  await pause(80)
  expect(w.p.attempts.length).toBe(151)
})

test('C1: a file git ignores, appearing after allow, pauses and runs nothing', async () => {
  const { w, allow, work, endTurn, view } = world()
  await allow()
  await work()
  w.ignored = ['.npmrc']
  w.files['.npmrc'] = 'loglevel=silent\n'
  await endTurn()
  expect(w.spawned).toEqual([])
  expect((await view()).roots[0]?.paused).toEqual(['.npmrc'])
})

test('H2: what cannot be resolved is never automatic, whatever is pressed', async () => {
  const { w, $, ops } = world()
  await proof.proofCommand($, ops, 'check lint -- cargo check', true)
  expect(w.p.draft?.manualOnly).toBeTruthy()
  await proof.pressAllow($, ops, ROOT, w.p.draft?.digest ?? '', true)
  expect(w.p.allowed[0]?.grant.auto).toBe(false)
})

// ---------------------------------------------------------------- what the review found

test('review 1: steady tool calls do not postpone the re-read', async () => {
  const { w, $, ops, allow } = world()
  await allow()
  let set = 0
  let cancelled = 0
  const { clock } = $
  ;($ as unknown as { clock: unknown }).clock = {
    ...clock,
    after: (ms: number, fn: () => void) => {
      if (ms !== 2000) return clock.after(ms, fn)
      set += 1
      return { cancel: () => void (cancelled += 1) }
    },
  }
  // Whatever timer an earlier test left is ended first.
  await proof.proofSessionEnded(ops, 'resume')
  await allow()
  set = cancelled = 0
  for (let i = 0; i < 5; i++) await proof.proofToolRan($, ops, null)
  expect([set, cancelled]).toEqual([1, 0])
  await proof.proofSessionEnded(ops, 'other')
  expect(w.p.allowed).toEqual([])
})

test('review 2: a run that ends after a resume to the same session records nothing', async () => {
  const { w, $, ops, allow } = world()
  await allow()
  let release = () => undefined as void
  w.hold = new Promise(done => (release = done))
  await proof.pressVerify($, ops, ROOT)
  await pause(60)
  expect(w.spawned.length).toBe(1)
  await proof.proofSessionEnded(ops, 'resume')
  await proof.proofSessionStarted($, ops)
  release()
  await pause(100)
  expect(w.p.attempts).toEqual([])
})

test('review 3: an older read does not overwrite a newer pause', async () => {
  const { w, $, ops, allow } = world()
  await allow()
  const allowed = w.files['package.json']!
  w.files['package.json'] = JSON.stringify({ scripts: { test: 'node other.js' } })
  let release = () => undefined as void
  let waiting = () => undefined as void
  const held = new Promise<void>(done => (release = done))
  const isWaiting = new Promise<void>(done => (waiting = done))
  const slow = {
    ...ops,
    setWork: async (fn: (x: ProofWork) => ProofWork) => {
      await ops.setWork(fn)
      waiting()
      await held
    },
  }
  const older = proof.refreshProof($, slow)
  await isWaiting
  w.files['package.json'] = allowed
  await proof.refreshProof($, ops)
  release()
  await older
  expect(w.p.paused).toEqual([])
})

test('review 4: an allowance made manual as a queued run starts is not run by itself', async () => {
  const { w, $, ops, allow, work } = world()
  await allow()
  await work()
  let read = 0
  const asItStarts = {
    ...ops,
    work: async () => {
      read += 1
      return ops.work()
    },
    proof: async () => {
      const seen = w.p
      // The third look at the turn is the queue's: the allowance changes just after it is next read.
      if (read === 3 && seen.allowed[0]?.grant.auto) {
        w.p = { ...w.p, allowed: w.p.allowed.map(a => ({ ...a, grant: { ...a.grant, auto: false } })) }
      }
      return seen
    },
  }
  await proof.proofTurnEnded($, asItStarts, { isMain: true, reason: 'answer' })
  await pause(120)
  expect(w.p.allowed[0]?.grant.auto).toBe(false)
  expect(w.spawned).toEqual([])
})

test('review 5: a baseline is of the allowance it was drawn for', async () => {
  const { w, $, ops, allow, work, endTurn, view } = world()
  await allow()
  await work()
  await endTurn()
  const b = (await view()).roots[0]!.baseline!
  const replaced = {
    ...ops,
    setProof: async (fn: (p: ProofSession) => ProofSession) => {
      w.p = { ...w.p, allowed: w.p.allowed.map(a => ({ ...a, grant: { ...a.grant, digest: 'allowed again' } })) }
      await ops.setProof(fn)
    },
  }
  await proof.pressBaseline($, replaced, ROOT, b.attemptId, b.checkId, b.passed, b.skipped)
  expect(w.p.allowed[0]?.grant.checks[0]?.count?.minPassed).toBe(null)
})

test('review 11: what was claimed and reviewed is in the history shown', async () => {
  const { w, $, ops, allow, work, view } = world()
  await allow()
  await work()
  const t = (await view()).tasks[0]!
  await proof.pressReview($, ops, t.claim.id, t.drawn)
  await pause(40)
  const said = await proof.proofCommand($, ops, 'history', true)
  expect(said).toContain('history, not evidence')
  expect(said).toContain('claimed "task 1" · reviewed')
  expect(w.spawned).toEqual([])
})

test('N13: detection offers what can be allowed and says what it left out', async () => {
  const { w, $, ops } = world()
  w.files['package.json'] = JSON.stringify({ scripts: { lint: 'turbo lint', typecheck: 'tsc --noEmit' } })
  const said = await proof.proofCommand($, ops, 'setup', true)
  expect(w.p.draft?.checks.map(c => c.id)).toEqual(['typecheck'])
  expect(w.p.draft?.problem).toBe(null)
  expect(said).toContain('left out')
  expect(said).toContain('turbo')
})

test('N13: a typed check does not inherit the problem of the draft before it', async () => {
  const { w, $, ops } = world()
  await proof.proofCommand($, ops, 'check lint -- turbo lint', true)
  expect(w.p.draft?.problem).toBeTruthy()
  await proof.proofCommand($, ops, 'check typecheck -- tsc --noEmit', true)
  expect(w.p.draft?.problem).toBe(null)
})

test('N14: tests that cannot be counted are not made required by detection', async () => {
  const { w, $, ops } = world()
  w.files['package.json'] = JSON.stringify({ scripts: { test: 'jest', typecheck: 'tsc --noEmit' } })
  const said = await proof.proofCommand($, ops, 'setup', true)
  expect(w.p.draft?.checks.map(c => c.id)).toEqual(['typecheck'])
  expect(said).toContain('no way to count its tests')
})

// ---------------------------------------------------------------- what the second attack got past

const long = `${String.fromCharCode(0x2800).repeat(200)}Fix a typo`
const renamed: [name: string, after: Partial<Plan['tasks'][number]>][] = [
  ['past the part a claim keeps', { subject: long.replace('Fix a typo', 'Rewrite auth') }],
  ['by its group alone', { group: ['Rewrite auth, security audit'] }],
]
for (const [name, change] of renamed)
  test(`N8: a task renamed ${name} keeps no claim`, async () => {
    const { w, $, ops, allow } = world()
    await allow()
    const at = (status: TaskStatus, more: object = {}): Plan => ({ tasks: [{ ...planWith([{ id: '1', subject: long, status }]).tasks[0]!, ...more }] })
    const changed = (before: Plan, after: Plan) => proof.proofTaskChanged($, ops, { before, after, taskId: '1', agentId: null, description: null })
    await changed(at('pending'), at('in_progress'))
    w.files['a.ts'] = 'two'
    await changed(at('in_progress'), at('completed'))
    expect(w.p.claims.map(c => c.withdrawn)).toEqual([false])
    await changed(at('completed'), at('completed', change))
    expect(w.p.claims.map(c => c.withdrawn)).toEqual([true])
  })

test('N9: a read begun before a clear never lands after it', async () => {
  const { w, $, ops, allow } = world()
  await allow(false)
  let release = () => undefined as void
  let reading = () => undefined as void
  const held = new Promise<void>(done => (release = done))
  const isReading = new Promise<void>(done => (reading = done))
  const { run } = $.process
  let armed = true
  ;($ as unknown as { process: { run: unknown } }).process.run = async (...args: Parameters<typeof run>) => {
    const got = await run(...args)
    if (armed && (args[0] as string[]).includes('hash-object')) {
      armed = false
      reading()
      await held
    }
    return got
  }
  const late = proof.refreshProof($, ops)
  await isReading
  await proof.proofSessionEnded(ops, 'clear')
  w.session = `${w.session}-cleared`
  release()
  await late
  expect(w.work.seen).toEqual([])
})

test('N10: a turn that begins as a run reads stops it, and it is still owed', async () => {
  const { w, $, ops, allow, work, endTurn } = world()
  await allow()
  await work()
  const { run } = $.process
  ;($ as unknown as { process: { run: unknown } }).process.run = async (...args: Parameters<typeof run>) => {
    if ((args[0] as string[]).includes('hash-object') && proof.liveRuns().size > 0) await proof.proofTurnStarted(ops)
    return run(...args)
  }
  await endTurn()
  expect(w.spawned).toEqual([])
  ;($ as unknown as { process: { run: unknown } }).process.run = run
  await endTurn()
  expect(w.spawned.length).toBe(1)
})

test('N17: a changed file that became ignored is not a deletion', async () => {
  const { w, allow, task, endTurn, accept, view } = world()
  await allow()
  await task('1', 'in_progress')
  w.files['a.ts'] = 'two'
  w.ignored = ['a.ts']
  await task('1', 'completed')
  await endTurn()
  await accept()
  expect((await view()).tasks[0]?.verdict.state).toBe('inconclusive')
})

test('C3: after a step back a failure reads failed, not waiting', async () => {
  const { w, $, ops, allow, work, endTurn, accept, view } = world()
  await allow()
  await work()
  await endTurn()
  await accept()
  w.now -= 500
  w.output = ' 0 pass\n 3 fail\nRan 3 tests across 1 file.\n'
  await proof.pressVerify($, ops, ROOT)
  await pause(120)
  expect((await view()).roots[0]?.verdict.state).toBe('failed')
})

test('L2: one root’s attempts do not push out another’s', async () => {
  const { w, $, ops, allow, work, endTurn } = world()
  await allow()
  await work()
  await endTurn()
  const ran = w.p.attempts[0]!
  w.p = { ...w.p, attempts: [...Array.from({ length: 600 }, (_, i) => ({ ...ran, id: `here${i}` })), ...Array.from({ length: 600 }, (_, i) => ({ ...ran, root: '/other', id: `there${i}` }))] }
  await proof.pressVerify($, ops, ROOT)
  await pause(120)
  expect(w.p.attempts.length).toBe(1201)
})

// ---------------------------------------------------------------- what the third attack got past

test('A5: a baseline read before a clear is not the next session’s', async () => {
  const { w, $, ops, allow, task } = world()
  await allow(false)
  let release = () => undefined as void
  let reading = () => undefined as void
  const held = new Promise<void>(done => (release = done))
  const isReading = new Promise<void>(done => (reading = done))
  const { run } = $.process
  let armed = true
  ;($ as unknown as { process: { run: unknown } }).process.run = async (...args: Parameters<typeof run>) => {
    const got = await run(...args)
    if (armed && (args[0] as string[]).includes('hash-object')) {
      armed = false
      reading()
      await held
    }
    return got
  }
  const starting = task('1', 'in_progress')
  await isReading
  await proof.proofSessionEnded(ops, 'clear')
  w.session = `${w.session}-cleared`
  await proof.proofCommand($, ops, 'setup', true)
  release()
  await starting
  await pause(60)
  expect(w.work.tracking.open).toEqual([])
})

for (const [whose, agentId, path] of [['another agent’s', 'agent-other', '/repo/a.ts'], ['an outside', null, '/elsewhere/x.ts']] as const)
  test(`A6: ${whose} edit still in flight as the task completes is seen`, async () => {
    const { w, allow, task, endTurn, accept, view } = world()
    await allow()
    await task('1', 'in_progress')
    const id = `edit-${w.session}`
    proof.proofEditStarted(id, { tool: 'Write', input: { file_path: path }, agentId })
    w.files['a.ts'] = 'two'
    await task('1', 'completed')
    proof.proofEditSettled(id)
    await endTurn()
    await accept()
    expect((await view()).tasks[0]?.verdict.state).toBe('inconclusive')
  })

test('A7: reviewing an empty claim does not review what its task changed before', async () => {
  const { w, $, ops, allow, task, work, endTurn, accept, view } = world()
  await allow()
  await work()
  await endTurn()
  await accept()
  await task('1', 'in_progress')
  await task('1', 'completed')
  const empty = (await view()).tasks[0]!
  expect(empty.claim.changes).toEqual([])
  await proof.pressReview($, ops, empty.claim.id, empty.drawn)
  expect((await view()).roots[0]?.unreviewed).toBe(1)
  expect(w.p.reviews.length).toBe(1)
})

test('A8: history gives a review to the claim that was reviewed, not to a later one of its id', async () => {
  const { w, $, ops, allow, task, work, view } = world()
  await allow()
  await work()
  const first = (await view()).tasks[0]!
  await proof.pressReview($, ops, first.claim.id, first.drawn)
  await pause(40)
  // As another process of the same session would number them: from one again.
  w.p = { ...w.p, claims: [] }
  await task('1', 'in_progress')
  w.files['a.ts'] = 'three'
  await task('1', 'completed')
  expect(w.p.claims[0]?.id).toBe(first.claim.id)
  await pause(40)
  expect((await proof.proofCommand($, ops, 'history', true)).split('· reviewed').length - 1).toBe(1)
})

test('a run stopped by a turn that began is still owed, though it had started', async () => {
  const { w, $, ops, allow, work, endTurn } = world()
  w.files['package.json'] = JSON.stringify({ scripts: { test: 'bun test', typecheck: 'tsc --noEmit' } })
  await allow()
  await work()
  const { spawn } = $.process
  ;($ as unknown as { process: { spawn: unknown } }).process.spawn = (q: never) => {
    if (w.spawned.length === 0) w.work = { ...w.work, turnEnded: false }
    return spawn(q)
  }
  await endTurn()
  expect(w.spawned.length).toBe(1)
  await endTurn()
  expect(w.spawned.length).toBe(3)
})

test('a run the person cancelled is not started again by the next turn', async () => {
  const { w, $, ops, allow, work, endTurn } = world()
  await allow()
  await work()
  const { run } = $.process
  let armed = true
  ;($ as unknown as { process: { run: unknown } }).process.run = async (...args: Parameters<typeof run>) => {
    if (armed && (args[0] as string[]).includes('hash-object') && proof.liveRuns().size > 0) {
      armed = false
      await proof.pressCancel(ROOT)
      await proof.proofTurnStarted(ops)
    }
    return run(...args)
  }
  await endTurn()
  await endTurn()
  expect(w.spawned).toEqual([])
})

test('work done while a task was back to pending is not that task’s', async () => {
  const { w, allow, task } = world()
  await allow()
  await task('1', 'in_progress')
  await task('1', 'pending')
  w.files['a.ts'] = 'two'
  await task('1', 'in_progress')
  await task('1', 'completed')
  expect(w.p.claims[0]?.changes).toEqual([])
})

test('guard: automatic switched off as a run reads starts nothing, under the same allowance', async () => {
  const { w, $, allow, work, endTurn } = world()
  await allow()
  await work()
  const { run } = $.process
  ;($ as unknown as { process: { run: unknown } }).process.run = async (...args: Parameters<typeof run>) => {
    if ((args[0] as string[]).includes('hash-object') && proof.liveRuns().size > 0)
      w.p = { ...w.p, allowed: w.p.allowed.map(a => ({ ...a, grant: { ...a.grant, auto: false } })) }
    return run(...args)
  }
  await endTurn()
  expect(w.spawned).toEqual([])
})

test('guard: a cancel after a turn stopped the run still means no more runs', async () => {
  const { w, $, ops, allow, work, endTurn } = world()
  await allow()
  await work()
  const { run } = $.process
  let armed = true
  ;($ as unknown as { process: { run: unknown } }).process.run = async (...args: Parameters<typeof run>) => {
    if (armed && (args[0] as string[]).includes('hash-object') && proof.liveRuns().size > 0) {
      armed = false
      await proof.proofTurnStarted(ops)
    }
    return run(...args)
  }
  const cancels = {
    ...ops,
    work: async () => {
      const seen = await ops.work()
      // The run has been told the turn began; only then does the person cancel it.
      if (!armed && !seen.turnEnded && proof.liveRuns().size > 0) await proof.pressCancel(ROOT)
      return seen
    },
  }
  await proof.proofTurnEnded($, cancels, { isMain: true, reason: 'answer' })
  await pause(200)
  expect(w.spawned).toEqual([])
  await endTurn()
  expect(w.spawned).toEqual([])
})

// ---------------------------------------------------------------- what the fourth attack got past

for (const [whose, agentId, path] of [['another agent’s', 'agent-other', '/repo/a.ts'], ['an outside', null, '/elsewhere/x.ts']] as const)
  test(`R1: ${whose} edit that settles during the completion's read is seen`, async () => {
    const { w, $, allow, task, endTurn, accept, view } = world()
    await allow()
    await task('1', 'in_progress')
    const id = `settles-${w.session}`
    proof.proofEditStarted(id, { tool: 'Write', input: { file_path: path }, agentId })
    w.files['a.ts'] = 'two'
    const { run } = $.process
    let armed = true
    ;($ as unknown as { process: { run: unknown } }).process.run = async (...args: Parameters<typeof run>) => {
      if (armed && (args[0] as string[]).includes('hash-object')) {
        armed = false
        proof.proofEditSettled(id)
      }
      return run(...args)
    }
    await task('1', 'completed')
    expect(armed).toBe(false)
    await endTurn()
    await accept()
    expect((await view()).tasks[0]?.verdict.state).toBe('inconclusive')
  })

test('R2: a stopped run that ran something keeps what it saw, and is still owed', async () => {
  const { w, $, ops, allow, task, endTurn, accept, view } = world()
  w.files['package.json'] = JSON.stringify({ scripts: { test: 'bun test', typecheck: 'tsc --noEmit' } })
  await allow()
  await task('1', 'in_progress')
  // Verified by a press before the completion, so an automatic run is owed on the same content.
  w.files['a.ts'] = 'two'
  await proof.pressVerify($, ops, ROOT)
  await pause(120)
  await accept()
  expect((await view()).roots[0]?.verdict.state).toBe('verified')
  await task('1', 'completed')
  const { spawn } = $.process
  const spawned = w.spawned.length
  ;($ as unknown as { process: { spawn: unknown } }).process.spawn = (q: never) => {
    if (w.spawned.length === spawned) w.work = { ...w.work, turnEnded: false }
    return spawn(q)
  }
  w.output = ' 1 pass\n 0 fail\nRan 1 test across 1 file.\n'
  await endTurn()
  expect(w.spawned.length).toBe(spawned + 1)
  expect((await view()).roots[0]?.verdict.state).not.toBe('verified')
  await endTurn()
  expect(w.spawned.length).toBe(spawned + 3)
})

for (const [what, agentId, path] of [['an outside edit', null, '/elsewhere/x.ts'], ['another agent’s edit', 'agent-other', '/repo/a.ts']] as const)
  test(`R3: back to pending does not wash away ${what}`, async () => {
    const { w, $, ops, allow, task, endTurn, accept, view } = world()
    await allow()
    await task('1', 'in_progress')
    await proof.proofToolRan($, ops, path, agentId)
    await pause(20)
    await task('1', 'pending')
    await task('1', 'in_progress')
    w.files['a.ts'] = 'two'
    await task('1', 'completed')
    await endTurn()
    await accept()
    expect((await view()).tasks[0]?.verdict.state).toBe('inconclusive')
  })

test('R4: a review of one repository reviews no other', async () => {
  const { w, $, ops, allow, view } = world()
  await allow()
  const here = w.p.allowed[0]!
  w.p = {
    ...w.p,
    allowed: [here, { ...here, grant: { ...here.grant, root: '/second' } }],
    claims: [{ id: 'c', session: w.p.session, taskId: '1', subject: 't', description: '', agentId: null, at: w.now, hasBaseline: false, changes: [{ root: ROOT, paths: [{ path: 'a.ts', hash: 'h' }], overlap: [] }], outside: [], withdrawn: false }],
  }
  await proof.pressReview($, ops, 'c', [{ root: ROOT, revision: 'r' }])
  expect((await view()).roots.map(r => r.unreviewed)).toEqual([0, 1])
})

test('R6: history lends no review to an earlier claim of the same id', async () => {
  const { w, $, ops, allow, work, task, view } = world()
  await allow()
  await work()
  const first = w.p.claims[0]!
  await pause(40)
  // Another process numbers from one again, and saves its claim under another root: this one has only the review.
  w.p = { ...w.p, claims: [] }
  await task('1', 'in_progress')
  w.files['a.ts'] = 'three'
  await task('1', 'completed')
  await pause(40)
  const later = (await view()).tasks[0]!
  expect(later.claim.id).toBe(first.id)
  await proof.pressReview($, ops, later.claim.id, later.drawn)
  await pause(40)
  for (const key of [...w.store.keys()]) if (key.includes(':c:') && key.includes(`:${Math.floor(later.claim.at)}:`)) w.store.delete(key)
  const said = await proof.proofCommand($, ops, 'history', true)
  expect(said).toContain('claimed "task 1"')
  expect(said).not.toContain('reviewed')
})

test('a task left pending poisons no later task, nor its own next start', async () => {
  const { w, $, ops, allow, task, endTurn, accept, view } = world()
  await allow()
  await task('1', 'in_progress')
  await task('1', 'pending')
  await task('2', 'in_progress')
  w.files['a.ts'] = 'two'
  await proof.proofToolRan($, ops, '/repo/a.ts', 'agent-two')
  await task('2', 'completed')
  // Its editor is not its claimant: only the overlap is asked here.
  expect(w.p.claims[0]?.changes[0]?.overlap).not.toContain('1')
  await task('1', 'in_progress')
  w.files['a.ts'] = 'three'
  await task('1', 'completed')
  await endTurn()
  await accept()
  expect((await view()).tasks.find(t => t.claim.taskId === '1')?.verdict.state).toBe('verified')
})

for (const how of ['cancelled', 'failed'] as const)
  test(`guard: a run that ran something, was stopped by a turn and ${how}, is not owed again`, async () => {
    const { w, $, ops, allow, work, endTurn, view } = world()
    w.files['package.json'] = JSON.stringify({ scripts: { test: 'bun test', typecheck: 'tsc --noEmit' } })
    await allow()
    await work()
    if (how === 'failed') w.code = 1
    const { spawn } = $.process
    ;($ as unknown as { process: { spawn: unknown } }).process.spawn = (q: never) => {
      if (w.spawned.length === 0) w.work = { ...w.work, turnEnded: false }
      return spawn(q)
    }
    const cancels = {
      ...ops,
      work: async () => {
        const seen = await ops.work()
        // The run has been told the turn began; only then does the person cancel it.
        if (how === 'cancelled' && w.spawned.length > 0 && !seen.turnEnded && proof.liveRuns().size > 0) await proof.pressCancel(ROOT)
        return seen
      },
    }
    await proof.proofTurnEnded($, cancels, { isMain: true, reason: 'answer' })
    await pause(250)
    expect(w.spawned.length).toBe(1)
    await endTurn()
    expect(w.spawned.length).toBe(1)
    if (how === 'failed') expect((await view()).roots[0]?.verdict.state).toBe('failed')
  })

// ---------------------------------------------------------------- what the fifth attack got past

for (const [whose, agentId, path] of [['an outside', null, '/elsewhere/x.ts'], ['another agent’s', 'agent-other', '/repo/a.ts']] as const)
  test(`S1: ${whose} edit under way as a task goes back to pending is kept`, async () => {
    const { w, allow, task, endTurn, accept, view } = world()
    await allow()
    await task('1', 'in_progress')
    const id = `waits-${w.session}`
    proof.proofEditStarted(id, { tool: 'Write', input: { file_path: path }, agentId })
    await task('1', 'pending')
    proof.proofEditSettled(id)
    await pause(20)
    await task('1', 'in_progress')
    w.files['a.ts'] = 'two'
    await task('1', 'completed')
    await endTurn()
    await accept()
    expect((await view()).tasks[0]?.verdict.state).toBe('inconclusive')
  })

test('S2: a review of no change covers no repository allowed after it', async () => {
  const { w, $, ops, allow, task, view } = world()
  await allow()
  await task('1', 'in_progress')
  await task('1', 'completed')
  const empty = (await view()).tasks[0]!
  await proof.pressReview($, ops, empty.claim.id, empty.drawn)
  expect((await view()).tasks[0]?.isReviewed).toBe(true)
  const here = w.p.allowed[0]!
  w.p = { ...w.p, allowed: [here, { ...here, grant: { ...here.grant, root: '/second' } }] }
  expect((await view()).tasks[0]?.isReviewed).toBe(false)
})

for (const how of ['a link, then folders not made yet', 'a link that leads nowhere yet'] as const)
  test(`S3: an edit in flight through ${how} is outside`, async () => {
    const { w, allow, task } = world()
    await allow()
    await task('1', 'in_progress')
    const file = `${ROOT}/linked/new/deeper/x.ts`
    w.missing = [file, `${ROOT}/linked/new/deeper`, `${ROOT}/linked/new`]
    if (how === 'a link that leads nowhere yet') {
      w.missing.push(`${ROOT}/linked`)
      w.dangling = [`${ROOT}/linked`]
    } else w.links[`${ROOT}/linked`] = '/elsewhere'
    const id = `link-${w.session}`
    proof.proofEditStarted(id, { tool: 'Write', input: { file_path: file }, agentId: null })
    w.files['a.ts'] = 'two'
    await task('1', 'completed')
    proof.proofEditSettled(id)
    expect(w.p.claims[0]?.outside.length).toBe(1)
  })

// ---------------------------------------------------------------- what the sixth attack got past

const OUT = ['/q/../repo/a.ts', '/Q/repo/a.ts', '/repo/a.ts', '\\repo\\a.ts', 'a.ts', './a.ts', 'real-work.md', '\\beside\\x.ts', '/beside/x.ts', '~/notes/x.md', '~someone/x.md', 'C:x.ts', 'D:\\beside\\x.ts', '\\\\host\\share\\x.ts', '//host/share/x.ts', '  ~/x.md', 'a.ts:hidden']
for (const when of ['returned', 'in flight'] as const)
  test(`T1: an outside edit ${when} is outside, however it is spelled`, async () => {
    for (const path of OUT) {
      const { w, $, ops, allow, task } = world('C:/repo')
      await allow()
      await task('1', 'in_progress')
      const id = `spelled-${w.session}`
      if (when === 'returned') await proof.proofToolRan($, ops, path, null)
      else proof.proofEditStarted(id, { tool: 'Write', input: { file_path: path }, agentId: null })
      w.files['a.ts'] = 'two'
      await task('1', 'completed')
      proof.proofEditSettled(id)
      expect([path, w.p.claims[0]?.outside.length]).toEqual([path, 1])
    }
  })

test('T1: an inside edit is inside, however it is spelled', async () => {
  for (const path of ['C:\\repo\\a.ts', 'C:/repo/a.ts', ' C:/repo/a.ts ', '/c/repo/a.ts', '/C/repo/a.ts', 'c:/REPO/a.ts']) {
    const { w, $, ops, allow, task } = world('C:/repo')
    await allow()
    await task('1', 'in_progress')
    await proof.proofToolRan($, ops, path, null)
    w.files['a.ts'] = 'two'
    await task('1', 'completed')
    expect([path, w.p.claims[0]?.outside]).toEqual([path, []])
  }
})

test('T2: a dangling link named by an alias still leads nowhere', async () => {
  const { w, allow, task } = world()
  await allow()
  await task('1', 'in_progress')
  // No listing has this name: only stat knows what it is.
  const alias = `${ROOT}/AVERYL~1`
  w.dangling = [alias]
  w.missing = [`${alias}/x.ts`]
  const id = `alias-${w.session}`
  proof.proofEditStarted(id, { tool: 'Write', input: { file_path: `${alias}/x.ts` }, agentId: null })
  w.files['a.ts'] = 'two'
  await task('1', 'completed')
  proof.proofEditSettled(id)
  expect(w.p.claims[0]?.outside.length).toBe(1)
})

test('C3: setup takes a folder with no drive to the drive it is on, and one it cannot place to none', async () => {
  const { w, $, ops } = world('C:/repo')
  await proof.proofCommand($, ops, 'setup /repo', true)
  expect(w.p.draft?.root).toBe('C:/repo')
  for (const folder of ['~/repo', 'C:repo', '//host/share']) expect([folder, await proof.proofCommand($, ops, `setup ${folder}`, true)]).toEqual([folder, 'OS-Deck proof: give a folder on this machine, without "~" or "..".'])
})

test('U1: setup reads /d/ as that drive, as the file tools do', async () => {
  const { w, $, ops } = world('C:/repo')
  await proof.proofCommand($, ops, 'setup /c/repo', true)
  expect(w.p.draft?.root).toBe('C:/repo')
})

test('C3: a setup folder with no drive, beside the repository, is not taken into it', async () => {
  const { w, $, ops } = world('C:/repo')
  // Joined to the session's folder it would be C:/repo/beside, which walks up into the repository.
  expect(await proof.proofCommand($, ops, 'setup /beside', true)).toContain('not inside a git repository')
  expect(w.p.draft).toBe(null)
})

// ---------------------------------------------------------------- what the eighth attack got past

for (const when of ['returned', 'in flight'] as const)
  for (const how of ['named', 'through a link'] as const)
    test(`V1: off Windows a folder beside, with a backslash in its name, ${how}, ${when}, is outside`, async () => {
      // A plain fake, not the kit's: on a Windows host the kit respells what its fs is handed.
      const { w, $, ops, allow, task } = world()
      await allow()
      await task('1', 'in_progress')
      const beside = '/repo\\evil/real-work.md'
      const path = how === 'named' ? beside : `${ROOT}/alias/real-work.md`
      if (how !== 'named') w.links[path] = beside
      const id = `backslash-${w.session}`
      if (when === 'returned') await proof.proofToolRan($, ops, path, null)
      else proof.proofEditStarted(id, { tool: 'Write', input: { file_path: path }, agentId: null })
      w.files['a.ts'] = 'two'
      await task('1', 'completed')
      proof.proofEditSettled(id)
      expect(w.p.claims[0]?.outside).toEqual([beside])
    })

// ---------------------------------------------------------------- what the ninth attack got past

test('C1: on a drive that resolves to a share an inside edit is still inside', async () => {
  const { w, $, ops, allow, task } = world('C:/repo')
  await allow()
  await task('1', 'in_progress')
  // A string in stat's answer alone: nothing is asked of a share.
  const share = '\\\\host.invalid\\share\\repo'
  w.links['C:/repo'] = share
  w.links['C:/'] = '\\\\host.invalid\\share'
  w.links['C:/repo/a.ts'] = `${share}\\a.ts`
  await proof.proofToolRan($, ops, 'C:/repo/a.ts', null)
  w.files['a.ts'] = 'two'
  await task('1', 'completed')
  expect(w.p.claims[0]?.outside).toEqual([])
})

test('C2: off Windows a root with a backslash in its name keeps its whole name', async () => {
  const { allow, view } = world('/a\\repo')
  await allow()
  expect((await view()).roots[0]?.name).toBe('a\\repo')
})

for (const isMade of [true, false])
  test(`Y2: a folder one case from an allowed root is outside it, ${isMade ? 'made' : 'not made yet'}`, async () => {
    const { w, $, ops, allow, task } = world('C:/repo')
    await allow()
    await task('1', 'in_progress')
    // A case-sensitive folder of Windows holds both.
    const file = 'C:/Repo/x.ts'
    w.links = { 'C:/Repo': 'C:/Repo', [file]: file }
    if (!isMade) w.missing = [file]
    await proof.proofToolRan($, ops, file, null)
    w.files['a.ts'] = 'two'
    await task('1', 'completed')
    expect(w.p.claims[0]?.outside.length).toBe(1)
  })

test('Z: a root is spelled as the disk has it, however setup was given it', async () => {
  for (const given of ['c:/REPO', 'C:\\Repo', 'c:/repo']) {
    const { w, $, ops } = world('C:/repo')
    await proof.proofCommand($, ops, `setup ${given}`, true)
    expect([given, w.p.draft?.root]).toEqual([given, 'C:/repo'])
  }
})

test('os-review: history of a named folder reads the store alone, as a link can send it', async () => {
  for (const typed of [true, false]) {
    const { $, ops } = world('C:/repo')
    const asked: string[] = []
    const fs = $.fs as unknown as { list: (path: string) => Promise<unknown>; stat: (path: string) => Promise<unknown> }
    for (const call of ['list', 'stat'] as const) fs[call] = async path => (asked.push(`${call} ${path}`), Promise.reject(new Error('not to be asked')))
    await proof.proofCommand($, ops, 'history C:/junction/to/a/share', typed)
    expect([typed, asked]).toEqual([typed, []])
  }
})

test('R1: allowing again after a rename by case replaces the allowance, automatic and what it left', async () => {
  for (const before of ['C:/REPO', 'C:/Repo']) {
    const { w, allow } = world('C:/repo')
    await allow(true)
    const [held] = w.p.allowed
    w.p = { ...w.p, allowed: [{ ...held!, grant: { ...held!.grant, root: before } }], paused: [{ root: before, paths: ['x'] }] }
    await allow(false)
    expect([w.p.allowed.map(a => [a.grant.root, a.grant.auto]), w.p.paused]).toEqual([[['C:/repo', false]], []])
  }
})

for (const to of ['C:/elsewhere', '//host.invalid/share/elsewhere'])
  test(`R2: a root led elsewhere as an edit lands holds no edit: ${to}`, async () => {
    const { w, $, ops, allow, task } = world('C:/repo')
    await allow()
    await task('1', 'in_progress')
    w.links = { 'C:/': 'C:/', 'C:/repo': to, 'C:/repo/a.ts': `${to}/a.ts` }
    await proof.proofToolRan($, ops, 'C:/repo/a.ts', null)
    w.files['a.ts'] = 'two'
    await task('1', 'completed')
    expect(w.p.claims[0]?.outside.length).toBe(1)
  })

test('os-review: on a drive of a share, too, a root led elsewhere holds no edit', async () => {
  const { w, $, ops, allow, task } = world('C:/repo')
  await allow()
  await task('1', 'in_progress')
  w.links = { 'C:/': '//host.invalid/share', 'C:/repo': '//host.invalid/share/other', 'C:/repo/a.ts': '//host.invalid/share/other/a.ts' }
  await proof.proofToolRan($, ops, 'C:/repo/a.ts', null)
  w.files['a.ts'] = 'two'
  await task('1', 'completed')
  expect(w.p.claims[0]?.outside.length).toBe(1)
})

test('os-review: what runs under a replaced allowance is cancelled and records nothing', async () => {
  const old = world('C:/RUNS')
  await old.allow(false)
  let release = () => undefined as void
  old.w.hold = new Promise(done => (release = done))
  await proof.pressVerify(old.$, old.ops, 'C:/RUNS')
  await pause(80)
  expect(old.w.spawned.length).toBe(1)
  const now = world('C:/runs')
  now.w.session = old.w.session
  now.w.p = old.w.p
  await now.allow(false)
  release()
  await pause(200)
  expect(now.w.p.allowed.map(a => a.grant.root)).toEqual(['C:/runs'])
  expect(old.w.p.attempts.map(a => a.endedAt)).toEqual([null])
})
