// O RELÓGIO DO SISTEMA (SW-016 · SW-017) — a segunda entrada de trabalho deste deployable.
//
// A primeira é a fila: alguém publicou uma mensagem. Esta é o calendário: NINGUÉM fez nada durante
// um prazo. As quatro automações por tempo do Deal Ops (REQ-0603 · REQ-0208) são desta natureza —
// não há tela nem requisição onde pendurá-las.
//
// **Aqui não há SQL nem regra**, como em todo este repo (AGENTS.md): uma `Varredura` é injetada, e
// o corpo dela chama a superfície pública do crm-backend. Este arquivo é só o RELÓGIO — quem
// acorda, quando, uma vez só, e o que se registra a cada volta.

import type { QueueOptions, WorkerOptions } from "bullmq";
import { Redis, type RedisOptions } from "ioredis";
import { logger } from "crm-backend/lib/logger";
import type { Config } from "./config";

const log = logger.child({ module: "crm-worker-relogio" });

/**
 * O fuso do domínio. Cron do BullMQ SEM `tz` é interpretado em UTC — "às 9h" viraria "às 6h" no
 * horário de Brasília, e a automação de "2 dias úteis" dispararia antes do dia começar.
 */
export const FUSO = "America/Sao_Paulo";

/**
 * O prefixo das chaves, e a **hash tag é obrigatória**, não estética.
 *
 * O Redis de produção é o ElastiCache Serverless que o crm-backend já usa, e ele é cluster por
 * dentro. Os scripts do BullMQ são multi-key; sem `{...}` as chaves de UMA fila caem em slots
 * diferentes e cada operação falha com `CROSSSLOT`. Local (redis:7-alpine, standalone) funciona dos
 * dois jeitos — ou seja, é o erro que passa no CI e só aparece na AWS. Por isso é constante.
 */
export const PREFIXO = "{crm-worker}";

/** Estável de propósito: o agendamento vive no Redis e sobrevive ao deploy. */
export const NOME_FILA = "relogio";

/**
 * O batimento — a cada 5 minutos, e é CONSTANTE, não configuração.
 *
 * A SW-016 aceitou esta conta: a liveness da SW-007 é a profundidade da fila, e relógio parado não
 * faz fila crescer — ele some sem sinal. Este é o pulso que o alarme de AUSÊNCIA observa
 * (REQ-0414, item 5). Deixá-lo tunável por env seria deixar o alarme e o pulso divergirem.
 */
export const BATIMENTO_CRON = "*/5 * * * *";

/** Um trabalho de relógio: quem é, quando acorda, e o que faz. `executar` devolve quantas virou. */
export interface Varredura {
  id: string;
  cron: string;
  /** Propriedade, não método: é comportamento INJETADO, e não depende de `this`. */
  executar: () => Promise<number>;
}

/** O pulso. Não vira nada de propósito: o valor dele é EXISTIR no log a cada 5 minutos. */
export const batimento: Varredura = {
  id: "batimento",
  cron: BATIMENTO_CRON,
  executar: () => Promise.resolve(0),
};

/** A parte da `Queue` do BullMQ que este módulo usa — estreita para o teste não precisar de Redis. */
export interface FilaLike {
  upsertJobScheduler(
    id: string,
    repeat: { pattern: string; tz: string },
    template: { name: string },
  ): Promise<unknown>;
  getJobSchedulers(): Promise<{ key: string }[]>;
  removeJobScheduler(id: string): Promise<boolean>;
  close(): Promise<void>;
}

/** A parte do `Worker` do BullMQ que este módulo usa. */
export interface TrabalhadorLike {
  close(): Promise<void>;
}

export interface DepsRelogio {
  fila: FilaLike;
  trabalhador(processar: (nome: string) => Promise<void>): TrabalhadorLike;
}

/**
 * As opções da conexão. `maxRetriesPerRequest: null` é EXIGÊNCIA do BullMQ, não preferência: com o
 * default (20) o cliente desiste do comando durante um failover do cache e o job morre em vez de
 * esperar o cache voltar.
 */
export function opcoesConexao(): RedisOptions {
  return { maxRetriesPerRequest: null };
}

/** Só constrói — quem trata `error` é o entrypoint, que é onde o processo decide o que fazer. */
export function criarConexao(config: Config): Redis {
  return new Redis(config.redisUrl, opcoesConexao());
}

// As opções são funções PURAS, e o `new Queue(...)`/`new Worker(...)` fica no entrypoint (SW-006).
// A razão é de teste: construir um `Worker` põe o loop de consumo no ar, então um teste de unidade
// não pode fazê-lo — mas as DECISÕES (o prefixo, a conexão única, a concorrência 1) são justamente o
// que tem de ficar travado por teste, porque errá-las quebra só em produção.

export function opcoesFila(conexao: Redis): QueueOptions {
  return { connection: conexao, prefix: PREFIXO };
}

export function opcoesTrabalhador(conexao: Redis): WorkerOptions {
  return {
    connection: conexao,
    prefix: PREFIXO,
    // Um relógio não sobrepõe voltas: se uma varredura ainda roda, a próxima espera. Concorrência
    // maior aqui faria duas voltas disputarem as mesmas linhas de `tarefa`.
    concurrency: 1,
  };
}

export function criarRelogio(varreduras: Varredura[], deps: DepsRelogio) {
  const porId = new Map(varreduras.map((v) => [v.id, v]));
  let trabalhador: TrabalhadorLike | undefined;

  async function tique(nome: string): Promise<void> {
    const varredura = porId.get(nome);
    if (!varredura) {
      // Agendamento órfão que escapou da limpeza. No-op silencioso faria o BullMQ marcar SUCESSO
      // para trabalho que ninguém fez — a pior das duas saídas.
      throw new Error(`Varredura desconhecida no tique: ${nome}`);
    }
    const comecou = Date.now();
    try {
      const viradas = await varredura.executar();
      log.info(
        { event: "crm_worker_tique", varredura: nome, viradas, duracaoMs: Date.now() - comecou },
        "Tique concluído",
      );
    } catch (err) {
      log.error(
        { event: "crm_worker_tique_falhou", varredura: nome, err, duracaoMs: Date.now() - comecou },
        "Tique falhou",
      );
      throw err;
    }
  }

  return {
    tique,

    async iniciar(): Promise<void> {
      // `upsertJobScheduler` é idempotente PELO id, e o id é o da varredura: reiniciar o pod
      // reescreve o mesmo agendamento em vez de criar um segundo.
      for (const v of varreduras) {
        await deps.fila.upsertJobScheduler(v.id, { pattern: v.cron, tz: FUSO }, { name: v.id });
      }

      // O inverso, que é o que se esquece: agendamento que o Redis guarda e o código não declara
      // mais. Renomear uma varredura deixaria o nome velho disparando para sempre um job que só
      // sabe falhar.
      for (const agendado of await deps.fila.getJobSchedulers()) {
        if (!porId.has(agendado.key)) await deps.fila.removeJobScheduler(agendado.key);
      }

      trabalhador = deps.trabalhador(tique);
      log.info(
        { event: "crm_worker_relogio_iniciado", varreduras: [...porId.keys()], fuso: FUSO },
        "Relógio escutando o calendário",
      );
    },

    async parar(): Promise<void> {
      // A ordem importa: fecha quem consome antes de quem publica. E `parar()` antes de `iniciar()`
      // acontece de verdade — SIGTERM no meio do boot —, então o trabalhador pode não existir.
      await trabalhador?.close();
      await deps.fila.close();
      log.info({ event: "crm_worker_relogio_parado" }, "Relógio parou");
    },
  };
}
