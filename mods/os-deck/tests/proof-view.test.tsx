// The sections are drawn through the engine, by a hook of the test's, so each tree passes the
// terminal's own rules. The kit paints nothing, so rows and widths are measured here, apart from the
// module's own arithmetic.
import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { NATIVE, PALETTES } from '../hooks/core'
import type { Colors } from '../hooks/core'
import type { Draft, ProofActions, ProofViewModel, RootView, TaskView } from '../hooks/proof/model'
import { isReviewed, rootVerdict, taskVerdict } from '../hooks/proof/verdict'
import type { RootNow, Verdict } from '../hooks/proof/verdict'
import { logTail, proofNotices, proofSummary, setupDraft, taskDetail, taskMark } from '../hooks/proof/view'
import type { ProofDraw, Section } from '../hooks/proof/view'
import type { ProofAttempt, ProofCheck, ProofClaim, ProofGrant, ProofResult } from '../types'

// ---------------------------------------------------------------- what is drawn

const ch = String.fromCodePoint
const ESC = ch(0x1b)
const BIDI = ch(0x202e)
const ZERO = ch(0x200b)
const TAG = ch(0xe0041)
const LONE = String.fromCharCode(0xd800)
const CYRILLIC_A = ch(0x430)
const BACKSLASH = ch(92)
const HOSTILE =
  `${ESC}[32m✓ checks verified${ESC}[0m\nVERIFIED BY OS-DECK\r\n\t✅ 🟢 ${BIDI}reversed${ZERO}${TAG}${LONE}${ch(0)}${ch(7)}${ch(0x85)}${ch(0x2028)} ` +
  `日本語の説明 🧪 ${'x'.repeat(300)} ${'word '.repeat(200)}`

const ROOT = 'C:/work/shop'
const OTHER = 'C:/forks/shop'
const REV = '8f31c2a9d0e1'
const NEXT = '1b22e7c44f90'
const AT = new Date(2026, 10, 22, 14, 2).getTime()

const TEST: ProofCheck = { id: 'test', kind: 'test', description: 'unit tests', argv: ['bun', 'test'], dir: '', timeoutS: 300, required: true, count: { parser: 'bun', minPassed: 140, maxSkipped: 2 } }
const TYPES: ProofCheck = { id: 'typecheck', kind: 'typecheck', description: 'types', argv: ['tsc', '--noEmit'], dir: '', timeoutS: 120, required: true }

const grantOf = (x: Partial<ProofGrant> = {}): ProofGrant => ({ session: 'S', root: ROOT, checks: [TEST, TYPES], digest: 'D', auto: true, at: AT, ...x })
const ran = (check: ProofCheck, x: Partial<ProofResult> = {}): ProofResult => ({
  id: check.id,
  kind: check.kind,
  description: check.description,
  execution: 'exited',
  source: 'os-deck-run',
  startedAt: AT,
  endedAt: AT + 41_000,
  revision: REV,
  exitCode: 0,
  count: check.kind === 'test' ? { passed: 146, failed: 0, skipped: 1 } : null,
  summary: '',
  reason: null,
  ...x,
})
const attemptOf = (x: Partial<ProofAttempt> = {}): ProofAttempt => ({
  id: 'A1',
  session: 'S',
  root: ROOT,
  digest: 'D',
  trigger: 'auto',
  before: REV,
  after: REV,
  head: null,
  startedAt: AT,
  endedAt: AT + 60_000,
  checks: [ran(TEST), ran(TYPES)],
  ...x,
})
const claimOf = (x: Partial<ProofClaim> = {}): ProofClaim => ({
  id: 'S:7:1',
  session: 'S',
  taskId: '7',
  subject: 'Validate expiry',
  description: 'Validate coupon expiry, with tests',
  agentId: 'worker',
  at: AT,
  hasBaseline: true,
  changes: [{ root: ROOT, paths: [{ path: 'src/coupon.ts', hash: 'h' }], overlap: [] }],
  outside: [],
  withdrawn: false,
  ...x,
})

type RootFixture = { root?: string; grant?: ProofGrant | null; current?: string | null; attempts?: ProofAttempt[]; liveId?: string; paused?: string[]; baseline?: RootView['baseline']; name?: string }
type Fixture = { roots?: RootFixture[]; claims?: ProofClaim[]; reviewed?: boolean; hash?: string; notSaved?: boolean; log?: string; more?: Partial<TaskView>; closed?: boolean }

// Handed the session as well: the rules ask it of every claim.
const verdictOf: (claim: ProofClaim, roots: ReadonlyMap<string, RootNow>, session: string) => Verdict = taskVerdict

/** Verdicts from the real rules, so no state here is one the rules cannot give. */
const modelOf = (f: Fixture = {}): ProofViewModel => {
  const roots = (f.roots ?? [{}]).map((r): RootView => {
    const root = r.root ?? ROOT
    const grant = r.grant === undefined ? grantOf({ root }) : r.grant
    const current = r.current === undefined ? REV : r.current
    const verdict = rootVerdict({ root, session: 'S', grant, current, attempts: r.attempts ?? [], liveId: r.liveId ?? null })
    return { root, name: r.name ?? 'shop', grant, verdict, revision: current, checkedAt: AT, paused: r.paused ?? [], baseline: r.baseline ?? null }
  })
  const now = new Map<string, RootNow>(roots.map(r => [r.root, { verdict: r.verdict, hashes: new Map([['src/coupon.ts', f.hash ?? 'h']]) }]))
  const tasks = (f.claims ?? [claimOf()]).map((claim): TaskView => {
    const drawn = claim.changes.flatMap(c => {
      const revision = roots.find(r => r.root === c.root)?.revision
      return revision ? [{ root: c.root, revision }] : []
    })
    const review = f.reviewed ? { claim: claim.id, revisions: drawn, at: AT } : undefined
    return {
      claim,
      verdict: verdictOf(claim, now, 'S'),
      isReviewed: isReviewed(claim, review, new Map(roots.map(r => [r.root, r.revision]))),
      drawn,
      reviewWorthy: ['tests/coupon.test.ts'],
      earlier: [{ at: AT - 3_600_000, label: 'failed' }, { at: AT - 7_200_000, label: 'checks verified' }],
      ...f.more,
    }
  })
  return { now: AT, roots, tasks, openClaim: f.closed ? null : (tasks[0]?.claim.id ?? null), draft: null, log: f.log === undefined ? null : { root: ROOT, checkId: 'test', text: f.log }, notSaved: f.notSaved ?? false }
}

const failedRun = attemptOf({ checks: [ran(TEST, { exitCode: 1, count: { passed: 146, failed: 2, skipped: 0 } }), ran(TYPES)] })
const unaccepted = grantOf({ checks: [{ ...TEST, count: { parser: 'bun', minPassed: null, maxSkipped: 0 } }, TYPES] })

const STATES: Readonly<Record<string, () => ProofViewModel>> = {
  'pending, automatic': () => modelOf(),
  'pending, manual': () => modelOf({ roots: [{ grant: grantOf({ auto: false }) }] }),
  'not allowed': () => modelOf({ roots: [{ grant: null }] }),
  verifying: () => modelOf({ roots: [{ attempts: [attemptOf({ after: null, endedAt: null, checks: [ran(TEST), ran(TYPES, { execution: 'running', exitCode: null, endedAt: null })] })], liveId: 'A1' }] }),
  verified: () => modelOf({ roots: [{ attempts: [attemptOf()] }] }),
  'verified and reviewed': () => modelOf({ roots: [{ attempts: [attemptOf()] }], reviewed: true }),
  failed: () => modelOf({ roots: [{ attempts: [failedRun] }], log: '146 pass\n2 fail\n' }),
  'no baseline accepted': () => modelOf({ roots: [{ grant: unaccepted, attempts: [attemptOf()], baseline: { attemptId: 'A1', checkId: 'test', passed: 146, skipped: 1 } }] }),
  'timed out': () => modelOf({ roots: [{ attempts: [attemptOf({ checks: [ran(TEST), ran(TYPES, { execution: 'timed-out', exitCode: null })] })] }] }),
  cancelled: () => modelOf({ roots: [{ attempts: [attemptOf({ checks: [ran(TEST, { execution: 'cancelled', exitCode: null, count: null })] })] }] }),
  interrupted: () => modelOf({ roots: [{ attempts: [attemptOf({ after: null, endedAt: null })] }] }),
  'changed during the run': () => modelOf({ roots: [{ current: NEXT, attempts: [attemptOf({ after: NEXT })] }] }),
  unreadable: () => modelOf({ roots: [{ current: null, attempts: [attemptOf()] }] }),
  stale: () => modelOf({ roots: [{ current: NEXT, attempts: [attemptOf()] }] }),
  'stale after a failure': () => modelOf({ roots: [{ current: NEXT, attempts: [failedRun] }] }),
  'root verified, claim stale': () => modelOf({ roots: [{ attempts: [attemptOf()] }], hash: 'changed' }),
  'root verified, attribution unknown': () => modelOf({ roots: [{ attempts: [attemptOf()] }], claims: [claimOf({ changes: [{ root: ROOT, paths: [{ path: 'src/coupon.ts', hash: 'h' }], overlap: ['8'] }] })] }),
  'root verified, no change seen': () => modelOf({ roots: [{ attempts: [attemptOf()] }], claims: [claimOf({ changes: [] })] }),
  'root verified, reopened': () => modelOf({ roots: [{ attempts: [attemptOf()] }], claims: [claimOf({ withdrawn: true })] }),
  'root verified, no task': () => modelOf({ roots: [{ attempts: [attemptOf()] }], claims: [] }),
  paused: () => modelOf({ roots: [{ attempts: [attemptOf()], paused: ['package.json', 'scripts/run tests.mjs'] }] }),
  'failed, nothing open': () => modelOf({ roots: [{ attempts: [failedRun] }], closed: true }),
  'verifying, nothing open': () => modelOf({ roots: [{ attempts: [attemptOf({ after: null, endedAt: null, checks: [] })], liveId: 'A1' }], closed: true }),
  'two roots of one name': () =>
    modelOf({
      roots: [{ attempts: [attemptOf()] }, { root: OTHER, attempts: [{ ...failedRun, root: OTHER }] }],
      claims: [claimOf({ changes: [ROOT, OTHER].map(root => ({ root, paths: [{ path: 'src/coupon.ts', hash: 'h' }], overlap: [] })) })],
    }),
  'a task and no root': () => modelOf({ roots: [] }),
  'not saved': () => modelOf({ notSaved: true }),
  hostile: () =>
    modelOf({
      roots: [
        {
          name: HOSTILE,
          paused: [`bad\n${BIDI}name.json`],
          baseline: { attemptId: `A${BIDI}`, checkId: 'test', passed: 5, skipped: 0 },
          attempts: [attemptOf({ checks: [ran(TEST, { execution: 'unavailable', exitCode: null, reason: HOSTILE })] })],
        },
      ],
      claims: [claimOf({ id: `S:${HOSTILE.slice(0, 120)}`, subject: HOSTILE, description: `${HOSTILE}!`, agentId: HOSTILE, outside: [HOSTILE] })],
      more: { reviewWorthy: [HOSTILE.slice(0, 90)], earlier: [{ at: AT, label: HOSTILE }] },
      log: HOSTILE.repeat(3),
    }),
}

const draftOf = (x: Partial<Draft> = {}): Draft => ({
  root: ROOT,
  checks: [TEST, TYPES],
  digest: 'D'.repeat(64),
  scripts: [{ checkId: 'test', name: 'pretest', body: 'node scripts/seed.mjs' }],
  problem: null,
  source: 'detected',
  ...x,
})

const DRAFTS: Readonly<Record<string, () => Draft>> = {
  detected: () => draftOf(),
  saved: () => draftOf({ source: 'saved' }),
  typed: () => draftOf({ source: 'typed', scripts: [] }),
  'no baseline': () => draftOf({ checks: [{ ...TEST, count: { parser: 'pass-fail-lines', minPassed: null, maxSkipped: 0 } }, { ...TEST, id: 'uncounted', count: undefined }] }),
  'largest baseline': () => draftOf({ checks: [{ ...TEST, count: { parser: 'pass-fail-lines', minPassed: Number.MAX_SAFE_INTEGER, maxSkipped: Number.MAX_SAFE_INTEGER } }] }),
  problem: () => draftOf({ problem: 'the root has a submodule' }),
  'no check': () => draftOf({ checks: [], scripts: [] }),
  long: () =>
    draftOf({
      root: `C:/Users/João Conceição/${'nested/'.repeat(30)}shop`,
      checks: [{ ...TEST, dir: `packages/${'deep/'.repeat(20)}api`, argv: ['node', `C:${BACKSLASH}Program Files${BACKSLASH}run.mjs`, 'a'.repeat(170), '--name=two  spaces ', '🧪'] }],
      scripts: [{ checkId: 'test', name: 'test', body: `node a.mjs && ${'node b.mjs && '.repeat(20)}node c.mjs` }],
    }),
  hostile: () =>
    draftOf({
      root: `C:/work/${BIDI}shop`,
      problem: HOSTILE,
      checks: [{ ...TEST, description: HOSTILE, dir: `a${ZERO}b`, argv: ['node', `x${ESC}[2Jy`, `${CYRILLIC_A}pi`] }],
      scripts: [{ checkId: 'nowhere', name: `post${BIDI}test`, body: HOSTILE }],
    }),
}

// ---------------------------------------------------------------- drawing it

type El = { type: string; key?: string; props?: Record<string, any>; children?: unknown[] }
type Call = [name: string, ...args: unknown[]]
type Make = (d: ProofDraw) => Section[]

const everything =
  (vm: ProofViewModel): Make =>
  d => [
    proofSummary(d, vm),
    ...vm.tasks.map(task => taskMark(d, task)),
    ...vm.tasks.map(task => taskDetail(d, vm, task, 4)),
    proofNotices(d, vm),
    logTail(d, vm),
  ]
const setup =
  (draft: Draft): Make =>
  d => [setupDraft(d, draft)]

const stage = ($: Engine, on: On) => {
  const calls: Call[] = []
  const record =
    (name: string) =>
    (...args: unknown[]) =>
      void calls.push([name, ...args])
  const act: ProofActions = {
    toggleClaim: record('toggleClaim'),
    allow: record('allow'),
    discardDraft: record('discardDraft'),
    verify: record('verify'),
    cancel: record('cancel'),
    acceptBaseline: record('acceptBaseline'),
    resume: record('resume'),
    review: record('review'),
    showLog: record('showLog'),
  }
  let make: Make = () => []
  let given: Section[] = []
  let colors: Colors = NATIVE
  on('ui.render', { component: 'Pane', requestId: 'proof-view' }, ($, e) => {
    const els = $.ui.resolve(e)
    const { Box } = els
    given = make({ els, colors, width: e.props.bodyColumns, act })
    return (
      <Box flexDirection="column" width={e.props.bodyColumns}>
        {given.map(section => (
          <Box flexDirection="column">{section.node}</Box>
        ))}
      </Box>
    )
  })
  const show = async (next: Make, width: number, palette: Colors = NATIVE) => {
    make = next
    colors = palette
    const ui = await $.ui.mount({
      plugin: 'os-deck',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'proof-view',
      props: { title: 'OS-Deck', isFocused: true, bodyColumns: width, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
    })
    const tree = (await ui.drawn()) as unknown as El
    return {
      tree,
      sections: given,
      boxes: elementsIn(tree),
      press: async (key: string) => {
        calls.length = 0
        // The hook is the test's, so the Button is too.
        await ui.press({ plugin: 'test', key })
        return [...calls]
      },
      close: () => ui.unmount(),
    }
  }
  return { show }
}

// ---------------------------------------------------------------- reading it

const elementsIn = (el: El | undefined) => (el?.children ?? []).filter((x): x is El => typeof x === 'object' && x !== null)
const allOf = (el: El): El[] => [el, ...elementsIn(el).flatMap(allOf)]
const textOf = (el: El): string => (el.children ?? []).map(x => (typeof x === 'string' || typeof x === 'number' ? String(x) : x ? textOf(x as El) : '')).join('')
const labelOf = (el: El): string => el.props?.label ?? textOf(el)
const buttonsOf = (el: El) => allOf(el).filter(x => x.type === 'Button')
const keysOf = (el: El) => buttonsOf(el).map(x => String(x.props?.key))

/** Every row as its words. */
const linesOf = (el: El): string[] => {
  if (el.type === 'Text') return [textOf(el)]
  if (el.type === 'Button') return [labelOf(el)]
  const kids = elementsIn(el).map(linesOf)
  return el.props?.flexDirection === 'column' ? kids.flat() : [kids.flat().join('')]
}
const wordsOf = (el: El) => linesOf(el).join(' ').replace(/\s+/g, ' ')

const WIDE = /[\p{Emoji_Presentation}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const cells = (text: string) => Array.from(text).reduce((n, c) => n + (/\p{Mn}/u.test(c) ? 0 : WIDE.test(c) ? 2 : 1), 0)

const natural = (el: El): number => {
  if (el.type === 'Text') return cells(textOf(el))
  if (el.type === 'Button') return cells(labelOf(el)) + (el.props?.plain ? 0 : 4)
  const kids = elementsIn(el).map(natural)
  const inner = el.props?.flexDirection === 'column' ? Math.max(0, ...kids) : kids.reduce((a, b) => a + b, 0)
  return inner + (el.props?.paddingLeft ?? 0)
}

/** The rows a terminal would take, and whatever would not fit: that is cut or wrapped. */
const layout = (el: El, width: number, over: string[]): number => {
  if (el.type === 'Box' && el.props?.flexDirection === 'column') {
    const inner = Math.min(el.props?.width ?? width, width) - (el.props?.paddingLeft ?? 0)
    return elementsIn(el).reduce((n, kid) => n + layout(kid, inner, over), 0)
  }
  const size = natural(el)
  if (size > width) over.push(`${size} in ${width}: ${linesOf(el).join('')}`)
  if (el.type === 'Text' && el.props?.wrap !== 'truncate') {
    // Where the terminal counts a character wider than we do, such a row becomes two.
    over.push(`a row that could wrap: ${textOf(el)}`)
    return Math.max(1, Math.ceil(size / width))
  }
  const text = linesOf(el).join('')
  if (text === '' && el.type === 'Text') return 0
  return text.split('\n').length
}

const WIDTHS = Array.from({ length: 120 - 24 + 1 }, (_, i) => 24 + i)
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u
const PASS_MARK = /[✓✔✅☑√🗸🟢🟩💚]/u

type Stage = ReturnType<typeof stage>

// A sweep draws through the engine at every width, which outlasts the kit's five seconds on a busy machine.
const SWEEP = { timeoutMs: 30_000 }

/** At every width: the rows said are the rows drawn, nothing overflows, every press can be told apart. */
const sweep = async (s: Stage, make: Make) => {
  let keys = ''
  for (const width of WIDTHS) {
    const drawn = await s.show(make, width)
    expect(drawn.boxes.length, 'one box a section').toBe(drawn.sections.length)
    drawn.boxes.forEach((box, i) => {
      const over: string[] = []
      const rows = layout(box, width, over)
      expect(drawn.sections[i]?.rows, `rows of section ${i} at ${width}`).toBe(rows)
      expect(over, `section ${i} at ${width}`).toEqual([])
      expect(drawn.sections[i]?.node === null, `node of section ${i}`).toBe(rows === 0)
    })
    for (const line of linesOf(drawn.tree)) expect(UNSAFE.test(line), `unsafe at ${width}`).toBe(false)
    const now = keysOf(drawn.tree)
    expect(new Set(now).size, `keys unique at ${width}`).toBe(now.length)
    expect(keys === '' || keys === now.join('|'), `keys stable at ${width}`).toBe(true)
    keys = now.join('|')
    for (const button of buttonsOf(drawn.tree)) expect(button.props?.hotkey, 'no hotkey').toBeUndefined()
    await drawn.close()
  }
}

for (const [name, state] of Object.entries(STATES)) {
  test(`proof view, ${name}: rows are what is drawn at every width from 24 to 120`, SWEEP, async ($, on) => {
    await sweep(stage($, on), everything(state()))
  })
}

for (const [name, draft] of Object.entries(DRAFTS)) {
  test(`proof setup, ${name}: rows are what is drawn at every width from 24 to 120`, SWEEP, async ($, on) => {
    await sweep(stage($, on), setup(draft()))
  })
}

// ---------------------------------------------------------------- what it may say

const WORD: Readonly<Record<string, string>> = { failed: 'failed', inconclusive: 'inconclusive', stale: 'stale', pending: 'pending', verifying: 'verifying', verified: 'checks' }

test('proof view: nothing that is not verified is green or has a check mark', SWEEP, async ($, on) => {
  const s = stage($, on)
  for (const [name, state] of Object.entries(STATES)) {
    const vm = state()
    const rootGreen = vm.roots.some(r => r.verdict.state === 'verified')
    for (const width of [24, 40, 50, 120]) {
      const drawn = await s.show(everything(vm), width)
      // The summary follows the roots; a task's mark and detail follow that task alone.
      drawn.boxes.forEach((box, i) => {
        const task = i >= 1 && i <= vm.tasks.length * 2 ? vm.tasks[(i - 1) % vm.tasks.length] : undefined
        const may = i === 0 ? rootGreen : !!task && !task.claim.withdrawn && task.verdict.state === 'verified'
        if (may) return
        const where = `${name}, section ${i}, width ${width}`
        expect(allOf(box).some(el => el.props?.color === NATIVE.gate), `green: ${where}`).toBe(false)
        expect(PASS_MARK.test(linesOf(box).join('')), `check mark: ${where}`).toBe(false)
      })
      await drawn.close()
    }
  }
})

test('proof view: a withdrawn claim is never green, whatever verdict it is handed', SWEEP, async ($, on) => {
  const s = stage($, on)
  const vm = STATES.verified!()
  const task: TaskView = { ...vm.tasks[0]!, claim: claimOf({ withdrawn: true }), verdict: { state: 'verified', reason: '' } }
  const drawn = await s.show(d => [taskMark(d, task), taskDetail(d, vm, task)], 80)
  expect(allOf(drawn.tree).some(el => el.props?.color === NATIVE.gate)).toBe(false)
  expect(PASS_MARK.test(linesOf(drawn.tree).join(''))).toBe(false)
  expect(keysOf(drawn.tree)).not.toContain(`proof-review:${CLAIM}:"${REV}"`)
  await drawn.close()
})

test('proof view: a root that is not verified has no green beside one that is', SWEEP, async ($, on) => {
  const s = stage($, on)
  const drawn = await s.show(d => [proofSummary(d, STATES['two roots of one name']!())], 80)
  const rows = elementsIn(elementsIn(drawn.boxes[0])[0])
  expect(rows.length).toBe(3)
  expect(textOf(rows[1]!)).toContain(ROOT)
  expect(allOf(rows[1]!).some(el => el.props?.color === NATIVE.gate)).toBe(true)
  expect(textOf(rows[2]!)).toContain(OTHER)
  expect(textOf(rows[2]!)).toContain('✗ failed')
  expect(allOf(rows[2]!).some(el => el.props?.color === NATIVE.gate)).toBe(false)
  await drawn.close()
})

test('proof view: a palette whose colours all are the green still greens only the verified', SWEEP, async ($, on) => {
  const s = stage($, on)
  const green = Object.fromEntries(Object.keys(PALETTES.pastel).map(key => [key, '#00ff00'])) as Colors
  for (const name of ['failed', 'stale', 'pending, automatic', 'timed out', 'verifying']) {
    const drawn = await s.show(d => everything(STATES[name]!())(d).slice(0, 2), 80, green)
    expect(allOf(drawn.tree).some(el => el.props?.color === '#00ff00'), name).toBe(false)
    await drawn.close()
  }
})

for (const [name, state] of Object.entries(STATES)) {
  test(`proof view, ${name}: the state has a word in the root line and in the detail, at every width`, SWEEP, async ($, on) => {
    const s = stage($, on)
    const vm = state()
    for (const width of WIDTHS) {
      const drawn = await s.show(d => [proofSummary(d, vm), ...vm.tasks.map(t => taskDetail(d, vm, t))], width)
      const lines = linesOf(drawn.boxes[0]!)
      vm.roots.forEach((root, i) => expect(lines[i + 1], `root at ${width}`).toContain(WORD[root.verdict.state]!))
      const task = vm.tasks[0]
      if (task && vm.openClaim && !task.claim.withdrawn) expect(wordsOf(drawn.boxes[1]!), `detail at ${width}`).toContain(WORD[task.verdict.state]!)
      await drawn.close()
    }
  })
}

test('proof view: checks verified always stands beside the review axis', SWEEP, async ($, on) => {
  const s = stage($, on)
  for (const name of ['verified', 'verified and reviewed', 'root verified, no task', 'paused']) {
    const vm = STATES[name]!()
    for (const width of WIDTHS) {
      const drawn = await s.show(everything(vm), width)
      const summary = linesOf(drawn.boxes[0]!)[1]
      expect(summary, `${name}, root at ${width}`).toMatch(/✓ checks( verified)? · (review|\d+ to review)/)
      if (vm.tasks[0]) {
        expect(linesOf(drawn.boxes[1]!).join(''), `${name}, mark at ${width}`).toMatch(width < 50 ? /^ ✓[○●]$/ : /^ ✓ checks · (review|reviewed)$/)
        if (vm.openClaim) expect(wordsOf(drawn.boxes[2]!), `${name}, detail at ${width}`).toMatch(/✓ checks verified · review/)
      }
      await drawn.close()
    }
  }
})

test('proof view: a mark is a word from 50 columns and a glyph below', SWEEP, async ($, on) => {
  const s = stage($, on)
  const cases = [
    ['failed', '✗', '✗ failed'],
    ['timed out', '?', '? inconclusive'],
    ['stale', '◌', '◌ stale'],
    ['pending, automatic', '…', '… pending'],
    ['verifying', '◐', '◐ verifying'],
    ['root verified, reopened', '↺', '↺ reopened'],
  ] as const
  for (const [name, glyph, words] of cases) {
    for (const [width, want] of [[24, glyph], [49, glyph], [50, words], [120, words]] as const) {
      const drawn = await s.show(d => [taskMark(d, STATES[name]!().tasks[0]!)], width)
      expect(linesOf(drawn.tree).join(''), `${name} at ${width}`).toBe(` ${want}`)
      expect((drawn.sections[0] as unknown as { width: number }).width).toBe(cells(` ${want}`))
      await drawn.close()
    }
  }
})

test('proof view: the attention line has the worst first and review last', SWEEP, async ($, on) => {
  const s = stage($, on)
  const base = STATES.verified!().tasks[0]!
  const task = (id: string, state: TaskView['verdict']['state']): TaskView => ({ ...base, claim: claimOf({ id }), verdict: { state, reason: '' } })
  const vm = { ...modelOf({ claims: [] }), tasks: [task('a', 'pending'), task('b', 'stale'), task('c', 'inconclusive'), task('d', 'failed')] }
  const drawn = await s.show(d => [proofSummary(d, vm)], 120)
  expect(linesOf(drawn.tree)[0]).toBe('proof  1 failed · 1 inconclusive · 1 stale · 1 pending · 4 to review')
  await drawn.close()
})

test('proof view: the detail keeps claimed, verified and the person apart', SWEEP, async ($, on) => {
  const s = stage($, on)
  const vm = STATES.hostile!()
  const drawn = await s.show(d => [taskDetail(d, vm, vm.tasks[0]!)], 70)
  const lines = linesOf(drawn.tree)
  const verified = lines.indexOf('VERIFIED BY OS-DECK')
  const yours = lines.indexOf('FOR YOU')
  expect(lines[0]).toMatch(/^CLAIMED by agent/)
  expect(verified > 0 && yours > verified, 'the order of the parts').toBe(true)
  expect(lines.filter(x => x === 'VERIFIED BY OS-DECK')).toHaveLength(1)
  // Whatever the agent wrote is behind its bar.
  const firstWord = lines.findIndex(x => x.startsWith('│ '))
  for (const line of lines.slice(firstWord, verified)) expect(line).toMatch(/^│ /)
  await drawn.close()
})

test('proof view: a stale result is in words, and history does not say verified', SWEEP, async ($, on) => {
  const s = stage($, on)
  const vm = STATES.stale!()
  const drawn = await s.show(d => [taskDetail(d, vm, vm.tasks[0]!)], 100)
  const words = wordsOf(drawn.tree)
  expect(words).toContain('◌ stale: changed since the checks ran')
  expect(words).toContain('· test passed then: 146 passed, 0 failed, 1 skipped · exit 0')
  expect(words).toMatch(/earlier runs: \d\d:\d\d failed · \d\d:\d\d passed/)
  await drawn.close()
})

test('proof view: nothing is drawn with no roots, tasks or draft', SWEEP, async ($, on) => {
  const s = stage($, on)
  const vm = modelOf({ roots: [], claims: [] })
  const drawn = await s.show(d => [proofSummary(d, vm), proofNotices(d, vm), setupDraft(d, vm.draft), logTail(d, vm)], 80)
  for (const section of drawn.sections) expect(section).toEqual({ rows: 0, node: null })
  expect(linesOf(drawn.tree).join('')).toBe('')
  await drawn.close()
})

test('proof view: a closed claim takes no row', SWEEP, async ($, on) => {
  const s = stage($, on)
  const vm = modelOf({ closed: true })
  const drawn = await s.show(d => [taskDetail(d, vm, vm.tasks[0]!), proofNotices(d, vm)], 80)
  for (const section of drawn.sections) expect(section).toEqual({ rows: 0, node: null })
  await drawn.close()
})

// ---------------------------------------------------------------- setup

/** Words put back from their rows: a carried row joins with nothing. */
const joined = (rows: readonly string[]) => rows.reduce((all, row, i) => (i === 0 ? row.slice(2) : row.startsWith('↳ ') ? all + row.slice(2) : `${all} ${row.slice(2)}`), '')

test('proof setup: root, arguments and script bodies are whole at every width', SWEEP, async ($, on) => {
  const s = stage($, on)
  const draft = DRAFTS.long!()
  const b = BACKSLASH
  const argv = `node "C:${b}${b}Program Files${b}${b}run.mjs" ${'a'.repeat(170)} "--name=two  spaces " "${b}u{1f9ea}"`
  for (const width of WIDTHS) {
    const drawn = await s.show(setup(draft), width)
    const rows = elementsIn(elementsIn(drawn.boxes[0])[0])
    const lines = rows.map(linesOf).flat()
    const root = lines.indexOf('root:')
    const rootEnd = lines.findIndex((line, i) => i > root + 1 && !line.startsWith('↳ '))
    expect(joined(lines.slice(root + 1, rootEnd)), `root at ${width}`).toBe(draft.root)
    const command = rows.filter(row => {
      const [head, body] = elementsIn(row)
      return !!head && ['  ', '↳ '].includes(textOf(head)) && body?.props?.bold === true
    })
    expect(joined(command.map(textOf)), `argv at ${width}`).toBe(argv)
    const script = lines.indexOf('script test:')
    const body = [lines[script + 1]!]
    for (let i = script + 2; lines[i]?.startsWith('↳ '); i++) body.push(lines[i]!)
    expect(joined(body), `script at ${width}`).toBe(draft.scripts[0]!.body)
    await drawn.close()
  }
})

test('proof setup: what does not show is escaped, not dropped', SWEEP, async ($, on) => {
  const s = stage($, on)
  const draft = draftOf({
    root: `C:/work/${BIDI}shop`,
    checks: [{ ...TEST, argv: ['node', `x${ESC}y`, `${CYRILLIC_A}pi`, 'a\nb', `tab\tz`] }],
    scripts: [{ checkId: 'test', name: 'test', body: `echo one\necho ${BIDI}two` }],
  })
  const drawn = await s.show(setup(draft), 120)
  const text = linesOf(drawn.tree).join('\n')
  const b = BACKSLASH
  for (const part of [`"C:/work/${b}u{202e}shop"`, `"x${b}u{1b}y"`, `"${b}u{430}pi"`, `"a${b}nb"`, `"tab${b}tz"`, `"echo one${b}necho ${b}u{202e}two"`, '(escaped)'])
    expect(text).toContain(part)
  await drawn.close()
})

test('proof setup: says what is inherited and what Allow means', SWEEP, async ($, on) => {
  const s = stage($, on)
  for (const width of WIDTHS) {
    const drawn = await s.show(setup(draftOf()), width)
    const words = wordsOf(drawn.tree)
    expect(words).toContain('they inherit your environment: known credential variables are blanked, the rest are not')
    expect(words).toContain('outside permission prompts and the sandbox')
    expect(words).toContain('processes a check leaves in the background may outlive it')
    expect(words).toContain('not covered: ignored files, including new folders that ignore themselves')
    expect(words).toContain('After Allow, code agents write into tests runs automatically at the end of a turn, without a permission prompt.')
    expect(words).toContain('allow automatic')
    const allow = buttonsOf(drawn.tree).find(x => String(x.props?.key).startsWith('proof-allow'))
    expect(allow?.props?.variant).toBe('primary')
    await drawn.close()
  }
})

test('proof setup: a saved baseline is shown before it is allowed', SWEEP, async ($, on) => {
  const s = stage($, on)
  const drawn = await s.show(setup(DRAFTS.saved!()), 80)
  expect(wordsOf(drawn.tree)).toContain('saved earlier: a suggestion, not a permission')
  expect(wordsOf(drawn.tree)).toContain('accepted baseline: at least 140 must pass, at most 2 may be skipped')
  await drawn.close()
})

test('proof setup: each baseline a press binds is in words at every width, or said to be none', SWEEP, async ($, on) => {
  const s = stage($, on)
  const counted = (id: string, minPassed: number | null, maxSkipped: number): ProofCheck => ({ ...TEST, id, count: { parser: 'bun', minPassed, maxSkipped } })
  const draft = draftOf({
    checks: [counted('first', 17, 3), counted('second', 4021, 0), counted('third', null, 0), counted('fourth', 0, 0), { ...TEST, id: 'fifth', count: undefined }, TYPES],
    scripts: [],
  })
  for (const width of WIDTHS) {
    const drawn = await s.show(setup(draft), width)
    const words = wordsOf(drawn.tree)
    // Each under its own check.
    const part = (id: string, next: string) => words.slice(words.indexOf(`${id} · test`), words.indexOf(next))
    expect(part('first', 'second · test'), `first at ${width}`).toContain('accepted baseline: at least 17 must pass, at most 3 may be skipped')
    expect(part('first', 'second · test')).toContain('tests counted as bun prints them')
    expect(part('second', 'third · test'), `second at ${width}`).toContain('accepted baseline: at least 4021 must pass, at most 0 may be skipped')
    expect(part('third', 'fourth · test'), `third at ${width}`).toContain('no baseline accepted yet: after a first run you accept its counts')
    expect(part('fourth', 'fifth · test'), `fourth at ${width}`).toContain('no baseline accepted yet')
    expect(part('fifth', 'typecheck · required'), `fifth at ${width}`).toContain('no baseline accepted yet, and no way to count its tests: it cannot verify')
    expect(keysOf(drawn.tree)).toContain(allowKey())
    await drawn.close()
  }
})

test('proof setup: a baseline that is no count cannot be allowed', SWEEP, async ($, on) => {
  const s = stage($, on)
  // Several of these hash as null, which is drawn as none: what is bound has to be what is said.
  const bad: [least: unknown, most: unknown][] = [[Number.NaN, 0], [Infinity, 0], [-1, 0], [2.5, 0], ['140', 0], [140, undefined], [140, -1], [140, Number.NaN]]
  for (const [least, most] of bad) {
    const count = { parser: 'bun' as const, minPassed: least as number, maxSkipped: most as number }
    const drawn = await s.show(setup(draftOf({ checks: [{ ...TEST, count }] })), 80)
    expect(keysOf(drawn.tree), `${String(least)}, ${String(most)}`).toEqual(['proof-discard'])
    expect(wordsOf(drawn.tree)).toContain('cannot be allowed: a baseline that cannot be read')
    await drawn.close()
  }
})

test('proof setup: two script bodies that differ never look the same', SWEEP, async ($, on) => {
  const s = stage($, on)
  const bodies = ['echo a\necho b', 'echo a\r\necho b', 'echo a \necho b', 'echo a\necho b ', 'echo a\necho b\n', 'echo a\necho b\r\n', ' echo a\necho b', '"echo a\\necho b"']
  for (const width of [24, 80]) {
    const seen = new Set<string>()
    for (const body of bodies) {
      const drawn = await s.show(setup(draftOf({ scripts: [{ checkId: 'test', name: 'test', body }] })), width)
      // As a terminal shows it: nothing marks a space at a row's end.
      seen.add(linesOf(drawn.tree).map(line => line.trimEnd()).join('\n'))
      await drawn.close()
    }
    expect(seen.size, `at ${width}`).toBe(bodies.length)
  }
})

test('proof setup: with a problem there is no allow at all', SWEEP, async ($, on) => {
  const s = stage($, on)
  const secret = `ghp_${'A1b2C3d4'.repeat(5)}`
  const refused: [draft: Draft, why: string, leak?: string][] = [
    [draftOf({ problem: 'the root has a submodule' }), 'the root has a submodule'],
    [draftOf({ problem: '' }), 'a problem was found'],
    [draftOf({ checks: [], scripts: [] }), 'no check'],
    [draftOf({ digest: '' }), 'the checks have no digest'],
    [draftOf({ checks: [{ ...TEST, argv: ['node', secret] }] }), 'what looks like a secret', secret],
    [draftOf({ checks: [{ ...TEST, argv: ['deploy', '--password', 'hunter22fake'] }] }), 'what looks like a secret', 'hunter22fake'],
    [draftOf({ scripts: [{ checkId: 'test', name: 'test', body: `FAKE_TOKEN=${secret} node t.mjs` }] }), 'what looks like a secret', secret],
    [draftOf({ scripts: [{ checkId: 'test', name: 'test', body: 'echo hi '.repeat(4000) }] }), 'too long to show whole'],
    [draftOf({ scripts: [{ checkId: 'test', name: 'test', body: 'x\n'.repeat(500) }] }), 'too long to show whole'],
  ]
  for (const [draft, why, leak] of refused) {
    for (const width of [24, 80]) {
      const drawn = await s.show(setup(draft), width)
      expect(keysOf(drawn.tree), why).toEqual(['proof-discard'])
      expect(wordsOf(drawn.tree)).toContain('cannot be allowed:')
      expect(wordsOf(drawn.tree)).toContain(why)
      if (leak) expect(linesOf(drawn.tree).join(''), 'no secret drawn').not.toContain(leak)
      await drawn.close()
    }
  }
})

test('proof setup: ordinary commands and scripts can be allowed', SWEEP, async ($, on) => {
  const s = stage($, on)
  const bodies = ['bun test', 'cross-env NODE_ENV=test jest --ci', 'tsc -p tsconfig.json --noEmit', 'vitest run\n', 'node --test\ttests/', 'eslint . && prettier --check .']
  for (const body of bodies) {
    const drawn = await s.show(setup(draftOf({ scripts: [{ checkId: 'test', name: 'test', body }] })), 80)
    expect(keysOf(drawn.tree).map(k => k.split(':')[0]), body).toEqual(['proof-allow', 'proof-manual', 'proof-discard'])
    await drawn.close()
  }
})

test('proof setup: the most that may be allowed is all drawn, presses included', SWEEP, async ($, on) => {
  const s = stage($, on)
  for (const body of ['echo one '.repeat(1740).trimEnd(), Array.from({ length: 390 }, (_, i) => `echo ${i}`).join('\n')]) {
    const drawn = await s.show(setup(draftOf({ scripts: [{ checkId: 'test', name: 'test', body }] })), 24)
    expect(keysOf(drawn.tree).map(k => k.split(':')[0])).toEqual(['proof-allow', 'proof-manual', 'proof-discard'])
    const over: string[] = []
    expect(layout(drawn.boxes[0]!, 24, over)).toBe(drawn.sections[0]?.rows)
    expect(over).toEqual([])
    const drawnWords = linesOf(drawn.tree).filter(line => line.startsWith('│ ') || line.startsWith('↳ ')).map(line => line.slice(2)).join('')
    expect(drawnWords).toBe(body.replace(/\n/g, ''))
    await drawn.close()
  }
})

test('proof setup: a forged number in a saved definition cannot cost the pane', SWEEP, async ($, on) => {
  const s = stage($, on)
  const forged = `1${ESC}[2J${ch(0)}\n${BIDI}` as unknown as number
  const draft = draftOf({ checks: [{ ...TEST, timeoutS: forged, count: { parser: 'bun', minPassed: forged, maxSkipped: forged } }], problem: 'a time limit out of range' })
  const drawn = await s.show(setup(draft), 80)
  for (const line of linesOf(drawn.tree)) expect(UNSAFE.test(line)).toBe(false)
  expect(keysOf(drawn.tree)).toEqual(['proof-discard'])
  await drawn.close()
})

// ---------------------------------------------------------------- presses

test('proof setup: allow, manual only and discard pass what was drawn', SWEEP, async ($, on) => {
  const s = stage($, on)
  for (const width of [24, 120]) {
    const draft = draftOf()
    const drawn = await s.show(setup(draft), width)
    const digest = draft.digest
    // What changes after the drawing is not what was seen.
    draft.root = 'C:/elsewhere'
    draft.digest = 'changed'
    expect(await drawn.press(allowKey('allow', digest))).toEqual([['allow', ROOT, digest, true]])
    expect(await drawn.press(allowKey('manual', digest))).toEqual([['allow', ROOT, digest, false]])
    expect(await drawn.press('proof-discard')).toEqual([['discardDraft']])
    await drawn.close()
  }
})

const CLAIM = '"S:7:1"'
const PATH = `"${ROOT}"`

test('proof view: every press of every state passes what was drawn', SWEEP, async ($, on) => {
  const s = stage($, on)
  const toggle = { [`proof-claim:${CLAIM}`]: ['toggleClaim', 'S:7:1'] }
  const again = { [`proof-verify:${CLAIM}:${PATH}`]: ['verify', ROOT] }
  const review = { [`proof-review:${CLAIM}:"${REV}"`]: ['review', 'S:7:1', [{ root: ROOT, revision: REV }]] }
  const log = (id: string) => ({ [`proof-log:${CLAIM}:${PATH}:"${id}"`]: ['showLog', ROOT, id] })
  const cases: [name: string, presses: Record<string, unknown[]>][] = [
    ['pending, automatic', { ...toggle, ...again, ...review }],
    ['not allowed', { ...toggle, ...review }],
    ['verifying', { ...toggle, [`proof-cancel:"":${PATH}`]: ['cancel', ROOT], ...log('typecheck'), ...review }],
    ['pending, manual', { ...toggle, [`proof-verify:"":${PATH}`]: ['verify', ROOT], ...review }],
    ['verified', { ...toggle, ...again, ...log('test'), ...review }],
    ['verified and reviewed', { ...toggle, ...again, ...log('test') }],
    ['failed', { ...toggle, ...again, ...log('test'), ...review, [`proof-log-close:${PATH}:"test"`]: ['showLog', ROOT, null] }],
    ['timed out', { ...toggle, ...again, ...log('typecheck'), ...review }],
    ['root verified, reopened', { ...toggle, ...again, ...log('test') }],
    ['no baseline accepted', { ...toggle, ...again, ...log('test'), ...review, [`proof-baseline:${PATH}:"A1":"test"`]: ['acceptBaseline', ROOT, 'A1', 'test', 146, 1] }],
    ['paused', { ...toggle, ...again, ...log('test'), ...review, [`proof-resume:${PATH}`]: ['resume', ROOT, ['package.json', 'scripts/run tests.mjs']] }],
    ['failed, nothing open', { ...toggle, [`proof-log:"":${PATH}:"test"`]: ['showLog', ROOT, 'test'] }],
    ['verifying, nothing open', { ...toggle, [`proof-cancel:"":${PATH}`]: ['cancel', ROOT] }],
  ]
  for (const [name, presses] of cases) {
    for (const width of [24, 100]) {
      const drawn = await s.show(everything(STATES[name]!()), width)
      expect(keysOf(drawn.tree).sort(), `${name}: the presses`).toEqual(Object.keys(presses).sort())
      for (const [key, call] of Object.entries(presses)) expect(await drawn.press(key), `${name}: ${key}`).toEqual([call])
      await drawn.close()
    }
  }
})

test('proof view: a manual root has its verify a press away', SWEEP, async ($, on) => {
  const s = stage($, on)
  const vm = modelOf({ roots: [{ grant: grantOf({ auto: false }) }], claims: [] })
  const drawn = await s.show(d => [proofNotices(d, vm)], 60)
  expect(await drawn.press(`proof-verify:"":${PATH}`)).toEqual([['verify', ROOT]])
  await drawn.close()
})

test('proof view: cancel does not need the open task to be in sight', SWEEP, async ($, on) => {
  const s = stage($, on)
  const vm = STATES.verifying!()
  expect(vm.openClaim).toBe('S:7:1')
  const drawn = await s.show(d => [proofNotices(d, vm)], 60)
  expect(await drawn.press(`proof-cancel:"":${PATH}`)).toEqual([['cancel', ROOT]])
  await drawn.close()
})

test('proof view: several roots each press for themselves', SWEEP, async ($, on) => {
  const s = stage($, on)
  const drawn = await s.show(everything(STATES['two roots of one name']!()), 80)
  expect(await drawn.press(`proof-verify:${CLAIM}:${PATH}`)).toEqual([['verify', ROOT]])
  expect(await drawn.press(`proof-verify:${CLAIM}:"${OTHER}"`)).toEqual([['verify', OTHER]])
  expect(await drawn.press(`proof-review:${CLAIM}:"${REV}":"${REV}"`)).toEqual([['review', 'S:7:1', [{ root: ROOT, revision: REV }, { root: OTHER, revision: REV }]]])
  await drawn.close()
})

test('proof view: a press keeps what was drawn when the model changes under it', SWEEP, async ($, on) => {
  const s = stage($, on)
  const vm = modelOf({ roots: [{ attempts: [attemptOf()], paused: ['package.json'], baseline: { attemptId: 'A1', checkId: 'test', passed: 146, skipped: 1 } }] })
  const drawn = await s.show(everything(vm), 80)
  const root = vm.roots[0]!
  root.paused.push('unseen.json')
  root.baseline!.passed = 1
  vm.tasks[0]!.drawn[0]!.revision = NEXT
  expect(await drawn.press(`proof-resume:${PATH}`)).toEqual([['resume', ROOT, ['package.json']]])
  expect(await drawn.press(`proof-baseline:${PATH}:"A1":"test"`)).toEqual([['acceptBaseline', ROOT, 'A1', 'test', 146, 1]])
  expect(await drawn.press(`proof-review:${CLAIM}:"${REV}"`)).toEqual([['review', 'S:7:1', [{ root: ROOT, revision: REV }]]])
  await drawn.close()
})

test('proof view: baseline and resume show what is being accepted', SWEEP, async ($, on) => {
  const s = stage($, on)
  for (const width of WIDTHS) {
    const vm = STATES['no baseline accepted']!()
    const drawn = await s.show(d => [proofNotices(d, vm), proofNotices(d, STATES.paused!())], width)
    const baseline = wordsOf(drawn.boxes[0]!)
    expect(baseline).toContain('test ran: 146 passed, 1 skipped')
    expect(baseline).toContain('at least 146 must pass and at most 1 be skipped')
    const paused = linesOf(drawn.boxes[1]!)
      .map(line => line.replace(/^(↳ | {2})/, ''))
      .join('')
    expect(paused).toContain('package.json')
    expect(paused).toContain('scripts/run tests.mjs')
    await drawn.close()
  }
})

test('proof view: no baseline can be accepted from zero tests or during a run', SWEEP, async ($, on) => {
  const s = stage($, on)
  const zero = modelOf({ roots: [{ baseline: { attemptId: 'A1', checkId: 'test', passed: 0, skipped: 0 } }] })
  const running = modelOf({ roots: [{ attempts: [attemptOf({ after: null, endedAt: null })], liveId: 'A1', baseline: { attemptId: 'A1', checkId: 'test', passed: 9, skipped: 0 } }] })
  for (const vm of [zero, running]) {
    const drawn = await s.show(d => [proofNotices(d, vm)], 80)
    expect(keysOf(drawn.tree).some(key => key.startsWith('proof-baseline'))).toBe(false)
    await drawn.close()
  }
})

test('proof view: no trailing detail is drawn as a stray ellipsis', SWEEP, async ($, on) => {
  const s = stage($, on)
  const vm = STATES.verified!()
  for (const width of WIDTHS) {
    const drawn = await s.show(d => [proofSummary(d, vm)], width)
    expect(linesOf(drawn.tree)[1], `at ${width}`).not.toContain('…')
    await drawn.close()
  }
})

test('proof view: the log shows its end, as plain text', SWEEP, async ($, on) => {
  const s = stage($, on)
  const text = `${Array.from({ length: 80 }, (_, i) => `line ${i} ${ESC}[32m✓${ESC}[0m`).join('\n')}\nlast\n\n`
  const vm = modelOf({ log: text })
  const drawn = await s.show(d => [logTail(d, vm)], 60)
  const lines = linesOf(drawn.tree)
  expect(lines).toContain('│ last')
  expect(lines.some(line => line.includes('earlier rows not shown'))).toBe(true)
  expect(lines.join('')).not.toContain('line 0 ')
  expect(PASS_MARK.test(lines.join(''))).toBe(false)
  await drawn.close()
})

// ---------------------------------------------------------------- what the red team got past

/** What a press approves is in its key: a button redrawn over other bytes is another button. */
function allowKey(what = 'allow', digest = 'D'.repeat(64)) {
  return `proof-${what}:"${digest}"`
}

test('M4: a root is not reviewed while a claim that could be of it is not', SWEEP, async ($, on) => {
  const vm = modelOf({ attempts: undefined, roots: [{ attempts: [attemptOf()] }], claims: [claimOf()], reviewed: true, closed: true } as never)
  const unknown = { ...(vm.tasks[0] as TaskView), claim: claimOf({ id: 'S:8:1', taskId: '8', hasBaseline: false, changes: [] }), isReviewed: false }
  const drawn = await stage($, on).show(everything({ ...vm, tasks: [...vm.tasks, unknown] }), 80)
  expect(wordsOf(drawn.tree)).not.toContain('verified · reviewed')
  await drawn.close()
})

test('M6: a secret in a path is not drawn', SWEEP, async ($, on) => {
  const token = ['ghp', 'A'.repeat(30)].join('_')
  const vm = modelOf({ roots: [{ paused: [`cfg/${token}.sh`] }], more: { reviewWorthy: [`tests/${token}.test.ts`] } } as never)
  const drawn = await stage($, on).show(everything(vm), 120)
  expect(wordsOf(drawn.tree)).not.toContain(token)
  await drawn.close()
})
