#!/usr/bin/env node
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

// Radimo iz foldera gde je index.js
process.chdir(path.dirname(__filename));

const app = express();
// CORS & JSON
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin',  '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// Load configs
const CONFIG_DIR  = path.join(__dirname, 'configs');
const configFiles = fs.existsSync(CONFIG_DIR)
  ? fs.readdirSync(CONFIG_DIR).filter(f => f.endsWith('.json'))
  : [];
const configs          = {}; // configs[name] = [ { base, manifest }, ... ]
const wrapperManifests = {}; // spojeni manifesti

// Init each config
async function initConfig(name) {
  const file = path.join(CONFIG_DIR, name + '.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file)); }
  catch (e) { console.error(`❌ Ne mogu da učitam ${file}:`, e.message); return; }

  const bases = Array.from(new Set(
    (cfg.TARGET_ADDON_BASES||[])
      .map(u => u.trim().replace(/\/manifest\.json$/i,'').replace(/\/+$/,''))
      .filter(Boolean)
  ));

  // Fetch each base manifest
  const results = await Promise.allSettled(bases.map(b => axios.get(`${b}/manifest.json`)));
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

  // Build wrapper manifest
  const manifests = baseManifests.map(bm => bm.manifest);
  const wrapper = {
    manifestVersion: '4',
    id:              `stremio-proxy-wrapper-${name}`,
    version:         '1.0.0',
    name:            `Stremio Proxy Wrapper (${name})`,
    description:     'Proxy svih vaših Stremio addon-a',
    // Dodaj channels kao zvanični resource
    resources:       ['catalog','meta','stream','subtitles','channels'],
    types:           Array.from(new Set(manifests.flatMap(m=>m.types||[]))),
    idPrefixes:      Array.from(new Set(manifests.flatMap(m=>m.idPrefixes||[]))),
    catalogs:        manifests.flatMap(m=>m.catalogs||[]),
    logo:            manifests[0].logo||'',
    icon:            manifests[0].icon||''
  };

  wrapperManifests[name] = wrapper;
  console.log(`✅ [${name}] inicijalizovano: ${baseManifests.length} baza, ${wrapper.catalogs.length} kataloga`);
}

// Kick off
Promise.all(configFiles.map(f=>initConfig(f.replace(/\.json$/,''))))
  .then(_ => console.log(`🎉 Svi config-i spremni: ${configFiles.join(', ')}`))
  .catch(e => console.error('❌ Init error:', e));

// Manifest route
app.get('/:config/manifest.json', (req,res) => {
  const w = wrapperManifests[req.params.config];
  if (!w) return res.status(404).json({ error:'Config nije pronađen' });
  res.json(w);
});

// Generic POST handler factory
function makeHandler(key, endpoint) {
  return async (req, res) => {
    const name  = req.params.config;
    const bases = configs[name]||[];
    if (!bases.length) return res.json({ [key]: [] });

    // For catalog only, filter by catalog-id
    let targets = bases;
    if (key==='metas') {
      const id = req.body.id;
      targets = bases.filter(bm =>
        (bm.manifest.catalogs||[]).some(c=>c.id===id)
      );
    }

    const combined = [];
    await Promise.all(targets.map(async bm => {
      try {
        const r = await axios.post(
          `${bm.base}/${endpoint}`,
          req.body,
          { headers:{ 'Content-Type':'application/json' }}
        );
        if (r.data && Array.isArray(r.data[key])) {
          combined.push(...r.data[key]);
        }
      } catch (e) {
        console.warn(`⚠️ [${name}] ${endpoint} za ${bm.base} nije uspeo:`, e.message);
      }
    }));
    res.json({ [key]: combined });
  };
}

// Wire up standard endpoints
app.post('/:config/catalog',   makeHandler('metas',     'catalog'));
app.post('/:config/meta',      makeHandler('metas',     'meta'));
app.post('/:config/stream',    makeHandler('streams',   'stream'));
app.post('/:config/subtitles', makeHandler('subtitles','subtitles'));

// --- NEW: Channels handler ---------------------------------------
// Proxyuje channel-addone kroz isti catalog endpoint, ali vraća pod ključem channels
app.post('/:config/channels', async (req, res) => {
  const name = req.params.config;
  const bases = configs[name]||[];
  if (!bases.length) return res.json({ channels: [] });

  // req.body.id je catalog ID (npr. 'yt-sheet')
  const combined = [];
  await Promise.all(bases.map(async bm => {
    try {
      const r = await axios.post(
        `${bm.base}/catalog`,
        req.body,
        { headers:{ 'Content-Type':'application/json' }}
      );
      if (r.data && Array.isArray(r.data.metas)) {
        combined.push(...r.data.metas);
      }
    } catch (e) {
      console.warn(`⚠️ [${name}] channels za ${bm.base} nije uspeo:`, e.message);
    }
  }));
  res.json({ channels: combined });
});

// Fallback GET v3 compatibility
app.get('/:config/:path(*)', async (req,res) => {
  const name  = req.params.config;
  const bases = configs[name]||[];
  if (!bases.length) return res.status(404).json({ error:'Config nije pronađen' });

  const route = req.params.path;
  let key, field;
  if      (route.startsWith('catalog/'))   { key='metas';      field='metas'; }
  else if (route.startsWith('stream/'))    { key='streams';    field='streams'; }
  else if (route.startsWith('subtitles/')) { key='subtitles';  field='subtitles'; }
  else if (route.startsWith('channels/'))  { key='channels';   field='channels'; }
  else                                     return res.status(404).json({ error:'Nije pronađeno' });

  // For catalog GET, filter by ID
  let targets = bases;
  if (key==='metas'||key==='channels') {
    const id = route.split('/')[1].replace('.json','');
    targets = bases.filter(bm =>
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
  res.json({ [field]: combined });
});

// Start server
const PORT = process.env.PORT||7000;
app.listen(PORT, () => console.log(`🔌 Slušam na portu :${PORT}`));
