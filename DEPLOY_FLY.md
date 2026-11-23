# Deploying DURIN staging on Fly.io

**Status: prepared, not yet run by anyone.** The database below exists; the API app does not. The Fly connection used by engineering cannot create apps or deploy, so these steps are run by you with `flyctl`. I verified the production bundle builds and starts (`/health` returned `ok` from the pruned deploy output), but I could not build the Docker image in my sandbox (no Docker daemon), so **the first `fly deploy` is the first real image build**.

## What already exists
| Item | Value |
|---|---|
| Fly org | `tebogo-mvelase` |
| Managed Postgres | `durin-staging-db` — id `1zqyxr7jmj1rwp8m`, plan `dev-256` ($4/mo list price), region `fra`, Postgres 16, **1 GB disk**, database `durin` |
| DB user | `fly-user` (role `schema_admin`) — the only user; its password is not available to engineering |
| Endpoints | pooler `pgbouncer.1zqyxr7jmj1rwp8m.flympg.net:5432`, direct `direct.1zqyxr7jmj1rwp8m.flympg.net:5432` |

`dev-256` is a toy size (256 MB RAM, shared CPU). Fine for staging; **resize before any load test**.

## Steps
```bash
# 0. Install flyctl and sign in (https://fly.io/docs/flyctl/install/)
fly auth login

# 1. Create the app (names are global; edit `app` in fly.toml if this is taken)
fly apps create durin-staging-api --org tebogo-mvelase

# 2. Attach the database. This sets a DATABASE_URL secret (pooled). Check flags with `fly mpg attach --help`.
fly mpg attach 1zqyxr7jmj1rwp8m --app durin-staging-api --database durin
fly secrets list --app durin-staging-api          # confirm DATABASE_URL exists
```

**3. Check the owner can create roles** (the migrations create `durin_runtime`; if this fails, stop and ask Fly support to grant `CREATEROLE`, or tell me — do not skip least-privilege silently):
```bash
fly mpg connect 1zqyxr7jmj1rwp8m --database durin
#   in psql:   SELECT rolcreaterole, rolsuper FROM pg_roles WHERE rolname = current_user;   -- expect rolcreaterole = t
#              \q
```

**4. Create the runtime login** (generate a password, keep it in your password manager):
```bash
APP_PW=$(openssl rand -base64 24 | tr -d '/+=')
fly mpg connect 1zqyxr7jmj1rwp8m --database durin   # then paste:  \set app_password '''<APP_PW>'''   \i ops/fly/roles.sql
```
(If `\i` isn't available through your connection, paste the contents of `ops/fly/roles.sql` and replace `:app_password` with `'<APP_PW>'`.)

**5. Secrets.** Take the URL that step 2 stored as `DATABASE_URL` (`fly mpg attach` printed it; the owner credentials are in it) and use it for the owner, then build the runtime URL from the *pooler* host with user `durin_app`:
```bash
OWNER_DIRECT_URL='postgresql://fly-user:<owner-pw>@direct.1zqyxr7jmj1rwp8m.flympg.net:5432/durin'   # migrations
RUNTIME_URL="postgresql://durin_app:${APP_PW}@pgbouncer.1zqyxr7jmj1rwp8m.flympg.net:5432/durin"        # API runtime

fly secrets set --app durin-staging-api \
  MIGRATION_DATABASE_URL="$OWNER_DIRECT_URL" \
  DURIN_RUNTIME_ROLE=durin_app \
  DATABASE_URL="$RUNTIME_URL" \
  DURIN_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  BOOTSTRAP_TOKEN="$(openssl rand -hex 24)" \
  METRICS_TOKEN="$(openssl rand -hex 24)" \
  WORKOS_API_KEY='<WorkOS staging API key>' \
  DIDIT_API_KEY='<Didit sandbox API key>' \
  DIDIT_WEBHOOK_SECRET='pending-until-webhook-is-created'
```
Print and store `BOOTSTRAP_TOKEN` and `METRICS_TOKEN` yourself before running (they are not shown again). `DURIN_ENCRYPTION_KEY` must never change once webhook secrets are stored (rotation is not implemented).

**6. Deploy** (from the repository root):
```bash
fly deploy --remote-only
curl https://durin-staging-api.fly.dev/health      # expect {"status":"ok", ... "database":"up"}
curl -H "Authorization: Bearer $METRICS_TOKEN" https://durin-staging-api.fly.dev/metrics | head
```
If the release step fails, `fly logs --app durin-staging-api` shows the migration error. A failed release does not take traffic.

**7. Create the DURIN organisation and link it to WorkOS**
```bash
API=https://durin-staging-api.fly.dev
curl -s -X POST $API/v1/organisations -H "Content-Type: application/json" -H "X-Bootstrap-Token: $BOOTSTRAP_TOKEN" -d '{"name":"DURIN"}'
# -> keep apiKey.secret (shown once). Then link WorkOS (operator action, admin key + bootstrap token):
curl -s -X PUT $API/v1/auth/workos/organisation -H "Authorization: Bearer <apiKey.secret>" -H "X-Bootstrap-Token: $BOOTSTRAP_TOKEN" -H "Content-Type: application/json" -d '{"workosOrganizationId":"org_01M84EDF2A94SVHR4ETQJ8PYRM"}'
```

**8. Didit webhook.** In the Didit console (A-CARD → Sandbox) create a **v3** webhook destination for `status.updated` to `https://durin-staging-api.fly.dev/v1/webhooks/didit`. Copy its shared secret and run `fly secrets set DIDIT_WEBHOOK_SECRET=<secret> --app durin-staging-api`. Until then every Didit webhook is rejected (401), which is the safe failure.

**9. Smoke test:** `node scripts/smoke.mjs https://durin-staging-api.fly.dev` (uses the sandbox providers).

## Notes
- This is a **staging** configuration: `ALLOW_SANDBOX_IN_PRODUCTION=true` makes the production safety check accept simulated custody/fiat/liquidity. It must never appear in a production config.
- Running as `NODE_ENV=production` with that override means API keys are `dk_test_…`, and simulated endpoints remain available. No real money or real provider is involved.
- The dashboard is not part of this deployment. It needs its own Fly app (`docker/Dockerfile.dashboard`), the WorkOS staging redirect URI for its public URL, and `WORKOS_COOKIE_PASSWORD`.
- Cost: the database list price is $4/month; the API machine (shared-cpu-1x, 512 MB, always on) is billed separately by Fly.
- Backups: run `scripts/backup-restore-drill.sh` against the cluster via `fly mpg proxy` periodically; see `ops/RUNBOOK.md`. Managed Postgres backup retention/PITR for this plan is **not verified**.
