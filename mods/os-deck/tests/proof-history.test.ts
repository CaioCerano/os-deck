import type { EngineInterface } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { dirKey } from '../hooks/core'
import { pruneHistory } from '../hooks/history'
import { digestOf, mayRun } from '../hooks/proof/grant'
import { loadRecords, saveAttempt, saveChecks, saveClaim, saveReview } from '../hooks/proof/history'
import type { History } from '../hooks/proof/model'
import { rootVerdict, taskVerdict } from '../hooks/proof/verdict'
import type { RootNow, Verdict } from '../hooks/proof/verdict'
import type { ProofAttempt, ProofCheck, ProofClaim, ProofGrant, ProofResult, ProofReview } from '../types'

// The contract, held by the type checker.
const history: History = { saveAttempt, saveClaim, saveReview, saveChecks, loadRecords }

const ROOT = '/repo'
const NOW = 1_800_000_000_000
const REV = 'a'.repeat(64)
const HASH = 'b'.repeat(40)
// Fake, and put together here so no scanner takes it for a key.
const SECRET = ['ghp', 'A'.repeat(30)].join('_')
const ESC = String.fromCharCode(27)
const NONE = { claims: [], attempts: [], reviews: [], checks: [] }

type Opts = { capacity?: number; fail?: ('get' | 'set' | 'keys' | 'delete')[]; beforeSet?: (key: string) => void; beforeKeys?: () => void; slowSet?: boolean; noClock?: boolean }

/** A store as the engine's: JSON in, JSON out, refused when over its size. */
const world = (opts: Opts = {}) => {
  const data = new Map<string, unknown>()
  const seen = { gets: 0, sets: 0, keys: 0, deletes: [] as string[] }
  let delay = 60
  const failing = (op: 'get' | 'set' | 'keys' | 'delete') => {
    if (opts.fail?.includes(op)) throw new Error(`${op} failed`)
  }
  const $ = {
    clock: {
      now: async () => {
        if (opts.noClock) throw new Error('the session is going')
        return NOW
      },
    },
    store: {
      get: async (key: string) => {
        seen.gets += 1
        failing('get')
        return data.get(key)
      },
      set: async (key: string, value: unknown) => {
        seen.sets += 1
        failing('set')
        if (key.length > 256) throw new Error('key too long')
        // The first write the slowest: out of order unless queued.
        if (opts.slowSet) {
          const turns = delay
          delay = Math.max(0, delay - 25)
          for (let i = 0; i < turns; i++) await null
        }
        opts.beforeSet?.(key)
        if (opts.capacity !== undefined) {
          let size = JSON.stringify(value).length + key.length
          for (const [k, v] of data) if (k !== key) size += k.length + JSON.stringify(v).length
          if (size > opts.capacity) throw new Error('the store is full')
        }
        data.set(key, JSON.parse(JSON.stringify(value)))
      },
      delete: async (key: string) => {
        failing('delete')
        seen.deletes.push(key)
        data.delete(key)
      },
      keys: async () => {
        seen.keys += 1
        failing('keys')
        opts.beforeKeys?.()
        return [...data.keys()]
      },
    },
  } as unknown as EngineInterface
  const keys = (kind = '') => [...data.keys()].filter(k => k.startsWith(`os-deck:proof:${kind}`))
  const size = () => [...data].reduce((n, [k, v]) => n + new TextEncoder().encode(k + JSON.stringify(v)).length, 0)
  return { $, data, seen, keys, size }
}

const def = (over: Partial<ProofCheck> = {}): ProofCheck => ({ id: 'test', kind: 'test', description: 'tests', argv: ['bun', 'test'], dir: '', timeoutS: 60, required: true, count: { parser: 'bun', minPassed: 3, maxSkipped: 0 }, ...over })
const result = (over: Partial<ProofResult> = {}): ProofResult => ({
  id: 'test', kind: 'test', description: 'tests', execution: 'exited', source: 'os-deck-run', startedAt: NOW - 100, endedAt: NOW - 50,
  revision: REV, exitCode: 0, count: { passed: 3, failed: 0, skipped: 0 }, summary: '3 pass', reason: null, ...over,
})
const attempt = (over: Partial<ProofAttempt> = {}): ProofAttempt => ({
  id: 'run-1', session: 'S', root: ROOT, digest: 'd'.repeat(64), trigger: 'auto', before: REV, after: REV, head: null,
  startedAt: NOW - 1000, endedAt: NOW - 10, checks: [result()], ...over,
})
const claim = (over: Partial<ProofClaim> = {}): ProofClaim => ({
  id: 'S:1:1', session: 'S', taskId: '1', subject: 'Fix rounding', description: 'with tests', agentId: null, at: NOW - 1000,
  hasBaseline: true, changes: [{ root: ROOT, paths: [{ path: 'src/a.ts', hash: HASH }], overlap: [] }], outside: [], withdrawn: false, ...over,
})
const review = (over: Partial<ProofReview> = {}): ProofReview => ({ claim: 'S:1:1', revisions: [{ root: ROOT, revision: REV }], at: NOW - 500, ...over })
const run = (i: number, over: Partial<ProofAttempt> = {}) => attempt({ id: `run-${i}`, startedAt: NOW - 100_000 + i, ...over })

/** One record saved, then what the store held replaced by `change`. */
const forged = async (save: (($: EngineInterface) => Promise<boolean>), change: (value: any) => unknown) => {
  const w = world()
  expect(await save(w.$)).toBe(true)
  const key = w.keys()[0] as string
  w.data.set(key, change(JSON.parse(JSON.stringify(w.data.get(key)))))
  return history.loadRecords(w.$, ROOT)
}

// ---------------------------------------------------------------- there and back

test('saved, then loaded', async () => {
  const w = world()
  expect(await history.saveAttempt(w.$, attempt())).toBe(true)
  expect(await history.saveClaim(w.$, ROOT, claim())).toBe(true)
  expect(await history.saveReview(w.$, ROOT, review())).toBe(true)
  expect(await history.saveChecks(w.$, ROOT, [def()])).toBe(true)
  expect(await history.loadRecords(w.$, ROOT)).toEqual({
    attempts: [attempt({ session: 'stored:S' })],
    claims: [claim({ session: 'stored:S', hasBaseline: false })],
    reviews: [review()],
    checks: [def()],
  })
})

test('records come oldest first', async () => {
  const w = world()
  for (const i of [3, 1, 2]) await saveAttempt(w.$, run(i))
  expect((await loadRecords(w.$, ROOT)).attempts.map(a => a.id)).toEqual(['run-1', 'run-2', 'run-3'])
})

test('an attempt’s end and a claim’s withdrawal replace their first save', async () => {
  const w = world()
  await saveAttempt(w.$, attempt({ after: null, endedAt: null }))
  await saveAttempt(w.$, attempt())
  await saveClaim(w.$, ROOT, claim())
  await saveClaim(w.$, ROOT, claim({ withdrawn: true }))
  const out = await loadRecords(w.$, ROOT)
  expect([out.attempts.length, out.attempts[0]?.endedAt, out.claims.length, out.claims[0]?.withdrawn]).toEqual([1, NOW - 10, 1, true])
})

test('the end is not overtaken by the start', async () => {
  const w = world({ slowSet: true })
  await Promise.all([saveAttempt(w.$, attempt({ after: null, endedAt: null })), saveAttempt(w.$, attempt())])
  expect((await loadRecords(w.$, ROOT)).attempts[0]?.endedAt).toBe(NOW - 10)
})

test('a run whose end was not saved reads interrupted', async () => {
  const w = world()
  await saveAttempt(w.$, attempt({ after: null, endedAt: null, checks: [result({ execution: 'running', endedAt: null, exitCode: null, count: null }), result({ id: 'lint', kind: 'lint', execution: 'queued' })] }))
  expect((await loadRecords(w.$, ROOT)).attempts[0]?.checks.map(c => c.execution)).toEqual(['interrupted', 'interrupted'])
})

test('the newest review of each claim', async () => {
  const w = world()
  await saveReview(w.$, ROOT, review({ at: NOW - 900 }))
  await saveReview(w.$, ROOT, review({ at: NOW - 100 }))
  expect((await loadRecords(w.$, ROOT)).reviews).toEqual([review({ at: NOW - 100 })])
})

test('a root by either slash and, on Windows, either case', async () => {
  const w = world()
  await saveAttempt(w.$, attempt({ root: 'C:\\Work\\Shop' }))
  const out = await loadRecords(w.$, 'c:/work/shop/')
  expect(out.attempts.map(a => a.root)).toEqual(['c:/work/shop/'])
  expect(await loadRecords(w.$, '/Repo')).toEqual(NONE)
})

test('roots do not see each other', async () => {
  const w = world()
  await saveAttempt(w.$, attempt({ root: '/one' }))
  await saveChecks(w.$, '/one', [def()])
  expect(await loadRecords(w.$, '/two')).toEqual(NONE)
})

// ---------------------------------------------------------------- nothing loaded can grant or verify

test('a forged passing attempt of this session verifies nothing', async () => {
  const checks = [def()]
  const digest = await digestOf(ROOT, checks)
  const grant: ProofGrant = { session: 'S', root: ROOT, checks, digest, auto: true, at: 1 }
  const facts = (attempts: ProofAttempt[]) => rootVerdict({ root: ROOT, session: 'S', grant, current: REV, attempts, liveId: 'run-1' }).state
  // Live, the very same record is a green.
  expect(facts([attempt({ digest })])).toBe('verified')
  for (const session of ['S', 'stored:S']) {
    const w = world()
    await saveAttempt(w.$, attempt({ digest, session }))
    const loaded = (await loadRecords(w.$, ROOT)).attempts
    expect(loaded.length).toBe(1)
    expect(facts(loaded)).toBe('pending')
  }
})

test('a forged claim borrows no green', async () => {
  const green = new Map([[ROOT, { verdict: { state: 'verified', reason: '' } as const, hashes: new Map([['src/a.ts', HASH]]) }]])
  // Given the live session, for a verdict that takes one.
  const verdictOf: (c: ProofClaim, roots: ReadonlyMap<string, RootNow>, session: string) => Verdict = taskVerdict
  expect(verdictOf(claim(), green, 'S').state).toBe('verified')
  const loaded = await forged($ => saveClaim($, ROOT, claim()), v => ({ ...v, record: { ...v.record, hasBaseline: true } }))
  const back = loaded.claims[0] as ProofClaim
  expect([back.session, back.hasBaseline]).toEqual(['stored:S', false])
  for (const session of ['S', 'stored:S']) expect(['inconclusive', 'pending']).toContain(verdictOf(back, green, session).state)
})

test('a stored definition is a suggestion, and no allowance', async () => {
  const out = await forged($ => saveChecks($, ROOT, [def()]), v => ({ ...v, auto: true, session: 'S', record: v.record.map((c: object) => ({ ...c, auto: true, session: 'S', digest: 'x' })) }))
  expect(out.checks).toEqual([def()])
  expect(Object.keys(out).sort()).toEqual(['attempts', 'checks', 'claims', 'reviews'])
  expect(await mayRun(out.checks as unknown as ProofGrant, 'S', ROOT)).toBe(false)
})

test('fields a record does not have are not carried', async () => {
  const out = await forged($ => saveAttempt($, attempt()), v => ({ ...v, record: { ...v.record, result: 'pass', verified: true, checks: [{ ...v.record.checks[0], result: 'pass' }] } }))
  expect(out.attempts).toEqual([attempt({ session: 'stored:S' })])
})

// ---------------------------------------------------------------- a hostile store

const JUNK: readonly unknown[] = [{}, { toString: 1, valueOf: 1 }, [1], -1, true, '']

test('each field of an attempt is checked', async () => {
  for (const field of ['id', 'session', 'digest', 'trigger', 'before', 'after', 'head', 'startedAt', 'endedAt', 'checks']) {
    for (const junk of JUNK) {
      const out = await forged($ => saveAttempt($, attempt()), v => ({ ...v, record: { ...v.record, [field]: junk } }))
      expect([field, junk, out.attempts.length]).toEqual([field, junk, 0])
    }
  }
})

test('each field of a result is checked', async () => {
  for (const field of ['id', 'kind', 'execution', 'source', 'startedAt', 'endedAt', 'revision', 'count']) {
    for (const junk of JUNK) {
      const out = await forged($ => saveAttempt($, attempt()), v => ({ ...v, record: { ...v.record, checks: [{ ...v.record.checks[0], [field]: junk }] } }))
      expect([field, junk, out.attempts.length]).toEqual([field, junk, 0])
    }
  }
  for (const [field, junk] of [['description', 3], ['summary', null], ['reason', 3], ['exitCode', '0'], ['exitCode', 0.5], ['count', { passed: 1.5, failed: 0, skipped: 0 }]] as const) {
    const out = await forged($ => saveAttempt($, attempt()), v => ({ ...v, record: { ...v.record, checks: [{ ...v.record.checks[0], [field]: junk }] } }))
    expect([field, out.attempts.length]).toEqual([field, 0])
  }
})

test('more results than checks can be is dropped, not cut', async () => {
  const out = await forged($ => saveAttempt($, attempt()), v => ({ ...v, record: { ...v.record, checks: Array.from({ length: 9 }, () => v.record.checks[0]) } }))
  expect(out.attempts).toEqual([])
})

test('each field of a claim is checked', async () => {
  for (const field of ['id', 'session', 'taskId', 'agentId', 'hasBaseline', 'withdrawn']) {
    for (const junk of field === 'hasBaseline' || field === 'withdrawn' ? [1, 'yes', null] : JUNK) {
      const out = await forged($ => saveClaim($, ROOT, claim()), v => ({ ...v, record: { ...v.record, [field]: junk } }))
      expect([field, junk, out.claims.length]).toEqual([field, junk, 0])
    }
  }
  const bad: [string, unknown][] = [['subject', 4], ['description', null], ['at', '5'], ['outside', 'x'], ['outside', [4]], ['changes', {}], ['changes', [null]], ['changes', [{ root: ROOT, paths: [{ path: 'a' }], overlap: [] }]]]
  for (const [field, junk] of bad) {
    const out = await forged($ => saveClaim($, ROOT, claim()), v => ({ ...v, record: { ...v.record, [field]: junk } }))
    expect([field, junk, out.claims.length]).toEqual([field, junk, 0])
  }
})

test('each field of a review is checked', async () => {
  const bad: [string, unknown][] = [['claim', 4], ['claim', ''], ['at', null], ['revisions', []], ['revisions', [{ root: ROOT }]], ['revisions', Array.from({ length: 17 }, () => ({ root: ROOT, revision: REV }))]]
  for (const [field, junk] of bad) {
    const out = await forged($ => saveReview($, ROOT, review()), v => ({ ...v, record: { ...v.record, [field]: junk } }))
    expect([field, out.reviews.length]).toEqual([field, 0])
  }
})

test('a definition with one bad check is dropped whole', async () => {
  const lint = def({ id: 'lint', kind: 'lint', argv: ['bun', 'lint.ts'], count: undefined })
  const bad: Record<string, unknown>[] = [
    { argv: ['//host/x'] }, { argv: 'bun lint' }, { argv: [{ toString: 1 }] }, { id: { toString: 1 } }, { description: { toString: 1 } },
    { dir: '../up' }, { dir: 7 }, { timeoutS: '60' }, { required: 'yes' }, { count: null }, { count: { parser: 'bun', minPassed: '1', maxSkipped: 0 } },
  ]
  for (const change of bad) {
    const out = await forged($ => saveChecks($, ROOT, [def(), lint]), v => ({ ...v, record: [v.record[0], { ...v.record[1], ...change }] }))
    expect([change, out.checks]).toEqual([change, []])
  }
})

test('values that are no record', async () => {
  for (const value of [null, 'junk', 7, [], {}, { root: ROOT }, { root: ROOT, record: null }, { root: ROOT, record: [] }, { root: { toString: 1 }, record: {} }]) {
    expect(await forged($ => saveAttempt($, attempt()), () => value)).toEqual(NONE)
  }
})

test('a record of another root under this root’s key', async () => {
  expect(await forged($ => saveAttempt($, attempt()), v => ({ ...v, root: '/other' }))).toEqual(NONE)
})

test('one record under many keys is one record', async () => {
  const w = world()
  await saveAttempt(w.$, attempt())
  const key = w.keys()[0] as string
  for (let i = 1; i <= 5; i++) w.data.set(key.replace(`:${NOW - 1000}:`, `:${NOW - 1000 + i}:`), w.data.get(key))
  expect((await loadRecords(w.$, ROOT)).attempts.length).toBe(1)
})

test('an oversized value is dropped', async () => {
  expect((await forged($ => saveAttempt($, attempt()), v => ({ ...v, padding: 'x'.repeat(10_000) }))).attempts).toEqual([])
})

test('a hostile key is neither loaded nor allowed to stay', async () => {
  const w = world()
  const here = dirKey(ROOT)
  const keys = ['os-deck:proof:', 'os-deck:proof:z:junk', `os-deck:proof:a:${here}:NaN:1-1`, `os-deck:proof:a:${here}:1:${'x'.repeat(300)}`, `os-deck:proof:a:${here}:${NOW * 5}:1-1`]
  for (const key of keys) w.data.set(key, { root: ROOT, record: attempt() })
  expect(await loadRecords(w.$, ROOT)).toEqual(NONE)
  expect(w.seen.gets).toBe(0)
  await saveAttempt(w.$, attempt())
  for (const key of keys) expect(w.data.has(key)).toBe(false)
})

test('records dated ahead cannot push the true ones out', async () => {
  const w = world()
  for (let i = 0; i < 60; i++) w.data.set(`os-deck:proof:a:${dirKey(ROOT)}:${NOW * 2 + i}:1-1`, {})
  await saveAttempt(w.$, attempt())
  expect(w.keys('a:').length).toBe(1)
  expect((await loadRecords(w.$, ROOT)).attempts.length).toBe(1)
})

test('reading is bounded however much the store holds', async () => {
  const w = world()
  for (let i = 0; i < 3000; i++) w.data.set(`os-deck:proof:a:${dirKey(ROOT)}:${NOW - i}:x-y`, 'junk')
  expect(await loadRecords(w.$, ROOT)).toEqual(NONE)
  expect(w.seen.gets).toBe(50)
})

// ---------------------------------------------------------------- what is kept

test('secrets and control characters are not stored', async () => {
  const w = world()
  await saveClaim(w.$, ROOT, claim({ subject: `use ${SECRET}`, description: `${ESC}[31mred${ESC}[0m ${SECRET}`, outside: [`/tmp/${SECRET}`], changes: [{ root: ROOT, paths: [{ path: `k/${SECRET}`, hash: null }], overlap: [] }] }))
  await saveAttempt(w.$, attempt({ checks: [result({ summary: `token ${SECRET}`, reason: `${ESC}]0;title${SECRET}`, description: SECRET })] }))
  const all = JSON.stringify([...w.data])
  expect(all.includes(SECRET)).toBe(false)
  expect(all.includes(ESC) || all.includes('u001b')).toBe(false)
})

test('a secret the cut would split is still masked', async () => {
  const w = world()
  // Cut first, seven characters of it would be left: too few for the rule.
  await saveClaim(w.$, ROOT, claim({ subject: `${'x'.repeat(152)} ${SECRET}` }))
  expect(JSON.stringify([...w.data]).includes('ghp_A')).toBe(false)
})

test('an id that is a secret is refused, not stored', async () => {
  const w = world()
  expect(await saveClaim(w.$, ROOT, claim({ agentId: SECRET }))).toBe(false)
  expect(await saveAttempt(w.$, attempt({ head: SECRET }))).toBe(false)
  expect(w.seen.sets).toBe(0)
})

test('text read back is made safe again', async () => {
  const out = await forged($ => saveClaim($, ROOT, claim()), v => ({ ...v, record: { ...v.record, subject: `${ESC}[31m${SECRET}` } }))
  expect(out.claims[0]?.subject.includes(SECRET)).toBe(false)
  expect(out.claims[0]?.subject.includes(ESC)).toBe(false)
})

test('a huge claim is kept small, and never turns some into none', async () => {
  const w = world()
  const changes = Array.from({ length: 30 }, (_, r) => ({ root: `/root-${r}/${'d'.repeat(500)}`, overlap: ['2', '3'], paths: Array.from({ length: 2000 }, (_, i) => ({ path: `${'p'.repeat(300)}${i}`, hash: HASH })) }))
  expect(await saveClaim(w.$, ROOT, claim({ changes, outside: Array(100).fill('/elsewhere/file'), subject: 's'.repeat(90_000), description: 'word '.repeat(20_000) }))).toBe(true)
  expect(w.size()).toBeLessThan(5400)
  const kept = (await loadRecords(w.$, ROOT)).claims[0] as ProofClaim
  expect(kept.changes.length).toBeGreaterThan(0)
  expect(kept.changes[0]?.paths.length).toBeGreaterThan(0)
  expect(kept.changes[0]?.overlap.length).toBeGreaterThan(0)
  expect(kept.outside.length).toBeGreaterThan(0)
})

test('a huge attempt is kept small, every result in it', async () => {
  const w = world()
  const wide = String.fromCodePoint(0x4e00).repeat(5000)
  const checks = Array.from({ length: 8 }, (_, i) => result({ id: `c${i}`, summary: wide, reason: wide, description: wide }))
  expect(await saveAttempt(w.$, attempt({ checks }))).toBe(true)
  expect(w.size()).toBeLessThan(6400)
  expect((await loadRecords(w.$, ROOT)).attempts[0]?.checks.length).toBe(8)
})

test('fifty of each a root', async () => {
  const w = world()
  for (let i = 0; i < 53; i++) {
    await saveAttempt(w.$, run(i))
    await saveClaim(w.$, ROOT, claim({ id: `S:${i}:1`, at: NOW - 100_000 + i }))
    await saveReview(w.$, ROOT, review({ claim: `S:${i}:1`, at: NOW - 100_000 + i }))
  }
  expect([w.keys('a:').length, w.keys('c:').length, w.keys('r:').length]).toEqual([50, 50, 50])
  const out = await loadRecords(w.$, ROOT)
  expect([out.attempts[0]?.id, out.attempts[49]?.id, out.claims[0]?.id, out.reviews[0]?.claim]).toEqual(['run-3', 'run-52', 'S:3:1', 'S:3:1'])
})

test('a bound across roots, one definition a root', async () => {
  const w = world()
  for (let i = 0; i < 130; i++) await saveAttempt(w.$, run(i, { root: `/root-${i % 10}` }))
  expect(w.keys('a:').length).toBe(100)
  for (let i = 0; i < 30; i++) await saveChecks(w.$, `/root-${i}`, [def()])
  expect(w.keys('d:').length).toBe(24)
  await saveChecks(w.$, '/same', [def()])
  await saveChecks(w.$, '/same', [def({ timeoutS: 99 })])
  expect((await loadRecords(w.$, '/same')).checks[0]?.timeoutS).toBe(99)
})

test('the record being saved always stays', async () => {
  const w = world()
  for (let i = 0; i < 50; i++) await saveAttempt(w.$, run(i))
  await saveAttempt(w.$, run(999, { startedAt: 5 }))
  expect([...w.data.keys()].some(k => k.includes(':5:'))).toBe(true)
  expect(w.keys('a:').length).toBe(50)
})

test('keys are short, whatever the root and ids', async () => {
  const w = world()
  const root = `/${'deep/'.repeat(300)}`
  expect(await saveAttempt(w.$, attempt({ root, id: 'i'.repeat(160), session: 's'.repeat(160) }))).toBe(true)
  for (const key of w.keys()) {
    expect(key.length).toBeLessThan(256)
    expect(key.includes('deep')).toBe(false)
  }
})

test('pruning reads no value, lists once a save and deletes a bounded number', async () => {
  const w = world()
  for (let i = 0; i < 20_000; i++) w.data.set(`os-deck:proof:a:${dirKey(`/r${i % 9}`)}:${NOW - i}:x-${i.toString(36)}`, 1)
  expect(await saveAttempt(w.$, attempt())).toBe(true)
  expect([w.seen.gets, w.seen.keys, w.seen.deletes.length]).toEqual([0, 1, 64])
})

// ---------------------------------------------------------------- sessions, failure, the rest of the dock

test('saves at once keep every record', async () => {
  const w = world({ slowSet: true })
  const saved = await Promise.all(Array.from({ length: 12 }, (_, i) => saveAttempt(w.$, run(i, { session: `S${i % 3}` }))))
  expect(saved).toEqual(Array(12).fill(true))
  expect((await loadRecords(w.$, ROOT)).attempts.length).toBe(12)
})

test('another session’s write between ours is kept', async () => {
  const other = world()
  await saveAttempt(other.$, attempt({ session: 'OTHER', startedAt: NOW - 5 }))
  const [key, value] = [...other.data][0] as [string, unknown]
  for (const hook of ['beforeSet', 'beforeKeys'] as const) {
    const w = world({ [hook]: () => void w.data.set(key, value) })
    expect(await saveAttempt(w.$, attempt())).toBe(true)
    expect((await loadRecords(w.$, ROOT)).attempts.map(a => a.session)).toEqual(['stored:S', 'stored:OTHER'])
  }
})

test('two sessions may reuse an id', async () => {
  const w = world()
  await saveAttempt(w.$, attempt({ session: 'A' }))
  await saveAttempt(w.$, attempt({ session: 'B' }))
  expect((await loadRecords(w.$, ROOT)).attempts.length).toBe(2)
})

test('two sessions at the bound leave it true', async () => {
  let added = 0
  const w = world({ beforeSet: () => void (added++ === 50 && w.data.set(`os-deck:proof:a:${dirKey(ROOT)}:${NOW - 1}:o-o`, 1)) })
  for (let i = 0; i < 51; i++) await saveAttempt(w.$, run(i))
  expect(w.keys('a:').length).toBe(50)
})

test('a full store is false, not a throw, and loses nothing', async () => {
  const w = world({ capacity: 1500 })
  w.data.set('plan-history:x#s', 'x'.repeat(1400))
  expect(await saveAttempt(w.$, attempt())).toBe(false)
  expect(await saveClaim(w.$, ROOT, claim())).toBe(false)
  expect([...w.data.keys()]).toEqual(['plan-history:x#s'])
  expect(w.seen.deletes).toEqual([])
})

test('full, records past the bounds make room', async () => {
  const full = world()
  for (let i = 0; i < 50; i++) await saveAttempt(full.$, run(i))
  const w = world({ capacity: full.size() + 20 })
  for (const [key, value] of full.data) w.data.set(key, value)
  expect(await saveAttempt(w.$, run(50))).toBe(true)
  expect(w.keys('a:').length).toBe(50)
})

test('a failing store', async () => {
  const set = world({ fail: ['set'] })
  expect([await saveAttempt(set.$, attempt()), await saveClaim(set.$, ROOT, claim()), await saveReview(set.$, ROOT, review()), await saveChecks(set.$, ROOT, [def()])]).toEqual([false, false, false, false])
  expect(await saveAttempt(world({ fail: ['keys', 'delete'] }).$, attempt())).toBe(true)
  expect(await saveAttempt(world({ noClock: true }).$, attempt())).toBe(false)
  for (const op of ['get', 'keys'] as const) {
    const w = world({ fail: [op] })
    w.data.set(`os-deck:proof:a:${dirKey(ROOT)}:1:1-1`, {})
    expect(await loadRecords(w.$, ROOT)).toEqual(NONE)
  }
})

test('what cannot be saved is false', async () => {
  const w = world()
  expect(await saveAttempt(w.$, null as unknown as ProofAttempt)).toBe(false)
  expect(await saveAttempt(w.$, attempt({ root: '//host/share' }))).toBe(false)
  expect(await saveClaim(w.$, 'relative', claim())).toBe(false)
  expect(await saveChecks(w.$, ROOT, [def({ argv: ['./x.sh'] })])).toBe(false)
  expect(await saveChecks(w.$, ROOT, [])).toBe(false)
  expect(w.seen.sets).toBe(0)
})

test('the dock’s keys and these leave each other alone', async () => {
  const w = world()
  const theirs = ['os-deck:day:2020-01-01#s', 'os-deck:history', 'os-deck:pruned', 'os-deck:history-days', `plan-history:${dirKey(ROOT)}#s`, 'os-deck:proof', 'os-deck:hidden']
  for (const key of theirs) w.data.set(key, 1)
  for (let i = 0; i < 52; i++) await saveAttempt(w.$, run(i))
  for (const key of theirs) expect(w.data.has(key)).toBe(true)

  await saveClaim(w.$, ROOT, claim({ at: 1 }))
  const ours = w.keys()
  expect(ours.length).toBe(51)
  await pruneHistory(w.$, NOW + 400 * 86_400_000)
  for (const key of ours) expect(w.data.has(key)).toBe(true)
})
