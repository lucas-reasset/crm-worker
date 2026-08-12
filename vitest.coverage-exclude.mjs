// A lista de exclusão do denominador de cobertura — e, por consequência, do gate de espelho.
//
// Saiu de dentro do `vitest.config.ts` quando ganhou o SEGUNDO chamador (SW-013): o
// `vitest.config.ts` a usa como `coverage.exclude`, e o `scripts/check-espelho.mjs` a usa como a
// única exceção do gate — arquivo fora do denominador de cobertura não tem teste espelho a exigir,
// porque não há o que cobrir. Uma definição, dois chamadores. Duplicá-la nos dois lugares era
// garantir que um dia divergissem, e a divergência seria do tipo que passa: o gate exigiria teste
// para um arquivo que a cobertura nem mede.
//
// É `.mjs` de propósito: o gate roda em `node` puro, sem `tsx` e sem carregar o vitest — o hook
// PreToolUse da SW-013 o chama a CADA escrita em `src/**`, e pagar a subida do tsx nesse caminho
// seria atrito em cima da tecla.
//
// ── SW-006 (adota a BE-013) — uma exclusão só, e ela é honesta ─────────────────────────────────
//
// `src/index.ts` é ENTRYPOINT: lê env, prende SIGTERM/SIGINT e entrega ao loop. Não é linha sem
// teste, é linha que um teste de UNIDADE não tem como executar. Tudo que decide algo fica dentro e
// vai a 100%.
//
// Ampliar esta lista para esconder cobertura alcançável exige uma `SW-00N` revogando a SW-006 —
// piso não desce, teto não vira desculpa. E agora custa mais do que antes: tirar um arquivo daqui
// o tira também da exigência de teste próprio, então a lista virou a porta dos DOIS gates.
export const COVERAGE_EXCLUDE = ["src/index.ts"];
