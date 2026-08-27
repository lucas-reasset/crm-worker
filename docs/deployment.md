# Deploy do crm-worker

> **Estado em 12/08/2026: este serviço NÃO está deployado.** O chart e os dois workflows existem e
> estão escritos; o que falta é infra, e está listado abaixo. O rastreio de estado é o
> [REQ-0414](../../produto/requisitos/REQ-0414.yaml) — este documento explica o *porquê* de cada item,
> o requisito é quem diz se está feito.
>
> **O que mudou em 12/08:** o repositório passou a existir (`artell-ai/crm-worker`, privado) e o
> código foi enviado nas três branches, então **o CI deixou de ser um arquivo que nunca executa** — e
> a primeira execução já disse o que falta. A tag `v0.2.0` do crm-backend também existe. O que continua
> faltando, agora com prova de CI, é o **secret** da §2, e depois dele o Terraform da §3/§4.

O caminho é o mesmo do crm-backend: push em `development` builda, sobe pro ECR e faz `helm upgrade`
no cluster de development; produção é `workflow_dispatch` manual com a ref em `main`. Ver
[.github/workflows/deploy.yml](../.github/workflows/deploy.yml) e
[crm-backend/docs/deployment.md](../../crm-backend/docs/deployment.md) para a parte comum (promoção
por PR, o ruleset do org, o OIDC).

O que segue é **só o que difere**, e cada item difere por um motivo.

---

## 0. O `REDIS_URL` do relógio — e a boa notícia é que ele já existe

O relógio (SW-016/SW-017) agenda no **ElastiCache Serverless compartilhado da plataforma**, o mesmo
cache que o `crm-backend` já usa. **Não há provisionamento novo**: o endpoint está em
`helm/values-development.yaml` e `values-production.yaml`, como env não-sensível (é endpoint, não
credencial), exatamente como no chart de lá.

Dois detalhes que só quebram em produção, e por isso estão travados em constante com teste
(`src/relogio.ts`): as chaves vivem sob o prefixo **`{crm-worker}`** — a hash tag é obrigatória
porque o Serverless é cluster por dentro e os scripts do BullMQ são multi-key (sem ela, `CROSSSLOT`);
e a conexão usa `maxRetriesPerRequest: null`, que o BullMQ exige para o job esperar um failover em vez
de morrer.

⚠️ **O alarme de AUSÊNCIA de tique é pré-requisito, e é o item 5 do REQ-0414 crescendo.** A liveness
da SW-007 é a profundidade da fila; relógio parado **não faz fila crescer**. O pulso existe
(`crm_worker_tique`, a cada 5 min, constante para o alarme não divergir do pulso) — falta observá-lo.

---

## 1. ⛔ A `DATABASE_URL` tem de ser a do role restrito

É o item mais importante deste deploy, e o único que, se for feito errado, **passa nos testes e
mente**.

A D-068 promete que "o canônico só recebe o validado". Essa promessa é um `GRANT`, não uma
convenção: o worker tem `INSERT` em `enriquecimento_consulta` e `pessoa_informacao`, `UPDATE` em
**quatro colunas** de `importacao_credor`, `SELECT` no que resolve, e **zero** privilégio em
`pessoa`, `pessoa_fisica`, `advogado`, `cessao`, `telefone`, `email`, `endereco`. O espelho disso em
TypeScript é o `RetornoEnriquecimentoRepository`, no crm-backend.

Se o segredo `/crm/<ns>/crm-worker` carregar a URL do dono do schema, o código continua escrevendo
só as três coisas — mas **por disciplina, não por impedimento**. O dia em que alguém acrescentar uma
escrita "só para resolver rápido", nada barra.

Onde o role de produção nasce (migration ou Terraform) é decisão aberta:
[REQ-0412](../../produto/requisitos/REQ-0412.yaml). Existe um role de **dev** aplicado e provado por
negação — [`scripts/role-dev.sql`](../scripts/role-dev.sql) e
[`scripts/provar-grant.sql`](../scripts/provar-grant.sql) —, e ele é o rascunho do de produção, não o
de produção.

## 2. ⛔ O build precisa de credencial de leitura do crm-backend

A dependência é **git, pinada por tag** (BE-076), e o repositório é privado. O `prepare` do
crm-backend compila o `dist/` durante o `npm ci`, então **o build não roda sem clonar o repo**.

- **Secret necessário:** `CRM_BACKEND_READ_TOKEN`, com leitura em `artell-ai/crm-backend`. Token de
  GitHub App ou PAT fine-grained.
- **O `GITHUB_TOKEN` do job não serve** — ele é escopado ao repositório do workflow.
- No `ci.yml` ele entra como `url.<...>.insteadOf`; no `deploy.yml`, como **build secret**
  (`--secret id=gh_token`), nunca `--build-arg` (ARG fica no histórico da imagem).
- O `Dockerfile` apaga o `~/.gitconfig` **no mesmo `RUN`**. Sem isso o token viajaria no cache de
  registry do estágio `deps` (`--cache-to`), que é legível por quem lê o ECR.
- Localmente o caminho é outro e não precisa de token: `--ssh default` (o `docker-compose.yml` já
  passa).

✅ **A tag já existe** desde 12/08/2026 — `v0.2.0`, anotada, na ponta de `origin/development`
(`e7bd562`), que é onde a BE-076 está; a `main` ainda não a tem. `npm install`, `npm ci` e o
`npm ci --dry-run` resolvem por ela, verificados no mesmo dia.

⛔ **O secret continua sendo o bloqueio, e agora há prova dele.** O primeiro push (12/08/2026) rodou o
CI de verdade nas três branches: `gitleaks` **passou** e os três `ci` **falharam no passo de
credencial**, com a mensagem que o próprio workflow escreve — *"secret CRM_BACKEND_READ_TOKEN
ausente"*. Isso é o desenho funcionando: ele falha alto e nomeia o que falta, em vez de morrer num
`npm ci` com *"Repository not found"*. Para destravar:

```bash
gh secret set CRM_BACKEND_READ_TOKEN --repo artell-ai/crm-worker   # cola o PAT fine-grained
gh run rerun --repo artell-ai/crm-worker --failed
```

Mintar o token é ato humano: PAT fine-grained com **Contents: Read** em `artell-ai/crm-backend`, ou um
token de GitHub App. Não use um token de usuário de escopo amplo (o do `gh auth`, por exemplo) — ele dá
escrita em tudo o que a pessoa alcança e rotaciona sem avisar.

## 3. ⛔ Fila, DLQ e o `VisibilityTimeout` — no Terraform

O worker não cria fila; ele consome uma. Precisa existir, com três coisas fixadas:

| Atributo | Valor | Por quê |
|---|---|---|
| `VisibilityTimeout` | **300 s** | Tem de ser **menor** que a janela de `resgatar_mensagens_travadas(90)`. Janela menor que a visibilidade faz o Postgres declarar `falhou` uma mensagem que o worker ainda está processando — e passam a existir duas verdades sobre o mesmo trabalho. |
| `RedrivePolicy` | DLQ, `maxReceiveCount: 5` | É onde os erros permanentes pousam. |
| DLQ | `fila-save-dlq` | **Não tem consumidor** (ver §6). |

O `docker-compose.yml` deste repo cria as duas com esses valores — use-o como referência do que o
Terraform deve produzir.

## 4. ⛔ ServiceAccount com IRSA

O chart **referencia** a ServiceAccount `crm-worker`, nunca a cria (mesmo desenho do chart da API).
Ela nasce no Terraform (`modules/aws/kubernetes/service`, repo Infraestrutura) com a annotation IRSA,
e a policy precisa de:

```
sqs:ReceiveMessage
sqs:DeleteMessage
sqs:GetQueueAttributes
```

**na fila de retorno.** Não precisa de `sqs:SendMessage` — quem publica é o crm-backend. Não precisa
de S3 nem de KMS de aplicação.

## 5. ⛔ Repositório ECR

`app/crm-worker`, no mesmo registry do `app/crm-api`.

## 6. ⚠️ Duas coisas que ficam faltando mesmo depois do deploy

Não são pré-requisitos — são buracos conhecidos, e é melhor deployar sabendo deles do que descobrir
depois.

**Não há detecção de travamento pelo kubelet.** Este chart não tem `livenessProbe`, e isso é decisão
(SW-007): o processo não escuta porta, e um `/health` inventado responderia `200` com o loop travado
— foi literalmente o bug da SW-003. A liveness real é `ApproximateAgeOfOldestMessage` da fila, e
**o alarme não existe**. Enquanto não existir, este é o único serviço do stack cujo travamento
ninguém percebe até alguém perguntar por que um enriquecimento não voltou.

**Não há consumidor da DLQ.** `en_status='dlq'` só pode ser escrito por ele — o contrato diz
explicitamente que `dlq` não vem no payload do retorno. Então uma mensagem que esgota o
`maxReceiveCount` sai da fila principal e a `importacao_credor` **fica em `publicado` para sempre**,
sem ninguém sabendo que ela morreu.

## 7. O que este deploy NÃO precisa

Vale escrever porque a comparação com o chart da API sugere o contrário:

- **`Service` e `Ingress`** — não há porta (SW-007).
- **Probes de HTTP** — idem.
- **Redis** — não há cache. O worker não lê permissão.
- **`CORS_ORIGIN`, `JWT_SECRET`, cookie de sessão** — não emite sessão nem atende browser.
- **S3** — não guarda arquivo.
- **Nó on-demand** — o chart pede **spot**, e isso inverte a escolha do chart da API de propósito:
  preempção manda `SIGTERM`, o loop termina o ciclo e sai, a mensagem a meio caminho volta pela
  visibilidade e a idempotência absorve (SW-001). Pagar on-demand seria pagar para não usar a
  garantia que já se construiu.
