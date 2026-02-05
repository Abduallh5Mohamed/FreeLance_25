#!/bin/bash
echo "Updating admin password..."
MYSQL_PWD='NewSecureP@ssw0rd2025!' mysql -u root freelance -e "UPDATE users SET password_hash = '\$2b\$10\$d49pUjJJ9Pxb37R/Z832m.Loy2U6WHJCOEu7DR5ZfF1UuQFItjPHe', role = 'admin', is_active = 1, updated_at = NOW() WHERE phone = '01024083057';"
echo "Done! Showing admin info:"
MYSQL_PWD='NewSecureP@ssw0rd2025!' mysql -u root freelance -e "SELECT id, phone, name, role, is_active, password_hash FROM users WHERE phone = '01024083057';"
