-- A PROVA do GRANT: o que o crm_worker PODE e o que ele NÃO PODE.
--
-- A D-068 fez da regra "o canônico só recebe o validado" uma PERMISSÃO. Permissão que ninguém
-- testou é suposição — e a forma de testá-la é tentar violá-la e ver falhar.
--
-- CADA NEGATIVA VAI EM SEU PRÓPRIO SAVEPOINT, e isso não é estilo: no Postgres, o primeiro erro
-- aborta a transação e todo comando seguinte devolve "current transaction is aborted". Sem savepoint,
-- o script provaria UMA negativa e herdaria o erro nas outras — parecendo prova, sendo eco.
--
-- Uso: docker exec -i postgres psql -U postgres -d reasset < scripts/provar-grant.sql
-- =====================================================================
\set ON_ERROR_STOP off
SET search_path TO crm;
BEGIN;

-- Dado de apoio, criado como POSTGRES (o dono), para o UPDATE do worker ter uma linha real em que
-- acertar. Sem isto, "UPDATE 0" seria indistinguível de permissão negada.
CREATE TEMP TABLE alvo AS
SELECT (SELECT id FROM importacao LIMIT 1) AS imp,
       (SELECT id FROM pessoa LIMIT 1) AS pes,
       (SELECT id FROM credor ORDER BY id LIMIT 1) AS cred,
       (SELECT id FROM fornecedor WHERE sigla = 'pre_enriquecimento') AS forn;
GRANT SELECT ON alvo TO crm_worker;

INSERT INTO importacao_credor (id_importacao, id_credor, en_status, dt_publicacao)
SELECT imp, cred, 'publicado', now() FROM alvo;

SET ROLE crm_worker;

\echo ''
\echo '######## O QUE ELE PODE ########'
\echo '-- afirmação no inbox --'
INSERT INTO pessoa_informacao (id_pessoa, id_importacao, id_fornecedor, en_atributo, valor, en_origem, en_status, en_entidade_canonica)
SELECT pes, imp, forn, 'cpf', '55566677788', 'robo', 'suspeito', 'pessoa_fisica' FROM alvo;

\echo '-- a consulta (a tentativa cobrada) --'
INSERT INTO enriquecimento_consulta (id_pessoa, id_importacao, id_fornecedor, en_tipo, en_gatilho, en_status_retorno)
SELECT pes, imp, forn, 'pre_enriquecimento', 'robo', 'sucesso' FROM alvo;

\echo '-- fechar a mensagem: as quatro colunas do ciclo de vida (espera UPDATE 1) --'
UPDATE importacao_credor SET en_status = 'concluido', dt_conclusao = now(), nr_tentativas = 1, erro = NULL
 WHERE id_credor = (SELECT cred FROM alvo);

\echo ''
\echo '######## O QUE ELE NÃO PODE (cada um em seu savepoint) ########'

\echo '-- promover telefone --'
SAVEPOINT s; INSERT INTO telefone (numero_e164) VALUES ('+5511900000000'); ROLLBACK TO s;
\echo '-- promover advogado --'
SAVEPOINT s; INSERT INTO advogado (oab, en_oab_uf) VALUES ('123456', 'SP'); ROLLBACK TO s;
\echo '-- promover cessão (registro jurídico) --'
SAVEPOINT s; INSERT INTO cessao (id_credito) SELECT NULL; ROLLBACK TO s;
\echo '-- escrever CPF no canônico --'
SAVEPOINT s; UPDATE pessoa_fisica SET cpf = '11122233344'; ROLLBACK TO s;
\echo '-- criar identidade (a fábrica de duplicata que o dedup existe para limpar) --'
SAVEPOINT s; INSERT INTO pessoa (nome) VALUES ('Inventada'); ROLLBACK TO s;
\echo '-- trocar o vínculo da mensagem (o UPDATE é por COLUNA, não pela tabela) --'
SAVEPOINT s; UPDATE importacao_credor SET id_credor = gen_random_uuid(); ROLLBACK TO s;
\echo '-- semear fornecedor (semear é decisão humana) --'
SAVEPOINT s; INSERT INTO fornecedor (sigla, nome) VALUES ('inventado', 'Inventado'); ROLLBACK TO s;
\echo '-- apagar afirmação --'
SAVEPOINT s; DELETE FROM pessoa_informacao; ROLLBACK TO s;
\echo '-- desligar a própria auditoria --'
SAVEPOINT s; UPDATE sys_audit_config SET st_auditar = false; ROLLBACK TO s;
\echo '-- ler senha de usuário --'
SAVEPOINT s; SELECT senha_hash FROM usuario LIMIT 1; ROLLBACK TO s;

RESET ROLE;
ROLLBACK;
