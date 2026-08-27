import { Queue, Worker, type Job } from "bullmq";
import { closePool } from "crm-backend/database/db";
import { logger } from "crm-backend/lib/logger";
import { carregarConfig } from "./config";
import { criarConsumidor, criarSqs } from "./consumidor";
import {
  NOME_FILA,
  batimento,
  criarConexao,
  criarRelogio,
  opcoesFila,
  opcoesTrabalhador,
} from "./relogio";
import { salvarRetorno } from "./salvar";

const log = logger.child({ module: "crm-worker" });

async function main(): Promise<void> {
  const config = carregarConfig();
  const consumidor = criarConsumidor(config, {
    sqs: criarSqs(config),
    salvar: salvarRetorno,
  });

  // A SEGUNDA ENTRADA DE TRABALHO — o calendário (SW-016/SW-017). O `new Queue`/`new Worker` mora
  // aqui, e não no `relogio.ts`, porque construir um `Worker` põe o loop de consumo no ar: é fiação
  // de entrypoint, e as decisões que importam (prefixo hash-tagged, conexão única, concorrência 1)
  // vêm de `opcoesFila`/`opcoesTrabalhador`, que TÊM teste.
  //
  // A lista de varreduras é a que existe HOJE: só o batimento. As quatro do Deal Ops entram quando
  // o `GRANT` do role alcançar `tarefa`/`negociacao` (REQ-0603 · REQ-0412) — a sonda daquele
  // requisito é quem cobra.
  const conexao = criarConexao(config);
  // Sem este handler, uma queda momentânea do cache derruba o processo por unhandled error. O
  // BullMQ já retenta (`maxRetriesPerRequest: null`); o que falta é não morrer no caminho.
  conexao.on("error", (err: unknown) =>
    log.warn({ event: "crm_worker_redis_erro", err }, "Erro na conexão do relógio"),
  );
  const relogio = criarRelogio([batimento], {
    fila: new Queue(NOME_FILA, opcoesFila(conexao)),
    trabalhador: (processar) =>
      new Worker(NOME_FILA, (job: Job) => processar(job.name), opcoesTrabalhador(conexao)),
  });
  await relogio.iniciar();

  // Encerramento ordenado. O `parar()` só impede o PRÓXIMO receive: a mensagem em curso termina a
  // transação dela. Derrubar no meio deixaria a linha em `processando` e dependeria do resgate
  // (`resgatar_mensagens_travadas`) para voltar a fazer sentido — o resgate é a rede de segurança,
  // não o caminho normal.
  const encerrar = (sinal: string) => {
    log.info({ event: "crm_worker_encerrando", sinal }, "Sinal recebido — encerrando");
    consumidor.parar();
  };
  process.on("SIGTERM", () => encerrar("SIGTERM"));
  process.on("SIGINT", () => encerrar("SIGINT"));

  await consumidor.rodar();
  // O relógio para DEPOIS do laço da fila: fechar a fila do BullMQ antes deixaria um tique em curso
  // sem para onde reportar. Só então o pool e a conexão do cache.
  await relogio.parar();
  await closePool();
  await conexao.quit();
}

void main().catch((err: unknown) => {
  // Falha de BOOT (env faltando, contrato renomeado no crm-backend). Sair com código != 0 é o
  // certo: o orquestrador reinicia, e se a causa persistir o CrashLoopBackOff é justamente o
  // sinal de que alguém precisa olhar — melhor que um processo vivo que não consome nada.
  log.fatal({ event: "crm_worker_boot_falhou", err }, "crm-worker não subiu");
  process.exitCode = 1;
});
