// One check's reading as it goes: what it found to show and to watch, and how it ends.
import type { ProofCheck } from '../../../types'
import type { Draft } from '../model'
import { keyOf, pathFrom } from '../watched'
import type { Disk } from '../watched'

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
  /** What is being read, for the words of a refusal. */
  where: string
  depth: number
  /** Inside a package script: npm starts it, through a shell, with node_modules/.bin before the PATH. */
  inScript: boolean
  found: Found
  own: { scripts: Draft['scripts']; seen: Set<string>; manual: string | null }
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

/** A path a command names, as one from the root, or the reading ends. */
export const insideRoot = (r: Reading, value: string): string => {
  const to = pathFrom(r.root, r.check.dir, value)
  if (to === 'outside') return refuse(r, 'it names a path outside the repository')
  if (to === 'unclear') return refuse(r, 'a path in it cannot be resolved')
  return to.path
}

/**
 * A path spelled as the disk has it, or the reading ends: a folder of Windows can be case-sensitive,
 * and there another spelling is another file, or none, with another found in its place.
 */
export async function asSpelled(r: Reading, path: string): Promise<void> {
  const steps = path.split('/')
  for (let i = 0; i < steps.length; i++) {
    const entries = await r.disk.list(steps.slice(0, i).join('/'))
    if (!entries?.some(x => x.name === steps[i])) refuse(r, `${path} is not spelled as the disk has it`)
  }
}

/** A file named to run: there as it is named, so nothing is found in its place, and then watched. */
export async function watchRun(r: Reading, value: string): Promise<void> {
  const path = insideRoot(r, value)
  if (path.split('/').some(step => step.toLowerCase() === 'node_modules')) refuse(r, 'it runs a file of a dependency')
  const file = await r.disk.file(path)
  if (file.kind === 'problem') throw new Unshown(`${path} cannot be watched: ${file.why}`)
  if (file.kind !== 'file') refuse(r, `there is no file ${path} to run`)
  await asSpelled(r, path)
  watch(r, path)
}
