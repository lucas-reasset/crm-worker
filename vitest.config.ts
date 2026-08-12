import { defineConfig } from "vitest/config";

import { COVERAGE_EXCLUDE } from "./vitest.coverage-exclude.mjs";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Pega `tests/unit/**` hoje e `tests/integration/**` quando existir (SW-005): a primeira pasta
    // diz a NATUREZA do teste, e dentro dela o caminho espelha `src/`.
    include: ["tests/**/*.{test,spec}.ts"],
    env: {
      LOG_LEVEL: "silent",
      // Importar `crm-backend/database/db` instancia o Pool no load do módulo. Instanciar não
      // conecta, mas a URL precisa existir para o pool não nascer com `undefined` e mascarar, num
      // teste futuro, um erro de configuração como se fosse erro de código.
      DATABASE_URL: "postgres://ninguem:nada@localhost:5432/nao_usado_em_teste",
      DB_SCHEMA: "crm",
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // A lista, e o porquê da única exclusão (SW-006), moram em `vitest.coverage-exclude.mjs`. Ela
      // saiu daqui porque tem um segundo chamador: o gate de espelho da SW-013
      // (`scripts/check-espelho.mjs`) não exige teste próprio de arquivo que está fora do
      // denominador de cobertura — e duas cópias da mesma lista divergiriam.
      exclude: COVERAGE_EXCLUDE,
      thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
      // Por default o v8 SÓ emite o relatório (e portanto SÓ checa os pisos acima) quando a suíte
      // inteira passa. Um teste quebrado não baixaria a cobertura medida — ele a tornaria NÃO
      // MEDIDA, e a checagem sairia do ar em silêncio bem no momento em que mais serve.
      reportOnFailure: true,
    },
  },
});
