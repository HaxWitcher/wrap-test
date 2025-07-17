#!/usr/bin/env node
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

// Ensure working directory
process.chdir(path.dirname(__filename));

const app = express();
// CORS & JSON parsing
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// Load configurations
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
  try {
    cfg = JSON.parse(fs.readFileSync(file));
  } catch (e) {
    console.error(`❌ Cannot load ${file}:`, e.message);
    return;
  }

  // Normalize bases URLs
  const bases = Array.from(new Set(
    (cfg.TARGET_ADDON_BASES || [])
      .map(u => u.trim().replace(/\/manifest\.json$/i, '').replace(/\/+$/, ''))
      .filter(Boolean)
  ));

  // Fetch each base manifest
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

  // Build wrapper manifest, mapping channel catalogs into movies
  const manifests = baseManifests.map(bm => bm.manifest);
  // Flatten all catalogs
  const allCatalogs = manifests.flatMap(m => m.catalogs || []);
  // Identify channel catalog IDs
  const channelCatalogIds = allCatalogs
    .filter(c => c.type === 'channel')
    .map(c => c.id);

  // Replace channel type with movie
  const wrappedCatalogs = allCatalogs.map(c => {
    if (c.type === 'channel') {
      return { ...c, type: 'movie' };
    }
    return c;
  });

  const wrapper = {
    manifestVersion: '4',
    id: `stremio-proxy-wrapper-${name}`,
    version: '1.0.0',
    name: `Stremio Proxy Wrapper (${name})`,
    description: 'Proxy svih vaših Stremio addon-a',
    resources: ['catalog','meta','stream','subtitles'],
    types: Array.from(new Set(
      manifests.flatMap(m => m.types || [])
    )).filter(t => t !== 'channel'),
    idPrefixes: Array.from(new Set(
      manifests.flatMap(m => m.idPrefixes || [])
    )),
    catalogs: wrappedCatalogs,
    logo: manifests[0].logo || '',
    icon: manifests[0].icon || '',
    _channelCatalogIds: channelCatalogIds
  };

  wrapperManifests[name] = wrapper;
  console.log(`✅ [${name}] initialized: ${baseManifests.length} bases, ${wrappedCatalogs.length} catalogs (${channelCatalogIds.length} channels mapped)`);
}

Promise.all(configFiles.map(f => initConfig(f.replace(/\.json$/, ''))))
  .then(() => console.log(`🎉 All configs ready: ${configFiles.join(', ')}`))
  .catch(err => console.error('❌ Init error:', err));

// Serve manifest
app.get('/:config/manifest.json', (req, res) => {
  const w = wrapperManifests[req.params.config];
  if (!w) return res.status(404).json({ error: 'Config not found' });
  res.json(w);
});

// Generic handlers for catalog, meta, stream, subtitles
function makeHandler(key, endpoint) {
  return async (req, res) => {
    const name = req.params.config;
    const wrapper = wrapperManifests[name];
    const bases = configs[name] || [];
    if (!bases.length) return res.json({ [key]: [] });

    const combined = [];
    for (const bm of bases) {
      try {
        let body = req.body;
        // Remap movie->channel for streams of channel-origin catalogs
        if (endpoint === 'stream' && wrapper._channelCatalogIds.includes(req.body.id)) {
          body = { id: req.body.id, type: 'channel' };
        }
        const r = await axios.post(`${bm.base}/${endpoint}`, body, {
          headers: { 'Content-Type':'application/json' }
        });
        if (r.data && Array.isArray(r.data[key])) {
          combined.push(...r.data[key]);
        }
      } catch (e) {
        console.warn(`⚠️ [${name}] ${endpoint} failed for ${bm.base}:`, e.message);
      }
    }
    res.json({ [key]: combined });
  };
}

app.post('/:config/catalog',    makeHandler('metas',     'catalog'));
app.post('/:config/meta',       makeHandler('metas',     'meta'));
app.post('/:config/stream',     makeHandler('streams',   'stream'));
app.post('/:config/subtitles',  makeHandler('subtitles', 'subtitles'));

// GET fallback for v3 compatibility
app.get('/:config/:path(*)', async (req, res) => {
  const name = req.params.config;
  const bases = configs[name] || [];
  if (!bases.length) return res.status(404).json({ error: 'Config not found' });

  const route = req.params.path;
  let key;
  if (route.startsWith('catalog/'))    key = 'metas';
  else if (route.startsWith('stream/')) key = 'streams';
  else if (route.startsWith('subtitles/')) key = 'subtitles';
  else return res.status(404).json({ error: 'Not found' });

  const combined = [];
  for (const bm of bases) {
    try {
      const r = await axios.get(`${bm.base}/${route}`);
      if (r.data && Array.isArray(r.data[key])) {
        combined.push(...r.data[key]);
      }
    } catch {}
  }
  res.json({ [key]: combined });
});

// Start server
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`🔌 Listening on port ${PORT}`));
