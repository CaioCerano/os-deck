// What could be checked, and what a person is shown before allowing it. Read only: this runs before
// anyone allowed anything, so it starts no process, git included, and follows no link. A check is
// suggested only where a file evidences it; what cannot be shown as it would run is a problem.
import type { EngineInterface } from 'claude-code'

import type { ProofCheck, ProofCountRule, ProofKind } from '../../types'
import { shorten } from '../core'
import { redact } from '../redact'
import { checkProblem, offerDigest, setupProblem } from './grant'
import type { Draft } from './model'
import { isLocalPath } from './revision'
import { unshowable } from './showable'

const MAX_MANIFEST = 256 * 1024
const MAX_TYPED = 1000
const MAX_BODY = 1000
const MAX_SCRIPTS = 24
/** How many scripts deep one may run another and still be shown. */
const MAX_DEPTH = 4
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

/**
 * What a press is bound to: what would run, the script bodies shown, and the accepted counts.
 */
const digestOfDraft = (d: Draft): Promise<string> => offerDigest(d.root, d.checks, d.scripts)

// ---------------------------------------------------------------- what can be shown

// By number: typed in, they could not be seen here either. A blank braille cell, and what an undecodable byte becomes.
const LOOKS_BLANK = [0x2800, 0xfffd].map(code => String.fromCharCode(code))
const BOM = String.fromCharCode(0xfeff)

/** Whether a text holds what does not show as itself: the plain space is the only blank that does. */
const hidesSomething = (text: string) =>
  /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Z}\p{Default_Ignorable_Code_Point}]/u.test(text.replaceAll(' ', '')) || LOOKS_BLANK.some(ch => text.includes(ch))

/** Why a text would not be shown as what runs; null where it would. */
const showProblem = (text: string): string | null =>
  text.length > MAX_BODY
    ? 'is too long to show whole'
    : hidesSomething(text)
      ? 'holds a character that does not show'
      : redact(text) !== text
        ? 'holds what looks like a secret'
        : null

// ---------------------------------------------------------------- reading

type Entry = { name: string; kind: string; size: number; isLink: boolean }

/** The entries of a folder inside the root, every step to it a folder and no link; null where one is not. */
async function listInside($: EngineInterface, root: string, dir: string): Promise<readonly Entry[] | null> {
  try {
    let at = root
    let entries: readonly Entry[] = await $.fs.list(at)
    for (const part of dir ? dir.split('/') : []) {
      const entry = entries.find(x => x.name === part)
      if (!entry || entry.isLink || entry.kind !== 'dir') return null
      at = `${at}/${part}`
      entries = await $.fs.list(at)
    }
    return entries
  } catch {
    return null
  }
}

const hasFile = (entries: readonly Entry[] | null, name: string) => entries?.some(x => x.name === name && x.kind === 'file' && !x.isLink) === true

/** The scripts of a folder's package.json; null where there is none that can be read whole. */
async function readScripts($: EngineInterface, root: string, dir: string, entries: readonly Entry[] | null): Promise<Map<string, unknown> | null> {
  const file = entries?.find(x => x.name === 'package.json')
  if (!file || file.isLink || file.kind !== 'file' || file.size > MAX_MANIFEST) return null
  try {
    // Bounded again: it may have grown since it was listed.
    const read = await $.fs.read(dir ? `${root}/${dir}/package.json` : `${root}/package.json`, { length: MAX_MANIFEST + 1 })
    const text = String(read)
    if (new TextEncoder().encode(text).length > MAX_MANIFEST) return null
    const manifest = JSON.parse(text.startsWith(BOM) ? text.slice(1) : text) as { scripts?: unknown } | null
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return null
    const { scripts } = manifest
    // A Map: a script may be named like what every object has.
    return new Map(typeof scripts === 'object' && scripts !== null && !Array.isArray(scripts) ? Object.entries(scripts) : [])
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- the package scripts behind a command

const baseName = (word: string) => word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1).toLowerCase()
/** A command line's parts: split where a shell would start another command. For finding only, never to run or show. */
const partsOf = (line: string) =>
  line.split(/[;&|()`\n]/).map(part => part.replace(/["']/g, '').split(/\s+/).filter(Boolean))

/** The runner a word names, whichever path or extension it was named by. */
const toolOf = (word: string): string | null =>
  /npm_execpath/i.test(word)
    ? 'npm'
    : (/^(npm|pnpm|yarn|bun|node|run-s|run-p|npm-run-all2?)(?:-cli)?(?:@[\w.^~-]+)?(?:\.(?:cmd|exe|bat|ps1|c?js))?$/.exec(baseName(word))?.[1] ?? null)

const HARMLESS_FLAGS: readonly string[] = ['-s', '--silent', '-q', '--quiet', '--if-present']
const RUN_WORDS: Readonly<Record<string, readonly string[]>> = { npm: ['run', 'run-script', 'rum', 'urn'], pnpm: ['run', 'run-script'], yarn: ['run'], bun: ['run'] }
const SHORT_RUNS: Readonly<Record<string, readonly string[]>> = { npm: ['test', 't', 'tst', 'start', 'stop'], pnpm: ['test', 't', 'start'], yarn: ['test'], bun: [] }
const NO_SCRIPT: Readonly<Record<string, readonly string[]>> = { npm: ['exec', 'x', 'ls', 'audit'], pnpm: ['exec', 'dlx'], yarn: ['exec', 'dlx', 'node'], bun: ['test', 'x', 'build'] }
// These run scripts of other names, or of other folders.
const UNSHOWABLE = /^(?:install|i|ci|add|update|up|upgrade|remove|rm|link|publish|pack|rebuild|rb|version|restart|it|workspaces?|recursive|multi|m)$/

/** The scripts one use of a runner starts: none, their names, or null where that cannot be told. */
const startedBy = (tool: string, args: readonly string[], scripts: ReadonlyMap<string, unknown> | null): string[] | null => {
  if (tool === 'node') {
    for (let i = 0; args[i]?.startsWith('-'); i++) {
      const flag = args[i] as string
      if (flag.startsWith('--run=')) return [flag.slice(6)]
      if (flag === '--run') return args[i + 1] ? [args[i + 1] as string] : null
    }
    return []
  }
  if (tool.startsWith('run-') || tool.startsWith('npm-run-all')) {
    const names = args.filter(a => !a.startsWith('-'))
    return names.some(name => name.includes('*')) ? null : names
  }
  let at = 0
  const skipFlags = () => {
    while (HARMLESS_FLAGS.includes(args[at] ?? '')) at += 1
  }
  skipFlags()
  let name = args[at]
  if (name === undefined || name === '--version' || name === '-v') return []
  const isRun = RUN_WORDS[tool]?.includes(name) === true
  const isShort = !isRun && SHORT_RUNS[tool]?.includes(name) === true
  if (isRun) {
    at += 1
    skipFlags()
    name = args[at]
  } else if (isShort && (name === 't' || name === 'tst')) name = 'test'
  // A flag before the name may choose another folder, and yarn takes that one after it too.
  if (!name || name.startsWith('-') || (tool === 'yarn' && args.some(a => a.startsWith('--cwd')))) return null

  if (tool === 'bun' && !scripts?.has(name) && /\.[cm]?[jt]sx?$/.test(name)) return []
  if (!isRun && !isShort) {
    if (NO_SCRIPT[tool]?.includes(name)) return []
    if (tool === 'npm' || UNSHOWABLE.test(name) || !scripts) return null
    // The others take a script by its bare name, and otherwise a program.
    return scripts.has(name) ? [name] : []
  }
  // npm reads flags after the name as its own, up to `--`.
  const after = args.slice(at + 1)
  const own = after.includes('--') ? after.slice(0, after.indexOf('--')) : after
  if (tool === 'npm' && own.some(a => a.startsWith('-') && !HARMLESS_FLAGS.includes(a))) return null
  return [name]
}

/** Another folder's manifest, or npm told to use one. */
const MOVES = /^(?:cd(?:[.][.].*)?|chdir|pushd|npm_config_(?:prefix|local_prefix|workspaces?)=.*)$/i

/** The scripts a command line starts in its own folder; null where what it starts cannot be told. */
const startedIn = (line: string, scripts: ReadonlyMap<string, unknown> | null): string[] | null => {
  const names: string[] = []
  let hasMoved = false
  for (const words of partsOf(line)) {
    for (let i = 0; i < words.length; i++) {
      const word = words[i] as string
      if (MOVES.test(word)) hasMoved = true
      const tool = toolOf(word)
      if (!tool) continue
      const started = startedBy(tool, words.slice(i + 1), scripts)
      // After a change of folder the name is another manifest's.
      if (!started || (hasMoved && started.length > 0)) return null
      names.push(...started)
    }
  }
  return names
}

type Shown = { scripts: Draft['scripts']; problem: string | null }

/** Every script body behind a check, as written, with the hooks around each. */
const scriptsBehind = (check: ProofCheck, scripts: ReadonlyMap<string, unknown> | null): Shown => {
  const shown: Draft['scripts'] = []
  const is = (problem: string | null): Shown => ({ scripts: shown, problem })
  const first = startedIn(check.argv.join(' '), scripts)
  if (!first) return is('it runs package scripts in a way that cannot be shown')
  if (first.length === 0) return is(null)
  if (!scripts) return is('the package.json of its folder cannot be read')
  const queue = first.map(name => ({ name, depth: 0 }))
  const seen = new Set<string>()
  // Breadth first, so each script is met at its least depth.
  for (const { name, depth } of queue) {
    if (seen.has(name)) continue
    seen.add(name)
    if (depth > MAX_DEPTH) return is('its scripts run one another too deep to show')
    if (showProblem(name)) return is('a script it runs has a name that cannot be shown')
    if (!scripts.has(name)) return is(`there is no script "${name}" to show`)
    for (const part of [`pre${name}`, name, `post${name}`]) {
      if (!scripts.has(part)) continue
      const body = scripts.get(part)
      if (typeof body !== 'string') return is(`the script "${part}" is not text`)
      const bad = showProblem(body)
      if (bad) return is(`the script "${part}" ${bad}`)
      if (shown.some(s => s.name === part)) continue
      if (shown.length >= MAX_SCRIPTS) return is('it runs more scripts than can be shown')
      shown.push({ checkId: check.id, name: part, body })
      const next = startedIn(body, scripts)
      if (!next) return is(`the script "${part}" runs others in a way that cannot be shown`)
      for (const started of next) queue.push({ name: started, depth: depth + 1 })
    }
  }
  return is(null)
}

// ---------------------------------------------------------------- checks

/** How a command's counts are read, where the command itself says so. */
const parserOf = ([exe = '', first = '', second = '']: readonly string[]): ProofCountRule['parser'] | null => {
  const program = baseName(exe).replace(/\.(?:exe|com|cmd|bat)$/, '')
  if ((program === 'bun' && first === 'test') || (program === 'claude' && first === 'plugin' && second === 'test')) return 'bun'
  return (program === 'bash' || program === 'sh') && baseName(first) === 'run_all.sh' ? 'pass-fail-lines' : null
}

type Found = { id?: string; kind: ProofKind; argv: string[]; description: string; dir?: string; parser?: ProofCountRule['parser'] | null }

const checkOf = ({ kind, id = kind, argv, description, dir = '', parser = parserOf(argv) }: Found): ProofCheck => ({
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

const managerOf = (entries: readonly Entry[]): string => {
  if (hasFile(entries, 'package-lock.json') || hasFile(entries, 'npm-shrinkwrap.json')) return 'npm'
  if (hasFile(entries, 'pnpm-lock.yaml')) return 'pnpm'
  if (hasFile(entries, 'yarn.lock')) return 'yarn'
  return hasFile(entries, 'bun.lock') || hasFile(entries, 'bun.lockb') ? 'bun' : 'npm'
}

const scriptChecks = (manager: string, scripts: ReadonlyMap<string, unknown>): Found[] =>
  SCRIPT_NAMES.flatMap(([kind, names]): Found[] => {
    const name = names.find(n => typeof scripts.get(n) === 'string' && scripts.get(n) !== '')
    if (!name) return []
    const body = scripts.get(name) as string
    // What npm init writes is no test.
    if (kind === 'test' && body.includes('Error: no test specified')) return []
    const parser = body.length > MAX_BODY ? null : (partsOf(body).map(parserOf).find(p => p !== null) ?? null)
    return [{ kind, argv: [manager, 'run', name], description: `${name} script`, parser }]
  })

/** A Claude Code plugin with tests in `dir`. */
async function pluginCheck($: EngineInterface, root: string, dir: string, entries: readonly Entry[] | null): Promise<Found[]> {
  const holds = (name: string) => entries?.some(x => x.name === name && x.kind === 'dir' && !x.isLink) === true
  if (!holds('.claude-plugin') || !holds('tests')) return []
  const inDir = (name: string) => (dir ? `${dir}/${name}` : name)
  if (!hasFile(await listInside($, root, inDir('.claude-plugin')), 'plugin.json')) return []
  const tests = await listInside($, root, inDir('tests'))
  if (!tests?.some(x => x.kind === 'file' && !x.isLink && /\.test\.tsx?$/.test(x.name))) return []
  return [{ kind: 'test', argv: ['claude', 'plugin', 'test', dir || '.'], description: dir ? `plugin tests: ${dir}` : 'plugin tests' }]
}

/** Candidate checks from the files at the root. Never throws. */
export async function detectChecks($: EngineInterface, root: string): Promise<ProofCheck[]> {
  try {
    if (!isLocalPath(root)) return []
    const entries = await listInside($, root, '')
    if (!entries) return []
    const scripts = await readScripts($, root, '', entries)
    const found: Found[] = scripts ? scriptChecks(managerOf(entries), scripts) : []
    found.push(...(await pluginCheck($, root, '', entries)))
    const mods = (await listInside($, root, 'mods')) ?? []
    const folders = mods.filter(x => x.kind === 'dir' && !x.isLink).map(x => x.name).sort()
    for (const name of folders.slice(0, MAX_MODS)) {
      const dir = `mods/${name}`
      found.push(...(await pluginCheck($, root, dir, await listInside($, root, dir))))
    }
    if (hasFile(await listInside($, root, 'tests'), 'run_all.sh')) found.push({ kind: 'test', argv: ['bash', 'tests/run_all.sh'], description: 'tests/run_all.sh' })

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

/** What is put before a person: the checks, what is behind them, and the hash their press is bound to. Never throws. */
export async function draftFor($: EngineInterface, root: string, checks: readonly ProofCheck[], source: Draft['source']): Promise<Draft> {
  // Copied first: what is hashed is what is returned.
  const draft: Draft = { root, checks: [], digest: '', scripts: [], problem: null, source }
  try {
    draft.checks = checks.map(c => ({ ...c, argv: [...c.argv], ...(c.count ? { count: { ...c.count } } : {}) }))
    let problem = setupProblem(root, draft.checks)
    for (const check of problem ? [] : draft.checks) {
      const bad = [check.dir, ...check.argv].map(showProblem).find(p => p !== null)
      if (bad) {
        problem = `${check.id}: its command or folder ${bad}`
        break
      }
      const entries = await listInside($, root, check.dir)
      if (!entries) {
        problem = `${check.id}: its folder is not there, cannot be read, or is a link`
        break
      }
      const behind = scriptsBehind(check, await readScripts($, root, check.dir, entries))
      draft.scripts.push(...behind.scripts)
      if (behind.problem) problem ??= `${check.id}: ${behind.problem}`
    }
    problem ??= unshowable(draft)
    // It may quote a name from the repository or the store.
    draft.problem = problem === null ? null : shorten(redact(problem), 200)
    // Last: it covers the bodies shown.
    draft.digest = await digestOfDraft(draft)
  } catch {
    draft.digest = ''
    draft.problem = 'it could not be read'
  }
  return draft
}
