# Supabase — notifiche giornaliere

Questa cartella non viene pubblicata: e' la copia versionata di cio' che gira
su Supabase (progetto `FREEDOM`), che altrimenti esisterebbe solo nel pannello
web e non sarebbe rivedibile in un diff.

## Come arriva una notifica

1. `pg_cron` chiama la edge function **ogni 5 minuti** (`migrations/`).
2. `functions/push-notify` legge l'ora di **Europe/Rome** e, per ogni riga di
   `push_subscriptions`, confronta quell'ora con gli orari di **quell'utente**
   (`notif_settings`, con i default della function per cio' che non ha
   cambiato). Se combaciano, invia in Web Push (VAPID, aes128gcm).
3. Il service worker (`/sw.js`, in radice) riceve il push e mostra la notifica.

## Orari predefiniti (ora italiana)

| Ora   | Promemoria         |
|-------|--------------------|
| 07:30 | ⚖️ Buongiorno      |
| 08:00 | ☕ Colazione       |
| 10:30 | 🍎 Piccola pausa   |
| 12:00 | 🍝 È ora di pranzo |
| 16:00 | 🍊 Metà pomeriggio |
| 20:00 | 🍽️ Cena            |

Sono solo i valori di partenza: l'utente li cambia da **Profilo → Orario
Notifiche**, e puo' spegnere i singoli promemoria. Le scelte finiscono in
`push_subscriptions.notif_settings`:

```json
{ "slots": { "peso": { "h": 7, "m": 30, "on": true }, "...": {} } }
```

I testi restano invece nel codice, e vanno tenuti allineati fra **due punti**:
`DEFAULTS` in `functions/push-notify/index.ts` e `NOTIF_DEFAULTS` in
`index.html`. Gli `id` degli slot (`peso`, `colazione`, `snack1`, `pranzo`,
`snack2`, `cena`) devono combaciare fra i due, altrimenti le preferenze
salvate non vengono riconosciute.

## Perche' il cron ogni 5 minuti

Prima c'era un job per ogni orario, ciascuno su due ore UTC (una per CET, una
per CEST) perche' `pg_cron` ragiona in UTC e non conosce l'ora legale. Da
quando gli orari sono personalizzabili il cron non puo' piu' conoscerli in
anticipo, quindi scatta a intervallo fisso ed e' la function a decidere.

Con la tolleranza di 2 minuti e scatti distanti 5, ogni minuto scelto cade in
uno e un solo controllo: nessun promemoria doppio, nessuno perso. Il confronto
e' circolare sulle 24 ore, altrimenti un orario a ridosso di mezzanotte
risulterebbe lontano 1438 minuti dallo scatto delle 00:00 e non partirebbe.
Sono 288 chiamate al giorno.

## Notifiche locali

`index.html` pianifica gli stessi orari anche lato client, ma solo finche'
l'app resta aperta: servono da riserva se il push non arriva. Le due notifiche
condividono il `tag` (`awakening-<id>`), cosi' la seconda sostituisce la prima
invece di accumularsi.

## Limite noto

La policy RLS su `push_subscriptions` e' `ALL` con `using (true)`: chiunque
abbia la chiave anon puo' leggere e scrivere le righe di tutti. Va bene per
un'app a utente singolo, va stretta prima di aprirla ad altri.

## Deploy

Le modifiche qui **non** si applicano da sole: la function va ridistribuita su
Supabase e la migration eseguita sul database.
