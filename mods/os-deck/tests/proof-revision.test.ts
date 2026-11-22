import type { EngineInterface } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { changedPaths, oddPath, readRevision } from '../hooks/proof/revision'

type World = { index?: string[]; others?: string[]; deleted?: string[]; top?: string; links?: string[]; absent?: string[]; truncated?: boolean; hashes?: string; exclude?: Error }
const row = (path: string, mode = '100644', stage = '0') => `${mode} ${'a'.repeat(40)} ${stage}\t${path}`
const nul = (xs: string[]) => xs.map(x => `${x}\0`).join('')

/**
 * A repository at /repo as git and the disk would describe it, and every git call made of it. A plain
 * object: the kit's own `$` raises events and has no process or fs to pass to a function.
 */
const world = (w: World = {}) => {
  const index = w.index ?? [row('a.ts'), row('src/b.ts')]
  const paths = [...index.map(r => r.slice(r.indexOf('\t') + 1)), ...(w.others ?? [])]
  const calls: { argv: string[]; stdin?: string }[] = []
  const run = async (argv: string[], init?: { stdin?: string }) => {
    calls.push({ argv, stdin: init?.stdin })
    const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: '', isStdoutTruncated: w.truncated === true && argv.includes('--stage') })
    if (argv.includes('--show-toplevel')) return ok(`${w.top ?? '/repo'}\n`)
    if (argv.includes('--git-path')) return ok('.git/info/exclude\n')
    if (argv.includes('--stage')) return ok(nul(index))
    if (argv.includes('--others')) return ok(nul(w.others ?? []))
    if (argv.includes('--deleted')) return ok(nul(w.deleted ?? []))
    if (argv.includes('config')) return { ...ok(''), exitCode: 1 }
    if (argv.includes('hash-object')) return ok(w.hashes ?? paths.filter(p => !w.absent?.includes(p)).map(() => `${'b'.repeat(40)}\n`).join(''))
    return ok(`${'c'.repeat(40)}\n`)
  }
  const read = async () => {
    if (w.exclude) throw w.exclude
    return ''
  }
  const list = async (path: string) => {
    const dir = path.replace(/\\/g, '/').replace(/^.*?\/repo\/?/, '')
    const found = new Map<string, { name: string; kind: string; isLink: boolean }>()
    for (const p of paths) {
      if (w.absent?.includes(p) || (dir && !p.startsWith(`${dir}/`))) continue
      const [name = '', ...rest] = (dir ? p.slice(dir.length + 1) : p).split('/')
      const full = dir ? `${dir}/${name}` : name
      const isLink = w.links?.includes(full) === true
      found.set(name, { name, kind: isLink ? 'other' : rest.length ? 'dir' : 'file', isLink })
    }
    return [...found.values()]
  }
  return { $: { process: { run }, fs: { read, list } } as unknown as EngineInterface, calls }
}

test('a plain repository has a revision, hashed with no filter', async () => {
  const { $, calls } = world()
  const r = await readRevision($, '/repo')
  expect(r.ok ? 'ok' : r.reason).toBe('ok')
  if (r.ok) {
    expect(r.revision).toMatch(/^[0-9a-f]{64}$/)
    expect([...r.hashes.keys()]).toEqual(['a.ts', 'src/b.ts'])
  }
  const hashing = calls.filter(c => c.argv.includes('hash-object'))
  expect(hashing.length).toBe(1)
  expect(hashing[0]?.argv).toContain('--no-filters')
  expect(hashing[0]?.stdin).toBe('a.ts\nsrc/b.ts\n')
  for (const c of calls) {
    expect(c.argv).toContain('safe.bareRepository=explicit')
    for (const banned of ['status', 'diff', 'diff-files', '--modified', '-m']) expect(c.argv).not.toContain(banned)
  }
})

const unavailable: [string, World, string][] = [
  ['below the top', { top: '/' }, 'top of a git'],
  ['a conflict', { index: [row('a.ts', '100644', '1')] }, 'merge conflict'],
  ['a tracked link', { index: [row('lnk', '120000')] }, 'a link'],
  ['a submodule', { index: [row('sub', '160000')] }, 'submodule'],
  ['a link on the way', { links: ['src'] }, 'a link'],
  ['a file turned into a link', { links: ['a.ts'] }, 'a link'],
  ['a nested repository', { others: ['inner/'] }, 'nested'],
  ['a name with a line break', { others: ['a\nb'] }, 'read differently'],
  ['a name starting with a quote', { others: ['"a"'] }, 'read differently'],
  ['a name ending in CR', { others: ['a\r'] }, 'read differently'],
  ['a name that is not UTF-8', { others: ['a\ufffd'] }, 'not UTF-8'],
  ['a truncated listing', { truncated: true }, 'list it whole'],
  ['a file git sees and the disk does not', { absent: ['a.ts'] }, 'disagree'],
  ['fewer hashes than files', { hashes: `${'b'.repeat(40)}\n` }, 'all be hashed'],
  ['an unreadable exclude file', { exclude: new Error('EACCES') }, 'exclude'],
]
for (const [name, w, reason] of unavailable)
  test(`no revision for ${name}`, async () => {
    const { $ } = world(w)
    const r = await readRevision($, '/repo')
    // By its own guard, not by falling over on the way.
    expect(r.ok ? 'ok' : r.reason).toContain(reason)
  })

test('a deleted file leaves a revision without it', async () => {
  const { $ } = world({ absent: ['a.ts'], deleted: ['a.ts'] })
  const r = await readRevision($, '/repo')
  expect(r.ok ? [...r.hashes.keys()].join() : r.reason).toBe('src/b.ts')
})

test('a network root is never read', async () => {
  const { $, calls } = world()
  for (const root of ['//host/share', '\\\\host\\share', 'relative']) expect((await readRevision($, root)).ok).toBe(false)
  expect(calls).toEqual([])
})

test('paths that leave the repository are refused', () => {
  for (const p of ['../x', 'a/../../x', '/etc/passwd', 'C:/x']) expect(oddPath(p)).not.toBeNull()
  for (const p of ['a..b', 'src/b.ts', 'Implementação.md', '-dash']) expect(oddPath(p)).toBeNull()
})

test('changes list edits, additions and deletions', () => {
  expect(changedPaths(new Map([['a', '1'], ['b', '1'], ['c', '1']]), new Map([['a', '1'], ['b', '2'], ['d', '1']]))).toEqual([{ path: 'b', hash: '2' }, { path: 'c', hash: null }, { path: 'd', hash: '1' }])
})
