import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const DAYS = ["Lunedì","Martedì","Mercoledì","Giovedì","Venerdì","Sabato","Domenica"];
const CHAPTERS = ["Activation (Sett. 1)","Momentum (Sett. 2)","Breakthrough (Sett. 3)","Mastery (Sett. 4)"];

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
// I tetti di max_tokens sono quelli che l'app chiedeva gia' per ogni tipo.
const TIPI: Record<string, { maxTokens: number; maxChars: number; immagini: number }> = {
  chat:   { maxTokens: 2000, maxChars: 6000,  immagini: 0 },  // una domanda in chat
  scheda: { maxTokens: 1500, maxChars: 60000, immagini: 0 },  // analisi della scheda (porta il catalogo esercizi)
  foto:   { maxTokens: 600,  maxChars: 6000,  immagini: 1 },  // foto del pasto
};
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
    const { messages, max_tokens, user_jwt, schedule_context } = body;

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
        const cosa = tipo === "chat" ? `i ${q.limite} messaggi` : tipo === "scheda" ? `le ${q.limite} analisi delle schede` : `le ${q.limite} foto dei pasti`;
        return errore("quota", `Hai usato ${cosa} di oggi. Si ricaricano a mezzanotte.`, 429, { _quota: quota });
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
              ? p.exercises_json.map((e: any) => `    • ${e.name}: ${e.sr} serie, ${e.baseWeight}kg`).join("\n")
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
          lines.push(`📅 ${CHAPTERS[w]}${chapterDone} — ${7 - restDays} allenamenti, ${restDays} rest day\n${dayLines.join("\n")}`);
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

I giorni sono 0=Lunedì, 1=Martedì, 2=Mercoledì, 3=Giovedì, 4=Venerdì, 5=Sabato, 6=Domenica. Il chapter è 0-indexed (0=Activation, 1=Momentum, 2=Breakthrough, 3=Mastery). Usa il chapter attivo indicato nel contesto. Includi SOLO gli esercizi che modifichi per exercise_edit.

Oppure, per replicare la schedulazione di un chapter in un altro (stessi protocolli, stessi giorni, senza creare duplicati):

<ai_modifications>
{
  "type": "assign_chapter",
  "from_chapter": 1,
  "to_chapter": 2,
  "description": "Replica schedulazione Momentum in Breakthrough"
}
</ai_modifications>

Usa assign_chapter quando l'utente vuole replicare/copiare la schedulazione da un chapter a un altro. NON crea protocolli nuovi — assegna gli stessi protocolli esistenti agli stessi giorni nel chapter di destinazione.

PROGRESSIONE CARICHI: L'app calcola automaticamente i carichi per chapter usando moltiplicatori sul baseWeight:
- Chapter 1 (Activation): 70% — Chapter 2 (Momentum): 80% — Chapter 3 (Breakthrough): 90% — Chapter 4 (Integration): 60% (deload)
Gli stessi protocolli mostrano carichi diversi in chapter diversi — la progressione è automatica.${protocolsContext}${scheduleContext}`;

    const tetto = Math.max(1, Math.min(Number(max_tokens) || regole.maxTokens, regole.maxTokens));
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
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: tetto,
          system: systemPrompt,
          messages,
        }),
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
