// The contract between Agent Proof's parts. Types only. The hooks module owns the state and the engine
// calls; lifecycle, setup, history and view are given values and hand values back.
import type { ProofAttempt, ProofCheck, ProofClaim, ProofGrant, ProofReview, ProofSession, ProofWork } from '../../types'
import type { RootVerdict, Verdict } from './verdict'

/** What is worked from between a task's start and its end: session state, declared with it. */
export type Tracking = ProofWork['tracking']
export type OpenTask = Tracking['open'][number]
/** A root's content as read: what `readRevision` gave, as plain data. */
export type Manifest = OpenTask['start'][number]
/** What setup found or was given, before anyone allowed anything: session state, declared with it. */
export type Draft = NonNullable<ProofSession['draft']>

/** proof/lifecycle.ts: pure. */
export type Lifecycle = {
  describeTask: (t: Tracking, taskId: string, text: string) => Tracking
  startTask: (t: Tracking, x: { taskId: string; at: number; start: Manifest[]; unread: string[] }) => Tracking
  noteEdit: (t: Tracking, path: string, editor: string) => Tracking
  dropTask: (t: Tracking, taskId: string) => Tracking
  /** Back to pending: the baseline goes, what was seen stays. */
  waitTask: (t: Tracking, taskId: string) => Tracking
  completeTask: (
    t: Tracking,
    x: { session: string; taskId: string; subject: string; group?: readonly string[]; agentId: string | null; helpers: readonly string[]; at: number; end: Manifest[]; unread: string[]; roots: string[]; claims: readonly ProofClaim[] },
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
  /** The changed paths a person should look at: tests, scripts, test configuration. */
  reviewWorthy: (paths: readonly string[]) => string[]
}

export type ProofRecords = { claims: ProofClaim[]; attempts: ProofAttempt[]; reviews: ProofReview[]; checks: ProofCheck[] }

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
  /** Claims of this session, the replaced and withdrawn too, that could be of this root and nobody reviewed. */
  unreviewed: number
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
