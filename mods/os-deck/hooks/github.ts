// The GitHub section: the pull request of the session's branch, its checks and review, and the
// issues it closes; with no pull request for the branch, the repository's open ones. Read with the
// `gh` CLI by argument vector, no shell, from the session's repository. Pure parsing here, the one
// read below; the hooks module keeps the result in $.state and draws it.
import type { EngineInterface } from 'claude-code'

import type { GhCheck, GhPr, Github } from '../types'

export const DEFAULT_GITHUB: Github = { status: 'off', pr: null, open: [], at: 0, error: null }

/** How often the section reads again at most, unless forced (after a push, a `gh pr` command). */
export const GITHUB_FRESH_MS = 60_000

const PR_FIELDS = 'number,title,state,isDraft,reviewDecision,statusCheckRollup,url,body,headRefName'

/** The issues a pull request body closes: `Closes #12`, `fixes #3`, `resolved #40`, in order, once each. */
export const closingIssuesOf = (body: string): number[] => {
  const out: number[] = []
  for (const m of body.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s+#(\d+)/gi)) {
    const n = Number(m[1])
    if (n > 0 && !out.includes(n)) out.push(n)
  }
  return out.slice(0, 6)
}

/**
 * A check of `statusCheckRollup`, either kind: a check run (`status`, `conclusion`) or a commit
 * status (`state`). Pending until it completes; then passed, failed, or skipped.
 */
export const checkOf = (x: unknown): GhCheck | null => {
  if (!x || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  const name = String(o.name ?? o.context ?? 'check')
  const state = String(o.state ?? '').toUpperCase()
  const status = String(o.status ?? '').toUpperCase()
  const conclusion = String(o.conclusion ?? '').toUpperCase()
  if (state) {
    const s = state === 'SUCCESS' ? 'passed' : state === 'FAILURE' || state === 'ERROR' ? 'failed' : 'pending'
    return { name, state: s }
  }
  if (status && status !== 'COMPLETED') return { name, state: 'pending' }
  const s = conclusion === 'SUCCESS' ? 'passed' : conclusion === 'SKIPPED' || conclusion === 'NEUTRAL' ? 'skipped' : conclusion ? 'failed' : 'pending'
  return { name, state: s }
}

/** `gh pr view --json` output, read leniently; null for anything that is not one pull request. */
export const parsePr = (stdout: string): GhPr | null => {
  let o: Record<string, unknown>
  try {
    o = JSON.parse(stdout) as Record<string, unknown>
  } catch {
    return null
  }
  if (!o || typeof o !== 'object' || typeof o.number !== 'number') return null
  const checks = Array.isArray(o.statusCheckRollup) ? o.statusCheckRollup.map(checkOf).filter((c): c is GhCheck => c !== null) : []
  const review = String(o.reviewDecision ?? '')
  return {
    number: o.number,
    title: String(o.title ?? ''),
    state: String(o.state ?? 'OPEN').toUpperCase() === 'MERGED' ? 'merged' : String(o.state ?? 'OPEN').toUpperCase() === 'CLOSED' ? 'closed' : 'open',
    isDraft: o.isDraft === true,
    review: review === 'APPROVED' ? 'approved' : review === 'CHANGES_REQUESTED' ? 'changes' : review === 'REVIEW_REQUIRED' ? 'required' : 'none',
    checks,
    closes: closingIssuesOf(String(o.body ?? '')),
    url: String(o.url ?? ''),
    branch: String(o.headRefName ?? ''),
  }
}

/** `gh pr list --json number,title,headRefName,isDraft` output: the open pull requests, five at most. */
export const parsePrList = (stdout: string): Github['open'] => {
  try {
    const xs = JSON.parse(stdout) as unknown
    if (!Array.isArray(xs)) return []
    return xs
      .filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === 'object' && typeof (x as Record<string, unknown>).number === 'number')
      .map(x => ({ number: x.number as number, title: String(x.title ?? ''), branch: String(x.headRefName ?? ''), isDraft: x.isDraft === true }))
      .slice(0, 5)
  } catch {
    return []
  }
}

/** The checks in a few words: `✓5`, `✗1 ✓4`, `…2 ✓3`, or `no checks`. */
export const checksLine = (checks: readonly GhCheck[]): { text: string; worst: 'passed' | 'failed' | 'pending' | 'none' } => {
  if (checks.length === 0) return { text: 'no checks', worst: 'none' }
  const n = (s: GhCheck['state']) => checks.filter(c => c.state === s).length
  const [failed, pending, passed] = [n('failed'), n('pending'), n('passed')]
  const parts = [failed ? `✗${failed}` : '', pending ? `…${pending}` : '', passed ? `✓${passed}` : ''].filter(Boolean)
  return { text: parts.join(' ') || `${checks.length} skipped`, worst: failed ? 'failed' : pending ? 'pending' : 'passed' }
}

/** A gh error in a few words: not installed, not signed in, not a GitHub repository, or its first line. */
export const ghErrorOf = (stderr: string, exitCode: number): string => {
  const s = stderr.toLowerCase()
  if (s.includes('auth login') || s.includes('not logged')) return 'gh is not signed in (gh auth login)'
  if (s.includes('not a git repository') || s.includes('no git remotes') || s.includes('none of the git remotes')) return 'not a GitHub repository'
  return stderr.trim().split('\n')[0]?.slice(0, 80) || `gh exited ${exitCode}`
}

/**
 * Reads the section from `dir`: the branch's pull request, or, when it has none, the open ones.
 * Never throws: a missing gh, a signed-out one or a repository without GitHub is a status.
 */
export async function readGithub($: EngineInterface, dir: string, gh = 'gh'): Promise<Github> {
  const at = await $.clock.now()
  const run = (argv: string[]) => $.process.run([gh, ...argv], { cwd: dir, timeoutMs: 15_000 })
  let view
  try {
    view = await run(['pr', 'view', '--json', PR_FIELDS])
  } catch (err) {
    const text = String(err)
    return { ...DEFAULT_GITHUB, status: /enoent|not found|no such file/i.test(text) ? 'missing' : 'error', at, error: text.slice(0, 80) }
  }
  // A shell's way of saying the program is not there.
  if (view.exitCode === 127 || /command not found|is not recognized|enoent/i.test(view.stderr)) return { ...DEFAULT_GITHUB, status: 'missing', at, error: ghErrorOf(view.stderr, view.exitCode) }
  if (view.exitCode === 0) {
    const pr = parsePr(view.stdout)
    if (pr) return { status: 'ok', pr, open: [], at, error: null }
  }
  // No pull request for this branch (or a detached head): the open ones stand in.
  if (!/no pull requests found|no open pull requests/i.test(view.stderr + view.stdout) && view.exitCode !== 0)
    return { ...DEFAULT_GITHUB, status: 'error', at, error: ghErrorOf(view.stderr, view.exitCode) }
  const list = await run(['pr', 'list', '--state', 'open', '--limit', '5', '--json', 'number,title,headRefName,isDraft']).catch(() => null)
  return { status: 'ok', pr: null, open: list && list.exitCode === 0 ? parsePrList(list.stdout) : [], at, error: null }
}
