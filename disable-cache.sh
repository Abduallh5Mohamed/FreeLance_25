#!/bin/bash
cat > /var/www/alqaed/.htaccess << 'EOF'
# Disable caching for JS/CSS/HTML
<FilesMatch "\.(html|js|css)$">
  Header set Cache-Control "no-cache, no-store, must-revalidate"
  Header set Pragma "no-cache"
  Header set Expires 0
</FilesMatch>
EOF

echo "Cache disabled!"
cat /var/www/alqaed/.htaccess
