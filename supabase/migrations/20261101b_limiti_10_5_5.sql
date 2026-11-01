-- v.317 — Limiti gratuiti alzati a 10 domande, 5 analisi, 5 foto al giorno.
--
-- Il Coach e' passato a Claude Haiku 5.5 (functions/ai-coach): nel confronto
-- del 1/11/2026 sulle richieste vere dell'app ogni uso costa da 5 a 8 volte
-- meno (chat ~0,05 centesimi, scheda ~0,09, foto ~0,03-0,07). Con 10 + 5 + 5
-- chi li usa tutti ogni giorno costa al massimo circa mezzo euro al mese,
-- meno di prima con 3 + 2 + 2.
--
-- Il tetto comune dei gratuiti sale da 300 a 2000 usi al giorno: con i
-- limiti nuovi 300 bastavano a una quindicina di persone attive, poi il
-- Coach si sarebbe fermato per tutti. 2000 usi costano al massimo circa
-- 1,5 euro al giorno, la stessa protezione di prima (pochi euro al giorno
-- nel caso peggiore).
insert into public.ai_limiti (piano, tipo, al_giorno) values
    ('free', 'chat',   10),
    ('free', 'scheda', 5),
    ('free', 'foto',   5),
    ('free', 'totale', 2000)
on conflict (piano, tipo) do update set al_giorno = excluded.al_giorno;
