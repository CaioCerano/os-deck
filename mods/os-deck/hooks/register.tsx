import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Account, AgentCard, Github, Architect, Bucket, Check, DeckSection, Gate, Git, GitRepo, Layout, LogLine, Loop, Main, Plan, PlanTask, Roster, Turn, Usage, View } from '../types'
import {
  DEFAULT_ARCHITECT,
  DEFAULT_GATE,
  DEFAULT_MAIN,
  DEFAULT_ROSTER,
  DEFAULT_TURN,
  DEFAULT_USAGE,
  DEFAULT_VIEW,
  EDIT_TOOLS,
  SCHEMA_VERSION,
  afterCall,
  applyStep,
  bucketOf,
  cardTitle,
  titleLines,
  consultTimeline,
  describeInput,
  endConsult,
  fitLegend,
  fmtClock,
  fmtDuration,
  fmtTimer,
  fmtUsd,
  plural,
  gateSummary,
  gauge,
  isAdvising,
  isLoopActive,
  kTokens,
  lanes,
  limitLabel,
  limitOf,
  fmtResetIn,
  fmtSpeed,
  listOf,
  logRows,
  momentOf,
  normalize,
  cardsOf,
  normalizeCard,
  normalizeGate,
  normalizeLog,
  noteTool,
  SVG_COLORS,
  colorsOf,
  parseConfig,
  prettyModel,
  promptLine,
  handbackOf,
  adviceLine,
  receiptOf,
  recordCheck,
  settleCheck,
  shorten,
  redact,
  startConsult,
  stepSpeed,
  stepLoop,
  jiraKeysIn,
  jiraIssueOf,
  jiraSiteOf,
  jiraSkeleton,
  jiraHint,
  skinColors,
  DEFAULT_PLAN,
  demoPlan,
  normalizePlan,
  planApply,
  planLinkAgent,
  planLinkTo,
  planCurrent,
  groupsFinished,
  doneByPath,
  historyWith,
  historyBefore,
  groupSpent,
  nodeAt,
  planTree,
  planOutline,
  DEFAULT_GIT,
  DEFAULT_ACCOUNT,
  isHolding,
  SWITCH_HOLD_MS,
  parseCswapList,
  parseCswapSwitch,
  shownLimits,
  switchTargetOf,
  pickBase,
  isTrunk,
  normalizeGit,
  parseAheadBehind,
  parseGitStatus,
  sortRepos,
  planPolicyHint,
  DECK_SECTIONS,
  deckSectionOf,
  hiddenOf,
  epicKeyOf,
  epicView,
  jiraSearchOf,
  jqlParentKey,
  timelineRows,
  adviseConsult,
  agentKinds,
} from './core'
import type { TimelineItem } from './core'
import { PET_COLUMNS, PET_FRIEND_HEX, PET_ROWS, friendsAt, isSweating, petCells, petColorsOf, petFrame, petStateOf, petToolKind } from './pet-art'
import type { PetInput } from './pet-art'
import { isTurnAlert, scheduleAskAlert, sendAlert, settleAskAlert, stopAlerts, turnAlertText } from './alerts'
import type { AlertConfig } from './alerts'
import { DEFAULT_GITHUB, GITHUB_FRESH_MS, checksLine, readGithub } from './github'
import { phaseProgress, planEta, turnsLine, turnsToFull, withReading } from './forecast'
import { HISTORY_KEY, historyReport, recordDay } from './history'
import type { Config, Panel } from './core'

const PANE = 'flightdeck'
const TITLE = 'OS-Deck'
const PANE_COLUMNS = 66
const PLAN_HINT =
  'If you create tasks with TaskCreate, set metadata.group to the path of the structure each task belongs to, ' +
  'outermost first and separated by " / ", e.g. "v1.2 / Reports / Pie chart": whatever hierarchy the work already has ' +
  '(version, epic, story, phase, area), one to three levels, the exact same path for tasks of the same group. ' +
  'Do not create tasks or invent structure for this; if you create no tasks, ignore it.'


// ---------------------------------------------------------------- state

const meta = atom({ plugin: 'os-deck', key: 'meta' } as const, { schemaVersion: SCHEMA_VERSION })
const main = atom({ plugin: 'os-deck', key: 'main' } as const, DEFAULT_MAIN)
const usage = atom({ plugin: 'os-deck', key: 'usage' } as const, DEFAULT_USAGE)
const architect = atom({ plugin: 'os-deck', key: 'architect' } as const, DEFAULT_ARCHITECT)
const gate = atom({ plugin: 'os-deck', key: 'gate' } as const, DEFAULT_GATE)
const agents = atom({ plugin: 'os-deck', key: 'agents' } as const, [])
const loops = atom({ plugin: 'os-deck', key: 'loops' } as const, [])
const log = atom({ plugin: 'os-deck', key: 'log' } as const, [])
const turn = atom({ plugin: 'os-deck', key: 'turn' } as const, DEFAULT_TURN)
const receipt = atom({ plugin: 'os-deck', key: 'receipt' } as const, null)
const view = atom({ plugin: 'os-deck', key: 'view' } as const, DEFAULT_VIEW)
const roster = atom({ plugin: 'os-deck', key: 'roster' } as const, DEFAULT_ROSTER)
const plan = atom({ plugin: 'os-deck', key: 'plan' } as const, DEFAULT_PLAN)
const git = atom({ plugin: 'os-deck', key: 'git' } as const, DEFAULT_GIT)
const github = atom({ plugin: 'os-deck', key: 'github' } as const, DEFAULT_GITHUB)
const account = atom({ plugin: 'os-deck', key: 'account' } as const, DEFAULT_ACCOUNT)
// The skins mod's own state, read (never written) so the pane wears the skin the transcript does.
const skinPrefs = { plugin: 'skins', key: 'prefs' } as const
const skinCustom = { plugin: 'skins', key: 'custom' } as const
const skinLight = { plugin: 'skins', key: 'isLight' } as const

type ServerBlock = { type: string; id?: string; name?: string; tool_use_id?: string }

// Every read goes through these, so a value saved under an older shape still reads.
async function getMain($: EngineInterface): Promise<Main> {
  return normalize(DEFAULT_MAIN, await read($, main))
}
async function getUsage($: EngineInterface): Promise<Usage> {
  return normalize(DEFAULT_USAGE, await read($, usage))
}
async function getArchitect($: EngineInterface): Promise<Architect> {
  const a = normalize(DEFAULT_ARCHITECT, await read($, architect))
  return { ...a, consults: listOf(a.consults), ids: listOf(a.ids), seen: listOf(a.seen) }
}
async function getGate($: EngineInterface): Promise<Gate> {
  return normalizeGate(await read($, gate))
}
async function getCards($: EngineInterface): Promise<AgentCard[]> {
  return cardsOf(await read($, agents))
}
async function getLoops($: EngineInterface): Promise<Loop[]> {
  return listOf<Loop>(await read($, loops))
}
async function getLog($: EngineInterface): Promise<LogLine[]> {
  return normalizeLog(await read($, log))
}
async function getTurn($: EngineInterface): Promise<Turn> {
  return normalize(DEFAULT_TURN, await read($, turn))
}
async function getView($: EngineInterface): Promise<View> {
  return normalize(DEFAULT_VIEW, await read($, view))
}
async function getGit($: EngineInterface): Promise<Git> {
  return normalizeGit(await read($, git))
}

// Never take .git/index.lock: a refresh must not make the person's own commit or rebase fail.
const GIT = ['git', '--no-optional-locks'] as const
// Each repository's integration branch, found once: remote branches rarely come and go.
const baseOf = new Map<string, string | null>()

/** One repository: its status, and on a feature branch how far it sits from its integration branch. */
async function readRepo($: EngineInterface, dir: string, name: string): Promise<GitRepo | null> {
  const st = await $.process.run([...GIT, '-C', dir, 'status', '--porcelain=v2', '--branch'], { timeoutMs: 8000 })
  if (st.exitCode !== 0) return null
  const repo = parseGitStatus(st.stdout, name)
  if (!repo.branch || isTrunk(repo.branch) || repo.branch === 'detached' || repo.branch === '(initial)') return repo
  if (!baseOf.has(dir)) {
    const refs = await $.process.run([...GIT, '-C', dir, 'for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'], { timeoutMs: 5000 })
    baseOf.set(dir, refs.exitCode === 0 ? pickBase(refs.stdout) : null)
  }
  const base = baseOf.get(dir) ?? null
  if (!base) return repo
  const ab = await $.process.run([...GIT, '-C', dir, 'rev-list', '--left-right', '--count', `${base}...HEAD`], { timeoutMs: 5000 })
  const n = ab.exitCode === 0 ? parseAheadBehind(ab.stdout) : null
  return n ? { ...repo, base, baseAhead: n.ahead, baseBehind: n.behind } : repo
}

/** The session's repository, or where the directory is a workspace of several, each one beneath it. */
async function refreshGit($: EngineInterface) {
  const startedAt = await $.clock.now()
  const cwd = await $.session.cwd()
  const top = await $.process.run([...GIT, '-C', cwd, 'rev-parse', '--show-toplevel'], { timeoutMs: 5000 })
  const dirs: { dir: string; name: string }[] = []
  if (top.exitCode === 0) {
    const d = top.stdout.trim()
    dirs.push({ dir: d, name: d.split('/').pop() || d })
  } else {
    for (const en of await $.fs.list(cwd)) {
      if (dirs.length >= 6) break
      if (en.kind === 'dir' && !en.name.startsWith('.') && (await $.fs.exists(`${cwd}/${en.name}/.git`))) dirs.push({ dir: `${cwd}/${en.name}`, name: en.name })
    }
  }
  const before = await getGit($)
  // A repository that failed this time keeps its last reading rather than blinking out.
  const read = await Promise.all(dirs.map(d => readRepo($, d.dir, d.name).catch(() => before.repos.find(r => r.name === d.name) ?? null)))
  const repos = read.filter((x): x is GitRepo => x !== null)
  // Two reads may overlap: the one that started later wins, whichever ends last.
  await update($, git, x => {
    const cur = normalizeGit(x)
    return cur.at > startedAt ? cur : { repos: sortRepos(repos), at: startedAt }
  })
}

// Not more often than every few seconds unless forced. No lock: a read cut off with its
// session would hold it for good, and two reads at once only write the same thing twice.
let gitLast = 0
async function pokeGit($: EngineInterface, isOn: boolean, force: boolean) {
  if (!isOn) return
  const now = await $.clock.now()
  if (!force && now - gitLast < 4000) return
  gitLast = now
  try {
    await refreshGit($)
  } catch (err) {
    // Called without waiting: nothing may escape, the log line included (the session may be gone).
    await say($, 'os-deck', `git read failed: ${String(err)}`, 'error').catch(() => undefined)
  }
}

// ---------------------------------------------------------------- github (gh)

async function getGithub($: EngineInterface): Promise<Github> {
  return normalize(DEFAULT_GITHUB, await read($, github))
}

// Read at most once a minute unless forced (a push, a `gh pr` command, /os-deck github); never two at once.
let ghLast = 0
let ghBusy = false
async function pokeGithub($: EngineInterface, cfg: Config, force: boolean): Promise<void> {
  if (!cfg.github || ghBusy) return
  ghBusy = true
  try {
    const now = await $.clock.now()
    if (!force && now - ghLast < GITHUB_FRESH_MS) return
    ghLast = now
    const x = await readGithub($, await $.session.cwd(), cfg.ghCommand)
    await update($, github, () => x)
  } catch (err) {
    // Called without waiting: nothing may escape, the log line included (the session may be gone).
    await say($, 'os-deck', `github read failed: ${String(err)}`, 'error').catch(() => undefined)
  } finally {
    ghBusy = false
  }
}

/** The main loop's latest tool, for the pet's detail row: what, since when, and when it ended. */
let mainTool: { tool: string; text: string; at: number; endAt: number | null } | null = null

// ---------------------------------------------------------------- account (cswap)

// A switch made outside (the terminal, the menu bar, cswap auto) raises no event: a timer reads it,
// and the events that come before a response read it sooner, not more often than every few seconds.
const ACCOUNT_POLL_MS = 45_000
const ACCOUNT_POKE_MS = 5_000

async function getAccount($: EngineInterface): Promise<Account> {
  return normalize(DEFAULT_ACCOUNT, await read($, account))
}

/**
 * The active account changed: the session's limits are the old account's, so they go until the
 * next measurement past the hold, and the log says who it is now.
 */
async function noteSwitch($: EngineInterface, command: string, from: string | null, to: string) {
  await update($, usage, x => ({ ...normalize(DEFAULT_USAGE, x), limits: [] }))
  await say($, 'cswap', from ? `account ${from} → ${to}` : `account → ${to}`)
  // The hold ends with nothing to redraw it: a fresh reading then does.
  holdTimer?.cancel()
  const gen = accountGen
  holdTimer = $.clock.after(SWITCH_HOLD_MS + 500, () => {
    if (gen === accountGen) void readAccount($, command, true).catch(() => undefined)
  })
}

// The timer and the pokes never run two reads at once: one asked while another runs is run after
// it, once. The account's last reading lives in $.state, so a reload does not count as a switch.
let accountBusy = false
let accountAgain = false
let accountLast = 0
let accountTimer: { cancel: () => void } | null = null
// What the last plan-view draw decided about the pet, for /os-deck pet to explain.
let petSeen: { isOn: boolean; inner: number; bodyRows: number; isShown: boolean } | null = null
let holdTimer: { cancel: () => void } | null = null
let accountGen = 0
async function readAccount($: EngineInterface, command: string, force: boolean): Promise<void> {
  if (accountBusy) {
    accountAgain = true
    return
  }
  accountBusy = true
  try {
    const before = await getAccount($)
    // No cswap here: stop asking until the person asks with /os-deck account.
    if (before.status === 'missing' && !force) return
    const now = await $.clock.now()
    let out: { exitCode: number; stdout: string; stderr: string }
    try {
      out = await $.process.run([command, 'list', '--json'], { timeoutMs: 10_000 })
    } catch (err) {
      const isMissing = /ENOENT|not found|no such file/i.test(String(err))
      await update($, account, (x): Account => ({ ...normalize(DEFAULT_ACCOUNT, x), status: isMissing ? 'missing' : 'error', error: isMissing ? null : shorten(String(err), 120), at: now }))
      if (!isMissing && before.status !== 'error') $.ui.toast(`OS-Deck: cswap failed: ${shorten(String(err), 80)}`)
      return
    }
    const accounts = out.exitCode === 0 ? parseCswapList(out.stdout) : null
    if (!accounts) {
      const why = (out.stderr || out.stdout).trim().split('\n')[0] || `exit ${out.exitCode}`
      await update($, account, (x): Account => ({ ...normalize(DEFAULT_ACCOUNT, x), status: 'error', error: shorten(redact(why), 120), at: now }))
      if (before.status !== 'error') $.ui.toast(`OS-Deck: cswap could not be read: ${shorten(redact(why), 80)}`)
      return
    }
    const active = accounts.find(a => a.isActive) ?? null
    let prev: string | null = null
    let isSwitch = false
    await update($, account, (x): Account => {
      const cur = normalize(DEFAULT_ACCOUNT, x)
      // A switch landed while this read ran: what it read is from before, so it is dropped.
      if (cur.switchedAt !== null && cur.switchedAt >= now) return cur
      prev = cur.active?.email ?? null
      // The first reading is not a switch: there is nothing it switched from.
      isSwitch = prev !== null && active !== null && active.email !== prev
      return {
        ...cur,
        status: 'ok',
        error: null,
        active: active ? { number: active.number, email: active.email, org: active.org } : null,
        accounts,
        at: now,
        switchedAt: isSwitch ? now : cur.switchedAt,
      }
    })
    if (isSwitch && active) await noteSwitch($, command, prev, active.email)
  } finally {
    accountBusy = false
  }
  if (accountAgain) {
    accountAgain = false
    await readAccount($, command, true)
  }
}

/** Ends the account timers this load started: the session is over, or a new load takes over. */
function stopAccountTimers() {
  accountTimer?.cancel()
  holdTimer?.cancel()
  accountTimer = null
  holdTimer = null
  accountGen++
}

async function pokeAccount($: EngineInterface, cfg: Config, force: boolean) {
  if (!cfg.cswap) return
  const now = await $.clock.now()
  if (!force && now - accountLast < ACCOUNT_POKE_MS) return
  accountLast = now
  try {
    await readAccount($, cfg.cswapCommand, force)
  } catch (err) {
    await say($, 'cswap', `account read failed: ${String(err)}`, 'error')
  }
}

/** `/os-deck account`: the accounts cswap knows, or a switch to one of them. */
async function accountCommand($: EngineInterface, cfg: Config, arg: string): Promise<string> {
  if (!cfg.cswap) return 'OS-Deck: the cswap option is off.'
  const isList = arg.trim() === '' || arg.trim() === 'list'
  if (isList) {
    await pokeAccount($, cfg, true)
    const a = await getAccount($)
    if (a.status === 'missing') return `OS-Deck: cswap (claude-swap) was not found as "${cfg.cswapCommand}". Install it or set the cswapCommand option.`
    if (a.status !== 'ok') return `OS-Deck: cswap could not be read${a.error ? `: ${a.error}` : ''}.`
    const now = await $.clock.now()
    const rows = a.accounts.map(x => {
      const lim = x.limits.map(l => `${limitLabel(l.kind)} ${Math.round(l.pct)}%${fmtResetIn(l.resetsAt, now) ? ` ↻${fmtResetIn(l.resetsAt, now)}` : ''}`).join(' · ')
      return `${x.isActive ? '●' : '○'} #${x.number} ${x.email}${x.org ? ` (${x.org})` : ''}${lim ? `  ${lim}` : ''}`
    })
    return `OS-Deck accounts:\n${rows.join('\n')}\n/os-deck account <n|email|alias|next> switches.`
  }
  const t = switchTargetOf(arg)
  if (!t) return 'Usage: /os-deck account [list|next|<number>|<email>|<alias>]'
  return switchAccount($, cfg, t.target)
}

/** Switches through cswap, `target` null for the next account: what /os-deck account and the pane's list both do. */
async function switchAccount($: EngineInterface, cfg: Config, target: string | null): Promise<string> {
  const before = await getAccount($)
  let out: { exitCode: number; stdout: string; stderr: string }
  try {
    out = await $.process.run([cfg.cswapCommand, 'switch', ...(target ? [target] : []), '--json'], { timeoutMs: 30_000 })
  } catch (err) {
    return /ENOENT|not found|no such file/i.test(String(err))
      ? `OS-Deck: cswap (claude-swap) was not found as "${cfg.cswapCommand}". Install it or set the cswapCommand option.`
      : `OS-Deck: cswap failed: ${shorten(String(err), 160)}`
  }
  const r = parseCswapSwitch(out.stdout)
  if (!r) return `OS-Deck: cswap gave no answer it understands (exit ${out.exitCode}). Is it up to date?`
  if (!r.isSwitched) return `OS-Deck: ${r.message || 'no switch'}.`
  const now = await $.clock.now()
  if (r.to) {
    const to = r.to
    await update($, account, x => {
      const a = normalize(DEFAULT_ACCOUNT, x)
      const hit = a.accounts.find(y => y.email === to)
      return {
        ...a,
        active: hit ? { number: hit.number, email: hit.email, org: hit.org } : { number: 0, email: to, org: '' },
        accounts: a.accounts.map(y => ({ ...y, isActive: y.email === to })),
        switchedAt: now,
      }
    })
    await noteSwitch($, cfg.cswapCommand, before.active?.email ?? null, to)
  }
  void pokeAccount($, cfg, true)
  return `OS-Deck: ${r.message}. Claude Code picks the new account up within about 30 seconds; restart it to apply now.`
}

/** A press on an account in the pane: the switch, told in a toast as the pane has no reply line. */
async function pickAccount($: EngineInterface, cfg: Config, n: number) {
  await update($, view, x => ({ ...normalize(DEFAULT_VIEW, x), accountOpen: false }))
  const text = await switchAccount($, cfg, String(n)).catch(err => `OS-Deck: cswap failed: ${shorten(String(err), 120)}`)
  $.ui.toast(text.replace(/^OS-Deck: /, ''))
}

const HIDDEN_KEY = 'os-deck:hidden'

// The room the pet needs beside the summary, and the height left for the plan below it.
const PET_MIN_INNER = 58
const PET_MIN_ROWS = 30

/** Why the pet is drawn or not, from what the last draw of the plan view saw. */
function petReport(cfg: Config, hidden: readonly DeckSection[]): string {
  if (!cfg.pet) return 'OS-Deck pet: off in the pet option.'
  if (cfg.view !== 'plan') return 'OS-Deck pet: only the plan view draws it (the view option is classic).'
  if (hidden.includes('pet')) return 'OS-Deck pet: hidden. /os-deck show pet brings it back.'
  if (hidden.includes('header')) return 'OS-Deck pet: the header is hidden. /os-deck show header brings both back.'
  const p = petSeen
  if (!p) return "OS-Deck pet: the plan view's header is not drawn now (the pane is closed or in the mini layout). Open it docked with /os-deck."
  if (!p.isShown) return 'OS-Deck pet: the header is off (main is not in the panels option).'
  const size = `the pane has ${p.inner} columns and ${p.bodyRows} rows; the pet needs ${PET_COLUMNS} and ${PET_MIN_ROWS} (${PET_MIN_INNER} columns to sit beside the summary)`
  if (p.isOn) return `OS-Deck pet: drawn (${size}).`
  return `OS-Deck pet: not drawn, ${size}. A taller or wider pane (full screen, the pane docked beside the transcript) shows it.`
}

/**
 * Hides or shows one section, for this session and the ones after it. The stored list is the one
 * merged into, so another open session's choice is kept; the view follows what was saved, and when
 * saving fails this session alone changes.
 */
async function setHidden($: EngineInterface, section: DeckSection, isHidden: boolean): Promise<{ hidden: DeckSection[]; isSaved: boolean }> {
  const stored = await $.store.get(HIDDEN_KEY).then(hiddenOf, () => null)
  const cur = stored ?? hiddenOf((await getView($)).hidden)
  const next = isHidden ? [...new Set([...cur, section])] : cur.filter(x => x !== section)
  const isSaved = stored !== null && (await $.store.set(HIDDEN_KEY, next).then(() => true, () => false))
  await update($, view, x => ({ ...normalize(DEFAULT_VIEW, x), hidden: next }))
  return { hidden: next, isSaved }
}

async function getPlan($: EngineInterface): Promise<Plan> {
  return normalizePlan(await read($, plan))
}
async function getRoster($: EngineInterface): Promise<Roster> {
  const r = normalize(DEFAULT_ROSTER, await read($, roster))
  return { architectTypes: listOf(r.architectTypes) }
}

/** Claude's own task list, as its task tools change it: what the plan panel draws. */
/** `now` is null when the call is replayed from the transcript: its time is not known. */
async function notePlan($: EngineInterface, tool: string, input: Record<string, unknown>, result: unknown, now: number | null) {
  await update($, plan, p => planApply(normalizePlan(p), tool, input, result, now))
}

/** A getJiraIssue result for an issue the person cited (or the one already anchored) anchors the plan. */
async function noteJira($: EngineInterface, input: Record<string, unknown>, result: unknown, site: string | null) {
  const issue = jiraIssueOf(result, jiraSiteOf(input.cloudId) ?? site)
  if (!issue) return
  await update($, plan, x => {
    const p = normalizePlan(x)
    const isCited = (p.cited ?? []).includes(issue.key)
    return isCited || p.jira?.key === issue.key ? { ...p, jira: issue } : p
  })
}

/** Reads a cited issue through the Atlassian connector, as Claude would; a permission check like any call. */
async function fetchJira($: EngineInterface, key: string, site: string) {
  const ran = await $.tool.call({
    tool: 'mcp__atlassian__getJiraIssue',
    cloudId: site.replace(/^https?:\/\//, ''),
    issueIdOrKey: key,
    fields: ['summary', 'status', 'issuetype', 'parent', 'subtasks', 'assignee'],
  } as never)
  const r = ran as { deny?: string; result?: unknown }
  if (r.deny === undefined) await noteJira($, { cloudId: site }, r.result, site)
}

/** A JQL search for the anchored issue's epic children fills the epic view, whoever ran it. */
async function noteEpic($: EngineInterface, input: Record<string, unknown>, result: unknown) {
  const key = jqlParentKey(input.jql)
  const children = key ? jiraSearchOf(result) : null
  // A result that could not be read is no epic with nothing in it: keep what was there.
  if (!key || !children) return
  const at = await $.clock.now()
  await update($, plan, x => {
    const p = normalizePlan(x)
    return key === epicKeyOf(p.jira) ? { ...p, epic: { key, children, at } } : p
  })
}

/** Reads an epic's children through the Atlassian connector; a permission check like any call. */
async function fetchEpic($: EngineInterface, key: string, site: string) {
  const input = {
    tool: 'mcp__atlassian__searchJiraIssuesUsingJql',
    cloudId: site.replace(/^https?:\/\//, ''),
    jql: `parent = ${key} ORDER BY rank`,
    fields: ['summary', 'status', 'issuetype', 'assignee'],
    maxResults: 50,
  }
  const ran = (await $.tool.call(input as never)) as { deny?: string; result?: unknown; isError?: boolean }
  if (ran.deny === undefined && ran.isError !== true) await noteEpic($, input, ran.result)
}

// An epic read in flight, so the two ways a new anchor is seen ask for it once.
const epicInFlight = new Set<string>()
const EPIC_FRESH_MS = 10 * 60_000

/**
 * After an issue is anchored, reads its epic once, when the person allowed active reads and the
 * issue has a parent; a story with no parent already brought its subtasks, and /os-deck epic
 * remains for a read by hand. A snapshot older than ten minutes is read again.
 */
async function autoEpic($: EngineInterface, isOn: boolean, siteOpt: string | null) {
  if (!isOn) return
  const p = await getPlan($)
  const ek = epicKeyOf(p.jira)
  const site = siteOpt ?? p.jira?.site ?? null
  if (!ek || !site || !p.jira?.parent || epicInFlight.has(ek)) return
  const now = await $.clock.now()
  if (p.epic?.key === ek && now - p.epic.at < EPIC_FRESH_MS) return
  epicInFlight.add(ek)
  try {
    await fetchEpic($, ek, site)
  } catch (err) {
    await say($, 'os-deck', `epic read failed: ${String(err)}`, 'error')
  } finally {
    epicInFlight.delete(ek)
  }
}

const PLAN_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite', 'ExitPlanMode'])

/** The project's plan history lives in the store under the session's directory. */
async function historyKey($: EngineInterface) {
  return `plan-history:${await $.session.cwd()}`
}

/**
 * After a task change: a toast for a group it finished, this session's counts written to the
 * project's history. A subagent taking a task up itself moves under that task.
 */
async function afterPlanChange($: EngineInterface, before: Plan, input: Record<string, unknown>, agentId: string | undefined, now: number) {
  const taskId = typeof input.taskId === 'string' ? input.taskId : null
  if (agentId && taskId && input.status === 'in_progress') await update($, plan, p => planLinkTo(normalizePlan(p), taskId, agentId))
  const after = await getPlan($)
  const finished = groupsFinished(before, after)
  if (finished[0]) $.ui.toast(`✓ ${finished[0]} done`)
  if (input.status === 'completed') {
    const key = await historyKey($)
    const id = await $.session.id()
    await $.store.set(key, historyWith(await $.store.get(key), id, doneByPath(after.tasks), now))
  }
}

/**
 * A resumed session starts with an empty plan: rebuild it from the transcript's own task calls,
 * groups included, and read what earlier sessions finished in this project.
 */
async function rebuildPlan($: EngineInterface) {
  const p0 = await getPlan($)
  if (p0.tasks.length === 0 && !p0.rebuilt) {
    // Reduced in memory and written once: a long session has many task calls.
    const messages = await $.session.messages()
    let p = p0
    for (const msg of Array.isArray(messages) ? messages : []) {
      for (const use of msg.toolUses) {
        if (!PLAN_TOOLS.has(use.tool) || use.result === undefined || use.isError) continue
        p = planApply(p, use.tool, use.input, use.result, null)
      }
    }
    await update($, plan, () => ({ ...p, rebuilt: true }))
  }
  const [stored, id, now] = await Promise.all([historyKey($).then(k => $.store.get(k)), $.session.id(), $.clock.now()])
  const history = historyBefore(stored, id, now)
  await update($, plan, p => ({ ...normalizePlan(p), history }))
}

/** A stored shape older than this build's: drop what cannot be read, keep the rest. */
async function migrate($: EngineInterface) {
  const m = await read($, meta)
  if ((m?.schemaVersion ?? 0) >= SCHEMA_VERSION) return
  await update($, log, list => normalizeLog(list))
  await update($, agents, list => listOf<unknown>(list).map(normalizeCard))
  await update($, gate, g => normalizeGate(g))
  await update($, meta, () => ({ schemaVersion: SCHEMA_VERSION }))
}

async function say($: EngineInterface, who: string, text: string, kind: LogLine['kind'] = 'info', agentId: string | null = null) {
  const line: LogLine = { at: await $.clock.now(), who, text, kind, agentId }
  await update($, log, list => [...normalizeLog(list), line].slice(-60))
}

async function refreshStatus($: EngineInterface, cfg: Config) {
  if (!cfg.statusLine) return $.ui.status(undefined)
  const [u, a, g, cards] = await Promise.all([getUsage($), getArchitect($), getGate($), getCards($)])
  const running = cards.filter(c => c.status === 'running').length
  const s = gateSummary(g)
  const parts = [
    u.pct !== null ? `ctx ${Math.round(u.pct)}%` : null,
    cards.length > 0 ? `agents ${running}/${cards.length}` : null,
    a.consults.length > 0 || a.ids.length > 0 ? `${cfg.architectLabel.toLowerCase()} ${isAdvising(a) ? 'advising' : a.consults.length}` : null,
    s.deny > 0 ? `denied ${s.deny}` : null,
  ]
  // Only fields with something to say; with none, no status entry at all.
  const shown = parts.filter(Boolean)
  $.ui.status(shown.length > 0 ? shown.join(' · ') : undefined)
}

async function whoIs($: EngineInterface, agentId: string | undefined) {
  if (!agentId) return 'main'
  const card = (await getCards($)).find(c => c.id === agentId)
  return card ? shorten(cardTitle(card), 14) : 'agent'
}

async function consultStarted($: EngineInterface, cfg: Config, id: string, via: string, about = '') {
  const t = await getTurn($)
  const moment = momentOf(t)
  const at = await $.clock.now()
  await update($, architect, a => startConsult(normalize(DEFAULT_ARCHITECT, a), { id, at, moment, via, ...(about ? { about } : {}) }))
  if (moment === 'before done') await update($, turn, x => ({ ...normalize(DEFAULT_TURN, x), isReviewing: true }))
  await say($, cfg.architectLabel.toLowerCase(), cfg.moments ? `${moment} · ${via}` : `consulted · ${via}`, 'consult')
  await refreshStatus($, cfg)
}

async function consultEnded($: EngineInterface, cfg: Config, advice: string | null, id?: string) {
  const at = await $.clock.now()
  const text = advice ? adviceLine(advice) || null : null
  await update($, architect, a => endConsult(normalize(DEFAULT_ARCHITECT, a), at, text, id))
  await update($, turn, t => ({ ...normalize(DEFAULT_TURN, t), isReviewing: false }))
  await say($, cfg.architectLabel.toLowerCase(), text ? `advice: ${shorten(text, 60)}` : 'advice returned', 'consult')
  await refreshStatus($, cfg)
}

async function noteAdvice($: EngineInterface, cfg: Config, advice: string, id: string | null = null) {
  const isNew = advice !== (await getArchitect($)).lastAdvice
  await update($, architect, x => adviseConsult(normalize(DEFAULT_ARCHITECT, x), id, advice))
  if (isNew) await say($, cfg.architectLabel.toLowerCase(), `advice: ${shorten(advice, 60)}`, 'consult')
}

async function isArchitectType($: EngineInterface, cfg: Config, type: string) {
  return cfg.architect.test(type) || (await getRoster($)).architectTypes.includes(type)
}

async function openPane($: EngineInterface) {
  // columns apply when docked beside the transcript, rows when seated inline above the prompt.
  return $.ui.open({ id: PANE, title: TITLE, columns: PANE_COLUMNS, rows: 8 })
}

async function resetAll($: EngineInterface) {
  await update($, main, m => ({ ...DEFAULT_MAIN, model: normalize(DEFAULT_MAIN, m).model, mode: normalize(DEFAULT_MAIN, m).mode }))
  await update($, architect, () => DEFAULT_ARCHITECT)
  await update($, gate, () => DEFAULT_GATE)
  await update($, agents, () => [])
  await update($, loops, () => [])
  await update($, log, () => [])
  await update($, turn, () => DEFAULT_TURN)
  await update($, receipt, () => null)
  // What the person hid stays hidden: a reset clears the session, not their layout.
  await update($, view, x => ({ ...DEFAULT_VIEW, hidden: hiddenOf(normalize(DEFAULT_VIEW, x).hidden) }))
  await update($, plan, () => DEFAULT_PLAN)
  // The context gauge waits for the next measurement rather than showing the pre-clear fill.
  await update($, usage, x => ({ ...normalize(DEFAULT_USAGE, x), pct: null, tokens: null }))
}

/** The session's cost read fresh, not from the last measurement: the receipt subtracts two of these. */
async function costNow($: EngineInterface): Promise<number | null> {
  const u = await $.session.usage().catch(() => null)
  return u?.cost?.usd ?? null
}

async function noteMode($: EngineInterface, mode: string | undefined) {
  if (mode) await update($, main, m => (normalize(DEFAULT_MAIN, m).mode === mode ? normalize(DEFAULT_MAIN, m) : { ...normalize(DEFAULT_MAIN, m), mode }))
}

// ---------------------------------------------------------------- hooks


export const register: Register = (on, options) => {
  const cfg = parseConfig(options)
  const alertCfg: AlertConfig = { isOn: cfg.alerts, askAfterMs: cfg.alertAfterS * 1000, longTurnMs: cfg.alertTurnMin * 60_000 }
  const C = colorsOf(cfg)
  const native = cfg.style === 'native'
  // What a number or a gauge is drawn in: the panel's colour in cards; in the native style plain
  // text, the accent kept for markers and the working state as the transcript keeps it.
  const val = (color: string) => (native ? C.text : color)
  // tool.check carries no loop id; the tool.call around it does, keyed by the call's id.
  const callLoop = new Map<string, string | null>()

  on('session.start', async ($, e, next) => {
    // /os-deck is the name shown; /flightdeck stays for the habit.
    for (const name of ['os-deck', 'flightdeck'])
      await $.command.register({
        name,
        description: 'OS-Deck, the live agent dashboard: open, close, reset, or set the layout',
        argumentHint: '[open|close|reset|demo|epic|pet|today|history|github|account [n|email|next]|hide <section>|show <section>|sections|layout auto|compact|wide|mini]',
      })
    await migrate($)
    // One timer per load: a reload runs session.start again, and a timer an older load left behind
    // finds its generation stale and does nothing.
    stopAccountTimers()
    if (cfg.cswap) {
      const gen = ++accountGen
      accountTimer = $.clock.every(ACCOUNT_POLL_MS, () => {
        if (gen === accountGen) void pokeAccount($, cfg, false)
      })
      void pokeAccount($, cfg, true)
    }
    const hidden = hiddenOf(await $.store.get(HIDDEN_KEY).catch(() => []))
    await update($, view, x => ({ ...normalize(DEFAULT_VIEW, x), hidden }))
    void pokeGit($, cfg.panels.includes('git'), true)
    void pokeGithub($, cfg, true)
    // A host without usage (headless, an SDK host, a session not yet bound) just starts without it.
    const u = await $.session.usage().catch(() => null)
    if (u) {
      const holding = isHolding(await getAccount($), await $.clock.now())
      await update($, usage, x => ({
        ...normalize(DEFAULT_USAGE, x),
        pct: u.context.percent ?? null,
        tokens: u.context.tokens ?? null,
        window: u.context.window,
        costUsd: u.cost?.usd ?? null,
        limits: holding ? [] : u.rateLimits.map(limitOf),
      }))
    }
    if (cfg.panels.includes('plan')) await rebuildPlan($).catch(err => say($, 'flightdeck', `plan rebuild failed: ${String(err)}`, 'error'))
    if (cfg.openOnStart) void openPane($).catch(() => undefined)
    await refreshStatus($, cfg)
    return next(e)
  })

  // An issue key in a prompt (ABC-407) is what the plan anchors to once its issue is read.
  on('prompt.submit', async ($, e, next) => {
    void pokeAccount($, cfg, false)
    const keys = cfg.panels.includes('plan') ? jiraKeysIn(e.text) : []
    if (keys.length > 0) {
      await update($, plan, x => {
        const p = normalizePlan(x)
        return { ...p, cited: [...(p.cited ?? []).filter(k => !keys.includes(k)), ...keys].slice(-10) }
      })
      const key = keys[keys.length - 1]
      const site = cfg.jiraSite
      if (cfg.jiraFetch && site && key && (await getPlan($)).jira?.key !== key) {
        void fetchJira($, key, site)
          .then(() => autoEpic($, cfg.jiraFetch, cfg.jiraSite))
          .catch(err => say($, 'flightdeck', `jira read failed: ${String(err)}`, 'error'))
      }
    }
    return next(e)
  })

  // The plan panel draws Claude's tasks as a tree: ask it to name each task's place in one.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!cfg.planHint || !cfg.panels.includes('plan') || !e.tools.includes('TaskCreate')) return composed
    const pc = await getPlan($)
    const groups = pc.groups ?? []
    const hint = cfg.planPolicy === 'always' ? planPolicyHint(cfg.planPhases) : PLAN_HINT
    const base = groups.length > 0 ? `${hint} The approved plan's sections, to use as group names in this order where they fit: ${groups.map(x => `"${x}"`).join(', ')}.` : hint
    const text = pc.jira ? `${base} ${jiraHint(pc.jira)}` : base
    return { sections: [...composed.sections, { id: 'flightdeck:plan-groups', text, scope: 'session' as const }] }
  })

  on('session.end', async ($, e, next) => {
    // A /clear keeps the account: it is the person's, not the conversation's.
    if (e.reason !== 'clear') {
      stopAccountTimers()
      stopAlerts()
    }
    if (e.reason === 'clear') {
      await resetAll($)
      await refreshStatus($, cfg)
    }
    return next(e)
  })

  on('command.run', async ($, e, next) => {
    if (e.command !== 'os-deck' && e.command !== 'flightdeck') return next(e)
    const [verb = 'open', arg = ''] = e.args.trim().split(/\s+/)
    if (verb === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'OS-Deck closed.' }
    }
    if (verb === 'reset') {
      await resetAll($)
      await refreshStatus($, cfg)
      return { text: 'OS-Deck reset.' }
    }
    if (verb === 'demo') {
      const now = await $.clock.now()
      await update($, plan, () => demoPlan(now))
      const opened = await openPane($)
      return { text: `OS-Deck: a sample plan is in the plan panel; /os-deck reset clears it.${opened.isPlaced ? '' : ` The pane is not shown yet: ${opened.reason}`}` }
    }
    if (verb === 'hide' || verb === 'show') {
      const section = deckSectionOf(arg)
      if (!section) return { text: `Usage: /os-deck ${verb} ${DECK_SECTIONS.join('|')}` }
      const { hidden, isSaved } = await setHidden($, section, verb === 'hide')
      const saved = isSaved ? '' : ' (this session only: it could not be saved)'
      return { text: `OS-Deck: ${section} ${verb === 'hide' ? 'hidden' : 'shown'}${saved}.${hidden.length > 0 ? ` Hidden: ${hidden.join(', ')}.` : ''}` }
    }
    if (verb === 'epic') {
      const p = await getPlan($)
      const ek = epicKeyOf(p.jira)
      const site = cfg.jiraSite ?? p.jira?.site ?? null
      if (!ek) return { text: 'OS-Deck: no Jira issue anchors the plan yet. Cite one (ABC-123) and let Claude read it.' }
      if (!site) return { text: 'OS-Deck: set the Jira site option (your-team.atlassian.net) to read the epic.' }
      try {
        await fetchEpic($, ek, site)
      } catch (err) {
        return { text: `OS-Deck: ${ek} could not be read: ${String(err)}` }
      }
      const ep = (await getPlan($)).epic
      return { text: ep?.key === ek ? `OS-Deck: ${ek} has ${ep.children.length} children.` : `OS-Deck: ${ek} could not be read.` }
    }
    if (verb === 'today' || verb === 'hoje' || verb === 'history' || verb === 'historico' || verb === 'histórico') {
      const stored = await $.store.get(HISTORY_KEY).catch(() => null)
      return { text: historyReport(stored, await $.clock.now(), verb === 'today' || verb === 'hoje' ? 1 : 7) }
    }
    if (verb === 'github' || verb === 'gh' || verb === 'pr') {
      if (!cfg.github) return { text: 'OS-Deck: the GitHub section is off in the github option.' }
      await pokeGithub($, cfg, true)
      const x = await getGithub($)
      if (x.status === 'missing') return { text: `OS-Deck: ${cfg.ghCommand} was not found. Install the GitHub CLI or set the ghCommand option.` }
      if (x.status === 'error') return { text: `OS-Deck: GitHub could not be read: ${x.error ?? 'unknown error'}` }
      if (x.status === 'off') return { text: 'OS-Deck: GitHub has not been read yet; the session log says why if the read failed.' }
      if (x.pr) return { text: `OS-Deck: #${x.pr.number} ${x.pr.title} · ${x.pr.state}${x.pr.isDraft ? ' (draft)' : ''} · ${checksLine(x.pr.checks).text} · review ${x.pr.review}${x.pr.closes.length ? ` · closes ${x.pr.closes.map(n => `#${n}`).join(' ')}` : ''}` }
      return { text: `OS-Deck: no pull request for this branch; ${x.open.length} open in the repository.` }
    }
    if (verb === 'pet' || verb === 'mascote') {
      return { text: petReport(cfg, hiddenOf((await getView($)).hidden)) }
    }
    if (verb === 'account' || verb === 'conta') {
      return { text: await accountCommand($, cfg, e.args.trim().split(/\s+/).slice(1).join(' ')) }
    }
    if (verb === 'sections') {
      const hidden = hiddenOf((await getView($)).hidden)
      const isOff = (x: DeckSection) =>
        x === 'pet' ? !cfg.pet || !cfg.panels.includes('main') : x === 'github' ? !cfg.github : x !== 'title' && !cfg.panels.includes(x === 'header' ? 'main' : x)
      const label = (x: DeckSection) => (hidden.includes(x) ? `${x} (hidden)` : isOff(x) ? `${x} (off in the panels option)` : x)
      return { text: `OS-Deck sections: ${DECK_SECTIONS.map(label).join(', ')}. /os-deck hide|show <section>.` }
    }
    if (verb === 'layout') {
      const layout: Layout | null = arg === 'compact' || arg === 'wide' || arg === 'auto' || arg === 'mini' ? arg : null
      if (!layout) return { text: 'Usage: /os-deck layout auto|compact|wide|mini' }
      await update($, view, v => ({ ...normalize(DEFAULT_VIEW, v), layout }))
      const opened = await openPane($)
      return { text: opened.isPlaced ? `OS-Deck layout: ${layout}.` : `Layout set to ${layout}; the pane is not shown yet: ${opened.reason}` }
    }
    void pokeGit($, cfg.panels.includes('git'), true)
    void pokeAccount($, cfg, false)
    const opened = await openPane($)
    if (!opened.isPlaced) return { text: `OS-Deck is not shown yet: ${opened.reason}` }
    return { text: 'OS-Deck opened. Focus it with ctrl+x tab; 1-6 expand cards, f/s/o open the gate rows.' }
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await noteMode($, e.permission_mode)
    return next(e)
  })

  // The mode read fresh during the turn, so the pet knows who an ask goes to (shift+tab mid-turn
  // included). `classic.PreToolUse` carries only the tool call now; these two still carry the
  // hook's common fields: a permission request as its dialog is about to open, and each finished call.
  on('classic.PermissionRequest', async ($, e, next) => {
    if (!e.agent_id) await noteMode($, e.permission_mode)
    return next(e)
  })
  on('classic.PostToolUse', async ($, e, next) => {
    if (!e.agent_id) await noteMode($, e.permission_mode)
    return next(e)
  })

  on('agent.offer', async ($, e, next) => {
    const offered = await next(e)
    if (cfg.architect.test(e.agent) || (cfg.matchDescriptions && cfg.architect.test(e.description))) {
      await update($, roster, r => {
        const x = normalize(DEFAULT_ROSTER, r)
        return x.architectTypes.includes(e.agent) ? x : { architectTypes: [...listOf<string>(x.architectTypes), e.agent].slice(-20) }
      })
    }
    return offered
  })

  on('turn.start', async ($, e, next) => {
    // A subagent's run is not the main loop's turn: it must not restart the turn or mark main running.
    if (e.agentId !== undefined) return next(e)
    const [now, cost] = await Promise.all([$.clock.now(), costNow($)])
    await update($, turn, () => ({ ...DEFAULT_TURN, startedAt: now, costAtStart: cost }))
    await update($, main, m => ({ ...normalize(DEFAULT_MAIN, m), isRunning: true }))
    // A background architect's report reaches the main loop as the text opening this turn. The
    // SubagentHandback tool call (in tool.call) normally carries it first; this is the fallback.
    const back = e.text ? handbackOf(e.text) : null
    const a = back ? await getArchitect($) : null
    if (back && a && a.ids.includes(back.from)) {
      const advice = adviceLine(back.body)
      if (advice) await noteAdvice($, cfg, advice, back.from)
    } else if (e.text) {
      const p = promptLine(e.text)
      await say($, p.who, p.text)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // The main loop's model is known when its request starts; a long first request shouldn't read "—".
    if (!e.agentId) {
      // A new request: the tool the last one ran is over, and the pet is back to thinking.
      await update($, main, m => {
        const x = normalize(DEFAULT_MAIN, m)
        return { ...x, model: e.model, effort: String(e.effort ?? x.effort), steps: x.steps + 1, tool: null }
      })
      // Time the response as it passes: the first piece that is not the engine's envelope, then the
      // stop chunk. Two clock reads in the stream and nothing stored until it has ended.
      const sentAt = await $.clock.now()
      let firstAt: number | null = null
      let stopAt: number | null = null
      const s = next(e)
      for await (const c of s) {
        if (c.kind === 'stop') stopAt = await $.clock.now()
        else if (firstAt === null && c.kind !== 'engine') firstAt = await $.clock.now()
        yield c
      }
      const result = await s.result
      const speed = result.usage && stopAt !== null ? stepSpeed(sentAt, firstAt, stopAt, result.usage.output_tokens) : null
      if (speed) await update($, main, m => ({ ...normalize(DEFAULT_MAIN, m), speed }))
      return result
    }
    const result = yield* next(e)
    const id = e.agentId
    const [cards, a] = await Promise.all([getCards($), getArchitect($)])
    if (cards.some(c => c.id === id)) {
      const step = { model: e.model, usage: result.usage, stopReason: result.stopReason }
      await update($, agents, list => listOf<unknown>(list).map(normalizeCard).map(c => (c.id === id ? applyStep(c, step) : c)))
      if (result.stopReason === 'max_tokens') await say($, await whoIs($, id), 'hit max_tokens', 'error', id)
    } else if (!a.ids.includes(id)) {
      const now = await $.clock.now()
      await update($, loops, l => stepLoop(listOf<Loop>(l), id, now))
    }
    return result
  })

  on('session.measure', async ($, e, next) => {
    // A measurement may be the old account's for a while after a switch: cswap's reading stands in.
    void pokeAccount($, cfg, false)
    const holding = isHolding(await getAccount($), await $.clock.now())
    await update($, usage, x => ({
      ...normalize(DEFAULT_USAGE, x),
      pct: e.context.percent ?? null,
      tokens: e.context.tokens ?? null,
      window: e.context.window,
      costUsd: e.cost?.usd ?? null,
      limits: holding ? [] : e.rateLimits.map(limitOf),
    }))
    if (e.changed.includes('context')) await refreshStatus($, cfg)
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (!e.agentId && e.trigger !== 'precompute') {
      const now = await $.clock.now()
      await update($, usage, x => {
        const u = normalize(DEFAULT_USAGE, x)
        return { ...u, compactions: u.compactions + 1, lastCompactAt: now }
      })
      await say($, 'main', `context compacted (${e.trigger})`)
    }
    return done
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (e.tool_use_id) {
      const check: Check = {
        id: e.tool_use_id,
        tool: e.tool,
        bucket: bucketOf(e.tool),
        verdict: verdict.decision === 'allow' ? 'rule' : verdict.decision,
        inSubagent: Boolean(callLoop.get(e.tool_use_id)),
        detail: shorten(describeInput(e.tool, e.input), 90),
        at: await $.clock.now(),
      }
      await update($, gate, g => recordCheck(normalizeGate(g), check))
      // An ask the person must answer is announced if it still waits a while later (not in auto mode: the classifier answers).
      if (check.verdict === 'ask' && (await getMain($)).mode !== 'auto')
        scheduleAskAlert($, alertCfg, check.id, check.tool, check.detail, async () => (await getGate($)).recent.some(c => c.id === check.id && c.verdict === 'ask'))
      // The status line updates when the call settles; only a refusal ends here.
      if (verdict.decision === 'deny') {
        await say($, 'gate', `denied by rule · ${check.detail}`, 'error')
        await refreshStatus($, cfg)
      }
    }
    return verdict
  })

  on('tool.call', async ($, e, next) => {
    callLoop.set(e.tool_use_id, e.agentId ?? null)
    if (!e.agentId) mainTool = { tool: e.tool, text: shorten(describeInput(e.tool, e), 64), at: await $.clock.now(), endAt: null }
    // The pet acts out the main loop's tool; written only when what it acts out changes.
    if (cfg.pet && !e.agentId) {
      const m0 = await getMain($)
      if (petToolKind(m0.tool ?? null) !== petToolKind(e.tool)) await update($, main, m => ({ ...normalize(DEFAULT_MAIN, m), tool: e.tool }))
    }
    const ran = await next(e).finally(() => callLoop.delete(e.tool_use_id))
    const didRun = ran.deny === undefined
    // Settle this call's pending ask, if it had one; skip the write (and the redraw) otherwise.
    const g0 = await getGate($)
    const isSettled = settleCheck(g0, e.tool_use_id, didRun) !== g0
    if (!e.agentId && mainTool !== null && mainTool.tool === e.tool) mainTool = { ...mainTool, endAt: await $.clock.now() }
    if (isSettled) {
      await update($, gate, g => settleCheck(normalizeGate(g), e.tool_use_id, didRun))
      settleAskAlert(e.tool_use_id)
      // The time the person took to answer, for the day's history.
      const asked = g0.recent.find(c => c.id === e.tool_use_id && c.verdict === 'ask')
      if (asked) {
        const at = await $.clock.now()
        void recordDay($, at, { asks: 1, askWaitMs: Math.max(0, at - asked.at) })
      }
    }
    // A background agent hands its report back through this tool; an architect's report is its advice.
    if (String(e.tool) === 'SubagentHandback') {
      const message = (e as unknown as { message?: unknown }).message
      const a = e.agentId ? await getArchitect($) : null
      if (a && e.agentId && a.ids.includes(e.agentId) && typeof message === 'string') {
        const advice = adviceLine(message)
        if (advice) await noteAdvice($, cfg, advice, e.agentId)
      }
      return ran
    }
    if (String(e.tool).endsWith('__getJiraIssue') && didRun && ran.isError !== true) {
      await noteJira($, e as unknown as Record<string, unknown>, ran.result, cfg.jiraSite).catch(err => say($, 'flightdeck', `jira read failed: ${String(err)}`, 'error'))
      // A newly anchored issue's epic is read once when the person allowed active reads.
      void autoEpic($, cfg.jiraFetch, cfg.jiraSite)
      return ran
    }
    if (String(e.tool).endsWith('__searchJiraIssuesUsingJql') && didRun && ran.isError !== true) {
      await noteEpic($, e as unknown as Record<string, unknown>, ran.result).catch(err => say($, 'os-deck', `epic read failed: ${String(err)}`, 'error'))
      return ran
    }
    if (PLAN_TOOLS.has(e.tool)) {
      // The task list is the session's, shared with subagents; a todo list is each loop's own, so only the main one's.
      const isOwnTodos = e.tool === 'TodoWrite' && Boolean(e.agentId)
      if (didRun && ran.isError !== true && !isOwnTodos) {
        const input = e as unknown as Record<string, unknown>
        const [before, now] = await Promise.all([getPlan($), $.clock.now()])
        await notePlan($, e.tool, input, ran.result, now)
        if (e.tool === 'TaskUpdate') await afterPlanChange($, before, input, e.agentId, now).catch(err => say($, 'flightdeck', `plan update failed: ${String(err)}`, 'error'))
        if (e.tool === 'TaskUpdate' && input.status === 'completed') void recordDay($, now, { tasks: 1 })
      }
      if (isSettled) await refreshStatus($, cfg)
      return ran
    }
    if (e.tool === 'Agent') {
      if (isSettled) await refreshStatus($, cfg)
      return ran
    }
    const hasFailed = didRun && ran.isError === true
    const isEdit = !hasFailed && didRun && EDIT_TOOLS.has(e.tool)
    if (didRun && (isEdit || e.tool === 'Bash')) void pokeGit($, cfg.panels.includes('git'), false)
    // A push or a gh pr command changes what the GitHub section shows: read it again now.
    if (didRun && (e.tool === 'Bash' || e.tool === 'PowerShell') && /\bgit\s+push\b|\bgh\s+pr\b/.test(String((e as unknown as { command?: unknown }).command ?? ''))) void pokeGithub($, cfg, true)
    const t0 = await getTurn($)
    if (isEdit || hasFailed || (!e.agentId && t0.errorStreak > 0)) {
      const failedAt = hasFailed && !e.agentId ? await $.clock.now() : null
      await update($, turn, t => {
        const x = afterCall(normalize(DEFAULT_TURN, t), { inSubagent: Boolean(e.agentId), hasFailed, isEdit })
        return failedAt !== null ? { ...x, lastErrorAt: failedAt } : x
      })
    }
    const text = shorten(describeInput(e.tool, e), 64)
    if (e.agentId) {
      const id = e.agentId
      await update($, agents, list =>
        listOf<unknown>(list)
          .map(normalizeCard)
          .map(c => (c.id === id ? noteTool(c, { tool: e.tool, text, isError: hasFailed || ran.deny !== undefined }) : c)),
      )
    }
    // The log keeps what is worth a glance: refusals, errors and edits; the rest is on the cards.
    if (ran.deny !== undefined) await say($, await whoIs($, e.agentId), `${text}  denied`, 'error', e.agentId ?? null)
    else if (hasFailed) await say($, await whoIs($, e.agentId), `${text}  ✗`, 'error', e.agentId ?? null)
    else if (isEdit) await say($, await whoIs($, e.agentId), text, 'info', e.agentId ?? null)
    if (isSettled || !didRun) await refreshStatus($, cfg)
    return ran
  })

  // A server-side review tool never reaches tool.call: it shows only in the assistant's rows.
  on('session.append', async ($, e, next) => {
    if (!e.agentId && e.message.type === 'assistant') {
      const a = await getArchitect($)
      // Consults this row opened: their result may be in the same row, after the stale read above.
      const opened = new Set<string>()
      for (const block of e.message.content as unknown as readonly ServerBlock[]) {
        if (block.type === 'server_tool_use' && block.name && block.id && cfg.architect.test(block.name)) {
          if (a.seen.includes(block.id)) continue
          const id = block.id
          await update($, architect, x => {
            const y = normalize(DEFAULT_ARCHITECT, x)
            return { ...y, seen: [...listOf<string>(y.seen), id].slice(-60) }
          })
          opened.add(id)
          await consultStarted($, cfg, id, `${block.name} tool`)
        } else if (block.type.endsWith('_tool_result') && block.tool_use_id) {
          const id = block.tool_use_id
          const isOpen = opened.has(id) || (await getArchitect($)).consults.some(c => c.id === id && c.endAt === null)
          if (isOpen) await consultEnded($, cfg, null, id)
        }
      }
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (!e.parentAgentId) await noteMode($, e.permissionMode)
    if (started.deny !== undefined || !started.agentId) return started
    const id = started.agentId
    if (await isArchitectType($, cfg, e.subagentType)) {
      await update($, architect, a => {
        const x = normalize(DEFAULT_ARCHITECT, a)
        return { ...x, ids: [...listOf<string>(x.ids), id].slice(-40) }
      })
      await update($, loops, l => listOf<Loop>(l).filter(x => x.id !== id))
      await consultStarted($, cfg, id, e.subagentType.split(':').pop() ?? 'agent', e.description ?? '')
      return started
    }
    // A resumed agent spawns again under its id: its card runs again, with what it has done so far.
    const prior = (await getCards($)).find(c => c.id === id)
    const card: AgentCard = {
      ...(prior ?? normalizeCard({})),
      id,
      type: e.name ?? e.subagentType,
      model: started.model,
      description: e.description || (prior?.description ?? ''),
      status: 'running',
      spawnedAt: await $.clock.now(),
      endedAt: null,
      lastStop: null,
      answer: '',
    }
    await update($, agents, list => [...cardsOf(list).filter(c => c.id !== id), card].slice(-24))
    await update($, plan, p => planLinkAgent(normalizePlan(p), id))
    await update($, loops, l => listOf<Loop>(l).filter(x => x.id !== id))
    await say($, shorten(cardTitle(card), 12), `spawned · ${card.type}`, 'info', id)
    await refreshStatus($, cfg)
    return started
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const id = e.agentId
    const now = await $.clock.now()
    if (!id) {
      const [t, cards, cost] = await Promise.all([getTurn($), getCards($), costNow($)])
      const r = receiptOf(t, {
        durationMs: e.durationMs,
        agentsSince: cards.filter(c => c.spawnedAt >= t.startedAt).length,
        costNow: cost,
        reason: e.reason,
      })
      await update($, receipt, () => r)
      await update($, main, m => ({ ...normalize(DEFAULT_MAIN, m), isRunning: false, tool: null, endedAt: e.reason === 'answer' ? now : (normalize(DEFAULT_MAIN, m).endedAt ?? null) }))
      // The context at the turn's end, for the turns-left forecast.
      await update($, usage, x => {
        const u = normalize(DEFAULT_USAGE, x)
        return { ...u, turnPcts: withReading(u.turnPcts, u.pct) }
      })
      void recordDay($, now, { turns: 1, busyMs: e.durationMs, agents: r.agents, costUsd: r.costDelta ?? 0 })
      if (isTurnAlert(alertCfg, e.reason, e.durationMs)) void sendAlert($, turnAlertText(e.reason, e.durationMs, r.edits, r.errors), 'turn')
      await refreshStatus($, cfg)
      void pokeGit($, cfg.panels.includes('git'), true)
      void pokeGithub($, cfg, false)
      return done
    }
    if ((await getArchitect($)).ids.includes(id)) {
      await consultEnded($, cfg, e.answer, id)
      return done
    }
    const cards = await getCards($)
    if (cards.some(c => c.id === id)) {
      const status = e.reason === 'answer' ? 'done' : e.reason === 'aborted' ? 'stopped' : 'failed'
      await update($, agents, list =>
        listOf<unknown>(list)
          .map(normalizeCard)
          .map(c => (c.id === id ? { ...c, status, endedAt: now, answer: shorten(e.answer, 400) } : c)),
      )
      const card = cards.find(c => c.id === id)
      const took = card ? fmtDuration(now - card.spawnedAt) : ''
      await say($, await whoIs($, id), status === 'done' ? `done · ${took}` : status, status === 'done' ? 'done' : 'error', id)
    } else {
      await update($, loops, l => listOf<Loop>(l).map(x => (x.id === id ? { ...x, isDone: true, lastAt: now } : x)))
    }
    await refreshStatus($, cfg)
    return done
  })

  // ---------------------------------------------------------------- drawing

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // Set again below only when this draw reaches the plan view's header.
    petSeen = null
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const hasClient = 'Client' in els
    // The skin's colours where the skins mod is on; a read is a subscription, so a /skin change redraws.
    const none = { value: undefined }
    // The pet wears the skin's accent in the native style too.
    const useSkin = cfg.palette === 'skin' && (!native || cfg.pet)
    const [sp, sc, sl] = useSkin
      ? await Promise.all([
          $.state.get(skinPrefs as never).catch(() => none),
          $.state.get(skinCustom as never).catch(() => none),
          $.state.get(skinLight as never).catch(() => none),
        ]).then(xs => xs.map(x => (x as { value?: unknown }).value))
      : [null, null, false]
    const C = colorsOf(cfg, skinColors(sp, sc, sl === true))
    const [m, u0, a, g, cards, lp, lines, t, r, v, now, pl, gt, acc, ghs] = await Promise.all([
      getMain($),
      getUsage($),
      getArchitect($),
      getGate($),
      getCards($),
      getLoops($),
      getLog($),
      getTurn($),
      read($, receipt),
      getView($),
      $.clock.now(),
      getPlan($),
      getGit($),
      getAccount($),
      getGithub($),
    ])
    // The limits drawn: the session's, or cswap's reading of the active account (marked ~).
    const shown = shownLimits(u0.limits, acc, now)
    const u = { ...u0, limits: shown.limits }
    const limTag = shown.isCswap ? '~' : ''
    // What the pet is doing: the main loop's tool and turn timings, the asks and agents in flight.
    const petInput: PetInput = {
      isRunning: m.isRunning,
      tool: m.tool ?? null,
      agents: cards.filter(c => c.status === 'running').length,
      // In auto mode an ask goes to the classifier, not the person: nothing waits on them.
      asks: m.mode === 'auto' ? 0 : g.recent.filter(c => c.verdict === 'ask').length,
      errorAt: t.lastErrorAt ?? null,
      doneAt: m.endedAt ?? null,
      activeAt: Math.max(t.startedAt, m.endedAt ?? 0),
      now,
      // The cubes: every subagent in spawn order, its colour its place in that order, as in the plan.
      friends: cards.map((c, i) => ({ color: i, status: c.status === 'failed' ? ('failed' as const) : c.status === 'running' ? ('running' as const) : ('done' as const), endedAt: c.endedAt })),
      compactAt: u0.lastCompactAt,
      ctxPct: u0.pct,
    }
    const petNow = petStateOf(petInput)
    // Turns until the context is full, at the rate the last turns filled it.
    const ctxTurns = turnsToFull(u0.turnPcts ?? [], u0.pct)
    const ctxLeft = turnsLine(ctxTurns)
    const petColors = petColorsOf(cfg.pet ? skinColors(sp, sc, sl === true)?.main : null)
    // The accounts cswap knows, listed under the header while the account row is open.
    const accountRows = v.accountOpen && acc.status === 'ok' ? acc.accounts.slice(0, 6) : []
    const W = Math.max(40, e.props.bodyColumns)
    const layout = v.layout ?? cfg.layout
    const isWide = layout === 'wide' || (layout === 'auto' && W >= 110)
    const colW = isWide ? Math.floor((W - 2) / 2) : W
    const modelName = prettyModel(m.model)
    const viewed = e.props.view?.agentId ?? null
    const advising = isAdvising(a)
    const running = cards.filter(c => c.status === 'running')
    const showArchitect = a.consults.length > 0 || a.ids.length > 0
    const motion = cfg.motion && hasClient
    // A panel with nothing to show yet takes no room: most sessions never spawn an agent.
    const isEmpty: Record<Panel, boolean> = {
      main: false,
      architect: !showArchitect,
      gate: g.recent.length === 0 && gateSummary(g).total === 0,
      agents: cards.length === 0,
      loops: lp.length === 0,
      plan: pl.tasks.length === 0,
      receipt: !m.isRunning && !r,
      log: false,
      // Drawn by the plan view alone.
      git: true,
      epic: true,
      timeline: true,
    }
    const panels = cfg.panels.filter(p => !isEmpty[p])
    const decider = m.mode === 'auto' ? 'classifier' : 'you'

    // A connector between panels: animated while its flow is live, a dim line otherwise.
    const rail = (key: string, active: boolean, color: string, width: number, marks: number[] = [], isMerge = false) =>
      motion ? (
        <els.Client
          key={key}
          module="./rail.tsx"
          width={width}
          height={1}
          props={{ active, width, color, dim: C.faint, marks, isMerge }}
        />
      ) : (
        <Text color={C.faint}>{'▱'.repeat(Math.max(1, width))}</Text>
      )

    // Work in progress: a turning braille grid and a glint along the label, or a still dot.
    const spin = (key: string, label: string, color: string) =>
      motion ? (
        <els.Client key={key} module="./spinner.tsx" height={1} props={{ label, color, dim: C.faint }} />
      ) : (
        <Text color={color} wrap="truncate">{`● ${label}`}</Text>
      )

    // A start time of 0 is unknown (state saved before it was recorded): no clock, not decades.
    const clock = (key: string, since: number, endAt: number | null, color: string) =>
      since <= 0 ? (
        <Text color={color}>—</Text>
      ) : hasClient ? (
        <els.Client key={key} module="./elapsed.tsx" props={{ since, now, endAt, color }} />
      ) : (
        <Text color={color}>{fmtTimer((endAt ?? now) - since)}</Text>
      )

    // The body's fill: the terminal's background when the person names it, else the surface's own.
    const fill = cfg.background ? { backgroundColor: cfg.background } : {}

    // A panel's frame: upstream's coloured border, or in the native style none, only a gap above,
    // the way the transcript separates its rows.
    const frame = (color: string, dim = false) =>
      native ? { marginTop: 1 } : { borderStyle: 'round', borderColor: color, borderDimColor: dim, paddingX: 1 }
    // A panel's title: in the native style a transcript row's marker in the accent, the words plain.
    const title = (label: string, color: string) =>
      native ? (
        <Text bold wrap="truncate">
          <Text color={color}>● </Text>
          {label}
        </Text>
      ) : (
        <Text color={color} bold>
          {label}
        </Text>
      )

    // ---- main
    const effortN = { low: 1, medium: 2, high: 3, xhigh: 4, max: 4 }[m.effort] ?? 0
    const ctxGauge = u.pct !== null ? gauge(u.pct, 10) : null
    const mainPanel = (w: number) => (
      <Box flexDirection="column" {...frame(C.main)} width={w}>
        <Box justifyContent="space-between">
          {title(`${modelName} · main`, C.main)}
          {m.isRunning ? spin('main-working', 'working', C.main) : <Text color={C.dim}>○ idle</Text>}
        </Box>
        <Text wrap="truncate">
          <Text dimColor>effort </Text>
          <Text color={val(C.main)}>{'▮'.repeat(effortN) + '▯'.repeat(4 - effortN)} </Text>
          <Text color={val(C.main)} bold>
            {m.effort || '—'}
          </Text>
          {m.mode ? <Text dimColor>{`   mode ${m.mode}`}</Text> : null}
          <Text dimColor>{`   ${m.steps} req`}</Text>
        </Text>
        {ctxGauge ? (
          <Text wrap="truncate">
            <Text dimColor>ctx </Text>
            <Text color={u.pct !== null && u.pct >= 80 ? C.warn : val(C.main)}>{ctxGauge.on}</Text>
            <Text color={C.faint}>{ctxGauge.off}</Text>
            <Text bold>{` ${Math.round(u.pct ?? 0)}%`}</Text>
            {u.tokens !== null ? <Text dimColor>{` ${kTokens(u.tokens)}/${kTokens(u.window)}`}</Text> : null}
            {u.compactions > 0 ? <Text color={C.amber}>{`  ⟲${u.compactions}`}</Text> : null}
            {ctxLeft ? <Text color={ctxTurns !== null && ctxTurns <= 2 ? C.warn : C.dim}>{`  ${ctxLeft}`}</Text> : null}
          </Text>
        ) : null}
        {u.costUsd !== null || u.limits.length > 0 ? (
          <Text wrap="truncate">
            {u.costUsd !== null ? <Text color={C.text}>{`${fmtUsd(u.costUsd)}   `}</Text> : null}
            {u.limits.slice(0, 2).map(l => {
              const lg = gauge(l.pct, 5)
              // The time to each reset where the line has room for it: both windows fit from 56 columns,
              // so a wide pane's half column (59 at 120) has them and a 40-column pane keeps its gauges.
              const resetIn = w >= 56 ? fmtResetIn(l.resetsAt, now) : ''
              return (
                <Text wrap="truncate">
                  <Text dimColor>{`${limTag}${limitLabel(l.kind)} `}</Text>
                  <Text color={l.pct >= 80 ? C.warn : val(C.main)}>{lg.on}</Text>
                  <Text color={C.faint}>{lg.off}</Text>
                  <Text dimColor>{` ${Math.round(l.pct)}%${resetIn ? ` ↻${resetIn}` : ''}  `}</Text>
                </Text>
              )
            })}
          </Text>
        ) : null}
        {m.speed ? <Text dimColor wrap="truncate">{`last req  ${fmtSpeed(m.speed)}`}</Text> : null}
      </Box>
    )

    // ---- architect
    const lastConsult = a.consults[a.consults.length - 1]
    const architectPanel = (w: number) => {
      const tl = consultTimeline(a, now, Math.max(8, w - 4))
      return (
        <Box flexDirection="column" {...frame(C.arch)} width={w}>
          <Box justifyContent="space-between">
            {title(`${cfg.architectLabel} · ${advising ? 'advising' : 'on call'}`, C.arch)}
            <Text>
              <Text dimColor>consults </Text>
              <Text color={val(C.arch)} bold>
                {a.consults.length}
              </Text>
            </Text>
          </Box>
          <Text color={native ? C.dim : C.arch}>{tl}</Text>
          {lastConsult ? (
            <Text dimColor wrap="truncate">
              {advising
                ? `consulting since ${fmtClock(lastConsult.at)}`
                : `last ${fmtDuration(now - (lastConsult.endAt ?? lastConsult.at))} ago · took ${fmtDuration((lastConsult.endAt ?? now) - lastConsult.at)}`}
            </Text>
          ) : (
            <Text dimColor>not consulted yet</Text>
          )}
          {cfg.moments ? (
            <Box flexWrap="wrap" columnGap={2}>
              {(['before a plan', 'error repeats', 'before done'] as const).map(mo => {
                const isOn = lastConsult?.moment === mo
                return (
                  <Text color={isOn ? C.arch : C.dim} bold={isOn}>
                    {isOn ? '◆' : '◇'} {mo}
                  </Text>
                )
              })}
              <Text color={C.faint}>(inferred)</Text>
            </Box>
          ) : null}
          {a.lastAdvice ? (
            <Text color={val(C.arch)} wrap="truncate">
              » {a.lastAdvice}
            </Text>
          ) : null}
        </Box>
      )
    }

    // ---- gate
    const s = gateSummary(g)
    const verdictColor = (c: Check) =>
      c.verdict === 'rule' ? C.gate : c.verdict === 'cleared' ? C.cleared : c.verdict === 'ask' ? C.amber : C.warn
    const gatePanel = (w: number) => {
      const strip = g.recent.slice(-Math.max(8, w - 4))
      const open = v.gateOpen
      return (
        <Box flexDirection="column" {...frame(C.gate)} width={w}>
          <Box justifyContent="space-between">
            {title(`${cfg.gateLabel} · permissions`, native ? C.main : C.gate)}
            <Text dimColor>{`${s.total} checks`}</Text>
          </Box>
          <Box>
            {strip.length === 0 ? <Text color={C.faint}>no checks yet</Text> : null}
            {strip.map(c => (
              <Text color={verdictColor(c)} dimColor={c.inSubagent}>
                {c.verdict === 'deny' ? '✗' : '■'}
              </Text>
            ))}
          </Box>
          <Text wrap="truncate">
            <Text color={C.gate}>■</Text>
            <Text dimColor>{` ${s.rule} allowed  `}</Text>
            <Text color={C.cleared}>■</Text>
            <Text dimColor>{` ${s.cleared} ${decider}  `}</Text>
            {s.ask > 0 ? <Text color={C.amber}>{`■ ${s.ask} pending  `}</Text> : null}
            <Text color={s.deny > 0 ? C.warn : C.dim}>{`✗ ${s.deny} denied`}</Text>
            {w >= 80 && g.recent.some(c => c.inSubagent) ? <Text color={C.faint}>{'  dim: in subagents'}</Text> : null}
          </Text>
          <Box columnGap={2}>
            {(['file', 'shell', 'other'] as const).map((b: Bucket) => {
              const tl = g.totals[b]
              const n = tl.rule + tl.ask + tl.cleared + tl.deny
              return (
                <Button
                  key={`gate-${b}`}
                  plain
                  hotkey={b[0]}
                  label={`${b} ${n}${open === b ? ' ▾' : ''}`}
                  dimColor={n === 0}
                  onPress={() => update($, view, x => ({ ...normalize(DEFAULT_VIEW, x), gateOpen: normalize(DEFAULT_VIEW, x).gateOpen === b ? null : b }))}
                />
              )
            })}
          </Box>
          {open
            ? g.recent
                .filter(c => c.bucket === open)
                .slice(-5)
                .map(c => (
                  <Text wrap="truncate">
                    <Text color={verdictColor(c)}>{c.verdict === 'deny' ? '✗ ' : '■ '}</Text>
                    <Text color={C.dim}>{`${(c.verdict === 'rule' ? 'allowed' : c.verdict === 'cleared' ? decider : c.verdict === 'ask' ? 'pending' : 'denied').padEnd(10)} `}</Text>
                    <Text dimColor={c.inSubagent}>{shorten(c.detail, Math.max(10, w - 18))}</Text>
                  </Text>
                ))
            : null}
        </Box>
      )
    }

    // ---- agents: cards up to the limit, swimlanes beyond it
    const statusColor = (c: AgentCard) => (c.status === 'failed' ? C.warn : c.status === 'done' ? C.gate : C.agent)
    const glyph = (c: AgentCard) => (c.status === 'running' ? '◐' : c.status === 'done' ? '✓' : c.status === 'failed' ? '✗' : '■')
    const expandOnPress = (id: string) => () =>
      update($, view, x => ({ ...normalize(DEFAULT_VIEW, x), expanded: normalize(DEFAULT_VIEW, x).expanded === id ? null : id }))

    const agentsPanel = (w: number) => {
      // Cards need 20 columns each; when the pane can't hold the limit, lanes take over.
      const fit = Math.max(1, Math.min(cfg.maxCards, Math.floor((w + 1) / 21)))
      const useLanes = cards.length > fit
      const header = (
        <Box justifyContent="space-between" width={w}>
          {title(`agents · ${running.length} running · ${cards.length} total`, native ? C.main : C.text)}
          {cards.length > 0 ? <Text color={C.faint}>1-{Math.min(cards.length, useLanes ? 6 : fit)} expand</Text> : null}
        </Box>
      )
      if (cards.length === 0) {
        return (
          <Box flexDirection="column" width={w} marginTop={native ? 1 : 0}>
            {header}
            <Text color={C.faint}>no subagents yet</Text>
          </Box>
        )
      }
      if (useLanes) {
        const shown = cards.slice(-6)
        const barW = Math.max(8, w - 28)
        const geo = lanes(shown, now, barW)
        return (
          <Box flexDirection="column" width={w} marginTop={native ? 1 : 0}>
            {header}
            {cards.length > shown.length ? <Text color={C.faint}>{`+${cards.length - shown.length} earlier`}</Text> : null}
            {shown.map((c, i) => {
              const gm = geo[i]
              const isViewed = viewed === c.id
              return (
                <Box>
                  <Text color={statusColor(c)} bold={isViewed}>{`${isViewed ? '▶' : glyph(c)} `}</Text>
                  <Box width={17}>
                    <Button key={`card-${c.id}`} plain hotkey={String(i + 1)} label={shorten(cardTitle(c), 14)} onPress={expandOnPress(c.id)} />
                  </Box>
                  <Text color={C.faint}>{' ' + '·'.repeat(gm?.before ?? 0)}</Text>
                  <Text color={statusColor(c)}>{'━'.repeat(gm?.bar ?? 1)}</Text>
                  <Text color={C.faint}>{'·'.repeat(gm?.after ?? 0) + ' '}</Text>
                  {clock(`lane-clock-${c.id}`, c.spawnedAt, c.endedAt, C.dim)}
                </Box>
              )
            })}
          </Box>
        )
      }
      const shown = cards.slice(-fit)
      const cardW = Math.max(20, Math.floor((w - (shown.length - 1)) / shown.length))
      const centers = shown.map((_, i) => i * (cardW + 1) + Math.floor(cardW / 2))
      return (
        <Box flexDirection="column" width={w} marginTop={native ? 1 : 0}>
          {header}
          {native ? null : rail('fan-out', running.length > 0, C.agent, w, centers)}
          <Box columnGap={1}>
            {shown.map((c, i) => {
              const isViewed = viewed === c.id
              const sameModel = !c.model || prettyModel(c.model) === modelName
              return (
                <Box
                  flexDirection="column"
                  {...(native
                    ? {}
                    : {
                        borderStyle: isViewed ? 'double' : 'round',
                        borderColor: c.lastStop === 'max_tokens' ? C.warn : C.agent,
                        borderDimColor: c.status !== 'running' && !isViewed,
                        paddingX: 1,
                      })}
                  width={cardW}
                >
                  <Button
                    key={`card-${c.id}`}
                    plain
                    hotkey={String(i + 1)}
                    label={`${native && isViewed ? '▶ ' : ''}${titleLines(cardTitle(c), cardW - 7, cardW - 4)[0]}`}
                    onPress={expandOnPress(c.id)}
                  />
                  <Text bold wrap="truncate">
                    {titleLines(cardTitle(c), cardW - 7, cardW - 4)[1]}
                  </Text>
                  <Text color={C.dim} wrap="truncate">
                    {sameModel ? c.type : `${c.type} · ${prettyModel(c.model)}`}
                  </Text>
                  <Text dimColor wrap="truncate">
                    {c.steps > 0 ? `ctx ${kTokens(c.ctx)} · out ${kTokens(c.out)} · ${c.steps} st` : 'starting…'}
                  </Text>
                  <Box>
                    <Text color={c.lastStop === 'max_tokens' ? C.warn : statusColor(c)}>
                      {cardW >= 26 ? `${glyph(c)} ${c.lastStop === 'max_tokens' ? 'max_tokens' : c.status} ` : `${glyph(c)} `}
                    </Text>
                    <Box flexShrink={0}>{clock(`card-clock-${c.id}`, c.spawnedAt, c.endedAt, C.dim)}</Box>
                  </Box>
                </Box>
              )
            })}
          </Box>
          {native ? null : rail('merge', running.length > 0, C.agent, w, centers, true)}
        </Box>
      )
    }

    const expandedCard = cards.find(c => c.id === v.expanded)
    const expandedPanel = (w: number) =>
      expandedCard ? (
        <Box flexDirection="column" {...(native ? { marginTop: 1, paddingLeft: 2 } : { borderStyle: 'single', borderColor: C.agent, paddingX: 1 })} width={w}>
          <Text bold wrap="wrap">
            {expandedCard.description || expandedCard.type}
          </Text>
          <Text dimColor wrap="truncate">{`${expandedCard.type} · ${prettyModel(expandedCard.model)} · ${expandedCard.status} · ${expandedCard.steps} steps`}</Text>
          {expandedCard.tools.length === 0 ? <Text color={C.faint}>no tool calls yet</Text> : null}
          {expandedCard.tools.map(n => (
            <Text color={n.isError ? C.warn : C.text} wrap="truncate">
              {`${n.isError ? '✗' : '·'} ${n.text}`}
            </Text>
          ))}
          {expandedCard.answer ? (
            <Text dimColor wrap="wrap">
              {`» ${shorten(expandedCard.answer, 240)}`}
            </Text>
          ) : null}
        </Box>
      ) : null

    // ---- other loops (workflow agents, forks): ids that match no card
    const loopsPanel = (w: number) => {
      if (lp.length === 0) return null
      const active = lp.filter(l => isLoopActive(l, now)).length
      const dots = lp.slice(-Math.max(4, w - 38))
      return (
        <Box width={w}>
          <Text bold>other loops </Text>
          <Text dimColor>{`${lp.length} seen · ${active} active  `}</Text>
          {dots.map(l => (
            <Text color={isLoopActive(l, now) ? C.agent : l.isDone ? C.dim : C.faint}>{isLoopActive(l, now) ? '●' : l.isDone ? '✓' : '○'}</Text>
          ))}
        </Box>
      )
    }

    // ---- receipt: the turn now, or the last one
    const receiptPanel = (w: number) => {
      const isReview = t.isReviewing
      return (
        <Box flexDirection="column" {...frame(C.main, !m.isRunning && !isReview)} width={w}>
          {m.isRunning ? (
            <Box>
              <Text color={C.main} wrap="truncate">{`◐ back to ${modelName.toLowerCase()} · turn `}</Text>
              <Box flexShrink={0}>{clock('turn-clock', t.startedAt, null, C.main)}</Box>
              {w >= 60 ? <Text dimColor wrap="truncate">{` · ${plural(t.edits, 'edit')} · ${plural(t.errors, 'error')}`}</Text> : null}
            </Box>
          ) : r ? (
            <Text wrap="truncate">
              <Text color={r.reason === 'answer' ? C.gate : C.warn}>{r.reason === 'answer' ? '✓ ' : '✗ '}</Text>
              <Text>{`last turn ${fmtDuration(r.durationMs)} · ${plural(r.agents, 'agent')} · ${plural(r.edits, 'edit')} · ${plural(r.errors, 'error')}`}</Text>
              {r.costDelta !== null ? <Text color={val(C.main)}>{` · +${fmtUsd(r.costDelta)}`}</Text> : null}
            </Text>
          ) : (
            <Text color={C.faint}>no turn finished yet</Text>
          )}
          {isReview ? <Text color={C.arch}>{`${cfg.architectLabel.toLowerCase()} reviewing before done (inferred)`}</Text> : null}
        </Box>
      )
    }

    // ---- plan: Claude's own task list as an outline of the groups its tasks name
    // Open Jira subtasks Claude has not taken up yet are placeholders in the tree.
    const shownTasks = [...pl.tasks, ...jiraSkeleton(pl.jira, pl.tasks)]
    const tree = planTree(shownTasks, pl.groups ?? [])
    const current = planCurrent(pl.tasks)
    // A group opened by hand holds while the same task is in progress; a new one takes the focus back.
    const focusKey = current ? `task:${current.id}:${current.subject}` : `idle:${pl.tasks.filter(t => t.status === 'completed').length}`
    const handFocus = v.planFocus && v.planFocusAt === focusKey ? v.planFocus : null
    const outline = planOutline(tree, current, 12, { focus: handFocus, showDone: v.planDone === true })
    const history = pl.history ?? {}
    const isPlanShown = panels.includes('plan')
    const openBlockers = (t: PlanTask) =>
      t.status === 'pending' ? pl.tasks.filter(x => t.blockedBy.includes(x.id) && x.status !== 'completed') : []
    // Under the task in progress, its latest three agents that still have a card.
    const currentAgents = current ? current.agents.flatMap(id => cards.filter(c => c.id === id)).slice(-3) : []
    const planHead = 2 + (current ? 1 + currentAgents.length : 0)
    const planPanel = (w: number) => {
      const pct = tree.total > 0 ? (tree.done / tree.total) * 100 : 0
      const bar = gauge(pct, Math.max(8, Math.min(30, w - 12)))
      return (
        <Box flexDirection="column" {...frame(C.gate)} width={w}>
          <Box justifyContent="space-between">
            {title('PLAN', C.gate)}
            <Text dimColor>{`${tree.done}/${tree.total} done`}</Text>
          </Box>
          <Text>
            <Text color={val(C.gate)}>{bar.on}</Text>
            <Text color={C.faint}>{bar.off}</Text>
            <Text bold>{` ${Math.round(pct)}%`}</Text>
          </Text>
          {current ? (
            <Box>
              <Box flexGrow={1} flexShrink={1}>
                {spin('plan-current', current.activeForm || current.subject, C.main)}
              </Box>
              {current.startedAt !== null ? <Text dimColor>{` ${fmtDuration(now - current.startedAt)}`}</Text> : null}
            </Box>
          ) : null}
          {currentAgents.map(c => (
            <Text key={`plan-agent-${c.id}`} wrap="truncate">
              <Text color={C.faint}>{'  └ '}</Text>
              <Text color={statusColor(c)}>{`${glyph(c)} `}</Text>
              <Text>{cardTitle(c)}</Text>
              <Text dimColor>{` · ${c.type}`}</Text>
            </Text>
          ))}
          {outline.length > 0 ? <Text> </Text> : null}
          {outline.map(l => {
            const pad = '  '.repeat(l.depth)
            const key = `plan-${l.kind}-${l.task?.id ?? l.text}-${l.depth}`
            if (l.kind === 'group') {
              const isDone = l.done === l.total
              return (
                <Box key={key}>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text wrap="truncate" dimColor={isDone}>
                      {pad}
                      {isDone ? <Text color={C.gate}>✓ </Text> : null}
                      {l.text}
                    </Text>
                  </Box>
                  <Text dimColor>{` ${l.done}/${l.total}`}</Text>
                </Box>
              )
            }
            if (l.kind === 'task' && l.task) {
              const tk = l.task
              const isNow = tk.status === 'in_progress'
              const blockers = openBlockers(tk)
              return (
                <Box key={key}>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text wrap="truncate">
                      <Text color={isNow ? C.main : C.faint}>{`${pad}${isNow ? '▶' : '·'} `}</Text>
                      <Text bold={isNow} dimColor={!isNow}>
                        {tk.subject}
                      </Text>
                    </Text>
                  </Box>
                  {blockers.length > 0 ? <Text color={C.amber} dimColor wrap="truncate">{` after ${shorten(blockers[0]?.subject ?? '', 18)}`}</Text> : null}
                </Box>
              )
            }
            return (
              <Text key={key} dimColor>
                {`${pad}${l.text}`}
              </Text>
            )
          })}
        </Box>
      )
    }

    // ---- log: whatever rows the other panels leave, 4 to 8
    // The main box's speed line and the gap above the log are a row each.
    const used = (isPlanShown ? (native ? 1 : 2) + planHead + (outline.length > 0 ? 1 + outline.length : 0) : 0) + 2 + 5 + (m.speed ? 1 : 0) + 1 + (showArchitect ? 6 : 0) + 6 + (v.gateOpen ? 5 : 0) + (cards.length > cfg.maxCards ? 3 + Math.min(6, cards.length) : 8) + (expandedCard ? 8 : 0) + (lp.length ? 1 : 0) + 3
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 40
    const nLog = logRows(bodyRows, used)
    const shownLines = (viewed ? lines.filter(l => l.agentId === viewed) : lines).slice(-nLog)
    const colorOf = (l: LogLine) =>
      native ? (l.kind === 'error' ? C.warn : C.text) : l.kind === 'error' ? C.warn : l.kind === 'consult' ? C.arch : l.who === 'main' ? C.main : l.who === 'gate' ? C.gate : l.who === 'you' ? C.text : C.agent
    const logPanel = (w: number) => (
      <Box flexDirection="column" {...frame(C.faint)} marginTop={1} width={w}>
        {native ? title(viewed ? 'session log · this agent' : 'session log', C.main) : <Text dimColor>{viewed ? 'session log · this agent' : 'session log'}</Text>}
        {shownLines.length === 0 ? <Text color={C.faint}>nothing yet</Text> : null}
        {shownLines.map(l => (
          <Box>
            <Box width={9} flexShrink={0}>
              <Text color={C.faint}>{fmtClock(l.at)}</Text>
            </Box>
            <Box width={13} flexShrink={0}>
              <Text color={colorOf(l)} bold wrap="truncate">
                {l.who}
              </Text>
            </Box>
            <Text color={l.kind === 'error' ? C.warn : C.text} wrap="truncate">
              {l.text}
            </Text>
          </Box>
        ))}
      </Box>
    )

    const draw = (p: Panel, w: number) =>
      p === 'main'
        ? mainPanel(w)
        : p === 'plan'
          ? planPanel(w)
        : p === 'architect'
          ? architectPanel(w)
          : p === 'gate'
            ? gatePanel(w)
            : p === 'agents'
              ? agentsPanel(w)
              : p === 'loops'
                ? loopsPanel(w)
                : p === 'receipt'
                  ? receiptPanel(w)
                  : logPanel(w)

    // Panels with the flow between them; the agents panel draws its own rails.
    const column = (ps: Panel[], w: number) => (
      <Box flexDirection="column" width={w}>
        {ps.map((p, i) => {
          const prev = ps[i - 1]
          const link =
            native || i === 0 || p === 'plan' || prev === 'plan' || p === 'agents' || prev === 'agents' || p === 'log' || p === 'loops' || prev === 'loops'
              ? null
              : rail(`link-${p}`, p === 'architect' ? advising : m.isRunning, p === 'architect' ? C.arch : C.main, w)
          return (
            <Box flexDirection="column">
              {link}
              {draw(p, w)}
              {p === 'agents' ? expandedPanel(w) : null}
            </Box>
          )
        })}
      </Box>
    )

    // Desktop draws the agents' time axis as SVG under the panels.
    const svgLanes =
      e.surface !== 'terminal' && cards.length > 0
        ? (() => {
            const { Svg } = $.ui.resolve(e)
            const rowH = 18
            const pxW = 520
            const geo = lanes(cards.slice(-10), now, 100)
            const rects = cards
              .slice(-10)
              .map((c, i) => {
                const gm = geo[i]
                const x = 150 + ((gm?.before ?? 0) / 100) * (pxW - 160)
                const wpx = Math.max(3, ((gm?.bar ?? 1) / 100) * (pxW - 160))
                const fill = c.status === 'running' ? SVG_COLORS.running : c.status === 'done' ? SVG_COLORS.done : c.status === 'failed' ? SVG_COLORS.failed : SVG_COLORS.other
                const label = shorten(cardTitle(c), 22).replace(/[<&>]/g, '')
                return `<text x="4" y="${i * rowH + 13}" font-size="11" fill="${SVG_COLORS.label}">${label}</text><rect x="${x}" y="${i * rowH + 4}" width="${wpx}" height="10" rx="3" fill="${fill}"/>`
              })
              .join('')
            const svgH = Math.min(10, cards.length) * rowH + 4
            return (
              <Svg
                source={`<svg xmlns="http://www.w3.org/2000/svg" width="${pxW}" height="${svgH}" viewBox="0 0 ${pxW} ${svgH}">${rects}</svg>`}
                alt={`${cards.length} agents on a time axis`}
                width={pxW}
                height={svgH}
              />
            )
          })()
        : null

    // Inline above the prompt (the terminal's main screen), the pane is a summary of at most 8 rows.
    const isMini = layout === 'mini' || (layout === 'auto' && e.props.placement === 'inline')
    if (isMini) {
      const live = [...cards.filter(c => c.status === 'running'), ...cards.filter(c => c.status !== 'running').reverse()].slice(0, 3)
      const counts = ` ${s.rule} allowed · ${s.cleared} ${decider}${s.ask > 0 ? ` · ${s.ask} pending` : ''} · ${s.deny} denied`
      const strip = g.recent.slice(-Math.max(4, W - cfg.gateLabel.length - 1 - counts.length))
      const mg = u.pct !== null ? gauge(u.pct, 6) : null
      return (
        <Box flexDirection="column" width={W} {...fill}>
          <Text wrap="truncate">
            <Text color={C.main} bold>
              {modelName}
            </Text>
            <Text color={m.isRunning ? C.main : C.dim}>{m.isRunning ? ' ● working' : ' ○ idle'}</Text>
            {mg ? <Text dimColor> · ctx </Text> : null}
            {mg ? <Text color={(u.pct ?? 0) >= 80 ? C.warn : val(C.main)}>{mg.on}</Text> : null}
            {mg ? <Text color={C.faint}>{mg.off}</Text> : null}
            {mg ? <Text>{` ${Math.round(u.pct ?? 0)}%`}</Text> : null}
            {u.compactions > 0 ? <Text color={C.amber}>{` ⟲${u.compactions}`}</Text> : null}
            {u.costUsd !== null ? <Text dimColor>{` · ${fmtUsd(u.costUsd)}`}</Text> : null}
            {showArchitect ? <Text color={val(C.arch)}>{` · ${cfg.architectLabel.toLowerCase()} ${advising ? 'advising' : a.consults.length}`}</Text> : null}
          </Text>
          {tree.total > 0 ? (
            <Text wrap="truncate">
              <Text dimColor>plan </Text>
              <Text color={val(C.gate)}>{gauge((tree.done / tree.total) * 100, 8).on}</Text>
              <Text color={C.faint}>{gauge((tree.done / tree.total) * 100, 8).off}</Text>
              <Text>{` ${tree.done}/${tree.total}`}</Text>
              {current ? <Text color={C.main}>{` · ▶ ${current.activeForm || current.subject}`}</Text> : null}
            </Text>
          ) : null}
          {strip.length > 0 ? (
            <Box>
              <Text dimColor>{`${cfg.gateLabel.toLowerCase()} `}</Text>
              {strip.map(c => (
                <Text color={verdictColor(c)} dimColor={c.inSubagent}>
                  {c.verdict === 'deny' ? '✗' : '■'}
                </Text>
              ))}
              <Text color={s.deny > 0 ? C.warn : s.ask > 0 ? C.amber : C.dim} wrap="truncate">
                {counts}
              </Text>
            </Box>
          ) : null}
          {live.map(c => (
            <Box>
              <Text color={statusColor(c)}>{`${glyph(c)} `}</Text>
              <Box width={Math.max(10, W - 30)}>
                <Text wrap="truncate">{cardTitle(c)}</Text>
              </Box>
              <Text dimColor>{c.steps > 0 ? ` ctx ${kTokens(c.ctx)} ` : ' '}</Text>
              {clock(`mini-clock-${c.id}`, c.spawnedAt, c.endedAt, C.dim)}
            </Box>
          ))}
          {cards.length > live.length ? (
            <Text color={C.faint} wrap="truncate">{`+${cards.length - live.length} more agents · /os-deck layout compact for all`}</Text>
          ) : null}
          {lp.length > 0 ? <Text dimColor>{`other loops ${lp.length} · ${lp.filter(l => isLoopActive(l, now)).length} active`}</Text> : null}
          {!m.isRunning && r ? (
            <Text dimColor wrap="truncate">
              {`last turn ${fmtDuration(r.durationMs)} · ${plural(r.agents, 'agent')} · ${plural(r.edits, 'edit')} · ${plural(r.errors, 'error')}${r.costDelta !== null ? ` · +${fmtUsd(r.costDelta)}` : ''}`}
            </Text>
          ) : null}
        </Box>
      )
    }

    // ---- the plan view: a header, the plan with its subagents nested, the log at the foot
    if (cfg.view === 'plan') {
      const inner = native ? W : W - 4
      const rowsOut: { key: string; node: unknown }[] = []
      const push = (key: string, node: unknown) => rowsOut.push({ key, node })
      // Which task each subagent was spawned under; the rest are outside the plan.
      const taskOf = new Map<string, string>()
      for (const tk of pl.tasks) for (const id of tk.agents) taskOf.set(id, tk.id)
      let hot = 0
      // The rows the plan may take: what the title, the header, both frames and a short log leave.
      const gateOpenRows = v.gateOpen ? g.recent.filter(c => c.bucket === v.gateOpen).slice(-5) : []
      const showReceipt = !m.isRunning && r !== null
      const frameRows = native ? 1 : 2
      // A section is drawn when the panels option keeps it and the person has not hidden it.
      const hidden = hiddenOf(v.hidden)
      const shows = (s: DeckSection): boolean => !hidden.includes(s) && (s === 'pet' ? cfg.pet && shows('header') : s === 'header' ? cfg.panels.includes('main') : s === 'github' ? cfg.github : s === 'title' || cfg.panels.includes(s as Panel))
      // The header names the architect only while its own section is not drawn.
      const archInHeader = showArchitect && !(shows('architect') && a.consults.length > 0)
      // The pet sits beside the summary where the pane is wide enough, and on top of it, as the
      // header's first rows, in a narrow (vertical) pane; a short pane goes without (the mini layout never gets here).
      const petOn = shows('pet') && inner >= PET_COLUMNS && bodyRows >= PET_MIN_ROWS
      const petSide = petOn && inner >= PET_MIN_INNER
      petSeen = { isOn: petOn, inner, bodyRows, isShown: shows('pet') }
      const textW = inner - (petSide ? PET_COLUMNS + 1 : 0)
      // The pet wanted but left out for room: one dim line says what it needs, so it is not a mystery.
      const petCramped = shows('pet') && !petOn
      // The pet's detail, opened from its caption: the main loop's tool, then the agents (running first), each opening its card.
      const petAgents = [...cards.filter(c => c.status === 'running'), ...cards.filter(c => c.status !== 'running').reverse()].slice(0, 4)
      const petDetailRows = petOn && v.petOpen ? 1 + petAgents.length : 0
      const textRows = petDetailRows + 3 + (u.limits.length > 0 ? 1 : 0) + (acc.status === 'ok' && acc.active ? 1 : 0) + (petOn || petCramped ? 1 : 0) + (archInHeader ? 1 : 0) + (showReceipt ? 1 : 0)
      const headerRows = frameRows + (petSide ? Math.max(PET_ROWS, textRows) : petOn ? PET_ROWS + textRows : textRows) + accountRows.length + gateOpenRows.length
      // Each repository one row, under a title; a clean trunk with nothing to say still shows where it stands.
      // The pane's frame already names it: the title row only counts tasks and agents, and goes when there are none.
      const titleRows = shows('title') && (tree.total > 0 || cards.length > 0) ? 1 : 0
      const repos = shows('git') ? gt.repos.slice(0, 4) : []
      const gitRows = repos.length > 0 ? frameRows + 1 + repos.length : 0
      // GitHub: the branch's pull request (and the issues it closes), or up to three open ones; nothing to say, no section.
      const ghShown = shows('github') && ghs.status === 'ok' && (ghs.pr !== null || ghs.open.length > 0)
      const ghBody = !ghShown ? 0 : ghs.pr ? 1 + (ghs.pr.closes.length > 0 ? 1 : 0) : Math.min(3, ghs.open.length)
      const ghRows = ghShown ? frameRows + 1 + ghBody : 0
      // The epic: its head and up to six children, the anchored issue first.
      const ev = shows('epic') ? epicView(pl.jira, pl.epic) : null
      const epicKids = ev ? ev.rows.slice(0, 6) : []
      const epicRows = ev ? frameRows + 1 + epicKids.length + (ev.rows.length > epicKids.length ? 1 : 0) : 0
      // The timeline: tasks and agents on one axis, the latest six by start.
      const tlItems: TimelineItem[] = shows('timeline')
        ? [
            ...pl.tasks
              .filter(tk => tk.startedAt !== null && tk.source !== 'jira')
              .map(tk => ({
                id: `t-${tk.id}`,
                label: tk.subject,
                kind: 'task' as const,
                start: tk.startedAt ?? 0,
                end: tk.status === 'in_progress' ? null : (tk.doneAt ?? tk.startedAt),
              })),
            ...cards.map(c => ({ id: `a-${c.id}`, label: cardTitle(c), kind: 'agent' as const, start: c.spawnedAt, end: c.status === 'running' ? null : (c.endedAt ?? c.spawnedAt), isFailed: c.status === 'failed' })),
            ...a.consults.map(c => ({ id: `c-${c.id}`, label: c.about || cfg.architectLabel.toLowerCase(), kind: 'architect' as const, start: c.at, end: c.endAt })),
          ]
        : []
      const tlLabelW = Math.min(18, Math.max(8, Math.floor(inner * 0.3)))
      const tlW = Math.max(4, inner - tlLabelW - 1 - 7)
      const tl = tlItems.length >= 2 ? timelineRows(tlItems, now, tlW, 6) : { t0: now, rows: [] }
      const timelineRowsN = tl.rows.length > 0 ? frameRows + 1 + tl.rows.length + 1 : 0
      // The architect: its latest three consults, and the newest advice under them in two lines at most.
      const archConsults = shows('architect') ? a.consults.slice(-3) : []
      // While a consult runs its answer is not in yet: no older advice stands in for it.
      const newestAdvice = advising ? '' : ([...archConsults].reverse().find(c => c.advice)?.advice ?? '')
      const adviceLines = archConsults.length > 0 && newestAdvice ? titleLines(`» ${newestAdvice}`, inner, inner - 2).filter(x => x.length > 0) : []
      // Kept on call while shown, even before the first consult: one dim line stands in for them.
      const archRows = shows('architect') ? frameRows + 1 + Math.max(1, archConsults.length) + adviceLines.length : 0
      // The agents: the session's subagents by type, four types at most.
      const kinds = shows('agents') ? agentKinds(cards, now) : []
      const kindsShown = kinds.slice(0, 4)
      const agentsRows = kinds.length > 0 ? frameRows + 1 + kindsShown.length + (kinds.length > kindsShown.length ? 1 : 0) : 0
      // The log keeps a quarter of the pane, six rows at least; the plan takes the rest.
      const headerShown = shows('header') ? headerRows : 0
      const logReserve = shows('log') ? frameRows + 1 + Math.max(6, Math.round(bodyRows / 4)) : 0
      const planRoom = bodyRows - titleRows - headerShown - gitRows - ghRows - epicRows - archRows - agentsRows - timelineRowsN - (frameRows + 1) - logReserve
      // Rows the outline does not count: the issue, the bar, agents under open tasks, an opened agent, work outside the plan.
      const looseCount = cards.filter(c => !taskOf.has(c.id)).length
      const extras =
        (pl.jira ? 1 : 0) +
        (tree.total > 0 ? 1 : 0) +
        pl.tasks.filter(tk => tk.status !== 'completed').reduce((n, tk) => n + Math.min(4, cards.filter(c => taskOf.get(c.id) === tk.id).length), 0) +
        (v.expanded ? 7 : 0) +
        cards.filter(c => c.status === 'running' && c.tools.length > 0).length +
        (looseCount > 0 || advising ? 1 + Math.min(4, looseCount) + (advising ? 1 : 0) + (looseCount > 4 ? 1 : 0) : 0)
      const deckOutline = planOutline(tree, current, Math.max(4, planRoom - extras), { focus: handFocus, showDone: v.planDone === true })
      // A subagent's row: one line, one control. The title gets what the tree, the hotkey, the
      // type and the clock leave, so nothing wraps.
      const shortType = (t: string) => shorten(t.replace(/-purpose$/, '').split(':').pop() ?? t, 10)
      // Its kind: the agent type, the model family and how many requests it has made.
      const family = (model: string) => prettyModel(model).split(' ')[0]?.toLowerCase() ?? ''
      const agentRow = (c: AgentCard, pad: string, isLast: boolean) => {
        hot += 1
        const hasKey = hot <= 9
        const isViewed = viewed === c.id || v.expanded === c.id
        const fam = c.model ? family(c.model) : ''
        const type = `${shortType(c.type)}${fam && fam !== '—' ? ` · ${fam}` : ''}${c.steps > 0 ? ` · ${c.steps}↻` : ''}`
        const room = Math.max(8, inner - pad.length - 2 - 2 - 2 - (hasKey ? 3 : 0) - (type.length + 2) - 7)
        const label = shorten(cardTitle(c), room)
        const body = (
          <Text wrap="truncate" bold={isViewed} dimColor={!isViewed && c.status !== 'running'}>
            {label}
            <Text dimColor>{`  ${type}`}</Text>
          </Text>
        )
        return (
          <Box key={`deck-agent-${c.id}`}>
            <Text color={C.faint}>{`${pad}${isLast ? '└' : '├'} `}</Text>
            <Text color={PET_FRIEND_HEX[Math.max(0, cards.indexOf(c)) % PET_FRIEND_HEX.length]}>■ </Text>
            {c.status === 'running' ? spin(`deck-spin-${c.id}`, '', statusColor(c)) : <Text color={statusColor(c)}>{`${glyph(c)} `}</Text>}
            <Box flexGrow={1} flexShrink={1}>
              {hasKey ? (
                <Button key={`card-${c.id}`} plain hotkey={String(hot)} onPress={expandOnPress(c.id)}>
                  {label}
                  <Text dimColor>{`  ${type}`}</Text>
                </Button>
              ) : (
                body
              )}
            </Box>
            <Box flexShrink={0}>
              <Text> </Text>
              {clock(`deck-clock-${c.id}`, c.spawnedAt, c.endedAt, C.dim)}
            </Box>
          </Box>
        )
      }
      // A subagent's row, and under it, when its hotkey opened it, its latest tool calls and its answer.
      const pushAgent = (c: AgentCard, pad: string, isLast: boolean) => {
        push(`deck-a-${c.id}`, agentRow(c, pad, isLast))
        const sub = `${pad}${isLast ? ' ' : '│'}   `
        // A running agent shows what it is doing now, under its row.
        if (v.expanded !== c.id) {
          const last = c.tools[c.tools.length - 1]
          if (c.status === 'running' && last)
            push(`deck-an-${c.id}`, <Text color={last.isError ? C.warn : C.faint} wrap="truncate">{`${sub}↳ ${last.text}`}</Text>)
          return
        }
        if (c.description && c.description !== cardTitle(c)) push(`deck-ad-${c.id}`, <Text dimColor wrap="truncate">{`${sub}${c.description}`}</Text>)
        if (c.tools.length === 0) push(`deck-at-${c.id}`, <Text color={C.faint}>{`${sub}no tool calls yet`}</Text>)
        c.tools.slice(-4).forEach((n, i) =>
          push(`deck-at-${c.id}-${i}`, (
            <Text color={n.isError ? C.warn : C.dim} wrap="truncate">
              {`${sub}${n.isError ? '✗' : '·'} ${n.text}`}
            </Text>
          )),
        )
        if (c.answer) push(`deck-aa-${c.id}`, <Text color={val(C.agent)} wrap="truncate">{`${sub}» ${c.answer.replace(/\s+/g, ' ')}`}</Text>)
      }
      // The anchored Jira issue: its key (a link where the site is known), type, status and assignee.
      const jira = pl.jira
      if (jira) {
        const link = jira.site ? `${jira.site}/browse/${jira.key}` : null
        const Link = 'Link' in els ? ((els as unknown as Record<string, unknown>).Link as typeof Box) : null
        push('deck-jira', (
          <Box>
            <Box flexShrink={0}>
              {link && Link ? (
                <Link {...({ href: link, label: jira.key } as Record<string, unknown>)} />
              ) : (
                <Text color={val(C.main)} bold>
                  {jira.key}
                </Text>
              )}
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate" dimColor>
                {` ${jira.type ? `${jira.type} · ` : ''}${jira.status}${jira.assignee ? ` · ${jira.assignee}` : ''}${jira.parent ? `  ↑ ${jira.parent.key}` : ''}`}
              </Text>
            </Box>
          </Box>
        ))
      }
      // Each group's estimate from the session's finished tasks; the whole plan's on the bar.
      const phases = phaseProgress(pl.tasks, now)
      const etaOf = new Map(phases.map(x => [x.group, x.etaMs]))
      const etaAll = planEta(phases)
      if (tree.total > 0) {
        const pct = (tree.done / tree.total) * 100
        const bar = gauge(pct, Math.max(8, Math.min(30, inner - 16)))
        push('deck-bar', (
          <Text>
            <Text color={val(C.gate)}>{bar.on}</Text>
            <Text color={C.faint}>{bar.off}</Text>
            <Text bold>{` ${Math.round(pct)}%`}</Text>
            <Text dimColor>{`  ${tree.done}/${tree.total} done`}</Text>
            {etaAll !== null ? <Text dimColor>{`  ~${fmtDuration(etaAll)} left`}</Text> : null}
          </Text>
        ))
      }
      for (const l of deckOutline) {
        const pad = '  '.repeat(l.depth)
        if (l.kind === 'group') {
          const isDone = l.done === l.total
          const pathKey = l.path.join(' / ')
          const node = nodeAt(tree, l.path)
          const isOpen = deckOutline.some(x => x.depth > l.depth && x.path.length > l.path.length && l.path.every((seg, i) => x.path[i] === seg))
          const spent = isOpen && node ? groupSpent(node, now) : 0
          const before = history[pathKey] ?? 0
          const eta = isDone ? null : (etaOf.get(pathKey) ?? null)
          const suffix = `${spent >= 60_000 ? ` ${fmtDuration(spent)}` : ''}${before > 0 ? ` +${before} earlier` : ''} ${l.done}/${l.total}${eta !== null ? ` ~${fmtDuration(eta)}` : ''}`
          // Tab onto a group and Enter opens it; Enter on the open one gives the focus back.
          const onPress = () =>
            update($, view, x => {
              const cur = normalize(DEFAULT_VIEW, x)
              const isSame = cur.planFocus?.join(' / ') === pathKey
              return { ...cur, planFocus: isSame ? null : l.path, planFocusAt: focusKey }
            })
          push(`deck-g-${pathKey}`, (
            <Box>
              <Text>{pad}</Text>
              {isDone ? <Text color={C.gate}>✓ </Text> : null}
              <Box flexGrow={1} flexShrink={1}>
                <Button key={`plan-group-${pathKey}`} plain dimColor={isDone} onPress={onPress}>
                  {shorten(l.text, Math.max(6, inner - pad.length - (isDone ? 2 : 0) - suffix.length))}
                </Button>
              </Box>
              {spent >= 60_000 ? <Text dimColor>{` ${fmtDuration(spent)}`}</Text> : null}
              {before > 0 ? <Text color={C.faint}>{` +${before} earlier`}</Text> : null}
              <Text dimColor>{` ${l.done}/${l.total}`}</Text>
            </Box>
          ))
        } else if (l.kind === 'task' && l.task) {
          const tk = l.task
          const isNow = tk.status === 'in_progress'
          const blockers = openBlockers(tk)
          push(`deck-t-${tk.id}`, (
            <Box>
              <Box flexGrow={1} flexShrink={1}>
                {isNow ? (
                  <Box>
                    <Text>{pad}</Text>
                    {spin(`deck-task-${tk.id}`, tk.activeForm || tk.subject, C.main)}
                  </Box>
                ) : tk.status === 'completed' ? (
                  <Text wrap="truncate" dimColor>
                    <Text color={C.gate}>{`${pad}✓ `}</Text>
                    {tk.subject}
                  </Text>
                ) : (
                  <Text wrap="truncate">
                    <Text color={C.faint}>{`${pad}· `}</Text>
                    <Text dimColor>{tk.subject}</Text>
                  </Text>
                )}
              </Box>
              {isNow && tk.startedAt !== null ? <Text dimColor>{` ${fmtDuration(now - tk.startedAt)}`}</Text> : null}
              {blockers.length > 0 ? <Text color={C.amber} dimColor wrap="truncate">{` after ${shorten(blockers[0]?.subject ?? '', 18)}`}</Text> : null}
            </Box>
          ))
          const mine = cards.filter(c => taskOf.get(c.id) === tk.id).slice(-4)
          mine.forEach((c, i) => pushAgent(c, `${pad}  `, i === mine.length - 1))
        } else {
          push(`deck-more-${l.depth}`, <Text dimColor>{`${pad}${l.text}`}</Text>)
        }
      }
      // Subagents no task claims, and the architect while it advises: work outside the plan.
      const loose = cards.filter(c => !taskOf.has(c.id))
      const looseShown = [...loose.filter(c => c.status === 'running'), ...loose.filter(c => c.status !== 'running').reverse()].slice(0, 4)
      if (looseShown.length > 0 || advising) {
        push('deck-outside', <Text dimColor>{tree.total > 0 ? 'outside the plan' : 'subagents'}</Text>)
        if (advising && lastConsult) {
          push('deck-arch', (
            <Box>
              <Text color={C.faint}>{`${looseShown.length > 0 ? '├' : '└'} `}</Text>
              {spin('deck-arch-spin', cfg.architectLabel.toLowerCase(), C.arch)}
              <Box flexGrow={1} />
              {clock('deck-arch-clock', lastConsult.at, null, C.dim)}
            </Box>
          ))
        }
        looseShown.forEach((c, i) => pushAgent(c, '', i === looseShown.length - 1))
        if (loose.length > looseShown.length) push('deck-earlier', <Text color={C.faint}>{`  +${loose.length - looseShown.length} earlier`}</Text>)
      }
      // What room is left shows the latest finished tasks, newest first, unless they are listed already.
      const listed = new Set(deckOutline.flatMap(l => (l.task ? [l.task.id] : [])))
      // Not while the outline is cut short: open work comes before finished work.
      const recent = v.planDone || deckOutline.some(l => l.kind === 'more')
        ? []
        : pl.tasks
            .filter(tk => tk.status === 'completed' && !listed.has(tk.id))
            .sort((x, y) => (y.doneAt ?? 0) - (x.doneAt ?? 0))
            .slice(0, Math.max(0, Math.min(6, planRoom - rowsOut.length - 1)))
      if (recent.length > 0) {
        push('deck-recent', <Text dimColor>recently done</Text>)
        recent.forEach(tk => {
          push(`deck-r-${tk.id}`, (
            <Box>
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="truncate" dimColor>
                  <Text color={C.gate}>✓ </Text>
                  {tk.group.length > 0 ? <Text color={C.faint}>{`${tk.group[tk.group.length - 1]} · `}</Text> : null}
                  {tk.subject}
                </Text>
              </Box>
            </Box>
          ))
        })
      }
      if (rowsOut.length === 0) push('deck-empty', <Text color={C.faint}>no tasks or subagents yet</Text>)

      // ---- git: one row a repository: name, branch, distance from its base, changed files
      const gitRow = (rp: GitRepo) => {
        const dirty = rp.staged + rp.modified + rp.untracked + rp.conflicts
        const base = rp.base ? rp.base.replace(/^origin\//, '') : null
        const nameW = Math.min(16, Math.max(...repos.map(x => x.name.length)))
        return (
          <Box key={`git-${rp.name}`}>
            <Box width={nameW + 1} flexShrink={0}>
              <Text dimColor={dirty === 0 && rp.ahead === 0} wrap="truncate">
                {rp.name}
              </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate">
                <Text color={isTrunk(rp.branch) ? C.dim : val(C.main)}>{rp.branch}</Text>
                {rp.ahead > 0 ? <Text color={val(C.gate)}>{` ⇡${rp.ahead}`}</Text> : null}
                {rp.behind > 0 ? <Text color={C.amber}>{` ⇣${rp.behind}`}</Text> : null}
                {base ? <Text color={C.faint}>{`  ${base}`}</Text> : null}
                {base && rp.baseAhead > 0 ? <Text dimColor>{` ↑${rp.baseAhead}`}</Text> : null}
                {base && rp.baseBehind > 0 ? <Text color={rp.baseBehind >= 20 ? C.amber : C.dim}>{` ↓${rp.baseBehind}`}</Text> : null}
              </Text>
            </Box>
            <Box flexShrink={0}>
              {rp.conflicts > 0 ? <Text color={C.warn}>{` !${rp.conflicts}`}</Text> : null}
              {rp.staged > 0 ? <Text color={C.gate}>{` +${rp.staged}`}</Text> : null}
              {rp.modified > 0 ? <Text color={C.amber}>{` ●${rp.modified}`}</Text> : null}
              {rp.untracked > 0 ? <Text dimColor>{` ?${rp.untracked}`}</Text> : null}
              {dirty === 0 ? <Text color={C.faint}> clean</Text> : null}
            </Box>
          </Box>
        )
      }

      // ---- header: everything about the session itself, compact. With the pet, the summary sits in
      // a column beside it, a gauge shorter and the limits without theirs.
      const hg = u.pct !== null ? gauge(u.pct, petSide ? 6 : 10) : null
      const petNode = !petOn ? null : motion ? (
        <els.Client key="pet" module="./pet.tsx" width={PET_COLUMNS} height={PET_ROWS} props={{ part: 'pet', input: petInput, colors: petColors, captionColor: C.dim }} />
      ) : (
        <Box flexDirection="column" height={PET_ROWS}>
          {petCells(petFrame(petNow.state, 0, friendsAt(petInput), isSweating(petInput)), petColors).map(runs => (
            <Text>
              {runs.map(x => (
                <Text color={x.fg ?? undefined} backgroundColor={x.bg ?? undefined} bold={x.bold}>
                  {x.text}
                </Text>
              ))}
            </Text>
          ))}
        </Box>
      )
      const summary = (
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          <Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate">
                <Text color={C.main} bold>
                  {modelName}
                </Text>
                <Text dimColor>{`${m.effort ? ` · ${m.effort}` : ''}${!petSide && m.mode ? ` · ${m.mode}` : ''}${petSide ? '' : ` · ${m.steps} req`}`}</Text>
              </Text>
            </Box>
            <Box flexShrink={0}>{m.isRunning ? spin('hdr-working', petSide ? '' : 'working', C.main) : <Text color={C.dim}>{petSide ? '○' : '○ idle'}</Text>}</Box>
          </Box>
          <Text wrap="truncate">
            <Text dimColor>ctx </Text>
            {hg ? <Text color={(u.pct ?? 0) >= 80 ? C.warn : val(C.main)}>{hg.on}</Text> : null}
            {hg ? <Text color={C.faint}>{hg.off}</Text> : null}
            <Text bold>{u.pct !== null ? ` ${Math.round(u.pct)}%` : ' —'}</Text>
            {u.tokens !== null && !petSide ? <Text dimColor>{` ${kTokens(u.tokens)}/${kTokens(u.window)}`}</Text> : null}
            {u.compactions > 0 ? <Text color={C.amber}>{` ⟲${u.compactions}`}</Text> : null}
            {ctxTurns !== null ? <Text color={ctxTurns <= 2 ? C.warn : C.dim}>{petSide ? ` ~${ctxTurns}t` : ` ${ctxLeft}`}</Text> : null}
            {u.costUsd !== null ? <Text>{`${petSide ? '  ' : '   '}${fmtUsd(u.costUsd)}`}</Text> : null}
          </Text>
          {u.limits.length > 0 ? (
            <Text wrap="truncate">
              {u.limits.slice(0, 2).map((l, i) => {
                const lg = gauge(l.pct, 5)
                const resetIn = (petSide ? textW >= 34 : inner >= 50) ? fmtResetIn(l.resetsAt, now) : ''
                return petSide ? (
                  <Text>
                    <Text dimColor>{`${i > 0 ? ' · ' : ''}${limTag}${limitLabel(l.kind)} `}</Text>
                    <Text color={l.pct >= 80 ? C.warn : val(C.main)}>{`${Math.round(l.pct)}%`}</Text>
                    <Text dimColor>{resetIn ? ` ↻${resetIn}` : ''}</Text>
                  </Text>
                ) : (
                  <Text>
                    <Text dimColor>{`${limTag}${limitLabel(l.kind)} `}</Text>
                    <Text color={l.pct >= 80 ? C.warn : val(C.main)}>{lg.on}</Text>
                    <Text color={C.faint}>{lg.off}</Text>
                    <Text dimColor>{` ${Math.round(l.pct)}%${resetIn ? ` ↻${resetIn}` : ''}   `}</Text>
                  </Text>
                )
              })}
            </Text>
          ) : null}
            {acc.status === 'ok' && acc.active ? (
              <Box>
                <Text dimColor>account </Text>
                <Box flexShrink={1}>
                  <Button
                    key="account"
                    plain
                    hotkey="a"
                    label={`${acc.active.email}${acc.active.number > 0 ? ` #${acc.active.number}` : ''} ${v.accountOpen ? '▴' : '▾'}`}
                    onPress={() => update($, view, x => ({ ...normalize(DEFAULT_VIEW, x), accountOpen: !normalize(DEFAULT_VIEW, x).accountOpen }))}
                  />
                </Box>
                {isHolding(acc, now) ? <Text color={C.amber}> switching…</Text> : null}
              </Box>
            ) : null}
            <Box columnGap={1}>
              <Text wrap="truncate">
                <Text dimColor>{`${cfg.gateLabel.toLowerCase()} `}</Text>
                <Text color={C.gate}>{`✓${s.rule} `}</Text>
                <Text color={C.cleared}>{`◇${s.cleared} `}</Text>
                {s.ask > 0 ? <Text color={C.amber}>{`…${s.ask} `}</Text> : null}
                <Text color={s.deny > 0 ? C.warn : C.dim}>{`✗${s.deny}`}</Text>
              </Text>
              <Box flexGrow={1} />
              {(['file', 'shell', 'other'] as const).map((b: Bucket) => {
                const tl = g.totals[b]
                const n = tl.rule + tl.ask + tl.cleared + tl.deny
                return (
                  <Button
                    key={`gate-${b}`}
                    plain
                    hotkey={b[0]}
                    label={`${n}${v.gateOpen === b ? '▾' : ''}`}
                    dimColor={v.gateOpen !== b && n === 0}
                    onPress={() => update($, view, x => ({ ...normalize(DEFAULT_VIEW, x), gateOpen: normalize(DEFAULT_VIEW, x).gateOpen === b ? null : b }))}
                  />
                )
              })}
            </Box>
          {petOn ? (
            <Box>
              <Box flexGrow={1} flexShrink={1}>
                {motion ? (
                  <els.Client key="pet-caption" module="./pet.tsx" height={1} props={{ part: 'caption', input: petInput, colors: petColors, captionColor: C.dim }} />
                ) : (
                  <Text color={C.dim} wrap="truncate">
                    {petNow.caption}
                  </Text>
                )}
              </Box>
              <Box flexShrink={0}>
                <Button
                  key="pet-open"
                  plain
                  hotkey="p"
                  label={v.petOpen ? '▴' : '▾'}
                  dimColor
                  onPress={() => update($, view, x => ({ ...normalize(DEFAULT_VIEW, x), petOpen: !normalize(DEFAULT_VIEW, x).petOpen }))}
                />
              </Box>
            </Box>
          ) : petCramped ? (
            <Text color={C.faint} wrap="truncate">{`pet hidden: pane ${inner}×${bodyRows}, needs ${PET_COLUMNS}×${PET_MIN_ROWS}`}</Text>
          ) : null}
            {petDetailRows > 0 ? (
              <Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text wrap="truncate" dimColor={mainTool === null || mainTool.endAt !== null}>
                    {mainTool ? `⏵ ${mainTool.text}` : '⏵ no tool yet'}
                  </Text>
                </Box>
                {mainTool ? <Box flexShrink={0}>{clock('pet-tool-clock', mainTool.at, mainTool.endAt, C.dim)}</Box> : null}
              </Box>
            ) : null}
            {petDetailRows > 0
              ? petAgents.map(c => (
                  <Box key={`pet-agent-${c.id}`}>
                    <Box flexGrow={1} flexShrink={1}>
                      <Button key={`pet-card-${c.id}`} plain onPress={expandOnPress(c.id)}>
                        <Text color={PET_FRIEND_HEX[Math.max(0, cards.indexOf(c)) % PET_FRIEND_HEX.length]}>■ </Text>
                        <Text color={statusColor(c)}>{`${glyph(c)} `}</Text>
                        {shorten(cardTitle(c), Math.max(8, textW - 12))}
                      </Button>
                    </Box>
                    <Box flexShrink={0}>{clock(`pet-agent-clock-${c.id}`, c.spawnedAt, c.endedAt, C.dim)}</Box>
                  </Box>
                ))
              : null}
            {archInHeader ? (
              <Text wrap="truncate">
                <Text color={val(C.arch)}>{`${cfg.architectLabel.toLowerCase()} ${advising ? 'advising' : `${a.consults.length}×`}`}</Text>
                {a.lastAdvice && !advising ? <Text dimColor>{`  » ${a.lastAdvice}`}</Text> : null}
              </Text>
            ) : null}
            {showReceipt && r ? (
              <Text dimColor wrap="truncate">
                <Text color={r.reason === 'answer' ? C.gate : C.warn}>{r.reason === 'answer' ? '✓ ' : '✗ '}</Text>
                {`last turn ${fmtDuration(r.durationMs)} · ${plural(r.edits, 'edit')} · ${plural(r.errors, 'error')}${r.costDelta !== null ? ` · +${fmtUsd(r.costDelta)}` : ''}`}
              </Text>
            ) : null}
        </Box>
      )
      const header = (
        <Box flexDirection="column" {...frame(C.main)} width={W}>
          {petSide ? (
            <Box columnGap={1}>
              <Box flexShrink={0} width={PET_COLUMNS}>
                {petNode}
              </Box>
              {summary}
            </Box>
          ) : petOn ? (
            <Box flexDirection="column">
              <Box flexShrink={0} width={PET_COLUMNS}>
                {petNode}
              </Box>
              {summary}
            </Box>
          ) : (
            summary
          )}
          {accountRows.map(x => {
            const lim = x.limits.map(l => `${limitLabel(l.kind)} ${Math.round(l.pct)}%`).join(' · ')
            return (
              <Box key={`acct-${x.number}`}>
                <Text color={x.isActive ? C.main : C.faint}>{x.isActive ? '  ● ' : '  ○ '}</Text>
                <Box flexShrink={1}>
                  {x.isActive ? (
                    <Text wrap="truncate">{`#${x.number} ${x.email}`}</Text>
                  ) : (
                    <Button key={`acct-pick-${x.number}`} plain label={`#${x.number} ${x.email}`} onPress={() => pickAccount($, cfg, x.number)} />
                  )}
                </Box>
                <Box flexGrow={1} />
                {lim ? <Text color={x.limits.some(l => l.pct >= 90) ? C.warn : C.dim}>{` ${lim}`}</Text> : null}
              </Box>
            )
          })}
          {gateOpenRows.map(c => (
            <Text wrap="truncate">
              <Text color={verdictColor(c)}>{c.verdict === 'deny' ? '✗ ' : '■ '}</Text>
              <Text color={C.dim}>{`${(c.verdict === 'rule' ? 'allowed' : c.verdict === 'cleared' ? decider : c.verdict === 'ask' ? 'pending' : 'denied').padEnd(10)} `}</Text>
              <Text dimColor={c.inSubagent}>{shorten(c.detail, Math.max(10, inner - 14))}</Text>
            </Text>
          ))}
        </Box>
      )
      const deckRows = shows('plan') ? frameRows + 1 + rowsOut.length : 0
      const logLines = Math.max(3, bodyRows - titleRows - headerShown - gitRows - ghRows - epicRows - archRows - agentsRows - timelineRowsN - deckRows - frameRows - 1)
      const tail = (viewed ? lines.filter(l => l.agentId === viewed) : lines).slice(-logLines)
      return (
        <Box flexDirection="column" width={W} minHeight={bodyRows} {...fill}>
          {titleRows > 0 ? (
          <Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate" dimColor>
                {tree.total > 0 ? `${tree.done}/${tree.total} tasks` : ''}
              </Text>
            </Box>
            {cards.length > 0 ? (
              <Box flexShrink={0}>
                <Text dimColor>{`${running.length}/${cards.length} agents`}</Text>
              </Box>
            ) : null}
          </Box>
          ) : null}
          {shows('header') ? header : null}
          {repos.length > 0 ? (
            <Box flexDirection="column" {...frame(C.main, true)} width={W}>
              {native ? title('git', C.main) : <Text dimColor>git</Text>}
              {repos.map(rp => gitRow(rp))}
            </Box>
          ) : null}
          {ghShown ? (
            <Box flexDirection="column" {...frame(C.main, true)} width={W}>
              {native ? title('github', C.main) : <Text dimColor>github</Text>}
              {ghs.pr
                ? (() => {
                    const pr = ghs.pr
                    const ck = checksLine(pr.checks)
                    const stateText = pr.state === 'open' ? (pr.isDraft ? 'draft' : 'open') : pr.state
                    const stateColor = pr.state === 'merged' ? C.arch : pr.state === 'closed' || pr.isDraft ? C.dim : C.gate
                    const review = pr.review === 'approved' ? ['✓ approved', C.gate] : pr.review === 'changes' ? ['✗ changes', C.warn] : pr.review === 'required' ? ['… review', C.amber] : null
                    return [
                      <Box key="gh-pr">
                        <Box flexGrow={1} flexShrink={1}>
                          <Text wrap="truncate">
                            <Text bold>{`#${pr.number} `}</Text>
                            <Text>{pr.title}</Text>
                          </Text>
                        </Box>
                        <Box flexShrink={0}>
                          <Text color={stateColor}>{` ${stateText}`}</Text>
                          <Text color={ck.worst === 'failed' ? C.warn : ck.worst === 'pending' ? C.amber : ck.worst === 'passed' ? C.gate : C.faint}>{` ${ck.text}`}</Text>
                          {review ? <Text color={review[1]}>{` ${review[0]}`}</Text> : null}
                        </Box>
                      </Box>,
                      pr.closes.length > 0 ? (
                        <Text key="gh-closes" dimColor wrap="truncate">{`  closes ${pr.closes.map(n => `#${n}`).join(' ')}${pr.branch ? ` · ${pr.branch}` : ''}`}</Text>
                      ) : null,
                    ]
                  })()
                : ghs.open.slice(0, 3).map(o => (
                    <Box key={`gh-open-${o.number}`}>
                      <Box flexGrow={1} flexShrink={1}>
                        <Text wrap="truncate">
                          <Text dimColor>{`#${o.number} `}</Text>
                          {o.title}
                        </Text>
                      </Box>
                      <Box flexShrink={0}>
                        <Text dimColor>{` ${o.isDraft ? 'draft · ' : ''}${shorten(o.branch, 18)}`}</Text>
                      </Box>
                    </Box>
                  ))}
            </Box>
          ) : null}
          {ev ? (
            <Box flexDirection="column" {...frame(C.arch, true)} width={W}>
              <Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text wrap="truncate">
                    {native ? <Text color={C.main}>● </Text> : null}
                    <Text bold>{ev.head.key}</Text>
                    <Text dimColor>{` ${ev.head.type ? `${ev.head.type} · ` : ''}${ev.head.summary}`}</Text>
                  </Text>
                </Box>
                <Box flexShrink={0}>
                  {ev.total > 0 ? <Text color={val(C.gate)}>{gauge((ev.done / ev.total) * 100, 6).on}</Text> : null}
                  {ev.total > 0 ? <Text color={C.faint}>{gauge((ev.done / ev.total) * 100, 6).off}</Text> : null}
                  <Text dimColor>{` ${ev.done}/${ev.total}`}</Text>
                  {!ev.isRead ? <Text color={C.faint}> · /os-deck epic</Text> : null}
                </Box>
              </Box>
              {epicKids.map(c => (
                <Box key={`epic-${c.key}`}>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text wrap="truncate" dimColor={c.isDone}>
                      <Text color={c.isDone ? C.gate : c.isAnchor ? C.main : C.faint}>{c.isDone ? '✓ ' : c.isAnchor ? '◆ ' : '· '}</Text>
                      <Text dimColor>{`${c.key} `}</Text>
                      <Text bold={c.isAnchor}>{c.summary}</Text>
                    </Text>
                  </Box>
                  <Box flexShrink={0}>
                    <Text dimColor>{` ${shorten(c.status, 14)}${c.assignee ? ` · ${shorten(c.assignee.split(' ')[0] ?? '', 10)}` : ''}`}</Text>
                  </Box>
                </Box>
              ))}
              {ev.rows.length > epicKids.length ? <Text color={C.faint}>{`+${ev.rows.length - epicKids.length} more`}</Text> : null}
            </Box>
          ) : null}
          {shows('plan') ? (
          <Box flexDirection="column" {...frame(C.gate)} width={W}>
            <Box justifyContent="space-between">
              {title('PLAN', C.gate)}
              <Box columnGap={2}>
                {tree.done > 0 ? (
                  <Button
                    key="plan-done"
                    plain
                    hotkey="d"
                    label={v.planDone ? 'hide done' : 'done'}
                    dimColor
                    onPress={() => update($, view, x => ({ ...normalize(DEFAULT_VIEW, x), planDone: !normalize(DEFAULT_VIEW, x).planDone }))}
                  />
                ) : null}
              </Box>
            </Box>
            {rowsOut.map(x => (
              <Box key={x.key}>{x.node as never}</Box>
            ))}
          </Box>
          ) : null}
          {archRows > 0 ? (
            <Box flexDirection="column" {...frame(C.arch, !advising)} width={W}>
              <Box>
                <Box flexGrow={1} flexShrink={1}>
                  {advising ? spin('deck-arch-head', `${cfg.architectLabel.toLowerCase()} · advising`, C.arch) : title(`${cfg.architectLabel} · on call`, C.arch)}
                </Box>
                <Box flexShrink={0}>
                  <Text dimColor>{plural(a.consults.length, 'consult')}</Text>
                </Box>
              </Box>
              {archConsults.length === 0 ? (
                <Text dimColor wrap="truncate">{`no consults yet · waits for an ${cfg.architect.source} agent`}</Text>
              ) : null}
              {archConsults.map(c => (
                <Box key={`arch-${c.id}`}>
                  <Box flexShrink={0}>
                    <Text color={c.endAt === null ? C.arch : C.faint}>{c.endAt === null ? '◐ ' : '◆ '}</Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text wrap="truncate">
                      <Text color={val(C.arch)}>{cfg.moments ? c.moment : c.via}</Text>
                      {c.about ? <Text dimColor>{` · ${c.about}`}</Text> : null}
                    </Text>
                  </Box>
                  <Box flexShrink={0}>
                    <Text dimColor>{` ${fmtDuration(Math.max(0, (c.endAt ?? now) - c.at))}  ${fmtClock(c.at).slice(0, 5)}`}</Text>
                  </Box>
                </Box>
              ))}
              {adviceLines.map((line, i) => (
                <Text key={`arch-advice-${i}`} color={val(C.arch)} wrap="truncate">
                  {i === 0 ? line : `  ${line}`}
                </Text>
              ))}
            </Box>
          ) : null}
          {agentsRows > 0 ? (
            <Box flexDirection="column" {...frame(C.agent, true)} width={W}>
              <Box>
                <Box flexGrow={1} flexShrink={1}>
                  {title('agents', C.agent)}
                </Box>
                <Box flexShrink={0}>
                  <Text dimColor>
                    {`${running.length} running · ${cards.filter(c => c.status === 'done').length} done${cards.some(c => c.status === 'failed') ? ` · ${cards.filter(c => c.status === 'failed').length} failed` : ''}`}
                  </Text>
                </Box>
              </Box>
              {kindsShown.map(k => (
                <Box key={`kind-${k.type}`}>
                  <Box width={14} flexShrink={0}>
                    <Text wrap="truncate">{shortType(k.type)}</Text>
                  </Box>
                  <Box width={9} flexShrink={0}>
                    <Text color={val(C.agent)}>{'▰'.repeat(Math.min(5, k.total))}</Text>
                    <Text dimColor>{` ${k.total}`}</Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text dimColor wrap="truncate">
                      {`${k.models.map(family).filter(x => x && x !== '—').join('/')}${k.avgMs !== null ? ` · avg ${fmtDuration(k.avgMs)}` : ''}`}
                    </Text>
                  </Box>
                  <Box flexShrink={0}>
                    {k.running > 0 ? <Text color={C.main}>{` ${k.running} running`}</Text> : null}
                    {k.failed > 0 ? <Text color={C.warn}>{` ${k.failed} failed`}</Text> : null}
                  </Box>
                </Box>
              ))}
              {kinds.length > kindsShown.length ? <Text color={C.faint}>{`+${kinds.length - kindsShown.length} more types`}</Text> : null}
            </Box>
          ) : null}
          {tl.rows.length > 0 ? (
            <Box flexDirection="column" {...frame(C.faint, true)} width={W}>
              {native ? title('timeline', C.main) : <Text dimColor>timeline</Text>}
              {tl.rows.map(rw => (
                <Box key={`tl-${rw.id}`}>
                  <Box width={tlLabelW + 1} flexShrink={0}>
                    <Text wrap="truncate" dimColor={rw.end !== null}>
                      {rw.kind === 'agent' ? <Text color={C.faint}>↳ </Text> : rw.kind === 'architect' ? <Text color={C.arch}>◆ </Text> : null}
                      {shorten(rw.label, rw.kind === 'task' ? tlLabelW : tlLabelW - 2)}
                    </Text>
                  </Box>
                  <Text color={C.faint}>{'·'.repeat(rw.pre)}</Text>
                  <Text color={rw.isFailed ? C.warn : rw.kind === 'architect' ? C.arch : rw.kind === 'agent' ? C.agent : C.main} dimColor={rw.end !== null}>
                    {(rw.kind === 'agent' ? '═' : '━').repeat(rw.bar)}
                  </Text>
                  <Text color={C.faint}>{'·'.repeat(rw.post)}</Text>
                  <Box width={7} flexShrink={0} justifyContent="flex-end">
                    <Text dimColor>{fmtDuration(Math.max(0, (rw.end ?? now) - rw.start))}</Text>
                  </Box>
                </Box>
              ))}
              <Text color={C.faint} wrap="truncate">
                {`${' '.repeat(tlLabelW + 1)}${fmtClock(tl.t0).slice(0, 5)}${'─'.repeat(Math.max(1, tlW - 8))}now`}
              </Text>
            </Box>
          ) : null}
          <Box flexGrow={1} />
          {shows('log') ? (
          <Box flexDirection="column" {...frame(C.faint, true)} width={W}>
            <Text dimColor>{viewed ? 'session log · this agent' : 'session log'}</Text>
            {tail.length === 0 ? <Text color={C.faint}>nothing yet</Text> : null}
            {tail.map(l => (
              <Box>
                <Box width={6} flexShrink={0}>
                  <Text color={C.faint}>{fmtClock(l.at).slice(0, 5)}</Text>
                </Box>
                <Box width={10} flexShrink={0}>
                  <Text color={colorOf(l)} bold wrap="truncate">
                    {l.who}
                  </Text>
                </Box>
                <Text color={l.kind === 'error' ? C.warn : C.text} wrap="truncate">
                  {l.text}
                </Text>
              </Box>
            ))}
          </Box>
          ) : null}
        </Box>
      )
    }

    const legend = fitLegend(
      [
        { label: 'main', color: C.main },
        { label: 'agents', color: C.agent },
        { label: cfg.gateLabel.toLowerCase(), color: C.gate },
        ...(showArchitect ? [{ label: cfg.architectLabel.toLowerCase(), color: C.arch }] : []),
      ],
      W,
    )

    const body = isWide ? (
      <Box flexDirection="column">
        <Box columnGap={2}>
          {column(panels.filter(p => p === 'main' || p === 'architect' || p === 'gate'), colW)}
          {column(panels.filter(p => p === 'plan' || p === 'agents' || p === 'loops' || p === 'receipt'), colW)}
        </Box>
        {panels.includes('log') ? logPanel(W) : null}
      </Box>
    ) : (
      column(panels, W)
    )

    if (native) {
      return (
        <Box flexDirection="column" width={W} {...fill}>
          <Text wrap="truncate">
            <Text bold>OS-Deck</Text>
            <Text dimColor>{` · ${modelName} · ${m.isRunning ? 'working' : 'idle'}`}</Text>
            {showArchitect ? <Text dimColor>{` · ${cfg.architectLabel.toLowerCase()} ${advising ? 'advising' : 'on call'}`}</Text> : null}
          </Text>
          {body}
          {svgLanes}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" width={W} {...fill}>
        <Box justifyContent="center">
          <Text bold wrap="truncate">
            <Text>OS-DECK</Text>
            <Text color={C.dim}> · </Text>
            <Text color={C.main}>{modelName.toUpperCase()}</Text>
            <Text>{m.isRunning ? ' WORKS' : ' IDLE'}</Text>
            {showArchitect ? <Text color={C.dim}> · </Text> : null}
            {showArchitect ? <Text color={C.arch}>{cfg.architectLabel}</Text> : null}
            {showArchitect ? <Text>{advising ? ' ADVISING' : ' ON CALL'}</Text> : null}
          </Text>
        </Box>
        <Box justifyContent="center" columnGap={2}>
          {legend.map(l => (
            <Text>
              <Text color={l.color}>■</Text>
              <Text dimColor>{` ${l.label}`}</Text>
            </Text>
          ))}
        </Box>
        {body}
        {svgLanes}
      </Box>
    )
  })
}
