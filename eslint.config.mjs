// Mesma base do crm-backend, enxugada ao que este serviço tem: sem Express, sem camadas.
//
// As três regras herdadas sem discussão (`no-console`, `no-unused-vars` com `^_`,
// `consistent-type-imports`) estão lá pelos motivos de lá — log é evento estruturado pelo `logger`
// do backend (BE-002), e `console.*` num worker de fila é linha que ninguém acha no CloudWatch.
//
// A que é DESTE serviço é o `no-restricted-imports` do segundo bloco. Ela mecaniza a fronteira que
// o crm-worker existe para respeitar: aqui não há SQL. Ver o comentário sobre ela, abaixo.
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**"] },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      // `project` e não `projectService`: os testes moram FORA do tsconfig de build (que só compila
      // `src/`), e sem o tsconfig.eslint.json o parser os recusa como "não encontrados no projeto".
      parserOptions: { project: "./tsconfig.eslint.json", tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "no-console": "error",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "warn",
    },
  },

  // A FRONTEIRA DESTE SERVIÇO, mecanizada — o análogo do "SQL só no Repository" do crm-backend.
  //
  // Aqui é mais forte: **não existe SQL neste repo, em lugar nenhum.** Todo o SQL do worker é o
  // `RetornoEnriquecimentoRepository`, no crm-backend, e aquele arquivo é o ESPELHO EM TYPESCRIPT DO
  // `GRANT` (D-068) — a lista fechada de três escritas. Quem abrir o pool aqui e mandar um `query`
  // contorna as duas coisas de uma vez: a lista de escritas permitidas e as quatro GUCs da trilha
  // (D-010), que só são publicadas por `withTransaction`/`comContexto`. E as duas falham CALADAS —
  // o INSERT passa, a linha nasce sem ator, e ninguém descobre até uma auditoria perguntar.
  //
  // `database/transaction` NÃO está barrado, e a distinção é a mesma que o crm-backend faz:
  // `withTransaction` não é SQL, é fronteira transacional, e quem sabe que "as consultas + os
  // achados + o fechamento da mensagem" é uma unidade atômica é `salvar.ts`. O que a regra barra é o
  // acesso ao pool (`query`) e ao driver.
  //
  // Os caminhos internos do pacote (`crm-backend/src/**`, `crm-backend/dist/**`,
  // `crm-backend/modelo/**`) são barrados por outro motivo: o mapa `exports` da BE-076 é um GATE, e
  // uma importação por caminho interno o contorna. Hoje o `moduleResolution: Node16` já reprovaria
  // isso, mas quando reprova diz "não encontrado" — que manda a pessoa procurar um bug de
  // instalação em vez de ler a decisão. A regra existe pela MENSAGEM.
  {
    files: ["src/**/*.ts"],
    ignores: ["src/index.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["pg", "crm-backend/database/db"],
              message:
                "Neste repo não há SQL. O SQL do worker é o RetornoEnriquecimentoRepository, no crm-backend — o espelho do GRANT (D-068). Importar o pool aqui contorna a lista de escritas permitidas E as GUCs da trilha (D-010), e as duas falham caladas. Use `crm-backend/repositories` (o repository) e `crm-backend/database/transaction` (a fronteira transacional). Exceção: só `src/index.ts`, para `closePool` no encerramento.",
            },
            {
              group: ["crm-backend/src/**", "crm-backend/dist/**", "crm-backend/modelo/**"],
              message:
                "Importe pelo mapa `exports` do pacote (BE-076), nunca pelo caminho interno: `crm-backend/repositories`, `crm-backend/database/transaction`, `crm-backend/lib/logger`, `crm-backend/lib/requestContext`, `crm-backend/models/DerivacaoAchado`, `crm-backend/contratos/<arquivo>.json`. O mapa é um gate: o que não está nele é da API, não da biblioteca.",
            },
          ],
        },
      ],
    },
  },

  {
    files: ["tests/**/*.ts"],
    // Teste monta dublê e dá `as unknown as X` de propósito — cobrar tipagem estrita do dublê
    // empurraria o teste a imitar a implementação em vez de afirmar comportamento.
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      // A asserção que o lint chama de "desnecessária" é o que dá NOME ao comando da SQS que o
      // dublê devolveu (`as [ReceiveMessageCommand]`) — tirá-la troca uma leitura clara por
      // `mock.calls[0][0]` anônimo.
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      // Dublê de função assíncrona (um `dormir` falso, um `send` falso) não tem o que aguardar. A
      // regra está certa em produção e é ruído aqui.
      "@typescript-eslint/require-await": "off",
    },
  },
);
