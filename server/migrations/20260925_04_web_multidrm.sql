-- Managed multi-DRM delivery (Widevine/FairPlay) metadata.
-- Existing MinIO videos stay marked as legacy and must be re-uploaded before
-- VIDEO_DRM_REQUIRED can be enforced for every viewer.

ALTER TABLE videos
  ADD COLUMN delivery_provider ENUM('minio','vdocipher') NOT NULL DEFAULT 'minio' AFTER uploaded_by,
  ADD COLUMN drm_asset_id VARCHAR(80) NULL AFTER delivery_provider,
  ADD COLUMN drm_status VARCHAR(32) NULL AFTER drm_asset_id,
  ADD COLUMN drm_last_synced_at DATETIME NULL AFTER drm_status,
  ADD UNIQUE KEY uq_videos_drm_asset (drm_asset_id),
  ADD INDEX idx_videos_delivery_provider (delivery_provider, status);
