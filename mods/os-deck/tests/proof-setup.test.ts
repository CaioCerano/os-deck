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
        if (path !== ROOT && !path.startsWith(`${ROOT}/`)) return []
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

test('H1: config from the folder of the check up to the root', async () => {
  const d = await typedDraft('npm run test', { '.npmrc': 'audit=false', 'a/.npmrc': 'fund=false', 'a/b/package.json': pkg({ test: 'jest' }) }, 'a/b')
  expect(d.problem).toBeNull()
  expect(d.files.map(f => f.path).sort()).toEqual(['.npmrc', 'a/.npmrc'])
  expect(watchOf(d)).toContain('a/b/.npmrc')
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

test('H1: files shown are under the same limits as scripts', async () => {
  const line = `# ${'x'.repeat(100)}\n`
  const d = await typedDraft('npm run test', { '.npmrc': line.repeat(70), 'a/.npmrc': line.repeat(70), 'a/b/.npmrc': line.repeat(70), 'a/b/package.json': pkg({ test: 'jest' }) }, 'a/b')
  expect(d.problem).toBe('too long to show whole')
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

// ---------------------------------------------------------------- each guard of the reading

test('files shown are counted in lines as scripts are', async () => {
  const short = '#\n'.repeat(140)
  const d = await typedDraft('npm run test', { '.npmrc': short, 'a/.npmrc': short, 'a/b/.npmrc': short, 'a/b/package.json': pkg({ test: 'jest' }) }, 'a/b')
  expect(d.problem).toBe('too long to show whole')
})

test('H1: npm sent to another package', async () => {
  for (const body of ['global=true\n', 'location=global\n', 'workspace-root=true\n']) expect([body, (await bodyIn('jest', { '.npmrc': body })).problem?.includes('.npmrc')]).toEqual([body, true])
})

// ---------------------------------------------------------------- the grammar: understood, by hand, or refused

const bodyRefused = async (body: string, more: Tree = {}, scripts: Record<string, string> = {}) => {
  const d = await bodyIn(body, more, scripts)
  return [body, d.problem !== null, d.digest]
}
const RUNNABLE: Tree = { 'ok.js': '', 'x.js': '', 'scripts/x.js': '', 'tests/run_all.sh': '', 'tools/lint': '', 'dist/cli.js': '' }

test('detection always proposes npm run, whoever installed', async () => {
  for (const lock of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'])
    expect(await commands({ [lock]: '', 'package.json': pkg({ lint: 'eslint .' }) })).toEqual(['npm run lint'])
})

test('a script is shown with its hooks, exactly as written', async () => {
  const body = 'eslint .  --max-warnings 0 && node ok.js'
  const made = await draftOf({ test: body, pretest: 'tsc --noEmit', posttest: 'jest', other: 'x' }, ['npm', 'run', 'test'], RUNNABLE)
  expect(made.problem).toBeNull()
  expect(made.scripts).toEqual([
    { checkId: 'test', name: 'pretest', body: 'tsc --noEmit' },
    { checkId: 'test', name: 'test', body },
    { checkId: 'test', name: 'posttest', body: 'jest' },
  ])
})

test('scripts a script runs are followed, their hooks too', async () => {
  const made = await draftOf({ test: 'npm run unit && npm run lint', unit: 'bun test', preunit: 'npm run gen', gen: 'node gen.js', lint: 'eslint .', posttest: 'jest' }, ['npm', 'test'], { 'gen.js': '' })
  expect(made.problem).toBeNull()
  expect(made.scripts.map(x => x.name).sort()).toEqual(['gen', 'lint', 'posttest', 'preunit', 'test', 'unit'])
})

test('loops end, depth and number are bounded', async () => {
  const loop = await draftOf({ test: 'npm run b', b: 'npm run test' })
  expect([loop.problem, loop.scripts.map(x => x.name)]).toEqual([null, ['test', 'b']])
  const chain = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [i ? `s${i}` : 'test', i + 1 < n ? `npm run s${i + 1}` : 'jest']))
  expect((await draftOf(chain(5))).problem).toBeNull()
  expect((await draftOf(chain(6))).problem).toBe('test: its scripts run one another too deep to show')
  const wide = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`w${i}`, 'jest']))
  expect((await draftOf({ test: Object.keys(wide).map(n => `npm run ${n}`).join(' && '), ...wide })).problem).toBe('test: it runs more scripts than can be shown')
})

test('what the screen would not draw whole is a problem of setup too', async () => {
  // Each body is short enough alone; the twenty are not.
  const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`s${i}`, `eslint ${'a'.repeat(900)}`]))
  expect((await draftOf({ test: Object.keys(many).map(n => `npm run ${n}`).join(' && '), ...many })).problem).toBe('too long to show whole')
  const named = await setup.draftFor(world({ [`${SECRET}/a.test.ts`]: '' }).$, `${ROOT}/${SECRET}`, [check({ argv: ['bun', 'test'] })], 'detected')
  expect(named.problem).toBe('what looks like a secret')
})

test('ordinary cases stay automatic', async () => {
  const typedCases: [string, Tree][] = [
    ['claude plugin test mods/os-deck', plugin('mods/os-deck/')],
    ['bun test', {}],
    ['bash tests/run_all.sh', RUNNABLE],
    ['node scripts/x.js', RUNNABLE],
    ['tsc --noEmit', {}],
  ]
  for (const [line, files] of typedCases) {
    const d = await typedDraft(line, files)
    expect([line, d.problem, d.manualOnly]).toEqual([line, null, null])
  }
  const bodies = [
    'jest', 'jest --ci --runInBand', 'tsc --noEmit', 'tsc -p tsconfig.build.json && vite build', 'eslint .', 'eslint src --max-warnings 0', 'prettier --check .',
    'vitest run', 'bun test', 'node scripts/x.js', 'bash tests/run_all.sh', 'claude plugin test .', 'pytest -q',
  ]
  for (const body of bodies) {
    const d = await bodyIn(body, RUNNABLE)
    expect([body, d.problem, d.manualOnly]).toEqual([body, null, null])
  }
})

test('ordinary cases stay unpaused: work on the code changes nothing watched', async () => {
  for (const line of ['bun test', 'npm run test', 'bash tests/run_all.sh', 'claude plugin test mods/m']) {
    const d = await typedDraft(line, { ...RUNNABLE, ...plugin('mods/m/'), 'package.json': pkg({ test: 'jest && eslint src && tsc --noEmit && vite build' }) })
    expect([line, d.problem]).toEqual([line, null])
    for (const work of ['src/index.ts', 'src', 'index.js', 'tests/a.test.ts', 'mods/m/hooks/register.tsx', 'mods/m/tests/a.test.ts', 'dist/index.js']) expect([line, work, watchOf(d).includes(work)]).toEqual([line, work, false])
  }
})

test('N1: a quote, which cmd and sh read as two things, is not understood', async () => {
  const bodies = [
    "node --test-name-pattern='a evil.cjs b' ok.js", "node ok.js 'a --run quiet -- b'", 'eslint "src/**/*.ts"', 'eslint src/**/*.ts', 'node ok.js $HOME', 'node ok.js %PATH%',
    'node ok.js; node x.js', 'node ok.js || node x.js', 'node ok.js | node x.js', 'node ok.js&&node x.js', 'node ok.js\tmore', 'node ok.js ~/x', 'node ok.js @args', 'node ok.js a,b',
    'np^m run quiet', 'node ok.js # note', '(node ok.js)', 'node ok.js `id`', 'node ok.js !x',
  ]
  for (const body of bodies) expect(await bodyRefused(body, RUNNABLE)).toEqual([body, true, ''])
})

test('N2: a program of node_modules/.bin, which npm puts first, is watched', async () => {
  const d = await bodyIn('bash tests/run_all.sh && tsc --noEmit', RUNNABLE)
  expect(d.problem).toBeNull()
  for (const name of ['bash', 'tsc', 'node', 'sh']) expect(d.watched).toContainEqual([`node_modules/.bin/${name}.*`, null])
  const inFolder = await draft({ 'app/package.json': pkg({ test: 'jest' }) }, [check({ dir: 'app' })])
  for (const path of ['app/node_modules/.bin/jest.*', 'node_modules/.bin/jest.*']) expect(watchOf(inFolder)).toContain(path)
})

test('N3: a config line not known to leave what runs alone is refused', async () => {
  const lines = [
    'usage=true', 'ignore-scripts=true', 'node-options=--require=./x.js', 'script-shell=sh', 'workspace=pkg', 'dry-run=true', '"usage"=true', 'usage', '[section]',
    'us${X}age=true', 'prefix=..', 'audit=${X}', 'IGNORE-SCRIPTS=true', 'ignore_scripts=true',
  ]
  for (const line of lines) expect([line, (await bodyIn('jest', { '.npmrc': `${line}\n` })).problem !== null]).toEqual([line, true])
  expect((await typedDraft('bun test', { 'bunfig.toml': '[test]\npreload = ["./pre.ts"]\n' })).problem).not.toBeNull()
})

test('H1: config that is harmless is shown whole, from the folder up to the root', async () => {
  const body = 'audit=false\r\n\tfund=false\r\n# note\r\n'
  const d = await draft({ '.npmrc': body, 'app/package.json': pkg({ test: 'jest' }) }, [check({ dir: 'app' })])
  expect(d.problem).toBeNull()
  expect(d.files).toEqual([{ path: '.npmrc', body }])
  expect(d.watched).toContainEqual(['.npmrc', await sha(body)])
})

test('N15: a token that only names a variable is no secret; a token is', async () => {
  const named = ['//registry.npmjs.org/:_auth', 'Token=${NPM_TOKEN}\n'].join('')
  expect((await bodyIn('jest', { '.npmrc': named })).problem).toBeNull()
  const real = ['//registry.npmjs.org/:_auth', `Token=${SECRET}\n`].join('')
  expect((await bodyIn('jest', { '.npmrc': real })).problem).not.toBeNull()
})

test('N4: node reads a manifest otherwise, so node never runs a script', async () => {
  for (const body of ['node --run quiet', 'node --run=quiet', 'node --require ./x.js ok.js', 'node -r setup ok.js', 'node -e 0', 'node --test tools/check'])
    expect(await bodyRefused(body, RUNNABLE, { quiet: 'jest' })).toEqual([body, true, ''])
})

test('N5: what cmd reads as another command is not understood', async () => {
  const bodies = ['cmd/c sh tools/lint', 'cmd/c exit 0', 'turbo/x run quiet', 'node >o,evil.cjs ok.js', 'node ok.js > out.txt', 'exit=0 node ok.js', 'NODE_ENV=test jest', './x.sh', 'NODE ok.js', 'node.exe ok.js']
  for (const body of bodies) expect(await bodyRefused(body, RUNNABLE)).toEqual([body, true, ''])
})

test('N6: an option is never taken for the file', async () => {
  for (const body of ['sh +e tools/lint', 'bash +x tools/lint', 'bash -c jest', 'sh -e tools/lint', 'node tools/lint', 'node 10>f tools/lint']) expect(await bodyRefused(body, RUNNABLE)).toEqual([body, true, ''])
  for (const line of ['bash +x tools/lint', 'node tools/lint', 'node missing.js', 'bash missing.sh', 'node node_modules/npm/bin/npm-cli.js', 'node ../x.js']) expect([line, (await typedDraft(line, RUNNABLE)).problem !== null]).toEqual([line, true])
})

test('N7: what starts or fetches another package is refused, not offered', async () => {
  const lines = ['npx -y tools/lint', 'npx tsc', 'bunx tsc', 'pnpm run test', 'yarn test', 'bun run test', 'npm exec tsc', 'npm ci', 'npm run test -- --watch', 'corepack pnpm test', 'turbo lint', 'cmd /c x']
  for (const line of lines) {
    expect([line, (await typedDraft(line, { ...RUNNABLE, 'package.json': pkg({ test: 'jest' }) })).problem !== null]).toEqual([line, true])
    expect(await bodyRefused(line, RUNNABLE)).toEqual([line, true, ''])
  }
})

test('a flag that makes a tool do nothing is no check', async () => {
  for (const body of ['tsc --help', 'tsc --version', 'eslint --print-config x.js', 'jest --listTests', 'jest --passWithNoTests', 'prettier .', 'vitest', 'biome --version', 'bun test --preload=./x.ts', 'claude --version'])
    expect(await bodyRefused(body, RUNNABLE)).toEqual([body, true, ''])
})

test('a program that is not known runs by hand alone, and says so', async () => {
  for (const [body, program] of [['cargo check', 'cargo'], ['rimraf dist && tsc', 'rimraf'], ['make lint', 'make']] as const) {
    const d = await bodyIn(body)
    expect([body, d.problem, d.manualOnly]).toEqual([body, null, `test: what ${program} runs is not known`])
  }
  expect((await typedDraft('cargo check')).manualOnly).toBe('test: what cargo runs is not known')
})

test('a plugin’s manifests, however the folder is spelled, and hooks it names', async () => {
  for (const [arg, base] of [['.', ''], ['mods/m', 'mods/m/'], ['mods/m/', 'mods/m/'], ['./mods/m', 'mods/m/']] as const) {
    const d = await typedDraft(`claude plugin test ${arg}`, { [`${base}.claude-plugin/plugin.json`]: '{"hooks":"./hooks/own.json"}', [`${base}hooks/own.json`]: '{}' })
    expect([arg, d.problem, d.manualOnly]).toEqual([arg, null, null])
    for (const path of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/own.json']) expect([arg, watchOf(d).includes(`${base}${path}`)]).toEqual([arg, true])
  }
})

test('tsconfig named to a project is watched', async () => {
  expect(watchOf(await bodyIn('tsc -p config/ts.json'))).toContain('config/ts.json')
  expect(watchOf(await bodyIn('tsc --project config'))).toContain('config/tsconfig.json')
})

test('the grammar is of the whole body, an unknown program’s as well', async () => {
  // Manual only says the program is not known, never that a line no shell reads one way was shown.
  for (const body of ['cargo check; node x.js', 'cargo check | tee log', 'make "lint all"']) expect(await bodyRefused(body, RUNNABLE)).toEqual([body, true, ''])
})

test('a typed program of the grammar takes plain words alone', async () => {
  for (const line of ['node ok.js a,b', 'bash tests/run_all.sh a;b', 'tsc =x']) expect([line, (await typedDraft(line, RUNNABLE)).problem !== null]).toEqual([line, true])
})

test('an option that is also the name of a file is still an option', async () => {
  const named: Tree = { '-r.js': '', '-x': '' }
  for (const line of ['node -r.js', 'bash -x']) expect([line, (await typedDraft(line, named)).problem !== null]).toEqual([line, true])
})
