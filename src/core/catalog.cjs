const fs = require('node:fs');
const AdmZip = require('adm-zip');
const commonWaterlogged = /(?:_stairs|_slab|_wall|_fence|_pane|_trapdoor|_sign|_hanging_sign|_chest|_chain)$|^(?:chest|trapped_chest|ender_chest|ladder|scaffolding|chain|iron_bars|glass_pane|sea_pickle|campfire|soul_campfire|conduit|lantern|soul_lantern|lightning_rod|decorated_pot|mangrove_roots|glow_lichen|amethyst_cluster|small_amethyst_bud|medium_amethyst_bud|large_amethyst_bud)$/;
function readCatalog(jarPath, palette = [], resourcePackPath) {
  const catalog = new Map();
  const add=(id)=>{if(!catalog.has(id))catalog.set(id,{id,properties:{},defaults:{}});return catalog.get(id);};
  function value(entry,key,raw) {
    if(!/^[a-z0-9_]+$/.test(key))return;
    const values=String(raw).split('|').filter(x=>/^[a-z0-9_-]+$/.test(x));
    entry.properties[key]=[...new Set([...(entry.properties[key]||[]),...values])];
  }
  function conditions(entry,when) {if(!when||typeof when!=='object')return;for(const [k,v]of Object.entries(when)){if(k==='OR'||k==='AND'){if(Array.isArray(v))v.forEach(x=>conditions(entry,x));}else value(entry,k,v);}}
  for(const file of [jarPath,resourcePackPath].filter(Boolean)){
    if(fs.statSync(file).size>768*1024*1024)throw new Error('资源文件过大');
    const zip=new AdmZip(file);
    for(const z of zip.getEntries()){
      const match=z.entryName.match(/^assets\/([a-z0-9_.-]+)\/blockstates\/([a-z0-9_/-]+)\.json$/);if(!match||z.header.size>4*1024*1024)continue;
      const id=match[1]+':'+match[2],entry=add(id);let json;try{json=JSON.parse(z.getData().toString('utf8'));}catch{continue;}
      for(const key of Object.keys(json.variants||{}))for(const condition of key.split(',')){const i=condition.indexOf('=');if(i>0)value(entry,condition.slice(0,i),condition.slice(i+1));}
      for(const part of json.multipart||[])conditions(entry,part.when);
    }
  }
  for(const state of palette){const entry=add(state.Name);for(const [k,v]of Object.entries(state.Properties||{}))value(entry,k,v);if(!entry.sample){entry.defaults={...(state.Properties||{})};entry.sample=true;}}
  for(const entry of catalog.values()){
    const short=entry.id.replace(/^minecraft:/,'');
    if(entry.id.startsWith('minecraft:')&&commonWaterlogged.test(short)&&!short.endsWith('_fence_gate'))entry.properties.waterlogged=['false','true'];
    if(['redstone_wire','light_weighted_pressure_plate','heavy_weighted_pressure_plate'].includes(short))entry.properties.power=Array.from({length:16},(_,i)=>String(i));
    if(['chest','trapped_chest'].includes(short)){entry.properties.facing=['north','south','east','west'];entry.properties.type=['single','left','right'];}
    if(short==='ender_chest')entry.properties.facing=['north','south','east','west'];
    if(short.endsWith('copper_grate'))entry.properties.waterlogged=['false','true'];
    for(const [key,values]of Object.entries(entry.properties)){
      const desired={facing:'north',axis:'y',half:'bottom',shape:'straight',type:values.includes('single')?'single':'bottom',waterlogged:'false',powered:'false',lit:'false',open:'false',power:'0',level:'0'}[key];
      entry.defaults[key]=entry.defaults[key]??(values.includes(desired)?desired:values.includes('false')?'false':values.includes('none')?'none':values.includes('0')?'0':values[0]);
      entry.properties[key]=values.sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
    }
    delete entry.sample;
  }
  return [...catalog.values()].sort((a,b)=>a.id.localeCompare(b.id));
}
module.exports={readCatalog};
