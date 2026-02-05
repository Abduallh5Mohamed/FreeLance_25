#!/bin/bash

# Block direct access to backend port (should only be accessed via nginx)
ufw deny 3001

# Also block MinIO console direct access
ufw deny 9001

echo "Blocked direct access to backend (3001) and MinIO console (9001)"
echo ""
ufw status
