-- v.320 — Il resoconto della settimana del Coach nella Posta.
--
-- Nuovo tipo d'uso dell'AI, 'settimana': a fine settimana il Coach legge gli
-- ultimi 7 giorni (sedute, carichi, diario, pasti, acqua, peso) e scrive un
-- messaggio con cosa migliorare la settimana dopo. Nell'anteprima lo chiede
-- a mano solo l'account sviluppatore; nella versione finale lo scrivera' il
-- server la domenica sera, uno per persona. Il limite dei gratuiti e' 1 al
-- giorno come per il resoconto della sera; lo sviluppatore non ha limiti.
--
-- ai_consuma e' la stessa della migrazione 20261101c con 'settimana' fra i
-- tipi accettati. ai_restituisci non controlla il tipo: non cambia.

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
    if p_tipo is null or p_tipo not in ('chat', 'scheda', 'foto', 'resoconto', 'settimana') then
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
    ('free', 'settimana', 1),
    ('dev',  'settimana', null)
on conflict (piano, tipo) do update set al_giorno = excluded.al_giorno;
