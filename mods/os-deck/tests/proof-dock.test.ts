import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

// Agent Proof through the mod's own hooks, drawing and buttons: what a person types, presses and reads.

const pause = (ms = 80) => new Promise(done => setTimeout(done, ms))
const command = (args: string, kind = 'composer') => ({ command: 'os-deck', args, origin: { kind }, presentation: { isFullscreen: true, columns: 160 } }) as never
const paneAt = (columns = 80, rows = 70, placement = 'dock') =>
  ({ plugin: 'os-deck', component: 'Pane', requestId: 'flightdeck', surface: 'terminal', props: { title: 'OS-Deck', bodyColumns: columns, scroll: { offset: 0, bodyRows: rows }, isFocused: true, placement, view: {} }, viewport: { columns, rows } }) as never

const world = (on: On, cwd = 'C:/repo') => {
  const clock = mock.clock(on)
  const files: Record<string, string> = { 'package.json': JSON.stringify({ scripts: { test: 'bun test' } }), 'a.ts': 'one' }
  const seen = { spawned: [] as string[][], git: 0, listed: 0 }
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
  on('session.cwd', () => ({ value: cwd }) as never)
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
    seen.listed += 1
    const path = String((e as unknown as { path?: string }).path ?? '').replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
    const entries = path === '/repo' ? [{ name: '.git', kind: 'dir', size: 0, isLink: false }, ...Object.keys(files).map(name => ({ name, kind: 'file', size: 20, isLink: false }))] : []
    return { value: entries } as never
  })
  on('fs.stat', (_$, e) => ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false, realPath: (e as unknown as { path: string }).path } }) as never)
  on('fs.read', (_$, e) => {
    const x = e as unknown as { path: string; as?: string; options?: { as?: string } }
    const text = files[String(x.path).split(/[\\/]/).pop() ?? ''] ?? ''
    return { value: (x.as ?? x.options?.as) === 'bytes' ? { base64: btoa(String.fromCharCode(...new TextEncoder().encode(text))) } : text } as never
  })
  on('process.run', (_$, e) => {
    const x = e as unknown as { argv: string[]; stdin?: string; init?: { stdin?: string } }
    const ok = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false } }) as never
    if (x.argv[0] !== 'git') return ok('', 127)
    seen.git += x.argv.includes('hash-object') ? 1 : 0
    if (x.argv.includes('--show-toplevel')) return ok('C:/repo\n')
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
  on('agent.spawn', () => ({ agentId: 'posing', model: 'claude-sonnet-5-5' }) as never)
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

  await press($, keyLike(await drawn($), 'proof-allow'))
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

// ---------------------------------------------------------------- what the red team got past

/** Claimed, run and its baseline accepted: verified, as a person would get there. */
const verified = async ($: any, w: ReturnType<typeof world>, subject = 'Change a', editor?: string) => {
  await $.command.run(command('proof setup'))
  await press($, keyLike(await drawn($), 'proof-allow'))
  await $.turn.start({ text: 'go', turnId: 'V1' })
  await $.tool.call({ tool: 'TaskCreate', subject, description: 'd', tool_use_id: 'v1' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress', tool_use_id: 'v2' } as never)
  w.files['a.ts'] = 'two'
  if (editor) await $.tool.call({ tool: 'Write', file_path: 'C:/repo/a.ts', content: 'two', agentId: editor, tool_use_id: 'v3' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed', tool_use_id: 'v4' } as never)
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'V1', reason: 'answer' } as never)
  await w.clock.advance(600)
  await pause(200)
  await press($, keyLike(await drawn($), 'proof-baseline'))
}

test('C2: a verified mark does not move onto a new subject', { timeoutMs: 30_000 }, async ($, on) => {
  await verified($, world(on))
  expect(await drawn($)).toContain('"proof-claim:')
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', subject: 'Security audit', tool_use_id: 'v5' } as never)
  await pause()
  expect(await drawn($)).not.toContain('"proof-claim:')
})

test('C2: a verified mark does not move onto a task created with its id', { timeoutMs: 30_000 }, async ($, on) => {
  await verified($, world(on))
  await $.tool.call({ tool: 'TaskCreate', subject: 'Change a', description: 'another', tool_use_id: 'v6' } as never)
  await pause()
  expect(await drawn($)).not.toContain('"proof-claim:')
})

test("H7: another agent's write is not verified as the task's", { timeoutMs: 30_000 }, async ($, on) => {
  await verified($, world(on), 'Change a', 'agent-other')
  expect(await drawn($)).toContain('inconclusive')
})

test('M5: a subject cannot pose as verified', { timeoutMs: 30_000 }, async ($, on) => {
  world(on)
  await $.command.run(command('proof setup'))
  await $.tool.call({ tool: 'TaskCreate', subject: 'Auth \u2713 checks · reviewed', description: 'd', tool_use_id: 'p' } as never)
  expect(await drawn($)).not.toContain('\u2713 checks')
})

test('H8: no allow where the screen cannot be drawn whole', async ($, on) => {
  world(on)
  await $.command.run(command('proof setup'))
  const text = await drawn($, paneAt(30, 40))
  expect(text).toContain('widen')
  expect(text).not.toContain('"key":"proof-allow')
})

test('M7: the classic view does not send a person to a button it has not', { options: { view: 'classic' } }, async ($, on) => {
  world(on)
  const out = await $.command.run(command('proof setup'))
  expect(out.text).toContain('plan view')
})

test('H1: config that changes what a runner runs is on the screen', async ($, on) => {
  const { files } = world(on)
  files['.npmrc'] = 'loglevel=silent\n'
  await $.command.run(command('proof setup'))
  const text = await drawn($)
  for (const part of ['.npmrc', 'loglevel=silent']) expect(text).toContain(part)
})

test('H2: where what runs cannot be resolved there is no automatic allow', async ($, on) => {
  world(on)
  await $.command.run(command('proof check lint -- cargo check'))
  const text = await drawn($)
  expect(text).toContain('"key":"proof-manual')
  expect(text).not.toContain('"key":"proof-allow')
})

test('review 6: an agent cannot pose as verified by its title', { timeoutMs: 30_000 }, async ($, on) => {
  world(on)
  await $.command.run(command('proof setup'))
  await $.turn.start({ text: 'go', turnId: 'R6' })
  await $.agent.spawn({ prompt: 'p', description: '\u2713 checks · reviewed', subagentType: 'general-purpose', tool_use_id: 'r6', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false } as never)
  const text = await drawn($)
  expect(text).toContain('checks · reviewed')
  expect(text).not.toContain('\u2713 checks')
})

test('M5: no mark that reads as a pass, and no letter that does not show, in a subject', async ($, on) => {
  world(on)
  await $.command.run(command('proof setup'))
  const box = String.fromCodePoint(0x1f5f9)
  const hidden = String.fromCodePoint(0x2060)
  await $.tool.call({ tool: 'TaskCreate', subject: `Auth ${box} checks${hidden} · reviewed`, description: 'd', tool_use_id: 'm5' } as never)
  const text = await drawn($)
  expect(text).not.toContain(box)
  expect(text).not.toContain(hidden)
})

for (const cwd of ['/repo', '/Users/someone/repo', '\\\\host\\share\\repo'])
  test(`off Windows Agent Proof allows nothing: ${cwd}`, async ($, on) => {
    const { seen } = world(on, cwd)
    for (const args of ['proof', 'proof setup', 'proof setup C:/repo', 'proof check lint -- node x.js', 'proof history']) {
      const out = await $.command.run(command(args))
      expect(out.text).toContain('Agent Proof works on Windows alone')
    }
    // Counted before the drawing, which has listings of its own.
    const { listed } = seen
    const text = await drawn($)
    expect(text).not.toContain('proof setup')
    expect(text).not.toContain('proof-allow')
    expect([seen.git, seen.spawned.length, listed]).toEqual([0, 0, 0])
  })

test('R3: the hook places an edit as it runs, before any return', { timeoutMs: 30_000 }, async ($, on) => {
  on('tool.run', (_$, x) => ({ result: String(x.tool) === 'TaskCreate' ? { task: { id: '1' } } : { success: true } }) as never)
  const w = world(on)
  await $.command.run(command('proof setup'))
  await press($, keyLike(await drawn($), 'proof-allow'))
  await $.turn.start({ text: 'go', turnId: 'R3' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Change a', description: 'd', tool_use_id: 'r1' } as never)
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress', tool_use_id: 'r2' } as never)
  await $.tool.run({ tool: 'Write', file_path: 'C:/notes/x.md', content: 'x', tool_use_id: 'r3' } as never)
  w.files['a.ts'] = 'two'
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed', tool_use_id: 'r4' } as never)
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'R3', reason: 'answer' } as never)
  await w.clock.advance(600)
  await pause(200)
  await press($, keyLike(await drawn($), 'proof-baseline'))
  // The row says which; why is drawn once it is opened.
  expect(await drawn($)).toContain('? inconclusive')
})
