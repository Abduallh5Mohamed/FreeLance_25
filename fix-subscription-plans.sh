#!/bin/bash
echo "=== Fixing subscription_plans table ==="

MYSQL_PWD='NewSecureP@ssw0rd2025!' mysql -u root freelance << 'EOF'

-- Add UUID generation if not exists
ALTER TABLE subscription_plans MODIFY id CHAR(36) NOT NULL DEFAULT (UUID());

-- Add some default subscription plans
INSERT INTO subscription_plans (id, name, duration_months, price, description, is_active) VALUES
(UUID(), 'باقة شهرية', 1, 200, 'اشتراك لمدة شهر واحد', 1),
(UUID(), 'باقة ربع سنوية', 3, 550, 'اشتراك لمدة 3 أشهر بخصم 8%', 1),
(UUID(), 'باقة نصف سنوية', 6, 1000, 'اشتراك لمدة 6 أشهر بخصم 15%', 1),
(UUID(), 'باقة سنوية', 12, 1800, 'اشتراك لمدة سنة كاملة بخصم 25%', 1);

SELECT 'Subscription plans created successfully!' as status;
SELECT * FROM subscription_plans;
EOF
