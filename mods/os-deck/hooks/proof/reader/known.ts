// All that is understood of commands. What is not here is never run by itself: a thing is added only
// with a run of the real program showing that it starts what is shown, and nothing else.

/**
 * Tools that run their own code, each with the words it needs first and the flags it may be given.
 * A flag that only asks for help or a version is absent on purpose: exit 0 would be a pass of nothing.
 */
export type Tool = { first?: readonly string[]; flags: readonly string[]; counts?: readonly string[]; projects?: readonly string[] }
export const TOOLS: ReadonlyMap<string, Tool> = new Map<string, Tool>([
  ['tsc', { flags: ['--noEmit', '--pretty', '--strict', '--skipLibCheck'], projects: ['-p', '--project'] }],
  ['vue-tsc', { flags: ['--noEmit'], projects: ['-p', '--project'] }],
  ['eslint', { flags: ['--quiet', '--no-warn-ignored', '--cache'], counts: ['--max-warnings'] }],
  ['prettier', { first: ['--check'], flags: [] }],
  ['biome', { first: ['check', 'lint'], flags: [] }],
  ['jest', { flags: ['--ci', '--runInBand', '-i', '--coverage', '--silent'] }],
  ['vitest', { first: ['run'], flags: ['--coverage'] }],
  ['vite', { first: ['build'], flags: [] }],
  ['pytest', { flags: ['-q', '-x', '-v'] }],
  ['ruff', { first: ['check'], flags: [] }],
  ['mypy', { flags: ['--strict'] }],
])
export const BUN_TEST_FLAGS: readonly string[] = ['--bail', '--coverage']

/** Read by a word of the grammar's own. */
export const UNDERSTOOD: readonly string[] = ['npm', 'node', 'bun', 'bash', 'sh', 'claude']
/** They start what a person was not shown: in no form are they a check. */
export const STARTS_OTHERS: readonly string[] = [
  'npx', 'pnpm', 'pnpx', 'yarn', 'yarnpkg', 'bunx', 'corepack', 'nodejs', 'cmd', 'powershell', 'pwsh', 'wsl', 'zsh', 'fish', 'dash', 'env', 'xargs', 'sudo', 'eval', 'exec',
  'cd', 'chdir', 'pushd', 'call', 'start', 'set', 'source', 'cross-env', 'cross-env-shell', 'concurrently', 'run-s', 'run-p', 'npm-run-all', 'turbo', 'nx', 'lerna', 'nodemon',
]

/** The keys of an .npmrc that say where packages come from or how much is printed, and nothing of what runs. */
export const NPMRC_HARMLESS: readonly string[] = [
  'registry', 'save-exact', 'save-prefix', 'engine-strict', 'fund', 'audit', 'update-notifier', 'package-lock', 'legacy-peer-deps', 'loglevel', 'progress',
]

/** In a folder a check runs in, and in those above it up to the root. */
export const MANIFESTS: readonly string[] = ['package.json', '.npmrc', 'bunfig.toml']
