-- pg_net rinunciava dopo 5 secondi.
--
-- La edge function a freddo ci mette di piu' (crypto VAPID + chiamata ai
-- server Apple), quindi la riga di risposta restava vuota con
-- "Timeout of 5000 ms reached". L'invio avveniva lo stesso - i log della
-- function mostrano il 201 di Apple - ma dal database non si vedeva piu'
-- se il promemoria fosse andato a buon fine, e proprio le prime chiamate
-- del mattino, quelle a freddo, erano le piu' colpite.
--
-- 20 secondi bastano e rendono di nuovo leggibile l'esito.

select cron.schedule(
  'notifiche-giornaliere',
  '*/5 * * * *',
  $cmd$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/push-notify',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'), 'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 20000
  );
$cmd$
);
