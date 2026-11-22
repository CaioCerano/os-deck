// The pet: a little Clawd drawn as 24 × 16 pixels, two to a terminal cell (▀, its colour the pixel
// above, its background the one below), so it is 24 columns by 8 rows; bubbles, the "!", z's and
// sparkles are real characters over whole cells, crisp where pixels would blur. Pure functions only: the
// hooks module picks the state, the surface module (pet.tsx) animates it.

export type PetState = 'idle' | 'thinking' | 'reading' | 'editing' | 'running' | 'agents' | 'compact' | 'ask' | 'error' | 'done' | 'sleep'

export const PET_STATES: readonly PetState[] = ['idle', 'thinking', 'reading', 'editing', 'running', 'agents', 'compact', 'ask', 'error', 'done', 'sleep']

/** A subagent as the pet draws it: its colour (its place in the session's spawn order) and how it stands. */
export type PetFriend = { color: number; status: 'running' | 'done' | 'failed' }
/** The friends' colours as hex, in the same order, for the markers beside the agents in the plan. */
export const PET_FRIEND_HEX: readonly string[] = ['#7dc4e4', '#7cc98f', '#b48ead', '#ffd166']
/** How long a finished subagent's cube stays, sparkling or red, before it goes. */
export const PET_FRIEND_LINGER_MS = 2_500
/** How long the squash of a compaction shows. */
export const PET_COMPACT_MS = 2_500
/** Context use from which the pet sweats. */
export const PET_SWEAT_PCT = 85

export const PET_COLUMNS = 24
export const PET_ROWS = 8
const W = PET_COLUMNS
const H = PET_ROWS * 2

/** How long a finished turn and a failed call show before the pet settles, and when it dozes off. */
export const PET_DONE_MS = 5_000
export const PET_ERROR_MS = 3_000
export const PET_SLEEP_MS = 5 * 60_000
/** How long one kind of work shows at least before another takes over, so quick tool calls do not make the pet flicker. */
export const PET_HOLD_MS = 700

export type PetColors = { B: string; D: string; L: string }

const CLAUDE: PetColors = { B: '#d97757', D: '#a9533a', L: '#efa07e' }

const FIXED: Record<string, string> = {
  O: '#17110f', // eyes
  W: '#fff3e8', // paper
  Y: '#ffd166', // big sparkles
  C: '#7dc4e4', // sweat, the magnifier's glass, a blue friend
  c: '#4f93b5',
  G: '#a3a9b8', // metal: the magnifier's rim, written lines
  g: '#7cc98f', // a green friend
  h: '#4f9c63',
  R: '#ef5f5f', // the "!", the pencil's eraser
  P: '#f2c94c', // pencil
  K: '#3b2a1f', // its tip
  S: '#3a3d47', // floor shadow
  V: '#b48ead', // a purple friend
  v: '#8a6a88',
  k: '#4a4f5c', // keyboard: dark keys; a terminal's screen
  w: '#d6dae3', // and light ones; a terminal's output
  r: '#b84444', // a failed friend's shade
}

const HEX = /^#[0-9a-f]{6}$/i

const mix = (a: string, b: string, t: number) => {
  const ch = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16)
  return `#${[0, 1, 2].map(i => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t).toString(16).padStart(2, '0')).join('')}`
}

/** The body's colours: the skin's accent when it is a hex colour, with a shade and a light made from it; Claude's orange otherwise. */
export const petColorsOf = (accent: string | null | undefined): PetColors =>
  accent && HEX.test(accent) ? { B: accent.toLowerCase(), D: mix(accent, '#000000', 0.25), L: mix(accent, '#ffffff', 0.25) } : CLAUDE

// ---------------------------------------------------------------- drawing

type Grid = string[][]
/** A character drawn over a whole cell, crisp where pixels two to a cell would blur: bubbles, the "!", the z's, sparkles. */
type Glyph = { ch: string; color: string; isBold: boolean }
/** One frame: the pixels, and the glyphs laid over them, one per cell at most. */
export type PetCanvas = { px: Grid; text: (Glyph | undefined)[][] }

const blank = (): PetCanvas => ({
  px: Array.from({ length: H }, () => Array<string>(W).fill('.')),
  text: Array.from({ length: PET_ROWS }, () => Array<Glyph | undefined>(W).fill(undefined)),
})

const put = (g: PetCanvas, x: number, y: number, rows: readonly string[]) =>
  rows.forEach((r, j) =>
    [...r].forEach((ch, i) => {
      const X = x + i
      const Y = y + j
      const row = g.px[Y]
      if (ch !== '.' && row && X >= 0 && X < W) row[X] = ch
    }),
  )

/** Text at a cell (`col`, `row`), in a palette colour; a space blanks the cell under it. */
const say = (g: PetCanvas, col: number, row: number, s: string, color: string, isBold = false) =>
  [...s].forEach((ch, i) => {
    const line = g.text[row]
    if (line && col + i >= 0 && col + i < W) line[col + i] = { ch, color, isBold }
  })

type Eyes = 'open' | 'wide' | 'up' | 'down' | 'closed' | 'happy' | 'x'
type Arm = 'side' | 'up' | 'low' | 'none'
type Legs = 'stand' | 'walkA' | 'walkB' | 'sit'
/** `squash` (0, 2 or 4 pixels, whole cells) flattens the body from the top and widens it a pixel each side: a compaction. */
type Pose = { dx?: number; dy?: number; eyes?: Eyes; look?: number; armL?: Arm; armR?: Arm; legs?: Legs; squash?: 0 | 2 | 4 }

/**
 * Where the body's top row sits: low in the frame, so bubbles, signs and sparkles have room above,
 * and on an even row, so the body's rows pair into whole cells (two pixels to a cell).
 */
const TOP = 6

/** The body: 14 pixels wide, an arm on each side, four legs flush with its edges and narrow eyes, after Claude Code's own Clawd. */
const clawd = (g: PetCanvas, o: Pose = {}) => {
  const dx = o.dx ?? 0
  const dy = o.dy ?? 0
  const top = TOP + dy
  const x0 = 5 + dx
  // The floor shadow stays put, as wide as the body, and shrinks as the body leaves the ground.
  put(g, dy < 0 ? 6 : 5, TOP + 8, [dy < 0 ? 'SSSSSSSSSSSS' : 'SSSSSSSSSSSSSS'])
  const sq = o.squash ?? 0
  if (sq > 0) {
    // Flattened: the body's lower rows only, a pixel wider each side, eyes shut in a line, arms out.
    const bt = top + sq
    for (let r = sq; r <= 5; r++) put(g, x0 - 1, top + r, ['BBBBBBBBBBBBBBBB'])
    put(g, x0 - 3, bt, ['BB'])
    put(g, x0 + 15, bt, ['BB'])
    for (const ex of [x0 + 2, x0 + 9]) put(g, ex, bt + (sq === 2 ? 2 : 1), ['OO'])
    ;[x0, x0 + 2, x0 + 11, x0 + 13].forEach(x => put(g, x, top + 6, ['D', 'D']))
    return
  }
  // Three whole cells tall, square cornered: no row of the body shares a cell with another colour.
  for (let r = 0; r <= 5; r++) put(g, x0, top + r, ['BBBBBBBBBBBBBB'])
  put(g, x0 + 1, top, ['L', 'L'])
  const arm = (ax: number, kind: Arm) => {
    if (kind === 'none') return
    // Raised arms go up and out from the body's sides: \o/
    if (kind === 'up') put(g, ax, top - 1, ax < x0 ? ['B.', 'BB', '.B'] : ['.B', 'BB', 'B.'])
    else if (kind === 'low') put(g, ax, top + 4, ['BB', 'BB'])
    else put(g, ax, top + 2, ['BB', 'BB'])
  }
  arm(x0 - 2, o.armL ?? 'side')
  arm(x0 + 14, o.armR ?? 'side')
  const legs = o.legs ?? 'stand'
  if (legs !== 'sit')
    // Two pairs, the outer legs on the body's edges.
    [x0, x0 + 2, x0 + 11, x0 + 13].forEach((x, i) => {
      const isLifted = (legs === 'walkA' && i % 2 === 0) || (legs === 'walkB' && i % 2 === 1)
      put(g, x, top + 6, isLifted ? ['D'] : ['D', 'D'])
    })
  const look = o.look ?? 0
  for (const ex of [x0 + 3, x0 + 10]) {
    const X = ex + look
    const eyes = o.eyes ?? 'open'
    if (eyes === 'open') put(g, X, top + 2, ['O', 'O'])
    // One pixel down: on a book or a keyboard in front of the body.
    else if (eyes === 'down') put(g, X, top + 3, ['O', 'O'])
    // One pixel up, not at the top edge: raised, with body still above them.
    else if (eyes === 'up') put(g, X, top + 1, ['O', 'O'])
    else if (eyes === 'wide') put(g, X, top + 2, ['OO', 'OO'])
    else if (eyes === 'closed') put(g, X - 1, top + 3, ['OO'])
    else if (eyes === 'happy') put(g, X - 1, top + 2, ['.O.', 'O.O'])
    else put(g, X - 1, top + 1, ['O.O', '.O.', 'O.O'])
  }
}

/** A thought: a trail of dots up from the head to a one-line cloud whose dots light in turn (`lit` 0-2, -1 for none). `upTo` grows it as it begins. */
const thought = (g: PetCanvas, lit: number, upTo: 1 | 2 | 3 = 3) => {
  say(g, 18, 2, '·', 'D')
  if (upTo >= 2) say(g, 20, 1, 'o', 'B')
  if (upTo < 3) return
  say(g, 14, 0, '(       )', 'B')
  for (let i = 0; i < 3; i++) say(g, 16 + i * 2, 0, i <= lit ? '•' : '·', i <= lit ? 'B' : 'D', i <= lit)
}
/** A speech balloon over the head with a "!" in it: the person is wanted. */
const balloon = (g: PetCanvas, isLit: boolean) => {
  say(g, 15, 0, '╭───╮', 'B')
  say(g, 15, 1, '│ ! │', 'B')
  say(g, 17, 1, '!', isLit ? 'R' : 'B', true)
  say(g, 15, 2, '╰┬──╯', 'B')
}
const drop = (g: PetCanvas, x: number, y: number) => put(g, x, y, ['.C', '.C', 'CC', 'CC'])
/**
 * An open book held in front of the body, below the eyes, its cover on the floor line. `turn` 1
 * lifts the right page up from the spine, 2 lays it over the left one; both blank the right page.
 */
const book = (g: PetCanvas, turn: 0 | 1 | 2 = 0) => {
  put(g, 6, 10, ['WWWWWKKWWWWW', turn ? 'WGGGWKKWWWWW' : 'WGGGWKKWGGGW', 'WWWWWKKWWWWW', turn ? 'WGGWWKKWWWWW' : 'WGGWWKKWGGWW'])
  put(g, 5, 14, ['cccccccccccccc'])
  if (turn === 1) put(g, 12, 7, ['.W', 'WW', 'WW'])
  if (turn === 2) put(g, 8, 9, ['WWWW.', '.WWWW'])
}
const reader = (g: PetCanvas, look: number, turn: 0 | 1 | 2 = 0) => (clawd(g, { eyes: 'down', look, armL: 'low', armR: 'low' }), book(g, turn))
/** A keyboard in front of the body, hiding the legs, one key (`lit`, [x, y]) lit by the press. */
const keyboard = (g: PetCanvas, lit: readonly [number, number] | null) => {
  put(g, 2, 12, ['GGGGGGGGGGGGGGGGGGGG', `G${'wk'.repeat(9)}G`, `G${'kw'.repeat(9)}G`, '.SSSSSSSSSSSSSSSSSS.'])
  if (lit) put(g, lit[0], lit[1], ['Y'])
}
/** A hand on the keys, in the shade so it shows against the body: up, or down on a key. */
const hand = (g: PetCanvas, x: number, isDown: boolean) => put(g, x, isDown ? 12 : 11, ['DD', 'DD'])
/** What it types, a letter a frame, over the left of its head. */
const CODE = 'fix(bug);'
const KEYS: readonly (readonly [number, number])[] = [[5, 13], [16, 14], [9, 13], [13, 14], [7, 14], [17, 13], [11, 13], [15, 14], [6, 13]]
/** Typing: eyes on the keys, the hands taking turns, the first `n` letters typed and a cursor that blinks. */
const typist = (g: PetCanvas, n: number, isLeftDown: boolean, lit: readonly [number, number] | null, isCursor = true) => {
  clawd(g, { eyes: 'down', armL: 'none', armR: 'none' })
  keyboard(g, lit)
  hand(g, 6, isLeftDown)
  hand(g, 16, !isLeftDown)
  say(g, 2, 1, CODE.slice(0, n) + (isCursor ? '▌' : ' '), 'B')
}
/** The z's of a nap, each `[col, row, letter]`: they rise from beside the head and drift off. */
const zs = (g: PetCanvas, ...at: readonly (readonly [number, number, 'z' | 'Z'])[]) => at.forEach(([c, r, z]) => say(g, c, r, z, 'B', z === 'Z'))
/** Sparkles, each `[col, row, big]`. */
const sparks = (g: PetCanvas, ...at: readonly (readonly [number, number, boolean])[]) => at.forEach(([c, r, isBig]) => say(g, c, r, isBig ? '✦' : '✧', isBig ? 'Y' : 'B', isBig))
/** A friend's colour and its shade, by its place among the running subagents. */
const CUBE_COLORS: readonly (readonly [string, string])[] = [['C', 'c'], ['g', 'h'], ['V', 'v'], ['Y', 'P']]
/** A friend: a floating cube with two eyes that blink, no legs. Big is 5 × 4 pixels, mini 3 × 3. */
const cube = (g: PetCanvas, x: number, y: number, [b, d]: readonly [string, string], isBlink: boolean) =>
  put(g, x, y, [b.repeat(5), isBlink ? b.repeat(5) : `${b}O${b}O${b}`, b.repeat(5), d.repeat(5)])
const mini = (g: PetCanvas, x: number, y: number, [b, d]: readonly [string, string], isBlink: boolean) =>
  put(g, x, y, [b.repeat(3), isBlink ? b.repeat(3) : `O${b}O`, d.repeat(3)])
/** Where the friends float: four big ones low and high on each side, or up to eleven minis around the body. */
const BIG_SLOTS: readonly (readonly [number, number])[] = [[0, 11], [19, 11], [0, 3], [19, 3]]
const MINI_SLOTS: readonly (readonly [number, number])[] = [[0, 12], [21, 12], [0, 8], [21, 8], [0, 4], [21, 4], [7, 1], [14, 1], [0, 0], [21, 0], [10, 1]]

/** What a frame draws from beyond the state: the friends, one per subagent shown. */
type Ctx = { friends: readonly PetFriend[] }
type Frame = readonly [ms: number, draw: (g: PetCanvas, ctx: Ctx) => void]
/** A state's frames: `intro` plays once as the state begins, then `loop` repeats. */
type Track = { intro?: readonly Frame[]; loop: readonly Frame[] }

/** `n` running friends in spawn colours: what a count alone stands for. */
export const runningFriends = (n: number): PetFriend[] => Array.from({ length: Math.max(0, n) }, (_, i) => ({ color: i, status: 'running' as const }))

/**
 * The friends around it: one per subagent shown, in its spawn colour. Up to four are big cubes;
 * from five they are minis, and past the minis' slots a "+N" counts the rest. Running ones bob
 * and blink out of step; a finished one holds still under a sparkle, a failed one turns red.
 */
const friends = (g: PetCanvas, shown: readonly PetFriend[], phase: number) => {
  const isBig = shown.length <= BIG_SLOTS.length
  const slots = isBig ? BIG_SLOTS : MINI_SLOTS
  for (let i = 0; i < Math.min(shown.length, slots.length); i++) {
    const f = shown[i] as PetFriend
    const [x, y] = slots[i] as readonly [number, number]
    const colors = f.status === 'failed' ? (['R', 'r'] as const) : (CUBE_COLORS[f.color % CUBE_COLORS.length] as readonly [string, string])
    const isLive = f.status === 'running'
    const bob = isLive ? (i + phase) % 2 : 0
    const isBlink = isLive && (i + phase) % 4 === 1
    // Minis bob down: the top row's would leave the frame going up.
    const at = isBig ? y - bob : y + bob
    if (isBig) {
      cube(g, x, at, colors, isBlink)
      if (y >= 10) put(g, x + 1, 15, ['SSS'])
    } else mini(g, x, at, colors, isBlink)
    // A finished friend's sparkle sits on the cell above its head, twinkling with the phase.
    if (f.status === 'done') say(g, x + (isBig ? 2 : 1), Math.max(0, Math.floor((at - 1) / 2)), phase % 2 ? '✧' : '✦', 'Y', true)
  }
  if (shown.length > slots.length) say(g, 10, 0, `+${shown.length - slots.length}`, 'B', true)
}
/**
 * A small terminal up at the right, its screen three pixels wide: a prompt with a blinking cursor
 * (steps 0-1), the command typed (2), two lines of output (3, 4), the next prompt (5).
 */
const terminal = (g: PetCanvas, step: number) => {
  put(g, 19, 2, ['GGGGG', 'GkkkG', 'GkkkG', 'GkkkG', 'GkkkG', 'GGGGG'])
  put(g, 20, 3, [step === 0 ? 'gw' : step === 1 ? 'g' : 'gww'])
  if (step >= 3) put(g, 20, 4, ['www'])
  if (step >= 4) put(g, 20, 5, ['ww'])
  if (step >= 5) put(g, 20, 6, ['gw'])
  say(g, 19, 0, '>_', 'g', true)
}

const thinkUp = (g: PetCanvas, look: number) => clawd(g, { eyes: 'up', look })
const nap = (g: PetCanvas) => clawd(g, { eyes: 'closed', dy: 2, legs: 'sit', armL: 'low', armR: 'low' })

const TRACKS: Record<PetState, Track> = {
  // Looks about, blinks, and now and then waves.
  idle: {
    loop: [
      [1800, g => clawd(g)],
      [140, g => clawd(g, { eyes: 'closed' })],
      [1400, g => clawd(g)],
      [900, g => clawd(g, { look: -1 })],
      [900, g => clawd(g, { look: 1 })],
      [700, g => clawd(g)],
      [1800, g => clawd(g)],
      [140, g => clawd(g, { eyes: 'closed' })],
      [600, g => clawd(g)],
      [240, g => clawd(g, { eyes: 'happy', armR: 'up' })],
      [240, g => clawd(g, { eyes: 'happy' })],
      [240, g => clawd(g, { eyes: 'happy', armR: 'up' })],
      [500, g => clawd(g, { eyes: 'happy' })],
    ],
  },
  // Eyes up toward a thought that rises dot by dot into a cloud whose dots light in turn.
  thinking: {
    intro: [
      [240, g => thinkUp(g, 0)],
      [240, g => (thinkUp(g, 1), thought(g, -1, 1))],
      [240, g => (thinkUp(g, 1), thought(g, -1, 2))],
      [200, g => (thinkUp(g, 1), thought(g, -1))],
    ],
    loop: [
      [380, g => (thinkUp(g, 1), thought(g, 0))],
      [380, g => (thinkUp(g, 1), thought(g, 1))],
      [380, g => (thinkUp(g, 1), thought(g, 2))],
      [380, g => (thinkUp(g, 1), thought(g, -1))],
      [380, g => (thinkUp(g, 1), thought(g, 0))],
      [380, g => (thinkUp(g, 1), thought(g, 1))],
      [380, g => (thinkUp(g, 1), thought(g, 2))],
      [140, g => (clawd(g, { eyes: 'closed', look: 1 }), thought(g, -1))],
      [380, g => (thinkUp(g, 0), thought(g, -1))],
    ],
  },
  // An open book held in front, the eyes sweeping across its pages; a blink, then a page turns.
  reading: {
    loop: [
      [550, g => reader(g, -1)],
      [550, g => reader(g, 0)],
      [550, g => reader(g, 1)],
      [140, g => (clawd(g, { eyes: 'closed', armL: 'low', armR: 'low' }), book(g))],
      [550, g => reader(g, -1)],
      [550, g => reader(g, 1)],
      [180, g => reader(g, 1, 1)],
      [180, g => reader(g, 0, 2)],
    ],
  },
  // Typing on a keyboard in front of it, the hands taking turns and each press lighting a key, the
  // text growing a letter at a time over its head; then the cursor blinks on the finished line.
  editing: {
    loop: [
      ...CODE.split('').map((_, i): Frame => [170, g => typist(g, i + 1, i % 2 === 0, KEYS[i] ?? null)]),
      [400, g => typist(g, CODE.length, false, null, false)],
      [400, g => typist(g, CODE.length, false, null)],
      [400, g => typist(g, CODE.length, false, null, false)],
    ],
  },
  // A floating cube per subagent, bobbing and blinking, while the body glances from side to side.
  agents: {
    loop: [
      [700, (g, c) => (clawd(g, { look: -1 }), friends(g, c.friends, 0))],
      [150, (g, c) => (clawd(g, { look: -1 }), friends(g, c.friends, 1))],
      [700, (g, c) => (clawd(g, { look: 1 }), friends(g, c.friends, 2))],
      [150, (g, c) => (clawd(g, { look: 1 }), friends(g, c.friends, 3))],
    ],
  },
  // A shell command: eyes up on a small terminal at its right, the command typed, its output coming in.
  running: {
    loop: [
      [300, g => (clawd(g, { eyes: 'up', look: 1 }), terminal(g, 0))],
      [300, g => (clawd(g, { eyes: 'up', look: 1 }), terminal(g, 1))],
      [250, g => (clawd(g, { eyes: 'up', look: 1 }), terminal(g, 2))],
      [250, g => (clawd(g, { eyes: 'up', look: 1 }), terminal(g, 3))],
      [250, g => (clawd(g, { eyes: 'up', look: 1 }), terminal(g, 4))],
      [500, g => (clawd(g, { eyes: 'up', look: 1 }), terminal(g, 5))],
      [140, g => (clawd(g, { eyes: 'closed', look: 1 }), terminal(g, 5))],
    ],
  },
  // The context compacted: squashed flat under a "⟲", then springing back up.
  compact: {
    intro: [
      [160, g => (clawd(g, { squash: 4 }), say(g, 11, 1, '⟲', 'B', true))],
      [240, g => (clawd(g, { squash: 4 }), say(g, 11, 1, '⟲', 'B', true))],
      [160, g => (clawd(g, { squash: 2 }), say(g, 11, 1, '⟲', 'B', true))],
      [200, g => (clawd(g, { dy: -2, eyes: 'happy', armL: 'up', armR: 'up' }), say(g, 11, 0, '⟲', 'B', true))],
    ],
    loop: [
      [500, g => (clawd(g, { eyes: 'happy' }), say(g, 11, 1, '⟲', 'B', true))],
      [500, g => (clawd(g, { eyes: 'happy' }), say(g, 11, 1, '⟲', 'D'))],
    ],
  },
  // A "!" in a balloon, the left arm waving for attention, a blink now and then.
  ask: {
    loop: [
      [350, g => (clawd(g, { eyes: 'wide', armL: 'up' }), balloon(g, true))],
      [350, g => (clawd(g, { eyes: 'wide' }), balloon(g, true))],
      [350, g => (clawd(g, { eyes: 'wide', armL: 'up' }), balloon(g, false))],
      [350, g => (clawd(g, { eyes: 'wide' }), balloon(g, true))],
      [900, g => (clawd(g, { eyes: 'wide', look: 1 }), balloon(g, true))],
      [150, g => (clawd(g, { eyes: 'closed', look: 1 }), balloon(g, true))],
    ],
  },
  // One flinch, then a sweat drop that slides down while the eyes stay crossed.
  error: {
    intro: [
      [120, g => (clawd(g, { eyes: 'x', dx: -1 }), drop(g, 20, 2))],
      [120, g => (clawd(g, { eyes: 'x', dx: 1 }), drop(g, 21, 2))],
      [120, g => (clawd(g, { eyes: 'x' }), drop(g, 20, 2))],
    ],
    loop: [
      [600, g => (clawd(g, { eyes: 'x' }), drop(g, 20, 2))],
      [600, g => (clawd(g, { eyes: 'x' }), drop(g, 20, 4))],
    ],
  },
  // A hop with the arms up and sparkles, landing happy while they twinkle on.
  done: {
    intro: [
      [140, g => clawd(g, { eyes: 'happy' })],
      [220, g => (clawd(g, { eyes: 'happy', dy: -2, armL: 'up', armR: 'up' }), sparks(g, [1, 0, true], [22, 3, false]))],
      [220, g => (clawd(g, { eyes: 'happy', dy: -2, armL: 'up', armR: 'up' }), sparks(g, [22, 0, true], [0, 3, false]))],
      [160, g => (clawd(g, { eyes: 'happy' }), sparks(g, [1, 1, false], [23, 2, true]))],
    ],
    loop: [
      [500, g => (clawd(g, { eyes: 'happy' }), sparks(g, [22, 1, true], [1, 2, false]))],
      [500, g => (clawd(g, { eyes: 'happy' }), sparks(g, [21, 0, false], [2, 1, true]))],
    ],
  },
  // Sitting with the eyes shut, z's rising one by one from beside the head and drifting off.
  sleep: {
    loop: [
      [600, g => (nap(g), zs(g, [19, 3, 'z']))],
      [600, g => (nap(g), zs(g, [19, 3, 'z'], [20, 2, 'z']))],
      [600, g => (nap(g), zs(g, [19, 3, 'z'], [20, 2, 'z'], [21, 1, 'Z']))],
      [600, g => (nap(g), zs(g, [20, 2, 'z'], [21, 1, 'Z'], [22, 0, 'Z']))],
      [600, g => (nap(g), zs(g, [21, 1, 'Z'], [22, 0, 'Z']))],
      [600, g => (nap(g), zs(g, [22, 0, 'Z']))],
      [900, g => nap(g)],
    ],
  },
}

const sum = (fs: readonly Frame[] | undefined) => (fs ?? []).reduce((n, [ms]) => n + ms, 0)

/** The frame `t` ms after the state began: through its intro once, then round its loop. Its index counts the intro's frames first. */
const pick = (state: PetState, t: number): { index: number; frame: Frame } => {
  const { intro = [], loop } = TRACKS[state]
  let m = Math.max(0, t)
  if (m < sum(intro))
    for (let i = 0; i < intro.length; i++) {
      const f = intro[i] as Frame
      if (m < f[0]) return { index: i, frame: f }
      m -= f[0]
    }
  m = (m - sum(intro)) % sum(loop)
  for (let i = 0; i < loop.length; i++) {
    const f = loop[i] as Frame
    if (m < f[0]) return { index: intro.length + i, frame: f }
    m -= f[0]
  }
  return { index: intro.length, frame: loop[0] as Frame }
}

/**
 * The frame shown `t` ms after a state began: a grid of palette letters ('.' is empty) and the
 * glyphs over it. `friends` are the subagents to draw, or a count of running ones; `isSweating`
 * (context nearly full) adds a drop at the left of the head, except where friends float there.
 */
export const petFrame = (state: PetState, t: number, friends: number | readonly PetFriend[] = 0, isSweating = false): PetCanvas => {
  const g = blank()
  pick(state, t).frame[1](g, { friends: typeof friends === 'number' ? runningFriends(friends) : friends })
  if (isSweating && state !== 'agents' && state !== 'compact') drop(g, 2, 3)
  return g
}

/** Which of a state's frames shows `t` ms after it began: what changes the drawing, so a redraw can wait for it. */
export const petFrameIndex = (state: PetState, t: number) => pick(state, t).index

export type PetRun = { text: string; fg: string | null; bg: string | null; bold?: true }

/**
 * A frame as terminal rows: each cell takes the pixel above as its ▀'s colour and the one below as
 * its background (▄ when only the lower one is drawn, a space on its background when both are one
 * colour, a bare space when neither), neighbours of one look merged into a run. A glyph takes its
 * cell whole, on no background. A bare grid is a frame without glyphs.
 */
export const petCells = (frame: PetCanvas | readonly (readonly string[])[], colors: PetColors): PetRun[][] => {
  const { px: grid, text } = 'px' in frame ? frame : { px: frame, text: [] as PetCanvas['text'] }
  const colorOf = (ch: string | undefined) => (ch === undefined || ch === '.' ? null : ((colors as Record<string, string>)[ch] ?? FIXED[ch] ?? null))
  const at = (x: number, y: number) => colorOf(grid[y]?.[x])
  const rows: PetRun[][] = []
  for (let r = 0; r < PET_ROWS; r++) {
    const runs: PetRun[] = []
    let lastIsGlyph = false
    for (let x = 0; x < W; x++) {
      const glyph = text[r]?.[x]
      const t = at(x, r * 2)
      const b = at(x, r * 2 + 1)
      // A cell of one colour is a space on that background: the background fills the whole cell,
      // line spacing included, where a block glyph leaves a seam between rows. In a cell of two,
      // the line spacing shows the background: ▀ on the lower colour is right where the pixel above
      // the cell is that colour too, ▄ on the upper one where the pixel below is.
      let cell: PetRun
      if (glyph) cell = { text: glyph.ch, fg: colorOf(glyph.color), bg: null, ...(glyph.isBold ? { bold: true as const } : {}) }
      else if (t && b && t === b) cell = { text: ' ', fg: null, bg: t }
      else if (t && b) cell = at(x, r * 2 + 2) === t && at(x, r * 2 - 1) !== b ? { text: '▄', fg: b, bg: t } : { text: '▀', fg: t, bg: b }
      else if (t) cell = { text: '▀', fg: t, bg: null }
      else if (b) cell = { text: '▄', fg: b, bg: null }
      else cell = { text: ' ', fg: null, bg: null }
      const last = runs[runs.length - 1]
      const isGlyph = glyph !== undefined
      const isSame = last && last.fg === cell.fg && last.bg === cell.bg && last.bold === cell.bold && lastIsGlyph === isGlyph
      if (last && isSame && (isGlyph || last.text[0] === cell.text)) last.text += cell.text
      else runs.push(cell)
      lastIsGlyph = isGlyph
    }
    rows.push(runs)
  }
  return rows
}

// ---------------------------------------------------------------- what it is doing

/** What the pet's state is read from: the main loop's last tool, the session's timings. */
export type PetInput = {
  isRunning: boolean
  /** The main loop's tool running now, if any. */
  tool: string | null
  /** Subagents running now. */
  agents: number
  /** Permission asks still waiting on the person. */
  asks: number
  errorAt: number | null
  doneAt: number | null
  /** The last time anything happened: a prompt, a tool, a turn ending. */
  activeAt: number
  now: number
  /** The session's subagents in spawn order, running or finished, for the cubes; absent, `agents` running ones. */
  friends?: readonly (PetFriend & { endedAt?: number | null })[]
  /** When the context last compacted. */
  compactAt?: number | null
  /** Context use, 0-100. */
  ctxPct?: number | null
}

/** The friends drawn at `now`: the running ones and those finished in the last moments, in spawn order. */
export const friendsAt = (i: Pick<PetInput, 'friends' | 'agents' | 'now'>): PetFriend[] =>
  i.friends
    ? i.friends
        .filter(f => f.status === 'running' || (f.endedAt != null && i.now - f.endedAt < PET_FRIEND_LINGER_MS))
        .map(f => ({ color: f.color, status: f.status }))
    : runningFriends(i.agents)

/** Whether the context is full enough to sweat. */
export const isSweating = (i: Pick<PetInput, 'ctxPct'>) => i.ctxPct != null && i.ctxPct >= PET_SWEAT_PCT

const READS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'LSP'])
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const RUNS = new Set(['Bash', 'PowerShell'])

/** What the pet acts out for a tool: the kinds its states tell apart. */
export const petToolKind = (tool: string | null): 'none' | 'read' | 'edit' | 'run' | 'other' =>
  tool === null ? 'none' : READS.has(tool) ? 'read' : RUNS.has(tool) ? 'run' : EDITS.has(tool) ? 'edit' : 'other'

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * The state the pet shows now and a short caption for it. A waiting ask comes first (it needs the
 * person), then a fresh failure, a fresh compaction, then the work itself; between turns, a fresh
 * finish, then idle, then sleep. The caption names the tool where the state is one, and the
 * context use once it is high enough to sweat.
 */
export const petStateOf = (i: PetInput): { state: PetState; caption: string } => {
  const base = stateOf(i)
  const ctx = isSweating(i) && base.state !== 'ask' && base.state !== 'compact' ? ` · ctx ${Math.round(i.ctxPct ?? 0)}%` : ''
  return { state: base.state, caption: base.caption + ctx }
}

const stateOf = (i: PetInput): { state: PetState; caption: string } => {
  if (i.asks > 0) return { state: 'ask', caption: i.asks === 1 ? 'waiting for your ok' : `${i.asks} asks waiting` }
  if (i.errorAt !== null && i.now - i.errorAt < PET_ERROR_MS) return { state: 'error', caption: 'that one failed' }
  if (i.compactAt != null && i.now >= i.compactAt && i.now - i.compactAt < PET_COMPACT_MS) return { state: 'compact', caption: 'context compacted' }
  // Subagents mostly run in the background, past the end of the turn that spawned them: they are
  // work whether the main loop is running or not. One that just finished stays a moment.
  const shown = friendsAt(i)
  if (shown.length > 0) {
    const live = shown.filter(f => f.status === 'running').length
    const failed = shown.filter(f => f.status === 'failed').length
    const caption = live > 0 ? `${plural(live, 'agent', 'agents')} working` : failed > 0 ? (failed === 1 ? 'an agent failed' : `${failed} agents failed`) : 'agent done'
    return { state: 'agents', caption }
  }
  if (i.isRunning) {
    const tool = i.tool ?? ''
    if (READS.has(tool)) return { state: 'reading', caption: tool === 'WebSearch' || tool === 'WebFetch' ? 'reading the web' : 'reading' }
    if (RUNS.has(tool)) return { state: 'running', caption: 'running a command' }
    if (EDITS.has(tool)) return { state: 'editing', caption: 'editing' }
    return { state: 'thinking', caption: tool ? `using ${shortTool(tool)}` : 'thinking…' }
  }
  if (i.doneAt !== null && i.now - i.doneAt < PET_DONE_MS) return { state: 'done', caption: 'done' }
  if (i.now - i.activeAt >= PET_SLEEP_MS) return { state: 'sleep', caption: 'zzz' }
  return { state: 'idle', caption: 'waiting for you' }
}

/** An MCP tool's own name, not its server's prefix: `mcp__atlassian__getJiraIssue` → `getJiraIssue`. */
const shortTool = (tool: string) => (tool.startsWith('mcp__') ? (tool.split('__').pop() ?? tool) : tool)
