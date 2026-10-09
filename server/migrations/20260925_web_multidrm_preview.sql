-- A separately packaged DRM asset for the first ten minutes used in offers.
ALTER TABLE videos
  ADD COLUMN drm_preview_asset_id VARCHAR(80) NULL AFTER drm_asset_id,
  ADD UNIQUE KEY uq_videos_drm_preview_asset (drm_preview_asset_id);
