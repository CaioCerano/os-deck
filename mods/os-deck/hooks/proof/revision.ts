// The content revision of an allowed root: one hash over every file git does not ignore, by its raw
// bytes. Whole or unavailable, never partial: what cannot be read for certain gives no revision, and
// with no revision nothing is verified. Only for roots a person allowed to run code: listing untracked
// files looks inside nested repositories, which the dock does nowhere else by default.
import type { EngineInterface } from 'claude-code'

import { gitHashRaw, gitRead, namesIn } from '../safe-git'
import { foldCase, isWindowsOddName, slashed } from './names'
import { sha256 } from './values'

export type Revision =
  | { ok: true; revision: string; hashes: Map<string, string>; head: string | null }
  | { ok: false; reason: string }

/** Past this, hashing on every change costs more than it tells. */
const MAX_FILES = 20_000

const no = (reason: string): Revision => ({ ok: false, reason })
const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/** A path a check may be rooted at: absolute and on this machine. */
export const isLocalPath = (path: string) => /^[A-Za-z]:[\\/]/.test(path) || /^\/(?![\\/])/.test(path)
const isWindows = (path: string) => /^[A-Za-z]:/.test(path)

/** One spelling of a directory: git's and the engine's differ in slashes and, on Windows, in case. */
export const spellRoot = (path: string) => {
  const s = slashed(path).replace(/\/+$/, '')
  return isWindows(s) ? foldCase(s) : s
}

export const samePath = (a: string, b: string) => spellRoot(a) === spellRoot(b)

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

/** `listed` as git spells it, `actual` as the disk does: what is hashed and what is recorded. */
type Present = { files: { listed: string; actual: string }[]; missing: string[] } | { problem: string }

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
  const key = (name: string) => (foldsCase ? foldCase(name) : name)
  const listings = new Map<string, Map<string, { name: string; kind: string; isLink: boolean }>>()
  const spelled = new Map<string, string>([['', '']])
  // A directory is listed only once its parent showed it to be a directory and no link.
  for (const depth of [...byDepth.keys()].sort((a, b) => a - b)) {
    const open: string[] = []
    for (const dir of byDepth.get(depth) ?? []) {
      if (dir) {
        const entry = listings.get(parentOf(dir))?.get(key(baseOf(dir)))
        if (!entry) continue
        if (entry.isLink) return { problem: 'a link' }
        if (entry.kind !== 'dir') continue
        const up = spelled.get(parentOf(dir)) ?? parentOf(dir)
        spelled.set(dir, up ? `${up}/${entry.name}` : entry.name)
      }
      open.push(dir)
    }
    for (let i = 0; i < open.length; i += 32) {
      const batch = open.slice(i, i + 32)
      const read = await Promise.all(batch.map(dir => $.fs.list(dir ? `${root}/${dir}` : root)))
      for (let j = 0; j < batch.length; j++) {
        const entries = new Map<string, { name: string; kind: string; isLink: boolean }>()
        for (const entry of read[j] ?? []) {
          // Git lists nothing inside one, wherever it is.
          if (batch[j] !== '' && entry.name.toLowerCase() === '.git') return { problem: 'a repository nested in it' }
          // Two names one case apart on a file system that folds case: which is hashed is not known.
          if (entries.has(key(entry.name))) return { problem: 'two names differing only in case' }
          entries.set(key(entry.name), { name: entry.name, kind: entry.kind, isLink: entry.isLink })
        }
        listings.set(batch[j] as string, entries)
      }
    }
  }
  const files: { listed: string; actual: string }[] = []
  const missing: string[] = []
  for (const path of paths) {
    const entry = listings.get(parentOf(path))?.get(key(baseOf(path)))
    if (!entry) missing.push(path)
    else if (entry.isLink) return { problem: 'a link' }
    // A folder where the file was: gone, and git does not call that deleted.
    else if (entry.kind === 'dir') continue
    else if (entry.kind !== 'file') return { problem: 'something that is not a regular file' }
    else {
      const up = spelled.get(parentOf(path)) ?? parentOf(path)
      files.push({ listed: path, actual: up ? `${up}/${entry.name}` : entry.name })
    }
  }
  // An ignore file can hide itself with what it hides, so it is in by being on the disk.
  const taken = new Set(files.map(f => key(f.actual)))
  for (const [dir, entries] of listings) {
    const entry = entries.get('.gitignore')
    if (!entry || entry.kind === 'dir') continue
    if (entry.isLink) return { problem: 'a link' }
    if (entry.kind !== 'file') return { problem: 'something that is not a regular file' }
    const up = spelled.get(dir) ?? dir
    const actual = up ? `${up}/${entry.name}` : entry.name
    if (!taken.has(key(actual))) files.push({ listed: actual, actual })
  }
  return { files, missing }
}

/** `info/exclude`, whose edits can hide a file from the listing; null where it cannot be read. */
async function readExclude($: EngineInterface, root: string): Promise<string | null> {
  const where = await gitRead($, root, ['rev-parse', '--git-path', 'info/exclude'])
  if (where.exitCode !== 0) return null
  const said = where.stdout.replace(/\r?\n$/, '')
  const path = isLocalPath(said) ? said : `${root}/${said}`
  if (/^[\\/]{2}/.test(said)) return null
  try {
    const text = String(await $.fs.read(path))
    // Bytes not UTF-8 all read as one character: an edit among them would not show.
    return text.includes('\ufffd') ? null : text
  } catch (err) {
    // No such file is an empty one; any other failure is not known.
    return /ENOENT|no such file/i.test(String(err)) ? '' : null
  }
}

/** Config a person or the machine set; any other scope is the repository's. */
const TRUSTED_SCOPES = new Set(['system', 'global'])

type Scan = { files: { listed: string; actual: string }[]; executable: Set<string>; exclude: string; same: string }

/** All that decides which files are hashed, read whole. */
async function scan($: EngineInterface, root: string): Promise<Scan | { problem: string }> {
  // Long paths are otherwise skipped with a warning; folded case hides a file beside its namesake.
  const config = ['core.longpaths=true', ...(isWindows(root) ? [] : ['core.ignorecase=false'])]
  const [index, untracked, deleted, pointed, exclude] = await Promise.all([
    gitRead($, root, ['ls-files', '--stage', '-z'], config),
    gitRead($, root, ['ls-files', '--others', '--exclude-standard', '-z'], config),
    gitRead($, root, ['ls-files', '--deleted', '-z'], config),
    gitRead($, root, ['config', '--show-scope', '--get-all', 'core.excludesFile']),
    readExclude($, root),
  ])
  // Git exits 0 having skipped a folder it could not open, and says so on stderr alone.
  for (const out of [index, untracked, deleted]) if (out.exitCode !== 0 || out.isStdoutTruncated || out.stderr.trim()) return { problem: 'git could not list it whole' }
  if (pointed.exitCode > 1 || pointed.isStdoutTruncated) return { problem: 'its git config cannot be read' }
  if (pointed.exitCode === 0)
    for (const row of pointed.stdout.split('\n'))
      if (row.trim() && !TRUSTED_SCOPES.has(row.split(/\s/)[0] ?? '')) return { problem: 'an ignore file set in its git config' }
  if (exclude === null) return { problem: 'its exclude file cannot be read' }

  const executable = new Set<string>()
  const all = new Set<string>()
  for (const row of namesIn(index.stdout)) {
    const m = /^(\d{6}) [0-9a-f]{40,64} (\d)\t([\s\S]+)$/.exec(row)
    if (!m) return { problem: 'git listed it in a form not understood' }
    const [, mode, stage, path] = m as unknown as [string, string, string, string]
    if (stage !== '0') return { problem: 'a merge conflict' }
    if (mode === '120000') return { problem: 'a link' }
    if (mode === '160000') return { problem: 'a submodule' }
    if (mode === '100755') executable.add(path)
    all.add(path)
  }
  for (const path of namesIn(untracked.stdout)) all.add(path)
  if (all.size > MAX_FILES) return { problem: `more than ${MAX_FILES} files` }
  const paths = [...all].sort()
  for (const path of paths) {
    const odd = oddPath(path)
    if (odd) return { problem: odd }
    if (isWindows(root) && (path.includes('\\') || path.split('/').some(isWindowsOddName))) return { problem: 'a file name Windows reads differently' }
  }

  const present = await presentFiles($, root, paths)
  if ('problem' in present) return present
  // Absent from the disk must be absent to git as well, or an edit would go unseen.
  const gone = new Set(namesIn(deleted.stdout))
  if (present.missing.some(path => !gone.has(path))) return { problem: 'git and the disk disagree on which files exist' }
  const files = [...present.files].sort((a, b) => (a.actual < b.actual ? -1 : 1))
  return { files, executable, exclude, same: JSON.stringify([files, [...executable].sort(), exclude]) }
}

/** The revision of `root`, which must be the top of a repository. Never throws. */
export async function readRevision($: EngineInterface, root: string): Promise<Revision> {
  try {
    if (!isLocalPath(root)) return no('not a folder on this machine')
    const top = await gitRead($, root, ['rev-parse', '--show-toplevel'])
    // Below the top, the listing and the hashing would resolve one path against two folders.
    if (top.exitCode !== 0 || !samePath(top.stdout.replace(/\r?\n$/, ''), root)) return no('not the top of a git repository')
    const head = await gitRead($, root, ['rev-parse', '--verify', '--quiet', 'HEAD'])

    const first = await scan($, root)
    if ('problem' in first) return no(first.problem)
    const hashes = new Map<string, string>()
    if (first.files.length > 0) {
      const out = await gitHashRaw($, root, first.files.map(f => f.actual))
      const lines = out.stdout.trim().split(/\r?\n/)
      if (out.exitCode !== 0 || out.isStdoutTruncated || lines.length !== first.files.length) return no('its files could not all be hashed')
      for (let i = 0; i < lines.length; i++) {
        const hash = lines[i] as string
        if (!/^[0-9a-f]{40,64}$/.test(hash)) return no('git gave a hash not understood')
        const file = first.files[i] as { listed: string; actual: string }
        // The bit is part of the hash, so a task that changed only it still shows a change.
        hashes.set(file.actual, first.executable.has(file.listed) ? `${hash}+x` : hash)
      }
    }
    // Looked at again: a folder can become a link, or a file appear, while it is hashed.
    const second = await scan($, root)
    if ('problem' in second) return no(second.problem)
    if (second.same !== first.same) return no('it changed while being read')

    const body = JSON.stringify(['proof-revision-2', [...hashes], first.exclude])
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
