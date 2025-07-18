#!/usr/bin/env node
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

// Radimo iz direktorijuma gde je ovaj fajl
process.chdir(path.dirname(__filename));
const app = express();

// CORS i JSON parsiranje
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
const configs          = {}; // configs[name] = [ { base, manifest }, ... ]
const wrapperManifests = {}; // wrapperManifests[name] = spojen manifest

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

  // Fetch manifest-e svih baza
  const results = await Promise.allSettled(
    bases.map(b => axios.get(`${b}/manifest.json`))
  );

  const baseManifests = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value.data) {
      baseManifests.push({ base: bases[i], manifest: r.value.data });
    } else {
      console.warn(`⚠️ [${name}] fetch manifest-a za ${bases[i]} nije uspeo`);
    }
  });

  configs[name] = baseManifests;
  if (!baseManifests.length) {
    console.error(`❌ [${name}] nema važećih manifest-a`);
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
    resources:       ['catalog','meta','stream','subtitles'],
    types:           Array.from(new Set(manifests.flatMap(m => m.types || []))),
    idPrefixes:      Array.from(new Set(manifests.flatMap(m => m.idPrefixes || []))),
    catalogs:        manifests.flatMap(m => m.catalogs || []),
    logo:            manifests[0].logo || '',
    icon:            manifests[0].icon || ''
  };

  wrapperManifests[name] = wrapper;
  console.log(`✅ [${name}] inicijalizovano: ${baseManifests.length} baza, ${wrapper.catalogs.length} kataloga`);
}

Promise.all(configFiles.map(f => initConfig(f.replace(/\.json$/, ''))))
  .then(() => console.log(`🎉 Svi config-i spremni: ${configFiles.join(', ')}`))
  .catch(err => console.error('❌ Greška pri inicijalizaciji:', err));

// --- Ruta za manifest -------------------------------------------------------
app.get('/:config/manifest.json', (req, res) => {
  const w = wrapperManifests[req.params.config];
  if (!w) return res.status(404).json({ error: 'Config nije pronađen' });
  res.json(w);
});

// --- Catalog handler --------------------------------------------------------
app.post('/:config/catalog', async (req, res) => {
  const name  = req.params.config;
  const bases = configs[name] || [];
  if (!bases.length) return res.json({ metas: [] });

  const id = req.body.id;
  // filtriraj po katalog-ID
  const targets = bases.filter(bm =>
    (bm.manifest.catalogs || []).some(c => c.id === id)
  );

  const combined = [];
  await Promise.all(targets.map(async bm => {
    try {
      const r = await axios.post(`${bm.base}/catalog`, req.body, {
        headers: { 'Content-Type':'application/json' }
      });
      if (r.data && Array.isArray(r.data.metas)) {
        combined.push(...r.data.metas);
      }
    } catch (e) {
      console.warn(`⚠️ [${name}] catalog za ${bm.base} nije uspeo:`, e.message);
    }
  }));

  res.json({ metas: combined });
});

// --- Meta handler -----------------------------------------------------------
app.post('/:config/meta', async (req, res) => {
  const name  = req.params.config;
  const bases = configs[name] || [];
  if (!bases.length) return res.json({ meta: {} });

  // for channels we skip filtering by catalog-id entirely
  const isChannel = req.body.type === 'channel';
  const entries = [];
  for (const bm of bases) {
    try {
      const r = await axios.post(`${bm.base}/meta`, req.body, {
        headers: { 'Content-Type':'application/json' }
      });
      // base addons return either r.data.meta or r.data.metas[]
      if (r.data) {
        if (r.data.meta) {
          return res.json({ meta: r.data.meta });
        }
        if (Array.isArray(r.data.metas) && r.data.metas.length) {
          return res.json({ meta: r.data.metas[0] });
        }
      }
    } catch (e) {
      console.warn(`⚠️ [${name}] meta za ${bm.base} nije uspeo:`, e.message);
    }
  }

  // ništa nije pronađeno
  res.json({ meta: {} });
});

// --- Stream handler ---------------------------------------------------------
app.post('/:config/stream', async (req, res) => {
  const name  = req.params.config;
  const bases = configs[name] || [];
  if (!bases.length) return res.json({ streams: [] });

  const combined = [];
  await Promise.all(bases.map(async bm => {
    try {
      const r = await axios.post(`${bm.base}/stream`, req.body, {
        headers: { 'Content-Type':'application/json' }
      });
      if (r.data && Array.isArray(r.data.streams)) {
        combined.push(...r.data.streams);
      }
    } catch (e) {
      console.warn(`⚠️ [${name}] stream za ${bm.base} nije uspeo:`, e.message);
    }
  }));

  res.json({ streams: combined });
});

// --- Subtitles handler ------------------------------------------------------
app.post('/:config/subtitles', async (req, res) => {
  const name  = req.params.config;
  const bases = configs[name] || [];
  if (!bases.length) return res.json({ subtitles: [] });

  const combined = [];
  await Promise.all(bases.map(async bm => {
    try {
      const r = await axios.post(`${bm.base}/subtitles`, req.body, {
        headers: { 'Content-Type':'application/json' }
      });
      if (r.data && Array.isArray(r.data.subtitles)) {
        combined.push(...r.data.subtitles);
      }
    } catch (e) {
      console.warn(`⚠️ [${name}] subtitles za ${bm.base} nije uspeo:`, e.message);
    }
  }));

  res.json({ subtitles: combined });
});

// --- GET fallback za v3 kompatibilnost -------------------------------------
app.get('/:config/:path(*)', async (req, res) => {
  const name = req.params.config;
  const bases = configs[name] || [];
  if (!bases.length) return res.status(404).json({ error: 'Config nije pronađen' });

  const route = req.params.path;
  let key, field;
  if (route.startsWith('catalog/'))      { key = 'metas';      field = 'metas'; }
  else if (route.startsWith('stream/'))   { key = 'streams';    field = 'streams'; }
  else if (route.startsWith('subtitles/')){ key = 'subtitles';  field = 'subtitles'; }
  else                                    { return res.status(404).json({ error: 'Nije pronađeno' }); }

  // za katalog GET filtriraj po catalog-id
  let targets = bases;
  if (key === 'metas') {
    const parts = route.split('/');
    const id    = parts[1]?.replace('.json','');
    targets = bases.filter(bm =>
      (bm.manifest.catalogs || []).some(c => c.id === id)
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

// Startovanje servera
const PORT = process.env.PORT || 7000;
app.listen(PORT, () => console.log(`🔌 Slušam na portu :${PORT}`));
