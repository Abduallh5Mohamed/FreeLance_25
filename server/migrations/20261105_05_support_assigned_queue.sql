-- Additive file only; application requires separate operational authorization.
-- Stable self-assigned keyset browsing; no status/priority ordering claim.
CREATE INDEX idx_support_assignee_id ON support_tickets (assigned_to,id);
