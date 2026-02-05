#!/bin/bash

# ============================================
# ADVANCED SECURITY HARDENING SCRIPT
# ============================================

echo "=========================================="
echo "Starting Advanced Security Hardening..."
echo "=========================================="

# 1. Kernel security settings
echo "[1/8] Applying kernel security settings..."
cat > /etc/sysctl.d/99-security.conf << 'SYSCTL'
# IP Spoofing protection
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1

# Ignore ICMP broadcast requests
net.ipv4.icmp_echo_ignore_broadcasts = 1

# Disable source packet routing
net.ipv4.conf.all.accept_source_route = 0
net.ipv6.conf.all.accept_source_route = 0

# Block SYN attacks
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_syn_backlog = 2048
net.ipv4.tcp_synack_retries = 2

# Log Martians
net.ipv4.conf.all.log_martians = 1

# Ignore ICMP redirects
net.ipv4.conf.all.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0

# Disable IPv6
net.ipv6.conf.all.disable_ipv6 = 1
net.ipv6.conf.default.disable_ipv6 = 1

# Restrict core dumps
fs.suid_dumpable = 0
SYSCTL
sysctl -p /etc/sysctl.d/99-security.conf 2>/dev/null

# 2. Harden SSH
echo "[2/8] Hardening SSH configuration..."
cat > /etc/ssh/sshd_config.d/hardening.conf << 'SSHD'
MaxAuthTries 3
MaxSessions 2
ClientAliveInterval 300
ClientAliveCountMax 2
LoginGraceTime 30
PermitEmptyPasswords no
X11Forwarding no
AllowTcpForwarding no
Ciphers aes256-gcm@openssh.com,chacha20-poly1305@openssh.com,aes256-ctr
MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com
SSHD
systemctl restart ssh

# 3. Secure file permissions
echo "[3/8] Securing critical file permissions..."
chmod 700 /root
chmod 600 /etc/ssh/sshd_config
chmod 600 /root/backend/.env
chown -R root:root /var/www/alqaed
chmod -R 755 /var/www/alqaed
find /var/www/alqaed -type f -exec chmod 644 {} \;

# 4. Enhanced Fail2Ban
echo "[4/8] Enhancing Fail2Ban..."
cat > /etc/fail2ban/jail.local << 'FAIL2BAN'
[DEFAULT]
bantime = 86400
findtime = 600
maxretry = 3
banaction = ufw
backend = systemd

[sshd]
enabled = true
port = ssh
maxretry = 2
bantime = 604800

[nginx-http-auth]
enabled = true
filter = nginx-http-auth
port = http,https
logpath = /var/log/nginx/error.log
maxretry = 3
bantime = 86400

[nginx-botsearch]
enabled = true
filter = nginx-botsearch
port = http,https
logpath = /var/log/nginx/access.log
maxretry = 2
bantime = 604800

[nginx-req-limit]
enabled = true
filter = nginx-limit-req
port = http,https
logpath = /var/log/nginx/error.log
maxretry = 5
bantime = 86400
FAIL2BAN
systemctl restart fail2ban

# 5. Block malicious IP ranges
echo "[5/8] Blocking known malicious IP ranges..."
ufw deny from 185.220.0.0/16 2>/dev/null
ufw deny from 45.148.0.0/16 2>/dev/null
ufw deny from 89.248.0.0/16 2>/dev/null
ufw deny from 193.142.0.0/16 2>/dev/null
ufw deny from 194.26.0.0/16 2>/dev/null

# 6. Secure MySQL
echo "[6/8] Securing MySQL..."
MYSQL_PWD='NewSecureP@ssw0rd2025!' mysql -u root << 'MYSQLSEC'
DELETE FROM mysql.user WHERE User='';
DELETE FROM mysql.user WHERE User='root' AND Host NOT IN ('localhost', '127.0.0.1', '::1');
DROP DATABASE IF EXISTS test;
DELETE FROM mysql.db WHERE Db='test' OR Db='test\\_%';
FLUSH PRIVILEGES;
MYSQLSEC

# 7. Nginx extra security
echo "[7/8] Adding extra nginx security..."
cat > /etc/nginx/conf.d/security.conf << 'NGINXSEC'
# Hide nginx version
server_tokens off;

# Prevent clickjacking
add_header X-Frame-Options "SAMEORIGIN" always;

# XSS Protection
add_header X-XSS-Protection "1; mode=block" always;

# Prevent MIME type sniffing
add_header X-Content-Type-Options "nosniff" always;

# CSP
add_header Content-Security-Policy "default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval';" always;

# Limit request body size
client_max_body_size 100M;

# Limit connections per IP
limit_conn_zone $binary_remote_addr zone=addr:10m;
limit_conn addr 100;
NGINXSEC
nginx -t && systemctl reload nginx

# 8. Setup log rotation
echo "[8/8] Configuring log rotation..."
cat > /etc/logrotate.d/nginx-custom << 'LOGROTATE'
/var/log/nginx/*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640 www-data adm
    sharedscripts
    postrotate
        [ -f /var/run/nginx.pid ] && kill -USR1 $(cat /var/run/nginx.pid)
    endscript
}
LOGROTATE

echo "=========================================="
echo "Security hardening complete!"
echo "=========================================="
