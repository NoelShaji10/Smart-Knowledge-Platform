-- 0014_pgboss_schema_privileges.sql
-- Grants permissions on the pgboss schema to the runtime application role knowledge_app
-- so that pg-boss can initialize its tables and process queues under knowledge_app.

CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION knowledge_app;
GRANT USAGE, CREATE ON SCHEMA pgboss TO knowledge_app;
GRANT ALL ON ALL TABLES IN SCHEMA pgboss TO knowledge_app;
GRANT ALL ON ALL SEQUENCES IN SCHEMA pgboss TO knowledge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON TABLES TO knowledge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA pgboss GRANT ALL ON SEQUENCES TO knowledge_app;
