import type { On } from 'claude-code'
import type { TestBody } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import {
  DEFAULT_ARCHITECT,
  DEFAULT_GATE,
  DEFAULT_TURN,
  afterCall,
  applyStep,
  cardsOf,
  consultTimeline,
  describeInput,
  endConsult,
  fitLegend,
  fmtResetIn,
  fmtSpeed,
  gateSummary,
  lanes,
  limitLabel,
  limitOf,
  logRows,
  momentOf,
  normalizeCard,
  normalizeGate,
  normalizeLog,
  titleLines,
  parseConfig,
  prettyModel,
  promptLine,
  handbackOf,
  adviceLine,
  receiptOf,
  recordCheck,
  redact,
  settleCheck,
  trimRecent,
  startConsult,
  stepSpeed,
  DEFAULT_PLAN,
  jiraKeysIn,
  jiraIssueOf,
  jiraSiteOf,
  jiraRoot,
  jiraSkeleton,
  jiraHint,
  skinColors,
  colorsOf,
  planApply,
  planLinkTo,
  groupsFinished,
  planGroupsOf,
  groupSpent,
  nodeAt,
  doneByPath,
  historyWith,
  historyBefore,
  normalizePlan,
  groupOf,
  planCreate,
  planUpdate,
  planTodos,
  planLinkAgent,
  planCurrent,
  planTree,
  planOutline,
  parseAheadBehind,
  pickBase,
  deckSectionOf,
  epicView,
  jiraSearchOf,
  jqlParentKey,
  timelineRows,
  agentKinds,
  adviseConsult,
  hiddenOf,
  DEFAULT_ACCOUNT,
  SWITCH_HOLD_MS,
  parseCswapList,
  parseCswapSwitch,
  shownLimits,
  switchTargetOf,
  sortRepos,
} from '../hooks/core'
import type { Check } from '../types'

// ---------------------------------------------------------------- pure behaviour

test('redaction masks credentials before anything is stored', () => {
  expect(redact('curl -H "Authorization: Bearer abc.def.ghi123" x')).not.toContain('abc.def')
  expect(redact('export OPENAI_API_KEY=sk-proj-1234567890abcdef')).not.toContain('1234567890')
  expect(redact('gh auth --token ghp_abcdefghijklmnop')).not.toContain('abcdefghijklmnop')
  expect(redact('psql postgres://bob:hunter2@db/x')).not.toContain('hunter2')
  expect(redact('password=hunter2 ls')).not.toContain('hunter2')
  expect(redact('ls -la src/')).toBe('ls -la src/')
  expect(describeInput('Read', { file_path: 'C:\\Users\\me\\proj\\src\\main.ts' })).toBe('Read → src/main.ts')
})

const check = (id: string, verdict: Check['verdict'], bucket: Check['bucket'] = 'shell'): Check => ({
  id,
  tool: 'Bash',
  bucket,
  verdict,
  inSubagent: false,
  detail: 'Bash → ls',
  at: 1,
})

test('an ask is settled by the call that follows: cleared if it ran, deny if refused', () => {
  let g = recordCheck(DEFAULT_GATE, check('a', 'ask'))
  g = recordCheck(g, check('b', 'ask'))
  g = recordCheck(g, check('c', 'rule', 'file'))
  g = settleCheck(g, 'a', true)
  g = settleCheck(g, 'b', false)
  g = settleCheck(g, 'zzz', true) // not an ask: unchanged
  const s = gateSummary(g)
  expect([s.rule, s.ask, s.cleared, s.deny, s.total]).toEqual([1, 0, 1, 1, 3])
  expect(g.recent.map(c => c.verdict)).toEqual(['cleared', 'deny', 'rule'])
})

test('the gate tallies a mixed run of verdicts per family', () => {
  let g = DEFAULT_GATE
  g = recordCheck(g, check('r1', 'rule', 'file'))
  g = recordCheck(g, check('a1', 'ask', 'shell'))
  g = recordCheck(g, check('a2', 'ask', 'shell'))
  g = recordCheck(g, check('d1', 'deny', 'other'))
  g = settleCheck(g, 'a1', true)
  g = settleCheck(g, 'a2', false)
  expect(g.totals.file).toEqual({ rule: 1, ask: 0, cleared: 0, deny: 0 })
  expect(g.totals.shell).toEqual({ rule: 0, ask: 0, cleared: 1, deny: 1 })
  expect(g.totals.other.deny).toBe(1)
  expect(gateSummary(g)).toEqual({ rule: 1, ask: 0, cleared: 1, deny: 2, total: 4 })
  expect(gateSummary(DEFAULT_GATE).total).toBe(0)
})

test('a v1-shaped gate reads as empty, then records normally', () => {
  const g = normalizeGate({ file: { allow: 3, ask: 1, deny: 0, cleared: 2 }, shell: null })
  expect(gateSummary(g).total).toBe(0)
  const next = recordCheck(g, check('n1', 'rule', 'file'))
  expect(next.totals.file.rule).toBe(1)
  expect(next.recent.length).toBe(1)
})

test('a pending ask is never trimmed out before it settles', () => {
  let g = recordCheck(DEFAULT_GATE, check('old-ask', 'ask'))
  for (let i = 0; i < 120; i += 1) g = recordCheck(g, check(`r${i}`, 'rule', 'file'))
  expect(g.recent.length).toBe(80)
  expect(g.recent.some(c => c.id === 'old-ask')).toBe(true)
  g = settleCheck(g, 'old-ask', true)
  expect(gateSummary(g).ask).toBe(0)
  expect(trimRecent([check('a', 'rule'), check('b', 'rule')], 5).length).toBe(2)
})

test('edits count from every loop; errors only from the main loop', () => {
  const t = { ...DEFAULT_TURN, errorStreak: 1 }
  expect(afterCall(t, { inSubagent: true, hasFailed: false, isEdit: true }).edits).toBe(1)
  expect(afterCall(t, { inSubagent: true, hasFailed: true, isEdit: false }).errorStreak).toBe(1)
  expect(afterCall(t, { inSubagent: false, hasFailed: true, isEdit: false })).toEqual({ ...t, errorStreak: 2, errors: 1 })
  expect(momentOf(afterCall(DEFAULT_TURN, { inSubagent: true, hasFailed: false, isEdit: true }))).toBe('before done')
  expect(momentOf({ edits: 0, errorStreak: 2 })).toBe('error repeats')
})

test("a card's context is its latest step's whole input; output adds up", () => {
  let c = normalizeCard({ id: 'x' })
  c = applyStep(c, { model: 'claude-sonnet-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 30_000, cache_creation_input_tokens: 2_000, output_tokens: 500 }, stopReason: 'tool_use' })
  c = applyStep(c, { model: 'claude-sonnet-5-5', usage: { input_tokens: 5, cache_read_input_tokens: 40_000, output_tokens: 700 }, stopReason: 'max_tokens' })
  expect([c.ctx, c.out, c.steps, c.lastStop, c.model]).toEqual([40_005, 1200, 2, 'max_tokens', 'claude-sonnet-5-5'])
})

test('consults open, close by id, and draw on a shared timeline', () => {
  let a = startConsult(DEFAULT_ARCHITECT, { id: 's1', at: 0, moment: 'before a plan', via: 'advisor tool' })
  a = startConsult(a, { id: 's1', at: 5, moment: 'before a plan', via: 'again' }) // same id: ignored
  a = endConsult(a, 10, null, 's1')
  a = startConsult(a, { id: 's2', at: 90, moment: 'before done', via: 'advisor tool' })
  expect(a.consults.length).toBe(2)
  expect(a.consults[0]?.endAt).toBe(10)
  const tl = consultTimeline(a, 100, 11)
  expect(tl.length).toBe(11)
  expect(tl.startsWith('◆━')).toBe(true)
  expect(tl.split('◆').length - 1).toBe(2)
})

test('config is read leniently: bad values fall back to defaults', () => {
  const d = parseConfig({})
  expect([d.maxCards, d.layout, d.motion, d.moments, d.panels.length]).toEqual([3, 'auto', true, true, 11])
  expect(d.architect.test('fable-advisor:fable-advisor')).toBe(true)
  const c = parseConfig({ architectPattern: '([', maxCards: 99, layout: 'diagonal', panels: 'log, gate ,nope,gate', motion: 'off' })
  expect(c.architect.test('advisor')).toBe(true) // invalid regex → default
  expect([c.maxCards, c.layout, c.motion]).toEqual([6, 'auto', false])
  expect(c.panels).toEqual(['log', 'gate'])
})

test('state saved under an older shape still reads', () => {
  expect(normalizeLog([{ at: '08:00:00', who: 'jev', text: 'x' }])[0]).toEqual({ at: 0, who: 'jev', text: 'x', agentId: null, kind: 'info' })
  const g = normalizeGate({ file: { allow: 1 } }) // v1 gate shape
  expect(g.recent).toEqual([])
  expect(g.totals.shell.rule).toBe(0)
  expect(normalizeCard({ id: 'a', status: 'done' }).tools).toEqual([])
})

test('layout math: lanes share one axis, the log gets 4-8 rows, the legend never wraps', () => {
  const cards = [
    { ...normalizeCard({}), id: 'a', spawnedAt: 1000, endedAt: 1050 },
    { ...normalizeCard({}), id: 'b', spawnedAt: 1050, endedAt: null },
  ]
  const [a, b] = lanes(cards, 1100, 20)
  expect(a).toEqual({ id: 'a', before: 0, bar: 10, after: 10 })
  expect(b?.before).toBe(10)
  expect((b?.before ?? 0) + (b?.bar ?? 0) + (b?.after ?? 0)).toBe(20)
  expect([logRows(10, 40), logRows(50, 40), logRows(200, 40)]).toEqual([4, 7, 8])
  expect(fitLegend([{ label: 'main' }, { label: 'agents' }, { label: 'architect' }], 20).map(x => x.label)).toEqual(['main', 'agents'])
  expect(limitLabel('five_hour')).toBe('5h')
  expect(prettyModel('claude-opus-5-5[1m]')).toBe('Opus 5.5 1M')
  expect(prettyModel('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('Sonnet 4.5')
  expect(prettyModel('claude-3-5-haiku-20241022')).toBe('Haiku 3.5')
  expect(prettyModel('claude-opus-4-20250514')).toBe('Opus 4')
  expect(prettyModel('claude-3-opus-20240229')).toBe('Opus 3')
  expect(prettyModel('z-ai/glm-5.3-flash-with-a-long-name')).toBe('z-ai/glm-5.3-flash-wi…')
  expect(prettyModel('')).toBe('—')
  expect(promptLine('fix the parser')).toEqual({ who: 'you', text: 'fix the parser' })
  const hb = '<agent-message from="a1940a83d593229d5">\n[Subagent hand-back] The text below is the final report. The report follows:\n  Add gate tests: redaction edge cases.\n  - more\n</agent-message>'
  expect(handbackOf(hb)).toEqual({ from: 'a1940a83d593229d5', body: 'Add gate tests: redaction edge cases.' })
  expect(handbackOf('<agent-message from="x">\nPlain report line\n</agent-message>')).toEqual({ from: 'x', body: 'Plain report line' })
  expect(handbackOf('fix the parser')).toBe(null)
  expect(adviceLine('## Ship it after one more gate test.\n- details')).toBe('Ship it after one more gate test.')
  expect(adviceLine('[Subagent hand-back] header\n\n**Fix card overflow first**')).toBe('Fix card overflow first')
  expect(adviceLine('')).toBe('')
  expect(promptLine('<agent-message from="a1492260715f3be7b"> [Subagent hand-back]')).toEqual({ who: 'engine', text: 'agent message from a1492260' })
  expect(receiptOf({ ...DEFAULT_TURN, costAtStart: 5 }, { durationMs: 1, agentsSince: 0, costNow: 5, reason: 'answer' }).costDelta).toBe(null)
  expect(titleLines('Write tinyqueue test suite', 13, 16)).toEqual(['Write', 'tinyqueue test…'])
  expect(titleLines('Short', 13, 16)).toEqual(['Short', ''])
  expect(receiptOf({ ...DEFAULT_TURN, costAtStart: 1, edits: 2 }, { durationMs: 1000, agentsSince: 3, costNow: 1.5, reason: 'answer' }).costDelta).toBe(0.5)
})

test('a request\'s speed: time to its first piece, then output tokens per second to the stop', () => {
  expect(stepSpeed(1000, 1800, 3800, 120)).toEqual({ ttftMs: 800, tokPerS: 60 })
  expect(stepSpeed(1000, null, 3800, 120)).toBe(null) // no response arrived
  expect(stepSpeed(1000, 1800, 1800, 120)?.tokPerS).toBe(null) // nothing to divide by
  expect(stepSpeed(1000, 1800, 3800, null)?.tokPerS).toBe(null)
  expect(fmtSpeed({ ttftMs: 800, tokPerS: 60.4 })).toBe('ttft 0.8s · 60 tok/s')
  expect(fmtSpeed({ ttftMs: 1250, tokPerS: null })).toBe('ttft 1.3s')
})

test('a window keeps its reset time, drawn as the time left', () => {
  expect(limitOf({ kind: 'five_hour', percentUsed: 19, resetsAt: '1970-01-01T03:10:00.000Z' })).toEqual({ kind: 'five_hour', pct: 19, resetsAt: 11_400_000 })
  expect(limitOf({ kind: 'seven_day', percentUsed: 3 }).resetsAt).toBe(null)
  expect(limitOf({ kind: 'spend_limit', percentUsed: 1, resetsAt: 'soon' }).resetsAt).toBe(null)
  expect([fmtResetIn(11_400_000, 0), fmtResetIn(25 * 60_000 + 5_000, 0), fmtResetIn(4 * 86_400_000 + 2 * 3_600_000, 0)]).toEqual(['3h10m', '25m', '4d2h'])
  expect([fmtResetIn(null, 0), fmtResetIn(undefined, 0), fmtResetIn(5, 10)]).toEqual(['', '', ''])
})

// ---------------------------------------------------------------- plan

test('a group is a path: "a / b", "a > b" or a list; anything else is no group', () => {
  expect(groupOf({ group: 'v1.2 / Relatórios / Pizza' })).toEqual(['v1.2', 'Relatórios', 'Pizza'])
  expect(groupOf({ group: 'v1.2 > Auth' })).toEqual(['v1.2', 'Auth'])
  expect(groupOf({ group: 'Infra / CI/CD' })).toEqual(['Infra', 'CI/CD']) // a slash inside a name stays
  expect(groupOf({ group: [' v2 ', '', 'API'] })).toEqual(['v2', 'API'])
  // No key: no change to make. A key that names nothing (null clears it): the empty path.
  expect([groupOf({}), groupOf(null), groupOf({ group: 3 }), groupOf({ group: '  ' }), groupOf({ group: null })]).toEqual([undefined, undefined, [], [], []])
})

test('tasks are created, moved through their states, blocked and deleted by id', () => {
  let p = planCreate(DEFAULT_PLAN, { id: '1', subject: 'Schema', activeForm: 'Writing the schema', group: ['v1', 'API'] })
  p = planCreate(p, { id: '2', subject: 'Endpoint', activeForm: '', group: ['v1', 'API'] })
  p = planCreate(p, { id: '3', subject: 'Docs', activeForm: '', group: [] })
  expect(p.tasks.map(t => t.status)).toEqual(['pending', 'pending', 'pending'])
  p = planUpdate(p, { taskId: '1', status: 'in_progress' }, 100)
  expect(p.tasks[0]?.startedAt).toBe(100)
  p = planUpdate(p, { taskId: '1', status: 'completed' }, 250)
  expect([p.tasks[0]?.status, p.tasks[0]?.doneAt]).toEqual(['completed', 250])
  p = planUpdate(p, { taskId: '2', addBlockedBy: ['1', '1'], subject: 'Endpoint v2', group: ['v1', 'HTTP'] }, 300)
  expect([p.tasks[1]?.blockedBy, p.tasks[1]?.subject, p.tasks[1]?.group]).toEqual([['1'], 'Endpoint v2', ['v1', 'HTTP']])
  p = planUpdate(p, { taskId: '3', status: 'deleted' }, 400)
  expect(p.tasks.map(t => t.id)).toEqual(['1', '2'])
  // An update for an id never seen (a task made before the pane loaded) is kept as a bare task.
  p = planUpdate(p, { taskId: '9', status: 'in_progress', subject: 'Late' }, 500)
  expect(p.tasks.find(t => t.id === '9')?.subject).toBe('Late')
})

test('a todo list replaces the todo-sourced tasks and keeps their start times', () => {
  let p = planCreate(DEFAULT_PLAN, { id: '1', subject: 'Task tool one', activeForm: '', group: [] })
  p = planTodos(p, [{ content: 'Read', status: 'in_progress', activeForm: 'Reading' }, { content: 'Write', status: 'pending', activeForm: 'Writing' }], 10)
  p = planTodos(p, [{ content: 'Read', status: 'completed', activeForm: 'Reading' }, { content: 'Write', status: 'in_progress', activeForm: 'Writing' }], 20)
  expect(p.tasks.map(t => [t.subject, t.status, t.startedAt])).toEqual([
    ['Task tool one', 'pending', null],
    ['Read', 'completed', 10],
    ['Write', 'in_progress', 20],
  ])
})

test('an agent joins the task in progress when it spawns, the latest started first', () => {
  let p = planCreate(DEFAULT_PLAN, { id: '1', subject: 'A', activeForm: '', group: [] })
  p = planCreate(p, { id: '2', subject: 'B', activeForm: '', group: [] })
  expect(planLinkAgent(p, 'ag0')).toBe(p) // nothing in progress: no link
  p = planUpdate(planUpdate(p, { taskId: '1', status: 'in_progress' }, 1), { taskId: '2', status: 'in_progress' }, 2)
  p = planLinkAgent(planLinkAgent(p, 'ag1'), 'ag1')
  expect([p.tasks[0]?.agents, p.tasks[1]?.agents]).toEqual([[], ['ag1']])
})

test('the tree counts done over total at every level; ungrouped tasks sit at the root', () => {
  let p = DEFAULT_PLAN
  for (const [id, g] of [['1', ['v1', 'API']], ['2', ['v1', 'API']], ['3', ['v1', 'UI']], ['4', []]] as const) {
    p = planCreate(p, { id, subject: `t${id}`, activeForm: '', group: [...g] })
  }
  p = planUpdate(p, { taskId: '1', status: 'completed' }, 1)
  p = planUpdate(p, { taskId: '3', status: 'completed' }, 1)
  const root = planTree(p.tasks)
  expect([root.done, root.total]).toEqual([2, 4])
  const v1 = root.children[0]
  expect([v1?.label, v1?.done, v1?.total, v1?.children.map(c => `${c.label} ${c.done}/${c.total}`)]).toEqual(['v1', 2, 3, ['API 1/2', 'UI 1/1']])
  expect(root.tasks.map(t => t.id)).toEqual(['4'])
})

test('outline: groups are one line each, only the group being worked on opens, finished tasks only count', () => {
  let p = DEFAULT_PLAN
  for (const [id, g] of [['1', 'v1 / API'], ['2', 'v1 / API'], ['3', 'v1 / API'], ['4', 'v1 / UI'], ['5', 'v2 / Admin'], ['6', '']] as const) {
    p = planCreate(p, { id, subject: `t${id}`, activeForm: '', group: g ? g.split(' / ') : [] })
  }
  for (const id of ['1', '4']) p = planUpdate(p, { taskId: id, status: 'completed' }, 1)
  p = planUpdate(p, { taskId: '3', status: 'in_progress' }, 2)
  const lines = (cur: (typeof p.tasks)[number] | null, max = 20) =>
    planOutline(planTree(p.tasks), cur, max).map(l => `${'  '.repeat(l.depth)}${l.kind === 'group' ? `${l.text} ${l.done}/${l.total}` : l.text}`)
  expect(lines(planCurrent(p.tasks))).toEqual(['v1 2/4', '  API 1/3', '    t3', '    t2', '  UI 1/1', 'v2 0/1', 'ungrouped 0/1'])
  // With nothing in progress, the first group with open work opens.
  p = planUpdate(p, { taskId: '3', status: 'pending' }, 3)
  expect(lines(null)[2]).toBe('    t2')
  expect(lines(null, 3)).toEqual(['v1 2/4', '  API 1/3', '+5 more'])
})

test('a subagent that takes a task up moves under it; a replayed move keeps no made-up time', () => {
  let p = planCreate(planCreate(DEFAULT_PLAN, { id: '1', subject: 'A', activeForm: '' }), { id: '2', subject: 'B', activeForm: '' })
  p = planLinkAgent(planUpdate(p, { taskId: '1', status: 'in_progress' }, 5), 'ag')
  p = planLinkTo(p, '2', 'ag')
  expect([p.tasks[0]?.agents, p.tasks[1]?.agents]).toEqual([[], ['ag']])
  expect(planLinkTo(p, 'nope', 'ag')).toBe(p)
  const r = planUpdate(DEFAULT_PLAN, { taskId: '9', status: 'completed', subject: 'old' }, null)
  expect([r.tasks[0]?.startedAt, r.tasks[0]?.doneAt]).toEqual([null, null])
})

test('a group of two or more finishing is reported once, the deepest first', () => {
  let p = DEFAULT_PLAN
  for (const [id, g] of [['1', ['v1', 'API']], ['2', ['v1', 'API']], ['3', ['v1', 'Solo']]] as const) p = planCreate(p, { id, subject: id, activeForm: '', group: [...g] })
  p = planUpdate(p, { taskId: '1', status: 'completed' }, 1)
  const before = p
  p = planUpdate(p, { taskId: '2', status: 'completed' }, 2)
  expect(groupsFinished(before, p)).toEqual(['v1 / API'])
  const b2 = p
  p = planUpdate(p, { taskId: '3', status: 'completed' }, 3)
  expect(groupsFinished(b2, p)).toEqual(['v1']) // Solo has one task: no toast of its own
  expect(groupsFinished(p, p)).toEqual([])
})

test('an approved plan gives its section names, headings first, numbered items failing those', () => {
  expect(planGroupsOf('# Plan\n## Phase 1: Schema\nx\n## **API**\n## UI\n')).toEqual(['Schema', 'API', 'UI'])
  expect(planGroupsOf('Intro\n1. Read the code\n2. Write tests\n3) Ship')).toEqual(['Read the code', 'Write tests', 'Ship'])
  expect(planGroupsOf('just prose, no structure')).toEqual([])
  // The sections order the tree's groups.
  let p = DEFAULT_PLAN
  for (const [id, g] of [['1', 'UI'], ['2', 'API']] as const) p = planCreate(p, { id, subject: id, activeForm: '', group: [g] })
  expect(planTree(p.tasks, ['API', 'UI']).children.map(c => c.label)).toEqual(['API', 'UI'])
})

test('time spent sums each started task to its finish or to now; nodeAt walks a path', () => {
  let p = DEFAULT_PLAN
  for (const id of ['1', '2', '3']) p = planCreate(p, { id, subject: id, activeForm: '', group: ['v1', 'API'] })
  p = planUpdate(planUpdate(p, { taskId: '1', status: 'in_progress' }, 0), { taskId: '1', status: 'completed' }, 60_000)
  p = planUpdate(p, { taskId: '2', status: 'in_progress' }, 100_000)
  const root = planTree(p.tasks)
  expect(groupSpent(root, 130_000)).toBe(90_000)
  expect(nodeAt(root, ['v1', 'API'])?.total).toBe(3)
  expect(nodeAt(root, ['nope'])).toBe(null)
})

test('outline: a group opened by hand, and finished tasks listed on request', () => {
  let p = DEFAULT_PLAN
  for (const [id, g] of [['1', 'API'], ['2', 'API'], ['3', 'UI']] as const) p = planCreate(p, { id, subject: `t${id}`, activeForm: '', group: [g] })
  p = planUpdate(p, { taskId: '1', status: 'completed' }, 1)
  p = planUpdate(p, { taskId: '3', status: 'in_progress' }, 2)
  const txt = (o: Parameters<typeof planOutline>[3]) => planOutline(planTree(p.tasks), planCurrent(p.tasks), 20, o).map(l => `${l.depth}${l.text}`)
  expect(txt({})).toEqual(['0API', '0UI', '1t3'])
  expect(txt({ focus: ['API'] })).toEqual(['0API', '1t2', '0UI'])
  expect(txt({ focus: ['API'], showDone: true })).toEqual(['0API', '1t2', '1t1', '0UI'])
})

test('history: each session writes its counts, the others add up, two-week-old entries drop', () => {
  let p = planCreate(DEFAULT_PLAN, { id: '1', subject: 'a', activeForm: '', group: ['v1', 'API'] })
  p = planUpdate(p, { taskId: '1', status: 'completed' }, 1)
  expect(doneByPath(p.tasks)).toEqual({ v1: 1, 'v1 / API': 1 })
  const day = 86_400_000
  let store = historyWith(undefined, 's1', doneByPath(p.tasks), 0)
  store = historyWith(store, 's2', { v1: 2 }, day)
  expect(historyBefore(store, 's2', day)).toEqual({ v1: 1, 'v1 / API': 1 })
  expect(historyBefore(store, 's3', day)).toEqual({ v1: 3, 'v1 / API': 1 })
  expect(historyBefore(store, 's3', 15 * day)).toEqual({ v1: 2 })
  expect(historyBefore('junk', 's1', 0)).toEqual({})
})

test('the skin palette: the built-in skin, a custom one over its base, its light variant, theme colours otherwise', () => {
  const cfg = { palette: 'skin' as const, style: 'cards' as const }
  const tokyo = skinColors({ skin: 'tokyo-night' }, {}, false)
  expect(tokyo).not.toBe(null)
  expect(tokyo?.main).toMatch(/^#[0-9a-f]{6}$/i)
  expect(colorsOf(cfg, tokyo)).toBe(tokyo)
  // A custom skin keeps its base's colours but the slot it changed.
  const mine = skinColors({ skin: 'mine' }, { mine: { name: 'mine', base: 'tokyo-night', palette: { user: '#ff0000' } } }, false)
  expect(mine?.main).toBe('#ff0000')
  expect(mine?.agent).toBe(tokyo?.agent)
  // Light: the skin's own light palette where it has one.
  expect(skinColors({ skin: 'ayu' }, {}, true)?.text).toBe('#5c6166')
  // Skins off, an unknown skin, or no skins state at all: the theme's colours.
  for (const prefs of [{ skin: 'off' }, { skin: 'nope' }, null, 'junk']) expect(skinColors(prefs, {}, false)).toBe(null)
  expect(colorsOf(cfg, null).main).toBe('claude')
  // The native style keeps its one accent whatever the skin.
  expect(colorsOf({ palette: 'skin', style: 'native' }, tokyo).main).toBe('claude')
  expect(parseConfig({}).palette).toBe('skin')
})

// A getJiraIssue result in the connector's shape, with made-up content.
const jiraStatus = (name: string, key: string) => ({ name, statusCategory: { key } })
const STORY = {
  key: 'ABC-363',
  fields: {
    summary: 'Permitir a consulta dos contratos',
    issuetype: { name: 'História', subtask: false, hierarchyLevel: 0 },
    status: jiraStatus('Em andamento', 'indeterminate'),
    assignee: { displayName: 'dev.one' },
    parent: { key: 'ABC-300', fields: { summary: 'Contratos', issuetype: { name: 'Epic' }, status: jiraStatus('Em andamento', 'indeterminate') } },
    subtasks: [
      { key: 'ABC-401', fields: { summary: 'Tela de consulta', issuetype: { name: 'Sub-Tarefa' }, status: jiraStatus('Pronto', 'done') } },
      { key: 'ABC-407', fields: { summary: 'Integrar a consulta / tratar estados', issuetype: { name: 'Sub-Tarefa' }, status: jiraStatus('A fazer', 'new') } },
    ],
  },
}

test('jira: keys in a prompt, an issue from any shape the connector hands, the site from the cloudId', () => {
  expect(jiraKeysIn('vamos fazer a ABC-407, ver a abc 994 e a abc-363')).toEqual(['ABC-407', 'ABC-994', 'ABC-363'])
  const j = jiraIssueOf(STORY)
  expect([j?.key, j?.type, j?.status, j?.isDone, j?.assignee, j?.parent?.key, j?.subtasks.map(x => [x.key, x.isDone])]).toEqual([
    'ABC-363', 'História', 'Em andamento', false, 'dev.one', 'ABC-300', [['ABC-401', true], ['ABC-407', false]],
  ])
  expect(jiraIssueOf(JSON.stringify(STORY))?.key).toBe('ABC-363')
  expect(jiraIssueOf({ content: [{ type: 'text', text: JSON.stringify(STORY) }] })?.key).toBe('ABC-363')
  expect([jiraIssueOf('not json'), jiraIssueOf({ issues: [] }), jiraIssueOf(null)]).toEqual([null, null, null])
  expect(jiraSiteOf('acme.atlassian.net')).toBe('https://acme.atlassian.net')
  expect(jiraSiteOf('92e0702e-83d5-4e90-81fd-ae2feb21c822')).toBe(null)
})

test('jira: a story is the root, its open subtasks are placeholders until Claude covers them', () => {
  const j = jiraIssueOf(STORY)
  expect(j).not.toBe(null)
  if (!j) return
  expect(jiraRoot(j)).toEqual(['ABC-363 Permitir a consulta dos contratos'])
  const sub = 'ABC-407 Integrar a consulta - tratar estados'
  let sk = jiraSkeleton(j, [])
  expect(sk.map(t => [t.group.at(-1), t.status, t.source])).toEqual([
    ['ABC-401 Tela de consulta', 'completed', 'jira'],
    [sub, 'pending', 'jira'],
  ])
  // Claude's own task under the subtask's path takes its place.
  let p = planCreate(DEFAULT_PLAN, { id: '1', subject: 'wire the query', activeForm: '', group: [...jiraRoot(j), sub] })
  sk = jiraSkeleton(j, p.tasks)
  expect(sk.map(t => t.group.at(-1))).toEqual(['ABC-401 Tela de consulta'])
  // By key alone: a ticket's own words never reach the system prompt.
  expect(jiraHint(j)).toContain('"ABC-363 / ABC-407"')
  expect(jiraHint(j)).not.toContain('Permitir')
  // A subtask anchored alone sits under its story.
  const lone = jiraIssueOf({ key: 'ABC-407', fields: { summary: 'Integrar', issuetype: { name: 'Sub-Tarefa' }, status: jiraStatus('A fazer', 'new'), parent: { key: 'ABC-363', fields: { summary: 'Permitir', issuetype: { name: 'História' }, status: jiraStatus('x', 'new') } }, subtasks: [] } })
  expect(lone ? jiraRoot(lone) : null).toEqual(['ABC-363 Permitir', 'ABC-407 Integrar'])
  expect(jiraSkeleton(null, p.tasks)).toEqual([])
})

// ---------------------------------------------------------------- drawing

const engine = (on: On) => {
  const clock = mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return clock
}

const pane = (bodyColumns: number) => ({
  plugin: 'os-deck',
  component: 'Pane' as const,
  requestId: 'flightdeck',
  props: {
    title: 'Flightdeck',
    isFocused: true,
    bodyColumns,
    placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 70 },
    view: {},
  },
})

let spawnN = 0
const spawn = (subagentType: string, description: string) => ({
  prompt: description,
  description,
  subagentType,
  tool_use_id: `tu${++spawnN}`,
  provider: { plugin: 'engine', tier: 'core' as const },
  parentModel: 'claude-opus-5-5',
  background: true,
  fork: false,
})

test('a fresh session draws on every surface and width, empty panels hidden', { options: { view: 'classic' } }, async ($, on) => {
  engine(on)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    for (const cols of [40, 60, 86, 120]) {
      const ui = await $.ui.mount({ ...pane(cols), surface })
      expect(await ui.find({ text: /· main$/ })).toBeDefined()
      expect(await ui.find({ text: /session log/ })).toBeDefined()
      expect(await ui.find({ text: /agents ·/ })).toBeUndefined() // no subagents: no agents panel
      expect(await ui.find({ text: /permissions/ })).toBeUndefined() // no checks yet: no gate panel
      await ui.unmount()
    }
  }
})

test('inline above the prompt, the pane is a summary of at most 8 rows', async ($, on) => {
  engine(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `m${++n}` }))
  on('tool.check', () => ({ decision: 'allow' }))
  await $.turn.start({ text: 'go', turnId: 'M1' })
  for (const d of ['one', 'two', 'three', 'four', 'five']) await $.agent.spawn(spawn('general-purpose', `task ${d}`))
  await $.tool.check({ tool: 'Read', input: { file_path: '/a' }, tool_use_id: 'm-k1' })
  for (const surface of ['terminal', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...pane(80), props: { ...pane(80).props, placement: 'inline' as const }, surface })
    const root = (await ui.drawn()) as { children?: unknown[] }
    expect((root.children ?? []).filter(Boolean).length <= 8).toBe(true)
    expect(await ui.find({ text: /\+2 more agents/ })).toBeDefined()
    expect(await ui.find({ text: /1 allowed/ })).toBeDefined()
    expect(await ui.find({ text: /session log/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('cards are one per agent, the latest of an id in its place', () => {
  const cards = cardsOf([
    { id: 'a', description: 'first' },
    { id: 'b', description: 'other' },
    { id: 'a', description: 'again' },
  ])
  expect(cards.map(c => c.id)).toEqual(['b', 'a'])
  expect(cards.find(c => c.id === 'a')?.description).toBe('again')
})

test('a resumed agent keeps one card and the pane still draws', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'r1' }))
  await $.turn.start({ text: 'go', turnId: 'R1' })
  await $.agent.spawn(spawn('Explore', 'look around'))
  await $.agent.spawn(spawn('Explore', 'look again'))
  const ui = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  expect(await ui.find({ text: /look again/ })).toBeDefined()
  expect(await ui.find({ text: /1\/1 agents/ })).toBeDefined()
  await ui.unmount()
})

test('/clear starts the pane fresh', async ($, on) => {
  engine(on)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'c1' }))
  await $.turn.start({ text: 'go', turnId: 'C1' })
  await $.agent.spawn(spawn('Explore', 'look around'))
  await $.session.end({ reason: 'clear', sessionId: 's' } as never)
  const ui = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  expect(await ui.find({ text: /look around/ })).toBeUndefined()
  await ui.unmount()
})

test('the cards style takes its colours from the theme, raw hex only when asked', { options: { view: 'classic', style: 'cards' } }, async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  const title = await ui.find({ text: /· main$/ })
  expect(title?.props.color).toBe('claude')
  await ui.unmount()
})

test('pastel keeps the fixed dark-terminal colours', { options: { view: 'classic', palette: 'pastel', style: 'cards' } }, async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  expect((await ui.find({ text: /· main$/ }))?.props.color).toBe('#7dd3fc')
  await ui.unmount()
})

test('subagents become cards, then swimlanes past the card limit; a card expands on its hotkey', { options: { view: 'classic' } }, async ($, on) => {
  engine(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `ag${++n}` }))
  await $.turn.start({ text: 'fan out', turnId: 'T1' })
  await $.agent.spawn(spawn('general-purpose', 'Write the parser tests'))
  await $.agent.spawn(spawn('Explore', 'Map the call sites'))

  const ui = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  expect(await ui.find({ text: /Write the parser/ })).toBeDefined()
  expect(await ui.find({ text: /Sonnet 5\.5/ })).toBeDefined() // differs from main: shown
  await ui.press({ key: 'card-ag1' })
  expect(await ui.find({ text: /^Write the parser tests$/ })).toBeDefined() // the expanded panel, full title
  await ui.unmount()

  await $.agent.spawn(spawn('general-purpose', 'Implement the parser'))
  await $.agent.spawn(spawn('general-purpose', 'Review the parser'))
  for (const surface of ['terminal', 'desktop'] as const) {
    const lanesUi = await $.ui.mount({ ...pane(64), surface })
    expect(await lanesUi.find({ text: /4 total/ })).toBeDefined()
    expect(await lanesUi.find({ text: /━/ })).toBeDefined()
    await lanesUi.unmount()
  }
})

test('the server-side advisor is read from assistant rows: consulting, then on call', { options: { view: 'classic' } }, async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'plan it', turnId: 'T2' })
  const row = (content: unknown[]) =>
    $.session
      .append({
        message: { type: 'assistant', role: 'assistant', content: content as never },
        door: 'response',
        origin: { kind: 'model', model: 'claude-opus-5-5' } as never,
        uuid: `u${++spawnN}`,
      })
      .catch(() => undefined) // the test has no transcript to store rows in
  await row([{ type: 'server_tool_use', id: 'srv1', name: 'advisor', input: {} }])
  const mid = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  expect(await mid.find({ text: /ARCHITECT · advising/ })).toBeDefined()
  expect(await mid.find({ text: /◆ before a plan/ })).toBeDefined()
  await mid.unmount()

  await row([{ type: 'advisor_tool_result', tool_use_id: 'srv1', content: { type: 'advisor_redacted_result' } }])
  const after = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  expect(await after.find({ text: /ARCHITECT · on call/ })).toBeDefined()
  expect(await after.find({ text: /^1$/ })).toBeDefined()
  await after.unmount()
})

test('the gate strip fills from checks and a row opens its redacted drill-down', { options: { view: 'classic' } }, async ($, on) => {
  engine(on)
  on('tool.check', (_$, e) => ({ decision: e.tool === 'Read' ? 'allow' : 'ask' }))
  await $.tool.check({ tool: 'Read', input: { file_path: '/a/b.ts' }, tool_use_id: 'k1' })
  await $.tool.check({ tool: 'Bash', input: { command: 'curl -H "Authorization: Bearer abcdefgh12345" api' }, tool_use_id: 'k2' })
  const ui = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  expect(await ui.find({ text: /2 checks/ })).toBeDefined()
  expect(await ui.find({ text: /1 pending/ })).toBeDefined()
  await ui.press({ key: 'gate-shell' })
  expect(await ui.find({ text: /Authorization: Bearer •••/ })).toBeDefined()
  expect(await ui.find({ text: /abcdefgh12345/ })).toBeUndefined()
  await ui.unmount()
})

test('config changes labels, hides panels and turns the moments off', { options: { view: 'classic', architectLabel: 'REVIEWER', panels: 'main,architect,agents,log', moments: false } }, async ($, on) => {
  engine(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-fable-5-1', agentId: `r${++n}` }))
  await $.turn.start({ text: 'review it', turnId: 'T3' })
  await $.agent.spawn(spawn('fable-advisor:fable-advisor', 'final review'))
  const ui = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  expect(await ui.find({ text: /REVIEWER · advising/ })).toBeDefined()
  expect(await ui.find({ text: /permissions/ })).toBeUndefined()
  expect(await ui.find({ text: /before a plan/ })).toBeUndefined()
  await ui.unmount()
})

test('a consult whose start and result share one row closes, and its review flag with it', { options: { view: 'classic' } }, async ($, on) => {
  engine(on)
  on('tool.call', () => ({ result: {}, text: 'ok' }))
  await $.turn.start({ text: 'go', turnId: 'T4' })
  // An edit first, so the consult is inferred as "before done" and sets the review flag.
  await $.tool.call({ tool: 'Edit', file_path: '/x.ts', old_string: 'a', new_string: 'b' } as never)
  await $.session
    .append({
      message: {
        type: 'assistant',
        role: 'assistant',
        content: [
          { type: 'server_tool_use', id: 'srv9', name: 'advisor', input: {} },
          { type: 'advisor_tool_result', tool_use_id: 'srv9', content: { type: 'advisor_redacted_result' } },
        ] as never,
      },
      door: 'response',
      origin: { kind: 'model', model: 'claude-opus-5-5' } as never,
      uuid: 'one-row',
    })
    .catch(() => undefined)
  const ui = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  expect(await ui.find({ text: /ARCHITECT · on call/ })).toBeDefined()
  expect(await ui.find({ text: /◆ before done/ })).toBeDefined()
  expect(await ui.find({ text: /reviewing before done/ })).toBeUndefined()
  await ui.unmount()
})

// The plan view keeps the architect on call (an empty section that says it waits); the classic view hides it.
test('with no architect anywhere, the panel, legend entry and status field stay hidden', { options: { view: 'classic' } }, async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  expect(await ui.find({ text: /ARCHITECT/ })).toBeUndefined()
  expect(await ui.find({ text: /^ architect$/ })).toBeUndefined()
  await ui.unmount()
})

test('cards that cannot fit the pane fall back to lanes', { options: { view: 'classic' } }, async ($, on) => {
  engine(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `w${++n}` }))
  await $.turn.start({ text: 'go', turnId: 'W1' })
  for (const d of ['alpha', 'beta', 'gamma']) await $.agent.spawn(spawn('Explore', `task ${d}`))
  const narrow = await $.ui.mount({ ...pane(40), surface: 'terminal' })
  expect(await narrow.find({ text: /━/ })).toBeDefined() // lanes
  await narrow.unmount()
  const wide = await $.ui.mount({ ...pane(70), surface: 'terminal' })
  expect(await wide.find({ text: /━/ })).toBeUndefined() // three cards fit in 70
  expect(await wide.find({ text: /task gamma/ })).toBeDefined()
  await wide.unmount()
})

test("a background architect's advice is read from its hand-back", async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-fable-5-1', agentId: 'fab1' }))
  await $.turn.start({ text: 'review it', turnId: 'H1' })
  await $.agent.spawn(spawn('fable-advisor:fable-advisor', 'final review'))
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'H1', agentId: 'fab1', reason: 'answer' })
  await $.turn.start({
    text: '<agent-message from="fab1">\n[Subagent hand-back] The report follows:\n  Ship it after one more gate test.\n</agent-message>',
    turnId: 'H2',
  })
  const ui = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  expect(await ui.find({ text: /» Ship it after one more gate test\./ })).toBeDefined()
  await ui.unmount()
})

test('each rate-limit window shows the time to its reset where the main panel has room', async ($, on) => {
  engine(on)
  on('session.measure', (_$, e) => ({ changed: e.changed }))
  const at = (ms: number) => new Date(ms).toISOString()
  await $.session.measure({
    context: { window: 200_000 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 19, resetsAt: at(3 * 3_600_000 + 10 * 60_000) },
      { kind: 'seven_day', percentUsed: 3, resetsAt: at(4 * 86_400_000 + 2 * 3_600_000) },
    ],
    changed: ['rateLimits'],
  })
  for (const cols of [64, 120]) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    expect(await ui.find({ text: /19% ↻3h10m/ })).toBeDefined()
    expect(await ui.find({ text: /3% ↻4d2h/ })).toBeDefined()
    await ui.unmount()
  }
  const narrow = await $.ui.mount({ ...pane(40), surface: 'terminal' })
  expect(await narrow.find({ text: /19%/ })).toBeDefined()
  expect(await narrow.find({ text: /↻/ })).toBeUndefined() // no room: the gauges stay whole
  await narrow.unmount()
})

test("the main box shows the last request's time to first token and decode speed", { options: { view: 'classic' } }, async ($, on) => {
  const clock = engine(on)
  // The model beneath: 800 ms to its first words, then 2 s more to stop after 120 tokens.
  on('turn.step', async function* () {
    await clock.sleep(800)
    yield { kind: 'text' as const, index: 0, text: 'hello' }
    await clock.sleep(2000)
    const usage = { input_tokens: 10, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-opus-5-5' }
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage }
    return { turnId: 'S1', index: 0, answer: 'hello', toolUses: [], stopReason: 'end_turn' as const, usage }
  })
  const before = await $.ui.mount({ ...pane(40), surface: 'terminal' })
  expect(await before.find({ text: /ttft/ })).toBeUndefined() // nothing measured yet: no line
  await before.unmount()
  const s = $.turn.step({ turnId: 'S1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  const first = s.next()
  await clock.advance(800)
  expect((await first).value).toEqual({ kind: 'text', index: 0, text: 'hello' })
  const stop = s.next()
  await clock.advance(2000)
  await stop
  for await (const _ of s) void _
  await s.result
  for (const cols of [40, 64, 120]) {
    const ui = await $.ui.mount({ ...pane(cols), surface: 'terminal' })
    expect(await ui.find({ text: /ttft 0\.8s · 60 tok\/s/ })).toBeDefined()
    await ui.unmount()
  }
})

const boxes = (node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] => {
  if (node && typeof node === 'object') {
    const n = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }
    if (n.type === 'Box' && n.props) out.push(n.props)
    for (const c of n.children ?? []) boxes(c, out)
  }
  return out
}

test('the native style draws no panel frames and one accent, whatever the palette', { options: { view: 'classic', palette: 'pastel' } }, async ($, on) => {
  engine(on)
  on('tool.check', () => ({ decision: 'allow' }))
  await $.turn.start({ text: 'go', turnId: 'N1' })
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'n-k1' })
  const ui = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  const drawn = await ui.drawn()
  expect(boxes(drawn).filter(b => b.borderStyle !== undefined)).toEqual([])
  expect(await ui.find({ text: /permissions/ })).toBeDefined()
  expect((await ui.find({ text: /^● $/ }))?.props.color).toBe('claude')
  expect(await ui.find({ text: /^FLIGHTDECK$/ })).toBeUndefined()
  await ui.unmount()
})

test('config reads the style leniently: native unless cards is asked for', () => {
  expect([parseConfig({}).style, parseConfig({ style: 'cards' }).style, parseConfig({ style: 'neon' }).style]).toEqual(['native', 'cards', 'native'])
})

test('in the native style subagent cards have no frames either', async ($, on) => {
  engine(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: `nc${++n}` }))
  await $.turn.start({ text: 'go', turnId: 'NC1' })
  for (const d of ['one', 'two']) await $.agent.spawn(spawn('general-purpose', `native task ${d}`))
  const ui = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  expect(await ui.find({ text: /native task one/ })).toBeDefined()
  expect(boxes(await ui.drawn()).filter(b => b.borderStyle !== undefined)).toEqual([])
  await ui.unmount()
})

test('in the native style values are plain text: the accent is for markers alone', async ($, on) => {
  engine(on)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  await $.turn.start({ text: 'go', turnId: 'NV1' })
  const ui = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  const texts = (node: unknown, out: { color: unknown; text: string }[] = []) => {
    if (node && typeof node === 'object') {
      const n = node as { type?: unknown; props?: Record<string, unknown>; children?: unknown[] }
      const own = (n.children ?? []).filter((c): c is string => typeof c === 'string').join('')
      if (n.type === 'Text' && own) out.push({ color: n.props?.color, text: own })
      for (const c of n.children ?? []) texts(c, out)
    }
    return out
  }
  const drawn = texts(await ui.drawn())
  expect(drawn.find(t => t.text === 'you')?.color).toBe('text')
  // The accent is left on markers and the working state alone.
  expect(drawn.filter(t => t.color === 'claude').every(t => /^(● ?|✦ |● working|◐ back to .*|—)$/.test(t.text))).toBe(true)
  await ui.unmount()
})

test('a background option fills the pane; a malformed one is ignored', { options: { background: '#191d27' } }, async ($, on) => {
  engine(on)
  const ui = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  expect(boxes(await ui.drawn())[0]?.backgroundColor).toBe('#191d27')
  await ui.unmount()
  expect([parseConfig({}).background, parseConfig({ background: 'navy' }).background]).toEqual([null, null])
})

test('Claude\'s tasks become the plan panel: a tree of their groups, the task in progress and its agents', async ($, on) => {
  engine(on)
  let n = 0
  on('tool.call', { tool: 'TaskCreate' }, e => ({ result: { task: { id: String(++n), subject: (e as unknown as { subject: string }).subject } }, text: 'ok' }) as never)
  on('tool.call', { tool: 'TaskUpdate' }, e => ({ result: { success: true, taskId: (e as unknown as { taskId: string }).taskId, updatedFields: ['status'] }, text: 'ok' }) as never)
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'pa1' }))
  await $.turn.start({ text: 'go', turnId: 'P1' })
  const create = (subject: string, group: string) => $.tool.call({ tool: 'TaskCreate', subject, description: subject, metadata: { group } } as never)
  await create('Pie legend', 'v1.2 / Reports')
  await create('Pie labels', 'v1.2 / Reports')
  await create('Release notes', 'v1.2 / Docs')
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress', activeForm: 'Placing pie labels' } as never)
  await $.agent.spawn(spawn('Explore', 'find label code'))
  const ui = await $.ui.mount({ ...pane(70), surface: 'terminal' })
  expect(await ui.find({ text: /\bPLAN\b/ })).toBeDefined()
  expect(await ui.find({ text: /1\/3 done/ })).toBeDefined()
  expect(await ui.find({ text: /33%/ })).toBeDefined()
  // The task in progress heads the panel with its agent; its group opens, the finished one is a line.
  // The task in progress turns in the spinner's own module, its label carried as a prop.
  expect(JSON.stringify(await ui.drawn())).toContain('Placing pie labels')
  expect(await ui.find({ text: /find label code/ })).toBeDefined()
  // Its kind beside it: the agent type and the model family.
  expect(await ui.find({ text: /Explore · haiku/ })).toBeDefined()
  expect(await ui.find({ text: /Reports/ })).toBeDefined()
  expect(await ui.find({ text: /Docs/ })).toBeDefined()
  // Finished: in the count, not the outline; the room left lists it under recently done.
  expect(await ui.find({ text: /\d+\/\d+ tasks/ })).toBeDefined()
  // The frame names the pane: the body no longer repeats it.
  expect(await ui.find({ text: /OS-Deck/ })).toBeUndefined()
  expect(await ui.find({ text: /recently done/ })).toBeDefined()
  expect(await ui.find({ text: /Pie legend/ })).toBeDefined()
  await ui.unmount()
  // Short of rows the room goes to open work and the log: no recently done.
  const short = await $.ui.mount({ ...pane(70), props: { ...pane(70).props, scroll: { offset: 0, bodyRows: 18 } }, viewport: { columns: 70, rows: 18 }, surface: 'terminal' } as never)
  expect(await short.find({ text: /recently done/ })).toBeUndefined()
  await short.unmount()
  // Inline above the prompt the plan is one line: its bar, the count and the task.
  const mini = await $.ui.mount({ ...pane(70), props: { ...pane(70).props, placement: 'inline' as const }, surface: 'terminal' })
  expect(await mini.find({ text: /· ▶ Placing pie labels/ })).toBeDefined()
  await mini.unmount()
})

test('a long plan in a short pane is cut to "+N more" and lists no finished work', async ($, on) => {
  engine(on)
  let n = 0
  on('tool.call', { tool: 'TaskCreate' }, e => ({ result: { task: { id: String(++n), subject: (e as unknown as { subject: string }).subject } }, text: 'ok' }) as never)
  on('tool.call', { tool: 'TaskUpdate' }, e => ({ result: { success: true, taskId: (e as unknown as { taskId: string }).taskId, updatedFields: ['status'] }, text: 'ok' }) as never)
  await $.turn.start({ text: 'go', turnId: 'LP1' })
  for (let i = 1; i <= 30; i++) await $.tool.call({ tool: 'TaskCreate', subject: `Step ${i}`, description: 'x', metadata: { group: 'v2 / Big' } } as never)
  for (let i = 1; i <= 10; i++) await $.tool.call({ tool: 'TaskUpdate', taskId: String(i), status: 'completed' } as never)
  const ui = await $.ui.mount({ ...pane(70), props: { ...pane(70).props, scroll: { offset: 0, bodyRows: 30 } }, viewport: { columns: 70, rows: 30 }, surface: 'terminal' } as never)
  expect(await ui.find({ text: /^\+\d+ more$/ })).toBeDefined()
  expect(await ui.find({ text: /recently done/ })).toBeUndefined()
  expect(await ui.find({ text: /session log/ })).toBeDefined()
  await ui.unmount()
})

test('with no tasks there is no plan panel; the prompt asks for group paths only where TaskCreate is offered', { options: { view: 'classic' } }, async ($, on) => {
  engine(on)
  on('prompt.compose', () => ({ sections: [{ id: 'core', text: 'core', scope: 'shared' as const }] }))
  const ui = await $.ui.mount({ ...pane(70), surface: 'terminal' })
  expect(await ui.find({ text: /\bPLAN\b/ })).toBeUndefined()
  await ui.unmount()
  const base = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'] as const, outputStyle: null, traits: [] }
  const withTasks = await $.prompt.compose({ ...base, tools: ['TaskCreate', 'Read'] } as never)
  const without = await $.prompt.compose({ ...base, tools: ['Read'] } as never)
  expect(withTasks.sections.map(x => x.id)).toEqual(['core', 'flightdeck:plan-groups'])
  expect(without.sections.map(x => x.id)).toEqual(['core'])
})

test('an update can clear a group and block other tasks; the cap drops finished tasks first', () => {
  let p = planCreate(DEFAULT_PLAN, { id: '1', subject: 'A', activeForm: '', group: ['v1'] })
  p = planCreate(p, { id: '2', subject: 'B', activeForm: '', group: ['v1'] })
  p = planUpdate(p, { taskId: '1', group: [] }, 1)
  p = planUpdate(p, { taskId: '1', addBlocks: ['2'] }, 1)
  p = planUpdate(p, { taskId: '2', subject: 'B2' }, 1) // no group named: kept
  expect([p.tasks[0]?.group, p.tasks[1]?.group, p.tasks[1]?.blockedBy]).toEqual([[], ['v1'], ['1']])
  let big = planCreate(DEFAULT_PLAN, { id: 'open', subject: 'still open', activeForm: '' })
  for (let i = 0; i < 85; i++) big = planUpdate(planCreate(big, { id: `d${i}`, subject: `d${i}`, activeForm: '' }), { taskId: `d${i}`, status: 'completed' }, i)
  expect(big.tasks.length).toBe(80)
  expect(big.tasks.some(t => t.id === 'open')).toBe(true)
})

test('the current task is the one started last, for the header and the agent links alike', () => {
  let p = planCreate(planCreate(DEFAULT_PLAN, { id: '1', subject: 'A', activeForm: '' }), { id: '2', subject: 'B', activeForm: '' })
  p = planUpdate(planUpdate(p, { taskId: '2', status: 'in_progress' }, 5), { taskId: '1', status: 'in_progress' }, 9)
  expect(planCurrent(p.tasks)?.id).toBe('1')
  expect(planLinkAgent(p, 'x').tasks.find(t => t.id === '1')?.agents).toEqual(['x'])
})

test('a subagent\'s own todo list stays out of the plan; a failed update changes nothing', { options: { view: 'classic' } }, async ($, on) => {
  engine(on)
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: { oldTodos: [], newTodos: [] }, text: 'ok' }) as never)
  on('tool.call', { tool: 'TaskCreate' }, () => ({ result: { task: { id: '7', subject: 'Seven' } }, text: 'ok' }) as never)
  on('tool.call', { tool: 'TaskUpdate' }, () => ({ result: { success: false, taskId: '7', updatedFields: [], error: 'nope' }, text: 'no' }) as never)
  await $.turn.start({ text: 'go', turnId: 'S1' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'main step', status: 'in_progress', activeForm: 'Stepping' }] } as never)
  await $.tool.call({ tool: 'TodoWrite', agentId: 'sub1', todos: [{ content: 'sub step', status: 'pending', activeForm: 'x' }] } as never)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Seven', description: 'Seven' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '7', status: 'completed' } as never)
  const ui = await $.ui.mount({ ...pane(70), surface: 'terminal' })
  expect(await ui.find({ text: /main step/ })).toBeDefined()
  expect(await ui.find({ text: /sub step/ })).toBeUndefined()
  expect(await ui.find({ text: /0\/2 done/ })).toBeDefined()
  await ui.unmount()
})

test('without the plan panel the prompt carries no group hint', { options: { panels: 'main,gate,log' } }, async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'core', text: 'core', scope: 'shared' as const }] }))
  const base = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'] as const, outputStyle: null, traits: [] }
  const out = await $.prompt.compose({ ...base, tools: ['TaskCreate'] } as never)
  expect(out.sections.map(x => x.id)).toEqual(['core'])
})

test('/flightdeck demo fills the plan panel with a sample plan', async ($, on) => {
  engine(on)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  await $.command.run({ command: 'flightdeck', args: 'demo', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  const ui = await $.ui.mount({ ...pane(66), surface: 'terminal' })
  expect(await ui.find({ text: /\bPLAN\b/ })).toBeDefined()
  expect(await ui.find({ text: /3\/8 done/ })).toBeDefined()
  expect(await ui.find({ text: /Pie chart labels/ })).toBeDefined()
  await ui.unmount()
})

test('the plan view: a header, each task with its subagents nested beneath, the rest outside the plan, the log at the foot', async ($, on) => {
  engine(on)
  let n = 0
  let ag = 0
  on('tool.call', { tool: 'TaskCreate' }, e => ({ result: { task: { id: String(++n), subject: (e as unknown as { subject: string }).subject } }, text: 'ok' }) as never)
  on('tool.call', { tool: 'TaskUpdate' }, e => ({ result: { success: true, taskId: (e as unknown as { taskId: string }).taskId, updatedFields: ['status'] }, text: 'ok' }) as never)
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: `pv${++ag}` }))
  await $.turn.start({ text: 'go', turnId: 'PV1' })
  await $.agent.spawn(spawn('general-purpose', 'unplanned look around'))
  await $.tool.call({ tool: 'TaskCreate', subject: 'Pie labels', description: 'x', metadata: { group: 'v1.2 / Reports' } } as never)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Release notes', description: 'x', metadata: { group: 'v1.2 / Docs' } } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' } as never)
  await $.agent.spawn(spawn('Explore', 'find label code'))
  const ui = await $.ui.mount({ ...pane(70), surface: 'terminal' })
  const drawn = JSON.stringify(await ui.drawn())
  // Header: model and context; no legend, no separate main/gate/architect panels.
  expect(await ui.find({ text: /Opus|Sonnet|—/ })).toBeDefined()
  expect(await ui.find({ text: /^ctx $/ })).toBeDefined()
  expect(await ui.find({ text: /permissions/ })).toBeUndefined()
  // The plan: the task in progress turns, its subagent nested under it; the other one outside the plan.
  expect(drawn).toContain('Pie labels')
  expect(await ui.find({ text: /find label code/ })).toBeDefined()
  expect(await ui.find({ text: /outside the plan/ })).toBeDefined()
  expect(await ui.find({ text: /unplanned look around/ })).toBeDefined()
  expect(await ui.find({ text: /session log/ })).toBeDefined()
  await ui.unmount()
})

test('the plan view with nothing yet says so, and a subagent hotkey still opens its detail', async ($, on) => {
  engine(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'hk1' }))
  let ui = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  expect(await ui.find({ text: /no tasks or subagents yet/ })).toBeDefined()
  await ui.unmount()
  await $.turn.start({ text: 'go', turnId: 'HK1' })
  await $.agent.spawn(spawn('Explore', 'map the tests'))
  ui = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  await ui.press({ key: 'card-hk1' })
  await ui.unmount()
  ui = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  expect(await ui.find({ text: /no tool calls yet/ })).toBeDefined()
  await ui.unmount()
})

test('a stored plan of the wrong shape reads as tasks with safe fields, never a broken render', () => {
  const p = normalizePlan({ tasks: [{ id: 'a', group: null, blockedBy: 'x', status: 'weird', agents: [1, 'ag'] }, { subject: 'no id' }, 'junk'] })
  expect(p.tasks).toEqual([
    { id: 'a', subject: '', activeForm: '', status: 'pending', group: [], blockedBy: [], agents: ['ag'], startedAt: null, doneAt: null, source: 'task' },
  ])
  expect(planTree(p.tasks).total).toBe(1)
})

// The session nouns the plan's glue reads, answered beneath the plugin.
const planWorld = (on: On, messages: unknown[] = []) => {
  const toasts: string[] = []
  const db = new Map<string, unknown>()
  on('store.get', (_$, e) => ({ value: db.get((e as unknown as { key: string }).key) }) as never)
  on('store.set', (_$, e) => {
    const x = e as unknown as { key: string; value: unknown }
    db.set(x.key, JSON.parse(JSON.stringify(x.value)))
    return { value: undefined } as never
  })
  on('session.id', () => ({ value: 'S1' }) as never)
  on('session.cwd', () => ({ value: '/proj' }) as never)
  on('session.messages', () => ({ value: messages }) as never)
  on('ui.toast', (_$, e) => {
    toasts.push((e as unknown as { text: string }).text)
    return { value: undefined } as never
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  return { toasts, db }
}

const taskTools = (on: On) => {
  let n = 0
  on('tool.call', { tool: 'TaskCreate' }, e => ({ result: { task: { id: String(++n), subject: (e as unknown as { subject: string }).subject } }, text: 'ok' }) as never)
  on('tool.call', { tool: 'TaskUpdate' }, e => ({ result: { success: true, taskId: (e as unknown as { taskId: string }).taskId, updatedFields: ['status'] }, text: 'ok' }) as never)
}

test('a resumed session rebuilds its plan from the transcript, groups included, with no made-up times', async ($, on) => {
  engine(on)
  planWorld(on, [
    {
      role: 'assistant',
      text: '',
      toolUses: [
        { tool_use_id: 'u1', tool: 'TaskCreate', input: { subject: 'Old one', description: 'x', metadata: { group: 'v1 / API' } }, result: { task: { id: '1', subject: 'Old one' } } },
        { tool_use_id: 'u2', tool: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' }, result: { success: true, taskId: '1', updatedFields: ['status'] } },
        { tool_use_id: 'u3', tool: 'TaskCreate', input: { subject: 'Failed one', description: 'x' }, isError: true },
      ],
    },
  ])
  await $.session.start({ source: 'resume' } as never).catch(() => undefined)
  const ui = await $.ui.mount({ ...pane(70), surface: 'terminal' })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('Old one')
  expect(drawn).not.toContain('Failed one')
  expect(await ui.find({ text: /API/ })).toBeDefined()
  await ui.unmount()
})

test('a subagent that takes a task up moves under it; a group finishing raises a toast and is kept for later sessions', async ($, on) => {
  engine(on)
  const { toasts, db } = planWorld(on)
  taskTools(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'w1' }))
  await $.turn.start({ text: 'go', turnId: 'L1' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Schema', description: 'x', metadata: { group: 'v1 / API' } } as never)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Endpoint', description: 'x', metadata: { group: 'v1 / API' } } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' } as never)
  await $.agent.spawn(spawn('general-purpose', 'endpoint worker'))
  // The worker takes task 2 up itself: it moves from task 1 to task 2.
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress', agentId: 'w1' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as never)
  const ui = await $.ui.mount({ ...pane(70), surface: 'terminal' })
  const rows = JSON.stringify(await ui.drawn())
  expect(rows.indexOf('endpoint worker')).toBeGreaterThan(rows.indexOf('Endpoint'))
  await ui.unmount()
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'completed', agentId: 'w1' } as never)
  expect(toasts).toEqual(['✓ v1 / API done'])
  const stored = db.get('plan-history:/proj') as Record<string, { done: Record<string, number> }>
  expect(stored.S1?.done).toEqual({ v1: 2, 'v1 / API': 2 })
})

test('an approved plan names the groups the prompt asks for', async ($, on) => {
  engine(on)
  planWorld(on)
  on('prompt.compose', () => ({ sections: [{ id: 'core', text: 'core', scope: 'shared' as const }] }))
  on('tool.call', { tool: 'ExitPlanMode' }, () => ({ result: { plan: '# P\n## Schema\n## API\n## UI', isAgent: false }, text: 'ok' }) as never)
  await $.tool.call({ tool: 'ExitPlanMode' } as never)
  const base = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'] as const, outputStyle: null, traits: [] }
  const out = await $.prompt.compose({ ...base, tools: ['TaskCreate'] } as never)
  expect(out.sections.find(x => x.id === 'flightdeck:plan-groups')?.text).toContain('"Schema", "API", "UI"')
})

test('the keyboard opens another group and lists finished tasks', async ($, on) => {
  engine(on)
  planWorld(on)
  taskTools(on)
  await $.turn.start({ text: 'go', turnId: 'K1' })
  for (const [subject, group] of [['Schema', 'API'], ['Endpoint', 'API'], ['Button', 'UI']]) {
    await $.tool.call({ tool: 'TaskCreate', subject, description: 'x', metadata: { group } } as never)
  }
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '3', status: 'in_progress' } as never)
  let ui = await $.ui.mount({ ...pane(70), surface: 'terminal' })
  expect(JSON.stringify(await ui.drawn())).not.toContain('Endpoint')
  await ui.press({ key: 'plan-group-API' })
  await ui.press({ key: 'plan-done' })
  await ui.unmount()
  ui = await $.ui.mount({ ...pane(70), surface: 'terminal' })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('Endpoint')
  expect(drawn).toContain('Schema')
  await ui.unmount()
})

test('history counts only what this session finished: tasks replayed from the transcript are not counted again', () => {
  let p = planApply(DEFAULT_PLAN, 'TaskCreate', { subject: 'old', metadata: { group: 'v1' } }, { task: { id: '1' } }, null)
  p = planApply(p, 'TaskUpdate', { taskId: '1', status: 'completed' }, { success: true }, null)
  p = planApply(p, 'TaskCreate', { subject: 'new', metadata: { group: 'v1' } }, { task: { id: '2' } }, 5)
  p = planApply(p, 'TaskUpdate', { taskId: '2', status: 'completed' }, { success: true }, 9)
  expect(doneByPath(p.tasks)).toEqual({ v1: 1 })
  // A refused update and an unknown tool change nothing; ExitPlanMode reads the plan from its input.
  expect(planApply(p, 'TaskUpdate', { taskId: '2', status: 'pending' }, { success: false }, 10)).toBe(p)
  expect(planApply(p, 'Read', {}, {}, 10)).toBe(p)
  expect(planApply(p, 'ExitPlanMode', { plan: '## A\n## B' }, {}, 10).groups).toEqual(['A', 'B'])
})

test('a group line in a narrow pane with every suffix still fits on one line', async ($, on) => {
  engine(on)
  taskTools(on)
  await $.turn.start({ text: 'go', turnId: 'N1' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'x', metadata: { group: 'A very long version name / An even longer epic name here' } } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' } as never)
  const ui = await $.ui.mount({ ...pane(40), surface: 'terminal' })
  const label = JSON.stringify(await ui.drawn()).match(/An even[^"]*/)?.[0] ?? ''
  expect(label.length).toBeLessThanOrEqual(40)
  await ui.unmount()
})

test('jira: an issue the person cites and Claude reads anchors the plan, its subtasks as placeholders, the prompt told', async ($, on) => {
  engine(on)
  planWorld(on)
  on('prompt.submit', (_$, e) => ({ text: (e as unknown as { text: string }).text }) as never)
  on('prompt.compose', () => ({ sections: [{ id: 'core', text: 'core', scope: 'shared' as const }] }))
  on('tool.call', { tool: 'mcp__atlassian__getJiraIssue' }, () => ({ result: { content: [{ type: 'text', text: JSON.stringify(STORY) }] }, text: 'ok' }) as never)
  // An issue nobody cited does not anchor anything.
  await $.tool.call({ tool: 'mcp__atlassian__getJiraIssue', cloudId: 'acme.atlassian.net', issueIdOrKey: 'ABC-363' } as never)
  let ui = await $.ui.mount({ ...pane(70), surface: 'terminal' })
  expect(JSON.stringify(await ui.drawn())).not.toContain('ABC-363')
  await ui.unmount()
  await $.prompt.submit({ text: 'vamos fazer a ABC-363' } as never).catch(() => undefined)
  await $.tool.call({ tool: 'mcp__atlassian__getJiraIssue', cloudId: 'acme.atlassian.net', issueIdOrKey: 'ABC-363' } as never)
  ui = await $.ui.mount({ ...pane(70), surface: 'terminal' })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('https://acme.atlassian.net/browse/ABC-363')
  expect(drawn).toContain('Em andamento')
  expect(drawn).toContain('ABC-407 Integrar a consulta - tratar estados')
  expect(drawn).toContain('1/2')
  await ui.unmount()
  const base = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'] as const, outputStyle: null, traits: [] }
  const out = await $.prompt.compose({ ...base, tools: ['TaskCreate'] } as never)
  expect(out.sections.find(x => x.id === 'flightdeck:plan-groups')?.text).toContain('anchored to Jira ABC-363')
})

test('git status reads branch, upstream distance and files by state', () => {
  const r = { name: 'web', branch: 'feat/x', ahead: 2, behind: 1, base: null, baseAhead: 0, baseBehind: 0, staged: 2, untracked: 1, conflicts: 1 }
  expect(pickBase('origin/HEAD\norigin/main\norigin/dev\n')).toBe('origin/dev')
  expect(pickBase('origin/feat\n')).toBeNull()
  expect(parseAheadBehind('87\t3\n')).toEqual({ behind: 87, ahead: 3 })
  expect(parseAheadBehind('')).toBeNull()
  const clean = { ...r, name: 'api', branch: 'dev', ahead: 0, behind: 0, staged: 0, untracked: 0, conflicts: 0 }
  expect(sortRepos([clean, r]).map(x => x.name)).toEqual(['web', 'api'])
})

test('a workspace of several repositories shows a git row for each, feature branches against origin/dev', async ($, on) => {
  engine(on)
  on('session.cwd', () => ({ value: '/ws' }) as never)
  on('fs.list', () => ({ value: [{ name: 'api', kind: 'dir' }, { name: 'web', kind: 'dir' }, { name: 'notes.md', kind: 'file' }, { name: '.cache', kind: 'dir' }] }) as never)
  on('fs.exists', (_$, e) => ({ value: /[\\/](api|web)[\\/]\.git$/.test((e as unknown as { path: string }).path) }) as never)
  const calls: string[] = []
  on('process.run', (_$, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    calls.push(argv.join(' '))
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } }) as never
    if (argv.includes('rev-parse')) return { value: { exitCode: 128, stdout: '', stderr: 'not a git repository' } } as never
    if (argv.includes('symbolic-ref')) return ok(argv.includes('/ws/web') ? 'refs/heads/feat/pie\n' : 'refs/heads/dev\n')
    if (argv.includes('diff-index') && argv.includes('/ws/web')) return ok('x.ts\0')
    if (argv.includes('@{upstream}...HEAD') && argv.includes('/ws/api')) return ok('5\t0')
    if (argv.includes('for-each-ref')) return ok('origin/HEAD\norigin/main\norigin/dev')
    if (argv.includes('rev-list')) return argv.includes('origin/dev...HEAD') ? ok('87\t3') : ({ value: { exitCode: 128, stdout: '', stderr: '' } } as never)
    return ok('')
  })
  await $.turn.start({ text: 'go', turnId: 'G1' })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'G1', reason: 'answer' } as never)
  const ui = await $.ui.mount({ ...pane(70), surface: 'terminal' })
  let row: unknown
  for (let i = 0; i < 50 && !row; i++) {
    await new Promise(r => setTimeout(r, 5))
    row = await ui.find({ text: /feat\/pie/ })
  }
  expect(row).toBeDefined()
  expect(await ui.find({ text: /↑3/ })).toBeDefined()
  expect(await ui.find({ text: /↓87/ })).toBeDefined()
  expect(await ui.find({ text: /\+1/ })).toBeDefined()
  expect(await ui.find({ text: /⇣5/ })).toBeDefined()
  // Modified files are not read, so nothing may be called clean.
  expect(await ui.find({ text: /clean/ })).toBeUndefined()
  // No git call may take the index lock the person's own commands need.
  expect(calls.length).toBeGreaterThan(0)
  expect(calls.every(c => c.startsWith('git --no-optional-locks '))).toBe(true)
  await ui.unmount()
})

test('by default the prompt asks for every multi-step job as tasks filed by phase; the hint policy only asks for groups', async ($, on) => {
  engine(on)
  on('prompt.compose', () => ({ sections: [{ id: 'core', text: 'core', scope: 'shared' as const }] }))
  const base = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'] as const, outputStyle: null, traits: [] }
  const out = await $.prompt.compose({ ...base, tools: ['TaskCreate'] } as never)
  const text = out.sections.find(x => x.id === 'flightdeck:plan-groups')?.text ?? ''
  expect(text).toContain('Break any work of two steps or more into tasks')
  expect(text).toContain('"Plano", "Implementação", "Qualidade"')
})

test('the hint policy keeps the old ask, phases are read leniently', { options: { planPolicy: 'hint' } }, async ($, on) => {
  engine(on)
  on('prompt.compose', () => ({ sections: [] }))
  const base = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'] as const, outputStyle: null, traits: [] }
  const out = await $.prompt.compose({ ...base, tools: ['TaskCreate'] } as never)
  expect(out.sections[0]?.text).toContain('Do not create tasks or invent structure')
  expect(parseConfig({ planPhases: ' Spec , Build ,, ' }).planPhases).toEqual(['Spec', 'Build'])
  expect(parseConfig({ planPhases: '' }).planPhases).toEqual(['Plano', 'Implementação', 'Qualidade'])
})

test('the classic view has no git panel: the session log is drawn once', { options: { view: 'classic' } }, async ($, on) => {
  engine(on)
  await $.turn.start({ text: 'go', turnId: 'CL1' })
  const ui = await $.ui.mount({ ...pane(64), surface: 'terminal' })
  const text = JSON.stringify(await ui.drawn())
  expect(text.split('session log').length - 1).toBe(1)
  await ui.unmount()
})

test('sections: names read leniently, a stored list keeps only known ones', () => {
  expect([deckSectionOf('Git'), deckSectionOf('session'), deckSectionOf('cabeçalho'), deckSectionOf('nope')]).toEqual(['git', 'log', 'header', null])
  expect(hiddenOf(['git', 'git', 'bogus', 3, 'log'])).toEqual(['git', 'log'])
})

test('/os-deck hide drops a section from the plan view, keeps it hidden after a reset, and show brings it back', async ($, on) => {
  const { db } = planWorld(on)
  engine(on)
  const run = (args: string) => $.command.run({ command: 'os-deck', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  await $.turn.start({ text: 'go', turnId: 'HS1' })
  let ui = await $.ui.mount({ ...pane(70), surface: 'terminal' })
  expect(await ui.find({ text: /session log/ })).toBeDefined()
  expect(await ui.find({ text: /\bPLAN\b/ })).toBeDefined()
  await ui.unmount()
  const said = await run('hide log')
  expect(JSON.stringify(said)).toContain('log hidden')
  await run('hide plan')
  await run('hide header')
  await run('reset')
  ui = await $.ui.mount({ ...pane(70), surface: 'terminal' })
  expect(await ui.find({ text: /session log/ })).toBeUndefined()
  expect(await ui.find({ text: /\bPLAN\b/ })).toBeUndefined()
  expect(await ui.find({ text: /^ctx $/ })).toBeUndefined()
  await ui.unmount()
  expect(db.get('os-deck:hidden')).toEqual(['log', 'plan', 'header'])
  await run('show log')
  ui = await $.ui.mount({ ...pane(70), surface: 'terminal' })
  expect(await ui.find({ text: /session log/ })).toBeDefined()
  await ui.unmount()
  expect(JSON.stringify(await run('hide nothing'))).toContain('Usage')
})

test('a hidden plan gives its rows to the log; hidden title and git are left out', async ($, on) => {
  planWorld(on)
  engine(on)
  const run = (args: string) => $.command.run({ command: 'os-deck', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  on('tool.call', { tool: 'Edit' }, () => ({ result: 'ok', text: 'ok' }) as never)
  await $.turn.start({ text: 'go', turnId: 'HS2' })
  for (let i = 0; i < 40; i++) await $.tool.call({ tool: 'Edit', file_path: `/p/f${i}.ts`, old_string: 'a', new_string: 'b' } as never)
  const mount = () => $.ui.mount({ ...pane(70), props: { ...pane(70).props, scroll: { offset: 0, bodyRows: 40 } }, viewport: { columns: 70, rows: 40 }, surface: 'terminal' } as never)
  const logRows = async () => {
    const ui = await mount()
    const n = (JSON.stringify(await ui.drawn()).match(/f\d+\.ts/g) ?? []).length
    await ui.unmount()
    return n
  }
  const withPlan = await logRows()
  await run('hide plan')
  const withoutPlan = await logRows()
  expect(withoutPlan).toBeGreaterThan(withPlan)
  await run('hide title')
  const ui = await mount()
  expect(await ui.find({ text: /\d+\/\d+ tasks/ })).toBeUndefined()
  await ui.unmount()
})

test('epic helpers: the parent key of a JQL, a search result in any shape, children in reading order', () => {
  expect([jqlParentKey('parent = ABC-300 ORDER BY rank'), jqlParentKey('"Epic Link" = abc-300'), jqlParentKey('project = ABC')]).toEqual(['ABC-300', 'ABC-300', null])
  // A filtered search lists only some children: not the epic.
  expect([jqlParentKey('parent = ABC-300 AND status != Done'), jqlParentKey('parent in (ABC-300, ABC-301)')]).toEqual([null, null])
  const issue = (key: string, done: boolean, who = '') => ({ key, fields: { summary: key, issuetype: { name: 'História' }, status: jiraStatus(done ? 'Pronto' : 'A fazer', done ? 'done' : 'new'), assignee: who ? { displayName: who } : null } })
  const raw = { issues: [issue('ABC-301', true, 'Ana Lima'), issue('ABC-363', false), issue('ABC-410', false)] }
  expect(jiraSearchOf({ content: [{ type: 'text', text: JSON.stringify(raw) }] }).map(c => c.key)).toEqual(['ABC-301', 'ABC-363', 'ABC-410'])
  expect(jiraSearchOf(raw)[0]?.assignee).toBe('Ana Lima')
  expect(jiraSearchOf('not json')).toBeNull()
  expect(jiraSearchOf({ issues: [] })).toEqual([])
})

test('timeline: bars on one axis from the first start to now, running ones reach now', () => {
  const { t0, rows } = timelineRows(
    [
      { id: 'a', label: 'a', kind: 'task', start: 1000, end: 2000 },
      { id: 'b', label: 'b', kind: 'agent', start: 1500, end: null },
    ],
    3000,
    20,
    6,
  )
  expect(t0).toBe(1000)
  expect(rows.map(r => [r.pre, r.bar, r.post])).toEqual([
    [0, 11, 9],
    [5, 15, 0],
  ])
  expect(rows.every(r => r.pre + r.bar + r.post === 20)).toBe(true)
})

test('the epic section heads with the epic, lists its children once Claude searched for them, the anchored issue first', async ($, on) => {
  planWorld(on)
  engine(on)
  on('prompt.submit', (_$, e) => ({ text: (e as unknown as { text: string }).text }) as never)
  on('tool.call', { tool: 'mcp__atlassian__getJiraIssue' }, () => ({ result: { content: [{ type: 'text', text: JSON.stringify(STORY) }] }, text: 'ok' }) as never)
  const issue = (key: string, summary: string, done: boolean, who = '') => ({ key, fields: { summary, issuetype: { name: 'História' }, status: jiraStatus(done ? 'Pronto' : 'A fazer', done ? 'done' : 'new'), assignee: who ? { displayName: who } : null } })
  const children = { issues: [issue('ABC-301', 'Cadastro de contratos', true, 'Ana Lima'), issue('ABC-363', 'Permitir a consulta dos contratos', false, 'dev.one'), issue('ABC-410', 'Exportar contratos', false)] }
  on('tool.call', { tool: 'mcp__atlassian__searchJiraIssuesUsingJql' }, () => ({ result: { content: [{ type: 'text', text: JSON.stringify(children) }] }, text: 'ok' }) as never)
  await $.prompt.submit({ text: 'vamos fazer a ABC-363' } as never).catch(() => undefined)
  await $.tool.call({ tool: 'mcp__atlassian__getJiraIssue', cloudId: 'acme.atlassian.net', issueIdOrKey: 'ABC-363' } as never)
  let ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await ui.find({ text: /^ABC-300$/ })).toBeDefined()
  expect(await ui.find({ text: /\/os-deck epic/ })).toBeDefined()
  await ui.unmount()
  // A search for another epic's children changes nothing.
  await $.tool.call({ tool: 'mcp__atlassian__searchJiraIssuesUsingJql', cloudId: 'acme.atlassian.net', jql: 'parent = ABC-999' } as never)
  await $.tool.call({ tool: 'mcp__atlassian__searchJiraIssuesUsingJql', cloudId: 'acme.atlassian.net', jql: 'parent = ABC-300 ORDER BY rank' } as never)
  ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('Exportar contratos')
  expect(drawn).toContain(' 1/3')
  expect(drawn).toContain('· Ana')
  expect(drawn.indexOf('ABC-363 ')).toBeLessThan(drawn.indexOf('ABC-410 '))
  expect(drawn.indexOf('ABC-410 ')).toBeLessThan(drawn.indexOf('ABC-301 '))
  expect(await ui.find({ text: /\/os-deck epic/ })).toBeUndefined()
  await ui.unmount()
})

test('the timeline shows tasks and agents side by side once two have started', async ($, on) => {
  engine(on)
  let n = 0
  on('tool.call', { tool: 'TaskCreate' }, e => ({ result: { task: { id: String(++n), subject: (e as unknown as { subject: string }).subject } }, text: 'ok' }) as never)
  on('tool.call', { tool: 'TaskUpdate' }, e => ({ result: { success: true, taskId: (e as unknown as { taskId: string }).taskId, updatedFields: ['status'] }, text: 'ok' }) as never)
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'tl1' }))
  await $.turn.start({ text: 'go', turnId: 'TL1' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Map the pie code', description: 'x' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' } as never)
  await $.agent.spawn(spawn('Explore', 'find pie labels'))
  const ui = await $.ui.mount({ ...pane(70), surface: 'terminal' })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('"timeline"')
  expect(drawn).toContain('Map the pie code')
  expect(drawn).toContain('━')
  expect(drawn).toMatch(/now"/)
  await ui.unmount()
})

test('agent kinds: by type, running first, with models and the typical time of the finished', () => {
  const card = (id: string, type: string, status: string, start: number, end: number | null, model = 'claude-haiku-4-5') => ({ ...normalizeCard({}), id, type, status, spawnedAt: start, endedAt: end, model })
  const kinds = agentKinds([card('1', 'Explore', 'done', 0, 60_000), card('2', 'Explore', 'done', 0, 120_000), card('3', 'general-purpose', 'running', 0, null, 'claude-opus-5-5'), card('4', 'Explore', 'failed', 0, 30_000)], 200_000)
  expect(kinds.map(k => [k.type, k.total, k.running, k.failed])).toEqual([
    ['general-purpose', 1, 1, 0],
    ['Explore', 3, 0, 1],
  ])
  expect(kinds[1]?.avgMs).toBe(70_000)
  expect(kinds[0]?.avgMs).toBeNull()
})

test('the plan view has an architect section with each consult, what it was about and its advice, and an agents section by type', async ($, on) => {
  engine(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: `ag${++n}` }))
  await $.turn.start({ text: 'go', turnId: 'AR1' })
  await $.agent.spawn(spawn('Explore', 'map the pie code'))
  await $.agent.spawn(spawn('Explore', 'find label tests'))
  await $.agent.spawn(spawn('general-purpose', 'write the parser'))
  await $.agent.spawn(spawn('architect', 'review the chart plan'))
  let ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  let drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('review the chart plan')
  expect(drawn).toContain('architect · advising')
  await ui.unmount()
  await $.turn.complete({ answer: 'Ship it after splitting the parser into two modules.', durationMs: 10, isAborted: false, turnId: 'AR1', agentId: 'ag4', reason: 'answer' } as never)
  ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('ARCHITECT · on call')
  expect(drawn).toContain('» Ship it after splitting the parser')
  expect(drawn).toContain('1 consult')
  // The header leaves the architect to its section.
  expect(drawn).not.toContain('architect 1×')
  // Agents by type, the architect not among them.
  expect(await ui.find({ text: /^Explore$/ })).toBeDefined()
  expect(drawn).toContain('3 running · 0 done')
  expect(drawn).toContain('▰▰')
  await ui.unmount()
})

test('a consult keeps the advice it handed back over its closing answer, and a repeated advice still lands on its consult', () => {
  let a = startConsult(DEFAULT_ARCHITECT, { id: 'k1', at: 0, moment: 'before done', via: 'architect', about: 'review' })
  a = adviseConsult(a, 'k1', 'Fix the lock first.')
  a = endConsult(a, 10, '[envelope] something else', 'k1')
  expect(a.consults[0]?.advice).toBe('Fix the lock first.')
  expect(a.consults[0]?.about).toBe('review')
  a = startConsult(a, { id: 'k2', at: 20, moment: 'before done', via: 'architect' })
  a = adviseConsult(a, 'k2', 'Fix the lock first.')
  expect(a.consults[1]?.advice).toBe('Fix the lock first.')
})

// ---------------------------------------------------------------- account (cswap)

const cswapList = (active: number, pcts: Record<number, number> = {}) =>
  JSON.stringify({
    schemaVersion: 1,
    activeAccountNumber: active,
    accounts: [1, 2].map(n => ({
      number: n,
      email: `dev${n}@example.com`,
      organizationName: `Org ${n}`,
      active: n === active,
      usage: { fiveHour: { pct: pcts[n] ?? 10 * n, resetsAt: '2030-01-01T05:00:00+00:00' }, sevenDay: { pct: 40, resetsAt: '2030-01-04T00:00:00+00:00' } },
    })),
  })

/** cswap on the test's PATH: `list --json` answers with the active account, `switch` moves it. */
const cswapWorld = (on: On, start = 1) => {
  const world = { active: start, calls: [] as string[][] }
  on('process.run', (_$, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    world.calls.push(argv)
    const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '' } }) as never
    if (argv[0] !== 'cswap') return ok('', 128)
    if (argv[1] === 'list') return ok(cswapList(world.active))
    if (argv[1] === 'switch') {
      const target = argv[2] === '--json' ? String(world.active === 1 ? 2 : 1) : argv[2]
      if (target !== '1' && target !== '2') return ok(JSON.stringify({ schemaVersion: 1, error: { type: 'AccountNotFoundError', message: `No account found with identifier: ${target}` } }), 1)
      const from = world.active
      world.active = Number(target)
      return ok(JSON.stringify({ schemaVersion: 1, switched: from !== world.active, from: { number: from, email: `dev${from}@example.com` }, to: { number: world.active, email: `dev${world.active}@example.com` }, reason: 'direct', message: `Switched to Account-${world.active} (dev${world.active}@example.com)`, warnings: [] }))
    }
    return ok('', 2)
  })
  return world
}

const START = { source: 'startup', cwd: '/proj', surface: 'terminal', isInteractive: true } as never
const measured = (on: On) => on('session.measure', (_$, e) => ({ changed: e.changed }))
const drawnText = async ($: Parameters<TestBody>[0]) => {
  const ui = await $.ui.mount({ ...pane(70), surface: 'terminal' })
  const text = JSON.stringify(await ui.drawn())
  await ui.unmount()
  return text
}

test('cswap: its list and switch answers are read leniently, a switch target never reads as an option', () => {
  const xs = parseCswapList(cswapList(2))
  expect(xs?.map(x => [x.number, x.email, x.isActive])).toEqual([[1, 'dev1@example.com', false], [2, 'dev2@example.com', true]])
  expect(xs?.[1]?.limits[0]).toEqual({ kind: 'five_hour', pct: 20, resetsAt: Date.parse('2030-01-01T05:00:00+00:00') })
  expect(parseCswapList('not json')).toBeNull()
  expect(parseCswapList('{"accounts": [{"number": "x"}]}')).toEqual([])
  expect(parseCswapSwitch('{"switched": true, "to": {"email": "a@b.co"}, "message": "Switched"}')).toEqual({ isSwitched: true, to: 'a@b.co', message: 'Switched' })
  expect(parseCswapSwitch('{"error": {"type": "X", "message": "nope"}}')).toEqual({ isSwitched: false, to: null, message: 'nope' })
  expect(parseCswapSwitch('usage: cswap ...')).toBeNull()
  expect([switchTargetOf(''), switchTargetOf('next'), switchTargetOf('2'), switchTargetOf('dev@example.com'), switchTargetOf('work')]).toEqual([
    { target: null },
    { target: null },
    { target: '2' },
    { target: 'dev@example.com' },
    { target: 'work' },
  ])
  expect([switchTargetOf('--force'), switchTargetOf('-x@y.co'), switchTargetOf('a b'), switchTargetOf('a;b'), switchTargetOf('x'.repeat(40))]).toEqual([null, null, null, null, null])
})

test('cswap: the session limits win; cswap stands in while there are none or a switch is fresh', () => {
  const own = [{ kind: 'five_hour', pct: 55, resetsAt: null }]
  const acc = { ...DEFAULT_ACCOUNT, status: 'ok' as const, accounts: parseCswapList(cswapList(1)) ?? [] }
  expect(shownLimits(own, acc, 1000)).toEqual({ limits: own, isCswap: false })
  expect(shownLimits([], acc, 1000).isCswap).toBe(true)
  expect(shownLimits(own, { ...acc, switchedAt: 1000 }, 1000 + SWITCH_HOLD_MS - 1).isCswap).toBe(true)
  expect(shownLimits(own, { ...acc, switchedAt: 1000 }, 1000 + SWITCH_HOLD_MS)).toEqual({ limits: own, isCswap: false })
  // No cswap reading to stand in: a fresh switch shows no limits rather than the old account's.
  expect(shownLimits(own, { ...DEFAULT_ACCOUNT, switchedAt: 1000 }, 1001)).toEqual({ limits: [], isCswap: false })
})

test('/os-deck account switches through cswap by argv, drops the old limits and holds measurements off for the Keychain window', async ($, on) => {
  const clock = engine(on)
  planWorld(on)
  measured(on)
  const world = cswapWorld(on, 1)
  await $.session.start(START).catch(() => undefined)
  await clock.advance(10)
  expect(await drawnText($)).toContain('dev1@example.com')
  const measure = (pct: number) =>
    $.session.measure({ context: { percent: 10, tokens: 1000, window: 200000 }, rateLimits: [{ kind: 'five_hour', percentUsed: pct }], changed: ['rateLimits'] } as never)
  await measure(77)
  const run = (args: string) => $.command.run({ command: 'os-deck', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  const listed = await run('account')
  expect(listed.text).toContain('● #1 dev1@example.com')
  expect(listed.text).toContain('○ #2 dev2@example.com')
  const out = await run('account 2')
  expect(out.text).toContain('Switched to Account-2')
  expect(out.text).toContain('30 seconds')
  expect(world.calls.some(c => c.join(' ') === 'cswap switch 2 --json')).toBe(true)
  expect(world.calls.every(c => !c.some(a => /[;&|`$]/.test(a)))).toBe(true)
  // A measurement inside the hold may be the old account's: it does not land.
  await measure(91)
  const held = await drawnText($)
  expect(held).toContain('dev2@example.com')
  expect(held).toContain('switching')
  expect(held).toContain('~5h')
  expect(held).not.toContain('91%')
  expect(held).not.toContain('77%')
  // Past it, the session's own limits win again.
  await clock.advance(SWITCH_HOLD_MS + 10)
  await measure(12)
  const after = await drawnText($)
  expect(after).toContain('12%')
  expect(after).not.toContain('~5h')
  expect((await run('account nobody@example.com')).text).toContain('No account found')
  expect((await run('account --force')).text).toContain('Usage: /os-deck account')
})

test('a switch made outside OS-Deck is seen on the next read: the log names it and the old limits go', async ($, on) => {
  const clock = engine(on)
  planWorld(on)
  measured(on)
  const world = cswapWorld(on, 1)
  await $.session.start(START).catch(() => undefined)
  await clock.advance(10)
  await $.session.measure({ context: { percent: 10, tokens: 1000, window: 200000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 66 }], changed: ['rateLimits'] } as never)
  world.active = 2
  await clock.advance(46_000)
  const text = await drawnText($)
  expect(text).toContain('dev1@example.com → dev2@example.com')
  expect(text).not.toContain('66%')
})

test('a cswap that cannot be read keeps the account row away, toasts once, and /os-deck account says why', async ($, on) => {
  const clock = engine(on)
  const { toasts } = planWorld(on)
  // No process.run beneath: the engine refuses the run, as it does for a command that fails to start.
  await $.session.start(START).catch(() => undefined)
  await clock.advance(10)
  await clock.advance(46_000)
  await clock.advance(46_000)
  expect(await drawnText($)).not.toContain('account ')
  expect(toasts.filter(t => t.includes('cswap'))).toHaveLength(1)
  const out = await $.command.run({ command: 'os-deck', args: 'account', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(out.text).toContain('cswap could not be read')
})

test('the cswap option off reads nothing', { options: { cswap: false } }, async ($, on) => {
  const clock = engine(on)
  planWorld(on)
  const world = cswapWorld(on, 1)
  await $.session.start(START).catch(() => undefined)
  await clock.advance(50_000)
  expect(world.calls.filter(c => c[0] === 'cswap')).toEqual([])
})

test('the account row opens the cswap accounts in the pane, and a press on one switches to it', async ($, on) => {
  const clock = engine(on)
  const { toasts } = planWorld(on)
  measured(on)
  const world = cswapWorld(on, 1)
  await $.session.start(START).catch(() => undefined)
  await clock.advance(10)
  const ui = await $.ui.mount({ ...pane(70), surface: 'terminal' })
  expect(JSON.stringify(await ui.drawn())).not.toContain('dev2@example.com')
  await ui.press({ key: 'account' })
  expect(JSON.stringify(await ui.drawn())).toContain('#2 dev2@example.com')
  await ui.press({ key: 'acct-pick-2' })
  expect(world.calls.some(c => c.join(' ') === 'cswap switch 2 --json')).toBe(true)
  expect(toasts.some(t => t.includes('Switched to Account-2'))).toBe(true)
  const after = JSON.stringify(await ui.drawn())
  expect(after).toContain('dev2@example.com #2')
  expect(after).not.toContain('#1 dev1@example.com')
  await ui.unmount()
})
