-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "OrganisationStatus" AS ENUM ('active', 'suspended', 'pending_verification');

-- CreateEnum
CREATE TYPE "MembershipRole" AS ENUM ('owner', 'admin', 'developer', 'viewer');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense', 'system');

-- CreateEnum
CREATE TYPE "JournalStatus" AS ENUM ('posted');

-- CreateEnum
CREATE TYPE "PaymentIntentStatus" AS ENUM ('created', 'pending', 'requires_action', 'processing', 'confirmed', 'settled', 'failed', 'cancelled', 'expired');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('open', 'accepted', 'expired', 'cancelled');

-- CreateEnum
CREATE TYPE "ConversionStatus" AS ENUM ('quoted', 'accepted', 'processing', 'settlement_pending', 'settled', 'failed', 'expired');

-- CreateEnum
CREATE TYPE "WithdrawalStatus" AS ENUM ('requested', 'pending_approval', 'approved', 'processing', 'submitted', 'confirmed', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('not_started', 'pending', 'approved', 'rejected', 'expired');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('pending', 'approved', 'rejected', 'cancelled');

-- CreateTable
CREATE TABLE "organisations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "OrganisationStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organisations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT,
    "name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisation_members" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "MembershipRole" NOT NULL DEFAULT 'developer',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organisation_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_hash" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "last_used_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "locked_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "secret_enc" TEXT NOT NULL,
    "events" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "endpoint_id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_status" INTEGER,
    "last_error" TEXT,
    "delivered_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ledger_accounts" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "account_type" "AccountType" NOT NULL,
    "asset_code" TEXT NOT NULL,
    "allow_negative" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ledger_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journals" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "reference" TEXT,
    "description" TEXT,
    "status" "JournalStatus" NOT NULL DEFAULT 'posted',
    "idempotency_key" TEXT,
    "posted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "value_date" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_lines" (
    "id" UUID NOT NULL,
    "journal_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "direction" TEXT NOT NULL,
    "amount" DECIMAL(36,18) NOT NULL,
    "asset_code" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "balances" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "asset_code" TEXT NOT NULL,
    "available" DECIMAL(36,18) NOT NULL DEFAULT 0,
    "pending" DECIMAL(36,18) NOT NULL DEFAULT 0,
    "reserved" DECIMAL(36,18) NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_intents" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "amount" DECIMAL(36,18) NOT NULL,
    "asset_code" TEXT NOT NULL,
    "status" "PaymentIntentStatus" NOT NULL DEFAULT 'created',
    "description" TEXT,
    "customer_reference" TEXT,
    "metadata" JSONB,
    "payment_instructions" JSONB,
    "journal_id" UUID,
    "idempotency_key" TEXT,
    "expires_at" TIMESTAMP(3),
    "confirmed_at" TIMESTAMP(3),
    "settled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_links" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "payment_intent_id" UUID,
    "url_slug" TEXT NOT NULL,
    "amount" DECIMAL(36,18),
    "asset_code" TEXT,
    "description" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "source_asset" TEXT NOT NULL,
    "target_asset" TEXT NOT NULL,
    "source_amount" DECIMAL(36,18) NOT NULL,
    "target_amount" DECIMAL(36,18) NOT NULL,
    "rate" DECIMAL(36,18) NOT NULL,
    "fee_amount" DECIMAL(36,18) NOT NULL DEFAULT 0,
    "fee_asset" TEXT NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'open',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversions" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "source_asset" TEXT NOT NULL,
    "target_asset" TEXT NOT NULL,
    "source_amount" DECIMAL(36,18) NOT NULL,
    "target_amount" DECIMAL(36,18) NOT NULL,
    "rate" DECIMAL(36,18) NOT NULL,
    "fee_amount" DECIMAL(36,18) NOT NULL,
    "status" "ConversionStatus" NOT NULL DEFAULT 'accepted',
    "journal_id" UUID,
    "idempotency_key" TEXT,
    "failure_reason" TEXT,
    "settled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallets" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "label" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'sandbox',
    "external_ref" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposit_addresses" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "asset_code" TEXT NOT NULL,
    "chain" TEXT NOT NULL DEFAULT 'ethereum-sepolia',
    "address" TEXT NOT NULL,
    "provider_ref" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deposit_addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "withdrawal_requests" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "asset_code" TEXT NOT NULL,
    "amount" DECIMAL(36,18) NOT NULL,
    "destination" TEXT NOT NULL,
    "chain" TEXT NOT NULL DEFAULT 'ethereum-sepolia',
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'requested',
    "provider_ref" TEXT,
    "tx_hash" TEXT,
    "journal_id" UUID,
    "failure_reason" TEXT,
    "idempotency_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "withdrawal_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_records" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'sandbox',
    "status" "VerificationStatus" NOT NULL DEFAULT 'not_started',
    "level" TEXT NOT NULL DEFAULT 'kyb_basic',
    "metadata" JSONB,
    "reviewed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "screening_results" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "screening_type" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'sandbox',
    "result" TEXT NOT NULL,
    "details" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "screening_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "limit_policies" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "asset_code" TEXT,
    "daily_limit" DECIMAL(36,18),
    "per_tx_limit" DECIMAL(36,18),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "limit_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "amount" DECIMAL(36,18),
    "asset_code" TEXT,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'pending',
    "requested_by" TEXT,
    "decided_by" TEXT,
    "decision_note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "organisation_id" UUID,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT,
    "action" TEXT NOT NULL,
    "resource_type" TEXT,
    "resource_id" TEXT,
    "ip" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "organisation_members_organisation_id_user_id_key" ON "organisation_members"("organisation_id", "user_id");

-- CreateIndex
CREATE INDEX "api_keys_key_prefix_idx" ON "api_keys"("key_prefix");

-- CreateIndex
CREATE INDEX "api_keys_organisation_id_idx" ON "api_keys"("organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_organisation_id_idempotency_key_key" ON "idempotency_records"("organisation_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "webhook_endpoints_organisation_id_idx" ON "webhook_endpoints"("organisation_id");

-- CreateIndex
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx" ON "webhook_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "webhook_deliveries_organisation_id_idx" ON "webhook_deliveries"("organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "webhook_deliveries_endpoint_id_event_id_key" ON "webhook_deliveries"("endpoint_id", "event_id");

-- CreateIndex
CREATE INDEX "ledger_accounts_organisation_id_idx" ON "ledger_accounts"("organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_accounts_organisation_id_code_key" ON "ledger_accounts"("organisation_id", "code");

-- CreateIndex
CREATE INDEX "journals_organisation_id_idx" ON "journals"("organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "journals_organisation_id_idempotency_key_key" ON "journals"("organisation_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "journal_lines_journal_id_idx" ON "journal_lines"("journal_id");

-- CreateIndex
CREATE INDEX "journal_lines_account_id_idx" ON "journal_lines"("account_id");

-- CreateIndex
CREATE INDEX "balances_organisation_id_idx" ON "balances"("organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "balances_account_id_key" ON "balances"("account_id");

-- CreateIndex
CREATE INDEX "payment_intents_organisation_id_idx" ON "payment_intents"("organisation_id");

-- CreateIndex
CREATE INDEX "payment_intents_status_idx" ON "payment_intents"("status");

-- CreateIndex
CREATE UNIQUE INDEX "payment_intents_organisation_id_idempotency_key_key" ON "payment_intents"("organisation_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "payment_links_url_slug_key" ON "payment_links"("url_slug");

-- CreateIndex
CREATE INDEX "payment_links_organisation_id_idx" ON "payment_links"("organisation_id");

-- CreateIndex
CREATE INDEX "quotes_organisation_id_idx" ON "quotes"("organisation_id");

-- CreateIndex
CREATE INDEX "conversions_organisation_id_idx" ON "conversions"("organisation_id");

-- CreateIndex
CREATE INDEX "conversions_status_idx" ON "conversions"("status");

-- CreateIndex
CREATE UNIQUE INDEX "conversions_organisation_id_idempotency_key_key" ON "conversions"("organisation_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "wallets_organisation_id_idx" ON "wallets"("organisation_id");

-- CreateIndex
CREATE INDEX "deposit_addresses_organisation_id_idx" ON "deposit_addresses"("organisation_id");

-- CreateIndex
CREATE INDEX "deposit_addresses_address_idx" ON "deposit_addresses"("address");

-- CreateIndex
CREATE INDEX "withdrawal_requests_organisation_id_idx" ON "withdrawal_requests"("organisation_id");

-- CreateIndex
CREATE UNIQUE INDEX "withdrawal_requests_organisation_id_idempotency_key_key" ON "withdrawal_requests"("organisation_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "verification_records_organisation_id_idx" ON "verification_records"("organisation_id");

-- CreateIndex
CREATE INDEX "verification_records_subject_type_subject_id_idx" ON "verification_records"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "screening_results_organisation_id_idx" ON "screening_results"("organisation_id");

-- CreateIndex
CREATE INDEX "limit_policies_organisation_id_idx" ON "limit_policies"("organisation_id");

-- CreateIndex
CREATE INDEX "approval_requests_organisation_id_idx" ON "approval_requests"("organisation_id");

-- CreateIndex
CREATE INDEX "approval_requests_status_idx" ON "approval_requests"("status");

-- CreateIndex
CREATE INDEX "audit_logs_organisation_id_idx" ON "audit_logs"("organisation_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- AddForeignKey
ALTER TABLE "organisation_members" ADD CONSTRAINT "organisation_members_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_members" ADD CONSTRAINT "organisation_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_fkey" FOREIGN KEY ("endpoint_id") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "journals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balances" ADD CONSTRAINT "balances_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "ledger_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_payment_intent_id_fkey" FOREIGN KEY ("payment_intent_id") REFERENCES "payment_intents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversions" ADD CONSTRAINT "conversions_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_addresses" ADD CONSTRAINT "deposit_addresses_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

