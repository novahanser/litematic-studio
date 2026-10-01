function parseLayers(text,min,max) {
  const result=new Set();
  if (!String(text).trim()) throw new Error('请输入层数，例如 0, 3, 6-10。');
  const normalized=String(text).replace(/(-?\d+)\s*([-~至])\s*(-?\d+)/g,'$1$2$3');
  for (const raw of normalized.split(/[,，;；\s]+/).filter(Boolean)) {
    const match=raw.match(/^(-?\d+)(?:\s*[-~至]\s*(-?\d+))?$/);
    if (!match) throw new Error(`无法识别层数：${raw}`);
    let a=Number(match[1]),b=match[2]===undefined?a:Number(match[2]);
    if (!Number.isSafeInteger(a)||!Number.isSafeInteger(b)||a<min||a>max||b<min||b>max) throw new Error(`层数必须在 ${min} 到 ${max} 之间。`);
    if (a>b) [a,b]=[b,a];
    for(let y=a;y<=b;y++) result.add(y);
  }
  return result;
}
function materialForState(state) {
  const name=state.Name||state.name, p=state.Properties||state.properties||{};
  let id=name,count=1;
  const short=name.replace(/^minecraft:/,'');
  if (/^(air|cave_air|void_air|water|lava|bubble_column|fire|soul_fire|piston_head|moving_piston|nether_portal|end_portal|end_gateway)$/.test(short)) return null;
  if ((/_door$/.test(short)&&p.half==='upper') || (/_bed$/.test(short)&&p.part==='head') || (['sunflower','lilac','rose_bush','peony','tall_grass','large_fern','pitcher_plant'].includes(short)&&p.half==='upper')) return null;
  if (/_slab$/.test(short)&&p.type==='double') count=2;
  if (short==='snow') {id='minecraft:snow'; count=Number(p.layers||1);}
  if (short==='sea_pickle') count=Number(p.pickles||1);
  if (short==='turtle_egg') count=Number(p.eggs||1);
  if (['pink_petals','wildflowers'].includes(short)) count=Number(p.flower_amount||1);
  if (/_candle$/.test(short)||short==='candle') count=Number(p.candles||1);
  const replacements={redstone_wire:'redstone',wall_torch:'torch',redstone_wall_torch:'redstone_torch',soul_wall_torch:'soul_torch',tripwire:'string',cocoa:'cocoa_beans',wheat:'wheat_seeds',carrots:'carrot',potatoes:'potato',beetroots:'beetroot_seeds',sweet_berry_bush:'sweet_berries',powder_snow:'powder_snow_bucket',melon_stem:'melon_seeds',attached_melon_stem:'melon_seeds',pumpkin_stem:'pumpkin_seeds',attached_pumpkin_stem:'pumpkin_seeds'};
  if (replacements[short]) id='minecraft:'+replacements[short];
  else if (short.includes('_wall_hanging_sign')) id=name.replace('_wall_hanging_sign','_hanging_sign');
  else if (short.endsWith('_wall_sign')) id=name.replace('_wall_sign','_sign');
  else if (short.endsWith('_wall_banner')) id=name.replace('_wall_banner','_banner');
  else if (short.endsWith('_wall_head')) id=name.replace('_wall_head','_head');
  else if (short.endsWith('_wall_skull')) id=name.replace('_wall_skull','_skull');
  return {id,count};
}
function buildMaterialRows(schematic,visible) {
  const rows=new Map();
  schematic.blocks.forEach((b,index)=>{
    const item=materialForState(schematic.palette[b.state]); if(!item) return;
    let row=rows.get(item.id);if(!row){row={id:item.id,total:0,visible:0};rows.set(item.id,row);}
    row.total+=item.count;if(visible.has(index))row.visible+=item.count;
  });
  return [...rows.values()].sort((a,b)=>b.total-a.total||a.id.localeCompare(b.id));
}
function stacks64(count) {return count<64 ? String(count) : `${Math.floor(count/64)} 组${count%64 ? ' + '+count%64 : ''}`;}
function csvCell(value) {let s=String(value??'');if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}
function matchesSpecial(state,filter){const p=state.Properties||{},name=state.Name||'';switch(filter){
  case 'waterlogged':return p.waterlogged==='true';
  case 'waterloggable':return Object.hasOwn(p,'waterlogged');
  case 'dry':return p.waterlogged==='false';
  case 'powered':return p.powered==='true'||Number(p.power)>0;
  case 'lit':return p.lit==='true';
  case 'open':return p.open==='true';
  case 'fluids':return /:(water|lava|bubble_column)$/.test(name);
  case 'transparent':return /glass|:(water|bubble_column|ice|frosted_ice|slime_block|honey_block)$/.test(name);
  case 'redstone':return /redstone|repeater|comparator|piston|observer|hopper|dropper|dispenser|lever|button|pressure_plate|tripwire|target|crafter/.test(name);
  case 'partial':return /_slab$|_stairs$|_wall$|_fence$|_pane$|_door$|_trapdoor$|:iron_bars$/.test(name);
  default:return true;
}}
module.exports={parseLayers,materialForState,buildMaterialRows,stacks64,csvCell,matchesSpecial};
