# os-mods

[English](README.md) · **Português**

Mods do Claude Code. Por enquanto, um:

- **[os-deck](mods/os-deck/README.pt-BR.md)**: painel lateral que mostra, ao vivo, o que a sessão do Claude Code está fazendo: o plano em tarefas por fase com os subagentes de cada uma, o mascote Clawd, git e GitHub, o épico do Jira, alertas, previsões e o log da sessão. Fork do [Flightdeck](https://github.com/scasella/claude-flightdeck) (MIT).

## Instalar

No prompt do Claude Code (terminal):

```text
/plugin install os-deck --marketplace CaioCerano/os-deck
```

De um shell:

```text
claude plugin install os-deck --marketplace CaioCerano/os-deck
```

No app desktop, onde `/plugin` não roda: clique no + ao lado da caixa do prompt, depois Plugins, Add marketplace com `CaioCerano/os-deck`, depois Add plugin.

Responda `y` para adicionar o marketplace e escolha o escopo de usuário. Detalhes, comandos e opções no [README do os-deck](mods/os-deck/README.pt-BR.md).

## Licença

MIT. Veja [mods/os-deck/LICENSE](mods/os-deck/LICENSE).
