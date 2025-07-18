#!/usr/bin/env node
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

// Osiguraj da radimo iz direktorijuma gde je ovaj fajl
process.chdir(path.dirname(__filename));

const app = express();

// CORS i parsiranje JSON tela
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin',  '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// --- Učitavanje config fajlova ----------------------------------------------
const CONFIG_DIR  = path.join(__dirname, 'configs');
const configFiles = fs.existsSync(CONFIG_DIR)
  ? fs.readdirSync(CONFIG_DIR).filter(f => f.endsWith('.json'))
  : [];
const configNames = configFiles.map(f => f.replace(/\.json$/, ''));

// Ovde čuvamo po-config listu baza i generisane manifest-e
const configs          = {}; // configs[ime] = [ { base, manifest }, ... ]
const wrapperManifests = {}; // wrapperManifests[ime] = spojen manifest

async function initConfig(name) {
  const file = path.join(CONFIG_DIR, name + '.json');
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file));
  } catch (e) {
    console.error(`❌ Ne mogu da učitam ${file}:`, e.message);
    return;
  }

  // Normalizuj i ukloni duplikate iz TARGET_ADDON_BASES
  const bases = Array.from(new Set(
    (cfg.TARGET_ADDON_BASES || [])
      .map(u => u.trim()
                 .replace(/\/manifest\.json$/i,'')
                 .replace(/\/+$/,''))
      .filter(Boolean)
  ));

  // Fetch-uj svaki manifest
  const results = await Promise.allSettled(
    bases.map(b => axios.get(`${b}/manifest.json`))
  );

  const baseManifests = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.data) {
      baseManifests.push({ base: bases[i], manifest: r.value.data });
    } else {
      console.warn(`⚠️  [${name}] fetch manifest-a za ${bases[i]} nije uspeo`);
    }
  });

  configs[name] = baseManifests;
  if (!baseManifests.length) {
    console.error(`❌ [${name}] nema važećih manifest-a`);
    return;
  }

  // Pravi "wrapper" manifest za ovaj config
  const manifests = baseManifests.map(bm => bm.manifest);
  const wrapper = {
    manifestVersion: '4',
    id:              `stremio-proxy-wrapper-${name}`,
    version:         '1.0.0',
    name:            `Stremio Proxy Wrapper (${name})`,
    description:     'Proxy svih vaših Stremio addon-a',
    resources:       ['catalog','meta','stream','subtitles'],  // NIŠTA OVDE NISAM DIRAO
    types:           Array.from(new Set(manifests.flatMap(m => m.types  || []))),
    idPrefixes:      Array.from(new Set(manifests.flatMap(m => m.idPrefixes || []))),
    catalogs:        manifests.flatMap(m => m.catalogs || []),
    logo:            manifests[0].logo || '',
    icon:            manifests[0].icon || ''
  };

  wrapperManifests[name] = wrapper;
  console.log(`✅ [${name}] inicijalizovano: ${baseManifests.length} baza, ${wrapper.catalogs.length} kataloga`);
}

// Inicijalizuj sve configuracije
Promise.all(configNames.map(initConfig))
  .then(() => console.log(`🎉 Svi config-i spremni: ${configNames.join(', ')}`))
  .catch(err => console.error('❌ Greška pri inicijalizaciji:', err));

// --- Ruta za manifest -------------------------------------------------------
app.get('/:config/manifest.json', (req, res) => {
  const w = wrapperManifests[req.params.config];
  if (!w) return res.status(404).json({ error: 'Config nije pronađen' });
  res.json(w);
});

// --- POST handleri za katalog, meta, stream i subtitles ---------------------
function makeHandler(key, endpoint) {
  return async (req, res) => {
    const name = req.params.config;
    const bases = configs[name] || [];
    if (!bases.length) return res.json({ [key]: [] });

    // za katalog filtriraj po id-u kataloga samo ako nije channel
    let targets = bases;
    if (key === 'metas' && req.body.type !== 'channel') {
      const id = req.body.id;
      targets = bases.filter(bm =>
        (bm.manifest.catalogs || []).some(c => c.id === id)
      );
    }

    const results = await Promise.allSettled(
      targets.map(bm =>
        axios.post(`${bm.base}/${endpoint}`, req.body, {
          headers: { 'Content-Type':'application/json' }
        })
      )
    );

    // spoji rezultate
    const combined = [];
    results.forEach(r => {
      if (r.status === 'fulfilled' &&
          r.value.data &&
          Array.isArray(r.value.data[key])) {
        combined.push(...r.value.data[key]);
      }
    });
    res.json({ [key]: combined });
  };
}

app.post('/:config/catalog',   makeHandler('metas',     'catalog'));
app.post('/:config/meta',      makeHandler('metas',     'meta'));
app.post('/:config/stream',    makeHandler('streams',   'stream'));
app.post('/:config/subtitles', makeHandler('subtitles', 'subtitles'));

// --- JEDINI DODATAK: Channels katalog proxy -------------------------------
app.post('/:config/channels', async (req, res) => {
  const name = req.params.config;
  const bases = configs[name] || [];
  if (!bases.length) return res.json({ channels: [] });

  const combined = [];
  await Promise.all(bases.map(async bm => {
    try {
      // proxy /catalog sa istim body za channels
      const r = await axios.post(
        `${bm.base}/catalog`,
        req.body,
        { headers: { 'Content-Type':'application/json' } }
      );
      if (r.data && Array.isArray(r.data.metas)) {
        combined.push(...r.data.metas);
      }
    } catch (_) {}
  }));

  res.json({ channels: combined });
});

// --- GET fallback za v3 kompatibilnost -------------------------------------
app.get('/:config/:path(*)', async (req, res) => {
  const name = req.params.config;
  const bases = configs[name] || [];
  if (!bases.length) return res.status(404).json({ error: 'Config nije pronađen' });

  const route = req.params.path;
  let key;
  if (route.startsWith('catalog/'))      key = 'metas';
  else if (route.startsWith('stream/'))  key = 'streams';
  else if (route.startsWith('subtitles/')) key = 'subtitles';
  else return res.status(404).json({ error: 'Nije pronađeno' });

  // za katalog GET filtriraj po id-u
  let targets = bases;
  if (key === 'metas') {
    const parts = route.split('/');
    const id    = parts[2]?.replace('.json','');
    targets = bases.filter(bm =>
      (bm.manifest.catalogs || []).some(c => c.id === id)
    );
  }

  const results = await Promise.allSettled(
    targets.map(bm => axios.get(`${bm.base}/${route}`))
  );
  const combined = [];
  results.forEach(r => {
    if (r.status === 'fulfilled' &&
        r.value.data &&
        Array.isArray(r.value.data[key])) {
      combined.push(...r.value.data[key]);
    }
  });
  res.json({ [key]: combined });
});

// Startovanje servera
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`🔌 Slušam na portu :${PORT}`));
