# Decisões — crm-worker

Registro **append-only** das decisões deste serviço, com o *porquê* junto. É o irmão dos registros do
crm-backend: lá as decisões são de **modelagem** (`D-00x`, e `modelo/` é dono do schema) e de
**backend** (`BE-00x` — camadas, build, runtime da API); aqui são as **deste deployable** — o loop de
consumo, a classificação de erro, o layout de teste, o que se importa e o que não se escreve.

**Nada aqui modela.** Quando o assunto for dado — tabela, coluna, enum, índice, view, function,
trigger —, `crm-backend/modelo/` manda e este arquivo não tem voz. **E nada aqui define contrato de
payload**: o do pré é transcrição de um artefato (D-076), o do enriquecimento é autorado no
`crm-backend/modelo/contratos/`. Este serviço **valida** contra os dois; não os escreve.

Cada projeto tem o seu, com prefixo próprio, para os números nunca colidirem entre repositórios:

| Projeto | Arquivo | Prefixo |
|---|---|---|
| crm-backend | `modelo/decisoes.md` | `D-00x` (modelagem — manda no schema) |
| crm-backend | `docs/decisoes.md` | `BE-00x` (camadas, build, teste, runtime da API) |
| crm-frontend | `docs/decisoes.md` | `FE-00x` |
| crm-worker | `docs/decisoes.md` (este) | `SW-00x` |

**Como usar:** antes de mexer no loop ou no gravador, leia. Se a mudança pede algo que contraria uma
decisão, a saída é **mudar a decisão** (nova entrada, revogando a antiga) — não abrir exceção calada
no código. Decisão revogada não some: ganha a marca `REVOGADA por SW-00N`, para o histórico continuar
legível. Numeração é sequencial e nunca reaproveitada.

**Toda entrada nomeia o seu executor**, e é a única maneira de uma decisão não ser redigitada daqui a
um mês. O crm-backend resolve isso com tags que apontam para skills; **aqui não há tags**, porque não
há skill neste repo para cobrar uma. Então cada entrada diz, no fim, quem a faz valer:

| Tipo de executor | Exemplo |
|---|---|
| **Comando** — reprova sozinho no `verify` | uma regra do eslint, um piso do `vitest.config.ts` |
| **Teste** — um caso que quebra se alguém desfizer | `tests/unit/consumidor.test.ts` |
| **`AGENTS.md`** — vale em qualquer arquivo, então sobe para lá | a regra do ator da trilha |

Entrada sem executor é **bug deste arquivo** — não existe quarto estado.

Onze das doze primeiras decisões foram **tomadas em 06/08/2026**, durante a construção do serviço, e
viviam só em comentário de código e em nota de requisito. Registrá-las é o que as torna citáveis: um
comentário se apaga num refactor sem ninguém notar que apagou uma decisão. A **SW-013** é posterior —
12/08/2026 — e nasceu já como decisão, não como registro de algo que o código fazia.

---

## SW-001 — Apagar da fila é **depois** do commit

**Decisão.** O `DeleteMessage` só é enviado após a transação committar. Nunca antes, nunca em
paralelo.

**Por quê.** A ordem É a garantia. Apagar depois faz a entrega ser *at-least-once*: se o processo
morrer entre o commit e o delete, a mensagem volta pela visibilidade e a idempotência do banco (os
dois índices únicos do REQ-0409) absorve a repetição. Apagar antes trocaria *"grava duas vezes, que o
banco resolve"* por *"perde o retorno"* — e o retorno perdido é o de um trabalho **já pago** ao
fornecedor: o enriquecimento de contato chama quatro provedores cobrados, sem early-exit.

A troca é assimétrica de propósito. Duplicata tem conserto estrutural (índice único); retorno perdido
não tem conserto nenhum, porque refazer significa pagar de novo.

**Executor:** `tests/unit/consumidor.test.ts` — há caso afirmando que o delete não sai quando a
gravação lança, e que sai depois quando ela conclui.

---

## SW-002 — Erro de **dado** do Postgres é permanente; erro de **infra** é transiente

**Decisão.** As classes `22` (data exception) e `23` (integrity constraint) do SQLSTATE são
**permanentes**: a mensagem é apagada e o log é o registro. Falha de conexão (`08`), deadlock
(`40P01`) e timeout (`57014`) são **transientes**: a mensagem **não** é apagada e volta pela
visibilidade.

**Por quê.** Descoberto rodando de ponta a ponta, não em teoria. Um retorno com `id_credito`
inexistente violava a FK, e a classificação ingênua — *"não é erro nosso ⇒ transiente"* — mandava a
mensagem de volta para violar **a mesma FK** até esgotar o `maxReceiveCount`. **Retentar não cria o
crédito.** O efeito era um giro em falso que terminava na DLQ de todo jeito, N tentativas mais tarde,
com N vezes mais log.

O corte é entre *"a próxima tentativa pode dar outro resultado"* e *"vai dar exatamente o mesmo"*.
Banco fora dá outro resultado em cinco minutos; uuid malformado não dá outro resultado nunca. E o
lado transiente é o que **não** se pode apagar por engano, pelo motivo da SW-001.

**Executor:** `CLASSES_PERMANENTES` em [`src/consumidor.ts`](../src/consumidor.ts), com quatro casos
em `tests/unit/consumidor.test.ts` — um por classe, incluindo os transientes que **não** devem
apagar.

---

## SW-003 — O loop cede o event loop a cada volta, e `dormir` é injetável

**Decisão.** `rodar()` chama `await dormir(0)` ao fim de cada iteração, e `dormir` entra por
`DepsConsumidor`. O caminho de falha do `receive` espera `BACKOFF_MS = 5000`.

**Por quê.** Um `while` que só faz `await` de promessa **já resolvida** starva os timers do processo.
Sem uma pausa de verdade a cada volta, um `receive` que responde na hora — espera 0, fila local, ou o
caminho de erro — gira sem nunca ceder o event loop, e aí **nem o handler de SIGTERM roda**: o pod
some por `SIGKILL` no fim do grace period, no meio de uma transação. Foi descoberto porque o teste
travou o worker do vitest e o processo morreu por OOM; em produção teria aparecido como "o worker não
para", que é muito mais difícil de ligar à causa.

Com long polling real de 20s a pausa é ruído — é o caso degenerado que ela protege. O backoff no
caminho de erro é o mesmo problema com outro custo: um `receive` que falha rápido, retentado sem
pausa, martela a SQS milhares de vezes por segundo e enche o log. A falha fica mais cara que a causa.

A injeção não é "testabilidade" — é o que permite afirmar o comportamento sem cronômetro.

**Executor:** `DepsConsumidor.dormir` + os casos de backoff e de encerramento em
`tests/unit/consumidor.test.ts`.

---

## SW-004 — O de-para vive num módulo só, e o gravador não conhece a forma do payload

**Decisão.** Toda tradução entre o que trafega na fila e o que vai para as colunas mora em
[`src/normalizar.ts`](../src/normalizar.ts), em funções puras que devolvem **uma forma só**
(`LinhaParaGravar`). [`src/salvar.ts`](../src/salvar.ts) orquestra — ator, transação, idempotência —
e não sabe se o retorno era do pré ou do enriquecimento.

**Por quê.** Nasceu do realinhamento de contrato (D-075): as duas etapas têm **envelopes
diferentes**, e a primeira versão do gravador conhecia o formato do payload em três lugares. Com dois
envelopes, isso viraria seis. Concentrar o de-para num módulo puro fez as duas coisas que importavam:
o gravador ficou com um caminho só, e a tradução — que é onde ficam as decisões chatas, como
`encontrado`→`sucesso`, o `oab_uf` que se parte em dois e o `cod_origem` que se deriva preferindo a
folha à página — ficou num arquivo que se lê inteiro.

O efeito colateral é o que mais paga: quando o contrato do pré mudar (e ele muda fora deste repo, por
D-076), o diff é num arquivo.

**Executor:** [AGENTS.md](../AGENTS.md) + `tests/unit/salvar.test.ts`, que alimenta o gravador com
`LinhaParaGravar` já normalizada — um gravador que voltasse a inspecionar o payload não passaria
naqueles casos.

---

## SW-005 — Teste mora em `tests/unit/`, espelhando `src/`

**Decisão.** Nenhum teste em `src/`. Os testes ficam em `tests/`, a primeira pasta diz a **natureza**
do teste, e dentro dela o caminho espelha `src/`:

```
tests/unit/<nome>.test.ts     → src/<nome>.ts
tests/integration/…           → (ainda não existe; é o slot reservado)
tests/fixtures.ts             → compartilhado, não espelha ninguém
```

**Por quê.** É a **BE-001 adotada**, e adotar é diferente de herdar: aquela decisão governa o
crm-backend, e um repo não manda no outro. Vale a pena porque o custo de descobrir onde um teste mora
é pago em toda leitura, e porque `tests/integration/` reservado tem destinatário concreto aqui — a
verificação de ponta a ponta do REQ-0410 e do REQ-0413 é hoje um roteiro de `bash` + `psql` no campo
`verificar_manual`. O dia em que ela virar código, o lugar já existe e já se sabe que não é unidade.

`tests/fixtures.ts` fica na raiz de `tests/` de propósito: ele não espelha arquivo nenhum de `src/`,
é compartilhado, e — o que mais importa — **lê os `examples` dos próprios schemas do contrato**, para
nunca defasar em relação ao que o worker de extração publica.

**Executor:** o `include` do [`vitest.config.ts`](../vitest.config.ts) + [AGENTS.md](../AGENTS.md).

---

## SW-006 — Cobertura é 100% nas quatro métricas, com uma exclusão só

**Decisão.** Pisos de 100% em `lines`, `functions`, `branches` e `statements`. O denominador exclui
**um** arquivo: `src/index.ts`. `reportOnFailure: true`.

**Por quê.** É a **BE-013 adotada**, e aqui é mais fácil de sustentar: são seis arquivos, e cinco
deles decidem algo que falha calado (quem é o ator, se a mensagem é duplicata, se o erro retenta, se
o `en_status` derivado existe no vocabulário da coluna). Um piso menor deixaria de fora exatamente as
bordas — o `if` que ninguém escreveu teste para.

A exclusão é honesta pelo critério da BE-013: não esconde linha sem teste, é linha que um teste de
unidade **não tem como executar**. `index.ts` lê env, prende SIGTERM/SIGINT e entrega ao loop;
exercitá-lo é integração. Ampliar essa lista para esconder cobertura alcançável exige uma `SW-00N`
revogando esta — piso não desce, teto não vira desculpa.

`reportOnFailure` está lá pelo motivo da BE-013: por default o v8 só emite o relatório (e portanto só
checa o piso) quando a suíte inteira passa. Um teste quebrado não baixaria a cobertura medida — ele a
tornaria **não medida**, e a checagem sairia do ar em silêncio bem no momento em que mais serve.

**Executor:** os `thresholds` do [`vitest.config.ts`](../vitest.config.ts), dentro do
`npm run verify`.

---

## SW-007 — Este serviço não escuta porta, e portanto não tem probe de HTTP

**Decisão.** Sem servidor, sem `EXPOSE`, sem `Service`, sem `Ingress`, sem `readinessProbe`/
`livenessProbe` no chart. O sinal de saúde é o **log estruturado** e a **profundidade da fila**.

**Por quê.** Este worker é *pull*: ninguém o chama. Um `/health` aqui seria um servidor HTTP
inventado só para satisfazer um probe — código novo, superfície de rede nova, e uma resposta `200`
que **não prova o que interessa**. Um processo pode responder `200` alegremente enquanto não consome
nada da fila (foi literalmente o bug da SW-003: o loop girava e o processo estava vivo).

A liveness que importa é *"a fila está sendo drenada"*, e isso não se lê de dentro do pod: lê-se em
`ApproximateAgeOfOldestMessage`. Por isso o alarme é **pré-requisito de infra**, não faxina paralela
— sem ele, este serviço é o único do stack sem detecção de travamento. Está registrado em
[docs/deployment.md](deployment.md) e no REQ-0414.

Consequência aceita: um pod travado só é notado pelo alarme da fila, não pelo kubelet. Trocar isso
por um probe HTTP mentiroso seria pior — a mentira **passa** no CI.

**Executor:** o chart em [`helm/`](../helm/) (não há `service.yaml` nem `ingress.yaml`) + o Dockerfile
(sem `EXPOSE`).

---

## SW-008 — Não há SQL neste repo, e a superfície importada é o mapa `exports`

**Decisão.** `pg` e `crm-backend/database/db` são **proibidos** em `src/`, com uma exceção nominal:
`src/index.ts`, que chama `closePool` no encerramento. Caminhos internos do pacote
(`crm-backend/src/**`, `crm-backend/dist/**`, `crm-backend/modelo/**`) são proibidos sem exceção.

**Por quê.** Duas fronteiras, uma regra.

A primeira: todo o SQL do worker é o `RetornoEnriquecimentoRepository`, no crm-backend, e **aquele
arquivo é o espelho em TypeScript do `GRANT`** (D-068) — três escritas, lista fechada. Quem abrir o
pool aqui e mandar um `query` contorna duas coisas de uma vez: a lista de escritas permitidas e as
quatro GUCs da trilha (D-010), que só são publicadas por `withTransaction`/`comContexto`. **As duas
falham caladas.** `database/transaction` fica de fora da proibição, e a distinção é a mesma que o
crm-backend faz: `withTransaction` não é SQL, é fronteira transacional, e quem sabe que "as consultas
+ os achados + o fechamento da mensagem" é uma unidade atômica é o `salvar.ts`.

A segunda: o mapa `exports` da BE-076 é um **gate** — o que não está nele é da API, não da
biblioteca. O `moduleResolution: Node16` já reprovaria um caminho interno, mas reprova dizendo *"não
encontrado"*, que manda a pessoa caçar um bug de instalação em vez de ler a decisão. A regra existe
pela **mensagem**.

**Executor:** o bloco `no-restricted-imports` do [`eslint.config.mjs`](../eslint.config.mjs), no
`npm run lint` — dentro do `verify`.

---

## SW-009 — O `typecheck` cobre `tests/`; quem compila é o `tsconfig.build.json`

**Decisão.** `tsconfig.json` inclui `src/` **e** `tests/`, e é o que o `typecheck` usa.
`tsconfig.build.json` estende-o com `rootDir: "src"` e exclui `tests/`, e é o que o `build` usa.

**Por quê.** Antes havia um arquivo só, com `include: ["src/**/*.ts"]`, e a consequência é fácil de
não ver: **um erro de tipo dentro de um teste passava pelo `verify` inteiro.** O `tsc --noEmit` nem
olhava o arquivo, e o vitest transpila sem checar tipo. Teste é onde mais se escreve dublê, e dublê é
exatamente onde o tipo errado se esconde — um mock com a assinatura defasada continua "passando"
enquanto a produção já mudou.

O `rootDir` vive no arquivo de build, e não no base, porque é o que mantém a saída em `dist/index.js`
— o que o `main`, o `start` e o `CMD` do Dockerfile apontam. No base, com `tests/` incluído, o
`rootDir` teria de virar `"."` e a saída escorregaria para `dist/src/index.js`; é exatamente a
cicatriz que o Dockerfile do crm-backend documenta ("o `start` está defasado"). Um arquivo a mais
custa menos que essa divergência.

`tsconfig.eslint.json` continua existindo por um terceiro motivo: ele soma os arquivos de
configuração (`eslint.config.mjs`, `vitest.config.ts`), que o typecheck do produto não precisa ver
mas o parser tipado do eslint sim.

**Executor:** `npm run typecheck` e `npm run build`, ambos com `-p` explícito, dentro do `verify`.

---

## SW-010 — A mensagem não é marcada `processando`, e isso é uma pendência registrada, não um default

**Decisão.** O worker **não** chama `abrirMensagem`. A `importacao_credor` vai de `publicado` direto a
`concluido`/`falhou`. O método existe no repository, testado, e deliberadamente não é chamado.

**Por quê.** `en_status='processando'` **não tem quem escreva**, e isso é um buraco no desenho, não no
código. A D-068 lista o valor como *"o worker pegou"*, mas os workers de extração são Python e não
tocam no banco — é a própria BE-074 que decide isso. O save-worker só vê a mensagem **no retorno**,
quando o trabalho já terminou: marcá-la `processando` um milissegundo antes de `concluido` seria
teatro, e pior, **tornaria inútil a janela de 90 minutos** de `resgatar_mensagens_travadas()`, que
pressupõe `processando` durante a *extração*. O resgate passaria a nunca resgatar nada, e a função
continuaria existindo dando a impressão de que resgata.

Escolher em código seria escolher calado. Resolver pede decisão de desenho: ou o extrator publica um
"recebi" na fila de retorno, ou `processando` sai do vocabulário, ou o publisher o carimba junto do
`publicado`.

**Executor:** este registro + o REQ-0410 (campo `nota`, item aberto). Não há comando: é justamente
uma decisão **não** tomada, e mecanizar uma pendência a esconderia.

---

## SW-011 — O contrato é validado em runtime, e a divergência aparece na DLQ

**Decisão.** O payload é validado pelo Ajv contra os JSON Schemas que o pacote `crm-backend` embarca.
Payload fora do contrato é erro **permanente** (SW-002): a mensagem sai da fila com o motivo no log.

**Por quê.** A alternativa — descrever a forma do payload em TypeScript — cria a segunda verdade que
a D-068 existe para impedir, e a divergência seria **silenciosa**: o `INSERT` gravaria dado errado sem
nada reclamar. Compilando o schema publicado, o teste de contrato deste worker vira, de graça, o
alarme de que alguém mudou o schema do outro lado.

**O limite disto tem de ficar escrito, porque chamá-lo de gate seria mentira.** Para o **pré**, a
fonte do contrato **não é o arquivo do backend** — é um artefato publicado ao time de extração
(D-076), e o `.schema.json` é transcrição datada dele. Nenhum CI compara os dois: o artefato é página
autenticada, e o pipeline não a alcança. Então a divergência aparece **em runtime, alta**: mensagem
nova é recusada pelo Ajv e vai para a DLQ com o erro de schema. É detecção real, ao custo de
mensagens rejeitadas — e é a razão pela qual "como uma mudança de contrato é anunciada" é item aberto
do REQ-0413, não detalhe.

**Executor:** `tests/unit/contrato.test.ts` (inclusive o guard de boot, que falha se um schema
embarcado não compilar) + as fixtures, que leem os `examples` do próprio contrato.

---

## SW-012 — Este repo segue o `verify` do crm-backend, e o CI roda **só** ele

**Decisão.** `npm run verify` = `format:check && typecheck && lint && coverage && audit:prod`. O
workflow de CI tem um passo: `npm run verify`. `make ci` é o mesmo comando.

**Por quê.** É o desenho do crm-backend adotado — lá ele não é uma `BE-00x` numerada, vive no
comentário `// verify` do `package.json` e no `AGENTS.md`, e vale a pena repetir aqui com número
porque o motivo é o local-verde/CI-vermelho: se o CI enumerasse os passos, a lista existiria em dois
lugares e divergiria na primeira vez que alguém acrescentasse um. Uma definição, três chamadores
(você, o `make`, o CI).

`verify` chama `coverage` e não `test` porque `test` é vitest **sem** `--coverage` — os pisos da
SW-006 não disparariam em lugar nenhum. O `openapi:check` do backend não tem análogo aqui: este
serviço não publica contrato, consome o de lá.

**Executor:** [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) e o
[`Makefile`](../Makefile), ambos chamando `npm run verify` e mais nada.

---

## SW-013 — Teste vem primeiro, e quem cobra a ordem é um hook

**Data:** 2026-08-12

**Decisão.** Adota a **BE-077** do crm-backend, com as duas metades:

1. **`espelho:check` entra no `verify`.** Todo arquivo de `src/` com código executável tem um teste
   que é DELE, no caminho espelho da SW-005. O gate é
   [`scripts/check-espelho.mjs`](../scripts/check-espelho.mjs).
2. **A ordem é cobrada na hora da escrita.** Um hook `PreToolUse`
   ([`.claude/settings.json`](../.claude/settings.json) → `scripts/hook-precheck-tdd.sh`) **bloqueia**
   escrever em `src/**/*.ts` sem o teste espelho, na criação e na edição. Ele não reimplementa a
   regra: delega ao mesmo `.mjs`. Uma regra, dois chamadores.

A lista de exclusão saiu do `vitest.config.ts` para
[`vitest.coverage-exclude.mjs`](../vitest.coverage-exclude.mjs) pelo mesmo motivo — ela passou a ter
dois leitores, e duas cópias divergiriam.

**Por quê.** Cobertura 100% (SW-006) **não prova que o arquivo tem teste**: prova que alguma linha de
alguma suíte executou aquele código, e *alguma* é a palavra cara. Neste repo o risco não é
hipotético, é a topologia — `consumidor.ts` importa `contrato.ts`, `salvar.ts` importa
`normalizar.ts`. Um módulo novo nesse meio chega a 100% **de carona** no teste de quem o chama, sem
nunca ter existido um vermelho pedindo aquele código. E o próximo módulo tem nome: o `dlq.ts` que
falta no REQ-0410 nasceria exercitado pelo teste do consumidor.

O par é estrutural: o piso pergunta *"esta linha rodou?"*, o espelho pergunta *"alguém escreveu um
teste PARA este arquivo?"*, e o hook pergunta *"o teste existia ANTES?"*. A terceira é a única que um
comando de CI não consegue fazer — quando o `verify` roda, os dois arquivos já estão escritos e a
ordem em que nasceram é informação perdida.

**O que NÃO veio da BE-077, e por quê.** A exceção `src/routes/**` (BE-006 — rota é fiação, testada
dirigindo a API pelo contrato) **não tem análogo**: aqui não há rota e não há porta (SW-007). Copiá-la
abriria um buraco para uma pasta que não existe, e o dia em que alguém criasse `src/routes/` no worker
o gate calaria justamente sobre código novo. **E o hook de migration (BE-014) continua fora**: não há
migration neste repo — o schema em que ele escreve nasce em `crm-backend/modelo/`. É o que o
`REQ-0415` já declarava ao dizer que o `.claude/settings.json` não foi copiado; a objeção era **àquele**
hook, e segue de pé.

Isto **não revoga** a SW-012 (o `verify` ganhou um passo, o CI continua chamando só ele) nem a SW-006
(o piso continua 100%, e a exclusão continua sendo uma só — agora com o custo a mais de ser a porta
dos dois gates).

**Executor:** `npm run espelho:check` dentro do `npm run verify` (portanto no CI e no `make ci`) + o
hook `PreToolUse` de [`.claude/settings.json`](../.claude/settings.json), que sai com `exit 2` e
devolve o caminho do teste que falta.

## SW-014 — O mock do retorno entra pelo contrato e pelo gravador, nunca por `INSERT`

**Data:** 2026-08-18

**Decisão.** [`scripts/mock-retorno.ts`](../scripts/mock-retorno.ts) faz o papel dos workers externos — gera um payload de retorno por mensagem `publicado` — e o empurra pelo **caminho de produção**: `interpretarRetorno` (SW-011) e depois `salvarRetorno`. Nada de SQL próprio. É o par de `crm-backend/scripts/mock-enriquecimento.ts`, que cria as rodadas e as mensagens (BE-149); a fronteira entre os dois é a do papel — **este repo não cria mensagem, e o backend não inventa resultado**.

Três consequências que valem estar escritas:

1. **Só o payload é mock.** A normalização (SW-004), a derivação da D-068, a transação e a trilha com ator são as de verdade. Contrato que mudar no crm-backend quebra o mock junto com o worker — é o mesmo alarme da SW-011, agora disparável sem fila.
2. **Sem SQS.** O corpo vai direto ao `interpretarRetorno`; o transporte é o `consumidor.ts` e exercitá-lo é outro exercício (LocalStack + `make fila`). Mockar dois eixos de uma vez teria confundido falha de contrato com falha de entrega.
3. **Conexão herdada do irmão.** Sem `DATABASE_URL`/`DB_SCHEMA` no ambiente, o script lê as duas do `.env` do `crm-backend` — em dev o banco é o dele, é de lá que sai o schema (BE-014). E `NODE_ENV` entra como `production` quando ausente: o logger do backend só pede `pino-pretty` em `development`, e este repo não tem essa dependência (nem precisa — o worker roda em produção).

Roda como o usuário daquele `.env` (o dono do schema), **não** como o role restrito: a prova por negação do `GRANT` é outra e já existe ([`scripts/provar-grant.sql`](../scripts/provar-grant.sql), REQ-0412). Misturar as duas faria uma falha de permissão parecer erro de mock.

**Por quê não um seed com SQL.** Porque ele grava a forma que o autor do seed imaginou. A tela passaria a exibir afirmação com `en_status`/`en_origem` escolhidos à mão — exatamente o que a D-068 tirou do payload para que ninguém pudesse escolher — e o primeiro bug seria descoberto quando o worker real chegasse com forma diferente. No primeiro uso, em 18/08/2026, o `--seco` reprovou dois payloads antes de qualquer escrita (`nr_registros` `const 0` em score/prospecção; `nr_processo` sem máscara).

**Executor:** `npm run mock:retorno -- --seco`, que valida todo payload contra os contratos publicados e sai 1 se algum não casar. Não entra no `verify` de propósito — é ferramenta de bancada, e o `verify` não tem banco.

---

## SW-015 — O serviço passa a se chamar `crm-worker`, e o nome vale até a role do Postgres

**Data:** 2026-08-27

**Decisão.** `save-worker` virou **`crm-worker`** — diretório do workspace, repositório
(`artell-ai/crm-worker`), `name` do pacote, chart e release Helm, `ECR_REPOSITORY` (`app/crm-worker`),
projeto do compose e o segredo `/crm/<ns>/crm-worker`. O nome antigo dizia o *verbo* ("salva"); o novo
diz de **qual produto** ele é — a pergunta que se faz olhando uma lista de repositórios ou de pods
ao lado de `crm-backend` e `crm-frontend`.

**Três coisas foram renomeadas junto, e nenhuma é cosmética. Todas são baratas HOJE porque o
serviço não tem deploy (REQ-0414, itens 4 e 5 abertos) — depois, cada uma custaria uma migração:**

1. **A role restrita do Postgres: `save_worker` → `crm_worker`** (`scripts/role-dev.sql`,
   `scripts/provar-grant.sql`, `.env.example`, o `externalsecret`). Ela **não nasce de migration** —
   o `GRANT` mínimo da D-068 segue aberto lá e o REQ-0412 é quem cobra a prova. Depois de existir em
   staging, seria `ALTER ROLE` mais rotação de segredo.
2. **Os nove eventos de log: `save_worker_*` → `crm_worker_*`** (`consumidor.ts`, `index.ts`).
   Nenhum painel consulta esses nomes ainda; depois do alarme de profundidade de fila, renomear
   passaria a ser mudança de contrato de observabilidade.
3. **O `cod_requisicao` da trilha: `save-worker:<id_mensagem>` → `crm-worker:<id_mensagem>`**
   (`salvar.ts`). É DADO em `sys_audit_log` — só as linhas de mock em dev carregam o valor velho.

**O que NÃO mudou, de propósito.** SW-001…SW-014 e os registros irmãos (`D-`, `BE-`, `ETL-`) seguem
dizendo `save-worker`: o registro é **append-only**, e reescrever histórico apaga a prova de quando
cada decisão foi tomada. Quem procurar o nome antigo cai aqui.

**Executor:** `grep -rn 'save[-_]worker' src helm scripts .github` sai vazio, e `npm run verify`
prova que o rename não quebrou o pacote — `package.json` e `package-lock.json` andam juntos.

