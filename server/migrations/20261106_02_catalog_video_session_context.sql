-- FILE ONLY. No migration application or existing-session backfill authorized.
-- Context is persisted in the same INSERT as its video session, never attached later.
ALTER TABLE video_sessions ADD COLUMN catalog_context JSON NULL;
