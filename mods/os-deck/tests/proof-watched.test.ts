import type { EngineInterface } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { changedOnDisk, readWatched } from '../hooks/proof/watched'

// C1: what a check runs is read from the disk, whatever git lists.

const ROOT = '/repo'
const MAX = 4 * 1024 * 1024 - 1
type Odd = { links?: string[]; others?: string[]; sizes?: Record<string, number>; failList?: string[]; failRead?: string[]; grown?: string[]; extra?: Record<string, string[]>; root?: string }

const bytesOf = (text: string) => new TextEncoder().encode(text)
const sha = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as never))].map(b => b.toString(16).padStart(2, '0')).join('')

const world = (files: Record<string, Uint8Array | string>, odd: Odd = {}) => {
  const root = odd.root ?? ROOT
  const seen = { ran: 0, reads: [] as string[], lists: [] as string[], lengths: [] as number[] }
  const inRoot = (path: string) => (path === root ? '' : path.slice(root.length + 1))
  const ran = () => {
    seen.ran += 1
    throw new Error('no process before a press')
  }
  const $ = {
    process: { run: ran, spawn: ran },
    fs: {
      list: async (path: string) => {
        const dir = inRoot(path)
        seen.lists.push(dir)
        if (odd.failList?.includes(dir)) throw new Error('EACCES')
        const prefix = dir ? `${dir}/` : ''
        const below = Object.keys(files).filter(p => p.startsWith(prefix))
        if (dir && below.length === 0) throw new Error('ENOENT')
        const names = [...new Set(below.map(p => p.slice(prefix.length).split('/')[0] as string)), ...(odd.extra?.[dir] ?? [])]
        return names.map(name => {
          const at = prefix + name
          const isLink = odd.links?.includes(at) === true
          const held = files[at]
          const kind = isLink || odd.others?.includes(at) ? 'other' : held !== undefined ? 'file' : 'dir'
          return { name, kind, isLink, mtimeMs: 7, size: kind === 'file' ? (odd.sizes?.[at] ?? held?.length ?? 0) : 0 }
        })
      },
      read: async (path: string, options: { as?: string; length?: number }) => {
        const at = inRoot(path)
        seen.reads.push(at)
        seen.lengths.push(options.length ?? -1)
        if (options.as !== 'bytes') throw new Error('watched content is bytes')
        const held = files[at]
        if (held === undefined || odd.failRead?.includes(at)) throw new Error('ENOENT')
        if (odd.grown?.includes(at)) return { base64: btoa(' '.repeat(MAX + 1)) }
        const bytes = typeof held === 'string' ? bytesOf(held) : held
        return { base64: btoa([...bytes].map(b => String.fromCharCode(b)).join('')) }
      },
    },
  } as unknown as EngineInterface
  return { $, seen }
}

const readOne = async (files: Record<string, Uint8Array | string>, path: string, odd?: Odd) => readWatched(world(files, odd).$, odd?.root ?? ROOT, [path])

test('the hash is of the raw bytes, and reading starts no process', async () => {
  const raw = new Uint8Array([0, 255, 254, 13, 10, 0xc3, 0x28])
  const w = world({ 'local/lint.js': raw })
  const got = await readWatched(w.$, ROOT, ['local/lint.js'])
  expect(got.watched).toEqual([['local/lint.js', await sha(raw)]])
  expect(got.problems).toEqual([])
  expect([w.seen.ran, w.seen.lengths]).toEqual([0, [MAX + 1]])
})

test('two byte strings that decode to one text are two hashes', async () => {
  const a = await readOne({ x: new Uint8Array([0xff]) }, 'x')
  const b = await readOne({ x: new Uint8Array([0xfe]) }, 'x')
  expect(typeof a.watched[0]?.[1]).toBe('string')
  expect(a.watched[0]?.[1]).not.toBe(b.watched[0]?.[1])
})

test('absence is null, at any depth', async () => {
  const got = await readWatched(world({ 'a.txt': 'x' }).$, ROOT, ['.npmrc', 'no/such/lint.js', 'a.txt/under', ''].filter(Boolean))
  expect(got.watched).toEqual([['.npmrc', null], ['no/such/lint.js', null], ['a.txt/under', null]])
  expect(got.problems).toEqual([])
})

test('a name matches in any case on disk', async () => {
  const got = await readOne({ 'Local/Lint.JS': 'x' }, 'local/lint.js')
  expect(got.watched).toEqual([['local/lint.js', await sha(bytesOf('x'))]])
})

test('what cannot be known is a problem, and no hash', async () => {
  const cases: [Record<string, string>, string, Odd, string][] = [
    [{ 'lint.js': 'x' }, 'lint.js', { links: ['lint.js'] }, 'it is a link'],
    [{ 'local/lint.js': 'x' }, 'local/lint.js', { links: ['local'] }, 'it is a link'],
    [{ 'local/a': 'x' }, 'local/absent.js', { links: ['local'] }, 'it is a link'],
    [{ 'lint.js': 'x' }, 'lint.js', { others: ['lint.js'] }, 'it is no regular file'],
    [{ 'lint.js': 'x' }, 'lint.js', { sizes: { 'lint.js': MAX + 1 } }, 'it is too large to read whole'],
    [{ 'lint.js': 'x' }, 'lint.js', { grown: ['lint.js'] }, 'it is too large to read whole'],
    [{ 'lint.js': 'x' }, 'lint.js', { failRead: ['lint.js'] }, 'it cannot be read'],
    [{ 'lint.js': 'x' }, 'lint.js', { failList: [''] }, 'its folder cannot be read'],
    [{ 'lint.js': 'x' }, 'lint.js', { extra: { '': ['Lint.js'] } }, 'two names differ only in case'],
  ]
  for (const [files, path, odd, why] of cases) {
    const got = await readOne(files, path, odd)
    expect([path, got.watched, got.problems]).toEqual([path, [], [[path, why]]])
  }
})

test('no link is read or listed through', async () => {
  const w = world({ 'out/lint.js': 'x' }, { links: ['out'] })
  expect((await readWatched(w.$, ROOT, ['out/lint.js'])).problems.length).toBe(1)
  expect([w.seen.reads, w.seen.lists.includes('out')]).toEqual([[], false])
})

test('a path that Windows would open as another, or outside the root, is a problem', async () => {
  for (const path of ['/etc/passwd', '../x', 'a/../../x', 'C:/x', '//host/share', 'lint.js.', 'lint.js::$DATA', 'NUL', 'LINT~1.JS', '', '.']) {
    const got = await readOne({ 'lint.js': 'x' }, path)
    expect([path, got.watched, got.problems]).toEqual([path, [], [[path, 'a path not understood']]])
  }
})

test('size and time are kept beside the hash', async () => {
  expect((await readOne({ a: 'xy' }, 'a')).stamps.get('a')).toBe('2:7')
})

test('changed: content, appearing, going, and what cannot be read', async () => {
  const allowed = (await readWatched(world({ a: '1', b: '1', same: '1', c: '1' }).$, ROOT, ['a', 'b', 'same', 'c', '.npmrc'])).watched
  const now = world({ a: '2', same: '1', c: '1', '.npmrc': 'node-options=--require=./evil.js' }, { links: ['c'] })
  expect(await changedOnDisk(now.$, ROOT, allowed)).toEqual(['a', 'b', 'c', '.npmrc'])
})

test('nothing changed is no path', async () => {
  const files = { '.npmrc': 'audit=false', 'local/lint.js': 'x' }
  const allowed = (await readWatched(world(files).$, ROOT, ['.npmrc', 'local/lint.js', 'gone.js'])).watched
  expect(allowed.length).toBe(3)
  expect(await changedOnDisk(world(files).$, ROOT, allowed)).toEqual([])
})

test('a root that cannot be read changes everything', async () => {
  const w = world({}, { failList: [''] })
  expect(await changedOnDisk(w.$, ROOT, [['a', null], ['b', 'x']])).toEqual(['a', 'b'])
  expect(await changedOnDisk({} as EngineInterface, ROOT, [['a', null]])).toEqual(['a'])
})

test('what was kept in state and is no path is changed, not a throw', async () => {
  expect(await changedOnDisk(world({}).$, ROOT, [[5, 'x']] as never)).toEqual([5] as never)
})
