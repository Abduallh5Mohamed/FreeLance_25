-- Instructor self-service top-ups and one-shot subscription renewal intents.
-- Apply after the SaaS foundation and platform duration migrations.

ALTER TABLE instructor_wallets
  MODIFY COLUMN balance DECIMAL(12,2) NOT NULL DEFAULT 0.00;

ALTER TABLE instructor_wallet_transactions
  MODIFY COLUMN amount DECIMAL(12,2) NOT NULL,
  MODIFY COLUMN balance_after DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  ADD COLUMN reference_type VARCHAR(60) NULL AFTER reference_id,
  ADD COLUMN reference_uuid CHAR(36) NULL AFTER reference_type,
  ADD UNIQUE KEY uq_wallet_reference (instructor_id,type,reference_type,reference_uuid);

ALTER TABLE tenant_subscriptions
  MODIFY COLUMN status ENUM('pending','active','past_due','grace_period','expired','cancelled','completed') NOT NULL DEFAULT 'pending';

CREATE TABLE instructor_topup_requests (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  instructor_id CHAR(36) NOT NULL,
  purpose_code VARCHAR(60) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'EGP',
  method VARCHAR(40) NOT NULL,
  reference_number VARCHAR(160) NOT NULL,
  paid_at DATETIME NOT NULL,
  proof_object_key VARCHAR(500) NOT NULL,
  proof_sha256 CHAR(64) NOT NULL,
  proof_content_type VARCHAR(100) NOT NULL,
  notes VARCHAR(1000) NULL,
  status ENUM('submitted','verified','rejected','cancelled') NOT NULL DEFAULT 'submitted',
  idempotency_key VARCHAR(120) NOT NULL,
  reviewed_by CHAR(36) NULL,
  reviewed_at DATETIME NULL,
  rejection_reason VARCHAR(500) NULL,
  credited_transaction_id INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (instructor_id) REFERENCES users(id),
  FOREIGN KEY (reviewed_by) REFERENCES users(id),
  FOREIGN KEY (credited_transaction_id) REFERENCES instructor_wallet_transactions(id),
  UNIQUE KEY uq_topup_idempotency (instructor_id,idempotency_key),
  UNIQUE KEY uq_topup_reference (method,reference_number),
  UNIQUE KEY uq_topup_proof_hash (proof_sha256),
  INDEX idx_topup_queue (status,created_at),
  INDEX idx_topup_tenant (tenant_id,created_at),
  CHECK (amount > 0),
  CHECK (purpose_code IN ('subscription_renewal','other'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tenant_renewal_intents (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  instructor_id CHAR(36) NOT NULL,
  source_subscription_id CHAR(36) NOT NULL,
  source_topup_id CHAR(36) NULL,
  target_plan_id CHAR(36) NOT NULL,
  trigger_type ENUM('topup','manual') NOT NULL,
  charge_amount DECIMAL(12,2) NOT NULL,
  paid_at DATETIME NULL,
  status ENUM('pending','executed','cancelled') NOT NULL DEFAULT 'pending',
  executed_subscription_id CHAR(36) NULL,
  executed_at DATETIME NULL,
  cancelled_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  pending_tenant_id CHAR(36) GENERATED ALWAYS AS (CASE WHEN status='pending' THEN tenant_id ELSE NULL END) STORED,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (instructor_id) REFERENCES users(id),
  FOREIGN KEY (source_subscription_id) REFERENCES tenant_subscriptions(id),
  FOREIGN KEY (source_topup_id) REFERENCES instructor_topup_requests(id),
  FOREIGN KEY (target_plan_id) REFERENCES platform_plans(id),
  UNIQUE KEY uq_pending_renewal_intent (pending_tenant_id),
  INDEX idx_renewal_intent_due (status,tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE tenant_subscriptions
  ADD COLUMN renewed_from_subscription_id CHAR(36) NULL AFTER approved_by,
  ADD COLUMN renewal_intent_id CHAR(36) NULL AFTER renewed_from_subscription_id,
  ADD CONSTRAINT fk_subscription_renewed_from FOREIGN KEY (renewed_from_subscription_id) REFERENCES tenant_subscriptions(id),
  ADD CONSTRAINT fk_subscription_renewal_intent FOREIGN KEY (renewal_intent_id) REFERENCES tenant_renewal_intents(id),
  ADD UNIQUE KEY uq_subscription_renewal_intent (renewal_intent_id);

ALTER TABLE tenant_renewal_intents
  ADD CONSTRAINT fk_intent_executed_subscription FOREIGN KEY (executed_subscription_id) REFERENCES tenant_subscriptions(id);

CREATE TABLE platform_revenue_events (
  id CHAR(36) PRIMARY KEY,
  tenant_id CHAR(36) NOT NULL,
  subscription_id CHAR(36) NOT NULL,
  wallet_transaction_id INT NOT NULL,
  event_type VARCHAR(60) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'EGP',
  recognized_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (subscription_id) REFERENCES tenant_subscriptions(id),
  FOREIGN KEY (wallet_transaction_id) REFERENCES instructor_wallet_transactions(id),
  UNIQUE KEY uq_revenue_subscription_event (subscription_id,event_type),
  INDEX idx_revenue_recognized (recognized_at,tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
