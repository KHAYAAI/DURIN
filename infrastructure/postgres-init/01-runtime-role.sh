#!/bin/sh
# Creates the least-privilege login the API runs as. The schema owner (POSTGRES_USER) runs
# migrations; `durin_runtime` privileges are granted to this role by api/scripts/migrate.mjs.
set -e
psql -v ON_ERROR_STOP=1 -v app_password="$DURIN_APP_PASSWORD" --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE durin_app LOGIN PASSWORD :'app_password';
SQL
