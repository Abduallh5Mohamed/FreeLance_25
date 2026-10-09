-- Notification storage was referenced by legacy routes but absent in some installations.
CREATE TABLE IF NOT EXISTS notifications (
  id CHAR(36) PRIMARY KEY DEFAULT (UUID()),
  user_id VARCHAR(64) NOT NULL,
  user_type VARCHAR(30) NOT NULL,
  title VARCHAR(255) NOT NULL,
  message VARCHAR(1000) NOT NULL,
  type VARCHAR(60) NOT NULL DEFAULT 'general',
  link VARCHAR(500) NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_notification_recipient (user_id,user_type,is_read,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS billing_notification_events (
  id CHAR(36) PRIMARY KEY,
  subscription_id CHAR(36) NOT NULL,
  event_code VARCHAR(80) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (subscription_id) REFERENCES tenant_subscriptions(id),
  UNIQUE KEY uq_billing_notification_event (subscription_id,event_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
