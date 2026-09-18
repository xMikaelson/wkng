import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Utils ──────────────────────────────────────────────────────────────────

function b64uToBytes(b64u: string): Uint8Array {
  const b64 = b64u.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.padEnd(b64.length + (4 - b64.length % 4) % 4, "=");
  return Uint8Array.from(atob(pad), c => c.charCodeAt(0));
}

function bytesToB64u(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function b64uEncodeObj(obj: object): string {
  return btoa(JSON.stringify(obj))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

// ── VAPID JWT ──────────────────────────────────────────────────────────────

async function importVapidPrivateKey(privB64u: string, pubB64u: string): Promise<CryptoKey> {
  // x e y dal punto non compresso (65 bytes: 0x04 + 32 + 32)
  const pubBytes = b64uToBytes(pubB64u);
  const x = bytesToB64u(pubBytes.slice(1, 33));
  const y = bytesToB64u(pubBytes.slice(33, 65));

  // Importa come JWK — più affidabile di PKCS8 in Deno
  return crypto.subtle.importKey(
    "jwk",
    { kty:"EC", crv:"P-256", d: privB64u, x, y, key_ops:["sign"], ext:true },
    { name:"ECDSA", namedCurve:"P-256" },
    false,
    ["sign"]
  );
}

async function makeVapidJWT(audience: string, subject: string, vapidPriv: string, vapidPub: string): Promise<string> {
  const h = b64uEncodeObj({ typ:"JWT", alg:"ES256" });
  const p = b64uEncodeObj({ aud: audience, exp: Math.floor(Date.now()/1000)+3600, sub: subject });
  const unsigned = `${h}.${p}`;
  const key = await importVapidPrivateKey(vapidPriv, vapidPub);
  const sig  = await crypto.subtle.sign({ name:"ECDSA", hash:"SHA-256" }, key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${bytesToB64u(new Uint8Array(sig))}`;
}

// ── Web Push Encryption (RFC 8291 / RFC 8188, aes128gcm) ──────────────────

// Prima si cifrava con "aesgcm", la bozza vecchia dello standard. I server di
// Apple accettano la richiesta lo stesso (rispondono 201), ma iOS non sa
// decifrare quel formato e scarta il messaggio senza mostrare niente: la
// notifica risultava "inviata" e non arrivava mai. Safari implementa solo
// l'RFC 8291 finale, cioe' "aes128gcm", che e' anche quello che usano Chrome
// e Firefox moderni.
//
// Differenze rispetto a prima: salt e chiave pubblica del server viaggiano
// dentro il corpo del messaggio invece che negli header Encryption/Crypto-Key,
// e il testo in chiaro finisce con un delimitatore 0x02.

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, bits: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, { name: "HKDF" }, false, ["deriveBits"]);
  const out = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bits);
  return new Uint8Array(out);
}

async function encryptPayload(
  plaintext: string,
  clientPubB64u: string,
  authB64u: string
): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const clientPubBytes = b64uToBytes(clientPubB64u);   // 65 byte, punto non compresso
  const authSecret     = b64uToBytes(authB64u);        // 16 byte

  const clientPubKey = await crypto.subtle.importKey(
    "raw", clientPubBytes, { name:"ECDH", namedCurve:"P-256" }, true, []
  );

  const serverKP = await crypto.subtle.generateKey({ name:"ECDH", namedCurve:"P-256" }, true, ["deriveBits"]);
  const serverPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", serverKP.publicKey));

  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name:"ECDH", public: clientPubKey }, serverKP.privateKey, 256)
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));

  // RFC 8291 §3.4: IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info"||0x00||ua_pub||as_pub, 32)
  const authInfo = concat(
    enc.encode("WebPush: info"), new Uint8Array([0x00]),
    clientPubBytes, serverPubRaw
  );
  const ikm = await hkdf(sharedSecret, authSecret, authInfo, 256);

  const cek   = await hkdf(ikm, salt, enc.encode("Content-Encoding: aes128gcm\0"), 128);
  const nonce = await hkdf(ikm, salt, enc.encode("Content-Encoding: nonce\0"),      96);

  const aesKey = await crypto.subtle.importKey("raw", cek, { name:"AES-GCM" }, false, ["encrypt"]);

  // 0x02 = delimitatore di record finale (RFC 8188 §2), al posto del padding.
  const padded = concat(enc.encode(plaintext), new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name:"AES-GCM", iv: nonce }, aesKey, padded)
  );

  // Header del corpo: salt(16) | record size(4) | lunghezza chiave(1) | chiave(65)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([serverPubRaw.length]), serverPubRaw, ciphertext);
}

// ── Send Push ──────────────────────────────────────────────────────────────

async function sendPush(
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payloadText: string,
  vapidPub: string,
  vapidPriv: string,
  vapidSubject: string
): Promise<{ status: number; body: string }> {
  const { endpoint, keys } = subscription;
  const url      = new URL(endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const jwt      = await makeVapidJWT(audience, vapidSubject, vapidPriv, vapidPub);

  const body = await encryptPayload(payloadText, keys.p256dh, keys.auth);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization":    `vapid t=${jwt},k=${vapidPub}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type":     "application/octet-stream",
      "TTL":              "86400",
      "apns-push-type":   "alert",
      "apns-priority":    "10",
    },
    body,
  });

  return { status: res.status, body: await res.text() };
}

// ── Schedule ───────────────────────────────────────────────────────────────

// Gli orari di partenza. Valgono per chi non li ha mai cambiati; chi li
// modifica dal profilo se li ritrova in push_subscriptions.notif_settings.
// L'id e' stabile e non contiene l'ora, cosi' spostare un promemoria non ne
// crea uno nuovo e non perde l'impostazione di acceso/spento.
type Slot = { id: string; h: number; m: number; title: string; body: string; on: boolean };

const DEFAULTS: Slot[] = [
  { id: "peso",      h: 7,  m: 30, title: "\u2696\ufe0f Buongiorno",        body: "Saliamo un attimo sulla bilancia?", on: true },
  { id: "colazione", h: 8,  m: 0,  title: "\u2615 Colazione",                body: "Che si mangia? Segnalo quando hai finito.", on: true },
  { id: "snack1",    h: 10, m: 30, title: "\ud83c\udf4e Piccola pausa",     body: "Uno spuntino e un bicchiere d\u2019acqua.", on: true },
  { id: "pranzo",    h: 12, m: 0,  title: "\ud83c\udf5d \u00c8 ora di pranzo", body: "Raccontami cosa c\u2019\u00e8 nel piatto.", on: true },
  { id: "snack2",    h: 16, m: 0,  title: "\ud83c\udf4a Met\u00e0 pomeriggio", body: "Un boccone e bevi, manca poco.", on: true },
  { id: "cena",      h: 20, m: 0,  title: "\ud83c\udf7d\ufe0f Cena",       body: "Ultimo pasto, poi si stacca.", on: true },
];

// Il cron scatta ogni 5 minuti e la chiamata HTTP puo' arrivare con qualche
// secondo di ritardo. Con 2 minuti di tolleranza ogni minuto scelto cade in
// uno e un solo scatto (gli scatti distano 5): niente doppioni, niente buchi.
const TOLERANCE_MIN = 2;

function romeClock(now: Date): { h: number; m: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? "0");
  return { h: get("hour") % 24, m: get("minute") };   // %24: a mezzanotte alcuni runtime danno "24"
}

// I default riempiono tutto cio' che l'utente non ha toccato, cosi' aggiungere
// un promemoria in futuro non richiede di migrare le preferenze gia' salvate.
function scheduleFor(settings: unknown): Slot[] {
  const slots = (settings && typeof settings === "object")
    ? (settings as Record<string, unknown>).slots
    : null;
  const over = (slots && typeof slots === "object") ? slots as Record<string, {h?:unknown;m?:unknown;on?:unknown}> : {};
  return DEFAULTS.map(d => {
    const o = over[d.id] ?? {};
    const h = (typeof o.h === "number" && o.h >= 0 && o.h <= 23) ? o.h : d.h;
    const m = (typeof o.m === "number" && o.m >= 0 && o.m <= 59) ? o.m : d.m;
    return { ...d, h, m, on: o.on === false ? false : true };
  });
}

function slotAt(schedule: Slot[], rome: { h: number; m: number }): Slot | null {
  const nowMin = rome.h * 60 + rome.m;
  // La distanza va misurata sul quadrante, non sulla retta: un promemoria
  // alle 23:58 ha lo scatto piu' vicino a mezzanotte, e con una differenza
  // semplice risultava lontano 1438 minuti invece di 2. Non sarebbe mai
  // partito.
  const vicino = (a: number, b: number) => {
    const d = Math.abs(a - b);
    return Math.min(d, 1440 - d) <= TOLERANCE_MIN;
  };
  return schedule.find(s => s.on && vicino(s.h * 60 + s.m, nowMin)) ?? null;
}

// Titolo fisso "Awakening": iOS stampa gia' il nome dell'app sopra la
// notifica, ripeterlo nel titolo rubava spazio al messaggio. Il promemoria
// sta tutto nel corpo. Il tag combacia con quello delle notifiche locali di
// index.html, cosi' ad app aperta la push sostituisce quella gia' mostrata
// invece di affiancarsi.
function payloadFor(slot: Slot): string {
  return JSON.stringify({
    title: "Awakening",
    body:  `${slot.title} \u00b7 ${slot.body}`,
    tag:   `awakening-${slot.id}`,
  });
}

// ── Handler ────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const vapidPub     = Deno.env.get("VAPID_PUBLIC_KEY")!;
  const vapidPriv    = Deno.env.get("VAPID_PRIVATE_KEY")!;
  const vapidSubject = Deno.env.get("VAPID_SUBJECT")!;

  const now  = new Date();
  const rome = romeClock(now);
  const romeKey = `${String(rome.h).padStart(2,"0")}:${String(rome.m).padStart(2,"0")}`;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;

  // Override manuale: una notifica uguale per tutti, fuori dagli orari.
  // Serve per i test e per gli avvisi una tantum.
  const manual = (typeof body?.title === "string" && typeof body?.body === "string")
    ? JSON.stringify({
        title: body.title,
        body:  body.body,
        tag:   typeof body.tag === "string" ? body.tag : "awakening-reminder",
      })
    : null;

  const { data: subs, error } = await supabase
    .from("push_subscriptions")
    .select("user_id, subscription, notif_settings");
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });

  const rows = (subs ?? []).filter(r => r.subscription && r.subscription.endpoint);
  if (rows.length === 0) return new Response(JSON.stringify({ sent: 0, rome: romeKey }), { status: 200 });

  // dryRun: mostra chi riceverebbe cosa adesso, senza spedire niente.
  if (body?.dryRun === true) {
    return new Response(JSON.stringify({
      dryRun: true, rome: romeKey,
      utenti: rows.map(r => {
        const s = manual ? null : slotAt(scheduleFor(r.notif_settings), rome);
        return { user_id: r.user_id, invio: manual ? "manuale" : (s ? s.id : null) };
      }),
    }), { status: 200 });
  }

  let sent = 0, failed = 0, skipped = 0;

  for (const row of rows) {
    // Ogni utente ha i suoi orari: il controllo va fatto riga per riga, non
    // una volta sola per tutta la chiamata.
    let payloadText = manual;
    let etichetta = "manuale";
    if (!payloadText) {
      const slot = slotAt(scheduleFor(row.notif_settings), rome);
      if (!slot) { skipped++; continue; }
      payloadText = payloadFor(slot);
      etichetta = slot.id;
    }
    try {
      const { status, body: resBody } = await sendPush(row.subscription, payloadText, vapidPub, vapidPriv, vapidSubject);
      console.log(`[Push] ${row.user_id} ${etichetta} \u2192 ${status}: ${resBody}`);
      if (status >= 200 && status < 300) sent++;
      else {
        failed++;
        // 404/410 = subscription non piu' valida (app disinstallata, permesso
        // revocato). Si azzera la subscription ma si tengono gli orari, cosi'
        // riattivando le notifiche l'utente li ritrova come li aveva lasciati.
        if (status === 404 || status === 410) {
          await supabase.from("push_subscriptions").update({ subscription: null }).eq("user_id", row.user_id);
        }
      }
    } catch(e) {
      failed++;
      console.error(`[Push] ERROR ${row.user_id}:`, String(e));
    }
  }

  return new Response(JSON.stringify({ sent, failed, skipped, rome: romeKey }), { status: 200 });
});
