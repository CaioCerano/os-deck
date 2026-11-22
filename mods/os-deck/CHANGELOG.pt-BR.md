# Changelog

[English](CHANGELOG.md) · **Português**

## os-deck 0.5.0

**Agent Proof: verificação por evidência das tarefas que os agentes dizem ter terminado.**

- **Checks que você libera, rodados pelo os-deck.** `/os-deck proof setup` mostra comandos de teste, typecheck, lint e build com os scripts por trás deles. Um botão libera para a sessão, automático ou só manual. Antes disso nada roda.
- **Verified pertence ao conteúdo exato.** Uma tarefa só é verificada se os checks obrigatórios passaram no conteúdo atual e a mudança é dela. Uma edição a deixa stale; evidência que falta, é incerta ou falhou nunca verifica.
- **O alegado, o verificado e o que fica com você** aparecem separados, com a sua revisão como marca própria.
- **Scripts de check alterados pausam os checks** até você ver e liberar de novo.
- **O histórico** de execuções, alegações e revisões é guardado, e nunca conta como evidência.
- **Mudou: com um repositório liberado,** o início e a conclusão de uma tarefa esperam até 1,5 segundo enquanto o conteúdo é lido. Sem configurar o Agent Proof nada muda.
- **Só no Windows.** Fora dele o Agent Proof se recusa a começar. Os outros limites estão listados no README.

## os-deck 0.4.3

Correções de segurança e de perda de dados.

- **Mudou: o git não abre mais repositórios aninhados na pasta que você abre.** A config ou o arquivo `.git` deles podia apontar para um compartilhamento de rede. Os que ficam dentro de uma pasta mostram só a branch, e arquivos não rastreados não são mais contados. A nova opção `gitChildRepos` (desligada por padrão) devolve os dois em pastas em que você confia. O repositório que você abre continua exposto a isso pelo git do próprio Claude Code, que o dock não controla.
- **As palavras de um plano aprovado ficam fora do system prompt.**
- **A redação** cobre mais formatos de token e deixa em paz uma lista curta e fixa de frases e nomes comuns. Outros textos comuns com cara de segredo continuam mascarados.
- **Cinco regexes lentas** em texto não confiável agora são lineares ou limitadas.
- **`/os-deck demo` não substitui mais o seu plano** nem grava no histórico do projeto.
- **O histórico não se perde mais:** retomar soma ao que foi salvo, um reset mantém as sessões anteriores, uma gravação que falha é recuperada na seguinte, e cada sessão salva na própria chave. As chamadas de ferramenta não esperam mais por ele.
- **Agentes rodando são mantidos** depois de 24, até 200; os terminados saem primeiro.
- **Comandos do PowerShell** atualizam a seção Git.

## os-deck 0.4.2

Correções de segurança. **A 0.4.1 não corrigiu o que dizia: atualize a partir de qualquer versão anterior.**

- **Na 0.4.1 o git ainda podia rodar programas de um repositório.** Desligar filtros pelo nome podia ser contornado. Agora o git é lido só com comandos que nunca abrem o conteúdo dos arquivos, e pastas montadas como repositório bare não são lidas.
- **Mudou:** a seção Git não conta mais arquivos modificados (`●N`) nem diz `clean`, porque os dois precisam do conteúdo dos arquivos.
- **A migração da 0.4.1 nunca rodava.** O texto salvo por versões antigas agora é limpo no próximo carregamento.
- **Caracteres de controle e de reordenação de texto** são removidos. Um só deles apagava o dock inteiro.
- **Redação:** cobre também `Cookie:`, `docker login -p`, `redis-cli -a`, tokens escondidos atrás de cores de terminal, e status e responsável do Jira.
- **Docs:** a estimativa de tempo restante aparece só na barra do plano, não em cada grupo como a 0.4.0 dizia.

## os-deck 0.4.1

Correções de segurança e confiabilidade.

- **Leitura do git com os filtros do repositório desligados.** *(Correção: isso podia ser contornado; corrigido na 0.4.2.)* O `git status` roda com os filtros da config do próprio repositório desligados, sem entrar em submódulos e sem fetch. Os seus filtros globais e de sistema (Git LFS incluído) continuam valendo.
- **Executáveis configurados.** `ghCommand` e `cswapCommand` aceitam um nome simples ou um caminho absoluto; um caminho relativo volta para o padrão.
- **Redação em tudo.** Respostas e descrições de agentes, conselhos do architect, a linha do seu prompt no log, textos de tasks, do Jira e de PRs, e erros são mascarados antes de serem salvos. Muitos outros formatos de credencial são cobertos, o estado salvo por versões antigas deveria ser mascarado uma vez (só passou a ser na 0.4.2), e as regras rodam em tempo linear.
- **Jira no prompt.** O system prompt cita as issues só pela chave; título e tipo do ticket não entram mais. O dock continua mostrando os títulos.
- **Alertas.** Um pedido deixa de esperar quando você aprova, não quando a ferramenta termina, e também quando a chamada é interrompida. O tempo de espera do histórico acompanha.
- **Hooks e estado salvo.** Uma falha no trabalho do dock não chega à chamada de ferramenta que ele observa, e um valor salvo inválido é descartado em vez de quebrar toda escrita seguinte.

## os-deck 0.4.0

- **Cubos = subagentes de verdade.** Cada cubo tem a cor do subagente na ordem em que foi criado, e a linha dele no plano ganha um `■` da mesma cor. Quando um subagente termina, o cubo fica parado um instante com um brilho `✦`; quando falha, fica vermelho.
- **Detalhe do mascote.** O `▾` ao lado da legenda (atalho `p`) abre, embaixo do cabeçalho, a ferramenta que o loop principal está rodando, com o tempo, e os subagentes (rodando primeiro), cada um um botão que abre o cartão dele.
- **Novos estados do mascote.** `running`: `Bash` e `PowerShell` agora mostram um terminalzinho com `>_`, prompt, comando e saída (antes caíam no teclado de edição). `compact`: quando o contexto compacta, o Clawd achata sob um `⟲` e pula de volta. Com o contexto em 85% ou mais, ele sua (gota ao lado da cabeça) e a legenda diz `ctx 92%`.
- **Seção GitHub** (`github`, ligada por padrão): o PR da branch pelo `gh` CLI, com estado, checks (`✓ ✗ …`), review e as issues que ele fecha (`Closes #N`); sem PR, até três PRs abertos do repositório. Lê ao abrir a sessão, ao fim de cada turno (no máximo uma vez por minuto) e na hora depois de um `git push` ou `gh pr`. `/os-deck github` força a leitura e diz o que achou ou por que não leu. Opções `github` e `ghCommand`.
- **Alertas.** Notificação nativa (pelo canal de notificação configurado: iTerm2, kitty, Ghostty, sino do terminal ou o app) quando um pedido de permissão espera mais de 30 s e quando um turno de 2 min ou mais termina. Não avisa no modo auto nem quando você mesmo interrompe o turno. Opções `alerts`, `alertAfterS` e `alertTurnMin`.
- **Previsões.** A linha de contexto mostra quantos turnos faltam para encher (`~6 turns left`), pela média dos últimos turnos; uma compactação recomeça a conta. No plano, a barra mostra o tempo estimado que falta, pela duração média das tasks já concluídas na sessão.
- **Histórico.** Cada dia fica guardado entre sessões: turnos, tempo trabalhando, tasks concluídas, subagentes, custo e pedidos de permissão (com o tempo que você levou para responder). `/os-deck today` (ou `hoje`) e `/os-deck history` (7 dias, com total).
- **Correção:** o modo de permissão voltou a ser lido durante o turno. O `classic.PreToolUse` não traz mais `permission_mode`; agora ele vem de `classic.PermissionRequest` e `classic.PostToolUse`, então o `!` do mascote volta a sumir no modo auto mesmo depois de um shift+tab no meio do turno.
- **Correção:** uma leitura de git ou GitHub que falha depois do fim da sessão não deixa mais uma rejeição solta.
- Testes: três testes antigos que falhavam foram corrigidos (premissas de macOS e de painel com menos de 40 colunas, e a seção do arquiteto na visão plan); 12 testes novos em `tests/upgrades.test.ts`.
- O código novo fica em módulos próprios (`github.ts`, `alerts.ts`, `forecast.ts`, `history.ts`). O estado continua no `register.tsx`: o engine só aceita `$.state` com átomos declarados no próprio módulo de hooks, então ele não pode ser dividido por seção.

## os-deck 0.3.6

- As pernas do Clawd ficam rentes às bordas do corpo, como no Clawd do Claude Code, e a sombra no chão tem a largura do corpo.
- Lendo: em vez da lupa, ele segura um livro aberto na frente, os olhos correm da página da esquerda para a da direita, pisca e vira a página.
- Editando: em vez do lápis, ele digita num teclado na frente dele, as mãos se alternam, cada tecla pressionada acende e `fix(bug);` aparece letra a letra acima da cabeça, com cursor piscando.
- Subagentes: um cubinho flutuante com olhos (sem pernas) para cada subagente rodando, não mais dois no máximo. Até 4 são cubos grandes; de 5 a 11 viram minicubos em volta do corpo; acima disso aparece `+N`. Os cubos sobem, descem e piscam fora de sincronia.

## os-deck 0.3.5

- Um subagente retomado não duplica mais o cartão: o painel recusava a árvore inteira (`Client ... is drawn twice`) e sumia. O cartão volta a rodar com o que o agente já fez, e sessões que já tinham duplicatas se corrigem sozinhas.

## os-deck 0.3.4

- No modo auto o pet não mostra mais o `!`: lá o pedido vai para o classificador, não para a pessoa. O modo é lido antes de cada chamada de ferramenta, então trocar com shift+tab no meio do turno também vale.

## os-deck 0.3.3

- O pet mostra a animação de agentes enquanto houver subagentes rodando, mesmo depois que o turno principal termina (subagentes em segundo plano antes deixavam o pet em done/idle).
- O início do turno de um subagente não reinicia mais o turno principal nem o marca como rodando.

## os-deck 0.3.2

- Os efeitos do pet agora são caracteres de verdade sobre células inteiras, nítidos onde os meio-blocos borravam: o pensamento é um balão `( • · · )` com rastro saindo da cabeça e pontos que acendem em sequência; o pedido de permissão é um balão com `!` em vermelho e o braço acenando; o sono solta `z`/`Z` que sobem e somem; o fim do turno tem brilhos `✦ ✧` piscando.
- O olhar para cima fica um pixel abaixo do topo da cabeça, sem colar na borda.
- Parado, o pet acena de vez em quando.
- O topo do painel não repete mais o nome OS-Deck (a moldura já mostra): a linha só conta tasks e agentes, e some quando não há nenhum.

## os-deck 0.3.1

- O pet não mostra mais faixas entre as linhas em terminais com entrelinha: células de uma cor só viram espaço com cor de fundo, o desenho foi alinhado a células inteiras e, nas células de duas cores, o glifo (`▀` ou `▄`) é escolhido pela cor vizinha.

## os-deck 0.3.0

- O cabeçalho da visão plan começa com o Clawd, um mascote em pixel art (meio-blocos, 24×8) que mostra o que o Claude está fazendo: esperando, pensando, lendo, editando, com subagentes, pedindo permissão, com erro, concluído ou dormindo.
- Com o mascote, o resumo ao lado fica mais enxuto (gauge de contexto menor, limites sem gauge).
- Nova seção `pet` (`/os-deck hide pet`) e nova opção `pet`.
- Sem espaço para o pet, o cabeçalho diz o tamanho atual e o mínimo; `/os-deck pet` explica por que ele não aparece.
- Animação: cada estado começa do primeiro quadro, trocas rápidas entre tipos de trabalho esperam 0,7 s, e o estado sobrevive a um redesenho do painel. Pensando, concluiu e pedindo permissão redesenhados.

## os-deck 0.2.0

- O cabeçalho mostra a conta ativa do `cswap` (claude-swap) e acompanha as trocas feitas fora do OS-Deck (leitura a cada 45 s e antes de cada prompt e medição).
- `/os-deck account [n|email|alias|next]` lista as contas ou troca a conta pelo `cswap`, por argv e sem shell.
- Depois de uma troca, os limites da conta anterior são descartados e as medições da sessão ficam suspensas por 35 s (cache do Keychain); nesse período aparecem os limites do `cswap`, marcados com `~`.
- No painel, a linha da conta abre a lista das contas do `cswap` (atalho `a`); clicar numa conta faz a troca.
- Novas opções: `cswap` e `cswapCommand`.

## Flightdeck (upstream)

As versões do Flightdeck original, de onde o os-deck foi bifurcado, mantidas em inglês como no projeto de origem.

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
