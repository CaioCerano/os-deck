# os-mods

**English** · [Português](README.pt-BR.md)

Claude Code mods. For now, one:

**141 automated tests** (114 written for os-deck) · **[a changelog for every release](mods/os-deck/CHANGELOG.md)** · [what os-deck adds over Flightdeck](mods/os-deck/README.md#what-os-deck-adds-over-flightdeck)

![The os-deck mascot changing states as a session works](mods/os-deck/docs/media/mascot-states.gif)

- **[os-deck](mods/os-deck/README.md)**: a side dock that shows, live, what your Claude Code session is doing: the plan in tasks by phase with each one's subagents, the Clawd mascot, git and GitHub, the Jira epic, alerts, forecasts and the session log. A fork of [Flightdeck](https://github.com/scasella/claude-flightdeck) (MIT).

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

Answer `y` to add the marketplace and choose the user scope. Details, commands and options are in the [os-deck README](mods/os-deck/README.md).

## License

MIT. See [mods/os-deck/LICENSE](mods/os-deck/LICENSE).
