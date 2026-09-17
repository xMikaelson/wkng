-- Il pranzo si sposta dalle 13:00 alle 12:00.
--
-- Come gli altri, il job scatta su due ore UTC (una per CET, una per CEST) e
-- la edge function sceglie in base all'ora di Roma: mezzogiorno italiano sono
-- le 10:00 UTC d'estate e le 11:00 d'inverno.
--
-- Il nome del job contiene l'orario, quindi cambia: si crea 'pranzo-12-00' e
-- si rimuove 'pranzo-13-00', altrimenti resterebbero entrambi e la function
-- verrebbe chiamata due volte.

select cron.schedule(
  'pranzo-12-00',
  '0 10,11 * * *',
  $cmd$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/push-notify',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'), 'Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
$cmd$
);

select cron.unschedule('pranzo-13-00')
where exists (select 1 from cron.job where jobname = 'pranzo-13-00');
