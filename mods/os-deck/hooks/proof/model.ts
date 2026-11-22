// The contract between Agent Proof's parts. Types only. The hooks module owns the state and the engine
// calls; lifecycle, setup, history and view are given values and hand values back.
import type { EngineInterface } from 'claude-code'

import type { ProofAttempt, ProofCheck, ProofClaim, ProofGrant, ProofReview } from '../../types'
import type { RootVerdict, Verdict } from './verdict'

/** A root's content as read: what `readRevision` gave, as plain data. */
export type Manifest = { root: string; revision: string; files: [path: string, hash: string][] }

/** A task under way: where each root stood as it began, and what was seen meanwhile. Session state. */
export type OpenTask = {
  taskId: string
  at: number
  /** The session's allowed roots as the task began; a root missing here has no baseline for it. */
  start: Manifest[]
  /** Roots allowed then whose content could not be read. */
  unread: string[]
  /** Absolute paths of observed edits. */
  edits: string[]
  /** Other tasks whose time under way overlapped this one's, kept after they end. */
  overlap: string[]
  editors?: string[]
}

export type Tracking = {
  open: OpenTask[]
  /** The agent's own descriptions, from TaskCreate, by task id. */
  descriptions: [taskId: string, text: string][]
}

/** proof/lifecycle.ts: pure. */
export type Lifecycle = {
  describeTask: (t: Tracking, taskId: string, text: string) => Tracking
  startTask: (t: Tracking, x: { taskId: string; at: number; start: Manifest[]; unread: string[] }) => Tracking
  noteEdit: (t: Tracking, path: string) => Tracking
  dropTask: (t: Tracking, taskId: string) => Tracking
  completeTask: (
    t: Tracking,
    x: { session: string; taskId: string; subject: string; agentId: string | null; at: number; end: Manifest[]; unread: string[]; roots: string[]; claims: readonly ProofClaim[] },
  ) => { tracking: Tracking; claim: ProofClaim }
  withdrawClaims: (claims: readonly ProofClaim[], session: string, taskId: string) => ProofClaim[]
  /** The roots an automatic run is owed on, now that a turn ended with an answer. */
  rootsToRun: (x: {
    session: string
    grants: readonly ProofGrant[]
    claims: readonly ProofClaim[]
    attempts: readonly ProofAttempt[]
    /** Roots paused because a watched file changed. */
    paused: readonly string[]
    /** Roots with a run under way. */
    busy: readonly string[]
  }) => string[]
  /** The watched paths whose content is not what was allowed. */
  changedWatched: (allowed: readonly [path: string, hash: string | null][], now: ReadonlyMap<string, string>) => string[]
  /** The changed paths a person should look at: tests, scripts, test configuration. */
  reviewWorthy: (paths: readonly string[]) => string[]
}

/** What setup found or was given, before anyone allowed anything. */
export type Draft = {
  root: string
  checks: ProofCheck[]
  /** The offer's digest (checks, baselines, script bodies): what a press is bound to. */
  digest: string
  /** Package script bodies behind the checks, pre and post hooks included, exactly as written. */
  scripts: { checkId: string; name: string; body: string }[]
  /** Why it cannot be allowed as it stands; null where it can. */
  problem: string | null
  source: 'detected' | 'saved' | 'typed'
}

/** proof/setup.ts: reads, runs nothing. */
export type Setup = {
  /** Candidate checks from manifests at the root. */
  detectChecks: ($: EngineInterface, root: string) => Promise<ProofCheck[]>
  /** `<kind> [--dir <folder>] -- <argv>` as typed, or why it was not understood. */
  parseTypedCheck: (args: string) => { check: ProofCheck } | { error: string }
  draftFor: ($: EngineInterface, root: string, checks: readonly ProofCheck[], source: Draft['source']) => Promise<Draft>
}

export type ProofRecords = { claims: ProofClaim[]; attempts: ProofAttempt[]; reviews: ProofReview[]; checks: ProofCheck[] }

/** proof/history.ts: the store. Nothing read from it allows or verifies anything. */
export type History = {
  saveAttempt: ($: EngineInterface, attempt: ProofAttempt) => Promise<boolean>
  saveClaim: ($: EngineInterface, root: string, claim: ProofClaim) => Promise<boolean>
  saveReview: ($: EngineInterface, root: string, review: ProofReview) => Promise<boolean>
  saveChecks: ($: EngineInterface, root: string, checks: readonly ProofCheck[]) => Promise<boolean>
  loadRecords: ($: EngineInterface, root: string) => Promise<ProofRecords>
}

export type RootView = {
  root: string
  /** The folder's name, for the one-line form. */
  name: string
  grant: ProofGrant | null
  verdict: RootVerdict
  revision: string | null
  /** When the revision was last read. */
  checkedAt: number | null
  paused: string[]
  /** The unaccepted counts of the last test run, where a baseline can be accepted. */
  baseline: { attemptId: string; checkId: string; passed: number; skipped: number } | null
}

export type TaskView = {
  claim: ProofClaim
  verdict: Verdict
  isReviewed: boolean
  /** The revisions drawn here: what a review press is bound to. */
  drawn: { root: string; revision: string }[]
  reviewWorthy: string[]
  /** Earlier attempts on its roots, newest first. */
  earlier: { at: number; label: string }[]
}

export type ProofViewModel = {
  now: number
  roots: RootView[]
  tasks: TaskView[]
  /** The claim whose detail is open. */
  openClaim: string | null
  draft: Draft | null
  /** The kept output tail shown, once asked for. */
  log: { root: string; checkId: string; text: string } | null
  notSaved: boolean
}

/** Every press. Each carries what was drawn, so a press cannot act on what was not seen. */
export type ProofActions = {
  toggleClaim: (claimId: string) => unknown
  allow: (root: string, drawnDigest: string, auto: boolean) => unknown
  discardDraft: () => unknown
  verify: (root: string) => unknown
  cancel: (root: string) => unknown
  acceptBaseline: (root: string, attemptId: string, checkId: string, passed: number, skipped: number) => unknown
  resume: (root: string, changed: string[]) => unknown
  review: (claimId: string, drawn: { root: string; revision: string }[]) => unknown
  showLog: (root: string, checkId: string | null) => unknown
}
