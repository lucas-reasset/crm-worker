import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import comum from "crm-backend/contratos/_comum.schema.json";
import preEnriquecimento from "crm-backend/contratos/pre-enriquecimento.schema.json";
import enriquecimento from "crm-backend/contratos/enriquecimento.schema.json";

// O CONTRATO É VALIDADO CONTRA O PRÓPRIO ARTEFATO PUBLICADO, não contra uma cópia da forma.
//
// Os três schemas vêm de `crm-backend/modelo/contratos/`, embarcados no pacote (BE-076). Reescrever
// a forma aqui à mão criaria uma segunda verdade, e a divergência passaria a ser silenciosa: o
// INSERT gravaria dado errado sem nada reclamar. Efeito colateral bem-vindo: o teste de contrato
// deste repo é o alarme de que alguém mudou o schema no backend.
//
// ⚠️ AS DUAS ETAPAS TÊM ENVELOPES DIFERENTES (D-075), e isto não é provisório. O pré tem grão
// (credor × atributo) e devolve um `resultado` ÚNICO; o enriquecimento tem grão credor e devolve
// `consultas[]` → `achados[]`, forma que ele PRECISA porque a CredValue cobra por serviço e seis
// chamadas são seis linhas de custo. A D-068 tinha desenhado um envelope só "para o save-worker ter
// um mapeador"; são dois. O que se preservou é ter **um gravador** — ver `normalizar.ts`.

export type Etapa = "pre_enriquecimento" | "enriquecimento";

/** Payload que não casa com o contrato. Vai para a DLQ: reprocessar não conserta forma errada. */
export class ContratoInvalidoError extends Error {
  constructor(
    message: string,
    public readonly detalhes: string[] = [],
  ) {
    super(message);
    this.name = "ContratoInvalidoError";
    Object.setPrototypeOf(this, ContratoInvalidoError.prototype);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PRÉ-ENRIQUECIMENTO — o contrato publicado ao time do worker (D-075)
// ─────────────────────────────────────────────────────────────────────────────

/** Fala do DADO, não do worker. `parcial` = achou parte (ex.: o advogado, não o credor). */
export type StatusRetornoPre = "encontrado" | "nao_encontrado" | "parcial";

export interface ResultadoDocumento {
  en_status_retorno: StatusRetornoPre;
  en_atributo: "cpf" | "cnpj";
  valor?: string | null;
  /** Folha DOS AUTOS — ≠ `payload.nr_pagina`, que é a página do PDF. */
  nr_folha?: number | null;
  /** Onde achou: pode ser um INCIDENTE, não o processo principal da entrada. */
  nr_processo?: string | null;
  pct_confianca?: number | null;
  payload?: Record<string, unknown> | null;
}

export interface ResultadoAdvogado {
  en_status_retorno: StatusRetornoPre;
  en_atributo: "advogado";
  /** Inscrição e seccional JUNTAS (`"1234-DF"`) — o número sozinho não identifica ninguém. */
  oab_uf?: string | null;
  nome_advogado?: string | null;
  nome_sociedade?: string | null;
  nr_folha?: number | null;
  nr_processo?: string | null;
  pct_confianca?: number | null;
  payload?: Record<string, unknown> | null;
}

export interface CessaoItem {
  id_credito: string;
  cedente?: { nome?: string | null; documento?: string | null } | null;
  cessionario?: { nome?: string | null; documento?: string | null } | null;
  advogado_cessionario?: Record<string, unknown> | null;
  tipo_cessao: "integral" | "parcial";
  vl_cedido?: string | null;
  vl_pago?: string | null;
  /** FRAÇÃO de 0 a 1 — `0.30` = 30%. */
  pct_cedido?: number | null;
  data_cessao?: string | null;
  data_protocolo?: string | null;
  notas?: string | null;
  herdeiros?: Record<string, unknown>[] | null;
  nr_folha?: number | null;
  nr_processo?: string | null;
  pct_confianca?: number | null;
  payload?: Record<string, unknown> | null;
}

export interface ResultadoCessao {
  en_status_retorno: StatusRetornoPre;
  detail_cessoes: CessaoItem[];
}

export type ResultadoPre = ResultadoDocumento | ResultadoAdvogado | ResultadoCessao;

export interface RetornoPre {
  schema_version?: number;
  tipo: "pre_enriquecimento";
  id_mensagem: string;
  /** Fala do WORKER: `erro` = não conseguiu rodar. → `importacao_credor.en_status='falhou'`. */
  en_status: "concluido" | "erro";
  erro?: string | null;
  cod_versao?: string | null;
  /** → `importacao_credor.dt_conclusao` E `enriquecimento_consulta.dt_consulta`. */
  dt_fim: string;
  /** Ausente quando `en_status='erro'`: não houve resultado, e inventar um registraria fato falso. */
  resultado?: ResultadoPre;
  /** Não pertence ao envelope de saída — ver a checagem de fronteira em `interpretarRetorno`. */
  st_simulacao?: boolean;
}

/** `detail_cessoes` presente ⇒ cessão. É o discriminador que o retorno permite (não vem `en_enrichment`). */
export function ehCessao(r: ResultadoPre): r is ResultadoCessao {
  return Object.prototype.hasOwnProperty.call(r, "detail_cessoes");
}

export function ehAdvogado(r: ResultadoPre): r is ResultadoAdvogado {
  return !ehCessao(r) && r.en_atributo === "advogado";
}

// ─────────────────────────────────────────────────────────────────────────────
// ENRIQUECIMENTO — inalterado pela D-075 (a D-069 governa)
// ─────────────────────────────────────────────────────────────────────────────

export interface AchadoRecebido {
  en_atributo: string;
  valor?: string | null;
  payload?: unknown;
  pct_confianca: number | string | null;
  nr_score?: number | null;
  cod_origem?: string | null;
  dt_observacao: string;
  id_credito?: string | null;
}

export interface ConsultaRecebida {
  /** A `sigla` da tabela `fornecedor`. Sigla desconhecida é ERRO, nunca fornecedor novo. */
  fornecedor: string;
  servico?: string | null;
  en_finalidade?: "contato" | "score" | "prospeccao" | null;
  cod_lake?: string | null;
  en_status_retorno: "sucesso" | "inconclusivo" | "erro";
  nr_registros: number | null;
  resumo?: string | null;
  vl_custo?: string | null;
  dt_consulta: string;
  cod_versao?: string | null;
  erro?: string | null;
  achados: AchadoRecebido[];
}

export interface RetornoEnriq {
  schema_version: number;
  tipo: "enriquecimento";
  id_mensagem: string;
  id_lote: string;
  id_credor: string | null;
  id_credito?: string | null;
  id_pessoa: string;
  en_status: "concluido" | "falhou";
  erro?: string | null;
  cod_versao?: string | null;
  dt_inicio: string;
  dt_fim: string;
  consultas: ConsultaRecebida[];
  is_draft?: boolean;
}

export type Retorno = RetornoPre | RetornoEnriq;

// ─────────────────────────────────────────────────────────────────────────────

const ajv = new Ajv2020({
  allErrors: true,
  // `strict: false` porque os schemas carregam `description`/`examples` ricos. Eles são documentação
  // do contrato, não ruído: reprová-los aqui empurraria alguém a apagá-los para o worker subir.
  strict: false,
  schemas: [comum, preEnriquecimento, enriquecimento],
});
addFormats(ajv);

/**
 * Resolve o validador do `#/$defs/output` de um dos contratos.
 *
 * Exportado para o teste alcançar o guard: se o `$defs/output` for renomeado no crm-backend, este
 * worker leria um lugar que não existe — e um `undefined` silencioso viraria "aceita tudo", o pior
 * desfecho num validador. Falhar no BOOT é o certo.
 */
export function validadorDe(arquivo: string) {
  const uri = `https://reasset.com.br/contratos/${arquivo}.schema.json#/$defs/output`;
  const validar = ajv.getSchema(uri);
  if (!validar) throw new Error(`contrato não encontrado: ${uri}`);
  return validar;
}

/** Uma entrada do `errors` do Ajv em texto. Isolado para ser testável sem forjar um schema. */
export function descreverErro(erro: { instancePath?: string; message?: string }): string {
  return `${erro.instancePath || "/"} ${erro.message ?? "inválido"}`;
}

const validadores: Record<Etapa, ReturnType<typeof validadorDe>> = {
  pre_enriquecimento: validadorDe("pre-enriquecimento"),
  enriquecimento: validadorDe("enriquecimento"),
};

/**
 * Interpreta o corpo cru de uma mensagem da fila de retorno.
 *
 * A ordem das checagens é deliberada:
 *
 * 1. **JSON parseável** — corpo truncado não é falha de negócio.
 * 2. **`tipo` conhecido** — é ele que escolhe o validador; sem ele não há contra o que validar. É
 *    também o discriminador das duas formas de envelope (D-075).
 * 3. **flag de simulação recusada com mensagem própria.** O nome mudou com a D-075 (`st_simulacao`
 *    no pré, `is_draft` no enriquecimento) e os DOIS são checados, porque um worker que ecoe o
 *    campo do outro contrato merece um erro que diga o motivo. Escopo: a flag é campo da ENTRADA, e
 *    quem a D-068 encarrega de recusá-la é o worker de EXTRAÇÃO. No retorno ela não deveria existir
 *    — os dois `output` recusam campo extra —, então isto é defesa de fronteira: a recusa vem com o
 *    motivo ("simulação gravaria de verdade") em vez de um erro genérico de propriedade não
 *    avaliada, e vem antes do schema para o motivo sobreviver num payload quebrado.
 */
export function interpretarRetorno(corpo: string): Retorno {
  let bruto: unknown;
  try {
    bruto = JSON.parse(corpo);
  } catch {
    throw new ContratoInvalidoError("corpo da mensagem não é JSON válido");
  }

  if (typeof bruto !== "object" || bruto === null) {
    throw new ContratoInvalidoError("corpo da mensagem não é um objeto");
  }

  const candidato = bruto as { tipo?: unknown; st_simulacao?: unknown; is_draft?: unknown };

  if (candidato.tipo !== "pre_enriquecimento" && candidato.tipo !== "enriquecimento") {
    throw new ContratoInvalidoError(
      `tipo desconhecido: ${JSON.stringify(candidato.tipo)} (espera pre_enriquecimento | enriquecimento)`,
    );
  }

  if (candidato.st_simulacao === true || candidato.is_draft === true) {
    throw new ContratoInvalidoError(
      "simulação recusada: o simulador de (pré-)enriquecimento não existe. " +
        "Aceitar e ignorar faria uma simulação gravar de verdade (D-068).",
    );
  }

  const validar = validadores[candidato.tipo];
  if (!validar(bruto)) {
    // O `?? []` existe só para o tipo: o Ajv declara `errors: ErrorObject[] | null` e, quando a
    // validação FALHA, ele sempre popula.
    /* v8 ignore next */
    const detalhes = (validar.errors ?? []).map(descreverErro);
    throw new ContratoInvalidoError(
      `payload não casa com o contrato de ${candidato.tipo}`,
      detalhes,
    );
  }

  return bruto as Retorno;
}
