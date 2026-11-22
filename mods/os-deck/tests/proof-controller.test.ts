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
      stat: async (path: string) => ({ kind: 'file', size: 1, mtimeMs: 0, isLink: false, realPath: w.links[path] ?? path }),
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
