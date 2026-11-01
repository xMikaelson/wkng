-- v.324 — La Posta del Coach arriva da sola alle 22:00 (ora italiana).
--
-- Finora il resoconto si chiedeva a mano dall'app e restava su quel
-- telefono. Ora:
--  - coach_dati: una riga per utente con i dati che il Coach legge
--    (giornata, settimana da lunedi', mese nella quarta settimana, pesate per
--    i grafici). La scrive l'app quando salva, qualche secondo dopo
--    l'ultima modifica: sono gli stessi dati che prima mandava al pulsante.
--  - posta: i messaggi del Coach, scritti solo dal server (nessuna policy di
--    inserimento). Ognuno legge e cancella i propri; "letto" si segna con
--    posta_segna_letto, che tocca solo quella colonna.
--  - posta_sera_avvia: alle 22 ora italiana chiama la funzione posta-sera,
--    una chiamata per utente, cosi' ogni resoconto ha il suo tempo. Il job
--    gira alle 20 e alle 21 UTC (le 22 italiane d'inverno e d'estate) e la
--    funzione parte solo nell'ora giusta.
--  - Destinatari: chi vede la Posta, cioe' per ora il piano 'dev', e solo se
--    l'app ha gia' mandato i dati almeno una volta.

create table if not exists public.coach_dati (
    user_id    uuid primary key references auth.users(id) on delete cascade,
    dati       jsonb not null,
    aggiornato timestamptz not null default now()
);
alter table public.coach_dati enable row level security;
create policy "coach_dati: solo la propria riga" on public.coach_dati
    for all to authenticated
    using (user_id = auth.uid()) with check (user_id = auth.uid());

create table if not exists public.posta (
    id      uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    giorno  date not null,
    tipo    text not null,
    da      text not null default 'Coach AI',
    titolo  text not null,
    testo   text not null,
    extra   jsonb,
    letto   boolean not null default false,
    creato  timestamptz not null default now(),
    unique (user_id, giorno, tipo)
);
alter table public.posta enable row level security;
create policy "posta: leggere i propri messaggi" on public.posta
    for select to authenticated using (user_id = auth.uid());
create policy "posta: cancellare i propri messaggi" on public.posta
    for delete to authenticated using (user_id = auth.uid());
create index if not exists posta_utente_creato on public.posta (user_id, creato desc);

create or replace function public.posta_segna_letto(p_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
    update posta set letto = true where id = p_id and user_id = auth.uid();
$$;

create or replace function public.posta_sera_avvia(p_forza boolean default false)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    r   record;
    n   integer := 0;
    url text;
    key text;
begin
    if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', 'service_role') <> 'service_role' then
        raise exception 'posta_sera_avvia: riservata al server' using errcode = '42501';
    end if;
    if not p_forza and extract(hour from (now() at time zone 'Europe/Rome')) <> 22 then
        return 0;
    end if;
    select decrypted_secret into url from vault.decrypted_secrets where name = 'project_url';
    select decrypted_secret into key from vault.decrypted_secrets where name = 'service_role_key';
    for r in
        select c.user_id
          from coach_dati c
          join ai_piani p on p.user_id = c.user_id
         where p.piano = 'dev'
    loop
        perform net.http_post(
            url := url || '/functions/v1/posta-sera',
            headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || key),
            body := jsonb_build_object('user_id', r.user_id),
            timeout_milliseconds := 120000
        );
        n := n + 1;
    end loop;
    return n;
end;
$$;

select cron.schedule('posta-sera', '0 20,21 * * *', $$select public.posta_sera_avvia()$$);
