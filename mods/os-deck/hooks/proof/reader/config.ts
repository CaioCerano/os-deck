// What of a repository configures the two runners understood: shown whole, and only where every line
// of it is known to leave what runs alone.
import { joined, keyOf } from '../watched'
import { NPMRC_HARMLESS } from './known'
import { Unshown, chainOf, refuse } from './reading'
import type { Reading } from './reading'
import { fileProblem, textOf } from './text'

async function showConfig(r: Reading, path: string): Promise<string | null> {
  const read = await r.disk.file(path)
  if (read.kind === 'problem') throw new Unshown(`${path} cannot be watched: ${read.why}`)
  if (read.kind !== 'file') return null
  const body = textOf(read.bytes)
  if (!r.found.files.has(keyOf(path))) {
    const bad = fileProblem(body)
    if (bad) throw new Unshown(`${path} ${bad}`)
    r.found.files.set(keyOf(path), { path, body })
  }
  return body
}

/** One line of an .npmrc that cannot change what runs. */
const isHarmless = (line: string): boolean => {
  if (line === '' || line.startsWith('#') || line.startsWith(';')) return true
  if (/^\/\/[\w.:/-]+:_authToken=(?:\$\{[A-Za-z_]\w*\})$/.test(line) || /^@[a-z0-9._-]+:registry=[\w.:/-]+$/.test(line)) return true
  const m = /^([a-z-]+) ?= ?[\w.:/@^~-]*$/.exec(line)
  return m !== null && NPMRC_HARMLESS.includes(m[1] as string)
}

export async function readNpmConfig(r: Reading): Promise<void> {
  for (const dir of chainOf(r.check.dir)) {
    const path = joined(dir, '.npmrc')
    const body = await showConfig(r, path)
    if (body === null) continue
    for (const line of body.split(/\r\n|\r|\n/)) if (!isHarmless(line.trim())) refuse({ ...r, where: path }, 'a setting in it is not one known to leave what runs alone')
  }
}

export async function readBunConfig(r: Reading, dir: string): Promise<void> {
  for (const at of chainOf(dir)) {
    const path = joined(at, 'bunfig.toml')
    const body = await showConfig(r, path)
    // An escape can spell the word.
    if (body !== null && /preload|\\/i.test(body)) refuse({ ...r, where: path }, 'it can load code before the tests')
  }
}
