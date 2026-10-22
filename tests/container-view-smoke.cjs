'use strict';
// Optional real Electron/local-resource regression. Build before running and set
// MINECRAFT_JAR. This uses an isolated profile and creates no game resources.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {_electron:electron}=require('playwright');
const {writeNBT}=require('../src/core/document.cjs');
const root=path.resolve(__dirname,'..'),output=path.join(root,'test-results','container-v140');
const report={passed:false,checks:[],errors:[]};let app,page,profile,watchdog;
function fixture(filename){
  const tag=(type,value)=>({value,types:{type}}),int=n=>tag('int',n),str=s=>tag('string',s);
  const comp=children=>({value:Object.fromEntries(Object.entries(children).map(([k,v])=>[k,v.value])),types:{type:'compound',children:Object.fromEntries(Object.entries(children).map(([k,v])=>[k,v.types]))}});
  const list=(elementType,items)=>({value:items.map(v=>v.value),types:{type:'list',elementType,items:items.map(v=>v.types)}}),vec=(x,y,z)=>comp({x:int(x),y:int(y),z:int(z)});
  const state=(name,props={})=>comp({Name:str('minecraft:'+name),Properties:comp(Object.fromEntries(Object.entries(props).map(([k,v])=>[k,str(v)])))});
  const item=(slot,id,count=1,components)=>comp({Slot:tag('byte',slot),id:str('minecraft:'+id),count:int(count),...(components?{components}: {})});
  const defs=[['chest',{facing:'north',type:'left',waterlogged:'false'}],['chest',{facing:'north',type:'right',waterlogged:'false'}],['barrel',{facing:'up',open:'false'}],['hopper',{facing:'down',enabled:'true'}],['chest',{facing:'north',type:'single',waterlogged:'false'}],['dropper',{facing:'north',triggered:'false'}],['furnace',{facing:'north',lit:'false'}],['brewing_stand',{has_bottle_0:'true',has_bottle_1:'true',has_bottle_2:'true'}],['crafter',{orientation:'north_up',triggered:'false',crafting:'false'}],['white_shulker_box',{facing:'up'}],['decorated_pot',{facing:'north',cracked:'false',waterlogged:'false'}],['jukebox',{has_record:'true'}],['ender_chest',{facing:'north',waterlogged:'false'}]];
  const records=[{Items:list('compound',[item(26,'emerald',7)])},{Items:list('compound',[item(0,'diamond',4),item(8,'ice',64)])},{Items:list('compound',[])},null,{LootTable:str('minecraft:chests/simple_dungeon')},{Items:list('compound',[item(4,'cobblestone',64)])},{Items:list('compound',[item(0,'iron_ore',12),item(1,'coal',32),item(2,'iron_ingot',3)])},{Items:list('compound',[item(0,'potion',1,comp({'minecraft:potion_contents':comp({potion:str('minecraft:healing')})})),item(1,'potion',1,comp({'minecraft:potion_contents':comp({potion:str('minecraft:water')})})),item(2,'potion',1,comp({'minecraft:potion_contents':comp({potion:str('minecraft:swiftness')})})),item(3,'nether_wart',8),item(4,'blaze_powder',16)])},{Items:list('compound',[item(0,'iron_ingot',64),item(0,'diamond',1),item(1,'coal',2),item(20,'emerald',5)]),disabled_slots:tag('int_array',[1,4,7])},{Items:list('compound',[item(26,'ice',64),item(0,'missing_icon',2)])},{item:comp({id:str('minecraft:brick'),count:int(12)})},{RecordItem:comp({id:str('minecraft:music_disc_cat'),count:int(1)})},{}];
  defs.push(['barrel',{facing:'up',open:'false'}]);
  records.push({Items:list('compound',[item(0,'shield'),item(1,'red_bed'),item(2,'diamond_chestplate',1,comp({'minecraft:trim':comp({material:str('minecraft:gold'),pattern:str('minecraft:coast')})})),
    item(3,'crossbow',1,comp({'minecraft:charged_projectiles':list('compound',[comp({id:str('minecraft:arrow'),count:int(1)})])})),
    item(4,'crossbow',1,comp({'minecraft:charged_projectiles':list('compound',[comp({id:str('minecraft:firework_rocket'),count:int(1)})])})),
    item(5,'diamond_sword',1,comp({'minecraft:enchantments':comp({'minecraft:sharpness':int(3)}),'minecraft:custom_name':comp({text:str('Original sword name')})})),item(6,'crossbow')])});
  const states=Array.from({length:16},(_,i)=>i<defs.length?i+1:0),bits=states.reduce((sum,n,i)=>sum|(BigInt(n)<<BigInt(i*4)),0n);
  const tree=comp({Version:int(6),MinecraftDataVersion:int(4671),Metadata:comp({Name:str('Container regression')}),Regions:comp({main:comp({Position:vec(0,0,0),Size:vec(16,1,1),BlockStatePalette:list('compound',[state('air'),...defs.map(([name,props])=>state(name,props))]),BlockStates:tag('long_array',[BigInt.asIntN(64,bits).toString()]),TileEntities:list('compound',records.flatMap((fields,x)=>fields?[comp({id:str('minecraft:'+defs[x][0]),x:int(x),y:int(0),z:int(0),...fields})]:[]))})})});
  fs.writeFileSync(filename,writeNBT({name:'Container regression',...tree}));
}
function check(name){report.checks.push(name);console.log('PASS '+name);}
function kill(){const child=app?.process();if(child?.pid&&child.exitCode===null)spawnSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore',timeout:10000});}
async function close(){if(!app)return;let timer;await Promise.race([app.close(),new Promise(resolve=>timer=setTimeout(()=>{kill();resolve();},5000))]);clearTimeout(timer);app=null;}
async function inspect(x){for(const [axis,value]of [['x',x],['y',0],['z',0]])await page.locator('#jump-'+axis).fill(String(value));await page.locator('#jump-button').click();await page.locator('.container-board').waitFor();}
async function screenshot(name){await page.locator('.container-board').screenshot({path:path.join(output,name+'.png')});}
async function coords(){return page.locator('.container-board').evaluate(el=>{const b=el.getBoundingClientRect();return[...el.querySelectorAll('[data-container-slot]')].map(s=>{const r=s.getBoundingClientRect();return{x:(r.x-b.x)*176/b.width,y:(r.y-b.y)*176/b.width,w:r.width*176/b.width};});});}
async function main(){
  if(!process.env.MINECRAFT_JAR){console.log('SKIP container smoke: set MINECRAFT_JAR.');return;}
  fs.mkdirSync(output,{recursive:true});profile=fs.mkdtempSync(path.join(os.tmpdir(),'studio-containers-'));const file=path.join(profile,'containers.litematic');fixture(file);
  fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({jarPath:path.resolve(process.env.MINECRAFT_JAR),resourcePackPath:'',locale:'en_us'}));
  const env={...process.env,LITEMATIC_STUDIO_TEST_DATA:profile};delete env.ELECTRON_RUN_AS_NODE;
  watchdog=setTimeout(()=>{kill();process.exitCode=1;},180000);
  app=await electron.launch({executablePath:process.env.VIEWER_EXE||require('electron'),args:process.env.VIEWER_EXE?[file]:[root,file],env,timeout:60000});
  await app.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows()){w.setSize(1440,1040);w.show();}});
  page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>report.errors.push(e.message));
  await page.waitForFunction(()=>window.studio?.getState().data&&!window.studio.getState().busy,null,{timeout:120000});
  await inspect(0);assert.equal(await page.locator('[data-container-slot]').count(),54);
  await page.waitForFunction(()=>document.querySelector('[data-container-slot="0"] [data-icon-loaded="true"]'));
  assert.equal(await page.locator('[data-container-slot="0"] .inventory-item').getAttribute('data-item-id'),'minecraft:diamond');
  assert.equal(await page.locator('[data-container-slot="53"] .inventory-item').getAttribute('data-item-id'),'minecraft:emerald');
  await screenshot('double-chest');await page.locator('[data-container-slot="53"]').click();assert.match(await page.locator('.container-slot-detail').textContent(),/Original slot 26.*Emerald/s);
  check('double chest has 54 slots, verified RIGHT-first ordering, local item icons and source-slot detail');
  await inspect(2);assert.match(await page.locator('.container-state').textContent(),/Recorded empty/);assert.equal(await page.locator('.container-unknown').count(),0);await screenshot('barrel');
  await inspect(3);assert.equal(await page.locator('.container-unknown').count(),5);await screenshot('unknown-hopper');
  await inspect(4);assert.equal(await page.locator('.container-unknown').count(),27);assert.match(await page.locator('.container-state').textContent(),/Loot not generated/);
  await inspect(12);assert.equal(await page.locator('.container-unknown').count(),27);assert.match(await page.locator('.container-notes').textContent(),/belongs to the player/);
  check('confirmed empty, missing NBT, ungenerated loot and player-owned ender inventory remain distinct');
  await inspect(5);assert.equal(await page.locator('[data-container-slot]').count(),9);await screenshot('dropper');
  await inspect(6);await page.waitForFunction(()=>document.querySelectorAll('.container-board [data-icon-loaded="true"]').length===3);
  let p=await coords();for(const [i,[x,y]]of [[55,16],[55,52],[115,34]].entries()){assert(Math.abs(p[i].x-x)<.1);assert(Math.abs(p[i].y-y)<1.2);}
  await screenshot('furnace');await page.locator('[data-container-slot="2"]').click();assert.match(await page.locator('.container-slot-detail').textContent(),/Output.*Iron Ingot/s);
  await inspect(7);await page.waitForFunction(()=>document.querySelectorAll('.container-board [data-icon-loaded="true"]').length===5);p=await coords();
  for(const [i,[x,y]]of [[55,50],[78,57],[101,50],[78,16],[16,16]].entries()){assert(Math.abs(p[i].x-x)<.1);assert(Math.abs(p[i].y-y)<1.2);}
  const potions=await page.locator('.container-board [data-item-id="minecraft:potion"] img').evaluateAll(imgs=>imgs.map(i=>i.src));await screenshot('brewing');
  if(process.env.SKIP_ICON_VARIANTS==='1')report.deferred=['Component-specific potion appearance'];else assert.equal(new Set(potions).size,3);
  check('dropper, furnace and brewing layouts match native slots'+(report.deferred?' (potion appearance check deferred)':' and component-specific potion icons differ'));
  await inspect(8);assert.equal(await page.locator('.disabled-slot').count(),3);await page.locator('[data-container-slot="0"]').click();assert.equal(await page.locator('.container-detail-item').count(),2);assert.match(await page.locator('.container-anomalies').textContent(),/Slot outside container range.*20/s);await screenshot('crafter');
  await page.locator('#language-select').selectOption('zh_cn');assert.equal(await page.locator('[data-container-slot="0"]').getAttribute('aria-pressed'),'true');assert.match(await page.locator('.container-detail-title').textContent(),/槽位/);await page.locator('#language-select').selectOption('en_us');
  check('crafter disabled slots, duplicate and out-of-range entries survive inspection and language changes');
  await inspect(9);await page.waitForFunction(()=>document.querySelector('[data-container-slot="26"] [data-icon-loaded="true"]'));assert.equal(await page.locator('[data-container-slot="0"] .inventory-icon-placeholder').count(),1);await screenshot('shulker-placeholder');
  await inspect(10);assert.equal(await page.locator('[data-container-slot]').count(),1);assert.match(await page.locator('.container-notes').textContent(),/no container inventory screen/);await screenshot('decorated-pot');
  await inspect(11);assert.equal(await page.locator('[data-container-slot]').count(),1);await page.locator('[data-container-slot="0"]').click();assert.match(await page.locator('.container-slot-detail').textContent(),/music_disc_cat/);
  check('unknown item icon has an ID placeholder; pot and jukebox use honest saved-slot views');
  if(!report.deferred){
    await inspect(13);await page.waitForFunction(()=>document.querySelectorAll('.container-board [data-icon-loaded="true"]').length===7);
    const crossbows=await page.locator('.container-board [data-item-id="minecraft:crossbow"] img').evaluateAll(imgs=>imgs.map(i=>i.src));assert.equal(new Set(crossbows).size,3);
    const alpha=await page.locator('.container-board [data-icon-loaded="true"] img').evaluateAll(async imgs=>Promise.all(imgs.map(async img=>{await img.decode();const c=document.createElement('canvas');c.width=c.height=64;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);const data=ctx.getImageData(0,0,64,64).data;let visible=0;for(let i=3;i<data.length;i+=4)if(data[i]>10)visible++;return visible;})));assert(alpha.every(n=>n>20));
    await screenshot('special-items');await page.locator('[data-container-slot="5"]').click();assert.match(await page.locator('.container-slot-detail').textContent(),/Original sword name/);assert.match(await page.locator('.container-slot-detail').textContent(),/Enchantment glint is not drawn/);
    check('shield, whole bed, trimmed armor and charged crossbows have nonempty local icons; omitted glint and saved custom name are explicit');
  }
  assert.deepEqual(report.errors,[]);report.passed=!report.deferred;
}
main().catch(e=>{report.errors.push(e.stack);console.error(e);process.exitCode=1;}).finally(async()=>{clearTimeout(watchdog);await close();if(profile){fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));if(path.dirname(profile)===os.tmpdir()&&path.basename(profile).startsWith('studio-containers-'))fs.rmSync(profile,{recursive:true,force:true});}});
