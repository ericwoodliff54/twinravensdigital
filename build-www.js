// Builds the folder the store apps load (www/). Run with: node build-www.js
// Set RC_IOS_KEY and RC_ANDROID_KEY (RevenueCat public SDK keys, appl_... and goog_...), PRIVACY_URL and TERMS_URL before building a release.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const root = __dirname;
const out = path.join(root, 'www');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const skip = /\.(py|txt|md|yml|yaml|toml|zip|log)$|^(accuracy-test\.html|eval-worker\.js|schooled-worker\.js|worker\.js|package(-lock)?\.json|capacitor\.config\.json|build-www\.js|patch-native\.js|purchases\.src\.js|service-worker\.js)$/;
fs.readdirSync(root, { withFileTypes: true }).forEach((e) => {
  if (!e.isFile() || skip.test(e.name) || e.name.startsWith('.')) return;
  if (/\.(html|js|css|json|png|jpg|jpeg|woff2|svg)$/.test(e.name)) fs.copyFileSync(path.join(root, e.name), path.join(out, e.name));
});
const q = (v, d) => JSON.stringify(process.env[v] || d);
esbuild.buildSync({
  entryPoints: [path.join(root, 'purchases.src.js')], bundle: true, minify: true, format: 'iife', target: 'es2019', outfile: path.join(out, 'purchases.js'),
  define: {
    __RC_IOS_KEY__: q('RC_IOS_KEY', 'appl_REPLACE_ME'),
    __RC_ANDROID_KEY__: q('RC_ANDROID_KEY', 'goog_REPLACE_ME'),
    __PRIVACY_URL__: q('PRIVACY_URL', 'https://www.twinravensdigital.com/schooled-privacy.html'),
    __TERMS_URL__: q('TERMS_URL', 'https://www.apple.com/legal/internet-services/itunes/dev/stdeula/')
  }
});
// The store apps load purchases.js before app.js. The web version's index.html is left alone.
const idx = path.join(out, 'index.html');
let html = fs.readFileSync(idx, 'utf8');
if (!html.includes('<script src="app.js"></script>')) throw new Error('index.html no longer has the app.js script tag');
html = html.replace('<script src="app.js"></script>', '<script src="purchases.js"></script>\n<script src="app.js"></script>');
fs.writeFileSync(idx, html);
console.log('www/ built: ' + fs.readdirSync(out).length + ' files');
