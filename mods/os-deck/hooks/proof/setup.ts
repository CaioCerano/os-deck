// What could be checked, and what a person is shown before allowing it. Read only: this runs before
// anyone allowed anything, so it starts no process, git included, and follows no link. A check is
// suggested only where a file evidences it. What a command starts is understood or it is refused:
// nothing is shown in part, and all that is shown is parsed from the bytes that are watched.
import type { EngineInterface } from 'claude-code'

import type { ProofCheck, ProofCountRule, ProofKind } from '../../types'
import { shorten } from '../core'
import { redact } from '../redact'
import { checkProblem, offerDigest, setupProblem } from './grant'
import type { Draft } from './model'
import { commandsIn, readCommand } from './reader/command'
import { Unshown } from './reader/reading'
import type { Found, Reading } from './reader/reading'
import { MAX_BODY, hidesSomething, scriptsIn, showProblem } from './reader/text'
import { isLocalPath } from './revision'
import { unshowable } from './showable'
import { joined, openDisk, readFrom } from './watched'
import type { Disk, Entry } from './watched'

const MAX_TYPED = 1000
const MAX_WATCHED = 1500
/** How many folders of `mods/` are looked into. */
const MAX_MODS = 64
const LONG_S = 1800

const TIMEOUT_S: Readonly<Record<ProofKind, number>> = { test: 600, typecheck: 300, lint: 300, build: 900 }
const SCRIPT_NAMES: readonly [ProofKind, readonly string[]][] = [
  ['test', ['test']],
  ['typecheck', ['typecheck', 'type-check', 'check-types']],
  ['lint', ['lint']],
  ['build', ['build']],
]

// ---------------------------------------------------------------- checks

/** How a command's counts are read, where the command itself says so. */
const parserOf = ([exe = '', first = '', second = '']: readonly string[]): ProofCountRule['parser'] | null => {
  if ((exe === 'bun' && first === 'test') || (exe === 'claude' && first === 'plugin' && second === 'test')) return 'bun'
  return (exe === 'bash' || exe === 'sh') && /(?:^|\/)run_all\.sh$/.test(first) ? 'pass-fail-lines' : null
}

type Candidate = { id?: string; kind: ProofKind; argv: string[]; description: string; dir?: string; parser?: ProofCountRule['parser'] | null }

const checkOf = ({ kind, id = kind, argv, description, dir = '', parser = parserOf(argv) }: Candidate): ProofCheck => ({
  id,
  kind,
  description: shorten(redact(description), 80),
  argv,
  dir,
  timeoutS: parser === 'pass-fail-lines' ? LONG_S : TIMEOUT_S[kind],
  required: true,
  // No baseline: only a press accepts one.
  ...(kind === 'test' && parser ? { count: { parser, minPassed: null, maxSkipped: 0 } } : {}),
})

const hasFile = (entries: readonly Entry[] | null, name: string) => entries?.some(x => x.name === name && x.kind === 'file' && !x.isLink) === true

// Always npm run, whoever installed: it starts the body shown, where the others have rules of their own.
const scriptChecks = (scripts: ReadonlyMap<string, unknown>): Candidate[] =>
  SCRIPT_NAMES.flatMap(([kind, names]): Candidate[] => {
    const name = names.find(n => typeof scripts.get(n) === 'string' && scripts.get(n) !== '')
    if (!name) return []
    const body = scripts.get(name) as string
    // What npm init writes is no test.
    if (kind === 'test' && body.includes('Error: no test specified')) return []
    const commands = body.length > MAX_BODY ? [] : (commandsIn(body) ?? [])
    const parser = commands.map(parserOf).find(p => p !== null) ?? null
    return [{ kind, argv: ['npm', 'run', name], description: `${name} script`, parser }]
  })

/** A Claude Code plugin with tests in `dir`. */
async function pluginCheck(disk: Disk, dir: string): Promise<Candidate[]> {
  const entries = await disk.list(dir)
  const holds = (name: string) => entries?.some(x => x.name === name && x.kind === 'dir' && !x.isLink) === true
  if (!holds('.claude-plugin') || !holds('tests')) return []
  if (!hasFile(await disk.list(joined(dir, '.claude-plugin')), 'plugin.json')) return []
  const tests = await disk.list(joined(dir, 'tests'))
  if (!tests?.some(x => x.kind === 'file' && !x.isLink && /\.test\.tsx?$/.test(x.name))) return []
  return [{ kind: 'test', argv: ['claude', 'plugin', 'test', dir || '.'], description: dir ? `plugin tests: ${dir}` : 'plugin tests' }]
}

/** Candidate checks from the files at the root. Never throws. */
export async function detectChecks($: EngineInterface, root: string): Promise<ProofCheck[]> {
  try {
    if (!isLocalPath(root)) return []
    const disk = openDisk($, root)
    const entries = await disk.list('')
    if (!entries) return []
    const manifest = await disk.file('package.json')
    const scripts = manifest.kind === 'file' ? scriptsIn(manifest.bytes) : null
    const found: Candidate[] = scripts ? scriptChecks(scripts) : []
    found.push(...(await pluginCheck(disk, '')))
    const mods = (await disk.list('mods')) ?? []
    const folders = mods.filter(x => x.kind === 'dir' && !x.isLink).map(x => x.name).sort()
    for (const name of folders.slice(0, MAX_MODS)) found.push(...(await pluginCheck(disk, `mods/${name}`)))
    if (hasFile(await disk.list('tests'), 'run_all.sh')) found.push({ kind: 'test', argv: ['bash', 'tests/run_all.sh'], description: 'tests/run_all.sh' })

    const out: ProofCheck[] = []
    for (const one of found) {
      // One that could never be allowed is not a candidate.
      if (one.argv.some(hidesSomething) || checkProblem(checkOf(one))) continue
      const same = out.filter(c => c.kind === one.kind).length
      out.push(checkOf({ ...one, id: same ? `${one.kind}-${same + 1}` : one.kind }))
    }
    return out
  } catch {
    return []
  }
}

/**
 * What detection puts before a person: the checks that could be allowed and could verify, and why each
 * other was left out, so one of those does not block the rest. With none such, all of them, for setup
 * to say why.
 */
export async function detectOffer($: EngineInterface, root: string): Promise<{ checks: ProofCheck[]; leftOut: string[] }> {
  const found = await detectChecks($, root)
  const checks: ProofCheck[] = []
  const leftOut: string[] = []
  for (const check of found) {
    if (check.kind === 'test' && !check.count) {
      leftOut.push(`${check.id}: no way to count its tests`)
      continue
    }
    const { problem } = await draftFor($, root, [check], 'detected')
    if (problem) leftOut.push(problem)
    else checks.push(check)
  }
  return checks.length > 0 ? { checks, leftOut } : { checks: found, leftOut: [] }
}

const USAGE = 'expected: <test|typecheck|lint|build> [--dir <folder>] -- <command>'

/** The words typed: double quotes group, and nothing else means anything. */
const wordsTyped = (text: string): string[] | { error: string } => {
  // A backslash does not escape, so this would end up as other words than were meant.
  if (text.includes('\\"')) return { error: 'a backslash does not escape a quote here' }
  const words: string[] = []
  let word: string | null = null
  let isQuoted = false
  for (const ch of text) {
    if (!isQuoted && (ch === ' ' || ch === '\t')) {
      if (word !== null) words.push(word)
      word = null
      continue
    }
    if (ch === "'" && word === null && !isQuoted) return { error: 'single quotes do not group words here: use double quotes' }
    word ??= ''
    if (ch === '"') isQuoted = !isQuoted
    else word += ch
  }
  if (isQuoted) return { error: 'a double quote is not closed' }
  if (word !== null) words.push(word)
  return words
}

/** `<kind> [--dir <folder>] -- <argv>` as typed, or why it was not understood. */
export const parseTypedCheck = (args: string): { check: ProofCheck } | { error: string } => {
  if (args.length > MAX_TYPED) return { error: 'too long to show whole' }
  const words = wordsTyped(args)
  if (!Array.isArray(words)) return words
  const kind = SCRIPT_NAMES.find(([k]) => k === words[0])?.[0]
  if (!kind) return { error: USAGE }
  const hasDir = words[1] === '--dir'
  const dir = hasDir ? (words[2] ?? '') : ''
  const split = hasDir ? 3 : 1
  const argv = words.slice(split + 1)
  if (words[split] !== '--' || argv.length === 0 || (hasDir && (dir === '' || dir === '--'))) return { error: USAGE }
  if (argv.includes('')) return { error: 'an empty argument' }
  if ([dir, ...argv].some(hidesSomething)) return { error: 'a character that does not show' }
  if (redact(dir) !== dir) return { error: 'what looks like a secret in the folder' }
  const check = checkOf({ kind, argv, dir, description: argv.join(' ') })
  const problem = checkProblem(check)
  return problem ? { error: problem } : { check }
}

/**
 * What is put before a person, from one reading of the disk: the checks, the bodies and config behind
 * them, the bytes of what they run, and the hash of all of it that a press is bound to. Never throws.
 */
export async function draftFor($: EngineInterface, root: string, checks: readonly ProofCheck[], source: Draft['source']): Promise<Draft> {
  // Copied first: what is hashed is what is returned.
  const draft: Draft = { root, checks: [], digest: '', scripts: [], watched: [], files: [], manualOnly: null, problem: null, source }
  try {
    draft.checks = checks.map(c => ({ ...c, argv: [...c.argv], ...(c.count ? { count: { ...c.count } } : {}) }))
    let problem = setupProblem(root, draft.checks)
    const disk = openDisk($, root)
    const found: Found = { watch: new Map(), files: new Map() }
    for (const check of problem ? [] : draft.checks) {
      const bad = [check.dir, ...check.argv].map(showProblem).find(p => p !== null)
      if (bad) {
        problem = `${check.id}: its command or folder ${bad}`
        break
      }
      if (!(await disk.list(check.dir))) {
        problem = `${check.id}: its folder is not there, cannot be read, or is a link`
        break
      }
      const r: Reading = { disk, root, check, where: 'it', depth: 0, inScript: false, found, own: { scripts: [], seen: new Set(), manual: null } }
      try {
        await readCommand(r, check.argv)
      } catch (err) {
        if (!(err instanceof Unshown)) throw err
        problem ??= `${check.id}: ${err.message}`
      }
      draft.scripts.push(...r.own.scripts)
      if (r.own.manual) draft.manualOnly ??= shorten(redact(`${check.id}: ${r.own.manual}`), 200)
    }
    draft.files = [...found.files.values()]
    const paths = [...found.watch.values()].sort()
    if (paths.length > MAX_WATCHED) problem ??= 'it runs more files than can be watched'
    else {
      const read = await readFrom(disk, paths)
      draft.watched = read.watched
      const first = read.problems[0]
      if (first) problem ??= `${first[0]} cannot be watched: ${first[1]}`
    }
    problem ??= unshowable(draft)
    // It may quote a name from the repository or the store.
    draft.problem = problem === null ? null : shorten(redact(problem), 200)
    // Last: it covers all that was read. With a problem there is nothing to press on.
    if (problem === null) draft.digest = await offerDigest(root, draft.checks, draft.scripts, draft)
  } catch {
    draft.digest = ''
    draft.problem = 'it could not be read'
  }
  return draft
}
