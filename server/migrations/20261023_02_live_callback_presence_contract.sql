-- =============================================================================
-- CL-E — live callback / presence contract (R22 presence-event cursor,
--        R23 callback outcome vocabulary) — ADDITIVE migration on top of 06
-- Task:    CL-E (sole schema writer; source DDL only, never executed)
-- Date:    2026-10-23
-- Depends: 20261022_06_live_sessions_recordings.sql (delivered and FROZEN,
--          sha256 391d02304861095056f89daf69c228e5149f8ac44ba5d499ddc0dea646566846;
--          NOT edited by this file).
--
-- WHAT THIS FILE DOES
--   1. R22: adds a PRESENCE-EVENT CURSOR to live_session_participants:
--        presence_event_at_ms BIGINT NULL
--        presence_event_id    VARCHAR(128) NULL, utf8mb4 / utf8mb4_0900_bin
--      and the explicitly named paired-NULL CHECK
--        chk_live_participant_cursor_pair:
--        (presence_event_at_ms IS NULL) = (presence_event_id IS NULL).
--      This is an event-ORDERING cursor (the provider event time and byte-exact
--      provider event identity of the newest presence event applied to the
--      participant). It is NOT a heartbeat and NOT last_seen_at_ms. Existing
--      rows stay NULL/NULL: no backfill, no fabricated historical event time.
--      The binary collation makes event identity byte-exact (case, accents and
--      trailing spaces are significant). The column/CHECK SHAPE is verified on
--      a pre-existing catalog and drift fails closed.
--   2. R23: replaces chk_live_callback_outcome (live_session_callbacks) by
--      chk_live_callback_outcome_v2, which admits every current value
--      (pending, applied, rejected:illegal-transition,
--      ignored:unknown-participant, ignored:malformed) PLUS
--      ignored:mapping-unavailable, ignored:ordering-unavailable,
--      ignored:stale-event, ignored:ambiguous-event. The replacement is
--      installed in ONE atomic ALTER (DROP old CHECK + ADD new CHECK), so the
--      table never has an instant without an outcome CHECK and the new
--      protection is effective in the same statement that removes the old one.
--      Nothing in this file grants any callback a tenant or provider
--      participant mapping.
--   3. Ingest outcomes ignored:outside-grace and ignored:session-cancelled:
--      live_recording_ingests.outcome is VARCHAR(32) with NO outcome-domain
--      CHECK in 06 (only chk_live_ingest_lease_pair and
--      chk_live_ingest_terminal_release, which constrain the lease, not the
--      vocabulary). Both strings (21 and 25 chars) fit. NO DDL is therefore
--      added for them; this file only verifies the column is a VARCHAR of at
--      least 25 characters (fail closed otherwise).
--   No table is dropped, no data is deleted or updated, no index is added or
--   dropped, FOREIGN_KEY_CHECKS is not touched.
--
-- OWNERSHIP / RUNNER
--   Source DDL only, UNEXECUTED, NOT in the manifest (Codex owns registration).
--   Variable prefix c6_, helper prefix c6_20261023_02_.
--
-- ASSUMPTIONS THAT ARE UNPROVEN (verify on a live server before registration)
--   * The migration account holds CREATE ROUTINE and ALTER ROUTINE (DROP) in
--     addition to ALTER/DDL rights, and, when binary logging is on,
--     log_bin_trust_function_creators permits the routine.
--   * MySQL 8.0.16+ semantics: ALTER TABLE ... DROP CHECK, ADD CONSTRAINT CHECK
--     enforced, and the utf8mb4_0900_bin collation exists (8.0.17+ for the
--     INFORMATION_SCHEMA spellings used here). It is NOT available on MariaDB.
--   * sql_mode does not include ANSI_QUOTES (double-quoted SQL string literals
--     are used for the prepared statement texts, as in 06).
--   * The CHECK_CLAUSE renderings in the allowlists below are ASSUMED from the
--     DDL text MySQL 8.0 is expected to store; they are NOT confirmed. A
--     recognition miss on a PRE-EXISTING object fails closed (the old
--     protection is kept); it never silently accepts drift. Our own atomic ALTER
--     never depends on recognition.
--
-- SHAPE RECOGNITION RULES (copied from 20261022_02)
--   CHECK_CLAUSE is normalized by LOWER() and removal of backticks, space, tab,
--   LF and CR ONLY. PARENTHESES ARE NEVER STRIPPED. A pre-existing CHECK is
--   accepted only when the normalized clause equals one explicit rendering.
--   A flat `a IS NULL = b IS NULL` rendering is deliberately NOT recognised
--   (it parses as ((a IS NULL) = b) IS NULL, a different predicate).
--
-- PARTIAL-APPLICATION STATES -- callback outcome CHECK (all re-runnable;
--   probes are recomputed after each mutation). O = chk_live_callback_outcome
--   present, N = chk_live_callback_outcome_v2 present:
--     A  O present (recognised old shape), N absent -> ONE atomic ALTER:
--        DROP CHECK old + ADD v2 (our own output; not re-recognised).
--     A' O present with an UNRECOGNISED shape, N absent -> NOTHING changes
--        (old protection kept) and the final guard SIGNALs.
--     B  O absent, N present and recognised -> no-op.
--     C  O absent, N present and unrecognised -> SIGNAL (weak shape).
--     D  O and N present, N recognised -> drop ONLY the old CHECK.
--     E  O and N present, N unrecognised -> old kept, SIGNAL.
--     F  neither present -> ADD v2 (our own output; not re-recognised).
--   A missing live_session_callbacks / live_recording_ingests table, or an
--   outcome column that is not a VARCHAR of sufficient length, also SIGNALs
--   (prerequisite drift); this migration never creates those tables.
--
-- PARTIAL-APPLICATION STATES -- participant cursor (columns A=at_ms, I=id,
--   K=chk_live_participant_cursor_pair):
--     all three absent -> ONE ALTER adds both columns and the CHECK.
--     A or I absent (others present) -> the missing column is added alone.
--     both columns present, shape correct, K absent -> ADD K (validates rows;
--        a row violating the pair rule fails the ALTER closed natively).
--     any column present with a wrong shape (type, signedness, nullability,
--        default, generated, charset, collation, length) -> NOTHING is
--        altered and the final guard SIGNALs.
--     K present but unrecognised and not added by this run -> SIGNAL.
--
-- PRIVILEGES / PERSISTENT ROUTINES / MANUAL CLEANUP
--   SIGNAL is not preparable and MySQL 8.0 rejects CREATE/DROP PROCEDURE inside
--   a prepared statement, so each guard is a LITERAL, UNCONDITIONAL top-level
--   CREATE PROCEDURE of ONE SIGNAL statement (no BEGIN/END, no DELIMITER),
--   with a migration-unique name and the marker COMMENT
--   'tabweb 20261023_02 guard helper (safe to drop)':
--     c6_20261023_02_guard_cursor_fail   (participant cursor shape guard)
--     c6_20261023_02_guard_outcome_fail  (callback/ingest outcome guard)
--   Only the CALL is dispatched through PREPARE/EXECUTE/DEALLOCATE. EVERY run,
--   including a clean one, therefore needs CREATE ROUTINE and ALTER ROUTINE.
--   Routines are PERSISTENT objects: there is deliberately NO
--   `DROP PROCEDURE IF EXISTS` before a CREATE (a literal CREATE fails with
--   error 1304 on a name collision, so nothing is overwritten). A literal DROP
--   follows each dispatch and is reachable only when this run's CREATE of that
--   exact name succeeded and the CALL did not abort the script. After a drift
--   failure the helper REMAINS by design; after reconciling the drift, drop it
--   manually before the rerun:
--     DROP PROCEDURE c6_20261023_02_guard_cursor_fail;
--     DROP PROCEDURE c6_20261023_02_guard_outcome_fail;
--   If the script dies between a CREATE and its DROP for any other reason
--   (connection loss), the same manual DROP applies.
--
-- !! THIS FILE IS AUTHORING-ONLY SOURCE DDL. No statement here is executed and
--    no database is connected to. Manifest registration is Codex's.
-- =============================================================================

SET @c6_db = DATABASE();

-- =============================================================================
-- PART 1 — R22 presence-event cursor on live_session_participants
-- =============================================================================

SET @c6_lp_has = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c6_db AND TABLE_NAME = 'live_session_participants');

SET @c6_cur_at_0 = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c6_db AND TABLE_NAME = 'live_session_participants' AND COLUMN_NAME = 'presence_event_at_ms');
SET @c6_cur_id_0 = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c6_db AND TABLE_NAME = 'live_session_participants' AND COLUMN_NAME = 'presence_event_id');
SET @c6_cur_chk_0 = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c6_db AND TABLE_NAME = 'live_session_participants'
      AND CONSTRAINT_TYPE = 'CHECK' AND CONSTRAINT_NAME = 'chk_live_participant_cursor_pair');

-- Clean path: all three absent -> one ALTER adds both columns and the CHECK.
SET @c6_cur_all_needed = IF(@c6_lp_has = 1 AND @c6_cur_at_0 = 0 AND @c6_cur_id_0 = 0 AND @c6_cur_chk_0 = 0, 1, 0);
SET @c6_sql_cur_all = IF(@c6_cur_all_needed = 1,
    "ALTER TABLE live_session_participants ADD COLUMN presence_event_at_ms BIGINT NULL COMMENT 'R22 presence-event cursor: provider event time (UTC epoch ms) of the newest applied presence event, NULL until one is applied, not a heartbeat', ADD COLUMN presence_event_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL COMMENT 'R22 presence-event cursor: byte-exact provider event identity paired with presence_event_at_ms', ADD CONSTRAINT chk_live_participant_cursor_pair CHECK ((presence_event_at_ms IS NULL) = (presence_event_id IS NULL))",
    'SELECT 1');
PREPARE c6_stmt_cur_all FROM @c6_sql_cur_all;
EXECUTE c6_stmt_cur_all;
DEALLOCATE PREPARE c6_stmt_cur_all;

-- Probes recomputed AFTER the combined ALTER.
SET @c6_cur_at_1 = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c6_db AND TABLE_NAME = 'live_session_participants' AND COLUMN_NAME = 'presence_event_at_ms');
SET @c6_cur_id_1 = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c6_db AND TABLE_NAME = 'live_session_participants' AND COLUMN_NAME = 'presence_event_id');

-- Partial catalog: add only the missing column (shape is verified below).
SET @c6_sql_cur_at = IF(@c6_lp_has = 1 AND @c6_cur_at_1 = 0,
    "ALTER TABLE live_session_participants ADD COLUMN presence_event_at_ms BIGINT NULL COMMENT 'R22 presence-event cursor: provider event time (UTC epoch ms) of the newest applied presence event, NULL until one is applied, not a heartbeat'",
    'SELECT 1');
PREPARE c6_stmt_cur_at FROM @c6_sql_cur_at;
EXECUTE c6_stmt_cur_at;
DEALLOCATE PREPARE c6_stmt_cur_at;

SET @c6_sql_cur_id = IF(@c6_lp_has = 1 AND @c6_cur_id_1 = 0,
    "ALTER TABLE live_session_participants ADD COLUMN presence_event_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL COMMENT 'R22 presence-event cursor: byte-exact provider event identity paired with presence_event_at_ms'",
    'SELECT 1');
PREPARE c6_stmt_cur_id FROM @c6_sql_cur_id;
EXECUTE c6_stmt_cur_id;
DEALLOCATE PREPARE c6_stmt_cur_id;

-- Probes recomputed AFTER the single-column adds: existence AND shape.
SET @c6_cur_at_ok_2 = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c6_db AND TABLE_NAME = 'live_session_participants'
      AND COLUMN_NAME = 'presence_event_at_ms'
      AND DATA_TYPE = 'bigint' AND COLUMN_TYPE NOT LIKE '%unsigned%'
      AND IS_NULLABLE = 'YES' AND COLUMN_DEFAULT IS NULL
      AND EXTRA = '' AND COALESCE(GENERATION_EXPRESSION, '') = '');
SET @c6_cur_id_ok_2 = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c6_db AND TABLE_NAME = 'live_session_participants'
      AND COLUMN_NAME = 'presence_event_id'
      AND DATA_TYPE = 'varchar' AND CHARACTER_MAXIMUM_LENGTH = 128
      AND CHARACTER_SET_NAME = 'utf8mb4' AND COLLATION_NAME = 'utf8mb4_0900_bin'
      AND IS_NULLABLE = 'YES' AND COLUMN_DEFAULT IS NULL
      AND EXTRA = '' AND COALESCE(GENERATION_EXPRESSION, '') = '');
SET @c6_cur_chk_2 = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c6_db AND TABLE_NAME = 'live_session_participants'
      AND CONSTRAINT_TYPE = 'CHECK' AND CONSTRAINT_NAME = 'chk_live_participant_cursor_pair');

-- Add the pair CHECK only when BOTH columns exist with the correct shape.
SET @c6_cur_chk_add_needed = IF(@c6_lp_has = 1 AND @c6_cur_at_ok_2 = 1 AND @c6_cur_id_ok_2 = 1 AND @c6_cur_chk_2 = 0, 1, 0);
SET @c6_sql_cur_chk = IF(@c6_cur_chk_add_needed = 1,
    'ALTER TABLE live_session_participants ADD CONSTRAINT chk_live_participant_cursor_pair CHECK ((presence_event_at_ms IS NULL) = (presence_event_id IS NULL))',
    'SELECT 1');
PREPARE c6_stmt_cur_chk FROM @c6_sql_cur_chk;
EXECUTE c6_stmt_cur_chk;
DEALLOCATE PREPARE c6_stmt_cur_chk;

-- Final probes (recomputed AFTER every mutation of PART 1).
SET @c6_cur_at_ok_end = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c6_db AND TABLE_NAME = 'live_session_participants'
      AND COLUMN_NAME = 'presence_event_at_ms'
      AND DATA_TYPE = 'bigint' AND COLUMN_TYPE NOT LIKE '%unsigned%'
      AND IS_NULLABLE = 'YES' AND COLUMN_DEFAULT IS NULL
      AND EXTRA = '' AND COALESCE(GENERATION_EXPRESSION, '') = '');
SET @c6_cur_id_ok_end = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c6_db AND TABLE_NAME = 'live_session_participants'
      AND COLUMN_NAME = 'presence_event_id'
      AND DATA_TYPE = 'varchar' AND CHARACTER_MAXIMUM_LENGTH = 128
      AND CHARACTER_SET_NAME = 'utf8mb4' AND COLLATION_NAME = 'utf8mb4_0900_bin'
      AND IS_NULLABLE = 'YES' AND COLUMN_DEFAULT IS NULL
      AND EXTRA = '' AND COALESCE(GENERATION_EXPRESSION, '') = '');
SET @c6_cur_chk_end = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c6_db AND TABLE_NAME = 'live_session_participants'
      AND CONSTRAINT_TYPE = 'CHECK' AND CONSTRAINT_NAME = 'chk_live_participant_cursor_pair');

SET @c6_cur_chk_clause_end = (SELECT
    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
        LOWER(CHECK_CLAUSE),
        '`', ''),
        ' ', ''),
        CHAR(9), ''),
        CHAR(10), ''),
        CHAR(13), '')
    FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c6_db
      AND CONSTRAINT_NAME = 'chk_live_participant_cursor_pair'
      AND EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS enforced_check
          WHERE enforced_check.CONSTRAINT_SCHEMA = @c6_db
            AND enforced_check.CONSTRAINT_NAME = 'chk_live_participant_cursor_pair'
            AND enforced_check.CONSTRAINT_TYPE = 'CHECK' AND enforced_check.ENFORCED = 'YES'));

-- Recognised renderings (ASSUMED, verify live). Parentheses preserved.
SET @c6_cur_clause_r1 = '((presence_event_at_msisnull)=(presence_event_idisnull))';
SET @c6_cur_clause_r2 = '(presence_event_at_msisnull)=(presence_event_idisnull)';

SET @c6_cur_chk_recognised_end = IF(@c6_cur_chk_end = 1
    AND @c6_cur_chk_clause_end IN (@c6_cur_clause_r1, @c6_cur_clause_r2), 1, 0);

-- True when THIS run added the CHECK itself (our own output is authoritative).
SET @c6_cur_chk_added_here = IF(@c6_cur_all_needed = 1 OR @c6_cur_chk_add_needed = 1, 1, 0);

SET @c6_cur_drift = IF(@c6_lp_has = 0
    OR @c6_cur_at_ok_end = 0
    OR @c6_cur_id_ok_end = 0
    OR @c6_cur_chk_end = 0
    OR (@c6_cur_chk_recognised_end = 0 AND @c6_cur_chk_added_here = 0), 1, 0);

CREATE PROCEDURE c6_20261023_02_guard_cursor_fail()
    COMMENT 'tabweb 20261023_02 guard helper (safe to drop)'
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Schema drift; reconcile, remove helper c6_20261023_02_guard_cursor_fail, then rerun.';

SET @c6_sql_cur_signal = IF(@c6_cur_drift = 1,
    'CALL c6_20261023_02_guard_cursor_fail()',
    'SELECT 1');
PREPARE c6_stmt_cur_signal FROM @c6_sql_cur_signal;
EXECUTE c6_stmt_cur_signal;
DEALLOCATE PREPARE c6_stmt_cur_signal;

DROP PROCEDURE c6_20261023_02_guard_cursor_fail;

-- =============================================================================
-- PART 2 — R23 callback outcome vocabulary (and ingest outcome verification)
-- =============================================================================

SET @c6_lc_has = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = @c6_db AND TABLE_NAME = 'live_session_callbacks');

-- Outcome column must be a VARCHAR long enough for the longest new value
-- ('ignored:ordering-unavailable' = 28 characters).
SET @c6_lc_outcome_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c6_db AND TABLE_NAME = 'live_session_callbacks'
      AND COLUMN_NAME = 'outcome' AND DATA_TYPE = 'varchar'
      AND CHARACTER_MAXIMUM_LENGTH >= 28);

-- Ingest outcome: no CHECK is added; only verify it can hold
-- 'ignored:session-cancelled' (25 characters) and is not an ENUM.
SET @c6_li_outcome_ok = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = @c6_db AND TABLE_NAME = 'live_recording_ingests'
      AND COLUMN_NAME = 'outcome' AND DATA_TYPE = 'varchar'
      AND CHARACTER_MAXIMUM_LENGTH >= 25);

SET @c6_oc_old_0 = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c6_db AND TABLE_NAME = 'live_session_callbacks'
      AND CONSTRAINT_TYPE = 'CHECK' AND CONSTRAINT_NAME = 'chk_live_callback_outcome');
SET @c6_oc_new_0 = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c6_db AND TABLE_NAME = 'live_session_callbacks'
      AND CONSTRAINT_TYPE = 'CHECK' AND CONSTRAINT_NAME = 'chk_live_callback_outcome_v2');

SET @c6_oc_old_clause_0 = (SELECT
    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
        LOWER(CHECK_CLAUSE),
        '`', ''),
        ' ', ''),
        CHAR(9), ''),
        CHAR(10), ''),
        CHAR(13), '')
    FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c6_db
      AND CONSTRAINT_NAME = 'chk_live_callback_outcome'
      AND EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS enforced_check
          WHERE enforced_check.CONSTRAINT_SCHEMA = @c6_db
            AND enforced_check.CONSTRAINT_NAME = 'chk_live_callback_outcome'
            AND enforced_check.CONSTRAINT_TYPE = 'CHECK' AND enforced_check.ENFORCED = 'YES'));

-- Recognised renderings of the OLD (06) CHECK: the five current values in the
-- 06 order. ASSUMED, verify live. Parentheses preserved; only these exact
-- strings are accepted. (_utf8mb4 introducer variants cover MySQL's stored form.)
SET @c6_oc_old_r1 = "(outcomein('pending','applied','rejected:illegal-transition','ignored:unknown-participant','ignored:malformed'))";
SET @c6_oc_old_r2 = "outcomein('pending','applied','rejected:illegal-transition','ignored:unknown-participant','ignored:malformed')";
SET @c6_oc_old_r3 = "(outcomein(_utf8mb4'pending',_utf8mb4'applied',_utf8mb4'rejected:illegal-transition',_utf8mb4'ignored:unknown-participant',_utf8mb4'ignored:malformed'))";
SET @c6_oc_old_r4 = "outcomein(_utf8mb4'pending',_utf8mb4'applied',_utf8mb4'rejected:illegal-transition',_utf8mb4'ignored:unknown-participant',_utf8mb4'ignored:malformed')";

-- Recognised renderings of the REPLACEMENT: the nine values in this file's order.
SET @c6_oc_new_r1 = "(outcomein('pending','applied','rejected:illegal-transition','ignored:unknown-participant','ignored:malformed','ignored:mapping-unavailable','ignored:ordering-unavailable','ignored:stale-event','ignored:ambiguous-event'))";
SET @c6_oc_new_r2 = "outcomein('pending','applied','rejected:illegal-transition','ignored:unknown-participant','ignored:malformed','ignored:mapping-unavailable','ignored:ordering-unavailable','ignored:stale-event','ignored:ambiguous-event')";
SET @c6_oc_new_r3 = "(outcomein(_utf8mb4'pending',_utf8mb4'applied',_utf8mb4'rejected:illegal-transition',_utf8mb4'ignored:unknown-participant',_utf8mb4'ignored:malformed',_utf8mb4'ignored:mapping-unavailable',_utf8mb4'ignored:ordering-unavailable',_utf8mb4'ignored:stale-event',_utf8mb4'ignored:ambiguous-event'))";
SET @c6_oc_new_r4 = "outcomein(_utf8mb4'pending',_utf8mb4'applied',_utf8mb4'rejected:illegal-transition',_utf8mb4'ignored:unknown-participant',_utf8mb4'ignored:malformed',_utf8mb4'ignored:mapping-unavailable',_utf8mb4'ignored:ordering-unavailable',_utf8mb4'ignored:stale-event',_utf8mb4'ignored:ambiguous-event')";

SET @c6_oc_old_recognised_0 = IF(@c6_oc_old_0 = 1
    AND @c6_oc_old_clause_0 IN (@c6_oc_old_r1, @c6_oc_old_r2, @c6_oc_old_r3, @c6_oc_old_r4), 1, 0);

-- State A: old present with a recognised shape and the replacement absent ->
-- ONE atomic ALTER drops the old CHECK and adds the replacement. State A'
-- (old present, shape unrecognised) deliberately does nothing here.
SET @c6_oc_evolve_needed = IF(@c6_lc_has = 1 AND @c6_lc_outcome_ok = 1
    AND @c6_oc_old_0 = 1 AND @c6_oc_new_0 = 0 AND @c6_oc_old_recognised_0 = 1, 1, 0);
SET @c6_sql_oc_evolve = IF(@c6_oc_evolve_needed = 1,
    "ALTER TABLE live_session_callbacks DROP CHECK chk_live_callback_outcome, ADD CONSTRAINT chk_live_callback_outcome_v2 CHECK (outcome IN ('pending','applied','rejected:illegal-transition','ignored:unknown-participant','ignored:malformed','ignored:mapping-unavailable','ignored:ordering-unavailable','ignored:stale-event','ignored:ambiguous-event'))",
    'SELECT 1');
PREPARE c6_stmt_oc_evolve FROM @c6_sql_oc_evolve;
EXECUTE c6_stmt_oc_evolve;
DEALLOCATE PREPARE c6_stmt_oc_evolve;

-- Probes recomputed AFTER state A.
SET @c6_oc_old_1 = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c6_db AND TABLE_NAME = 'live_session_callbacks'
      AND CONSTRAINT_TYPE = 'CHECK' AND CONSTRAINT_NAME = 'chk_live_callback_outcome');
SET @c6_oc_new_1 = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c6_db AND TABLE_NAME = 'live_session_callbacks'
      AND CONSTRAINT_TYPE = 'CHECK' AND CONSTRAINT_NAME = 'chk_live_callback_outcome_v2');

-- State F: neither present -> add the replacement (our own output).
SET @c6_oc_add_needed = IF(@c6_lc_has = 1 AND @c6_lc_outcome_ok = 1
    AND @c6_oc_old_1 = 0 AND @c6_oc_new_1 = 0, 1, 0);
SET @c6_sql_oc_add = IF(@c6_oc_add_needed = 1,
    "ALTER TABLE live_session_callbacks ADD CONSTRAINT chk_live_callback_outcome_v2 CHECK (outcome IN ('pending','applied','rejected:illegal-transition','ignored:unknown-participant','ignored:malformed','ignored:mapping-unavailable','ignored:ordering-unavailable','ignored:stale-event','ignored:ambiguous-event'))",
    'SELECT 1');
PREPARE c6_stmt_oc_add FROM @c6_sql_oc_add;
EXECUTE c6_stmt_oc_add;
DEALLOCATE PREPARE c6_stmt_oc_add;

-- Probes recomputed AFTER state F, plus the replacement clause.
SET @c6_oc_old_2 = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c6_db AND TABLE_NAME = 'live_session_callbacks'
      AND CONSTRAINT_TYPE = 'CHECK' AND CONSTRAINT_NAME = 'chk_live_callback_outcome');
SET @c6_oc_new_2 = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c6_db AND TABLE_NAME = 'live_session_callbacks'
      AND CONSTRAINT_TYPE = 'CHECK' AND CONSTRAINT_NAME = 'chk_live_callback_outcome_v2');
SET @c6_oc_new_clause_2 = (SELECT
    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
        LOWER(CHECK_CLAUSE),
        '`', ''),
        ' ', ''),
        CHAR(9), ''),
        CHAR(10), ''),
        CHAR(13), '')
    FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c6_db
      AND CONSTRAINT_NAME = 'chk_live_callback_outcome_v2'
      AND EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS enforced_check
          WHERE enforced_check.CONSTRAINT_SCHEMA = @c6_db
            AND enforced_check.CONSTRAINT_NAME = 'chk_live_callback_outcome_v2'
            AND enforced_check.CONSTRAINT_TYPE = 'CHECK' AND enforced_check.ENFORCED = 'YES'));
SET @c6_oc_new_recognised_2 = IF(@c6_oc_new_2 = 1
    AND @c6_oc_new_clause_2 IN (@c6_oc_new_r1, @c6_oc_new_r2, @c6_oc_new_r3, @c6_oc_new_r4), 1, 0);

-- True when THIS run installed the replacement (state A or F); that output is
-- authoritative and is not re-recognised.
SET @c6_oc_added_here = IF(@c6_oc_evolve_needed = 1 OR @c6_oc_add_needed = 1, 1, 0);

-- State D: both present and the replacement recognised -> drop ONLY the old
-- CHECK (the replacement is already effective, so nothing is unprotected).
-- An unrecognised replacement (state E) never triggers this statement.
SET @c6_sql_oc_old_drop = IF(@c6_lc_has = 1
    AND @c6_oc_old_2 = 1 AND @c6_oc_new_2 = 1
    AND @c6_oc_new_recognised_2 = 1,
    'ALTER TABLE live_session_callbacks DROP CHECK chk_live_callback_outcome',
    'SELECT 1');
PREPARE c6_stmt_oc_old_drop FROM @c6_sql_oc_old_drop;
EXECUTE c6_stmt_oc_old_drop;
DEALLOCATE PREPARE c6_stmt_oc_old_drop;

-- Final probes (recomputed AFTER state D) and the fail-closed decision.
SET @c6_oc_old_end = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c6_db AND TABLE_NAME = 'live_session_callbacks'
      AND CONSTRAINT_TYPE = 'CHECK' AND CONSTRAINT_NAME = 'chk_live_callback_outcome');
SET @c6_oc_new_end = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c6_db AND TABLE_NAME = 'live_session_callbacks'
      AND CONSTRAINT_TYPE = 'CHECK' AND CONSTRAINT_NAME = 'chk_live_callback_outcome_v2');
SET @c6_oc_new_clause_end = (SELECT
    REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
        LOWER(CHECK_CLAUSE),
        '`', ''),
        ' ', ''),
        CHAR(9), ''),
        CHAR(10), ''),
        CHAR(13), '')
    FROM INFORMATION_SCHEMA.CHECK_CONSTRAINTS
    WHERE CONSTRAINT_SCHEMA = @c6_db
      AND CONSTRAINT_NAME = 'chk_live_callback_outcome_v2'
      AND EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS enforced_check
          WHERE enforced_check.CONSTRAINT_SCHEMA = @c6_db
            AND enforced_check.CONSTRAINT_NAME = 'chk_live_callback_outcome_v2'
            AND enforced_check.CONSTRAINT_TYPE = 'CHECK' AND enforced_check.ENFORCED = 'YES'));
SET @c6_oc_new_recognised_end = IF(@c6_oc_new_end = 1
    AND @c6_oc_new_clause_end IN (@c6_oc_new_r1, @c6_oc_new_r2, @c6_oc_new_r3, @c6_oc_new_r4), 1, 0);

SET @c6_oc_drift = IF(@c6_lc_has = 0
    OR @c6_lc_outcome_ok = 0
    OR @c6_li_outcome_ok = 0
    OR @c6_oc_old_end = 1
    OR @c6_oc_new_end = 0
    OR (@c6_oc_new_recognised_end = 0 AND @c6_oc_added_here = 0), 1, 0);

CREATE PROCEDURE c6_20261023_02_guard_outcome_fail()
    COMMENT 'tabweb 20261023_02 guard helper (safe to drop)'
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Schema drift; reconcile, remove helper c6_20261023_02_guard_outcome_fail, then rerun.';

SET @c6_sql_oc_signal = IF(@c6_oc_drift = 1,
    'CALL c6_20261023_02_guard_outcome_fail()',
    'SELECT 1');
PREPARE c6_stmt_oc_signal FROM @c6_sql_oc_signal;
EXECUTE c6_stmt_oc_signal;
DEALLOCATE PREPARE c6_stmt_oc_signal;

DROP PROCEDURE c6_20261023_02_guard_outcome_fail;
