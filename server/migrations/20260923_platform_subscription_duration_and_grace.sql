-- Platform subscriptions: support composite month/day durations.
ALTER TABLE platform_plans
  ADD COLUMN duration_days SMALLINT NOT NULL DEFAULT 0 AFTER duration_months;

-- The foundation schema required duration_months > 0. Replace that generated
-- check so plans expressed only in days are valid as well.
ALTER TABLE platform_plans
  DROP CHECK platform_plans_chk_1;

ALTER TABLE platform_plans
  ADD CONSTRAINT chk_platform_plan_duration CHECK (duration_months > 0 OR duration_days > 0);
