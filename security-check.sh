#!/bin/bash

echo "=========================================="
echo "Security Status Check"
echo "=========================================="

echo ""
echo "=== Firewall Status ==="
ufw status

echo ""
echo "=== Fail2Ban Status ==="
fail2ban-client status

echo ""
echo "=== SSH Banned IPs ==="
fail2ban-client status sshd 2>/dev/null | grep -A 20 "Banned"

echo ""
echo "=== Listening Ports ==="
ss -tlnp | grep LISTEN

echo ""
echo "=== Nginx Status ==="
systemctl status nginx --no-pager | head -10

echo ""
echo "=== Backend Status ==="
pm2 status

echo ""
echo "=== Database Users Count ==="
MYSQL_PWD='NewSecureP@ssw0rd2025!' mysql -u root freelance -e "SELECT COUNT(*) as total_users FROM users; SELECT role, COUNT(*) as count FROM users GROUP BY role;"

echo ""
echo "=== SSL Certificate ==="
certbot certificates 2>/dev/null | head -15

echo ""
echo "=========================================="
echo "Security check complete!"
echo "=========================================="
