-- AlterTable
ALTER TABLE "organisations" ADD COLUMN     "is_house" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "conversions" ADD COLUMN     "execution_mode" TEXT NOT NULL DEFAULT 'provider',
ADD COLUMN     "matching_until" TIMESTAMP(3),
ADD COLUMN     "netting_batch_id" UUID;

-- CreateTable
CREATE TABLE "rejected_deposits" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "deposit_address_id" UUID NOT NULL,
    "chain" TEXT NOT NULL,
    "tx_hash" TEXT NOT NULL,
    "token_contract" TEXT NOT NULL,
    "base_units" TEXT NOT NULL,
    "decimals" INTEGER,
    "reason" TEXT NOT NULL,
    "sender" TEXT,
    "status" TEXT NOT NULL DEFAULT 'detected',
    "reviewed_by" TEXT,
    "review_note" TEXT,
    "return_address" TEXT,
    "override_reason" TEXT,
    "screening_ref" TEXT,
    "approved_by" TEXT,
    "return_tx_hash" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rejected_deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "netting_batches" (
    "id" UUID NOT NULL,
    "base_asset" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "hedge_action" TEXT,
    "hedge_base_amount" TEXT,
    "hedge_quote_amount" TEXT,
    "hedge_provider_ref" TEXT,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "netting_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "rejected_deposits_organisation_id_status_idx" ON "rejected_deposits"("organisation_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "rejected_deposits_deposit_address_id_tx_hash_token_contract_key" ON "rejected_deposits"("deposit_address_id", "tx_hash", "token_contract");

-- CreateIndex
CREATE INDEX "netting_batches_status_idx" ON "netting_batches"("status");


-- At most one house organisation.
CREATE UNIQUE INDEX "organisations_single_house" ON "organisations" ((true)) WHERE "is_house";

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'durin_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON rejected_deposits, netting_batches TO durin_runtime;
  END IF;
END $$;
