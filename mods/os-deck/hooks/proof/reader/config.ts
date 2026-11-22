// What of a repository configures a runner: shown whole, with what it names watched.
import { joined, keyOf } from '../watched'
import { CHANGES_WHAT_RUNS, CODE_IN_TEXT, CONFIG, ENV_FILES, LOADED, NPMRC_REDIRECTS, PNPM_REDIRECTS, SAFE_ENV, YARN_PATH, YARN_REDIRECTS } from './known'
import { literal } from './line'
import { Unshown, chainOf, looksLikePath, readNodeFlags, refuse, watch, watchTarget } from './reading'
import type { Reading } from './reading'
import { fileProblem, textOf } from './text'

async function showConfig(r: Reading, path: string): Promise<string | null> {
  const read = await r.disk.file(path)
  if (read.kind !== 'file') return null
  const body = textOf(read.bytes)
  if (!r.found.files.has(keyOf(path))) {
    const bad = fileProblem(body)
    if (bad) throw new Unshown(`${path} ${bad}`)
    r.found.files.set(keyOf(path), { path, body })
  }
  return body
}

async function readNpmrc(r: Reading, path: string, body: string): Promise<void> {
  const at = { ...r, where: path }
  for (const raw of body.split(/[\r\n]+/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const cut = line.indexOf('=')
    const name = cut < 0 ? line : line.slice(0, cut)
    if (name.includes('${')) refuse(at, 'it expands the name of a setting')
    // A quoted name is read as JSON, escapes and all; after ; or # is a comment.
    if (name.includes('\\')) refuse(at, 'it escapes the name of a setting')
    const key = (name.split(/[;#]/)[0] as string).replace(/["'\s]/g, '').replace(/\[\]$/, '').replace(/^-+/, '').replace(/_/g, '-').toLowerCase()
    if (NPMRC_REDIRECTS.includes(key)) refuse(at, `it sets ${key}, which changes what runs`)
    if (key !== 'node-options') continue
    const value = line.slice(cut + 1).trim().replace(/^"(.*)"$/, '$1')
    if (cut < 0 || /["'$\\;#]/.test(value)) refuse(at, 'its node-options cannot be understood')
    const args = value.split(/\s+/).filter(Boolean).map(literal)
    const flags = await readNodeFlags(at, args)
    if (flags.script !== null || flags.isTest || flags.at !== args.length) refuse(at, 'its node-options cannot be understood')
    for (const load of flags.loads) r.own.preloads.add(load)
  }
}

/** What of the repository configures a runner: shown whole, with what it names watched. */
export async function readConfig(r: Reading, tool: string): Promise<void> {
  for (const dir of chainOf(r.cwd)) {
    for (const name of CONFIG[tool] ?? []) {
      const path = joined(dir, name)
      const body = await showConfig(r, path)
      if (body === null) continue
      const at = { ...r, where: path }
      const lines = body.split('\n').filter(line => !/^\s*#/.test(line))
      const named: string[] = []
      if (name === '.npmrc') await readNpmrc(r, path, body)
      if (name !== '.npmrc' && tool in ENV_FILES && lines.some(line => line.includes('\\'))) refuse(at, 'it escapes what it says')
      if (name === 'pnpm-workspace.yaml' && lines.some(line => PNPM_REDIRECTS.test(line))) refuse(at, 'a setting in it changes what runs')
      if (name.startsWith('.yarnrc')) {
        for (const line of lines) {
          if (YARN_REDIRECTS.test(line)) refuse(at, 'a setting in it changes what runs')
          if (/\byarn-?path\b/i.test(line)) {
            const m = YARN_PATH.exec(line)
            const value = m?.[1] ?? m?.[2] ?? m?.[3]
            if (!value) return refuse(at, 'the program it names cannot be told')
            named.push(value)
          }
          for (const m of line.matchAll(CODE_IN_TEXT)) named.push(m[0])
        }
      }
      if (name === 'bunfig.toml' && lines.some(line => /\bpreload\b/.test(line)))
        for (const line of lines)
          for (const m of line.matchAll(/["']([^"'\n]+)["']/g)) if (/\bpreload\b/.test(line) || looksLikePath(m[1] as string)) named.push(m[1] as string)
      for (const value of new Set(named)) await watchTarget({ ...at, cwd: dir }, value, 'module')
    }
    for (const name of LOADED[tool] ?? []) watch(r, joined(dir, name))
    for (const name of ENV_FILES[tool] ?? []) {
      const path = joined(dir, name)
      watch(r, path)
      const read = await r.disk.file(path)
      if (read.kind !== 'file') continue
      for (const line of textOf(read.bytes).split(/[\r\n]+/)) {
        const key = /^\s*(?:export\s+)?["']?([A-Za-z_][\w-]*)/.exec(line)?.[1]
        if (key && !SAFE_ENV.includes(key.toUpperCase()) && CHANGES_WHAT_RUNS.test(key)) refuse({ ...r, where: path }, `it sets ${key}, which changes what runs`)
      }
    }
  }
}
