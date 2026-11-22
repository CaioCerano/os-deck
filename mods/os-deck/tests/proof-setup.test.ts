import type { EngineInterface } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { checkProblem, grantFrom } from '../hooks/proof/grant'
import type { Draft, Setup } from '../hooks/proof/model'
import { detectChecks, draftFor, parseTypedCheck } from '../hooks/proof/setup'
import type { ProofCheck } from '../types'

// The contract, held by the type checker.
const setup: Setup = { detectChecks, parseTypedCheck, draftFor }

const ROOT = '/repo'
const chr = (code: number) => String.fromCodePoint(code)
// Fake, and put together here so no scanner takes it for a key.
const SECRET = ['ghp', 'A'.repeat(30)].join('_')

type Tree = Record<string, string>
type Odd = { links?: string[]; others?: string[]; sizes?: Record<string, number>; failList?: string[]; grown?: Record<string, string> }

/** A file system of `files`. It records what was read, and fails the test's expectations on any process. */
const world = (files: Tree, odd: Odd = {}) => {
  const seen = { reads: [] as string[], lists: [] as string[], lengths: [] as number[], ran: [] as string[] }
  const inRoot = (path: string) => (path === ROOT ? '' : path.slice(ROOT.length + 1))
  const ran = (what: string) => () => {
    seen.ran.push(what)
    throw new Error('setup must run nothing')
  }
  const $ = {
    process: { run: ran('run'), spawn: ran('spawn') },
    store: { get: ran('store.get'), set: ran('store.set') },
    fs: {
      list: async (path: string) => {
        const dir = inRoot(path)
        seen.lists.push(dir)
        if (odd.failList?.includes(dir)) throw new Error('EACCES')
        const prefix = dir ? `${dir}/` : ''
        const below = Object.keys(files).filter(p => p.startsWith(prefix))
        if (dir && below.length === 0) throw new Error('ENOENT')
        return [...new Set(below.map(p => p.slice(prefix.length).split('/')[0] as string))].map(name => {
          const at = prefix + name
          const isLink = odd.links?.includes(at) === true
          const kind = isLink || odd.others?.includes(at) ? 'other' : at in files ? 'file' : 'dir'
          return { name, kind, isLink, mtimeMs: 0, size: kind === 'file' ? (odd.sizes?.[at] ?? (files[at] as string).length) : 0 }
        })
      },
      read: async (path: string, options?: { length?: number }) => {
        const at = inRoot(path)
        seen.reads.push(at)
        seen.lengths.push(options?.length ?? Number.POSITIVE_INFINITY)
        const text = odd.grown?.[at] ?? files[at]
        if (text === undefined) throw new Error('ENOENT')
        return options?.length === undefined ? text : text.slice(0, options.length)
      },
    },
  } as unknown as EngineInterface
  return { $, seen }
}

const pkg = (scripts: Record<string, unknown>, more: Record<string, unknown> = {}) => JSON.stringify({ name: 'x', ...more, scripts })
const detect = async (files: Tree, odd?: Odd) => setup.detectChecks(world(files, odd).$, ROOT)
const commands = async (files: Tree, odd?: Odd) => (await detect(files, odd)).map(c => c.argv.join(' '))
const check = (over: Partial<ProofCheck> = {}): ProofCheck => ({ id: 'test', kind: 'test', description: 'tests', argv: ['npm', 'run', 'test'], dir: '', timeoutS: 60, required: true, ...over })
const draft = async (files: Tree, checks = [check()], odd?: Odd) => setup.draftFor(world(files, odd).$, ROOT, checks, 'detected')
const draftOf = (scripts: Record<string, unknown>, argv = ['npm', 'run', 'test'], more: Tree = {}) => draft({ 'package.json': pkg(scripts), ...more }, [check({ argv })])
/** A press on a draft, as the dock makes one. */
const press = (d: Draft, checks: readonly ProofCheck[] = d.checks) => {
  const pressed = { session: 'S', root: ROOT, checks, scripts: d.scripts, drawnDigest: d.digest, at: 1 }
  return grantFrom(pressed)
}
const plugin = (dir = '') => ({ [`${dir}.claude-plugin/plugin.json`]: '{}', [`${dir}tests/a.test.ts`]: '' })

// ---------------------------------------------------------------- detection

test('package scripts: the four kinds, each only where the script is', async () => {
  const found = await detect({ 'package.json': pkg({ test: 'jest', typecheck: 'tsc --noEmit', lint: 'eslint .', build: 'vite build', deploy: 'sh ship.sh' }) })
  expect(found.map(c => [c.id, c.kind, c.argv.join(' '), c.required])).toEqual([
    ['test', 'test', 'npm run test', true],
    ['typecheck', 'typecheck', 'npm run typecheck', true],
    ['lint', 'lint', 'npm run lint', true],
    ['build', 'build', 'npm run build', true],
  ])
  expect(await commands({ 'package.json': pkg({ 'type-check': 'tsc' }) })).toEqual(['npm run type-check'])
})

test('nothing is invented', async () => {
  const none: Tree[] = [
    {},
    { 'tsconfig.json': '{}', 'bun.lock': '', 'src/a.test.ts': '', Makefile: 'test:' },
    { 'package.json': pkg({}), 'tsconfig.json': '{}' },
    { 'package.json': pkg({ test: 'echo "Error: no test specified" && exit 1' }) },
    { 'package.json': pkg({ test: '', lint: 7, build: null }) },
    { '.claude-plugin/plugin.json': '{}' },
    { '.claude-plugin/plugin.json': '{}', 'tests/readme.md': '' },
    { '.claude-plugin/marketplace.json': '{}', 'tests/a.test.ts': '' },
    { 'scripts/run_all.sh': '' },
  ]
  for (const files of none) expect(await commands(files)).toEqual([])
})

test('tsconfig alone suggests nothing; beside a script, that script', async () => {
  expect(await commands({ 'tsconfig.json': '{}', 'package.json': pkg({ typecheck: 'tsc' }) })).toEqual(['npm run typecheck'])
})

test('the package manager is the lockfile’s', async () => {
  const cases: [string, string][] = [['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun']]
  for (const [lock, manager] of cases) expect(await commands({ [lock]: '', 'package.json': pkg({ lint: 'x' }) })).toEqual([`${manager} run lint`])
  expect(await commands({ 'yarn.lock': '', 'package.json': pkg({ lint: 'x' }) }, { links: ['yarn.lock'] })).toEqual(['npm run lint'])
})

test('a plugin with tests, at the root and under mods', async () => {
  const found = await detect({ ...plugin(), ...plugin('mods/b/'), ...plugin('mods/a/'), 'mods/c/readme.md': '' })
  expect(found.map(c => [c.id, c.argv.join(' '), c.dir])).toEqual([
    ['test', 'claude plugin test .', ''],
    ['test-2', 'claude plugin test mods/a', ''],
    ['test-3', 'claude plugin test mods/b', ''],
  ])
  for (const c of found) expect(c.count).toEqual({ parser: 'bun', minPassed: null, maxSkipped: 0 })
})

test('a run_all runner: pass-fail lines and a long limit', async () => {
  const [found] = await detect({ 'tests/run_all.sh': '#!/bin/bash' })
  expect(found?.argv).toEqual(['bash', 'tests/run_all.sh'])
  expect(found?.count).toEqual({ parser: 'pass-fail-lines', minPassed: null, maxSkipped: 0 })
  expect(found?.timeoutS).toBe(1800)
})

test('counts only where the command says how they are printed', async () => {
  const parser = async (body: string) => (await detect({ 'package.json': pkg({ test: body }) }))[0]?.count?.parser ?? null
  expect(await parser('bun test')).toBe('bun')
  expect(await parser('tsc && bun test src')).toBe('bun')
  expect(await parser('bash tests/run_all.sh')).toBe('pass-fail-lines')
  expect(await parser('jest')).toBeNull()
  expect((await detect({ 'package.json': pkg({ lint: 'bun test' }) }))[0]?.count).toBeUndefined()
})

test('a detected baseline is never already accepted', async () => {
  for (const c of await detect({ 'package.json': pkg({ test: 'bun test' }), ...plugin('mods/a/') })) expect(c.count?.minPassed).toBeNull()
})

test('no link is read or listed through', async () => {
  const files = { 'package.json': pkg({ test: 'jest' }), ...plugin('mods/out/'), ...plugin('mods/in/'), 'tests/run_all.sh': '' }
  const w = world(files, { links: ['package.json', 'mods/out', 'mods/in/tests', 'tests'] })
  expect(await setup.detectChecks(w.$, ROOT)).toEqual([])
  expect(w.seen.reads).toEqual([])
  for (const dir of ['mods/out', 'mods/in/tests', 'tests']) expect(w.seen.lists.includes(dir)).toBe(false)
})

test('a linked plugin manifest, test or runner is not evidence', async () => {
  expect(await commands(plugin(), { links: ['.claude-plugin/plugin.json'] })).toEqual([])
  expect(await commands(plugin(), { links: ['tests/a.test.ts'] })).toEqual([])
  expect(await commands({ 'tests/run_all.sh': '' }, { links: ['tests/run_all.sh'] })).toEqual([])
  expect(await commands({ 'package.json': pkg({ test: 'jest' }) }, { others: ['package.json'] })).toEqual([])
})

test('a huge manifest is not read, and one that grew is not used', async () => {
  const files = { 'package.json': pkg({ test: 'jest' }) }
  const big = world(files, { sizes: { 'package.json': 50_000_000 } })
  expect(await setup.detectChecks(big.$, ROOT)).toEqual([])
  expect(big.seen.reads).toEqual([])

  const grown = world(files, { grown: { 'package.json': `${pkg({ test: 'jest' })}${' '.repeat(400_000)}` } })
  expect(await setup.detectChecks(grown.$, ROOT)).toEqual([])
  expect(grown.seen.lengths).toEqual([256 * 1024 + 1])
})

test('hostile manifests give nothing, and never throw', async () => {
  const texts = ['', '{', 'null', '[]', '"x"', '{"scripts":null}', '{"scripts":[]}', '{"scripts":"test"}', '{"scripts":{"test":{"toString":1}}}', '{"__proto__":{"scripts":{"test":"evil"}}}', '['.repeat(100_000)]
  for (const text of texts) expect(await commands({ 'package.json': text })).toEqual([])
  expect(await commands({ 'package.json': `${chr(0xfeff)}${pkg({ lint: 'eslint' })}` })).toEqual(['npm run lint'])
})

test('a folder name that could never be allowed is no candidate', async () => {
  const names = ['a&calc', '%PATH%', `a${chr(0x202e)}b`, `a${chr(0xa0)}b`, SECRET]
  expect(await commands(Object.assign({ ...plugin('mods/fine/') }, ...names.map(name => plugin(`mods/${name}/`))))).toEqual(['claude plugin test mods/fine'])
})

test('every candidate is one the grant rules allow, and each of those is offered', async () => {
  const names = ['fine', 'my mod', 'a*', 'a?', '[x]', '{a,b}', '@scope', '~home', 'a..b', 'end ', 'x.sh', 'npm']
  const offered = (await detect(Object.assign({}, ...names.map(name => plugin(`mods/${name}/`))))).map(c => c.argv[3])
  const allowed = names.map(name => `mods/${name}`).filter(dir => checkProblem(check({ argv: ['claude', 'plugin', 'test', dir] })) === null)
  expect([...offered].sort()).toEqual(allowed.sort())
  expect(offered).toContain('mods/fine')
})

test('what detection proposes is plain, whatever the manager', async () => {
  for (const lock of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock']) {
    const found = await detect({ [lock]: '', 'package.json': pkg({ test: 'jest "src/**"', typecheck: 'tsc', lint: 'eslint ~/x', build: 'vite' }), ...plugin(), ...plugin('mods/os-deck/'), 'tests/run_all.sh': '' })
    expect(found.length).toBe(7)
    for (const c of found) {
      expect(checkProblem(c)).toBeNull()
      for (const arg of c.argv) expect(/[*?[\]{}]|^[@~]|\/\//.test(arg)).toBe(false)
      expect(['npm', 'pnpm', 'yarn', 'bun', 'bash', 'claude']).toContain(c.argv[0])
    }
  }
})

test('a root not on this machine, or not readable', async () => {
  const w = world(plugin())
  for (const root of ['//host/share', '\\\\host\\share', 'relative', '']) expect(await setup.detectChecks(w.$, root)).toEqual([])
  expect(w.seen.lists).toEqual([])
  expect(await detect(plugin(), { failList: [''] })).toEqual([])
})

test('setup runs nothing, git included', async () => {
  const files = { 'package.json': pkg({ test: 'bun test', pretest: 'npm run lint', lint: 'eslint' }), '.git/config': '', ...plugin('mods/a/') }
  const w = world(files)
  await setup.draftFor(w.$, ROOT, await setup.detectChecks(w.$, ROOT), 'detected')
  expect(w.seen.ran).toEqual([])
  for (const read of w.seen.reads) expect(read).toBe('package.json')
})

// ---------------------------------------------------------------- typed

const typed = (args: string) => {
  const out = setup.parseTypedCheck(args)
  return 'check' in out ? out.check : out.error
}
const argvOf = (args: string) => (typed(args) as ProofCheck).argv

test('typed: kind, folder, argv', () => {
  expect(typed('lint --dir web -- npm run lint')).toEqual({ id: 'lint', kind: 'lint', description: 'npm run lint', argv: ['npm', 'run', 'lint'], dir: 'web', timeoutS: 300, required: true })
  expect(argvOf('build  --\tnode  build.js ')).toEqual(['node', 'build.js'])
  expect((typed('test -- bash tests/run_all.sh') as ProofCheck).count?.parser).toBe('pass-fail-lines')
  expect((typed('test -- claude plugin test mods/os-deck') as ProofCheck).count?.parser).toBe('bun')
  expect(argvOf('test -- npm run test -- --watch=false')).toEqual(['npm', 'run', 'test', '--', '--watch=false'])
})

test('typed: double quotes group words', () => {
  expect(argvOf('test -- "C:\\Program Files\\Godot\\godot.exe" --path "my game"')).toEqual(['C:\\Program Files\\Godot\\godot.exe', '--path', 'my game'])
  expect(argvOf('test -- node --name="a b" it\'s')).toEqual(['node', '--name=a b', "it's"])
  expect((typed('test --dir "my app" -- bun test') as ProofCheck).dir).toBe('my app')
})

test('typed: no shell meaning', () => {
  expect(argvOf('test -- node a.js ; echo $HOME a~b `id`')).toEqual(['node', 'a.js', ';', 'echo', '$HOME', 'a~b', '`id`'])
})

test('typed: refused with its reason, never repaired', () => {
  const usage = 'expected: <test|typecheck|lint|build> [--dir <folder>] -- <command>'
  const cases: [string, string][] = [
    ['', usage],
    ['deploy -- sh ship.sh', usage],
    ['Test -- bun test', usage],
    ['test bun test', usage],
    ['test --', usage],
    ['test --dir -- bun test', usage],
    ['test --dir a b -- bun test', usage],
    ['test --dir "" -- bun test', usage],
    ['test -- node "a b', 'a double quote is not closed'],
    ["test -- node 'a b'", 'single quotes do not group words here: use double quotes'],
    ['test -- node "a\\"b"', 'a backslash does not escape a quote here'],
    ['test -- node ""', 'an empty argument'],
    [`test -- node a${chr(0x202e)}b`, 'a character that does not show'],
    [`test -- node a${chr(0xa0)}b`, 'a character that does not show'],
    [`test -- node a${chr(0x3164)}b`, 'a character that does not show'],
    ['test -- node a\nnode b', 'a character that does not show'],
    ['test -- npm run a&calc', 'a character cmd would read as its own'],
    ['test -- node //host/share/x.js', 'a network path'],
    ['test -- ./run.sh', 'a program that is neither a bare name nor a full local path'],
    ['test --dir ../up -- bun test', 'a folder outside the repository'],
    ['test --dir ./app -- bun test', 'a folder outside the repository'],
    [`test -- node ${SECRET}`, 'what looks like a secret'],
    [`test --dir ${SECRET} -- bun test`, 'what looks like a secret in the folder'],
    [`test -- node ${'x '.repeat(600)}`, 'too long to show whole'],
  ]
  for (const [args, error] of cases) expect(typed(args)).toBe(error)
})

// ---------------------------------------------------------------- the draft

test('the digest is what a press is bound to', async () => {
  const checks = [check({ argv: ['bun', 'test'], count: { parser: 'bun', minPassed: null, maxSkipped: 0 } })]
  const made = await draft({}, checks)
  expect(made).toEqual({ root: ROOT, checks, digest: made.digest, scripts: [], problem: null, source: 'detected' })
  expect('grant' in (await press(made))).toBe(true)
  expect(await press(made, [check({ argv: ['bun', 'other'] })])).toEqual({ refused: 'the checks changed since they were shown' })
})

test('the digest takes a press on a draft with scripts', async () => {
  const made = await draftOf({ test: 'jest', pretest: 'echo before' })
  expect(made.scripts.length).toBe(2)
  expect('grant' in (await press(made))).toBe(true)
})

test('what is hashed is what is returned, though the caller changes theirs', async () => {
  const checks = [check({ argv: ['bun', 'test'] })]
  const making = draft({}, checks)
  ;(checks[0] as ProofCheck).argv[1] = 'evil'
  const made = await making
  expect(made.checks[0]?.argv).toEqual(['bun', 'test'])
  expect('grant' in (await press(made))).toBe(true)
})

test('a script is shown with its hooks, exactly as written', async () => {
  const body = 'eslint "src/**/*.ts"  --max-warnings 0 && echo done'
  const made = await draftOf({ test: body, pretest: 'echo before', posttest: 'echo after', other: 'x' })
  expect(made.problem).toBeNull()
  expect(made.scripts).toEqual([
    { checkId: 'test', name: 'pretest', body: 'echo before' },
    { checkId: 'test', name: 'test', body },
    { checkId: 'test', name: 'posttest', body: 'echo after' },
  ])
})

test('scripts a script runs are followed, their hooks too', async () => {
  const made = await draftOf({ test: 'npm run unit && yarn lint', unit: 'bun test', preunit: 'pnpm run gen', gen: 'node gen.js', lint: 'eslint', posttest: 'npm t' })
  expect(made.problem).toBeNull()
  expect(made.scripts.map(s => s.name).sort()).toEqual(['gen', 'lint', 'posttest', 'preunit', 'test', 'unit'])
})

test('every way a command names a script', async () => {
  const ways = [
    ['npm', 'test'], ['npm', 't'], ['npm', 'run-script', 'test'], ['npm', 'run', 'test', '--', '--watch'], ['npm', '--silent', 'test'],
    ['pnpm', 'test'], ['yarn', 'test'], ['yarn', 'run', 'test'], ['bun', 'run', 'test'], ['node', '--run', 'test'], ['node', '--run=test'],
    ['run-s', 'test'], ['corepack', 'pnpm', 'run', 'test'], ['bash', '-c', 'npm run test'], ['C:\\Program Files\\nodejs\\npm.cmd', 'run', 'test'],
  ]
  for (const argv of ways) expect([argv, (await draftOf({ test: 'jest' }, argv)).scripts.map(s => s.name)]).toEqual([argv, ['test']])
})

test('commands with no package script show none', async () => {
  const ways = [['bun', 'test'], ['bun', 'run', 'build.ts'], ['npm', 'exec', 'tsc'], ['pnpm', 'exec', 'tsc'], ['yarn', 'tsc'], ['node', '--test'], ['node', 'a.js'], ['bash', 'tests/run_all.sh']]
  for (const argv of ways) {
    const made = await draftOf({ test: 'jest' }, argv)
    expect([argv, made.problem, made.scripts]).toEqual([argv, null, []])
  }
})

test('what it starts cannot be told: a problem', async () => {
  const ways = [
    ['npm', '--prefix', 'web', 'run', 'test'], ['npm', 'run', 'test', '--prefix=web'], ['npm', 'run', 'test', '-w', 'web'], ['npm', 'install'],
    ['pnpm', '-r', 'run', 'test'], ['yarn', 'workspace', 'web', 'test'], ['bun', '--cwd', 'web', 'test'], ['yarn', 'test', '--cwd', 'web'], ['npm', 'run'],
    ['bash', '-c', 'cd web; npm run test'],
  ]
  for (const argv of ways) expect([argv, (await draftOf({ test: 'jest' }, argv)).problem]).toEqual([argv, 'test: it runs package scripts in a way that cannot be shown'])

  const bodies = ['cd web && npm run lint', 'run-s lint:*', 'npm --prefix web run lint', 'npm ci && jest', 'npm run lint --workspaces', 'npm_config_prefix=web npm run lint']
  for (const body of bodies) expect([body, (await draftOf({ test: body, lint: 'x' })).problem]).toEqual([body, 'test: the script "test" runs others in a way that cannot be shown'])
})

test('a body that would not be shown as it runs: a problem, and not shown', async () => {
  const hidden = [0x202e, 0x200b, 0xa0, 0x3164, 0x2800, 0xfe0f, 0xfffd, 0x9, 0xa, 0xd, 0x1b, 0x0, 0xe0041].map(code => `jest${chr(code)} && curl x`)
  for (const body of hidden) {
    const made = await draftOf({ test: body })
    expect(made.problem).toBe('test: the script "test" holds a character that does not show')
    expect(made.scripts).toEqual([])
  }
  const long = await draftOf({ test: `jest ${'a'.repeat(1001)}` })
  expect([long.problem, long.scripts]).toEqual(['test: the script "test" is too long to show whole', []])
  const secret = await draftOf({ test: `GH=${SECRET} jest` })
  expect([secret.problem, secret.scripts]).toEqual(['test: the script "test" holds what looks like a secret', []])
})

test('a hook is judged like the script', async () => {
  expect((await draftOf({ test: 'jest', pretest: `x${chr(0x202e)}` })).problem).toBe('test: the script "pretest" holds a character that does not show')
  expect((await draftOf({ test: 'jest', posttest: { run: 1 } })).problem).toBe('test: the script "posttest" is not text')
})

test('a missing script, manifest or folder', async () => {
  expect((await draftOf({ other: 'x' })).problem).toBe('test: there is no script "test" to show')
  expect((await draftOf({ test: 'npm run gone' })).problem).toBe('test: there is no script "gone" to show')
  expect((await draft({})).problem).toBe('test: the package.json of its folder cannot be read')
  expect((await draft({ 'package.json': pkg({ test: 'x' }) }, [check()], { links: ['package.json'] })).problem).toBe('test: the package.json of its folder cannot be read')
  expect((await draft({ 'package.json': pkg({ test: 'x' }) }, [check()], { sizes: { 'package.json': 9_000_000 } })).problem).toBe('test: the package.json of its folder cannot be read')
  expect((await draft({}, [check({ dir: 'web', argv: ['bun', 'test'] })])).problem).toBe('test: its folder is not there, cannot be read, or is a link')
})

test('a check in a folder shows that folder’s scripts, never through a link', async () => {
  const files = { 'package.json': pkg({ test: 'root tests' }), 'web/package.json': pkg({ test: 'web tests' }) }
  expect((await draft(files, [check({ dir: 'web' })])).scripts[0]?.body).toBe('web tests')
  const linked = await draft(files, [check({ dir: 'web' })], { links: ['web'] })
  expect([linked.problem, linked.scripts]).toEqual(['test: its folder is not there, cannot be read, or is a link', []])
})

test('loops end, depth and number are bounded', async () => {
  const loop = await draftOf({ test: 'npm run b', b: 'npm run test' })
  expect([loop.problem, loop.scripts.map(s => s.name)]).toEqual([null, ['test', 'b']])
  const chain = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i ? `s${i}` : 'test', i + 1 < n ? `npm run s${i + 1}` : 'true']))
  expect((await draftOf(chain(5))).problem).toBeNull()
  expect((await draftOf(chain(6))).problem).toBe('test: its scripts run one another too deep to show')
  const wide = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`w${i}`, 'true']))
  expect((await draftOf({ test: `run-p ${Object.keys(wide).join(' ')}`, ...wide })).problem).toBe('test: it runs more scripts than can be shown')
})

test('names that every object has are only names', async () => {
  expect((await draftOf({ test: 'x' }, ['npm', 'run', 'constructor'])).problem).toBe('test: there is no script "constructor" to show')
  expect((await draft({ 'package.json': '{"scripts":{"__proto__":"shown"}}' }, [check({ argv: ['npm', 'run', '__proto__'] })])).scripts[0]?.body).toBe('shown')
})

test('grant’s problems are the draft’s', async () => {
  expect((await draft({}, [])).problem).toBe('no check')
  expect((await draft({}, [check(), check()])).problem).toBe('two checks with one id')
  expect((await setup.draftFor(world({}).$, '//host/share', [check()], 'typed')).problem).toBe('the root is not a folder on this machine')
  expect((await draft({}, [check({ argv: ['node', `a${chr(0xa0)}b`] })])).problem).toBe('test: its command or folder holds a character that does not show')
})

test('a problem carries nothing that cannot be drawn', async () => {
  const made = await draft({}, [check({ id: `x${chr(0x1b)}[31m${chr(0)}` })])
  expect(made.problem).toBe('x: an id not understood')
})

test('a draft of junk is a problem, never a throw', async () => {
  const made = await setup.draftFor(world({}).$, ROOT, [null] as unknown as ProofCheck[], 'saved')
  expect([made.problem, made.digest, made.source]).toEqual(['it could not be read', '', 'saved'])
})

test('what the screen would not draw whole is a problem of setup too', async () => {
  // Each body is short enough alone; escaped, as they are drawn, the three are not.
  const body = `jest ${chr(0x44f).repeat(900)}`
  const long = await draftOf({ pretest: body, test: body, posttest: body })
  expect(long.problem).toBe('too long to show whole')

  const named = await setup.draftFor(world({ [`${SECRET}/a.test.ts`]: '' }).$, `${ROOT}/${SECRET}`, [check({ argv: ['bun', 'test'] })], 'detected')
  expect(named.problem).toBe('what looks like a secret')
})
