// Session history across sessions: one record per day in $.store, added to as turns end, read back
// by `/os-deck today` and `/os-deck history`. Pure merging and formatting here, plus the store's
// read and write.
import type { EngineInterface } from 'claude-code'

export type DayRecord = {
  /** Main-loop turns that ended. */
  turns: number
  /** Time the main loop spent working, in milliseconds. */
  busyMs: number
  /** Tasks completed. */
  tasks: number
  /** Subagents spawned. */
  agents: number
  /** Cost, in dollars, as the session's own counter moved. */
  costUsd: number
  /** Permission asks the person answered, and the time they waited on them. */
  asks: number
  askWaitMs: number
}

export const EMPTY_DAY: DayRecord = { turns: 0, busyMs: 0, tasks: 0, agents: 0, costUsd: 0, asks: 0, askWaitMs: 0 }
/**
 * Read only since 0.4.3. A session now writes `os-deck:day:<day>#<session>`; once a day no longer
 * changes, its keys fold into DAYS_KEY.
 */
export const HISTORY_KEY = 'os-deck:history'
/** Days kept: about two months. */
export const HISTORY_DAYS = 62

/** The local day of an epoch time, `2026-11-21`. */
export const dayOf = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0)

/** A stored history, read leniently: days in order, unknown fields dropped, the oldest beyond the limit gone. */
export const normalizeHistory = (stored: unknown): Record<string, DayRecord> => {
  const out: Record<string, DayRecord> = {}
  if (!stored || typeof stored !== 'object') return out
  const days = Object.keys(stored as object)
    .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k))
    .sort()
    .slice(-HISTORY_DAYS)
  for (const k of days) {
    const r = (stored as Record<string, Record<string, unknown>>)[k] ?? {}
    out[k] = { turns: num(r.turns), busyMs: num(r.busyMs), tasks: num(r.tasks), agents: num(r.agents), costUsd: num(r.costUsd), asks: num(r.asks), askWaitMs: num(r.askWaitMs) }
  }
  return out
}

/** The history with `delta` added to the day of `at`. */
export const addToDay = (stored: unknown, at: number, delta: Partial<DayRecord>): Record<string, DayRecord> => {
  const h = normalizeHistory(stored)
  const k = dayOf(at)
  const cur = h[k] ?? EMPTY_DAY
  const next = { ...cur }
  for (const f of Object.keys(EMPTY_DAY) as (keyof DayRecord)[]) next[f] = cur[f] + num(delta[f])
  return normalizeHistory({ ...h, [k]: next })
}

const dur = (ms: number) => {
  const m = Math.round(ms / 60_000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/** One day in a line: `2026-11-21  12 turns · 3h05m busy · 9 tasks · 4 agents · $3.20 · 6 asks, 2m waiting`. */
export const dayLine = (day: string, r: DayRecord) =>
  `${day}  ${r.turns} turn${r.turns === 1 ? '' : 's'} · ${dur(r.busyMs)} busy · ${r.tasks} task${r.tasks === 1 ? '' : 's'} · ${r.agents} agent${r.agents === 1 ? '' : 's'} · $${r.costUsd.toFixed(2)}` +
  (r.asks > 0 ? ` · ${r.asks} ask${r.asks === 1 ? '' : 's'}, ${dur(r.askWaitMs)} waiting` : '')

/** The report for `/os-deck today` (one day) or `/os-deck history` (the last seven, newest first, with their total). */
export const historyReport = (stored: unknown, now: number, days: 1 | 7): string => {
  const h = normalizeHistory(stored)
  const keys = Array.from({ length: days }, (_, i) => dayOf(now - i * 86_400_000))
  const shown = keys.filter(k => h[k])
  if (shown.length === 0) return days === 1 ? 'OS-Deck today: nothing recorded yet.' : 'OS-Deck history: nothing recorded in the last 7 days.'
  const lines = shown.map(k => dayLine(k, h[k] as DayRecord))
  if (days === 1) return `OS-Deck today:\n${lines[0]}`
  const total = shown.reduce((t, k) => addToDay(t, 0, h[k] as DayRecord), {} as Record<string, DayRecord>)
  return `OS-Deck history (last 7 days):\n${lines.join('\n')}\n${dayLine('total     ', total[dayOf(0)] ?? EMPTY_DAY)}`
}

let queue: Promise<unknown> = Promise.resolve()

/** Runs a store read-then-write after those before it, so none writes over another's. */
export function inTurn<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job)
  queue = run.catch(() => undefined)
  return run
}

/** The keys sessions keep beside `base`, each `<base>#<session id>`. */
export const sessionKeysIn = (keys: readonly string[], base: string): string[] =>
  keys.filter(k => k.startsWith(`${base}#`) && !/[#/\\]/.test(k.slice(base.length + 1)))

/** Waits for the writes asked so far. */
export async function flushHistory() {
  await inTurn(async () => undefined)
}

const DAY_PREFIX = 'os-deck:day:'
const DAYS_KEY = 'os-deck:history-days'
const PRUNED_KEY = 'os-deck:pruned'
const PLAN_PREFIX = 'plan-history:'
const PLAN_KEPT_MS = 14 * 86_400_000

const sumOf = (a: DayRecord, b: DayRecord): DayRecord => {
  const out = { ...a }
  for (const f of Object.keys(EMPTY_DAY) as (keyof DayRecord)[]) out[f] += b[f]
  return out
}

/** The session keys of each day. */
const byDay = (keys: readonly string[]) => {
  const out = new Map<string, string[]>()
  for (const key of keys) {
    const day = key.startsWith(DAY_PREFIX) ? /^(\d{4}-\d{2}-\d{2})#/.exec(key.slice(DAY_PREFIX.length))?.[1] : undefined
    if (day) out.set(day, [...(out.get(day) ?? []), key])
  }
  return out
}

async function sumDay($: EngineInterface, day: string, keys: readonly string[]): Promise<DayRecord> {
  let sum = EMPTY_DAY
  for (const key of keys) sum = sumOf(sum, normalizeHistory(await $.store.get(key))[day] ?? EMPTY_DAY)
  return sum
}

/** Every session's days added up, with what was saved before each had its own key. */
export async function loadHistory($: EngineInterface): Promise<Record<string, DayRecord>> {
  // After the writes asked before it, outside their queue: reading must not hold them up.
  await flushHistory()
  const out = normalizeHistory(await $.store.get(HISTORY_KEY))
  const folded = normalizeHistory(await $.store.get(DAYS_KEY))
  for (const [day, record] of Object.entries(folded)) out[day] = sumOf(out[day] ?? EMPTY_DAY, record)
  for (const [day, keys] of byDay(await $.store.keys().catch(() => [])))
    if (!folded[day]) out[day] = sumOf(out[day] ?? EMPTY_DAY, await sumDay($, day, keys))
  return normalizeHistory(out)
}

/**
 * Once a day, beside the writes rather than among them: days past changing fold into one key, and plan
 * records past their two weeks go. A folded day is never added to, so two sessions folding it write the
 * same sum. Never throws.
 */
export async function pruneHistory($: EngineInterface, now: number) {
  try {
    const today = dayOf(now)
    if ((await $.store.get(PRUNED_KEY)) === today) return
    await $.store.set(PRUNED_KEY, today)
    const keys = await $.store.keys()
    const settled = dayOf(now - 2 * 86_400_000)
    const oldest = dayOf(now - HISTORY_DAYS * 86_400_000)
    const past = [...byDay(keys)].filter(([day]) => day < settled)
    if (past.length > 0) {
      const sums = new Map<string, DayRecord>()
      for (const [day, dayKeys] of past) if (day >= oldest) sums.set(day, await sumDay($, day, dayKeys))
      // Read after summing: keys are deleted only once their day is folded, so a day not folded by now
      // was summed whole, and one another session folded meanwhile keeps that session's sum.
      const days = normalizeHistory(await $.store.get(DAYS_KEY))
      for (const [day, sum] of sums) if (!days[day]) days[day] = sum
      await $.store.set(DAYS_KEY, normalizeHistory(days))
      for (const [, dayKeys] of past) for (const key of dayKeys) await $.store.delete(key)
    }
    for (const key of keys) {
      if (!key.startsWith(PLAN_PREFIX)) continue
      const v = await $.store.get(key)
      if (typeof v !== 'object' || v === null) continue
      // A session's record, or the map sessions shared before 0.4.3, kept until its newest has expired.
      const own = (v as { at?: unknown }).at
      const times = typeof own === 'number' ? [own] : Object.values(v).map(x => (x as { at?: unknown } | null)?.at).filter((x): x is number => typeof x === 'number')
      if (times.length > 0 && times.every(at => now - at > PLAN_KEPT_MS)) await $.store.delete(key)
    }
  } catch {
    // Left for another day.
  }
}

/** Adds to this session's record of the day. Never throws: history is a nicety. */
export async function recordDay($: EngineInterface, at: number, delta: Partial<DayRecord>) {
  try {
    await inTurn(async () => {
      const key = `${DAY_PREFIX}${dayOf(at)}#${await $.session.id()}`
      await $.store.set(key, addToDay(await $.store.get(key), at, delta))
    })
  } catch {
    // A store that cannot be read or written leaves the history as it was.
  }
}
