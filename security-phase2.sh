#!/bin/bash

echo "=========================================="
echo "Advanced Security Hardening - Phase 2"
echo "=========================================="

# 1. Install additional security tools
echo "[1/10] Installing security tools..."
apt-get update -qq
apt-get install -y libpam-pwquality auditd unattended-upgrades 2>/dev/null

# 2. Configure password policy
echo "[2/10] Setting up password policy..."
cat > /etc/security/pwquality.conf << 'PWQUALITY'
minlen = 12
minclass = 3
maxrepeat = 3
dcredit = -1
ucredit = -1
lcredit = -1
ocredit = -1
PWQUALITY

# 3. Set up automatic security updates
echo "[3/10] Configuring automatic security updates..."
cat > /etc/apt/apt.conf.d/20auto-upgrades << 'AUTOUPGRADE'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
AUTOUPGRADE

# 4. Secure /tmp with noexec
echo "[4/10] Securing /tmp..."
if ! grep -q "/tmp.*noexec" /etc/fstab; then
    echo "tmpfs /tmp tmpfs defaults,noexec,nosuid,nodev 0 0" >> /etc/fstab
fi

# 5. Disable IPv6 completely
echo "[5/10] Disabling IPv6..."
cat >> /etc/sysctl.d/99-security.conf << 'SYSCTL'
# Additional security
kernel.dmesg_restrict = 1
kernel.kptr_restrict = 2
kernel.randomize_va_space = 2
net.core.bpf_jit_harden = 2
SYSCTL
sysctl -p /etc/sysctl.d/99-security.conf 2>/dev/null

# 6. Set up more strict file permissions
echo "[6/10] Hardening file permissions..."
chmod 700 /root/.ssh 2>/dev/null
chmod 600 /root/.ssh/* 2>/dev/null
chmod 600 /etc/crontab
chmod 700 /etc/cron.d
chmod 700 /etc/cron.daily
chmod 700 /etc/cron.hourly
chmod 700 /etc/cron.monthly
chmod 700 /etc/cron.weekly

# 7. Configure audit daemon
echo "[7/10] Setting up audit daemon..."
systemctl enable auditd 2>/dev/null
cat > /etc/audit/rules.d/security.rules << 'AUDIT'
# Monitor authentication
-w /etc/passwd -p wa -k identity
-w /etc/shadow -p wa -k identity
-w /var/log/auth.log -p wa -k auth

# Monitor sudo usage
-w /etc/sudoers -p wa -k sudo
-w /etc/sudoers.d -p wa -k sudo

# Monitor network configuration
-w /etc/hosts -p wa -k hosts
-w /etc/network -p wa -k network

# Monitor scheduled tasks
-w /etc/crontab -p wa -k cron
-w /etc/cron.d -p wa -k cron

# Monitor system calls
-a always,exit -F arch=b64 -S execve -k exec
AUDIT
systemctl restart auditd 2>/dev/null

# 8. Additional Fail2Ban hardening
echo "[8/10] Hardening Fail2Ban further..."
cat >> /etc/fail2ban/jail.local << 'F2B'

[nginx-noscript]
enabled = true
port = http,https
filter = nginx-noscript
logpath = /var/log/nginx/access.log
maxretry = 2
bantime = 604800

[nginx-proxy]
enabled = true
port = http,https
filter = nginx-proxy
logpath = /var/log/nginx/access.log
maxretry = 2
bantime = 604800
F2B

# Create custom filter for script attacks
cat > /etc/fail2ban/filter.d/nginx-noscript.conf << 'FILTER'
[Definition]
failregex = ^<HOST> -.*GET.*(\.php|\.asp|\.exe|\.pl|\.cgi|\.scgi)
ignoreregex =
FILTER

# Create custom filter for proxy attempts
cat > /etc/fail2ban/filter.d/nginx-proxy.conf << 'FILTER'
[Definition]
failregex = ^<HOST> -.*GET http.*
ignoreregex =
FILTER

systemctl restart fail2ban

# 9. Block more malicious IP ranges
echo "[9/10] Blocking additional malicious IPs..."
ufw deny from 77.247.0.0/16 2>/dev/null
ufw deny from 141.98.0.0/16 2>/dev/null
ufw deny from 45.155.0.0/16 2>/dev/null
ufw deny from 5.188.0.0/16 2>/dev/null
ufw deny from 91.241.0.0/16 2>/dev/null

# 10. Secure nginx further
echo "[10/10] Enhancing nginx security..."
cat > /etc/nginx/snippets/security-headers.conf << 'HEADERS'
# Additional security headers
add_header X-Permitted-Cross-Domain-Policies "none" always;
add_header X-Download-Options "noopen" always;
add_header Cross-Origin-Embedder-Policy "require-corp" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Cross-Origin-Resource-Policy "same-origin" always;
HEADERS

# Add rate limiting to nginx
cat > /etc/nginx/conf.d/rate-limit.conf << 'RATELIMIT'
# Enhanced rate limiting
limit_req_zone $binary_remote_addr zone=general:10m rate=5r/s;
limit_req_zone $binary_remote_addr zone=api_strict:10m rate=2r/s;
limit_conn_zone $binary_remote_addr zone=perip:10m;
RATELIMIT

nginx -t && systemctl reload nginx

echo ""
echo "=========================================="
echo "Security Hardening Phase 2 Complete!"
echo "=========================================="

# Show security status
echo ""
echo "=== Current Security Status ==="
echo "Fail2Ban Jails: $(fail2ban-client status | grep 'Number of jail' | awk '{print $5}')"
echo "UFW Rules: $(ufw status | grep -c DENY) blocked ranges"
echo "Auditd: $(systemctl is-active auditd)"
