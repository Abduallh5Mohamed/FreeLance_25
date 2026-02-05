#!/bin/bash

echo "=== Security Headers Check ==="
curl -sI https://elka2d.cloud | head -25

echo ""
echo "=== Fail2Ban Status ==="
fail2ban-client status | head -10

echo ""
echo "=== UFW Status ==="
ufw status | head -20

echo ""
echo "=== Current Connections ==="
ss -s

echo ""
echo "=== System Load ==="
uptime

echo ""
echo "=== Memory Usage ==="
free -h
