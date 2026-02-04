#!/bin/bash
# Remove the first broken line
sed -i '1d' /root/backend/services/minio.js
# Add the correct line at the beginning
echo 'require("dotenv").config();' > /tmp/dotenv_line.txt
cat /root/backend/services/minio.js >> /tmp/dotenv_line.txt
mv /tmp/dotenv_line.txt /root/backend/services/minio.js
# Verify
head -3 /root/backend/services/minio.js
