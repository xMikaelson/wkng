-- Il Club (sito, v.346).
--
-- Il sito in /sito/ e' il "club" di Awakening: chi ha un account dell'app
-- firma il Patto e diventa membro numerato; ogni giorno risponde
-- all'Appello con un'Offerta (cosa ha pagato oggi: una seduta, una sveglia
-- all'alba, una rinuncia); gli altri membri rispondono con una Spinta, o
-- Chiamano chi manca da due giorni. Il sito registra anche i pasti
-- riconosciuti dalla foto.
--
-- Tutto qui e' AGGIUNTO: nessuna tabella dell'app cambia. In particolare il
-- sito non scrive mai profiles.state_json, che l'app sovrascrive per intero
-- a ogni salvataggio: un pasto messo li' dal sito sparirebbe al primo
-- salvataggio del telefono. Per questo i pasti del sito hanno una tabella
-- loro (club_pasti).
--
-- Visibilita':
--   club_membri   i membri si vedono fra loro; chi non e' membro non vede
--                 nessuno. Ognuno scrive solo la propria riga e solo nome,
--                 prezzo (il voto del Patto) e sedute.
--   club_offerte  il Registro: leggibile dai membri, si scrive solo per se'
--                 e solo per oggi (ora italiana), al massimo 6 al giorno.
--   club_spinte   le spinte sono pubbliche fra i membri; le chiamate le
--                 vedono solo chi chiama e chi e' chiamato.
--   club_pasti    privati: solo il proprietario.
--   club_oggi()   per la pagina pubblica: solo numeri, nessun nome.

-- Giorno di oggi in Italia: il Registro e l'Appello ragionano per giornate
-- italiane, come le notifiche e i limiti del Coach.
create or replace function public.club_oggi_it()
returns date language sql stable
set search_path = ''
as $$ select (now() at time zone 'Europe/Rome')::date $$;

create table if not exists public.club_membri (
    user_id  uuid primary key default auth.uid() references auth.users (id) on delete cascade,
    numero   integer generated always as identity unique,
    nome     text not null check (char_length(btrim(nome)) between 1 and 24),
    prezzo   text not null check (char_length(btrim(prezzo)) between 3 and 140),
    sedute   integer not null default 0 check (sedute between 0 and 100000),
    entrato  timestamptz not null default now(),
    ultima   date
);

create table if not exists public.club_offerte (
    id      uuid primary key default gen_random_uuid(),
    user_id uuid not null default auth.uid() references public.club_membri (user_id) on delete cascade,
    giorno  date not null default public.club_oggi_it(),
    tipo    text not null check (tipo in ('allenamento', 'alba', 'rinuncia', 'pasto', 'altro')),
    testo   text not null check (char_length(btrim(testo)) between 2 and 200),
    creato  timestamptz not null default now()
);
create index if not exists club_offerte_giorno on public.club_offerte (giorno desc, creato desc);
create index if not exists club_offerte_user on public.club_offerte (user_id, giorno desc);

create table if not exists public.club_spinte (
    id      uuid primary key default gen_random_uuid(),
    da      uuid not null default auth.uid() references public.club_membri (user_id) on delete cascade,
    a       uuid not null references public.club_membri (user_id) on delete cascade,
    offerta uuid references public.club_offerte (id) on delete cascade,
    tipo    text not null check (tipo in ('spinta', 'chiamata')),
    giorno  date not null default public.club_oggi_it(),
    letto   boolean not null default false,
    creato  timestamptz not null default now(),
    check (da <> a),
    check ((tipo = 'spinta') = (offerta is not null))
);
-- Una spinta per offerta da ogni membro, una chiamata al giorno per coppia.
create unique index if not exists club_spinte_una on public.club_spinte (da, offerta) where tipo = 'spinta';
create unique index if not exists club_chiamata_una on public.club_spinte (da, a, giorno) where tipo = 'chiamata';
create index if not exists club_spinte_a on public.club_spinte (a, letto);
create index if not exists club_spinte_offerta on public.club_spinte (offerta);

create table if not exists public.club_pasti (
    id      uuid primary key default gen_random_uuid(),
    user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
    giorno  date not null default public.club_oggi_it(),
    pasto   text not null check (pasto in ('colazione', 'pranzo', 'snack', 'cena')),
    nome    text not null check (char_length(btrim(nome)) between 1 and 80),
    grammi  numeric check (grammi is null or (grammi >= 0 and grammi <= 5000)),
    kcal    numeric not null check (kcal >= 0 and kcal <= 10000),
    prot    numeric not null default 0 check (prot >= 0 and prot <= 1000),
    carb    numeric not null default 0 check (carb >= 0 and carb <= 1000),
    grassi  numeric not null default 0 check (grassi >= 0 and grassi <= 1000),
    fonte   text not null default 'foto' check (fonte in ('foto', 'manuale')),
    creato  timestamptz not null default now()
);
create index if not exists club_pasti_user_giorno on public.club_pasti (user_id, giorno desc);

-- ── Chi e' membro ───────────────────────────────────────────
-- security definer: le policy delle altre tabelle la chiamano senza
-- ricadere nella RLS di club_membri.
create or replace function public.club_sono_membro()
returns boolean language sql stable security definer
set search_path = ''
as $$ select exists (select 1 from public.club_membri where user_id = auth.uid()) $$;

-- ── Regole di scrittura che una policy non sa dire ─────────
-- Offerte: solo per oggi, al massimo 6 al giorno. Aggiorna "ultima" del
-- membro, che l'Appello usa per sapere chi manca.
create or replace function public.club_offerta_prima()
returns trigger language plpgsql security definer
set search_path = ''
as $$
begin
    new.giorno := public.club_oggi_it();
    new.creato := now();
    if (select count(*) from public.club_offerte where user_id = new.user_id and giorno = new.giorno) >= 6 then
        raise exception 'Oggi hai gia'' risposto 6 volte all''appello.' using errcode = 'P0001';
    end if;
    return new;
end $$;

create or replace function public.club_offerta_dopo()
returns trigger language plpgsql security definer
set search_path = ''
as $$
begin
    if tg_op = 'INSERT' then
        update public.club_membri set ultima = new.giorno where user_id = new.user_id;
    else
        update public.club_membri m
           set ultima = (select max(giorno) from public.club_offerte o where o.user_id = old.user_id)
         where m.user_id = old.user_id;
    end if;
    return null;
end $$;

-- Spinte: la spinta va all'autore dell'offerta; la chiamata solo a chi
-- manca da almeno due giorni (o non ha mai risposto) e solo per oggi.
create or replace function public.club_spinta_prima()
returns trigger language plpgsql security definer
set search_path = ''
as $$
declare autore uuid; sua_ultima date;
begin
    new.giorno := public.club_oggi_it();
    new.creato := now();
    new.letto  := false;
    if new.tipo = 'spinta' then
        select user_id into autore from public.club_offerte where id = new.offerta;
        if autore is null then raise exception 'Offerta non trovata.' using errcode = 'P0001'; end if;
        new.a := autore;
    else
        select ultima into sua_ultima from public.club_membri where user_id = new.a;
        if not found then raise exception 'Membro non trovato.' using errcode = 'P0001'; end if;
        if sua_ultima is not null and sua_ultima > new.giorno - 2 then
            raise exception 'Questo membro ha gia'' risposto all''appello.' using errcode = 'P0001';
        end if;
    end if;
    return new;
end $$;

drop trigger if exists club_offerta_prima on public.club_offerte;
create trigger club_offerta_prima before insert on public.club_offerte
    for each row execute function public.club_offerta_prima();
drop trigger if exists club_offerta_dopo on public.club_offerte;
create trigger club_offerta_dopo after insert or delete on public.club_offerte
    for each row execute function public.club_offerta_dopo();
drop trigger if exists club_spinta_prima on public.club_spinte;
create trigger club_spinta_prima before insert on public.club_spinte
    for each row execute function public.club_spinta_prima();

-- Le funzioni dei trigger non si chiamano da fuori.
revoke execute on function public.club_offerta_prima() from public, anon, authenticated;
revoke execute on function public.club_offerta_dopo()  from public, anon, authenticated;
revoke execute on function public.club_spinta_prima()  from public, anon, authenticated;

-- ── RLS ─────────────────────────────────────────────────────
alter table public.club_membri  enable row level security;
alter table public.club_offerte enable row level security;
alter table public.club_spinte  enable row level security;
alter table public.club_pasti   enable row level security;

drop policy if exists "club_membri: i membri si vedono" on public.club_membri;
create policy "club_membri: i membri si vedono" on public.club_membri
    for select to authenticated using (user_id = (select auth.uid()) or (select public.club_sono_membro()));
drop policy if exists "club_membri: entrare" on public.club_membri;
create policy "club_membri: entrare" on public.club_membri
    for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "club_membri: la propria tessera" on public.club_membri;
create policy "club_membri: la propria tessera" on public.club_membri
    for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "club_membri: uscire" on public.club_membri;
create policy "club_membri: uscire" on public.club_membri
    for delete to authenticated using (user_id = (select auth.uid()));

-- Numero, data d'ingresso e ultima risposta non si toccano dal client.
revoke insert, update on public.club_membri from anon, authenticated;
grant insert (user_id, nome, prezzo, sedute) on public.club_membri to authenticated;
grant update (nome, prezzo, sedute) on public.club_membri to authenticated;

drop policy if exists "club_offerte: il registro" on public.club_offerte;
create policy "club_offerte: il registro" on public.club_offerte
    for select to authenticated using ((select public.club_sono_membro()));
drop policy if exists "club_offerte: rispondere" on public.club_offerte;
create policy "club_offerte: rispondere" on public.club_offerte
    for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "club_offerte: ritirare" on public.club_offerte;
create policy "club_offerte: ritirare" on public.club_offerte
    for delete to authenticated using (user_id = (select auth.uid()));
revoke update on public.club_offerte from anon, authenticated;

drop policy if exists "club_spinte: vedere" on public.club_spinte;
create policy "club_spinte: vedere" on public.club_spinte
    for select to authenticated using (
        (tipo = 'spinta' and (select public.club_sono_membro()))
        or da = (select auth.uid()) or a = (select auth.uid()));
drop policy if exists "club_spinte: spingere" on public.club_spinte;
create policy "club_spinte: spingere" on public.club_spinte
    for insert to authenticated with check (da = (select auth.uid()));
drop policy if exists "club_spinte: ritirare" on public.club_spinte;
create policy "club_spinte: ritirare" on public.club_spinte
    for delete to authenticated using (da = (select auth.uid()));
drop policy if exists "club_spinte: segnare letto" on public.club_spinte;
create policy "club_spinte: segnare letto" on public.club_spinte
    for update to authenticated using (a = (select auth.uid())) with check (a = (select auth.uid()));
revoke update on public.club_spinte from anon, authenticated;
grant update (letto) on public.club_spinte to authenticated;

drop policy if exists "club_pasti: solo i propri" on public.club_pasti;
create policy "club_pasti: solo i propri" on public.club_pasti
    for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Chi non ha account non vede nessuna tabella del club.
revoke all on public.club_membri, public.club_offerte, public.club_spinte, public.club_pasti from anon;

-- ── La pagina pubblica ──────────────────────────────────────
-- Solo conteggi: quanti membri, quanti hanno risposto oggi, quante offerte
-- e spinte. Il sole della prima pagina sale con la quota dei presenti.
create or replace function public.club_oggi()
returns json language sql stable security definer
set search_path = ''
as $$
    select json_build_object(
        'membri',   (select count(*) from public.club_membri),
        'presenti', (select count(distinct user_id) from public.club_offerte where giorno = public.club_oggi_it()),
        'offerte',  (select count(*) from public.club_offerte where giorno = public.club_oggi_it()),
        'spinte',   (select count(*) from public.club_spinte where giorno = public.club_oggi_it()),
        'giorno',   public.club_oggi_it()
    )
$$;
revoke execute on function public.club_oggi() from public;
grant execute on function public.club_oggi() to anon, authenticated;
revoke execute on function public.club_sono_membro() from public, anon;
grant execute on function public.club_sono_membro() to authenticated;
