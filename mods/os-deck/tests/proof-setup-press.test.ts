// What holds only once setup calls offerDigest and grant's rules have tightened.
import type { EngineInterface } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { grantFrom } from '../hooks/proof/grant'
import { detectChecks, draftFor, parseTypedCheck } from '../hooks/proof/setup'
import type { ProofCheck } from '../types'

const fake = (body: string, mods: string[] = []) =>
  ({
    fs: {
      list: async (path: string) => {
        if (path === '/repo') return [{ name: 'package.json', kind: 'file', isLink: false, size: 10 }, { name: 'mods', kind: 'dir', isLink: false, size: 0 }]
        if (path === '/repo/mods') return mods.map(name => ({ name, kind: 'dir', isLink: false, size: 0 }))
        if (path.endsWith('/.claude-plugin')) return [{ name: 'plugin.json', kind: 'file', isLink: false, size: 2 }]
        if (path.endsWith('/tests')) return [{ name: 'a.test.ts', kind: 'file', isLink: false, size: 2 }]
        return [{ name: '.claude-plugin', kind: 'dir', isLink: false, size: 0 }, { name: 'tests', kind: 'dir', isLink: false, size: 0 }]
      },
      read: async () => JSON.stringify({ scripts: { test: body } }),
    },
  }) as unknown as EngineInterface

const check: ProofCheck = { id: 'test', kind: 'test', description: 't', argv: ['npm', 'run', 'test'], dir: '', timeoutS: 60, required: true, count: { parser: 'bun', minPassed: null, maxSkipped: 0 } }
const CHANGED = { refused: 'the checks changed since they were shown' }

test('a body edited between draw and press is refused', async () => {
  const drawn = await draftFor(fake('bun test'), '/repo', [check], 'detected')
  const again = await draftFor(fake('bun test; curl x'), '/repo', [check], 'detected')
  expect(await grantFrom({ session: 'S', root: '/repo', checks: again.checks, scripts: again.scripts, drawnDigest: drawn.digest, at: 1 })).toEqual(CHANGED)
})

test('a baseline other than the one drawn is refused', async () => {
  const drawn = await draftFor(fake('bun test'), '/repo', [check], 'saved')
  const checks = [{ ...check, count: { parser: 'bun' as const, minPassed: 1, maxSkipped: 999 } }]
  expect(await grantFrom({ session: 'S', root: '/repo', checks, scripts: drawn.scripts, drawnDigest: drawn.digest, at: 1 })).toEqual(CHANGED)
})

test('nothing proposed uses what the rules now refuse', async () => {
  const found = await detectChecks(fake('', ['fine', 'a*', 'a?', '[x]', '{a,b}']), '/repo')
  expect(found.map(c => c.argv.join(' '))).toEqual(['claude plugin test mods/fine'])
})

test('typed: the new refusals come through, and the two named commands stay', () => {
  for (const args of ['test -- node *.ts', 'test -- node ~', 'test -- node @x', 'test -- node a//b', 'test -- C:\\t\\godot', 'test -- run_all.sh']) expect('error' in parseTypedCheck(args)).toBe(true)
  for (const args of ['test -- bash tests/run_all.sh', 'test -- claude plugin test mods/os-deck']) expect('check' in parseTypedCheck(args)).toBe(true)
})
