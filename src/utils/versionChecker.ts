/**
 * Version Checker - Auto-reload when new build is deployed
 * Prevents users from seeing cached old builds
 */

const CHECK_INTERVAL = 60000; // Check every 60 seconds

let checkInterval: NodeJS.Timeout | null = null;
let currentVersion: string | null = null;

// Extract current version from loaded script tags
function getCurrentVersion(): string | null {
    const scripts = document.querySelectorAll('script[src]');
    for (const script of scripts) {
        const src = script.getAttribute('src');
        if (src) {
            const match = src.match(/index-(\d+)\.js/);
            if (match) {
                return match[1];
            }
        }
    }
    return null;
}

export function startVersionCheck() {
    // Force side-effect to prevent tree-shaking
    window.__APP_VERSION_CHECK_ENABLED__ = true;
    
    // Don't check in development
    if (import.meta.env.DEV) {
        console.log('🔧 Version check disabled in development mode');
        return;
    }

    // Get current version
    currentVersion = getCurrentVersion();
    if (!currentVersion) {
        console.debug('Could not determine current build version');
        return;
    }

    console.log('📋 Current build version:', currentVersion);

    // Check after 60 seconds (give user time to interact)
    setTimeout(() => {
        checkVersion();
        // Then check periodically
        checkInterval = setInterval(checkVersion, CHECK_INTERVAL);
    }, 60000);
}

export function stopVersionCheck() {
    if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
    }
}

async function checkVersion() {
    if (!currentVersion) return;

    try {
        // Fetch index.html with cache bypass
        const response = await fetch('/index.html?' + Date.now(), {
            cache: 'no-store',
            headers: {
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            }
        });

        const html = await response.text();
        
        // Extract server version from the HTML
        const scriptMatch = html.match(/index-(\d+)\.js/);
        
        if (scriptMatch) {
            const serverVersion = scriptMatch[1];
            
            // If versions don't match, force reload
            if (serverVersion !== currentVersion) {
                console.log(`🔄 New build detected!`);
                console.log(`   Current: ${currentVersion}`);
                console.log(`   Server: ${serverVersion}`);
                console.log('🔄 Reloading page to get latest version...');
                
                // Stop checking
                stopVersionCheck();
                
                // Clear cache
                if ('caches' in window) {
                    caches.keys().then(names => {
                        names.forEach(name => caches.delete(name));
                    });
                }
                
                // Force hard reload
                setTimeout(() => {
                    window.location.href = window.location.href.split('?')[0] + '?v=' + serverVersion;
                }, 1000);
            }
        }
    } catch (error) {
        // Silently fail - don't disrupt user experience
        console.debug('Version check failed:', error);
    }
}
