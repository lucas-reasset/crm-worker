import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextoMensagem } from "crm-backend/repositories";
import type { RetornoEnriq, RetornoPre } from "../src/contrato";

// OS EXEMPLOS SAEM DO PRÓPRIO CONTRATO, não de fixtures escritas à mão.
//
// O README de `contratos/` diz que os `examples` são o caso de referência, e a experiência de 06/08
// confirmou a razão: um payload de `advogado` inventado à mão não passou no schema — faltavam cinco
// campos obrigatórios que ninguém lembraria de cabeça. Fixture manual é a documentação mentindo com
// mais confiança, e num teste ela mente contra o teste.
const DIR = join(__dirname, "..", "..", "crm-backend", "modelo", "contratos");

function exemplosDe(arquivo: string): unknown[] {
  const s = JSON.parse(readFileSync(join(DIR, `${arquivo}.schema.json`), "utf-8")) as {
    $defs: { output: { examples?: unknown[] } };
  };
  return s.$defs.output.examples ?? [];
}

const exemplosPre = exemplosDe("pre-enriquecimento");
const exemplosEnriq = exemplosDe("enriquecimento");

export const MSG = "3f7a1c02-9b41-4e6d-8a5f-1d2e3c4b5a60";
export const IMP = "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d";
export const CRE = "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e";
export const PES = "3c4d5e6f-7a8b-4c9d-8e1f-2a3b4c5d6e7f";
export const USR = "4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f70";

/** Os quatro exemplos do contrato do pré: documento · advogado · cessão · erro do worker. */
export function retornoPreDocumento(over: Partial<RetornoPre> = {}): RetornoPre {
  return { ...(structuredClone(exemplosPre[0]) as RetornoPre), id_mensagem: MSG, ...over };
}
export function retornoPreAdvogado(over: Partial<RetornoPre> = {}): RetornoPre {
  return { ...(structuredClone(exemplosPre[1]) as RetornoPre), id_mensagem: MSG, ...over };
}
export function retornoPreCessao(over: Partial<RetornoPre> = {}): RetornoPre {
  return { ...(structuredClone(exemplosPre[2]) as RetornoPre), id_mensagem: MSG, ...over };
}
export function retornoPreErro(over: Partial<RetornoPre> = {}): RetornoPre {
  return { ...(structuredClone(exemplosPre[3]) as RetornoPre), id_mensagem: MSG, ...over };
}

export function retornoEnriq(over: Partial<RetornoEnriq> = {}): RetornoEnriq {
  return {
    ...(structuredClone(exemplosEnriq[0]) as RetornoEnriq),
    id_mensagem: MSG,
    id_pessoa: PES,
    id_credor: CRE,
    ...over,
  };
}

export function contexto(over: Partial<ContextoMensagem> = {}): ContextoMensagem {
  return {
    id: MSG,
    id_importacao: IMP,
    id_credor: CRE,
    id_credito: null,
    en_status: "publicado",
    id_usuario_criacao: USR,
    id_pessoa: PES,
    ...over,
  };
}
