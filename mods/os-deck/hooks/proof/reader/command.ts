// What one command starts, followed through scripts and runners: understood, manual only, or refused.
import { isWindowsOddName } from '../names'
import { joined, pathFrom } from '../watched'
import { readConfig } from './config'
import { BUILT_IN, CHANGES_WHAT_RUNS, CODE_FILE, EXEC_WORDS, FILE_HOSTS, INERT, NODE_PLAIN, NPX_FLAGS, PYTHON_MODULES, RUNNER, RUNNER_FLAGS, RUNNER_OWN, RUNS_OTHERS, RUN_ALL_FLAGS, RUN_WORDS, SAFE_ENV, SHORT_RUNS, STARTS_CODE, TOOLS, WINDOWS_EXTS } from './known'
import { readLine } from './line'
import type { Word } from './line'
import { Unshown, flagOf, manualOnly, notHandedRunner, notRunner, programOf, readNodeFlags, refuse, watch, watchFolders, watchNamed, watchTarget } from './reading'
import type { Reading } from './reading'
import { objectIn, scriptsIn, showProblem } from './text'

const MAX_SCRIPTS = 24
/** How many scripts deep one may run another and still be shown. */
const MAX_DEPTH = 4
/** Commands followed for one check, so scripts that call each other many times end. */
const MAX_COMMANDS = 400

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
export async function readCommand(r: Reading, all: readonly Word[]): Promise<void> {
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
