-- Orari dei promemoria modificabili dall'utente.
--
-- Prima gli orari erano identici per tutti e scritti nella edge function, con
-- un job di cron per ciascuno. Ora si cambiano dal profilo, quindi il cron non
-- puo' piu' conoscerli in anticipo: si passa a un solo scatto ogni 5 minuti ed
-- e' la function a confrontare l'ora di Roma con gli orari di ogni utente.
--
-- Con la tolleranza di 2 minuti gia' presente nella function, ogni minuto
-- scelto cade dentro uno e un solo scatto (gli scatti distano 5 minuti):
-- nessun promemoria doppio, nessuno perso. Sono 288 chiamate al giorno.

alter table push_subscriptions
  add column if not exists notif_settings jsonb;

-- La riga puo' esistere con le sole preferenze, prima che l'utente conceda il
-- permesso: la subscription arriva solo dopo, e senza questo il salvataggio
-- degli orari fallirebbe per chi non ha ancora attivato le notifiche.
alter table push_subscriptions
  alter column subscription drop not null;

select cron.schedule(
  'notifiche-giornaliere',
  '*/5 * * * *',
  $cmd$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/push-notify',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'), 'Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
$cmd$
);

select cron.unschedule(jobname)
from cron.job
where jobname in ('peso-07-30','colazione-08-00','snack-mattina-10-30',
                  'pranzo-12-00','snack-pomeriggio-16-00','cena-20-00');
