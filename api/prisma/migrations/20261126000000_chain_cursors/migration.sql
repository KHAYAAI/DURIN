-- CreateTable
CREATE TABLE "chain_cursors" (
    "id" UUID NOT NULL,
    "deposit_address_id" UUID NOT NULL,
    "token_account" TEXT NOT NULL,
    "last_signature" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chain_cursors_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chain_cursors_deposit_address_id_token_account_key" ON "chain_cursors"("deposit_address_id", "token_account");


DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'durin_runtime') THEN
    GRANT SELECT, INSERT, UPDATE ON chain_cursors TO durin_runtime;
  END IF;
END $$;
