/*
 * Copia l'app web (la stessa pubblicata su GitHub Pages) dentro native/www,
 * la cartella che Capacitor mette nell'app iOS.
 *
 * Le tre librerie che il sito carica da cdn.jsdelivr.net vengono copiate
 * dentro l'app (www/vendor) e l'index.html copiato punta a quelle: cosi'
 * l'app si apre e funziona anche senza rete. Il sito resta invariato.
 * sw.js non viene copiato: nell'app i file sono gia' sul telefono e il
 * service worker non serve (index.html non lo registra in modalita' nativa).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');   // la radice del repository
const NATIVE = path.resolve(__dirname, '..');
const WWW = path.join(NATIVE, 'www');
const VENDOR = path.join(WWW, 'vendor');

const VENDOR_FILES = [
  { url: 'https://cdn.jsdelivr.net/npm/chart.js',
    from: 'node_modules/chart.js/dist/chart.umd.min.js', to: 'chart.umd.min.js' },
  { url: 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js',
    from: 'node_modules/@zxing/library/umd/index.min.js', to: 'zxing.min.js' },
  { url: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
    from: 'node_modules/@supabase/supabase-js/dist/umd/supabase.js', to: 'supabase.js' }
];
const WEB_FILES = ['manifest.json', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-1024.png'];

fs.rmSync(WWW, { recursive: true, force: true });
fs.mkdirSync(VENDOR, { recursive: true });

let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
for (const v of VENDOR_FILES) {
  const src = path.join(NATIVE, v.from);
  if (!fs.existsSync(src)) throw new Error('Manca ' + v.from + ': esegui prima "npm install" in native/');
  fs.copyFileSync(src, path.join(VENDOR, v.to));
  const n = html.split('"' + v.url + '"').length - 1;
  if (n !== 1) throw new Error('Nell\'index.html il link ' + v.url + ' compare ' + n + ' volte invece di 1');
  html = html.split('"' + v.url + '"').join('"vendor/' + v.to + '"');
}
fs.writeFileSync(path.join(WWW, 'index.html'), html);
for (const f of WEB_FILES) fs.copyFileSync(path.join(ROOT, f), path.join(WWW, f));
console.log('App web copiata in native/www (' + VENDOR_FILES.length + ' librerie incluse).');
