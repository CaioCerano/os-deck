import type { EngineInterface } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { samePath } from '../hooks/proof/revision'
import { draftFor } from '../hooks/proof/setup'
import { changedOnDisk, keyOf, pathFrom } from '../hooks/proof/watched'

// Names resolved as npm, cmd and NTFS resolve them, on a whole disk with the repository in a folder of it.

const ROOT = 'C:/work/repo'
const KELVIN = String.fromCodePoint(0x212a)
const check = (argv: string[] = ['npm', 'run', 'lint'], dir = '') => ({ id: 'lint', kind: 'lint' as const, description: '', argv, dir, timeoutS: 60, required: true })
const pkg = (body: string) => JSON.stringify({ scripts: { lint: body } })

const disk = (files: Record<string, string>, links: Record<string, string> = {}) => {
  const list = async (path: string) => {
    const at = `${path.replace(/\/+$/, '')}/`
    const found = new Map<string, unknown>()
    for (const file of [...Object.keys(files), ...Object.keys(links)]) {
      if (!file.startsWith(at)) continue
      const [name = '', ...more] = file.slice(at.length).split('/')
      const isLink = more.length === 0 && file in links
      found.set(name, { name, kind: more.length ? 'dir' : isLink ? 'other' : 'file', size: more.length || isLink ? 0 : files[file]!.length, mtimeMs: 1, isLink })
    }
    return [...found.values()]
  }
  const read = async (path: string) => {
    // Reading follows a link; one that leads to nothing held here is an empty program.
    const text = files[path] ?? (path in links ? (files[links[path]!] ?? '') : null)
    if (text === null) throw new Error('ENOENT')
    return { base64: btoa(String.fromCharCode(...new TextEncoder().encode(text))) }
  }
  const stat = async (path: string) => ({ kind: 'file', size: 1, mtimeMs: 1, isLink: path in links, realPath: links[path] ?? path })
  return { fs: { list, read, stat } } as unknown as EngineInterface
}
const repo = (more: Record<string, string> = {}) => ({ [`${ROOT}/package.json`]: pkg('tsc --noEmit'), ...more })
const draft = (files: Record<string, string>, c = check(), links: Record<string, string> = {}) => draftFor(disk(files, links), ROOT, [c], 'detected')

/** What was watched at the press, against the disk as it is then. */
const changedBy = async (later: Record<string, string>) => {
  const files = repo()
  const d = await draft(files)
  expect(d.problem).toBe(null)
  return changedOnDisk(disk({ ...files, ...later }), ROOT, d.watched)
}

test('A1: under a workspace of a folder above, npm is refused', async () => {
  for (const at of ['C:/work', 'C:'])
    for (const manifest of ['{"workspaces":["repo"]}', '{"workspaces":', JSON.stringify({ workspaces: { packages: ['*'] } })])
      expect([at, manifest, (await draft(repo({ [`${at}/package.json`]: manifest }))).problem !== null]).toEqual([at, manifest, true])
})

test('A1: a manifest appearing above the root is a change', async () => {
  expect((await changedBy({ 'C:/work/package.json': '{"workspaces":["repo"]}' })).length).toBe(1)
  expect((await changedBy({ 'C:/package.json': '{}' })).length).toBe(1)
})

test('A2: a program planted in a folder above the root is a change', async () => {
  for (const path of ['C:/work/node_modules/.bin/node.exe', 'C:/node_modules/.bin/tsc.cmd', 'C:/work/node_modules/.bin/sh'])
    expect([path, (await changedBy({ [path]: 'x' })).length > 0]).toEqual([path, true])
})

test('A3: a program planted under any extension is a change', async () => {
  for (const ext of ['', '.js', '.vbs', '.PY', '.cpl', '.anything']) {
    const path = `${ROOT}/node_modules/.bin/tsc${ext}`
    expect([ext, (await changedBy({ [path]: 'x' })).length > 0]).toEqual([ext, true])
  }
  expect(await changedBy({ [`${ROOT}/node_modules/.bin/tscx.cmd`]: 'x' })).toEqual([])
})

test('a program that is a link, as npm installs off Windows, is bound by where it leads', async () => {
  const top = '/work/repo'
  const at = `${top}/node_modules/.bin/tsc`
  const held = { [`${top}/package.json`]: pkg('tsc --noEmit') }
  const d = await draftFor(disk(held, { [at]: `${top}/node_modules/typescript/bin/tsc` }), top, [check()], 'detected')
  expect(d.problem).toBe(null)
  expect((await changedOnDisk(disk(held, { [at]: '/elsewhere/tsc' }), top, d.watched)).length).toBe(1)
})

test('A4: only ASCII case is folded', async () => {
  expect(samePath(`C:/wor${KELVIN}/repo`, 'C:/work/repo')).toBe(false)
  expect(samePath('c:/WORK/repo', 'C:/work/Repo')).toBe(false)
  expect(samePath('c:/work/Repo', 'C:/work/Repo')).toBe(true)
  expect(keyOf(`pac${KELVIN}age.json`)).not.toBe(keyOf('package.json'))
  expect((await draft({ [`${ROOT}/chec${KELVIN}.sh`]: 'exit 1' }, check(['bash', 'check.sh']))).problem).not.toBe(null)
  expect((await draft({ [`${ROOT}/package.json`]: pkg('jest'), [`${ROOT}/sub/pac${KELVIN}age.json`]: pkg('tsc --noEmit') }, check(['npm', 'run', 'lint'], 'sub'))).problem).not.toBe(null)
})

test('A4: off Windows another case is another file', async () => {
  const $ = disk({ '/work/repo/Check.sh': 'exit 1' })
  expect((await draftFor($, '/work/repo', [check(['bash', 'check.sh'])], 'typed')).problem).not.toBe(null)
})

test('tsc takes a project named by a file of any name', async () => {
  const d = await draft({ [`${ROOT}/tsconfig.strict`]: '{}' }, check(['tsc', '-p', 'tsconfig.strict']))
  expect(d.watched.map(([path]) => path)).toContain('tsconfig.strict')
})

test('a plugin manifest that cannot be read whole is refused', async () => {
  const d = await draft({ [`${ROOT}/.claude-plugin/plugin.json`]: '{"hooks":' }, check(['claude', 'plugin', 'test', '.']))
  expect(d.problem).not.toBe(null)
})

test('R5: a folder name that splits npm’s PATH is refused', async () => {
  for (const [at, dir] of [['C:/work/a;b/repo', ''], ['C:/work/repo', 'x;y'], ['/work/a:b/repo', '']] as const) {
    const $ = disk({ [`${at}/${dir ? `${dir}/` : ''}package.json`]: pkg('tsc --noEmit') })
    expect([at, (await draftFor($, at, [check(['npm', 'run', 'lint'], dir)], 'detected')).problem !== null]).toEqual([at, true])
  }
})

test('installed shims above the root are bound, not refused', async () => {
  const files = repo({ 'C:/work/node_modules/.bin/node.cmd': 'x', 'C:/node_modules/.bin/tsc': 'x' })
  const d = await draft(files)
  expect(d.problem).toBe(null)
  expect((await changedOnDisk(disk({ ...files, 'C:/work/node_modules/.bin/node.cmd': 'y' }), ROOT, d.watched)).length).toBe(1)
})

test('a file named like the pattern itself does not recurse', async () => {
  const at = '/work/repo'
  const $ = disk({ [`${at}/package.json`]: pkg('tsc --noEmit'), [`${at}/node_modules/.bin/node.*`]: 'x' })
  expect((await draftFor($, at, [check()], 'detected')).problem).toBe(null)
})

test('a linked program is bound by the bytes it leads to', async () => {
  const top = '/work/repo'
  const at = `${top}/node_modules/.bin/tsc`
  const to = `${top}/tools/tsc`
  const holding = (text: string) => disk({ [`${top}/package.json`]: pkg('tsc --noEmit'), [to]: text }, { [at]: to })
  const d = await draftFor(holding('one'), top, [check()], 'detected')
  expect(d.problem).toBe(null)
  expect((await changedOnDisk(holding('two'), top, d.watched)).length).toBe(1)
})

test('C3: on Windows no link is followed before a press: it could lead to a share', async () => {
  const at = `${ROOT}/node_modules/.bin/tsc`
  const $ = disk(repo(), { [at]: 'C:/anywhere/tsc' })
  const followed: string[] = []
  const { stat } = $.fs
  ;($ as unknown as { fs: { stat: unknown } }).fs.stat = (...args: Parameters<typeof stat>) => (followed.push(String(args[0])), stat(...args))
  expect((await draftFor($, ROOT, [check()], 'detected')).problem).toContain('it is a link')
  expect(followed).toEqual([])
})

test('V1: off Windows a backslash is a letter of a name, never a separator', async () => {
  expect(samePath('/w\\repo', '/w/repo')).toBe(false)
  expect(samePath('C:\\w\\repo\\', 'C:/w/repo')).toBe(true)
  // The top of the repository is /work/a\b, whose folders above are /work and /.
  const top = '/work/a\\b'
  const d = await draftFor(disk({ [`${top}/package.json`]: pkg('tsc --noEmit') }), top, [check()], 'detected')
  expect(d.problem).toBe(null)
  expect(d.watched.map(([path]) => path).filter(path => path.startsWith('/work/a|'))).toEqual([])
})

test('W1: a bar in the name of a folder above does not hide what is in it', async () => {
  for (const top of ['/w|x/repo', '/home/|x/repo', '/w|x|y/repo']) {
    const above = top.slice(0, top.lastIndexOf('/'))
    const files = { [`${top}/package.json`]: pkg('tsc --noEmit') }
    const d = await draftFor(disk(files), top, [check()], 'detected')
    expect([top, d.problem]).toEqual([top, null])
    for (const planted of ['node_modules/.bin/tsc', 'node_modules/.bin/node', 'package.json'])
      expect([top, planted, (await changedOnDisk(disk({ ...files, [`${above}/${planted}`]: '{}' }), top, d.watched)).length]).toEqual([top, planted, 1])
    const under = await draftFor(disk({ ...files, [`${above}/package.json`]: '{"workspaces":["repo"]}' }), top, [check()], 'detected')
    expect([top, under.problem !== null]).toEqual([top, true])
  }
})

test('off Windows two files that differ only in case are refused, not watched as one', async () => {
  const top = '/work/repo'
  const held = { [`${top}/tools/run.sh`]: 'one', [`${top}/Tools/run.sh`]: 'two' }
  const both = [{ ...check(['bash', 'tools/run.sh']), id: 'lint' }, { ...check(['bash', 'Tools/run.sh']), id: 'lint-two' }]
  const d = await draftFor(disk(held), top, both, 'typed')
  expect(d.problem).toContain('case')
})

test('X1: what runs is named as the disk spells it, as a folder of Windows can be case-sensitive', async () => {
  const lone = { [`${ROOT}/tools/check.js`]: '' }
  for (const path of ['tools/Check.js', 'Tools/check.js']) expect([path, (await draft(lone, check(['node', path]))).problem !== null]).toEqual([path, true])
  const script = { [`${ROOT}/check.js`]: '', [`${ROOT}/package.json`]: pkg('node check.js && node Check.js') }
  expect((await draft(script)).problem).not.toBe(null)
  expect((await draft({ [`${ROOT}/Package.json`]: pkg('tsc --noEmit') })).problem).not.toBe(null)
  expect((await draft(lone, check(['node', 'tools/check.js']))).problem).toBe(null)
})

test('Z1: an absolute path into a twin one case apart is outside, the drive’s letter aside', async () => {
  for (const twin of ['C:/x/Repo/check.js', 'C:/X/repo/check.js', 'c:\\x\\REPO\\check.js']) expect([twin, pathFrom('C:/x/repo', '', twin)]).toEqual([twin, 'outside'])
  expect(pathFrom('C:/x/repo', '', 'c:\\x\\repo\\check.js')).toEqual({ path: 'check.js' })
})

test('Z1: two spellings in one check are two paths to watch', async () => {
  const held = { [`${ROOT}/a.json`]: '{}' }
  expect((await draft(held, check(['tsc', '-p', 'a.json']))).problem).toBe(null)
  expect((await draft(held, check(['tsc', '-p', 'a.json', '-p', 'A.json']))).problem).not.toBe(null)
})
