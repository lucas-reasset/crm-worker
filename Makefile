.DEFAULT_GOAL := help
SHELL := /bin/bash

# Mesmos nomes de target do crm-backend, ligados aos npm scripts deste repo (a fonte única, no
# package.json). `make ci` reproduz exatamente o que .github/workflows/ci.yml roda — que é
# `npm run verify`, o Definition of Done (SW-012).
#
# Os targets de banco (migrate/seed) não existem aqui de propósito: este serviço NÃO tem migration.
# O schema em que ele escreve nasce no crm-backend (`modelo/` → migration, BE-014), e a migration que
# criou a fila é a `202608060001_fila_de_enriquecimento`, de lá.
#
# Fora do `fila`, este arquivo só dá nome curto ao que o package.json já define. Target que roda o
# que o package.json NÃO define é uma segunda verdade — não crie um.

.PHONY: help install fmt lint typecheck test tdd cov espelho ci verify dev build fila mock clean

help: ## Show this help.
	@awk 'BEGIN {FS = ":.*##"; printf "Usage:\n  make \033[36m<target>\033[0m\n\nTargets:\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

install: ## Install exactly the lockfile (reproducible; fails on package.json drift).
	npm ci

fmt: ## Auto-format (prettier).
	npm run format

lint: ## Format-check + eslint, no changes.
	npm run format:check
	npm run lint

typecheck: ## Type-check src/ AND tests/ (tsc --noEmit, SW-009).
	npm run typecheck

test: ## Run unit tests (vitest, no coverage).
	npm run test

tdd: ## The red→green loop (SW-013, verbose reporter). Filter: make tdd T=tests/unit/normalizar.test.ts
	npm run tdd $(if $(T),-- $(T),)

cov: ## Run tests with coverage + the 100% floors (SW-006).
	npm run coverage

espelho: ## "Is there a test FOR this file?" (SW-013) — the structural pair of the coverage floor. Inside ci.
	npm run espelho:check

ci: ## Reproduce the CI gate locally — the DoD (format · type · lint · espelho · coverage · prod audit).
	npm run verify

verify: ci ## Alias of ci — the same `npm run verify` the rest of the workspace says out loud.

dev: ## Run the worker in watch mode (tsx).
	npm run dev

build: ## Compile to dist/ (tsconfig.build.json — src only).
	npm run build

# Sem Docker (com Docker o compose já faz isto: o serviço `fila`). As DUAS filas, porque a DLQ é
# onde pousa o erro PERMANENTE de desenho (contrato inválido, FK inexistente — SW-002/SW-011): quem
# não a tem localmente descobre isso em produção. Os números são os mesmos do docker-compose.yml e
# os mesmos a fixar no Terraform — se mudarem lá, mudam aqui.
fila: ## Create the local LocalStack queues the worker consumes — fila-save + fila-save-dlq, with redrive.
	@E="--endpoint-url=http://localhost:4566"; \
	aws $$E sqs create-queue --queue-name fila-save-dlq >/dev/null; \
	ARN=$$(aws $$E sqs get-queue-attributes \
	  --queue-url http://localhost:4566/000000000000/fila-save-dlq \
	  --attribute-names QueueArn --query Attributes.QueueArn --output text); \
	aws $$E sqs create-queue --queue-name fila-save \
	  --attributes "{\"VisibilityTimeout\":\"300\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$$ARN\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}" >/dev/null; \
	echo "fila-save + fila-save-dlq criadas"

mock: ## Play the external workers: one payload per `publicado` message, through the production path (run crm-backend's `make mock` first).
	npm run mock:retorno

clean: ## Remove build artifacts and installed deps.
	rm -rf dist node_modules coverage
