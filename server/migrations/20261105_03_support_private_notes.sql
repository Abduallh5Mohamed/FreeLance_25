-- Additive file only; no migration application is authorized by its presence.
-- Private notes are never stored in the requester-visible reply table.
CREATE TABLE IF NOT EXISTS support_ticket_private_notes (
  id CHAR(36) PRIMARY KEY,
  ticket_id CHAR(36) NOT NULL,
  author_user_id CHAR(36) NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_support_private_note_ticket FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE,
  CONSTRAINT fk_support_private_note_author FOREIGN KEY (author_user_id) REFERENCES users(id),
  INDEX idx_support_private_notes_page (ticket_id,created_at,id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
