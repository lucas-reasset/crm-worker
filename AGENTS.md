# Duas coisas não nascem aqui: o contrato e o SQL

Este repo é **um consumidor**. As duas coisas que ele parece dever definir, ele importa:

- **O contrato do payload** é o `modelo/contratos/*.schema.json` do crm-backend, que o pacote
  embarca (BE-076) e o Ajv compila em runtime. Nunca reescreva a forma do payload em TypeScript:
  isso cria a segunda verdade que a D-068 existe para impedir, e a divergência é **silenciosa** — o
  `INSERT` grava dado errado sem nada reclamar. Para o **pré**, nem o schema do backend é a fonte: é
  transcrição datada de um artefato (D-076), e a divergência aparece na DLQ, não no CI.
- **O SQL** é o `RetornoEnriquecimentoRepository`, no crm-backend, e aquele arquivo é o **espelho em
  TypeScript do `GRANT`** (D-068): três escritas, lista fechada. Aqui não há SQL em lugar nenhum, e
  o eslint reprova quem importar `pg` ou o pool (SW-008).

Se você está prestes a escrever `query(` ou uma `interface` que descreve o payload, pare: o lugar é
o crm-backend, e o caminho é o `AGENTS.md` de lá.

# O que é

O executor do CRM **fora de requisição** — o que roda sem ninguém clicar. Hoje tem uma entrada
(a fila); a **SW-016 decidiu a segunda**, o relógio do sistema, e ela ainda não existe em código:
quando existir, um tique varre `tarefa.dt_prazo` vencido e aplica a transição (REQ-0603). Ler a
seção acima antes: o relógio também não ganha SQL próprio nem reescreve regra — ele chama a
superfície pública do crm-backend, como o gravador da fila já faz.

A entrada que existe hoje é o consumo da fila de retorno do (pré-)enriquecimento: lê a mensagem na
SQS, escreve **três coisas e nada mais** — uma `enriquecimento_consulta` por consulta (a tentativa e
o custo), uma `pessoa_informacao` por achado (a afirmação), e o fechamento da `importacao_credor` —
tudo num commit só, e apaga da fila **depois** do commit.

O que ele **não** é, porque o modelo mental errado custa caro:

- **Não é um extrator.** É a **ponta de escrita do nosso modelo**. Quem lê documento e chama bureau
  são os workers Python, que **não tocam no banco** (BE-074).
- **Não escreve no canônico.** `pessoa`, `pessoa_fisica`, `advogado`, `cessao`, `telefone`, `email`,
  `endereco`: zero `GRANT`. Promover é do backend, atrás do gate de revisão.
- **Não escuta porta.** É *pull*, não *serve* (SW-007). Não invente um `/health` para agradar um
  probe de k8s.

O desenho está fechado em decisão, não em prosa aqui:
[D-068](../crm-backend/modelo/decisoes.md) (a fila e o que este worker pode escrever) ·
[D-069](../crm-backend/modelo/decisoes.md) (o enriquecimento são três pipelines) ·
[D-075/D-076](../crm-backend/modelo/decisoes.md) (o contrato do pré, e quem o governa) ·
[BE-074](../crm-backend/docs/decisoes.md) e [BE-076](../crm-backend/docs/decisoes.md) (o reuso).
Estado e pendências: [REQ-0410](../produto/requisitos/REQ-0410.yaml).

# Regras que valem em qualquer arquivo

Estas não têm superfície própria — valem no código inteiro, então moram aqui.

- **A trilha tem ator, e a falta dele é calada.** O gatilho de auditoria descobre *quem* por GUC de
  transação (D-010). Escrever fora de `withTransaction`/`comContexto` grava cada linha em
  `sys_audit_log` **sem ator**: o `INSERT` passa, a trilha fica anônima, e ninguém descobre até uma
  auditoria perguntar. Reusar o `db.ts` do backend dá as GUCs de graça — **não dá o ator**. Quem o
  publica é [`salvar.ts`](src/salvar.ts), lendo `importacao_credor.id_usuario_criacao` e chamando
  `runWithContext` + `setActor`.
- **Três colunas do achado não vêm no payload.** `en_origem`, `en_entidade_canonica` e `en_status`
  são derivadas por tabela fixa em
  [`DerivacaoAchado`](../crm-backend/src/models/DerivacaoAchado.ts), no backend, para existirem uma
  vez só. Atributo sem entrada na tabela **lança** — nunca cai num default.
- **ids e dinheiro são `string`.** `numeric` volta do `pg` como string; **não converta para
  number** (o float destrói centavo).
- **Log é evento estruturado** (BE-002, herdado com o `logger`):
  `log.info({ event: "crm_worker_retorno_gravado", … }, "Retorno gravado")` — nunca frase
  concatenada, nunca `console.*` (o eslint reprova).
- **Formato não se discute: `npm run format`** (BE-010). O Prettier manda e `format:check` é o
  primeiro passo do `verify`. Não gaste turno alinhando vírgula.

# Decisões deste projeto: `docs/decisoes.md`

[docs/decisoes.md](docs/decisoes.md) é o registro **append-only** das decisões deste serviço
(`SW-00x`), cada uma com o *porquê*. **Leia antes de mexer no loop ou no gravador.** Contrariar uma
exige **nova entrada revogando a antiga**, nunca exceção calada no código.

São decisões **deste deployable** — o loop, a classificação de erro, o layout de teste, o que se
importa. Modelagem tem registro próprio em
[`crm-backend/modelo/decisoes.md`](../crm-backend/modelo/decisoes.md) (`D-00x`) e **nada aqui
modela**: quando o assunto for tabela, coluna ou enum, o `modelo/` manda e este repo transcreve.
Camada, build e runtime do backend são `BE-00x`.

Este registro **não tem tags**, e a razão é honesta: não existe skill neste repo para cobrar uma.
Cada entrada nomeia o seu executor — uma regra de eslint, um piso de cobertura, um teste, ou uma
linha aqui neste arquivo. Entrada sem executor é bug do registro.

# O teste vem primeiro — e um hook bloqueia se não vier (SW-013)

Escrever ou editar qualquer `src/**/*.ts` cujo **teste espelho** (SW-005) ainda não existe é
**bloqueado** por `scripts/hook-precheck-tdd.sh` (exit 2), na criação e na edição. A ordem é:

```bash
# 1. o teste, no espelho:  src/dlq.ts  →  tests/unit/dlq.test.ts
npm run tdd -- tests/unit/dlq.test.ts   # 2. veja-o FALHAR — vermelho é a prova
# 3. só então o código de src/, até ficar verde
```

Isto não substitui o piso de 100% da SW-006, complementa: cobertura pergunta "esta linha rodou?",
`npm run espelho:check` (dentro do `verify`) pergunta "alguém escreveu um teste **para** este
arquivo?". Aqui a diferença tem endereço — `consumidor.ts` importa `contrato.ts` e `salvar.ts` importa
`normalizar.ts`, então módulo novo chega a 100% **de carona** no teste de quem o chama. Exceção — uma
só: o que está em `vitest.coverage-exclude.mjs` (hoje o entrypoint). A exceção de rotas da BE-006 não
tem análogo aqui: não há rota e não há porta (SW-007).

# Definition of Done

```bash
npm run verify   # format:check + typecheck + lint + espelho + coverage(100%) + audit de produção
```

É o mesmo desenho do crm-backend, menos duas coisas sem análogo aqui: o `openapi:check` (este serviço
não publica contrato, consome o de lá) e o `migracao:check` (não há migration — o schema nasce em
`crm-backend/modelo/`). `npm run verify` é **o único comando que o CI roda**
([.github/workflows/ci.yml](.github/workflows/ci.yml)), então local-verde e CI-vermelho não se
separam. `make ci` é o mesmo.

Cobertura é **100% nas quatro métricas**, com uma exclusão só e ela é honesta: `src/index.ts` é
entrypoint (SW-006). A lista mora em [`vitest.coverage-exclude.mjs`](vitest.coverage-exclude.mjs)
porque tem dois leitores — o vitest e o gate de espelho —, então tirar um arquivo dela o tira dos
**dois** gates. Teste mora em `tests/unit/`, espelhando `src/` (SW-005).

Setup local, a dependência git do crm-backend e as armadilhas de operação estão no
[README.md](README.md). O que a infra precisa ter antes de existir deploy está em
[docs/deployment.md](docs/deployment.md).
