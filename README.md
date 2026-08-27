# crm-worker

Consome o **retorno** do (pré-)enriquecimento na SQS e o grava no Postgres do CRM. É a **ponta de
escrita do nosso modelo** — não é um extrator.

```
                 ┌──────── 1 lote = 1 `importacao` ────────┐
crm-backend ─────┤  N mensagens, 1 por credor              ├────► SQS ────► worker de extração
   │             └─────────────────────────────────────────┘         (Python, NÃO toca no banco)
   │  grava `importacao` + N × `importacao_credor` (a mensagem)                │
   │                                                                          ▼
   └──── Postgres ◄──── ESTE SERVIÇO ◄──── SQS ◄──── retorno (consultas[] → achados[])
```

Por mensagem, ele escreve **três coisas e nada mais**: uma `enriquecimento_consulta` por
`consultas[]` (a tentativa e o custo), uma `pessoa_informacao` por `achados[]` (a afirmação), e o
fechamento da `importacao_credor` (`en_status='concluido'` + `dt_conclusao`), tudo num commit só.

**O doc que governa este repo é o [AGENTS.md](AGENTS.md)** — leia-o antes de escrever código; este
README é o setup e a operação.

**O desenho está fechado em decisão, não em prosa.** As deste serviço estão em
[docs/decisoes.md](docs/decisoes.md) (`SW-00x`, append-only). As que vêm de fora e mandam aqui:
[D-068](../crm-backend/modelo/decisoes.md) (a fila, o que este worker pode escrever) ·
[D-069](../crm-backend/modelo/decisoes.md) (o enriquecimento são três pipelines) ·
[D-075/D-076](../crm-backend/modelo/decisoes.md) (o contrato do pré, e quem o governa) ·
[BE-074](../crm-backend/docs/decisoes.md) (por que TypeScript reusando o backend) ·
[BE-076](../crm-backend/docs/decisoes.md) (como o reuso funciona) ·
[contratos/](../crm-backend/modelo/contratos/) (o que trafega). Estado e pendências:
[REQ-0410](../produto/requisitos/REQ-0410.yaml). O que a infra precisa ter antes de existir deploy:
[docs/deployment.md](docs/deployment.md).

## As quatro coisas que este serviço existe para não errar

**1. A trilha tem ator.** O gatilho de auditoria descobre *quem* por GUC de transação (D-010). Quem
não as publica grava cada linha em `sys_audit_log` **sem ator** — o `INSERT` passa, a trilha fica
anônima, e ninguém descobre até uma auditoria perguntar. Reusar o `db.ts` do backend dá as GUCs de
graça; saber *quem* é trabalho explícito, e é [`salvar.ts`](src/salvar.ts) lendo
`importacao_credor.id_usuario_criacao` e publicando com `runWithContext` + `setActor`.

**2. O extrator não escolhe `en_status`.** Três colunas do inbox — `en_origem`,
`en_entidade_canonica` e `en_status` — **não vêm no payload**: são derivadas por tabela fixa em
[`DerivacaoAchado`](../crm-backend/src/models/DerivacaoAchado.ts), no crm-backend, para existirem uma
vez só. Se o extrator pudesse mandar `en_status`, um dia mandaria `validado` e o canônico receberia
dado não validado. Não podendo, o gate é estrutural. Atributo sem entrada na tabela **lança** — nunca
cai num default.

**3. Reprocessar não duplica nem cobra de novo.** A SQS é *at-least-once* e o enriquecimento de
contato chama quatro fornecedores **pagos** sem early-exit: mensagem duplicada seria quatro cobranças
repetidas. A trava é no banco (dois índices únicos, REQ-0409) e o worker trata a violação como *"já
processei"*. Mensagem já `concluido` sai sem escrever nada.

**4. Apagar é DEPOIS do commit.** Se o processo morrer entre o commit e o delete, a mensagem volta e
a idempotência absorve. Apagar antes trocaria *"grava duas vezes, que o banco resolve"* por *"perde o
retorno de um trabalho já pago"*.

## Não escreve no canônico, e isso é permissão — não convenção

`INSERT` em `enriquecimento_consulta` e `pessoa_informacao`, `UPDATE` em quatro colunas de
`importacao_credor`, `SELECT` no que resolve. **Zero `GRANT`** em `pessoa`, `pessoa_fisica`,
`advogado`, `cessao`, `telefone`, `email`, `endereco`. O copy-up continua sendo do backend, atrás do
gate de revisão. O espelho disso em código é
[`RetornoEnriquecimentoRepository`](../crm-backend/src/repositories/RetornoEnriquecimentoRepository.ts).

> ⛔ **O role restrito ainda NÃO EXISTE em produção.** Enquanto a `DATABASE_URL` de lá não for a
> dele, a regra acima é papel: o worker teria permissão de escrever onde não deve. Onde o role nasce
> (migration ou Terraform) é decisão aberta — ver o [REQ-0412](../produto/requisitos/REQ-0412.yaml) e
> [docs/deployment.md §1](docs/deployment.md). Em dev, `scripts/role-dev.sql` cria um `crm_worker`
> local, e `scripts/provar-grant.sql` prova o `GRANT` **por negação** (cada tentativa proibida num
> `SAVEPOINT` próprio — sem isso a primeira negativa aborta a transação e as demais só ecoam
> "current transaction is aborted", o que parece prova e não é).

## Rodar local

Duas maneiras. **Com Docker** o LocalStack e a fila (com DLQ e redrive) vêm de graça:

```bash
cd ../crm-backend && docker compose up -d      # o BANCO é de lá — este compose não o sobe
cd ../crm-worker && docker compose up --build  # LocalStack + fila-save + fila-save-dlq + o worker
```

O build precisa do seu agente SSH (`ssh-add -l` não pode estar vazio) — a dependência `crm-backend` é
git privada. Sem ele o build falha em *"Repository not found"*.

⚠️ **O `docker-compose` do `crm-backend` tem de estar de pé**, e agora por dois motivos: o Postgres
(sempre foi) e o **Redis**, que é onde o relógio agenda (SW-017). Sem `REDIS_URL` o processo não sobe
— de propósito: um worker que consome a fila mas não é o relógio sumiria sem sinal.

**Sem Docker:**

```bash
cp .env.example .env          # ajuste DATABASE_URL / SQS_QUEUE_URL / REDIS_URL
npm install                   # ⚠️ ver "a dependência do crm-backend", abaixo
npm run dev                   # tsx watch
npm run tdd                   # o loop vermelho→verde (SW-013); aceita -- <arquivo de teste>
npm run verify                # DoD: format + typecheck + lint + espelho + coverage(100%) + audit
make fila                     # cria a fila no LocalStack
```

⚠️ **O teste vem primeiro, e um hook cobra** (SW-013): escrever ou editar `src/**/*.ts` sem o teste
espelho é bloqueado com `exit 2`. A ordem é teste → vermelho no `npm run tdd` → código.

Pré-requisito: o Postgres do CRM com a migration `202608060001_fila_de_enriquecimento` aplicada — sem
ela não há onde escrever. `make help` lista os alvos (são os mesmos nomes do crm-backend).

### A dependência do crm-backend

`package.json` declara `crm-backend` como **dependência git pinada por tag**
(`github:artell-ai/crm-backend#v0.2.0`, BE-076). O pin é o que faz o deploy deste worker ser um
evento: sem ele, um merge no backend mudaria o comportamento daqui **sem ninguém deployar nada**.

**A tag existe desde 12/08/2026**, cortada da ponta de `origin/development` (`e7bd562`) — a `main`
ainda não tem a BE-076. `npm install` e `npm ci` resolvem por ela, e o `prepare` do backend compila o
`dist/` durante o install: não é preciso buildar o repo irmão à mão.

⚠️ **A armadilha do SSH, que custa meia hora se você não a conhece.** O npm resolve a dependência por
`ssh://git@github.com/artell-ai/crm-backend.git`, e um `insteadOf` que cubra só a forma
`git@github.com:` **não casa com essa** — o clone sai pela chave pessoal, que não tem acesso à org, e
a mensagem é *"ERROR: Repository not found"*, que parece nome errado de repositório. Se o seu
`~/.ssh/config` tem um host alias para a org, cubra as **duas** formas:

```bash
git config --global url."ssh://git@github-artell/".insteadOf "ssh://git@github.com/"
```

No CI o caminho é outro e já está no `ci.yml`: `insteadOf` para HTTPS com o token
`CRM_BACKEND_READ_TOKEN` (o `GITHUB_TOKEN` do job **não serve** — é escopado ao repositório do
workflow).

Para desenvolver contra o repo irmão **ao vivo**, sem sujar o `package.json`:

```bash
npm i --no-save ../crm-backend
```

Isso troca a dependência resolvida por um symlink — as mudanças de lá valem na hora, mas o `dist/`
passa a ser o do repo irmão, então requer `npm run build` no crm-backend. E é o modo que **reescreve
o `package-lock.json`** (grava `file:../crm-backend` mesmo com `--no-save`): o lock versionado é o da
instalação real, então descarte essa mudança antes de commitar.

## Estrutura

| Arquivo | O que faz |
|---|---|
| [`src/index.ts`](src/index.ts) | Entrypoint: env, SIGTERM, entrega ao loop |
| [`src/config.ts`](src/config.ts) | O contrato de ambiente — pequeno de propósito |
| [`src/contrato.ts`](src/contrato.ts) | Valida o payload contra os **JSON Schemas publicados** do crm-backend, via Ajv |
| [`src/normalizar.ts`](src/normalizar.ts) | O de-para inteiro, em funções puras: fio → colunas (SW-004) |
| [`src/salvar.ts`](src/salvar.ts) | O gravador: ator, transação, idempotência |
| [`src/consumidor.ts`](src/consumidor.ts) | O loop receive → gravar → apagar |

Teste espelha `src/` em `tests/unit/`, e `tests/integration/` é o slot reservado (SW-005). Governança
e configuração:

| Arquivo | O que é |
|---|---|
| [`AGENTS.md`](AGENTS.md) | **O doc que governa este repo** (`CLAUDE.md` é uma linha só apontando pra ele) |
| [`docs/decisoes.md`](docs/decisoes.md) | As decisões deste serviço (`SW-00x`), append-only, com o *porquê* |
| [`docs/deployment.md`](docs/deployment.md) | O que a infra precisa ter antes de existir deploy |
| [`helm/`](helm/) | O chart — **sem `Service`, sem `Ingress`, sem probe** (SW-007), em nó spot |
| [`Makefile`](Makefile) | Mesmos alvos do crm-backend; `make ci` == `npm run verify` |
| [`scripts/check-espelho.mjs`](scripts/check-espelho.mjs) | O gate de teste-primeiro (SW-013) — roda no `verify` e no hook |
| [`.claude/settings.json`](.claude/settings.json) | Um hook só: `PreToolUse` → `scripts/hook-precheck-tdd.sh` |
| [`vitest.coverage-exclude.mjs`](vitest.coverage-exclude.mjs) | A exclusão de cobertura — lida pelo vitest **e** pelo gate |

A validação não reimplementa a forma do payload: ela compila os
[`modelo/contratos/*.schema.json`](../crm-backend/modelo/contratos/) que o pacote embarca. Uma cópia
manual da forma criaria a segunda verdade que a D-068 existe para impedir — e a divergência seria
**silenciosa**, com o `INSERT` gravando dado errado sem nada reclamar.

## Duas armadilhas de operação

**A janela do resgate tem de exceder o `VisibilityTimeout`.** `resgatar_mensagens_travadas(90)` no
banco declara `falhou` a mensagem presa em `processando` além da janela. Se a janela for **menor**
que a visibilidade da fila, o Postgres condena uma mensagem que o worker ainda está processando — e
passam a existir duas verdades sobre o mesmo trabalho. Fixar o timeout no Terraform é pré-requisito,
não faxina paralela.

**`achados` vazio deixou de significar "não achou"** (D-069). `sucesso` + `contato` + vazio é bug;
`sucesso` + `score`/`prospeccao` + vazio é o **esperado** — as duas capturas cruas custam e não geram
afirmação nenhuma. Um alerta que trate vazio como falha vai gritar todo dia sem motivo.
