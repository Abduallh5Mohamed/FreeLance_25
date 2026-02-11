#!/bin/bash
mysql -u root -p'NewSecureP@ssw0rd2025!' freelance 2>/dev/null -e "SELECT name, schedule_days, schedule_time, is_active FROM \`groups\` ORDER BY name;"
