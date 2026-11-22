// What Agent Proof shows in the plan view. Pure: values and presses go in, rows come out. Every row is
// wrapped or cut here, to the width given, so the rows reported are the rows drawn.
import type { Elements } from 'claude-code'

import type { ProofCheck, ProofCountRule, ProofExecution } from '../../types'
import { fmtClock, fmtDuration } from '../core'
import type { Colors } from '../core'
import { redact } from '../redact'
import { outcomeOf } from './checks'
import type { Draft, ProofActions, ProofViewModel, RootView, TaskView } from './model'
import type { ProofState } from './verdict'

export type ProofDraw = {
  els: Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>
  colors: Colors
  /** The columns the section may take. */
  width: number
  act: ProofActions
}

/** `rows` is what `node` draws; with none, there is no node. */
export type Section = { rows: number; node: JSX.Element | null }

/** A task's mark sits in that task's own row and takes `width` of its columns. */
export type Mark = Section & { width: number }

// ---------------------------------------------------------------- text

// Marks that read as verified are ours alone to draw.
const PASS_MARKS = /[✓✔✅☑√🗸🟢🟩💚]/gu
// A shown character is one cell and can be told from every other.
const UNSHOWN = /[^ -~À-ÖØ-öø-ÿ]/u
const BARE_ARG = /^[A-Za-z0-9À-ÖØ-öø-ÿ_@%+=:,./\\~-]+$/u
// The engine refuses a whole pane for one of these.
const UNDRAWABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu
const ESCAPED: Readonly<Record<string, string>> = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' }

/** Agent or output text, on one line. */
const safe = (text: string): string =>
  redact(String(text ?? ''))
    .replace(/\s+/g, ' ')
    .replace(UNDRAWABLE, '')
    .replace(PASS_MARKS, '*')
    .trim()

const quoted = (text: string): string =>
  `"${Array.from(text, ch => ESCAPED[ch] ?? (UNSHOWN.test(ch) ? `\\u{${(ch.codePointAt(0) ?? 0).toString(16)}}` : ch)).join('')}"`

/** A path as it is, or escaped where a character of it would not show. */
const shown = (text: string): string => (text === '' || UNSHOWN.test(text) ? quoted(text) : text)
const shownArg = (arg: string): string => (BARE_ARG.test(arg) ? arg : quoted(arg))

// Counted wide where unsure: an early wrap loses nothing, a late one is cut by the terminal.
const cellsOf = (ch: string): number => {
  const code = ch.codePointAt(0) ?? 0
  if (code < 0x1100) return 1
  return code >= 0x2000 && code <= 0x2bff && !/\p{Emoji_Presentation}/u.test(ch) ? 1 : 2
}

const widthOf = (text: string): number => Array.from(text).reduce((n, ch) => n + cellsOf(ch), 0)

const cut = (text: string, width: number): string => {
  if (widthOf(text) <= width) return text
  let out = ''
  let used = 1
  for (const ch of text) {
    used += cellsOf(ch)
    if (used > width) break
    out += ch
  }
  return width > 0 ? `${out}…` : ''
}

/** Broken anywhere, every character and space kept. */
const pieces = (text: string, width: number): string[] => {
  const out: string[] = []
  let line = ''
  let used = 0
  for (const ch of text) {
    const size = cellsOf(ch)
    if (line && used + size > width) {
      out.push(line)
      line = ''
      used = 0
    }
    line += ch
    used += size
  }
  return [...out, line]
}

/** Broken between words where it can be. */
const wrapped = (text: string, width: number): string[] => {
  const out: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word
    if (widthOf(next) <= width) {
      line = next
      continue
    }
    if (line) out.push(line)
    const parts = pieces(word, width)
    line = parts.pop() ?? ''
    out.push(...parts)
  }
  return [...out, line]
}

const clockOf = (at: number) => fmtClock(at).slice(0, 5)
const shortRevision = (revision: string) => shown(revision.slice(0, 7))

// Every part of a key is quoted, so no two sets of parts make one key.
const keyOf = (what: string, ...parts: string[]) => [`proof-${what}`, ...parts.map(quoted)].join(':')

// ---------------------------------------------------------------- rows

type Run = { text: string; color?: string | undefined; dim?: boolean; bold?: boolean }
type Style = { head?: string; headColor?: string | undefined; color?: string | undefined; dim?: boolean; bold?: boolean; max?: number }
type Press = { key: string; label: string; onPress: () => unknown; primary?: boolean; beside?: string }

/** Only what is verified is drawn in the colour of verified, whatever the palette. */
const notGreen = (colors: Colors, color: string): string | undefined => (color === colors.gate ? undefined : color)

const sheetOf = (d: ProofDraw, indent = 0) => {
  const { Box, Text, Button } = d.els
  const full = Math.max(16, Math.floor(d.width))
  const pad = Math.min(Math.max(0, indent), Math.max(0, full - 22))
  const width = full - pad
  const out: JSX.Element[] = []

  const line = (...runs: Run[]) => {
    let room = width
    const kept: Run[] = []
    for (const run of runs) {
      // Numbers and words from the store reach here too, whatever their type says.
      const whole = run.text.replace(UNDRAWABLE, '')
      const text = cut(whole, room)
      if (!text) continue
      kept.push({ ...run, text })
      room -= widthOf(text)
      if (text !== whole) break
    }
    out.push(
      <Text wrap="truncate">
        {kept.length === 0
          ? ' '
          : kept.map(run => (
              <Text
                {...(run.color ? { color: run.color } : {})}
                {...(run.dim ? { dimColor: true } : {})}
                {...(run.bold ? { bold: true } : {})}
              >
                {run.text}
              </Text>
            ))}
      </Text>,
    )
  }

  /** Words, wrapped under their head; cut only where a most is given. */
  const say = (text: string, { head = '', headColor, max, ...style }: Style = {}) => {
    const room = Math.max(1, width - widthOf(head))
    let lines = wrapped(text, room)
    if (max !== undefined && lines.length > max) lines = [...lines.slice(0, max - 1), cut(`${lines[max - 1]}…`, room)]
    const rest = head.startsWith('│') ? head : ' '.repeat(widthOf(head))
    lines.forEach((part, i) => line({ text: i === 0 ? head : rest, color: headColor }, { text: part, ...style }))
  }

  /** To be read exactly: every character kept, a row that carries one on marked. */
  const exact = (text: string, head: string, color?: string) =>
    pieces(text, width - widthOf(head)).forEach((part, i) =>
      line({ text: i === 0 ? head : '↳ '.padStart(widthOf(head)), color: d.colors.faint }, { text: part, color }),
    )

  /** A vector: a new row starts a new argument unless it is marked as carrying one on. */
  const argv = (args: readonly string[]) => {
    const room = width - 2
    const rows: { isRest: boolean; text: string }[] = []
    for (const arg of args.map(shownArg)) {
      const last = rows[rows.length - 1]
      if (last && widthOf(last.text) + 1 + widthOf(arg) <= room) last.text += ` ${arg}`
      else pieces(arg, room).forEach((text, i) => rows.push({ isRest: i > 0, text }))
    }
    for (const row of rows) line({ text: row.isRest ? '↳ ' : '  ', color: d.colors.faint }, { text: row.text, bold: true })
  }

  /** Presses, as many to a row as fit. */
  const presses = (list: readonly Press[]) => {
    let row: { press: Press; label: string }[] = []
    let used = 0
    const flush = () => {
      if (row.length === 0) return
      out.push(
        <Box>
          {row.map(({ press, label }, i) => (
            <Box flexShrink={0}>
              {i > 0 ? <Text> </Text> : null}
              <Button key={press.key} label={label} {...(press.primary ? { variant: 'primary' as const } : {})} onPress={press.onPress} />
              {press.beside ? <Text>{` ${press.beside}`}</Text> : null}
            </Box>
          ))}
        </Box>,
      )
      row = []
      used = 0
    }
    for (const press of list) {
      const beside = press.beside ? widthOf(press.beside) + 1 : 0
      // `[ label ]`: four cells round it.
      const label = cut(press.label.replace(UNDRAWABLE, ''), width - beside - 4)
      const size = widthOf(label) + 4 + beside
      if (used > 0 && used + 1 + size > width) flush()
      used += (used > 0 ? 1 : 0) + size
      row.push({ press, label })
    }
    flush()
  }

  const section = (): Section => ({
    rows: out.length,
    node:
      out.length === 0 ? null : (
        <Box flexDirection="column" flexShrink={0} width={full} paddingLeft={pad}>
          {out}
        </Box>
      ),
  })

  return { width, line, say, exact, argv, presses, section }
}

type Sheet = ReturnType<typeof sheetOf>

// ---------------------------------------------------------------- states

const STATE: Readonly<Record<ProofState, { glyph: string; word: string; color: keyof Colors }>> = {
  failed: { glyph: '✗', word: 'failed', color: 'warn' },
  inconclusive: { glyph: '?', word: 'inconclusive', color: 'amber' },
  stale: { glyph: '◌', word: 'stale', color: 'amber' },
  pending: { glyph: '…', word: 'pending', color: 'dim' },
  verifying: { glyph: '◐', word: 'verifying', color: 'main' },
  verified: { glyph: '✓', word: 'checks verified', color: 'gate' },
}
const ATTENTION: readonly ProofState[] = ['failed', 'inconclusive', 'stale', 'pending', 'verifying']

const lookOf = (colors: Colors, state: ProofState) => {
  const { glyph, word, color } = STATE[state]
  return { glyph, word, color: state === 'verified' ? colors.gate : notGreen(colors, colors[color]) }
}

const changedRoots = (task: TaskView): string[] => [...new Set(task.claim.changes.filter(c => c.paths.length > 0).map(c => c.root))]

/** A root's name, or its path where two share the name. */
const rootName = (vm: ProofViewModel, root: RootView): string =>
  vm.roots.some(r => r !== root && r.name === root.name) ? shown(root.root) : safe(root.name) || shown(root.root)

/** Keeps the end, where two paths of one name differ. */
const cutStart = (text: string, width: number): string => [...cut([...text].reverse().join(''), width)].reverse().join('')

// ---------------------------------------------------------------- the lines under the bar

/** What waits, worst first, then one row for each root. */
export const proofSummary = (d: ProofDraw, vm: ProofViewModel): Section => {
  const s = sheetOf(d)
  if (vm.roots.length === 0 && vm.tasks.length === 0) return s.section()
  const C = d.colors
  const tasks = vm.tasks.filter(t => !t.claim.withdrawn)

  const waits: Run[] = []
  for (const state of ATTENTION) {
    // Tasks are counted; a root only where no task says it already.
    const count = tasks.filter(t => t.verdict.state === state).length || vm.roots.filter(r => r.verdict.state === state).length
    if (count === 0) continue
    const { word, color } = lookOf(C, state)
    waits.push({ text: `${count} ${word}`, color })
  }
  const toReview = tasks.filter(t => !t.isReviewed).length
  if (toReview > 0) waits.push({ text: `${toReview} to review`, color: notGreen(C, C.amber) })
  s.line({ text: 'proof', bold: true }, ...waits.flatMap((run, i) => [{ text: i === 0 ? '  ' : ' · ', dim: true }, run]))

  for (const root of vm.roots) {
    const { state, reason } = root.verdict
    const { glyph, word, color } = lookOf(C, state)
    const runs: Run[] = []
    if (state === 'verified') {
      const own = tasks.filter(t => changedRoots(t).includes(root.root))
      const open = own.filter(t => !t.isReviewed).length
      const isReviewed = own.length > 0 && open === 0
      const isNarrow = s.width < 50
      const axis = isReviewed ? 'reviewed' : isNarrow ? 'review' : open > 0 ? `${open} to review` : 'review needed'
      runs.push({ text: `${glyph} ${isNarrow ? 'checks' : word}`, color }, { text: ` · ${axis}`, color: notGreen(C, isReviewed ? C.dim : C.amber) })
    } else {
      runs.push({ text: `${glyph} ${word}`, color })
    }
    // The state is never cut for the name, only the other way round.
    const room = Math.max(1, Math.min(24, s.width - runs.reduce((n, run) => n + widthOf(run.text), 0) - 2))
    const name = rootName(vm, root)
    const label = name === shown(root.root) ? cutStart(name, room) : cut(name, room)
    if (root.paused.length > 0) runs.push({ text: ' · paused', color: notGreen(C, C.amber) })
    if (state === 'verified') {
      const checked = root.checkedAt ? ` · checked ${clockOf(root.checkedAt)}` : ''
      const used = widthOf(label) + 2 + runs.reduce((n, run) => n + widthOf(run.text), 0)
      if (checked && used + widthOf(checked) <= s.width) runs.push({ text: checked, dim: true })
    } else if (reason) {
      runs.push({ text: `: ${safe(reason)}`, dim: true })
    }
    s.line({ text: label, bold: true }, { text: '  ' }, ...runs)
  }
  if (vm.notSaved) s.line({ text: 'history not saved', color: notGreen(C, C.amber) })
  return s.section()
}

// ---------------------------------------------------------------- a task's mark

/** Beside a plan task; pressed, it opens or closes that claim. `d.width` is the plan's, not the mark's. */
export const taskMark = (d: ProofDraw, task: TaskView): Mark => {
  const { Box, Text, Button } = d.els
  const C = d.colors
  const isWide = d.width >= 50
  const { state } = task.verdict
  const runs: Run[] = []
  if (task.claim.withdrawn) {
    runs.push({ text: isWide ? '↺ reopened' : '↺', color: notGreen(C, C.dim) })
  } else if (state === 'verified') {
    const { glyph, color } = lookOf(C, state)
    runs.push({ text: isWide ? `${glyph} checks` : glyph, color })
    // A check mark never stands without the other axis, even as glyphs alone.
    const axis = task.isReviewed ? (isWide ? ' · reviewed' : '●') : isWide ? ' · review' : '○'
    runs.push({ text: axis, color: notGreen(C, task.isReviewed ? C.dim : C.amber) })
  } else {
    const { glyph, word, color } = lookOf(C, state)
    runs.push({ text: isWide ? `${glyph} ${word}` : glyph, color })
  }
  const { id } = task.claim
  return {
    rows: 1,
    width: 1 + runs.reduce((n, run) => n + widthOf(run.text), 0),
    node: (
      <Box flexShrink={0}>
        <Text> </Text>
        <Button key={keyOf('claim', id)} plain onPress={() => d.act.toggleClaim(id)}>
          {runs.map(run => (
            <Text {...(run.color ? { color: run.color } : {})}>{run.text}</Text>
          ))}
        </Button>
      </Box>
    ),
  }
}

// ---------------------------------------------------------------- a task's detail

const WAITING: Partial<Record<ProofExecution, string>> = { queued: 'queued', running: 'running' }

/** One check as its root's last attempt left it. */
const checkRow = (s: Sheet, C: Colors, root: RootView, check: ProofCheck, isTaskVerified: boolean) => {
  const { state, attempt } = root.verdict
  if (!attempt) return
  const found = attempt.checks.filter(r => r.id === check.id)
  const result = found.length === 1 ? found[0] : undefined
  const name = `${shown(check.id)}${check.required ? '' : ' (optional)'}`
  const waiting = result ? WAITING[result.execution] : undefined
  if (state === 'verifying' && (!result || waiting)) {
    s.say(`${name} ${waiting ?? 'queued'}`, { head: waiting === 'running' ? '◐ ' : '… ', dim: true })
    return
  }

  const outcome = outcomeOf(check, result)
  const isStale = state === 'stale'
  const isPass = outcome.result === 'pass'
  const facts: string[] = []
  if (result?.count) {
    const { passed, failed, skipped } = result.count
    facts.push(`${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`)
  }
  if (result?.execution === 'exited' && result.exitCode !== null) facts.push(`exit ${result.exitCode}`)
  if (outcome.result === 'inconclusive') {
    facts.unshift(result?.execution === 'timed-out' ? `timed out after ${check.timeoutS}s` : outcome.reason)
    if (result?.reason) facts.push(result.reason)
  }
  if (result?.endedAt) facts.push(fmtDuration(result.endedAt - result.startedAt))
  const word = isPass ? 'passed' : outcome.result === 'fail' ? 'failed' : 'no result'
  // A pass is a check mark only inside a verified task, on a verified root, and on that root's content.
  const isGreen = isPass && isTaskVerified && state === 'verified' && result?.revision === attempt.before
  const glyph = isGreen ? '✓' : isStale || isPass ? '·' : outcome.result === 'fail' ? '✗' : '?'
  const color = isGreen ? C.gate : notGreen(C, isStale || isPass ? C.dim : outcome.result === 'fail' ? C.warn : C.amber)
  s.say(safe(`${name} ${word}${isStale ? ' then' : ''}: ${facts.join(' · ')}`), { head: `${glyph} `, headColor: color, dim: isStale })
}

/** A press that cannot wait for a task's detail: cancelling, and the only way a manual root runs. */
const isNoticed = (root: RootView): boolean =>
  root.verdict.state === 'verifying' || (root.grant?.auto === false && root.verdict.state !== 'verified')

const verifyPress = (d: ProofDraw, root: RootView, scope: string): Press | null => {
  if (!root.grant) return null
  const path = root.root
  if (root.verdict.state === 'verifying') return { key: keyOf('cancel', scope, path), label: 'cancel', onPress: () => d.act.cancel(path) }
  return { key: keyOf('verify', scope, path), label: root.verdict.attempt ? 'verify again' : 'verify', onPress: () => d.act.verify(path) }
}

/** The logs worth opening: of each check that did not pass, else of the first. */
const logPresses = (d: ProofDraw, root: RootView, scope: string): Press[] => {
  const { attempt } = root.verdict
  if (!attempt || !root.grant) return []
  const ran = root.grant.checks.flatMap(check => {
    const result = attempt.checks.find(r => r.id === check.id && r.execution !== 'queued')
    return result ? [{ check, outcome: outcomeOf(check, result) }] : []
  })
  const open = ran.filter(x => x.outcome.result !== 'pass')
  return (open.length > 0 ? open : ran.slice(0, 1)).map(({ check }) => {
    const path = root.root
    const { id } = check
    return { key: keyOf('log', scope, path, id), label: `log ${shown(id)}`, onPress: () => d.act.showLog(path, id) }
  })
}

const MAX_LISTED = 8

/** The open claim, in three parts that never mix: the agent's words, what was observed, what is left to a person. */
export const taskDetail = (d: ProofDraw, vm: ProofViewModel, task: TaskView, indent = 0): Section => {
  const s = sheetOf(d, indent)
  const { claim, verdict } = task
  if (vm.openClaim !== claim.id) return s.section()
  const C = d.colors
  const amber = notGreen(C, C.amber)

  const by = claim.agentId ? `by agent "${safe(claim.agentId)}"` : 'by the main agent'
  s.say(`CLAIMED ${by}, ${clockOf(claim.at)}`, { bold: true, max: 2 })
  const subject = safe(claim.subject)
  const description = safe(claim.description)
  // The bar on every row keeps the agent's words from passing for ours.
  s.say(`"${subject}"`, { head: '│ ', headColor: C.faint, dim: true, max: 3 })
  if (description && description !== subject) s.say(`"${description}"`, { head: '│ ', headColor: C.faint, dim: true, max: 4 })

  s.say('VERIFIED BY OS-DECK', { bold: true })
  const isTaskVerified = !claim.withdrawn && verdict.state === 'verified'
  if (claim.withdrawn) {
    s.say('reopened: the claim is withdrawn', { head: '↺ ', dim: true })
  } else if (isTaskVerified) {
    const { glyph, word, color } = lookOf(C, 'verified')
    const axis = task.isReviewed ? 'reviewed' : 'review needed'
    const axisColor = notGreen(C, task.isReviewed ? C.dim : C.amber)
    if (widthOf(`${glyph} ${word} · ${axis}`) <= s.width) {
      s.line({ text: `${glyph} ${word}`, color }, { text: ` · ${axis}`, color: axisColor })
    } else {
      s.line({ text: `${glyph} ${word}`, color })
      s.line({ text: `· ${axis}`, color: axisColor })
    }
  } else {
    const { glyph, word, color } = lookOf(C, verdict.state)
    s.say(safe(`${word}: ${verdict.reason}`), { head: `${glyph} `, headColor: color, color })
  }

  const own = changedRoots(task)
  // With no change seen, the roots stand beside the task and are not its own.
  const paths = own.length > 0 ? own : vm.roots.map(r => r.root)
  const several = paths.length > 1
  const presses: Press[] = []
  for (const path of paths) {
    const root = vm.roots.find(r => r.root === path)
    if (!root) {
      s.say(`${shown(path)}: not allowed in this session`, { dim: true })
      continue
    }
    const { attempt, state, reason } = root.verdict
    const revision = attempt?.before ?? root.revision
    const name = rootName(vm, root)
    const when = attempt ? ` · ${clockOf(attempt.endedAt ?? attempt.startedAt)}` : ''
    s.say(`${name}${revision ? ` @ ${shortRevision(revision)}` : ''}${when}${own.length === 0 ? ' · not shown to be this task’s work' : ''}`)
    // A root's green is not lent to a task that is not verified.
    if (several || own.length === 0 || state !== verdict.state) {
      if (state === 'verified' && !isTaskVerified) {
        s.say('repository checks passed; this task is not verified by them', { head: '· ', dim: true })
      } else if (state !== 'verified') {
        const { glyph, word, color } = lookOf(C, state)
        s.say(safe(`${word}: ${reason}`), { head: `${glyph} `, headColor: color })
      }
    }
    for (const check of root.grant?.checks ?? []) checkRow(s, C, root, check, isTaskVerified)
    const verify = isNoticed(root) ? null : verifyPress(d, root, claim.id)
    const list = [...(verify ? [verify] : []), ...logPresses(d, root, claim.id)]
    // Several roots: each one's presses under it, so none is taken for another's.
    if (several) s.presses(list)
    else presses.push(...list)
  }
  if (task.earlier.length > 0) {
    // History is never the present state, so it does not use that word.
    const earlier = task.earlier.slice(0, 5).map(e => `${clockOf(e.at)} ${safe(e.label).replace(/(?:checks )?\bverified\b/gi, 'passed')}`)
    s.say(`earlier runs: ${earlier.join(' · ')}`, { dim: true, max: 3 })
  }

  s.say('FOR YOU', { bold: true })
  const drawn = task.drawn.map(({ root, revision }) => ({ root, revision }))
  const canReview =
    !claim.withdrawn &&
    !task.isReviewed &&
    drawn.length > 0 &&
    drawn.every(x => x.revision !== '') &&
    own.every(path => drawn.some(x => x.root === path))
  s.say(task.isReviewed ? 'reviewed at this content' : 'review needed', task.isReviewed ? { dim: true } : { color: amber })
  s.say('acceptance criteria are not checked', { dim: true })
  if (task.reviewWorthy.length > 0) {
    s.say('changed tests, scripts or test config:', { color: amber })
    for (const path of task.reviewWorthy.slice(0, MAX_LISTED)) s.exact(shown(path), '  ')
    if (task.reviewWorthy.length > MAX_LISTED) s.say(`and ${task.reviewWorthy.length - MAX_LISTED} more`, { dim: true })
  }
  s.say('not covered: ignored files, dependencies, shell writes outside allowed repositories', { dim: true })
  if (canReview) {
    s.say('mark reviewed covers:', { dim: true })
    for (const { root, revision } of drawn) s.exact(`${shown(root)} @ ${shortRevision(revision)}`, '  ')
    presses.push({ key: keyOf('review', claim.id), label: 'mark reviewed', onPress: () => d.act.review(claim.id, drawn.map(x => ({ ...x }))) })
  }
  s.presses(presses)
  return s.section()
}

// ---------------------------------------------------------------- what a root asks

/** Under the summary, only for a root with something to press: cancel, resume, a baseline, a manual run. */
export const proofNotices = (d: ProofDraw, vm: ProofViewModel): Section => {
  const s = sheetOf(d)
  const C = d.colors
  const amber = notGreen(C, C.amber)
  const open = vm.tasks.find(t => t.claim.id === vm.openClaim)
  for (const root of vm.roots) {
    const { grant, baseline } = root
    if (!grant) continue
    const path = root.root
    const { state } = root.verdict
    const isRunning = state === 'verifying'
    const list: Press[] = []
    if (root.paused.length > 0) {
      s.exact(shown(path), '')
      s.say(grant.auto ? 'automatic runs paused: files the checks run from changed' : 'files the checks run from changed since they were allowed', { color: amber })
      for (const file of root.paused) s.exact(shown(file), '  ')
      s.say('resume shows setup again, to allow them', { dim: true })
      const changed = [...root.paused]
      s.presses([{ key: keyOf('resume', path), label: 'resume', onPress: () => d.act.resume(path, [...changed]) }])
    }
    if (baseline && !isRunning && Number.isSafeInteger(baseline.passed) && baseline.passed > 0 && Number.isSafeInteger(baseline.skipped) && baseline.skipped >= 0) {
      const { attemptId, checkId, passed, skipped } = baseline
      s.exact(shown(path), '')
      s.say(`${shown(checkId)} ran: ${passed} passed, ${skipped} skipped`, { color: amber })
      s.say(`accepting means at least ${passed} must pass and at most ${skipped} be skipped`)
      s.presses([
        { key: keyOf('baseline', path, attemptId, checkId), label: 'accept as baseline', onPress: () => d.act.acceptBaseline(path, attemptId, checkId, passed, skipped) },
      ])
    }
    if (isNoticed(root)) {
      const verify = verifyPress(d, root, '')
      if (verify) list.push(verify)
    }
    // A failure no open claim explains still has its output a press away.
    const own = open ? changedRoots(open) : null
    const isExplained = own !== null && (own.length === 0 || own.includes(path))
    if (state === 'failed' && !isExplained) list.push(...logPresses(d, root, ''))
    if (list.length > 0) {
      if (vm.roots.length > 1) s.exact(shown(path), '')
      s.presses(list)
    }
  }
  return s.section()
}

// ---------------------------------------------------------------- setup

// Past these the engine cuts a tree's text, and then what is allowed was not all shown.
const MAX_DRAFT_CHARS = 16_000
const MAX_DRAFT_LINES = 400

/** Whether redaction would show other words than these, its tidying of control characters aside. */
const hasSecret = (text: string): boolean => {
  const plain = text
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, ch => (ch === '\n' ? ch : ''))
  return redact(plain) !== plain
}

const SOURCE: Readonly<Record<Draft['source'], string>> = {
  detected: 'found in this repository',
  saved: 'saved earlier: a suggestion, not a permission',
  typed: 'as you typed it',
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0

/** What would judge the tests, as a press binds it: accepted counts, none yet, or counts that are no counts. */
const baselineIn = ({ minPassed, maxSkipped }: ProofCountRule): { least: number; most: number } | 'none' | 'unreadable' => {
  if (minPassed === null || minPassed === 0) return 'none'
  return isCount(minPassed) && isCount(maxSkipped) ? { least: minPassed, most: maxSkipped } : 'unreadable'
}

/** Why what would run cannot be shown as it is; null where it can. */
const unshowable = (draft: Draft): string | null => {
  const texts = [
    draft.root,
    ...draft.checks.flatMap(c => [c.id, c.dir, ...c.argv]),
    ...draft.scripts.flatMap(x => [x.name, x.body]),
  ]
  if (texts.reduce((n, t) => n + quoted(t).length, 0) > MAX_DRAFT_CHARS) return 'too long to show whole'
  if (draft.scripts.reduce((n, x) => n + x.body.split('\n').length, 0) > MAX_DRAFT_LINES) return 'too long to show whole'
  // An argument split from its flag is still read as one line.
  if (texts.some(hasSecret) || draft.checks.some(c => hasSecret(c.argv.join(' ')))) return 'what looks like a secret'
  return null
}

/** Everything a press would allow, whole, and then the presses. */
export const setupDraft = (d: ProofDraw, draft: Draft | null): Section => {
  const s = sheetOf(d)
  if (!draft) return s.section()
  const C = d.colors
  const amber = notGreen(C, C.amber)
  const warn = notGreen(C, C.warn)
  const discard: Press = { key: 'proof-discard', label: 'discard', onPress: () => d.act.discardDraft() }

  s.line({ text: 'proof setup', bold: true })
  s.say(SOURCE[draft.source] ?? 'not from a known source', { dim: true })

  const hidden = unshowable(draft)
  if (hidden) {
    // Nothing of it in part: a part read as the whole is what this screen is there to prevent.
    if (draft.problem) s.say(`cannot be allowed: ${safe(draft.problem)}`, { color: warn })
    s.say(`cannot be allowed: ${hidden}; its commands are not drawn`, { color: warn })
    s.presses([discard])
    return s.section()
  }

  s.say('root:', { dim: true })
  s.exact(shown(draft.root), '  ')

  const script = (x: Draft['scripts'][number]) => {
    const rows = x.body.split('\n')
    // The press binds these bytes: a return or a space at a row's end is escaped, or two bodies look one.
    const isEscaped = x.body === '' || rows.some(row => UNSHOWN.test(row) || row.endsWith(' '))
    s.exact(`script ${shown(x.name)}${isEscaped ? ' (escaped)' : ''}:`, '')
    for (const row of isEscaped ? [quoted(x.body)] : rows) s.exact(row, '│ ')
  }
  for (const check of draft.checks) {
    s.say(`${shown(check.id)}${check.id === check.kind ? '' : ` · ${safe(check.kind)}`} · ${check.required ? 'required' : 'optional'} · ${check.timeoutS}s limit`, { bold: true })
    if (check.description) s.say(`"${safe(check.description)}"`, { dim: true, max: 2 })
    s.say(check.dir ? 'runs in the folder:' : 'runs in the root:', { dim: true })
    if (check.dir) s.exact(shown(check.dir), '  ')
    s.argv(check.argv)
    if (check.count) {
      s.say(`tests counted as ${safe(check.count.parser)} prints them`, { dim: true })
      const baseline = baselineIn(check.count)
      if (baseline === 'none') s.say('no baseline accepted yet: after a first run you accept its counts', { color: amber })
      else if (baseline === 'unreadable') s.say('its baseline is not a count of tests', { color: warn })
      else s.say(`accepted baseline: at least ${baseline.least} must pass, at most ${baseline.most} may be skipped`, { color: amber })
    } else if (check.kind === 'test') {
      s.say('no baseline accepted yet, and no way to count its tests: it cannot verify', { color: amber })
    }
    draft.scripts.filter(x => x.checkId === check.id).forEach(script)
  }
  // One that names no check drawn still runs.
  draft.scripts.filter(x => !draft.checks.some(c => c.id === x.checkId)).forEach(script)

  s.say('checks run as you, outside permission prompts and the sandbox', { color: amber })
  s.say('they inherit your environment: known credential variables are blanked, the rest are not', { color: amber })
  s.say('processes a check leaves in the background may outlive it', { color: amber })
  s.say('not covered: ignored files, including new folders that ignore themselves', { color: amber })

  const problem =
    draft.problem ??
    (draft.checks.length === 0 ? 'no check' : !draft.digest ? 'the checks have no digest' : null) ??
    (draft.checks.some(c => c.count && baselineIn(c.count) === 'unreadable') ? 'a baseline that cannot be read' : null)
  if (problem !== null) {
    s.say(`cannot be allowed: ${safe(problem) || 'a problem was found'}`, { color: warn })
    s.presses([discard])
    return s.section()
  }
  s.say('After Allow, code agents write into tests runs automatically at the end of a turn, without a permission prompt.', { color: warn, bold: true })
  s.say('manual only: checks run when you press verify', { dim: true })
  s.say('either one lasts for this session', { dim: true })
  const { root, digest } = draft
  s.presses([
    { key: 'proof-allow', label: 'allow', primary: true, beside: 'automatic', onPress: () => d.act.allow(root, digest, true) },
    { key: 'proof-manual', label: 'manual only', onPress: () => d.act.allow(root, digest, false) },
    discard,
  ])
  return s.section()
}

// ---------------------------------------------------------------- the log

const LOG_ROWS = 20

/** The end of one check's kept output. */
export const logTail = (d: ProofDraw, vm: ProofViewModel): Section => {
  const s = sheetOf(d)
  if (!vm.log) return s.section()
  const { root, checkId, text } = vm.log
  s.exact(shown(root), '')
  s.say(`output of ${shown(checkId)}, not evidence by itself`, { bold: true })
  const all = redact(text)
    .split('\n')
    .flatMap(row => pieces(row.replace(UNDRAWABLE, '').replace(PASS_MARKS, '*'), s.width - 2))
  while (all.length > 0 && all[all.length - 1]?.trim() === '') all.pop()
  if (all.length === 0) s.say('no output kept', { dim: true })
  if (all.length > LOG_ROWS) s.say(`${all.length - LOG_ROWS} earlier rows not shown`, { dim: true })
  for (const row of all.slice(-LOG_ROWS)) s.line({ text: '│ ', color: d.colors.faint }, { text: row, dim: true })
  s.presses([{ key: keyOf('log-close', root, checkId), label: 'close log', onPress: () => d.act.showLog(root, null) }])
  return s.section()
}
