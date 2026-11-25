'use strict';

// ---------------------------------------------------------------
// Schooled app. Plain JavaScript, no build step.
// Change WORKER_URL only if you rename or move the Cloudflare Worker.
// ---------------------------------------------------------------
const WORKER_URL = 'https://schooled-worker.ericwoodliff.workers.dev';
const STORE_KEY = 'schooled.v1';
const MAX_PHOTO_SIDE = 1280; // preview and zoom-set whole picture
const SINGLE_SIDE = 2048; // the one sharp picture sent first
const MAX_VERIFY = 6; // most kinds double-checked with close-ups in one scan
const MONTAGE_CROP_MIN = 200; // close-ups are shown to the AI at least this big (pixels)
const MONTAGE_CROP_MAX = 480;
const MONTAGE_MAX_W = 1400;
const KIND_LIST = ['fish', 'shrimp', 'snail', 'plant', 'coral', 'invert', 'other'];

// ---------- Small helpers ----------
const $ = (id) => document.getElementById(id);

// Builds elements with textContent only, so text from the AI can never inject markup.
function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  for (const [key, val] of Object.entries(props || {})) {
    if (key === 'class') node.className = val;
    else if (key === 'text') node.textContent = val;
    else if (key.startsWith('on') && typeof val === 'function') node.addEventListener(key.slice(2), val);
    else if (val !== false && val != null) node.setAttribute(key, val === true ? '' : String(val));
  }
  for (const kid of kids.flat()) {
    if (kid != null) node.append(kid);
  }
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const KIND_ICONS = {
  fish: ['M3 12c3-4.5 8-5.5 12-2.5l5-2.5v10l-5-2.5c-4 3-9 2-12-2.5z'],
  plant: ['M12 21V9', 'M12 13c-4 0-6-2.5-6-6 4 0 6 2 6 6z', 'M12 16c4 0 6-2.5 6-6-4 0-6 2-6 6z'],
  shrimp: ['M5 8c0-2.5 3-4 6-3 4 1.2 7 4.5 7 9 0 2-1 4-3 5', 'M5 8c0 2 1.5 3 3.5 3', 'M15 19l-3 1.5'],
  snail: ['M5 19h14', 'M16 19c2.5 0 3-2.5 3-4a7 7 0 1 0-7 4', 'M12 15a2.5 2.5 0 1 1 2.5-2.5', 'M5 19c0-2 .5-4 2-5'],
  coral: ['M12 21v-8', 'M12 13c-3 0-5-2-5-5', 'M12 13c3 0 5-2 5-5', 'M7 8c0-2 1-3 1-5', 'M17 8c0-2-1-3-1-5', 'M12 13V4'],
  invert: ['M12 3l2.6 5.6 6.1.8-4.5 4.2 1.1 6-5.3-3-5.3 3 1.1-6L3.3 9.4l6.1-.8z']
};
function kindIcon(kind) {
  const paths = KIND_ICONS[kind] || KIND_ICONS.fish;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '22');
  svg.setAttribute('height', '22');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  paths.forEach((d) => {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  });
  return svg;
}
function kindAvatar(kind) {
  const safe = ['fish', 'plant', 'shrimp', 'snail', 'coral', 'invert'].includes(kind) ? kind : 'other';
  return el('span', { class: 'avatar ' + safe }, kindIcon(safe));
}

// ---------- Species database (names, look-alike groups, autocomplete) ----------
const DB = { ready: false, list: [], byKey: new Map(), byGenus: new Map(), groups: {} };

function normKey(text) {
  return String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/['\u2019]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

async function loadSpecies() {
  try {
    const res = await fetch('species.json');
    const data = await res.json();
    if (!data || !Array.isArray(data.species)) return;
    DB.list = data.species;
    DB.groups = data.groups || {};
    DB.byKey = new Map();
    DB.bySquash = new Map(); // same keys without spaces, so "Yellow-tail" finds "Yellowtail"
    DB.byGenus = new Map();
    DB.list.forEach((e) => {
      const g = /^([A-Z][a-z]+)( sp\.?)?$/.exec(e.s || '');
      if (g) DB.byGenus.set(normKey(g[1]), e); // a genus-level entry, used when the exact species is not in the list
      [e.n, e.s].concat(e.a || []).forEach((key) => {
        const k = normKey(key);
        if (k && !DB.byKey.has(k)) DB.byKey.set(k, e);
        const q = k.replace(/ /g, '');
        if (q && !DB.bySquash.has(q)) DB.bySquash.set(q, e);
      });
    });
    DB.ready = true;
  } catch (err) { /* the app works without the list, with plainer names */ }
}

function lookupSpecies(name) {
  const k = normKey(name);
  return DB.byKey.get(k) || (DB.bySquash && DB.bySquash.get(k.replace(/ /g, ''))) || null;
}

// Matches what the AI said to the species list on the phone: common name, then scientific name, then the genus.
// This is why the AI never needs to be sent the list. When `where` is given, names that did not match cleanly are
// written to a small tester's list (see "Names I could not match" on Home) so the species list can be improved.
function resolveSpecies(common, scientific, where, kind) {
  let hit = common ? lookupSpecies(common) : null;
  let how = hit ? 'exact' : '';
  if (!hit && scientific) {
    hit = lookupSpecies(scientific);
    how = hit ? 'alias' : '';
    if (!hit) {
      hit = DB.byGenus.get(normKey(String(scientific).trim().split(/\s+/)[0])) || null;
      how = hit ? 'genus' : '';
    }
  }
  if (where && DB.ready && how !== 'exact') noteMiss(common, scientific, kind, how || 'miss', hit ? hit.n : '', where);
  return hit;
}

// ---------- Tester usage log (tokens and cost of each AI call, kept on this phone) ----------
const USAGE_KEY = 'schooled.usage';
const USAGE_PRICES = { 'gemini-3.5-flash-lite': [0.3, 2.5], 'gemini-3.8-flash': [0.75, 3.75], 'gemini-3.7-flash': [0.75, 3.75], 'gemini-3.6-flash': [0.75, 3.75], 'gemini-3.5-flash': [0.75, 3.75] };
function loadUsage() {
  try { const v = JSON.parse(localStorage.getItem(USAGE_KEY)); return Array.isArray(v) ? v : []; } catch (err) { return []; }
}
function saveUsage(list) {
  try { localStorage.setItem(USAGE_KEY, JSON.stringify(list.slice(-500))); } catch (err) { /* storage full or blocked */ }
}
// kind: scan, zoom, fish, care, dream-plan, dream-image. cents is an estimate from Google's list prices.
function logUsage(kind, model, usage, extra) {
  if (!usage) return;
  const inTok = Number(usage.input) || 0, outTok = Number(usage.output) || 0;
  let dollars = null;
  if (kind === 'dream-image') {
    const c = dreamCost({ image: Object.assign({ model }, usage) });
    if (c.known) dollars = c.dollars;
  } else if (USAGE_PRICES[model]) dollars = (inTok * USAGE_PRICES[model][0] + outTok * USAGE_PRICES[model][1]) / 1e6;
  const list = loadUsage();
  list.push(Object.assign({ t: new Date().toISOString().slice(0, 19).replace('T', ' '), kind, model: model || '', in: inTok, out: outTok, cents: dollars === null ? '' : Math.round(dollars * 10000) / 100 }, extra || {}));
  saveUsage(list);
}
function usageCsv(list) {
  const head = 'time,kind,model,tokens_in,tokens_out,cents,detail';
  return [head].concat(list.map((u) => [u.t, u.kind, u.model, u.in, u.out, u.cents, '"' + String(u.detail || '').replace(/"/g, '') + '"'].join(','))).join('\n');
}
function usageSummary(list) {
  const by = {};
  list.forEach((u) => { const b = by[u.kind] || (by[u.kind] = { n: 0, cents: 0 }); b.n++; b.cents += Number(u.cents) || 0; });
  return { by, total: list.reduce((s, u) => s + (Number(u.cents) || 0), 0) };
}

// ---------- Names the app could not match cleanly ----------
const MISS_KEY = 'schooled.misses';
function loadMisses() {
  try { const v = JSON.parse(localStorage.getItem(MISS_KEY)); return Array.isArray(v) ? v : []; } catch (err) { return []; }
}
function saveMisses(list) {
  try { localStorage.setItem(MISS_KEY, JSON.stringify(list.slice(0, 300))); } catch (err) { /* storage full or blocked */ }
}
// how: 'miss' = not in the list at all, 'genus' = only the genus matched, 'alias' = matched by scientific name but the common name was new
function noteMiss(common, scientific, kind, how, matched, where) {
  const name = String(common || '').trim().slice(0, 60);
  if (!name || kind === 'other' || /^unidentified/i.test(name)) return;
  const key = normKey(name) + '|' + how;
  const list = loadMisses();
  let m = list.find((x) => x.key === key);
  if (!m) { m = { key, name, sci: '', kind: kind || '', how, matched: matched || '', where: where || '', n: 0 }; list.push(m); }
  m.n += 1;
  if (scientific && !m.sci) m.sci = String(scientific).slice(0, 80);
  saveMisses(list);
}
function missesText(list) {
  return list.map((m) => [m.name, m.sci || '-', m.kind || '-', m.how + (m.matched ? ' -> ' + m.matched : ''), m.where || '-', m.n + 'x'].join(' | ')).join('\n');
}
const MISS_WORDS = { miss: 'Not in my list', genus: 'Only the genus matched', alias: 'Matched by scientific name' };
function renderMisses() {
  const body = $('misses-body');
  body.replaceChildren();
  const list = loadMisses();
  const usage = loadUsage();
  body.append(el('h1', { text: 'Tester tools' }), el('h2', { class: 'section', text: 'Usage log' }));
  if (!usage.length) body.append(el('p', { class: 'muted', text: 'Nothing yet. Every scan, Fish Check and dream picture is logged here with its tokens and estimated cost.' }));
  else {
    const sum = usageSummary(usage);
    body.append(el('p', { class: 'muted', text: usage.length + ' calls, about $' + (sum.total / 100).toFixed(2) + ' in total. ' + Object.keys(sum.by).map((k) => k + ' ' + sum.by[k].n + ' (avg ' + (sum.by[k].cents / sum.by[k].n).toFixed(2) + '\u00a2)').join(', ') + '.' }),
      el('div', { class: 'row photo-actions' },
        el('button', { type: 'button', class: 'btn primary', text: 'Copy usage log', onclick: () => {
          const text = usageCsv(usage);
          const done = () => toast('Copied ' + usage.length + ' calls.');
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => { fallbackCopy(text); done(); });
          else { fallbackCopy(text); done(); }
        } }),
        el('button', { type: 'button', class: 'btn', text: 'Download CSV', onclick: () => {
          const url = URL.createObjectURL(new Blob([usageCsv(usage)], { type: 'text/csv' }));
          const link = el('a', { href: url, download: 'schooled-usage.csv' });
          document.body.append(link); link.click(); link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
        } }),
        el('button', { type: 'button', class: 'btn', text: 'Clear log', onclick: () => { saveUsage([]); renderMisses(); } })));
  }
  body.append(el('h2', { class: 'section', text: 'Names I could not match' }),
    el('p', { class: 'muted', text: 'Names the AI used that were not in my species list, or matched only loosely. Send this list to Claude to grow the list.' }));
  if (!list.length) { body.append(el('p', { class: 'muted', text: 'Nothing yet. Scan or check a few fish.' })); return; }
  body.append(el('div', { class: 'row photo-actions' },
    el('button', { type: 'button', class: 'btn primary', text: 'Copy list', onclick: () => {
      const text = missesText(list);
      const done = () => toast('Copied ' + list.length + ' names.');
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, () => { fallbackCopy(text); done(); });
      else { fallbackCopy(text); done(); }
    } }),
    el('button', { type: 'button', class: 'btn', text: 'Clear list', onclick: () => { saveMisses([]); renderMisses(); } })));
  body.append(el('div', { class: 'card' }, ...list.slice().sort((x, y) => y.n - x.n).map((m) => el('div', { class: 'miss-row' },
    el('strong', { text: m.name + (m.n > 1 ? ' (' + m.n + 'x)' : '') }),
    el('span', { class: 'muted small', text: [m.sci, MISS_WORDS[m.how] + (m.matched ? ': ' + m.matched : ''), m.where].filter(Boolean).join(' \u00b7 ') })))));
}
function fallbackCopy(text) {
  const ta = el('textarea', { style: 'position:fixed;opacity:0' });
  ta.value = text; document.body.append(ta); ta.select();
  try { document.execCommand('copy'); } catch (err) { /* nothing more to try */ }
  ta.remove();
}

// Same species whatever the spelling: "cardinals", "Cardinal Tetra" and its scientific name all match.
function canonKey(name) {
  const hit = lookupSpecies(name);
  return normKey(hit ? hit.n : name);
}

function usableScientific(entry) {
  return entry && /\s/.test(entry.s) && !/\bsp\.$/.test(entry.s) ? entry.s : '';
}

// ---------- Search box for species (names, aliases and scientific names) ----------
function speciesMatches(query, type) {
  const q = normKey(query);
  if (!q || !DB.ready) return [];
  const codes = type === 'Saltwater' ? ['s'] : type === 'Brackish' ? ['b', 'f'] : ['f'];
  const scored = [];
  DB.list.forEach((e) => {
    if (!codes.some((c) => e.w.includes(c))) return;
    let best = 99;
    [e.n, e.s].concat(e.a || []).forEach((raw) => {
      const n = normKey(raw);
      if (!n) return;
      if (n === q) best = Math.min(best, 0);
      else if (n.startsWith(q)) best = Math.min(best, 1);
      else if (n.split(' ').some((w) => w.startsWith(q))) best = Math.min(best, 2);
      else if (n.includes(q)) best = Math.min(best, 3);
    });
    if (best < 99) scored.push([best, e]);
  });
  scored.sort((a, b) => a[0] - b[0] || a[1].n.localeCompare(b[1].n));
  return scored.slice(0, 8).map((x) => x[1]);
}

// A search-as-you-type box. onPick(name, entry) gets called with the database entry, or null for text typed in by hand.
function createSearch(opts) {
  const input = el('input', {
    type: 'text', class: 'search-input', placeholder: opts.placeholder, 'aria-label': opts.label,
    maxlength: 60, autocomplete: 'off', autocapitalize: 'words', spellcheck: 'false', enterkeyhint: 'search', value: opts.value || ''
  });
  const results = el('div', { class: 'search-results', role: 'listbox' });
  results.hidden = true;
  const root = el('div', { class: 'search' }, input, results);
  function render() {
    const q = input.value.trim();
    results.replaceChildren();
    if (!q) { results.hidden = true; return; }
    const found = speciesMatches(q, opts.type ? opts.type() : 'Freshwater');
    found.forEach((e) => results.append(
      el('button', { type: 'button', class: 'search-row', role: 'option', onclick: () => opts.onPick(e.n, e) },
        kindAvatar(e.k),
        el('span', { class: 'grow' },
          el('span', { class: 'name', text: e.n }),
          usableScientific(e) ? el('span', { class: 'sub sci', text: e.s }) : null))
    ));
    if (!found.some((e) => normKey(e.n) === normKey(q))) {
      results.append(
        el('button', { type: 'button', class: 'search-row custom', role: 'option', onclick: () => opts.onPick(q.slice(0, 60), null) },
          el('span', { class: 'avatar other', text: '+' }),
          el('span', { class: 'grow' },
            el('span', { class: 'name', text: 'Add \u201c' + q + '\u201d' }),
            el('span', { class: 'sub', text: found.length ? 'Not what you meant? Add it as typed' : 'Not in the list, add it as typed' })))
      );
    }
    results.hidden = false;
    if (typeof results.scrollIntoView === 'function') results.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  input.addEventListener('input', render);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); const first = results.querySelector('.search-row'); if (first) first.click(); }
    else if (ev.key === 'Escape') results.hidden = true;
  });
  return {
    root, input,
    close() { results.hidden = true; },
    clear() { input.value = ''; results.replaceChildren(); results.hidden = true; }
  };
}

// ---------- Saved data (stays on the phone) ----------
const TYPES = ['Freshwater', 'Saltwater', 'Brackish'];
const STYLES = {
  Freshwater: ['Community', 'Planted', 'Cichlid', 'Nano / shrimp', 'Predator', 'Species only', 'Breeding', 'Biotope', 'Other'],
  Saltwater: ['Reef', 'Fish only (FOWLR)', 'Nano reef', 'Predator', 'Seahorse', 'Other'],
  Brackish: ['Community', 'Puffer', 'Other']
};
const FILTER_TYPES = [['hob', 'Hang-on-back (HOB)'], ['canister', 'Canister'], ['sump', 'Sump'], ['sponge', 'Sponge'], ['internal', 'Internal'], ['undergravel', 'Undergravel'], ['other', 'Other']];
const FILTER_KEYS = FILTER_TYPES.map((x) => x[0]);
const FILTER_SHORT = { hob: 'HOB', canister: 'Canister', sump: 'Sump', sponge: 'Sponge', internal: 'Internal', undergravel: 'Undergravel', other: 'Other' };
const SIZE_PRESETS = {
  gallons: [5, 10, 15, 20, 29, 40, 55, 75, 90, 125, 150, 180, 220, 300],
  liters: [20, 40, 60, 100, 150, 200, 300, 400, 500, 700, 1000]
};
const TANK_PHOTO_SIDE = 800;
const SPECIES_PHOTO_SIDE = 640;
const MAX_TANKS = 12;

function uid() {
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function newTank(partial) {
  return Object.assign({
    id: uid(), name: '', size: '', unit: 'gallons', type: 'Freshwater', style: '',
    filter: '', photo: '', started: '', notes: '', fish: [], log: [], tasks: [], gear: [], gearSkip: [], dismissed: []
  }, partial || {});
}

function cleanFish(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((f) => f && typeof f.name === 'string' && f.name.trim())
    .map((f) => {
      const item = { name: f.name.trim().slice(0, 60), count: Math.min(999, Math.max(1, Math.round(Number(f.count)) || 1)) };
      if (KIND_LIST.includes(f.kind)) item.kind = f.kind;
      if (typeof f.photo === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(f.photo) && f.photo.length < 600000) item.photo = f.photo;
      return item;
    });
}

// Accepts anything from storage and returns a safe tank (or null).
function cleanTank(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const t = newTank();
  if (typeof raw.id === 'string' && raw.id) t.id = raw.id.slice(0, 40);
  t.name = typeof raw.name === 'string' ? raw.name.slice(0, 40) : '';
  const size = Number(raw.size);
  t.size = isFinite(size) && size > 0 && size <= 5000 ? String(size) : '';
  t.unit = raw.unit === 'liters' ? 'liters' : 'gallons';
  t.type = TYPES.includes(raw.type) ? raw.type : 'Freshwater';
  t.style = typeof raw.style === 'string' && STYLES[t.type].includes(raw.style) ? raw.style : '';
  t.filter = FILTER_KEYS.includes(raw.filter) ? raw.filter : '';
  t.photo = typeof raw.photo === 'string' && raw.photo.startsWith('data:image/') ? raw.photo : '';
  t.started = typeof raw.started === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.started) ? raw.started : '';
  t.notes = typeof raw.notes === 'string' ? raw.notes.slice(0, 400) : '';
  t.fish = cleanFish(raw.fish);
  t.log = cleanLog(raw.log);
  t.tasks = cleanTasks(raw.tasks);
  t.gear = cleanGear(raw.gear);
  t.gearSkip = cleanStrings(raw.gearSkip, 30, 80);
  t.dismissed = cleanStrings(raw.dismissed, 60, 200);
  return t;
}

// ---------- Water log and reminders ----------
const DAY_MS = 86400000;
const LOG_FIELDS = {
  temp: { label: 'Temperature', unit: '°F', min: 32, max: 110, hint: '78' },
  ph: { label: 'pH', unit: '', min: 0, max: 14, hint: '7.2' },
  nh3: { label: 'Ammonia', unit: 'ppm', min: 0, max: 20, hint: '0' },
  no2: { label: 'Nitrite', unit: 'ppm', min: 0, max: 20, hint: '0' },
  no3: { label: 'Nitrate', unit: 'ppm', min: 0, max: 500, hint: '10' },
  sg: { label: 'Salinity', unit: 'SG', min: 1, max: 1.04, hint: '1.025' },
  gh: { label: 'GH', unit: 'dGH', min: 0, max: 60, hint: '' },
  kh: { label: 'KH', unit: 'dKH', min: 0, max: 40, hint: '' },
  tds: { label: 'TDS', unit: 'ppm', min: 0, max: 3000, hint: '' },
  po4: { label: 'Phosphate', unit: 'ppm', min: 0, max: 20, hint: '' },
  ca: { label: 'Calcium', unit: 'ppm', min: 0, max: 800, hint: '420' },
  alk: { label: 'Alkalinity', unit: 'dKH', min: 0, max: 20, hint: '8' },
  mg: { label: 'Magnesium', unit: 'ppm', min: 0, max: 2000, hint: '1300' }
};
const LOG_SETS = {
  Freshwater: ['temp', 'ph', 'nh3', 'no2', 'no3', 'gh', 'kh', 'tds', 'po4'],
  Saltwater: ['temp', 'sg', 'ph', 'nh3', 'no2', 'no3', 'po4', 'ca', 'alk', 'mg'],
  Brackish: ['temp', 'sg', 'ph', 'nh3', 'no2', 'no3', 'kh', 'gh']
};
const LOG_CORE = ['temp', 'sg', 'ph', 'nh3', 'no2', 'no3'];
const MAX_LOG = 500;
const MAX_TASKS = 20;
const TASK_PRESETS = [
  { kind: 'change', label: 'Water change', days: 7 },
  { kind: 'test', label: 'Test the water', days: 7 },
  { kind: 'filter', label: 'Clean the filter', days: 30 },
  { kind: 'glass', label: 'Clean the glass', days: 7 },
  { kind: 'media', label: 'Replace filter carbon or media', days: 60 },
  { kind: 'plants', label: 'Trim plants and dose fertilizer', days: 7, only: 'Freshwater' },
  { kind: 'skimmer', label: 'Empty the skimmer cup', days: 7, only: 'Saltwater' }
];
const TASK_STARTER = ['change', 'test', 'filter'];
const TASK_EVERY = [1, 2, 3, 5, 7, 10, 14, 21, 30, 45, 60, 90, 180];

function cleanLog(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  list.forEach((r) => {
    if (!r || typeof r !== 'object') return;
    const t = Number(r.t);
    if (!isFinite(t) || t <= 0) return;
    const e = { id: typeof r.id === 'string' && r.id ? r.id.slice(0, 40) : uid(), t: Math.round(t), k: r.k === 'change' ? 'change' : 'test', v: {}, note: typeof r.note === 'string' ? r.note.slice(0, 200) : '' };
    if (r.v && typeof r.v === 'object') {
      Object.keys(LOG_FIELDS).forEach((key) => {
        const n = Number(r.v[key]);
        const f = LOG_FIELDS[key];
        if (r.v[key] != null && r.v[key] !== '' && isFinite(n) && n >= f.min && n <= f.max) e.v[key] = n;
      });
    }
    if (e.k === 'change') {
      const p = Number(r.pct);
      e.pct = isFinite(p) && p > 0 && p <= 100 ? Math.round(p) : 0;
    } else if (!Object.keys(e.v).length) return;
    if (e.k === 'test' && r.cleared === true) e.cleared = true;
    out.push(e);
  });
  return out.sort((a, b) => a.t - b.t).slice(-MAX_LOG);
}

function cleanTasks(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  list.slice(0, MAX_TASKS).forEach((r) => {
    if (!r || typeof r !== 'object' || typeof r.label !== 'string' || !r.label.trim()) return;
    const every = Math.round(Number(r.every));
    const last = Number(r.last);
    out.push({
      id: typeof r.id === 'string' && r.id ? r.id.slice(0, 40) : uid(),
      kind: typeof r.kind === 'string' ? r.kind.slice(0, 12) : 'custom',
      label: r.label.trim().slice(0, 40),
      every: isFinite(every) && every >= 1 && every <= 365 ? every : 7,
      last: isFinite(last) && last > 0 ? Math.round(last) : Date.now(),
      snooze: isFinite(Number(r.snooze)) && Number(r.snooze) > 0 ? Math.round(Number(r.snooze)) : 0
    });
  });
  return out;
}

function fmtDay(ts) {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function startOfDay(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
function daysBetween(fromTs, toTs) {
  return Math.round((startOfDay(toTs) - startOfDay(fromTs)) / DAY_MS);
}
function agoText(ts) {
  const n = daysBetween(ts, Date.now());
  if (n <= 0) return 'today';
  if (n === 1) return 'yesterday';
  return n + ' days ago';
}
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function dateFromInput(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str || '');
  if (!m) return Date.now();
  const now = new Date();
  const same = str === todayStr();
  const d = new Date(+m[1], +m[2] - 1, +m[3], same ? now.getHours() : 12, same ? now.getMinutes() : 0);
  return Math.min(d.getTime(), Date.now());
}
function fmtVal(key, v) {
  return key === 'sg' ? v.toFixed(3) : String(Math.round(v * 100) / 100);
}
function fieldLabel(key) {
  const f = LOG_FIELDS[key];
  return f.label + (f.unit ? ' (' + f.unit + ')' : '');
}
function isYoung(t) {
  if (!t.started) return false;
  const d = Date.parse(t.started + 'T12:00:00');
  return isFinite(d) && Date.now() - d < 60 * DAY_MS;
}
function isReef(t) {
  return t.type === 'Saltwater' && /reef/i.test(t.style || '');
}

// The pH or temperature range that suits everything in the tank, when the species list knows them all.
function wantRange(t, idx) {
  let lo = -Infinity, hi = Infinity, n = 0;
  t.fish.forEach((f) => {
    const e = lookupSpecies(f.name);
    const r = e && e.c && e.c[idx];
    if (r && r.length === 2 && isFinite(r[0]) && isFinite(r[1])) { lo = Math.max(lo, r[0]); hi = Math.min(hi, r[1]); n++; }
  });
  return n && lo <= hi ? { lo, hi, roster: true } : null;
}
function defaultRange(t, idx) {
  const D = {
    p: { Freshwater: [6.5, 7.8], Saltwater: [8.0, 8.4], Brackish: [7.5, 8.5] },
    t: { Freshwater: [72, 80], Saltwater: [75, 80], Brackish: [74, 82] }
  };
  const r = D[idx][t.type] || D[idx].Freshwater;
  return { lo: r[0], hi: r[1], roster: false };
}
function rangeFor(t, idx) {
  return wantRange(t, idx) || defaultRange(t, idx);
}
function rangeText(r, unit) {
  return Math.round(r.lo * 10) / 10 + '-' + Math.round(r.hi * 10) / 10 + (unit || '');
}

// Plain-English check of one reading. Returns { level, text } or null when there is nothing useful to say.
function judgeValue(t, key, v) {
  const mk = (level, text) => ({ level, text });
  const young = isYoung(t);
  const cycle = young ? ' This is normal while a new tank is still cycling.' : '';
  const salt = t.type === 'Saltwater';
  if (key === 'nh3' || key === 'no2') {
    const name = key === 'nh3' ? 'ammonia' : 'nitrite';
    if (v < 0.05) return mk('ok', 'No ' + name + '. Good.');
    if (v <= 0.25) return mk('warn', 'A trace of ' + name + '. Do a 25% water change and check the filter.' + cycle);
    return mk('bad', name.charAt(0).toUpperCase() + name.slice(1) + ' is toxic. Do a 30-50% water change now, feed lightly and check the filter.' + cycle);
  }
  if (key === 'no3') {
    const lim = isReef(t) ? [10, 20] : salt ? [20, 40] : [20, 40];
    if (v <= lim[0]) return mk('ok', 'Nitrate is low. Good.');
    if (v <= lim[1]) return mk('warn', 'Nitrate is climbing. Plan a water change.');
    return mk('bad', 'Nitrate is high. Do a 30-50% water change and test again in a day or two.');
  }
  if (key === 'ph') {
    const r = rangeFor(t, 'p');
    const d = v < r.lo ? r.lo - v : v > r.hi ? v - r.hi : 0;
    const who = r.roster ? 'your animals' : 'this kind of tank';
    if (d <= 0.3) return mk('ok', 'pH suits ' + who + ' (' + rangeText(r) + ').');
    if (d <= 0.8) return mk('warn', 'A little outside what ' + who + ' prefer (' + rangeText(r) + '). Change it slowly, never in one jump.');
    return mk('bad', 'Far from what ' + who + ' want (' + rangeText(r) + '). Fix it gradually with water changes and test again.');
  }
  if (key === 'temp') {
    const r = rangeFor(t, 't');
    const d = v < r.lo ? r.lo - v : v > r.hi ? v - r.hi : 0;
    const who = r.roster ? 'your animals' : 'this kind of tank';
    if (d <= 1) return mk('ok', 'Temperature suits ' + who + ' (' + rangeText(r, '°F') + ').');
    if (d <= 4) return mk('warn', 'A little outside what ' + who + ' prefer (' + rangeText(r, '°F') + '). Check the heater and thermometer.');
    return mk('bad', 'Well outside what ' + who + ' want (' + rangeText(r, '°F') + '). Check the heater now and adjust slowly.');
  }
  if (key === 'sg') {
    if (salt) {
      if (v >= 1.023 && v <= 1.026) return mk('ok', 'Salinity is on target.');
      if (v >= 1.020 && v <= 1.028) return mk('warn', 'A bit off. Aim for 1.024-1.026 and adjust slowly.');
      return mk('bad', 'Far from the 1.024-1.026 target. Fix gradually with top-off water or mixed salt water.');
    }
    if (t.type === 'Brackish') {
      if (v >= 1.002 && v <= 1.018) return mk('ok', 'In the normal brackish range. Match what your fish need.');
      return mk('warn', 'Outside the usual brackish range (1.002-1.018). Check what your fish need.');
    }
    return null;
  }
  if (key === 'po4') {
    const lim = salt ? [0.1, 0.3] : [1, 2.5];
    if (v <= lim[0]) return mk('ok', 'Phosphate is low. Good.');
    if (v <= lim[1]) return mk('warn', 'Phosphate is a little high and can feed algae.');
    return mk('bad', 'Phosphate is high and will feed algae. Do water changes and check your food and filter media.');
  }
  if (key === 'kh' && !salt) {
    if (v < 3) return mk('warn', 'KH is low, so pH can swing. Raise it gradually.');
    return mk('ok', 'KH gives pH a stable buffer.');
  }
  if (key === 'alk') {
    if (v >= 7 && v <= 11) return mk('ok', 'Alkalinity is in a good range.');
    if (v >= 6 && v <= 12) return mk('warn', 'Alkalinity is a bit off (aim for 7-11 dKH). Adjust slowly.');
    return mk('bad', 'Alkalinity is far off (aim for 7-11 dKH). Change it slowly, and no more than 1 dKH a day.');
  }
  if (key === 'ca') {
    if (v >= 380 && v <= 450) return mk('ok', 'Calcium is in a good range.');
    if (v >= 350 && v <= 480) return mk('warn', 'Calcium is a bit off (aim for 380-450 ppm).');
    return mk('bad', 'Calcium is far off (aim for 380-450 ppm).');
  }
  if (key === 'mg') {
    if (v >= 1200 && v <= 1450) return mk('ok', 'Magnesium is in a good range.');
    if (v >= 1100 && v <= 1550) return mk('warn', 'Magnesium is a bit off (aim for 1200-1450 ppm).');
    return mk('bad', 'Magnesium is far off (aim for 1200-1450 ppm).');
  }
  return null;
}

// The "good" band drawn behind a trend line, or null.
function judgeBand(t, key) {
  if (key === 'ph') { const r = rangeFor(t, 'p'); return [r.lo - 0.3, r.hi + 0.3]; }
  if (key === 'temp') { const r = rangeFor(t, 't'); return [r.lo - 1, r.hi + 1]; }
  if (key === 'nh3' || key === 'no2') return [0, 0.05];
  if (key === 'no3') return [0, isReef(t) ? 10 : 20];
  if (key === 'sg') return t.type === 'Saltwater' ? [1.023, 1.026] : t.type === 'Brackish' ? [1.002, 1.018] : null;
  if (key === 'po4') return [0, t.type === 'Saltwater' ? 0.1 : 1];
  if (key === 'alk') return [7, 11];
  if (key === 'ca') return [380, 450];
  if (key === 'mg') return [1200, 1450];
  return null;
}

const LEVEL_RANK = { ok: 0, warn: 1, bad: 2 };
function entryChecks(t, e) {
  return logKeys(t).filter((k) => e.v[k] != null).map((k) => ({ key: k, val: e.v[k], j: judgeValue(t, k, e.v[k]) }));
}
function worstLevel(checks) {
  let w = 'ok';
  checks.forEach((c) => { if (c.j && LEVEL_RANK[c.j.level] > LEVEL_RANK[w]) w = c.j.level; });
  return w;
}
function logKeys(t) {
  return LOG_SETS[t.type] || LOG_SETS.Freshwater;
}
const LEVEL_WORDS = { ok: 'All good', warn: 'Keep an eye on it', bad: 'Needs action' };

// ----- Water log screen -----
let logForm = null; // { mode: 'test' | 'change', pct }
let logParam = '';
let logAll = false;
let logDelete = '';
function putAll(parent, ...nodes) {
  parent.append(...nodes.filter(Boolean));
}


// A labelled drop-down for choosing which tank a check or scan is for. Works for any number of tanks.
function tankSwitcher(current, label, onPick, noneLabel) {
  if (!state.tanks.length || (!noneLabel && (!current || state.tanks.length < 2))) return null;
  const sel = el('select', { class: 'select', 'aria-label': label },
    ...state.tanks.map((x) => el('option', { value: x.id, text: tankLabel(x), selected: !!current && x.id === current.id })),
    noneLabel ? el('option', { value: '', text: noneLabel, selected: !current }) : null);
  sel.addEventListener('change', () => onPick(sel.value));
  return el('div', { class: 'tank-switch' }, el('span', { class: 'label small', text: label }), sel);
}

function setActiveTank(id) {
  if (!getTank(id)) return;
  state.activeId = id;
  fishCheckTankId = '';
  saveState();
}


function svgEl(tag, attrs, ...kids) {
  const n = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs || {}).forEach(([k, v]) => n.setAttribute(k, String(v)));
  kids.flat().forEach((k) => { if (k != null) n.append(k); });
  return n;
}

function logChart(t, key) {
  const pts = t.log.filter((e) => e.k === 'test' && e.v[key] != null).slice(-30).map((e) => ({ t: e.t, v: e.v[key] }));
  if (pts.length < 2) return null;
  const W = 320, H = 150, L = 44, R = 10, T = 10, B = 26;
  const band = judgeBand(t, key);
  let lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v));
  if (band) { lo = Math.min(lo, band[0]); hi = Math.max(hi, band[1]); }
  if (hi === lo) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.1;
  lo = Math.max(LOG_FIELDS[key].min, lo - pad);
  hi += pad;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const sx = (x) => (t1 === t0 ? (L + W - R) / 2 : L + ((x - t0) / (t1 - t0)) * (W - L - R));
  const sy = (v) => T + ((hi - v) / (hi - lo)) * (H - T - B);
  const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'log-chart', role: 'img', 'aria-label': LOG_FIELDS[key].label + ' over time: ' + pts.map((p) => fmtVal(key, p.v)).join(', ') });
  if (band) {
    const y1 = sy(Math.min(band[1], hi)), y2 = sy(Math.max(band[0], lo));
    svg.append(svgEl('rect', { x: L, y: y1, width: W - L - R, height: Math.max(2, y2 - y1), class: 'chart-band' }));
  }
  svg.append(svgEl('line', { x1: L, y1: T, x2: L, y2: H - B, class: 'chart-axis' }), svgEl('line', { x1: L, y1: H - B, x2: W - R, y2: H - B, class: 'chart-axis' }));
  const txt = (x, y, anchor, s) => { const n = svgEl('text', { x, y, 'text-anchor': anchor, class: 'chart-t' }); n.textContent = s; return n; };
  svg.append(txt(L - 5, T + 8, 'end', fmtVal(key, hi)), txt(L - 5, H - B, 'end', fmtVal(key, lo)), txt(L, H - 8, 'start', fmtDay(t0)), txt(W - R, H - 8, 'end', fmtDay(t1)));
  svg.append(svgEl('polyline', { points: pts.map((p) => sx(p.t).toFixed(1) + ',' + sy(p.v).toFixed(1)).join(' '), class: 'chart-line', fill: 'none' }));
  pts.forEach((p) => svg.append(svgEl('circle', { cx: sx(p.t).toFixed(1), cy: sy(p.v).toFixed(1), r: 3.5, class: 'chart-dot' })));
  return svg;
}

let latestOpen = false;
function logSummaryCard(t) {
  const tests = t.log.filter((e) => e.k === 'test');
  const card = el('div', { class: 'card' });
  if (!tests.length) {
    card.append(el('h2', { text: 'No readings yet' }),
      el('p', { class: 'muted', text: 'Log a test from your kit to see what your numbers mean for ' + tankLabel(t) + ' and watch them over time.' }));
    return card;
  }
  const last = tests[tests.length - 1];
  const checks = entryChecks(t, last);
  const worst = worstLevel(checks);
  const det = el('details', { class: 'card group-card log-latest' });
  det.open = latestOpen;
  det.addEventListener('toggle', () => { latestOpen = det.open; });
  const dots = el('div', { class: 'log-dots' });
  checks.forEach((c) => dots.append(el('span', { class: 'log-dot ' + (c.j ? c.j.level : 'ok'), text: LOG_FIELDS[c.key].label })));
  det.append(el('summary', { class: 'group-sum log-latest-sum' },
    el('div', { class: 'log-latest-main' },
      el('div', { class: 'water-line' }, el('h2', { text: 'Latest test' }), el('span', { class: 'pill ' + worst, text: LEVEL_WORDS[worst] })),
      el('p', { class: 'muted small', text: fmtDay(last.t) + ' · ' + agoText(last.t) }), dots),
    el('span', { class: 'chev', text: '›' })));
  const list = el('div', { class: 'log-values' });
  checks.forEach((c) => {
    list.append(el('div', { class: 'log-val' },
      el('div', { class: 'water-line' }, el('span', { text: LOG_FIELDS[c.key].label }), el('strong', { text: fmtVal(c.key, c.val) + (LOG_FIELDS[c.key].unit ? ' ' + LOG_FIELDS[c.key].unit : '') })),
      c.j && c.j.level !== 'ok' ? el('div', { class: 'log-note ' + c.j.level, text: c.j.text }) : null));
  });
  const inner = el('div', { class: 'log-latest-body' }, list);
  if (daysBetween(last.t, Date.now()) >= 14) inner.append(el('p', { class: 'muted small', text: 'It has been a while. Test again to see where the tank stands now.' }));
  det.append(inner);
  return det;
}

function submitTest(t, inputs, dateInput, noteInput) {
  const v = {};
  let bad = '';
  Object.keys(inputs).forEach((key) => {
    const raw = inputs[key].value.trim();
    if (!raw) return;
    const n = parseFloat(raw.replace(',', '.'));
    const f = LOG_FIELDS[key];
    if (!isFinite(n) || n < f.min || n > f.max) bad = bad || f.label + ' should be between ' + f.min + ' and ' + f.max + '.';
    else v[key] = n;
  });
  if (bad) { toast(bad); return; }
  if (!Object.keys(v).length) { toast('Enter at least one reading.'); return; }
  addLogEntry(t, { id: uid(), t: dateFromInput(dateInput.value), k: 'test', v, note: noteInput.value.trim().slice(0, 200) });
  logForm = null;
  logParam = '';
  renderLog();
}

function addLogEntry(t, e) {
  t.log.push(e);
  t.log.sort((a, b) => a.t - b.t);
  if (t.log.length > MAX_LOG) t.log = t.log.slice(-MAX_LOG);
  const kind = e.k === 'change' ? 'change' : 'test';
  t.tasks.forEach((k) => { if (k.kind === kind && e.t > k.last) { k.last = e.t; k.snooze = 0; } });
  if (!saveState()) toast('Could not save. Your phone storage may be full.');
  updateBadge();
}

function logFormCard(t) {
  const card = el('div', { class: 'card log-form' });
  const dateInput = el('input', { type: 'date', class: 'date-input', value: todayStr(), max: todayStr(), 'aria-label': 'Date' });
  const noteInput = el('input', { type: 'text', placeholder: 'Note (optional)', maxlength: '200', 'aria-label': 'Note' });
  if (logForm.mode === 'change') {
    card.append(el('h2', { text: 'Log a water change' }));
    const chips = el('div', { class: 'chips' }, ...[10, 20, 25, 30, 50].map((p) => el('button', { type: 'button', class: 'chip-btn' + (logForm.pct === p ? ' on' : ''), 'aria-pressed': logForm.pct === p ? 'true' : 'false', text: p + '%', onclick: () => { logForm.pct = p; renderLog(); } })));
    card.append(el('span', { class: 'label', text: 'How much did you change?' }), chips,
      el('label', { class: 'log-field' }, el('span', { class: 'label', text: 'Date' }), dateInput), noteInput,
      el('div', { class: 'row-actions' },
        el('button', { type: 'button', class: 'btn primary small', text: 'Save', onclick: () => {
          if (!logForm.pct) { toast('Pick how much you changed.'); return; }
          addLogEntry(t, { id: uid(), t: dateFromInput(dateInput.value), k: 'change', v: {}, pct: logForm.pct, note: noteInput.value.trim().slice(0, 200) });
          logForm = null; renderLog();
        } }),
        el('button', { type: 'button', class: 'btn link', text: 'Cancel', onclick: () => { logForm = null; renderLog(); } })));
    return card;
  }
  const inputs = {};
  const field = (key) => {
    const f = LOG_FIELDS[key];
    inputs[key] = el('input', { type: 'number', inputmode: 'decimal', step: 'any', placeholder: f.hint, 'aria-label': f.label });
    return el('label', { class: 'log-field' }, el('span', { class: 'label', text: fieldLabel(key) }), inputs[key]);
  };
  const keys = logKeys(t);
  const core = keys.filter((k) => LOG_CORE.includes(k));
  const more = keys.filter((k) => !LOG_CORE.includes(k));
  card.append(el('h2', { text: 'Log a test' }), el('p', { class: 'muted small', text: 'Fill in only what you tested.' }),
    el('div', { class: 'log-grid' }, ...core.map(field)));
  if (more.length) card.append(el('details', { class: 'log-more' }, el('summary', { text: 'More tests' }), el('div', { class: 'log-grid' }, ...more.map(field))));
  card.append(el('label', { class: 'log-field' }, el('span', { class: 'label', text: 'Date' }), dateInput), noteInput,
    el('div', { class: 'row-actions' },
      el('button', { type: 'button', class: 'btn primary small', text: 'Save test', onclick: () => submitTest(t, inputs, dateInput, noteInput) }),
      el('button', { type: 'button', class: 'btn link', text: 'Cancel', onclick: () => { logForm = null; renderLog(); } })));
  return card;
}

function logTrendCard(t) {
  const tests = t.log.filter((e) => e.k === 'test');
  const keys = logKeys(t).filter((k) => tests.filter((e) => e.v[k] != null).length >= 2);
  if (!keys.length) {
    return tests.length ? el('div', { class: 'card' }, el('h2', { text: 'Trends' }), el('p', { class: 'muted', text: 'Log one more test and you will see how each number moves over time.' })) : null;
  }
  if (!keys.includes(logParam)) logParam = keys.includes('nh3') ? 'nh3' : keys[0];
  const vals = tests.filter((e) => e.v[logParam] != null).map((e) => e.v[logParam]);
  const diff = vals[vals.length - 1] - vals[0];
  const card = el('div', { class: 'card' }, el('h2', { text: 'Trends' }),
    el('div', { class: 'chips' }, ...keys.map((k) => el('button', { type: 'button', class: 'chip-btn' + (k === logParam ? ' on' : ''), 'aria-pressed': k === logParam ? 'true' : 'false', text: LOG_FIELDS[k].label, onclick: () => { logParam = k; renderLog(); } }))),
    logChart(t, logParam),
    el('p', { class: 'muted small', text: 'Latest ' + fmtVal(logParam, vals[vals.length - 1]) + (LOG_FIELDS[logParam].unit ? ' ' + LOG_FIELDS[logParam].unit : '') + (diff === 0 ? ', unchanged since your first reading.' : ', ' + (diff > 0 ? 'up' : 'down') + ' from ' + fmtVal(logParam, vals[0]) + ' at your first reading.') + (judgeBand(t, logParam) ? ' The shaded band is the good range.' : '') }));
  return card;
}

function logHistoryCard(t) {
  if (!t.log.length) return null;
  const rows = t.log.slice().reverse();
  const shown = logAll ? rows : rows.slice(0, 10);
  const card = el('div', { class: 'card' }, el('h2', { text: 'History' }));
  shown.forEach((e) => {
    let line, pill = null;
    if (e.k === 'change') line = 'Water change' + (e.pct ? ', ' + e.pct + '%' : '');
    else {
      const checks = entryChecks(t, e);
      line = checks.map((c) => LOG_FIELDS[c.key].label + ' ' + fmtVal(c.key, c.val)).join(' · ');
      const w = worstLevel(checks);
      pill = el('span', { class: 'pill ' + w, text: w === 'ok' ? 'Good' : w === 'warn' ? 'Watch' : 'Act' });
    }
    const confirming = logDelete === e.id;
    card.append(el('div', { class: 'log-row' },
      el('div', { class: 'log-row-main' }, el('div', { class: 'water-line' }, el('strong', { text: fmtDay(e.t) }), pill), el('span', { class: 'muted small', text: line }), e.note ? el('span', { class: 'muted small', text: '“' + e.note + '”' }) : null),
      el('button', { type: 'button', class: 'btn link small-link', text: confirming ? 'Tap to confirm' : 'Delete', 'aria-label': 'Delete the ' + fmtDay(e.t) + ' entry', onclick: () => {
        if (!confirming) { logDelete = e.id; renderLog(); return; }
        t.log = t.log.filter((x) => x.id !== e.id); logDelete = ''; saveState(); renderLog();
      } })));
  });
  if (rows.length > 10) card.append(el('button', { type: 'button', class: 'btn link', text: logAll ? 'Show fewer' : 'Show all ' + rows.length, onclick: () => { logAll = !logAll; renderLog(); } }));
  return card;
}

// ----- What to do: treatments and chemicals picked from the latest test -----
const REEF_SUPPLEMENT = { tier: 'Popular', name: 'Red Sea Foundation supplements', spec: 'Calcium+, KH/Alkalinity and Magnesium supplements made to go with Red Sea tests. Follow the label.' };

function treatmentsFor(t) {
  const tests = t.log.filter((e) => e.k === 'test');
  if (!tests.length) return null;
  const last = tests[tests.length - 1];
  const checks = entryChecks(t, last).filter((c) => c.j && c.j.level !== 'ok');
  const young = isYoung(t) ? ' This is normal while a new tank is still cycling.' : '';
  const cond = gearPicks('Water conditioner', t)[0] || null;
  const list = [];
  checks.forEach((c) => {
    const lvl = c.j.level;
    const add = (title, text, pick, kind) => list.push({ key: c.key, level: lvl, title, text, pick: pick || null, kind: kind || '' });
    if (c.key === 'nh3' || c.key === 'no2') {
      const nm = c.key === 'nh3' ? 'Ammonia' : 'Nitrite';
      add(nm + ' is ' + (lvl === 'bad' ? 'high' : 'showing'), 'Do a 25 to 50% water change, feed lightly and check the filter. A conditioner that detoxifies ' + nm.toLowerCase() + ' can help while the filter catches up.' + young, cond, 'Water conditioner');
    } else if (c.key === 'no3') {
      add('Nitrate is ' + (lvl === 'bad' ? 'high' : 'climbing'), 'Water changes are the fix. No product needed.');
    } else if (c.key === 'ph') {
      add('pH is off', 'Move it slowly with water changes. A steady pH matters more than a perfect one, so avoid quick fixes.');
    } else if (c.key === 'kh' && t.type !== 'Saltwater') {
      add('KH is low', 'Low KH lets pH swing. An aquarium carbonate-hardness buffer can raise it gradually. Test again after each change.');
    } else if (c.key === 'sg') {
      add('Salinity is off', c.val > 1.026 ? 'Top off with fresh RO/DI water to bring it down slowly.' : 'Add mixed salt water slowly to bring it up.');
    } else if (c.key === 'po4') {
      add('Phosphate is high', 'Water changes, a look at how much you feed, and fresh filter media. A phosphate-removing media is an option for stubborn algae.');
    } else if (c.key === 'alk' || c.key === 'ca' || c.key === 'mg') {
      const low = c.key === 'alk' ? c.val < 7 : c.key === 'ca' ? c.val < 380 : c.val < 1200;
      const nm = LOG_FIELDS[c.key].label;
      if (low) add(nm + ' is low', 'A reef supplement made for ' + nm.toLowerCase() + ' raises it. Change it slowly and test again before the next dose.', REEF_SUPPLEMENT, 'Other');
      else add(nm + ' is high', 'Stop adding ' + nm.toLowerCase() + ' for now and let water changes bring it down. Test again in a few days.');
    } else if (c.key === 'temp') {
      add('Temperature is off', 'Check the heater and thermometer. Adjust slowly, no more than a degree or two a day.');
    }
  });
  return { last, list };
}

function addPickToGear(t, kind, name) {
  if (t.gear.some((g) => g.name === name)) { toast('Already in your equipment list.'); return; }
  if (t.gear.length >= 40) { toast('That is the most equipment one tank can list.'); return; }
  t.gear.push({ id: uid(), kind: GEAR_KINDS.includes(kind) ? kind : 'Other', name: name.slice(0, 60), note: '', added: todayISO() });
  saveState();
  toast('Added to your equipment list.');
}

function treatCard(t) {
  const r = treatmentsFor(t);
  if (!r) return null;
  const lastTest = t.log.filter((e) => e.k === 'test').slice(-1)[0];
  if (lastTest && lastTest.cleared) return null;
  const card = el('div', { class: 'card treat-card' }, el('div', { class: 'water-line' }, el('h2', { text: 'What to do' }),
    r.list.length ? el('button', { type: 'button', class: 'btn small', text: 'Clear', 'aria-label': 'Clear these treatments', onclick: () => { lastTest.cleared = true; saveState(); renderLog(); toast('Cleared. A new test will bring them back if needed.'); } }) : null));
  if (!r.list.length) {
    card.append(el('p', { class: 'muted', text: 'No treatments needed. Your latest test looks fine for ' + tankLabel(t) + '.' }));
    return card;
  }
  r.list.forEach((x) => {
    card.append(el('div', { class: 'tip-row ' + x.level },
      el('div', { class: 'water-line' }, el('strong', { text: x.title }), el('span', { class: 'pill ' + (x.level === 'bad' ? 'bad' : 'warn'), text: x.level === 'bad' ? 'Now' : 'Soon' })),
      el('p', { class: 'muted small', text: x.text }),
      x.pick ? el('button', { type: 'button', class: 'pick', 'aria-label': 'Add ' + x.pick.name + ' to my equipment', onclick: () => { addPickToGear(t, x.kind, x.pick.name); } },
        el('span', { class: 'pick-tier', text: 'Treatment' }), el('strong', { text: x.pick.name }), el('span', { class: 'sub', text: x.pick.spec + ' Tap if you have it.' })) : null));
  });
  card.append(el('p', { class: 'muted small', text: 'These are suggestions from your readings. Always follow the product label. ' + GEAR_DISCLAIMER }));
  return card;
}

// ----- Scan a test strip or tubes -----
const scanState = { step: 'kit', kit: 'unknown', rows: [], msg: '', note: '', chart: true, tank: '' };

function closeScanSheet() {
  const sh = $('scan-sheet');
  if (!sh || sh.hidden) return;
  sh.hidden = true;
  sh.replaceChildren();
  scanState.step = 'kit';
}
function openScanSheet() {
  const t = getTank(openTankId);
  if (!t) return;
  scanState.step = 'kit'; scanState.kit = 'unknown'; scanState.rows = []; scanState.msg = ''; scanState.note = ''; scanState.tank = t.id;
  $('scan-sheet').hidden = false;
  renderScanSheet();
}
function scanShell(title, ...kids) {
  return [el('div', { class: 'sheet-dim', onclick: closeScanSheet }),
    el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      el('div', { class: 'sheet-grab', 'aria-hidden': 'true' }),
      el('div', { class: 'sheet-head' }, el('h2', { text: title }), el('button', { type: 'button', class: 'sheet-x', 'aria-label': 'Close', text: '×', onclick: closeScanSheet })),
      ...kids)];
}
function pickScanFile(camera) {
  const input = el('input', { type: 'file', accept: 'image/*,.heic,.heif' });
  if (camera) input.setAttribute('capture', 'environment');
  input.addEventListener('change', () => { if (input.files && input.files[0]) runWaterScan(input.files[0]); });
  input.click();
}
function renderScanSheet() {
  const sh = $('scan-sheet');
  const t = getTank(scanState.tank);
  if (!t) { closeScanSheet(); return; }
  if (scanState.step === 'kit') {
    const kitBtn = (id, label) => el('button', { type: 'button', class: 'chip-btn' + (scanState.kit === id ? ' on' : ''), 'aria-pressed': scanState.kit === id ? 'true' : 'false', text: label, onclick: () => { scanState.kit = id; renderScanSheet(); } });
    sh.replaceChildren(...scanShell('Scan a test',
      el('p', { class: 'muted small', text: 'What kind of test did you use?' }),
      el('div', { class: 'chips' }, kitBtn('strips', 'Test strips'), kitBtn('tubes', 'Liquid tubes'), kitBtn('unknown', 'Not sure')),
      el('p', { class: 'muted small', text: scanState.kit === 'strips' ? 'Hold the strip beside the color chart on the bottle, with the pads in view.' : scanState.kit === 'tubes' ? 'Stand the tubes in front of the kit color card, all in one photo.' : 'Get the strip or tubes and the color chart in the same photo.' }),
      el('p', { class: 'muted small', text: 'Use daylight if you can. A colored tank light changes how the colors look.' }),
      el('div', { class: 'row-actions wide' },
        el('button', { type: 'button', class: 'btn primary', text: 'Take a photo', onclick: () => pickScanFile(true) }),
        el('button', { type: 'button', class: 'btn', text: 'Upload a photo', onclick: () => pickScanFile(false) }))));
  } else if (scanState.step === 'wait') {
    sh.replaceChildren(...scanShell('Reading your test', el('p', { class: 'muted', text: 'Matching the colors to your chart. This takes a few seconds.' })));
  } else if (scanState.step === 'error') {
    sh.replaceChildren(...scanShell('Could not read it',
      el('p', { class: 'muted', text: scanState.msg }),
      el('div', { class: 'row-actions wide' },
        el('button', { type: 'button', class: 'btn primary', text: 'Try another photo', onclick: () => { scanState.step = 'kit'; renderScanSheet(); } }),
        el('button', { type: 'button', class: 'btn', text: 'Type readings instead', onclick: () => { closeScanSheet(); logForm = { mode: 'test' }; renderLog(); } }))));
  } else {
    const inputs = {};
    const rows = scanState.rows.map((r) => {
      inputs[r.key] = el('input', { type: 'number', inputmode: 'decimal', step: 'any', value: String(r.value), 'aria-label': LOG_FIELDS[r.key].label });
      return el('label', { class: 'scan-row' },
        el('span', {}, el('span', { text: fieldLabel(r.key) }), r.confident ? null : el('span', { class: 'pill warn', text: 'Not sure' })), inputs[r.key]);
    });
    sh.replaceChildren(...scanShell('Check your readings',
      el('p', { class: 'muted small', text: 'These are my best guesses from the photo. Check each one against your color chart and fix anything that looks off.' }),
      scanState.chart ? null : el('p', { class: 'muted small', text: 'I could not see a color chart, so treat every number as a guess.' }),
      scanState.note ? el('p', { class: 'muted small', text: scanState.note }) : null,
      rows.length ? el('div', { class: 'scan-rows' }, ...rows) : el('p', { class: 'muted', text: 'I could not read any values from that photo.' }),
      el('div', { class: 'row-actions wide' },
        rows.length ? el('button', { type: 'button', class: 'btn primary', text: 'Save these readings', onclick: () => saveScanned(t, inputs) }) : null,
        el('button', { type: 'button', class: 'btn', text: 'Retake photo', onclick: () => { scanState.step = 'kit'; renderScanSheet(); } }))));
  }
}
function saveScanned(t, inputs) {
  const v = {};
  let bad = '';
  Object.keys(inputs).forEach((key) => {
    const raw = inputs[key].value.trim();
    if (!raw) return;
    const n = parseFloat(raw.replace(',', '.'));
    const f = LOG_FIELDS[key];
    if (!isFinite(n) || n < f.min || n > f.max) bad = bad || f.label + ' should be between ' + f.min + ' and ' + f.max + '.';
    else v[key] = n;
  });
  if (bad) { toast(bad); return; }
  if (!Object.keys(v).length) { toast('Enter at least one reading.'); return; }
  addLogEntry(t, { id: uid(), t: Date.now(), k: 'test', v, note: 'Scanned from a photo' });
  closeScanSheet();
  logForm = null;
  renderLog();
  toast('Readings saved.');
}
async function runWaterScan(file) {
  const t = getTank(scanState.tank);
  if (!t) return;
  scanState.step = 'wait'; renderScanSheet();
  try {
    const image = await loadImage(file);
    const jpeg = drawToJpeg(image.source, 0, 0, image.width, image.height, SINGLE_SIDE, 0.85).split(',')[1];
    const res = await fetch(WORKER_URL + '/water', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: jpeg, mime: 'image/jpeg', kit: scanState.kit, tank_type: t.type, keys: logKeys(t) }),
      signal: AbortSignal.timeout(60000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(friendlyError(data.error, res.status));
    if (data.usage) logUsage('water', data.model, data.usage, { detail: 'test scan, ' + (data.kit_type || '') });
    scanState.rows = data.readings || [];
    scanState.chart = !!data.chart_visible;
    scanState.note = data.note || '';
    scanState.step = 'confirm';
  } catch (err) {
    scanState.msg = err && err.message === 'bad_image' ? "That photo couldn't be read. Try a different one." : (err && err.message) || 'Something went wrong. Try again.';
    scanState.step = 'error';
  }
  if (!$('scan-sheet').hidden) renderScanSheet();
}

function renderLog() {
  if (currentView !== 'tank' || tankSection !== 'water') return;
  const body = $('tank-sec-water');
  body.replaceChildren();
  const t = getTank(openTankId);
  if (!t) return;
  putAll(body, logSummaryCard(t));
  if (logForm) putAll(body, logFormCard(t));
  else putAll(body, el('div', { class: 'row-actions wide' },
    el('button', { type: 'button', class: 'btn primary small', text: 'Scan a test', onclick: openScanSheet }),
    el('button', { type: 'button', class: 'btn small', text: 'Log a test', onclick: () => { logForm = { mode: 'test' }; renderLog(); } }),
    el('button', { type: 'button', class: 'btn small', text: 'Log a water change', onclick: () => { logForm = { mode: 'change', pct: 0 }; renderLog(); } })));
  putAll(body, treatCard(t), logTrendCard(t), logHistoryCard(t));
  putAll(body, el('p', { class: 'muted small', text: 'These checks are general guidance. Your own fish and your test kit come first.' }));
}

// ----- Reminders -----
let remEdit = '';
let remDelete = '';
let remCustom = false;

function everyLabel(n) {
  if (n === 1) return 'every day';
  if (n === 7) return 'every week';
  if (n === 14) return 'every 2 weeks';
  if (n === 30) return 'every month';
  if (n === 60) return 'every 2 months';
  if (n === 90) return 'every 3 months';
  if (n === 180) return 'every 6 months';
  return 'every ' + n + ' days';
}
function taskDue(k) {
  return Math.max(k.last + k.every * DAY_MS, k.snooze || 0);
}
// diff: days until due (negative when overdue)
function taskInfo(k) {
  const diff = daysBetween(Date.now(), taskDue(k));
  if (diff < 0) return { diff, level: 'bad', text: diff === -1 ? 'Overdue by 1 day' : 'Overdue by ' + -diff + ' days' };
  if (diff === 0) return { diff, level: 'warn', text: 'Due today' };
  if (diff === 1) return { diff, level: 'ok', text: 'Due tomorrow' };
  return { diff, level: 'ok', text: 'Due in ' + diff + ' days' };
}
function dueTasks() {
  const out = [];
  state.tanks.forEach((t) => t.tasks.forEach((k) => { const i = taskInfo(k); if (i.diff <= 0) out.push({ tank: t, task: k, info: i }); }));
  return out.sort((a, b) => a.info.diff - b.info.diff);
}
function updateBadge() {
  try {
    const n = dueTasks().length;
    if (n && navigator.setAppBadge) navigator.setAppBadge(n);
    else if (!n && navigator.clearAppBadge) navigator.clearAppBadge();
  } catch (err) { /* badges are optional */ }
}
function addTask(t, label, days, kind) {
  if (t.tasks.length >= MAX_TASKS) { toast('That is plenty of reminders for one tank.'); return null; }
  const k = { id: uid(), kind: kind || 'custom', label: label.trim().slice(0, 40), every: days, last: Date.now(), snooze: 0 };
  t.tasks.push(k);
  if (!saveState()) toast('Could not save. Your phone storage may be full.');
  updateBadge();
  return k;
}

// One compact row per reminder. Tap the name to open its settings; only one is open at a time.
function taskRow(t, k) {
  const info = taskInfo(k);
  const open = remEdit === k.id;
  const done = () => {
    k.last = Date.now(); k.snooze = 0; remEdit = ''; saveState(); updateBadge();
    toast('Done. Next: ' + k.label.toLowerCase() + ' ' + taskInfo(k).text.toLowerCase() + '.');
    renderReminders();
  };
  const row = el('div', { class: 'rem-row ' + info.level + (open ? ' open' : '') });
  row.append(el('div', { class: 'rem-line' },
    el('button', { type: 'button', class: 'rem-main', 'aria-expanded': open ? 'true' : 'false', onclick: () => { remEdit = open ? '' : k.id; remDelete = ''; renderReminders(); } },
      el('strong', { text: k.label }),
      el('span', { class: 'pill ' + info.level, text: info.text })),
    el('button', { type: 'button', class: 'btn small' + (info.diff <= 0 ? ' primary' : ''), text: 'Done', 'aria-label': 'Mark ' + k.label + ' done', onclick: done })));
  if (open) {
    const sel = el('select', { class: 'select', 'aria-label': 'How often' }, ...(TASK_EVERY.includes(k.every) ? TASK_EVERY : TASK_EVERY.concat(k.every).sort((x, y) => x - y)).map((n) => el('option', { value: n, text: capital(everyLabel(n)), selected: n === k.every })));
    sel.addEventListener('change', () => { k.every = Number(sel.value); k.snooze = 0; saveState(); updateBadge(); renderReminders(); });
    row.append(el('div', { class: 'task-edit' },
      el('p', { class: 'muted small', text: 'Last done ' + fmtDay(k.last) + '.' }),
      el('label', { class: 'log-field' }, el('span', { class: 'label', text: 'How often' }), sel),
      info.diff <= 0 ? el('button', { type: 'button', class: 'btn small', text: 'Snooze a day', onclick: () => { k.snooze = startOfDay(Date.now()) + DAY_MS; remEdit = ''; saveState(); updateBadge(); renderReminders(); } }) : null,
      el('button', { type: 'button', class: 'btn link', text: remDelete === k.id ? 'Tap again to remove' : 'Remove this reminder', onclick: () => {
        if (remDelete !== k.id) { remDelete = k.id; renderReminders(); return; }
        t.tasks = t.tasks.filter((x) => x.id !== k.id); remEdit = ''; remDelete = ''; saveState(); updateBadge(); renderReminders();
      } })));
  }
  return row;
}
function capital(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function renderReminders() {
  if (currentView !== 'tank' || tankSection !== 'care') return;
  const body = $('tank-sec-care');
  body.replaceChildren();
  const t = getTank(openTankId);
  if (!t) return;
  if (!t.tasks.length) {
    putAll(body, el('div', { class: 'card note' }, el('h2', { text: 'Keep up with ' + tankLabel(t) }),
      el('p', { class: 'muted', text: 'Start with a weekly water change and water test and a monthly filter clean. You can change any of them.' }),
      el('button', { type: 'button', class: 'btn primary small', text: 'Add the starter set', onclick: () => {
        TASK_STARTER.forEach((kind) => { const p = TASK_PRESETS.find((x) => x.kind === kind); addTask(t, p.label, p.days, p.kind); });
        renderReminders();
      } })));
  } else {
    const sorted = t.tasks.slice().sort((a, b) => taskDue(a) - taskDue(b));
    const dueNow = sorted.filter((k) => taskInfo(k).diff <= 0);
    const later = sorted.filter((k) => taskInfo(k).diff > 0);
    if (dueNow.length) putAll(body, el('div', { class: 'card rem-card' }, el('h2', { text: 'Due now' }), ...dueNow.map((k) => taskRow(t, k))));
    else putAll(body, el('div', { class: 'card note' }, el('strong', { text: 'Nothing due right now' })));
    if (later.length) putAll(body, el('div', { class: 'card rem-card' }, el('h2', { text: 'Coming up' }), ...later.map((k) => taskRow(t, k))));
  }
  const have = new Set(t.tasks.map((k) => k.kind));
  const presets = TASK_PRESETS.filter((p) => !have.has(p.kind) && (!p.only || p.only === t.type));
  const add = el('div', { class: 'card' }, el('h2', { text: 'Add a reminder' }),
    el('div', { class: 'chips' }, ...presets.map((p) => el('button', { type: 'button', class: 'chip-btn', text: p.label, onclick: () => { const k = addTask(t, p.label, p.days, p.kind); if (k) toast('Added ' + p.label.toLowerCase() + '.'); renderReminders(); } })),
      el('button', { type: 'button', class: 'chip-btn' + (remCustom ? ' on' : ''), text: 'Something else', onclick: () => { remCustom = !remCustom; renderReminders(); } })));
  if (remCustom) {
    const name = el('input', { type: 'text', placeholder: 'What needs doing?', maxlength: '40', 'aria-label': 'Reminder name' });
    const sel = el('select', { class: 'select', 'aria-label': 'How often' }, ...TASK_EVERY.map((n) => el('option', { value: n, text: capital(everyLabel(n)), selected: n === 7 })));
    add.append(el('div', { class: 'task-edit' }, name, sel, el('button', { type: 'button', class: 'btn primary small', text: 'Add', onclick: () => {
      if (!name.value.trim()) { toast('Give the reminder a name.'); return; }
      addTask(t, name.value, Number(sel.value), 'custom'); remCustom = false; renderReminders();
    } })));
  }
  putAll(body, add, el('p', { class: 'muted small', text: 'Due reminders show on Home too. Tap Done when you have done it, and the clock restarts.' }));
}

function defaultState() {
  return { version: 2, setupDone: false, activeId: '', tanks: [] };
}

let migrated = false;
const GEAR_KINDS = ['Filter', 'Heater', 'Light', 'Pump or wavemaker', 'Protein skimmer', 'Air pump', 'CO2 system', 'Fan or chiller', 'Auto top-off', 'Test kit', 'Water conditioner', 'Substrate', 'Surface skimmer', 'Fertilizer', 'Gravel vacuum', 'Other'];
const BACKUP_KEY = 'schooled.v1.bak';
function loadState() {
  let st = loadFrom(STORE_KEY);
  if (!st.tanks.length) {
    // Nothing usable in the main slot. Recover from the copy kept at the last good start.
    const back = loadFrom(BACKUP_KEY);
    if (back.tanks.length) { st = back; try { localStorage.setItem(STORE_KEY, JSON.stringify(st)); } catch (err) { /* ignore */ } }
  } else {
    try { localStorage.setItem(BACKUP_KEY, localStorage.getItem(STORE_KEY)); } catch (err) { /* storage full; backup is optional */ }
  }
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (err) { /* optional */ }
  return st;
}
function loadFrom(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return defaultState();
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return defaultState();
    const next = defaultState();
    next.setupDone = !!saved.setupDone;
    if (Array.isArray(saved.tanks)) {
      saved.tanks.slice(0, MAX_TANKS).forEach((r) => {
        const t = cleanTank(r);
        if (t && !next.tanks.some((x) => x.id === t.id)) next.tanks.push(t);
      });
    } else if (saved.tank || Array.isArray(saved.fish)) {
      // Older version kept a single tank. Carry it over as the first tank.
      const old = saved.tank && typeof saved.tank === 'object' ? saved.tank : {};
      const fish = cleanFish(saved.fish);
      if (saved.setupDone || fish.length || old.name || old.size) {
        const t = cleanTank(Object.assign({}, old, { fish }));
        if (t) next.tanks.push(t);
      }
      migrated = true;
    }
    next.activeId = next.tanks.some((t) => t.id === saved.activeId) ? saved.activeId : (next.tanks[0] ? next.tanks[0].id : '');
    return next;
  } catch (err) {
    return defaultState();
  }
}

// Returns true when the save worked. Photos can fill a phone's browser storage.
function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
    if (!state.tanks.length) localStorage.removeItem(BACKUP_KEY); // deleted on purpose
    return true;
  } catch (err) {
    return false; // private mode or full storage; the app still works for this visit
  }
}

let state = loadState();
if (migrated) saveState();
let pending = null; // current scan: { photoUrl, species: [], tips, loading, error, tankId }

let toastTimer = null;
function toast(message) {
  const box = $('toast');
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 4500);
}

// ---------- Navigation ----------
const VIEWS = ['setup', 'home', 'results', 'water', 'tank', 'species', 'dream', 'fishcheck', 'misses', 'ask', 'backup'];
let currentView = 'home';
let openTankId = '';
let editingSize = false;

// Back swipe / back button: every screen change is a history entry, so the
// phone's own back gesture walks back through the app instead of leaving it.
let navIdx = -1;
let navKey = '';
let navRestoring = false;
let navCurrent = null;
function navSnapshot(name) {
  return {
    v: name, tank: openTankId, sec: tankSection, from: fishCheckFrom, wfrom: waterFrom,
    sv: speciesView ? { name: speciesView.name, tankId: speciesView.tankId } : null,
    so: speciesOrigin, sot: speciesOriginTank
  };
}
function navRecord(name) {
  if (navRestoring || !window.history || !history.pushState) return;
  const snap = navSnapshot(name);
  const key = name + '|' + (name === 'tank' || name === 'ask' ? snap.tank : '') + '|' + (name === 'species' && snap.sv ? snap.sv.name : '');
  try {
    if (navIdx < 0) { navIdx = 0; snap.i = 0; history.replaceState(snap, ''); }
    else if (key === navKey) { snap.i = navIdx; history.replaceState(snap, ''); }
    else { navIdx += 1; snap.i = navIdx; history.pushState(snap, ''); }
  } catch (e) { /* history not available */ }
  navKey = key;
  navCurrent = snap;
}
function goBack(fallback) {
  if (navIdx > 0 && window.history) history.back();
  else fallback();
}
function overlayOpen() {
  const pop = $('add-pop');
  const menu = $('tank-add-menu');
  const es = $('edit-sheet'), gs = $('gallery-sheet'), ss = $('scan-sheet');
  return !!((pop && !pop.hidden) || (menu && !menu.hidden) || (es && !es.hidden) || (gs && !gs.hidden) || (ss && !ss.hidden));
}
window.addEventListener('popstate', (ev) => {
  const st = ev.state;
  if (!st || !st.v) return;
  if (overlayOpen()) {
    // first back just closes the popup or menu and stays on the screen
    closeAddPop();
    closeAddMenu();
    closeSheets();
    if (navCurrent) { try { history.pushState(navCurrent, ''); } catch (e) { /* ignore */ } }
    return;
  }
  navIdx = typeof st.i === 'number' ? st.i : 0;
  navRestoring = true;
  try {
    if (currentView === 'results' && st.v !== 'results') pending = null;
    fishCheckFrom = st.from || 'home';
    waterFrom = st.wfrom || 'home';
    let v = st.v;
    if (v === 'setup' && state.tanks.length) v = 'home';
    if (v === 'results' && !pending) v = navIdx > 0 ? 'skip' : 'home';
    if (v === 'species') {
      speciesView = st.sv || null;
      speciesOrigin = st.so || 'home';
      speciesOriginTank = st.sot || '';
      speciesStack = [];
      if (!speciesView) v = 'home';
    }
    if (v === 'skip') { navRestoring = false; history.back(); return; }
    if ((v === 'tank') && getTank(st.tank)) showTank(st.tank, st.sec);
    else if (v === 'ask' && getTank(st.tank)) { openTankId = st.tank; showView('ask'); }
    else showView(v === 'tank' || v === 'ask' ? 'home' : v);
    navKey = v + '|' + (v === 'tank' ? openTankId : '') + '|' + (v === 'species' && speciesView ? speciesView.name : '');
    navCurrent = navSnapshot(currentView);
    navCurrent.i = navIdx;
  } finally {
    navRestoring = false;
  }
});

function showView(name) {
  VIEWS.forEach((v) => { $('view-' + v).hidden = v !== name; });
  if (name !== 'tank') closeSheets();
  document.body.dataset.view = name;
  currentView = name;
  navRecord(name);
  if (name === 'setup') fillSetupForm();
  if (name === 'home') renderHome();
  if (name === 'water') renderWater();
  if (name === 'tank') renderTank();
  if (name === 'species') renderSpecies();
  if (name === 'dream') renderDream();
  if (name === 'fishcheck') renderFishCheck();
  if (name === 'misses') renderMisses();
  if (name === 'ask') renderAsk();
  if (name === 'backup') renderBackup();
  window.scrollTo(0, 0);
}

let tankSection = 'fish';
function showTank(id, section, form) {
  openTankId = id;
  tankSection = section || 'fish';
  logForm = form || null;
  logParam = '';
  logAll = false;
  logDelete = '';
  remEdit = '';
  remDelete = '';
  remCustom = false;
  editingSize = false;
  resetDelete();
  showView('tank');
}

// ---------- Tank helpers ----------
function getTank(id) {
  return state.tanks.find((t) => t.id === id) || null;
}

function activeTank() {
  return getTank(state.activeId) || state.tanks[0] || null;
}

function tankLabel(t) {
  if (t.name.trim()) return t.name.trim();
  return state.tanks.length > 1 ? 'Tank ' + (state.tanks.indexOf(t) + 1) : 'My tank';
}

function sizeShort(t) {
  return t.size ? t.size + (t.unit === 'liters' ? ' L' : ' gal') : '';
}

function tankSummary(t) {
  return [sizeShort(t), t.type, t.style].filter(Boolean).join(' · ');
}

function ensureTank() {
  let t = activeTank();
  if (!t) {
    t = newTank();
    state.tanks.push(t);
    state.activeId = t.id;
    state.setupDone = true;
  }
  return t;
}

function addToTank(tank, name, count, mode, kind, photo) {
  let clean = name.trim().slice(0, 60);
  if (!clean) return '';
  const hit = lookupSpecies(clean);
  if (hit) { clean = hit.n; kind = kind || hit.k; }
  const key = canonKey(clean);
  const existing = tank.fish.find((f) => canonKey(f.name) === key);
  if (existing) {
    const before = existing.count;
    if (kind && !existing.kind) existing.kind = kind;
    if (photo && !existing.photo) existing.photo = photo;
    if (mode === 'add') existing.count = Math.min(999, existing.count + count);
    else if (mode === 'scan') existing.count = Math.max(existing.count, count); // a scan can only add or confirm, never lower
    else existing.count = count;
    return existing.count > before ? 'raised' : 'same';
  }
  const row = kind && KIND_LIST.includes(kind) ? { name: clean, count, kind } : { name: clean, count };
  if (photo) row.photo = photo;
  tank.fish.push(row);
  return 'new';
}

function totalFish(tank) {
  return tank.fish.reduce((sum, f) => sum + f.count, 0);
}

// Reads a photo from almost any file type and shrinks it to fit in saved storage.
async function photoFromFile(file, side) {
  const image = await loadImage(file);
  try {
    return drawToJpeg(image.source, 0, 0, image.width, image.height, side || TANK_PHOTO_SIDE, 0.8);
  } finally {
    image.done();
  }
}

function wireTankPhotoInput(buttonId, inputId, onPhoto) {
  $(buttonId).addEventListener('click', () => $(inputId).click());
  $(inputId).addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      onPhoto(await photoFromFile(file));
    } catch (err) {
      toast("This device couldn't open that photo. Try another one.");
    }
  });
}

// ---------- Add a tank (also the first-run setup) ----------
let setupPhoto = '';

function fillStyleSelect(type, selected) {
  const sel = $('tank-style');
  sel.replaceChildren(el('option', { value: '', text: 'Not set' }), ...STYLES[type].map((s) => el('option', { value: s, text: s })));
  sel.value = STYLES[type].includes(selected) ? selected : '';
}

function renderSetupPhoto() {
  const box = $('setup-photo');
  box.replaceChildren(setupPhoto
    ? el('img', { src: setupPhoto, alt: 'Your tank photo' })
    : el('div', { class: 'photo-empty' }, kindIcon('fish'), el('span', { text: 'Add a photo of your tank' })));
  $('setup-photo-remove').hidden = !setupPhoto;
}

function fillSetupForm() {
  const first = !state.setupDone;
  $('setup-title').textContent = first ? "Let's set up your tank" : 'Add a tank';
  $('setup-sub').textContent = first
    ? 'This helps size treatments and look up your tap water. It stays on your phone.'
    : 'Give it a name, a photo and a few details. You can change any of it later.';
  $('setup-submit').textContent = first ? 'Continue' : 'Add tank';
  const sl = $('setup-legal');
  if (sl) { sl.textContent = ''; if (first) sl.append('By continuing you agree to the ', extLink(LEGAL.privacy + '#terms', 'Terms of Use'), ' and ', extLink(LEGAL.privacy, 'Privacy Policy'), '.'); }
  $('setup-skip').textContent = first ? 'Skip for now' : 'Cancel';
  $('tank-name').value = '';
  $('tank-size').value = '';
  $('tank-filter').value = '';
  document.querySelector('input[name="unit"][value="gallons"]').checked = true;
  document.querySelector('input[name="type"][value="Freshwater"]').checked = true;
  fillStyleSelect('Freshwater', '');
  setupPhoto = '';
  renderSetupPhoto();
  $('setup-error').hidden = true;
}
document.querySelectorAll('input[name="type"]').forEach((r) => r.addEventListener('change', () => {
  fillStyleSelect(document.querySelector('input[name="type"]:checked').value, '');
}));

wireTankPhotoInput('setup-photo-camera', 'setup-photo-camera-input', (url) => { setupPhoto = url; renderSetupPhoto(); });
wireTankPhotoInput('setup-photo-gallery', 'setup-photo-gallery-input', (url) => { setupPhoto = url; renderSetupPhoto(); });
$('setup-photo-remove').addEventListener('click', () => { setupPhoto = ''; renderSetupPhoto(); });

function startAddTank() {
  if (state.tanks.length >= MAX_TANKS) {
    toast('That is the most tanks the app can hold on this phone (' + MAX_TANKS + ').');
    return;
  }
  showView('setup');
}

let setupThenScan = false;
$('setup-scan').addEventListener('click', () => { setupThenScan = true; });
$('setup-submit').addEventListener('click', () => { setupThenScan = false; });
$('setup-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const scanNext = setupThenScan;
  setupThenScan = false;
  const first = !state.setupDone;
  const name = $('tank-name').value.trim();
  const sizeRaw = $('tank-size').value.trim();
  const unit = document.querySelector('input[name="unit"]:checked').value;
  const type = document.querySelector('input[name="type"]:checked').value;
  const style = $('tank-style').value;
  const filter = $('tank-filter').value;
  const err = $('setup-error');

  const size = Number(sizeRaw);
  if (sizeRaw && (!isFinite(size) || size <= 0 || size > 5000)) {
    err.textContent = 'Enter your tank size as a number, like 29, or leave it blank.';
    err.hidden = false;
    $('tank-size').focus();
    return;
  }
  if (state.tanks.length >= MAX_TANKS) {
    err.textContent = 'That is the most tanks the app can hold on this phone (' + MAX_TANKS + ').';
    err.hidden = false;
    return;
  }

  const tank = newTank({
    name, size: sizeRaw ? String(size) : '', unit, type,
    style: STYLES[type].includes(style) ? style : '',
    filter: FILTER_KEYS.includes(filter) ? filter : '', photo: setupPhoto
  });
  state.tanks.push(tank);
  if (!state.activeId || first) state.activeId = tank.id;
  state.setupDone = true;
  if (!saveState() && tank.photo) {
    tank.photo = '';
    saveState();
    toast('This phone is out of saved space, so the photo was left off.');
  }
  if (scanNext) { state.activeId = tank.id; saveState(); showTank(tank.id); $('gallery-input').click(); }
  else if (first) showView('home');
  else showTank(tank.id);
});

let fishCheckFrom = 'home';
let waterFrom = 'home';
let menuTank = '';
function closeAddMenu() {
  if (!$('tank-add-menu') || !$('tank-add-fish')) return;
  $('tank-add-menu').hidden = true;
  $('tank-add-fish').setAttribute('aria-expanded', 'false');
}
function renderTankAddMenu() {
  const box = $('tank-add-menu');
  const t = getTank(openTankId);
  box.replaceChildren();
  if (!t) return;
  putAll(box,
    featureBtn({ icon: 'scan', color: 'blue', title: 'Scan the whole tank', text: 'Photograph the tank and name every fish, plant and coral',
      go: () => { state.activeId = t.id; saveState(); closeAddMenu(); $('gallery-input').click(); } }),
    featureBtn({ icon: 'fish', color: 'aqua', title: 'Check one fish', text: 'Photograph a fish and see if it fits ' + tankLabel(t),
      go: () => { fishCheck = null; fishCheckTankId = t.id; fishCheckNone = false; fishCheckFrom = 'tank'; closeAddMenu(); showView('fishcheck'); } }),
    featureBtn({ icon: 'plus', color: 'orange', title: 'Add by name', text: 'Search the list and add it yourself',
      go: () => { closeAddMenu(); openAddPop(); } }));
}
if ($('tank-add-fish')) $('tank-add-fish').addEventListener('click', () => {
  const box = $('tank-add-menu');
  box.hidden = !box.hidden;
  $('tank-add-fish').setAttribute('aria-expanded', String(!box.hidden));
  if (!box.hidden) renderTankAddMenu();
});

$('setup-skip').addEventListener('click', () => {
  if (state.setupDone) { showView('home'); return; }
  state.setupDone = true;
  saveState();
  showView('home');
});

// ---------- Home ----------
// Your own photo first, then the Wikipedia picture for known species, then the plain icon.
let thumbQueue = Promise.resolve();
function rowAvatar(f) {
  if (f.photo) return el('img', { class: 'avatar photo', src: f.photo, alt: '' });
  const icon = kindAvatar(rosterKind(f));
  const entry = lookupSpecies(f.name);
  if (!entry) return icon;
  const make = (found) => {
    const img = el('img', { class: 'avatar photo', src: found.src, alt: '', loading: 'lazy' });
    img.addEventListener('error', () => { if (img.parentNode) img.replaceWith(kindAvatar(rosterKind(f))); });
    return img;
  };
  const cached = stockCached(entry, entry.n);
  if (cached) return make(cached);
  if (cached === 0) return icon;
  thumbQueue = thumbQueue.then(() => fetchStock(entry, entry.n)).then((found) => {
    if (found && icon.parentNode) icon.replaceWith(make(found));
  }, () => {});
  return icon;
}
function rosterKind(f) {
  const hit = lookupSpecies(f.name);
  const k = f.kind || (hit && hit.k) || 'fish';
  return KIND_LIST.includes(k) ? k : 'fish';
}
function kindTotals(t) {
  const sums = { fish: 0, plant: 0, other: 0 };
  t.fish.forEach((f) => {
    const k = rosterKind(f);
    sums[k === 'fish' ? 'fish' : k === 'plant' ? 'plant' : 'other'] += f.count;
  });
  return sums;
}



const WATER_TOOLS = [
  { icon: 'drop', color: 'aqua', title: 'Water care', text: 'Conditioner and test kit picks for this tank', go: () => { state.activeId = openTankId; saveState(); waterFrom = 'tank'; showView('water'); } },
];
const TANK_TOOLS = []; // Get Schooled moved to a button on the tank photo (#tank-ask)
const FEATURES = [
  { icon: 'sparkle', color: 'purple', title: 'Dream Tank', text: 'Picture the tank you dream of, we\'ll bring it to life!', go: () => showView('dream') },
  { icon: 'drop', color: 'aqua', title: 'Water care', text: 'Conditioner and test kit picks for your tank', go: () => showView('water') }
];
const FEATURE_ICONS = {
  fish: KIND_ICONS.fish,
  search: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 20l-4-4'],
  drop: ['M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z'],
  star: ['M12 3l2.6 5.6 6.1.8-4.5 4.2 1.1 6-5.3-3-5.3 3 1.1-6L3.3 9.4l6.1-.8z'],
  strip: ['M8 3h8v18H8z', 'M8 8h8', 'M8 12h8', 'M8 16h8'],
  chart: ['M4 20V4', 'M4 20h16', 'M8 15l4-4 3 3 5-6'],
  bell: ['M6 16V11a6 6 0 1 1 12 0v5l2 2H4z', 'M10 21h4'],
  chat: ['M4 5h16v11H9l-5 4z'],
  scan: ['M4 8V5a1 1 0 0 1 1-1h3', 'M16 4h3a1 1 0 0 1 1 1v3', 'M20 16v3a1 1 0 0 1-1 1h-3', 'M8 20H5a1 1 0 0 1-1-1v-3', 'M8 12c1.5-2 4-2 6 0-2 2-4.5 2-6 0z', 'M14 12l2-1.2v2.4z'],
  plus: ['M12 5v14', 'M5 12h14'],
  lfs: ['M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8', 'M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8', 'M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16', 'M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16', 'M7 12c2-2.6 5.2-3 7.6-1.2L17 9.5v5l-2.4-1.3C12.2 15 9 14.6 7 12z', 'M10 11.6h.01'],
  sparkle: ['M12 3.5l1.6 4.2 4.2 1.6-4.2 1.6L12 15.1l-1.6-4.2-4.2-1.6 4.2-1.6z', 'M18.5 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z', 'M5.5 15.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z'],
  gear: ['M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', 'M12 3v2.5', 'M12 18.5V21', 'M3 12h2.5', 'M18.5 12H21', 'M5.6 5.6l1.8 1.8', 'M16.6 16.6l1.8 1.8', 'M18.4 5.6l-1.8 1.8', 'M7.4 16.6l-1.8 1.8'],
  info: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 11v5', 'M12 7.5v.5']
};
function featureIcon(name) {
  const svg = kindIcon('fish');
  svg.replaceChildren();
  (FEATURE_ICONS[name] || FEATURE_ICONS.fish).forEach((d) => {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    svg.append(p);
  });
  return svg;
}

function featureBtn(f) {
  const n = f.badge ? f.badge() : '';
  return el('button', { type: 'button', class: 'feature ' + f.color + (f.soon ? ' soon' : ''), onclick: () => (f.soon ? toast(f.title + ' is coming soon.') : f.go()) },
    el('span', { class: 'feature-icon' }, featureIcon(f.icon)),
    el('span', { class: 'feature-text' }, el('strong', { text: f.title }), el('span', { text: f.text })),
    n ? el('span', { class: 'pill warn', text: n }) : f.soon ? el('span', { class: 'soon-badge', text: 'Soon' }) : chevron());
}

function homeStatus(t) {
  const tests = t.log.filter((e) => e.k === 'test');
  if (!tests.length) return { cls: '', text: 'No water test yet' };
  const w = worstLevel(entryChecks(t, tests[tests.length - 1]));
  return { cls: w, text: w === 'ok' ? 'Water good' : w === 'warn' ? 'Water: watch' : 'Water needs action' };
}

function homeTankCard(t) {
  const sums = kindTotals(t);
  const count = sums.fish + sums.plant + sums.other;
  const st = homeStatus(t);
  return el('button', { type: 'button', class: 'home-tank', 'aria-label': 'Open ' + tankLabel(t), onclick: () => { state.activeId = t.id; saveState(); showTank(t.id); } },
    t.photo ? el('img', { class: 'home-tank-pic', src: t.photo, alt: '' }) : el('span', { class: 'home-tank-pic empty' }, kindIcon('fish')),
    el('span', { class: 'home-tank-text' },
      el('strong', { text: tankLabel(t) }),
      el('span', { text: [tankSummary(t), count ? count + (count === 1 ? ' animal or plant' : ' animals and plants') : 'Empty so far'].filter(Boolean).join(' \u00b7 ') }),
      el('span', { class: 'pill ' + st.cls, text: st.text })),
    chevron());
}

function renderHome() {
  const body = $('home-body');
  body.replaceChildren();
  const missBox = $('home-misses');
  missBox.replaceChildren();
  if (!state.tanks.length) {
    putAll(body, el('button', { type: 'button', class: 'home-tank', onclick: startAddTank },
      el('span', { class: 'home-tank-pic empty' }, featureIcon('plus')),
      el('span', { class: 'home-tank-text' },
        el('strong', { text: 'Start a new tank' }),
        el('span', { text: 'Add a name and photo, then keep its fish, water and reminders in one place.' })),
      chevron()));
  } else {
    putAll(body, ...state.tanks.map(homeTankCard));
    const at = activeTank();
    const due = dueTasks();
    const addBtn = el('button', { type: 'button', class: 'btn small add-pill add-grad', 'aria-label': 'Add a care reminder', onclick: () => showTank(at.id, 'care') }, featureIcon('plus'), 'Add');
    if (due.length) {
      const card = el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: 'Due now' }), addBtn));
      due.slice(0, 5).forEach((d) => card.append(el('div', { class: 'due-row' },
        el('button', { type: 'button', class: 'due-main', onclick: () => showTank(d.tank.id, 'care') },
          el('strong', { text: d.task.label + (state.tanks.length > 1 ? ' \u00b7 ' + tankLabel(d.tank) : '') }),
          el('span', { class: 'pill ' + d.info.level, text: d.info.text })),
        el('button', { type: 'button', class: 'btn small', text: 'Done', 'aria-label': 'Mark ' + d.task.label + ' done', onclick: () => { d.task.last = Date.now(); d.task.snooze = 0; saveState(); updateBadge(); renderHome(); } }))));
      if (due.length > 5) card.append(el('p', { class: 'muted small', text: 'And ' + (due.length - 5) + ' more in your tanks.' }));
      putAll(body, card);
    } else {
      const next = [];
      state.tanks.forEach((x) => x.tasks.forEach((k) => next.push({ tank: x, task: k, info: taskInfo(k) })));
      next.sort((p, q) => p.info.diff - q.info.diff);
      const card = el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: 'Care reminders' }), addBtn));
      if (next.length) card.append(el('strong', { text: 'Nothing due right now' }),
        el('p', { class: 'muted small', text: 'Next up: ' + next[0].task.label + (state.tanks.length > 1 ? ' (' + tankLabel(next[0].tank) + ')' : '') + ', ' + next[0].info.text.toLowerCase() + '.' }));
      else card.append(el('p', { class: 'muted', text: 'No reminders yet. Tap Add to set up water changes and other chores for your tank.' }));
      putAll(body, card);
    }
  }
  putAll(body, heroBtn('At Your LFS?', 'Photograph one fish and see if it fits your tank', 'lfs', true, () => { fishCheck = null; fishCheckTankId = ''; fishCheckNone = false; fishCheckFrom = 'home'; showView('fishcheck'); }));
  putAll(body, heroBtn('Dream Tank', 'Picture the tank you dream of, we\'ll bring it to life!', 'sparkle', true, () => showView('dream')));
  putAll(body, heroBtn('Settings', lastBackupText() + ' \u00b7 Backup, sharing, legal', 'gear', true, () => { restorePending = null; showView('backup'); }));
  updateBadge();
  const misses = loadMisses();
  const usageN = loadUsage().length;
  if (usageN) missBox.append(el('button', { type: 'button', class: 'misses-bar', onclick: () => showView('misses') },
    featureIcon('info'),
    el('strong', { text: 'Usage log: ' + usageN + ' AI calls' }),
    chevron()));
  if (misses.length) missBox.append(el('button', { type: 'button', class: 'misses-bar', onclick: () => showView('misses') },
    featureIcon('info'),
    el('strong', { text: misses.length + (misses.length === 1 ? ' unmatched species to review' : ' unmatched species to review') }),
    chevron()));
}

// ---------- About and legal ----------
// The legal pages live on the publisher's own site, so store listings and the app point to the same place.
const SITE_URL = 'https://www.twinravensdigital.com';
const LEGAL = { privacy: SITE_URL + '/schooled-privacy.html', support: SITE_URL + '/support.html#schooled', page: SITE_URL + '/schooled.html', email: 'contact@twinravensdigital.com' };
const APP_VERSION = '1.0';
function extLink(href, text) { return el('a', { href, target: '_blank', rel: 'noopener noreferrer', text }); }

// ---------- Community fish photos (opt-in) ----------
// With the keeper's yes, a small crop of one fish and its confirmed name go to a shared collection. No tank background, name or place.
const CONTRIB_KEY = 'schooled.contrib';
const CROP_SIDE = 384;
function contribState() { try { return localStorage.getItem(CONTRIB_KEY) || ''; } catch (err) { return ''; } }
function setContrib(v) { try { localStorage.setItem(CONTRIB_KEY, v); } catch (err) { /* optional */ } }
const CONTRIB_BLURB = 'When you add a fish, Schooled can send a small cropped photo of just that fish, with the name you confirmed, to a shared collection that makes fish ID better for everyone. We never send your whole tank photo, tank names, notes, location or account details.';
function askContribConsent() {
  return new Promise((resolve) => {
    const done = (v) => { setContrib(v); wrap.remove(); resolve(v === 'yes'); };
    const wrap = el('div', { class: 'sheet-wrap' },
      el('div', { class: 'sheet-dim' }),
      el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Help improve fish ID' },
        el('div', { class: 'sheet-grab', 'aria-hidden': 'true' }),
        el('div', { class: 'sheet-head' }, el('h2', { text: 'Help improve fish ID?' })),
        el('p', { text: CONTRIB_BLURB }),
        el('p', { class: 'muted small' }, 'You can change this any time under Settings. ', extLink(LEGAL.privacy + '#photos', 'How we use these photos'), '.'),
        el('button', { type: 'button', class: 'btn primary big', text: 'Yes, help improve it', onclick: () => done('yes') }),
        el('button', { type: 'button', class: 'btn big', text: 'No thanks', onclick: () => done('no') })));
    document.body.append(wrap);
  });
}
async function postCrop(item, withImage) {
  const body = { device: deviceId(), name: item.name, sci: item.sci, kind: item.kind, src: item.src, ai: item.ai, conf: item.conf, water: item.water };
  if (withImage) body.image = item.image.split(',')[1];
  const res = await fetch(WORKER_URL + '/contribute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  return res.json().catch(() => ({}));
}
// Asks once, then quietly shares. Never blocks or shows errors: this is a bonus, not part of saving.
async function shareCrops(list) {
  try {
    const items = (list || []).filter((x) => x && x.image && x.name).slice(0, 12);
    if (!items.length) return;
    let st = contribState();
    if (st === '') { await askContribConsent(); st = contribState(); }
    if (st !== 'yes') return;
    for (const item of items) {
      const q = await postCrop(item, false);
      if (q && q.ok && q.want) await postCrop(item, true);
    }
  } catch (err) { /* sharing is optional */ }
}

// ---------- Back up and restore ----------
// One file holds every tank, its fish, water log, reminders, equipment and progress photos.
const LASTBACKUP_KEY = 'schooled.lastbackup';
function lastBackupText() {
  let at = 0;
  try { at = Number(localStorage.getItem(LASTBACKUP_KEY)) || 0; } catch (err) { at = 0; }
  if (!at) return 'Never backed up';
  const days = Math.floor((Date.now() - at) / DAY_MS);
  return days <= 0 ? 'Backed up today' : 'Last backup ' + days + (days === 1 ? ' day ago' : ' days ago');
}
async function buildBackup() {
  const photos = [];
  for (const t of state.tanks) {
    try { (await PhotoDB.list(t.id)).forEach((x) => photos.push({ id: x.id, tank: x.tank, date: x.date, note: x.note || '', data: x.data })); } catch (err) { /* photos are optional */ }
  }
  return { app: 'schooled', format: 1, saved: new Date().toISOString(), state: { setupDone: true, activeId: state.activeId, tanks: state.tanks }, photos };
}
async function saveBackupFile() {
  const text = JSON.stringify(await buildBackup());
  const name = 'schooled-backup-' + todayISO() + '.json';
  const file = new File([text], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Schooled backup' }); markBackup(); return; }
  } catch (err) {
    if (err && err.name === 'AbortError') return; // the person closed the share sheet
  }
  const url = URL.createObjectURL(file);
  const link = el('a', { href: url, download: name });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  markBackup();
}
function markBackup() {
  try { localStorage.setItem(LASTBACKUP_KEY, String(Date.now())); } catch (err) { /* optional */ }
  toast('Backup saved. Keep the file somewhere safe, like email or cloud storage.');
  if (currentView === 'backup') renderBackup();
}
// Reads a backup file and checks it. Returns { tanks, photos, saved } or throws.
async function readBackupFile(file) {
  if (!file) throw new Error('none');
  if (file.size > 150 * 1024 * 1024) throw new Error('big');
  let raw;
  try { raw = JSON.parse(await file.text()); } catch (err) { throw new Error('bad'); }
  if (!raw || raw.app !== 'schooled' || !raw.state || !Array.isArray(raw.state.tanks)) throw new Error('bad');
  const tanks = [];
  raw.state.tanks.slice(0, MAX_TANKS).forEach((r) => {
    const t = cleanTank(r);
    if (t && !tanks.some((x) => x.id === t.id)) tanks.push(t);
  });
  if (!tanks.length) throw new Error('empty');
  const ids = tanks.map((t) => t.id);
  const photos = (Array.isArray(raw.photos) ? raw.photos : []).filter((x) => x && typeof x.id === 'string' && ids.indexOf(x.tank) !== -1 && typeof x.data === 'string' && x.data.startsWith('data:image/'))
    .map((x) => ({ id: x.id.slice(0, 40), tank: x.tank, date: /^\d{4}-\d{2}-\d{2}$/.test(x.date) ? x.date : todayISO(), note: typeof x.note === 'string' ? x.note.slice(0, 80) : '', data: x.data }));
  return { tanks, photos, activeId: ids.indexOf(raw.state.activeId) !== -1 ? raw.state.activeId : ids[0], saved: typeof raw.saved === 'string' ? raw.saved.slice(0, 10) : '' };
}
async function applyBackup(b) {
  for (const t of state.tanks) { try { await PhotoDB.delTank(t.id); } catch (err) { /* ignore */ } }
  state.tanks = b.tanks; state.activeId = b.activeId; state.setupDone = true;
  const ok = saveState();
  let lost = 0;
  for (const x of b.photos) { try { await PhotoDB.add(x); } catch (err) { lost++; } }
  return { ok, lost };
}
let restorePending = null;
function renderBackup() {
  const body = $('backup-body');
  body.replaceChildren();
  const tn = state.tanks.length;
  body.append(el('h1', { text: 'Settings' }),
    el('p', { class: 'muted', text: 'Your tanks live only on this phone. Save a backup file before you switch phones, clear your browser data or delete the app, then restore it on the new phone.' }),
    el('div', { class: 'card' },
      el('h2', { text: 'Save a backup' }),
      el('p', { class: 'muted small', text: lastBackupText() + (tn ? '. ' + tn + (tn === 1 ? ' tank' : ' tanks') + ' with their fish, water logs, reminders, equipment and progress photos.' : '.') }),
      el('button', { type: 'button', class: 'btn primary', text: 'Save backup file', disabled: tn ? null : '', onclick: () => { saveBackupFile().catch(() => toast("Couldn't make the backup file.")); } })));
  const on = contribState() === 'yes';
  body.append(el('div', { class: 'card' },
    el('h2', { text: 'Help improve fish ID' }),
    el('p', { class: 'muted small', text: CONTRIB_BLURB }),
    el('p', { class: 'small', text: on ? 'Sharing is on.' : 'Sharing is off.' }),
    el('button', { type: 'button', class: 'btn' + (on ? '' : ' primary'), text: on ? 'Turn off sharing' : 'Turn on sharing', onclick: () => { setContrib(on ? 'no' : 'yes'); renderBackup(); } })));
  const fileIn = el('input', { type: 'file', accept: '.json,application/json', hidden: '' });
  fileIn.addEventListener('change', async () => {
    const f = fileIn.files && fileIn.files[0];
    fileIn.value = '';
    if (!f) return;
    try { restorePending = await readBackupFile(f); renderBackup(); }
    catch (err) {
      restorePending = null;
      toast(err.message === 'big' ? 'That file is too large to be a Schooled backup.' : err.message === 'empty' ? 'That backup has no tanks in it.' : "That doesn't look like a Schooled backup file.");
    }
  });
  const rcard = el('div', { class: 'card' }, el('h2', { text: 'Restore from a backup' }));
  if (restorePending) {
    const b = restorePending;
    rcard.append(el('p', { text: 'Found ' + b.tanks.length + (b.tanks.length === 1 ? ' tank' : ' tanks') + ' and ' + b.photos.length + (b.photos.length === 1 ? ' photo' : ' photos') + (b.saved ? ', saved ' + b.saved : '') + '.' }),
      el('p', { class: 'muted small', text: tn ? 'Restoring replaces the ' + tn + (tn === 1 ? ' tank' : ' tanks') + ' on this phone. Save a backup first if you want to keep them.' : 'This phone has no tanks yet, so nothing will be replaced.' }),
      el('div', { class: 'row photo-actions' },
        el('button', { type: 'button', class: 'btn primary', text: 'Restore', onclick: async () => {
          const r = await applyBackup(b);
          restorePending = null;
          toast(r.ok ? (r.lost ? 'Restored, but ' + r.lost + ' photos did not fit.' : 'Backup restored.') : 'Restored for now, but this phone is out of storage.');
          showView('home');
        } }),
        el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: () => { restorePending = null; renderBackup(); } })));
  } else {
    rcard.append(el('p', { class: 'muted small', text: 'Choose a backup file you saved earlier. You will see what is in it before anything changes.' }),
      el('button', { type: 'button', class: 'btn primary', text: 'Choose backup file', onclick: () => fileIn.click() }));
  }
  body.append(rcard, fileIn);
  body.append(el('div', { class: 'card' },
    el('h2', { text: 'About Schooled' }),
    el('p', { class: 'muted small', text: 'Schooled is made by Twin Ravens Digital LLC. Fish identification, care information and product ideas are estimates to help you plan, not veterinary or professional advice. Check with a trusted fish store or vet before you buy or treat livestock.' }),
    el('p', { class: 'small' }, extLink(LEGAL.privacy, 'Privacy Policy'), ' \u00b7 ', extLink(LEGAL.privacy + '#terms', 'Terms of Use'), ' \u00b7 ', extLink(LEGAL.support, 'Support'), ' \u00b7 ', extLink(LEGAL.page, 'Website')),
    el('p', { class: 'muted small', text: 'Contact: ' + LEGAL.email }),
    el('p', { class: 'muted small', text: 'Version ' + APP_VERSION })));
}

function heroBtn(title, sub, icon, alt, onclick) {
  const ic = featureIcon(icon);
  ic.setAttribute('width', '28');
  ic.setAttribute('height', '28');
  return el('button', { type: 'button', class: 'hero' + (alt ? ' alt' : ''), onclick },
    el('span', {}, el('strong', { text: title }), el('small', { text: sub })),
    el('span', { class: 'hero-icon tile-' + icon }, ic));
}


// ---------- Water ----------
function renderWater() {
  const t = activeTank();
  renderWaterRecs(t);
}

// Chemicals and test kits for this tank's water, with the same curated picks as equipment.
function renderWaterRecs(t) {
  const box = $('water-recs-body');
  if (!box) return;
  if (!t) { box.replaceChildren(el('p', { class: 'muted small', text: 'Add a tank on Home to see picks for your water.' })); return; }
  const seen = {};
  const items = gearSuggestions(t).filter((s) => WATER_KINDS.indexOf(s.kind) !== -1 && !seen[s.title] && (seen[s.title] = 1));
  if (t.type === 'Saltwater' && !items.some((s) => s.kind === 'Water conditioner')) items.push({ kind: 'Water conditioner', title: 'Water conditioner', why: 'Treats tap or RO/DI top-off water before it goes into mixed salt water.' });
  const anyPicks = items.some((s) => gearPicks(s.kind, t).length);
  const parts = [el('p', { class: 'muted small gear-disclaimer', text: GEAR_DISCLAIMER + (anyPicks ? ' Last checked ' + GEAR_PICKS_CHECKED + '.' : '') })];
  parts.push(el('p', { class: 'muted small', text: 'Tap water often has chlorine or chloramine in it, so use a conditioner that handles both whenever you add water.' }));
  items.forEach((s) => {
    const have = t.gear.some((g) => g.kind === s.kind);
    const picks = gearPicks(s.kind, t);
    parts.push(el('div', { class: 'water-rec' },
      el('strong', { text: s.title }), el('span', { class: 'sub', text: s.why }),
      ...picks.map((p) => el('button', { type: 'button', class: 'pick', 'aria-label': 'I have ' + p.name, onclick: () => {
        if (t.gear.length >= 40) { toast('That is the most equipment one tank can list.'); return; }
        t.gear.push({ id: uid(), kind: s.kind, name: p.name.slice(0, 60), note: '', added: todayISO() });
        saveState(); renderWaterRecs(t); toast('Added to ' + (t.name || 'your tank') + '.');
      } }, el('span', { class: 'pick-tier', text: p.tier }), el('strong', { text: p.name }), el('span', { class: 'sub', text: p.spec }))),
      have ? el('span', { class: 'sub', text: 'Already in your equipment list.' }) : null));
  });
  box.replaceChildren(...parts);
}

// ---------- My Tanks (list) ----------
function lastTestLine(t) {
  const tests = t.log.filter((e) => e.k === 'test');
  return tests.length ? 'Last water test ' + agoText(tests[tests.length - 1].t) : '';
}


// ---------- One tank ----------
function chevron() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.6');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'chev');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M6 9l6 6 6-6');
  svg.append(path);
  return svg;
}

// A pill you tap to open a dropdown. The real <select> sits invisibly on top, so phones show their own picker.
function pillSelect(label, display, groups, current, onChange) {
  const select = el('select', { 'aria-label': label });
  groups.forEach((g) => {
    const parent = g.label ? el('optgroup', { label: g.label }) : select;
    g.options.forEach((o) => parent.append(el('option', { value: o.value, text: o.text })));
    if (g.label) select.append(parent);
  });
  select.value = current;
  select.addEventListener('change', () => onChange(select.value));
  return el('label', { class: 'pill-edit' },
    el('span', { class: 'k', text: label }),
    el('span', { class: 'v', text: display }),
    chevron(),
    select);
}

function todayString() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function datePill(t) {
  const input = el('input', { type: 'date', value: t.started, max: todayString(), 'aria-label': 'Running since' });
  input.addEventListener('click', () => { try { if (input.showPicker) input.showPicker(); } catch (err) { /* older browsers open it themselves */ } });
  input.addEventListener('change', () => {
    t.started = /^\d{4}-\d{2}-\d{2}$/.test(input.value) ? input.value : '';
    saveState();
    renderTank();
  });
  let shown = 'Not set';
  if (t.started) {
    const d = new Date(t.started + 'T00:00:00');
    if (!isNaN(d)) shown = d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  }
  return el('label', { class: 'pill-edit' },
    el('span', { class: 'k', text: 'Running since' }),
    el('span', { class: 'v', text: shown }),
    chevron(),
    input);
}

function sizePill(t) {
  if (editingSize) {
    const num = el('input', { type: 'number', class: 'pill-input', inputmode: 'decimal', min: 1, max: 5000, value: t.size, placeholder: '55', 'aria-label': 'Tank size' });
    const unit = el('select', { class: 'pill-unit', 'aria-label': 'Units' },
      el('option', { value: 'gallons', text: 'gal' }), el('option', { value: 'liters', text: 'L' }));
    unit.value = t.unit;
    const done = () => {
      const n = Number(num.value);
      if (!isFinite(n) || n <= 0 || n > 5000) { toast('Enter a size between 1 and 5000.'); return; }
      t.size = String(n);
      t.unit = unit.value;
      editingSize = false;
      saveState();
      renderTank();
    };
    num.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); done(); } });
    return el('span', { class: 'pill-edit editing' },
      el('span', { class: 'k', text: 'Size' }), num, unit,
      el('button', { type: 'button', class: 'pill-ok', text: 'Set', onclick: done }),
      el('button', { type: 'button', class: 'pill-cancel', 'aria-label': 'Cancel', text: '×', onclick: () => { editingSize = false; renderTank(); } }));
  }
  const cur = t.size ? (t.unit === 'liters' ? 'l:' : 'g:') + t.size : '';
  const gal = SIZE_PRESETS.gallons.map((n) => ({ value: 'g:' + n, text: n + ' gal' }));
  const lit = SIZE_PRESETS.liters.map((n) => ({ value: 'l:' + n, text: n + ' L' }));
  const extra = cur && ![...gal, ...lit].some((o) => o.value === cur) ? [{ value: cur, text: sizeShort(t) }] : [];
  const groups = [
    { options: [{ value: '', text: 'Not set' }, ...extra] },
    { label: 'Gallons', options: gal },
    { label: 'Liters', options: lit },
    { options: [{ value: 'custom', text: 'Custom size…' }] }
  ];
  return pillSelect('Size', sizeShort(t) || 'Not set', groups, cur, (v) => {
    if (v === 'custom') { editingSize = true; renderTank(); return; }
    if (!v) t.size = '';
    else { t.unit = v.startsWith('l:') ? 'liters' : 'gallons'; t.size = v.slice(2); }
    saveState();
    renderTank();
  });
}

function renderTank() {
  const t = getTank(openTankId);
  if (!t) { showView('home'); return; }

  $('tank-hero').replaceChildren(
    t.photo ? el('img', { src: t.photo, alt: 'Photo of ' + tankLabel(t) }) : el('div', { class: 'tank-hero-empty' }, kindIcon('fish'), el('span', { text: 'No photo yet' })),
    el('div', { class: 'hero-shade' }),
    el('div', { class: 'hero-title' }, el('h1', { text: tankLabel(t) })));
  $('sheet-photo-thumb').replaceChildren(t.photo ? el('img', { src: t.photo, alt: '' }) : el('span', { text: 'No photo' }));
  $('tank-photo-remove').hidden = !t.photo;
  $('tank-photo-camera').textContent = t.photo ? 'Retake' : 'Take photo';
  $('tank-photo-gallery').textContent = t.photo ? 'Change' : 'Choose photo';

  if (menuTank !== t.id) { menuTank = t.id; closeAddMenu(); }
  if ($('tank-tools')) $('tank-tools').replaceChildren(...TANK_TOOLS.map(featureBtn));
  const nameInput = $('tank-title-input');
  if (document.activeElement !== nameInput) nameInput.value = t.name;

  const typeGroups = [{ options: TYPES.map((x) => ({ value: x, text: x })) }];
  const styleGroups = [{ options: [{ value: '', text: 'Not set' }, ...STYLES[t.type].map((x) => ({ value: x, text: x }))] }];
  const filterGroups = [{ options: [{ value: '', text: 'Not set' }, ...FILTER_TYPES.map((x) => ({ value: x[0], text: x[1] }))] }];
  $('tank-pills').replaceChildren(
    sizePill(t),
    pillSelect('Type', t.type, typeGroups, t.type, (v) => {
      t.type = v;
      if (!STYLES[v].includes(t.style)) t.style = '';
      saveState();
      renderTank();
    }),
    pillSelect('Style', t.style || 'Not set', styleGroups, t.style, (v) => { t.style = v; saveState(); renderTank(); }),
    pillSelect('Filtration', t.filter ? FILTER_SHORT[t.filter] : 'Not set', filterGroups, t.filter, (v) => { t.filter = v; saveState(); renderTank(); }),
    datePill(t)
  );

  const notes = $('tank-notes');
  if (document.activeElement !== notes) notes.value = t.notes;


  const SECS = [['fish', 'Fish and plants'], ['water', 'Water'], ['care', 'Care']];
  const dueHere = t.tasks.filter((k) => taskInfo(k).diff <= 0).length;
  $('tank-seg').replaceChildren(...SECS.map(([k, label]) => el('button', { type: 'button', class: 'seg-btn' + (k === tankSection ? ' on' : ''), 'aria-pressed': k === tankSection ? 'true' : 'false',
    text: label + (k === 'care' && dueHere ? ' (' + dueHere + ')' : ''), onclick: () => { tankSection = k; renderTank(); } })));
  $('tank-sec-fish').hidden = tankSection !== 'fish';
  $('tank-sec-water').hidden = tankSection !== 'water';
  $('tank-sec-care').hidden = tankSection !== 'care';
  if (tankSection === 'water') renderLog();
  if (tankSection === 'care') renderReminders();

  const list = $('tank-list');
  list.replaceChildren();
  const rowFor = (f) => {
    const sci = usableScientific(lookupSpecies(f.name));
    return el('div', { class: 'item' },
      rowAvatar(f),
      el('button', { type: 'button', class: 'row-main', 'aria-label': 'Details for ' + f.name, onclick: () => showSpecies(f.name, t.id) },
        el('span', { class: 'name', text: f.name }),
        sci ? el('span', { class: 'sub sci', text: sci }) : null),
      el('button', { type: 'button', class: 'round', 'aria-label': 'One fewer ' + f.name, text: '\u2212', onclick: () => changeCount(t, f, -1) }),
      el('span', { class: 'count', text: String(f.count) }),
      el('button', { type: 'button', class: 'round', 'aria-label': 'One more ' + f.name, text: '+', onclick: () => changeCount(t, f, 1) }));
  };
  const salt = t.type === 'Saltwater';
  const second = salt ? { key: 'coral', title: 'Corals', kinds: ['coral'], empty: 'No corals yet.' } : { key: 'plant', title: 'Plants', kinds: ['plant'], empty: 'No plants yet.' };
  const groups = [{ key: 'fish', title: 'Fish', kinds: ['fish'], empty: 'No fish yet.' }, second];
  const taken = new Set(groups.flatMap((g) => g.kinds));
  const others = t.fish.filter((f) => !taken.has(rosterKind(f)));
  if (others.length) groups.push({ key: 'other', title: 'Invertebrates and others', kinds: null, empty: '' });
  groups.forEach((g) => {
    const items = g.kinds ? t.fish.filter((f) => g.kinds.includes(rosterKind(f))) : others;
    const total = items.reduce((sum, f) => sum + f.count, 0);
    const det = el('details', { class: 'card group-card', 'data-group': g.key },
      el('summary', { class: 'group-sum' },
        el('span', { class: 'group-thumb' }, items.length ? rowAvatar(items[0]) : kindAvatar(g.kinds ? g.kinds[0] : 'invert')),
        el('span', { class: 'group-text' }, el('strong', { text: g.title }), el('span', { text: total ? total + ' in your tank' : 'None yet' })),
        chevron()),
      el('div', { class: 'group-body' }, ...(items.length ? items.map(rowFor) : [el('p', { class: 'muted small', text: g.empty + ' Tap Scan / Add to start.' })])));
    if (groupOpen[g.key]) det.open = true;
    det.addEventListener('toggle', () => { groupOpen[g.key] = det.open; });
    list.append(det);
  });
  const ins = $('tank-insights');
  const strip = summaryStrip(t);
  ins.replaceChildren(strip.row, ...(strip.showMates ? [mateCheckCard(t)] : []));
  renderGear();
  if (photoState.tank !== t.id || photoState.list === null) { photoState.list = null; loadProgressPhotos(); } else renderProgress();
}

// ---------- Equipment and progress photos (one expandable card each, inside every tank) ----------

function cleanGear(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 40).map((g) => {
    if (!g || typeof g !== 'object') return null;
    const kind = GEAR_KINDS.includes(g.kind) ? g.kind : 'Other';
    const name = typeof g.name === 'string' ? g.name.trim().slice(0, 60) : '';
    if (!name) return null;
    return {
      id: typeof g.id === 'string' && g.id ? g.id.slice(0, 40) : uid(),
      kind, name,
      note: typeof g.note === 'string' ? g.note.slice(0, 120) : '',
      added: typeof g.added === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(g.added) ? g.added : ''
    };
  }).filter(Boolean);
}
function cleanStrings(list, max, len) {
  return Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x).map((x) => x.slice(0, len)).slice(0, max) : [];
}
function todayISO() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// Rule-based ideas from the tank's water type, size and what lives in it.
function gearSuggestions(t) {
  const gal = tankGallons(t);
  const salt = t.type === 'Saltwater';
  const brackish = t.type === 'Brackish';
  const items = t.fish.map((f) => ({ f, e: careOf(f.name) })).filter((x) => x.e);
  const has = (k) => items.some((x) => x.e.k === k);
  const corals = has('coral');
  const plants = has('plant');
  const inverts = has('shrimp') || has('invert') || has('snail');
  const heavy = items.some((x) => x.e.k === 'fish' && hasTag(x.e, 'heavy'));
  const coolFish = items.some((x) => x.e.k === 'fish' && x.e.c.t && x.e.c.t[1] < 74);
  const out = [];
  const add = (kind, title, why) => out.push({ kind, title, why });
  const sizeTxt = gal ? ' for about ' + Math.round(gal) + ' gallons' : '';

  const ft = t.filter || '';
  const rated = gal ? Math.round(gal * (heavy ? 1.5 : 1)) : 0;
  const flow = gal ? Math.round(gal * (salt ? 5 : 4)) : 0;
  const FT = { hob: 'Hang-on-back filter', canister: 'Canister filter', internal: 'Internal filter', sponge: 'Sponge filter', undergravel: 'Undergravel filter', sump: 'Sump and return pump' };
  if (ft === 'sump') {
    add('Filter', FT.sump + sizeTxt, 'The sump holds your skimmer, heater and filter media. Size the return pump for roughly ' + (gal ? Math.round(gal * 5) + ' gallons per hour' : '4 to 6 times your tank volume per hour') + ' after it loses some flow to height.');
  } else if (ft === 'sponge') {
    add('Filter', FT.sponge + sizeTxt, 'Pick a sponge filter rated for ' + (gal ? Math.round(gal) + ' gallons or more' : 'your tank size') + '. It runs on an air pump and is gentle on fry, shrimp and bettas.');
  } else if (ft === 'undergravel') {
    add('Filter', FT.undergravel + sizeTxt, 'Plates under the gravel, lifted by an air pump or powerhead. Keep the gravel layer even, and expect plants with deep roots to struggle.');
  } else if (ft) {
    add('Filter', FT[ft] ? FT[ft] + sizeTxt : 'Filter' + sizeTxt,
      gal ? 'Look for one rated for ' + rated + ' gallons or more' + (heavy ? ' (you have big or messy fish)' : '') + '. Flow of about ' + flow + ' gallons per hour is a good start.' : 'Add your tank size on the tank page and I can suggest a size.');
  } else {
    add('Filter', 'Filter' + sizeTxt,
      gal ? 'Look for a filter rated for ' + rated + ' gallons or more' + (heavy ? ' (you have big or messy fish)' : '') + '. Flow of about ' + flow + ' gallons per hour is a good start.' : 'Add your tank size on the tank page and I can suggest a size.');
  }
  if (!coolFish) {
    add('Heater', 'Heater' + sizeTxt,
      gal ? 'About ' + Math.round(gal * 3) + ' to ' + Math.round(gal * 5) + ' watts keeps most tanks steady. A second small heater is a good backup in bigger tanks.' : 'Most tropical tanks want 3 to 5 watts per gallon.');
  }
  add('Test kit', 'Liquid test kit', salt ? 'For ' + (corals ? 'reef' : 'saltwater') + ' tanks: salinity (refractometer), ammonia, nitrite, nitrate, alkalinity and calcium.' : 'Ammonia, nitrite, nitrate and pH. Liquid kits are more accurate than strips.');
  if (!salt) add('Water conditioner', 'Water conditioner', 'Removes chlorine and chloramine from tap water before it goes in the tank.');
  if (plants) {
    add('Light', 'Plant light', 'Full spectrum light (about 6500K) on a timer, 6 to 8 hours a day.');
    add('Substrate', 'Plant substrate or root tabs', 'Rooted plants like Vallisneria and Swords feed from the substrate.');
    if (gal >= 20) add('CO2 system', 'CO2 (optional)', 'Only needed for demanding plants. Many easy plants do fine without it.');
  } else if (!salt) {
    add('Light', 'Aquarium light', 'Any LED made for aquariums on a timer. Too much light feeds algae.');
  }
  if (salt) {
    add('Light', corals ? 'Reef light' : 'Saltwater light', corals ? 'Corals need a reef-grade light with blue and white channels you can dim.' : 'A basic LED is fine for fish-only. Reef-grade if you add corals later.');
    add('Pump or wavemaker', 'Powerhead or wavemaker', corals ? 'Corals like random, gentle flow across the whole tank. Aim for about ' + (gal ? Math.round(gal * 20) : 20 + ' times the tank volume') + ' gallons per hour in total.' : 'Moves water so waste does not settle.');
    if (gal >= 20 || corals) add('Protein skimmer', 'Protein skimmer', ft && ft !== 'sump' ? 'Pulls waste out before it breaks down. With no sump, look for a hang-on-back or in-tank skimmer rated above your tank size.' : 'Pulls waste out before it breaks down. Pick one rated above your tank size.');
    add('Auto top-off', 'Auto top-off', 'Keeps salinity steady by replacing evaporated water with fresh RO/DI water.');
    add('Fan or chiller', 'Cooling fan', 'Small clip-on fans stop summer heat spikes, which stress corals.');
  }
  if (!salt) {
    if (gal >= 20) add('Pump or wavemaker', 'Powerhead or wavemaker', 'Moves water into dead spots so waste reaches the filter and plant food reaches every corner. Filter flow plus powerhead of about ' + Math.round(gal * 5) + ' to ' + Math.round(gal * 8) + ' gallons per hour is a good start' + (inverts ? ', but keep it gentle and guard the intake if you have shrimp or fry.' : '.') + (gal > 75 ? ' Two, placed at opposite ends, move water more evenly in a big tank.' : ''));
    if (gal >= 10 && ft !== 'sponge') add('Surface skimmer', 'Surface skimmer', 'Pulls the oily film off the top of the water into the filter. Clearer water, better gas exchange and more light for plants.');
    if (plants) add('Fertilizer', 'Plant fertilizer', 'Liquid fertilizer feeds leaf plants from the water. Heavy root feeders like swords and crypts also like root tabs in the substrate.');
    add('Gravel vacuum', 'Gravel vacuum or water changer', 'Lifts waste out of the substrate while you take water out. A hose that reaches the sink makes weekly water changes quick' + (gal >= 40 ? ', and a bigger tank is worth the longer hose.' : '.'));
  }
  if (!salt && inverts) add('Fan or chiller', 'Cooling fan', 'Shrimp are sensitive to heat. Small clip-on fans help in summer if your room runs warm.');
  if (brackish) add('Test kit', 'Hydrometer or refractometer', 'Brackish tanks need a salinity reading too.');
  if (ft === 'sponge' || ft === 'undergravel') add('Air pump', 'Air pump', 'Drives the ' + ft + ' filter. Pick one rated above your tank size, with an air line and a check valve.');
  else if (inverts && !salt && ft !== 'sump') add('Air pump', 'Sponge filter or air pump', 'Shrimp and snails do best with gentle flow, and a sponge filter keeps babies from being sucked in.');
  return out;
}

// ---------- Curated gear picks ----------
// Real models only, hand-checked against maker and retailer spec pages (November 2026).
// Sizes are the makers' own ratings; no prices. Kinds with no verified model simply show no picks.
const GEAR_PICKS_CHECKED = 'November 2026';
const GEAR_DISCLAIMER = 'Product names and models are suggested for compatibility reference only; Schooled is not affiliated with or endorsed by these brands.';
const AQUACLEAR = [[20, 5, 20, 100], [30, 10, 30, 150], [50, 20, 50, 200], [70, 40, 70, 300], [110, 60, 110, 500]]; // model, min gal, max gal, GPH
const FLUVAL07 = [[107, 10, 30], [207, 20, 45], [307, 40, 70], [407, 50, 100]];
const JAGER = [[5, 7, 25], [7, 16, 50], [16, 26, 75], [26, 40, 100], [40, 53, 125], [53, 79, 150], [79, 106, 200], [106, 159, 250], [159, 264, 300]]; // min gal, max gal, watts
const TIDAL = [['35', 35, 130], ['55', 55, 250], ['75', 75, 350], ['110', 110, 450]]; // model, max gal, GPH (Seachem)
const HYDRO_SPONGE = [['I', 10], ['II', 20], ['III', 30], ['IV', 80], ['V', 120]]; // size, max gal (Aquarium Technology)
const FLUVAL_E = [[50, 15], [100, 30], [200, 65], [300, 100]]; // Fluval E heater: watts, max gal (maker)
const COOP_LED = [[3, 12, 13], [7, 16, 0], [12, 20, 0], [20, 24, 0], [45, 36, 0], [9999, 48, 50]]; // Easy Plant LED: max gal, length in, watts (Aquarium Co-Op chart; 13 W for 12 in, 50 W for 48 in)
const FLUVAL_CO2 = [['Mini Pressurized CO2 Kit (20 g)', 15], ['Pressurized CO2 Kit (45 g)', 30], ['Pressurized CO2 Kit (95 g)', 50]]; // kit, max gal
const KORALIA = [['Nano 240', 10, 15, 240], ['Nano 425', 15, 30, 425], ['Nano 565', 20, 40, 565]]; // model, min salt gal, max salt gal, GPH (Hydor)
const CURVE = [['5', 55], ['7', 90]]; // Bubble Magus Curve, BRS heavy-bioload rating in gal
const REGAL = [['Regal 150INT', 100], ['Regal 200SSS', 150], ['Regal 250INT', 250], ['Regal 300INT', 450]]; // Reef Octopus, BRS heavy-bioload rating in gal
const AQUEON = [[50, 20], [100, 30], [150, 55], [200, 75], [300, 100]]; // Aqueon Pro: watts, max gal (maker)
const FINNEX_HMA = [[50, 20], [100, 30], [150, 60], [200, 80], [300, 100], [500, 120]]; // watts, max gal
const FINNEX_TH = [[300, 40, 80], [500, 70, 130], [800, 140, 265]]; // heating tube only: watts, min gal, max gal
const OCTO = [['110-INT', 75], ['150-INT', 120], ['200-INT', 160]]; // model, largest tank Bulk Reef Supply recommends

function gearPicks(kind, t) {
  const gal = tankGallons(t) || 0;
  const salt = t.type === 'Saltwater';
  const fresh = t.type === 'Freshwater';
  const out = [];
  const P = (tier, name, spec) => out.push({ tier, name, spec });
  const g = Math.round(gal);
  const ft = t.filter || '';
  if (kind === 'Filter' && gal > 0) {
    const ac = ft && ft !== 'hob' ? null : AQUACLEAR.find((m) => gal >= m[1] && gal * 1.25 <= m[2]) || AQUACLEAR.find((m) => gal >= m[1] && gal <= m[2]); // a little headroom when there is a bigger model
    if (ac) P('Budget', 'AquaClear ' + ac[0], 'Hang-on filter. Rated ' + ac[1] + ' to ' + ac[2] + ' gal, up to ' + ac[3] + ' GPH.');
    const fl = ft && ft !== 'canister' ? null : FLUVAL07.find((m) => gal >= m[1] && gal * 1.25 <= m[2]) || FLUVAL07.find((m) => gal >= m[1] && gal <= m[2]);
    if (fl) P('Popular', 'Fluval ' + fl[0], 'Canister filter. Rated ' + fl[1] + ' to ' + fl[2] + ' gal.');
    const td = ft && ft !== 'hob' ? null : TIDAL.find((m) => gal <= m[1] && gal * 1.25 <= m[1]) || TIDAL.find((m) => gal <= m[1]);
    if (td) P('Popular', 'Seachem Tidal ' + td[0], 'Hang-on filter with an adjustable flow dial. Rated up to ' + td[1] + ' gal, ' + td[2] + ' GPH.');
    if (fresh && (ft === 'sponge' || (!ft && gal <= 55))) {
      const cs = gal <= 10 ? 'Nano' : gal <= 30 ? 'Medium' : 'Large';
      P('Budget', 'Aquarium Co-Op Easy Flow Sponge Filter (' + cs + ')', 'Sponge filter that runs on an air pump. Retailers list the nano for up to 10 gal, medium for 10 to 30 and large for 30 to 55+. Safe for fry and shrimp.');
    }
    const sp = ft === 'sponge' ? (HYDRO_SPONGE.find((m) => gal <= m[1]) || null) : null;
    if (sp) P('Budget', 'Hydro-Sponge ' + sp[0], 'Sponge filter that runs off an air pump. Sold for up to ' + sp[1] + ' gal.');
    if ((!ft || ft === 'canister') && gal >= 20 && gal <= 150) P('Budget', gal <= 100 ? 'Penn-Plax Cascade Pro 1000 (III)' : 'Penn-Plax Cascade 1200', gal <= 100 ? 'Canister filter, 350 GPH. The maker rates it for up to 100 gal.' : 'Canister filter, 315 GPH. The maker rates it for up to 150 gal.');
    if ((!ft || ft === 'canister') && gal >= 60 && gal <= 400) P('Pro', 'Fluval FX6', 'Large canister filter. Rated up to 400 gal, 925 GPH pump.');
  } else if (kind === 'Heater' && gal > 0) {
    const aq = AQUEON.find((m) => gal <= m[1]);
    if (aq) P('Budget', 'Aqueon Pro Adjustable ' + aq[0] + 'W', 'Shatterproof plastic body with an electronic thermostat. Rated up to ' + aq[1] + ' gal by the maker.');
    const fe = FLUVAL_E.find((m) => gal <= m[1]);
    if (fe) P('Popular', 'Fluval E ' + fe[0] + 'W', 'Electronic heater with a digital display of the real water temperature and a built-in guard. Rated up to ' + fe[1] + ' gal by the maker, freshwater or saltwater.');
    const h = JAGER.find((m) => gal > m[0] && gal <= m[1]) || (gal <= 5 ? JAGER[0] : null);
    if (h) P('Popular', 'EHEIM Jäger TruTemp ' + h[2] + 'W', 'Rated ' + h[0] + ' to ' + h[1] + ' gal by the maker. Go up a size if your room runs cold.');
    const fh = FINNEX_HMA.find((m) => gal <= m[1]);
    const ft2 = FINNEX_TH.find((m) => gal >= m[1] && gal <= m[2]);
    if (fh) P('Pro', 'Finnex HMA-S ' + fh[0] + 'W titanium', 'Titanium heater with a plastic guard and an attached controller. Sold for up to ' + fh[1] + ' gal.');
    else if (ft2) P('Pro', 'Finnex TH-' + ft2[0] + ' titanium tube', 'Titanium heating tube for ' + ft2[1] + ' to ' + ft2[2] + ' gal. It has no thermostat, so pair it with a separate controller such as the Finnex HC-820M.');
  } else if (kind === 'Test kit') {
    if (fresh) P('Popular', 'API Freshwater Master Test Kit', 'Liquid tests for pH, high range pH, ammonia, nitrite and nitrate. About 800 tests.');
    if (salt) {
      P('Budget', 'Salifert KH/Alkalinity and Calcium kits', 'Single-parameter liquid kits sold separately. Cheap ways to watch the two numbers that drift fastest in a reef.');
      P('Popular', 'Red Sea Reef Foundation Pro', 'Titration tests for calcium, alkalinity (KH) and magnesium. About 75 calcium and alkalinity tests and 100 magnesium tests.');
      P('Pro', 'Hanna Marine Alkalinity Checker (HI772)', 'Handheld colorimeter that reads alkalinity in dKH, so you are not judging a color by eye. Reagents are sold separately.');
    }
  } else if (kind === 'Water conditioner') {
    P('Budget', 'API Tap Water Conditioner', 'Removes chlorine, chloramine and heavy metals. Follow the label for how much to add per gallon.');
    P('Popular', 'Seachem Prime', 'Removes chlorine and chloramine, detoxifies ammonia, nitrite and nitrate. Follow the label for how much to use.');
    P('Popular', 'Aquarium Co-Op Easy Dechlorinator', 'Dechlorinator from Aquarium Co-Op. Follow the label for how much to use.');
    P('Pro', 'Fritz Complete', 'A conditioner that retailers recommend for sensitive tanks such as shrimp. Follow the label for how much to use.');
  } else if (kind === 'Light' && gal > 0) {
    if (salt) {
      if (gal <= 15) P('Budget', 'Kessil A80 Tuna Blue', 'Nano reef light, 15 W. Covers about 20 x 20 in, enough for most soft coral nanos and fish-only tanks.');
      if (gal <= 30) P('Popular', 'Kessil A160WE Tuna Blue', 'Compact 40 W reef light. Covers about 12 to 24 in across, depending on mounting height.');
      else P('Popular', 'Kessil A360XE Tuna Blue', '90 W reef light. Covers about 24 x 24 in, which suits LPS and soft corals. Plan one per 24 x 24 in.');
      if (gal > 30 && gal <= 90) P('Pro', 'Kessil A500X', '185 W reef light with an adjustable beam angle, made for SPS-heavy reefs.');
      else if (gal > 90) P('Pro', 'Kessil A500X', '185 W reef light with an adjustable beam angle, made for SPS-heavy reefs. Plan more than one over a big tank.');
      else if (gal > 15) P('Pro', 'Kessil A360XE Tuna Blue', '90 W reef light. Covers about 24 x 24 in. Two per 24 x 24 in suits SPS.');
    } else {
      const nl = gal <= 12 ? 12 : gal <= 20 ? 18 : gal <= 35 ? 30 : gal <= 50 ? 36 : 48;
      P('Budget', 'NICREW SkyLED Plus (' + nl + ' in)', 'Budget 24-hour LED with an automatic sunrise and sunset cycle. Sold from 12 to 60 in, so match your tank length. Fine for easy plants.');
      const sz = gal <= 12 ? ['15 to 24 in', '22 W'] : gal <= 35 ? ['24 to 34 in', '32 W'] : gal <= 50 ? ['36 to 48 in', '46 W'] : ['48 to 60 in', '59 W'];
      P('Popular', 'Fluval Plant 3.0 LED (' + sz[0] + ')', sz[1] + ', 6500K full spectrum with app control. Sold by tank length, so match yours.');
      const fl = gal <= 12 ? '20' : gal <= 20 ? '24' : gal <= 35 ? '30' : gal <= 50 ? '36' : '48';
      P('Popular', 'Finnex Planted+ 24/7 (' + fl + ' in)', 'Automated sunrise to sunset on a built-in controller. Sold by tank length (20, 24, 30, 36, 48 in), so match yours.');
      const cl = COOP_LED.find((m) => gal <= m[0]);
      P('Popular', 'Aquarium Co-Op Easy Plant LED (' + cl[1] + ' in)', 'Plant light with an inline remote, adjustable brightness and sliding brackets for in-between tank lengths. Runs ' + (cl[2] ? cl[2] + ' W' : '13 W on the 12 in up to 50 W on the 48 in') + '. Sold by tank length.');
      if (gal <= 30) P('Pro', 'Kessil A160WE Tuna Sun', 'Compact 40 W light for planted tanks. Covers about 12 to 24 in across.');
      else if (gal <= 90) P('Pro', 'Kessil A360X Tuna Sun', '90 W light for planted tanks. Covers up to 24 x 24 in, so plan one per 20 to 24 in of tank length.');
    }
  } else if (kind === 'Pump or wavemaker' && salt && gal >= 10 && gal <= 500) {
    const kr = KORALIA.find((m) => gal >= m[1] && gal <= m[2]) || (gal > 30 && gal <= 40 ? KORALIA[2] : null);
    if (kr) P('Budget', 'Hydor Koralia ' + kr[0], 'Small propeller pump, ' + kr[3] + ' GPH at 3.5 W, with a ball joint to aim it. Rated for about ' + kr[1] + ' to ' + kr[2] + ' gal of saltwater. Flow is fixed.');
    else if (gal > 40) P('Budget', 'Hydor Koralia Evolution 1500', 'Propeller pump, 1,500 GPH. Hydor rates each one for about 55 to 90 gal of saltwater, so a ' + g + ' gal tank wants about ' + Math.ceil(gal / 90) + ' placed around the tank. Flow is fixed.');
    if (gal <= 135) P('Popular', 'Tunze Nanostream 6045', '400 to 1,175 GPH with a manual flow slider. Rated for about 10 to 135 gal.');
    else if (gal <= 265) P('Popular', 'Tunze Turbelle Nanostream 6095', 'Controllable DC propeller pump, 528 to 2,510 GPH. Bulk Reef Supply lists it for 25 to 265 gal. Plan on two or more for even flow.');
    else P('Popular', 'Tunze Turbelle Stream 6125', '3,150 GPH at 22 W. Bulk Reef Supply lists it for 105 to 525 gal. Plan on two or more for even flow.');
    if (gal <= 50) P('Pro', 'EcoTech VorTech MP10', 'Wireless-ready, programmable wavemaker. Maker rates it for 2.5 to 50+ gal and glass up to 0.375 in thick.');
    else P('Pro', 'EcoTech VorTech MP40', 'Wireless-ready, programmable wavemaker. Maker rates it for 50 to 500+ gal and glass up to 0.75 in thick.');
  } else if (kind === 'Pump or wavemaker' && !salt && gal >= 20 && gal <= 300) {
    P('Budget', 'Aquarium Co-Op Power Head', '211 GPH at 10 W. Fits the Co-Op sponge filter or runs on its own to add circulation. Extra-long cord.');
    if (gal <= 75) P('Budget', 'Marineland Maxi-Jet 400', 'Powerhead, 110 GPH, 8 W, with a suction-cup mount. Works in freshwater or saltwater.');
    P('Popular', 'Marineland Maxi-Jet 600', 'Powerhead at 160 GPH, or 750 GPH with the circulation-pump kit. 8 W, freshwater or saltwater.');
    P('Pro', 'Innovative Marine AquaGadget WaveLink AIO', 'Digital-controlled powerhead, 165 to 1,500 GPH. Magnetic mount for glass up to 15 mm. Freshwater or saltwater.');
  } else if (kind === 'Surface skimmer' && !salt && gal >= 10) {
    if (ft === 'hob' && gal <= 50) P('Budget', 'Fluval AC Surface Skimmer', 'Slides onto the intake of AquaClear and Fluval AC20, AC30 and AC50 power filters, so only if that is your filter. No power cord.');
    if (gal <= 105) P('Popular', 'Fluval SK400 Surface Skimmer', 'Powered skimmer, 400 L/h (about 105 GPH) at about 3 W, with an intake dial. The maker lists it for tanks up to 400 L (105 gal).');
    P('Pro', 'Sicce Shark Mini Skim 350 Plus', 'Powered surface skimmer sold for freshwater tanks. Takes floating plant debris, dust and biofilm.');
  } else if (kind === 'Fertilizer' && !salt) {
    P('Budget', 'Aquarium Co-Op Easy Green', 'All-in-one liquid fertilizer. Safe for fish, shrimp and snails. Follow the label for how much to dose.');
    P('Budget', 'Seachem Flourish', 'Liquid plant supplement with trace elements and micronutrients. Follow the label for how much to dose.');
    P('Popular', 'Aquarium Co-Op Easy Root Tabs', 'Substrate tabs for root feeders such as Amazon swords and cryptocoryne. Push them into the gravel near the roots.');
    P('Popular', 'Fluval Plant Gro+', 'Liquid fertilizer that adds macro and micro nutrients. Follow the label for how much to dose.');
    P('Pro', 'Aquarium Co-Op Easy Iron', 'Iron supplement to bring out the color of red plants. Pair it with a base fertilizer.');
    P('Pro', 'Aquarium Co-Op Easy Potassium', 'Potassium supplement for heavy potassium feeders such as java fern and anubias. Pair it with a base fertilizer.');
  } else if (kind === 'Gravel vacuum' && !salt) {
    P('Budget', 'Python Pro-Clean Gravel Washer', 'Gravel washer on a 6 ft hose that separates debris from the gravel while you siphon. Good for small to medium tanks.');
    P('Budget', 'Fluval EasyVac Gravel Cleaner', 'Narrow oval tube for tight spots, with quick-start priming and a gravel guard so it does not clog.');
    P('Popular', 'Python No Spill Clean and Fill (' + (gal >= 75 ? '50' : '25') + ' ft)', 'Hose, gravel tube and faucet adapter in one kit, so you drain and refill without a bucket. ' + (gal >= 75 ? 'The longer hose reaches a far sink.' : 'Also sold in 50 and 75 ft lengths.'));
    P('Pro', 'Fluval ProVac Gravel Cleaner', 'Plug-in powered cleaner with an LED spotlight and a dual-density filter pad. It filters as it cleans.');
    P('Pro', 'EHEIM Quick Vac Pro', 'Battery-powered cleaner on 4 AA batteries, no hose or bucket. A good fit for small tanks and between water changes.');
  } else if (kind === 'Protein skimmer' && salt && gal > 0 && gal <= 450 && (!ft || ft === 'sump')) {
    const sk = OCTO.find((m) => gal <= m[1]);
    const cv = CURVE.find((m) => gal <= m[1]);
    if (cv) P('Budget', 'Bubble Magus Curve ' + cv[0], 'In-sump skimmer. Bulk Reef Supply sizes it for about ' + cv[1] + ' gal with a heavy fish load, more with a light one.');
    if (sk) P('Popular', 'Reef Octopus Classic ' + sk[0], 'In-sump skimmer, so you need a sump. Bulk Reef Supply recommends it up to ' + sk[1] + ' gal.');
    else if (gal <= 250) P('Popular', 'Reef Octopus Regal 250SSS', 'Space-saving in-sump skimmer with a VarioS-6 DC pump. Bulk Reef Supply sizes it for about 250 gal with a heavy fish load.');
    const rg = REGAL.find((m) => m[1] >= gal * 1.5) || REGAL.find((m) => gal <= m[1]);
    if (rg) P('Pro', 'Reef Octopus ' + rg[0], 'In-sump skimmer with a controllable DC pump. Bulk Reef Supply sizes it for about ' + rg[1] + ' gal with a heavy fish load.');
  } else if (kind === 'Auto top-off' && salt && gal > 0) {
    if (gal <= 50) P('Budget', 'AutoAqua Smart ATO Nano G2', 'Hang-on unit with an optical sensor and a built-in pump. Has run-dry protection and an overflow timer. Made for tanks up to 50 gal.');
    if (gal <= 66) P('Popular', 'Tunze Osmolator 3 Nano', 'Optical sensor, run-dry protection and an adjustable safety timer. Suggested by Bulk Reef Supply for tanks up to 66 gal.');
    if (gal <= 100) P('Pro', 'Tunze Osmolator Universal 3155', 'Tunze\'s flagship top-off, with an optical sensor and a float-switch backup. Best under about 100 gal.');
  } else if (kind === 'Air pump') {
    P('Popular', gal <= 20 ? 'Aquarium Co-Op Air Pump with Battery Backup (single outlet)' : 'Aquarium Co-Op Air Pump with Battery Backup (dual outlet)', gal <= 20 ? 'Built-in battery switches on in a power cut. One outlet, 1.1 L/min, 1.2 W, with adjustable air flow.' : 'Built-in battery switches on in a power cut. Two outlets, 1.6 L/min, 2.1 W, with adjustable air flow.');
    if (gal <= 20) P('Popular', 'Active Aqua AAPA3.2L', 'One outlet, 3.2 L/min, 2 W. Runs one air stone or a small sponge filter.');
    if (gal > 10 && gal <= 75) P('Popular', 'Active Aqua AAPA7.8L', 'Two outlets, 7.8 L/min, 3 W. Runs a couple of stones or sponge filters.');
    if (gal > 40) P('Popular', 'Active Aqua AAPA15L', 'Four outlets, 15 L/min, 6 W. For bigger tanks or several stones and filters.');
  } else if (kind === 'CO2 system' && fresh && gal > 0) {
    const co = FLUVAL_CO2.find((m) => gal <= m[1]);
    P('Budget', 'Aquarium Co-Op Aquario Neo CO2 Diffuser', 'Diffuser only. Pair it with a regulator and a CO2 tank.');
    P('Budget', 'Aquarium Co-Op CO2 Stainless Steel Check Valve', 'Check valve for a CO2 line. Stops water from backing up toward the regulator.');
    P('Pro', 'Aquarium Co-Op CO2 Regulator Expansion Manifold', 'Add-on for a CO2 regulator, sold by Aquarium Co-Op.');
    if (co) P('Popular', 'Fluval ' + co[0], 'Complete kit with regulator and diffuser. Made for planted tanks up to ' + co[1] + ' gal.');
  } else if (kind === 'Fan or chiller' && gal > 0) {
    if (gal <= 50) P('Budget', 'Hygger Aquarium Chiller Cooling Fan (HG051)', 'Clip-on fans that take a few degrees off in hot rooms. Sold for tanks up to about 50 gal, so check your glass thickness.');
    if (gal <= 10) P('Popular', 'JBJ Nano Arctica E-Chiller', 'Compact cooler for tanks up to 10 gal. Cools about 9 to 10 F below room temperature.');
    else if (gal <= 40) P('Popular', 'JBJ Mini Arctica 1/15 HP', 'Inline chiller for small tanks. Wants 100 to 200 GPH of flow through it.');
    else if (gal <= 130) P('Pro', 'JBJ Arctica 1/10 HP', 'Inline titanium chiller. Recommended up to 130 gal, wants 240 to 960 GPH of flow.');
    else if (gal <= 340) P('Pro', 'JBJ Arctica 1/3 HP', 'Inline titanium chiller. Recommended up to 340 gal, wants 480 to 2,400 GPH of flow.');
  } else if (kind === 'Substrate' && !salt) {
    const amt = gal > 0 ? 'About ' + g + ' lb for a 1 in bed, ' + g * 2 + ' lb for 2 in.' : 'About 1 lb per gal for a 1 in bed.';
    P('Budget', 'CaribSea Eco-Complete', 'Black planted-tank gravel, no soil. ' + amt);
    P('Popular', 'Fluval Plant and Shrimp Stratum', 'Volcanic soil from Mount Aso, 3 to 5 mm grains that help hold a neutral to slightly acidic pH. Sold in 8.8 lb (4 kg) bags. Good for shrimp.');
    P('Pro', 'Fluval Bio-Stratum', 'Finer 1 to 3 mm grains infused with nitrifying bacteria, made for small tanks and fine roots. Sold in 8.8 lb bags. Shrimp keepers should use the standard Stratum.');
    P('Popular', 'Seachem Flourite', 'Porous clay gravel that does not change pH and is not replaced. A 7 kg bag makes about a 2 in bed in a 10 gal tank' + (gal > 10 ? ', so about ' + Math.ceil(gal / 10) + ' bags for yours.' : '.'));
    P('Pro', 'ADA Aqua Soil Amazonia', 'Nutrient-rich plant soil that softens water and lowers pH. About one 9 L bag per 15 gal' + (gal > 15 ? ', so about ' + Math.ceil(gal / 15) + ' bags for yours.' : '.') + ' Best for demanding plants, and not for hard-water fish.');
  }
  // Up to three per tier, with Aquarium Co-Op and Fluval listed first inside each tier.
  const fav = (x) => (/Aquarium Co-Op|Fluval/.test(x.name) ? 0 : 1);
  const byTier = (tr) => out.filter((x) => x.tier === tr).sort((a, b) => fav(a) - fav(b)).slice(0, 3);
  return byTier('Budget').concat(byTier('Popular'), byTier('Pro'));
}

const WATER_KINDS = ['Water conditioner', 'Test kit'];
const gearState = { kind: 'Filter', name: '', note: '', skipOpen: false };

const gearOpenKinds = new Set();
// Turn a pick's spec sentence into small tags (size, flow, power) plus one short note.
function pickTags(spec) {
  const tags = [];
  let m = /(\d[\d,.]*)\s*(?:to|-)\s*(\d[\d,.]*)\+?\s*gal\b/.exec(spec);
  if (m) tags.push(m[1] + '–' + m[2] + ' gal');
  else if ((m = /up to (\d[\d,.]*)\s*gal\b/i.exec(spec))) tags.push('≤ ' + m[1] + ' gal');
  else if ((m = /(\d[\d,.]*) gal\b/.exec(spec))) tags.push('≤ ' + m[1] + ' gal');
  if ((m = /(\d[\d,]*)(?:\s*to\s*[\d,]+)? GPH/.exec(spec))) tags.push(m[1] + ' GPH');
  if ((m = /(\d+)\s?W\b/.exec(spec))) tags.push(m[1] + ' W');
  const sentences = spec.split(/(?<=\.)\s+/).filter((x) => !/^(Rated|Sold (for|from)|Maker rates|Hydor rates|Bulk Reef Supply (sizes|lists|recommends)|Suggested by|Made for|Recommended)/.test(x));
  const note = (sentences[0] || '').replace(/\.$/, '');
  return { tags: tags.slice(0, 3), note: note.length > 90 ? note.slice(0, 87).replace(/\s+\S*$/, '') + '…' : note };
}

function renderGear() {
  const t = getTank(openTankId);
  const body = $('tank-gear-body');
  if (!t || !body) return;
  $('tank-gear-count').textContent = t.gear.length ? String(t.gear.length) : '';

  const mine = t.gear.map((g) => el('div', { class: 'gear-row' },
    el('div', { class: 'gear-main' },
      el('strong', { text: g.name }),
      el('span', { class: 'sub', text: g.kind + (g.note ? ' · ' + g.note : '') + (g.added ? ' · added ' + g.added : '') })),
    el('button', { type: 'button', class: 'btn link small-link', 'aria-label': 'Remove ' + g.name, text: 'Remove', onclick: () => { t.gear = t.gear.filter((x) => x.id !== g.id); saveState(); renderGear(); } })));

  const kindSel = el('select', { id: 'gear-kind', 'aria-label': 'Kind of equipment' }, ...GEAR_KINDS.map((k) => el('option', { value: k, text: k })));
  kindSel.value = gearState.kind;
  kindSel.addEventListener('change', () => { gearState.kind = kindSel.value; });
  const nameIn = el('input', { id: 'gear-name', type: 'text', maxlength: '60', placeholder: 'Name or model, e.g. AquaClear 50', autocomplete: 'off', 'aria-label': 'Equipment name', value: gearState.name });
  nameIn.addEventListener('input', () => { gearState.name = nameIn.value; });
  const noteIn = el('input', { id: 'gear-note', type: 'text', maxlength: '120', placeholder: 'Note (optional), e.g. 100W, replace media monthly', autocomplete: 'off', 'aria-label': 'Note', value: gearState.note });
  noteIn.addEventListener('input', () => { gearState.note = noteIn.value; });
  const addBtn = el('button', { type: 'button', class: 'btn primary', text: 'Add equipment', onclick: () => {
    const name = gearState.name.trim();
    if (!name) { toast('Type a name first.'); nameIn.focus(); return; }
    if (t.gear.length >= 40) { toast('That is the most equipment one tank can list.'); return; }
    t.gear.push({ id: uid(), kind: gearState.kind, name: name.slice(0, 60), note: gearState.note.trim().slice(0, 120), added: todayISO() });
    gearState.name = ''; gearState.note = '';
    saveState(); renderGear();
  } });

  const skipped = t.gearSkip;
  const equip = gearSuggestions(t).filter((s) => WATER_KINDS.indexOf(s.kind) === -1); // chemicals and tests live on the Water page
  const isOwned = (s) => t.gear.some((g) => g.kind === s.kind);
  const hiddenCount = equip.filter((s) => !isOwned(s) && skipped.indexOf(s.title) !== -1).length;
  const needed = equip.filter((s) => !isOwned(s) && skipped.indexOf(s.title) === -1);
  const covered = equip.filter(isOwned);
  const sugg = needed.concat(covered); // what is still missing stays on top, owned goes to the end

  const parts = [
    mine.length ? el('div', { class: 'gear-list' }, ...mine) : el('p', { class: 'muted small', text: 'Nothing logged yet. Add the filter, heater, light and anything else on this tank.' }),
    el('div', { class: 'gear-form' }, kindSel, nameIn, noteIn, addBtn),
  ];
  body.replaceChildren(...parts);

  // Recommended gear: its own collapsible card, a vertical list of accordions.
  $('tank-ideas-count').textContent = needed.length ? String(needed.length) : '';
  const gl = tankGallons(t);
  const ip = [el('p', { class: 'muted small gear-lead', text: 'Tailored for your ' + (gl ? Math.round(gl) + ' gal ' : '') + t.type.toLowerCase() + ' tank' + (t.fish.length ? ' and what is in it' : '') + '.' })];
  if (!sugg.length) ip.push(el('p', { class: 'muted small', text: 'No ideas right now.' }));
  else ip.push(el('div', { class: 'gear-acc-list' }, ...sugg.map((s) => {
    const picks = gearPicks(s.kind, t);
    const owned = isOwned(s);
    const hm = /about (\d+) to (\d+) watts/i.exec(s.why);
    const hint = hm ? hm[1] + '\u2013' + hm[2] + ' W' : '';
    const d = el('details', { class: 'gear-acc' + (owned ? ' owned' : '') });
    if (gearOpenKinds.has(s.kind) && !owned) d.open = true;
    d.addEventListener('toggle', () => {
      if (d.open) {
        // Only one category open at a time: close any other open one.
        gearOpenKinds.clear(); gearOpenKinds.add(s.kind);
        const list = d.parentNode;
        if (list) list.querySelectorAll('details.gear-acc[open]').forEach((o) => { if (o !== d) o.open = false; });
      } else gearOpenKinds.delete(s.kind);
    });
    const sum = el('summary', null,
      el('span', { class: 'gear-acc-title' }, el('strong', { text: s.kind }), hint ? el('span', { class: 'gear-acc-hint', text: hint }) : null),
      owned ? el('span', { class: 'owned-pill', text: '✓ Owned' }) : (picks.length ? el('span', { class: 'gear-acc-count', text: picks.length + (picks.length === 1 ? ' pick' : ' picks') }) : null),
      owned ? null : el('button', { type: 'button', class: 'gear-x', 'aria-label': 'Dismiss ' + s.kind, text: '×', onclick: (e) => { e.preventDefault(); e.stopPropagation(); t.gearSkip.push(s.title); t.gearSkip = t.gearSkip.slice(-30); saveState(); renderGear(); } }));
    d.appendChild(sum);
    const body2 = el('div', { class: 'gear-acc-body' }, el('p', { class: 'sub gear-why', text: s.why }));
    picks.forEach((p) => {
      const pt = pickTags(p.spec);
      body2.appendChild(el('button', { type: 'button', class: 'gpick tier-' + p.tier.toLowerCase(), 'aria-label': 'Add ' + p.name + ' to my equipment', title: p.spec, onclick: () => { gearState.kind = s.kind; addPickToGear(t, s.kind, p.name); renderGear(); } },
        el('span', { class: 'gpick-main' },
          el('span', { class: 'tier-pill', text: p.tier }),
          el('strong', { text: p.name }),
          pt.tags.length ? el('span', { class: 'gpick-tags' }, ...pt.tags.map((x) => el('span', { class: 'gtag', text: x }))) : null,
          pt.note ? el('span', { class: 'sub gpick-note', text: pt.note }) : null),
        el('span', { class: 'gpick-add', 'aria-hidden': 'true', text: '+ Add' })));
    });
    body2.appendChild(el('button', { type: 'button', class: 'btn link small-link gpick-other', text: picks.length ? 'I have a different one' : 'I have one', onclick: () => { gearState.kind = s.kind; gearState.name = ''; $('tank-gear').open = true; renderGear(); $('gear-name').focus(); } }));
    d.appendChild(body2);
    return d;
  })));
  if (hiddenCount) ip.push(el('button', { type: 'button', class: 'btn link', text: 'Show ' + hiddenCount + ' dismissed idea' + (hiddenCount === 1 ? '' : 's'), onclick: () => { t.gearSkip = []; saveState(); renderGear(); } }));
  ip.push(el('p', { class: 'gear-foot', text: GEAR_DISCLAIMER + ' Check the label on anything you buy.' + (sugg.some((s) => gearPicks(s.kind, t).length) ? ' Sizes are the makers\' ratings, last checked ' + GEAR_PICKS_CHECKED + '.' : '') }));
  $('tank-ideas-body').replaceChildren(...ip);
}

// Progress photos live in the browser's database (IndexedDB), not in the small saved-settings space.
const PhotoDB = (() => {
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined' || !indexedDB) { reject(new Error('none')); return; }
      const rq = indexedDB.open('schooled-photos', 1);
      rq.onupgradeneeded = () => { const s = rq.result.createObjectStore('photos', { keyPath: 'id' }); s.createIndex('tank', 'tank'); };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error || new Error('open'));
    });
    dbp.catch(() => { dbp = null; });
    return dbp;
  }
  async function run(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('photos', mode);
      const req = fn(tx.objectStore('photos'));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('abort'));
    });
  }
  return {
    add: (p) => run('readwrite', (s) => s.put(p)),
    list: (tank) => run('readonly', (s) => s.index('tank').getAll(tank)),
    del: (id) => run('readwrite', (s) => s.delete(id)),
    async delTank(tank) { const all = await this.list(tank); for (const p of all) await this.del(p.id); }
  };
})();

const photoState = { date: '', note: '', list: null, error: false, tank: '', viewing: '', gallery: false };

async function loadProgressPhotos() {
  const t = getTank(openTankId);
  if (!t) return;
  photoState.tank = t.id;
  try {
    const list = await PhotoDB.list(t.id);
    if (photoState.tank !== t.id) return;
    photoState.list = list.sort((a, b) => (a.date === b.date ? b.id.localeCompare(a.id) : b.date.localeCompare(a.date)));
    photoState.error = false;
  } catch (err) {
    photoState.list = [];
    photoState.error = true;
  }
  renderProgress();
}

function progressInputs(t) {
  const camIn = el('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: '' });
  const galIn = el('input', { type: 'file', accept: 'image/*,.heic,.heif,.avif,.webp', hidden: '' });
  [camIn, galIn].forEach((inp) => inp.addEventListener('change', async () => {
    const file = inp.files && inp.files[0];
    inp.value = '';
    if (!file) return;
    try {
      const data = await photoFromFile(file, 1000);
      await PhotoDB.add({ id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), tank: t.id, date: photoState.date || todayISO(), note: photoState.note.trim().slice(0, 80), data });
      photoState.note = '';
      await loadProgressPhotos();
      toast('Photo saved.');
    } catch (err) {
      toast("Couldn't save that photo. This browser may not allow saved photos, or it is out of space.");
    }
  }));
  return { camIn, galIn };
}

function renderProgress() {
  const t = getTank(openTankId);
  const body = $('tank-progress-body');
  if (!t || !body) return;
  const list = photoState.list;
  $('tank-progress-count').textContent = list && list.length ? String(list.length) : '';
  if (!photoState.date) photoState.date = todayISO();

  const dateIn = el('input', { id: 'progress-date', type: 'date', max: todayISO(), value: photoState.date, 'aria-label': 'Date of the photo' });
  dateIn.addEventListener('change', () => { photoState.date = /^\d{4}-\d{2}-\d{2}$/.test(dateIn.value) ? dateIn.value : todayISO(); });
  const noteIn = el('input', { id: 'progress-note', type: 'text', maxlength: '80', placeholder: 'Caption (optional), e.g. Week 4, plants filling in', autocomplete: 'off', 'aria-label': 'Caption', value: photoState.note });
  noteIn.addEventListener('input', () => { photoState.note = noteIn.value; });
  const { camIn, galIn } = progressInputs(t);

  const parts = [
    el('p', { class: 'muted small', text: 'Add a photo every week or two and watch the tank grow in. Photos stay on this phone.' }),
    el('div', { class: 'row photo-actions' },
      el('button', { type: 'button', class: 'btn small primary', text: 'Take photo', onclick: () => camIn.click() }),
      el('button', { type: 'button', class: 'btn small', text: 'Upload photo', onclick: () => galIn.click() }),
      list && list.length ? el('button', { type: 'button', class: 'btn small', id: 'open-gallery', text: 'Open gallery (' + list.length + ')', onclick: openGallery }) : null),
    camIn, galIn,
    el('details', { class: 'photo-details' }, el('summary', { text: 'Date and caption (optional)' }),
      el('div', { class: 'gear-form' }, el('label', { class: 'field' }, el('span', { class: 'label', text: 'Photo date' }), dateIn), noteIn))
  ];
  if (photoState.error) parts.push(el('p', { class: 'error small', text: 'This browser does not allow saved photos right now (private mode can cause this).' }));
  if (list === null) parts.push(el('p', { class: 'muted small', text: 'Loading photos...' }));
  else if (list.length) {
    parts.push(el('div', { class: 'progress-grid strip' }, ...list.slice(0, 3).map((p) => progressTile(p))));
  } else if (!photoState.error) parts.push(el('p', { class: 'muted small', text: 'No progress photos yet.' }));

  const view = list && photoState.viewing ? list.find((p) => p.id === photoState.viewing) : null;
  if (view) {
    const close = () => { photoState.viewing = ''; renderProgress(); };
    parts.push(el('div', { class: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Photo from ' + view.date },
      el('img', { src: view.data, alt: 'Tank on ' + view.date }),
      el('p', { class: 'viewer-cap', text: view.date + (view.note ? ' · ' + view.note : '') }),
      el('div', { class: 'row' },
        el('button', { type: 'button', class: 'btn', text: 'Close', onclick: close }),
        el('button', { type: 'button', class: 'btn danger', text: 'Delete photo', onclick: async () => {
          try { await PhotoDB.del(view.id); } catch (err) { toast("Couldn't delete that photo."); return; }
          photoState.viewing = '';
          await loadProgressPhotos();
        } }))));
  }
  body.replaceChildren(...parts);
  renderGallery();
}

function progressTile(p) {
  return el('button', { type: 'button', class: 'progress-tile', 'aria-label': 'Open photo from ' + p.date, onclick: () => { photoState.viewing = p.id; renderProgress(); } },
    el('img', { src: p.data, alt: 'Tank on ' + p.date }),
    el('span', { class: 'progress-date', text: p.date }));
}

// The whole gallery for this tank: every photo, plus the first and latest side by side.
function openGallery() { photoState.gallery = true; renderGallery(); }
function closeGallery() {
  photoState.gallery = false;
  const g = $('gallery-sheet');
  if (g) { g.hidden = true; g.replaceChildren(); }
}
function renderGallery() {
  const g = $('gallery-sheet');
  if (!g) return;
  const t = getTank(openTankId);
  if (!photoState.gallery || !t) { g.hidden = true; return; }
  const list = photoState.list || [];
  const { camIn, galIn } = progressInputs(t);
  const parts = [
    el('div', { class: 'sheet-head' }, el('h2', { text: 'Photos of ' + tankLabel(t) }),
      el('button', { type: 'button', id: 'gallery-close', class: 'sheet-x', 'aria-label': 'Close gallery', onclick: closeGallery }, iconSvg(['M6 6l12 12', 'M18 6L6 18'], 20))),
    el('div', { class: 'row photo-actions' },
      el('button', { type: 'button', class: 'btn small primary', text: 'Take photo', onclick: () => camIn.click() }),
      el('button', { type: 'button', class: 'btn small', text: 'Upload photo', onclick: () => galIn.click() })),
    camIn, galIn
  ];
  if (list.length) {
    parts.push(el('div', { class: 'progress-grid' }, ...list.map((p) => progressTile(p))));
    if (list.length > 1) {
      const a = list[list.length - 1], b = list[0];
      parts.push(el('div', { class: 'progress-compare' },
        el('h3', { class: 'gear-h', text: 'First and latest' }),
        el('div', { class: 'progress-pair' },
          el('figure', {}, el('img', { src: a.data, alt: 'First photo' }), el('figcaption', { text: a.date })),
          el('figure', {}, el('img', { src: b.data, alt: 'Latest photo' }), el('figcaption', { text: b.date })))));
    }
  } else parts.push(el('p', { class: 'muted', text: 'No photos yet. Take or upload one to start the gallery.' }));
  g.replaceChildren(el('div', { class: 'sheet-dim', onclick: closeGallery }), el('div', { class: 'sheet tall', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Tank photos' }, el('div', { class: 'sheet-grab', 'aria-hidden': 'true' }), ...parts));
  g.hidden = false;
}

function changeCount(tank, fish, delta) {
  fish.count += delta;
  if (fish.count < 1) tank.fish = tank.fish.filter((f) => f !== fish);
  if (fish.count > 999) fish.count = 999;
  saveState();
  if (currentView === 'species') renderSpecies(); else renderTank();
}


function openEditSheet(focusName) {
  if (!getTank(openTankId)) return;
  $('edit-sheet').hidden = false;
  if (focusName) setTimeout(() => { try { $('tank-title-input').focus(); } catch (e) { /* ignore */ } }, 50);
}
function closeEditSheet() { const sh = $('edit-sheet'); if (sh) sh.hidden = true; }
function closeSheets() { closeEditSheet(); closeGallery(); closeScanSheet(); }
$('tank-edit').addEventListener('click', () => openEditSheet(false));
$('tank-ask').addEventListener('click', () => openAsk(openTankId));
$('edit-sheet-close').addEventListener('click', closeEditSheet);
$('edit-sheet-done').addEventListener('click', closeEditSheet);
$('edit-sheet-dim').addEventListener('click', closeEditSheet);
$('home-add').addEventListener('click', () => startAddTank());

$('tank-title-input').addEventListener('change', () => {
  const t = getTank(openTankId);
  if (!t) return;
  t.name = $('tank-title-input').value.trim().slice(0, 40);
  saveState();
  if (currentView === 'tank') renderTank();
});

$('tank-notes').addEventListener('change', () => {
  const t = getTank(openTankId);
  if (!t) return;
  t.notes = $('tank-notes').value.slice(0, 400);
  saveState();
});

function setTankPhoto(url) {
  const t = getTank(openTankId);
  if (!t) return;
  const old = t.photo;
  t.photo = url;
  if (!saveState()) {
    t.photo = old;
    toast('This phone is out of saved space for photos. Remove a photo from another tank and try again.');
  }
  renderTank();
}
wireTankPhotoInput('tank-photo-camera', 'tank-photo-camera-input', setTankPhoto);
wireTankPhotoInput('tank-photo-gallery', 'tank-photo-gallery-input', setTankPhoto);
$('tank-photo-remove').addEventListener('click', () => {
  const t = getTank(openTankId);
  if (!t) return;
  t.photo = '';
  saveState();
  renderTank();
});

const addSearch = createSearch({
  placeholder: 'Search to add a fish, plant or coral', label: 'Add a fish, plant or coral',
  type: () => { const t = getTank(openTankId); return t ? t.type : 'Freshwater'; },
  onPick: (name, entry) => {
    const t = getTank(openTankId);
    if (!t) return;
    addToTank(t, name, 1, 'add', entry ? entry.k : undefined);
    addSearch.clear();
    closeAddPop();
    saveState();
    renderTank();
  }
});
$('add-slot').append(addSearch.root);
function openAddPop() { addSearch.clear(); $('add-pop').hidden = false; addSearch.input.focus(); }
function closeAddPop() { $('add-pop').hidden = true; addSearch.clear(); }
$('add-pop-close').addEventListener('click', closeAddPop);
$('add-pop').addEventListener('click', (ev) => { if (ev.target === $('add-pop')) closeAddPop(); });

let deleteArmed = false;
let deleteTimer = null;
function resetDelete() {
  deleteArmed = false;
  clearTimeout(deleteTimer);
  $('tank-delete').textContent = 'Delete this tank';
}
$('tank-delete').addEventListener('click', () => {
  const t = getTank(openTankId);
  if (!t) return;
  if (!deleteArmed) {
    deleteArmed = true;
    $('tank-delete').textContent = 'Tap again to delete this tank and its fish list';
    deleteTimer = setTimeout(resetDelete, 4000);
    return;
  }
  resetDelete();
  PhotoDB.delTank(t.id).catch(() => {});
  state.tanks = state.tanks.filter((x) => x !== t);
  if (state.activeId === t.id) state.activeId = state.tanks[0] ? state.tanks[0].id : '';
  saveState();
  showView('home');
});

// ---------- Scan ----------
function wirePhotoInput(inputId) {
  $(inputId).addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = ''; // lets the same photo be picked again
    if (file) startScan(file);
  });
}
wirePhotoInput('camera-input');
wirePhotoInput('gallery-input');
if ($('video-input')) $('video-input').addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (file) startVideoScan(file);
});

$('rescan').addEventListener('click', () => $('gallery-input').click());
$('add-photo').addEventListener('click', () => $('more-photo-input').click());
$('more-photo-input').addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (file) startScan(file, true);
});
$('results-back').addEventListener('click', () => goBack(() => { const t = getTank(pending && pending.tankId) || activeTank(); pending = null; if (t) showTank(t.id); else showView('home'); }));

// Opens a photo from almost any format. Tries the browser first, then a converter for iPhone HEIC photos.
async function decodeWithBrowser(blob) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, done: () => { if (bitmap.close) bitmap.close(); } };
    } catch (err) { /* fall through to the older method */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve({ source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad_image')); };
    img.src = url;
  });
}

let heicLoader = null;
function loadHeicConverter() {
  if (window.HeicTo) return Promise.resolve(window.HeicTo);
  if (!heicLoader) {
    heicLoader = new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = 'heic-to.js';
      tag.onload = () => (window.HeicTo ? resolve(window.HeicTo) : reject(new Error('bad_image')));
      tag.onerror = () => { heicLoader = null; reject(new Error('bad_image')); };
      document.head.appendChild(tag);
    });
  }
  return heicLoader;
}

async function loadImage(file) {
  try {
    return await decodeWithBrowser(file);
  } catch (firstError) {
    // The browser could not open it. Try converting (HEIC/HEIF from iPhones and some Android phones).
    try {
      const HeicTo = await loadHeicConverter();
      const jpeg = await HeicTo({ blob: file, type: 'image/jpeg', quality: 0.9 });
      return await decodeWithBrowser(jpeg);
    } catch (secondError) {
      throw new Error('bad_image');
    }
  }
}

function drawToJpeg(source, sx, sy, sw, sh, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // transparent PNGs/GIFs become white instead of black
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', quality);
}

// A small square picture of one fish, cut from the scan photo, to use as its icon in the tank.
// box is [ymin, xmin, ymax, xmax] from 0 to 1000; without a box the middle of the photo is used.
const FISH_THUMB_SIDE = 240;
function fishThumb(image, box, side0) {
  try {
    if (!image || !image.source || !image.width) return '';
    const W = image.width, H = image.height;
    let cx = W / 2, cy = H / 2, side = Math.min(W, H);
    if (Array.isArray(box) && box.length === 4) {
      const x1 = box[1] / 1000 * W, x2 = box[3] / 1000 * W, y1 = box[0] / 1000 * H, y2 = box[2] / 1000 * H;
      if (Math.min(x2 - x1, y2 - y1) < 40) return ''; // too small in the photo to make a useful icon
      cx = (x1 + x2) / 2; cy = (y1 + y2) / 2;
      side = Math.min(Math.max(x2 - x1, y2 - y1) * 1.15, W, H);
    }
    const sx = Math.max(0, Math.min(W - side, cx - side / 2)), sy = Math.max(0, Math.min(H - side, cy - side / 2));
    return drawToJpeg(image.source, sx, sy, side, side, side0 || FISH_THUMB_SIDE, side0 ? 0.82 : 0.8);
  } catch (err) { return ''; }
}
function biggestBox(boxes) {
  return (boxes || []).slice().sort((a, b) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1]))[0] || null;
}

// The first, cheap request: one sharp picture of the whole tank.
function makeSingle(image) {
  const sharp = drawToJpeg(image.source, 0, 0, image.width, image.height, SINGLE_SIDE, 0.8);
  const preview = drawToJpeg(image.source, 0, 0, image.width, image.height, MAX_PHOTO_SIDE, 0.82);
  return { images: [sharp.split(',')[1]], previewUrl: preview };
}

// ---------- Photo quality check (free, runs on the phone) ----------
// Only catches clearly dark or clearly blurry photos, so it never nags about a decent shot.
function photoQualityTip(image) {
  return photoQuality(image).tip;
}

function photoQuality(image) {
  try {
    const w = 512;
    const h = Math.max(8, Math.round(w * image.height / image.width));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image.source, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data;
    const gray = new Float32Array(w * h);
    let total = 0;
    for (let i = 0; i < w * h; i++) {
      gray[i] = px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114;
      total += gray[i];
    }
    const brightness = total / (w * h);
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
        sum += lap;
        sumSq += lap * lap;
        n++;
      }
    }
    const mean = sum / (n || 1);
    const edges = sumSq / (n || 1) - mean * mean;
    if (brightness < 28) return { tip: 'This photo is very dark, so fish may be missed. Turn the tank light on and try again.', severe: brightness < 18 };
    if (edges < 25) return { tip: 'This photo looks blurry, so fish may be missed. Hold steady, tap the tank on screen to focus, and try again.', severe: edges < 8 };
  } catch (err) { /* no canvas available: skip the check */ }
  return { tip: '', severe: false };
}

function friendlyError(code, status) {
  switch (code) {
    case 'rate_limited': return 'Lots of scans right now. Wait a minute and try again.';
    case 'ai_busy': return 'The photo reader is busy. Try again in a moment.';
    case 'limit_reached': return 'You have used this month\u2019s photo scans. They come back on the 1st.';
    case 'busy_today': return 'Photo scans are very busy today. Please try again tomorrow.';
    case 'bad_image': return "That photo couldn't be read. Try a different one.";
    case 'too_large': return 'That photo is too large. Try a smaller one.';
    case 'server_not_configured': return 'The server is not set up yet. Check the Worker secret.';
    default: return status ? 'Something went wrong (' + status + '). Try again.' : 'Something went wrong. Try again.';
  }
}

async function askWorker(images, mode, timeoutMs, ctx) {
  ctx = ctx || {};
  const body = { images, mime: 'image/jpeg', mode, known: ctx.known || [], device: deviceId() };
  if (ctx.tank_type) body.tank_type = ctx.tank_type;
  if (ctx.items) body.items = ctx.items;
  if (ctx.deep) body.deep = true;
  const res = await fetch(WORKER_URL + '/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    throw new Error((data.error === 'ai_error' || data.error === 'ai_busy') && data.ai_detail !== undefined
      ? 'The photo reader had trouble (' + (data.ai_detail || 'error ' + data.ai_status) + '). Please try again in a moment.'
      : friendlyError(data.error, res.status));
  }
  if (data.first_pass && data.first_pass.usage) logUsage('fish', data.first_pass.model, data.first_pass.usage, { detail: 'first look' });
  if (data.usage) logUsage(mode === 'zoom' || mode === 'verify' ? 'zoom' : mode === 'fish' ? 'fish' : 'scan', data.model, data.usage, { detail: mode + (ctx.deep ? ' deep' : '') + ', ' + (images || []).length + ' img, ' + Math.round(JSON.stringify(images || []).length / 1024) + ' KB' });
  return data;
}

function titleCase(text) {
  return text.replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/'S\b/g, "'s");
}
function canonName(name) {
  const hit = lookupSpecies(name);
  return hit ? hit.n : String(name).trim().slice(0, 60);
}
function canonList(list) {
  const seen = new Set();
  const out = [];
  (Array.isArray(list) ? list : []).forEach((n) => {
    const c = canonName(n || '');
    const k = canonKey(c);
    if (c && !seen.has(k)) { seen.add(k); out.push(c); }
  });
  return out;
}

// Fish that look alike get a tell-apart tip, and a photo alone can't be "Sure" about the hard groups.
// A look-alike already in the tank goes first in "Could also be".
// A suggested look-alike must be the same kind (fish, coral, plant...) as what was seen. Unknown names are left alone.
function sameKindAs(name, ref) {
  const x = lookupSpecies(name), y = lookupSpecies(ref);
  return !(x && y && x.k && y.k && x.k !== y.k);
}

// Vague labels the AI falls back on when it can't tell cichlids apart. They are never a confident answer.
function isGenericName(name) {
  return /^((african|malawi|tanganyika|lake victoria|small|large|mixed|dwarf)\s+)?(cichlid|cichlids|mbuna|haplochromis)$/i.test(String(name || '').trim()) || /^peacock cichlid$/i.test(String(name || '').trim());
}

function lookalikeGuard(sp) {
  if (isGenericName(sp.name)) sp.confidence = Math.min(sp.confidence, 0.6);
  if (!DB.ready || sp.kind === 'plant' || !sp.group || !DB.groups[sp.group]) return;
  const group = DB.groups[sp.group];
  const tank = getTank(pending && pending.tankId);
  const key = canonKey(sp.name);
  const members = DB.list.filter((e) => e.g === sp.group && normKey(e.n) !== key);
  const padding = group.h ? members.map((e) => e.n) : [];
  const inTank = members.filter((e) => tank && tank.fish.some((f) => canonKey(f.name) === normKey(e.n)));
  const seen = new Set([key]);
  const alts = [];
  inTank.map((e) => e.n).concat(sp.alternatives || [], padding).forEach((n) => {
    const k = canonKey(n);
    if (n && sameKindAs(n, sp.name) && !seen.has(k)) { seen.add(k); alts.push(n); }
  });
  sp.alternatives = alts.slice(0, 3);
  sp.tankMatches = inTank.map((e) => e.n);
  if (group.h && !sp.verified) sp.confidence = Math.min(sp.confidence, 0.85);
}

function mergeDuplicates() {
  const out = [];
  pending.species.forEach((sp) => {
    const same = out.find((o) => canonKey(o.name) === canonKey(sp.name) && o.kind === sp.kind);
    if (!same) { out.push(sp); return; }
    same.count = Math.min(999, same.count + sp.count);
    same.confidence = Math.max(same.confidence, sp.confidence);
    same.verified = same.verified || sp.verified;
    same.boxes = (same.boxes || []).concat(sp.boxes || []).slice(0, 3);
  });
  pending.species = out;
}

function applyResult(data, mode) {
  if (data.is_aquarium === false) {
    pending.error = "That doesn't look like an aquarium. Try a photo of your tank.";
  } else if (!data.species || !data.species.length) {
    pending.error = "Couldn't spot any fish, plants or corals. Try getting closer, with less glare.";
  }
  pending.species = (data.species || []).map((s) => {
    const hit = resolveSpecies(s.common_name, s.scientific_name, 'scan', s.kind);
    const kind = hit && KIND_LIST.includes(hit.k) ? hit.k : (s.kind || 'fish');
    return {
      name: hit ? hit.n : s.common_name,
      scientific: usableScientific(hit) || s.scientific_name || '',
      kind,
      group: hit && hit.g ? hit.g : '',
      count: s.count,
      confidence: s.confidence,
      alternatives: canonList(s.alternatives).filter((n) => canonKey(n) !== canonKey(hit ? hit.n : s.common_name)),
      boxes: Array.isArray(s.boxes) ? s.boxes : [],
      verified: false,
      editing: false
    };
  });
  mergeDuplicates();
  pending.species.forEach(lookalikeGuard);
  pending.tips = data.photo_tips || '';
  if (data.too_far && !pending.tips) pending.tips = 'Some fish look small here, so names may be off. Try again from closer, or photograph one end of the tank at a time.';
  pending.debug = data.model ? 'Read by ' + data.model + ' (' + (mode || data.mode) + ' scan' + (data.usage ? ', ' + data.usage.input + ' in, ' + data.usage.output + ' out tokens' : '') + ')' : '';
}

// ---------- Find, then zoom in ----------
const VERIFY_MAX = 6;
function needsVerify(sp) {
  const group = sp.group && DB.groups[sp.group];
  if (!(sp.kind === 'fish' || sp.kind === 'coral' || sp.kind === 'invert' || sp.kind === 'plant' || group)) return false;
  if (!sp.boxes || !sp.boxes.length) return false;
  return sp.confidence < 0.9 || !!(group && group.h) || !lookupSpecies(sp.name);
}

// Boxes are [ymin, xmin, ymax, xmax] from 0 to 1000. Pad them so the fish isn't cut off.
function cropRect(box, W, H) {
  let x1 = box[1] / 1000 * W, x2 = box[3] / 1000 * W, y1 = box[0] / 1000 * H, y2 = box[2] / 1000 * H;
  const padX = (x2 - x1) * 0.3, padY = (y2 - y1) * 0.3;
  x1 = Math.max(0, x1 - padX); x2 = Math.min(W, x2 + padX);
  y1 = Math.max(0, y1 - padY); y2 = Math.min(H, y2 + padY);
  return { x: x1, y: y1, w: Math.max(16, x2 - x1), h: Math.max(16, y2 - y1) };
}

// Up to three close-ups of the same kind of animal, side by side in one picture.
function makeMontage(image, boxes) {
  const tiles = boxes.slice().sort((a, b) => (b[2] - b[0]) * (b[3] - b[1]) - (a[2] - a[0]) * (a[3] - a[1])).slice(0, 3).map((box) => {
    const r = cropRect(box, image.width, image.height);
    const scale = Math.min(2.5, 480 / Math.max(r.w, r.h));
    return { r, w: Math.max(8, Math.round(r.w * scale)), h: Math.max(8, Math.round(r.h * scale)) };
  });
  const gap = 6;
  let width = tiles.reduce((sum, t) => sum + t.w, 0) + gap * (tiles.length - 1);
  const shrink = width > 1400 ? 1400 / width : 1;
  width = Math.round(width * shrink);
  const height = Math.round(Math.max(...tiles.map((t) => t.h)) * shrink);
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#222';
  ctx.fillRect(0, 0, width, height);
  let x = 0;
  tiles.forEach((t) => {
    const dw = Math.round(t.w * shrink), dh = Math.round(t.h * shrink);
    ctx.drawImage(image.source, t.r.x, t.r.y, t.r.w, t.r.h, x, 0, dw, dh);
    x += dw + Math.round(gap * shrink);
  });
  return canvas.toDataURL('image/jpeg', 0.88).split(',')[1];
}

function applyVerified(targets, data) {
  (data.items || []).forEach((it) => {
    const sp = targets[it.index];
    if (!sp) return;
    if (it.confidence >= 0.45 && !/^unidentified/i.test(it.common_name)) {
      const hit = resolveSpecies(it.common_name, it.scientific_name, 'close-up', it.kind);
      sp.name = hit ? hit.n : it.common_name;
      sp.scientific = usableScientific(hit) || it.scientific_name || '';
      if (hit && KIND_LIST.includes(hit.k)) sp.kind = hit.k;
      sp.group = hit && hit.g ? hit.g : '';
      sp.confidence = it.confidence;
      sp.alternatives = canonList(it.alternatives).filter((n) => canonKey(n) !== canonKey(sp.name));
      sp.verified = true;
    } else {
      sp.confidence = Math.min(sp.confidence, 0.5); // the close-ups didn't back up the first guess
    }
  });
  mergeDuplicates();
  pending.species.forEach(lookalikeGuard);
}

function showScanError(err) {
  if (err && err.name === 'TimeoutError') pending.error = 'That took too long. Try again, or try a smaller or clearer photo.';
  else if (err instanceof TypeError) pending.error = "Couldn't reach the server. Check your connection and try again.";
  else if (err.message === 'bad_image') pending.error = "This device couldn't open that photo. Try the Take a photo button, or pick a different picture.";
  else pending.error = err.message || friendlyError();
}

// Several photos of one tank add up to one list: the same species keeps its highest count.
function mergeSessions(prior, fresh) {
  const out = prior.slice();
  fresh.forEach((sp) => {
    const same = out.find((o) => canonKey(o.name) === canonKey(sp.name) && o.kind === sp.kind);
    if (!same) { out.push(sp); return; }
    same.count = Math.max(same.count, sp.count);
    if (sp.verified && !same.verified) { same.confidence = sp.confidence; same.verified = true; same.scientific = sp.scientific || same.scientific; }
    else same.confidence = Math.max(same.confidence, sp.confidence);
  });
  return out;
}

// ---------- Short video scan ----------
// Picks the sharpest, most different frames from a few seconds of video. `scores` has one sharpness value per candidate frame.
function pickFrames(scores, wanted) {
  const order = scores.map((v, i) => i).sort((a, b) => scores[b] - scores[a]);
  const picked = [];
  order.forEach((i) => {
    if (picked.length >= wanted) return;
    if (picked.every((j) => Math.abs(j - i) >= 2)) picked.push(i);
  });
  // Not enough spread-out frames (a very short clip): fill with the next sharpest ones.
  order.forEach((i) => { if (picked.length < wanted && picked.indexOf(i) === -1) picked.push(i); });
  return picked;
}

// Rough sharpness: average change between neighbouring pixels on a small grey copy of the frame.
function frameSharpness(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data;
  let sum = 0, n = 0;
  for (let y = 1; y < h; y += 1) {
    for (let x = 1; x < w; x += 1) {
      const i = (y * w + x) * 4, a = (y * w + x - 1) * 4, b = ((y - 1) * w + x) * 4;
      const g = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11;
      sum += Math.abs(g - (d[a] * 0.3 + d[a + 1] * 0.59 + d[a + 2] * 0.11)) + Math.abs(g - (d[b] * 0.3 + d[b + 1] * 0.59 + d[b + 2] * 0.11));
      n += 2;
    }
  }
  return n ? sum / n : 0;
}

async function extractVideoFrames(file, wanted) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.preload = 'auto'; video.setAttribute('playsinline', ''); video.src = url;
  const waitFor = (name, ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { video.removeEventListener(name, ok); reject(new Error('video_timeout')); }, ms);
    const ok = () => { clearTimeout(timer); resolve(); };
    video.addEventListener(name, ok, { once: true });
  });
  try {
    if (video.readyState < 1) { video.load(); await waitFor('loadedmetadata', 12000); }
    const dur = isFinite(video.duration) && video.duration > 0 ? Math.min(video.duration, 10) : 3;
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh) throw new Error('video_size');
    const scale = Math.min(1, 1280 / Math.max(vw, vh));
    const big = document.createElement('canvas'); big.width = Math.round(vw * scale); big.height = Math.round(vh * scale);
    const small = document.createElement('canvas'); small.width = 240; small.height = Math.max(1, Math.round(240 * vh / vw));
    const bigCtx = big.getContext('2d'), smallCtx = small.getContext('2d', { willReadFrequently: true });
    const count = 12, blobs = [], scores = [];
    for (let k = 0; k < count; k++) {
      const t = dur * (0.08 + 0.84 * (k / (count - 1)));
      try {
        video.currentTime = t;
        await waitFor('seeked', 6000);
      } catch (e) { continue; }
      bigCtx.drawImage(video, 0, 0, big.width, big.height);
      smallCtx.drawImage(video, 0, 0, small.width, small.height);
      const blob = await new Promise((resolve) => big.toBlob(resolve, 'image/jpeg', 0.88));
      if (!blob) continue;
      blobs.push(blob); scores.push(frameSharpness(smallCtx, small.width, small.height));
    }
    if (!blobs.length) throw new Error('video_frames');
    return pickFrames(scores, Math.min(wanted, blobs.length)).map((i, n) => new File([blobs[i]], 'frame' + (n + 1) + '.jpg', { type: 'image/jpeg' }));
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute('src'); video.load();
  }
}

async function startVideoScan(file) {
  const target = activeTank();
  pending = { photoUrl: '', species: [], tips: '', loading: true, error: '', note: '', tankId: target ? target.id : '', photos: 0, loadingNote: 'Picking the sharpest frames from your video\u2026' };
  showView('results');
  renderResults();
  let frames = [];
  try { frames = await extractVideoFrames(file, 3); } catch (e) { frames = []; }
  if (!frames.length) {
    pending.loading = false;
    pending.error = 'That video could not be read. Try recording again, or use a photo.';
    renderResults();
    return;
  }
  for (let i = 0; i < frames.length; i++) {
    await startScan(frames[i], i > 0, 'Checking frame ' + (i + 1) + ' of ' + frames.length + '\u2026', true);
  }
}

// A repeat of the same photo (double tap, or going back and rescanning) returns the saved answer instead of paying for another scan.
const scanCache = new Map();
const SCAN_CACHE_MS = 15 * 60 * 1000;
function hashText(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36) + ':' + str.length;
}

async function startScan(file, append, note, force) {
  const target = activeTank();
  const more = !!(append && pending && pending.species && pending.species.length);
  const priorSpecies = more ? pending.species : [];
  const priorPhotos = more ? (pending.photos || 1) : 0;
  const tankId = more && getTank(pending.tankId) ? pending.tankId : (target ? target.id : '');
  const scanTank = getTank(tankId) || target;
  pending = { photoUrl: more ? pending.photoUrl : '', species: [], tips: '', loading: true, error: '', note: '', tankId, photos: priorPhotos, loadingNote: note || '' };
  // Tell the AI what this tank already has, plus anything found in earlier photos of this session.
  const known = [];
  (scanTank ? scanTank.fish.map((f) => f.name) : []).concat(priorSpecies.filter((sp) => sp.kind !== 'plant').map((sp) => sp.name)).forEach((n) => {
    if (n && known.indexOf(n) === -1 && known.length < 40) known.push(n);
  });
  showView('results');
  renderResults();

  let image = null;
  let qualityTip = '';
  try {
    image = await loadImage(file);
    const quality = photoQuality(image);
    qualityTip = quality.tip;
    if (quality.severe && !force) {
      // Too dark or too blurry to read: stop here and let the person retake it, rather than spend a scan.
      pending.error = quality.tip;
      pending.forceFile = file;
      return finishScan(more, priorSpecies, priorPhotos, image);
    }
    const single = makeSingle(image);
    pending.photoUrl = single.previewUrl;
    renderResults();
    const cacheKey = hashText(single.images[0]) + '|' + (scanTank ? scanTank.type : '') + '|' + known.join(',');
    const cached = scanCache.get(cacheKey);
    if (cached && Date.now() - cached.t < SCAN_CACHE_MS) {
      pending.species = JSON.parse(cached.species);
      pending.tips = cached.tips;
      pending.debug = 'Same photo as a moment ago, so no new scan was used.';
      return finishScan(more, priorSpecies, priorPhotos, image);
    }

    const ctx = { known, tank_type: scanTank && TYPES.includes(scanTank.type) ? scanTank.type : '' };
    const data = await askWorker(single.images, 'single', 60000, ctx);
    applyResult(data, 'single');

    const targets = pending.species.filter(needsVerify).sort((a, b) => a.confidence - b.confidence).slice(0, VERIFY_MAX);
    if (targets.length) {
      pending.loadingNote = 'Zooming in on the ones that are hard to tell apart\u2026';
      renderResults();
      try {
        const montages = targets.map((sp) => makeMontage(image, sp.boxes));
        const items = targets.map((sp) => ({ name: sp.name, kind: sp.kind, count: sp.count, alternatives: sp.alternatives }));
        const checked = await askWorker(montages, 'verify', 75000, Object.assign({ items }, ctx));
        applyVerified(targets, checked);
        if (checked.usage) pending.debug += '; zoom-in check on ' + targets.length + ': ' + checked.usage.input + ' in, ' + checked.usage.output + ' out';
      } catch (verifyError) {
        // Keep the first look if the closer look fails.
      }
    }
    if (qualityTip) pending.tips = pending.tips ? pending.tips + ' ' + qualityTip : qualityTip;
    pending.species.forEach((sp) => { if (!sp.thumb && sp.boxes && sp.boxes.length) sp.thumb = fishThumb(image, biggestBox(sp.boxes)); if (sp.boxes && sp.boxes.length && !sp.crop) sp.crop = fishThumb(image, biggestBox(sp.boxes), CROP_SIDE); });
    if (!pending.error && pending.species.length) {
      if (scanCache.size >= 6) scanCache.delete(scanCache.keys().next().value);
      scanCache.set(cacheKey, { t: Date.now(), species: JSON.stringify(pending.species), tips: pending.tips });
    }
  } catch (err) {
    showScanError(err);
  }
  return finishScan(more, priorSpecies, priorPhotos, image);
}

function finishScan(more, priorSpecies, priorPhotos, image) {
  if (image) image.done();
  if (more) {
    if (pending.error) {
      // The new photo failed or showed nothing: keep what the earlier photos found.
      pending.tips = 'The last photo could not be added. ' + pending.error;
      pending.error = '';
      pending.species = priorSpecies;
      pending.photos = priorPhotos;
    } else {
      pending.species = mergeSessions(priorSpecies, pending.species);
      pending.photos = priorPhotos + 1;
    }
  } else {
    pending.photos = pending.error ? 0 : 1;
  }
  pending.loading = false;
  renderResults();
}

function confidenceLabel(c) {
  // The accuracy check showed the model says 85 to 90 percent even when it is wrong about half the time, so only 95 and up is Confident.
  if (c >= 0.95) return ['Confident', 'ok'];
  if (c >= 0.8) return ['Likely', 'warn'];
  return ['Unsure', 'bad'];
}

const LOADING_STEPS = [
  'Reading your photo…',
  'Identifying each species…',
  'Counting what\'s in the tank…',
  'Almost there…'
];
let loadingTimer = null;

function renderResults() {
  if (!pending) return;
  const photo = $('results-photo');
  photo.hidden = !pending.photoUrl;
  if (pending.photoUrl) photo.src = pending.photoUrl;

  const status = $('results-status');
  status.replaceChildren();
  const list = $('results-list');
  list.replaceChildren();
  $('results-note').hidden = true;
  $('results-actions').hidden = true;
  $('add-photo').hidden = true;
  $('results-target').hidden = true;

  if (pending.loading) {
    $('results-title').textContent = 'Looking at your tank…';
    const msg = el('span', { text: pending.loadingNote || LOADING_STEPS[0] });
    status.append(el('div', { class: 'status-card' }, el('div', { class: 'spinner' }), msg));
    for (let i = 0; i < 3; i++) {
      list.append(el('div', { class: 'skeleton' },
        el('div', { class: 'dot' }),
        el('div', { class: 'lines' }, el('div', { class: 'bar' }), el('div', { class: 'bar short' }))));
    }
    clearInterval(loadingTimer);
    let step = 0;
    loadingTimer = setInterval(() => {
      if (!msg.isConnected || !pending || !pending.loading) { clearInterval(loadingTimer); return; }
      if (pending.loadingNote) { msg.textContent = pending.loadingNote; return; }
      step = Math.min(step + 1, LOADING_STEPS.length - 1);
      msg.textContent = LOADING_STEPS[step];
    }, 2800);
    return;
  }

  if (pending.error) {
    $('results-title').textContent = 'No results';
    status.append(el('div', { class: 'status-card bad' }, el('span', { text: pending.error })));
    if (pending.forceFile) {
      const f = pending.forceFile;
      pending.forceFile = null;
      status.append(el('button', { class: 'btn', type: 'button', text: 'Scan anyway', onclick: () => startScan(f, false, '', true) }));
    }
    $('results-actions').hidden = false;
    $('save-scan').hidden = true;
    return;
  }

  const n = pending.species.length;
  $('results-title').textContent = (n === 1 ? 'Found 1 kind' : 'Found ' + n + ' kinds') + (pending.photos > 1 ? ' in ' + pending.photos + ' photos' : '');
  $('add-photo').hidden = false;
  if (pending.debug) status.append(el('p', { class: 'debug', text: pending.debug }));
  if (pending.tips) status.append(el('div', { class: 'status-card tip' }, el('span', { text: 'Tip: ' + pending.tips })));

  if (!getTank(pending.tankId)) pending.tankId = activeTank() ? activeTank().id : '';
  pending.species.forEach((sp, index) => list.append(sp.editing ? editRow(sp, index) : resultRow(sp)));
  $('results-note').hidden = false;
  $('results-actions').hidden = false;
  $('save-scan').hidden = n === 0;

  // With more than one tank, let the person choose where this scan goes.
  if (state.tanks.length > 1) {
    const sel = $('results-tank');
    sel.replaceChildren(...state.tanks.map((x) => el('option', { value: x.id, text: tankLabel(x) })));
    sel.value = pending.tankId;
    $('results-target').hidden = false;
  }
}

$('results-tank').addEventListener('change', () => {
  if (!pending) return;
  pending.tankId = $('results-tank').value;
  renderResults();
});

function inTankHint(sp) {
  const target = getTank(pending && pending.tankId);
  const have = target && target.fish.find((f) => canonKey(f.name) === canonKey(sp.name));
  if (!have) return el('span', { class: 'hint-new', text: 'New to your tank' });
  return el('span', { class: 'hint-have', text: have.count >= sp.count ? 'Already in your tank (' + have.count + ')' : 'Raises your count from ' + have.count });
}

function resultRow(sp) {
  const [label, tone] = confidenceLabel(sp.confidence);
  const alts = (sp.alternatives || []).filter((n) => n && n.toLowerCase() !== sp.name.toLowerCase());
  const altRow = alts.length && sp.confidence < 0.9
    ? el('div', { class: 'alts' },
        el('span', { class: 'sub', text: 'Could also be:' }),
        ...alts.map((n) => el('button', {
          type: 'button', class: 'alt-chip', text: n + ((sp.tankMatches || []).includes(n) ? ' · in your tank' : ''),
          onclick: () => { const hit = lookupSpecies(n); if (canonKey(sp.name) !== canonKey(n)) { sp.ai = sp.ai || sp.name; sp.edited = true; } sp.name = n; sp.scientific = usableScientific(hit); if (hit && KIND_LIST.includes(hit.k)) sp.kind = hit.k; sp.group = hit && hit.g ? hit.g : ''; sp.alternatives = []; sp.confidence = 1; sp.verified = true; renderResults(); }
        })))
    : null;
  const grp = sp.group && DB.groups[sp.group];
  const tellRow = grp && grp.tip && sp.confidence < 0.95
    ? el('details', { class: 'tell' }, el('summary', { text: 'How to tell them apart' }), el('p', { text: grp.tip }))
    : null;
  return el('div', { class: 'item' },
    kindAvatar(sp.kind),
    el('div', { class: 'grow' },
      el('span', { class: 'name', text: sp.name + (sp.count > 1 ? '\u00a0×\u00a0' + sp.count : '') }),
      inTankHint(sp),
      el('div', { class: 'meta' },
        el('span', { class: 'pill ' + tone, text: label }),
        sp.scientific ? el('span', { class: 'sub sci', text: sp.scientific }) : (sp.kind ? el('span', { class: 'sub', text: sp.kind }) : null)
      ),
      altRow,
      tellRow
    ),
    el('button', { type: 'button', class: 'btn small', text: 'Edit', onclick: () => { sp.editing = true; renderResults(); } })
  );
}

function editRow(sp, index) {
  const searchBox = createSearch({
    placeholder: 'Search by name', label: 'Name', value: sp.name,
    type: () => { const t = getTank(pending && pending.tankId); return t ? t.type : 'Freshwater'; },
    onPick: (name) => { searchBox.input.value = name; searchBox.close(); }
  });
  const nameInput = searchBox.input;
  const countInput = el('input', { type: 'number', value: sp.count, min: 1, max: 999, 'aria-label': 'How many', style: 'max-width: 90px' });
  return el('div', { class: 'item edit-row' },
    searchBox.root,
    countInput,
    el('button', {
      type: 'button', class: 'btn small primary', text: 'Done',
      onclick: () => {
        const name = nameInput.value.trim();
        const count = Math.round(Number(countInput.value));
        if (name) { const was = sp.name; const hit = lookupSpecies(name); sp.name = hit ? hit.n : name.slice(0, 60); if (canonKey(was) !== canonKey(sp.name)) { sp.ai = sp.ai || was; sp.edited = true; } sp.group = hit && hit.g ? hit.g : ''; if (hit && KIND_LIST.includes(hit.k)) sp.kind = hit.k; }
        if (count >= 1 && count <= 999) sp.count = count;
        sp.confidence = 1; // the user checked it
        sp.editing = false;
        renderResults();
      }
    }),
    el('button', {
      type: 'button', class: 'btn small', text: 'Remove',
      onclick: () => { pending.species.splice(index, 1); renderResults(); }
    })
  );
}

$('save-scan').addEventListener('click', () => {
  if (!pending) return;
  const target = getTank(pending.tankId) || ensureTank();
  const out = { new: 0, raised: 0, same: 0 };
  const before = new Set(target.fish.filter((f) => f.photo).map((f) => f));
  const shared = pending.species.filter((sp) => sp.crop && sp.kind !== 'other' && (sp.edited || (Number(sp.confidence) || 0) >= 0.7))
    .map((sp) => ({ name: sp.name, sci: sp.scientific || '', kind: sp.kind, src: sp.edited ? 'user' : 'ai', ai: sp.ai || '', conf: sp.edited ? 1 : sp.confidence, water: target.type, image: sp.crop }));
  pending.species.forEach((sp) => { const r = addToTank(target, sp.name, sp.count, 'scan', sp.kind, sp.thumb || ''); if (r) out[r] += 1; });
  if (!saveState()) { target.fish.forEach((f) => { if (f.photo && !before.has(f)) delete f.photo; }); saveState(); }
  pending = null;
  showTank(target.id);
  const bits = [];
  if (out.new) bits.push(out.new + ' new');
  if (out.raised) bits.push(out.raised + ' count' + (out.raised === 1 ? '' : 's') + ' raised');
  if (out.same) bits.push(out.same + ' already in the tank');
  if (bits.length) toast('Saved: ' + bits.join(', ') + '.');
  shareCrops(shared);
});

// ---------- Care data, tank mate check and stocking ----------
const TEMPER = { p: 'Peaceful', s: 'Semi-aggressive', a: 'Aggressive' };
const DIET = { o: 'Eats most things', c: 'Meat eater', h: 'Plant and algae eater', p: 'Filter feeder' };
const ZONE_FISH = { t: 'Top of the tank', m: 'Middle of the tank', b: 'Bottom of the tank', a: 'All levels' };
const ZONE_PLANT = { f: 'Foreground', m: 'Midground', k: 'Background', x: 'Floating', a: 'Tied to wood or rock' };
const LEVEL = { e: 'Beginner friendly', m: 'Some experience', h: 'Experienced keepers' };

function hasTag(e, tag) { return !!(e && e.c && e.c.x && e.c.x.indexOf(tag) !== -1); }
function careOf(name) { const e = lookupSpecies(name); return e && e.c ? e : null; }
function isMobile(e) { return e.k === 'fish' || e.k === 'shrimp' || e.k === 'snail' || (e.k === 'invert' && !hasTag(e, 'sting')); }
function sharesWater(a, b) { return [...a.w].some((c) => b.w.indexOf(c) !== -1); }
function rangeGap(r1, r2) { return Math.max(0, Math.max(r1[0], r2[0]) - Math.min(r1[1], r2[1])); }
function tankGallons(t) {
  const n = parseFloat(t && t.size);
  if (!(n > 0)) return 0;
  return t.unit === 'liters' ? n / 3.785 : n;
}

// One animal's effect on another (only the direction given).
function directional(x, y) {
  const out = [];
  const xs = x.c.z, ys = y.c.z;
  if (hasTag(x, 'pred') && y.k === 'fish' && ys <= xs / 2) out.push({ level: 'bad', text: x.n + ' will likely eat ' + y.n });
  else if (hasTag(x, 'opp') && y.k === 'fish' && ys <= xs / 3.2) out.push({ level: 'warn', text: x.n + ' may eat ' + y.n + ' once it is grown' });
  if (hasTag(x, 'shrimp') && y.k === 'shrimp') out.push({ level: 'bad', text: x.n + ' hunts shrimp, so ' + y.n + ' will not last' });
  if (hasTag(x, 'snail') && y.k === 'snail') out.push({ level: 'warn', text: x.n + ' eats snails such as ' + y.n });
  if (hasTag(x, 'nip') && y.k === 'fish' && hasTag(y, 'longfin')) out.push({ level: 'warn', text: x.n + ' may nip the fins of ' + y.n });
  if (x.k === 'fish' && y.k === 'fish' && x.c.m === 'a' && y.c.m === 'p' && ys <= xs * 1.5 && !hasTag(x, 'pred')) out.push({ level: 'warn', text: x.n + ' is aggressive and may bully ' + y.n });
  const prey = y.k === 'coral' || y.k === 'invert' || y.k === 'shrimp' || y.k === 'snail';
  if (hasTag(x, 'reefunsafe') && prey) out.push({ level: 'bad', text: x.n + ' eats or damages ' + y.n });
  else if (hasTag(x, 'reefrisk') && prey) out.push({ level: 'warn', text: x.n + ' may nibble on ' + y.n });
  if (hasTag(x, 'sting') && y.k === 'coral') out.push({ level: 'warn', text: x.n + ' can sting ' + y.n + ' if they touch, so leave space between them' });
  if (hasTag(x, 'eatsplants') && y.k === 'plant' && y.c.y !== 'a') out.push({ level: 'warn', text: x.n + ' may eat ' + y.n });
  return out;
}

function pairIssues(a, b) {
  if (!a || !b || a === b || !a.c || !b.c) return [];
  if (a.k === 'plant' && b.k === 'plant') return [];
  const out = [];
  if (!sharesWater(a, b)) {
    out.push({ level: 'bad', text: a.n + ' and ' + b.n + ' need different water (freshwater vs saltwater)' });
    return out;
  }
  if (a.k !== 'plant' && b.k !== 'plant') {
    const tg = rangeGap(a.c.t, b.c.t);
    const range = (e) => Math.round(e.c.t[0]) + '-' + Math.round(e.c.t[1]) + '°F';
    if (tg > 6) out.push({ level: 'bad', text: a.n + ' (' + range(a) + ') and ' + b.n + ' (' + range(b) + ') want very different temperatures' });
    else if (tg >= 3) out.push({ level: 'warn', text: a.n + ' (' + range(a) + ') and ' + b.n + ' (' + range(b) + ') like different temperatures' });
    const pg = rangeGap(a.c.p, b.c.p);
    if (pg > 1.0) out.push({ level: 'bad', text: a.n + ' and ' + b.n + ' want very different water (pH ' + a.c.p[0] + '-' + a.c.p[1] + ' vs ' + b.c.p[0] + '-' + b.c.p[1] + ')' });
    else if (pg > 0.5) out.push({ level: 'warn', text: a.n + ' and ' + b.n + ' prefer different pH (' + a.c.p[0] + '-' + a.c.p[1] + ' vs ' + b.c.p[0] + '-' + b.c.p[1] + ')' });
  }
  out.push(...directional(a, b), ...directional(b, a));
  if (a.g && a.g === b.g && hasTag(a, 'terr') && hasTag(b, 'terr') && a.g !== 'cichmal' && a.g !== 'tanganyika') {
    out.push({ level: 'warn', text: a.n + ' and ' + b.n + ' are territorial relatives and may fight' });
  }
  return out;
}

// Things about one species in this tank: tank size and group size.
function singleIssues(e, count, gal) {
  const out = [];
  if (e.k === 'plant' || !e.c) return out;
  if (gal && e.c.g > gal) out.push({ level: 'bad', text: e.n + ' needs a tank of at least ' + e.c.g + ' gallons' });
  // Only flag a group that is clearly too small: 2 of a recommended 3 or 4 of 5 is fine, a lone fish or 2 of 5 is not.
  if (e.c.s >= 3 && count < Math.max(2, Math.ceil(e.c.s * 0.6)) && (e.k === 'fish' || e.k === 'shrimp')) out.push({ level: 'warn', text: e.n + ' do best in groups of ' + e.c.s + ' or more (you have ' + count + ')' });
  if (count > 1 && e.k === 'fish' && hasTag(e, 'terr') && e.c.s <= 1 && e.g !== 'cfish' && gal && gal < e.c.g * count * 2) {
    out.push({ level: 'warn', text: 'Several ' + e.n + ' may fight in a tank this size' });
  }
  return out;
}

function tankCheck(t) {
  const gal = tankGallons(t);
  const items = t.fish.map((f) => ({ f, e: careOf(f.name) })).filter((x) => x.e);
  const issues = [];
  const seen = new Set();
  const push = (names, list) => list.forEach((i) => {
    if (seen.has(i.text)) return;
    seen.add(i.text);
    issues.push({ level: i.level, text: i.text, names });
  });
  items.forEach((it) => push([it.e.n], singleIssues(it.e, it.f.count, gal)));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) push([items[i].e.n, items[j].e.n], pairIssues(items[i].e, items[j].e));
  }
  issues.sort((p, q) => (p.level === q.level ? 0 : p.level === 'bad' ? -1 : 1));
  return { issues, checked: items.length, unknown: t.fish.length - items.length };
}

function stocking(t) {
  const gal = tankGallons(t);
  let load = 0, skipped = 0, known = 0, need = 0, needName = '', needOwn = 0;
  t.fish.forEach((f) => {
    const e = careOf(f.name);
    if (!e) { skipped++; return; }
    known++;
    let mine = 0;
    if (e.k === 'fish') mine = f.count * e.c.z * (hasTag(e, 'heavy') ? 2 : 1);
    else if (isMobile(e)) mine = f.count * e.c.z * 0.25;
    load += mine;
    if (e.k !== 'plant' && e.c.g > 0 && e.c.g / (gal || 1) > need / (gal || 1)) { need = e.c.g; needName = e.n; needOwn = mine; }
  });
  const factor = t.type === 'Saltwater' ? 0.4 : t.type === 'Brackish' ? 0.7 : 1;
  const cap = gal * factor;
  // The fish that needs the biggest tank takes at least its minimum tank's share; everything else adds on top.
  const byInches = cap ? load / cap : 0;
  // Once a tank meets a fish's minimum it is workable, not full, so the minimum counts for three quarters of its share.
  const needShare = gal && need ? (need > gal ? need / gal : (need / gal) * 0.75) : 0;
  const pct = cap ? (load - needOwn) / cap + Math.max(needOwn / cap, needShare) : 0;
  const tooSmall = gal && need > gal ? { name: needName, gal: need, big: true } : (need / gal >= 0.6 ? { name: needName, gal: need, big: false } : null);
  return { gal, load, cap, pct: Math.max(pct, byInches), skipped, known, tooSmall };
}
function stockLevel(pct) {
  if (pct <= 0.55) return { label: 'Room to grow', tone: 'low', hint: 'Plenty of room to add more.' };
  if (pct <= 0.85) return { label: 'Comfortable', tone: 'ok', hint: 'A comfortable load for this size tank.' };
  if (pct <= 1.0) return { label: 'Getting full', tone: 'full', hint: 'Getting full. Add new fish slowly.' };
  if (pct <= 1.25) return { label: 'Fully stocked', tone: 'high', hint: 'Fully stocked. Good filtration and regular water changes matter.' };
  return { label: 'Overstocked', tone: 'over', hint: 'Too many fish for this tank over time.' };
}

// A slim bar with a mark where the tank is full.
function stockBar(t) {
  const s = stocking(t);
  const box = el('div', { class: 'stock' });
  if (!s.gal) { box.append(el('p', { class: 'muted small', text: 'Add your tank size on the tank page to see how full it is.' })); return box; }
  if (!s.known) { box.append(el('p', { class: 'muted small', text: 'Add fish to see how full this tank is.' })); return box; }
  const lvl = stockLevel(s.pct);
  const fill = Math.max(2, Math.min(s.pct, 1) * 100);
  const over = s.pct > 1 ? Math.round((s.pct - 1) * 100) : 0;
  box.append(
    el('div', { class: 'stock-top' },
      el('strong', { text: lvl.label }),
      el('span', { class: 'stock-pct', text: over ? over + '% over capacity' : Math.round(s.pct * 100) + '% of capacity' })),
    el('div', { class: 'stock-track', role: 'img', 'aria-label': lvl.label + ', ' + Math.round(s.pct * 100) + ' percent of capacity' },
      el('div', { class: 'stock-fill ' + lvl.tone, style: 'width:' + fill.toFixed(1) + '%' }),
      el('div', { class: 'stock-mark' })),
    el('div', { class: 'stock-scale' }, el('span', { text: 'Empty' }), el('span', { class: 'stock-full', text: 'Full' })),
    el('p', { class: 'muted small', text: (s.tooSmall ? s.tooSmall.name + ' needs at least ' + s.tooSmall.gal + ' gallons' + (s.tooSmall.big ? ', which is more than this tank holds.' : ', so it takes up much of this tank.') : lvl.hint) + ' An estimate from adult sizes.' + (s.skipped ? ' ' + s.skipped + ' not counted (no size data).' : '') })
  );
  return box;
}

let mateShowAll = false;
const groupOpen = {};
let mateOpen = false; // the Compatibility pill stays collapsed until tapped
function iconSvg(paths, size) {
  return svgEl('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2.2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, ...paths.map((d) => svgEl('path', { d })));
}
// Two small cards side by side: how full the tank is, and whether the fish get along.
// A slim full-width Stocking card, with a Compatibility pill under it that opens to show any issues.
function summaryStrip(t) {
  const s = stocking(t);
  const stock = el('div', { class: 'stock-slim' });
  if (!s.gal) stock.append(el('div', { class: 'stock-slim-top' }, el('span', { class: 'sum-k', text: 'Stocking' }), el('span', { class: 'stock-slim-note', text: 'Add the tank size to see how full it is.' })));
  else if (!s.known) stock.append(el('div', { class: 'stock-slim-top' }, el('span', { class: 'sum-k', text: 'Stocking' }), el('span', { class: 'stock-slim-note', text: 'Add fish to see how full it is.' })));
  else {
    const lvl = stockLevel(s.pct);
    stock.append(
      el('div', { class: 'stock-slim-top' }, el('span', { class: 'sum-k', text: 'Stocking' }),
        el('span', { class: 'stock-slim-val' }, el('strong', { text: Math.round(s.pct * 100) + '%' }), ' ' + (s.tooSmall ? s.tooSmall.name + ' needs ' + s.tooSmall.gal + ' gal or more' : lvl.label))),
      el('div', { class: 'stock-track sum-track', role: 'img', 'aria-label': lvl.label + ', ' + Math.round(s.pct * 100) + ' percent of capacity' },
        el('div', { class: 'stock-fill ' + lvl.tone, style: 'width:' + Math.max(2, Math.min(s.pct, 1) * 100).toFixed(1) + '%' })));
  }
  const allIssues = tankCheck(t).issues;
  const issues = allIssues.filter((i) => t.dismissed.indexOf(i.text) === -1);
  const cleared = allIssues.length - issues.length;
  const bad = issues.some((i) => i.level === 'bad');
  const canOpen = issues.length > 0 || cleared > 0;
  const open = canOpen && mateOpen === true;
  let tone = 'ok', head = cleared ? 'Cleared' : 'All clear';
  if (!t.fish.length) { tone = 'none'; head = 'Add fish'; }
  else if (issues.length) { tone = bad ? 'bad' : 'warn'; head = issues.length + ' to look at'; }
  const inner = [
    el('span', { class: 'sum-badge ' + tone, 'aria-hidden': 'true' }, tone === 'ok' ? iconSvg(['M5 12.5l4.5 4.5L19 7.5'], 18) : tone === 'none' ? iconSvg(['M12 5v14', 'M5 12h14'], 18) : iconSvg(['M12 8v5', 'M12 17h.01'], 18)),
    el('span', { class: 'compat-label', text: 'Compatibility' }),
    el('span', { class: 'compat-status ' + tone, text: head }),
    canOpen ? chevron() : null
  ];
  const pill = canOpen
    ? el('button', { type: 'button', class: 'compat-pill', 'aria-expanded': String(open), onclick: () => { mateOpen = !open; renderTank(); } }, ...inner)
    : el('div', { class: 'compat-pill static' }, ...inner);
  return { row: el('div', { class: 'sum-stack' }, stock, el('div', { class: 'compat-wrap' + (open ? ' open' : '') }, pill, open ? mateCheckCard(t) : null)), showMates: false };
}
function mateCheckCard(t) {
  const all = tankCheck(t).issues;
  const r = { issues: all.filter((i) => t.dismissed.indexOf(i.text) === -1), checked: tankCheck(t).checked, unknown: tankCheck(t).unknown };
  const cleared = all.length - r.issues.length;
  const bad = r.issues.some((i) => i.level === 'bad');
  const chip = !r.issues.length
    ? el('span', { class: 'pill ok', text: cleared ? 'Cleared' : 'All clear' })
    : el('span', { class: 'pill ' + (bad ? 'bad' : 'warn'), text: r.issues.length + (r.issues.length === 1 ? ' thing to look at' : ' things to look at') });
  const shown = mateShowAll ? r.issues : r.issues.slice(0, 5);
  const card = el('div', { class: 'compat-body' });
  if (!t.fish.length) card.append(el('p', { class: 'muted small', text: 'Add fish and I will check how they get along.' }));
  else if (!r.issues.length) card.append(el('p', { class: 'muted small', text: cleared ? 'You cleared everything I flagged.' : (r.checked ? 'No problems found between the ' + r.checked + ' kinds I could check.' : 'None of these names are in the species list yet, so nothing could be checked.') }));
  shown.forEach((i) => card.append(
    el('div', { class: 'issue-row' },
      el('button', { type: 'button', class: 'issue ' + i.level, onclick: () => showSpecies(i.names[0], t.id) },
        el('span', { class: 'dot', 'aria-hidden': 'true' }),
        el('span', { class: 'issue-text', text: i.text })),
      el('button', { type: 'button', class: 'issue-x', 'aria-label': 'Clear this suggestion', title: 'Clear', text: '\u00d7', onclick: () => { t.dismissed.push(i.text); t.dismissed = t.dismissed.slice(-60); saveState(); renderTank(); } }))
  ));
  if (r.issues.length > 5) card.append(el('button', { type: 'button', class: 'btn small', text: mateShowAll ? 'Show fewer' : 'Show all ' + r.issues.length, onclick: () => { mateShowAll = !mateShowAll; renderTank(); } }));
  if (r.issues.length > 1) card.append(el('button', { type: 'button', class: 'btn link', text: 'Clear all', onclick: () => { r.issues.forEach((i) => t.dismissed.push(i.text)); t.dismissed = t.dismissed.slice(-60); saveState(); renderTank(); } }));
  if (cleared) card.append(el('button', { type: 'button', class: 'btn link', text: 'Bring back ' + cleared + ' cleared', onclick: () => { t.dismissed = []; saveState(); renderTank(); } }));
  if (r.issues.length || r.unknown) {
    card.append(el('p', { class: 'muted small', text: 'General guidance, and every fish is different.' + (r.unknown ? ' ' + r.unknown + ' not in the species list, so not checked.' : '') }));
  }
  return card;
}

// ---------- Species page ----------
let speciesView = null;      // { name, tankId }
let speciesStack = [];
let speciesOrigin = 'tank';
let speciesOriginTank = '';

function showSpecies(name, tankId, fromChip) {
  if (fromChip && speciesView) speciesStack.push(speciesView);
  else { speciesStack = []; speciesOrigin = currentView === 'home' ? 'home' : currentView === 'dream' ? 'dream' : currentView === 'fishcheck' ? 'fishcheck' : 'tank'; speciesOriginTank = tankId || openTankId || ''; }
  speciesView = { name, tankId: tankId || '' };
  showView('species');
}
$('species-back').addEventListener('click', () => goBack(() => {
  if (speciesStack.length) { speciesView = speciesStack.pop(); showView('species'); return; }
  if (speciesOrigin === 'home') showView('home');
  else if (speciesOrigin === 'dream') showView('dream');
  else if (speciesOrigin === 'fishcheck') showView('fishcheck');
  else if (getTank(speciesOriginTank)) showTank(speciesOriginTank);
  else showView('home');
}));

// Stock photos come from Wikipedia by name, with a link back to the page for credit.
let stockSaved = {};
try { stockSaved = JSON.parse(localStorage.getItem('schooled.stock') || '{}') || {}; } catch (err) { stockSaved = {}; }
function saveStock(key, value) {
  if (Object.keys(stockSaved).length > 150) stockSaved = {};
  stockSaved[key] = value;
  try { localStorage.setItem('schooled.stock', JSON.stringify(stockSaved)); } catch (err) { /* cache is optional */ }
}
// Cached Wikipedia picture: the photo if we have one, 0 if every title is known to have none, undefined if unknown.
function stockCached(entry, name) {
  const titles = [usableScientific(entry), entry ? entry.n : name].filter(Boolean);
  let unknown = false;
  for (const title of titles) {
    const v = stockSaved[normKey(title)];
    if (v) return v;
    if (v === undefined) unknown = true;
  }
  if (unknown) return undefined;
  const x = stockSaved[stockExtraKey(entry, name)]; // the Wikidata / iNaturalist fallback
  return x === undefined ? undefined : (x || 0);
}
// "Genus species" without variety names in quotes, for photo lookups.
function stockSci(entry) {
  const sci = String(usableScientific(entry) || '').replace(/\s*['"‘’(].*$/, '').trim();
  return /^[A-Z][a-z]+ [a-z]+$/.test(sci) ? sci : '';
}
function stockExtraKey(entry, name) { return 'x:' + normKey(stockSci(entry) || (entry ? entry.n : name)); }
// Free photo licenses that allow use in a paid app (with credit).
const STOCK_LICENSES = ['cc0', 'cc-by', 'cc-by-sa'];
async function fetchStockExtra(entry, name) {
  const key = stockExtraKey(entry, name);
  if (stockSaved[key] !== undefined) return stockSaved[key] || null;
  const sci = stockSci(entry);
  let reached = false;
  // 1. Wikidata: the species' main picture on Wikimedia Commons.
  if (sci) {
    try {
      const r1 = await fetch('https://www.wikidata.org/w/api.php?action=query&list=search&srlimit=1&format=json&origin=*&srsearch=' + encodeURIComponent('haswbstatement:"P225=' + sci + '"'), { signal: AbortSignal.timeout(8000) });
      const j1 = r1.ok ? await r1.json() : null;
      reached = reached || r1.ok;
      const id = j1 && j1.query && j1.query.search && j1.query.search[0] && j1.query.search[0].title;
      if (id && /^Q\d+$/.test(id)) {
        const r2 = await fetch('https://www.wikidata.org/w/api.php?action=wbgetclaims&property=P18&format=json&origin=*&entity=' + id, { signal: AbortSignal.timeout(8000) });
        const j2 = r2.ok ? await r2.json() : null;
        const file = j2 && j2.claims && j2.claims.P18 && j2.claims.P18[0] && j2.claims.P18[0].mainsnak && j2.claims.P18[0].mainsnak.datavalue && j2.claims.P18[0].mainsnak.datavalue.value;
        if (typeof file === 'string' && /\.(jpe?g|png|webp)$/i.test(file)) {
          const f = file.replace(/ /g, '_');
          const found = { src: 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(f) + '?width=400', page: 'https://commons.wikimedia.org/wiki/File:' + encodeURIComponent(f), from: 'Wikimedia Commons' };
          saveStock(key, found);
          return found;
        }
      }
    } catch (err) { /* try the next source */ }
  }
  // 2. iNaturalist: the taxon's default photo, only when its license allows commercial use.
  try {
    const q = sci || (entry ? entry.n : name);
    const r3 = await fetch('https://api.inaturalist.org/v1/taxa?per_page=5&q=' + encodeURIComponent(q), { signal: AbortSignal.timeout(8000) });
    const j3 = r3.ok ? await r3.json() : null;
    reached = reached || r3.ok;
    const list = (j3 && Array.isArray(j3.results)) ? j3.results : [];
    const hit = list.find((x) => x && x.default_photo && (!sci || String(x.name || '').toLowerCase() === sci.toLowerCase()));
    const ph = hit && hit.default_photo;
    if (ph && STOCK_LICENSES.includes(String(ph.license_code || '').toLowerCase()) && /^https:\/\//.test(ph.medium_url || '')) {
      const found = { src: ph.medium_url, page: 'https://www.inaturalist.org/taxa/' + hit.id, from: 'iNaturalist', credit: String(ph.attribution || '').slice(0, 160) };
      saveStock(key, found);
      return found;
    }
  } catch (err) { /* offline */ }
  if (reached) saveStock(key, 0); // only remember "no photo" when the services actually answered
  return null;
}
async function fetchStock(entry, name) {
  const titles = [usableScientific(entry), entry ? entry.n : name].filter(Boolean);
  for (const title of titles) {
    const key = normKey(title);
    if (stockSaved[key] !== undefined) { if (stockSaved[key]) return stockSaved[key]; continue; }
    try {
      const res = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title.replace(/ /g, '_')), { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const j = await res.json();
        if (j && j.type === 'standard' && j.thumbnail && /^https:\/\//.test(j.thumbnail.source || '')) {
          const found = { src: j.thumbnail.source, page: (j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page) || '' };
          saveStock(key, found);
          return found;
        }
        saveStock(key, 0);
      } else if (res.status === 404) saveStock(key, 0);
    } catch (err) { /* offline: try again next time */ }
  }
  // No Wikipedia article or picture: try free photos from Wikidata and iNaturalist.
  if (titles.every((tt) => stockSaved[normKey(tt)] === 0)) return fetchStockExtra(entry, name);
  return null;
}

function rosterRow(t, name) {
  return t ? t.fish.find((f) => canonKey(f.name) === canonKey(name)) : null;
}

function factRow(label, value) {
  return el('div', { class: 'fact' }, el('span', { class: 'fact-label', text: label }), el('span', { class: 'fact-value', text: value }));
}
function speciesFacts(e) {
  const c = e.c;
  const temp = Math.round(c.t[0]) + '-' + Math.round(c.t[1]) + '°F';
  const ph = c.p[0] + '-' + c.p[1];
  if (e.k === 'plant') {
    const light = hasTag(e, 'highlight') ? 'Bright light' : hasTag(e, 'lowlight') ? 'Low light' : 'Medium light';
    return [['Height', 'Up to ' + c.z + ' in'], ['Placement', ZONE_PLANT[c.y] || 'Anywhere'], ['Light', light], ['CO2', hasTag(e, 'co2') ? 'Helps a lot' : 'Not needed'], ['Growth', hasTag(e, 'fast') ? 'Fast' : 'Slow to medium'], ['Temperature', temp], ['pH', ph], ['Care level', LEVEL[c.l]]];
  }
  if (e.k === 'coral') {
    return [['Size', 'Up to ' + c.z + ' in'], ['Smallest tank', c.g + ' gal'], ['Temperature', temp], ['pH', ph], ['Stings neighbors', hasTag(e, 'sting') ? 'Yes, leave space' : 'Not much'], ['Care level', LEVEL[c.l]]];
  }
  const rows = [['Adult size', c.z + ' in'], ['Smallest tank', c.g + ' gal'], ['Temperature', temp], ['pH', ph]];
  if (TEMPER[c.m]) rows.push(['Temperament', TEMPER[c.m]]);
  if (c.f) rows.push(['Eats', c.f]);
  else if (DIET[c.d]) rows.push(['Diet', DIET[c.d]]);
  if (ZONE_FISH[c.y]) rows.push(['Lives in', ZONE_FISH[c.y]]);
  if (e.k === 'fish' || e.k === 'shrimp') rows.push(['Group size', c.s > 1 ? c.s + ' or more' : 'Fine on its own']);
  rows.push(['Care level', LEVEL[c.l]]);
  return rows;
}

function issueList(list) {
  return el('div', { class: 'issues' }, ...list.map((i) => el('div', { class: 'issue static ' + i.level }, el('span', { class: 'dot', 'aria-hidden': 'true' }), el('span', { class: 'issue-text', text: i.text }))));
}

function speciesPhotoBox(entry, name, f, t) {
  const box = el('div', { class: 'photo-box species-photo' });
  const credit = el('p', { class: 'muted small photo-credit' });
  const wrap = el('div', { class: 'species-photo-wrap' }, box, credit);
  const icon = () => el('div', { class: 'tank-hero-empty' }, kindIcon(entry && entry.k ? entry.k : 'fish'), el('span', { text: 'No photo yet' }));
  if (f && f.photo) {
    box.append(el('img', { src: f.photo, alt: 'Your ' + name }));
    credit.textContent = 'Your photo';
  } else {
    box.append(icon());
    const shownFor = speciesView && speciesView.name;
    fetchStock(entry, name).then((found) => {
      if (!found || !speciesView || speciesView.name !== shownFor || (f && f.photo)) return;
      box.replaceChildren(el('img', { src: found.src, alt: name, loading: 'lazy' }));
      credit.replaceChildren(document.createTextNode('Photo from ' + (found.from || 'Wikipedia') + (found.credit ? ' (' + found.credit + ')' : '') + '. It may be a different color form. '),
        found.page ? el('a', { href: found.page, target: '_blank', rel: 'noopener noreferrer', text: 'Credits' }) : '');
    });
  }
  return wrap;
}

function renderSpecies() {
  const body = $('species-body');
  body.replaceChildren();
  if (!speciesView) { showView('home'); return; }
  const t = getTank(speciesView.tankId) || activeTank();
  const entry = lookupSpecies(speciesView.name);
  const name = entry ? entry.n : speciesView.name;
  const f = rosterRow(t, name);
  const gal = tankGallons(t);

  // Photo and photo buttons
  body.append(speciesPhotoBox(entry, name, f, t));
  if (f) {
    const wire = (input) => input.addEventListener('change', async (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (!file) return;
      try {
        f.photo = await photoFromFile(file, SPECIES_PHOTO_SIDE);
        if (!saveState()) { f.photo = ''; return; }
        renderSpecies();
      } catch (err) { toast("This device couldn't open that photo. Try another one."); }
    });
    const cam = el('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
    const gal2 = el('input', { type: 'file', accept: 'image/*,.heic,.heif,.avif,.webp,.bmp,.gif,.tif,.tiff', hidden: true });
    wire(cam); wire(gal2);
    body.append(el('div', { class: 'row photo-actions' },
      el('button', { type: 'button', class: 'btn small', text: f.photo ? 'Retake' : 'Take photo', onclick: () => cam.click() }),
      el('button', { type: 'button', class: 'btn small', text: f.photo ? 'Change' : 'Choose photo', onclick: () => gal2.click() }),
      f.photo ? el('button', { type: 'button', class: 'btn small', text: 'Use stock photo', onclick: () => { f.photo = ''; saveState(); renderSpecies(); } }) : null),
      cam, gal2);
  }

  // Name and tags
  body.append(
    el('h1', { class: 'species-title', text: name }),
    entry && usableScientific(entry) ? el('p', { class: 'muted sci', text: entry.s }) : null);
  if (entry && entry.c) {
    body.append(el('div', { class: 'chips' },
      el('span', { class: 'pill', text: entry.k === 'plant' ? 'Plant' : entry.k === 'coral' ? 'Coral' : entry.k === 'shrimp' ? 'Shrimp' : entry.k === 'snail' ? 'Snail' : entry.k === 'invert' ? 'Invertebrate' : 'Fish' }),
      el('span', { class: 'pill ' + (entry.c.l === 'e' ? 'ok' : entry.c.l === 'h' ? 'warn' : ''), text: LEVEL[entry.c.l] }),
      TEMPER[entry.c.m] ? el('span', { class: 'pill ' + (entry.c.m === 'p' ? 'ok' : entry.c.m === 'a' ? 'bad' : 'warn'), text: TEMPER[entry.c.m] }) : null));
  }

  // In your tank
  const inTank = el('div', { class: 'card' });
  if (t && f) {
    inTank.append(
      el('div', { class: 'card-head' }, el('h2', { text: 'In ' + tankLabel(t) }),
        el('div', { class: 'stepper' },
          el('button', { type: 'button', class: 'round', 'aria-label': 'One fewer ' + name, text: '−', onclick: () => changeCount(t, f, -1) }),
          el('span', { class: 'count', text: String(f.count) }),
          el('button', { type: 'button', class: 'round', 'aria-label': 'One more ' + name, text: '+', onclick: () => changeCount(t, f, 1) }))));
  } else if (t) {
    inTank.append(
      el('div', { class: 'card-head' }, el('h2', { text: 'Not in ' + tankLabel(t) }),
        el('button', { type: 'button', class: 'btn small primary', text: 'Add to tank', onclick: () => { addToTank(t, name, 1, 'add', entry ? entry.k : undefined); saveState(); renderSpecies(); } })));
  }
  if (inTank.childNodes.length) body.append(inTank);

  if (!entry || !entry.c) {
    body.append(el('div', { class: 'card' }, el('p', { class: 'muted', text: 'This name is not in the species list yet, so there are no care details. You can still keep it in your tank and add your own photo.' })));
    return;
  }

  // Fit with this tank
  if (t) {
    let mine = [];
    if (f) {
      mine = tankCheck(t).issues.filter((i) => i.names.indexOf(entry.n) !== -1);
    } else {
      mine = singleIssues(entry, 1, gal);
      t.fish.forEach((o) => { const oe = careOf(o.name); if (oe) mine.push(...pairIssues(entry, oe)); });
      mine.sort((p, q) => (p.level === q.level ? 0 : p.level === 'bad' ? -1 : 1));
    }
    const fit = el('div', { class: 'card' }, el('h2', { text: f ? 'How it fits your tank' : 'If you add it to your tank' }));
    if (!mine.length) fit.append(el('p', { class: 'muted small', text: t.fish.length ? 'No problems found with what you keep now.' : 'Nothing to compare with yet.' }));
    else fit.append(issueList(mine));
    body.append(fit);
  }

  // Facts
  body.append(el('div', { class: 'card' }, el('h2', { text: 'Quick facts' }),
    el('div', { class: 'facts' }, ...speciesFacts(entry).map((r) => factRow(r[0], r[1])))));

  // About and look-alike tip
  const about = el('div', { class: 'card' }, el('h2', { text: 'Habitat and care' }), el('p', { text: entry.c.n }));
  const grp = entry.g && DB.groups[entry.g];
  if (grp && grp.tip && entry.k !== 'plant') about.append(el('details', { class: 'tell' }, el('summary', { text: 'How to tell it from lookalikes' }), el('p', { text: grp.tip })));
  body.append(about);

  // Mates
  if (entry.k !== 'plant') {
    const type = t && TYPES.includes(t.type) ? t.type : 'Freshwater';
    const codes = type === 'Saltwater' ? ['s'] : type === 'Brackish' ? ['b', 'f'] : ['f'];
    const wantKinds = entry.k === 'coral' ? ['fish', 'coral', 'invert', 'shrimp', 'snail'] : ['fish', 'shrimp', 'snail', 'invert'];
    const good = [], avoid = [];
    DB.list.forEach((c) => {
      if (c === entry || !c.c || wantKinds.indexOf(c.k) === -1 || !codes.some((x) => c.w.indexOf(x) !== -1)) return;
      const issues = pairIssues(entry, c);
      if (!issues.length) { if (!gal || c.c.g <= gal) good.push(c); }
      else if (issues.some((i) => i.level === 'bad')) avoid.push({ c, text: issues.find((i) => i.level === 'bad').text });
    });
    const score = (c) => (c.c.m === 'p' ? 0 : 6) + Math.abs(c.c.z - entry.c.z) * 0.6 + (c.c.y === entry.c.y ? 2 : 0) + (c.c.l === 'h' ? 3 : 0);
    good.sort((p, q) => score(p) - score(q));
    const goodCard = el('div', { class: 'card' }, el('h2', { text: 'Good tank mates' }));
    if (good.length) {
      goodCard.append(el('div', { class: 'alts mates' }, ...good.slice(0, 14).map((c) => el('button', { type: 'button', class: 'alt-chip', text: c.n + (rosterRow(t, c.n) ? ' · in your tank' : ''), onclick: () => showSpecies(c.n, t && t.id, true) }))));
      goodCard.append(el('p', { class: 'muted small', text: 'Showing the best matches for ' + type.toLowerCase() + ' tanks. Check size and temperament before buying.' }));
    } else goodCard.append(el('p', { class: 'muted small', text: 'No clear matches in the list for this tank type.' }));
    body.append(goodCard);
    if (avoid.length) {
      avoid.sort((p, q) => (p.c.c.l === q.c.c.l ? p.c.n.localeCompare(q.c.n) : p.c.c.l < q.c.c.l ? -1 : 1));
      const shrimpHits = avoid.filter((a) => a.c.k === 'shrimp');
      if (shrimpHits.length > 1) {
        const first = avoid.indexOf(shrimpHits[0]);
        avoid.splice(0, avoid.length, ...avoid.filter((a) => a.c.k !== 'shrimp'));
        avoid.splice(Math.min(first, avoid.length), 0, { c: shrimpHits[0].c, text: shrimpHits[0].text.replace(/so .* will not last/, 'so shrimp will not last') });
      }
      body.append(el('div', { class: 'card' }, el('h2', { text: 'Better to avoid' }),
        el('div', { class: 'issues' }, ...avoid.slice(0, 6).map((a) => el('button', { type: 'button', class: 'issue bad', onclick: () => showSpecies(a.c.n, t && t.id, true) }, el('span', { class: 'dot', 'aria-hidden': 'true' }), el('span', { class: 'issue-text', text: a.text }))))));
    }
  }
}

function stockCard(t) {
  return el('div', { class: 'card' }, el('div', { class: 'card-head' }, el('h2', { text: 'Stocking' })), stockBar(t));
}

// ---------- Fish Check ----------
const SCAN_PRICES = { 'gemini-3.5-flash-lite': [0.3, 2.5], 'gemini-3.8-flash': [0.75, 3.75] };
let fishCheckTankId = '';
let fishCheckNone = false;
function fishCheckTank() { return fishCheckNone ? null : (getTank(fishCheckTankId) || activeTank()); }
let fishCheck = null; // { photoUrl, loading, error, result, name, count, usage, model }

function fishCheckCostLine(fc) {
  if (!fc || !fc.runs || !fc.runs.length) return null;
  const n = (x) => Number(x || 0).toLocaleString();
  return fc.runs.map((run) => {
    const p = SCAN_PRICES[run.model];
    const bits = [run.model + ', ' + n(run.usage.input) + ' tokens in, ' + n(run.usage.output) + ' out'];
    if (p) bits.push('about ' + centsText((run.usage.input * p[0] + run.usage.output * p[1]) / 1e6));
    return bits.join(' · ');
  }).join(' | ');
}

async function runFish(deep) {
  const t = fishCheckTank();
  fishCheck.loading = true; fishCheck.error = '';
  renderFishCheck();
  try {
    const data = await askWorker(fishCheck.images, 'fish', 45000, { tank_type: t && TYPES.includes(t.type) ? t.type : '', deep: !!deep });
    const r = data.fish;
    if (data.first_pass) fishCheck.runs.push({ model: data.first_pass.model, usage: data.first_pass.usage });
    fishCheck.runs.push({ model: data.model, usage: data.usage });
    if (!r || !r.is_aquarium || !r.common_name) {
      fishCheck.error = 'I could not find a fish, plant or coral in that photo. Move closer to one animal, hold still, and try again.';
    } else {
      fishCheck.result = r;
      fishCheck.deep = !!deep;
      if (!fishCheck.picker && fishCheck.image && r.main_box && r.others && r.others.length) {
        fishCheck.picker = { active: 0, items: [{ look: r.common_name, box: r.main_box, done: true }].concat(r.others.map((o) => ({ look: o.look, box: o.box, done: false }))) };
      } else if (fishCheck.picker) {
        const it = fishCheck.picker.items[fishCheck.picker.active];
        if (it) { it.look = r.common_name; it.done = true; }
      }
      const hit = resolveSpecies(r.common_name, r.scientific_name, 'fish check', r.kind);
      fishCheck.name = hit ? hit.n : r.common_name;
      fishCheck.userPick = false;
      fishCheck.count = hit && hit.c && hit.c.s > 1 ? hit.c.s : (r.care_estimate && r.care_estimate.min_group > 1 ? r.care_estimate.min_group : 1);
    }
  } catch (err) {
    fishCheck.error = (err && err.message) || 'Something went wrong. Please try again.';
  }
  fishCheck.loading = false;
  renderFishCheck();
  const res = fishCheck.result;
  if (res && !res.care_estimate && !(lookupSpecies(fishCheck.name) && lookupSpecies(fishCheck.name).c)) fetchCare(fishCheck, res);
}

// A species that is not in the app's list: ask the AI for a rough care sheet, a separate tiny call that only runs when needed.
async function fetchCare(fc, r) {
  fc.careLoading = true;
  renderFishCheck();
  try {
    const res = await fetch(WORKER_URL + '/care', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: r.common_name, scientific: r.scientific_name || '' }),
      signal: AbortSignal.timeout(20000)
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.ok) {
      if (data.care_estimate) r.care_estimate = data.care_estimate;
      if (data.usage) { fc.runs.push({ model: data.model, usage: data.usage }); logUsage('care', data.model, data.usage, { detail: r.common_name }); }
    }
  } catch (err) { /* the estimate is a bonus; the plain "ask the store" text shows instead */ }
  fc.careLoading = false;
  if (fishCheck === fc) renderFishCheck();
}

// Several kinds of fish in one photo: re-check a close-up of the one the person tapped.
async function pickFish(index) {
  const fc = fishCheck;
  if (!fc || fc.loading || !fc.picker || !fc.image) return;
  const item = fc.picker.items[index];
  if (!item || index === fc.picker.active) return;
  const r = cropRect(item.box, fc.image.width, fc.image.height);
  const crop = drawToJpeg(fc.image.source, r.x, r.y, r.w, r.h, SINGLE_SIDE, 0.85);
  fc.images = [crop.split(',')[1]];
  fc.picker.active = index;
  fc.result = null; fc.name = ''; fc.count = 1; fc.error = ''; fc.deep = false; fc.userPick = false;
  await runFish(false);
}

async function startFishCheck(file, fromVideo) {
  fishCheck = { photoUrl: '', loading: true, error: '', result: null, name: '', count: 1, runs: [], images: null, deep: false };
  renderFishCheck();
  try {
    if (fromVideo) {
      let frames = [];
      try { frames = await extractVideoFrames(file, 1); } catch (e) { frames = []; }
      if (!frames.length) throw new Error('That video could not be read. Try recording again, or use a photo.');
      file = frames[0];
    }
    const image = await loadImage(file);
    const single = makeSingle(image);
    fishCheck.photoUrl = single.previewUrl;
    fishCheck.images = single.images;
    fishCheck.image = image;
  } catch (err) {
    fishCheck.error = (err && err.message) || 'I could not read that photo. Please try another.';
    fishCheck.loading = false;
    renderFishCheck();
    return;
  }
  await runFish(false);
}

// For a species that is not in the app's list, the AI gives a rough care sheet. Shown clearly as an estimate.
function estimateFacts(ce) {
  const rows = [['Adult size', ce.adult_size_in + ' in'], ['Smallest tank', ce.min_tank_gal + ' gal']];
  if (ce.temp_low_f !== null && ce.temp_high_f !== null) rows.push(['Temperature', Math.round(ce.temp_low_f) + '-' + Math.round(ce.temp_high_f) + '°F']);
  if (ce.ph_low !== null && ce.ph_high !== null) rows.push(['pH', ce.ph_low + '-' + ce.ph_high]);
  if (ce.temperament) rows.push(['Temperament', ce.temperament === 'peaceful' ? 'Peaceful' : ce.temperament === 'aggressive' ? 'Aggressive' : 'Semi-aggressive']);
  if (ce.eats) rows.push(['Eats', ce.eats]);
  rows.push(['Group size', ce.min_group > 1 ? ce.min_group + ' or more' : 'Fine on its own']);
  return rows;
}
function estimateNotes(ce, t) {
  const notes = [];
  if (!t) return notes;
  const typeWater = t.type === 'Saltwater' ? 'salt' : t.type === 'Brackish' ? 'brackish' : 'fresh';
  if (ce.water && ce.water !== typeWater && !(t.type === 'Brackish')) notes.push({ level: 'bad', text: 'This looks like a ' + ce.water + ' water animal and your tank is ' + t.type.toLowerCase() + '.' });
  const gal = tankGallons(t);
  if (gal && ce.min_tank_gal > gal) notes.push({ level: 'bad', text: 'It likely needs about ' + ce.min_tank_gal + ' gallons or more. Your tank is ' + Math.round(gal) + '.' });
  if (ce.temperament === 'aggressive' && t.fish.length) notes.push({ level: 'warn', text: 'It may be aggressive toward your current fish.' });
  return notes;
}

function fishVerdict(t, name, count) {
  const before = tankCheck(t);
  const tmp = Object.assign({}, t, { fish: t.fish.map((f) => Object.assign({}, f)) });
  addToTank(tmp, name, count, 'add');
  const after = tankCheck(tmp);
  const had = new Set(before.issues.map((i) => i.text));
  const fresh = after.issues.filter((i) => !had.has(i.text));
  return { tmp, fresh };
}

const HEALTH_LOOK = {
  healthy: ['Looks healthy', 'ok'],
  some_concerns: ['Some concerns', 'warn'],
  unwell: ['Looks unwell', 'bad'],
  cannot_tell: ["Can't tell from this photo", 'warn']
};
function healthCard(h) {
  const hh = h && HEALTH_LOOK[h.status] ? h : { status: 'cannot_tell', score: null, signs: [] };
  const look = HEALTH_LOOK[hh.status];
  const box = el('div', { class: 'health-box ' + look[1] });
  box.append(el('div', { class: 'water-line' }, el('strong', { text: 'Health check' }), el('span', { class: 'pill ' + look[1], text: look[0] })));
  if (hh.score !== null && hh.score !== undefined) {
    box.append(el('div', { class: 'health-score' }, el('span', { class: 'health-num', text: hh.score + '/100' }),
      el('div', { class: 'health-bar', role: 'img', 'aria-label': 'Health score ' + hh.score + ' out of 100' }, el('span', { style: 'width:' + hh.score + '%' }))));
  }
  if (hh.signs && hh.signs.length) box.append(el('ul', { class: 'health-signs' }, ...hh.signs.map((x) => el('li', { text: x }))));
  const tip = hh.status === 'unwell'
    ? 'I would pass on this one. Fish from the same tank can carry the same problem.'
    : hh.status === 'cannot_tell'
      ? 'Try a sharper, evenly lit photo with natural colors. Watch it swim before you buy.'
      : 'A photo cannot catch everything. Ask to see it eat, and keep new fish apart for a few weeks before adding them.';
  box.append(el('p', { class: 'muted small', text: tip }));
  return box;
}

// Splits a tell-apart tip such as "Cardinal: ... Neon: ..." into one entry per fish.
function parseTip(tip) {
  const out = [];
  if (!tip) return out;
  tip.split(/\.\s+/).forEach((sentence) => {
    const m = sentence.match(/^([A-Z][^:]{0,40}):\s*(.*)$/);
    if (m) out.push({ label: m[1].trim(), text: m[2].replace(/\.*$/, '') + '.' });
  });
  return out;
}

// Short "works with / avoid with" lists for one species, used on the Fish Check result.
function compatLists(entry, t) {
  if (!entry || !entry.c || entry.k === 'plant') return null;
  const saltOnly = entry.w.indexOf('s') !== -1 && entry.w.indexOf('f') === -1 && entry.w.indexOf('b') === -1;
  const type = t && TYPES.includes(t.type) ? t.type : saltOnly ? 'Saltwater' : 'Freshwater';
  const codes = type === 'Saltwater' ? ['s'] : type === 'Brackish' ? ['b', 'f'] : ['f'];
  const wantKinds = entry.k === 'coral' ? ['fish', 'coral', 'invert', 'shrimp', 'snail'] : ['fish', 'shrimp', 'snail', 'invert'];
  const gal = t ? tankGallons(t) : 0;
  const good = [], avoid = [];
  DB.list.forEach((c) => {
    if (c === entry || !c.c || wantKinds.indexOf(c.k) === -1 || !codes.some((x) => c.w.indexOf(x) !== -1)) return;
    const issues = pairIssues(entry, c);
    if (!issues.length) { if (!gal || c.c.g <= gal) good.push(c); }
    else if (issues.some((i) => i.level === 'bad')) avoid.push(c);
  });
  const score = (c) => (c.c.m === 'p' ? 0 : 6) + Math.abs(c.c.z - entry.c.z) * 0.6 + (c.c.y === entry.c.y ? 2 : 0) + (c.c.l === 'h' ? 3 : 0);
  good.sort((p, q) => score(p) - score(q));
  avoid.sort((p, q) => (p.c.l === q.c.l ? p.n.localeCompare(q.n) : p.c.l < q.c.l ? -1 : 1));
  const avoidNames = [];
  let shrimpAdded = false;
  avoid.forEach((c) => {
    if (c.k === 'shrimp') { if (!shrimpAdded) { avoidNames.push('Shrimp'); shrimpAdded = true; } return; }
    avoidNames.push(c.n);
  });
  return { good: good.slice(0, 8).map((c) => c.n), avoid: avoidNames.slice(0, 6) };
}

function compatBox(entry, t) {
  const lists = compatLists(entry, t);
  if (!lists) return null;
  const col = (cls, title, names, empty) => el('div', { class: 'compat-col ' + cls },
    el('h3', { text: title }),
    names.length ? el('ul', {}, ...names.map((n) => el('li', { text: n }))) : el('p', { class: 'muted small', text: empty }));
  return el('div', { class: 'compat' },
    col('ok', 'Works with', lists.good, 'No clear matches in the list.'),
    col('bad', 'Not with', lists.avoid, 'Nothing flagged.'));
}

function renderFishCheck() {
  const body = $('fishcheck-body');
  body.replaceChildren();
  const t = fishCheckTank();
  body.append(el('h1', { text: 'Fish Check' }),
    el('p', { class: 'muted', text: 'Standing at the fish store? Photograph one fish, plant or coral. Get its name, what it needs, and whether it fits your tank. Including its name tag in the photo helps.' }));
  if (fishCheckFrom === 'tank' && t) body.append(el('p', { class: 'muted small', text: 'Checking for ' + tankLabel(t) }));
  else putAll(body, tankSwitcher(t, 'Checking for', (id) => { fishCheckNone = !id; if (id) setActiveTank(id); else fishCheckTankId = ''; renderFishCheck(); }, 'No tank yet'));
  const fc = fishCheck;
  const actions = el('div', { class: 'row photo-actions' },
    el('button', { type: 'button', class: 'btn primary', text: 'Take photo', onclick: () => $('fishcheck-camera').click() }),
    el('button', { type: 'button', class: 'btn', text: 'Choose photo', onclick: () => $('fishcheck-gallery').click() }),
    el('button', { type: 'button', class: 'btn', text: 'Record short video', onclick: () => $('fishcheck-video').click() }));
  body.append(actions);
  body.append(el('p', { class: 'muted small', text: 'Video: hold steady on one fish for about 3 seconds. We pick the sharpest frame, so it costs the same as one photo.' }));
  if (!fc) return;
  if (fc.photoUrl && fc.picker) {
    const pk = fc.picker;
    const wrap = el('div', { class: 'pick-wrap' }, el('img', { class: 'dream-image', src: fc.photoUrl, alt: 'The fish you photographed' }));
    pk.items.forEach((it, i) => {
      wrap.append(el('button', {
        type: 'button', class: 'pick-box' + (i === pk.active ? ' on' : ''),
        style: 'top:' + it.box[0] / 10 + '%;left:' + it.box[1] / 10 + '%;height:' + (it.box[2] - it.box[0]) / 10 + '%;width:' + (it.box[3] - it.box[1]) / 10 + '%',
        'aria-label': 'Check ' + it.look, onclick: () => pickFish(i)
      }, el('span', { text: String(i + 1) })));
    });
    body.append(wrap);
    body.append(el('p', { class: 'muted small', text: 'I can see ' + pk.items.length + ' kinds of fish here. Tap the one you want to check.' }));
    body.append(el('div', { class: 'alts' }, ...pk.items.map((it, i) => el('button', { type: 'button', class: 'alt-chip' + (i === pk.active ? ' pick-on' : ''), text: (i + 1) + '. ' + it.look, onclick: () => pickFish(i) }))));
  } else if (fc.photoUrl) body.append(el('img', { class: 'dream-image', src: fc.photoUrl, alt: 'The fish you photographed' }));
  if (fc.loading) { body.append(el('p', { class: 'muted center', role: 'status', text: 'Looking…' })); return; }
  if (fc.error) { body.append(el('div', { class: 'notice', role: 'status', text: fc.error })); return; }
  const r = fc.result;
  if (!r) return;
  const entry = lookupSpecies(fc.name);
  // A photo alone can't settle the look-alike groups (two rainbowfish, neon vs cardinal and so on), so never say "Confident" for those.
  const group = entry && entry.g && DB.groups[entry.g] ? DB.groups[entry.g] : null;
  // "Your pick" only when the keeper tapped a different name, not when the app matched the AI's answer by its scientific name.
  const switched = !!fc.userPick && canonKey(fc.name) !== canonKey(r.common_name);
  let conf = isGenericName(r.common_name) ? Math.min(r.confidence, 0.6) : (group && group.h ? Math.min(r.confidence, 0.85) : r.confidence);
  // The AI's common name is not one we know (matched only by scientific name or genus): treat it as unsure.
  if (entry && !lookupSpecies(r.common_name)) conf = Math.min(conf, 0.75);
  const sure = switched ? ['Your pick', 'ok'] : conf >= 0.95 ? ['Confident', 'ok'] : conf >= 0.8 ? ['Likely', 'warn'] : ['Not sure', 'bad'];
  const card = el('div', { class: 'card dream-result' });
  card.append(el('div', { class: 'water-line' }, el('h2', { text: fc.name }), el('span', { class: 'pill ' + sure[1], text: sure[0] })));
  if (entry && entry.s) card.append(el('p', { class: 'muted small', text: entry.s }));
  card.append(healthCard(r.health));
  if (r.label_text) card.append(el('p', { class: 'muted small', text: 'Read from the tag: ' + r.label_text }));
  if (conf < 0.95 && conf >= 0.6 && !switched) card.append(el('p', { class: 'muted small', text: 'Worth a second look. Check the other names below, or try a closer side-on photo.' }));
  if (conf < 0.6 && !switched) card.append(el('p', { class: 'muted small', text: 'Try a closer photo of one fish, or include its name tag. Fish look different when they are stressed in store tanks.' }));
  // Members of the look-alike group, in the order the tell-apart tip mentions them (the usual mix-ups come first).
  const tipText = group && group.tip ? group.tip.toLowerCase() : '';
  const tipPos = (n) => { const k = tipText.indexOf(n.toLowerCase().split(/[\s-]/)[0]); return k < 0 ? 9999 : k; };
  const members = group && group.h ? DB.list.filter((e) => e.g === entry.g).map((e) => e.n).sort((x, y) => tipPos(x) - tipPos(y)) : [];
  const seenAlt = new Set();
  const alts = r.alternatives.concat(members).map((x) => lookupSpecies(x) ? lookupSpecies(x).n : x)
    .filter((x) => { const k = canonKey(x); if (k === canonKey(fc.name) || seenAlt.has(k) || !sameKindAs(x, fc.name)) return false; seenAlt.add(k); return true; }).slice(0, 3);
  if (alts.length) {
    const chunks = parseTip(group && group.tip);
    card.append(el('p', { class: 'label', text: 'Could also be' }),
      el('div', { class: 'lookalikes' }, ...alts.map((x) => {
        const hit = lookupSpecies(x);
        const fw = x.toLowerCase().split(/[\s-]/)[0];
        const chunk = chunks.find((ch) => ch.label.toLowerCase().split(/[\s\/(]/)[0] === fw) || chunks.find((ch) => ch.label.toLowerCase().indexOf(fw) >= 0);
        const desc = chunk ? chunk.text : (hit && hit.s ? hit.s : '');
        return el('button', { type: 'button', class: 'lookalike', 'aria-label': 'Switch to ' + x, onclick: () => {
          fc.name = x; fc.userPick = true; const h2 = lookupSpecies(x); fc.count = h2 && h2.c && h2.c.s > 1 ? h2.c.s : 1; renderFishCheck();
        } }, el('strong', { text: x }), desc ? el('span', { text: desc }) : null);
      })));
  }
  const care = entry && entry.c ? entry : null;
  if (care) {
    card.append(el('div', { class: 'facts' }, ...speciesFacts(care).slice(0, 8).map((row) => factRow(row[0], row[1]))));
    if (care.c.n) card.append(el('p', { class: 'muted small', text: care.c.n }));
  } else if (fc.careLoading && canonKey(fc.name) === canonKey(r.common_name)) {
    card.append(el('p', { class: 'muted small', role: 'status', text: 'Looking up care details…' }));
  } else if (r.care_estimate && canonKey(fc.name) === canonKey(r.common_name)) {
    const ce = r.care_estimate;
    card.append(el('p', { class: 'label', text: 'AI estimate' }),
      el('div', { class: 'facts' }, ...estimateFacts(ce).map((row) => factRow(row[0], row[1]))),
      el('p', { class: 'muted small', text: (ce.note ? ce.note + ' ' : '') + 'This is the AI\'s best guess, not from the app\'s care list. Double-check with the store.' }));
    const en = estimateNotes(ce, t);
    if (en.length) card.append(issueList(en));
    else if (t) card.append(el('p', { class: 'muted small', text: 'Nothing obvious against your tank, based on that estimate.' }));
  } else {
    card.append(el('p', { class: 'muted', text: 'I do not have care details for this one yet. Before you buy, ask the store for its adult size, the smallest tank it needs and whether it gets along with other fish.' }));
  }

  if (t && care) {
    const counter = el('div', { class: 'card-head' },
      el('span', { class: 'label', text: 'How many would you buy?' }),
      el('div', { class: 'stepper' },
        el('button', { type: 'button', class: 'round', 'aria-label': 'One fewer', text: '\u2212', onclick: () => { fc.count = Math.max(1, fc.count - 1); renderFishCheck(); } }),
        el('span', { class: 'count', text: String(fc.count) }),
        el('button', { type: 'button', class: 'round', 'aria-label': 'One more', text: '+', onclick: () => { fc.count = Math.min(60, fc.count + 1); renderFishCheck(); } })));
    const v = fishVerdict(t, fc.name, fc.count);
    const bad = v.fresh.some((i) => i.level === 'bad');
    card.append(el('h2', { class: 'dream-list-h', text: 'Will it work in ' + tankLabel(t) + '?' }), counter,
      el('div', { class: 'water-line' }, el('strong', { text: 'Verdict' }),
        !v.fresh.length ? el('span', { class: 'pill ok', text: 'Looks good' }) : el('span', { class: 'pill ' + (bad ? 'bad' : 'warn'), text: bad ? 'Not a good fit' : v.fresh.length + (v.fresh.length === 1 ? ' thing to know' : ' things to know') })),
      v.fresh.length ? issueList(v.fresh.slice(0, 5)) : el('p', { class: 'muted small', text: 'No new problems with what you keep now.' }),
      stockBar(v.tmp), el('p', { class: 'muted small', text: 'Stocking shown with ' + fc.count + ' added.' }));
    const have = t.fish.find((f) => canonKey(f.name) === canonKey(fc.name));
    if (have) card.append(el('p', { class: 'muted small', text: 'You already have ' + have.count + ' in this tank.' }));
  } else if (!t && care) {
    card.append(el('p', { class: 'muted small', text: 'Add a tank on the home screen to see whether this fish fits.' }));
  }

  const box = compatBox(entry, t);
  if (box) card.append(el('h2', { class: 'dream-list-h', text: 'Tank mates' }), box);
  const buttons = el('div', { class: 'row photo-actions' });
  if (t) buttons.append(el('button', { type: 'button', class: 'btn primary', text: 'Add to ' + tankLabel(t), onclick: () => {
    const active = fc.picker && fc.picker.items[fc.picker.active];
    const thumb = fishThumb(fc.image, (active && active.box) || r.main_box || null);
    const had = t.fish.find((f) => canonKey(f.name) === canonKey(lookupSpecies(fc.name) ? lookupSpecies(fc.name).n : fc.name));
    const hadPhoto = !!(had && had.photo);
    addToTank(t, fc.name, fc.count, 'add', r.kind, thumb);
    if (r.is_aquarium !== false && r.kind !== 'other') {
      const crop = fishThumb(fc.image, (active && active.box) || r.main_box || null, CROP_SIDE);
      const lk = lookupSpecies(fc.name);
      if (crop) shareCrops([{ name: lk ? lk.n : fc.name, sci: r.scientific_name || '', kind: r.kind, src: fc.userPick ? 'user' : 'ai', ai: fc.userPick ? r.common_name : '', conf: fc.userPick ? 1 : r.confidence, water: t.type, image: crop }]);
    }
    if (!saveState() && !hadPhoto) { const row = t.fish.find((f) => canonKey(f.name) === canonKey(lookupSpecies(fc.name) ? lookupSpecies(fc.name).n : fc.name)); if (row) delete row.photo; saveState(); }
    toast('Added ' + fc.count + ' ' + fc.name + ' to ' + tankLabel(t) + '.');
    renderFishCheck();
  } }));
  card.append(buttons, el('a', { class: 'link-out', href: 'https://www.google.com/search?q=' + encodeURIComponent(((entry && entry.n) || fc.name) + ' aquarium care'), target: '_blank', rel: 'noopener noreferrer', text: 'More photos and care info on Google \u2197'}), el('p', { class: 'muted small', text: 'General guidance, and the AI can be wrong about which species it is. Confirm with the store before you buy.' }));
  const cl = fishCheckCostLine(fc);
  if (cl) card.append(el('p', { class: 'muted small cost-line', text: cl }));
  body.append(card);
}

['fishcheck-camera', 'fishcheck-gallery'].forEach((id) => $(id).addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (file) startFishCheck(file);
}));
if ($('fishcheck-video')) $('fishcheck-video').addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (file) startFishCheck(file, true);
});
$('fishcheck-back').addEventListener('click', () => goBack(() => (fishCheckFrom === 'tank' && getTank(openTankId) ? showTank(openTankId) : showView('home'))));
$('backup-back').addEventListener('click', () => goBack(() => showView('home')));
$('misses-back').addEventListener('click', () => goBack(() => showView('home')));

// ---------- Get Schooled (ask about a tank) ----------
// A short chat about one tank. The phone builds a plain summary of the tank and sends it with each question,
// so the AI always answers about this tank. Chats are kept on this phone, per tank.
const ASK_KEY = 'schooled.ask';
const ASK_MONTHLY = 100;
const ASK_KEEP = 40; // messages kept per tank
const ASK_ERRORS = {
  limit_reached: 'You have used all ' + ASK_MONTHLY + ' questions for this month. They reset on the 1st.',
  busy_today: 'Get Schooled is very busy today. Please try again tomorrow.',
  rate_limited: 'That is a lot of questions in a short time. Wait a few minutes and try again.',
  ai_busy: 'The AI is busy right now. Try again in a minute.',
  bad_request: 'Type a question first.',
  bad_image: 'That photo could not be sent. Try a different one.',
  too_large: 'That photo is too large. Try a different one.'
};
let askBusy = false;
let askDraft = '';
let askPhoto = ''; // photo waiting to be sent with the next question (data URL)
let askMessage = '';

function askLoad() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(ASK_KEY)); } catch (err) { s = null; }
  if (!s || typeof s !== 'object') s = {};
  if (!s.chats || typeof s.chats !== 'object') s.chats = {};
  const m = new Date().toISOString().slice(0, 7);
  if (s.month !== m) { s.month = m; s.used = 0; }
  s.used = Math.max(0, Number(s.used) || 0);
  return s;
}
function askSave(s) {
  try { localStorage.setItem(ASK_KEY, JSON.stringify(s)); return true; } catch (err) { return false; }
}
function askChat(s, id) {
  const list = Array.isArray(s.chats[id]) ? s.chats[id] : [];
  return list.filter((m) => m && (m.role === 'user' || m.role === 'model') && typeof m.text === 'string');
}
function askLeft() { return Math.max(0, ASK_MONTHLY - askLoad().used); }

// Plain-text summary of the tank for the AI. Uses the same checks the app shows, so answers agree with the app.
function askContext(t) {
  const L = [];
  const gal = tankGallons(t);
  L.push('Name: ' + tankLabel(t));
  L.push('Type: ' + t.type + (t.style ? ', style: ' + t.style : ''));
  L.push('Size: ' + (gal ? Math.round(gal) + ' gallons' + (t.unit === 'liters' ? ' (' + t.size + ' liters)' : '') : 'not set'));
  if (t.filter) L.push('Filter: ' + (FILTER_TYPES.find((x) => x[0] === t.filter) || ['', t.filter])[1]);
  if (t.started) L.push('Set up on: ' + t.started + ' (' + Math.max(0, daysBetween(new Date(t.started + 'T12:00:00').getTime(), Date.now())) + ' days ago)');
  if (t.notes) L.push('Keeper notes: ' + t.notes);
  if (t.fish.length) {
    L.push('Livestock and plants:');
    t.fish.slice(0, 40).forEach((f) => {
      const e = careOf(f.name);
      let line = '- ' + f.count + ' x ' + (e ? e.n : f.name);
      if (e && e.c) {
        const c = e.c;
        line += ' (' + e.k + (e.k === 'plant' ? '' : ', adult ' + c.z + ' in, min ' + c.g + ' gal') + ', ' + Math.round(c.t[0]) + '-' + Math.round(c.t[1]) + ' F, pH ' + c.p[0] + '-' + c.p[1] + (TEMPER[c.m] ? ', ' + TEMPER[c.m].toLowerCase() : '') + (c.s > 1 ? ', group of ' + c.s + '+' : '') + ')';
      }
      L.push(line);
    });
    const st = stocking(t);
    if (st.gal && st.known) L.push('App stocking estimate: ' + stockLevel(st.pct).label + ' (' + Math.round(st.pct * 100) + '% of capacity).');
    const chk = tankCheck(t);
    if (chk.issues.length) {
      L.push('App compatibility warnings:');
      chk.issues.slice(0, 8).forEach((i) => L.push('- ' + i.text));
    }
  } else L.push('Livestock: none added yet.');
  const tests = t.log.filter((r) => r.k === 'test').slice(-5).reverse();
  if (tests.length) {
    L.push('Recent water tests (newest first):');
    tests.forEach((r) => L.push('- ' + new Date(r.t).toISOString().slice(0, 10) + ': ' + Object.keys(r.v).map((k) => LOG_FIELDS[k].label + ' ' + r.v[k] + (LOG_FIELDS[k].unit ? ' ' + LOG_FIELDS[k].unit : '')).join(', ') + (r.note ? ' (note: ' + r.note + ')' : '')));
  } else L.push('Water tests: none logged.');
  const changes = t.log.filter((r) => r.k === 'change').slice(-3).reverse();
  if (changes.length) L.push('Recent water changes: ' + changes.map((r) => new Date(r.t).toISOString().slice(0, 10) + (r.pct ? ' (' + r.pct + '%)' : '')).join(', '));
  if (t.tasks.length) L.push('Reminders: ' + t.tasks.map((k) => k.label + ' every ' + k.every + ' days, ' + taskInfo(k).text.toLowerCase()).join('; '));
  if (t.gear.length) L.push('Equipment: ' + t.gear.map((g) => g.kind + ': ' + g.name).join('; '));
  return L.join('\n').slice(0, 4000);
}

function askStarters(t) {
  const out = [];
  if (t.fish.length) out.push('Are my fish good tankmates?', 'Is my tank overstocked?');
  else out.push('What fish would suit this tank?');
  if (t.log.some((r) => r.k === 'test')) out.push('What do my last test results mean?');
  else out.push('Which water tests should I do first?');
  out.push('How often should I change the water?');
  if (t.started && daysBetween(new Date(t.started + 'T12:00:00').getTime(), Date.now()) < 60) out.push('Is my tank cycled yet?');
  return out.slice(0, 4);
}

// Turns a plain-text answer into paragraphs and simple bullet lists.
function askText(text) {
  const box = el('div', { class: 'ask-text' });
  let ul = null;
  String(text).split(/\n+/).forEach((line) => {
    const s = line.trim();
    if (!s) return;
    const b = /^[-*•]\s+(.*)$/.exec(s) || /^\d+[.)]\s+(.*)$/.exec(s);
    if (b) {
      if (!ul) { ul = el('ul'); box.append(ul); }
      ul.append(el('li', { text: b[1] }));
    } else { ul = null; box.append(el('p', { text: s })); }
  });
  return box;
}

function openAsk(id) {
  if (!getTank(id)) return;
  if (openTankId !== id) { askPhoto = ''; askDraft = ''; }
  openTankId = id;
  askMessage = '';
  showView('ask');
}

function renderAsk() {
  const body = $('ask-body');
  if (!body) return;
  const t = getTank(openTankId);
  if (!t) { showView('home'); return; }
  const s = askLoad();
  const chat = askChat(s, t.id);
  const left = Math.max(0, ASK_MONTHLY - s.used);

  const head = el('div', { class: 'ask-head' },
    el('div', {}, el('h1', { text: 'Get Schooled' }), el('p', { class: 'muted small', text: 'About ' + tankLabel(t) })),
    chat.length ? el('button', { type: 'button', class: 'btn link small-link', text: 'Clear chat', onclick: () => {
      const s2 = askLoad(); delete s2.chats[t.id]; askSave(s2); askMessage = ''; renderAsk();
    } }) : null);
  const parts = [head];

  if (!chat.length) {
    parts.push(el('div', { class: 'card ask-intro' },
      el('p', { text: 'Ask anything about this tank. The AI sees your fish, water tests, reminders and equipment, so answers are about your tank, not tanks in general. Tap the camera to add a photo, like a spot on a fish or algae on the glass.' }),
      el('div', { class: 'ask-chips' }, ...askStarters(t).map((q) => el('button', { type: 'button', class: 'chip-btn', text: q, onclick: () => sendAsk(q) })))));
  }

  const log = el('div', { class: 'ask-log', 'aria-live': 'polite' });
  chat.forEach((m) => log.append(el('div', { class: 'ask-msg ' + (m.role === 'user' ? 'me' : 'ai') + (m.img ? ' has-img' : '') },
    m.img ? el('img', { class: 'ask-img', src: m.img, alt: 'Your photo' }) : null,
    m.role === 'user' ? el('p', { text: m.text }) : askText(m.text))));
  if (askBusy) log.append(el('div', { class: 'ask-msg ai busy', 'aria-label': 'Thinking' }, el('span', { class: 'ask-dots' }, el('i'), el('i'), el('i'))));
  parts.push(log);

  const last = chat[chat.length - 1];
  if (!askBusy && last && last.role === 'model' && Array.isArray(last.sug) && last.sug.length) {
    parts.push(el('div', { class: 'ask-chips' }, ...last.sug.map((q) => el('button', { type: 'button', class: 'chip-btn', text: q, onclick: () => sendAsk(q) }))));
  }
  if (askMessage) parts.push(el('div', { class: 'notice', role: 'status', text: askMessage }));

  const area = el('textarea', { class: 'ask-input', rows: 1, maxlength: 500, placeholder: left ? 'Ask about this tank…' : 'No questions left this month', 'aria-label': 'Your question' });
  area.value = askDraft;
  const fit = () => { area.style.height = 'auto'; area.style.height = Math.min(140, area.scrollHeight) + 'px'; };
  area.addEventListener('input', () => { askDraft = area.value; fit(); });
  area.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendAsk(area.value); } });
  const send = el('button', { type: 'button', class: 'ask-send', 'aria-label': 'Send', onclick: () => sendAsk(area.value) }, iconSvg(['M5 12h13', 'M13 6l6 6-6 6'], 22));
  const pick = el('input', { type: 'file', accept: 'image/*,.heic,.heif,.avif,.webp,.bmp,.gif,.tif,.tiff', hidden: true });
  pick.addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try { askPhoto = await photoFromFile(file, 1024); renderAsk(); } catch (err) { toast("This device couldn't open that photo. Try another one."); }
  });
  const cam = el('button', { type: 'button', class: 'ask-cam', 'aria-label': askPhoto ? 'Change photo' : 'Add a photo', onclick: () => pick.click() },
    iconSvg(['M4 8h3l2-2.5h6L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z', 'M12 10a3.2 3.2 0 1 0 0 6.4 3.2 3.2 0 0 0 0-6.4z'], 22));
  if (askBusy || !left) { send.disabled = true; cam.disabled = true; area.disabled = !left; }
  const preview = askPhoto ? el('div', { class: 'ask-preview' }, el('img', { src: askPhoto, alt: 'Photo to send' }),
    el('button', { type: 'button', class: 'ask-preview-x', 'aria-label': 'Remove photo', text: '\u00d7', onclick: () => { askPhoto = ''; renderAsk(); } })) : null;
  if (askPhoto && !askDraft) area.placeholder = 'Ask about this photo…';
  parts.push(el('div', { class: 'ask-bar' }, preview, el('div', { class: 'ask-row' }, cam, area, send, pick),
    el('p', { class: 'muted small center', text: left + ' of ' + ASK_MONTHLY + ' questions left this month. Answers are AI guidance; check anything serious with a local fish store.' })));

  body.replaceChildren(...parts);
  requestAnimationFrame(fit);
}

async function sendAsk(text) {
  let q = String(text || '').trim().slice(0, 500);
  const t = getTank(openTankId);
  if (!t || askBusy) return;
  const photo = askPhoto;
  if (photo && q.length < 2) q = 'What do you see in this photo? Anything I should worry about?';
  if (q.length < 2) { toast('Type a question first.'); return; }
  if (!askLeft()) { askMessage = ASK_ERRORS.limit_reached; renderAsk(); return; }
  const s = askLoad();
  const chat = askChat(s, t.id);
  const history = chat.slice(-8).map((m) => ({ role: m.role, text: m.text + (m.img ? ' [I attached a photo with this message]' : '') }));
  while (history.length && history[0].role !== 'user') history.shift();
  let thumb = '';
  if (photo) { try { thumb = await shrinkDataUrl(photo, 360); } catch (err) { thumb = ''; } }
  const msg = { role: 'user', text: q, t: Date.now() };
  if (thumb) msg.img = thumb;
  chat.push(msg);
  s.chats[t.id] = chat.slice(-ASK_KEEP);
  if (!askSave(s)) { // phone storage full: drop old photo thumbnails and try again
    s.chats[t.id].forEach((m, i, a) => { if (i < a.length - 1) delete m.img; });
    if (!askSave(s)) { delete msg.img; askSave(s); }
  }
  askDraft = ''; askPhoto = ''; askMessage = ''; askBusy = true;
  renderAsk();
  window.scrollTo(0, document.body.scrollHeight);
  try {
    const res = await fetch(WORKER_URL + '/ask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.assign({ question: q, tank: askContext(t), history, device: deviceId() }, photo ? { image: photo.split(',')[1] || '', mime: 'image/jpeg' } : {})),
      signal: AbortSignal.timeout(75000)
    });
    let j = null;
    try { j = await res.json(); } catch (err) { j = null; }
    const s2 = askLoad();
    const c2 = askChat(s2, t.id);
    if (!j || !j.ok) {
      const code = j && j.error;
      if (code === 'limit_reached') s2.used = ASK_MONTHLY;
      // take the unanswered question back out, and put it in the box so it can be sent again
      if (c2.length && c2[c2.length - 1].role === 'user') { askDraft = c2.pop().text; askPhoto = photo; }
      s2.chats[t.id] = c2;
      askSave(s2);
      askMessage = ASK_ERRORS[code] || 'Something went wrong. Your question was not counted. Try again in a minute.';
    } else {
      c2.push({ role: 'model', text: String(j.answer || ''), sug: Array.isArray(j.suggestions) ? j.suggestions.slice(0, 3).map(String) : [], t: Date.now() });
      s2.chats[t.id] = c2.slice(-ASK_KEEP);
      s2.used += 1;
      if (typeof j.left === 'number') s2.used = Math.max(s2.used, ASK_MONTHLY - j.left);
      askSave(s2);
      if (j.usage) logUsage('ask', j.model, j.usage, { detail: q.slice(0, 40) });
    }
  } catch (err) {
    const s2 = askLoad();
    const c2 = askChat(s2, t.id);
    if (c2.length && c2[c2.length - 1].role === 'user') { askDraft = c2.pop().text; askPhoto = photo; }
    s2.chats[t.id] = c2;
    askSave(s2);
    askMessage = 'Could not reach the server. Check your connection and try again.';
  }
  askBusy = false;
  if (currentView === 'ask') {
    renderAsk();
    window.scrollTo(0, document.body.scrollHeight);
  }
}

// ---------- Dream Tank ----------
const DREAM_MONTHLY = 10;
const DREAM_KEY = 'schooled.dream';
const DEVICE_KEY = 'schooled.device';
const DREAM_ERRORS = {
  limit_reached: 'You have used this month’s dream pictures. They come back next month.',
  busy_today: 'Dream Tank has been very busy today. Please try again tomorrow.',
  rate_limited: 'That was a few too many tries in a row. Wait a few minutes and try again.',
  not_aquarium: 'That did not sound like an aquarium. Describe the fish, plants and style you want.',
  ai_busy: 'The AI is busy right now. Nothing was used. Try again in a minute.',
  too_large: 'That photo is too big. Try a different one.',
  bad_image: 'That photo could not be used. Try a different one.'
};

function dreamMonth() { return new Date().toISOString().slice(0, 7); }
function dreamLoad() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(DREAM_KEY) || 'null'); } catch (err) { s = null; }
  if (!s || typeof s !== 'object') s = {};
  if (s.month !== dreamMonth()) { s.month = dreamMonth(); s.used = 0; }
  s.used = Math.max(0, Math.min(99, Math.round(Number(s.used)) || 0));
  return s;
}
function dreamSave(s) {
  try { localStorage.setItem(DREAM_KEY, JSON.stringify(s)); return true; } catch (err) { return false; }
}
function dreamLeft() { return Math.max(0, DREAM_MONTHLY - dreamLoad().used); }
function deviceId() {
  let id = '';
  try { id = localStorage.getItem(DEVICE_KEY) || ''; } catch (err) { id = ''; }
  if (!/^[A-Za-z0-9_-]{12,60}$/.test(id)) {
    id = uid() + uid();
    id = id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40).padEnd(12, 'x');
    try { localStorage.setItem(DEVICE_KEY, id); } catch (err) { /* the server then counts by address */ }
  }
  return id;
}

let dreamForm = null;
let dreamPhoto = '';
let dreamBusy = false;
let dreamMessage = '';

function shrinkDataUrl(src, side) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          const k = Math.min(1, side / Math.max(img.width, img.height));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', 0.82));
        } catch (err) { resolve(src.length < 900000 ? src : ''); }
      };
      img.onerror = () => resolve(src.length < 900000 ? src : '');
      setTimeout(() => resolve(src.length < 900000 ? src : ''), 4000); // never leave the page waiting
      img.src = src;
    } catch (err) { resolve(''); }
  });
}

function dreamTank(r) {
  const fish = (r.species || []).map((s) => {
    const item = { name: canonName(s.common_name), count: Math.max(1, Math.round(s.count) || 1) };
    if (KIND_LIST.includes(s.kind)) item.kind = s.kind;
    return item;
  });
  return newTank({ name: r.title || 'Dream tank', size: String(r.gallons || 55), unit: 'gallons', type: r.type || 'Freshwater', fish, photo: r.image || '' });
}

async function runDream() {
  if (dreamBusy) return;
  const f = dreamForm;
  const text = f.text.trim();
  const gal = Number(f.size);
  if (text.length < 3) { toast('Describe the tank you want first.'); return; }
  if (!(gal >= 5 && gal <= 2000)) { toast('Enter a tank size between 5 and 2000 gallons.'); return; }
  if (!dreamLeft()) { dreamMessage = DREAM_ERRORS.limit_reached; renderDream(); return; }
  dreamBusy = true; dreamMessage = '';
  renderDream();
  try {
    const body = { prompt: text, tank_type: f.type, gallons: gal, device: deviceId() };
    if (dreamPhoto) { body.image = dreamPhoto.split(',')[1] || ''; body.mime = 'image/jpeg'; }
    const res = await fetch(WORKER_URL + '/dream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(130000) });
    let j = null;
    try { j = await res.json(); } catch (err) { j = null; }
    if (!j || !j.ok) {
      const code = j && j.error;
      if (code === 'limit_reached') { const s = dreamLoad(); s.used = DREAM_MONTHLY; dreamSave(s); }
      dreamMessage = (DREAM_ERRORS[code] || 'Something went wrong. Nothing was used. Try again in a minute.') + (j && j.ai_detail ? ' (' + String(j.ai_detail).slice(0, 300) + ')' : '');
    } else {
      let image = '';
      if (j.image && j.image.data && /^image\/(png|jpeg|webp)$/.test(j.image.mime)) {
        image = await shrinkDataUrl('data:' + j.image.mime + ';base64,' + j.image.data, 1024);
      }
      const s = dreamLoad();
      if (image) s.used += 1;
      if (j.usage && j.usage.plan) logUsage('dream-plan', j.usage.plan.model, j.usage.plan, { detail: 'plan' });
      if (j.usage && j.usage.image) logUsage('dream-image', j.usage.image.model, j.usage.image, { detail: image ? 'picture' : 'no picture returned' });
      const cost = dreamCost(j.usage);
      if (image) s.cost = Math.round(((Number(s.cost) || 0) + cost.dollars) * 10000) / 10000;
      s.last = { title: String(j.title || ''), summary: String(j.summary || ''), species: j.species, image, gallons: gal, type: f.type, at: Date.now(), usage: j.usage || null, imageModel: String(j.image_model || '') };
      if (!dreamSave(s)) { s.last.image = ''; dreamSave(s); }
      dreamMessage = image ? '' : 'The AI made your list but could not make the picture this time, and no picture was used. Try again.' + (j.image_error ? ' (' + String(j.image_error).slice(0, 300) + ')' : '');
    }
  } catch (err) {
    dreamMessage = 'Could not reach the server. Check your connection. Nothing was used.';
  }
  dreamBusy = false;
  renderDream();
  window.scrollTo(0, 0);
}

// Google's paid-tier prices per 1M tokens: [input, output]. Image output is priced much higher than text.
const DREAM_PRICES = { 'gemini-3.1-flash-image': [0.5, 60], 'gemini-2.5-flash-image': [0.3, 30], 'gemini-3-pro-image': [2, 120] };
function dreamCost(usage) {
  const im = usage && usage.image;
  const p = im && DREAM_PRICES[im.model];
  if (!p) return { dollars: 0, known: false };
  const out = (im.image_out || im.output || 0);
  const textOut = Math.max(0, (im.output || 0) - (im.image_out || 0)) + (im.thoughts || 0);
  const dollars = ((im.input || 0) * p[0] + (im.image_out ? im.image_out * p[1] + textOut * 3 : out * p[1]) ) / 1e6;
  return { dollars, known: true };
}
function centsText(d) { return (d * 100).toFixed(d * 100 < 10 ? 2 : 1) + '\u00a2'; }
function dreamCostLine(r) {
  const u = r.usage;
  if (!u || !u.image) return null;
  const c = dreamCost(u);
  const n = (x) => Number(x || 0).toLocaleString();
  const bits = [
    'Picture: ' + (u.image.model || 'unknown') + ', ' + n(u.image.input) + ' tokens in, ' + n(u.image.output) + ' out' + (u.image.image_out ? ' (' + n(u.image.image_out) + ' image)' : ''),
    c.known ? 'about ' + centsText(c.dollars) + ' for the picture' : 'price for this model not in the app',
    u.plan ? 'Plan: ' + (u.plan.model || 'unknown') + ', ' + n(u.plan.input) + ' in, ' + n(u.plan.output) + ' out (price not counted)' : ''
  ].filter(Boolean);
  const s = dreamLoad();
  if (s.cost) bits.push('Pictures this month on this phone: about ' + centsText(s.cost));
  return bits.join(' \u00b7 ');
}

function dreamPhotoButtons(rerender) {
  const cam = el('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: true });
  const gal = el('input', { type: 'file', accept: 'image/*,.heic,.heif,.avif,.webp,.bmp,.gif,.tif,.tiff', hidden: true });
  const wire = (input) => input.addEventListener('change', async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try { dreamPhoto = await photoFromFile(file, 1024); rerender(); } catch (err) { toast("This device couldn't open that photo. Try another one."); }
  });
  wire(cam); wire(gal);
  const t = activeTank();
  return el('div', { class: 'row photo-actions' },
    el('button', { type: 'button', class: 'btn small', text: 'Take photo', onclick: () => cam.click() }),
    el('button', { type: 'button', class: 'btn small', text: 'Choose photo', onclick: () => gal.click() }),
    t && t.photo && dreamPhoto !== t.photo ? el('button', { type: 'button', class: 'btn small', text: 'Use my tank', onclick: () => { dreamPhoto = t.photo; rerender(); } }) : null,
    dreamPhoto ? el('button', { type: 'button', class: 'btn small', text: 'Remove', onclick: () => { dreamPhoto = ''; rerender(); } }) : null,
    cam, gal);
}

function renderDream() {
  const body = $('dream-body');
  body.replaceChildren();
  const t = activeTank();
  if (!dreamForm) {
    dreamForm = { text: '', type: t ? t.type : 'Freshwater', size: t && tankGallons(t) ? String(Math.round(tankGallons(t))) : '55' };
  }
  const s = dreamLoad();
  const left = dreamLeft();

  body.append(el('h1', { text: 'Dream Tank' }),
    el('p', { class: 'muted', text: 'Describe the tank you want and the AI will picture it with fish and plants, then list what it would take. Add a photo of your tank to see the idea in your own space.' }));

  if (dreamMessage) body.append(el('div', { class: 'notice', role: 'status', text: dreamMessage }));

  // Photo
  const photoCard = el('div', { class: 'card' }, el('h2', { text: 'Your tank photo' }), el('p', { class: 'muted small', text: 'Optional. The AI keeps your tank and room and redoes what is inside.' }));
  const box = el('div', { class: 'photo-box dream-photo' });
  if (dreamPhoto) box.append(el('img', { src: dreamPhoto, alt: 'Your tank photo' }));
  else box.append(el('div', { class: 'tank-hero-empty' }, kindIcon('fish'), el('span', { text: 'No photo added' })));
  photoCard.append(box, dreamPhotoButtons(renderDream));
  body.append(photoCard);

  // Wish
  const area = el('textarea', { class: 'dream-text', rows: 4, maxlength: 400, placeholder: 'For example: a heavily planted tank with schooling fish, driftwood and a calm feel', 'aria-label': 'Describe your dream tank' });
  area.value = dreamForm.text;
  area.addEventListener('input', () => { dreamForm.text = area.value; });
  const typeSel = el('select', { class: 'select', 'aria-label': 'Water type' }, ...['Freshwater', 'Saltwater', 'Brackish'].map((x) => el('option', { value: x, text: x })));
  typeSel.value = dreamForm.type;
  typeSel.addEventListener('change', () => { dreamForm.type = typeSel.value; });
  const size = el('input', { type: 'number', inputmode: 'numeric', min: 5, max: 2000, class: 'dream-size', value: dreamForm.size, 'aria-label': 'Tank size in gallons' });
  size.addEventListener('input', () => { dreamForm.size = size.value; });
  const wishCard = el('div', { class: 'card' },
    el('h2', { text: 'What do you want?' }), area,
    el('div', { class: 'dream-row' }, el('label', {}, el('span', { class: 'label', text: 'Water' }), typeSel), el('label', {}, el('span', { class: 'label', text: 'Gallons' }), size)));
  body.append(wishCard);

  const go = el('button', { type: 'button', class: 'btn primary big', text: dreamBusy ? 'Dreaming…' : (s.last ? 'Dream another one' : 'Dream it'), onclick: runDream });
  if (dreamBusy || !left) go.disabled = true;
  body.append(go,
    el('p', { class: 'muted small center', text: dreamBusy ? 'This can take up to a minute. Please keep the app open.' : left + ' of ' + DREAM_MONTHLY + ' dream pictures left this month. A picture only counts when it is made.' }));

  if (s.last && !dreamBusy) body.append(dreamResultCard(s.last));
}

function dreamResultCard(r) {
  const tmp = dreamTank(r);
  const card = el('div', { class: 'card dream-result' });
  if (r.image) {
    card.append(el('img', { class: 'dream-image', src: r.image, alt: 'AI picture of ' + r.title }),
      el('a', { class: 'btn small', href: r.image, download: 'dream-tank.jpg', text: 'Save picture' }),
      el('p', { class: 'muted small', text: 'On an iPhone, press and hold the picture to save it. This is an AI picture, so real fish and plants will look a little different.' }));
  }
  card.append(el('h2', { text: r.title }), r.summary ? el('p', { text: r.summary }) : null);

  const check = tankCheck(tmp);
  const bad = check.issues.some((i) => i.level === 'bad');
  card.append(el('div', { class: 'water-line' },
    el('strong', { text: 'Would it work?' }),
    !check.issues.length ? el('span', { class: 'pill ok', text: 'All clear' }) : el('span', { class: 'pill ' + (bad ? 'bad' : 'warn'), text: check.issues.length + (check.issues.length === 1 ? ' thing to look at' : ' things to look at') })),
    stockBar(tmp));
  if (check.issues.length) card.append(issueList(check.issues.slice(0, 4)));

  card.append(el('h2', { class: 'dream-list-h', text: 'What it takes' }),
    el('div', { class: 'roster dream-roster' }, ...tmp.fish.map((f, i) => {
      const note = r.species[i] && r.species[i].note;
      return el('div', { class: 'item' },
        rowAvatar(f),
        el('button', { type: 'button', class: 'row-main', 'aria-label': 'Details for ' + f.name, onclick: () => { const a = activeTank(); showSpecies(f.name, a ? a.id : ''); } },
          el('span', { class: 'name', text: f.name }),
          note ? el('span', { class: 'sub', text: note }) : null),
        el('span', { class: 'count-chip', text: '× ' + f.count }));
    })),
    el('button', { type: 'button', class: 'btn primary big', text: 'Start this as a new tank', onclick: () => {
      if (state.tanks.length >= MAX_TANKS) { toast('That is the most tanks the app can hold on this phone (' + MAX_TANKS + ').'); return; }
      state.tanks.push(tmp);
      state.activeId = tmp.id;
      if (!saveState()) { tmp.photo = ''; saveState(); }
      showTank(tmp.id);
      toast('Created ' + tankLabel(tmp) + '. Add what you actually own as you go.');
    } }),
    el('p', { class: 'muted small', text: 'Stocking advice is general guidance, and the AI can be wrong. Check each species before you buy.' }),
    dreamCostLine(r) ? el('p', { class: 'muted small cost-line', text: dreamCostLine(r) }) : null);
  return card;
}

$('dream-back').addEventListener('click', () => goBack(() => showView('home')));
$('ask-back').addEventListener('click', () => goBack(() => (getTank(openTankId) ? showTank(openTankId) : showView('home'))));
$('water-back').addEventListener('click', () => goBack(() => { if (waterFrom === 'tank' && getTank(openTankId)) showTank(openTankId); else showView('home'); waterFrom = 'home'; }));

// ---------- Splash ----------
(function () {
  const s = document.getElementById('splash');
  if (!s) return;
  setTimeout(() => {
    s.classList.add('leaving');
    setTimeout(() => s.remove(), 450);
  }, 2500);
})();

// ---------- Start ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(() => {});
  });
}

loadSpecies().then(() => {
  // Names and kinds come from the list, so redraw once it has loaded.
  if (!$('view-home').hidden) renderHome();
  else if (!$('view-tank').hidden) renderTank();
});
showView('home');
