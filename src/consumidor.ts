import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import { logger } from "crm-backend/lib/logger";
import type { Config } from "./config";
import { ContratoInvalidoError, interpretarRetorno } from "./contrato";
import type { salvarRetorno } from "./salvar";
import { RetornoImprocessavelError } from "./normalizar";

const log = logger.child({ module: "crm-worker" });

export interface Consumidor {
  rodar(): Promise<void>;
  parar(): void;
  /**
   * Um receive→gravar→apagar, exposto de propósito.
   *
   * `rodar()` é um `while` infinito: um teste que o chamasse teria de parar o loop de fora, e
   * "verifiquei que o loop gira" é o que menos importa. O que importa é o que acontece com UMA
   * mensagem — apagou? não apagou? — e é isto que dá para afirmar sem cronômetro.
   */
  cicloUnico(): Promise<number>;
}

export interface DepsConsumidor {
  sqs: Pick<SQSClient, "send">;
  salvar: typeof salvarRetorno;
  /**
   * Injetável para o teste não depender de tempo real.
   *
   * Existe por um motivo menos óbvio que "testabilidade": um `while` que só faz `await` de promessa
   * já resolvida STARVA OS TIMERS do processo. Sem uma pausa de verdade a cada volta, um receive que
   * responde na hora (espera 0, fila local, ou o caminho de erro) faz o loop girar sem nunca ceder o
   * event loop — e aí nem o handler de SIGTERM roda. Com long polling real de 20s a pausa é ruído;
   * é o caso degenerado que ela protege.
   */
  dormir?: (ms: number) => Promise<void>;
}

const dormirDeVerdade = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Espera antes de tentar de novo quando o próprio receive falha (credencial, rede, fila). */
const BACKOFF_MS = 5000;

/**
 * Classes de erro do Postgres que **não melhoram com retentativa**.
 *
 * Descoberto rodando de ponta a ponta: um retorno com `id_credito` que não existe viola a FK, e a
 * classificação ingênua ("não é erro nosso ⇒ transiente") mandava a mensagem de volta para a fila
 * para violar a MESMA FK até esgotar o `maxReceiveCount`. Retentar não cria o crédito.
 *
 * · `22` — data exception (uuid malformado, data inválida, numeric fora de faixa)
 * · `23` — integrity constraint (FK inexistente, CHECK violado, NOT NULL)
 *
 * O que fica FORA é deliberado: falha de conexão (`08`), deadlock (`40P01`), timeout e
 * indisponibilidade são transientes de verdade, e apagar a mensagem ali perderia o retorno de um
 * trabalho já PAGO ao fornecedor.
 */
const CLASSES_PERMANENTES = ["22", "23"];

function ehErroDeDadoDoPostgres(err: unknown): boolean {
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && CLASSES_PERMANENTES.includes(code.slice(0, 2));
}

export function criarSqs(config: Config): SQSClient {
  return new SQSClient({
    region: config.regiao,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
  });
}

/**
 * O loop: recebe, grava, apaga.
 *
 * A ORDEM É A GARANTIA. Apagar só DEPOIS do commit é o que faz a entrega ser at-least-once em vez
 * de at-most-once: se o processo morrer entre o commit e o delete, a mensagem volta e a
 * idempotência do banco (os dois índices únicos do REQ-0409) absorve a repetição. Apagar antes
 * trocaria "grava duas vezes, que o banco resolve" por "perde o retorno", que nada resolve.
 */
export function criarConsumidor(config: Config, deps: DepsConsumidor): Consumidor {
  let ativo = false;
  const dormir = deps.dormir ?? dormirDeVerdade;

  async function processar(mensagem: Message): Promise<void> {
    const corpo = mensagem.Body ?? "";
    const recibo = mensagem.ReceiptHandle;
    const tentativas = Number(mensagem.Attributes?.ApproximateReceiveCount ?? "1");

    try {
      const retorno = interpretarRetorno(corpo);
      const resultado = await deps.salvar(retorno);

      if (resultado.jaProcessada) {
        log.info(
          { event: "crm_worker_entrega_repetida", idMensagem: retorno.id_mensagem, tentativas },
          "Mensagem já estava concluída — entrega repetida da SQS",
        );
      } else {
        log.info(
          { event: "crm_worker_retorno_gravado", ...resultado, tentativas },
          "Retorno gravado",
        );
      }

      await apagar(recibo);
    } catch (err) {
      // DOIS DESFECHOS, e confundi-los é o que faz um worker girar em falso ou perder dado.
      //
      // Erro de FORMA ou de ESTADO (payload fora do contrato, id_mensagem inexistente, fornecedor
      // não semeado, atributo sem derivação) não melhora com retentativa: a mensagem é apagada e o
      // log é o registro. Deixá-la voltar a ocuparia a fila até o maxReceiveCount, N vezes, para
      // falhar igual.
      //
      // Erro TRANSIENTE (banco fora, deadlock, timeout) NÃO apaga: a mensagem volta pela
      // visibilidade e a próxima tentativa pode dar certo. Apagá-la aqui perderia o retorno de um
      // trabalho que já foi PAGO ao fornecedor.
      const permanente =
        err instanceof ContratoInvalidoError ||
        err instanceof RetornoImprocessavelError ||
        ehErroDeDadoDoPostgres(err);

      log.error(
        {
          event: permanente ? "crm_worker_retorno_recusado" : "crm_worker_falha_transiente",
          err,
          tentativas,
          detalhes: err instanceof ContratoInvalidoError ? err.detalhes : undefined,
        },
        permanente ? "Retorno recusado — não retenta" : "Falha transiente — a mensagem volta",
      );

      if (permanente) await apagar(recibo);
    }
  }

  async function apagar(recibo: string | undefined): Promise<void> {
    if (!recibo) return;
    await deps.sqs.send(
      new DeleteMessageCommand({ QueueUrl: config.filaUrl, ReceiptHandle: recibo }),
    );
  }

  async function cicloUnico(): Promise<number> {
    const resposta = await deps.sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: config.filaUrl,
        MaxNumberOfMessages: config.maxMensagens,
        WaitTimeSeconds: config.esperaSegundos,
        VisibilityTimeout: config.visibilidadeSegundos,
        MessageAttributeNames: ["All"],
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    );

    const mensagens = resposta.Messages ?? [];
    // Sequencial, não `Promise.all`: cada mensagem abre uma transação, e dez transações
    // concorrentes no mesmo pool disputariam conexão para ganhar nada — o gargalo é o banco, e a
    // vazão da fila já vem do long polling.
    for (const mensagem of mensagens) await processar(mensagem);
    return mensagens.length;
  }

  return {
    cicloUnico,
    async rodar(): Promise<void> {
      ativo = true;
      log.info(
        { event: "crm_worker_iniciado", fila: config.filaUrl, endpoint: config.endpoint },
        "crm-worker escutando a fila de retorno",
      );
      while (ativo) {
        try {
          await cicloUnico();
          // Cede o event loop a cada volta. Ver o comentário de `dormir`: sem isto, um ciclo que
          // responde na hora vira um `while` que impede timers — inclusive o do encerramento.
          await dormir(0);
        } catch (err) {
          // Falha no próprio receive (credencial, rede, fila inexistente). Não derruba o processo:
          // cair aqui faria o orquestrador reiniciar em loop por uma indisponibilidade momentânea.
          // Mas TAMBÉM não retenta na hora: um receive que falha rápido, retentado sem pausa,
          // martela a SQS milhares de vezes por segundo e enche o log — a falha fica mais cara que
          // a causa. O backoff é o que separa "resiliente" de "loop quente".
          log.error(
            { event: "crm_worker_receive_falhou", err, backoffMs: BACKOFF_MS },
            "Falha ao receber da fila — aguardando antes de tentar de novo",
          );
          await dormir(BACKOFF_MS);
        }
      }
      log.info({ event: "crm_worker_parado" }, "crm-worker parou");
    },
    parar(): void {
      ativo = false;
    },
  };
}
