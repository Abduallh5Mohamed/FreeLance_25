-- File only; never applied by the local implementation task.
-- Exact assignee/status range, oldest update first with a stable ID tie-break.
CREATE INDEX idx_support_followup ON support_tickets (assigned_to,status,updated_at,id);
