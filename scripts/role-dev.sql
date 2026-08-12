-- O role restrito do save-worker — VERSÃO DE DESENVOLVIMENTO.
--
-- A D-068 diz: "a decisão só é real quando a permissão existe; até então o rail é papel". Este
-- script é o rail em dev, para que o GRANT mínimo seja EXERCITADO e não apenas descrito.
--
-- ⛔ NÃO É O DE PRODUÇÃO, e não vira. `CREATE ROLE` é cluster-level (não de banco), em RDS o
-- usuário de migration normalmente não pode criá-lo, e a senha aqui é literal. Onde o role de
-- produção nasce — migration no crm-backend ou Terraform — é decisão ABERTA (REQ-0410); a escolha
-- muda quem opera o segredo.
--
-- Uso:
--   docker exec -i postgres psql -U postgres -d reasset -v ON_ERROR_STOP=1 -f - < scripts/role-dev.sql
--
-- A prova de que funcionou não é este arquivo rodar: é o role FALHAR ao tentar escrever no canônico.
-- Ver scripts/provar-grant.sql.
-- =====================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'save_worker') THEN
    CREATE ROLE save_worker LOGIN PASSWORD 'save_worker_dev';
  END IF;
END $$;

-- Nada por herança: o role entra sem nenhum privilégio e recebe só o enumerado abaixo.
REVOKE ALL ON ALL TABLES IN SCHEMA crm FROM save_worker;
REVOKE ALL ON SCHEMA crm FROM save_worker;

GRANT USAGE ON SCHEMA crm TO save_worker;
-- `pgcrypto` mora no public (gen_random_uuid) — sem USAGE aqui, todo INSERT com default de id falha.
GRANT USAGE ON SCHEMA public TO save_worker;

-- ---- INSERT: a tentativa e a afirmação --------------------------------------
GRANT INSERT, SELECT ON crm.enriquecimento_consulta TO save_worker;
GRANT INSERT, SELECT ON crm.pessoa_informacao       TO save_worker;

-- ---- UPDATE: só o ciclo de vida do TRANSPORTE ------------------------------
-- Por COLUNA, não pela tabela. É o que impede o worker de mexer em `id_credor`, `id_importacao` ou
-- no bloco de auditoria da linha — inclusive por refatoração distraída.
GRANT SELECT ON crm.importacao_credor TO save_worker;
GRANT UPDATE (en_status, nr_tentativas, dt_conclusao, erro) ON crm.importacao_credor TO save_worker;

-- ---- SELECT: só o que precisa resolver -------------------------------------
GRANT SELECT ON crm.fornecedor TO save_worker;
GRANT SELECT ON crm.credor     TO save_worker;
GRANT SELECT ON crm.credito    TO save_worker;
GRANT SELECT ON crm.caso       TO save_worker;

-- ---- A trilha ---------------------------------------------------------------
-- O trigger de auditoria roda como o CHAMADOR e faz INSERT em sys_audit_log — sem este GRANT, toda
-- escrita do worker falharia no trigger, não na tabela, e a mensagem de erro apontaria para o lugar
-- errado. `set_config` de GUC `app.*` não pede privilégio, então o ator continua funcionando.
GRANT INSERT ON crm.sys_audit_log TO save_worker;
GRANT SELECT ON crm.sys_audit_config TO save_worker;
GRANT SELECT ON crm.sys_audit_pii TO save_worker;

-- Explicitamente NADA no canônico. As linhas abaixo são no-ops defensivas: se alguém tiver dado
-- GRANT à mão, isto o tira. É o oposto de um comentário dizendo "não dê permissão aqui".
REVOKE ALL ON crm.pessoa, crm.pessoa_fisica, crm.pessoa_juridica, crm.advogado, crm.cessao,
              crm.telefone, crm.pessoa_telefone, crm.email, crm.endereco
  FROM save_worker;
