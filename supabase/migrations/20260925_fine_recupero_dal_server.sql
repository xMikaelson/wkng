-- Fine recupero dal server (app v.285).
--
-- Per lasciare suonare la musica l'app non tiene piu' viva la pagina con
-- una traccia audio: a schermo spento il JavaScript si ferma e la notifica
-- locale di fine recupero non parte. Allora all'inizio del recupero l'app
-- scrive qui quando finira', e il server manda il push.
--
-- Una riga per utente (il recupero in corso e' uno solo): l'app fa upsert
-- a ogni nuovo recupero e cancella la riga se finisce con l'app aperta.
-- Chiave = username, come push_subscriptions, con la stessa policy.

create table if not exists public.rest_push (
  user_id    text primary key,
  fire_at    timestamptz not null,
  title      text,
  body       text,
  created_at timestamptz not null default now()
);

alter table public.rest_push enable row level security;

create policy "Ognuno gestisce solo il proprio recupero"
  on public.rest_push for all
  to authenticated
  using      (user_id = (select username from profiles where id = auth.uid()))
  with check (user_id = (select username from profiles where id = auth.uid()));

-- Ogni 5 secondi (pg_cron >= 1.5 accetta intervalli in secondi). La edge
-- function viene chiamata solo se c'e' davvero una riga scaduta: a vuoto il
-- job costa una query, non un'invocazione.
select cron.schedule(
  'fine-recupero',
  '5 seconds',
  $cmd$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/push-notify',
    headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'), 'Content-Type', 'application/json'),
    body := '{"mode":"rest"}'::jsonb,
    timeout_milliseconds := 20000
  )
  where exists (select 1 from public.rest_push where fire_at <= now());
$cmd$
);
