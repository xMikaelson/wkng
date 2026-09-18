-- push_subscriptions era l'unica tabella aperta a chiunque.
--
-- La policy era ALL con using(true): con la chiave anon, che sta in chiaro nel
-- JavaScript dell'app, si potevano leggere e scrivere le righe di tutti.
-- profiles e protocols erano gia' legate a auth.uid(); qui non si poteva fare
-- lo stesso perche' la chiave della tabella e' lo username, non l'id
-- dell'account, e i due non si confrontano direttamente.
--
-- Si passa dallo username al profilo: la riga e' accessibile solo se il suo
-- user_id e' lo username del profilo di chi sta chiamando. Nessuna modifica
-- allo schema ne' all'app, quindi la subscription gia' registrata continua a
-- funzionare senza riattivare le notifiche.
--
-- La sottoquery su profiles gira con i diritti del chiamante e la policy
-- profiles_select gli lascia leggere la propria riga, quindi si risolve.
-- Senza login auth.uid() e' null, la sottoquery non da' nulla e il confronto
-- e' falso: non si vede niente.
--
-- La edge function usa la service role, che ignora RLS: continua a leggere
-- tutte le righe per spedire i promemoria.

drop policy if exists "Utenti possono gestire la propria subscription" on push_subscriptions;

create policy "Ognuno gestisce solo la propria riga"
  on push_subscriptions for all
  to authenticated
  using      (user_id = (select username from profiles where id = auth.uid()))
  with check (user_id = (select username from profiles where id = auth.uid()));
