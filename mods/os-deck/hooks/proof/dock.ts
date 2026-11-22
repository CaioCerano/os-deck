// Agent Proof's part of the plan view, worked out whole: the hooks module only places it.
import type { AgentCard, LogLine, Plan, ProofSession, ProofWork } from '../../types'
import { cardTitle } from '../core'
import { liveRuns, logShown } from './controller'
import { isClaimOf } from './lifecycle'
import { presentProof } from './present'
import { withoutMarks } from './showable'
import { logTail, proofNotices, proofSummary, setupDraft, taskDetail, taskMark } from './view'
import type { ProofDraw, Section } from './view'

// Clipped, a command reads as another: none is allowed from a screen that cannot draw it whole.
const MIN_ALLOW_COLUMNS = 40

/** Anything allowed, or setup on the screen. Before that the dock is as it was. */
export const isProofOn = (p: ProofSession) => p.allowed.length > 0 || p.draft !== null

type Words = { plan: Plan; cards: AgentCard[]; lines: LogLine[] }

/** With proof on a check mark is the dock's alone to draw: not a subject's, an agent's title's or its words'. */
export const unposed = (p: ProofSession, x: Words): Words =>
  !isProofOn(p)
    ? x
    : {
        plan: {
          ...x.plan,
          tasks: x.plan.tasks.map(t => ({ ...t, subject: withoutMarks(t.subject), activeForm: withoutMarks(t.activeForm), group: t.group.map(withoutMarks) })),
          groups: (x.plan.groups ?? []).map(withoutMarks),
        },
        cards: x.cards.map(c => ({ ...c, description: withoutMarks(c.description), type: withoutMarks(c.type) })),
        lines: x.lines.map(l => ({ ...l, who: withoutMarks(l.who), text: withoutMarks(l.text) })),
      }

export type DockFacts = {
  draw: ProofDraw
  /** The pane's own columns, which can be fewer than the card's. */
  columns: number
  state: ProofSession
  work: ProofWork
  /** The session's own plan, its words as they are. */
  tasks: Plan['tasks']
  cards: readonly AgentCard[]
  /** A sample plan is drawn, whose tasks have no claims. */
  isSample: boolean
  now: number
}

/** Draws nothing before setup. */
export const proofDock = (f: DockFacts) => {
  const { draw } = f
  const seen = presentProof(f.state, f.work, liveRuns(), logShown(), f.now)
  const vm = {
    ...seen,
    tasks: seen.tasks.map(task => {
      const by = f.cards.find(c => c.id === task.claim.agentId)
      return by ? { ...task, claim: { ...task.claim, agentId: cardTitle(by) } } : task
    }),
  }
  // An id is not a task: a mark is drawn only on the completed task its claim is of.
  const ofTheirTasks = vm.tasks.filter(x => {
    const task = f.tasks.find(t => t.id === x.claim.taskId && t.source === 'task')
    return !x.claim.withdrawn && task?.status === 'completed' && isClaimOf(x.claim, task)
  })
  const marked = new Map(f.isSample ? [] : ofTheirTasks.map(x => [x.claim.taskId, x] as const))
  const offered = vm.draft && f.columns < MIN_ALLOW_COLUMNS ? { ...vm.draft, problem: `widen the dock to ${MIN_ALLOW_COLUMNS} columns` } : vm.draft
  const head: Section[] = [setupDraft(draw, offered), proofSummary(draw, vm), proofNotices(draw, vm), logTail(draw, vm)]
  const open = vm.tasks.find(x => x.claim.id === vm.openClaim)
  let detail = open ? taskDetail(draw, vm, open, 2) : null
  return {
    head,
    rows: head.reduce((n, x) => n + x.rows, 0) + (detail?.rows ?? 0),
    hasMarks: marked.size > 0,
    mark: (taskId: string) => {
      const task = marked.get(taskId)
      return task ? taskMark(draw, task).node : null
    },
    /** The opened claim's detail, once: under its task's row, or with no id wherever that is asked. */
    takeDetail: (taskId?: string): Section | null => {
      if (!detail || (taskId !== undefined && open?.claim.taskId !== taskId)) return null
      const taken = detail
      detail = null
      return taken
    },
    needsLook: (taskId: string) => {
      const task = marked.get(taskId)
      return task !== undefined && (task.verdict.state !== 'verified' || !task.isReviewed)
    },
  }
}
