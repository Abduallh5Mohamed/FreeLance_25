#!/bin/bash

# Get all tables
echo "=== Tables in database ==="
MYSQL_PWD='NewSecureP@ssw0rd2025!' mysql -u root freelance -e "SHOW TABLES;"
