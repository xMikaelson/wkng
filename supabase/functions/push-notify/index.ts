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

// ── Web Push Encryption (RFC 8291 aesgcm) ─────────────────────────────────

async function encryptPayload(
  plaintext: string,
  clientPubB64u: string,
  authB64u: string
): Promise<{ ciphertext: Uint8Array; salt: Uint8Array; serverPubRaw: Uint8Array }> {
  const enc = new TextEncoder();
  const clientPubBytes = b64uToBytes(clientPubB64u);

  const clientPubKey = await crypto.subtle.importKey(
    "raw", clientPubBytes, { name:"ECDH", namedCurve:"P-256" }, true, []
  );

  const serverKP = await crypto.subtle.generateKey({ name:"ECDH", namedCurve:"P-256" }, true, ["deriveKey","deriveBits"]);
  const serverPubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", serverKP.publicKey));

  const sharedBits   = await crypto.subtle.deriveBits({ name:"ECDH", public: clientPubKey }, serverKP.privateKey, 256);
  const sharedSecret = new Uint8Array(sharedBits);

  const salt        = crypto.getRandomValues(new Uint8Array(16));
  const authSecret  = b64uToBytes(authB64u);

  // PRK_combine = HMAC-SHA256(auth_secret, shared_secret)
  const hmacKey1  = await crypto.subtle.importKey("raw", authSecret, { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
  const prkCombine = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey1, sharedSecret));

  // IKM = HKDF-expand(PRK_combine, "Content-Encoding: auth\0", 32)
  const prkKey1 = await crypto.subtle.importKey("raw", prkCombine, { name:"HKDF" }, false, ["deriveBits"]);
  const ikm = new Uint8Array(await crypto.subtle.deriveBits(
    { name:"HKDF", hash:"SHA-256", salt: new Uint8Array(32), info: enc.encode("Content-Encoding: auth\0") },
    prkKey1, 256
  ));

  // PRK = HMAC-SHA256(salt, ikm)
  const hmacKey2 = await crypto.subtle.importKey("raw", salt, { name:"HMAC", hash:"SHA-256" }, false, ["sign"]);
  const prk      = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey2, ikm));

  const prkKey2 = await crypto.subtle.importKey("raw", prk, { name:"HKDF" }, false, ["deriveBits"]);

  // Context = label + 0x00 + 0x00 0x41 + clientPub + 0x00 0x41 + serverPub
  const contextKey   = concat(
    enc.encode("P-256\0"),
    new Uint8Array([0x00, 0x41]), clientPubBytes,
    new Uint8Array([0x00, 0x41]), serverPubRaw
  );
  const infoKey   = concat(enc.encode("Content-Encoding: aesgcm\0"), contextKey);
  const infoNonce = concat(enc.encode("Content-Encoding: nonce\0"),  contextKey);

  const cek   = new Uint8Array(await crypto.subtle.deriveBits({ name:"HKDF", hash:"SHA-256", salt: new Uint8Array(32), info: infoKey   }, prkKey2, 128));
  // Need separate key import for second deriveBits
  const prkKey3 = await crypto.subtle.importKey("raw", prk, { name:"HKDF" }, false, ["deriveBits"]);
  const nonce = new Uint8Array(await crypto.subtle.deriveBits({ name:"HKDF", hash:"SHA-256", salt: new Uint8Array(32), info: infoNonce }, prkKey3, 96));

  const aesKey   = await crypto.subtle.importKey("raw", cek, { name:"AES-GCM" }, false, ["encrypt"]);
  const padded   = concat(new Uint8Array(2), enc.encode(plaintext));
  const cipherBuf = await crypto.subtle.encrypt({ name:"AES-GCM", iv: nonce }, aesKey, padded);

  return { ciphertext: new Uint8Array(cipherBuf), salt, serverPubRaw };
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

  const { ciphertext, salt, serverPubRaw } = await encryptPayload(payloadText, keys.p256dh, keys.auth);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization":    `vapid t=${jwt},k=${vapidPub}`,
      "Content-Encoding": "aesgcm",
      "Content-Type":     "application/octet-stream",
      "Encryption":       `salt=${bytesToB64u(salt)}`,
      "Crypto-Key":       `dh=${bytesToB64u(serverPubRaw)};vapid=${vapidPub}`,
      "TTL":              "86400",
      "apns-push-type":   "alert",
      "apns-priority":    "10",
    },
    body: ciphertext,
  });

  const body = await res.text();
  return { status: res.status, body };
}

// ── Schedule ───────────────────────────────────────────────────────────────

// Gli orari sono ORA LOCALE ITALIANA, non UTC. Prima erano chiavi UTC fisse
// (6:15, 7:00, ...) che valevano solo d'inverno: da fine marzo a fine ottobre
// l'Italia e' su CEST (UTC+2) e le notifiche arrivavano un'ora tardi. Qui si
// legge l'ora di Europe/Rome, cosi' il cambio dell'ora e' gestito da solo.
//
// Il tag replica quello delle notifiche client-side in index.html
// ('awakening-' + h + '-' + m): stesso tag = la notifica push e quella locale
// si sovrascrivono invece di accumularsi quando l'app e' aperta.
const SCHEDULE: { h: number; m: number; title: string; body: string }[] = [
  { h: 7,  m: 15, title: "⚖️ Peso",         body: "Buongiorno! Registra il tuo peso di oggi." },
  { h: 8,  m: 0,  title: "☕ Colazione",           body: "Ora di colazione! Ricordati di loggarla su Awakening." },
  { h: 10, m: 30, title: "🍎 Snack + Acqua", body: "Spuntino di meta mattina! Hai bevuto abbastanza acqua?" },
  { h: 13, m: 0,  title: "🍝 Pranzo",        body: "Ora di pranzo! Registra il pasto su Awakening." },
  { h: 16, m: 0,  title: "🍊 Snack + Acqua", body: "Spuntino pomeridiano! Ricordati di bere." },
  { h: 20, m: 0,  title: "🍽️ Cena",    body: "Ora di cena! Registra il pasto su Awakening." },
];

// Il cron parte al minuto esatto ma la chiamata HTTP puo' arrivare con qualche
// secondo di ritardo: senza tolleranza un rilascio a cavallo del minuto fa
// perdere la notifica. Due minuti bastano e sono ben lontani dall'ora di
// scarto fra i due orari UTC con cui ogni job e' schedulato.
const TOLERANCE_MIN = 2;

function romeClock(now: Date): { h: number; m: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value ?? "0");
  return { h: get("hour") % 24, m: get("minute") };   // %24: a mezzanotte alcuni runtime danno "24"
}

function slotFor(now: Date) {
  const { h, m } = romeClock(now);
  const nowMin = h * 60 + m;
  return SCHEDULE.find(s => Math.abs((s.h * 60 + s.m) - nowMin) <= TOLERANCE_MIN) ?? null;
}

function tagFor(slot: { h: number; m: number }): string {
  return `awakening-${slot.h}-${slot.m}`;
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
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;

  const slot = slotFor(now);
  let notification = slot
    ? { title: slot.title, body: slot.body, tag: tagFor(slot) }
    : null;

  // Override manuale: utile per i test e per le notifiche una tantum.
  if (typeof body?.title === "string" && typeof body?.body === "string") {
    notification = {
      title: body.title,
      body:  body.body,
      tag:   typeof body.tag === "string" ? body.tag : "awakening-reminder",
    };
  }

  const romeKey = `${String(rome.h).padStart(2,"0")}:${String(rome.m).padStart(2,"0")}`;

  if (!notification) {
    // Ogni orario e' schedulato su due ore UTC (una per CET, una per CEST):
    // lo scatto che non corrisponde all'ora di Roma finisce qui, ed e' normale.
    return new Response(JSON.stringify({ skipped: true, reason: `Nessuna notifica per le ${romeKey} (Europe/Rome)` }), { status: 200 });
  }

  // dryRun: verifica quale slot risponde a un certo momento senza inviare nulla.
  if (body?.dryRun === true) {
    return new Response(JSON.stringify({ dryRun: true, rome: romeKey, notification }), { status: 200 });
  }

  const { data: subs, error } = await supabase.from("push_subscriptions").select("user_id, subscription");
  if (error) return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  if (!subs || subs.length === 0) return new Response(JSON.stringify({ sent: 0, rome: romeKey }), { status: 200 });

  const payloadText = JSON.stringify({ title: notification.title, body: notification.body, tag: notification.tag });
  let sent = 0, failed = 0;

  for (const row of subs) {
    try {
      const { status, body: resBody } = await sendPush(row.subscription, payloadText, vapidPub, vapidPriv, vapidSubject);
      console.log(`[Push] ${row.user_id} → ${status}: ${resBody}`);
      if (status >= 200 && status < 300) sent++;
      else {
        failed++;
        if (status === 404 || status === 410) await supabase.from("push_subscriptions").delete().eq("user_id", row.user_id);
      }
    } catch(e) {
      failed++;
      console.error(`[Push] ERROR ${row.user_id}:`, String(e));
    }
  }

  return new Response(JSON.stringify({ sent, failed, rome: romeKey, notification: notification.title }), { status: 200 });
});
