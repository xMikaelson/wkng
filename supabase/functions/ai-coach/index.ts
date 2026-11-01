import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const DAYS = ["Lunedì","Martedì","Mercoledì","Giovedì","Venerdì","Sabato","Domenica"];
// Capitoli del programma e percentuale del carico di riferimento in ognuno.
// Dal 1/11/2026 li manda l'app (schedule_context.programma, letti da
// CHAPTER_NAMES e WEEK_LOADS in index.html): qui restano solo come ripiego
// per le versioni dell'app che non li mandano. Prima erano scritti a mano e
// fermi al programma vecchio (4 capitoli, 70/80/90/60%), e la quinta
// settimana arrivava al Coach come "undefined". Il testo che li spiega al
// Coach (system prompt, "IL PROGRAMMA DELL'APP") descrive cio' che l'app gia'
// fa, con le fonti scritte accanto al codice dell'app: scala MTR_LADDER e
// periodizzazione lineare (ACSM 2009), scarico con carico vicino al picco e
// volume dimezzato (Bosquet et al. 2007; Mujika & Padilla 2003), aumento con
// la regola 2-per-2 (Baechle & Earle, NSCA 2008). Nessun numero nuovo.
const CAPITOLI_RIPIEGO = [
  { nome: "Activation", carico: 85 }, { nome: "Momentum", carico: 89 }, { nome: "The Peak", carico: 93 },
  { nome: "Overload", carico: 97 }, { nome: "Deload", carico: 90, deload: true },
];
type Capitolo = { nome: string; carico: number; deload?: boolean };
function leggiCapitoli(sc: any): Capitolo[] {
  const c = sc && sc.programma && sc.programma.capitoli;
  if (!Array.isArray(c) || !c.length || c.length > 8) return CAPITOLI_RIPIEGO;
  const ok = c.every((x: any) => x && typeof x.nome === "string" && x.nome.length <= 40 &&
    typeof x.carico === "number" && x.carico > 0 && x.carico <= 150);
  return ok ? c.map((x: any) => ({ nome: x.nome, carico: Math.round(x.carico), deload: !!x.deload })) : CAPITOLI_RIPIEGO;
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ── v.316: chi puo' usare l'AI e quanto ──────────────────────
// Prima la funzione rispondeva a chiunque conoscesse l'indirizzo, senza
// account, e accettava richieste di qualsiasi lunghezza: ogni chiamata la
// pagava il progetto. Ora:
//  - serve il token di un account (user_jwt nel corpo, o Authorization);
//  - ogni richiesta dichiara il suo tipo e ha i suoi tetti (risposta,
//    lunghezza del testo, immagini);
//  - l'uso si conta su Supabase (ai_consuma, migrations/20261101) con i
//    limiti al giorno per piano: free, pro, dev. Se l'AI non risponde l'uso
//    viene restituito (ai_restituisci).
//
// ── Modello: Claude Haiku 5.5 (dal 1/11/2026) ──────────────
// Confronto del 1/11/2026 sulle richieste vere dell'app (3 domande in chat,
// analisi di una scheda FORGE, foto di una pizza margherita), Haiku 4.5
// contro Haiku 5.5 con le stesse istruzioni:
//  - costo per richiesta da 5 a 8 volte piu' basso (listino 0,10 $ / 0,50 $
//    per milione di token in entrata / uscita, contro 1 $ / 5 $), e
//    risposte piu' rapide in chat e nella scheda;
//  - la foto del pasto con Haiku 4.5 veniva RIFIUTATA ("Non posso aiutarti,
//    sono un coach di fitness"): le arrivava il system prompt della chat,
//    che dice di rispondere solo su allenamento. Ora foto e scheda partono
//    senza: il loro testo contiene gia' tutte le istruzioni;
//  - Haiku 5.5 ragiona prima di rispondere e quel ragionamento conta nel
//    tetto max_tokens: con i tetti di prima (600 la foto, 1500 la scheda)
//    la risposta restava a meta' o vuota. Il tetto lo decide il server per
//    tipo, non piu' l'app;
//  - nella scheda, con il ragionamento acceso il modello aggiungeva uno
//    squat a una seduta Upper (il prompt dell'app la dichiara "Full Body"):
//    li' il ragionamento e' spento, come faceva Haiku 4.5, e le regole
//    del prompt (niente minuti di recupero, serie invariate) sono rispettate
//    meglio. Chat e foto lo tengono a sforzo "low": nella foto separa meglio
//    i componenti del piatto (impasto, pomodoro, mozzarella) invece di
//    contare due volte la mozzarella.
const MODELLO = "claude-haiku-5-5";
// v.319 — 'resoconto': il messaggio serale del personal coach nella Posta.
// Ha un system prompt suo (promptResoconto) e sforzo "medium": deve
// incrociare allenamento, pasti, acqua e peso in un testo solo, ed e' una
// richiesta al giorno per persona, quindi il costo resta basso. Prova del
// 1/11/2026 su una giornata piena (seduta, 6 alimenti, acqua, peso): ~2.900
// token in entrata e ~3.700 in uscita, di cui ~2.700 di ragionamento, circa
// 0,2 centesimi; 17 secondi. Il tetto e' 8000 perche' il ragionamento cresce
// con i dati della giornata e un tetto stretto lascia il messaggio a meta'.
const TIPI: Record<string, { maxTokens: number; maxChars: number; immagini: number; pensiero: boolean; sistema: boolean; effort: string }> = {
  chat:      { maxTokens: 3000, maxChars: 6000,  immagini: 0, pensiero: true,  sistema: true,  effort: "low" },     // una domanda in chat
  scheda:    { maxTokens: 1500, maxChars: 60000, immagini: 0, pensiero: false, sistema: false, effort: "low" },     // analisi della scheda (porta il catalogo esercizi)
  foto:      { maxTokens: 3000, maxChars: 6000,  immagini: 1, pensiero: true,  sistema: false, effort: "low" },     // foto del pasto
  resoconto: { maxTokens: 8000, maxChars: 24000, immagini: 0, pensiero: true,  sistema: true,  effort: "medium" },  // resoconto della giornata (dati in JSON)
  settimana: { maxTokens: 10000, maxChars: 30000, immagini: 0, pensiero: true, sistema: true,  effort: "medium" },  // resoconto della settimana (v.320)
  mese:      { maxTokens: 12000, maxChars: 40000, immagini: 0, pensiero: true, sistema: true,  effort: "medium" },  // resoconto del mese (v.321)
};

// Istruzioni del resoconto serale. I dati arrivano dall'app in JSON e sono
// gli unici che il Coach puo' usare: niente pasti, numeri o sedute inventati.
// Carichi e serie restano del programma: il Coach non li cambia.
function promptResoconto(capitoli: Capitolo[]): string {
  return `Sei il personal coach di chi usa l'app Awakening. Ogni sera scrivi un messaggio privato nella sua Posta: il resoconto della giornata e come migliorare domani, su allenamento, alimentazione e idratazione, sempre legato al suo percorso dall'inizio.

Ricevi i suoi dati reali in JSON. Usa SOLO quelli: non inventare pasti, allenamenti, pesi o numeri che non ci sono. Se un dato manca (pasti o acqua non registrati, peso non inserito), dillo in una frase come invito a registrarlo, senza rimproverare. Se oggi era giorno di riposo, il riposo fa parte del programma: non trattarlo come un'assenza.

Struttura del messaggio, con questi titoli esatti, ognuno su una riga sua:
👋 Una o due frasi: saluto con il nome e il senso della giornata.
🏋️ ALLENAMENTO
Cosa ha fatto oggi rispetto al programma (o il riposo), ripetizioni e carichi rispetto al previsto quando ci sono, come si e' sentito dal diario. Carichi e ripetizioni si registrano durante la seduta nella pagina Allenamento; il diario e' la sensazione a fine seduta. Collega a quanto fatto dall'inizio e nella settimana.
🍽️ ALIMENTAZIONE
Calorie e proteine (poi carboidrati e grassi) rispetto all'obiettivo. Di' cosa mangiare di piu' e cosa di meno nominando gli alimenti che ha registrato davvero: per esempio quale ha alzato zuccheri o grassi saturi, quale gli ha dato proteine. Guarda anche Nutri-Score e prodotti ultra-processati (NOVA 4) se ci sono.
💧 IDRATAZIONE
Bicchieri bevuti rispetto all'obiettivo, e la media della settimana se c'e'.
📈 IL TUO PERCORSO
Una o due tendenze dagli ultimi 7 giorni e dall'inizio: costanza, peso, record.
🎯 PER DOMANI
Da due a quattro azioni concrete, una per riga, che cominciano con "•": l'allenamento previsto domani (nome della scheda) o il riposo, e cosa fare con pasti e acqua.

${regoleCoach(capitoli)}
Massimo 350 parole.`;
}

// v.320 — Il resoconto della settimana: gli ultimi 7 giorni (la domenica,
// lunedi'-domenica), con le medie gia' calcolate dall'app e gli alimenti
// della settimana sommati. Stesse regole del resoconto della sera. Prova del
// 1/11/2026 su una settimana con 3 sedute, 5 giorni di pasti e 6 di acqua:
// ~3.800 token in entrata e ~5.100 in uscita (~3.800 di ragionamento),
// circa 0,3 centesimi, 22 secondi; tetto 10000.
function promptSettimana(capitoli: Capitolo[]): string {
  return `Sei il personal coach di chi usa l'app Awakening. A fine settimana scrivi un messaggio privato nella sua Posta: il resoconto degli ultimi 7 giorni e come migliorare la settimana prossima, su allenamento, alimentazione e idratazione, sempre legato al suo percorso dall'inizio.

Ricevi i suoi dati reali in JSON. Usa SOLO quelli: non inventare pasti, allenamenti, pesi o numeri che non ci sono. Le medie sono gia' calcolate in "medie": usa quelle, non ricalcolarle. La domenica questo messaggio arriva al posto del resoconto della sera: l'ultimo giorno dei dati e' oggi, e in una o due frasi di' anche com'e' andata oggi. Se in alcuni giorni pasti o acqua non sono registrati, dillo una volta come invito a registrarli, senza rimproverare. I giorni di riposo fanno parte del programma: non trattarli come assenze.

Struttura del messaggio, con questi titoli esatti, ognuno su una riga sua:
👋 Una o due frasi: saluto con il nome e il senso della settimana.
🏋️ ALLENAMENTO
Sedute fatte rispetto a quelle del capitolo, come sono andati carichi e ripetizioni negli esercizi principali (non elencarli tutti), record della settimana, sensazioni dal diario. Carichi e ripetizioni si registrano durante la seduta nella pagina Allenamento; il diario e' la sensazione a fine seduta.
🍽️ ALIMENTAZIONE
Medie di calorie e proteine (poi carboidrati e grassi) rispetto all'obiettivo, e in quanti giorni ha registrato i pasti. Da "alimenti_della_settimana" di' cosa mangiare di piu' e cosa di meno nominando gli alimenti che ha registrato davvero, soprattutto quelli che tornano piu' spesso o pesano di piu': quali hanno portato zuccheri o grassi saturi, quali proteine, quali hanno Nutri-Score D o E o sono ultra-processati (NOVA 4).
💧 IDRATAZIONE
Media dei bicchieri rispetto all'obiettivo e in quanti giorni l'ha raggiunto.
📈 IL TUO PERCORSO
Una o due tendenze dall'inizio: costanza, peso (nella settimana e dal primo peso), record.
🎯 LA PROSSIMA SETTIMANA
Da tre a cinque azioni concrete, una per riga, che cominciano con "•": il capitolo e le sedute in programma (da "prossima_settimana"), e un obiettivo preciso per pasti e acqua.

${regoleCoach(capitoli)}
Massimo 450 parole.`;
}

// v.321 — Il resoconto del mese: ogni quarta domenica, al posto di quello
// della settimana. Le 4 settimane una per una (sedute, medie, acqua, peso,
// sensazioni), le medie e gli alimenti del mese, gli esercizi con il primo e
// l'ultimo carico del mese. I pasti arrivano dallo storico dei giorni
// dell'app (35 giorni), non dai pasti completi, che l'app tiene 7 giorni.
// Prova del 1/11/2026 su quattro settimane (11 sedute, 23 giorni di pasti):
// ~3.500 token in entrata e ~5.600 in uscita (~4.000 di ragionamento),
// circa 0,3 centesimi, 24 secondi; tetto 12000.
function promptMese(capitoli: Capitolo[]): string {
  return `Sei il personal coach di chi usa l'app Awakening. Ogni quattro settimane scrivi un messaggio privato nella sua Posta: il resoconto del mese appena chiuso e gli obiettivi del prossimo, su allenamento, alimentazione e idratazione, sempre legato al suo percorso dall'inizio. Questo messaggio arriva la domenica sera al posto del resoconto della settimana.

Ricevi i suoi dati reali in JSON. Usa SOLO quelli: non inventare pasti, allenamenti, pesi o numeri che non ci sono. Le medie sono gia' calcolate ("settimane" e "medie_del_mese"): usa quelle, non ricalcolarle. Se in alcune settimane pasti o acqua non sono registrati, dillo una volta come invito, senza rimproverare. I giorni di riposo fanno parte del programma.

Struttura del messaggio, con questi titoli esatti, ognuno su una riga sua:
👋 Una o due frasi: saluto con il nome e il senso del mese.
🏋️ ALLENAMENTO
Sedute del mese e come si sono distribuite nelle quattro settimane (costanza), progressi negli esercizi principali confrontando il primo e l'ultimo carico del mese, record, sensazioni dal diario.
🍽️ ALIMENTAZIONE
Medie del mese di calorie e proteine (poi carboidrati e grassi) rispetto all'obiettivo e come sono cambiate settimana per settimana. Da "alimenti_del_mese" di' cosa mangiare di piu' e cosa di meno nominando gli alimenti che ha registrato davvero, soprattutto quelli che tornano piu' spesso o pesano di piu': zuccheri, grassi saturi, proteine, Nutri-Score D o E, ultra-processati (NOVA 4).
💧 IDRATAZIONE
Media del mese rispetto all'obiettivo, giorni in cui l'ha raggiunto, e se e' migliorata nelle settimane.
📈 IL TUO PERCORSO
Il peso nel mese e dall'inizio, la costanza, i record: due o tre tendenze.
🎯 IL PROSSIMO MESE
Da tre a cinque obiettivi concreti, uno per riga, che cominciano con "•": il capitolo e le sedute della prossima settimana (da "prossima_settimana"), e obiettivi precisi su pasti e acqua per le prossime quattro settimane.

${regoleCoach(capitoli)}
Massimo 550 parole.`;
}

// Parti comuni ai messaggi della Posta: il programma (descrive cio' che
// l'app gia' fa, fonti accanto a CAPITOLI_RIPIEGO), il tono e i limiti.
function regoleCoach(capitoli: Capitolo[]): string {
  return `Il programma dell'app, per capire i dati: un ciclo di ${capitoli.length} capitoli, uno per settimana (${capitoli.map((c) => `${c.nome} ${c.carico}%` + (c.deload ? " con meta' delle serie" : "")).join(", ")} del carico di riferimento). Carichi, serie e ripetizioni li decide il programma: non proporre di cambiarli, al massimo ricorda la regola 2-per-2 (due sedute di fila con almeno due ripetizioni in piu' nell'ultima serie fanno salire il carico).

Sotto il titolo 📈 IL TUO PERCORSO l'app mostra il grafico del peso: commenta la tendenza in una o due frasi, senza elencare tutte le pesate.

Tono: un personal coach che lo segue da vicino. Dagli del tu, frasi brevi e concrete, caldo ma diretto; usa il maschile o il femminile come indicato nei dati. Grassetto solo con **due asterischi** e con misura; niente tabelle.
Limiti: non fare diagnosi, non consigliare farmaci o integratori, non proporre diete estreme o digiuni. Se le calorie sono molto sotto l'obiettivo, invita a non scendere troppo. Non citare studi o percentuali che non sono nei dati.`;
}
const MAX_MESSAGGI = 12;
const MAX_IMG_B64 = 7_000_000;   // circa 5 MB di immagine: il limite dell'API
const MAX_CONTESTO = 60000;      // caratteri dello schedule_context della chat

function rispondi(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
function errore(type: string, message: string, status: number, extra: Record<string, unknown> = {}) {
  return rispondi({ error: { type, message }, ...extra }, status);
}

// Controlla forma e misura dei messaggi prima di contare l'uso: una
// richiesta sbagliata non deve consumare un messaggio dell'utente.
function controllaMessaggi(messages: any, regole: { maxChars: number; immagini: number }): string | null {
  if (!Array.isArray(messages) || !messages.length || messages.length > MAX_MESSAGGI) return "Richiesta non valida.";
  let chars = 0, img = 0;
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) return "Richiesta non valida.";
    if (typeof m.content === "string") { chars += m.content.length; continue; }
    if (!Array.isArray(m.content)) return "Richiesta non valida.";
    for (const b of m.content) {
      if (b && b.type === "text" && typeof b.text === "string") chars += b.text.length;
      else if (b && b.type === "image" && b.source && b.source.type === "base64" && typeof b.source.data === "string") {
        img++;
        if (b.source.data.length > MAX_IMG_B64) return "Foto troppo grande: riprova con una foto più leggera.";
      } else return "Richiesta non valida.";
    }
  }
  if (img > regole.immagini) return "Richiesta non valida.";
  if (chars > regole.maxChars) return "Testo troppo lungo: accorcia la domanda e riprova.";
  return null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: corsHeaders });

  try {
    const body = await req.json();
    const { messages, user_jwt, schedule_context } = body;

    // Chi non dichiara il tipo e' una versione dell'app di prima: allora
    // l'unica chiamata con l'account era la chat.
    const tipo = typeof body.tipo === "string" ? body.tipo : "chat";
    const regole = TIPI[tipo];
    if (!regole) return errore("richiesta", "Richiesta non valida.", 400);
    const problema = controllaMessaggi(messages, regole);
    if (problema) return errore("richiesta", problema, 400);
    if (schedule_context && JSON.stringify(schedule_context).length > MAX_CONTESTO) {
      return errore("richiesta", "Richiesta non valida.", 400);
    }

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "API key not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const sb = createClient(supabaseUrl, supabaseKey);

    // ── Account ──────────────────────────────────────────────
    // La chiave pubblica dell'app (anon) non e' un account: getUser la rifiuta.
    const auth = req.headers.get("authorization") ?? "";
    const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    const jwt = (typeof user_jwt === "string" && user_jwt) ? user_jwt : bearer;
    let user: any = null;
    if (jwt) {
      try { const { data } = await sb.auth.getUser(jwt); user = data?.user ?? null; } catch (_) { user = null; }
    }
    if (!user) {
      return errore("login", "Per usare il Coach serve un account: accedi dal Profilo e riprova.", 401);
    }

    // ── Limite del giorno ────────────────────────────────────
    // Se il conteggio non risponde non si chiama l'AI: meglio un Coach
    // fermo per qualche minuto che una spesa senza controllo.
    const { data: q, error: qErr } = await sb.rpc("ai_consuma", { p_user: user.id, p_tipo: tipo });
    if (qErr || !q) {
      console.error("ai_consuma:", qErr?.message ?? "nessuna risposta");
      return errore("server", "Il Coach non è disponibile in questo momento: riprova tra poco.", 503);
    }
    const quota = { tipo, piano: q.piano ?? null, limite: q.limite ?? null, usati: q.usati ?? null };
    if (!q.ok) {
      if (q.motivo === "limite") {
        const cosa = tipo === "chat" ? `i ${q.limite} messaggi` : tipo === "scheda" ? `le ${q.limite} analisi delle schede`
          : tipo === "resoconto" ? (q.limite === 1 ? "il resoconto" : `i ${q.limite} resoconti`)
          : tipo === "settimana" ? (q.limite === 1 ? "il resoconto della settimana" : `i ${q.limite} resoconti della settimana`)
          : tipo === "mese" ? (q.limite === 1 ? "il resoconto del mese" : `i ${q.limite} resoconti del mese`) : `le ${q.limite} foto dei pasti`;
        return errore("quota", `Hai usato ${cosa} di oggi. ${q.limite === 1 ? "Si ricarica" : "Si ricaricano"} a mezzanotte.`, 429, { _quota: quota });
      }
      if (q.motivo === "pausa") {
        return errore("pausa", "Il Coach gratuito ha raggiunto il limite di oggi per tutti gli utenti. Riprova domani.", 503);
      }
      return errore("richiesta", "Richiesta non valida.", 400);
    }
    const restituisci = async () => {
      try { await sb.rpc("ai_restituisci", { p_user: user.id, p_tipo: tipo }); } catch (_) { /* resta contato */ }
    };

    // ── Fetch protocols from Supabase ──────────────────────────
    // Solo per la chat, come prima: le altre chiamate portano gia' nel
    // testo cio' che serve.
    let protocolsContext = "";
    let userProtocols: any[] = [];

    if (tipo === "chat") {
      try {
        const { data: protocols } = await sb
          .from("protocols")
          .select("id, name, goal, exercises_json")
          .eq("user_id", user.id);
        if (protocols?.length) {
          userProtocols = protocols;
          const summary = protocols.map((p: any) => {
            const exs = Array.isArray(p.exercises_json)
              ? p.exercises_json.map((e: any) => `    • ${e.name}: ${e.sr}, ` + (Number(e.baseWeight) > 0 ? `riferimento ${e.baseWeight} kg` : "a corpo libero")).join("\n")
              : "    nessun esercizio";
            return `📋 "${p.name}" [${p.goal}]\n${exs}`;
          }).join("\n\n");
          protocolsContext = `\n\n━━ PROTOCOLLI CREATI ━━\n${summary}`;
        }
      } catch (e) {
        console.warn("Could not fetch protocols:", (e as Error).message);
      }
    }

    // ── Build schedule context ─────────────────────────────────
    const capitoli = leggiCapitoli(schedule_context);
    let scheduleContext = "";
    if (schedule_context) {
      const { dayAssignments, chipStates, completedWeeks, personalRecords, totalWorkouts, startDate } = schedule_context;

      // Today info
      const today = schedule_context.today;
      if (today) {
        const todayProto = today.todayAssignment ? `"${today.todayAssignment.protoName}"` : 'rest day';
        scheduleContext += `\n\n━━ OGGI ━━\n    Data: ${today.date}\n    Chapter attivo: ${today.activeChapterName} (settimana ${today.activeChapter + 1})\n    Allenamento di oggi: ${todayProto}`;
      }

      if (dayAssignments) {
        const lines: string[] = [];
        dayAssignments.forEach((week: any[], w: number) => {
          const isActive = w === today?.activeChapter;
          const chapterDone = completedWeeks?.[w] ? " ✓ completata" : (isActive ? " ← CHAPTER CORRENTE" : " (non ancora iniziata)");
          const dayLines = week.map((assignment: any, d: number) => {
            const chipState = chipStates?.[w]?.[d];
            const isToday = isActive && d === today?.dayIndex;
            const status = chipState === 'done' ? '✓ completato' : chipState === 'rest' ? 'riposo' : 'programmato';
            const proto = assignment ? `"${assignment.protoName}"` : 'rest day';
            const todayMark = isToday ? ' ← OGGI' : '';
            return `    ${DAYS[d]}: ${proto} [${status}]${todayMark}`;
          });
          const restDays = week.filter((a: any) => !a).length;
          const nomeCap = capitoli[w] ? capitoli[w].nome : `Capitolo ${w + 1}`;
          lines.push(`📅 ${nomeCap} (Sett. ${w + 1})${chapterDone} — ${7 - restDays} allenamenti, ${restDays} rest day\n${dayLines.join("\n")}`);
        });
        scheduleContext += `\n\n━━ PROGRAMMAZIONE SETTIMANALE ━━\n${lines.join("\n\n")}`;
      }

      if (personalRecords && Object.keys(personalRecords).length > 0) {
        const prs = Object.entries(personalRecords)
          .map(([name, kg]) => `    • ${name}: ${kg}kg`)
          .join("\n");
        scheduleContext += `\n\n━━ PERSONAL RECORDS ━━\n${prs}`;
      }

      if (totalWorkouts) {
        scheduleContext += `\n\n━━ STATISTICHE ━━\n    Allenamenti completati: ${totalWorkouts}`;
        if (startDate) {
          const days = Math.floor((Date.now() - new Date(startDate).getTime()) / 86400000);
          scheduleContext += `\n    Giorni dall'inizio: ${days}`;
        }
      }
    }

    // ── System prompt ──────────────────────────────────────────
    const systemPrompt = `Sei un coach di fitness esperto integrato nell'app Awakening. Rispondi sempre in italiano, in modo conciso e pratico. Sei specializzato in allenamento con i pesi, ipertrofia, forza, recupero muscolare, nutrizione sportiva e supplementazione. Usa un tono diretto, motivante e professionale. Se la domanda non riguarda fitness, allenamento, nutrizione o benessere fisico, rispondi educatamente che puoi aiutare solo su questi argomenti.

Hai accesso completo al programma dell'utente: protocolli creati, distribuzione settimanale degli allenamenti, rest day, personal records e statistiche. Usa queste informazioni per dare consigli personalizzati e contestuali.

IMPORTANTE — MODIFICHE AI PROTOCOLLI: Quando suggerisci modifiche concrete a esercizi, serie o carichi, aggiungi in fondo alla risposta un blocco nel formato esatto seguente (SOLO se hai una modifica applicabile):

<ai_modifications>
{
  "type": "exercise_edit",
  "protocol_id": "ID_DEL_PROTOCOLLO",
  "protocol_name": "NOME_DEL_PROTOCOLLO",
  "description": "Breve descrizione delle modifiche",
  "exercises": [
    { "name": "Nome Esercizio", "sr": "4x8", "baseWeight": 80 }
  ]
}
</ai_modifications>

Oppure, per scambiare due giorni della settimana nel chapter corrente:

<ai_modifications>
{
  "type": "swap_days",
  "chapter": 1,
  "day_a": 1,
  "day_b": 2,
  "description": "Scambio Martedì con Mercoledì nel chapter 2"
}
</ai_modifications>

I giorni sono 0=Lunedì, 1=Martedì, 2=Mercoledì, 3=Giovedì, 4=Venerdì, 5=Sabato, 6=Domenica. Il chapter è 0-indexed (${capitoli.map((c, i) => i + "=" + c.nome).join(", ")}). Usa il chapter attivo indicato nel contesto. Includi SOLO gli esercizi che modifichi per exercise_edit.

Oppure, per replicare la schedulazione di un chapter in un altro (stessi protocolli, stessi giorni, senza creare duplicati):

<ai_modifications>
{
  "type": "assign_chapter",
  "from_chapter": 1,
  "to_chapter": 2,
  "description": "Replica schedulazione Momentum in The Peak"
}
</ai_modifications>

Usa assign_chapter quando l'utente vuole replicare/copiare la schedulazione da un chapter a un altro. NON crea protocolli nuovi — assegna gli stessi protocolli esistenti agli stessi giorni nel chapter di destinazione.

IL PROGRAMMA DELL'APP: un ciclo di ${capitoli.length} capitoli, uno per settimana.
${capitoli.map((c, i) => `- Capitolo ${i + 1} · ${c.nome}: ${c.carico}% del carico di riferimento` + (c.deload ? ", con metà delle serie (scarico)" : "")).join("\n")}
Il carico di riferimento di ogni esercizio (baseWeight nei protocolli) è il suo MTR, il massimo tecnico: il peso più alto che l'atleta solleva con tecnica pulita per le ripetizioni previste. In ogni capitolo l'app usa la percentuale qui sopra di quel riferimento, quindi il peso della seduta non è il baseWeight: lo mostra l'app nella pagina Allenamento.
Con i pesi le ripetizioni scendono da un capitolo all'altro mentre il carico sale; nello scarico il carico resta vicino al picco e le serie si dimezzano. A corpo libero salgono le ripetizioni e poi si passa alla variante più difficile.
Il carico sale da solo con la regola 2-per-2: quando l'atleta chiude almeno due ripetizioni in più nell'ultima serie per due sedute di fila, l'app propone di alzarlo.
Non inventare percentuali, scale di carico o capitoli diversi da questi. In exercise_edit, baseWeight è il carico di riferimento, non quello del capitolo.${protocolsContext}${scheduleContext}`;

    const tetto = regole.maxTokens;
    const corpo: Record<string, unknown> = {
      model: MODELLO,
      max_tokens: tetto,
      messages,
      output_config: { effort: regole.effort },
    };
    if (regole.sistema) corpo.system = tipo === "resoconto" ? promptResoconto(capitoli) : tipo === "settimana" ? promptSettimana(capitoli)
      : tipo === "mese" ? promptMese(capitoli) : systemPrompt;
    if (!regole.pensiero) corpo.thinking = { type: "disabled" };
    let response: Response;
    let data: any;
    try {
      response = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(corpo),
      });
      data = await response.json();
    } catch (e) {
      await restituisci();
      throw e;
    }
    if (!response.ok) {
      await restituisci();
      return rispondi(data, response.status);
    }
    // L'app legge il primo blocco come testo: i blocchi di ragionamento
    // (vuoti, Haiku 5.5 non ne restituisce il contenuto) si tolgono qui.
    data.content = (data.content ?? []).filter((b: any) => b && b.type === "text");
    if (data.stop_reason === "refusal") {
      await restituisci();
      return errore("richiesta", "Il Coach non può rispondere a questa richiesta: prova a riformularla.", 422);
    }
    if (!data.content.some((b: any) => b.text && b.text.trim())) {
      await restituisci();
      return errore("server", "Il Coach non ha completato la risposta: riprova.", 502);
    }
    if (data.content?.[0]?.text) {
      data._protocols = userProtocols.map((p: any) => ({ id: p.id, name: p.name }));
    }
    data._quota = quota;

    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("Edge function error:", (err as Error).message);
    return new Response(JSON.stringify({ error: "Internal error", detail: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
