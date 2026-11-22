export type Moment = 'before a plan' | 'error repeats' | 'before done'

export type Bucket = 'file' | 'shell' | 'other'

/** rule: settings allowed it. ask: put to the decider, outcome pending. cleared: asked, then ran. deny: refused. */
export type Verdict = 'rule' | 'ask' | 'cleared' | 'deny'

export type Main = {
  model: string
  effort: string
  mode: string
  steps: number
  isRunning: boolean
  /** The main loop's last answered request: time to its first piece of response, and output tokens
   *  per second from that piece to the stop. Null until one is measured, absent in older state. */
  speed?: { ttftMs: number; tokPerS: number | null } | null
  /** The main loop's tool running now, for the pet; cleared when the next request starts. */
  tool?: string | null
  /** When the main loop last finished a turn with an answer. */
  endedAt?: number | null
}

export type Usage = {
  pct: number | null
  tokens: number | null
  window: number
  costUsd: number | null
  /** `resetsAt`: when the window resets, in ms since the epoch; null when the API gave no time,
   *  absent in state saved before it was kept. */
  limits: { kind: string; pct: number; resetsAt?: number | null }[]
  compactions: number
  lastCompactAt: number | null
  /** Context use at the end of the last few main-loop turns, for the turns-left forecast. */
  turnPcts?: number[]
}

/** The account cswap (claude-swap) has active, read from its CLI. Absent in state saved before it was kept. */
export type Account = {
  /** off: not read yet or turned off; missing: no cswap to run; error: it ran and failed. */
  status: 'off' | 'missing' | 'ok' | 'error'
  active: { number: number; email: string; org: string } | null
  accounts: { number: number; email: string; org: string; isActive: boolean; limits: Usage['limits'] }[]
  /** When it was last read, in ms since the epoch. */
  at: number | null
  /** When the active account last changed, by /os-deck account or outside it. */
  switchedAt: number | null
  error: string | null
}

export type Consult = {
  id: string
  at: number
  endAt: number | null
  moment: Moment
  via: string
  /** What it was asked about: the spawn's description. */
  about?: string
  /** The first line of what it answered. */
  advice?: string
}

export type Architect = { consults: Consult[]; ids: string[]; seen: string[]; lastAdvice: string }

export type Check = {
  id: string
  tool: string
  bucket: Bucket
  verdict: Verdict
  inSubagent: boolean
  detail: string
  at: number
}

export type Tally = { rule: number; ask: number; cleared: number; deny: number }

export type Gate = { recent: Check[]; totals: Record<Bucket, Tally> }

export type ToolNote = { tool: string; text: string; isError: boolean }

export type AgentCard = {
  id: string
  type: string
  model: string
  description: string
  status: string
  spawnedAt: number
  endedAt: number | null
  /** The agent's context now: input + cache read + cache write of its latest step. */
  ctx: number
  /** Output tokens summed over its steps. */
  out: number
  steps: number
  lastStop: string | null
  tools: ToolNote[]
  answer: string
}

/** A model loop whose id matches no card: a workflow agent, a compaction or a memory fork. */
export type Loop = { id: string; steps: number; firstAt: number; lastAt: number; isDone: boolean }

export type LogLine = {
  at: number
  who: string
  text: string
  agentId: string | null
  kind: 'info' | 'error' | 'consult' | 'done'
}

export type Turn = {
  edits: number
  errorStreak: number
  errors: number
  isReviewing: boolean
  startedAt: number
  costAtStart: number | null
  /** When a main-loop tool last failed this turn, for the pet. */
  lastErrorAt?: number | null
}

export type Receipt = {
  durationMs: number
  agents: number
  edits: number
  errors: number
  costDelta: number | null
  reason: string
}

export type Layout = 'auto' | 'compact' | 'wide' | 'mini'

/** The plan view's sections, top to bottom, each one the person may hide. */
export type DeckSection = 'title' | 'header' | 'pet' | 'git' | 'github' | 'epic' | 'plan' | 'architect' | 'agents' | 'timeline' | 'log'

export type View = {
  expanded: string | null
  gateOpen: Bucket | null
  layout: Layout | null
  /** A group the person opened by hand, kept while the task in progress is `planFocusAt`. */
  planFocus?: string[] | null
  planFocusAt?: string | null
  /** Finished tasks listed in the open group, not only counted. */
  planDone?: boolean
  /** Sections of the plan view the person hid with /os-deck hide; kept across sessions. */
  hidden?: DeckSection[]
  /** The account list under the header, opened from the account row. */
  accountOpen?: boolean
  /** Set while /os-deck demo shows its sample plan: when it began. The real plan is untouched. */
  demoAt?: number | null
  /** The pet's detail rows (the tool running and the agents, each opening its card) shown under the header. */
  petOpen?: boolean
}

export type Roster = { architectTypes: string[] }

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

/** One task of Claude's own list (TaskCreate/TaskUpdate, or a TodoWrite item), placed in the
 *  hierarchy its `metadata.group` names: ['v1.2', 'Reports'] is version v1.2, group Reports. */
export type PlanTask = {
  id: string
  subject: string
  activeForm: string
  status: TaskStatus
  group: string[]
  blockedBy: string[]
  /** Subagents spawned while this task was in progress. */
  agents: string[]
  startedAt: number | null
  doneAt: number | null
  /** jira: an open Jira subtask drawn as a placeholder until Claude's own tasks cover its group. */
  source: 'task' | 'todo' | 'jira'
}

/** One repository's state, read without its files' contents: so no count of modified files. */
export type GitRepo = {
  name: string
  branch: string
  /** Commits not pushed to, and not pulled from, the branch's upstream. */
  ahead: number
  behind: number
  /** On a feature branch, the integration branch it is measured against (origin/dev, else main) and how far it sits. */
  base: string | null
  baseAhead: number
  baseBehind: number
  staged: number
  untracked: number
  conflicts: number
}

export type Git = { repos: GitRepo[]; at: number }

export type GhCheck = { name: string; state: 'passed' | 'failed' | 'pending' | 'skipped' }

export type GhPr = {
  number: number
  title: string
  state: 'open' | 'merged' | 'closed'
  isDraft: boolean
  review: 'approved' | 'changes' | 'required' | 'none'
  checks: GhCheck[]
  /** Issues its body closes (`Closes #12`). */
  closes: number[]
  url: string
  branch: string
}

/** The GitHub section: the branch's pull request, or the repository's open ones when it has none. */
export type Github = {
  status: 'off' | 'missing' | 'ok' | 'error'
  pr: GhPr | null
  open: { number: number; title: string; branch: string; isDraft: boolean }[]
  at: number
  error: string | null
}

export type Plan = {
  tasks: PlanTask[]
  /** Section names of the plan approved in plan mode, in order: the group names Claude is asked to use. */
  groups?: string[]
  /** Tasks finished under each group path ("v1.2 / Reports") in this project's earlier sessions. */
  history?: Record<string, number>
  /** Set once the plan was rebuilt from the transcript, so a later start does not replay it again. */
  rebuilt?: boolean
  /** The Jira issue the work is anchored to: the last one cited and read. */
  jira?: JiraIssue | null
  /** Issue keys the person cited, newest last. */
  cited?: string[]
  /** The epic (or story) above the anchored issue, with every child Jira lists under it. */
  epic?: JiraEpic | null
}

export type JiraRef = { key: string; summary: string; type: string; status: string; isDone: boolean }

/** What the plan keeps of a Jira issue: the issue, its parent (story or epic) and its subtasks. */
export type JiraIssue = JiraRef & {
  assignee: string
  /** The browse link's site, `https://<site>.atlassian.net`, when known. */
  site: string | null
  parent: JiraRef | null
  subtasks: JiraRef[]
}

/** One child of an epic as a JQL search lists it: the issue and who has it. */
export type JiraChild = JiraRef & { assignee: string }

/** An epic's children, read by a `parent = KEY` search; `at` is when they were read. */
export type JiraEpic = { key: string; children: JiraChild[]; at: number }

declare module 'claude-code' {
  interface PluginState {
    'os-deck': {
      meta: { schemaVersion: number }
      main: Main
      usage: Usage
      architect: Architect
      gate: Gate
      agents: AgentCard[]
      loops: Loop[]
      log: LogLine[]
      turn: Turn
      receipt: Receipt | null
      view: View
      roster: Roster
      plan: Plan
      git: Git
      github: Github
      account: Account
    }
  }
}
