#!/usr/bin/env node
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

// Radimo iz direktorijuma gde je ovaj fajl
process.chdir(path.dirname(__filename));

const app = express();

// CORS i JSON parsing
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

// Čuvamo po‑config listu baza i wrapper manifeste
const configs          = {}; 
const wrapperManifests = {};

async function initConfig(name) {
  const file = path.join(CONFIG_DIR, name + '.json');
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file));
  } catch (e) {
    console.error(`❌ Ne mogu da učitam ${file}:`, e.message);
    return;
  }

  // Normalizuj TARGET_ADDON_BASES
  const bases = Array.from(new Set(
    (cfg.TARGET_ADDON_BASES||[])
      .map(u => u.trim().replace(/\/manifest\.json$/i,'').replace(/\/+$/,''))
      .filter(Boolean)
  ));

  // Fetch base manifest-e
  const results = await Promise.allSettled(
    bases.map(b => axios.get(`${b}/manifest.json`))
  );
  const baseManifests = [];
  results.forEach((r,i) => {
    if (r.status==='fulfilled' && r.value.data) {
      baseManifests.push({ base: bases[i], manifest: r.value.data });
    } else {
      console.warn(`⚠️ [${name}] fetch ${bases[i]}/manifest.json nije uspeo`);
    }
  });

  configs[name] = baseManifests;
  if (!baseManifests.length) {
    console.error(`❌ [${name}] nema važećih baza`);
    return;
  }

  // Sastavi wrapper manifest
  const manifests = baseManifests.map(bm => bm.manifest);
  const wrapper = {
    manifestVersion: '4',
    id:              `stremio-proxy-wrapper-${name}`,
    version:         '1.0.0',
    name:            `Stremio Proxy Wrapper (${name})`,
    description:     'Proxy svih vaših Stremio addon-a',
    resources:       ['catalog','meta','stream','subtitles','channels'],
    types:           Array.from(new Set(manifests.flatMap(m => m.types||[]))),
    idPrefixes:      Array.from(new Set(manifests.flatMap(m => m.idPrefixes||[]))),
    catalogs:        manifests.flatMap(m => m.catalogs||[]),
    logo:            manifests[0].logo||'',
    icon:            manifests[0].icon||''
  };

  wrapperManifests[name] = wrapper;
  console.log(`✅ [${name}] inicijalizovano: ${baseManifests.length} baza, ${wrapper.catalogs.length} kataloga`);
}

Promise.all(configNames.map(initConfig))
  .then(() => console.log(`🎉 Svi config-i spremni: ${configNames.join(', ')}`))
  .catch(err => console.error('❌ Greška pri inicijalizaciji:', err));

// --- Ruta za manifest -------------------------------------------------------
app.get('/:config/manifest.json', (req,res) => {
  const w = wrapperManifests[req.params.config];
  if (!w) return res.status(404).json({ error:'Config nije pronađen' });
  res.json(w);
});

// --- Generalni POST handler ------------------------------------------------
function makeHandler(key, endpoint) {
  return async (req, res) => {
    const name  = req.params.config;
    const bases = configs[name]||[];
    if (!bases.length) return res.json({ [key]: [] });

    // inicijalno svi base
    let targets = bases;

    // filtriraj katalog po id-u samo ako nije channel
    if (key==='metas' && req.body.type !== 'channel') {
      const id = req.body.id;
      targets = targets.filter(bm =>
        (bm.manifest.catalogs||[]).some(c => c.id===id)
      );
    }

    // za stream type:channel prosledi samo base koji podržavaju channel
    if (key==='streams' && req.body.type === 'channel') {
      targets = targets.filter(bm =>
        Array.isArray(bm.manifest.types) && bm.manifest.types.includes('channel')
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
      if (r.status==='fulfilled' &&
          r.value.data &&
          Array.isArray(r.value.data[key])) {
        combined.push(...r.value.data[key]);
      }
    });
    return res.json({ [key]: combined });
  };
}

app.post('/:config/catalog',   makeHandler('metas',     'catalog'));
app.post('/:config/meta',      makeHandler('metas',     'meta'));
app.post('/:config/stream',    makeHandler('streams',   'stream'));
app.post('/:config/subtitles', makeHandler('subtitles', 'subtitles'));

// --- Channels POST ---------------------------------------------------------
app.post('/:config/channels', async (req,res) => {
  const name  = req.params.config;
  const bases = configs[name]||[];
  if (!bases.length) return res.json({ channels: [] });

  const combined = [];
  await Promise.all(bases.map(async bm => {
    try {
      const r = await axios.post(`${bm.base}/catalog`, req.body, {
        headers: { 'Content-Type':'application/json' }
      });
      if (r.data && Array.isArray(r.data.metas)) {
        combined.push(...r.data.metas);
      }
    } catch(e) {
      console.warn(`⚠️ [${name}] channels za ${bm.base} nije uspeo:`, e.message);
    }
  }));
  return res.json({ channels: combined });
});

// --- GET fallback v3 kompatibilnost ---------------------------------------
app.get('/:config/:path(*)', async (req,res) => {
  const name  = req.params.config;
  const bases = configs[name]||[];
  if (!bases.length) return res.status(404).json({ error:'Config nije pronađen' });

  const route = req.params.path;
  let key, field;
  if      (route.startsWith('catalog/'))   { key='metas';     field='metas'; }
  else if (route.startsWith('stream/'))    { key='streams';   field='streams'; }
  else if (route.startsWith('subtitles/')) { key='subtitles'; field='subtitles'; }
  else if (route.startsWith('channels/'))  { key='channels';  field='channels'; }
  else                                     return res.status(404).json({ error:'Nije pronađeno' });

  let targets = bases;
  if (key==='metas'||key==='channels') {
    const id = route.split('/')[1].replace('.json','');
    targets = targets.filter(bm =>
      (bm.manifest.catalogs||[]).some(c=>c.id===id)
    );
  }

  const combined = [];
  await Promise.all(targets.map(async bm => {
    try {
      const r = await axios.get(`${bm.base}/${route}`);
      if (r.data && Array.isArray(r.data[field])) {
        combined.push(...r.data[field]);
      }
    } catch {}
  }));
  return res.json({ [field]: combined });
});

// Start server
const PORT = process.env.PORT||7000;
app.listen(PORT, () => console.log(`🔌 Slušam na portu :${PORT}`));
