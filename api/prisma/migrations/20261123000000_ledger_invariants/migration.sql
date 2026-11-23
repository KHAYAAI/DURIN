-- DURIN ledger invariants, enforced in the database as defence in depth.
-- The application validates the same rules first (for friendly errors), but nothing the
-- application does can bypass these:
--   1. every journal balances per asset and has at least two lines (checked at COMMIT)
--   2. line amounts are strictly positive; direction is debit or credit
--   3. a line's account must belong to the journal's organisation, match its asset, be active
--   4. balances are maintained ONLY by triggers, in the same transaction as the line
--   5. available balance cannot go negative unless the account allows it
--   6. posted journals and lines are immutable; accounts cannot be deleted or re-typed
--   7. the runtime role cannot write balances or alter posted entries

-- ── 1/2. Column constraints ─────────────────────────────────
ALTER TABLE "journal_lines"
  ADD CONSTRAINT "journal_lines_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "journal_lines_direction_valid" CHECK ("direction" IN ('debit', 'credit'));

-- ── 3. Line consistency (tenant, asset, status) ─────────────
CREATE OR REPLACE FUNCTION durin_check_journal_line() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  journal_org uuid;
  acct RECORD;
BEGIN
  SELECT organisation_id INTO journal_org FROM journals WHERE id = NEW.journal_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: journal % does not exist', NEW.journal_id;
  END IF;
  SELECT organisation_id, asset_code, status, code INTO acct FROM ledger_accounts WHERE id = NEW.account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: account % does not exist', NEW.account_id;
  END IF;
  IF acct.organisation_id <> journal_org THEN
    RAISE EXCEPTION 'TENANT_MISMATCH: account % belongs to another organisation', acct.code;
  END IF;
  IF acct.asset_code <> NEW.asset_code THEN
    RAISE EXCEPTION 'ASSET_MISMATCH: line asset % does not match account % asset %', NEW.asset_code, acct.code, acct.asset_code;
  END IF;
  IF acct.status <> 'active' THEN
    RAISE EXCEPTION 'ACCOUNT_CLOSED: account % is not active', acct.code;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "journal_lines_check" BEFORE INSERT ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION durin_check_journal_line();

-- ── 4/5. Balances maintained by trigger ─────────────────────
-- SECURITY DEFINER: runs with the migration owner's rights, so the runtime role needs no
-- write access to "balances". Sign convention: asset/expense/system are debit-normal;
-- liability/revenue/equity are credit-normal. "available" is the balance on the normal side.
CREATE OR REPLACE FUNCTION durin_apply_journal_line() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  acct RECORD;
  delta numeric;
  new_available numeric;
BEGIN
  SELECT account_type::text AS account_type, allow_negative, code INTO acct
    FROM ledger_accounts WHERE id = NEW.account_id;
  delta := CASE WHEN (acct.account_type IN ('asset', 'expense', 'system')) = (NEW.direction = 'debit')
                THEN NEW.amount ELSE -NEW.amount END;
  UPDATE balances
     SET available = available + delta, updated_at = now()
   WHERE account_id = NEW.account_id
   RETURNING available INTO new_available;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'No balance row for account %', NEW.account_id;
  END IF;
  IF new_available < 0 AND NOT acct.allow_negative THEN
    RAISE EXCEPTION 'NEGATIVE_BALANCE: account % available balance would be negative (%)', acct.code, new_available
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER "journal_lines_apply" AFTER INSERT ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION durin_apply_journal_line();

-- A balance row is created with every account, by the database, not the application.
CREATE OR REPLACE FUNCTION durin_create_balance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO balances (id, organisation_id, account_id, asset_code, available, pending, reserved, updated_at)
  VALUES (gen_random_uuid(), NEW.organisation_id, NEW.id, NEW.asset_code, 0, 0, 0, now());
  RETURN NULL;
END $$;

CREATE TRIGGER "ledger_accounts_balance" AFTER INSERT ON "ledger_accounts"
  FOR EACH ROW EXECUTE FUNCTION durin_create_balance();

-- ── 1. Balanced journal, checked at COMMIT ──────────────────
CREATE OR REPLACE FUNCTION durin_assert_journal_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM journal_lines WHERE journal_id = NEW.id) < 2 THEN
    RAISE EXCEPTION 'UNBALANCED_JOURNAL: journal % has fewer than two lines', NEW.id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM journal_lines WHERE journal_id = NEW.id
    GROUP BY asset_code
    HAVING SUM(CASE WHEN direction = 'debit' THEN amount ELSE -amount END) <> 0
  ) THEN
    RAISE EXCEPTION 'UNBALANCED_JOURNAL: journal % does not balance per asset', NEW.id;
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER "journals_balanced" AFTER INSERT ON "journals"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION durin_assert_journal_balanced();

-- ── 6. Immutability ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION durin_forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE: % is append-only (% not allowed)', TG_TABLE_NAME, TG_OP;
END $$;

CREATE TRIGGER "journals_immutable" BEFORE UPDATE OR DELETE ON "journals"
  FOR EACH ROW EXECUTE FUNCTION durin_forbid_mutation();
CREATE TRIGGER "journal_lines_immutable" BEFORE UPDATE OR DELETE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION durin_forbid_mutation();
CREATE TRIGGER "journals_no_truncate" BEFORE TRUNCATE ON "journals"
  FOR EACH STATEMENT EXECUTE FUNCTION durin_forbid_mutation();
CREATE TRIGGER "journal_lines_no_truncate" BEFORE TRUNCATE ON "journal_lines"
  FOR EACH STATEMENT EXECUTE FUNCTION durin_forbid_mutation();
CREATE TRIGGER "balances_no_delete" BEFORE DELETE ON "balances"
  FOR EACH ROW EXECUTE FUNCTION durin_forbid_mutation();
CREATE TRIGGER "audit_logs_immutable" BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION durin_forbid_mutation();

CREATE OR REPLACE FUNCTION durin_guard_account() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IMMUTABLE: ledger accounts cannot be deleted; close them instead';
  END IF;
  IF NEW.organisation_id <> OLD.organisation_id
     OR NEW.account_type <> OLD.account_type
     OR NEW.asset_code <> OLD.asset_code
     OR NEW.code <> OLD.code THEN
    RAISE EXCEPTION 'IMMUTABLE: organisation, code, type and asset of a ledger account cannot change';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "ledger_accounts_guard" BEFORE UPDATE OR DELETE ON "ledger_accounts"
  FOR EACH ROW EXECUTE FUNCTION durin_guard_account();

-- ── 7. Least-privilege runtime role ─────────────────────────
-- The API connects as a login role that is a member of durin_runtime, e.g.:
--   CREATE ROLE durin_app LOGIN PASSWORD '...';  GRANT durin_runtime TO durin_app;
-- Migrations run as a different, privileged role. Future migrations that add tables must
-- GRANT explicitly to durin_runtime.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'durin_runtime') THEN
    CREATE ROLE durin_runtime NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO durin_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO durin_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO durin_runtime;

REVOKE ALL ON "_prisma_migrations" FROM durin_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON "journals", "journal_lines" FROM durin_runtime;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "balances" FROM durin_runtime;
REVOKE DELETE, TRUNCATE ON "ledger_accounts" FROM durin_runtime;
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_logs" FROM durin_runtime;
