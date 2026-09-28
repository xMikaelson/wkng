# Awakening per iPhone (Capacitor)

Questa cartella trasforma il sito in un'app per iPhone. Il codice
dell'app è lo stesso `index.html` della radice: qui c'è solo il
contenitore nativo, più il timer di recupero sulla schermata di blocco e
nell'isola dinamica (Live Activity).

Cosa aggiunge l'app rispetto al sito:

- **Scheda di recupero sulla schermata di blocco**: seduta, esercizio,
  serie fatte, prossimo carico, conto alla rovescia e tempo della
  seduta. Allo scadere diventa "Tocca a te" e mostra "Serie fatta".
- **Isola dinamica**: chiusa mostra anello e secondi; aperta (tenendola
  premuta) mostra la stessa scheda.
- **Suono e vibrazione a fine recupero** anche a telefono bloccato, con
  una notifica locale.
- **Funziona senza rete**: grafici, Supabase e scanner sono inclusi
  nell'app invece di arrivare da internet.

Servono iOS 16.2 o successivo per la scheda e l'isola; il resto funziona
da iOS 15.

## La prima volta, su un Mac

Serve un Mac con Xcode 16 o successivo e Node.js 20 o successivo.

1. Nel terminale, dalla cartella del repository:

   ```sh
   cd native
   npm install
   npm run sync
   npm run open
   ```

   L'ultimo comando apre il progetto in Xcode.

2. **Crea l'estensione del timer** (solo la prima volta):
   - *File › New › Target…* e scegli **Widget Extension**.
   - Product Name: **AwakeningTimer**. Togli la spunta da *Include
     Configuration App Intent*, *Include Live Activity* e *Include
     Control*. Premi *Finish* e, se chiede di attivare lo schema, premi
     *Activate*.
   - Nella colonna a sinistra, dentro il gruppo **AwakeningTimer**,
     elimina i file `.swift` creati da Xcode (*Delete › Move to Trash*).
     Lascia `Info.plist` e `Assets.xcassets`.
   - Trascina nel gruppo **AwakeningTimer** i due file della cartella
     `native/ios/App/LiveActivitySources/`. Nella finestra che compare
     lascia spenta *Copy items if needed* e spunta solo il target
     **AwakeningTimer**.
   - Seleziona `App/RestActivityAttributes.swift`. Nel pannello a destra,
     sotto *Target Membership*, spunta anche **AwakeningTimer**.
   - Seleziona il target **AwakeningTimer** › *General* › *Minimum
     Deployments*: **iOS 16.2**.

3. **Firma**: nei target **App** e **AwakeningTimer**, scheda *Signing &
   Capabilities*, scegli il tuo *Team* (va bene anche l'Apple ID gratuito).
   Se il nome `com.xmikaelson.awakening` risulta già usato, cambialo in
   entrambi i target mantenendo `.AwakeningTimer` in fondo a quello
   dell'estensione.

4. Collega l'iPhone, sceglilo in alto e premi ▶. Sul telefono attiva
   *Impostazioni › Privacy e sicurezza › Modalità sviluppatore* e, la
   prima volta, fidati del certificato in *Impostazioni › Generali › VPN e
   gestione dispositivi*.

Il passo 2 cambia il file del progetto Xcode: conviene salvarlo nel
repository, così non va ripetuto.

## Provare il timer

Avvia un allenamento, completa una serie e blocca il telefono: la scheda
compare sulla schermata di blocco. Allo scadere senti il suono e la scheda
dice "Tocca a te". Toccando "Serie fatta" l'app si apre, segna la serie e
fa partire il recupero successivo. Con un'altra app aperta il recupero
resta nell'isola dinamica.

## Dopo ogni modifica al sito

```sh
cd native
npm run sync
```

Poi ▶ in Xcode. `sync` ricopia `index.html` e le icone dentro l'app.
