// The content revision of an allowed root: one hash over every file git does not ignore, by its raw
// bytes. Whole or unavailable, never partial: what cannot be read for certain gives no revision, and
// with no revision nothing is verified. Only for roots a person allowed to run code: listing untracked
// files looks inside nested repositories, which the dock does nowhere else by default.
import type { EngineInterface } from 'claude-code'

import { gitHashRaw, gitRead } from '../safe-git'

export type Revision =
  | { ok: true; revision: string; hashes: Map<string, string>; head: string | null }
  | { ok: false; reason: string }

/** Past this, hashing on every change costs more than it tells. */
const MAX_FILES = 20_000

const no = (reason: string): Revision => ({ ok: false, reason })
const namesIn = (stdout: string) => stdout.split('\0').filter(Boolean)
const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** A path a check may be rooted at: absolute and on this machine. */
export const isLocalPath = (path: string) => /^[A-Za-z]:[\\/]/.test(path) || /^\/(?![\\/])/.test(path)
const isWindows = (path: string) => /^[A-Za-z]:/.test(path)

/** One spelling for a directory, so the root can be compared with what git calls the top. */
export const samePath = (a: string, b: string) => {
  const spell = (p: string) => {
    const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
    return isWindows(s) ? s.toLowerCase() : s
  }
  return spell(a) === spell(b)
}

/** Why git, fed this path on a line of its own, would hash another file or none; null for a plain path. */
export const oddPath = (path: string): string | null =>
  path.endsWith('/')
    ? 'a repository nested in it'
    : path.includes('\n') || path.endsWith('\r') || path.startsWith('"')
      ? 'a file name git would read differently'
      : path.includes('�')
        ? 'a file name that is not UTF-8'
        : /^(?:\/|[A-Za-z]:)|(?:^|\/)\.\.(?:\/|$)/.test(path)
          ? 'a path that leaves the repository'
          : null

type Present = { files: string[]; missing: string[] } | { problem: string }

/**
 * Which of the paths are regular files on disk, by listing each directory on the way and following no
 * link: hashing follows links, out of the repository or onto a share.
 */
async function presentFiles($: EngineInterface, root: string, paths: readonly string[]): Promise<Present> {
  const dirs = new Set<string>([''])
  for (const path of paths) for (let dir = parentOf(path); dir && !dirs.has(dir); dir = parentOf(dir)) dirs.add(dir)
  const byDepth = new Map<number, string[]>()
  for (const dir of dirs) {
    const depth = dir ? dir.split('/').length : 0
    byDepth.set(depth, [...(byDepth.get(depth) ?? []), dir])
  }
  const foldsCase = isWindows(root)
  const key = (name: string) => (foldsCase ? name.toLowerCase() : name)
  const listings = new Map<string, Map<string, { kind: string; isLink: boolean }>>()
  // A directory is listed only once its parent showed it to be a directory and no link.
  for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
    const open: string[] = []
    for (const dir of byDepth.get(depth) ?? []) {
      if (dir) {
        const entry = listings.get(parentOf(dir))?.get(key(baseOf(dir)))
        if (!entry) continue
        if (entry.isLink) return { problem: 'a link' }
        if (entry.kind !== 'dir') continue
      }
      open.push(dir)
    }
    for (let i = 0; i < open.length; i += 32) {
      const batch = open.slice(i, i + 32)
      const read = await Promise.all(batch.map(dir => $.fs.list(dir ? `${root}/${dir}` : root)))
      for (let j = 0; j < batch.length; j++) {
        const entries = new Map<string, { kind: string; isLink: boolean }>()
        for (const entry of read[j] ?? []) {
          // Two names one case apart on a file system that folds case: which is hashed is not known.
          if (entries.has(key(entry.name))) return { problem: 'two names differing only in case' }
          entries.set(key(entry.name), { kind: entry.kind, isLink: entry.isLink })
        }
        listings.set(batch[j] as string, entries)
      }
    }
  }
  const files: string[] = []
  const missing: string[] = []
  for (const path of paths) {
    const entry = listings.get(parentOf(path))?.get(key(baseOf(path)))
    if (!entry) missing.push(path)
    else if (entry.isLink) return { problem: 'a link' }
    else if (entry.kind === 'dir') missing.push(path)
    else if (entry.kind !== 'file') return { problem: 'something that is not a regular file' }
    else files.push(path)
  }
  return { files, missing }
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

/** `info/exclude`, whose edits can hide a file from the listing; null where it cannot be read. */
async function readExclude($: EngineInterface, root: string): Promise<string | null> {
  const where = await gitRead($, root, ['rev-parse', '--git-path', 'info/exclude'])
  if (where.exitCode !== 0) return null
  const said = where.stdout.replace(/\r?\n$/, '')
  const path = isLocalPath(said) ? said : `${root}/${said}`
  if (/^[\\/]{2}/.test(said)) return null
  try {
    return String(await $.fs.read(path))
  } catch (err) {
    // No such file is an empty one; any other failure is not known.
    return /ENOENT|no such file/i.test(String(err)) ? '' : null
  }
}

/** The revision of `root`, which must be the top of a repository. Never throws. */
export async function readRevision($: EngineInterface, root: string): Promise<Revision> {
  try {
    if (!isLocalPath(root)) return no('not a folder on this machine')
    const top = await gitRead($, root, ['rev-parse', '--show-toplevel'])
    // Below the top, the listing and the hashing would resolve one path against two folders.
    if (top.exitCode !== 0 || !samePath(top.stdout.replace(/\r?\n$/, ''), root)) return no('not the top of a git repository')

    const [index, untracked, deleted, head, exclude] = await Promise.all([
      gitRead($, root, ['ls-files', '--stage', '-z']),
      gitRead($, root, ['ls-files', '--others', '--exclude-standard', '-z']),
      gitRead($, root, ['ls-files', '--deleted', '-z']),
      gitRead($, root, ['rev-parse', '--verify', '--quiet', 'HEAD']),
      readExclude($, root),
    ])
    for (const out of [index, untracked, deleted]) if (out.exitCode !== 0 || out.isStdoutTruncated) return no('git could not list it whole')
    if (exclude === null) return no('its exclude file cannot be read')

    const executable = new Set<string>()
    const all = new Set<string>()
    for (const row of namesIn(index.stdout)) {
      const m = /^(\d{6}) [0-9a-f]{40,64} (\d)\t([\s\S]+)$/.exec(row)
      if (!m) return no('git listed it in a form not understood')
      const [, mode, stage, path] = m as unknown as [string, string, string, string]
      if (stage !== '0') return no('a merge conflict')
      if (mode === '120000') return no('a link')
      if (mode === '160000') return no('a submodule')
      if (mode === '100755') executable.add(path)
      all.add(path)
    }
    for (const path of namesIn(untracked.stdout)) all.add(path)
    if (all.size > MAX_FILES) return no(`more than ${MAX_FILES} files`)
    const paths = [...all].sort()
    for (const path of paths) {
      const odd = oddPath(path)
      if (odd) return no(odd)
    }

    const present = await presentFiles($, root, paths)
    if ('problem' in present) return no(present.problem)
    // Absent from the disk must be absent to git as well, or an edit would go unseen.
    const gone = new Set(namesIn(deleted.stdout))
    if (present.missing.some(path => !gone.has(path))) return no('git and the disk disagree on which files exist')

    const hashes = new Map<string, string>()
    if (present.files.length > 0) {
      const out = await gitHashRaw($, root, present.files)
      const lines = out.stdout.trim().split(/\r?\n/)
      if (out.exitCode !== 0 || out.isStdoutTruncated || lines.length !== present.files.length) return no('its files could not all be hashed')
      for (let i = 0; i < lines.length; i++) {
        const hash = lines[i] as string
        if (!/^[0-9a-f]{40,64}$/.test(hash)) return no('git gave a hash not understood')
        const path = present.files[i] as string
        // The bit is part of the hash, so a task that changed only it still shows a change.
        hashes.set(path, executable.has(path) ? `${hash}+x` : hash)
      }
    }
    const body = JSON.stringify(['proof-revision-1', [...hashes], exclude])
    return { ok: true, revision: await sha256(body), hashes, head: head.exitCode === 0 ? head.stdout.trim() : null }
  } catch (err) {
    return no(/ENOENT|not found/i.test(String(err)) ? 'a file or git itself was not found while reading it' : 'it could not be read')
  }
}

/** What changed between two readings: each path with its hash after, null where it is gone. */
export const changedPaths = (from: ReadonlyMap<string, string>, to: ReadonlyMap<string, string>): { path: string; hash: string | null }[] => {
  const out: { path: string; hash: string | null }[] = []
  for (const [path, hash] of to) if (from.get(path) !== hash) out.push({ path, hash })
  for (const path of from.keys()) if (!to.has(path)) out.push({ path, hash: null })
  return out.sort((a, b) => (a.path < b.path ? -1 : 1))
}
