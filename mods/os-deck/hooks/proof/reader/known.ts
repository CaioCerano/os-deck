// What is known of runners, shells and tools: tables, and nothing that decides.

/** Shown whole for the runner that reads them. */
export const CONFIG: Readonly<Record<string, readonly string[]>> = {
  npm: ['.npmrc'],
  pnpm: ['.npmrc', 'pnpm-workspace.yaml'],
  yarn: ['.npmrc', '.yarnrc', '.yarnrc.yml'],
  bun: ['bunfig.toml'],
  claude: ['bunfig.toml'],
  make: ['GNUmakefile', 'Makefile'],
  just: ['justfile', '.justfile'],
  composer: ['composer.json'],
  deno: ['deno.json', 'deno.jsonc'],
}
// Each is watched in a folder a check runs in, and in those above it up to the root: all that can be shown included.
export const MANIFESTS = [...new Set(['package.json', 'tsconfig.json', ...Object.values(CONFIG).flat()])]
/** Loaded by the runner itself, where there is one. */
export const LOADED: Readonly<Record<string, readonly string[]>> = { yarn: ['.pnp.cjs', '.pnp.loader.mjs'], pnpm: ['.pnpmfile.cjs'] }
/** Read for what they set, and never shown: their values are the person's secrets. */
export const ENV_FILES: Readonly<Record<string, readonly string[]>> = {
  bun: ['.env', '.env.local', '.env.test', '.env.test.local', '.env.development', '.env.development.local', '.env.production', '.env.production.local'],
  yarn: ['.env.yarn', '.corepack.env'],
  pnpm: ['.corepack.env'],
}
// With one of these set, the bodies shown are not what runs, or not how it runs.
export const NPMRC_REDIRECTS: readonly string[] = [
  'workspace', 'workspaces', 'include-workspace-root', 'prefix', 'local-prefix', 'dir', 'recursive', 'filter', 'script-shell', 'shell', 'shell-emulator',
  'w', 'ws', 'iwr', 'c', 'g', 'global', 'location', 'workspace-root', 'call', 'package', 'userconfig', 'globalconfig', 'npm-path', 'scripts-prepend-node-path', 'verify-deps-before-run', 'onload-script', 'modules-dir',
]
export const PNPM_REDIRECTS = /\b(?:scriptShell|script-shell|node-options|nodeOptions|shellEmulator|npmPath|verifyDepsBeforeRun|modulesDir)\b/
export const YARN_REDIRECTS = /(?:^|[\s{,."'-])(?:cwd|script-shell|modules-folder|injectEnvironmentFiles)\b/i
export const YARN_PATH = /\byarn-?path["']?[\s:]+(?:"([^"]+)"|'([^']+)'|([^\s"',{}*&|>!]+))/i
export const CODE_IN_TEXT = /[\w.@/-]{1,200}\.[cm]?js\b/g

export const RUN_WORDS: Readonly<Record<string, readonly string[]>> = { npm: ['run', 'run-script', 'rum', 'urn'], pnpm: ['run', 'run-script'], yarn: ['run'], bun: ['run'] }
export const SHORT_RUNS: Readonly<Record<string, readonly string[]>> = { npm: ['test', 't', 'tst', 'start', 'stop'], pnpm: ['test', 't', 'start'], yarn: ['test'], bun: [] }
/** A runner's words that start another program, named after them. */
export const EXEC_WORDS: Readonly<Record<string, readonly string[]>> = { npm: ['exec', 'x'], pnpm: ['exec', 'dlx'], yarn: ['exec', 'dlx'], bun: ['x'] }
// A runner's own commands, some of which run scripts of other names or folders.
export const RUNNER_OWN = /^(?:install|i|ci|c|add|a|update|up|upgrade|remove|rm|link|publish|pack|rebuild|rb|version|restart|it|workspaces?|recursive|multi|m|exec|create|init|deploy|import|prune|dedupe|setup|pm|patch|prepare|pnp|set|config|env|install-test|clean-install|ic|fetch|approve-builds|self-update)$/
export const RUNNER_FLAGS: readonly string[] = ['-s', '--silent', '-q', '--quiet', '--if-present']
export const NPX_FLAGS: readonly string[] = ['-y', '--yes', '--no', '--no-install', '--silent', '-q', '--quiet', '--bun']
export const RUN_ALL_FLAGS = /^(?:-[clnrsp]|--(?:print-label|print-name|continue-on-error|race|silent|aggregate-output|serial|sequential|parallel))$/

/** Words that are a package runner, by any of its names. */
export const RUNNER = /^(?:npm|npx|pnpm|pnpx|yarn|yarnpkg|yarn-berry|bun|bunx|bun-debug|bun-profile|corepack|run-s|run-p|run-z|npm-run-all2?|concurrently|ni|nr|nun|nlx)(?:-cli)?(?:\.(?:[cm]?js|ps1))?$/
/** Where a runner's own code lives. */
export const RUNNER_FILE = /(?:^|[\\/])node_modules[\\/](?:npm|pnpm|yarn|corepack|npm-run-all2?|concurrently|turbo|nx|lerna|wireit)(?:[\\/]|$)/i
// They start commands this does not read.
export const RUNS_OTHERS: readonly string[] = [
  'cd', 'chdir', 'pushd', 'popd', 'call', 'start', 'cmd', 'powershell', 'pwsh', 'eval', 'exec', 'source', '.', 'env', 'xargs', 'sudo', 'nohup', 'nice', 'time', 'timeout',
  'command', 'builtin', 'forfiles', 'if', 'for', 'while', 'set', 'export', 'alias', 'doskey', 'path', 'find', 'wsl', 'fish', 'cross-env-shell', 'env-cmd', 'dotenv', 'dotenvx',
  'trap', 'coproc', 'function', 'hash', 'declare', 'enable', 'unset', 'case', 'select', 'until', 'then', 'do', 'else', 'elif',
  'turbo', 'nx', 'lerna', 'wireit', 'wsrun', 'rush', 'moon', 'lage', 'nodemon', 'husky', 'lint-staged', 'shx', 'start-server-and-test', 'npm-watch', 'onchange', 'execa',
]
// Neither start code of the repository's naming nor read any.
export const INERT: readonly string[] = ['echo', 'exit', 'true', 'false', 'rimraf', 'rm', 'del', 'mkdir', 'mkdirp']
export const BUILT_IN: readonly string[] = ['echo', 'exit', 'cd', 'mkdir', 'del']
// Tools known to run their own code, and tests as tests are run.
export const TOOLS: readonly string[] = [
  'jest', 'vitest', 'mocha', 'ava', 'tap', 'jasmine', 'playwright', 'tsd', 'tsc', 'vue-tsc', 'svelte-check', 'astro', 'eslint', 'biome', 'oxlint', 'prettier', 'stylelint',
  'standard', 'xo', 'knip', 'cspell', 'markdownlint', 'publint', 'vite', 'next', 'rollup', 'webpack', 'esbuild', 'pytest', 'ruff', 'mypy', 'pyright', 'flake8', 'black', 'shellcheck',
]
// With a name and an equals sign before it, sh sets a variable and cmd starts the name.
export const STARTS_CODE = /^(?:node|nodejs|bash|sh|python3?|py|claude|make|just|composer|deno|cross-env|tsx|ts-node|ruby|perl|php)$/
export const PYTHON_MODULES: readonly string[] = ['pytest', 'unittest', 'mypy', 'ruff', 'flake8', 'black', 'pyright']
export const FILE_HOSTS: readonly string[] = ['tsx', 'ts-node', 'ruby', 'perl', 'php']

export const NODE_PLAIN = /^(?:--(?:no-warnings|no-deprecation|trace-warnings|trace-deprecation|enable-source-maps|expose-gc|check|experimental-vm-modules|experimental-strip-types|experimental-transform-types|experimental-test-coverage|test-only|test-force-exit)|--(?:max-old-space-size|stack-size|test-concurrency|test-timeout)=\d+|--(?:test-name-pattern|test-reporter-destination)=.+)$/
export const NODE_CODE: readonly string[] = ['-r', '--require', '--import', '--loader', '--experimental-loader', '--test-reporter']
export const NODE_EXTS = ['.js', '.cjs', '.mjs', '.json', '.node', '.ts', '.tsx', '.cts', '.mts', '.jsx']
/** What cmd would start from the folder it is in, before anything on the PATH. */
export const WINDOWS_EXTS = ['.com', '.exe', '.bat', '.cmd', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msc']
export const CODE_FILE = /\w\.(?:[cm]?[jt]sx?|sh|bash|py|rb|pl|php|ps1|bat|cmd)$/i
export const WRITTEN_AFTER: readonly string[] = ['-o', '--out', '--outfile', '--outFile', '--out-file', '--output', '--output-file', '--outputFile']
export const CODE_AFTER: readonly string[] = ['--require', '--import', '--loader', '--preload', '--config', '--rcfile', '--setupFiles', '--setupFilesAfterEach', '--setupFilesAfterEnv', '--globalSetup']
export const SHORT_CODE_AFTER: readonly string[] = ['-r', '-c']

export const SAFE_ENV: readonly string[] = ['NODE_ENV', 'BABEL_ENV', 'CI', 'FORCE_COLOR', 'NO_COLOR', 'TZ', 'LANG', 'LC_ALL', 'PORT', 'NODE_NO_WARNINGS']
export const CHANGES_WHAT_RUNS = /^(?:(?:npm_|yarn_|pnpm_|bun_|corepack_|node_|ld_|dyld_)|(?:path|pathext|bash_env|env|comspec|cdpath|ifs|shell|shellopts|bashopts|home|userprofile|appdata|xdg_config_home|pythonpath|pythonstartup|pythonhome|perl5opt|rubyopt)$)/i
