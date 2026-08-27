import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BATIMENTO_CRON,
  FUSO,
  NOME_FILA,
  PREFIXO,
  batimento,
  criarConexao,
  criarRelogio,
  opcoesConexao,
  opcoesFila,
  opcoesTrabalhador,
  type FilaLike,
  type TrabalhadorLike,
  type Varredura,
} from "../../src/relogio";

function filaFalsa(agendadosNoRedis: { key: string }[] = []): FilaLike & {
  upserts: { id: string; pattern: string; tz: string; name: string }[];
  removidos: string[];
  fechada: boolean;
} {
  const upserts: { id: string; pattern: string; tz: string; name: string }[] = [];
  const removidos: string[] = [];
  return {
    upserts,
    removidos,
    fechada: false,
    async upsertJobScheduler(id, repeat, template) {
      upserts.push({ id, pattern: repeat.pattern, tz: repeat.tz, name: template.name });
    },
    async getJobSchedulers() {
      return agendadosNoRedis;
    },
    async removeJobScheduler(id) {
      removidos.push(id);
      return true;
    },
    async close() {
      this.fechada = true;
    },
  };
}

function varredura(id: string, cron = "0 9 * * *", viradas = 0): Varredura {
  return { id, cron, executar: vi.fn(async () => viradas) };
}

let fila: ReturnType<typeof filaFalsa>;
let trabalhador: TrabalhadorLike & { fechado: boolean };
let processador: ((nome: string) => Promise<void>) | undefined;

beforeEach(() => {
  fila = filaFalsa();
  trabalhador = {
    fechado: false,
    async close() {
      this.fechado = true;
    },
  };
  processador = undefined;
});

const deps = () => ({
  fila,
  trabalhador: (p: (nome: string) => Promise<void>) => {
    processador = p;
    return trabalhador;
  },
});

describe("constantes do relógio", () => {
  // O ElastiCache Serverless é cluster por dentro. Sem hash tag as chaves de UMA fila caem em
  // slots diferentes e os scripts multi-key do BullMQ falham com CROSSSLOT — em AWS, não aqui.
  // É o erro que passa no CI e quebra em produção, então o prefixo é constante, não configuração.
  it("o prefixo é hash-tagged, senão o BullMQ quebra com CROSSSLOT no Redis em cluster", () => {
    expect(PREFIXO).toMatch(/^\{.+\}$/);
  });

  it("o fuso é o do domínio — cron sem tz vira UTC e 'às 9h' vira 'às 6h'", () => {
    expect(FUSO).toBe("America/Sao_Paulo");
  });

  // BullMQ exige maxRetriesPerRequest: null; com o default (20) o cliente desiste do comando
  // durante um failover e o job morre em vez de esperar.
  it("a conexão desliga o limite de retentativa por comando, como o BullMQ exige", () => {
    expect(opcoesConexao().maxRetriesPerRequest).toBeNull();
  });

  // O prefixo tem de chegar na fila E no trabalhador. Passar só num dos dois é pior que não passar
  // em nenhum: as chaves ficam em dois espaços de nome e o trabalhador não vê o que a fila agendou.
  it("o prefixo hash-tagged vai para a fila E para o trabalhador", () => {
    const conexao = { fake: true } as never;
    expect(opcoesFila(conexao).prefix).toBe(PREFIXO);
    expect(opcoesTrabalhador(conexao).prefix).toBe(PREFIXO);
  });

  it("as duas pontas usam a MESMA conexão — uma segunda dobraria o custo no cache", () => {
    const conexao = { fake: true } as never;
    expect(opcoesFila(conexao).connection).toBe(conexao);
    expect(opcoesTrabalhador(conexao).connection).toBe(conexao);
  });

  // Relógio não sobrepõe voltas: duas execuções da mesma varredura disputariam as mesmas linhas.
  it("o trabalhador roda uma volta por vez", () => {
    expect(opcoesTrabalhador({} as never).concurrency).toBe(1);
  });

  it("criarConexao usa a URL do config", () => {
    const conexao = criarConexao({ redisUrl: "redis://127.0.0.1:6399" } as never);
    conexao.on("error", () => undefined);
    expect(conexao.options.maxRetriesPerRequest).toBeNull();
    conexao.disconnect();
  });
});

describe("o batimento", () => {
  // A SW-016 aceitou a conta: relógio parado NÃO faz fila crescer, então a liveness da SW-007
  // (profundidade da SQS) não o cobre. O batimento é o que o alarme de ausência observa.
  it("é uma varredura como qualquer outra, e não vira nada", async () => {
    expect(batimento.id).toBe("batimento");
    expect(batimento.cron).toBe(BATIMENTO_CRON);
    await expect(batimento.executar()).resolves.toBe(0);
  });
});

describe("criarRelogio · iniciar", () => {
  it("registra um agendamento por varredura, com o cron dela e o fuso do domínio", async () => {
    await criarRelogio(
      [varredura("a", "*/5 * * * *"), varredura("b", "0 9 * * *")],
      deps(),
    ).iniciar();

    expect(fila.upserts).toEqual([
      { id: "a", pattern: "*/5 * * * *", tz: FUSO, name: "a" },
      { id: "b", pattern: "0 9 * * *", tz: FUSO, name: "b" },
    ]);
  });

  // upsertJobScheduler é idempotente PELO id. Passar um id estável é o que faz reiniciar o pod não
  // duplicar o agendamento — que é o modo de falha clássico de relógio em container.
  it("usa o id da varredura como id do agendamento, para reiniciar não duplicar", async () => {
    const r = criarRelogio([varredura("a")], deps());
    await r.iniciar();
    await r.iniciar();
    expect(fila.upserts.map((u) => u.id)).toEqual(["a", "a"]);
  });

  // Sem isto, renomear ou remover uma varredura deixa o agendamento velho vivo no Redis: ele
  // dispara para sempre um job cujo nome ninguém mais conhece.
  it("remove do Redis agendamento que não é mais declarado — o fantasma que sobra do rename", async () => {
    fila = filaFalsa([{ key: "a" }, { key: "varredura-que-morreu" }]);
    await criarRelogio([varredura("a")], deps()).iniciar();
    expect(fila.removidos).toEqual(["varredura-que-morreu"]);
  });

  it("não remove nada quando o Redis só tem o que está declarado", async () => {
    fila = filaFalsa([{ key: "a" }]);
    await criarRelogio([varredura("a")], deps()).iniciar();
    expect(fila.removidos).toEqual([]);
  });
});

describe("criarRelogio · o tique", () => {
  it("roda a varredura do nome que chegou, e só ela", async () => {
    const a = varredura("a");
    const b = varredura("b");
    const r = criarRelogio([a, b], deps());
    await r.iniciar();

    await r.tique("b");

    expect(a.executar).not.toHaveBeenCalled();
    expect(b.executar).toHaveBeenCalledTimes(1);
  });

  it("o processador entregue ao trabalhador é o tique", async () => {
    const a = varredura("a");
    await criarRelogio([a], deps()).iniciar();
    await processador?.("a");
    expect(a.executar).toHaveBeenCalledTimes(1);
  });

  // Job com nome desconhecido é agendamento órfão que escapou da limpeza. Falhar alto é o certo:
  // um no-op silencioso faria o BullMQ marcar sucesso para trabalho que ninguém fez.
  it("lança quando o nome do job não tem varredura — órfão não vira sucesso calado", async () => {
    const r = criarRelogio([varredura("a")], deps());
    await r.iniciar();
    await expect(r.tique("fantasma")).rejects.toThrow(/fantasma/);
  });

  it("propaga a falha da varredura, para o BullMQ registrar o job como falho", async () => {
    const quebrada: Varredura = {
      id: "q",
      cron: "0 9 * * *",
      executar: vi.fn(async () => {
        throw new Error("banco recusou");
      }),
    };
    const r = criarRelogio([quebrada], deps());
    await r.iniciar();
    await expect(r.tique("q")).rejects.toThrow(/banco recusou/);
  });
});

describe("criarRelogio · parar", () => {
  it("fecha o trabalhador e a fila", async () => {
    const r = criarRelogio([varredura("a")], deps());
    await r.iniciar();
    await r.parar();
    expect(trabalhador.fechado).toBe(true);
    expect(fila.fechada).toBe(true);
  });

  // parar() antes de iniciar() acontece de verdade: SIGTERM no meio do boot. Não pode lançar.
  it("parar sem ter iniciado não lança — SIGTERM durante o boot é real", async () => {
    await expect(criarRelogio([varredura("a")], deps()).parar()).resolves.toBeUndefined();
    expect(fila.fechada).toBe(true);
  });
});

describe("o nome da fila", () => {
  it("é estável, porque o agendamento vive no Redis entre deploys", () => {
    expect(NOME_FILA).toBe("relogio");
  });
});
