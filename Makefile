.DEFAULT_GOAL := help
SHELL := /bin/bash

# Mesmos nomes de target do crm-backend, ligados aos npm scripts deste repo (a fonte única, no
# package.json). `make ci` reproduz exatamente o que .github/workflows/ci.yml roda — que é
# `npm run verify`, o Definition of Done (SW-012).
#
# Os targets de banco (migrate/seed) não existem aqui de propósito: este serviço NÃO tem migration.
# O schema em que ele escreve nasce no crm-backend (`modelo/` → migration, BE-014), e a migration que
# criou a fila é a `202608060001_fila_de_enriquecimento`, de lá.

.PHONY: help install fmt lint typecheck test cov ci dev build fila clean

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

cov: ## Run tests with coverage + the 100% floors (SW-006).
	npm run coverage

ci: ## Reproduce the CI gate locally (= the DoD: format + type + lint + coverage + prod audit).
	npm run verify

dev: ## Run the worker in watch mode (tsx).
	npm run dev

build: ## Compile to dist/ (tsconfig.build.json — src only).
	npm run build

fila: ## Create the local LocalStack queue the worker consumes.
	aws --endpoint-url=http://localhost:4566 sqs create-queue --queue-name fila-save

clean: ## Remove build artifacts and installed deps.
	rm -rf dist node_modules coverage
