// MOCK do RETORNO de (pré-)enriquecimento — a metade do fluxo que é papel dos workers externos.
//
// O par de `crm-backend/scripts/mock-enriquecimento.ts`: aquele cria as rodadas e as mensagens; este
// faz o que o robô de extração e os bureaus fariam — devolver um payload de retorno por mensagem
// `publicado`. Rode aquele primeiro.
//
// O QUE É MOCK AQUI É SÓ O PAYLOAD. Tudo o que acontece depois dele é o caminho de produção, sem
// atalho: cada payload passa por `interpretarRetorno` (valida contra os contratos publicados em
// `crm-backend/modelo/contratos/`, exatamente como o consumidor da fila faz) e por `salvarRetorno`
// (o gravador real — mesma normalização, mesma derivação da D-068, mesma transação, mesma trilha).
// É o que impede o mock de gravar uma forma que o worker de verdade nunca produziria: se o contrato
// mudar no backend, este script quebra junto com o worker.
//
// O QUE FICA DE FORA, de propósito:
// · a SQS. Não há fila aqui — `interpretarRetorno` recebe o corpo direto. O transporte é o
//   `consumidor.ts`, e exercitá-lo é outro exercício (LocalStack + `make fila`);
// · a promoção ao canônico. O retorno pousa no inbox `pessoa_informacao`, que é onde o worker real
//   para. O gate de validação é do backend e ainda não existe.
//
// Conexão: usa `DATABASE_URL`/`DB_SCHEMA` do ambiente; sem elas, lê o `.env` do `crm-backend` irmão
// — em dev o banco é o dele (é de lá que sai o schema). Roda como o usuário daquele `.env` (o dono),
// não como o role restrito: a prova do GRANT é outra (REQ-0412, `scripts/provar-grant.sql`).
//
//   npm run mock:retorno            # grava o retorno de toda mensagem `publicado` do mock
//   npm run mock:retorno -- --seco  # só imprime o que faria (valida o contrato e não escreve)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ETIQUETA = "[MOCK]";
const SECO = process.argv.includes("--seco");
const VERSAO_ROBO = "2.1.0-mock";
const VERSAO_ENRIQ = "1.4.2-mock";

/**
 * Popula o que falta a partir do `.env` do crm-backend irmão. Só as duas chaves de conexão.
 *
 * `NODE_ENV` entra como `production` quando ausente, e não é detalhe: o logger do crm-backend só
 * liga o transport `pino-pretty` em `development`, e este repo não tem essa dependência — nem
 * precisa, porque o worker roda em produção. Sem isto o import do pool morre no boot.
 */
function carregarEnvDoBackend(): void {
  process.env.NODE_ENV ??= "production";
  process.env.LOG_LEVEL ??= "warn";
  if (process.env.DATABASE_URL) return;
  const caminho = resolve(__dirname, "..", "..", "crm-backend", ".env");
  let bruto: string;
  try {
    bruto = readFileSync(caminho, "utf8");
  } catch {
    throw new Error(
      `sem DATABASE_URL no ambiente e sem ${caminho} para herdar. ` +
        `Exporte DATABASE_URL/DB_SCHEMA ou rode dentro do workspace.`,
    );
  }
  for (const linha of bruto.split("\n")) {
    const m = /^\s*(DATABASE_URL|DB_SCHEMA)\s*=\s*(.*)\s*$/.exec(linha);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  if (!process.env.DATABASE_URL) throw new Error(`${caminho} não define DATABASE_URL`);
}

interface Mensagem {
  id_mensagem: string;
  id_lote: string;
  en_tipo: "pre_enriquecimento" | "enriquecimento";
  en_modo: string;
  id_credor: string;
  id_pessoa: string;
  nome: string | null;
  nr_processo: string | null;
  creditos: string[] | null;
  /** Posição da mensagem DENTRO da rodada — é ela que escolhe o cenário. */
  pos: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Geradores determinísticos — o mesmo índice produz sempre o mesmo dado, para
// duas rodadas do mock não mudarem a tela por baixo de quem está olhando.
// ─────────────────────────────────────────────────────────────────────────────

/** CPF com dígitos verificadores VÁLIDOS a partir de uma semente. */
function cpf(semente: number): string {
  const base = String(10_000_000_000 + ((semente * 7_654_321) % 899_999_999)).slice(0, 9);
  const dv = (nums: string, peso: number): number => {
    const soma = [...nums].reduce((a, d, i) => a + Number(d) * (peso - i), 0);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = dv(base, 10);
  const d2 = dv(base + d1, 11);
  return `${base}${d1}${d2}`;
}

function cnpj(semente: number): string {
  return String(10_000_000_000_000 + ((semente * 987_654_321) % 89_999_999_999)).slice(0, 14);
}

function iso(diasAtras: number, minuto: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - diasAtras);
  d.setUTCHours(14, minuto, 0, 0);
  return d.toISOString();
}

/**
 * `nr_processo` como o contrato o exige: 20 DÍGITOS, sem máscara.
 *
 * `caso.nr_processo` guarda a forma formatada do CNJ (`0260447-16.2010.8.19.0001`), e o contrato
 * reprova qualquer coisa fora de `^\d{20}$`. Não é detalhe do mock: é o mesmo de-para que o disparo
 * de verdade (REQ-0411) vai precisar fazer ao montar a mensagem de entrada.
 */
function processoCru(formatado: string | null): string {
  const so = (formatado ?? "").replace(/\D/g, "");
  return so.length === 20 ? so : "00023821219968260032";
}

/** Telefone brasileiro em E.164 — o contrato exige `^\+\d{8,15}$` (dedup depende disso). */
function telefone(semente: number, movel: boolean): string {
  const ddd = 11 + (semente % 20);
  const n = String(20_000_000 + ((semente * 131_071) % 79_999_999));
  return movel ? `+55${ddd}9${n}` : `+55${ddd}${n}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRÉ-ENRIQUECIMENTO — um `resultado` por mensagem (D-075)
// ─────────────────────────────────────────────────────────────────────────────

function retornoPre(m: Mensagem, diasAtras: number): Record<string, unknown> {
  const envelope = {
    schema_version: 1,
    tipo: "pre_enriquecimento",
    id_mensagem: m.id_mensagem,
    en_status: "concluido",
    erro: null,
    cod_versao: VERSAO_ROBO,
    dt_fim: iso(diasAtras, 30 + m.pos),
  };
  const processo = processoCru(m.nr_processo);

  if (m.en_modo === "cpf" || m.en_modo === "all") {
    switch (m.pos % 5) {
      case 0:
        return {
          ...envelope,
          resultado: {
            en_status_retorno: "encontrado",
            en_atributo: "cpf",
            valor: cpf(m.pos + 1),
            nr_folha: 112 + m.pos,
            nr_processo: processo,
            pct_confianca: 0.94,
            payload: {
              nr_pagina: 118 + m.pos,
              metodo_match: "exact",
              nr_paginas_votantes: 3,
              st_mock: true,
            },
          },
        };
      case 1:
        // Confiança baixa + `fuzzy`: é o caso que a revisão humana 100% existe para pegar. O dígito
        // trocado é DE PROPÓSITO — o robô erra ~20–30% assim, quase sempre por OCR.
        return {
          ...envelope,
          resultado: {
            en_status_retorno: "encontrado",
            en_atributo: "cpf",
            valor: cpf(m.pos + 1).slice(0, 10) + "0",
            nr_folha: 88,
            nr_processo: processo,
            pct_confianca: 0.58,
            payload: { nr_pagina: 91, metodo_match: "fuzzy", fuzzy_score: 0.71, st_mock: true },
          },
        };
      case 2:
        return {
          ...envelope,
          resultado: {
            en_status_retorno: "encontrado",
            en_atributo: "cnpj",
            valor: cnpj(m.pos + 3),
            nr_folha: 204,
            nr_processo: processo,
            pct_confianca: 0.91,
            payload: { nr_pagina: 210, metodo_match: "normalized", st_mock: true },
          },
        };
      case 3:
        // Rodou e não achou: a consulta EXISTE (`inconclusivo`) e nenhuma afirmação nasce. É o que
        // justifica o credor inconclusivo e o reprocessamento.
        return {
          ...envelope,
          resultado: { en_status_retorno: "nao_encontrado", en_atributo: "cpf", valor: null },
        };
      default:
        // O worker não conseguiu rodar → `importacao_credor.en_status='falhou'`.
        return {
          ...envelope,
          en_status: "erro",
          erro: "OCR indisponível: timeout de 120s ao buscar as páginas do processo",
        };
    }
  }

  if (m.en_modo === "oab") {
    switch (m.pos % 4) {
      case 0:
        return {
          ...envelope,
          resultado: {
            en_status_retorno: "encontrado",
            en_atributo: "advogado",
            oab_uf: `${112233 + m.pos}-SP`,
            nome_advogado: "Maria Souza Lima",
            nome_sociedade: "Souza Lima Advogados Associados",
            nr_folha: 14,
            nr_processo: processo,
            pct_confianca: 0.89,
            payload: {
              nr_pagina: 18,
              metodo_match: "vision",
              cnpj_advogado: null,
              prompt_version: "v3",
              st_mock: true,
            },
          },
        };
      case 1:
        return {
          ...envelope,
          resultado: {
            en_status_retorno: "encontrado",
            en_atributo: "advogado",
            oab_uf: `${45678 + m.pos}-RJ`,
            nome_advogado: "João Baptista Ferreira",
            nome_sociedade: null,
            nr_folha: 9,
            nr_processo: processo,
            pct_confianca: 0.76,
            payload: { nr_pagina: 11, metodo_match: "exact", st_mock: true },
          },
        };
      case 2:
        // `parcial` = achou o advogado, não o que se procurava do credor. Vira
        // `enriquecimento_consulta.en_status_retorno='parcial'` (REQ-0413).
        return {
          ...envelope,
          resultado: {
            en_status_retorno: "parcial",
            en_atributo: "advogado",
            oab_uf: `${330011 + m.pos}-MG`,
            nome_advogado: "Escritório não identificado — procuração ilegível",
            nome_sociedade: null,
            nr_folha: 41,
            nr_processo: processo,
            pct_confianca: 0.52,
            payload: { nr_pagina: 44, metodo_match: "containment", st_mock: true },
          },
        };
      default:
        return {
          ...envelope,
          resultado: { en_status_retorno: "nao_encontrado", en_atributo: "advogado", oab_uf: null },
        };
    }
  }

  // modo `cessao` — o único achado que é fato de CRÉDITO, e o mais incerto que entra no CRM.
  const credito = m.creditos?.[0];
  const credito2 = m.creditos?.[1];
  if (!credito) {
    return { ...envelope, resultado: { en_status_retorno: "nao_encontrado", detail_cessoes: [] } };
  }
  switch (m.pos % 3) {
    case 0:
      return {
        ...envelope,
        resultado: {
          en_status_retorno: "encontrado",
          detail_cessoes: [
            {
              id_credito: credito,
              cedente: { nome: m.nome ?? "CEDENTE NÃO IDENTIFICADO", documento: cpf(m.pos + 11) },
              cessionario: { nome: "COMPRADORA DE CREDITOS LTDA", documento: cnpj(m.pos + 21) },
              advogado_cessionario: {
                nome: "Ana Paula Rezende",
                oab: "223344",
                uf: "SP",
                sociedade: "Rezende & Associados",
                cnpj_sociedade: null,
              },
              tipo_cessao: "integral",
              vl_cedido: "184320.55",
              vl_pago: "55296.16",
              pct_cedido: null,
              data_cessao: "2019-11-08",
              data_protocolo: "2019-12-02",
              notas: "cessão integral homologada, com anuência do administrador judicial",
              herdeiros: null,
              nr_folha: 212,
              nr_processo: processo,
              pct_confianca: 0.81,
              payload: { nr_pagina: 219, metodo_match: "vision", st_mock: true },
            },
          ],
        },
      };
    case 1:
      return {
        ...envelope,
        resultado: {
          en_status_retorno: "encontrado",
          detail_cessoes: [
            {
              id_credito: credito,
              cedente: { nome: m.nome ?? "CEDENTE NÃO IDENTIFICADO", documento: cpf(m.pos + 13) },
              cessionario: {
                nome: "FUNDO DE INVESTIMENTO EM DIREITOS CREDITORIOS ALFA",
                documento: cnpj(m.pos + 31),
              },
              advogado_cessionario: null,
              tipo_cessao: "parcial",
              vl_cedido: "61440.18",
              vl_pago: "18432.05",
              pct_cedido: 0.3,
              data_cessao: "2021-05-14",
              data_protocolo: "2021-06-01",
              notas: "cessão parcial de 30%; espólio com dois herdeiros habilitados",
              herdeiros: [
                { nome: "Herdeiro Um da Silva", cpf: cpf(m.pos + 41), percentual_heranca: 0.5 },
                { nome: "Herdeira Dois da Silva", cpf: cpf(m.pos + 51), percentual_heranca: 0.5 },
              ],
              nr_folha: 318,
              nr_processo: processo,
              pct_confianca: 0.64,
              payload: { nr_pagina: 322, metodo_match: "vision", st_mock: true },
            },
            ...(credito2
              ? [
                  {
                    id_credito: credito2,
                    cedente: { nome: m.nome ?? null, documento: null },
                    cessionario: {
                      nome: "COMPRADORA DE CREDITOS LTDA",
                      documento: cnpj(m.pos + 61),
                    },
                    advogado_cessionario: null,
                    tipo_cessao: "integral",
                    vl_cedido: "22110.00",
                    vl_pago: null,
                    pct_cedido: null,
                    data_cessao: "2021-05-14",
                    data_protocolo: null,
                    notas: "segundo crédito do mesmo instrumento",
                    herdeiros: null,
                    nr_folha: 319,
                    nr_processo: processo,
                    pct_confianca: 0.6,
                    payload: { nr_pagina: 323, metodo_match: "vision", st_mock: true },
                  },
                ]
              : []),
          ],
        },
      };
    default:
      return {
        ...envelope,
        resultado: { en_status_retorno: "nao_encontrado", detail_cessoes: [] },
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ENRIQUECIMENTO — `consultas[]` → `achados[]`, uma linha por chamada COBRADA
// ─────────────────────────────────────────────────────────────────────────────

function retornoEnriq(m: Mensagem, diasAtras: number): Record<string, unknown> {
  const dt = (min: number): string => iso(diasAtras, min);
  const envelope = {
    schema_version: 1,
    tipo: "enriquecimento",
    id_mensagem: m.id_mensagem,
    id_lote: m.id_lote,
    id_credor: m.id_credor,
    id_credito: null,
    id_pessoa: m.id_pessoa,
    en_status: "concluido",
    erro: null,
    cod_versao: VERSAO_ENRIQ,
    dt_inicio: dt(1 + m.pos),
    dt_fim: dt(6 + m.pos),
  };

  if (m.en_modo === "contato" || m.en_modo === "all") {
    switch (m.pos % 5) {
      case 0:
        return {
          ...envelope,
          consultas: [
            {
              fornecedor: "lemit",
              servico: null,
              en_finalidade: "contato",
              cod_lake: null,
              en_status_retorno: "sucesso",
              nr_registros: 3,
              resumo: "2 telefones + 1 e-mail",
              vl_custo: "0.18",
              dt_consulta: dt(2 + m.pos),
              cod_versao: null,
              erro: null,
              achados: [
                {
                  en_atributo: "telefone",
                  valor: telefone(m.pos + 1, true),
                  pct_confianca: 0.84,
                  nr_score: 62,
                  cod_origem: `lemit:ph:${880000 + m.pos}`,
                  dt_observacao: dt(2 + m.pos),
                  payload: {
                    en_tipo: "movel",
                    st_whatsapp: true,
                    st_hotphone: true,
                    st_opt_out: false,
                    dt_ultimo_contato: "2026-06-11",
                    nr_ranking: 62,
                  },
                },
                {
                  en_atributo: "telefone",
                  valor: telefone(m.pos + 2, false),
                  pct_confianca: 0.47,
                  nr_score: 18,
                  cod_origem: `lemit:ph:${880100 + m.pos}`,
                  dt_observacao: dt(2 + m.pos),
                  payload: { en_tipo: "fixo", st_whatsapp: false, st_hotphone: false },
                },
                {
                  en_atributo: "email",
                  valor: `credor.mock${m.pos}@exemplo.com.br`,
                  pct_confianca: 0.66,
                  nr_score: null,
                  cod_origem: `lemit:em:${55100 + m.pos}`,
                  dt_observacao: dt(2 + m.pos),
                  payload: null,
                },
              ],
            },
            {
              fornecedor: "assertiva",
              servico: null,
              en_finalidade: "contato",
              cod_lake: null,
              en_status_retorno: "inconclusivo",
              nr_registros: 0,
              resumo: "nada",
              vl_custo: "0.11",
              dt_consulta: dt(4 + m.pos),
              cod_versao: null,
              erro: null,
              achados: [],
            },
            {
              fornecedor: "bigdatacorp",
              servico: null,
              en_finalidade: "contato",
              cod_lake: null,
              en_status_retorno: "sucesso",
              nr_registros: 1,
              resumo: "1 endereço",
              vl_custo: "0.34",
              dt_consulta: dt(5 + m.pos),
              cod_versao: null,
              erro: null,
              achados: [
                {
                  en_atributo: "endereco",
                  valor: null,
                  pct_confianca: 0.72,
                  nr_score: null,
                  cod_origem: `bigdata:addr:${9100 + m.pos}`,
                  dt_observacao: dt(5 + m.pos),
                  payload: {
                    cep: "01310100",
                    logradouro: "Avenida Paulista",
                    numero: String(1000 + m.pos),
                    complemento: "conj. 42",
                    bairro: "Bela Vista",
                    municipio: "São Paulo",
                    en_uf: "SP",
                    pais: "Brasil",
                    en_tipo: "residencial",
                  },
                },
              ],
            },
          ],
        };
      case 1:
        return {
          ...envelope,
          consultas: [
            {
              fornecedor: "lemit",
              servico: null,
              en_finalidade: "contato",
              cod_lake: null,
              en_status_retorno: "sucesso",
              nr_registros: 1,
              resumo: "1 telefone (whatsapp)",
              vl_custo: "0.18",
              dt_consulta: dt(2 + m.pos),
              cod_versao: null,
              erro: null,
              achados: [
                {
                  en_atributo: "telefone",
                  valor: telefone(m.pos + 7, true),
                  pct_confianca: 0.91,
                  nr_score: 71,
                  cod_origem: `lemit:ph:${881000 + m.pos}`,
                  dt_observacao: dt(2 + m.pos),
                  payload: {
                    en_tipo: "movel",
                    st_whatsapp: true,
                    st_hotphone: true,
                    st_opt_out: false,
                    nr_ranking: 71,
                  },
                },
              ],
            },
            {
              fornecedor: "3c",
              servico: null,
              en_finalidade: "contato",
              cod_lake: null,
              en_status_retorno: "erro",
              nr_registros: 0,
              resumo: "timeout após 30s",
              vl_custo: null,
              dt_consulta: dt(3 + m.pos),
              cod_versao: null,
              erro: "ReadTimeout: POST /discador/consulta",
              achados: [],
            },
          ],
        };
      case 2:
        // Óbito: o achado de maior consequência da etapa (aciona espólio/herdeiros).
        return {
          ...envelope,
          consultas: [
            {
              fornecedor: "assertiva",
              servico: null,
              en_finalidade: "contato",
              cod_lake: null,
              en_status_retorno: "sucesso",
              nr_registros: 2,
              resumo: "1 e-mail + óbito",
              vl_custo: "0.11",
              dt_consulta: dt(2 + m.pos),
              cod_versao: null,
              erro: null,
              achados: [
                {
                  en_atributo: "email",
                  valor: `espolio.mock${m.pos}@exemplo.com.br`,
                  pct_confianca: 0.55,
                  nr_score: null,
                  cod_origem: `assertiva:em:${7700 + m.pos}`,
                  dt_observacao: dt(2 + m.pos),
                  payload: null,
                },
                {
                  en_atributo: "obito",
                  valor: "true",
                  pct_confianca: 0.88,
                  nr_score: null,
                  cod_origem: `assertiva:ob:${310 + m.pos}`,
                  dt_observacao: dt(2 + m.pos),
                  payload: { dt_obito: "2023-02-17" },
                },
              ],
            },
          ],
        };
      case 3:
        // Todos inconclusivos: o credor que sai da rodada sem contato — custo gasto sem retorno.
        return {
          ...envelope,
          consultas: [
            {
              fornecedor: "lemit",
              servico: null,
              en_finalidade: "contato",
              cod_lake: null,
              en_status_retorno: "inconclusivo",
              nr_registros: 0,
              resumo: "nada",
              vl_custo: "0.18",
              dt_consulta: dt(2 + m.pos),
              cod_versao: null,
              erro: null,
              achados: [],
            },
            {
              fornecedor: "assertiva",
              servico: null,
              en_finalidade: "contato",
              cod_lake: null,
              en_status_retorno: "inconclusivo",
              nr_registros: 0,
              resumo: "nada",
              vl_custo: "0.11",
              dt_consulta: dt(3 + m.pos),
              cod_versao: null,
              erro: null,
              achados: [],
            },
          ],
        };
      default:
        // O worker não rodou. `falhou` já é o vocabulário do transporte no enriquecimento.
        return {
          ...envelope,
          en_status: "falhou",
          erro: "cluster Databricks sem slot: job 41827 abortado após 3 tentativas",
          consultas: [],
        };
    }
  }

  if (m.en_modo === "score") {
    if (m.pos % 2 === 0) {
      return {
        ...envelope,
        consultas: [
          {
            fornecedor: "proscore",
            servico: "score_credor",
            en_finalidade: "score",
            cod_lake: `66b0f2a41c9d4400009${(1000 + m.pos).toString(16)}`,
            en_status_retorno: "sucesso",
            // `nr_registros` é `const 0` e `achados` é VAZIO por desenho em score/prospeccao: a
            // captura é crua e vai inteira para o lake. O score em si não é afirmação sobre a
            // pessoa — quem o recebe é `credor.nr_score`, que este worker não escreve.
            nr_registros: 0,
            resumo: `score ${640 + m.pos * 13}`,
            vl_custo: "0.90",
            dt_consulta: dt(2 + m.pos),
            cod_versao: VERSAO_ENRIQ,
            erro: null,
            achados: [],
          },
        ],
      };
    }
    return {
      ...envelope,
      consultas: [
        {
          fornecedor: "proscore",
          servico: "score_credor",
          en_finalidade: "score",
          cod_lake: null,
          en_status_retorno: "erro",
          nr_registros: 0,
          resumo: "HTTP 503 do fornecedor",
          vl_custo: null,
          dt_consulta: dt(2 + m.pos),
          cod_versao: VERSAO_ENRIQ,
          erro: "ServiceUnavailable: GET /score/v2 (3 tentativas)",
          achados: [],
        },
      ],
    };
  }

  // modo `prospeccao` — a CredValue cobra POR SERVIÇO: seis chamadas são seis linhas de custo.
  const servicos = ["creditos", "processos", "socios"];
  return {
    ...envelope,
    consultas: servicos.map((servico, i) => {
      const falha = m.pos % 2 === 1 && servico === "processos";
      return {
        fornecedor: "credvalue",
        servico,
        en_finalidade: "prospeccao",
        cod_lake: falha ? null : `66b0f2a41c9d44000${(0xa1b2c0 + m.pos * 8 + i).toString(16)}`,
        en_status_retorno: falha ? "erro" : "sucesso",
        nr_registros: 0,
        resumo: falha ? "timeout após 30s" : "capturado no lake",
        vl_custo: falha ? null : "1.40",
        dt_consulta: dt(2 + m.pos + i),
        cod_versao: VERSAO_ENRIQ,
        erro: falha ? `ReadTimeout: /${servico}/consulta` : null,
        achados: [],
      };
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  carregarEnvDoBackend();

  // Import DEPOIS do env: o pool do crm-backend é criado no load do módulo e lê a config ali.
  const { pool } = await import("crm-backend/database/db");
  const { interpretarRetorno } = await import("../src/contrato");
  const { salvarRetorno } = await import("../src/salvar");

  const { rows } = await pool.query<Mensagem & { dias_atras: number }>(
    `SELECT ic.id AS id_mensagem, i.id AS id_lote, i.en_tipo, i.en_modo,
            ic.id_credor, cr.id_pessoa, p.nome, c.nr_processo,
            (SELECT array_agg(cd.id ORDER BY cd.vl_estimado_final_atual DESC NULLS LAST, cd.id)
               FROM credito cd
              WHERE cd.id_credor = ic.id_credor AND cd.st_excluido = false) AS creditos,
            GREATEST(0, EXTRACT(DAY FROM NOW() - i.dt_inicio))::int AS dias_atras,
            -- A posição ordena por CREDOR, e não pela data/uuid da linha: as mensagens de uma rodada
            -- nascem na mesma transação (mesmo now()), então o desempate cairia no uuid e o cenário de
            -- cada credor mudaria a cada recriação do disparo. Por credor, o mesmo credor recebe
            -- sempre o mesmo cenário — é o que mantém a tela estável entre rodadas.
            (ROW_NUMBER() OVER (PARTITION BY i.id ORDER BY ic.id_credor) - 1)::int AS pos
       FROM importacao_credor ic
       JOIN importacao i ON i.id = ic.id_importacao
       JOIN credor cr ON cr.id = ic.id_credor
       JOIN pessoa p ON p.id = cr.id_pessoa
       LEFT JOIN caso c ON c.id = i.id_caso
      WHERE i.observacoes LIKE $1
        AND ic.en_status = 'publicado'
        AND ic.st_excluido = false
      ORDER BY i.dt_inicio, ic.id_credor`,
    [`${ETIQUETA}%`],
  );

  if (rows.length === 0) {
    // Duas ausências bem diferentes, e confundi-las manda a pessoa para o comando errado: ou o
    // disparo nunca rodou, ou ele rodou e todas as mensagens já foram fechadas por este script.
    const { rows: existe } = await pool.query<{ rodadas: string; abertas: string }>(
      `SELECT count(DISTINCT i.id)::text AS rodadas,
              count(ic.id) FILTER (WHERE ic.en_status = 'pendente')::text AS abertas
         FROM importacao i
         LEFT JOIN importacao_credor ic ON ic.id_importacao = i.id
        WHERE i.observacoes LIKE $1`,
      [`${ETIQUETA}%`],
    );
    const rodadas = Number(existe[0]?.rodadas ?? "0");
    console.log(
      rodadas === 0
        ? "nenhuma rodada etiquetada [MOCK] neste banco. " +
            "Rode primeiro: cd ../crm-backend && npm run mock:enriquecimento"
        : `${rodadas} rodada(s) [MOCK] no banco e nenhuma mensagem \`publicado\`: os retornos já foram ` +
            `gravados. Para refazer do zero: cd ../crm-backend && npm run mock:enriquecimento`,
    );
    await pool.end();
    return;
  }

  console.log(
    `${rows.length} mensagem(ns) publicada(s)${SECO ? " — modo seco, nada será gravado" : ""}\n`,
  );

  const placar = { gravadas: 0, repetidas: 0, consultas: 0, achados: 0, recusadas: 0 };
  for (const m of rows) {
    const corpo =
      m.en_tipo === "pre_enriquecimento"
        ? retornoPre(m, m.dias_atras)
        : retornoEnriq(m, m.dias_atras);
    const rotulo = `${m.en_tipo}/${m.en_modo} #${m.pos} ${(m.nome ?? "").slice(0, 28)}`;
    try {
      // Valida contra o contrato PUBLICADO, como o consumidor da fila faz. Payload que não casa
      // morre aqui — é o que impede o mock de gravar forma que o worker real não produziria.
      const retorno = interpretarRetorno(JSON.stringify(corpo));
      if (SECO) {
        console.log(`  ✓ contrato ok · ${rotulo}`);
        continue;
      }
      const r = await salvarRetorno(retorno);
      placar.gravadas += r.jaProcessada ? 0 : 1;
      placar.repetidas += r.jaProcessada ? 1 : 0;
      placar.consultas += r.consultasGravadas;
      placar.achados += r.achadosGravados;
      console.log(
        `  ${r.jaProcessada ? "=" : "✓"} ${rotulo} → ${r.consultasGravadas} consulta(s) · ${r.achadosGravados} achado(s)`,
      );
    } catch (err) {
      placar.recusadas += 1;
      console.error(`  ✗ ${rotulo} → ${(err as Error).message}`);
      if ((err as { detalhes?: string[] }).detalhes?.length) {
        for (const d of (err as { detalhes: string[] }).detalhes) console.error(`      ${d}`);
      }
    }
  }

  console.log(
    `\n${placar.gravadas} mensagem(ns) gravada(s) · ${placar.repetidas} já processada(s) · ` +
      `${placar.consultas} consulta(s) · ${placar.achados} afirmação(ões) · ${placar.recusadas} recusada(s)`,
  );

  // ONDE VER. Sem isto o mock termina dizendo "gravei" e a pessoa abre a tela de enriquecimento —
  // que ordena por nome entre ~58 mil credores — e não encontra nada. A lista de leads NÃO é o
  // caminho: o atalho é o detalhe da parte, cuja rota é `/partes/detalhe?id=<id_pessoa>` (FE, um
  // export estático não gera rota para uuid do banco).
  if (!SECO && placar.achados > 0) {
    const { rows: alvos } = await pool.query<{ nome: string; id_pessoa: string; achados: string }>(
      `SELECT p.nome, p.id AS id_pessoa,
              string_agg(DISTINCT pi.en_atributo, ', ' ORDER BY pi.en_atributo) AS achados
         FROM pessoa_informacao pi
         JOIN pessoa p ON p.id = pi.id_pessoa
         JOIN importacao i ON i.id = pi.id_importacao
        WHERE i.observacoes LIKE $1 AND pi.st_excluido = false
        GROUP BY p.nome, p.id
        ORDER BY count(*) DESC, p.nome
        LIMIT 8`,
      [`${ETIQUETA}%`],
    );
    console.log("\nonde ver (detalhe da parte · /partes/detalhe?id=<id>):");
    for (const a of alvos) {
      console.log(`  ${(a.nome ?? "").slice(0, 34).padEnd(36)} ${a.id_pessoa}  ${a.achados}`);
    }
  }

  await pool.end();
  if (placar.recusadas > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
