// What runs, by the bytes on the disk. It starts no process, git included, as it is read before any
// press; it knows no ignore rule, as a file git does not list runs the same; and it follows no link.
// What cannot be known is never "unchanged".
import type { EngineInterface } from 'claude-code'

import { foldCase, isWindowsOddName, slashed } from './names'
import { sha256 } from './values'

export type Watched = readonly (readonly [path: string, hash: string | null])[]

export type WatchRead = {
  /** Each path that could be read, with its hash; null where there is no file by that name. */
  watched: [path: string, hash: string | null][]
  /** Size and time of each file, to see one changed and put back. */
  stamps: Map<string, string>
  problems: [path: string, why: string][]
}

export type Entry = { name: string; kind: string; size: number; mtimeMs?: number; isLink: boolean }
export type DiskFile = { kind: 'file'; bytes: Uint8Array; hash: string; stamp: string } | { kind: 'absent' } | { kind: 'problem'; why: string }

/** The engine answers no read over 4 MiB, and one byte more has to be asked to see a file is larger. */
const MAX_BYTES = 4 * 1024 * 1024 - 1

/** A name as it is matched: programs load `Package.json` for `package.json` where the disk folds case. */
export const keyOf = foldCase
export const joined = (dir: string, name: string) => (dir && name ? `${dir}/${name}` : dir || name)

/** A step Windows would open as another name, or that is no name. */
const isOddStep = (step: string) => step === '' || step === '.' || step === '..' || step.includes('\\') || isWindowsOddName(step) || /~\d/.test(step)

/** A path as typed from a folder of the root, as one from the root. */
export const pathFrom = (root: string, dir: string, value: string): { path: string } | 'outside' | 'unclear' => {
  let v = slashed(value, root)
  if (v === '') return 'unclear'
  const top = slashed(root).replace(/\/+$/, '')
  const fold = (s: string) => (/^[A-Za-z]:/.test(top) ? foldCase(s) : s)
  let steps = dir ? dir.split('/') : []
  if (top && fold(`${v}/`).startsWith(`${fold(top)}/`)) {
    v = v.slice(top.length + 1)
    steps = []
  } else if (/^(?:\/|[A-Za-z]:)/.test(v)) return 'outside'
  let named = 0
  for (const step of v.split('/')) {
    if (step === '' || step === '.') continue
    if (step === '..') {
      // Back out of a step the value itself named: were that a link, two programs would read it as two places.
      if (named > 0) return 'unclear'
      if (steps.pop() === undefined) return 'outside'
    } else if (isOddStep(step)) return 'unclear'
    else {
      steps.push(step)
      named += 1
    }
  }
  return { path: steps.join('/') }
}

/** Ends a path that means a program's name with whatever extension, which is what a shell takes. */
export const ANY_EXT = '.*'

/** A path of a folder above the root is written `<folder>|<steps below it>`. Off Windows a folder's name can hold that mark, the steps never: the last is the one meant. */
export const aboveRoot = (folder: string, rest: string) => `${/^[A-Za-z]:$|^$/.test(folder) ? `${folder}/` : folder}|${rest}`
const isAbove = (path: string) => /^(?:\/(?!\/)|[A-Za-z]:\/)[\s\S]*\|/.test(path)
const belowFolder = (path: string) => {
  const cut = path.lastIndexOf('|')
  return { folder: path.slice(0, cut), rest: path.slice(cut + 1) }
}
/** Where the disk is asked: such a folder by itself, anything else from the root. */
const isWhole = (at: string) => /^(?:\/|[A-Za-z]:\/)/.test(at)

/** The folders above a root, up to the drive's. */
export const foldersAbove = (root: string): string[] => {
  const out: string[] = []
  let at = slashed(root).replace(/\/+$/, '')
  while (at.includes('/')) {
    at = at.slice(0, at.lastIndexOf('/'))
    out.push(at)
  }
  return out
}

export type Disk = {
  /** A folder's entries; null where it is not a folder that can be read without following a link. */
  list: (dir: string) => Promise<readonly Entry[] | null>
  file: (path: string) => Promise<DiskFile>
}

/**
 * The files under a root, each read once: what is parsed from a reading and what is hashed are the
 * same bytes. One of these serves one reading, never two.
 */
export function openDisk($: EngineInterface, root: string): Disk {
  const listings = new Map<string, Promise<readonly Entry[] | null>>()
  const files = new Map<string, Promise<DiskFile>>()
  const problem = (why: string): DiskFile => ({ kind: 'problem', why })
  const onWindows = /^[A-Za-z]:/.test(root)
  const placeOf = (at: string) => (isWhole(at) ? at : at ? `${root}/${at}` : root)

  const entriesOf = (at: string) => {
    const known = listings.get(at)
    if (known) return known
    const read = (async (): Promise<readonly Entry[] | null> => {
      try {
        return await $.fs.list(placeOf(at))
      } catch {
        return null
      }
    })()
    listings.set(at, read)
    return read
  }

  /** The entry a path names, each step a folder and no link, with the spelling the disk has. */
  const find = async (path: string): Promise<{ at: string; entry: Entry } | DiskFile> => {
    // A folder above the root is reached as the root is; the steps watched begin below it.
    const above = isAbove(path) ? belowFolder(path) : null
    const steps = (above ? above.rest : path).split('/')
    let at = above ? above.folder : ''
    for (let i = 0; i < steps.length; i++) {
      const entries = await entriesOf(at)
      if (!entries) return problem('its folder cannot be read')
      const step = keyOf(steps[i] as string)
      const found = entries.filter(x => keyOf(x.name) === step)
      if (found.length > 1) return problem('two names differ only in case')
      const entry = found[0]
      if (!entry) return { kind: 'absent' }
      // Never taken for it: a folder of Windows can be case-sensitive, and there it is another file.
      if (entry.name !== steps[i]) return problem('it is there in another case')
      if (entry.isLink) return problem('it is a link')
      // The top folder is written with its slash.
      const here = at.endsWith('/') ? `${at}${entry.name}` : joined(at, entry.name)
      if (i === steps.length - 1) return { at: here, entry }
      if (entry.kind === 'file') return { kind: 'absent' }
      if (entry.kind !== 'dir') return problem('it is no regular file')
      at = here
    }
    return { kind: 'absent' }
  }

  const readBytes = async (at: string, is: { size: number; mtimeMs?: number }): Promise<DiskFile> => {
    if (is.size > MAX_BYTES) return problem('it is too large to read whole')
    const { base64 } = await $.fs.read(placeOf(at), { as: 'bytes', length: MAX_BYTES + 1 })
    const bytes = Uint8Array.from(atob(base64), ch => ch.charCodeAt(0))
    if (bytes.length > MAX_BYTES) return problem('it is too large to read whole')
    return { kind: 'file', bytes, hash: await sha256(bytes), stamp: `${is.size}:${is.mtimeMs}` }
  }

  /** All that a program's name can start in one folder: the name, with any extension or none. */
  const readPrograms = async (path: string): Promise<DiskFile> => {
    const cut = path.lastIndexOf('/')
    const dir = path.slice(0, cut)
    const name = keyOf(path.slice(cut + 1))
    const folder = await find(dir)
    if (!('entry' in folder)) return folder
    // A link for the folder would be followed by whoever starts it.
    if (folder.entry.kind !== 'dir') return { kind: 'absent' }
    const entries = await entriesOf(folder.at)
    if (!entries) return problem('its folder cannot be read')
    const found: [name: string, is: string, stamp: string][] = []
    for (const entry of entries) {
      const key = keyOf(entry.name)
      if (key !== name && !key.startsWith(`${name}.`)) continue
      const at = folder.at.endsWith('/') ? `${folder.at}${entry.name}` : joined(folder.at, entry.name)
      if (entry.isLink) {
        // npm installs links only off Windows. On it none is followed: this runs before any press, and one
        // can lead to a share, which takes the person's login.
        if (onWindows) return problem('it is a link')
        // Where one leads, and the bytes there, are what it is.
        const to = await $.fs.stat(placeOf(at), { resolve: true })
        const { realPath } = to
        if (!realPath || /^[\\/]{2}/.test(realPath) || to.kind !== 'file') return problem('where its link leads cannot be told')
        const read = await readBytes(at, to)
        if (read.kind !== 'file') return read
        found.push([entry.name, `link ${realPath} ${read.hash}`, `${realPath} ${read.stamp}`])
        continue
      }
      // By the entry, not by its path: that could be this pattern again, or a step above the root.
      const read = entry.kind === 'file' ? await readBytes(at, entry) : { kind: 'absent' as const }
      if (read.kind === 'problem') return read
      found.push(read.kind === 'file' ? [entry.name, read.hash, read.stamp] : [entry.name, entry.kind, ''])
    }
    if (found.length === 0) return { kind: 'absent' }
    found.sort((a, b) => (a[0] < b[0] ? -1 : 1))
    const hash = await sha256(JSON.stringify(found.map(([n, is]) => [n, is])))
    return { kind: 'file', bytes: new Uint8Array(0), hash, stamp: found.map(x => x[2]).join(' ') }
  }

  const readFile = async (path: string): Promise<DiskFile> => {
    try {
      if ((isAbove(path) ? belowFolder(path).rest : path).split('/').some(isOddStep)) return problem('a path not understood')
      if (path.endsWith(ANY_EXT)) return await readPrograms(path.slice(0, -ANY_EXT.length))
      const found = await find(path)
      if (!('entry' in found)) return found
      const { at, entry } = found
      if (entry.kind === 'dir') return { kind: 'absent' }
      if (entry.kind !== 'file') return problem('it is no regular file')
      return await readBytes(at, entry)
    } catch {
      return problem('it cannot be read')
    }
  }

  return {
    async list(dir) {
      if (dir === '') return entriesOf('')
      if (dir.split('/').some(isOddStep)) return null
      const found = await find(dir)
      return 'entry' in found && found.entry.kind === 'dir' ? entriesOf(found.at) : null
    },
    file(path) {
      const key = path
      const known = files.get(key)
      if (known) return known
      const read = readFile(path)
      files.set(key, read)
      return read
    },
  }
}

/** Each path as an open disk has it. */
export const readFrom = async (disk: Disk, paths: readonly string[]): Promise<WatchRead> => {
  const out: WatchRead = { watched: [], stamps: new Map(), problems: [] }
  const found = await Promise.all(paths.map(path => disk.file(path)))
  found.forEach((file, i) => {
    const path = paths[i] as string
    if (file.kind === 'problem') out.problems.push([path, file.why])
    else out.watched.push([path, file.kind === 'file' ? file.hash : null])
    if (file.kind === 'file') out.stamps.set(path, file.stamp)
  })
  return out
}

/** The raw bytes of each path, as a hash. Never throws. */
export async function readWatched($: EngineInterface, root: string, paths: readonly string[]): Promise<WatchRead> {
  return readFrom(openDisk($, root), paths)
}

/**
 * The paths that are not as they were. `since`, an earlier reading's stamps, also finds one that was
 * written meanwhile and holds the same bytes again.
 */
export const changedSince = (watched: Watched, now: WatchRead, since?: ReadonlyMap<string, string>): string[] => {
  const hashes = new Map(now.watched)
  return watched.filter(([path, hash]) => hashes.get(path) !== hash || (since !== undefined && since.get(path) !== now.stamps.get(path))).map(([path]) => path)
}

/** The watched paths that differ on the disk, with whatever cannot be read counted as changed. Never throws. */
export async function changedOnDisk($: EngineInterface, root: string, watched: Watched): Promise<string[]> {
  try {
    return changedSince(watched, await readWatched($, root, watched.map(([path]) => path)))
  } catch {
    return watched.map(([path]) => path)
  }
}
