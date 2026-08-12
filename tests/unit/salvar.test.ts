import { beforeEach, describe, expect, it, vi } from "vitest";
import { salvarRetorno, type Dependencias } from "../../src/salvar";
import { RetornoImprocessavelError } from "../../src/normalizar";
import {
  USR,
  contexto,
  retornoEnriq,
  retornoPreCessao,
  retornoPreDocumento,
  retornoPreErro,
} from "../fixtures";

// O `runWithContext`/`setActor` e o `derivarAchado` são os DE VERDADE, importados do crm-backend: é o
// reuso da BE-074 que está sob teste junto. O que é falso aqui é só a borda de I/O — o repository e a
// transação, injetados pela assinatura. O de-para de payload tem teste próprio (normalizar.test.ts).

function fakeDeps(over: Record<string, unknown> = {}) {
  const repo = {
    contextoMensagem: vi.fn().mockResolvedValue(contexto()),
    resolverFornecedor: vi.fn().mockResolvedValue("for-1"),
    registrarConsulta: vi.fn().mockResolvedValue({ id: "con-1" }),
    registrarAchado: vi.fn().mockResolvedValue({ id: "inf-1" }),
    fecharMensagem: vi.fn().mockResolvedValue(1),
    abrirMensagem: vi.fn().mockResolvedValue(1),
    ...over,
  };
  const transacao = vi.fn(async (fn: (c: unknown) => Promise<unknown>) => fn({ fake: "client" }));
  return { deps: { repo, transacao } as unknown as Dependencias, repo, transacao };
}

beforeEach(() => vi.clearAllMocks());

describe("salvarRetorno — o caminho normal, nas duas etapas", () => {
  it("pré: grava a consulta, o achado e fecha a mensagem numa transação", async () => {
    const { deps, repo, transacao } = fakeDeps();

    const r = await salvarRetorno(retornoPreDocumento(), deps);

    expect(transacao).toHaveBeenCalledOnce();
    expect(repo.registrarConsulta).toHaveBeenCalledOnce();
    expect(repo.registrarAchado).toHaveBeenCalledOnce();
    expect(repo.fecharMensagem).toHaveBeenCalledOnce();
    expect(r).toMatchObject({
      etapa: "pre_enriquecimento",
      consultasGravadas: 1,
      achadosGravados: 1,
      jaProcessada: false,
    });
  });

  it("enriquecimento: o mesmo gravador serve, sem saber que o envelope é outro", async () => {
    const { deps, repo } = fakeDeps();
    const r = await salvarRetorno(retornoEnriq(), deps);
    expect(r.etapa).toBe("enriquecimento");
    expect(repo.registrarConsulta).toHaveBeenCalled();
    expect(repo.fecharMensagem).toHaveBeenCalledOnce();
  });

  it("pré resolve UMA sigla — a do robô interno", async () => {
    const { deps, repo } = fakeDeps();
    await salvarRetorno(retornoPreDocumento(), deps);
    expect(repo.resolverFornecedor).toHaveBeenCalledOnce();
    expect(repo.resolverFornecedor).toHaveBeenCalledWith("pre_enriquecimento");
  });

  // O ATOR é a razão da BE-074 existir: sem ele a trilha nasce anônima e o INSERT passa.
  it("publica o ator lido de importacao_credor.id_usuario_criacao", async () => {
    const { deps, repo } = fakeDeps();
    await salvarRetorno(retornoPreDocumento(), deps);

    for (const chamada of [repo.registrarConsulta, repo.registrarAchado, repo.fecharMensagem]) {
      expect(chamada.mock.calls[0]!.at(-1)).toMatchObject({ actorId: USR });
    }
  });

  it("todas as escritas vão no MESMO client da transação", async () => {
    const { deps, repo } = fakeDeps();
    await salvarRetorno(retornoPreDocumento(), deps);

    const clients = [repo.registrarConsulta, repo.registrarAchado, repo.fecharMensagem].map(
      (m) => (m.mock.calls[0]!.at(-1) as { client: unknown }).client,
    );
    expect(new Set(clients).size).toBe(1);
  });

  it("dt_conclusao sai do dt_fim do payload, não da hora da gravação", async () => {
    const { deps, repo } = fakeDeps();
    await salvarRetorno(retornoPreDocumento(), deps);
    expect(repo.fecharMensagem.mock.calls[0]![1]).toMatchObject({
      enStatus: "concluido",
      dtConclusao: "2026-08-05T14:07:52Z",
    });
  });

  // A tradução `erro`→`falhou` chega ao banco pelo gravador.
  it("erro do worker fecha a mensagem como falhou, com o texto do erro", async () => {
    const { deps, repo } = fakeDeps();
    await salvarRetorno(retornoPreErro(), deps);
    expect(repo.fecharMensagem.mock.calls[0]![1]).toMatchObject({ enStatus: "falhou" });
    expect(repo.fecharMensagem.mock.calls[0]![1]).toHaveProperty("erro");
    // A tentativa é registrada mesmo na falha: não registrar apagaria o custo de OCR já gasto.
    expect(repo.registrarConsulta).toHaveBeenCalledOnce();
    expect(repo.registrarAchado).not.toHaveBeenCalled();
  });

  it("cessão grava um achado por crédito", async () => {
    const { deps, repo } = fakeDeps();
    const r = await salvarRetorno(retornoPreCessao(), deps);
    expect(repo.registrarAchado).toHaveBeenCalledOnce();
    expect(r.achadosGravados).toBe(1);
  });

  it("mensagem sem ator grava actorId null — não inventa autor", async () => {
    const { deps, repo } = fakeDeps({
      contextoMensagem: vi.fn().mockResolvedValue(contexto({ id_usuario_criacao: null })),
    });
    await salvarRetorno(retornoPreDocumento(), deps);
    expect(repo.fecharMensagem.mock.calls[0]!.at(-1)).toMatchObject({ actorId: null });
  });
});

describe("salvarRetorno — idempotência", () => {
  // A SQS é at-least-once: a entrega repetida é ESPERADA, não anomalia.
  it("mensagem já concluída sai sem escrever nada", async () => {
    const { deps, repo, transacao } = fakeDeps({
      contextoMensagem: vi.fn().mockResolvedValue(contexto({ en_status: "concluido" })),
    });

    const r = await salvarRetorno(retornoPreDocumento(), deps);

    expect(r.jaProcessada).toBe(true);
    expect(transacao).not.toHaveBeenCalled();
    expect(repo.registrarConsulta).not.toHaveBeenCalled();
    expect(repo.fecharMensagem).not.toHaveBeenCalled();
  });

  it("linha que já existia conta como repetida, não como gravada", async () => {
    const { deps } = fakeDeps({
      registrarConsulta: vi.fn().mockResolvedValue({ id: null }),
      registrarAchado: vi.fn().mockResolvedValue({ id: null }),
    });

    const r = await salvarRetorno(retornoPreDocumento(), deps);

    expect(r).toMatchObject({
      consultasGravadas: 0,
      consultasRepetidas: 1,
      achadosGravados: 0,
      achadosRepetidos: 1,
    });
  });
});

describe("salvarRetorno — o que é improcessável (vai para a DLQ, não retenta)", () => {
  it("id_mensagem que não existe no banco", async () => {
    const { deps } = fakeDeps({ contextoMensagem: vi.fn().mockResolvedValue(null) });
    await expect(salvarRetorno(retornoPreDocumento(), deps)).rejects.toThrow(
      RetornoImprocessavelError,
    );
    await expect(salvarRetorno(retornoPreDocumento(), deps)).rejects.toThrow(
      /não existe em importacao_credor/,
    );
  });

  // No pré o `id_pessoa` NÃO vem no payload (o id_mensagem basta), então a única fonte é o banco —
  // e um credor sem pessoa deixaria a afirmação sem sujeito.
  it("credor sem pessoa: afirmação sem sujeito não tem onde pousar", async () => {
    const { deps, transacao } = fakeDeps({
      contextoMensagem: vi.fn().mockResolvedValue(contexto({ id_pessoa: null })),
    });
    await expect(salvarRetorno(retornoPreDocumento(), deps)).rejects.toThrow(/não tem pessoa/);
    expect(transacao).not.toHaveBeenCalled();
  });

  // Semear fornecedor é decisão humana — nunca INSERT do worker.
  it("sigla fora do catálogo, e nada é escrito", async () => {
    const { deps, transacao } = fakeDeps({ resolverFornecedor: vi.fn().mockResolvedValue(null) });
    await expect(salvarRetorno(retornoPreDocumento(), deps)).rejects.toThrow(
      /não está no catálogo/,
    );
    // ANTES da transação: descobrir isso no meio deixaria o trabalho pela metade.
    expect(transacao).not.toHaveBeenCalled();
  });

  it("atributo sem derivação aborta antes de abrir a transação", async () => {
    const r = retornoEnriq();
    r.consultas[0]!.achados[0]!.en_atributo = "nome";
    const { deps, transacao } = fakeDeps();

    await expect(salvarRetorno(r, deps)).rejects.toThrow(/não tem derivação/);
    // A normalização acontece FORA da transação, então nem se abre uma para desfazer.
    expect(transacao).not.toHaveBeenCalled();
  });
});
