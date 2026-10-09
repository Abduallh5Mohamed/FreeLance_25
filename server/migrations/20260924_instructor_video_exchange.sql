-- Instructor-to-instructor video exchange, offers, commission and publishing.
-- Run once after instructor-system-v2.sql.

ALTER TABLE lectures
  ADD COLUMN price DECIMAL(12,2) NULL AFTER duration_minutes,
  ADD COLUMN archived_at DATETIME NULL AFTER is_published;

ALTER TABLE videos
  ADD COLUMN preview_key VARCHAR(500) NULL AFTER thumbnail_key,
  ADD COLUMN preview_duration_seconds INT NULL AFTER preview_key,
  ADD COLUMN preview_status ENUM('pending','ready','failed') NOT NULL DEFAULT 'pending' AFTER preview_duration_seconds;

ALTER TABLE instructor_video_requests
  MODIFY lecture_id CHAR(36) NULL,
  ADD COLUMN requested_title VARCHAR(255) NULL AFTER owner_id,
  ADD COLUMN requested_grade VARCHAR(255) NULL AFTER requested_title,
  ADD COLUMN requested_group VARCHAR(255) NULL AFTER requested_grade,
  ADD COLUMN expires_at DATETIME NULL AFTER owner_response,
  ADD COLUMN completed_at DATETIME NULL AFTER expires_at,
  ADD COLUMN cancelled_at DATETIME NULL AFTER completed_at,
  ADD COLUMN cancelled_by CHAR(36) NULL AFTER cancelled_at,
  ADD COLUMN cancellation_reason VARCHAR(1000) NULL AFTER cancelled_by;

ALTER TABLE instructor_video_requests
  MODIFY status ENUM(
    'pending','approved_free','approved_paid','rejected',
    'open','awaiting_requester','completed','cancelled_by_requester',
    'cancelled_by_owner','expired','failed_insufficient_balance'
  ) NOT NULL DEFAULT 'open';

UPDATE instructor_video_requests r
LEFT JOIN lectures l ON l.id=r.lecture_id
SET r.requested_title=COALESCE(r.requested_title,l.title,'Legacy video request'),
    r.requested_grade=COALESCE(r.requested_grade,'Legacy'),
    r.requested_group=COALESCE(r.requested_group,'Legacy'),
    r.expires_at=COALESCE(r.expires_at,DATE_ADD(r.created_at,INTERVAL 48 HOUR)),
    r.status=CASE
      WHEN r.status='pending' THEN 'open'
      WHEN r.status IN ('approved_free','approved_paid') THEN 'completed'
      WHEN r.status='rejected' THEN 'cancelled_by_owner'
      ELSE r.status END;

ALTER TABLE instructor_video_requests
  MODIFY requested_title VARCHAR(255) NOT NULL,
  MODIFY requested_grade VARCHAR(255) NOT NULL,
  MODIFY requested_group VARCHAR(255) NOT NULL,
  MODIFY expires_at DATETIME NOT NULL,
  MODIFY status ENUM(
    'open','awaiting_requester','completed','cancelled_by_requester',
    'cancelled_by_owner','expired','failed_insufficient_balance'
  ) NOT NULL DEFAULT 'open',
  ADD INDEX idx_video_requests_requester (requester_id,status,created_at),
  ADD INDEX idx_video_requests_owner (owner_id,status,created_at),
  ADD INDEX idx_video_requests_expiry (status,expires_at);

CREATE TABLE IF NOT EXISTS instructor_video_offers (
  id CHAR(36) PRIMARY KEY,
  request_id INT NOT NULL,
  lecture_id CHAR(36) NOT NULL,
  video_id VARCHAR(36) NOT NULL,
  title_snapshot VARCHAR(255) NOT NULL,
  price_snapshot DECIMAL(12,2) NOT NULL,
  status ENUM('proposed','rejected','accepted','superseded') NOT NULL DEFAULT 'proposed',
  rejection_reason VARCHAR(1000) NULL,
  proposed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at DATETIME NULL,
  FOREIGN KEY (request_id) REFERENCES instructor_video_requests(id) ON DELETE CASCADE,
  FOREIGN KEY (lecture_id) REFERENCES lectures(id),
  FOREIGN KEY (video_id) REFERENCES videos(id),
  INDEX idx_video_offers_request (request_id,status,proposed_at),
  CHECK (price_snapshot > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS video_purchase_transactions (
  id CHAR(36) PRIMARY KEY,
  request_id INT NOT NULL UNIQUE,
  offer_id CHAR(36) NOT NULL UNIQUE,
  buyer_id CHAR(36) NOT NULL,
  seller_id CHAR(36) NOT NULL,
  lecture_id CHAR(36) NOT NULL,
  gross_amount DECIMAL(12,2) NOT NULL,
  commission_percent DECIMAL(5,2) NOT NULL,
  commission_amount DECIMAL(12,2) NOT NULL,
  seller_net_amount DECIMAL(12,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'EGP',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (request_id) REFERENCES instructor_video_requests(id),
  FOREIGN KEY (offer_id) REFERENCES instructor_video_offers(id),
  FOREIGN KEY (buyer_id) REFERENCES users(id),
  FOREIGN KEY (seller_id) REFERENCES users(id),
  FOREIGN KEY (lecture_id) REFERENCES lectures(id),
  INDEX idx_video_purchase_buyer (buyer_id,created_at),
  INDEX idx_video_purchase_seller (seller_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_video_revenue (
  id CHAR(36) PRIMARY KEY,
  purchase_id CHAR(36) NOT NULL UNIQUE,
  amount DECIMAL(12,2) NOT NULL,
  recognized_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (purchase_id) REFERENCES video_purchase_transactions(id),
  INDEX idx_platform_video_revenue_date (recognized_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE instructor_shared_lectures
  ADD COLUMN purchase_id CHAR(36) NULL AFTER request_id,
  ADD COLUMN is_published BOOLEAN NOT NULL DEFAULT FALSE AFTER obtained_at,
  ADD CONSTRAINT fk_shared_purchase FOREIGN KEY (purchase_id) REFERENCES video_purchase_transactions(id);

CREATE TABLE IF NOT EXISTS instructor_shared_lecture_publications (
  id CHAR(36) PRIMARY KEY,
  shared_lecture_id INT NOT NULL,
  grade_id CHAR(36) NOT NULL,
  group_id CHAR(36) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (shared_lecture_id) REFERENCES instructor_shared_lectures(id) ON DELETE CASCADE,
  FOREIGN KEY (grade_id) REFERENCES grades(id),
  FOREIGN KEY (group_id) REFERENCES `groups`(id),
  UNIQUE KEY uq_shared_group (shared_lecture_id,group_id),
  INDEX idx_shared_publication_group (group_id,shared_lecture_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_settings (
  setting_key VARCHAR(100) PRIMARY KEY,
  setting_value VARCHAR(255) NOT NULL,
  updated_by CHAR(36) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (updated_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO platform_settings(setting_key,setting_value)
VALUES ('video_commission_percent','2.00');

ALTER TABLE instructor_wallet_transactions
  ADD COLUMN transaction_group_id CHAR(36) NULL AFTER reference_id,
  ADD COLUMN category VARCHAR(50) NULL AFTER transaction_group_id,
  ADD INDEX idx_wallet_transaction_group (transaction_group_id);

INSERT IGNORE INTO admin_role_permissions(role_code,permission_key)
VALUES ('super_admin','video_commission.manage'),('billing_admin','video_commission.manage');
