-- Support tickets are intentionally introduced through a versioned migration.
-- Apply only after taking a database backup. This migration is additive.

CREATE TABLE IF NOT EXISTS support_tickets (
  id CHAR(36) PRIMARY KEY,
  ticket_number VARCHAR(32) NOT NULL UNIQUE,
  user_id CHAR(36) NOT NULL,
  category ENUM('technical', 'account', 'billing', 'content', 'exam', 'video', 'other') NOT NULL,
  subject VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  status ENUM('open', 'waiting_on_support', 'waiting_on_user', 'resolved', 'closed') NOT NULL DEFAULT 'open',
  priority ENUM('low', 'normal', 'high', 'urgent') NOT NULL DEFAULT 'normal',
  assigned_to CHAR(36) NULL,
  resolved_at TIMESTAMP NULL,
  closed_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_support_ticket_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_support_ticket_assignee FOREIGN KEY (assigned_to) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_support_user_updated (user_id, updated_at),
  INDEX idx_support_status_updated (status, updated_at),
  INDEX idx_support_assignee_status (assigned_to, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS support_ticket_replies (
  id CHAR(36) PRIMARY KEY,
  ticket_id CHAR(36) NOT NULL,
  sender_id CHAR(36) NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_support_reply_ticket FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE,
  CONSTRAINT fk_support_reply_sender FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_support_reply_ticket_created (ticket_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

