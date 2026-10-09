-- Allows the server to invalidate every previously issued student JWT after
-- a confirmed capture attempt. Existing tokens remain valid at version zero.
ALTER TABLE users
  ADD COLUMN token_version INT NOT NULL DEFAULT 0;
