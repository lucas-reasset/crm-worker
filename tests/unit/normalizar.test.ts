import { describe, expect, it } from "vitest";
import {
  RetornoImprocessavelError,
  SIGLA_ROBO_INTERNO,
  derivarCodOrigem,
  normalizarEnriquecimento,
  normalizarPre,
  partirOabUf,
  siglasDoRetorno,
  statusRetornoDaColuna,
  statusTransporte,
  transporteDoRetorno,
} from "../../src/normalizar";
import type { ResultadoCessao, ResultadoDocumento } from "../../src/contrato";
import {
  CRE,
  IMP,
  PES,
  contexto,
  retornoEnriq,
  retornoPreAdvogado,
  retornoPreCessao,
  retornoPreDocumento,
  retornoPreErro,
} from "../fixtures";

// Este arquivo testa o DE-PARA, que é onde a D-075 concentrou o risco: cinco vocabulários trocaram
// entre a fila e as colunas, e cada tradução errada é dado gravado no lugar errado — em silêncio.

describe("os de-para de vocabulário (D-075)", () => {
  // Mapear `parcial` para `sucesso` faria o relatório contar "achou o advogado" como se tivesse
  // achado o documento. É por isso que `parcial` virou valor de coluna em vez de tradução.
  it("en_status_retorno: encontrado→sucesso, nao_encontrado→inconclusivo, parcial→parcial", () => {
    expect(statusRetornoDaColuna("encontrado")).toBe("sucesso");
    expect(statusRetornoDaColuna("nao_encontrado")).toBe("inconclusivo");
    expect(statusRetornoDaColuna("parcial")).toBe("parcial");
  });

  it("en_status do envelope: erro→falhou (a coluna é o vocabulário do CRM)", () => {
    expect(statusTransporte("concluido")).toBe("concluido");
    expect(statusTransporte("erro")).toBe("falhou");
  });

  it("o enriquecimento já fala o vocabulário da coluna, e não é traduzido", () => {
    expect(transporteDoRetorno(retornoEnriq({ en_status: "falhou" }))).toBe("falhou");
    expect(transporteDoRetorno(retornoPreErro())).toBe("falhou");
    expect(transporteDoRetorno(retornoPreDocumento())).toBe("concluido");
  });
});

describe("partirOabUf — a inscrição sozinha não identifica ninguém", () => {
  it("parte no hífen", () => {
    expect(partirOabUf("1234-DF")).toEqual({ oab: "1234", en_oab_uf: "DF" });
    expect(partirOabUf("111235-SP")).toEqual({ oab: "111235", en_oab_uf: "SP" });
  });

  // Gravar `en_oab_uf` errado promoveria um advogado inexistente.
  it("forma inesperada devolve null em vez de adivinhar", () => {
    for (const ruim of ["1234/DF", "1234", "DF-1234", "1234-df", "abc-DF", "123456789-SP", ""]) {
      expect(partirOabUf(ruim), ruim).toBeNull();
    }
  });
});

describe("derivarCodOrigem — proveniência para o revisor", () => {
  // Refazer o OCR muda a página e não muda a folha, e é a folha que se cita numa petição.
  it("prefere a FOLHA dos autos à página do PDF", () => {
    expect(derivarCodOrigem("00023821219968260032", 10, 14)).toBe("00023821219968260032#f10");
  });

  it("cai na página quando não há folha", () => {
    expect(derivarCodOrigem("00023821219968260032", null, 14)).toBe("00023821219968260032#p14");
  });

  it("sem folha nem página, fica só o processo", () => {
    expect(derivarCodOrigem("00023821219968260032", null, null)).toBe("00023821219968260032");
  });

  it("sem processo, não há proveniência a inventar", () => {
    expect(derivarCodOrigem(null, 10, 14)).toBeNull();
    expect(derivarCodOrigem(undefined, null, null)).toBeNull();
  });
});

describe("normalizarPre — o robô interno, uma tentativa por mensagem", () => {
  const ctx = contexto();
  const norm = (r = retornoPreDocumento()) => normalizarPre(r, ctx, "for-robo");

  it("sempre UMA consulta, com os quatro campos derivados", () => {
    const [linha] = norm();
    expect(linha).toBeDefined();
    expect(linha!.consulta).toMatchObject({
      idImportacao: IMP,
      idPessoa: PES,
      idCredor: CRE,
      idFornecedor: "for-robo",
      enTipo: "pre_enriquecimento",
      // NULL no pré: a finalidade é única e já está dita pelo en_tipo (D-069).
      enFinalidade: null,
      codServico: null,
      codLake: null,
      // Custo ~0 no robô interno.
      vlCusto: null,
      enStatusRetorno: "sucesso",
      nrRegistros: 1,
    });
  });

  // O contrato do pré não tem `dt_consulta` nem `dt_observacao`: os dois saem do `dt_fim`.
  it("dt_consulta e dt_observacao saem do dt_fim do envelope", () => {
    const [linha] = norm();
    expect(linha!.consulta.dtConsulta).toBe("2026-08-05T14:07:52Z");
    expect(linha!.achados[0]!.dtObservacao).toBe("2026-08-05T14:07:52Z");
  });

  it("o achado de documento leva nr_folha e nr_processo para o payload", () => {
    const [linha] = norm();
    expect(linha!.achados).toHaveLength(1);
    expect(linha!.achados[0]).toMatchObject({
      enAtributo: "cpf",
      valor: "12345678909",
      // As três derivadas pela tabela do backend.
      enOrigem: "robo",
      enStatus: "suspeito",
      enEntidadeCanonica: "pessoa_fisica",
      pctConfianca: "0.92",
      codOrigem: "00023821219968260032#f10",
    });
    expect(linha!.achados[0]!.payload).toMatchObject({
      nr_folha: 10,
      nr_processo: "00023821219968260032",
      nr_pagina: 14,
      metodo_match: "fuzzy",
    });
  });

  // Folha ≠ página, e as duas sobrevivem à normalização. Perder `nr_folha` deixaria a proveniência
  // em coordenada de PDF, que muda se o OCR for refeito.
  it("nr_folha e nr_pagina coexistem no payload, sem uma sobrescrever a outra", () => {
    const [linha] = norm();
    const p = linha!.achados[0]!.payload as Record<string, unknown>;
    expect(p.nr_folha).toBe(10);
    expect(p.nr_pagina).toBe(14);
  });

  it("advogado: valor é o oab_uf VERBATIM e as partes vão no payload", () => {
    const [linha] = norm(retornoPreAdvogado());
    expect(linha!.achados[0]).toMatchObject({
      enAtributo: "advogado",
      valor: "1234-DF",
      enEntidadeCanonica: "advogado",
      enStatus: "suspeito",
    });
    expect(linha!.achados[0]!.payload).toMatchObject({
      oab: "1234",
      en_oab_uf: "DF",
      nome_advogado: "fulano de tal",
      nome_sociedade: "fulano e tal sa",
    });
  });

  it("advogado com oab_uf malformado é improcessável, não é gravado torto", () => {
    const r = retornoPreAdvogado();
    (r.resultado as { oab_uf: string }).oab_uf = "1234/DF";
    expect(() => normalizarPre(r, ctx, "for-robo")).toThrow(RetornoImprocessavelError);
    expect(() => normalizarPre(r, ctx, "for-robo")).toThrow(/promoveria um advogado inexistente/);
  });

  it("cessão: uma linha do inbox por crédito, com valor NULL e o dado no payload", () => {
    const [linha] = norm(retornoPreCessao());
    expect(linha!.consulta.nrRegistros).toBe(1);
    expect(linha!.achados).toHaveLength(1);
    const achado = linha!.achados[0]!;
    expect(achado).toMatchObject({
      enAtributo: "cessao",
      // NULL por desenho: é por isso que o índice de idempotência hasheia (valor ‖ payload).
      valor: null,
      idCredito: "e2440a7d-31cb-4f09-8b5e-6a1c2d3e4f50",
      enEntidadeCanonica: "cessao",
      enStatus: "suspeito",
    });
    expect(achado.payload).toMatchObject({
      en_tipo: "parcial",
      cedente: "FULANO DE TAL DA SILVA - ME",
      cessionario: "COMPRADORA DE CREDITOS LTDA",
      vl_cedido: "123456.78",
      vl_preco_pago: "40000.00",
      pct_cedido: 0.3,
      dt_cessao: "2020-03-15",
      dt_protocolo: "2020-04-10",
    });
  });

  // ⛔ A única PERDA da D-075, e ela fica explícita no dado em vez de ser esquecida.
  it("credor_is_cedente fica NULL — o contrato não diz de que lado o credor está", () => {
    const [linha] = norm(retornoPreCessao());
    expect((linha!.achados[0]!.payload as Record<string, unknown>).credor_is_cedente).toBeNull();
  });

  it("cessão com duas pontas gera dois achados, um por crédito", () => {
    const r = retornoPreCessao();
    const res = r.resultado as ResultadoCessao;
    res.detail_cessoes.push({
      ...res.detail_cessoes[0]!,
      id_credito: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });
    const [linha] = normalizarPre(r, ctx, "for-robo");
    expect(linha!.achados).toHaveLength(2);
    expect(linha!.consulta.nrRegistros).toBe(2);
    expect(linha!.achados.map((a) => a.idCredito)).toEqual([
      "e2440a7d-31cb-4f09-8b5e-6a1c2d3e4f50",
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ]);
  });

  // "Rodou até o fim e o dado não está lá" é SUCESSO no contrato — registra a tentativa e alimenta
  // o reprocessamento. Zero achados, mas a consulta EXISTE.
  it("nao_encontrado gera a consulta e nenhum achado", () => {
    const r = retornoPreDocumento();
    const res = r.resultado as ResultadoDocumento;
    res.en_status_retorno = "nao_encontrado";
    res.valor = null;
    const [linha] = normalizarPre(r, ctx, "for-robo");
    expect(linha!.consulta.enStatusRetorno).toBe("inconclusivo");
    expect(linha!.consulta.nrRegistros).toBe(0);
    expect(linha!.achados).toHaveLength(0);
    expect(linha!.consulta.resumo).toContain("não encontrado");
  });

  it("parcial chega à coluna como parcial, e ainda gera achado", () => {
    const r = retornoPreAdvogado();
    (r.resultado as { en_status_retorno: string }).en_status_retorno = "parcial";
    const [linha] = normalizarPre(r, ctx, "for-robo");
    expect(linha!.consulta.enStatusRetorno).toBe("parcial");
    expect(linha!.achados).toHaveLength(1);
  });

  // O worker falhou: a tentativa AINDA existe e vale registrar — não registrar apagaria o custo de
  // OCR já gasto.
  it("erro do worker registra a consulta com en_status_retorno='erro' e zero achados", () => {
    const [linha] = norm(retornoPreErro());
    expect(linha!.consulta.enStatusRetorno).toBe("erro");
    expect(linha!.consulta.nrRegistros).toBe(0);
    expect(linha!.consulta.observacoes).toContain("OCR indisponível");
    expect(linha!.achados).toHaveLength(0);
  });

  it("concluido SEM resultado é improcessável — diz que rodou e não diz o que achou", () => {
    const r = retornoPreDocumento();
    delete r.resultado;
    expect(() => normalizarPre(r, ctx, "for-robo")).toThrow(/sem `resultado`/);
  });

  it("a sigla do pré é fixa: o robô interno", () => {
    expect(siglasDoRetorno(retornoPreDocumento())).toEqual([SIGLA_ROBO_INTERNO]);
  });
});

describe("normalizarEnriquecimento — N fornecedores, o formato que a D-069 exige", () => {
  const ctx = contexto();
  const resolver = (sigla: string) => `for-${sigla}`;

  it("uma consulta por item de consultas[], com custo e serviço", () => {
    const linhas = normalizarEnriquecimento(retornoEnriq(), ctx, resolver);
    expect(linhas.length).toBeGreaterThan(0);
    expect(linhas[0]!.consulta).toMatchObject({ enTipo: "enriquecimento" });
    // Dinheiro segue string até o banco.
    for (const l of linhas) {
      if (l.consulta.vlCusto !== null) expect(typeof l.consulta.vlCusto).toBe("string");
    }
  });

  it("resolve a sigla de cada consulta pelo catálogo", () => {
    const linhas = normalizarEnriquecimento(retornoEnriq(), ctx, resolver);
    for (const l of linhas) expect(l.consulta.idFornecedor).toMatch(/^for-/);
  });

  it("as siglas distintas do payload são as que precisam resolver", () => {
    const siglas = siglasDoRetorno(retornoEnriq());
    expect(siglas.length).toBe(new Set(siglas).size);
  });

  // Gravar afirmação na pessoa errada é pior que falhar.
  it("id_pessoa divergente entre payload e banco é improcessável", () => {
    expect(() =>
      normalizarEnriquecimento(
        retornoEnriq({ id_pessoa: PES }),
        contexto({ id_pessoa: "outra" }),
        resolver,
      ),
    ).toThrow(/id_pessoa divergente/);
  });
});

// O contrato deixa quase todo campo do resultado opcional, e um worker que ache POUCO manda pouco.
// Estes testes são os payloads mínimos: cada `?? null` aqui é um lugar onde `undefined` chegaria ao
// driver do Postgres e viraria erro de bind, não NULL.
describe("payloads mínimos — o que o contrato permite omitir", () => {
  const ctx = contexto();

  it("documento sem folha, processo, confiança nem payload", () => {
    const r = retornoPreDocumento();
    r.resultado = { en_status_retorno: "encontrado", en_atributo: "cpf", valor: "12345678909" };
    const [linha] = normalizarPre(r, ctx, "for-robo");
    expect(linha!.achados[0]).toMatchObject({
      valor: "12345678909",
      pctConfianca: null,
      codOrigem: null,
    });
    expect(linha!.achados[0]!.payload).toEqual({ nr_folha: null, nr_processo: null });
  });

  it("documento com pct_confianca explicitamente null", () => {
    const r = retornoPreDocumento();
    (r.resultado as ResultadoDocumento).pct_confianca = null;
    const [linha] = normalizarPre(r, ctx, "for-robo");
    expect(linha!.achados[0]!.pctConfianca).toBeNull();
  });

  // `encontrado` sem valor não tem afirmação a fazer — não se grava linha com valor vazio.
  it("documento encontrado SEM valor não gera achado", () => {
    const r = retornoPreDocumento();
    (r.resultado as ResultadoDocumento).valor = null;
    const [linha] = normalizarPre(r, ctx, "for-robo");
    expect(linha!.achados).toHaveLength(0);
    expect(linha!.consulta.nrRegistros).toBe(0);
  });

  it("advogado sem oab_uf não gera achado — a inscrição é o achado", () => {
    const r = retornoPreAdvogado();
    (r.resultado as { oab_uf: string | null }).oab_uf = null;
    const [linha] = normalizarPre(r, ctx, "for-robo");
    expect(linha!.achados).toHaveLength(0);
  });

  it("advogado só com a inscrição, sem nome, sociedade, folha nem payload", () => {
    const r = retornoPreAdvogado();
    r.resultado = { en_status_retorno: "encontrado", en_atributo: "advogado", oab_uf: "9-SP" };
    const [linha] = normalizarPre(r, ctx, "for-robo");
    expect(linha!.achados[0]).toMatchObject({ valor: "9-SP", pctConfianca: null, codOrigem: null });
    expect(linha!.achados[0]!.payload).toMatchObject({
      oab: "9",
      en_oab_uf: "SP",
      nome_advogado: null,
      nome_sociedade: null,
    });
  });

  it("cessão só com o obrigatório: id_credito e tipo_cessao", () => {
    const r = retornoPreCessao();
    (r.resultado as ResultadoCessao).detail_cessoes = [
      { id_credito: "e2440a7d-31cb-4f09-8b5e-6a1c2d3e4f50", tipo_cessao: "integral" },
    ];
    const [linha] = normalizarPre(r, ctx, "for-robo");
    const p = linha!.achados[0]!.payload as Record<string, unknown>;
    expect(linha!.achados[0]).toMatchObject({ pctConfianca: null, codOrigem: null, valor: null });
    // Nenhum `undefined` pode chegar ao bind do driver.
    expect(Object.values(p).every((v) => v !== undefined)).toBe(true);
    expect(p).toMatchObject({
      en_tipo: "integral",
      cedente: null,
      cessionario: null,
      credor_is_cedente: null,
      herdeiros: null,
    });
  });

  it("cessão com as duas pontas sem documento", () => {
    const r = retornoPreCessao();
    const item = (r.resultado as ResultadoCessao).detail_cessoes[0]!;
    item.cedente = { nome: "SÓ NOME" };
    item.cessionario = {};
    item.pct_confianca = null;
    const [linha] = normalizarPre(r, ctx, "for-robo");
    expect(linha!.achados[0]!.payload).toMatchObject({
      cedente: "SÓ NOME",
      cedente_documento: null,
      cessionario: null,
      cessionario_documento: null,
    });
    expect(linha!.achados[0]!.pctConfianca).toBeNull();
  });

  it("cessão vazia: nao_encontrado com lista vazia", () => {
    const r = retornoPreCessao();
    const res = r.resultado as ResultadoCessao;
    res.en_status_retorno = "nao_encontrado";
    res.detail_cessoes = [];
    const [linha] = normalizarPre(r, ctx, "for-robo");
    expect(linha!.achados).toHaveLength(0);
    expect(linha!.consulta.enStatusRetorno).toBe("inconclusivo");
    expect(linha!.consulta.resumo).toContain("nenhuma cessão");
  });

  it("erro do worker sem texto de erro", () => {
    const r = retornoPreErro({ erro: null, cod_versao: null });
    const [linha] = normalizarPre(r, ctx, "for-robo");
    expect(linha!.consulta.observacoes).toBeNull();
    expect(linha!.consulta.codVersao).toBeNull();
  });

  it("enriquecimento: consulta e achado sem campo opcional nenhum", () => {
    const r = retornoEnriq({ cod_versao: null });
    r.consultas = [
      {
        fornecedor: "lemit",
        en_status_retorno: "sucesso",
        nr_registros: 1,
        dt_consulta: "2026-08-06T10:00:00Z",
        achados: [
          { en_atributo: "telefone", pct_confianca: null, dt_observacao: "2026-08-06T10:00:00Z" },
        ],
      },
    ];
    const [linha] = normalizarEnriquecimento(r, ctx, (s) => `for-${s}`);
    expect(linha!.consulta).toMatchObject({
      enFinalidade: null,
      codServico: null,
      codLake: null,
      vlCusto: null,
      codVersao: null,
      resumo: null,
      observacoes: null,
    });
    expect(linha!.achados[0]).toMatchObject({
      valor: null,
      payload: null,
      pctConfianca: null,
      codOrigem: null,
      nrScore: null,
      idCredito: null,
    });
  });

  it("enriquecimento: cod_versao do envelope é o fallback do da consulta", () => {
    const r = retornoEnriq({ cod_versao: "envelope" });
    r.consultas[0]!.cod_versao = null;
    const [linha] = normalizarEnriquecimento(r, ctx, (s) => `for-${s}`);
    expect(linha!.consulta.codVersao).toBe("envelope");
  });
});
