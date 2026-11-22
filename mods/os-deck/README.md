# os-deck

Painel lateral (dock) que mostra, ao vivo, o que a sessão do Claude Code está fazendo: o plano quebrado em tarefas por fase, os subagentes de cada tarefa, as consultas ao arquiteto, as checagens de permissão, o estado do git, o épico do Jira e o log da sessão. As cores seguem o skin ativo do mod [skins](https://github.com/hellosverre/claude-skins), quando ele está ligado.

É um fork do [Flightdeck](https://github.com/scasella/claude-flightdeck) (MIT, de Stephen Casella), adaptado para o nosso fluxo. A documentação original está em [docs/flightdeck-original.md](docs/flightdeck-original.md).

## Autor

Caio Cerano ([@CaioCerano](https://github.com/CaioCerano)).

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

Responda `y` para adicionar o marketplace e escolha o escopo de usuário. Vale a partir da próxima sessão (ou depois de `/reload-plugins`). Se você usa o Flightdeck original, desative-o (`claude plugin disable flightdeck@claude-flightdeck`): os dois respondem a `/flightdeck`.

## Para que serve

Acompanhar sessões longas sem rolar o transcript. Na visão `plan` (padrão):

| Seção | O que mostra |
|---|---|
| Cabeçalho | O mascote (Clawd) e, ao lado, modelo, contexto, custo, limites 5h/7d e a conta ativa do `cswap` |
| Git | Branch, ahead/behind e arquivos alterados do repositório da sessão |
| GitHub | O PR da branch (estado, checks, review, issues que fecha) pelo `gh`; sem PR, os abertos do repositório |
| Épico | A issue do Jira citada na sessão e os filhos do épico acima dela |
| Plano | As tarefas (`TaskCreate`) agrupadas por trabalho e fase (Plano, Implementação, Qualidade), com os subagentes aninhados em cada tarefa |
| Arquiteto | Cada consulta ao subagente arquiteto: o momento, o assunto e a recomendação |
| Agentes | Subagentes por tipo, com modelo e tempo típico |
| Linha do tempo | Tarefas e agentes lado a lado |
| Log | Os eventos da sessão |

Com a política de plano `always`, o mod pede ao Claude que quebre todo trabalho de vários passos em tarefas por fase, para o painel sempre ter um plano.

O painel abre ao lado da conversa no terminal em tela cheia a partir de 110 colunas; em terminais menores aparece acima do prompt, resumido.

## Comandos

`/os-deck` (ou `/flightdeck`):

| Comando | O que faz |
|---|---|
| `/os-deck` | Abre o painel |
| `/os-deck close` | Fecha o painel |
| `/os-deck reset` | Zera o que o painel acumulou na sessão |
| `/os-deck demo` | Preenche o plano com um exemplo |
| `/os-deck hide <seção>` / `show <seção>` | Esconde ou mostra uma seção (guardado entre sessões), `pet` incluído |
| `/os-deck sections` | Lista as seções e quais estão ocultas |
| `/os-deck layout <auto\|compact\|wide\|mini>` | Troca o layout |
| `/os-deck epic` | Lê do Jira o épico da issue ancorada |
| `/os-deck github` | Lê o GitHub agora e diz o PR da branch (ou por que não leu) |
| `/os-deck today` / `history` | O resumo de hoje, ou dos últimos 7 dias com total: turnos, tempo, tasks, subagentes, custo, pedidos de permissão |
| `/os-deck pet` | Diz se o mascote está aparecendo e, se não, por quê (tamanho do painel, seção oculta, opção) |
| `/os-deck account` (ou `conta`) | Lista as contas do `cswap`, com o uso de 5h/7d de cada uma |
| `/os-deck account <n\|email\|alias>` | Troca a conta do Claude pelo `cswap` |
| `/os-deck account next` | Passa para a próxima conta, como `cswap switch` sem alvo |

No painel, a linha `account` do cabeçalho é um botão (atalho `a`): ela abre a lista das contas que você já tem no `cswap`, com o uso de 5h/7d de cada uma. Clicar numa conta faz a troca e mostra o resultado num aviso.

## O mascote

O cabeçalho da visão `plan` começa com o **Clawd**, um mascote em pixel art desenhado para este mod (24 colunas × 8 linhas). Ele usa meio-blocos (`▀`) com cor de frente e de fundo, então funciona em qualquer terminal, sem imagem. Ao lado dele, o resumo da sessão fica mais enxuto: o gauge de contexto é menor, os limites aparecem sem gauge e o número de requisições sai.

| Estado | Quando |
|---|---|
| À espera | sessão aberta, nada rodando (pisca e olha para os lados) |
| Pensando | o turno começou e o modelo está respondendo |
| Lendo | `Read`, `Grep`, `Glob`, `WebFetch`… no loop principal (livro aberto na frente, olhos correndo as páginas, uma página vira) |
| Editando | `Edit`, `Write`… no loop principal (digita num teclado na frente dele, teclas acendem e o texto cresce acima da cabeça) |
| Rodando um comando | `Bash` ou `PowerShell` no loop principal (um terminalzinho com `>_`: prompt, comando, saída) |
| Com subagentes | um cubinho flutuante com olhos para cada subagente, na cor dele (a mesma do `■` na linha do plano): grandes até 4, mini até 11, depois `+N`. Ao terminar, fica um instante com `✦`; ao falhar, vermelho |
| Compactou | o contexto foi compactado (achata sob um `⟲` e pula de volta, por 2,5 s) |
| Pedindo permissão | uma ferramenta espera o seu sim (placa com "!") |
| Deu erro | uma ferramenta do loop principal falhou (por 3 s) |
| Concluiu | o turno terminou com resposta (pula, por 5 s) |
| Dormindo | 5 min sem nada acontecer |

Com o contexto em 85% ou mais, o mascote sua (uma gota ao lado da cabeça) e a legenda ganha `· ctx 92%`. O `▾` ao lado da legenda (atalho `p`) abre o detalhe: a ferramenta do loop principal com o tempo dela e os subagentes, cada um um botão que abre o cartão.

Cada estado começa do primeiro quadro. Entre dois tipos de trabalho (pensando, lendo, editando, subagentes), o estado mostrado fica pelo menos 0,7 s, para chamadas rápidas não fazerem o pet piscar; permissão, erro, fim e descanso entram na hora.

O corpo usa a cor de destaque do skin ativo, mesmo no estilo `native`; sem skin, usa o laranja do Claude. A animação roda num módulo de superfície (`hooks/pet.tsx`) e só redesenha a região do pet quando o quadro muda, nunca o painel inteiro.

O pet não aparece com o painel mais estreito que 58 colunas ou mais baixo que 30 linhas, para não tirar espaço do plano. No lugar dele, o cabeçalho mostra uma linha discreta com o tamanho atual e o que falta (`pet hidden: pane 52×28, needs 58×30`), e `/os-deck pet` explica por que ele está ou não aparecendo. Também não aparece no layout `mini` nem na visão `classic`. Para escondê-lo, use `/os-deck hide pet` (ou `mascote`); para desligar de vez, a opção `pet: false`.

## Alertas e previsões

Com a opção `alerts` (ligada por padrão), o OS-Deck manda uma notificação nativa pelo canal que você configurou no Claude Code (iTerm2, kitty, Ghostty, sino do terminal ou o app) quando:

- um pedido de permissão espera por você há `alertAfterS` segundos (30 por padrão); não no modo auto, em que quem responde é o classificador;
- um turno de `alertTurnMin` minutos ou mais (2 por padrão) termina; não quando você mesmo o interrompe.

Sem canal de notificação, o aviso vira um toast no painel.

A linha de contexto do cabeçalho mostra quantos turnos faltam para o contexto encher (`~6 turns left`, ou `~6t` ao lado do mascote), pela média de crescimento dos últimos seis turnos; uma compactação recomeça a conta. No plano, a barra e cada grupo aberto mostram o tempo que falta (`~12m`), pela duração média das tasks concluídas nesta sessão; sem nenhuma concluída ainda, não há estimativa.

## Conta do Claude (cswap)

Com o [claude-swap](https://github.com/realiti4/claude-swap) (`cswap`) instalado, o cabeçalho mostra a conta ativa (`account voce@empresa.com #2`) e acompanha as trocas feitas fora do OS-Deck: pelo terminal, pela menubar ou pelo `cswap auto`. O mod lê `cswap list --json` ao abrir a sessão, a cada 45 s e antes de cada prompt e medição (no máximo uma vez a cada 5 s). Sem o `cswap`, a linha não aparece e nada mais muda.

Por que isso é preciso: os limites 5h/7d da sessão vêm das respostas da API e só mudam quando chega uma resposta nova. Além disso, no macOS o `cswap` grava a credencial no Keychain, e o Claude Code mantém o token antigo em cache por cerca de 30 s. Então, logo depois de uma troca, a sessão ainda pode responder pela conta anterior. Para não exibir os limites da conta errada:

- quando a conta ativa muda, o log registra `account a → b` e os limites da sessão são descartados;
- durante 35 s, as medições da sessão são ignoradas, e a conta aparece em âmbar com `switching…`;
- enquanto a sessão não tem limites próprios, a linha de limites mostra os do `cswap` para a conta ativa, marcados com `~` (`~5h`). É uma leitura em cache do `cswap`, não um valor ao vivo. Fora dessa janela, os limites da sessão sempre prevalecem.

Uma troca feita fora do OS-Deck só é vista na próxima leitura: em até 45 s, ou antes, no próximo prompt. Se nesse intervalo chegarem limites da conta nova, eles também são descartados quando a troca é detectada, e o `~` aparece por 35 s. É uma imprecisão aceita.

No Linux e no Windows o `cswap` grava em arquivo, e o Claude Code costuma aplicar a troca já na próxima mensagem. A janela de 35 s vale nos três sistemas, por precaução.

A troca roda `cswap switch <alvo> --json` por vetor de argumentos, sem shell. O alvo precisa ser um número de até 3 dígitos, um e-mail ou um alias (`[a-z0-9][\w.-]{0,31}`), e nunca pode começar com `-`. O `cswap` não aceita `--` antes do alvo, por isso essa validação é a proteção. `next` (ou `próxima`) é palavra reservada: um alias com esse nome só pode ser usado pelo número ou pelo e-mail.

## Capacidades usadas

Saída de `claude plugin validate mods/os-deck`:

- Eventos: `session.start`, `session.end`, `session.measure`, `session.compact`, `turn.start`, `turn.step`, `turn.complete`, `agent.offer`, `agent.spawn`, `tool.check`, `command.run`, `classic.UserPromptSubmit`, `classic.PermissionRequest` e `classic.PostToolUse` (só para ler o modo de permissão), `ui.render` do `Pane`.
- **Sensíveis:**
  - `prompt.submit`: só lê o prompt para achar a chave de issue do Jira citada (ancora o plano). Não altera o prompt.
  - `prompt.compose`: acrescenta ao prompt de sistema uma seção pedindo que as tarefas sejam agrupadas por trabalho e fase (desligável com `planHint` e `planPolicy`).
  - `tool.call` e `session.append`: só observam as chamadas de ferramenta e as mensagens para desenhar o plano, os agentes, as permissões e o log. Passam tudo adiante sem negar, reescrever nem atrasar nada.
  - `$.process.run`: roda `git --no-optional-locks -C <dir> status|for-each-ref|rev-list|rev-parse` por vetor de argumentos, sem shell, para a seção Git. Com a opção `github` ligada, roda `<ghCommand> pr view --json …` e `<ghCommand> pr list --state open --json …` no diretório da sessão (só leitura). Com a opção `cswap` ligada, roda também `<cswapCommand> list --json` (leitura da conta) e `<cswapCommand> switch [<alvo>] --json`, este só quando a pessoa pede com `/os-deck account <alvo>`. O alvo é validado antes (veja a seção acima), e o executável vem só do `userConfig`, nunca de um argumento do comando.
  - `$.fs.exists`, `$.fs.list`: acha o repositório git da sessão.
  - `$.tool.call`: lê issue e épico do Jira pelo conector Atlassian (`getJiraIssue`, `searchJiraIssuesUsingJql`), só com `jiraFetch` ligado ou com `/os-deck epic`. Cada leitura pede permissão como qualquer chamada de ferramenta.
- `$.session.cwd`, `$.session.id`, `$.session.messages`, `$.session.usage`: diretório, id, histórico (para reconstruir o plano ao retomar) e uso da sessão.
- `$.state` (`os-deck.*`): estado do painel na sessão, incluindo a ferramenta do loop principal e os horários de fim de turno e de falha que o mascote usa, a última leitura da conta (`os-deck.account`), para uma recarga do mod não contar como troca. Lê também, sem escrever, `skins.prefs`, `skins.custom` e `skins.isLight`, para usar as cores do skin.
- `$.store`: seções ocultas, histórico do plano e o resumo de cada dia (`os-deck:history`, uns dois meses), entre sessões.
- `$.ui.notify`: os alertas de permissão esperando e de turno longo (opção `alerts`). `$.clock.now`, `$.clock.every` (leitura da conta a cada 45 s), `$.clock.after` (nova leitura quando a janela de 35 s termina), ambos cancelados no fim da sessão, `$.command.register`, `$.ui.open`, `$.ui.close`, `$.ui.resolve`, `$.ui.status`, `$.ui.toast`.

Comandos de git e texto do log passam por uma redação que esconde tokens, senhas e chaves.

## Configuração

```text
/plugin configure os-deck@os-mods
```

As principais: `view` (`plan` ou `classic`), `layout`, `panels` (quais seções e em que ordem), `palette` (`skin`, `theme`, `pastel`), `background` (cor de fundo em hex, para casar com o terminal), `planPolicy` e `planPhases`, `architectPattern` (quais agentes contam como arquiteto), `jiraSite` e `jiraFetch`, `openOnStart`, `statusLine`, `pet` (o mascote no cabeçalho, ligado por padrão), `cswap` (liga a linha de conta e o `/os-deck account`, ligado por padrão), `cswapCommand`, `github` e `ghCommand` (a seção GitHub), `alerts`, `alertAfterS` e `alertTurnMin` (os alertas) (o executável do `cswap`, quando o Claude Code não o acha no `PATH`). A descrição de cada uma está no `plugin.json`.

## Dependências de sistema

`git` no `PATH`, só para a seção Git (sem ele, a seção fica vazia). O [GitHub CLI](https://cli.github.com) (`gh`, autenticado) é opcional, só para a seção GitHub: sem ele, a seção não aparece e `/os-deck github` diz por quê. O conector Atlassian é opcional, só para o épico do Jira. O [claude-swap](https://github.com/realiti4/claude-swap) (`cswap`) também é opcional, só para a linha de conta e o `/os-deck account`. O mod não o instala: sem ele, a linha não aparece.

## Como remover

```text
claude plugin uninstall os-deck@os-mods
```

## Versão do Claude Code validada

2.1.301 no macOS (Darwin 25.3). A conta via `cswap` foi validada no 2.1.302 no macOS, com o claude-swap e duas contas. O mascote foi validado pelo kit de testes do 2.1.302, que roda o módulo de superfície; ainda não foi visto numa sessão interativa. Ubuntu e Windows não validados; o mod não depende do sistema, além do `git` e, opcionalmente, do `cswap`.

## Licença

MIT, herdada do Flightdeck. Veja [LICENSE](LICENSE).
