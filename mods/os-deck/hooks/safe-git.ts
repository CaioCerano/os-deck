// Reading a repository must not run it. The dock reads git with nobody asked, at session start and in
// every repository beneath a workspace, and a repository's own config can name programs: `git status`
// runs its clean and process filters. The engine already turns repository hooks off; this does the rest.
import type { EngineInterface } from 'claude-code'

// Never take .git/index.lock: a refresh must not make the person's own commit or rebase fail.
const GIT = ['git', '--no-optional-locks', '-c', 'core.fsmonitor=false'] as const
// No fetch of a partial clone's missing objects: the remote's transport is a command of the repository's choosing.
const NO_FETCH = { GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'none' }
/** Config the person or the machine set; any other scope is the repository's. */
const TRUSTED_SCOPES = new Set(['system', 'global', 'command'])

/**
 * The environment that blanks every filter the repository's own config defines, from
 * `git config --show-scope --null --name-only` output (scope, name, scope, name…). By environment,
 * not `-c`: a filter's name may hold `=`.
 */
export const filterOverrides = (listing: string): Record<string, string> => {
  const fields = listing.split('\0')
  const names = new Set<string>()
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (TRUSTED_SCOPES.has(fields[i] ?? '')) continue
    const name = /^filter\.([\s\S]*)\.(?:clean|smudge|process)$/i.exec(fields[i + 1] ?? '')?.[1]
    if (name !== undefined) names.add(name)
  }
  if (names.size === 0) return {}
  const pairs = [...names].flatMap(n => [
    [`filter.${n}.clean`, ''],
    [`filter.${n}.smudge`, ''],
    [`filter.${n}.process`, ''],
    [`filter.${n}.required`, 'false'],
  ])
  return Object.fromEntries([['GIT_CONFIG_COUNT', String(pairs.length)], ...pairs.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]])])
}

/** A git read for commands that never read the working tree, so run no filter. */
export function gitRead($: EngineInterface, dir: string, args: readonly string[], env: Record<string, string> = {}) {
  return $.process.run([...GIT, '-C', dir, ...args], { timeoutMs: 8000, env: { ...NO_FETCH, ...env } })
}

/** `git status` with the repository's own filters off. Throws where its config cannot be read: no status then. */
export async function gitStatus($: EngineInterface, dir: string) {
  const found = await gitRead($, dir, ['config', '--show-scope', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process)$'])
  // Exit 1 is no match.
  if (found.exitCode > 1) throw new Error(`git config could not be read (exit ${found.exitCode})`)
  // A submodule's status runs under the submodule's config, so only its commit is compared.
  return gitRead($, dir, ['status', '--porcelain=v2', '--branch', '--ignore-submodules=dirty'], filterOverrides(found.stdout))
}
