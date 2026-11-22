// Agent Proof's orchestration: the engine's events and a person's presses in, session state out. The
// decisions are the pure modules'; what is here is order, and who may cause what. Task events go
// through one queue in the order they arrived; runs go through another, so neither waits on checks.
import type { EngineInterface } from 'claude-code'

import type { Plan, ProofAttempt, ProofCheck, ProofClaim } from '../../types'
import { EDIT_TOOLS, shorten } from '../core'
import { redact } from '../redact'
import { runAttempt } from './attempt'
import { digestOf, grantFrom } from './grant'
import { loadRecords, saveAttempt, saveChecks, saveClaim, saveReview } from './history'
import { asOwing, completeTask, describeTask, dropTask, endsClaims, noteEdit, rootsToRun, startTask, waitTask, withdrawClaims } from './lifecycle'
import type { Manifest, ProofActions, ProofViewModel } from './model'
import { editPath, foldCase, placedPath, slashed } from './names'
import { pastLabel, rootsNow } from './present'
import { isLocalPath, readRevision, samePath } from './revision'
import { cancelSignal } from './runner'
import type { CancelSignal } from './runner'
import { detectOffer, draftFor, parseTypedCheck } from './setup'
import { withoutMarks } from './showable'
import { EMPTY_PROOF, EMPTY_WORK } from './state'
import type { ProofOps } from './state'
import { changedOnDisk } from './watched'

/** How long a tool call waits for a content read; a read later than this is no baseline. */
const READ_WAIT_MS = 1500
const REFRESH_AFTER_MS = 2000
const REFRESH_EVERY_MS = 30_000
const MAX_KEPT = 100
// Each automatic run uses up a claim, counted among the attempts kept: so as many of both are kept.
const MAX_CLAIMS = 1000
const MAX_ATTEMPTS = MAX_CLAIMS

// This load's own: what is running, its output, and the timers.
const live = new Map<string, { id: string; signal: CancelSignal }>()
const tails = new Map<string, string>()
const queued = new Map<string, object>()
/** Runs whose allowance ended under them: what they still report is no evidence. */
const revoked = new Set<string>()
/** File tools' calls under way: what lands before it returns was done in whatever completed meanwhile. */
const editing = new Map<string, { path: string; editor: string }>()
/** The order reads began in, which no clock changes, and the last applied of each session. */
let lastRead = 0
/** Reads begun no later than this are of a session that is over. */
let overBefore = 0
const applied = new Map<string, number>()
let shownLog: ProofViewModel['log'] = null
let eventQueue: Promise<unknown> = Promise.resolve()
let runQueue: Promise<unknown> = Promise.resolve()
let refreshTimer: { cancel: () => void } | null = null
let watchTimer: { cancel: () => void } | null = null
let lastId = 0

function inOrder<T>(job: () => Promise<T>): Promise<T> {
  const ran = eventQueue.then(job)
  eventQueue = ran.catch(() => undefined)
  return ran
}

export const liveRuns = (): ReadonlyMap<string, string> => new Map([...live].map(([root, run]) => [root, run.id]))
export const logShown = () => shownLog

function cancelAll() {
  for (const run of live.values()) {
    // A resume can come back to the same id, which would take the end of this run as its own.
    revoked.add(run.id)
    run.signal.cancel()
  }
  queued.clear()
  overBefore = lastRead
  tails.clear()
  shownLog = null
}

/** The session id, with all of an earlier session's allowances and evidence gone when it changed. */
async function currentSession($: EngineInterface, ops: ProofOps): Promise<string> {
  const id = await $.session.id()
  if ((await ops.proof()).session === id) return id
  cancelAll()
  await ops.setWork(() => ({ ...EMPTY_WORK, session: id }))
  await ops.setProof(p => (p.session === id ? p : { ...EMPTY_PROOF, session: id }))
  return id
}

async function noteSaved(ops: ProofOps, saved: boolean) {
  if ((await ops.proof()).notSaved !== !saved) await ops.setProof(p => ({ ...p, notSaved: !saved }))
}

// ---------------------------------------------------------------- content

type RootRead = { root: string; manifest: Manifest | null; reason: string | null }

async function readRoot($: EngineInterface, root: string): Promise<RootRead> {
  const r = await readRevision($, root)
  return r.ok ? { root, manifest: { root, revision: r.revision, files: [...r.hashes] }, reason: null } : { root, manifest: null, reason: r.reason }
}

/** The roots as read, each that took too long given as unread. */
async function readWithin($: EngineInterface, roots: readonly string[], ms: number): Promise<RootRead[]> {
  if (ms <= 0) return roots.map(root => ({ root, manifest: null, reason: 'read too late' }))
  let timer: { cancel: () => void } | null = null
  const late = new Promise<null>(resolve => (timer = $.clock.after(ms, () => resolve(null))))
  const reads = await Promise.all(roots.map(async root => (await Promise.race([readRoot($, root), late])) ?? { root, manifest: null, reason: 'read too late' }))
  ;(timer as { cancel: () => void } | null)?.cancel()
  return reads
}

/** Reads what is allowed as it is now, and pauses a root whose checks would run other than was allowed. */
export async function refreshProof($: EngineInterface, ops: ProofOps): Promise<void> {
  // Another session id ends what is drawn, whether or not an end was seen.
  const session = await currentSession($, ops)
  const { allowed } = await ops.proof()
  if (allowed.length === 0) return
  const order = ++lastRead
  const at = await $.clock.now()
  // What runs is read from the disk, and so even where git cannot read the content.
  const [reads, changed] = await Promise.all([
    Promise.all(allowed.map(a => readRoot($, a.grant.root))),
    Promise.all(allowed.map(async a => ({ root: a.grant.root, paths: await changedOnDisk($, a.grant.root, a.watched) }))),
  ])
  // Two reads can overlap: the one begun later stands.
  if (order <= overBefore || order < (applied.get(session) ?? 0)) return
  applied.set(session, order)
  await ops.setWork(w =>
    order <= overBefore || applied.get(session) !== order
      ? w
      : { ...w, seen: reads.map(r => ({ root: r.root, revision: r.manifest?.revision ?? null, files: r.manifest?.files ?? [], at, reason: r.reason })) },
  )
  const paused = changed.filter(x => x.paths.length > 0)
  if (JSON.stringify(paused) !== JSON.stringify((await ops.proof()).paused)) await ops.setProof(p => (p.session === session && applied.get(session) === order ? { ...p, paused } : p))
}

function refreshSoon($: EngineInterface, ops: ProofOps) {
  // The first call sets the time: put off by each, a busy turn would keep a green over what it changed.
  if (refreshTimer) return
  refreshTimer = $.clock.after(REFRESH_AFTER_MS, () => {
    refreshTimer = null
    void refreshProof($, ops).catch(() => undefined)
  })
}

// ---------------------------------------------------------------- task events

type TaskChange = { before: Plan; after: Plan; taskId: string; agentId: string | null; description: string | null; created?: boolean }

/**
 * A task as a tool call changed it. The call waits only for a content read, and not for long: an edit
 * before the read would be in the baseline.
 */
export async function proofTaskChanged($: EngineInterface, ops: ProofOps, x: TaskChange): Promise<void> {
  const p0 = await ops.proof()
  // Before anything is allowed this costs a state read, and no git.
  if (p0.allowed.length === 0) return
  const asked = await $.clock.now()
  const job = inOrder(async () => {
    const session = await currentSession($, ops)
    const p = await ops.proof()
    if (p.allowed.length === 0) return
    if (x.description !== null) {
      const text = x.description
      await ops.setWork(w => (w.session === session ? { ...w, tracking: describeTask(w.tracking, x.taskId, text) } : w))
    }
    const was = x.before.tasks.find(t => t.id === x.taskId)
    const is = x.after.tasks.find(t => t.id === x.taskId)
    const held = p.claims.filter(c => c.session === session && c.taskId === x.taskId && !c.withdrawn)
    if (endsClaims(held, { task: is, created: x.created === true })) {
      await ops.setProof(s => ({ ...s, claims: withdrawClaims(s.claims, session, x.taskId) }))
      for (const c of held) for (const root of new Set(c.changes.map(ch => ch.root))) void saveClaim($, root, { ...c, withdrawn: true })
    }
    if (!is || x.created) {
      await ops.setWork(w => (w.session === session ? { ...w, tracking: dropTask(w.tracking, x.taskId) } : w))
      return
    }
    if (was?.status === is.status) return
    // Back to waiting: what is done until it starts again is not its work.
    if (is.status === 'pending') {
      // What is under way was begun while it worked.
      await noteEditing($, ops, session, p.allowed.map(a => a.grant.root))
      await ops.setWork(w => (w.session === session ? { ...w, tracking: waitTask(w.tracking, x.taskId) } : w))
    }
    const roots = p.allowed.map(a => a.grant.root)
    if (is.status !== 'in_progress' && is.status !== 'completed') return

    const waited = (await $.clock.now()) - asked
    const reads = await readWithin($, roots, READ_WAIT_MS - waited)
    const manifests = reads.flatMap(r => (r.manifest ? [r.manifest] : []))
    const unread = reads.filter(r => !r.manifest).map(r => r.root)
    const at = await $.clock.now()
    if (is.status === 'in_progress') {
      await ops.setWork(w => (w.session === session ? { ...w, tracking: startTask(w.tracking, { taskId: x.taskId, at, start: manifests, unread }) } : w))
      return
    }
    await noteEditing($, ops, session, roots)
    const claims = (await ops.proof()).claims
    const { tracking } = await ops.work()
    const done = completeTask(tracking, { session, taskId: x.taskId, subject: is.subject, group: is.group, agentId: x.agentId, helpers: is.agents, at, end: manifests, unread, roots, claims })
    if (await stillThere($, done.claim)) done.claim = { ...done.claim, hasBaseline: false }
    await ops.setWork(w => (w.session === session ? { ...w, tracking: done.tracking } : w))
    // The new completion replaces what an earlier one claimed.
    await ops.setProof(s => (s.session === session ? { ...s, claims: [...withdrawClaims(s.claims, session, x.taskId), done.claim].slice(-MAX_CLAIMS) } : s))
    const changed = new Set(done.claim.changes.map(c => c.root))
    for (const root of changed.size > 0 ? changed : new Set(roots.slice(0, 1))) void saveClaim($, root, done.claim).then(ok => noteSaved(ops, ok)).catch(() => undefined)
    refreshSoon($, ops)
  })
  let timer: { cancel: () => void } | null = null
  await Promise.race([job.catch(() => undefined), new Promise<void>(resolve => (timer = $.clock.after(READ_WAIT_MS, () => resolve())))])
  ;(timer as { cancel: () => void } | null)?.cancel()
}

/** Whether a path the claim has as gone is on the disk: ignored since, and so not seen, not deleted. */
async function stillThere($: EngineInterface, claim: ProofClaim): Promise<boolean> {
  const gone = claim.changes.flatMap(c => c.paths.filter(p => p.hash === null).map(p => `${c.root}/${p.path}`))
  for (let i = 0; i < gone.length; i += 64) {
    const found = await Promise.all(gone.slice(i, i + 64).map(path => $.fs.stat(path).then(st => st.kind === 'file', () => false)))
    if (found.includes(true)) return true
  }
  return false
}

/** The file tools' calls under way, noted on the tasks open now. */
async function noteEditing($: EngineInterface, ops: ProofOps, session: string, roots: readonly string[]): Promise<void> {
  for (const { path, editor } of [...editing.values()]) {
    const landed = await placeEdit($, roots, path)
    await ops.setWork(w => (w.session === session ? { ...w, tracking: noteEdit(w.tracking, landed, editor) } : w))
  }
}

/** An edit's path as a tool named it, to where it lands; one that cannot be placed is inside no root. */
async function placeEdit($: EngineInterface, roots: readonly string[], named: string): Promise<string> {
  // The session's folder says which system this is, and no more.
  const path = editPath(named, await $.session.cwd())
  return path ? landedAt($, roots, path) : `unresolved path: ${named}`
}

/** Where an edit landed, links followed, spelled from the allowed root it landed in. */
async function landedAt($: EngineInterface, roots: readonly string[], path: string): Promise<string> {
  const resolved = async (of: string) => {
    const real = (await $.fs.stat(of, { resolve: true }).catch(() => null))?.realPath
    // By the system it was asked on: a drive can resolve to a share, which names none.
    return real ? slashed(real, of).replace(/\/+$/, '') : null
  }
  let real = await resolved(path)
  if (!real) {
    // Not there yet: where the nearest folder that is leads is where it will land.
    // Off Windows a backslash is a letter of a name.
    const steps = slashed(path).split('/')
    let at = steps.length - 1
    // Never a drive by itself, which is that drive's current folder.
    for (; at > 1; at--) {
      const folder = await resolved(steps.slice(0, at).join('/'))
      if (!folder) continue
      // Something is there and leads nowhere: a link, whichever of its names was used, which can come to
      // lead anywhere. No path, so inside no root.
      if (await $.fs.stat(steps.slice(0, at + 1).join('/')).then(() => true, () => false)) return `unresolved link: ${path}`
      real = `${folder}/${steps.slice(at).join('/')}`
      break
    }
    if (!real) return path
  }
  for (const root of roots) {
    const top = await resolved(root)
    if (top && real.length > top.length + 1 && real[top.length] === '/' && real.slice(0, top.length) === top) return `${root}/${real.slice(top.length + 1)}`
  }
  return real
}

/** A file tool's path, or any shell call: what can have changed the content. */
export async function proofToolRan($: EngineInterface, ops: ProofOps, editedPath: string | null, agentId: string | null = null): Promise<void> {
  const { allowed, session } = await ops.proof()
  if (allowed.length === 0) return
  if (editedPath) {
    const editor = agentId ?? ''
    void inOrder(async () => {
      if ((await ops.work()).tracking.open.length === 0) return
      const path = await placeEdit($, (await ops.proof()).allowed.map(a => a.grant.root), editedPath)
      await ops.setWork(w => (w.session === session ? { ...w, tracking: noteEdit(w.tracking, path, editor) } : w))
    }).catch(() => undefined)
  }
  refreshSoon($, ops)
}

/** A task tool's call, done: which task it was of, and how it changed. */
export async function proofTaskTool(
  $: EngineInterface,
  ops: ProofOps,
  x: { tool: string; input: Record<string, unknown>; result: unknown; before: Plan; after: Plan; agentId: string | null },
): Promise<void> {
  const created = x.tool === 'TaskCreate'
  // The result's id, not the one new to the plan: an id used again is new to neither.
  const id = created ? (x.result as { task?: { id?: unknown } } | null)?.task?.id : x.input.taskId
  if (typeof id !== 'string') return
  const description = typeof x.input.description === 'string' ? x.input.description : null
  await proofTaskChanged($, ops, { before: x.before, after: x.after, taskId: id, agentId: x.agentId, description, created })
}

/** A tool's call as it begins. No state, no wait. */
export function proofEditStarted(id: string, x: { tool: string; input: Record<string, unknown>; agentId: string | null }): void {
  if (!EDIT_TOOLS.has(x.tool)) return
  const path = x.input.file_path ?? x.input.notebook_path
  if (typeof path === 'string') editing.set(id, { path, editor: x.agentId ?? '' })
}

/** That call over, and whatever it did noted. */
export function proofEditSettled(id: string): void {
  // Through the queue, after its note: a completion already waiting there still finds it under way.
  if (editing.has(id)) void inOrder(async () => void editing.delete(id)).catch(() => undefined)
}

/** Any other tool's call, done: whether it can have changed the content, and the file it named. */
export async function proofToolDone(
  $: EngineInterface,
  ops: ProofOps,
  x: { tool: string; input: Record<string, unknown>; hasFailed: boolean; agentId: string | null },
): Promise<void> {
  const isEdit = EDIT_TOOLS.has(x.tool)
  // A failed shell call can have changed files too, and an MCP tool writes as it likes.
  if (!isEdit && x.tool !== 'Bash' && x.tool !== 'PowerShell' && !x.tool.startsWith('mcp__')) return
  const path = isEdit && !x.hasFailed ? (x.input.file_path ?? x.input.notebook_path) : null
  await proofToolRan($, ops, typeof path === 'string' ? path : null, x.agentId)
}

// ---------------------------------------------------------------- runs

async function runRoot($: EngineInterface, ops: ProofOps, root: string, trigger: ProofAttempt['trigger']): Promise<void> {
  const session = await currentSession($, ops)
  const allowed = (await ops.proof()).allowed.find(a => a.grant.root === root)
  // Asked of the very allowance that runs: automatic may have been switched off since it was queued.
  if (!allowed || (trigger === 'auto' && !allowed.grant.auto)) return
  const { grant, watched } = allowed
  const startedAt = await $.clock.now()
  const id = `${startedAt.toString(36)}-${++lastId}`
  const signal = cancelSignal()
  live.set(root, { id, signal })
  let stoppedForTurn = false
  // Its output is this run's, or none.
  for (const key of [...tails.keys()]) if (key.endsWith(`\n${root}`)) tails.delete(key)
  const record = (attempt: ProofAttempt) =>
    ops.setProof(p => {
      // An end that lands after a /clear, or after another allow, is nobody's evidence.
      if (p.session !== attempt.session || revoked.has(attempt.id)) return p
      const at = p.attempts.findIndex(a => a.id === attempt.id)
      if (at >= 0) return { ...p, attempts: p.attempts.map((a, i) => (i === at ? attempt : a)) }
      // Of each root so many: one root's runs must not push out those that used up another's claims.
      const ofRoot = p.attempts.filter(a => a.root === attempt.root)
      const oldest = ofRoot.length >= MAX_ATTEMPTS ? ofRoot[0] : null
      return { ...p, attempts: [...p.attempts.filter(a => a !== oldest), attempt] }
    })
  try {
    const got = await runAttempt($, {
      id,
      session,
      grant,
      trigger,
      watched,
      signal,
      isStillAllowed: async () => {
        const p = await ops.proof()
        const now = p.allowed.find(a => a.grant.root === root)?.grant
        if (revoked.has(id) || p.session !== session || (await $.session.id()) !== session || now?.digest !== grant.digest || now.at !== grant.at) return false
        // Before each spawn: an automatic one is of a turn that is over, under an allowance still automatic.
        if (trigger === 'manual') return true
        if (!now.auto) return false
        if ((await ops.work()).turnEnded) return true
        stoppedForTurn = true
        return false
      },
      onProgress: record,
    })
    const ranSome = 'attempt' in got && got.tails.length > 0
    const hasFailed = 'attempt' in got && got.attempt.checks.some(r => r.execution === 'exited' && (r.exitCode !== 0 || (r.count?.failed ?? 0) > 0))
    // A turn began. What saw something stays as what was seen last, or an older green would come back;
    // only what started nothing was no attempt. Either way the run is still owed.
    if (stoppedForTurn && !signal.cancelled && !hasFailed && ranSome && 'attempt' in got) await record({ ...got.attempt, stopped: true })
    if (stoppedForTurn && !signal.cancelled && !ranSome) {
      await ops.setProof(p => ({ ...p, attempts: p.attempts.filter(a => a.id !== id) }))
    } else if ('attempt' in got) {
      for (const [check, text] of got.tails) tails.set(`${check}\n${root}`, text)
      await refreshProof($, ops)
      const ok = await saveAttempt($, got.attempt)
      await noteSaved(ops, ok)
    } else if (got.changed.length > 0) {
      await ops.setProof(p => (p.session === session ? { ...p, paused: [...p.paused.filter(x => x.root !== root), { root, paths: got.changed }] } : p))
    } else {
      // An attempt that could not be made is still one, or it would be owed again at every turn's end.
      await refreshProof($, ops)
      const p = await ops.proof()
      if (!p.attempts.some(a => a.id === id)) {
        const before = (await ops.work()).seen.find(s => s.root === root)?.revision ?? 'unread'
        await record({
          id, session, root, digest: grant.digest, trigger, before, after: before === 'unread' ? null : before, head: null, startedAt, endedAt: await $.clock.now(),
          checks: grant.checks.map(c => ({
            id: c.id, kind: c.kind, description: c.description, execution: 'unavailable' as const, source: 'os-deck-run' as const,
            startedAt, endedAt: startedAt, revision: before, exitCode: null, count: null, summary: '', reason: got.notRun,
          })),
        })
      }
    }
  } finally {
    live.delete(root)
    revoked.delete(id)
    // Drawn again now that nothing runs, whatever else changed.
    await ops.setWork(w => ({ ...w }))
  }
}

function queueRun($: EngineInterface, ops: ProofOps, root: string, trigger: ProofAttempt['trigger']) {
  if (queued.has(root) || live.has(root)) return
  const turn = {}
  queued.set(root, turn)
  runQueue = runQueue
    .then(async () => {
      // Cancelled, or allowed again, while it waited.
      if (queued.get(root) !== turn) return
      queued.delete(root)
      // Owed as it was queued is not owed as it starts: a turn can begin, or automatic be switched off.
      if (trigger === 'auto' && !(await ops.work()).turnEnded) return
      await runRoot($, ops, root, trigger)
    })
    .catch(() => undefined)
}

/** Starts what automatic runs are owed, once a turn ended with an answer and no agent is at work. */
async function runOwed($: EngineInterface, ops: ProofOps): Promise<void> {
  if (!(await ops.work()).turnEnded) return
  const session = await currentSession($, ops)
  if ((await $.agent.list()).some(a => a.status === 'running')) return
  // The turn's last task events first.
  await eventQueue
  await refreshProof($, ops)
  if (!(await ops.work()).turnEnded) return
  const p = await ops.proof()
  const claims = asOwing(p.claims, p.allowed.map(a => a.grant.root))
  const roots = rootsToRun({
    session,
    grants: p.allowed.map(a => a.grant),
    claims,
    attempts: p.attempts,
    paused: p.paused.map(x => x.root),
    busy: [...live.keys(), ...queued.keys()],
  })
  for (const root of roots) queueRun($, ops, root, 'auto')
}

export async function proofTurnStarted(ops: ProofOps): Promise<void> {
  if ((await ops.work()).turnEnded) await ops.setWork(w => ({ ...w, turnEnded: false }))
}

export async function proofTurnEnded($: EngineInterface, ops: ProofOps, x: { isMain: boolean; reason: string }): Promise<void> {
  if ((await ops.proof()).allowed.length === 0) return
  if (x.isMain) {
    // Esc, a refusal and an error run nothing.
    const turnEnded = x.reason === 'answer'
    await ops.setWork(w => ({ ...w, turnEnded }))
  }
  // Outside the hook, and a moment later: an agent that just ended is still listed as running.
  $.clock.after(500, () => void runOwed($, ops).catch(() => undefined))
}

// ---------------------------------------------------------------- the session

export async function proofSessionStarted($: EngineInterface, ops: ProofOps): Promise<void> {
  await currentSession($, ops)
  watchTimer?.cancel()
  watchTimer = null
  watch($, ops)
}

/** What an editor or another session changes raises no event here. */
function watch($: EngineInterface, ops: ProofOps) {
  if (watchTimer) return
  watchTimer = $.clock.every(REFRESH_EVERY_MS, () => {
    void (async () => {
      const p = await ops.proof()
      if (p.allowed.length === 0) return
      await refreshProof($, ops)
      await runOwed($, ops)
    })().catch(() => undefined)
  })
}

export async function proofSessionEnded(ops: ProofOps, reason: string): Promise<void> {
  cancelAll()
  refreshTimer?.cancel()
  refreshTimer = null
  // A clear and a resume go on in this process, with no session.start to begin the watch again.
  if (reason !== 'clear' && reason !== 'resume') {
    watchTimer?.cancel()
    watchTimer = null
  }
  await ops.setWork(() => EMPTY_WORK)
  await ops.setProof(() => EMPTY_PROOF)
}

// ---------------------------------------------------------------- the command

/** The top of the repository `from` is in, found by looking: before a press no git runs. */
/**
 * A root's one spelling, the disk's: every later comparison is exact. Only capitals are taken from
 * there: where a link leads is another path, and git is asked of the one that was given.
 */
async function asOnDisk($: EngineInterface, dir: string, at: string): Promise<string> {
  const real = (await $.fs.stat(dir, { resolve: true }).catch(() => null))?.realPath
  const disk = real ? slashed(real).replace(/\/+$/, '') : at
  return (foldCase(disk) === foldCase(at) ? disk : at).replace(/^[a-z]:/, drive => drive.toUpperCase())
}

async function topOf($: EngineInterface, from: string): Promise<string | null> {
  let at = slashed(from).replace(/\/+$/, '')
  for (let i = 0; i < 32 && at; i++) {
    const dir = /^[A-Za-z]:$/.test(at) ? `${at}/` : at
    if (!isLocalPath(dir)) return null
    const found = await $.fs.list(dir).catch(() => [])
    if (found.some(x => x.name === '.git' && !x.isLink)) return asOnDisk($, dir, at)
    const up = at.slice(0, at.lastIndexOf('/'))
    if (up === at) return null
    at = up
  }
  return null
}

const USAGE = 'OS-Deck proof: /os-deck proof setup [folder] | check <test|typecheck|lint|build> [--dir <folder>] -- <command> | history'

/** `/os-deck proof …`: shows and drafts. Allowing is a press in the dock, never a command. */
export async function proofCommand($: EngineInterface, ops: ProofOps, args: string, isTyped: boolean): Promise<string> {
  const session = await currentSession($, ops)
  const [verb = '', ...words] = args.trim().split(/\s+/)
  const rest = args.trim().slice(verb.length).trim()
  const p = await ops.proof()
  if (verb === '') {
    if (p.allowed.length === 0) return 'OS-Deck proof: nothing is allowed in this session. /os-deck proof setup shows what could be checked; nothing runs until you press allow.'
    const roots = rootsNow(p, await ops.work(), liveRuns())
    return `OS-Deck proof:\n${roots.map(r => `${redact(r.root)}  ${r.verdict.state}: ${redact(r.verdict.reason)}`).join('\n')}`
  }
  if (verb === 'history') {
    const root = words.length > 0 ? ((await topOf($, rest)) ?? rest) : (p.allowed[0]?.grant.root ?? (await topOf($, await $.session.cwd())))
    if (!root) return 'OS-Deck proof: no repository here.'
    const { attempts, claims, reviews } = await loadRecords($, root)
    const when = (at: number) => new Date(at).toLocaleString()
    // Ids are numbered again by another process, so a review names its claim's time as well.
    const reviewed = (claim: ProofClaim) => reviews.some(r => r.claim === claim.id && r.claimAt === Math.floor(claim.at))
    const lines = [
      ...attempts.slice(-10).reverse().map(a => `${when(a.startedAt)}  ${pastLabel(a)}  ${a.checks.map(c => c.id).join(', ')}`),
      ...claims.slice(-10).reverse().map(c => {
        const since = c.withdrawn ? ' · withdrawn' : reviewed(c) ? ' · reviewed' : ''
        return `${when(c.at)}  claimed "${withoutMarks(c.subject)}"${since}`
      }),
    ]
    if (lines.length === 0) return 'OS-Deck proof: nothing saved for this repository.'
    return `OS-Deck proof, saved runs and claims (history, not evidence):\n${lines.join('\n')}`
  }
  if (verb !== 'setup' && verb !== 'check' && verb !== 'run') return USAGE
  // The origin of a typed command is a clicked link's too: so this only shows and drafts, whoever sent it.
  if (!isTyped) return 'OS-Deck proof: type this command yourself.'
  if (verb === 'run') {
    if (p.allowed.length === 0) return 'OS-Deck proof: nothing is allowed in this session. /os-deck proof setup first.'
    return 'OS-Deck proof: press verify in the dock. A command does not run checks: a clicked link looks like a typed one.'
  }

  let typed: ProofCheck | null = null
  let from = await $.session.cwd()
  if (verb === 'check') {
    const parsed = parseTypedCheck(rest)
    if ('error' in parsed) return `OS-Deck proof: ${redact(parsed.error)}`
    typed = parsed.check
  } else if (rest) {
    const folder = rest.replace(/^"(.*)"$/, '$1')
    const placed = /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(folder) ? null : placedPath(folder, from)
    if (!placed) return 'OS-Deck proof: give a folder on this machine, without "~" or "..".'
    from = placed
  }
  const found = (verb === 'check' ? p.draft?.root : null) ?? (await topOf($, from))
  const root = found && (p.allowed.find(a => samePath(a.grant.root, found))?.grant.root ?? found)
  if (!root) return 'OS-Deck proof: that folder is not inside a git repository. /os-deck proof setup <folder> names one.'

  const records = await loadRecords($, root)
  const granted = p.allowed.find(a => samePath(a.grant.root, root))?.grant.checks
  let checks: ProofCheck[]
  let leftOut: string[] = []
  let source: 'detected' | 'saved' | 'typed'
  if (typed) {
    const one = typed
    // Added to what could be allowed, never to a draft that could not.
    const base = p.draft?.root === root && !p.draft.problem ? p.draft.checks : (granted ?? [])
    checks = [...base.filter(c => c.id !== one.id), one]
    source = 'typed'
  } else if (granted || records.checks.length > 0) {
    checks = granted ?? records.checks
    source = 'saved'
  } else {
    ;({ checks, leftOut } = await detectOffer($, root))
    source = 'detected'
  }
  if (checks.length === 0) return 'OS-Deck proof: no test, typecheck, lint or build found here. /os-deck proof check <kind> -- <command> names one.'
  const draft = await draftFor($, root, checks, source)
  const past = records.attempts.slice(-20).map(a => ({ root, at: a.startedAt, label: pastLabel(a) }))
  await ops.setProof(s => (s.session === session ? { ...s, draft, past: [...s.past.filter(x => x.root !== root), ...past] } : s))
  const others = leftOut.length > 0 ? `\n${leftOut.map(why => `left out: ${redact(why)}`).join('\n')}` : ''
  return `OS-Deck proof: ${checks.length} check${checks.length === 1 ? '' : 's'} shown in the dock. Nothing has run; press allow there to let them.${others}`
}

// ---------------------------------------------------------------- presses

export async function pressAllow($: EngineInterface, ops: ProofOps, root: string, drawnDigest: string, auto: boolean): Promise<void> {
  const refuse = async (why: string) => {
    // A second press on the same spot would allow what this one refused: setup is asked for again.
    await ops.setProof(p => (p.draft?.root === root ? { ...p, draft: null } : p))
    $.ui.toast(`OS-Deck proof: ${why}. Nothing was allowed: /os-deck proof setup shows it again`)
  }
  const session = await currentSession($, ops)
  const draft = (await ops.proof()).draft
  if (!draft || draft.root !== root || draft.digest !== drawnDigest || !drawnDigest || draft.problem) return refuse('what was pressed is no longer what is shown')
  const start = await readRevision($, root)
  if (!start.ok) return refuse(`this repository cannot be verified: ${start.reason}`)
  // Read again only to refuse what moved: what is bound is the one reading that was drawn and hashed.
  const again = await draftFor($, root, draft.checks, draft.source)
  if (again.problem || again.digest !== drawnDigest) return refuse('the checks changed since they were shown')
  const at = await $.clock.now()
  const made = await grantFrom({ session, root, checks: again.checks, scripts: again.scripts, watched: again.watched, files: again.files, manualOnly: again.manualOnly, drawnDigest, auto, at })
  if ('refused' in made) return refuse(made.refused)
  const { watched } = again
  let isAllowed = false
  await ops.setProof(p => {
    // Discarded, or replaced, while this was read.
    isAllowed = p.session === session && p.draft?.root === root && p.draft.digest === drawnDigest
    if (!isAllowed) return p
    const isHere = (x: { root: string }) => samePath(x.root, root)
    // A new allowance takes no evidence from the one before, whatever the clock says of which came first.
    const past = p.attempts.filter(isHere).map(a => ({ root, at: a.startedAt, label: pastLabel(a) }))
    return {
      ...p,
      draft: null,
      paused: p.paused.filter(x => !isHere(x)),
      attempts: p.attempts.filter(a => !isHere(a)),
      past: [...p.past, ...past].slice(-MAX_KEPT),
      allowed: [...p.allowed.filter(a => !isHere(a.grant)), { grant: made.grant, watched }],
    }
  })
  if (!isAllowed) return
  queued.delete(root)
  const running = live.get(root)
  if (running) {
    revoked.add(running.id)
    running.signal.cancel()
  }
  watch($, ops)
  await refreshProof($, ops)
  await noteSaved(ops, await saveChecks($, root, made.grant.checks))
}

/** Never accepts changed scripts unseen: it shows setup again, for another allow. */
export async function pressResume($: EngineInterface, ops: ProofOps, root: string): Promise<void> {
  const allowed = (await ops.proof()).allowed.find(a => a.grant.root === root)
  if (!allowed) return
  const draft = await draftFor($, root, allowed.grant.checks, 'saved')
  await ops.setProof(p => ({ ...p, draft }))
}

export async function pressVerify($: EngineInterface, ops: ProofOps, root: string): Promise<void> {
  await currentSession($, ops)
  if ((await ops.proof()).allowed.some(a => a.grant.root === root)) queueRun($, ops, root, 'manual')
}

export async function pressCancel(root: string): Promise<void> {
  queued.delete(root)
  live.get(root)?.signal.cancel()
}

export async function pressBaseline($: EngineInterface, ops: ProofOps, root: string, attemptId: string, checkId: string, passed: number, skipped: number): Promise<void> {
  const session = await currentSession($, ops)
  const p = await ops.proof()
  const offered = rootsNow(p, await ops.work(), liveRuns()).find(r => r.root === root)?.baseline
  if (!offered || offered.attemptId !== attemptId || offered.checkId !== checkId || offered.passed !== passed || offered.skipped !== skipped) {
    $.ui.toast('OS-Deck proof: that run is no longer the one shown')
    return
  }
  const allowed = p.allowed.find(a => a.grant.root === root)
  if (!allowed) return
  const checks = allowed.grant.checks.map(c => (c.id === checkId && c.count ? { ...c, count: { ...c.count, minPassed: passed, maxSkipped: skipped } } : c))
  // The same bytes run: only the judging changed, so the attempt seen still stands.
  if ((await digestOf(root, checks)) !== allowed.grant.digest) return
  await ops.setProof(s => (s.session === session ? { ...s, allowed: s.allowed.map(a => (a.grant.root === root && a.grant.digest === allowed.grant.digest && a.grant.at === allowed.grant.at ? { ...a, grant: { ...a.grant, checks } } : a)) } : s))
  await noteSaved(ops, await saveChecks($, root, checks))
}

export async function pressReview($: EngineInterface, ops: ProofOps, claim: string, revisions: { root: string; revision: string }[]): Promise<void> {
  const session = await currentSession($, ops)
  const claimed = (await ops.proof()).claims.find(c => c.id === claim && c.session === session && !c.withdrawn)
  if (revisions.length === 0 || !claimed) return
  const review = { claim, claimAt: Math.floor(claimed.at), revisions, at: await $.clock.now() }
  await ops.setProof(p => (p.session === session ? { ...p, reviews: [...p.reviews.filter(r => r.claim !== claim), review].slice(-MAX_CLAIMS) } : p))
  await noteSaved(ops, await saveReview($, revisions[0]?.root ?? '', review))
}

export async function pressShowLog(ops: ProofOps, root: string, checkId: string | null): Promise<void> {
  const isSame = shownLog?.root === root && shownLog.checkId === checkId
  shownLog = checkId === null || isSame ? null : { root, checkId, text: tails.get(`${checkId}\n${root}`) ?? 'no output kept' }
  await ops.setWork(w => ({ ...w }))
}

/** The dock's presses. Each carries what was drawn; the functions above hold it against what is. */
export function proofActions($: EngineInterface, ops: ProofOps): ProofActions {
  const done = (work: Promise<unknown>) => work.catch(err => $.ui.toast(`OS-Deck proof: ${shorten(redact(String(err)), 120)}`))
  return {
    toggleClaim: id => done(ops.setProof(p => ({ ...p, openClaim: p.openClaim === id ? null : id }))),
    allow: (root, digest, auto) => done(pressAllow($, ops, root, digest, auto)),
    discardDraft: () => done(ops.setProof(p => ({ ...p, draft: null }))),
    verify: root => done(pressVerify($, ops, root)),
    cancel: root => done(pressCancel(root)),
    acceptBaseline: (root, attempt, check, passed, skipped) => done(pressBaseline($, ops, root, attempt, check, passed, skipped)),
    resume: root => done(pressResume($, ops, root)),
    review: (claim, drawn) => done(pressReview($, ops, claim, drawn)),
    showLog: (root, check) => done(pressShowLog(ops, root, check)),
  }
}
