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
    resources:       ['catalog','meta','stream','subtitles'],
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

// --- ADDITIVNI STREAM HANDLER ZA CHANNELS ------------------------
// samo za type: 'channel'
app.post('/:config/stream', async (req, res, next) => {
  if (req.body.type === 'channel') {
    const bases = configs[req.params.config] || [];
    for (const bm of bases) {
      // proveri da li ovaj addon ima kanal-katalog
      if (Array.isArray(bm.manifest.catalogs) && bm.manifest.catalogs.some(c => c.type === 'channel')) {
        try {
          const r = await axios.post(
            `${bm.base}/stream`,
            req.body,
            { headers: { 'Content-Type':'application/json' } }
          );
          if (r.data && Array.isArray(r.data.streams) && r.data.streams.length) {
            return res.json({ streams: r.data.streams });
          }
        } catch (_) {
          // preskoči grešku i probaj sledeći
        }
      }
    }
    // nijedan addon nije vratio stream
    return res.json({ streams: [] });
  }
  // nije kanal → pusti dalje na generički
  next();
});

// --- POST handleri za katalog, meta, generic stream i subtitles -------
// (ostatak koda je NEPROMENJEN)
function makeHandler(key, endpoint) {
  return async (req, res) => {
    const bases = configs[req.params.config] || [];
    if (!bases.length) return res.json({ [key]: [] });

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

// --- GET fallback za v3 kompatibilnost -------------------------------------
app.get('/:config/:path(*)', async (req, res) => {
  const bases = configs[req.params.config] || [];
  if (!bases.length) return res.status(404).json({ error: 'Config nije pronađen' });

  const route = req.params.path;
  let key;
  if (route.startsWith('catalog/'))     key = 'metas';
  else if (route.startsWith('stream/'))  key = 'streams';
  else if (route.startsWith('subtitles/')) key = 'subtitles';
  else return res.status(404).json({ error: 'Nije pronađeno' });

  let targets = bases;
  if (key === 'metas') {
    const id = route.split('/')[2]?.replace('.json','');
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
