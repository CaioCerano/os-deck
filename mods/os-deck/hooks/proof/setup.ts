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
import { isWindowsOddName } from './names'
import { isLocalPath } from './revision'
import { hasSecret, unshowable } from './showable'
import { joined, keyOf, openDisk, pathFrom, readFrom } from './watched'
import type { Disk, Entry } from './watched'

const MAX_MANIFEST = 256 * 1024
const MAX_TYPED = 1000
const MAX_BODY = 1000
const MAX_CONFIG = 8000
const MAX_SCRIPTS = 24
/** How many scripts deep one may run another and still be shown. */
const MAX_DEPTH = 4
/** Commands followed for one check, so scripts that call each other many times end. */
const MAX_COMMANDS = 400
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

/** The same for a file shown whole, where lines and tabs are its form. */
const fileProblem = (body: string): string | null =>
  body.length > MAX_CONFIG
    ? 'is too long to show whole'
    : hidesSomething(body.replace(/\r\n|[\n\t]/g, ' '))
      ? 'holds a character that does not show'
      : hasSecret(body)
        ? 'holds what looks like a secret'
        : null

const textOf = (bytes: Uint8Array) => {
  const text = new TextDecoder().decode(bytes)
  return text.startsWith(BOM) ? text.slice(1) : text
}

/** An object a file holds as JSON; null where it holds none. */
const objectIn = (bytes: Uint8Array): Record<string, unknown> | null => {
  if (bytes.length > MAX_MANIFEST) return null
  try {
    const value: unknown = JSON.parse(textOf(bytes))
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The scripts of a package.json's bytes, a Map: a script may be named like what every object has. */
const scriptsIn = (bytes: Uint8Array): Map<string, unknown> | null => {
  const manifest = objectIn(bytes)
  if (!manifest) return null
  const { scripts } = manifest
  return new Map(typeof scripts === 'object' && scripts !== null && !Array.isArray(scripts) ? Object.entries(scripts) : [])
}

// ---------------------------------------------------------------- a line, as both shells read it

/** `isPlain`: every shell reads it as this one word, so it may name what runs. */
type Word = { text: string; isPlain: boolean; isQuoted: boolean }
type Line = { commands: Word[][]; joins: string[] }

const literal = (text: string): Word => ({ text, isPlain: true, isQuoted: false })

/**
 * A script's line split as sh and cmd both would, or why not: what one shell reads otherwise than the
 * other, or expands, is not guessed at.
 */
const readLine = (line: string): Line | { why: string } => {
  if (/%[^%]+%/.test(line)) return { why: 'it expands a variable' }
  const out: Line = { commands: [], joins: [] }
  let words: Word[] = []
  let text = ''
  let isWord = false
  let isQuoted = false
  let isPlain = true
  let isGlob = false
  let dropsNext = false
  const endWord = (): string | null => {
    if (!isWord) return null
    if (isGlob && !/^[\w./]/.test(text)) return 'it expands names that could be anything'
    if (dropsNext) dropsNext = false
    else words.push({ text, isPlain: isPlain && !isGlob, isQuoted })
    text = ''
    isWord = isQuoted = isGlob = false
    isPlain = true
    return null
  }
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string
    if (ch === '"' || ch === "'") {
      const end = line.indexOf(ch, i + 1)
      if (end < 0) return { why: 'a quote in it is not closed' }
      const inner = line.slice(i + 1, end)
      if (ch === '"') {
        if (/[\\^]/.test(inner)) return { why: 'it uses a shell escape' }
        if (/[$`]/.test(inner)) return { why: 'it expands a variable or a command' }
      } else {
        // To cmd a single quote is a letter like any other.
        if (/[&|<>()^"]/.test(inner)) return { why: 'cmd reads its quotes otherwise' }
        isPlain = false
      }
      text += inner
      isWord = isQuoted = true
      i = end
      continue
    }
    if (ch === ' ') {
      const why = endWord()
      if (why) return { why }
    } else if (ch === '\\' || ch === '^') return { why: 'it uses a shell escape' }
    else if (ch === '$' || ch === '`') return { why: 'it expands a variable or a command' }
    else if (ch === '(' || ch === ')') return { why: 'it groups commands' }
    else if (ch === '<') return { why: 'it feeds a command its input' }
    else if (ch === '>') {
      // A bare number before it names a pipe.
      if (isWord && !isQuoted && /^\d$/.test(text)) {
        text = ''
        isWord = false
      }
      const why = endWord()
      if (why || dropsNext) return { why: why ?? 'it sends output where that cannot be told' }
      if (line[i + 1] === '>') i += 1
      const pipe = /^&\d/.exec(line.slice(i + 1))
      if (pipe) i += pipe[0].length
      else dropsNext = true
    } else if (ch === '&' || ch === '|' || ch === ';') {
      const why = endWord()
      if (why || dropsNext) return { why: why ?? 'it sends output where that cannot be told' }
      const isDouble = ch !== ';' && line[i + 1] === ch
      if (isDouble) i += 1
      if (words.length === 0) return { why: 'a command in it is empty' }
      out.commands.push(words)
      out.joins.push(isDouble ? ch + ch : ch)
      words = []
    } else {
      // A comment to sh, and to cmd a command like the rest.
      if (ch === '#' && !isWord) return { why: 'it holds a comment, which cmd runs' }
      if (ch === '~' && (!isWord || /[=:]$/.test(text))) return { why: 'it expands a home folder' }
      if ('*?[]{}'.includes(ch)) isGlob = true
      text += ch
      isWord = true
    }
  }
  const why = endWord()
  if (why || dropsNext) return { why: why ?? 'it sends output where that cannot be told' }
  if (words.length === 0 && out.commands.length > 0) return { why: 'a command in it is empty' }
  if (words.length > 0) out.commands.push(words)
  return out
}

// ---------------------------------------------------------------- what is known

/** Shown whole for the runner that reads them. */
const CONFIG: Readonly<Record<string, readonly string[]>> = {
  npm: ['.npmrc'],
  pnpm: ['.npmrc', 'pnpm-workspace.yaml'],
  yarn: ['.npmrc', '.yarnrc', '.yarnrc.yml'],
  bun: ['bunfig.toml'],
  claude: ['bunfig.toml'],
  make: ['GNUmakefile', 'Makefile'],
  just: ['justfile', '.justfile'],
  composer: ['composer.json'],
  deno: ['deno.json', 'deno.jsonc'],
}
// Each is watched in a folder a check runs in, and in those above it up to the root: all that can be shown included.
const MANIFESTS = [...new Set(['package.json', 'tsconfig.json', ...Object.values(CONFIG).flat()])]
/** Loaded by the runner itself, where there is one. */
const LOADED: Readonly<Record<string, readonly string[]>> = { yarn: ['.pnp.cjs', '.pnp.loader.mjs'], pnpm: ['.pnpmfile.cjs'] }
/** Read for what they set, and never shown: their values are the person's secrets. */
const ENV_FILES: Readonly<Record<string, readonly string[]>> = {
  bun: ['.env', '.env.local', '.env.test', '.env.test.local', '.env.development', '.env.development.local', '.env.production', '.env.production.local'],
  yarn: ['.env.yarn', '.corepack.env'],
  pnpm: ['.corepack.env'],
}
// With one of these set, the bodies shown are not what runs, or not how it runs.
const NPMRC_REDIRECTS: readonly string[] = [
  'workspace', 'workspaces', 'include-workspace-root', 'prefix', 'local-prefix', 'dir', 'recursive', 'filter', 'script-shell', 'shell', 'shell-emulator',
  'w', 'ws', 'iwr', 'c', 'g', 'global', 'location', 'workspace-root', 'call', 'package', 'userconfig', 'globalconfig', 'npm-path', 'scripts-prepend-node-path', 'verify-deps-before-run', 'onload-script', 'modules-dir',
]
const PNPM_REDIRECTS = /\b(?:scriptShell|script-shell|node-options|nodeOptions|shellEmulator|npmPath|verifyDepsBeforeRun|modulesDir)\b/
const YARN_REDIRECTS = /(?:^|[\s{,."'-])(?:cwd|script-shell|modules-folder|injectEnvironmentFiles)\b/i
const YARN_PATH = /\byarn-?path["']?[\s:]+(?:"([^"]+)"|'([^']+)'|([^\s"',{}*&|>!]+))/i
const CODE_IN_TEXT = /[\w.@/-]{1,200}\.[cm]?js\b/g

const RUN_WORDS: Readonly<Record<string, readonly string[]>> = { npm: ['run', 'run-script', 'rum', 'urn'], pnpm: ['run', 'run-script'], yarn: ['run'], bun: ['run'] }
const SHORT_RUNS: Readonly<Record<string, readonly string[]>> = { npm: ['test', 't', 'tst', 'start', 'stop'], pnpm: ['test', 't', 'start'], yarn: ['test'], bun: [] }
/** A runner's words that start another program, named after them. */
const EXEC_WORDS: Readonly<Record<string, readonly string[]>> = { npm: ['exec', 'x'], pnpm: ['exec', 'dlx'], yarn: ['exec', 'dlx'], bun: ['x'] }
// A runner's own commands, some of which run scripts of other names or folders.
const RUNNER_OWN = /^(?:install|i|ci|c|add|a|update|up|upgrade|remove|rm|link|publish|pack|rebuild|rb|version|restart|it|workspaces?|recursive|multi|m|exec|create|init|deploy|import|prune|dedupe|setup|pm|patch|prepare|pnp|set|config|env|install-test|clean-install|ic|fetch|approve-builds|self-update)$/
const RUNNER_FLAGS: readonly string[] = ['-s', '--silent', '-q', '--quiet', '--if-present']
const NPX_FLAGS: readonly string[] = ['-y', '--yes', '--no', '--no-install', '--silent', '-q', '--quiet', '--bun']
const RUN_ALL_FLAGS = /^(?:-[clnrsp]|--(?:print-label|print-name|continue-on-error|race|silent|aggregate-output|serial|sequential|parallel))$/

/** Words that are a package runner, by any of its names. */
const RUNNER = /^(?:npm|npx|pnpm|pnpx|yarn|yarnpkg|yarn-berry|bun|bunx|bun-debug|bun-profile|corepack|run-s|run-p|run-z|npm-run-all2?|concurrently|ni|nr|nun|nlx)(?:-cli)?(?:\.(?:[cm]?js|ps1))?$/
/** Where a runner's own code lives. */
const RUNNER_FILE = /(?:^|[\\/])node_modules[\\/](?:npm|pnpm|yarn|corepack|npm-run-all2?|concurrently|turbo|nx|lerna|wireit)(?:[\\/]|$)/i
// They start commands this does not read.
const RUNS_OTHERS: readonly string[] = [
  'cd', 'chdir', 'pushd', 'popd', 'call', 'start', 'cmd', 'powershell', 'pwsh', 'eval', 'exec', 'source', '.', 'env', 'xargs', 'sudo', 'nohup', 'nice', 'time', 'timeout',
  'command', 'builtin', 'forfiles', 'if', 'for', 'while', 'set', 'export', 'alias', 'doskey', 'path', 'find', 'wsl', 'fish', 'cross-env-shell', 'env-cmd', 'dotenv', 'dotenvx',
  'trap', 'coproc', 'function', 'hash', 'declare', 'enable', 'unset', 'case', 'select', 'until', 'then', 'do', 'else', 'elif',
  'turbo', 'nx', 'lerna', 'wireit', 'wsrun', 'rush', 'moon', 'lage', 'nodemon', 'husky', 'lint-staged', 'shx', 'start-server-and-test', 'npm-watch', 'onchange', 'execa',
]
// Neither start code of the repository's naming nor read any.
const INERT: readonly string[] = ['echo', 'exit', 'true', 'false', 'rimraf', 'rm', 'del', 'mkdir', 'mkdirp']
const BUILT_IN: readonly string[] = ['echo', 'exit', 'cd', 'mkdir', 'del']
// Tools known to run their own code, and tests as tests are run.
const TOOLS: readonly string[] = [
  'jest', 'vitest', 'mocha', 'ava', 'tap', 'jasmine', 'playwright', 'tsd', 'tsc', 'vue-tsc', 'svelte-check', 'astro', 'eslint', 'biome', 'oxlint', 'prettier', 'stylelint',
  'standard', 'xo', 'knip', 'cspell', 'markdownlint', 'publint', 'vite', 'next', 'rollup', 'webpack', 'esbuild', 'pytest', 'ruff', 'mypy', 'pyright', 'flake8', 'black', 'shellcheck',
]
// With a name and an equals sign before it, sh sets a variable and cmd starts the name.
const STARTS_CODE = /^(?:node|nodejs|bash|sh|python3?|py|claude|make|just|composer|deno|cross-env|tsx|ts-node|ruby|perl|php)$/
const PYTHON_MODULES: readonly string[] = ['pytest', 'unittest', 'mypy', 'ruff', 'flake8', 'black', 'pyright']
const FILE_HOSTS: readonly string[] = ['tsx', 'ts-node', 'ruby', 'perl', 'php']

const NODE_PLAIN = /^(?:--(?:no-warnings|no-deprecation|trace-warnings|trace-deprecation|enable-source-maps|expose-gc|check|experimental-vm-modules|experimental-strip-types|experimental-transform-types|experimental-test-coverage|test-only|test-force-exit)|--(?:max-old-space-size|stack-size|test-concurrency|test-timeout)=\d+|--(?:test-name-pattern|test-reporter-destination)=.+)$/
const NODE_CODE: readonly string[] = ['-r', '--require', '--import', '--loader', '--experimental-loader', '--test-reporter']
const NODE_EXTS = ['.js', '.cjs', '.mjs', '.json', '.node', '.ts', '.tsx', '.cts', '.mts', '.jsx']
/** What cmd would start from the folder it is in, before anything on the PATH. */
const WINDOWS_EXTS = ['.com', '.exe', '.bat', '.cmd', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msc']
const CODE_FILE = /\w\.(?:[cm]?[jt]sx?|sh|bash|py|rb|pl|php|ps1|bat|cmd)$/i
const WRITTEN_AFTER: readonly string[] = ['-o', '--out', '--outfile', '--outFile', '--out-file', '--output', '--output-file', '--outputFile']
const CODE_AFTER: readonly string[] = ['--require', '--import', '--loader', '--preload', '--config', '--rcfile', '--setupFiles', '--setupFilesAfterEach', '--setupFilesAfterEnv', '--globalSetup']
const SHORT_CODE_AFTER: readonly string[] = ['-r', '-c']

const SAFE_ENV: readonly string[] = ['NODE_ENV', 'BABEL_ENV', 'CI', 'FORCE_COLOR', 'NO_COLOR', 'TZ', 'LANG', 'LC_ALL', 'PORT', 'NODE_NO_WARNINGS']
const CHANGES_WHAT_RUNS = /^(?:(?:npm_|yarn_|pnpm_|bun_|corepack_|node_|ld_|dyld_)|(?:path|pathext|bash_env|env|comspec|cdpath|ifs|shell|shellopts|bashopts|home|userprofile|appdata|xdg_config_home|pythonpath|pythonstartup|pythonhome|perl5opt|rubyopt)$)/i

// ---------------------------------------------------------------- what one check starts

/** What ends a check's reading: a reason it cannot be allowed. */
class Unshown extends Error {}

type Found = {
  watch: Map<string, string>
  files: Map<string, { path: string; body: string }>
}
type Reading = {
  disk: Disk
  root: string
  check: ProofCheck
  cwd: string
  /** What is being read, for the words of a refusal. */
  where: string
  depth: number
  /** The command itself, which no shell reads. */
  isArgv: boolean
  found: Found
  /** `preloads`: what a config has Node load first, in whichever folder Node is then started. */
  own: { scripts: Draft['scripts']; seen: Set<string>; preloads: Set<string>; commands: number; manual: string | null }
}

const refuse = (r: Reading, why: string): never => {
  throw new Unshown(`${r.where} cannot be shown: ${why}`)
}
const manualOnly = (r: Reading, why: string) => {
  r.own.manual ??= why
}
const watch = (r: Reading, path: string) => {
  if (path && !r.found.watch.has(keyOf(path))) r.found.watch.set(keyOf(path), path)
}

/** A folder and those above it, up to the root. */
const chainOf = (dir: string): string[] => {
  const steps = dir ? dir.split('/') : []
  return Array.from({ length: steps.length + 1 }, (_, i) => steps.slice(0, steps.length - i).join('/'))
}
const watchFolders = (r: Reading, dir: string) => {
  for (const at of chainOf(dir)) for (const name of MANIFESTS) watch(r, joined(at, name))
}

/** Program names as they are matched. */
const programOf = (word: string) =>
  word
    .slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1)
    .toLowerCase()
    .replace(/(.)@[\w.^~-]+$/, '$1')
    .replace(/\.(?:exe|com|cmd|bat)$/, '')
/** The value in a `--flag=value`, or in the word after it. */
const flagOf = (text: string): [name: string, value: string | null] => {
  const at = text.startsWith('-') ? text.indexOf('=') : -1
  return at < 0 ? [text, null] : [text.slice(0, at), text.slice(at + 1)]
}
const looksLikePath = (value: string) => /[\\/]/.test(value) || /\w\.\w{1,8}$/.test(value)

/** A file named to run, as Node finds it: as named, with an extension, or as a folder's index or main. */
async function watchModule(r: Reading, path: string): Promise<void> {
  if (path) {
    watch(r, path)
    if ((await r.disk.file(path)).kind === 'file') return
    for (const ext of NODE_EXTS) watch(r, path + ext)
  }
  for (const ext of NODE_EXTS) watch(r, joined(path, `index${ext}`))
  const manifest = joined(path, 'package.json')
  watch(r, manifest)
  const read = await r.disk.file(manifest)
  const main = read.kind === 'file' ? objectIn(read.bytes)?.main : null
  if (typeof main !== 'string' || main === '') return
  const to = pathFrom(r.root, path, main)
  if (typeof to === 'string') return manualOnly(r, 'it runs a file outside the repository')
  watch(r, to.path)
  for (const ext of NODE_EXTS) {
    watch(r, to.path + ext)
    watch(r, joined(to.path, `index${ext}`))
  }
}

const notRunner = (r: Reading, file: string) => {
  if (RUNNER.test(programOf(file)) || RUNNER_FILE.test(file)) refuse(r, 'a package runner under another name')
}
/** A program of the repository or of no known kind could be handed a runner in any of its words. */
const notHandedRunner = (r: Reading, args: readonly Word[]) => {
  for (const arg of args) if (arg.text.split(/[^\w.@/\\-]+/).some(part => programOf(part) === 'node' || RUNNER.test(programOf(part)))) refuse(r, 'another program is handed a runner')
}

/** A file named to run. */
async function watchTarget(r: Reading, value: string, as: 'module' | 'file'): Promise<void> {
  const to = pathFrom(r.root, r.cwd, value)
  if (to === 'outside') return manualOnly(r, 'it runs a file outside the repository')
  if (to === 'unclear') return refuse(r, 'a path in it cannot be resolved')
  if (as === 'file') watch(r, to.path)
  else await watchModule(r, to.path)
}

/** The code a tool's own arguments name, and none of what they say it writes. */
async function watchNamed(r: Reading, args: readonly Word[]): Promise<void> {
  for (let i = 0; i < args.length; i++) {
    const { text } = args[i] as Word
    const [name, inline] = flagOf(text)
    if (WRITTEN_AFTER.includes(name)) {
      if (inline === null) i += 1
      continue
    }
    const next = args[i + 1]
    const value = inline ?? (next && !next.text.startsWith('-') ? next.text : null)
    if (value !== null && (name === '-p' || name === '--project')) {
      const to = pathFrom(r.root, r.cwd, value)
      if (typeof to === 'string') continue
      if (to.path && /\.\w+$/.test(to.path)) watch(r, to.path)
      else watch(r, joined(to.path, 'tsconfig.json'))
    } else if (value !== null && CODE_AFTER.includes(name) && looksLikePath(value)) await watchTarget(r, value, 'module')
    else if (value !== null && SHORT_CODE_AFTER.includes(name) && /\w\.\w{1,8}$/.test(value)) await watchTarget(r, value, 'file')
    else {
      const word = inline ?? text
      if (/[*?[\]{}]/.test(word) || !CODE_FILE.test(word)) continue
      const to = pathFrom(r.root, r.cwd, word)
      if (typeof to !== 'string') watch(r, to.path)
    }
  }
}

/** Node's flags up to the file it runs, and the files they have it load first. */
async function readNodeFlags(r: Reading, args: readonly Word[]): Promise<{ at: number; isTest: boolean; script: string | null; loads: string[] }> {
  let at = 0
  let isTest = false
  const loads: string[] = []
  for (; args[at]?.text.startsWith('-'); at++) {
    const [name, inline] = flagOf((args[at] as Word).text)
    if (name === '--run') {
      const word = inline === null ? args[++at] : args[at]
      const script = inline ?? word?.text
      if (!word?.isPlain || !script || script.startsWith('-')) return refuse(r, 'the script node runs cannot be told')
      return { at: at + 1, isTest, script, loads }
    }
    if (name === '--test' && inline === null) isTest = true
    else if (NODE_CODE.includes(name)) {
      const word = inline === null ? args[++at] : args[at]
      const value = inline ?? word?.text
      if (!word?.isPlain || !value || value.startsWith('-')) return refuse(r, 'what node loads first cannot be told')
      if (looksLikePath(value)) {
        loads.push(value)
        await watchTarget(r, value, 'module')
      }
    } else if (!NODE_PLAIN.test((args[at] as Word).text)) return refuse(r, 'a flag of node not understood')
  }
  return { at, isTest, script: null, loads }
}

async function showConfig(r: Reading, path: string): Promise<string | null> {
  const read = await r.disk.file(path)
  if (read.kind !== 'file') return null
  const body = textOf(read.bytes)
  if (!r.found.files.has(keyOf(path))) {
    const bad = fileProblem(body)
    if (bad) throw new Unshown(`${path} ${bad}`)
    r.found.files.set(keyOf(path), { path, body })
  }
  return body
}

async function readNpmrc(r: Reading, path: string, body: string): Promise<void> {
  const at = { ...r, where: path }
  for (const raw of body.split(/[\r\n]+/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const cut = line.indexOf('=')
    const name = cut < 0 ? line : line.slice(0, cut)
    if (name.includes('${')) refuse(at, 'it expands the name of a setting')
    // A quoted name is read as JSON, escapes and all; after ; or # is a comment.
    if (name.includes('\\')) refuse(at, 'it escapes the name of a setting')
    const key = (name.split(/[;#]/)[0] as string).replace(/["'\s]/g, '').replace(/\[\]$/, '').replace(/^-+/, '').replace(/_/g, '-').toLowerCase()
    if (NPMRC_REDIRECTS.includes(key)) refuse(at, `it sets ${key}, which changes what runs`)
    if (key !== 'node-options') continue
    const value = line.slice(cut + 1).trim().replace(/^"(.*)"$/, '$1')
    if (cut < 0 || /["'$\\;#]/.test(value)) refuse(at, 'its node-options cannot be understood')
    const args = value.split(/\s+/).filter(Boolean).map(literal)
    const flags = await readNodeFlags(at, args)
    if (flags.script !== null || flags.isTest || flags.at !== args.length) refuse(at, 'its node-options cannot be understood')
    for (const load of flags.loads) r.own.preloads.add(load)
  }
}

/** What of the repository configures a runner: shown whole, with what it names watched. */
async function readConfig(r: Reading, tool: string): Promise<void> {
  for (const dir of chainOf(r.cwd)) {
    for (const name of CONFIG[tool] ?? []) {
      const path = joined(dir, name)
      const body = await showConfig(r, path)
      if (body === null) continue
      const at = { ...r, where: path }
      const lines = body.split('\n').filter(line => !/^\s*#/.test(line))
      const named: string[] = []
      if (name === '.npmrc') await readNpmrc(r, path, body)
      if (name !== '.npmrc' && tool in ENV_FILES && lines.some(line => line.includes('\\'))) refuse(at, 'it escapes what it says')
      if (name === 'pnpm-workspace.yaml' && lines.some(line => PNPM_REDIRECTS.test(line))) refuse(at, 'a setting in it changes what runs')
      if (name.startsWith('.yarnrc')) {
        for (const line of lines) {
          if (YARN_REDIRECTS.test(line)) refuse(at, 'a setting in it changes what runs')
          if (/\byarn-?path\b/i.test(line)) {
            const m = YARN_PATH.exec(line)
            const value = m?.[1] ?? m?.[2] ?? m?.[3]
            if (!value) return refuse(at, 'the program it names cannot be told')
            named.push(value)
          }
          for (const m of line.matchAll(CODE_IN_TEXT)) named.push(m[0])
        }
      }
      if (name === 'bunfig.toml' && lines.some(line => /\bpreload\b/.test(line)))
        for (const line of lines)
          for (const m of line.matchAll(/["']([^"'\n]+)["']/g)) if (/\bpreload\b/.test(line) || looksLikePath(m[1] as string)) named.push(m[1] as string)
      for (const value of new Set(named)) await watchTarget({ ...at, cwd: dir }, value, 'module')
    }
    for (const name of LOADED[tool] ?? []) watch(r, joined(dir, name))
    for (const name of ENV_FILES[tool] ?? []) {
      const path = joined(dir, name)
      watch(r, path)
      const read = await r.disk.file(path)
      if (read.kind !== 'file') continue
      for (const line of textOf(read.bytes).split(/[\r\n]+/)) {
        const key = /^\s*(?:export\s+)?["']?([A-Za-z_][\w-]*)/.exec(line)?.[1]
        if (key && !SAFE_ENV.includes(key.toUpperCase()) && CHANGES_WHAT_RUNS.test(key)) refuse({ ...r, where: path }, `it sets ${key}, which changes what runs`)
      }
    }
  }
}

/** The scripts of the package a runner is started in. */
async function packageScripts(r: Reading): Promise<Map<string, unknown> | null> {
  const path = joined(r.cwd, 'package.json')
  const read = await r.disk.file(path)
  if (read.kind === 'problem') throw new Unshown(`${path} cannot be watched: ${read.why}`)
  return read.kind === 'file' ? scriptsIn(read.bytes) : null
}

/** A package script and its hooks, shown, and read with what is handed to it. */
async function runScript(r: Reading, name: string, handed: readonly Word[]): Promise<void> {
  for (const word of handed)
    if (/[$`%^&|<>"'\\;()]/.test(word.text) || (!word.isPlain && /\s/.test(word.text))) refuse(r, 'what it hands to a script cannot be told')
  const seen = JSON.stringify([r.cwd, name, handed.map(w => w.text)])
  if (r.own.seen.has(seen)) return
  r.own.seen.add(seen)
  if (r.depth > MAX_DEPTH) throw new Unshown('its scripts run one another too deep to show')
  const scripts = await packageScripts(r)
  if (!scripts) {
    if (r.isArgv) throw new Unshown('the package.json of its folder cannot be read')
    return refuse(r, `the package.json of ${r.cwd || 'the root'} cannot be read`)
  }
  if (!scripts.has(name)) throw new Unshown(`there is no script "${name}" to show`)
  for (const part of [`pre${name}`, name, `post${name}`]) {
    if (!scripts.has(part)) continue
    const label = r.cwd === r.check.dir ? part : `${r.cwd || '(root)'}: ${part}`
    const body = scripts.get(part)
    if (typeof body !== 'string') throw new Unshown(`the script "${label}" is not text`)
    const bad = showProblem(body) ?? (showProblem(label) ? 'is in a folder that cannot be shown' : null)
    if (bad) throw new Unshown(`the script "${label}" ${bad}`)
    if (!r.own.scripts.some(s => s.name === label && s.body === body)) {
      if (r.own.scripts.length >= MAX_SCRIPTS) throw new Unshown('it runs more scripts than can be shown')
      r.own.scripts.push({ checkId: r.check.id, name: label, body })
    }
    await readScript({ ...r, where: `the script "${label}"`, depth: r.depth + 1, isArgv: false }, body, part === name ? handed : [])
  }
}

/** A line of shell, command by command, following a change of folder where that is certain. */
async function readScript(r: Reading, line: string, handed: readonly Word[]): Promise<void> {
  const read = readLine(line)
  if ('why' in read) return refuse(r, read.why)
  const commands = read.commands.map(words => [...words])
  const last = commands[commands.length - 1]
  if (last) last.push(...handed)
  else if (handed.length > 0) return refuse(r, 'what is handed to it would be the command')
  const isMove = (words: readonly Word[]) => words[0]?.text.toLowerCase() === 'cd' && !words[0].isQuoted
  // Joined any other way, where a later command runs depends on how an earlier one ended, or on the shell.
  if (commands.some(isMove) && read.joins.some(join => join !== '&&')) return refuse(r, 'its change of folder cannot be resolved')
  let at = r
  for (const words of commands) {
    if (!isMove(words)) {
      await readCommand(at, words)
      continue
    }
    const target = words[1]
    const to = words.length === 2 && target?.isPlain && !target.text.startsWith('-') ? pathFrom(r.root, at.cwd, target.text) : 'unclear'
    if (typeof to === 'string' || !(await r.disk.list(to.path))) return refuse(r, 'its change of folder cannot be resolved')
    at = { ...at, cwd: to.path }
  }
}

/** The words after a flag-free runner word that names another program. */
async function readWrapped(r: Reading, args: readonly Word[], flags: readonly string[]): Promise<void> {
  let at = 0
  while (flags.includes(args[at]?.text ?? '')) at += 1
  const rest = args.slice(at)
  if (!rest[0] || rest[0].text.startsWith('-')) return refuse(r, 'the program it starts cannot be told')
  await readCommand({ ...r, isArgv: false }, rest)
}

async function readPackageRunner(r: Reading, tool: string, args: readonly Word[]): Promise<void> {
  const texts = args.map(w => w.text)
  if (texts.length === 1 && (texts[0] === '--version' || texts[0] === '-v')) return
  if (tool === 'yarn' && texts.some(text => text.startsWith('--cwd'))) return refuse(r, 'yarn would run in another folder')
  const flags = tool === 'bun' ? [...RUNNER_FLAGS, '--bun'] : RUNNER_FLAGS
  let at = 0
  const skipFlags = () => {
    while (flags.includes(texts[at] ?? '')) at += 1
  }
  skipFlags()
  let name = texts[at]
  await readConfig(r, tool)
  const isRun = name !== undefined && RUN_WORDS[tool]?.includes(name) === true
  const isShort = !isRun && name !== undefined && SHORT_RUNS[tool]?.includes(name) === true
  if (isRun) {
    at += 1
    skipFlags()
    name = texts[at]
  } else if (isShort && (name === 't' || name === 'tst')) name = 'test'
  // A flag before the name may choose another folder, or take the name as its value.
  if (!name || name.startsWith('-') || !args[at]?.isPlain) return refuse(r, `what ${tool} starts cannot be told`)
  const rest = args.slice(at + 1)

  if (!isRun && !isShort) {
    if (tool === 'bun' && name === 'test') return readBunTest(r, rest)
    if (tool === 'bun' && name === 'build') return watchNamed(r, rest)
    if (tool === 'yarn' && name === 'node') return readNode(r, rest)
    if (EXEC_WORDS[tool]?.includes(name)) {
      if (tool !== 'npm') return readWrapped(r, rest, tool === 'bun' ? NPX_FLAGS : [])
      // npm takes every flag as its own until `--`.
      if (rest[0]?.text === '--') return readWrapped(r, rest.slice(1), [])
      if (rest.some(w => w.text.startsWith('-'))) return refuse(r, 'npm exec would read these flags as its own')
      return readWrapped(r, rest, [])
    }
    if (tool === 'npm') return name === 'ls' || name === 'audit' ? undefined : refuse(r, 'a command of npm not understood')
    if (RUNNER_OWN.test(name)) return refuse(r, `a command of ${tool} that can run other scripts`)
  }
  if (tool === 'bun' && CODE_FILE.test(name) && !(await packageScripts(r))?.has(name)) {
    notRunner(r, name)
    notHandedRunner(r, rest)
    await watchTarget(r, name, 'module')
    return watchNamed(r, rest)
  }
  if (!isRun && !isShort) {
    // The others take a script by its bare name, and otherwise a program.
    const scripts = await packageScripts(r)
    if (!scripts) return refuse(r, `what ${tool} ${name} starts cannot be told`)
    if (!scripts.has(name)) return TOOLS.includes(name) ? readCommand({ ...r, isArgv: false }, args.slice(at)) : refuse(r, `a command of ${tool} not understood`)
  }
  const cut = rest.findIndex(w => w.text === '--')
  let handed = cut < 0 ? rest : [...rest.slice(0, cut), ...rest.slice(cut + 1)]
  if (tool === 'npm') {
    // npm reads flags after the name as its own, up to `--`.
    const own = cut < 0 ? rest : rest.slice(0, cut)
    if (own.some(w => w.text.startsWith('-') && !flags.includes(w.text))) return refuse(r, 'npm would read a flag after the name as its own')
    handed = [...own.filter(w => !flags.includes(w.text)), ...(cut < 0 ? [] : rest.slice(cut + 1))]
  }
  await runScript(r, name, handed)
}

async function readBunTest(r: Reading, args: readonly Word[]): Promise<void> {
  for (let i = 0; i < args.length; i++) {
    const [name, inline] = flagOf((args[i] as Word).text)
    if (['--cwd', '--config', '-c', '--env-file', '--define'].includes(name)) refuse(r, 'a flag of bun test not understood')
    if (name !== '-r' && name !== '--preload') continue
    const word = inline === null ? args[i + 1] : args[i]
    const value = inline ?? word?.text
    if (!word?.isPlain || !value) return refuse(r, 'what bun loads first cannot be told')
    await watchTarget(r, value, 'module')
  }
  await watchNamed(r, args)
}

async function readNode(r: Reading, args: readonly Word[]): Promise<void> {
  const { at, isTest, script } = await readNodeFlags(r, args)
  const rest = args.slice(at)
  if (script !== null) {
    if (rest.length > 0 && rest[0]?.text !== '--') return refuse(r, 'what node hands to the script cannot be told')
    return runScript(r, script, rest.slice(1))
  }
  if (isTest) return watchNamed(r, rest)
  const file = rest[0]
  if (!file?.isPlain || file.text === 'inspect') return refuse(r, 'the file node runs cannot be told')
  notRunner(r, file.text)
  notHandedRunner(r, rest.slice(1))
  await watchTarget(r, file.text, 'module')
  await watchNamed(r, rest.slice(1))
}

async function readShell(r: Reading, args: readonly Word[]): Promise<void> {
  let at = 0
  for (; args[at]?.text.startsWith('-'); at++) {
    const flag = (args[at] as Word).text
    if (flag === '-c') {
      const line = args[at + 1]
      if (!line?.isPlain || args.length !== at + 2) return refuse(r, 'the line given to a shell cannot be told')
      return readScript({ ...r, isArgv: false }, line.text, [])
    }
    if (/^-[eux]{0,3}o$/.test(flag) && args[at + 1]?.text === 'pipefail') at += 1
    else if (!/^(?:-[eux]{1,3}|--noprofile|--norc)$/.test(flag)) return refuse(r, 'a flag of a shell not understood')
  }
  const file = args[at]
  if (!file?.isPlain || !file.text) return refuse(r, 'the script the shell runs cannot be told')
  notRunner(r, file.text)
  notHandedRunner(r, args.slice(at + 1))
  await watchTarget(r, file.text, 'file')
  await watchNamed(r, args.slice(at + 1))
}

async function readPython(r: Reading, args: readonly Word[]): Promise<void> {
  let at = 0
  while (['-u', '-B'].includes(args[at]?.text ?? '')) at += 1
  const first = args[at]
  if (!first?.isPlain || first.text === '-' || first.text.startsWith('-c')) return refuse(r, 'the code python runs cannot be told')
  if (first.text === '-m') {
    const name = args[at + 1]?.text ?? ''
    if (!PYTHON_MODULES.includes(name)) {
      notHandedRunner(r, args.slice(at + 2))
      await watchNamed(r, args.slice(at + 2))
      return manualOnly(r, 'what that python module runs is not known')
    }
    // Python takes a module of that name from the folder it is in first.
    watch(r, joined(r.cwd, `${name}.py`))
    watch(r, joined(r.cwd, `${name}/__init__.py`))
    watch(r, joined(r.cwd, `${name}/__main__.py`))
    return watchNamed(r, args.slice(at + 2))
  }
  if (first.text.startsWith('-')) {
    if (args.some(word => word.text.startsWith('-c'))) return refuse(r, 'the code python runs cannot be told')
    notHandedRunner(r, args)
    await watchNamed(r, args)
    return manualOnly(r, 'what those python flags run is not known')
  }
  notRunner(r, first.text)
  notHandedRunner(r, args.slice(at + 1))
  await watchTarget(r, first.text, 'file')
  const to = pathFrom(r.root, r.cwd, first.text)
  if (typeof to !== 'string' && !/\.py$/i.test(to.path)) watch(r, joined(to.path, '__main__.py'))
  await watchNamed(r, args.slice(at + 1))
}

async function readFileHost(r: Reading, host: string, args: readonly Word[]): Promise<void> {
  const first = args[0]
  if (!first?.isPlain || /^-(?:$|[cerEp]|-eval|-print)/.test(first.text)) return refuse(r, `the code ${host} runs cannot be told`)
  if (first.text.startsWith('-')) {
    if (args.some(word => /^-(?:[eE]|-eval)/.test(word.text))) return refuse(r, `the code ${host} runs cannot be told`)
    notHandedRunner(r, args)
    await watchNamed(r, args)
    return manualOnly(r, `what those flags of ${host} run is not known`)
  }
  notRunner(r, first.text)
  notHandedRunner(r, args.slice(1))
  await watchTarget(r, first.text, host === 'tsx' || host === 'ts-node' ? 'module' : 'file')
  await watchNamed(r, args.slice(1))
}

async function readClaude(r: Reading, args: readonly Word[]): Promise<void> {
  const [noun, verb, folder] = args
  if (noun?.text !== 'plugin' || (verb?.text !== 'test' && verb?.text !== 'validate') || args.length > 3 || folder?.text.startsWith('-') || folder?.isPlain === false)
    return refuse(r, 'only claude plugin test and validate are understood')
  const to = pathFrom(r.root, r.cwd, folder?.text ?? '.')
  if (to === 'outside') return manualOnly(r, 'it tests a plugin outside the repository')
  if (to === 'unclear') return refuse(r, 'the plugin folder cannot be resolved')
  watchFolders(r, to.path)
  await readConfig(r, 'claude')
  await readConfig({ ...r, cwd: to.path }, 'claude')
  const manifest = joined(to.path, '.claude-plugin/plugin.json')
  watch(r, manifest)
  watch(r, joined(to.path, 'hooks/hooks.json'))
  const read = await r.disk.file(manifest)
  const hooks = read.kind === 'file' ? objectIn(read.bytes)?.hooks : null
  if (typeof hooks === 'string') await watchTarget({ ...r, cwd: to.path }, hooks, 'file')
}

async function readRunAll(r: Reading, args: readonly Word[]): Promise<void> {
  await readConfig(r, 'npm')
  for (const word of args) {
    if (word.text.startsWith('-')) {
      if (!RUN_ALL_FLAGS.test(word.text)) refuse(r, 'a flag before a script not understood')
    } else if (!word.isPlain || /[*?{}\s]/.test(word.text)) refuse(r, 'the scripts it runs cannot be told')
    else await runScript(r, word.text, [])
  }
}

async function readRecipes(r: Reading, tool: string, args: readonly Word[]): Promise<void> {
  for (const word of args) if (!word.isPlain || word.text.startsWith('-') || word.text.includes('=')) refuse(r, `a word before a recipe of ${tool} not understood`)
  await readConfig(r, tool)
  manualOnly(r, 'what its recipes run is not known')
}

/** The environment set before a command. */
const readAssignment = (r: Reading, name: string, value: string) => {
  if (SAFE_ENV.includes(name.toUpperCase())) return
  if (name === 'NODE_OPTIONS' && value.split(/\s+/).filter(Boolean).every(flag => NODE_PLAIN.test(flag))) return
  if (CHANGES_WHAT_RUNS.test(name)) refuse(r, `it sets ${name}, which changes what runs`)
  manualOnly(r, `what setting ${name} changes is not known`)
}

/** One command, as far as it is understood. */
async function readCommand(r: Reading, all: readonly Word[]): Promise<void> {
  r.own.commands += 1
  if (r.own.commands > MAX_COMMANDS) throw new Unshown('it runs more commands than can be shown')
  watchFolders(r, r.cwd)
  for (const load of r.own.preloads) await watchTarget(r, load, 'module')
  let words = all
  for (;;) {
    const set = /^([A-Za-z_]\w*)=(.*)$/.exec(words[0]?.text ?? '')
    if (!set) break
    const name = set[1] as string
    const asProgram = name.toLowerCase()
    if (RUNNER.test(asProgram) || STARTS_CODE.test(asProgram) || RUNS_OTHERS.includes(asProgram)) return refuse(r, 'cmd would start what it sets')
    for (const ext of WINDOWS_EXTS) watch(r, joined(r.cwd, name + ext))
    readAssignment(r, name, set[2] as string)
    words = words.slice(1)
  }
  const word = words[0]
  if (!word) return refuse(r, 'it sets the environment and names no command')
  const args = words.slice(1)
  const spelled = word.text.replace(/\\/g, '/')
  if (!r.isArgv) {
    if (word.isQuoted || !word.isPlain || !/^(?=.*\w)[\w./][\w.+@/-]*$/.test(word.text)) return refuse(r, 'a program named in a way not understood')
    const steps = spelled.split('/')
    if (steps.some(step => step !== '.' && step !== '..' && isWindowsOddName(step))) return refuse(r, 'a program name Windows reads as another')
    // cmd ends a name at these, and takes the rest as its arguments.
    if (/^(?:cd|chdir|call|start|echo|set|if|for|path|pushd|type)[./+]/i.test(spelled)) return refuse(r, 'a command cmd reads otherwise')
    const head = (steps[0] as string).toLowerCase()
    // cmd ends a program's name at a slash.
    if (steps.length > 1 && (RUNNER.test(head) || STARTS_CODE.test(head))) return refuse(r, 'a package runner under another name')
  }
  const program = programOf(word.text)

  if (spelled.includes('/')) {
    const to = pathFrom(r.root, r.cwd, word.text)
    if (to === 'unclear') return refuse(r, 'a path in it cannot be resolved')
    if (to !== 'outside' && !to.path.split('/').includes('node_modules')) {
      // The repository's own program, whatever it is called.
      if (RUNNER.test(program) || program === 'node') return refuse(r, 'a package runner under another name')
      notHandedRunner(r, args)
      watch(r, to.path)
      for (const ext of WINDOWS_EXTS) watch(r, to.path + ext)
      return watchNamed(r, args)
    }
    if (to === 'outside' && !r.isArgv) manualOnly(r, 'it runs a file outside the repository')
  } else if (!BUILT_IN.includes(program)) {
    // cmd, and the shims npm makes, look in the folder they are in before the PATH.
    // A shim of any installed tool starts `node` by that bare name.
    for (const name of [program, 'node']) for (const ext of WINDOWS_EXTS) watch(r, joined(r.cwd, name + ext))
    if (word.text.includes('.')) watch(r, joined(r.cwd, word.text))
  }

  if (program === 'npm' || program === 'pnpm' || program === 'yarn' || program === 'bun') return readPackageRunner(r, program, args)
  if (program === 'npx' || program === 'bunx') {
    await readConfig(r, program === 'npx' ? 'npm' : 'bun')
    return readWrapped(r, args, NPX_FLAGS)
  }
  if (program === 'corepack') {
    const manager = args[0]
    if (!manager?.isPlain || !['npm', 'pnpm', 'yarn'].includes(manager.text)) return refuse(r, 'a command of corepack not understood')
    return readPackageRunner(r, manager.text, args.slice(1))
  }
  if (program === 'cross-env') return readCommand({ ...r, isArgv: false }, args)
  if (program === 'run-s' || program === 'run-p' || program === 'npm-run-all' || program === 'npm-run-all2') return readRunAll(r, args)
  if (program === 'node' || program === 'nodejs') return readNode(r, args)
  if (program === 'bash' || program === 'sh') return readShell(r, args)
  if (program === 'python' || program === 'python3' || program === 'py') return readPython(r, args)
  if (FILE_HOSTS.includes(program)) return readFileHost(r, program, args)
  if (program === 'claude') return readClaude(r, args)
  if (program === 'make' || program === 'just' || program === 'composer' || (program === 'deno' && args[0]?.text === 'task')) return readRecipes(r, program, args)
  if (RUNNER.test(program)) return refuse(r, 'a runner alias, which is not read')
  if (RUNS_OTHERS.includes(program)) return refuse(r, `${program} starts commands that are not read`)
  if (INERT.includes(program)) return
  if (TOOLS.includes(program)) {
    // A tool is handed a command as one word, if at all.
    for (const arg of args)
      if (/\s/.test(arg.text) && arg.text.split(/[\s:=]+/).some(part => RUNNER.test(programOf(part)))) return refuse(r, `${program} is handed a runner`)
    return watchNamed(r, args)
  }
  notHandedRunner(r, args)
  // An alias this does not know, told to run one of the package's scripts.
  if (args.some(arg => arg.text === 'run' || arg.text === 'run-script')) {
    const scripts = await packageScripts(r)
    if (args.some(arg => scripts?.has(arg.text))) return refuse(r, `${program} may be a runner alias`)
  }
  manualOnly(r, `what ${program} runs is not known`)
  await watchNamed(r, args)
}

// ---------------------------------------------------------------- checks

/** How a command's counts are read, where the command itself says so. */
const parserOf = ([exe = '', first = '', second = '']: readonly string[]): ProofCountRule['parser'] | null => {
  const program = programOf(exe)
  if ((program === 'bun' && first === 'test') || (program === 'claude' && first === 'plugin' && second === 'test')) return 'bun'
  return (program === 'bash' || program === 'sh') && programOf(first) === 'run_all.sh' ? 'pass-fail-lines' : null
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

const managerOf = (entries: readonly Entry[]): string => {
  if (hasFile(entries, 'package-lock.json') || hasFile(entries, 'npm-shrinkwrap.json')) return 'npm'
  if (hasFile(entries, 'pnpm-lock.yaml')) return 'pnpm'
  if (hasFile(entries, 'yarn.lock')) return 'yarn'
  return hasFile(entries, 'bun.lock') || hasFile(entries, 'bun.lockb') ? 'bun' : 'npm'
}

const scriptChecks = (manager: string, scripts: ReadonlyMap<string, unknown>): Candidate[] =>
  SCRIPT_NAMES.flatMap(([kind, names]): Candidate[] => {
    const name = names.find(n => typeof scripts.get(n) === 'string' && scripts.get(n) !== '')
    if (!name) return []
    const body = scripts.get(name) as string
    // What npm init writes is no test.
    if (kind === 'test' && body.includes('Error: no test specified')) return []
    const read = body.length > MAX_BODY ? null : readLine(body)
    const commands = read && 'commands' in read ? read.commands : []
    const parser = commands.map(words => parserOf(words.map(w => w.text))).find(p => p !== null) ?? null
    return [{ kind, argv: [manager, 'run', name], description: `${name} script`, parser }]
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
    const found: Candidate[] = scripts ? scriptChecks(managerOf(entries), scripts) : []
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
      const r: Reading = { disk, root, check, cwd: check.dir, where: 'it', depth: 0, isArgv: true, found, own: { scripts: [], seen: new Set(), preloads: new Set(), commands: 0, manual: null } }
      try {
        await readCommand(r, check.argv.map(literal))
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
