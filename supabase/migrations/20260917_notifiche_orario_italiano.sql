-- Notifiche giornaliere: gli orari seguono l'ora italiana, non l'UTC.
--
-- Prima ogni promemoria aveva un solo scatto UTC, scelto sull'ora solare:
-- 06:15 UTC per le 07:15, 07:00 per le 08:00 e cosi' via. Funzionava solo
-- d'inverno. Da fine marzo a fine ottobre l'Italia e' su CEST (UTC+2) e le
-- stesse righe di cron facevano arrivare tutto un'ora tardi: il peso alle
-- 08:15, la cena alle 21:00.
--
-- Ora ogni promemoria e' schedulato su DUE ore UTC, una per CET e una per
-- CEST. E' la edge function push-notify a decidere: legge l'ora di
-- Europe/Rome e invia solo se corrisponde a uno slot, quindi degli scatti
-- ogni giorno ne parte sempre esattamente uno. Nessun intervento ai cambi
-- d'ora.

do $$
declare
  cmd text := $cmd$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/push-notify',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'), 'Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
$cmd$;
begin
  --                       job                      CEST   CET   ora italiana
  perform cron.schedule('peso-07-15',             '15 5,6 * * *',   cmd);  -- 07:15
  perform cron.schedule('colazione-08-00',        '0 6,7 * * *',    cmd);  -- 08:00
  perform cron.schedule('snack-mattina-10-30',    '30 8,9 * * *',   cmd);  -- 10:30
  perform cron.schedule('pranzo-13-00',           '0 11,12 * * *',  cmd);  -- 13:00
  perform cron.schedule('snack-pomeriggio-16-00', '0 14,15 * * *',  cmd);  -- 16:00
  perform cron.schedule('cena-20-00',             '0 18,19 * * *',  cmd);  -- 20:00
end $$;

-- Doppione rimasto da una prima prova: scattava alle 08:00 UTC su un orario
-- che nessuna schedule ha mai previsto, quindi chiamava la function ogni
-- giorno per farla uscire subito senza inviare niente. Il promemoria del peso
-- e' gia' coperto da 'peso-07-15'.
select cron.unschedule('peso-reminder-daily')
where exists (select 1 from cron.job where jobname = 'peso-reminder-daily');
