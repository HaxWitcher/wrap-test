#!/usr/bin/env node
const express = require('express');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');

process.chdir(path.dirname(__filename));
const app = express();
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin',  '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

const CONFIG_DIR  = path.join(__dirname, 'configs');
const configFiles = fs.existsSync(CONFIG_DIR)
  ? fs.readdirSync(CONFIG_DIR).filter(f => f.endsWith('.json'))
  : [];
const configs = {};
const wrapperManifests = {};

async function initConfig(name) {
  const file = path.join(CONFIG_DIR, name + '.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file)); }
  catch (e) { console.error(`❌ Ne mogu da učitam ${file}:`, e.message); return; }

  const bases = Array.from(new Set(
    (cfg.TARGET_ADDON_BASES || []).map(u => u.trim().replace(/\/manifest\.json$/i,'').replace(/\/+$/,'')).filter(Boolean)
  ));

  const results = await Promise.allSettled(bases.map(b => axios.get(`${b}/manifest.json`)));
  const baseManifests = [];
  results.forEach((r,i) => r.status==='fulfilled' && r.value.data && baseManifests.push({ base:bases[i], manifest:r.value.data }));
  configs[name] = baseManifests;
  if (!baseManifests.length) { console.error(`❌ [${name}] nema važećih manifest-a`); return; }

  const manifests = baseManifests.map(bm => bm.manifest);
  const wrapper = {
    manifestVersion: '4',
    id: `stremio-proxy-wrapper-${name}`,
    version: '1.0.0',
    name: `Stremio Proxy Wrapper (${name})`,
    description: 'Proxy svih vaših Stremio addon-a',
    resources: ['catalog','meta','stream','subtitles'],
    types: Array.from(new Set(manifests.flatMap(m=>m.types||[]))),
    idPrefixes: Array.from(new Set(manifests.flatMap(m=>m.idPrefixes||[]))),
    catalogs: manifests.flatMap(m=>m.catalogs||[]).map(c=> c.type==='channel' ? {...c, type:'movie'} : c),
    logo: manifests[0].logo||'',
    icon: manifests[0].icon||''
  };

  // Pre-fetch stream metas for channel catalogs
  const channelIds = manifests.flatMap(m=> (m.catalogs||[]).filter(c=>c.type==='channel').map(c=>c.id));
  wrapper._channels = channelIds; // interne

  wrapperManifests[name] = wrapper;
  console.log(`✅ [${name}] inicijalizovano: ${baseManifests.length} baza, ${wrapper.catalogs.length} kataloga`);
}

Promise.all(configFiles.map(f=>initConfig(f.replace(/\.json$/,''))))
  .then(()=>console.log(`🎉 Svi config-i spremni: ${configFiles.join(', ')}`))
  .catch(e=>console.error('❌ Greška pri initConfig:',e));

app.get('/:config/manifest.json',(req,res)=>{
  const w = wrapperManifests[req.params.config];
  if(!w) return res.status(404).json({error:'Config nije pronađen'});
  res.json(w);
});

function makeHandler(key, endpoint) {
  return async (req,res) => {
    const name = req.params.config;
    const bases = configs[name]||[];
    if(!bases.length) return res.json({[key]:[]});

    const combined = [];
    for(const bm of bases) {
      let body = { ...req.body };
      if(endpoint==='stream') {
        // ako je movie id iz channel kataloga, tretiraj tip kao 'channel'
        if(wrapperManifests[name]._channels.includes(req.body.id)) {
          body.type = 'channel';
        }
      }
      try {
        const r = await axios.post(`${bm.base}/${endpoint}`, body, { headers:{ 'Content-Type':'application/json' }});
        if(r.data && Array.isArray(r.data[key])) combined.push(...r.data[key]);
      } catch {};
    }
    res.json({[key]:combined});
  };
}
app.post('/:config/catalog',makeHandler('metas','catalog'));
app.post('/:config/meta',makeHandler('metas','meta'));
app.post('/:config/stream',makeHandler('streams','stream'));
app.post('/:config/subtitles',makeHandler('subtitles','subtitles'));

app.get('/:config/:path(*)',async(req,res)=>{
  const name = req.params.config;
  const bases = configs[name]||[];
  if(!bases.length) return res.status(404).json({error:'Config nije pronađen'});
  const route=req.params.path; let key;
  if(route.startsWith('catalog/')) key='metas';
  else if(route.startsWith('stream/')) key='streams';
  else if(route.startsWith('subtitles/')) key='subtitles';
  else return res.status(404).json({error:'Nije pronađeno'});

  const combined=[];
  for(const bm of bases) {
    try{
      const r=await axios.get(`${bm.base}/${route}`);
      if(r.data && Array.isArray(r.data[key])) combined.push(...r.data[key]);
    }catch{}
  }
  res.json({[key]:combined});
});

const PORT=process.env.PORT||7000;
app.listen(PORT,()=>console.log(`🔌 Slušam na portu :${PORT}`));
