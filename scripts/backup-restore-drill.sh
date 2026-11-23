#!/usr/bin/env bash
# Backup → restore → verify drill. Proves a backup is RESTORABLE and that the restored ledger still
# satisfies its invariants. Run it on a schedule and after every migration; a backup that has never
# been restored is not a backup.
#
#   SOURCE_DATABASE_URL=postgresql://owner:pw@host:5432/durin \
#   ADMIN_DATABASE_URL=postgresql://owner:pw@host:5432/postgres \
#   ./scripts/backup-restore-drill.sh
#
# ADMIN_DATABASE_URL must be able to CREATE/DROP a scratch database. Nothing in SOURCE is modified.
set -euo pipefail

: "${SOURCE_DATABASE_URL:?set SOURCE_DATABASE_URL}"
: "${ADMIN_DATABASE_URL:?set ADMIN_DATABASE_URL}"
SCRATCH="durin_restore_drill_$(date +%s)"
DUMP="$(mktemp -t durin-drill-XXXXXX.dump)"
trap 'rm -f "$DUMP"; psql "$ADMIN_DATABASE_URL" -qAt -c "DROP DATABASE IF EXISTS \"$SCRATCH\" WITH (FORCE)" >/dev/null 2>&1 || true' EXIT

scratch_url() { python3 - "$ADMIN_DATABASE_URL" "$SCRATCH" <<'PY'
import sys, urllib.parse as u
p = u.urlparse(sys.argv[1]); print(p._replace(path='/' + sys.argv[2]).geturl())
PY
}
TARGET="$(scratch_url)"
fail() { echo "DRILL FAILED: $*" >&2; exit 1; }
q() { psql "$1" -qAt -v ON_ERROR_STOP=1 -c "$2"; }

echo "1/5 backup"
START=$(date +%s)
pg_dump --format=custom --no-owner --file "$DUMP" "$SOURCE_DATABASE_URL"
echo "    dump $(du -h "$DUMP" | cut -f1) in $(( $(date +%s) - START ))s"

echo "2/5 restore into scratch database $SCRATCH"
START=$(date +%s)
q "$ADMIN_DATABASE_URL" "CREATE DATABASE \"$SCRATCH\"" >/dev/null
pg_restore --no-owner --exit-on-error --dbname "$TARGET" "$DUMP"
RESTORE_SECS=$(( $(date +%s) - START ))
echo "    restored in ${RESTORE_SECS}s (this is your measured RTO for this dataset size)"

echo "3/5 row counts match the source"
for t in organisations ledger_accounts journals journal_lines balances audit_logs conversions withdrawal_requests; do
  a=$(q "$SOURCE_DATABASE_URL" "SELECT count(*) FROM $t"); b=$(q "$TARGET" "SELECT count(*) FROM $t")
  [ "$a" = "$b" ] || fail "$t: source=$a restored=$b (backup is taken from a live DB, so small drift is possible only if writes occurred during the dump)"
  echo "    $t: $b"
done

echo "4/5 ledger invariants hold on the restored copy"
UNBALANCED=$(q "$TARGET" "SELECT count(*) FROM (SELECT journal_id, asset_code FROM journal_lines GROUP BY 1,2 HAVING SUM(CASE WHEN direction='debit' THEN amount ELSE -amount END) <> 0) x")
[ "$UNBALANCED" = "0" ] || fail "$UNBALANCED unbalanced journal/asset groups"
DRIFT=$(q "$TARGET" "SELECT count(*) FROM (SELECT b.account_id FROM balances b JOIN ledger_accounts a ON a.id=b.account_id LEFT JOIN journal_lines l ON l.account_id=b.account_id GROUP BY b.account_id, b.available, a.account_type HAVING b.available <> COALESCE(SUM(CASE WHEN (a.account_type IN ('asset','expense','system')) = (l.direction='debit') THEN l.amount ELSE -l.amount END),0)) x")
[ "$DRIFT" = "0" ] || fail "$DRIFT accounts whose balance differs from their journal lines"
NEG=$(q "$TARGET" "SELECT count(*) FROM balances b JOIN ledger_accounts a ON a.id=b.account_id WHERE b.available < 0 AND NOT a.allow_negative")
[ "$NEG" = "0" ] || fail "$NEG negative balances on accounts that forbid it"
echo "    balanced journals, balances == derived, no illegal negatives"

echo "5/5 database-level protections survived the restore"
TRIGGERS=$(q "$TARGET" "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('journals'::regclass,'journal_lines'::regclass,'ledger_accounts'::regclass)")
[ "$TRIGGERS" -ge 4 ] || fail "expected ledger triggers, found $TRIGGERS"
if psql "$TARGET" -qAt -c "UPDATE journal_lines SET amount = amount + 1 WHERE id = (SELECT id FROM journal_lines LIMIT 1)" >/dev/null 2>&1; then
  if [ "$(q "$TARGET" 'SELECT count(*) FROM journal_lines')" != "0" ]; then fail "journal_lines are mutable after restore"; fi
fi
echo "    ledger triggers present ($TRIGGERS) and posted lines are immutable"

echo "DRILL PASSED  (restore ${RESTORE_SECS}s)"
