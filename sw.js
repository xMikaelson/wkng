const CACHE_NAME = 'awakening-v131';

// Files to cache for offline use
const STATIC_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './icon-192.png',
    './icon-512.png',
    'https://cdn.jsdelivr.net/npm/chart.js',
    'https://cdn.jsdelivr.net/npm/@ericblade/quagga2@1.8.4/dist/quagga.min.js'
];

// Install — cache static assets
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(STATIC_ASSETS.filter(url => !url.startsWith('http') || url.includes('jsdelivr'))))
            .catch(err => console.log('Cache install error:', err))
    );
    self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys
                .filter(key => key !== CACHE_NAME)
                .map(key => caches.delete(key))
            )
        )
    );
    self.clients.claim();
});

// Fetch — cache first for static, network first for API
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // Always fetch live: Supabase, Open Food Facts, YouTube
    const alwaysLive = [
        'supabase.co',
        'openfoodfacts.org',
        'youtube.com',
        'googleapis.com',
        'anthropic.com'
    ];
    if (alwaysLive.some(domain => url.hostname.includes(domain))) {
        return; // let browser handle normally
    }

    // Cache first for everything else (app shell, CDN libraries)
    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) return cached;
            return fetch(event.request).then(response => {
                // Cache successful GET responses
                if (event.request.method === 'GET' && response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => {
                // Offline fallback for navigation requests
                if (event.request.mode === 'navigate') {
                    return caches.match('./index.html');
                }
            });
        })
    );
});
