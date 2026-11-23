-- CreateTable
CREATE TABLE "gate_approvals" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "gate" TEXT NOT NULL,
    "counsel_reference" TEXT NOT NULL,
    "document_sha256" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "approved_by" TEXT NOT NULL,
    "approved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,

    CONSTRAINT "gate_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gate_approvals_organisation_id_gate_idx" ON "gate_approvals"("organisation_id", "gate");


DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'durin_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON gate_approvals TO durin_runtime;
  END IF;
END $$;
