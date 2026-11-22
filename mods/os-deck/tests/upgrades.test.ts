import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { askAlertText, isTurnAlert, turnAlertText } from '../hooks/alerts'
import { FULL_PCT, phaseProgress, planEta, turnsLine, turnsToFull, withReading } from '../hooks/forecast'
import { checkOf, checksLine, closingIssuesOf, ghErrorOf, parsePr, parsePrList } from '../hooks/github'
import { addToDay, dayOf, historyReport, normalizeHistory } from '../hooks/history'
import { PET_COMPACT_MS, PET_FRIEND_LINGER_MS, friendsAt, petCells, petColorsOf, petFrame, petStateOf } from '../hooks/pet-art'
import type { PetInput } from '../hooks/pet-art'
import type { PlanTask } from '../types'

const base: PetInput = { isRunning: false, tool: null, agents: 0, asks: 0, errorAt: null, doneAt: null, activeAt: 0, now: 10_000 }

test('pet: cubes follow the real subagents, a finished one lingers sparkling, a failed one red', () => {
  const friends = [
    { color: 0, status: 'done' as const, endedAt: 10_000 - PET_FRIEND_LINGER_MS - 1 },
    { color: 1, status: 'running' as const, endedAt: null },
    { color: 2, status: 'failed' as const, endedAt: 9_500 },
    { color: 3, status: 'done' as const, endedAt: 9_900 },
  ]
  // The long-finished one is gone; the rest keep their spawn colours.
  expect(friendsAt({ ...base, friends })).toEqual([
    { color: 1, status: 'running' },
    { color: 2, status: 'failed' },
    { color: 3, status: 'done' },
  ])
  expect(petStateOf({ ...base, friends }).caption).toBe('1 agent working')
  expect(petStateOf({ ...base, friends: [friends[2]!] }).caption).toBe('an agent failed')
  expect(petStateOf({ ...base, friends: [friends[3]!] })).toEqual({ state: 'agents', caption: 'agent done' })
  // Once the finished ones have gone, the pet goes back to what it was doing.
  expect(petStateOf({ ...base, now: 20_000, friends: friends.filter(f => f.status !== 'running') }).state).toBe('idle')
  const shown = friendsAt({ ...base, friends })
  const px = petFrame('agents', 0, shown).px.flat()
  expect(px.filter(c => c === 'R' || c === 'r').length).toBe(18) // the failed cube in red: 20 pixels, its two eyes kept
  expect(px.filter(c => c === 'g' || c === 'h').length + px.filter(c => c === 'O').length).toBeGreaterThan(0)
  const glyphs = petCells(petFrame('agents', 0, shown), petColorsOf(null)).flat().map(r => r.text).join('')
  expect(glyphs).toMatch(/[✦✧]/) // the finished one's sparkle
})

test('pet: a shell command runs at a terminal, a compaction squashes it, a full context makes it sweat', () => {
  expect(petStateOf({ ...base, isRunning: true, tool: 'PowerShell' })).toEqual({ state: 'running', caption: 'running a command' })
  expect(petStateOf({ ...base, isRunning: true, tool: 'Edit' }).state).toBe('editing')
  const run = petCells(petFrame('running', 0), petColorsOf(null)).flat().map(r => r.text).join('')
  expect(run).toContain('>_')
  expect(petStateOf({ ...base, compactAt: 9_000 }).state).toBe('compact')
  expect(petStateOf({ ...base, compactAt: 10_000 - PET_COMPACT_MS }).state).toBe('idle')
  // Squashed: the body's top rows are empty for the first frames.
  expect(petFrame('compact', 0).px[6]?.includes('B')).toBe(false)
  expect(petFrame('compact', 0).px[10]?.includes('B')).toBe(true)
  // Sweat: a drop beside the head and the context in the caption, from 85%.
  expect(petStateOf({ ...base, ctxPct: 84 }).caption).toBe('waiting for you')
  expect(petStateOf({ ...base, ctxPct: 91.6 }).caption).toBe('waiting for you · ctx 92%')
  expect(petFrame('idle', 0, 0, true).px[4]?.[3]).toBe('C')
  expect(petFrame('idle', 0, 0, false).px[4]?.[3]).toBe('.')
})

test('github: a pull request read leniently, its checks, review and the issues it closes', () => {
  expect(closingIssuesOf('Closes #12. Also fixes #3 and resolved #12; see #99')).toEqual([12, 3])
  expect(checkOf({ name: 'ci', status: 'IN_PROGRESS' })).toEqual({ name: 'ci', state: 'pending' })
  expect(checkOf({ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' })).toEqual({ name: 'ci', state: 'failed' })
  expect(checkOf({ context: 'lint', state: 'SUCCESS' })).toEqual({ name: 'lint', state: 'passed' })
  const pr = parsePr(
    JSON.stringify({
      number: 134,
      title: 'docs',
      state: 'OPEN',
      isDraft: false,
      reviewDecision: 'CHANGES_REQUESTED',
      statusCheckRollup: [{ name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' }, { name: 'b', status: 'QUEUED' }],
      url: 'https://github.com/o/r/pull/134',
      body: 'Closes #133',
      headRefName: 'v5-docs',
    }),
  )
  expect(pr?.review).toBe('changes')
  expect(pr?.closes).toEqual([133])
  expect(checksLine(pr?.checks ?? [])).toEqual({ text: '…1 ✓1', worst: 'pending' })
  expect(checksLine([])).toEqual({ text: 'no checks', worst: 'none' })
  expect(parsePr('no pull requests found for branch "main"')).toBeNull()
  expect(parsePr(JSON.stringify({ number: 1, state: 'MERGED' }))?.state).toBe('merged')
  expect(parsePrList(JSON.stringify([{ number: 5, title: 't', headRefName: 'b', isDraft: true }, { nope: 1 }]))).toEqual([{ number: 5, title: 't', branch: 'b', isDraft: true }])
  expect(ghErrorOf('To get started with GitHub CLI, please run:  gh auth login', 4)).toBe('gh is not signed in (gh auth login)')
})

test('forecast: turns until the context is full, a compaction starting the rate over', () => {
  let r: number[] = []
  for (const pct of [20, 26, 32, 38]) r = withReading(r, pct)
  expect(turnsToFull(r, 38)).toBe(Math.ceil((FULL_PCT - 38) / 6))
  expect(turnsLine(turnsToFull(r, 38))).toBe('~10 turns left')
  expect(turnsLine(1)).toBe('full next turn')
  expect(withReading(r, 12)).toEqual([12]) // compacted
  expect(turnsToFull([40], 40)).toBeNull()
  expect(turnsToFull([40, 40.2], 40.2)).toBeNull() // not growing
})

test('forecast: each phase, its open tasks at the session average, the plan the sum', () => {
  const t = (id: string, phase: string, status: PlanTask['status'], startedAt: number | null, doneAt: number | null): PlanTask => ({
    id,
    subject: id,
    activeForm: id,
    status,
    group: ['Work', phase],
    blockedBy: [],
    agents: [],
    startedAt,
    doneAt,
    source: 'task',
  })
  const tasks = [t('1', 'Plano', 'completed', 0, 600_000), t('2', 'Impl', 'completed', 600_000, 1_800_000), t('3', 'Impl', 'in_progress', 1_800_000, null), t('4', 'QA', 'pending', null, null)]
  const now = 2_100_000
  const ph = phaseProgress(tasks, now)
  // The average task took 15 minutes; the running one has spent 5 of them.
  expect(ph.map(x => [x.group, x.done, x.total, x.etaMs])).toEqual([
    ['Work / Plano', 1, 1, null],
    ['Work / Impl', 1, 2, 600_000],
    ['Work / QA', 0, 1, 900_000],
  ])
  expect(planEta(ph)).toBe(1_500_000)
  expect(planEta(phaseProgress(tasks.slice(2), now))).toBeNull() // nothing finished yet
})

test('history: a day added to, kept leniently, reported for today and the week', () => {
  const at = new Date(2026, 10, 21, 15).getTime()
  let h: unknown = { junk: 1, '2026-11-20': { turns: 2, costUsd: 1.5, extra: 'x' } }
  h = addToDay(h, at, { turns: 1, busyMs: 3_600_000, tasks: 2, agents: 1, costUsd: 0.25 })
  h = addToDay(h, at, { turns: 1, asks: 1, askWaitMs: 60_000 })
  const n = normalizeHistory(h)
  expect(Object.keys(n)).toEqual(['2026-11-20', '2026-11-21'])
  expect(n[dayOf(at)]).toEqual({ turns: 2, busyMs: 3_600_000, tasks: 2, agents: 1, costUsd: 0.25, asks: 1, askWaitMs: 60_000 })
  expect(historyReport(h, at, 1)).toBe('OS-Deck today:\n2026-11-21  2 turns · 1h00m busy · 2 tasks · 1 agent · $0.25 · 1 ask, 1m waiting')
  const week = historyReport(h, at, 7)
  expect(week).toContain('2026-11-20  2 turns')
  expect(week).toContain('total')
  expect(week).toContain('4 turns')
  expect(historyReport({}, at, 1)).toBe('OS-Deck today: nothing recorded yet.')
})

test('alerts: what an ask and a long turn say, and which turns are worth it', () => {
  expect(askAlertText('Bash', 'npm test', 30_000)).toBe('Bash waits for your ok (30 s): npm test')
  expect(turnAlertText('answer', 5 * 60_000, 3, 1)).toBe('The turn finished after 5 min · 3 edits, 1 error')
  const cfg = { isOn: true, askAfterMs: 30_000, longTurnMs: 120_000 }
  expect(isTurnAlert(cfg, 'answer', 130_000)).toBe(true)
  expect(isTurnAlert(cfg, 'answer', 60_000)).toBe(false)
  expect(isTurnAlert(cfg, 'aborted', 600_000)).toBe(false)
  expect(isTurnAlert({ ...cfg, isOn: false }, 'answer', 600_000)).toBe(false)
})

// ---------------------------------------------------------------- in the pane

const world = (on: On) => {
  const clock = mock.clock(on)
  const db = new Map<string, unknown>()
  const notes: string[] = []
  const toasts: string[] = []
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', (_$, e) => {
    toasts.push(String((e as unknown as { text: string }).text))
    return { value: undefined } as never
  })
  on('ui.notify', (_$, e) => {
    notes.push(String((e as unknown as { text: string }).text))
    return { value: { isSent: true, channel: 'terminal_bell' } } as never
  })
  on('store.get', (_$, e) => ({ value: db.get((e as unknown as { key: string }).key) }) as never)
  on('store.set', (_$, e) => {
    const x = e as unknown as { key: string; value: unknown }
    db.set(x.key, JSON.parse(JSON.stringify(x.value)))
    return { value: undefined } as never
  })
  on('command.register', () => ({ value: undefined }) as never)
  on('session.cwd', () => ({ value: '/repo' }) as never)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return { clock, notes, toasts }
}
const pane = (bodyColumns: number, bodyRows = 70) => ({
  plugin: 'os-deck',
  component: 'Pane' as const,
  requestId: 'flightdeck',
  surface: 'terminal' as const,
  props: { title: 'OS-Deck', isFocused: true, bodyColumns, placement: 'dock' as const, scroll: { offset: 0, bodyRows }, view: {} },
})
const cmd = (args: string) => ({ command: 'os-deck', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } })

test('the GitHub section shows the branch pull request, its checks, review and the issues it closes', async ($, on) => {
  world(on)
  const argvs: string[][] = []
  on('process.run', (_$, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    argvs.push(argv)
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } }) as never
    if (argv[0] === 'gh' && argv.includes('view'))
      return ok(JSON.stringify({ number: 7, title: 'Pet cubes', state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }], url: 'u', body: 'Closes #3', headRefName: 'pet-cubes' }))
    return { value: { exitCode: 128, stdout: '', stderr: 'not a git repository' } } as never
  })
  const out = await $.command.run(cmd('github'))
  expect(out.text).toBe('OS-Deck: #7 Pet cubes · open · ✓1 · review approved · closes #3')
  // gh runs by argument vector, no shell.
  expect(argvs.some(a => a[0] === 'gh' && a[1] === 'pr' && a[2] === 'view')).toBe(true)
  const ui = await $.ui.mount(pane(70))
  expect(await ui.find({ text: /#7 / })).toBeDefined()
  expect(await ui.find({ text: /approved/ })).toBeDefined()
  expect(await ui.find({ text: /closes #3/ })).toBeDefined()
  await ui.unmount()
})

test('without gh the section stays away and /os-deck github says why', { options: { ghCommand: 'gh-missing' } }, async ($, on) => {
  world(on)
  on('process.run', (_$, e) => {
    if ((e as unknown as { argv: string[] }).argv[0] === 'gh-missing') return { value: { exitCode: 127, stdout: '', stderr: 'gh-missing: command not found' } } as never
    return { value: { exitCode: 128, stdout: '', stderr: '' } } as never
  })
  const out = await $.command.run(cmd('github'))
  expect(out.text).toContain('gh-missing was not found')
  const ui = await $.ui.mount(pane(70))
  expect(await ui.find({ text: /^github$/ })).toBeUndefined()
  await ui.unmount()
})

test('the pet caption opens its detail: the tool running and each agent, in its cube colour, opening its card', async ($, on) => {
  world(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'pd1' }))
  await $.turn.start({ text: 'go', turnId: 'PD1' })
  await $.agent.spawn({ prompt: 'map the tests', description: 'map the tests', subagentType: 'Explore', tool_use_id: 'tpd1', provider: { plugin: 'engine', tier: 'core' as const }, parentModel: 'claude-opus-5-5', background: true, fork: false } as never)
  let ui = await $.ui.mount(pane(70))
  // The agent's row in the plan carries a marker in its cube's colour.
  expect(JSON.stringify(await ui.drawn())).toContain('#7dc4e4')
  await ui.press({ key: 'pet-open' })
  await ui.unmount()
  ui = await $.ui.mount(pane(70))
  expect(await ui.find({ text: /no tool yet/ })).toBeDefined()
  await ui.press({ key: 'pet-card-pd1' })
  await ui.unmount()
  ui = await $.ui.mount(pane(70))
  expect(await ui.find({ text: /no tool calls yet/ })).toBeDefined()
  await ui.unmount()
})

test('an ask left waiting is announced once its time is up; one answered before is not', { options: { alertAfterS: 10 } }, async ($, on) => {
  const w = world(on)
  on('tool.check', () => ({ decision: 'ask' }) as never)
  await $.tool.check({ tool: 'Bash', input: { command: 'npm test' }, tool_use_id: 'al1' } as never)
  await w.clock.advance(5_000)
  expect(w.notes).toEqual([])
  await w.clock.advance(6_000)
  expect(w.notes.length).toBe(1)
  expect(w.notes[0]).toContain('Bash waits for your ok (10 s)')
})

test('a long turn is announced as it ends; the day records it and /os-deck today reports it', { options: { alertTurnMin: 1 } }, async ($, on) => {
  const w = world(on)
  await $.turn.start({ text: 'go', turnId: 'LT1' })
  await $.turn.complete({ answer: '', durationMs: 90_000, isAborted: false, turnId: 'LT1', reason: 'answer' } as never)
  expect(w.notes.some(n => n.startsWith('The turn finished after 2 min'))).toBe(true)
  await $.turn.start({ text: 'again', turnId: 'LT2' })
  await $.turn.complete({ answer: '', durationMs: 5_000, isAborted: false, turnId: 'LT2', reason: 'answer' } as never)
  expect(w.notes.length).toBe(1)
  const out = await $.command.run(cmd('today'))
  expect(out.text).toContain('2 turns')
})
