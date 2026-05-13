const CACHE_NAME = 'awakening-v199';

const STATIC_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './icon-192.png',
    './icon-512.png',
    'https://cdn.jsdelivr.net/npm/chart.js',
    'https://cdn.jsdelivr.net/npm/@ericblade/quagga2@1.8.4/dist/quagga.min.js'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(STATIC_ASSETS.filter(url => !url.startsWith('http') || url.includes('jsdelivr'))))
            .catch(err => console.log('Cache install error:', err))
    );
    self.skipWaiting();
});

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

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    const alwaysLive = ['supabase.co', 'openfoodfacts.org', 'youtube.com', 'googleapis.com', 'anthropic.com'];
    if (alwaysLive.some(domain => url.hostname.includes(domain))) return;

    event.respondWith(
        caches.match(event.request).then(cached => {
            if (cached) return cached;
            return fetch(event.request).then(response => {
                if (event.request.method === 'GET' && response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => {
                if (event.request.mode === 'navigate') return caches.match('./index.html');
            });
        })
    );
});

// Notifica push dal server Supabase
self.addEventListener('push', event => {
    let title = '\u2696\ufe0f Awakening';
    let body  = 'Hai un promemoria da Awakening!';
    let tag   = 'awakening-reminder';

    if (event.data) {
        try {
            const text = event.data.text();
            console.log('[SW] Push ricevuto:', text);
            if (text && text.trim().startsWith('{')) {
                const payload = JSON.parse(text);
                if (payload.title) title = payload.title;
                if (payload.body)  body  = payload.body;
                if (payload.tag)   tag   = payload.tag;
            }
        } catch(e) {
            console.warn('[SW] Errore parsing push:', e);
        }
    } else {
        console.log('[SW] Push ricevuto senza data');
    }

    event.waitUntil(
        self.registration.showNotification(title, {
            body,
            icon:      './icon-192.png',
            badge:     './icon-192.png',
            tag,
            renotify:  true,
            silent:    false,
            data:      { url: './' }
        })
    );
});

// Tap sulla notifica: apre/focusa la PWA
self.addEventListener('notificationclick', event => {
    event.notification.close();
    const target = (event.notification.data && event.notification.data.url) || './';
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
            for (const client of list) {
                if (client.url.includes(self.location.origin) && 'focus' in client) {
                    return client.focus();
                }
            }
            if (clients.openWindow) return clients.openWindow(target);
        })
    );
});
