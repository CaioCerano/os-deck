// Reading a repository must not run it. The dock reads git with nobody asked, and a repository can make
// any command that reads a working-tree file's content start a program: its own filters, or the person's
// filters reading its config (Git LFS extensions). Switching those off by name cannot be made complete,
// so no command here reads such content. That rules out `status`, `diff-files`, `ls-files -m` and any
// rename detection, and with them a count of modified files: do not add one back.
import type { EngineInterface } from 'claude-code'

import { parseAheadBehind } from './core'

// No index lock: a refresh must not make the person's own commit or rebase fail. No implicit bare
// repository: a folder of a clone can be laid out as one, its config arriving with the clone.
const GIT = ['git', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'safe.bareRepository=explicit'] as const
// No fetch of a partial clone's missing objects: the remote's transport is a command of the repository's choosing.
const NO_FETCH = { GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'none' }

export type RepoState = { branch: string; ahead: number; behind: number; staged: number; untracked: number; conflicts: number }

export function gitRead($: EngineInterface, dir: string, args: readonly string[]) {
  return $.process.run([...GIT, '-C', dir, ...args], { timeoutMs: 8000, env: NO_FETCH })
}

const namesIn = (stdout: string) => stdout.split('\0').filter(Boolean)

/** Branch, upstream distance, staged, untracked and conflicts, from refs, the index and directory listings. */
export async function readRepoState($: EngineInterface, dir: string): Promise<RepoState | null> {
  const head = await gitRead($, dir, ['symbolic-ref', '--quiet', 'HEAD'])
  // Exit 1 is a detached head.
  if (head.exitCode > 1) return null
  const [staged, untracked, unmerged, upstream] = await Promise.all([
    gitRead($, dir, ['diff-index', '--cached', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=dirty', '--diff-filter=u', '-z', 'HEAD', '--']),
    gitRead($, dir, ['ls-files', '--others', '--exclude-standard', '--directory', '--no-empty-directory', '-z']),
    gitRead($, dir, ['ls-files', '--unmerged', '-z']),
    gitRead($, dir, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD', '--']),
  ])
  if (untracked.exitCode !== 0 || unmerged.exitCode !== 0) return null
  // Before the first commit there is no HEAD to compare with: all in the index is staged.
  const inIndex = staged.exitCode === 0 ? staged : await gitRead($, dir, ['ls-files', '--cached', '-z'])
  if (inIndex.exitCode !== 0) return null
  const distance = upstream.exitCode === 0 ? parseAheadBehind(upstream.stdout) : null
  return {
    branch: head.exitCode === 0 ? head.stdout.trim().replace(/^refs\/heads\//, '') : 'detached',
    ahead: distance?.ahead ?? 0,
    behind: distance?.behind ?? 0,
    staged: namesIn(inIndex.stdout).length,
    untracked: namesIn(untracked.stdout).length,
    conflicts: new Set(namesIn(unmerged.stdout).map(line => line.slice(line.indexOf('\t') + 1))).size,
  }
}
