-- La pesata si sposta dalle 07:15 alle 07:30.
--
-- Come per gli altri promemoria, il job scatta su due ore UTC (una per CET,
-- una per CEST) ed e' la edge function a decidere in base all'ora di Roma:
-- 07:30 italiane sono le 05:30 UTC d'estate e le 06:30 d'inverno.
--
-- Il job cambia nome perche' il vecchio lo conteneva ('peso-07-15'): si crea
-- quello nuovo e si toglie il vecchio, altrimenti resterebbero entrambi e la
-- function verrebbe chiamata due volte al mattino.

select cron.schedule(
  'peso-07-30',
  '30 5,6 * * *',
  $cmd$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/push-notify',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'), 'Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
$cmd$
);

select cron.unschedule('peso-07-15')
where exists (select 1 from cron.job where jobname = 'peso-07-15');
