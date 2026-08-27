import { runWithContext, setActor } from "crm-backend/lib/requestContext";
import { withTransaction } from "crm-backend/database/transaction";
import { retornoEnriquecimentoRepository } from "crm-backend/repositories";
import type { Retorno } from "./contrato";
import {
  RetornoImprocessavelError,
  normalizarEnriquecimento,
  normalizarPre,
  siglasDoRetorno,
  transporteDoRetorno,
} from "./normalizar";

// O GRAVADOR — a ponte de escrita do modelo (BE-074).
//
// Tudo o que é REGRA vem importado do crm-backend: as GUCs da trilha (`runWithContext`/`setActor`,
// D-010), a transação (`withTransaction`, que aplica o contexto) e as escritas
// (`retornoEnriquecimentoRepository`, que É o espelho do GRANT). O de-para de payload vive em
// `normalizar.ts`. O que sobra aqui é a ORQUESTRAÇÃO: a ordem, o que aborta, e o que conta como
// reprocessamento em vez de erro.
//
// Este arquivo não sabe a forma do payload — depois da D-075 são duas, e é justamente por isso que
// ele não deve saber.

export { RetornoImprocessavelError };

export interface ResultadoGravacao {
  idMensagem: string;
  etapa: Retorno["tipo"];
  /** `true` quando a mensagem já estava `concluido` — entrega repetida, não trabalho novo. */
  jaProcessada: boolean;
  consultasGravadas: number;
  consultasRepetidas: number;
  achadosGravados: number;
  achadosRepetidos: number;
}

export interface Dependencias {
  repo: typeof retornoEnriquecimentoRepository;
  transacao: typeof withTransaction;
}

const dependenciasPadrao: Dependencias = {
  repo: retornoEnriquecimentoRepository,
  transacao: withTransaction,
};

/**
 * Grava um retorno já validado contra o contrato.
 *
 * **Uma mensagem = uma transação.** Consultas, afirmações e o fechamento da mensagem commitam
 * juntos: se qualquer parte falhar, a linha NÃO fica `concluido` com metade do retorno gravado — a
 * mensagem volta para a fila e a idempotência do banco absorve a repetição.
 */
export async function salvarRetorno(
  retorno: Retorno,
  deps: Dependencias = dependenciasPadrao,
): Promise<ResultadoGravacao> {
  const { repo, transacao } = deps;

  const contexto = await repo.contextoMensagem(retorno.id_mensagem);
  if (!contexto) {
    // Retorno de uma mensagem que não existe: ou o worker inventou o id, ou está falando com o
    // banco errado. Retentar não cria a linha.
    throw new RetornoImprocessavelError(
      `id_mensagem ${retorno.id_mensagem} não existe em importacao_credor`,
    );
  }

  const resultado: ResultadoGravacao = {
    idMensagem: retorno.id_mensagem,
    etapa: retorno.tipo,
    jaProcessada: false,
    consultasGravadas: 0,
    consultasRepetidas: 0,
    achadosGravados: 0,
    achadosRepetidos: 0,
  };

  // Entrega repetida de trabalho já fechado. A SQS é at-least-once, então isto é ESPERADO, não
  // anomalia: sair aqui poupa as N tentativas de INSERT que o banco rejeitaria de qualquer forma, e
  // mantém o `dt_conclusao` do primeiro processamento.
  if (contexto.en_status === "concluido") {
    return { ...resultado, jaProcessada: true };
  }

  // A pessoa vem do BANCO, não do payload. No pré o contrato nem a manda (o `id_mensagem` basta
  // para reencontrar rodada, credor e pessoa); no enriquecimento ela vem e o normalizador confere.
  if (!contexto.id_pessoa) {
    throw new RetornoImprocessavelError(
      `credor ${contexto.id_credor} não tem pessoa: uma afirmação sem sujeito não tem onde pousar`,
    );
  }

  // Resolver TODAS as siglas ANTES de abrir a transação. Sigla desconhecida é erro de configuração
  // (fornecedor não semeado), e semear fornecedor é decisão humana — nunca INSERT automático. Antes
  // da transação porque descobrir isso no meio deixaria o trabalho pela metade.
  const fornecedores = new Map<string, string>();
  for (const sigla of siglasDoRetorno(retorno)) {
    const id = await repo.resolverFornecedor(sigla);
    if (!id) {
      throw new RetornoImprocessavelError(
        `fornecedor "${sigla}" não está no catálogo — semear fornecedor é decisão humana, não INSERT do worker`,
      );
    }
    fornecedores.set(sigla, id);
  }

  const resolverSigla = (sigla: string): string => fornecedores.get(sigla)!;
  const linhas =
    retorno.tipo === "pre_enriquecimento"
      ? normalizarPre(retorno, contexto, resolverSigla(siglasDoRetorno(retorno)[0]!))
      : normalizarEnriquecimento(retorno, contexto, resolverSigla);

  // O ATOR: quem disparou a rodada. Sem publicá-lo, cada linha nasce em `sys_audit_log` sem ator —
  // o INSERT passa, a trilha fica anônima, e ninguém descobre até uma auditoria perguntar. Reusar o
  // `db.ts` dá as GUCs; saber QUEM é trabalho explícito, e é este bloco (BE-074).
  await runWithContext(
    {
      requestId: `crm-worker:${retorno.id_mensagem}`,
      ip: null,
      actorId: null,
      impersonadorId: null,
    },
    async () => {
      if (contexto.id_usuario_criacao) setActor(contexto.id_usuario_criacao);

      await transacao(async (client) => {
        const opts = { actorId: contexto.id_usuario_criacao, client };

        for (const linha of linhas) {
          const gravada = await repo.registrarConsulta(linha.consulta, opts);
          if (gravada.id) resultado.consultasGravadas += 1;
          else resultado.consultasRepetidas += 1;

          for (const achado of linha.achados) {
            const inserido = await repo.registrarAchado(achado, opts);
            if (inserido.id) resultado.achadosGravados += 1;
            else resultado.achadosRepetidos += 1;
          }
        }

        // Fecha a mensagem no MESMO commit. `concluido` não quer dizer que achou algo — 'achou / não
        // achou' é o `en_status_retorno` de cada consulta. E `dt_conclusao` vem do `dt_fim` do
        // payload: quem terminou foi o worker, e a mensagem pode ter esperado na fila.
        await repo.fecharMensagem(
          retorno.id_mensagem,
          {
            enStatus: transporteDoRetorno(retorno),
            erro: retorno.erro ?? null,
            dtConclusao: retorno.dt_fim,
          },
          opts,
        );
      });
    },
  );

  return resultado;
}
