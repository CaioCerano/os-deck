# os-deck

**English** · [Português](README.pt-BR.md)

A side dock that shows, live, what your Claude Code session is doing: the plan broken into tasks by phase, each task's subagents, architect consults, permission checks, git and GitHub state, the Jira epic and the session log. Its colours follow the active skin of the [skins](https://github.com/hellosverre/claude-skins) mod when that mod is on.

It is a fork of [Flightdeck](https://github.com/scasella/claude-flightdeck) (MIT, by Stephen Casella), adapted to our workflow. The original documentation is in [docs/flightdeck-original.md](docs/flightdeck-original.md).

## Author

Caio Cerano ([@CaioCerano](https://github.com/CaioCerano)).

## Install

At the Claude Code prompt (terminal):

```text
/plugin install os-deck --marketplace CaioCerano/os-deck
```

From a shell:

```text
claude plugin install os-deck --marketplace CaioCerano/os-deck
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `CaioCerano/os-deck`, then Add plugin.

Answer `y` to add the marketplace and choose the user scope. It takes effect from the next session (or after `/reload-plugins`). If you use the original Flightdeck, disable it (`claude plugin disable flightdeck@claude-flightdeck`): both answer to `/flightdeck`.

## What it is for

Following long sessions without scrolling the transcript. In the `plan` view (the default):

| Section | What it shows |
|---|---|
| Header | The mascot (Clawd) and, beside it, model, context, cost, the 5h/7d limits and the active `cswap` account |
| Git | Branch, ahead/behind and changed files of the session's repository |
| GitHub | The branch's PR (state, checks, review, issues it closes) through `gh`; with no PR, the repository's open ones |
| Epic | The Jira issue cited in the session and the children of the epic above it |
| Plan | The tasks (`TaskCreate`) grouped by work and phase (Plano, Implementação, Qualidade), with the subagents nested under each task |
| Architect | Each consult with the architect subagent: when, what about, and the advice |
| Agents | Subagents by type, with model and typical time |
| Timeline | Tasks and agents side by side |
| Log | The session's events |

With the `always` plan policy, the mod asks Claude to break any multi-step work into tasks by phase, so the dock always has a plan. The phase names are the `planPhases` option.

The dock opens beside the conversation in a full-screen terminal from 110 columns; in smaller terminals it shows above the prompt, summarised.

## Commands

`/os-deck` (or `/flightdeck`):

| Command | What it does |
|---|---|
| `/os-deck` | Opens the dock |
| `/os-deck close` | Closes the dock |
| `/os-deck reset` | Clears what the dock gathered this session |
| `/os-deck demo` | Fills the plan with a sample |
| `/os-deck hide <section>` / `show <section>` | Hides or shows a section (kept between sessions), `pet` included |
| `/os-deck sections` | Lists the sections and which are hidden |
| `/os-deck layout <auto\|compact\|wide\|mini>` | Changes the layout |
| `/os-deck epic` | Reads the anchored issue's epic from Jira |
| `/os-deck github` | Reads GitHub now and reports the branch's PR (or why it could not read) |
| `/os-deck today` / `history` | Today's summary, or the last 7 days with a total: turns, time, tasks, subagents, cost, permission asks |
| `/os-deck pet` | Says whether the mascot is shown and, if not, why (dock size, hidden section, option) |
| `/os-deck account` (or `conta`) | Lists the `cswap` accounts, with each one's 5h/7d usage |
| `/os-deck account <n\|email\|alias>` | Switches the Claude account through `cswap` |
| `/os-deck account next` | Moves to the next account, like `cswap switch` with no target |

In the dock, the header's `account` row is a button (shortcut `a`): it opens the list of the accounts you already have in `cswap`, with each one's 5h/7d usage. Clicking an account switches to it and shows the result in a toast.

## The mascot

The `plan` view's header starts with **Clawd**, a pixel-art mascot drawn for this mod (24 columns × 8 rows). It is made of half blocks (`▀`) with a foreground and a background colour, so it works in any terminal, with no image. Beside it, the session summary is leaner: the context gauge is shorter, the limits show without gauges, and the request count goes.

| State | When |
|---|---|
| Waiting | session open, nothing running (blinks and glances around) |
| Thinking | the turn started and the model is answering |
| Reading | `Read`, `Grep`, `Glob`, `WebFetch`… in the main loop (an open book held in front, eyes running across the pages, a page turns) |
| Editing | `Edit`, `Write`… in the main loop (typing on a keyboard in front of it, keys light up and the text grows above its head) |
| Running a command | `Bash` or `PowerShell` in the main loop (a small terminal with `>_`: prompt, command, output) |
| With subagents | a small floating cube with eyes for each subagent, in its colour (the same as the `■` on its plan row): big up to 4, mini up to 11, then `+N`. A finished one stays a moment with a `✦`; a failed one turns red |
| Compacted | the context was compacted (squashes flat under a `⟲` and springs back, for 2.5 s) |
| Asking permission | a tool waits for your yes (a sign with "!") |
| Error | a main-loop tool failed (for 3 s) |
| Done | the turn ended with an answer (hops, for 5 s) |
| Sleeping | 5 min with nothing happening |

With context at 85% or more, the mascot sweats (a drop beside its head) and the caption gets `· ctx 92%`. The `▾` next to the caption (shortcut `p`) opens the detail: the main loop's tool with its elapsed time, and the subagents, each a button that opens its card.

Each state starts from its first frame. Between two kinds of work (thinking, reading, editing, running, subagents), the state shown stays at least 0.7 s, so quick tool calls do not make the pet flicker; permission, error, compaction, done and rest cut in at once.

The body wears the active skin's accent colour, in the `native` style too; with no skin, Claude's orange. The animation runs in a surface module (`hooks/pet.tsx`) and only redraws the pet's region when the frame changes, never the whole dock.

The pet sits beside the summary from 58 columns and on top of it in narrower docks. In a dock under 30 rows it is left out so it does not take room from the plan: in its place, the header shows a quiet line with the current size and what is needed (`pet hidden: pane 70×20, needs 24×30`), and `/os-deck pet` explains why it is or is not shown. It is also not drawn in the `mini` layout or the `classic` view. To hide it, use `/os-deck hide pet` (or `mascote`); to turn it off for good, the `pet: false` option.

## Alerts and forecasts

With the `alerts` option (on by default), OS-Deck sends a native notification through the channel you set up in Claude Code (iTerm2, kitty, Ghostty, the terminal bell or the app) when:

- a permission ask has waited on you for `alertAfterS` seconds (30 by default); not in auto mode, where the classifier answers;
- a turn of `alertTurnMin` minutes or more (2 by default) ends; not when you stopped it yourself.

With no notification channel, the alert becomes a toast in the dock.

The header's context line shows how many turns are left before the context fills (`~6 turns left`, or `~6t` beside the mascot), from the average growth of the last six turns; a compaction starts the count over. In the plan, the bar and each open group show the time left (`~12m`), from the average duration of the tasks finished this session; with none finished yet, there is no estimate.

## Claude account (cswap)

With [claude-swap](https://github.com/realiti4/claude-swap) (`cswap`) installed, the header shows the active account (`account you@company.com #2`) and follows switches made outside OS-Deck: from the terminal, the menu bar or `cswap auto`. The mod reads `cswap list --json` when the session opens, every 45 s, and before each prompt and measurement (at most once every 5 s). Without `cswap`, the row does not show and nothing else changes.

Why this is needed: the session's 5h/7d limits come from API responses and only change when a new response arrives. Also, on macOS `cswap` writes the credential to the Keychain, and Claude Code keeps the old token cached for about 30 s. So right after a switch, the session may still answer through the previous account. To avoid showing the wrong account's limits:

- when the active account changes, the log records `account a → b` and the session's limits are dropped;
- for 35 s, the session's measurements are ignored, and the account shows in amber with `switching…`;
- while the session has no limits of its own, the limits row shows `cswap`'s for the active account, marked with `~` (`~5h`). This is `cswap`'s cached reading, not a live value. Outside that window, the session's limits always win.

A switch made outside OS-Deck is only seen at the next read: within 45 s, or sooner, at the next prompt. If the new account's limits arrive in that interval, they are also dropped when the switch is detected, and the `~` shows for 35 s. This is an accepted inaccuracy.

On Linux and Windows `cswap` writes to a file, and Claude Code usually applies the switch from the next message. The 35 s window applies on all three systems, as a precaution.

The switch runs `cswap switch <target> --json` by argument vector, with no shell. The target must be a number of up to 3 digits, an email or an alias (`[a-z0-9][\w.-]{0,31}`), and may never start with `-`. `cswap` does not accept `--` before the target, so this validation is the protection. `next` (or `próxima`) is a reserved word: an alias with that name can only be used by its number or email.

## Capabilities used

From `claude plugin validate mods/os-deck`:

- Events: `session.start`, `session.end`, `session.measure`, `session.compact`, `turn.start`, `turn.step`, `turn.complete`, `agent.offer`, `agent.spawn`, `tool.check`, `command.run`, `classic.UserPromptSubmit`, `classic.PermissionRequest` and `classic.PostToolUse` (only to read the permission mode), `ui.render` of the `Pane`.
- **Sensitive:**
  - `prompt.submit`: only reads the prompt to find a cited Jira issue key (which anchors the plan). It does not change the prompt.
  - `prompt.compose`: adds a section to the system prompt asking for tasks grouped by work and phase (turned off with `planHint` and `planPolicy`).
  - `tool.call` and `session.append`: only watch tool calls and messages to draw the plan, the agents, the permissions and the log. They pass everything on without denying, rewriting or delaying anything.
  - `$.process.run`: runs `git --no-optional-locks -C <dir> status|for-each-ref|rev-list|rev-parse` by argument vector, with no shell, for the Git section. With the `github` option on, it runs `<ghCommand> pr view --json …` and `<ghCommand> pr list --state open --json …` in the session's directory (read only). With the `cswap` option on, it also runs `<cswapCommand> list --json` (reading the account) and `<cswapCommand> switch [<target>] --json`, the latter only when you ask with `/os-deck account <target>`. The target is validated first (see the section above), and the executables come only from `userConfig`, never from a command argument.
  - `$.fs.exists`, `$.fs.list`: find the session's git repository.
  - `$.tool.call`: reads the Jira issue and epic through the Atlassian connector (`getJiraIssue`, `searchJiraIssuesUsingJql`), only with `jiraFetch` on or with `/os-deck epic`. Each read asks permission like any tool call.
- `$.session.cwd`, `$.session.id`, `$.session.messages`, `$.session.usage`: the session's directory, id, history (to rebuild the plan when resuming) and usage.
- `$.state` (`os-deck.*`): the dock's state in the session, including the main loop's tool and the turn-end and failure times the mascot uses, and the last account reading (`os-deck.account`), so a reload of the mod does not count as a switch. It also reads, without writing, `skins.prefs`, `skins.custom` and `skins.isLight`, to use the skin's colours.
- `$.store`: hidden sections, the plan's history and each day's summary (`os-deck:history`, about two months), between sessions.
- `$.ui.notify`: the alerts for a waiting ask and a long turn (the `alerts` option). `$.clock.now`, `$.clock.every` (reading the account every 45 s), `$.clock.after` (a new reading when the 35 s window ends, and the ask alerts), all cancelled when the session ends, `$.command.register`, `$.ui.open`, `$.ui.close`, `$.ui.resolve`, `$.ui.status`, `$.ui.toast`.

Everything the dock stores from commands, agents, tasks, Jira, GitHub and errors goes through a redaction that hides tokens, passwords and keys. It works by pattern, so a secret in a format it does not know can still show. Git is read with the filters of the repository's own config turned off (filters installed with `git lfs install --local` included), and Jira issues enter the system prompt by key alone.

## Configuration

```text
/plugin configure os-deck@os-mods
```

The main ones: `view` (`plan` or `classic`), `layout`, `panels` (which sections and in what order), `palette` (`skin`, `theme`, `pastel`), `background` (a hex background colour, to match your terminal), `planPolicy` and `planPhases`, `architectPattern` (which agents count as the architect), `jiraSite` and `jiraFetch`, `openOnStart`, `statusLine`, `pet` (the mascot in the header, on by default), `cswap` (turns on the account row and `/os-deck account`, on by default), `cswapCommand` (the `cswap` executable, when Claude Code cannot find it on the `PATH`), `github` and `ghCommand` (the GitHub section), `alerts`, `alertAfterS` and `alertTurnMin` (the alerts). Each one is described in `plugin.json`.

## System dependencies

`git` on the `PATH`, only for the Git section (without it, the section stays empty). The [GitHub CLI](https://cli.github.com) (`gh`, signed in) is optional, only for the GitHub section: without it, the section does not show and `/os-deck github` says why. The Atlassian connector is optional, only for the Jira epic. [claude-swap](https://github.com/realiti4/claude-swap) (`cswap`) is optional too, only for the account row and `/os-deck account`. The mod does not install it: without it, the row does not show.

## Uninstall

```text
claude plugin uninstall os-deck@os-mods
```

## Claude Code versions validated

2.1.301 on macOS (Darwin 25.3). The `cswap` account was validated on 2.1.302 on macOS, with claude-swap and two accounts. Version 0.4.0 passed the 110 tests of the 2.1.329 test kit on Windows 11, which runs the dock and the surface module in a simulated terminal; it has not yet been seen in an interactive session. Ubuntu is not validated; the mod does not depend on the system beyond `git` and, optionally, `gh` and `cswap`.

## License

MIT, inherited from Flightdeck. See [LICENSE](LICENSE).
