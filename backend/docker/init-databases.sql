-- backend/docker/init-databases.sql
--
-- Runs once, on first initialization of the postgres volume.
--
-- Two databases in one local-only service: simplest robust option. A second
-- postgres container would double the memory for no isolation benefit, since
-- PostgreSQL databases already cannot see into each other, and a test reset
-- targets a database rather than a server.
--
-- POSTGRES_DB creates web3_index_dev; this adds the disposable test database.
CREATE DATABASE web3_index_test;

COMMENT ON DATABASE web3_index_dev IS
  'Local development index. Survives test runs. Rebuildable from chain.';
COMMENT ON DATABASE web3_index_test IS
  'Disposable test database. Truncated and rebuilt by the test suite.';
