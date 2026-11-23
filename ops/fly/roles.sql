-- Run ONCE per database as the schema owner (fly-user), before the first deploy:
--   psql ... -v app_password="'<generated password>'" -f ops/fly/roles.sql
-- Creates the least-privilege runtime login the API connects as. The migrations create the
-- `durin_runtime` group role and grant it table rights; this script only adds the login.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'durin_runtime') THEN CREATE ROLE durin_runtime NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'durin_app') THEN CREATE ROLE durin_app LOGIN; END IF;
END $$;
ALTER ROLE durin_app PASSWORD :app_password;
GRANT durin_runtime TO durin_app;
GRANT CONNECT ON DATABASE durin TO durin_app;
GRANT USAGE ON SCHEMA public TO durin_runtime;
