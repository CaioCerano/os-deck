// Forecasts for the header and the plan: how many turns the context lasts at the rate it has been
// filling, and how far each phase of the plan is, with a finish estimated from the session's own
// finished tasks. Pure functions; nothing here reads the engine.
import type { PlanTask } from '../types'

/** Context use where the forecast says it is full: compaction comes around here. */
export const FULL_PCT = 95
/** Turn-end readings kept for the rate: enough to smooth one big turn, few enough to follow a change. */
export const TURN_READINGS = 6

/** The turn-end context readings with one more, a compaction's drop starting them over. */
export const withReading = (readings: readonly number[] | undefined, pct: number | null): number[] => {
  if (pct === null || !Number.isFinite(pct)) return [...(readings ?? [])]
  const xs = [...(readings ?? [])]
  const last = xs[xs.length - 1]
  // A drop of more than a few points is a compaction (or a clear): the old rate no longer holds.
  if (last !== undefined && pct < last - 5) return [pct]
  return [...xs, pct].slice(-TURN_READINGS)
}

/**
 * Turns until the context is full at the average growth per turn of the readings, or null when
 * there is no rate yet (fewer than two readings) or it is not growing.
 */
export const turnsToFull = (readings: readonly number[], now: number | null, full = FULL_PCT): number | null => {
  if (readings.length < 2 || now === null) return null
  const first = readings[0] as number
  const last = readings[readings.length - 1] as number
  const perTurn = (last - first) / (readings.length - 1)
  if (perTurn < 0.5) return null
  return Math.max(0, Math.ceil((full - now) / perTurn))
}

/** The forecast in a few words: `~6 turns left`, `full next turn`, or nothing. */
export const turnsLine = (turns: number | null) => (turns === null ? '' : turns <= 1 ? 'full next turn' : `~${turns} turns left`)

export type PhaseProgress = { group: string; done: number; total: number; etaMs: number | null }

/** A task's group as one label: its path joined, `Mascot redesign / Implementação`. */
export const groupLabel = (t: Pick<PlanTask, 'group'>) => t.group.join(' / ')

/**
 * Each group's progress in plan order, and the time its open tasks would take at the session's
 * average task (from start to finish, finished tasks only), less what the running ones have spent.
 * No estimate before a task has finished, and none for a finished group.
 */
export const phaseProgress = (tasks: readonly PlanTask[], now: number): PhaseProgress[] => {
  const real = tasks.filter(t => t.source !== 'jira')
  const took = real.filter(t => t.status === 'completed' && t.startedAt !== null && t.doneAt !== null).map(t => (t.doneAt as number) - (t.startedAt as number))
  const avg = took.length > 0 ? took.reduce((a, b) => a + b, 0) / took.length : null
  const order: string[] = []
  for (const t of real) if (!order.includes(groupLabel(t))) order.push(groupLabel(t))
  return order.map(group => {
    const ts = real.filter(t => groupLabel(t) === group)
    const done = ts.filter(t => t.status === 'completed').length
    let etaMs: number | null = null
    if (avg !== null && done < ts.length) {
      etaMs = ts
        .filter(t => t.status !== 'completed')
        .reduce((sum, t) => sum + Math.max(avg * 0.25, avg - (t.status === 'in_progress' && t.startedAt !== null ? now - t.startedAt : 0)), 0)
    }
    return { group, done, total: ts.length, etaMs }
  })
}

/** The whole plan's estimate: the open groups' estimates added, or null while any open group has none. */
export const planEta = (phases: readonly PhaseProgress[]): number | null => {
  const open = phases.filter(p => p.done < p.total)
  if (open.length === 0 || open.some(p => p.etaMs === null)) return null
  return open.reduce((s, p) => s + (p.etaMs as number), 0)
}
