// Agent Proof's orchestration: the engine's events and a person's presses in, session state out. The
// decisions are the pure modules'; what is here is order, and who may cause what. Task events go
// through one queue in the order they arrived; runs go through another, so neither waits on checks.
import type { EngineInterface } from 'claude-code'

import type { Plan, ProofAttempt, ProofCheck } from '../../types'
import { redact } from '../redact'
import { runAttempt } from './attempt'
import { digestOf, grantFrom, watchedPaths } from './grant'
import { loadRecords, saveAttempt, saveChecks, saveClaim, saveReview } from './history'
import { changedWatched, completeTask, describeTask, dropTask, noteEdit, rootsToRun, startTask, withdrawClaims } from './lifecycle'
import type { Manifest, ProofViewModel } from './model'
import { pastLabel, rootsNow } from './present'
import { isLocalPath, readRevision, samePath } from './revision'
import { cancelSignal } from './runner'
import type { CancelSignal } from './runner'
import { detectChecks, draftFor, parseTypedCheck } from './setup'
import { EMPTY_PROOF, EMPTY_WORK } from './state'
import type { ProofOps } from './state'

/** How long a tool call waits for a content read; a read later than this is no baseline. */
const READ_WAIT_MS = 1500
const REFRESH_AFTER_MS = 2000
const REFRESH_EVERY_MS = 30_000
const MAX_KEPT = 100
// Far more than attempts: each automatic run uses up a claim, so claims pruned first would end the runs.
const MAX_CLAIMS = 1000

// This load's own: what is running, its output, and the timers.
const live = new Map<string, { id: string; signal: CancelSignal }>()
const tails = new Map<string, string>()
const queued = new Set<string>()
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
  for (const run of live.values()) run.signal.cancel()
  queued.clear()
  tails.clear()
  shownLog = null
}

/** The session id, with all of an earlier session's allowances and evidence gone when it changed. */
async function currentSession($: EngineInterface, ops: ProofOps): Promise<string> {
  const id = await $.session.id()
  if ((await ops.proof()).session === id) return id
  cancelAll()
  await ops.setWork(() => EMPTY_WORK)
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
  const { allowed, session } = await ops.proof()
  if (allowed.length === 0 || session !== (await $.session.id())) return
  const at = await $.clock.now()
  const reads = await Promise.all(allowed.map(a => readRoot($, a.grant.root)))
  await ops.setWork(w => ({
    ...w,
    seen: reads.map(r => {
      const before = w.seen.find(s => s.root === r.root)
      // Two reads can overlap: the one begun later stands.
      if (before && before.at > at) return before
      return { root: r.root, revision: r.manifest?.revision ?? null, files: r.manifest?.files ?? [], at, reason: r.reason }
    }),
  }))
  const paused: { root: string; paths: string[] }[] = []
  for (const a of allowed) {
    const manifest = reads.find(r => r.root === a.grant.root)?.manifest
    const paths = manifest ? changedWatched(a.watched, new Map(manifest.files)) : ((await ops.proof()).paused.find(x => x.root === a.grant.root)?.paths ?? [])
    if (paths.length > 0) paused.push({ root: a.grant.root, paths })
  }
  if (JSON.stringify(paused) !== JSON.stringify((await ops.proof()).paused)) await ops.setProof(p => (p.session === session ? { ...p, paused } : p))
}

function refreshSoon($: EngineInterface, ops: ProofOps) {
  refreshTimer?.cancel()
  refreshTimer = $.clock.after(REFRESH_AFTER_MS, () => void refreshProof($, ops).catch(() => undefined))
}

// ---------------------------------------------------------------- task events

export type TaskChange = { before: Plan; after: Plan; taskId: string; agentId: string | null; description: string | null }

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
      await ops.setWork(w => ({ ...w, tracking: describeTask(w.tracking, x.taskId, text) }))
    }
    const was = x.before.tasks.find(t => t.id === x.taskId)
    const is = x.after.tasks.find(t => t.id === x.taskId)
    if (!is) {
      if (was) await ops.setWork(w => ({ ...w, tracking: dropTask(w.tracking, x.taskId) }))
      return
    }
    if (was?.status === is.status) return
    const roots = p.allowed.map(a => a.grant.root)
    if (was?.status === 'completed') {
      // Reopened: what was claimed is claimed no longer.
      await ops.setProof(s => ({ ...s, claims: withdrawClaims(s.claims, session, x.taskId) }))
      for (const c of (await ops.proof()).claims)
        if (c.taskId === x.taskId && c.withdrawn) for (const root of new Set(c.changes.map(ch => ch.root))) void saveClaim($, root, c)
    }
    if (is.status !== 'in_progress' && is.status !== 'completed') return

    const waited = (await $.clock.now()) - asked
    const reads = await readWithin($, roots, READ_WAIT_MS - waited)
    const manifests = reads.flatMap(r => (r.manifest ? [r.manifest] : []))
    const unread = reads.filter(r => !r.manifest).map(r => r.root)
    const at = await $.clock.now()
    if (is.status === 'in_progress') {
      await ops.setWork(w => ({ ...w, tracking: startTask(w.tracking, { taskId: x.taskId, at, start: manifests, unread }) }))
      return
    }
    const claims = (await ops.proof()).claims
    const { tracking } = await ops.work()
    const done = completeTask(tracking, { session, taskId: x.taskId, subject: is.subject, agentId: x.agentId, at, end: manifests, unread, roots, claims })
    await ops.setWork(w => ({ ...w, tracking: done.tracking }))
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

/** A file tool's path, or any shell call: what can have changed the content. */
export async function proofToolRan($: EngineInterface, ops: ProofOps, editedPath: string | null): Promise<void> {
  if ((await ops.proof()).allowed.length === 0) return
  if (editedPath) {
    void inOrder(async () => {
      if ((await ops.work()).tracking.open.length === 0) return
      const path = isLocalPath(editedPath) ? editedPath : `${await $.session.cwd()}/${editedPath}`
      await ops.setWork(w => ({ ...w, tracking: noteEdit(w.tracking, path) }))
    }).catch(() => undefined)
  }
  refreshSoon($, ops)
}

// ---------------------------------------------------------------- runs

async function runRoot($: EngineInterface, ops: ProofOps, root: string, trigger: ProofAttempt['trigger']): Promise<void> {
  const session = await currentSession($, ops)
  const allowed = (await ops.proof()).allowed.find(a => a.grant.root === root)
  if (!allowed) return
  const { grant, watched } = allowed
  const startedAt = await $.clock.now()
  const id = `${startedAt.toString(36)}-${++lastId}`
  const signal = cancelSignal()
  live.set(root, { id, signal })
  const record = (attempt: ProofAttempt) =>
    ops.setProof(p => {
      // An end that lands after a /clear is nobody's evidence.
      if (p.session !== attempt.session) return p
      const at = p.attempts.findIndex(a => a.id === attempt.id)
      const attempts = at < 0 ? [...p.attempts, attempt].slice(-MAX_KEPT) : p.attempts.map((a, i) => (i === at ? attempt : a))
      return { ...p, attempts }
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
        return p.session === session && (await $.session.id()) === session && now?.digest === grant.digest && now.at === grant.at
      },
      onProgress: record,
    })
    if ('attempt' in got) {
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
    // Drawn again now that nothing runs, whatever else changed.
    await ops.setWork(w => ({ ...w }))
  }
}

function queueRun($: EngineInterface, ops: ProofOps, root: string, trigger: ProofAttempt['trigger']) {
  if (queued.has(root) || live.has(root)) return
  queued.add(root)
  runQueue = runQueue
    .then(async () => {
      // Cancelled while it waited.
      if (!queued.delete(root)) return
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
  const roots = rootsToRun({
    session,
    grants: p.allowed.map(a => a.grant),
    claims: p.claims,
    attempts: p.attempts,
    paused: p.paused.map(x => x.root),
    busy: [...live.keys(), ...queued],
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
  // What an editor or another session changes raises no event here.
  watchTimer = $.clock.every(REFRESH_EVERY_MS, () => {
    void (async () => {
      const p = await ops.proof()
      if (p.allowed.length === 0) return
      await refreshProof($, ops)
      await runOwed($, ops)
    })().catch(() => undefined)
  })
}

export async function proofSessionEnded(ops: ProofOps, isClear: boolean): Promise<void> {
  cancelAll()
  refreshTimer?.cancel()
  if (!isClear) watchTimer?.cancel()
  await ops.setWork(() => EMPTY_WORK)
  await ops.setProof(() => EMPTY_PROOF)
}

// ---------------------------------------------------------------- the command

/** The top of the repository `from` is in, found by looking: before a press no git runs. */
async function topOf($: EngineInterface, from: string): Promise<string | null> {
  let at = from.replace(/\\/g, '/').replace(/\/+$/, '')
  for (let i = 0; i < 32 && at; i++) {
    const dir = /^[A-Za-z]:$/.test(at) ? `${at}/` : at
    if (!isLocalPath(dir)) return null
    const found = await $.fs.list(dir).catch(() => [])
    if (found.some(x => x.name === '.git' && !x.isLink)) return at
    const up = at.slice(0, at.lastIndexOf('/'))
    if (up === at) return null
    at = up
  }
  return null
}

const USAGE = 'OS-Deck proof: /os-deck proof setup [folder] | check <test|typecheck|lint|build> [--dir <folder>] -- <command> | run | history'

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
    const root = words.length > 0 ? rest : (p.allowed[0]?.grant.root ?? (await topOf($, await $.session.cwd())))
    if (!root) return 'OS-Deck proof: no repository here.'
    const { attempts } = await loadRecords($, root)
    if (attempts.length === 0) return 'OS-Deck proof: no saved runs for this repository.'
    const lines = attempts.slice(-10).reverse().map(a => `${new Date(a.startedAt).toLocaleString()}  ${pastLabel(a)}  ${a.checks.map(c => c.id).join(', ')}`)
    return `OS-Deck proof, saved runs (history, not evidence):\n${lines.join('\n')}`
  }
  if (verb !== 'setup' && verb !== 'check' && verb !== 'run') return USAGE
  // Only the person's own Enter: not a plugin, a schedule, another session or a link's click forwarded.
  if (!isTyped) return 'OS-Deck proof: type this command yourself.'
  if (verb === 'run') {
    if (p.allowed.length === 0) return 'OS-Deck proof: nothing is allowed in this session. /os-deck proof setup first.'
    for (const a of p.allowed) queueRun($, ops, a.grant.root, 'manual')
    return 'OS-Deck proof: running the allowed checks.'
  }

  let typed: ProofCheck | null = null
  let from = await $.session.cwd()
  if (verb === 'check') {
    const parsed = parseTypedCheck(rest)
    if ('error' in parsed) return `OS-Deck proof: ${redact(parsed.error)}`
    typed = parsed.check
  } else if (rest) {
    const folder = rest.replace(/^"(.*)"$/, '$1')
    if (/^[\\/]{2}|(?:^|[\\/])\.\.(?:[\\/]|$)/.test(folder)) return 'OS-Deck proof: give a folder on this machine, without "..".'
    from = isLocalPath(folder) ? folder : `${from}/${folder}`
  }
  const root = (verb === 'check' ? p.draft?.root : null) ?? (await topOf($, from))
  if (!root) return 'OS-Deck proof: that folder is not inside a git repository. /os-deck proof setup <folder> names one.'

  const records = await loadRecords($, root)
  const granted = p.allowed.find(a => samePath(a.grant.root, root))?.grant.checks
  let checks: ProofCheck[]
  let source: 'detected' | 'saved' | 'typed'
  if (typed) {
    const one = typed
    const base = p.draft?.root === root ? p.draft.checks : (granted ?? [])
    checks = [...base.filter(c => c.id !== one.id), one]
    source = 'typed'
  } else if (granted || records.checks.length > 0) {
    checks = granted ?? records.checks
    source = 'saved'
  } else {
    checks = await detectChecks($, root)
    source = 'detected'
  }
  if (checks.length === 0) return 'OS-Deck proof: no test, typecheck, lint or build found here. /os-deck proof check <kind> -- <command> names one.'
  const draft = await draftFor($, root, checks, source)
  const past = records.attempts.slice(-20).map(a => ({ root, at: a.startedAt, label: pastLabel(a) }))
  await ops.setProof(s => (s.session === session ? { ...s, draft, past: [...s.past.filter(x => x.root !== root), ...past] } : s))
  return `OS-Deck proof: ${checks.length} check${checks.length === 1 ? '' : 's'} shown in the dock. Nothing has run; press allow there to let them.`
}

// ---------------------------------------------------------------- presses

export async function pressAllow($: EngineInterface, ops: ProofOps, root: string, drawnDigest: string, auto: boolean): Promise<void> {
  const refuse = (why: string) => $.ui.toast(`OS-Deck proof: ${why}`)
  const session = await currentSession($, ops)
  const draft = (await ops.proof()).draft
  if (!draft || draft.root !== root || draft.digest !== drawnDigest || !drawnDigest || draft.problem) return refuse('what was pressed is no longer what is shown')
  const start = await readRevision($, root)
  if (!start.ok) return refuse(`this repository cannot be verified: ${start.reason}`)
  // Drafted again after the content was read, so the bodies shown are those whose hashes are watched.
  const again = await draftFor($, root, draft.checks, draft.source)
  if (again.problem || again.digest !== drawnDigest) {
    await ops.setProof(p => ({ ...p, draft: again }))
    return refuse('the checks changed since they were shown: read them again')
  }
  const at = await $.clock.now()
  const made = await grantFrom({ session, root, checks: again.checks, scripts: again.scripts, drawnDigest, auto, at })
  if ('refused' in made) return refuse(made.refused)
  // What a script body names is run as much as what the command names.
  const behind = again.scripts.map(s => {
    const check = again.checks.find(c => c.id === s.checkId) as ProofCheck
    return { ...check, argv: s.body.split(/[\s;&|()"'`]+/).filter(Boolean) }
  })
  const paths = new Set(watchedPaths([...again.checks, ...behind], start.hashes, root))
  // A check pointed at a folder runs the manifests inside it.
  for (const check of again.checks)
    for (const arg of check.argv)
      for (const file of ['.claude-plugin/plugin.json', 'hooks/hooks.json']) if (start.hashes.has(`${arg}/${file}`)) paths.add(`${arg}/${file}`)
  const watched = [...paths].map(path => [path, start.hashes.get(path) ?? null] as [string, string | null])
  live.get(root)?.signal.cancel()
  await ops.setProof(p => {
    if (p.session !== session) return p
    return { ...p, draft: null, paused: p.paused.filter(x => x.root !== root), allowed: [...p.allowed.filter(a => !samePath(a.grant.root, root)), { grant: made.grant, watched }] }
  })
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
  await ops.setProof(s => (s.session === session ? { ...s, allowed: s.allowed.map(a => (a.grant.root === root ? { ...a, grant: { ...a.grant, checks } } : a)) } : s))
  await noteSaved(ops, await saveChecks($, root, checks))
}

export async function pressReview($: EngineInterface, ops: ProofOps, claim: string, revisions: { root: string; revision: string }[]): Promise<void> {
  const session = await currentSession($, ops)
  if (revisions.length === 0 || !(await ops.proof()).claims.some(c => c.id === claim && c.session === session && !c.withdrawn)) return
  const review = { claim, revisions, at: await $.clock.now() }
  await ops.setProof(p => (p.session === session ? { ...p, reviews: [...p.reviews.filter(r => r.claim !== claim), review].slice(-MAX_KEPT) } : p))
  await noteSaved(ops, await saveReview($, revisions[0]?.root ?? '', review))
}

export async function pressShowLog(ops: ProofOps, root: string, checkId: string | null): Promise<void> {
  const isSame = shownLog?.root === root && shownLog.checkId === checkId
  shownLog = checkId === null || isSame ? null : { root, checkId, text: tails.get(`${checkId}\n${root}`) ?? 'no output kept' }
  await ops.setWork(w => ({ ...w }))
}
