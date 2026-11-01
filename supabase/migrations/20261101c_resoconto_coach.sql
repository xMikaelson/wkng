-- v.319 — Anteprima del personal coach: il resoconto della giornata.
--
-- Un nuovo tipo d'uso dell'AI, 'resoconto': il Coach legge i dati della
-- giornata (allenamento, pasti, acqua, peso, diario) e scrive un messaggio
-- nella Posta del Profilo. In questa anteprima lo chiede a mano solo
-- l'account sviluppatore; nella versione finale lo scrivera' il server ogni
-- sera, uno per persona: per questo il limite dei gratuiti e' 1 al giorno.

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
    if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', 'service_role') <> 'service_role' then
        raise exception 'ai_consuma: riservata alla funzione ai-coach' using errcode = '42501';
    end if;
    if p_tipo is null or p_tipo not in ('chat', 'scheda', 'foto', 'resoconto') then
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

insert into public.ai_limiti (piano, tipo, al_giorno) values
    ('free', 'resoconto', 1),
    ('dev',  'resoconto', null)
on conflict (piano, tipo) do update set al_giorno = excluded.al_giorno;
