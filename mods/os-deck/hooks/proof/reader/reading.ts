// One check's reading as it goes: what it found to watch, and the files a command names.
import type { ProofCheck } from '../../../types'
import type { Draft } from '../model'
import { joined, keyOf, pathFrom } from '../watched'
import type { Disk } from '../watched'
import { CODE_AFTER, CODE_FILE, MANIFESTS, NODE_CODE, NODE_EXTS, NODE_PLAIN, RUNNER, RUNNER_FILE, SHORT_CODE_AFTER, WRITTEN_AFTER } from './known'
import type { Word } from './line'
import { objectIn } from './text'

/** What ends a check's reading: a reason it cannot be allowed. */
export class Unshown extends Error {}

export type Found = {
  watch: Map<string, string>
  files: Map<string, { path: string; body: string }>
}
export type Reading = {
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

export const refuse = (r: Reading, why: string): never => {
  throw new Unshown(`${r.where} cannot be shown: ${why}`)
}
export const manualOnly = (r: Reading, why: string) => {
  r.own.manual ??= why
}
export const watch = (r: Reading, path: string) => {
  if (path && !r.found.watch.has(keyOf(path))) r.found.watch.set(keyOf(path), path)
}

/** A folder and those above it, up to the root. */
export const chainOf = (dir: string): string[] => {
  const steps = dir ? dir.split('/') : []
  return Array.from({ length: steps.length + 1 }, (_, i) => steps.slice(0, steps.length - i).join('/'))
}
export const watchFolders = (r: Reading, dir: string) => {
  for (const at of chainOf(dir)) for (const name of MANIFESTS) watch(r, joined(at, name))
}

/** Program names as they are matched. */
export const programOf = (word: string) =>
  word
    .slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1)
    .toLowerCase()
    .replace(/(.)@[\w.^~-]+$/, '$1')
    .replace(/\.(?:exe|com|cmd|bat)$/, '')
/** The value in a `--flag=value`, or in the word after it. */
export const flagOf = (text: string): [name: string, value: string | null] => {
  const at = text.startsWith('-') ? text.indexOf('=') : -1
  return at < 0 ? [text, null] : [text.slice(0, at), text.slice(at + 1)]
}
export const looksLikePath = (value: string) => /[\\/]/.test(value) || /\w\.\w{1,8}$/.test(value)

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

export const notRunner = (r: Reading, file: string) => {
  if (RUNNER.test(programOf(file)) || RUNNER_FILE.test(file)) refuse(r, 'a package runner under another name')
}
/** A program of the repository or of no known kind could be handed a runner in any of its words. */
export const notHandedRunner = (r: Reading, args: readonly Word[]) => {
  for (const arg of args) if (arg.text.split(/[^\w.@/\\-]+/).some(part => programOf(part) === 'node' || RUNNER.test(programOf(part)))) refuse(r, 'another program is handed a runner')
}

/** A file named to run. */
export async function watchTarget(r: Reading, value: string, as: 'module' | 'file'): Promise<void> {
  const to = pathFrom(r.root, r.cwd, value)
  if (to === 'outside') return manualOnly(r, 'it runs a file outside the repository')
  if (to === 'unclear') return refuse(r, 'a path in it cannot be resolved')
  if (as === 'file') watch(r, to.path)
  else await watchModule(r, to.path)
}

/** The code a tool's own arguments name, and none of what they say it writes. */
export async function watchNamed(r: Reading, args: readonly Word[]): Promise<void> {
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
export async function readNodeFlags(r: Reading, args: readonly Word[]): Promise<{ at: number; isTest: boolean; script: string | null; loads: string[] }> {
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
