# Regole di lavoro su Awakening

## 1. Gli esercizi seguono la ricerca, non il buon senso

Ogni modifica che tocca esercizi, carichi, serie, ripetizioni, recuperi,
progressioni o deload deve poggiare su uno studio reale. Nel commento accanto al
codice e nel messaggio di commit va citata la fonte: autore, anno, e cosa dice.

Le fonti gia' usate nell'app, da preferire quando coprono il caso:
ACSM Position Stand 2009 (intensita' e volume), Baechle & Earle — NSCA
Essentials, 3a ed. 2008 (regola 2-per-2, incrementi 2-10%, test xRM),
Schoenfeld 2016 e Grgic 2018 (recuperi), Bosquet et al. 2007 e Mujika &
Padilla 2003 (taper e deload), Simao et al. 2012 (ordine degli esercizi),
Epley 1985 (conversione fra basi di ripetizioni), Wendler 5/3/1 (training max).

Se per una modifica non esiste una fonte, dirlo invece di inventare un numero:
meglio lasciare il comportamento attuale che introdurne uno arbitrario.

## 2. Prima di modificare, allineare il file

Il lavoro parte sempre dalla versione piu' recente: `git fetch origin main` e
confronto con `origin/main` prima di toccare `index.html`. L'app viene
pubblicata da GitHub Pages a partire da `main`, quindi una modifica fatta su una
copia vecchia si perde o sovrascrive il lavoro gia' online.

Ogni rilascio bumpa insieme `APP_VERSION` in `index.html` e `CACHE_NAME` in
`sw.js`: sono lo stesso numero. Se si muove solo uno dei due, il telefono resta
sulla versione vecchia o il profilo dichiara una versione che non e' quella
installata.

## 3. Rispondere con il risultato, non con la cronaca

Nella risposta va cosa e' cambiato per chi usa l'app, in linguaggio non tecnico:
cosa fa adesso, cosa faceva prima, cosa va provato. Niente elenco dei passaggi,
dei file aperti o dei comandi eseguiti. I dettagli tecnici vivono nei commenti
del codice e nei messaggi di commit, che restano completi.

Le cose da segnalare comunque, in breve: quello che non ha funzionato, le
scelte che l'utente potrebbe volere diverse, e i limiti noti (per esempio cosa
non funziona a schermo bloccato).
