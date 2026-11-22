// What one check starts. A small grammar is understood, and only that runs by itself. A program that is
// not known runs by hand alone, as the screen then says; anything else is refused, never guessed at.
//
// A package script is understood only as plain words joined by ` && `: no quote, glob, variable, escape,
// redirect or assignment, so sh and cmd cannot read it two ways.
import { joined } from '../watched'
import { readBunConfig, readNpmConfig } from './config'
import { BUN_TEST_FLAGS, MANIFESTS, SHIM_EXTS, STARTS_OTHERS, TOOLS, UNDERSTOOD } from './known'
import type { Tool } from './known'
import { Unshown, chainOf, insideRoot, manualOnly, refuse, watch, watchRun } from './reading'
import type { Reading } from './reading'
import { objectIn, scriptsIn, showProblem } from './text'

const MAX_SCRIPTS = 24
/** How many scripts deep one may run another and still be shown. */
const MAX_DEPTH = 4

/** Letters every shell, and every shim between, reads as themselves. An `=` only inside a flag. */
const isPlain = (word: string) => /^[A-Za-z0-9_./:-][A-Za-z0-9_./:@-]*$/.test(word) || /^--?[A-Za-z][A-Za-z0-9-]*=[A-Za-z0-9_./:@-]+$/.test(word)
/** A word that is an option to some program: `-x`, `+x`. */
const isOption = (word: string) => /^[-+]/.test(word)

/** One script's commands, or null where it is not of the grammar. */
export const commandsIn = (body: string): string[][] | null => {
  const commands = body.trim().split(/ +&& +/).map(part => part.split(/ +/))
  return commands.every(words => words.length > 0 && words.every(isPlain)) ? commands : null
}

/** npm puts each node_modules/.bin up to the root before every program of the same name, node among them. */
const watchShims = (r: Reading, program: string) => {
  for (const dir of chainOf(r.check.dir))
    for (const name of new Set([program, 'node'])) for (const ext of SHIM_EXTS) watch(r, joined(dir, `node_modules/.bin/${name}${ext}`))
}

async function readNpm(r: Reading, args: readonly string[]): Promise<void> {
  const name = args.length === 2 && args[0] === 'run' ? args[1] : args.length === 1 && args[0] === 'test' ? 'test' : undefined
  if (!name || !/^[A-Za-z0-9_][A-Za-z0-9_:.-]*$/.test(name)) return refuse(r, 'of npm only `npm run <name>` is understood')
  await readNpmConfig(r)
  if (r.own.seen.has(name)) return
  r.own.seen.add(name)
  if (r.depth > MAX_DEPTH) throw new Unshown('its scripts run one another too deep to show')
  const path = joined(r.check.dir, 'package.json')
  const read = await r.disk.file(path)
  if (read.kind === 'problem') throw new Unshown(`${path} cannot be watched: ${read.why}`)
  const scripts = read.kind === 'file' ? scriptsIn(read.bytes) : null
  if (!scripts) throw new Unshown('the package.json of its folder cannot be read')
  if (!scripts.has(name)) throw new Unshown(`there is no script "${name}" to show`)
  for (const part of [`pre${name}`, name, `post${name}`]) {
    if (!scripts.has(part)) continue
    const body = scripts.get(part)
    if (typeof body !== 'string') throw new Unshown(`the script "${part}" is not text`)
    const bad = showProblem(body)
    if (bad) throw new Unshown(`the script "${part}" ${bad}`)
    if (!r.own.scripts.some(s => s.name === part)) {
      if (r.own.scripts.length >= MAX_SCRIPTS) throw new Unshown('it runs more scripts than can be shown')
      r.own.scripts.push({ checkId: r.check.id, name: part, body })
    }
    const inner = { ...r, where: `the script "${part}"`, depth: r.depth + 1, inScript: true }
    const commands = commandsIn(body)
    if (!commands) return refuse(inner, 'only plain words joined by && are understood')
    for (const words of commands) await readCommand(inner, words)
  }
}

/** `node <file> [words]`: no flag before the file, and the file there under exactly that name. */
async function readNode(r: Reading, args: readonly string[]): Promise<void> {
  const [file] = args
  if (!file || isOption(file) || !/\.(?:[cm]?js|[cm]?ts)$/.test(file)) return refuse(r, 'of node only `node <file>` is understood, the file with its extension')
  await watchRun(r, file)
}

/** `bash <file> [words]`: no option. */
async function readShell(r: Reading, args: readonly string[]): Promise<void> {
  const [file] = args
  if (!file || isOption(file)) return refuse(r, 'of a shell only `bash <file>` is understood, with no option')
  await watchRun(r, file)
}

async function readBun(r: Reading, args: readonly string[]): Promise<void> {
  if (args[0] !== 'test') return refuse(r, 'of bun only `bun test` is understood')
  for (const arg of args.slice(1)) if (isOption(arg) && !BUN_TEST_FLAGS.includes(arg)) refuse(r, `${arg} is not a flag of bun test that is understood`)
  await readBunConfig(r, r.check.dir)
}

async function readClaude(r: Reading, args: readonly string[]): Promise<void> {
  const [noun, verb, folder = '.', more] = args
  if (noun !== 'plugin' || (verb !== 'test' && verb !== 'validate') || more !== undefined || isOption(folder)) return refuse(r, 'of claude only `claude plugin test` and `validate` are understood')
  const dir = insideRoot(r, folder)
  await readBunConfig(r, r.check.dir)
  await readBunConfig(r, dir)
  for (const name of ['package.json', 'bunfig.toml', 'hooks/hooks.json']) watch(r, joined(dir, name))
  const manifest = joined(dir, '.claude-plugin/plugin.json')
  watch(r, manifest)
  const read = await r.disk.file(manifest)
  const hooks = read.kind === 'file' ? objectIn(read.bytes)?.hooks : null
  if (hooks === undefined || hooks === null) return
  if (typeof hooks !== 'string') return refuse(r, 'hooks written inside plugin.json are not understood')
  await watchRun(r, joined(dir === r.check.dir ? '' : folder.replace(/\/+$/, ''), hooks.replace(/^\.\//, '')))
}

function readTool(r: Reading, name: string, tool: Tool, args: readonly string[]) {
  if (tool.first && !tool.first.includes(args[0] ?? '')) return refuse(r, `of ${name} only ${tool.first.join(', ')} is understood`)
  for (let i = tool.first ? 1 : 0; i < args.length; i++) {
    const arg = args[i] as string
    if (!isOption(arg)) {
      // Only to keep what it is pointed at inside the repository.
      insideRoot(r, arg)
      continue
    }
    if (tool.flags.includes(arg)) continue
    const next = args[i + 1]
    if (tool.counts?.includes(arg) && next !== undefined && /^\d+$/.test(next)) {
      i += 1
      continue
    }
    if (tool.projects?.includes(arg) && next !== undefined && !isOption(next)) {
      const path = insideRoot(r, next)
      watch(r, /\.json$/.test(path) ? path : joined(path, 'tsconfig.json'))
      i += 1
      continue
    }
    return refuse(r, `${arg} is not a flag of ${name} that is understood`)
  }
}

/** One command, as argv: the check's own, or a script's plain words. */
export async function readCommand(r: Reading, words: readonly string[]): Promise<void> {
  const [word = '', ...args] = words
  for (const dir of chainOf(r.check.dir)) for (const name of MANIFESTS) watch(r, joined(dir, name))
  const program = word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1).toLowerCase().replace(/\.(?:exe|com|cmd|bat|ps1)$/, '')
  if (STARTS_OTHERS.includes(program)) return refuse(r, `${program} starts what is not shown`)
  const tool = TOOLS.get(program)
  const isKnown = tool !== undefined || UNDERSTOOD.includes(program)
  if (!/^[a-z][a-z0-9-]*$/.test(word)) {
    // Under any other spelling a known program is another file. An unknown one, named whole, is only typed.
    if (isKnown || r.inScript) return refuse(r, 'a program is named by its plain name')
    if (/^(?:\/|[A-Za-z]:)/.test(word) && !word.replace(/\\/g, '/').toLowerCase().startsWith(`${r.root.replace(/\\/g, '/').toLowerCase()}/`))
      return manualOnly(r, `what ${program} runs is not known`)
    return refuse(r, 'a program of the repository is not understood: name what runs it')
  }
  if (r.inScript) watchShims(r, program)
  if (!isKnown) return manualOnly(r, `what ${program} runs is not known`)
  if (!args.every(isPlain)) return refuse(r, 'an argument in it is not a plain word')
  if (program === 'npm') return readNpm(r, args)
  if (program === 'node') return readNode(r, args)
  if (program === 'bash' || program === 'sh') return readShell(r, args)
  if (program === 'bun') return readBun(r, args)
  if (program === 'claude') return readClaude(r, args)
  if (tool) readTool(r, program, tool, args)
}
