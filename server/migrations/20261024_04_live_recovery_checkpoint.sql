-- =============================================================================
-- R24 — live_recovery_checkpoints: one durable cursor for the ONE global
--        recording-recovery sweep
-- Task:    R24 checkpoint DDL (sole schema writer; source DDL only, never
--          executed; no runtime loop; no fake schema readiness)
-- Date:    2026-10-24
-- Depends: 20261022_06_live_sessions_recordings.sql (delivered and FROZEN,
--          sha256 391d0230…; NOT touched by this file), 20261023_02 for the
--          live callback/presence contract (NOT touched), 20261024_01..03
--          (NOT touched). Also untouched: every peer migration R16-R23 and
--          every source adapter file.
--
-- SOURCE CONTRACT (read from the code, not from memory — nothing invented)
--   Column list EXACTLY as CHECKPOINT_COLUMNS in
--   `server/src/services/live-recording-ingest-sql.ts` (lines ~916-928) and as
--   RECOVERY_CHECKPOINT_COLUMNS in `live-session-sql.ts` (~1444-1453), the
--   `recoveryCheckpoint` area of `verifyLiveSchema` (~1741-1770), which the
--   migration must satisfy column-for-column:
--     purpose, cursor_occurred_at_ms, cursor_id,
--     owner, lease_expires_at_ms,
--     row_version, sweep_generation, updated_at_ms
--
--   STATEMENT BINDINGS (every one of them, from the adapter SQL):
--   purpose
--     The FIXED server-owned key RECOVERY_CHECKPOINT_PURPOSE =
--     'recording-recovery-global' (25 chars). Bound in every INSERT value,
--     every ON-DUPLICATE no-op (`ON DUPLICATE KEY UPDATE purpose = purpose`
--     — requires purpose to be a PRIMARY/UNIQUE key, hence the key below)
--     and every CAS `WHERE purpose = ?`. PRIMARY KEY (purpose) is the table's
--     ONLY key: all four operations (claim/advance/completeSweep/release)
--     address the row by purpose alone; no other column is ever a search key,
--     so no index is added. One row = one global scan; NOT tenant-scoped and
--     carrying no tenant_id/FK by design (the port doc: "one global scan").
--   row_version
--     The fencing token. claimCheckpoint INSERTs it as 1
--     (`VALUES (?, NULL, NULL, NULL, NULL, 1, 0, ?)`); every winning CAS runs
--     `row_version = row_version + 1` and presents `WHERE row_version = ?`,
--     so a stale reader can never write again; release also increments it.
--     Affected rows = 1 is the win signal exactly because row_version always
--     changes (changed-rows semantics the adapter relies on). CHECK: >= 1
--     (the mapper readUnsignedInteger + "row_version is below 1" -> 1 is the
--     floor) and <= 9007199254740991 (safeinteger bound; the mapper refuses
--     anything outside ±2^53-1 rather than truncating).
--   sweep_generation
--     Completed-sweep counter. INSERT seeds 0; async completeSweepCheckpoint
--     runs `sweep_generation = sweep_generation + 1` and CASes on
--     `WHERE sweep_generation = ?`. Read back with readUnsignedInteger, so
--     the column is UNSIGNED. CHECK: BETWEEN 0 AND 9007199254740991.
--   cursor_occurred_at_ms / cursor_id  (PAIRED CHECK)
--     advanceCheckpoint writes BOTH or clears BOTH (completeSweep writes
--     `cursor_occurred_at_ms = NULL, cursor_id = NULL` in the SAME CAS as the
--     generation bump). The CAS matches the previous cursor with
--     `((? IS NULL AND cursor_occurred_at_ms IS NULL AND cursor_id IS NULL)
--         OR (cursor_occurred_at_ms = ? AND cursor_id = ?))` — so both arms
--     must hold the pair together exactly; half a cursor is unrepresentable.
--     mapCheckpointRow mirrors this: NULL must equal NULL, otherwise
--     invalid_row ("row holds half a cursor"). The pair CHECK below is that
--     predicate in DDL form.
--     cursor_occurred_at_ms: BIGINT (signed; read through readNullableInteger,
--     safe-integer validated both directions), the keyset page bound value
--     (occurring epoch ms of the last inspected ledger row).
--     cursor_id: VARCHAR(64) NULL — CHECKPOINT_CURSOR_ID_MAX_LENGTH (adapter
--     refuses a longer cursor id; the ingest ledger id is a 36-char UUID and
--     the column is deliberately wider). Byte-exact: `cursor_id = ?` and the
--     recovery pass compare ids BYTE FOR BYTE ("the id is compared BYTE FOR
--     BYTE... no trimming, no normalisation"), so the collation is
--     utf8mb4_0900_bin — NO PAD. A PAD collation would make 'x' match 'x   '
--     and two different cursor positions collapse into one CAS identity.
--   owner / lease_expires_at_ms  (PAIRED CHECK)
--     claim writes owner + lease_expires_at_ms TOGETHER (one statement), and
--     its predicate `owner IS NULL OR lease_expires_at_ms IS NULL OR
--     lease_expires_at_ms <= ?` takes the row only when unowned, half-lease or
--     expired; release clears BOTH together with `owner = NULL,
--     lease_expires_at_ms = NULL`; advance/completeSweep REFRESH the lease
--     inside the same CAS as the cursor move. Half a lease is invalid_row in
--     mapCheckpointRow ("row holds half a lease"). The CHECK below is that
--     pair rule in DDL form.
--     owner: VARCHAR(128) NULL — CHECKPOINT_OWNER_MAX_LENGTH (adapter refuses
--     a longer owner on write and on read). NO PAD utf8mb4_0900_bin: owner is
--     the claim identity (`WHERE owner = ?`, `state.owner !== expect.owner`).
--     lease_expires_at_ms: BIGINT NULL, safe-integer bound; CAS compares
--     `lease_expires_at_ms > ?` (live lease) and `<= ?` (expired/reclaimable).
--   updated_at_ms
--     Written by EVERY mutation (claim INSERT, claim UPDATE, advance,
--     completeSweep, release; bound to nowMs). Read with readSafeInteger in
--     readCheckpoint. NOT NULL with no DEFAULT (the adapter always supplies
--     it; nothing else may create rows). CHECK: <= 9007199254740991.
--   BIGINT safety (caller side, stated as a fact, not re-implemented here):
--   mysql2 must run with supportBigNumbers/bigNumberStrings so the adapter's
--   exact-integer-string validation holds for these BIGINT columns.
--
-- HOW THIS COMPLIES (fail-closed; no IF NOT EXISTS)
--   A plain CREATE TABLE: if the table ALREADY exists, MySQL aborts with 1050
--   and nothing of this run is silently accepted; there is no IF NOT EXISTS
--   anywhere in this file, so an SHAPED-different pre-existing table (drift)
--   is never swallowed and the run fails closed. After a successful create,
--   the exact column contract is independently re-measurable at runtime by
--   the EXISTING `verifyLiveSchema` executor (`recoveryCheckpoint` area,
--   which reports 'absent' for a missing table/column and 'verified' only
--   when all eight names above exist) — no schema readiness is faked here.
--   The port stays UNPROVEN until the adapter degrades with the real
--   'checkpoint-absent'/'schema-unavailable' answers on a real server; this
--   file claims no operational proof and no test is executed.
--
-- OWNERSHIP
--   No legacy or peer table is altered, dropped, renamed or backfilled. The
--   migration manifest is NOT touched here (registration owned elsewhere, as
--   in 06 and 20261023_02). Variable prefix none (no procedural guards are
--   needed: the file is one atomic CREATE; a failed CREATE aborts).
--
-- EXPLICITLY NOT ADDED (recorded so nothing is silent)
--   * no CHECK on non-empty purpose/owner/cursor_id strings: the adapter
--     refuses empty strings at requireText/requireCheckpointOwner before any
--     statement, and the source contract names no such DDL constraint;
--   * no lower-bound CHECKs on the three ms columns (the adapter accepts any
--     safe integer ms; only the safe-integer ceiling exists), no ENUM, no
--     DEFAULT on row_version/sweep_generation (the INSERT seeds 1/0);
--   * no index beyond the PRIMARY KEY (single-row PK access only).
--
-- UNRESOLVED ASSUMPTIONS TO VERIFY BEFORE REGISTRATION (none proven here)
--   * MySQL 8.0.16+ (CHECK constraints enforced) and the utf8mb4_0900_bin
--     collation (NO PAD) available — NOT on MariaDB.
--   * `sql_mode` without ANSI_QUOTES (single-quoted literals only here).
--   * STRICT mode (updated_at_ms and the unsigned counters always bound).
--   * purpose column size: the source fixes owner=128 and cursor_id=64 but
--     does NOT name a length for purpose (the constant string is 25 chars);
--     VARCHAR(64) is chosen following the house precedent for server-owned
--     purpose keys (e.g. settlement obligations `purpose VARCHAR(64)`), and
--     this is a chosen bound, not a dictated one.
--   * CHECK-constraint names below are chosen here; the adapter classifies by
--     driver code/message and never by constraint name, so no name is
--     load-bearing, but they must not collide with other CHECKs on this
--     table (a fresh table cannot collide).
--   * FILENAME DRIFT, recorded not repaired: the source texts request
--     `20261023_04_live_recovery_checkpoint.sql` (live-recording-recovery.ts
--     header, live-recording-ingest-sql.ts header, and the
--     verifyLiveSchema 'absent' reason string). The assignment for this
--     round delivers the same migration as `20261024_04_...` (this file).
--     Source adapters are NOT edited here, so those strings still name the
--     older spelling; the migration content itself matches the eight-column
--     contract they describe, and only the date prefix differs.
--   * No database, server, provider, test or manifest was touched by this
--     authoring run; nothing here was executed.
--
-- !! THIS FILE IS AUTHORING-ONLY SOURCE DDL. No statement here is executed,
--    no database is connected to. Registration is the runner's/manifest's.
-- =============================================================================

CREATE TABLE live_recovery_checkpoints (
    -- FK, the fixed server-owned scan key 'recording-recovery-global';
    -- ON DUPLICATE KEY UPDATE no-op seeding and every CAS bind `purpose = ?`.
    purpose VARCHAR(64) COLLATE utf8mb4_0900_bin NOT NULL
        COMMENT 'Fixed server-owned scan key (RECOVERY_CHECKPOINT_PURPOSE); never a caller-chosen value',

    cursor_occurred_at_ms BIGINT NULL
        COMMENT 'Cursor pair A: occurred_at_ms of the last INSPECTED ingest key; NULL = start at the beginning (full-sweep reset)',
    cursor_id VARCHAR(64) COLLATE utf8mb4_0900_bin NULL
        COMMENT 'Cursor pair B: ledger id of the same key, byte-exact under NO PAD utf8mb4_0900_bin',

    owner VARCHAR(128) COLLATE utf8mb4_0900_bin NULL
        COMMENT 'Lease pair A: the claim owner token (CHECKPOINT_OWNER_MAX_LENGTH); NULL = unowned',
    lease_expires_at_ms BIGINT NULL
        COMMENT 'Lease pair B: UTC epoch ms the claim lease expires; NULL = unowned (pair with owner)',

    row_version BIGINT UNSIGNED NOT NULL
        COMMENT 'Fencing token: INSERT seeds 1, every winning CAS does row_version + 1 and presents the value it last saw',
    sweep_generation BIGINT UNSIGNED NOT NULL
        COMMENT 'Completed-sweep counter: INSERT seeds 0, only a completed sweep CAS increments it (with the cursor reset in ONE statement)',
    updated_at_ms BIGINT NOT NULL
        COMMENT 'UTC epoch ms of the last mutation (claim/advance/completeSweep/release); always bound, never defaulted',

    PRIMARY KEY (purpose),
    CONSTRAINT chk_live_recovery_cursor_pair CHECK ((cursor_occurred_at_ms IS NULL) = (cursor_id IS NULL)),
    CONSTRAINT chk_live_recovery_lease_pair CHECK ((owner IS NULL) = (lease_expires_at_ms IS NULL)),
    CONSTRAINT chk_live_recovery_cursor_ms CHECK (cursor_occurred_at_ms IS NULL OR cursor_occurred_at_ms <= 9007199254740991),
    CONSTRAINT chk_live_recovery_lease_ms CHECK (lease_expires_at_ms IS NULL OR lease_expires_at_ms <= 9007199254740991),
    CONSTRAINT chk_live_recovery_version CHECK (row_version BETWEEN 1 AND 9007199254740991),
    CONSTRAINT chk_live_recovery_generation CHECK (sweep_generation BETWEEN 0 AND 9007199254740991),
    CONSTRAINT chk_live_recovery_changed_ms CHECK (updated_at_ms <= 9007199254740991)
) ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin
  COMMENT 'R24: the one durable recovery sweep cursor; purpose is a singleton key, owner/lease and cursor/ms are ALL-or-NULL pairs';
