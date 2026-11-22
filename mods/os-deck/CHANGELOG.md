# Changelog

**English** · [Português](CHANGELOG.pt-BR.md)

## os-deck 0.4.3

Security and data-loss fixes.

- **Changed: git no longer runs in repositories beneath the folder you open.** Their config could make git contact a network share. The dock shows their branch alone; the new `gitChildRepos` option (off by default) restores the counts for folders you trust. The repository you open is still exposed to this through Claude Code's own git, which the dock cannot change.
- **An approved plan's words stay out of the system prompt.**
- **Redaction** covers many more token formats and leaves common code, branch names and titles alone.
- **Five slow regexes** on untrusted text are now linear or capped.
- **`/os-deck demo` no longer replaces your plan** or writes into the project's history.
- **History is no longer lost:** resuming adds to what was saved, a reset keeps earlier sessions, and each session saves under its own key, one write at a time.
- **Running agents are never dropped** to make room past 24; finished ones go first.
- **PowerShell** commands refresh the Git section.

## os-deck 0.4.2

Security fixes. **0.4.1 did not fix what it said it did: update from any earlier version.**

- **Git could still run a repository's programs in 0.4.1.** Switching filters off by name could be bypassed. Git is now read only with commands that never open file contents, and folders laid out as bare repositories are not read.
- **Changed:** the Git section no longer counts modified files (`●N`) or says `clean`, since both need file contents.
- **The 0.4.1 migration never ran.** Text saved by older versions is now cleaned at the next load.
- **Control and text-reordering characters** are stripped. A single one used to blank the whole dock.
- **Redaction:** also covers `Cookie:`, `docker login -p`, `redis-cli -a`, tokens hidden behind terminal colours, and Jira status and assignee.
- **Docs:** the time-left estimate shows on the plan's bar only, not on each group as 0.4.0 said.

## os-deck 0.4.1

Security and reliability fixes.

- **Reading git with repository filters off.** *(Correction: this could be bypassed; fixed in 0.4.2.)* `git status` is read with the filters of the repository's own config turned off, without entering submodules and without fetching. Your global and system filters (Git LFS included) still apply.
- **Configured executables.** `ghCommand` and `cswapCommand` take a bare name or an absolute path; a relative path falls back to the default.
- **Redaction everywhere.** Agent answers and descriptions, architect advice, your prompt's log line, task, Jira and pull request text, and errors are masked before they are stored. Many more credential formats are covered, state saved by older versions was meant to be masked once (it was not until 0.4.2), and the rules take linear time.
- **Jira in the prompt.** The system prompt names issues by key alone; a ticket's title and type no longer enter it. The dock still shows the titles.
- **Alerts.** An ask stops waiting when you approve it, not when the tool finishes, and when its call is interrupted. The history's waiting time follows.
- **Hooks and stored state.** A failure in the dock's own work does not reach the tool call it watches, and a bad stored value is dropped instead of breaking every later write.

## os-deck 0.4.0

- **Cubes are the real subagents.** Each cube wears its subagent's colour, by the order it was spawned, and its row in the plan gets a `■` in the same colour. When a subagent finishes, its cube holds still a moment under a `✦`; when it fails, it turns red.
- **Mascot detail.** The `▾` next to the caption (shortcut `p`) opens, under the header, the tool the main loop is running, with its elapsed time, and the subagents (running first), each a button that opens its card.
- **New mascot states.** `running`: `Bash` and `PowerShell` now show a small terminal with `>_`, prompt, command and output (they used to fall into the editing keyboard). `compact`: when the context compacts, Clawd squashes flat under a `⟲` and springs back. With context at 85% or more, it sweats (a drop beside its head) and the caption says `ctx 92%`.
- **GitHub section** (`github`, on by default): the branch's PR through the `gh` CLI, with its state, checks (`✓ ✗ …`), review and the issues it closes (`Closes #N`); with no PR, up to three of the repository's open PRs. Read when the session opens, at the end of each turn (at most once a minute) and right after a `git push` or `gh pr`. `/os-deck github` forces a read and says what it found or why it could not read. Options `github` and `ghCommand`.
- **Alerts.** A native notification (through the configured notification channel: iTerm2, kitty, Ghostty, the terminal bell or the app) when a permission ask waits more than 30 s and when a turn of 2 min or more ends. No alert in auto mode, or when you stopped the turn yourself. Options `alerts`, `alertAfterS` and `alertTurnMin`.
- **Forecasts.** The context line shows how many turns are left before it fills (`~6 turns left`), from the average of the last turns; a compaction starts the count over. In the plan, the bar shows the estimated time left, from the average duration of the tasks already finished this session.
- **History.** Each day is kept between sessions: turns, time working, tasks finished, subagents, cost and permission asks (with the time you took to answer). `/os-deck today` (or `hoje`) and `/os-deck history` (7 days, with a total).
- **Fix:** the permission mode is read during the turn again. `classic.PreToolUse` no longer carries `permission_mode`; it now comes from `classic.PermissionRequest` and `classic.PostToolUse`, so the mascot's `!` hides in auto mode again, even after a shift+tab mid-turn.
- **Fix:** a git or GitHub read that fails after the session ends no longer leaves an unhandled rejection.
- Tests: three old failing tests were fixed (assumptions of macOS paths and of a dock under 40 columns, and the architect section in the plan view); 12 new tests in `tests/upgrades.test.ts`.
- The new code lives in its own modules (`github.ts`, `alerts.ts`, `forecast.ts`, `history.ts`). The state stays in `register.tsx`: the engine only accepts `$.state` with atoms declared in the hooks module itself, so it cannot be split by section.

## os-deck 0.3.6

- Clawd's legs sit flush with the edges of its body, like Claude Code's own Clawd, and the floor shadow is as wide as the body.
- Reading: instead of the magnifier, it holds an open book in front, its eyes run from the left page to the right, it blinks and turns the page.
- Editing: instead of the pencil, it types on a keyboard in front of it, the hands take turns, each key pressed lights up and `fix(bug);` appears letter by letter above its head, with a blinking cursor.
- Subagents: a small floating cube with eyes (no legs) for each running subagent, no longer two at most. Up to 4 are big cubes; from 5 to 11 they become mini cubes around the body; past that, a `+N` shows. The cubes bob and blink out of step.

## os-deck 0.3.5

- A resumed subagent no longer duplicates its card: the dock used to refuse the whole tree (`Client ... is drawn twice`) and disappear. The card runs again with what the agent already did, and sessions that already had duplicates fix themselves.

## os-deck 0.3.4

- In auto mode the pet no longer shows the `!`: there the ask goes to the classifier, not to the person. The mode is read before each tool call, so switching with shift+tab mid-turn counts too.

## os-deck 0.3.3

- The pet shows the agents animation while any subagent is running, even after the main turn ends (background subagents used to leave the pet in done/idle).
- A subagent's turn starting no longer restarts the main turn or marks it running.

## os-deck 0.3.2

- The pet's effects are now real characters over whole cells, crisp where the half blocks blurred: thinking is a `( • · · )` balloon with a trail from the head and dots that light in turn; a permission ask is a balloon with a red `!` and the arm waving; sleep lets out `z`/`Z` that rise and fade; a turn's end has twinkling `✦ ✧` sparkles.
- Eyes raised sit a pixel below the top of the head, not on the edge.
- Idle, the pet waves now and then.
- The top of the dock no longer repeats the OS-Deck name (the frame already shows it): the row only counts tasks and agents, and goes when there are none.

## os-deck 0.3.1

- The pet no longer shows bands between rows in terminals with line spacing: one-colour cells become a space on that background colour, the drawing was aligned to whole cells and, in two-colour cells, the glyph (`▀` or `▄`) is chosen by the neighbouring colour.

## os-deck 0.3.0

- The plan view's header starts with Clawd, a pixel-art mascot (half blocks, 24×8) that shows what Claude is doing: waiting, thinking, reading, editing, with subagents, asking permission, erroring, done or sleeping.
- With the mascot, the summary beside it is leaner (shorter context gauge, limits without gauges).
- New `pet` section (`/os-deck hide pet`) and new `pet` option.
- With no room for the pet, the header says the current size and the minimum; `/os-deck pet` explains why it is not shown.
- Animation: each state starts from its first frame, quick switches between kinds of work wait 0.7 s, and the state survives a redraw of the dock. Thinking, done and asking permission redrawn.

## os-deck 0.2.0

- The header shows the active `cswap` (claude-swap) account and follows switches made outside OS-Deck (read every 45 s and before each prompt and measurement).
- `/os-deck account [n|email|alias|next]` lists the accounts or switches the account through `cswap`, by argv and with no shell.
- After a switch, the previous account's limits are dropped and the session's measurements are held for 35 s (Keychain cache); during that time `cswap`'s limits show, marked with `~`.
- In the dock, the account row opens the list of `cswap` accounts (shortcut `a`); clicking an account switches to it.
- New options: `cswap` and `cswapCommand`.

## Flightdeck (upstream)

The releases of the original Flightdeck that os-deck was forked from.

### 0.4.0

- The main box shows the time left until each rate-limit window resets (`5h ▰▱▱▱▱ 19% ↻3h10m`), from the `resetsAt` the session already reports. Below 56 columns the gauges stay as they were. ([#3](https://github.com/scasella/claude-flightdeck/pull/3), thanks @vihrea1337)
- The main box shows the last main-loop request's time to first token and decode speed (`last req  ttft 0.8s · 60 tok/s`), timed as its response streams past. ([#1](https://github.com/scasella/claude-flightdeck/issues/1))
- The session log has a one-row gap above it, in both layouts. ([#2](https://github.com/scasella/claude-flightdeck/issues/2))

### 0.3.2

- A background architect's advice is read from its `SubagentHandback` tool call, where the report actually arrives, with the hand-back text as a fallback. Bold markers no longer leak into the advice line.
- README: no longer promises that counters survive every update; a change to the state's shape may reset them once.

### 0.3.1

- The main box shows the model and effort as soon as a request starts, not after the first one finishes.
- Advice from a background architect agent (such as `fable-advisor`) now reaches the architect's `»` line; it arrives as a hand-back message, not as the agent's own answer.
- New README media showing the Flightdeck header; plainer wording about opening on start.
- More gate tests (24 in all).

### 0.3.0

First public release.

- Panels: main vitals (context, compactions, cost, rate limits), architect timeline, permission gate strip with per-family drill-down, agent cards and swimlanes, other loops, turn receipt, session log.
- Layouts: docked one- or two-column, and an 8-row inline summary for the main screen. Cards fall back to swimlanes when they don't fit.
- Theme colours by default, with a `pastel` palette option.
- Animated connectors and live clocks as surface modules, only while work flows.
- Works on the terminal, desktop app, VS Code and mobile surfaces.
- Config for the architect pattern, labels, panels, layout, card limit, motion, moments, palette, opening on start and the status line.
- `/clear` and `/flightdeck reset` start the pane fresh; reads tolerate missing or older fields.
