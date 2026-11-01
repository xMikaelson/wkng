-- v.316 — Chi puo' usare l'AI e quanto.
--
-- Prima la funzione ai-coach rispondeva a chiunque conoscesse il suo
-- indirizzo, senza account e senza limiti: ogni richiesta la pagava il
-- progetto. Ora risponde solo agli account e conta gli usi del giorno
-- (ora italiana), separati per tipo:
--   chat   — una domanda al Coach
--   scheda — "Analisi Coach AI" nell'editor delle schede
--   foto   — riconoscimento del piatto dalla foto del pasto
--
-- ai_piani   un piano per account: 'free' (chi non ha riga), 'pro'
--            (abbonati, quando ci saranno), 'dev' (chi sviluppa l'app).
-- ai_limiti  quanti usi al giorno per piano e tipo; NULL = nessun limite.
--            La riga ('free', 'totale') e' un tetto per TUTTI gli account
--            gratuiti insieme: se qualcuno crea tanti account per aggirare
--            il limite personale, la spesa del giorno resta comunque chiusa.
--            I numeri si cambiano qui, senza toccare app o funzione.
-- ai_uso     il contatore: una riga per account, giorno e tipo.
--
-- Scrive solo la funzione ai-coach (service role) attraverso ai_consuma e
-- ai_restituisci; ogni utente puo' solo leggere il proprio piano e i propri
-- contatori, per vedere nell'app quanti messaggi gli restano. Il piano non
-- sta in profiles perche' la policy profiles_update lascia all'utente ogni
-- colonna della propria riga: potrebbe promuoversi da solo.

create table if not exists public.ai_piani (
    user_id    uuid primary key references auth.users (id) on delete cascade,
    piano      text not null default 'free' check (piano in ('free', 'pro', 'dev')),
    nota       text,
    aggiornato timestamptz not null default now()
);

create table if not exists public.ai_limiti (
    piano     text not null,
    tipo      text not null,
    al_giorno integer check (al_giorno is null or al_giorno >= 0),
    primary key (piano, tipo)
);

create table if not exists public.ai_uso (
    user_id uuid not null references auth.users (id) on delete cascade,
    giorno  date not null,
    tipo    text not null,
    usati   integer not null default 0,
    primary key (user_id, giorno, tipo)
);
create index if not exists ai_uso_giorno on public.ai_uso (giorno);

alter table public.ai_piani  enable row level security;
alter table public.ai_limiti enable row level security;
alter table public.ai_uso    enable row level security;

drop policy if exists "ai_piani: ognuno legge il proprio" on public.ai_piani;
create policy "ai_piani: ognuno legge il proprio" on public.ai_piani
    for select to authenticated using (user_id = auth.uid());
drop policy if exists "ai_limiti: leggibili dagli account" on public.ai_limiti;
create policy "ai_limiti: leggibili dagli account" on public.ai_limiti
    for select to authenticated using (true);
drop policy if exists "ai_uso: ognuno legge il proprio" on public.ai_uso;
create policy "ai_uso: ognuno legge il proprio" on public.ai_uso
    for select to authenticated using (user_id = auth.uid());

revoke insert, update, delete on public.ai_piani, public.ai_limiti, public.ai_uso from anon, authenticated;

-- Limiti di partenza (stime con Claude Haiku 4.5, 1 $ / 5 $ per milione di
-- token in entrata / uscita): una domanda in chat costa circa mezzo
-- centesimo, un'analisi della scheda circa un centesimo, una foto circa
-- mezzo centesimo. Con 3 + 2 + 2 al giorno, chi li usa tutti ogni giorno
-- costa al massimo poco piu' di un euro al mese; chi li usa davvero, molto
-- meno. Il tetto comune (300 usi al giorno per tutti i gratuiti insieme)
-- chiude la spesa giornaliera a pochi euro anche nel caso peggiore.
insert into public.ai_limiti (piano, tipo, al_giorno) values
    ('free', 'chat',   3),
    ('free', 'scheda', 2),
    ('free', 'foto',   2),
    ('free', 'totale', 300),
    ('dev',  'chat',   null),
    ('dev',  'scheda', null),
    ('dev',  'foto',   null)
on conflict (piano, tipo) do update set al_giorno = excluded.al_giorno;

-- L'account di chi ha creato l'app.
insert into public.ai_piani (user_id, piano, nota)
values ('99e2d002-502a-48eb-b818-abbfeb4292d1', 'dev', 'creatore dell''app')
on conflict (user_id) do update set piano = 'dev', nota = excluded.nota, aggiornato = now();

-- Conta un uso, se il piano lo consente. Risponde con
--   { ok: true,  piano, limite, usati }      uso contato
--   { ok: false, motivo: 'limite', ... }     finiti quelli di oggi
--   { ok: false, motivo: 'pausa' }           tetto comune dei gratuiti
--   { ok: false, motivo: 'tipo' }            tipo sconosciuto
-- L'incremento e' una sola istruzione (insert ... on conflict ... where):
-- due richieste insieme non possono superare il limite.
create or replace function public.ai_consuma(p_user uuid, p_tipo text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_oggi  date := (now() at time zone 'Europe/Rome')::date;
    v_piano text;
    v_lim   integer;
    v_cap   integer;
    v_tot   integer;
    v_usati integer;
begin
    if p_tipo is null or p_tipo not in ('chat', 'scheda', 'foto') then
        return jsonb_build_object('ok', false, 'motivo', 'tipo');
    end if;
    select piano into v_piano from ai_piani where user_id = p_user;
    v_piano := coalesce(v_piano, 'free');
    select al_giorno into v_lim from ai_limiti where piano = v_piano and tipo = p_tipo;
    if not found then
        return jsonb_build_object('ok', false, 'motivo', 'tipo', 'piano', v_piano);
    end if;
    if v_lim is not null and v_lim <= 0 then
        return jsonb_build_object('ok', false, 'motivo', 'limite', 'piano', v_piano, 'limite', v_lim, 'usati', 0);
    end if;
    if v_piano = 'free' then
        select al_giorno into v_cap from ai_limiti where piano = 'free' and tipo = 'totale';
        if v_cap is not null then
            select coalesce(sum(u.usati), 0) into v_tot
              from ai_uso u
              left join ai_piani p on p.user_id = u.user_id
             where u.giorno = v_oggi and coalesce(p.piano, 'free') = 'free';
            if v_tot >= v_cap then
                return jsonb_build_object('ok', false, 'motivo', 'pausa', 'piano', v_piano);
            end if;
        end if;
    end if;
    insert into ai_uso as u (user_id, giorno, tipo, usati)
    values (p_user, v_oggi, p_tipo, 1)
    on conflict (user_id, giorno, tipo) do update
        set usati = u.usati + 1
        where v_lim is null or u.usati < v_lim
    returning usati into v_usati;
    if v_usati is null then
        return jsonb_build_object('ok', false, 'motivo', 'limite', 'piano', v_piano, 'limite', v_lim, 'usati', v_lim);
    end if;
    return jsonb_build_object('ok', true, 'piano', v_piano, 'limite', v_lim, 'usati', v_usati);
end;
$$;

-- Se la risposta dell'AI non arriva (errore del servizio, rete), l'uso
-- contato viene restituito: chi non ha ricevuto niente non perde un messaggio.
create or replace function public.ai_restituisci(p_user uuid, p_tipo text)
returns void
language sql
security definer
set search_path = public
as $$
    update ai_uso set usati = greatest(usati - 1, 0)
     where user_id = p_user and tipo = p_tipo
       and giorno = (now() at time zone 'Europe/Rome')::date;
$$;

revoke all on function public.ai_consuma(uuid, text)     from public, anon, authenticated;
revoke all on function public.ai_restituisci(uuid, text) from public, anon, authenticated;
grant execute on function public.ai_consuma(uuid, text)     to service_role;
grant execute on function public.ai_restituisci(uuid, text) to service_role;
