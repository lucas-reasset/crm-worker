import { derivarAchado } from "crm-backend/models/DerivacaoAchado";
import type {
  AchadoParaGravar,
  ConsultaParaGravar,
  ContextoMensagem,
} from "crm-backend/repositories";
import {
  ehAdvogado,
  ehCessao,
  type CessaoItem,
  type Retorno,
  type RetornoEnriq,
  type RetornoPre,
  type StatusRetornoPre,
} from "./contrato";

// DOIS MAPEADORES, UM GRAVADOR — e é aqui que o de-para inteiro mora.
//
// A D-075 matou o envelope compartilhado das duas etapas: o pré devolve um `resultado` único (grão
// credor × atributo), o enriquecimento devolve `consultas[]` → `achados[]` (grão credor, N
// fornecedores). O que se preservou da intenção da D-068 é ter **um lugar** onde o payload vira
// linha: as duas funções abaixo produzem a MESMA estrutura, e `salvar.ts` grava sem saber de qual
// etapa veio.
//
// Todo de-para de vocabulário está neste arquivo, e de propósito: espalhá-lo pelo gravador faria
// "por que `erro` virou `falhou`?" ser uma pergunta sem endereço.

/** Uma consulta e as afirmações que nasceram dela. É o que o gravador consome. */
export interface LinhaParaGravar {
  consulta: ConsultaParaGravar;
  achados: AchadoParaGravar[];
}

/** Erro de payload/estado que reprocessar não conserta. */
export class RetornoImprocessavelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetornoImprocessavelError";
    Object.setPrototypeOf(this, RetornoImprocessavelError.prototype);
  }
}

/**
 * O de-para do `en_status_retorno` do PRÉ para o vocabulário da coluna (D-075).
 *
 * `parcial` passa direto porque virou valor de coluna: mapeá-lo para `sucesso` faria o relatório de
 * cobertura contar "achou o advogado" como se tivesse achado o documento.
 */
export function statusRetornoDaColuna(status: StatusRetornoPre): string {
  if (status === "encontrado") return "sucesso";
  if (status === "nao_encontrado") return "inconclusivo";
  return "parcial";
}

/**
 * O de-para do `en_status` do envelope do PRÉ para o ciclo de vida do transporte.
 *
 * A coluna diz `falhou` onde a fila diz `erro`, e não se mexeu na coluna: ela é o vocabulário do
 * CRM e tem também `dlq`, que não vem da fila (quem o escreve é quem consome a DLQ).
 */
export function statusTransporte(en_status: "concluido" | "erro"): "concluido" | "falhou" {
  return en_status === "concluido" ? "concluido" : "falhou";
}

/**
 * `"1234-DF"` → `{ oab: "1234", en_oab_uf: "DF" }`.
 *
 * O contrato manda inscrição e seccional JUNTAS, e a promoção para `advogado` precisa das duas
 * separadas. A inscrição sozinha não identifica ninguém — ela repete entre seccionais —, então esta
 * partição é obrigatória, não conveniência. Forma inesperada devolve `null` em vez de adivinhar:
 * gravar `en_oab_uf` errado promoveria um advogado inexistente.
 */
export function partirOabUf(oabUf: string): { oab: string; en_oab_uf: string } | null {
  const m = /^(\d{1,8})-([A-Z]{2})$/.exec(oabUf);
  return m ? { oab: m[1]!, en_oab_uf: m[2]! } : null;
}

/**
 * Ponteiro de proveniência para o revisor: `<processo>#f<folha>` ou `#p<pagina>`.
 *
 * DERIVADO — o contrato do pré não tem `cod_origem`. Prefere a FOLHA à página porque refazer o OCR
 * muda a página e não muda a folha, e é a folha que se cita numa petição.
 */
export function derivarCodOrigem(
  nrProcesso: string | null | undefined,
  nrFolha: number | null | undefined,
  nrPagina: unknown,
): string | null {
  if (!nrProcesso) return null;
  if (typeof nrFolha === "number") return `${nrProcesso}#f${nrFolha}`;
  if (typeof nrPagina === "number") return `${nrProcesso}#p${nrPagina}`;
  return nrProcesso;
}

function resumoPre(retorno: RetornoPre): string {
  if (retorno.en_status === "erro") return "erro do worker";
  const r = retorno.resultado;
  /* v8 ignore next -- `concluido` sem resultado é barrado antes, em `normalizarPre` */
  if (!r) return "sem resultado";
  if (ehCessao(r)) {
    const n = r.detail_cessoes.length;
    return n === 0 ? "nenhuma cessão" : `${n} cessão(ões)`;
  }
  if (r.en_status_retorno === "nao_encontrado") return `${r.en_atributo} não encontrado`;
  return `${r.en_atributo} ${r.en_status_retorno}`;
}

function achadosDoPre(retorno: RetornoPre, ctx: ContextoMensagem, idFornecedor: string) {
  const r = retorno.resultado;
  if (!r || r.en_status_retorno === "nao_encontrado") return [];

  const idPessoa = ctx.id_pessoa!;
  const base = {
    idImportacao: ctx.id_importacao,
    idPessoa,
    idFornecedor,
    // O contrato do pré não tem `dt_observacao` por achado: sai do `dt_fim` do envelope (D-075).
    dtObservacao: retorno.dt_fim,
    nrScore: null,
  };

  if (ehCessao(r)) {
    // Uma cessão por crédito → UMA linha do inbox por item. `valor` fica NULL por desenho: o dado
    // inteiro vive no payload, e é por isso que o índice de idempotência hasheia (valor ‖ payload).
    return r.detail_cessoes.map((item) => cessaoParaAchado(item, base));
  }

  if (ehAdvogado(r)) {
    if (!r.oab_uf) return [];
    const partes = partirOabUf(r.oab_uf);
    if (!partes) {
      throw new RetornoImprocessavelError(
        `oab_uf "${r.oab_uf}" fora do formato <inscrição>-<UF>; partir errado promoveria um advogado inexistente`,
      );
    }
    const derivado = derivarAchado("pre_enriquecimento", "advogado");
    return [
      {
        ...base,
        idCredito: null,
        enAtributo: "advogado",
        // `valor` guarda o `oab_uf` VERBATIM. Não se inventa um terceiro formato: as partes vão no
        // payload, que é o que a promoção consome.
        valor: r.oab_uf,
        payload: {
          ...partes,
          nome_advogado: r.nome_advogado ?? null,
          nome_sociedade: r.nome_sociedade ?? null,
          nr_folha: r.nr_folha ?? null,
          nr_processo: r.nr_processo ?? null,
          ...(r.payload ?? {}),
        },
        pctConfianca:
          r.pct_confianca === null || r.pct_confianca === undefined
            ? null
            : String(r.pct_confianca),
        codOrigem: derivarCodOrigem(r.nr_processo, r.nr_folha, (r.payload ?? {})["nr_pagina"]),
        enOrigem: derivado.en_origem,
        enStatus: derivado.en_status,
        enEntidadeCanonica: derivado.en_entidade_canonica,
      },
    ];
  }

  // cpf | cnpj
  if (!r.valor) return [];
  const derivado = derivarAchado("pre_enriquecimento", r.en_atributo);
  return [
    {
      ...base,
      idCredito: null,
      enAtributo: r.en_atributo,
      valor: r.valor,
      payload: {
        nr_folha: r.nr_folha ?? null,
        nr_processo: r.nr_processo ?? null,
        ...(r.payload ?? {}),
      },
      pctConfianca:
        r.pct_confianca === null || r.pct_confianca === undefined ? null : String(r.pct_confianca),
      codOrigem: derivarCodOrigem(r.nr_processo, r.nr_folha, (r.payload ?? {})["nr_pagina"]),
      enOrigem: derivado.en_origem,
      enStatus: derivado.en_status,
      enEntidadeCanonica: derivado.en_entidade_canonica,
    },
  ];
}

function cessaoParaAchado(
  item: CessaoItem,
  base: Omit<
    AchadoParaGravar,
    | "idCredito"
    | "enAtributo"
    | "valor"
    | "payload"
    | "pctConfianca"
    | "codOrigem"
    | "enOrigem"
    | "enStatus"
    | "enEntidadeCanonica"
  >,
): AchadoParaGravar {
  const derivado = derivarAchado("pre_enriquecimento", "cessao");
  return {
    ...base,
    // O crédito do ACHADO, não o da mensagem: a cessão é o único achado que é fato de crédito, e um
    // credor pode ter vários.
    idCredito: item.id_credito,
    enAtributo: "cessao",
    valor: null,
    payload: {
      // ⛔ `credor_is_cedente` FICA NULL, e é a única perda da D-075. O contrato publicado nomeia as
      // duas pontas e instrui o worker a NÃO inferir quem é quem — então ninguém responde, na
      // entrada do dado, a pergunta mais consequente da cessão: se o credor-alvo é o cedente, ele
      // perdeu o crédito e sai do funil; se é só o cessionário, o crédito segue intacto.
      // Não se deriva por comparação de documento aqui de propósito: o role do save-worker não tem
      // SELECT em `pessoa` (é o que o mantém longe do canônico), e adivinhar por nome é exatamente
      // o que o contrato alerta para não fazer. Fica para a revisão humana.
      credor_is_cedente: null,
      en_tipo: item.tipo_cessao,
      cedente: item.cedente?.nome ?? null,
      cedente_documento: item.cedente?.documento ?? null,
      cessionario: item.cessionario?.nome ?? null,
      cessionario_documento: item.cessionario?.documento ?? null,
      advogado_cessionario: item.advogado_cessionario ?? null,
      vl_cedido: item.vl_cedido ?? null,
      vl_preco_pago: item.vl_pago ?? null,
      pct_cedido: item.pct_cedido ?? null,
      dt_cessao: item.data_cessao ?? null,
      dt_protocolo: item.data_protocolo ?? null,
      notas: item.notas ?? null,
      herdeiros: item.herdeiros ?? null,
      nr_folha: item.nr_folha ?? null,
      nr_processo: item.nr_processo ?? null,
      ...(item.payload ?? {}),
    },
    pctConfianca:
      item.pct_confianca === null || item.pct_confianca === undefined
        ? null
        : String(item.pct_confianca),
    codOrigem: derivarCodOrigem(item.nr_processo, item.nr_folha, (item.payload ?? {})["nr_pagina"]),
    enOrigem: derivado.en_origem,
    enStatus: derivado.en_status,
    enEntidadeCanonica: derivado.en_entidade_canonica,
  };
}

/**
 * PRÉ → linhas. Sempre **uma** consulta: o pré é o robô interno, uma tentativa por mensagem.
 *
 * Quatro campos da consulta são DERIVADOS porque o contrato não os traz, e cada um tem motivo:
 * · `id_fornecedor` — é sempre o robô interno (`sigla='pre_enriquecimento'`); pedir na fila seria
 *   pedir ao worker que repetisse uma constante, e campo redundante um dia discorda;
 * · `en_finalidade` — NULL no pré: a finalidade é única e já está dita pelo `en_tipo` (D-069);
 * · `nr_registros` — 1/0 no documento e no advogado, N nas cessões;
 * · `vl_custo` — NULL: custo ~0. ⚠️ Se o pré passar a ter custo (LLM de visão não é grátis), isto
 *   deixa de ser derivável e vira campo de fila.
 */
export function normalizarPre(
  retorno: RetornoPre,
  ctx: ContextoMensagem,
  idFornecedor: string,
): LinhaParaGravar[] {
  if (retorno.en_status === "concluido" && !retorno.resultado) {
    throw new RetornoImprocessavelError(
      "en_status='concluido' sem `resultado`: o worker diz que rodou até o fim e não diz o que achou",
    );
  }

  const achados = achadosDoPre(retorno, ctx, idFornecedor);
  const r = retorno.resultado;

  return [
    {
      consulta: {
        idImportacao: ctx.id_importacao,
        idPessoa: ctx.id_pessoa!,
        idCredor: ctx.id_credor,
        idFornecedor,
        enTipo: "pre_enriquecimento",
        enFinalidade: null,
        codServico: null,
        codLake: null,
        // Sem `resultado` (o worker falhou) a tentativa AINDA existe e vale registrar: `erro` diz
        // que se tentou e quebrou. Não registrar apagaria o custo de OCR já gasto.
        enStatusRetorno: r ? statusRetornoDaColuna(r.en_status_retorno) : "erro",
        // O contrato não tem `dt_consulta`: sai do `dt_fim` (D-075). Carimbar a hora da GRAVAÇÃO
        // faria a latência medir a espera na fila em vez do trabalho.
        dtConsulta: retorno.dt_fim,
        nrRegistros: achados.length,
        vlCusto: null,
        codVersao: retorno.cod_versao ?? null,
        resumo: resumoPre(retorno),
        // `enriquecimento_consulta` não tem coluna `erro`.
        observacoes: retorno.erro ?? null,
      },
      achados,
    },
  ];
}

/**
 * ENRIQUECIMENTO → linhas. Uma consulta por item de `consultas[]`, N achados dentro de cada.
 *
 * `resolverSigla` é injetado porque a resolução `sigla` → `id_fornecedor` é I/O, e este módulo é
 * puro de propósito: é o que permite testar todo o de-para sem banco.
 */
export function normalizarEnriquecimento(
  retorno: RetornoEnriq,
  ctx: ContextoMensagem,
  resolverSigla: (sigla: string) => string,
): LinhaParaGravar[] {
  // O payload do enriquecimento TRAZ `id_pessoa` (para poupar um JOIN por achado), e quem afirma é
  // o banco: divergir significa que este retorno não é da mensagem que pedimos, e gravar afirmação
  // na pessoa errada é pior que falhar — o revisor veria dado plausível pendurado em quem não é.
  if (ctx.id_pessoa !== retorno.id_pessoa) {
    throw new RetornoImprocessavelError(
      `id_pessoa divergente na mensagem ${retorno.id_mensagem}: payload ${retorno.id_pessoa}, banco ${ctx.id_pessoa}`,
    );
  }

  return retorno.consultas.map((consulta) => {
    const idFornecedor = resolverSigla(consulta.fornecedor);
    return {
      consulta: {
        idImportacao: ctx.id_importacao,
        idPessoa: retorno.id_pessoa,
        idCredor: retorno.id_credor,
        idFornecedor,
        enTipo: "enriquecimento",
        enFinalidade: consulta.en_finalidade ?? null,
        codServico: consulta.servico ?? null,
        codLake: consulta.cod_lake ?? null,
        enStatusRetorno: consulta.en_status_retorno,
        dtConsulta: consulta.dt_consulta,
        nrRegistros: consulta.nr_registros,
        vlCusto: consulta.vl_custo ?? null,
        codVersao: consulta.cod_versao ?? retorno.cod_versao ?? null,
        resumo: consulta.resumo ?? null,
        observacoes: consulta.erro ?? null,
      },
      achados: consulta.achados.map((achado) => {
        // As três colunas que o extrator não manda. Atributo sem derivação LANÇA.
        const derivado = derivarAchado("enriquecimento", achado.en_atributo);
        return {
          idImportacao: ctx.id_importacao,
          idPessoa: retorno.id_pessoa,
          idCredito: achado.id_credito ?? null,
          idFornecedor,
          enAtributo: achado.en_atributo,
          valor: achado.valor ?? null,
          payload: achado.payload ?? null,
          dtObservacao: achado.dt_observacao,
          pctConfianca: achado.pct_confianca === null ? null : String(achado.pct_confianca),
          codOrigem: achado.cod_origem ?? null,
          nrScore: achado.nr_score ?? null,
          enOrigem: derivado.en_origem,
          enStatus: derivado.en_status,
          enEntidadeCanonica: derivado.en_entidade_canonica,
        };
      }),
    };
  });
}

/** A sigla do robô interno. Toda tentativa tem um QUEM, e a do pré é sempre esta (D-068). */
export const SIGLA_ROBO_INTERNO = "pre_enriquecimento";

/** As siglas que este retorno precisa resolver — o pré tem uma fixa, o enriq tem as do payload. */
export function siglasDoRetorno(retorno: Retorno): string[] {
  if (retorno.tipo === "pre_enriquecimento") return [SIGLA_ROBO_INTERNO];
  return [...new Set(retorno.consultas.map((c) => c.fornecedor))];
}

/** O `en_status` do transporte que este retorno pede. O pré diz `erro`; o enriq já diz `falhou`. */
export function transporteDoRetorno(retorno: Retorno): "concluido" | "falhou" {
  return retorno.tipo === "pre_enriquecimento"
    ? statusTransporte(retorno.en_status)
    : retorno.en_status;
}
