import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// v.324 — La Posta del Coach alle 22:00, ora italiana.
//
// La chiama posta_sera_avvia (job "posta-sera", migrations/20261101f), una
// volta per utente. Sceglie il messaggio della sera come l'app:
//   - dal lunedi' al sabato il resoconto del giorno ('resoconto');
//   - la domenica quello della settimana ('settimana'), al posto del giorno;
//   - ogni quarta domenica quello del mese ('mese'). Le settimane si contano
//     dal lunedi' della settimana del primo allenamento, come postaSettimanaN
//     in index.html.
// I dati sono quelli che l'app carica in coach_dati quando salva (gli stessi
// che prima mandava il pulsante). Il testo lo scrive ai-coach, con gli stessi
// prompt, limiti e restituzione dell'uso di prima. Poi il messaggio va nella
// tabella posta e parte una notifica (push-notify, modo "utente").
//
// Se l'app oggi non ha mandato dati (non e' stata aperta, o non ha
// registrato niente), il resoconto del giorno non passa dall'AI: arriva un
// messaggio breve che lo dice, senza inventare. Un messaggio per tipo e per
// giorno (unique su posta): una seconda chiamata nella stessa sera non
// scrive niente.
//
// Con { prova: true } scrive il testo e lo restituisce senza salvarlo ne'
// notificarlo: serve a provare la funzione senza toccare la Posta vera
// (con dati_prova, anche senza leggere coach_dati).

function ruolo(req: Request): string | null {
  try {
    const t = (req.headers.get("authorization") ?? "").split(" ")[1] ?? "";
    let p = t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    p += "=".repeat((4 - (p.length % 4)) % 4);
    return JSON.parse(atob(p)).role ?? null;
  } catch (_) { return null; }
}

function rispondi(o: unknown, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
}

// Data e giorno della settimana a Roma (0 = domenica).
function roma(now: Date): { iso: string; dow: number } {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(now);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  const giorni: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { iso: `${g("year")}-${g("month")}-${g("day")}`, dow: giorni[g("weekday")] ?? new Date(`${g("year")}-${g("month")}-${g("day")}T12:00:00Z`).getUTCDay() };
}
function giornoUtc(iso: string): Date { return new Date(iso + "T12:00:00Z"); }
function isoDi(d: Date): string { return d.toISOString().slice(0, 10); }
function lunedi(iso: string): string {
  const d = giornoUtc(iso);
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return isoDi(d);
}
function settimanaN(oggi: string, primo: string | null): number {
  const inizio = (primo && /^\d{4}-\d{2}-\d{2}$/.test(primo) && primo <= oggi) ? primo : oggi;
  return Math.round((giornoUtc(lunedi(oggi)).getTime() - giornoUtc(lunedi(inizio)).getTime()) / (7 * 86400000)) + 1;
}
function etichetta(iso: string): string {
  return giornoUtc(iso).toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
}

const RICHIESTA: Record<string, string> = {
  resoconto: "Scrivi il resoconto di oggi.",
  settimana: "Scrivi il resoconto della mia settimana.",
  mese: "Scrivi il resoconto del mio mese.",
};
const NOTIFICA: Record<string, string> = {
  resoconto: "Il resoconto di oggi è nella tua Posta.",
  settimana: "Il resoconto della settimana è nella tua Posta.",
  mese: "Il resoconto del mese è nella tua Posta.",
};

Deno.serve(async (req) => {
  if (ruolo(req) !== "service_role") return rispondi({ error: "vietato" }, 403);
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const userId = typeof body.user_id === "string" && /^[0-9a-f-]{36}$/i.test(body.user_id) ? body.user_id : null;
  if (!userId) return rispondi({ error: "user_id" }, 400);
  const prova = body.prova === true;

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const chiave = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const sb = createClient(url, chiave);

  const { iso: oggi, dow } = roma(new Date());
  // In prova si possono passare dati finti (dati_prova), per non toccare
  // coach_dati di un utente vero.
  let dati: Record<string, any> | null = null;
  if (prova && body.dati_prova && typeof body.dati_prova === "object") dati = body.dati_prova as Record<string, any>;
  else {
    const { data: riga } = await sb.from("coach_dati").select("dati, aggiornato").eq("user_id", userId).maybeSingle();
    dati = (riga?.dati as Record<string, any>) ?? null;
  }
  if (!dati) return rispondi({ saltato: "nessun dato dall'app" });

  let tipo = dow === 0 ? (settimanaN(oggi, dati.primo_allenamento ?? null) % 4 === 0 ? "mese" : "settimana") : "resoconto";
  if (typeof body.tipo_prova === "string" && prova && RICHIESTA[body.tipo_prova]) tipo = body.tipo_prova;

  if (!prova) {
    const { data: gia } = await sb.from("posta").select("id").eq("user_id", userId).eq("giorno", oggi).eq("tipo", tipo).maybeSingle();
    if (gia) return rispondi({ saltato: "gia' inviato", tipo });
  }

  // I dati validi per stasera: la giornata solo se e' di oggi, la settimana
  // se parte da questo lunedi', il mese se e' stato calcolato in questa
  // settimana (altrimenti si ripiega sulla settimana).
  const lun = lunedi(oggi);
  let set: Record<string, any> | null = null;
  if (tipo === "resoconto" && dati.giorno?.data === oggi) set = dati.giorno;
  if (tipo === "mese") {
    if (dati.mese?.periodo?.al >= lun) set = dati.mese;
    else if (dati.settimana?.periodo?.dal === lun) { tipo = "settimana"; set = dati.settimana; }
  }
  if (tipo === "settimana" && !set && dati.settimana?.periodo?.dal === lun) set = dati.settimana;
  if (set && tipo !== "resoconto") set = { ...set, dati_aggiornati_al: set.periodo?.al ?? null, oggi };

  const nome = String(dati.giorno?.profilo?.nome ?? "").trim();
  const ciao = nome ? `Ciao ${nome}` : "Ciao";
  let titolo: string, testo: string;

  if (!set) {
    // Niente dati di oggi (o di questa settimana): un messaggio breve e vero.
    titolo = tipo === "resoconto" ? `Il resoconto di ${etichetta(oggi)}`
      : tipo === "mese" ? "Il tuo mese" : "La tua settimana";
    testo = tipo === "resoconto"
      ? `👋 ${ciao}, oggi l'app non mi ha mandato niente: nessun allenamento, pasto o bicchiere d'acqua registrato.\n\n🎯 PER DOMANI\n• Registra pasti e acqua mentre la giornata va avanti: alle 22 ti scrivo com'è andata.\n• Se è giorno di allenamento, segna la seduta nella pagina Allenamento.`
      : `👋 ${ciao}, questa settimana l'app non mi ha mandato dati: nessun allenamento, pasto o bicchiere d'acqua registrato.\n\n🎯 LA PROSSIMA SETTIMANA\n• Apri l'app ogni giorno e registra pasti, acqua e sedute: la domenica sera ti scrivo com'è andata la settimana.`;
  } else {
    const chiedi = async () => fetch(`${url}/functions/v1/ai-coach`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${chiave}`, "apikey": chiave },
      body: JSON.stringify({
        tipo, user_id: userId,
        messages: [{ role: "user", content: `${RICHIESTA[tipo]} I miei dati in JSON:\n${JSON.stringify(set)}` }],
        schedule_context: Array.isArray(dati.capitoli) ? { programma: { capitoli: dati.capitoli } } : undefined,
      }),
    });
    let r = await chiedi();
    // Un secondo tentativo se l'AI e' sovraccarica o non risponde: di sera
    // non c'e' nessuno che possa premere "riprova".
    if (r.status >= 500) { await new Promise((x) => setTimeout(x, 8000)); r = await chiedi(); }
    const out = await r.json().catch(() => null) as any;
    const scritto = ((out?.content ?? []) as any[]).map((b) => b?.text ?? "").join("").trim();
    if (!r.ok || !scritto) {
      console.error("[posta-sera]", userId, tipo, r.status, JSON.stringify(out?.error ?? out).slice(0, 300));
      return rispondi({ errore: "ai-coach", status: r.status, tipo }, 502);
    }
    testo = scritto;
    titolo = tipo === "mese" ? `Il tuo mese, ${set.periodo?.etichetta ?? ""}`
      : tipo === "settimana" ? `La tua settimana, ${set.periodo?.etichetta ?? ""}`
      : `Il resoconto di ${set.giorno ?? etichetta(oggi)}`;
  }

  // Le pesate per il grafico, calcolate dall'app per ogni tipo.
  const peso = dati.peso?.[tipo];
  const extra: Record<string, unknown> = {};
  if (peso && Array.isArray(peso.serie) && peso.serie.length >= 2) {
    extra.peso = peso.serie;
    extra.pesoEtichetta = peso.etichetta ?? "";
    if (typeof dati.peso_obiettivo === "number") extra.pesoObiettivo = dati.peso_obiettivo;
  }

  if (prova) return rispondi({ prova: true, tipo, titolo, testo, extra, dati_validi: !!set });

  const { error: insErr } = await sb.from("posta").insert({
    user_id: userId, giorno: oggi, tipo, da: "Coach AI", titolo, testo, extra: Object.keys(extra).length ? extra : null,
  });
  if (insErr) {
    // 23505 = gia' inviato da una chiamata contemporanea
    if ((insErr as any).code === "23505") return rispondi({ saltato: "gia' inviato", tipo });
    console.error("[posta-sera] insert", userId, insErr.message);
    return rispondi({ errore: insErr.message }, 500);
  }

  // Notifica: push_subscriptions usa lo username, non l'id.
  let notifica: unknown = null;
  try {
    const { data: prof } = await sb.from("profiles").select("username").eq("id", userId).maybeSingle();
    if (prof?.username) {
      const n = await fetch(`${url}/functions/v1/push-notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": req.headers.get("authorization") ?? "" },
        body: JSON.stringify({ mode: "utente", user_id: prof.username, title: "✨ Il tuo Coach ti ha scritto", body: NOTIFICA[tipo], tag: `awakening-posta-${oggi}` }),
      });
      notifica = await n.json().catch(() => n.status);
    }
  } catch (e) { notifica = String(e); }

  return rispondi({ inviato: true, tipo, titolo, notifica });
});
