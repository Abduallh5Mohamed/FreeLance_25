-- Additive file only. Do not apply without separate operational authorization.
ALTER TABLE support_tickets ADD COLUMN assignment_version INT UNSIGNED NOT NULL DEFAULT 0;

-- Immutable receipts survive later transfers; current assignment is not a receipt.
CREATE TABLE IF NOT EXISTS support_assignment_attempts (
  id CHAR(36) PRIMARY KEY,
  ticket_id CHAR(36) NOT NULL,
  actor_user_id CHAR(36) NOT NULL,
  assigned_to CHAR(36) NULL,
  expected_version INT UNSIGNED NOT NULL,
  result_version INT UNSIGNED NOT NULL,
  changed TINYINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_support_assignment_ticket FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE,
  CONSTRAINT fk_support_assignment_actor FOREIGN KEY (actor_user_id) REFERENCES users(id),
  CONSTRAINT chk_support_assignment_changed CHECK (changed IN (0,1)),
  CONSTRAINT chk_support_assignment_version CHECK (result_version = expected_version + changed)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
