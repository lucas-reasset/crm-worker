#!/usr/bin/env node
// O gate de espelho da SW-013 — todo arquivo de `src/` com código executável tem um teste que é
// DELE, no caminho espelho da SW-005.
//
// Por que isto existe, se a cobertura já é 100% (SW-006): cobertura 100% não prova que o arquivo tem
// teste. Ela prova que alguma linha de alguma suíte executou aquele código — e "alguma" é a palavra
// cara. Aqui o risco não é hipotético, é a topologia do repo: `normalizar.ts` é importado por
// `salvar.ts` e por `consumidor.ts`, e `contrato.ts` por `consumidor.ts`. Um módulo NOVO nesse meio
// — o `dlq.ts` que falta no REQ-0410 é o próximo — chega a 100% de carona no teste de quem o chama,
// sem nunca ter existido um vermelho pedindo aquele código.
//
// Cobertura de carona tem duas consequências: apagar o teste do importador derruba a cobertura de um
// arquivo que ninguém associou a ele, e — a que importa para TDD — dá para escrever o código
// primeiro e a cobertura aparecer sozinha.
//
// Este gate é o complemento estrutural do piso de cobertura: o piso pergunta "esta linha rodou?", o
// espelho pergunta "alguém escreveu um teste PARA este arquivo?". A ORDEM (o vermelho antes do
// verde) é do hook `hook-precheck-tdd.sh`, que chama este mesmo módulo — a regra é uma só, e o gate
// e o hook são dois chamadores dela.
//
// Modos:
//   node scripts/check-espelho.mjs                   varre src/ inteiro; sai 1 se faltar espelho
//   node scripts/check-espelho.mjs --arquivo <path>   um arquivo; sai 1 se falta o espelho dele
//
// Saída 0 = tudo tem espelho. Saída 1 = falta. Saída 2 = o gate não conseguiu julgar (nunca falha
// aberto: não saber é motivo para parar, não para deixar passar).

import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { COVERAGE_EXCLUDE } from "../vitest.coverage-exclude.mjs";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── A ÚNICA exceção ───────────────────────────────────────────────────────────────────────────
//
// Estar fora do denominador de cobertura. Vem de `vitest.coverage-exclude.mjs`, não de uma cópia:
// arquivo que não tem linha a cobrir não tem teste a exigir. Ampliar aquela lista para fugir deste
// gate é o que a SW-006 já proíbe.
//
// Não há segunda, e a diferença em relação ao crm-backend é o que vale registrar: lá existe a
// exceção de `src/routes/**` (BE-006 — rota é fiação, testada dirigindo a API pelo contrato).
// AQUI NÃO HÁ ROTA e não há porta (SW-007), então a exceção não tem análogo — copiá-la criaria um
// buraco para uma pasta que não existe, e o dia em que alguém criasse `src/routes/` no worker o
// gate calaria justamente sobre código novo.

const paraRegex = (glob) => {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*" && glob[i + 2] === "/") {
      out += "(?:.*/)?"; // `a/**/b` casa `a/b` também — `**` é zero-ou-mais diretórios
      i += 2;
    } else if (c === "*" && glob[i + 1] === "*") {
      out += ".*";
      i += 1;
    } else if (c === "*") {
      out += "[^/]*";
    } else if (".+?^$()[]{}|\\".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return new RegExp("^" + out + "$");
};

const EXCLUIDOS = COVERAGE_EXCLUDE.map(paraRegex);

/** Caminho do teste que espelha este arquivo (SW-005): `src/a/B.ts` → `tests/unit/a/B.test.ts`. */
export const caminhoEspelho = (rel) =>
  rel.replace(/^src\//, "tests/unit/").replace(/\.ts$/, ".test.ts");

/** Este arquivo precisa de teste espelho? `rel` é relativo à raiz do repo, com `/`. */
export const exigeEspelho = (rel) => {
  if (!rel.startsWith("src/") || !rel.endsWith(".ts")) return false;
  return !EXCLUIDOS.some((re) => re.test(rel));
};

const listarTs = (dir) => {
  const achados = [];
  for (const nome of readdirSync(dir)) {
    const abs = join(dir, nome);
    if (statSync(abs).isDirectory()) achados.push(...listarTs(abs));
    else if (nome.endsWith(".ts")) achados.push(relative(RAIZ, abs));
  }
  return achados;
};

const ajuda = (faltantes) => {
  const linhas = [
    "",
    "BLOQUEADO — teste-primeiro (SW-013).",
    "",
    `${faltantes.length === 1 ? "Este arquivo de src/ não tem" : `Estes ${faltantes.length} arquivos de src/ não têm`} o teste espelho da SW-005:`,
    "",
  ];
  for (const { arquivo, espelho } of faltantes) {
    linhas.push(`  · ${arquivo}`, `    falta: ${espelho}`);
  }
  linhas.push(
    "",
    "A ordem certa é —",
    "  1. escreva o teste no caminho espelho acima",
    "  2. rode `npm run tdd` e VEJA-O FALHAR (vermelho é a prova de que ele testa algo)",
    "  3. só então escreva o código de src/ que o faz passar",
    "",
    "Cobertura 100% não substitui isto: ela mede se a linha rodou, não se alguém escreveu um",
    "teste PARA este arquivo — e neste repo, onde consumidor→contrato e salvar→normalizar, código",
    "novo chega a 100% de carona no teste de quem o importa.",
    "",
    "Se o arquivo não tem código executável (só `type`/`interface`) ou é entrypoint, ele não vem",
    "para cá: entra na lista de `vitest.coverage-exclude.mjs`, que é a porta dos dois gates — e",
    "ampliá-la para esconder cobertura alcançável exige uma SW-00N revogando a SW-006.",
    "",
  );
  return linhas.join("\n");
};

const argv = process.argv.slice(2);
const iArq = argv.indexOf("--arquivo");

if (iArq !== -1) {
  const alvo = argv[iArq + 1];
  if (!alvo) {
    process.stderr.write("check-espelho: --arquivo exige um caminho.\n");
    process.exit(2);
  }
  const rel = relative(RAIZ, resolve(alvo)).split("\\").join("/");
  if (!exigeEspelho(rel)) process.exit(0);
  const espelho = caminhoEspelho(rel);
  if (existsSync(join(RAIZ, espelho))) process.exit(0);
  process.stderr.write(ajuda([{ arquivo: rel, espelho }]));
  process.exit(1);
}

const src = join(RAIZ, "src");
if (!existsSync(src)) {
  process.stderr.write(`check-espelho: src/ não encontrado em ${RAIZ}.\n`);
  process.exit(2);
}

const arquivos = listarTs(src)
  .map((a) => a.split("\\").join("/"))
  .filter(exigeEspelho);

const faltantes = arquivos
  .map((arquivo) => ({ arquivo, espelho: caminhoEspelho(arquivo) }))
  .filter(({ espelho }) => !existsSync(join(RAIZ, espelho)))
  .sort((a, b) => a.arquivo.localeCompare(b.arquivo));

if (faltantes.length > 0) {
  process.stderr.write(ajuda(faltantes));
  process.exit(1);
}

process.stdout.write(`espelho: ${arquivos.length} arquivos de src/ com teste próprio (SW-013).\n`);
