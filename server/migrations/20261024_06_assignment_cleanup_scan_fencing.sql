-- Codex source correction after independent review; NO SQL executed.
-- One-time migration after20261018_08. Existing cleanup table, scan columns or
-- same-name index cause an explicit refusal. Do not blindly rerun a partial apply.
-- No table is accepted on index names or disabled/unverified CHECKs.
-- Before table mutation, verify base InnoDB/columns/PK and absence of new objects.
-- Requires MySQL8 enforced CHECK/NO PAD, routine privileges and DELIMITER-capable
-- client. DDL implicitly commits: cleanup CREATE can persist if later ALTER fails.
-- Reconcile such partial state explicitly; no automatic DROP/data deletion.
-- No provenance backfill, scanner activation, conditional-delete claim or wiring.
DELIMITER $$
CREATE PROCEDURE codex_guard_assignment_schema_20261024()
BEGIN
    DECLARE cleanup_exists INT;
    DECLARE base_ok INT;
    DECLARE base_columns INT;
    DECLARE additions INT;
    DECLARE claim_index INT;
    DECLARE pk_ok INT;
    SELECT COUNT(*) INTO cleanup_exists FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='assignment_cleanup_obligations';
    SELECT COUNT(*) INTO base_ok FROM information_schema.TABLES
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='assignment_submissions'
        AND ENGINE='InnoDB' AND TABLE_COLLATION='utf8mb4_unicode_ci';
    SELECT COUNT(*) INTO base_columns FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='assignment_submissions' AND (
        (COLUMN_NAME IN ('id','tenant_id','assignment_id','student_enrollment_id')
          AND COLUMN_TYPE='char(36)' AND IS_NULLABLE='NO' AND COLLATION_NAME='utf8mb4_unicode_ci')
        OR (COLUMN_NAME='status' AND COLUMN_TYPE='enum(''submitted'',''late'',''revoked'')' AND IS_NULLABLE='NO')
        OR (COLUMN_NAME='scan_status' AND COLUMN_TYPE='enum(''pending'',''clean'',''infected'',''failed'')' AND IS_NULLABLE='NO')
        OR (COLUMN_NAME='submitted_at' AND COLUMN_TYPE='timestamp' AND IS_NULLABLE='NO')
        OR (COLUMN_NAME='file_size_bytes' AND COLUMN_TYPE='bigint' AND IS_NULLABLE='NO')
        OR (COLUMN_NAME='storage_key' AND COLUMN_TYPE='varchar(255)' AND IS_NULLABLE='NO' AND COLLATION_NAME='utf8mb4_unicode_ci')
      );
    SELECT COUNT(*) INTO additions FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='assignment_submissions'
        AND COLUMN_NAME IN ('scan_claim_owner','scan_claim_version','scan_lease_until_ms',
          'scan_attempts','scan_last_error','scan_next_attempt_ms','object_etag');
    SELECT COUNT(*) INTO claim_index FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='assignment_submissions' AND INDEX_NAME='k_scan_claim';
    SELECT COUNT(*) INTO pk_ok FROM (
      SELECT INDEX_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='assignment_submissions'
        AND INDEX_NAME='PRIMARY' AND NON_UNIQUE=0 GROUP BY INDEX_NAME
      HAVING COUNT(*)=1 AND MAX(SUB_PART) IS NULL
         AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)='id'
    ) expected_pk;
    IF cleanup_exists<>0 OR base_ok<>1 OR base_columns<>9 OR additions<>0 OR claim_index<>0 OR pk_ok<>1 THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Assignment schema drift or prior partial apply; reconcile before retry';
    END IF;
END$$
DELIMITER ;
CALL codex_guard_assignment_schema_20261024();
CREATE TABLE assignment_cleanup_obligations (
        id CHAR(36) NOT NULL,
        tenant_id CHAR(36) NOT NULL,
        assignment_id CHAR(36) NOT NULL,
        student_enrollment_id CHAR(36) NOT NULL,
        submission_id CHAR(36) NOT NULL,
        storage_key VARCHAR(255) NOT NULL COMMENT 'Private opaque key; re-parsed and re-bound before any delete',
        object_etag VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL COMMENT 'Exact object-version identity; compared and stored byte-for-byte, NO PAD',
        object_size_bytes BIGINT NOT NULL,
        reason ENUM('admission_oversize','admission_size_out_of_bounds','admission_content_type_mismatch','admission_signature_mismatch','scan_infected','cancelled_upload') NOT NULL,
        state ENUM('pending','deleted','superseded') NOT NULL DEFAULT 'pending',
        claim_owner VARCHAR(64) NULL,
        claim_version INT NOT NULL DEFAULT 0,
        lease_until_ms BIGINT NULL,
        attempts INT NOT NULL DEFAULT 0,
        last_failure ENUM('capability_absent','store_error','binding_mismatch','record_state_invalid','legacy_etag_unprovable') NULL,
        retry_after_ms BIGINT NULL,
        completion_proof ENUM('store_removed','store_already_absent','pre_stat_absent','store_version_replaced','pre_stat_version_replaced') NULL,
        created_at_ms BIGINT NOT NULL,
        updated_at_ms BIGINT NOT NULL,
        completed_at_ms BIGINT NULL,
        PRIMARY KEY (id),
        UNIQUE KEY uq_cleanup_target (submission_id, object_etag, object_size_bytes),
        KEY k_cleanup_claim (state, created_at_ms, id),
        KEY k_cleanup_lease (state, lease_until_ms),
        KEY k_cleanup_tenant (tenant_id, state, created_at_ms),
        CONSTRAINT chk_assignment_cleanup_1 CHECK (object_size_bytes > 0),
        CONSTRAINT chk_assignment_cleanup_2 CHECK (CHAR_LENGTH(object_etag) > 0),
        CONSTRAINT chk_assignment_cleanup_3 CHECK (claim_version >= 0),
        CONSTRAINT chk_assignment_cleanup_4 CHECK (attempts >= 0),
        CONSTRAINT chk_assignment_cleanup_5 CHECK (created_at_ms >= 0),
        CONSTRAINT chk_assignment_cleanup_6 CHECK (updated_at_ms >= created_at_ms),
        CONSTRAINT chk_assignment_cleanup_7 CHECK (lease_until_ms IS NULL OR lease_until_ms > 0),
        CONSTRAINT chk_assignment_cleanup_8 CHECK (retry_after_ms IS NULL OR retry_after_ms >= 0),
        CONSTRAINT chk_assignment_cleanup_9 CHECK (completed_at_ms IS NULL OR completed_at_ms > 0),
        -- A stamped claim always writes owner + lease together; every release
        -- and completion path clears both (toRecord refuses a half-pair).
        CONSTRAINT chk_assignment_cleanup_10 CHECK ((claim_owner IS NULL) = (lease_until_ms IS NULL)),
        -- A terminal row must carry its proof and its settlement instant.
        CONSTRAINT chk_assignment_cleanup_11 CHECK ((state = 'pending') OR (completion_proof IS NOT NULL AND completed_at_ms IS NOT NULL)),
        CONSTRAINT chk_assignment_cleanup_12 CHECK ((state <> 'pending') OR (completion_proof IS NULL AND completed_at_ms IS NULL)),
        -- A settled row no longer holds a live fence.
        CONSTRAINT chk_assignment_cleanup_13 CHECK ((state = 'pending') OR (claim_owner IS NULL AND lease_until_ms IS NULL))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      COMMENT 'Durable exact-version cleanup obligations (assignment recovery)';
ALTER TABLE assignment_submissions
    ADD COLUMN scan_claim_owner VARCHAR(64) NULL,
    ADD COLUMN scan_claim_version INT NOT NULL DEFAULT 0,
    ADD COLUMN scan_lease_until_ms BIGINT NULL,
    ADD COLUMN scan_attempts INT NOT NULL DEFAULT 0,
    ADD COLUMN scan_last_error VARCHAR(255) NULL,
    ADD COLUMN scan_next_attempt_ms BIGINT NULL,
    ADD COLUMN object_etag VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
    ADD KEY k_scan_claim (scan_status, scan_next_attempt_ms, submitted_at, id),
    ADD CONSTRAINT chk_assignment_scan_version CHECK (scan_claim_version>=0),
    ADD CONSTRAINT chk_assignment_scan_attempts CHECK (scan_attempts>=0),
    ADD CONSTRAINT chk_assignment_scan_lease CHECK (scan_lease_until_ms IS NULL OR scan_lease_until_ms>0),
    ADD CONSTRAINT chk_assignment_scan_retry CHECK (scan_next_attempt_ms IS NULL OR scan_next_attempt_ms>0),
    ADD CONSTRAINT chk_assignment_scan_owner_pair CHECK ((scan_claim_owner IS NULL)=(scan_lease_until_ms IS NULL));
DROP PROCEDURE codex_guard_assignment_schema_20261024;
