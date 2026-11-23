-- AlterTable
ALTER TABLE "organisations" ADD COLUMN     "workos_organization_id" TEXT;

-- AlterTable
ALTER TABLE "ledger_accounts" ADD COLUMN     "custodian" TEXT,
ADD COLUMN     "role" TEXT;

-- AlterTable
ALTER TABLE "conversions" ADD COLUMN     "fill_journal_id" UUID,
ADD COLUMN     "provider_ref" TEXT,
ADD COLUMN     "provider_unknown" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reserve_journal_id" UUID,
ADD COLUMN     "settle_journal_id" UUID;

-- AlterTable
ALTER TABLE "verification_records" ADD COLUMN     "expires_at" TIMESTAMP(3),
ADD COLUMN     "external_id" TEXT,
ADD COLUMN     "last_event_id" TEXT,
ADD COLUMN     "provider_status" TEXT,
ADD COLUMN     "verification_url" TEXT;

-- CreateTable
CREATE TABLE "provider_calls" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "client_reference" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "detail" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "provider_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_runs" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "checked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reconciliation_breaks" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "asset_code" TEXT NOT NULL,
    "custodian" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ledger_amount" DECIMAL(36,18) NOT NULL,
    "reported_amount" DECIMAL(36,18),
    "delta" DECIMAL(36,18),
    "status" TEXT NOT NULL DEFAULT 'open',
    "note" TEXT,
    "acknowledged_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reconciliation_breaks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_webhook_events" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_challenges" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "factor_id" TEXT NOT NULL,
    "workos_challenge_id" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_challenges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_verifications" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "user_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "factor_id" TEXT NOT NULL,
    "verified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mfa_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "provider_calls_organisation_id_idx" ON "provider_calls"("organisation_id");

-- CreateIndex
CREATE INDEX "provider_calls_status_created_at_idx" ON "provider_calls"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "provider_calls_provider_operation_client_reference_key" ON "provider_calls"("provider", "operation", "client_reference");

-- CreateIndex
CREATE INDEX "reconciliation_runs_organisation_id_checked_at_idx" ON "reconciliation_runs"("organisation_id", "checked_at");

-- CreateIndex
CREATE INDEX "reconciliation_breaks_organisation_id_status_idx" ON "reconciliation_breaks"("organisation_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "processed_webhook_events_provider_event_id_key" ON "processed_webhook_events"("provider", "event_id");

-- CreateIndex
CREATE INDEX "mfa_challenges_user_id_session_id_idx" ON "mfa_challenges"("user_id", "session_id");

-- CreateIndex
CREATE INDEX "mfa_verifications_user_id_session_id_expires_at_idx" ON "mfa_verifications"("user_id", "session_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "organisations_workos_organization_id_key" ON "organisations"("workos_organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "verification_records_provider_external_id_key" ON "verification_records"("provider", "external_id");

-- AddForeignKey
ALTER TABLE "reconciliation_breaks" ADD CONSTRAINT "reconciliation_breaks_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "reconciliation_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Runtime role gets the new tables (the invariant migration granted ON ALL TABLES at that time only).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'durin_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON provider_calls, reconciliation_runs, reconciliation_breaks,
      processed_webhook_events, mfa_challenges, mfa_verifications TO durin_runtime;
  END IF;
END $$;
