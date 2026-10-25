-- Source only, not applied. Depends on 20261018_23_search_export.sql.
-- One-time migration tracked by runner: existing ownership columns/checks cause
-- ALTER to fail, rather than silently accepting an unknown partial schema.
-- Existing jobs remain unclaimed (NULL owner/lease, epoch zero). No jobs are
-- deleted, retried, marked complete/failed or given a fabricated owner.
-- MySQL8 enforced CHECK and utf8mb4_0900_bin required; no feature activation.
ALTER TABLE tenant_data_exports
    ADD COLUMN export_owner VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL,
    ADD COLUMN owner_epoch BIGINT UNSIGNED NOT NULL DEFAULT 0,
    ADD COLUMN owner_lease_until_ms BIGINT UNSIGNED NULL,
    ADD CONSTRAINT chk_tenant_export_owner_pair CHECK (
        (export_owner IS NULL) = (owner_lease_until_ms IS NULL)
    ),
    ADD CONSTRAINT chk_tenant_export_owner_epoch CHECK (owner_epoch <= 9007199254740991),
    ADD CONSTRAINT chk_tenant_export_owner_lease CHECK (
        owner_lease_until_ms IS NULL OR owner_lease_until_ms <= 9007199254740991
    ),
    ADD CONSTRAINT chk_tenant_export_owner_claim CHECK (
        export_owner IS NULL OR (CHAR_LENGTH(export_owner) > 0 AND owner_epoch > 0)
    );
-- Rollout is still held: service claim must pass a transaction-scoped callable
-- executor WITH query readback. Current anonymous execute wrapper lacks query,
-- so the existing concrete SQL port refuses instead of returning a grant.
