// What may be allowed to run, and the allowance itself. An invalid definition is refused with its
// reason, never repaired: what a person allowed and what runs are the same bytes.
import type { ProofCheck, ProofGrant } from '../../types'
import { redact } from '../redact'
import { isLocalPath } from './revision'

const KINDS: readonly string[] = ['test', 'typecheck', 'lint', 'build']
const PARSERS: readonly string[] = ['bun', 'pass-fail-lines']
const MAX_CHECKS = 8
export const MAX_TIMEOUT_S = 3600

/** Why an argument may not be run; null for one that may. */
const badArgument = (arg: string): string | null => {
  // A .cmd shim hands its arguments to cmd, which reads them again.
  if (/[&|<>^%!"]/.test(arg)) return 'a character cmd would read as its own'
  // What cannot be seen cannot be approved.
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(arg)) return 'a character that does not show'
  if (/(?:^|[=,;@])[\\/]{2}[^\\/]/.test(arg) || /(?:^|=)file:/i.test(arg)) return 'a network path'
  return null
}

/** Why a check may not be allowed; null for one that may. */
export const checkProblem = (c: ProofCheck): string | null => {
  if (!KINDS.includes(c.kind)) return 'an unknown kind of check'
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(c.id)) return 'an id not understood'
  if (!Array.isArray(c.argv) || c.argv.length === 0 || c.argv.length > 24 || c.argv.some(a => typeof a !== 'string' || a === '')) return 'no command'
  if (c.argv.join(' ').length > 400) return 'a command too long to show whole'
  const exe = c.argv[0] as string
  // A bare name, which the engine never takes from the current folder, or a path on this machine.
  if (!/^[\w+-][\w.+-]*$/.test(exe) && !isLocalPath(exe)) return 'a program that is neither a bare name nor a full local path'
  for (const arg of c.argv) {
    const bad = badArgument(arg)
    if (bad) return bad
  }
  // Shown through redaction it would not be what runs.
  const line = c.argv.join(' ')
  if (redact(line) !== line) return 'what looks like a secret'
  if (typeof c.dir !== 'string' || c.dir.length > 200) return 'a folder not understood'
  if (c.dir !== '' && (c.dir.startsWith('/') || /[\\:]/.test(c.dir) || c.dir.split('/').some(p => p === '' || p === '.' || p === '..') || badArgument(c.dir))) return 'a folder outside the repository'
  if (!Number.isSafeInteger(c.timeoutS) || c.timeoutS < 1 || c.timeoutS > MAX_TIMEOUT_S) return 'a time limit out of range'
  if (typeof c.required !== 'boolean') return 'no word on whether it is required'
  if (c.count && !PARSERS.includes(c.count.parser)) return 'a count format not known'
  return null
}

/** Why a set of checks may not be allowed for a root; null where it may. */
export const setupProblem = (root: string, checks: readonly ProofCheck[]): string | null => {
  if (!isLocalPath(root)) return 'the root is not a folder on this machine'
  if (checks.length === 0) return 'no check'
  if (checks.length > MAX_CHECKS) return `more than ${MAX_CHECKS} checks`
  if (new Set(checks.map(c => c.id)).size !== checks.length) return 'two checks with one id'
  if (!checks.some(c => c.required)) return 'no check is required'
  for (const c of checks) {
    const bad = checkProblem(c)
    if (bad) return `${c.id}: ${bad}`
  }
  return null
}

/**
 * The hash of what would run. The accepted counts are not in it: accepting a baseline judges the run
 * that was seen, and runs nothing.
 */
export async function digestOf(root: string, checks: readonly ProofCheck[]): Promise<string> {
  const body = JSON.stringify([root, checks.map(c => [c.id, c.kind, c.argv, c.dir, c.timeoutS, c.required, c.count?.parser ?? null])])
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body))
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export type Press = { session: string; root: string; checks: readonly ProofCheck[]; drawnDigest: string; auto?: boolean; at: number }

/**
 * An allowance from a person's press, or why there is none: only for what was drawn when they pressed,
 * and only for this session. Automatic unless they chose manual.
 */
export async function grantFrom(p: Press): Promise<{ grant: ProofGrant } | { refused: string }> {
  if (!p.session) return { refused: 'the session is not known' }
  const problem = setupProblem(p.root, p.checks)
  if (problem) return { refused: problem }
  const digest = await digestOf(p.root, p.checks)
  if (digest !== p.drawnDigest) return { refused: 'the checks changed since they were shown' }
  const checks = p.checks.map(c => ({ ...c, argv: [...c.argv], ...(c.count ? { count: { ...c.count } } : {}) }))
  return { grant: { session: p.session, root: p.root, checks, digest, auto: p.auto !== false, at: p.at } }
}

/** Whether a grant still allows running, asked again before every run. */
export async function mayRun(grant: ProofGrant | null | undefined, session: string, root: string): Promise<boolean> {
  if (!grant || !session || grant.session !== session || grant.root !== root) return false
  return setupProblem(root, grant.checks) === null && (await digestOf(root, grant.checks)) === grant.digest
}

/** A definition read back from the store: only ever something to suggest, with no baseline it did not have. */
export const suggestedChecks = (stored: unknown): ProofCheck[] => {
  if (!Array.isArray(stored)) return []
  const out: ProofCheck[] = []
  for (const x of stored.slice(0, MAX_CHECKS)) {
    if (typeof x !== 'object' || x === null) continue
    const v = x as ProofCheck
    const count = typeof v.count === 'object' && v.count !== null ? { parser: v.count.parser, minPassed: v.count.minPassed ?? null, maxSkipped: v.count.maxSkipped ?? 0 } : null
    const check: ProofCheck = { id: String(v.id), kind: v.kind, description: redact(String(v.description ?? '')).slice(0, 80), argv: Array.isArray(v.argv) ? [...v.argv] : [], dir: v.dir ?? '', timeoutS: v.timeoutS, required: v.required, ...(count ? { count } : {}) }
    if (checkProblem(check) === null) out.push(check)
  }
  return out
}

/** The files whose change means a check no longer runs what was allowed: its manifests and any file it names. */
export const watchedPaths = (checks: readonly ProofCheck[], files: ReadonlyMap<string, string>): string[] => {
  const out = new Set<string>()
  const lower = new Map([...files.keys()].map(f => [f.toLowerCase(), f]))
  const watch = (path: string) => {
    const found = lower.get(path.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase())
    if (found) out.add(found)
  }
  for (const c of checks) {
    const inDir = (name: string) => (c.dir ? `${c.dir}/${name}` : name)
    // Manifests of the folder, and of the root above it.
    for (const name of ['package.json', 'bunfig.toml', '.npmrc', 'tsconfig.json', 'Makefile']) {
      watch(inDir(name))
      watch(name)
    }
    for (const arg of c.argv) {
      const value = (arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg).replace(/^\.\//, '')
      watch(inDir(value))
      watch(value)
    }
  }
  return [...out].sort()
}
