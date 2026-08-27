import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { carregarConfig } from "../../src/config";

const original = { ...process.env };

beforeEach(() => {
  process.env = {
    ...original,
    SQS_QUEUE_URL: "http://localhost:4566/000000000000/fila-save",
    REDIS_URL: "redis://localhost:6379",
  };
  delete process.env.SQS_ENDPOINT;
  delete process.env.AWS_REGION;
  delete process.env.SQS_WAIT_TIME_SECONDS;
  delete process.env.SQS_MAX_MESSAGES;
  delete process.env.SQS_VISIBILITY_TIMEOUT;
});
afterEach(() => {
  process.env = { ...original };
});

describe("carregarConfig", () => {
  it("exige a URL da fila — sem ela o worker não tem o que consumir", () => {
    delete process.env.SQS_QUEUE_URL;
    expect(() => carregarConfig()).toThrow(/SQS_QUEUE_URL/);
  });

  it("URL vazia conta como ausente", () => {
    process.env.SQS_QUEUE_URL = "";
    expect(() => carregarConfig()).toThrow(/SQS_QUEUE_URL/);
  });

  // SW-017 — o relógio é parte do contrato deste processo, não um extra. Sem REDIS_URL ele subiria
  // consumindo a fila e NÃO seria o relógio, e é exatamente esse o modo de falha que a SW-016
  // nomeou: relógio parado não faz fila crescer, some sem sinal. Falhar no boot é o oposto disso.
  it("exige a URL do Redis — sem ela o worker subiria sem ser o relógio, calado", () => {
    delete process.env.REDIS_URL;
    expect(() => carregarConfig()).toThrow(/REDIS_URL/);
  });

  it("URL do Redis vazia conta como ausente", () => {
    process.env.REDIS_URL = "";
    expect(() => carregarConfig()).toThrow(/REDIS_URL/);
  });

  it("lê a URL do Redis", () => {
    process.env.REDIS_URL = "rediss://cache.use1.cache.amazonaws.com:6379";
    expect(carregarConfig().redisUrl).toBe("rediss://cache.use1.cache.amazonaws.com:6379");
  });

  it("os defaults são os que a SQS aceita: long polling no máximo, 10 mensagens", () => {
    const c = carregarConfig();
    expect(c).toMatchObject({
      regiao: "us-east-1",
      endpoint: undefined,
      esperaSegundos: 20,
      maxMensagens: 10,
      visibilidadeSegundos: 300,
    });
  });

  it("lê os overrides do ambiente", () => {
    process.env.AWS_REGION = "sa-east-1";
    process.env.SQS_ENDPOINT = "http://localstack:4566";
    process.env.SQS_WAIT_TIME_SECONDS = "5";
    process.env.SQS_MAX_MESSAGES = "1";
    process.env.SQS_VISIBILITY_TIMEOUT = "60";

    expect(carregarConfig()).toMatchObject({
      regiao: "sa-east-1",
      endpoint: "http://localstack:4566",
      esperaSegundos: 5,
      maxMensagens: 1,
      visibilidadeSegundos: 60,
    });
  });

  // "20 segundos" digitado errado virando NaN e depois `undefined` no comando da SQS é o tipo de
  // erro que só aparece como comportamento estranho em produção.
  it("recusa número inválido em vez de virar NaN", () => {
    process.env.SQS_WAIT_TIME_SECONDS = "vinte";
    expect(() => carregarConfig()).toThrow(/SQS_WAIT_TIME_SECONDS tem de ser inteiro/);
  });

  it("variável vazia cai no default, não em erro", () => {
    process.env.SQS_MAX_MESSAGES = "";
    expect(carregarConfig().maxMensagens).toBe(10);
  });
});
