// From a task's events to its claim, and from claims to the runs they are owed. Pure. A claim has three
// ways to say it must not verify (no baseline, an overlap, an edit outside), and whatever is not known,
// or was too much to keep, becomes one of them.
import type { ProofAttempt, ProofChange, ProofClaim } from '../../types'
import { redact } from '../redact'
import type { Lifecycle, OpenTask } from './model'
import { foldDrive, slashed } from './names'
import { changedPaths, isLocalPath, samePath } from './revision'

const MAX_OPEN = 64
/** With those waiting, which hold no baseline. */
const MAX_HELD = 512
/** Of all baselines together: each is a whole listing of a repository, kept in session state. */
const MAX_BASELINE_FILES = 100_000
/** Past this a claim keeps some of its paths, to run and to show, and cannot verify. */
const MAX_CHANGED = 5_000
const MAX_EDITS = 256
const MAX_EDITORS = 16
/** The longest path kept by name, or walked to see where it leads. */
export const MAX_PATH = 1024
const MAX_OVERLAP = 16
const MAX_DESCRIPTIONS = 200
const MAX_TEXT = 2_000
const MAX_SUBJECT = 200
/** A task named in more than this is never known again, so its claim is never drawn. */
const MAX_NAMED = 4_000
const MAX_ID = 128

/** Stands for the tasks there was no room to track. It never ends: when they would is not known. */
const UNTRACKED = '*'
/** Stands for edits there was no room to keep. No path, so inside no root. */
const UNKEPT = 'edits that could not all be kept'

// ---------------------------------------------------------------- paths

/**
 * One spelling for an absolute path, ending in a slash; null where what it names is not certain. Only
 * a drive's letter is folded: a folder of Windows can be case-sensitive, and an edit arrives as the disk spells it.
 */
const spellPath = (path: string): string | null => {
  if (!isLocalPath(path)) return null
  const onWindows = /^[A-Za-z]:/.test(path)
  const text = foldDrive(slashed(path))
  const [top, ...parts] = text.split('/')
  const kept: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      kept.pop()
      continue
    }
    // Windows drops an ending dot or space, and reads a colon as a stream.
    if (onWindows && /[. ]$|:/.test(part)) return null
    kept.push(part)
  }
  return `${[top, ...kept].join('/')}/`
}

const isInside = (path: string, roots: readonly string[]) => {
  const at = spellPath(path)
  if (!at) return false
  return roots.some(root => {
    const top = spellPath(root)
    return top !== null && at.startsWith(top)
  })
}

// ---------------------------------------------------------------- overlap

// Any one name blocks verified, so dropping the rest loses nothing.
const withName = (names: string[], name: string) => (names.includes(name) || names.length >= MAX_OVERLAP ? names : [...names, name])

const overlappedBy = (open: readonly OpenTask[], taskId: string) =>
  open.map(task => (task.waiting ? task : { ...task, overlap: withName(task.overlap, taskId.slice(0, MAX_ID)) }))

// ---------------------------------------------------------------- tasks

export const describeTask: Lifecycle['describeTask'] = (t, taskId, text) => {
  if (taskId.length > MAX_ID) return t
  const others = t.descriptions.filter(([id]) => id !== taskId)
  return { ...t, descriptions: [...others, [taskId, redact(text).slice(0, MAX_TEXT)] as [string, string]].slice(-MAX_DESCRIPTIONS) }
}

export const startTask: Lifecycle['startTask'] = (t, x) => {
  // Started again while open: still the one interval, so the first baseline and all seen since stand.
  const open = t.open.find(o => o.taskId === x.taskId)
  if (open && !open.waiting) return t
  const others = t.open.filter(o => o !== open)
  const isTracked = x.taskId !== UNTRACKED && x.taskId.length <= MAX_ID && others.filter(o => !o.waiting).length < MAX_OPEN && others.length < MAX_HELD
  const taskId = isTracked ? x.taskId : UNTRACKED
  if (others.some(o => o.taskId === taskId)) return t

  const held = [...others.flatMap(o => o.start), ...x.start].reduce((n, m) => n + m.files.length, 0)
  const keepsBaseline = isTracked && held <= MAX_BASELINE_FILES
  const task: OpenTask = {
    taskId,
    at: x.at,
    start: keepsBaseline ? [...x.start] : [],
    unread: keepsBaseline ? [...x.unread] : [...x.unread, ...x.start.map(m => m.root)],
    // One that waited keeps all that was seen of it: only its baseline is new.
    edits: open?.edits ?? [],
    editors: open?.editors ?? [],
    overlap: others.filter(o => !o.waiting).map(o => o.taskId).reduce(withName, open?.overlap ?? []),
  }
  return { ...t, open: [...overlappedBy(others, taskId), task] }
}

// Which task made an edit is not known, so it is every open one's.
export const noteEdit: Lifecycle['noteEdit'] = (t, path, editor) => ({
  ...t,
  open: t.open.map(before => {
    // What is done while it waits is not its work.
    if (before.waiting) return before
    const isKept = before.editors.includes(editor) || before.editors.length >= MAX_EDITORS
    const task = isKept ? before : { ...before, editors: [...before.editors, editor] }
    // Inside what the task started with it can never count as outside: not kept, so the room is for those that can.
    if (isInside(path, [...task.start.map(m => m.root), ...task.unread])) return task
    const kept = task.edits.length >= MAX_EDITS || path.length > MAX_PATH ? UNKEPT : path
    return task.edits.includes(kept) ? task : { ...task, edits: [...task.edits, kept] }
  }),
})

// The others keep its name in their overlap: that it worked meanwhile stays true.
export const dropTask: Lifecycle['dropTask'] = (t, taskId) => ({ ...t, open: t.open.filter(o => o.taskId === UNTRACKED || o.taskId !== taskId) })

/** All of a task's words: cut, a claim would pass to whatever was written after the cut. */
const nameOf = (task: { subject: string; group: readonly string[] }): string | undefined => {
  const named = JSON.stringify([redact(task.subject), task.group])
  return named.length > MAX_NAMED ? undefined : named
}

export const waitTask: Lifecycle['waitTask'] = (t, taskId) => ({
  ...t,
  open: t.open.map(o =>
    o.taskId === taskId && o.taskId !== UNTRACKED ? { ...o, waiting: true, start: [], unread: [...new Set([...o.unread, ...o.start.map(m => m.root)])] } : o,
  ),
})

/** Above every number seen, not the count: older claims are pruned, and a reused id would inherit a review. */
const nextClaimId = (claims: readonly ProofClaim[], session: string, taskId: string) => {
  const prefix = `${session}:${taskId}:`
  let last = 0
  for (const { id } of claims) {
    const number = id.startsWith(prefix) ? id.slice(prefix.length) : ''
    if (/^\d{1,9}$/.test(number)) last = Math.max(last, Number(number))
  }
  return `${prefix}${last + 1}`
}

export const completeTask: Lifecycle['completeTask'] = (t, x) => {
  const task = t.open.find(o => o.taskId === x.taskId && o.taskId !== UNTRACKED)
  const others = t.open.filter(o => o !== task)

  const isSame = (c: ProofClaim) => c.session === x.session && c.taskId === x.taskId
  // A baseline older than this task's last completion is that completion's, left by a start recorded late.
  let hasBaseline = task !== undefined && !task.waiting && !x.claims.some(c => isSame(c) && c.at > task.at)
  const changes: ProofChange[] = []
  const outside: string[] = []
  if (task) {
    const meanwhile = x.claims.filter(c => !isSame(c) && c.at > task.at && c.at <= x.at)
    // An agent that is neither the claimant nor its helper edited while it worked.
    const other = task.editors.find(id => id !== (x.agentId ?? '') && !x.helpers.includes(id))
    const byOther = other === undefined ? [] : [other ? `agent ${other}`.slice(0, MAX_ID) : 'the main agent']
    const names = [...byOther, ...task.overlap, ...others.filter(o => !o.waiting).map(o => o.taskId), ...meanwhile.map(c => (c.session === x.session ? c.taskId : c.id))]
    const overlap = names.reduce(withName, [])
    // Every root known at either end must have been allowed and read at both.
    const roots = new Set([...x.roots, ...task.start.map(m => m.root), ...task.unread, ...x.end.map(m => m.root), ...x.unread])
    for (const root of roots) {
      const from = task.start.find(m => m.root === root)
      const to = x.end.find(m => m.root === root)
      if (!from || !to || !x.roots.includes(root) || task.unread.includes(root) || x.unread.includes(root)) {
        hasBaseline = false
        continue
      }
      const paths = changedPaths(new Map(from.files), new Map(to.files))
      if (paths.length > MAX_CHANGED) hasBaseline = false
      if (paths.length > 0) changes.push({ root, paths: paths.slice(0, MAX_CHANGED), overlap: [...overlap] })
    }
    for (const path of task.edits) if (!isInside(path, x.roots)) outside.push(redact(path))
  }

  return {
    // Marked even where its start was not seen: it worked while these did, for how long is not known.
    tracking: { ...t, open: overlappedBy(others, x.taskId) },
    claim: {
      id: nextClaimId(x.claims, x.session, x.taskId),
      session: x.session,
      taskId: x.taskId,
      subject: redact(x.subject).slice(0, MAX_SUBJECT),
      named: nameOf({ subject: x.subject, group: x.group ?? [] }),
      description: t.descriptions.find(([id]) => id === x.taskId)?.[1] ?? '',
      agentId: x.agentId,
      at: x.at,
      hasBaseline,
      changes,
      outside,
      withdrawn: false,
    },
  }
}

export const withdrawClaims: Lifecycle['withdrawClaims'] = (claims, session, taskId) =>
  claims.map(c => (c.session === session && c.taskId === taskId && !c.withdrawn ? { ...c, withdrawn: true } : c))

/** Whether a claim is of this task as it reads: an id can be renamed or used again. */
export const isClaimOf = (claim: ProofClaim, task: { subject: string; group: readonly string[] }) =>
  claim.named !== undefined && claim.named === nameOf(task)

/**
 * Whether a task's claims no longer stand: an id is not a task, so deleted, reopened, renamed or used
 * again, what was claimed is claimed no longer, whatever the plan remembered of it.
 */
export const endsClaims = (held: readonly ProofClaim[], now: { task: { status: string; subject: string; group: readonly string[] } | undefined; created: boolean }) => {
  const { task, created } = now
  return held.length > 0 && (created || !task || task.status !== 'completed' || held.some(c => !isClaimOf(c, task)))
}

// ---------------------------------------------------------------- runs

/** The claims as runs are owed by them: with no baseline, what a task changed could be in any root. */
export const asOwing = (claims: readonly ProofClaim[], roots: readonly string[]): ProofClaim[] =>
  claims.map(c => (c.hasBaseline ? c : { ...c, changes: roots.map(root => ({ root, paths: [{ path: '', hash: null }], overlap: [] })) }))

export const rootsToRun: Lifecycle['rootsToRun'] = x => {
  if (!x.session) return []
  // One to a root, the later of two.
  const grants = new Map(x.grants.filter(g => g.session === x.session).map(g => [g.root, g]))
  const held = [...x.paused, ...x.busy]
  const owed: string[] = []
  for (const { root, digest, auto, at: allowedAt } of grants.values()) {
    if (!auto || held.some(h => samePath(h, root))) continue
    let last: ProofAttempt | null = null
    let autoRuns = 0
    for (const a of x.attempts) {
      if (a.session !== x.session || a.root !== root || a.digest !== digest || a.stopped) continue
      if (a.trigger === 'auto') autoRuns += 1
      // The verdict's choice: of those under this allowance, the one recorded last.
      if (a.startedAt >= allowedAt) last = a
    }
    const changedIt = x.claims.filter(c => c.session === x.session && c.changes.some(change => change.root === root && change.paths.length > 0))
    // The clock says which claims are newer; only a count can end the runs. Each automatic one used up
    // a claim, the earliest recorded, so a clock set back cannot make more runs than there were claims.
    const isOwed = changedIt.slice(autoRuns).some(c => !c.withdrawn && (last === null || c.at > last.startedAt))
    if (isOwed) owed.push(root)
  }
  return owed
}

// ---------------------------------------------------------------- for the review

const TEST_FOLDER = /(?:^|\/)(?:(?:[^/]*[._-])?tests?|__tests__|__mocks__|__snapshots__|specs?|e2e|testing|testdata|fixtures|cypress|gut|gdunit4)\//
const TEST_NAME = /(?:^|[._-])(?:tests?|specs?|e2e|snap|conftest|pytest|setuptests)(?:[._-]|$)/
/** PlayerTest.gd, TestPlayer.gd: only the capital tells them from latest.gd. */
const TEST_CLASS = /^(?:Test[A-Z_].*|.*[a-z0-9]Tests?)\.(?:gd|cs|py|[cm]?[jt]sx?)$/
const SCRIPT_FOLDER = /(?:^|\/)(?:scripts?|\.husky|\.github\/(?:workflows|actions))\/|^(?:tools|bin|ci)\//
/** In Godot a scripts folder holds the game's own code. */
const GAME_CODE = /\.(?:gd|cs|gdshader|tscn|tres|uid)$/
const SCRIPT_FILE = /\.(?:sh|bash|zsh|ps1|bat|cmd|mk)$/
const CONFIG_FILES = new Set([
  'package.json', 'bunfig.toml', '.npmrc', '.pnpmfile.cjs', 'deno.json', 'deno.jsonc', 'turbo.json', 'nx.json', 'biome.json', 'biome.jsonc',
  'makefile', 'gnumakefile', 'justfile', '.justfile', 'taskfile.yml', 'taskfile.yaml', '.gitlab-ci.yml',
  'pyproject.toml', 'setup.cfg', 'setup.py', 'tox.ini', 'noxfile.py', '.coveragerc', 'mypy.ini', '.mypy.ini', 'ruff.toml', '.ruff.toml', 'pyrightconfig.json', '.flake8', 'pylintrc',
  'project.godot', '.gutconfig.json', 'gdlintrc', '.gdlintrc',
])
const CONFIG_NAME =
  /^(?:(?:vite|vitest|jest|playwright|cypress|karma|ava|babel|eslint|mocha|wdio|stryker)\.(?:config|workspace|setup|preset)\.|\.(?:mocha|eslint|nyc|c8|tap|jest|babel|yarn|pylint)rc(?:\.|$)|[jt]sconfig(?:\..+)?\.json$)/

const isReviewWorthy = (path: string) => {
  const lower = path.toLowerCase()
  const name = lower.slice(lower.lastIndexOf('/') + 1)
  if (TEST_FOLDER.test(lower) || TEST_NAME.test(name) || TEST_CLASS.test(path.slice(path.lastIndexOf('/') + 1))) return true
  if (CONFIG_FILES.has(name) || CONFIG_NAME.test(name) || SCRIPT_FILE.test(name)) return true
  return SCRIPT_FOLDER.test(lower) && !GAME_CODE.test(name)
}

export const reviewWorthy: Lifecycle['reviewWorthy'] = paths => paths.filter(isReviewWorthy)
