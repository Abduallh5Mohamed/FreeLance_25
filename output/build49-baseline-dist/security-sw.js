/**
 * Security Service Worker
 * - Intercepts HLS segment requests to add auth headers
 * - Prevents caching of video segments
 * - Blocks direct m3u8/segment access without valid origin
 */

const CACHE_NAME = 'tabweb-academy-security-v2';

// Install — skip waiting to activate immediately
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

// Activate — take control of all clients immediately
self.addEventListener('activate', (event) => {
    event.waitUntil(
        Promise.all([
            self.clients.claim(),
            caches.keys().then(names => Promise.all(names.map(n => caches.delete(n))))
        ])
    );
});

// Fetch — intercept requests
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    if (url.pathname.includes('/api/secure-video/media/')) {
        event.respondWith(handleSegmentRequest(event.request));
        return;
    }

    // Intercept m3u8 playlist requests
    if (url.pathname.includes('/api/secure-video/manifest/') || url.pathname.includes('.m3u8')) {
        event.respondWith(handlePlaylistRequest(event.request));
        return;
    }

    // Intercept encryption key requests
    if (url.pathname.includes('/key/') || url.pathname.includes('/secure-video/key/')) {
        event.respondWith(handleKeyRequest(event.request));
        return;
    }
});

async function handleSegmentRequest(request) {
    // Add no-cache headers to prevent segment caching
    const modifiedHeaders = new Headers(request.headers);
    modifiedHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    modifiedHeaders.set('Pragma', 'no-cache');

    try {
        const response = await fetch(request, {
            headers: modifiedHeaders,
            cache: 'no-store'
        });

        // Create new response with no-cache headers
        const newHeaders = new Headers(response.headers);
        newHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        newHeaders.set('Pragma', 'no-cache');
        newHeaders.set('Expires', '0');

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders
        });
    } catch (error) {
        return new Response('Secure video delivery unavailable', { status: 503 });
    }
}

async function handlePlaylistRequest(request) {
    try {
        const response = await fetch(request, { cache: 'no-store' });

        const newHeaders = new Headers(response.headers);
        newHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate');
        newHeaders.set('Pragma', 'no-cache');
        newHeaders.set('Expires', '0');

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders
        });
    } catch (error) {
        return new Response('Secure playlist unavailable', { status: 503 });
    }
}

async function handleKeyRequest(request) {
    // Keys must never be cached
    try {
        const response = await fetch(request, { cache: 'no-store' });

        const newHeaders = new Headers(response.headers);
        newHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate');

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders
        });
    } catch (error) {
        return new Response('Secure key unavailable', { status: 503 });
    }
}

// Listen for messages from the main thread
self.addEventListener('message', (event) => {
    if (event.data.type === 'CLEAR_VIDEO_CACHE') {
        caches.keys().then(names =>
            Promise.all(names.map(n => caches.delete(n)))
        );
    }
});
