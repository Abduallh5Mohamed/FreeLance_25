-- Platform settlement contract, additive extension of 20261023_01.
-- Authoring-only source DDL. No connection or SQL execution is performed here.
-- Source contracts: docs/streams/server/CL-B-BILLING-20261022.md §14.8 and
-- server/src/services/billing-settlement-sql.ts / billing-collection-sql.ts.
-- Unknown/partial shapes fail closed. Existing completed merchant obligations
-- retain their status, journal_id and net_minor semantics; no data is backfilled.

SET @c7_db = DATABASE();

-- Guard helper used for catalog drift and unsafe existing data.
CREATE PROCEDURE c7_20261024_02_guard()
    COMMENT 'tabweb 20261024_02 guard helper (safe to drop)'
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'platform settlement schema drift or unsafe legacy data: reconcile and rerun';

SET @c7_preflight = IF(@c7_db IS NULL OR
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='financial_settlement_obligations')<>1 OR
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='billing_payment_allocations')<>1 OR
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='billing_difference_requests')<>1 OR
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='checkout_orders')<>1 OR
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='billing_invoices')<>1 OR
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='billing_journals')<>1 OR
    (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='tenants')<>1,
    'CALL c7_20261024_02_guard()', 'SELECT 1');
PREPARE c7_stmt_preflight FROM @c7_preflight;
EXECUTE c7_stmt_preflight;
DEALLOCATE PREPARE c7_stmt_preflight;

-- S3: atomic replacement of the status CHECK plus receipt columns/keys/FK.
-- Exact old status is the 3-value enum from 20261023_01. Exact new status is
-- accepted only with the complete new shape; any partial shape is rejected.
SET @c7_status_type = (SELECT COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='financial_settlement_obligations' AND COLUMN_NAME='status');
SET @c7_new_col_count = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='financial_settlement_obligations'
 AND COLUMN_NAME IN ('allocatable_minor','platform_receipt_journal_id'));
SET @c7_new_columns_shape = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='financial_settlement_obligations' AND ((COLUMN_NAME='allocatable_minor' AND COLUMN_TYPE='bigint unsigned' AND IS_NULLABLE='YES') OR (COLUMN_NAME='platform_receipt_journal_id' AND COLUMN_TYPE='char(36)' AND IS_NULLABLE='YES' AND COLLATION_NAME='utf8mb4_unicode_ci')));
SET @c7_new_check_count = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
 WHERE CONSTRAINT_SCHEMA=@c7_db AND TABLE_NAME='financial_settlement_obligations'
 AND CONSTRAINT_TYPE='CHECK' AND CONSTRAINT_NAME IN ('chk_settlement_obligation_platform'));
SET @c7_old_status_check = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
 WHERE CONSTRAINT_SCHEMA=@c7_db AND TABLE_NAME='financial_settlement_obligations'
 AND CONSTRAINT_TYPE='CHECK' AND CONSTRAINT_NAME='chk_settlement_obligation_status');
SET @c7_old_status_clause_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA=cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME=cc.CONSTRAINT_NAME WHERE tc.CONSTRAINT_SCHEMA=@c7_db AND tc.TABLE_NAME='financial_settlement_obligations' AND tc.CONSTRAINT_TYPE='CHECK' AND tc.ENFORCED='YES' AND cc.CONSTRAINT_NAME='chk_settlement_obligation_status' AND REPLACE(REPLACE(LOWER(cc.CHECK_CLAUSE),' ',''),'`','')="((status='completed'andjournal_idisnotnullandnet_minorisnotnull)or(status<>'completed'andjournal_idisnull))");
SET @c7_new_status_clause_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA=cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME=cc.CONSTRAINT_NAME WHERE tc.CONSTRAINT_SCHEMA=@c7_db AND tc.TABLE_NAME='financial_settlement_obligations' AND tc.CONSTRAINT_TYPE='CHECK' AND tc.ENFORCED='YES' AND cc.CONSTRAINT_NAME='chk_settlement_obligation_status' AND REPLACE(REPLACE(LOWER(cc.CHECK_CLAUSE),' ',''),'`','')="((status='completed'andjournal_idisnotnullandnet_minorisnotnull)or(statusin('pending','awaiting_allocation')andjournal_idisnull)or(status='allocated'andpurpose='subscription_difference'andjournal_idisnullandnet_minorisnullandallocatable_minorisnotnullandplatform_receipt_journal_idisnotnull))");
SET @c7_platform_clause_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA=cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME=cc.CONSTRAINT_NAME WHERE tc.CONSTRAINT_SCHEMA=@c7_db AND tc.TABLE_NAME='financial_settlement_obligations' AND tc.CONSTRAINT_TYPE='CHECK' AND tc.ENFORCED='YES' AND cc.CONSTRAINT_NAME='chk_settlement_obligation_platform' AND REPLACE(REPLACE(LOWER(cc.CHECK_CLAUSE),' ',''),'`','')="(((allocatable_minorisnull)=(platform_receipt_journal_idisnull))and(allocatable_minorisnullor(purpose='subscription_difference'andstatusin('awaiting_allocation','allocated')andfee_minorisnotnullandtax_minorisnotnullandnet_minorisnullandallocatable_minor>0andallocatable_minor<=amount_minorandallocatable_minor+fee_minor+tax_minor=amount_minor)))");
SET @c7_new_uq = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS
 WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='financial_settlement_obligations'
 AND INDEX_NAME='uq_settlement_obligation_platform_receipt');
SET @c7_new_idx = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS
 WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='financial_settlement_obligations'
 AND INDEX_NAME='idx_settlement_obligation_platform_receipt_tenant');
SET @c7_new_fk = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
 WHERE CONSTRAINT_SCHEMA=@c7_db AND TABLE_NAME='financial_settlement_obligations'
 AND CONSTRAINT_TYPE='FOREIGN KEY' AND CONSTRAINT_NAME='fk_settlement_obligation_platform_receipt');
SET @c7_new_uq_shape = (SELECT COUNT(*) FROM (SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='financial_settlement_obligations' AND INDEX_NAME='uq_settlement_obligation_platform_receipt' AND NON_UNIQUE=0 GROUP BY INDEX_NAME HAVING COUNT(*)=1 AND MAX(SUB_PART) IS NULL AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='platform_receipt_journal_id') q);
SET @c7_new_idx_shape = (SELECT COUNT(*) FROM (SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='financial_settlement_obligations' AND INDEX_NAME='idx_settlement_obligation_platform_receipt_tenant' AND NON_UNIQUE=1 GROUP BY INDEX_NAME HAVING COUNT(*)=2 AND MAX(SUB_PART) IS NULL AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='platform_receipt_journal_id,tenant_id') q);
SET @c7_new_fk_shape = (SELECT COUNT(*) FROM (SELECT CONSTRAINT_NAME,GROUP_CONCAT(CONCAT(COLUMN_NAME,'>',REFERENCED_TABLE_NAME,'.',REFERENCED_COLUMN_NAME) ORDER BY ORDINAL_POSITION) AS shape FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA=@c7_db AND TABLE_NAME='financial_settlement_obligations' AND CONSTRAINT_NAME='fk_settlement_obligation_platform_receipt' AND REFERENCED_TABLE_NAME IS NOT NULL GROUP BY CONSTRAINT_NAME) q WHERE shape='platform_receipt_journal_id>billing_journals.id,tenant_id>billing_journals.tenant_id');
SET @c7_new_fk_rules = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=@c7_db AND TABLE_NAME='financial_settlement_obligations' AND CONSTRAINT_NAME='fk_settlement_obligation_platform_receipt' AND DELETE_RULE='RESTRICT' AND UPDATE_RULE='RESTRICT');
SET @c7_partial_obligation = IF(
 (@c7_status_type="enum('pending','awaiting_allocation','completed')" AND @c7_new_col_count=0 AND @c7_new_check_count=0 AND @c7_new_uq=0 AND @c7_new_idx=0 AND @c7_new_fk=0 AND @c7_old_status_check=1 AND @c7_old_status_clause_ok=1),0,
 IF(@c7_status_type="enum('pending','awaiting_allocation','completed','allocated')" AND @c7_new_col_count=2 AND @c7_new_columns_shape=2 AND @c7_new_check_count=1 AND @c7_new_uq=1 AND @c7_new_idx=1 AND @c7_new_fk=1 AND @c7_new_uq_shape=1 AND @c7_new_idx_shape=1 AND @c7_new_fk_shape=1 AND @c7_new_fk_rules=1 AND @c7_new_status_clause_ok=1 AND @c7_platform_clause_ok=1,0,1));
SET @c7_sql_obligation_guard = IF(@c7_partial_obligation=1,'CALL c7_20261024_02_guard()','SELECT 1');
PREPARE c7_stmt_obligation_guard FROM @c7_sql_obligation_guard;
EXECUTE c7_stmt_obligation_guard;
DEALLOCATE PREPARE c7_stmt_obligation_guard;

SET @c7_sql_obligation_alter = IF(@c7_status_type="enum('pending','awaiting_allocation','completed')",
 "ALTER TABLE financial_settlement_obligations
   MODIFY COLUMN status ENUM('pending','awaiting_allocation','completed','allocated') NOT NULL DEFAULT 'pending' COMMENT 'pending = recorded; awaiting_allocation = fee/net/tax not proved (unknown stays NULL); completed = merchant journal posted; allocated = platform allocatable fully allocated',
   ADD COLUMN allocatable_minor BIGINT UNSIGNED NULL COMMENT 'Verified platform allocatable amount; NULL means not proved, never substitute zero',
   ADD COLUMN platform_receipt_journal_id CHAR(36) NULL COMMENT 'Platform receipt journal (debit platform cash, credit unallocated receipts)',
   ADD UNIQUE KEY uq_settlement_obligation_platform_receipt (platform_receipt_journal_id),
   ADD KEY idx_settlement_obligation_platform_receipt_tenant (platform_receipt_journal_id, tenant_id),
   ADD CONSTRAINT fk_settlement_obligation_platform_receipt FOREIGN KEY (platform_receipt_journal_id, tenant_id) REFERENCES billing_journals (id, tenant_id),
   DROP CHECK chk_settlement_obligation_status,
   ADD CONSTRAINT chk_settlement_obligation_status CHECK (
     (status='completed' AND journal_id IS NOT NULL AND net_minor IS NOT NULL) OR
     (status IN ('pending','awaiting_allocation') AND journal_id IS NULL) OR
     (status='allocated' AND purpose='subscription_difference' AND journal_id IS NULL AND net_minor IS NULL AND allocatable_minor IS NOT NULL AND platform_receipt_journal_id IS NOT NULL)),
   ADD CONSTRAINT chk_settlement_obligation_platform CHECK (
     ((allocatable_minor IS NULL) = (platform_receipt_journal_id IS NULL)) AND
     (allocatable_minor IS NULL OR (purpose='subscription_difference' AND status IN ('awaiting_allocation','allocated') AND fee_minor IS NOT NULL AND tax_minor IS NOT NULL AND net_minor IS NULL AND allocatable_minor>0 AND allocatable_minor<=amount_minor AND allocatable_minor+fee_minor+tax_minor=amount_minor)))",
 'SELECT 1');
PREPARE c7_stmt_obligation_alter FROM @c7_sql_obligation_alter;
EXECUTE c7_stmt_obligation_alter;
DEALLOCATE PREPARE c7_stmt_obligation_alter;

-- S4: reversal provenance. Existing reversal rows have no source allocation id;
-- do not fabricate it. The single ALTER establishes the self-reference and
-- exact one-to-one reversal uniqueness. A fully applied shape is idempotent.
SET @c7_reverse_col = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='billing_payment_allocations' AND COLUMN_NAME='reverses_allocation_id');
SET @c7_reverse_uq = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='billing_payment_allocations' AND INDEX_NAME='uq_billing_allocation_reverses');
SET @c7_reverse_idx = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='billing_payment_allocations' AND INDEX_NAME='idx_billing_allocation_reverses');
SET @c7_reverse_fk = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=@c7_db AND TABLE_NAME='billing_payment_allocations' AND CONSTRAINT_TYPE='FOREIGN KEY' AND CONSTRAINT_NAME='fk_billing_allocation_reverses');
SET @c7_reverse_check = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=@c7_db AND TABLE_NAME='billing_payment_allocations' AND CONSTRAINT_TYPE='CHECK' AND CONSTRAINT_NAME='chk_billing_allocation_reversal_link');
SET @c7_reverse_col_shape = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='billing_payment_allocations' AND COLUMN_NAME='reverses_allocation_id' AND COLUMN_TYPE='char(36)' AND IS_NULLABLE='YES' AND COLLATION_NAME='utf8mb4_0900_bin');
SET @c7_reverse_uq_shape = (SELECT COUNT(*) FROM (SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='billing_payment_allocations' AND INDEX_NAME='uq_billing_allocation_reverses' AND NON_UNIQUE=0 GROUP BY INDEX_NAME HAVING COUNT(*)=2 AND MAX(SUB_PART) IS NULL AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='tenant_id,reverses_allocation_id') q);
SET @c7_reverse_idx_shape = (SELECT COUNT(*) FROM (SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='billing_payment_allocations' AND INDEX_NAME='idx_billing_allocation_reverses' AND NON_UNIQUE=1 GROUP BY INDEX_NAME HAVING COUNT(*)=2 AND MAX(SUB_PART) IS NULL AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='reverses_allocation_id,tenant_id') q);
SET @c7_reverse_fk_shape = (SELECT COUNT(*) FROM (SELECT CONSTRAINT_NAME,GROUP_CONCAT(CONCAT(COLUMN_NAME,'>',REFERENCED_TABLE_NAME,'.',REFERENCED_COLUMN_NAME) ORDER BY ORDINAL_POSITION) AS shape FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA=@c7_db AND TABLE_NAME='billing_payment_allocations' AND CONSTRAINT_NAME='fk_billing_allocation_reverses' AND REFERENCED_TABLE_NAME IS NOT NULL GROUP BY CONSTRAINT_NAME) q WHERE shape='reverses_allocation_id>billing_payment_allocations.allocation_id,tenant_id>billing_payment_allocations.tenant_id');
SET @c7_reverse_fk_rules = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=@c7_db AND TABLE_NAME='billing_payment_allocations' AND CONSTRAINT_NAME='fk_billing_allocation_reverses' AND DELETE_RULE='RESTRICT' AND UPDATE_RULE='RESTRICT');
SET @c7_reverse_check_shape = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA=cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME=cc.CONSTRAINT_NAME WHERE tc.CONSTRAINT_SCHEMA=@c7_db AND tc.TABLE_NAME='billing_payment_allocations' AND tc.CONSTRAINT_TYPE='CHECK' AND tc.ENFORCED='YES' AND cc.CONSTRAINT_NAME='chk_billing_allocation_reversal_link' AND REPLACE(REPLACE(LOWER(cc.CHECK_CLAUSE),' ',''),'`','')="((kind='reversal')=(reverses_allocation_idisnotnull))");
SET @c7_reverse_shape = IF(@c7_reverse_col=0 AND @c7_reverse_uq=0 AND @c7_reverse_idx=0 AND @c7_reverse_fk=0 AND @c7_reverse_check=0,0,
 IF(@c7_reverse_col=1 AND @c7_reverse_col_shape=1 AND @c7_reverse_uq=1 AND @c7_reverse_uq_shape=1 AND @c7_reverse_idx=1 AND @c7_reverse_idx_shape=1 AND @c7_reverse_fk=1 AND @c7_reverse_fk_shape=1 AND @c7_reverse_fk_rules=1 AND @c7_reverse_check=1 AND @c7_reverse_check_shape=1,1,2));
SET @c7_reverse_data = (SELECT COUNT(*) FROM billing_payment_allocations WHERE kind='reversal');
SET @c7_sql_reverse_guard = IF(@c7_reverse_shape=2 OR (@c7_reverse_shape=0 AND @c7_reverse_data<>0),'CALL c7_20261024_02_guard()','SELECT 1');
PREPARE c7_stmt_reverse_guard FROM @c7_sql_reverse_guard;
EXECUTE c7_stmt_reverse_guard;
DEALLOCATE PREPARE c7_stmt_reverse_guard;
SET @c7_sql_reverse_alter = IF(@c7_reverse_shape=0,
 "ALTER TABLE billing_payment_allocations
   ADD COLUMN reverses_allocation_id CHAR(36) COLLATE utf8mb4_0900_bin NULL COMMENT 'allocation_id of the payment allocation this reversal reverses; NULL for payment/credit rows',
   ADD UNIQUE KEY uq_billing_allocation_reverses (tenant_id, reverses_allocation_id),
   ADD KEY idx_billing_allocation_reverses (reverses_allocation_id, tenant_id),
   ADD CONSTRAINT fk_billing_allocation_reverses FOREIGN KEY (reverses_allocation_id, tenant_id) REFERENCES billing_payment_allocations (allocation_id, tenant_id),
   ADD CONSTRAINT chk_billing_allocation_reversal_link CHECK ((kind='reversal') = (reverses_allocation_id IS NOT NULL))",
 'SELECT 1');
PREPARE c7_stmt_reverse_alter FROM @c7_sql_reverse_alter;
EXECUTE c7_stmt_reverse_alter;
DEALLOCATE PREPARE c7_stmt_reverse_alter;

-- S5: composite target key for request -> invoice/currency/amount proof.
-- Multiple aliases to one target are prohibited by the contract; preflight
-- duplicates and fail rather than delete or choose a canonical row.
SET @c7_target_uq = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='billing_difference_requests' AND INDEX_NAME='uq_billing_diff_request_target');
SET @c7_target_uq_shape = (SELECT COUNT(*) FROM (SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='billing_difference_requests' AND INDEX_NAME='uq_billing_diff_request_target' AND NON_UNIQUE=0 GROUP BY INDEX_NAME HAVING COUNT(*)=5 AND MAX(SUB_PART) IS NULL AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='id,tenant_id,invoice_ref_id,currency,amount_minor') q);
SET @c7_duplicate_request_targets = (SELECT COUNT(*) FROM (SELECT id FROM billing_difference_requests WHERE invoice_ref_id IS NOT NULL GROUP BY id,tenant_id,invoice_ref_id,currency,amount_minor HAVING COUNT(*)>1) AS c7_dupes);
SET @c7_sql_request_target_guard = IF(@c7_duplicate_request_targets>0 OR @c7_target_uq>1 OR (@c7_target_uq=1 AND @c7_target_uq_shape<>1),'CALL c7_20261024_02_guard()','SELECT 1');
PREPARE c7_stmt_request_target_guard FROM @c7_sql_request_target_guard;
EXECUTE c7_stmt_request_target_guard;
DEALLOCATE PREPARE c7_stmt_request_target_guard;
SET @c7_sql_request_target = IF(@c7_target_uq=0,
 'ALTER TABLE billing_difference_requests ADD UNIQUE KEY uq_billing_diff_request_target (id, tenant_id, invoice_ref_id, currency, amount_minor)',
 'SELECT 1');
PREPARE c7_stmt_request_target FROM @c7_sql_request_target;
EXECUTE c7_stmt_request_target;
DEALLOCATE PREPARE c7_stmt_request_target;

-- S6: immutable binding from a paid checkout order to the request snapshot.
SET @c7_sql_target_table = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='checkout_order_platform_targets')=0,
 "CREATE TABLE checkout_order_platform_targets (
   tenant_id CHAR(36) NOT NULL,
   order_id VARCHAR(64) NOT NULL,
   purpose VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL,
   request_id CHAR(36) NOT NULL,
   invoice_id CHAR(36) NOT NULL,
   currency CHAR(3) NOT NULL,
   amount_minor BIGINT UNSIGNED NOT NULL,
   created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
   PRIMARY KEY (tenant_id, order_id),
   UNIQUE KEY uq_checkout_platform_target_binding (tenant_id, order_id, request_id, invoice_id, currency, amount_minor),
   KEY idx_checkout_platform_target_request (tenant_id, request_id),
   KEY idx_checkout_platform_target_request_proof (request_id, tenant_id, invoice_id, currency, amount_minor),
   KEY idx_checkout_platform_target_invoice (invoice_id, tenant_id, currency),
   CONSTRAINT fk_checkout_platform_target_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
   CONSTRAINT fk_checkout_platform_target_order FOREIGN KEY (tenant_id, order_id) REFERENCES checkout_orders (tenant_id, order_id),
   CONSTRAINT fk_checkout_platform_target_request FOREIGN KEY (request_id, tenant_id, invoice_id, currency, amount_minor) REFERENCES billing_difference_requests (id, tenant_id, invoice_ref_id, currency, amount_minor),
   CONSTRAINT fk_checkout_platform_target_invoice FOREIGN KEY (invoice_id, tenant_id, currency) REFERENCES billing_invoices (id, tenant_id, currency),
   CONSTRAINT chk_checkout_platform_target_purpose CHECK (purpose='subscription_difference'),
   CONSTRAINT chk_checkout_platform_target_amount CHECK (amount_minor>0 AND amount_minor<=1000000000000000)
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Immutable checkout target proof for platform subscription-difference payments'",
 'SELECT 1');
PREPARE c7_stmt_target_table FROM @c7_sql_target_table;
EXECUTE c7_stmt_target_table;
DEALLOCATE PREPARE c7_stmt_target_table;

-- S7: insert-only closure link joining the obligation, immutable order target,
-- invoice allocation, and request. Never backfill existing payments.
SET @c7_sql_link_table = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='platform_payment_request_links')=0,
 "CREATE TABLE platform_payment_request_links (
   tenant_id CHAR(36) NOT NULL,
   obligation_id CHAR(36) COLLATE utf8mb4_0900_bin NOT NULL,
   order_id VARCHAR(64) NOT NULL,
   request_id CHAR(36) NOT NULL,
   invoice_id CHAR(36) NOT NULL,
   allocation_id CHAR(36) COLLATE utf8mb4_0900_bin NOT NULL,
   currency CHAR(3) NOT NULL,
   amount_minor BIGINT UNSIGNED NOT NULL,
   created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
   PRIMARY KEY (tenant_id, obligation_id),
   UNIQUE KEY uq_platform_link_request (tenant_id, request_id),
   UNIQUE KEY uq_platform_link_allocation (tenant_id, allocation_id),
   KEY idx_platform_link_obligation (obligation_id, tenant_id),
   KEY idx_platform_link_target (tenant_id, order_id, request_id, invoice_id, currency, amount_minor),
   KEY idx_platform_link_allocation (allocation_id, tenant_id),
   KEY idx_platform_link_request (request_id, tenant_id),
   CONSTRAINT fk_platform_link_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
   CONSTRAINT fk_platform_link_obligation FOREIGN KEY (obligation_id, tenant_id) REFERENCES financial_settlement_obligations (id, tenant_id),
   CONSTRAINT fk_platform_link_target FOREIGN KEY (tenant_id, order_id, request_id, invoice_id, currency, amount_minor) REFERENCES checkout_order_platform_targets (tenant_id, order_id, request_id, invoice_id, currency, amount_minor),
   CONSTRAINT fk_platform_link_allocation FOREIGN KEY (allocation_id, tenant_id) REFERENCES billing_payment_allocations (allocation_id, tenant_id),
   CONSTRAINT fk_platform_link_request FOREIGN KEY (request_id, tenant_id) REFERENCES billing_difference_requests (id, tenant_id),
   CONSTRAINT chk_platform_link_amount CHECK (amount_minor>0 AND amount_minor<=1000000000000000)
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Insert-only proof linking a platform payment allocation to one difference request'",
 'SELECT 1');
PREPARE c7_stmt_link_table FROM @c7_sql_link_table;
EXECUTE c7_stmt_link_table;
DEALLOCATE PREPARE c7_stmt_link_table;

-- S8: immutable invoice composition/due terms. No default due date and no
-- historical backfill: absent row means terms unresolved to readers.
SET @c7_sql_invoice_obligation = IF((SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='billing_invoice_obligations')=0,
 "CREATE TABLE billing_invoice_obligations (
   invoice_id CHAR(36) NOT NULL,
   tenant_id CHAR(36) NOT NULL,
   currency CHAR(3) NOT NULL,
   new_charge_minor BIGINT UNSIGNED NOT NULL,
   carried_debt_reference_minor BIGINT UNSIGNED NOT NULL DEFAULT 0,
   composition_version SMALLINT UNSIGNED NOT NULL,
   issued_at BIGINT UNSIGNED NOT NULL COMMENT 'Server UTC epoch seconds at issuance',
   due_status ENUM('resolved','unresolved') NOT NULL,
   due_at BIGINT UNSIGNED NULL,
   due_basis_ref VARCHAR(128) COLLATE utf8mb4_0900_bin NULL,
   due_basis_version INT UNSIGNED NULL,
   created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
   PRIMARY KEY (invoice_id),
   UNIQUE KEY uq_billing_invoice_obligation_invoice (invoice_id, tenant_id),
   KEY idx_billing_invoice_obligation_invoice_currency (invoice_id, tenant_id, currency),
   KEY idx_billing_invoice_obligation_tenant (tenant_id),
   CONSTRAINT fk_billing_invoice_obligation_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
   CONSTRAINT fk_billing_invoice_obligation_invoice FOREIGN KEY (invoice_id, tenant_id, currency) REFERENCES billing_invoices (id, tenant_id, currency),
   CONSTRAINT chk_billing_invoice_obligation_amount CHECK (new_charge_minor>0 AND new_charge_minor<=1000000000000000 AND carried_debt_reference_minor<=1000000000000000),
   CONSTRAINT chk_billing_invoice_obligation_due CHECK ((due_status='resolved' AND due_at IS NOT NULL AND due_basis_ref IS NOT NULL AND due_basis_version IS NOT NULL AND due_basis_version>=1) OR (due_status='unresolved' AND due_at IS NULL AND due_basis_ref IS NULL AND due_basis_version IS NULL))
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Insert-only invoice composition and approved due-term evidence'",
 'SELECT 1');
PREPARE c7_stmt_invoice_obligation FROM @c7_sql_invoice_obligation;
EXECUTE c7_stmt_invoice_obligation;
DEALLOCATE PREPARE c7_stmt_invoice_obligation;

-- Validate the complete required catalog shape, including ordered index/FK
-- columns and check definitions. Same-name drift is never accepted.
SET @c7_target_table_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='checkout_order_platform_targets' AND ENGINE='InnoDB' AND TABLE_COLLATION='utf8mb4_unicode_ci');
SET @c7_target_columns_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='checkout_order_platform_targets' AND ((COLUMN_NAME='tenant_id' AND COLUMN_TYPE='char(36)' AND IS_NULLABLE='NO' AND COLLATION_NAME='utf8mb4_unicode_ci') OR (COLUMN_NAME='order_id' AND COLUMN_TYPE='varchar(64)' AND IS_NULLABLE='NO' AND COLLATION_NAME='utf8mb4_unicode_ci') OR (COLUMN_NAME='purpose' AND COLUMN_TYPE='varchar(64)' AND IS_NULLABLE='NO' AND COLLATION_NAME='utf8mb4_0900_bin') OR (COLUMN_NAME='request_id' AND COLUMN_TYPE='char(36)' AND IS_NULLABLE='NO' AND COLLATION_NAME='utf8mb4_unicode_ci') OR (COLUMN_NAME='invoice_id' AND COLUMN_TYPE='char(36)' AND IS_NULLABLE='NO' AND COLLATION_NAME='utf8mb4_unicode_ci') OR (COLUMN_NAME='currency' AND COLUMN_TYPE='char(3)' AND IS_NULLABLE='NO' AND COLLATION_NAME='utf8mb4_unicode_ci') OR (COLUMN_NAME='amount_minor' AND COLUMN_TYPE='bigint unsigned' AND IS_NULLABLE='NO') OR (COLUMN_NAME='created_at' AND COLUMN_TYPE='timestamp(3)' AND IS_NULLABLE='NO')));
SET @c7_target_index_ok = (SELECT COUNT(*) FROM (
 SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='checkout_order_platform_targets' AND INDEX_NAME='PRIMARY' AND NON_UNIQUE=0 GROUP BY INDEX_NAME HAVING MAX(SUB_PART) IS NULL AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='tenant_id,order_id'
 UNION ALL SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='checkout_order_platform_targets' AND INDEX_NAME='uq_checkout_platform_target_binding' AND NON_UNIQUE=0 GROUP BY INDEX_NAME HAVING MAX(SUB_PART) IS NULL AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='tenant_id,order_id,request_id,invoice_id,currency,amount_minor'
 UNION ALL SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='checkout_order_platform_targets' AND INDEX_NAME='idx_checkout_platform_target_request' AND NON_UNIQUE=1 GROUP BY INDEX_NAME HAVING MAX(SUB_PART) IS NULL AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='tenant_id,request_id'
 UNION ALL SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='checkout_order_platform_targets' AND INDEX_NAME='idx_checkout_platform_target_request_proof' AND NON_UNIQUE=1 GROUP BY INDEX_NAME HAVING MAX(SUB_PART) IS NULL AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='request_id,tenant_id,invoice_id,currency,amount_minor'
 UNION ALL SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='checkout_order_platform_targets' AND INDEX_NAME='idx_checkout_platform_target_invoice' AND NON_UNIQUE=1 GROUP BY INDEX_NAME HAVING MAX(SUB_PART) IS NULL AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='invoice_id,tenant_id,currency') AS c7_target_indexes);
SET @c7_target_fk_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=@c7_db AND TABLE_NAME='checkout_order_platform_targets' AND CONSTRAINT_NAME IN ('fk_checkout_platform_target_tenant','fk_checkout_platform_target_order','fk_checkout_platform_target_request','fk_checkout_platform_target_invoice'));
SET @c7_target_fk_shape = (SELECT COUNT(*) FROM (SELECT CONSTRAINT_NAME, GROUP_CONCAT(CONCAT(COLUMN_NAME,'>',REFERENCED_TABLE_NAME,'.',REFERENCED_COLUMN_NAME) ORDER BY ORDINAL_POSITION) AS shape FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA=@c7_db AND TABLE_NAME='checkout_order_platform_targets' AND REFERENCED_TABLE_NAME IS NOT NULL GROUP BY CONSTRAINT_NAME) q WHERE (CONSTRAINT_NAME='fk_checkout_platform_target_tenant' AND shape='tenant_id>tenants.id') OR (CONSTRAINT_NAME='fk_checkout_platform_target_order' AND shape='tenant_id>checkout_orders.tenant_id,order_id>checkout_orders.order_id') OR (CONSTRAINT_NAME='fk_checkout_platform_target_request' AND shape='request_id>billing_difference_requests.id,tenant_id>billing_difference_requests.tenant_id,invoice_id>billing_difference_requests.invoice_ref_id,currency>billing_difference_requests.currency,amount_minor>billing_difference_requests.amount_minor') OR (CONSTRAINT_NAME='fk_checkout_platform_target_invoice' AND shape='invoice_id>billing_invoices.id,tenant_id>billing_invoices.tenant_id,currency>billing_invoices.currency'));
SET @c7_target_fk_rules = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=@c7_db AND TABLE_NAME='checkout_order_platform_targets' AND CONSTRAINT_NAME IN ('fk_checkout_platform_target_tenant','fk_checkout_platform_target_order','fk_checkout_platform_target_request','fk_checkout_platform_target_invoice') AND DELETE_RULE='RESTRICT' AND UPDATE_RULE='RESTRICT');
SET @c7_target_check_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA=cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME=cc.CONSTRAINT_NAME WHERE tc.CONSTRAINT_SCHEMA=@c7_db AND tc.TABLE_NAME='checkout_order_platform_targets' AND tc.CONSTRAINT_TYPE='CHECK' AND tc.ENFORCED='YES' AND ((cc.CONSTRAINT_NAME='chk_checkout_platform_target_purpose' AND REPLACE(REPLACE(LOWER(cc.CHECK_CLAUSE),' ',''),'`','')="(purpose='subscription_difference')") OR (cc.CONSTRAINT_NAME='chk_checkout_platform_target_amount' AND REPLACE(REPLACE(LOWER(cc.CHECK_CLAUSE),' ',''),'`','')="(amount_minor>0andamount_minor<=1000000000000000)")));
SET @c7_target_total_columns = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='checkout_order_platform_targets');
SET @c7_target_total_indexes = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='checkout_order_platform_targets');
SET @c7_target_total_fks = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=@c7_db AND TABLE_NAME='checkout_order_platform_targets');
SET @c7_target_total_checks = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='checkout_order_platform_targets' AND CONSTRAINT_TYPE='CHECK');

SET @c7_link_table_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='platform_payment_request_links' AND ENGINE='InnoDB' AND TABLE_COLLATION='utf8mb4_unicode_ci');
SET @c7_link_columns_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='platform_payment_request_links' AND ((COLUMN_NAME='tenant_id' AND COLUMN_TYPE='char(36)' AND IS_NULLABLE='NO' AND COLLATION_NAME='utf8mb4_unicode_ci') OR (COLUMN_NAME='obligation_id' AND COLUMN_TYPE='char(36)' AND IS_NULLABLE='NO' AND COLLATION_NAME='utf8mb4_0900_bin') OR (COLUMN_NAME='order_id' AND COLUMN_TYPE='varchar(64)' AND IS_NULLABLE='NO' AND COLLATION_NAME='utf8mb4_unicode_ci') OR (COLUMN_NAME='request_id' AND COLUMN_TYPE='char(36)' AND IS_NULLABLE='NO' AND COLLATION_NAME='utf8mb4_unicode_ci') OR (COLUMN_NAME='invoice_id' AND COLUMN_TYPE='char(36)' AND IS_NULLABLE='NO' AND COLLATION_NAME='utf8mb4_unicode_ci') OR (COLUMN_NAME='allocation_id' AND COLUMN_TYPE='char(36)' AND IS_NULLABLE='NO' AND COLLATION_NAME='utf8mb4_0900_bin') OR (COLUMN_NAME='currency' AND COLUMN_TYPE='char(3)' AND IS_NULLABLE='NO' AND COLLATION_NAME='utf8mb4_unicode_ci') OR (COLUMN_NAME='amount_minor' AND COLUMN_TYPE='bigint unsigned' AND IS_NULLABLE='NO') OR (COLUMN_NAME='created_at' AND COLUMN_TYPE='timestamp(3)' AND IS_NULLABLE='NO')));
SET @c7_link_index_ok = (SELECT COUNT(*) FROM (
 SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='platform_payment_request_links' AND INDEX_NAME='PRIMARY' AND NON_UNIQUE=0 GROUP BY INDEX_NAME HAVING MAX(SUB_PART) IS NULL AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='tenant_id,obligation_id'
 UNION ALL SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='platform_payment_request_links' AND INDEX_NAME='uq_platform_link_request' AND NON_UNIQUE=0 GROUP BY INDEX_NAME HAVING MAX(SUB_PART) IS NULL AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='tenant_id,request_id'
 UNION ALL SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='platform_payment_request_links' AND INDEX_NAME='uq_platform_link_allocation' AND NON_UNIQUE=0 GROUP BY INDEX_NAME HAVING MAX(SUB_PART) IS NULL AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='tenant_id,allocation_id'
 UNION ALL SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='platform_payment_request_links' AND INDEX_NAME='idx_platform_link_obligation' AND NON_UNIQUE=1 GROUP BY INDEX_NAME HAVING MAX(SUB_PART) IS NULL AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='obligation_id,tenant_id'
 UNION ALL SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='platform_payment_request_links' AND INDEX_NAME='idx_platform_link_target' AND NON_UNIQUE=1 GROUP BY INDEX_NAME HAVING MAX(SUB_PART) IS NULL AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='tenant_id,order_id,request_id,invoice_id,currency,amount_minor'
 UNION ALL SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='platform_payment_request_links' AND INDEX_NAME='idx_platform_link_allocation' AND NON_UNIQUE=1 GROUP BY INDEX_NAME HAVING MAX(SUB_PART) IS NULL AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='allocation_id,tenant_id'
 UNION ALL SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='platform_payment_request_links' AND INDEX_NAME='idx_platform_link_request' AND NON_UNIQUE=1 GROUP BY INDEX_NAME HAVING MAX(SUB_PART) IS NULL AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='request_id,tenant_id') AS c7_link_indexes);
SET @c7_link_fk_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=@c7_db AND TABLE_NAME='platform_payment_request_links' AND CONSTRAINT_NAME IN ('fk_platform_link_tenant','fk_platform_link_obligation','fk_platform_link_target','fk_platform_link_allocation','fk_platform_link_request'));
SET @c7_link_fk_shape = (SELECT COUNT(*) FROM (SELECT CONSTRAINT_NAME, GROUP_CONCAT(CONCAT(COLUMN_NAME,'>',REFERENCED_TABLE_NAME,'.',REFERENCED_COLUMN_NAME) ORDER BY ORDINAL_POSITION) AS shape FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA=@c7_db AND TABLE_NAME='platform_payment_request_links' AND REFERENCED_TABLE_NAME IS NOT NULL GROUP BY CONSTRAINT_NAME) q WHERE (CONSTRAINT_NAME='fk_platform_link_tenant' AND shape='tenant_id>tenants.id') OR (CONSTRAINT_NAME='fk_platform_link_obligation' AND shape='obligation_id>financial_settlement_obligations.id,tenant_id>financial_settlement_obligations.tenant_id') OR (CONSTRAINT_NAME='fk_platform_link_target' AND shape='tenant_id>checkout_order_platform_targets.tenant_id,order_id>checkout_order_platform_targets.order_id,request_id>checkout_order_platform_targets.request_id,invoice_id>checkout_order_platform_targets.invoice_id,currency>checkout_order_platform_targets.currency,amount_minor>checkout_order_platform_targets.amount_minor') OR (CONSTRAINT_NAME='fk_platform_link_allocation' AND shape='allocation_id>billing_payment_allocations.allocation_id,tenant_id>billing_payment_allocations.tenant_id') OR (CONSTRAINT_NAME='fk_platform_link_request' AND shape='request_id>billing_difference_requests.id,tenant_id>billing_difference_requests.tenant_id'));
SET @c7_link_fk_rules = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=@c7_db AND TABLE_NAME='platform_payment_request_links' AND CONSTRAINT_NAME IN ('fk_platform_link_tenant','fk_platform_link_obligation','fk_platform_link_target','fk_platform_link_allocation','fk_platform_link_request') AND DELETE_RULE='RESTRICT' AND UPDATE_RULE='RESTRICT');
SET @c7_link_check_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA=cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME=cc.CONSTRAINT_NAME WHERE tc.CONSTRAINT_SCHEMA=@c7_db AND tc.TABLE_NAME='platform_payment_request_links' AND tc.CONSTRAINT_TYPE='CHECK' AND tc.ENFORCED='YES' AND cc.CONSTRAINT_NAME='chk_platform_link_amount' AND REPLACE(REPLACE(LOWER(cc.CHECK_CLAUSE),' ',''),'`','')="(amount_minor>0andamount_minor<=1000000000000000)");
SET @c7_link_total_columns = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='platform_payment_request_links');
SET @c7_link_total_indexes = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='platform_payment_request_links');
SET @c7_link_total_fks = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=@c7_db AND TABLE_NAME='platform_payment_request_links');
SET @c7_link_total_checks = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='platform_payment_request_links' AND CONSTRAINT_TYPE='CHECK');

SET @c7_invoice_obligation_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='billing_invoice_obligations' AND ENGINE='InnoDB' AND TABLE_COLLATION='utf8mb4_unicode_ci');
SET @c7_invoice_columns_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='billing_invoice_obligations' AND ((COLUMN_NAME='invoice_id' AND COLUMN_TYPE='char(36)' AND IS_NULLABLE='NO' AND COLLATION_NAME='utf8mb4_unicode_ci') OR (COLUMN_NAME='tenant_id' AND COLUMN_TYPE='char(36)' AND IS_NULLABLE='NO' AND COLLATION_NAME='utf8mb4_unicode_ci') OR (COLUMN_NAME='currency' AND COLUMN_TYPE='char(3)' AND IS_NULLABLE='NO' AND COLLATION_NAME='utf8mb4_unicode_ci') OR (COLUMN_NAME='new_charge_minor' AND COLUMN_TYPE='bigint unsigned' AND IS_NULLABLE='NO') OR (COLUMN_NAME='carried_debt_reference_minor' AND COLUMN_TYPE='bigint unsigned' AND IS_NULLABLE='NO') OR (COLUMN_NAME='composition_version' AND COLUMN_TYPE='smallint unsigned' AND IS_NULLABLE='NO') OR (COLUMN_NAME='issued_at' AND COLUMN_TYPE='bigint unsigned' AND IS_NULLABLE='NO') OR (COLUMN_NAME='due_status' AND COLUMN_TYPE="enum('resolved','unresolved')" AND IS_NULLABLE='NO') OR (COLUMN_NAME='due_at' AND COLUMN_TYPE='bigint unsigned' AND IS_NULLABLE='YES') OR (COLUMN_NAME='due_basis_ref' AND COLUMN_TYPE='varchar(128)' AND IS_NULLABLE='YES' AND COLLATION_NAME='utf8mb4_0900_bin') OR (COLUMN_NAME='due_basis_version' AND COLUMN_TYPE='int unsigned' AND IS_NULLABLE='YES') OR (COLUMN_NAME='created_at' AND COLUMN_TYPE='timestamp(3)' AND IS_NULLABLE='NO')));
SET @c7_invoice_index_ok = (SELECT COUNT(*) FROM (
 SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='billing_invoice_obligations' AND INDEX_NAME='PRIMARY' AND NON_UNIQUE=0 GROUP BY INDEX_NAME HAVING MAX(SUB_PART) IS NULL AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='invoice_id'
 UNION ALL SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='billing_invoice_obligations' AND INDEX_NAME='uq_billing_invoice_obligation_invoice' AND NON_UNIQUE=0 GROUP BY INDEX_NAME HAVING MAX(SUB_PART) IS NULL AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='invoice_id,tenant_id'
 UNION ALL SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='billing_invoice_obligations' AND INDEX_NAME='idx_billing_invoice_obligation_invoice_currency' AND NON_UNIQUE=1 GROUP BY INDEX_NAME HAVING MAX(SUB_PART) IS NULL AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='invoice_id,tenant_id,currency'
 UNION ALL SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='billing_invoice_obligations' AND INDEX_NAME='idx_billing_invoice_obligation_tenant' AND NON_UNIQUE=1 GROUP BY INDEX_NAME HAVING MAX(SUB_PART) IS NULL AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='tenant_id') AS c7_invoice_indexes);
SET @c7_invoice_fk_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=@c7_db AND TABLE_NAME='billing_invoice_obligations' AND CONSTRAINT_NAME IN ('fk_billing_invoice_obligation_tenant','fk_billing_invoice_obligation_invoice'));
SET @c7_invoice_fk_shape = (SELECT COUNT(*) FROM (SELECT CONSTRAINT_NAME, GROUP_CONCAT(CONCAT(COLUMN_NAME,'>',REFERENCED_TABLE_NAME,'.',REFERENCED_COLUMN_NAME) ORDER BY ORDINAL_POSITION) AS shape FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA=@c7_db AND TABLE_NAME='billing_invoice_obligations' AND REFERENCED_TABLE_NAME IS NOT NULL GROUP BY CONSTRAINT_NAME) q WHERE (CONSTRAINT_NAME='fk_billing_invoice_obligation_tenant' AND shape='tenant_id>tenants.id') OR (CONSTRAINT_NAME='fk_billing_invoice_obligation_invoice' AND shape='invoice_id>billing_invoices.id,tenant_id>billing_invoices.tenant_id,currency>billing_invoices.currency'));
SET @c7_invoice_fk_rules = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=@c7_db AND TABLE_NAME='billing_invoice_obligations' AND CONSTRAINT_NAME IN ('fk_billing_invoice_obligation_tenant','fk_billing_invoice_obligation_invoice') AND DELETE_RULE='RESTRICT' AND UPDATE_RULE='RESTRICT');
SET @c7_invoice_check_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA=cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME=cc.CONSTRAINT_NAME WHERE tc.CONSTRAINT_SCHEMA=@c7_db AND tc.TABLE_NAME='billing_invoice_obligations' AND tc.CONSTRAINT_TYPE='CHECK' AND tc.ENFORCED='YES' AND ((cc.CONSTRAINT_NAME='chk_billing_invoice_obligation_amount' AND REPLACE(REPLACE(LOWER(cc.CHECK_CLAUSE),' ',''),'`','')="(new_charge_minor>0andnew_charge_minor<=1000000000000000andcarried_debt_reference_minor<=1000000000000000)") OR (cc.CONSTRAINT_NAME='chk_billing_invoice_obligation_due' AND REPLACE(REPLACE(LOWER(cc.CHECK_CLAUSE),' ',''),'`','')="((due_status='resolved'anddue_atisnotnullanddue_basis_refisnotnullanddue_basis_versionisnotnullanddue_basis_version>=1)or(due_status='unresolved'anddue_atisnullanddue_basis_refisnullanddue_basis_versionisnull))")));
SET @c7_invoice_total_columns = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='billing_invoice_obligations');
SET @c7_invoice_total_indexes = (SELECT COUNT(DISTINCT INDEX_NAME) FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='billing_invoice_obligations');
SET @c7_invoice_total_fks = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=@c7_db AND TABLE_NAME='billing_invoice_obligations');
SET @c7_invoice_total_checks = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='billing_invoice_obligations' AND CONSTRAINT_TYPE='CHECK');

SET @c7_sql_table_guard = IF(@c7_target_table_ok<>1 OR @c7_target_columns_ok<>8 OR @c7_target_total_columns<>8 OR @c7_target_index_ok<>5 OR @c7_target_total_indexes<>5 OR @c7_target_fk_ok<>4 OR @c7_target_total_fks<>4 OR @c7_target_fk_shape<>4 OR @c7_target_fk_rules<>4 OR @c7_target_check_ok<>2 OR @c7_target_total_checks<>2 OR
 @c7_link_table_ok<>1 OR @c7_link_columns_ok<>9 OR @c7_link_total_columns<>9 OR @c7_link_index_ok<>7 OR @c7_link_total_indexes<>7 OR @c7_link_fk_ok<>5 OR @c7_link_total_fks<>5 OR @c7_link_fk_shape<>5 OR @c7_link_fk_rules<>5 OR @c7_link_check_ok<>1 OR @c7_link_total_checks<>1 OR
 @c7_invoice_obligation_ok<>1 OR @c7_invoice_columns_ok<>12 OR @c7_invoice_total_columns<>12 OR @c7_invoice_index_ok<>4 OR @c7_invoice_total_indexes<>4 OR @c7_invoice_fk_ok<>2 OR @c7_invoice_total_fks<>2 OR @c7_invoice_fk_shape<>2 OR @c7_invoice_fk_rules<>2 OR @c7_invoice_check_ok<>2 OR @c7_invoice_total_checks<>2,
 'CALL c7_20261024_02_guard()', 'SELECT 1');
PREPARE c7_stmt_table_guard FROM @c7_sql_table_guard;
EXECUTE c7_stmt_table_guard;
DEALLOCATE PREPARE c7_stmt_table_guard;

-- Confirm the obligation status/CHECK output and receipt FK after ALTER.
SET @c7_final_obligation = IF(
 (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=@c7_db AND TABLE_NAME='financial_settlement_obligations' AND COLUMN_NAME IN ('allocatable_minor','platform_receipt_journal_id'))=2 AND
 (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=@c7_db AND TABLE_NAME='financial_settlement_obligations' AND CONSTRAINT_NAME IN ('chk_settlement_obligation_status','chk_settlement_obligation_platform','fk_settlement_obligation_platform_receipt'))=3,
 'SELECT 1','CALL c7_20261024_02_guard()');
PREPARE c7_stmt_final_obligation FROM @c7_final_obligation;
EXECUTE c7_stmt_final_obligation;
DEALLOCATE PREPARE c7_stmt_final_obligation;

DROP PROCEDURE c7_20261024_02_guard;
