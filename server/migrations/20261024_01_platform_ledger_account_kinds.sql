-- Source only. Run after 20261021_02. Not executed or runner-verified.
-- Preserve existing ENUM ordinals; append the two kinds already used by source.
-- Requires CREATE ROUTINE/ALTER ROUTINE and ALTER TABLE. DDL implicitly commits.
-- No pre-emptive DROP: an existing helper is a collision and must stop execution.
-- On drift/failure the helper remains; inspect then explicitly remove it before retry.
-- A failure after the first ALTER may leave a safe partial expansion; rerun accepts it.
-- This migration does NOT complete the separate platform-obligation schema contract.
DELIMITER $$
CREATE PROCEDURE codex_expand_platform_ledger_kinds_20261024()
BEGIN
    DECLARE account_type LONGTEXT;
    DECLARE line_type LONGTEXT;
    DECLARE account_nullable VARCHAR(3);
    DECLARE line_nullable VARCHAR(3);
    SELECT MAX(COLUMN_TYPE), MAX(IS_NULLABLE) INTO account_type, account_nullable
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'billing_accounts' AND COLUMN_NAME = 'kind';
    SELECT MAX(COLUMN_TYPE), MAX(IS_NULLABLE) INTO line_type, line_nullable
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'billing_journal_lines' AND COLUMN_NAME = 'account_kind';
    -- Check BOTH columns before any DDL; never narrow unknown/newer enum values.
    IF account_type IS NULL OR line_type IS NULL
       OR account_nullable <> 'NO' OR line_nullable <> 'NO'
       OR (BINARY account_type <> BINARY 'enum(''platform_receivable'',''platform_cash'',''merchant_pending'',''merchant_available'',''merchant_reserved'',''subscription_credit'',''cash_receipt_clearing'')' AND BINARY account_type <> BINARY 'enum(''platform_receivable'',''platform_cash'',''merchant_pending'',''merchant_available'',''merchant_reserved'',''subscription_credit'',''cash_receipt_clearing'',''platform_subscription_revenue'',''platform_unallocated_receipts'')')
       OR (BINARY line_type <> BINARY 'enum(''platform_receivable'',''platform_cash'',''merchant_pending'',''merchant_available'',''merchant_reserved'',''subscription_credit'',''cash_receipt_clearing'')' AND BINARY line_type <> BINARY 'enum(''platform_receivable'',''platform_cash'',''merchant_pending'',''merchant_available'',''merchant_reserved'',''subscription_credit'',''cash_receipt_clearing'',''platform_subscription_revenue'',''platform_unallocated_receipts'')') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform ledger kind schema drift; inspect helper and columns before retry';
    END IF;
    IF BINARY account_type = BINARY 'enum(''platform_receivable'',''platform_cash'',''merchant_pending'',''merchant_available'',''merchant_reserved'',''subscription_credit'',''cash_receipt_clearing'')' THEN
        ALTER TABLE billing_accounts MODIFY COLUMN kind ENUM('platform_receivable','platform_cash','merchant_pending','merchant_available','merchant_reserved','subscription_credit','cash_receipt_clearing','platform_subscription_revenue','platform_unallocated_receipts') NOT NULL;
    END IF;
    IF BINARY line_type = BINARY 'enum(''platform_receivable'',''platform_cash'',''merchant_pending'',''merchant_available'',''merchant_reserved'',''subscription_credit'',''cash_receipt_clearing'')' THEN
        ALTER TABLE billing_journal_lines MODIFY COLUMN account_kind ENUM('platform_receivable','platform_cash','merchant_pending','merchant_available','merchant_reserved','subscription_credit','cash_receipt_clearing','platform_subscription_revenue','platform_unallocated_receipts') NOT NULL COMMENT 'Snapshot of the account kind at posting time';
    END IF;
END$$
DELIMITER ;
CALL codex_expand_platform_ledger_kinds_20261024();
DROP PROCEDURE codex_expand_platform_ledger_kinds_20261024;
