import type { EngineInterface } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { checkProblem, grantFrom } from '../hooks/proof/grant'
import type { Draft } from '../hooks/proof/model'
import { detectChecks, draftFor, parseTypedCheck } from '../hooks/proof/setup'
import type { ProofCheck } from '../types'

const setup = { detectChecks, parseTypedCheck, draftFor }

const ROOT = '/repo'
const chr = (code: number) => String.fromCodePoint(code)
// Fake, and put together here so no scanner takes it for a key.
const SECRET = ['ghp', 'A'.repeat(30)].join('_')

const base64Of = (text: string) => btoa([...new TextEncoder().encode(text)].map(b => String.fromCharCode(b)).join(''))
const sha = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('')
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
      read: async (path: string, options?: { as?: string; length?: number }) => {
        const at = inRoot(path)
        seen.reads.push(at)
        seen.lengths.push(options?.length ?? Number.POSITIVE_INFINITY)
        const text = odd.grown?.[at] ?? files[at]
        if (text === undefined) throw new Error('ENOENT')
        const kept = options?.length === undefined ? text : text.slice(0, options.length)
        return options?.as === 'bytes' ? { base64: base64Of(kept) } : kept
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
  const pressed = { session: 'S', root: ROOT, checks, scripts: d.scripts, watched: d.watched, files: d.files, manualOnly: d.manualOnly, drawnDigest: d.digest, at: 1 }
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
  expect(grown.seen.lengths).toEqual([4 * 1024 * 1024])
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
  for (const read of w.seen.reads) expect(['package.json', 'mods/a/.claude-plugin/plugin.json']).toContain(read)
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
  expect(made).toEqual({ root: ROOT, checks, digest: made.digest, scripts: [], watched: made.watched, files: [], manualOnly: null, problem: null, source: 'detected' })
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
  for (const argv of ways) expect([argv, (await draftOf({ test: 'jest' }, argv)).problem?.startsWith('test: it cannot be shown: ')]).toEqual([argv, true])

  const bodies = ['cd web && npm run lint', 'run-s lint:*', 'npm --prefix web run lint', 'npm ci && jest', 'npm run lint --workspaces', 'npm_config_prefix=web npm run lint']
  for (const body of bodies) expect([body, (await draftOf({ test: body, lint: 'x' })).problem?.startsWith('test: the script "test" cannot be shown: ')]).toEqual([body, true])
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
  expect((await draft({ 'package.json': pkg({ test: 'x' }) }, [check()], { links: ['package.json'] })).problem).toBe('test: package.json cannot be watched: it is a link')
  expect((await draft({ 'package.json': pkg({ test: 'x' }) }, [check()], { sizes: { 'package.json': 9_000_000 } })).problem).toBe('test: package.json cannot be watched: it is too large to read whole')
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

// ---------------------------------------------------------------- what runs is bound to what is read

const watchOf = (d: Draft) => (d.watched ?? []).map(([path]) => path)
const bodyIn = async (body: string, more: Tree = {}, scripts: Record<string, string> = {}) => draftOf({ test: body, ...scripts }, ['npm', 'run', 'test'], more)
const typedDraft = async (line: string, files: Tree = {}, dir = '') => draft(files, [check({ kind: 'lint', argv: line.split(' '), dir })])
const refused = (body: string, d: Draft) => [body, d.problem?.startsWith('test: ') === true && d.problem.includes('cannot be shown')]

test('C1: what git ignores is watched as anything else, there or not yet', async () => {
  const d = await typedDraft('node local/lint.js', { '.gitignore': 'local/\n.npmrc\n', 'local/lint.js': 'process.exit(1)' })
  expect(d.watched).toContainEqual(['local/lint.js', await sha('process.exit(1)')])
  const npm = await bodyIn('node lint.js', { 'lint.js': 'x' })
  expect(npm.watched).toContainEqual(['.npmrc', null])
  expect(npm.watched).toContainEqual(['lint.js', await sha('x')])
})

test('C4: what is shown is parsed from the bytes that are hashed', async () => {
  const shown = pkg({ test: 'node shown.js' })
  const other = pkg({ test: 'node other.js' })
  const files: Tree = { 'package.json': shown, '.npmrc': 'audit=false\n' }
  const w = world(files)
  let reads = 0
  const read = (w.$ as any).fs.read
  // As a file watcher would: other bytes as soon as the first read is done.
  ;(w.$ as any).fs.read = async (path: string, options: unknown) => {
    const got = await read(path, options)
    if (path.endsWith('package.json') && ++reads === 1) files['package.json'] = other
    return got
  }
  const d = await setup.draftFor(w.$, ROOT, [check()], 'detected')
  expect(d.scripts[0]?.body).toBe('node shown.js')
  expect(d.watched).toContainEqual(['package.json', await sha(shown)])
  expect(reads).toBe(1)
  expect(w.seen.reads.filter(path => path === '.npmrc').length).toBe(1)
})

test('H1: config of the runner is shown whole, and what it names is watched', async () => {
  const cases: [string, string, string, string | null][] = [
    ['npm run test', '.npmrc', 'audit=false\r\nnode-options=--require=./helper.cjs\r\n', 'helper.cjs'],
    ['npm run test', '.npmrc', 'audit=false\n\tfund=false\n', null],
    ['yarn run test', '.yarnrc.yml', 'yarnPath: .yarn/releases/yarn.cjs\n', '.yarn/releases/yarn.cjs'],
    ['yarn run test', '.yarnrc.yml', 'plugins:\n  - path: .yarn/plugins/p.cjs\n', '.yarn/plugins/p.cjs'],
    ['yarn run test', '.yarnrc', 'yarn-path "tools/yarn"\n', 'tools/yarn'],
    ['bun test', 'bunfig.toml', '[test]\npreload = ["./pre.ts"]\n', 'pre.ts'],
    ['pnpm run test', 'pnpm-workspace.yaml', 'packages:\n  - app\n', null],
    ['bun run test', 'bunfig.toml', '[run]\nsilent = true\n', null],
  ]
  for (const [line, path, body, named] of cases) {
    const d = await typedDraft(line, { 'package.json': pkg({ test: 'jest' }), [path]: body })
    expect([line, d.problem]).toEqual([line, null])
    expect(d.files).toEqual([{ path, body }])
    expect(d.watched).toContainEqual([path, await sha(body)])
    if (named) expect(watchOf(d)).toContain(named)
  }
})

test('H1: config from the folder of the check up to the root', async () => {
  const d = await typedDraft('npm run test', { '.npmrc': 'audit=false', 'a/.npmrc': 'fund=false', 'a/b/package.json': pkg({ test: 'jest' }) }, 'a/b')
  expect(d.problem).toBeNull()
  expect(d.files.map(f => f.path).sort()).toEqual(['.npmrc', 'a/.npmrc'])
  expect(watchOf(d)).toContain('a/b/.npmrc')
})

test('H1: config that makes what is shown untrue is a problem', async () => {
  const cases: [string, string, string][] = [
    ['npm run test', '.npmrc', 'workspace=pkg\n'],
    ['npm run test', '.npmrc', '  "workspace[]" = pkg\n'],
    ['npm run test', '.npmrc', 'script-shell=evil.exe\n'],
    ['npm run test', '.npmrc', 'SCRIPT_SHELL=evil.exe\n'],
    ['npm run test', '.npmrc', 'prefix=web\n'],
    ['npm run test', '.npmrc', 'node-options=--run quiet\n'],
    ['npm run test', '.npmrc', 'node-options=${HIDDEN}\n'],
    ['npm run test', '.npmrc', '${KEY}=pkg\n'],
    ['pnpm run test', 'pnpm-workspace.yaml', 'scriptShell: ./other\n'],
    ['pnpm run test', '.npmrc', 'verify-deps-before-run=install\n'],
    ['yarn run test', '.yarnrc', '--cwd web\n'],
    ['bun run test', '.env', 'NODE_OPTIONS=--require=./evil.js\n'],
    ['yarn run test', '.env.yarn', 'export npm_config_prefix=web\n'],
  ]
  for (const [line, path, body] of cases) expect([body, (await typedDraft(line, { 'package.json': pkg({ test: 'jest' }), [path]: body })).problem?.includes(path) === true]).toEqual([body, true])
})

test('H1: config that cannot be shown is a problem, and is not shown', async () => {
  const bodies: [string, string][] = [
    [`//registry.npmjs.org/:_authToken=${SECRET}\n`, 'what looks like a secret'],
    [`audit=false${chr(0x202e)}\n`, 'a character that does not show'],
    ['audit=false\rworkspace=x\n', 'a character that does not show'],
    ['# long\n'.repeat(2000), 'too long to show whole'],
  ]
  for (const [body, why] of bodies) {
    const d = await bodyIn('jest', { '.npmrc': body })
    expect(d.problem?.includes(why)).toBe(true)
    expect(d.files).toEqual([])
  }
})

test('H1: an env file that only sets harmless values is watched, never shown', async () => {
  const d = await typedDraft('bun test', { '.env': `API_TOKEN=${SECRET}\n` })
  expect([d.problem, d.files]).toEqual([null, []])
  expect(d.watched).toContainEqual(['.env', await sha(`API_TOKEN=${SECRET}\n`)])
})

test('H1: files shown are under the same limits as scripts', async () => {
  const line = `# ${'x'.repeat(100)}\n`
  const d = await typedDraft('npm run test', { '.npmrc': line.repeat(70), 'a/.npmrc': line.repeat(70), 'a/b/.npmrc': line.repeat(70), 'a/b/package.json': pkg({ test: 'jest' }) }, 'a/b')
  expect(d.problem).toBe('too long to show whole')
})

test('H2: a helper after a change of folder', async () => {
  const d = await bodyIn('cd tools && node lint.js', { 'tools/lint.js': 'old' })
  expect(d.problem).toBeNull()
  expect(d.watched).toContainEqual(['tools/lint.js', await sha('old')])
  expect(watchOf(d)).toContain('tools/.npmrc')
})

test('H2: a script of another folder, shown as that folder’s', async () => {
  const d = await bodyIn('cd web && npm run lint', { 'web/package.json': pkg({ lint: 'node w.js' }) }, { lint: 'node root.js' })
  expect(d.problem).toBeNull()
  expect(d.scripts.map(s => [s.name, s.body])).toEqual([['test', 'cd web && npm run lint'], ['web: lint', 'node w.js']])
  expect(watchOf(d)).toContain('web/w.js')
})

test('H2: a name without its extension, and a folder’s index', async () => {
  const file = await bodyIn('node tools/lint', { 'tools/lint.js': 'old' })
  expect(file.watched).toContainEqual(['tools/lint.js', await sha('old')])
  for (const path of ['tools/lint', 'tools/lint.json', 'tools/lint/index.js', 'tools/lint/package.json']) expect(file.watched).toContainEqual([path, null])

  const folder = await bodyIn('node tools/lint', { 'tools/lint/package.json': '{"main":"./entry"}', 'tools/lint/entry.js': 'old' })
  expect(folder.watched).toContainEqual(['tools/lint/entry.js', await sha('old')])

  const exact = await bodyIn('node ./tools\u002flint.js', { 'tools/lint.js': 'old' })
  expect(exact.watched).toContainEqual(['tools/lint.js', await sha('old')])
})

test('H2: a plugin test’s manifests, however the folder is spelled', async () => {
  for (const [arg, base] of [['.', ''], ['./', ''], ['mods/m', 'mods/m/'], ['mods/m/', 'mods/m/'], ['./mods/m', 'mods/m/'], ['mods\\m', 'mods/m/']] as const) {
    const d = await typedDraft(`claude plugin test ${arg}`, { [`${base}.claude-plugin/plugin.json`]: '{}', [`${base}hooks/hooks.json`]: '{}' })
    expect([arg, d.problem, d.manualOnly]).toEqual([arg, null, null])
    expect(d.watched).toContainEqual([`${base}.claude-plugin/plugin.json`, await sha('{}')])
    expect(d.watched).toContainEqual([`${base}hooks/hooks.json`, await sha('{}')])
  }
})

test('H2: other runners: their manifest shown and watched, and manual only', async () => {
  const cases: [string, string, string][] = [
    ['just test', 'justfile', 'test:\n\ttrue\n'],
    ['make test', 'Makefile', 'test:\n\ttrue\n'],
    ['composer test', 'composer.json', '{}\n'],
    ['deno task test', 'deno.json', '{}\n'],
  ]
  for (const [line, path, body] of cases) {
    const d = await typedDraft(line, { [path]: body })
    expect([line, d.problem]).toEqual([line, null])
    expect(d.files.map(f => f.body)).toEqual([body])
    expect(d.watched).toContainEqual([d.files[0]?.path, await sha(body)])
    expect(d.manualOnly).toBe('test: what its recipes run is not known')
  }
  expect(watchOf(await typedDraft('yarn exec tsc'))).toContain('.yarnrc.yml')
})

test('H2: a file in the folder that would run in the program’s place', async () => {
  const d = await bodyIn('jest', { '.gitignore': 'jest.cmd' })
  for (const path of ['jest.cmd', 'jest.exe', 'jest.bat', 'jest.js', 'node.exe']) expect(d.watched).toContainEqual([path, null])
})

test('H2: what cannot be resolved is manual only, with its reason', async () => {
  const cases: [string, string][] = [
    ['cargo test', 'test: what cargo runs is not known'],
    ['node ../outside.js', 'test: it runs a file outside the repository'],
    ['claude plugin test ../elsewhere', 'test: it tests a plugin outside the repository'],
    ['C:\\tools\\godot.exe --headless', 'test: what godot runs is not known'],
  ]
  for (const [line, why] of cases) {
    const d = await typedDraft(line)
    expect([line, d.problem, d.manualOnly]).toEqual([line, null, why])
  }
  expect((await bodyIn('APP_MODE=test jest')).manualOnly).toBe('test: what setting APP_MODE changes is not known')
})

test('H3: the reproductions', async () => {
  const hidden = { quiet: 'node hidden.js' }
  const node = await bodyIn('node --require ./ok.js --run quiet', {}, hidden)
  expect(node.problem).toBeNull()
  expect(node.scripts.map(s => s.name)).toEqual(['test', 'quiet'])
  expect(watchOf(node)).toContain('ok.js')
  expect(watchOf(node)).toContain('hidden.js')
  for (const body of ['yarnpkg run quiet', 'np^m run quiet', 'concurrently npm:quiet']) expect(refused(body, await bodyIn(body, {}, hidden))).toEqual([body, true])
})

test('H3: what is not positively understood is a problem', async () => {
  const bodies = [
    'n\\pm run quiet', '"np"m run quiet', "'npm' run quiet", '$RUNNER run quiet', '%RUNNER% run quiet', '`echo npm` run quiet', '$(echo npm) run quiet', '@npm run quiet', 'npm. run quiet', 'npm,run,quiet',
    'ni quiet', 'nr quiet', 'pnpx jest', 'turbo run quiet', 'wrapper npm run quiet', 'cross-env-shell "npm run quiet"', 'xargs npm run quiet', 'cmd /c npm run quiet', 'eval npm run quiet', '. ./env.sh', 'call npm run quiet',
    'node -e "1"', 'node --eval=1', 'node --unknown-flag a.js', 'node --env-file=.env a.js', 'node', 'node - ', 'node < quiet.js', 'echo npm run quiet | sh', 'node node_modules/npm/bin/npm-cli.js run quiet', 'bash --rcfile x tests/a.sh',
    'npm --loglevel silent run quiet', 'npm run quiet --prefix=web', 'pnpm --filter web run quiet', 'bun --cwd web run quiet', 'bun test --cwd web', 'run-s --npm-path evil quiet',
    'NODE_OPTIONS=--require=./evil.js jest', 'PATH=evil jest', 'npm_config_prefix=web npm run quiet', 'cross-env NODE_OPTIONS=--import=$X jest', 'BASH_ENV=evil.sh bash tests/a.sh',
    "echo 'a & npm run quiet'", 'echo # && npm run quiet', '(npm run quiet)', 'np? run quiet', 'node *.js', 'run-s {quiet,other}', 'eslint *', 'jest &',
    'cd .. && node x.js', 'cd web && node x.js', 'cd /tmp && node x.js', 'cd src; node x.js', 'cd src || node x.js', 'cd -- src && node x.js', 'pushd src && node x.js', 'cd/d src && node x.js', 'claude -p fix',
  ]
  for (const body of bodies) expect(refused(body, await bodyIn(body, { 'src/x.js': '' }, { quiet: 'node hidden.js' }))).toEqual([body, true])
})

test('H3: arguments handed to a script are read with its body', async () => {
  const d = await bodyIn('npm run unit -- --require ./evil.js --run quiet', {}, { unit: 'node', quiet: 'node hidden.js' })
  expect(d.scripts.map(s => s.name)).toEqual(['test', 'unit', 'quiet'])
  expect(watchOf(d)).toContain('evil.js')
})

test('ordinary cases stay automatic', async () => {
  const typedCases: [string, Tree][] = [
    ['claude plugin test mods/os-deck', plugin('mods/os-deck/')],
    ['bun test', {}],
    ['bash tests/run_all.sh', { 'tests/run_all.sh': 'echo' }],
    ['node scripts/x.js', { 'scripts/x.js': '' }],
  ]
  for (const [line, files] of typedCases) {
    const d = await typedDraft(line, files)
    expect([line, d.problem, d.manualOnly]).toEqual([line, null, null])
  }
  const bodies = [
    'jest', 'tsc --noEmit', 'eslint .', 'node scripts/x.js', 'bash tests/run_all.sh', 'bun test', 'claude plugin test .', 'vitest run', 'jest --passWithNoTests',
    'cross-env NODE_ENV=test jest', 'eslint "src/**/*.ts" --max-warnings 0', 'prettier --check src/**/*.{ts,tsx}', 'tsc -p tsconfig.build.json && vite build', 'node --test',
    'NODE_OPTIONS=--max-old-space-size=4096 vite build', 'rimraf dist && tsc', 'npx tsc --noEmit', 'jest --testEnvironment node', 'python -m pytest -q', 'jest > report.txt 2>&1',
  ]
  for (const body of bodies) {
    const d = await bodyIn(body, { 'scripts/x.js': '', 'tests/run_all.sh': '' })
    expect([body, d.problem, d.manualOnly]).toEqual([body, null, null])
  }
})

test('ordinary cases stay unpaused: work on the code changes nothing watched', async () => {
  for (const line of ['bun test', 'npm run test', 'bash tests/run_all.sh', 'node scripts/x.js', 'claude plugin test mods/m']) {
    const d = await typedDraft(line, { 'package.json': pkg({ test: 'jest && eslint . && tsc --noEmit -p . && vite build --outDir dist && node scripts/x.js' }), 'src/index.ts': '', 'src/index.js': '', 'tests/a.test.ts': '', 'mods/m/hooks/register.tsx': '', 'mods/m/tests/a.test.ts': '', 'dist/index.js': '' })
    expect(d.problem).toBeNull()
    for (const work of ['src/index.ts', 'src/index.js', 'tests/a.test.ts', 'mods/m/hooks/register.tsx', 'mods/m/tests/a.test.ts', 'dist/index.js', 'index.js']) expect([line, work, watchOf(d).includes(work)]).toEqual([line, work, false])
  }
})

test('what a command writes is not watched', async () => {
  const d = await bodyIn('rimraf dist/a.js && esbuild src.ts --outfile=dist/a.js && esbuild b.ts -o dist/b.js && node scripts/x.js > dist/log.js')
  expect(d.problem).toBeNull()
  for (const path of ['dist/a.js', 'dist/b.js', 'dist/log.js']) expect(watchOf(d)).not.toContain(path)
})

test('a watched path that cannot be read is a problem', async () => {
  const files = { 'local/lint.js': 'x', '.npmrc': 'audit=false', 'package.json': pkg({ test: 'jest' }) }
  for (const [line, odd] of [['node local/lint.js', { links: ['local/lint.js'] }], ['node local/lint.js', { links: ['local'] }], ['node local/lint.js', { sizes: { 'local/lint.js': 5_000_000 } }], ['npm run test', { links: ['.npmrc'] }]] as [string, Odd][]) {
    const d = await draft(files, [check({ argv: line.split(' ') })], odd)
    expect([line, d.problem?.includes('cannot be watched') === true, d.digest]).toEqual([line, true, ''])
  }
})

test('a draft with a problem has nothing a press can be bound to', async () => {
  const d = await bodyIn('yarnpkg run quiet')
  expect(d.problem === null).toBe(false)
  expect(await press(d)).toEqual({ refused: 'the checks changed since they were shown' })
})

test('H3: cmd, aliases and wrappers read as they would run', async () => {
  const bodies = [
    'npm=run quiet', 'node=hidden.js jest', 'node/x run quiet', 'trap "node hidden.js" EXIT', 'npx turbo@2 run quiet', 'node node_modules/npm/lib/cli.js run quiet',
    'bun node_modules/npm/bin/npm-cli.js run quiet', 'bash node_modules/.bin/npm run quiet', 'bash scripts/wrap.sh npm run quiet', 'node scripts/wrap.js npm run quiet',
    './scripts/wrap npm run quiet', 'python scripts/wrap.py npm run quiet', 'perl -E 1', 'myrunner run quiet', 'npm exec tsc --noEmit',
  ]
  for (const body of bodies) expect(refused(body, await bodyIn(body, {}, { quiet: 'node hidden.js' }))).toEqual([body, true])

  const versioned = await bodyIn('npx -y pnpm@8 run quiet', {}, { quiet: 'node hidden.js' })
  expect([versioned.problem, versioned.scripts.map(s => s.name)]).toEqual([null, ['test', 'quiet']])
  expect((await bodyIn('../bin/jest')).manualOnly).toBe('test: it runs a file outside the repository')
})

test('H1: config spelled to be read otherwise', async () => {
  const cases: [string, string, string][] = [
    ['npm run test', '.npmrc', 'node-options=--require ./a.js#x\n'],
    ['npm run test', '.npmrc', 'workspace#x=pkg\n'],
    ['npm run test', '.npmrc', '"work\\u0073pace"=pkg\n'],
    ['npm run test', '.npmrc', 'w=pkg\n'],
    ['yarn run test', '.yarnrc.yml', '"yarn\\u0050ath": tools/yarn\n'],
    ['yarn run test', '.yarnrc.yml', 'yarnPath:\n  tools/yarn\n'],
    ['yarn run test', '.yarnrc.yml', 'injectEnvironmentFiles: [other]\n'],
    ['yarn run test', '.yarnrc', 'modules-folder "evil"\n'],
    ['pnpm run test', 'pnpm-workspace.yaml', '"script\\u0053hell": ./other\n'],
    ['pnpm run test', 'pnpm-workspace.yaml', 'script-shell: ./other\n'],
    ['bun test', 'bunfig.toml', '"pre\\u006coad" = ["./pre.ts"]\n'],
  ]
  for (const [line, path, body] of cases) expect([body, (await typedDraft(line, { 'package.json': pkg({ test: 'jest' }), [path]: body })).problem?.includes(path) === true]).toEqual([body, true])
})

test('H1: node options follow a change of folder', async () => {
  const d = await bodyIn('cd tools && node lint.js', { '.npmrc': 'node-options=--require=./helper.cjs\n', 'tools/lint.js': '' })
  expect(d.problem).toBeNull()
  for (const path of ['helper.cjs', 'tools/helper.cjs']) expect(watchOf(d)).toContain(path)
})

test('H2: the other files that run in a program’s place', async () => {
  expect(watchOf(await bodyIn('jest.js'))).toContain('jest.js')
  expect(watchOf(await bodyIn('APP_MODE=1 jest'))).toContain('APP_MODE.cmd')
  expect(watchOf(await bodyIn("mocha './spec/a.js'"))).toContain('spec/a.js')
  expect(watchOf(await bodyIn('node scripts/x.js --file tools/y.js'))).toContain('tools/y.js')
  expect(watchOf(await typedDraft('yarn run test', { 'package.json': pkg({ test: 'jest' }) }))).toContain('.pnp.cjs')
  expect(watchOf(await typedDraft('bun test', { 'bunfig.toml': 'preload = ["setup"]\n' }))).toContain('setup.ts')
})

// ---------------------------------------------------------------- each guard of the reading

test('each refusal of a line of shell', async () => {
  const cases: [string, string][] = [
    ['echo %HOME%', 'it expands a variable'],
    ['echo "$HOME"', 'it expands a variable or a command'],
    ['echo "a\\b"', 'it uses a shell escape'],
    ['node ~/x.js', 'it expands a home folder'],
    ['echo --dir=~/x', 'it expands a home folder'],
    ['echo "open', 'a quote in it is not closed'],
    ['jest >', 'it sends output where that cannot be told'],
    ['jest > && tsc', 'it sends output where that cannot be told'],
    ['jest > > out', 'it sends output where that cannot be told'],
    ['eslint * src', 'it expands names that could be anything'],
    ['eslint * "open', 'it expands names that could be anything'],
    ['eslint *>out', 'it expands names that could be anything'],
    ['eslint *&& tsc', 'it expands names that could be anything'],
    ['jest && && tsc', 'a command in it is empty'],
    ['&& jest', 'a command in it is empty'],
  ]
  for (const [body, why] of cases) expect([body, (await bodyIn(body)).problem]).toEqual([body, `test: the script "test" cannot be shown: ${why}`])
})

test('each refusal of a command', async () => {
  const cases: [string, string][] = [
    ['node a/../b.js', 'a path in it cannot be resolved'],
    ['node --run --x', 'the script node runs cannot be told'],
    ['node -r --no-warnings a.js', 'what node loads first cannot be told'],
    ["node 'a.js'", 'the file node runs cannot be told'],
    ['node --run quiet extra', 'what node hands to the script cannot be told'],
    ['npm run quiet -- "a&b"', 'what it hands to a script cannot be told'],
    ["npm run quiet -- 'a b'", 'what it hands to a script cannot be told'],
    ['npx --package x tsc', 'the program it starts cannot be told'],
    ['npx', 'the program it starts cannot be told'],
    ['yarn frobnicate', 'a command of yarn not understood'],
    ['bun test --preload', 'what bun loads first cannot be told'],
    ['bun run x.ts npm', 'another program is handed a runner'],
    ['tsx w.ts npm', 'another program is handed a runner'],
    ['wrapper npm audit', 'another program is handed a runner'],
    ['tsx node_modules/npm/bin/npm-cli.js', 'a package runner under another name'],
    ['python node_modules/npm/run.py', 'a package runner under another name'],
    ['./npm audit', 'a package runner under another name'],
    ['bash -c "echo" extra', 'the line given to a shell cannot be told'],
    ['python -c pass', 'the code python runs cannot be told'],
    ['python', 'the code python runs cannot be told'],
    ['claude plugin test a/../b', 'the plugin folder cannot be resolved'],
    ['make -C other', 'a word before a recipe of make not understood'],
    ['make SHELL=evil', 'a word before a recipe of make not understood'],
    ['NODE_ENV=test', 'it sets the environment and names no command'],
    ['./a/../run.sh', 'a path in it cannot be resolved'],
    ['corepack enable', 'a command of corepack not understood'],
    ['jest "npm run quiet"', 'jest is handed a runner'],
  ]
  for (const [body, why] of cases) expect([body, (await bodyIn(body, {}, { quiet: 'jest' })).problem]).toEqual([body, `test: the script "test" cannot be shown: ${why}`])

  expect((await bodyIn('cd src && npm run quiet', { 'src/a.ts': '' })).problem).toBe('test: the script "test" cannot be shown: the package.json of src cannot be read')
  expect((await bodyIn('npm run empty -- sh', {}, { empty: '' })).problem).toBe('test: the script "empty" cannot be shown: what is handed to it would be the command')
  expect((await typedDraft('yarn tsc')).problem).toBe('test: it cannot be shown: what yarn tsc starts cannot be told')
  const many = 'echo;'.repeat(190) + 'echo'
  expect((await draftOf({ pretest: many, test: many, posttest: many })).problem).toBe('test: it runs more commands than can be shown')
})

test('each file a command names is watched', async () => {
  const cases: [string, string[]][] = [
    ['tsc -p tsconfig.build.json', ['tsconfig.build.json']],
    ['tsc -p app', ['app/tsconfig.json']],
    ['jest --config ./conf/jest', ['conf/jest.js']],
    ['rollup -c rollup.cfg', ['rollup.cfg']],
    ['bun build entry.ts', ['entry.ts']],
    ['bun run build.ts helper.js', ['build.ts', 'helper.js']],
    ['bun test --preload ./setup', ['setup.ts']],
    ['bun test -r ./early', ['early.ts']],
    ['bun test a.test.ts', ['a.test.ts']],
    ['node --test a.test.js', ['a.test.js']],
    ['bash tests/run helper.sh', ['tests/run', 'helper.sh']],
    ['python -m pytest conftest.py', ['pytest.py', 'pytest/__init__.py', 'pytest/__main__.py', 'conftest.py']],
    ['python tools helper.py', ['tools', 'tools/__main__.py', 'helper.py']],
    ['tsx tool.ts helper.ts', ['tool.ts', 'helper.ts']],
    ['./scripts/check.sh helper.js', ['scripts/check.sh', 'scripts/check.sh.cmd', 'helper.js']],
    ['cargo test check.sh', ['check.sh']],
    ['node tool.js', ['tsconfig.json', 'package.json']],
    ['claude plugin test mods/m', ['mods/m/bunfig.toml', 'mods/m/package.json']],
  ]
  for (const [line, paths] of cases) {
    const d = await bodyIn(line)
    expect([line, d.problem]).toEqual([line, null])
    for (const path of paths) expect([line, path, watchOf(d).includes(path)]).toEqual([line, path, true])
  }
  // With no package.json and no script: the check alone.
  expect(watchOf(await typedDraft('node tool.js'))).toContain('tsconfig.json')
})

test('a folder’s main, where it leads', async () => {
  const main = async (value: string, more: Tree) => bodyIn('node tools/lint', { 'tools/lint/package.json': JSON.stringify({ main: value }), ...more })
  expect((await main('./bin/cli', { 'tools/lint/bin/cli': 'x' })).watched).toContainEqual(['tools/lint/bin/cli', await sha('x')])
  expect((await main('./dist', { 'tools/lint/dist/index.js': 'x' })).watched).toContainEqual(['tools/lint/dist/index.js', await sha('x')])
  expect((await main('../../../out', {})).manualOnly).toBe('test: it runs a file outside the repository')
})

test('a plugin’s own config and hooks', async () => {
  const d = await typedDraft('claude plugin test mods/m', { 'bunfig.toml': '[test]\n', 'mods/m/bunfig.toml': '[run]\n', 'mods/m/.claude-plugin/plugin.json': '{"hooks":"./other/hooks.json"}' })
  expect(d.files.map(f => f.path)).toEqual(['bunfig.toml', 'mods/m/bunfig.toml'])
  expect(watchOf(d)).toContain('mods/m/other/hooks.json')
})

test('config is shown for every way into a runner', async () => {
  for (const line of ['run-s lint', 'npx tsc', 'corepack npm run lint', 'npm exec tsc']) {
    const d = await typedDraft(line, { 'package.json': pkg({ lint: 'eslint .' }), '.npmrc': 'audit=false' })
    expect([line, d.files.map(f => f.path)]).toEqual([line, ['.npmrc']])
  }
})

test('each reason to run by hand', async () => {
  const cases: [string, string][] = [
    ['python -m http.server', 'what that python module runs is not known'],
    ['python -X dev run.py', 'what those python flags run is not known'],
    ['ruby -S rake', 'what those flags of ruby run is not known'],
  ]
  for (const [body, why] of cases) expect([body, (await bodyIn(body)).manualOnly]).toEqual([body, `test: ${why}`])
})

test('files shown are counted in lines as scripts are', async () => {
  const short = '#\n'.repeat(140)
  const d = await typedDraft('npm run test', { '.npmrc': short, 'a/.npmrc': short, 'a/b/.npmrc': short, 'a/b/package.json': pkg({ test: 'jest' }) }, 'a/b')
  expect(d.problem).toBe('too long to show whole')
})

test('H3: a script named like another folder’s hides none', async () => {
  const d = await bodyIn('npm run "web: lint" && cd web && npm run lint', { 'web/package.json': pkg({ lint: 'node hidden.js' }) }, { 'web: lint': 'eslint .' })
  expect(d.problem).toBeNull()
  expect(d.scripts.map(s => s.body)).toEqual(['npm run "web: lint" && cd web && npm run lint', 'eslint .', 'node hidden.js'])
})

test('H3: code and runners behind the flags of a host', async () => {
  for (const body of ['python -X dev -c pass', 'ruby -w -e 1', 'python -X dev wrap.py npm run quiet', 'ruby -S npm run quiet', 'python -m invoke npm', 'wrapper "system(\'npm run quiet\')"'])
    expect(refused(body, await bodyIn(body, {}, { quiet: 'node hidden.js' }))).toEqual([body, true])
})

test('H2: what may run by hand is still watched', async () => {
  for (const [body, path] of [['python -X dev run.py', 'run.py'], ['ruby -w run.rb', 'run.rb'], ['python -m invoke tasks.py', 'tasks.py']] as const) {
    const d = await bodyIn(body)
    expect([body, d.manualOnly === null, watchOf(d).includes(path)]).toEqual([body, false, true])
  }
  expect(watchOf(await typedDraft('claude plugin test .'))).toContain('node.exe')
})

test('H1: npm sent to another package', async () => {
  for (const body of ['global=true\n', 'location=global\n', 'workspace-root=true\n']) expect([body, (await bodyIn('jest', { '.npmrc': body })).problem?.includes('.npmrc')]).toEqual([body, true])
})
