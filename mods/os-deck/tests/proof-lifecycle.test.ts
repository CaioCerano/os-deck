import { expect, test } from 'claude-code/testing'

import { completeTask, describeTask, dropTask, noteEdit, reviewWorthy, rootsToRun, startTask, withdrawClaims } from '../hooks/proof/lifecycle'
import type { Manifest, Tracking } from '../hooks/proof/model'
import { isReviewed, rootVerdict, taskVerdict } from '../hooks/proof/verdict'
import type { RootNow, RootVerdict, Verdict } from '../hooks/proof/verdict'
import type { ProofAttempt, ProofCheck, ProofClaim, ProofGrant, ProofReview } from '../types'

const APP = 'C:/work/app'
const LIB = 'C:/work/lib'
/** Inside APP, and a repository of its own. */
const INNER = 'C:/work/app/inner'

const NO_BASELINE = 'its start was not seen, so what it changed is not known'
const NO_CHANGE = 'no change seen in an allowed repository'
const OVERLAP = 'attribution unknown: another task or agent worked at the same time'
const REVERTED = 'changed since this claim'
const OUTSIDE = 'edited outside the allowed repositories: '

const CHECK: ProofCheck = { id: 'test', kind: 'test', description: 'tests', argv: ['t'], dir: '', timeoutS: 60, required: true, count: { parser: 'bun', minPassed: 3, maxSkipped: 0 } }

// Every value handed over is frozen, so a member that changed one in place would throw.
const frozen = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const inner of Object.values(value)) frozen(inner)
  }
  return value
}

const EMPTY: Tracking = frozen({ open: [], descriptions: [] })

type How = 'pass' | 'fail' | 'interrupted' | 'changes files'

/** The hooks module in small: it owns the state, reads the manifests, and serializes the events. */
const world = (allowed: readonly string[] = [APP], firstSession = 'S1') => {
  const w = {
    session: firstSession,
    now: 1_000,
    t: EMPTY,
    claims: frozen<ProofClaim[]>([]),
    attempts: [] as ProofAttempt[],
    grants: [] as ProofGrant[],
    files: new Map([APP, LIB, INNER].map(root => [root, new Map([['a.ts', 'a0'], ['b.ts', 'b0']])])),
    unreadable: new Set<string>(),
    paused: [] as string[],
    busy: [] as string[],
    tick: (): number => ++w.now,
    roots: (): string[] => w.grants.filter(g => g.session === w.session).map(g => g.root),
    allow: (root: string, over: Partial<ProofGrant> = {}): void => {
      w.grants = w.grants.filter(g => g.root !== root)
      w.grants.push({ session: w.session, root, checks: [CHECK], digest: 'D', auto: true, at: w.tick(), ...over })
    },
    revoke: (root: string): void => void (w.grants = w.grants.filter(g => g.root !== root)),
    read: (root: string): Manifest | null => {
      if (w.unreadable.has(root)) return null
      const files = [...(w.files.get(root) as Map<string, string>)].sort((a, b) => (a[0] < b[0] ? -1 : 1))
      return { root, revision: JSON.stringify(files), files }
    },
    readAll: (): { found: Manifest[]; unread: string[] } => {
      const found: Manifest[] = []
      const unread: string[] = []
      for (const root of w.roots()) {
        const m = w.read(root)
        if (m) found.push(m)
        else unread.push(root)
      }
      return { found, unread }
    },
    describe: (taskId: string, text: string): void => void (w.t = frozen(describeTask(w.t, taskId, text))),
    start: (taskId: string, at: number = w.tick()): void => {
      const { found, unread } = w.readAll()
      w.claims = frozen(withdrawClaims(w.claims, w.session, taskId))
      w.t = frozen(startTask(w.t, frozen({ taskId, at, start: found, unread })))
    },
    complete: (taskId: string, at: number = w.tick()): ProofClaim => {
      const { found, unread } = w.readAll()
      const done = completeTask(w.t, frozen({ session: w.session, taskId, subject: `task ${taskId}`, agentId: null, helpers: [], at, end: found, unread, roots: w.roots(), claims: w.claims }))
      w.t = frozen(done.tracking)
      w.claims = frozen([...withdrawClaims(w.claims, w.session, taskId), done.claim])
      return done.claim
    },
    drop: (taskId: string): void => void (w.t = frozen(dropTask(w.t, taskId))),
    reopen: (taskId: string): void => void (w.claims = frozen(withdrawClaims(w.claims, w.session, taskId))),
    note: (path: string): void => void (w.t = frozen(noteEdit(w.t, path, ''))),
    /** A write nothing observed, as a shell's is. */
    write: (root: string, path: string, hash: string | null): void => {
      const files = w.files.get(root) as Map<string, string>
      if (hash === null) files.delete(path)
      else files.set(path, hash)
    },
    edit: (root: string, path: string, hash: string | null): void => {
      w.write(root, path, hash)
      w.note(`${root}/${path}`)
    },
    run: (root: string, how: How = 'pass', trigger: 'auto' | 'manual' = 'manual'): void => {
      const before = w.read(root)?.revision
      const grant = w.grants.find(g => g.root === root && g.session === w.session)
      if (before === undefined || !grant) return
      const startedAt = w.tick()
      if (how === 'changes files') w.write(root, 'generated.ts', `g${startedAt}`)
      const isOver = how !== 'interrupted'
      w.attempts.push({
        id: `run${startedAt}`, session: w.session, root, digest: grant.digest, trigger, before, after: isOver ? (w.read(root)?.revision ?? null) : null, head: null, startedAt, endedAt: isOver ? w.tick() : null,
        checks: [{
          id: CHECK.id, kind: CHECK.kind, description: '', execution: isOver ? 'exited' : 'interrupted', source: 'os-deck-run', startedAt, endedAt: startedAt, revision: before,
          exitCode: how === 'fail' ? 1 : 0, count: { passed: 3, failed: 0, skipped: 0 }, summary: '', reason: null,
        }],
      })
    },
    owed: (): string[] => rootsToRun({ session: w.session, grants: w.grants, claims: w.claims, attempts: w.attempts, paused: w.paused, busy: w.busy }),
    /** A turn that ended with an answer. */
    turn: (how: How = 'pass'): string[] => {
      const owed = w.owed()
      for (const root of owed) w.run(root, how, 'auto')
      return owed
    },
    /** /clear: a new session id, so no grant and no task under way. */
    clear: (session: string): void => {
      w.session = session
      w.grants = []
      w.t = EMPTY
    },
    rootState: (root: string): RootVerdict =>
      rootVerdict({ root, session: w.session, grant: w.grants.find(g => g.root === root) ?? null, current: w.read(root)?.revision ?? null, attempts: w.attempts, liveId: null }),
    claim: (taskId: string): ProofClaim => w.claims.filter(c => c.taskId === taskId).at(-1) as ProofClaim,
    verdictOf: (claim: ProofClaim): Verdict => {
      const now = new Map<string, RootNow>()
      for (const root of w.roots()) {
        const m = w.read(root)
        now.set(root, { verdict: w.rootState(root), hashes: m && new Map(m.files) })
      }
      return taskVerdict(w.claims.find(c => c.id === claim.id) ?? claim, now, w.session)
    },
    verdict: (taskId: string): Verdict => w.verdictOf(w.claim(taskId)),
  }
  for (const root of allowed) w.allow(root)
  return w
}
type World = ReturnType<typeof world>

/** A task that changed one file, ended, and was checked green. */
const verifiedTask = (w: World, taskId = 'A', root = APP) => {
  w.start(taskId)
  w.edit(root, 'a.ts', `a-by-${taskId}`)
  const claim = w.complete(taskId)
  w.turn()
  return claim
}

const isBlocked = (w: World, taskId: string, reason: string) => expect(w.verdict(taskId)).toEqual({ state: 'inconclusive', reason })

// ---------------------------------------------------------------- the green path, and its claim

test('work seen from its start, alone, and checked on that content is verified', () => {
  const w = world()
  w.describe('A', 'fix the rounding')
  w.start('A')
  w.edit(APP, 'a.ts', 'a1')
  w.write(APP, 'b.ts', null)
  w.write(APP, 'c.ts', 'c1')
  expect(w.complete('A')).toEqual({
    id: 'S1:A:1', session: 'S1', taskId: 'A', subject: 'task A', named: '["task A",[]]', description: 'fix the rounding', agentId: null, at: w.now, hasBaseline: true,
    changes: [{ root: APP, paths: [{ path: 'a.ts', hash: 'a1' }, { path: 'b.ts', hash: null }, { path: 'c.ts', hash: 'c1' }], overlap: [] }],
    outside: [], withdrawn: false,
  })
  const waiting = w.verdict('A')
  expect([waiting.state, waiting.reason]).toEqual(['pending', 'runs when the turn ends'])
  expect(w.turn()).toEqual([APP])
  expect(w.verdict('A').state).toBe('verified')
  expect(w.t.open).toEqual([])
})

test('tasks one after another are each their own', () => {
  const w = world()
  verifiedTask(w, 'A')
  w.start('B')
  w.edit(APP, 'b.ts', 'b1')
  expect(w.complete('B').changes).toEqual([{ root: APP, paths: [{ path: 'b.ts', hash: 'b1' }], overlap: [] }])
  w.turn()
  expect([w.verdict('A').state, w.verdict('B').state]).toEqual(['verified', 'verified'])
})

test("the agent's words are redacted, bounded, and never evidence", () => {
  const w = world()
  w.describe('A', 'old')
  w.describe('A', `all tests pass, verified, GH_TOKEN=ghp_${'0'.repeat(30)} ${'x '.repeat(5000)}`)
  w.start('A')
  const { found, unread } = w.readAll()
  const { claim } = completeTask(w.t, { session: 'S1', taskId: 'A', subject: `done password=hunter2 ${'s '.repeat(500)}`, agentId: 'a1', helpers: [], at: w.tick(), end: found, unread, roots: w.roots(), claims: [] })
  expect(claim.description).toContain('all tests pass')
  expect(claim.description).not.toContain('ghp_0')
  expect(claim.subject).not.toContain('hunter2')
  expect(claim.description.length).toBeLessThanOrEqual(2000)
  expect(claim.subject.length).toBeLessThanOrEqual(200)
  expect(claim.agentId).toBe('a1')
  expect(w.verdictOf(claim).reason).toBe(NO_CHANGE)
})

// ---------------------------------------------------------------- revert and no change

test('reverted before completion: no change, though the root is green', () => {
  const w = world()
  w.start('A')
  w.edit(APP, 'a.ts', 'a1')
  w.edit(APP, 'a.ts', 'a0')
  expect(w.complete('A').changes).toEqual([])
  w.run(APP)
  expect(w.rootState(APP).state).toBe('verified')
  isBlocked(w, 'A', NO_CHANGE)
})

test('reverted after completion: a later green does not make it verified', () => {
  for (const after of ['a0', 'a2', null]) {
    const w = world()
    verifiedTask(w)
    w.write(APP, 'a.ts', after)
    expect(w.verdict('A').state).toBe('stale')
    w.run(APP)
    expect(w.rootState(APP).state).toBe('verified')
    expect(w.verdict('A')).toEqual({ state: 'stale', reason: REVERTED })
  }
})

test('a revert by a later task leaves only that task green', () => {
  const w = world()
  verifiedTask(w, 'A')
  w.start('B')
  w.edit(APP, 'a.ts', 'a0')
  w.complete('B')
  w.turn()
  expect(w.verdict('A')).toEqual({ state: 'stale', reason: REVERTED })
  expect(w.verdict('B').state).toBe('verified')
})

test('a deletion holds while the file stays gone', () => {
  const w = world()
  w.start('A')
  w.edit(APP, 'a.ts', null)
  w.complete('A')
  w.turn()
  expect(w.verdict('A').state).toBe('verified')
  w.write(APP, 'a.ts', 'a0')
  w.run(APP)
  expect(w.verdict('A')).toEqual({ state: 'stale', reason: REVERTED })
})

test('a task that changed nothing, or had no root, is not verified', () => {
  const w = world()
  w.run(APP)
  w.start('A')
  w.complete('A')
  isBlocked(w, 'A', NO_CHANGE)
  expect(w.owed()).toEqual([])

  const none = world([])
  none.start('A')
  none.complete('A')
  isBlocked(none, 'A', NO_CHANGE)
})

// ---------------------------------------------------------------- overlap

/** Plays `A+ B+ B- A-` (start, complete, x for deleted, ~ for reopened), each completion after a change of its own. */
const play = (script: string, w = world()) => {
  let n = 0
  for (const step of script.split(' ')) {
    const id = step.slice(0, -1)
    const op = step.slice(-1)
    if (op === '+') w.start(id)
    else if (op === 'x') w.drop(id)
    else if (op === '~') w.reopen(id)
    else {
      w.edit(APP, `${id}.ts`, `${id}${++n}`)
      w.complete(id)
    }
  }
  w.turn()
  return w
}

test('overlap in every order marks both, whichever ended first', () => {
  for (const script of ['A+ B+ A- B-', 'A+ B+ B- A-', 'B+ A+ A- B-', 'B+ A+ B- A-']) {
    const w = play(script)
    expect(w.claim('A').changes.map(c => c.overlap)).toEqual([['B']])
    expect(w.claim('B').changes.map(c => c.overlap)).toEqual([['A']])
    isBlocked(w, 'A', OVERLAP)
    isBlocked(w, 'B', OVERLAP)
  }
})

test('overlap survives the other ending, being deleted or reopened', () => {
  const scripts = [
    'A+ B+ Bx A-', 'B+ A+ Bx A-', 'A+ B+ B- Bx A-', 'A+ B+ B- B~ A-', 'A+ B+ B- B~ B+ Bx A-',
    'B+ B- B~ B+ A+ Bx A-', 'A+ B- A-', 'A+ B+ A+ B- A-', 'A+ B+ Bx A+ A-', 'A+ Ax B+ A+ Bx A-',
  ]
  for (const script of scripts) {
    const w = play(script)
    expect(w.claim('A').changes.map(c => c.overlap)).toEqual([['B']])
    isBlocked(w, 'A', OVERLAP)
  }
})

test('a completion with no seen start marks the open ones, its claim kept or not', () => {
  const w = world()
  w.start('A')
  w.complete('B')
  w.claims = []
  w.edit(APP, 'a.ts', 'a1')
  expect(w.complete('A').changes[0]?.overlap).toEqual(['B'])
  w.turn()
  isBlocked(w, 'A', OVERLAP)
})

test('overlap chains through three tasks without joining those apart', () => {
  const w = play('A+ B+ A- C+ B- C-')
  expect(['A', 'B', 'C'].map(id => w.claim(id).changes[0]?.overlap)).toEqual([['B'], ['A', 'C'], ['B']])
})

test('batch starts and batch completions overlap', () => {
  const w = world()
  const started = w.tick()
  for (const id of ['A', 'B', 'C']) w.start(id, started)
  w.edit(APP, 'a.ts', 'a1')
  const ended = w.tick()
  for (const id of ['C', 'A', 'B']) w.complete(id, ended)
  w.turn()
  for (const id of ['A', 'B', 'C']) {
    expect(w.claim(id).changes[0]?.overlap).toHaveLength(2)
    isBlocked(w, id, OVERLAP)
  }
})

test('a completion and the next start at one instant do not overlap', () => {
  const w = world()
  w.start('A')
  w.edit(APP, 'a.ts', 'a1')
  const at = w.tick()
  w.complete('A', at)
  w.start('B', at)
  w.edit(APP, 'b.ts', 'b1')
  w.complete('B')
  w.turn()
  expect([w.verdict('A').state, w.verdict('B').state]).toEqual(['verified', 'verified'])
})

test('a completion inside the interval counts though it was recorded first', () => {
  for (const session of ['S1', 'other']) {
    const w = world()
    const at = w.tick()
    const meanwhile: ProofClaim = { id: `${session}:B:1`, session, taskId: 'B', subject: '', description: '', agentId: null, at: at + 1, hasBaseline: true, changes: [], outside: [], withdrawn: session === 'S1' }
    w.claims = [meanwhile]
    w.now += 5
    w.start('A', at)
    w.edit(APP, 'a.ts', 'a1')
    w.complete('A')
    w.turn()
    expect(w.claim('A').changes[0]?.overlap).toEqual([session === 'S1' ? 'B' : 'other:B:1'])
    isBlocked(w, 'A', OVERLAP)
  }
})

test('overlap is for the interval, so it reaches every root changed', () => {
  const w = world([APP, LIB])
  w.start('A')
  w.start('B')
  w.edit(APP, 'a.ts', 'a1')
  w.edit(LIB, 'a.ts', 'l1')
  w.complete('B')
  w.complete('A')
  for (const id of ['A', 'B']) expect(w.claim(id).changes.map(c => c.overlap.length)).toEqual([1, 1])
})

test('every order of two tasks: verified only alone and seen from its start', () => {
  const ops = ['A+', 'A-', 'Ax', 'B+', 'B-', 'Bx']
  const wrong: string[] = []
  let verified = 0
  for (let code = 0; code < ops.length ** 5; code++) {
    const steps: string[] = []
    for (let rest = code, i = 0; i < 5; i++, rest = Math.floor(rest / ops.length)) steps.push(ops[rest % ops.length] as string)
    const w = world()
    // Worked out from the order alone.
    const open = new Map<string, boolean>()
    const expected = new Map<string, boolean>()
    let n = 0
    for (const step of steps) {
      const id = step[0] as string
      const other = id === 'A' ? 'B' : 'A'
      if (step[1] === '+') {
        if (!open.has(id)) open.set(id, !open.has(other))
        if (open.has(other)) open.set(other, false)
        expected.delete(id)
        w.start(id)
      } else if (step[1] === 'x') {
        open.delete(id)
        w.drop(id)
      } else {
        expected.set(id, open.get(id) === true)
        open.delete(id)
        if (open.has(other)) open.set(other, false)
        w.edit(APP, `${id}.ts`, `${id}${++n}`)
        w.complete(id)
      }
    }
    w.turn()
    for (const [id, alone] of expected) {
      const got = w.verdict(id).state === 'verified'
      if (got) verified++
      if (got !== alone && wrong.length < 5) wrong.push(`${steps.join(' ')}: ${id}`)
    }
  }
  expect(wrong).toEqual([])
  expect(verified).toBeGreaterThan(100)
})

// ---------------------------------------------------------------- reopen and repeated completion

test('reopening withdraws, and the next completion starts from nothing', () => {
  const w = world()
  const first = verifiedTask(w)
  const review: ProofReview = { claim: first.id, revisions: [{ root: APP, revision: w.read(APP)?.revision as string }], at: w.now }
  const current = () => new Map([[APP, w.read(APP)?.revision ?? null]])
  expect(isReviewed(w.claim('A'), review, current())).toBe(true)

  w.reopen('A')
  expect(w.verdictOf(first)).toEqual({ state: 'pending', reason: 'reopened' })
  expect(isReviewed(w.claim('A'), review, current())).toBe(false)

  w.start('A')
  const second = w.complete('A')
  expect(second.id).toBe('S1:A:2')
  expect(second.changes).toEqual([])
  expect(w.rootState(APP).state).toBe('verified')
  isBlocked(w, 'A', NO_CHANGE)
  expect(isReviewed(second, review, current())).toBe(false)
})

test('the work of a reopened task is measured from its new start', () => {
  const w = world()
  verifiedTask(w)
  w.start('A')
  w.edit(APP, 'b.ts', 'b1')
  expect(w.complete('A').changes).toEqual([{ root: APP, paths: [{ path: 'b.ts', hash: 'b1' }], overlap: [] }])
  expect(w.verdict('A').state).toBe('stale')
  expect(w.turn()).toEqual([APP])
  expect(w.verdict('A').state).toBe('verified')
})

test('completed again without a start never verifies', () => {
  const w = world()
  verifiedTask(w)
  const again = w.complete('A')
  expect([again.id, again.hasBaseline, again.changes]).toEqual(['S1:A:2', false, []])
  isBlocked(w, 'A', NO_BASELINE)
  expect(w.turn()).toEqual([])
  expect(w.claims.filter(c => !c.withdrawn).map(c => c.id)).toEqual(['S1:A:2'])
})

test('a start recorded after its completion lends no baseline to the next', () => {
  const w = world()
  const at = w.tick()
  const { found, unread } = w.readAll()
  w.edit(APP, 'a.ts', 'a1')
  w.complete('A')
  w.t = startTask(w.t, { taskId: 'A', at, start: found, unread })
  w.complete('A')
  w.run(APP)
  isBlocked(w, 'A', NO_BASELINE)
})

test('a number is not reused once older claims are pruned', () => {
  const w = world()
  for (let i = 0; i < 4; i++) verifiedTask(w)
  w.claims = w.claims.slice(-1)
  expect(w.complete('A').id).toBe('S1:A:5')
})

test('started again while open keeps the first baseline and all seen since', () => {
  const w = world()
  w.start('A')
  const first = w.t.open[0]
  w.edit(APP, 'a.ts', 'a1')
  w.start('A')
  expect(w.t.open).toEqual([{ ...first, editors: [''] }])
  expect(w.complete('A').changes[0]?.paths).toEqual([{ path: 'a.ts', hash: 'a1' }])

  const seen = world()
  seen.start('A')
  seen.note('C:/elsewhere/x.ts')
  seen.start('A')
  seen.edit(APP, 'a.ts', 'a1')
  seen.complete('A')
  seen.turn()
  isBlocked(seen, 'A', `${OUTSIDE}C:/elsewhere/x.ts`)
})

test('withdrawing touches that task of that session alone', () => {
  const w = world()
  verifiedTask(w, 'A')
  verifiedTask(w, 'B')
  const claims = [...w.claims, { ...w.claim('A'), id: 'S0:A:1', session: 'S0' }]
  const out = withdrawClaims(frozen(claims), 'S1', 'A')
  expect(out.map(c => c.withdrawn)).toEqual([true, false, false])
  expect(out[1]).toBe(claims[1])
})

// ---------------------------------------------------------------- baselines

test('no seen start never verifies', () => {
  const w = world()
  w.edit(APP, 'a.ts', 'a1')
  w.complete('A')
  w.run(APP)
  expect(w.rootState(APP).state).toBe('verified')
  isBlocked(w, 'A', NO_BASELINE)
})

test('a root without a baseline, or unreadable at either end, never verifies', () => {
  const cases: [string, (w: World) => void, (w: World) => void][] = [
    ['allowed meanwhile', () => {}, w => w.allow(LIB)],
    ['unreadable at the start', w => (w.allow(LIB), void w.unreadable.add(LIB)), w => void w.unreadable.delete(LIB)],
    ['unreadable at the end', w => w.allow(LIB), w => void w.unreadable.add(LIB)],
    ['unreadable at both', w => (w.allow(LIB), void w.unreadable.add(LIB)), () => {}],
    ['no longer allowed', w => w.allow(LIB), w => w.revoke(LIB)],
  ]
  for (const [name, before, after] of cases) {
    const w = world()
    before(w)
    w.start('A')
    w.edit(APP, 'a.ts', 'a1')
    after(w)
    w.complete('A')
    w.unreadable.clear()
    expect(w.turn()).toEqual([APP])
    expect([name, w.claim('A').hasBaseline]).toEqual([name, false])
    isBlocked(w, 'A', NO_BASELINE)
  }
})

test('a root missing from one reading, or both read and unread, never verifies', () => {
  const start: Manifest = { root: APP, revision: 'r0', files: [['a.ts', 'a0']] }
  const end: Manifest = { root: APP, revision: 'r1', files: [['a.ts', 'a1']] }
  const cases: [Manifest[], string[], Manifest[], string[], string[]][] = [
    [[], [], [end], [], [APP]],
    [[start], [], [], [], [APP]],
    [[start], [APP], [end], [], [APP]],
    [[start], [], [end], [APP], [APP]],
    // Read at both ends, and not allowed at the second.
    [[start], [], [end], [], []],
    // Allowed, and in neither reading.
    [[start], [], [end], [], [APP, LIB]],
  ]
  for (const [from, unreadThen, to, unreadNow, roots] of cases) {
    const t = startTask(EMPTY, { taskId: 'A', at: 1, start: from, unread: unreadThen })
    expect(completeTask(t, { session: 'S', taskId: 'A', subject: '', agentId: null, helpers: [], at: 2, end: to, unread: unreadNow, roots, claims: [] }).claim.hasBaseline).toBe(false)
  }
})

// ---------------------------------------------------------------- several roots

test('several roots: each change is listed, and the worst wins in either order', () => {
  for (const order of [[APP, LIB], [LIB, APP]]) {
    for (const bad of order) {
      const w = world(order)
      w.start('A')
      w.edit(APP, 'a.ts', 'a1')
      w.edit(LIB, 'b.ts', 'l1')
      expect(w.complete('A').changes.map(c => c.root)).toEqual(order)
      expect(w.owed()).toEqual(order)
      const good = order.find(r => r !== bad) as string
      w.run(good)
      expect(w.verdict('A').state).toBe('pending')
      w.run(bad, 'fail')
      expect(w.verdict('A').state).toBe('failed')
      w.run(bad)
      expect(w.verdict('A').state).toBe('verified')
      w.revoke(bad)
      expect(w.verdict('A').state).toBe('pending')
    }
  }
})

test('an allowed root left alone is neither listed nor run', () => {
  const w = world([APP, LIB])
  w.start('A')
  w.edit(LIB, 'a.ts', 'l1')
  expect(w.complete('A').changes.map(c => c.root)).toEqual([LIB])
  expect(w.turn()).toEqual([LIB])
  expect(w.verdict('A').state).toBe('verified')
})

// ---------------------------------------------------------------- outside

const afterEdit = (roots: string[], path: string) => {
  const start = roots.map(root => ({ root, revision: 'r0', files: [['a.ts', 'a0']] as [string, string][] }))
  const t = noteEdit(startTask(EMPTY, { taskId: 'A', at: 1, start, unread: [] }), path, '')
  return completeTask(t, { session: 'S', taskId: 'A', subject: '', agentId: null, helpers: [], at: 2, end: start, unread: [], roots, claims: [] }).claim.outside
}

test('paths inside an allowed root, however Windows spells them', () => {
  const inside: [string[], string][] = [
    [[APP], 'C:/work/app/a.ts'], [[APP], 'C:\\work\\app\\src\\a.ts'], [[APP], 'c:/WORK/App/a.ts'], [[APP], 'C:/work//app/./a.ts'],
    [[APP], 'C:/work/app/src/../a.ts'], [[APP], 'C:/work/lib/../app/a.ts'], [[APP], 'C:/work/app'], [[APP], 'C:/work/app/..config/x'],
    [['c:\\Work\\App\\'], 'C:/work/app/a.ts'], [['C:/'], 'C:/any/a.ts'],
    [[APP, INNER], 'C:/work/app/inner/a.ts'], [[INNER, APP], 'C:/work/app/a.ts'], [[APP], 'C:/work/app/inner/a.ts'],
    [['/srv/app'], '/srv/app/a.ts'], [['/'], '/srv/a.ts'],
  ]
  for (const [roots, path] of inside) expect([path, afterEdit(roots, path)]).toEqual([path, []])
})

test('paths outside every allowed root, or not certain to be inside', () => {
  const outside: [string[], string][] = [
    [[APP], 'C:/work/app2/a.ts'], [[APP], 'C:/work/app-old/a.ts'], [[APP], 'C:/work/ap'], [[APP], 'C:/work'], [[APP], 'D:/work/app/a.ts'],
    [[APP], 'C:/work/app/../x.ts'], [[APP], 'C:\\work\\app\\src\\..\\..\\x.ts'], [[APP], 'C:/work/app/../app2/a.ts'], [[APP], 'C:/../../x.ts'],
    [[INNER], 'C:/work/app/a.ts'], [[INNER], 'C:/work/app/inner2/a.ts'], [[APP], 'src/a.ts'], [[APP], '../a.ts'], [[APP], 'C:a.ts'], [[APP], ''],
    [[APP], '//server/share/work/app/a.ts'], [[APP], '\\\\server\\work\\app\\a.ts'], [[APP], '/c/work/app/a.ts'],
    [[APP], 'C:/work/app/.. /x.ts'], [[APP], 'C:/work/app/a.ts:stream'], [[APP], 'C:/work/app./a.ts'],
    [['C:/kit'], `C:/${String.fromCharCode(0x212a)}it/a.ts`],
    [['/srv/app'], '/srv/App/a.ts'], [['/srv/app'], '/srv/app/../x'], [['/srv/app'], '/srv/app\\a.ts'], [['/srv/app'], '/srv/app2/a.ts'],
  ]
  for (const [roots, path] of outside) expect([path, afterEdit(roots, path).length]).toEqual([path, 1])
})

test('an edit outside blocks verified, whichever open task made it', () => {
  const w = world()
  w.start('A')
  w.edit(APP, 'a.ts', 'a1')
  w.note('C:/work/app2/b.ts')
  w.note('C:/work/app2/b.ts')
  expect(w.complete('A').outside).toEqual(['C:/work/app2/b.ts'])
  w.turn()
  isBlocked(w, 'A', `${OUTSIDE}C:/work/app2/b.ts`)

  const two = world()
  two.start('A')
  two.start('B')
  two.note('C:/elsewhere/x')
  expect([two.complete('A').outside, two.complete('B').outside]).toEqual([['C:/elsewhere/x'], ['C:/elsewhere/x']])
})

test('an edit with no task open, or before the start, is no task of theirs', () => {
  const w = world()
  w.note('C:/elsewhere/x')
  expect(w.t).toEqual(EMPTY)
  verifiedTask(w)
  expect(w.verdict('A').state).toBe('verified')
})

test('an edit inside a nested root counts for that root', () => {
  const w = world([APP, INNER])
  w.start('A')
  w.edit(INNER, 'a.ts', 'i1')
  expect(w.complete('A').changes.map(c => c.root)).toEqual([INNER])
  w.turn()
  expect(w.verdict('A').state).toBe('verified')
})

// ---------------------------------------------------------------- /clear

test('/clear: nothing of the earlier session verifies or is run', () => {
  const w = world()
  const old = verifiedTask(w)
  w.start('B')
  w.edit(APP, 'b.ts', 'b1')
  w.clear('S2')
  expect(w.owed()).toEqual([])
  expect(w.verdictOf(old).state).toBe('pending')

  w.allow(APP)
  expect(w.owed()).toEqual([])
  expect(w.verdictOf(old).state).not.toBe('verified')

  const b = w.complete('B')
  expect(b.id).toBe('S2:B:1')
  w.run(APP)
  isBlocked(w, 'B', NO_BASELINE)
})

test("another session's claim never verifies, though its content is green here", () => {
  const w = world()
  const old = verifiedTask(w)
  w.clear('S2')
  w.allow(APP)
  w.run(APP)
  expect(w.rootState(APP).state).toBe('verified')
  expect(w.verdictOf(old)).toEqual({ state: 'pending', reason: 'claimed in another session' })
})

test('/clear: the same task id is another task', () => {
  const w = world()
  const old = verifiedTask(w)
  w.clear('S2')
  w.allow(APP)
  w.start('A')
  w.edit(APP, 'b.ts', 'b1')
  expect(w.complete('A').id).toBe('S2:A:1')
  expect(w.claims.find(c => c.id === old.id)?.withdrawn).toBe(false)
  expect(w.verdict('A').state).toBe('pending')
  expect(w.turn()).toEqual([APP])
  expect(w.verdict('A').state).toBe('verified')
})

// ---------------------------------------------------------------- what is owed a run

/** A root with one claim waiting. */
const owing = () => {
  const w = world()
  w.start('A')
  w.edit(APP, 'a.ts', 'a1')
  w.complete('A')
  expect(w.owed()).toEqual([APP])
  return w
}

test('an attempted claim is not owed again, however the run ended', () => {
  for (const how of ['pass', 'fail', 'interrupted', 'changes files'] as const) {
    const w = owing()
    expect(w.turn(how)).toEqual([APP])
    for (let i = 0; i < 3; i++) expect(w.turn(how)).toEqual([])
    w.write(APP, 'b.ts', `later ${how}`)
    expect(w.owed()).toEqual([])
  }
})

test('a manual run pays, and a claim made by its start is paid', () => {
  const w = owing()
  w.run(APP)
  expect(w.owed()).toEqual([])
  const same = owing()
  same.run(APP)
  const started = same.attempts[0]?.startedAt as number
  same.claims = [{ ...same.claim('A'), at: started }]
  expect(same.owed()).toEqual([])
  same.claims = [{ ...same.claim('A'), at: started + 1 }]
  expect(same.owed()).toEqual([APP])
})

test('only an automatic, unpaused, free grant of this session runs', () => {
  const cases: [string, (w: World) => void][] = [
    ['manual', w => w.allow(APP, { auto: false })],
    ['paused', w => void w.paused.push('c:\\work\\app')],
    ['busy', w => void w.busy.push(APP)],
    ['revoked', w => w.revoke(APP)],
    ['of another session', w => w.allow(APP, { session: 'other' })],
    ['reopened', w => w.reopen('A')],
    ['no session', w => void (w.session = '')],
  ]
  for (const [name, change] of cases) {
    const w = owing()
    change(w)
    expect([name, w.owed()]).toEqual([name, []])
  }
  expect(rootsToRun({ session: '', grants: [{ session: '', root: APP, checks: [CHECK], digest: 'D', auto: true, at: 1 }], claims: [{ ...owing().claim('A'), session: '' }], attempts: [], paused: [], busy: [] })).toEqual([])
})

test('only an attempt of this session, root and digest pays', () => {
  for (const over of [{ session: 'other' }, { root: LIB }, { digest: 'E' }]) {
    const w = owing()
    w.run(APP)
    w.attempts = w.attempts.map(a => ({ ...a, ...over }))
    expect(w.owed()).toEqual([APP])
  }
  const w = owing()
  w.turn()
  w.allow(APP, { digest: 'E' })
  expect(w.turn()).toEqual([APP])
  expect(w.owed()).toEqual([])
})

test('the attempt recorded last decides, whatever the clock called newest', () => {
  const w = owing()
  const claim = w.claim('A')
  w.run(APP)
  const first = w.attempts[0] as ProofAttempt
  const earlier = { ...first, id: 'the earlier clock', startedAt: claim.at - 1 }
  w.grants = w.grants.map(g => ({ ...g, at: 1 }))
  w.attempts = [first, earlier]
  expect(w.rootState(APP).attempt?.id).toBe(earlier.id)
  expect(w.owed()).toEqual([APP])
  w.attempts = [earlier, first]
  expect(w.owed()).toEqual([])
})

test('an attempt from before this allowance pays nothing, one at its instant does', () => {
  const w = owing()
  w.run(APP)
  expect(w.owed()).toEqual([])
  w.allow(APP)
  expect(w.rootState(APP).attempt).toBeNull()
  expect(w.owed()).toEqual([APP])
  const startedAt = w.attempts[0]?.startedAt as number
  w.grants = w.grants.map(g => ({ ...g, at: startedAt }))
  expect(w.owed()).toEqual([])
})

test('allowed again as it was, a claim already run by itself is not run again', () => {
  const w = owing()
  w.turn()
  w.allow(APP)
  expect(w.owed()).toEqual([])
  expect(w.verdict('A').state).toBe('pending')
  w.start('B')
  w.edit(APP, 'b.ts', 'b1')
  w.complete('B')
  expect(w.turn()).toEqual([APP])
  expect(w.verdict('B').state).toBe('verified')
})

test('a clock set back, or standing still, never loops', () => {
  for (const back of [2, 10, 100_000]) {
    for (const count of [1, 2, 7]) {
      const w = world()
      for (let i = 0; i < count; i++) {
        w.start(`T${i}`)
        w.edit(APP, `${i}.ts`, `h${i}`)
        w.complete(`T${i}`)
      }
      w.now -= back
      let runs = 0
      for (let turn = 0; turn < 50; turn++) runs += w.turn().length
      expect(runs).toBeGreaterThan(0)
      expect(runs).toBeLessThanOrEqual(count)
      expect(w.owed()).toEqual([])
    }
  }
  const still = owing()
  const at = still.now
  still.tick = () => at
  expect(still.turn()).toEqual([APP])
  for (let turn = 0; turn < 5; turn++) expect(still.turn()).toEqual([])
})

test('work after a clock step is still run, once', () => {
  const w = owing()
  w.now = 10
  expect(w.turn()).toEqual([APP])
  expect(w.turn()).toEqual([])
  w.now = 5_000
  w.start('B')
  w.edit(APP, 'b.ts', 'b1')
  w.complete('B')
  expect(w.turn()).toEqual([APP])
  expect(w.turn()).toEqual([])
})

test('a reopened claim still counts for the run it used up', () => {
  const w = owing()
  w.turn()
  w.start('A')
  w.edit(APP, 'a.ts', 'a2')
  w.complete('A')
  expect(w.turn()).toEqual([APP])
  expect(w.owed()).toEqual([])
})

test('one run for many claims, and none for a claim of another session', () => {
  const w = play('A+ A- B+ B-')
  expect(w.attempts).toHaveLength(1)
  expect(w.owed()).toEqual([])
  const other = owing()
  other.claims = other.claims.map(c => ({ ...c, session: 'other' }))
  expect(other.owed()).toEqual([])
})

test('work that cannot verify is still run', () => {
  const w = play('A+ B+ A- B-')
  expect(w.attempts).toHaveLength(1)
  expect(w.rootState(APP).state).toBe('verified')
})

// ---------------------------------------------------------------- watched and for review

test('a rename of case alone is a change, and holds', () => {
  const w = world()
  w.start('A')
  w.write(APP, 'a.ts', null)
  w.write(APP, 'A.ts', 'a0')
  expect(w.complete('A').changes[0]?.paths).toEqual([{ path: 'A.ts', hash: 'a0' }, { path: 'a.ts', hash: null }])
  w.turn()
  expect(w.verdict('A').state).toBe('verified')
})

test('tests, scripts and test configuration are for a person to look at', () => {
  const flagged = [
    'package.json', 'apps/web/package.json', 'tsconfig.json', 'tsconfig.test.json', 'vitest.config.ts', 'jest.config.base.js', 'playwright.config.ts', 'vite.config.mts', '.mocharc.yml', 'eslint.config.js', '.eslintrc.cjs', 'setupTests.ts',
    'src/__tests__/cart.ts', 'src/cart.test.ts', 'src/cart.spec.tsx', 'test/helpers.js', 'e2e/login.ts', 'src/__snapshots__/cart.ts.snap', 'scripts/build.mjs', 'packages/a/scripts/check.js',
    'bunfig.toml', 'src/cart_test.ts', '.npmrc', '.github/workflows/ci.yml', '.husky/pre-commit', 'Makefile', 'justfile', 'tools/check.py', 'run.ps1', 'deploy/run.sh',
    'project.godot', '.gutconfig.json', 'test/unit/player.gd', 'src/test_player.gd', 'src/player_test.gd', 'src/PlayerTest.gd', 'src/TestPlayer.cs', 'addons/gut/gut_cmdln.gd', 'scripts/ci.py', 'scripts/run_tests.gd',
    'tests/conftest.py', 'app/conftest.py', 'app/test_cart.py', 'app/cart_test.py', 'app/tests.py', 'pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini', 'noxfile.py', '.coveragerc', 'integration_tests/x.py', 'App.Tests/Cart.cs',
  ]
  const plain = [
    'src/cart.ts', 'src/latest.ts', 'src/contest.ts', 'src/Latest.ts', 'src/attestation.py', 'src/Testimonial.tsx', 'src/protest/index.ts', 'README.md', 'next.config.js', 'src/tools/weather.ts',
    'scripts/player.gd', 'game/scripts/enemy.cs', 'scenes/main.tscn', 'src/inspect.py', 'assets/data.json', 'src/respect.go',
  ]
  expect(reviewWorthy(flagged)).toEqual(flagged)
  expect(reviewWorthy(plain)).toEqual([])
  expect(reviewWorthy(['src/a.ts', 'a.test.ts', 'b.ts'])).toEqual(['a.test.ts'])
})

// ---------------------------------------------------------------- bounds

test('past the most open tasks, what is started overlaps for the rest of the session', () => {
  const w = world()
  for (let i = 0; i < 300; i++) w.start(`T${i}`)
  expect(w.t.open).toHaveLength(65)
  for (const task of w.t.open) expect(task.overlap.length).toBeLessThanOrEqual(16)
  w.edit(APP, 'a.ts', 'a1')
  w.complete('T299')
  w.run(APP)
  isBlocked(w, 'T299', NO_BASELINE)

  for (let i = 0; i < 300; i++) w.drop(`T${i}`)
  w.drop('*')
  // T100 may still be at work, and nothing says when it ends.
  w.start('late')
  w.edit(APP, 'b.ts', 'b1')
  expect(w.complete('late').changes[0]?.overlap).toEqual(['*'])
  w.turn()
  isBlocked(w, 'late', OVERLAP)
})

test('the stand-in for untracked tasks cannot be claimed as a task', () => {
  for (const id of ['*', 'x'.repeat(5000)]) {
    const w = world()
    w.start(id)
    w.edit(APP, 'a.ts', 'a1')
    expect(w.complete(id).hasBaseline).toBe(false)
    expect(w.t.open.map(o => o.taskId)).toEqual(['*'])
    w.start('next')
    w.edit(APP, 'b.ts', 'b1')
    w.complete('next')
    w.turn()
    isBlocked(w, 'next', OVERLAP)
  }
})

test('past the kept edits, or a kept path, the claim says outside', () => {
  const w = world()
  w.start('A')
  for (let i = 0; i < 600; i++) w.note(`${APP}/src/f${i}.ts`)
  expect(w.t.open[0]?.edits).toEqual([])
  for (let i = 0; i < 600; i++) w.note(`C:/elsewhere/f${i}.ts`)
  expect(w.t.open[0]?.edits).toHaveLength(257)

  const long = world()
  long.start('A')
  long.edit(APP, 'a.ts', 'a1')
  long.note(`C:/elsewhere/${'x'.repeat(5000)}`)
  expect((long.t.open[0]?.edits[0] as string).length).toBeLessThan(100)
  long.complete('A')
  long.turn()
  isBlocked(long, 'A', `${OUTSIDE}edits that could not all be kept`)
})

test('past the kept baseline files, the task has none', () => {
  const files = Array.from({ length: 20_000 }, (_, i): [string, string] => [`f${i}`, 'h'])
  let t = EMPTY
  for (let i = 0; i < 8; i++) t = startTask(t, { taskId: `T${i}`, at: i, start: [{ root: APP, revision: 'r0', files }], unread: [] })
  expect(t.open.map(o => o.start.length)).toEqual([1, 1, 1, 1, 1, 0, 0, 0])
  expect(t.open[6]?.unread).toEqual([APP])
  expect(t.open[6]?.overlap).toHaveLength(7)
  const end = [{ root: APP, revision: 'r1', files: [...files, ['new', 'h'] as [string, string]] }]
  expect(completeTask(t, { session: 'S', taskId: 'T6', subject: '', agentId: null, helpers: [], at: 9, end, unread: [], roots: [APP], claims: [] }).claim.hasBaseline).toBe(false)
})

test('past the kept changed paths, the claim cannot verify but is still run', () => {
  const w = world()
  w.start('A')
  for (let i = 0; i < 5001; i++) w.write(APP, `gen/f${i}`, 'h')
  const claim = w.complete('A')
  expect([claim.hasBaseline, claim.changes[0]?.paths.length]).toEqual([false, 5000])
  expect(w.turn()).toEqual([APP])
  isBlocked(w, 'A', NO_BASELINE)
})

test('descriptions are bounded, the newest kept', () => {
  let t = EMPTY
  for (let i = 0; i < 500; i++) t = describeTask(t, `T${i}`, `d${i}`)
  t = describeTask(t, 'x'.repeat(5000), 'never kept')
  expect(t.descriptions).toHaveLength(200)
  expect(t.descriptions.at(-1)).toEqual(['T499', 'd499'])
})

// ---------------------------------------------------------------- random sequences against an oracle

const randomFrom = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let r = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
  return ((r ^ (r >>> 14)) >>> 0) / 4294967296
}

/** An edit's path, and the roots it is inside: known by writing it, not by comparing. */
const SPELLINGS: [string, string[]][] = [
  ['C:/work/app/a.ts', [APP]], ['c:\\WORK\\App\\src\\b.ts', [APP]], ['C:/work/lib/../app/c.ts', [APP]],
  ['C:/work/lib/a.ts', [LIB]], ['C:/work/app/../lib/b.ts', [LIB]], ['C:/Work/App/Inner/a.ts', [APP, INNER]],
  ['C:/work/app2/a.ts', []], ['C:/work/app/../x.ts', []], ['D:/work/app/a.ts', []], ['notes.md', []],
]

type Span = { id: string; from: number; to: number }
type Task = { span: Span; files: Map<string, Map<string, string> | null>; edits: string[][] }
type Truth = { session: string; taskId: string; at: number; live: boolean; canVerify: boolean; changed: Map<string, Map<string, string | null>> }
type Run = { session: string; root: string; digest: string; auto: boolean; at: number; before: string; after: string | null; passed: boolean }

// The oracle keeps its own record of what happened and reads "may be verified" off the proposal's section 4.
// With a clock that steps green may be lost but never gained, and runs stay within the claims there were.
const againstOracle = (firstSeed: number, count: number, clockSteps: boolean) => {
  const wrong: string[] = []
  const seen = { verified: 0, notVerified: 0, owed: 0, several: 0 }

  for (let seed = firstSeed; seed < firstSeed + count && wrong.length === 0; seed++) {
    const random = randomFrom(seed)
    const pick = <T>(list: readonly T[]) => list[Math.floor(random() * list.length)] as T
    const w = world([APP, LIB, INNER].filter(root => root === APP || random() < 0.35))
    const open = new Map<string, Task>()
    const spans: Span[] = []
    const truths = new Map<string, Truth>()
    const runs: Run[] = []
    const log: string[] = []
    let sessions = 1
    let hash = 0
    // The order things happened in, which no clock changes.
    let seq = 0

    const filesNow = (root: string) => (w.unreadable.has(root) ? null : new Map(w.files.get(root)))
    const contentNow = (root: string) => {
      const files = filesNow(root)
      return files && JSON.stringify([...files].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
    }
    const grantOf = (root: string) => w.grants.find(g => g.root === root)
    const runsOf = (root: string) => runs.filter(r => r.session === w.session && r.root === root && r.digest === grantOf(root)?.digest)
    const claimsOn = (root: string) => [...truths.values()].filter(c => c.session === w.session && c.changed.has(root))
    const latestRun = (root: string) => runsOf(root).filter(r => r.at >= (grantOf(root)?.at as number)).at(-1)
    const withdraw = (id: string) => {
      for (const truth of truths.values()) if (truth.session === w.session && truth.taskId === id) truth.live = false
    }

    const start = (id: string) => {
      withdraw(id)
      w.start(id)
      if (open.has(id)) return
      const span = { id, from: ++seq, to: Infinity }
      spans.push(span)
      open.set(id, { span, files: new Map(w.roots().map(root => [root, filesNow(root)])), edits: [] })
    }
    const complete = (id: string) => {
      withdraw(id)
      const claim = w.complete(id)
      const task = open.get(id)
      open.delete(id)
      seq++
      if (task) task.span.to = seq
      else spans.push({ id, from: seq, to: seq })
      const allowed = w.roots()
      const changed = new Map<string, Map<string, string | null>>()
      let canVerify = task !== undefined
      if (task) {
        for (const root of new Set([...allowed, ...task.files.keys()])) {
          const from = task.files.get(root)
          const to = allowed.includes(root) ? filesNow(root) : null
          if (!from || !to) {
            canVerify = false
            continue
          }
          const paths = new Map<string, string | null>()
          for (const path of new Set([...from.keys(), ...to.keys()])) if (from.get(path) !== to.get(path)) paths.set(path, to.get(path) ?? null)
          if (paths.size > 0) changed.set(root, paths)
        }
        if (changed.size === 0) canVerify = false
        if (task.edits.some(owners => !owners.some(root => allowed.includes(root)))) canVerify = false
        if (spans.some(s => s !== task.span && s.from <= task.span.to && s.to >= task.span.from)) canVerify = false
      }
      if (truths.has(claim.id)) wrong.push(`seed ${seed}: ${claim.id} reused`)
      truths.set(claim.id, { session: w.session, taskId: id, at: w.now, live: true, canVerify, changed })
    }
    const run = (root: string, trigger: 'auto' | 'manual') => {
      const before = contentNow(root)
      const grant = grantOf(root)
      if (before === null || !grant) return
      const how = random() < 0.8 ? 'pass' : pick(['fail', 'interrupted', 'changes files'] as const)
      const at = w.now + 1
      w.run(root, how, trigger)
      runs.push({ session: w.session, root, digest: grant.digest, auto: trigger === 'auto', at, before, after: how === 'interrupted' ? null : contentNow(root), passed: how === 'pass' || how === 'changes files' })
    }
    const write = (root: string) => {
      const path = pick(['a.ts', 'b.ts', 'c.ts'])
      // Often an earlier content, so reverts happen.
      w.write(root, path, random() < 0.15 ? null : random() < 0.3 ? pick(['a0', 'b0']) : `h${++hash}`)
    }
    const oweRuns = () => {
      const expected = w.grants
        .filter(g => g.auto && !w.paused.includes(g.root))
        .filter(g =>
          claimsOn(g.root)
            .slice(runsOf(g.root).filter(r => r.auto).length)
            .some(c => c.live && c.at > (latestRun(g.root)?.at ?? -Infinity)),
        )
        .map(g => g.root)
      const got = w.owed()
      if ([...got].sort().join() !== expected.sort().join()) wrong.push(`seed ${seed}: owed ${got} for ${expected}: ${log.join(' ')}`)
      seen.owed += got.length
      for (const root of got) if (runsOf(root).filter(r => r.auto).length >= claimsOn(root).length) wrong.push(`seed ${seed}: ${root} run more often than claimed: ${log.join(' ')}`)
      return got
    }
    const judge = () => {
      for (const claim of w.claims) {
        const truth = truths.get(claim.id)
        if (!truth) continue
        const may =
          truth.session === w.session && truth.live && truth.canVerify &&
          [...truth.changed].every(([root, paths]) => {
            if (!grantOf(root)) return false
            const latest = latestRun(root)
            const content = contentNow(root)
            const files = filesNow(root)
            if (!latest || !files || !latest.passed || latest.before !== content || latest.after !== content) return false
            return [...paths].every(([path, then]) => (files.get(path) ?? null) === then)
          })
        const got = w.verdictOf(claim).state === 'verified'
        if ((clockSteps ? got && !may : got !== may) && wrong.length < 5) wrong.push(`seed ${seed}: ${claim.id} verified=${got}, may=${may}: ${log.join(' ')}`)
        if (got) seen.verified++
        else seen.notVerified++
        if (got && truth.changed.size > 1) seen.several++
      }
    }

    for (let step = 0; step < 45 && wrong.length === 0; step++) {
      const r = random()
      const root = random() < 0.6 ? APP : pick([LIB, INNER])
      const id = open.size > 0 && random() < 0.75 ? pick([...open.keys()]) : pick(['1', '2', '3', '4'])
      if (r < 0.14) {
        // Mostly one at a time, as agents work.
        if (open.size > 0 && random() < 0.8) continue
        log.push(`start:${id}`)
        start(id)
      } else if (r < 0.29) {
        log.push(`complete:${id}`)
        complete(id)
      } else if (r < 0.55) {
        log.push(`write:${root}`)
        write(root)
      } else if (r < 0.6) {
        const [path, owners] = random() < 0.8 ? (SPELLINGS[0] as [string, string[]]) : pick(SPELLINGS)
        log.push(`edit:${path}`)
        w.note(path)
        for (const task of open.values()) task.edits.push(owners)
      } else if (r < 0.79) {
        log.push('turn')
        for (const owed of oweRuns()) run(owed, 'auto')
        // Never a loop: what was just attempted is not owed at the next turn's end.
        for (const again of oweRuns()) if (!clockSteps && !w.unreadable.has(again)) wrong.push(`seed ${seed}: ${again} owed twice: ${log.join(' ')}`)
      } else if (r < 0.85) {
        log.push(`verify:${root}`)
        run(root, 'manual')
      } else if (r < 0.88) {
        log.push(`drop:${id}`)
        w.drop(id)
        const task = open.get(id)
        if (task) task.span.to = ++seq
        open.delete(id)
      } else if (r < 0.9) {
        log.push(`reopen:${id}`)
        w.reopen(id)
        withdraw(id)
      } else if (r < 0.925) {
        log.push(`readable:${root}`)
        if (w.unreadable.has(root)) w.unreadable.delete(root)
        else w.unreadable.add(root)
      } else if (r < 0.95) {
        log.push(`allow:${root}`)
        w.allow(root, { auto: random() < 0.85, digest: random() < 0.8 ? 'D' : 'E' })
      } else if (r < 0.965) {
        log.push(`revoke:${root}`)
        w.revoke(root)
      } else if (r < 0.98) {
        log.push(`pause:${root}`)
        w.paused = w.paused.includes(root) ? [] : [root]
      } else if (random() < 0.3) {
        log.push('clear')
        w.clear(`S${++sessions}`)
        w.allow(APP)
        open.clear()
        spans.length = 0
      }
      if (clockSteps && random() < 0.08) {
        w.now += pick([-100_000, -50, -5, -1, 50])
        log.push(`clock:${w.now}`)
      }
      w.tick()
      judge()
      for (const a of w.t.open) for (const b of w.t.open) if (a !== b && !a.overlap.includes(b.taskId)) wrong.push(`seed ${seed}: overlap not symmetric: ${log.join(' ')}`)
    }
  }

  expect(wrong).toEqual([])
  // A run that reached no green would agree with any oracle.
  expect(seen.verified).toBeGreaterThan(100)
  expect(seen.notVerified).toBeGreaterThan(100)
  expect(seen.owed).toBeGreaterThan(100)
  expect(seen.several).toBeGreaterThan(0)
}

// In parts, each well inside the time a test may take.
for (const part of [0, 1, 2, 3]) test(`random sequences, part ${part + 1}: verified and runs exactly where the oracle allows`, () => againstOracle(part * 500 + 1, 500, false))
for (const part of [0, 1]) test(`random sequences with a stepping clock, part ${part + 1}: no false green, no loop`, () => againstOracle(part * 500 + 1, 500, true))
