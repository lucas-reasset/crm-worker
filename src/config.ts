// O contrato de ambiente do worker — e ele é PEQUENO de propósito.
//
// O crm-worker importa `crm-backend/database/db`, e isso poderia ter arrastado o contrato de env
// inteiro da API (JWT_SECRET, S3_BUCKET, CORS_ORIGIN…). Não arrasta: o `validateEnv` do backend é
// chamado pelo `server.ts`, não no load do `config`, então importar o pool exige só `DATABASE_URL`
// e `DB_SCHEMA` (verificado, não suposto). O que este arquivo valida é o que ESTE processo precisa.

function obrigatoria(nome: string): string {
  const valor = process.env[nome];
  if (!valor) throw new Error(`Falta a variável de ambiente ${nome}`);
  return valor;
}

function inteiro(nome: string, padrao: number): number {
  const bruto = process.env[nome];
  if (!bruto) return padrao;
  const n = Number.parseInt(bruto, 10);
  if (Number.isNaN(n)) throw new Error(`${nome} tem de ser inteiro, veio "${bruto}"`);
  return n;
}

export interface Config {
  filaUrl: string;
  /**
   * O Redis do relógio (SW-017). **Obrigatória**, e é decisão: sem ela o processo subiria
   * consumindo a fila e não seria o relógio — a falha que a SW-016 nomeou como "some sem sinal",
   * porque relógio parado não faz fila crescer. Aqui ela vira erro de boot.
   *
   * Em AWS é `rediss://` (TLS), o mesmo ElastiCache Serverless que o `crm-backend` já usa
   * (`src/lib/cache/index.ts`) — não há cache novo a provisionar.
   */
  redisUrl: string;
  regiao: string;
  /** Endpoint alternativo — LocalStack em dev. Vazio = a AWS de verdade. */
  endpoint: string | undefined;
  /** Long polling: 20s é o máximo da SQS e o que evita receive vazio em loop apertado. */
  esperaSegundos: number;
  /** Até 10 por receive (limite da SQS). */
  maxMensagens: number;
  /**
   * Quanto tempo a mensagem fica invisível enquanto processamos.
   *
   * ⚠️ Este valor e a janela de `resgatar_mensagens_travadas()` (90 min no banco) TÊM de ser
   * coerentes: se a janela do banco for MENOR que a visibilidade, o Postgres declara `falhou` uma
   * mensagem que ainda está sendo processada — e passam a existir duas verdades sobre o mesmo
   * trabalho. Fixar isto no Terraform é pré-requisito, não faxina paralela (D-068).
   */
  visibilidadeSegundos: number;
}

export function carregarConfig(): Config {
  return {
    filaUrl: obrigatoria("SQS_QUEUE_URL"),
    redisUrl: obrigatoria("REDIS_URL"),
    regiao: process.env.AWS_REGION ?? "us-east-1",
    endpoint: process.env.SQS_ENDPOINT ?? undefined,
    esperaSegundos: inteiro("SQS_WAIT_TIME_SECONDS", 20),
    maxMensagens: inteiro("SQS_MAX_MESSAGES", 10),
    visibilidadeSegundos: inteiro("SQS_VISIBILITY_TIMEOUT", 300),
  };
}
