#!/usr/bin/env node
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

process.chdir(path.dirname(__filename));
const app = express();

// CORS & JSON body parsing
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// Load configs
const CONFIG_DIR = path.join(__dirname, 'configs');
const configFiles = fs.existsSync(CONFIG_DIR)
  ? fs.readdirSync(CONFIG_DIR).filter(f => f.endsWith('.json'))
  : [];
const configs = {};
const wrapperManifests = {};

// Initialize each config
async function initConfig(name) {
  const file = path.join(CONFIG_DIR, name + '.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file)); }
  catch (e) { console.error(`❌ Cannot load ${file}:`, e.message); return; }

  // Normalize TARGET_ADDON_BASES
  const bases = Array.from(new Set(
    (cfg.TARGET_ADDON_BASES || [])
      .map(u => u.trim().replace(/\/manifest\.json$/i, '').replace(/\/+$/, ''))
      .filter(Boolean)
  ));

  // Fetch base manifests
  const results = await Promise.allSettled(
    bases.map(b => axios.get(`${b}/manifest.json`))
  );
  const baseManifests = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.data) {
      baseManifests.push({ base: bases[i], manifest: r.value.data });
    } else {
      console.warn(`⚠️ [${name}] failed to fetch ${bases[i]}/manifest.json`);
    }
  });
  configs[name] = baseManifests;
  if (!baseManifests.length) {
    console.error(`❌ [${name}] no valid manifests`);
    return;
  }

  // Build wrapper manifest
  const manifests = baseManifests.map(bm => bm.manifest);
  // All catalogs flattened
  const allCatalogs = manifests.flatMap(m => m.catalogs || []);
  // Identify channel catalogs
  const channelCatalogs = allCatalogs.filter(c => c.type === 'channel');
  // Wrap catalogs: preserve movies/series, map channels under 'channels'
  const wrapperCatalogs = allCatalogs;

  const wrapper = {
    manifestVersion: '4',
    id:              `stremio-proxy-wrapper-${name}`,
    version:         '1.0.0',
    name:            `Stremio Proxy Wrapper (${name})`,
    description:     'Proxy svih vaših Stremio addon-a',
    resources:       ['catalog','meta','stream','subtitles','channels'],
    types:           Array.from(new Set(manifests.flatMap(m => m.types || []))),
    idPrefixes:      Array.from(new Set(manifests.flatMap(m => m.idPrefixes || []))),
    catalogs:        wrapperCatalogs,
    logo:            manifests[0].logo || '',
    icon:            manifests[0].icon || ''
  };
  // Pre-fetch channel entries
  const channelEntries = [];
  for (const bm of baseManifests) {
    for (const cat of (bm.manifest.catalogs || []).filter(c => c.type === 'channel')) {
      try {
        const r = await axios.post(
          `${bm.base}/catalog`,
          { id: cat.id },
          { headers: { 'Content-Type':'application/json' } }
        );
        if (r.data && Array.isArray(r.data.metas)) {
          channelEntries.push(...r.data.metas);
        }
      } catch (e) {
        console.warn(`⚠️ [${name}] failed to fetch channel catalog ${cat.id}`);
      }
    }
  }
  wrapper.channels = channelEntries;
  wrapperManifests[name] = wrapper;
  console.log(`✅ [${name}] initialized: ${baseManifests.length} bases, ${wrapper.catalogs.length} catalogs, ${wrapper.channels.length} channels`);
}

Promise.all(configFiles.map(f => initConfig(f.replace(/\.json$/, ''))))
  .then(() => console.log(`🎉 All configs ready: ${configFiles.join(', ')}`))
  .catch(err => console.error('❌ Init error:', err));

// Routes
app.get('/:config/manifest.json', (req, res) => {
  const w = wrapperManifests[req.params.config];
  if (!w) return res.status(404).json({ error: 'Config not found' });
  res.json(w);
});
// Catalog handler
app.post('/:config/catalog',   makeHandler('metas',     'catalog'));
// Meta handler
app.post('/:config/meta',      makeHandler('metas',     'meta'));
// Stream handler
app.post('/:config/stream',    makeHandler('streams',   'stream'));
// Subtitles handler
app.post('/:config/subtitles', makeHandler('subtitles', 'subtitles'));
// Channels handler
app.get('/:config/channels',   (req, res) => {
  const w = wrapperManifests[req.params.config];
  if (!w) return res.status(404).json({ channels: [] });
  res.json({ channels: w.channels });
});
app.post('/:config/channels',  makeHandler('channels','channels'));
// Fallback v3
app.get('/:config/:path(*)', async (req, res) => {
  const name = req.params.config;
  const bases = configs[name] || [];
  if (!bases.length) return res.status(404).json({ error: 'Config not found' });
  const route = req.params.path;
  let key;
  if (route.startsWith('catalog/')) key = 'metas';
  else if (route.startsWith('stream/')) key = 'streams';
  else if (route.startsWith('subtitles/')) key = 'subtitles';
  else if (route.startsWith('channels/')) key = 'channels';
  else return res.status(404).json({ error: 'Not found' });
  const combined = [];
  for (const bm of configs[name]) {
    try {
      const r = await axios.get(`${bm.base}/${route}`);
      if (r.data && Array.isArray(r.data[key])) combined.push(...r.data[key]);
    } catch {};
  }
  res.json({ [key]: combined });
});
// Generic handler factory
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
    // za channel streamove: pozivamo samo baze koje podržavaju "channel"
    if (key === 'streams' && req.body.type === 'channel') {
      targets = bases.filter(bm =>
        Array.isArray(bm.manifest.types) && bm.manifest.types.includes('channel')
      );
    }
    if (key === 'metas' && req.body.type !== 'channel') {
      const id = req.body.id;
      targets = bases.filter(bm =>
        (bm.manifest.catalogs || []).some(c => c.id === id)
      );
    }
    // za streamove smanjimo na addone koji podržavaju taj tip
    if (key === 'streams' && req.body.type) {
      targets = bases.filter(bm =>
        Array.isArray(bm.manifest.types) && bm.manifest.types.includes(req.body.type)
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
      if (r.status === 'fulfilled' && r.value.data && Array.isArray(r.value.data[key])) {
        combined.push(...r.value.data[key]);
      }
    });
    res.json({ [key]: combined });
  };
};
    }
    res.json({ [key]: combined });
  };
}
// Start server
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`🔌 Listening on port ${PORT}`));
