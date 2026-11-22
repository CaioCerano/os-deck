import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// Agent Proof through the mod's own hooks, drawing and buttons: what a person types, presses and reads.

const pause = (ms = 80) => new Promise(done => setTimeout(done, ms))
const command = (args: string, kind = 'composer') => ({ command: 'os-deck', args, origin: { kind }, presentation: { isFullscreen: true, columns: 160 } }) as never
const paneAt = (columns = 80, rows = 70, placement = 'dock') =>
  ({ plugin: 'os-deck', component: 'Pane', requestId: 'flightdeck', surface: 'terminal', props: { title: 'OS-Deck', bodyColumns: columns, bodyRows: rows, isFocused: true, placement } }) as never

const world = (on: On) => {
  const clock = mock.clock(on)
  const files: Record<string, string> = { 'package.json': JSON.stringify({ scripts: { test: 'bun test' } }), 'a.ts': 'one' }
  const seen = { spawned: [] as string[][], git: 0 }
  const db = new Map<string, unknown>()
  const hash = (s: string) => {
    let h = 7
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
    return (h >>> 0).toString(16).padStart(8, '0').repeat(5)
  }
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('agent.list', () => ({ value: [] }) as never)
  on('session.cwd', () => ({ value: '/repo' }) as never)
  on('session.id', () => ({ value: 'DOCK' }) as never)
  on('store.get', (_$, e) => ({ value: db.get((e as unknown as { key: string }).key) }) as never)
  on('store.set', (_$, e) => {
    const x = e as unknown as { key: string; value: unknown }
    db.set(x.key, JSON.parse(JSON.stringify(x.value)))
    return { value: undefined } as never
  })
  on('store.delete', () => ({ value: undefined }) as never)
  on('store.keys', () => ({ value: [...db.keys()] }) as never)
  on('fs.list', (_$, e) => {
    const path = String((e as unknown as { path?: string }).path ?? '').replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
    const entries = path === '/repo' ? [{ name: '.git', kind: 'dir', size: 0, isLink: false }, ...Object.keys(files).map(name => ({ name, kind: 'file', size: 20, isLink: false }))] : []
    return { value: entries } as never
  })
  on('fs.read', (_$, e) => ({ value: files[String((e as unknown as { path: string }).path).split(/[\\/]/).pop() ?? ''] ?? '' }) as never)
  on('process.run', (_$, e) => {
    const x = e as unknown as { argv: string[]; stdin?: string; init?: { stdin?: string } }
    const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false } }) as never
    if (x.argv[0] !== 'git') return ok('', 127)
    seen.git += x.argv.includes('hash-object') ? 1 : 0
    if (x.argv.includes('--show-toplevel')) return ok('/repo\n')
    if (x.argv.includes('--git-path')) return ok('.git/info/exclude\n')
    if (x.argv.includes('symbolic-ref')) return ok('refs/heads/main\n')
    if (x.argv.includes('--stage')) return ok(Object.keys(files).map(f => `100644 ${'a'.repeat(40)} 0\t${f}\0`).join(''))
    if (x.argv.includes('hash-object')) return ok((x.stdin ?? x.init?.stdin ?? '').split('\n').filter(Boolean).map(f => `${hash(files[f] ?? '')}\n`).join(''))
    if (x.argv.includes('ls-files')) return ok('')
    return ok('', 1)
  })
  on('process.spawn', async function* (_$, e) {
    seen.spawned.push((e as unknown as { argv: string[] }).argv)
    yield { stream: 'stderr', text: ' 3 pass\n 0 fail\nRan 3 tests across 1 file.\n' } as never
    return { value: { code: 0, signal: null } } as never
  })
  on('tool.call', (_$, e) => ({ result: e.tool === 'TaskCreate' ? { task: { id: '1' } } : { success: true } }) as never)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return { clock, files, seen }
}

const drawn = async ($: any, pane = paneAt()) => {
  const ui = await $.ui.mount(pane)
  const text = JSON.stringify(await ui.drawn())
  await ui.unmount()
  return text
}
const press = async ($: any, key: string, pane = paneAt()) => {
  const ui = await $.ui.mount(pane)
  await ui.press({ key })
  await ui.unmount()
  await pause()
}
/** The key of a drawn button, by the start of it: keys carry what was drawn. */
const keyLike = (text: string, start: string) => {
  const key = [...text.matchAll(/"key":"((?:[^"\\]|\\.)*)"/g)].map(m => JSON.parse(`"${m[1]}"`) as string).find(k => k.startsWith(start))
  if (!key) throw new Error(`no button ${start}`)
  return key
}

test('setup, allow, claim, run, baseline, verified, review: all by the dock', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock, files, seen } = world(on)
  expect(await drawn($)).not.toContain('proof')

  await $.command.run(command('proof setup'))
  let text = await drawn($)
  for (const part of ['proof setup', 'bun test', 'allow', 'manual only', 'without a permission prompt']) expect(text).toContain(part)
  expect([seen.spawned.length, seen.git]).toEqual([0, 0])

  await press($, 'proof-allow')
  text = await drawn($)
  expect(text).not.toContain('proof setup')
  expect(text).toContain('pending')

  await $.turn.start({ text: 'go', turnId: 'P1' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Change a', description: 'make it two', tool_use_id: 'p1' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress', tool_use_id: 'p2' } as never)
  files['a.ts'] = 'two'
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed', tool_use_id: 'p3' } as never)
  expect(seen.spawned).toEqual([])
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'P1', reason: 'answer' } as never)
  await clock.advance(600)
  await pause(200)
  expect(seen.spawned).toEqual([['npm', 'run', 'test']])

  text = await drawn($)
  expect(text).toContain('inconclusive')
  expect(text).not.toContain('✓ checks')
  await press($, keyLike(text, 'proof-baseline'))
  text = await drawn($)
  expect(text).toContain('✓ checks')
  expect(text).toContain('review')

  await press($, keyLike(text, 'proof-claim'))
  text = await drawn($)
  for (const part of ['CLAIMED', 'VERIFIED BY OS-DECK', 'FOR YOU', 'make it two', 'acceptance criteria are not checked']) expect(text).toContain(part)
  await press($, keyLike(text, 'proof-review'))
  expect(await drawn($)).toContain('reviewed')
})

test('setup can be allowed in a narrow inline pane', async ($, on) => {
  world(on)
  await $.command.run(command('proof setup'))
  const text = await drawn($, paneAt(50, 20, 'inline'))
  expect(text).toContain('proof setup')
  expect(text).toContain('proof-allow')
})

test('a command nobody typed sets up nothing', async ($, on) => {
  world(on)
  const out = await $.command.run(command('proof setup', 'sdk'))
  expect(out.text).toContain('type this command yourself')
  expect(await drawn($)).not.toContain('proof setup')
})
