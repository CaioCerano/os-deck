import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { PET_COLUMNS, PET_ROWS, PET_STATES, PET_DONE_MS, PET_SLEEP_MS, petCells, petColorsOf, petFrame, petStateOf, petToolKind } from '../hooks/pet-art'
import type { PetInput } from '../hooks/pet-art'

const base: PetInput = { isRunning: false, tool: null, agents: 0, asks: 0, errorAt: null, doneAt: null, activeAt: 0, now: 1000 }

test('pet: a waiting ask comes first, then a fresh failure, then the work, then the time since', () => {
  const st = (x: Partial<PetInput>) => petStateOf({ ...base, ...x }).state
  expect(st({ asks: 1, isRunning: true, agents: 2, errorAt: 999 })).toBe('ask')
  expect(st({ isRunning: true, errorAt: 900 })).toBe('error')
  expect(st({ isRunning: true, agents: 2, tool: 'Read' })).toBe('agents')
  expect(st({ isRunning: true, tool: 'Grep' })).toBe('reading')
  expect(st({ isRunning: true, tool: 'Edit' })).toBe('editing')
  expect(st({ isRunning: true, tool: 'Bash' })).toBe('running')
  expect(st({ isRunning: true })).toBe('thinking')
  expect(st({ doneAt: 1000 - PET_DONE_MS + 1 })).toBe('done')
  expect(st({ doneAt: 1000 - PET_DONE_MS })).toBe('idle')
  expect(st({ now: PET_SLEEP_MS })).toBe('sleep')
  expect(petStateOf({ ...base, isRunning: true, tool: 'mcp__atlassian__getJiraIssue' }).caption).toBe('using getJiraIssue')
  expect(petStateOf({ ...base, isRunning: true, agents: 1 }).caption).toBe('1 agent working')
  // Background subagents outlive the turn that spawned them.
  expect(st({ agents: 1, doneAt: 999 })).toBe('agents')
  expect(st({ agents: 1, now: 10 * 60_000 })).toBe('agents')
  expect([petToolKind(null), petToolKind('Read'), petToolKind('Write'), petToolKind('Bash'), petToolKind('Agent')]).toEqual(['none', 'read', 'edit', 'run', 'other'])
})

test('pet: every frame of every state is 24 × 8 cells of half blocks, runs merged', () => {
  const colors = petColorsOf(null)
  for (const s of PET_STATES)
    for (const agents of [2, 5, 14])
      for (let t = 0; t < 4000; t += 90) {
        const rows = petCells(petFrame(s, t, agents), colors)
        expect(rows.length).toBe(PET_ROWS)
        for (const runs of rows) {
          expect(runs.map(r => r.text).join('').length).toBe(PET_COLUMNS)
          // Half blocks, or the glyphs laid over whole cells: bubbles, the "!", z's, sparkles,
          // the typed text and its cursor, and the "+N" of the friends past the last slot.
          expect(runs.every(r => /^(▀+|▄+| +|[ ()·•o╭╮╰╯│─┬!zZ✦✧a-z;▌+0-9>_⟲]+)$/.test(r.text))).toBe(true)
        }
      }
  // The top half is the ▀'s colour, the bottom half its background.
  const g = Array.from({ length: 16 }, () => Array(24).fill('.'))
  g[0]![0] = 'B'
  g[1]![0] = 'O'
  g[3]![1] = 'B'
  const [r0, r1] = petCells(g, colors)
  expect(r0?.[0]).toEqual({ text: '▀', fg: '#d97757', bg: '#17110f' })
  expect(r1?.[0]).toEqual({ text: ' ', fg: null, bg: null })
  expect(r1?.[1]).toEqual({ text: '▄', fg: '#d97757', bg: null })
  // A cell of one colour is a space on its background, so line spacing leaves no seam.
  const solid = Array.from({ length: 16 }, () => Array(24).fill('.'))
  solid[4]![2] = 'B'
  solid[5]![2] = 'B'
  expect(petCells(solid, colors)[2]?.[1]).toEqual({ text: ' ', fg: null, bg: '#d97757' })
  // Every state's body is whole cells: no ▀ or ▄ with the body's colour on top of its own.
  for (const s of PET_STATES) {
    const rows = petCells(petFrame(s, 0, 2), colors)
    expect(rows.every(runs => runs.every(r => !(r.fg === '#d97757' && r.bg === '#d97757')))).toBe(true)
  }
  // The effects are real characters, crisp where pixels two to a cell blur.
  const glyphs = (s: (typeof PET_STATES)[number], t: number) => petCells(petFrame(s, t), colors).flat().map(r => r.text).join('')
  expect(glyphs('thinking', 2000)).toMatch(/\(.*[•·].*\)/)
  expect(glyphs('ask', 0)).toContain('!')
  expect(glyphs('sleep', 1500)).toMatch(/z.*Z|Z.*z/)
  expect(petCells(petFrame('ask', 0), colors).flat().find(r => r.text.includes('!'))?.bold).toBe(true)
  // Eyes raised in thought sit a pixel below the top edge, not on it.
  expect(petFrame('thinking', 0).px[6]?.includes('O')).toBe(false)
  expect(petFrame('thinking', 0).px[7]?.includes('O')).toBe(true)
  // The outer legs sit on the body's edges (columns 5 and 18), like Clawd's.
  expect(petFrame('idle', 0).px[12]?.join('')).toBe('.....D.D........D.D.....')
  // Reading holds a book in front; editing types on a keyboard, the text growing over the head.
  expect(petFrame('reading', 0).px[10]?.join('')).toContain('WWWWWKKWWWWW')
  expect(petFrame('editing', 0).px[14]?.join('')).toContain('kwkwkwkwkw')
  expect(glyphs('editing', 0)).toContain('f▌')
  expect(glyphs('editing', 170 * 9 - 1)).toContain('fix(bug);')
  // One cube per subagent, counted by its pixels, eyes included (a big cube is 20, a mini 9,
  // blinking or not; the body's own four eye pixels left out): big up to four, minis up to
  // eleven, then a "+N" for the rest.
  const cubes = (n: number) => {
    const px = petFrame('agents', 0, n).px.flat().filter(c => 'CcghVvYPO'.includes(c)).length - 4
    return n <= 4 ? px / 20 : px / 9
  }
  expect([1, 2, 3, 4, 5, 8, 11, 14].map(cubes)).toEqual([1, 2, 3, 4, 5, 8, 11, 11])
  expect(glyphs('agents', 0)).not.toContain('+')
  expect(petCells(petFrame('agents', 0, 14), colors).flat().map(r => r.text).join('')).toContain('+3')
  expect(petColorsOf('#5B9BD5').B).toBe('#5b9bd5')
  expect(petColorsOf('claude')).toEqual(petColorsOf(null))
})

const engine = (on: On) => {
  const clock = mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return clock
}
const pane = (bodyColumns: number, bodyRows = 70) => ({
  plugin: 'os-deck',
  component: 'Pane' as const,
  requestId: 'flightdeck',
  surface: 'terminal' as const,
  props: { title: 'OS-Deck', isFocused: true, bodyColumns, placement: 'dock' as const, scroll: { offset: 0, bodyRows }, view: {} },
})

test('the pet heads the plan header and acts out the main loop: reading while Read runs', async ($, on) => {
  engine(on)
  let shown = ''
  on('tool.call', { tool: 'Read' }, async () => {
    const ui = await $.ui.mount(pane(70))
    shown = String((await ui.find({ in: 'pet-caption', text: /reading/ })) !== undefined)
    await ui.unmount()
    return { result: 'x', text: 'x' } as never
  })
  const idle = await $.ui.mount(pane(70))
  expect(await idle.find({ in: 'pet', text: /▀/ })).toBeDefined()
  expect(await idle.find({ in: 'pet-caption', text: /waiting for you/ })).toBeDefined()
  await idle.unmount()
  await $.turn.start({ text: 'go', turnId: 'P1' })
  await $.tool.call({ tool: 'Read', file_path: '/x.ts' } as never)
  expect(shown).toBe('true')
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'P1', reason: 'answer' } as never)
  const done = await $.ui.mount(pane(70))
  expect(await done.find({ in: 'pet-caption', text: /done/ })).toBeDefined()
  await done.unmount()
})

test('the pet sits on top of the header in a narrow pane, and goes in a tiny or short one, or when hidden or turned off', async ($, on) => {
  engine(on)
  on('command.register', () => ({ value: undefined }) as never)
  const has = async (cols: number, rows = 70) => {
    const ui = await $.ui.mount(pane(cols, rows))
    const d = JSON.stringify(await ui.drawn())
    await ui.unmount()
    return d.includes('"pet"')
  }
  expect(await has(70)).toBe(true)
  expect(await has(50)).toBe(true)
  // The engine seats a pane at 40 columns at least, room for the pet on top: a short pane is the small one.
  expect(await has(70, 20)).toBe(false)
  const short = await $.ui.mount(pane(70, 20))
  expect(JSON.stringify(await short.drawn())).toContain('needs 24×30')
  await short.unmount()
  const out = await $.command.run({ command: 'os-deck', args: 'hide pet', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } })
  expect(out.text).toContain('pet hidden')
  expect(await has(70)).toBe(false)
})

test('the pet option off draws the old header', { options: { pet: false } }, async ($, on) => {
  engine(on)
  const ui = await $.ui.mount(pane(70))
  const d = JSON.stringify(await ui.drawn())
  expect(d.includes('"pet"')).toBe(false)
  expect(d).toContain(' req')
  await ui.unmount()
})

test('without motion the pet is one still frame in the pane tree itself', { options: { motion: 'off' } }, async ($, on) => {
  engine(on)
  const ui = await $.ui.mount(pane(70))
  const d = JSON.stringify(await ui.drawn())
  expect(d.includes('pet.tsx')).toBe(false)
  expect(d).toContain('▀')
  expect(d).toContain('waiting for you')
  await ui.unmount()
})

test('one mounted pet follows new props, then settles on its own clock: done, then idle', async ($, on) => {
  engine(on)
  const ui = await $.ui.mount(pane(70))
  expect(await ui.find({ in: 'pet-caption', text: /waiting for you/ })).toBeDefined()
  await $.turn.start({ text: 'go', turnId: 'P2' })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'P2', reason: 'answer' } as never)
  expect(await ui.find({ in: 'pet-caption', text: /^done$/ })).toBeDefined()
  await ui.advance(PET_DONE_MS + 300)
  expect(await ui.find({ in: 'pet-caption', text: /waiting for you/ })).toBeDefined()
  await ui.unmount()
})

test('a kind of work holds its minimum time, then the next one takes over', async ($, on) => {
  engine(on)
  const seen: string[] = []
  let ui: Awaited<ReturnType<typeof $.ui.mount>> | null = null
  // The caption as last drawn; reading the drawing first lets a pending redraw land.
  const caption = async () => JSON.stringify(ui ? await ui.drawn({ in: 'pet-caption' }) : null)
  on('tool.call', { tool: 'Read' }, async () => {
    seen.push(await caption())
    return { result: 'x', text: 'x' } as never
  })
  ui = await $.ui.mount(pane(70))
  await $.turn.start({ text: 'go', turnId: 'P3' })
  expect(await caption()).toContain('thinking')
  // Straight after thinking began, a quick read does not flip the pet yet.
  await $.tool.call({ tool: 'Read', file_path: '/a.ts' } as never)
  // Once thinking has had its time, the next read shows at once.
  await ui.advance(800)
  await $.tool.call({ tool: 'Read', file_path: '/b.ts' } as never)
  expect(seen[0]).toContain('thinking')
  expect(seen[1]).toContain('reading')
  await ui.unmount()
})
