# syntax=docker/dockerfile:1

# save-worker — consumidor da fila de retorno do (pré-)enriquecimento (D-068 · BE-074).
#
# Debian slim (não alpine) pelo MESMO motivo do crm-backend: este serviço o importa como
# dependência, e o `bcrypt` dele é addon nativo cujo prebuild glibc é confiável. No musl do alpine
# ele cairia para compilar e precisaria de toolchain no runtime — mesmo o worker nunca chamando
# bcrypt, a dependência é instalada.
#
# ⚠️ ESTE BUILD PRECISA DE ACESSO AO REPO PRIVADO artell-ai/crm-backend. A dependência é git pinada
# por tag (BE-076) e o `prepare` de lá compila o `dist/` durante o install. Há DOIS caminhos, e o
# estágio `deps` aceita os dois sem exigir nenhum:
#
#   local  →  docker buildx build --ssh default .            (usa o agente SSH da sua máquina)
#   CI     →  docker buildx build --secret id=gh_token,env=TOKEN .
#
# Nenhuma credencial fica em layer: o agente SSH nunca é copiado, o secret vive só em
# /run/secrets durante o RUN, e o `~/.gitconfig` que carrega o token é APAGADO no mesmo RUN —
# senão ele viajaria no cache de registry (`--cache-to`) do estágio `deps`, que é público para
# quem lê o ECR.

FROM node:22-slim AS deps
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates openssh-client \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN --mount=type=ssh,required=false \
    --mount=type=secret,id=gh_token \
  set -e; \
  mkdir -p -m 0700 ~/.ssh; ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null || true; \
  if [ -s /run/secrets/gh_token ]; then \
    tok="$(cat /run/secrets/gh_token)"; \
    git config --global "url.https://x-access-token:${tok}@github.com/.insteadOf" "ssh://git@github.com/"; \
    git config --global --add "url.https://x-access-token:${tok}@github.com/.insteadOf" "git@github.com:"; \
  fi; \
  npm ci; \
  rm -f ~/.gitconfig

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build

FROM node:22-slim AS runner
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
# Reaproveita o node_modules já resolvido (o crm-backend vem compilado do `prepare`) e poda as dev
# deps — sem reinstalar, sem precisar de git nem de credencial no runtime.
COPY --from=build /app/node_modules ./node_modules
RUN npm prune --omit=dev
COPY --from=build /app/dist ./dist
USER node
# Sem EXPOSE: este serviço não escuta porta (SW-007). Ele é PULL — puxa da SQS. Um health check HTTP
# aqui seria um servidor inventado só para o probe, e responderia 200 mesmo com o loop travado (foi o
# bug da SW-003). A liveness que interessa é "está consumindo", e ela se lê na profundidade da fila.
CMD ["node", "dist/index.js"]
