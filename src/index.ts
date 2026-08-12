import { closePool } from "crm-backend/database/db";
import { logger } from "crm-backend/lib/logger";
import { carregarConfig } from "./config";
import { criarConsumidor, criarSqs } from "./consumidor";
import { salvarRetorno } from "./salvar";

const log = logger.child({ module: "save-worker" });

async function main(): Promise<void> {
  const config = carregarConfig();
  const consumidor = criarConsumidor(config, {
    sqs: criarSqs(config),
    salvar: salvarRetorno,
  });

  // Encerramento ordenado. O `parar()` só impede o PRÓXIMO receive: a mensagem em curso termina a
  // transação dela. Derrubar no meio deixaria a linha em `processando` e dependeria do resgate
  // (`resgatar_mensagens_travadas`) para voltar a fazer sentido — o resgate é a rede de segurança,
  // não o caminho normal.
  const encerrar = (sinal: string) => {
    log.info({ event: "save_worker_encerrando", sinal }, "Sinal recebido — encerrando");
    consumidor.parar();
  };
  process.on("SIGTERM", () => encerrar("SIGTERM"));
  process.on("SIGINT", () => encerrar("SIGINT"));

  await consumidor.rodar();
  await closePool();
}

void main().catch((err: unknown) => {
  // Falha de BOOT (env faltando, contrato renomeado no crm-backend). Sair com código != 0 é o
  // certo: o orquestrador reinicia, e se a causa persistir o CrashLoopBackOff é justamente o
  // sinal de que alguém precisa olhar — melhor que um processo vivo que não consome nada.
  log.fatal({ event: "save_worker_boot_falhou", err }, "save-worker não subiu");
  process.exitCode = 1;
});
