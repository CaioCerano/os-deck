// What may be allowed to run, and the allowance itself. An invalid definition is refused with its
// reason, never repaired: what a person allowed and what runs are the same bytes.
import type { ProofCheck, ProofGrant } from '../../types'
import { redact } from '../redact'
import { isWindowsOddName } from './names'
import { isLocalPath } from './revision'
import { sha256 } from './values'

const KINDS: readonly string[] = ['test', 'typecheck', 'lint', 'build']
const PARSERS: readonly string[] = ['bun', 'pass-fail-lines']
const MAX_CHECKS = 8
export const MAX_TIMEOUT_S = 3600

/** Why an argument may not be run; null for one that may. */
const badArgument = (arg: string): string | null => {
  // A .cmd shim hands its arguments to cmd, which reads them again.
  if (/[&|<>^%!"]/.test(arg)) return 'a character cmd would read as its own'
  // Programs of Git Bash expand these in their own arguments, with no shell between.
  if (/[*?[\]{}]/.test(arg) || /^[@~]/.test(arg)) return 'a character a program would expand'
  // What cannot be seen cannot be approved.
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u.test(arg)) return 'a character that does not show'
  if (arg !== arg.trim()) return 'a space at either end'
  const local = arg.replace(/^((?:--?[\w-]{1,40}=)?)https?:\/\/(?=[\w.-])/i, '$1').replace(/\\/g, '/')
  if (local.includes('//') || /\/Device\/|file:/i.test(local)) return 'a network path'
  return null
}

/** Why a program may not be run; null where what is named is what would start. */
const badProgram = (exe: string): string | null => {
  if (/^[A-Za-z]:[\\/]/.test(exe)) {
    const steps = exe.slice(3).split(/[\\/]/)
    if (steps.some(s => s === '' || s === '..' || isWindowsOddName(s))) return 'a program path Windows reads differently'
    // Without one of these Windows starts a sibling, or whatever opens that kind of file.
    return /\.(?:exe|com|cmd|bat)$/i.test(exe) ? null : 'a program without .exe, .com, .cmd or .bat'
  }
  if (/^\/(?![\\/])/.test(exe)) {
    return exe.includes('\\') || /(?:^|\/)(?:\.\.|\?\?)(?:\/|$)|^\/Device\//i.test(exe) ? 'a program path not understood' : null
  }
  if (!/^[\w+-][\w.+-]*$/.test(exe) || isWindowsOddName(exe)) return 'a program that is neither a bare name nor a full local path'
  return /\.(?:py|pyw|[cm]?js|jse|[cm]?ts|sh|rb|pl|php|ps1|psm1|vbs|vbe|wsf|hta|lnk|url|txt|msi|scr|pif|jar)$/i.test(exe) ? 'a script in place of a program: name what runs it' : null
}

/** Why a check may not be allowed; null for one that may. */
export const checkProblem = (c: ProofCheck): string | null => {
  if (!KINDS.includes(c.kind)) return 'an unknown kind of check'
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(c.id)) return 'an id not understood'
  if (!Array.isArray(c.argv) || c.argv.length === 0 || c.argv.length > 24 || c.argv.some(a => typeof a !== 'string' || a === '')) return 'no command'
  if (c.argv.join(' ').length > 400) return 'a command too long to show whole'
  const program = badProgram(c.argv[0] as string)
  if (program) return program
  for (const arg of c.argv) {
    const bad = badArgument(arg)
    if (bad) return bad
  }
  // Shown through redaction it would not be what runs.
  const line = c.argv.join(' ')
  if (redact(line) !== line) return 'what looks like a secret'
  if (typeof c.dir !== 'string' || c.dir.length > 200) return 'a folder not understood'
  if (c.dir !== '' && (c.dir.startsWith('/') || /[\\:]/.test(c.dir) || c.dir.split('/').some(p => p === '' || p === '.' || p === '..' || isWindowsOddName(p)) || badArgument(c.dir))) return 'a folder outside the repository'
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

const hashed = (value: unknown) => sha256(JSON.stringify(value))

/**
 * The hash of what would run. The accepted counts are not in it: accepting a baseline judges the run
 * that was seen, and runs nothing.
 */
export const digestOf = (root: string, checks: readonly ProofCheck[]): Promise<string> =>
  hashed([root, checks.map(c => [c.id, c.kind, c.argv, c.dir, c.timeoutS, c.required, c.count?.parser ?? null])])

export type ShownScript = { checkId: string; name: string; body: string }

/** What else a press approves: the bytes of what runs, the config shown, and why it may only be run by hand. */
export type Bound = {
  watched?: readonly (readonly [path: string, hash: string | null])[]
  files?: readonly { path: string; body: string }[]
  manualOnly?: string | null
}

/** The hash of all a press approves as drawn: what would run, what is shown behind it, and the counts that will judge it. */
export const offerDigest = async (root: string, checks: readonly ProofCheck[], scripts: readonly ShownScript[], bound: Bound = {}): Promise<string> =>
  hashed([
    'offer', await digestOf(root, checks), checks.map(c => [c.count?.minPassed ?? null, c.count?.maxSkipped ?? null]), scripts.map(s => [s.checkId, s.name, s.body]),
    (bound.watched ?? []).map(([path, hash]) => [path, hash]), (bound.files ?? []).map(f => [f.path, f.body]), bound.manualOnly ?? null,
  ])

export type Press = Bound & {
  session: string
  root: string
  checks: readonly ProofCheck[]
  /** Read again at the press, to be held against what was drawn. */
  scripts: readonly ShownScript[]
  drawnDigest: string
  auto?: boolean
  at: number
}

/**
 * An allowance from a person's press, or why there is none: only for what was drawn when they pressed,
 * and only for this session. Automatic unless they chose manual, or what runs cannot be resolved.
 */
export async function grantFrom(p: Press): Promise<{ grant: ProofGrant } | { refused: string }> {
  if (!p.session) return { refused: 'the session is not known' }
  const problem = setupProblem(p.root, p.checks)
  if (problem) return { refused: problem }
  if ((await offerDigest(p.root, p.checks, p.scripts, p)) !== p.drawnDigest) return { refused: 'the checks changed since they were shown' }
  const checks = p.checks.map(c => ({ ...c, argv: [...c.argv], ...(c.count ? { count: { ...c.count } } : {}) }))
  return { grant: { session: p.session, root: p.root, checks, digest: await digestOf(p.root, checks), auto: p.auto !== false && !p.manualOnly, at: p.at } }
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
    if (typeof v.id !== 'string' || (v.description !== undefined && typeof v.description !== 'string')) continue
    const count = typeof v.count === 'object' && v.count !== null ? { parser: v.count.parser, minPassed: Number.isSafeInteger(v.count.minPassed) ? v.count.minPassed : null, maxSkipped: Number.isSafeInteger(v.count.maxSkipped) ? v.count.maxSkipped : 0 } : null
    const check: ProofCheck = { id: String(v.id), kind: v.kind, description: redact(String(v.description ?? '')).slice(0, 80), argv: Array.isArray(v.argv) ? [...v.argv] : [], dir: v.dir ?? '', timeoutS: v.timeoutS, required: v.required, ...(count ? { count } : {}) }
    if (checkProblem(check) === null) out.push(check)
  }
  return out
}
