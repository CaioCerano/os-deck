// Test counts read from a run's output as it streams, every line of both pipes. Doubt runs one way: a
// failure seen anywhere stays seen, and a passing count comes only from one summary that adds up.
import type { ProofCount, ProofCountRule } from '../../types'

type Pipe = 'stdout' | 'stderr'
export type Counter = { line: (text: string, pipe?: Pipe) => void; count: () => ProofCount | null }

const MAX_LINE = 2000

/** What a line showed, each overwrite of it apart: without escapes, its end, or the spaces after it. */
const writtenIn = (text: string): string[] =>
  (text.length > 2 * MAX_LINE ? `${text.slice(0, MAX_LINE)}\r${text.slice(-MAX_LINE)}` : text)
    .replace(/\x1b\[[0-?]{0,32}[ -/]{0,8}[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]{0,256}(?:\x07|\x1b\\)?/g, '')
    .replace(/\x1b./g, '')
    .split('\r')
    .map(part => part.trimEnd())
    .filter(Boolean)

/** `bun test` and `claude plugin test`: ` 152 pass`, ` 0 fail`, then `Ran 152 tests across 5 files.` */
const bunCounter = (): Counter => {
  type Parts = { pass?: number; fail?: number; skip?: number; todo?: number }
  let open: Record<Pipe, Parts> = { stdout: {}, stderr: {} }
  let failed = 0
  let errors = 0
  let summaries = 0
  let summary: ProofCount | null = null
  return {
    line(text, pipe = 'stdout') {
      for (const s of writtenIn(text)) {
        const error = /^ {0,4}(\d{1,9}) errors?$/.exec(s)
        if (error) errors = Math.max(errors, Number(error[1]))
        const part = /^ {0,4}(\d{1,9}) (pass|fail|skip|todo)$/.exec(s)
        if (part) {
          const n = Number(part[1])
          if (part[2] === 'fail') failed = Math.max(failed, n)
          open[pipe][part[2] as 'pass'] = n
          continue
        }
        const ran = /^Ran (\d{1,9}) tests? across \d{1,9} files?\./.exec(s)
        if (!ran) continue
        const { pass, fail, skip = 0, todo = 0 } = open[pipe]
        open = { ...open, [pipe]: {} }
        summaries += 1
        const addsUp = pass !== undefined && fail !== undefined && pass + fail + skip + todo === Number(ran[1])
        summary = addsUp ? { passed: pass, failed: fail, skipped: skip + todo } : null
      }
    },
    count() {
      // An error outside any test is in no other number.
      if (failed + errors > 0) return { passed: summary?.passed ?? 0, failed: failed + errors, skipped: summary?.skipped ?? 0 }
      // A second summary is somebody's output posing as one, or two runs: which is meant is not known.
      return summaries === 1 ? summary : null
    },
  }
}

/** A suite that prints a line a test: `[PASS] …`, `[FAIL] …`, `[SKIP] …`. */
const lineCounter = (): Counter => {
  const total = { passed: 0, failed: 0, skipped: 0 }
  return {
    line(text) {
      const words = writtenIn(text).map(s => /^\[(PASS|FAIL|SKIP)\](?=[\s:.-]|$)/.exec(s)?.[1]).filter(Boolean)
      // One test a line however often it was redrawn, and a failure it ever showed is the one kept.
      const word = words.includes('FAIL') ? 'FAIL' : words[words.length - 1]
      if (word === 'PASS') total.passed += 1
      else if (word === 'FAIL') total.failed += 1
      else if (word === 'SKIP') total.skipped += 1
    },
    count: () => (total.passed + total.failed + total.skipped > 0 ? { ...total } : null),
  }
}

export const counterFor = (parser: ProofCountRule['parser']): Counter => (parser === 'bun' ? bunCounter() : lineCounter())
