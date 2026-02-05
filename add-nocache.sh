#!/bin/bash

# Backup nginx config
cp /etc/nginx/sites-available/alqaed /etc/nginx/sites-available/alqaed.backup

# Add no-cache headers before the last closing brace of HTTPS server block
sed -i '/location \/ {/,/}/ {
    /root \/var\/www\/alqaed/a\
\
    # No cache for JS/CSS/HTML\
    location ~* \\.(js|css|html)$ {\
        add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0";\
        add_header Pragma "no-cache";\
        add_header Expires "0";\
    }
}' /etc/nginx/sites-available/alqaed

# Test nginx config
nginx -t && systemctl reload nginx && echo "Done! No-cache headers added"
