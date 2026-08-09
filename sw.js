const CACHE_NAME = 'awakening-v307';

const STATIC_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './icon-192.png',
    './icon-512.png',
    'https://cdn.jsdelivr.net/npm/chart.js',
    'https://cdn.jsdelivr.net/npm/@ericblade/quagga2@1.8.4/dist/quagga.min.js'
];

// Un asset e' "documento" se e' la root o index.html: questi vanno sempre
// chiesti alla rete per primi, altrimenti la PWA resta ferma alla versione vecchia.
function isDocumentRequest(request) {
    if (request.mode === 'navigate') return true;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return false;
    return url.pathname.endsWith('/') || url.pathname.endsWith('/index.html');
}

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => Promise.all(STATIC_ASSETS.map(url => {
                // cache:'reload' salta la cache HTTP del browser: senza questo
                // il precache puo' salvare di nuovo il vecchio index.html.
                const req = url.startsWith('http')
                    ? new Request(url, { mode: 'cors' })
                    : new Request(url, { cache: 'reload' });
                return fetch(req)
                    .then(res => (res && res.ok) ? cache.put(url, res) : null)
                    .catch(() => null);
            })))
            .catch(err => console.log('Cache install error:', err))
    );
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => {
            // Se esistevano cache vecchie siamo davanti a un AGGIORNAMENTO,
            // non a una prima installazione: in quel caso ricarichiamo le finestre aperte.
            const isUpdate = keys.some(key => key !== CACHE_NAME);
            return Promise.all(keys
                .filter(key => key !== CACHE_NAME)
                .map(key => caches.delete(key))
            ).then(() => self.clients.claim())
             .then(() => {
                if (!isUpdate) return;
                return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
                    .then(list => Promise.all(list.map(client => {
                        try {
                            return client.navigate(client.url);
                        } catch (e) {
                            return null;
                        }
                    })))
                    .catch(() => null);
             });
        })
    );
});

self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    const alwaysLive = ['supabase.co', 'openfoodfacts.org', 'youtube.com', 'googleapis.com', 'anthropic.com'];
    if (alwaysLive.some(domain => url.hostname.includes(domain))) return;

    // ---- Documento (navigazione / index.html): NETWORK-FIRST ----
    if (isDocumentRequest(event.request)) {
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    if (response && response.status === 200) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    }
                    return response;
                })
                .catch(() => caches.match(event.request)
                    .then(cached => cached || caches.match('./index.html'))
                )
        );
        return;
    }

    // ---- Tutto il resto: CACHE-FIRST (come prima) ----
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
