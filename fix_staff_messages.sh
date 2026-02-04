#!/bin/bash

# Fix staff messages to use same query as teacher
cd /root/backend/routes

# Create backup
cp messages.js messages.js.bak

# Replace the staff query to use same as teacher (students from users table)
sed -i "s/else if (userRole === 'staff') {/else if (userRole === 'staff') {\n            \/\/ Staff uses same query as teacher - students from users table\n            query = \`\n                SELECT\n                    u.id,\n                    u.name,\n                    u.role,\n                    uos.is_online,\n                    uos.last_seen\n                FROM users u\n                LEFT JOIN user_online_status uos ON u.id = uos.user_id\n                WHERE u.role = 'student' AND u.id != ?\n                ORDER BY uos.is_online DESC, u.name ASC\n            \`;\n        }\n        else if (userRole === 'staff_disabled') {/" messages.js

# Restart PM2
pm2 restart alqaed-api

echo "Staff messages fix applied!"
