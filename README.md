# TRIO // VALORANT — Quem joga o quê?

Página pessoal para organizar os picks de agentes do trio em cada mapa do VALORANT.

HTML + CSS + JavaScript vanilla. Sem frameworks, sem backend, sem dependências.

Os mapas, as jogadoras e os picks vêm de uma **planilha do Google Sheets publicada na Web**.

## Como executar

A página precisa ser aberta por um servidor (local ou publicado). **Abrir o `index.html` com duplo clique não funciona**: o Google bloqueia a leitura da planilha (CORS) para páginas abertas como `file://`, e a tela mostra o erro com essa dica.

Servidor local:

```bash
python -m http.server 8000
# depois acesse http://localhost:8000
```

Também funciona com a extensão Live Server do VS Code ou publicado no GitHub Pages.

## Funcionalidades

- Mapas e jogadoras gerados automaticamente a partir da planilha.
- Seleção de mapa sem recarregar a página.
- Uma coluna por jogadora com **principal**, **secundária** e **terciária** (retrato, nome e função de cada uma).
- **TROCAR**: inverte principal ↔ reserva daquela jogadora (temporário, só na tela; a terciária não participa).
- **RESTAURAR PICKS**: descarta todas as trocas e volta aos picks carregados da planilha.
- **COMPOSIÇÃO**: mostra quais funções (Duelista, Iniciador, Controlador, Sentinela) estão presentes entre os principais exibidos (✓ presente, ! função crítica ausente, — Duelista ausente). Recalcula a cada troca.
- Trocar de mapa também descarta as trocas temporárias.
- Enquanto busca os dados aparece **CARREGANDO PICKS...**; se falhar, aparece **NÃO FOI POSSÍVEL CARREGAR OS PICKS.** com o botão **TENTAR NOVAMENTE**.

## Assistente de Draft (V2: composição + META)

Abaixo da COMPOSIÇÃO. Informe o que JOGADOR 4 e JOGADOR 5 já escolheram (ou deixe "Nenhum agente") e clique em **SUGERIR PICKS**.

### Regra absoluta

Cada jogadora só pode receber a **PRINCIPAL**, a **SECUNDÁRIA/RESERVA** ou a **TERCIÁRIA** dela **no mapa atual**, conforme a planilha de PICKS. A META **nunca** adiciona agentes ao pool: mesmo um agente Tier S com 60% de win rate não é sugerido se não estiver nos picks dela.

### Como decide

Testa todas as combinações (até 3 × 3 × 3 = 27; opções vazias são ignoradas e agentes repetidos no pool da mesma jogadora contam uma vez só), descarta as que repetem agente (entre externos, externo × trio ou dentro do trio; comparação sem caixa/acentos/espaços) e soma três partes, calculadas separadamente:

```
score = estrutura + META (limitada) + preferência
```

Ordem de decisão:

1. combinação válida (sem agente repetido);
2. **maior cobertura das funções críticas** (Controlador, Iniciador, Sentinela);
3. **regra de conforto**: Duelista que só existe por causa de uma TERCIÁRIA não ganha, no ranking, o bônus de presença/diversidade de Duelista;
4. score (estrutura > META > preferência > ordem da planilha nos empates).

**Regra de conforto (terciária x Duelista)**: com a mesma cobertura crítica, não se troca uma principal/secundária por uma terciária **só para ter Duelista**. A combinação cujo único Duelista é uma terciária é comparada como se esse Duelista não existisse (o score exibido continua o real). A terciária continua vencendo quando garante função crítica, quando as outras opções da jogadora já estão na composição, quando evita excesso de uma função ou quando tem vantagem real de META. Nesses casos a explicação diz o motivo; quando a terciária perde por essa regra, a explicação diz "Phoenix (terciária) só acrescentaria Duelista, o que não justifica trocar por ela", e a alternativa mostra "Duelista só via terciária (não conta no ranking)".

**Funções críticas**: antes de qualquer score, só competem as combinações que cobrem o **máximo possível** de Controlador/Iniciador/Sentinela naquele cenário (considerando externos, pools e conflitos). Se der para ter as três, nenhuma combinação com duas pode vencer — nem com META ou principal a favor; a terciária é escolhida sem problema se for o jeito de garantir a função. Se uma função for impossível com os pools (ou as três não couberem juntas), o assistente segue com a maior cobertura possível e explica ("Controlador não pôde ser incluído com os picks disponíveis do trio."). Duelista **não** é crítico: continua só no score estrutural.

**Estrutura** (`STRUCTURAL_SCORES`), sobre os 5 (ou 4, ou 3) agentes conhecidos:

| Função | Presente | Ausente |
|---|---|---|
| Controlador | +40 | −60 |
| Iniciador | +25 | −25 |
| Sentinela | +20 | −15 |
| Duelista | +15 | −8 |

- Diversidade: 4 funções +25 · 3 funções +12 · 2 funções 0 · 1 função −30.
- Repetição (progressiva, por função; cada nível soma ao anterior: −5, −40, −70, −100): 2 agentes −5 · 3 agentes −45 · 4 agentes −115 · 5 agentes −215. Duplas (double initiator etc.) são legítimas e quase não pesam; 4 iniciadores é praticamente proibido.

**META por agente** (`META_CONFIG`, `TIER_SCORES`), só do mapa atual:

```
nonMirror  = clamp((NON_MIRROR_WR − 50) × 2,    −10, +10)
winRate    = clamp((WIN_RATE − 50)     × 0.75, −4,  +4)
confiança  = PLAYED ≥ 5%: 1 · ≥ 2%: 0.85 · ≥ 1%: 0.70 · < 1%: 0.55
tier       = S +8 · A +5 · B +2 · C 0 · D −3 · outro 0
agente     = clamp((nonMirror + winRate) × confiança + tier, −10, +15)
```

A soma do trio é limitada a **−20…+30**, para que a META não compense falta de Controlador, 4 da mesma função etc. Jogadores externos não recebem META. `KILLS_%`, `K_D` e `DD_DELTA_ROUND` são carregados, mas ainda não pesam.

**Preferência** (`PREFERENCE_SCORES`): PRINCIPAL +8, SECUNDÁRIA +3, TERCIÁRIA 0. Vem depois da cobertura crítica, da estrutura e da META: a terciária não é ruim, só tem menos prioridade de conforto.

**Ordenação**: maior cobertura crítica → score de ranking (regra de conforto) → maior score → maior estrutura → maior META → maior preferência → mais PRINCIPAIS → ordem da planilha. Sem aleatoriedade: o mesmo draft sempre dá o mesmo resultado.

### Resultado

- Para cada jogadora: agente, PRINCIPAL/SECUNDÁRIA/TERCIÁRIA, função e, se houver META, `Tier S · NM WR 55.2%`.
- COMP FINAL, FUNÇÕES, score com as partes (Composição · META · Principais).
- O **score é comparativo entre as opções disponíveis; não representa chance de vitória** nem probabilidade.
- Explicação montada pelas regras (sem IA): por que cada jogadora ficou com aquele agente, comparando com a outra opção dela.
- Com 3 ou mais combinações válidas: MELHOR OPÇÃO + 2ª e 3ª (com comp, funções, score e META).
- Trocar de mapa limpa seletores e sugestão. TROCAR/RESTAURAR não afetam o assistente (ele usa os picks originais da planilha).

### Funções dos agentes

Ordem: FUNÇÃO da META daquele mapa → `AGENTS` (local) → FUNÇÃO do agente em outro mapa da META. Assim agentes novos (ex.: Miks, Veto) funcionam mesmo fora de `AGENTS`. A função da META também aparece nos cards e na COMPOSIÇÃO.

## Planilha META (opcional)

Segunda aba publicada do mesmo arquivo, constante `META_CSV_URL` em `script.js` (**gid=442044478**):

```
https://docs.google.com/spreadsheets/d/e/2PACX-1vRYRN9DkYYxTbobwLwYwxFrwxTT430kpxlpLJOSeFRiOlDpBRtpCuDFxqkS3l0DTOBTrmrLLqnfKM63/pub?gid=442044478&single=true&output=csv
```

Colunas esperadas:

| MAPA | AGENTE | FUNÇÃO | TIER | PLAYED_% | WIN_RATE_% | NON_MIRROR_WR_% | KILLS_% | K_D | DD_DELTA_ROUND |
|---|---|---|---|---|---|---|---|---|---|
| ABYSS | Clove | Controller | S | 8,5 | 52,9 | 55,2 | 9,2 | 0,94 | -6,5 |

- Percentuais em pontos percentuais: `52,9` = 52,9%. Aceita `52.9`, `52,9`, `52.9%`, `52,9%`.
- FUNÇÃO em inglês (Controller/Initiator/Sentinel/Duelist) ou português.
- Só MAPA e AGENTE são obrigatórios; campo vazio ou inválido vale como ausente.
- Nomes de mapas e agentes são comparados sem caixa/acentos/espaços. Grafias diferentes do mesmo mapa ficam em `MAP_ALIASES` (hoje: `Abbys` → `ABYSS`). A tela continua mostrando o nome original.
- Inconsistências (número inválido, FUNÇÃO desconhecida, linha repetida, linha sem MAPA/AGENTE) são listadas no console com o número da linha; nada é corrigido silenciosamente.

**Fallback** — PICKS e META carregam em paralelo e são independentes:

| PICKS | META | Resultado |
|---|---|---|
| ok | ok | funcionamento completo |
| ok | falhou | site normal; aviso discreto "DADOS META INDISPONÍVEIS — sugestão baseada na composição." |
| ok | sem o mapa/agente | META = 0 para ele ("SEM DADOS META PARA ESTE MAPA" se faltar o mapa inteiro) |
| falhou | — | erro de sempre com TENTAR NOVAMENTE (que também tenta a META de novo) |

Se a META chegar depois de uma sugestão, a sugestão é recalculada automaticamente.

## Google Sheets

### URL configurada

Constante `SHEET_CSV_URL` no início de `script.js`:

```
https://docs.google.com/spreadsheets/d/e/2PACX-1vRYRN9DkYYxTbobwLwYwxFrwxTT430kpxlpLJOSeFRiOlDpBRtpCuDFxqkS3l0DTOBTrmrLLqnfKM63/pub?gid=0&single=true&output=csv
```

É o link de **Arquivo → Compartilhar → Publicar na Web**, no formato **CSV**. Não precisa de API key nem login. Para usar outra planilha/aba, troque só essa constante.

### Estrutura

A primeira linha é o cabeçalho. Cada linha seguinte é o pick de uma jogadora em um mapa:

| MAPA | JOGADORA | PRINCIPAL | SECUNDÁRIA | TERCIÁRIA |
|---|---|---|---|---|
| Ascent | Amorim | Astra | Skye | Sage |
| Ascent | Geu | Vyse | Sova | Phoenix |
| Ascent | Cinthia | Sage | Clove | Skye |

- A ordem das colunas não importa; os nomes do cabeçalho são lidos sem diferenciar maiúsculas/acentos.
- A coluna de reserva pode se chamar `RESERVA` ou `SECUNDÁRIA`.
- `TERCIÁRIA` é **opcional** (a coluna pode nem existir, e a célula pode ficar vazia). Ela entra no Assistente de Draft; nos cards aparece só como informação.
- Os mapas e as jogadoras aparecem na ordem em que surgem na planilha.
- Linhas sem MAPA ou sem JOGADORA são ignoradas; linhas vazias também.
- Agente vazio aparece como `—` (e o TROCAR daquela jogadora fica desabilitado).
- Se a mesma jogadora aparecer duas vezes no mesmo mapa, vale a última linha.
- Nomes de agentes são reconhecidos sem diferenciar maiúsculas/símbolos (`kayo` → `KAY/O`).

### Como adicionar um mapa

Adicione uma linha por jogadora com o nome do novo mapa na coluna MAPA. O botão do mapa aparece sozinho.

### Como alterar um agente

Edite a célula PRINCIPAL, SECUNDÁRIA ou TERCIÁRIA da linha correspondente (mapa + jogadora).

### Como adicionar/remover jogadora

- **Adicionar**: crie linhas com o nome dela na coluna JOGADORA (de preferência uma por mapa). O card aparece sozinho.
- **Remover**: apague todas as linhas com o nome dela.
- Mapa em que a jogadora não tem linha mostra o card dela com `—`.

### Como atualizar os dados exibidos

Edite a planilha e **recarregue a página** (F5). Cada carregamento busca o CSV com um parâmetro de tempo na URL (`&_=...`) e `cache: "no-store"`, para não reaproveitar cópia antiga do navegador.

Observação: o próprio Google pode levar alguns minutos para refletir uma edição no link publicado. Se a alteração não aparecer, espere um pouco e recarregue.

### TROCAR não altera a planilha

TROCAR e RESTAURAR PICKS mexem só no que está na tela. Nada é gravado na planilha, e recarregar a página volta aos dados dela.

## O que continua no `script.js`

| O quê | Constante |
|---|---|
| URL da planilha (PICKS) | `SHEET_CSV_URL` |
| URL da META | `META_CSV_URL` |
| Pesos do Assistente | `STRUCTURAL_SCORES`, `TIER_SCORES`, `META_CONFIG`, `PREFERENCE_SCORES` |
| Apelidos de mapas | `MAP_ALIASES` |
| Funções | `ROLES` |
| Agentes e suas funções | `AGENTS` (`"Nome": "Função"`) |

Para adicionar um agente novo, basta incluir uma linha em `AGENTS`, por exemplo:

```js
Veto: "Sentinela",
```

Se a planilha usar um agente que não está em `AGENTS` nem na META, o card mostra "Função desconhecida" (e ele não conta na COMPOSIÇÃO).

## Visual e imagens

Interface em estilo HUD do VALORANT: fundo azul-escuro, painéis com bordas finas, detalhes coral, cores por função (Duelista coral, Iniciador azul, Controlador roxo, Sentinela amarelo) e por jogadora (1ª coral, 2ª violeta, 3ª ciano, pela ordem da planilha). Fontes: Barlow Condensed (títulos/labels) e Inter (textos), via Google Fonts, com fallback para fontes do sistema. As cores ficam em variáveis no início de `style.css`.

### Assets

Todos vêm de [valorant-api.com](https://valorant-api.com) (assets oficiais extraídos do jogo), baixados para o projeto e otimizados em WebP. A lista com a URL original de cada arquivo está em `assets/SOURCES.json`.

| Pasta | Conteúdo |
|---|---|
| `assets/agents/<agente>.webp` | retrato quadrado 160×160 (cards e resultado) |
| `assets/agents/full/<agente>.webp` | retrato completo, 320 px de altura (arte do header) |
| `assets/maps/<mapa>.webp` | splash 640×360 (faixa do mapa selecionado) |
| `assets/maps/<mapa>-strip.webp` | faixa 456×100 (botões de mapa) |
| `assets/ui/roles/<funcao>.png` | ícones das funções (glifo branco; a cor vem do CSS) |

O `<agente>`/`<mapa>` é o nome em minúsculas, sem espaços, acentos ou símbolos (`KAY/O` → `kayo`). Mapas usam o nome normalizado, então `Abbys` usa `abyss.webp` (a tela continua mostrando "ABBYS"). Há imagens para os 29 agentes e os 13 mapas competitivos atuais.

**Sem imagem, nada quebra**: agente vira um quadro escuro com as iniciais, mapa vira fundo escuro com o nome, e a arte do header simplesmente omite o retrato. Para um agente/mapa novo, basta salvar o arquivo com o nome certo na pasta.

As funções responsáveis são `getAgentImage()`, `getAgentFullImage()`, `getMapImage()` e `getMapStripImage()` em `script.js`.

## Próximos passos

- Ajustar os pesos do Assistente com base no uso real.
- Publicar no GitHub Pages (a página já funciona como site estático).
