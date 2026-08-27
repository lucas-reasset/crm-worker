import { beforeEach, describe, expect, it, vi } from "vitest";
import { DeleteMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { criarConsumidor, criarSqs, type DepsConsumidor } from "../../src/consumidor";
import { ContratoInvalidoError } from "../../src/contrato";
import { RetornoImprocessavelError } from "../../src/normalizar";
import type { Config } from "../../src/config";
import { retornoPreDocumento } from "../fixtures";

const config: Config = {
  filaUrl: "http://localhost:4566/000000000000/fila-save",
  redisUrl: "redis://localhost:6379",
  regiao: "us-east-1",
  endpoint: "http://localhost:4566",
  esperaSegundos: 20,
  maxMensagens: 10,
  visibilidadeSegundos: 300,
};

const corpoValido = JSON.stringify(retornoPreDocumento());

function fake(over: Partial<DepsConsumidor> = {}, mensagens: unknown[] = []) {
  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof ReceiveMessageCommand) return { Messages: mensagens };
    return {};
  });
  const deps = {
    sqs: { send },
    salvar: vi.fn().mockResolvedValue({
      idMensagem: "x",
      jaProcessada: false,
      consultasGravadas: 0,
      consultasRepetidas: 0,
      achadosGravados: 0,
      achadosRepetidos: 0,
    }),
    ...over,
  } as unknown as DepsConsumidor;
  return { deps, send };
}

const deletes = (send: ReturnType<typeof vi.fn>) =>
  send.mock.calls.filter(([c]) => c instanceof DeleteMessageCommand);

beforeEach(() => vi.clearAllMocks());

describe("o loop de recebimento", () => {
  it("pede long polling e o ApproximateReceiveCount", async () => {
    const { deps, send } = fake();
    await criarConsumidor(config, deps).cicloUnico();

    const [cmd] = send.mock.calls[0]! as [ReceiveMessageCommand];
    expect(cmd.input.WaitTimeSeconds).toBe(20);
    expect(cmd.input.MaxNumberOfMessages).toBe(10);
    expect(cmd.input.VisibilityTimeout).toBe(300);
    expect(cmd.input.MessageSystemAttributeNames).toContain("ApproximateReceiveCount");
  });

  it("fila vazia devolve 0 e não apaga nada", async () => {
    const { deps, send } = fake();
    expect(await criarConsumidor(config, deps).cicloUnico()).toBe(0);
    expect(deletes(send)).toHaveLength(0);
  });

  it("processa as mensagens em SEQUÊNCIA — cada uma abre uma transação", async () => {
    const ordem: string[] = [];
    const salvar = vi.fn(async () => {
      ordem.push("inicio");
      await new Promise((r) => setTimeout(r, 1));
      ordem.push("fim");
      return { jaProcessada: false } as never;
    });
    const { deps } = fake({ salvar } as Partial<DepsConsumidor>, [
      { Body: corpoValido, ReceiptHandle: "r1" },
      { Body: corpoValido, ReceiptHandle: "r2" },
    ]);

    await criarConsumidor(config, deps).cicloUnico();

    // Concorrente daria inicio,inicio,fim,fim.
    expect(ordem).toEqual(["inicio", "fim", "inicio", "fim"]);
  });
});

describe("apagar é DEPOIS do commit — a garantia at-least-once", () => {
  it("sucesso apaga a mensagem", async () => {
    const { deps, send } = fake({}, [{ Body: corpoValido, ReceiptHandle: "r1" }]);
    await criarConsumidor(config, deps).cicloUnico();

    const [[cmd]] = deletes(send) as [[DeleteMessageCommand]];
    expect(cmd.input.ReceiptHandle).toBe("r1");
    expect(cmd.input.QueueUrl).toBe(config.filaUrl);
  });

  it("entrega repetida de mensagem já concluída também apaga", async () => {
    const salvar = vi.fn().mockResolvedValue({ jaProcessada: true });
    const { deps, send } = fake({ salvar } as Partial<DepsConsumidor>, [
      { Body: corpoValido, ReceiptHandle: "r1" },
    ]);
    await criarConsumidor(config, deps).cicloUnico();
    expect(deletes(send)).toHaveLength(1);
  });

  // Se o processo morre entre o commit e o delete, a mensagem volta — e os dois índices únicos do
  // banco (REQ-0409) absorvem a repetição. Apagar antes trocaria isso por PERDER o retorno.
  it("a ordem é gravar → apagar, nunca o contrário", async () => {
    const eventos: string[] = [];
    const salvar = vi.fn(async () => {
      eventos.push("gravou");
      return { jaProcessada: false } as never;
    });
    const send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof ReceiveMessageCommand)
        return { Messages: [{ Body: corpoValido, ReceiptHandle: "r1" }] };
      eventos.push("apagou");
      return {};
    });
    const deps = { sqs: { send }, salvar } as unknown as DepsConsumidor;

    await criarConsumidor(config, deps).cicloUnico();
    expect(eventos).toEqual(["gravou", "apagou"]);
  });
});

describe("os dois desfechos de erro", () => {
  it("payload fora do contrato: apaga (retentar não conserta forma errada)", async () => {
    const { deps, send } = fake({}, [{ Body: "{nao json", ReceiptHandle: "r1" }]);
    await criarConsumidor(config, deps).cicloUnico();
    expect(deletes(send)).toHaveLength(1);
  });

  it("corpo ausente: não explode, e não tenta apagar sem recibo", async () => {
    const { deps, send } = fake({}, [{ ReceiptHandle: undefined }]);
    await expect(criarConsumidor(config, deps).cicloUnico()).resolves.toBe(1);
    expect(deletes(send)).toHaveLength(0);
  });

  it("erro improcessável do gravador: apaga", async () => {
    const salvar = vi
      .fn()
      .mockRejectedValue(new RetornoImprocessavelError("id_mensagem não existe"));
    const { deps, send } = fake({ salvar } as Partial<DepsConsumidor>, [
      { Body: corpoValido, ReceiptHandle: "r1" },
    ]);
    await criarConsumidor(config, deps).cicloUnico();
    expect(deletes(send)).toHaveLength(1);
  });

  it("erro de contrato lançado pelo gravador: apaga, e loga os detalhes", async () => {
    const salvar = vi.fn().mockRejectedValue(new ContratoInvalidoError("forma", ["/x ruim"]));
    const { deps, send } = fake({ salvar } as Partial<DepsConsumidor>, [
      { Body: corpoValido, ReceiptHandle: "r1" },
    ]);
    await criarConsumidor(config, deps).cicloUnico();
    expect(deletes(send)).toHaveLength(1);
  });

  // Apagar aqui perderia o retorno de um trabalho JÁ PAGO ao fornecedor.
  it("falha TRANSIENTE (banco fora): NÃO apaga — a mensagem volta pela visibilidade", async () => {
    const salvar = vi.fn().mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:5432"));
    const { deps, send } = fake({ salvar } as Partial<DepsConsumidor>, [
      { Body: corpoValido, ReceiptHandle: "r1" },
    ]);
    await criarConsumidor(config, deps).cicloUnico();
    expect(deletes(send)).toHaveLength(0);
  });
});

describe("rodar/parar", () => {
  it("parar() encerra o loop depois do ciclo em curso", async () => {
    const { deps } = fake();
    const consumidor = criarConsumidor(config, { ...deps, dormir: async () => {} });
    const promessa = consumidor.rodar();
    consumidor.parar();
    await expect(promessa).resolves.toBeUndefined();
  });

  // Cair aqui faria o orquestrador reiniciar em loop por uma indisponibilidade momentânea.
  it("falha no próprio receive não derruba o loop, e espera antes de retentar", async () => {
    let chamadas = 0;
    const send = vi.fn(async () => {
      chamadas += 1;
      if (chamadas === 1) throw new Error("credencial inválida");
      return { Messages: [] };
    });
    const esperas: number[] = [];
    const consumidor = criarConsumidor(config, {
      sqs: { send },
      salvar: vi.fn(),
      dormir: async (ms: number) => {
        esperas.push(ms);
        // Para o loop na terceira pausa: sem isto o teste giraria para sempre.
        if (esperas.length >= 3) consumidor.parar();
      },
    } as unknown as DepsConsumidor);

    await consumidor.rodar();

    expect(chamadas).toBeGreaterThan(1);
    // A primeira volta falhou → backoff; as seguintes só cedem o event loop.
    expect(esperas[0]).toBe(5000);
    expect(esperas.slice(1)).not.toContain(5000);
  });

  // O caso degenerado que o `dormir(0)` protege: sem ele, um `while` de promessas resolvidas
  // starva os timers e nem o encerramento acontece.
  it("o loop cede o event loop a cada volta", async () => {
    const { deps } = fake();
    let voltas = 0;
    const consumidor = criarConsumidor(config, {
      ...deps,
      dormir: async () => {
        voltas += 1;
        if (voltas >= 3) consumidor.parar();
      },
    });

    await consumidor.rodar();
    expect(voltas).toBe(3);
  });
});

describe("criarSqs", () => {
  it("usa o endpoint quando declarado (LocalStack em dev)", async () => {
    const cliente = criarSqs(config);
    expect(await cliente.config.endpoint!()).toMatchObject({ hostname: "localhost", port: 4566 });
  });

  it("sem endpoint, resolve o da AWS pela região", async () => {
    const cliente = criarSqs({ ...config, endpoint: undefined });
    expect(await cliente.config.region()).toBe("us-east-1");
  });
});

describe("a pausa de verdade", () => {
  // Sem injetar `dormir`, o consumidor usa o setTimeout real. Este teste existe para essa linha não
  // ficar sem uso nenhum: é ela que roda em produção.
  it("o default é uma espera real, e o loop encerra com ela", async () => {
    const { deps } = fake();
    const consumidor = criarConsumidor({ ...config, esperaSegundos: 0 }, deps);
    const promessa = consumidor.rodar();
    consumidor.parar();
    await expect(promessa).resolves.toBeUndefined();
  });
});

describe("as bordas do que a SQS devolve", () => {
  // Um receive sem a chave `Messages` (a SQS omite quando não há nada) não pode virar TypeError.
  it("resposta SEM a chave Messages conta como fila vazia", async () => {
    const send = vi.fn(async () => ({}));
    const deps = { sqs: { send }, salvar: vi.fn() } as unknown as DepsConsumidor;
    expect(await criarConsumidor(config, deps).cicloUnico()).toBe(0);
  });

  // O ApproximateReceiveCount é o que distingue "falhou uma vez e vai voltar" de "morreu na DLQ".
  it("lê o ApproximateReceiveCount quando a SQS o manda", async () => {
    const salvar = vi.fn().mockResolvedValue({ jaProcessada: false });
    const { deps, send } = fake({ salvar } as Partial<DepsConsumidor>, [
      { Body: corpoValido, ReceiptHandle: "r1", Attributes: { ApproximateReceiveCount: "3" } },
    ]);
    await criarConsumidor(config, deps).cicloUnico();
    expect(deletes(send)).toHaveLength(1);
  });
});

// Descoberto no e2e de 06/08: um retorno com `id_credito` inexistente viola a FK, e classificá-lo
// como transiente mandava a mensagem violar a MESMA FK até esgotar o maxReceiveCount.
describe("erro de DADO do Postgres é permanente, não transiente", () => {
  const comCode = (code: string) => Object.assign(new Error(`pg ${code}`), { code });

  it("violação de FK (23503) e de CHECK (23514) apagam a mensagem", async () => {
    for (const code of ["23503", "23514", "23502", "22P02", "22003"]) {
      vi.clearAllMocks();
      const salvar = vi.fn().mockRejectedValue(comCode(code));
      const { deps, send } = fake({ salvar } as Partial<DepsConsumidor>, [
        { Body: corpoValido, ReceiptHandle: "r1" },
      ]);
      await criarConsumidor(config, deps).cicloUnico();
      expect(deletes(send), code).toHaveLength(1);
    }
  });

  // Apagar aqui perderia o retorno de um trabalho já PAGO ao fornecedor.
  it("conexão caída (08006) e deadlock (40P01) NÃO apagam", async () => {
    for (const code of ["08006", "08003", "40P01", "57014"]) {
      vi.clearAllMocks();
      const salvar = vi.fn().mockRejectedValue(comCode(code));
      const { deps, send } = fake({ salvar } as Partial<DepsConsumidor>, [
        { Body: corpoValido, ReceiptHandle: "r1" },
      ]);
      await criarConsumidor(config, deps).cicloUnico();
      expect(deletes(send), code).toHaveLength(0);
    }
  });

  it("erro sem `code` segue transiente — não se inventa permanência", async () => {
    const salvar = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const { deps, send } = fake({ salvar } as Partial<DepsConsumidor>, [
      { Body: corpoValido, ReceiptHandle: "r1" },
    ]);
    await criarConsumidor(config, deps).cicloUnico();
    expect(deletes(send)).toHaveLength(0);
  });

  it("`code` que não é string não quebra a classificação", async () => {
    const salvar = vi.fn().mockRejectedValue(Object.assign(new Error("x"), { code: 23503 }));
    const { deps, send } = fake({ salvar } as Partial<DepsConsumidor>, [
      { Body: corpoValido, ReceiptHandle: "r1" },
    ]);
    await criarConsumidor(config, deps).cicloUnico();
    expect(deletes(send)).toHaveLength(0);
  });
});
