import { describe, expect, it } from "vitest";
import {
  ContratoInvalidoError,
  descreverErro,
  ehAdvogado,
  ehCessao,
  interpretarRetorno,
  validadorDe,
} from "../../src/contrato";
import type { ResultadoCessao, ResultadoDocumento, RetornoPre } from "../../src/contrato";
import {
  retornoEnriq,
  retornoPreAdvogado,
  retornoPreCessao,
  retornoPreDocumento,
  retornoPreErro,
} from "../fixtures";

// A validação roda contra os JSON Schemas PUBLICADOS em crm-backend/modelo/contratos/ — os mesmos
// arquivos que documentam o contrato. Estes testes, portanto, também são o alarme de que alguém
// mudou o contrato de lá: se um payload que era válido parar de ser, é o schema que mudou.
//
// As fixtures são os `examples` do próprio contrato: um payload de `advogado` escrito à mão não
// passou (faltavam cinco campos obrigatórios), e foi assim que a divergência de 06/08 apareceu.

const json = (o: unknown) => JSON.stringify(o);

describe("interpretarRetorno — pré-enriquecimento (D-075)", () => {
  it("aceita os quatro exemplos do contrato: documento, advogado, cessão e erro", () => {
    for (const r of [
      retornoPreDocumento(),
      retornoPreAdvogado(),
      retornoPreCessao(),
      retornoPreErro(),
    ]) {
      expect(interpretarRetorno(json(r)).tipo).toBe("pre_enriquecimento");
    }
  });

  it("o retorno NÃO ecoa id_lote/id_credor/id_pessoa — o id_mensagem basta", () => {
    const r = interpretarRetorno(json(retornoPreDocumento())) as RetornoPre;
    expect(r).not.toHaveProperty("id_lote");
    expect(r).not.toHaveProperty("id_credor");
    expect(r).not.toHaveProperty("id_pessoa");
    expect(r.id_mensagem).toBeTruthy();
  });

  it("recusa campo extra no retorno (unevaluatedProperties: false)", () => {
    expect(() => interpretarRetorno(json({ ...retornoPreDocumento(), inventado: 1 }))).toThrow(
      ContratoInvalidoError,
    );
  });

  it("recusa oab_uf fora do formato <inscrição>-<UF>", () => {
    const r = retornoPreAdvogado();
    (r.resultado as { oab_uf: string }).oab_uf = "1234/DF";
    expect(() => interpretarRetorno(json(r))).toThrow(ContratoInvalidoError);
  });

  it("recusa pct_cedido fora de 0–1 — mandar 30 viraria 3000%", () => {
    const r = retornoPreCessao();
    (r.resultado as ResultadoCessao).detail_cessoes[0]!.pct_cedido = 30;
    expect(() => interpretarRetorno(json(r))).toThrow(ContratoInvalidoError);
  });

  it("recusa tipo_cessao='total' — o modelo diz integral", () => {
    const r = retornoPreCessao();
    (r.resultado as ResultadoCessao).detail_cessoes[0]!.tipo_cessao =
      "total" as unknown as "integral";
    expect(() => interpretarRetorno(json(r))).toThrow(ContratoInvalidoError);
  });

  it("recusa vl_cedido como number — dinheiro é string decimal", () => {
    const r = retornoPreCessao();
    (r.resultado as ResultadoCessao).detail_cessoes[0]!.vl_cedido = 123456.78 as unknown as string;
    expect(() => interpretarRetorno(json(r))).toThrow(ContratoInvalidoError);
  });

  it("recusa en_status='falhou' no pré — lá o vocabulário é concluido|erro", () => {
    expect(() =>
      interpretarRetorno(json({ ...retornoPreDocumento(), en_status: "falhou" })),
    ).toThrow(ContratoInvalidoError);
  });

  it("recusa en_status_retorno='sucesso' no pré — lá é encontrado|nao_encontrado|parcial", () => {
    const r = retornoPreDocumento();
    (r.resultado as ResultadoDocumento).en_status_retorno = "sucesso" as unknown as "encontrado";
    expect(() => interpretarRetorno(json(r))).toThrow(ContratoInvalidoError);
  });

  it("aceita parcial, que é o estado novo da D-075", () => {
    const r = retornoPreAdvogado();
    (r.resultado as { en_status_retorno: string }).en_status_retorno = "parcial";
    expect(interpretarRetorno(json(r))).toBeTruthy();
  });

  it("erro do worker vem SEM resultado, e isso é válido", () => {
    const r = interpretarRetorno(json(retornoPreErro())) as RetornoPre;
    expect(r.en_status).toBe("erro");
    expect(r.resultado).toBeUndefined();
  });
});

describe("o discriminador das três formas de resultado", () => {
  // O retorno não traz `en_enrichment`, então a forma se descobre pelo conteúdo.
  it("detail_cessoes presente ⇒ cessão", () => {
    expect(ehCessao(retornoPreCessao().resultado!)).toBe(true);
    expect(ehCessao(retornoPreDocumento().resultado!)).toBe(false);
    expect(ehCessao(retornoPreAdvogado().resultado!)).toBe(false);
  });

  it("en_atributo='advogado' ⇒ advogado; cpf/cnpj ⇒ documento", () => {
    expect(ehAdvogado(retornoPreAdvogado().resultado!)).toBe(true);
    expect(ehAdvogado(retornoPreDocumento().resultado!)).toBe(false);
    expect(ehAdvogado(retornoPreCessao().resultado!)).toBe(false);
  });
});

describe("interpretarRetorno — enriquecimento (inalterado pela D-075)", () => {
  it("aceita o envelope consultas[]/achados[], que a D-069 exige", () => {
    const r = interpretarRetorno(json(retornoEnriq()));
    expect(r.tipo).toBe("enriquecimento");
    expect(r).toHaveProperty("consultas");
  });

  // A prova de que os dois envelopes NÃO são intercambiáveis — a razão de existirem dois mapeadores.
  it("um retorno de pré com o tipo trocado para enriquecimento é recusado", () => {
    expect(() =>
      interpretarRetorno(json({ ...retornoPreDocumento(), tipo: "enriquecimento" })),
    ).toThrow(ContratoInvalidoError);
  });

  it("e o inverso também", () => {
    expect(() =>
      interpretarRetorno(json({ ...retornoEnriq(), tipo: "pre_enriquecimento" })),
    ).toThrow(ContratoInvalidoError);
  });
});

describe("o portão de entrada", () => {
  it("recusa corpo que não é JSON", () => {
    expect(() => interpretarRetorno("{nao json")).toThrow(/não é JSON válido/);
  });

  it("recusa corpo que é JSON mas não é objeto", () => {
    expect(() => interpretarRetorno('"uma string"')).toThrow(/não é um objeto/);
    expect(() => interpretarRetorno("null")).toThrow(/não é um objeto/);
    expect(() => interpretarRetorno("42")).toThrow(/não é um objeto/);
  });

  it("recusa tipo desconhecido — é ele que escolhe o validador e o envelope", () => {
    expect(() => interpretarRetorno(json({ ...retornoPreDocumento(), tipo: "outra" }))).toThrow(
      /tipo desconhecido/,
    );
    expect(() => interpretarRetorno(json({ ...retornoPreDocumento(), tipo: undefined }))).toThrow(
      /tipo desconhecido/,
    );
  });

  // Os DOIS nomes da flag são checados: o pré usa `st_simulacao`, o enriq usa `is_draft`, e um worker
  // que ecoe o campo do outro contrato merece um erro que diga o motivo.
  it("recusa simulação pelos dois nomes, com o motivo", () => {
    for (const flag of ["st_simulacao", "is_draft"]) {
      const corpo = json({ ...retornoPreDocumento(), [flag]: true });
      expect(() => interpretarRetorno(corpo), flag).toThrow(ContratoInvalidoError);
      expect(() => interpretarRetorno(corpo), flag).toThrow(/simulador.*não existe/s);
    }
  });

  it("e vem ANTES do schema: num payload quebrado o motivo ainda sobrevive", () => {
    expect(() =>
      interpretarRetorno(json({ tipo: "pre_enriquecimento", st_simulacao: true })),
    ).toThrow(/simulador/);
  });

  it("recusa payload fora do schema, e diz onde", () => {
    const semDtFim = { ...retornoPreDocumento() } as Record<string, unknown>;
    delete semDtFim.dt_fim;
    try {
      interpretarRetorno(json(semDtFim));
      expect.unreachable("devia ter lançado");
    } catch (err) {
      const e = err as ContratoInvalidoError;
      expect(e).toBeInstanceOf(ContratoInvalidoError);
      expect(e.detalhes.join(" ")).toContain("dt_fim");
    }
  });

  it("recusa uuid malformado — o id_mensagem é a chave de idempotência", () => {
    expect(() =>
      interpretarRetorno(json({ ...retornoPreDocumento(), id_mensagem: "IDQGC00791040" })),
    ).toThrow(ContratoInvalidoError);
  });
});

describe("os guards de infraestrutura do validador", () => {
  it("contrato renomeado no crm-backend falha ALTO, em vez de aceitar tudo", () => {
    expect(() => validadorDe("contrato-que-nao-existe")).toThrow(/contrato não encontrado/);
  });

  it("descreverErro cobre erro de raiz e erro sem mensagem", () => {
    expect(descreverErro({ instancePath: "/resultado", message: "faltando" })).toBe(
      "/resultado faltando",
    );
    // Erro de RAIZ tem instancePath vazio — sem o fallback, a linha começaria com espaço.
    expect(descreverErro({ instancePath: "", message: "ruim" })).toBe("/ ruim");
    expect(descreverErro({})).toBe("/ inválido");
  });
});
