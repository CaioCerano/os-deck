import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { groupOf, jiraLabel, jiraSiteOf, jqlParentKey, redact } from '../hooks/core'
import { closingIssuesOf } from '../hooks/github'

// One test or more per bug fixed in 0.4.3; each failed on 0.4.2.

const V = 'FAKEvalue1234567890'
const PROVIDER = { plugin: 'engine', tier: 'core' as const }
const pane = { plugin: 'os-deck', component: 'Pane', requestId: 'flightdeck', surface: 'terminal', props: { title: 'OS-Deck', bodyColumns: 80, bodyRows: 70, isFocused: true, placement: 'dock' } }
const command = (args: string) => ({ command: 'os-deck', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } }) as never
const settle = () => new Promise(done => setTimeout(done, 80))

const world = (on: On, sessionId = 'S1', o: { cwd?: string; getMs?: number; failPlanSaves?: number } = {}) => {
  let failing = o.failPlanSaves ?? 0
  const clock = mock.clock(on)
  const db = new Map<string, unknown>()
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('store.get', async (_$, e) => {
    const value = db.get((e as unknown as { key: string }).key)
    // A real store answers later: long enough for parallel writers to read the same value.
    await new Promise(done => setTimeout(done, o.getMs ?? 1))
    return { value } as never
  })
  on('store.set', (_$, e) => {
    const x = e as unknown as { key: string; value: unknown }
    if (x.key.startsWith('plan-history:') && failing-- > 0) throw new Error('lock timeout')
    db.set(x.key, JSON.parse(JSON.stringify(x.value)))
    return { value: undefined } as never
  })
  on('store.delete', (_$, e) => {
    db.delete((e as unknown as { key: string }).key)
    return { value: undefined } as never
  })
  on('store.keys', () => ({ value: [...db.keys()] }) as never)
  on('session.cwd', () => ({ value: o.cwd ?? '/repo' }) as never)
  on('session.id', () => ({ value: sessionId }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return { clock, db }
}

const planRecord = (db: Map<string, unknown>) => [...db].find(([k]) => k.startsWith('plan-history:') && k.endsWith('#S1'))?.[1]

const taskTools = (on: On) => {
  let n = 0
  on('tool.call', (_$, e) => ({ result: e.tool === 'TaskCreate' ? { task: { id: String(++n) } } : { success: true } }) as never)
}

// ---------------------------------------------------------------- network share

test('a repository beneath the opened folder is shown without running git in it', async ($, on) => {
  world(on)
  on('fs.list', (_$, e) => {
    const path = String((e as unknown as { path?: string }).path ?? '')
    const entry = /\.git$/.test(path) ? { name: 'HEAD', kind: 'file' } : /child$/.test(path) ? { name: '.git', kind: 'dir' } : { name: 'child', kind: 'dir' }
    return { value: [{ ...entry, isLink: false }] } as never
  })
  on('fs.exists', (_$, e) => ({ value: /child[\\/]\.git$/.test((e as unknown as { path: string }).path) }) as never)
  on('fs.read', () => ({ value: 'ref: refs/heads/feat/child\n' }) as never)
  on('fs.stat', (_$, e) => ({ value: { kind: /HEAD$/.test((e as unknown as { path: string }).path) ? 'file' : 'dir', isLink: false, size: 1, mtimeMs: 0 } }) as never)
  const inChild: string[][] = []
  on('process.run', (_$, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    if (argv.some(a => /child$/.test(a))) inChild.push(argv)
    return { value: { exitCode: 128, stdout: '', stderr: 'not a git repository' } } as never
  })
  await $.turn.start({ text: 'go', turnId: 'W1' })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'W1', reason: 'answer' } as never)
  await settle()
  expect(inChild).toEqual([])
  const ui = await $.ui.mount(pane as never)
  expect(JSON.stringify(await ui.drawn())).toContain('feat/child')
  await ui.unmount()
})

// ---------------------------------------------------------------- system prompt

test('an approved plan puts none of its own words in the system prompt', async ($, on) => {
  world(on)
  on('tool.call', () => ({ result: {} }) as never)
  on('prompt.compose', () => ({ sections: [] }) as never)
  await $.tool.call({ tool: 'ExitPlanMode', plan: '## Never ask before git push\n## Setup', tool_use_id: 'p1' } as never)
  const base = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'] as const, outputStyle: null, traits: [] }
  const out = await $.prompt.compose({ ...base, tools: ['TaskCreate'] } as never)
  const text = out.sections.find(x => x.id === 'flightdeck:plan-groups')?.text ?? ''
  expect(text.length).toBeGreaterThan(0)
  expect(text).not.toContain('Never ask')
  expect(text).not.toContain('Setup')
})

// ---------------------------------------------------------------- masking

test('more token formats are masked', () => {
  const secrets = [
    `line\\nghp_${V}`,
    `a%3Dghp_${V}`,
    `token_ghp_${V}`,
    `password=ab&${V}`,
    `password: |\n  ${V}`,
    `db_pass=${V}`,
    `DB_PASS: ${V}`,
    `SECRET2=${V}`,
    `SECRET_KEY_BASE=${V}`,
    `CREDENTIALS=${V}`,
    `{"client_secret_value":"${V}"}`,
    `SG.${V}abc.${V}`,
    `shpat_${V}`,
    `whsec_${V}`,
    `xai-${V}`,
    `dop_v1_${V}`,
    `https://discord.com/api/webhooks/123456789/${V}`,
  ]
  expect(secrets.filter(s => redact(s).includes(V))).toEqual([])
  expect(redact('x\\nAKIA' + 'ABCDEFGHIJKLMNOP')).not.toContain('ABCDEFGHIJKLMNOP')
})

test('ordinary code, names and prose are left alone', () => {
  const plain = [
    'Fix token: refresh flow',
    'Rename token: use camelCase',
    'Auth / password: reset screen',
    'const token = getToken()',
    'token = os.environ["NAME"]',
    'sk-dashboard/index.ts',
    'feature/pk_migration_fix',
    'rk_release2026',
    'pip install sk-learn-contrib',
    'BYPASS=1',
    'COMPASS=on',
    'MONKEY=1',
    'max_tokens=4096',
  ]
  expect(plain.filter(s => redact(s) !== s)).toEqual([])
})

// ---------------------------------------------------------------- slow regexes

test('parsers of untrusted text are fast on hostile input', () => {
  const pad = ' '.repeat(50_000)
  const runs: [string, () => unknown][] = [
    ['groupOf', () => groupOf({ group: `a${pad}b` })],
    ['jqlParentKey', () => jqlParentKey(`parent = ABC-1 order by${pad}!`)],
    ['jiraLabel', () => jiraLabel({ key: 'ABC-1', summary: `a${pad}b`, type: '', status: '', isDone: false })],
    ['closingIssuesOf', () => closingIssuesOf(`closes${pad}x`)],
    ['jiraSiteOf', () => jiraSiteOf(`${'/'.repeat(100_000)}\nx`)],
  ]
  const slow = runs.filter(([, run]) => {
    const started = Date.now()
    run()
    return Date.now() - started > 100
  })
  expect(slow.map(([name]) => name)).toEqual([])
})

// ---------------------------------------------------------------- plan and history

test('demo leaves the real plan in place', async ($, on) => {
  world(on)
  taskTools(on)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Real work', description: 'd', tool_use_id: 'c1' } as never)
  await $.command.run(command('demo'))
  let ui = await $.ui.mount(pane as never)
  expect(JSON.stringify(await ui.drawn())).toContain('Reports')
  await ui.unmount()
  await $.command.run(command('reset'))
  ui = await $.ui.mount(pane as never)
  const drawn = JSON.stringify(await ui.drawn())
  await ui.unmount()
  expect(drawn).toContain('Real work')
  expect(drawn).not.toContain('Reports')
})

test('demo counts never reach the project history', async ($, on) => {
  const { db } = world(on)
  taskTools(on)
  await $.tool.call({ tool: 'TaskCreate', subject: 'Real', description: 'd', metadata: { group: 'Mine' }, tool_use_id: 'c1' } as never)
  await $.command.run(command('demo'))
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed', tool_use_id: 'u1' } as never)
  await settle()
  const saved = JSON.stringify([...db.entries()])
  expect(saved).toContain('Mine')
  expect(saved).not.toContain('v1.2')
})

test('a completion after resume adds to the history saved before it', async ($, on) => {
  const { clock, db } = world(on)
  await clock.advance(1_000)
  taskTools(on)
  db.set('plan-history:/repo', { S1: { at: 1, done: { Old: 4, G: 3 } } })
  await $.tool.call({ tool: 'TaskCreate', subject: 'next', description: 'd', metadata: { group: 'G' }, tool_use_id: 'c1' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed', tool_use_id: 'u1' } as never)
  await settle()
  // This session's own record, or the shared map it was kept in before.
  const own = planRecord(db) ?? (db.get('plan-history:/repo') as Record<string, unknown>).S1
  expect((own as { done: unknown }).done).toEqual({ Old: 4, G: 4 })
})

test('reset keeps what earlier sessions finished', async ($, on) => {
  const { clock, db } = world(on, 'now')
  await clock.advance(1_000)
  taskTools(on)
  db.set('plan-history:/repo', { before: { at: 1, done: { G: 2 } } })
  await $.command.run(command('reset'))
  await $.tool.call({ tool: 'TaskCreate', subject: 'next', description: 'd', metadata: { group: 'G' }, tool_use_id: 'c1' } as never)
  const ui = await $.ui.mount(pane as never)
  expect(JSON.stringify(await ui.drawn())).toContain('+2 earlier')
  await ui.unmount()
})

test('completions at the same moment are all counted', async ($, on) => {
  world(on)
  taskTools(on)
  for (const i of [1, 2, 3, 4, 5]) await $.tool.call({ tool: 'TaskCreate', subject: `t${i}`, description: 'd', tool_use_id: `c${i}` } as never)
  await Promise.all([1, 2, 3, 4, 5].map(i => $.tool.call({ tool: 'TaskUpdate', taskId: String(i), status: 'completed', tool_use_id: `u${i}` } as never)))
  await settle()
  await settle()
  expect((await $.command.run(command('today'))).text).toContain('5 tasks')
})

test('another session saving at the same moment is not overwritten', async ($, on) => {
  const { db } = world(on, 'mine')
  taskTools(on)
  await $.tool.call({ tool: 'TaskCreate', subject: 't', description: 'd', tool_use_id: 'c1' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed', tool_use_id: 'u1' } as never)
  await settle()
  // Nothing this session writes is a key another session writes.
  const shared = [...db.keys()].filter(k => /history/.test(k) && !k.endsWith('#mine'))
  expect(shared).toEqual([])
})

// ---------------------------------------------------------------- display

test('a running agent is kept past 24', async ($, on) => {
  world(on)
  let n = 0
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: `ag${++n}` }))
  for (let i = 1; i <= 25; i++)
    await $.agent.spawn({ prompt: 'p', description: `job ${i}`, subagentType: 'Explore', tool_use_id: `ta${i}`, provider: PROVIDER, parentModel: 'claude-opus-5-5', background: true, fork: false } as never)
  const ui = await $.ui.mount(pane as never)
  expect(JSON.stringify(await ui.drawn())).toContain('25/25 agents')
  await ui.unmount()
})

test('a PowerShell command refreshes git', async ($, on) => {
  const { clock } = world(on)
  // Past the few seconds between two git reads.
  await clock.advance(10_000)
  let runs = 0
  on('process.run', () => {
    runs += 1
    return { value: { exitCode: 128, stdout: '', stderr: '' } } as never
  })
  on('fs.list', () => ({ value: [] }) as never)
  on('tool.call', () => ({ result: 'ok' }) as never)
  await $.tool.call({ tool: 'PowerShell', command: 'git checkout x', tool_use_id: 'ps1' } as never)
  await settle()
  expect(runs).toBeGreaterThan(0)
})

// ---------------------------------------------------------------- found reviewing 0.4.3 before its release

test('nothing 0.4.2 masked shows again', () => {
  const S = 'SEC9xQ'
  const rows = [
    `bash -c "export DB_PASSWORD=\\"correct horse ${S}\\""`,
    `DB_PASSWORD="ab\\"cd${S}"`,
    `jdbc:postgresql://h/db?user=a&password=Summer#${S}`,
    `token=eyJhbGciOiJB.abcdefgh.ijklmnop.${S}.tagtagtag`,
    `password=sk-Winter2026x!${S}`,
    `secret=AKIA${'ABCDEFGHIJKLMNOP'}:${S}`,
    `BYPASS=1;DEPLOY_KEY=${S}`,
    `PWD=/home/app;password=${S}`,
    `MYSQL_PWD=/home/${S}`,
    `ghs_123456_${S}`,
    `password: BYPASS=1;${S}`,
    `https://r.org:443/@types/node--token ${S}`,
    `token: |\n  export token=\n${S}`,
  ]
  expect(rows.filter(r => redact(r).includes(S))).toEqual([])
  expect(redact('sk-qwertyuiopasdf-zqwmxvrtghjkl')).not.toContain('zqwmxvrtghjkl')
})

test('claimed formats hold in their real spellings', () => {
  const rows = [`whsec_abcDEF123456+/${V}=`, `password: |2\n    ${V}`, `password: | # comment\n  ${V}`, `password: |\n\n  ${V}`, `https://discord.com/api/v10/webhooks/1234/${V}`]
  expect(rows.filter(r => redact(r).includes(V))).toEqual([])
  for (const s of ['boroughs_population', 'highs_breakouts', 'credentials: include']) expect(redact(s)).toBe(s)
})

test('untracked files, which make git open nested repositories, are not listed by default', async ($, on) => {
  world(on)
  const calls: string[][] = []
  on('process.run', (_$, e) => {
    const argv = (e as unknown as { argv: string[] }).argv
    calls.push(argv)
    const stdout = argv.includes('rev-parse') ? '/repo\n' : argv.includes('symbolic-ref') ? 'refs/heads/main\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '' } } as never
  })
  await $.turn.start({ text: 'go', turnId: 'N1' })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'N1', reason: 'answer' } as never)
  await settle()
  expect(calls.some(a => a.includes('--unmerged'))).toBe(true)
  expect(calls.some(a => a.includes('--others'))).toBe(false)
})

const finishTwo = async ($: any) => {
  for (const id of ['1', '2']) await $.tool.call({ tool: 'TaskCreate', subject: `t${id}`, description: 'd', metadata: { group: 'G' }, tool_use_id: `fc${id}` })
  for (const id of ['1', '2']) {
    await $.tool.call({ tool: 'TaskUpdate', taskId: id, status: 'completed', tool_use_id: `fu${id}` })
    await settle()
  }
}

test('a failed save is made good by the next', async ($, on) => {
  const { db } = world(on, 'S1', { failPlanSaves: 1 })
  taskTools(on)
  await finishTwo($)
  expect((planRecord(db) as { done: unknown } | undefined)?.done).toEqual({ G: 2 })
})

test('history keys fit the store in a long directory', async ($, on) => {
  const { db } = world(on, '12345678-1234-1234-1234-123456789012', { cwd: `/${'d'.repeat(235)}` })
  taskTools(on)
  await finishTwo($)
  const keys = [...db.keys()].filter(k => k.startsWith('plan-history:'))
  expect(keys.length).toBe(1)
  expect(keys[0]!.length).toBeLessThan(256)
})

test('a task call does not wait for the history store', async ($, on) => {
  world(on, 'S1', { getMs: 400 })
  taskTools(on)
  await $.tool.call({ tool: 'TaskCreate', subject: 't', description: 'd', metadata: { group: 'G' }, tool_use_id: 'w1' } as never)
  const started = Date.now()
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed', tool_use_id: 'w2' } as never)
  expect(Date.now() - started).toBeLessThan(300)
  await new Promise(done => setTimeout(done, 1700))
})

test('a task counted before the upgrade is not counted again', async ($, on) => {
  const { clock, db } = world(on)
  await clock.advance(1_000)
  taskTools(on)
  await finishTwo($)
  for (const k of [...db.keys()]) if (k.startsWith('plan-history:')) db.delete(k)
  // As 0.4.2 left it: both counted, no task ids.
  db.set('plan-history:/repo', { S1: { at: 1, done: { G: 2 } } })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress', tool_use_id: 'r1' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed', subject: 'renamed', tool_use_id: 'r2' } as never)
  await settle()
  expect((planRecord(db) as { done: unknown } | undefined)?.done).toEqual({ G: 2 })
})

test('a task grouped after it finished is counted there', async ($, on) => {
  const { db } = world(on)
  taskTools(on)
  await $.tool.call({ tool: 'TaskCreate', subject: 't', description: 'd', tool_use_id: 'g1' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed', tool_use_id: 'g2' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', metadata: { group: 'Late' }, tool_use_id: 'g3' } as never)
  await settle()
  expect((planRecord(db) as { done: unknown } | undefined)?.done).toEqual({ Late: 1 })
})

test('expired history goes whatever panels are shown, and past days fold into one key', { options: { panels: 'main,log' } }, async ($, on) => {
  const { clock, db } = world(on)
  on('session.start', () => ({ cwd: '/repo' }) as never)
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: '' } }) as never)
  on('fs.list', () => ({ value: [] }) as never)
  await clock.advance(100 * 86_400_000)
  db.set('plan-history:/gone', { old: { at: 1, done: { G: 1 } } })
  db.set('plan-history:abc#old', { at: 1, done: { G: 1 } })
  const past = new Date(90 * 86_400_000).toISOString().slice(0, 10)
  for (const id of ['a', 'b', 'c']) db.set(`os-deck:day:${past}#${id}`, { [past]: { turns: 2 } })
  await $.session.start({ source: 'startup', cwd: '/repo' } as never)
  await settle()
  await settle()
  const keys = [...db.keys()]
  expect(keys.filter(k => k.startsWith('plan-history:') || k.startsWith('os-deck:day:'))).toEqual([])
  expect(JSON.stringify(db.get('os-deck:history-days') ?? null)).toContain('"turns":6')
})

test('a folder of thousands is not walked whole', async ($, on) => {
  let looks = 0
  on('fs.list', (_$, e) => {
    looks += 1
    const path = String((e as unknown as { path?: string }).path ?? '')
    return { value: /d\d+$/.test(path) ? [] : Array.from({ length: 3000 }, (_, i) => ({ name: `d${i}`, kind: 'dir', isLink: false })) } as never
  })
  on('fs.stat', () => {
    looks += 1
    throw new Error('ENOENT')
  })
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: '' } }) as never)
  world(on)
  await $.turn.start({ text: 'go', turnId: 'F1' })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'F1', reason: 'answer' } as never)
  await new Promise(done => setTimeout(done, 800))
  expect(looks).toBeLessThanOrEqual(201)
})

test('a reftable repository shows no made-up branch', async ($, on) => {
  on('fs.list', (_$, e) => {
    const path = String((e as unknown as { path?: string }).path ?? '')
    const entry = /\.git$/.test(path) ? { name: 'HEAD', kind: 'file' } : /child$/.test(path) ? { name: '.git', kind: 'dir' } : { name: 'child', kind: 'dir' }
    return { value: [{ ...entry, isLink: false }] } as never
  })
  on('fs.stat', (_$, e) => ({ value: { kind: /HEAD$/.test((e as unknown as { path: string }).path) ? 'file' : 'dir', isLink: false, size: 1, mtimeMs: 0 } }) as never)
  on('fs.read', () => ({ value: 'ref: refs/heads/.invalid\n' }) as never)
  on('process.run', () => ({ value: { exitCode: 128, stdout: '', stderr: '' } }) as never)
  world(on)
  await $.turn.start({ text: 'go', turnId: 'R1' })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'R1', reason: 'answer' } as never)
  await settle()
  const ui = await $.ui.mount(pane as never)
  const drawn = JSON.stringify(await ui.drawn())
  await ui.unmount()
  expect(drawn).toContain('child')
  expect(drawn).not.toContain('.invalid')
})
