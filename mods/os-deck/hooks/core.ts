// Pure data: defaults, reducers, formatting and layout math. Nothing here touches `$`, so every
// behaviour is testable directly (the test kit cannot raise a subagent's tool call or a
// permission check inside a call; these functions are what the hooks apply).
import { SKIN_PALETTES } from './skin-palettes'
import type {
  Account,
  AgentCard,
  JiraChild,
  JiraEpic,
  DeckSection,
  Git,
  GitRepo,
  Architect,
  Bucket,
  Check,
  Gate,
  Layout,
  LogLine,
  Loop,
  Main,
  Moment,
  JiraIssue,
  JiraRef,
  Plan,
  PlanTask,
  Receipt,
  Roster,
  Tally,
  TaskStatus,
  ToolNote,
  Turn,
  Usage,
  View,
} from '../types'

export const SCHEMA_VERSION = 2

// ---------------------------------------------------------------- defaults

export const DEFAULT_MAIN: Main = { model: '', effort: '', mode: '', steps: 0, isRunning: false, speed: null }
export const DEFAULT_USAGE: Usage = {
  pct: null,
  tokens: null,
  window: 0,
  costUsd: null,
  limits: [],
  compactions: 0,
  lastCompactAt: null,
}
export const DEFAULT_ARCHITECT: Architect = { consults: [], ids: [], seen: [], lastAdvice: '' }
const ZERO: Tally = { rule: 0, ask: 0, cleared: 0, deny: 0 }
export const DEFAULT_GATE: Gate = { recent: [], totals: { file: ZERO, shell: ZERO, other: ZERO } }
export const DEFAULT_TURN: Turn = { edits: 0, errorStreak: 0, errors: 0, isReviewing: false, startedAt: 0, costAtStart: null }
export const DEFAULT_VIEW: View = { expanded: null, gateOpen: null, layout: null, planFocus: null, planFocusAt: null, planDone: false }
export const DEFAULT_ROSTER: Roster = { architectTypes: [] }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A stored object merged over its defaults, so a value saved under an older shape still reads. */
export const normalize = <T extends object>(def: T, stored: unknown): T =>
  isObject(stored) ? ({ ...def, ...stored } as T) : def

/** A stored list, or empty when what is stored is not a list. */
export const listOf = <T>(stored: unknown): T[] => (Array.isArray(stored) ? (stored as T[]) : [])

export const normalizeGate = (stored: unknown): Gate => {
  const g = normalize(DEFAULT_GATE, stored)
  const totals = normalize(DEFAULT_GATE.totals, g.totals)
  return {
    recent: listOf<Check>(g.recent),
    totals: { file: normalize(ZERO, totals.file), shell: normalize(ZERO, totals.shell), other: normalize(ZERO, totals.other) },
  }
}

export const normalizeCard = (stored: unknown): AgentCard =>
  normalize<AgentCard>(
    {
      id: '',
      type: 'agent',
      model: '',
      description: '',
      status: 'running',
      spawnedAt: 0,
      endedAt: null,
      ctx: 0,
      out: 0,
      steps: 0,
      lastStop: null,
      tools: [],
      answer: '',
    },
    stored,
  )

/** The stored cards, one per agent, the latest of an id in its place: a card drawn twice fails the whole pane. */
export const cardsOf = (stored: unknown): AgentCard[] => {
  const byId = new Map<string, AgentCard>()
  for (const card of listOf<unknown>(stored).map(normalizeCard)) {
    byId.delete(card.id)
    byId.set(card.id, card)
  }
  return [...byId.values()]
}

export const normalizeLog = (stored: unknown): LogLine[] =>
  listOf<Record<string, unknown>>(stored).map(l => ({
    at: typeof l.at === 'number' ? l.at : 0,
    who: String(l.who ?? ''),
    text: String(l.text ?? ''),
    agentId: typeof l.agentId === 'string' ? l.agentId : null,
    kind: l.kind === 'error' || l.kind === 'consult' || l.kind === 'done' ? l.kind : 'info',
  }))

// ---------------------------------------------------------------- config

export type Panel = 'main' | 'plan' | 'architect' | 'gate' | 'agents' | 'loops' | 'receipt' | 'log' | 'git' | 'epic' | 'timeline'
const PANELS: readonly Panel[] = ['main', 'plan', 'architect', 'gate', 'agents', 'loops', 'receipt', 'log', 'git', 'epic', 'timeline']

export type Config = {
  architect: RegExp
  architectLabel: string
  gateLabel: string
  panels: Panel[]
  motion: boolean
  moments: boolean
  matchDescriptions: boolean
  maxCards: number
  layout: Layout
  palette: Palette
  style: Style
  /** A fill for the pane's body, to match a terminal background the pane's own fill differs from. */
  background: string | null
  /** Ask Claude to file each task under a group path, for the plan panel's tree. */
  planHint: boolean
  /** always: Claude is asked to break any multi-step work into tasks by phase; hint: only to group the tasks it makes. */
  planPolicy: 'always' | 'hint'
  /** The phases tasks are filed under when the policy is always, in order. */
  planPhases: string[]
  /** plan: a header, the plan with each task's subagents beneath it, the log at the foot. classic: the panels stacked. */
  view: 'plan' | 'classic'
  /** Read a cited issue from Jira itself when Claude has not; off, the plan anchors only to issues Claude reads. */
  jiraFetch: boolean
  /** The Jira site, `your-team.atlassian.net`: browse links, and the active read's cloudId. */
  jiraSite: string | null
  openOnStart: boolean
  statusLine: boolean
  /** Read the active account from cswap (claude-swap) and switch it with /os-deck account. */
  cswap: boolean
  /** The cswap executable: a name on PATH or a full path. */
  cswapCommand: string
  /** Draw the pet at the head of the plan view's header. */
  pet: boolean
  /** The GitHub section: the branch's pull request through the gh CLI. */
  github: boolean
  /** The gh executable: a name on PATH or a full path. */
  ghCommand: string
  /** Native notifications for an ask left waiting and a long turn's end. */
  alerts: boolean
  /** Seconds an ask waits before it is announced. */
  alertAfterS: number
  /** Minutes a turn runs before its end is announced. */
  alertTurnMin: number
}

const safeRegExp = (source: string, fallback: string) => {
  try {
    return new RegExp(source || fallback, 'i')
  } catch {
    return new RegExp(fallback, 'i')
  }
}

/** The plugin's `/config` values, read leniently: anything malformed falls back to the default. */
export const parseConfig = (o: Readonly<Record<string, unknown>>): Config => {
  const str = (k: string, d: string) => (typeof o[k] === 'string' && o[k] !== '' ? (o[k] as string) : d)
  const bool = (k: string, d: boolean) => (typeof o[k] === 'boolean' ? (o[k] as boolean) : d)
  const panels = str('panels', PANELS.join(','))
    .split(',')
    .map(s => s.trim())
    .filter((p): p is Panel => (PANELS as readonly string[]).includes(p))
  const layout = str('layout', 'auto')
  const max = typeof o.maxCards === 'number' ? Math.round(o.maxCards) : 3
  return {
    architect: safeRegExp(str('architectPattern', ''), 'advisor|architect'),
    architectLabel: str('architectLabel', 'ARCHITECT'),
    gateLabel: str('gateLabel', 'GATE'),
    panels: panels.length > 0 ? [...new Set(panels)] : [...PANELS],
    motion: str('motion', 'while-active') !== 'off',
    moments: bool('moments', true),
    matchDescriptions: bool('matchDescriptions', false),
    maxCards: Math.min(6, Math.max(1, max)),
    layout: layout === 'compact' || layout === 'wide' || layout === 'mini' ? layout : 'auto',
    palette: str('palette', 'skin') === 'pastel' ? 'pastel' : str('palette', 'skin') === 'theme' ? 'theme' : 'skin',
    style: str('style', 'native') === 'cards' ? 'cards' : 'native',
    background: /^#[0-9a-f]{6}$/i.test(str('background', '')) ? str('background', '') : null,
    planHint: bool('planHint', true),
    planPolicy: str('planPolicy', 'always') === 'hint' ? 'hint' : 'always',
    planPhases: (() => {
      const xs = str('planPhases', 'Plano,Implementação,Qualidade').split(',').map(x => x.trim()).filter(x => x.length > 0 && x.length <= 30)
      return xs.length > 0 ? xs.slice(0, 6) : ['Plano', 'Implementação', 'Qualidade']
    })(),
    view: str('view', 'plan') === 'classic' ? 'classic' : 'plan',
    jiraFetch: bool('jiraFetch', false),
    jiraSite: jiraSiteOf(str('jiraSite', '')),
    openOnStart: bool('openOnStart', true),
    statusLine: bool('statusLine', true),
    cswap: bool('cswap', true),
    cswapCommand: str('cswapCommand', 'cswap').trim() || 'cswap',
    pet: bool('pet', true),
    github: bool('github', true),
    ghCommand: str('ghCommand', 'gh').trim() || 'gh',
    alerts: bool('alerts', true),
    alertAfterS: typeof o.alertAfterS === 'number' && o.alertAfterS >= 5 ? Math.min(3600, Math.round(o.alertAfterS)) : 30,
    alertTurnMin: typeof o.alertTurnMin === 'number' && o.alertTurnMin >= 1 ? Math.min(600, Math.round(o.alertTurnMin)) : 2,
  }
}

// ---------------------------------------------------------------- palette

/** skin follows the skins mod's skin when one is on, the theme's colours otherwise. */
export type Palette = 'theme' | 'pastel' | 'skin'
/** `native` draws like the transcript: no coloured frames, one accent; `cards` is upstream's framed look. */
export type Style = 'native' | 'cards'
export type Colors = Record<'main' | 'agent' | 'gate' | 'cleared' | 'arch' | 'amber' | 'warn' | 'dim' | 'faint' | 'text', string>

/**
 * `theme` names the person's own theme colours (they follow light, dark and colour-blind themes);
 * `pastel` is fixed hex tuned for dark terminals.
 */
export const PALETTES: Record<'theme' | 'pastel', Colors> = {
  theme: {
    main: 'claude',
    agent: 'suggestion',
    gate: 'success',
    cleared: 'permission',
    arch: 'merged',
    amber: 'warning',
    warn: 'error',
    dim: 'inactive',
    faint: 'subtle',
    text: 'text',
  },
  pastel: {
    main: '#7dd3fc',
    agent: '#93c5fd',
    gate: '#86efac',
    cleared: '#5eead4',
    arch: '#c4b5fd',
    amber: '#fcd34d',
    warn: '#fca5a5',
    dim: '#6b7280',
    faint: '#3f4654',
    text: '#e5e7eb',
  },
}

/**
 * The native style's colours: Claude's own accent for markers and the working state, the
 * theme's status colours for verdicts, and plain text for the rest (values are drawn in `text`). Theme keys, so it follows the
 * person's theme like the transcript does.
 */
export const NATIVE: Colors = {
  main: 'claude',
  agent: 'claude',
  gate: 'success',
  cleared: 'inactive',
  arch: 'claude',
  amber: 'warning',
  warn: 'error',
  dim: 'inactive',
  faint: 'subtle',
  text: 'text',
}

/** The colours a config draws with: the native style keeps one accent whatever the palette. */
export const colorsOf = (cfg: Pick<Config, 'palette' | 'style'>, skin: Colors | null = null): Colors =>
  cfg.style === 'native' ? NATIVE : cfg.palette === 'skin' ? (skin ?? PALETTES.theme) : PALETTES[cfg.palette]

/** Halfway (or `t` of the way) from one hex colour to another. */
const mix = (a: string, b: string, t: number) => {
  const ch = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16)
  return `#${[0, 1, 2].map(i => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t).toString(16).padStart(2, '0')).join('')}`
}

const HEX = /^#[0-9a-f]{6}$/i

/**
 * The colours of the skin the skins mod draws, from what it keeps in state: its `prefs.skin`
 * (a built-in skin, or a custom one over a built-in base) and whether the terminal is light.
 * Null when skins is off, absent, or names a skin this table does not know.
 */
export const skinColors = (prefs: unknown, custom: unknown, isLight: boolean): Colors | null => {
  const name = isObject(prefs) && typeof prefs.skin === 'string' ? prefs.skin : null
  if (!name || name === 'off') return null
  const made = isObject(custom) && isObject(custom[name]) ? custom[name] : null
  const baseName = made && typeof made.base === 'string' ? made.base : name
  const base = SKIN_PALETTES[baseName]
  if (!base) return null
  const own = made && isObject(made.palette) ? Object.fromEntries(Object.entries(made.palette).filter((e): e is [string, string] => typeof e[1] === 'string' && HEX.test(e[1]))) : {}
  const p: Record<string, string> = { ...((isLight && base.light) || base.dark), ...own }
  const get = (k: string, d: string) => (typeof p[k] === 'string' && HEX.test(p[k] as string) ? (p[k] as string) : d)
  const fg = get('fg', '#c0c0c0')
  const muted = get('muted', '#808080')
  // Skin slots to Flightdeck's roles: the prompt's accent leads, tool kinds tell the panels apart.
  return {
    main: get('user', fg),
    agent: get('web', fg),
    gate: get('ok', fg),
    cleared: get('read', fg),
    arch: get('search', fg),
    amber: get('warn', fg),
    warn: get('err', fg),
    dim: muted,
    // Empty gauge cells and tree lines: between muted text and the skin's surface, seen but quiet.
    faint: mix(muted, get('surface', isLight ? '#ffffff' : '#000000'), 0.45),
    text: fg,
  }
}

/** SVG cannot name theme keys: mid-tone colours that read on light and dark backgrounds. */
export const SVG_COLORS = { running: '#3b82f6', done: '#16a34a', failed: '#dc2626', other: '#8b5cf6', label: '#6b7280' }

// ---------------------------------------------------------------- formatting

/** `claude-opus-5-5` → `Opus 5.5`; anything else is shown as given. */
/**
 * A model id as people say it, from any provider's spelling: `claude-opus-5-5[1m]` → `Opus 5.5 1M`,
 * `us.anthropic.claude-sonnet-4-5-20250929-v1:0` → `Sonnet 4.5`, `claude-3-5-haiku-20241022` →
 * `Haiku 3.5`. Anything else is shown as given, cut to 22 characters.
 */
export const prettyModel = (id: string) => {
  if (!id) return '—'
  const cap = (f: string) => f.charAt(0).toUpperCase() + f.slice(1)
  const big = /\[1m\]|-1m\b/i.test(id) ? ' 1M' : ''
  const now = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?![\d])/i.exec(id)
  if (now?.[1] && !/^\d/.test(now[1])) return `${cap(now[1].toLowerCase())} ${now[2]}${now[3] ? `.${now[3]}` : ''}${big}`
  const old = /claude-(\d+)(?:-(\d))?-([a-z]+)/i.exec(id)
  if (old?.[3]) return `${cap(old[3].toLowerCase())} ${old[1]}${old[2] ? `.${old[2]}` : ''}${big}`
  return shorten(id, 22)
}

export const shorten = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return n <= 0 ? '' : one.length > n ? `${one.slice(0, Math.max(0, n - 1)).trimEnd()}…` : one
}

export const kTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)

export const fmtDuration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** A running clock as the live cards draw it: m:ss, or XhYY past an hour. */
export const fmtTimer = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

export const fmtClock = (ms: number) => (ms > 0 ? new Date(ms).toTimeString().slice(0, 8) : '--:--:--')

/** `1 error`, `2 errors`. */
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export const fmtUsd = (n: number) => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`)

/**
 * How fast a request answered, from three readings of the clock: when it was sent, when its first
 * piece of response arrived, and when it stopped. Null when no response came. `tokPerS` is null
 * when there is no usage or no time between the first piece and the stop to divide by.
 */
export const stepSpeed = (sentAt: number, firstAt: number | null, stopAt: number, outTokens: number | null) => {
  if (firstAt === null) return null
  const decodeMs = stopAt - firstAt
  return {
    ttftMs: Math.max(0, firstAt - sentAt),
    tokPerS: outTokens !== null && outTokens > 0 && decodeMs > 0 ? (outTokens * 1000) / decodeMs : null,
  }
}

/** `ttft 0.8s · 42 tok/s`; the rate is left off when it is unknown. */
export const fmtSpeed = (s: { ttftMs: number; tokPerS: number | null }) =>
  `ttft ${(s.ttftMs / 1000).toFixed(1)}s` + (s.tokPerS !== null ? ` · ${Math.round(s.tokPerS)} tok/s` : '')

/** A gauge of `width` cells: ▰ filled, ▱ empty. */
export const gauge = (pct: number, width: number) => {
  const full = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return { on: '▰'.repeat(full), off: '▱'.repeat(width - full) }
}

/** A rate-limit reading as the pane keeps it, its ISO reset time turned into ms since the epoch. */
export const limitOf = (r: { kind: string; percentUsed: number; resetsAt?: string }) => {
  const at = r.resetsAt ? Date.parse(r.resetsAt) : NaN
  return { kind: r.kind, pct: r.percentUsed, resetsAt: Number.isFinite(at) ? at : null }
}

/** Time left until a window resets, its two largest units: `25m`, `3h10m`, `4d2h`; empty when unknown or past. */
export const fmtResetIn = (resetsAt: number | null | undefined, now: number) => {
  if (resetsAt === null || resetsAt === undefined || resetsAt <= now) return ''
  const m = Math.max(1, Math.floor((resetsAt - now) / 60_000))
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  if (d > 0) return `${d}d${h}h`
  return h > 0 ? `${h}h${String(m % 60).padStart(2, '0')}m` : `${m}m`
}

/** A rate-limit window's short name: `five_hour` → `5h`, `seven_day_opus` → `7d opus`. */
export const limitLabel = (kind: string) =>
  kind
    .replace(/five[_ -]?hours?/i, '5h')
    .replace(/seven[_ -]?days?/i, '7d')
    .replace(/[_-]+/g, ' ')
    .trim()

// ---------------------------------------------------------------- redaction

const SECRETS: [RegExp, string][] = [
  [/(authorization\s*[:=]\s*)(bearer\s+|basic\s+)?\S+/gi, '$1$2•••'],
  [/\b(bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, '$1 •••'],
  [/\b(sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{8,}/g, '•••'],
  [/((?:api[_-]?key|access[_-]?token|token|secret|password|passwd|pwd)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1•••'],
  [/(--(?:token|password|api-key|secret)[= ])\S+/gi, '$1•••'],
  [/(\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)=)\S+/g, '$1•••'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s@]+@/gi, '$1•••@'],
]

/** What the gate drill-down may store: credentials masked before anything is written to state. */
export const redact = (s: string) => SECRETS.reduce((t, [re, to]) => t.replace(re, to), s)

// ---------------------------------------------------------------- tools and gate

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
export const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

export const bucketOf = (tool: string): Bucket =>
  FILE_TOOLS.has(tool) ? 'file' : SHELL_TOOLS.has(tool) ? 'shell' : 'other'

/** One line saying what a call was about: its command, path or pattern; redacted. */
export const describeInput = (tool: string, input: unknown) => {
  const i = isObject(input) ? input : {}
  const path = typeof i.file_path === 'string' ? i.file_path.split(/[\\/]/).slice(-2).join('/') : ''
  const what =
    typeof i.command === 'string'
      ? i.command
      : path || (typeof i.pattern === 'string' ? i.pattern : typeof i.url === 'string' ? i.url : typeof i.description === 'string' ? i.description : '')
  return redact(what ? `${tool} → ${what}` : tool)
}

/** Keeps the last `max` checks, but never drops a pending ask: its settle must still find it. */
export const trimRecent = (list: Check[], max: number): Check[] => {
  let extra = list.length - max
  if (extra <= 0) return list
  const out: Check[] = []
  for (const c of list) {
    if (extra > 0 && c.verdict !== 'ask') {
      extra -= 1
      continue
    }
    out.push(c)
  }
  return out.slice(-max * 2)
}

export const recordCheck = (g: Gate, c: Check): Gate => {
  const t = g.totals[c.bucket]
  return {
    recent: trimRecent([...g.recent, c], 80),
    totals: { ...g.totals, [c.bucket]: { ...t, [c.verdict]: t[c.verdict] + 1 } },
  }
}

/** An `ask` settled by the call that followed it: it ran (cleared) or was refused (deny). */
export const settleCheck = (g: Gate, id: string, didRun: boolean): Gate => {
  const c = g.recent.find(r => r.id === id && r.verdict === 'ask')
  if (!c) return g
  const verdict = didRun ? 'cleared' : 'deny'
  const t = g.totals[c.bucket]
  return {
    recent: g.recent.map(r => (r === c ? { ...r, verdict } : r)),
    totals: { ...g.totals, [c.bucket]: { ...t, ask: Math.max(0, t.ask - 1), [verdict]: t[verdict] + 1 } },
  }
}

export const gateSummary = (g: Gate) => {
  const all = (['file', 'shell', 'other'] as const).reduce(
    (s, k) => ({
      rule: s.rule + g.totals[k].rule,
      ask: s.ask + g.totals[k].ask,
      cleared: s.cleared + g.totals[k].cleared,
      deny: s.deny + g.totals[k].deny,
    }),
    { ...ZERO },
  )
  return { ...all, total: all.rule + all.ask + all.cleared + all.deny }
}

// ---------------------------------------------------------------- turn and architect

/**
 * The turn after one tool call. Errors count in the main loop only (a subagent's failure is its
 * own); edits count from every loop, so delegated work still reaches "before done".
 */
export const afterCall = (t: Turn, c: { inSubagent: boolean; hasFailed: boolean; isEdit: boolean }): Turn => ({
  ...t,
  errorStreak: c.inSubagent ? t.errorStreak : c.hasFailed ? t.errorStreak + 1 : 0,
  errors: t.errors + (!c.inSubagent && c.hasFailed ? 1 : 0),
  edits: t.edits + (c.isEdit ? 1 : 0),
})

/** Which of the architect's three moments a consult falls at: an inference over this turn so far. */
export const momentOf = (t: Pick<Turn, 'edits' | 'errorStreak'>): Moment =>
  t.errorStreak >= 2 ? 'error repeats' : t.edits === 0 ? 'before a plan' : 'before done'

export const startConsult = (a: Architect, c: { id: string; at: number; moment: Moment; via: string; about?: string }): Architect =>
  a.consults.some(x => x.id === c.id) ? a : { ...a, consults: [...a.consults, { ...c, endAt: null }].slice(-40) }

/** Ends the open consult (the latest without an end), or the one named. */
export const endConsult = (a: Architect, at: number, advice: string | null, id?: string): Architect => {
  const open = [...a.consults].reverse().find(c => c.endAt === null && (id === undefined || c.id === id))
  return {
    ...a,
    // A report handed back before the end is that consult's advice already: the end does not replace it.
    consults: a.consults.map(c => (c === open ? { ...c, endAt: at, ...(advice && !c.advice ? { advice } : {}) } : c)),
    lastAdvice: advice ?? a.lastAdvice,
  }
}

export const isAdvising = (a: Architect) => a.consults.some(c => c.endAt === null)

/** A one-row timeline of consults across `width` cells: ◆ a consult, ━ while it ran. */
export const consultTimeline = (a: Architect, now: number, width: number) => {
  if (a.consults.length === 0 || width < 4) return '─'.repeat(Math.max(0, width))
  const first = a.consults[0]?.at ?? now
  const span = Math.max(1, now - first)
  const cells = Array.from({ length: width }, () => '─')
  for (const c of a.consults) {
    const from = Math.min(width - 1, Math.floor(((c.at - first) / span) * (width - 1)))
    const to = Math.min(width - 1, Math.floor((((c.endAt ?? now) - first) / span) * (width - 1)))
    for (let i = from + 1; i <= to; i += 1) cells[i] = '━'
    cells[from] = '◆'
  }
  return cells.join('')
}

export const receiptOf = (t: Turn, o: { durationMs: number; agentsSince: number; costNow: number | null; reason: string }): Receipt => ({
  durationMs: o.durationMs,
  agents: o.agentsSince,
  edits: t.edits,
  errors: t.errors,
  costDelta: o.costNow !== null && t.costAtStart !== null && o.costNow - t.costAtStart >= 0.005 ? o.costNow - t.costAtStart : null,
  reason: o.reason,
})

// ---------------------------------------------------------------- agents and loops

type StepUsage = { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; output_tokens?: number } | null

/** A card after one of its model requests: its context is the latest step's whole input; output adds up. */
export const applyStep = (c: AgentCard, s: { model: string; usage: StepUsage; stopReason: string | null }): AgentCard => {
  const u = s.usage ?? {}
  const ctx = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
  return {
    ...c,
    model: c.model || s.model,
    steps: c.steps + 1,
    ctx: ctx > 0 ? ctx : c.ctx,
    out: c.out + (u.output_tokens ?? 0),
    lastStop: s.stopReason,
  }
}

export const noteTool = (c: AgentCard, n: ToolNote): AgentCard => ({ ...c, tools: [...c.tools, n].slice(-3) })

export const stepLoop = (loops: Loop[], id: string, at: number): Loop[] => {
  const found = loops.find(l => l.id === id)
  const next = found
    ? loops.map(l => (l === found ? { ...l, steps: l.steps + 1, lastAt: at } : l))
    : [...loops, { id, steps: 1, firstAt: at, lastAt: at, isDone: false }]
  return next.slice(-60)
}

export const LOOP_ACTIVE_MS = 15_000
export const isLoopActive = (l: Loop, now: number) => !l.isDone && now - l.lastAt < LOOP_ACTIVE_MS

/** Swimlane geometry: each agent's bar on one shared axis from the first spawn to now. */
export const lanes = (cards: AgentCard[], now: number, width: number) => {
  const start = Math.min(...cards.map(c => c.spawnedAt).filter(n => n > 0), now)
  const span = Math.max(1, now - start)
  return cards.map(c => {
    const from = Math.floor(((Math.max(c.spawnedAt, start) - start) / span) * width)
    const to = Math.max(from + 1, Math.ceil((((c.endedAt ?? now) - start) / span) * width))
    return { id: c.id, before: Math.min(from, width), bar: Math.min(to, width) - Math.min(from, width), after: width - Math.min(to, width) }
  })
}

// ---------------------------------------------------------------- layout

/** How many log lines fit: what the other panels leave, never fewer than 4 nor more than 8. */
export const logRows = (bodyRows: number, used: number) => Math.max(4, Math.min(8, bodyRows - used - 3))

/** Legend items that fit on one row of `width` cells, in order; the rest are dropped. */
export const fitLegend = <T extends { label: string }>(items: T[], width: number) => {
  const out: T[] = []
  let used = 0
  for (const it of items) {
    const w = it.label.length + 4
    if (used + w > width) break
    out.push(it)
    used += w
  }
  return out
}

/** A card's title row: the task in the agent's own words, the type only when there is none. */
export const cardTitle = (c: AgentCard) => c.description || c.type

/** A title split over two rows at a word boundary: `first` cells on row one, `rest` on row two. */
export const titleLines = (title: string, first: number, rest: number): [string, string] => {
  const t = title.replace(/\s+/g, ' ').trim()
  if (t.length <= first) return [t, '']
  const cut = t.lastIndexOf(' ', first)
  const at = cut > 0 ? cut : first
  return [t.slice(0, at).trim(), shorten(t.slice(at), rest)]
}

/**
 * What a turn's opening text was, for the log: the person's words, or for a turn the engine
 * opened with a tagged message (a subagent's hand-back, a task notification), that message's kind.
 */
export const promptLine = (text: string): { who: string; text: string } => {
  const tag = /^\s*<([a-z][\w-]*)/i.exec(text)?.[1]
  if (!tag) return { who: 'you', text: shorten(text, 70) }
  const from = /\bfrom="([^"]+)"/.exec(text)?.[1]
  return { who: 'engine', text: shorten(`${tag.replace(/[-_]/g, ' ')}${from ? ` from ${from.slice(0, 8)}` : ''}`, 70) }
}

/**
 * A subagent's hand-back message: who sent it and the first line of what it said. The report
 * follows a framing header in the message; without one, the first line after the opening tag.
 */
export const handbackOf = (text: string): { from: string; body: string } | null => {
  const from = /^\s*<agent-message\s+from="([^"]+)"/.exec(text)?.[1]
  if (!from) return null
  const afterHeader = text.split(/The report follows:\s*\n/)[1]
  const rest = afterHeader ?? text.replace(/^\s*<agent-message[^>]*>/, '')
  const body =
    rest
      .split('\n')
      .map(l => l.trim())
      .find(l => l && !l.startsWith('[') && !l.startsWith('<') && !l.startsWith('</')) ?? ''
  return body ? { from, body } : null
}

/** The advice line a pane shows for a report: its first real line, markdown markers stripped, cut to 160. */
export const adviceLine = (report: string) => {
  const first = report.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('[') && !l.startsWith('<')) ?? ''
  return shorten(first.replace(/\*\*|__/g, '').replace(/^[#>*\s-]+/, ''), 160)
}

export const elapsedOf = (c: AgentCard, now: number) => (c.endedAt ?? now) - c.spawnedAt

// ---------------------------------------------------------------- plan

export const DEFAULT_PLAN: Plan = { tasks: [] }

/** A sample plan for `/flightdeck demo`: two versions, their groups, work done, under way and blocked. */
export const demoPlan = (now: number): Plan => {
  const mk = (id: string, subject: string, group: string, status: TaskStatus, ago: number, blockedBy: string[] = []): PlanTask => ({
    ...blankTask(id),
    subject,
    activeForm: status === 'in_progress' ? `Working on ${subject.toLowerCase()}` : '',
    group: group.split(' / '),
    status,
    blockedBy,
    startedAt: status === 'pending' ? null : now - ago,
    doneAt: status === 'completed' ? now - ago / 2 : null,
  })
  return {
    tasks: [
      mk('d1', 'Pie chart legend', 'v1.2 / Reports', 'completed', 900_000),
      mk('d2', 'Pie chart labels', 'v1.2 / Reports', 'in_progress', 42_000),
      mk('d3', 'Export to PDF', 'v1.2 / Reports', 'pending', 0, ['d2']),
      mk('d4', 'Release notes', 'v1.2 / Docs', 'completed', 600_000),
      mk('d5', 'Cache invalidation', 'v1.2 / API', 'completed', 1_200_000),
      mk('d6', 'Rate limit headers', 'v1.2 / API', 'pending', 0),
      mk('d7', 'Account switch', 'v1.3 / Admin', 'pending', 0),
      mk('d8', 'Audit log', 'v1.3 / Admin', 'pending', 0, ['d7']),
    ],
  }
}

const STATUSES: readonly string[] = ['pending', 'in_progress', 'completed']

/**
 * A task's place in the hierarchy, from its `metadata.group`: "a / b", "a > b" or ["a", "b"].
 * Undefined when the metadata does not name the key, so an update leaves the group as it was;
 * `group: null` (how the API clears a key) is the empty path.
 */
export const groupOf = (metadata: unknown): string[] | undefined => {
  if (!isObject(metadata) || !('group' in metadata)) return undefined
  const g = metadata.group
  const parts = typeof g === 'string' ? g.split(/\s+\/\s+|\s*>\s*/) : Array.isArray(g) ? g.filter((x): x is string => typeof x === 'string') : []
  return parts.map(x => x.trim()).filter(Boolean).slice(0, 4)
}

const blankTask = (id: string): PlanTask => ({
  id,
  subject: '',
  activeForm: '',
  status: 'pending',
  group: [],
  blockedBy: [],
  agents: [],
  startedAt: null,
  doneAt: null,
  source: 'task',
})

export const normalizePlan = (stored: unknown): Plan => {
  const p = normalize(DEFAULT_PLAN, stored)
  const strs = (v: unknown) => listOf<unknown>(v).filter((x): x is string => typeof x === 'string')
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  // Field by field, as normalizeCard does: a stored shape this build cannot read must not break the render.
  const counts = isObject(p.history) ? Object.fromEntries(Object.entries(p.history).filter((e): e is [string, number] => typeof e[1] === 'number')) : {}
  return {
    groups: strs(p.groups),
    history: counts,
    rebuilt: p.rebuilt === true,
    jira: isObject(p.jira) && typeof p.jira.key === 'string' ? (p.jira as unknown as JiraIssue) : null,
    cited: strs(p.cited).slice(-10),
    epic:
      isObject(p.epic) && typeof p.epic.key === 'string'
        ? {
            key: p.epic.key,
            at: typeof p.epic.at === 'number' ? p.epic.at : 0,
            children: listOf<unknown>(p.epic.children)
              .filter(isObject)
              .filter(c => typeof c.key === 'string')
              .map(c => ({
                key: String(c.key),
                summary: str(c.summary),
                type: str(c.type),
                status: str(c.status),
                isDone: c.isDone === true,
                assignee: str(c.assignee),
              })),
          }
        : null,
    tasks: listOf<unknown>(p.tasks)
      .filter(isObject)
      .map(t => ({
        ...blankTask(str(t.id)),
        subject: str(t.subject),
        activeForm: str(t.activeForm),
        status: (STATUSES.includes(str(t.status)) ? t.status : 'pending') as TaskStatus,
        group: strs(t.group),
        blockedBy: strs(t.blockedBy),
        agents: strs(t.agents),
        startedAt: num(t.startedAt),
        doneAt: num(t.doneAt),
        source: t.source === 'todo' ? ('todo' as const) : t.source === 'jira' ? ('jira' as const) : ('task' as const),
      }))
      .filter(t => t.id !== ''),
  }
}

/** Status moves stamp the clock: the first start, and the finish. */
/** `now` is null for a move replayed from the transcript: its time is not known, so none is made up. */
const moved = (t: PlanTask, status: TaskStatus, now: number | null): PlanTask => ({
  ...t,
  status,
  startedAt: status !== 'pending' && t.startedAt === null ? now : t.startedAt,
  doneAt: status === 'completed' ? (t.doneAt ?? now) : null,
})

const MAX_TASKS = 80

/** Past the cap the oldest finished tasks go first: an open or blocking task is never dropped for room. */
const capped = (tasks: PlanTask[]): PlanTask[] => {
  let extra = tasks.length - MAX_TASKS
  if (extra <= 0) return tasks
  // Only finished tasks make room; past the cap with every task open, the list runs long instead.
  return tasks.filter(t => (t.status === 'completed' && extra-- > 0 ? false : true))
}

export const planCreate = (p: Plan, x: { id: string; subject: string; activeForm: string; group?: string[] }): Plan => ({
  ...p,
  tasks: capped([...p.tasks.filter(t => t.id !== x.id), { ...blankTask(x.id), subject: x.subject, activeForm: x.activeForm, group: x.group ?? [] }]),
})

export type PlanUpdate = {
  taskId: string
  status?: string
  subject?: string
  activeForm?: string
  addBlockedBy?: string[]
  /** Tasks this one blocks: each gains this task in its `blockedBy`. */
  addBlocks?: string[]
  group?: string[]
}

export const planUpdate = (p: Plan, x: PlanUpdate, now: number | null): Plan => {
  if (x.status === 'deleted') return { ...p, tasks: p.tasks.filter(t => t.id !== x.taskId) }
  const known = p.tasks.some(t => t.id === x.taskId)
  const tasks = known ? p.tasks : capped([...p.tasks, { ...blankTask(x.taskId), subject: x.subject ?? `task ${x.taskId}` }])
  return {
    ...p,
    tasks: tasks.map(t => {
      if (t.id !== x.taskId) return t
      let n: PlanTask = {
        ...t,
        subject: x.subject ?? t.subject,
        activeForm: x.activeForm ?? t.activeForm,
        group: x.group ?? t.group,
        blockedBy: x.addBlockedBy ? [...new Set([...t.blockedBy, ...x.addBlockedBy])] : t.blockedBy,
      }
      if (x.status && STATUSES.includes(x.status) && x.status !== t.status) n = moved(n, x.status as TaskStatus, now)
      return n
    }).map(t => (x.addBlocks?.includes(t.id) && !t.blockedBy.includes(x.taskId) ? { ...t, blockedBy: [...t.blockedBy, x.taskId] } : t)),
  }
}

/** TodoWrite sends the whole list: it replaces the todo-sourced tasks, matched by their text. */
export const planTodos = (p: Plan, todos: readonly { content: string; status: string; activeForm: string }[], now: number | null): Plan => {
  const old = new Map(p.tasks.filter(t => t.source === 'todo').map(t => [t.subject, t]))
  const fresh = todos.map((td, i) => {
    const prev = old.get(td.content) ?? { ...blankTask(`todo-${i}`), subject: td.content, source: 'todo' as const }
    const status = (STATUSES.includes(td.status) ? td.status : 'pending') as TaskStatus
    return moved({ ...prev, id: `todo-${i}`, activeForm: td.activeForm }, status, now)
  })
  return { ...p, tasks: capped([...p.tasks.filter(t => t.source !== 'todo'), ...fresh]) }
}

/** The task in progress the plan is on: of several, the one started last. */
export const planCurrent = (tasks: readonly PlanTask[]): PlanTask | null =>
  tasks.filter(t => t.status === 'in_progress').reduce<PlanTask | null>((a, t) => (a === null || (t.startedAt ?? 0) >= (a.startedAt ?? 0) ? t : a), null)

/** A subagent belongs to the task in progress when it spawns. */
export const planLinkAgent = (p: Plan, agentId: string): Plan => {
  const host = planCurrent(p.tasks)
  if (!host || host.agents.includes(agentId)) return p
  return { ...p, tasks: p.tasks.map(t => (t.id === host.id ? { ...t, agents: [...t.agents, agentId].slice(-6) } : t)) }
}

/** A subagent that takes a task up itself belongs to that task, not the one it was spawned under. */
export const planLinkTo = (p: Plan, taskId: string, agentId: string): Plan => {
  if (!p.tasks.some(t => t.id === taskId)) return p
  return {
    ...p,
    tasks: p.tasks.map(t =>
      t.id === taskId
        ? { ...t, agents: t.agents.includes(agentId) ? t.agents : [...t.agents, agentId].slice(-6) }
        : { ...t, agents: t.agents.filter(a => a !== agentId) },
    ),
  }
}

export type PlanNode = { label: string; done: number; total: number; children: PlanNode[]; tasks: PlanTask[] }

/** Groups nest by path, in first-seen order; each counts every task beneath it. */
/** Groups nest by path, in first-seen order unless `order` names them (the approved plan's sections). */
export const planTree = (tasks: readonly PlanTask[], order: readonly string[] = []): PlanNode => {
  const root = planTreeRaw(tasks)
  if (order.length === 0) return root
  const rank = (label: string) => {
    const i = order.indexOf(label)
    return i < 0 ? order.length : i
  }
  const sort = (n: PlanNode) => {
    n.children.sort((a, b) => rank(a.label) - rank(b.label))
    n.children.forEach(sort)
  }
  sort(root)
  return root
}

const planTreeRaw = (tasks: readonly PlanTask[]): PlanNode => {
  const root: PlanNode = { label: '', done: 0, total: 0, children: [], tasks: [] }
  for (const t of tasks) {
    let node = root
    const path = [node]
    for (const label of t.group) {
      let child = node.children.find(c => c.label === label)
      if (!child) {
        child = { label, done: 0, total: 0, children: [], tasks: [] }
        node.children.push(child)
      }
      node = child
      path.push(node)
    }
    node.tasks.push(t)
    for (const n of path) {
      n.total += 1
      if (t.status === 'completed') n.done += 1
    }
  }
  return root
}

export type PlanLine = { kind: 'group' | 'task' | 'more'; depth: number; text: string; done: number; total: number; task: PlanTask | null; path: string[] }

/** Where there is open work: down the first unfinished group at each level. */
const openPath = (root: PlanNode): string[] => {
  const path: string[] = []
  let n = root
  for (;;) {
    const next = n.children.find(c => c.done < c.total)
    if (!next) break
    path.push(next.label)
    n = next
  }
  return path
}

/**
 * The plan as an outline that reads at a glance: every group one line with its count, only the
 * group being worked on opened, and in it only the open tasks, the one in progress first.
 * Finished tasks are in the counts, not the list. Past `max` lines the rest is one "more" line.
 */
export const planOutline = (
  root: PlanNode,
  current: PlanTask | null,
  max: number,
  opts: { focus?: readonly string[] | null; showDone?: boolean } = {},
): PlanLine[] => {
  const focus = opts.focus ?? (current ? current.group : openPath(root))
  const out: PlanLine[] = []
  const rank = (t: PlanTask) => (t.status === 'in_progress' ? 0 : 1)
  const walk = (n: PlanNode, depth: number, isFocus: boolean, path: string[]) => {
    if (isFocus && depth === focus.length) {
      const open = n.tasks.filter(t => t.status !== 'completed').sort((a, b) => rank(a) - rank(b))
      for (const t of open) out.push({ kind: 'task', depth, text: t.subject, done: 0, total: 0, task: t, path })
      if (opts.showDone) for (const t of n.tasks.filter(x => x.status === 'completed')) out.push({ kind: 'task', depth, text: t.subject, done: 0, total: 0, task: t, path })
    }
    for (const c of n.children) {
      out.push({ kind: 'group', depth, text: c.label, done: c.done, total: c.total, task: null, path: [...path, c.label] })
      const opens = isFocus && focus[depth] === c.label && (c.done < c.total || opts.focus !== undefined && opts.focus !== null || opts.showDone === true)
      if (opens) walk(c, depth + 1, true, [...path, c.label])
    }
    // Tasks with no group, beside groups: one line of their own unless they are the focus.
    if (depth === 0 && focus.length > 0 && n.tasks.length > 0) {
      out.push({ kind: 'group', depth, text: 'ungrouped', done: n.tasks.filter(t => t.status === 'completed').length, total: n.tasks.length, task: null, path: [] })
    }
  }
  walk(root, 0, true, [])
  if (out.length <= max) return out
  const kept = out.slice(0, Math.max(1, max - 1))
  return [...kept, { kind: 'more', depth: 0, text: `+${out.length - kept.length} more`, done: 0, total: 0, task: null, path: [] }]
}

/** Every path a task counts toward: "v1.2" and "v1.2 / Reports" for ["v1.2", "Reports"]. */
const prefixes = (group: readonly string[]) => group.map((_, i) => group.slice(0, i + 1).join(' / '))

/**
 * Tasks this session finished under each group path. A task replayed from the transcript has no
 * finish time and is left out: the session it was finished in has already counted it.
 */
export const doneByPath = (tasks: readonly PlanTask[]): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const t of tasks) if (t.status === 'completed' && t.doneAt !== null) for (const k of prefixes(t.group)) out[k] = (out[k] ?? 0) + 1
  return out
}

/** Group paths of two tasks or more that this change finished: worth a toast. */
export const groupsFinished = (before: Plan, after: Plan): string[] => {
  const tally = (p: Plan) => {
    const m = new Map<string, { done: number; total: number }>()
    for (const t of p.tasks)
      for (const k of prefixes(t.group)) {
        const x = m.get(k) ?? { done: 0, total: 0 }
        x.total += 1
        if (t.status === 'completed') x.done += 1
        m.set(k, x)
      }
    return m
  }
  const b = tally(before)
  const out: string[] = []
  for (const [k, x] of tally(after)) {
    const was = b.get(k)
    if (x.total >= 2 && x.done === x.total && was && was.done < was.total) out.push(k)
  }
  // The deepest first: "v1.2 / Reports" says more than "v1.2" when both finish at once.
  return out.sort((x, y) => y.split(' / ').length - x.split(' / ').length)
}

/** The section names of an approved plan: its headings, or failing those its top numbered items. */
export const planGroupsOf = (markdown: string): string[] => {
  const clean = (s: string) => s.replace(/[*_`]/g, '').replace(/^\d+[.)]\s*/, '').replace(/^(phase|fase|step|etapa)\s*\d+\s*[:.-]\s*/i, '').trim()
  const lines = markdown.split('\n')
  const heads = lines.filter(l => /^#{2,3}\s+\S/.test(l)).map(l => clean(l.replace(/^#+\s+/, '')))
  const numbered = lines.filter(l => /^\d+[.)]\s+\S/.test(l)).map(clean)
  const pick = (xs: string[]) => [...new Set(xs.filter(x => x.length > 0 && x.length <= 40))]
  const h = pick(heads)
  if (h.length >= 2 && h.length <= 8) return h
  const n = pick(numbered)
  return n.length >= 2 && n.length <= 8 ? n : []
}

/** Time spent under a node: each started task from its start to its finish, or to now. */
export const groupSpent = (n: PlanNode, now: number): number =>
  n.tasks.reduce((sum, t) => sum + (t.startedAt === null ? 0 : Math.max(0, (t.doneAt ?? now) - t.startedAt)), 0) +
  n.children.reduce((sum, c) => sum + groupSpent(c, now), 0)

/** The node at a path, or null. */
export const nodeAt = (root: PlanNode, path: readonly string[]): PlanNode | null => {
  let n: PlanNode | undefined = root
  for (const label of path) n = n?.children.find(c => c.label === label)
  return n ?? null
}

// ---------------------------------------------------------------- plan history across sessions

const HISTORY_DAYS = 14

export type PlanHistory = Record<string, { at: number; done: Record<string, number> }>

/** The project's history with this session's counts written in, entries past two weeks dropped. */
export const historyWith = (stored: unknown, sessionId: string, done: Record<string, number>, now: number): PlanHistory => {
  const out: PlanHistory = {}
  if (isObject(stored))
    for (const [id, v] of Object.entries(stored)) {
      if (!isObject(v) || typeof v.at !== 'number' || !isObject(v.done)) continue
      if (now - v.at > HISTORY_DAYS * 86_400_000) continue
      out[id] = { at: v.at, done: Object.fromEntries(Object.entries(v.done).filter((e): e is [string, number] => typeof e[1] === 'number')) }
    }
  if (Object.keys(done).length > 0) out[sessionId] = { at: now, done }
  return out
}

/** Tasks finished under each path in the project's other sessions. */
export const historyBefore = (stored: unknown, sessionId: string, now: number): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const [id, v] of Object.entries(historyWith(stored, '', {}, now))) {
    if (id === sessionId) continue
    for (const [k, n] of Object.entries(v.done)) out[k] = (out[k] ?? 0) + n
  }
  return out
}

/**
 * One task-tool call applied to the plan: TaskCreate (its id from the result), TaskUpdate (a
 * refused one changes nothing), TodoWrite (the whole list), ExitPlanMode (the plan's sections).
 * `now` is null for a call replayed from the transcript.
 */
export const planApply = (p: Plan, tool: string, input: Record<string, unknown>, result: unknown, now: number | null): Plan => {
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  const res = isObject(result) ? result : {}
  if (tool === 'TaskCreate') {
    const task = isObject(res.task) ? res.task : {}
    const id = str(task.id)
    if (!id) return p
    return planCreate(p, { id, subject: str(input.subject) ?? str(task.subject) ?? '', activeForm: str(input.activeForm) ?? '', group: groupOf(input.metadata) })
  }
  if (tool === 'TaskUpdate') {
    const taskId = str(input.taskId)
    if (!taskId || res.success === false) return p
    const ids = (v: unknown) => (Array.isArray(v) ? v.filter((b): b is string => typeof b === 'string') : undefined)
    return planUpdate(
      p,
      {
        taskId,
        status: str(input.status),
        subject: str(input.subject),
        activeForm: str(input.activeForm),
        addBlockedBy: ids(input.addBlockedBy),
        addBlocks: ids(input.addBlocks),
        group: groupOf(input.metadata),
      },
      now,
    )
  }
  if (tool === 'TodoWrite') {
    const todos = listOf<unknown>(input.todos).filter(
      (t): t is { content: string; status: string; activeForm: string } => isObject(t) && typeof t.content === 'string',
    )
    return planTodos(p, todos, now)
  }
  if (tool === 'ExitPlanMode') {
    // The plan is the tool's input; some builds echo it in the result as well.
    const groups = planGroupsOf(str(res.plan) ?? str(input.plan) ?? '')
    return groups.length > 0 ? { ...p, groups } : p
  }
  return p
}

// ---------------------------------------------------------------- jira

/**
 * Issue keys in a text, as people type them: ABC-407, abc-407 or abc 407, each as ABC-407. A
 * word and a number that is no issue ("page 10") is harmless: only an issue Claude reads anchors.
 */
export const jiraKeysIn = (text: string): string[] => [
  ...new Set([...text.matchAll(/\b([a-z][a-z0-9]{1,9})[- ](\d{1,7})\b/gi)].map(m => `${(m[1] ?? '').toUpperCase()}-${m[2]}`)),
]

const refOf = (x: unknown): JiraRef | null => {
  if (!isObject(x) || typeof x.key !== 'string') return null
  const f = isObject(x.fields) ? x.fields : {}
  const status = isObject(f.status) ? f.status : {}
  const cat = isObject(status.statusCategory) ? status.statusCategory : {}
  return {
    key: x.key,
    summary: typeof f.summary === 'string' ? f.summary : '',
    type: isObject(f.issuetype) && typeof f.issuetype.name === 'string' ? f.issuetype.name : '',
    status: typeof status.name === 'string' ? status.name : '',
    isDone: cat.key === 'done',
  }
}

/**
 * A Jira issue from a getJiraIssue result, however the connector hands it over: the issue
 * itself, its JSON as text, or MCP content blocks holding that text. Null when it holds none.
 */
export const jiraIssueOf = (result: unknown, site: string | null = null): JiraIssue | null => {
  let x: unknown = result
  if (isObject(x) && Array.isArray(x.content)) x = x.content.map(b => (isObject(b) && typeof b.text === 'string' ? b.text : '')).join('')
  if (Array.isArray(x)) x = x.map(b => (isObject(b) && typeof b.text === 'string' ? b.text : '')).join('')
  if (typeof x === 'string') {
    try {
      x = JSON.parse(x)
    } catch {
      return null
    }
  }
  const ref = refOf(x)
  if (!ref || !isObject(x) || !isObject(x.fields)) return null
  const f = x.fields
  return {
    ...ref,
    assignee: isObject(f.assignee) && typeof f.assignee.displayName === 'string' ? f.assignee.displayName : '',
    site,
    parent: refOf(f.parent),
    subtasks: listOf<unknown>(f.subtasks).map(refOf).filter((r): r is JiraRef => r !== null).slice(0, 20),
  }
}

/** The browse site from a getJiraIssue call's cloudId when it names one (`acme.atlassian.net`). */
export const jiraSiteOf = (cloudId: unknown): string | null =>
  typeof cloudId === 'string' && /^[\w-]+\.atlassian\.net$/i.test(cloudId.replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    ? `https://${cloudId.replace(/^https?:\/\//, '').replace(/\/.*$/, '')}`
    : null

/** A group label for an issue: its key and a short summary, no group separators inside. */
export const jiraLabel = (r: JiraRef) => `${r.key} ${shorten(r.summary.replace(/\s*[/>]\s*/g, ' - '), 40)}`.trim()

/**
 * The plan's root for an issue: a subtask sits under its story, a story or task is the root
 * itself, and its subtasks are the groups beneath. Paths, outermost first.
 */
export const jiraRoot = (j: JiraIssue): string[] => (j.parent && j.subtasks.length === 0 ? [jiraLabel(j.parent), jiraLabel(j)] : [jiraLabel(j)])

/**
 * Placeholders for the issue's open Jira subtasks that Claude's own tasks do not cover yet, so
 * the plan shows the work Jira expects; a finished one counts as done. Not stored: drawn.
 */
export const jiraSkeleton = (j: JiraIssue | null | undefined, tasks: readonly PlanTask[]): PlanTask[] => {
  if (!j) return []
  const root = jiraRoot(j)
  return j.subtasks
    .filter(s => {
      const path = [...root, jiraLabel(s)].join(' / ')
      return !tasks.some(t => t.group.join(' / ') === path || t.group.join(' / ').startsWith(`${path} / `))
    })
    .map(s => ({
      ...blankTask(`jira-${s.key}`),
      subject: `${s.summary || s.key}`,
      status: s.isDone ? ('completed' as const) : ('pending' as const),
      group: [...root, jiraLabel(s)],
      source: 'jira' as const,
    }))
}

/** What the prompt tells Claude about the anchored issue: the group paths to file tasks under. */
export const jiraHint = (j: JiraIssue): string => {
  const root = jiraRoot(j)
  const subs = j.subtasks.filter(s => !s.isDone).map(s => `"${[...root, jiraLabel(s)].join(' / ')}"`)
  return (
    `The work is anchored to Jira ${j.key} (${j.type || 'issue'}: ${j.summary})${j.parent ? `, under ${j.parent.key} (${j.parent.type}: ${j.parent.summary})` : ''}. ` +
    `File its tasks under the group path "${root.join(' / ')}"` +
    (subs.length > 0 ? `, and where a task belongs to one of its Jira subtasks, under that subtask's path: ${subs.slice(0, 8).join(', ')}.` : '.')
  )
}

// ---------------------------------------------------------------- git

export const DEFAULT_GIT: Git = { repos: [], at: 0 }

/** `git status --porcelain=v2 --branch`: the branch, its upstream and counts, and the files by state. */
export const parseGitStatus = (stdout: string, name: string): GitRepo => {
  const repo: GitRepo = { name, branch: '', ahead: 0, behind: 0, base: null, baseAhead: 0, baseBehind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0 }
  for (const line of stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) repo.branch = line.slice(14).trim()
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line)
      if (m) [repo.ahead, repo.behind] = [Number(m[1]), Number(m[2])]
    } else if (line.startsWith('? ')) repo.untracked += 1
    else if (line.startsWith('u ')) repo.conflicts += 1
    else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const xy = line.slice(2, 4)
      if (xy[0] !== '.') repo.staged += 1
      if (xy[1] !== '.') repo.modified += 1
    }
  }
  if (repo.branch === '(detached)') repo.branch = 'detached'
  return repo
}

/** `git rev-list --left-right --count base...HEAD`: behind, then ahead. */
export const parseAheadBehind = (stdout: string): { ahead: number; behind: number } | null => {
  const m = /^(\d+)\s+(\d+)/.exec(stdout.trim())
  return m ? { behind: Number(m[1]), ahead: Number(m[2]) } : null
}

/** The branches a feature branch is measured against, in order; the first that exists wins. */
export const GIT_BASES = ['origin/dev', 'origin/develop', 'origin/main', 'origin/master'] as const

/** `git for-each-ref --format=%(refname:short)` over the candidates: the first base present, in GIT_BASES order. */
export const pickBase = (stdout: string): string | null => {
  const have = new Set(stdout.split('\n').map(x => x.trim()))
  return GIT_BASES.find(b => have.has(b)) ?? null
}
const TRUNKS = new Set(['dev', 'develop', 'main', 'master'])
export const isTrunk = (branch: string) => TRUNKS.has(branch)

/** Repos with work in them first, then by name. */
export const sortRepos = (repos: readonly GitRepo[]): GitRepo[] => {
  const dirty = (r: GitRepo) => r.staged + r.modified + r.untracked + r.conflicts + r.ahead
  return [...repos].sort((a, b) => Number(dirty(b) > 0) - Number(dirty(a) > 0) || a.name.localeCompare(b.name))
}

export const normalizeGit = (stored: unknown): Git => {
  const g = normalize(DEFAULT_GIT, stored)
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const repos = listOf<unknown>(g.repos)
    .filter(isObject)
    .map(r => ({
      name: String(r.name ?? ''),
      branch: String(r.branch ?? ''),
      ahead: n(r.ahead),
      behind: n(r.behind),
      base: typeof r.base === 'string' ? r.base : null,
      baseAhead: n(r.baseAhead),
      baseBehind: n(r.baseBehind),
      staged: n(r.staged),
      modified: n(r.modified),
      untracked: n(r.untracked),
      conflicts: n(r.conflicts),
    }))
  return { repos, at: n(g.at) }
}

/** The prompt's ask when every piece of multi-step work becomes tasks, filed under its phase. */
export const planPolicyHint = (phases: readonly string[]) =>
  'Break any work of two steps or more into tasks with TaskCreate before you start it, one task per step, and keep them current with TaskUpdate ' +
  '(one in_progress at a time when the work is sequential, completed only when the step is really done). ' +
  `File each task under its phase: set metadata.group to "<the work> / <phase>", the phase one of ${phases.map(p => `"${p}"`).join(', ')} in that order, ` +
  'and the work a short name for the feature, bug or request, the exact same name for every task of it. ' +
  'Spawn a subagent while the task it serves is in_progress, so it is shown under that task. ' +
  'Skip tasks for a single quick step or a question that needs no changes.'

// ---------------------------------------------------------------- sections

export const DECK_SECTIONS: readonly DeckSection[] = ['title', 'header', 'pet', 'git', 'github', 'epic', 'plan', 'architect', 'agents', 'timeline', 'log']

/** Section names as typed: the plan view's own, with a few spellings people reach for. */
export const deckSectionOf = (word: string): DeckSection | null => {
  const w = word.trim().toLowerCase()
  const alias: Record<string, DeckSection> = { arquiteto: 'architect', advisor: 'architect', agentes: 'agents', subagents: 'agents', epico: 'epic', épico: 'epic', jira: 'epic', 'linha-do-tempo': 'timeline', gantt: 'timeline', session: 'log', 'session-log': 'log', logs: 'log', tasks: 'plan', cabecalho: 'header', cabeçalho: 'header', mascote: 'pet', mascot: 'pet', clawd: 'pet', titulo: 'title', título: 'title', gh: 'github', pr: 'github', prs: 'github', 'pull-requests': 'github' }
  return (DECK_SECTIONS as readonly string[]).includes(w) ? (w as DeckSection) : alias[w] ?? null
}

/** A stored hidden list, unknown names dropped. */
export const hiddenOf = (stored: unknown): DeckSection[] =>
  [...new Set(listOf<unknown>(stored).filter((x): x is DeckSection => typeof x === 'string' && (DECK_SECTIONS as readonly string[]).includes(x)))]

// ---------------------------------------------------------------- epic

/** The issue whose children make the epic view: the anchored issue's parent, or the issue itself when it has none. */
export const epicKeyOf = (j: JiraIssue | null | undefined): string | null => (j ? (j.parent?.key ?? j.key) : null)

/**
 * The epic a JQL search lists every child of: `parent = ABC-300`, `"Epic Link" = ABC-300` or
 * `parentEpic = ABC-300`, an ORDER BY allowed. A filtered search (`AND status != Done`, `parent in
 * (A, B)`) lists only some, so it is not taken for the epic: null.
 */
export const jqlParentKey = (jql: unknown): string | null => {
  if (typeof jql !== 'string') return null
  const m = /^\s*(?:parent(?:Epic)?|"epic link"|'epic link')\s*=\s*["']?([a-z][a-z0-9]{1,9}-\d{1,7})["']?\s*(?:order\s+by\s+[\w\s,"']+)?$/i.exec(jql)
  return m?.[1] ? m[1].toUpperCase() : null
}

/** The issues of a searchJiraIssuesUsingJql result, however the connector hands them over; null when it holds no issue list. */
export const jiraSearchOf = (result: unknown): JiraChild[] | null => {
  let x: unknown = result
  if (isObject(x) && Array.isArray(x.content)) x = x.content.map(b => (isObject(b) && typeof b.text === 'string' ? b.text : '')).join('')
  if (Array.isArray(x) && x.every(b => isObject(b) && typeof b.text === 'string' && !('key' in b))) x = x.map(b => (b as { text: string }).text).join('')
  if (typeof x === 'string') {
    try {
      x = JSON.parse(x)
    } catch {
      return null
    }
  }
  const found = Array.isArray(x) ? x : isObject(x) ? (x.issues ?? x.values ?? (isObject(x.data) ? x.data.issues : undefined)) : undefined
  if (!Array.isArray(found)) return null
  return found
    .map(i => {
      const ref = refOf(i)
      if (!ref) return null
      const f = isObject(i) && isObject(i.fields) ? i.fields : {}
      return { ...ref, assignee: isObject(f.assignee) && typeof f.assignee.displayName === 'string' ? f.assignee.displayName : '' }
    })
    .filter((c): c is JiraChild => c !== null)
    .slice(0, 50)
}

export type EpicView = {
  /** The issue heading the view: the epic, or the anchored issue when it has no parent. */
  head: JiraRef
  /** Children in reading order: the anchored issue first, then the open ones, then the finished. */
  rows: (JiraChild & { isAnchor: boolean })[]
  done: number
  total: number
  /** Children are the epic's own as read by a search; false: the anchored issue's subtasks stand in. */
  isRead: boolean
}

/** What the epic section draws, from the anchored issue and, once read, its epic's children. */
export const epicView = (j: JiraIssue | null | undefined, epic: JiraEpic | null | undefined): EpicView | null => {
  if (!j) return null
  const key = epicKeyOf(j)
  const isRead = Boolean(epic && epic.key === key)
  const head: JiraRef = j.parent ?? j
  const kids: JiraChild[] = isRead && epic ? epic.children : j.parent ? [{ ...j, assignee: j.assignee }] : j.subtasks.map(s => ({ ...s, assignee: '' }))
  // The anchored issue as read last, over the epic's older snapshot of it.
  const fresh = kids.map(c => (c.key === j.key ? { ...c, summary: j.summary || c.summary, status: j.status || c.status, isDone: j.isDone, assignee: j.assignee || c.assignee } : c))
  const rank = (c: JiraChild) => (c.key === j.key ? 0 : c.isDone ? 2 : 1)
  const rows = [...fresh].sort((a, b) => rank(a) - rank(b)).map(c => ({ ...c, isAnchor: c.key === j.key }))
  return { head, rows, done: fresh.filter(c => c.isDone).length, total: fresh.length, isRead }
}

// ---------------------------------------------------------------- timeline

export type TimelineItem = { id: string; label: string; kind: 'task' | 'agent' | 'architect'; start: number; end: number | null; isFailed?: boolean }

export type TimelineRow = TimelineItem & {
  /** Cells before the bar, the bar's own, and after it, summing to the width. */
  pre: number
  bar: number
  post: number
}

/**
 * Items on one time axis from the earliest shown start to now, each a bar of at least one cell,
 * the latest `max` by start, oldest first, so overlap shows what ran side by side.
 */
export const timelineRows = (items: readonly TimelineItem[], now: number, width: number, max: number): { t0: number; rows: TimelineRow[] } => {
  const shown = [...items].filter(i => i.start <= now).sort((a, b) => a.start - b.start).slice(-Math.max(0, max))
  if (shown.length === 0 || width < 4) return { t0: now, rows: [] }
  const t0 = Math.min(...shown.map(i => i.start))
  const span = Math.max(1, now - t0)
  const cell = (t: number) => Math.min(width - 1, Math.max(0, Math.floor(((t - t0) / span) * width)))
  const rows = shown.map(i => {
    const a = cell(i.start)
    const b = Math.max(a, i.end === null ? width - 1 : cell(i.end))
    return { ...i, pre: a, bar: b - a + 1, post: width - 1 - b }
  })
  return { t0, rows }
}

// ---------------------------------------------------------------- architect and agents

/** A report handed back later (a background consult) is that consult's advice, and the latest. */
export const adviseConsult = (a: Architect, id: string | null, advice: string): Architect => ({
  ...a,
  consults: a.consults.map(c => (id !== null && c.id === id ? { ...c, advice } : c)),
  lastAdvice: advice,
})


export type AgentKind = { type: string; total: number; running: number; failed: number; models: string[]; avgMs: number | null }

/** The session's agents by type, the busiest first: how many, how many still running or failed, their models and typical time. */
export const agentKinds = (cards: readonly AgentCard[], now: number): AgentKind[] => {
  const by = new Map<string, AgentCard[]>()
  for (const c of cards) by.set(c.type, [...(by.get(c.type) ?? []), c])
  return [...by.entries()]
    .map(([type, cs]) => {
      const ended = cs.filter(c => c.status !== 'running' && c.endedAt !== null)
      return {
        type,
        total: cs.length,
        running: cs.filter(c => c.status === 'running').length,
        failed: cs.filter(c => c.status === 'failed').length,
        models: [...new Set(cs.map(c => c.model).filter(Boolean))],
        avgMs: ended.length > 0 ? ended.reduce((n, c) => n + ((c.endedAt ?? now) - c.spawnedAt), 0) / ended.length : null,
      }
    })
    .sort((x, y) => y.running - x.running || y.total - x.total || x.type.localeCompare(y.type))
}

// ---------------------------------------------------------------- account (cswap)

/** One account as `cswap list --json` lists it: its windows as the pane keeps limits. */
export type CswapAccount = Account['accounts'][number]

export const DEFAULT_ACCOUNT: Account = { status: 'off', active: null, accounts: [], at: null, switchedAt: null, error: null }

/**
 * How long after a switch the session's own limits may still be the old account's: on macOS cswap
 * writes the Keychain, and Claude Code keeps the token it read from there for about 30 seconds.
 */
export const SWITCH_HOLD_MS = 35_000

export const isHolding = (a: Account, now: number) => a.switchedAt !== null && now - a.switchedAt < SWITCH_HOLD_MS

/**
 * The limits the header draws: the session's own, as the API reported them; cswap's reading of the
 * active account while the session has none, or while a switch is fresh and the session's may
 * still be the old account's. `isCswap` marks cswap's, a cached reading rather than a live one.
 */
export const shownLimits = (sessionLimits: Usage['limits'], a: Account, now: number): { limits: Usage['limits']; isCswap: boolean } => {
  const own = a.status === 'ok' ? (a.accounts.find(x => x.isActive)?.limits ?? []) : []
  if ((sessionLimits.length === 0 || isHolding(a, now)) && own.length > 0) return { limits: own, isCswap: true }
  return { limits: isHolding(a, now) ? [] : sessionLimits, isCswap: false }
}

const cswapWindow = (kind: string, w: unknown): Usage['limits'][number] | null => {
  if (!w || typeof w !== 'object') return null
  const { pct, resetsAt } = w as { pct?: unknown; resetsAt?: unknown }
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null
  const at = typeof resetsAt === 'string' ? Date.parse(resetsAt) : NaN
  return { kind, pct, resetsAt: Number.isFinite(at) ? at : null }
}

/** `cswap list --json`'s accounts, or null when the output is not that shape. */
export const parseCswapList = (stdout: string): CswapAccount[] | null => {
  let d: unknown
  try {
    d = JSON.parse(stdout)
  } catch {
    return null
  }
  const xs = d && typeof d === 'object' ? (d as { accounts?: unknown }).accounts : null
  if (!Array.isArray(xs)) return null
  return xs.flatMap(x => {
    if (!x || typeof x !== 'object') return []
    const a = x as { number?: unknown; email?: unknown; organizationName?: unknown; active?: unknown; usage?: { fiveHour?: unknown; sevenDay?: unknown } | null }
    if (typeof a.number !== 'number' || typeof a.email !== 'string') return []
    const limits = [cswapWindow('five_hour', a.usage?.fiveHour), cswapWindow('seven_day', a.usage?.sevenDay)].filter((l): l is Usage['limits'][number] => l !== null)
    return [{ number: a.number, email: a.email, org: typeof a.organizationName === 'string' ? a.organizationName : '', isActive: a.active === true, limits }]
  })
}

/** `cswap switch --json`'s answer: whether it switched, to whom, and what to tell the person. */
export const parseCswapSwitch = (stdout: string): { isSwitched: boolean; to: string | null; message: string } | null => {
  let d: unknown
  try {
    d = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!d || typeof d !== 'object') return null
  const r = d as { switched?: unknown; to?: { email?: unknown } | null; message?: unknown; error?: { message?: unknown } | null }
  if (r.error && typeof r.error === 'object') return { isSwitched: false, to: null, message: typeof r.error.message === 'string' ? r.error.message : 'cswap failed' }
  if (typeof r.switched !== 'boolean') return null
  return { isSwitched: r.switched, to: typeof r.to?.email === 'string' ? r.to.email : null, message: typeof r.message === 'string' ? r.message : '' }
}

/**
 * What `/os-deck account <arg>` hands cswap as the switch target: a slot number, an e-mail or an
 * alias; `next` (or nothing) rotates, as bare `cswap switch` does. Anything else is refused, and no
 * target can start with `-`, so it never reads as an option.
 */
export const switchTargetOf = (arg: string): { target: string | null } | null => {
  const a = arg.trim()
  if (a === '' || a === 'next' || a === 'próxima' || a === 'proxima') return { target: null }
  if (/^\d{1,3}$/.test(a)) return { target: a }
  if (a.length <= 254 && /^[^\s@-][^\s@]*@[^\s@]+\.[^\s@]+$/.test(a)) return { target: a }
  if (/^[a-z0-9][\w.-]{0,31}$/i.test(a)) return { target: a }
  return null
}
