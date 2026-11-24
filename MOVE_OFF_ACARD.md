# Moving DURIN off the A-CARD Didit and WorkOS accounts

**Why.** DURIN's staging currently uses the A-CARD WorkOS project ("A-CARD's Project → Staging") and the A-CARD Didit organisation (sandbox app). Related repositories (FORGE Mutual) state the owner's decision that its WorkOS/Didit live in **new accounts, not A-CARD**. Use this if DURIN should be separated too. Nothing here can be done without the new accounts, which only you can create.

**Status.** Tooling is built and tested; the move itself has **not** been performed.

## What is automated
| Piece | Tool | Notes |
|---|---|---|
| WorkOS organisation, permissions, roles | `node api/dist/provisioning/cli.js` (needs the new environment's `WORKOS_API_KEY`) | Idempotent; dry-run unless `--apply`; refuses an `sk_live_` key without `--allow-live-key`. Driven by `ops/provisioning/manifest.json` |
| Didit workflows | Recreate from `ops/provisioning/manifest.json` → `didit` (console or the Didit connector signed in to the NEW account) | Definitions are small and listed explicitly; no script because Didit's management API is not verified from this repo |
| App configuration | Environment variables (below) | No code change |

## Steps
1. **Create the accounts** (you): a new WorkOS team/project with a Staging environment, and a new Didit organisation with a sandbox application. Use a company mailbox, not a personal one, so the accounts outlive any individual.
2. **Provision WorkOS** (dry-run first):
   ```bash
   pnpm --filter @durin/api build
   WORKOS_API_KEY=sk_test_... node api/dist/provisioning/cli.js            # shows the plan
   WORKOS_API_KEY=sk_test_... node api/dist/provisioning/cli.js --apply    # creates it
   ```
   Then do the printed **manual steps** (redirect URI, AuthKit methods/MFA policy).
3. **Create the Didit workflows** from the manifest in the new application; note the two workflow ids; create a v3 webhook destination (`status.updated`) → `<api>/v1/webhooks/didit` and keep its shared secret.
4. **Switch configuration** on the API (and dashboard): `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD`; `DIDIT_API_KEY`, `DIDIT_WORKFLOW_KYB`, `DIDIT_WORKFLOW_KYC`, `DIDIT_WEBHOOK_SECRET` (set the old secret as `DIDIT_WEBHOOK_SECRET_PREVIOUS` for an overlap if old sessions are still completing).
5. **Re-link the organisation:** `PUT /v1/auth/workos/organisation` (operator action: admin key + `X-Bootstrap-Token`) with the new WorkOS organisation id. The old link is overwritten.
6. **Re-enrol people:** users and their TOTP factors do not move between WorkOS projects. Invite them to the new organisation; each enrols MFA again on the dashboard Security page. Existing DURIN MFA verifications are bound to old sessions and expire.
7. **Verify** (see below), then **decommission** the A-CARD-side objects: the "DURIN" organisation, the DURIN permissions/roles, the two Didit workflows, any webhook destination.

## Verification checklist
- [ ] `GET /v1/auth/me` with a token from the new WorkOS environment returns the DURIN organisation.
- [ ] A user without MFA is blocked from an `@RequireMfa` action; after the challenge it succeeds.
- [ ] A Didit KYB session starts from `POST /v1/compliance/verifications` and the hosted URL opens.
- [ ] A signed test webhook from the new destination returns `applied`/`unknown`, a bad signature returns 401.
- [ ] No request in API logs still hits the A-CARD WorkOS client id (`client_01M079SBRGBJ82933Y70J1KDX2`) or the old Didit workflow ids.

## Rollback
Keep the old variables in your secrets manager until the new setup has run clean for a week. To roll back: restore the old env vars, re-link the old WorkOS organisation id, redeploy. Verifications completed in the new Didit account stay in the DURIN database (they reference their own session ids) and do not need migrating.

## What cannot be migrated
Didit sessions and their evidence (they stay in the old account — export anything you must keep before decommissioning), WorkOS users/sessions/factors, audit logs held by either vendor.
