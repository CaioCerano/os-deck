// Test counts read from a run's output as it streams: a line at a time, every line seen, so a long run
// loses nothing to a kept tail. A format not recognized gives no count, and no count is no pass.
import type { ProofCount, ProofCountRule } from '../../types'

export type Counter = { line: (text: string) => void; count: () => ProofCount | null }

/** A line without its colours, its end or the spaces after it. */
const bare = (text: string) => text.slice(0, 2000).replace(/\x1b\[[0-9;]{0,32}m/g, '').trimEnd()

/** `bun test` and `claude plugin test`: ` 152 pass`, ` 0 fail`, then `Ran 152 tests across 5 files.` */
const bunCounter = (): Counter => {
  let seen: { pass?: number; fail?: number; skip?: number; todo?: number } = {}
  let total: ProofCount | null = null
  let isBroken = false
  return {
    line(text) {
      const s = bare(text)
      const part = /^ {0,4}(\d{1,9}) (pass|fail|skip|todo)$/.exec(s)
      if (part) {
        seen[part[2] as 'pass'] = Number(part[1])
        return
      }
      const ran = /^Ran (\d{1,9}) tests? across \d{1,9} files?\./.exec(s)
      if (!ran) return
      const { pass, fail, skip = 0, todo = 0 } = seen
      seen = {}
      // A summary whose parts do not add up is not a summary understood.
      if (pass === undefined || fail === undefined || pass + fail + skip + todo !== Number(ran[1])) {
        isBroken = true
        // A failure is still a failure.
        if (fail) total = { passed: total?.passed ?? 0, failed: (total?.failed ?? 0) + fail, skipped: total?.skipped ?? 0 }
        return
      }
      total = { passed: (total?.passed ?? 0) + pass, failed: (total?.failed ?? 0) + fail, skipped: (total?.skipped ?? 0) + skip + todo }
    },
    count: () => (isBroken && !total?.failed ? null : total),
  }
}

/** A suite that prints a line a test: `[PASS] …`, `[FAIL] …`, `[SKIP] …`. */
const lineCounter = (): Counter => {
  const total = { passed: 0, failed: 0, skipped: 0 }
  return {
    line(text) {
      const word = /^\[(PASS|FAIL|SKIP)\](?:\s|$)/.exec(bare(text))?.[1]
      if (word === 'PASS') total.passed += 1
      else if (word === 'FAIL') total.failed += 1
      else if (word === 'SKIP') total.skipped += 1
    },
    count: () => (total.passed + total.failed + total.skipped > 0 ? { ...total } : null),
  }
}

export const counterFor = (parser: ProofCountRule['parser']): Counter => (parser === 'bun' ? bunCounter() : lineCounter())
