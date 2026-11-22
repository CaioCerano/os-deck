// One check, run: an argument vector, no shell, in the allowed root. What is returned is what was
// observed, never whether it passed. `spawn`, not `run`: run stops at ten minutes and drops the end of
// a long output, where a suite prints its summary.
import type { EngineInterface } from 'claude-code'

import type { ProofCheck, ProofExecution, ProofResult } from '../../types'
import { redact } from '../redact'
import { counterFor } from './counts'
import { checkProblem } from './grant'
import { isLocalPath } from './revision'

/** Blanked in the child. A variable can be blanked, not removed, and the rest are inherited: setup says so. */
export const BLANKED_ENV: Readonly<Record<string, string>> = Object.fromEntries(
  [
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY',
    'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITLAB_TOKEN', 'NPM_TOKEN', 'NODE_AUTH_TOKEN',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AZURE_CLIENT_SECRET',
  ].map(name => [name, '']),
)

const KEPT = 16_000
const TAIL = 4_000
const MAX_LINE = 4_000

/** The end of an output made safe: masked whole, then cut, a key whose head was cut off masked too. */
const safeTail = (kept: string, wasCut: boolean) => {
  // The first line of a cut output is half a line: half a secret no longer matches its rule.
  let text = wasCut ? (kept.includes('\n') ? kept.slice(kept.indexOf('\n') + 1) : '') : kept
  const end = text.search(/-----END [A-Z ]{0,50}PRIVATE KEY/)
  if (end >= 0 && !text.slice(0, end).includes('-----BEGIN ')) text = `•••${text.slice(end)}`
  return redact(text).slice(-TAIL)
}

/** The folder a check runs in, every step of it a directory and no link; null where one is not. */
async function folderOf($: EngineInterface, root: string, dir: string): Promise<string | null> {
  let at = root
  for (const part of dir ? dir.split('/') : []) {
    const entry = (await $.fs.list(at)).find(x => x.name === part)
    if (!entry || entry.isLink || entry.kind !== 'dir') return null
    at = `${at}/${part}`
  }
  return at
}

export type CancelSignal = { cancelled: boolean; onCancel: (stop: () => void) => void; cancel: () => void }

export const cancelSignal = (): CancelSignal => {
  const stops: (() => void)[] = []
  const signal: CancelSignal = {
    cancelled: false,
    onCancel: stop => (signal.cancelled ? stop() : void stops.push(stop)),
    cancel: () => {
      if (signal.cancelled) return
      signal.cancelled = true
      for (const stop of stops.splice(0)) stop()
    },
  }
  return signal
}

export type Ran = { result: ProofResult; tail: string }

/** Runs one check on content already at `revision`. Never throws, and always ends by its time limit. */
export async function runCheck($: EngineInterface, root: string, check: ProofCheck, revision: string, signal: CancelSignal): Promise<Ran> {
  let startedAt = 0
  const ended = async (execution: ProofExecution, more: Partial<ProofResult> = {}, tail = ''): Promise<Ran> => {
    let endedAt = startedAt
    try {
      endedAt = await $.clock.now()
    } catch {
      // The session is going: the start stands in.
    }
    const last = tail.split('\n').map(l => l.trim()).filter(Boolean).pop() ?? ''
    return {
      tail,
      result: { id: check.id, kind: check.kind, description: check.description, execution, source: 'os-deck-run', startedAt, endedAt, revision, exitCode: null, count: null, summary: last.slice(0, 160), reason: null, ...more },
    }
  }
  try {
    startedAt = await $.clock.now()
    const problem = isLocalPath(root) ? checkProblem(check) : 'the root is not a folder on this machine'
    if (problem) return await ended('unavailable', { reason: problem })
    const cwd = await folderOf($, root, check.dir)
    if (cwd === null) return await ended('unavailable', { reason: 'its folder is not there, or is a link' })
    if (signal.cancelled) return await ended('cancelled')

    const counter = check.count ? counterFor(check.count.parser) : null
    let kept = ''
    let wasCut = false
    // Each pipe its own partial line: a piece ends wherever the child's write did.
    const partial = { stdout: '', stderr: '' }
    const take = (stream: 'stdout' | 'stderr', text: string) => {
      kept += text
      if (kept.length > KEPT) {
        kept = kept.slice(-KEPT)
        wasCut = true
      }
      const lines = (partial[stream] + text).split('\n')
      partial[stream] = (lines.pop() ?? '').slice(0, MAX_LINE)
      for (const line of lines) counter?.line(line)
    }

    let stop: (why: 'timed-out' | 'cancelled') => void = () => undefined
    const stopped = new Promise<'timed-out' | 'cancelled'>(resolve => (stop = resolve))
    const child = $.process.spawn({ argv: [...check.argv], cwd, env: { ...BLANKED_ENV } })
    const timer = $.clock.after(check.timeoutS * 1000, () => stop('timed-out'))
    signal.onCancel(() => stop('cancelled'))
    try {
      for (;;) {
        // Raced: a silent child never settles its next piece.
        const step = await Promise.race([child.next(), stopped])
        if (step === 'timed-out' || step === 'cancelled') {
          // Not awaited: ending the stream kills the child, and may itself never settle.
          void child.return(undefined as never).catch(() => undefined)
          return await ended(step, { count: counter?.count() ?? null }, safeTail(kept, wasCut))
        }
        if (!step.done) {
          take(step.value.stream, step.value.text)
          continue
        }
        if (partial.stdout) counter?.line(partial.stdout)
        if (partial.stderr) counter?.line(partial.stderr)
        const { code, signal: killedBy } = step.value as { code: number | null; signal: string | null }
        const count = counter?.count() ?? null
        if (code === null || killedBy) return await ended('interrupted', { count, reason: killedBy ? `ended by ${killedBy}` : null }, safeTail(kept, wasCut))
        return await ended('exited', { exitCode: code, count }, safeTail(kept, wasCut))
      }
    } finally {
      timer.cancel()
    }
  } catch (err) {
    return await ended('unavailable', { reason: redact(String(err)).slice(0, 120) })
  }
}
