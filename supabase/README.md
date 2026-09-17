# Supabase — notifiche giornaliere

Questa cartella non viene pubblicata: e' la copia versionata di cio' che gira
su Supabase (progetto `FREEDOM`), che altrimenti esisterebbe solo nel pannello
web e non sarebbe rivedibile in un diff.

## Come arriva una notifica

1. `pg_cron` chiama la edge function agli orari previsti (`migrations/`).
2. `functions/push-notify` legge l'ora di **Europe/Rome**, sceglie il
   promemoria di quello slot e lo invia in Web Push (VAPID) a ogni device
   presente in `push_subscriptions`.
3. Il service worker (`/sw.js`, in radice) riceve il push e mostra la notifica.

## Orari (ora italiana)

| Ora   | Promemoria     |
|-------|----------------|
| 07:15 | ⚖️ Peso        |
| 08:00 | ☕ Colazione    |
| 10:30 | 🍎 Snack + Acqua |
| 13:00 | 🍝 Pranzo      |
| 16:00 | 🍊 Snack + Acqua |
| 20:00 | 🍽️ Cena        |

Gli orari si cambiano in **due punti**, che devono restare allineati:
`SCHEDULE` in `functions/push-notify/index.ts` (l'orario vero) e le righe di
cron nella migration (gli scatti che risvegliano la function).

## Perche' ogni job ha due ore UTC

`pg_cron` ragiona in UTC e non conosce l'ora legale. Con un solo scatto gli
orari erano giusti d'inverno e un'ora tardi da fine marzo a fine ottobre.
Ora ogni promemoria e' schedulato sia sull'ora CET che su quella CEST
(es. `15 5,6 * * *` per le 07:15): la function confronta con l'ora di Roma e
scarta lo scatto sbagliato, quindi ogni giorno ne va a segno esattamente uno.

## Notifiche locali

`index.html` pianifica gli stessi orari anche lato client
(`CLIENT_NOTIF_SCHEDULE`), ma solo finche' l'app resta aperta: servono da
riserva se il push non arriva. Le due notifiche condividono il `tag`
(`awakening-<ora>-<minuti>`), cosi' la seconda sostituisce la prima invece di
accumularsi.

## Deploy

Le modifiche qui **non** si applicano da sole: la function va ridistribuita su
Supabase e la migration eseguita sul database.
