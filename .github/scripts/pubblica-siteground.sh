#!/usr/bin/env bash
# Pubblica la cartella sito/ nella public_html del dominio su SiteGround.
# Lo lancia .github/workflows/siteground.yml; si puo' provare anche a mano
# esportando le stesse variabili.
#
# Variabili:
#   SG_HOST, SG_USER    da Site Tools > Devs > SSH Keys Manager > SSH Credentials
#   SG_KEY              chiave privata (Private Key), testo completo
#   SG_PASSPHRASE       passphrase della chiave (Site Tools la mette sempre)
#   SG_PORT             porta SSH, su SiteGround 18765
#   SG_DOMINIO          cartella in ~/www; vuoto = l'unico sito presente
#   SG_KNOWN_HOSTS      file con la chiave del server fissata (vedi sotto)
#   SG_SORGENTE         cartella da pubblicare (default: sito)
#
# Sicurezza: usa solo ssh, ssh-keygen e rsync del sistema, nessun codice di
# terzi tocca la chiave. La chiave senza passphrase esiste solo in una cartella
# temporanea del runner (usa e getta) e viene cancellata all'uscita.
# Il server viene riconosciuto dalla sua chiave pubblica salvata nel repository
# (SG_KNOWN_HOSTS): se cambia, la pubblicazione si ferma invece di mandare i
# file a un altro server. Prima che il file esista, la chiave viene letta al
# primo collegamento e stampata nel log per poterla fissare.
set -euo pipefail

if [ -z "${SG_HOST:-}" ] || [ -z "${SG_USER:-}" ] || [ -z "${SG_KEY:-}" ]; then
  echo "::notice::Pubblicazione su SiteGround non ancora configurata (mancano SG_HOST, SG_USER o SG_KEY): nessuna modifica."
  exit 0
fi

PORTA="${SG_PORT:-18765}"
SORGENTE="${SG_SORGENTE:-sito}"
[ -f "$SORGENTE/index.html" ] || { echo "::error::Manca $SORGENTE/index.html: niente da pubblicare."; exit 1; }

LAVORO=$(mktemp -d)
trap 'rm -rf "$LAVORO"' EXIT
umask 077
CHIAVE="$LAVORO/chiave"
printf '%s\n' "$SG_KEY" | tr -d '\r' > "$CHIAVE"
if ! ssh-keygen -y -P '' -f "$CHIAVE" >/dev/null 2>&1; then
  # Chiave protetta da passphrase: la togliamo dalla sola copia temporanea,
  # cosi' ssh e rsync non la chiedono.
  [ -n "${SG_PASSPHRASE:-}" ] || { echo "::error::La chiave SG_KEY ha una passphrase ma SG_PASSPHRASE e' vuoto."; exit 1; }
  ssh-keygen -q -p -P "$SG_PASSPHRASE" -N '' -f "$CHIAVE" >/dev/null 2>&1 \
    || { echo "::error::SG_KEY non e' una chiave valida o SG_PASSPHRASE non e' la sua passphrase."; exit 1; }
fi

NOTI="$LAVORO/known_hosts"
if [ -n "${SG_KNOWN_HOSTS:-}" ] && [ -s "$SG_KNOWN_HOSTS" ]; then
  cp "$SG_KNOWN_HOSTS" "$NOTI"
else
  ssh-keyscan -H -T 20 -p "$PORTA" "$SG_HOST" 2>/dev/null | grep -v '^#' > "$NOTI" || true
  [ -s "$NOTI" ] || { echo "::error::Il server SiteGround non risponde sulla porta $PORTA (controlla SG_HOST)."; exit 1; }
  echo "::warning::Chiave del server non ancora fissata nel repository. Copiare queste righe in ${SG_KNOWN_HOSTS:-.github/siteground_known_hosts}:"
  echo "----- inizio -----"
  cat "$NOTI"
  echo "----- fine -----"
fi

SSH=(ssh -p "$PORTA" -i "$CHIAVE" -o IdentitiesOnly=yes -o BatchMode=yes
     -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$NOTI" -o ConnectTimeout=20)
REMOTO="$SG_USER@$SG_HOST"

# Trova la cartella del sito sul server: ~/www/<dominio>/public_html.
# Con un solo sito nell'hosting lo prende da solo, altrimenti serve SG_DOMINIO.
TROVA='set -e
d="$1"
if [ -n "$d" ]; then
  p="$HOME/www/$d/public_html"
  [ -d "$p" ] || { echo "ERRORE: non esiste ~/www/$d/public_html. Cartelle in ~/www:"; ls -1 "$HOME/www" 2>&1; exit 3; }
else
  n=0; p=""
  for x in "$HOME"/www/*/public_html; do [ -d "$x" ] && { n=$((n+1)); p="$x"; }; done
  [ "$n" -eq 1 ] || { echo "ERRORE: siti trovati in ~/www: $n. Impostare SG_DOMINIO con uno di questi:"; ls -1 "$HOME/www" 2>&1; exit 3; }
fi
if command -v rsync >/dev/null 2>&1; then r=rsync; else r=tar; fi
echo "DEST=$p"
echo "METODO=$r"'
if ! USCITA=$("${SSH[@]}" "$REMOTO" sh -s -- "${SG_DOMINIO:-}" <<<"$TROVA" 2>&1); then
  echo "$USCITA"
  echo "::error::Collegamento a SiteGround non riuscito o cartella del sito non trovata (vedi sopra)."
  exit 1
fi
DEST=$(printf '%s\n' "$USCITA" | sed -n 's/^DEST=//p' | tail -1)
METODO=$(printf '%s\n' "$USCITA" | sed -n 's/^METODO=//p' | tail -1)
case "$DEST" in
  /*/www/*/public_html) ;;
  *) echo "$USCITA"; echo "::error::Cartella di destinazione inattesa: '$DEST'."; exit 1 ;;
esac
DOMINIO=$(basename "$(dirname "$DEST")")
echo "Destinazione: ~/www/$DOMINIO/public_html (copia con $METODO)"

if [ "$METODO" = rsync ]; then
  # --delete toglie i file che non fanno piu' parte del sito (per esempio la
  # pagina di benvenuto di SiteGround o un'immagine eliminata). I file che
  # iniziano con il punto (.htaccess, .well-known del certificato) sono esclusi
  # e quindi non vengono mai toccati.
  rsync -rlptz --delete --exclude='.*' --chmod=D755,F644 --itemize-changes \
    -e "${SSH[*]}" "$SORGENTE"/ "$REMOTO:$DEST/"
else
  # Senza rsync sul server: copia completa con tar (non elimina i file vecchi).
  echo "::warning::rsync non disponibile sul server: copia con tar, i file rimossi dal sito restano sul server."
  tar -C "$SORGENTE" -czf - . | "${SSH[@]}" "$REMOTO" "tar -xzf - -C '$DEST' && find '$DEST' -type d -exec chmod 755 {} + && find '$DEST' -type f ! -name '.*' -exec chmod 644 {} +"
fi

# Controllo dal web: la pagina servita dal dominio deve essere quella appena
# copiata. Non blocca (il dominio puo' non puntare ancora a SiteGround).
if [ "${SG_CONTROLLO_WEB:-1}" = 1 ]; then
  ATTESO=$(sha256sum "$SORGENTE/index.html" | cut -d' ' -f1)
  for url in "https://$DOMINIO/" "http://$DOMINIO/"; do
    CODICE=$(curl -sS -L -o "$LAVORO/pagina" -w '%{http_code}' --max-time 20 "$url" 2>"$LAVORO/curl.err" || true)
    if [ "$CODICE" = 200 ] && [ "$(sha256sum "$LAVORO/pagina" | cut -d' ' -f1)" = "$ATTESO" ]; then
      echo "Controllo web: $url risponde con la pagina appena pubblicata."
      exit 0
    fi
    echo "Controllo web: $url -> codice ${CODICE:-nessuno} $(head -c 200 "$LAVORO/curl.err" 2>/dev/null)"
  done
  echo "::warning::File copiati, ma il dominio non mostra ancora la pagina nuova (DNS o certificato non ancora pronti, oppure cache)."
fi
