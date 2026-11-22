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
/** How long a stopped child is given to be gone before the content is read again. */
export const KILL_WAIT_MS = 5_000

const MASK = '•••'
const BLOCK_OPENS = /^([ \t]{0,40})[^\n:]{0,80}(?:password|passwd|passphrase|pwd|secret|token|key|credentials)\d{0,3}["']?[ \t]{0,3}:[ \t]{0,3}[|>]/i

/**
 * The end of one pipe, safe to keep. The secrets that span lines are masked as the lines arrive: once
 * the head of one is cut away, nothing left says it is a secret.
 */
const safePipe = () => {
  let lines: string[] = []
  let size = 0
  let wasCut = false
  let inKey = false
  let block: number | null = null
  const add = (line: string) => {
    lines.push(line)
    size += line.length + 1
    while (size > KEPT && lines.length > 1) {
      size -= (lines.shift() as string).length + 1
      wasCut = true
    }
  }
  return {
    line(raw: string, isWhole: boolean) {
      const text = raw.replace(/\r$/, '')
      if (/-----END [A-Z ]{0,50}PRIVATE KEY/.test(text)) {
        // Its head may be behind the cut, or never have been printed: what came before it goes too.
        if (!inKey) {
          lines = []
          size = 0
        }
        inKey = false
        return add(MASK)
      }
      if (inKey) return add(MASK)
      if (/-----BEGIN [A-Z ]{0,50}PRIVATE KEY/.test(text)) {
        inKey = true
        return add(MASK)
      }
      if (block !== null) {
        if (text.trim() === '' || text.length - text.trimStart().length > block) return add(MASK)
        block = null
      }
      const opens = BLOCK_OPENS.exec(text)
      if (opens) block = (opens[1] as string).length
      // A line too long to hold can end in half a secret.
      add(isWhole ? text : MASK)
    },
    text() {
      // The first line after a cut may go on from one that is gone.
      const kept = redact((wasCut ? lines.slice(1) : lines).join('\n'))
      return kept
    },
  }
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
type Pipe = 'stdout' | 'stderr'

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
    const exe = check.argv[0] as string
    // Named whole, it must be there: absent, Windows would look for it under another extension.
    if (isLocalPath(exe) && (await $.fs.stat(exe).catch(() => null))?.kind !== 'file') return await ended('unavailable', { reason: 'its program is not there' })
    const cwd = await folderOf($, root, check.dir)
    if (cwd === null) return await ended('unavailable', { reason: 'its folder is not there, or is a link' })
    if (signal.cancelled) return await ended('cancelled')

    const counter = check.count ? counterFor(check.count.parser) : null
    const pipes = { stdout: safePipe(), stderr: safePipe() }
    // Each pipe its own partial line: a piece ends wherever the child's write did.
    const partial = { stdout: '', stderr: '' }
    const overlong = { stdout: false, stderr: false }
    let lastPipe: Pipe = 'stdout'
    const endLine = (pipe: Pipe, text: string) => {
      counter?.line(text, pipe)
      pipes[pipe].line(text, !overlong[pipe] && text.length <= MAX_LINE)
      overlong[pipe] = false
      if (text.trim()) lastPipe = pipe
    }
    const take = (pipe: Pipe, text: string) => {
      const lines = (partial[pipe] + text).split('\n')
      const rest = lines.pop() ?? ''
      for (const line of lines) endLine(pipe, line)
      if (rest.length > MAX_LINE) overlong[pipe] = true
      // Both ends of a line too long to hold: a failure can be written over at either.
      partial[pipe] = rest.length > MAX_LINE ? `${rest.slice(0, MAX_LINE / 2)}\r${rest.slice(-MAX_LINE / 2)}` : rest
    }
    const output = () => {
      for (const pipe of ['stdout', 'stderr'] as const) {
        if (partial[pipe]) endLine(pipe, partial[pipe])
        partial[pipe] = ''
      }
      const other: Pipe = lastPipe === 'stdout' ? 'stderr' : 'stdout'
      // The pipe written last is last, so the summary is the line that was.
      return [pipes[other].text().slice(-TAIL / 2), pipes[lastPipe].text()].filter(Boolean).join('\n').slice(-TAIL)
    }

    let why: 'timed-out' | 'cancelled' | null = null
    // The one waker, replaced each piece: racing one long-lived promise would keep every piece.
    let wake: () => void = () => undefined
    const stop = (reason: 'timed-out' | 'cancelled') => {
      why = why ?? reason
      wake()
    }
    const child = $.process.spawn({ argv: [...check.argv], cwd, env: { ...BLANKED_ENV } })
    const timer = $.clock.after(check.timeoutS * 1000, () => stop('timed-out'))
    signal.onCancel(() => stop('cancelled'))
    const nextPiece = () =>
      new Promise<Awaited<ReturnType<typeof child.next>> | null>((resolve, reject) => {
        wake = () => resolve(null)
        if (why) return resolve(null)
        child.next().then(resolve, reject)
      })
    try {
      for (;;) {
        const step = await nextPiece()
        if (step === null) {
          timer.cancel()
          // Waited for, so the content is read after it stopped writing; bounded, as a return may never settle.
          await new Promise<void>(resolve => {
            const grace = $.clock.after(KILL_WAIT_MS, () => resolve())
            const gone = () => {
              grace.cancel()
              resolve()
            }
            child.return(undefined as never).then(gone, gone)
          })
          const tail = output()
          return await ended(why ?? 'cancelled', { count: counter?.count() ?? null }, tail)
        }
        if (!step.done) {
          take(step.value.stream, step.value.text)
          continue
        }
        timer.cancel()
        const tail = output()
        const { code, signal: killedBy } = step.value as { code: number | null; signal: string | null }
        const count = counter?.count() ?? null
        if (code === null || killedBy) return await ended('interrupted', { count, reason: killedBy ? `ended by ${killedBy}` : null }, tail)
        return await ended('exited', { exitCode: code, count }, tail)
      }
    } catch (err) {
      timer.cancel()
      throw err
    }
  } catch (err) {
    return await ended('unavailable', { reason: redact(String(err)).slice(0, 120) })
  }
}
