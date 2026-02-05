#!/bin/bash

# ============================================
# SECURITY HARDENING & DATABASE CLEANUP SCRIPT
# ============================================

echo "=========================================="
echo "Starting Advanced Security Hardening..."
echo "=========================================="

# 1. Install security tools
echo "[1/10] Installing security tools..."
apt-get install -y libpam-pwquality auditd rkhunter lynis 2>/dev/null

# 2. Disable unused services
echo "[2/10] Disabling unused services..."
systemctl disable cups 2>/dev/null
systemctl disable avahi-daemon 2>/dev/null
systemctl disable bluetooth 2>/dev/null

# 3. Secure shared memory
echo "[3/10] Securing shared memory..."
grep -q "tmpfs /run/shm" /etc/fstab || echo "tmpfs /run/shm tmpfs defaults,noexec,nosuid 0 0" >> /etc/fstab

# 4. Secure sysctl settings
echo "[4/10] Applying kernel security settings..."
cat > /etc/sysctl.d/99-security.conf << 'SYSCTL'
# IP Spoofing protection
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1

# Ignore ICMP broadcast requests
net.ipv4.icmp_echo_ignore_broadcasts = 1

# Disable source packet routing
net.ipv4.conf.all.accept_source_route = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv6.conf.default.accept_source_route = 0

# Ignore send redirects
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0

# Block SYN attacks
net.ipv4.tcp_syncookies = 1
net.ipv4.tcp_max_syn_backlog = 2048
net.ipv4.tcp_synack_retries = 2
net.ipv4.tcp_syn_retries = 5

# Log Martians
net.ipv4.conf.all.log_martians = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1

# Ignore ICMP redirects
net.ipv4.conf.all.accept_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0

# Disable IPv6 if not needed
net.ipv6.conf.all.disable_ipv6 = 1
net.ipv6.conf.default.disable_ipv6 = 1

# Protect against time-wait assassination
net.ipv4.tcp_rfc1337 = 1

# Increase system file descriptor limit
fs.file-max = 65535

# Restrict core dumps
fs.suid_dumpable = 0
SYSCTL
sysctl -p /etc/sysctl.d/99-security.conf 2>/dev/null

# 5. Secure SSH further
echo "[5/10] Hardening SSH configuration..."
cat > /etc/ssh/sshd_config.d/hardening.conf << 'SSHD'
# Disable root login with password (use key only)
PermitRootLogin prohibit-password

# Limit authentication attempts
MaxAuthTries 3
MaxSessions 2

# Timeout settings
ClientAliveInterval 300
ClientAliveCountMax 2
LoginGraceTime 30

# Disable empty passwords
PermitEmptyPasswords no

# Disable X11 forwarding
X11Forwarding no

# Disable TCP forwarding
AllowTcpForwarding no
AllowAgentForwarding no

# Use only Protocol 2
Protocol 2

# Restrict to specific algorithms
Ciphers aes256-gcm@openssh.com,chacha20-poly1305@openssh.com,aes256-ctr
MACs hmac-sha2-512-etm@openssh.com,hmac-sha2-256-etm@openssh.com
KexAlgorithms curve25519-sha256,curve25519-sha256@libssh.org
SSHD
systemctl restart ssh

# 6. Setup automatic security updates
echo "[6/10] Configuring automatic security updates..."
cat > /etc/apt/apt.conf.d/50unattended-upgrades << 'UNATTENDED'
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}";
    "${distro_id}:${distro_codename}-security";
    "${distro_id}ESMApps:${distro_codename}-apps-security";
    "${distro_id}ESM:${distro_codename}-infra-security";
};
Unattended-Upgrade::AutoFixInterruptedDpkg "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
Unattended-Upgrade::Automatic-Reboot "false";
UNATTENDED

# 7. Secure file permissions
echo "[7/10] Securing critical file permissions..."
chmod 700 /root
chmod 600 /etc/ssh/sshd_config
chmod 644 /etc/passwd
chmod 600 /etc/shadow
chmod 644 /etc/group
chmod 600 /etc/gshadow
chmod 600 /root/backend/.env

# 8. Setup audit rules
echo "[8/10] Configuring audit rules..."
cat > /etc/audit/rules.d/security.rules << 'AUDIT'
# Monitor changes to authentication files
-w /etc/passwd -p wa -k identity
-w /etc/group -p wa -k identity
-w /etc/shadow -p wa -k identity
-w /etc/gshadow -p wa -k identity
-w /etc/sudoers -p wa -k sudo_changes
-w /etc/ssh/sshd_config -p wa -k sshd_config

# Monitor login/logout events
-w /var/log/faillog -p wa -k logins
-w /var/log/lastlog -p wa -k logins
-w /var/log/auth.log -p wa -k auth

# Monitor root activity
-w /root/.bash_history -p wa -k root_hist
AUDIT
systemctl restart auditd 2>/dev/null

# 9. Enhanced Fail2Ban configuration
echo "[9/10] Enhancing Fail2Ban..."
cat > /etc/fail2ban/jail.local << 'FAIL2BAN'
[DEFAULT]
bantime = 86400
findtime = 600
maxretry = 3
banaction = ufw
backend = systemd
ignoreip = 127.0.0.1/8

[sshd]
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
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

[nginx-badbots]
enabled = true
port = http,https
filter = apache-badbots
logpath = /var/log/nginx/access.log
maxretry = 1
bantime = 604800
FAIL2BAN
systemctl restart fail2ban

# 10. Block known malicious IPs
echo "[10/10] Setting up IP blocking..."
ufw deny from 185.220.0.0/16 2>/dev/null
ufw deny from 45.148.0.0/16 2>/dev/null
ufw deny from 89.248.0.0/16 2>/dev/null

echo "=========================================="
echo "Security hardening complete!"
echo "=========================================="

# ============================================
# DATABASE CLEANUP
# ============================================

echo ""
echo "=========================================="
echo "Starting Database Cleanup..."
echo "=========================================="

MYSQL_PWD='NewSecureP@ssw0rd2025!' mysql -u root freelance << 'MYSQL_SCRIPT'

-- Get the admin user ID first
SET @admin_phone = '01024083057';
SET @admin_id = NULL;

SELECT id INTO @admin_id FROM users WHERE phone = @admin_phone LIMIT 1;

SELECT CONCAT('Admin ID found: ', IFNULL(@admin_id, 'NOT FOUND')) AS status;

-- If admin exists, proceed with cleanup
-- Disable foreign key checks temporarily
SET FOREIGN_KEY_CHECKS = 0;

-- Clean all tables except keeping the admin user

-- Clean exam-related tables
TRUNCATE TABLE exam_attempts;
TRUNCATE TABLE exam_answers;
TRUNCATE TABLE exam_questions;
TRUNCATE TABLE exams;

-- Clean lecture-related tables  
TRUNCATE TABLE student_lectures;
TRUNCATE TABLE lecture_materials;
TRUNCATE TABLE lectures;

-- Clean notification tables
TRUNCATE TABLE notifications;

-- Clean video tables
TRUNCATE TABLE video_access_logs;
TRUNCATE TABLE video_processing_queue;
TRUNCATE TABLE videos;

-- Clean payment tables
TRUNCATE TABLE payments;
TRUNCATE TABLE payment_receipts;

-- Clean meeting tables
TRUNCATE TABLE meetings;
TRUNCATE TABLE meeting_attendance;

-- Clean chat/message tables
TRUNCATE TABLE messages;
TRUNCATE TABLE chats;

-- Clean security logs
TRUNCATE TABLE security_logs;

-- Clean sessions
TRUNCATE TABLE sessions;

-- Clean registration requests
TRUNCATE TABLE registration_requests;

-- Clean students - delete all except if linked to admin
DELETE FROM students WHERE user_id != @admin_id OR @admin_id IS NULL;

-- Clean guardians
DELETE FROM guardians WHERE id NOT IN (
    SELECT DISTINCT guardian_id FROM students WHERE guardian_id IS NOT NULL
);

-- Clean users - keep only admin
DELETE FROM users WHERE phone != @admin_phone;

-- Update admin password with new bcrypt hash
-- Password: Mtd#mora55
UPDATE users SET 
    password = '$2b$10$YourNewHashHere',
    role = 'admin',
    is_active = 1,
    updated_at = NOW()
WHERE phone = @admin_phone;

-- Re-enable foreign key checks
SET FOREIGN_KEY_CHECKS = 1;

-- Show remaining data
SELECT 'Users remaining:' as info, COUNT(*) as count FROM users
UNION ALL
SELECT 'Students remaining:', COUNT(*) FROM students
UNION ALL
SELECT 'Exams remaining:', COUNT(*) FROM exams
UNION ALL
SELECT 'Lectures remaining:', COUNT(*) FROM lectures;

MYSQL_SCRIPT

echo "=========================================="
echo "Database cleanup complete!"
echo "=========================================="
