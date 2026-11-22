// What holds only once setup calls offerDigest and grant's rules have tightened.
import type { EngineInterface } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { grantFrom, offerDigest } from '../hooks/proof/grant'
import type { Draft } from '../hooks/proof/model'
import { detectChecks, draftFor, parseTypedCheck } from '../hooks/proof/setup'
import type { ProofCheck } from '../types'

const base64Of = (text: string) => btoa([...new TextEncoder().encode(text)].map(b => String.fromCharCode(b)).join(''))
const fake = (body: string, mods: string[] = [], helper: string | null = null) =>
  ({
    fs: {
      list: async (path: string) => {
        if (path === '/repo') return [{ name: 'package.json', kind: 'file', isLink: false, size: 10 }, { name: 'mods', kind: 'dir', isLink: false, size: 0 }, ...(helper === null ? [] : [{ name: 'x.js', kind: 'file', isLink: false, size: helper.length }])]
        if (path === '/repo/mods') return mods.map(name => ({ name, kind: 'dir', isLink: false, size: 0 }))
        if (path.endsWith('/.claude-plugin')) return [{ name: 'plugin.json', kind: 'file', isLink: false, size: 2 }]
        if (path.endsWith('/tests')) return [{ name: 'a.test.ts', kind: 'file', isLink: false, size: 2 }]
        return [{ name: '.claude-plugin', kind: 'dir', isLink: false, size: 0 }, { name: 'tests', kind: 'dir', isLink: false, size: 0 }]
      },
      read: async (path: string) => ({ base64: base64Of(path.endsWith('/x.js') ? (helper ?? '') : JSON.stringify({ scripts: { test: body } })) }),
    },
  }) as unknown as EngineInterface

const check: ProofCheck = { id: 'test', kind: 'test', description: 't', argv: ['npm', 'run', 'test'], dir: '', timeoutS: 60, required: true, count: { parser: 'bun', minPassed: null, maxSkipped: 0 } }
const CHANGED = { refused: 'the checks changed since they were shown' }

test('a body edited between draw and press is refused', async () => {
  const drawn = await draftFor(fake('bun test'), '/repo', [check], 'detected')
  const again = await draftFor(fake('bun test; curl x'), '/repo', [check], 'detected')
  expect(await grantFrom({ session: 'S', root: '/repo', checks: again.checks, scripts: again.scripts, watched: drawn.watched, files: drawn.files, manualOnly: drawn.manualOnly, drawnDigest: drawn.digest, at: 1 })).toEqual(CHANGED)
})

test('a baseline other than the one drawn is refused', async () => {
  const drawn = await draftFor(fake('bun test'), '/repo', [check], 'saved')
  const checks = [{ ...check, count: { parser: 'bun' as const, minPassed: 1, maxSkipped: 999 } }]
  expect(await grantFrom({ session: 'S', root: '/repo', checks, scripts: drawn.scripts, watched: drawn.watched, files: drawn.files, manualOnly: drawn.manualOnly, drawnDigest: drawn.digest, at: 1 })).toEqual(CHANGED)
})

test('nothing proposed uses what the rules now refuse', async () => {
  const found = await detectChecks(fake('', ['fine', 'a*', 'a?', '[x]', '{a,b}']), '/repo')
  expect(found.map(c => c.argv.join(' '))).toEqual(['claude plugin test mods/fine'])
})

test('typed: the new refusals come through, and the two named commands stay', () => {
  for (const args of ['test -- node *.ts', 'test -- node ~', 'test -- node @x', 'test -- node a//b', 'test -- C:\\t\\godot', 'test -- run_all.sh']) expect('error' in parseTypedCheck(args)).toBe(true)
  for (const args of ['test -- bash tests/run_all.sh', 'test -- claude plugin test mods/os-deck']) expect('check' in parseTypedCheck(args)).toBe(true)
})

const pressOn = (d: Draft, over: object = {}) =>
  grantFrom({ session: 'S', root: '/repo', checks: d.checks, scripts: d.scripts, watched: d.watched, files: d.files, manualOnly: d.manualOnly, drawnDigest: d.digest, at: 1, ...over })

test('C4: a press is bound to the watched bytes that were drawn', async () => {
  const d = await draftFor(fake('node x.js'), '/repo', [check], 'detected')
  expect((d.watched ?? []).length).toBeGreaterThan(0)
  expect('grant' in (await pressOn(d))).toBe(true)
  const first = d.watched[0] as [string, string | null]
  expect(await pressOn(d, { watched: [[first[0], 'f'.repeat(64)], ...d.watched.slice(1)] })).toEqual(CHANGED)
  expect(await pressOn(d, { watched: d.watched.slice(1) })).toEqual(CHANGED)
  expect(await pressOn(d, { watched: undefined })).toEqual(CHANGED)
})

test('C4: a helper edited between draw and press changes the digest', async () => {
  const at = (helper: string) => draftFor(fake('node x.js', [], helper), '/repo', [check], 'detected')
  expect((await at('process.exit(1)')).digest).not.toBe((await at('process.exit(0)')).digest)
})

test('H1: a press is bound to the config that was shown', async () => {
  const d = await draftFor(fake('bun test'), '/repo', [check], 'detected')
  expect(await pressOn(d, { files: [{ path: '.npmrc', body: 'workspace=pkg' }] })).toEqual(CHANGED)
  const shown = [{ path: '.npmrc', body: 'audit=false' }]
  const digest = await offerDigest('/repo', d.checks, d.scripts, { watched: d.watched, files: shown, manualOnly: null })
  expect('grant' in (await pressOn(d, { files: shown, drawnDigest: digest }))).toBe(true)
  expect(await pressOn(d, { files: [], drawnDigest: digest })).toEqual(CHANGED)
})

test('H2: manual only cannot be pressed into automatic', async () => {
  const cargo = { ...check, argv: ['cargo', 'test'] }
  const d = await draftFor(fake('x'), '/repo', [cargo], 'typed')
  expect(d.manualOnly).toBe('test: what cargo runs is not known')
  const made = await pressOn(d, { auto: true })
  expect('grant' in made && made.grant.auto).toBe(false)
  expect(await pressOn(d, { auto: true, manualOnly: null })).toEqual(CHANGED)
})
